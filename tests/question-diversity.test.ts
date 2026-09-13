/**
 * 出题多样性仪表测试（#230 / ADR-0064）。
 *
 * 三段：
 * 1. 指标纯函数单测——熵/编辑距离/BLEU 的取值与退化边界（单题不报 self-BLEU、
 *    无选项题不进干扰项轴、缺席 ≠ 0）；
 * 2. 全链回归——问 _bank 出题两路都随返回值带 diversity，批内只数本批入库题、
 *    题库累计含全库，归档题不入读数；
 * 3. 基线回放——`tests/fixtures/bank-corpus/`（vault 现存的题库 YAML 快照）
 *    用**同一函数**复算必须逐值等于 `tests/fixtures/diversity-baseline.json`：
 *    基线是入库事实，被测的是「它还能被复算出来」（口径改了基线必须跟着改并人审）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { LearnhubEngine } from '../src/engine/index.ts'
import { YAML } from '../src/engine/yaml.ts'
import {
  distractorDistanceOf, diversityMetricsOf, diversityQuestionOf, entropyOf, levenshteinDistance,
  meanStemSimilarityOf, questionDiversityReportOf, selfBleuOf, trigramOverlap,
} from '../src/engine/question-diversity.ts'
import type { DiversityMetrics, DiversityQuestion } from '../src/engine/question-diversity.ts'
import { withVault } from './helpers/vault.ts'

const here = dirname(fileURLToPath(import.meta.url))
const corpusDir = join(here, 'fixtures/bank-corpus')

/** 六道题的金样本批（六种题型 + 三组选项），全链与纯函数测试共用。
 * 两条约束写在这里免得下次再踩：①「数学一律写进 `$…$`」——ASCII `^` 是记法违规，
 * 选项也要包（ADR-0030）；②有 invokes 就必须在概念登记表在册（#141 受理门），
 * 本样本的测试 vault 没有登记表，故全部不标 invokes（缺席恒合法）。 */
const LLM_SIX = `node: 入门
questions:
  - kind: single_choice
    q: 因式分解 $x^2-1$ 的结果是什么？
    options: ["$(x-1)(x+1)$", "$(x-1)^2$", "$x(x-1)$", "$(x+1)^2$"]
    answer: A
    difficulty: 1
  - kind: true_false
    q: 提取公因式时系数要取最大公因数。
    answer: true
    difficulty: 1
  - kind: fill_in_blank
    q: 把多项式各项共有的因式提出来，这个因式叫 ______
    answer: ["公因式"]
    difficulty: 2
  - kind: single_choice
    q: 多项式 $6x^2y+4xy$ 的公因式是（ ）
    options: ["$2xy$", "$6xy$", "$2x^2y$", "$4xy$"]
    answer: A
    difficulty: 2
  - kind: numeric
    q: 计算 $12$ 与 $18$ 的最大公因数。
    answer: 6
    difficulty: 1
  - kind: multi_choice
    q: 下列哪些式子已经分解到底？（多选）
    options: ["$x^2-1$", "$a(x+y)$", "$x^2+2x+1$", "$(x-1)(x+1)$"]
    answer: ["B", "D"]
    difficulty: 3
`

