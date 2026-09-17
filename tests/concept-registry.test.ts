import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  activeEntries,
  applyConceptMints,
  confusablePairsOf,
  conceptReferenceErrors,
  deprecatedNames,
  isDeprecated,
  mergeConceptEntries,
  namesOf,
  resolveConcept,
  setConceptDeprecated,
  validateConceptRegistry,
  ConceptRegistry,
} from '../src/engine/concepts/concepts.ts'
import { validateBank } from '../src/engine/content/question-bank.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { validateEditProposal } from '../src/engine/coach/proposals.ts'
import { withVault } from './helpers/vault.ts'
import type { Paths } from '../src/engine/infra/paths.ts'

// 概念登记表（#141 / #122 契约 v0.1）：课程根/概念登记表.yaml，每课程一份受控词表。
// 条目 = canonical 名 + 别名[] + 选填定义；全部名字联合唯一（违约 Broken、缺失 Missing
// 合法空态）；引用解析 = 精确匹配在册名字；条目禁删只并入（合并 = 名字并集，旧地址经
// 别名续解析）；铸名随生长批提案与图 apply 同事务落盘；受理门对 teaches/assumes/误解/
// invokes 的概念引用做在册校验。

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

// ---- 契约：联合唯一违约 Broken、文件缺失 Missing 合法空态 ----

test('#141 文件缺失 = Missing 合法空态：load 返回空表不抛错', async () => {
  await withVault({ graph: null }, async ({ engine, root }) => {
    assert.equal(existsSync(registryPath(root)), false)
    assert.deepEqual(await engine.concepts.load('math'), [])
  })
})

test('#141 YAML 无法解析 = Broken 抛错（不静默当空表）', async () => {
  await withVault({
    graph: null,
    files: [{ path: '学习中心/math/概念登记表.yaml', content: 'concepts:\n  - canonical: "因式分解\n' }],
  }, async ({ engine }) => {
    await assert.rejects(() => engine.concepts.load('math'), /概念登记表 Broken.*YAML 无法解析/s)
  })
})

test('#141 联合唯一违约 = Broken：canonical 互重、canonical 撞别名、别名互重', () => {
  const dupCanonical = validateConceptRegistry({
    concepts: [{ canonical: '因式分解' }, { canonical: '因式分解' }],
  })
  assert.ok(dupCanonical.errors.some(e => e.includes('concepts.2.canonical') && e.includes('联合唯一')))

  const crossName = validateConceptRegistry({
    concepts: [{ canonical: '因式分解' }, { canonical: '配方法', aliases: ['因式分解'] }],
  })
  assert.ok(crossName.errors.some(e => e.includes('「因式分解」') && e.includes('联合唯一')))

  const dupAlias = validateConceptRegistry({
    concepts: [{ canonical: '甲', aliases: ['别名一'] }, { canonical: '乙', aliases: ['别名一'] }],
  })
  assert.ok(dupAlias.errors.some(e => e.includes('「别名一」')))

  const selfDup = validateConceptRegistry({ concepts: [{ canonical: '甲', aliases: ['甲'] }] })
  assert.ok(selfDup.errors.some(e => e.includes('「甲」')))
})

test('#141 条目契约：canonical 空、aliases 非列表、definition 非字符串、未知键拒收', () => {
  assert.ok(validateConceptRegistry({ concepts: [{ canonical: '  ' }] }).errors.some(e => e.includes('canonical: 不能为空')))
  assert.ok(validateConceptRegistry({ concepts: [{ canonical: '甲', aliases: ['甲', 3] }] }).errors.some(e => e.includes('aliases: 必须是字符串列表')))
  assert.ok(validateConceptRegistry({ concepts: [{ canonical: '甲', definition: 5 }] }).errors.some(e => e.includes('definition: 必须是非空字符串')))
  assert.ok(validateConceptRegistry({ concepts: [{ canonical: '甲', name: '乙' }] }).errors.some(e => e.includes('含未知字段')))
  assert.ok(validateConceptRegistry({ concepts: '不是列表' }).errors.some(e => e.includes('concepts: 必须是列表')))
  assert.ok(validateConceptRegistry(null).errors.length > 0)
})

