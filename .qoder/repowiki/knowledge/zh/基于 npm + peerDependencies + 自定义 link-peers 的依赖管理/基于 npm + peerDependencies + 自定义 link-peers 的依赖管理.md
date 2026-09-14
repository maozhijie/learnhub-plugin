---
kind: dependency_management
name: 基于 npm + peerDependencies + 自定义 link-peers 的依赖管理
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - scripts/link-peers.mjs
    - build.mjs
    - ui/package.json
    - ui/package-lock.json
    - cordis.patch.yml
---

## 1. 使用的系统/工具

- **包管理器**：npm（根 `package.json` + `package-lock.json`，前端子工程 `ui/package.json` + `ui/package-lock.json`）。
- **构建器**：esbuild（根 `build.mjs` 将 `src/` 打包为 `lib/index.js`、`lib/engine.js`、`lib/client.js`），Vite（`ui/` 子工程独立构建 SPA）。pnpm store（`.pnpm-store/v11/`）存在但仓库未声明 pnpm 工作区，实际以 npm 为主。
- **宿主集成**：通过 dsh profile 的 `link:` 安装方式，插件作为 DeepSeek Harness 的 dsh 插件发布与消费。

## 2. 关键文件

- `package.json`：定义插件名 `dsh-learnhub`、`peerDependencies`（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-schedule`、`@deepseek-ai/dsh-time-context`、`@deepseek-ai/dsh-tools`）、`devDependencies`（`typescript`、`esbuild`、`@types/node`）以及运行时依赖 `ts-fsrs`、`yaml`、`@open-spaced-repetition/binding`。
- `package-lock.json`：锁定所有 npm 解析到的依赖版本，来源指向 `registry.npmjs.org`。
- `scripts/link-peers.mjs`：在 `npm install` 的 `prepare` 钩子中运行，把 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools` 两个私有 peer 以 Windows `mklink /J` 硬链接形式注入到本仓库 `node_modules/@deepseek-ai/` 下。
- `build.mjs`：构建脚本，声明 `NODE_EXTERNALS = ['@deepseek-ai/*', 'node:*', '@open-spaced-repetition/*']`，将这些模块保持 external 不打包进产物；同时从 `ui/node_modules` 拷贝 katex/three 到 `web/vendor` 随插件分发。
- `ui/package.json`：前端面板的独立依赖声明（React、Arco Design、ECharts、Mermaid、KaTeX 等），由 `build.mjs` 首次构建时自动执行 `npm install --no-fund --no-audit`。
- `cordis.patch.yml`：通过 `dsh.bundle.patch` 字段声明 Cordis 补丁，随插件一起发布。

## 3. 架构与约定

- **peerDependencies 模式**：插件自身不安装 `@deepseek-ai/*` 系列运行时依赖，而是声明为 peer，由宿主（DSH）提供。`peerDependenciesMeta` 将 `dsh-llm`、`dsh-tools`、`dsh-schedule`、`dsh-time-context` 标记为 optional，使插件在无这些宿主能力时仍可被安装。
- **私有 peer 的“junction”注入**：因为 Node 按 realpath 解析 peer，`link-peers.mjs` 优先查找环境变量 `DSH_MONOREPO` 指向的 monorepo 检出，否则扫描 `%LOCALAPPDATA%/npm-cache/_npx/<hash>/node_modules/@deepseek-ai/dsh` 找到 npx 缓存中的 dsh，再将其内部的 `dsh-llm`、`dsh-tools` 以 `mklink /J` 硬链接到本仓库 `node_modules/@deepseek-ai/`。这样插件代码 `import ... from '@deepseek-ai/dsh-llm'` 能解析到宿主实际加载的同份实现。
- **外部化策略**：`build.mjs` 用 esbuild 的 `external` 配置把 `@deepseek-ai/*`、`node:*`、`@open-spaced-repetition/*` 排除出 bundle，避免重复打包宿主已提供的模块；客户端产物 `lib/client.js` 额外把 `react`、`react-dom`、`react/jsx-*`、`scheduler` 也 external，由宿主模块系统提供。
- **vendor 资源复制**：katex 与 three 的 JS/CSS/字体通过 `copyVendor()` 从 `ui/node_modules` 复制到 `web/vendor`，由 host 经 `/learnhub/api/vendor/*` 同源伺服，沙箱 CSP 放开 `'self'` 后交互件仅能从此处取库。
- **技能随构建安装**：`skills/*` 目录在构建时被递归复制到 `<DSH_HOME>/skills/`（默认 `~/.dsh/skills`），这是 skill-filesystem 的内置扫描根，无需任何配置即对所有 dsh 会话可见。

## 4. 约定与约束

- **Node 版本约束**：`engines.node >= 22`，构建目标 `target: ['node22']`，确保 ESM-only 行为一致。
- **依赖版本锁定**：根级使用 `package-lock.json` 锁定所有 npm 依赖；前端 `ui/` 使用独立的 `package-lock.json` 隔离 UI 依赖树。
- **私有依赖必须可解析**：`link-peers.mjs` 要求先执行 `npx @deepseek-ai/dsh --version` 让 npx 缓存好 dsh，或设置 `DSH_MONOREPO` 环境变量，否则会在 `prepare` 阶段输出警告并跳过链接。
- **native 二进制不可打包**：`@open-spaced-repetition/binding` 等含 `.node` 原生模块必须保留在运行时 `node_modules` 中动态 import，构建脚本明确将其 external。
- **UI 依赖首次构建自动安装**：`build.mjs` 检测 `ui/node_modules` 不存在时自动执行 `npm install --no-fund --no-audit`，保证干净克隆也能构建。
- **行尾空白清理**：构建过程中对 `web/dist` 和 `lib/*.js` 执行 CRLF→LF 转换与行尾空白去除，以通过 whitespace 门禁。
- **无全局 .npmrc / 私有 registry 配置**：仓库未发现 `.npmrc`、`.npmrc.local` 或 CI 中覆盖 registry 的配置，所有依赖均从 npm 官方源解析。