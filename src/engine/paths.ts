/**
 * 学习中心统一定位（吸收自 Python paths.py）。
 *
 * 两级路径：中心级（学习中心/：注册表、会话工作单、state 流水、提案、日志）与
 * 课程级（学习中心/<root>/：data/ 课程/ state/、审计报告、就绪清单）。
 * 全部由构造注入的 centerRoot 派生，无全局可变状态。
 */

/** Windows 非法字符与正斜杠 → 全角替换（节点改名必须走 graph apply-edit 的 rename op）。 */
const FW_MAP: Record<string, string> = {
  '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？',
  '"': '＂', '<': '＜', '>': '＞', '|': '｜',
}

/** 学习产物输出区目录名（V-3 #107；output.ts 注册豁免判定共用同一常量）。 */
export const OUTPUT_DIR_NAME = '我的产出'

/** 节点名 → 安全文件名（不含扩展名）。 */
export function safeFilename(name: string): string {
  return [...name].map(c => FW_MAP[c] ?? c).join('')
}

export class Paths {
  // 显式字段赋值（参数属性在 strip-only 单测模式下不可导入）
  readonly centerRoot: string
  constructor(centerRoot: string) {
    this.centerRoot = centerRoot
  }

  // ---- 中心级 ----
  get registryPath(): string { return `${this.centerRoot}/课程注册表.yaml` }
  get sessionDir(): string { return `${this.centerRoot}/会话` }
  get centerStateDir(): string { return `${this.centerRoot}/state` }
  get journalPath(): string { return `${this.centerStateDir}/journal.jsonl` }
  get practicePath(): string { return `${this.centerStateDir}/practice.jsonl` }
  get reviewLogPath(): string { return `${this.centerStateDir}/review-log.jsonl` }
  get proposalsPath(): string { return `${this.centerStateDir}/proposals.json` }
  get proposalDir(): string { return `${this.centerStateDir}/proposals` }
  get snapshotDir(): string { return `${this.centerStateDir}/snapshots` }
  get dashboardPath(): string { return `${this.centerRoot}/学习仪表盘.md` }
  get recoveryStatePath(): string { return `${this.centerStateDir}/recovery_state.json` }
  get runLogPath(): string { return `${this.centerStateDir}/运行日志.md` }
  get promptDir(): string { return `${this.centerStateDir}/提示词` }
  get learnhubConfigPath(): string { return `${this.centerStateDir}/learnhub.json` }
  get genJobsPath(): string { return `${this.centerStateDir}/生成任务.json` }
  /** 「今天学它」pin 清单（E3 #67）：中心级 [{course,node,date}]，过期自动失效。 */
  get pinPath(): string { return `${this.centerStateDir}/今日pin.json` }
  /** 「过于简单」建议忽略清单（B2 / ADR-0032 同期）：被持久忽略的建议定位。 */
  get adviceDismissPath(): string { return `${this.centerStateDir}/难度建议忽略.json` }
  /** 难度带会话日志（E5 #65）：JSONL 追加，困难教练的长期选择分布数据源。 */
  get bandLogPath(): string { return `${this.centerStateDir}/难度带.jsonl` }
  /** E 档案（ADR-0009 Learner Output 判词存档；#68 E2）：JSONL 追加，判词只入档案不 canonical。 */
  get eArchivePath(): string { return `${this.centerStateDir}/e档案.jsonl` }
  /** N-of-1 实验定义（D-1 #110 / ADR-0023）：whole-file 原子写；臂标注进复习日志，
   * 本文件只存实验定义与状态。 */
  get experimentsPath(): string { return `${this.centerStateDir}/实验.json` }
  /** 回执流水（U-1 #88 / ADR-0016）：JSONL 追加，学习者证据账本——只增不回滚。 */
  get receiptLogPath(): string { return `${this.centerStateDir}/回执.jsonl` }
  /** 判卷失败留痕（#116）：AI 判卷解析失败时原始模型输出的专项留档（JSONL 追加）。 */
  get gradingFailurePath(): string { return `${this.centerStateDir}/判卷失败.jsonl` }
  /** 勘误冲正流水（ADR-0031）：对已落盘作答判罚的抵消记录（JSONL 追加，只增）；
   * 聚合账读侧按净值读，FSRS/review-log 不冲正。 */
  get erratumLogPath(): string { return `${this.centerStateDir}/勘误.jsonl` }
  /** 习惯重复流（U-3 #90 / ADR-0017）：JSONL 追加，自报重复即事实；曲线/streak 派生。 */
  get habitRepeatLogPath(): string { return `${this.centerStateDir}/习惯重复.jsonl` }
  /** 技能条目（U-2 #89 / ADR-0018）：学习中心/技能/<id>.yaml，lane 载体（不复用题目卡）。 */
  get skillsDir(): string { return `${this.centerRoot}/技能` }
  skillPath(id: string): string { return `${this.skillsDir}/${safeFilename(id)}.yaml` }
  /** 习惯（U-3 #90 / ADR-0017）：学习中心/习惯/<id>.yaml，一等实体（零 FSRS 语义）。 */
  get habitsDir(): string { return `${this.centerRoot}/习惯` }
  habitPath(id: string): string { return `${this.habitsDir}/${safeFilename(id)}.yaml` }
  /** 笔记源自料区（C1 #59 / ADR-0010）：镜像区，用户笔记零写入。 */
  get noteSourceDir(): string { return `${this.centerRoot}/笔记源` }
  get noteSourceManifestPath(): string { return `${this.noteSourceDir}/源清单.yaml` }
  /** 学习者产出卡域（E1 #45/#68）：课程根/我的卡/<节点>.yaml，独立门禁独立调度。 */
  learnerCardsDir(root: string): string { return `${this.courseRoot(root)}/我的卡` }
  /** Anki 镜象（C2 #63 / ADR-0011）：中心级 anki/镜象.json——可丢弃派生状态，
   * 记录 key↔noteId 归属与导入水位，坏档静默重建不判 Broken。 */
  get ankiMirrorPath(): string { return `${this.centerRoot}/anki/镜象.json` }
  get trashDir(): string { return `${this.centerRoot}/.trash` }

