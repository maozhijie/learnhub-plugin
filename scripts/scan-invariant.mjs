/**
 * 顶层不变量扫描（#165 门 G6；ADR-0044）：**只有教练层能改图**。
 *
 * 判据取「谁能调用图写原语」：`GraphStore.writeRegionDoc`（`graph.ts`，`data/*.yaml`
 * 的唯一写原语）的调用者只准是 `proposals.ts`（`applyEdit`／`applySeed` 的落图处，
 * 即教练层的提案门）。其余任何模块直接调用它 = 绕过提案门改图，门即失败。
 *
 * 白名单是**紧的**：`proposals.ts` 一处。`graphApply('enrich')` 从 `growth-subsystem.ts`
 * ／`projects.ts` 直调 `proposals.*` 属提案门内的教练层行为，不触本门（ADR-0044 已登记）。
 * 定义处（`graph.ts`）不算调用者——它是原语自己的家。
 *
 * 用法：node scripts/scan-invariant.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { strip } from './undefined-scan.mjs'

const SRC_DIR = 'src'

/** 图写原语与其定义处（新增原语时两处一起加：原语名 + 它所在的模块）。 */
export const GRAPH_WRITE_PRIMITIVES = [
  { name: 'writeRegionDoc', definedIn: 'src/engine/graph.ts' },
]

/** 唯一允许调用图写原语的模块（教练层提案门）。 */
export const GRAPH_WRITE_WHITELIST = ['src/engine/proposals.ts']

/**
 * 从 `[路径, 源码]` 序列里收集图写原语的调用者（定义处除外）。
 * 纯函数，自检可喂假样本；**剥注释与字符串后**再匹配（注释里提一句原语名不该触门）。
 */
export function graphWriteCallers(sources) {
  const callers = new Map()
  for (const [rel, code] of sources) {
    const file = rel.split('\\').join('/')
    const src = strip(code)
    const hits = []
    for (const prim of GRAPH_WRITE_PRIMITIVES) {
      if (file === prim.definedIn) continue
      // 调用形态：`x.writeRegionDoc(`
      if (new RegExp(`\\.${prim.name}\\s*\\(`).test(src)) hits.push(prim.name)
      // 解构别名（`const { writeRegionDoc } = store`）同属调用面
      else if (new RegExp(`[{,]\\s*${prim.name}\\s*[,}]`).test(src)) hits.push(`${prim.name}(解构)`)
    }
    if (hits.length) callers.set(file, hits)
  }
  return callers
}

/** 扫描 src 下全部 .ts／.tsx。 */
export function scanGraphWriters(root = process.cwd(), dir = SRC_DIR) {
  const sources = []
  const walk = rel => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) sources.push([p, readFileSync(join(root, p), 'utf8')])
    }
  }
  walk(dir)
  return graphWriteCallers(sources)
}

if (process.argv[1] && process.argv[1].includes('scan-invariant')) {
  const callers = scanGraphWriters()
  const rows = [...callers.entries()].sort()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(Object.fromEntries(rows), null, 2))
  } else {
    for (const [f, prims] of rows) {
      const ok = GRAPH_WRITE_WHITELIST.includes(f)
      console.log(`${ok ? '✓' : '✗'} ${f}：${prims.join(', ')}${ok ? '（教练层提案门）' : '（白名单外调用图写原语）'}`)
    }
    const bad = rows.filter(([f]) => !GRAPH_WRITE_WHITELIST.includes(f))
    if (bad.length) process.exitCode = 1
  }
}
