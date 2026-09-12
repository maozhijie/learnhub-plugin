/**
 * 追加流水清单——单点登记处（#195 / ADR-0053）：全部**有读侧**的追加流水（JSONL）
 * 在此列册，dataCheck 的 evidence_streams area 逐流盘点（present + 条目数进
 * inventory、中段坏行 Broken finding、撕裂尾行 hint finding、缺失合法空态不报）。
 *
 * 新增流水 = paths.ts 加路径成员 + 这里加一条 + tests/jsonl-contract.test.ts 的
 * 登记处守卫会强制对账（paths.ts 上出现 .jsonl 路径成员而未列册/未豁免即红）——
 * 盘点清单不随流水增长漂移。无读侧的纯留痕流（覆盖层.jsonl、判卷失败.jsonl）
 * 不列册，在守卫的豁免表里显式点名。
 */
import type { Paths } from './paths.ts'

/** 展开半径：center 全中心一份；course 每注册课程一份；project 每项目目录一份。 */
export type EvidenceStreamScope = 'center' | 'course' | 'project'

export interface EvidenceStreamDef {
  /** 机读流名：进 inventory.stream 与 finding location，同时作读侧原语 label
   * （与各消费方 readJsonlLines 的 label 保持同串，错误文案前缀全库一致）。 */
  stream: string
  scope: EvidenceStreamScope
  /** paths.ts 上的路径成员名——登记处守卫按它与 paths.ts 的 .jsonl 成员对账。 */
  getter: string
  pathOf(paths: Paths, id: string): string
}

export const EVIDENCE_STREAMS: EvidenceStreamDef[] = [
  { stream: 'journal', scope: 'center', getter: 'journalPath', pathOf: p => p.journalPath },
  { stream: 'practice', scope: 'center', getter: 'practicePath', pathOf: p => p.practicePath },
  { stream: 'review-log', scope: 'center', getter: 'reviewLogPath', pathOf: p => p.reviewLogPath },
  { stream: 'band-log', scope: 'center', getter: 'bandLogPath', pathOf: p => p.bandLogPath },
  { stream: 'receipts', scope: 'center', getter: 'receiptLogPath', pathOf: p => p.receiptLogPath },
  { stream: 'e-archive', scope: 'center', getter: 'eArchivePath', pathOf: p => p.eArchivePath },
  { stream: 'erratum', scope: 'center', getter: 'erratumLogPath', pathOf: p => p.erratumLogPath },
  { stream: 'habit-repeats', scope: 'center', getter: 'habitRepeatLogPath', pathOf: p => p.habitRepeatLogPath },
  { stream: 'sediment', scope: 'center', getter: 'sedimentPath', pathOf: p => p.sedimentPath },
  { stream: 'probation', scope: 'course', getter: 'probationLedgerPath', pathOf: (p, root) => p.probationLedgerPath(root) },
  { stream: 'exec', scope: 'project', getter: 'projectExecPath', pathOf: (p, id) => p.projectExecPath(id) },
  { stream: 'recall', scope: 'project', getter: 'projectRecallPath', pathOf: (p, id) => p.projectRecallPath(id) },
]
