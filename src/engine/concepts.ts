/**
 * 概念登记表（#141 / #122 契约 v0.1；v0.2 增可选 confusable 字段，#232——可选字段
 * 子格式演进，非主版本断裂）：课程根/概念登记表.yaml，每课程一份受控词表。
 *
 * 条目 = canonical 名 + 别名[] + 选填定义 + 选填易混对；全部名字（canonical ∪ 别名）
 * 课程内联合唯一——一个名字至多属一条目，违约 Broken；文件缺失 Missing 合法空态。
 * 身份=条目、名字=地址：引用解析 = 精确匹配在册名字（canonical 或别名），永不模糊匹配。
 * 条目禁删只并入：合并 = 名字并集，被并入条目的 canonical 降级为别名，旧地址经别名
 * 续解析——沉淀层档案坐标系（ADR-0034）的语义底座，登记表跨宣告式断裂存活。
 *
 * 地址生命周期（v0.3，#262 / ADR-0084）：条目可被标记**废弃**（可逆、不删除）——废弃地址
 * 保留全部别名解析（用旧名字写的历史记录仍解析到该条目），仅从生成注入面（概念清单 /
 * 易混对 / 档位）与候选面退出；清标记即完全恢复（写侧只落 `true`，false 等同缺席）。
 * 条目仍禁删、仍只并入：退役走「标记」，不走删除。
 *
 * 写侧门与量级纪律（v0.3，#264 / 父 #260）：铸名受理门对本批新名做**近似名预检**（字符
 * trigram Jaccard，与题目侧查重同算法族，**软提示不拒收**——精确撞名的硬拒语义不变）；
 * 登记表有**量级告警带**（别名条数、混淆对条数各 WARN/ERROR 两档，报到读面与人审回执，
 * **不拒收**：别名是历史地址，拦下即断读）；混淆对**注入有上限**、超限按稳定序截断并
 * 如实披露（组装面在 content.ts）。
 *
 * 治理回路（#265 / 父 #260）：合并与混淆对候选都走**提案 + 人确认**两段式——合并不可逆
 * （只并入、不拆分），未确认不落盘；候选从**题目共现**派生，人审一次一条，接受后才入册。
 *
 * 登记机械化无人审：铸名随生长批提案（edit 提案 concepts 块）随图 apply 的写入单元落盘，
 * 人的领域判断只在合并/改名时行使。
 */
import type { VaultFs } from './io.ts'
import { YAML } from './yaml.ts'
import { atomicWrite } from './io.ts'
import type { Paths } from './paths.ts'
import { trigramSimilarity } from './question-dedup.ts'
import { round2 } from './grading.ts'

/** 登记表条目：canonical 主名；别名可选（名字并集后历史地址都在这）；定义选填
 * （同形异义与螺旋升档判断的依据，随注入切片给出）；易混对选填（#232：同课程在册
 * 概念名，出题时随概念清单注入作跨概念对比题候选；名字经精确解析归一，悬空引用
 * 消费侧静默降级）；废弃标记选填（#262：true = 该条目退役——地址仍解析、仅从生成
 * 注入面与候选面退出；缺席 = 在册活跃。写侧只落 true，false 等同缺席）。 */
export interface ConceptEntry {
  canonical: string
  aliases?: string[]
  definition?: string
  confusable?: string[]
  deprecated?: boolean
}

const ENTRY_KEYS = new Set(['canonical', 'aliases', 'definition', 'confusable', 'deprecated'])

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
 * 字符串列表可选、definition 字符串可选、confusable 字符串列表可选（#232）；未知键
 * fail loud（拼错键静默丢字段会让名字联合唯一出现假空位）。名字一律 trim。
 * confusable 不做「在册」校验——登记表是单文件静态物，先写对再补被指条目的书写序
 * 合法，悬空引用由消费侧（易混对候选提取）精确解析时静默降级。 */
