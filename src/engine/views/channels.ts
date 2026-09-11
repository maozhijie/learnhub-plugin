/**
 * 通道域视图类型（C1 笔记复习源 / C2 Anki 通道，#152 刀 3 自 views.ts 归档）。
 */

// ---- Anki 通道（C2 #63 / ADR-0011；ankiStatus）----

/** Anki 通道状态：镜象规模/最近推送与导入/当前到期分布 + AnkiConnect 可达性。 */
export interface AnkiStatusDoc {
  date: string
  mirror: { entries: number; last_push: string | null; last_import: string | null; decks: string[] }
  due: { total: number; by_deck: Array<{ deck: string; count: number }> }
  /** AnkiConnect 可达性（仅传入 transport 时探测）。 */
  anki?: { connected: boolean; error?: string }
}

// ---- C1 笔记复习源（#59 / ADR-0010；noteSourceList / noteSourceRegister）----

/** 笔记源状态（note-source.NoteSourceStatus 的视图镜像）。 */
export type NoteSourceStatus = 'ok' | 'missing' | 'drifted' | 'inconsistent'

/** 笔记源清单条目（C1 #59）：注册身份 × 指纹状态 × 卡池概况。 */
export interface NoteSourceItem {
  id: string
  path: string
  title: string
  enabled: boolean
  created: string
  /** ok 正常 / drifted 漂移（可重出或归档旧题）/ missing 缺失（重注册或解除）/ inconsistent 镜象不一致。 */
  status: NoteSourceStatus
  cards: number
  due: number
  hint?: string
  /** 题库镜像 Broken 时为 true（hint 带原因）。 */
  broken?: true
}

/** 笔记源清单（noteSourceList）。excludes = 用户排除清单（V-1 #86，只管未来注册）。 */
export interface NoteSourceDoc {
  date: string
  total: number
  excludes: string[]
  sources: NoteSourceItem[]
}

/** 笔记源注册（noteSourceRegister）：单篇 .md 或文件夹批量登记；随响应带回最新清单。
 * skipped = 被跳过条目数（排除清单命中 + 学习中心内部文件）；skipped_paths 仅在有
 * 跳过时带回（vault 相对，混合两类）。 */
export interface NoteSourceRegisterResult {
  date: string
  registered: number
  updated: number
  skipped: number
  sources: NoteSourceItem[]
  skipped_paths?: string[]
}
