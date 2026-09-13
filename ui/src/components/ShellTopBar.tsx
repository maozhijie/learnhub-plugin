/** 壳顶栏（#205 / ADR-0058；#206 起视觉由 token 层驱动）：五区页签（今日/课程/
 * 洞察/项目/无界实践区）+ 课程区子导航（图/队列/提案/题库四入口，T5 成型三入口）
 * + 右侧通知铃铛位（不可用态，实现属 #164 池票）、帮助抽屉入口（能力指南退役于
 * 此）与亮暗切换。图标用 Arco 内置（icon 入口具名导入、vite tree-shake）。
 * 区键表（ZONE_KEYS）与子路由表（COURSE_SUBS）住在 lib/router——本组件的
 * TabPane 键与子导航项字面量表由 tests/ui-router.test.ts 三表门对账。 */
import { Badge, Button, Tabs, Tooltip } from '@arco-design/web-react'
import { IconMoon, IconNotification, IconQuestionCircle, IconSun } from '@arco-design/web-react/icon'
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
    <div className='shell-topbar'>
      <Tabs className='shell-zones' activeTab={props.zone} onChange={k => props.onZone(k as ZoneKey)} type='capsule' size='small'>
        <Tabs.TabPane key='today' title='今日' />
        <Tabs.TabPane key='courses' title='课程' />
        <Tabs.TabPane key='insight' title='洞察' />
        <Tabs.TabPane key='projects' title='项目' />
        <Tabs.TabPane key='practice' title='无界实践区' />
      </Tabs>
      <div className='shell-controls'>
        {/* 铃铛通知中心：壳位预留（ADR-0058），实现属 #164 池票——不可用态带说明 */}
        <Tooltip content='通知中心在建：升级落地前此处留位（属池票 #164）'>
          <Button size='mini' type='text' disabled aria-label='通知中心（未开放）'
            icon={<Badge dot><IconNotification /></Badge>} />
        </Tooltip>
        <Button size='mini' type='text' onClick={props.onOpenHelp} aria-label='能力指南'
          icon={<IconQuestionCircle />}>指南</Button>
        <Button size='mini' type='text' onClick={props.onToggleTheme}
          aria-label={props.theme === 'dark' ? '切到亮色' : '切到暗色'}
          icon={props.theme === 'dark' ? <IconSun /> : <IconMoon />} />
      </div>
    </div>
  )
}
