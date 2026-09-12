/**
 * L2 冒烟渲染门的 .tsx 加载钩子（#183 / ADR-0051 第一层零新增依赖）。
 *
 * Node 24 原生 TS 直跑不支持 JSX（.tsx 直接 ERR_UNKNOWN_FILE_EXTENSION，2026-09-12 实测），
 * 而 L2 要在 node:test 里 renderToStaticMarkup 渲染 ui/src 的页面组件。本钩子用**已在
 * devDependencies 里的 typescript 包**（G7 类型门同款、版本已锁）对 .tsx 做内存转译
 * （jsx: react-jsx），不落盘、不加构建步骤、不引第二个 runner——类型剥离之外只有 JSX
 * 一件事被翻译，与 node --experimental-transform-types 的职责互补。
 *
 * 只拦截 ui/src 下的 .tsx；其余（.ts、依赖包）一律走默认链。消费方 tests/ui-smoke.test.ts
 * 与 tests/ui-router.test.ts（resolve 钩子：ui/src 相对导入不带扩展名，node ESM 补后缀）
 * 用 node:module 的 register() 挂载（只影响其后发生的动态 import，故被测模块必须动态加载）；
 * 转译正确性由该门的自检探针（必然崩溃样本 + 12 项真实渲染）逐次全量行使。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const tsOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
}

export async function load(url, context, nextLoad) {
  // 依赖包里的 .css（mafs/katex 等带样式导入）：vite 才消费，SSR 渲染零消费——空模块替代
  if (/\.css($|\?)/.test(url)) {
    return { format: 'module', source: '', shortCircuit: true }
  }
  if (!url.startsWith('file:') || !/\/ui\/src\/.+\.tsx($|\?)/.test(url)) {
    return nextLoad(url, context)
  }
  const path = fileURLToPath(url)
  const src = readFileSync(path, 'utf8')
  const out = ts.transpileModule(src, { compilerOptions: tsOptions, fileName: path })
  return { format: 'module', source: out.outputText, shortCircuit: true }
}

// ui/src 按 vite 的 bundler 风格写相对导入（不带扩展名）——node ESM 解析不了，
// 这里补后缀重试（先试默认链，失败才补 .tsx/.ts/index；ui/src 之外零影响）。
const SUFFIXES = ['.tsx', '.ts', '/index.tsx', '/index.ts']

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('.')) return nextResolve(specifier, context)
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    for (const suffix of SUFFIXES) {
      try {
        return await nextResolve(specifier + suffix, context)
      } catch {
        // 试下一个后缀
      }
    }
    throw err
  }
}
