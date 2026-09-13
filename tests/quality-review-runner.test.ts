/**
 * 离线批量评审运行器·宿主面（#222 / ADR-0070）：临时 vault + 路由式假 provider 跑通
 * 「读语料 → 两段式评审 → 报告落盘」，逐条钉住票面验收与宿主纪律：
 *
 * - 「对样例语料跑出报告」：夹具语料副本进临时 vault 的 `state/生成语料/`，报告落
 *   `state/质量评审/`（报告不进 canonical —— 断言它只出现在 state 观测面）。
 * - 「报告每条分数能指到具体语料文件与原文证据」：报告里 ref 与证据引文都在。
 * - 「评审调用本身进语料」：跑完在 `state/生成语料/质量评审/` 下能看到评审调用捕获
 *   （站标签 = STATIONS.qualityReview）。
 * - 空输出件零模型调用（成本纪律）；语料目录无有量规的站时 fail loud 并给指引。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { createHostRuntime } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { runQualityReview } from '../src/host/quality-review.ts'
import { STATIONS } from '../src/host/corpus.ts'
import { QUALITY_REVIEW_STATION } from '../src/engine/index.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_CORPUS = join(ROOT, 'tests', 'fixtures', 'quality-corpus')
const tmpDirs: string[] = []

test.after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

/** 临时 vault：夹具语料副本进 state/生成语料（真实布局），返回 vault 路径。 */
function tempVault(withCorpus = true): string {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-review-'))
  tmpDirs.push(vault)
  mkdirSync(join(vault, '学习中心', 'state'), { recursive: true })
  if (withCorpus) cpSync(FIXTURE_CORPUS, join(vault, '学习中心', 'state', '生成语料'), { recursive: true })
  return vault
}

