/**
 * 声明式「已起草课程」夹具（#256 / ADR-0082）：**种子起草通道整体退役后**，测试里
 * 「建课 + 手加终点 + 种子 apply」三件套的等价落盘改由本模块一次完成。
 *
 * 为什么需要它：种子通道（propose-seed / apply-seed）已从引擎删除，而 edit 提案建不了
 * 新区——草图的「区/块/粗占位边（endpoint.pre = starts）/锚留痕（seed_nodes、start_basis）」
 * 只能靠测试侧最小重建。本模块是**测试专属落盘器**，落盘形状与退役前
 * `createCourse(课程) + addEndpoint(...) + applySeed(...)` 的最终态对齐（root = 课程名），
 * 使 coach/compass/kata/project 等既有断言（路径/锚/图面/罗盘）原样复用。
 *
 * 纪律：本模块只写盘、不触引擎写通道（零 journal、零提案）——它是夹具，不是生产代码。
 */
import type { LearnhubEngine } from '../../src/engine/index.ts'
import type { VaultFs } from '../../src/engine/io.ts'
import { atomicWrite } from '../../src/engine/io.ts'
import type { CourseEntry, GNode } from '../../src/engine/types.ts'
import { GraphStore } from '../../src/engine/graph/graph.ts'
import { writeAnchors } from '../../src/engine/coach/seed.ts'
import type { EndpointAnchor, GoalType, StartBasis } from '../../src/engine/coach/seed.ts'
import { compassScaffold } from '../../src/engine/coach/compass.ts'
import { todayStr } from '../../src/engine/dates.ts'
import { noteText } from './vault.ts'
import type { NoteSeed } from './vault.ts'

/** 起草起点（pre=[]；basis 走锚的 start_basis 留痕）。 */
export interface DraftStart {
  name: string
  teaches?: Record<string, string>
  basis?: StartBasis
}

/** 起草终点（pre = starts 全集 = 粗占位边）。 */
export interface DraftEndpoint {
  name: string
  goalNote?: string
  goalType?: GoalType
  worksheet?: Array<{ block: string; note?: string; done: boolean }>
  teaches?: Record<string, string>
}

export interface DraftSpec {
  /** 课程名（root 同课程名，与 createCourse 一致）。 */
  course?: string
  /** 随批铸名的概念（登记表）。 */
  concepts?: Array<{ canonical: string; aliases?: string[]; definition?: string }>
  /** 手加终点（addEndpoint 等价：未分区零 pre 节点 + 无留痕锚）。 */
  manualEndpoints?: Array<{ name: string; goalNote?: string }>
  starts?: DraftStart[]
  endpoint?: DraftEndpoint
  /** 笔记覆盖：键 = 节点名；false = 不写骨架（缺省 = 为起点/终点写 ready 空笔记）。 */
  notes?: Record<string, string | NoteSeed> | false
  /** 锚声明日（缺省 = 引擎时钟的当前学习日）。 */
  declared?: string
}

/** 常见夹具：能力锚定课程（数学）——概念「变化率」+ 手加终点「导数方向」+
 * 起点「认识变化率」+ 终点「用导数解决优化问题」（教「变化率」）。 */
export const CAPABILITY_DRAFT: DraftSpec = {
  concepts: [{ canonical: '变化率' }],
  manualEndpoints: [{ name: '导数方向', goalNote: '能用导数解决优化问题' }],
  starts: [{ name: '认识变化率', basis: 'baseline', teaches: { 变化率: '会用' } }],
  endpoint: { name: '用导数解决优化问题', teaches: { 变化率: '会用' } },
}

/**
 * 把「已起草课程」落盘到（已构造的）引擎 vault 上：registry + data/*.yaml +
 * state/终点锚.json + 概念登记表.yaml + 罗盘脚手架 + 起点/终点笔记骨架。
 * 幂等前置：调用方应先 `withVault({ registry: null, graph: null })` 起一个空 vault。
 */
