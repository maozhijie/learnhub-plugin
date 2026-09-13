---
station: 课程大纲
arm: control
variant: 重申契约
run: 1
tool_called: false
delivered: true
schema_ok: true
input_tokens: 153
output_tokens: 4860
duration_ms: 25303
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
    points: 变量是给数据起的名字，让程序不必反复写具体值。
    tier: 低
    visual: mermaid
  - id: s2
    title: 概念：变量是名字指向值
    type: 概念
    points: 变量不是值本身，而是“名字—值”的绑定；名字不变，指向的值可以改变。
    tier: 中
    visual: 示意图
  - id: s3
    title: 演示：追踪同一个名字的指向变化
    type: 演示
    points: 用时间线展示一个变量名先后指向不同值，体会“可变”的含义。
    tier: 中
    visual: mermaid
  - id: s4
    title: 练习：辨认变量名、当前值与绑定
    type: 练习
    points: 在生活化片段中判断哪个名字是变量、它当前指向什么值、是否可重新指向。
    tier: 中
    visual: 无
