// 移植自 AstrBot（AGPL-3.0-or-later）：
//   astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py
//   astrbot/core/platform/sources/aiocqhttp/aiocqhttp_message_event.py
//   astrbot/core/platform/astrbot_message.py、message_type.py
// 只把消息的去向从 AstrBot 事件队列换成 onMessage 回调，转换和发送逻辑保持原样。

import { randomUUID } from 'node:crypto'
import { CQHttp, type Logger } from './onebot/server.js'
import { eventFromPayload, type OneBotEvent } from './onebot/event.js'
import { ActionFailed } from './onebot/errors.js'
import {
  At, ComponentTypes, File, Plain, Poke, convertToBase64, make, toDict, toDictAsync, toFileUri,
  type Component, type MessageChain,
} from './components.js'

export enum MessageType {
  GROUP_MESSAGE = 'GroupMessage',
  FRIEND_MESSAGE = 'FriendMessage',
  OTHER_MESSAGE = 'OtherMessage',
}

/** MessageMember */
export interface MessageMember {
  user_id: string
  nickname: string | null
}

/** Group */
export interface Group {
  group_id: string
  group_name?: string | null
  group_avatar?: string | null
  group_owner?: string | null
  group_admins?: string[] | null
  members?: MessageMember[] | null
  member_count?: number | null
}

/** AstrBotMessage */
export interface AstrBotMessage {
  type: MessageType
  self_id: string
  session_id: string
  message_id: string
  group: Group | null
  sender: MessageMember
  message: Component[]
  message_str: string
  raw_message: OneBotEvent
  timestamp: number
}

/** MessageSesion：platform_name:message_type:session_id */
export interface MessageSession {
  platform_name: string
  message_type: MessageType
  session_id: string
}

export function sessionToString(s: MessageSession): string {
  return s.platform_name + ':' + s.message_type + ':' + s.session_id
}

export function groupId(abm: AstrBotMessage): string {
  return abm.group ? abm.group.group_id : ''
}

export interface AdapterOptions {
  /** platform_config.id */
  id: string
  ws_reverse_host: string
  ws_reverse_port: number
  ws_reverse_token?: string
  log: Logger
  /** handle_msg → commit_event 的替代：转换好的消息交给这里。 */
  onMessage: (abm: AstrBotMessage, event: AiocqhttpMessageEvent) => void | Promise<void>
}

const nowSec = (): number => Math.floor(Date.now() / 1000)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** AiocqhttpAdapter */
export class AiocqhttpAdapter {
  readonly bot: CQHttp
  readonly id: string
  private host: string
  private port: number
  private readonly log: Logger
  private readonly onMessage: AdapterOptions['onMessage']

  constructor(options: AdapterOptions) {
    this.id = options.id
    this.host = options.ws_reverse_host
    this.port = options.ws_reverse_port
    this.log = options.log
    this.onMessage = options.onMessage
    this.bot = new CQHttp({ accessToken: options.ws_reverse_token, apiTimeoutSec: 180, log: options.log })

    this.bot.onRequest()(async event => {
      try {
        const abm = await this.convertMessage(event)
        if (!abm) return
        await this.handleMsg(abm)
      } catch (e) {
        this.log('error', 'Handle request message failed: ' + errText(e))
      }
    })
    this.bot.onNotice()(async event => {
      try {
        const abm = await this.convertMessage(event)
        if (abm) await this.handleMsg(abm)
      } catch (e) {
        this.log('error', 'Handle notice message failed: ' + errText(e))
      }
    })
    this.bot.onMessage('group')(async event => {
      try {
        const abm = await this.convertMessage(event)
        if (abm) await this.handleMsg(abm)
      } catch (e) {
        this.log('error', 'Handle group message failed: ' + errText(e))
      }
    })
    this.bot.onMessage('private')(async event => {
      try {
        const abm = await this.convertMessage(event)
        if (abm) await this.handleMsg(abm)
      } catch (e) {
        this.log('error', 'Handle private message failed: ' + errText(e))
      }
    })
    this.bot.onWebsocketConnection(() => {
      this.log('info', 'aiocqhttp(OneBot v11) 适配器已连接。')
    })
  }

