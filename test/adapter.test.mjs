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

test('图片只保留 AstrBot 声明的字段；mface 有地址当普通图片；markdown 当文字；未知类型忽略', async () => {
  const a = adapterWith({})
  const abm = await a.convertMessage(groupEvent([
    { type: 'image', data: { file: 'a.jpg', url: 'https://img', summary: '[图片]', sub_type: 0 } },
    { type: 'mface', data: { summary: '[开心]', url: 'https://m/1.gif' } },
    { type: 'markdown', data: { content: '**粗**' } },
    { type: 'longmsg', data: {} },
  ]))
  assert.deepEqual(abm.message, [
    { type: 'Image', file: 'a.jpg', _type: '', url: 'https://img', path: '' },
    { type: 'Image', file: 'https://m/1.gif', _type: '', url: 'https://m/1.gif', path: '' },
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

// ---- v0.2.0 改动 ----

test('时间用 QQ 的发送时间', async () => {
  const a = adapterWith({})
  const ev = groupEvent([{ type: 'text', data: { text: 'x' } }])
  ev.time = 1700000000
  assert.equal((await a.convertMessage(ev)).timestamp, 1700000000)
})

test('同一条消息（self_id + message_id）只处理一次', async () => {
  const a = adapterWith({})
  const ev = groupEvent([{ type: 'text', data: { text: 'x' } }])
  assert.notEqual(await a.convertMessage(ev), null)
  assert.equal(await a.convertMessage({ ...ev }), null)
  assert.notEqual(await a.convertMessage({ ...ev, message_id: 8 }), null)
})

test('@ 的名片查询有缓存：同一个人第二次不再调接口', async () => {
  let calls = 0
  const a = adapterWith({ get_group_member_info: () => { calls += 1; return { card: '名片' } } })
  await a.convertMessage(groupEvent([{ type: 'at', data: { qq: '9' } }]))
  await a.convertMessage({ ...groupEvent([{ type: 'at', data: { qq: '9' } }]), message_id: 99 })
  assert.equal(calls, 1)
})

test('群名：事件没带时查 get_group_info 并缓存', async () => {
  let calls = 0
  const a = adapterWith({ get_group_info: () => { calls += 1; return { group_name: '测试群' } } })
  const abm = await a.convertMessage(groupEvent([{ type: 'text', data: { text: 'x' } }]))
  await a.convertMessage({ ...groupEvent([{ type: 'text', data: { text: 'y' } }]), message_id: 100 })
  assert.equal(abm.group.group_name, '测试群')
  assert.equal(calls, 1)
})

test('小黄脸写成 [表情:名字]；NapCat 商城表情（image 段带 emoji_id）当普通图片，不写名字', async () => {
  const a = adapterWith({})
  const abm = await a.convertMessage(groupEvent([
    { type: 'face', data: { id: '14' } },
    { type: 'image', data: { summary: '[狗头]', file: 'ab-cd.gif', url: 'https://gxh/raw300.gif', emoji_id: 'cd', emoji_package_id: 1 } },
    { type: 'image', data: { summary: '[图片]', file: 'p.jpg', url: 'https://img' } },
  ]))
  assert.equal(abm.message_str, '[表情:微笑]')
  assert.deepEqual(abm.message.map(c => c.type), ['Face', 'Image', 'Image'])
})

test('通知：进群写成一句话，名字查名片', async () => {
  const a = adapterWith({ get_group_member_info: p => ({ card: p.user_id === 42 ? '小明' : '群主' }) })
  const abm = await a.convertMessage({ post_type: 'notice', notice_type: 'group_increase', sub_type: 'invite', self_id: BOT, user_id: 42, operator_id: 1, group_id: 555, time: 1700000001 })
  assert.equal(abm.event_text, '小明(42) 加入了群（被邀请）（操作人 群主(1)）')
  assert.equal(abm.sender.nickname, '小明')
  assert.equal(abm.timestamp, 1700000001)
})

test('通知：撤回时带上被撤回的文字', async () => {
  const a = adapterWith({ get_group_member_info: () => ({ card: '小明' }) })
  await a.convertMessage(groupEvent([{ type: 'text', data: { text: '说错了' } }]))
  const abm = await a.convertMessage({ post_type: 'notice', notice_type: 'group_recall', self_id: BOT, user_id: 42, operator_id: 42, group_id: 555, message_id: 7 })
  assert.equal(abm.event_text, '小明(42) 撤回了一条消息：昵称(42)：说错了')
})

test('通知：戳机器人', async () => {
  const a = adapterWith({ get_stranger_info: () => ({ nickname: '路人' }) })
  const abm = await a.convertMessage({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: BOT, user_id: 42, target_id: BOT })
  assert.equal(abm.event_text, '路人(42) 戳了戳 机器人')
  assert.deepEqual(abm.message, [{ type: 'Poke', _type: '126', id: String(BOT), qq: 0 }])
})

test('请求：加好友带附言', async () => {
  const a = adapterWith({ get_stranger_info: () => ({ nickname: '路人' }) })
  const abm = await a.convertMessage({ post_type: 'request', request_type: 'friend', self_id: BOT, user_id: 42, comment: '你好', flag: 'f' })
  assert.equal(abm.event_text, '路人(42) 请求加好友，附言：你好')
})

test('图片格式按文件头判断', async () => {
  const { sniffImage } = await import('../lib/images.js')
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a')), 'image/gif')
  assert.equal(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBP')), 'image/webp')
  assert.equal(sniffImage(new TextEncoder().encode('hello')), undefined)
})

// ---- v0.4.0：引用和聊天记录 ----

test('引用：文字写成 <Quoted Message>(昵称): 内容，图片取出来', async () => {
  const { extractQuoted } = await import('../lib/quoted.js')
  const a = adapterWith({
    get_msg: () => ({ message_id: 3, message_type: 'group', group_id: 555, self_id: BOT, sender: { user_id: 42, nickname: '小明' }, message: [{ type: 'text', data: { text: '看这个' } }, { type: 'image', data: { file: 'a.jpg', url: 'https://img/a' } }] }),
  })
  const abm = await a.convertMessage(groupEvent([{ type: 'reply', data: { id: '3' } }, { type: 'text', data: { text: '笑死' } }]))
  const q = await extractQuoted(abm.message, (action, params) => a.bot.callAction(action, params))
  assert.equal(q.text, '<Quoted Message>\n(小明): 看这个[Image]\n</Quoted Message>')
  assert.deepEqual(q.imageRefs, ['https://img/a'])
})

test('引用聊天记录：get_forward_msg 逐层展开，记录里套着的记录也展开', async () => {
  const { extractQuoted } = await import('../lib/quoted.js')
  const calls = []
  const api = {
    get_msg: () => ({ message_id: 3, sender: { user_id: 42, nickname: '小明' }, message: [{ type: 'forward', data: { id: 'F1' } }] }),
    get_forward_msg: p => {
      calls.push(p)
      const id = p.message_id ?? p.id
      if (id === 'F1') return { messages: [
        { sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '第一层' } }] },
        { sender: { nickname: '乙' }, message: [{ type: 'forward', data: { id: 'F2' } }] },
      ] }
      if (id === 'F2') return { messages: [{ sender: { nickname: '丙' }, message: [{ type: 'text', data: { text: '第二层' } }, { type: 'image', data: { url: 'https://img/f2' } }] }] }
      return null
    },
  }
  const callAction = async (action, params) => api[action](params)
  const message = [{ type: 'Reply', id: '3', chain: [{ type: 'Forward', id: 'F1' }], sender_id: '42', sender_nickname: '小明', time: 0, message_str: '', text: '', qq: 0, seq: 0 }]
  const q = await extractQuoted(message, callAction)
  assert.equal(q.text, '<Quoted Message>\n(小明): 甲: 第一层\n丙: 第二层[Image]\n</Quoted Message>')
  assert.deepEqual(q.imageRefs, ['https://img/f2'])
  assert.equal(calls.length, 2)
})

test('引用里已有文字（不只是聊天记录占位）时直接用，不再展开', async () => {
  const { extractQuoted } = await import('../lib/quoted.js')
  const message = [{ type: 'Reply', id: '', chain: [{ type: 'Plain', text: '原话' }, { type: 'At', qq: '9', name: '小红' }], sender_nickname: '小明', message_str: '' }]
  const q = await extractQuoted(message, async () => { throw new Error('不应调用') })
  assert.equal(q.text, '<Quoted Message>\n(小明): 原话@小红\n</Quoted Message>')
})

test('直接发来的聊天记录也展开成 <Forward Message>', async () => {
  const { extractForwards } = await import('../lib/quoted.js')
  const callAction = async () => ({ messages: [{ sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '你好' } }] }] })
  const f = await extractForwards([{ type: 'Forward', id: 'F9' }], callAction)
  assert.equal(f.text, '<Forward Message>\n甲: 你好\n</Forward Message>')
})

test('小黄脸名字表：新表情和旧表情都能认出来', async () => {
  const a = adapterWith({})
  const abm = await a.convertMessage(groupEvent([
    { type: 'face', data: { id: '354' } },
    { type: 'face', data: { id: '507' } },
    { type: 'face', data: { id: '54' } },
    { type: 'face', data: { id: '99999' } },
  ]))
  assert.equal(abm.message_str, '[表情:尊嘟假嘟][表情:被发现了][表情:闪电][表情:99999]')
})
