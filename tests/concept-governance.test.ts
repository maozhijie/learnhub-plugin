/**
 * 概念层治理回路与写侧门（#264 / #265 / 父 #260；裁决 ADR-0084，实现裁决 ADR-0086）。
 *
 * #264 写侧门与量级纪律：近似名预检（软提示，不拒收；精确撞名照旧硬拒）、错误卡生成期
 * 概念引用在册对照、概念侧量级告警带（别名/混淆对 WARN/ERROR，data-check hint）、混淆对
 * 注入上限 + 截断披露（稳定序，同输入同输出）。
 * #265 治理回路：合并走「提案 + 人确认」两段式（未确认不落盘，提案面显式不可逆）；
 * 混淆对候选从题目共现派生、走提案（不自动入册，接受后单方向入册，候选面尊重废弃态）。
 *
 * 只测外部行为（受理回执 / 落盘结果 / 注入文本 / 提案状态），不测内部实现与私有函数；
 * 阈值常量只在构成「可观测契约」的截断披露行里出现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addConfusablePair, capConfusablePairs, confusableCandidates, conceptMagnitudeFindings,
  nearNameCandidates, nearNameWarnings, validateConceptMergeProposal, validateConfusableCandidateProposal,
  CONFUSABLE_INJECT_CAP,
} from '../src/engine/concepts/concepts.ts'
import type { ConceptEntry } from '../src/engine/concepts/concepts.ts'
import { Content } from '../src/engine/content/content.ts'
import { YAML } from '../src/engine/infra/yaml.ts'
import { withVault } from './helpers/vault.ts'

const REGISTRY_YAML = [
  'concepts:',
  '  - canonical: 因式分解',
  '    aliases: [十字相乘法]',
  '    definition: 把多项式化为几个整式的乘积',
  '  - canonical: 配方法',
].join('\n')

const registryVault = (files: Array<{ path: string; content: string }> = []) => ({
  files: [{ path: '学习中心/math/概念登记表.yaml', content: `${REGISTRY_YAML}\n` }, ...files],
})

const registryPath = (root: string) => join(root, '学习中心', 'math', '概念登记表.yaml')

/** 铸名一批 + 挂在一个新节点上（生长批提案的最小形态）。 */
const mintYaml = (canonical: string) => `course: 数学
reason: 生长批：中继节点
concepts:
  - canonical: ${canonical}
ops:
  - op: add_node
    name: 中继节点
    pre: [入门]
    est: 10
    teaches: { ${canonical}: 知道 }
`

// ---- #264 近似名预检：软提示回报候选清单，不拒收；精确撞名照旧硬拒 ----

test('#264 铸名近似名：受理成功且回执带候选清单；精确撞名仍硬拒', async () => {
  await withVault(registryVault(), async ({ engine }) => {
    const r = await engine.graph.graphPropose('edit', mintYaml('因式分解法')) as { id: number; warns?: string[] }
    assert.ok(r.id, '近似但非精确 → 不拒收')
    const hit = r.warns?.find(w => w.includes('近似名提示'))
    assert.ok(hit, '受理结果回报候选清单')
    assert.ok(hit!.includes('因式分解法') && hit!.includes('因式分解'), '候选清单指明本批名与在册名')
    assert.ok(hit!.includes('非阻'), '软提示明示不阻')

    await assert.rejects(() => engine.graph.graphPropose('edit', mintYaml('配方法')), /铸名冲突/, '精确撞名照旧硬拒（不改既有语义）')
  })
})

test('#264 近似名预检（纯函数）：阈值、废弃条目名字仍占名位、精确相等不报', () => {
  const existing: ConceptEntry[] = [{ canonical: '十字相乘', deprecated: true }, { canonical: '甲' }]
  const hits = nearNameCandidates([{ canonical: '十字相乘法' }], existing)
  assert.equal(hits.length, 1, '废弃条目的地址仍在册（仍解析）——撞上它同样是重复铸名，照报')
  assert.equal(hits[0]!.existing, '十字相乘')
  assert.ok(hits[0]!.similarity >= 0.6)
  assert.deepEqual(nearNameCandidates([{ canonical: '甲' }], existing), [], '精确相等是硬拒门的业务，不进近似清单')
  assert.deepEqual(nearNameCandidates([{ canonical: '完全不同' }], existing), [], '低于阈值不报')
  const warns = nearNameWarnings(hits)
  assert.equal(warns.length, 1)
  assert.match(warns[0]!, /十字相乘法.*十字相乘/)
})