  /** send_by_session */
  async sendBySession(session: MessageSession, messageChain: MessageChain): Promise<void> {
    const isGroup = session.message_type === MessageType.GROUP_MESSAGE
    const sessionId = isGroup ? session.session_id.split('_').at(-1)! : session.session_id
    await AiocqhttpMessageEvent.sendMessage(this.bot, messageChain, null, isGroup, sessionId, this.log)
  }

  /** convert_message */
  async convertMessage(event: OneBotEvent): Promise<AstrBotMessage | null> {
    this.log('debug', '[aiocqhttp] RawMessage ' + JSON.stringify(event))
    let abm: AstrBotMessage | null = null
    if (event.post_type === 'message') {
      abm = await this.convertHandleMessageEvent(event)
      if (abm.sender.user_id === '2854196310') {
        // 屏蔽 QQ 管家的消息
        return null
      }
    } else if (event.post_type === 'notice') {
      abm = await this.convertHandleNoticeEvent(event)
    } else if (event.post_type === 'request') {
      abm = await this.convertHandleRequestEvent(event)
    }
    return abm
  }

  /** _convert_handle_request_event：OneBot V11 请求类事件 */
  async convertHandleRequestEvent(event: OneBotEvent): Promise<AstrBotMessage> {
    const sender = { user_id: String(event.user_id), nickname: String(event.user_id) }
    const isGroup = Boolean(event.group_id)
    return {
      self_id: String(event.self_id),
      sender,
      type: isGroup ? MessageType.GROUP_MESSAGE : MessageType.FRIEND_MESSAGE,
      group: isGroup ? { group_id: String(event.group_id) } : null,
      session_id: isGroup ? String(event.group_id) : sender.user_id,
      message_str: '',
      message: [],
      timestamp: nowSec(),
      message_id: randomUUID().replace(/-/g, ''),
      raw_message: event,
    }
  }

  /** _convert_handle_notice_event：OneBot V11 通知类事件 */
  async convertHandleNoticeEvent(event: OneBotEvent): Promise<AstrBotMessage> {
    const sender = { user_id: String(event.user_id), nickname: String(event.user_id) }
    const isGroup = Boolean(event.group_id)
    const abm: AstrBotMessage = {
      self_id: String(event.self_id),
      sender,
      type: isGroup ? MessageType.GROUP_MESSAGE : MessageType.FRIEND_MESSAGE,
      group: isGroup ? { group_id: String(event.group_id) } : null,
      session_id: isGroup ? String(event.group_id) : sender.user_id,
      message_str: '',
      message: [],
      raw_message: event,
      timestamp: nowSec(),
      message_id: randomUUID().replace(/-/g, ''),
    }
    if ('sub_type' in event) {
      if (event.sub_type === 'poke' && 'target_id' in event) {
        abm.message.push(Poke({ id: String(event.target_id) }))
      }
    }
    return abm
  }

