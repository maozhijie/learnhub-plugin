---
kind: build_system
name: dsh-learnhub 插件构建系统：esbuild + Vite 双产物管线与 skills 同步
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - build.mjs
    - ui/package.json
    - ui/vite.config.ts
    - tsconfig.json
    - scripts/link-peers.mjs
    - scripts/gen-smoke.mjs
    - scripts/spike.mjs
    - scripts/e2e.mjs
    - cordis.patch.yml
---

## 1. 使用的系统与工具

本仓库是一个 DeepSeek Harness (dsh) 插件包，采用 **Node.js + TypeScript** 工程，通过两个并行的前端/后端构建器产出可分发产物：

- **服务端（cordis 插件）**：使用 `esbuild`（`node build.mjs`）将 `src/index.ts`、`src/engine/index.ts`、`src/client/index.tsx` 分别打包为 `lib/index.js`、`lib/engine.js`、`lib/client.js`。目标平台 `node22` / `es2022`，输出 ESM（客户端 CJS），启用 sourcemap。
- **Web 面板（React SPA）**：子目录 `ui/` 是独立的 Vite 项目，`vite.config.ts` 将产物输出到根 `web/dist/`，由 dsh host 直接以 `/learnhub/*` 静态资源形式伺服。
- **类型检查**：根 `tsconfig.json` 开启 `strict: true`、`noEmit: true`，作为“类型门”基线；`scripts/arch-baseline.mjs` 与 `scripts/scan-ui-types.mjs` 配合实现逐批压降错误数的棘轮机制。
- **测试运行器**：基于 Node 原生 `node:test`，通过 `--experimental-transform-types` 直接执行 `.test.ts`，并发度 `3`。
- **依赖管理**：pnpm store（`.pnpm-store/`）+ `package-lock.json` 共存；peerDependencies 声明 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-*` 等宿主运行时依赖，部分标记 optional。

## 2. 关键文件

- `package.json`：顶层入口，定义 `build`/`check`/`prepare`/`smoke`/`spike`/`quality-review`/`prompt-bump`/`typecheck`/`test` 脚本，以及 `dsh.bundle.patch`、`dsh.client.platform=web` 的插件元数据。
- `build.mjs`：核心构建编排脚本，串联 UI 构建、vendor 拷贝、esbuild 三产物、空白行清洗、skills 同步。
- `ui/package.json` + `ui/vite.config.ts`：Vite React 配置，`base: './'` 适配 `/learnhub` 前缀路由，`outDir: '../web/dist'`。
- `tsconfig.json`：严格模式类型门，仅 include `src/`，client JSX 保留由宿主注入。
- `scripts/*.mjs`：工程脚本集合（arch-baseline、link-peers、gen-smoke、spike、e2e、质量审查、迁移、冒烟等）。
- `cordis.patch.yml`：随 bundle 分发的 Cordis 补丁清单。
- `skills/*/SKILL.md`：技能规范，构建时复制到 `<DSH_HOME>/skills/`。

## 3. 架构与约定

### 构建流水线顺序（`npm run build` → `node build.mjs`）

1. **UI 构建**：若 `ui/node_modules` 不存在则自动 `npm install --no-fund --no-audit`，然后调用 `vite build` 产出 `web/dist/`。对 HTML/JS/CSS/SVG 等文本产物统一 CRLF→LF 并去除行尾空白，避免 whitespace 门禁失败。
2. **Vendor 拷贝**：从 `ui/node_modules/katex` 和 `three` 复制 `katex.min.css/js/auto-render`、`three.module.js/core.js/OrbitControls.js` 及 `.woff2` 字体到 `web/vendor/`，供沙箱 CSP 下同源加载。
3. **esbuild 打包**：
   - `src/index.ts` → `lib/index.js`（服务端 cordis 插件，ESM，target node22）
   - `src/engine/index.ts` → `lib/engine.js`（独立引擎产物，供冒烟/脚本消费）
   - `src/client/index.tsx` → `lib/client.js`（浏览器侧 CJS，包裹在 `window.__ModuleLoader__.load` 握手协议中）
   - 外部依赖白名单 `NODE_EXTERNALS = ['@deepseek-ai/*', 'node:*', '@open-spaced-repetition/*']`，native `.node` 二进制不打包，运行时动态 import。
4. **空白行清洗**：对三个 lib 产物去除纯空白行的行首缩进，满足 whitespace 门禁。
5. **Skills 同步**：读取环境变量 `DSH_HOME`（默认 `~/.dsh`），将 `skills/*` 真实目录复制到 `$DSH_HOME/skills/`，覆盖旧版本。这是 skill-filesystem 扫描根的唯一来源。

### 产物发布面

`package.json.files` 仅包含 `lib`、`web`、`cordis.patch.yml`、`README.md`，即 npm 包只分发编译后的 JS 与静态资源，源码不随包发布。

### 开发工作流

- `npm run prepare` 执行 `scripts/link-peers.mjs`，在本地建立 peer 依赖链接。
- `npm run typecheck` 先跑 arch-baseline 再 scan-ui-types，确保类型错误数不反弹。
- `npm test` 先 typecheck，再以并发 3 运行所有 `tests/*.test.ts`。
- `npm run smoke` / `spike` / `quality-review` 分别触发冒烟、spike 重算、质量审查流程。

## 4. 约定与约束

- **Node 版本要求**：`engines.node >= 22`，构建 target 固定为 `node22` / `es2022`。
- **类型门棘轮**：`tsconfig.json` 注释明确 `tsc --noEmit` 按文件错误数棘轮，基线必须精确匹配且只能下调，禁止新增类型错误。
- **CSP 安全边界**：交互件库（katex/three）必须经 `web/vendor/` 同源提供，构建期缺失源文件会抛错而非静默跳过。
- **客户端模块加载契约**：`lib/client.js` 必须以 `window.__ModuleLoader__.load({ id: 'dsh-learnhub', factory })` 格式导出，react/react-dom 保持 external 由宿主提供。
- **Native 模块隔离**：`@open-spaced-repetition/*` 等 native binding 不可被 esbuild 打包，调用点集中在 `src/engine/optimize.ts` 内隔离。
- **无 CI/Dockerfile**：仓库未包含 GitHub Actions、Dockerfile 或 Makefile；构建与测试完全通过 `npm scripts` + Node 原生 runner 驱动，依赖 pnpm store 缓存加速安装。
- **Windows 兼容性**：构建脚本显式处理 CRLF→LF 转换，说明该流水线需在 Windows 工作副本上稳定运行。
