#!/usr/bin/env node
/**
 * 未定义标识符探针（#152 后续架构门的前置工具）：
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

/** 剥注释与字符串字面量（保留换行以维持行号不敏感的可读位置）。 */
function strip(code) {
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
  // 形参与解构名（宽松：任何 `( x:` / `, x:` / `{ x,` / `x =`）
  add(/[(,{[]\s*(\w+)\s*[:=,}\]]/g)
  add(/^\s*(\w+)\s*[:=]/gm)
  for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()
      if (n) names.add(n)
    }
  }
  return names
}

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node scripts/scan-undefined.mjs <文件…>')
  process.exit(2)
}
let bad = 0
for (const f of files) {
  const code = strip(readFileSync(f, 'utf8'))
  const declared = declaredNames(code)
  const missing = new Set()
  for (const m of code.matchAll(/(?<![\w.$])([a-zA-Z_]\w{2,})\s*\(/g)) {
    const n = m[1]
    if (!declared.has(n) && !GLOBALS.has(n)) missing.add(n)
  }
  if (missing.size) {
    bad += missing.size
    console.error(`${f}: 未定义调用 ${[...missing].join(', ')}`)
  }
}
if (bad) {
  console.error(`\n✗ 发现 ${bad} 个未定义标识符（抽文件漏导出/漏导入的典型症状）`)
  process.exit(1)
}
console.log('✓ 无未定义标识符')
