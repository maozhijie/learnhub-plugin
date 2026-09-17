import test from 'node:test'
import assert from 'node:assert/strict'
import { Content } from '../src/engine/content/content.ts'
import { GROWTH_OPERATORS } from '../src/engine/types.ts'
import { withVault } from './helpers/vault.ts'

// ---- v6 提示词契约（#14 P2/P3）：版本标记 + 复杂度档案锚点 ----

test('P2: 存量内置模板全部升到 prompt/v6（生长式套件除外——新套件模板自带版本线）', () => {
  for (const kind of Object.keys(Content.PROMPT_KINDS)) {
    if (kind === '罗盘初画' || kind === '思路官回合' || kind === '思路官重裁' || kind === '执行官回合') continue // 生长式套件的独立版本线（v1 起），不背 v6 存量约定
    const text = Content.PROMPT_KINDS[kind]!
    assert.ok(Content.promptVersionOf(text) >= 6, `${kind} 应升到 v6+`)
  }
})

test('P2: 大纲模板节数锚定改指上下文包 §9（不再写死"通常 3-8 节"）', () => {
  const tpl = Content.PROMPT_KINDS['课程大纲']!
  assert.match(tpl, /复杂度档案/)
  assert.match(tpl, /目标节段数区间/)
  assert.doesNotMatch(tpl, /通常 3–8 节/)
})

test('P2: 节生成模板文字预算与可视化引导改指上下文包 §9（不再写死 ≤150 字）', () => {
  const tpl = Content.PROMPT_KINDS['课程节生成']!
  assert.match(tpl, /复杂度档案/)
  assert.match(tpl, /大多数节段配一个主体可视化/)
  assert.doesNotMatch(tpl, /文字只做引导与衔接（≤150 字）/)
})

test('P2: 风格变体模板同步 v6 锚点（与默认模板同口径）', () => {
  for (const kind of ['课程节生成-苏格拉底', '课程节生成-费曼'] as const) {
    const tpl = Content.PROMPT_KINDS[kind]!
    assert.match(tpl, /复杂度档案/, `${kind} 应指向 §9 锚点`)
  }
})

// ---- P-5 目标反编译模板（#95；v11 plan-only 形态 #149/#240·ADR-0076 种子降职）：版本标记 + 单半区契约 + 对账与先验注入指令 ----

test('#149/#240: 项目目标反编译模板 v11——plan-only 契约（ADR-0076 种子降职）、名字对账指令、Vault 先验注入', () => {
  const tpl = Content.PROMPT_KINDS['项目目标反编译']!
  assert.ok(Content.promptVersionOf(tpl) >= 11, '项目目标反编译 应升到 v11')
  assert.match(tpl, /project: <项目 id/, 'plan 半区 = #92 的 PlanArtifact 契约')
  assert.match(tpl, /acceptance_hints/, '计划条目字段按设计 §3')
  assert.doesNotMatch(tpl, /seed:/, '种子半区退役（ADR-0076：反编译不再自带建课能力，YAML 顶层只剩 project+plan）')
  assert.match(tpl, /目标课程已注册/, '落点裁决进提示词（未注册拒并指引先建课）')
  assert.match(tpl, /名字对账/, '受理侧名字对账指令（计划引用悬空节点整体拒收）')
  assert.match(tpl, /沿用原 id/, '里程碑身份锚钉 id（修订沿用未变条目的 id）')
  assert.match(tpl, /学习者已有理解（Vault 先验）/, '先验段注入指令（尊重已有理解，不从零铺已会节点）')
  assert.match(tpl, /提案/, '产物走人审提案通道（apply 前零 canonical 写入）')
  assert.match(tpl, /留给教练按计划修订补支生长/, '新知识缺口不硬凑名字（走计划修订驱动的教练补支）')
})

// ---- v9 题目生成契约（ADR-0029/0030）：唯一答案填空 + 记法契约 + YAML 单引号规则 ----

test('P2: 题目生成/笔记出题模板升到 v9 并携带新契约锚点', () => {
  for (const kind of ['题目生成', '笔记出题'] as const) {
    const tpl = Content.PROMPT_KINDS[kind]!
    assert.ok(Content.promptVersionOf(tpl) >= 9, `${kind} 应升到 v9`)
    assert.match(tpl, /只考唯一写法的术语/, `${kind} 填空唯一答案锚点`)
    assert.match(tpl, /数学记法契约/, `${kind} 记法契约锚点`)
    assert.match(tpl, /单引号/, `${kind} YAML 单引号规则锚点`)
    assert.match(tpl, /禁用双引号/, `${kind} YAML 双引号禁令锚点`)
    assert.match(tpl, /≤4 句/, `${kind} 解析限长锚点`)
    assert.match(tpl, /最易错点/, `${kind} 解析三段结构锚点`)
  }
  const quiz = Content.PROMPT_KINDS['题目生成']!
  assert.match(quiz, /数字与代数式一律不进填空/, '数字与代数式不进填空')
  assert.match(quiz, /必须用单选/, '表达式答案走单选')
})