  /**
   * _convert_handle_message_event：OneBot V11 消息类事件
   * @param getReply 是否获取回复消息。这个参数是为了防止多个回复嵌套。
   */
  async convertHandleMessageEvent(event: OneBotEvent, getReply = true): Promise<AstrBotMessage> {
    if (event.sender === undefined || event.sender === null) throw new Error('AssertionError: event.sender is None')
    const abm: AstrBotMessage = {
      self_id: String(event.self_id),
      sender: {
        user_id: String(event.sender.user_id),
        nickname: event.sender.card || (event.sender.nickname ?? 'N/A'),
      },
      type: MessageType.OTHER_MESSAGE,
      group: null,
      session_id: '',
      message_id: '',
      message: [],
      message_str: '',
      raw_message: event,
      timestamp: nowSec(),
    }
    if (event.message_type === 'group') {
      abm.type = MessageType.GROUP_MESSAGE
      abm.group = { group_id: String(event.group_id), group_name: event.group_name }
    } else if (event.message_type === 'private') {
      abm.type = MessageType.FRIEND_MESSAGE
    }
    abm.session_id = abm.type === MessageType.GROUP_MESSAGE ? String(event.group_id) : abm.sender.user_id
    abm.message_id = String(event.message_id)

    let messageStr = ''
    if (!Array.isArray(event.message)) {
      const err = 'aiocqhttp: 无法识别的消息类型: ' + String(event.message) + '，此条消息将被忽略。如果您在使用 go-cqhttp，请将其配置文件中的 message.post-format 更改为 array。'
      this.log('error', err)
      try {
        await this.bot.send(event, err)
      } catch (e) {
        this.log('error', '回复消息失败: ' + errText(e))
      }
      throw new Error(err)
    }

    // 按消息段类型适配（itertools.groupby：相邻同类型分为一组）
    const routingParams: Record<string, unknown> = event.self_id ? { self_id: event.self_id } : {}
    for (const [t, mGroup] of groupBy(event.message as Array<{ type: string; data: Record<string, any> }>)) {
      if (t === 'text') {
        const currentText = mGroup.map(m => m.data.text).join('').trim()
        if (!currentText) continue // 如果文本段为空，则跳过
        messageStr += currentText
        abm.message.push(ComponentTypes[t]({ text: currentText }))
      } else if (t === 'file') {
        for (const m of mGroup) {
          if (m.data.url && String(m.data.url).startsWith('http')) {
            // Lagrange
            this.log('info', 'guessing lagrange')
            const fileName = m.data.file_name || m.data.name || m.data.file || 'file'
            abm.message.push(File({ name: fileName, url: m.data.url }))
          } else {
            try {
              // Napcat
              let ret: any = null
              if (abm.type === MessageType.GROUP_MESSAGE) {
                ret = await this.bot.callAction('get_group_file_url', { file_id: m.data.file_id, group_id: event.group_id, ...routingParams })
              } else if (abm.type === MessageType.FRIEND_MESSAGE) {
                ret = await this.bot.callAction('get_private_file_url', { file_id: m.data.file_id, ...routingParams })
              }
              if (ret && typeof ret === 'object' && 'url' in ret) {
                const fileUrl = ret.url
                // 优先从 API 返回值获取文件名，其次从原始消息数据获取
                const fileName = ret.file_name || ret.name || m.data.file || m.data.file_name || ''
                abm.message.push(File({ name: fileName, url: fileUrl }))
              } else {
                this.log('error', '获取文件失败: ' + JSON.stringify(ret))
              }
            } catch (e) {
              this.log('error', '获取文件失败: ' + errText(e) + '，此消息段将被忽略。')
            }
          }
        }
      } else if (t === 'reply') {
        for (const m of mGroup) {
          if (!getReply) {
            abm.message.push(ComponentTypes[t](m.data))
          } else {
            try {
              const replyEventData = await this.bot.callAction('get_msg', { message_id: parseInt(String(m.data.id), 10), ...routingParams })
              // 添加必要的 post_type 字段，防止 Event.from_payload 报错
              replyEventData.post_type = 'message'
              const newEvent = eventFromPayload(replyEventData)
              if (!newEvent) {
                this.log('error', '无法从回复消息数据构造 Event 对象: ' + JSON.stringify(replyEventData))
                continue
              }
              const abmReply = await this.convertHandleMessageEvent(newEvent, false)
              abm.message.push(make('Reply', {
                id: abmReply.message_id,
                chain: abmReply.message,
                sender_id: abmReply.sender.user_id,
                sender_nickname: abmReply.sender.nickname,
                time: abmReply.timestamp,
                message_str: abmReply.message_str,
                text: abmReply.message_str, // for compatibility
                qq: abmReply.sender.user_id, // for compatibility
              }))
            } catch (e) {
              this.log('error', '获取引用消息失败: ' + errText(e) + '。')
              abm.message.push(ComponentTypes[t](m.data))
            }
          }
        }
      } else if (t === 'at') {
        let firstAtSelfProcessed = false
        const atParts: string[] = []
        for (const m of mGroup) {
          try {
            if (m.data.qq === 'all') {
              abm.message.push(At({ qq: 'all', name: '全体成员' }))
              continue
            }
            let atInfo = await this.bot.callAction('get_group_member_info', {
              group_id: event.group_id,
              user_id: parseInt(String(m.data.qq), 10),
              no_cache: false,
              ...routingParams,
            })
            if (atInfo) {
              let nickname = atInfo.card ?? ''
              if (nickname === '') {
                atInfo = await this.bot.callAction('get_stranger_info', {
                  user_id: parseInt(String(m.data.qq), 10),
                  no_cache: false,
                  ...routingParams,
                })
                nickname = atInfo.nick || atInfo.nickname || ''
              }
              const isAtSelf = String(m.data.qq) === abm.self_id || String(m.data.qq) === 'all'
              abm.message.push(At({ qq: m.data.qq, name: nickname }))
              if (isAtSelf && !firstAtSelfProcessed) {
                // 第一个@是机器人，不添加到message_str
                firstAtSelfProcessed = true
              } else {
                // 非第一个@机器人或@其他用户，添加到message_str
                atParts.push(' @' + nickname + '(' + m.data.qq + ') ')
              }
            } else {
              abm.message.push(At({ qq: String(m.data.qq), name: '' }))
            }
          } catch (e) {
            this.log('error', '获取 @ 用户信息失败: ' + errText(e) + '，此消息段将被忽略。')
          }
        }
        messageStr += atParts.join('')
      } else if (t === 'mface') {
        continue
      } else if (t === 'markdown') {
        for (const m of mGroup) {
          const text = m.data.markdown || m.data.content || ''
          abm.message.push(Plain(text))
          messageStr += text
        }
      } else {
        for (const m of mGroup) {
          try {
            if (!(t in ComponentTypes)) {
              this.log('warn', '不支持的消息段类型，已忽略: ' + t + ', data=' + JSON.stringify(m.data))
              continue
            }
            abm.message.push(ComponentTypes[t](m.data))
          } catch (e) {
            this.log('error', '消息段解析失败: type=' + t + ', data=' + JSON.stringify(m.data) + '. ' + errText(e))
            continue
          }
        }
      }
    }

    abm.timestamp = nowSec()
    abm.message_str = messageStr
    abm.raw_message = event
    return abm
  }

