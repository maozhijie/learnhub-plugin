#!/usr/bin/env node
/**
 * 未定义标识符探针 CLI（#152 后续架构门；核心在 scripts/undefined-scan.mjs，
 * tests/arch-guards.test.ts 复用同一实现）。
 *
 * 动机：宿主无 tsc 门、esbuild 只剥类型不查未定义全局——抽文件时漏掉导出/导入
 * 会静默通过 build，只在运行时炸（实测：一次抽离漏了 14 个标识符）。
 *
 * 用法：node scripts/scan-undefined.mjs src/index.ts src/engine/*.ts
 */
import { scanUndefined } from './undefined-scan.mjs'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node scripts/scan-undefined.mjs <文件…>')
  process.exit(2)
}
let bad = 0
for (const { file, missing } of scanUndefined(files)) {
  if (missing.length) {
    bad += missing.length
    console.error(`${file}: 未定义调用 ${missing.join(', ')}`)
  }
}
if (bad) {
  console.error(`
✗ 发现 ${bad} 个未定义标识符（抽文件漏导出/漏导入的典型症状）`)
  process.exit(1)
}
console.log('✓ 无未定义标识符')
