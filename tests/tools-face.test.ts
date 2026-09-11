/**
 * 工具面行为探针（#169 的门⑦·agent 侧）：111 个工具的**行为**（返回文本 + 响应前的引擎
 * 调用序列）相对注册表切面之前逐字不变。
 *
 * 快照 tests/fixtures/host-tools-behavior.json 由切面前的实现捕获（259 条探针：每个工具
 * 全参一次 + 逐个缺必填一次），与路由面的 464 条探针同款：注册表切面后必须逐字复现。
 * 队列型工具只比文本（响应后的 fire-and-forget 调用序列不钉，见 helpers/tools-probe.ts）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupToolProbeVault, runToolProbes } from './helpers/tools-probe.ts'
import type { ToolProbe } from './helpers/tools-probe.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'host-tools-behavior.json'), 'utf8')) as
  Array<ToolProbe & { text: string; error?: string; calls: string[] }>

test('门⑦·agent 侧：259 条工具探针的文本与引擎调用序列与切面之前逐字一致', async () => {
  assert.ok(SNAPSHOT.length >= 250, `探针快照只剩 ${SNAPSHOT.length} 条（扫描面塌了）`)
  const probes: ToolProbe[] = SNAPSHOT.map(s => ({ id: s.id, tool: s.tool, args: s.args, queued: s.queued }))
  const got = await runToolProbes(probes)
  const diffs: string[] = []
  for (let i = 0; i < probes.length; i++) {
    const want = SNAPSHOT[i]!
    const now = got[i]!
    if (now.text !== want.text || now.error !== want.error || JSON.stringify(now.calls) !== JSON.stringify(want.calls)) {
      diffs.push(`  · ${want.id}\n    期望 text=${JSON.stringify(want.text).slice(0, 120)} error=${want.error ?? '—'} calls=${JSON.stringify(want.calls)}\n`
        + `    实得 text=${JSON.stringify(now.text).slice(0, 120)} error=${now.error ?? '—'} calls=${JSON.stringify(now.calls)}`)
    }
  }
  assert.deepEqual(diffs, [], `工具面行为相对切面之前漂移（${diffs.length} 条）：\n${diffs.join('\n')}`)
})

test.after(() => { cleanupToolProbeVault() })
