---
station: 课程大纲
arm: control
variant: 重申契约
run: 3
tool_called: false
delivered: true
schema_ok: true
input_tokens: 153
output_tokens: 1693
duration_ms: 9358
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4338 字符，变体后缀=有）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：变量是给数据起的名字
    type: 概念
    points: 变量不是数据本身，而是你给某份数据起的名字，之后用这个名字来指代它。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：名字与值是两回事
    type: 概念
    points: 名字和值分属两层——名字保持不变，它所指的值可以换；同一个值也可以被多个名字同时指着。
    tier: 低
    visual: mermaid
  - id: s3
    title: 演示：一行行看一个变量的值怎么变
    type: 演示
    points: 跟着程序逐行执行，观察同一个名字在不同时刻指向不同的值，以及旧值会怎样被"遗忘"。
    tier: 中
    visual: mermaid
  - id: s4
    title: 交互：给数据起名字并追踪它的值
    type: 交互
    points: 亲手创建变量、改变它所指向的值，实时看到"名字—值"这张对照表如何随之更新。
    tier: 中
    visual: 交互
  - id: s5
    title: 概念：为什么非要给数据起名字
    type: 概念
    points: 变量让同一份数据可以反复使用、让修改只发生在一个地方、让代码能被别人（和未来的自己）读懂。
    tier: 中
    visual: mermaid
