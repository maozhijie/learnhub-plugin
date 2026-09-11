/**
 * 写入单元（#176 / ADR-0046）：数据面是「多处权威 + 约定协调」，跨文件一致性过去
 * 散布在各域的顺序约定注释里。本原语把那些约定搬成**声明**——一次操作把要落的多处收成
 * 有序步骤列表，按声明顺序执行，末尾追加一条 journal。只做三件事：
 *
 *   1. 按声明顺序执行（顺序是领域知识，本原语只记录并强制「声明顺序＝执行顺序」）；
 *   2. 强制每步幂等：声明了 done 判据的步骤，done()===true 即续段跳过（「已存在即
 *      续段」模式的原语化）；没声明 done 的步骤每次都执行——原语不替域推断幂等；
 *   3. 末尾追加一条 journal（全部步骤成功后恰一条；失败不写）。
 *
 * 失败行为（与各域既有顺序约定注释的今天语义逐条对齐）：步骤 k 抛错 → 异常上抛中止，
 * 前面已写的步骤留在盘上——不回滚、不续跑、失败不写 journal；恢复走既有
 * dataCheck／doctor／rebuild 与各域自己的幂等门/重验门。
 *
 * journal sink：复用既有 state/journal.jsonl（store.appendJournal，零新工件；
 * ADR-0046 的「既有 JSONL 流水」支）。ts 经 Clock 端口（#175 阶段①）。
 */
import { nowIsoOf } from './dates.ts'
import type { Clock } from './clock.ts'
import type { JournalRec } from './types.ts'

/** 写入单元的一个步骤：有名字（journal 清单可读）、有落盘动作、可选的幂等判据。 */
export interface WriteStep {
  /** 步骤名——journal 的 steps 清单用它回答「落了几笔、顺序如何」。 */
  name: string
  /** 落盘动作。 */
  run: () => Promise<void>
  /** 幂等判据（域自声明）：返回 true = 已存在，续段跳过。省略 = 每次都执行。 */
  done?: () => Promise<boolean>
}

export interface WriteUnitReport {
  op: string
  course: string
  steps: Array<{ name: string; status: 'done' | 'skipped' }>
}

/** 执行一个写入单元。journal = sink（通常 store.appendJournal；测试注入收集器）。 */
export async function runWriteUnit(
  op: string,
  opts: {
    /** 受影响课程（journal 的 course 维度；跨课程/无课程缺省 '*'）。 */
    course?: string
    clock: Clock
    /** journal sink——全部步骤成功后恰调用一次（返回值忽略；store.appendJournal 直通可用）。 */
    journal: (rec: JournalRec) => Promise<unknown>
    steps: readonly WriteStep[]
  },
): Promise<WriteUnitReport> {
  const steps: WriteUnitReport['steps'] = []
  for (const step of opts.steps) {
    if (step.done && await step.done()) {
      steps.push({ name: step.name, status: 'skipped' })
      continue
    }
    await step.run()
    steps.push({ name: step.name, status: 'done' })
  }
  const doneNames = steps.filter(s => s.status === 'done').map(s => s.name)
  await opts.journal({
    ts: nowIsoOf(opts.clock.nowMs()),
    course: opts.course ?? '*',
    node: op,
    rating: null,
    kind: 'write_unit',
    elapsed_days: 0,
    detail: `steps=${steps.map(s => `${s.name}:${s.status}`).join(',')}`
      + `（落 ${doneNames.length} 笔、跳过 ${steps.length - doneNames.length} 步）`,
  })
  return { op, course: opts.course ?? '*', steps }
}
