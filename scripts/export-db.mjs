/**
 * 一次性导出：旧 SQLite 权威库（state/learnhub.db）的 journal/practice 表
 * → state/journal.jsonl / state/practice.jsonl（追加，不覆盖现有行）。
 * 用法：node scripts/export-db.mjs <vault 路径>
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const vault = process.argv[2]
if (!vault) {
  console.error('usage: node scripts/export-db.mjs <vault>')
  process.exit(1)
}
const here = dirname(fileURLToPath(import.meta.url))
const center = join(vault, '学习中心')
const dbPath = join(center, 'state', 'learnhub.db')
if (!existsSync(dbPath)) {
  console.log(`no legacy db at ${dbPath} — nothing to export`)
  process.exit(0)
}

const db = new DatabaseSync(dbPath, { readOnly: true })

// journal：列序 (id, ts, course, node, rating, kind, elapsed_days, session, duration_s, detail)
let n = 0
const journalOut = []
for (const row of db.prepare('SELECT * FROM journal ORDER BY id').all()) {
  const rec = {
    ts: row.ts, course: row.course, node: row.node,
    rating: row.rating ?? null, kind: row.kind,
    elapsed_days: row.elapsed_days ?? 0,
    session: row.session ?? null, duration_s: row.duration_s ?? null,
    ...(row.detail ? { detail: row.detail } : {}),
  }
  journalOut.push(JSON.stringify(rec))
  n++
}
await mkdir(join(center, 'state'), { recursive: true })
await appendFile(join(center, 'state', 'journal.jsonl'), (journalOut.length ? journalOut.join('\n') + '\n' : ''), 'utf8')
console.log(`journal exported: ${n} rows`)

// practice：列序 (id, ts, course, node, ex, answer, correct, judge, feedback)
let m = 0
const practiceOut = []
for (const row of db.prepare('SELECT * FROM practice ORDER BY id').all()) {
  const rec = {
    ts: row.ts, course: row.course, node: row.node, ex: row.ex,
    answer: row.answer ?? '', correct: row.correct === null || row.correct === undefined ? null : Boolean(row.correct),
    judge: row.judge ?? 'human', ...(row.feedback ? { feedback: row.feedback } : {}),
  }
  practiceOut.push(JSON.stringify(rec))
  m++
}
await appendFile(join(center, 'state', 'practice.jsonl'), (practiceOut.length ? practiceOut.join('\n') + '\n' : ''), 'utf8')
console.log(`practice exported: ${m} rows`)
db.close()