// ---- #264 量级纪律：别名 / 混淆对 WARN-ERROR 带（只报不拦）----

test('#264 量级告警（纯函数）：别名与混淆对各两档，超带才报', () => {
  assert.deepEqual(conceptMagnitudeFindings([{ canonical: '甲', aliases: ['一', '二', '三', '四'] }]), [], '4 条别名 = 带内不报')
  const warn = conceptMagnitudeFindings([{ canonical: '甲', aliases: ['一', '二', '三', '四', '五'] }])
  assert.equal(warn.length, 1)
  assert.equal(warn[0]!.band, 'warn')
  assert.equal(warn[0]!.field, 'aliases')
  const error = conceptMagnitudeFindings([{ canonical: '甲', aliases: ['一', '二', '三', '四', '五', '六', '七', '八', '九'] }])
  assert.equal(error[0]!.band, 'error')
  assert.deepEqual(conceptMagnitudeFindings([{ canonical: '甲', confusable: Array.from({ length: CONFUSABLE_INJECT_CAP }, (_, i) => `乙${i}`) }]), [], '混淆对 ≤ 注入上限 = 带内不报')
  const confWarn = conceptMagnitudeFindings([{ canonical: '甲', confusable: Array.from({ length: CONFUSABLE_INJECT_CAP + 1 }, (_, i) => `乙${i}`) }])
  assert.equal(confWarn[0]!.band, 'warn')
  assert.equal(confWarn[0]!.field, 'confusable')
  const confError = conceptMagnitudeFindings([{ canonical: '甲', confusable: Array.from({ length: CONFUSABLE_INJECT_CAP * 2 + 1 }, (_, i) => `乙${i}`) }])
  assert.equal(confError[0]!.band, 'error')
})

test('#264 data-check：超量别名/混淆对 = hint（不 broken——地址全部照常解析）', async () => {
  await withVault({
    tag: 'learnhub-magnitude-',
    files: [{
      path: '学习中心/math/概念登记表.yaml',
      content: [
        'concepts:',
        '  - canonical: 甲',
        '    aliases: [甲一, 甲二, 甲三, 甲四, 甲五]',
        '    confusable: [乙一, 乙二, 乙三, 乙四, 乙五, 乙六, 乙七, 乙八, 乙九]',
      ].join('\n') + '\n',
    }],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    assert.notEqual(report.status, 'broken', '量级越带是信号不是违约（hint 不升级整体状态）')
    const hits = report.findings.filter(f => f.reason === 'concept_registry_magnitude')
    assert.equal(hits.length, 2, '别名一条 + 混淆对一条')
    assert.ok(hits.every(f => f.level === 'hint'))
    assert.ok(hits.some(f => (f.detail ?? '').includes('别名 5 条')))
    assert.ok(hits.some(f => (f.detail ?? '').includes('混淆对 9 条')))
    assert.equal(report.byArea.concept_registry.hint, 2)
  })
})

// ---- #264 混淆对注入上限 + 截断披露：稳定序、截断数与理由如实写在注入文本内 ----

test('#264 注入截断（纯函数）：超限取稳定序前缀并如实报数', () => {
  const pairs = Array.from({ length: 12 }, (_, i) => ({ a: `甲${i}`, b: `乙${i}` }))
  const capped = capConfusablePairs(pairs)
  assert.deepEqual(capped.pairs, pairs.slice(0, CONFUSABLE_INJECT_CAP), '稳定序 = 输入序前缀（同输入恒同输出）')
  assert.equal(capped.total, 12)
  assert.equal(capped.truncated, 4)
  const small = capConfusablePairs(pairs.slice(0, 3))
  assert.deepEqual(small, { pairs: pairs.slice(0, 3), total: 3, truncated: 0 })
  assert.equal(capConfusablePairs(pairs, 3).truncated, 9, '上限是参数（缺省 = 注入上限）')
})

