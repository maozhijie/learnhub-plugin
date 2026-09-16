/**
 * Vault 先验上下文注入（V-2 / #106；#229 检索换核）：生成节点内容/题目时检索学习者
 * Vault 个人笔记，把相关摘录注入生成上下文，正文尊重「你已有的理解与记法」，不从零
 * 教已会内容。
 *
 * ## 换核边界（#229）
 *
 * 本节三件都落在这条边界内——**注入面不动**：注入段形态（`priorSection`）、注入位置、
 * 只读纪律都不变，只换检索核、并让检索过程可观测。
 *
 * 1. **BM25 式打分**：旧核是 `String.includes` 命中计分（标题 +3 / 正文 +1），无 IDF、
 *    无词频饱和、无长度归一——词面检索的范式下限是 BM25（BEIR 一类检索评测的常识），
 *    `includes` 连它都不是。新核 = Robertson–Spärck-Jones 式 IDF
 *    （`ln(1 + (N−df+0.5)/(df+0.5))`，恒正）× 词频饱和（k1）× 文档长度归一（b）+
 *    标题字段加权。**未调参**：本仓零相关性标注语料，k1/b 取文献常用默认值（1.2/0.75），
 *    「未调参」这件事本身如实登记在 ADR-0071——调参需要标注，那是另一张票。
 * 2. **查询扩展**：检索词先经概念登记表（#141）扩展——词面能解析到条目就并入其**别名**
 *    与**易混概念**（`confusable`，两档低权重）。动机是 Furnas 词表问题：检索词来自课程
 *    规范词表，学习者笔记里的私人记法恰在词表之外，「他明明记过」却零命中。扩展只做一级
 *    （别名的别名不并入——再扩一次词面就炸了），权重经 `PriorQueryTerm.weight` 进打分、
 *    来源经 `source` 留痕：扩展词是**召回线索不是同义断言**，所以低权重而非同权。
 * 3. **可观测性**：零命中、扫描面截断、结果面截断、命中文件清单收进 `VaultPriorAudit`
 *    随生成入口带出（ADR-0004 不静默纪律）：旧核零命中静默返回空串，个性化缺席没有任何
 *    信号——学习者无从知道「这次生成没读他的笔记」，更无从区分是没记过还是没检索到。
 *    顺带把 maxFiles 截断从「目录字典序前 N 篇」改成 **mtime 优先**：旧口径是系统性偏斜
 *    （胜出的永远是同一批目录名靠前的文件），而新近改动的笔记更可能是本次生成的先验。
 *
 * 前置探测结论（2026-09-09，票内裁决、#78 调研的回填）：宿主 dsh-llm / dsh-tools
 * （0.1.2-rc.1 导出面逐一核对：LlmRuntime/消息/错误与 ToolRuntime/工具定义）**没有
 * 本地检索/嵌入 API**——宿主能力不可得。票面降级菜单写「学习中心内检索或后置」，
 * 本实现取**引擎（学习中心）内自建纯扫描检索**、检索范围 = 全 vault 个人笔记：
 * 「学习中心外的个人笔记」恰是 V-2 要检索的对象，把范围缩到中心内文件等于自废；
 * 这也是 #78 调研的推荐路径（「引擎构造即持 vaultRoot，全 vault 文件扫描零新依赖，
 * 纯扫描降级路径足够」）。宿主未来提供嵌入能力时，可把 searchVaultPrior 换核，
 * 注入面（contentPack / questionGenerate*）不动。
 *
 * ADR-0010 只读纪律：检索对个人笔记零写入——只读文件内容，不建指纹、不进镜像区、
 * 不改 frontmatter；注入产物只进生成提示词（提示词落盘属提示词快照域，与个人笔记
 * 无关）。学习中心/ 与点目录整体排除（引擎管理区不是先验来源）。
 */
import type { VaultFs } from '../io.ts'
import { stripHtmlComments } from '../html-comments.ts'
import { stripFrontmatter, titleOfBody } from './note-source.ts'
import type { VaultPriorAudit } from '../types.ts'
import { resolveConcept } from '../concepts/concepts.ts'
import type { ConceptEntry, ConceptRegistry } from '../concepts/concepts.ts'

