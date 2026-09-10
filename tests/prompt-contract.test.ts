import test from 'node:test'
import assert from 'node:assert/strict'
import { Content } from '../src/engine/content.ts'

// ---- v6 提示词契约（#14 P2/P3）：版本标记 + 复杂度档案锚点 ----

test('P2: 存量内置模板全部升到 prompt/v6（生长式套件除外——新套件模板自带版本线）', () => {
  for (const kind of Object.keys(Content.PROMPT_KINDS)) {
    if (kind === '罗盘初画' || kind === '教练回合') continue // 生长式套件的独立版本线（v1 起），不背 v6 存量约定
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

// ---- P-5 目标反编译模板（#95）：版本标记 + 双产物输出契约 + 先验注入指令 ----

test('P5: 项目目标反编译模板——版本标记、plan/subgraph 双产物契约、Vault 先验注入指令', () => {
  const tpl = Content.PROMPT_KINDS['项目目标反编译']!
  assert.ok(Content.promptVersionOf(tpl) >= 6, '项目目标反编译 应带版本标记 v6+')
  assert.match(tpl, /project: <项目 id/, 'plan 半区 = #92 的 PlanArtifact 契约')
  assert.match(tpl, /acceptance_hints/, '计划条目字段按设计 §3')
  assert.match(tpl, /subgraph:/, '子图半区 = 图谱域 gen regions 形态')
  assert.match(tpl, /enc:/, '子图节点可挂成分技能边')
  assert.match(tpl, /学习者已有理解（Vault 先验）/, '先验段注入指令（尊重已有理解，不从零铺已会节点）')
  assert.match(tpl, /提案/, '双产物走人审提案通道（apply 前零 canonical 写入）')
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

// ---- v1 教练回合契约（#145 / ADR-0033 滚动教练）：算子集 + 停机转译 + 两段式 + note/route 输出契约 ----

test('#145: 教练回合模板 v1——五算子语义、停机转译、分歧升级、note/route/ops 输出契约', () => {
  const tpl = Content.PROMPT_KINDS['教练回合']!
  assert.ok(Content.promptVersionOf(tpl) >= 1, '教练回合 应带版本标记 v1+')
  // 算子集五件与停机规则转译（前进=目标消费、旁支=教学消费不走复诊）
  for (const op of ['前进', '插入', '巩固', '旁支', '换向']) {
    assert.ok(tpl.includes(`**${op}**`), `算子集含「${op}」`)
  }
  assert.match(tpl, /目标消费/, '前进 = 目标消费（停机规则转译进算子语义）')
  assert.match(tpl, /教学消费/, '旁支 = 教学消费')
  assert.match(tpl, /不走复诊/, '旁支/巩固不走复诊')
  assert.match(tpl, /只引已教概念/, '巩固只引已教概念')
  assert.match(tpl, /重新种子提案/, '换终点不归教练（走重新种子人审）')
  // 两段式与分歧纪律
  assert.match(tpl, /轻量段/, '轻量段（显然步）')
  assert.match(tpl, /免仲裁税/, '显然步免仲裁税')
  assert.match(tpl, /真分歧/, '真分歧才声明')
  assert.match(tpl, /dispute/, '分歧声明字段')
  assert.match(tpl, /全量段/, '分歧升级全量段')
  // 输出契约
  assert.match(tpl, /note:/, 'note 区（算子+理由+分歧）')
  assert.match(tpl, /operator: 前进\|插入\|巩固\|旁支\|换向/, '算子枚举锁死')
  assert.match(tpl, /reason:/, '理由必填')
  assert.match(tpl, /route: \|/, '罗盘随批重写（route 块）')
  assert.match(tpl, /ops: \[\]/, '零操作=暂不产结构（合法语态）')
  assert.match(tpl, /逐字来自图面/, '节点名/pre 引用逐字来自图面')
  assert.match(tpl, /每批重算一次|不做一次性规划|≤8 个操作/, '批规模克制')
  assert.match(tpl, /单引号/, 'YAML 单引号规则锚点')
  // 停机语义：回合被拉起 = 就绪深度未满足
  assert.match(tpl, /就绪深度检查未满足/, '停机转译：拉起即缺口')
})
