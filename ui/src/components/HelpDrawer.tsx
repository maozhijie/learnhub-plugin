/** 帮助抽屉（#205 / ADR-0058）：能力指南从独立页签退役为壳级抽屉——低频参考
 * 不再占页签，顶栏问号直达。内容 = GuidePage 原样（零内容改动）。 */
import { Drawer } from '@arco-design/web-react'
import GuidePage from '../pages/GuidePage'

export function HelpDrawer(props: { visible: boolean; onClose: () => void }) {
  return (
    <Drawer width='min(860px, 94vw)' title='能力指南' visible={props.visible}
      onCancel={props.onClose} footer={null}>
      <GuidePage />
    </Drawer>
  )
}
