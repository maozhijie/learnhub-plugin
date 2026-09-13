---
station: 课程大纲
arm: control
variant: 重申契约
run: 6
tool_called: false
delivered: true
schema_ok: true
input_tokens: 153
output_tokens: 4424
duration_ms: 23213
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4338 字符，变体后缀=有）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：为什么需要变量——给数据一个名字
    type: 概念
    points: 变量用一个名字代表一个数据，避免重复记忆和重复书写原始值。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：变量的结构——名字标签与值盒子
    type: 概念
    points: 变量由标识符（名字）和当前存储的值构成；名字是访问值的入口，值才是数据本身。
    tier: 低
    visual: 示意图
  - id: s3
    title: 演示：变量的值可以更换——为什么叫“变”量
    type: 演示
    points: 同一个变量名在不同时刻可以对应不同的值，变量的“变”指的是所存数据可更新。
    tier: 中
    visual: 示意图
  - id: s4
    title: 练习：识别变量并为它们起名
    type: 练习
    points: 从场景中找出适合作为变量的量，写出合法变量名，并说明它当前代表什么值。
    tier: 中
    visual: 无
