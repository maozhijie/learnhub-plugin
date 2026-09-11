import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { reconsolidationAdvice, SLEEP_SCORE } from '../src/engine/sleep.ts'
import { withVault } from './helpers/vault.ts'

/** 一门两节点课：入门（普通）→ 练习节（practice 交互实践节点 = 重巩固型）。 */
const PRACTICE_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 练习节, pre: [入门], opt: false, note: "", est: 15, type: practice }',
].join('\n')

test('纯函数：文案锁预期管理口径——主建议带 Walker 依据，心理演练带 r≈0.13 与「别替代真练」', () => {
  const sug = reconsolidationAdvice('音阶')
  assert.match(sug.text, /音阶/)
  assert.match(sug.text, /睡前练一小段/)
  assert.match(sug.text, /醒后/)
  assert.match(sug.text, /Walker 2002\/2005/, '证据标注保留（措辞口径）')
  assert.match(sug.rehearsal, /心理演练/)
  assert.match(sug.rehearsal, /r≈0\.13/, '小效应如实标注')
  assert.match(sug.rehearsal, /锦上添花/)
  assert.match(sug.rehearsal, /别替代真练/, '预期管理：不许诺替代效应')
})

test('学习中实践节点：推荐事件就地附着 sleep 建议（不新占推荐位）', async () => {
  await withVault({
    graph: PRACTICE_GRAPH,
    notes: {
      入门: { stage: 'ready' },
      练习节: { stage: 'learning', practice: { attempts: 2, correct: 2 } },
    },
  }, async ({ engine }) => {
    const doc = await engine.recommend()
    const ev = doc.events.find(e => e.node === '练习节')
    assert.ok(ev, 'learning 实践节点本就有推荐事件')
    assert.notEqual(ev.type, 'sleep', '有事件就附着，不另开独立事件')
    const sleep = ev.sleep
    assert.ok(sleep, 'sleep 建议附着在既有事件上')
    assert.match(sleep!.text, /练习节/)
    assert.match(sleep!.rehearsal, /心理演练/)
    // 普通节点不带 sleep 字段
    for (const e of doc.events.filter(x => x.node !== '练习节')) {
      assert.equal(e.sleep, undefined, '重巩固建议只落 practice 节点')
    }
  })
})

test('已开始但今日无事件的实践节点：至多两条独立 sleep 事件，分数低于新课带', async () => {
  await withVault({
    graph: PRACTICE_GRAPH,
    notes: {
      入门: { stage: 'ready' },
      练习节: { stage: 'review', fsrs: { stability: 5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 3, lapses: 0 } },
    },
  }, async ({ engine }) => {
    const doc = await engine.recommend()
    const ev = doc.events.find(e => e.type === 'sleep')
    assert.ok(ev, 'review 态实践节点无其他事件 → 独立 sleep 事件')
    assert.equal(ev.node, '练习节')
    assert.equal(ev.score, SLEEP_SCORE)
    assert.match(ev.why, /睡前练一小段/)
    assert.ok(ev.sleep, '独立事件自带完整建议结构')
  })
})

test('未开始的 practice 节点不出 sleep 建议（首次学它之前谈不上巩固窗口）', async () => {
  await withVault({
    graph: PRACTICE_GRAPH,
    notes: { 入门: { stage: 'ready' }, 练习节: { stage: 'ready' } },
  }, async ({ engine }) => {
    const doc = await engine.recommend()
    assert.ok(!doc.events.some(e => e.sleep), 'ready 态实践节点静默')
    assert.ok(!doc.events.some(e => e.type === 'sleep'))
  })
})

test('可关闭：sleep.enabled=false 后推荐零睡眠建议；配置写不碰其他键', async () => {
  await withVault({
    graph: PRACTICE_GRAPH,
    notes: {
      入门: { stage: 'ready' },
      练习节: { stage: 'learning', practice: { attempts: 2, correct: 2 } },
    },
  }, async ({ engine }) => {
    assert.deepEqual(await engine.lab.sleepAdviceConfig(), { enabled: true }, '默认开')
    await engine.lab.setSleepAdviceConfig({ enabled: false })
    assert.deepEqual(await engine.lab.sleepAdviceConfig(), { enabled: false })
    const doc = await engine.recommend()
    assert.ok(!doc.events.some(e => e.sleep || e.type === 'sleep'), '关闭后整层静默')
    // 配置文件其他键原样保留（day_cutoff 是测试基线写入的）
    const { readFile } = await import('node:fs/promises')
    const cfg = JSON.parse(await readFile(engine.paths.learnhubConfigPath, 'utf8')) as Record<string, unknown>
    assert.equal(cfg.day_cutoff, '00:00')
    assert.deepEqual(cfg.sleep, { enabled: false })
  })
})

test('红线：睡眠建议层纯读侧——recommend 后零 canonical 写入', async () => {
  await withVault({
    graph: PRACTICE_GRAPH,
    notes: {
      入门: { stage: 'ready' },
      练习节: { stage: 'learning', practice: { attempts: 2, correct: 2 } },
    },
  }, async ({ engine }) => {
    await engine.recommend()
    assert.ok(!existsSync(engine.paths.practicePath), '无作答流水')
    assert.ok(!existsSync(engine.paths.reviewLogPath), '无复习日志')
    assert.ok(!existsSync(engine.paths.journalPath), '无 journal 流水')
    assert.ok(!existsSync(engine.paths.courseRoot('math') + '/题库/练习节.yaml'), '实践节点无题库')
  })
})
