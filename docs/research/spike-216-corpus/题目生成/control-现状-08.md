---
station: 题目生成
arm: control
variant: 现状
run: 8
tool_called: false
delivered: true
schema_ok: true
input_tokens: 176
output_tokens: 4585
duration_ms: 22102
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 5207 字符，变体后缀=无）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
questions:
  - id: q1
    kind: single_choice
    q: '下面关于变量的说法，正确的是'
    options:
      - '变量的名字稳定不变，而它代表的值可以随时刻改变'
      - '变量的名字随值一起变，值变一次名字就要换一次'
      - '同一个变量在同一时刻可以同时取两个不同的值'
      - '变量的值一旦写进名字，就再也不能重新赋值'
    answer: A
    explanation: |
      变量是给一个**会变的值**起的名字，所以名字稳定、值随时可变，A 正确。
      早上余额 $50$ 元、晚上余额 $20$ 元，是同一个名字在不同时刻的取值：
      $$余额:\ 50 \rightarrow 20$$
      最易错点：把「值会变」错记成「名字也会变」，其实换的是值，不是名字。
    difficulty: 1
    section: 概念：变量是什么
    invokes: 变量
    uses: [名字, 值]
  - id: q2
    kind: true_false
    q: '在「$余额 = 50$」这一步中，$余额$ 是被读取的变量。'
    answer: 错
    explanation: |
      这一步是把 $50$ 写进名字 $余额$，属于赋值；读取是拿名字换回当前的值，方向正好相反。
      两个动作的区别可写成：
      $$余额 = 50 \quad(\text{把值写进名字})$$
      最易错点：看到等号左边是变量名，就以为是在「读」它，其实它是被写入的那一方。
    difficulty: 1
    section: 概念：赋值与读取
    invokes: 变量
    uses: [赋值, 读取]
  - id: q3
    kind: fill_in_blank
    q: '从一个变量名字换回它此刻的值，这个动作叫做____（填一个两字术语）。'
    answer: ['读取']
    explanation: |
      拿名字换回当前的值，正是正文所说的读取。
      与它配对的另一动作是把值写进名字，即赋值：
      $$读取 \longleftrightarrow 赋值$$
      最易错点：把「换回当前值」说成赋值——赋值是写进去，不是取出来。
    difficulty: 2
    section: 概念：赋值与读取
    invokes: 变量
    uses: [赋值]
  - id: q4
    kind: single_choice
    q: |
      一段记录按顺序执行三步：① $余额 = 50$；② $零钱 = 余额$；③ $余额 = 20$。
      此时读取 $零钱$，得到的是多少？
    options:
      - '$50$'
      - '$20$'
      - '$30$'
      - '无法确定'
    answer: A
    explanation: |
      第②步中读取 $余额$，拿到的是它「此刻」的值，当时 $余额$ 还是 $50$，所以写入 $零钱$ 的就是 $50$；第③步只改 $余额$，不会回头改动已写入 $零钱$ 的值。
      因此最后：
      $$零钱 = 50,\qquad 余额 = 20$$
      最易错点：以为 $余额$ 后来的变化会让 $零钱$ 跟着一起变，其实读取只在那一瞬间取值。
    difficulty: 3
    section: 通用
    invokes: 变量
    uses: [赋值, 读取]
