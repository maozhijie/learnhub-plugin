import test from 'node:test'
import assert from 'node:assert/strict'
import { atomicWrite } from '../src/engine/infra/io.ts'
import type { VaultFs } from '../src/engine/index.ts'

// ---- atomicWrite：同毫秒并发写同一路径（tmp 名碰撞回归）----
// 事故（2026-09-17）：tmp 名 = `${path}.tmp-${pid}-${Date.now()}` 只到毫秒；宿主队列终态
// 落盘是 fire-and-forget，finally 里 persistGenJobs 与 scheduleJobRetention→persistGenJobs
// 同步连发两笔，落进同一毫秒时 tmp 同名——先 rename 者把 tmp 搬走，输家 rename ENOENT，
// #296 之后落盘失败会上写回闸，生成队列就此误锁 broken（终档其实已由赢家写成）。
// 回归：冻结时钟强制同毫秒 + 内存 fs（rename 忠于真实 fs——源不存在即 ENOENT）锁步交错，
// 两笔并发 atomicWrite 必须双双成功、终档在场、不留 tmp 残留。

const memFs = (): VaultFs & { names: () => string[] } => {
  const files = new Map<string, string>()
  const tick = () => Promise.resolve()
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  return {
    names: () => [...files.keys()],
    readFile: async p => { await tick(); const v = files.get(p); if (v === undefined) throw enoent(p); return v },
    readFileSync: p => { const v = files.get(p); if (v === undefined) throw enoent(p); return v },
    exists: p => files.has(p),
    mkdir: async () => { await tick() },
    readdir: async () => { await tick(); return [] },
    readdirTypes: async () => { await tick(); return [] },
    appendFile: async () => { await tick() },
    writeFile: async (p, d) => { await tick(); files.set(p, d) },
    rename: async (from, to) => {
      await tick()
      const v = files.get(from)
      if (v === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`), { code: 'ENOENT' })
      files.delete(from)
      files.set(to, v)
    },
    unlink: async p => { await tick(); files.delete(p) },
    statIsFile: async () => { await tick(); return true },
    statMtimeMs: async () => { await tick(); return 0 },
  }
}

test('atomicWrite：同毫秒并发写同一路径，两笔都必须成功（tmp 名不得撞车）', async () => {
  const realNow = Date.now
  Date.now = () => 1789625080055 // 生产事故的 tmp 时间戳：冻结 = 强制同毫秒
  try {
    for (let i = 0; i < 20; i++) {
      const fs = memFs()
      const results = await Promise.allSettled([
        atomicWrite('/v/state/生成任务.json', 'A', fs),
        atomicWrite('/v/state/生成任务.json', 'B', fs),
      ])
      assert.deepEqual(
        results.map(r => r.status), ['fulfilled', 'fulfilled'],
        `并发 atomicWrite 有输家：${results.filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason)).join('；')}`,
      )
      assert.equal(fs.exists('/v/state/生成任务.json'), true, '终档必须由其中一笔写成')
      assert.ok(fs.names().every(n => !n.includes('.tmp-')), '成功后不得残留 tmp 文件')
    }
  } finally {
    Date.now = realNow
  }
})
