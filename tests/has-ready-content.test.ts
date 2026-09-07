import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultFrontmatter, hasReadyContent } from '../src/engine/notes.ts'
import type { Fm } from '../src/engine/types.ts'

// ---- hasReadyContent：列表/图三态「已生成」标识的数据源 ----
// 语义：节清单里至少一节 ready = 点开有东西读（部分完成的中断产物也算）。

const fmWith = (sections: Array<{ status: string }> | undefined): Fm => ({
  ...defaultFrontmatter('N'),
  content: {
    ...defaultFrontmatter('N').content,
    ...(sections ? { sections: sections as Fm['content']['sections'] } : {}),
  },
})

test('hasReadyContent：无节清单/全 pending = 未生成；任一 ready = 已生成', () => {
  assert.equal(hasReadyContent(undefined), false)
  assert.equal(hasReadyContent(fmWith(undefined)), false)
  assert.equal(hasReadyContent(fmWith([])), false)
  assert.equal(hasReadyContent(fmWith([{ status: 'pending' }])), false)
  assert.equal(hasReadyContent(fmWith([{ status: 'pending' }, { status: 'ready' }])), true)
  assert.equal(hasReadyContent(fmWith([{ status: 'ready' }])), true)
})
