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
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ---- 页面内联 style 门（#211 / ADR-0058 收尾）：静态样式一律语义类，内联只许动态值 ----

/** 内联 style 站点（相对 ui/src 的 posix 路径 + 声明串）。括号/引号/模板串感知扫描：
 * 只看 `style={{…}}` 块，逐块判定「纯字面量 = 静态」。 */
function inlineStyleSites(srcRoot: string): Array<{ file: string; body: string; dynamic: boolean }> {
  const BS = String.fromCharCode(92)
  /** 顶层逗号切分（引号/模板串/括号感知）。 */
  const splitTop = (b: string): string[] => {
    const out: string[] = []; let cur = ''; let q: string | null = null; let depth = 0
    for (let i = 0; i < b.length; i++) {
      const c = b[i]!
      if (q) { cur += c; if (c === q && b[i - 1] !== BS) q = null; continue }
      if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue }
      if (c === '(' || c === '[' || c === '{') depth++
      if (c === ')' || c === ']' || c === '}') depth--
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue }
      cur += c
    }
    if (cur.trim()) out.push(cur)
    return out
  }
  const sites: Array<{ file: string; body: string; dynamic: boolean }> = []
  for (const p of walk(srcRoot)) {
    if (!p.endsWith('.tsx')) continue
    const text = readFileSync(p, 'utf8')
    for (const m of text.matchAll(/style=\{\{([\s\S]*?)\}\}/g)) {
      const body = m[1]!.replace(/\s+/g, ' ').trim()
      const dynamic = splitTop(body).map(x => x.trim()).filter(Boolean).some(part => {
        const i = part.indexOf(':')
        if (i < 0) return true
        const v = part.slice(i + 1).trim()
        const literal = /^-?\d+(\.\d+)?$/.test(v) || /^'[^']*'$/.test(v) || /^"[^"]*"$/.test(v)
        return !literal
      })
      sites.push({ file: p.split(String.fromCharCode(92)).join('/').split('/ui/src/')[1]!, body, dynamic })
    }
  }
  return sites
}

/** 登记的内联站点数（棘轮，精确匹配；#211 收敛后只剩动态值——进度条宽度、按数据着色等）。
 * 增减随提交同步并在注释里给理由（照调用点棘轮纪律）。 */
const INLINE_STYLE_SITES = 30

test(`页面内联 style 只许动态值（现存 ${INLINE_STYLE_SITES} 处，全为动态值）`, () => {
  const sites = inlineStyleSites(join(ROOT, 'ui', 'src'))
  const staticSites = sites.filter(s => !s.dynamic)
  assert.deepEqual(staticSites.map(s => `${s.file}: ${s.body}`), [],
    `静态内联 style 一律迁 ui/src/global.css 的语义 class 层（.lh-*；值名工具类见该段头注释）：\n${staticSites.map(s => `  ${s.file}: ${s.body}`).join('\n')}`)
  assert.equal(sites.length, INLINE_STYLE_SITES,
    `内联站点从 ${INLINE_STYLE_SITES} 漂到 ${sites.length}（动态值增减随提交同步登记）：\n${sites.map(s => `  ${s.file}: ${s.body.slice(0, 80)}`).join('\n')}`)
})

test('门自检：静态内联样本必须被抓住，动态值样本不误咬（ADR-0047）', () => {
  const tmp = join(ROOT, 'ui', 'src', '__inline_probe__.tsx')
  try {
    writeFileSync(tmp, [
      "export const A = () => <div style={{ fontSize: 12, color: 'var(--color-text-3)' }} />",
      'export const B = () => <div style={{ width: `${p}%` }} />',
      'export const C = () => <div style={{ marginLeft: onRetry ? 0 : 6 }} />',
    ].join('\n'), 'utf8')
    const sites = inlineStyleSites(join(ROOT, 'ui', 'src'))
    const probe = sites.filter(s => s.file === '__inline_probe__.tsx')
    assert.equal(probe.length, 3, `探针模块必须被扫描面看见（实得 ${probe.length} 个站点）——收集器不看目标形态就是恒过的门`)
    assert.equal(probe.filter(s => !s.dynamic).length, 1, '静态样本未被判定为静态')
    assert.equal(probe.filter(s => s.dynamic).length, 2, '动态值样本被误判为静态（模板串/三元）')
  } finally {
    rmSync(tmp, { force: true })
  }
})
