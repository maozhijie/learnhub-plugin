/**
 * 常驻 worktree 池管理（章法见 docs/agents/parallel-sessions.md §常驻 worktree 池）。
 * 池位永不销毁，并行任务先认领、用完释放：
 *   claim    认领第一个空闲池位（原子写标记，两会话同抢只有一个成功）
 *   release  释放池位（删除认领标记）
 *   status   池位一览（分支 / 脏文件 / 落后领先 / 认领信息）
 *   sync     保养未被认领的池位：脏树先提交 → fetch → rebase origin/main，冲突即 abort
 *   setup    补建缺失的池位（幂等；新位还需两处 npm install + 首次索引）
 * 认领标记放仓外（<仓父目录>/.learnhub-wt-claims/）：git 看不见，不会被同步步骤的
 * `git add -A` 误提交，也不污染 worktree 的 git status。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const poolRoot = dirname(repoRoot)
const claimDir = join(poolRoot, '.learnhub-wt-claims')
const SLOTS = [1, 2, 3]
const REMOTE_BRANCH = 'origin/main'

const wtPath = (n) => join(poolRoot, `learnhub-wt-${n}`)
const branchName = (n) => `wt-${n}`
const markerPath = (n) => join(claimDir, `learnhub-wt-${n}.json`)

function git(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function readMarker(n) {
  try {
    return JSON.parse(readFileSync(markerPath(n), 'utf8'))
  } catch {
    return null
  }
}

function aheadBehind(n) {
  try {
    const ahead = git(['rev-list', '--count', `${REMOTE_BRANCH}..HEAD`], wtPath(n))
    const behind = git(['rev-list', '--count', `HEAD..${REMOTE_BRANCH}`], wtPath(n))
    return `${behind}/${ahead}`
  } catch {
    return '?/?'
  }
}

function parseSlot(arg) {
  const m = /^(?:1|2|3|wt-[123]|learnhub-wt-[123])$/.exec(arg ?? '')
  if (!m) throw new Error(`无法识别池位「${arg}」，可用：1|2|3（或 wt-1 / learnhub-wt-1 / 完整路径的前几段同形写法）`)
  return /([123])$/.exec(m[0])[1]
}

function cmdClaim(flags) {
  const missing = []
  mkdirSync(claimDir, { recursive: true })
  for (const n of SLOTS) {
    if (!existsSync(wtPath(n))) {
      missing.push(n)
      continue
    }
    const body = JSON.stringify(
      {
        task: flags.task ?? '(未注明——认领时请带 --task "<一句话任务>")',
        ...(flags.session ? { session: flags.session } : {}),
        claimedAt: new Date().toISOString(),
        pid: process.pid,
      },
      null,
      2,
    ) + '\n'
    try {
      writeFileSync(markerPath(n), body, { flag: 'wx' })
    } catch (e) {
      if (e.code === 'EEXIST') continue
      throw e
    }
    console.log(`[wt-pool] 已认领 wt-${n} -> ${wtPath(n)}（分支 ${branchName(n)}）`)
    console.log('[wt-pool] 接下来：① 同步（脏树先 commit → fetch → rebase origin/main）② index_repository 刷新索引 ③ 用该池位的 project 名探索 ④ 完工后 release。章法见 docs/agents/parallel-sessions.md §常驻 worktree 池')
    return
  }
  for (const n of SLOTS) {
    const m = readMarker(n)
    if (m) console.log(`[wt-pool] wt-${n} 已被认领：${m.task}（${m.claimedAt}）`)
  }
  if (missing.length) console.log(`[wt-pool] 池位缺失：${missing.map((n) => `wt-${n}`).join('、')}（node scripts/worktree-pool.mjs setup 补建）`)
  console.error('[wt-pool] 没有空闲池位——等一个释放，或经用户同意临时另建 worktree（见 parallel-sessions.md 临时章节）')
  process.exit(1)
}

function cmdRelease(arg) {
  const n = parseSlot(arg)
  if (!existsSync(markerPath(n))) {
    console.log(`[wt-pool] wt-${n} 本就没有认领标记（已是空闲）`)
    return
  }
  rmSync(markerPath(n))
  console.log(`[wt-pool] 已释放 wt-${n}`)
}

function cmdStatus() {
  for (const n of SLOTS) {
    if (!existsSync(wtPath(n))) {
      console.log(`wt-${n}  ✗ 池位不存在（node scripts/worktree-pool.mjs setup 补建）`)
      continue
    }
    const parts = [`wt-${n}`, git(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath(n))]
    const dirty = git(['status', '--porcelain'], wtPath(n))
    parts.push(dirty ? `脏文件 ${dirty.split('\n').length}` : '干净')
    parts.push(`落后/领先 ${aheadBehind(n)}`)
    const m = readMarker(n)
    if (m) {
      parts.push(`已认领：${m.task}（${m.claimedAt}）`)
    } else {
      parts.push('空闲')
    }
    console.log(parts.join('  '))
  }
}

function cmdSync() {
  console.log('[wt-pool] fetch origin …')
  git(['fetch', 'origin'])
  const failed = []
  for (const n of SLOTS) {
    if (!existsSync(wtPath(n))) continue
    if (existsSync(markerPath(n))) {
      console.log(`[wt-pool] wt-${n} 认领中，跳过`)
      continue
    }
    const wt = wtPath(n)
    try {
      if (git(['status', '--porcelain'], wt)) {
        git(['add', '-A'], wt)
        git(['commit', '-m', 'wip: 池保养 sync 前自动落盘'], wt)
        console.log(`[wt-pool] wt-${n} 有脏改动，已先提交`)
      }
      const behind = git(['rev-list', '--count', `HEAD..${REMOTE_BRANCH}`], wt)
      if (behind === '0') {
        console.log(`[wt-pool] wt-${n} 已是最新`)
        continue
      }
      git(['rebase', REMOTE_BRANCH], wt)
      console.log(`[wt-pool] wt-${n} 已 rebase 到 ${REMOTE_BRANCH}`)
    } catch (e) {
      try {
        git(['rebase', '--abort'], wt)
      } catch {}
      failed.push(n)
      console.error(`[wt-pool] wt-${n} rebase 失败，已 abort 保持原状：${String(e.message).split('\n')[0]}`)
    }
  }
  if (failed.length) {
    console.error(`[wt-pool] 冲突未解决的池位：${failed.map((n) => `wt-${n}`).join('、')}——需要人工/会话按任务分派处理`)
    process.exit(1)
  }
}

function cmdSetup() {
  for (const n of SLOTS) {
    if (existsSync(wtPath(n))) {
      console.log(`[wt-pool] wt-${n} 已存在，跳过`)
      continue
    }
    const hasBranch = git(['branch', '--list', branchName(n)]) !== ''
    if (hasBranch) git(['worktree', 'add', wtPath(n), branchName(n)])
    else git(['worktree', 'add', '-b', branchName(n), wtPath(n), REMOTE_BRANCH])
    console.log(`[wt-pool] 已建 wt-${n} -> ${wtPath(n)}`)
    console.log('[wt-pool] 新池位还需：根目录与 ui/ 各一次 npm install；index_repository 首次索引')
  }
}

function usage() {
  console.log(`用法：node scripts/worktree-pool.mjs <命令>
  claim   [--task "<一句话>"] [--session <会话id>]   认领第一个空闲池位
  release <1|2|3>                                    释放池位（删认领标记）
  status                                             池位一览
  sync                                               保养未被认领的池位（脏树先提交→fetch→rebase）
  setup                                              补建缺失池位（幂等）`)
}

const [cmd, ...rest] = process.argv.slice(2)
const flags = {}
for (let i = 0; i < rest.length; i++) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(rest[i])
  if (m) flags[m[1]] = m[2] ?? rest[++i]
}

try {
  if (cmd === 'claim') cmdClaim(flags)
  else if (cmd === 'release') cmdRelease(rest[0])
  else if (cmd === 'status') cmdStatus()
  else if (cmd === 'sync') cmdSync()
  else if (cmd === 'setup') cmdSetup()
  else usage()
} catch (e) {
  console.error(`[wt-pool] ${e.message}`)
  process.exit(1)
}
