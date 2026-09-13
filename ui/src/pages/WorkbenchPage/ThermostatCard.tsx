/** 挑战点恒温器（D-2 #111 / ADR-0024；#209 自实验室页迁入教练台分栏）：跨区只读
 * 观测仪表——课程区真实保留率与难度带长期选择、无界区执行事件评级、项目区渐退档
 * 分布；至多三条只读建议，逐条显式确认（Popconfirm）后才走 thermostat-apply 生效。
 * 恒温器不是自动控制器：观测与提议在这里，任何参数调整都是学习者的显式动作。 */
import { Alert, Button, Card, Message, Popconfirm, Typography } from '@arco-design/web-react'
import { useCallback, useState } from 'react'
import { api } from '../../api'
import { usePolling } from '../../hooks/usePolling'
import { errorMessage } from '../../hooks/useCommand'
import type { ThermostatDoc } from '../../types'

const { Text } = Typography

export default function ThermostatCard() {
  const [thermo, setThermo] = useState<ThermostatDoc | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setThermo(await api.thermostat())
    } catch {
      setThermo(null)
    }
  }, [])
  // 挂载即取 + 低频轮询（观测面缓变；非激活跳过、切回即补）
  usePolling(load, { tab: 'courses.course', intervalMs: 60_000 })

  const act = async (run: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await run()
      Message.success(ok)
      await load()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card size='small' title='挑战点恒温器 · 跨区观测（只读）' style={{ borderRadius: 10, marginTop: 10 }}>
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
  )
}
