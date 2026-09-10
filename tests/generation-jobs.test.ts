import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GEN_JOB_PHASES,
  contentFailureStatus,
  generationJobRetentionMs,
  nextQueuedJob,
  quizFailureOutcome,
  quizSuccessOutcome,
} from '../src/generation-jobs.ts'
import type { GenJobPhase, GenJobStatus } from '../src/generation-jobs.ts'

const HOUR = 60 * 60_000

test('队列 phase 六值（#131 §5 / #140）：节点内容管线三值 + 图域 种子/生长/富化', () => {
  assert.deepEqual([...GEN_JOB_PHASES], ['outline', 'sections', 'quiz', '种子', '生长', '富化'])
  const phases: GenJobPhase[] = ['outline', 'sections', 'quiz', '种子', '生长', '富化']
  assert.equal(phases.length, GEN_JOB_PHASES.length, '类型与值表同步（phase 联合不漂移）')
})

test('生成任务保留：done 30 分钟，partial/failed/cancelled 保留 24h；queued 非终态不清理', () => {
  const statuses: GenJobStatus[] = ['queued', 'running', 'cancelling', 'done', 'partial', 'failed', 'cancelled']
  const retention = Object.fromEntries(statuses.map(status => [status, generationJobRetentionMs(status)]))
  assert.equal(retention.done, 30 * 60_000)
  assert.equal(retention.partial, 24 * HOUR)
  assert.equal(retention.failed, 24 * HOUR)
  assert.equal(retention.cancelled, 24 * HOUR)
})

test('正文失败终态：取消旗标优先，其余保持 failed', () => {
  assert.equal(contentFailureStatus('cancelling'), 'cancelled')
  assert.equal(contentFailureStatus('running'), 'failed')
})

test('nextQueuedJob：FIFO 取 startedAt 最早的排队任务；无排队返回 null', () => {
  const jobs = [
    { key: 'a', status: 'done' as GenJobStatus, startedAt: '2026-09-08T10:00:00Z' },
    { key: 'b', status: 'queued' as GenJobStatus, startedAt: '2026-09-08T10:05:00Z' },
    { key: 'c', status: 'queued' as GenJobStatus, startedAt: '2026-09-08T10:01:00Z' },
    { key: 'd', status: 'running' as GenJobStatus, startedAt: '2026-09-08T09:00:00Z' },
  ]
  assert.equal(nextQueuedJob(jobs)?.key, 'c')
  assert.equal(nextQueuedJob(jobs.filter(j => j.key !== 'c'))?.key, 'b')
  assert.equal(nextQueuedJob(jobs.filter(j => j.status !== 'queued')), null)
  assert.equal(nextQueuedJob([]), null)
})

test('自动出题成功终态仍是 done', () => {
  const r = quizSuccessOutcome('「入口」正文完成（3 节）', 4, 3, 42)
  assert.equal(r.status, 'done')
  assert.equal(r.message, '「入口」正文完成（3 节）；出题 7 道（节绑 4 + 综合 3，题库共 42）')
})

test('自动出题失败终态为 partial，并保留错误与重试指引', () => {
  const r = quizFailureOutcome('「入口」正文完成（3 节）', new Error('模型调用失败[401]'))
  assert.equal(r.status, 'partial')
  assert.match(r.message, /自动出题失败（模型调用失败\[401\]）/)
  assert.match(r.message, /可在练习页单独重试$/)
})
