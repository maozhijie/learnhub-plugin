import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GEN_JOB_PHASES,
  contentFailureStatus,
  genJobRetentionRemainingMs,
  genJobSweepVerdict,
  generationJobRetentionMs,
  isGenJobTerminal,
  isNodeAnchoredPhase,
  nextQueuedJob,
  quizFailureOutcome,
  quizSuccessOutcome,
} from '../src/generation-jobs.ts'
import type { GenJobPhase, GenJobStatus } from '../src/generation-jobs.ts'

const HOUR = 60 * 60_000

test('队列 phase 十值（#131 §5 / #140 + 面板下发扩展）：节点内容管线三值 + 图域七值', () => {
  assert.deepEqual([...GEN_JOB_PHASES],
    ['outline', 'sections', 'quiz', '种子', '生长', '富化', '罗盘', '反编译', '计划', '里程碑'])
  const phases: GenJobPhase[] = ['outline', 'sections', 'quiz', '种子', '生长', '富化', '罗盘', '反编译', '计划', '里程碑']
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

test('终态判定与内容锚定 phase：活动记录不参与保留期清扫，图域任务不参与节点悬空判定', () => {
  for (const s of ['done', 'partial', 'failed', 'cancelled'] as GenJobStatus[]) {
    assert.equal(isGenJobTerminal(s), true, `${s} 是终态`)
  }
  for (const s of ['queued', 'running', 'cancelling'] as GenJobStatus[]) {
    assert.equal(isGenJobTerminal(s), false, `${s} 非终态`)
  }
  for (const p of [undefined, 'outline', 'sections', 'quiz'] as (GenJobPhase | undefined)[]) {
    assert.equal(isNodeAnchoredPhase(p), true, `phase=${String(p)} 的任务键是真实节点`)
  }
  for (const p of ['种子', '生长', '富化', '罗盘', '反编译', '计划', '里程碑'] as GenJobPhase[]) {
    assert.equal(isNodeAnchoredPhase(p), false, `phase=${p} 是课程级任务，node 槽是标签`)
  }
})

test('清扫裁决：悬空（课程删/节点删改名）一律 dangling，不做墓碑（ADR-0039）', () => {
  const now = Date.parse('2026-09-11T08:00:00Z')
  const base = { status: 'failed' as GenJobStatus, startedAt: '2026-09-11T01:00:00Z' }
  // 课程删了：任何 phase、任何状态都悬空（含排队）
  assert.equal(genJobSweepVerdict({ ...base, phase: '生长' }, { courseMissing: true, nodeMissing: false }, now), 'dangling')
  assert.equal(genJobSweepVerdict({ ...base, status: 'queued', phase: 'quiz' }, { courseMissing: true, nodeMissing: false }, now), 'dangling')
  // 节点删/改名：内容锚定任务悬空（含排队中尚未标注 phase 的内容任务与在途记录）
  assert.equal(genJobSweepVerdict({ ...base, phase: 'quiz' }, { courseMissing: false, nodeMissing: true }, now), 'dangling')
  assert.equal(genJobSweepVerdict({ ...base, status: 'queued' }, { courseMissing: false, nodeMissing: true }, now), 'dangling')
  assert.equal(genJobSweepVerdict({ ...base, status: 'running', phase: 'sections' }, { courseMissing: false, nodeMissing: true }, now), 'dangling')
  // 课程级任务 node 槽是标签：节点缺失不构成悬空
  assert.equal(genJobSweepVerdict({ ...base, phase: '罗盘' }, { courseMissing: false, nodeMissing: true }, now), 'keep')
})

test('清扫裁决：终态超保留期 expired（finishedAt 起算，旧档回退 startedAt），活动记录不受保留期约束', () => {
  const now = Date.parse('2026-09-11T08:00:00Z')
  const ok = { courseMissing: false, nodeMissing: false }
  // finishedAt 一周前：恢复清扫要能清掉跨重启滞留的旧终态记录（保留期失效 bug 的实证形态）
  assert.equal(genJobSweepVerdict({ status: 'failed', startedAt: '2026-09-04T10:30:26Z', finishedAt: '2026-09-04T10:35:00Z' }, ok, now), 'expired')
  // 旧档无 finishedAt：回退 startedAt，同样超期
  assert.equal(genJobSweepVerdict({ status: 'done', startedAt: '2026-09-04T10:30:26Z' }, ok, now), 'expired')
  // 窗口内的终态保留
  assert.equal(genJobSweepVerdict({ status: 'failed', startedAt: '2026-09-11T01:00:00Z', finishedAt: '2026-09-11T01:01:00Z' }, ok, now), 'keep')
  // 排队/在途再久也不按保留期清——它们的出口是悬空判定
  assert.equal(genJobSweepVerdict({ status: 'queued', startedAt: '2026-09-01T00:00:00Z' }, ok, now), 'keep')
  assert.equal(genJobSweepVerdict({ status: 'running', startedAt: '2026-09-01T00:00:00Z' }, ok, now), 'keep')
})

test('保留期剩余时长：finishedAt 起算、超期归零（恢复补挂定时器用）', () => {
  const now = Date.parse('2026-09-11T08:00:00Z')
  const twoHoursAgo = '2026-09-11T06:00:00Z'
  assert.equal(
    genJobRetentionRemainingMs({ status: 'failed', startedAt: '2026-09-11T05:00:00Z', finishedAt: twoHoursAgo }, now),
    22 * HOUR,
  )
  assert.equal(genJobRetentionRemainingMs({ status: 'done', startedAt: '2026-09-11T05:00:00Z', finishedAt: twoHoursAgo }, now), 0)
  // 旧档无 finishedAt：回退 startedAt
  assert.equal(genJobRetentionRemainingMs({ status: 'failed', startedAt: twoHoursAgo }, now), 22 * HOUR)
})
