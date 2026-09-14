/** 建课表单（ADR-0076：建课 = 名称即空图——面板只收一个课程名）：一个写入单元落
 * 注册表条目、零节点区、空概念登记表、空终点锚与罗盘骨架；**不自动开始生成**。
 * 学习页空态/顶栏共用这一份表单。下一步：到图屏「添加终点」给课程方向，教练回合
 * 把终点接上台阶（或对面板显式下发「生长一步」）。 */
import { Input, Message, Modal, Space, Typography } from '@arco-design/web-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { errorMessage } from '../hooks/useCommand'

const { Text } = Typography

export default function SeedFormModal({ visible, course, onCancel, onCreated }: {
  visible: boolean
  /** 既有课程名（编辑场景预填；缺省 = 新建）。 */
  course?: string | null
  onCancel: () => void
  onCreated?: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (visible) setName(course ?? '')
  }, [visible, course])

  const submit = async () => {
    if (!name.trim()) { Message.warning('课程名必填'); return }
    setBusy(true)
    try {
      await api.courseCreate(name.trim())
      Message.success(`课程「${name.trim()}」已创建：先在图屏添加终点，再让教练生长`)
      onCreated?.(name.trim())
      onCancel()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title='新建课程'
      visible={visible}
      onCancel={onCancel}
      onOk={() => void submit()}
      okText='建课'
      confirmLoading={busy}
      className='lh-w-560'
      unmountOnExit
    >
      <Space direction='vertical' className='lh-full' size={12}>
        <Input placeholder='课程名（如：线性代数）' value={name} onChange={setName} />
        <Text type='secondary' className='lh-t-12'>
          建课只收一个课程名：落一门空课（零节点图 + 空终点锚 + 罗盘骨架），不自动开始生成。
          图不长预铺的骨架——到图屏「添加终点」给方向，教练回合沿终点长台阶，节点数不可预测也不必预测。
        </Text>
      </Space>
    </Modal>
  )
}
