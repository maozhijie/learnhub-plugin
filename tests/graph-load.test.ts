import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../src/engine/graph.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'

// 图加载的两类缺失拆开报（#61 排查误导教训）：「目录不存在」（建课前/课程被挪走）
// 与「目录在但零 .yaml」（真异常）曾是同一句「为空或不存在」——排查方向直接被带偏
// （现场第一反应是 vault 挪了位置）。

test('GraphStore.load：data 目录不存在与目录为空分别报因，不再合并成一句', async () => {
  const base = await mkdtemp(join(tmpdir(), 'learnhub-graphload-'))
  try {
    const missing = new GraphStore(null as never, join(base, '没有课程'), nodeVaultFs)
    await assert.rejects(() => missing.load(), (err: Error) => {
      assert.match(err.message, /数据目录不存在: /)
      assert.doesNotMatch(err.message, /为空/, '旧合并文案必须退役')
      return true
    })

    const emptyRoot = join(base, '空课程')
    await mkdir(join(emptyRoot, 'data'), { recursive: true })
    const empty = new GraphStore(null as never, emptyRoot, nodeVaultFs)
    await assert.rejects(() => empty.load(), /数据目录为空（没有 \.yaml 区文件）: /)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
