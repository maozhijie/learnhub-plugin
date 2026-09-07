---
name: learnhub-manim
description: 3Blue1Brown 风格讲解动画：为学习中心的课程节点生成 Manim 动画（Python 工具链预渲染 MP4），落盘为课程媒体并挂进正文。用户说「做个动画」「动起来的演示」「Manim」「推导动画」时使用；交互操作优先用「交互」节而不是本技能。
---

# learnhub Manim 动画生成

定位：**agent 技能而非引擎功能**——learnhub 引擎是纯 TS，本技能按需在会话里调用本地
Python/Manim 工具链渲染讲解型动画（精确推导、几何变换、逐步构造），产物是普通 MP4，
由面板的 media 渲染器播放。需要可调参数的动手模拟请用「交互」节（引擎内建），不要用本技能。

## 1. 前置自检（fail loud，缺什么补什么）

逐项检查并如实报告，任何一项缺失都先给安装指引、征得用户同意再装，绝不静默跳过：

| 依赖 | 检查 | 缺失时指引 |
|---|---|---|
| Python ≥3.9 | `python --version` | python.org 安装 |
| Manim | `python -m manim --version` | `pip install manim`（社区版 manim-ce） |
| LaTeX（MathTex 需要） | `latex --version` | Windows 装 MiKTeX / macOS 装 MacTeX / Linux 装 texlive；**没有 LaTeX 时退化为 Text + 图形动画，不用 MathTex** |
| ffmpeg | `ffmpeg -version` | 随 manim 文档安装并加入 PATH |

## 2. 定位与取材

- `learnhub_status` / `learnhub_lesson` 确认目标节点与正文；动画必须锚定某节已讲的核心概念（公式、几何关系、变化过程），不得引入正文没有的内容。
- 和用户确认动画要讲清的一件事（一句话），再动笔——Manim 场景没有明确叙事目标时容易变成无重点的特效堆砌。

## 3. 创作与渲染

1. 场景脚本写到 `<课程根>/课程图/manim/<节点名>_<语义化slug>.py`（随课程归档，便于重渲）。
2. 渲染：`python -m manim -qm <脚本.py> <SceneName>`（-qm 720p 足够面板播放；耗时的才用 -qh）。
3. 把产物移入 `<课程根>/课程图/<语义化名称>.mp4`（media 渲染器按扩展名播放）。时长建议 10–45 秒，一个动画只讲一件事。
4. 中文文案用 `Text()`（配 font 参数指定系统中文字体）；数学记号用 `MathTex()`（需 LaTeX）。

## 4. 挂进正文与质检

1. 在节点正文对应位置加媒体引用块：

```media
<课程根>/课程图/<语义化名称>.mp4
```

2. 跑 `learnhub_content_check`，修尽全部 findings（媒体路径必须在课程根内）。
3. 汇报：动画讲什么、文件在哪、正文哪一节引用了它；用户不满意就改脚本重渲（脚本已归档，改一行重跑即可）。

## 边界

- 引擎与面板不做任何 Manim 集成：本技能只产出文件 + 正文引用，属于内容资产。
- 渲染失败（LaTeX 报错/缺字体）如实报告原因；不要交付黑屏或半截视频。
- 大量动画会膨胀 vault 体积：同一节点至多保留 2–3 个动画，废弃的删掉。