  /** run */
  async run(): Promise<void> {
    if (!this.host || !this.port) {
      this.log('warn', 'aiocqhttp: 未配置 ws_reverse_host 或 ws_reverse_port，将使用默认值：http://0.0.0.0:6199')
      this.host = '0.0.0.0'
      this.port = 6199
    }
    await this.bot.run(this.host, this.port)
  }

  /** terminate */
  async terminate(): Promise<void> {
    await this.bot.close()
    this.log('info', 'aiocqhttp 适配器已被关闭')
  }

  /** create_event */
  createEvent(message: AstrBotMessage): AiocqhttpMessageEvent {
    return new AiocqhttpMessageEvent(message, this.id, this.bot, this.log)
  }

  /** handle_msg：AstrBot 在这里 commit_event 进事件队列。 */
  async handleMsg(message: AstrBotMessage): Promise<void> {
    await this.onMessage(message, this.createEvent(message))
  }
}

/** itertools.groupby(seq, key=lambda x: x["type"]) */
function groupBy<T extends { type: string }>(items: T[]): Array<[string, T[]]> {
  const out: Array<[string, T[]]> = []
  for (const item of items) {
    const last = out.at(-1)
    if (last !== undefined && last[0] === item.type) last[1].push(item)
    else out.push([item.type, [item]])
  }
  return out
}

/** AiocqhttpMessageEvent */
export class AiocqhttpMessageEvent {
  readonly message_obj: AstrBotMessage
  readonly message_str: string
  readonly session: MessageSession
  readonly bot: CQHttp
  private readonly log: Logger

  constructor(message: AstrBotMessage, platformId: string, bot: CQHttp, log: Logger) {
    this.message_obj = message
    this.message_str = message.message_str
    this.session = { platform_name: platformId, message_type: message.type, session_id: message.session_id }
    this.bot = bot
    this.log = log
  }

  get unified_msg_origin(): string {
    return sessionToString(this.session)
  }

  getGroupId(): string {
    return groupId(this.message_obj)
  }

  getSenderId(): string {
    return this.message_obj.sender.user_id
  }

  getSelfId(): string {
    return this.message_obj.self_id
  }

  isPrivateChat(): boolean {
    return this.message_obj.type === MessageType.FRIEND_MESSAGE
  }

  /** _from_segment_to_dict：修复部分字段 */
  static async fromSegmentToDict(segment: Component): Promise<Record<string, any>> {
    if (segment.type === 'Image' || segment.type === 'Record') {
      const bs64 = await convertToBase64(segment)
      return { type: segment.type.toLowerCase(), data: { file: 'base64://' + bs64 } }
    }
    if (segment.type === 'File') {
      const d = await toDictAsync(segment)
      const fileVal = d.data?.file ?? ''
      if (fileVal) {
        try {
          d.data.file = toFileUri(fileVal)
        } catch {
          // 如果不是合法路径，则跳过转换
        }
      }
      return d
    }
    if (segment.type === 'Video') return toDictAsync(segment)
    return toDict(segment)
  }