test('#141 合法登记表加载：trim 保真、空 concepts 合法', async () => {
  await withVault(registryVault(), async ({ engine }) => {
    const entries = await engine.concepts.load('math')
    assert.deepEqual(entries, [
      { canonical: '因式分解', aliases: ['十字相乘法'], definition: '把多项式化为几个整式的乘积' },
      { canonical: '配方法' },
    ])
  })
  assert.deepEqual(validateConceptRegistry({ concepts: [] }).errors, [])
})

// ---- 身份=条目、名字=地址：别名解析 ----

test('#141 引用解析：canonical 与别名精确命中 → 条目；未命中 null；永不模糊匹配', async () => {
  await withVault(registryVault(), async ({ engine }) => {
    const entries = await engine.concepts.load('math')
    assert.equal(resolveConcept(entries, '因式分解')?.canonical, '因式分解')
    assert.equal(resolveConcept(entries, '十字相乘法')?.canonical, '因式分解', '别名解析到同一身份')
    assert.equal(resolveConcept(entries, '因式分'), null, '模糊前缀不命中')
    assert.equal(resolveConcept(entries, '不存在'), null)
    assert.deepEqual([...namesOf(entries)].sort(), ['十字相乘法', '因式分解', '配方法'])
  })
})

// ---- 条目禁删只并入（#265 起：合并从直写面改为「提案 + 人确认」两段式——
// 直调面 ConceptRegistry.merge 已退役，引擎缝测试迁至 concept-governance.test.ts；
// 纯函数语义（名字并集 / definition 回退 / 别名定位）仍在此直测）----

test('#141 并入：definition 缺省回退（into 无定义时承继 from 的）', () => {
  const { errors, entries } = mergeConceptEntries(
    [{ canonical: '甲' }, { canonical: '乙', definition: '乙的定义' }],
    '乙', '甲',
  )
  assert.equal(errors.length, 0)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.canonical, '甲')
  assert.equal(entries[0]!.definition, '乙的定义')
})

test('#141 并入经别名定位：用别名指称条目同样生效', () => {
  const { errors, entries } = mergeConceptEntries(
    [{ canonical: '甲', aliases: ['甲别'] }, { canonical: '乙' }],
    '甲别', '乙',
  )
  assert.equal(errors.length, 0)
  assert.equal(resolveConcept(entries, '甲别')?.canonical, '乙')
})

// ---- 受理门对表：teaches/assumes/误解概念引用在册校验 ----

test('#141 受理门：引用未在册名字的 edit 提案被拒（拒收信息可执行、不落提案）', async () => {
  await withVault({ ...registryVault(), tag: 'learnhub-refgate-' }, async ({ engine }) => {
    const yaml = `course: 数学
ops:
  - op: add_node
    name: 中继节点
    pre: [入门]
    teaches: { 未登记概念: 知道 }
    assumes: { 也没登记: 会用, 因式分解: 知道 }
    misconceptions:
      - { concept: 误解未登记, model: 错法 }
`
    await assert.rejects(() => engine.graph.graphPropose('edit', yaml), e => {
      const m = (e as Error).message
      assert.match(m, /未登记概念/)
      assert.match(m, /未在登记表/)
      assert.match(m, /也没登记/, '逐名列出全部未在册引用')
      assert.match(m, /误解未登记/)
      return true
    })
    assert.equal((await engine.store.loadProposals()).length, 0, '拒收不落提案')
  })
})

test('#141 受理门：引用在册名字（含别名）的提案受理；登记表缺失时任何引用都拒', async () => {
  await withVault({ ...registryVault(), tag: 'learnhub-refok-' }, async ({ engine }) => {
    const yaml = `course: 数学
ops:
  - op: add_node
    name: 中继节点
    pre: [入门]
    teaches: { 十字相乘法: 知道 }
`
    const r = await engine.graph.graphPropose('edit', yaml) as { id: number }
    assert.ok(r.id > 0, '别名是在册地址，受理')
  })
  await withVault({ tag: 'learnhub-refnone-' }, async ({ engine }) => {
    const yaml = `course: 数学
ops:
  - op: add_node
    name: 中继节点
    pre: [入门]
    teaches: { 任意概念: 知道 }
`
    await assert.rejects(() => engine.graph.graphPropose('edit', yaml), /任意概念.*未在登记表|不在登记表/)
  })
})

