import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { calibrationHintText, calibrationProfileView, overconfidenceOf } from '../src/engine/calibration.ts'
import type { PracticeRec } from '../src/engine/types.ts'
import { LearnhubEngine } from '../src/engine/index.ts'
import { tfQuestion, withVault } from './helpers/vault.ts'

// Self-Calibration 自评校准画像(ADR-0022 / #104):跨源「自评档 × 客观判分」配对画像,
// 分源自省面为主、全局聚合只作参考视图(带域特异警戒);过信检出 → 显式轻提示 +
// JOL 抽查密度加强(呈现层,可全局关)。红线:画像只读派生,零 canonical 写入。
// 名词边界:memory.ts 的 FSRS calibrationBins(r_pred × 实际保留率)是模型体检,
// 本文件刻意不 import 其聚合,画像 schema 也不含 r_pred(混入即回归)。

/** 到期 true_false 题(与 jol.test 同款:R 低 → 全部 0 分候选,抽样可确定性断言)。 */
const DUE_TF = {
  difficulty: 1,
  fsrs: { stability: 0.5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 2, lapses: 0 },
}

const rec = (p: Partial<PracticeRec>): PracticeRec => ({
  ts: '2026-09-08T10:00:00+08:00', course: '数学', node: '入门', ex: 1,
  answer: '', correct: true, judge: 'true_false', ...p,
})

/** 「会」档过信流水:n 条、correct 率 = every(第 every 条对一次)。 */
const huiRecs = (n: number, correctEvery = 4): PracticeRec[] =>
  Array.from({ length: n }, (_, i) => rec({
    qid: `q${i}`, predicted: '会', correct: i % correctEvery === 0,
  }))

// ---- 纯规则(接缝 S37)----

test('overconfidenceOf:「会」档 ≥10 条且实际正确率低于阈值 → 检出带证据;数据不足门槛静默', () => {
  // 12 条「会」、正确率 0.25(显著低于 0.6)
  const hit = overconfidenceOf(huiRecs(12))
  assert.equal(hit.overconfident, true)
  assert.deepEqual(hit.evidence, {
    source: 'jol', self: '会', n: 12, accuracy: 0.25, threshold: 0.6,
  })

  // 边界:正确率恰等于阈值(10 条对 6)= 0.6 → 不算低于,不检出(证据仍透出)
  const atThreshold = overconfidenceOf(huiRecs(10, 1).map((r, i) => ({ ...r, correct: i < 6 })))
  assert.equal(atThreshold.overconfident, false)
  assert.equal(atThreshold.evidence?.accuracy, 0.6)

  // 档内条数不足门槛(总配对够但「会」档只有 6 条)→ 静默
  const mixed = [
    ...huiRecs(6, 1).map(r => ({ ...r, correct: false as const })),
    ...Array.from({ length: 4 }, (_, i) => rec({ qid: `n${i}`, predicted: '不会' as const, correct: true })),
  ]
  assert.deepEqual(overconfidenceOf(mixed), { overconfident: false, evidence: null })

  // 总配对不足门槛(jolCalibration 为 null)→ 静默
  assert.deepEqual(overconfidenceOf(huiRecs(9, 4)), { overconfident: false, evidence: null })
})

test('calibrationProfileView:分源可读(jol bins+正确率),全局参考视图带域特异警戒;非配对记录不混入', () => {
  const recs = [
    ...huiRecs(12), // 「会」12 条、0.25
    ...Array.from({ length: 4 }, (_, i) => rec({ qid: `n${i}`, predicted: '不会' as const, correct: true })),
    rec({ predicted: null, correct: true }), // 无自评档:不落配对
    rec({ predicted: '会', correct: null }), // 无客观判分:不落配对
  ]
  const doc = calibrationProfileView(recs)
  assert.equal(doc.sources.length, 1, 'v1 只有 jol 源')
  const jol = doc.sources[0]!
  assert.equal(jol.source, 'jol')
  assert.equal(jol.calibration?.pairs, 16)
  const hui = jol.calibration?.bins.find(b => b.label === '会')
  assert.equal(hui?.n, 12)
  assert.equal(hui?.accuracy, 0.25)
  assert.equal(jol.overconfidence.overconfident, true)

  assert.equal(doc.global.calibration?.pairs, 16, '全局 = 各源合并(v1 平凡情形)')
  assert.match(doc.global.warning, /域特异/)
  assert.match(doc.global.warning, /分源/)

  // 名词边界:画像不含 FSRS r_pred 自校准词汇
  assert.ok(!JSON.stringify(doc).includes('r_pred'))
})

