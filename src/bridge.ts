// dsh 一侧：替代 AstrBot 的事件队列和流水线里与"消息进出"有关的部分。
// 一条消息依次经过（顺序同 AstrBot STAGES_ORDER）：
//   唤醒（WakingCheckStage）→ 白名单（WhitelistCheckStage）→ 指令（builtin_commands）
//   → 只 @ 不说话时等下一条（handle_empty_mention）→ 频率限制（RateLimitStage）
//   → 语音转文字（PreProcessStage）→ 交给 unified_msg_origin 对应的 dsh 会话。
// 每条转换好的消息都通过 ctx 事件 'napcat/message' 广播（给记忆等其他插件用）。
// 会话一轮结束时，把模型最后一条回复的文字原样发回。

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  AiocqhttpMessageEvent, MessageType, sessionToString,
  type AstrBotMessage, type MessageSession,
} from './adapter.js'
import { Plain, type Component } from './components.js'
import { loadImage, type LoadedImage } from './images.js'
import { extractForwards, extractQuoted } from './quoted.js'
import { transcribe, type SttSettings } from './stt.js'
import type { SessionStore } from './store.js'
import type { Logger } from './onebot/server.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 从 QQ（NapCat）来的用户消息 */
    'plugin:napcat-bridge': { kind: 'plugin:napcat-bridge' }
  }
}

export interface WakeConfig {
  /** AstrBot wake_prefix，默认 ["/"] */
  wakePrefix: string[]
  /** AstrBot platform_settings.ignore_bot_self_message，默认 false */
  ignoreBotSelfMessage: boolean
  /** AstrBot platform_settings.friend_message_needs_wake_prefix，默认 false */
  friendMessageNeedsWakePrefix: boolean
}

export interface BridgeDeps {
  agents: AgentRegistry
  /** 新会话用的默认模型（dsh-agent-default-model） */
  defaultModel(): { currentSelection(): { provider: string; model: string; reasoningEffort?: string } | undefined } | undefined
  /** 预设挂载（可选） */
  presets(): { mount(agentCtx: unknown, id?: string): Promise<{ id: string }> } | undefined
  /** 判断会话日志是否已存在（可选；存在时 resume 而不是 create） */
  persistence(): { stat(id: string): Promise<object | undefined> } | undefined
  /** 会话事件来源（ctx.on('session/event')） */
  onSessionEvent(listener: (session: Session, event: SessionEvent) => void): () => void
  /** dsh 附件服务（可选；没有时图片不交给模型） */
  attachments(): { admitPromptContent(content: readonly unknown[]): Promise<unknown[]> } | undefined
  /** 调 OneBot API（读图片时 get_image 兜底） */
  callAction(action: string, params: Record<string, unknown>): Promise<any>
  /** 广播给其他插件 */
  emit(abm: AstrBotMessage, event: AiocqhttpMessageEvent, isWake: boolean): void
  /** 当前设置（每次用到时读取，设置页改了立即生效） */
  settings(): BridgeSettings
  /** 记住每个 QQ 会话当前的 dsh 会话 id */
  store: SessionStore
  log: Logger
}

