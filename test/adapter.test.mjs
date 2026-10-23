// 单元测试：消息转换和发送格式与 AstrBot aiocqhttp 适配器一致。
// 用法：node --test test/（先 pnpm run build）
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AiocqhttpAdapter, AiocqhttpMessageEvent, MessageType, Plain, At, make, toDict } from '../lib/index.js'

const BOT = 10001
const quiet = () => {}

/** 不启动服务器，替换 callAction 来模拟 NapCat。 */
function adapterWith(api) {
  const a = new AiocqhttpAdapter({ id: 'napcat', ws_reverse_host: '127.0.0.1', ws_reverse_port: 0, log: quiet, onMessage: () => {} })
  a.bot.callAction = async (action, params) => {
    if (!(action in api)) throw new Error('unexpected ' + action)
    return api[action](params)
  }
  return a
}

const groupEvent = message => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, message_id: 7, group_id: 555, user_id: 42,
  sender: { user_id: 42, nickname: '昵称', card: '' }, message,
})

test('文字相邻段合并、去空白；发送者名片为空时用昵称', async () => {
  const a = adapterWith({})
  const abm = await a.convertMessage(groupEvent([{ type: 'text', data: { text: ' 你' } }, { type: 'text', data: { text: '好 ' } }]))
  assert.equal(abm.message_str, '你好')
  assert.deepEqual(abm.message, [{ type: 'Plain', text: '你好', convert: true }])
  assert.equal(abm.sender.nickname, '昵称')
  assert.equal(abm.type, MessageType.GROUP_MESSAGE)
  assert.equal(abm.session_id, '555')
  assert.equal(abm.message_id, '7')
  assert.deepEqual(abm.group, { group_id: '555', group_name: undefined })
})

test('@：第一个 @ 机器人不进文字，其余写成 " @名片(QQ) "；名片为空查陌生人昵称', async () => {
  const a = adapterWith({
    get_group_member_info: p => ({ card: p.user_id === BOT ? '鱼' : '' }),
    get_stranger_info: () => ({ nickname: '路人' }),
  })
  const abm = await a.convertMessage(groupEvent([
    { type: 'at', data: { qq: String(BOT) } },
    { type: 'at', data: { qq: '9' } },
    { type: 'text', data: { text: 'hi' } },
  ]))
  assert.equal(abm.message_str, ' @路人(9) hi')
  assert.deepEqual(abm.message.slice(0, 2), [
    { type: 'At', qq: String(BOT), name: '鱼' },
    { type: 'At', qq: '9', name: '路人' },
  ])
})

test('@全体成员：At(qq=all, name=全体成员)，不查接口', async () => {
  const a = adapterWith({})
  const abm = await a.convertMessage(groupEvent([{ type: 'at', data: { qq: 'all' } }]))
  assert.deepEqual(abm.message, [{ type: 'At', qq: 'all', name: '全体成员' }])
  assert.equal(abm.message_str, '')
})

test('引用：get_msg 取回后转成 Reply（只取一层）', async () => {
  const a = adapterWith({
    get_msg: () => ({ message_id: 3, message_type: 'group', group_id: 555, self_id: BOT, sender: { user_id: BOT, nickname: '鱼' }, message: [{ type: 'text', data: { text: '原话' } }] }),
  })
  const abm = await a.convertMessage(groupEvent([{ type: 'reply', data: { id: '3' } }]))
  const r = abm.message[0]
  assert.equal(r.type, 'Reply')
  assert.equal(r.id, '3')
  assert.equal(r.sender_id, String(BOT))
  assert.equal(r.message_str, '原话')
  assert.deepEqual(r.chain, [{ type: 'Plain', text: '原话', convert: true }])
})

test('引用失败时退回 Reply(**data)', async () => {
  const a = adapterWith({ get_msg: () => { throw new Error('x') } })
  const abm = await a.convertMessage(groupEvent([{ type: 'reply', data: { id: '3' } }]))
  assert.equal(abm.message[0].type, 'Reply')
  assert.equal(abm.message[0].id, '3')
  assert.deepEqual(abm.message[0].chain, [])
})

test('NapCat 文件：get_group_file_url 换下载地址', async () => {
  const a = adapterWith({ get_group_file_url: () => ({ url: 'https://f/x' }) })
  const abm = await a.convertMessage(groupEvent([{ type: 'file', data: { file: 'a.txt', file_id: 'id1' } }]))
  assert.deepEqual(abm.message, [{ type: 'File', name: 'a.txt', file_: '', url: 'https://f/x' }])
})

test('图片只保留 AstrBot 声明的字段；mface 丢弃；markdown 当文字；未知类型忽略', async () => {
  const a = adapterWith({})
  const abm = await a.convertMessage(groupEvent([
    { type: 'image', data: { file: 'a.jpg', url: 'https://img', summary: '[图片]', sub_type: 0 } },
    { type: 'mface', data: { summary: '[表情]' } },
    { type: 'markdown', data: { content: '**粗**' } },
    { type: 'longmsg', data: {} },
  ]))
  assert.deepEqual(abm.message, [
    { type: 'Image', file: 'a.jpg', _type: '', url: 'https://img', path: '' },
    { type: 'Plain', text: '**粗**', convert: true },
  ])
  assert.equal(abm.message_str, '**粗**')
})

test('QQ 管家的消息返回 null', async () => {
  const a = adapterWith({})
  const ev = groupEvent([{ type: 'text', data: { text: 'x' } }])
  ev.sender.user_id = 2854196310
  assert.equal(await a.convertMessage(ev), null)
})

test('通知：戳一戳转成 Poke；sender 昵称就是 QQ 号', async () => {
  const a = adapterWith({})
  const abm = await a.convertMessage({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: BOT, user_id: 42, target_id: BOT, group_id: 555 })
  assert.deepEqual(abm.message, [{ type: 'Poke', _type: '126', id: String(BOT), qq: 0 }])
  assert.deepEqual(abm.sender, { user_id: '42', nickname: '42' })
  assert.equal(abm.message_str, '')
  assert.equal(abm.message_id.length, 32)
})

test('发送：At 后补空格，空白 Plain 跳过；群聊 send_group_msg 带 self_id', async () => {
  const calls = []
  const bot = { sendGroupMsg: async p => calls.push(['group', p]), sendPrivateMsg: async p => calls.push(['private', p]) }
  await AiocqhttpMessageEvent.sendMessage(bot, { chain: [At({ qq: 9 }), Plain('  '), Plain('好')] }, { self_id: BOT }, true, '555')
  assert.deepEqual(calls, [['group', {
    group_id: 555,
    self_id: BOT,
    message: [{ type: 'at', data: { qq: '9' } }, { type: 'text', data: { text: ' ' } }, { type: 'text', data: { text: '好' } }],
  }]])
})

test('toDict：默认去掉 None、_type 改名 type、类型小写', () => {
  assert.deepEqual(toDict(make('Face', { id: 14 })), { type: 'face', data: { id: 14 } })
  assert.deepEqual(toDict(make('Reply', { id: 5 })), { type: 'reply', data: { id: '5' } })
  assert.deepEqual(toDict(make('Image', { file: 'x' })), { type: 'image', data: { file: 'x', type: '', url: '', path: '' } })
})
