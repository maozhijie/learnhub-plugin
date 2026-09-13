/** 我的课程（课程区首屏，#209 / ADR-0058 T5）：课程卡的正式新家——「今天学什么」
 * 由今日页的推荐流回答，「所有课」在这里。空 vault = 建课入口（教练台空课形态，
 * #154/#159 既裁的全面板唯一主动建课入口）；有课 = 课程卡网格（打开图 → 单课工作台
 * 首屏）。逐课复习会话由 CourseCardGrid 内聚拉起（T4 既有语义）。 */
import { Card, Space, Typography } from '@arco-design/web-react'
import CoachCockpit from '../../components/CoachCockpit'
import CourseCardGrid from '../../components/CourseCardGrid'
import type { AppFrame } from '../../App'

const { Text } = Typography

export default function CoursesPage({ frame }: { frame: AppFrame }) {
  const noCourses = !frame.tree || frame.tree.courses.length === 0
  if (noCourses) {
    return (
      <Space direction='vertical' className='lh-full' size={12}>
        <Card>
          <Text type='secondary'>还没有课程——在这里新建：种子一次人审即开工，图随教练回合沿真实的需要生长。</Text>
        </Card>
        {/* 空 vault：驾驶舱仍然可达——建课从这里开始（种子提案一次人审即开工） */}
        <CoachCockpit course={null} />
      </Space>
    )
  }
  return (
    <Space direction='vertical' className='lh-full' size={12}>
      <CourseCardGrid frame={frame} />
    </Space>
  )
}
