# 命令面统一：声明式命令注册表（表项形状与分流纪律）

投递面今天是**一个命令系统的三份手写实现**：agent 工具 111 个（`src/index.ts:2034-2972` 平铺，`defineTool` 全仓只经一个柯里化助手调用一次，见 `:2027`）、HTTP 路由 124 个分支／120 条路径（`handleApi`，`:957-1945`，990 行，**零 `else`／零 `switch`／零 `break`**，逐条 `return`）、UI 客户端 111 个端点函数（`ui/src/api.ts`，361 行）。单条命令的通体形状是「取参 → engine → 序列化」，业务逻辑占比不足 1%，但三份实现各自维护参数解析、校验、序列化与命名。本 ADR 把三者收敛为**一份声明式命令注册表**：每条命令声明 `id / 参数 schema / 引擎入口 / 输出形状 / 通道（含各自执行模型）`，工具面与路由面各只剩一个薄适配器，UI 的类型与调用从同一份 schema 派生。**实现施工另开票；本 ADR 只定表项形状与纪律。**

理由有三条，都是实测的。

**一、命名不能当地基。** 111 个工具里只有 **23 个**与某条路由同名（20.7%）——名单：`status`/`probation`/`question_audit`/`lesson`/`recommend`/`review_queue`/`coach`/`thermostat`/`rebuild`/`feedback`/`generate`/`difficulty_advice`/`bank_cleanup`/`optimize_params`/`question_generate`/`question_update`/`question_save`/`question_answer`/`explain_back_pack`/`explain_feedback`/`learner_queue`/`learner_rate`/`learner_forget`。规格里「46 条可机械配对」只有在承认三类例外之后才成立（截断：`/graph` ↔ `learnhub_graph_analyze`、`/questions` ↔ `learnhub_question_list`；单复数：`/habits/create` ↔ `learnhub_habit_create`；域名词：`/error-*` ↔ `learnhub_error_card_*`、`/learner-*` ↔ `learnhub_learner_card_*`）。而**真正的配对键是引擎入口**：两个面各调约 110 个引擎方法、**共享 84 个**（工具独有 26、路由独有 49）。所以注册表的主键是命令 id，「引擎入口」是必填字段，工具名与路由路径都降级为**属性**。

**二、执行模型今天是（命令, 通道）对的属性，不是命令的属性。** `compass_paint` 工具侧同步直调、面板侧走生成队列（两态并存）；`coachGrowthBatch` 只有队列、无工具。这个分叉靠人肉记忆维持——单命令单字段的模型表达不了它。

**三、参数校验有两个出处，而工具侧已在写声明式 schema。** 路由侧：`host/http.ts:45` 的 `need()`（123 个调用点）+ **21 处内联** `missing required field:` + **51 处手写** `typeof body.x` 守卫；工具侧：已经在写 SDK 的 per-property DSL（`{type:'string'|'number'|'boolean'|'array'+items|'object'+additionalProperties, required:true, enum}`，实测 148 处 `required`／195 处 `string`／23 `number`／11 `boolean`／5 `array`／4 `object`／1 `enum`），却把它打成 `Record<string, unknown>` 并把 `execute` 与返回值**两次 `as never`**（`src/index.ts:2027-2032`）——**SDK 的 `InferArgs` 编译期推断被主动丢掉了**。

关键裁决：

- **表项形状**（字段与语义）：

```ts
interface CommandSpec {
  id: string                  // 稳定主键（kebab）；工具名与路由路径由它派生或显式声明
  summary: string             // 人话描述——工具面 description 与面板文案的单一出处
  args: ParameterSchemaSpec   // 参数 schema：沿用宿主已在写的 SDK DSL，不打 Record<string, unknown>
  engine: string              // 引擎入口（门面方法名）——必填，且有门断言它存在
  output: TypeRef             // 输出形状：引擎视图类型的类型引用（编译期，零运行时）
  channels: Array<{
    channel: 'agent' | 'panel'
    mode: 'sync' | 'queued'
    tool?: string                                    // agent 通道的工具名
    route?: { method: 'GET' | 'POST' | 'PUT'; path: string }  // panel 通道的路由
  }>
}
```

