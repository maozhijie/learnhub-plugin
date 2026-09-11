# 命令面统一：声明式命令注册表（表项形状与分流纪律）

投递面今天是**一个命令系统的三份手写实现**：agent 工具 111 个（`src/index.ts:2034-2972` 平铺，`defineTool` 全仓只经一个柯里化助手调用一次，见 `:2027`）、HTTP 路由 124 个分支／120 条路径（`handleApi`，`:957-1945`，990 行，**零 `else`／零 `switch`／零 `break`**，逐条 `return`）、UI 客户端 111 个端点函数（`ui/src/api.ts`，361 行）。单条命令的通体形状是「取参 → engine → 序列化」，业务逻辑占比不足 1%，但三份实现各自维护参数解析、校验、序列化与命名。本 ADR 把三者收敛为**一份声明式命令注册表**：每条命令声明 `id / 参数 schema / 引擎入口 / 输出形状 / 通道（含各自执行模型）`，工具面与路由面各只剩一个薄适配器，UI 的类型与调用从同一份 schema 派生。**实现施工另开票；本 ADR 只定表项形状与纪律。**

理由有三条，都是实测的。

**一、命名不能当地基。** 111 个工具里只有 **23 个**与某条路由同名（20.7%）——名单：`status`/`probation`/`question_audit`/`lesson`/`recommend`/`review_queue`/`coach`/`thermostat`/`rebuild`/`feedback`/`generate`/`difficulty_advice`/`bank_cleanup`/`optimize_params`/`question_generate`/`question_update`/`question_save`/`question_answer`/`explain_back_pack`/`explain_feedback`/`learner_queue`/`learner_rate`/`learner_forget`。规格里「46 条可机械配对」只有在承认三类例外之后才成立（截断：`/graph` ↔ `learnhub_graph_analyze`、`/questions` ↔ `learnhub_question_list`；单复数：`/habits/create` ↔ `learnhub_habit_create`；域名词：`/error-*` ↔ `learnhub_error_card_*`、`/learner-*` ↔ `learnhub_learner_card_*`）。而**真正的配对键是引擎入口**：两个面各调约 110 个引擎方法、**共享 84 个**（工具独有 26、路由独有 49）。所以注册表的主键是命令 id，「引擎入口」是必填字段，工具名与路由路径都降级为**属性**。

**二、执行模型今天是（命令, 通道）对的属性，不是命令的属性。** `compass_paint` 工具侧同步直调、面板侧走生成队列（两态并存）；`coachGrowthBatch` 只有队列、无工具。这个分叉靠人肉记忆维持——单命令单字段的模型表达不了它。

**三、参数校验有两个出处，而工具侧已在写声明式 schema。** 路由侧：`host/http.ts:45` 的 `need()`（123 个调用点）+ **21 处内联** `missing required field:` + **51 处手写** `typeof body.x` 守卫；工具侧：已经在写 SDK 的 per-property DSL（`{type:'string'|'number'|'boolean'|'array'+items|'object'+additionalProperties, required:true, enum}`，实测 148 处 `required`／195 处 `string`／23 `number`／11 `boolean`／5 `array`／4 `object`／1 `enum`），却把它打成 `Record<string, unknown>` 并把 `execute` 与返回值**两次 `as never`**（`src/index.ts:2027-2032`）——**SDK 的 `InferArgs` 编译期推断被主动丢掉了**。

关键裁决：

- **表项形状**（字段与语义；#169 落地时按实测修正过，见下「裁定」段与本 ADR 末尾的施工记录）：

```ts
interface ChannelSpec {
  channel: 'agent' | 'panel'
  mode: 'sync' | 'queued'
  tool?: string                                    // agent 通道的工具名
  route?: { method: 'GET' | 'POST' | 'PUT'; path: string }  // panel 通道的路由
  phase?: GenJobPhase                              // 仅 mode:'queued'：入口阶段（∈ GEN_JOB_PHASES）
  bind?: Array<string | null>                      // 生成路径：顺序＝引擎实参位置，元素＝ args 键名，null＝传 undefined
}

interface CommandSpec {
  id: string                  // 稳定主键（kebab）；工具名与路由路径由它派生或显式声明
  summary?: string            // 人话描述——工具面 description 与面板文案的单一出处；**agent 通道必填**
  args: ParameterSchemaSpec   // 参数 schema：沿用宿主已在写的 SDK DSL，不打 Record<string, unknown>
  engine?: string             // 引擎入口（门面方法名）——声明了就必须存在；留空须进白名单（逐条理由）
  output?: TypeRef            // 输出形状：引擎视图类型的类型引用（编译期幻影字段，零运行时）
  domain: CommandDomain       // 域分组（表内字段，也是声明文件的切分依据）
  channels: ChannelSpec[]
}
```

