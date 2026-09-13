/**
 * 输出契约注册表文本锚门（#214 / ADR-0061）：PROMPT_KINDS 模板文本、判卷族系统提示词
 * 与注册表三方交叉核对——模板里「只输出一个 YAML（不要围栏、不要解释）」族指令与
 * 注册表声明漂移即红。门带自检（ADR-0047 铁律①）：故意改坏一个锚点必须变红，防恒过门。
 *
 * 覆盖对账（同门）：注册表站名 ⊆ 语料站名词表（host STATIONS，#213 受控词表）；注册表
 * 模板键 = PROMPT_KINDS 全集（14 模板站，节生成三变体一票三键）；明示不在册的会话站
 * 也必须在词表内（防幽灵站名）。phase 1 格式级校验器逐 shape 正反夹具对账。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { Content } from '../src/engine/content.ts'
import {
  OUTPUT_CONTRACTS, OUT_OF_SCOPE_STATIONS, PROMPT_CHANGELOG, contractOf, validateByContract,
} from '../src/engine/output-contracts.ts'
import type { OutputContract, PromptBump } from '../src/engine/output-contracts.ts'
import { splitContractSection, withContractLast } from '../src/engine/prompt-assembly.ts'
import { DISPUTE_REVIEW_SYSTEM, OPEN_QUESTION_GRADING_SYSTEM, REFLECTION_GRADING_SYSTEM } from '../src/engine/grading.ts'
import { receiptReviewSystem } from '../src/engine/receipts.ts'
import { solverPromptFor } from '../src/engine/question-audit.ts'
import { STATIONS } from '../src/host/corpus.ts'

/** 锚文本解析表：判别名 → 系统提示词原文；规范块判别名 → 引擎拼装块原文。 */
const SYSTEM_TEXTS: Record<string, string> = {
  reflection: REFLECTION_GRADING_SYSTEM,
  open: OPEN_QUESTION_GRADING_SYSTEM,
  dispute: DISPUTE_REVIEW_SYSTEM,
  receipt: receiptReviewSystem(),
}
const SPEC_BLOCK_TEXTS: Record<string, string> = {
  interactiveSpecBlock: Content.interactiveSpecBlock(),
  solverPrompt: solverPromptFor({ kind: 'true_false', q: '（示例题干）', answer: true }),
}

/** 文本锚门本体（可注入 = 自检可改坏样本）：契约句族漂移、机器块禁令、覆盖完备性、
 * 站名对账、结构化资格不变式，全部在这一个函数里执法。 */
