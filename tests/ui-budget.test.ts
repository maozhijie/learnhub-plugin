/** ui/ 文件规模预算门（#183 / ADR-0052）：ui/src 单文件 500 行硬预算，随 npm test 全量执行。
 *
 * ADR-0052 把预算定为「硬预算」而非棘轮：超线即失败（现存超线 4 文件由 #183 本票收敛，
 * 收敛后不存在基线条目——新超线须在票面登记理由并经重划，而不是悄悄养大）。
 * 门的自检纪律照 ADR-0047：构造必然违规的样本断言本门会失败（恒过的门比没有门更坏）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUDGET = 500

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = join(dir, e.name)
  return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : []
})

/** 门体：返回超线文件清单（相对 ui/src 的 posix 路径 + 行数）。提取为函数供自检复用。 */
function overBudget(dir: string, lineCount: (p: string) => number): Array<{ file: string; lines: number }> {
  return walk(dir)
    .map(p => ({ file: p.replaceAll('\\', '/').split('/ui/src/')[1]!, lines: lineCount(p) }))
    .filter(f => f.lines > BUDGET)
}

test(`ui/src 单文件 ≤${BUDGET} 行（ADR-0052 硬预算）`, () => {
  const over = overBudget(join(ROOT, 'ui', 'src'), p => readFileSync(p, 'utf8').split('\n').length)
  assert.deepEqual(over, [], `超线文件（拆分或登记理由重划，不许静默养大）：\n${over.map(f => `  ${f.file}: ${f.lines}`).join('\n')}`)
})

test('门自检：超线样本必须被抓住（恒过的门比没有门更坏）', () => {
  const fakeDir = join(ROOT, 'ui', 'src')
  const caught = overBudget(fakeDir, p => p.endsWith('App.tsx') ? BUDGET + 1 : 1)
  assert.equal(caught.length, 1, '注入的必然违规样本没有被看见——扫描面塌了')
  assert.equal(caught[0]!.lines, BUDGET + 1)
})
