/**
 * dsh-learnhub 构建脚本
 *   - lib/index.js    服务端 ESM（cordis 插件：工具 + /learnhub 路由）
 *   - lib/client.js   客户端单文件 CJS（window.__ModuleLoader__.load 握手；
 *                     react / @deepseek-ai/* 由宿主模块系统提供，保持 external）
 * esbuild JS API，与 dsh-worktable 构建同构。
 */
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'lib'), { recursive: true })

/** 面板 SPA 构建（ui/ → web/dist）：host 直接伺服产物，必须先于 lib 构建。
 * node_modules 缺失（干净克隆）时自动补 npm install。
 * Windows 工作副本是 CRLF，vite 会原样带进文本产物 → 统一 LF；
 * mermaid 等 minified 产物的行尾空白（CSS 声明 / SVG path 分隔符）会挂
 * whitespace 门禁 → 一并清除（均为渲染等价改动，不影响求值语义）。 */
function buildUi() {
  const uiDir = join(here, 'ui')
  if (!existsSync(join(uiDir, 'node_modules'))) {
    console.log('[dsh-learnhub build] ui/node_modules missing, npm install (first time only)')
    execSync('npm install --no-fund --no-audit', { cwd: uiDir, stdio: 'inherit' })
  }
  execFileSync(process.execPath, [join(uiDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: uiDir,
    stdio: 'inherit',
  })
  const distDir = join(here, 'web', 'dist')
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(html|js|mjs|css|map|json|svg)$/.test(entry.name)) {
        const text = readFileSync(p, 'utf8')
        const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
        if (cleaned !== text) writeFileSync(p, cleaned, 'utf8')
      }
    }
  }
  walk(distDir)
}
buildUi()

/** 交互件 vendored 库（host 经 /learnhub/api/vendor/* 同源伺服；沙箱 CSP 放开 'self' 后交互件仅能从这里取库）。
 * katex（min.css/JS/auto-render + woff2 字体）与 three（模块构建 + OrbitControls）；中间产物不入 git。
 * 源在 ui/node_modules（three 是 ui 的 devDependency，仅构建期用）；缺文件即失败，不静默跳过。 */
function copyVendor() {
  const uiModules = join(here, 'ui', 'node_modules')
  const vendorDir = join(here, 'web', 'vendor')
  const katexDist = join(uiModules, 'katex', 'dist')
  const threeDir = join(uiModules, 'three')
  const files = [
    [join(katexDist, 'katex.min.css'), join(vendorDir, 'katex', 'katex.min.css')],
    [join(katexDist, 'katex.min.js'), join(vendorDir, 'katex', 'katex.min.js')],
    [join(katexDist, 'contrib', 'auto-render.min.js'), join(vendorDir, 'katex', 'contrib', 'auto-render.min.js')],
    [join(threeDir, 'build', 'three.module.js'), join(vendorDir, 'three', 'build', 'three.module.js')],
    [join(threeDir, 'build', 'three.core.js'), join(vendorDir, 'three', 'build', 'three.core.js')],
    [join(threeDir, 'examples', 'jsm', 'controls', 'OrbitControls.js'), join(vendorDir, 'three', 'examples', 'jsm', 'controls', 'OrbitControls.js')],
  ]
  for (const [from, to] of files) {
    if (!existsSync(from)) throw new Error(`[dsh-learnhub build] vendor source missing: ${from}（先在 ui/ npm install）`)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
  }
  const fontsDir = join(katexDist, 'fonts')
  mkdirSync(join(vendorDir, 'katex', 'fonts'), { recursive: true })
  for (const f of readdirSync(fontsDir)) {
    if (f.endsWith('.woff2')) cpSync(join(fontsDir, f), join(vendorDir, 'katex', 'fonts', f))
  }
  console.log(`[dsh-learnhub build] vendor copied: katex + three -> ${vendorDir}`)
}
copyVendor()

/** 产物里依赖源码（ts-fsrs JSDoc 等）遗留的纯空白行会挂 whitespace 门禁；
 *  行尾空白仅在「整行为空白」时无语义，规范为空行（模板字符串内的空行同理）。 */
function stripBlankLineTrailingWhitespace(file) {
  const code = readFileSync(file, 'utf8')
  const cleaned = code.replace(/^[ \t]+$/gm, '')
  if (cleaned !== code) writeFileSync(file, cleaned, 'utf8')
}

// ESM 产物内 CJS 依赖（yaml 等）的 require 兜底：esbuild 动态 require shim 的标准解法
const nodeBanner = {
  js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
}

/** native 模块（napi .node 二进制按平台包分发）不可打包：运行时从 node_modules 动态
 * import。优化器（#62）是唯一消费方，调用点隔离在 src/engine/optimize.ts。 */
const NODE_EXTERNALS = ['@deepseek-ai/*', 'node:*', '@open-spaced-repetition/*']

const clientBanner = {
  js: "window.__ModuleLoader__.load({ id: 'dsh-learnhub', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
}
const clientFooter = { js: 'return module.exports; } });' }

await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: 'lib/index.js',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  external: NODE_EXTERNALS,
  banner: nodeBanner,
})

// 引擎独立产物：冒烟测试/脚本消费（不含 cordis 工具与 HTTP 层）
await build({
  entryPoints: [join(here, 'src/engine/index.ts')],
  outfile: 'lib/engine.js',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  external: NODE_EXTERNALS,
  banner: nodeBanner,
})

await build({
  entryPoints: [join(here, 'src/client/index.tsx')],
  outfile: 'lib/client.js',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  platform: 'browser',
  format: 'cjs',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  banner: clientBanner,
  footer: clientFooter,
})

/** 技能随构建安装：skills/* 真实复制到 <dshHome>/skills/（skill-filesystem 的
 * 内置扫描根，对所有 dsh 会话可见、无需任何配置）。必须真实目录而非
 * junction——skill 扫描根只认 isDirectory()。改技能后重跑 build 即生效。 */
function syncSkills() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dest = join(dshHome, 'skills')
  mkdirSync(dest, { recursive: true })
  let n = 0
  for (const entry of readdirSync(join(here, 'skills'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    rmSync(join(dest, entry.name), { recursive: true, force: true })
    cpSync(join(here, 'skills', entry.name), join(dest, entry.name), { recursive: true })
    n++
  }
  console.log(`[dsh-learnhub build] skills synced: ${n} -> ${dest}`)
}

for (const f of ['lib/index.js', 'lib/engine.js', 'lib/client.js']) {
  stripBlankLineTrailingWhitespace(join(here, f))
}
syncSkills()

console.log('[dsh-learnhub build] done: lib/index.js, lib/client.js')