function runContractGate(
  contracts: readonly OutputContract[],
  outOfScope: readonly { station: string; reason: string }[],
  kinds: Record<string, string>,
  stations: ReadonlySet<string>,
): void {
  // —— 覆盖完备性（双向）：注册表模板键 = PROMPT_KINDS 全集且一键至多一站声明；
  // 语料站词表每个值要么在注册表、要么在明示不在册清单（防新站漏登静默放过）——
  const seen = new Map<string, string>()
  for (const c of contracts) {
    for (const t of c.templates ?? []) {
      const owner = seen.get(t)
      assert.ok(!owner, `模板键「${t}」被 ${owner} 与 ${c.station} 重复声明`)
      seen.set(t, c.station)
    }
  }
  const covered = new Set<string>()
  for (const c of contracts) for (const t of c.templates ?? []) covered.add(t)
  assert.deepEqual(
    [...covered].sort(), Object.keys(kinds).sort(),
    '注册表模板键与 PROMPT_KINDS 全集必须一一对应（漂移 = 新站未登记或旧站漏登）',
  )
  // —— 站名对账（双向）：注册表与明示不在册清单的站名都必须在语料词表；
  // 词表里的每个站也必须有归属（在册或明示不在册）——
  for (const c of contracts) {
    assert.ok(stations.has(c.station), `契约站名「${c.station}」不在语料站名词表（host STATIONS）`)
  }
  for (const x of outOfScope) {
    assert.ok(stations.has(x.station), `不在册站名「${x.station}」不在语料站名词表——幽灵站名`)
    assert.ok(x.reason.trim(), `不在册站「${x.station}」必须给理由`)
  }
  const claimed = new Set([...contracts.map(c => c.station), ...outOfScope.map(x => x.station)])
  for (const s of stations) {
    assert.ok(claimed.has(s), `语料站「${s}」既无契约条目也不在明示不在册清单——新站接入时必须二选一登记（#214）`)
  }
  // —— 逐契约：锚源至少一族、契约句族全部命中、格式 sanity、机器块禁令、结构化资格 ——
  for (const c of contracts) {
    const anchors: Array<{ key: string; text: string }> = [
      ...(c.templates ?? []).map(t => {
        assert.ok(kinds[t] !== undefined, `契约「${c.station}」声明的模板键「${t}」不在 PROMPT_KINDS`)
        return { key: `模板:${t}`, text: kinds[t]! }
      }),
      ...(c.systemAnchors ?? []).map(s => {
        assert.ok(SYSTEM_TEXTS[s] !== undefined, `未知系统提示词判别名「${s}」`)
        return { key: `system:${s}`, text: SYSTEM_TEXTS[s]! }
      }),
      ...(c.specBlocks ?? []).map(s => {
        assert.ok(SPEC_BLOCK_TEXTS[s] !== undefined, `未知规范块判别名「${s}」`)
        return { key: `spec:${s}`, text: SPEC_BLOCK_TEXTS[s]! }
      }),
    ]
    assert.ok(anchors.length > 0, `契约「${c.station}${c.surface ? '/' + c.surface : ''}」没有声明任何锚源`)
    // 契约句只对契约所在位置（contractLocation）的锚族核对：回执评审的 JSON 契约住在
    // system 提示词（全仓唯一先例），模板只定义评审立场——两族不得互相背书。
    const clauseAnchors = (c.contractLocation ?? '模板') === 'system'
      ? anchors.filter(a => a.key.startsWith('system:'))
      : anchors.filter(a => !a.key.startsWith('system:'))
    assert.ok(clauseAnchors.length > 0, `契约「${c.station}${c.surface ? '/' + c.surface : ''}」的契约位置没有锚文本`)
    for (const a of clauseAnchors) {
      for (const clause of c.clause) {
        assert.ok(
          a.text.includes(clause),
          `「${c.station}${c.surface ? '/' + c.surface : ''}」契约句漂移：${a.key} 缺少原句「${clause}」——改模板须同步注册表（#214）`,
        )
      }
    }
    if (c.format === 'yaml') {
      assert.ok(c.clause.some(x => x.includes('YAML')), `yaml 站「${c.station}」契约句必须点名 YAML`)
      for (const t of c.templates ?? []) {
        assert.doesNotMatch(
          kinds[t]!, /enc_candidates/,
          `yaml 站「${c.station}」模板不得出现机器块指令（enc_candidates 只属于节正文契约——§8 契约矛盾事故类的锚）`,
        )
      }
    }
    if (c.format === 'json') {
      assert.ok(c.clause.some(x => x.includes('JSON')), `json 站「${c.station}」契约句必须点名 JSON`)
    }
    if (c.format === 'route-text') {
      assert.ok(c.clause.some(x => x.includes('围栏')), `route-text 站「${c.station}」契约句必须禁围栏`)
    }
    assert.equal(
      c.structuredEligible, c.format === 'json',
      `「${c.station}」结构化资格必须 phase 1 对齐现状：只有已在 JSON 通道上的站有资格（yaml 站群默认不迁）`,
    )
    assert.ok(c.repair.rounds >= 0 && c.repair.feedback.trim(), `「${c.station}」修复策略登记不完整`)
  }
}

test('文本锚门：14 模板站 + 判卷族 + 交互件/独立解题面与注册表全量对账（漂移即红）', () => {
  runContractGate(OUTPUT_CONTRACTS, OUT_OF_SCOPE_STATIONS, Content.PROMPT_KINDS, new Set(Object.values(STATIONS)))
})

