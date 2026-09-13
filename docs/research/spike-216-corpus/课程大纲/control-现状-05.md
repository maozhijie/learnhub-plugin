---
station: 课程大纲
arm: control
variant: 现状
run: 5
tool_called: false
delivered: true
schema_ok: true
input_tokens: 134
output_tokens: 2599
duration_ms: 13495
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4303 字符，变体后缀=无）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：为什么需要变量——给值起个名字
    type: 概念
    points: 从「同一个数字在多处重复、一改就要改很多地方」的具体麻烦出发，引出「给值起个名字」的需求。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：变量是「名字 → 值」的绑定
    type: 概念
    points: 变量就是程序里的一个带名字的位置，读这个名字就等于读到它当前指向的那个值。
    tier: 低
    visual: 示意图
  - id: s3
    title: 概念：为什么叫「变」量——名字固定、值可替换
    type: 概念
    points: 名字不变而值可以换，这是变量与常量、也与数学里待求解的未知数 x 的分界。
    tier: 中
    visual: mermaid
  - id: s4
    title: 演示：跟着执行看同一个名字里的值被替换
    type: 交互
    points: 逐步执行一小段伪代码，观察名字背后的值随执行推进而变化，建立「变量随时间流动」的动态直觉。
    tier: 中
    visual: 交互
  - id: s5
    title: 练习：判断谁是变量，并给变量起名
    type: 练习
    points: 用「名字是否指向一个会变化的值」判断变量，并写出符合直觉、读得懂的变量名。
    tier: 中
    visual: 无
