/** 建课/换终点表单（教练台种子起草，ADR-0038；#159 起是全面板唯一主动建课入口——
 * 学习页空态/顶栏与图页教练台共用这一份表单，agent 指令复制引导已退役）。
 * phase=种子 队列任务 → 种子提案一次人审；课程名/目标类型/块工作表是绑定字段
 * （引擎以表单为准，不信模型照抄）。 */
import { Checkbox, Input, Message, Modal, Radio, Space, Typography } from '@arco-design/web-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { errorMessage, notifyQueued } from '../hooks/useCommand'

const { Text } = Typography

export default function SeedFormModal({ visible, mode, course, onCancel }: {
  visible: boolean
  mode: 'new' | 'reseed'
  course: string | null
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [goalType, setGoalType] = useState<'capability' | 'coverage'>('capability')
  const [usePrior, setUsePrior] = useState(false)
  const [worksheetText, setWorksheetText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (visible) {
      setName(course ?? '')
      setGoal('')
      setGoalType('capability')
      setUsePrior(false)
      setWorksheetText('')
    }
  }, [visible, course])

  const submit = async () => {
    if (!name.trim()) { Message.warning('课程名必填'); return }
    if (!goal.trim()) { Message.warning('给一句目标描述——种子起草只认学习者的目标'); return }
    const worksheet = worksheetText.split('\n').map(x => x.trim()).filter(Boolean).map(block => ({ block }))
    if (goalType === 'coverage' && !worksheet.length) {
      Message.warning('覆盖锚定需要块工作表：每行一个块名')
      return
    }
    setBusy(true)
    try {
      const r = await api.seedPropose({
        course: name.trim(), goal: goal.trim(), mode,
        goalType, useVaultPrior: usePrior,
        worksheet: goalType === 'coverage' ? worksheet : [],
      })
      // 诚实版反馈（#155）：按引擎真实返回着色，拒绝不收表单；提案还不存在——起草
      // 完成后才落提案收件箱（弹通知告知），别让人在提案收件箱空等
      notifyQueued(r, {
        successMessage: `${r.message}通常 1–3 分钟；完成后弹通知、提案收件箱出现提案——期间可随意刷新或离开页面`,
        onQueued: onCancel,
      })
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={mode === 'new' ? '新建课程（种子提案）' : `换终点/改工作表（${course}）`}
      visible={visible}
      onCancel={onCancel}
      onOk={() => void submit()}
      okText='起草种子提案'
      confirmLoading={busy}
      className='lh-w-560'
      unmountOnExit
    >
      <Space direction='vertical' className='lh-full' size={12}>
        {mode === 'new' ? (
          <Input placeholder='课程名（如：线性代数）' value={name} onChange={setName} />
        ) : (
          <Text type='secondary'>对既有课程重新种子：终点可换、起点通常保留（除非目标本身变了）。</Text>
        )}
        <Input.TextArea
          placeholder='目标描述：学完这门课你想能做什么？（一段话即可，模型据此定起点与终点）'
          value={goal} onChange={setGoal} autoSize={{ minRows: 3, maxRows: 6 }} />
        <Space size={16}>
          <Text type='secondary'>目标类型：</Text>
          <Radio.Group value={goalType} onChange={v => setGoalType(v as 'capability' | 'coverage')}>
            <Radio value='capability'>能力锚定（完成 = 终点掌握）</Radio>
            <Radio value='coverage'>覆盖锚定（完成 = 块工作表 + 终点）</Radio>
          </Radio.Group>
        </Space>
        {goalType === 'coverage' && (
          <Input.TextArea
            placeholder='块工作表：每行一个块名（完成判据的核对表）'
            value={worksheetText} onChange={setWorksheetText} autoSize={{ minRows: 3, maxRows: 6 }} />
        )}
        <Checkbox checked={usePrior} onChange={setUsePrior}>
          参考我的笔记定起点（Vault 先验检索：起点放在熟悉边界，已会内容不作起点）
        </Checkbox>
        <Text type='secondary' className='lh-t-12'>
          提交即入队起草（通常 1–3 分钟，队列 FIFO，可能排在内容生成之后）；随时刷新或离开页面都不影响——
          任务在宿主执行，完成后弹通知、提案收件箱出现提案。产物是种子提案：1–3 起点 + 终点，一次人审即开工；
          图的其余部分由教练回合随生长批生长，不预先铺满。
        </Text>
      </Space>
    </Modal>
  )
}
