/**
 * 窄面一致性扫描（#152 后续架构门）：对每个子系统文件，
 * 比较「deps 接口声明的成员」与「类体实际 this.e.X 用到的成员」——
 *   dead    = 声明了却从不使用（死接线，接线里可能还引用不存在的门面方法）
 *   missing = 用了却未声明（运行期 undefined 调用的前兆）
 * 用法：node scripts/scan-deps-face.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ENGINE = 'src/engine'

export function scanDepsFaces(dir = ENGINE) {
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue
    const path = join(dir, f)
    const src = readFileSync(path, 'utf8')
    const m = src.match(/export interface (\w*Deps)\s*\{/)
    if (!m) continue
    const start = src.indexOf('{', m.index)
    let depth = 0
    let i = start
    for (; i < src.length; i++) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const body = src.slice(start + 1, i)
    const declared = new Set()
    for (const mm of body.matchAll(/^\s{2}(\w+)\s*[(:]/gm)) declared.add(mm[1])
    const cls = src.slice(src.indexOf('export class'))
    const used = new Set()
    for (const mm of cls.matchAll(/this\.e\.(\w+)/g)) used.add(mm[1])
    out.push({
      file: path,
      deps: m[1],
      dead: [...declared].filter(n => !used.has(n)).sort(),
      missing: [...used].filter(n => !declared.has(n)).sort(),
      declared: declared.size,
      used: used.size,
    })
  }
  return out
}

if (process.argv[1] && process.argv[1].includes('scan-deps-face')) {
  const rows = scanDepsFaces()
  let bad = 0
  for (const r of rows) {
    if (!r.dead.length && !r.missing.length) {
      console.log(`✓ ${r.file}  ${r.deps}: ${r.declared} 成员，全部在用`)
      continue
    }
    bad += r.dead.length + r.missing.length
    console.error(`✗ ${r.file}  ${r.deps}: 声明 ${r.declared} / 实用 ${r.used}`)
    if (r.dead.length) console.error(`    dead（声明未用）: ${r.dead.join(', ')}`)
    if (r.missing.length) console.error(`    missing（用而未声明）: ${r.missing.join(', ')}`)
  }
  process.exit(bad ? 1 : 0)
}
