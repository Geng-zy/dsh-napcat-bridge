// 单元测试：桥接（白名单、管理员、指令、只 @ 等待、频率限制、提示、按类型选预设、语音转文字）。
// 用法：node --test test/（先 pnpm run build）
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { AiocqhttpAdapter } from '../lib/adapter.js'
import { Bridge, formatNow } from '../lib/bridge.js'
import { SessionStore } from '../lib/store.js'

const BOT = 10001
const ADMIN = '42'

function settings(over = {}) {
  return {
    cwd: '/tmp',
    wake: { wakePrefix: ['/'], ignoreBotSelfMessage: false, friendMessageNeedsWakePrefix: false },
    identifier: true, imageToModel: false, maxImages: 0,
    admins: [ADMIN],
    whitelist: { enabled: true, ids: [], ignoreAdminOnGroup: true, ignoreAdminOnFriend: true, log: false },
    rateLimit: { count: 0, seconds: 60, strategy: 'stall' },
    emptyMention: { waiting: true, needReply: true },
    uniqueSession: false,
    reminder: { datetime: false, timezone: 'Asia/Shanghai', groupName: false, markAdmin: false },
    commands: { enabled: true, noPermissionReply: true },
    presets: { default: '', private: '', group: '', adminPrivate: '' },
    models: { private: '', group: '', adminPrivate: '' },
    stt: { mode: 'off', command: '', apiUrl: '', apiKey: '', model: '' },
    ...over,
  }
}

/** 搭一个桥：假的 agent 注册表记下每次 followup，假的 NapCat 记下发出的消息。 */
function harness(over = {}, api = {}) {
  const followups = []
  const created = []
  const sent = []
  let s = settings(over)
  const agents = {
    create: async opts => {
      created.push(opts)
      const sessionId = String(opts.sessionId)
      return {
        agent: {
          session: { id: sessionId },
          followup: m => followups.push({ sessionId, text: m.content.map(c => c.text ?? '').join('\n') }),
          cancel: () => followups.push({ sessionId, cancelled: true }),
        },
        dispose: async () => {},
      }
    },
    resume: async () => { throw new Error('不该恢复') },
  }
  let bridge
  const adapter = new AiocqhttpAdapter({ id: 'napcat', ws_reverse_host: '127.0.0.1', ws_reverse_port: 0, log: () => {}, onMessage: (abm, ev) => bridge.handle(abm, ev) })
  adapter.bot.callAction = async (action, params) => {
    if (action === 'send_private_msg' || action === 'send_group_msg') {
      sent.push({ action, text: params.message.map(m => m.data.text ?? '').join('') })
      return { message_id: 1 }
    }
    if (action in api) return api[action](params)
    throw new Error('unexpected ' + action)
  }
  adapter.bot.sendPrivateMsg = p => adapter.bot.callAction('send_private_msg', p)
  adapter.bot.sendGroupMsg = p => adapter.bot.callAction('send_group_msg', p)
  bridge = new Bridge({
    agents,
    defaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek', model: 'default-model' }) }),
    presets: () => ({ mount: async () => ({}) }),
    persistence: () => undefined,
    attachments: () => undefined,
    callAction: (a, p) => adapter.bot.callAction(a, p),
    onSessionEvent: () => () => {},
    emit: () => {},
    settings: () => s,
    store: new SessionStore(join(mkdtempSync(join(tmpdir(), 'napcat-store-')), 'sessions.json')),
    log: () => {},
  })
  let id = 100
  const send = async (ev) => {
    const abm = await adapter.convertMessage({ self_id: BOT, time: 1700000000, message_id: id++, ...ev })
    if (abm) await bridge.handle(abm, adapter.createEvent(abm))
  }
  const privateMsg = (user, message) => send({ post_type: 'message', message_type: 'private', user_id: user, sender: { user_id: user, nickname: 'n' + user }, message })
  const groupMsg = (user, group, message, role = 'member') => send({ post_type: 'message', message_type: 'group', group_id: group, group_name: '测试群', user_id: user, sender: { user_id: user, nickname: 'n' + user, card: '', role }, message })
  return { followups, created, sent, privateMsg, groupMsg, set: next => { s = settings({ ...over, ...next }) } }
}
const text = t => ({ type: 'text', data: { text: t } })
const at = qq => ({ type: 'at', data: { qq: String(qq) } })
const memberInfo = { get_group_member_info: p => ({ card: p.user_id === BOT ? '鱼' : '' }), get_stranger_info: () => ({ nickname: '路人' }) }

test('白名单：不在名单的群和私聊不交给模型；管理员不受限制；私聊可以写 QQ 号', async () => {
  const h = harness({ whitelist: { enabled: true, ids: ['555', '77'], ignoreAdminOnGroup: true, ignoreAdminOnFriend: true, log: false } }, memberInfo)
  await h.groupMsg(9, 666, [at(BOT), text('不在名单')])
  await h.privateMsg(8, [text('不在名单')])
  assert.equal(h.followups.length, 0)
  await h.groupMsg(9, 555, [at(BOT), text('在名单的群')])
  await h.privateMsg(77, [text('在名单的私聊')])
  await h.privateMsg(Number(ADMIN), [text('管理员私聊')])
  await h.groupMsg(Number(ADMIN), 666, [at(BOT), text('管理员在别的群')])
  assert.equal(h.followups.length, 4)
})

