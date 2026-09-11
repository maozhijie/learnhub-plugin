/**
 * 架构止血门（#152 后续裁决：可测量的门进 npm test）：
 *
 * G1 未定义标识符扫描——剥注释与字符串后，凡「被当函数调用、却既未声明也未导入」
 *    的名字即失败。动机是实测教训：一次宿主抽离漏了 14 个标识符（host 模块没 export、
 *    宿主没回引），707 个测试与 `npm run build` 全绿、`node --check` 只验语法——直到
 *    运行时才会炸。
 * G2 宿主模块可加载 + 装配面齐备——动态 import src/index.ts 与 host/*，断言插件入口
 *    三件套（name/inject/apply）与抽出的技术层导出都在。加载即覆盖模块级初始化路径。
 *
 * 二者都是零依赖、秒级的静态/加载检查；tsc 类型门落地后 G1 可退役（TS2304 覆盖它），
 * 但加载冒烟仍然只有这里能测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanUndefined } from '../scripts/undefined-scan.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

test('G1 无未定义标识符（抽文件漏导出/漏导入的兜底门）', () => {
  const files = walk(SRC)
  assert.ok(files.length > 50, `扫描面异常：只找到 ${files.length} 个 src/*.ts`)
  const bad = scanUndefined(files)
    .filter(r => r.missing.length)
    .map(r => `${r.file.slice(ROOT.length + 1)}: ${r.missing.join(', ')}`)
  assert.deepEqual(bad, [], `未定义标识符（运行时 ReferenceError 的静态前兆）：\n${bad.join('\n')}`)
})

test('G2 宿主模块可加载且装配面齐备', async () => {
  const host = await import('../src/index.ts')
  assert.equal(host.name, 'dsh-learnhub')
  assert.deepEqual(host.inject, ['tools', 'webServer', 'llm'])
  assert.equal(typeof host.apply, 'function')

  const llm = await import('../src/host/llm.ts')
  for (const n of ['llmComplete', 'llmSeam', 'llmStreamOnce', 'llmView', 'contentEffort']) {
    assert.equal(typeof llm[n], 'function', `host/llm.ts 缺导出 ${n}`)
  }
  const http = await import('../src/host/http.ts')
  for (const n of ['sendJson', 'readJson', 'need', 'injectKatexIfMathed', 'PAGE_DIST', 'VENDOR_DIST', 'FILE_MIME', 'ASSET_MIME']) {
    assert.ok(http[n] !== undefined, `host/http.ts 缺导出 ${n}`)
  }
})

test('G2b src 下的入口文件存在且非空（防止误删/误移）', () => {
  for (const rel of ['index.ts', 'host/llm.ts', 'host/http.ts', 'engine/index.ts']) {
    assert.ok(statSync(join(SRC, rel)).size > 0, `${rel} 缺失或为空`)
  }
})