test('#264 注入文本：超限出现截断披露行；同输入同输出', () => {
  const pairs = (n: number) => Array.from({ length: n }, (_, i) => ({ a: `概念${i}`, b: `邻居${i}` }))
  const under = Content.confusablePairsBlock(pairs(CONFUSABLE_INJECT_CAP))
  assert.ok(!under.includes('已截断'), '带内不披露')
  assert.equal((under.match(/↔/g) ?? []).length, CONFUSABLE_INJECT_CAP)
  const over = Content.confusablePairsBlock(pairs(CONFUSABLE_INJECT_CAP + 1))
  assert.ok(over.includes('已截断'), '超限在注入文本内如实披露')
  assert.ok(over.includes(`共 ${CONFUSABLE_INJECT_CAP + 1} 对`), '披露截断数（共几对）')
  assert.ok(over.includes(`只注入前 ${CONFUSABLE_INJECT_CAP} 对`))
  assert.ok(over.includes(`注入上限 ${CONFUSABLE_INJECT_CAP} 对`), '披露理由（上限）')
  assert.equal((over.match(/↔/g) ?? []).length, CONFUSABLE_INJECT_CAP, '实际注入恰上限条')
  assert.ok(over.indexOf('概念0') < over.indexOf('概念1'), '截断保序')
  assert.equal(over, Content.confusablePairsBlock(pairs(CONFUSABLE_INJECT_CAP + 1)), '同输入同输出')
  assert.equal(Content.confusablePairsBlock([]), '', '无对静默降级照旧')
})

// ---- #265 混淆对候选派生（纯函数）：题目共现、废弃/未在册/已声明不提名、确定性 ----

test('#265 候选派生：同节点 invokes 共现 + 误解先验×正答；已声明/废弃/未在册不提名；同输入同输出', () => {
  const entries: ConceptEntry[] = [
    { canonical: '甲', aliases: ['甲别'] },
    { canonical: '乙' },
    { canonical: '丙', confusable: ['甲'] },
    { canonical: '丁', deprecated: true },
  ]
  const nodes = [{
    node: '入门',
    questions: [
      { id: 'q1', invokes: '甲' },
      { id: 'q2', invokes: '甲别' },
      { id: 'q3', invokes: '乙' },
      { id: 'q4', invokes: '丙' },
      { id: 'q5', invokes: '丁' },
      { id: 'q6', invokes: '没登记' },
    ],
    misconceptions: [{ concept: '甲别' }, { concept: '丁' }],
  }]
  const cands = confusableCandidates(nodes, entries)
  // 甲-乙：q1↔q3、q2↔q3（别名归一后同概念）+ 误解先验「甲」×q3 → 3 条证据
  // 甲-丙：登记表已声明（confusable），不重复提名；丁（废弃）与 没登记（未在册）不出现
  assert.deepEqual(cands.map(c => [c.a, c.b, c.weight]), [['甲', '乙', 3], ['乙', '丙', 1]])
  assert.ok(cands[0]!.evidence.every(l => l.includes('节点「入门」')))
  assert.equal(cands[0]!.evidence.filter(l => l.includes('题目间共现')).length, 2)
  assert.equal(cands[0]!.evidence.filter(l => l.includes('误解先验')).length, 1)
  assert.deepEqual(confusableCandidates(nodes, entries), cands, '候选面也要可复现（同输入同输出）')
})

test('#265 易混对入册核（纯函数）：单方向、幂等、未在册/同条目拒', () => {
  const entries: ConceptEntry[] = [{ canonical: '甲', aliases: ['甲别'] }, { canonical: '乙' }]
  const first = addConfusablePair(entries, '甲', '乙')
  assert.deepEqual(first, { errors: [], changed: true, entries: [{ canonical: '甲', aliases: ['甲别'], confusable: ['乙'] }, { canonical: '乙' }] }, '只写 a→b 一个方向（单向是待复核态）')
  assert.deepEqual(addConfusablePair(first.entries, '甲', '乙'), { errors: [], changed: false, entries: first.entries }, '已声明幂等')
  assert.equal(addConfusablePair(first.entries, '乙', '甲').changed, false, '无序对：反方向重复声明同样幂等')
  assert.ok(addConfusablePair(entries, '甲', '没登记').errors.some(e => e.includes('不在登记表')))
  assert.ok(addConfusablePair(entries, '甲', '甲别').errors.some(e => e.includes('同一条目')), '别名解析后同身份 = 同条目')
})

// ---- #265 提案产物 schema 门（形态）----