- **`channels` 是唯一表达「允许通道 + 执行模型」的形状，两个字段不拆**：「允许通道」＝列出的通道集合，「执行模型」＝每条通道自己的 mode。理由见上（`compass_paint` 的双态）。这个形状让「同一动作两条通道两种行为」**在类型里无法被掩盖**，且今天零行为变化。
- **主键是 `id`，不是命名、也不是引擎入口**：因为「一个引擎入口、两个通道、两个名字」是常态（84 个共享入口对 111 个工具与 120 条路径）。门断言 `tool` 名与 `(method, route.path)` 各自唯一。
- **`args` 沿用 SDK 的 per-property DSL**，不引 zod／ajv（ADR-0042 已将「为静态规则引工具链」列为否决项；此处同理）。**两个 `as never` 随命令迁移逐条退役**——这是注册表最大的白捡收益：SDK 会给回参数类型，而今天 111 个处理函数把参数类型**手写第二遍**（`(args: {course: string; node: string})`），两份声明互不校验，所以到处 `as never`（`engine` 的 schema 与 `args.answers as never` 一类）。
- **`output` 是类型引用，编译期零运行时**。不做运行时输出校验——那需要 schema 库。今天的对外形状本就统一：路由侧把引擎对象**原样透传**、由 `sendJson` 序列化一次（约定写在 `src/index.ts:191-193`，禁止手动 `JSON.stringify` 造成双重编码）；错误形状全仓统一 `{ error: string }`，状态码实测 200×122／404×4／500×1。
- **参数校验收成一处的语义**：`need()` 的「缺失即 400 语义错误」与 `tool-contracts.ts` 的显式契约原则（可选参数只允许「省略」或「合法」；必填显式参数缺省即错；非法输入**永不**静默改写为另一个请求）**由注册表驱动的适配器统一施加**，消除 21 处内联 `missing required field:` 与 51 处手写 `typeof` 守卫；错误消息形状与状态码保持逐字不变。
- **与 ADR-0038 分流纪律的关系**：0038 的「面板能做的，指南不再宣传」从文档句子变成 `channels` 上的**可执行事实**。`AGENT_GUIDE`（`src/index.ts:63-105`，22 条手写、**从未与 111 个工具对账过**）的**工具名降为注册表的受检投影**：门断言每条 `tool` 名 ∈ 注册表且其通道分类与该命令一致；指南文案仍手写（它是教学性文字，不是派生物）。ADR-0038 的传输裁决不受本 ADR 影响：面板下发照旧复用全局串行生成队列，不引 allo 的同步长请求 + WS。
- **UI 同源、零代码生成**：注册表住**零 I/O 模块**（`src/commands.ts`——src 根的宿主侧模块已有 `tool-contracts.ts`／`generation-jobs.ts` 先例，并被 ADR-0042 边界段承认为「宿主侧模块」）。「零 I/O + 不 import fs 耦合模块」是 UI 能跨包 `import type` 它的**唯一前提**，也是「住哪一层」的真正判据——判据不是目录名。UI 侧 **111 个 `api.ts` 端点函数名与签名保持不变、139 处 `api.<name>(` 调用点零改动**，实现改为注册表驱动的泛型转发；响应类型从 `output` 派生，顺带清掉 **19 个引擎形状手写镜像**、收口 **49 个内联匿名响应类型**（这些类型今天在 `api.ts` 调用点就地书写、无家可归）、并消掉 camelCase→snake_case 的**第三处**手写映射（宿主两个面都没有这一层，只有 UI 客户端有）。**不做代码生成**：加 build 步骤是 ADR-0042 同类的工具链成本。
- **迁移是增量、一次一条命令**：每条命令迁完、`npm test` 全绿、才删旧分支；注册表与旧实现可长期并存（表项先只是声明，适配器后接）。这与 ADR-0043「一刀一个子系统、每刀独立可回滚」同款节奏。
- **不新增可达性**：今天 26 条 tool-only、49 条 route-only 的引擎方法**保持原样**。统一是「一份声明、两个适配器」的**机械统一**，不是「让面板能做的都给 agent 开个工具」——后者是 scope change，与「公共面零改动」相抵。

