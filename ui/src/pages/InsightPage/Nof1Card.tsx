/** 洞察区·N-of-1 实验卡（D-1 #110 / ADR-0023；#210 自实验室页迁入）：模板库发起 →
 * 提案-确认制开跑 → 直白话报告（个体效应口径）；开停手动；零 XP 不进 Mastery。
 * #210 人审收口：**确认开跑的动作只在提案收件箱**（ADR-0058「该不该同意永远只去
 * 一个地方回答」）——本卡只显示待确认提案并提供直达入口，不再就地确认（原实验室页的
 * 本地「确认开跑」按钮随页退役）。取数走 useCommand；待确认提案与收件箱同源
 * （/proposals），应用后收件箱派发 learnhub:reload，本卡随之刷新（实验在册）。
 */
import { Alert, Button, Card, Message, Popconfirm, Select, Space, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { CommandBoundary } from '../../components/CommandBoundary'
import { onTabActive } from '../../active-tab'
import { api } from '../../api'
import { useCommand, errorMessage } from '../../hooks/useCommand'
import type { AppFrame } from '../../App'
import type { ExperimentsDoc, PropItem } from '../../types'

const { Text } = Typography

export default function Nof1Card({ frame }: { frame: AppFrame }) {
  const exp = useCommand(() => api.experiments())
  const props = useCommand(() => api.proposals())
  const [course, setCourse] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const { reload: reloadExp } = exp
  const { reload: reloadProps } = props
  const reloadAll = useCallback(() => Promise.all([reloadExp(), reloadProps()]).then(() => undefined), [reloadExp, reloadProps])

  // 收件箱应用/拒绝实验提案后回到本页即可见最新状态（ProposalsPage 应用后派发）
  useEffect(() => {
    const h = () => void reloadAll()
    window.addEventListener('learnhub:reload', h)
    // 保活页签：从收件箱/今日切回洞察时补一次取数（在册实验与新提案随之现身）
    const off = onTabActive('insight', () => void reloadAll())
    return () => { window.removeEventListener('learnhub:reload', h); off() }
  }, [reloadAll])

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) Message.success(ok)
      await reloadAll()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const propose = async (template: string) => {
    setBusy(true)
    try {
      const r = await api.experimentPropose(template, course)
      Message.success(`实验提案 #${r.proposal} 已发起（合格卡池 ${r.pool} 张）——到提案收件箱确认后开跑`)
      await reloadAll()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const doc: ExperimentsDoc | null = exp.data
  const running = doc?.experiments.find(e => e.status === 'running') ?? null
  const pending = (props.data ?? []).filter((p): p is PropItem => p.kind === 'experiment' && p.status === 'pending')
  const courseNames = frame.tree?.courses.map(c => c.name) ?? []

  return (
    <Card title='N-of-1 实验 · 在自己身上做对照' style={{ borderRadius: 10 }}>
      {pending.length > 0 && (
        <Alert
          style={{ marginBottom: 12 }}
          type='warning'
          content={
            <Space size={8} wrap>
              <Text>
                {pending.length === 1
                  ? `提案 #${pending[0]!.id}「${pending[0]!.summary}」待确认`
                  : `${pending.length} 条实验提案待确认（#${pending.map(p => p.id).join(' #')}）`}
                ：合格卡池与轮臂参数在提案里，人审动作只在收件箱。
              </Text>
              <Button size='mini' type='primary' onClick={() => frame.goto('courses.proposals')}>去提案收件箱确认</Button>
            </Space>
          }
        />
      )}
      {running ? (
        <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
          <Space wrap>
            <Tag color='arcoblue'>#{running.id} 进行中</Tag>
            <Text bold>{running.title}</Text>
            <Text type='secondary'>自 {running.started_day} · 每臂 ≥{running.per_arm_min} 次真实推进</Text>
          </Space>
          {doc?.report && doc.report.experiment.id === running.id ? (
            <>
              <div style={{ display: 'grid', gap: 2 }}>
                {doc.report.analysis.per_arm.map(a => (
                  <Text key={a.arm} style={{ fontSize: 12 }}>
                    {a.label}：{a.n} 次真实推进 · 真实保留率 {Math.round(a.rate * 100)}%
                  </Text>
                ))}
              </div>
              <Alert type={doc.report.analysis.ready ? 'success' : 'warning'} content={doc.report.analysis.message} />
            </>
          ) : null}
          <div>
            <Popconfirm title='停止实验？停止后报告定稿、不再标注。' onOk={() => { void act(() => api.experimentStop(running.id), '实验已停止') }}>
              <Button size='small' status='warning' disabled={busy}>停止实验</Button>
            </Popconfirm>
          </div>
        </div>
      ) : null}
      {!running && doc?.report && doc.report.experiment.status === 'stopped' ? (
        <Alert
          style={{ marginBottom: 12 }}
          type='success'
          content={`最近实验 #${doc.report.experiment.id}（${doc.report.experiment.title}，已停止）：${doc.report.analysis.message}`}
        />
      ) : null}
      <CommandBoundary cmd={exp} loadingNode={<Text type='secondary'>加载中…</Text>}>
        {d => (
          <>
            <Space size={8} wrap style={{ marginBottom: 8 }}>
              <Text type='secondary' style={{ fontSize: 12 }}>范围</Text>
              <Select size='small' placeholder='全部课程' value={course} onChange={setCourse} style={{ width: 160 }} allowClear>
                {courseNames.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
              </Select>
              <Text type='secondary' style={{ fontSize: 11 }}>发起提案时生效（确认前零副作用）</Text>
            </Space>
            <Table
              size='mini' pagination={false} rowKey='id'
              data={d.templates}
              columns={[
                { title: '模板', dataIndex: 'title' },
                {
                  title: '研究问题', dataIndex: 'question',
                  render: (v: string, row) => (
                    <div>
                      <Text style={{ fontSize: 12 }}>{v}</Text>
                      <div><Text type='secondary' style={{ fontSize: 11 }}>{row.description}</Text></div>
                      {!row.unlocked ? <Tag size='small'>未解锁：{row.unlock_note ?? '参数未上线'}</Tag> : null}
                    </div>
                  ),
                },
                {
                  title: '操作', width: 110,
                  render: (_, row) => row.unlocked ? (
                    <Popconfirm
                      title={`从模板发起实验提案？发起后到提案收件箱确认才开跑（人审唯一处）。`}
                      onOk={() => void propose(row.id)}
                    >
                      <Button size='mini' disabled={busy || Boolean(running) || pending.length > 0}>
                        {running ? '有实验在跑' : pending.length > 0 ? '有待确认提案' : '发起提案'}
                      </Button>
                    </Popconfirm>
                  ) : null,
                },
              ]}
            />
            <Text type='secondary' style={{ fontSize: 11 }}>
              实验变量只允许引擎可控的内容/课程设计参数（调度核心永不作实验变量）；臂标注进复习日志；零 XP、不进 Mastery。
              发起后到提案收件箱确认（确认前零副作用），停止即定稿。
            </Text>
          </>
        )}
      </CommandBoundary>
    </Card>
  )
}