// ---- v8 课程大纲契约（P-8 #97 专家思维轨迹 + C-3 #82 同期）：思维节类型 + §10/§11 指针 ----

test('P8: 课程大纲模板升到 v8 并携带思维节类型与 §10/§11 硬性要求指针', () => {
  const tpl = Content.PROMPT_KINDS['课程大纲']!
  assert.ok(Content.promptVersionOf(tpl) >= 8, '课程大纲 应升到 v8')
  assert.match(tpl, /概念\/例题\/演示\/小结\/练习\/交互\/思维/, '节类型菜单含思维')
  assert.match(tpl, /§10（先做后教）与 §11（专家思维轨迹）出现时是硬性要求/, '上下文包硬性要求指针')
})

// ---- v9 节段模板契约（#147）：难度档锚 + 前置档位区块 + 误解坑位 + 检索点 + 样例密度 ----

test('#147: 课程大纲/节生成三模板升到 v9 并携带难度档锚与前置档位/误解坑位/检索点/样例密度锚点', () => {
  for (const kind of ['课程大纲', '课程节生成', '课程节生成-苏格拉底', '课程节生成-费曼'] as const) {
    const tpl = Content.PROMPT_KINDS[kind]!
    assert.ok(Content.promptVersionOf(tpl) >= 9, `${kind} 应升到 v9`)
    assert.match(tpl, /节段难度档/, `${kind} 节段难度档锚点`)
  }
  const outline = Content.PROMPT_KINDS['课程大纲']!
  assert.match(outline, /tier: 低\|中\|高/, '大纲输出 schema 含节段 tier 字段')
  assert.match(outline, /难度档锚/, 'tier 字段语义 = 难度档锚')
  for (const kind of ['课程节生成', '课程节生成-苏格拉底', '课程节生成-费曼'] as const) {
    const tpl = Content.PROMPT_KINDS[kind]!
    assert.match(tpl, /前置概念档位/, `${kind} 前置档位区块锚点`)
    assert.match(tpl, /误解坑位（生成期先验）/, `${kind} 误解坑位区块锚点`)
    assert.match(tpl, /检索点/, `${kind} 检索点锚点`)
    assert.match(tpl, /样例密度/, `${kind} 样例密度锚点`)
    assert.match(tpl, /worked example/, `${kind} 样例（worked example）锚点`)
  }
})

// ---- v10 题目生成契约（#147）：难度锚定跟随注入 + 误解先验干扰项材料 ----

test('#147: 题目生成模板升到 v10——难度按注入锚定走、误解先验（干扰项材料）消费锚点', () => {
  const tpl = Content.PROMPT_KINDS['题目生成']!
  assert.ok(Content.promptVersionOf(tpl) >= 10, '题目生成 应升到 v10')
  assert.match(tpl, /难度按系统附的「难度锚定」走/, '写死的开头 d1/中间 d2/收尾 d3 退役，跟随注入锚定')
  assert.match(tpl, /误解先验（干扰项材料）/, '干扰项消费误解先验')
  assert.match(tpl, /以指令为准/, '先验让位于学习者生成指令')
})

// ---- v11 题目生成契约（#148）：invokes 出生打标（恰一枚概念） ----

test('#148: 题目生成模板升到 v11——出生打标 invokes：恰一枚概念、清单照抄、空缺禁令', () => {
  const tpl = Content.PROMPT_KINDS['题目生成']!
  assert.ok(Content.promptVersionOf(tpl) >= 11, '题目生成 应升到 v11')
  assert.match(tpl, /恰一枚/, '一枚 invokes（不多枚）')
  assert.match(tpl, /概念清单/, '取值域 = 引擎注入的概念清单')
  assert.match(tpl, /精确照抄/, '名字精确照抄（canonical/别名）')
  assert.match(tpl, /不得空缺/, '空缺禁令（空→修复一次仍空拒收的服务端兜底）')
  assert.match(tpl, /清单外的名字/, '不得自创清单外名字')
  assert.match(tpl, /未附「概念清单」时省略 invokes/, '清单缺席 = 门不激活（invokes 恒合法 Missing）')
  assert.match(tpl, /invokes: <概念清单中的名字>/, '输出 schema 样例带 invokes 字段')
})

