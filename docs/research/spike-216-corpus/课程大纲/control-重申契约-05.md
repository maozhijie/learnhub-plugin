---
station: 课程大纲
arm: control
variant: 重申契约
run: 5
tool_called: false
delivered: true
schema_ok: true
input_tokens: 153
output_tokens: 2859
duration_ms: 14983
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4338 字符，变体后缀=有）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：为什么值需要一个名字
    type: 概念
    points: 从"直接写死的值"到"给值起个名字"，看清变量要解决的第一个问题——让人能稳定地指代同一个值。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：变量 = 名字 + 值
    type: 概念
    points: 一个变量由可读的名字和一个当下的值组成，名字负责被指代，值负责被使用，两者可以分开讨论。
    tier: 低
    visual: 示意图
  - id: s3
    title: 演示：同一个名字，前后装着不同的值
    type: 演示
    points: 沿着时间轴看同一个名字（如 age）在三个时刻分别装着什么，理解"变"量到底"变"的是值而不是名字。
    tier: 中
    visual: 示意图
  - id: s4
    title: 交互：亲手摆放名字和值
    type: 交互
    points: 在模拟器里自己输入名字、放入值、再换一个值，观察盒子（名字）不动、内容（值）改变，动手建立变量的直觉。
    tier: 中
    visual: 交互
  - id: s5
    title: 练习：辨一辨名字、值与盒子
    type: 练习
    points: 用三组小判断区分"这是名字还是值""这里变的是谁""同一个值能不能有第二个名字"，把直觉固化成能说清的判断。
    tier: 中
    visual: 无