test('#265 提案产物 schema：未知键拒收、irreversible 只认 true、evidence 必须非空列表', () => {
  const merge = validateConceptMergeProposal({ course: '数学', from: '甲', into: '乙', irreversible: false, foo: 1 })
  assert.ok(merge.errors?.some(e => e.includes('irreversible')))
  assert.ok(merge.errors?.some(e => e.includes('未知字段')))
  assert.ok(validateConceptMergeProposal({ course: '数学', from: '甲', into: '甲' }).errors?.some(e => e.includes('相同')))
  assert.ok(
    validateConceptMergeProposal({ course: '数学', from: '甲', into: '乙', irreversible_note: '自拟声明' }).errors?.some(e => e.includes('篡改')),
    '不可逆声明文本被改 = 拒（语义不接受改写）',
  )
  assert.deepEqual(validateConceptMergeProposal({ course: '数学', from: '甲', into: '乙' }).spec, { course: '数学', from: '甲', into: '乙' })
  const cand = validateConfusableCandidateProposal({ course: '数学', a: '甲', b: '甲' })
  assert.ok(cand.errors?.some(e => e.includes('相同')))
  assert.ok(validateConfusableCandidateProposal({ course: '数学', a: '甲', b: '乙' }).errors?.some(e => e.includes('evidence')))
  assert.ok(validateConfusableCandidateProposal({ course: '数学', a: '甲', b: '乙', evidence: [''] }).errors?.some(e => e.includes('evidence')))
  assert.deepEqual(validateConfusableCandidateProposal({ course: '数学', a: '甲', b: '乙', evidence: [' 证一 '] }).spec?.evidence, ['证一'])
})

// ---- #265 合并提案 + 人确认：未确认不落盘；提案面显式不可逆；apply 双门对表 ----

test('#265 合并提案：未确认不落盘，产物带不可逆声明与归一后的 canonical', async () => {
  await withVault(registryVault(), async ({ engine, root }) => {
    const r = await engine.graph.conceptMerge('数学', '配方法', '因式分解', '同一概念两次铸名')
    assert.equal(r.kind, 'concept_merge')
    assert.equal(r.irreversible, true, '提案面显式声明不可逆')
    assert.deepEqual(r.names, ['因式分解', '十字相乘法', '配方法'])
    assert.equal(readFileSync(registryPath(root), 'utf8'), `${REGISTRY_YAML}\n`, '未确认不落盘')
    const p = (await engine.store.loadProposals()).find(x => x.id === r.proposal)!
    assert.equal(p.kind, 'concept_merge')
    assert.equal(p.status, 'pending')
    assert.match(p.summary, /不可逆/)
    const artifact = YAML.parse(readFileSync(p.artifact, 'utf8')) as Record<string, unknown>
    assert.equal(artifact.irreversible, true)
    assert.equal(artifact.from, '配方法')
    assert.equal(artifact.into, '因式分解')
    assert.equal(artifact.reason, '同一概念两次铸名')
    assert.match(String(artifact.irreversible_note), /条目禁删只并入/, '提案产物带不可逆全文声明（单源常量）')
  })
})

test('#265 合并 apply 复核声明：产物被改写不可逆声明 → 拒绝执行', async () => {
  await withVault(registryVault(), async ({ engine }) => {
    const r = await engine.graph.conceptMerge('数学', '配方法', '因式分解')
    const p = (await engine.store.loadProposals()).find(x => x.id === r.proposal)!
    const tampered = YAML.parse(readFileSync(p.artifact, 'utf8')) as Record<string, unknown>
    tampered.irreversible_note = '合并可逆（改写声明）'
    const { writeFileSync } = await import('node:fs')
    writeFileSync(p.artifact, YAML.stringify(tampered))
    await assert.rejects(() => engine.graph.proposalApply('concept_merge', r.proposal), /篡改/)
    assert.deepEqual(await engine.concepts.load('math').then(es => es.map(e => e.canonical)), ['因式分解', '配方法'], '登记表一字未动')
  })
})

