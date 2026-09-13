---
station: 课程大纲
arm: control
variant: 现状
run: 8
tool_called: false
delivered: true
schema_ok: true
input_tokens: 134
output_tokens: 1730
duration_ms: 9784
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4303 字符，变体后缀=无）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：变量是给值起的名字
    type: 概念
    points: 从"每次要用都得重新写一遍那个数"的麻烦出发，引出变量本质是给一个值贴上的名字标签，用它可以代替那个值出现。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：同一个名字先后指向不同的值
    type: 概念
    points: 名字指向的内容可以换——同一个名字先代表 3、后来代表 7，理解"变"的是指向关系，不是那个 3 本身。
    tier: 低
    visual: mermaid
  - id: s3
    title: 概念：类型属于值，不属于名字
    type: 概念
    points: 破除"变量是个装东西的盒子、盒子有类型"的直觉，看清名字本身不带类型，类型是它此刻指向的那个值自带的。
    tier: 中
    visual: 示意图
  - id: s4
    title: 交互：亲手追踪一个名字每一刻指向谁
    type: 交互
    points: 在逐步执行的模拟里预测每一步之后名字指向的值，用即时反馈把"追踪变量"变成可操作的动作。
    tier: 中
    visual: 交互
  - id: s5
    title: 练习：猜取值与判断起名规则
    type: 练习
    points: 用若干小题综合检验三件事：名字此刻指向什么、换指向后旧值会怎样、哪些名字能被使用。
    tier: 中
    visual: 无
