// 快照再生成（#182 各批次随删转发演进；提交前删除本文件）
import { readFileSync, writeFileSync } from 'node:fs'
import { runToolProbes } from './tools-probe.ts'
import { runProbes } from './routes-probe.ts'

const TOOLS = new URL('../fixtures/host-tools-behavior.json', import.meta.url)
const SNAP = JSON.parse(readFileSync(TOOLS, 'utf8'))
const gotT = await runToolProbes(SNAP.map(s => ({ id: s.id, tool: s.tool, args: s.args, queued: s.queued })))
const outT = SNAP.map((s, i) => {
  const g = gotT[i]!
  return { id: s.id, tool: s.tool, args: s.args, ...(s.queued !== undefined ? { queued: s.queued } : {}), text: g.text, ...(g.error !== undefined ? { error: g.error } : {}), calls: g.calls }
})
writeFileSync(TOOLS, JSON.stringify(outT, null, 1) + '\n')
let tc = 0
for (let i = 0; i < SNAP.length; i++) if (JSON.stringify(SNAP[i].calls) !== JSON.stringify(outT[i].calls)) tc++
console.log('tools snapshot:', outT.length, 'entries; calls 变化', tc)

const ROUTES = new URL('../fixtures/host-routes-snapshot.json', import.meta.url)
const RS = JSON.parse(readFileSync(ROUTES, 'utf8'))
const gotR = await runProbes(RS.map(s => ({ method: s.method, url: s.url, ...(s.body !== undefined ? { body: s.body } : {}) })))
let rc = 0, sd = 0
const outR = RS.map((s, i) => {
  const g = gotR[i]!
  if (g.status !== s.status) sd++
  if (JSON.stringify(s.calls) !== JSON.stringify(g.calls)) rc++
  return { ...s, status: g.status, res: g.res, calls: g.calls }
})
writeFileSync(ROUTES, JSON.stringify(outR, null, 1) + '\n')
console.log('routes snapshot:', outR.length, 'entries; calls 变化', rc, '; status 漂移', sd)
