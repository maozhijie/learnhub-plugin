/**
 * 类型门测量（#170 / ADR-0047 类型门 G7）：跑 `tsc --noEmit`，按**文件**统计错误数。
 *
 * 为什么是「按文件」而非总数：聚合值会掩盖病灶——一个文件修好、另一个文件变坏，总数不动
 * （ADR-0047 否决「用聚合值代替逐文件基线」同款理由）。基线记「有错的文件」，未列出的文件
 * 即 0 错。
 *
 * 为什么单独一份脚本而不是塞进 tsc 调用点：棘轮机制（精确匹配、过期即失败、幽灵条目自检）
 * 已在 `scripts/arch-baseline.mjs` 定型，本模块只负责**测量**——测量结果进同一份基线文件
 * 的 `typeErrors` 段，不另造一套对照逻辑。
 *
 * `--listFiles` 与诊断同一次调用取回：受控面（tsc 实际读到的 src 文件集）与错误数一起落袋，
 * 门才能断言「扫描面没塌」（R3 恒过的根因是收集器静默收空；单看错误数无法区分「干净」与
 * 「根本没扫」）。
 *
 * 用法：
 *   node scripts/scan-types.mjs            打印逐文件错误数 + 错误码分布
 *   node scripts/scan-types.mjs --json     打印 { counts, codes, checked } 原始测量
 * 对照基线的是 `npm run typecheck`（= `scripts/arch-baseline.mjs --types`）：棘轮机制与
 * 基线文件只有那一处，本模块不复制它（单向依赖：arch-baseline → scan-types）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** TypeScript 的 node 可执行入口（跨平台：不走 .bin 的 cmd 外壳）。 */
export const TSC_ENTRY = ['node_modules', 'typescript', 'bin', 'tsc']

/** 定位到的诊断形态：`src/x.ts(12,3): error TS2304: ...`。 */
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+):/

const toPosix = p => p.split('\\').join('/')

/**
 * tsc 文本输出（`--pretty false --listFiles`）→ `{ counts, codes, checked }`。
 * **纯函数**：自检可喂假样本。`checked` 只取 root 下的文件（node_modules 与 lib.*.d.ts 排除）。
 */
export function parseTscOutput(text, root = process.cwd()) {
  const counts = {}
  const codes = {}
  const checked = new Set()
  const unpositioned = []
  const rootPosix = toPosix(root).replace(/\/$/, '') + '/'
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const m = DIAGNOSTIC.exec(line)
    if (m) {
      if (m[4] !== 'error') continue
      const file = toPosix(m[1])
      counts[file] = (counts[file] ?? 0) + 1
      codes[m[5]] = (codes[m[5]] ?? 0) + 1
      continue
    }
    // 无文件位置的 `error TSxxxx`（tsconfig 坏、参数错）：不是逐文件诊断，单独回报
    if (/^error TS\d+:/.test(line)) { unpositioned.push(line); continue }
    // --listFiles 的行：绝对路径（含 .ts／.tsx／.d.ts）
    if (!/\.(ts|tsx)$/.test(line) || !/[\\/]/.test(line)) continue
    const abs = toPosix(line)
    if (abs.startsWith(rootPosix)) checked.add(abs.slice(rootPosix.length))
  }
  return { counts, codes, checked: [...checked].sort(), unpositioned }
}

let cached = null

/** 跑一次 tsc（同进程内按 root 记忆化：门内多处取用只付一次编译）。 */
export function scanTypes(root = process.cwd()) {
  if (cached && cached.root === root) return cached.value
  const bin = join(root, ...TSC_ENTRY)
  if (!existsSync(bin)) {
    throw new Error(`找不到 ${TSC_ENTRY.join('/')}——typescript 是 devDependency，先 npm install。`)
  }
  let out = ''
  let failed = false
  try {
    out = execFileSync(process.execPath, [bin, '--noEmit', '--pretty', 'false', '--listFiles'], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    // 有类型错误时 tsc 退出码非 0——诊断在 stdout，配置/参数问题在 stderr
    if (err.stdout && DIAGNOSTIC.test(err.stdout)) out = err.stdout
    else { failed = true; out = `${err.stderr ?? ''}\n${err.stdout ?? ''}` }
  }
  const parsed = parseTscOutput(out, root)
  // 无文件位置的 `error TSxxxx`（tsconfig 坏、参数错）必须硬失败：
  // 返回空 counts 会被当成「全修好了」，正是恒过门的样子。
  if (parsed.unpositioned.length) {
    throw new Error(`tsc 报了无文件位置的错误（配置/参数问题）：\n${parsed.unpositioned.join('\n')}`)
  }
  if (failed) throw new Error(`tsc 未能完成：\n${out.slice(0, 4000)}`)
  const value = { counts: parsed.counts, codes: parsed.codes, checked: parsed.checked }
  cached = { root, value }
  return value
}

/** 受控面（tsc 实际读到的 src 文件集）——门断言「扫描面没塌」用。 */
export function checkedSrc(measured) {
  return measured.checked.filter(f => f.startsWith('src/'))
}

if (process.argv[1] && process.argv[1].includes('scan-types')) {
  const measured = scanTypes(process.cwd())
  const summary = `（合计 ${Object.values(measured.counts).reduce((s, n) => s + n, 0)} 处 / ${Object.keys(measured.counts).length} 个涉错文件；受控面 src/ 共 ${checkedSrc(measured).length} 个文件被 tsc 读到）`
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(measured, null, 2))
  } else {
    const codes = Object.entries(measured.codes).sort((a, b) => b[1] - a[1])
    for (const [f, n] of Object.entries(measured.counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      console.log(`${String(n).padStart(4)}  ${f}`)
    }
    console.log(`\n错误码：${codes.map(([c, n]) => `${c} ×${n}`).join('、') || '（无）'}`)
    console.log(summary)
    console.log('（对照基线：npm run typecheck）')
  }
}
