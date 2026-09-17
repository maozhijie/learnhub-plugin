/**
 * 宿主侧提示词文本（#237 / ADR-0075）：住 `src/host/*` 的模型可见散文的单源。
 *
 * **为什么住 engine 下**：本仓 `shared/` 是 UI 与 engine 的共享面，而宿主侧散文只有宿主与
 * 引擎两侧需要；`src/engine/prompts/` 是提示词文本的统一落点，集中一处才好「一个地方找全」。
 * 宿主深导入本文件（纯字符串常量、零运行期语义）——`engine/index.ts` 头注记了这条约定的
 * 边界：host 深导入只准落在纯声明面。
 *
 * **范围口径**（#311 拓宽，取代 ADR-0075 §1 的窄口径）：凡**会进到模型眼前、改变模型行为**
 * 的散文都算——不再限于「做什么、怎么做」的指令，工具 `description`、参数说明、上下文包骨架行、
 * 视图骨架行、回执与拒收回灌文案同样归 `prompts/`（教练三站的活图/草稿两口径已各自归位同族
 * 文件）。判据收敛为「删掉这段文字，模型的行为会不会变」，会变的才进这里。
 *
 * **尚未迁入（后续波次，见 ADR-0100）**：`shared/content-renderers.ts::rendererCapabilityBlock()`
 * 的能力清单正文与 `host/jobs.ts::sectionMaterials` 的节块标题（后者散在站点，逐条待收）——
 * 前者受分层门约束（`shared/` 不能反向 import `engine/`，须「数据留 shared、骨架文本落 prompts、
 * 拼装移 engine 侧」），两者单独立票。
 *
 * 渲染：取值走 `../prompt-render.ts::render`（`{{var}}` 占位符，缺变量与残留都抛）。
 * **本文件不得整体送进 `render`**——占位符是按段声明的。
 */

/** 导师会话系统提示词（`/tutor`）：角色 + 范围纪律 + learnhub-teacher 动作块格式。
 * 上下文包（discussionPack）由调用点在尾部拼接，不进变量面——它是材料，不是指令。 */
export const TUTOR_SYSTEM_INSTRUCTIONS = `你是 learnhub 的 AI 老师，正在辅导学习者攻克一个课程节点。只依据下面的课程上下文与本课范围回答；超出范围的追问给一句概括并建议回到课程主线。回答用 Markdown，简洁直接，公式用 KaTeX（$...$）。\n\n若页面上有交互模拟件且演示能帮助理解，可在回答末尾附一个 learnhub-teacher 动作块（普通回答不要输出）：\n\`\`\`learnhub-teacher\n{ "action": "highlight|setState|reveal|annotate", "selector": "#元素CSS选择器", "state": {"变量名": 值}, "text": "批注文字" }\n\`\`\`\n面板会把块转成「在交互件上演示」按钮并广播给本页全部交互件；highlight/reveal 需 selector，annotate 需 text，setState 需 state（变量名与交互件滑杆一致）。`

/** 节生成材料块里的**前节结尾**段标题（`host/jobs.ts::sectionMaterials`）。整段就靠这句
 * 约束模型的衔接行为（只参考、不复述），所以它是指令、不是标签；同段的 `## 本节任务`
 * 与节 id/标题行是纯容器与数据标签，留在原站点。 */
export const SECTION_PREV_TAIL_HEADING = '## 前节结尾（仅供衔接参考，不复述前节内容）'

// ---------------------------------------------------------------- spike 装置专用（#216 / ADR-0069）
// 下面三条是**工具通道 spike** 的措辞变体（FormatSpread 抗性检查），只被 `scripts/spike.mjs`
// 与 `host/spike.ts` 的实验路径消费，不进生产调用链。放这里是为了「提示词单源」不留例外，
// 但改动它们不影响任何生产站的产出——别把它们当成活的生产提示词。

/** control 臂·重申契约（语义等价于现状，只把契约再强调一遍）。 */
export const SPIKE_SUFFIX_RESTATE_CONTRACT = '\n\n（提醒：只输出一个 YAML 文档；不要代码围栏、不要任何解释。）'
/** tool 臂·指令式（通道变更说明）。 */
export const SPIKE_SUFFIX_TOOL_IMPERATIVE = '\n\n（本轮输出通道变更：必须调用 submit 工具提交结果，不要输出任何正文——把全部内容放进工具参数，参数是 JSON。）'
/** tool 臂·口令式（同义的另一种说法）。 */
export const SPIKE_SUFFIX_TOOL_PASSWORD = '\n\n（交卷方式：用 submit 工具。除工具调用外不要写任何文字；工具的参数就是你的完整 JSON 结果。）'
