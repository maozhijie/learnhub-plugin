import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { withVault } from './helpers/vault.ts'
import { weekStartOf, weekEndOf, prevWeekStartOf, buildKataReality, renderKataReality } from '../src/engine/kata.ts'
import { todayStr, dayOfTs } from '../src/engine/dates.ts'

const BANK = [
  'node: 入门',
  'questions:',
  '  - id: q1',
  '    kind: true_false',
  '    q: 命题成立。',
  '    answer: true',
  '    difficulty: 2',
].join('\n')

test('学习周折叠：周一起算、上一完整周、跨月/跨年边界', () => {
  assert.equal(weekStartOf('2026-09-09'), '2026-09-07') // 周三 → 本周一
  assert.equal(weekStartOf('2026-09-06'), '2026-08-31') // 周日 → 上周一
  assert.equal(weekStartOf('2026-09-07'), '2026-09-07') // 周一 → 自身
  assert.equal(weekEndOf('2026-08-31'), '2026-09-06')
  assert.equal(prevWeekStartOf('2026-09-09'), '2026-08-31')
  assert.equal(prevWeekStartOf('2026-09-07'), '2026-08-31') // 周一当天，上一完整周是刚结束的
  assert.equal(weekStartOf('2026-01-01'), '2025-12-29') // 跨年
  assert.equal(prevWeekStartOf('2026-01-01'), '2025-12-22')
  assert.equal(weekStartOf('垃圾'), null)
})

test('现状聚合的凌晨学习日归属：01:00 行为过日界归前一天，落周口径随日界翻转（ADR-0020）', () => {
  const journal = [{ ts: '2026-09-07T01:00:00', course: '数学', node: '入门', rating: null, kind: 'x', elapsed_days: 0, xp: 30 }]
  const base = {
    weekStart: '2026-08-31', weekEnd: '2026-09-06',
    practice: [], journal, reviewLog: [], habitRepeats: [],
    projects: [], projectExec: {}, noteSources: {}, habitNames: {}, skillNames: {},
  }
  // 日界 02:00：周一凌晨 01:00 归属周日 09-06 → 落在复盘周内
  const folded = buildKataReality({ ...base, cutoffMin: 120 })
  assert.equal(folded.days, 1)
  assert.equal(folded.xp, 30)
  // 日界 00:00：周一 01:00 就是周一 → 落在下一周，复盘周空
  const plain = buildKataReality({ ...base, cutoffMin: 0 })
  assert.equal(plain.days, 0)
  assert.equal(plain.xp, 0)
})

