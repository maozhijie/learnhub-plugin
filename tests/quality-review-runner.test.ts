/**
 * 离线批量评审运行器·宿主面（#222 / ADR-0070）：临时 vault + 路由式假 provider 跑通
 * 「读语料 → 两段式评审 → 报告落盘」，逐条钉住票面验收与宿主纪律：
 *
 * - 「对样例语料跑出报告」：夹具语料副本进临时 vault 的 `state/生成语料/`，报告落
 *   `state/质量评审/`（报告不进 canonical —— 断言它只出现在 state 观测面）。
 * - 「报告每条分数能指到具体语料文件与原文证据」：报告里 ref 与证据引文都在。
 * - 「评审调用本身进调用记录」：跑完在 `state/调用记录/_离线/质量评审.md` 组文件里能看到
 *   评审调用捕获（站标签 = STATIONS.qualityReview；#330 起捕获落调用记录新目录）。
 * - 空输出件零模型调用（成本纪律）；语料目录无有量规的站时 fail loud 并给指引。
 */
import { memLogger } from './helpers/logger.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { createHostRuntime } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { runQualityReview } from '../src/host/quality-review.ts'
import { STATIONS } from '../src/host/corpus.ts'
import { parseCallRecordFile } from '../src/host/corpus-read.ts'
import { QUALITY_REVIEW_STATION } from '../src/engine/index.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_CORPUS = join(ROOT, 'tests', 'fixtures', 'quality-corpus')
const tmpDirs: string[] = []

test.after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

