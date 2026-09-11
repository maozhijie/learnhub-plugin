/**
 * content 域视图类型（#152 刀归档；叶子文件，只引类型层）。
 */

/** 作答结算（questionAnswer）。课程题库通道与笔记源卡通道共用：
 * explanation/mastery/xp_reason 仅课程题库通道返回（笔记源无节点证据与 settle）。 */
export interface AnswerResult {
  correct: boolean
  /** 判卷分（0-100 整数）。 */
  score: number
  feedback: string
  /** 错题公布答案（allo answer_review 语义的题型化展示）。 */
  answer: string
  kind: QuestionKind
  /** 该题新到期日（挂起/同日重复 = 原值）。 */
  due: string | null
  /** 本次作答是否推进了该题 FSRS 调度（每题每天至多一次；自评挂起视为未推进）。 */
  scheduled: boolean
  /** 复习刷卡流答对挂起（deferSchedule）：previews 给出三档自评的下次到期预览。 */
  pendingRating: boolean
  previews?: { hard: string; good: string; easy: string }
  /** XP 时间账本结算（笔记源卡恒 0——复习自评语义不含 XP）。 */
  xp: number
  explanation?: string
  /** 节点聚合掌握度（口径 B；笔记源无节点，缺省）。 */
  mastery?: number
  xp_reason?: 'correct' | 'wrong' | 'guess' | 'repeat'
  /** 判错差异摘要（规则题判错时携带）：点名「漏选了 A / 多选了 C / 从第 2 项起顺序不对」，
   * 让判错反馈能对上学习者的作答（ADR-0031）。 */
  diff?: string
  /** probation 在途行使闸（#146）：实验中的插入节点——作答只记流不回流练习证据。 */
  evidence_gated?: true
}

/** 忘记申报（questionForget）：不作答直接翻面，调度与统计按答错记，0 XP。 */
export interface QuestionForgetResult {
  correct: false
  judge: 'forget'
  feedback: string
  answer: string
  explanation: string
  kind: QuestionKind
  due: string
  scheduled: true
  /** 节点聚合掌握度（课程题库通道；笔记源无节点，缺省）。 */
  mastery?: number
  xp: 0
  /** probation 在途行使闸（#146）：实验中的插入节点——忘记只记流不回流练习证据。 */
  evidence_gated?: true
}

/** 自评结算（questionRate）：复习刷卡流答对后的 Hard/Good/Easy 推卡。 */
export interface QuestionRateResult {
  course: string
  node: string
  qid: string
  rating: number
  /** 推卡后的新到期日。 */
  due: string
  scheduled: true
  /** 节点聚合掌握度（课程题库通道；笔记源无节点，缺省）。 */
  mastery?: number
}
