import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { LearnhubEngine } from '../src/engine/index.ts'
import { revealAnswer } from '../src/engine/grading.ts'
import { mapAnkiEase, sameDayAdvanced, planMirrorSync, sourceKeyOf, parseSourceKey, ankiCardPayload, fingerprintOf, isoFromMs } from '../src/engine/anki.ts'
import type { AnkiTransport } from '../src/engine/anki.ts'
import { todayStr } from '../src/engine/dates.ts'
import { withVault as makeVault } from './helpers/vault.ts'

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
  '  attempts: 2',
  '  correct: 2',
  '---',
  '',
  '# 入门',
  '',
  '## 概念',
  '',
  '课程正文占位。',
].join('\n')

const TODAY = todayStr(new Date())

function bankYaml(): string {
  // q1/q2 到期（due=今天）；q3 已归档且到期（导出必须排除，归档移除用例消费）
  return [
    'node: 入门',
    'questions:',
    '  - id: q1',
    '    kind: single_choice',
    '    q: 等差数列的定义是？',
    '    options: ["相邻两项之差恒定", "任意两项之比恒定", "各项递增", "各项为整数"]',
    '    answer: A',
    '    explanation: 公差 d 刻画相邻差。',
    `    fsrs: { stability: 3, difficulty: 5, due: "${TODAY}", last_review: "2026-09-01", reps: 2, lapses: 0 }`,
    '  - id: q2',
    '    kind: fill_in_blank',
    '    q: 等差数列相邻两项之差叫____。',
    '    answer: ["公差"]',
    `    fsrs: { stability: 2, difficulty: 6, due: "${TODAY}", last_review: "2026-09-02", reps: 1, lapses: 1 }`,
    '  - id: q3',
    '    kind: true_false',
    '    q: 已归档的题占位。',
    '    answer: true',
    '    archived: true',
    `    fsrs: { stability: 4, difficulty: 5, due: "${TODAY}", last_review: "2026-09-01", reps: 3, lapses: 0 }`,
  ].join('\n') + '\n'
}

async function withVault(run: (engine: LearnhubEngine) => Promise<void>): Promise<void> {
  await makeVault({ tag: 'learnhub-anki-', notes: { 入门: `${NOTE}\n` }, banks: { 入门: bankYaml() } }, ({ engine }) => run(engine))
}

/** 假 AnkiConnect：内存态牌组/笔记/复习日志（cardReviews 按毫秒水位过滤）。 */
class FakeAnki implements AnkiTransport {
  notes = new Map<number, { noteId: number; deckName: string; fields: Record<string, string>; tags: string[] }>()
  cards = new Map<number, number>()
  reviews: number[][] = []
  models = new Set<string>()
  decks = new Set<string>()
  private nextNoteId = 1_700_000_000_000
  private nextCardId = 1_800_000_000_000