/** 递归拷贝目录：逐文件读写——Windows 上 cpSync 对含中文的目标路径会静默不拷
 * （同 spike.ts copyDir 的既有教训），夹具的中文站目录名正是受害者。 */
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = `${src}/${e.name}`
    const d = `${dst}/${e.name}`
    if (e.isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

/** 临时 vault：夹具语料副本进 state/生成语料（真实布局），返回 vault 路径。 */
function tempVault(withCorpus = true): string {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-review-'))
  tmpDirs.push(vault)
  mkdirSync(join(vault, '学习中心', 'state'), { recursive: true })
  if (withCorpus) copyDir(FIXTURE_CORPUS, join(vault, '学习中心', 'state', '生成语料'))
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
  return createHostRuntime(ctx, { vault, logger: memLogger() })
}

test('评审器跑通：报告落 state/质量评审、逐件两期评审、证据与 ref 都在、成本按件计', async () => {
  const vault = tempVault()
  const { ctx, prompts } = stubCtx()
  const rt = runtimeOf(ctx, vault)
  const result = await runQualityReview(ctx, rt, { repeats: 1, corpusDir: join(vault, '学习中心', 'state', '生成语料') })
  const report = result.report

  assert.equal(report.sampling.stations.join('、'), '教练执行', '范围 = 有量规的站（种子站随 #256 退役、判卷等无量规站不评）')
  assert.equal(report.sampling.pool, 3, '池 = 教练执行夹具三件（种子站语料不再入范围）')
  assert.equal(report.sampling.selected, 3, '配额（bad 3 + ok 2）盖过池量时取全池')
  assert.equal(report.unscoreable.length, 1, '空输出件零模型调用（列为未评分件）')
  assert.equal(report.reviews.length, 2, '剩余两件逐件评审')
  assert.ok(report.reviews.every(r => r.blind && r.reconciled && r.calls === 2), '每件两段式两次调用')
  assert.equal(report.cost.calls, 4, '成本 = 件数 × 2（未评分件不计）')
  assert.equal(report.cost.inputTokens, 4 * 111)
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
  assert.ok(result.markdown.includes('教练执行/ok-2026-09-13T07-24-41-882Z-0001.md'), '报告指到具体语料文件')
  assert.ok(result.markdown.includes('「ops」') || result.markdown.includes('「generated」'), '报告带证据引文')
  assert.ok(result.markdown.includes('审计面声明'), '范围含审计面站时报告带审计面声明（#224）')
  assert.ok(result.report.systemic, '图轴在册时系统性候选进报告（#224）')
})

test('评审调用本身进调用记录（站标签 质量评审，_离线 组文件）：报告与捕获都在 state 观测面', async () => {
  const vault = tempVault()
  const { ctx } = stubCtx()
  const rt = runtimeOf(ctx, vault)
  await runQualityReview(ctx, rt, { repeats: 1, stations: ['教练执行'], badQuota: 0, okQuota: 1, corpusDir: join(vault, '学习中心', 'state', '生成语料') })
  await rt.corpus.flush()
  const path = join(vault, '学习中心', 'state', '调用记录', '_离线', '质量评审.md')
  assert.ok(existsSync(path), `评审调用捕获组文件应在：${path}`)
  const calls = parseCallRecordFile(readFileSync(path, 'utf8'))
  assert.equal(calls.length, 2, '一件两段式 = 两条捕获（一期 + 二期）')
  assert.equal(calls[0]!.station, STATIONS.qualityReview, '站标签正确（STATIONS.qualityReview）')
  assert.equal(calls[0]!.outcome, 'ok', '捕获记为成功调用')
  assert.ok(calls[0]!.prompt.length > 0 && calls[0]!.output.length > 0, '提示词与响应都留档（请求/响应 JSON 原文块）')
  assert.equal(calls[0]!.source, '离线', '无业务键的评审调用来源 = 离线')
  assert.equal(QUALITY_REVIEW_STATION, STATIONS.qualityReview, '站名常量与词表同源')
})

test('稳定性读数：重复两次（桩两轮同判）→ 报告带稳定性段；温度固定下同判即 100% 一致', async () => {
  const vault = tempVault()
  const { ctx } = stubCtx()
  const rt = runtimeOf(ctx, vault)
  const result = await runQualityReview(ctx, rt, {
    repeats: 2, stations: ['教练执行'], badQuota: 0, okQuota: 1,
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
    repeats: 1, stations: ['教练执行'], badQuota: 0, okQuota: 1,
    corpusDir: join(vault, '学习中心', 'state', '生成语料'),
  })
  assert.equal(result.report.reviews.length, 1)
  assert.match(result.report.reviews[0]!.failure ?? '', /找不到 JSON/)
  assert.deepEqual(result.report.stats, [], '失败件不进分数分布（评审失败 ≠ 产物差）')
  assert.ok(result.markdown.includes('评审失败件'), '失败件在报告里单列')
})

test('#236 工具调用件端到端：文本为空而载荷在参数里 → 可评（合并视图进两期提示词，不列未评分件）', async () => {
  const vault = tempVault(false)
  const corpus = join(vault, '学习中心', 'state', '生成语料')
  mkdirSync(join(corpus, '教练执行'), { recursive: true })
  writeFileSync(join(corpus, '教练执行', 'ok-2026-09-13T08-00-00-000Z-0001.md'), [
    '---', 'ts: 2026-09-13T08:00:00.000Z', 'station: 教练执行', 'kind: loop', 'effort: fast',
    'outcome: ok', 'truncated: false', 'duration_ms: 900', 'provider: deepseek-official',
    'model: deepseek-v4-flash', 'prompt_chars: 120', 'reply_chars: 0', '---', '',
    '## 提示词', '', '<!-- learnhub:prompt/v6 -->', '# 教练回合提示词', '',
    '## 原始输出', '', '（空输出）', '',
    '## 工具调用', '', JSON.stringify({ name: 'submit_batch', arguments: '{"note":{"operator":"前进"}}' }), '',
  ].join('\n'), 'utf8')
  const { ctx, prompts } = stubCtx()
  const rt = runtimeOf(ctx, vault)
  const result = await runQualityReview(ctx, rt, {
    repeats: 1, stations: ['教练执行'], badQuota: 0, okQuota: 5, corpusDir: corpus,
  })
  assert.equal(result.report.unscoreable.length, 0, '工具调用件不再落进未评分件（#224 的教练轴空壳）')
  assert.equal(result.report.reviews.length, 1, '逐件两期评审照跑')
  assert.ok(prompts[0]!.includes('[工具调用 submit_batch]'), '一期受评对象 = 文本 + 工具调用载荷合并视图')
  assert.ok(prompts[0]!.includes('"operator":"前进"'), 'arguments 原文进受评对象')
  assert.ok(!prompts[0]!.includes('教练回合提示词（用户可编辑'), '一期仍不给生成提示词（防锚定纪律不动）')
  assert.ok(result.report.stats.length > 0, '照常进分数分布')
})