边界：

- **注册表的实现施工不在本窗**（#165 已裁定另开票）；本 ADR 只定形状与纪律。
- **投递侧前置已落地（#168，2026-09-11）**：路由从 990 行 if 链变成数据表（`host/route-table.ts` 表项形状 + `host/routes.ts`／`routes-post.ts` 两段表 + `host/api.ts` 查表分发），并**已按本 ADR 的表项形状预留字段位**（`id·summary·args·engine·output·channels`，只留位不消费）。参数守卫的语义已收进一处（`host/params.ts`：`need` 迁入 + `required*`/`opt*`/`pick`），21 处内联 `missing required field:` 与 51 处手写 `typeof body.x` 归零——**但今天可选参数的实现是「非法即当省略」**（比本 ADR 的「省略或合法」更宽松）；#169 把守卫改成注册表声明驱动时若收紧成 fail loud，须在票面登记这条行为变更。行为逐字不变的证据是 464 条探针快照（`tests/host-routes.test.ts`），不是通读代码。
- **`api.ts` 的物理位置在 #168 再分了一层**（`route-table.ts`／`routes.ts`／`routes-post.ts`），理由是 ADR-0047 的 G5 棘轮不许单文件继续长而 #169 还要往表项里填字段；本 ADR 的表项**形状**不变，只是表的**存放**分了段。

### #169 施工前需裁的四个问题（#168 收尾时实测登记；登记而非就地裁）

1. **`engine` 对队列型命令不成立（ADR 的字面在这里有洞）。** 实测 `src/host/jobs.ts`：队列命令的引擎面是**多方法管线**而非单个入口——正文管线依次调 `contentPack` → `contentTierOf` → `loadPrompt` → `contentSectionsView` → `contentOutline` → `questionGenerateSections` → `questionGenerate`；图域任务按 phase 分叉（种子 `seedPropose`／罗盘 `compassPaint`／反编译 `projectDecompile`／计划 `projectPlanPropose`／里程碑 `projectMilestoneWrite`／生长 `coachGrowthBatch`）。而队列型命令有十余条（`/generate`、`/generate/section`、`/course/reset`、`/question-generate`、`/coach/growth`、`/coach/compass`、`/seed/propose`、`/project/plan|milestone|decompile` 及各对应工具）。「`engine` 必填 + 门断言它存在」按字面施加不到这批命令上：要么把字段改成**按 phase／按通道**的形态，要么承认队列型命令的入口是 host 侧入队函数（此时本字段对它为空、门转为断言**入队函数**存在）。
2. **`args` schema 不含「参数 → 引擎实参」的映射。** 111 个工具的取值表达式是逐条手写的（`need`/`opt*`/嵌套对象/`Number()` 换算/条件透传），注册表只有声明式 `args`，没有表达「引擎第 k 个位置传哪个参数、哪些是嵌套负载」。因此「表项先只是声明、适配器后接」在**同步且单入口**的命令上可机械化，其余命令需要一个新字段（如 `bind`）或明确保留手写 handler——ADR 未裁，「两个 `as never` 逐条退役」的节奏也取决于它。
3. **单文件注册表与 G5 棘轮冲突。** 236 条命令的声明（含 111 条英文 description 与 SDK schema；工具面快照实测 **112KB**）落成一份 `src/commands.ts` 远超「宿主单文件 ≤900 行」的目标；而本 ADR 又否决了「按域拆成多份注册表」（唯一性要全局视角）。三条落法需选一：① 规模门白名单——**#165 的「文件规模预算」段已把「生成/枚举大表」列为白名单类别**（`src/engine/types.ts` 是既有先例），生成式注册表大概率可归入，但需显式登记理由；② 域分组作为**表内字段**的同文件分段；③ 改裁「表可分段、唯一致性由门跨段断言」——等于承认可以拆表。
4. **配对口径要从「引擎入口」落到「命令」。** 本 ADR 的 84／26／49 是**引擎入口**口径；命令数是 111 工具 + 125 路由表项，其中 46 条可机械配对（另有三类例外：截断／单复数／域名词），但**一个引擎入口对多条命令**是常态（如 pin/unpin 各一条命令共享同一引擎域）。注册表要求「一条命令一个 `id`」，所以施工前必须把配对规则写成清单（哪条工具与哪条路由是同一条命令），否则 `channels` 的合并与唯一性门都无从下手——这是 236 条命令里最费判断的一步。

