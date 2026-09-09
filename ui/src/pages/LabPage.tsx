/** 实验室页（D 区个人实验室 #85/#110/#111/#112）：
 * - D-4 睡眠耦合建议开关（「睡前练、醒后验」时段建议层，默认开）
 * - D-1 N-of-1 实验引擎（ADR-0023）：模板库发起 → 确认开跑 → 直白话报告（个体
 *   效应口径）；开停手动；零 XP 不进 Mastery
 * - D-2 挑战点恒温器（ADR-0024）：跨区只读仪表 + 至多三条建议，逐条显式确认后
 *   生效——非自动控制器
 * - D-3 沙盘（ADR-0025）：现有 FSRS+mastery 模型蒙特卡洛推演，分布输出，
 *   措辞锁「模型推演，非承诺」；零写侧 */
import { Alert, Button, Card, InputNumber, Message, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { toastError } from '../App'
import type { AppFrame } from '../App'
import type { ExperimentsDoc, SandboxDoc, SleepConfig, ThermostatDoc } from '../types'

const { Text } = Typography

/** 逐周掌握曲线（纯 div 条形：浅色 = p80，实色 = p50）。 */
function CurveBars({ curve }: { curve: Array<{ week: number; p50: number; p80: number }> }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {curve.map(pt => (
        <div key={pt.week} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Text type='secondary' style={{ fontSize: 11, width: 44, flexShrink: 0 }}>第 {pt.week} 周</Text>
          <div style={{ flex: 1, height: 10, background: 'var(--color-fill-2,#f2f3f5)', borderRadius: 5, overflow: 'hidden' }}>
            <div style={{ position: 'relative', width: `${Math.min(100, pt.p80 * 100)}%`, height: '100%', background: 'var(--color-primary-light-3,#bedaff)' }}>
              <div style={{ width: `${pt.p80 ? Math.min(100, (pt.p50 / pt.p80) * 100) : 0}%`, height: '100%', background: 'var(--color-primary-4,#4080ff)' }} />
            </div>
          </div>
          <Text style={{ fontSize: 11, width: 96, textAlign: 'right' }}>
            p50 {Math.round(pt.p50 * 100)}% · p80 {Math.round(pt.p80 * 100)}%
          </Text>
        </div>
      ))}
    </div>
  )
}

