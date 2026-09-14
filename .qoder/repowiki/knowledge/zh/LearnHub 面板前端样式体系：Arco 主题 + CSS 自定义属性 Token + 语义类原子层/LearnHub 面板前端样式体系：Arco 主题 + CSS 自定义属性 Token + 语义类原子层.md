---
kind: frontend_style
name: LearnHub 面板前端样式体系：Arco 主题 + CSS 自定义属性 Token + 语义类原子层
category: frontend_style
scope:
    - '**'
source_files:
    - ui/src/tokens.css
    - ui/src/global.css
    - ui/vite.config.ts
    - ui/package.json
    - tests/ui-budget.test.ts
---

## 1. 系统与方法

LearnHub 面板前端（`ui/`）采用 **React + Vite** 构建，UI 组件基于 **@arco-design/web-react** 设计系统，但并未直接使用 Arco 的样式覆盖机制，而是通过自建 **CSS 自定义属性 token 层**（`tokens.css`）与 **语义 class 原子层**（`global.css`）来统一视觉风格。页面内容渲染使用 `react-markdown` + `rehype-katex` / `remark-math` / `remark-gfm`，并通过 `mermaid`、`echarts`、`mafs`、`katex` 等库渲染数学公式、图表与流程图。

Vite 配置 (`vite.config.ts`) 将产物输出到 `../web/dist`，`base: './'` 使资源引用为相对路径，由宿主 dsh web 以 `/learnhub/*` 前缀伺服，运行在 iframe 中。

## 2. 关键文件

- `ui/src/tokens.css`：设计 token 定义层，声明间距（4px 基尺）、字号阶梯、圆角、动效、亮/暗双主题语义变量（`--lh-bg`、`--lh-surface`、`--lh-border`、`--lh-text`、`--lh-accent` 等），所有值映射到 Arco 调色板变量（`color-bg-*`、`color-text-*`、`color-primary-*` 等），暗色模式通过 `body[arco-theme='dark']` 切换。
- `ui/src/global.css`：全局壳规则 + 语义 class 原子层（`.lh-*`）。包含 App Shell、顶栏、今日页、Markdown 正文排版（`.md-body`）、富内容块、日历热力图、调用提示框（`.lh-callout-*`）、卡片、网格布局等；注释明确标注“#211 内联 style 收敛”后的语义类词汇表。
- `tests/ui-budget.test.ts`：**强制执法**文件，实现三项门：① 单文件 ≤500 行硬预算；② 壳级视觉纪律门（`App.tsx`、`ShellTopBar.tsx`、`ZoneBody.tsx`、`HelpDrawer.tsx` 禁止 hex/rgb/rgba 硬编码色值与 `style={{…}}` 内联样式）；③ 页面内联 style 仅允许动态值（当前登记 31 处，全部为进度条宽度、按数据着色等动态场景），并校验 `.lh-*` 引用 ↔ 定义对账。
- `ui/package.json`：依赖声明，核心 UI 栈为 React 18 + Arco Design 2.66 + Vite 6。
- `ui/vite.config.ts`：构建配置，产物直出至 `web/dist`，供 dsh host 静态托管。

## 3. 架构与约定

### 分层模型（自底向上）
1. **Token 层** (`tokens.css`)：唯一合法存放色值与尺寸常量的位置，使用 CSS 自定义属性（`--lh-*`），绑定 Arco 主题变量，亮/暗主题自动跟随。
2. **语义 class 原子层** (`global.css` 下半段)：以 `.lh-` 前缀命名的原子类，如 `.lh-t-16`（字号）、`.lh-gap-8`（间距）、`.lh-w-160`（宽度）、`.lh-card`、`.lh-callout-info`、`.lh-quote` 等，命名即值，声明与迁移前的内联样式逐条等价。
3. **壳级规则** (`global.css` 上半段)：App Shell、顶栏、子导航、视图保活容器、Markdown 正文排版等布局级样式，只消费 `--lh-*` token。
4. **组件层** (`ui/src/components/*.tsx`)：React 组件组合语义 class 与 Arco 组件，不直接写颜色或布局尺寸。

### 主题策略
- 亮/暗双主题通过 Arco 的 `body[arco-theme='dark']` 切换，token 层把 `--lh-*` 别名到 Arco 的 `color-*` 变量，因此无需维护第二套色值。
- 注释强调 token 必须声明在 `body` 而非 `:root`，因为 CSS 自定义属性在声明元素处替换，挂在 `:root` 会导致暗色切换失效。

### 响应式策略
- 未引入媒体查询断点，主要依靠 Flexbox/Grid 自适应（`.lh-grid-cards`、`.lh-grid-stats` 使用 `repeat(auto-fill, minmax(...))`）。
- 特定容器用视口高度兜底（如 `.dag-wrap` 的 `calc(100vh - 230px)`、`.lh-h-viewport-120`）。

### Markdown 内容排版
- `.md-body` 统一阅读排版：正文 16px/1.8 行高，限宽 680px（≈40 字/行），标题层级 20/18/17/16 拉开，代码块、表格、blockquote、MathJax/KaTeX 公式、Mermaid/SVG 图表均做独立适配。
- 支持 quiz 反馈专用变体 `.md-body.quiz-feedback`（字号收一档，读起来不挤）。

## 4. 约定与约束（含强制执行项）

| 约定 | 说明 | 执行方式 |
|---|---|---|
| 色值只许住在 token 层 | 壳级组件（App、ShellTopBar、ZoneBody、HelpDrawer）禁止出现 hex/rgb/rgba 硬编码色值 | `tests/ui-budget.test.ts` 扫描 shell 文件，匹配 `#[0-9a-fA-F]{6}`、`rgba?(` 即失败 |
| 壳级布局一律语义类化 | 壳级组件禁止 `style={{…}}` 内联样式 | 同上测试门扫描 `style=\{` |
| 页面内联 style 仅允许动态值 | 静态样式必须迁入 `global.css` 的 `.lh-*` 原子类；当前登记 31 处动态站点（进度条宽度、按数据着色等） | 测试门解析每个 `style={{…}}` 块，判断值是否为纯字面量；同时校验站点总数恒等于 31 |
| `.lh-*` 类名必须合法且已定义 | 类名只能含 `[a-z0-9-]`，且必须在 `global.css` 有对应定义 | 测试门双向对账：扫描 `.tsx` 中的 `className` 引用的 `.lh-*`，检查是否匹配正则且存在于 CSS 定义集合 |
| 单文件规模预算 | `ui/src` 下任意 `.tsx/.ts` 文件不超过 500 行 | 测试门递归扫描，超线即失败 |
| 主题切换生效 | token 必须声明在 `body` 上而非 `:root` | 代码注释作为规范约束 |
| 构建产物相对路径 | `base: './'`，产物输出到 `../web/dist` | Vite 配置固定 |

该体系的核心思想是：**Arco 提供主题变量，项目通过 `--lh-*` 语义别名 + `.lh-*` 原子类建立稳定契约，所有视觉变更集中在 token 与原子层，组件保持无样式语义**。