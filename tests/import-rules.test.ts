/**
 * 分层依赖规则执法（#152 刀 1 / ADR-0042）：收集 src 下全部 .ts 的相对 import
 * （静态 import、import type、侧效 import、export … from、动态 import()），
 * 按七条规则断言——
 *   R1 host(src/index.ts) 的 engine 相对导入只准解析到 engine/index.ts；
 *   R2 engine 目录禁 import 宿主 src/index.ts；
 *   R3 engine 目录禁 import @deepseek-ai/*；
 *   R4 views.ts 所有 import 必须是 import type（views 纯类型）；
 *   R5 io.ts 零相对导入（零领域依赖叶子）；
 *   R6 engine 目录内零文件 import engine/index.ts（门面是唯一汇点，子系统不回引门面）；
 *   R7 src 相对 import 全图零环（含 type-only 边；与 R5 联合锁死 store⇄receipts
 *      类类型环不复发）。
 * eslint-boundaries / dependency-cruiser 的零依赖替身：node:test 原生跑进 npm test。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const HOST = join(SRC, 'index.ts')
const ENGINE = join(SRC, 'engine')
const ENGINE_INDEX = join(ENGINE, 'index.ts')
const VIEWS = join(ENGINE, 'views.ts')
const IO = join(ENGINE, 'io.ts')

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.name.endsWith('.ts')) yield p
  }
}

/** 全部说明符（含裸包名与 @scoped：R3 需要看见 @deepseek-ai/*；其余规则只用相对项）。 */
function allSpecs(code: string): string[] {
  const specs: string[] = []
  for (const m of code.matchAll(/from\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.push(m[1])
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  return specs
}

/** 相对导入收集（说明符原文）：静态（含 import type）与 export … from 的
 * `from '<spec>'` 形态 + 侧效 `import '<spec>'` + 动态 `import('<spec>')`。 */
function relativeSpecs(code: string): string[] {
  return allSpecs(code).filter(s => s.startsWith('.'))
}

/** 相对说明符解析：带 .ts 直用 → 否则补 .ts → 否则补 /index.ts。后两级是兜底（目录导入、
 * 无扩展名写法）：`#170` 起 engine 内说明符一律带 `.ts`（nodenext 类型门的要求），
 * 兜底留着好让写错扩展名的新文件仍被解析到、而不是被当成「无此依赖」静默放过。
 * 解析不到返回 null。 */
function resolveSpec(fromFile: string, spec: string): string | null {
  const abs = resolve(dirname(fromFile), spec)
  if (existsSync(abs) && statSync(abs).isFile()) return abs
  if (existsSync(abs + '.ts')) return abs + '.ts'
  const idx = join(abs, 'index.ts')
  if (existsSync(idx)) return idx
  return null
}

const inDir = (file: string, dir: string) => file.startsWith(dir + sep)
const display = (file: string) => file.slice(SRC.length + 1)

const files = [...walk(SRC)]
const allSpecsOf = new Map(files.map(f => [f, allSpecs(String(readFileSync(f, 'utf8')))]))
const importsOf = new Map(files.map(f => [f, relativeSpecs(String(readFileSync(f, 'utf8')))]))

function resolvedEdges(file: string): Array<{ spec: string; resolved: string }> {
  const out: Array<{ spec: string; resolved: string }> = []
  for (const spec of importsOf.get(file) ?? []) {
    const resolved = resolveSpec(file, spec)
    assert.notEqual(resolved, null, `[rules] ${display(file)} 的相对导入 '${spec}' 解析不到文件`)
    if (resolved!.startsWith(SRC + sep)) out.push({ spec, resolved: resolved! })
  }
  return out
}

test('R1 host 的 engine 导入只走门面', () => {
  for (const { spec, resolved } of resolvedEdges(HOST)) {
    if (inDir(resolved, ENGINE)) {
      assert.equal(resolved, ENGINE_INDEX, `[R1] 宿主深导入 '${spec}' → ${display(resolved)}；只准从 engine/index.ts 取（D14）`)
    }
  }
})

test('R2 engine 禁 import 宿主', () => {
  for (const file of files) {
    if (!inDir(file, ENGINE)) continue
    for (const { spec, resolved } of resolvedEdges(file)) {
      assert.notEqual(resolved, HOST, `[R2] ${display(file)} ← '${spec}'：engine 不得依赖宿主`)
    }
  }
})

test('R3 engine 禁 import @deepseek-ai/*', () => {
  // 自检：收集器必须真能看见裸包/作用域包——否则本规则恒过（等于没执法，实测曾如此）
  assert.ok(allSpecs("import { x } from '@deepseek-ai/dsh-llm'").includes('@deepseek-ai/dsh-llm'),
    '[R3 自检] 说明符收集漏掉裸包名，规则形同虚设')
  assert.equal(relativeSpecs("import { x } from '@deepseek-ai/dsh-llm'").length, 0, '[R3 自检] 相对收集不应含裸包名')
  for (const file of files) {
    if (!inDir(file, ENGINE)) continue
    for (const spec of allSpecsOf.get(file) ?? []) {
      assert.ok(!spec.startsWith('@deepseek-ai/'), `[R3] ${display(file)} ← '${spec}'：引擎零宿主私有依赖（缝型自带）`)
    }
  }
})

test('R4 views.ts 纯类型', () => {
  const code = String(readFileSync(VIEWS, 'utf8'))
  const violations: string[] = []
  for (const m of code.matchAll(/^import\s+(?!type\b)/gm)) violations.push(`非 type import：${m[0].trim()}`)
  for (const m of code.matchAll(/^export\s*\{/gm)) violations.push('值 re-export：export { … }')
  for (const m of code.matchAll(/^export\s+\*/gm)) violations.push('星号 re-export：export * from …')
  assert.deepEqual(violations, [], `[R4] views.ts 只准 import type / export type（违规 ${violations.length} 处）`)
})

test('R5 io.ts 零领域依赖叶子', () => {
  const specs = importsOf.get(IO) ?? []
  assert.deepEqual(specs, [], `[R5] io.ts 只准 import node:*/npm，发现相对导入：${specs.join(', ')}`)
})

test('R6 门面唯一汇点：engine 子模块不回引 engine/index.ts', () => {
  for (const file of files) {
    if (!inDir(file, ENGINE) || file === ENGINE_INDEX) continue
    for (const { spec, resolved } of resolvedEdges(file)) {
      assert.notEqual(resolved, ENGINE_INDEX, `[R6] ${display(file)} ← '${spec}'：子系统不回引门面（跨子系统调用回引门面的类型面 Pick<…> 由门面传入，不 import）`)
    }
  }
})

test('R7 src 相对 import 全图零环（含 type-only 边）', () => {
  const graph = new Map(files.map(f => [f, resolvedEdges(f).map(e => e.resolved)]))
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map(files.map(f => [f, WHITE]))
  const stack: string[] = []
  const cycles: string[] = []
  const visit = (file: string): void => {
    color.set(file, GRAY)
    stack.push(file)
    for (const next of graph.get(file) ?? []) {
      const c = color.get(next)!
      if (c === GRAY) {
        const i = stack.indexOf(next)
        cycles.push([...stack.slice(i), next].map(display).join(' → '))
      } else if (c === WHITE) {
        visit(next)
      }
    }
    stack.pop()
    color.set(file, BLACK)
  }
  for (const f of files) if (color.get(f) === WHITE) visit(f)
  assert.deepEqual(cycles, [], `[R7] src 相对 import 存在环：\n${cycles.join('\n')}`)
})