test('#141 铸名与引用同批：concepts 块铸名 + ops 引用同批名字 → 受理', async () => {
  await withVault({ ...registryVault(), tag: 'learnhub-mintref-' }, async ({ engine }) => {
    const yaml = `course: 数学
reason: 生长批：中继节点
concepts:
  - canonical: 行变换几何直觉
    definition: 把行变换看成平面上的几何操作
ops:
  - op: add_node
    name: 中继节点
    pre: [入门]
    est: 10
    teaches: { 行变换几何直觉: 知道 }
    misconceptions:
      - { concept: 行变换几何直觉, model: 把行变换当成列变换 }
`
    const r = await engine.graph.graphPropose('edit', yaml) as { id: number }
    assert.ok(r.id > 0)
  })
})

test('#141 铸名撞名：提案铸名与登记表既有名字冲突 → 拒收（指向既有条目）', async () => {
  await withVault({ ...registryVault(), tag: 'learnhub-mintdup-' }, async ({ engine }) => {
    const clashCanonical = `course: 数学
concepts:
  - canonical: 因式分解
ops:
  - op: add_node
    name: 节点甲
    pre: [入门]
`
    await assert.rejects(() => engine.graph.graphPropose('edit', clashCanonical), /「因式分解」.*已在登记表|铸名冲突/)
    const clashAlias = `course: 数学
concepts:
  - canonical: 新名字
    aliases: [十字相乘法]
ops:
  - op: add_node
    name: 节点乙
    pre: [入门]
`
    await assert.rejects(() => engine.graph.graphPropose('edit', clashAlias), /十字相乘法/)
    const clashWithin = `course: 数学
concepts:
  - canonical: 概念甲
  - canonical: 概念甲
ops:
  - op: add_node
    name: 节点丙
    pre: [入门]
`
    await assert.rejects(() => engine.graph.graphPropose('edit', clashWithin), /概念甲/)
    assert.equal((await engine.store.loadProposals()).length, 0)
  })
})

test('#141 concepts 块条目契约：canonical 缺失、未知键 → schema 拒收', () => {
  const noCanonical = validateEditProposal({
    course: '数学',
    concepts: [{ definition: '没有 canonical' }],
    ops: [{ op: 'add_node', name: '甲', operator: '前进' }]
  })
  assert.ok(noCanonical.errors?.some(e => e.includes('canonical')))
  const unknownKey = validateEditProposal({
    course: '数学',
    concepts: [{ canonical: '甲', tier: '知道' }],
    ops: [{ op: 'add_node', name: '甲', operator: '前进' }]
  })
  assert.ok(unknownKey.errors?.some(e => e.includes('含未知字段')))
})

// ---- 同事务：铸名随 apply 落盘，提案被拒则登记不落盘 ----

const MINT_YAML = `course: 数学
reason: 生长批：中继节点
concepts:
  - canonical: 行变换几何直觉
    definition: 把行变换看成平面上的几何操作
ops:
  - op: add_node
    name: 中继节点
    pre: [入门]
    est: 10
    teaches: { 行变换几何直觉: 知道 }
`

test('#141 同事务：apply 后图与登记表同时落盘（铸名随生长批生效）', async () => {
  await withVault({ tag: 'learnhub-mintapply-' }, async ({ engine, root }) => {
    const r = await engine.graph.graphPropose('edit', MINT_YAML) as { id: number }
    await engine.graph.graphApply('edit', r.id)
    const onDisk = readFileSync(registryPath(root), 'utf8')
    assert.match(onDisk, /行变换几何直觉/)
    assert.match(onDisk, /把行变换看成平面上的几何操作/)
    const dataYaml = readFileSync(join(root, '学习中心', 'math', 'data', '图.yaml'), 'utf8')
    assert.match(dataYaml, /行变换几何直觉: 知道/)
  })
})

