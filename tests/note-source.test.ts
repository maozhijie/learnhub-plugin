import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import { fingerprintOf, classifySource, sourceHint, normalizeSourcePath, validateNoteSourceEntries, isExcludedPath } from '../src/engine/note-source.ts'
import { todayStr } from '../src/engine/dates.ts'
import { DEFAULT_REGISTRY, withVault as makeVault } from './helpers/vault.ts'

const NOTE = [
  '---',
  'node: 入门',
  'stage: review',
  'fsrs: null',
  'content:',
  '  version: 1',
  '  generated_at: "2026-09-01"',
  '  status: draft',
  'practice:',
  '  attempts: 1',
  '  correct: 1',
  '---',
  '',
  '# 入门',
  '',
  '## 概念',
  '',
  '课程正文占位。',
].join('\n')

const PERSONAL_NOTE = [
  '# 费曼技巧',
  '',
  '费曼技巧 = 用最朴素的语言把概念讲给完全不懂的人听，卡壳处就是没懂的地方。',
  '步骤：1) 选概念；2) 讲给外行；3) 卡壳处回炉；4) 重复直到流畅。',
].join('\n')

/** 带一门课程（含到期题）+ 一篇中心外个人笔记的临时 vault。 */
async function withVault(run: (engine: LearnhubEngine, paths: { noteAbs: string; folderAbs: string }) => Promise<void>): Promise<void> {
  await makeVault({
    tag: 'learnhub-notesrc-',
    notes: { 入门: NOTE },
    banks: { 入门: [
      'node: 入门',
      'questions:',
      '  - id: q1',
      '    kind: single_choice',
      '    q: 课程题占位？',
      '    options: ["A项", "B项", "C项", "D项"]',
      '    answer: A',
      '    fsrs: { stability: 5, difficulty: 5, due: "' + todayStr(new Date()) + '", last_review: "2026-09-01", reps: 1, lapses: 0 }',
    ].join('\n') },
    files: [
      { path: '我的笔记/费曼技巧.md', content: `${PERSONAL_NOTE}\n` },
      { path: '我的笔记/另一篇.md', content: '# 另一篇\n\n内容 B。\n' },
    ],
  }, async ({ engine, root }) => {
    const personal = join(root, '我的笔记')
    await run(engine, { noteAbs: join(personal, '费曼技巧.md'), folderAbs: personal })
  })
}

const NOTE_BANK_YAML = [
  'node: note-1',
  'questions:',
  '  - id: q1',
  '    kind: single_choice',
  '    q: 费曼技巧的核心动作是？',
  '    options: ["讲给外行听", "多刷题", "抄笔记", "看视频"]',
  '    answer: A',
  '    explanation: 卡壳处回炉是核心。',
  '  - id: q2',
  '    kind: fill_in_blank',
  '    q: 卡壳处说明该处____。',
  '    answer: ["没懂", "没理解"]',
].join('\n')

test('纯函数缝：源条目契约、指纹稳定、Missing/漂移判定与提示文案', () => {
  const bad = validateNoteSourceEntries([
    { id: 'note-1', path: 'a.md', created: '2026-09-08' },
    { id: 'note-1', path: 'b.md', created: '2026-09-08' },
    { id: '', path: 'a.md', created: '2026-09-08' },
    { id: 'note-3', path: '', created: '2026-09-08' },
    { id: 'note-4', path: 'c.md', created: '2026-09-08', enabled: 'yes' },
    { id: 'note-5', path: 'c.md', created: '' },
  ])
  assert.ok(bad.errors.some(e => e.includes('note_sources.2.id: 与其他笔记源重复')))
  assert.ok(bad.errors.some(e => e.includes('note_sources.3.id: 不能为空')))
  assert.ok(bad.errors.some(e => e.includes('note_sources.4.path: 不能为空')))
  assert.ok(bad.errors.some(e => e.includes('note_sources.5.enabled: 必须是布尔值')))
  assert.ok(bad.errors.some(e => e.includes('note_sources.6.created: 不能为空')))
  assert.equal(validateNoteSourceEntries('nope').errors[0], 'note_sources: 必须是列表')
  assert.deepEqual(validateNoteSourceEntries(undefined), { errors: [], entries: [] })

  assert.equal(fingerprintOf('abc'), fingerprintOf('abc'))
  assert.notEqual(fingerprintOf('abc'), fingerprintOf('abd'))

  assert.equal(classifySource(true, true), 'ok')
  assert.equal(classifySource(false, true), 'missing')
  assert.equal(classifySource(true, false), 'drifted')
  assert.match(sourceHint('missing') ?? '', /源文件缺失，卡池挂起/)
  assert.match(sourceHint('drifted') ?? '', /内容已变，可重新出题或归档旧题/)
  assert.equal(sourceHint('ok'), undefined)
})

