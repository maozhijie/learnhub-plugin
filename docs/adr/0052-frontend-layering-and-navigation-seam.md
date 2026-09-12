# 前端分层与导航缝：四层目录、500 行预算、自研 hash 路由缝

#187 规格会（2026-09-12）对前端架构的五项裁决中，三项属架构级——分层、导航、lint 安置——本 ADR 记录之；语义级裁决（useCommand 语义包、design-system 边界、bundle 基线）留在 #187 票面。裁决前的事实：`ui/src` 40 文件平铺 `pages/` + `components/` 两层，纯逻辑混居 components/（md-chain 等 5 个 .ts），无共享 hooks 层（唯一自定义 hook 是 useCoachToasts）、无导航抽象（内存 `setTab`，刷新即回默认页签）、无 lint（react-hooks 规则零静态检查）。

关键裁决：

- **四层目标形状**：`lib/`（纯逻辑：零 DOM、零 React，node:test 可直测；md-chain／quiz-rules／svg-uri／settle-context 自 components/ 迁入；`md.ts` 54 行全仓零引用，删除）、`hooks/`（useCommand、usePolling 等共享行为钩子）、`pages/<Page>/`（页面条目 + 页内子组件就近，LearnPage 的 ReviewSession／NoteSourceDrawer 等天然分块依此落地）、`components/`（跨页组件与域渲染器，不动）。`api.ts`／`App.tsx`／`active-tab.ts`／`useCoachToasts.tsx` 位置不变。
- **单文件 500 行硬预算**：全目录统一。现存超线 4 文件（LearnPage 1292／StatsPage 821／LessonView 580／PracticeFlow 554）由 U1（#183）收敛；此后新超线须在票面登记理由（棘轮语义照 ADR-0047）。
- **导航缝 = 自研极简 hash 路由**（U3，#189）：`location.hash` 为导航状态权威（`#/learn` 式页签路由，参数段留形不实现），约 50 行零依赖 `lib/router.ts`（parseHash／navigate／onRouteChange），App 消费；`AppFrame.goto／openLesson／locateInGraph` 三个程序化跳转收口走它。刷新、前进后退、外链深链自此可用。裁决动因是"项目可能膨胀"的保险：**URL 方案即扩展契约**——将来需要嵌套路由时换真 router 库，URL 不变、消费方不变（全部经 AppFrame，页签组件零改动）。否决的替代：**引 react-router**（ADR-0051 第三层：~20kB gzip 运行时依赖换 50 行手写，现无嵌套需求，不值）；**维持纯内存**（零扩展性，刷新丢位置，深链永无）；**直接上完整路由方案**（10 个页签的现状复杂度不匹配）。
- **react-hooks 静态检查 = eslint + eslint-plugin-react-hooks**，ADR-0051 第二层首个许可实例：devDep 仅装 `ui/`、`npm run lint` 脚本、**不进门家族**（无自检义务）、不做任何风格 lint。与 ADR-0042 不冲突：那次否决的是"用 eslint 写 import 规则门"——文本扫描足够挽回的场景；hooks 规则（条件 hook、effect 依赖）必须 AST，是第二层的正当用例。

边界与后果：

- U3 是**行为票**：刷新保持页签、URL 反映状态是它的交付物——#187"结构票不改用户可见交互"的冻结对 U3 显式豁免；U1（#183）行为冻结不变，路由缝不进 U1。
- `active-tab.ts` 的模块信号与 `isActiveTab` 轮询门保持现状；U3 落地时改为从路由派生或桥接，取舍在该票票面登记。
- Exhibit A（立法动因的实证）：#158 的项目页签修复落地时漏了 `TAB_KEYS` 键项——按钮在、TabBody 分支在、键表缺，点击渲染空白，自 33e6b42 起从未生效，tsc／文本门／人工走查三层验收均未拦截（hotfix `a6fea08`）。"页签表完整性"自此是 U2 交互测试的必测项。