test('#114 现状自动填：XP/作答/保留率/项目过点/习惯/技能/笔记源出链全部进「现状」段', async () => {
  const weekStart = prevWeekStartOf(todayStr(new Date()))!
  const weekEnd = weekEndOf(weekStart)!
  const mid = (offset: number): string => {
    const d = new Date(`${weekStart}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + offset)
    return `${d.toISOString().slice(0, 10)}T12:00:00`
  }
  await withVault({
    banks: { '入门': BANK },
    files: [{ path: '读书笔记/吉他.md', content: '# 吉他\n' }],
  }, async ({ engine }) => {
    // 上一周的真实行为：作答（XP）+ 笔记源复习 + 习惯重复 + 技能执行事件 + 项目过点
    await engine.noteSourceRegister('读书笔记/吉他.md')
    await engine.store.appendPractice({ ts: mid(0), course: '数学', node: '入门', ex: 1, answer: '对', correct: true, judge: 'auto', qid: 'q1', xp: 60 })
    await engine.store.appendJournal({ ts: mid(2), course: '数学', node: '入门', rating: null, kind: 'xp_bonus', elapsed_days: 0, xp: 10 })
    await engine.store.appendReview({ ts: mid(1), course: '笔记源', node: 'note-1', qid: 'q1', rating: 3, rating_source: 'self', elapsed_days: 3, stability_before: 5, difficulty_before: 5, r_pred: 0.8 })
    await engine.store.appendReview({ ts: mid(3), course: '*', node: '吉他', qid: 'exec', rating: 4, rating_source: 'execution', event_kind: 'acquisition', exec_source: 'self', elapsed_days: 2, stability_before: 4, difficulty_before: 5, r_pred: 0.7 })
    await engine.store.appendHabitRepeat({ ts: mid(1), habit: '晨间拉伸', day: dayOfTs(mid(1)) })
    await engine.projectCreate({ name: '吉他翻新', goal: 'g' })
    const prop = await engine.projectPlanPropose('吉他翻新', 'project: 吉他翻新\nplan:\n  - { id: m1, name: 换弦, task_class: 照做, acceptance_hints: 能换弦 }\n')
    await engine.projectApply(prop.id)
    await engine.store.appendJournal({ ts: mid(4), course: '吉他翻新', node: 'm1', rating: null, kind: 'milestone_settle', elapsed_days: 0, xp: 60, detail: '里程碑「换弦」过点：x' })

    const doc = await engine.learner.kataOpen(weekStart)
    assert.equal(doc.created, true)
    assert.ok(doc.path.replace(/\\/g, '/').includes(`/我的产出/周复盘/${weekStart}.md`), '#107 输出区约定落盘')
    assert.equal(doc.answered, false)
    assert.equal(doc.sections['目标条件'], '（待答）')
    // 现状 = 引擎自动填：数字来自上一周真实流水；笔记源出链指向个人笔记（V-3）
    assert.match(doc.reality, new RegExp(`XP \\+\\d`))
    assert.match(doc.reality, /作答 1 次/)
    assert.match(doc.reality, /到期复习 1 次/)
    assert.match(doc.reality, /习惯「晨间拉伸」重复 1 次/)
    assert.match(doc.reality, /技能「吉他」执行 1 次/)
    assert.match(doc.reality, /吉他翻新：过点 1 个（换弦）/)
    assert.match(doc.reality, /\[\[读书笔记\/吉他\|吉他\]\]：复习 1 次/)
    const fileText = await readFile(doc.path, 'utf8')
    assert.match(fileText, /kind: weekly_kata/)
    assert.match(fileText, /week_start: /)
  })
})

test('#114 四问保存与重开：引擎段刷新、四问保留；answered 随四问齐备翻转', async () => {
  const weekStart = prevWeekStartOf(todayStr(new Date()))!
  await withVault({}, async ({ engine }) => {
    await assert.rejects(() => engine.learner.kataSave(weekStart, { 目标条件: 'x' }), /先 learnhub_kata_open/)
    await engine.learner.kataOpen(weekStart)
    await assert.rejects(() => engine.learner.kataOpen('2026-09-02'), /周一/) // 非周一拒绝
    await assert.rejects(() => engine.learner.kataOpen(weekStartOf(todayStr(new Date()))!), /最近的完整周/) // 本周未完，不预填未来

    await engine.learner.kataSave(weekStart, { 目标条件: '稳定过 20 题/天', 障碍: '晚上总被杂事打断' })
    let doc = await engine.learner.kataOpen(weekStart) // 重开：四问保留
    assert.equal(doc.created, false)
    assert.equal(doc.sections['目标条件'], '稳定过 20 题/天')
    assert.equal(doc.sections['障碍'], '晚上总被杂事打断')
    assert.equal(doc.answered, false, '还差两问')
    assert.equal(doc.sections['现状'].includes('### 总览'), true, '引擎段保持')

    await engine.learner.kataSave(weekStart, { 下一实验: '把复习放在早上', 预期所学: '保留率上升' })
    doc = await engine.kataList().then(l => l[0])
    assert.equal(doc.answered, true, '四问齐备')
  })
})

test('#114 「下一实验」出口：一键转 N-of-1 提案 / 执行意图，留痕进记录、全路径零 canonical 零 XP', async () => {
  const weekStart = prevWeekStartOf(todayStr(new Date()))!
  await withVault({ banks: { '入门': BANK } }, async ({ engine }) => {
    await engine.learner.kataOpen(weekStart)
    await engine.learner.kataSave(weekStart, { 下一实验: '试试挑战带', 目标条件: 'x', 障碍: 'y', 预期所学: 'z' })

    // canonical 字节快照：复盘全路径（open/save/转换）零 journal/practice/review-log 写入、零 XP
    const snap = async (): Promise<[string, string, string, string]> => [
      await readFile(join(engine.paths.centerStateDir, 'journal.jsonl'), 'utf8').catch(() => ''),
      await readFile(join(engine.paths.centerStateDir, 'practice.jsonl'), 'utf8').catch(() => ''),
      await readFile(join(engine.paths.centerStateDir, 'review-log.jsonl'), 'utf8').catch(() => ''),
      await readFile(join(engine.paths.courseRoot('math'), '课程', '基础', '入门.md'), 'utf8').catch(() => '(无笔记)'),
    ]
    const before = await snap()

    const exp = await engine.kataToExperiment(weekStart, 'band_default_std_vs_hard')
    assert.ok(exp.proposal >= 1)
    const int = await engine.kataToIntention(weekStart, { course: '数学', node: '入门', cue: '早上刷完牙后', action: '做 5 道到期复习' })
    assert.equal(int.node, '入门')
    // 执行意图确实挂上了今日 pin（既有 C-5 机制）
    const pins = await engine.store.loadPins()
    assert.equal(pins.filter(p => p.intention).length, 1)

    const after = await snap()
    assert.deepEqual(after, before, 'journal/practice/review-log/课程笔记逐字节原样——零 canonical、零 XP')
    const text = await readFile(engine.learner.kataPath(weekStart), 'utf8')
    assert.match(text, /已转 N-of-1 实验提案 #\d+/)
    assert.match(text, /已挂今日执行意图（入门/)
  })
})

test('#114 清单面：多周记录按周排列，answered 现判', async () => {
  const w1 = prevWeekStartOf(todayStr(new Date()))!
  const d = new Date(`${w1}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 7)
  const w0 = weekStartOf(d.toISOString().slice(0, 10))!
  await withVault({}, async ({ engine, paths }) => {
    await engine.learner.kataOpen(w1)
    await engine.learner.kataSave(w1, { 目标条件: 'a', 障碍: 'b', 下一实验: 'c', 预期所学: 'd' })
    await engine.learner.kataOpen(w0)
    const list = await engine.kataList()
    assert.deepEqual(list.map(x => x.week_start), [w0, w1])
    assert.equal(list[0].answered, false)
    assert.equal(list[1].answered, true)
    // 记录落在输出区约定位置：我的产出/周复盘/<周一>.md（公开 Paths 面，不走私有方法）
    assert.ok(existsSync(`${paths.outputKindDir('周复盘')}/${w0}.md`))
  })
})

// ---- #150 罗盘周 ETA 挂周复盘：现状区旁挂沙盘 ETA 摘要 ----

test('#150 现状区旁挂沙盘 ETA：有锚课程逐课一行越阈参照（非承诺措辞）；未播种无此小节', async () => {
  const weekStart = prevWeekStartOf(todayStr(new Date()))!
  const SEED = `course: 数学
mode: new
concepts:
  - canonical: 变化率
endpoint:
  name: 用导数解决优化问题
  region: 基础
  block: 终点块
  teaches: {变化率: 会用}
starts:
  - name: 认识变化率
    region: 基础
    block: 起点块
    basis: baseline
    teaches: {变化率: 会用}
`
  await withVault({ registry: null, graph: null }, async ({ engine }) => {
    // 未播种：无 ETA 小节（合法空态——透明度装置锚在终点锚上）
    const bare = await engine.learner.kataOpen(weekStart)
    assert.doesNotMatch(bare.reality, /### 沙盘 ETA/)

    // 播种（终点锚在位）→ 打开复盘即旁挂 ETA 摘要
    const r = await engine.graphPropose('seed', SEED) as { id: number }
    await engine.graphApply('seed', r.id)
    const doc = await engine.learner.kataOpen(weekStart)
    assert.match(doc.reality, /### 沙盘 ETA/)
    assert.match(doc.reality, /数学 → 终点「用导数解决优化问题」：p50/)
    assert.match(doc.reality, /p80/)
    assert.match(doc.reality, /每日约 30 分钟口径；模型推演，非承诺/)
    // 旁挂与罗盘挂载同一份数据：罗盘「沙盘 ETA」段同时被刷出（写侧幂等归 compass.test.ts）
  })
})

test('#150 ETA 旁挂渲染：注入摘要逐课一行、周次未及如实说；空注入零小节', () => {
  const reality = buildKataReality({
    weekStart: '2026-09-07', weekEnd: '2026-09-13', cutoffMin: 0,
    practice: [], journal: [], reviewLog: [], habitRepeats: [],
    projects: [], projectExec: {}, noteSources: {}, habitNames: {}, skillNames: {},
  })
  const etas = [{
    course: '数学', endpoint: '用导数解决优化问题', minutes_per_day: 30,
    p50_week: { at: 8, from: 4 }, p80_week: null, horizon: 24,
    wording: '模型推演，非承诺',
  }]
  const md = renderKataReality(reality, etas)
  assert.ok(md.includes('### 沙盘 ETA'))
  assert.ok(md.includes('数学 → 终点「用导数解决优化问题」：p50约 5–8 周；p80推演时程（24 周）内未及（每日约 30 分钟口径；模型推演，非承诺）'))
  assert.ok(md.indexOf('### 有界 · 课程') < md.indexOf('### 沙盘 ETA'), '小节旁挂在有界 · 课程之后')
  assert.ok(md.indexOf('### 沙盘 ETA') < md.indexOf('### 有界 · 项目'))
  assert.doesNotMatch(renderKataReality(reality), /### 沙盘 ETA/, '空注入 = 零小节（缺席降级）')
})