test('自检：改坏契约句（模拟模板漂移）门必须变红', () => {
  const kinds = { ...Content.PROMPT_KINDS }
  kinds['课程大纲'] = kinds['课程大纲']!.replace('不要代码围栏、不要任何解释', '可以使用代码围栏')
  assert.throws(() => runContractGate(OUTPUT_CONTRACTS, OUT_OF_SCOPE_STATIONS, kinds, new Set(Object.values(STATIONS))), /契约句漂移/)
})

test('自检：往 yaml 模板塞机器块指令（§8 契约矛盾事故类）门必须变红', () => {
  const kinds = { ...Content.PROMPT_KINDS }
  kinds['课程大纲'] = kinds['课程大纲']! + '\n交稿时附 <!-- enc_candidates: [] -->'
  assert.throws(() => runContractGate(OUTPUT_CONTRACTS, OUT_OF_SCOPE_STATIONS, kinds, new Set(Object.values(STATIONS))), /enc_candidates/)
})

test('自检：注册表声明句被改坏（改注册表不改模板）门必须变红', () => {
  const broken: OutputContract[] = OUTPUT_CONTRACTS.map(c =>
    c.station === '课程节拆分' ? { ...c, clause: ['只输出一个 JSON 文档'] } : c)
  assert.throws(() => runContractGate(broken, OUT_OF_SCOPE_STATIONS, Content.PROMPT_KINDS, new Set(Object.values(STATIONS))), /契约句漂移/)
})

test('自检：模板键漏登/站名幽灵，覆盖完备性必须变红', () => {
  const kinds = { ...Content.PROMPT_KINDS }
  delete kinds['种子提案']
  assert.throws(() => runContractGate(OUTPUT_CONTRACTS, OUT_OF_SCOPE_STATIONS, kinds, new Set(Object.values(STATIONS))), /一一对应/)
  assert.throws(
    () => runContractGate(OUTPUT_CONTRACTS, [{ station: '不存在的站', reason: 'x' }], Content.PROMPT_KINDS, new Set(Object.values(STATIONS))),
    /幽灵站名/,
  )
})

test('自检：结构化资格与 JSON 口子的不变式被破坏必须变红', () => {
  const broken: OutputContract[] = OUTPUT_CONTRACTS.map(c =>
    c.station === '罗盘' ? { ...c, structuredEligible: true } : c)
  assert.throws(() => runContractGate(broken, OUT_OF_SCOPE_STATIONS, Content.PROMPT_KINDS, new Set(Object.values(STATIONS))), /结构化资格/)
})

// ---- phase 1 校验器：格式级 shape 正反夹具（对齐现状语义，不改行为） ----

test('校验器：yaml-top 各站——顶层形状缺失/类型不符即红，合法产物过', () => {
  const outline = contractOf('课程大纲')!
  assert.equal(validateByContract(outline, { sections: [{ id: 's1' }] }).ok, true)
  assert.equal(validateByContract(outline, {}).ok, false)
  assert.equal(validateByContract(outline, 'sections: []').ok, false)
  assert.equal(validateByContract(outline, { sections: 's1' }).ok, false)

  const quiz = contractOf('题目生成')!
  assert.equal(validateByContract(quiz, { node: '乙', questions: [{}] }).ok, true)
  assert.equal(validateByContract(quiz, { node: '乙' }).ok, false)

  const growth = contractOf('教练生长')!
  assert.equal(validateByContract(growth, { note: { operator: '前进' }, route: '|', ops: [] }).ok, true)
  assert.equal(validateByContract(growth, { note: {}, ops: [] }).ok, false, 'route 缺失即红')

  const decompile = contractOf('目标反编译')!
  assert.equal(validateByContract(decompile, { project: 'p', plan: [] }).ok, true, 'seed 半区可省略（显式目标课程）')
  assert.equal(validateByContract(decompile, { plan: [] }).ok, false)
})