test('#141 同事务：提案被拒则登记表不落盘', async () => {
  await withVault({ tag: 'learnhub-mintreject-' }, async ({ engine, root }) => {
    const r = await engine.graph.graphPropose('edit', MINT_YAML) as { id: number }
    await engine.graph.graphReject(r.id, '人审不通过')
    assert.equal(existsSync(registryPath(root)), false, '登记不落盘')
  })
})

test('#141 apply 幂等：铸名已落盘后重放（受理后登记表已含同条目）不炸不重复', () => {
  const existing = [{ canonical: '甲', definition: '定义' }]
  const once = applyConceptMints(existing, [{ canonical: '乙' }])
  assert.equal(once.errors.length, 0)
  assert.deepEqual(once.entries.map(x => x.canonical), ['甲', '乙'])
  // 同一笔铸名重放（崩溃恢复场景）：已属同一条目 → 幂等跳过
  const replay = applyConceptMints(once.entries, [{ canonical: '乙' }])
  assert.equal(replay.errors.length, 0)
  assert.equal(replay.entries.filter(x => x.canonical === '乙').length, 1)
  // 名字已属其他条目（含别名占用）→ apply 兜底拒绝
  const clash = applyConceptMints(
    [{ canonical: '甲', definition: '定义' }, { canonical: '乙', aliases: ['乙别'] }],
    [{ canonical: '丙', aliases: ['乙别'] }],
  )
  assert.ok(clash.errors.some(e => e.includes('「乙别」') && e.includes('乙')))
})

// ---- invokes 出生引用在册校验 ----

const QUIZ_BODY = ['# 入门', '', '入门正文足够长，用于出题冒烟。'].join('\n')

/** 两道 true_false 的模型输出；label 进题面（批间题面完全不同，避开 #119 查重门）。 */
const quizLlm = (invokes: string | null, label = '甲批') => async () => [
  'node: 入门',
  'questions:',
  '  - kind: true_false',
  `    q: ${label}第一问：三角形的内角和是180度。`,
  '    answer: true',
  ...(invokes ? [`    invokes: ${invokes}`] : []),
  '  - kind: true_false',
  `    q: ${label}第二问：正方形四条边长度相等。`,
  '    answer: true',
].join('\n')

test('#141 出题受理门：invokes 引用在册 → 入库；未在册 → 拒收并报告；缺席恒合法', async () => {
  await withVault({ ...registryVault(), notes: { 入门: { body: QUIZ_BODY.split('\n') } }, tag: 'learnhub-invokes-' },
    async ({ engine, paths }) => {
      const r = await engine.bank2.questionGenerate('数学', '入门', 2, quizLlm('因式分解'))
      assert.equal(r.added, 2, '在册引用与缺席都入库')
      const bank = await engine.bank.load(paths.courseRoot('math'), '入门')
      assert.equal(bank.questions[0]!.invokes, '因式分解')
      assert.equal(bank.questions[1]!.invokes, undefined, 'invokes 缺席恒合法 Missing')

      const bad = await engine.bank2.questionGenerate('数学', '入门', 2, async () => [
        'node: 入门',
        'questions:',
        '  - kind: true_false',
        '    q: 乙批独立题：光合作用吸收二氧化碳。',
        '    answer: true',
        '    invokes: 没登记的概念',
        '  - kind: true_false',
        '    q: 地球绕太阳公转一圈是一年。',
        '    answer: true',
      ].join('\n'))
      assert.equal(bad.added, 1, '未在册的拒收，在册的（缺席）照常入库')
      assert.equal(bad.rejected.length, 1)
      assert.match(bad.rejected[0]!.reason, /没登记的概念/)
      assert.match(bad.rejected[0]!.reason, /登记表|在册/)
    })
})

