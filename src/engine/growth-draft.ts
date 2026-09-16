/**
 * 生长草稿缓存（#271 / ADR-0088 裁决 4）：执行官会话的草稿快照落盘——vault 旁挂
 * `courseStateDir(root)/草稿/<sessionId>.json` 原子写（每批结束写，非逐 op），带
 * 「非活图、非提案」标记、不进提案生命周期；同课程同一时刻至多一份在途草稿，新会话
 * 遇在途草稿默认续建；finish 发布成功或显式取消时删除；进程重启可续建。
 *
 * 本文件只管**形状与 IO**；重放与门序列住 proposals.ts（replayDraft / editGateErrors
 * ——草稿通过 = 门通过按构造成立），站编排住 growth-subsystem.ts（growth2.coachDraft）。
 */
import type { VaultFs } from './io.ts'
import { atomicWrite } from './io.ts'
import type { Paths } from './paths.ts'
import type { EditOp } from './proposals.ts'
import type { ConceptEntry } from './concepts.ts'

/** 执行官站的语料站标签（host STATIONS.growthDraft 引门面常量对齐；站名是受控词表）。 */
export const GROWTH_DRAFT_STATION = '教练执行'

/** 草稿文件的身份标记（读侧拒收非本格式文件的防呆面；「非活图、非提案」）。 */
export const GROWTH_DRAFT_MARKER = '生长草稿（非活图、非提案）'

/** 一条轮次日志（草稿快照的对话记忆面：续建时注入执行官上下文，恢复认知）。 */
export interface GrowthDraftRound {
  /** ISO 时刻。 */
  at: string
  kind: 'patch' | 'audit' | 'finish' | 'note'
  summary: string
  /** 该轮的门错误回灌（过门轮省略）。 */
  errors?: string[]
}

/** 草稿快照（水位模型，ADR-0088 裁决 3）：草稿持**累积 ops + 已发布水位**——
 * 内核对「基图 + ops[0..published)（已发布段）+ 未发布增量」重放；每次 finish 只把
 * `[水位, end)` 增量硬化为 EditProposalSpec 投给真实受理门 → graphPropose → graphApply；
 * 水位只在 apply 成功后前移；基图漂移（外部改了图）时 finish 拒收、零落盘、草稿保留。 */
export interface GrowthDraftDoc {
  marker: typeof GROWTH_DRAFT_MARKER
  version: 1
  course: string
  session_id: string
  /** 累积 ops（含已发布段；patch 追加、失败回滚零追加）。 */
  ops: EditOp[]
  /** 已发布水位：ops[0..published) 已随历次 finish 走完 propose→apply。 */
  published: number
  /** 批级铸名块（累积；随每次 finish 随批投递——applyConceptMints 对同条目幂等）。 */
  concepts: ConceptEntry[]
  /** 未发布增量的算子/理由区（下一次 finish 硬化为 note；置空即清）。 */
  note?: EditProposalNoteLite
  rounds: GrowthDraftRound[]
  created_at: string
  updated_at: string
}

/** note 区的落盘瘦身形态（与 GrowthNote 同构；avoid 引 proposals 的 GrowthNote 造成
 * 类型耦合——草稿缓存只关心可 JSON 化的取值）。 */
export interface EditProposalNoteLite {
  operator: string
  reason: string
  target_endpoints?: string[]
  disagreement?: string
}

/** 草稿目录：courseStateDir(root)/草稿/。 */
export function draftDirOf(paths: Paths, root: string): string {
  return `${paths.courseStateDir(root)}/草稿`
}

/** 草稿文件路径：courseStateDir(root)/草稿/<sessionId>.json。 */
export function draftPathOf(paths: Paths, root: string, sessionId: string): string {
  return `${draftDirOf(paths, root)}/${sessionId}.json`
}

/** 草稿快照解析（读侧防呆：marker 不符即拒收——「非活图、非提案」的文件不许被当草稿读）。 */
export function parseDraftDoc(raw: string): GrowthDraftDoc | null {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  const d = doc as Record<string, unknown> | null
  if (!d || d.marker !== GROWTH_DRAFT_MARKER || d.version !== 1) return null
  if (typeof d.course !== 'string' || typeof d.session_id !== 'string' || !Array.isArray(d.ops)) return null
  return d as unknown as GrowthDraftDoc
}

/** 读在途草稿（同课程单份在途；文件损坏/非本格式 = 无在途，不炸读侧）。 */
export async function loadDraft(fs: VaultFs, path: string): Promise<GrowthDraftDoc | null> {
  if (!fs.exists(path)) return null
  return parseDraftDoc(await fs.readFile(path))
}

/** 扫描在途草稿（同课程至多一份；目录 Missing/空 = null，合法空态）。多个文件在目录
 * 时取字典序最新（幂等自愈面——正常流程不会出现多份；残留旧文件由下次 finish/取消清场）。 */
export async function findActiveDraft(fs: VaultFs, paths: Paths, root: string): Promise<GrowthDraftDoc | null> {
  const dir = draftDirOf(paths, root)
  if (!fs.exists(dir)) return null
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort()
  for (const f of files.reverse()) {
    const doc = await loadDraft(fs, `${dir}/${f}`)
    if (doc) return doc
  }
  return null
}

/** 原子写快照（tmp + rename，同 engine atomicWrite 语义）。 */
export async function saveDraft(fs: VaultFs, path: string, doc: GrowthDraftDoc): Promise<void> {
  await atomicWrite(path, JSON.stringify(doc, null, 2), fs)
}

/** 删除草稿快照（finish 发布成功清场 / 显式取消；Missing 静默）。 */
export async function deleteDraft(fs: VaultFs, path: string): Promise<void> {
  if (fs.exists(path)) await fs.unlink(path).catch(() => undefined)
}
