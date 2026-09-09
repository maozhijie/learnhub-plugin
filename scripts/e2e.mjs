/**
 * 端到端写路径测试：把 学习中心 的最小子集复制到临时目录，在副本上跑
 * 题库保存/刷卡作答（题目级 FSRS）/跳过/完成/审计/doctor/面板扩展接口 全链路，
 * 绝不触碰真实 vault。种子课程动态探测（注册表第一门启用课），课程名不硬编码。
 * 用法：node scripts/e2e.mjs <vault 路径>
 */
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, writeSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LearnhubEngine } from '../lib/engine.js'

const vault = process.argv[2]
if (!vault) {
  console.error('usage: node scripts/e2e.mjs <vault>')
  process.exit(1)
}
const scratch = join(tmpdir(), `learnhub-e2e-${process.pid}`)
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
const srcCenter = join(vault, '学习中心')
const dstCenter = join(scratch, '学习中心')

// 种子课程动态探测：注册表第一门启用课（真实 vault 的课程名不固定）
const probe = new LearnhubEngine({ vault })
const seed = (await probe.enabledCourses())[0]
if (!seed) {
  console.error('e2e: 注册表里没有启用中的课程，无法取种子')
  process.exit(1)
}
const courseName = seed.name
const courseRoot = seed.root
// 最小子集：单课程注册表 + 该课图数据 + 一份课程笔记（重置为未学状态）
mkdirSync(join(dstCenter, courseRoot, 'state'), { recursive: true })
mkdirSync(join(dstCenter, 'state'), { recursive: true })
writeFileSync(
  join(dstCenter, '课程注册表.yaml'),
  ['courses:', `  - id: ${seed.id ?? `${courseRoot}-01`}`, `    name: ${courseName}`, `    root: ${courseRoot}`, '    enabled: true', ''].join('\n'),
  'utf8',
)
// 逐项手动复制：本机环境（Desktop 目录的云同步/过滤驱动 + Node fs.cpSync）会以
// 0xC0000409 原生崩溃（基线 e2e 同样可复现），readFile/writeFile 路径不受影响
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name)
    const d = join(dest, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else writeFileSync(d, readFileSync(s))
  }
}
copyDir(join(srcCenter, courseRoot, 'data'), join(dstCenter, courseRoot, 'data'))
function findNote(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findNote(p)
      if (hit) return hit
    } else if (e.name.endsWith('.md')) return p
  }
  return null
}
const srcNote = findNote(join(srcCenter, courseRoot, '课程'))
if (!srcNote) {
  console.error('e2e: 种子课程没有课程笔记，无法取节点')
  process.exit(1)
}
/** 递归找文件（reset/points 断言用）。 */
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (e.name === name) return p
  }
  return null
}
const noteName = basename(srcNote).replace(/\.md$/, '')
{
  const rel = srcNote.slice(srcCenter.length + 1)
  mkdirSync(dirname(join(dstCenter, rel)), { recursive: true })
  // 重置 frontmatter 为未学状态：真实 vault 的笔记可能已有 fsrs/practice 历史，
  // 而 grade/reps/journal 断言依赖「首次学习」语义（CRLF 正文一并统一为 LF）。
  const text = readFileSync(srcNote, 'utf8')
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '')
  const fresh = [
    '---',
    `node: ${noteName}`,
    'stage: ready',
    'fsrs: null',
    'mastery: 0',
    'content:',
    '  version: 0',
    '  generated_at: null',
    '  status: draft',
    'practice:',
    '  attempts: 0',
    '  correct: 0',
    '---',
    '',
    body.replace(/\r\n/g, '\n'),
  ].join('\n')
  writeFileSync(join(dstCenter, rel), fresh, 'utf8')
}