test('#141 出题受理门：invokes 别名引用合法解析；题库 schema 透传与形态门', async () => {
  await withVault({ ...registryVault(), notes: { 入门: { body: QUIZ_BODY.split('\n') } }, tag: 'learnhub-invalias-' },
    async ({ engine, paths }) => {
      const r = await engine.bank2.questionGenerate('数学', '入门', 1, quizLlm('十字相乘法'))
      assert.equal(r.added, 1)
      assert.equal(r.rejected.length, 0)
      const bank = await engine.bank.load(paths.courseRoot('math'), '入门')
      assert.equal(bank.questions[0]!.invokes, '十字相乘法')
    })
  // schema 层：非字符串 invokes 报形态错误；合法字符串透传
  const bad = validateBank({ node: '入门', questions: [{ kind: 'true_false', q: '题', answer: true, invokes: 3 }] })
  assert.ok(bad.errors?.some(e => e.includes('invokes')))
  const ok = validateBank({ node: '入门', questions: [{ kind: 'true_false', q: '题', answer: true, invokes: '甲' }] })
  assert.equal(ok.errors, undefined)
  assert.equal(ok.spec!.questions[0]!.invokes, '甲')
})

// ---- data-check 覆盖登记表类 ----

test('#141 data-check：登记表缺席 = 合法空态零 finding（选填域，与我的卡同款）；inventory 可见', async () => {
  await withVault({ graph: null, tag: 'learnhub-dcmiss-' }, async ({ engine }) => {
    const report = await engine.dataCheck()
    assert.ok(!report.findings.some(f => f.area === 'concept_registry'), '缺席不报 finding')
    assert.deepEqual(report.byArea.concept_registry, { missing: 0, broken: 0, archived: 0, hint: 0 })
    assert.equal(report.inventory.conceptRegistries.present, 0)
    assert.equal(report.inventory.conceptRegistries.entries, 0)
  })
})

test('#141 data-check：联合唯一违约 = broken（concept_registry_schema）', async () => {
  await withVault({
    graph: null,
    tag: 'learnhub-dcbroken-',
    files: [{
      path: '学习中心/math/概念登记表.yaml',
      content: 'concepts:\n  - { canonical: 甲 }\n  - { canonical: 乙, aliases: [甲] }\n',
    }],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    assert.equal(report.status, 'broken')
    assert.deepEqual(report.byArea.concept_registry, { missing: 0, broken: 1, archived: 0, hint: 0 })
    const f = report.findings.find(x => x.reason === 'concept_registry_schema')
    assert.ok(f, '报 concept_registry_schema')
    assert.match(f!.detail ?? '', /联合唯一|甲/)
  })
})

test('#141 data-check：合法登记表盘点条目数', async () => {
  await withVault({ ...registryVault(), graph: null, tag: 'learnhub-dcok-' }, async ({ engine }) => {
    const report = await engine.dataCheck()
    assert.deepEqual(report.byArea.concept_registry, { missing: 0, broken: 0, archived: 0, hint: 0 })
    assert.equal(report.inventory.conceptRegistries.present, 1)
    assert.equal(report.inventory.conceptRegistries.entries, 2)
  })
})

// ---- 静态兜底：conceptReferenceErrors 纯函数 ----

test('#141 conceptReferenceErrors：逐名可执行错误行', () => {
  const known = namesOf([{ canonical: '甲', aliases: ['甲别'] }])
  const errs = conceptReferenceErrors([
    { where: 'teaches[节点一]', concept: '甲别' },
    { where: 'assumes[节点一]', concept: '乙' },
    { where: 'misconceptions[节点二]', concept: '丙' },
  ], known)
  assert.equal(errs.length, 2)
  assert.match(errs[0]!, /乙/)
  assert.match(errs[1]!, /丙/)
  assert.deepEqual(conceptReferenceErrors([{ where: 'teaches[x]', concept: '甲' }], known), [])
})

// ---- 类型面：Paths 提供登记表路径（课程根下） ----

test('#141 登记表路径在课程根下（跨断裂存活的坐标位）', async () => {
  await withVault({ graph: null }, async ({ paths }: { paths: Paths }) => {
    assert.equal(paths.conceptRegistryPath('math'), `${paths.courseRoot('math')}/概念登记表.yaml`)
    const reg = new ConceptRegistry(paths, nodeVaultFs)
    await reg.save('math', [{ canonical: '甲' }])
    assert.deepEqual(await reg.load('math'), [{ canonical: '甲' }])
  })
})

