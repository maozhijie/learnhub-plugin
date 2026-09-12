/**
 * Vault 先验上下文注入（V-2 / #106）：生成节点内容/题目时检索学习者 Vault 个人笔记，
 * 把相关摘录注入生成上下文，正文尊重「你已有的理解与记法」，不从零教已会内容。
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
import type { VaultFs } from './io.ts'
import { stripHtmlComments } from './html-comments.ts'
import { stripFrontmatter, titleOfBody } from './note-source.ts'

/** 一条 Vault 先验命中。 */
export interface VaultPriorHit {
  /** vault 相对路径（posix）。 */
  path: string
  title: string
  excerpt: string
  /** 命中得粗分（标题命中权重高）；排序用，不外传语义。 */
  score: number
}

export interface VaultPriorOptions {
  /** 最多返回条数（默认 3）。 */
  limit?: number
  /** 单条摘录最大字符数（默认 300）。 */
  excerptChars?: number
  /** 最多扫描文件数（防超大 vault 拖垮生成入口；默认 2000）。 */
  maxFiles?: number
}

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

/** 正文剥机器块：正文管线把 `<!-- enc_candidates: … -->` 写在节正文末尾，个人笔记
 * 抄录课程正文时会把机器块一并带进 vault。机器块是引擎元数据不是学习者的知识——
 * 留在正文里既污染检索打分（引擎文本命中检索词），又经摘录注入提示词成为「输出长
 * 这样」的活示范，串味进模型的 YAML 输出（大纲解析失败的曾见签名）。读入即剥；
 * 只剥机器块——学习者自己写的其它 HTML 注释是笔记内容，原样保留（CONTEXT.md
 * 「机器块」词条：机器块 ≠ 一般 HTML 注释）。 */
function stripMachineBlocks(text: string): string {
  return stripHtmlComments(text, { matching: body => body.trim().startsWith('enc_candidates') }).trim()
}

/** 纯扫描检索：vault 根下全部 .md（排除学习中心与点目录），按检索词命中粗分排序。
 * 只读——不写任何文件、不改任何状态。找不到检索词命中时返回 []（生成面零注入）。 */
export async function searchVaultPrior(
  vaultRoot: string, centerRel: string, terms: string[], opts: VaultPriorOptions = {}, fs: VaultFs,
): Promise<VaultPriorHit[]> {
  if (!terms.length) return []
  const limit = opts.limit ?? 3
  const chars = opts.excerptChars ?? 300
  const maxFiles = opts.maxFiles ?? 2000
  const excludePrefix = `${vaultRoot}/${centerRel}`
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return
    let entries
    try {
      entries = await fs.readdirTypes(dir)
    } catch {
      return // 目录不可读（权限/消失）：静默跳过——检索是尽力而为的增益，不是契约读
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) return
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
  const hits: VaultPriorHit[] = []
  for (const abs of files) {
    let raw: string
    try {
      raw = await fs.readFile(abs)
    } catch {
      continue
    }
    const body = stripMachineBlocks(stripFrontmatter(raw))
    const title = titleOfBody(body, abs.split('/').pop() ?? abs)
    let score = 0
    let firstTerm = ''
    for (const t of terms) {
      const inTitle = title.includes(t)
      const inBody = body.includes(t)
      if (inTitle) score += 3
      if (inBody) score += 1
      if ((inTitle || inBody) && !firstTerm) firstTerm = t
    }
    if (score <= 0) continue
    hits.push({
      path: abs.slice(vaultRoot.length + 1),
      title,
      excerpt: excerptAround(body, firstTerm || terms[0], chars),
      score,
    })
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit)
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
