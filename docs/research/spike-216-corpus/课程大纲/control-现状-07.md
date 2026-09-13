---
station: 课程大纲
arm: control
variant: 现状
run: 7
tool_called: false
delivered: true
schema_ok: true
input_tokens: 134
output_tokens: 2692
duration_ms: 14143
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4303 字符，变体后缀=无）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：变量就是给数据起的名字
    type: 概念
    points: 变量是一个名字，用来指代某个具体的数据，好让我们不必每次都把那份数据原样重写一遍。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：名字是标签，值是内容
    type: 概念
    points: 变量名本身只是一串字符，它「指向」的那个值才是真正的数据；两者是两样东西，不能混为一谈。
    tier: 低
    visual: mermaid
  - id: s3
    title: 演示：把散落各处的同一个数字收进一个名字
    type: 演示
    points: 通过一张账单的前后对比，看清「数据写死在多处」与「数据只出现一次、其余地方用名字指代」的差别。
    tier: 中
    visual: 示意图
  - id: s4
    title: 思维：起名时，熟练的人在心里问自己什么
    type: 思维
    points: 走一遍命名时的自问清单——这个名字说的是「里面的东西是什么」，还是只说了「它长什么样」？
    tier: 中
    visual: mermaid
  - id: s5
    title: 练习：分清名字与值，挑出说得清楚的名字
    type: 练习
    points: 在若干片段里指出哪个是名字、哪个是值，并为一组数据选出更合适的变量名。
    tier: 中
    visual: 无