// ---- 易混对（#232 / 契约 v0.2）：可选字段 + 候选对提取 ----

test('#232 confusable 可选字段：字符串列表合法；非列表报错；未知键照旧 fail loud；缺席 = Missing', () => {
  const ok = validateConceptRegistry({ concepts: [{ canonical: '甲', confusable: ['乙', ' 丙 '] }] })
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.entries[0]!.confusable, ['乙', '丙'], 'trim、空串剔除')

  const notList = validateConceptRegistry({ concepts: [{ canonical: '甲', confusable: '乙' }] })
  assert.match(notList.errors.join('\n'), /confusable: 必须是字符串列表/)

  const mixedList = validateConceptRegistry({ concepts: [{ canonical: '甲', confusable: ['乙', 3] }] })
  assert.match(mixedList.errors.join('\n'), /confusable: 必须是字符串列表/)

  const unknownKey = validateConceptRegistry({ concepts: [{ canonical: '甲', confusabel: ['乙'] }] })
  assert.match(unknownKey.errors.join('\n'), /含未知字段/, '拼错键名仍被未知键门拦住')

  const absent = validateConceptRegistry({ concepts: [{ canonical: '甲' }] })
  assert.deepEqual(absent.errors, [])
  assert.equal(absent.entries[0]!.confusable, undefined, '字段缺席合法 Missing')
})

test('#232 confusablePairsOf：精确解析归一、scope 相交过滤、悬空/自指降级、去重保序', () => {
  const entries = [
    { canonical: '自然数', confusable: ['质数', '悬空名', '自然数'] },
    { canonical: '质数', aliases: ['素数'], confusable: ['自然数'] },
    { canonical: '整除' },
  ]
  // scope 含自然数与质数：自然数↔质数 双向登记去重成一对
  assert.deepEqual(confusablePairsOf(entries, new Set(['自然数', '质数'])), [{ a: '自然数', b: '质数' }])
  // scope 只含整除：无相交对 → 空
  assert.deepEqual(confusablePairsOf(entries, new Set(['整除'])), [])
  // 悬空名与自指对静默跳过（不炸、不产对）
  assert.deepEqual(confusablePairsOf(entries, new Set(['自然数'])), [{ a: '自然数', b: '质数' }])
  // 别名引用解析到 canonical
  const viaAlias = [{ canonical: '甲', confusable: ['素数'] }, ...entries.slice(1)]
  assert.deepEqual(confusablePairsOf(viaAlias, new Set(['甲'])), [{ a: '甲', b: '质数' }])
})

test('#232 合并不丢易混对：from 与 into 的 confusable 并集随并入条目保留', () => {
  const merged = mergeConceptEntries(
    [
      { canonical: '甲', confusable: ['丙'] },
      { canonical: '乙', confusable: ['丙', '丁'] },
      { canonical: '丙' },
    ],
    '乙', '甲',
  )
  const dst = merged.entries.find(e => e.canonical === '甲')!
  assert.deepEqual(dst.confusable, ['丙', '丁'], '并集去重（丙双写合一）')
})

// ---- 地址生命周期（#262 / ADR-0084）：废弃 = 标记不删除、可逆、地址仍解析、退出注入/候选 ----

test('#262 deprecated 可选字段：布尔合法；false 归一为缺席（清标记无残留）；非布尔报错', () => {
  const ok = validateConceptRegistry({ concepts: [{ canonical: '甲', deprecated: true }] })
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.entries[0]!.deprecated, true)

  const off = validateConceptRegistry({ concepts: [{ canonical: '甲', deprecated: false }] })
  assert.deepEqual(off.errors, [])
  assert.equal('deprecated' in off.entries[0]!, false, 'false 归一为缺席（写侧只落 true）')

  const absent = validateConceptRegistry({ concepts: [{ canonical: '甲' }] })
  assert.equal(absent.entries[0]!.deprecated, undefined)

  const bad = validateConceptRegistry({ concepts: [{ canonical: '甲', deprecated: '是' }] })
  assert.match(bad.errors.join('\n'), /deprecated: 必须是布尔值/)
})