test('#265 合并确认（面板 apply）：名字并集落盘、旧地址续解析、journal 与提案全留痕', async () => {
  await withVault(registryVault(), async ({ engine, root }) => {
    const r = await engine.graph.conceptMerge('数学', '配方法', '因式分解')
    const out = await engine.graph.proposalApply('concept_merge', r.proposal)
    assert.deepEqual(out, { kind: 'concept_merge', course: '数学', from: '配方法', into: '因式分解', names: ['因式分解', '十字相乘法', '配方法'] })
    const entries = await engine.concepts.load('math')
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.canonical, '因式分解')
    assert.deepEqual(entries[0]!.aliases, ['十字相乘法', '配方法'], 'from canonical 降级为别名')
    const onDisk = readFileSync(registryPath(root), 'utf8')
    assert.match(onDisk, /配方法/)
    const p = (await engine.store.loadProposals()).find(x => x.id === r.proposal)!
    assert.equal(p.status, 'applied')
    const tail = await engine.store.journalTail('数学', 5)
    const j = tail.reverse().find(x => x.kind === 'concept_merge')!
    assert.ok(j, 'journal 留痕')
    assert.equal(j.session, String(r.proposal))
    assert.match(j.detail ?? '', /提案 #\d+ 人确认/)
  })
})

test('#265 合并提案门：并入自身 / 未在册名字拒收不改盘；别名指称归一到 canonical', async () => {
  await withVault(registryVault(), async ({ engine, root }) => {
    await assert.rejects(() => engine.graph.conceptMerge('数学', '因式分解', '因式分解'), /不能并入自身|同一/)
    await assert.rejects(() => engine.graph.conceptMerge('数学', '不存在', '因式分解'), /不在登记表/)
    await assert.rejects(() => engine.graph.conceptMerge('数学', '因式分解', '不存在'), /不在登记表/)
    assert.equal(readFileSync(registryPath(root), 'utf8'), `${REGISTRY_YAML}\n`, '拒绝受理不改盘')
    const r = await engine.graph.conceptMerge('数学', '十字相乘法', '配方法')
    assert.equal(r.from, '因式分解', 'from 是别名时归一到所属条目 canonical')
    assert.equal(r.into, '配方法')
  })
})

test('#265 合并 apply 双门：受理后登记表被并发改写 → 拒绝且保持原样', async () => {
  await withVault(registryVault(), async ({ engine, root }) => {
    const r = await engine.graph.conceptMerge('数学', '配方法', '因式分解')
    await engine.concepts.save('math', [{ canonical: '因式分解', aliases: ['十字相乘法'] }])
    await assert.rejects(() => engine.graph.proposalApply('concept_merge', r.proposal), /保持原样|已变/)
    assert.deepEqual(await engine.concepts.load('math'), [{ canonical: '因式分解', aliases: ['十字相乘法'] }])
    const p = (await engine.store.loadProposals()).find(x => x.id === r.proposal)!
    assert.equal(p.status, 'pending', 'apply 失败提案仍待审（reject 留给人）')
  })
})

test('#265 合并拒绝（人审不通过）：留痕且登记表一字不改', async () => {
  await withVault(registryVault(), async ({ engine, root }) => {
    const r = await engine.graph.conceptMerge('数学', '配方法', '因式分解')
    await engine.graph.graphReject(r.proposal, '不是同一个概念')
    assert.equal(readFileSync(registryPath(root), 'utf8'), `${REGISTRY_YAML}\n`)
    const p = (await engine.store.loadProposals()).find(x => x.id === r.proposal)!
    assert.equal(p.status, 'rejected')
    assert.equal(p.decision_note, '不是同一个概念')
  })
})

// ---- #265 混淆对候选提案：不自动入册；接受后单方向入册；重复不堆；尊重废弃态 ----