/** 第二批金样本（六道全新题面，题型配比与第一批不同：用来验两范围读数不一样）。 */
const LLM_SIX_2 = `node: 入门
questions:
  - kind: single_choice
    q: 合并同类项 $3a+5a$ 的结果是多少？
    options: ["$8a$", "$15a$", "$2a$", "$8a^2$"]
    answer: A
    difficulty: 1
  - kind: single_choice
    q: 下列哪个式子是单项式？
    options: ["$x+y$", "$3x^2y$", "$x/y$", "$x-1$"]
    answer: B
    difficulty: 1
  - kind: single_choice
    q: 去括号 $-(a-b)$ 等于什么？
    options: ["$-a-b$", "$a-b$", "$-a+b$", "$a+b$"]
    answer: C
    difficulty: 2
  - kind: true_false
    q: 单项式的次数等于所有字母指数之和。
    answer: true
    difficulty: 2
  - kind: numeric
    q: 计算 $3$ 与 $5$ 的最小公倍数。
    answer: 15
    difficulty: 1
  - kind: fill_in_blank
    q: 只含数与字母乘积的式子叫 ______
    answer: ["单项式"]
    difficulty: 1
`
/** 逐值比较读数（不做浮点宽容：同输入同输出是纯函数的硬要求，容差会把回归吞掉）。 */
function sameMetrics(a: DiversityMetrics, b: DiversityMetrics, label: string): void {
  const seen = (m: DiversityMetrics) => JSON.stringify(m)
  assert.equal(seen(a), seen(b), `${label}：读数与基线逐值不符——口径改了就必须重测基线并人审 diff`)
}

test('#230 熵：均匀分布取上界、单一取值恒 0、空集 0', () => {
  assert.equal(entropyOf([]), 0)
  assert.equal(entropyOf([7]), 0, '单一题型 = 零熵（这是它在执法）')
  assert.equal(entropyOf([1, 1]), 1, '两种题型各半 = 1 bit')
  assert.equal(entropyOf([1, 1, 1, 1]), 2, '四种题型各半 = 2 bit')
  assert.ok(Math.abs(entropyOf([3, 1]) - 0.8112781) < 1e-6, '偏斜分布低于上界')
  assert.equal(entropyOf([0, 5, 0]), 0, '零计数不占概率质量')
})

test('#230 Levenshtein：等长退化汉明、空串、单字符替换/插入删除', () => {
  assert.equal(levenshteinDistance('abc', 'abc'), 0)
  assert.equal(levenshteinDistance('abc', 'abd'), 1)
  assert.equal(levenshteinDistance('abc', 'ab'), 1, '删除')
  assert.equal(levenshteinDistance('ab', 'abc'), 1, '插入')
  assert.equal(levenshteinDistance('', 'abc'), 3)
  assert.equal(levenshteinDistance('kitten', 'sitting'), 3, '经典样例')
})

test('#230 干扰项距离：题内两两均值，标点差异被归一化吃掉（0 是合法读数）', () => {
  assert.equal(distractorDistanceOf(['ab']), null, '单选项无对可测（缺席，不是 0）')
  assert.equal(distractorDistanceOf(['ab', 'ab']), 0, '完全相同的两项 = 0：测到了，就是没差距')
  assert.equal(distractorDistanceOf(['ab', 'ab!']), 0, '归一化剥标点后同形 = 0')
  assert.equal(distractorDistanceOf(['aa', 'bb', 'cc']), 2, '三对等长距离各 2，全异时即时汉明距离')
  assert.equal(distractorDistanceOf(['ab', 'bc', 'cd']), 2, '等长替换仍是逐位计（1+2+1）/3 = 4/3 之下界示例')
  assert.equal(distractorDistanceOf(['2xy', '6xy', '2x^2y', '4xy']), 4 / 3, '六对均值 4/3')
})

test('#230 self-BLEU：单题缺席、复读批为 1、无关题串趋 0、平滑不让 4-gram 零匹配清分', () => {
  assert.equal(selfBleuOf(['只有一道题']), null, '单题无法自比——缺席不是 0')
  assert.equal(selfBleuOf(['', '']), null, '空题面不进题面轴')
  const same = selfBleuOf(['提取公因式并化简', '提取公因式并化简'])
  assert.equal(same, 1, '两句完全相同：1-4 阶全中 + BP=1 → 1')
  // 无关题串只共享单字：平滑后读数仍很低（远低于「同主题题」的量级，可作趋同的阴性对照）
  const unrelated = selfBleuOf(['提取公因式并化简', '矩阵特征向量的几何意义'])
  assert.ok(unrelated !== null && unrelated < 0.15, `无关题串应低分（实测 ${unrelated}）`)
  const similar = selfBleuOf(['提取公因式并化简', '提取公因式后化简'])
  assert.ok(similar! > unrelated!, `同主题同句式应显著高于无关题串（${similar} vs ${unrelated}）`)
  // 平滑的证据：长句只共享一个字，4-gram 零匹配也不把整分压成 0
  const shortOverlap = selfBleuOf(['把含一个未知量的等式解出未知量的值并代回检验', '把含两个未知量的等式解出未知量的值并代回检验'])
  assert.ok(shortOverlap !== null && shortOverlap > 0.7, `近同题应高分（实测 ${shortOverlap}）`)
})