  async invoke(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    switch (action) {
      case 'version': return 6
      case 'modelNames': return [...this.models]
      case 'createModel': this.models.add(String(params.modelName)); return null
      case 'deckNames': return [...this.decks]
      case 'createDeck': this.decks.add(String(params.deck)); return null
      case 'addNote': {
        const note = params.note as { deckName: string; fields: Record<string, string>; tags: string[] }
        for (const n of this.notes.values()) {
          if (n.deckName === note.deckName && n.fields['来源'] === note.fields['来源']) return null
        }
        if (!this.models.has('learnhub')) throw new Error('Model not found')
        const id = this.nextNoteId++
        this.notes.set(id, { noteId: id, deckName: note.deckName, fields: { ...note.fields }, tags: [...note.tags] })
        const cardId = this.nextCardId++
        this.cards.set(cardId, id)
        return id
      }
      case 'updateNoteFields': {
        const n = this.notes.get(Number((params.note as { id: number }).id))
        if (!n) throw new Error('Note not found')
        Object.assign(n.fields, (params.note as { fields: Record<string, string> }).fields)
        return null
      }
      case 'deleteNotes':
        for (const id of params.notes as number[]) this.notes.delete(Number(id))
        return null
      case 'findNotes': {
        const deck = /deck:"([^"]+)"/.exec(String(params.query))?.[1]
        return [...this.notes.values()].filter(n => !deck || n.deckName === deck).map(n => n.noteId)
      }
      case 'notesInfo':
        return (params.notes as number[]).map(id => {
          const n = this.notes.get(Number(id))
          if (!n) return null
          return { noteId: n.noteId, fields: Object.fromEntries(Object.entries(n.fields).map(([k, v]) => [k, { value: v }])) }
        }).filter(Boolean)
      case 'cardsInfo':
        return (params.cards as number[]).map(id => {
          const noteId = this.cards.get(Number(id))
          // AnkiConnect 的 cardsInfo 行里 note id 字段名是 note（非 noteId）
          return noteId !== undefined && this.notes.has(noteId) ? { cardId: Number(id), note: noteId } : null
        }).filter(Boolean)
      case 'cardReviews': {
        const mmin = Number(params.mmin)
        const mmax = Number(params.mmax)
        return this.reviews.filter(r => r[0]! > mmin && r[0]! <= mmax)
      }
      default: throw new Error(`fake anki: unknown action ${action}`)
    }
  }

  /** 模拟学习者在 Anki 里作答（button 1–4）。 */
  answer(noteKey: string, button: number, tsMs: number, timeMs = 5000): void {
    const note = [...this.notes.values()].find(n => n.fields['来源'] === noteKey)
    if (!note) throw new Error(`fake anki: no note ${noteKey}`)
    const cardId = [...this.cards].find(([, nid]) => nid === note.noteId)?.[0]
    if (cardId === undefined) throw new Error('fake anki: no card')
    this.reviews.push([tsMs, cardId, 0, button, 0, 0, button, timeMs, 1])
  }

  noteFields(noteKey: string): Record<string, string> {
    const note = [...this.notes.values()].find(n => n.fields['来源'] === noteKey)
    if (!note) throw new Error(`fake anki: no note ${noteKey}`)
    return note.fields
  }
}

/** 今天上午 10 点的本地毫秒时间戳（事件日 = 今天，避开午夜边界）。 */
function todayNoonMs(): number {
  const d = new Date()
  d.setHours(10, 0, 0, 0)
  return d.getTime()
}

/** 导入窗口上限：固定在事件之后（默认 Date.now() 会在 10 点前跑测试时漏掉全部事件）。 */
const IMPORT_AT = { nowMs: todayNoonMs() + 600_000 }

// ---- 纯函数缝 ----

test('纯函数缝：Anki 事件映射（Again→答错 auto；Hard/Good/Easy→自评 self）、非法按钮拒绝', () => {
  assert.deepEqual(mapAnkiEase(1), { rating: 1, correct: false, ratingSource: 'auto' })
  assert.deepEqual(mapAnkiEase(2), { rating: 2, correct: true, ratingSource: 'self' })
  assert.deepEqual(mapAnkiEase(3), { rating: 3, correct: true, ratingSource: 'self' })
  assert.deepEqual(mapAnkiEase(4), { rating: 4, correct: true, ratingSource: 'self' })
  assert.throws(() => mapAnkiEase(0), /1–4/)
  assert.throws(() => mapAnkiEase(5), /1–4/)
})

test('纯函数缝：同日已推进判定（stats.last 与 fsrs.last_review 双门）', () => {
  const q = {
    fsrs: { stability: 1, difficulty: 5, due: '2026-09-09', last_review: TODAY, reps: 1, lapses: 0 },
    stats: { attempts: 1, correct: 1, last: '2026-09-01' },
  }
  assert.equal(sameDayAdvanced(q, TODAY), true, 'fsrs.last_review 命中事件日')
  assert.equal(sameDayAdvanced({ ...q, fsrs: { ...q.fsrs, last_review: '2026-09-01' }, stats: { ...q.stats, last: TODAY } }, TODAY), true, 'stats.last 命中事件日')
  assert.equal(sameDayAdvanced({ ...q, fsrs: { ...q.fsrs, last_review: '2026-09-01' } }, TODAY), false)
  assert.equal(sameDayAdvanced({}, TODAY), false)
})

