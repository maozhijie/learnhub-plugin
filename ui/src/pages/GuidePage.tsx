/** 能力指南：面板能做的、以及「只能与 agent 对话实现」的全部能力，一处看全。
 * 数据源 = 宿主 AGENT_GUIDE（与工具注册同文件维护的单一事实源，GET /agent-guide）；
 * 各页面的场景内提示由 AgentHints 从同一份数据渲染（学 / 图 / 题库 / 实践 / 项目等）。
 * 每条附可复制的 dsh 会话指令——复制后到 dsh 对话里粘贴即可执行。 */
import { Card, Empty, Message, Space, Spin, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useState } from 'react'
import { fetchGuide, GUIDE_PAGE_LABEL } from '../components/AgentHints'
import type { AgentGuideItem } from '../types'
import { errorMessage } from '../hooks/useCommand'

const { Text } = Typography

export default function GuidePage() {
  const [items, setItems] = useState<AgentGuideItem[] | null>(null)
  useEffect(() => {
    void fetchGuide().then(setItems).catch(err => {
      Message.error(errorMessage(err))
      setItems([])
    })
  }, [])
  const groups = Object.entries(GUIDE_PAGE_LABEL)
    .map(([page, label]) => ({ page, label, list: (items ?? []).filter(x => x.page === page) }))
    .filter(g => g.list.length > 0)
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card size='small'>
        <Text style={{ fontSize: 13 }}>
          面板覆盖日常学习流（学 / 复习 / 刷卡 / 出题 / 生成 / 提案人审 / 统计与实验室）。
          更深或低频的操作——建项目、目标反编译、执行事件落账、回执、图查询与回填、数据体检等——
          由 dsh 会话里的 agent 调用 learnhub 工具完成：下面按页面列出这些能力，
          每条附可直接复制进 dsh 会话的指令；对应页面的「这些事可以找 agent 做」折叠块说的也是它们。
        </Text>
      </Card>
      {items === null ? (
        <div style={{ paddingTop: 40, textAlign: 'center' }}><Spin dot /></div>
      ) : groups.length === 0 ? (
        <Empty description='指南清单为空（宿主 AGENT_GUIDE 未返回条目）' />
      ) : (
        groups.map(g => (
          <Card key={g.page} size='small' title={`${g.label}`}>
            <Space direction='vertical' style={{ width: '100%' }} size={8}>
              {g.list.map(x => (
                <div key={x.tool} style={{
                  background: 'var(--color-fill-1,#f7f8fa)', borderRadius: 6, padding: '8px 10px',
                }}>
                  <Space size={6} wrap>
                    <Tag size='small' color='arcoblue'>{x.tool}</Tag>
                    <Text style={{ fontSize: 12 }}>{x.text}</Text>
                  </Space>
                  {x.prompt && (
                    <div>
                      <Text
                        copyable={{ onCopy: () => Message.success('指令已复制，粘贴到 dsh 会话即可') }}
                        type='secondary' style={{ fontSize: 12 }}>示例指令：{x.prompt}</Text>
                    </div>
                  )}
                </div>
              ))}
            </Space>
          </Card>
        ))
      )}
      <Card size='small' title='怎么跟 agent 协作'>
        <Text type='secondary' style={{ fontSize: 12, display: 'block' }}>
          1. 在 dsh 会话里用自然语言说需求（上面每条的示例指令可直接粘贴）；agent 调用 learnhub 工具完成动作，
          全部调用留痕在学习中心 state/运行日志.md。
        </Text>
        <Text type='secondary' style={{ fontSize: 12, display: 'block' }}>
          2. 改动走提案-确认或显式确认的通道（图提案在「提案」页人审；清理/归档在「题目管理」页确认），
          agent 不会静默改你的学习数据。
        </Text>
        <Text type='secondary' style={{ fontSize: 12, display: 'block' }}>
          3. 当前 AI 模型与思考档在「实验室 → 运行环境」只读展示；切换模型编辑
          ~/.dsh/profiles/web/cordis.patch.yml 的 dsh-learnhub 行后重启宿主。
        </Text>
      </Card>
    </div>
  )
}
