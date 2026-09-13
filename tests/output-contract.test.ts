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
import { readFileSync } from 'node:fs'
import { Content } from '../src/engine/content.ts'
import {
  OUTPUT_CONTRACTS, OUT_OF_SCOPE_STATIONS, contractOf, validateByContract,
} from '../src/engine/output-contracts.ts'
import type { OutputContract } from '../src/engine/output-contracts.ts'
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
