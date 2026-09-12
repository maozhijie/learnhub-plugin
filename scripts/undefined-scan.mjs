/**
 * 未定义标识符扫描核心（#152 后续架构门）：
 * 剥掉注释与字符串后，找出「被当函数调用、但既未声明也未导入」的名字。
 *
 * 动机：宿主无 tsc 门、esbuild 只剥类型不查未定义全局——抽文件时漏掉导出/导入
 * 会静默通过 build，只在运行时炸。本探针是零依赖兜底（tsc 门落地后可退役）。
 *
 * 用法：node scripts/scan-undefined.mjs src/index.ts src/host/*.ts
 */
import { readFileSync } from 'node:fs'

const GLOBALS = new Set(`if else for while return typeof new delete void await yield throw try catch finally
switch case break continue do in of instanceof function const let var this super import export default
async JSON Math Object Array String Number Boolean Date Map Set Promise Error RegExp Symbol BigInt
console process globalThis require setTimeout clearTimeout setInterval clearInterval URL URLSearchParams
AbortController Intl decodeURIComponent encodeURIComponent parseInt parseFloat isNaN isFinite
structuredClone fetch ReadableStream`.split(/\s+/))

/** 剥注释与字符串字面量（保留换行以维持行号不敏感的可读位置）。文本层门共用。 */
export function strip(code) {
  let out = ''
  let i = 0
  while (i < code.length) {
    if (code.startsWith('/*', i)) {
      const j = code.indexOf('*/', i + 2)
      out += ' '
      i = j === -1 ? code.length : j + 2
    } else if (code.startsWith('//', i)) {
      const j = code.indexOf('\n', i)
      i = j === -1 ? code.length : j
    } else if (code[i] === "'" || code[i] === '"' || code[i] === '`') {
      const q = code[i]
      i += 1
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === q) { i += 1; break }
        i += 1
      }
      out += '""'
    } else {
      out += code[i]
      i += 1
    }
  }
  return out
}

function declaredNames(code) {
  const names = new Set()
  const add = re => { for (const m of code.matchAll(re)) names.add(m[1]) }
  add(/\bfunction\s+(\w+)/g)
  add(/\b(?:const|let|var|class)\s+(\w+)/g)
  add(/\b(?:const|let|var)\s+(\w+)\s*=/g)
  add(/import\s+(?:type\s+)?\{([^}]*)\}/g)          // 逗号列表随后拆
  add(/\bimport\s+(\w+)\s+from/g)
  add(/\bcatch\s*\(\s*(\w+)\s*\)/g)
  // 类方法 / 对象字面量方法 / 接口成员声明（行首 成员名( 或 成员名<）
  add(/^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:private\s+|public\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_]\w*)\s*[(<]/gm)
  // 形参与解构名（宽松：任何 `( x:` / `, x?:` / `{ x,` / `x =`；`?` 须在位——
  // 可选形参 `name?` 此前漏声明，被当未定义调用误报）
  add(/[(,{[]\s*(\w+)\??\s*[:=,}\]]/g)
  add(/^\s*(\w+)\s*[:=]/gm)
  // 解构声明：const { a, b: c } = x
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop().split('=')[0].trim()
      if (n) names.add(n)
    }
  }
  // interface / type 块内的成员名
  for (const m of code.matchAll(/\b(?:interface|type)\s+\w+[^{]*\{/g)) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < code.length; i++) {
      if (code[i] === '{') depth += 1
      else if (code[i] === '}') {
        depth -= 1
        if (depth === 0) { i += 1; break }
      }
    }
    const span = code.slice(m.index, i)
    for (const mm of span.matchAll(/(?<![\w.>])([A-Za-z_]\w*)\s*[(<:]/g)) names.add(mm[1])
  }
  // 内联匿名对象类型：{ a: T; b(): U }（仅在内容全为类型字符时按类型对待，避免吞掉真代码）
  for (const m of code.matchAll(/\{([^{}]*)\}/g)) {
    const inner = m[1]
    if (!/^[\s\w,;:()[\]=>|&?'".<>$]*$/.test(inner)) continue
    if (!/[;:]/.test(inner)) continue
    for (const mm of inner.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*[(:]/g)) names.add(mm[1])
  }
  for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()
      if (n) names.add(n)
    }
  }
  return names
}


/** 扫描给定文件，返回每个文件的未定义调用名（空数组 = 干净）。 */
export function scanUndefined(files) {
  const out = []
  for (const f of files) {
    const code = strip(readFileSync(f, 'utf8'))
    const declared = declaredNames(code)
    const missing = new Set()
    for (const m of code.matchAll(/(?<![\w.$])([a-zA-Z_]\w{2,})\s*\(/g)) {
      const n = m[1]
      if (!declared.has(n) && !GLOBALS.has(n)) missing.add(n)
    }
    out.push({ file: f, missing: [...missing] })
  }
  return out
}