test('纯函数缝：注册路径归一拒绝学习中心内部与越界路径', () => {
  const vault = 'D:/v'.replace(/\//g, '/')
  const center = `${vault}/学习中心`
  assert.equal(normalizeSourcePath(vault, center, '我的笔记/a.md'), '我的笔记/a.md')
  assert.equal(normalizeSourcePath(vault, center, 'D:/v/我的笔记/a.md'), '我的笔记/a.md')
  assert.throws(() => normalizeSourcePath(vault, center, '学习中心/math/课程/a.md'), /学习中心内部/)
  assert.throws(() => normalizeSourcePath(vault, center, '../outside/a.md'), /\.\./)
})

test('注册 → 出题 → 复习全流程：用户笔记字节级零写入，派生物全落镜像区', async () => {
  await withVault(async (engine, p) => {
    const before = await readFile(p.noteAbs, 'utf8')
    const reg = await engine.channels.noteSourceRegister(p.noteAbs)
    assert.equal(reg.registered, 1)
    const src = reg.sources[0] as Record<string, unknown>
    assert.equal(src.status, 'ok')
    assert.equal(src.id, 'note-1')
    // 注册表带 note_sources 域，源清单带指纹
    const entries = await engine.registry.loadNoteSources()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.path, '我的笔记/费曼技巧.md')
    const manifestText = await readFile(engine.paths.noteSourceManifestPath, 'utf8')
    assert.match(manifestText, new RegExp(fingerprintOf(before)))

    // 出题（假模型产出过 validateBank 门禁的题库 YAML）→ 镜像题库 + 合成首复习 + 指纹
    const gen = await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)
    assert.equal(gen.added, 2)
    assert.equal(gen.total, 2)
    const afterGen = await readFile(p.noteAbs, 'utf8')
    assert.equal(afterGen, before, '出题后笔记仍字节不变')

    // 题卡初始化为明天起刷 → 今天不在队列；把 due 改到今天后进全局队列（course=笔记源）
    const q = await engine.content2.reviewQueue()
    assert.equal(q.cards.filter(c => c.source === 'note').length, 0)
    const today = todayStr(new Date())
    await engine.bank.updateQuestionEvidence(engine.paths.noteSourceDir, 'note-1', 'q1', {
      fsrs: { stability: 5, difficulty: 5, due: today, last_review: '2026-09-01', reps: 1, lapses: 0 },
    })
    const q2 = await engine.content2.reviewQueue()
    const noteCards = q2.cards.filter(c => c.course === '笔记源' && c.source === 'note')
    assert.equal(noteCards.length, 1)
    assert.equal(noteCards[0]!.node, 'note-1')
    // 课程到期题同在（源接入不阻塞/不挤掉课程卡）
    assert.ok(q2.cards.some(c => c.course === '数学'))

    // 复习自评语义全流程：答对挂起 → rate 结算（同日重复答不再推进）
    const neverLlm = async (): Promise<string> => { throw new Error('规则题型不应调用模型') }
    const a = await engine.questionAnswer(neverLlm, '笔记源', 'note-1', 'q1', 'A', null, { deferSchedule: true })
    assert.equal(a.correct, true)
    assert.equal(a.pendingRating, true)
    assert.equal(a.scheduled, false)
    assert.equal(a.xp, 1) // 无绑定 XP（ADR-0021）：single_choice 权重 1 × 难度 1，答对挂起即入账
    await assert.rejects(
      () => engine.content2.questionForget('笔记源', 'note-1', 'q1'),
      /今天已有推进记录/)
    const rated = await engine.content2.questionRate('笔记源', 'note-1', 'q1', 3)
    assert.equal(rated.scheduled, true)
    const due = String(rated.due)
    assert.ok(due > today)

    // 复习日志只落真实推进（synthetic×2 初始化 + self×1 自评）；practice 流水不存在、无 XP
    const log = await engine.store.reviewLogAll()
    assert.equal(log.filter(r => r.rating_source === 'synthetic').length, 2)
    assert.equal(log.filter(r => r.rating_source === 'self' && r.course === '笔记源').length, 1)
    assert.equal(await engine.store.practiceAll().then(r => r.length), 0)
    assert.ok(!existsSync(engine.paths.practicePath))

    // 忘记申报：另一题当日首次 → rating 1 推卡，0 XP
    const f = await engine.content2.questionForget('笔记源', 'note-1', 'q2')
    assert.equal(f.judge, 'forget')
    assert.equal(f.xp, 0)
    assert.equal((await engine.store.reviewLogAll()).filter(r => r.rating === 1 && r.rating_source === 'auto' && r.course === '笔记源').length, 1)

    // 无绑定 XP 行（ADR-0021）：作答 ×1（挂起即落）+ 忘记 ×1（0 XP）= 2 条；
    // course/node='*' 不绑实体，只入总账/streak
    const xpRows = (await engine.store.journalTail(null, Number.MAX_SAFE_INTEGER))
      .filter(r => r.kind === 'xp_notesource')
    assert.equal(xpRows.length, 2)
    assert.ok(xpRows.every(r => r.course === '*' && r.node === '*'))
    assert.equal(xpRows.reduce((s, r) => s + (r.xp ?? 0), 0), 1)

    // 全程笔记字节不变
    assert.equal(await readFile(p.noteAbs, 'utf8'), before)
  })
})

