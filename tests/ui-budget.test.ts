/** ui/ 文件规模预算门（#183 / ADR-0052）+ 壳级视觉纪律门（#206 / ADR-0058），
 * 随 npm test 全量执行。
 *
 * 规模预算是「硬预算」而非棘轮：超线即失败（现存超线 4 文件由 #183 本票收敛，
 * 收敛后不存在基线条目——新超线须在票面登记理由并经重划，而不是悄悄养大）。
 * 视觉纪律：壳级组件（App + shell 组件）只准消费 tokens.css 的 --lh-* 语义类/
 * 变量——硬编码色值只许住在 token 层，内联布局 style 一律语义类化（页面内部的
 * 内联 style 留待各区票与收尾票，不在本门扫描面）。
 * 两门的自检纪律照 ADR-0047：构造必然违规的样本断言本门会失败（恒过的门比没有门更坏）。
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

// ---- 壳级视觉纪律门（#206 / ADR-0058）：硬编码色值与内联布局 style 出壳即红 ----

/** 壳级文件清单：App 入口 + shell 组件（tokens.css 与 global.css 的壳规则是 token
 * 的定义/消费侧，字面量兜底只许住在 tokens.css，不列本清单）。 */
const SHELL_FILES = ['App.tsx', 'components/ShellTopBar.tsx', 'components/ZoneBody.tsx', 'components/HelpDrawer.tsx']

/** 门体：剥注释后扫硬编码色值（hex/rgb/rgba）与内联 style 属性。
 * hex 判据：6/8 位全收；3/4 位须含 a-f 字母——纯数字 3 位串是票号（#164）不是色值。 */
function shellStyleViolations(srcRoot: string, texts: Record<string, string>): string[] {
  const violations: string[] = []
  for (const rel of SHELL_FILES) {
    const text = texts[rel] ?? readFileSync(join(srcRoot, ...rel.split('/')), 'utf8')
    const bare = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (/(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)\b/.test(bare)
      || /#[0-9a-fA-F]{3,4}\b/.test(bare.replace(/#[0-9a-fA-F]{3,4}\b/g, m => (/[a-fA-F]/.test(m.slice(1)) ? m : '')))) {
      violations.push(`${rel}: 硬编码色值（hex）——色值只许住在 tokens.css`)
    }
    if (/rgba?\(/.test(bare)) violations.push(`${rel}: 硬编码色值（rgb/rgba）——色值只许住在 tokens.css`)
    if (/style=\{/.test(bare)) violations.push(`${rel}: 内联 style——布局/外观一律语义类化（global.css 壳规则）`)
  }
  return violations
}

test('壳级视觉纪律：硬编码色值与内联 style 出壳即红（#206）', () => {
  const violations = shellStyleViolations(join(ROOT, 'ui', 'src'), {})
  assert.deepEqual(violations, [], `壳级视觉纪律违约：\n${violations.join('\n')}`)
})

test('门自检：壳级色值/内联 style 样本必须被抓住；票号 #164 不误咬', () => {
  const caught = shellStyleViolations('', {
    'App.tsx': '<div style={{ color: "#1d2129" }}>x</div>',
    'components/ShellTopBar.tsx': '',
    'components/ZoneBody.tsx': '',
    'components/HelpDrawer.tsx': 'const c = rgba(0, 0, 0, 0.08)',
  })
  assert.ok(caught.some(v => v.startsWith('App.tsx') && v.includes('内联 style')), '内联 style 样本未被抓到')
  assert.ok(caught.some(v => v.startsWith('App.tsx') && v.includes('hex')), 'hex 色值样本未被抓到')
  assert.ok(caught.some(v => v.startsWith('components/HelpDrawer.tsx') && v.includes('rgb')), 'rgba 样本未被抓到')
  const ticketRef = shellStyleViolations('', {
    'App.tsx': '', 'components/ShellTopBar.tsx': '属池票 #164 与 #20', 'components/ZoneBody.tsx': '', 'components/HelpDrawer.tsx': '',
  })
  assert.deepEqual(ticketRef, [], '纯数字票号（#164/#20）被误判为色值')
})