test('纯函数缝：来源键编解码（节点名含 / 的拆解）与镜象 diff（add/update/remove）', () => {
  assert.equal(sourceKeyOf('数学', '入/门', 'q1'), '数学/入/门/q1')
  assert.deepEqual(parseSourceKey('数学/入/门/q1'), { course: '数学', node: '入/门', qid: 'q1' })
  assert.deepEqual(parseSourceKey('数学/入门/q1'), { course: '数学', node: '入门', qid: 'q1' })
  assert.equal(parseSourceKey('没有斜杠'), null)
  assert.equal(parseSourceKey('a/'), null)

  const p = (key: string, fp: string) => ({ key, deckName: `learnhub::${key.split('/')[0]}`, fields: { 题目: key, 答案: '', 来源: key }, fp })
  const plan = planMirrorSync([p('a/n/q1', 'f1'), p('a/n/q2', 'f2'), p('a/n/q3', 'f3')], [
    { key: 'a/n/q1', note_id: 11, fp: 'f1', deck: 'learnhub::a' },   // 不变
    { key: 'a/n/q2', note_id: 12, fp: 'old', deck: 'learnhub::a' },  // 内容变 → update
    { key: 'a/n/q9', note_id: 19, fp: 'f9', deck: 'learnhub::a' },   // vault 没了 → remove
  ])
  assert.deepEqual(plan.add.map(x => x.key), ['a/n/q3'])
  assert.deepEqual(plan.update, [{ payload: p('a/n/q2', 'f2'), noteId: 12 }])
  assert.deepEqual(plan.removeNoteIds, [19])
})

test('纯函数缝：导出负载（选项上正面不泄答案、答案+解析上背面、HTML 转义与指纹稳定）', () => {
  const payload = ankiCardPayload('数学', '入门', {
    id: 'q1', kind: 'single_choice', q: '题面 <A> & B', options: ['甲', '乙'],
  }, '答案：A\n\n解析：因为 x')
  assert.equal(payload.key, '数学/入门/q1')
  assert.equal(payload.deckName, 'learnhub::数学')
  assert.match(payload.fields['题目'], /题面 &lt;A&gt; &amp; B/)
  assert.match(payload.fields['题目'], /A\. 甲/)
  assert.ok(!payload.fields['题目'].includes('答案'))
  assert.match(payload.fields['答案'], /答案：A<br><br>解析：因为 x/)
  assert.match(payload.fields['来源'], /数学\/入门\/q1/)
  assert.equal(payload.fp, fingerprintOf('single_choice\u001f题面 <A> & B\nA. 甲\nB. 乙\u001f答案：A\n\n解析：因为 x'))
  assert.equal(isoFromMs(0).length >= 19, true)

  // revealAnswer（判卷域，grading.ts）背面排版复用
  assert.equal(revealAnswer({ kind: 'true_false', answer: true }), 'true')
})

// ---- 门面：导出推送 ----

test('导出推送：到期卡入镜象（未归档 due≤今日），已归档排除；重复推送零变更；清单落盘', async () => {
  await withVault(async engine => {
    const anki = new FakeAnki()
    const r1 = await engine.channels.ankiExportPush(anki)
    assert.equal(r1.added, 2, 'q1/q2 入镜象；q3 已归档排除')
    assert.equal(r1.total, 2)
    assert.deepEqual(r1.decks, ['learnhub::数学'])
    assert.equal(anki.notes.size, 2)
    assert.ok(anki.models.has('learnhub'))
    assert.match(anki.noteFields('数学/入门/q1')['答案'], /公差 d 刻画相邻差/)
    // 镜象清单落盘（key↔noteId 归属）
    const mirror = JSON.parse(await readFile(engine.paths.ankiMirrorPath, 'utf8'))
    assert.equal(mirror.notes.length, 2)
    assert.match(mirror.last_push, /T/)
    // 再推一次：无新增（到期集未变）
    const r2 = await engine.channels.ankiExportPush(anki)
    assert.equal(r2.added, 0)
    assert.equal(r2.updated, 0)
    assert.equal(r2.removed, 0)
    assert.equal(anki.notes.size, 2)
  })
})

// ---- 门面：导入回写 ----