- **`channels` 是唯一表达「允许通道 + 执行模型」的形状，两个字段不拆**：「允许通道」＝列出的通道集合，「执行模型」＝每条通道自己的 mode。理由见上（`compass_paint` 的双态）。这个形状让「同一动作两条通道两种行为」**在类型里无法被掩盖**，且今天零行为变化。
- **主键是 `id`，不是命名、也不是引擎入口**：因为「一个引擎入口、两个通道、两个名字」是常态（84 个共享入口对 111 个工具与 120 条路径）。门断言 `tool` 名与 `(method, route.path)` 各自唯一。
- **`args` 沿用 SDK 的 per-property DSL**，不引 zod／ajv（ADR-0042 已将「为静态规则引工具链」列为否决项；此处同理）。**两个 `as never` 随命令迁移逐条退役**——这是注册表最大的白捡收益：SDK 会给回参数类型，而今天 111 个处理函数把参数类型**手写第二遍**（`(args: {course: string; node: string})`），两份声明互不校验，所以到处 `as never`（`engine` 的 schema 与 `args.answers as never` 一类）。
- **`output` 是类型引用，编译期零运行时**。不做运行时输出校验——那需要 schema 库。今天的对外形状本就统一：路由侧把引擎对象**原样透传**、由 `sendJson` 序列化一次（约定写在 `src/index.ts:191-193`，禁止手动 `JSON.stringify` 造成双重编码）；错误形状全仓统一 `{ error: string }`，状态码实测 200×122／404×4／500×1。
- **参数校验收成一处的语义**：`need()` 的「缺失即 400 语义错误」与 `tool-contracts.ts` 的显式契约原则（可选参数只允许「省略」或「合法」；必填显式参数缺省即错；非法输入**永不**静默改写为另一个请求）**由注册表驱动的适配器统一施加**，消除 21 处内联 `missing required field:` 与 51 处手写 `typeof` 守卫；错误消息形状与状态码保持逐字不变。
- **与 ADR-0038 分流纪律的关系**：0038 的「面板能做的，指南不再宣传」从文档句子变成 `channels` 上的**可执行事实**。`AGENT_GUIDE`（`src/index.ts:63-105`，22 条手写、**从未与 111 个工具对账过**）的**工具名降为注册表的受检投影**：门断言每条 `tool` 名 ∈ 注册表且其通道分类与该命令一致；指南文案仍手写（它是教学性文字，不是派生物）。ADR-0038 的传输裁决不受本 ADR 影响：面板下发照旧复用全局串行生成队列，不引 allo 的同步长请求 + WS。
- **UI 同源、零代码生成**：注册表住**零运行时依赖模块**（`src/commands/`；#169 实测把「零 import」放宽为**零运行时 import**——只允许 `import type`，因为 `output` 必须是真实的类型引用才能让 UI 派生，而 `import type` 在构建期被擦除，UI 跨包 `import type` 的前提不变）。UI 侧 **111 个 `api.ts` 端点函数名与签名保持不变、139 处 `api.<name>(` 调用点零改动**，实现改为注册表驱动的泛型转发；响应类型从 `output` 派生，顺带清掉 **19 个引擎形状手写镜像**、收口 **49 个内联匿名响应类型**（这些类型今天在 `api.ts` 调用点就地书写、无家可归）、并消掉 camelCase→snake_case 的**第三处**手写映射（宿主两个面都没有这一层，只有 UI 客户端有）。**不做代码生成**：加 build 步骤是 ADR-0042 同类的工具链成本。
- **迁移是增量、一次一条命令**：每条命令迁完、`npm test` 全绿、才删旧分支；注册表与旧实现可长期并存（表项先只是声明，适配器后接）。这与 ADR-0043「一刀一个子系统、每刀独立可回滚」同款节奏。
- **不新增可达性**：今天 26 条 tool-only、49 条 route-only 的引擎方法**保持原样**。统一是「一份声明、两个适配器」的**机械统一**，不是「让面板能做的都给 agent 开个工具」——后者是 scope change，与「公共面零改动」相抵。


