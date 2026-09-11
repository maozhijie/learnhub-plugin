/**
 * 宿主模块级可变状态扫描（#167 门 G2c；ADR-0048）。
 *
 * 受控面：**动态发现**的宿主文件 = `src/index.ts` + `src/host/` 下全部 `.ts`（递归）。
 * 动态而非硬编码清单——`src/host/` 新增文件必须自动进面，否则新文件里的模块级 `let`
 * 会静默逃过门（R3 曾因收集器收空而恒过；同族教训：门的扫描面本身要被断言没塌）。
 *
 * 判据：行首（可带 `export `）的 `let` 即模块级；缩进的 `let` 是函数局部，不误伤。
 * `const` 放行——ADR-0048 只把「可变态」收进 runtime，常量表（AGENT_GUIDE /
 * GRAPH_JOB_PHASES / LOG_LIMIT / API / PAGE）留在模块级是设计。
 *
 * 用法：node scripts/scan-host-state.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const HOST_DIR = 'src/host'

const toPosix = rel => rel.split('\\').join('/')

/** 宿主受控面（动态发现）：src/index.ts + src/host/**\/*.ts，字典序稳定。 */
export function hostFiles(root = '.') {
  const out = ['src/index.ts']
  const walk = dir => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (e.name.endsWith('.ts')) out.push(toPosix(rel))
    }
  }
  walk(HOST_DIR)
  return out.sort()
}

/** 纯判据：模块级 `let` 的变量名（行首可带 `export `；缩进的不算）。 */
export function moduleLevelLets(code) {
  return [...code.matchAll(/^(?:export\s+)?let\s+(\w+)/gm)].map(m => m[1])
}

/** 扫描宿主受控面，返回每个文件的模块级 `let` 名单（空数组 = 干净）。 */
export function scanHostLets(root = '.') {
  return hostFiles(root).map(rel => ({ file: rel, names: moduleLevelLets(readFileSync(join(root, rel), 'utf8')) }))
}

if (process.argv[1] && process.argv[1].includes('scan-host-state')) {
  const rows = scanHostLets()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 1))
  } else {
    const bad = rows.filter(r => r.names.length)
    for (const r of rows) console.log(`${r.names.length ? '✗' : '✓'} ${r.file}：${r.names.join(', ') || '（无模块级 let）'}`)
    if (bad.length) process.exitCode = 1
  }
}
