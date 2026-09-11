import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { withVault } from './helpers/vault.ts'
import { YAML } from '../src/engine/yaml.ts'

const PRACTICE_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 前置概念, pre: [], opt: false, note: "", est: 15 }',
  '      - { name: 练琴, pre: [前置概念], opt: false, note: "", est: 30, type: practice }',
].join('\n')

const NOTE = [
  '---',
  'node: 练琴',
  'stage: ready',
  'fsrs: null',
  'content:',
  '  version: 0',
  '  generated_at: null',
  '  status: draft',
  'practice:',
  '  attempts: 0',
  '  correct: 0',
  '---',
  '',
  '# 练琴',
  '',
  '## 概念：音阶',
  '',
  'C 大调音阶的指型与换把要点，足够长的一段正文用于量表对照。',
].join('\n')

const REVIEW_LLM = async (): Promise<string> => JSON.stringify({
  score: 0.85,
  verdict: '换弦流程完整，琴颈支撑不够。',
  errors: [{ point: '琴颈支撑', issue: '手腕塌陷', advice: '手腕抬平后再走流程' }],
})

/** 建项目 + 计划（关联节点「练琴」）+ apply。 */
async function seedProject(engine: import('../src/engine/index.ts').LearnhubEngine, nodes: string[] | undefined): Promise<void> {
  await engine.project.projectCreate({ name: '吉他翻新', goal: '半年内能完整弹一首曲子' })
  const prop = await engine.project.projectPlanPropose('吉他翻新', [
    'project: 吉他翻新',
    'plan:',
    '  - id: m1',
    '    name: 换弦入门',
    '    task_class: 照做复现',
    '    acceptance_hints: 能独立完成换弦',
    ...(nodes ? [`    nodes: [${nodes.map(n => JSON.stringify(n)).join(', ')}]`] : []),
  ].join('\n') + '\n')
  await engine.graph.projectApply(prop.id)
}

test('#113 项目日志：追加带学习日条目、文件头只落一次、未写过 = null 合法空态', async () => {
  await withVault({ graph: PRACTICE_GRAPH, notes: { '练琴': `${NOTE}\n` } }, async ({ engine }) => {
    await engine.project.projectCreate({ name: '吉他翻新', goal: 'g' })
    const read = await engine.project.projectLog('吉他翻新')
    assert.equal(read.log, null, '没写过日志 = 合法空态，不建空文件')
    await assert.rejects(() => engine.project.projectLog('不存在'), /不存在/)

    await engine.project.projectLogAppend('吉他翻新', '换了琴弦。', '2026-09-08')
    await engine.project.projectLogAppend('吉他翻新', '练了 F 和弦。', '2026-09-09')
    const { log } = await engine.project.projectLog('吉他翻新')
    assert.ok(log)
    assert.equal((log.match(/# 项目日志/g) ?? []).length, 1, '文件头只出现一次')
    assert.match(log, /## 2026-09-08/)
    assert.match(log, /## 2026-09-09/)
    assert.match(log, /换了琴弦。/)
    await assert.rejects(() => engine.project.projectLogAppend('吉他翻新', '   '), /内容不能为空/)
    await assert.rejects(() => engine.project.projectLogAppend('nope', 'x'), /不存在/)
  })
})

test('#113 回执镜像：关联节点回执落项目工作区可读副本；canonical 流水与 EMA 语义不变', async () => {
  await withVault({ graph: PRACTICE_GRAPH, notes: { '练琴': `${NOTE}\n` } }, async ({ engine }) => {
    await seedProject(engine, ['练琴'])
    const r = await engine.learner.receiptSubmit('数学', '练琴', { kind: 'text', material: '今天完整换了四根弦，用时 20 分钟。' }, REVIEW_LLM)
    assert.equal(r.review_mode, 'full')
    assert.ok((r as unknown as { mirrored_projects?: string[] }).mirrored_projects?.includes('吉他翻新'))
    const mirror = join(engine.paths.projectReceiptDir('吉他翻新'), `数学-练琴-${r.receipt.id}.md`)
    const text = await readFile(mirror, 'utf8')
    assert.match(text, /kind: receipt/)
    assert.match(text, /subject: 数学\/练琴/)
    assert.match(text, /今天完整换了四根弦/)
    assert.match(text, /手腕塌陷/)

    // 未关联该节点的项目不镜像；无关联项目时回执照常入中心流水
    const before = await engine.store.receiptsAll()
    assert.equal(before.length, 1)
    await seedProject2(engine)
    const r2 = await engine.learner.receiptSubmit('数学', '练琴', { kind: 'text', material: '第二次回执。' }, REVIEW_LLM)
    assert.deepEqual((r2 as unknown as { mirrored_projects?: string[] }).mirrored_projects, ['吉他翻新'],
      '只有计划声明了该节点的项目才收到镜像')
  })
})

async function seedProject2(engine: import('../src/engine/index.ts').LearnhubEngine): Promise<void> {
  await engine.project.projectCreate({ name: '无关项目', goal: 'g' })
}

test('#113 项目日志注册为复习源后：出题读日志、零写日志文件（ADR-0010 只读纪律）', async () => {
  await withVault({ graph: PRACTICE_GRAPH, notes: { '练琴': `${NOTE}\n` } }, async ({ engine }) => {
    await engine.project.projectCreate({ name: '吉他翻新', goal: 'g' })
    await engine.project.projectLogAppend('吉他翻新', '换弦的完整步骤记录，足够出题的内容：先松弦，再换弦，最后调音。', '2026-09-08')
    const logAbs = engine.paths.projectLogPath('吉他翻新')
    await engine.channels.noteSourceRegister(logAbs.replace(/\\/g, '/'))
    const before = await readFile(logAbs, 'utf8')
    const gen = await engine.channels.noteSourceGenerate('note-1', 3, async () => YAML.stringify({
      questions: [{ kind: 'true_false', q: '日志中换弦步骤的第一步是先松弦。', answer: true }],
    }))
    assert.equal(gen.added, 1)
    assert.equal(await readFile(logAbs, 'utf8'), before, '出题对日志零写入')
  })
})