export default function LabPage({ frame }: { frame: AppFrame }) {
  const [sleep, setSleep] = useState<SleepConfig | null>(null)
  const [exp, setExp] = useState<ExperimentsDoc | null>(null)
  const [thermo, setThermo] = useState<ThermostatDoc | null>(null)
  const [sandbox, setSandbox] = useState<SandboxDoc | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ proposal: number; title: string; pool: number } | null>(null)
  const [minutes, setMinutes] = useState(45)
  const [weeks, setWeeks] = useState(6)
  const [course, setCourse] = useState<string | undefined>(undefined)

  const reload = useCallback(async () => {
    try {
      const [s, e, t] = await Promise.all([api.sleep(), api.experiments(), api.thermostat()])
      setSleep(s)
      setExp(e)
      setThermo(t)
    } catch (err) {
      toastError(err)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) Message.success(ok)
      await reload()
    } catch (err) {
      toastError(err)
    } finally {
      setBusy(false)
    }
  }

  const runSandbox = async () => {
    setBusy(true)
    try {
      setSandbox(await api.sandboxRun(minutes, weeks, course))
    } catch (err) {
      toastError(err)
    } finally {
      setBusy(false)
    }
  }

  const running = exp?.experiments.find(e => e.status === 'running') ?? null
  const courseNames = frame.tree?.courses.map(c => c.name) ?? []

  return (
    <div style={{ display: 'grid', gap: 12, padding: 12 }}>
      <Alert type='info' content='实验室是「提议非指令」区：沙盘是模型推演非承诺；实验与恒温器的建议都要你逐条确认才生效；这里发生的一切零 XP、不进掌握度、不碰调度语义。' />

      {/* ---- D-3 沙盘 ---- */}
      <Card title='沙盘 · 计划推演' extra={<Text type='secondary'>模型推演，非承诺</Text>}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Text>每日</Text>
          <InputNumber mode='button' min={5} max={600} value={minutes} onChange={v => setMinutes(Number(v) || 45)} style={{ width: 110 }} />
          <Text>分钟 ×</Text>
          <InputNumber mode='button' min={1} max={26} value={weeks} onChange={v => setWeeks(Number(v) || 6)} style={{ width: 110 }} />
          <Text>周</Text>
          <Select placeholder='全部课程' value={course} onChange={setCourse} style={{ width: 160 }} allowClear>
            {courseNames.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
          </Select>
          <Button type='primary' loading={busy} onClick={() => void runSandbox()}>推演</Button>
        </Space>
        {sandbox ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <Text type='secondary' style={{ fontSize: 12 }}>
              {sandbox.runs} 次蒙特卡洛 · 范围 {sandbox.scope.courses.join('、')}（{sandbox.scope.nodes} 节点）· 输出是分布不是承诺
            </Text>
            <CurveBars curve={sandbox.curve} />
            <Table
              size='mini' pagination={false}
              data={sandbox.map}
              columns={[
                { title: '节点', dataIndex: 'node' },
                { title: '推演终点掌握度 p50', dataIndex: 'p50', render: (v: number) => `${Math.round(v * 100)}%` },
                { title: 'p80', dataIndex: 'p80', render: (v: number) => `${Math.round(v * 100)}%` },
              ]}
            />
            <div style={{ display: 'grid', gap: 2 }}>
              {sandbox.assumptions.map((a, i) => (
                <Text key={i} type='secondary' style={{ fontSize: 11 }}>· {a}</Text>
              ))}
            </div>
          </div>
        ) : (
          <Text type='secondary' style={{ fontSize: 12 }}>输入计划点「推演」：用与调度同一套 FSRS+掌握度模型，蒙特卡洛 200 次出掌握度地图与分位带。零写入——推演不进门禁、不进调度。</Text>
        )}
      </Card>

      {/* ---- D-1 N-of-1 实验 ---- */}
      <Card title='N-of-1 实验 · 在自己身上做对照'>
        {running ? (
          <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
            <Space wrap>
              <Tag color='arcoblue'>#{running.id} 进行中</Tag>
              <Text bold>{running.title}</Text>
              <Text type='secondary'>自 {running.started_day} · 每臂 ≥{running.per_arm_min} 次真实推进</Text>
            </Space>
            {exp?.report && exp.report.experiment.id === running.id ? (
              <>
                <div style={{ display: 'grid', gap: 2 }}>
                  {exp.report.analysis.per_arm.map(a => (
                    <Text key={a.arm} style={{ fontSize: 12 }}>
                      {a.label}：{a.n} 次真实推进 · 真实保留率 {Math.round(a.rate * 100)}%
                    </Text>
                  ))}
                </div>
                <Alert type={exp.report.analysis.ready ? 'success' : 'warning'} content={exp.report.analysis.message} />
              </>
            ) : null}
            <div>
              <Popconfirm title='停止实验？停止后报告定稿、不再标注。' onOk={() => { void act(() => api.experimentStop(running.id), '实验已停止') }}>
                <Button size='small' status='warning' disabled={busy}>停止实验</Button>
              </Popconfirm>
            </div>
          </div>
        ) : null}
        {!running && exp?.report && exp.report.experiment.status === 'stopped' ? (
          <Alert
            style={{ marginBottom: 12 }}
            type='success'
            content={`最近实验 #${exp.report.experiment.id}（${exp.report.experiment.title}，已停止）：${exp.report.analysis.message}`}
          />
        ) : null}
        {pending ? (
          <Alert
            style={{ marginBottom: 12 }}
            type='warning'
            content={`提案 #${pending.proposal}「${pending.title}」已发起：合格卡池 ${pending.pool} 张、按学习日轮臂、主结局=真实保留率。确认后立即开跑。`}
            action={
              <Space>
                <Button size='mini' type='primary' disabled={busy}
                  onClick={() => { void act(async () => {
                    await api.experimentApply(pending.proposal)
                    setPending(null)
                  }, '实验已开跑（今天已按当日臂生效）') }}>确认开跑</Button>
                <Button size='mini' disabled={busy} onClick={() => setPending(null)}>先不开</Button>
              </Space>
            }
          />
        ) : null}
        <Table
          size='mini' pagination={false} rowKey='id'
          loading={!exp}
          data={exp?.templates ?? []}
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
                  title={`从模板发起实验提案？发起后这里会给出卡池与参数，确认后才开跑。`}
                  onOk={() => { void act(async () => {
                    setPending(await api.experimentPropose(row.id, course))
                  }) }}
                >
                  <Button size='mini' disabled={busy || Boolean(running) || Boolean(pending)}>{running ? '有实验在跑' : '发起提案'}</Button>
                </Popconfirm>
              ) : null,
            },
          ]}
        />
        <Text type='secondary' style={{ fontSize: 11 }}>
          实验变量只允许引擎可控的内容/课程设计参数（调度核心永不作实验变量）；臂标注进复习日志；零 XP、不进 Mastery。
        </Text>
      </Card>

      {/* ---- D-2 挑战点恒温器 ---- */}
      <Card title='挑战点恒温器 · 跨区观测（只读）'>
        {thermo ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <div>
                <Text type='secondary' style={{ fontSize: 11 }}>课程区 · 真实保留率（{thermo.course_region.retention.real} 次到期复习）</Text>
                <div><Text bold>{thermo.course_region.retention_band.label}</Text></div>
              </div>
              <div>
                <Text type='secondary' style={{ fontSize: 11 }}>课程区 · 难度带长期选择（{thermo.course_region.band_choices.sessions} 次会话）</Text>
                <Text style={{ fontSize: 12 }}>
                  简单 {Math.round(thermo.course_region.band_choices.shares.easy * 100)}% ·
                  标准 {Math.round(thermo.course_region.band_choices.shares.standard * 100)}% ·
                  挑战 {Math.round(thermo.course_region.band_choices.shares.hard * 100)}%
                </Text>
              </div>
              <div>
                <Text type='secondary' style={{ fontSize: 11 }}>无界区 · 执行事件评级</Text>
                <div><Text style={{ fontSize: 12 }}>{thermo.unbounded_region.execution_ratings.count
                  ? `${thermo.unbounded_region.execution_ratings.count} 次`
                  : '暂无数据（随执行事件通道上线）'}</Text></div>
              </div>
              <div>
                <Text type='secondary' style={{ fontSize: 11 }}>项目区</Text>
                <div><Text style={{ fontSize: 12 }}>{thermo.project_region.projects.length
                  ? thermo.project_region.projects.map(p => `${p.name}（${p.tier}）`).join('、')
                  : '后补：随 P-7 上线；当前无项目'}</Text></div>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              {thermo.knobs.map(k => (
                <Text key={k.knob} style={{ fontSize: 12 }}>
                  · <Text bold>{k.title}</Text>：{k.status}{k.current ? `（当前：${k.current}）` : ''}
                </Text>
              ))}
            </div>
            {thermo.suggestions.length ? (
              <div style={{ display: 'grid', gap: 8 }}>
                {thermo.suggestions.map(s => (
                  <Alert
                    key={s.id}
                    type='warning'
                    content={s.text}
                    action={
                      <Popconfirm title='确认采纳这条建议？（显式确认后才生效）' onOk={() => { void act(() => api.thermostatApply(s.id), '已确认生效') }}>
                        <Button size='mini' type='primary' disabled={busy}>确认采纳</Button>
                      </Popconfirm>
                    }
                  />
                ))}
              </div>
            ) : (
              <Text type='secondary' style={{ fontSize: 12 }}>暂无建议（低数据静默——观测足够后才会出现至多三条，逐条确认才生效；恒温器不是自动控制器）。</Text>
            )}
          </div>
        ) : (
          <Text type='secondary' style={{ fontSize: 12 }}>加载中…</Text>
        )}
      </Card>

      {/* ---- D-4 睡眠耦合建议 ---- */}
      <Card title='睡眠耦合排程建议'>
        <Space wrap>
          <Switch
            checked={sleep?.enabled ?? true}
            onChange={v => { void act(() => api.setSleep({ enabled: v }), v ? '睡眠建议已开启' : '睡眠建议已关闭') }}
          />
          <Text>{(sleep?.enabled ?? true) ? '已开启' : '已关闭'}</Text>
          <Text type='secondary' style={{ fontSize: 12 }}>
            开启后，实践类节点（乐器/运动等重巩固型）的推荐会带「睡前练、醒后验」时段建议与可选心理演练附注（小效应，预期管理措辞）。只读建议——不改调度语义。
          </Text>
        </Space>
      </Card>
    </div>
  )
}