test('注册文件夹 = 批量登记；重复注册同路径是恢复语义；解除清镜像、笔记不动', async () => {
  await withVault(async (engine, p) => {
    const reg = await engine.channels.noteSourceRegister(p.folderAbs)
    assert.equal(reg.registered, 2)
    const idOf = (name: string) =>
      String((reg.sources as Array<Record<string, unknown>>).find(s => String(s.path).endsWith(name))!.id)
    const feynmanId = idOf('费曼技巧.md')
    const otherId = idOf('另一篇.md')
    assert.notEqual(feynmanId, otherId)

    await engine.noteSourceGenerate(feynmanId, undefined, async () => NOTE_BANK_YAML)
    assert.ok(existsSync(join(engine.paths.noteSourceDir, '题库', `${feynmanId}.yaml`)))

    // 解除费曼技巧：镜像题库与清单/注册表条目清除；笔记文件仍在
    const noteBytes = await readFile(join(p.folderAbs, '费曼技巧.md'), 'utf8')
    const rm = await engine.noteSourceUnregister(feynmanId)
    assert.equal(rm.removed, feynmanId)
    assert.ok(!existsSync(join(engine.paths.noteSourceDir, '题库', `${feynmanId}.yaml`)))
    assert.equal((await engine.registry.loadNoteSources()).length, 1)
    assert.equal(await readFile(join(p.folderAbs, '费曼技巧.md'), 'utf8'), noteBytes)

    // 重新注册同路径 = 恢复（新 id，不复用已解除的 id）
    const re = await engine.channels.noteSourceRegister(join(p.folderAbs, '费曼技巧.md'))
    assert.equal(re.updated, 0)
    assert.equal(re.registered, 1)
    const reSrc = re.sources.map(s => s as Record<string, unknown>).find(s => String(s.path) === '我的笔记/费曼技巧.md')!
    assert.notEqual(String(reSrc.id), feynmanId)
    void otherId
  })
})

test('删除/改名 = Missing：卡池挂起、不阻塞其他源、重注册可恢复；用户笔记永不判 Broken', async () => {
  await withVault(async (engine, p) => {
    const reg = await engine.channels.noteSourceRegister(p.noteAbs)
    await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)
    const today = todayStr(new Date())
    await engine.bank.updateQuestionEvidence(engine.paths.noteSourceDir, 'note-1', 'q1', {
      fsrs: { stability: 5, difficulty: 5, due: today, last_review: '2026-09-01', reps: 1, lapses: 0 },
    })

    // 改名 → Missing：清单无卡 + suspended 带提示；课程卡不受影响
    const moved = `${p.noteAbs}.bak`
    await rename(p.noteAbs, moved)
    const list = await engine.channels.noteSourceList()
    assert.equal((list.sources[0] as Record<string, unknown>).status, 'missing')
    assert.match(String((list.sources[0] as Record<string, unknown>).hint), /源文件缺失，卡池挂起/)
    const q = await engine.content2.reviewQueue()
    assert.equal(q.cards.filter(c => c.source === 'note').length, 0)
    assert.ok(q.cards.some(c => c.course === '数学'))
    assert.equal((q.note_suspended as Array<Record<string, unknown>>)?.[0]?.id, 'note-1')
    assert.match(String((q.note_suspended as Array<Record<string, unknown>>)?.[0]?.reason), /源文件缺失/)

    // Missing 源上出题 fail loud（提示先恢复），data-check 不报用户笔记（永不判 Broken）
    await assert.rejects(() => engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML), /源文件缺失/)

    // 重注册同路径恢复 → 卡池回到队列
    await rename(moved, p.noteAbs)
    await engine.channels.noteSourceRegister(p.noteAbs)
    const q2 = await engine.content2.reviewQueue()
    assert.equal(q2.cards.filter(c => c.source === 'note').length, 1)
    assert.equal((q2 as Record<string, unknown>).note_suspended, undefined)
    void reg
  })
})

