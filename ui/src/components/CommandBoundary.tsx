/** 三态呈现组件（#158「失败不伪装」约定的缝级收口，#183）：同一份加载/失败/内容
 * 判定全面板一个长相，不再逐页手抄。空态不在这里——由调用方在 children 里派生
 * （#187 决议④：缝只供给三态，业务空态是渲染层的事）。
 * 已有数据后的后台刷新失败不进来（data 非 null 直接渲染内容）——错误保留在
 * cmd.error，由调用方决定是否轻提示。 */
import { Button, Result, Spin } from '@arco-design/web-react'
import type { ReactNode } from 'react'
import type { Command } from '../hooks/useCommand'

export function CommandBoundary<T>({ cmd, onRetry, variant = 'card', title = '加载失败',
  loadingText = '加载中…', loadingNode, children }: {
  cmd: Command<T>
  /** 失败态的重试入口（缺省用 cmd.reload）。 */
  onRetry?: () => void
  /** card = 卡片内联长相（轻量文本 + 重试）；page = 整页 Result（首载失败）。 */
  variant?: 'card' | 'page'
  /** page 变体的 Result 标题。 */
  title?: string
  loadingText?: string
  /** 加载态自定义渲染（缺省：card = 次要文本；page = 居中 Spin）。 */
  loadingNode?: ReactNode
  children: (data: T) => ReactNode
}) {
  const { data, loading, error, reload } = cmd
  if (data !== null) return <>{children(data)}</>
  const retry = onRetry ?? (() => { void reload() })
  if (loading) {
    if (loadingNode) return <>{loadingNode}</>
    return variant === 'page'
      ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spin dot /></div>
      : <span style={{ color: 'var(--color-text-3,#86909c)' }}>{loadingText}</span>
  }
  if (variant === 'page') {
    return (
      <Result status='error' title={title} subTitle={error ?? '宿主暂不可达'}
        extra={<Button type='primary' onClick={retry}>重试</Button>} />
    )
  }
  return (
    <span style={{ color: 'var(--color-danger-6,#f53f3f)' }}>
      {error ?? '加载失败'}{' '}
      <Button size='mini' type='text' onClick={retry}>重试</Button>
    </span>
  )
}
