import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GraphStore } from '../src/engine/graph.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { validateEnrichProposal } from '../src/engine/proposals.ts'
import { withVault } from './helpers/vault.ts'
import { YAML } from '../src/engine/yaml.ts'

// kind=enrich 富化覆盖层通道（#140：schema v2 出生/覆盖层分家，#127 §6 / #131 §6）：
// 受理时计正典文件 sha256 指纹 → pending → 人审 → apply 指纹复核（不符拒收）→
// 写正典 + state/覆盖层.jsonl 留痕 → journal + 快照。读侧只读正典，覆盖层只是审计概念。

const ENRICH_VAULT = {
  graph: `
region: 基础
color: blue
blocks:
  - name: 入门块
    nodes:
      - { name: 入门, pre: [], opt: false, note: "", est: 20 }
      - { name: 进阶, pre: [入门], opt: false, note: "", est: 25 }
`,
}

test('validateEnrichProposal：schema 负路径（未知字段/缺 enc/重复节点/签名字段不设）', () => {
  const v1 = validateEnrichProposal({ course: '数学', fields: [{ node: '入门', teaches: { a: '知道' } }] })
  assert.ok(v1.errors?.some(e => e.includes('覆盖层首期只补写 enc')), '出生字段不进覆盖层')
  const v2 = validateEnrichProposal({ course: '数学', fields: [{ node: '入门' }] })
  assert.ok(v2.errors?.some(e => e.includes('enc 缺失')), '覆盖层条目显式给全量 enc')
  const v3 = validateEnrichProposal({ course: '数学', fields: [{ node: '入门', enc: [] }, { node: '入门', enc: [] }] })
  assert.ok(v3.errors?.some(e => e.includes('节点重复条目')), '每节点至多一条')
  const v4 = validateEnrichProposal({ course: '数学', extra: 1, fields: [{ node: '入门', enc: [] }] })
  assert.ok(v4.errors?.some(e => e.includes('fingerprints 由引擎受理时写入')), '指纹由引擎写入不手工填')
})

test('kind=enrich 完整提案生命周期：受理→pending（带指纹）→apply→正典+覆盖层+journal+快照', async () => {
  await withVault(ENRICH_VAULT, async ({ engine, root }) => {
    const yamlText = `course: 数学
reason: 正文反哺 enc 回填
fields:
  - node: 进阶
    enc:
      - node: 入门
        w: 0.8
        note: 正文反哺候选
`
    const r = await engine.graph.graphPropose('enrich', yamlText) as { id: number; kind: string; files: number }
    assert.equal(r.kind, 'enrich')
    assert.equal(r.files, 1, '目标节点的区文件被指纹锚定')

    // 受理产物留痕：fields + fingerprints 进 artifact（全留痕纪律）
    const artifact = await readFile(
      engine.paths.proposalArtifactPath(r.id, 'enrich', '数学'), 'utf8')
    assert.match(artifact, /fields:/)
    assert.match(artifact, /fingerprints:/)
    assert.match(artifact, /data\/基础\.yaml/)

    const applied = await engine.graph.graphApply('enrich', r.id) as { course: string; fields: number; snapshot: number; files: string[] }
    assert.equal(applied.course, '数学')
    assert.equal(applied.fields, 1)
    assert.equal(applied.snapshot, 1, '快照落盘')
    assert.deepEqual(applied.files, ['基础'], 'files = 被重写的区名')

    // 读侧只读正典：enc 落进 data/*.yaml
    const dataYaml = await readFile(join(root, '学习中心', 'math', 'data', '基础.yaml'), 'utf8')
    assert.match(dataYaml, /name: 进阶[\s\S]*enc:[\s\S]*node: 入门/)
    assert.match(dataYaml, /w: 0\.8/)

    // 覆盖层留痕：{target, field, value, content_hash, applied_at}
    const overlay = await readFile(join(root, '学习中心', 'math', 'state', '覆盖层.jsonl'), 'utf8')
    const line = JSON.parse(overlay.trim()) as { target: string; field: string; content_hash: string; applied_at: string }
    assert.equal(line.target, '进阶')
    assert.equal(line.field, 'enc')
    assert.match(line.content_hash, /^[0-9a-f]{64}$/)
    assert.ok(line.applied_at)

    // journal + 快照（完整提案生命周期）
    const journal = await readFile(join(root, '学习中心', 'state', 'journal.jsonl'), 'utf8')
    assert.match(journal, /graph_enrich/)
    const snapshot = await readFile(join(root, '学习中心', 'state', 'snapshots', '数学-v1.json'), 'utf8')
    assert.ok(snapshot.includes('enc'), '快照带新 enc')
  })
})

