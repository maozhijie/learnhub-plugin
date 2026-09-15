# 单一诊断入口：doctor 并入 data-check 并整体退役

现状维护面有两个重叠的只读诊断入口：`dataCheck`（全库体检，输出 Missing/Broken/Archived/Hint 四类 finding + inventory）与 `doctor`（fm schema 对账，输出逐课程 `{total, notes, broken, missing, unknown}`）。实测两者的覆盖关系是**包含**：doctor 的 `missing`（图上有节点、无笔记）对上了 data-check 既有的 `note_missing`；`broken`（坏档）对上了 `note_frontmatter_missing`/`note_yaml_parse`/`note_schema`；`total`/`notes` 计数对上了既有 inventory 计数——只剩一格 `unknown`（有笔记、但笔记 frontmatter 的节点名不在图节点集内）独有。同时 `doctor` 没有任何产品入口：面板 UI 无调用方（`ui/src/api.ts` 有封装但零调用点），只有三个脚本/测试消费者（只读冒烟、端到端、时钟端口测试），而它的 `GET /doctor` 路由在行为快照里以一条 200 响应被「钉活」——快照是行为回归，不是可达性回归。

理由：同一件事有两份实现，就会有两份判据两个名字要维护者记；重叠格一旦各自修补就会漂移（`note_*` 与 `broken` 是同一批坏档的两种文案）。而 doctor 独有的那一格恰恰是数据体检的本职——笔记与图节点集的一次交叉对账，主场应该在笔记扫描里，而不是让维护者为了它去记第二个入口。

关键裁决：

- **孤儿笔记并入 `data-check`。** 笔记扫描新增一类 finding：`note_orphan` —— frontmatter 合法、但节点名不在图节点集内（节点改名/删除后的遗留）。判定在 `scanNotes` 内做，图节点名集由 `scanCourse` 传入（与终点锚悬空判定同一份数据）。定位到笔记路径 + 悬空节点名。
- **级别是 hint，不是 Broken。** 用户笔记是合法对象（可解析、可读出），孤儿是**状态**不是损坏——ADR-0004 的「用户笔记永不判 Broken」与 `note_source` 的漂移纪律同款：可见性归体检，处置归人工（删笔记或把节点改回图内）。hint 不进 status，故孤儿笔记不会把整库体检染成红色。
- **契约只增不改。** `DataCheckReport` 的既有字段与 finding 语义一字不动；doctor 的 `missing`/`broken` 不重复造——它们已由既有 `note_missing`/`note_*` 覆盖，消费方按需改用 inventory 计数。
- **doctor 整体退役，只留一个诊断入口。** 删除 `engine.doctor()`、命令声明 `doctor`、路由 `GET /doctor`、视图类型 `DoctorDoc`/`DoctorCourseReport`/`DoctorBrokenNote`、`ui/src/api.ts` 的 `api.doctor` 封装与 `ui/src/types.ts` 的 re-export、行为快照与路由基线里的 doctor 条目。
- **三个消费者迁到 `dataCheck()`。** `scripts/smoke.mjs`（只读冒烟）、`scripts/e2e.mjs`（写路径端到端）与新起的 `scripts/dev-server.mjs` 调试端点（`/data-check`）；哨兵作用不缩水——「跑得通 + 确定性输出」由 dataCheck 承接（e2e 断「笔记被盘点且无 Broken」，比只断形状更强）。
- **时钟端口测试改锚学习日。** 原断言锚在 `doctor.generated_at`（注入时刻的 ISO 渲染）。dataCheck 无时间戳字段，测试改锚 `recommend().date`（学习日 = 注入时刻按日界折算的本地日期）：同一固定时钟同输出、与真实时钟可区分，抽的是同一个端口。

边界：

- **不追溯、零数据迁移。** doctor 的输出不落盘、无机器消费方（脚本只断言形状），删除不产生存量兼容面。
- **`unknown` 格的唯一来源已被覆盖。** doctor 判 `unknown` 读的是 `stateMap` 的键集（课程目录下全部合法笔记），与被删后的 `scanNotes` 同一遍历口径；故迁移是等价替换，不是新判据。
- **课程目录里的非节点 markdown 也会报孤儿**（hint 级，不阻断）——这是与 doctor 同口径的已知边界：判定只做「名字在不在图上」，不猜文件是不是「故意放的」。
- **frontmatter 坏档不算孤儿。** 坏档仍走既有 `note_frontmatter_missing`/`note_yaml_parse`/`note_schema`（Broken），孤儿检查只作用于「能读出合法 frontmatter」的笔记。

替代方案（否决）：

- **保留 doctor、只删它的面板路由**——重叠入口的问题没解决（引擎方法、视图类型、快照条目继续养着），且「声明即产品面」这条纪律要的正是把无入口的路由连声明一起删掉。
- **孤儿笔记判 Broken 级**——与 ADR-0004「用户笔记永不判 Broken」直接冲突：笔记可解析、只是引用的节点不在图上；判 Broken 会让一次节点改名把整课笔记染红。
- **给 dataCheck 补一个 `generated_at` 以保住原时钟测试锚点**——为一个只读体检加无消费方的字段，并且它会破坏该测试自己的主题：体检输出带时钟戳后，「同输入同输出」的确定性断言就永远差一个字段。

取号：0081（合入主检出时顺延：0080 已被 #253「调试日志」占用）。票面：#255（父 #254）。