/** 路由式假 provider：按提示词形态分派应答（一期盲评 / 二期对账），并记录收到的提示词。 */
function stubCtx(opts: { secondPassScores?: number } = {}): { ctx: Context; prompts: string[] } {
  const prompts: string[] = []
  let seat = 0
  const ctx = {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
    llm: {
      stream: async function* (req: { messages?: Array<{ content?: Array<{ text?: string }> }> }) {
        const prompt = (req.messages ?? []).flatMap(m => (m.content ?? []).map(c => c.text ?? '')).join('')
        prompts.push(prompt)
        const reconcile = prompt.includes('# 质量评审·二期（对账）')
        const ids = [...prompt.matchAll(/（id: ([^）]+)）/g)].map(m => m[1]!)
        seat++
        // 二期对账把首维度改判（4 → 2）：一期 → 二期的修正可观测（锚定影响是读数）
        const text = JSON.stringify({
          dimensions: ids.map((id, i) => ({
            id,
            score: reconcile && i === 0 ? (opts.secondPassScores ?? 2) : 4,
            evidence: [reconcile ? 'generated' : 'ops'],
            notes: `桩判读 ${id}`,
            ...(reconcile ? { revised: i === 0 } : {}),
          })),
          ...(reconcile ? { contract_note: '契约允许批规模到 8；本批 9 条越限' } : {}),
        })
        yield { type: 'text-delta', text }
        yield { type: 'usage', usage: { inputTokens: 111, outputTokens: 22, reasoningTokens: 3 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        void seat
      },
    },
  } as unknown as Context
  return { ctx, prompts }
}

function runtimeOf(ctx: Context, vault: string): HostRuntime {
  return createHostRuntime(ctx, { vault })
}

test('评审器跑通：报告落 state/质量评审、逐件两期评审、证据与 ref 都在、成本按件计', async () => {
  const vault = tempVault()
  const { ctx, prompts } = stubCtx()
  const rt = runtimeOf(ctx, vault)
  const result = await runQualityReview(ctx, rt, { repeats: 1, corpusDir: join(vault, '学习中心', 'state', '生成语料') })
  const report = result.report

  assert.equal(report.sampling.stations.join('、'), '教练生长、种子起草', '范围 = 有量规的站（判卷等无量规站不评）')
  assert.equal(report.sampling.pool, 4, '池 = 夹具四件')
  assert.equal(report.sampling.selected, 4, '配额（bad 3 + ok 2）盖过池量时取全池')
  assert.equal(report.unscoreable.length, 1, '空输出件零模型调用（列为未评分件）')
  assert.equal(report.reviews.length, 3, '剩余三件逐件评审')
  assert.ok(report.reviews.every(r => r.blind && r.reconciled && r.calls === 2), '每件两段式两次调用')
  assert.equal(report.cost.calls, 6, '成本 = 次数 × 2（未评分件不计）')
  assert.equal(report.cost.inputTokens, 6 * 111)
  assert.equal(report.temperature, 0, '温度固定（可比性）')
  assert.ok(prompts[0]!.includes('一期（盲评）') && !prompts[0]!.includes('教练回合提示词（用户可编辑'), '一期不给生成提示词')

  // 盲评 → 对账的修正可观测（桩把二期首维度改判为 2）
  const first = report.reviews[0]!
  assert.equal(first.blind![0]!.score, 4)
  assert.equal(first.reconciled![0]!.score, 2)
  assert.equal(first.reconciled![0]!.revised, true)
  assert.equal(first.contractNote, '契约允许批规模到 8；本批 9 条越限')

  // 报告落盘：state/质量评审/*.md（报告不进 canonical）与返回的 markdown 一致
  assert.ok(result.reportPath.includes('/学习中心/state/质量评审/'), `报告落 state 观测面：${result.reportPath}`)
  assert.equal(readFileSync(result.reportPath, 'utf8'), result.markdown)
  assert.ok(result.markdown.includes('教练生长/ok-2026-09-13T07-24-41-882Z-0001.md'), '报告指到具体语料文件')
  assert.ok(result.markdown.includes('「ops」') || result.markdown.includes('「generated」'), '报告带证据引文')
  assert.ok(result.markdown.includes('审计面声明'), '范围含审计面站时报告带审计面声明（#224）')
  assert.ok(result.report.systemic, '图轴在册时系统性候选进报告（#224）')
})

test('评审调用本身进语料（站标签 质量评审）：报告与语料捕获都在 state 观测面', async () => {
  const vault = tempVault()
  const { ctx } = stubCtx()
  const rt = runtimeOf(ctx, vault)
  await runQualityReview(ctx, rt, { repeats: 1, stations: ['教练生长'], badQuota: 0, okQuota: 1, corpusDir: join(vault, '学习中心', 'state', '生成语料') })
  await rt.corpus.flush()
  const dir = join(vault, '学习中心', 'state', '生成语料', STATIONS.qualityReview)
  assert.ok(existsSync(dir), `评审调用捕获目录应在：${dir}`)
  const files = readdirSync(dir)
  assert.equal(files.length, 2, '一件两段式 = 两条捕获（一期 + 二期）')
  const body = readFileSync(join(dir, files[0]!), 'utf8')
  assert.ok(body.includes('station: 质量评审'), '站标签正确（STATIONS.qualityReview）')
  assert.ok(body.includes('outcome: ok'), '捕获记为成功调用')
  assert.ok(body.includes('## 提示词') && body.includes('## 原始输出'), '提示词与原始输出都留档')
  assert.equal(QUALITY_REVIEW_STATION, STATIONS.qualityReview, '站名常量与词表同源')
})

test('稳定性读数：重复两次（桩两轮同判）→ 报告带稳定性段；温度固定下同判即 100% 一致', async () => {
  const vault = tempVault()
  const { ctx } = stubCtx()
  const rt = runtimeOf(ctx, vault)
  const result = await runQualityReview(ctx, rt, {
    repeats: 2, stations: ['教练生长'], badQuota: 0, okQuota: 1,
    corpusDir: join(vault, '学习中心', 'state', '生成语料'),
  })
  assert.equal(result.report.reviews.length, 2, '一件两轮')
  assert.ok(result.report.stability.length >= 1, '稳定性读数在场')
  assert.ok(result.report.stability.every(s => s.agree === s.pairs && s.meanRange === 0), '桩两轮同判 = 全一致')
  assert.equal(result.report.cost.calls, 4, '重复评审的成本如实计入（两次 × 两期）')
  assert.ok(result.markdown.includes('稳定性读数'))
})

test('语料目录没有有量规的站样本时 fail loud（给可执行指引，不静默出空报告）', async () => {
  const vault = tempVault(false)
  const { ctx } = stubCtx()
  const rt = runtimeOf(ctx, vault)
  await assert.rejects(
    () => runQualityReview(ctx, rt, { corpusDir: join(vault, '学习中心', 'state', '生成语料') }),
    /没有「有量规的站」样本/,
  )
})

test('评审应答不可解析：记「评审失败」而非低分（报告单列；其余件照常跑完）', async () => {
  const vault = tempVault()
  const ctx = {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', text: '这不是 JSON' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  } as unknown as Context
  const rt = runtimeOf(ctx, vault)
  const result = await runQualityReview(ctx, rt, {
    repeats: 1, stations: ['教练生长'], badQuota: 0, okQuota: 1,
    corpusDir: join(vault, '学习中心', 'state', '生成语料'),
  })
  assert.equal(result.report.reviews.length, 1)
  assert.match(result.report.reviews[0]!.failure ?? '', /找不到 JSON/)
  assert.deepEqual(result.report.stats, [], '失败件不进分数分布（评审失败 ≠ 产物差）')
  assert.ok(result.markdown.includes('评审失败件'), '失败件在报告里单列')
})