边界：

- **注册表的实现施工不在本窗**（#165 已裁定另开票）；本 ADR 只定形状与纪律。
- **投递侧前置已落地（#168，2026-09-11）**：路由从 990 行 if 链变成数据表（`host/route-table.ts` 表项形状 + `host/routes.ts`／`routes-post.ts` 两段表 + `host/api.ts` 查表分发），并**已按本 ADR 的表项形状预留字段位**（`id·summary·args·engine·output·channels`，只留位不消费）。参数守卫的语义已收进一处（`host/params.ts`：`need` 迁入 + `required*`/`opt*`/`pick`），21 处内联 `missing required field:` 与 51 处手写 `typeof body.x` 归零——**但今天可选参数的实现是「非法即当省略」**（比本 ADR 的「省略或合法」更宽松）；#169 把守卫改成注册表声明驱动时若收紧成 fail loud，须在票面登记这条行为变更。行为逐字不变的证据是 464 条探针快照（`tests/host-routes.test.ts`），不是通读代码。
- **`api.ts` 的物理位置在 #168 再分了一层**（`route-table.ts`／`routes.ts`／`routes-post.ts`），理由是 ADR-0047 的 G5 棘轮不许单文件继续长而 #169 还要往表项里填字段；本 ADR 的表项**形状**不变，只是表的**存放**分了段。

### #169 施工前的裁定（2026-09-11，逐条实测后裁；本 ADR 据此改写表项形状）

**术语消歧**：本 ADR 里的「通道」（`channels` 的 agent/panel）是**投递义**；CONTEXT.md 里的「通道」是域义（练习证据通道、Anki 作答通道、回填通道、schema 升级的唯一通道）。两者不合并、不互相改写，读到时按语境取义。

1. **`engine` 是可选字段，三类命令留空（逐一登记理由）**——实测 236 条命令里有三类套不上「单一门面方法」：
   - **队列型（路由 10／工具 6；按命令去重后 14 条）**：handler 只调 host 入队函数，真正的引擎调用在 `jobs.ts` 的 runner，且是多方法管线（正文管线依次 7 个方法）。**裁定**：队列**通道**上声明 `phase`（入口阶段），命令级 `engine` 留空；门断言「`phase` ∈ `GEN_JOB_PHASES` 且 runner 有该阶段分支」——把今天靠 `job.phase === '生长'` 手写字符串匹配的接线变成受检的。
   - **按参分派型（7 条）**：入口是实参的函数（`/node/pin`→`pinToday|unpinToday`、`/experiments`→3 个读方法、`graph_apply`、`question_update`、`bank_cleanup`、`probation`、`sleep_config`）。**裁定**：`engine` 留空 + 保留手写 handler。
   - **无引擎型（9 条）**：伺服（`/file`、`/vendor/`、`/interactive`）、host 队列态（`/generate/status|resume|cancel`）、常量（`/agent-guide`）、LLM 会话（`/tutor`、`/explain-back`）。**裁定**：`engine` 留空。
   - 门因此是两段：「声明了 `engine` 的必须 ∈ 门面原型方法」＋「留空的必须落在白名单、逐条有理由」（ADR-0047 的白名单形状）。**阶段命名缺口登记**：`GEN_JOB_PHASES` 命名不一致（`outline`/`sections`/`quiz` 英文，图域五项中文），但它是**持久化数据**里的值（`state/生成任务.json`），改它=改行为；本票按原值引用，命名统一另开票。
