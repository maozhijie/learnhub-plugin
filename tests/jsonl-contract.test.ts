/**
 * JSONL 读侧契约（#192 / ADR-0053）：readJsonlLines 是全流水读侧唯一实现——
 * 撕裂尾行（末行无换行且非法 JSON）豁免跳过；中段坏行（换行结尾）抛 Broken，
 * 文案带流标签 + 路径 + 行号；Missing 合法空态；豁免只认末行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withVault } from './helpers/vault.ts'

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

test('结构守卫：流读取路径零手写 parse 循环（JSONL 读侧必经 readJsonlLines 原语，ADR-0053）', async () => {
  for (const f of ['engine/store.ts', 'engine/project-exec.ts', 'engine/probation.ts', 'engine/data-check.ts']) {
    const src = await readFile(join(SRC, f), 'utf8')
    assert.ok(!src.includes("split('\\n')"),
      `${f} 出现手写行切分——JSONL 读侧必须经 readJsonlLines 原语（ADR-0053 单一实现）`)
  }
})