let failed = 0
const step = async (name, fn) => {
  try {
    // 同步 stderr 打点：Windows 原生崩溃（0xC0000409）时同步写不丢失，能定位到具体步骤
    writeSync(2, `[step] ${name}\n`)
    await fn()
    console.log(`OK  ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL ${name}: ${err.message}`)
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed') }

async function run() {
  const engine = new LearnhubEngine({ vault: scratch })
  // 学习日从引擎取（ADR-0020）：日界可配置（默认 02:00），UI/脚本不得自算日历日
  const learningToday = (await engine.xpStatus()).date
  await step('questionSave', async () => {
    const r = await engine.questionSave(courseName, noteName, [
      'node: ' + noteName,
      'questions:',
      '  - id: q1',
      '    kind: single_choice',
      '    q: 0 是不是自然数？',
      '    options: ["A. 是","B. 不是"]',
      '    answer: A',
      '    explanation: 我国中小学教材规定 0 是自然数。',
      '  - id: q2',
      '    kind: fill_in_blank',
      '    q: 最小的自然数是____。',
      '    answer: ["0","零"]',
    ].join('\n'))
    assert(r.count === 2 && existsSync(r.path), 'bank file not written')
  })
  await step('questions(list)', async () => {
    const r = await engine.questions(courseName, noteName)
    assert(r.questions.length === 2 && r.questions[0].id === 'q1', 'bank list mismatch')
    assert(!('answer' in r.questions[0]), 'answers must not leak in list')
  })
  await step('questionAnswer 正确(single_choice) → 题目 FSRS 推进', async () => {
    const r = await engine.questionAnswer(async () => { throw new Error('should not call llm') }, courseName, noteName, 'q1', 'A')
    assert(r.correct === true && r.score === 100, `expected correct, got ${JSON.stringify(r)}`)
    assert(r.explanation.includes('0 是自然数'), 'explanation missing')
    assert(typeof r.due === 'string' && r.due > learningToday, `fsrs due missing: ${r.due}`)
    assert(r.mastery > 0, `mastery=${r.mastery}`)
    const bank = await engine.bank.load(engine.paths.courseRoot(courseRoot), noteName)
    const q1 = bank.questions.find(q => q.id === 'q1')
    assert(q1.fsrs?.reps === 1 && q1.stats?.attempts === 1 && q1.stats.correct === 1, 'question fsrs/stats not written')
  })
  await step('questionAnswer 同日重刷不推进调度', async () => {
    const r = await engine.questionAnswer(async () => { throw new Error('no llm') }, courseName, noteName, 'q1', 'A')
    assert(r.scheduled === false, `scheduled=${r.scheduled}（同日重刷应仅记统计）`)
    const bank = await engine.bank.load(engine.paths.courseRoot(courseRoot), noteName)
    const q1 = bank.questions.find(q => q.id === 'q1')
    assert(q1.fsrs?.reps === 1, `reps=${q1.fsrs?.reps}（同日重刷不应推进）`)
    assert(q1.stats?.attempts === 2, `attempts=${q1.stats?.attempts}`)
  })
  await step('questionAnswer 错误(fill_in_blank)', async () => {
    const r = await engine.questionAnswer(async () => { throw new Error('should not call llm') }, courseName, noteName, 'q2', '1')
    assert(r.correct === false, 'expected wrong answer')
    assert(String(r.answer).includes('0'), 'correct answer not revealed')
  })
  await step('practice 证据落盘（frontmatter EMA + JSONL + stage→learning）', async () => {
    const { state } = await engine.loadView({ name: courseName, root: courseRoot })
    const fm = state[noteName]
    assert(fm.practice.attempts === 3, `attempts=${fm.practice.attempts}（q1×2 + q2×1，同日重刷也计入练习统计）`)
    assert(fm.practice.correct === 2, `correct=${fm.practice.correct}`)
    assert(fm.stage === 'learning', `stage=${fm.stage}（首答应推进 learning）`)
    const practiceTxt = readFileSync(join(dstCenter, 'state', 'practice.jsonl'), 'utf8')
    assert(practiceTxt.includes('"qid":"q1"'), 'practice jsonl missing qid')
  })
  await step('statusJson 反映到期', async () => {
    const doc = await engine.statusJson()
    const c = doc.courses[0]
    assert(c.total > 0 && typeof c.due_today === 'number', 'status shape broken')
  })
  await step('rebuild（审计 + 就绪清单）', async () => {
    const r = await engine.rebuild()
    assert(r.message.includes('审计'), r.message)
    assert(existsSync(join(dstCenter, courseRoot, '审计报告.md')), 'audit report missing')
    assert(existsSync(join(dstCenter, courseRoot, '就绪清单.md')), 'ready list missing')
  })
  await step('doctor', async () => {
    const doc = await engine.doctor()
    assert(doc.courses.length === 1, 'doctor shape')
  })
  await step('skip/complete + questionsAll（面板扩展接口）', async () => {
    // 完成确认：未作答题初始化 FSRS + stage→review
    const done = await engine.nodeComplete(courseName, noteName)
    assert(done.stage === 'review', `complete stage=${done.stage}`)
    const { state } = await engine.loadView({ name: courseName, root: courseRoot })
    assert(state[noteName].stage === 'review', `stage=${state[noteName].stage}`)
    // 跳过：另一节点 stage→skipped
    const all0 = await engine.questionsAll()
    const otherNode = all0.questions.find(q => q.node !== noteName)?.node
    if (otherNode) {
      const skip = await engine.nodeSkip(courseName, otherNode, true)
      assert(skip.stage === 'skipped', `skip stage=${skip.stage}`)
      await engine.nodeSkip(courseName, otherNode, false)
    }
    await engine.questionAdd(courseName, noteName, { kind: 'true_false', q: '追加题', answer: false })
    const all = await engine.questionsAll()
    assert(all.total === 3, `questionsAll total=${all.total}`)
    assert(!('answer' in all.questions[0]), 'answers must not leak in questionsAll')
    await engine.questionArchive(courseName, noteName, 'q3', true)
    const vis = await engine.questions(courseName, noteName)
    assert(vis.questions.every(q => q.id !== 'q3'), 'archived question still visible')
  })
  await step('XP 预算对账（净账 = N₀×k，settle 恰一次）', async () => {
    const journal = readFileSync(join(dstCenter, 'state', 'journal.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l))
    const settles = journal.filter(r => r.kind === 'xp_settle' && r.node === noteName)
    assert(settles.length === 1, `settle rows=${settles.length}`)
    const practice = readFileSync(join(dstCenter, 'state', 'practice.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l))
    const earned = practice.filter(r => r.node === noteName).reduce((s, r) => s + (r.xp ?? 0), 0)
      + journal.filter(r => r.node === noteName).reduce((s, r) => s + (r.xp ?? 0), 0)
    const bank = await engine.bank.load(engine.paths.courseRoot(courseRoot), noteName)
    // 与 engine 同公式重算预算：est 优先（图 YAML 内容定价），无 est → N₀ = Σ(权重×难度)；
    // k = FSRS difficulty 加权
    const W = { single_choice: 1, true_false: 1, fill_in_blank: 2, multi_choice: 1, numeric: 2, ordering: 2, matching: 2, reflection: 3, open_question: 3 }
    const qs = bank.questions.filter(q => !q.archived)
    let weights = 0
    let weighted = 0
    for (const q of qs) {
      const w = (W[q.kind] ?? 1) * Math.max(1, q.difficulty ?? 1)
      weights += w
      weighted += w * (q.fsrs?.difficulty ? q.fsrs.difficulty / 5 : 1)
    }
    const k = Math.min(3, Math.max(0.5, weighted / weights))
    const nodeEst = (await engine.graphNode(courseName, noteName)).est
    const contentBudget = typeof nodeEst === 'number' && nodeEst > 0 ? nodeEst : 3
    const budget = Math.round(contentBudget * k) // q3 已归档；settle 时 q3 尚未创建，两时刻题集相同
    assert(earned === budget, `net xp ${earned} != budget ${budget} (k=${k.toFixed(3)})`)
    // 难度修订放在对账之后：完成时定价已锁定，事后改难度不得动摇已结算账目
    await engine.questionUpdate(courseName, noteName, 'q2', { difficulty: 3 })
  })
  await step('graph edit propose→apply（rename 联动：笔记改名+题库随迁）', async () => {
    const prop = await engine.graphPropose('edit', [
      `course: ${courseName}`,
      'reason: e2e rename 联动验证',
      'ops:',
      `  - { op: rename, node: ${noteName}, new: ${noteName}B }`,
    ].join('\n'))
    const applied = await engine.graphApply('edit', prop.id)
    assert(applied.renames && applied.renames[noteName] === `${noteName}B`, 'rename not applied')
    const { state } = await engine.loadView({ name: courseName, root: courseRoot })
    assert(state[`${noteName}B`] && !state[noteName], 'note not relinked (frontmatter scan)')
    assert(existsSync(join(dstCenter, courseRoot, '题库', `${noteName}B.yaml`)), 'bank not migrated')
    assert(!existsSync(join(dstCenter, courseRoot, '题库', `${noteName}.yaml`)), 'old bank file still there')
  })
  await step('questionSave 5 种新题型（multi/numeric/ordering/matching/open）', async () => {
    const r = await engine.questionSave(courseName, `${noteName}B`, [
      'node: ' + `${noteName}B`,
      'questions:',
      '  - id: m1',
      '    kind: multi_choice',
      '    q: 以下哪些是自然数？',
      '    options: ["A. -1","B. 0","C. 3"]',
      '    answer: ["B","C"]',
      '    explanation: 0 与正整数都是自然数。',
      '  - id: n1',
      '    kind: numeric',
      '    q: 圆周率保留两位小数约为____。',
      '    answer: 3.14',
      '    tol: 0.05',
      '    explanation: π ≈ 3.14159。',
      '  - id: o1',
      '    kind: ordering',
      '    q: 按从小到大排序。',
      '    options: ["三","一","二"]',
      '    answer: ["一","二","三"]',
      '    explanation: 汉字数字顺序。',
      '  - id: p1',
      '    kind: matching',
      '    q: 国家与首都配对。',
      '    options: ["中国","法国"]',
      '    answer: ["北京","巴黎"]',
      '    explanation: 常识配对。',
      '  - id: w1',
      '    kind: open_question',
      '    q: 用自己的话说明自然数与整数的联系。',
      '    answer: 自然数是非负整数；整数在其基础上加入负数。',
      '    explanation: 综合应用题，AI 按 10 分制批改。',
    ].join('\n'))
    assert(r.count === 5, `count=${r.count}`)
  })
  await step('questions(list)：matching 暴露 pairOptions、answer 不泄漏', async () => {
    const r = await engine.questions(courseName, `${noteName}B`)
    assert(r.questions.length === 5, `len=${r.questions.length}`)
    const p1 = r.questions.find(q => q.id === 'p1')
    assert(Array.isArray(p1?.pairOptions) && p1.pairOptions.length === 2, 'matching pairOptions missing')
    assert(!('answer' in p1), 'matching answer leaked')
    const w1 = r.questions.find(q => q.id === 'w1')
    assert(w1?.kind === 'open_question', 'open_question kind missing')
  })
  await step('multi_choice 判卷（集合相等，顺序无关）', async () => {
    const noLlm = async () => { throw new Error('no llm') }
    const ok = await engine.questionAnswer(noLlm, courseName, `${noteName}B`, 'm1', 'C,B')
    assert(ok.correct === true && ok.score === 100, `expected correct, got ${JSON.stringify(ok)}`)
    const bad = await engine.questionAnswer(noLlm, courseName, `${noteName}B`, 'm1', 'A', 60)
    assert(bad.correct === false && bad.answer === 'BC', `expected wrong + reveal BC, got ${JSON.stringify(bad)}`)
  })
  await step('numeric 判卷（tol 容差）', async () => {
    const noLlm = async () => { throw new Error('no llm') }
    const ok = await engine.questionAnswer(noLlm, courseName, `${noteName}B`, 'n1', '3.13')
    assert(ok.correct === true, `tol 0.05 should accept 3.13: ${JSON.stringify(ok)}`)
    const bad = await engine.questionAnswer(noLlm, courseName, `${noteName}B`, 'n1', '0.5', 60)
    assert(bad.correct === false, '0.5 should be wrong')
  })
  await step('ordering 判卷（顺序敏感）', async () => {
    const noLlm = async () => { throw new Error('no llm') }
    const ok = await engine.questionAnswer(noLlm, courseName, `${noteName}B`, 'o1', '一\n二\n三')
    assert(ok.correct === true, `expected correct: ${JSON.stringify(ok)}`)
    const bad = await engine.questionAnswer(noLlm, courseName, `${noteName}B`, 'o1', '一\n三\n二', 60)
    assert(bad.correct === false, 'wrong order should fail')
    assert(bad.answer.includes('一 → 二 → 三'), `reveal chain: ${bad.answer}`)
  })
  await step('matching 判卷（逐位配对）', async () => {
    const noLlm = async () => { throw new Error('no llm') }
    const ok = await engine.questionAnswer(noLlm, courseName, `${noteName}B`, 'p1', '北京\n巴黎')
    assert(ok.correct === true, `expected correct: ${JSON.stringify(ok)}`)
    const bad = await engine.questionAnswer(noLlm, courseName, `${noteName}B`, 'p1', '巴黎\n北京', 60)
    assert(bad.correct === false, 'mismatch should fail')
    assert(bad.answer.includes('中国 → 北京'), `reveal pairs: ${bad.answer}`)
  })
  await step('open_question AI 判卷（10 分制，≥6 及格）', async () => {
    const ok = await engine.questionAnswer(
      async () => JSON.stringify({ score: 7, feedback: '要点覆盖良好，建议补充负数例子。' }),
      courseName, `${noteName}B`, 'w1', '自然数就是非负的整数。')
    assert(ok.correct === true && ok.score === 70, `expected 70/correct, got ${JSON.stringify(ok)}`)
    assert(String(ok.feedback).includes('建议'), 'feedback missing')
    const bad = await engine.questionAnswer(
      async () => JSON.stringify({ score: 3, feedback: '只说对了一半，请对照参考要点重写。' }),
      courseName, `${noteName}B`, 'w1', '不知道。', 60)
    assert(bad.correct === false && bad.score === 30, `expected 30/wrong, got ${JSON.stringify(bad)}`)
  })
  await step('乱猜（耗时<5s 且答错）：负 XP + 不推进 FSRS（含首答）', async () => {
    // m1 已答对过一次，此处乱猜触发「guess 优先于 repeat」分支：负分照记
    const r = await engine.questionAnswer(async () => { throw new Error('no llm') }, courseName, `${noteName}B`, 'm1', 'A', 1)
    assert(r.correct === false && r.xp === -1 && r.xp_reason === 'guess', `expected guess penalty, got ${JSON.stringify(r)}`)
    assert(r.scheduled === false, `scheduled=${r.scheduled}`)
    const bank = await engine.bank.load(engine.paths.courseRoot(courseRoot), `${noteName}B`)
    const m1 = bank.questions.find(q => q.id === 'm1')
    assert(m1.fsrs?.reps === 1, `reps=${m1.fsrs?.reps}（乱猜不应推进调度卡）`)
    assert(m1.stats?.attempts === 3, `attempts=${m1.stats?.attempts}`)
  })
  await step('interactive 交互件：标记块拆分落盘 + 引用替换 + 质检门', async () => {
    const html = '<!doctype html><html><body><canvas id="c"></canvas><script>postMessage({type:"LEARNHUB_COMPLETE"},"*")</script></body></html>'
    const body = ['# 交互正文', '', '```learnhub-interactive:交互/演示.html', html, '```', '', '完。'].join('\n')
    const r = await engine.contentApply(courseName, `${noteName}B`, body)
    assert(r.version > 0, `version=${r.version}`)
    const htmlPath = join(dstCenter, courseRoot, '交互', '演示.html')
    assert(existsSync(htmlPath), 'interactive html not written')
    assert(readFileSync(htmlPath, 'utf8').includes('LEARNHUB_COMPLETE'), 'html content mismatch')
    const check = await engine.contentCheck(courseName, `${noteName}B`)
    assert(check.passed, `gate should pass: ${check.findings.join('；')}`)
    // 删除落盘文件 → 质检门必须拒绝悬空引用
    rmSync(htmlPath)
    const broken = await engine.contentCheck(courseName, `${noteName}B`)
    assert(!broken.passed && broken.findings.some(f => f.includes('演示.html')), `gate should reject dangling interactive ref: ${JSON.stringify(broken)}`)
  })
  await step('交互件契约 v2：widget-config 齐备过门、缺上报/坏类型被拒', async () => {
    const htmlOk = '<!doctype html><html><head><script type="application/json" id="widget-config">{ "type": "simulation", "description": "演示" }</script></head><body><canvas id="c"></canvas><script>postMessage({type:"LEARNHUB_COMPLETE",score:1},"*")</script></body></html>'
    await engine.contentApply(courseName, `${noteName}B`, ['```learnhub-interactive:交互/v2演示.html', htmlOk, '```'].join('\n'))
    let threw = ''
    const missing = htmlOk.replace('LEARNHUB_COMPLETE', 'LEARNHUB_DONE')
    try {
      await engine.contentApply(courseName, `${noteName}B`, ['```learnhub-interactive:交互/v2缺上报.html', missing, '```'].join('\n'))
    } catch (err) { threw = err.message }
    assert(threw.includes('LEARNHUB_COMPLETE'), `missing report must reject: ${threw}`)
    threw = ''
    const badType = htmlOk.replace('"simulation"', '"holodeck"')
    try {
      await engine.contentApply(courseName, `${noteName}B`, ['```learnhub-interactive:交互/v2坏类型.html', badType, '```'].join('\n'))
    } catch (err) { threw = err.message }
    assert(threw.includes('类型菜单'), `bad widget type must reject: ${threw}`)
  })
  await step('富内容块门禁：plot/chart/svg 合法过门、非法被拒', async () => {
    const good = [
      '# 富内容',
      '',
      '```plot',
      '{ "xRange": [-2, 2], "yRange": [-2, 2], "elements": [ { "type": "fn", "expr": "x^2" } ] }',
      '```',
      '',
      '```chart',
      '{ "xAxis": { "type": "category", "data": ["a"] }, "yAxis": { "type": "value" }, "series": [ { "type": "bar", "data": [1] } ] }',
      '```',
      '',
      '```svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="10"/></svg>',
      '```',
    ].join('\n')
    await engine.contentApply(courseName, `${noteName}B`, good)
    let threw = ''
    try {
      await engine.contentApply(courseName, `${noteName}B`, good.replace('"fn"', 'not json here'))
    } catch (err) { threw = err.message }
    assert(threw.includes('不是合法 JSON'), `bad plot JSON must reject: ${threw}`)
    threw = ''
    try {
      await engine.contentApply(courseName, `${noteName}B`, good.replace('<svg xmlns', '<div xmlns'))
    } catch (err) { threw = err.message }
    assert(threw.includes('<svg'), `non-svg block must reject: ${threw}`)
  })
  await step('风格变体：promptKinds + loadPrompt 落盘 + 未知类型 fail loud', async () => {
    const kinds = await engine.promptKinds()
    // 节级风格变体内置；整课版「课程生成*」已退役（scratch 环境无遗留快照，不应出现）
    for (const k of ['课程大纲', '课程节生成', '课程节生成-苏格拉底', '课程节生成-费曼', '题目生成']) assert(kinds.includes(k), `missing prompt kind: ${k}`)
    assert(!kinds.includes('课程生成'), 'retired whole-node kind must not be built-in')
    const p = await engine.loadPrompt('课程节生成-苏格拉底')
    assert(p.length > 100, 'socratic prompt too short')
    assert(p.includes('## 类型：标题'), 'socratic style must stay a per-section template')
    assert(existsSync(join(dstCenter, 'state', '提示词', '课程节生成-苏格拉底.md')), 'style prompt not persisted')
    let threw = false
    try { await engine.loadPrompt('课程节生成-不存在') } catch { threw = true }
    assert(threw, 'unknown style must fail loud')
  })
  await step('提示词版本迁移：旧快照（无标记）→ v5 覆盖升级 + .bak 生成', async () => {
    const promptPath = join(dstCenter, 'state', '提示词', '课程节生成.md')
    writeFileSync(promptPath, '# 旧版课程节生成（无版本标记）\n\n旧内容', 'utf8')
    const text = await engine.loadPrompt('课程节生成')
    assert(text.startsWith('<!-- learnhub:prompt/v5 -->'), `vault snapshot should upgrade to v5, got: ${text.slice(0, 60)}`)
    assert(existsSync(`${promptPath}.bak`), '.bak not written')
    assert(readFileSync(`${promptPath}.bak`, 'utf8').includes('旧版课程节生成'), '.bak content mismatch')
    const bak1 = readFileSync(`${promptPath}.bak`, 'utf8')
    await engine.loadPrompt('课程节生成')
    assert(readFileSync(`${promptPath}.bak`, 'utf8') === bak1, 'same version must not rewrite bak')
  })
  await step('模型输出围栏容错：```yaml 包裹的大纲/题库 YAML 正常解析、空 sections 仍 fail loud', async () => {
    const fencedOutline = [
      '```yaml',
      `node: ${noteName}B`,
      'sections:',
      '  - id: s1',
      '    title: 概念：围栏容错',
      '    type: 概念',
      '    points: 冒烟',
      '    visual: 无',
      '```',
    ].join('\n')
    const manifest = await engine.contentOutline(courseName, `${noteName}B`, fencedOutline)
    assert(manifest.length === 1 && manifest[0].id === 's1', `outline manifest: ${JSON.stringify(manifest)}`)
    const fencedBank = [
      '```yaml',
      `node: ${noteName}B`,
      'questions:',
      '  - id: f1',
      '    kind: true_false',
      '    q: 围栏容错冒烟',
      '    answer: 对',
      '```',
    ].join('\n')
    const saved = await engine.questionSave(courseName, `${noteName}B`, fencedBank)
    assert(saved.count === 1, `fenced bank count=${saved.count}`)
    let threw = ''
    try {
      await engine.contentOutline(courseName, `${noteName}B`, '```yaml\nsections: []\n```')
    } catch (err) { threw = err.message }
    assert(threw.includes('sections 为空'), `empty sections must still fail loud: ${threw}`)
  })
  await step('节形状门禁 + 大纲 points 落盘 + mermaid 引号 warn', async () => {
    // 重跑大纲：points 保留进 frontmatter（contextPack 前置骨架的数据源）
    await engine.contentOutline(courseName, `${noteName}B`, [
      `node: ${noteName}B`,
      'sections:',
      '  - id: s1',
      '    title: 概念：形状门禁',
      '    type: 概念',
      '    points: 一句话要点甲',
      '    visual: 无',
    ].join('\n'))
    const notePath = findFile(join(dstCenter, courseRoot, '课程'), `${noteName}B.md`)
    assert(notePath, 'note file not found')
    assert(readFileSync(notePath, 'utf8').includes('points: 一句话要点甲'), 'outline points not persisted')
    // ### 子标题 → finding 拒
    let threw = ''
    try {
      await engine.contentSection(courseName, `${noteName}B`, 's1', '开头。\n\n### 非法子标题\n\n内容。')
    } catch (err) { threw = err.message }
    assert(threw.includes('### 子标题'), `### must reject: ${threw}`)
    // 超长 prose（>2000，不含代码块/公式）→ finding 拒
    threw = ''
    try {
      await engine.contentSection(courseName, `${noteName}B`, 's1', '好'.repeat(2200))
    } catch (err) { threw = err.message }
    assert(threw.includes('正文过长'), `overlong must reject: ${threw}`)
    // 合法节过门；未加引号的 mermaid | 只 warn 不拦
    await engine.contentSection(courseName, `${noteName}B`, 's1', '合法正文。\n\n```mermaid\ngraph TD\n  A[模 |v| 值] --> B[相等]\n```\n')
    const check = await engine.contentCheck(courseName, `${noteName}B`)
    assert(check.passed, `gate should pass: ${check.findings.join('；')}`)
    assert(check.warns.some(w => w.includes('未用双引号包裹')), `mermaid warn missing: ${JSON.stringify(check.warns)}`)
  })
  await step('图谱健康分/建议 + gen/edit 认知维度字段 + R13 跳步候选 + enc 反哺 hints', async () => {
    // gen 提案（含 est/type/bloom/difficulty）→ apply → findings + 字段落盘 + analyze health/suggestions
    const prop = await engine.graphPropose('gen', [
      `course: ${courseName}`,
      'mode: append',
      'regions:',
      '  - region: e2e认知区',
      '    blocks:',
      '      - name: 块甲',
      '        nodes:',
      '          - { name: 计算e2e基础量, pre: [], est: 10, bloom: 理解, difficulty: 1 }',
      '          - { name: 应用e2e基础量解题, pre: [计算e2e基础量], est: 20, bloom: 应用, difficulty: 3 }',
      '      - name: 块乙',
      '        nodes:',
      '          - { name: 证明e2e进阶结论, pre: [应用e2e基础量解题], est: 30, bloom: 分析, difficulty: 5 }',
    ].join('\n'))
    const applied = await engine.graphApply('gen', prop.id)
    assert(Array.isArray(applied.findings), `apply findings missing: ${JSON.stringify(applied)}`)
    const dataDir = join(dstCenter, courseRoot, 'data')
    const regionFile = readdirSync(dataDir).find(f => readFileSync(join(dataDir, f), 'utf8').includes('e2e认知区'))
    assert(regionFile, 'gen region file not found')
    const regionText = readFileSync(join(dataDir, regionFile), 'utf8')
    assert(regionText.includes('difficulty: 5') && regionText.includes('bloom: 分析') && regionText.includes('est: 30'), `gen node fields not persisted: ${regionText.slice(0, 400)}`)
    const a = await engine.graphAnalyze(courseName)
    assert(a.health && a.health.score >= 0 && a.health.score <= 100, `health: ${JSON.stringify(a.health)}`)
    for (const k of ['action_naming', 'est_coverage', 'pre_completeness', 'convergence', 'structure_hygiene']) {
      assert(k in a.health.breakdown, `breakdown missing ${k}: ${JSON.stringify(a.health.breakdown)}`)
    }
    assert(a.suggestions.expand_blocks.length > 0 && a.suggestions.expand_blocks.every(b => b.nodes < 5), `expand_blocks: ${JSON.stringify(a.suggestions.expand_blocks)}`)
    assert(Array.isArray(a.suggestions.missing_pre) && Array.isArray(a.suggestions.unconverged), 'suggestions shape')
    // edit add_node 字段透传（回归：旧实现一律丢弃 est/type）
    const prop2 = await engine.graphPropose('edit', [
      `course: ${courseName}`,
      'reason: e2e edit 认知维度',
      'ops:',
      '  - { op: add_node, node: 辨析e2e边界情形, region: e2e认知区, block: 块甲, pre: [计算e2e基础量], est: 15, type: practice, bloom: 分析, difficulty: 2 }',
    ].join('\n'))
    await engine.graphApply('edit', prop2.id)
    const regionText2 = readFileSync(join(dataDir, regionFile), 'utf8')
    assert(regionText2.includes('type: practice') && regionText2.includes('est: 15'), `edit node fields not persisted`)
    // audit：baseline 健康分行 + R13 认知跨步候选（难度3→5 故意埋的跳跃；R11 口径已并入 R13）
    await engine.rebuild()
    const report = readFileSync(join(dstCenter, courseRoot, '审计报告.md'), 'utf8')
    assert(report.includes('图谱健康分'), 'baseline missing health score')
    assert(report.includes('R13 认知跨步候选'), 'R13 jump-candidate warning missing in audit')
    // 非法 bloom 拒（schema 从严）
    let threw = ''
    try {
      await engine.graphPropose('edit', [
        `course: ${courseName}`,
        'reason: e2e 非法 bloom',
        'ops:',
        '  - { op: add_node, node: 理解e2e非法字段, region: e2e认知区, block: 块甲, pre: [], bloom: 顿悟 }',
      ].join('\n'))
    } catch (err) { threw = err.message }
    assert(threw.includes('非法认知层级'), `bad bloom must reject: ${threw}`)
    // set_enc 往返：整体替换 enc 边（字符串=权重1，映射带 w）→ 字段落盘；analyze schema 含字段值
    const propEnc = await engine.graphPropose('edit', [
      `course: ${courseName}`,
      'reason: e2e set_enc',
      'ops:',
      '  - op: set_enc',
      '    node: 计算e2e基础量',
      '    enc:',
      '      - 应用e2e基础量解题',
      '      - { node: 辨析e2e边界情形, w: 0.5 }',
    ].join('\n'))
    await engine.graphApply('edit', propEnc.id)
    const regionText3 = readFileSync(join(dataDir, regionFile), 'utf8')
    assert(regionText3.includes('node: 应用e2e基础量解题') && regionText3.includes('w: 0.5'), `set_enc not persisted: ${regionText3.slice(-400)}`)
    const a2 = await engine.graphAnalyze(courseName)
    const sNode = a2.schema['计算e2e基础量']
    assert(sNode && sNode.difficulty === 1 && sNode.est === 10 && Array.isArray(sNode.pre), `analyze schema: ${JSON.stringify(sNode)}`)
    assert(sNode.enc.some(e => e.node === '辨析e2e边界情形' && e.w === 0.5), `schema enc: ${JSON.stringify(sNode.enc)}`)
    // enc 断边拒（模拟图门禁）
    threw = ''
    try {
      await engine.graphPropose('edit', [
        `course: ${courseName}`,
        'reason: e2e enc 断边',
        'ops:',
        '  - { op: set_enc, node: 计算e2e基础量, enc: [不存在的节点X] }',
      ].join('\n'))
    } catch (err) { threw = err.message }
    assert(threw.includes('enc 断边'), `dangling enc must reject: ${threw}`)
    // 提案列表（agent 侧 pending 可见性）
    const appliedList = await engine.graphProposals('applied')
    assert(Array.isArray(appliedList) && appliedList.some(p => p.kind === 'edit'), `proposals list: ${JSON.stringify(appliedList).slice(0, 200)}`)
    // 探索工具：单节点详情 / 区块浏览 / 前置路径链
    const nd = await engine.graphNode(courseName, '计算e2e基础量')
    assert(nd.difficulty === 1 && nd.est === 10, `graphNode fields: ${JSON.stringify(nd)}`)
    assert(nd.succ.includes('应用e2e基础量解题'), `graphNode succ: ${JSON.stringify(nd.succ)}`)
    assert(nd.enc.some(e => e.node === '辨析e2e边界情形' && e.w === 0.5), `graphNode enc: ${JSON.stringify(nd.enc)}`)
    assert(Array.isArray(nd.prereq_closure), 'graphNode closure')
    const br = await engine.graphBrowse(courseName, 'e2e认知区')
    assert(br.total >= 4 && br.regions.length === 1 && br.regions[0].blocks.length === 2, `graphBrowse: ${JSON.stringify(br).slice(0, 200)}`)
    const pa = await engine.graphPath(courseName, '计算e2e基础量', '证明e2e进阶结论')
    assert(pa.related === true && pa.direct === false, `graphPath related: ${JSON.stringify(pa)}`)
    assert(JSON.stringify(pa.chain) === JSON.stringify(['计算e2e基础量', '应用e2e基础量解题', '证明e2e进阶结论']), `graphPath chain: ${JSON.stringify(pa.chain)}`)
    const pa2 = await engine.graphPath(courseName, '证明e2e进阶结论', '计算e2e基础量')
    assert(pa2.related === false, `reverse path must be unrelated: ${JSON.stringify(pa2)}`)
    // enc 反哺 hints：enc_candidates 引用非祖先节点 → contentApply 返回 hints
    const view = await engine.loadView({ name: courseName, root: courseRoot })
    const bNode = `${noteName}B`
    const outsider = view.graph.names.find(n => n !== bNode && !view.graph.isAncestor(n, bNode))
    assert(outsider, 'no outsider node found')
    const applied2 = await engine.contentApply(courseName, bNode, [
      '# e2e enc 反哺', '', '内容。', '', `<!-- enc_candidates: [${outsider}] -->`,
    ].join('\n'))
    assert(Array.isArray(applied2.hints) && applied2.hints.some(h => h.includes(outsider)), `hints: ${JSON.stringify(applied2.hints)}`)
  })
  await step('question_get：单题全量含答案（作答流 question_list 不泄题）', async () => {
    // noteName 已被 rename 联动改名为 noteNameB（题库随迁后被 fencedBank 整库覆盖为 f1）
    const g = await engine.questionGet(courseName, `${noteName}B`, 'f1')
    assert(g.question && g.question.answer === '对' && g.question.kind === 'true_false', `question_get: ${JSON.stringify(g).slice(0, 200)}`)
    let threw = ''
    try { await engine.questionGet(courseName, `${noteName}B`, '不存在题') } catch (err) { threw = err.message }
    assert(threw.includes('题库没有'), `unknown qid must fail loud: ${threw}`)
  })
  await step('生成任务注册表落盘往返（durable genJobs）', async () => {
    await engine.saveGenJobs([{ course: courseName, node: `${noteName}B`, kind: 'content', status: 'running', ts: new Date().toISOString() }])
    const jobs = await engine.loadGenJobs()
    assert(jobs.length === 1 && jobs[0].status === 'running', `roundtrip mismatch: ${JSON.stringify(jobs)}`)
    assert(existsSync(join(dstCenter, 'state', '生成任务.json')), 'gen jobs file missing')
  })
  await step('contentReset：笔记回 draft + 产物目录移入 .trash + 图谱保留', async () => {
    const r = await engine.contentReset(courseName)
    assert(r.course === courseName, `course=${r.course}`)
    assert(r.nodes.includes(`${noteName}B`), `reset nodes: ${JSON.stringify(r.nodes)}`)
    assert(r.trashed.includes('题库') && r.trashed.includes('交互'), `trashed: ${JSON.stringify(r.trashed)}`)
    assert(!existsSync(join(dstCenter, courseRoot, '题库')), 'bank dir should be moved')
    assert(existsSync(join(dstCenter, courseRoot, 'data')), 'graph data must stay')
    const notePath = findFile(join(dstCenter, courseRoot, '课程'), `${noteName}B.md`)
    const text = readFileSync(notePath, 'utf8')
    assert(text.includes('status: draft'), 'note not reset to draft')
    assert(!text.includes('形状门禁'), 'old body still present after reset')
    assert(readdirSync(join(dstCenter, '.trash')).some(d => d.startsWith('regenerate-')), 'trash backup missing')
  })
  await step('courseDelete（移入 .trash）', async () => {
    const r = await engine.courseDelete(courseName)
    assert(r.removed === courseName && existsSync(r.trash), 'trash dir missing')
    assert((await engine.registry.load()).length === 0, 'registry not emptied')
  })
  await step('插件加载冒烟：真实 bundle + mock ctx apply（拦住 defineTool schema/注册期错误）', async () => {
    // e2e 前面步骤都直调 engine，不经 defineTool——工具参数 schema 违规只在 dsh 启动时才爆。
    // 这里加载构建产物并用 mock ctx 跑真实 apply：每个工具注册即编译 schema，加载期错误在这里变 FAIL。
    // peer 包（dsh-llm/dsh-tools）不在插件的解析路径上：junction 到 workspace 包根（packages/<group>/<pkg>，
    // 注意 packages/<group> 是分组目录本身不是包；宿主包 exports 指 lib，需已在仓库根 pnpm build 过）。
    const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
    const peers = [
      ['dsh-llm', join(repoRoot, 'packages', 'llm', 'llm')],
      ['dsh-tools', join(repoRoot, 'packages', 'core', 'tools')],
    ]
    for (const [name, target] of peers) {
      const link = join(pluginRoot, 'node_modules', '@deepseek-ai', name)
      if (existsSync(link)) {
        if (realpathSync(link) === realpathSync(target)) continue
        rmSync(link, { recursive: true, force: true }) // 目标不对（如指到分组目录）则重建
      }
      if (!existsSync(join(target, 'package.json')) || !existsSync(join(target, 'lib'))) {
        console.warn(`[e2e] 插件加载冒烟跳过：宿主包未构建（${target}）——先在仓库根 pnpm build 后重跑可覆盖此检查`)
        return
      }
      mkdirSync(join(pluginRoot, 'node_modules', '@deepseek-ai'), { recursive: true })
      symlinkSync(target, link, 'junction')
    }
    const mod = await import('../lib/index.js')
    const tools = []
    const ctx = {
      tools: { register: def => { tools.push(def); return () => {} } },
      effect: fn => fn(),
      llm: {},
      webServer: { register: () => () => {} },
    }
    await mod.apply(ctx, { vault: scratch })
    assert(tools.length >= 25, `tool count: ${tools.length}`)
    const names = new Set(tools.map(t => t.name))
    for (const k of ['learnhub_graph_node', 'learnhub_graph_browse', 'learnhub_graph_path', 'learnhub_question_get', 'learnhub_question_update', 'learnhub_course_reset', 'learnhub_course_delete']) {
      assert(names.has(k), `missing tool: ${k}`)
    }
  })
  console.log(failed ? `\n${failed} step(s) FAILED (scratch: ${scratch})` : `\nall e2e steps OK (scratch: ${scratch})`)
  rmSync(scratch, { recursive: true, force: true })
  // process.exitCode 而非 process.exit：Windows 上管道/重定向的 stdout 是异步的，
  // process.exit 会丢弃尚未 flush 的输出（症状：整段 OK/FAIL 日志消失、只剩退出码）
  process.exitCode = failed ? 1 : 0
}

await run()