test('白名单为空或关闭时不检查', async () => {
  const h = harness({}, memberInfo)
  await h.privateMsg(8, [text('谁都行')])
  assert.equal(h.followups.length, 1)
})

test('指令：/help /sid 回复，不交给模型；/new 换新会话', async () => {
  const h = harness({}, memberInfo)
  await h.privateMsg(8, [text('你好')])
  await h.privateMsg(8, [text('/help')])
  await h.privateMsg(8, [text('/sid')])
  assert.equal(h.followups.length, 1)
  assert.match(h.sent[0].text, /可用指令/)
  assert.match(h.sent[1].text, /会话标识：napcat:FriendMessage:8/)
  await h.privateMsg(8, [text('/new')])
  assert.match(h.sent[2].text, /新的对话/)
  await h.privateMsg(8, [text('再说一句')])
  assert.equal(h.created.length, 2)
  assert.notEqual(String(h.created[0].sessionId), String(h.created[1].sessionId))
})

test('指令：群里 /new 只有管理员、群主、群管理能用', async () => {
  const h = harness({}, memberInfo)
  await h.groupMsg(9, 555, [text('/new')])
  assert.match(h.sent.at(-1).text, /只有管理员/)
  await h.groupMsg(9, 555, [text('/new')], 'admin')
  assert.match(h.sent.at(-1).text, /新的对话/)
})

test('只 @ 她不说话：先让她问一句，这个人 60 秒内的下一条算唤醒', async () => {
  const h = harness({}, memberInfo)
  await h.groupMsg(9, 555, [at(BOT)])
  assert.equal(h.followups.length, 1)
  assert.match(h.followups[0].text, /只是通过@来唤醒你/)
  await h.groupMsg(9, 555, [text('帮我看看这个')])
  assert.equal(h.followups.length, 2)
  assert.match(h.followups[1].text, /帮我看看这个/)
  await h.groupMsg(9, 555, [text('这条不 @ 不该唤醒')])
  assert.equal(h.followups.length, 2)
})

test('频率限制：丢弃模式超出后不交给模型', async () => {
  const h = harness({ rateLimit: { count: 2, seconds: 60, strategy: 'discard' } }, memberInfo)
  for (let i = 0; i < 4; i += 1) await h.privateMsg(8, [text('第' + i + '条')])
  assert.equal(h.followups.length, 2)
})

test('提示：时间、群名、管理员身份写进 <system_reminder>', async () => {
  const h = harness({ reminder: { datetime: true, timezone: 'Asia/Shanghai', groupName: true, markAdmin: true } }, memberInfo)
  await h.groupMsg(Number(ADMIN), 555, [at(BOT), text('几点了')])
  const t = h.followups[0].text
  assert.match(t, /<system_reminder>Sender role: admin \(QQ 42\)\nGroup name: 测试群\nCurrent datetime: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\), Weekday: \w+day<\/system_reminder>/)
})

test('时间格式', () => {
  assert.equal(formatNow('Asia/Shanghai', new Date('2026-10-23T13:40:00Z')), '2026-10-23 21:40 (GMT+8), Weekday: Friday')
})

test('按聊天类型选预设和模型：管理员私聊 > 私聊/群聊 > 默认', async () => {
  const h = harness({
    presets: { default: 'base', private: '', group: 'group-p', adminPrivate: 'owner-p' },
    models: { private: '', group: 'deepseek/flash-low', adminPrivate: '' },
  }, memberInfo)
  await h.privateMsg(Number(ADMIN), [text('主人')])
  await h.privateMsg(8, [text('别人私聊')])
  await h.groupMsg(9, 555, [at(BOT), text('群里')])
  assert.deepEqual(h.created.map(c => c.meta.agentPreset), ['owner-p', 'base', 'group-p'])
  assert.deepEqual(h.created.map(c => c.agentOptions.model), ['default-model', 'default-model', 'flash-low'])
})

test('群里每人单独会话', async () => {
  const h = harness({ uniqueSession: true }, memberInfo)
  await h.groupMsg(9, 555, [at(BOT), text('a')])
  await h.groupMsg(10, 555, [at(BOT), text('b')])
  assert.equal(new Set(h.created.map(c => String(c.sessionId))).size, 2)
  assert.match(String(h.created[0].sessionId), /9-555/)
})

test('语音：关闭时写 [语音]；本机命令方式转成文字', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-'))
  const script = join(dir, 'fake-stt.sh')
  writeFileSync(script, '#!/bin/sh\necho "今天吃什么"\n')
  chmodSync(script, 0o755)
  const api = { ...memberInfo, get_record: () => ({ base64: Buffer.from('RIFFfake').toString('base64') }) }
  const h = harness({}, api)
  await h.privateMsg(8, [{ type: 'record', data: { file: 'a.amr' } }])
  assert.equal(h.followups[0].text, '[语音]')
  h.set({ stt: { mode: 'command', command: script + ' {file}', apiUrl: '', apiKey: '', model: '' } })
  await h.privateMsg(8, [{ type: 'record', data: { file: 'b.amr' } }])
  assert.equal(h.followups[1].text, '[语音] 今天吃什么')
})