/** 一条 Vault 先验命中。 */
export interface VaultPriorHit {
  /** vault 相对路径（posix）。 */
  path: string
  title: string
  excerpt: string
  /** BM25 式分数（IDF × 词频饱和 × 长度归一 + 标题字段加权）；排序用，不外传语义。 */
  score: number
}

/** 检索词（分词 + 登记表扩展的产物）：权重进打分，来源供审计读数。 */
export interface PriorQueryTerm {
  text: string
  /** 打分权重：基础词 1；别名/易混概念低权重并入（召回线索不是同义断言）。 */
  weight: number
  source: 'base' | 'alias' | 'confusable'
}

export interface VaultPriorOptions {
  /** 最多返回条数（默认 3）。 */
  limit?: number
  /** 单条摘录最大字符数（默认 300）。 */
  excerptChars?: number
  /** 最多扫描文件数（防超大 vault 拖垮生成入口；默认 2000）。 */
  maxFiles?: number
}

export interface VaultPriorSearch {
  hits: VaultPriorHit[]
  audit: VaultPriorAudit
}

/** BM25 词频饱和参数与长度归一参数：文献常用默认值（k1=1.2 / b=0.75），本仓**未调参**
 * ——调参需要相关性标注语料，本仓零标注（如实登记在 ADR-0071）。改这两个数 = 改打分
 * 口径 = 改 ADR，不是「顺手调一下」。 */
export const BM25_K1 = 1.2
export const BM25_B = 0.75

/** 标题字段权重：标题命中比正文命中更能说明「这篇笔记就是讲这个的」。旧核的 +3/+1
 * 以字段加权形式保留（同一个数量关系，换成 IDF 加权后的场）。标题不做长度归一——
 * 标题是短字段，命中即信号，标题之间的字数差没有信息量。 */
export const TITLE_FIELD_BOOST = 3

/** 登记表扩展词权重：别名与易混概念是**召回扩展**，不是同义断言，故低权重并入
 * （别名比易混对更可信：前者是同一概念的另一叫法，后者只是相邻概念）。 */
export const ALIAS_TERM_WEIGHT = 0.5
export const CONFUSABLE_TERM_WEIGHT = 0.35

/** 收集窗口倍数：maxFiles 封的是**读取面**，收集面另有一个更宽的窗口
 * （`maxFiles × 本倍数`）——窗口外仍按目录字典序前段截取，因为 walk 的算力上界不能由
 * vault 规模决定（旧实现让 maxFiles 同时兼任这两件事，于是 mtime 优先无从谈起）。
 * 这是**上界**不是调优参数：它只决定「mtime 优先在多大范围内成立」。 */
export const MTIME_WINDOW_FACTOR = 10

/** 检索词 → 简单分词：按非文字字符切分，CJK 长词整体保留；全词 ≥2 字符才参与。 */
export function priorTerms(raw: string[]): string[] {
  const out: string[] = []
  for (const term of raw) {
    const t = term.trim()
    if (!t) continue
    for (const seg of t.split(/[\s/·、，,;；:：()（）\[\]{}-]+/)) {
      if (seg.length >= 2 && !out.includes(seg)) out.push(seg)
    }
  }
  return out
}

/** 命中处摘录：取首个命中位置周围窗口（前置 ~1/4、后置其余），行首行尾修齐。 */
export function excerptAround(body: string, term: string, chars: number): string {
  const at = body.indexOf(term)
  if (at < 0) return body.slice(0, chars).trim()
  const lead = Math.floor(chars / 4)
  const start = Math.max(0, at - lead)
  const end = Math.min(body.length, start + chars)
  return body.slice(start, end).trim()
}

/** 登记表扩展（#229 第二件）：基础词保底权重 1，命中条目的别名/易混概念低权重并入。
 * 同名取**更高**权重的那一档（基础词优于别名，别名优于易混对），故结果是每个词面唯一
 * 一条——打分面不会出现「同一个词算两遍」。扩展词不设长度门槛（登记表是人工受控词表，
 * 短别名是有意为之；普遍词的噪声由 IDF 抑制，不靠长度门槛）。 */
