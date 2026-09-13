---
station: 课程大纲
arm: control
variant: 重申契约
run: 2
tool_called: false
delivered: true
schema_ok: true
input_tokens: 153
output_tokens: 2112
duration_ms: 11040
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4338 字符，变体后缀=有）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：为什么要给数据起名字
    type: 概念
    tier: 低
    visual: 示意图
    points: 从"记住一串数字很难、给它贴上名字就容易"的日常经验出发，引出变量存在的理由——名字让人能反复指认同一个数据。
  - id: s2
    title: 概念：变量 = 一个名字 + 此刻装着的值
    type: 概念
    tier: 中
    visual: mermaid
    points: 变量由两部分构成：一个固定的名字和一个当前的值；名字是入口，值是内容，两者不是一回事。
  - id: s3
    title: 演示：名字不变，值可以换——"变"字从哪来
    type: 演示
    tier: 中
    visual: 示意图
    points: 沿时间看同一个变量：名字始终是那个名字，值却可以是不同时刻的不同内容，"变"指的是值在变。
  - id: s4
    title: 交互：拨动时间轴，看这个变量此刻是什么
    type: 交互
    tier: 中
    visual: 交互
    points: 亲手操作一个变量随时间演变的模拟器，回答"这一刻它是什么"，把名字与值的分离变成手上的直觉。
  - id: s5
    title: 练习：分清名字与值，说出每一刻它的内容
    type: 练习
    tier: 高
    visual: 无
    points: 用三道小题辨认一个变量的名字、当前值，以及变化前后它分别是什么，巩固本课建立的直觉模型。
