---
station: 课程大纲
arm: control
variant: 重申契约
run: 7
tool_called: false
delivered: true
schema_ok: true
input_tokens: 153
output_tokens: 1456
duration_ms: 7899
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4338 字符，变体后缀=有）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：给一个值起名字
    type: 概念
    points: 变量就是贴在某个值上的一张名字标签，让你之后用名字代替值来反复引用，改动时只动一处。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：名字指向的值可以变
    type: 概念
    points: 变量的"值"不是刻死的，同一个名字在不同时刻可以指向不同的值；变量描述的是名字与当前值的绑定关系。
    tier: 低
    visual: mermaid
  - id: s3
    title: 演示：改一处，处处生效
    type: 演示
    points: 当同一份数据在多处被用到时，用名字引用能让你只改一处、其余自动跟随，这正是变量省力的核心价值。
    tier: 中
    visual: 图表
  - id: s4
    title: 思维：编程变量不是代数未知数
    type: 思维
    points: 代数里的 x 是一个待解的固定答案，编程里的变量是一个可被反复装入新值的容器，两者的思维方式要区分开。
    tier: 中
    visual: 示意图
  - id: s5
    title: 练习：追踪名字背后的值
    type: 练习
    points: 给定一串"名字被装入新值"的变化，逐步追踪每个名字当前指向的值，检验你建立的变量心智模型。
    tier: 中
    visual: 交互