export function expandPriorTerms(terms: string[], entries: ConceptEntry[]): PriorQueryTerm[] {
  const out = new Map<string, PriorQueryTerm>()
  const put = (raw: string, weight: number, source: PriorQueryTerm['source']): void => {
    const text = raw.trim()
    if (!text) return
    const cur = out.get(text)
    if (cur && cur.weight >= weight) return
    out.set(text, { text, weight, source })
  }
  for (const t of terms) put(t, 1, 'base')
  for (const t of terms) {
    const entry = resolveConcept(entries, t)
    if (!entry) continue
    for (const a of entry.aliases ?? []) put(a, ALIAS_TERM_WEIGHT, 'alias')
    for (const c of entry.confusable ?? []) put(c, CONFUSABLE_TERM_WEIGHT, 'confusable')
  }
  return [...out.values()]
}

/** 生成入口派生检索词的**唯一出口**（分词 + 登记表扩展）：检索词口径只此一处，
 * 调用方不自己拼词表（两处各拼一份必然漂移）。 */
export function priorQueryTerms(raw: string[], entries: ConceptEntry[] = []): PriorQueryTerm[] {
  return expandPriorTerms(priorTerms(raw), entries)
}

/** 登记表条目读侧（三个检索入口共用）：登记表是**检索增益**不是生成前置——Broken 不拦
 * 生成（降级为基础词），但降级**绝不静默**：错误随审计带出（ADR-0004）。
 * 裁决理由：Broken 的登记表已由 data-check 与概念消费面（出题对表）报出，检索面再拦
 * 一道会把「可选增益」变成「生成前置」，代价与收益不成比例。 */
