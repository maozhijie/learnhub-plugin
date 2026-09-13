/** 「我的卡」管理抽屉（E1 #70，#72 UI 挂接；页内子组件）：自注卡清单 + 归档/恢复。
 * 队列只回在库卡：「本次已归档」清单挂在学习页会话级（关闭抽屉再开仍可恢复，
 * 页面刷新后归档历史在卡文件里留档，恢复走引擎侧）。 */
import { Alert, Button, Drawer, Empty, Message, Popconfirm, Space, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { errorMessage } from '../../hooks/useCommand'
import type { LearnerCardItem, LearnerQueueDoc } from '../../types'

const { Text } = Typography

export default function LearnerCardManager(props: {
  open: boolean
  onClose: () => void
  onChanged: () => void
  /** 本次学习页会话里刚归档的卡（恢复入口的清单）。 */
  archived: LearnerCardItem[]
  onArchivedChange: (list: LearnerCardItem[]) => void
}) {
  const [q, setQ] = useState<LearnerQueueDoc | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setQ(await api.learnerQueue().catch(() => null))
  }, [])
  useEffect(() => {
    if (props.open) void load()
  }, [props.open, load])

  const toggleArchive = async (card: LearnerCardItem, flag: boolean) => {
    setBusy(true)
    try {
      await api.learnerArchive(card.course, card.node, card.id, flag)
      if (flag) {
        props.onArchivedChange([...props.archived, card])
        Message.success(`已归档「${card.id}」（不再进我的卡队列）`)
      } else {
        props.onArchivedChange(props.archived.filter(c => !(c.course === card.course && c.node === card.node && c.id === card.id)))
        Message.success(`已恢复「${card.id}」`)
      }
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const kindLabel = (k: string) => ({ recall_cue: '再讲一遍', cloze_rewrite: '挖空重述', self_explain: '自注讲解' })[k] ?? k

  return (
    <Drawer width={560} visible={props.open} footer={null} unmountOnExit
      title='我的卡管理（你自己的理解卡）' onCancel={props.onClose}>
      <Space direction='vertical' style={{ width: '100%' }} size={10}>
        <Alert type='info' style={{ fontSize: 12 }}
          content='归档后卡片不再进「我的卡」队列，历史保留在卡文件里；本次学习页会话里归档的卡可在此恢复。' />
        {q === null ? <Text type='secondary'>加载中…</Text>
          : q.cards.length === 0 ? <Empty description='没有在库卡：在节学习页「加我的理解」，或把「讲给我听」的讲稿存档' />
            : q.cards.map(c => (
              <div key={`${c.course}/${c.node}/${c.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Tag size='small' color='arcoblue'>{kindLabel(c.kind)}</Tag>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Text style={{ fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.prompt}</Text>
                  <Text type='secondary' style={{ fontSize: 12 }}>
                    {c.node} · {c.due ? `到期 ${c.due}` : '未调度'} · 做过 {c.attempts} 次
                  </Text>
                </div>
                <Popconfirm title='归档这张卡？'
                  content='归档后不再进「我的卡」队列；可在本抽屉立即恢复。'
                  onOk={() => void toggleArchive(c, true)}>
                  <Button size='mini' type='text' status='warning' disabled={busy}>归档</Button>
                </Popconfirm>
              </div>
            ))}
        {props.archived.length > 0 && (
          <>
            <Text type='secondary' style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>本次已归档（可恢复）</Text>
            {props.archived.map(c => (
              <div key={`archived-${c.course}/${c.node}/${c.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.7 }}>
                <Tag size='small'>{kindLabel(c.kind)}</Tag>
                <Text type='secondary' style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.prompt}</Text>
                <Button size='mini' type='text' disabled={busy} onClick={() => void toggleArchive(c, false)}>恢复</Button>
              </div>
            ))}
          </>
        )}
      </Space>
    </Drawer>
  )
}
