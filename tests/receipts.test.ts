/**
 * 回执反馈环（U-1 #88 / ADR-0016）。
 *
 * - 纯函数：渐退反馈曲线（full 位置 {1,2,4,7,11,16,…} 封顶每 5 份）、AI 评审解析
 *   （含围栏剥离与 fail-loud）。
 * - 行为（vault seam）：回执 → 评审 → EMA 全链（验收：一次练习回执走完三步）；
 *   渐退深度随历史递减 + force_full 越过；评审核验失败零落盘（ADR-0004 事务性）。
 * - 红线机检：回执零 XP、零 FSRS 写入（fsrs 块原样）、零复习日志/作答流水；
 *   永不判 Broken（没交回执连 Missing 都不算）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { wantsFullReview, receiptsUntilNextFull, parseReceiptReview, RECEIPT_KIND_LABEL } from '../src/engine/receipts.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { withVault } from './helpers/vault.ts'

const GRAPH_PRACTICE = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 练耳, pre: [], opt: false, note: "", est: 20, type: practice }',
  '      - { name: 乐理, pre: [], opt: false, note: "", est: 20 }',
].join('\n')

/** 假评审模型：记录收到的 (prompt, system)，返回可编造的 JSON 评分。 */
function fakeLlm(score: number, verdict = '总评') {
  const calls: Array<{ prompt: string; system?: string }> = []
  const fn = async (prompt: string, system?: string) => {
    calls.push({ prompt, system })
    return JSON.stringify({
      score, verdict,
      errors: [{ point: '要点A', issue: '音程听反', advice: '先定基准音' }],
    })
  }
  return Object.assign(fn, { calls })
}

// ---- 纯函数：渐退曲线 ----

test('渐退曲线：完整评审位置 {1,2,4,7,11,16,21}，间隔 1,2,3,4,5 封顶', () => {
  const full = new Set([1, 2, 4, 7, 11, 16, 21, 26, 31])
  const notFull = [3, 5, 6, 8, 9, 10, 12, 13, 14, 15, 17, 18, 19, 20, 22, 100]
  for (const i of full) assert.equal(wantsFullReview(i), true, `#${i} 应为完整评审`)
  for (const i of notFull) assert.equal(wantsFullReview(i), false, `#${i} 应为简要`)
  assert.equal(wantsFullReview(0), false)
  assert.equal(wantsFullReview(1.5), false)
})

test('渐退预告：已有 i 份后，再交几份吃到下一次完整评审', () => {
  assert.equal(receiptsUntilNextFull(0), 1)  // 首份即完整
  assert.equal(receiptsUntilNextFull(2), 2)  // #2 完整后，下一站 #4
  assert.equal(receiptsUntilNextFull(3), 1)
  assert.equal(receiptsUntilNextFull(12), 4) // 下一站 #16
  assert.equal(receiptsUntilNextFull(16), 5) // 下一站 #21（封顶段每 5 份一次）
  assert.equal(receiptsUntilNextFull(30), 1) // 下一站 #31
})

// ---- 纯函数：AI 评审解析 ----

test('评审解析：严格 JSON、围栏剥离、score clamp、缺字段 fail loud', () => {
  const ok = parseReceiptReview('{"score":0.8,"verdict":"节奏稳","errors":[{"point":"A","issue":"x","advice":"y"}]}')
  assert.equal(ok.score, 0.8)
  assert.equal(ok.errors?.length, 1)
  const fenced = parseReceiptReview('```json\n{"score":1.4,"verdict":"v"}\n```')
  assert.equal(fenced.score, 1) // clamp 到 [0,1]
  assert.throws(() => parseReceiptReview('这不是 JSON'), /不是合法 JSON/)
  assert.throws(() => parseReceiptReview('{"verdict":"缺分"}'), /score/)
  assert.throws(() => parseReceiptReview('{"score":0.5}'), /verdict/)
})

// ---- 行为：回执 → 评审 → EMA 全链（验收链）----

test('回执全链：一次乐器练习回执走完 回执→评审→EMA；mode=full 落拆解', async () => {
  await withVault({ tag: 'receipt-chain', graph: GRAPH_PRACTICE, notes: { 练耳: {}, 乐理: {} } }, async h => {
    const llm = fakeLlm(0.8)
    const r = await h.engine.receiptSubmit('数学', '练耳', { kind: 'text', material: '今天练了 30 分钟音程听辨' }, llm)
    assert.equal(r.index, 1)
    assert.equal(r.review_mode, 'full') // 首份永远完整评审
    assert.equal(r.next_full_in, null)
    assert.equal(r.receipt.id, 'r1')
    assert.equal(r.practice_ema, 0.8) // EMA 首证取分
    // 评审提示词带量表来源（节点要点位）与深度指令
    assert.ok(llm.calls[0].prompt.includes('练耳'))
    assert.ok(llm.calls[0].prompt.includes('完整（full）'))
    assert.ok(llm.calls[0].system?.includes('严格 JSON'))
    // 流水落盘：full 拆解留档 + 来源枚举
    const receipts = await h.store.receiptsAll()
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].kind, 'text')
    assert.equal(receipts[0].score, 0.8)
    assert.equal(receipts[0].errors?.length, 1)
    // 第二份（#2 恰好也是完整位）：EMA 接力 0.8*0.7 + 0.5*0.3
    const r2 = await h.engine.receiptSubmit('数学', '练耳', { kind: 'image', material: '练耳 App 截图路径 /imgs/x.png' }, fakeLlm(0.5))
    assert.equal(r2.review_mode, 'full')
    assert.deepEqual(r2.practice_ema, Math.round((0.8 * 0.7 + 0.5 * 0.3) * 1000) / 1000)
  })
})