// ---- v7 错误对比卡契约（#147）：出生期候选错法（先验让位于真实错答） ----

test('#147: 错误对比卡模板升到 v7——干扰做法可从误解先验取材、mine 仍以真实错答为准', () => {
  const tpl = Content.PROMPT_KINDS['错误对比卡']!
  assert.ok(Content.promptVersionOf(tpl) >= 7, '错误对比卡 应升到 v7')
  assert.match(tpl, /误解先验（出生期候选错法）/, '出生期候选错法锚点')
  assert.match(tpl, /mine 仍以学习者错答为准/, '先验让位于真实数据')
})

// ---- 错误对比卡模板（C-3 #82）：三选一辨别卡契约 ----

test('C3: 错误对比卡模板——三选一、mine 忠实错法、候选照抄契约', () => {
  const tpl = Content.PROMPT_KINDS['错误对比卡']!
  assert.ok(Content.promptVersionOf(tpl) >= 6, '错误对比卡 应升到 v6+')
  assert.match(tpl, /answer/, '正确项字段')
  assert.match(tpl, /mine/, '学习者错法项字段')
  assert.match(tpl, /source_q/, '候选来源照抄字段')
  assert.match(tpl, /恰好 3 个选项/, '三选一结构锚点')
  assert.match(tpl, /忠实还原学习者的真实思路/, '错法忠实性锚点')
})

// ---- v1 罗盘初画契约（#143 / ADR-0033 透明度装置）：非承诺草图 + 批注软输入 ----

test('#143: 罗盘初画模板 v1——非承诺措辞、批注软输入、路线条目输出契约', () => {
  const tpl = Content.PROMPT_KINDS['罗盘初画']!
  assert.ok(Content.promptVersionOf(tpl) >= 1, '罗盘初画 应带版本标记 v1+')
  assert.match(tpl, /不是承诺/, '路线是草图不是承诺')
  assert.match(tpl, /软输入/, '批注区是教练软输入')
  assert.match(tpl, /提议非指令/, '批注提议非指令锚点')
  assert.match(tpl, /不带 "## " 标题/, '输出不得携带段级标题（段落结构保护）')
  assert.match(tpl, /3–7 个阶段条目/, '路线条目数量锚')
  assert.match(tpl, /（候选）/, '未落图台阶一律标候选')
  assert.match(tpl, /不写时间估算|不写进度百分比/, '零时间/进度承诺')
  assert.match(tpl, /模型推演，非承诺/, 'ETA 才是推演参照且措辞锁死')
  assert.match(tpl, /块工作表/, '覆盖锚定课程按工作表块组织')
})

// ---- v1 思路官回合契约（#273 两站编排）：算子集 + 停摆转译 + 零名字交接契约 ----

