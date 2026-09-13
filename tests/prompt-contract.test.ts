import test from 'node:test'
import assert from 'node:assert/strict'
import { Content } from '../src/engine/content.ts'
import { GROWTH_OPERATORS } from '../src/engine/types.ts'

// ---- v6 提示词契约（#14 P2/P3）：版本标记 + 复杂度档案锚点 ----

test('P2: 存量内置模板全部升到 prompt/v6（生长式套件除外——新套件模板自带版本线）', () => {
  for (const kind of Object.keys(Content.PROMPT_KINDS)) {
    if (kind === '罗盘初画' || kind === '教练回合' || kind === '种子提案') continue // 生长式套件的独立版本线（v1 起），不背 v6 存量约定
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

// ---- P-5 目标反编译模板（#95；v8 种子簇形态 #149）：版本标记 + plan/seed 双半区契约 + 对账与先验注入指令 ----

test('#149: 项目目标反编译模板 v8——plan/seed 双半区契约、名字对账指令、Vault 先验注入、同进同退', () => {
  const tpl = Content.PROMPT_KINDS['项目目标反编译']!
  assert.ok(Content.promptVersionOf(tpl) >= 8, '项目目标反编译 应升到 v8')
  assert.match(tpl, /project: <项目 id/, 'plan 半区 = #92 的 PlanArtifact 契约')
  assert.match(tpl, /acceptance_hints/, '计划条目字段按设计 §3')
  assert.match(tpl, /seed:/, '种子半区 = kind=seed 种子簇形态')
  assert.match(tpl, /零 est 零 enc 零 pre/, '种子节点骨架模式（est/enc/pre 不进提案，粗占位边引擎落）')
  assert.match(tpl, /1–3 起点/, '种子簇 = 1–3 起点 + 终点')
  assert.match(tpl, /名字对账/, '受理侧名字对账指令（计划引用悬空节点整体拒收）')
  assert.match(tpl, /沿用原 id/, '里程碑身份锚钉 id（修订沿用未变条目的 id）')
  assert.match(tpl, /学习者已有理解（Vault 先验）/, '先验段注入指令（尊重已有理解，不从零铺已会节点）')
  assert.match(tpl, /提案/, '双产物走人审提案通道（apply 前零 canonical 写入）')
  assert.match(tpl, /同进同退/, '双提案同进同退（一起生效或一起放弃）')
})

test('面板下发：种子提案模板 v1——起草契约（骨架模式/熟悉边界/绑定字段/目标类型二分）', () => {
  const tpl = Content.PROMPT_KINDS['种子提案']!
  assert.ok(Content.promptVersionOf(tpl) >= 1, '种子提案 自带版本线（生长式套件 v1 起）')
  assert.match(tpl, /1–3 个起点节点 \+ 一个终点节点/, '种子形态锚点')
  assert.match(tpl, /零 enc 零 est 零 pre/, '种子骨架模式（粗占位边引擎落）')
  assert.match(tpl, /熟悉边界/, '起点定位 = vault 先验的熟悉边界路')
  assert.match(tpl, /basis: baseline\|vault/, '起点三路的语义路由声明')
  assert.match(tpl, /照抄附后的「课程名」/, '绑定字段以表单为准（课程名不自拟）')
  assert.match(tpl, /goal_type 照抄附后的「目标类型」/, '目标类型二分由表单绑定')
  assert.match(tpl, /capability/, '能力锚定缺省')
  assert.match(tpl, /仅 goal_type=coverage 时携带/, 'worksheet 只随 coverage')
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

// ---- v5 教练回合契约（#198 / ADR-0055+0056）：主线批必接线终点 + 收尾接线批 ----

test('#198: 教练回合模板 v5——主线批接线义务（set_pre 替换语义）与收尾接线批（收尾即宣告承诺兑现）', () => {
  const tpl = Content.PROMPT_KINDS['教练回合']!
  assert.ok(Content.promptVersionOf(tpl) >= 5, '教练回合应带版本标记 v5+')
  assert.match(tpl, /主线批必接线/, '前进批接线义务锚点')
  assert.match(tpl, /收尾即宣告承诺兑现/, '收尾批 = 承诺兑现宣告（ADR-0056）')
  assert.match(tpl, /零 add_node 的纯 set_pre 接线批/, '收尾批形态（停摆前接线）')
  assert.match(tpl, /禁长过目标/, '禁以终点为 pre')
  assert.match(tpl, /豁免接线义务/, '旁支/巩固/插入豁免')
})

// ---- v2 教练回合契约（#150）：三段式分歧纪律——轻量→全量→双沙盘仲裁终审 ----

test('#150: 教练回合模板 v2——真分歧升级双沙盘仲裁（终审、非承诺措辞照旧）', () => {
  const tpl = Content.PROMPT_KINDS['教练回合']!
  assert.ok(Content.promptVersionOf(tpl) >= 2, '教练回合 应带版本标记 v2+')
  assert.match(tpl, /三段式与分歧纪律/, '三段式升级链（两段式扩三段）')
  assert.match(tpl, /双沙盘/, '真分歧升级双沙盘仲裁')
  assert.match(tpl, /终审/, '仲裁段结论为最终裁决')
  assert.match(tpl, /模型推演，非承诺/, '沙盘参照非承诺措辞照旧（ADR-0025 纪律不动）')
  assert.match(tpl, /不再写（没有更多段了）/, '终审后没有更多段')
  assert.match(tpl, /六区块能裁动就绝不声明/, '仲裁税纪律：六区块能裁动不升级')
})

// ---- v1 教练回合契约（#145 / ADR-0033 滚动教练）：算子集 + 停机转译 + 两段式 + note/route 输出契约 ----

test('#145: 教练回合模板 v1——五算子语义、停机转译、分歧升级、note/route/ops 输出契约', () => {
  const tpl = Content.PROMPT_KINDS['教练回合']!
  assert.ok(Content.promptVersionOf(tpl) >= 1, '教练回合 应带版本标记 v1+')
  // 算子集五件与停机规则转译（前进=目标消费、旁支=教学消费不走复诊）
  for (const op of GROWTH_OPERATORS) {
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
  assert.match(tpl, /disagreement/, '分歧声明字段（避让申诉 Dispute 词条）')
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

// ---- v2 教练回合契约（#146 / 插入提案生命周期）：插入批复诊预注册 + 插入积极性调速 ----

test('#146: 教练回合模板 v2——插入批 note.recheck 预注册（metric 三选一/days 缺省 10）与调速闸门措辞', () => {
  const tpl = Content.PROMPT_KINDS['教练回合']!
  assert.ok(Content.promptVersionOf(tpl) >= 2, '教练回合应带版本标记 v2+')
  // 复诊预注册：metric 恰一枚可机判（小集合枚举锁死）+ 复诊期缺省
  assert.match(tpl, /recheck/, 'recheck 预注册字段（随 note 区）')
  assert.match(tpl, /metric: 前进恢复\|卡点集中度降幅\|保留率恢复/, 'metric 枚举锁死（可机判小集合）')
  assert.match(tpl, /缺省 10 学习日|days 缺省 10/, '复诊期缺省 10 学习日')
  assert.match(tpl, /自动结算/, '到期自动结算归引擎，教练不写结论')
  // 调速闸门对教练可见（插入积极性调速器）
  assert.match(tpl, /闸停|拒收/, '超限批被闸停/拒收的现势语义')
  assert.match(tpl, /旁支占比|旁支超限|韧性闸门/, '旁支上限的韧性闸门')
  // 插入批纪律与其他算子的边界
  assert.match(tpl, /插入批纪律|note\.recheck 必填/, '插入批必须预注册')
  assert.match(tpl, /不走复诊/, '旁支/巩固不走复诊')
})

// ---- v3 教练回合契约（ADR-0040）：生长纪律段——生成时质量自查回归提示词层 ----

test('ADR-0040: 教练回合模板 v3——生长纪律（认知粒度/动作句/螺旋式/依赖充分性/边级自查）+ 上交前自查', () => {
  const tpl = Content.PROMPT_KINDS['教练回合']!
  assert.ok(Content.promptVersionOf(tpl) >= 3, '教练回合应带版本标记 v3+')
  assert.match(tpl, /生长纪律/, '生成时质量段名（受理门只锁 schema 与结构事实）')
  assert.match(tpl, /30 分钟/, '认知粒度 30 分钟自问')
  assert.match(tpl, /动作句/, '动作句命名纪律')
  assert.match(tpl, /螺旋式/, '螺旋式学习合法 + 名称可区分')
  assert.match(tpl, /完整的直接前置集合/, '依赖充分性锚点')
  assert.match(tpl, /真实依赖优先于难度曲线/, '依赖与难度的冲突序（跳跃=症状，留给插入）')
  assert.match(tpl, /边级自查/, '逐边 verdict 纪律')
  assert.match(tpl, /上交前/, 'pre-submit 自查清单锚点')
})

// ---- v2 种子提案契约（ADR-0040）：起点资格判据——单一行为单元 + 复合概念操作化判定 ----

test('ADR-0040: 种子提案模板 v2——起点资格（单一行为单元/零复合概念/宁简勿繁）+ 操作化正反例', () => {
  const tpl = Content.PROMPT_KINDS['种子提案']!
  assert.ok(Content.promptVersionOf(tpl) >= 2, '种子提案应带版本标记 v2+')
  assert.match(tpl, /起点资格/, '资格判据段名（受理门查不了，靠把关）')
  assert.match(tpl, /单一行为单元/, '起点 = 单一行为单元')
  assert.match(tpl, /零复合概念/, '复合概念禁令')
  assert.match(tpl, /不放松起点资格/, '自述基础不放松资格（实测疼点：零基础自述下起点仍复合）')
  assert.match(tpl, /宁简勿繁/, '不对称论证锚点（过简趋零代价 vs 过繁坡道断裂）')
  assert.match(tpl, /「Python 基础语法」/, '复合泛称反例（allo 校勘范式：判据配正反例）')
  assert.match(tpl, /装好环境并运行第一行代码/, '单一行为正例')
})

// ---- v3 种子提案契约（#202 / ADR-0056）：终点资格与起点资格分家 ----

test('#202: 种子提案模板 v3——终点资格（承诺句/面向覆盖/禁窄化/可兑现）+ 操作化反例', () => {
  const tpl = Content.PROMPT_KINDS['种子提案']!
  assert.ok(Content.promptVersionOf(tpl) >= 3, '种子提案应带版本标记 v3+')
  assert.match(tpl, /终点资格/, '终点资格段名（与起点资格分家）')
  assert.match(tpl, /承诺句/, '终点 = 承诺句不是台阶句')
  assert.match(tpl, /禁止静默丢弃/, '面向覆盖纪律（禁静默丢弃）')
  assert.match(tpl, /窄化限定词/, '禁窄化限定词（「或/A 者 B」措辞）')
  assert.match(tpl, /可兑现/, '可兑现性判据（空泛口号不合格）')
  assert.match(tpl, /机器学习/, '操作化反例 = 「数学」课四面向实测案例')
  assert.match(tpl, /不受「单一行为单元」约束/, '终点不吃起点资格判据')
  assert.match(tpl, /定位与取舍/, 'reason 扩「定位与取舍」')
})

// ---- v9 反编译契约（ADR-0040）：seed 起点资格与种子提案同判据 + 上交前自查 ----

test('ADR-0040: 项目目标反编译模板 v9——seed 起点资格同种子提案判据', () => {
  const tpl = Content.PROMPT_KINDS['项目目标反编译']!
  assert.ok(Content.promptVersionOf(tpl) >= 9, '项目目标反编译应升到 v9')
  assert.match(tpl, /起点资格同种子提案/, '种子簇起点与种子提案同判据')
  assert.match(tpl, /单一行为单元/, '起点 = 单一行为单元')
  assert.match(tpl, /上交前自查/, 'pre-submit 自查锚点')
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
