# 刀 12 第一步：宿主 LLM 适配层 → src/host/llm.ts
import io, re

src = 'src/index.ts'
s = io.open(src, encoding='utf8').read()
lines = s.split('\n')

def block_str(start_marker, end_marker):
    a = next(i for i, l in enumerate(lines) if start_marker in l)
    b = next(i for i, l in enumerate(lines) if end_marker in l)
    return a, b

# 区间一：llmCfg/contentEffort/llmView（中间夹 AGENT_GUIDE，故分两段取）
# 区间 A：llmCfg .. llmView 结束（AGENT_GUIDE 之前）
a1 = next(i for i, l in enumerate(lines) if l.startswith('const llmCfg = {'))
b1 = next(i for i, l in enumerate(lines) if l.startswith('const AGENT_GUIDE'))
segA = '\n'.join(lines[a1:b1]).rstrip('\n')

# 区间 B：LLM 常量 .. llmStreamOnce 结束（stripFences 之前）
a2 = next(i for i, l in enumerate(lines) if l.startswith('const LLM_IDLE_TIMEOUT_MS'))
b2 = next(i for i, l in enumerate(lines) if l.startswith('/** 剥掉模型可能包住的整段 markdown 代码围栏'))
segB = '\n'.join(lines[a2:b2]).rstrip('\n')

moved = segA + '\n\n' + segB + '\n'

header = '''/**
 * 宿主 LLM 适配层（#152 刀 12 自 src/index.ts 抽出）：部署配置 → 语义档翻译 →
 * dsh llm 流式调用（空闲超时/截断重试/档位降级）+ 引擎侧 LlmComplete 缝实现。
 *
 * 与路由/队列/工具面无关的纯技术层：本文件只依赖 cordis Context 与 dsh-llm，
 * 不碰 engine 与宿主状态。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmComplete, LlmEffort } from '../engine/index.ts'

'''
io.open('src/host/llm.ts', 'w', encoding='utf8', newline='\n').write(header + moved)

# 删除源文件两段（从后往前）
for a, b in sorted([(a1, b1), (a2, b2)], key=lambda x: -x[0]):
    del lines[a:b]
s2 = '\n'.join(lines)
# 源文件改用 host/llm.ts
s2 = s2.replace("""import type { LlmComplete, LlmEffort, SeedDraftRequest } from './engine/index.ts'""",
                """import type { LlmComplete, LlmEffort, SeedDraftRequest } from './engine/index.ts'
import { contentEffort, llmComplete, llmSeam, llmStreamOnce, llmView } from './host/llm.ts'""")
# 头注释工具计数修正 106 → 111（实测 tool('learnhub_*') 111 个）
s2 = s2.replace('agent 工具面：106 个 defineTool 直调 engine', 'agent 工具面：111 个 defineTool 直调 engine')
io.open(src, 'w', encoding='utf8', newline='\n').write(s2)
print('host/llm.ts written; index.ts lines:', s2.count('\n') + 1)
