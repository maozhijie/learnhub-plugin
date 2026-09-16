/** 概念足迹分栏（#268）：引用面的第一张人类面孔——词条档（canonical/别名/定义/
 * confusable，缺失如实呈现）+ 教学面（谁 teaches/assumes）+ 题目面（invokes 分布）
 * + 漂移面三类（孤儿/悬空 confusable/单向 confusable，恒全表派生）。只读：无写按钮、
 * 无直改入口——写侧治理走提案门（ADR-0084），本视图只把读数摆给人看。子串发现是
 * 发现机制不是存在性判定：空 ≠ 不存在，换宽词或读全表（ADR-0077 归因分层口径）。 */
import { Card, Empty, Input, Spin, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { ConceptFootprintDoc } from '../../types'

const { Text, Title } = Typography

/** 漂移面区块：类别 + 明细行（空类不渲染——零噪音）。 */
function DriftBlock({ label, rows }: { label: string; rows: string[] }) {
  if (!rows.length) return null
  return (
    <div className='lh-mb-8'>
      <Text className='lh-t-12'>{label}（{rows.length}）</Text>
      <div>{rows.map(r => <div key={r}><Text type='secondary' className='lh-t-12'>{r}</Text></div>)}</div>
    </div>
  )
}

/** 单条概念：词条档 + 三面。缺失字段不假装有（无定义/无别名/无易混各自如实）。 */
function ConceptItem({ e }: { e: ConceptFootprintDoc['rows'][number] }) {
  const maxInvokes = Math.max(1, ...e.invokes.map(i => i.count))
  return (
    <div className='lh-mb-8' data-testid='concept-item'>
      <div className='lh-row lh-gap-8 lh-wrap'>
        <Title heading={6} className='lh-m-0'>{e.canonical}</Title>
        {e.deprecated && <Tag color='gray' size='small'>已废弃（地址仍解析，已退出生成注入与候选面）</Tag>}
        {e.orphan && <Tag color='orange' size='small'>孤儿（足迹空）</Tag>}
      </div>
      <Text type='secondary' className='lh-t-12 lh-block'>
        {e.aliases.length ? `别名：${e.aliases.join('、')}` : '（无别名）'}
      </Text>
      <Text className='lh-t-12 lh-block'>{e.definition ?? '（无定义）'}</Text>
      <Text className='lh-t-12 lh-block'>
        {e.confusable.length
          ? <>易混指向：{e.confusable.join('、')}
            {e.danglingConfusable.length > 0 && (
              <Text type='error' className='lh-t-12'>（悬空：{e.danglingConfusable.join('、')} 不在册——消费侧静默降级）</Text>
            )}
          </>
          : '（无易混声明）'}
      </Text>
      <Text className='lh-t-12 lh-block'>
        教学面：teaches {e.teachers.length ? e.teachers.join('、') : '（无节点教它）'}｜assumes {e.assumers.length ? e.assumers.join('、') : '（无节点假设它）'}
      </Text>
      {e.unreciprocated.length > 0 && (
        <Text type='warning' className='lh-t-12 lh-block'>
          单向易混：{e.unreciprocated.join('、')} 未回指本条（中性事实，是否补声明由人判）
        </Text>
      )}
      {e.invokes.length ? (
        <div>
          <Text className='lh-t-12 lh-block'>题目 invokes 分布：</Text>
          {e.invokes.map(i => (
            <div key={i.node} className='lh-row lh-gap-8' data-testid='invokes-row'>
              <Text className='lh-t-12 lh-minw-80'>{i.node}</Text>
              <div className='lh-bar-track'>
                <div className='lh-bar-fill' style={{ width: `${Math.round(i.count / maxInvokes * 100)}%` }} />
              </div>
              <Text type='secondary' className='lh-t-12'>×{i.count}</Text>
            </div>
          ))}
        </div>
      ) : (
        <Text type='secondary' className='lh-t-12 lh-block'>题目 invokes：（无在库题标注它——合法空态）</Text>
      )}
    </div>
  )
}

export default function ConceptFootprintColumn({ course }: { course: string }) {
  const [doc, setDoc] = useState<ConceptFootprintDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.conceptFootprint(course, query || undefined)
      .then(d => { if (alive) { setDoc(d); setError(null) } })
      .catch(err => { if (alive) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [course, query])

  if (error) {
    return (
      <Card size='small' title='概念足迹' className='lh-card'>
        <Text type='error'>加载失败：{error}</Text>
      </Card>
    )
  }
  return (
    <Card
      size='small' title='概念足迹' className='lh-card'
      extra={
        <Input.Search
          allowClear placeholder='子串发现（命中 canonical 或别名）'
          value={input} onChange={v => { setInput(v); if (v === '') setQuery('') }}
          onSearch={v => setQuery(v.trim())}
          className='lh-w-260'
        />
      }
    >
      <Text type='secondary' className='lh-t-12 lh-block lh-mb-8'>
        只读视图：引用面的读数折叠。写侧治理（合并/改名/易混收编）走提案门，本栏无直改入口。
      </Text>
      <Text type='secondary' className='lh-t-12 lh-block lh-mb-8'>
        子串发现只供找候选——空 ≠ 不存在：无命中时换宽词再试，或不带关键词读全表。
      </Text>
      {loading && !doc ? <Spin /> : !doc ? null : (
        <>
          <div className='lh-mb-8' data-testid='drift-panel'>
            <Text className='lh-t-12'>漂移面（恒全表派生，不随搜索收窄）：孤儿 {doc.drift.orphans.length}｜悬空 confusable {doc.drift.dangling.length}｜单向 confusable {doc.drift.oneWay.length}</Text>
            <DriftBlock label='孤儿（足迹空：无节点教/假设、无题 invokes）' rows={doc.drift.orphans} />
            <DriftBlock label='悬空 confusable（声明了不在册的指向）' rows={doc.drift.dangling.map(d => `${d.from} → ${d.to}`)} />
            <DriftBlock label='单向 confusable（对方未回指）' rows={doc.drift.oneWay.map(d => `${d.from} → ${d.to}`)} />
          </div>
          <Text type='secondary' className='lh-t-12 lh-block lh-mb-8'>
            {doc.matched}/{doc.total} 条{doc.query ? `，query=「${doc.query}」` : '（全表）'}
          </Text>
          {doc.matched === 0
            ? <Empty description={doc.total ? '无命中条目——空 ≠ 不存在：换宽词，或清空关键词读全表' : '登记表为空（合法空态：概念铸名随生长批提案落盘）'} />
            : doc.rows.map(e => <ConceptItem key={e.canonical} e={e} />)}
        </>
      )}
    </Card>
  )
}
