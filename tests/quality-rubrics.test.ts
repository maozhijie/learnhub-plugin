/**
 * 质量量规注册表锚门（#221 / ADR-0062）：每条判据可追溯到出处——source 指向的文档
 * （PROMPT_KINDS 模板 / docs/adr / CONTEXT.md 词条 / engine 源文件）必须真实存在，
 * anchor 原句必须在册，漂移即红。元数据门：分层法庭声明在册、无「总分」维度。
 * 门带自检（ADR-0047 铁律①）：伪造锚点、删法庭元数据、加总分维度必须变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { QUALITY_RUBRICS, RUBRIC_COURTS, allCriteria, rubricOf } from '../src/engine/quality-rubrics.ts'
import type { QualityRubric } from '../src/engine/quality-rubrics.ts'
import { Content } from '../src/engine/content.ts'
import { STATIONS } from '../src/host/corpus.ts'

const CONTEXT = readFileSync(new URL('../CONTEXT.md', import.meta.url), 'utf8')
const ADR_FILES = readdirSync(new URL('../docs/adr', import.meta.url))

/** source 判别式 → source 文档存在性；返回锚点核对用的目标文本（null = 文档缺席）。 */
function resolveSource(source: string): string | null {
  if (source.startsWith('模板:')) {
    const key = source.slice('模板:'.length)
    return Content.PROMPT_KINDS[key] ?? null
  }
  if (/^ADR-\d{4}$/.test(source)) {
    const file = ADR_FILES.find(f => f.startsWith(source.slice(4))) // 目录名带编号前缀
    return file ? readFileSync(new URL(`../docs/adr/${file}`, import.meta.url), 'utf8') : null
  }
  if (source.startsWith('词条:')) {
    const name = source.slice('词条:'.length)
    return CONTEXT.includes(`**${name}**`) ? CONTEXT : null
  }
  if (source.startsWith('引擎:')) {
    const file = source.slice('引擎:'.length)
    return readFileSync(new URL(`../src/engine/${file}`, import.meta.url), 'utf8')
  }
  return null
}

/** 锚门本体（可注入 = 自检可喂坏样本）。 */
function runRubricGate(rubrics: readonly QualityRubric[]): void {
  assert.deepEqual(
    rubrics.map(r => r.id), ['大纲', '节正文', '题目', '教练回合', '种子·终点'],
    '五份量规缺一不可（大纲/节正文/题目/教练回合/种子·终点）',
  )
  const stations = new Set(Object.values(STATIONS))
  for (const r of rubrics) {
    // 分层法庭元数据：单一出处（RUBRIC_COURTS）+ 三面声明齐全
    assert.equal(r.court, RUBRIC_COURTS, `量规「${r.id}」的法庭元数据必须引用 RUBRIC_COURTS 单一出处`)
    assert.ok(r.court.ai.includes('提议') && r.court.human.includes('终审') && r.court.outcome.includes('结果法院'))
    // 站名对账（语料站词表）
    for (const s of r.stations) assert.ok(stations.has(s), `量规「${r.id}」的站名「${s}」不在语料站名词表`)
    // 无总分维度（词条「内容质量」：没有单一总分）
    for (const d of r.dimensions) {
      assert.ok(!d.name.includes('总分') && !d.id.includes('总分'), `量规「${r.id}」出现总分维度「${d.name}」`)
      assert.ok(d.criteria.length > 0, `量规「${r.id}」维度「${d.name}」没有判据`)
    }
    // 逐判据：判据/证据/出处非空 + 出处可解析 + 锚点在册
    for (const { dimension, criterion: c } of allCriteriaOf(r)) {
      assert.ok(c.criterion.trim() && c.evidence.trim() && c.source.trim(), `量规「${r.id}」/「${dimension}」/「${c.id}」判据三要素有空项`)
      const doc = resolveSource(c.source)
      assert.ok(doc !== null, `量规「${r.id}」/「${c.id}」的出处「${c.source}」解析不到文档（词条/模板/ADR/引擎文件缺席或改名）`)
      if (c.anchor) {
        assert.ok(
          doc.includes(c.anchor),
          `量规「${r.id}」/「${c.id}」锚点漂移：出处「${c.source}」里找不到原句「${c.anchor}」——改出处文档须同步量规（#221）`,
        )
      }
    }
  }
}