  /** _parse_onebot_json：解析成 OneBot json 格式 */
  static async parseOnebotJson(messageChain: MessageChain): Promise<Record<string, any>[]> {
    const ret: Record<string, any>[] = []
    for (const segment of messageChain.chain) {
      if (segment.type === 'At') {
        // At 组件后插入一个空格，避免与后续文本粘连
        ret.push(await AiocqhttpMessageEvent.fromSegmentToDict(segment))
        ret.push({ type: 'text', data: { text: ' ' } })
      } else if (segment.type === 'Plain') {
        if (!String(segment.text).trim()) continue
        ret.push(await AiocqhttpMessageEvent.fromSegmentToDict(segment))
      } else {
        ret.push(await AiocqhttpMessageEvent.fromSegmentToDict(segment))
      }
    }
    return ret
  }

  /** _dispatch_send */
  static async dispatchSend(bot: CQHttp, event: OneBotEvent | null, isGroup: boolean, sessionId: string | null, messages: Record<string, any>[]): Promise<void> {
    // session_id 必须是纯数字字符串
    const sessionIdInt = sessionId && /^\d+$/.test(sessionId) ? parseInt(sessionId, 10) : null
    const routingParams: Record<string, unknown> = {}
    if (event && event.self_id) routingParams.self_id = event.self_id

    if (isGroup && sessionIdInt !== null) {
      await bot.sendGroupMsg({ group_id: sessionIdInt, message: messages, ...routingParams })
    } else if (!isGroup && sessionIdInt !== null) {
      await bot.sendPrivateMsg({ user_id: sessionIdInt, message: messages, ...routingParams })
    } else if (event) {
      // 最后兜底
      await bot.send(event, messages)
    } else {
      throw new Error('无法发送消息：缺少有效的数字 session_id(' + sessionId + ') 或 event(' + event + ')')
    }
  }

  /** send_message：发送消息至 QQ 协议端 */
  static async sendMessage(bot: CQHttp, messageChain: MessageChain, event: OneBotEvent | null, isGroup: boolean, sessionId: string | null, _log?: Logger): Promise<void> {
    // 转发消息、文件消息不能和普通消息混在一起发送
    const sendOneByOne = messageChain.chain.some(seg => seg.type === 'Node' || seg.type === 'Nodes' || seg.type === 'File')
    if (!sendOneByOne) {
      const ret = await AiocqhttpMessageEvent.parseOnebotJson(messageChain)
      if (ret.length === 0) return
      await AiocqhttpMessageEvent.dispatchSend(bot, event, isGroup, sessionId, ret)
      return
    }
    for (let seg of messageChain.chain) {
      if (seg.type === 'Node' || seg.type === 'Nodes') {
        // 合并转发消息
        if (seg.type === 'Node') seg = make('Nodes', { nodes: [seg] })
        const payload: Record<string, any> = await toDictAsync(seg)
        if (event && event.self_id) payload.self_id = event.self_id
        if (isGroup) {
          payload.group_id = sessionId
          await bot.callAction('send_group_forward_msg', payload)
        } else {
          payload.user_id = sessionId
          await bot.callAction('send_private_forward_msg', payload)
        }
      } else if (seg.type === 'File') {
        const d = await AiocqhttpMessageEvent.fromSegmentToDict(seg)
        await AiocqhttpMessageEvent.dispatchSend(bot, event, isGroup, sessionId, [d])
      } else {
        const messages = await AiocqhttpMessageEvent.parseOnebotJson({ chain: [seg] })
        if (messages.length === 0) continue
        await AiocqhttpMessageEvent.dispatchSend(bot, event, isGroup, sessionId, messages)
        await sleep(500)
      }
    }
  }

  /** send */
  async send(message: MessageChain): Promise<void> {
    const event = this.message_obj.raw_message ?? null
    const isGroup = Boolean(this.getGroupId())
    const sessionId = isGroup ? this.getGroupId() : this.getSenderId()
    await AiocqhttpMessageEvent.sendMessage(this.bot, message, event, isGroup, sessionId, this.log)
  }