export interface BridgeSettings {
  cwd: string
  wake: WakeConfig
  /** 群消息前面加 [昵称(QQ号)]，让模型知道是谁在说话 */
  identifier: boolean
  /** 图片交给模型 */
  imageToModel: boolean
  /** 一条消息最多交几张图片（含引用消息里的）；0 = 不限 */
  maxImages: number
  /** AstrBot admins_id：管理员 QQ 号 */
  admins: string[]
  /** AstrBot enable_id_white_list / id_whitelist / wl_ignore_admin_* / id_whitelist_log */
  whitelist: { enabled: boolean; ids: string[]; ignoreAdminOnGroup: boolean; ignoreAdminOnFriend: boolean; log: boolean }
  /** AstrBot rate_limit：time 秒内最多 count 条；strategy stall=排队 discard=丢弃；count 0 = 不限 */
  rateLimit: { count: number; seconds: number; strategy: 'stall' | 'discard' }
  /** AstrBot empty_mention_waiting / empty_mention_waiting_need_reply */
  emptyMention: { waiting: boolean; needReply: boolean }
  /** AstrBot unique_session：群里每人单独一个会话 */
  uniqueSession: boolean
  /** AstrBot datetime_system_prompt / group_name_display / timezone；markAdmin 为本插件新增 */
  reminder: { datetime: boolean; timezone: string; groupName: boolean; markAdmin: boolean }
  /** QQ 里的指令（/help /sid /new /reset /stop）；noPermissionReply 同 AstrBot */
  commands: { enabled: boolean; noPermissionReply: boolean }
  /** 新会话用的预设：主人私聊 > 私聊/群聊 > 默认（空 = 往下找） */
  presets: { default: string; private: string; group: string; adminPrivate: string }
  /** 新会话用的模型，写成 提供方/模型（空 = 用 dsh 默认模型） */
  models: { private: string; group: string; adminPrivate: string }
  stt: SttSettings
}

/** AstrBot handle_empty_mention 让模型主动问一句时用的提示词（原文）。 */
const EMPTY_MENTION_PROMPT = '注意，你正在社交媒体上中与用户进行聊天，用户只是通过@来唤醒你，但并未在这条消息中输入内容，他可能会在接下来一条发送他想发送的内容。'
  + '你友好地询问用户想要聊些什么或者需要什么帮助，回复要符合人设，不要太过机械化。'
  + '请注意，你仅需要输出要回复用户的内容，不要输出其他任何东西'
/** AstrBot @session_waiter(60) */
const EMPTY_MENTION_WAIT_MS = 60_000
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** 当前时间，格式同 AstrBot：2026-10-23 21:40 (GMT+8), Weekday: Friday */
export function formatNow(timezone: string, now = new Date()): string {
  const make = (tz: string | undefined) => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false, weekday: 'long', timeZoneName: 'short',
  })
  let fmt: Intl.DateTimeFormat
  try {
    fmt = make(timezone || undefined)
  } catch {
    fmt = make(undefined)
  }
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value
  const hour = p.hour === '24' ? '00' : p.hour
  return p.year + '-' + p.month + '-' + p.day + ' ' + hour + ':' + p.minute + ' (' + p.timeZoneName + '), Weekday: ' + (p.weekday ?? WEEKDAYS[now.getDay()])
}

