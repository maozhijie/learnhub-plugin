# 调研：Vault 链接图作为 pre/enc 先验的可行性

- 日期：2026-09-08
- 状态：可行性调研（喂 V-1「Vault 即课程输入」增量与 P-5「目标反编译」；不含实施决策）
- 票：[maozhijie/learnhub-plugin#78](https://github.com/maozhijie/learnhub-plugin/issues/78)（wayfinder 地图 #73 的 research 票）
- 源材料：本仓库源码（`src/index.ts` 工具面 + `src/engine/` 引擎）+ `~/.dsh/` 本机部署残留 + 本机 Obsidian Vault 只读实测（§3）

## 0. TL;DR

1. **宿主检索/嵌入能力：待宿主确认。** dsh monorepo（`C:/Users/test/Desktop/deepseek-harness`）在本机不存在（`DSH_MONOREPO` 未设，`node_modules/@deepseek-ai` 只 junction 了 cordis/cosmokit，dsh-llm/dsh-tools 缺席），无法从源码枚举宿主给插件的完整工具面。插件可见的宿主面只有 `inject = ['tools', 'webServer', 'llm']` 三个 seam 与 `defineTool`/`createUserMessage`/`ReasoningEffortId` 三个导入——**没有任何检索/嵌入 API 的使用痕迹**（§1）。
2. **但这不阻塞可行性：引擎本来就持 vault 根。** `LearnhubEngine` 构造即存 `vaultRoot`（`engine/index.ts:119`），`note-source.ts` 已经在递归扫描学习中心外的个人笔记（ADR-0010 零写入纪律）。`[[链接]]` 解析是纯文件扫描，**降级路径（无宿主检索、无嵌入）完全够 V-1/P-5 起步**（§1.3、§4）。
3. **推荐管线**：五段——扫描排除区 → wikilink 解析（alias/锚点/嵌入语法）→ 噪声过滤（嵌入/非 md/日期导航/归档区/代码围栏）→ 节点映射 + w∈[0,1] 置信度（复用 enc 边权重约定）→ 产物走 **enc_backfill 同款模式**（扫描 → 单个 pending edit 提案 → 人审 apply）；`graph_analyze` 的 `suggestions` 增加自由 JSON 段 `vault_link_candidates` 作先验展示，**零 schema 破坏**（§4–§5）。

## 1. 宿主能力：检索/嵌入工具面「待宿主确认」

### 1.1 查到的证据（本机可验证的部分）

| 证据 | 内容 | 出处 |
|---|---|---|
| 插件声明的宿主注入 | `export const inject = ['tools', 'webServer', 'llm']` | `src/index.ts:42` |
| 对 dsh-llm 的全部使用 | 仅 `createUserMessage`、`ReasoningEffortId`（模型调用与思考档） | `src/index.ts:20,174,183` |
| 对 dsh-tools 的全部使用 | 仅 `defineTool`（注册 agent 工具，输出为 text schema） | `src/index.ts:21,1105` |
| 私有 peer 清单 | dsh-llm / dsh-tools / dsh-schedule / dsh-time-context，全部 optional peer | `package.json` peerDependencies |
| monorepo 布局映射 | dsh-llm → `<monorepo>/llm/llm`；dsh-tools → `<monorepo>/core/tools` | `scripts/link-peers.mjs` |
| 宿主本体构成 | profile bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + dsh-learnhub | `~/.dsh/profiles/web/package.json` |
| 本仓库功能定位 | 插件自带 38 个 agent 工具 + `/learnhub/api/*` 面板后端 + SPA 伺服——检索类需求目前全部由引擎自己的 `node:fs` 扫描承担 | `README.md`、`package.json` |

### 1.2 查不到什么（诚实标注）

- **`@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-tools` 的导出面无法枚举。** monorepo 默认路径 `C:/Users/test/Desktop/deepseek-harness/packages` 不存在（`DSH_MONOREPO` 未设置），本仓库 `node_modules/@deepseek-ai` 只有 cordis/cosmokit（peer 未 junction 成功——link-peers 对缺失 target 只 warn 跳过）；`~/.dsh/profiles/web/node_modules` 只剩 dsh-learnhub/dsh-worktable/ts-fsrs，宿主核心包不在；`~/.dsh/sessions/*/session.jsonl.zstd` 解压后只有会话头（消息未持久化）。是否存在 `search`/`grep`/`embed`/`全文索引` 类可注册工具，**待宿主确认**（建议在有 monorepo 的机器上 `ls packages/core/tools/src` 并查 dsh-llm 导出表后回填本节）。
- 本机 Vault 部署路径（profile patch 指 `c:/Users/test/Desktop/Obsidian Vault`）与 `dsh-learnhub` junction 目标（`Desktop/learnhub-plugin`）在本机均为悬空——本机是分析环境而非部署环境，§3 实测改在仓库旁的真实 Vault 副本（`Desktop/my/Obsidian Vault`）上只读完成。

### 1.3 为什么待确认不阻塞：引擎自带全 vault 文件访问

- 宿主以 `link:` junction 直装本仓库（`~/.dsh/profiles/web/node_modules/dsh-learnhub → <repo>`），插件与宿主同进程跑 Node——**`node:fs/promises` 对 `config.vault` 下所有路径可直接读写**，不需要宿主额外授权（`README.md` 部署更新节、`cordis.patch.yml` config.vault）。
- 先例：`note-source.ts::collectNoteFiles` 已递归收集学习中心外全部 `.md`（跳点目录）；`resolveNote` 接受 vault 相对或绝对路径。全 vault 扫描在引擎侧零新依赖。
- 结论：**宿主检索/嵌入属于「有则更好」的加速项，不是前置条件**。V-1 用纯文件扫描即可交付；嵌入只在「节点模糊映射」（§4.3）这一段有增益。

## 2. 引擎现状：个人笔记通道与图提案接口

### 2.1 vault 根与零写入纪律

- 引擎两级路径：`vaultRoot`（config.vault 必填）⊃ `centerRoot = vault/学习中心`；`Paths` 全部由 centerRoot 派生（`engine/paths.ts`）。个人笔记天然在中心外。
- **ADR-0010（C1 #59）**：个人笔记可注册为复习源（注册表 `note_sources` 域 `{id, path, enabled, created}`），对源文件**零写入**，派生物（指纹 + 镜像题库）全部落 `学习中心/笔记源/`；删除/改名 → Missing 合法空态，正文漂移 → sha256 指纹比对（`note-source.ts`）。**Vault 链接扫描应沿用同一纪律**：个人笔记只读，产物落中心内。
- `normalizeSourcePath` 已实现「拒学习中心内部 + 拒 `..` 越界」的输入卫生（`note-source.ts:144-161`），可直接复用为扫描根校验。

### 2.2 图与边 schema（pre/enc 语义）

- 图事实源：`<课程根>/data/*.yaml`（region/block/nodes），人类可读可手编；节点允许字段 name/pre/opt/note/enc/est/type/bloom/difficulty，未知字段 schema 级拒绝（`engine/graph.ts` NODE_KEYS）。
- **pre**：字符串列表，解锁门禁与拓扑事实源；**enc**：成分技能边 `{node, w, note?}`，**w ∈ [0,1]**，必须落在 pre 传递闭包内（CONTEXT.md 术语表：enc 是「本节点练习真实调用的前置技能边（带权重）」，同时服务生成与审计，也是调度回退路由的消费边）。
- `Graph` 派生结构齐备：邻接表、Kahn 拓扑 + 环检测、`reach` 可达集（`isAncestor`）、传递约简边、连通分量（`engine/graph.ts:188-343`）；`structureCheck` 拒绝重名/断边（含 enc 断边）/环。
- **这直接决定先验的置信度表达：复用 `w ∈ [0,1]`，不需要新字段。**

### 2.3 enc_candidates 反哺：管线该抄的模板

现有「内容反哺图」闭环（ADR-0008 / #53）已经把「候选 → 提案 → 人审」的路径跑通：

1. 生成正文时节末落机器块 `<!-- enc_candidates: [技能...] -->`（`engine/content.ts:184-188`）；
2. `Content.encCandidates(body)` 从落盘正文回收（`content.ts:969`）；引用不在 pre 闭包/不在图内 → 质检与 hints 给出可执行建议（补 set_pre/set_enc，`content.ts:1015-1027`）；
3. **`learnhub_graph_enc_backfill`**：全量扫描 Ready 内容 → 每个有新候选的节点生成一条 `set_enc`（整体替换、保留既有）→ **汇总为单个 pending edit 提案** → 人审后 `learnhub_graph_apply(kind=edit)` 生效；可重入，无遗漏返回 ops=0（`engine/index.ts:596-636`）。

Vault 链接先验与此**同构**：wikilink 边 = 另一种「外部证据产生的候选边」，应当走同一个提案-人审通道，而不是绕过 propose 直写 data/*.yaml（违反「图变更必须走 propose 人审」的 SOP）。

### 2.4 analyze / propose 接口形态

- `learnhub_graph_analyze`（只读）：返回结构统计、健康分 0–100、下一批建议 `suggestions.expand_blocks/missing_pre/unconverged/jump_candidates/merge_blocks`、每节点 schema 全量、cytoscape elements；`jump_candidates`（认知跳跃边，需逐条裁决）证明 **suggestions 段可以承载「机器给候选、人/agent 裁决」的条目**（`src/index.ts:1190-1207`）。
- `learnhub_graph_propose`（kind=gen|edit，YAML 文本）：edit ops = add_node/set_pre/set_enc/del_node/rename/move/set_note；set_pre/set_enc 均为**整体替换**语义；提案带 reason 字段（`src/index.ts:1234-1241`）。
- `learnhub_graph_enc_backfill` 与 `learnhub_graph_apply` 是「先验回填」的现成入口（`src/index.ts:1250-1271`）。

## 3. Vault 实测（本机只读统计，2026-09-08）

样本：`Desktop/my/Obsidian Vault`，学习中心外 276 个 `.md`（02日记 72、过时20260903 归档 130、01笔记 3、04AI 3、05ob自定义 5、03属性 1）。

| 链接形态 | 实测数 | 说明 |
|---|---|---|
| wikilink 总数（含嵌入） | 474 | `grep -E "\[\[[^]]+\]\]"` |
| 嵌入 `![[...]]` | 67 | 附件/图片嵌入，非知识边 |
| alias 语法 `[[target|显示名]]` | 87 | 解析时取 target、留 alias 做显示 |
| 锚点引用 `[[note#标题/块]]` | 16 | `[[2026-04-28#编程笔记]]` 型，目标应剥 `#` 后段 |
| 指向非 md 资产 | 83 | `.base`（Obsidian Bases）/图片等，全部非知识边 |

噪声结构观察（直接决定 §4.2 过滤规则）：

- **日记是最大噪声源**：`[[日记.base|日记]]` 一条模板链接出现 66 次；日记间互链多为导航（`[[2026-04-30 …]]` 日期目标）。
- **真知识边存在但稀疏**：如 `[[完成第一个游戏demo]]`、`[[godot 的信号]]`（跨日记重复出现，恰是 P-5 目标反编译要的信号——目标笔记提到技术概念）。
- 个人笔记 frontmatter 是轻量键（`创建/修改/tags`），与课程文件 `node/stage/...` 契约完全不同——**绝不能把个人笔记喂进 `validateNoteFrontmatter`/scanCourseNotes**，需要独立的轻解析（只 split frontmatter + 正文）。
- 归档目录（`过时*`）占文件数一半——扫描必须带排除区，否则归档链接污染先验。

## 4. 推荐管线（五段，纯文件扫描即可起步）

### 4.1 扫描（复用 note-source 卫生）

- 扫描根 = vault 根；**排除区**：`学习中心/`、点目录、`99附件/`、`05ob自定义/`、`00类型/`、`03属性/`、`过时*/`（前缀匹配）；排除清单进扫描配置（缺省内置、可被 config 覆盖），不新增用户必填项。
- 沿用 `collectNoteFiles` 的递归 + 点目录跳过；每文件只做 `stripFrontmatter` + 正文抽取，不触碰课程契约校验。

### 4.2 wikilink 解析（含 alias/锚点/嵌入语法）

单一正则即可覆盖 §3 全部实测形态：

```
(!?)\[\[([^\[\]#|]+)(#[^\[\]|]+)?(\|[^\[\]]*)?\]\]
  ↑嵌入   ↑target          ↑锚点(弃)      ↑alias(留显示)
```

- target 归一：剥尾 `.md`、trim、折叠空白；**按文件名（basename）建 name→path 索引**解析（Obsidian 缺省按最短路径/basename 解析，与 §3 实测一致；实测带目录前缀的链接仅 1 条）。
- 扫描前先剥代码围栏（引擎已有同型先例：`yaml.ts::parseModel` 剥围栏）——防止教程笔记里贴的 `[[示例]]` 文档代码进先验。

### 4.3 噪声过滤（边候选 = 全部通过）

1. **非嵌入**（`![[` 排除——附件引用不是知识边）；
2. **目标是 .md**（`.base/.canvas/.png/...` 全排——实测 83 条）；
3. **目标非日期模式**（`^\d{4}-\d{2}-\d{2}` 排除——日记导航链接）；
4. **目标可解析**到扫描索引内的现存文件（unresolved 先不计边，计数进报告供人补笔记）；
5. **源/目标都不在排除区**；
6. 上下文加权（可后置）：跨**不同源文件**重复出现的链接对（如 `完成第一个游戏demo` 4 次）比单文件单次强得多。

策略上**不做**「日记一律排除」：P-5 目标反编译恰需要日记里的目标→概念链接；用上述规则 + 源区类型权重（§4.4）消化日记噪声，而不是一刀切。

### 4.4 节点映射与置信度

- **映射**：链接目标文件名 → 图节点名，走归一化精确匹配（大小写/空白/全半角）；精确不中再走别名表与模糊匹配（包含关系起步；**嵌入相似度是唯一需要宿主/模型能力的环节**，缺省降级为「不匹配、留在报告里」）。
- **方向语义要诚实**：wikilink 是联想不是依赖，「A 笔记链接 B 笔记」**不能**直接推断 A→B 是 pre。推荐：链接图只产出**无向关联对** {概念A, 概念B, 权重}；「这条边该进 pre 还是 enc、方向朝哪」交给 agent 在 propose 时结合图上下文裁决（analyze 的 jump_candidates 已确立了「机器出候选、逐条裁决」的先例）。经验倾向：映射到的对优先作 **enc（成分技能）候选**，pre 门禁边从严——误加 pre 会锁学习路径，误加 enc 只影响回退路由权重。
- **置信度 w ∈ [0,1]**（与 enc 边 `parseEnc` 的 w 同约定），建议构成：链接次数、独立源文件数、源区类型权重（01笔记/04AI > 日记 > 归档=0 已被排除）、双向链接加成、目标解析与否。分层：≥0.7 进提案；0.4–0.7 进 analyze 建议段待裁决；<0.4 只落扫描报告。

### 4.5 进 analyze/propose 的接口（零 schema 破坏）

- **新引擎模块** `engine/vault-links.ts`（D14 收口：IO 全在 engine 内），扫一次落 `学习中心/state/vault链接.json`（带源文件指纹，漂移可重扫——与笔记源指纹同法）。
- **新只读工具** `learnhub_vault_links_scan`（或直接复刻 enc_backfill 命名为 `learnhub_graph_link_backfill`）：返回候选边 JSON `{a, b, count, files, score, suggestion}`，并可像 enc_backfill 一样**直接产出单个 pending edit 提案**（set_enc/set_pre 的 note 字段注明 `vault 链接先验`，reason 写明来源，人审面板可溯源）。
- **analyze 侧**：`graphAnalyze` 读 `state/vault链接.json` 缓存，`suggestions` 增加自由 JSON 段 `vault_link_candidates`（条目上限沿用「随图规模伸缩」的既有规则）——suggestions 不是校验 schema，加段零破坏。
- **触发时机**：扫描是事件驱动（工具调用 / 生成队列空闲），不进每次 analyze 的热路径；本机量级（276 文件）单次全扫毫秒级，性能不构成约束。

## 5. 降级方案与升级路径

| 环节 | 降级（现在就能做） | 升级（待宿主确认后） |
|---|---|---|
| 全 vault 检索 | 引擎 `node:fs` 自扫（§4.1，零依赖） | 宿主若暴露全文搜索工具，可替换扫描实现，接口不变 |
| 节点模糊映射 | 归一化精确匹配 + 手工别名表 + 包含关系 | 宿主/llm seam 若有 embedding，做相似度匹配（只替换 §4.3 映射一段） |
| 链接语义判定 | 纯规则（§4.2–4.4） | 生成管线已有 llm 调用先例，可让模型对 mid 置信度边做 pre/enc 归类裁决 |

**不建议引擎自建嵌入/向量库**：引入本地模型与向量索引违反轻量依赖原则，且 §3 实测的边规模（百级）远用不上。

## 6. 风险与边界

1. **隐私/越权**：Vault 扫描会读到敏感文件（实测即存在密钥类笔记）。扫描产物只落聚合的候选边（概念对 + 计数），**不落原文**；排除区缺省收紧，密钥/配置类目录（01笔记 这类杂记区可配置排除）由人显式开启。
2. **先验污染**：归档区/日记模板链接若漏排会成批制造假边——过滤规则须带「命中率审计」（一次扫描报告里给出各规则各自拦了多少），防止静默误杀/漏杀（对齐 ADR-0004 用户数据不静默劣化）。
3. **方向误判**：最坏情况是把联想边当 pre 锁死学习路径。缓解：先验只出 enc 候选与 analyze 待裁决项，pre 边必须经 agent 在 propose 里显式主张并人审。
4. ** Vault 之外的本机证据局限**：§1 的宿主结论基于部署残留反推，正式实施前应在有 monorepo 的机器回填宿主工具面清单。

## 7. 主要出处

**本仓库源码（一手）**
- 工具面与宿主 seam：`src/index.ts`（inject 声明 :42；dsh-llm/dsh-tools 导入 :19-21；analyze :1190；propose :1234；enc_backfill :1250）
- 引擎：`src/engine/paths.ts`（vault 两级路径）、`note-source.ts`（ADR-0010 零写入 + collectNoteFiles + normalizeSourcePath）、`graph.ts`（NODE_KEYS/parseEnc w∈[0,1]/Graph 派生/structureCheck）、`content.ts`（enc_candidates :184-188、:969-1027）、`index.ts`（graphEncBackfill :596-636、vaultRoot :119）
- 部署事实：`scripts/link-peers.mjs`（MONOREPO 缺省与 peer 映射）、`cordis.patch.yml`、`package.json` peerDependencies、`README.md`

**宿主侧残留（本机 `~/.dsh/`，只读检查）**
- `profiles/web/package.json`（bundles：dsh-base/dsh-web-app/dsh-learnhub）、`profiles/web/cordis.patch.yml`（vault 机器配置）、`profiles/web/node_modules/`（junction 现状）、`settings.yaml`
- 缺证记录：`C:/Users/test/Desktop/deepseek-harness` 不存在；`~/.dsh/sessions/*/session.jsonl.zstd` 仅会话头

**Vault 实测（只读）**
- 样本：`Desktop/my/Obsidian Vault` 学习中心外 276 个 `.md`；统计口径见 §3 表（grep -E 词法统计，2026-09-08）
- 术语与语义：本仓库 `CONTEXT.md`（Pre/Enc 词条、认知跳跃定义）、`docs/adr/0008`、`docs/adr/0010`、`docs/research/2026-09-big-directions.md`（Arc C：Vault 即课程输入）