test('#265 候选提案：pending 不入册、重复提名不堆提案；apply 后单方向入册、已声明再提名拒', async () => {
  await withVault(registryVault(), async ({ engine }) => {
    const evidence = ['节点「入门」的题目间共现：q1→「因式分解」、q2→「配方法」']
    const r = await engine.proposals.proposeConfusableCandidate('数学', { a: '因式分解', b: '配方法', evidence })
    assert.equal(r.kind, 'confusable_pair')
    assert.equal(r.weight, 1)
    const p0 = (await engine.store.loadProposals()).find(x => x.id === r.id)!
    assert.ok(p0.summary.includes('证据：'), 'summary 带首条共现证据（人审列表即可读）')
    assert.ok(p0.summary.includes(evidence[0]!.slice(0, 12)))
    let entries = await engine.concepts.load('math')
    assert.equal(entries[0]!.confusable, undefined, '不自动入册')
    const again = await engine.proposals.proposeConfusableCandidate('数学', { a: '配方法', b: '因式分解', evidence: ['另一条证据'] })
    assert.equal(again.id, r.id, '同一候选已在待审队列 → 返回原提案，不堆第二条')

    const out = await engine.graph.proposalApply('confusable_pair', r.id)
    assert.deepEqual(out, { kind: 'confusable_pair', course: '数学', a: '因式分解', b: '配方法', changed: true })
    entries = await engine.concepts.load('math')
    assert.deepEqual(entries[0]!.confusable, ['配方法'], '只写提案声明的方向')
    assert.equal(entries[1]!.confusable, undefined, '不自动补双向（单向是待复核态，ADR-0084 ③）')
    const p = (await engine.store.loadProposals()).find(x => x.id === r.id)!
    assert.equal(p.status, 'applied')
    const tail = await engine.store.journalTail('数学', 5)
    assert.ok(tail.some(x => x.kind === 'concept_confusable' && (x.detail ?? '').includes(String(r.id))))

    await assert.rejects(
      () => engine.proposals.proposeConfusableCandidate('数学', { a: '因式分解', b: '配方法', evidence }),
      /声明/,
      '已入册（任一方向）再提名 → 拒',
    )
  })
})

test('#265 候选提案门：无证据 / 未在册 / 废弃条目都不受理；pending 期间被废弃 → apply 拦', async () => {
  await withVault({
    ...registryVault(),
    files: [{ path: '学习中心/math/概念登记表.yaml', content: `${REGISTRY_YAML}\n  - canonical: 新丙\n` }],
  }, async ({ engine }) => {
    await assert.rejects(
      () => engine.proposals.proposeConfusableCandidate('数学', { a: '因式分解', b: '配方法', evidence: [] }),
      /共现证据|evidence/,
    )
    await assert.rejects(
      () => engine.proposals.proposeConfusableCandidate('数学', { a: '因式分解', b: '没登记', evidence: ['x'] }),
      /不在登记表在册/,
    )
    await engine.concepts.setDeprecated('math', '配方法', true)
    await assert.rejects(
      () => engine.proposals.proposeConfusableCandidate('数学', { a: '因式分解', b: '配方法', evidence: ['x'] }),
      /废弃/,
      '候选面尊重废弃态（不提名已废弃条目）',
    )
    const r = await engine.proposals.proposeConfusableCandidate('数学', { a: '因式分解', b: '新丙', evidence: ['x'] })
    await engine.concepts.setDeprecated('math', '新丙', true)
    await assert.rejects(() => engine.graph.proposalApply('confusable_pair', r.id), /废弃/)
  })
})

// ---- #265 候选派生端到端（子系统缝）：从题库共现到待审提案，可重入不重复堆 ----

const CAND_REGISTRY = [
  'concepts:',
  '  - canonical: 甲',
  '  - canonical: 乙',
  '  - canonical: 丙',
].join('\n')

const CAND_BANKS = {
  入门: [[
    '  - id: q1',
    '    kind: true_false',
    '    q: q1 题干：说法是否成立。',
    '    answer: true',
    '    invokes: 甲',
  ], [
    '  - id: q2',
    '    kind: true_false',
    '    q: q2 题干：说法是否成立。',
    '    answer: true',
    '    invokes: 乙',
  ], [
    '  - id: q3',
    '    kind: true_false',
    '    q: q3 题干：说法是否成立。',
    '    answer: true',
    '    invokes: 丙',
  ]] as string[][],
}

test('#265 conceptConfusableCandidates：共现 → 待审提案；重跑幂等不堆；max 封顶', async () => {
  await withVault({
    tag: 'learnhub-candrun-',
    files: [{ path: '学习中心/math/概念登记表.yaml', content: `${CAND_REGISTRY}\n` }],
    banks: CAND_BANKS,
  }, async ({ engine }) => {
    const r1 = await engine.graph.conceptConfusableCandidates('数学')
    assert.equal(r1.filed.length, 3, '三对共现 → 三条待审提案（甲乙/甲丙/乙丙）')
    assert.ok(r1.message.includes('待审'))
    // 提案产物带共现证据
    const p1 = (await engine.store.loadProposals()).find(x => x.id === r1.filed[0]!.id)!
    const artifact = YAML.parse(readFileSync(p1.artifact, 'utf8')) as { evidence?: string[] }
    assert.ok((artifact.evidence ?? []).length >= 1, '共现证据随产物落盘，人审可查')
    // 重跑：pending 重复提名返回原 id，不堆新提案
    const r2 = await engine.graph.conceptConfusableCandidates('数学')
    assert.deepEqual(r2.filed.map(f => f.id).sort(), [...r1.filed.map(f => f.id)].sort())
    const count = (await engine.store.loadProposals()).filter(x => x.kind === 'confusable_pair').length
    assert.equal(count, 3)
  })
  await withVault({
    tag: 'learnhub-candmax-',
    files: [{ path: '学习中心/math/概念登记表.yaml', content: `${CAND_REGISTRY}\n` }],
    banks: CAND_BANKS,
  }, async ({ engine }) => {
    const r = await engine.graph.conceptConfusableCandidates('数学', 1)
    assert.equal(r.filed.length, 1, '人审一次一条的吞吐，max 封顶单次产出')
  })
})

