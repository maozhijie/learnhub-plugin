/**
 * 文件规模预算扫描（#165 门 G5；ADR-0044 / ADR-0047）。
 *
 * 受控面：`src/` 下全部 .ts／.tsx，逐文件行数进基线（冻结在现状不涨）。
 * 行数口径＝`wc -l`：换行符计数（末尾换行不算额外一行）。
 *
 * 白名单（不计入受控面，理由随条目写在代码里，门会断言每条白名单至少命中一个文件——
 * 白名单本身也可能是幽灵）：
 *   - `src/engine/views/`：views 叶子类型面（ADR-0043 的归档形态；UI 同源消费，
 *     随引擎视图增减而增减，长度不是病灶信号）
 *   - `src/engine/types.ts`：跨模块共享类型与**枚举大表**（STAGES／BLOOM_LEVELS／
 *     CONCEPT_TIERS／PROPOSAL_KINDS／GROWTH_OPERATORS／NOF1_VARIABLE_WHITELIST…）
 *
 * 用法：node scripts/scan-budget.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const SRC_DIR = 'src'

/** 白名单：`prefix` 目录前缀或 `exact` 单文件；`reason` 是准入理由（进 ADR/README 的同一份口径）。 */
export const SIZE_WHITELIST = [
  { prefix: 'src/engine/views/', reason: 'views 叶子类型面（ADR-0043 归档形态）' },
  { exact: 'src/engine/types.ts', reason: '共享类型与枚举大表' },
]

/** 行数口径＝`wc -l`。 */
export function countLines(code) {
  return code.split('\n').length - (code.endsWith('\n') ? 1 : 0)
}

const toPosix = rel => rel.split('\\').join('/')

/** 单条白名单是否覆盖某文件（`isWhitelisted` 与 `whitelistHits` 共用的唯一判据）。 */
export function matchesWhitelist(entry, rel) {
  const norm = toPosix(rel)
  return entry.exact ? norm === entry.exact : norm.startsWith(entry.prefix)
}

export function isWhitelisted(rel) {
  return SIZE_WHITELIST.some(w => matchesWhitelist(w, rel))
}

/** src 下全部 `.ts`／`.tsx`（含白名单；自检白名单是否为幽灵要用全集）。 */
export function srcFiles(root = process.cwd(), dir = SRC_DIR) {
  const out = []
  const walk = rel => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) out.push(toPosix(p))
    }
  }
  walk(dir)
  return out.sort()
}

/** 白名单命中（自检用：每条白名单至少要命中一个真实文件）。 */
export function whitelistHits(files) {
  return SIZE_WHITELIST.map(w => ({
    entry: w.exact ?? w.prefix,
    reason: w.reason,
    hits: files.filter(f => matchesWhitelist(w, f)).length,
  }))
}

/** 受控文件清单（白名单在外），按路径排序。 */
export function controlledFiles(root = process.cwd(), dir = SRC_DIR) {
  return srcFiles(root, dir).filter(f => !isWhitelisted(f))
}

/** 逐文件行数（受控面）；`files` 可覆盖（自检用假样本）。 */
export function scanSizes(root = process.cwd(), files = controlledFiles(root)) {
  const out = {}
  for (const rel of files) out[toPosix(rel)] = countLines(readFileSync(join(root, rel), 'utf8'))
  return out
}

if (process.argv[1] && process.argv[1].includes('scan-budget')) {
  const root = process.cwd()
  const sizes = scanSizes(root)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(sizes, null, 2))
  } else {
    const rows = Object.entries(sizes).sort((a, b) => b[1] - a[1])
    for (const [f, n] of rows) console.log(`${String(n).padStart(5)}  ${f}`)
    for (const w of whitelistHits(srcFiles(root))) console.log(`白名单 ${w.entry}：命中 ${w.hits} 个文件（${w.reason}）`)
    console.log(`共 ${rows.length} 个受控文件（白名单在外）`)
  }
}
