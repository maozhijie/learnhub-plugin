/**
 * 把 @deepseek-ai 私有 peer（dsh-llm / dsh-tools）junction 进本仓库 node_modules。
 * 插件经 dsh profile 的 `link:` 安装，Node 按 realpath（仓库真实路径）解析 peer 依赖，
 * 因此它们必须存在于本仓库树内。取源优先级：
 *   1. DSH_MONOREPO 指向的 monorepo 检出（老布局，本机已删，保留兼容）；
 *   2. npx 缓存里 dsh 自带的副本——与宿主实际加载同一份，版本天然一致（默认走这条）。
 * npx 缓存目录按调用 spec 生成哈希，`npx @deepseek-ai/dsh web` 原地更新不影响
 * junction；换 spec（如 dsh@0.2）会生成新目录，届时重跑本脚本即可。
 * npm install 的 prepare 钩子自动执行。
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const MONOREPO = process.env.DSH_MONOREPO
const PEERS = {
  '@deepseek-ai/dsh-llm': MONOREPO && `${MONOREPO}/llm/llm`,
  '@deepseek-ai/dsh-tools': MONOREPO && `${MONOREPO}/core/tools`,
}

/** 在 npx 缓存里找 dsh 的安装目录（`_npx/<hash>/node_modules/@deepseek-ai/dsh`）。 */
function findNpxDsh() {
  const npxRoot = join(process.env.LOCALAPPDATA ?? '', 'npm-cache/_npx')
  if (!existsSync(npxRoot)) return null
  for (const hash of readdirSync(npxRoot)) {
    const dsh = join(npxRoot, hash, 'node_modules/@deepseek-ai/dsh')
    if (existsSync(dsh)) return dirname(dirname(dsh))
  }
  return null
}

const npxScope = MONOREPO ? null : findNpxDsh()

mkdirSync(join(root, 'node_modules/@deepseek-ai'), { recursive: true })
for (const [name, monorepoTarget] of Object.entries(PEERS)) {
  const dst = join(root, 'node_modules', name)
  if (existsSync(dst)) {
    console.log(`[link-peers] ${name}: already present, skip`)
    continue
  }
  const target = monorepoTarget ?? join(npxScope ?? '', name)
  if (!existsSync(target)) {
    console.warn(`[link-peers] ${name}: target missing: ${target}（先跑一次 npx @deepseek-ai/dsh --version 让 npx 装好 dsh，或设 DSH_MONOREPO）`)
    continue
  }
  execSync(`cmd /c mklink /J "${dst}" "${target}"`, { stdio: 'inherit' })
  console.log(`[link-peers] ${name} -> ${target}`)
}
