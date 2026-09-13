/**
 * 修复轮策略 ↔ 实现一致性门（#217 / ADR-0065）：注册表 `repair` 列是修复策略的**单源**，
 * 本门把它从散文变成会失败的东西。
 *
 * 两层：
 * ① **结构层（全量 17 条契约）**——每条策略必须点名机制（`REPAIR_MECHANISMS` 的键），
 *    且 `(rounds === 0) === (mechanism === 'none')`（「0 轮＝无整批修复轮」不再是注释里
 *    的一句话）；机制声明的实现文件与见证串必须在 src/ 里真实命中——登记一个不存在的
 *    回路、或回路改名后登记没跟上，都红。逐题回路（出题站两个「恰一次」）走 `perItem`，
 *    与「几轮」分账。
 * ② **行为层（本票点名要核的站）**——脚本化模型 + 必败产物数模型调用次数：「0 轮」的站
 *    第一次调用就断（回执 ADR-0004 事务性、出题无整批修复轮），「1 轮」的站恰多一次
 *    （大纲，锁定在 `tests/host-runtime.test.ts` 的 MODEL_YAML 回灌用例里）；罗盘的
 *    「调用数恒 1」由 `tests/compass.test.ts` 的金样本回放闸承载。
 *
 * 门带自检（ADR-0047 铁律①）：幽灵机制名 / 0 轮却点名机制 / 见证串改坏 / 收集器看不见
 * 目标形态，四类样本各自必须变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPAIR_MECHANISMS, OUTPUT_CONTRACTS } from '../src/engine/output-contracts.ts'
import type { OutputContract } from '../src/engine/output-contracts.ts'
import type { LlmComplete } from '../src/engine/llm.ts'
import { withVault } from './helpers/vault.ts'

/** 录制型假实现：记 prompt，固定回放同一应答（与 #148 金样本闸同款）。 */
function replayFake(reply: string) {
  const calls: Array<{ prompt: string }> = []
  const fn: LlmComplete = async prompt => {
    calls.push({ prompt })
    return reply
  }
  return Object.assign(fn, { calls })
}

/** src/ 全量 .ts 源码（相对 src/ 的 posix 路径 → 文本）。 */
function srcSources(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts')) out[relative(join(process.cwd(), 'src'), full).replace(/\\/g, '/')] = readFileSync(full, 'utf8')
    }
  }
  walk(join(process.cwd(), 'src'))
  return out
}

// ---------------------------------------------------------------- ① 结构层

/** 机制登记 ↔ 实现对账（可注入 = 自检可改坏样本）。 */
function runMechanismGate(
  mechanisms: Readonly<Record<string, { file: string; witness: string[]; what: string }>>,
  contracts: readonly OutputContract[],
  sources: Record<string, string>,
): void {
  for (const [name, m] of Object.entries(mechanisms)) {
    assert.ok(m.what.trim(), `机制「${name}」缺 what（登记不许只有名字）`)
    assert.ok(m.witness.length > 0, `机制「${name}」缺见证串`)
    // 见证串按「src/ 下某文件」声明；file 允许带目录前缀（如 engine/agent.ts）或不带
    const hit = Object.entries(sources).find(([path]) => path === m.file || path.endsWith(`/${m.file}`))
    assert.ok(hit, `机制「${name}」声明的实现文件「${m.file}」不在 src/ 下`)
    for (const w of m.witness) {
      assert.ok(hit![1].includes(w), `机制「${name}」的见证串「${w}」在 ${hit![0]} 里找不到——回路改名/删了，登记没跟上`)
    }
  }
  for (const c of contracts) {
    const where = `${c.station}${c.surface ? '/' + c.surface : ''}`
    const p = c.repair
    assert.equal(
      p.mechanism === 'none', p.rounds === 0,
      `「${where}」修复策略自相矛盾：rounds=${p.rounds} 与 mechanism=${p.mechanism}（0 轮必须登记 'none'，非 0 轮必须点名机制）`,
    )
    if (p.mechanism !== 'none') {
      assert.ok(REPAIR_MECHANISMS[p.mechanism], `「${where}」点名了未登记的机制「${p.mechanism}」`)
    }
    for (const it of p.perItem ?? []) {
      assert.ok(REPAIR_MECHANISMS[it], `「${where}」点名了未登记的逐题机制「${it}」`)
    }
  }
}

test('#217 修复策略单源：机制登记与实现对账 + 「0 轮＝无整批轮」不变式（17 条契约）', () => {
  const sources = srcSources()
  assert.ok(Object.keys(sources).length > 50, `收集面太小（${Object.keys(sources).length} 个文件）——门会恒过`)
  runMechanismGate(REPAIR_MECHANISMS, OUTPUT_CONTRACTS, sources)
})

