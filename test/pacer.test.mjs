// 单元测试：发消息的节奏（打字速度、群里的发言频率、同一会话按顺序、等太久不发）。
// 用法：node --test test/（先 pnpm run build）
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Pacer, rateDelay, typingDelay } from '../lib/pacer.js'

const S = { typingPrivate: true, typingGroup: true, charsPerMinute: 20, typingMinSeconds: 2, typingMaxSeconds: 30, groupMinGapSeconds: 5, groupMaxPerWindow: 3, groupWindowSeconds: 60, maxWaitSeconds: 120 }

test('打字速度：一分钟 20 个字时 5 个字等 15 秒；有最短、最长；关掉不等；空白不算字', () => {
  assert.equal(typingDelay('你好呀朋友', false, S), 15_000)
  assert.equal(typingDelay('嗯', false, S), 3_000)
  assert.equal(typingDelay('嗯', false, { ...S, typingMinSeconds: 5 }), 5_000, '最短 5 秒')
  assert.equal(typingDelay('字'.repeat(200), true, S), 30_000, '最长 30 秒')
  assert.equal(typingDelay('你 好\n呀', false, S), 9_000)
  assert.equal(typingDelay('你好', true, { ...S, typingGroup: false }), 0)
  assert.equal(typingDelay('你好', false, { ...S, charsPerMinute: 0 }), 0)
})

test('群里的发言频率：两条之间至少隔几秒；一分钟最多几条', () => {
  assert.equal(rateDelay([], 100_000, S), 0)
  assert.equal(rateDelay([98_000], 100_000, S), 3_000, '离上一条才 2 秒，再等 3 秒')
  assert.equal(rateDelay([50_000, 70_000, 90_000], 100_000, S), 10_000, '一分钟里已经 3 条，等最早那条出窗口')
  assert.equal(rateDelay([30_000, 70_000, 90_000], 100_000, { ...S, groupMinGapSeconds: 0 }), 0, '最早那条已经出窗口')
})

function fakeClock() {
  let t = 1_000_000
  const waits = []
  return { now: () => t, sleep: async ms => { waits.push(ms); t += ms }, waits, advance: ms => { t += ms } }
}

test('排队：同一个群按顺序发，守频率；等太久就不发；私聊不受群频率限制', async () => {
  const c = fakeClock()
  const logs = []
  const p = new Pacer({ settings: () => ({ ...S, typingGroup: false, typingPrivate: false, maxWaitSeconds: 30 }), log: (l, m) => logs.push(m), now: c.now, sleep: c.sleep })
  const out = []
  const send = text => async () => { out.push([text, c.now()]) }
  const results = await Promise.all(['一', '二', '三', '四'].map(x => p.run('napcat:GroupMessage:1', true, x, send(x))))
  assert.deepEqual(out.map(o => o[0]), ['一', '二', '三'])
  assert.deepEqual(results, ['sent', 'sent', 'sent', 'dropped'], '第四条要等将近一分钟，超过 30 秒就不发')
  assert.equal(out[1][1] - out[0][1], 5_000, '两条之间隔 5 秒')
  assert.ok(logs.some(m => m.includes('太频繁')))
  for (const x of ['a', 'b', 'c', 'd']) assert.equal(await p.run('napcat:FriendMessage:2', false, x, send(x)), 'sent')
})

test('打字等待和发送顺序：长的先排就先发', async () => {
  const c = fakeClock()
  const p = new Pacer({ settings: () => S, log: () => {}, now: c.now, sleep: c.sleep })
  const out = []
  await Promise.all([p.run('u', false, '这是一句比较长的话', async () => { out.push('长') }), p.run('u', false, '短', async () => { out.push('短') })])
  assert.deepEqual(out, ['长', '短'])
  assert.deepEqual(c.waits, [27_000, 3_000])
})
