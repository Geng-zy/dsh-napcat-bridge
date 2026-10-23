#!/usr/bin/env node
// 端到端测试：真实的 dsh web 加载本插件，假的 DeepSeek 接口回答模型请求，
// 假的 NapCat 作为客户端连插件的反向 WebSocket。
//
// 检查：Token 缺失 401、错误 403；私聊直接交给模型并用 send_private_msg 回复；
// 群里不 @ 不回；@ 机器人会回（@ 用 get_group_member_info 查名片）；唤醒前缀 / 会被去掉；
// 引用机器人的消息会唤醒（用 get_msg 取被引用消息）；QQ 管家的消息被忽略。
//
// 需要：DSH_BIN 指向 dsh 可执行文件（或 dsh 在 PATH 上），先 pnpm run build。
// 不联网、不需要真实 API Key。用法：node test/e2e.mjs（退出码 0 = 通过）
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import WebSocket from 'ws'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'e2e-token'
const USER = 123450001
const BOT = 123450009
const GROUP = 888000001
const WS_PORT = 18000 + Math.floor(Math.random() * 1000)
const deadline = Date.now() + Number(process.env.E2E_TIMEOUT_MS ?? 180_000)

const log = (...a) => console.log('[e2e]', ...a)
let finished = false
const fail = async message => { console.error('[e2e] FAIL: ' + message); await cleanup(); process.exit(1) }

// ---- 假 DeepSeek（Anthropic Messages 流式），回复 = "回复:" + 最后一条用户消息的第一个文字块
const modelRequests = []
const lastUserText = json => {
  const user = [...(json.messages ?? [])].reverse().find(m => m.role === 'user')
  if (!user) return ''
  const content = typeof user.content === 'string' ? [{ type: 'text', text: user.content }] : user.content
  // dsh 会在后面追加环境信息块，QQ 消息是第一个文字块
  return content.find(b => b.type === 'text')?.text ?? ''
}
const llm = createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not found"}}')
      return
    }
    const json = JSON.parse(body || '{}')
    const text = lastUserText(json)
    modelRequests.push(text)
    const reply = '回复:' + text
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const ev = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n')
    ev('message_start', { message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: json.model ?? 'e2e', content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } })
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
    ev('message_stop', {})
    res.end()
  })
})
await new Promise(r => llm.listen(0, '127.0.0.1', r))
const llmUrl = 'http://127.0.0.1:' + llm.address().port + '/anthropic'

// ---- 独立的 DSH_HOME，本仓库作为 profile bundle
const home = mkdtempSync(join(tmpdir(), 'dsh-napcat-e2e-'))
const profile = join(home, 'profiles', 'web')
mkdirSync(join(profile, 'node_modules'), { recursive: true })
symlinkSync(ROOT, join(profile, 'node_modules', 'dsh-napcat-bridge'), 'dir')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-napcat-bridge'] } },
  dependencies: { 'dsh-napcat-bridge': 'link:' + ROOT },
}, null, 2))
const workspace = join(home, 'workspace')
mkdirSync(workspace)
writeFileSync(join(profile, 'cordis.patch.yml'), `- id: napcat-bridge
  config:
    ws_reverse_host: 127.0.0.1
    ws_reverse_port: ${WS_PORT}
    ws_reverse_token: ${TOKEN}
    workspacePath: ${workspace}
    logLevel: debug
`)

const dsh = spawn(process.env.DSH_BIN ?? 'dsh', ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'sk-e2e-fake', DEEPSEEK_BASE_URL: llmUrl, DSH_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let dshLog = ''
for (const s of [dsh.stdout, dsh.stderr]) s.on('data', d => { dshLog += d; if (process.env.E2E_VERBOSE) process.stdout.write(d) })
dsh.on('exit', code => { if (!finished) void fail('dsh 提前退出 (' + code + ')\n' + dshLog.slice(-4000)) })

async function cleanup() {
  finished = true
  if (dsh.exitCode === null && dsh.signalCode === null) {
    const exited = new Promise(resolve => dsh.once('exit', resolve))
    try { dsh.kill('SIGTERM') } catch {}
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 15_000))])
    if (dsh.exitCode === null && dsh.signalCode === null) try { dsh.kill('SIGKILL') } catch {}
  }
  llm.close()
  if (!process.env.E2E_KEEP) rmSync(home, { recursive: true, force: true })
}

// ---- 假 NapCat
const url = 'ws://127.0.0.1:' + WS_PORT + '/ws'
const headers = token => ({
  'X-Self-ID': String(BOT),
  'X-Client-Role': 'Universal',
  ...(token === undefined ? {} : { Authorization: 'Bearer ' + token }),
})
async function dial(token) {
  for (;;) {
    if (Date.now() > deadline) await fail('插件的 WS 一直没起来\n' + dshLog.slice(-4000))
    const result = await new Promise(resolve => {
      const ws = new WebSocket(url, { headers: headers(token) })
      ws.once('open', () => resolve({ ws }))
      ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }))
      ws.once('error', error => resolve({ error }))
    })
    if (result.error?.code === 'ECONNREFUSED') { await new Promise(r => setTimeout(r, 500)); continue }
    return result
  }
}

const noToken = await dial(undefined)
if (noToken.status !== 401) await fail('没带 Token 应该 401，实际 ' + JSON.stringify(noToken.status ?? noToken))
const badToken = await dial('wrong')
if (badToken.status !== 403) await fail('Token 错误应该 403，实际 ' + JSON.stringify(badToken.status ?? badToken))
log('Token 校验正常（401/403）')

const { ws } = await dial(TOKEN)
if (!ws) await fail('Token 正确却连不上')
log('已连接')