已可断言的部分（不等注册表）：**AGENT_GUIDE 的工具名 ∈ 工具面**（`tests/host-runtime.test.ts`：22 条指南 × 111 个工具的对账，本 ADR 记的「从未对账过」至此有门）；后半「通道分类与该命令一致」仍需注册表。`(method, path)` 与工具名的唯一性今天已在门内（路由表测试与工具面快照各自断言）。`engine` 存在性在**路由面**今天由 G7（tsc 的 TS2339）覆盖，注册表落地后才是字段级断言。
- **「门面转发层消失或自动生成」**（消费方直连子系统）是终极形态，牵动 host/UI/测试全部调用点，**另开票**，本 ADR 不裁。
- `ui/` 的 151 处类型错与它自己的 tsconfig／vite 构建**不在本 ADR 范围**。
- 不引 zod／ajv／代码生成器／运行时输出校验；不新增任何依赖。
- `src/tool-contracts.ts` 是运行时**守卫函数**模块（6 个导出解析器 + 1 个常量，54 行）、**不是契约表**，也不枚举任何工具；`tests/explicit-tool-contracts.test.ts` 亦不列举工具名或路由路径。它贡献的是**校验语义**，注册表不复用它的形状。
- UI 侧的 `ui/src/types.ts` 今天有 83 个类型 re-export 自引擎、26 个本地手写（19 引擎形状镜像 + 4 宿主形状 + 3 UI 词汇）；本 ADR 只要求**新派生自注册表 `output`**、并随适配器票（ADR-0044）消掉引擎形状镜像的**成因**，不在此重排 UI 类型文件。

替代方案（否决）：

- **以命名规则当地基**（`learnhub_X` ↔ `/X` 作主键）——实测只覆盖 23/111（20.7%），另外三类例外要么被硬编码成规则表、要么漏掉；引擎入口覆盖 84/110。命名是**属性**，不是身份。
- **「允许通道」与「执行模型」拆成两个 per-command 字段**（贴 #165 正文的字面字段清单）——表达不了（命令, 通道）级分叉：要么把 `compass_paint` 压成单值（改行为），要么再加第三个「分流例外」清单字段（把分叉降级成待清零的债，而不是类型里的一等事实）。
- **生成 `ui/src/api.ts`**——加 build 步骤；而调用点形状其实不必变（111 个函数名与签名可保留），生成物只多一层构建依赖与一份需要同步的产物。
- **泛型 `invoke(id, args)` 直接取代 111 个手写函数**——收益最大但 139 处调用点要改，与「公共面零改动」相抵；属规格已明确另开票的终极形态。
- **运行时输出校验**（引 schema 库检查响应形状）——与 ADR-0042 否决 zod/ajv 同源理由；输出形状是编译期事实，运行期再验一次买不到信任，只买到依赖。
- **先让 120 条路由与 111 个工具一一对齐，再建表**（补齐 49 + 26 条对侧缺失入口）——那是新增可达性的 scope change，不是统一化。
- **按域拆成多份注册表**（学习／图谱／题库／项目／实验室各一份）——「引擎入口必填 + 唯一性门」要求全局视角才能断言不冲突；多份表会把唯一性检查退回成跨表扫描。域分组是**表内字段**（或工具面适配器的组织方式，见 ADR-0048），不是表的分裂。