test('#230 同轴第二读数：trigram Jaccard 与长度加权的批内平均', () => {
  assert.equal(trigramOverlap('abc', 'abc'), 1)
  assert.equal(trigramOverlap('abc', ''), 0, '空串不与任何题相似')
  assert.equal(trigramOverlap('提取公因式', '提取公因式'), 1)
  assert.ok(trigramOverlap('提取公因式', '提取公因式并化简') > 0.3)
  assert.equal(meanStemSimilarityOf(['唯一一道']), null, '单题缺席')
  assert.ok(Math.abs(meanStemSimilarityOf(['完全一样', '完全一样'])! - 1) < 1e-9)
})

test('#230 报告形状：批内与题库分范围；缺席项不落键、不拿 0 冒充', () => {
  const single = diversityMetricsOf([{ kind: 'single_choice', q: '只有一道单选题', options: ['a', 'bb'] }])
  assert.equal(single.sample, 1)
  assert.deepEqual(single.kinds, { single_choice: 1 })
  assert.equal(single.entropy.value, 0, '单题批熵恒 0')
  assert.ok(single.distractor, '一到多选项题就有干扰项读数')
  assert.equal(single.selfBleu, undefined, '单题批没有 self-BLEU 键（缺席，不是 0）')
  assert.equal(single.stemSimilarity, undefined)
  const noOptions = diversityMetricsOf([
    { kind: 'true_false', q: '判断题甲', options: undefined },
    { kind: 'numeric', q: '数值题乙', options: undefined },
  ])
  assert.equal(noOptions.distractor, undefined, '无选项题型不进干扰项轴')
  assert.ok(noOptions.selfBleu, '题面轴照常测')
  const empty = diversityMetricsOf([])
  assert.equal(empty.sample, 0)
  assert.equal(empty.entropy.value, 0)
  assert.equal(empty.selfBleu, undefined)
})

test('#230 出题全链：两路都带 diversity，批内 = 本批入库、题库累计含在前题', async () => {
  await withVault({ notes: { 入门: { body: ['# 入门', '', '## 概念', '因式分解与公因式的基础讲解。'] } } }, async ({ engine }) => {
    const r = await engine.bank2.questionGenerate('数学', '入门', undefined, async () => LLM_SIX)
    assert.equal(r.added, 6)
    assert.equal(r.diversity.batch.sample, 6, '批内 = 本批入库题')
    assert.equal(r.diversity.bank.sample, 6, '题库累计 = 全库（本批前为空库）')
    assert.ok((r.diversity.batch.entropy.value ?? 0) > 0.9, `六题四型应接近上界（实测 ${r.diversity.batch.entropy.value}）`)
    assert.ok(r.diversity.batch.selfBleu, '六道不同题面有 self-BLEU')
    assert.ok(r.diversity.batch.distractor, '批内含单选题有干扰项读数')
    assert.equal(r.diversity.batch.distractor!.sample, 3, '带选项的题三组：两道单选 + 一道多选')

    // 第二批：六道全新的题（与第一批无字面重叠）→ 全部入库；
    // 批内只数本批，题库累计含第一批——两者样本量必须分开，这正是批间漂移曲线的读法
    const r2 = await engine.bank2.questionGenerate('数学', '入门', undefined, async () => LLM_SIX_2)
    assert.equal(r2.added, 6)
    assert.equal(r2.diversity.batch.sample, 6, '批内只数本批新增')
    assert.equal(r2.diversity.bank.sample, 12, '题库累计含前一批')
    assert.notEqual(
      JSON.stringify(r2.diversity.batch.selfBleu), JSON.stringify(r2.diversity.bank.selfBleu),
      '两范围是两个读数，不是一个数字的两个名字',
    )
  })
})