const calls = []
const sent = []
const history = new Map()
let nextMsgId = 1000
ws.on('message', raw => {
  const req = JSON.parse(String(raw))
  if (!req.action) return
  calls.push(req)
  let data = null
  if (req.action === 'send_private_msg' || req.action === 'send_group_msg') {
    sent.push(req)
    data = { message_id: nextMsgId++ }
  } else if (req.action === 'get_group_member_info') {
    data = { user_id: req.params.user_id, card: req.params.user_id === BOT ? '大肥鱼' : '', nickname: 'nick' + req.params.user_id }
  } else if (req.action === 'get_stranger_info') {
    data = { user_id: req.params.user_id, nickname: '陌生人' + req.params.user_id }
  } else if (req.action === 'get_msg') {
    data = history.get(req.params.message_id) ?? null
  }
  ws.send(JSON.stringify({ status: data === null && req.action === 'get_msg' ? 'failed' : 'ok', retcode: 0, data, echo: req.echo }))
})

const event = e => ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: BOT, ...e }))
const privateMsg = (message, user = USER) => event({
  post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: nextMsgId++, user_id: user,
  message, raw_message: '', font: 0, sender: { user_id: user, nickname: '主人' },
})
const groupMsg = message => event({
  post_type: 'message', message_type: 'group', sub_type: 'normal', message_id: nextMsgId++, group_id: GROUP, user_id: USER,
  message, raw_message: '', font: 0, sender: { user_id: USER, nickname: '主人', card: '群名片' },
})
const text = t => ({ type: 'text', data: { text: t } })
const at = qq => ({ type: 'at', data: { qq: String(qq) } })

async function waitFor(pred, what, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = pred()
    if (hit) return hit
    await new Promise(r => setTimeout(r, 200))
  }
  await fail('等不到：' + what + '\n已发出：' + JSON.stringify(sent) + '\n模型收到：' + JSON.stringify(modelRequests) + '\n' + dshLog.slice(-3000))
}
const sentText = req => req.params.message.filter(s => s.type === 'text').map(s => s.data.text).join('')

// 1. 私聊：直接交给模型，send_private_msg 回复
privateMsg([text('  你好呀  ')])
const r1 = await waitFor(() => sent.find(s => s.action === 'send_private_msg'), '私聊回复')
if (r1.params.user_id !== USER) await fail('私聊回复发错人：' + JSON.stringify(r1.params))
if (sentText(r1) !== '回复:你好呀') await fail('私聊回复内容不对：' + sentText(r1))
if (!r1.params.self_id) await fail('私聊回复应带 self_id 路由：' + JSON.stringify(r1.params))
log('私聊 OK：' + sentText(r1))

// 2. 群里不 @：不交给模型
const before = modelRequests.length
groupMsg([text('大家好')])
await new Promise(r => setTimeout(r, 3000))
if (modelRequests.length !== before) await fail('群里没 @ 也交给了模型')
if (sent.some(s => s.action === 'send_group_msg')) await fail('群里没 @ 也回复了')
log('群里不 @ 不回 OK')

// 3. 群里 @ 机器人：唤醒；第一个 @ 机器人不进文字
groupMsg([at(BOT), text(' 在吗')])
const r3 = await waitFor(() => sent.find(s => s.action === 'send_group_msg'), '群 @ 回复')
if (r3.params.group_id !== GROUP) await fail('群回复发错群：' + JSON.stringify(r3.params))
if (sentText(r3) !== '回复:在吗') await fail('群 @ 回复内容不对：' + sentText(r3))
if (!calls.some(c => c.action === 'get_group_member_info' && c.params.user_id === BOT)) await fail('@ 没有查群名片')
log('群 @ OK：' + sentText(r3))

// 4. 唤醒前缀 / 被去掉；@ 别人（名片为空）时查 get_stranger_info，文字里写成 @昵称(QQ)
const groupSentBefore = sent.filter(s => s.action === 'send_group_msg').length
groupMsg([text('/问一下'), at(555), text('是谁')])
const r4 = await waitFor(() => sent.filter(s => s.action === 'send_group_msg')[groupSentBefore], '唤醒前缀回复')
if (!modelRequests.some(t => t.includes('问一下 @陌生人555(555) 是谁'))) await fail('模型收到的文字不对：' + JSON.stringify(modelRequests.slice(-2)))
if (!calls.some(c => c.action === 'get_stranger_info' && c.params.user_id === 555)) await fail('名片为空时没查 get_stranger_info')
log('唤醒前缀 OK：' + sentText(r4))

// 5. 引用机器人的消息：get_msg 取回被引用消息，sender 是机器人 → 唤醒
history.set(4242, { message_id: 4242, message_type: 'group', group_id: GROUP, self_id: BOT, time: 1, sender: { user_id: BOT, nickname: '大肥鱼' }, message: [text('我是上一条')] })
const groupSentBefore5 = sent.filter(s => s.action === 'send_group_msg').length
groupMsg([{ type: 'reply', data: { id: '4242' } }, text('接着说')])
await waitFor(() => sent.filter(s => s.action === 'send_group_msg')[groupSentBefore5], '引用回复')
if (!calls.some(c => c.action === 'get_msg' && c.params.message_id === 4242)) await fail('引用没有调 get_msg')
log('引用机器人唤醒 OK')

// 6. QQ 管家的消息被忽略
const before6 = modelRequests.length
privateMsg([text('管家消息')], 2854196310)
await new Promise(r => setTimeout(r, 3000))
if (modelRequests.length !== before6) await fail('QQ 管家的消息被交给了模型')
log('QQ 管家屏蔽 OK')

log('全部通过')
ws.close()
await cleanup()
process.exit(0)