test('导入回写：Again/Hard/Good/Easy 按 vault ts-fsrs 重算 + 流水/复习日志/代表卡；Anki 排期不作数', async () => {
  await withVault(async engine => {
    const anki = new FakeAnki()
    await engine.channels.ankiExportPush(anki)
    const before = await engine.bank2.questionGet('数学', '入门', 'q1')
    const beforeQ2 = await engine.bank2.questionGet('数学', '入门', 'q2')
    const q1Before = (before.question as { fsrs: { reps: number; due: string } }).fsrs
    const q2Before = (beforeQ2.question as { fsrs: { reps: number; due: string } }).fsrs

    // 学习者在 Anki 作答：q1 Good（自评 3）、q2 Again（答错 1）
    anki.answer('数学/入门/q1', 3, todayNoonMs())
    anki.answer('数学/入门/q2', 1, todayNoonMs() + 60_000)
    const r = await engine.channels.ankiImportEvents(anki, IMPORT_AT)
    assert.equal(r.imported, 2)
    assert.equal(r.advanced, 2)
    assert.equal(r.skipped_same_day, 0)
    assert.equal(r.skipped_unknown, 0)

    // vault 按 ts-fsrs 重算：reps+1、last_review=今天、due 由 vault 调度器给出（推进到未来）
    const after = await engine.bank2.questionGet('数学', '入门', 'q1')
    const afterQ2 = await engine.bank2.questionGet('数学', '入门', 'q2')
    const q1After = (after.question as { fsrs: { reps: number; due: string; last_review: string } }).fsrs
    const q2After = (afterQ2.question as { fsrs: { reps: number; due: string; last_review: string; lapses: number } }).fsrs
    assert.equal(q1After.reps, q1Before.reps + 1)
    assert.equal(q1After.last_review, TODAY)
    assert.ok(q1After.due > TODAY, 'Good 推进到期日在未来')
    assert.equal(q2After.reps, q2Before.reps + 1)
    assert.equal(q2After.lapses, q2Before.lapses + 1, 'Again 记一次遗忘')
    assert.ok(q2After.due > TODAY, '忘记后明天再见（vault 排期，非 Anki 排期）')

    // 流水：judge=review、xp=0、ts 回溯到 Anki 作答时刻
    const practice = await engine.store.practiceAll()
    const ankiRows = practice.filter(x => x.judge === 'review')
    assert.equal(ankiRows.length, 2)
    assert.ok(ankiRows.every(x => x.xp === 0))
    assert.ok(ankiRows.every(x => x.ts.startsWith(TODAY)))
    assert.equal(ankiRows.find(x => x.qid === 'q2')?.correct, false)
    // 复习日志：q1 self(3)、q2 auto(1)，A2 数据回流可见
    const reviews = await engine.store.reviewLogAll()
    const ankiReviews = reviews.filter(x => x.qid === 'q1' && x.rating_source === 'self')
    assert.equal(ankiReviews.length, 1)
    assert.equal(ankiReviews[0]!.rating, 3)
    assert.equal(reviews.find(x => x.qid === 'q2' && x.rating_source === 'auto')?.rating, 1)

    // 代表卡回刷：fm.fsrs = 全部未归档题里 due 最早（q2 明天再见）
    const fm = await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8')
    const fmDue = /due: "?([^"\n]+)"?/.exec(fm.slice(fm.indexOf('fsrs:')))?.[1]
    assert.equal(fmDue, q2After.due)
  })
})

test('导入回写：同日已在 vault 推进的题，其当日 Anki 事件跳过调度只留档', async () => {
  await withVault(async engine => {
    const anki = new FakeAnki()
    await engine.channels.ankiExportPush(anki)
    // 先在 vault 里推进 q1（练习流自动判卷答对 → rating 3）
    const ans = await engine.questionAnswer(async () => { throw new Error('不该调模型') }, '数学', '入门', 'q1', 'A')
    assert.equal(ans.scheduled, true)
    const q1Before = await engine.bank2.questionGet('数学', '入门', 'q1')
    const fsrsBefore = (q1Before.question as { fsrs: { reps: number } }).fsrs
    const practiceBefore = (await engine.store.practiceAll()).length
    const reviewLogBefore = (await engine.store.reviewLogAll()).length

    // 同日 Anki 事件（q1 Good）：不产生第二次调度推进
    anki.answer('数学/入门/q1', 3, todayNoonMs() + 120_000)
    const r = await engine.channels.ankiImportEvents(anki, IMPORT_AT)
    assert.equal(r.imported, 1)
    assert.equal(r.skipped_same_day, 1)
    assert.equal(r.advanced, 0)

    const q1After = await engine.bank2.questionGet('数学', '入门', 'q1')
    assert.deepEqual((q1After.question as { fsrs: { reps: number } }).fsrs, fsrsBefore, '调度卡零写入')
    // 留档：practice 多一条（judge=review），复习日志零新增
    const practice = await engine.store.practiceAll()
    assert.equal(practice.length, practiceBefore + 1)
    assert.equal(practice.at(-1)!.judge, 'review')
    assert.equal((await engine.store.reviewLogAll()).length, reviewLogBefore)
  })
})