test('#230 全批撞已有题：整批被查重门丢光 → 老语义照旧抛错（仪表不改变失败行为）', async () => {
  await withVault({ notes: { 入门: { body: ['# 入门', '', '## 概念', '因式分解与公因式的基础讲解。'] } } }, async ({ engine }) => {
    const first = await engine.bank2.questionGenerate('数学', '入门', undefined, async () => LLM_SIX)
    assert.equal(first.added, 6)
    // 逐题与库内同题面：走查重门丢弃；一道不剩 → 既有「全部未过校验门」失败语义不变
    // （零入库时没有返回值，批内读数自然无从报出——这是「不进报告面」而非「报 0」）
    await assert.rejects(
      () => engine.bank2.questionGenerate('数学', '入门', undefined, async () => LLM_SIX),
      /一道都没入库/,
    )
  })
})

test('#230 逐节出题路同款在场；归档题不入题库累计读数', async () => {
  await withVault({
    notes: {
      入门: {
        body: ['# 入门', '', '## 概念：定义', '', '因式分解与公因式的基础讲解。'],
        content: { sections: ['    - { id: s1, title: "概念：定义", type: 概念, status: ready, version: 1 }'] },
      },
    },
  }, async ({ engine }) => {
    const r = await engine.bank2.questionGenerateSections('数学', '入门', async () => LLM_SIX)
    assert.ok(r.added > 0)
    assert.ok(r.diversity, '逐节路随返回值带 diversity')
    assert.equal(r.diversity.batch.sample, r.added, '批内样本 = 本批入库题量')
    assert.equal(r.diversity.bank.sample, r.added, '题库累计 = 全部非归档题')
    // 归档全部题：归档是「不参与学习」的终态，涨不了题库累计读数
    const bank = await engine.bank2.questionsAll()
    for (const q of bank.questions) await engine.bank2.questionArchive('数学', '入门', q.qid, true, 'manual')
    const after = await engine.bank2.questionGenerate('数学', '入门', 1, async () => LLM_SIX)
    assert.equal(after.diversity.bank.sample, 1, '归档题排除在题库累计之外，只数本批新题')
  })
})

test('#230 基线回放：语料快照复算逐值等于入库基线（口径改了必须重测并人审）', () => {
  const baseline = readBaseline()
  const names = readdirSync(corpusDir).filter(f => f.endsWith('.yaml')).sort()
  assert.deepEqual(
    names.map(n => `tests/fixtures/bank-corpus/${n}`),
    baseline.corpus,
    '语料目录与基线清单不一致（新增/删除语料须重测基线）',
  )
  const all: DiversityQuestion[] = []
  for (const name of names) {
    const doc = YAML.parse(readFileSync(join(corpusDir, name), 'utf8')) as { questions?: Array<Record<string, unknown>> }
    const qs = (doc.questions ?? [])
      .filter(q => q.archived !== true)
      .map(diversityQuestionOf)
    all.push(...qs)
    const want = baseline.perBatch[name]
    assert.ok(want, `基线缺 ${name} 的读数`)
    sameMetrics(diversityMetricsOf(qs), want, `批 ${name}`)
  }
  assert.equal(all.length, baseline.total, '语料总题数与基线不符')
  sameMetrics(diversityMetricsOf(all), baseline.aggregate, '全语料聚合')
})