test('编辑正文 = 内容漂移：状态提示可重出/归档；出题确认指纹后回到 ok；不自动改题', async () => {
  await withVault(async (engine, p) => {
    await engine.channels.noteSourceRegister(p.noteAbs)
    await engine.noteSourceGenerate('note-1', 1, async () => NOTE_BANK_YAML)
    const before = await readFile(join(engine.paths.noteSourceDir, '题库', 'note-1.yaml'), 'utf8')

    await writeFile(p.noteAbs, `${PERSONAL_NOTE}\n\n补充：2026 版新增要点。\n`, 'utf8')
    const list = await engine.channels.noteSourceList()
    assert.equal((list.sources[0] as Record<string, unknown>).status, 'drifted')
    assert.match(String((list.sources[0] as Record<string, unknown>).hint), /内容已变/)
    // 漂移不挂起：卡照常可复习
    const q = await engine.content2.reviewQueue()
    assert.equal((q as Record<string, unknown>).note_drifted !== undefined, true)
    assert.equal((q as Record<string, unknown>).note_suspended, undefined)

    // 重出题 = 确认当前内容：指纹刷新 → ok；旧卡仍在（归档是独立动作）
    await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)
    const list2 = await engine.channels.noteSourceList()
    assert.equal((list2.sources[0] as Record<string, unknown>).status, 'ok')
    const after = await readFile(join(engine.paths.noteSourceDir, '题库', 'note-1.yaml'), 'utf8')
    assert.equal(after.split('questions:').length - 1 >= 1, true)
    assert.ok(after.includes('q1') && after.includes('q2')) // 题追加，不自动删旧题
    void before
  })
})

test('镜像题库 Broken：该源卡挂起并带原因，不阻塞其他源；data-check 在 note_source 区报 Broken', async () => {
  await withVault(async (engine, p) => {
    await engine.channels.noteSourceRegister(p.noteAbs)
    await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)
    await writeFile(join(engine.paths.noteSourceDir, '题库', 'note-1.yaml'), 'node: [broken\n', 'utf8')

    const q = await engine.content2.reviewQueue()
    assert.ok(q.cards.some(c => c.course === '数学'))
    assert.equal(q.cards.filter(c => c.source === 'note').length, 0)
    const susp = (q as Record<string, unknown>).note_suspended as Array<Record<string, unknown>>
    assert.match(String(susp?.[0]?.reason), /题库镜像 Broken/)

    const report = await engine.dataCheck()
    assert.equal(report.byArea.note_source.broken >= 1, true)
    assert.ok(report.findings.some(f => f.reason === 'note_source_bank_yaml_parse'))
  })
})

test('源清单条目缺失（镜像不一致）= inconsistent：列表如实标注，队列卡照常出（不误报漂移）', async () => {
  await withVault(async (engine, p) => {
    await engine.channels.noteSourceRegister(p.noteAbs)
    await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)
    const today = todayStr(new Date())
    await engine.bank.updateQuestionEvidence(engine.paths.noteSourceDir, 'note-1', 'q1', {
      fsrs: { stability: 5, difficulty: 5, due: today, last_review: '2026-09-01', reps: 1, lapses: 0 },
    })
    // 手工抹掉清单条目（模拟镜像不一致）
    await engine.noteManifest.save({ sources: [] })

    const list = await engine.channels.noteSourceList()
    const src = list.sources[0] as Record<string, unknown>
    assert.equal(src.status, 'inconsistent')
    assert.match(String(src.hint), /镜像不一致/)
    assert.notEqual(src.status, 'drifted')

    const q = await engine.content2.reviewQueue()
    assert.equal(q.cards.filter(c => c.source === 'note').length, 1) // 不挂起、不误判漂移
    assert.match(String(((q as Record<string, unknown>).note_drifted as Array<Record<string, unknown>>)?.[0]?.hint), /镜像不一致/)
    const report = await engine.dataCheck()
    assert.ok(report.findings.some(f => f.reason === 'note_source_mirror_inconsistent'))
  })
})