export function validateConceptEntry(raw: unknown, where: string): { errors: string[]; entry?: ConceptEntry } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: [`${where}: 必须是映射（{canonical, aliases?, definition?, confusable?}）`] }
  }
  const r = raw as Record<string, unknown>
  const errors: string[] = []
  const unknown = Object.keys(r).filter(k => !ENTRY_KEYS.has(k))
  if (unknown.length) {
    errors.push(`${where} 含未知字段 ${JSON.stringify(unknown)}（条目只允许 canonical/aliases/definition/confusable/deprecated）`)
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
  let confusable: string[] | undefined
  if (r.confusable !== undefined) {
    if (!Array.isArray(r.confusable) || r.confusable.some(a => typeof a !== 'string')) {
      errors.push(`${where}.confusable: 必须是字符串列表`)
    } else {
      const cleaned = (r.confusable as string[]).map(a => a.trim()).filter(Boolean)
      if (cleaned.length) confusable = cleaned
    }
  }
  // 废弃标记（#262）：布尔；只落 true——false 等同缺席（清标记 = 字段删除，完全恢复）
  let deprecated = false
  if (r.deprecated !== undefined) {
    if (typeof r.deprecated !== 'boolean') {
      errors.push(`${where}.deprecated: 必须是布尔值`)
    } else {
      deprecated = r.deprecated
    }
  }
  if (errors.length || !canonical) return { errors }
  return { errors: [], entry: { canonical, ...(aliases ? { aliases } : {}), ...(definition ? { definition } : {}), ...(confusable ? { confusable } : {}), ...(deprecated ? { deprecated: true } : {}) } }
}

/** 易混对候选提取（#232）：条目 confusable 名字经精确解析归一到所属条目 canonical，
 * 只保留与本节概念清单（scope）相交的无序对（一端在清单内即可——对比题区分的是清单
 * 内概念与它的易混邻居）；悬空引用与自指对静默跳过，去重保序。 */
export function confusablePairsOf(entries: ConceptEntry[], scope: ReadonlySet<string>): Array<{ a: string; b: string }> {
  const out: Array<{ a: string; b: string }> = []
  const seen = new Set<string>()
  for (const e of entries) {
    for (const raw of e.confusable ?? []) {
      const other = resolveConcept(entries, raw)
      if (!other || other.canonical === e.canonical) continue
      // 废弃条目从生成注入面与候选面退出（#262）：任一端废弃的对不产出（地址仍解析，只是不再作候选）
      if (isDeprecated(e) || isDeprecated(other)) continue
      if (!scope.has(e.canonical) && !scope.has(other.canonical)) continue
      const key = [e.canonical, other.canonical].sort().join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ a: e.canonical, b: other.canonical })
    }
  }
  return out
}

/** 混淆对注入上限（#264）：注入产物的条数硬帽——超限按下面 capConfusablePairs 的稳定序
 * 截断，截断数与理由写在注入文本里（披露纪律：不静默丢）。上限也是量级告警的 WARN 带
 * （条目混淆对条数越过它 = 该收敛了——见 conceptMagnitudeFindings）。 */
export const CONFUSABLE_INJECT_CAP = 8

/** 注入产物的截断结果（#264）：pairs = 实际注入的前 cap 条（**稳定序**：confusablePairsOf
 * 的产出序是登记表文件序的纯函数——同输入恒同序，不排序不重排）；truncated = 被截掉条数。 */
export interface ConfusableInjection {
  pairs: Array<{ a: string; b: string }>
  total: number
  truncated: number
}

/** 混淆对注入截断（#264 纯函数）：超上限只取前 cap 条，并把「共几对、截掉几对」如实报出
 * 供注入文本披露（调用方不得静默丢弃——截断是事实，要写进提示词）。 */
