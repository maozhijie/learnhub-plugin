/**
 * 概念登记表（#141 / #122 契约 v0.1）：课程根/概念登记表.yaml，每课程一份受控词表。
 *
 * 条目 = canonical 名 + 别名[] + 选填定义；全部名字（canonical ∪ 别名）课程内联合唯一
 * ——一个名字至多属一条目，违约 Broken；文件缺失 Missing 合法空态。
 * 身份=条目、名字=地址：引用解析 = 精确匹配在册名字（canonical 或别名），永不模糊匹配。
 * 条目禁删只并入：合并 = 名字并集，被并入条目的 canonical 降级为别名，旧地址经别名
 * 续解析——沉淀层档案坐标系（ADR-0034）的语义底座，登记表跨宣告式断裂存活。
 *
 * 登记机械化无人审：铸名随生长批提案（edit 提案 concepts 块）与图 apply 同事务落盘，
 * 人的领域判断只在合并/改名时行使。
 */
import { readFile } from 'node:fs/promises'
import { YAML } from './yaml.ts'
import { atomicWrite } from './store.ts'
import type { Paths } from './paths.ts'

/** 登记表条目：canonical 主名；别名可选（名字并集后历史地址都在这）；定义选填
 * （同形异义与螺旋升档判断的依据，随注入切片给出）。 */
export interface ConceptEntry {
  canonical: string
  aliases?: string[]
  definition?: string
}

const ENTRY_KEYS = new Set(['canonical', 'aliases', 'definition'])

/** 一处概念引用（受理门对表的错误行定位原料）：where 供拒收文案指位。 */
export interface ConceptRef { where: string; concept: string }

/** 名字 → 所属条目 canonical 的索引（联合唯一的对账底表；canonical 自映射）。 */
function ownerMapOf(entries: ConceptEntry[]): Map<string, string> {
  const ownerOf = new Map<string, string>()
  for (const e of entries) {
    ownerOf.set(e.canonical, e.canonical)
    for (const a of e.aliases ?? []) ownerOf.set(a, e.canonical)
  }
  return ownerOf
}

/** 单条目形态校验（登记表读侧与提案铸名块共用同一契约）：canonical 非空、aliases
 * 字符串列表可选、definition 字符串可选；未知键 fail loud（拼错键静默丢字段会让
 * 名字联合唯一出现假空位）。名字一律 trim。 */
export function validateConceptEntry(raw: unknown, where: string): { errors: string[]; entry?: ConceptEntry } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: [`${where}: 必须是映射（{canonical, aliases?, definition?}）`] }
  }
  const r = raw as Record<string, unknown>
  const errors: string[] = []
  const unknown = Object.keys(r).filter(k => !ENTRY_KEYS.has(k))
  if (unknown.length) {
    errors.push(`${where} 含未知字段 ${JSON.stringify(unknown)}（条目只允许 canonical/aliases/definition）`)
  }
  const canonical = typeof r.canonical === 'string' ? r.canonical.trim() : ''
  if (!canonical) errors.push(`${where}.canonical: 不能为空`)
  let aliases: string[] | undefined
  if (r.aliases !== undefined) {
    if (!Array.isArray(r.aliases) || r.aliases.some(a => typeof a !== 'string')) {
      errors.push(`${where}.aliases: 必须是字符串列表`)
    } else {
      const cleaned = (r.aliases as string[]).map(a => a.trim()).filter(Boolean)
      if (cleaned.length) aliases = cleaned
    }
  }
  let definition: string | undefined
  if (r.definition !== undefined) {
    if (typeof r.definition !== 'string' || !r.definition.trim()) {
      errors.push(`${where}.definition: 必须是非空字符串`)
    } else {
      definition = r.definition.trim()
    }
  }
  if (errors.length || !canonical) return { errors }
  return { errors: [], entry: { canonical, ...(aliases ? { aliases } : {}), ...(definition ? { definition } : {}) } }
}

/** 登记表契约校验（读侧门禁与 data-check 共用同一口径）：concepts 列表 + 全部名字
 * 联合唯一。违约行可执行——给出冲突名字与占用位置。 */
export function validateConceptRegistry(raw: unknown): { errors: string[]; entries: ConceptEntry[] } {
  if (typeof raw !== 'object' || raw === null) {
    return { errors: ['(顶层): 必须是映射（concepts）'], entries: [] }
  }
  const doc = raw as Record<string, unknown>
  if (!Array.isArray(doc.concepts)) return { errors: ['concepts: 必须是列表'], entries: [] }
  const errors: string[] = []
  const entries: ConceptEntry[] = []
  const ownerOf = new Map<string, string>() // 名字 → 首个占用位置（联合唯一对账表）
  const claim = (name: string, where: string): void => {
    const owner = ownerOf.get(name)
    if (owner === undefined) ownerOf.set(name, where)
    else if (owner !== where) errors.push(`${where}: 名字「${name}」已被 ${owner} 占用（全部名字联合唯一：一个名字至多属一条目）`)
  }
  doc.concepts.forEach((item, index) => {
    const where = `concepts.${index + 1}`
    const v = validateConceptEntry(item, where)
    errors.push(...v.errors)
    if (!v.entry) return
    entries.push(v.entry)
    claim(v.entry.canonical, `${where}.canonical`)
    for (const alias of v.entry.aliases ?? []) claim(alias, `${where}.aliases`)
  })
  return { errors, entries }
}

