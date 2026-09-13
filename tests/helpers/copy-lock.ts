/** 文案语义锁助手（#207 / ADR-0058 门册判据修订「逐字锁→语义锁」）：交互测试的
 * 文案断言改为「canonical 词条词出现（正断言）+ 交互行为成立 + 词条 Avoid 词
 * 反断言」。词表唯一出处 = CONTEXT.md 的 Language 节——运行时解析真实文件，
 * 词条改门随之动，没有第二份词表可漂移。判据与边界登记在 tests/README.md
 * 「L3 文案语义锁」段；自检（含必然违规样本）在 tests/copy-lock.test.ts。
 *
 * 机械判据的四条边界（登记即执法面）：
 * - 锚词不锚整句：正断言只要求 canonical 词出现，同义措辞微调不再红；
 * - 反断言按语境区域执法：作用域由调用方圈定（元素或字符串），Avoid 词表是
 *   语境纪律（掌握度呈现区不得说「熟练度」），不是全页禁词；
 * - 遮蔽更长 canonical 形再查子串：「作答正确率」⊃「正确率」，canonical 合成形
 *   是合法词汇不误咬；
 * - 带「单独使用」括注的 Avoid 项不机械执法（中文无词边界，机械执法会咬
 *   「模型推演」这类合法形）——登记为门局限，由实机走查补位。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface GlossaryEntry {
  /** 词条原名，如 `Mastery（掌握度）`。 */
  header: string
  /** canonical 中文名形（无中文形取原名，如 XP）。 */
  canonical: string[]
  /** 参与机械反断言的 Avoid 词（剥括注、拆 `/` alternates）。 */
  avoid: string[]
  /** 带「单独使用」括注的 Avoid 词——登记为不机械执法。 */
  avoidContextual: string[]
}

/** 括号感知的 `、` 切分：Avoid 项的括注里也有 `、`，瞎切会把一条拆成两条。 */
function splitItems(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '（' || ch === '(') depth++
    else if (ch === '）' || ch === ')') depth--
    if (ch === '、' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

/** 词条行 → 词条：canonical 取头部的中文形；Avoid 项剥括注，`单独使用` 括注项
 * 归入 avoidContextual（不机械执法），`/` alternates 拆成独立词。 */
function toEntry(header: string, avoidRaw: string[]): GlossaryEntry {
  const parts = header.split(/[（）()]/).map(p => p.trim()).filter(Boolean)
  const cjk = parts.filter(p => /[\u4e00-\u9fff]/.test(p))
  const avoid: string[] = []
  const avoidContextual: string[] = []
  for (const item of avoidRaw.flatMap(splitItems)) {
    const m = item.match(/^(.*?)\s*[（(]([^（）()]*)[）)]\s*$/)
    const note = m ? m[2]! : ''
    const words = (m ? m[1]! : item).split('/').map(w => w.trim()).filter(Boolean)
    for (const w of words) (note.includes('单独使用') ? avoidContextual : avoid).push(w)
  }
  return { header, canonical: cjk.length ? cjk : parts, avoid, avoidContextual }
}

/** 解析 CONTEXT.md 的 Language 词条表：`**词条**:` 行开条目，`_Avoid_: …` 行收
 * 词表；正文散文不参与。每测试进程解析一次即可（词条文件在会话中不变）。 */
export function loadGlossary(): GlossaryEntry[] {
  const text = readFileSync(join(ROOT, 'CONTEXT.md'), 'utf8')
  const entries: GlossaryEntry[] = []
  let current: { header: string; avoidRaw: string[] } | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const h = line.match(/^\*\*(.+?)\*\*:\s*$/)
    if (h) {
      if (current) entries.push(toEntry(current.header, current.avoidRaw))
      current = { header: h[1]!, avoidRaw: [] }
      continue
    }
    if (!current) continue
    const a = line.match(/^_Avoid_: (.+)$/)
    if (a) current.avoidRaw.push(a[1]!)
  }
  if (current) entries.push(toEntry(current.header, current.avoidRaw))
  return entries
}

let cache: GlossaryEntry[] | null = null
function glossary(): GlossaryEntry[] {
  cache ??= loadGlossary()
  return cache
}

function entryOf(name: string): GlossaryEntry {
  const hit = glossary().find(e => e.header === name)
  if (!hit) {
    throw new Error(`语义锁·词表缺词条：「${name}」不在 CONTEXT.md 的 Language 节（词条名要逐字对上头部）`)
  }
  return hit
}

/** 语义锁（正断言 canonical 词 + Avoid 反断言）。scope 是调用方圈定的语境区域：
 * DOM 元素取其 textContent，或直接给字符串。allow = 作用域内确需豁免的字串。 */
export function lockCopy(
  scope: { textContent?: string | null } | string,
  lock: { canonical: string[]; glossary?: string; allow?: string[] },
): void {
  const text = typeof scope === 'string' ? scope : scope.textContent ?? ''
  for (const w of lock.canonical) {
    if (!text.includes(w)) {
      throw new Error(`语义锁·正断言失败：作用域文本缺 canonical 词「${w}」`)
    }
  }
  if (!lock.glossary) return
  const entry = entryOf(lock.glossary)
  // 全部 canonical 形按长度降序：先遮长的（作答正确率）再查短的（正确率）
  const canonicals = glossary().flatMap(e => e.canonical).sort((a, b) => b.length - a.length)
  for (const w of entry.avoid) {
    if (lock.allow?.includes(w)) continue
    let masked = text
    for (const c of canonicals) if (c.length > w.length && c.includes(w)) masked = masked.split(c).join('□')
    for (const a of lock.allow ?? []) masked = masked.split(a).join('□')
    if (masked.includes(w)) {
      throw new Error(`语义锁·反断言失败：词条「${entry.header}」的 Avoid 词「${w}」出现在作用域文本（CONTEXT.md 明文禁用）`)
    }
  }
}
