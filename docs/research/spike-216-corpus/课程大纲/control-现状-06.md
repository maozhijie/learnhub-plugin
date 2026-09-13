---
station: 课程大纲
arm: control
variant: 现状
run: 6
tool_called: false
delivered: true
schema_ok: true
input_tokens: 134
output_tokens: 3238
duration_ms: 15768
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4303 字符，变体后缀=无）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：变量是「会变的那个名字」
    type: 概念
    points: 从气温、余额、比分这些日常例子入手，先建立直觉——同一个名字后面挂着的值会随时间改变。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：名字、当前值、可变——变量的三要素
    type: 概念
    points: 一个变量由三件事构成：一个可称呼的名字、此刻装着的值、以及随时能被换成新值的性质。
    tier: 低
    visual: 示意图
  - id: s3
    title: 概念：变量不是等着被求出的未知数
    type: 概念
    points: 澄清与数学里 x 的关键差别：变量的值不是谜题答案，而是某个时刻确实装在那里的东西。
    tier: 中
    visual: mermaid
  - id: s4
    title: 交互：亲手把一个变量从 0 推到 10
    type: 交互
    points: 在交互件里一次次改变同一个变量的值，盯住「名字不变、值在换」，把当前值的概念变成手感。
    tier: 中
    visual: 交互
  - id: s5
    title: 练习：认出变量，说出它的当前值
    type: 练习
    points: 在若干生活与代码片段场景中判断谁在变化、它此刻装着什么值、哪个名字其实并不变。
    tier: 中
    visual: 示意图
