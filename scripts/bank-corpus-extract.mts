/**
 * 题库语料抽取（#230 一次性工具，随票入库留档）：把 vault 里现存/归档的题库 YAML
 * 原始文本复制进 `tests/fixtures/bank-corpus/`，作为多样性基线的**只读快照**。
 *
 * 为什么留档原始语料而不是只存数字：基线一旦只有数字，任何口径修订都无法复核
 * （改了归属/题型映射/权重，数字变了却说不清是哪个改动的功劳）。原始 YAML +
 * 复算脚本 = 基线可重放、可审计、可回放复测（生成语料 #213 落地后同口径复测新批）。
 *
 * 抽取面：存档区各课程目录下的「题库」目录里的 YAML（.trash 是课程删除残留，不入基线）。
 * 幂等：同一 source 路径重复抽取结果不变（按路径排序，目标名取节点名）。
 *
 * 用法（在仓库根跑）：
 *   node scripts/bank-corpus-extract.mts [--vault <vault 根>] [--check]
 * 缺省 vault = `~/.dsh/profiles/web/cordis.patch.yml` 里 dsh-learnhub 的 vault 配置。
 * `--check` 只比对不写盘（语料是否与当前 vault 一致，不一致即退出 1）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(here)
const outDir = join(repo, 'tests/fixtures/bank-corpus')

/** dsh profile 配置 → vault 根（缺省值；命令行 --vault 覆盖）。 */
function vaultFromProfile(): string {
  const patch = join(homedir(), '.dsh/profiles/web/cordis.patch.yml')
  if (!existsSync(patch)) throw new Error(`找不到 profile 配置：${patch}——用 --vault 显式指定 vault 根`)
  const text = readFileSync(patch, 'utf8')
  const m = /^\s*vault:\s*(.+?)\s*$/m.exec(text)
  if (!m?.[1]) throw new Error(`${patch} 里没有 vault 配置——用 --vault 显式指定 vault 根`)
  return m[1].replace(/^["']|["']$/g, '')
}

/** 递归列出 vault 下所有题库 YAML（相对路径按 posix 归一、排序确定）。 */
function bankFiles(vault: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === '.trash') continue // 课程删除残留不是基线语料
        walk(p)
      } else if (e.name.endsWith('.yaml') && /(^|[/\\])题库[/\\][^/\\]+\.yaml$/.test(p)) {
        out.push(posix.join(...relative(vault, p).split(sep)))
      }
    }
  }
  walk(vault)
  return out.sort()
}

/** questions 段里的题目条数（顶层 `- kind:` 行；YAML 缩进深度无关）。 */
function questionCount(text: string): number {
  return text.split('\n').filter(l => /^\s*-\s+kind:\s*\S/.test(l)).length
}

const argv = process.argv.slice(2)
const check = argv.includes('--check')
const vaultArg = argv.indexOf('--vault')
const vault = (vaultArg >= 0 ? argv[vaultArg + 1] : undefined) ?? vaultFromProfile()
if (!vault || !existsSync(vault)) throw new Error(`vault 不存在：${vault}`)

const files = bankFiles(vault)
// 同名节点（跨课程撞名）会互相覆盖——抽取前显式报错，不静默丢一份
const byName = new Map<string, string[]>()
for (const rel of files) {
  const name = `${rel.split('/').pop()!.replace(/\.yaml$/, '')}.yaml`
  byName.set(name, [...(byName.get(name) ?? []), rel])
}
const collided = [...byName.entries()].filter(([, v]) => v.length > 1)
if (collided.length) {
  throw new Error(`同名题库文件（跨课程撞名）：${collided.map(([n, v]) => `${n} ← ${v.join(' | ')}`).join('；')}——需人工改名后再抽取`)
}

const entries: Array<{ source: string; node: string; questions: number; bytes: number }> = []
for (const rel of files) {
  const node = rel.split('/').pop()!.replace(/\.yaml$/, '')
  const text = readFileSync(join(vault, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n')
  const target = join(outDir, `${node}.yaml`)
  entries.push({ source: rel, node, questions: questionCount(text), bytes: Buffer.byteLength(text, 'utf8') })
  if (check) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== text) {
      console.error(`✗ 语料与 vault 不一致：${node}.yaml ← ${rel}`)
      process.exit(1)
    }
    continue
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(target, text)
}
if (check) {
  console.log(`✓ 语料与 vault 一致（${files.length} 个题库文件）`)
  process.exit(0)
}
// 目录即抽取结果：清掉本次抽取之外的陈旧 YAML（同名覆盖之外的残留一律移除）
for (const e of readdirSync(outDir)) {
  if (e === 'MANIFEST.json' || !e.endsWith('.yaml')) continue
  if (!byName.has(e)) rmSync(join(outDir, e))
}
// 清单只记可复核的事实（来源路径/题量/字节数）；不记时间戳——重抽必须逐字节同结果
writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify({
  note: '题库语料快照（#230 多样性基线输入）：只读原始 YAML，勿手改；重抽走 scripts/bank-corpus-extract.mts',
  vault,
  files: entries.sort((a, b) => a.node.localeCompare(b.node)),
}, null, 2) + '\n')
console.log(`抽取 ${files.length} 个题库文件 → ${relative(repo, outDir)}`)
for (const e of entries) console.log(`  ${e.node}: ${e.questions} 题 / ${e.bytes} 字节 ← ${e.source}`)