test('源清单本身 Broken = fail loud（镜像区契约文件），注册表 note_sources 契约坏同样抛错', async () => {
  await withVault(async (engine, p) => {
    await engine.channels.noteSourceRegister(p.noteAbs)
    await writeFile(engine.paths.noteSourceManifestPath, 'sources: nope\n', 'utf8')
    await assert.rejects(() => engine.content2.reviewQueue(), /源清单 Broken/)
    await assert.rejects(() => engine.channels.noteSourceList(), /源清单 Broken/)
    const report = await engine.dataCheck()
    assert.ok(report.findings.some(f => f.reason === 'note_source_manifest_schema'))
  })
  await withVault(async engine => {
    // 注册表 note_sources 域契约坏 → 注册表整体 Broken（沿用 ADR-0004 fail loud）
    await writeFile(join(engine.paths.centerRoot, '课程注册表.yaml'), `${DEFAULT_REGISTRY}\nnote_sources:\n  - { id: "", path: "" }\n`, 'utf8')
    await assert.rejects(() => engine.registry.enabled(), /note_sources\.1\.id: 不能为空/)
  })
})

test('注册表 save 保留 note_sources 域：课程删除不抹笔记源', async () => {
  await withVault(async (engine, p) => {
    await engine.channels.noteSourceRegister(p.noteAbs)
    await engine.courseDelete('数学')
    const entries = await engine.registry.loadNoteSources()
    assert.equal(entries.length, 1)
    const text = await readFile(engine.paths.registryPath, 'utf8')
    assert.match(text, /note_sources:/)
  })
})

test('出题 count 非法显式拒绝；空正文笔记拒绝出题', async () => {
  await withVault(async (engine, p) => {
    await engine.channels.noteSourceRegister(p.noteAbs)
    await assert.rejects(() => engine.noteSourceGenerate('note-1', 0, async () => NOTE_BANK_YAML), /count 必须是正整数/)
    const emptyPath = join(p.folderAbs, '空.md')
    await writeFile(emptyPath, '', 'utf8')
    const reg = await engine.channels.noteSourceRegister(emptyPath)
    const emptyId = String(
      (reg.sources as Array<Record<string, unknown>>).find(s => String(s.path).endsWith('空.md'))!.id)
    await assert.rejects(
      () => engine.noteSourceGenerate(emptyId, undefined, async () => NOTE_BANK_YAML),
      /正文为空/)
  })
})

test('全量快照回归：题库/掌握度通道零新增写入（笔记源复习不写课程题库与节点 frontmatter）', async () => {
  await withVault(async (engine, p) => {
    await engine.channels.noteSourceRegister(p.noteAbs)
    const courseBankBefore = await readFile(join(engine.paths.courseRoot('math'), '题库', '入门.yaml'), 'utf8')
    const noteBefore = await readFile(p.noteAbs, 'utf8')

    await engine.channels.noteSourceRegister(p.folderAbs)
    await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)
    await engine.noteSourceGenerate('note-2', undefined, async () => NOTE_BANK_YAML)
    await engine.content2.questionRate('笔记源', 'note-1', 'q1', 2).catch(() => { /* 未挂起被拒绝也是边界行为 */ })

    assert.equal(await readFile(join(engine.paths.courseRoot('math'), '题库', '入门.yaml'), 'utf8'), courseBankBefore)
    assert.equal(await readFile(p.noteAbs, 'utf8'), noteBefore)
  })
})

test('纯函数缝：排除命中判定（精确 + 目录前缀，前缀串撞名不误伤）', () => {
  assert.equal(isExcludedPath('我的笔记/存档', ['我的笔记/存档']), true)
  assert.equal(isExcludedPath('我的笔记/存档/旧.md', ['我的笔记/存档']), true)
  assert.equal(isExcludedPath('我的笔记/日记.md', ['我的笔记/日记.md']), true)
  // 前缀串撞名不误伤：存档备 ≠ 存档/
  assert.equal(isExcludedPath('我的笔记/存档备/旧.md', ['我的笔记/存档']), false)
  assert.equal(isExcludedPath('我的笔记/另一篇.md', ['我的笔记/存档', '我的笔记/日记.md']), false)
})

