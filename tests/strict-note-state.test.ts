import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'

const REGISTRY = [
  'courses:',
  '  - id: math-01',
  '    name: 数学',
  '    root: math',
  '    enabled: true',
].join('\n')

const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
].join('\n')

function frontmatter(overrides: Record<string, unknown> = {}, extra?: string): string {
  const lines = ['---']
  lines.push(`node: ${String(overrides.node ?? '入门')}`)
  lines.push(`stage: ${String(overrides.stage ?? 'ready')}`)
  lines.push(`fsrs: ${String(overrides.fsrs ?? 'null')}`)
  // mastery 已退役（ADR-0007）：新式文件不含该键；显式提供时模拟存量文件
  if ('mastery' in overrides) lines.push(`mastery: ${String(overrides.mastery)}`)
  if ('content' in overrides) {
    lines.push(`content: ${String(overrides.content)}`)
  } else {
    lines.push('content:', '  version: 0', '  generated_at: null', '  status: draft')
  }
  if ('practice' in overrides) {
    lines.push(`practice: ${String(overrides.practice)}`)
  } else {
    lines.push('practice:', '  attempts: 0', '  correct: 0')
  }
  for (const key of Object.keys(overrides)) {
    if (['node', 'stage', 'fsrs', 'mastery', 'content', 'practice'].includes(key)) continue
    lines.push(`${key}: ${String(overrides[key])}`)
  }
  if (extra) lines.push(extra)
  lines.push('---', '', '# 入门')
  return lines.join('\n')
}

async function withVault(noteText: string, run: (engine: LearnhubEngine) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-notes-'))
  try {
    const center = join(root, '学习中心')
    const course = join(center, 'math')
    await mkdir(join(course, 'data'), { recursive: true })
    await mkdir(join(course, '课程', '基础'), { recursive: true })
    await mkdir(join(course, '题库'), { recursive: true })
    await writeFile(join(center, '课程注册表.yaml'), `${REGISTRY}\n`, 'utf8')
    await writeFile(join(course, 'data', '基础.yaml'), `${GRAPH}\n`, 'utf8')
    await writeFile(join(course, '课程', '基础', '入门.md'), `${noteText}\n`, 'utf8')
    await run(new LearnhubEngine({ vault: root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('#7 valid core state loads, unknown metadata is preserved on write, missing practice_ema is normalized', async () => {
  const note = frontmatter({}, 'custom_user_field: 我的元数据')
  await withVault(note, async engine => {
    const { state, broken } = await engine.loadView({ name: '数学', root: 'math' })
    assert.equal(broken.length, 0)
    assert.equal(state['入门']?.practice_ema, undefined)
    assert.equal(state['入门']?.mastery, undefined, 'mastery 已退役：无键合法且不入规范化状态')
    assert.equal(state['入门']?.stage, 'ready')

    await engine.nodeSkip('数学', '入门', true)
    const raw = await readFile(join(await engine.paths.courseDir('math'), '基础', '入门.md'), 'utf8')
    assert.ok(raw.includes('custom_user_field: 我的元数据'), 'unknown metadata was dropped by a state write')
    assert.ok(raw.includes('stage: skipped'), 'stage update missing')
    assert.ok(!raw.includes('mastery:'), '新式文件的回写不得引入 mastery 键')
  })
})

test('#7 mastery 键退役但存量兼容：给出 0–1 合法值不报 Broken', async () => {
  await withVault(frontmatter({ mastery: 0 }), async engine => {
    const view = await engine.loadView({ name: '数学', root: 'math' })
    assert.equal(view.broken.length, 0)
    assert.equal(view.state['入门']?.mastery, 0)
  })
})

test('#7 malformed core state is Broken: targeted operations fail with location/reason and aggregates block', async () => {
  const note = frontmatter({ mastery: '"0.5"' })
  await withVault(note, async engine => {
    const view = await engine.loadView({ name: '数学', root: 'math' })
    assert.equal(Object.keys(view.state).length, 0)
    assert.equal(view.broken.length, 1)
    assert.ok(view.broken[0].reason.includes('mastery'), view.broken[0].reason)
    assert.ok(view.broken[0].path.endsWith('入门.md'))

    await assert.rejects(() => engine.lesson('数学', '入门'), /节点笔记 Broken.*入门\.md[\s\S]*mastery/s)
    await assert.rejects(() => engine.nodeSkip('数学', '入门', true), /节点笔记 Broken/s)
    await assert.rejects(() => engine.nodeComplete('数学', '入门'), /节点笔记 Broken/s)
    await assert.rejects(() => engine.statusJson(), /状态 Broken/s)
    await assert.rejects(() => engine.recommend(), /状态 Broken/s)
    await assert.rejects(() => engine.xpStatus(), /状态 Broken/s)
  })
})

test('#7 pure graph browsing still works and exposes broken_notes explicitly', async () => {
  const note = frontmatter({ stage: 'sometimes' })
  await withVault(note, async engine => {
    const doc = await engine.graphBrowse('数学')
    assert.equal(doc.total, 1)
    assert.equal(doc.broken_notes.length, 1)
    assert.equal(doc.broken_notes[0].node, '入门')
    assert.ok(doc.broken_notes[0].reason.includes('stage'))
  })
})

test('#7 invalid present practice_ema is Broken while absence is legal', async () => {
  await withVault(frontmatter({ practice_ema: '高' }), async engine => {
    const view = await engine.loadView({ name: '数学', root: 'math' })
    assert.equal(view.broken.length, 1)
    assert.ok(view.broken[0].reason.includes('practice_ema'))
  })
})

test('#7 malformed fsrs, content, practice and unknown notes are all classified Broken', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ fsrs: 'yes' }, 'fsrs'],
    [{ content: 'oops' }, 'content'],
    [{ practice: 'oops' }, 'practice'],
    [{ stage: 'not-a-stage' }, 'stage'],
  ]
  for (const [override, needle] of cases) {
    await withVault(frontmatter(override), async engine => {
      const view = await engine.loadView({ name: '数学', root: 'math' })
      assert.equal(view.broken.length, 1, `expected Broken for ${needle}`)
      assert.ok(view.broken[0].reason.includes(needle), view.broken[0].reason)
    })
  }
})

test('#7 content.tier 只接受 低/中/高：非法值 Broken，合法值往返保留', async () => {
  const noteWith = (tier: string) => [
    '---', 'node: 入门', 'stage: ready', 'fsrs: null', 'mastery: 0',
    'content:', '  version: 0', '  generated_at: null', '  status: draft', `  tier: ${tier}`,
    'practice:', '  attempts: 0', '  correct: 0', '---', '', '# 入门',
  ].join('\n')
  await withVault(noteWith('超'), async engine => {
    const view = await engine.loadView({ name: '数学', root: 'math' })
    assert.equal(view.broken.length, 1)
    assert.ok(view.broken[0].reason.includes('tier'), view.broken[0].reason)
  })
  await withVault(noteWith('高'), async engine => {
    const view = await engine.loadView({ name: '数学', root: 'math' })
    assert.equal(view.broken.length, 0)
    assert.equal(view.state['入门']?.content.tier, '高')
  })
})
