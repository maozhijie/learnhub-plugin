/** 「这些事可以找 agent」提示块：渲染 AGENT_GUIDE（宿主单一事实源，GET /agent-guide）
 * 中属于当前页面的条目——每条附一句职责说明与可复制的 dsh 指令。
 * 所有只能通过与 agent 对话实现的功能，都应在对应页面能找到这里的说明。 */
import { Collapse, Message, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AgentGuideItem } from '../types'

const { Text } = Typography

/** 页面键 → 展示名（与宿主 AGENT_GUIDE.page 约定一致）。 */
export const GUIDE_PAGE_LABEL: Record<string, string> = {
  today: '今日', courses: '课程', insight: '洞察', projects: '项目', practice: '无界实践区', global: '全局',
}

let cache: AgentGuideItem[] | null = null

/** 拉取能力指南（模块级缓存：指南页与各页提示共享一次请求）。 */
export async function fetchGuide(): Promise<AgentGuideItem[]> {
  if (cache) return cache
  cache = await api.agentGuide()
  return cache
}

export default function AgentHints(props: { page: string }) {
  const [items, setItems] = useState<AgentGuideItem[] | null>(null)
  useEffect(() => {
    void fetchGuide().then(all => setItems(all.filter(x => x.page === props.page))).catch(() => setItems([]))
  }, [props.page])
  if (!items || items.length === 0) return null
  return (
    <Collapse bordered={false} style={{ marginTop: 8 }}>
      <Collapse.Item name='agent' header='这些事可以找 agent 做（对话直达）'>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map(x => (
            <div key={x.tool}>
              <Text style={{ fontSize: 12 }}>{x.text}</Text>
              <div>
                <Text type='secondary' style={{ fontSize: 11 }}>工具 {x.tool}</Text>
                {x.prompt && (
                  <Text copyable={{ onCopy: () => Message.success('指令已复制，粘贴到 dsh 会话即可') }}
                    style={{ fontSize: 11, marginLeft: 6 }}>示例：{x.prompt}</Text>
                )}
              </div>
            </div>
          ))}
        </div>
      </Collapse.Item>
    </Collapse>
  )
}

export function GuideToolTag({ tool }: { tool: string }) {
  return <Tag size='small'>{tool}</Tag>
}