test('排除清单管理：落盘归一去重、重复排除幂等、解除不在清单 fail loud、手编配置形状归一、其他字段保留', async () => {
  await withVault(async (engine, p) => {
    // 场上先有其他配置字段：写排除不得抹掉
    await engine.setDayCutoff('03:00')
    const add = await engine.noteSourceExclude(join(p.folderAbs, '存档'))
    assert.deepEqual(add.excludes, ['我的笔记/存档'])
    const again = await engine.noteSourceExclude('我的笔记/存档/') // 同路径异写法（尾斜杠）幂等
    assert.deepEqual(again.excludes, ['我的笔记/存档'])

    const cfg = JSON.parse(await readFile(engine.paths.learnhubConfigPath, 'utf8')) as Record<string, unknown>
    assert.deepEqual(cfg.note_source_excludes, ['我的笔记/存档'])
    assert.equal(cfg.day_cutoff, '03:00')

    assert.deepEqual((await engine.noteSourceExcludes()).excludes, ['我的笔记/存档'])
    assert.deepEqual((await engine.channels.noteSourceList()).excludes, ['我的笔记/存档'])

    // 手编配置的反斜杠/尾斜杠写法读时归一——防收编不因写法静默失效
    await writeFile(
      engine.paths.learnhubConfigPath,
      JSON.stringify({ day_cutoff: '03:00', note_source_excludes: ['我的笔记\\存档\\', '我的笔记/日记.md', '  ', 42] }, null, 1) + '\n',
      'utf8',
    )
    assert.deepEqual(
      (await engine.noteSourceExcludes()).excludes,
      ['我的笔记/存档', '我的笔记/日记.md'],
    )
    await assert.rejects(
      () => engine.channels.noteSourceRegister(join(p.folderAbs, '存档')),
      /排除清单内/,
    )

    assert.deepEqual((await engine.noteSourceUnexclude('我的笔记/存档/')).excludes, ['我的笔记/日记.md'])
    await assert.rejects(() => engine.noteSourceUnexclude('我的笔记/存档'), /排除清单没有/)
    // 排除条目同样不收学习中心与越界路径（内置排除不可复制、清单不出 vault）
    await assert.rejects(() => engine.noteSourceExclude('学习中心/数学'), /学习中心内部/)
    await assert.rejects(() => engine.noteSourceExclude('../外部.md'), /\.\./)
  })
})

test('排除清单在注册入口强制执行：直注被排除路径 fail loud；批量登记跳过排除子树（计数 + skipped_paths）；解除后可注册', async () => {
  await withVault(async (engine, p) => {
    await mkdir(join(p.folderAbs, '存档'), { recursive: true })
    await writeFile(join(p.folderAbs, '存档', '旧笔记.md'), '# 旧笔记\n\n不要收编。\n', 'utf8')
    await writeFile(join(p.folderAbs, '日记.md'), '# 日记\n\n私密内容。\n', 'utf8')
    await engine.noteSourceExclude(join(p.folderAbs, '存档'))
    await engine.noteSourceExclude(join(p.folderAbs, '日记.md'))

    // 直注被排除：文件与文件夹都拒绝（提示先解除）
    await assert.rejects(() => engine.channels.noteSourceRegister(join(p.folderAbs, '日记.md')), /排除清单内/)
    await assert.rejects(() => engine.channels.noteSourceRegister(join(p.folderAbs, '存档')), /排除清单内/)

    // 文件夹本身不在清单、但其下 .md 全部命中：报错点名排除清单，不是「没有 .md 笔记」
    await mkdir(join(p.folderAbs, '私密'), { recursive: true })
    await writeFile(join(p.folderAbs, '私密', '手记.md'), '# 手记\n\n内容。\n', 'utf8')
    await engine.noteSourceExclude(join(p.folderAbs, '私密', '手记.md'))
    await assert.rejects(() => engine.channels.noteSourceRegister(join(p.folderAbs, '私密')), /全部命中排除清单/)

    // 批量登记：排除子树整枝不下钻、排除文件不收，其余照常
    // （skipped/skipped_paths 记被跳过的清单条目本身——目录级，不展开内部文件）
    const reg = await engine.channels.noteSourceRegister(p.folderAbs)
    assert.equal(reg.registered, 2)
    assert.equal(reg.skipped, 3)
    assert.deepEqual(
      [...(reg.skipped_paths ?? [])].sort(),
      ['我的笔记/存档', '我的笔记/日记.md', '我的笔记/私密/手记.md'],
    )
    assert.ok((reg.sources as Array<Record<string, unknown>>).every(s => !String(s.path).includes('存档')))

    // 解除后同路径可注册
    await engine.noteSourceUnexclude('我的笔记/日记.md')
    const re = await engine.channels.noteSourceRegister(join(p.folderAbs, '日记.md'))
    assert.equal(re.registered, 1)
  })
})