/** 在册名字全集（canonical ∪ 别名）——受理门对表与 invokes 校验的已知集。 */
export function namesOf(entries: ConceptEntry[]): Set<string> {
  const names = new Set<string>()
  for (const e of entries) {
    names.add(e.canonical)
    for (const a of e.aliases ?? []) names.add(a)
  }
  return names
}

/** 精确匹配解析：名字（canonical 或别名）→ 条目；未命中返回 null。永不模糊匹配。 */
export function resolveConcept(entries: ConceptEntry[], name: string): ConceptEntry | null {
  return entries.find(e => e.canonical === name || (e.aliases ?? []).includes(name)) ?? null
}

/** 概念引用对表（受理门）：未在册的名字逐个给出可执行错误行。known = 在册名字 ∪
 * 同批铸名。 */
export function conceptReferenceErrors(
  refs: ConceptRef[],
  known: Set<string>,
): string[] {
  return refs.filter(r => !known.has(r.concept))
    .map(r => `${r.where} 引用「${r.concept}」未在登记表在册——把它加进提案 concepts 铸名块，或改用登记表既有名字（canonical/别名精确匹配）`)
}

/** 题目 invokes 在册校验（#141 受理门对表；#148 出生打标全链消费同一缝）：题目带
 * invokes 且名字未在册 → 拒收理由；缺席/空 = 合法 Missing；非字符串归题库 schema 门。 */
export function invokesUnregistered(q: { invokes?: unknown }, known: Set<string>): string | null {
  if (typeof q.invokes !== 'string' || !q.invokes.trim()) return null
  const name = q.invokes.trim()
  return known.has(name) ? null
    : `invokes 概念「${name}」未在概念登记表在册——随生长批提案铸名（concepts 块）或改用在册名字（canonical/别名）`
}

/** 铸名冲突校验（propose 受理门，从严）：铸名的任何名字撞上既有登记表（含撞自己
 * 的 canonical）或批内其他铸名都是冲突——引用既有名字直接用，吞并既有条目走人审
 * 合并；同条目幂等重写不是铸名的语义（那是 apply 侧 applyConceptMints 的事）。 */
export function mintConflicts(mints: ConceptEntry[], existing: ConceptEntry[]): string[] {
  const ownerOf = ownerMapOf(existing)
  const errors: string[] = []
  const seenCanonical = new Set<string>()
  for (const mint of mints) {
    if (seenCanonical.has(mint.canonical)) {
      errors.push(`铸名冲突: canonical「${mint.canonical}」在本提案 concepts 块内重复（一条目一铸名）`)
    }
    seenCanonical.add(mint.canonical)
    for (const name of [mint.canonical, ...(mint.aliases ?? [])]) {
      const owner = ownerOf.get(name)
      if (owner !== undefined) {
        errors.push(`铸名冲突: 名字「${name}」已在登记表条目「${owner}」在册——引用既有名字即可，或对人审合并走 concept-merge`)
      } else {
        ownerOf.set(name, mint.canonical)
      }
    }
  }
  return errors
}

/** apply 侧铸名合并（幂等）：铸名名字已属同 canonical 条目 = 幂等跳过（崩溃后重放
 * apply 不炸）；已属其他条目 = 错误（propose 门已拦，此处兜底 apply 期间登记表被并发
 * 修改的情形）。返回合并后的完整条目表（新条目追加在表尾，既有条目只补缺别名——
 * 条目禁删只并入的写侧纪律）。 */
export function applyConceptMints(existing: ConceptEntry[], mints: ConceptEntry[]): { errors: string[]; entries: ConceptEntry[] } {
  const ownerOf = ownerMapOf(existing)
  const errors: string[] = []
  const seenCanonical = new Set<string>()
  for (const mint of mints) {
    if (seenCanonical.has(mint.canonical)) {
      errors.push(`apply 铸名冲突: canonical「${mint.canonical}」在提案 concepts 块内重复`)
    }
    seenCanonical.add(mint.canonical)
    for (const name of [mint.canonical, ...(mint.aliases ?? [])]) {
      const owner = ownerOf.get(name)
      if (owner !== undefined && owner !== mint.canonical) {
        errors.push(`apply 铸名冲突: 名字「${name}」已属登记表条目「${owner}」（提案受理后登记表被并发修改——reject 本提案重新生成）`)
      }
      ownerOf.set(name, mint.canonical)
    }
  }
  if (errors.length) return { errors, entries: existing }
  const entries = existing.map(e => ({ ...e, ...(e.aliases ? { aliases: [...e.aliases] } : {}) }))
  for (const mint of mints) {
    const hit = entries.find(e => e.canonical === mint.canonical)
    if (!hit) {
      entries.push({ ...mint, ...(mint.aliases ? { aliases: [...mint.aliases] } : {}) })
      continue
    }
    const have = new Set(hit.aliases ?? [])
    const aliases = [...(hit.aliases ?? [])]
    for (const a of mint.aliases ?? []) {
      if (!have.has(a) && a !== hit.canonical) {
        aliases.push(a)
        have.add(a)
      }
    }
    if (aliases.length) hit.aliases = aliases
    // definition：既有条目已带定义不覆盖（条目在册语义以先到者为准；补定义走人审）
  }
  return { errors: [], entries }
}

