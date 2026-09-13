---
station: 课程大纲
arm: control
variant: 重申契约
run: 9
tool_called: false
delivered: true
schema_ok: true
input_tokens: 153
output_tokens: 1669
duration_ms: 8825
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4338 字符，变体后缀=有）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：变量是给数据起的一个名字
    type: 概念
    points: 变量不是数据本身，而是你在代码里称呼某个数据的名字——就像给储物格贴上一张标签，名字是入口，数据才是被存的东西。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：名字和值是两码事
    type: 概念
    points: 名字（怎么写）与值（当前是什么）分属两层——同一时刻一个名字只对应一个当前值，而同一个当前值也可以被两个名字共同指到。
    tier: 中
    visual: mermaid
  - id: s3
    title: 演示：变量的值为什么会"变"
    type: 演示
    points: 用计分器逐帧演示 score 从 0 变成 10 再变成 25：名字始终没换，只是这个时刻它对应的当前值被换成了新的。
    tier: 中
    visual: svg
  - id: s4
    title: 思维：读代码时把变量替换成它此刻的值
    type: 思维
    points: 熟练读者的做法——看到变量名，先在脑中代入它此刻的当前值再往下读；这个"代入"习惯是后面赋值与读取的心智基础。
    tier: 高
    visual: mermaid
  - id: s5
    title: 练习：分清名字、当前值与变化
    type: 练习
    points: 三道小题分别考：名字与值的区分、同一时刻一个名字只有一个当前值、值可以被换成新值而名字不变。
    tier: 高
    visual: 无