test('导入回写：题目已归档/重生成的事件不落库只计数；未知归属事件零副作用', async () => {
  await withVault(async engine => {
    const anki = new FakeAnki()
    await engine.channels.ankiExportPush(anki)
    // q1 归档后其 Anki 事件到来：不落库（下次推送时旧卡按 vault 校准移除）
    await engine.bank2.questionArchive('数学', '入门', 'q1', true)
    anki.answer('数学/入门/q1', 3, todayNoonMs())
    // 未知卡（清单/来源都对不上）：只计数
    anki.cards.set(999_999, 888_888)
    anki.reviews.push([todayNoonMs() + 300_000, 999_999, 0, 3, 0, 0, 3, 4000, 1])
    const r = await engine.channels.ankiImportEvents(anki, IMPORT_AT)
    assert.equal(r.skipped_unknown, 2)
    assert.equal(r.advanced, 0)
    assert.ok(!existsSync(engine.paths.practicePath), '无事件落库')
    assert.ok(!existsSync(engine.paths.reviewLogPath))
  })
})

test('导入回写：镜象清单丢失自愈（Anki 来源字段回补归属）', async () => {
  await withVault(async engine => {
    const anki = new FakeAnki()
    await engine.channels.ankiExportPush(anki)
    // 清单文件丢失（镜象可丢弃，不判 Broken）
    const { unlink } = await import('node:fs/promises')
    await unlink(engine.paths.ankiMirrorPath)
    anki.answer('数学/入门/q1', 4, todayNoonMs())
    const r = await engine.channels.ankiImportEvents(anki, IMPORT_AT)
    assert.equal(r.advanced, 1, '来源字段回补归属后照常重算')
    // 清单重建：本事件涉及的那张卡回补归属（fp 空 → 下次推送按内容校准；
    // 无事件的卡要等下次导出推送补全清单）
    const mirror = JSON.parse(await readFile(engine.paths.ankiMirrorPath, 'utf8'))
    assert.equal(mirror.notes.length, 1)
    assert.equal(mirror.notes[0].key, '数学/入门/q1')
    assert.equal(mirror.notes[0].fp, '')
    assert.ok(Number.isFinite(mirror.notes[0].note_id))
  })
})

// ---- 门面：归档移除与状态 ----

test('下次同步移除：vault 归档/消费的卡从 Anki 镜象删除（镜象以 vault 为准）', async () => {
  await withVault(async engine => {
    const anki = new FakeAnki()
    await engine.channels.ankiExportPush(anki)
    assert.equal(anki.notes.size, 2)
    await engine.bank2.questionArchive('数学', '入门', 'q2', true)
    const r = await engine.channels.ankiExportPush(anki)
    assert.equal(r.removed, 1)
    assert.equal(anki.notes.size, 1)
    assert.ok(anki.noteFields('数学/入门/q1'))
    // 清单同步收缩
    const mirror = JSON.parse(await readFile(engine.paths.ankiMirrorPath, 'utf8'))
    assert.equal(mirror.notes.length, 1)
  })
})

test('Anki 状态：镜象概况 + 到期分布 + AnkiConnect 可达性；连接失败不抛', async () => {
  await withVault(async engine => {
    const anki = new FakeAnki()
    const empty = await engine.channels.ankiStatus(anki)
    assert.equal(empty.mirror.entries, 0)
    assert.equal(empty.due.total, 2)
    assert.deepEqual((empty.anki as { connected: boolean }).connected, true)
    await engine.channels.ankiExportPush(anki)
    const st = await engine.channels.ankiStatus(anki)
    assert.equal(st.mirror.entries, 2)
    assert.match(String(st.mirror.last_push), /T/)
    assert.equal((st.anki as { connected: boolean }).connected, true)
    // 坏 transport：connected=false 带原因（不判 Broken）
    const bad: AnkiTransport = { invoke: async () => { throw new Error('ECONNREFUSED') } }
    const off = await engine.channels.ankiStatus(bad)
    assert.equal((off.anki as { connected: boolean }).connected, false)
    assert.match(String((off.anki as { error: string }).error), /ECONNREFUSED/)
  })
})