export function capConfusablePairs(
  pairs: Array<{ a: string; b: string }>, cap = CONFUSABLE_INJECT_CAP,
): ConfusableInjection {
  if (pairs.length <= cap) return { pairs, total: pairs.length, truncated: 0 }
  return { pairs: pairs.slice(0, cap), total: pairs.length, truncated: pairs.length - cap }
}

// ---- 混淆对候选派生（#265：从题目共现挖候选，走提案，永不自动入册）----

/** 候选派生的输入：一个节点的题目（各自 invokes 的概念）与误解先验（错答侧涉及的概念）。
 * 纯数据面——读盘取材（题库 + 图）归调用方，本函数零 IO。 */
export interface CooccurrenceNode {
  node: string
  questions: Array<{ id?: string; q?: string; invokes?: unknown }>
  /** 节点的误解条目（误解先验）：concept = 该误解针对的概念（错答侧）。 */
  misconceptions?: Array<{ concept: string }>
}

/** 一条候选混淆对：a/b = 归一后的条目 canonical（无序对，a/b 只是提案里的书写向），
 * weight = 共现证据条数（排序用），evidence = 逐条可查的共现证据（人审据此判断）。 */
export interface ConfusableCandidate {
  a: string
  b: string
  weight: number
  evidence: string[]
}

/** 候选派生的单次产出上限（#265）：一次扫描最多产出多少条待审提案——人审队列是人的
 * 吞吐，一次倒 200 条等于没有队列；其余候选留待下次扫描（已产出的不重复堆）。 */
export const CONFUSABLE_CANDIDATE_MAX = 20

/** 无序概念对的稳定键（已声明判定与候选去重共用同一身份规则：排序后拼单键）。 */
export function conceptPairKey(a: string, b: string): string {
  return [a, b].sort().join('\u0000')
}

/** 已声明的易混对键集（无序；两端都可解析才算声明——悬空引用不算数，且**任一端废弃即
 * 退出候选面**：废弃条目不再被提名，ADR-0084 ②）。 */
export function declaredPairKeys(entries: ConceptEntry[]): Set<string> {
  const keys = new Set<string>()
  for (const e of entries) {
    for (const raw of e.confusable ?? []) {
      const other = resolveConcept(entries, raw)
      if (!other || other.canonical === e.canonical) continue
      if (isDeprecated(e) || isDeprecated(other)) continue
      keys.add(conceptPairKey(e.canonical, other.canonical))
    }
  }
  return keys
}

/** 混淆对候选派生（#265 纯函数）：从**题目共现**挖候选——① 同一节点题目各自 invokes 的
 * 概念对（同一节点的多道题各自指向不同概念 = 这些概念在同一个学习动作里被同时调用）；
 * ② 错答与正答涉及的概念对（节点误解先验的概念 vs 其题目 invokes 的概念）。两类都只吃
 * **在册且活跃**的概念名（未在册 = 悬空，废弃 = 退出候选面）；已声明的对不重复提名；
 * 自指对跳过。产出按 weight 降序、再按名字典序——**同输入同输出**（候选面也要可复现）。 */
