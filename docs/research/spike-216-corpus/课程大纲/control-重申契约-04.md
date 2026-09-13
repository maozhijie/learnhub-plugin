---
station: 课程大纲
arm: control
variant: 重申契约
run: 4
tool_called: false
delivered: true
schema_ok: true
input_tokens: 153
output_tokens: 1973
duration_ms: 10922
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4338 字符，变体后缀=有）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：为什么需要给数据起名字
    type: 概念
    points: 从重复出现、容易写错的数据出发，引出变量就是给一份数据起的名字，让同一内容可以被反复指代。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：变量是一个名字，指向一份内容
    type: 概念
    points: 区分「名字」与「名字所指的内容」：变量本身不是数据，而是找到那份数据的入口。
    tier: 低
    visual: 示意图
  - id: s3
    title: 概念：变量名的规则与可读性
    type: 概念
    points: 变量名要机器能接受、人也能一眼看懂；对比宽泛名字与具体名字在阅读时的差别。
    tier: 中
    visual: 示意图
  - id: s4
    title: 练习：辨认变量、判断名字好坏与起名
    type: 练习
    points: 在若干小场景中找出哪些名字在指代数据，判断名字是否表意清晰，并给一段描述起一个合适变量名。
    tier: 中
    visual: 无
  - id: s5
    title: 思维：读到一个变量名时，专家在问什么
    type: 思维
    points: 展示专家看到变量名时的检查顺序：它此刻代表哪份内容、名字是否说清了这份内容、换一处还读得懂吗。
    tier: 高
    visual: mermaid