test('calibrationProfileView:配对不足门槛 → 该源 calibration 为 null(静默不造假)', () => {
  const doc = calibrationProfileView(huiRecs(9))
  assert.equal(doc.sources[0]!.calibration, null)
  assert.deepEqual(doc.sources[0]!.overconfidence, { overconfident: false, evidence: null })
  assert.equal(doc.global.calibration, null)
  assert.ok(doc.global.warning, '警戒标注仍随参考视图带出')
})

test('calibrationHintText:检出才给文案(预期管理语气);未检出/数据不足为 null', () => {
  const hit = overconfidenceOf(huiRecs(12))
  const text = calibrationHintText(hit)
  assert.match(text ?? '', /「会」/)
  assert.match(text ?? '', /保守/)
  assert.equal(calibrationHintText({ overconfident: false, evidence: null }), null)
  assert.equal(calibrationHintText({ overconfident: false, evidence: hit.evidence }), null)
})

// ---- 门面:画像入口 / 抽查密度加强与队列提示 / 全局开关 ----

/** 播种「会」档过信流水(12 条、正确率 0.25)进 practice 流水。 */
async function seedOverconfident(engine: LearnhubEngine): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await engine.store.appendPractice({
      course: '数学', node: '入门', ex: 1, answer: '', correct: i % 4 === 0,
      judge: 'true_false', qid: `seed${i}`, predicted: '会',
    })
  }
}

const SIX_DUE = {
  notes: { 入门: { stage: 'review' } },
  banks: {
    入门: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map(id => tfQuestion(id, DUE_TF)),
  },
}

test('calibrationProfile 门面:过信流水 → 分源可读、全局带警戒;门槛前该源为 null', async () => {
  await withVault(SIX_DUE, async ({ engine }) => {
    const empty = await engine.calibrationProfile()
    assert.equal(empty.sources[0]!.calibration, null, '无配对不显示')
    assert.equal(empty.global.calibration, null)

    await seedOverconfident(engine)
    const doc = await engine.calibrationProfile()
    const jol = doc.sources[0]!
    assert.equal(jol.source, 'jol')
    assert.equal(jol.calibration?.pairs, 12)
    assert.equal(jol.calibration?.bins.find(b => b.label === '会')?.accuracy, 0.25)
    assert.equal(jol.overconfidence.overconfident, true)
    assert.equal(jol.overconfidence.evidence?.n, 12)
    assert.match(doc.global.warning, /域特异/)
  })
})

test('reviewQueue:过信检出且提示开 → 抽样 1/3→1/2 加强 + 队列带轻提示;提示全局关后两者消失', async () => {
  await withVault(SIX_DUE, async ({ engine }) => {
    await seedOverconfident(engine)
    engine.jolRng = () => 0.5
    assert.deepEqual(await engine.calibrationHintsConfig(), { hints_enabled: true }, '缺省开(可全局关)')

    const r = await engine.reviewQueue('数学') as { cards: Array<{ jol?: boolean }>; calibration_hint?: string }
    assert.equal(r.cards.filter(c => c.jol).length, 3, '6 张 × 1/2(加强密度)= 3')
    assert.match(r.calibration_hint ?? '', /「会」/)
    assert.match(r.calibration_hint ?? '', /保守/)
    assert.equal(r.calibration_hint, calibrationHintText((await engine.calibrationProfile()).sources[0]!.overconfidence),
      '队列提示 = 引擎文案决策,单一出处')

    // 定向(单节点)队列同样带出
    const rNode = await engine.reviewQueue('数学', '入门') as { calibration_hint?: string }
    assert.match(rNode.calibration_hint ?? '', /保守/)

    // 全局关:密度回落 1/3、提示消失(既有 JOL 开关不受影响)
    await engine.setCalibrationHints(false)
    assert.deepEqual(await engine.calibrationHintsConfig(), { hints_enabled: false })
    const r2 = await engine.reviewQueue('数学') as { cards: Array<{ jol?: boolean }>; calibration_hint?: string }
    assert.equal(r2.cards.filter(c => c.jol).length, 2, '回落 1/3:6 张 × 1/3 = 2')
    assert.equal(r2.calibration_hint, undefined)
  })
})