  sessionPath(dateStr: string): string { return `${this.sessionDir}/${dateStr}.md` }

  proposalArtifactPath(pid: number, kind: string, course: string): string {
    return `${this.proposalDir}/${pid}-${kind}-${course}.yaml`
  }

  snapshotPath(course: string, version: number): string {
    return `${this.snapshotDir}/${course}-v${version}.json`
  }

  // ---- 课程级 ----
  courseRoot(root: string): string { return `${this.centerRoot}/${root}` }
  /** 题库目录（question-bank 的 <课程根>/题库/<节点>.yaml）。 */
  bankDir(root: string): string { return `${this.courseRoot(root)}/题库` }
  dataDir(root: string): string { return `${this.courseRoot(root)}/data` }
  courseDir(root: string): string { return `${this.courseRoot(root)}/课程` }
  statusPath(root: string): string { return `${this.courseRoot(root)}/进度.md` }
  readyPath(root: string): string { return `${this.courseRoot(root)}/就绪清单.md` }
  reportPath(root: string): string { return `${this.courseRoot(root)}/审计报告.md` }
  courseStateDir(root: string): string { return `${this.courseRoot(root)}/state` }
  queuePath(root: string): string { return `${this.courseStateDir(root)}/生成队列.md` }
  fsrsParamsPath(root: string): string { return `${this.courseStateDir(root)}/fsrs参数.json` }

  /** 课程文件规范路径：课程/<区名>/<节点名>.md。 */
  courseNotePath(root: string, regionName: string, nodeName: string): string {
    return `${this.courseDir(root)}/${safeFilename(regionName)}/${safeFilename(nodeName)}.md`
  }

  // ---- 项目区（P 区 / ADR-0015：Project 是 Course 姊妹实体，工作区按 #92 设计文档布局） ----
  get projectsDir(): string { return `${this.centerRoot}/projects` }
  projectDir(id: string): string { return `${this.projectsDir}/${safeFilename(id)}` }
  projectNotePath(id: string): string { return `${this.projectDir(id)}/项目.md` }
  projectMilestoneDir(id: string): string { return `${this.projectDir(id)}/milestones` }
  projectMilestonePath(id: string, file: string): string { return `${this.projectMilestoneDir(id)}/${file}` }
  /** 学习产物输出区（V-3 #107）：复盘稿/讲解稿/错误卡/周复盘的引擎专属输出区；
   * 只出链指向个人笔记，永不改写个人文件（ADR-0010）。 */
  get outputDir(): string { return `${this.centerRoot}/${OUTPUT_DIR_NAME}` }
  outputKindDir(kind: string): string { return `${this.outputDir}/${safeFilename(kind)}` }
  /** 项目日志（V-5 #113，设计文档预留位）：学习者自由记录，可注册为笔记源复习。 */
  projectLogPath(id: string): string { return `${this.projectDir(id)}/日志.md` }
  /** 项目回执镜像（V-5 #113）：关联节点回执的可读落盘副本（canonical 流水仍在中心 state）。 */
  projectReceiptDir(id: string): string { return `${this.projectDir(id)}/回执` }
  /** 项目域提案快照（被替换的计划 YAML / 里程碑产物旧文；state/snapshots/ 全留痕）。 */
  projectSnapshotPath(pid: number, what: string): string { return `${this.snapshotDir}/project-${pid}-${what}` }
  /** 检索点会话流水（#93：抽题+自述 JSONL 追加；项目域自有数据，零 journal/FSRS 写入）。 */
  projectRecallPath(id: string): string { return `${this.projectDir(id)}/recall.jsonl` }
  /** 项目执行事件流（P-7 #98 / ADR-0015 §4：项目自己的事件=真实执行+表现评级，喂
   * 渐退档提议与 2×2 诊断；与节点练习证据通道是两条流——回流单向复制，零共享存储）。 */
  projectExecPath(id: string): string { return `${this.projectDir(id)}/exec.jsonl` }
}