2. **加 `bind`（位置式实参绑定），载荷/回调/多入口/队列/无引擎命令保留手写 handler**——实测实参形态：纯位置透传 153 条、带换算 17 条、**载嵌套负载 32 条**、带回调 2 条。**裁定**：`bind` 定成 `Array<string | null>`（顺序＝引擎实参位置，元素＝`args` 的键名，`null` = 该位置传 `undefined`），**住通道**（`bind` 与 `mode`/`phase` 同理，是（命令,通道）对的属性：两条通道的参数面与调用点各自独立）；换算类走 `args` 的 `required`/类型派生的守卫语义（不再手写）；载荷类（领域负载）**不塞进 DSL**——在 JSON 里写一段小程序与 ADR-0044「不引通用工作流框架」同款否决。手写 handler 住**适配器**并按 `id` 对齐，门断言「handler 的 id 集合 == 注册表里非生成路径命令的 id 集合」。
3. **`summary` 取工具面 description 逐字，仅面板通道的命令可缺**——面板侧今天**没有任何命令文案**（都在 UI 里手写）；为 49 条仅面板命令现写人话文案是产品文案，不该由实现票代笔（与「指南文案仍手写」同源）。**裁定**：`summary` 对 **agent 通道必填**（逐字取长 description，机械可搬、零判断）、对仅面板命令可缺，并登记为待面板文案票。
4. **配对按引擎入口**——命名口径只覆盖 23/111（20.7%），而引擎入口口径**自动消解**本 ADR 记的三类命名例外（截断／单复数／域名词）；实测两面都有 80 个入口、仅工具 30、仅路由 26，且「多工具 × 多路由」的歧义组 **0 组**。**裁定**：一个引擎入口 + 两面各一条 = 一条双通道命令；只在单面出现的入口 = 该面的单通道命令；多入口命令自成一条、手写。
5. **声明按域分文件、单点装配、门在装配表上跑**——体量实测：111 条 description 62.7KB + schema 24.8KB + 125 条 panel 声明 ≈ 2000 行／90KB，远超「宿主单文件 ≤900 行」。**裁定**：`src/commands/<域>.ts`（8 域，对应工具面既有域横幅）+ `src/commands/index.ts` 装配成**一张表**；唯一性/配对/`engine` 存在性等门跑在装配表上。**本 ADR 关于「域分组是表内字段、不是表的分裂」的措辞据此澄清**：域分组可以落到文件，只要装配是单点、门在装配表上断言——「不可分裂」约束的是**唯一性与配对要有全局视角**，不是物理文件数（#168 已在路由三段表上验证过这个形状）。
6. **`output` 的零依赖口径放宽为「零运行时依赖」**：`output` 必须是**真实类型引用**，UI 才能派生；而视图类型的家在 `src/engine/views.ts`（ADR-0042 的 R4 保证它是纯类型模块）。**裁定**：注册表只允许 `import type`（构建期擦除，UI 跨包 `import type` 的前提不变），禁止任何运行时 import（含 `node:*`、`@deepseek-ai/*`、fs 耦合模块的值）。
7. **`#169` 一票到底、不拆子票**：注册表骨架、八道门、两个通道切到生成路径、UI 同源派生在一次交付里完成；每步 `npm test` 全绿、按域/按表段分步提交、每步可独立回滚。

**八道门**（1-6 硬门 0，各带自检；7 沿用既有棘轮/快照门，8 是新增的一致性锁）：

| # | 门 | 内容 |
|---|---|---|
| 1 | `engine` 存在性 | 声明值 ∈ `LearnhubEngine.prototype`；留空 ⇒ 白名单 + 逐条理由 |
| 2 | 队列阶段 | `phase` ∈ `GEN_JOB_PHASES` 且 `jobs.ts` runner 有该分支 |
| 3 | 唯一性 | `id`／`tool` 名／`(method, path)` 在装配表上各自唯一 |
| 4 | handler 覆盖 | 适配器 handler 的 id 集合 == 注册表里非生成路径命令的 id 集合（无孤儿、无缺件） |
| 5 | 指南投影 | `AGENT_GUIDE` 每条 `tool` 所属命令确实带 agent 通道（前半「∈ 工具面」已在 #168 后进门） |
| 6 | 零运行时依赖 | `src/commands/` 下只允许 `import type`，禁 `node:*`／`@deepseek-ai/*`／值 import |
| 7 | 零行为漂移 | 工具面快照（111 条 name/description/parameters）+ 路由探针快照（464 条）继续当门 |
| 8 | 声明与面一致 | 注册表 agent 通道的 `(tool, args, summary)` 与工具面快照逐字一致；panel 通道的 `(method, path)` 与路由清单逐字一致 |

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
