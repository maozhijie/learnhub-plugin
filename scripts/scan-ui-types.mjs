/**
 * UI 类型门测量（#169 / ADR-0045 裁定 7）：跑 `tsc -p ui/tsconfig.json`，**只断言 ui/src 自身**。
 *
 * 为什么只断言 ui/src：UI 的响应类型从命令注册表的 `output` 派生（`CommandOutput<id>`），
 * 于是 UI 的类型程序必然把宿主/引擎源码作为**类型依赖**拉进来。那些文件是按根 tsconfig
 * （strict: false）写的，用 UI 自己的 strict: true 去诊断它们只会得到一堆与 UI 无关的存量债——
 * 它们的严格化属于根类型门（另开票）。依赖侧的错数**照实打印**，不参与退出码。
 *
 * 放在 `npm run typecheck` 里（串行、测试之前）而不是测试里：一次 tsc ≈ 7s，塞进并行的
 * `node --test` 会与带定时器的测试抢资源，实测出现过偶发失败。
 *
 * 用法：node scripts/scan-ui-types.mjs
 */
import { execFileSync } from 'node:child_process'

let out = ''
try {
  out = execFileSync('npx', ['tsc', '-p', 'ui/tsconfig.json', '--noEmit', '--pretty', 'false'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
} catch (err) {
  out = String(err.stdout ?? '')
}
const lines = out.split('\n').filter(l => /error TS\d+/.test(l))
const isUiSrc = l => l.split('(')[0].split(String.fromCharCode(92)).join('/').startsWith('ui/src/')
const uiSrc = lines.filter(isUiSrc)
const deps = lines.filter(l => !isUiSrc(l))
if (deps.length) console.log(`[ui-types] 依赖源码（宿主/引擎）在 UI 的 strict 档下有 ${deps.length} 处存量债——属根类型门职责，不计入本门`)
if (uiSrc.length) {
  console.error(`✗ UI 类型门不符：ui/src 下 ${uiSrc.length} 处错\n${uiSrc.map(l => `  · ${l}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`✓ UI 类型门一致（ui/src 0 错；依赖侧存量债 ${deps.length} 处已报出）`)
}