test('#273: 思路官回合模板 v1——算子集含停摆、零名字交接契约、朝向声明、recheck 仅插入携带', () => {
  const tpl = Content.PROMPT_KINDS['思路官回合']!
  assert.ok(Content.promptVersionOf(tpl) >= 1, '思路官回合 应带版本标记 v1+')
  // 算子集（五件 + 停摆；停机规则转译进算子语义）
  for (const op of GROWTH_OPERATORS) {
    assert.ok(tpl.includes(`**${op}**`), `算子集含「${op}」`)
  }
  assert.match(tpl, /\*\*停摆\*\*/, '停摆 = 结构暂无需变化（steps 为空，裁决留痕）')
  assert.match(tpl, /目标消费/, '前进 = 目标消费（停机规则转译进算子语义）')
  assert.match(tpl, /症状消费/, '插入 = 症状消费')
  assert.match(tpl, /教学消费/, '旁支 = 教学消费')
  assert.match(tpl, /只行使已教概念/, '巩固只行使已教概念')
  assert.match(tpl, /只裁决朝哪个已声明终点长/, '换向只裁决朝向（ADR-0076；终点的增删归学习者——锚点短语随 19f74d3 措辞修订对齐）')
  // 零名字契约：单轮零工具单发，粒度变焦归执行官
  assert.match(tpl, /不动手改图/, '思路官零工具（交接契约的载体约束；锚点随 19f74d3 措辞修订对齐）')
  assert.match(tpl, /零节点名、零图上引用/, '交接计划零名字（幻觉面结构性消失的锚点）')
  assert.match(tpl, /意图句/, '台阶用意图句描述')
  assert.match(tpl, /登记表档位/, '概念名逐字来自登记表档位区')
  // 朝向声明与收尾朝向的算子判断（sealed 是批形态触发的引擎自动标记）
  assert.match(tpl, /target_endpoints/, '朝向声明字段')
  assert.match(tpl, /交汇优先/, '多终点交汇优先')
  assert.match(tpl, /收尾朝向是算子判断的一部分/, '收尾不是提示词族——计划内算子判断')
  // 输出契约
  assert.match(tpl, /operator: 前进\|插入\|巩固\|旁支\|换向\|停摆/, '算子枚举（含停摆）')
  assert.match(tpl, /reason:/, '理由必填')
  assert.match(tpl, /steps:/, '交接计划台阶列表')
  assert.match(tpl, /teaches_concept/, '概念面字段（只写概念名）')
  assert.match(tpl, /metric: 前进恢复\|卡点集中度降幅\|保留率恢复/, 'recheck metric 枚举锁死')
  assert.match(tpl, /recheck 仅 operator=插入 时携带/, '非插入批禁带 recheck')
  assert.match(tpl, /停摆只能由 operator: 停摆 表达/, '零步只属停摆（非停摆的空 steps 由门拒，#313 C15）')
  assert.match(tpl, /其余算子必须给出至少一个台阶/, '「计划不完整」与「裁决停摆」是两件事——非停摆必须给台阶')
  // 停机语义
  assert.match(tpl, /就绪深度检查未满足/, '停机转译：拉起即缺口')
})

// ---- v1 思路官重裁契约（#273 显式重裁族）：上次裁决摘要回灌 + 沿用/推翻纪律 ----

test('#273: 思路官重裁模板 v1——显式重新裁决、上次裁决摘要随包、沿用或推翻说理', () => {
  const tpl = Content.PROMPT_KINDS['思路官重裁']!
  assert.ok(Content.promptVersionOf(tpl) >= 1, '思路官重裁 应带版本标记 v1+')
  assert.match(tpl, /显式重新裁决/, '重裁族定位（node_skip / panel_dispatch）')
  assert.match(tpl, /上次裁决摘要/, '摘要块随包回灌')
  assert.match(tpl, /可沿用（现状未变）也可推翻/, '沿用或推翻的双向语义')
  assert.match(tpl, /重裁不是重试/, '重裁纪律（推翻时 reason 说明）')
  assert.match(tpl, /零节点名、零图上引用/, '零名字契约与常规族同构')
  assert.match(tpl, /operator: 前进\|插入\|巩固\|旁支\|换向\|停摆/, '算子枚举同构')
})

// ---- v11 反编译契约（#240 / ADR-0076；#256 随种子链整体退役）：上交前自查 ----

test('ADR-0076/#256: 项目目标反编译模板——起点资格判据不入反编译（随种子半区整体退役）', () => {
  const tpl = Content.PROMPT_KINDS['项目目标反编译']!
  assert.ok(Content.promptVersionOf(tpl) >= 9, '项目目标反编译应升到 v9+')
  assert.doesNotMatch(tpl, /起点资格/, '起点资格判据已随种子半区退役（#256）')
  assert.doesNotMatch(tpl, /单一行为单元/, '单一行为单元判据已随种子半区退役（#256）')
  assert.match(tpl, /上交前自查/, 'pre-submit 自查锚点（plan-only 形态自查 plan.nodes 对账）')
})

// ---- v10 节间连贯契约（#227）：模板声称与注入成分对齐——空头承诺清零 ----

test('#227: 大纲/节生成三变体升 v10——节清单+前节结尾注入后，声称与实际成分一一对应', () => {
  for (const kind of ['课程大纲', '课程节生成', '课程节生成-苏格拉底', '课程节生成-费曼'] as const) {
    const tpl = Content.PROMPT_KINDS[kind]!
    assert.ok(Content.promptVersionOf(tpl) >= 10, `${kind} 应升到 v10`)
    // 空头承诺清零：注入的实态是「前节结尾窗口 + 节清单」，不是「前节已生成正文」全文
    assert.doesNotMatch(tpl, /前节已生成正文/, `${kind} 不再声称注入前节已生成正文全文`)
  }
  assert.match(Content.PROMPT_KINDS['课程大纲']!, /注入节清单与前节结尾保证连贯/, '大纲递进原则指向实际注入成分')
  for (const kind of ['课程节生成', '课程节生成-苏格拉底', '课程节生成-费曼'] as const) {
    const tpl = Content.PROMPT_KINDS[kind]!
    assert.match(tpl, /前节结尾（非首节）/, `${kind} 头注声明的附带成分与实际一致`)
    assert.match(tpl, /与「前节结尾」自然衔接/, `${kind} 衔接约束指向注入块名`)
    assert.match(tpl, /仅供衔接参考，不复述/, `${kind} 带衔接参考不复述指令`)
  }
})