test('门槛静默:配对不足时队列无加强、无提示,不报错', async () => {
  await withVault(SIX_DUE, async ({ engine }) => {
    // 6 条全错「会」:低于门槛,即使正确率显著低也不触发
    for (let i = 0; i < 6; i++) {
      await engine.store.appendPractice({
        course: '数学', node: '入门', ex: 1, answer: '', correct: false,
        judge: 'true_false', qid: `seed${i}`, predicted: '会',
      })
    }
    engine.jolRng = () => 0.5
    const r = await engine.reviewQueue('数学') as { cards: Array<{ jol?: boolean }>; calibration_hint?: string }
    assert.equal(r.cards.filter(c => c.jol).length, 2, '仍按 1/3 抽样')
    assert.equal(r.calibration_hint, undefined)
  })
})

// ---- 红线(ADR-0022 裁决 5):画像永不折扣自评对 canonical 的驱动 ----

/** vault 全量文件快照(相对路径 → 内容),字节级零写入断言。 */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else files[relative(root, p)] = await readFile(p, 'utf8')
    }
  }
  await walk(root)
  return files
}

const loadQ = async (engine: LearnhubEngine, qid: string) => {
  const bank = await engine.bank.load(engine.paths.courseRoot('math'), '入门')
  return bank.questions.find(x => x.id === qid)!
}

test('红线:画像/提示/密度全开——读路径零写入;复习自评档原样推 FSRS、XP 照记', async () => {
  await withVault(SIX_DUE, async ({ engine, root }) => {
    await seedOverconfident(engine) // 过信态就位(画像会检出)
    const llm = async () => { throw new Error('不应调用 LLM') }

    // 复习流自评通道原样工作:预测「会」+ deferSchedule 答对挂起 → 自评 Good 结算推 FSRS
    const ans = await engine.questionAnswer(llm, '数学', '入门', 'q1', 'true', 30,
      { deferSchedule: true, predicted: '会' }) as { pendingRating?: boolean; previews?: { good: string } }
    assert.equal(ans.pendingRating, true)
    const rated = await engine.questionRate('数学', '入门', 'q1', 3) as { scheduled?: boolean; due?: string }
    assert.equal(rated.scheduled, true)
    assert.equal(rated.due, ans.previews?.good, '自评档 Good 原样决定到期(评分行为不被画像改动)')
    const q1 = await loadQ(engine, 'q1')
    assert.equal(q1.fsrs?.reps, 3, '种子卡 reps=2,自评 Good 真实推进 +1')
    const rl = await engine.store.reviewLogAll()
    assert.equal(rl.length, 1)
    assert.equal(rl[0]!.rating_source, 'self')
    assert.equal(rl[0]!.rating, 3, '自评 Good 不因过信画像被折扣/改写')

    // 画像全开后的全部读路径:vault 字节级不变(零 canonical 写入)
    const before = await snapshot(root)
    const xpBefore = await engine.xpStatus()
    await engine.calibrationProfile()
    await engine.reviewQueue('数学')
    await engine.reviewQueue('数学', '入门')
    assert.deepEqual(await snapshot(root), before, '画像/队列读路径零落盘(含题库 fsrs、笔记 frontmatter、流水)')
    assert.deepEqual(await engine.xpStatus(), xpBefore, 'XP 账本零变化')
  })
})
