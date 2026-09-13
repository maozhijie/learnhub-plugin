---
station: 课程大纲
arm: control
variant: 现状
run: 4
tool_called: false
delivered: true
schema_ok: true
input_tokens: 134
output_tokens: 2845
duration_ms: 15108
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4303 字符，变体后缀=无）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：为什么要把值装进名字
    type: 概念
    points: 从"同一个数字写在三处、改一次要改三处"这种具体麻烦出发，说明名字的作用是让一处改动管住全部引用。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：变量是贴了名字的位置，不是它此刻的值
    type: 概念
    points: 把变量理解成贴着标签的盒子——标签（名字）始终不变，盒子里装的东西（值）可以换掉，变量在任一时刻只对应一个当前值。
    tier: 中
    visual: 示意图
  - id: s3
    title: 交互：亲手拨动一个变量的值
    type: 交互
    points: 用点击/拖动让同一个名字先后指向不同的值，亲眼看到"名字没变、值在变"，把变量是位置而非值变成手感而不是记忆。
    tier: 中
    visual: 交互
  - id: s4
    title: 概念：名字是留给未来的自己的线索
    type: 概念
    points: 名字的好坏取决于"几周后的自己能否一眼看懂它装的是什么"，并据此区分会变的值与固定不变的值（常量）。
    tier: 中
    visual: 示意图
