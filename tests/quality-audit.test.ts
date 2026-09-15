/**
 * 图质量面审计抽样（#224 / ADR-0070 §图质量面）：教练回合裁决质量的审计面声明、系统性
 * 发现候选与跨表对账——票面验收「审计可跑出报告」的引擎侧证据（实跑报告由宿主运行器产出，
 * 见 tests/quality-review-runner.test.ts）。#256 种子链退役后「种子/终点资格」轴与「种子·终点」
 * 量规一并删除。
 *
 * 本文件同时是一道**跨表对账门**：审计面清单（AUDIT_AXES）里的站、量规、维度必须真的在
 * 语料站名词表与量规注册表里——三张表漂移（量规改了维度 id、站改名）时审计不会静默跑空。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_AXES,
  QUALITY_RUBRICS,
  RUBRIC_COURTS,
  SYSTEMIC_LOW_RATE,
  SYSTEMIC_MIN_SAMPLES,
  auditScopeLines,
  rubricForStation,
  systemicCandidates,
} from '../src/engine/index.ts'
import type { DimensionStat, LowScoreItem } from '../src/engine/index.ts'
import { STATIONS } from '../src/host/corpus.ts'

const CRITERIA_OF = (station: string, dimension: string): Array<{ id: string; source: string }> => {
  const rubric = rubricForStation(station, QUALITY_RUBRICS)
  const dim = rubric?.dimensions.find(d => d.id === dimension)
  return (dim?.criteria ?? []).map(c => ({ id: c.id, source: c.source }))
}

/** 一条分布读数（只填候选判据用得到的字段）。 */
function stat(over: Partial<DimensionStat> = {}): DimensionStat {
  return {
    station: '教练生长', dimension: '算子语义', dimensionName: '算子与结构语义',
    counts: [0, 0, 0, 0], na: 0, scored: 2, low: 2, noEvidence: 0, unlocated: 0,
    ...over,
  }
}

function low(over: Partial<LowScoreItem> = {}): LowScoreItem {
  return {
    ref: '教练生长/bad-桩.md', station: '教练生长', dimension: '算子语义', dimensionName: '算子与结构语义',
    score: 2, evidence: ['ops: - add_node: Python 基础语法'], notes: '批规模超限', templateVersion: 5, revised: false,
    ...over,
  }
}

test('审计面清单：站名在语料词表、量规与维度在注册表——三张表漂移即红（审计不会静默跑空）', () => {
  const stations = new Set(Object.values(STATIONS))
  assert.equal(AUDIT_AXES.length, 1, '种子轴退役后仅存教练回合裁决质量轴（#256）')
  for (const axis of AUDIT_AXES) {
    for (const s of axis.stations) assert.ok(stations.has(s), `审计面的站「${s}」不在语料站名词表`)
    const rubric = QUALITY_RUBRICS.find(r => r.id === axis.rubric)
    assert.ok(rubric, `审计面声明的量规「${axis.rubric}」不在注册表`)
    for (const s of axis.stations) {
      assert.equal(rubricForStation(s, QUALITY_RUBRICS)?.id, axis.rubric, `站「${s}」实际命中的量规不是「${axis.rubric}」`)
    }
    for (const d of axis.dimensions) {
      assert.ok(rubric!.dimensions.some(x => x.id === d.id), `量规「${axis.rubric}」没有维度「${d.id}」`)
      assert.ok(d.focus.trim(), `审计面维度「${d.id}」必须写看点（报告开场声明用）`)
    }
  }
})

test('审计面声明：逐轴列出（含看点）；未抽到样本的轴照实说「本轮无样本」', () => {
  const lines = auditScopeLines({
    sampling: { corpusDir: 'C:/桩', stations: ['教练生长'], pool: 3, selected: 3, quota: { bad: 3, ok: 2 } },
    stats: [stat()],
    rubricIds: ['教练回合'],
  })
  const text = lines.join('\n')
  assert.ok(text.includes('审计面声明'))
  assert.ok(text.includes('教练回合裁决质量'), '轴在册')
  assert.ok(text.includes('已判 2 件次'), '在册轴的判读件次带出')
  assert.ok(text.includes('算子选择 + 理由 vs 图面'), '看点进声明')
})

test('系统性发现候选：低分率越预注册线才入候选；低分件引用与判据出处随候选带出（贴票用）', () => {
  const belowLine = stat({ dimension: '生长纪律', scored: 4, low: 1 })
  const aboveLine = stat({ scored: 2, low: 2 })
  const tooFew = stat({ dimension: '裁决与路线', scored: 1, low: 1 })
  const candidates = systemicCandidates([belowLine, aboveLine, tooFew], [low(), low({ ref: '教练生长/bad-桩2.md' })], CRITERIA_OF)
  assert.equal(candidates.length, 1, '只有越线维度入候选（样本不足/低分率不够都不入）')
  const c = candidates[0]!
  assert.equal(c.station, '教练生长')
  assert.equal(c.dimension, '算子语义')
  assert.equal(c.low, 2)
  assert.equal(c.scored, 2)
  assert.deepEqual(c.refs, ['教练生长/bad-桩.md', '教练生长/bad-桩2.md'], '低分件引用齐备')
  assert.ok(c.criteria.length >= 1, '判据出处带出（改量规/开票的定位锚）')
  assert.ok(c.criteria.every(x => x.id && x.source), '判据条目 id 与出处都不空')
  assert.equal(SYSTEMIC_MIN_SAMPLES, 2)
  assert.equal(SYSTEMIC_LOW_RATE, 0.5)
})

test('系统性发现候选：阈值可覆盖（人审可调预注册线）；候选是提议（分层法庭随报告带出）', () => {
  const stats = [stat({ scored: 4, low: 2 })]
  assert.equal(systemicCandidates(stats, [low()], CRITERIA_OF).length, 1, '默认线 2/4 = 50% 入候选')
  assert.equal(systemicCandidates(stats, [low()], CRITERIA_OF, { lowRate: 0.6 }).length, 0, '线抬到 60% 即不入')
  assert.equal(systemicCandidates(stats, [low()], CRITERIA_OF, { minSamples: 5 }).length, 0, '样本量线抬到 5 即不入')
  assert.ok(RUBRIC_COURTS.ai.includes('提议'), '分层法庭声明在册（AI 评分 = 提议）')
})

test('候选为空是合法读数：无越线维度（报告写「无候选 ≠ 无问题」，不假装审计通过）', () => {
  assert.deepEqual(systemicCandidates([stat({ scored: 4, low: 0 })], [], CRITERIA_OF), [])
})