test('渐退生效：#3 起简要评审；force_full 越过；brief 丢弃拆解并预告', async () => {
  await withVault({ tag: 'receipt-fade', graph: GRAPH_PRACTICE, notes: { 练耳: {} } }, async h => {
    await h.engine.receiptSubmit('数学', '练耳', { kind: 'text', material: 'x1' }, fakeLlm(0.9))
    await h.engine.receiptSubmit('数学', '练耳', { kind: 'text', material: 'x2' }, fakeLlm(0.9))
    const brief = await h.engine.receiptSubmit('数学', '练耳', { kind: 'text', material: 'x3' }, fakeLlm(0.9))
    assert.equal(brief.review_mode, 'brief')
    assert.equal(brief.next_full_in, 1) // 下一份（#4）就是完整评审
    const receipts = await h.store.receiptsAll()
    assert.equal(receipts[2].errors, undefined) // brief 不落拆解
    // 学习者主动要完整评审：越过渐退曲线
    const forced = await h.engine.receiptSubmit('数学', '练耳', { kind: 'text', material: 'x4', force_full: true }, fakeLlm(0.9))
    assert.equal(forced.review_mode, 'full')
    // 渐退状态面：per 主体计数 + 预告
    const list = await h.engine.receiptList('数学', '练耳')
    assert.equal(list.total, 4)
    assert.equal(list.next_full_in, 3) // 下一站 #7
    assert.equal(list.receipts.every(x => x.course === '数学' && x.node === '练耳'), true)
  })
})

test('红线：回执零 XP、零 FSRS 推进、不进复习队列；非实践节点拒绝', async () => {
  await withVault({ tag: 'receipt-redline', graph: GRAPH_PRACTICE, notes: { 练耳: {}, 乐理: {} } }, async h => {
    await h.engine.receiptSubmit('数学', '练耳', { kind: 'signoff', material: '教练签核：进度良好' }, fakeLlm(0.7))
    // 账本红线：journal/practice/review-log 零行
    assert.equal((await h.store.journalTail()).length, 0)
    assert.equal((await h.store.practiceAll()).length, 0)
    assert.equal((await h.store.reviewLogAll()).length, 0)
    // 复习队列零卡（回执永不推卡、也本就不是复习对象）
    const q = await h.engine.content2.reviewQueue('数学', '练耳')
    assert.equal(q.cards.length, 0)
    // 非实践节点（普通节点乐理）拒绝——v1 载体 = 实践节点
    await assert.rejects(
      () => h.engine.receiptSubmit('数学', '乐理', { kind: 'text', material: 'x' }, fakeLlm(0.5)),
      /实践节点/,
    )
    // 材料形态枚举守门
    await assert.rejects(
      () => h.engine.receiptSubmit('数学', '练耳', { kind: 'video' as never, material: 'x' }, fakeLlm(0.5)),
      /kind 只能是/,
    )
    await assert.rejects(
      () => h.engine.receiptSubmit('数学', '练耳', { kind: 'text', material: '   ' }, fakeLlm(0.5)),
      /material 不能为空/,
    )
  })
})

test('事务性：AI 输出不可解析 → 回执与 EMA 零落盘；坏流水 Broken 报出', async () => {
  await withVault({ tag: 'receipt-tx', graph: GRAPH_PRACTICE, notes: { 练耳: {} } }, async h => {
    await assert.rejects(
      () => h.engine.receiptSubmit('数学', '练耳', { kind: 'text', material: 'x' }, async () => '模型胡言乱语'),
      /不是合法 JSON/,
    )
    assert.equal((await h.store.receiptsAll()).length, 0) // 回执未落
    const { loadNote } = await import('../src/engine/notes.ts')
    const { fm } = await loadNote(`${h.root}/学习中心/math/课程/基础/练耳.md`, nodeVaultFs)
    assert.equal(fm.practice_ema, undefined) // EMA 未动
    assert.equal(fm.practice.attempts, 0)
    // 坏流水 = Broken（不静默吞：渐退曲线会数错位置）
    const { appendFile } = await import('node:fs/promises')
    await appendFile(h.paths.receiptLogPath, '这不是JSON\n', 'utf8')
    await assert.rejects(() => h.engine.receiptList('数学', '练耳'), /Broken/)
    await assert.rejects(
      () => h.engine.receiptSubmit('数学', '练耳', { kind: 'text', material: 'x' }, fakeLlm(0.5)),
      /Broken/,
    )
  })
})

test('提示词模板：回执评审入 PROMPT_KINDS（可编辑、带版本标记）', async () => {
  await withVault({ tag: 'receipt-prompt', registry: null, graph: null }, async h => {
    assert.ok((await h.engine.content2.promptKinds()).includes('回执评审'))
    const tpl = await h.engine.content2.loadPrompt('回执评审')
    assert.ok(tpl.includes('回执评审'))
    assert.ok(tpl.includes('learnhub:prompt/v6'))
    assert.ok(Object.keys(RECEIPT_KIND_LABEL).length === 4)
  })
})

test('文件缺失 = 合法空态（不判 Broken、不判 Missing）', async () => {
  await withVault({ tag: 'receipt-empty', graph: GRAPH_PRACTICE, notes: { 练耳: {} } }, async h => {
    assert.equal(existsSync(h.paths.receiptLogPath), false)
    const list = await h.engine.receiptList('数学', '练耳')
    assert.equal(list.total, 0)
    assert.equal(list.receipts.length, 0)
    assert.equal(list.next_full_in, 1) // 与纯函数同口径：首份回执即完整评审
  })
})
