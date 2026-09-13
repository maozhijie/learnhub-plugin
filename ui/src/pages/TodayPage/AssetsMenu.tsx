/** 「我的资产」菜单（#208 / ADR-0058；#210 导出到 Anki 归洞察通道卡）：横幅 C1/C2/E1
 * 裸入口退役后的家——我的卡与笔记源抽屉。产出资产入口常驻今日页头，不再与学习动作
 * 挤一排；Anki 通道卡（含导出/回写）住洞察区，今日不再留过渡入口。 */
import { Button, Dropdown, Menu, Tooltip } from '@arco-design/web-react'

export function AssetsMenu({ onOpenSources, onManage }: {
  onOpenSources: () => void
  onManage: () => void
}) {
  return (
    <Dropdown trigger='click' position='br' droplist={
      <Menu style={{ minWidth: 168 }}>
        <Menu.Item key='sources' onClick={onOpenSources}>笔记源管理…</Menu.Item>
        <Menu.Item key='cards' onClick={onManage}>我的卡管理…</Menu.Item>
      </Menu>
    }>
      <Tooltip content='我的卡 / 笔记源（Anki 通道在洞察区）'>
        <Button>我的资产</Button>
      </Tooltip>
    </Dropdown>
  )
}
