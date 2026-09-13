/** 壳顶栏（#205 / ADR-0058）：五区页签（今日/课程/洞察/项目/无界实践区）+ 课程区
 * 子导航（图/队列/提案/题库四入口，T5 成型三入口）+ 右侧通知铃铛位（不可用态，
 * 实现属 #164 池票）、帮助抽屉入口（能力指南退役于此）与亮暗切换。
 * 区键表（ZONE_KEYS）与子路由表（COURSE_SUBS）住在 lib/router——本组件的
 * TabPane 键与子导航项字面量表由 tests/ui-router.test.ts 三表门对账。 */
import { Badge, Button, Tabs, Tooltip } from '@arco-design/web-react'
import type { CourseSub, ZoneKey } from '../lib/router'

/** 课程区子导航项（T1 四入口 = 现有页原样挂入；标题即原页签名，T5 重塑）。 */
export const COURSE_SUB_ITEMS: Array<{ key: CourseSub; title: string }> = [
  { key: 'graph', title: '学习图' },
  { key: 'queue', title: '生成' },
  { key: 'proposals', title: '提案' },
  { key: 'bank', title: '题目管理' },
]

export function ShellTopBar(props: {
  zone: ZoneKey
  courseSub: CourseSub
  theme: 'light' | 'dark'
  onZone: (z: ZoneKey) => void
  onCourseSub: (s: CourseSub) => void
  onToggleTheme: () => void
  onOpenHelp: () => void
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', borderBottom: '1px solid var(--color-border-2,#e5e6eb)' }}>
        <Tabs activeTab={props.zone} onChange={k => props.onZone(k as ZoneKey)} type='capsule' size='small'
          style={{ flex: 1, padding: '8px 12px 0' }}>
          <Tabs.TabPane key='today' title='今日' />
          <Tabs.TabPane key='courses' title='课程' />
          <Tabs.TabPane key='insight' title='洞察' />
          <Tabs.TabPane key='projects' title='项目' />
          <Tabs.TabPane key='practice' title='无界实践区' />
        </Tabs>
        <div style={{ margin: '10px 12px 0 0', flexShrink: 0, display: 'flex', gap: 4 }}>
          {/* 铃铛通知中心：壳位预留（ADR-0058），实现属 #164 池票——不可用态带说明。
           * 图标占位与主题钮同款文本形：Arco 内置图标全量 index 会撑 bundle，T2 视觉层再换具名图标。 */}
          <Tooltip content='通知中心在建：升级落地前此处留位（属池票 #164）'>
            <Button size='mini' type='text' disabled><Badge dot>🔔</Badge></Button>
          </Tooltip>
          <Button size='mini' type='text' onClick={props.onOpenHelp}>? 指南</Button>
          <Button size='mini' type='text' onClick={props.onToggleTheme}
            title={props.theme === 'dark' ? '切到亮色' : '切到暗色'}>
            {props.theme === 'dark' ? '☀ 亮色' : '☾ 暗色'}
          </Button>
        </div>
      </div>
      {props.zone === 'courses' && (
        <Tabs activeTab={props.courseSub} onChange={k => props.onCourseSub(k as CourseSub)}
          type='text' size='small' style={{ padding: '2px 12px 0', borderBottom: '1px solid var(--color-border-1,#f2f3f5)' }}>
          {COURSE_SUB_ITEMS.map(it => <Tabs.TabPane key={it.key} title={it.title} />)}
        </Tabs>
      )}
    </div>
  )
}
