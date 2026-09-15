/**
 * 闭包折叠单一出处扫描（#270 门 G10；ADR-0085 §防复发门）：
 * **图遍历闭包的原语只住 Graph（`src/engine/graph.ts`）**。
 *
 * 「前置传递闭包 / 祖先集」的正解是 `Graph.upstreamClosure`（悬空容错 + 环口径与
 * isAncestor 同步）与 `Graph.taughtByOf`/`assumedByOf`（构造期反向映射）。历史上四处
 * 各自手写折叠（#264/#265 实测事故：环图上 isAncestor 恒 false → 概念足迹/投影静默
 * 清零），#270 收成一处后立本门拦两类复发形态：
 *
 *   C1a  `.names.filter(…isAncestor…)`          —— names 全扫求祖先集（环上恒空的旧病）
 *   C1b  `for (const x of ….names)` 循环体含 isAncestor —— 同上的循环写法
 *   C2   `for (… of ….preOf[…])` 与 `queue.shift()` 同文件 —— 手写 preOf BFS（闭包请走原语；
 *        preOf 的普通属性读取不算——只认迭代头）
 *
 * 豁免是**紧的**：`graph.ts` 是原语自己的家（定义处不算手写）；
 * `graph-subsystem.ts` 的 `graphPath` 是带 parent 回溯的**链查询**（要路径不要集合，
 * #270 已补悬空守卫），登记白名单。isAncestor 的**单点判定**（`isAncestor(a, b)`）
 * 是合法用法，不在本门拦截面——门只拦「全图扫出祖先集」的组合形态。
 *
 * 启发式边界（形态门固有局限，靠评审兜底，不静默扩大拦截面）：C2 是**文件级**共现
 * （同文件无关的 for-of preOf 遍历 + queue.shift 会误报，走白名单）；C1a 只看 filter
 * 头 240 字符窗（更深的回调内漏报）；解构别名（`const { isAncestor } = g`）三门全漏。
 *
 * 用法：node scripts/scan-closure.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { strip } from './undefined-scan.mjs'

const SRC_DIR = 'src'

/** 闭包原语之家（定义处不算手写折叠）。 */
export const CLOSURE_PRIMITIVE_HOME = 'src/engine/graph.ts'

/** 白名单：形态像但语义不是「names 筛祖先 / 手写 preOf BFS 求闭包」的文件（带理由）。 */
export const CLOSURE_SCAN_WHITELIST = [
  { file: 'src/engine/graph-subsystem.ts', reason: 'graphPath 带 parent 回溯求前置链（#270），非闭包折叠' },
]

/** C1a：`.names.filter(` 链内 240 字符窗出现 `isAncestor(`（names 全扫求祖先集）。 */
const C1A = /\.names\s*\.\s*filter\s*\([\s\S]{0,240}?isAncestor\s*\(/

/** C1b：for-of `.names` 循环（头匹配 → 大括号平衡提取循环体；无大括号取单语句窗口）。 */
export function forOfNamesBodies(src) {
  const bodies = []
  const re = /for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+[\w.$]*\.names\s*\)/g
  for (const m of src.matchAll(re)) {
    // 头部与循环体之间的空白不影响大括号判定（`for (…) {` 是常态写法）。
    const rest = src.slice(m.index + m[0].length).replace(/^\s+/, '')
    if (rest.startsWith('{')) {
      let depth = 0
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '{') depth++
        else if (rest[i] === '}') { depth--; if (!depth) { bodies.push(rest.slice(0, i + 1)); break } }
      }
    } else {
      // 单语句循环体止于语句边界（`；`或换行）——邻行的合法单点判定不进窗口
      // （审查 Major#1：240 字符裸窗口会把后续代码当循环体，误报门自述豁免的形态）。
      const end = rest.search(/[;\n]/)
      bodies.push(rest.slice(0, end === -1 ? 240 : end))
    }
  }
  return bodies
}

/**
 * 从 `[路径, 源码]` 序列收集闭包折叠嫌疑（原语之家除外）。
 * 纯函数，自检可喂假样本；**剥注释与字符串后**再匹配（注释里提一句形态不该触门）。
 */
export function closureFoldSites(sources) {
  const sites = new Map()
  for (const [rel, code] of sources) {
    const file = rel.split('\\').join('/')
    if (file === CLOSURE_PRIMITIVE_HOME) continue
    const src = strip(code)
    const hits = []
    if (C1A.test(src)) hits.push('C1a names.filter(…isAncestor…) 求祖先集（走 Graph.upstreamClosure）')
    for (const body of forOfNamesBodies(src)) {
      if (/\bisAncestor\s*\(/.test(body)) { hits.push('C1b for-of names 循环体筛 isAncestor（走 Graph.upstreamClosure）'); break }
    }
    // C2 只认「for-of 迭代 preOf」的 BFS 迭代头：preOf[n] 属性读取（schema 构造等）
    // 与无关的 queue.shift 同文件共存不算（analysis.ts 实测误报教训）。
    if (/queue\.shift\(\)/.test(src) && /of\s+[\w.$]*\.preOf\[/.test(src)) {
      hits.push('C2 for-of preOf + queue.shift 手写 BFS（闭包请走 Graph.upstreamClosure）')
    }
    if (hits.length) sites.set(file, hits)
  }
  return sites
}

/** 扫描 src 下全部 .ts／.tsx。 */
export function scanClosureFolds(root = process.cwd(), dir = SRC_DIR) {
  const sources = []
  const walk = rel => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) sources.push([p, readFileSync(join(root, p), 'utf8')])
    }
  }
  walk(dir)
  return closureFoldSites(sources)
}

if (process.argv[1] && process.argv[1].includes('scan-closure')) {
  const sites = scanClosureFolds()
  const rows = [...sites.entries()].sort()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(Object.fromEntries(rows), null, 2))
  } else {
    for (const [f, hits] of rows) {
      const ok = CLOSURE_SCAN_WHITELIST.some(w => w.file === f)
      console.log(`${ok ? '✓' : '✗'} ${f}：${hits.join('; ')}${ok ? '（白名单：' + CLOSURE_SCAN_WHITELIST.find(w => w.file === f).reason + '）' : ''}`)
    }
    if (!rows.length) console.log('✓ 无闭包折叠嫌疑（原语单一出处保持）')
    const bad = rows.filter(([f]) => !CLOSURE_SCAN_WHITELIST.some(w => w.file === f))
    if (bad.length) process.exitCode = 1
  }
}
