#!/usr/bin/env node
/**
 * v1→v2 一次性迁移脚本（#138 / ADR-0034 宣告式断裂）。
 *
 * 用法：node scripts/migrate-v1.mjs <vault根目录>
 *
 * 做四件事，全部只增不删：
 *   1. 旧课程根整树 rename 进 学习中心/存档/pre-v1/<本地日期>/<root>/（我的卡/错误卡/
 *      fsrs参数.json 随课归档；行为流水 practice.jsonl 等原地不动——报表只查现课，
 *      无界域 streak 不连坐）。
 *   2. 概念登记表豁免：<root>/概念登记表.yaml 搬回原位（跨断裂存活的档案坐标系，
 *      不进存档清单）。
 *   3. 课程注册表重写为 courses: []（note_sources 保留——笔记源是 vault 个人笔记的
 *      注册身份，不随课断裂），原文拷贝进存档区留档。
 *   4. learnhub.json 盖 schema 版本戳：{ version: 2, breaks: [...], formats: {} }。
 *
 * 防重跑：learnhub.json 已是 version 2 即拒绝执行。中断后重跑安全：已搬走的课程根
 * 不在盘上自然跳过，存档目标目录已存在则换带时刻的新目录，绝不合并进旧存档。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

const CENTER = '学习中心'
const REGISTRY_FILE = '课程注册表.yaml'
const REGISTRY_EXEMPT = '概念登记表.yaml' // 跨断裂存活的档案坐标系，不进存档

function fail(message) {
  console.error(`[migrate-v1] ${message}`)
  process.exit(1)
}

function localDay() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const vault = (process.argv[2] ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
if (!vault) fail('用法：node scripts/migrate-v1.mjs <vault根目录>')
const center = join(vault, CENTER)
if (!existsSync(center)) fail(`学习中心目录不存在：${center}`)

const configPath = join(center, 'state', 'learnhub.json')
let prevConfig = {}
if (existsSync(configPath)) {
  try {
    prevConfig = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (err) {
    fail(`learnhub.json 无法解析（先手工修复再迁移）：${err.message}`)
  }
}
if (prevConfig.schema?.version === 2) {
  fail(`已是 v2（schema.version=2），拒绝重跑——迁移只能发生一次。`)
}
const fromVersion = typeof prevConfig.schema?.version === 'number' ? prevConfig.schema.version : 1

// ---- 读注册表：v1 课程清单（fail loud——清单不可读时迁移范围不明，不许猜） ----
const registryPath = join(center, REGISTRY_FILE)
let registryDoc = null
if (existsSync(registryPath)) {
  try {
    registryDoc = parse(await readFile(registryPath, 'utf8'))
  } catch (err) {
    fail(`课程注册表 YAML 无法解析（先手工修复再迁移）：${err.message}`)
  }
  if (typeof registryDoc !== 'object' || registryDoc === null || !Array.isArray(registryDoc.courses)) {
    fail('课程注册表没有 courses 列表（契约不符，先手工修复再迁移）。')
  }
}

const roots = (registryDoc?.courses ?? [])
  .map(c => (typeof c?.root === 'string' ? c.root.trim() : ''))
  .filter(Boolean)

// ---- 存档目标目录：只增不删，撞名换时刻目录，绝不合并 ----
const day = localDay()
let archiveBase = join(center, '存档', `pre-v${fromVersion}`, day)
if (existsSync(archiveBase)) archiveBase = `${archiveBase}-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`
await mkdir(archiveBase, { recursive: true })

// ---- 逐课程根整树搬移（概念登记表豁免：搬走后放回原位） ----
const moved = []
const exempted = []
const missing = []
for (const root of roots) {
  const src = join(center, root)
  if (!existsSync(src)) {
    missing.push(root)
    continue
  }
  await rename(src, join(archiveBase, root))
  moved.push(root)
  const regInArchive = join(archiveBase, root, REGISTRY_EXEMPT)
  if (existsSync(regInArchive)) {
    await mkdir(src, { recursive: true })
    await rename(regInArchive, join(src, REGISTRY_EXEMPT))
    exempted.push(root)
  }
}

// ---- 注册表：原文进存档留档，现档重写为空课程表（note_sources 保留） ----
if (existsSync(registryPath)) {
  await copyFile(registryPath, join(archiveBase, `${REGISTRY_FILE}.v1`))
  const kept = {}
  if (Array.isArray(registryDoc?.note_sources) && registryDoc.note_sources.length) {
    kept.note_sources = registryDoc.note_sources
  }
  await writeFile(registryPath, stringify({ courses: [], ...kept }), 'utf8')
}

// ---- 盖 schema 版本戳（breaks 追加断裂史，纯档案） ----
const breaks = [
  ...(Array.isArray(prevConfig.schema?.breaks) ? prevConfig.schema.breaks : []),
  {
    from: fromVersion,
    date: day,
    archived: moved,
    ...(missing.length ? { note: `盘上未找到课程根：${missing.join('、')}（未搬移）` } : {}),
  },
]
const nextConfig = {
  ...prevConfig,
  schema: { version: 2, breaks, formats: {} },
}
await mkdir(join(center, 'state'), { recursive: true })
await writeFile(configPath, JSON.stringify(nextConfig, null, 1) + '\n', 'utf8')

// ---- 汇总 ----
console.log(`[migrate-v1] cutover 完成：v${fromVersion} → v2（存档：${archiveBase}）`)
console.log(`  课程根搬移 ${moved.length} 个：${moved.join('、') || '（无）'}`)
if (exempted.length) console.log(`  概念登记表豁免（留在原位）：${exempted.join('、')}`)
if (missing.length) console.log(`  盘上未找到（跳过）：${missing.join('、')}`)
console.log('  行为流水（practice/review-log/journal）原地保留——引擎只查现课，无界域 streak 不受影响。')
console.log('  fsrs参数.json 随课归档：v2 起参数正典在沉淀层（出生即写）；旧参数蒸馏桥属后续票（#151）。')
console.log('  下一步：重启宿主（引擎版本硬门放行 v2）；新课程由种子提案接管（#142）。')