// ---- #264 错误卡生成期概念引用在册对照：不在册的先验拦在材料外并报告 ----

const EC_BANK = [
  'node: 入门',
  'questions:',
  '  - id: q1',
  '    kind: single_choice',
  '    q: 直角三角形两直角边为 3 和 4，斜边长为？',
  '    options: ["5", "6", "7", "8"]',
  '    answer: A',
  '    explanation: 勾股定理。',
  '    section: s1',
].join('\n')

// #284 存储塌缩：单文件 data/图.yaml { nodes: [...] }
const EC_GRAPH = [
  'nodes:',
  '  - { name: 入门, pre: [], opt: false, note: "", est: 20, misconceptions: [{ concept: 勾股定理, model: 两边相加再开方 }, { concept: 没登记的概念, model: 任意错法 }] }',
].join('\n')

const EC_VALID_YAML = [
  'cards:',
  '  - node: 入门',
  '    source_q: q1',
  '    q: 求直角三角形斜边时，第一步该做什么？',
  '    options: ["用勾股定理求斜边", "把两直角边相加", "两直角边平方再开方"]',
  '    answer: 用勾股定理求斜边',
  '    mine: 把两直角边相加',
  '    explanation: 斜边平方 = 两直角边平方之和；相加不是平方和。',
].join('\n')

test('#264 错误卡在册对照：不在册先验被拦并报告，生成照常完成；登记表 Broken 不拦生成', async () => {
  await withVault({
    tag: 'learnhub-ecgate-',
    graph: EC_GRAPH,
    banks: { 入门: EC_BANK },
    files: [{ path: '学习中心/math/概念登记表.yaml', content: 'concepts:\n  - canonical: 勾股定理\n' }],
  }, async ({ engine, store }) => {
    await store.appendPractice({ course: '数学', node: '入门', ex: 1, answer: 'B', correct: false, judge: 'single_choice', qid: 'q1', ts: '2026-09-07T10:00:00' })
    await store.appendPractice({ course: '数学', node: '入门', ex: 2, answer: 'C', correct: false, judge: 'single_choice', qid: 'q1', ts: '2026-09-08T10:00:00' })
    const result = await engine.bank2.errorCardGenerate('数学', undefined, async () => EC_VALID_YAML)
    assert.equal(result.generated.length, 1, '生成照常完成（拦的是引用不是生成）')
    assert.deepEqual(result.unregistered_concepts, [{ node: '入门', concept: '没登记的概念' }], '不在册名字如实报告')
  })
  await withVault({
    tag: 'learnhub-ecbroken-',
    graph: EC_GRAPH,
    banks: { 入门: EC_BANK },
    files: [{ path: '学习中心/math/概念登记表.yaml', content: 'concepts:\n  - canonical: 甲\n  - canonical: 甲\n' }],
  }, async ({ engine, store }) => {
    await store.appendPractice({ course: '数学', node: '入门', ex: 1, answer: 'B', correct: false, judge: 'single_choice', qid: 'q1', ts: '2026-09-07T10:00:00' })
    await store.appendPractice({ course: '数学', node: '入门', ex: 2, answer: 'C', correct: false, judge: 'single_choice', qid: 'q1', ts: '2026-09-08T10:00:00' })
    const result = await engine.bank2.errorCardGenerate('数学', undefined, async () => EC_VALID_YAML)
    assert.equal(result.generated.length, 1, '登记表 Broken 不拦生成（ADR-0071 读侧纪律），本门降级为不生效')
    assert.equal(result.unregistered_concepts, undefined)
  })
})
