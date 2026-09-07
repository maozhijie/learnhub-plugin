/**
 * 把 @deepseek-ai 私有 peer（dsh-llm / dsh-tools，未发布公共 npm）junction 进本仓库
 * node_modules。插件经 dsh profile 的 `link:` 安装，Node 按 realpath 解析 peer 依赖，
 * 因此它们必须存在于本仓库树内（monorepo 时代的旧布局由外层 workspace 提供）。
 * npm install 的 prepare 钩子自动执行；换机器只需改 MONOREPO 指向。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const MONOREPO = process.env.DSH_MONOREPO ?? 'C:/Users/test/Desktop/deepseek-harness/packages'
const PEERS = {
  '@deepseek-ai/dsh-llm': `${MONOREPO}/llm/llm`,
  '@deepseek-ai/dsh-tools': `${MONOREPO}/core/tools`,
}

mkdirSync(join(root, 'node_modules/@deepseek-ai'), { recursive: true })
for (const [name, target] of Object.entries(PEERS)) {
  const dst = join(root, 'node_modules', name)
  if (existsSync(dst)) {
    console.log(`[link-peers] ${name}: already present, skip`)
    continue
  }
  if (!existsSync(target)) {
    console.warn(`[link-peers] ${name}: target missing: ${target} (set DSH_MONOREPO)`)
    continue
  }
  execSync(`cmd /c mklink /J "${dst}" "${target}"`, { stdio: 'inherit' })
  console.log(`[link-peers] ${name} -> ${target}`)
}
