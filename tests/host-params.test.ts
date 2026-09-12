import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ParamError,
  optBoolean,
  optFinite,
  optList,
  optNumber,
  optObject,
  optRaw,
  optString,
  optText,
  optTrimmed,
  optTrue,
  readArgs,
} from '../src/host/params.ts'

/** #185 可选参数 fail loud 的语义钉：键缺席 → 各守卫的省略语义；键在场但类型不符 →
 * `ParamError`（`非法可选参数：<key>（应为…）`），不再「非法即当省略」。
 * 值级 convenience 不变：空白文本仍按省略、显式 false 仍按未设——类型合法值上的既有语义。 */

test('可选文本（optText/optTrimmed）：缺席与空白仍按省略，类型不符即抛', () => {
  const b: Record<string, unknown> = { a: ' x ', blank: '   ', n: 123, nil: null }
  // 缺席 / 空白 → undefined（省略语义不变）
  assert.equal(optText(b, 'nope'), undefined)
  assert.equal(optText(b, 'blank'), undefined)
  assert.equal(optText(b, 'a'), ' x ', 'optText 带出原值不 trim')
  assert.equal(optTrimmed(b, 'a'), 'x', 'optTrimmed 带出 trim 值')
  // 在场但非字符串 → 抛（null 也是显式在场）
  assert.throws(() => optText(b, 'n'), (e: unknown) => e instanceof ParamError && /非法可选参数：n（应为字符串）/.test((e as Error).message))
  assert.throws(() => optTrimmed(b, 'nil'), (e: unknown) => e instanceof ParamError && /非法可选参数：nil（应为字符串）/.test((e as Error).message))
})

test('可选原样字符串/带缺省（optRaw/optString）：合法值照旧，类型不符即抛', () => {
  const b: Record<string, unknown> = { empty: '', s: 'v', n: 5 }
  assert.equal(optRaw(b, 'empty'), '', 'optRaw 空串也算在场合法值')
  assert.equal(optString(b, 'nope'), '', '缺省回落默认空串')
  assert.equal(optString(b, 'nope', 'fb'), 'fb', '缺省回落自定义')
  assert.equal(optString(b, 's'), 'v')
  assert.throws(() => optRaw(b, 'n'), /非法可选参数：n（应为字符串）/)
  assert.throws(() => optString(b, 'n'), /非法可选参数：n（应为字符串）/)
})

test('可选数字/布尔（optNumber/optFinite/optBoolean/optTrue）：类型不符即抛；false 仍按未设', () => {
  const b: Record<string, unknown> = { num: 3.5, inf: Infinity, strnum: '3', yes: true, no: false, str: 'true' }
  assert.equal(optNumber(b, 'nope'), undefined)
  assert.equal(optNumber(b, 'num'), 3.5)
  assert.throws(() => optNumber(b, 'strnum'), /非法可选参数：strnum（应为数字）/, '字符串数字不再被吞（required 侧的 Number 强转是另一条登记过的语义，可选侧按声明类型拒绝）')
  assert.equal(optFinite(b, 'inf'), undefined, '非有限数字仍是省略（JSON 到不了这个形态，沿用今天形状）')
  assert.throws(() => optFinite(b, 'strnum'), /非法可选参数：strnum（应为数字）/)
  assert.equal(optBoolean(b, 'yes'), true)
  assert.equal(optBoolean(b, 'no'), false)
  assert.throws(() => optBoolean(b, 'str'), /非法可选参数：str（应为布尔）/)
  // optTrue：显式方向旗标——true 算真、false/缺席算未设，其他类型在场即抛
  assert.equal(optTrue(b, 'yes'), true)
  assert.equal(optTrue(b, 'no'), false)
  assert.equal(optTrue(b, 'nope'), false)
  assert.throws(() => optTrue(b, 'str'), /非法可选参数：str（应为布尔）/)
})

test('可选对象/数组（optObject/optList）：数组算对象沿用今天形状，null 在场即抛', () => {
  const b: Record<string, unknown> = { obj: { a: 1 }, arr: [1, 2], nil: null, s: 'x' }
  assert.deepEqual(optObject(b, 'obj'), { a: 1 })
  assert.deepEqual(optObject(b, 'arr'), [1, 2], '数组也算对象（与今天 typeof 判定一致）')
  assert.deepEqual(optList(b, 'arr'), [1, 2])
  assert.equal(optObject(b, 'nope'), undefined)
  assert.equal(optList(b, 'nope'), undefined)
  assert.throws(() => optObject(b, 'nil'), /非法可选参数：nil（应为对象）/)
  assert.throws(() => optObject(b, 's'), /非法可选参数：s（应为对象）/)
  assert.throws(() => optList(b, 'obj'), /非法可选参数：obj（应为数组）/)
})

test('注册表驱动路径（readArgs）同样 fail loud：可选键类型不符抛 ParamError，缺席位传 undefined', () => {
  const args = {
    course: { type: 'string' as const, required: true },
    kind: { type: 'string' as const, read: 'raw' as const },
    limit: { type: 'number' as const },
  }
  const bind: Array<string | null> = ['course', 'kind', 'limit']
  // 合法：全参 / 缺可选
  assert.deepEqual(
    readArgs(args, {}, { kind: 'body', body: { course: 'c', kind: 'k', limit: 3 } }, bind),
    ['c', 'k', 3],
  )
  assert.deepEqual(
    readArgs(args, {}, { kind: 'body', body: { course: 'c' } }, bind),
    ['c', undefined, undefined],
  )
  // 非法：kind=123 今天等价于没传，现在必须拒绝
  assert.throws(
    () => readArgs(args, {}, { kind: 'body', body: { course: 'c', kind: 123 } }, bind),
    (e: unknown) => e instanceof ParamError && /非法可选参数：kind（应为字符串）/.test((e as Error).message),
  )
  assert.throws(
    () => readArgs(args, {}, { kind: 'body', body: { course: 'c', limit: '3' } }, bind),
    /非法可选参数：limit（应为数字）/,
  )
})