// ---- v12 题目生成契约（#232）：收尾跨概念对比题 + 易混对段条件条款 ----

test('#232: 题目生成模板 v12——收尾易混对比题条款（易混对段缺席静默降级、invokes 记主概念）', () => {
  const tpl = Content.PROMPT_KINDS['题目生成']!
  assert.ok(Content.promptVersionOf(tpl) >= 12, '题目生成 应升到 v12')
  assert.match(tpl, /易混对/, '条款 conditioned on 易混对段在场')
  assert.match(tpl, /跨概念对比题/, '收尾槽位对比题指令')
  assert.match(tpl, /干扰项取其易混概念或典型混淆做法/, '干扰项取易混概念/做法')
  assert.match(tpl, /被区分的主概念/, '对比题 invokes 记被区分的主概念（恰一枚不破）')
  assert.match(tpl, /缺席时本条不适用/, '静默降级：不硬造对比题')
})

// ---- v11 节生成 / v13 题目生成契约（#233）：双重编码组合原则——软指令不进门禁 ----

test('#233: 节生成三变体升 v11——硬约束 6 带图文互引半句；题目生成升 v13——解析配图升「应配」（软措辞）', () => {
  for (const kind of ['课程节生成', '课程节生成-苏格拉底', '课程节生成-费曼'] as const) {
    const tpl = Content.PROMPT_KINDS[kind]!
    assert.ok(Content.promptVersionOf(tpl) >= 11, `${kind} 应升到 v11`)
    assert.match(tpl, /文字与图互引——文字提及图、图内标注与正文术语一致/, `${kind} 图文互引半句在硬约束 6`)
    assert.match(tpl, /防图文两张皮/, `${kind} 互引的目标（组合原则）点明`)
  }
  const quiz = Content.PROMPT_KINDS['题目生成']!
  assert.ok(Content.promptVersionOf(quiz) >= 13, '题目生成 应升到 v13')
  assert.match(quiz, /解析应配一个 ```svg 或 ```plot 代码块配图/, '几何/函数/数据类解析配图由「可用」升「应配」')
  assert.match(quiz, /软性要求，不进门禁/, '保持软措辞——零新增门禁 finding（验收红线）')
})

// ---- #302 ①：渲染菜单只认占位符（旧兜底回收——输出契约不被注入面覆盖）----

/** 占位符站（模板里带 `{{renderers}}`）= 课程节生成三风格变体；其余 13 站无占位符。 */
const RENDERER_PLACEHOLDER_KINDS = ['课程节生成', '课程节生成-苏格拉底', '课程节生成-费曼'] as const

test('#302: 无占位符的 13 个内置站不被追加渲染菜单（loadPrompt 逐字等于模板原文）；三风格变体照旧注入', async () => {
  const kinds = Object.keys(Content.PROMPT_KINDS)
  assert.equal(kinds.length, 16, '内置站总数（13 无占位符 + 3 风格变体）')
  assert.deepEqual(
    kinds.filter(k => Content.PROMPT_KINDS[k]!.includes('{{renderers}}')).sort(),
    [...RENDERER_PLACEHOLDER_KINDS].sort(),
    '占位符站恰三风格变体——模板面是这份断言的取值域',
  )
  await withVault({ tag: 'renderers-placeholder' }, async h => {
    for (const kind of kinds) {
      const final = await h.engine.content2.loadPrompt(kind)
      if ((RENDERER_PLACEHOLDER_KINDS as readonly string[]).includes(kind)) {
        assert.match(final, /## 面板支持的渲染格式/, `${kind}（占位符站）应注入渲染能力清单`)
        assert.doesNotMatch(final, /\{\{renderers\}\}/, `${kind} 占位符应被替换干净`)
      } else {
        assert.doesNotMatch(final, /面板支持的渲染格式/, `${kind} 输出契约不得被面板渲染菜单覆盖（#302 ①）`)
        assert.equal(final, Content.PROMPT_KINDS[kind]!, `${kind} 无占位符 = 零注入（loadPrompt 逐字交还模板）`)
      }
    }
  })
})