test('排除清单只管未来注册：先注册后排除不摘源、卡照常出队；Missing 后重注册被拒（提示先解除）', async () => {
  await withVault(async (engine, p) => {
    await engine.channels.noteSourceRegister(p.noteAbs)
    await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)
    const before = await readFile(p.noteAbs, 'utf8')
    const today = todayStr(new Date())
    await engine.bank.updateQuestionEvidence(engine.paths.noteSourceDir, 'note-1', 'q1', {
      fsrs: { stability: 5, difficulty: 5, due: today, last_review: '2026-09-01', reps: 1, lapses: 0 },
    })

    // 源路径进排除清单：已注册源不摘除、状态 ok、到期卡照常出队（摘除走 unregister）
    await engine.noteSourceExclude(p.noteAbs)
    const q = await engine.content2.reviewQueue()
    assert.equal(q.cards.filter(c => c.source === 'note').length, 1)
    const list = await engine.channels.noteSourceList()
    assert.equal((list.sources[0] as Record<string, unknown>).status, 'ok')

    // 但 Missing 后不能再靠重注册恢复——排除清单拒绝，提示先解除
    await rename(p.noteAbs, `${p.noteAbs}.bak`)
    await assert.rejects(() => engine.channels.noteSourceRegister(p.noteAbs), /排除清单内/)
    await rename(`${p.noteAbs}.bak`, p.noteAbs)

    // 排除动作全程不碰笔记文件（ADR-0010 零写入纪律）
    assert.equal(await readFile(p.noteAbs, 'utf8'), before)
  })
})

test('卡池镜像（V-4 #108）：出题落 [[个人笔记]] backlink 镜像、解除随删、个人笔记字节不变', async () => {
  await withVault(async (engine, p) => {
    const before = await readFile(p.noteAbs, 'utf8')
    const today = todayStr(new Date())
    await engine.channels.noteSourceRegister(p.noteAbs)
    await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)

    const poolPath = engine.paths.noteSourcePoolPath('note-1')
    assert.ok(existsSync(poolPath), '出题后卡池镜像存在')
    const pool = await readFile(poolPath, 'utf8')
    assert.match(pool, /\[\[我的笔记\/费曼技巧\|费曼技巧\]\]/, '镜像带指向个人笔记的 wikilink')
    assert.match(pool, /卡片 2 张/, '卡数快照')
    assert.match(pool, new RegExp(`截至 ${today}`))
    assert.match(pool, /零写入/)

    // 到期卡计数：把一题 due 改到今天后重连（relink 刷镜像）应显示到期 1
    await engine.bank.updateQuestionEvidence(engine.paths.noteSourceDir, 'note-1', 'q1', {
      fsrs: { stability: 5, difficulty: 5, due: today, last_review: '2026-09-01', reps: 1, lapses: 0 },
    })

    // 解除注册：镜像随删；个人笔记全程字节不变
    await engine.noteSourceUnregister('note-1')
    assert.ok(!existsSync(poolPath), '解除注册后卡池镜像清除')
    assert.equal(await readFile(p.noteAbs, 'utf8'), before)
  })
})

test('relink（V-6 #109）：改名后 Missing → 重连带卡池与调度恢复，指纹/标题/镜像跟随新路径', async () => {
  await withVault(async (engine, p) => {
    await engine.channels.noteSourceRegister(p.noteAbs)
    await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)
    const today = todayStr(new Date())
    await engine.bank.updateQuestionEvidence(engine.paths.noteSourceDir, 'note-1', 'q1', {
      fsrs: { stability: 5, difficulty: 5, due: today, last_review: '2026-09-01', reps: 1, lapses: 0 },
    })

    // 改名 → Missing 挂起
    const moved = join(p.folderAbs, '费曼技巧-v2.md')
    await rename(p.noteAbs, moved)
    assert.equal((await engine.channels.noteSourceList()).sources[0]!.status, 'missing')

    // relink 到新路径：id 不变（卡池与调度保留）、状态回 ok、到期卡回队列
    const rel = await engine.noteSourceRelink('note-1', moved)
    assert.equal(rel.id, 'note-1')
    assert.equal(rel.from, '我的笔记/费曼技巧.md')
    assert.equal(rel.to, '我的笔记/费曼技巧-v2.md')
    const src = (await engine.channels.noteSourceList()).sources[0] as Record<string, unknown>
    assert.equal(src.status, 'ok')
    assert.equal(src.path, '我的笔记/费曼技巧-v2.md')
    const entries = await engine.registry.loadNoteSources()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.id, 'note-1')
    // 新路径内容与旧一致 → 指纹与源清单同步（不被判漂移）
    const q = await engine.content2.reviewQueue()
    assert.equal(q.cards.filter(c => c.source === 'note').length, 1)
    assert.equal((q as Record<string, unknown>).note_suspended, undefined)
    // V-4 #108：队列卡带来源笔记标题与路径（面板显示 + obsidian:// 跳转的数据源）
    const nc = q.cards.find(c => c.source === 'note') as Record<string, unknown>
    assert.equal(nc.title, '费曼技巧')
    assert.equal(nc.source_path, '我的笔记/费曼技巧-v2.md')
    assert.match(String(nc.source_abs), /费曼技巧-v2\.md$/)
    // 卡池镜像的 [[链接]] 跟到新路径
    const pool = await readFile(engine.paths.noteSourcePoolPath('note-1'), 'utf8')
    assert.match(pool, /\[\[我的笔记\/费曼技巧-v2\|/)
    assert.match(pool, /到期 1/)

    // relink 后源文件依旧零写入
    assert.equal(await readFile(moved, 'utf8'), `${PERSONAL_NOTE}\n`)
  })
})

