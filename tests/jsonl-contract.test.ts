/**
 * JSONL 读侧契约（#192 / ADR-0053）：readJsonlLines 是全流水读侧唯一实现——
 * 撕裂尾行（末行无换行且非法 JSON）豁免跳过；中段坏行（换行结尾）抛 Broken，
 * 文案带流标签 + 路径 + 行号；Missing 合法空态；豁免只认末行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withVault } from './helpers/vault.ts'
import { EVIDENCE_STREAMS } from '../src/engine/evidence-streams.ts'
import { Paths } from '../src/engine/paths.ts'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')

const REC = '{"ts":"2024-01-01T10:00:00+08:00","course":"数学","node":"入门"}'

test('撕裂尾行豁免：宽容流（practice）与严格流（review-log）同一豁免，合法行照常读出', async () => {
  await withVault({
    files: [
      { path: '学习中心/state/practice.jsonl', content: `${REC}\n{"ts":"2024-01-02T1` },
      { path: '学习中心/state/review-log.jsonl', content: `${REC}\n{"ts":"2024-01-02T1` },
    ],
  }, async ({ engine }) => {
    assert.equal((await engine.store.practiceAll()).length, 1)
    assert.equal((await engine.store.reviewLogAll()).length, 1, '历史上严格版连中断尾行都抛——ADR-0053 起同享豁免')
  })
})

test('中段坏行抛 Broken：文案带流标签、路径与行号（严格版错误口径由原语接管，前缀保留）', async () => {
  await withVault({
    files: [
      { path: '学习中心/state/review-log.jsonl', content: `${REC}\n{broken\n${REC}\n` },
      { path: '学习中心/state/回执.jsonl', content: `${REC}\n{broken\n` },
    ],
  }, async ({ engine }) => {
    await assert.rejects(
      () => engine.store.reviewLogAll(),
      /\[review-log\] .+review-log\.jsonl 第 2 行不是合法 JSON（Broken）：修复或删除该行后再试。/)
    await assert.rejects(
      () => engine.store.receiptsAll(),
      /\[receipts\] .+回执\.jsonl 第 2 行不是合法 JSON（Broken）/)
  })
})

test('豁免只认末行：倒数第二行坏、末行合法 → 报坏行，不当撕裂尾行豁免', async () => {
  await withVault({
    files: [
      { path: '学习中心/state/practice.jsonl', content: `${REC}\n{broken\n${REC}` },
    ],
  }, async ({ engine }) => {
    await assert.rejects(
      () => engine.store.practiceAll(),
      /\[practice\] .+practice\.jsonl 第 2 行不是合法 JSON（Broken）/)
  })
})

test('Missing 合法空态不变：流水缺席返回 []，空行照旧跳过', async () => {
  await withVault({
    files: [{ path: '学习中心/state/勘误.jsonl', content: `\n\n${REC}\n\n` }],
  }, async ({ engine }) => {
    assert.deepEqual(await engine.store.erratumAll(), [JSON.parse(REC)], '空行跳过、合法行读出')
    assert.equal((await engine.store.journalTail()).length, 0, '未播种的流水缺席 = Missing 合法空态')
  })
})

test('结构守卫：JSONL 读侧必经原语——src 全域 split("\\n") 只许出现在白名单（非 JSONL 文本处理）', async () => {
  // 白名单 = 逐个核对过的非 JSONL 用法：io 原语本体；markdown/提示词/门禁清单的
  // 文本行处理（compass/content/growth-subsystem）；答案文本归一的多行切分（grading）；
  // mini-YAML 解析（yaml.ts）；路径与错误文案处理（note-source/generation-jobs 的
  // sectionFailure 切错误消息取首条 ✗）；语料 frontmatter 行级补丁（#213 corpus 的
  // applyPatch 只动 --- 围栏内 outcome/code 行，纯文本非数据流）。白名单外出现
  // split('\n') = 有人手写 JSONL parse 循环（ADR-0053 单一实现违约）。
  const ALLOW = new Set(['io.ts', 'compass.ts', 'content.ts', 'growth-subsystem.ts', 'grading.ts', 'note-source.ts', 'yaml.ts', 'generation-jobs.ts', 'corpus.ts'])
  const files: string[] = []
  function walk(dir: string): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) files.push(p)
    }
  }
  walk(SRC)
  assert.ok(files.length > 50, '扫描面非空（门必须能看见目标形态）')
  for (const f of files) {
    if (ALLOW.has(f.split(/[\\/]/).pop()!)) continue
    const src = await readFile(f, 'utf8')
    assert.ok(!src.includes("split('\\n')") && !src.includes('split(/\\n/)'),
      `${f} 手写行切分——JSONL 读侧必须经 readJsonlLines 原语（ADR-0053 单一实现）`)
  }
})

test('结构守卫：追加流水登记处对账——paths.ts 的 .jsonl 路径成员必须列册或显式豁免（#195 防盘点清单漂移）', async () => {
  const pathsSrc = await readFile(join(SRC, 'engine', 'paths.ts'), 'utf8')
  const jsonlGetters = new Set<string>()
  for (const line of pathsSrc.split('\n')) {
    if (!line.includes('.jsonl')) continue
    const m = line.match(/(?:get\s+)?([A-Za-z]\w*)\s*\(/)
    if (m) jsonlGetters.add(m[1]!)
  }
  assert.ok(jsonlGetters.size >= 12, '收集器看得见目标形态：paths.ts 上确有一批 .jsonl 路径成员')
  // 豁免 = 无读侧的纯留痕流：覆盖层（只作审计与出处，读侧永不读）、判卷失败（专项留档）
  const EXEMPT = new Set(['overlayPath', 'gradingFailurePath'])
  const registered = new Set(EVIDENCE_STREAMS.map(d => d.getter))
  assert.ok(registered.size >= 12, '登记处非空')
  for (const g of jsonlGetters) {
    assert.ok(registered.has(g) || EXEMPT.has(g),
      `paths.ts 的 .jsonl 成员 ${g} 未列入 EVIDENCE_STREAMS 登记处（evidence-streams.ts），也未显式豁免——新增流水必须列册，盘点清单不得漂移`)
  }
  for (const d of EVIDENCE_STREAMS) {
    assert.ok(jsonlGetters.has(d.getter), `登记处条目 ${d.getter} 在 paths.ts 上找不到对应 .jsonl 成员（登记处幽灵）`)
    assert.ok(!EXEMPT.has(d.getter), '豁免流不得列册')
  }
  // 接线自检：pathOf 闭包与 paths 同名成员同源（防闭包写错路径；center 级是 getter
  // 属性、course/project 级是带 id 的方法，两种形态都接）
  const paths = new Paths('V')
  for (const d of EVIDENCE_STREAMS) {
    const member = (paths as unknown as Record<string, unknown>)[d.getter]
    assert.ok(member !== undefined, `登记处条目 ${d.getter} 在 Paths 上不存在`)
    const viaPaths = typeof member === 'function' ? (member as (id: string) => string).call(paths, 'R') : member as string
    assert.equal(d.pathOf(paths, 'R'), viaPaths, `登记处条目 ${d.getter} 的 pathOf 与 paths 成员不同源`)
  }
})