test('校验器：json-top 判卷族——score/verdict/reasoning 形状对齐解析器现状', () => {
  const receipt = contractOf('回执评审')!
  assert.equal(validateByContract(receipt, { score: 0.5, verdict: '总评', errors: [] }).ok, true)
  assert.equal(validateByContract(receipt, { score: '高', verdict: '总评' }).ok, false)
  assert.equal(validateByContract(receipt, { verdict: '总评' }).ok, false)

  const judge = contractOf('判卷')!
  assert.equal(validateByContract(judge, { score: 0.75, feedback: 'md' }).ok, true)
  assert.equal(validateByContract(judge, { score: 0.75 }).ok, false)

  const dispute = contractOf('申诉判卷')!
  assert.equal(validateByContract(dispute, { verdict: 'ok', reasoning: 'r' }).ok, true)
  assert.equal(validateByContract(dispute, { verdict: 'ok' }).ok, false)
})

test('校验器：markdown/route 形态——节正文标题、四块任务卡、路线正文', () => {
  const section = contractOf('课程节生成')!
  assert.equal(validateByContract(section, '## 概念：分界\n\n正文').ok, true)
  assert.equal(validateByContract(section, '直接开始正文').ok, false)
  assert.equal(validateByContract(section, '---\nfrontmatter: 1\n---\n\n## 概念：x').ok, false)

  const milestone = contractOf('里程碑草案')!
  const four = '## 给定\nx\n\n## 待办\nx\n\n## 验收清单\n- [ ] x\n\n## 支持\nx'
  assert.equal(validateByContract(milestone, four).ok, true)
  assert.equal(validateByContract(milestone, four.replace('## 支持', '## 注意')).ok, false)

  const compass = contractOf('罗盘')!
  assert.equal(validateByContract(compass, '- **阶段名**：一句话').ok, true)
  assert.equal(validateByContract(compass, '## 剩余路线\n- **阶段**：x').ok, false)
  assert.equal(validateByContract(compass, '```yaml\nx\n```').ok, false)
})

test('校验器：交互件面 shape=any 直接过（深结构门归 extractInteractive/checkInteractiveHtml）', () => {
  const interactive = contractOf('课程节生成', '交互件')!
  assert.ok(interactive, '交互件面必须在册')
  assert.equal(validateByContract(interactive, 'anything').ok, true)
})

