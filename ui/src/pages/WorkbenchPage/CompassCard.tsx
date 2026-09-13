/** 罗盘卡（#209 工作台首屏上半）：课程根常驻的非承诺路线草图（ADR-0033 透明度装置）
 * 的面板读视图——剩余路线（教练唯一写权，随生长批重写）、学习者批注区（软输入：
 * 提议非指令）、每周挂载的沙盘 ETA（措辞「模型推演，非承诺」锁死）。数据走
 * GET /compass（引擎 compassRead 原样透传）；罗盘文件 Missing = 合法空态（未播种），
 * 不伪装成内容。语义零改动：本组件只读，重画入口住在教练台分栏；跨页流（生长批
 * 应用/罗盘重画完成）经 learnhub:reload 全局事件补拉。 */
import { Card, Empty, Space, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import MdView from '../../components/MdView'
import type { CompassDoc } from '../../types'

const { Text, Title } = Typography

export default function CompassCard({ course }: { course: string }) {
  const [doc, setDoc] = useState<CompassDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      setDoc(await api.compass(course))
      setError(null)
    } catch {
      setError('罗盘加载失败——引擎暂不可达')
    }
  }, [course])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const h = () => { void load() }
    window.addEventListener('learnhub:reload', h)
    return () => window.removeEventListener('learnhub:reload', h)
  }, [load])

  if (error) {
    return <Card size='small' title='罗盘' className='lh-card'><Text type='secondary'>{error}</Text></Card>
  }
  if (doc === null) {
    return <Card size='small' title='罗盘' className='lh-card'><Text type='secondary'>加载罗盘…</Text></Card>
  }
  return (
    <Card size='small' title='罗盘' className='lh-card'
      extra={
        <Space size={8}>
          {doc.goal_type && <Tag size='small' color='magenta'>{doc.goal_type === 'coverage' ? '覆盖锚定' : '能力锚定'}</Tag>}
          {doc.endpoint
            ? <Tag size='small' color='purple'>终点 · {doc.endpoint}</Tag>
            : <Tag size='small' color='gray'>终点未锚定</Tag>}
        </Space>
      }>
      {doc.missing ? (
        <Empty description='罗盘还没有初画：种子提案应用后落「待初画」占位，教练台可下发罗盘初画（或随首个生长批自动重写）。' />
      ) : (
        <Space direction='vertical' size={10} className='lh-full'>
          <div>
            <Title heading={6} className='lh-mt-0 lh-mb-4'>剩余路线（非承诺草图——方向感，不是承诺）</Title>
            {doc.route
              ? <MdView md={doc.route} />
              : <Text type='secondary'>待初画：教练台的「罗盘重画」或首个生长批会写下路线。</Text>}
          </div>
          <div>
            <Title heading={6} className='lh-mt-0 lh-mb-4'>学习者批注（软输入——提议非指令）</Title>
            {doc.annotations
              ? <MdView md={doc.annotations} />
              : <Text type='secondary'>空：直接在 vault 的罗盘文件里写，教练回合裁决前会读它（不产生权威变更，重写后仍在）。</Text>}
          </div>
          <div>
            <Title heading={6} className='lh-mt-0 lh-mb-4'>
              沙盘 ETA（模型推演，非承诺{doc.eta_week ? `；第 ${doc.eta_week} 周` : ''}）
            </Title>
            {doc.eta
              ? <MdView md={doc.eta} />
              : <Text type='secondary'>本周还没挂载推演：周复盘发起时随罗盘每周刷新。</Text>}
          </div>
        </Space>
      )}
    </Card>
  )
}
