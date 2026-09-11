/**
 * UI 类型门（#169 / ADR-0045 裁定 7）：**扫描面 = `ui/src/` 自身**。
 *
 * UI 的响应类型现在从命令注册表的 `output` 派生（`CommandOutput<id>`），
 * 于是 UI 的类型程序必然把宿主/引擎源码作为**类型依赖**拉进来（要门面类型才能派生）。
 * 那些文件是按**根 tsconfig（strict: false）**写的，用 UI 自己的 `strict: true` 去诊断它们
 * 只会得到一堆与 UI 无关的存量债——所以本门只断言 `ui/src/` 下 0 错，
 * 依赖源码的错数照实报出（它们的严格化属于根类型门的事，另开票）。
 *
 * 另一半是「公共面零改动」：`api.<name>(` 调用点数量必须与迁移前一致（139 处）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 跑一次 UI 的 tsc，按文件分拣错误。 */
function uiTypeErrors(): { uiSrc: string[]; deps: string[] } {
  let out = ''
  try {
    out = execFileSync('npx', ['tsc', '-p', 'ui/tsconfig.json', '--noEmit', '--pretty', 'false'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  } catch (err) {
    out = String((err as { stdout?: string }).stdout ?? '')
  }
  const lines = out.split('\n').filter(l => /error TS\d+/.test(l))
  const rel = (l: string) => l.split('(')[0]!.split(String.fromCharCode(92)).join('/')
  return {
    uiSrc: lines.filter(l => rel(l).startsWith('ui/src/')),
    deps: lines.filter(l => !rel(l).startsWith('ui/src/')),
  }
}

test('UI 类型门：ui/src 下 0 错（依赖源码的存量债照实报出，不计入本门）', () => {
  const { uiSrc, deps } = uiTypeErrors()
  if (deps.length) {
    console.warn(`[ui-types] 依赖源码（宿主/引擎）在 UI 的 strict 档下有 ${deps.length} 处存量债——属于根类型门的事，未计入本门`)
  }
  assert.deepEqual(uiSrc, [], `ui/src 下的类型错（响应类型从注册表 output 派生之后的真实漂移）：\n${uiSrc.join('\n')}`)
})

test('UI 公共面零改动：api.<name>( 调用点数量不变（139 处，函数名与签名未动）', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
  const callsites = walk(join(ROOT, 'ui', 'src'))
    .filter(f => !f.endsWith('api.ts'))
    .reduce((n, f) => n + [...readFileSync(f, 'utf8').matchAll(/\bapi\.[A-Za-z_]\w*\s*\(/g)].length, 0)
  assert.equal(callsites, 139, `调用点从 139 漂到 ${callsites}（受影响的文件：${walk(join(ROOT, 'ui', 'src')).join(', ')}）`)
})