test('AnkiConnectClient：坏端点带指引报错；错误响应透传 AnkiConnect error 字段', async () => {
  const { AnkiConnectClient } = await import('../src/engine/anki.ts')
  const bad = new AnkiConnectClient('http://127.0.0.1:9', async () => {
    throw new Error('connect ECONNREFUSED')
  })
  await assert.rejects(() => bad.invoke('version'), /AnkiConnect（http:\/\/127\.0\.0\.1:9）.*已打开且装了 AnkiConnect/s)
  const erring = new AnkiConnectClient('http://x', (async () =>
    new Response(JSON.stringify({ result: null, error: 'deck was not found' }), { status: 200 })) as unknown as typeof fetch)
  await assert.rejects(() => erring.invoke('createDeck', { deck: 'x' }), /deck was not found/)
})

// ---- V-4（#108）：笔记源卡并入 Anki 通道 ----

test('笔记源卡 Anki 衔接：到期卡入 learnhub::笔记源 镜象，作答回写路由到镜像题库（默认参数调度、零代表卡）', async () => {
  await makeVault({
    tag: 'learnhub-anki-notesrc-',
    notes: { 入门: `${NOTE}\n` },
    banks: { 入门: bankYaml() },
    files: [{ path: '我的笔记/费曼技巧.md', content: '# 费曼技巧\n\n讲给外行听。\n' }],
  }, async ({ engine }) => {
    await engine.channels.noteSourceRegister('我的笔记/费曼技巧.md')
    const gen = await engine.channels.noteSourceGenerate('note-1', 1, async () => [
      'node: note-1',
      'questions:',
      '  - id: q1',
      '    kind: single_choice',
      '    q: 费曼技巧的核心动作是？',
      '    options: ["讲给外行听", "多刷题", "抄笔记", "看视频"]',
      '    answer: A',
    ].join('\n'))
    assert.equal(gen.added, 1)
    // 合成首复习 = 明天起刷：改到今天让它进导出集
    await engine.bank.updateQuestionEvidence(engine.paths.noteSourceDir, 'note-1', 'q1', {
      fsrs: { stability: 3, difficulty: 5, due: TODAY, last_review: '2026-09-01', reps: 1, lapses: 0 },
    })

    const anki = new FakeAnki()
    const exp = await engine.channels.ankiExportPush(anki)
    assert.equal(exp.total, 3, '课程 2 张 + 笔记源 1 张')
    assert.deepEqual([...exp.decks].sort(), ['learnhub::数学', 'learnhub::笔记源'])
    assert.match(anki.noteFields('笔记源/note-1/q1')['题目'], /费曼技巧的核心动作/)

    // Anki 侧作答 Good → 回写路由到镜像题库（默认参数、无代表卡回刷）
    const repsBefore = await engine.bank.load(engine.paths.noteSourceDir, 'note-1')
    const fsBefore = repsBefore.questions[0]!.fsrs
    anki.answer('笔记源/note-1/q1', 3, todayNoonMs())
    const r = await engine.channels.ankiImportEvents(anki, IMPORT_AT)
    assert.equal(r.imported, 1)
    assert.equal(r.advanced, 1)
    assert.equal(r.skipped_unknown, 0)

    const after = await engine.bank.load(engine.paths.noteSourceDir, 'note-1')
    const fsAfter = after.questions[0]!.fsrs!
    assert.equal(fsAfter.reps, (fsBefore?.reps ?? 0) + 1)
    assert.equal(fsAfter.last_review, TODAY)
    assert.ok(fsAfter.due > TODAY, 'vault 重算排期')
    // 流水与复习日志落笔记源伪课程；无绑定 XP 零掺入（judge=review 行 xp=0）
    const reviews = await engine.store.reviewLogAll()
    const noteReview = reviews.find(x => x.course === '笔记源' && x.qid === 'q1' && x.rating_source === 'self')
    assert.equal(noteReview?.rating, 3)
    const practice = await engine.store.practiceAll()
    assert.equal(practice.find(x => x.course === '笔记源' && x.judge === 'review')?.qid, 'q1')
    // 节点文件零写入（笔记源没有代表卡——课程域 frontmatter 不被 Anki 事件触碰）
    const fm = await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8')
    assert.ok(!fm.includes(`due: "${TODAY}"`), '课程节点 frontmatter 未被笔记源 Anki 事件改写')
  })
})