export async function queryEntriesFor(
  registry: Pick<ConceptRegistry, 'load'>, root: string,
): Promise<{ entries: ConceptEntry[]; error?: string }> {
  try {
    return { entries: await registry.load(root) }
  } catch (err) {
    return { entries: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** 一次检索的完整请求（三个入口共用同一实现）。 */
export interface PriorSearchRequest {
  /** 概念登记表读侧（查询扩展用；课程根，Missing 合法空表）。 */
  registry: Pick<ConceptRegistry, 'load'>
  /** 课程根（登记表所在课程的**目录名**，即 CourseEntry.root）；无课程（未指定目标
   * 课程）传 null——此时不做扩展（没有登记表可读），与「登记表 Broken」是两件事，
   * 后者要留痕。 */
  courseRoot: string | null
  vaultRoot: string
  /** 中心相对路径（`centerRoot` 相对 vault 根；调用方算好，本函数不碰 Paths）。 */
  centerRel: string
  /** 原始检索材料（未分词、未扩展）。 */
  raw: string[]
  fs: VaultFs
  opts?: VaultPriorOptions
}

/** 检索入口的**唯一实现**（登记表扩词 → BM25 扫描 → 审计合并）：三处各写一遍这段形状必然
 * 漂移——#229 code-review 实测抓出种子站曾拿课程**名**去读课程**根**的登记表（`name`「数学」
 * 与 `root`「math」是两个字段），扩展静默失效且无痕。合并到一处后「读哪张表、扩哪些词、
 * 错了怎么留痕」只有一个答案。 */
export async function runPriorSearch(req: PriorSearchRequest): Promise<VaultPriorSearch> {
  const { entries, error } = req.courseRoot === null
    ? { entries: [] as ConceptEntry[], error: undefined as string | undefined }
    : await queryEntriesFor(req.registry, req.courseRoot)
  const found = await searchVaultPrior(req.vaultRoot, req.centerRel, priorQueryTerms(req.raw, entries), req.opts ?? {}, req.fs)
  return error ? { hits: found.hits, audit: { ...found.audit, expansionError: error } } : found
}

/** 词面出现次数（非重叠计数；CJK 子串整体匹配，与旧核同口径的字符串匹配语义）。 */function occurrences(hay: string, needle: string): number {
  if (!needle || !hay) return 0
  let n = 0
  let at = hay.indexOf(needle)
  while (at >= 0) {
    n++
    at = hay.indexOf(needle, at + needle.length)
  }
  return n
}

/** 正文剥机器块：正文管线把 `<!-- enc_candidates: … -->` 写在节正文末尾，个人笔记
 * 抄录课程正文时会把机器块一并带进 vault。机器块是引擎元数据不是学习者的知识——
 * 留在正文里既污染检索打分（引擎文本命中检索词），又经摘录注入提示词成为「输出长
 * 这样」的活示范，串味进模型的 YAML 输出（大纲解析失败的曾见签名）。读入即剥；
 * 只剥机器块——学习者自己写的其它 HTML 注释是笔记内容，原样保留（CONTEXT.md
 * 「机器块」词条：机器块 ≠ 一般 HTML 注释）。 */
function stripMachineBlocks(text: string): string {
  return stripHtmlComments(text, body => body.trim().startsWith('enc_candidates')).trim()
}

/** 文件修改时刻（mtime 优先排序用）：读不到记 0（排到最后）——排序是增益面，
 * 单个文件 stat 失败不该让整个检索失败。 */
async function mtimeOf(fs: VaultFs, path: string): Promise<number> {
  try {
    return await fs.statMtimeMs(path)
  } catch {
    return 0
  }
}

/** 纯扫描检索（BM25 式打分核）：vault 根下全部 .md（排除学习中心与点目录），按
 * IDF × 词频饱和 × 长度归一 + 标题加权打分排序，返回命中与**审计**。
 * 只读——不写任何文件、不改任何状态。检索词为空或零命中时 hits 为空数组
 * （生成面零注入），但审计照出（zeroHit = true）。 */
export async function searchVaultPrior(
  vaultRoot: string, centerRel: string, terms: readonly PriorQueryTerm[], opts: VaultPriorOptions = {}, fs: VaultFs,
): Promise<VaultPriorSearch> {
  const limit = opts.limit ?? 3
  const chars = opts.excerptChars ?? 300
  const maxFiles = opts.maxFiles ?? 2000
  if (!terms.length) {
    return {
      hits: [],
      audit: {
        terms: [], expanded: [], scanned: 0, matched: 0,
        scanTruncated: false, hitsTrimmed: false, zeroHit: true, hitPaths: [],
      },
    }
  }
  const excludePrefix = `${vaultRoot}/${centerRel}`
  const collectCap = maxFiles * MTIME_WINDOW_FACTOR
  const files: string[] = []
  let overflow = false
  async function walk(dir: string): Promise<void> {
    if (files.length >= collectCap) {
      overflow = true
      return
    }
    let entries
    try {
      entries = await fs.readdirTypes(dir)
    } catch {
      return // 目录不可读（权限/消失）：静默跳过——检索是尽力而为的增益，不是契约读
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= collectCap) {
        overflow = true
        return
      }
      const child = `${dir}/${ent.name}`
      if (ent.directory) {
        if (ent.name.startsWith('.')) continue
        await walk(child)
      } else if (!ent.directory && ent.name.toLowerCase().endsWith('.md')) {
        if (child === excludePrefix || child.startsWith(`${excludePrefix}/`)) continue
        files.push(child)
      }
    }
  }
  await walk(vaultRoot)

  // mtime 优先（#229 顺带）：读取面被 maxFiles 封顶时取**最近改动**的那些文件——旧口径
  // 按目录字典序取前 N，胜出的永远是同一批目录名靠前的文件（系统性偏斜）。并列按路径
  // 定序（mtime 同毫秒时仍有确定结果）。未触顶时根本不看 mtime：常见路径零额外 IO。
  const scanTruncated = overflow || files.length > maxFiles
  let picked = files
  if (files.length > maxFiles) {
    const stamped = await Promise.all(files.map(async p => ({ p, t: await mtimeOf(fs, p) })))
    stamped.sort((a, b) => b.t - a.t || a.p.localeCompare(b.p))
    picked = stamped.slice(0, maxFiles).map(x => x.p)
  }

  // 一遍扫面：命中文件的词频与文档长度。df 只需命中文件的计数——未命中文件词频恒 0，
  // 不进 df；但 **N 与平均长度取全部读到的文件**（BM25 的 N/avgdl 是集合级量，只拿
  // 命中面算会把 IDF 与长度归一的基准挪到命中面上）。
  interface Doc { path: string; title: string; body: string; len: number; tf: number[]; tfTitle: number[] }
  const docs: Doc[] = []
  const df = new Array<number>(terms.length).fill(0)
  let scanned = 0
  let totalLen = 0
  for (const abs of picked) {
    let raw: string
    try {
      raw = await fs.readFile(abs)
    } catch {
      continue
    }
    const body = stripMachineBlocks(stripFrontmatter(raw))
    const title = titleOfBody(body, abs.split('/').pop() ?? abs)
    scanned++
    totalLen += body.length
    const tf = terms.map(t => occurrences(body, t.text))
    const tfTitle = terms.map(t => occurrences(title, t.text))
    let matched = false
    for (let i = 0; i < terms.length; i++) {
      if (tf[i]! > 0 || tfTitle[i]! > 0) {
        df[i]!++
        matched = true
      }
    }
    if (matched) docs.push({ path: abs.slice(vaultRoot.length + 1), title, body, len: body.length, tf, tfTitle })
  }

  const avgdl = scanned > 0 ? totalLen / scanned : 0
  const idf = df.map(d => Math.log(1 + (scanned - d + 0.5) / (d + 0.5)))
  const scored = docs.map(d => {
    let score = 0
    let anchor = -1
    let anchorWeight = 0
    for (let i = 0; i < terms.length; i++) {
      const tf = d.tf[i]!
      const tfTitle = d.tfTitle[i]!
      if (!tf && !tfTitle) continue
      // 长度归一：长文档里的同样词频信息量更低（avgdl 为 0 的退化集合不做归一）
      const norm = avgdl > 0 ? 1 - BM25_B + BM25_B * (d.len / avgdl) : 1
      const sat = norm > 0 ? (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm) : 0
      const weighted = terms[i]!.weight * idf[i]!
      score += weighted * (sat + (tfTitle ? TITLE_FIELD_BOOST : 0))
      // 摘录窗口对准**信息量最高**的命中词（权重 × IDF 最大者）：旧核取「词表里第一个
      // 命中的词」，摘录段落随词表顺序漂移——同一篇笔记换个词序摘出来的就不是同一段
      if (weighted > anchorWeight) {
        anchorWeight = weighted
        anchor = i
      }
    }
    return { ...d, score, anchor: terms[anchor >= 0 ? anchor : 0]!.text }
  })
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  const top = scored.slice(0, limit)
  return {
    hits: top.map(d => ({ path: d.path, title: d.title, excerpt: excerptAround(d.body, d.anchor, chars), score: d.score })),
    audit: {
      terms: terms.filter(t => t.source === 'base').map(t => t.text),
      expanded: terms.filter(t => t.source !== 'base').map(t => t.text),
      scanned,
      matched: scored.length,
      scanTruncated,
      hitsTrimmed: scored.length > limit,
      zeroHit: scored.length === 0,
      hitPaths: top.map(d => d.path),
    },
  }
}

/** 命中 → 生成提示词注入段；零命中返回 ''（调用方原样拼接即可）。
 * 指令锁两件事：尊重已有理解与记法（不从零教）；只读先验（不假设学习者笔记可改、
 * 不假装学习者「应该」知道——摘录只是他记过的东西）。 */
export function priorSection(hits: VaultPriorHit[]): string {
  if (!hits.length) return ''
  const items = hits.map(h => `- 《${h.title}》（${h.path}）\n  > ${h.excerpt.replaceAll('\n', '\n  > ')}`).join('\n')
  return `## 学习者已有理解（Vault 先验）

以下是学习者个人 Vault 里与本节点相关的笔记摘录（只读检索所得）：

${items}

写作要求：正文尊重学习者已有的理解与记法——他已经会的不从零教，术语与记法沿用其笔记写法；记法与课程规范冲突时显式指出分歧并给出规范写法。这些笔记属于学习者，永不改写。`
}
