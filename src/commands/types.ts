/**
 * 命令注册表·表项形状（#169 / ADR-0045）。
 *
 * **零运行时依赖模块**：本目录下只允许 `import type`（构建期擦除），因此 UI 可以跨包
 * `import type` 它——这是「UI 类型与调用从同一份声明派生」的地基（ADR-0045 裁定 6）。
 *
 * 与 ADR-0045 的字段对照：
 * - `id` 稳定主键；`summary` 工具面 description 的单一出处（仅 agent 通道必填）；
 * - `args` 沿用 SDK 的 per-property DSL（**逐字**，工具面据它注册工具，故多出的
 *   `read` 只在投递层被消费、下发工具面前被剥掉）；
 * - `engine` 可选：声明了就必须是门面方法；队列型/按参分派型/无引擎型留空（白名单登记理由）；
 * - `bind` 住**通道**：顺序＝引擎实参位置，元素＝`args` 键名，`null`＝该位置传 `undefined`；
 * - `phase` 住**通道**：队列型命令的入口阶段（∈ GEN_JOB_PHASES）；
 * - `output` 类型引用（编译期幻影字段，运行时不写）。
 */
import type { GenJobPhase } from '../generation-jobs.ts'
import type { LearnhubEngine } from '../engine/index.ts'

/** 门面上「方法型」的入口名（`output` 从它派生，故非方法的键排除在外）。 */
type EngineMethod = {
  [K in keyof LearnhubEngine]: LearnhubEngine[K] extends (...a: never[]) => unknown ? K : never
}[keyof LearnhubEngine]

/** 面板路由今天实际在用的三种方法。 */
export type HttpMethod = 'GET' | 'POST' | 'PUT'

/** 域分组（表内字段，也是声明文件的切分依据；ADR-0045 裁定 5）。 */
export type CommandDomain =
  | '学习' | '图谱' | '题库' | '项目' | '学习者产出' | '实验室' | '通道' | '维护'

/**
 * 参数声明（SDK per-property DSL + 投递层扩展键）。
 * SDK 键（`type`／`required`／`description`／`enum`／`items`／`additionalProperties`）逐字沿用；
 * `read` 是投递层扩展：可选字符串/数字的**取值语义**（今天手写 `optText`/`optTrimmed`/`optRaw`/
 * `optString`/`optFinite` 五族就是它），下发工具面前会被剥掉。
 */
export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  required?: boolean
  description?: string
  enum?: string[]
  items?: ParamSpec
  additionalProperties?: boolean
  /** 取值语义：`trimmed`（默认，非空白才带出 trim 值）／`text`（非空白带出原值）／
   * `raw`（任何字符串带出原值）／`fallback`（缺省即 ''）／`finite`（数字且有限）／
   * `query`（GET 必填串：非空、**原样不 trim**——今天是 `needQuery` 的语义，与 `need` 的
   * 「非空白 + trim」不同；这是（命令, 通道）对的事实，不是笔误）。 */
  read?: 'trimmed' | 'text' | 'raw' | 'fallback' | 'finite' | 'query'
}

export type ParameterSchemaSpec = Record<string, ParamSpec>

/** 一条通道：允许通道 + 该通道自己的执行模型（＋该通道的实参绑定与队列阶段）。 */
export interface ChannelSpec {
  channel: 'agent' | 'panel'
  mode: 'sync' | 'queued'
  /** agent 通道的工具名。 */
  tool?: string
  /** panel 通道的路由。 */
  route?: { method: HttpMethod; path: string }
  /** 仅 mode:'queued'：入队后从哪个阶段开始跑（∈ GEN_JOB_PHASES）。 */
  phase?: GenJobPhase
  /** 生成路径的引擎实参绑定：顺序＝位置，元素＝`args` 键名，`null`＝传 undefined。 */
  bind?: Array<string | null>
  /** 本通道的必填清单；省略即沿用 `args` 的 `required`。
   * 必填是**（命令, 通道）对的属性**（实测 9 处两面不一致：`/lesson` 的 `course` 工具侧必填、
   * 面板侧可省——引擎自己能按 node 解析课程）——`args` 的 `required` 是工具面 SDK schema 的
   * 逐字契约（不许动），面板侧的不同契约由本字段表达。 */
  required?: string[]
  /** 前缀路由（今天唯一一条：GET /vendor/）。 */
  prefix?: boolean
  /** 本通道是否记运行日志（`apiRun` 包装）；省略＝记。实测 3 条面板路由直调不包 `apiRun`
   * （`/question-save`、`/question-add`、`/question-archive`），原样保留。 */
  log?: boolean
}

/** 一条命令（`E` = 声明的引擎入口；`output` 由它派生）。 */
export interface CommandSpec<E extends string = string> {
  id: string
  /** 工具面 description 的单一出处（逐字）；仅面板通道的命令可缺（待面板文案票，ADR-0045 裁定 3）。 */
  summary?: string
  args: ParameterSchemaSpec
  /** 引擎入口（门面方法名）；留空须进白名单（逐条理由，见 tests/commands.test.ts）。 */
  engine?: E
  /**
   * 输出形状：**引擎入口返回类型的类型引用**（编译期幻影字段，运行时不写）。
   * 由 `E` 派生而非手写——UI 侧的响应类型（`CommandOutput<id>`）与 `ui/src/types.ts` 的
   * 别名都从它来，这就是「响应类型派生自 output、引擎形状镜像消失」的机制（#169）。
   * 引擎入口留空的命令（队列型/按参分派型/无引擎型）→ `unknown`（UI 侧无对应端点或另有 handler）。
   */
  output?: E extends EngineMethod ? Awaited<ReturnType<LearnhubEngine[E]>> : unknown
  domain: CommandDomain
  channels: ChannelSpec[]
}

/**
 * 表项构造器（形状即 ADR-0045，不做运行时加工）：`engine` 是字面量时推断出 `E`，
 * `output` 随之派生——154 条声明**零手写输出类型**（这正是把 output 做成声明的一部分的理由）。
 * 引擎入口留空的命令走第二个重载（`output` = unknown）。
 */
export function command<E extends EngineMethod>(spec: Omit<CommandSpec<E>, 'output'> & { engine: E }): CommandSpec<E>
export function command(spec: Omit<CommandSpec<string>, 'output'>): CommandSpec<string>
export function command(spec: Omit<CommandSpec<string>, 'output'>): CommandSpec<string> {
  return spec as CommandSpec<string>
}