function allCriteriaOf(r: QualityRubric) {
  const out: Array<{ dimension: string; criterion: (typeof r.dimensions)[number]['criteria'][number] }> = []
  for (const d of r.dimensions) for (const c of d.criteria) out.push({ dimension: d.id, criterion: c })
  return out
}

test('锚门：五份量规全量对账（出处可解析 + 锚点在册 + 法庭元数据 + 无总分）', () => {
  runRubricGate(QUALITY_RUBRICS)
})

test('自检：伪造锚点（出处文档里不存在的原句）门必须变红', () => {
  const broken = QUALITY_RUBRICS.map(r =>
    r.id === '题目'
      ? { ...r, dimensions: r.dimensions.map(d =>
          d.id === '答案键正确性'
            ? { ...d, criteria: d.criteria.map(c => (c.id === '键自洽' ? { ...c, anchor: '出处里不存在的原句锚' } : c)) }
            : d) }
      : r)
  assert.throws(() => runRubricGate(broken), /锚点漂移/)
})

test('自检：出处指向不存在的文档（模板键改名/词条缺席）门必须变红', () => {
  const broken = QUALITY_RUBRICS.map(r =>
    r.id === '大纲' ? { ...r, dimensions: r.dimensions.map(d => ({ ...d, criteria: d.criteria.map(c => ({ ...c, source: '模板:不存在的模板' })) })) } : r)
  assert.throws(() => runRubricGate(broken), /解析不到文档/)
})

test('自检：加「总分」维度 / 换掉法庭元数据，元数据门必须变红', () => {
  const withTotal = QUALITY_RUBRICS.map(r =>
    r.id === '教练回合'
      ? { ...r, dimensions: [...r.dimensions, { id: '总分', name: '总分（加权合成）', criteria: [{ id: 'x', criterion: 'x', evidence: 'x', source: '模板:教练回合' }] }] }
      : r)
  assert.throws(() => runRubricGate(withTotal), /总分/)
  const noCourt = QUALITY_RUBRICS.map(r =>
    r.id === '种子·终点' ? { ...r, court: { ai: '', human: '', outcome: '' } } : r)
  assert.throws(() => runRubricGate(noCourt), /RUBRIC_COURTS/)
})

// ---- #221 增补条款的落地锚 ----

test('#221 增补：预注册预测在册——「不趋同」维度的低分预测与依据', () => {
  const quiz = rubricOf('题目')!
  assert.ok(quiz.notes?.some(n => n.includes('预注册预测') && n.includes('不趋同')), '题目量规必须携带预注册预测注记')
  const divergence = quiz.dimensions.flatMap(d => d.criteria).filter(c => c.id === '不趋同')
  assert.equal(divergence.length, 1, '「不趋同」是显式判据')
})

test('#221 增补：「与相邻节衔接」是节正文量规的显式判据（流程性缺陷不误读为个别文风）', () => {
  const section = rubricOf('节正文')!
  const criterion = section.dimensions.flatMap(d => d.criteria).find(c => c.id === '节间衔接')
  assert.ok(criterion, '节正文量规必须有「节间衔接」显式判据')
  assert.match(criterion!.criterion, /#227/)
  assert.ok(section.notes?.some(n => n.includes('流程性缺陷')))
})

test('量规先于评审器：判据可被评审器扁平消费（allCriteria 三级定位齐全）', () => {
  const flat = allCriteria()
  assert.ok(flat.length >= 30, `五量规判据总量实测 ${flat.length}，不应缩水`)
  for (const x of flat) {
    assert.ok(x.rubric && x.dimension && x.criterion.id, '扁平视图三级定位（量规/维度/判据）必须齐全')
    assert.ok(x.criterion.evidence.length > 0, `判据「${x.criterion.id}」缺证据要求（引原文定位）`)
  }
})