  /** send_streaming（use_fallback=False 时攒成一条发；True 时按句子分段发）。 */
  async sendStreaming(generator: AsyncIterable<MessageChain>, useFallback = false): Promise<void> {
    if (!useFallback) {
      let buffer: MessageChain | null = null
      for await (const chain of generator) {
        if (!buffer) buffer = { chain: [...chain.chain] }
        else buffer.chain.push(...chain.chain)
      }
      if (!buffer) return
      await this.send(squashPlain(buffer))
      return
    }
    let buffer = ''
    const pattern = /[^。？！~…]+[。？！~…]+/g
    for await (const chain of generator) {
      for (const comp of chain.chain) {
        if (comp.type === 'Plain') {
          buffer += comp.text
          if ([...'。？！~…'].some(p => buffer.includes(p))) buffer = await this.processBuffer(buffer, pattern)
        } else {
          await this.send({ chain: [comp] })
          await sleep(1500) // 限速
        }
      }
    }
    buffer = buffer.trim()
    if (buffer) await this.send({ chain: [Plain(buffer)] })
  }

  /** AstrMessageEvent.process_buffer：把完整的句子逐条发出，返回剩余部分。 */
  private async processBuffer(buffer: string, pattern: RegExp): Promise<string> {
    while (true) {
      pattern.lastIndex = 0
      const match = pattern.exec(buffer)
      if (!match) break
      const matched = match[0].trim()
      if (matched) {
        await this.send({ chain: [Plain(matched)] })
        await sleep(1500) // 限速
      }
      buffer = buffer.slice(match.index + match[0].length)
    }
    return buffer
  }

  /** get_group：取群信息，失败时保留已有数据。 */
  async getGroup(groupIdArg?: string | number): Promise<Group | null> {
    const resolved = groupIdArg ?? this.getGroupId()
    if (!resolved) return null
    const resolvedGroupId = String(resolved)
    const apiGroupId = /^\d+$/.test(resolvedGroupId) ? parseInt(resolvedGroupId, 10) : resolvedGroupId
    const current = this.message_obj.group
    const group: Group = current && current.group_id === resolvedGroupId ? current : { group_id: resolvedGroupId }
    const routingParams: Record<string, unknown> = {}
    if (this.message_obj.self_id) routingParams.self_id = this.message_obj.self_id

    try {
      const info = await this.bot.callAction('get_group_info', { group_id: apiGroupId, ...routingParams })
      if (info && typeof info === 'object') {
        group.group_name = info.group_name || group.group_name
        const memberCount = info.member_count
        if (memberCount !== undefined && memberCount !== null) {
          const n = parseInt(String(memberCount), 10)
          if (Number.isNaN(n)) this.log('warn', '[aiocqhttp] Invalid member_count for group ' + resolvedGroupId)
          else group.member_count = n
        }
      }
    } catch (e) {
      this.log('warn', '[aiocqhttp] Failed to get group information for ' + resolvedGroupId + ': ' + errText(e))
    }

    let members: unknown
    try {
      members = await this.bot.callAction('get_group_member_list', { group_id: apiGroupId, ...routingParams })
    } catch (e) {
      this.log('warn', '[aiocqhttp] Failed to get members for group ' + resolvedGroupId + ': ' + errText(e))
      return group
    }
    if (!Array.isArray(members)) return group

    let ownerId: string | null = null
    const adminIds: string[] = []
    for (const member of members) {
      if (!member || typeof member !== 'object' || member.user_id === undefined || member.user_id === null) continue
      if (member.role === 'owner') ownerId = String(member.user_id)
      if (member.role === 'admin') adminIds.push(String(member.user_id))
    }
    group.group_admins = adminIds
    group.group_owner = ownerId
    group.members = members
      .filter(m => m && typeof m === 'object' && m.user_id !== undefined && m.user_id !== null)
      .map(m => ({ user_id: String(m.user_id), nickname: m.nickname || m.card }))
    if (group.member_count === undefined || group.member_count === null) group.member_count = group.members.length
    return group
  }
}

/** MessageChain.squash_plain：合并所有 Plain 为一个，放在第一个 Plain 的位置。 */
function squashPlain(chain: MessageChain): MessageChain {
  const texts: string[] = []
  const out: Component[] = []
  let placed = false
  for (const comp of chain.chain) {
    if (comp.type === 'Plain') {
      texts.push(comp.text)
      if (!placed) {
        out.push(comp)
        placed = true
      }
    } else {
      out.push(comp)
    }
  }
  const first = out.find(c => c.type === 'Plain')
  if (first !== undefined) first.text = texts.join('')
  return { chain: out }
}

export { ActionFailed }