test('指纹不符拒收：受理后正典被改 → apply 拒绝并指路重新生成；提案不被静默写入', async () => {
  await withVault(ENRICH_VAULT, async ({ engine, root }) => {
    const yamlText = `course: 数学
fields:
  - node: 进阶
    enc: [{ node: 入门, w: 0.8 }]
`
    const r = await engine.graph.graphPropose('enrich', yamlText) as { id: number }

    // 受理后有人改了正典（edit 提案/手工）
    const dataPath = join(root, '学习中心', 'math', 'data', '基础.yaml')
    await writeFile(dataPath, (await readFile(dataPath, 'utf8')).replace('est: 20', 'est: 22'), 'utf8')

    await assert.rejects(
      () => engine.graph.graphApply('enrich', r.id),
      /sha256 指纹不符，拒绝写入[\s\S]*reject 本提案后重新生成富化提案/,
    )
    // 拒收不改图：正典没有出现新 enc
    const dataYaml = await readFile(dataPath, 'utf8')
    assert.doesNotMatch(dataYaml, /w: 0\.8/)
    const prop = (await engine.store.loadProposals()).find(p => p.id === r.id)
    assert.equal(prop!.status, 'pending', '指纹不符是 apply 拒绝，提案留 pending 待人工处置')
  })
})

test('手工构造的 enrich 提案（无指纹）apply 被拒；目标节点不在图内受理被拒', async () => {
  await withVault(ENRICH_VAULT, async ({ engine }) => {
    // 手工落一条缺指纹的 pending enrich 提案
    const pid = await engine.store.createProposal('enrich', '数学', '', '')
    const path = engine.paths.proposalArtifactPath(pid, 'enrich', '数学')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, YAML.stringify({ course: '数学', fields: [{ node: '进阶', enc: [{ node: '入门', w: 1 }] }] }), 'utf8')
    await engine.store.updateProposal(pid, { artifact: path })
    await assert.rejects(
      () => engine.graph.graphApply('enrich', pid),
      /提案缺内容指纹.*重新生成/,
    )

    await assert.rejects(
      () => engine.graph.graphPropose('enrich', YAML.stringify({ course: '数学', fields: [{ node: '幽灵节点', enc: [] }] })),
      /目标节点不在图内，提案未受理：幽灵节点（覆盖层只补写既有节点；新增节点走 kind=edit）/,
    )
  })
})

test('enrich apply 后可重入核验：图加载带新 enc（读侧只读正典，GraphStore 直读）', async () => {
  await withVault(ENRICH_VAULT, async ({ engine, root }) => {
    const yamlText = `course: 数学
fields:
  - node: 进阶
    enc: [{ node: 入门, w: 0.6, note: 先验 }]
`
    const r = await engine.graph.graphPropose('enrich', yamlText) as { id: number }
    await engine.graph.graphApply('enrich', r.id)
    const store = new GraphStore(engine.paths, join(root, '学习中心', 'math'), nodeVaultFs)
    const regions = await store.load()
    const node = regions[0]!.blocks[0]!.nodes.find(n => n.name === '进阶')!
    assert.deepEqual(node.enc, [{ node: '入门', w: 0.6, note: '先验' }])
  })
})
