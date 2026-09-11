/**
 * UI 公共面门（#169 / ADR-0045 裁定 7）：类型检查本身在 `npm run typecheck` 里
 * （`scripts/scan-ui-types.mjs`，串行跑一次 tsc——塞进并行的 `node --test` 会抢资源、实测偶发失败）。
 * 本文件只断言两件**便宜且关键**的事：调用点零改动，以及「引擎形状手工镜像已收口」这个不变式。
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
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

test('UI 形状收口：引擎形状手工镜像已清零（响应类型一律从注册表 output 派生）', () => {
  const text = readFileSync(join(ROOT, 'ui', 'src', 'types.ts'), 'utf8')
  // 旧形态：按引擎 schema 手抄的 interface（`export interface X { ... }`）。收口后本文件只剩
  // UI 本地词汇（Stage/ContentStatus/LlmView/StatusWithLlm/AgentGuideItem）与一处有理由的复合响应
  // （/experiments 多入口，组成仍派生）。任何新的手抄 interface 都会被这条挡住。
  const local = [...text.matchAll(/^export interface (\w+)/gm)].map(m => m[1]!)
  assert.deepEqual(local.sort(), ['AgentGuideItem', 'ExperimentsDoc', 'LlmView'].sort(),
    `ui/src/types.ts 又多出手写 interface（引擎形状该从 output 派生）：${local.join(', ')}`)
  assert.ok(text.includes("from '../../src/commands/index'"), '派生入口（注册表）不在了')
})