test('上下文包裁剪现状对账：大纲/拆节站取裁剪包（omitDeliverables）——注册表登记的机器块禁令有真实来源', async () => {
  // 契约矛盾事故的防复发锚（#212 §二）：大纲站消费的包必须无 §8 交付要求。
  // 这里直接对门面 contentPack 产物断言（行为现状，phase 1 只锁不改编）。
  const { withVault } = await import('./helpers/vault.ts')
  await withVault({}, async ({ engine }) => {
    const c = await engine.registry.resolve('数学')
    const { graph } = await engine.loadView(c)
    const node = graph.names[0]!
    const trimmed = await engine.content2.contentPack(c.name, node, { omitDeliverables: true })
    const full = await engine.content2.contentPack(c.name, node)
    assert.doesNotMatch(trimmed, /## 8\. 交付要求/)
    assert.match(full, /## 8\. 交付要求/)
    assert.doesNotMatch(trimmed, /enc_candidates/)
    assert.match(full, /enc_candidates/)
  })
})

test('CONTEXT.md「输出契约」词条承诺的敏感度词表在册（机械评审/规划/推理创意）', () => {
  const context = readFileSync(new URL('../CONTEXT.md', import.meta.url), 'utf8')
  assert.match(context, /格式敏感度标注（机械评审\/规划\/推理创意）/)
  const sensitivities = new Set(OUTPUT_CONTRACTS.map(c => c.sensitivity))
  for (const s of ['机械评审', '规划', '推理创意']) {
    assert.ok(sensitivities.has(s as never), `敏感度「${s}」应在注册表中有真实使用者`)
  }
})

// ---- #218 稀释治理：§5 截断如实告知（位置保留的理由见 ADR-0065 §4） ----

/** 造一个「目标 + n 个更深节点」的图（更深 = 进 §5 禁止概念）。 */
function graphWithDeeper(n: number): string {
  const nodes = ['      - { name: 目标, pre: [], opt: false, note: "", est: 10 }']
  for (let i = 0; i < n; i++) nodes.push(`      - { name: N${i}, pre: [目标], opt: false, note: "", est: 10 }`)
  return ['region: 基础', 'color: blue', 'blocks:', '  - name: 入门块', '    nodes:', ...nodes].join('\n')
}

/** 取上下文包 §5 段的非空行（标题行被正则吃掉：行 0 = 名字清单，行 1 = 可选的截断告知）。 */
function section5Lines(pack: string): string[] {
  const sec = /## 5\. 禁止使用的概念[^\n]*\n([\s\S]*?)(?=\n## 6\.)/.exec(pack)
  assert.ok(sec, '上下文包必须有 §5 段')
  return sec![1]!.split('\n').map(l => l.trim()).filter(Boolean)
}

test('#218 稀释治理：§5 超过上限时截断如实告知（旧版静默截断，模型会读成穷举）', async () => {
  const { withVault } = await import('./helpers/vault.ts')
  await withVault({ graph: graphWithDeeper(260) }, async ({ engine }) => {
    const c = await engine.registry.resolve('数学')
    const pack = await engine.content2.contentPack(c.name, '目标')
    assert.match(pack, /## 5\. 禁止使用的概念/, '§5 位置保留（挪走要重编号 §6–§13，而模板按号引用）')
    const lines = section5Lines(pack)
    assert.equal(lines[0]!.split('、').length, 200, '上限仍是实测的 200 条（FORBIDDEN_CONCEPT_CAP）')
    assert.match(
      lines[1] ?? '',
      /本清单按图深度降序截取前 200 条，共 260 条未学节点；\*\*未列出的节点同样未学\*\*/,
      '截断必须如实告知，否则模型把清单读成穷举',
    )
  })
})

test('#218 回归：§5 必须真的列出未学节点（旧实现 `Object.keys(Set)` 恒空 → §5 恒「（无）」）', async () => {
  const { withVault } = await import('./helpers/vault.ts')
  await withVault({ graph: graphWithDeeper(3) }, async ({ engine }) => {
    const c = await engine.registry.resolve('数学')
    const pack = await engine.content2.contentPack(c.name, '目标')
    const lines = section5Lines(pack)
    assert.doesNotMatch(lines.join('\n'), /（无：本节点已是图内最深）/, '§5 恒空是那条 bug 的签名')
    for (const n of ['N0', 'N1', 'N2']) assert.ok(lines[0]!.includes(n), `更深节点「${n}」应在 §5 里`)
    assert.doesNotMatch(lines.join('\n'), /截取前 \d+ 条/, '没到上限就不该声称截断')
  })
})

// ---- #218 契约后置：契约句必须在最终 prompt 的末段（模板形状门 + 拼装缝门 + 变更登记门）----

/** 模板里位于契约段起始标题之后的全部 `## ` 一级标题（不含起始那一节本身）。 */
function headingsAfterContract(tpl: string): string[] {
  const hits = [...tpl.matchAll(/^## 输出[^\n]*$/gm)]
  const start = hits[hits.length - 1]?.index
  if (start === undefined) return []
  return [...tpl.slice(start).matchAll(/^## [^\n]*$/gm)].slice(1).map(m => m[0].slice(3).trim())
}

/** 契约段形状门本体（可注入 = 自检可改坏样本）。四条不变式：
 * ① 每个模板键都有一段以最后一个 `## 输出…` 标题起的契约段——拼装缝据此切分；
 * ② 该站的契约句落在**契约段里**（不是「模板里任何地方出现过」——那是旧判据，恰好漏掉
 *    「schema 被挪回中段」这个本次要治的形态）；
 * ③ 契约段里除注册表声明的输出结构块（markdown-blocks 四块）外**不得再有别的 `## ` 一节**
 *    ——这条正是「材料拖在契约之后」的机器判据；
 * ④ 契约后置拼装的产物以契约段收尾，且材料在它之前。 */
function runContractLastGate(
  kinds: Record<string, string>,
  entries: readonly OutputContract[],
): void {
  const covered = new Set<string>()
  for (const c of entries) for (const t of c.templates ?? []) covered.add(t)
  for (const c of entries) {
    if (c.contractLocation === 'system') continue // 回执评审：契约住 system 提示词（全仓先例）
    // 输出结构块（四块任务卡）是契约段的合法内容——它描述的是**产出**的一级节，不是模板
    // 的节，故不与「材料不得拖在契约后」冲突；允许集来自注册表 shape，不硬编码。
    const structBlocks = new Set(c.shape.kind === 'markdown-blocks' ? c.shape.blocks : [])
    for (const t of c.templates ?? []) {
      const tpl = kinds[t]
      assert.ok(tpl !== undefined, `契约「${c.station}」的模板键「${t}」不在 PROMPT_KINDS`)
      covered.add(t)
      const { contract } = splitContractSection(tpl)
      assert.ok(contract, `模板「${t}」没有可后置的契约段（末节须由 \`## 输出…\` 起，#218）`)
      for (const clause of c.clause) {
        assert.ok(
          contract.includes(clause),
          `「${c.station}」契约句不在末段（模板「${t}」）：须落在最后一个 \`## 输出…\` 节里——`
          + '「模板里出现过」不是判据，「在最终 prompt 的末段」才是（#218）',
        )
      }
      for (const h of headingsAfterContract(tpl)) {
        assert.ok(
          structBlocks.has(h),
          `模板「${t}」在契约段之后还有一节「## ${h}」——契约段必须是最后一节（#218）`,
        )
      }
      const composed = withContractLast(tpl, 'PROBE-MATERIALS-占位材料')
      assert.ok(composed.trimEnd().endsWith(contract), `模板「${t}」拼装后未以契约段收尾（#218）`)
      assert.ok(
        composed.indexOf('PROBE-MATERIALS-占位材料') < composed.indexOf(contract),
        `模板「${t}」的材料未被插到契约段之前（#218）`,
      )
    }
  }
  // 契约段形状门的覆盖面 = PROMPT_KINDS 全集（新模板既不在册也不被声明的形态直接红）
  assert.deepEqual(
    [...covered].sort(), Object.keys(kinds).sort(),
    '契约段形状门的覆盖面与 PROMPT_KINDS 全集不一致（新模板未接入 / 幽灵键）',
  )
}

test('#218 契约后置：15 模板键各有契约段，各站契约句落在末段（漂移即红）', () => {
  runContractLastGate(Content.PROMPT_KINDS, OUTPUT_CONTRACTS)
})

test('自检：契约段之后又加一节（或契约挪回中段）门必须变红', () => {
  const kinds = { ...Content.PROMPT_KINDS }
  kinds['错误对比卡'] = `${kinds['错误对比卡']!.trimEnd()}\n\n## 附注\n\n（本节加在契约段之后）\n`
  assert.throws(() => runContractLastGate(kinds, OUTPUT_CONTRACTS), /契约段之后还有一节|契约句不在末段/)
  const renamed = { ...Content.PROMPT_KINDS }
  renamed['错误对比卡'] = renamed['错误对比卡']!.replace(/^## 输出$/m, '## 产物说明')
  assert.throws(() => runContractLastGate(renamed, OUTPUT_CONTRACTS), /没有可后置的契约段|契约段之后还有一节/)
})

// ---- 拼装缝门：src/ 里不得残留「模板变量直接拼进 prompt」的旧形态 ----

/** 旧形态的签名：字符串字面量里插值一个**提示词模板变量**（名字含 tpl/template——
 * 收集全部插值再按名字筛，不用写死变量名清单：新站的模板变量叫 `quizTpl`/`contentTpl`
 * 也一样被看见）。属性访问（`${tpl.title}`——取值不是拼模板）不算。收集面 = src/ 全量 .ts。 */
const TEMPLATE_VAR = /tpl|template/i

function rawTemplateInterpolations(sources: Record<string, string>): string[] {
  const out: string[] = []
  for (const [file, text] of Object.entries(sources)) {
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/`\$\{([A-Za-z_$][\w$]*)(?![.\w])/g)) {
        if (TEMPLATE_VAR.test(m[1]!)) out.push(`${file}:${i + 1}: ${m[0]}`)
      }
    })
  }
  return out
}

test('#218 拼装缝：src/ 零「模板变量直接拼进 prompt」（一律经 Content.withContractLast）', () => {
  const sources: Record<string, string> = {}
  const walk = (dir: URL): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dir)
      if (e.isDirectory()) walk(child)
      else if (e.name.endsWith('.ts')) sources[child.pathname] = readFileSync(child, 'utf8')
    }
  }
  walk(new URL('../src/', import.meta.url))
  assert.ok(Object.keys(sources).length > 50, `收集面太小（${Object.keys(sources).length} 个文件）——门会恒过`)
  assert.deepEqual(rawTemplateInterpolations(sources), [])
})

test('自检：直接插值模板变量的旧形态会被抓；换名的新站变量也被抓（门不是恒过）', () => {
  assert.equal(rawTemplateInterpolations({ 'x.ts': 'const p = `${tpl}\\n\\n---\\n\\n${pack}`\n' }).length, 1)
  assert.equal(rawTemplateInterpolations({ 'z.ts': 'const p = `${quizTpl}${body}`\n' }).length, 1, '新站换个变量名同样被抓')
  assert.deepEqual(rawTemplateInterpolations({ 'y.ts': 'const s = `${tpl.title} 提案`\n' }), [])
})

// ---- 变更登记门（#220 字段格式手工落位，#218 的版本 bump 首次登记）----

/** 登记门本体：覆盖完备（键 = PROMPT_KINDS 全集）+ 字段齐备 + 无幽灵键 + 最高登记版本
 * 与模板头版本标记一致（bump 了模板却没补条目 = 红）。 */
function runChangelogGate(
  kinds: Record<string, string>,
  changelog: Readonly<Record<string, readonly PromptBump[]>>,
  versionOf: (text: string) => number,
): void {
  assert.deepEqual(
    Object.keys(changelog).sort(), Object.keys(kinds).sort(),
    '变更登记表键与 PROMPT_KINDS 全集必须一一对应（新模板未登记 / 幽灵键）',
  )
  for (const [kind, entries] of Object.entries(changelog)) {
    assert.ok(entries.length > 0, `「${kind}」的登记条目为空`)
    // 同一版本号可有多条（模板未动但最终 prompt 变了：拼装线索、上下文包变更），
    // 但版本号不得倒序——倒序说明表被写乱了，读的人无法判断哪条是最新一次。
    const versions = entries.map(e => e.version)
    assert.deepEqual(versions, [...versions].sort((a, b) => a - b), `「${kind}」登记版本倒序（表写乱了）`)
    for (const e of entries) {
      assert.ok(
        e.date.trim() && e.changeType.trim() && e.expectedDelta.trim(),
        `「${kind}」v${e.version} 登记字段不齐（date/changeType/expectedDelta）`,
      )
      assert.ok(e.version <= versionOf(kinds[kind]!), `「${kind}」登记版本 v${e.version} 超过模板现行版本`)
    }
    assert.equal(
      Math.max(...versions), versionOf(kinds[kind]!),
      `「${kind}」最高登记版本与模板现行版本不一致——bump 模板必须同提交补登记条目（#220/#218）`,
    )
  }
}

test('#218/#220 变更登记：键覆盖 PROMPT_KINDS 全集，最高登记版本 == 模板现行版本', () => {
  runChangelogGate(Content.PROMPT_KINDS, PROMPT_CHANGELOG, Content.promptVersionOf)
})

test('自检：bump 模板不补条目 / 登记超版本 / 幽灵键 / 缺键，门都必须变红', () => {
  assert.throws(
    () => runChangelogGate(Content.PROMPT_KINDS, PROMPT_CHANGELOG, () => 999),
    /最高登记版本与模板现行版本不一致|超过模板现行版本/,
  )
  const ghosts = {
    ...PROMPT_CHANGELOG,
    幽灵模板: [{ version: 1, date: 'x', changeType: 'y', expectedDelta: 'z' }],
  }
  assert.throws(() => runChangelogGate(Content.PROMPT_KINDS, ghosts, Content.promptVersionOf), /一一对应/)
  const short: Record<string, readonly PromptBump[]> = { ...PROMPT_CHANGELOG }
  delete short['罗盘初画']
  assert.throws(() => runChangelogGate(Content.PROMPT_KINDS, short, Content.promptVersionOf), /一一对应/)
})
