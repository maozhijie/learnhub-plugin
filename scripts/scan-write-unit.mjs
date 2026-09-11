/**
 * 写入单元门（#176 / ADR-0046）：跨文件落盘的顺序约定必须住在原语里，不许再以
 * 「同事务」注释的形态散布。两条判定：
 *   1. src/ 内「同事务」注释**归零**——迁移后的顺序知识住在 WriteStep 声明里
 *      （测试侧断言消息里的同名 11 处不在扫描面，随迁移另行核对）。
 *   2. 七个写入单元站点各自必须经 runWriteUnit——站点清单在此（单一出处），迁移
 *      回退或新增跨文件落盘操作绕开原语都会被抓。
 *
 * 站点清单（文件 → 该文件内的写入单元调用次数 ≥ N）：
 *   proposals.ts ≥3（applyEdit／applySeed／applyEnrich）
 *   sched-subsystem.ts ≥2（nodeComplete／optimizeFsrsParams）
 *   nof1.ts ≥1（experimentStop）
 *   growth-subsystem.ts ≥1（settleRechecks）
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 七站点的最低调用数（键 = 相对 src/ 的 posix 路径——不能用文件名：
 * views/proposals.ts 与 engine/proposals.ts 同名，按名计数会互相覆盖）。 */
export const WRITE_UNIT_SITES = {
  'engine/proposals.ts': 3,
  'engine/sched-subsystem.ts': 2,
  'engine/nof1.ts': 1,
  'engine/growth-subsystem.ts': 1,
}

export function srcFilesOf(root) {
  const dir = join(root, 'src')
  const out = []
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  }
  walk(dir)
  return out
}

/** 「同事务」注释残留（原文扫描——要找的恰恰是注释，不剥）。 */
export function sameTransactionHits(files) {
  return files.filter(f => readFileSync(f, 'utf8').includes('同事务'))
}

/** 各文件的 runWriteUnit 调用数（键 = 相对 src/ 的 posix 路径）。 */
export function writeUnitCallCounts(files, srcRoot = 'src') {
  const out = {}
  for (const f of files) {
    const i = f.lastIndexOf(srcRoot)
    const rel = (i === -1 ? f : f.slice(i + srcRoot.length + 1)).split(/[\\/]/).join('/')
    if (rel in WRITE_UNIT_SITES) out[rel] = (readFileSync(f, 'utf8').match(/\brunWriteUnit\s*\(/g) ?? []).length
  }
  return out
}

/** 门判定（纯函数；自检喂假样本）。空数组 = 过。 */
export function writeUnitViolations(hits, counts) {
  const bad = hits.map(f => `[同事务残留] ${f}：顺序约定必须搬进 runWriteUnit 的步骤声明（#176）`)
  for (const [file, min] of Object.entries(WRITE_UNIT_SITES)) {
    const n = counts[file]
    if (n === undefined) { bad.push(`[站点缺失] ${file} 不在扫描面（站点文件改名/删除要同步本清单）`); continue }
    if (n < min) bad.push(`[写入单元] ${file} 的 runWriteUnit 调用 ${n} < ${min}——跨文件落盘操作绕开了原语`)
  }
  return bad
}