test('#262 废弃判定与过滤：isDeprecated / activeEntries / deprecatedNames（canonical ∪ 别名）', () => {
  const entries = [
    { canonical: '甲', aliases: ['甲别'] },
    { canonical: '乙', deprecated: true },
    { canonical: '丙', aliases: ['丙别'], deprecated: true },
  ]
  assert.equal(isDeprecated(entries[0]!), false)
  assert.equal(isDeprecated(entries[1]!), true)
  assert.deepEqual(activeEntries(entries).map(e => e.canonical), ['甲'])
  assert.deepEqual([...deprecatedNames(entries)].sort(), ['丙', '丙别', '乙'])
})

test('#262 废弃地址仍解析：resolveConcept / namesOf 对废弃条目不例外', () => {
  const entries = [{ canonical: '甲', aliases: ['甲别'], deprecated: true }]
  assert.equal(resolveConcept(entries, '甲')?.canonical, '甲')
  assert.equal(resolveConcept(entries, '甲别')?.canonical, '甲', '别名地址仍解析')
  assert.deepEqual([...namesOf(entries)].sort(), ['甲', '甲别'])
})

test('#262 setConceptDeprecated 纯函数：置标记 / 清标记完全恢复 / 未在册报错', () => {
  const base = [
    { canonical: '甲', aliases: ['甲别'], definition: '定义' },
    { canonical: '乙' },
  ]
  const on = setConceptDeprecated(base, '甲别', true)
  assert.equal(on.errors.length, 0)
  assert.equal(on.entries[0]!.deprecated, true, '按别名定位到身份条目')
  assert.equal(on.entries[1]!.deprecated, undefined, '其余条目不动')
  // 清标记 = 字段删除，完全恢复（与原始对象 deep-equal，无残留副作用）
  const off = setConceptDeprecated(on.entries, '甲', false)
  assert.equal(off.errors.length, 0)
  assert.deepEqual(off.entries, base)
  // 未在册名字 → 错误不落盘
  const miss = setConceptDeprecated(base, '不存在', true)
  assert.equal(miss.errors.length, 1)
  assert.match(miss.errors[0]!, /不在登记表/)
  assert.deepEqual(miss.entries, base)
})

test('#262 易混对候选退出：任一端废弃的对不产出（地址仍解析）；清标记后恢复产出', () => {
  const entries = [
    { canonical: '自然数', confusable: ['质数'] },
    { canonical: '质数', confusable: ['自然数'], deprecated: true },
    { canonical: '整除' },
  ]
  assert.deepEqual(confusablePairsOf(entries, new Set(['自然数', '质数'])), [])
  const rev = setConceptDeprecated(entries, '质数', false).entries
  assert.deepEqual(confusablePairsOf(rev, new Set(['自然数', '质数'])), [{ a: '自然数', b: '质数' }])
})

test('#262 登记表门面：setDeprecated 落盘 + 废弃地址仍解析 + 清标记完全恢复 + 失败不改盘', async () => {
  await withVault(registryVault(), async ({ engine, root }) => {
    const original = await engine.concepts.load('math')
    const r = await engine.concepts.setDeprecated('math', '十字相乘法', true)
    assert.equal(r.canonical, '因式分解', '按别名定位到身份条目')
    assert.equal(r.deprecated, true)
    const entries = await engine.concepts.load('math')
    assert.equal(resolveConcept(entries, '因式分解')?.deprecated, true)
    assert.equal(resolveConcept(entries, '十字相乘法')?.canonical, '因式分解', '废弃后别名地址仍解析')
    assert.match(readFileSync(registryPath(root), 'utf8'), /deprecated: true/)
    // 清标记完全恢复（读回与原始条目 deep-equal）
    await engine.concepts.setDeprecated('math', '因式分解', false)
    assert.deepEqual(await engine.concepts.load('math'), original, '清标记无残留')
    // 未在册名字 → 抛错不改盘
    await assert.rejects(() => engine.concepts.setDeprecated('math', '不存在', true), /不在登记表/)
    assert.deepEqual(await engine.concepts.load('math'), original)
  })
})