/** 读入库基线（回放与真事实两段共用；路径写死为仓库内固定位置）。 */
function readBaseline(): { corpus: string[]; total: number; aggregate: DiversityMetrics; perBatch: Record<string, DiversityMetrics> } {
  return JSON.parse(readFileSync(join(here, 'fixtures/diversity-baseline.json'), 'utf8'))
}

test('#230 基线数字是人读得懂的真事实（防基线被「改成恒过」）', () => {
  const b = readBaseline()
  assert.equal(b.total, 65, 'YAML 现状基线题量（2026-09-10 存档课程语料）')
  assert.equal(Object.keys(b.perBatch).length, 4)
  // 三指标都得是有意义的实数：熵>0（题型不止一种）、self-BLEU 在 (0,1)、干扰项距离为正
  assert.ok(b.aggregate.entropy.value > 2 && b.aggregate.entropy.value < 3, '八题型分布的熵落在 (2,3) bit')
  assert.ok(b.aggregate.selfBleu!.value > 0 && b.aggregate.selfBleu!.value < 1)
  assert.ok(b.aggregate.stemSimilarity!.value > 0)
  assert.ok(b.aggregate.distractor!.value > 1)
  // 最差一题的干扰项距离是点名事实（0 = 选项归一化后同形，语料里真实存在）
  assert.equal(b.aggregate.distractor!.min, 0)
  assert.ok(b.aggregate.distractor!.minQ)
})

test('#230 回放锁自检：口径漂移/基线被改都会被 sameMetrics 抓住（恒过的门比没有门更坏，ADR-0047）', () => {
  const b = readBaseline()
  const want = b.perBatch[readdirSync(corpusDir).filter(f => f.endsWith('.yaml'))[0]!]
  assert.ok(want, '取一份读数作自检基样')
  // 真相样本不报错
  sameMetrics(want, structuredClone(want), '自检：同值')
  // 任一指标动一点：读数被改（基线漂移）必须红
  for (const [label, mutate] of [
    ['熵', (m: DiversityMetrics) => { m.entropy.value += 0.01 }],
    ['干扰项距离', (m: DiversityMetrics) => { m.distractor!.value += 0.01 }],
    ['self-BLEU', (m: DiversityMetrics) => { m.selfBleu!.value += 0.01 }],
    ['样本量', (m: DiversityMetrics) => { m.sample += 1 }],
  ] as Array<[string, (m: DiversityMetrics) => void]>) {
    const drifted = structuredClone(want)
    mutate(drifted)
    assert.throws(() => sameMetrics(drifted, want, `自检：${label}漂移`), /读数与基线逐值不符/, `${label} 漂移未被抓住`)
  }
})

test('#230 题目投影：三轴字段照搬、多余字段不入测量面（投影是基线与运行时的同一把尺）', () => {
  assert.deepEqual(
    diversityQuestionOf({ kind: 'single_choice', q: '题面', options: ['a', 'b'], answer: 'A', id: 'q9', explanation: '解析' }),
    { kind: 'single_choice', q: '题面', options: ['a', 'b'] },
    '答案/解析/编号不进测量输入',
  )
  assert.deepEqual(
    diversityQuestionOf({ kind: 7, q: null, options: undefined }),
    { kind: undefined, q: undefined, options: undefined },
    '坏形态退化为缺席，不抛错（题库文件可能手编）',
  )
})

test('#230 出题两条路之外的调用点不受影响（零行为改动：门禁判定不消费多样性）', async () => {
  // 全畸形的模型输出：老失败语义原样（全弃 + 抛错），不因仪表多一分/少一分
  await withVault({ notes: { 入门: { body: ['# 入门', '', '## 概念', '讲解。'] } } }, async ({ engine }) => {
    await assert.rejects(
      () => engine.bank2.questionGenerate('数学', '入门', undefined, async () => 'questions:\n  - kind: single_choice\n    q: 缺选项与答案\n'),
      /全部未过校验门/,
    )
  })
})
