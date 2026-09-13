/** 洞察区·Anki 通道卡（C2 #63，#72 UI 挂接；页内子组件；#210 起导出到 Anki 的唯一入口）：通道状态（镜象规模/
 * 上次导出与回写/到期分布/AnkiConnect 可达性）+ 导出/回写按钮——C2 全流程面板内
 * 可达，无需进 dsh 会话。用词遵守 CONTEXT 词条 Anki Mirror（镜象）：这是单向推送
 * + 作答回写，不是「同步」。#183：状态取数走 useCommand。 */
import { Alert, Button, Card, Message, Space, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import { CommandBoundary } from '../../components/CommandBoundary'
import { api } from '../../api'
import { useCommand, errorMessage } from '../../hooks/useCommand'
import type { AnkiExportResult, AnkiImportResult } from '../../types'

const { Text } = Typography

export default function AnkiChannelCard() {
  const st = useCommand(() => api.ankiStatus())
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [lastImport, setLastImport] = useState<AnkiImportResult | null>(null)

  const doExport = async () => {
    setBusy('export')
    try {
      const r: AnkiExportResult = await api.ankiExport()
      Message.success(`已推送到 Anki：新增 ${r.added} · 更新 ${r.updated} · 移除 ${r.removed}（到期 ${r.total} 张）`)
      await st.reload()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    setBusy('import')
    try {
      const r = await api.ankiImport()
      setLastImport(r)
      Message.success(`回写完成：导入 ${r.imported} 条事件，推进调度 ${r.advanced} 题（同日已推进跳过 ${r.skipped_same_day} · 无法归属 ${r.skipped_unknown}）`)
      await st.reload()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const doc = st.data
  return (
    <Card size='small' title='Anki 通道' className='lh-card'
      extra={doc?.anki && (
        <Tooltip content={doc.anki.connected ? 'AnkiConnect 已连通（桌面 Anki 在线）' : doc.anki.error}>
          <Tag size='small' color={doc.anki.connected ? 'green' : 'red'}>
            {doc.anki.connected ? 'Anki 已连接' : 'Anki 未连接'}
          </Tag>
        </Tooltip>
      )}>
      <CommandBoundary cmd={st} loadingNode={<Text type='secondary'>加载中…</Text>}>
        {doc => (
          <Space direction='vertical' className='lh-full' size={10}>
            <Space size={24} wrap>
              <div>
                <Text className='lh-strong lh-t-18'>{doc.mirror.entries}</Text>
                <Text type='secondary' className='lh-t-12'> 张镜象卡（Anki 侧 learnhub 卡组）</Text>
              </div>
              <div>
                <Text className='lh-strong lh-t-18'>{doc.due.total}</Text>
                <Text type='secondary' className='lh-t-12'> 张 vault 到期卡待推送</Text>
              </div>
            </Space>
            <Text type='secondary' className='lh-t-12 lh-block'>
              上次导出：{doc.mirror.last_push ?? '从未'} · 上次回写：{doc.mirror.last_import ?? '从未'}
              {doc.mirror.decks.length > 0 && <> · 镜象卡组：{doc.mirror.decks.join('、')}</>}
            </Text>
            {doc.due.by_deck.length > 0 && (
              <Space size={4} wrap>
                {doc.due.by_deck.map(d => <Tag key={d.deck} size='small' color='orange'>{d.deck} · 到期 {d.count}</Tag>)}
              </Space>
            )}
            <Space size={8} wrap>
              <Button type='primary' size='small' loading={busy === 'export'} onClick={() => void doExport()}>导出到 Anki</Button>
              <Button size='small' loading={busy === 'import'} onClick={() => void doImport()}>导入回写</Button>
              <Button size='small' type='text' onClick={() => void st.reload()}>刷新</Button>
            </Space>
            {lastImport && lastImport.unknown.length > 0 && (
              <Alert type='warning' className='lh-t-12'
                content={`有 ${lastImport.skipped_unknown} 条事件无法归属（已跳过不猜）：${lastImport.unknown.join('；')}`} />
            )}
            <Text type='secondary' className='lh-t-12 lh-block'>
              Anki 是纯作答通道：先「导出到 Anki」把到期卡推进镜象卡组，在 Anki 里作答后再「导入回写」——vault 按自己的调度器重算（回写先于下次导出，刚答过的卡不会被重复推送）。
            </Text>
          </Space>
        )}
      </CommandBoundary>
    </Card>
  )
}