test('自检：幽灵机制名 / 0 轮却点名机制 / 见证串改坏，三类都必须变红', () => {
  const sources = srcSources()
  const ghost: OutputContract[] = OUTPUT_CONTRACTS.map(c =>
    c.station === '罗盘' ? { ...c, repair: { ...c.repair, rounds: 1, mechanism: '不存在的回路' as never } } : c)
  assert.throws(() => runMechanismGate(REPAIR_MECHANISMS, ghost, sources), /未登记的机制/)

  const lying: OutputContract[] = OUTPUT_CONTRACTS.map(c =>
    c.station === '罗盘' ? { ...c, repair: { ...c.repair, rounds: 1 } } : c)
  assert.throws(() => runMechanismGate(REPAIR_MECHANISMS, lying, sources), /自相矛盾/)

  const broken = { ...REPAIR_MECHANISMS, outlineRepairFeedback: { file: 'generation-jobs.ts', witness: ['不存在的函数名'], what: 'x' } }
  assert.throws(() => runMechanismGate(broken, OUTPUT_CONTRACTS, sources), /见证串/)

  const missingFile = { ...REPAIR_MECHANISMS, outlineRepairFeedback: { file: '不存在的文件.ts', witness: ['x'], what: 'x' } }
  assert.throws(() => runMechanismGate(missingFile, OUTPUT_CONTRACTS, sources), /不在 src\/ 下/)
})

// ---------------------------------------------------------------- ② 行为层

const GRAPH_NO_TEACHES = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 甲, pre: [], opt: false, note: "", est: 10 }',
  '      - { name: 乙, pre: [甲], opt: false, note: "", est: 20 }',
].join('\n')

const NOTE_乙 = {
  stage: 'ready',
  content: { version: 1, generatedAt: '2026-09-01', status: 'draft' },
  body: ['# 乙', '', '质数是大于 1 且只能被 1 和自身整除的自然数，1 不是质数。'],
}

/** 图内零 teaches → 概念清单为空 → 出生打标门不激活（#148）→ 出题站调用数 = 纯生成轮次，
 * 这样数出来的次数才是「整批轮」的读数，不被逐题补标回路干扰。 */
const VAULT = { graph: GRAPH_NO_TEACHES, notes: { 乙: NOTE_乙 } }

/** 回执评审只能挂实践节点（ADR-0016）：practice 类型夹具（同 receipts.test.ts）。 */
const GRAPH_PRACTICE = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 练耳, pre: [], opt: false, note: "", est: 20, type: practice }',
].join('\n')

test('#217 出题站 rounds=0 行为锁：模型产出不可解析 → 恰一次调用即断，无整批修复轮', async () => {
  await withVault(VAULT, async ({ engine }) => {
    const fake = replayFake('这不是一个 YAML 映射')
    await assert.rejects(
      () => engine.bank2.questionGenerate('数学', '乙', undefined, fake),
      /没有产出可用题目/,
    )
    assert.equal(fake.calls.length, 1, '0 轮：第一次产出就断，不得有整批回灌重产')
  })
})

test('#217 出题站 rounds=0 行为锁：逐题门全部拒收 → 仍恰一次调用，零落盘 fail loud', async () => {
  const asciiMath = [
    'node: 乙',
    'questions:',
    '  - id: q1',
    '    kind: true_false',
    '    q: x^2 是一个完全平方，判断对错。',
    '    answer: true',
    '    explanation: 展开即得。',
  ].join('\n')
  await withVault(VAULT, async ({ engine }) => {
    const fake = replayFake(asciiMath)
    await assert.rejects(
      () => engine.bank2.questionGenerate('数学', '乙', undefined, fake),
      /一道都没入库/,
    )
    assert.equal(fake.calls.length, 1, '逐题门拒收走报告面，不触发整批修复轮（#217 裁决维持 0 轮）')
  })
})

test('#217 回执评审 rounds=0 行为锁：评审不可解析 → 恰一次调用即断（ADR-0004 事务性）', async () => {
  // 回执只挂实践节点（ADR-0016）——用 type: practice 的节点，否则先撞节点类型门（与
  // tests/receipts.test.ts 的事务性用例同款夹具）。
  await withVault({ tag: 'repair-policy', graph: GRAPH_PRACTICE, notes: { 练耳: {} } }, async ({ engine }) => {
    const fake = replayFake('模型胡言乱语')
    await assert.rejects(
      () => engine.learner.receiptSubmit('数学', '练耳', { kind: 'text', material: 'x' }, fake),
      /不是合法 JSON/,
    )
    assert.equal(fake.calls.length, 1, '0 轮：解析失败即零落盘，无回灌重问')
  })
})