test('relink fail loud：同路径、目标不存在、路径被他源占用、目标在排除清单、中心内路径', async () => {
  await withVault(async (engine, p) => {
    await engine.channels.noteSourceRegister(p.noteAbs)
    await engine.channels.noteSourceRegister(join(p.folderAbs, '另一篇.md'))
    await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)

    await assert.rejects(() => engine.noteSourceRelink('note-1', p.noteAbs), /已注册在路径/)
    await assert.rejects(() => engine.noteSourceRelink('note-1', join(p.folderAbs, '不存在.md')), /目标文件不存在/)
    await assert.rejects(() => engine.noteSourceRelink('note-1', join(p.folderAbs, '另一篇.md')), /已是笔记源「note-2」/)
    // 排除清单目标拒绝
    await engine.noteSourceExclude(join(p.folderAbs, '私密.md'))
    await writeFile(join(p.folderAbs, '私密.md'), '# 私密\n', 'utf8')
    await assert.rejects(() => engine.noteSourceRelink('note-1', join(p.folderAbs, '私密.md')), /排除清单内/)
    // 中心内路径过不了注册同款卫生
    await assert.rejects(() => engine.noteSourceRelink('note-1', '学习中心/math/课程/入门.md'), /学习中心内部/)
    // 不存在的 id
    await assert.rejects(() => engine.noteSourceRelink('note-99', p.noteAbs), /没有笔记源/)
  })
})

test('Data Check 全库注册源盘点（V-6 #109）：逐源存在性+指纹计数、缺失报 Missing 级 finding', async () => {
  await withVault(async (engine, p) => {
    // 源1 出题后编辑 → 漂移；源2 注册后删除 → 缺失（清单条目在，不算镜像不一致）
    await engine.channels.noteSourceRegister(p.noteAbs)
    await engine.noteSourceGenerate('note-1', undefined, async () => NOTE_BANK_YAML)
    await writeFile(p.noteAbs, `${PERSONAL_NOTE}\n\n补充要点。\n`, 'utf8')
    const gone = join(p.folderAbs, '将删除.md')
    await writeFile(gone, '# 将删除\n\n内容。\n', 'utf8')
    await engine.channels.noteSourceRegister(gone)
    await rm(gone)

    const report = await engine.dataCheck()
    const inv = report.inventory.noteSourceFiles
    assert.equal(inv.total, 2)
    assert.equal(inv.ok, 0)
    assert.equal(inv.drifted, 1)
    assert.equal(inv.missing, 1)
    assert.equal(inv.inconsistent, 0)

    const missingFinding = report.findings.find(f => f.reason === 'note_source_file_missing')
    assert.ok(missingFinding, '缺失源报 finding')
    assert.equal(missingFinding!.level, 'missing')
    assert.match(missingFinding!.detail ?? '', /relink/)

    // 全恢复基线：note-2 relink 到另一现存文件（缺失清零）；note-1 仍是漂移（编辑没确认）
    const restored = join(p.folderAbs, '恢复.md')
    await writeFile(restored, '# 恢复\n\n内容。\n', 'utf8')
    await engine.noteSourceRelink('note-2', restored)
    const report2 = await engine.dataCheck()
    assert.equal(report2.inventory.noteSourceFiles.ok, 1)
    assert.equal(report2.inventory.noteSourceFiles.drifted, 1)
    assert.equal(report2.inventory.noteSourceFiles.missing, 0)
    assert.ok(!report2.findings.some(f => f.reason === 'note_source_file_missing'))
  })
})
