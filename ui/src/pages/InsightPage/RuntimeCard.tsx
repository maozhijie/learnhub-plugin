/** 洞察区·运行环境卡（模型透明；#210 自实验室页迁入）：当前 LLM 配置只读展示——
 * 面板看得见自己正在用哪个模型/思考档；切换走宿主机器级配置（面板不改运行环境）。
 * 词条与口径照旧（GuidePage「怎么跟 agent 协作」指向本卡）。 */
import { Card, Space, Tag, Typography } from '@arco-design/web-react'
import type { AppFrame } from '../../App'

const { Text } = Typography

export default function RuntimeCard({ frame }: { frame: AppFrame }) {
  return (
    <Card size='small' title='运行环境' className='lh-card'>
      {frame.status?.llm ? (
        <Space size={8} wrap>
          <Tag size='small' color='arcoblue'>{frame.status.llm.provider} / {frame.status.llm.model}</Tag>
          <Text type='secondary' className='lh-t-12'>
            思考档：常规 {frame.status.llm.fast_effort} · 高难 {frame.status.llm.deep_effort}；生成任务注册表逐条记录所用模型
          </Text>
          <Text type='secondary' className='lh-t-12'>
            切换模型：编辑 ~/.dsh/profiles/web/cordis.patch.yml 的 dsh-learnhub 行（provider/model/fastEffort/deepEffort）后重启宿主生效
          </Text>
        </Space>
      ) : (
        <Text type='secondary' className='lh-t-12'>运行环境信息随状态加载后展示。</Text>
      )}
    </Card>
  )
}
