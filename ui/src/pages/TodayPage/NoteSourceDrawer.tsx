/** 笔记源抽屉（C1 #59，#72 UI 挂接；页内子组件）：源清单 + 注册/解除注册/出题 +
 * 旧题逐题归档。从学习页复习横幅区进入；漂移提示的「归档旧题」跳进来并展开
 * 对应源的旧题清单。 */
import { Alert, Button, Card, Drawer, Empty, Input, Message, Popconfirm, Space, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { errorMessage } from '../../hooks/useCommand'
import type { NoteSourceDoc, QuestionItem } from '../../types'

const { Text } = Typography

export default function NoteSourceDrawer(props: { open: boolean; focusId: string | null; onClose: () => void; onChanged: () => void }) {
  const [doc, setDoc] = useState<NoteSourceDoc | null>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [oldQs, setOldQs] = useState<QuestionItem[] | null>(null)
  /** 缺失源的重连新路径（V-6 #109，按源 id 分格）。 */
  const [relinkPaths, setRelinkPaths] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setDoc(await api.noteSources().catch(() => null))
  }, [])
  useEffect(() => {
    if (props.open) {
      setExpanded(props.focusId)
      setOldQs(null)
      void load()
      if (props.focusId) void expandQuestions(props.focusId)
    }
  // focusId 变化（横幅「归档旧题」直达）时重新定位；load 稳定
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.focusId])

  /** 拉某源的旧题清单（笔记源伪课程走 /questions 同通道，不含答案）。 */
  const expandQuestions = async (id: string) => {
    try {
      const r = await api.questions('笔记源', id)
      setOldQs(r.questions)
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  const toggleExpand = (id: string) => {
    if (expanded === id) {
      setExpanded(null)
      setOldQs(null)
      return
    }
    setExpanded(id)
    setOldQs(null)
    void expandQuestions(id)
  }

  const register = async () => {
    if (!path.trim()) { Message.warning('填写笔记或文件夹路径（vault 相对或绝对）'); return }
    setBusy(true)
    try {
      const r = await api.noteSourceRegister(path.trim())
      Message.success(r.registered === 0 && r.updated > 0
        ? `已恢复注册（${r.updated} 篇，路径未变）`
        : `已注册 ${r.registered} 篇${r.updated ? `、恢复 ${r.updated} 篇` : ''}${r.skipped ? `、跳过 ${r.skipped} 篇（学习中心内部）` : ''}`)
      setPath('')
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const generate = async (id: string) => {
    setBusy(true)
    try {
      const r = await api.noteSourceGenerate(id)
      Message.success(`「${id}」出题完成：新增 ${r.added} 题（旧题保留，可展开逐题归档），新卡明天起进复习队列`)
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const unregister = async (id: string) => {
    try {
      const r = await api.noteSourceUnregister(id)
      Message.success(`已解除「${r.removed}」的注册（你的笔记文件未动）`)
      if (expanded === id) { setExpanded(null); setOldQs(null) }
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  const archiveOne = async (id: string, qid: string) => {
    try {
      await api.questionArchive('笔记源', id, qid, true)
      Message.success(`已归档 ${qid}（不再进复习队列）`)
      if (expanded === id) await expandQuestions(id)
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  /** 改路径重连（V-6 #109）：源缺失（改名/移动）时把既有源重连到新路径——
   * 卡池与每张卡的调度保留（区别于解除后重注册：旧卡不会变孤儿）。 */
  const relink = async (id: string) => {
    const p = (relinkPaths[id] ?? '').trim()
    if (!p) { Message.warning('填写改名/移动后的新路径（vault 相对或绝对）'); return }
    try {
      const r = await api.noteSourceRelink(id, p)
      Message.success(`「${r.id}」已重连到 ${r.to}（卡池与调度保留）`)
      setRelinkPaths(m => ({ ...m, [id]: '' }))
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  const STATUS: Record<string, { label: string; color: string }> = {
    ok: { label: '正常', color: 'green' },
    drifted: { label: '漂移', color: 'orange' },
    missing: { label: '缺失', color: 'red' },
    inconsistent: { label: '镜象不一致', color: 'purple' },
  }

  return (
    <Drawer width={560} visible={props.open} footer={null} unmountOnExit
      title='笔记源（个人笔记 → 复习题）' onCancel={props.onClose}>
      <Space direction='vertical' className='lh-full' size={12}>
        <Alert type='info' className='lh-t-12'
          content='注册 vault 里的笔记（单篇 .md 或整个文件夹）：引擎只读笔记来出复习题，永不改动笔记本身；到期卡进复习队列（课程列显示「笔记源」）。' />
        <Space size={8} className='lh-full'>
          <Input value={path} onChange={setPath} placeholder='笔记或文件夹路径（vault 相对/绝对）' className='lh-flex-1'
            onPressEnter={() => void register()} />
          <Button type='primary' loading={busy} onClick={() => void register()}>注册</Button>
        </Space>
        {doc === null ? (
          <Text type='secondary'>加载中…</Text>
        ) : doc.sources.length === 0 ? (
          <Empty description='还没有笔记源：填上方路径注册一篇笔记试试' />
        ) : (
          doc.sources.map(s => {
            const st = STATUS[s.status] ?? { label: s.status, color: 'gray' }
            return (
              <Card size='small' key={s.id} className='lh-r-md'>
                <div className='lh-row lh-gap-8 lh-wrap'>
                  <Tag size='small' color={st.color}>{st.label}</Tag>
                  <div className='lh-grow'>
                    <Text className='lh-ellipsis lh-strong lh-block'>
                      {s.title || s.path}
                    </Text>
                    <Text type='secondary' className='lh-t-12'>
                      {s.id} · {s.cards} 张卡{s.due > 0 ? `（到期 ${s.due}）` : ''}
                    </Text>
                  </div>
                  <Popconfirm title='按笔记当前内容出题？'
                    content='出题即确认当前内容（漂移清除）；旧题保留，可展开逐题归档。'
                    onOk={() => void generate(s.id)}>
                    <Button size='mini' type='primary' loading={busy}>出题</Button>
                  </Popconfirm>
                  {s.cards > 0 && (
                    <Button size='mini' onClick={() => toggleExpand(s.id)}>{expanded === s.id ? '收起旧题' : '旧题管理'}</Button>
                  )}
                  <Popconfirm title={`解除注册「${s.title || s.id}」？`}
                    content='移除注册与镜象题库；你的笔记文件不受影响。'
                    onOk={() => void unregister(s.id)}>
                    <Button size='mini' type='text' status='danger'>解除注册</Button>
                  </Popconfirm>
                </div>
                {s.hint && (
                  <Text type={s.status === 'missing' ? 'error' : 'warning'} className='lh-t-12 lh-block lh-mt-4'>
                    {s.hint}
                  </Text>
                )}
                {s.status === 'missing' && (
                  <div className='lh-mt-6 lh-flex lh-gap-8'>
                    <Input size='mini' value={relinkPaths[s.id] ?? ''} onChange={v => setRelinkPaths(m => ({ ...m, [s.id]: v }))}
                      placeholder='改名/移动后的新路径（重连保留卡池与调度）'
                      onPressEnter={() => void relink(s.id)} />
                    <Button size='mini' type='outline' onClick={() => void relink(s.id)}>重连</Button>
                  </div>
                )}
                {expanded === s.id && (
                  <div className='lh-divider-top'>
                    {oldQs === null ? <Text type='secondary' className='lh-t-12'>加载中…</Text>
                      : oldQs.length === 0 ? <Text type='secondary' className='lh-t-12'>没有在库旧题（都已归档；出题可补充新卡）</Text>
                        : oldQs.map(q => (
                          <div key={q.id} className='lh-row lh-gap-8 lh-p-4px-0'>
                            <Tag size='small' color='gray'>{q.id}</Tag>
                            <Text className='lh-ellipsis lh-grow lh-t-12'>{q.q}</Text>
                            <Popconfirm title={`归档「${q.id}」？`}
                              content='归档后不再进复习队列（笔记内容更新后重出题即可替换）。'
                              onOk={() => void archiveOne(s.id, q.id)}>
                              <Button size='mini' type='text' status='warning'>归档</Button>
                            </Popconfirm>
                          </div>
                        ))}
                  </div>
                )}
              </Card>
            )
          })
        )}
      </Space>
    </Drawer>
  )
}
