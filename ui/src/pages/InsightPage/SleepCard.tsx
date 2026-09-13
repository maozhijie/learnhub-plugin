/** 洞察区·睡眠耦合建议开关（D-4 #111；#210 自实验室页迁入）：开启后实践类节点
 * （乐器/运动等重巩固型）的推荐带「睡前练、醒后验」时段建议；只读建议——不改调度语义。 */
import { Card, Message, Space, Switch, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { errorMessage } from '../../hooks/useCommand'
import type { SleepConfig } from '../../types'

const { Text } = Typography

export default function SleepCard() {
  const [sleep, setSleep] = useState<SleepConfig | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setSleep(await api.sleep())
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const toggle = async (enabled: boolean) => {
    setBusy(true)
    try {
      await api.setSleep({ enabled })
      Message.success(enabled ? '睡眠建议已开启' : '睡眠建议已关闭')
      await reload()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const on = sleep?.enabled ?? true
  return (
    <Card title='睡眠耦合排程建议' className='lh-card'>
      <Space wrap>
        <Switch checked={on} disabled={busy} onChange={v => { void toggle(v) }} />
        <Text>{on ? '已开启' : '已关闭'}</Text>
        <Text type='secondary' className='lh-t-12'>
          开启后，实践类节点（乐器/运动等重巩固型）的推荐会带「睡前练、醒后验」时段建议与可选心理演练附注（小效应，预期管理措辞）。只读建议——不改调度语义。
        </Text>
      </Space>
    </Card>
  )
}
