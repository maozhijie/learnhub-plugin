/** 「我的资产」菜单（#208 / ADR-0058）：横幅 C1/C2/E1 裸入口退役后的家——我的卡、
 * 笔记源抽屉与 导出到 Anki（T6 归洞察通道卡，其间在此保持可达）。产出资产入口常驻
 * 今日页头，不再与学习动作挤一排。 */
import { Button, Dropdown, Menu, Tooltip } from '@arco-design/web-react'
import type { AnkiStatusDoc } from '../../types'

export function AssetsMenu({ anki, onExportAnki, onOpenSources, onManage }: {
  anki: AnkiStatusDoc | null
  onExportAnki: () => void
  onOpenSources: () => void
  onManage: () => void
}) {
  const ankiDue = anki?.due.total
  const ankiOffline = anki?.anki != null && !anki.anki.connected
  return (
    <Dropdown trigger='click' position='br' droplist={
      <Menu style={{ minWidth: 168 }}>
        <Menu.Item key='anki' onClick={onExportAnki}>
          导出到 Anki{typeof ankiDue === 'number' ? `（${ankiDue}）` : ''}
        </Menu.Item>
        <Menu.Item key='sources' onClick={onOpenSources}>笔记源管理…</Menu.Item>
        <Menu.Item key='cards' onClick={onManage}>我的卡管理…</Menu.Item>
      </Menu>
    }>
      <Tooltip content={ankiOffline ? `Anki 未连上：${anki?.anki?.error ?? '桌面 Anki 未打开'}` : '我的卡 / 笔记源 / 导出到 Anki'}>
        <Button>我的资产</Button>
      </Tooltip>
    </Dropdown>
  )
}
