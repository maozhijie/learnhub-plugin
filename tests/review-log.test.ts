import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReviewRec } from '../src/engine/types.ts'
import { answer, tfQuestion, withVault } from './helpers/vault.ts'

const PAST = '2024-01-01'

test('练习流答对：auto/Good 落一条，首学无旧卡 → 快照 null、r_pred=1.0', async () => {
  await withVault({ banks: { 入门: [tfQuestion('a1')] } }, async ({ engine }) => {
    await answer(engine, 'a1', 'true')
    const recs = await engine.store.reviewLogAll() as ReviewRec[]
    assert.equal(recs.length, 1, '一次真实推进恰好一条')
    const rec = recs[0]
    assert.equal(rec.course, '数学')
    assert.equal(rec.node, '入门')
    assert.equal(rec.qid, 'a1')
    assert.equal(rec.rating, 3)
    assert.equal(rec.rating_source, 'auto')
    assert.equal(rec.elapsed_days, 0, '首学 elapsed=0')
    assert.equal(rec.stability_before, null)
    assert.equal(rec.difficulty_before, null)
    assert.equal(rec.r_pred, 1, 'FSRS 对新卡的自预测 = 1.0')
    assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/)
  })
})

test('忘记申报：auto/Again + 复习前快照（种子卡 elapsed>0、S/D 取旧值、R 已衰减）', async () => {
  await withVault({
    banks: { 入门: [tfQuestion('a1', {
      fsrs: { stability: 5, difficulty: 5, due: PAST, last_review: PAST, reps: 3, lapses: 0 },
    })] },
  }, async ({ engine }) => {
    await engine.questionForget('数学', '入门', 'a1', 7)
    const recs = await engine.store.reviewLogAll() as ReviewRec[]
    assert.equal(recs.length, 1)
    const rec = recs[0]
    assert.equal(rec.rating, 1)
    assert.equal(rec.rating_source, 'auto', '忘记与答错同口径：auto')
    assert.ok(rec.elapsed_days > 0, `elapsed = 距上次复习天数，得到 ${rec.elapsed_days}`)
    assert.equal(rec.stability_before, 5)
    assert.equal(rec.difficulty_before, 5)
    assert.ok(rec.r_pred !== null && rec.r_pred < 0.9, `旧卡长期未刷 → R 明显衰减，得到 ${rec.r_pred}`)
  })
})

test('复习流自评：挂起作答不落日志，questionRate(Hard) 落 self/2', async () => {
  await withVault({ banks: { 入门: [tfQuestion('a1')] } }, async ({ engine }) => {
    await answer(engine, 'a1', 'true', { deferSchedule: true })
    assert.deepEqual(await engine.store.reviewLogAll(), [], '挂起=未推进，不落日志')
    await engine.questionRate('数学', '入门', 'a1', 2)
    const recs = await engine.store.reviewLogAll() as ReviewRec[]
    assert.equal(recs.length, 1)
    const rec = recs[0]
    assert.equal(rec.rating, 2)
    assert.equal(rec.rating_source, 'self')
    assert.equal(rec.r_pred, 1, '首学自评：r_pred 仍取 FSRS 新卡自预测')
    assert.equal(rec.stability_before, null)
  })
})

test('完成学习合成初始化：synthetic/3、elapsed=0、快照三字段 null；重复完成不重复落', async () => {
  await withVault({ banks: { 入门: [tfQuestion('a1'), tfQuestion('a2')] } }, async ({ engine }) => {
    const done = await engine.nodeComplete('数学', '入门') as Record<string, unknown>
    assert.equal(done.accepted, true)
    assert.equal(done.initialized, 2)
    const recs = await engine.store.reviewLogAll() as ReviewRec[]
    assert.equal(recs.length, 2, '两张未作答的题各落一条合成首复习')
    for (const rec of recs) {
      assert.equal(rec.rating, 3)
      assert.equal(rec.rating_source, 'synthetic')
      assert.equal(rec.elapsed_days, 0)
      assert.equal(rec.stability_before, null, 'synthetic 无「复习前」状态')
      assert.equal(rec.difficulty_before, null)
      assert.equal(rec.r_pred, null)
    }
    assert.deepEqual(recs.map(r => r.qid).sort(), ['a1', 'a2'])

    await engine.nodeComplete('数学', '入门')
    assert.equal((await engine.store.reviewLogAll()).length, 2, '重复完成不再初始化、不再落日志')
  })
})

test('同日重复作答与 5s 内乱猜都不推进、不落日志', async () => {
  await withVault({ banks: { 入门: [tfQuestion('a1'), tfQuestion('a2')] } }, async ({ engine }) => {
    await answer(engine, 'a1', 'true')
    await answer(engine, 'a1', 'true')
    await answer(engine, 'a2', 'false', { elapsedS: 2 }) // 耗时 2s < 5s 且答错 → 乱猜
    const recs = await engine.store.reviewLogAll() as ReviewRec[]
    assert.equal(recs.length, 1, '只有首次认真作答落了日志')
    assert.equal(recs[0].qid, 'a1')
  })
})

test('读取契约：文件缺失 = 合法空态；逐行损坏 = Broken 报出不静默吞', async () => {
  await withVault({}, async ({ engine }) => {
    assert.deepEqual(await engine.store.reviewLogAll(), [], 'Missing 合法空态')
    const dir = engine.paths.centerStateDir
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'review-log.jsonl'), '{"ts":"2026-09-08T00:00:00"}\n{oops\n', 'utf8')
    await assert.rejects(
      () => engine.store.reviewLogAll(),
      /review-log.*第 2 行|Broken/,
      '坏行要报出行号，不能静默跳过',
    )
  })
})