/** 并入（纯函数，human 决策的执行核）：from 整条并入 into——名字并集（from 的
 * canonical 与别名全部进 into 的别名），definition 缺省回退（into 无定义才承继），
 * from 条目移除。旧地址（from canonical 与别名）并入后经别名继续解析到 into。 */
export function mergeConceptEntries(
  entries: ConceptEntry[], from: string, into: string,
): { errors: string[]; entries: ConceptEntry[] } {
  const fromIdx = entries.findIndex(e => e.canonical === from || (e.aliases ?? []).includes(from))
  const intoIdx = entries.findIndex(e => e.canonical === into || (e.aliases ?? []).includes(into))
  if (fromIdx < 0) return { errors: [`「${from}」不在登记表在册（canonical/别名精确匹配）——合并只对在册条目生效`], entries }
  if (intoIdx < 0) return { errors: [`「${into}」不在登记表在册（canonical/别名精确匹配）——合并只对在册条目生效`], entries }
  if (fromIdx === intoIdx) return { errors: [`「${into}」不能并入自身（合并需要两个不同条目）`], entries }
  const src = entries[fromIdx]!
  const dst = entries[intoIdx]!
  const have = new Set([dst.canonical, ...(dst.aliases ?? [])])
  const aliases = [...(dst.aliases ?? [])]
  for (const name of [src.canonical, ...(src.aliases ?? [])]) {
    if (!have.has(name)) {
      aliases.push(name)
      have.add(name)
    }
  }
  const merged: ConceptEntry = {
    ...dst,
    ...(aliases.length ? { aliases } : {}),
    ...(dst.definition === undefined && src.definition !== undefined ? { definition: src.definition } : {}),
  }
  const out = entries.filter((_, i) => i !== fromIdx && i !== intoIdx)
  out.push(merged) // 并入后的条目排在表尾：追加式演化，diff 友好
  return { errors: [], entries: out }
}

/** 概念登记表读写：文件缺失 Missing 合法空态（load 返回空表）；存在但 YAML/契约坏
 * 抛 Broken（不静默当空表——名字唯一性是全部概念引用的地基，坏了必须 fail loud）。 */
export class ConceptRegistry {
  // 显式字段赋值（参数属性在 strip-only 单测模式下不可导入）
  private paths: Paths
  constructor(paths: Paths) {
    this.paths = paths
  }

  /** 读登记表 → 条目列表（保序）。文件缺失返回 []（合法 Missing）；Broken 抛错。 */
  async load(root: string): Promise<ConceptEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.paths.conceptRegistryPath(root), 'utf8')
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return []
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`[concept-registry] 概念登记表 Broken（无法读取）: ${this.paths.conceptRegistryPath(root)}\n  ✗ ${message}`)
    }
    let doc: unknown
    try {
      doc = YAML.parse(raw)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`[concept-registry] 概念登记表 Broken（YAML 无法解析）: ${this.paths.conceptRegistryPath(root)}\n  ✗ ${message}`)
    }
    const checked = validateConceptRegistry(doc)
    if (checked.errors.length) {
      throw new Error(`[concept-registry] 概念登记表 Broken（契约校验失败）: ${this.paths.conceptRegistryPath(root)}\n${checked.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    return checked.entries
  }

  /** 全量写登记表（原子写）。 */
  async save(root: string, entries: ConceptEntry[]): Promise<void> {
    await atomicWrite(this.paths.conceptRegistryPath(root), YAML.stringify({ concepts: entries }))
  }

  /** 并入（human 决策执行面）：from 并入 into，名字并集，旧地址经别名续解析。
   * 失败抛错不改盘。 */
  async merge(root: string, from: string, into: string): Promise<{ into: string; names: string[] }> {
    const entries = await this.load(root)
    const merged = mergeConceptEntries(entries, from, into)
    if (merged.errors.length) {
      throw new Error(`[concept-merge] 合并未执行（登记表保持原样）。\n${merged.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    await this.save(root, merged.entries)
    const dst = resolveConcept(merged.entries, into)
    return { into: dst!.canonical, names: [dst!.canonical, ...(dst!.aliases ?? [])] }
  }
}