export async function draftCourse(engine: LearnhubEngine, spec: DraftSpec = {}): Promise<void> {
  const course = spec.course ?? '数学'
  const root = course
  const fs: VaultFs = engine.fs
  const paths = engine.paths
  const declared = spec.declared ?? todayStr(new Date(engine.clock.nowMs()))

  // ① 注册表：追加课程（幂等）
  const items = await engine.registry.load()
  if (!items.some(c => c.name === course)) {
    const entry: CourseEntry = { id: `${root}-01`, name: course, root, enabled: true }
    items.push(entry)
    await engine.registry.save(items)
  }

  // ② 单文件图落盘（#284：data/图.yaml；手加终点/起点/终点全部平铺为节点）
  const starts = spec.starts ?? []
  const nodes: GNode[] = []
  for (const e of spec.manualEndpoints ?? []) {
    nodes.push({ name: e.name, pre: [], opt: false, note: '', enc: [] })
  }
  for (const s of starts) {
    nodes.push({ name: s.name, pre: [], opt: false, note: '', enc: [], ...(s.teaches ? { teaches: s.teaches as GNode['teaches'] } : {}) })
  }
  if (spec.endpoint) {
    const ep = spec.endpoint
    nodes.push({
      name: ep.name, pre: starts.map(s => s.name), opt: false, note: '', enc: [],
      ...(ep.teaches ? { teaches: ep.teaches as GNode['teaches'] } : {}),
    })
  }
  const store = new GraphStore(paths, paths.courseRoot(root), fs)
  await store.writeGraphDoc(nodes)

  // ③ 终点锚落盘（手加锚在前、起草锚在后；起草锚带 seed_nodes/start_basis 留痕）
  const anchors: EndpointAnchor[] = []
  for (const e of spec.manualEndpoints ?? []) {
    anchors.push({
      endpoint: e.name,
      ...(e.goalNote ? { goal_note: e.goalNote } : {}),
      goal_type: 'capability', declared, worksheet: [], seed_nodes: [], start_basis: {},
    })
  }
  if (spec.endpoint) {
    const ep = spec.endpoint
    const startBasis: Record<string, StartBasis> = {}
    for (const s of starts) startBasis[s.name] = s.basis ?? 'baseline'
    anchors.push({
      endpoint: ep.name,
      ...(ep.goalNote ? { goal_note: ep.goalNote } : {}),
      goal_type: ep.goalType ?? 'capability',
      declared,
      worksheet: ep.worksheet ?? [],
      origin_proposal: 1,
      seed_nodes: [...starts.map(s => s.name), ep.name],
      start_basis: startBasis,
    })
  }
  await writeAnchors(paths.anchorPath(root), anchors, fs)

  // ④ 概念登记表（随批铸名）
  await engine.concepts.save(root, spec.concepts ?? [])

  // ⑤ 罗盘脚手架（createCourse 的等价物）
  await atomicWrite(paths.compassPath(root), compassScaffold(course), fs)

  // ⑥ 起点/终点笔记骨架（与退役前 ensureNotesFor 同款：只在种子节点上）
  if (spec.notes !== false) {
    const defaults: string[] = [
      ...starts.map(s => s.name),
      ...(spec.endpoint ? [spec.endpoint.name] : []),
    ]
    for (const name of defaults) {
      const override = spec.notes?.[name]
      const seed = (typeof override === 'object' && override !== null ? override : {}) as NoteSeed
      // 正文占位与引擎 ensureNotesFor 同款（`> 内容待生成。`）——它被四处消费点按整行剥离
      // （question-bank／index 的整课节选），换成 `# <节点名>` 会改变喂给模型的上下文
      const text = typeof override === 'string'
        ? override
        : noteText(name, { ...seed, body: seed.body ?? ['> 内容待生成。'] }) + '\n'
      await atomicWrite(paths.courseNotePath(root, name), text, fs)
    }
  }
}