export function confusableCandidates(
  nodes: CooccurrenceNode[], entries: ConceptEntry[],
): ConfusableCandidate[] {
  const declared = declaredPairKeys(entries)
  const canonicalOf = (name: unknown): string | null => {
    if (typeof name !== 'string' || !name.trim()) return null
    const hit = resolveConcept(entries, name.trim())
    if (!hit || isDeprecated(hit)) return null
    return hit.canonical
  }
  const acc = new Map<string, { a: string; b: string; evidence: string[] }>()
  const add = (first: string, second: string, line: string): void => {
    if (first === second) return
    const key = conceptPairKey(first, second)
    if (declared.has(key)) return
    const hit = acc.get(key) ?? { a: first, b: second, evidence: [] }
    if (!hit.evidence.includes(line)) hit.evidence.push(line)
    acc.set(key, hit)
  }
  for (const n of nodes) {
    // ① 同节点题目各自的 invokes 概念对
    const invoked: Array<{ qid: string; concept: string }> = []
    for (const q of n.questions) {
      const concept = canonicalOf(q.invokes)
      if (concept) invoked.push({ qid: q.id ?? q.q?.slice(0, 24) ?? '?', concept })
    }
    for (let i = 0; i < invoked.length; i++) {
      for (let j = i + 1; j < invoked.length; j++) {
        const x = invoked[i]!
        const y = invoked[j]!
        add(x.concept, y.concept,
          `节点「${n.node}」的题目间共现：${x.qid}→「${x.concept}」、${y.qid}→「${y.concept}」`)
      }
    }
    // ② 错答（误解先验）与正答（题目 invokes）涉及的概念对
    for (const m of n.misconceptions ?? []) {
      const wrong = canonicalOf(m.concept)
      if (!wrong) continue
      for (const x of invoked) {
        add(wrong, x.concept,
          `节点「${n.node}」的误解先验「${wrong}」与其题目 ${x.qid} 的 invokes「${x.concept}」`)
      }
    }
  }
  return [...acc.values()]
    .map(v => ({ a: v.a, b: v.b, weight: v.evidence.length, evidence: [...v.evidence].sort() }))
    .sort((x, y) => y.weight - x.weight || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
}

// ---- 近似名预检（#264：铸名软提示，不改精确撞名的硬拒）----

/** 近似名相似度阈值（字符 trigram Jaccard，与题目侧查重 #119 同算法族——同量纲、独立阈值：
 * 概念名短，0.6 已属「写法近似」）。 */
export const NEAR_NAME_THRESHOLD = 0.6

/** 一条近似名候选：本批铸名 name 与**在册**名字 existing 的相似度超阈值（父票裁决：
 * 预检对象是在册名字；批内近似重复不在本门，批内精确重复归 mintConflicts）。 */
export interface NearNameCandidate { name: string; existing: string; similarity: number }

/** 近似名预检（#264 纯函数）：对本批铸名的**每个新名**（canonical 与别名）与既有在册名字
 * （canonical ∪ 别名，含废弃条目——废弃地址仍占名位，撞上它同样是重复铸名）做字符级近似
 * 检测，超阈值即作候选回报。**软提示**：不改精确撞名的硬拒语义（精确相等那一类归
 * mintConflicts），命中也**不拒收**——由提交方自行决定改名或在提案里说明理由。 */
export function nearNameCandidates(
  mints: ConceptEntry[], existing: ConceptEntry[], threshold = NEAR_NAME_THRESHOLD,
): NearNameCandidate[] {
  const known = namesOf(existing)
  const out: NearNameCandidate[] = []
  const seen = new Set<string>()
  for (const m of mints) {
    for (const name of [m.canonical, ...(m.aliases ?? [])]) {
      for (const other of known) {
        if (other === name) continue // 精确撞名是硬拒门的业务（mintConflicts 报冲突）
        const similarity = trigramSimilarity(name, other)
        if (similarity < threshold) continue
        const key = `${name}\u0000${other}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ name, existing: other, similarity: round2(similarity) })
      }
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity || a.name.localeCompare(b.name) || a.existing.localeCompare(b.existing))
}

/** 近似名候选 → 可执行提示行（非阻；随受理回执回报，供提交方改名或说明）。 */
export function nearNameWarnings(candidates: NearNameCandidate[]): string[] {
  return candidates.map(c =>
    `近似名提示（非阻）：铸名「${c.name}」与在册名字「${c.existing}」写法近似（相似度 ${c.similarity}）——同一个概念就引用既有名字，确实是另一个概念就在提案 reason 里写明区别；精确撞名照样硬拒`)
}

// ---- 量级纪律（#264：与节点侧同规格的 WARN/ERROR 带）----

/** 量级告警带（#264）：别名条数与混淆对条数各两档——warn 越过收敛线、error 越过病态线。
 * 混淆对的 warn 带与注入上限对齐（越过 = 注入面已在截断）。 */
export const ALIAS_WARN_MAX = 4
export const ALIAS_ERROR_MAX = 8

export interface ConceptMagnitudeFinding {
  entry: string
  field: 'aliases' | 'confusable'
  count: number
  band: 'warn' | 'error'
  message: string
}

/** 量级告警（#264 纯函数）：逐条目量别名与混淆对条数，超出带即报一条。**只报不拦**——
 * 别名是历史地址（断读才是违约，见 ADR-0084 ②），量级是「该收敛了」的信号而不是门禁；
 * ERROR 带是更强的信号（病态量级），随人审回执与 data-check 呈现。 */
export function conceptMagnitudeFindings(entries: ConceptEntry[]): ConceptMagnitudeFinding[] {
  const out: ConceptMagnitudeFinding[] = []
  for (const e of entries) {
    const aliasCount = (e.aliases ?? []).length
    if (aliasCount > ALIAS_WARN_MAX) {
      out.push({
        entry: e.canonical, field: 'aliases', count: aliasCount,
        band: aliasCount > ALIAS_ERROR_MAX ? 'error' : 'warn',
        message: `概念「${e.canonical}」别名 ${aliasCount} 条（WARN 带 >${ALIAS_WARN_MAX}、ERROR 带 >${ALIAS_ERROR_MAX}）：一个身份挂了太多历史地址，考虑是否该并入/复用别的条目`,
      })
    }
    const confusableCount = (e.confusable ?? []).length
    if (confusableCount > CONFUSABLE_INJECT_CAP) {
      out.push({
        entry: e.canonical, field: 'confusable', count: confusableCount,
        band: confusableCount > CONFUSABLE_INJECT_CAP * 2 ? 'error' : 'warn',
        message: `概念「${e.canonical}」混淆对 ${confusableCount} 条（WARN 带 >${CONFUSABLE_INJECT_CAP}＝注入上限、ERROR 带 >${CONFUSABLE_INJECT_CAP * 2}）：注入面已按上限截断，先收敛再谈覆盖`,
      })
    }
  }
  return out
}

/** 量级告警行（读物：受理回执与体检共用同一文案面）。 */
export function conceptMagnitudeWarnings(entries: ConceptEntry[]): string[] {
  return conceptMagnitudeFindings(entries).map(f => `${f.band === 'error' ? 'ERROR 带' : 'WARN 带'}量级告警：${f.message}`)
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

/** 精确匹配解析：名字（canonical 或别名）→ 条目；未命中返回 null。永不模糊匹配。
 * 废弃条目不例外——历史记录用旧地址书写时必须仍解析得到（#262 的地址生命周期）。 */
export function resolveConcept(entries: ConceptEntry[], name: string): ConceptEntry | null {
  return entries.find(e => e.canonical === name || (e.aliases ?? []).includes(name)) ?? null
}

/** 废弃判定（#262）：条目被标记退役——保留全部别名解析，仅从生成注入面与候选面退出。
 * 可逆：清标记即完全恢复（写侧只落 true，false 等同缺席）。 */
export function isDeprecated(e: ConceptEntry): boolean {
  return e.deprecated === true
}

/** 活跃条目（生成注入面与候选面的取值域）：剔除废弃条目——它们地址仍解析，但不再产出。 */
export function activeEntries(entries: ConceptEntry[]): ConceptEntry[] {
  return entries.filter(e => !isDeprecated(e))
}

/** 废弃条目的全部名字（canonical ∪ 别名）：供「概念清单」这类名字面过滤——废弃地址
 * 仍解析，只是不再作为注入/候选产出。 */
export function deprecatedNames(entries: ConceptEntry[]): Set<string> {
  const out = new Set<string>()
  for (const e of entries) {
    if (!isDeprecated(e)) continue
    out.add(e.canonical)
    for (const a of e.aliases ?? []) out.add(a)
  }
  return out
}

/** 废弃标记翻转（纯函数，human 决策的执行核，与 mergeConceptEntries 同款）：按名字
 * （canonical 或别名）定位条目置/清 deprecated。清标记 = 删除字段（完全恢复，无残留）；
 * 未在册名字 = 错误不落盘。 */
export function setConceptDeprecated(
  entries: ConceptEntry[], name: string, deprecated: boolean,
): { errors: string[]; entries: ConceptEntry[] } {
  const idx = entries.findIndex(e => e.canonical === name || (e.aliases ?? []).includes(name))
  if (idx < 0) return { errors: [`「${name}」不在登记表在册（canonical/别名精确匹配）——废弃标记只对在册条目生效`], entries }
  const out = entries.map((e, i): ConceptEntry => {
    if (i !== idx) return e
    if (!deprecated) {
      const copy: ConceptEntry = { ...e }
      delete copy.deprecated
      return copy
    }
    return { ...e, deprecated: true }
  })
  return { errors: [], entries: out }
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

/** 题目是否带一枚 invokes 概念标注（#148 出生打标的共用谓词：受理门、补标轮、
 * 覆盖率投影四处同口径——缺席/空串/非字符串都算未标注）。 */
export function invokesTagged(q: { invokes?: unknown }): boolean {
  return typeof q.invokes === 'string' && !!q.invokes.trim()
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
    // confusable 并集（#232）：并入不丢易混对数据；自指/悬空项由消费侧解析时降级
    ...((dst.confusable?.length || src.confusable?.length)
      ? { confusable: [...new Set([...(dst.confusable ?? []), ...(src.confusable ?? [])])] }
      : {}),
  }
  const out = entries.filter((_, i) => i !== fromIdx && i !== intoIdx)
  out.push(merged) // 并入后的条目排在表尾：追加式演化，diff 友好
  return { errors: [], entries: out }
}

/** 一枚易混对入册（纯函数，#265 人审通过后的执行核）：把 b 写进 a 的 confusable。
 * **只写提案声明的那个方向**——ADR-0084 ③：写入侧不自动补双向（不无依据地造数据），
 * 单向是合法的**待复核态**；对称性由读侧呈现、人审补全。地址经精确解析归一，
 * 任一端不在册 = 错误不落盘；已声明的对幂等成功（重放安全）。 */
export function addConfusablePair(
  entries: ConceptEntry[], a: string, b: string,
): { errors: string[]; entries: ConceptEntry[]; changed: boolean } {
  const ea = resolveConcept(entries, a)
  const eb = resolveConcept(entries, b)
  if (!ea) return { errors: [`「${a}」不在登记表在册（canonical/别名精确匹配）——易混对只对在册条目生效`], entries, changed: false }
  if (!eb) return { errors: [`「${b}」不在登记表在册（canonical/别名精确匹配）——易混对只对在册条目生效`], entries, changed: false }
  if (ea.canonical === eb.canonical) {
    return { errors: [`「${b}」与「${a}」是同一条目——易混对需要两个不同条目`], entries, changed: false }
  }
  const key = conceptPairKey(ea.canonical, eb.canonical)
  if (declaredPairKeys(entries).has(key)) return { errors: [], entries, changed: false } // 已声明：幂等
  const out = entries.map(e => {
    if (e.canonical !== ea.canonical) return e
    const list = [...(e.confusable ?? []), b]
    return { ...e, confusable: list }
  })
  return { errors: [], entries: out, changed: true }
}

// ---- 治理回路：合并提案与混淆对候选提案（#265 / 父 #260）----

/** 合并提案面（#265 两段式的第一段）：from/into 是**书写地址**（canonical 或别名，提交时
 * 不做在册归一——提案可能基于旧登记表，归一留在受理门与 apply 双门各自对表）。
 * `irreversible: true` 恒在场 = 提案面**显式声明不可逆语义**；`irreversible_note`（选填）
 * 是不可逆全文（CONCEPT_MERGE_IRREVERSIBLE），受理引擎写入、apply 复核被篡改即拒。 */
export interface ConceptMergeProposalSpec {
  course: string
  from: string
  into: string
  reason?: string
  irreversible_note?: string
}

/** 合并不可逆声明（提案产物面与 apply 复核共用的同一句）。 */
export const CONCEPT_MERGE_IRREVERSIBLE = '合并不可逆：from 整条并入 into（canonical 降级为别名、名字并集），登记表不提供拆分——旧地址经别名续解析，条目禁删只并入（ADR-0084 ②）。'

const MERGE_KEYS = new Set(['course', 'from', 'into', 'reason', 'irreversible', 'irreversible_note'])

/** 合并提案产物 schema 门（形态；在册归一与撞名归受理门）。 */
export function validateConceptMergeProposal(doc: unknown): { errors?: string[]; spec?: ConceptMergeProposalSpec } {
  const errors: string[] = []
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { errors: ['(顶层): 必须是映射（{course, from, into, reason?}）'] }
  const d = doc as Record<string, unknown>
  const unknown = Object.keys(d).filter(k => !MERGE_KEYS.has(k))
  if (unknown.length) errors.push(`(顶层) 含未知字段 ${JSON.stringify(unknown)}（只允许 course/from/into/reason/irreversible）`)
  const course = typeof d.course === 'string' ? d.course.trim() : ''
  if (!course) errors.push('course: 不能为空')
  const from = typeof d.from === 'string' ? d.from.trim() : ''
  const into = typeof d.into === 'string' ? d.into.trim() : ''
  if (!from) errors.push('from: 不能为空（被并入条目的书写地址：canonical 或别名）')
  if (!into) errors.push('into: 不能为空（存续条目的书写地址：canonical 或别名）')
  if (from && into && from === into) errors.push('into: 不能与被并入的名字相同（合并需要两个不同条目）')
  if (d.reason !== undefined && (typeof d.reason !== 'string' || !d.reason.trim())) {
    errors.push('reason: 写了就给内容（合并是人的判断，理由供人审复核）')
  }
  if (d.irreversible !== undefined && d.irreversible !== true) {
    errors.push('irreversible: 只能是 true（合并不可逆是恒定语义，不接受关掉）')
  }
  if (d.irreversible_note !== undefined && d.irreversible_note !== CONCEPT_MERGE_IRREVERSIBLE) {
    errors.push('irreversible_note: 声明文本被篡改（只接受受理引擎写入的原文——不可逆语义不接受改写）')
  }
  if (errors.length) return { errors }
  return {
    spec: {
      course, from, into,
      ...(typeof d.reason === 'string' && d.reason.trim() ? { reason: d.reason.trim() } : {}),
      ...(d.irreversible_note === CONCEPT_MERGE_IRREVERSIBLE ? { irreversible_note: CONCEPT_MERGE_IRREVERSIBLE } : {}),
    },
  }
}

/** 混淆对候选提案面（#265）：a/b 是**归一后的条目 canonical**（候选由派生面产出，
 * 已过在册与废弃过滤）；evidence = 共现证据行（人审据此判断「是不是真易混」）。
 * 接受后**只写 a→b 一个方向**（ADR-0084 ③：单向合法，是待复核态）。 */
export interface ConfusableCandidateProposalSpec { course: string; a: string; b: string; evidence: string[]; reason?: string }

const CONFUSABLE_CANDIDATE_KEYS = new Set(['course', 'a', 'b', 'evidence', 'reason'])

/** 混淆对候选提案产物 schema 门（形态；在册与撞名归受理门与 apply 双门）。 */
export function validateConfusableCandidateProposal(doc: unknown): { errors?: string[]; spec?: ConfusableCandidateProposalSpec } {
  const errors: string[] = []
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { errors: ['(顶层): 必须是映射（{course, a, b, evidence, reason?}）'] }
  const d = doc as Record<string, unknown>
  const unknown = Object.keys(d).filter(k => !CONFUSABLE_CANDIDATE_KEYS.has(k))
  if (unknown.length) errors.push(`(顶层) 含未知字段 ${JSON.stringify(unknown)}（只允许 course/a/b/evidence/reason）`)
  const course = typeof d.course === 'string' ? d.course.trim() : ''
  if (!course) errors.push('course: 不能为空')
  const a = typeof d.a === 'string' ? d.a.trim() : ''
  const b = typeof d.b === 'string' ? d.b.trim() : ''
  if (!a) errors.push('a: 不能为空')
  if (!b) errors.push('b: 不能为空')
  if (a && a === b) errors.push('b: 不能与 a 相同（对需要两个不同概念）')
  let evidence: string[] = []
  if (!Array.isArray(d.evidence) || !d.evidence.length || d.evidence.some(e => typeof e !== 'string' || !e.trim())) {
    errors.push('evidence: 必须是非空字符串列表（候选必须有来源可查——共现证据是候选的立身之本）')
  } else {
    evidence = (d.evidence as string[]).map(e => e.trim())
  }
  if (errors.length) return { errors }
  return { spec: { course, a, b, evidence, ...(typeof d.reason === 'string' && d.reason.trim() ? { reason: d.reason.trim() } : {}) } }
}

/** 概念登记表读写：文件缺失 Missing 合法空态（load 返回空表）；存在但 YAML/契约坏
 * 抛 Broken（不静默当空表——名字唯一性是全部概念引用的地基，坏了必须 fail loud）。 */
export class ConceptRegistry {
  // 显式字段赋值（参数属性在 strip-only 单测模式下不可导入）
  private paths: Paths
  private fs: VaultFs
  constructor(paths: Paths, fs: VaultFs) {
    this.paths = paths
    this.fs = fs
  }

  /** 读登记表 → 条目列表（保序）。文件缺失返回 []（合法 Missing）；Broken 抛错。 */
  async load(root: string): Promise<ConceptEntry[]> {
    let raw: string
    try {
      raw = await this.fs.readFile(this.paths.conceptRegistryPath(root))
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
    await atomicWrite(this.paths.conceptRegistryPath(root), YAML.stringify({ concepts: entries }), this.fs)
  }

  /** 废弃标记翻转（human 决策执行面）：按名字（canonical 或别名）置/清 deprecated，
   * 清标记 = 字段删除完全恢复。失败抛错不改盘（登记表保持原样）。 */
  async setDeprecated(root: string, name: string, deprecated: boolean): Promise<{ canonical: string; deprecated: boolean }> {
    const entries = await this.load(root)
    const toggled = setConceptDeprecated(entries, name, deprecated)
    if (toggled.errors.length) {
      throw new Error(`[concept-deprecate] 废弃标记未执行（登记表保持原样）。\n${toggled.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    await this.save(root, toggled.entries)
    const hit = resolveConcept(toggled.entries, name)!
    return { canonical: hit.canonical, deprecated: isDeprecated(hit) }
  }

  /** 混淆对入册（human 确认的执行面，#265）：把 b 写进 a 的 confusable（只写一个方向，
   * 单向是待复核态，ADR-0084 ③）。已在册的对幂等成功。失败抛错不改盘。 */
  async addConfusable(root: string, a: string, b: string): Promise<{ a: string; b: string; changed: boolean }> {
    const entries = await this.load(root)
    const added = addConfusablePair(entries, a, b)
    if (added.errors.length) {
      throw new Error(`[concept-confusable] 易混对未入册（登记表保持原样）。\n${added.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    if (added.changed) await this.save(root, added.entries)
    const ea = resolveConcept(added.entries, a)!
    const eb = resolveConcept(added.entries, b)!
    return { a: ea.canonical, b: eb.canonical, changed: added.changed }
  }
}
