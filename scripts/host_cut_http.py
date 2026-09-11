# 刀 12 第二步：HTTP 工具与静态资源常量 → src/host/http.ts
import io

src = 'src/index.ts'
lines = io.open(src, encoding='utf8').read().split('\n')

def find(pred):
    return next(i for i, l in enumerate(lines) if pred(l))

# 段 1：PAGE_DIST .. ASSET_MIME 结束（runLog 注释前）
a1 = find(lambda l: l.startswith('const PAGE_DIST'))
b1 = find(lambda l: l.startswith('/** 运行日志：每次引擎调用的记录'))
seg1 = '\n'.join(lines[a1:b1]).rstrip('\n')

# 段 2：sendJson .. injectKatexIfMathed 结束（handleApi 注释前）
a2 = find(lambda l: l.startswith('function sendJson('))
b2 = find(lambda l: l.startswith('/** /learnhub/api/* 路由分发'))
seg2 = '\n'.join(lines[a2:b2]).rstrip('\n')

header = '''/**
 * 宿主 HTTP 技术层（#152 刀 12 自 src/index.ts 抽出）：面板静态产物目录/MIME 表、
 * 请求解析与响应序列化、markdown 数学注入。无状态纯工具层——不碰 engine、不碰队列。
 */
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

'''
io.open('src/host/http.ts', 'w', encoding='utf8', newline='\n').write(header + seg1 + '\n\n' + seg2 + '\n')

for a, b in sorted([(a1, b1), (a2, b2)], key=lambda x: -x[0]):
    del lines[a:b]
s2 = '\n'.join(lines)
s2 = s2.replace("import { contentEffort, llmComplete, llmSeam, llmStreamOnce, llmView } from './host/llm.ts'",
                """import { contentEffort, llmComplete, llmSeam, llmStreamOnce, llmView } from './host/llm.ts'
import { ASSET_MIME, FILE_MIME, PAGE_DIST, VENDOR_DIST, injectKatexIfMathed, need, readJson, sendJson } from './host/http.ts'""")
io.open(src, 'w', encoding='utf8', newline='\n').write(s2)
print('host/http.ts written; index.ts lines:', s2.count('\n') + 1)
