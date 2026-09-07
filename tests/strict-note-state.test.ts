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
  lines.push(`mastery: ${String(overrides.mastery ?? '0')}`)
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
    assert.equal(state['入门']?.stage, 'ready')

    await engine.nodeSkip('数学', '入门', true)
    const raw = await readFile(join(await engine.paths.courseDir('math'), '基础', '入门.md'), 'utf8')
    assert.ok(raw.includes('custom_user_field: 我的元数据'), 'unknown metadata was dropped by a state write')
    assert.ok(raw.includes('stage: skipped'), 'stage update missing')
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