/** "provider/model" → agentOptions；格式不对返回 undefined。 */
function parseModel(text: string): { provider: string; model: string } | undefined {
  const i = text.indexOf('/')
  if (i <= 0 || i === text.length - 1) return undefined
  return { provider: text.slice(0, i).trim(), model: text.slice(i + 1).trim() }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface Chat {
  umo: string
  session: MessageSession
  handle: AgentHandle
  /** 本轮最后一条模型回复的文字 */
  lastText: string
  /** 最近一次唤醒它的事件，回复发给它 */
  replyTo: AiocqhttpMessageEvent
}

/** dsh 会话 id：napcat-<平台>-<类型>-<会话> 去掉不安全字符。 */
export function dshSessionId(umo: string): string {
  return 'napcat-' + umo.replace(/[^A-Za-z0-9-]/g, '-')
}

/**
 * WakingCheckStage.process 中与唤醒有关的部分（AstrBot 默认配置）。
 * 返回 null 表示不唤醒；否则返回处理后的 message_str（去掉了唤醒前缀）。
 */
export function wakingCheck(event: AiocqhttpMessageEvent, wake: WakeConfig): { isWake: boolean; messageStr: string; stop: boolean; prefixUsed: boolean } {
  if (wake.ignoreBotSelfMessage && event.getSelfId() === event.getSenderId()) {
    return { isWake: false, messageStr: event.message_str, stop: true, prefixUsed: false }
  }
  let messageStr = event.message_str.trim()
  const messages: Component[] = event.message_obj.message
  let isWake = false
  let prefixUsed = false
  for (const prefix of wake.wakePrefix) {
    if (messageStr.startsWith(prefix)) {
      const first = messages[0]
      if (
        !event.isPrivateChat()
        && first !== undefined && first.type === 'At'
        && String(first.qq) !== String(event.getSelfId())
        && String(first.qq) !== 'all'
      ) {
        // 如果是群聊，且第一个消息段是 At 消息，但不是 At 机器人或 At 全体成员，则不唤醒
        break
      }
      isWake = true
      prefixUsed = true
      messageStr = messageStr.slice(prefix.length).trim()
      break
    }
  }
  if (!isWake) {
    // 检查是否有at消息 / at全体成员消息 / 引用了bot的消息
    for (const m of messages) {
      // AstrBot 这里还判断 isinstance(m, AtAll)，但 aiocqhttp 适配器把 @全体 转成 At(qq="all")
      // 而不是 AtAll，所以 @全体 实际不会唤醒；这里保持同样的结果。
      if (
        (m.type === 'At' && String(m.qq) === String(event.getSelfId()))
        || (m.type === 'Reply' && String(m.sender_id) === String(event.getSelfId()))
      ) {
        isWake = true
        break
      }
    }
    // 检查是否是私聊
    if (event.isPrivateChat() && !wake.friendMessageNeedsWakePrefix) isWake = true
  }
  return { isWake, messageStr, stop: false, prefixUsed }
}

export class Bridge {
  private readonly chats = new Map<string, Chat>()
  private readonly bySession = new Map<string, string>()
  private readonly creating = new Map<string, Promise<Chat>>()
  /** 只 @ 不说话的人：key = 会话|QQ 号，值 = 等到什么时候 */
  private readonly waiters = new Map<string, number>()
  /** 频率限制：每个会话最近处理的时间 */
  private readonly timestamps = new Map<string, number[]>()
  private readonly off: () => void

  constructor(private readonly deps: BridgeDeps) {
    this.off = deps.onSessionEvent((session, event) => this.onSessionEvent(session, event))
  }

  /** unified_msg_origin；开了 unique_session 时群里按 QQ号_群号 分会话（同 AstrBot）。 */
  private umoOf(event: AiocqhttpMessageEvent, s: BridgeSettings): string {
    if (s.uniqueSession && event.message_obj.type === MessageType.GROUP_MESSAGE) {
      return sessionToString({ ...event.session, session_id: event.getSenderId() + '_' + event.getGroupId() })
    }
    return event.unified_msg_origin
  }

  private isAdmin(event: AiocqhttpMessageEvent, s: BridgeSettings): boolean {
    return s.admins.includes(event.getSenderId())
  }

  /** WhitelistCheckStage；另外私聊时也认发送者的 QQ 号（AstrBot 只认完整会话标识）。 */
  private allowed(event: AiocqhttpMessageEvent, admin: boolean, s: BridgeSettings): boolean {
    const wl = s.whitelist
    const ids = wl.ids.map(i => String(i).trim()).filter(i => i !== '')
    if (!wl.enabled || ids.length === 0) return true
    const isGroup = event.message_obj.type === MessageType.GROUP_MESSAGE
    if (admin && isGroup && wl.ignoreAdminOnGroup) return true
    if (admin && !isGroup && wl.ignoreAdminOnFriend) return true
    if (ids.includes(event.unified_msg_origin) || ids.includes(String(event.getGroupId()).trim())) return true
    if (!isGroup && ids.includes(event.getSenderId())) return true
    if (wl.log) this.deps.log('info', '会话 ' + event.unified_msg_origin + ' 不在白名单里，消息没有交给模型。需要的话在设置页「访问控制」里把群号或 QQ 号加进白名单。')
    return false
  }

  /** RateLimitStage（固定窗口）。返回 false 表示这条被丢弃。 */
  private async rateLimit(umo: string, s: BridgeSettings): Promise<boolean> {
    const { count, seconds, strategy } = s.rateLimit
    if (count <= 0) return true
    const windowMs = seconds * 1000
    while (true) {
      const now = Date.now()
      const list = (this.timestamps.get(umo) ?? []).filter(t => t >= now - windowMs)
      this.timestamps.set(umo, list)
      if (list.length < count) {
        list.push(now)
        return true
      }
      const wait = list[0] + windowMs - now + 300
      if (strategy === 'discard') {
        this.deps.log('info', '会话 ' + umo + ' 触发频率限制，这条消息被丢弃，' + (wait / 1000).toFixed(1) + ' 秒后恢复。')
        return false
      }
      this.deps.log('info', '会话 ' + umo + ' 触发频率限制，等 ' + (wait / 1000).toFixed(1) + ' 秒再处理。')
      await sleep(wait)
    }
  }

  /** 适配器 handle_msg 的去处。 */
  async handle(abm: AstrBotMessage, event: AiocqhttpMessageEvent): Promise<void> {
    const s = this.deps.settings()
    const woke = wakingCheck(event, s.wake)
    let { isWake } = woke
    const { stop, prefixUsed } = woke
    let messageStr = woke.messageStr
    const umo = this.umoOf(event, s)
    const isMessage = abm.raw_message.post_type === 'message'
    // 只 @ 过她的人，60 秒内的下一条有内容的消息算作唤醒（AstrBot 在下一条前插一个 @）
    const waiterKey = umo + '|' + event.getSenderId()
    const waitUntil = this.waiters.get(waiterKey)
    if (!stop && !isWake && isMessage && waitUntil !== undefined) {
      if (waitUntil < Date.now()) {
        this.waiters.delete(waiterKey)
      } else if (messageStr.trim() !== '') {
        this.waiters.delete(waiterKey)
        isWake = true
      }
    }
    try {
      this.deps.emit(abm, event, isWake && !stop)
    } catch (e) {
      this.deps.log('warn', 'napcat/message 监听器出错: ' + errText(e))
    }
    if (stop || !isWake) return
    // 只有消息事件交给模型；通知/请求只广播
    if (!isMessage) return
    const admin = this.isAdmin(event, s)
    if (!this.allowed(event, admin, s)) return

    if (s.commands.enabled && prefixUsed && await this.command(messageStr, event, umo, admin, s)) return

    if (s.emptyMention.waiting && this.isEmptyMention(abm, event, s)) {
      this.waiters.set(waiterKey, Date.now() + EMPTY_MENTION_WAIT_MS)
      if (s.emptyMention.needReply) await this.dispatch(event, umo, [{ type: 'text', text: EMPTY_MENTION_PROMPT }])
      return
    }

    if (!await this.rateLimit(umo, s)) return

    // 语音转文字（PreProcessStage）
    const records = abm.message.filter(c => c.type === 'Record')
    for (const record of records) {
      let piece = '[语音]'
      if (s.stt.mode !== 'off') {
        try {
          const text = await transcribe(record, s.stt, this.deps.callAction)
          piece = text !== '' ? '[语音] ' + text : '[语音，没听清]'
        } catch (e) {
          this.deps.log('warn', '语音转文字失败: ' + errText(e))
          piece = '[语音，转文字失败]'
        }
      }
      messageStr = messageStr === '' ? piece : messageStr + ' ' + piece
    }

    const own = abm.message.filter(c => c.type === 'Image')
    const hasForward = abm.message.some(c => c.type === 'Forward')
    if (messageStr === '' && own.length === 0 && !hasForward) return
    const content = await this.buildContent(abm, messageStr, own, admin, s)
    await this.dispatch(event, umo, content)
  }

  private isEmptyMention(abm: AstrBotMessage, event: AiocqhttpMessageEvent, s: BridgeSettings): boolean {
    const messages = abm.message
    if (messages.length !== 1) return false
    const m = messages[0]
    if (m.type === 'At' && String(m.qq) === String(event.getSelfId())) return true
    return m.type === 'Plain' && s.wake.wakePrefix.includes(String(m.text).trim())
  }

  private async dispatch(event: AiocqhttpMessageEvent, umo: string, content: unknown[]): Promise<void> {
    const chat = await this.ensureChat(event, umo)
    chat.replyTo = event
    chat.handle.agent.followup(createUserMessage({
      content: content as never,
      source: { kind: 'plugin:napcat-bridge' },
    }))
  }

  /** QQ 里的指令。返回 true 表示已处理（不再交给模型）。 */
  private async command(messageStr: string, event: AiocqhttpMessageEvent, umo: string, admin: boolean, s: BridgeSettings): Promise<boolean> {
    const name = messageStr.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    if (!['help', 'sid', 'new', 'reset', 'stop'].includes(name)) return false
    const reply = (text: string): Promise<void> => event.send({ chain: [Plain(text)] }).catch(e => {
      this.deps.log('error', '发送指令回复失败: ' + errText(e))
    })
    const isGroup = event.message_obj.type === MessageType.GROUP_MESSAGE
    // AstrBot SHARED_GROUP_ADMIN：私聊谁都能用；群里要管理员（本插件也认 QQ 群主和群管理）
    const groupRole = String(event.message_obj.raw_message.sender?.role ?? '')
    const sharedAdmin = !isGroup || admin || groupRole === 'owner' || groupRole === 'admin'
    if ((name === 'new' || name === 'reset') && !sharedAdmin) {
      if (s.commands.noPermissionReply) await reply('只有管理员能在群里用 /' + name + '。')
      return true
    }
    const chat = this.chats.get(umo)
    if (name === 'help') {
      await reply(['可用指令：', '/new  开始新的对话（旧对话保留在 dsh 里）', '/reset  同 /new', '/stop  停止她正在进行的回复', '/sid  查看本会话的标识'].join('\n'))
    } else if (name === 'sid') {
      const sessionId = chat !== undefined ? String((chat.handle.agent as Agent).session.id) : (this.deps.store.get(umo) ?? dshSessionId(umo))
      await reply(['会话标识：' + umo, '你的 QQ：' + event.getSenderId(), 'dsh 会话：' + sessionId].join('\n'))
    } else if (name === 'stop') {
      if (chat === undefined) {
        await reply('现在没有在进行的回复。')
      } else {
        chat.handle.agent.cancel({ kind: 'user' } as never)
        await reply('已停止。')
      }
    } else {
      await this.startNewSession(umo)
      await reply('已开始新的对话。')
    }
    return true
  }

  /** /new、/reset：换一个新的 dsh 会话，旧的留在 dsh 里。 */
  private async startNewSession(umo: string): Promise<void> {
    const next = dshSessionId(umo) + '-' + Date.now().toString(36)
    this.deps.store.set(umo, next)
    const chat = this.chats.get(umo)
    if (chat === undefined) return
    this.chats.delete(umo)
    this.bySession.delete(String((chat.handle.agent as Agent).session.id))
    await chat.handle.dispose().catch(e => this.deps.log('warn', '关闭旧会话失败: ' + errText(e)))
    this.deps.log('info', umo + ' 换到新会话 ' + next)
  }

  /** AstrBot _append_system_reminders；markAdmin 为本插件新增。 */
  private reminder(abm: AstrBotMessage, admin: boolean, s: BridgeSettings): string | undefined {
    const parts: string[] = []
    if (s.reminder.markAdmin && admin) parts.push('Sender role: admin (QQ ' + abm.sender.user_id + ')')
    if (s.reminder.groupName && abm.group?.group_name) parts.push('Group name: ' + abm.group.group_name)
    if (s.reminder.datetime) parts.push('Current datetime: ' + formatNow(s.reminder.timezone))
    return parts.length > 0 ? '<system_reminder>' + parts.join('\n') + '</system_reminder>' : undefined
  }

  /**
   * 交给模型的内容：（群里）[昵称(QQ号)] + 文字；有引用时接 <Quoted Message>（照 AstrBot），
   * 有聊天记录时接 <Forward Message>（本插件新增）；然后 <system_reminder>；最后是图片。
   */
  private async buildContent(abm: AstrBotMessage, messageStr: string, own: Component[], admin: boolean, s: BridgeSettings): Promise<unknown[]> {
    const settings = s
    const callAction = this.deps.callAction
    const safe = async <T>(what: string, task: () => Promise<T>): Promise<T | null> => {
      try {
        return await task()
      } catch (e) {
        this.deps.log('warn', what + '失败: ' + errText(e))
        return null
      }
    }
    const quoted = await safe('整理引用内容', () => extractQuoted(abm.message, callAction))
    const forwarded = await safe('展开聊天记录', () => extractForwards(abm.message, callAction))

    let text = messageStr
    if (text === '' && own.length > 0) text = '[图片]'
    if (text === '' && forwarded !== null) text = '[聊天记录]'
    if (settings.identifier && abm.type === MessageType.GROUP_MESSAGE) {
      text = '[' + (abm.sender.nickname || abm.sender.user_id) + '(' + abm.sender.user_id + ')] ' + text
    }
    const texts: unknown[] = [{ type: 'text', text }]
    if (quoted !== null) texts.push({ type: 'text', text: quoted.text })
    if (forwarded !== null) texts.push({ type: 'text', text: forwarded.text })
    const reminder = this.reminder(abm, admin, s)
    if (reminder !== undefined) texts.push({ type: 'text', text: reminder })
    const asImage = (ref: string): Component => ({ type: 'Image', file: ref, url: ref.startsWith('http') ? ref : '', _type: '', path: '' })
    const quotedImages = (quoted?.imageRefs ?? []).map(asImage)
    const forwardImages = (forwarded?.imageRefs ?? []).map(asImage)
    const attachments = this.deps.attachments()
    if (!settings.imageToModel || attachments === undefined || own.length + quotedImages.length + forwardImages.length === 0) {
      return texts
    }
    const parts: unknown[] = [...texts]
    let budget = settings.maxImages > 0 ? settings.maxImages : Infinity
    let failed = 0
    const add = async (images: Component[], label?: string): Promise<void> => {
      const loaded: LoadedImage[] = []
      for (const img of images) {
        if (budget <= 0) break
        try {
          loaded.push(await loadImage(img, callAction))
          budget -= 1
        } catch (e) {
          failed += 1
          this.deps.log('warn', '图片读取失败: ' + (e instanceof Error ? e.message : String(e)))
        }
      }
      if (loaded.length === 0) return
      if (label !== undefined) parts.push({ type: 'text', text: label })
      for (const img of loaded) parts.push({ type: 'image', mediaType: img.mediaType, data: img.data, ...(img.name ? { name: img.name } : {}) })
    }
    await add(own)
    await add(quotedImages, '（下面是被引用消息里的图片）')
    await add(forwardImages, '（下面是聊天记录里的图片）')
    if (failed > 0) parts.push({ type: 'text', text: '（有 ' + failed + ' 张图片没能读取）' })
    try {
      return await attachments.admitPromptContent(parts)
    } catch (e) {
      this.deps.log('warn', '图片交给 dsh 失败，只发文字: ' + (e instanceof Error ? e.message : String(e)))
      return texts
    }
  }

  private ensureChat(event: AiocqhttpMessageEvent, umo: string): Promise<Chat> {
    const existing = this.chats.get(umo)
    if (existing !== undefined) return Promise.resolve(existing)
    const pending = this.creating.get(umo)
    if (pending !== undefined) return pending
    const task = this.createChat(umo, event).finally(() => this.creating.delete(umo))
    this.creating.set(umo, task)
    return task
  }

  private async createChat(umo: string, event: AiocqhttpMessageEvent): Promise<Chat> {
    const settings = this.deps.settings()
    const sessionId = this.deps.store.get(umo) ?? dshSessionId(umo)
    const isGroup = event.message_obj.type === MessageType.GROUP_MESSAGE
    const adminPrivate = !isGroup && settings.admins.includes(event.getSenderId())
    // 预设和模型：主人私聊 > 私聊/群聊 > 默认
    const presetId = (adminPrivate ? settings.presets.adminPrivate : '') || (isGroup ? settings.presets.group : settings.presets.private) || settings.presets.default || undefined
    const modelText = (adminPrivate ? settings.models.adminPrivate : '') || (isGroup ? settings.models.group : settings.models.private)
    const chosen = modelText !== '' ? parseModel(modelText) : undefined
    if (modelText !== '' && chosen === undefined) this.deps.log('warn', '模型「' + modelText + '」格式不对，应写成 提供方/模型；改用默认模型')
    const selection = chosen ?? this.deps.defaultModel()?.currentSelection()
    const agentOptions = selection ? { provider: selection.provider, model: selection.model, ...('reasoningEffort' in selection && selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } : undefined
    const presets = this.deps.presets()
    const setup: AgentSetup | undefined = presets !== undefined && presetId !== undefined
      ? (async (agentCtx: unknown) => { await presets.mount(agentCtx, presetId) }) as unknown as AgentSetup
      : undefined
    const persistence = this.deps.persistence()
    const exists = persistence !== undefined && await persistence.stat(sessionId) !== undefined
    let handle: AgentHandle
    if (exists) {
      handle = await this.deps.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: agentOptions as never, setup })
      this.deps.log('info', '恢复会话 ' + sessionId + '（' + umo + '）')
    } else {
      handle = await this.deps.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: settings.cwd, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
        agentOptions: agentOptions as never,
        setup,
      })
      this.deps.log('info', '新建会话 ' + sessionId + '（' + umo + (presetId ? '，预设 ' + presetId : '') + (chosen ? '，模型 ' + modelText : '') + '）')
    }
    const chat: Chat = { umo, session: event.session, handle, lastText: '', replyTo: event }
    this.chats.set(umo, chat)
    this.bySession.set(String((handle.agent as Agent).session.id), umo)
    return chat
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const umo = this.bySession.get(String(session.id))
    if (umo === undefined) return
    const chat = this.chats.get(umo)
    if (chat === undefined) return
    if (event.type === 'turn/start') {
      chat.lastText = ''
    } else if (event.type === 'assistant/message') {
      const text = (event.data.message.content as ReadonlyArray<{ type: string; text?: string }>)
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('')
      if (text.trim() !== '') chat.lastText = text
    } else if (event.type === 'turn/end') {
      const text = chat.lastText
      chat.lastText = ''
      if (text.trim() === '') return
      void chat.replyTo.send({ chain: [Plain(text)] }).catch(e => {
        this.deps.log('error', '发送回复失败（' + umo + '）: ' + (e instanceof Error ? e.message : String(e)))
      })
    }
  }

  /** 已建立的会话（unified_msg_origin → dsh 会话 id）。 */
  sessions(): Array<{ umo: string; sessionId: string }> {
    return [...this.chats.values()].map(c => ({ umo: c.umo, sessionId: String((c.handle.agent as Agent).session.id) }))
  }

  async dispose(): Promise<void> {
    this.off()
    const handles = [...this.chats.values()].map(c => c.handle)
    this.chats.clear()
    this.bySession.clear()
    await Promise.allSettled(handles.map(h => h.dispose()))
  }
}

export { MessageType, sessionToString }
