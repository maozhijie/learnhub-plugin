---
station: 课程大纲
arm: control
variant: 重申契约
run: 8
tool_called: false
delivered: true
schema_ok: true
input_tokens: 153
output_tokens: 1688
duration_ms: 9133
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4338 字符，变体后缀=有）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：变量是给数据贴的标签
    type: 概念
    points: 变量不是数据本身，而是一个名字——名字挂在那块数据上，之后叫名字就等于叫那份数据。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：名字、值、类型——变量的三要素
    type: 概念
    points: 每个变量由三样东西构成：叫得出的名字、装着的值、以及值属于哪一类（数字/文本/真假）。
    tier: 低
    visual: mermaid
  - id: s3
    title: 演示：值会换，名字不变
    type: 演示
    points: 同一名字先后指向不同的值，旧值被顶掉——「变」字的由来；名字是固定的，指向的东西是可换的。
    tier: 中
    visual: 示意图
  - id: s4
    title: 练习：读一段小程序，报出每个变量的名字、值与类型
    type: 练习
    points: 三道由易到难的读数题，练「看到名字立刻说出它此刻指向什么、是什么类型」。
    tier: 中
    visual: 无
  - id: s5
    title: 思维：高手读代码时，脑子里开着一张变量表
    type: 思维
    points: 逐行跟踪一段小程序的变量表变化，展示老手不背代码、只维护「此刻谁指向什么」的思考轨迹。
    tier: 高
    visual: mermaid