test('#262 生成注入面退出：废弃概念不出现在概念清单与易混对块；旧地址引用仍受理', async () => {
  // #284 存储塌缩：单文件 data/图.yaml { nodes: [...] }
  const graph = [
    'nodes:',
    '  - { name: 入门, pre: [], opt: false, note: "", est: 20, teaches: { 因式分解: 知道, 配方法: 会用 } }',
  ].join('\n')
  await withVault({
    graph,
    notes: { 入门: { body: QUIZ_BODY.split('\n') } },
    tag: 'learnhub-depinject-',
    files: [{
      path: '学习中心/math/概念登记表.yaml',
      content: [
        'concepts:',
        '  - canonical: 因式分解',
        '    aliases: [十字相乘法]',
        '    confusable: [配方法]',
        '    deprecated: true',
        '  - canonical: 配方法',
      ].join('\n') + '\n',
    }],
  }, async ({ engine }) => {
    let prompt = ''
    const llmOf = (stem: string, invokes: string) => async (p: string): Promise<string> => {
      prompt = p
      return [
        'node: 入门',
        'questions:',
        '  - kind: true_false',
        `    q: ${stem}`,
        '    answer: true',
        `    invokes: ${invokes}`,
      ].join('\n')
    }
    const r1 = await engine.bank2.questionGenerate('数学', '入门', 1, llmOf('甲批问：三角形的内角和是180度。', '配方法'))
    assert.match(prompt, /## 概念清单/, '活跃概念在场 → 清单块产出')
    // 只看清单块：模板硬约束里出现「因式分解」是举例词，不能对全 prompt 断言
    const scopeBlock = prompt.split('## 概念清单')[1]!.split('---')[0]!
    assert.match(scopeBlock, /- 配方法/)
    assert.doesNotMatch(scopeBlock, /因式分解|十字相乘法/, '废弃概念退出概念清单（含其别名）')
    assert.doesNotMatch(prompt, /## 易混对/, '任一端废弃 → 易混对块不产出（空串）')
    assert.equal(r1.added, 1)
    // 旧地址（废弃概念 canonical/别名）仍解析 → 受理门照常接受
    const r2 = await engine.bank2.questionGenerate('数学', '入门', 1, llmOf('乙批问：地球绕太阳公转一圈是一年。', '十字相乘法'))
    assert.equal(r2.rejected.length, 0)
    assert.equal(r2.added, 1, '废弃地址写的 invokes 仍解析为在册名字、受理')
  })
})

test('#262 内容包注入面退出：§12 误解坑位与 §13 前置概念档位剔除废弃概念（活跃概念照旧）', async () => {
  // #284 存储塌缩：单文件 data/图.yaml { nodes: [...] }
  const graph = [
    'nodes:',
    '  - { name: 入门, pre: [], opt: false, note: "", est: 20, assumes: { "因式分解": "会用", "配方法": "会用" }, misconceptions: [{ concept: "因式分解", model: "把因式分解当成展开" }] }',
  ].join('\n')
  await withVault({
    graph,
    notes: { 入门: { body: ['# 入门', '', '入门正文。'] } },
    tag: 'learnhub-deppack-',
    files: [{
      path: '学习中心/math/概念登记表.yaml',
      content: ['concepts:', '  - canonical: 因式分解', '    deprecated: true', '  - canonical: 配方法'].join('\n') + '\n',
    }],
  }, async ({ engine }) => {
    const pack = await engine.content2.contentPack('数学', '入门')
    assert.match(pack, /## 13\. 前置概念档位/)
    assert.match(pack, /- 配方法：会用/, '活跃概念仍在 §13')
    assert.doesNotMatch(pack, /因式分解/, '废弃概念退出 §13 与 §12')
    assert.doesNotMatch(pack, /## 12\. 误解坑位/, '唯一误解先验废弃 → 整段省略（不产空块）')
  })
})

