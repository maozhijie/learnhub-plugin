import test from 'node:test'
import assert from 'node:assert/strict'
import type { LearnhubEngine } from '../src/engine/index.ts'
import { withVault } from './helpers/vault.ts'

async function withRegistry(registryYaml: string | null, run: (engine: LearnhubEngine) => Promise<void>): Promise<void> {
  await withVault({ registry: registryYaml, graph: null }, ({ engine }) => run(engine))
}

const VALID = [
  'courses:',
  '  - id: math-01',
  '    name: 数学',
  '    root: math',
  '    enabled: true',
  '    tags: [stem, 必修]',
].join('\n')

test('#6 missing registry remains a legal empty course list', async () => {
  await withRegistry(null, async engine => {
    assert.deepEqual(await engine.enabledCourses(), [])
    await assert.rejects(() => engine.resolveCourse(), /没有启用中的课程/)
  })
})

test('#6 valid registry loads all entries in order', async () => {
  await withRegistry([
    'courses:',
    '  - name: 数学',
    '    root: math',
    '  - id: phys-01',
    '    name: 物理',
    '    root: physics',
    '    enabled: false',
    '    tags: [理科]',
  ].join('\n'), async engine => {
    const courses = await engine.registry.load()
    assert.deepEqual(courses, [
      { name: '数学', root: 'math' },
      { id: 'phys-01', name: '物理', root: 'physics', enabled: false, tags: ['理科'] },
    ])
  })
})

test('#6 malformed registry YAML fails loudly instead of becoming an empty list', async () => {
  await withRegistry('courses:\n  - name: "数学\n', async engine => {
    await assert.rejects(() => engine.enabledCourses(), /注册表 Broken.*YAML 无法解析/s)
  })
})

test('#6 registry failing top-level or entry contract throws with reasons', async () => {
  const cases: Array<[string, RegExp]> = [
    ['region: 基础\n', /courses: 必须是列表/],
    ['courses:\n  - name: 数学\n', /courses\.1\.root: 不能为空/],
    ['courses:\n  - { name: 数学, root: math }\n  - { name: 数学, root: other }\n', /courses\.2\.name: 与其他课程重复/],
    ['courses:\n  - { name: 数学, root: math }\n  - { name: 物理, root: math }\n', /courses\.2\.root: 与其他课程重复/],
    ['courses:\n  - { id: c1, name: 数学, root: math }\n  - { id: c1, name: 物理, root: physics }\n', /courses\.2\.id: 与其他课程重复/],
    ['courses:\n  - { id: "", name: 数学, root: math }\n', /courses\.1\.id: 不能为空/],
    ['courses:\n  - { name: 数学, root: math, enabled: "yes" }\n', /courses\.1\.enabled: 必须是布尔值/],
    ['courses:\n  - { name: 数学, root: math, tags: [1] }\n', /courses\.1\.tags: 必须是字符串列表/],
  ]
  for (const [yaml, pattern] of cases) {
    await withRegistry(yaml, async engine => {
      await assert.rejects(() => engine.enabledCourses(), pattern, `registry:\n${yaml}`)
    })
  }
})

test('#6 Data Check reports the same broken entries without consulting Registry reads', async () => {
  await withRegistry('courses:\n  - { name: 数学, root: math, enabled: 1 }\n', async engine => {
    const report = await engine.dataCheck()
    assert.equal(report.status, 'broken')
    assert.deepEqual(report.byArea.registry, { missing: 0, broken: 1, archived: 0, hint: 0 })
    assert.ok(report.findings.some(f => f.reason === 'registry_schema' && f.detail?.includes('enabled')))
  })
})
