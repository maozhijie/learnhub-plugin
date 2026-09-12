/** 统计页·自评校准画像卡（ADR-0022 #104；数据源 GET /calibration/profile，缝在 index.tsx）：
 * 分源视图为主（v1 源 = JOL 预测 × 实际作答；构念效度：域特异成分显著），
 * 全局聚合折叠为参考视图并带「域特异」警戒标注；过信检出时给证据说明。
 * 画像只展示给学习者——不进 Mastery/XP，永不折扣自评对调度的驱动（红线）。 */
import { Alert, Card, Collapse, Space, Tag, Typography } from '@arco-design/web-react'
import { EMPTY_HINT } from './MemoryHealth'
import type { CalibrationProfileDoc } from '../../types'

const { Text } = Typography

export default function CalibrationProfileCard({ profile }: { profile: CalibrationProfileDoc }) {
  const SOURCE_LABEL: Record<string, string> = { jol: '源：JOL 预测 × 实际作答' }
  return (
    <Card size='small' title='自评校准画像' style={{ borderRadius: 10 }}
      extra={<Text type='secondary' style={{ fontSize: 12 }}>分源自省面——只展示给你的画像，不进任何成绩度量</Text>}>
      <Space direction='vertical' style={{ width: '100%' }} size={14}>
        {profile.sources.map(s => (
          <div key={s.source}>
            <Space size={8} style={{ marginBottom: 4 }}>
              <Text style={{ fontWeight: 600 }}>{SOURCE_LABEL[s.source] ?? `源：${s.source}`}</Text>
              {s.overconfidence.overconfident && s.overconfidence.evidence && (
                <Tag size='small' color='orange'>系统性过信</Tag>
              )}
            </Space>
            {s.calibration ? (
              <>
                <Text type='secondary' style={{ fontSize: 12 }}>
                  （翻面前抽查预测「会/不会/没把握」与实际对错的对照，共 {s.calibration.pairs} 条配对；
                  只统计被抽到的卡，不代表全部复习）
                </Text>
                <div style={{ display: 'grid', gap: 3, marginTop: 6 }}>
                  {s.calibration.bins.filter(b => b.n > 0).map(b => (
                    <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Text type='secondary' style={{ fontSize: 11, width: 70, flexShrink: 0 }}>预测 {b.label}</Text>
                      <div style={{ flex: 1, height: 8, background: 'var(--color-fill-2,#f2f3f5)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{
                          width: `${(b.accuracy ?? 0) * 100}%`, height: '100%',
                          background: 'var(--color-warning-4,#ffb65d)',
                        }} />
                      </div>
                      <Text style={{ fontSize: 11, width: 84, textAlign: 'right' }}>
                        实际 {b.accuracy === null ? '—' : `${Math.round(b.accuracy * 100)}%`}（{b.n} 条{b.forgot ? ` · 忘 ${b.forgot}` : ''}）
                      </Text>
                    </div>
                  ))}
                </div>
                {s.overconfidence.overconfident && s.overconfidence.evidence && (
                  <Alert type='warning' style={{ fontSize: 12, marginTop: 6 }}
                    content={`「会」档实际正确率 ${Math.round(s.overconfidence.evidence.accuracy * 100)}%（${s.overconfidence.evidence.n} 条抽查），低于显著阈值 ${Math.round(s.overconfidence.evidence.threshold * 100)}%——预测偏乐观：复习时不妨按「没把握」处理这些卡，预测出口也会轻提醒你。`} />
                )}
              </>
            ) : (
              <Text type='secondary' style={{ fontSize: 12, display: 'block' }}>
                {EMPTY_HINT}（该源的预测配对攒够 10 条后显示，低数据不造假曲线）
              </Text>
            )}
          </div>
        ))}
        {/* 全局聚合 = 参考视图：折叠次要展示，警戒标注必须随视图带出（ADR-0022 裁决 2） */}
        <Collapse bordered={false}>
          <Collapse.Item name='global' header={
            <Space size={6}>
              <Text type='secondary' style={{ fontSize: 12 }}>全局聚合（参考视图）</Text>
              <Tag size='small' color='gray'>域特异，仅供参考</Tag>
            </Space>
          }>
            <Text type='secondary' style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>{profile.global.warning}</Text>
            {profile.global.calibration ? (
              <div style={{ display: 'grid', gap: 3 }}>
                {profile.global.calibration.bins.filter(b => b.n > 0).map(b => (
                  <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Text type='secondary' style={{ fontSize: 11, width: 70, flexShrink: 0 }}>预测 {b.label}</Text>
                    <div style={{ flex: 1, height: 8, background: 'var(--color-fill-2,#f2f3f5)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{
                        width: `${(b.accuracy ?? 0) * 100}%`, height: '100%',
                        background: 'var(--color-fill-3,#e5e6eb)',
                      }} />
                    </div>
                    <Text style={{ fontSize: 11, width: 84, textAlign: 'right' }}>
                      实际 {b.accuracy === null ? '—' : `${Math.round(b.accuracy * 100)}%`}（{b.n} 条）
                    </Text>
                  </div>
                ))}
              </div>
            ) : (
              <Text type='secondary' style={{ fontSize: 12 }}>{EMPTY_HINT}</Text>
            )}
          </Collapse.Item>
        </Collapse>
      </Space>
    </Card>
  )
}
