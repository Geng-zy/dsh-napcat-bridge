// dsh 一侧：替代 AstrBot 的事件队列和流水线里与"消息进出"有关的部分。
// 一条消息依次经过（顺序同 AstrBot STAGES_ORDER）：
//   唤醒（WakingCheckStage）→ 白名单（WhitelistCheckStage）→ 指令（builtin_commands）
//   → 只 @ 不说话时等下一条（handle_empty_mention）→ 频率限制（RateLimitStage）
//   → 语音转文字（PreProcessStage）→ 交给 unified_msg_origin 对应的 dsh 会话。
// 每条转换好的消息都通过 ctx 事件 'napcat/message' 广播（给记忆等其他插件用）。
// 交给模型前先发 'napcat/prompt'，其他插件可以往内容里加东西（本插件新增）。
// 会话一轮结束时，把模型最后一条回复的文字原样发回，并发 'napcat/sent'（本插件新增）。

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  AiocqhttpMessageEvent, MessageType, sessionToString,
  type AstrBotMessage, type MessageSession,
} from './adapter.js'
import { Plain, type Component, type MessageChain } from './components.js'
import type { VideoSettings } from './ffmpeg.js'
import type { Media, ModelPart } from './media.js'
import { extractForwards, extractQuoted } from './quoted.js'
import type { SttSettings } from './stt.js'
import type { SessionStore } from './store.js'
import { Pacer, type PaceSettings } from './pacer.js'
import type { Logger } from './onebot/server.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 从 QQ（NapCat）来的用户消息 */
    'plugin:napcat-bridge': { kind: 'plugin:napcat-bridge' }
    /** 其他插件主动唤醒她（ctx.napcat.wake，比如定时主动聊天）；不算"人说的话" */
    'plugin:napcat-bridge-wake': { kind: 'plugin:napcat-bridge-wake' }
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
  presets(): { mount(agentCtx: unknown, id?: string): Promise<{ id: string }>; readonly defaultId?: string } | undefined
  /** 判断会话日志是否已存在（可选；存在时 resume 而不是 create） */
  persistence(): { stat(id: string): Promise<object | undefined> } | undefined
  /** 会话事件来源（ctx.on('session/event')） */
  onSessionEvent(listener: (session: Session, event: SessionEvent) => void): () => void
  /** 图片、语音、视频 → 模型内容 */
  media: Media
  /** 调 OneBot API（读图片时 get_image 兜底） */
  callAction(action: string, params: Record<string, unknown>): Promise<any>
  /** 广播给其他插件 */
  emit(abm: AstrBotMessage, event: AiocqhttpMessageEvent, isWake: boolean): void
  /** 交给模型前让其他插件加内容（ctx.serial('napcat/prompt')） */
  prompt(payload: PromptPayload): Promise<unknown>
  /** 她发出了一条消息（ctx.emit('napcat/sent')） */
  sent(payload: SentPayload): void
  /** QQ 会话换了 dsh 会话（ctx.emit('napcat/session-changed')） */
  sessionChanged(change: SessionChange): void
  /** 按会话主动发送（没有收到的消息可回复时用，比如主动唤醒以后） */
  sendBySession(session: MessageSession, chain: MessageChain): Promise<void>
  /** 她自己的 QQ 号（NapCat 连上以后才有） */
  selfId(): string | undefined
  /** 当前设置（每次用到时读取，设置页改了立即生效） */
  settings(): BridgeSettings
  /** 记住每个 QQ 会话当前的 dsh 会话 id */
  store: SessionStore
  log: Logger
  /** 测试用：替换等待 */
  sleep?: (ms: number) => Promise<void>
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
  /** 思考等级（本插件新增）：主人私聊 / 其他私聊 / 群聊；空 = 跟默认模型 */
  reasoning: { private: string; group: string; adminPrivate: string }
  stt: SttSettings
  video: VideoSettings
  /** 她回复里以这个开头时不发出去（主动唤醒时她决定不说话用） */
  silenceToken: string
  /** 发消息的节奏：打字速度、群里的发言频率（本插件新增，见 pacer.ts） */
  pace: PaceSettings
}

/** 一个 dsh 会话对应哪个 QQ 会话（本插件新增，给其他插件按会话分规则用）。 */
export interface SessionInfo {
  /** unified_msg_origin */
  umo: string
  /** dsh 会话 id */
  sessionId: string
  /** 平台 ID（设置里的 id） */
  platformId: string
  /** 她自己的 QQ 号 */
  selfId: string
  type: 'private' | 'group'
  /** 私聊：对方 QQ 号；群里每人单独一个会话时：这个人的 QQ 号 */
  userId?: string
  /** 群号 */
  groupId?: string
  /** 管理员（主人）的私聊 */
  adminPrivate: boolean
}

/** 'napcat/prompt' 的参数：监听者直接改 content（在前后插入文字或图片）。 */
export interface PromptPayload {
  info: SessionInfo
  /** 这是这个 dsh 会话的第一轮（刚新建的会话） */
  newSession: boolean
  /** 唤醒她的那条消息 */
  message: AstrBotMessage
  /**
   * 要交给模型的内容，还没经过 dsh 附件服务。
   * 元素是 { type: 'text', text } 或 { type: 'image', mediaType, data(base64) }，插件一之后统一交给附件服务。
   */
  content: ModelPart[]
}

/** 'napcat/sent' 的参数。 */
export interface SentPayload {
  /** unified_msg_origin */
  umo: string
  session: MessageSession
  /** 发出去的文字（只取文字部分） */
  text: string
  chain: MessageChain
  /** reply：她一轮说完的回复；service：其他插件通过 ctx.napcat.sendBySession 发的 */
  source: 'reply' | 'service'
  /** 发出的时间（毫秒） */
  time: number
}

/** 'napcat/session-changed' 的参数。 */
export interface SessionChange {
  umo: string
  oldSessionId: string
  newSessionId: string
  /** command：QQ 里发了 /new 或 /reset；rotate：其他插件调用了 ctx.napcat.rotateSession */
  reason: 'command' | 'rotate'
}

/** 'napcat/prompt' 监听者最多等多久，超时就按当时的内容发出去。 */
const PROMPT_HOOK_MS = 30_000

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
  /** 回复怎么发：最近一次唤醒它的事件；主动唤醒建的会话按会话发 */
  send(chain: MessageChain): Promise<void>
  info: SessionInfo
  /** 新建的会话，还没交过内容给模型 */
  fresh: boolean
  /** 建这个会话时用的模型和思考等级（设置改了以后，下一条消息时换成新的） */
  modelKey: string
  /** 正在回复（turn/start 到 turn/end 之间），这时不换模型 */
  running: boolean
}

/** 建会话需要的 QQ 会话信息（从收到的消息来，或者从 unified_msg_origin 解析出来）。 */
interface Target {
  umo: string
  session: MessageSession
  isGroup: boolean
  /** 私聊对方 / 群里每人单独会话时的这个人 */
  userId?: string
  groupId?: string
  /** 用来判断是不是管理员私聊 */
  senderId: string
  selfId: string
  isUnique: boolean
  send(chain: MessageChain): Promise<void>
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
  /** dsh 会话 id → QQ 会话信息（建会话之前就登记，预设里的插件启动时就能查到） */
  private readonly infos = new Map<string, SessionInfo>()
  /** 只 @ 不说话的人：key = 会话|QQ 号，值 = 等到什么时候 */
  private readonly waiters = new Map<string, number>()
  /** 频率限制：每个会话最近处理的时间 */
  private readonly timestamps = new Map<string, number[]>()
  private readonly off: () => void

  private readonly pacer: Pacer

  constructor(private readonly deps: BridgeDeps) {
    this.pacer = new Pacer({ settings: () => deps.settings().pace, log: deps.log, ...(deps.sleep ? { sleep: deps.sleep } : {}) })
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
      if (s.emptyMention.needReply) await this.dispatch(event, umo, abm, [{ type: 'text', text: EMPTY_MENTION_PROMPT }])
      return
    }

    if (!await this.rateLimit(umo, s)) return

    // 语音转文字（PreProcessStage）
    for (const record of abm.message.filter(c => c.type === 'Record')) {
      const piece = await this.deps.media.voiceText(record)
      messageStr = messageStr === '' ? piece : messageStr + ' ' + piece
    }

    const own = abm.message.filter(c => c.type === 'Image')
    const videos = abm.message.filter(c => c.type === 'Video')
    const hasForward = abm.message.some(c => c.type === 'Forward')
    // 本插件新增：视频（AstrBot 不处理）在文字里写 [视频]，有 ffmpeg 时另外附几张截图
    for (let i = 0; i < videos.length; i++) messageStr = messageStr === '' ? '[视频]' : messageStr + ' [视频]'
    if (messageStr === '' && own.length === 0 && !hasForward) return
    const content = await this.buildContent(abm, messageStr, own, videos, admin, s)
    await this.dispatch(event, umo, abm, content)
  }

  private isEmptyMention(abm: AstrBotMessage, event: AiocqhttpMessageEvent, s: BridgeSettings): boolean {
    const messages = abm.message
    if (messages.length !== 1) return false
    const m = messages[0]
    if (m.type === 'At' && String(m.qq) === String(event.getSelfId())) return true
    return m.type === 'Plain' && s.wake.wakePrefix.includes(String(m.text).trim())
  }

  private targetOf(event: AiocqhttpMessageEvent, umo: string): Target {
    const isGroup = event.message_obj.type === MessageType.GROUP_MESSAGE
    const isUnique = isGroup && umo !== event.unified_msg_origin
    return {
      umo, session: event.session, isGroup, isUnique,
      ...(isGroup ? { groupId: String(event.getGroupId()) } : {}),
      ...(!isGroup ? { userId: String(event.message_obj.session_id) } : isUnique ? { userId: event.getSenderId() } : {}),
      senderId: event.getSenderId(),
      selfId: event.getSelfId(),
      send: chain => event.send(chain),
    }
  }

  private async dispatch(event: AiocqhttpMessageEvent, umo: string, abm: AstrBotMessage, content: ModelPart[]): Promise<void> {
    const target = this.targetOf(event, umo)
    const chat = await this.ensureChat(target)
    chat.send = target.send
    // 本插件新增：交给模型前让其他插件（记忆等）往内容里加东西
    const payload: PromptPayload = { info: chat.info, newSession: chat.fresh, message: abm, content: [...content] }
    chat.fresh = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.deps.prompt(payload),
        new Promise(resolve => { timer = setTimeout(() => {
          this.deps.log('warn', 'napcat/prompt 监听器 ' + PROMPT_HOOK_MS / 1000 + ' 秒没有完成，先按现有内容发给模型')
          resolve(undefined)
        }, PROMPT_HOOK_MS) }),
      ])
    } catch (e) {
      this.deps.log('warn', 'napcat/prompt 监听器出错: ' + errText(e))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    const parts = Array.isArray(payload.content) ? [...payload.content] : content
    const admitted = await this.deps.media.admit(parts)
    chat.handle.agent.followup(createUserMessage({
      content: admitted as never,
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
      await this.startNewSession(umo, 'command')
      await reply('已开始新的对话。')
    }
    return true
  }

  /** /new、/reset、rotateSession：换一个新的 dsh 会话，旧的留在 dsh 里。返回新旧会话 id。 */
  private async startNewSession(umo: string, reason: SessionChange['reason']): Promise<{ oldSessionId: string; newSessionId: string }> {
    const pending = this.creating.get(umo)
    if (pending !== undefined) await pending.catch(() => undefined)
    const chat = this.chats.get(umo)
    const oldSessionId = chat !== undefined ? String((chat.handle.agent as Agent).session.id) : (this.deps.store.get(umo) ?? dshSessionId(umo))
    let next = dshSessionId(umo) + '-' + Date.now().toString(36)
    if (next === oldSessionId) next += '-1'
    this.deps.store.set(umo, next)
    if (chat !== undefined) {
      this.chats.delete(umo)
      this.bySession.delete(oldSessionId)
      await chat.handle.dispose().catch(e => this.deps.log('warn', '关闭旧会话失败: ' + errText(e)))
    }
    this.deps.log('info', umo + ' 换到新会话 ' + next)
    const change: SessionChange = { umo, oldSessionId, newSessionId: next, reason }
    try {
      this.deps.sessionChanged(change)
    } catch (e) {
      this.deps.log('warn', 'napcat/session-changed 监听器出错: ' + errText(e))
    }
    return { oldSessionId, newSessionId: next }
  }

  /** 给其他插件用：让某个 QQ 会话换一个新的 dsh 会话（下一条消息进新会话）。 */
  rotateSession(umo: string): Promise<{ oldSessionId: string; newSessionId: string }> {
    return this.startNewSession(umo, 'rotate')
  }

  /** dsh 会话 id → QQ 会话信息。 */
  sessionInfo(sessionId: string): SessionInfo | undefined {
    return this.infos.get(sessionId)
  }

  /** QQ 会话（unified_msg_origin）→ 当前的会话信息。 */
  sessionInfoByUmo(umo: string): SessionInfo | undefined {
    const chat = this.chats.get(umo)
    if (chat !== undefined) return chat.info
    const id = this.deps.store.get(umo) ?? dshSessionId(umo)
    return this.infos.get(id)
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
   * 有聊天记录时接 <Forward Message>（本插件新增）；然后 <system_reminder>；最后是图片和视频截图。
   * 返回的内容还没交给 dsh 附件服务（dispatch 里统一交）。
   */
  private async buildContent(abm: AstrBotMessage, messageStr: string, own: Component[], videos: Component[], admin: boolean, s: BridgeSettings): Promise<ModelPart[]> {
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
    const texts: ModelPart[] = [{ type: 'text', text }]
    if (quoted !== null) texts.push({ type: 'text', text: quoted.text })
    if (forwarded !== null) texts.push({ type: 'text', text: forwarded.text })
    const reminder = this.reminder(abm, admin, s)
    if (reminder !== undefined) texts.push({ type: 'text', text: reminder })
    const asImage = (ref: string): Component => ({ type: 'Image', file: ref, url: ref.startsWith('http') ? ref : '', _type: '', path: '' })
    const quotedImages = (quoted?.imageRefs ?? []).map(asImage)
    const forwardImages = (forwarded?.imageRefs ?? []).map(asImage)
    const media = this.deps.media
    if (!settings.imageToModel || !media.canAttach() || own.length + quotedImages.length + forwardImages.length + videos.length === 0) {
      return texts
    }
    const parts: ModelPart[] = [...texts]
    let budget = settings.maxImages > 0 ? settings.maxImages : Infinity
    let failed = 0
    const add = async (images: Component[], label?: string): Promise<void> => {
      const got = await media.convert(images, budget)
      budget -= got.used
      failed += got.failed
      if (got.parts.length === 0) return
      if (label !== undefined) parts.push({ type: 'text', text: label })
      parts.push(...got.parts)
    }
    await add(own)
    await add(quotedImages, '（下面是被引用消息里的图片）')
    await add(forwardImages, '（下面是聊天记录里的图片）')
    // 本插件新增：视频截图（每个视频前面有一句说明）
    for (const video of videos) {
      if (budget <= 0) break
      const v = await media.video(video, budget)
      budget -= v.parts.filter(p => p.type === 'image').length
      parts.push(...v.parts)
    }
    if (failed > 0) parts.push({ type: 'text', text: '（有 ' + failed + ' 张图片没能读取）' })
    return parts
  }

  private ensureChat(target: Target): Promise<Chat> {
    const umo = target.umo
    const pending = this.creating.get(umo)
    if (pending !== undefined) return pending
    const existing = this.chats.get(umo)
    // 本插件新增：设置里的模型或思考等级改了，等这个会话不在回复时，关掉旧的连接、用新设置接回同一个会话（聊天记录不变）
    const stale = existing !== undefined && !existing.running && existing.modelKey !== this.modelFor(target).key
    if (existing !== undefined && !stale) return Promise.resolve(existing)
    const task = (async () => {
      if (existing !== undefined) {
        this.chats.delete(umo)
        this.bySession.delete(String((existing.handle.agent as Agent).session.id))
        await existing.handle.dispose().catch(e => this.deps.log('warn', '关闭旧连接失败: ' + errText(e)))
        this.deps.log('info', umo + '：模型或思考等级改了，换成新设置（同一个会话）')
      }
      return this.createChat(target)
    })().finally(() => this.creating.delete(umo))
    this.creating.set(umo, task)
    return task
  }

  /**
   * 本插件新增：其他插件主动唤醒她（比如定时主动聊天）。给这个 QQ 会话的 dsh 会话发一条内容（来源 plugin:napcat-bridge-wake），
   * 她一轮说完的回复照常发到 QQ；回复以「不发」暗号开头时不发。会话还没建过时先建。群里每人单独一个会话的 umo 不支持。
   */
  async wake(umo: string, content: ModelPart[] | string): Promise<{ sessionId: string }> {
    const parts = umo.split(':')
    if (parts.length !== 3) throw new Error('会话标识不对：' + umo)
    const [platform, type, id] = parts
    if (type !== MessageType.GROUP_MESSAGE && type !== MessageType.FRIEND_MESSAGE) throw new Error('只能唤醒私聊或群聊：' + umo)
    if (id.includes('_')) throw new Error('不支持群里每人单独会话的唤醒：' + umo)
    const selfId = this.deps.selfId()
    if (selfId === undefined) throw new Error('NapCat 还没连上')
    const isGroup = type === MessageType.GROUP_MESSAGE
    const session: MessageSession = { platform_name: platform, message_type: type as MessageType, session_id: id }
    const send = (chain: MessageChain): Promise<void> => this.deps.sendBySession(session, chain)
    const chat = await this.ensureChat({ umo, session, isGroup, isUnique: false, ...(isGroup ? { groupId: id } : { userId: id }), senderId: isGroup ? '' : id, selfId, send })
    const admitted = await this.deps.media.admit(typeof content === 'string' ? [{ type: 'text', text: content }] : content)
    chat.handle.agent.followup(createUserMessage({ content: admitted as never, source: { kind: 'plugin:napcat-bridge-wake' } }))
    return { sessionId: String((chat.handle.agent as Agent).session.id) }
  }

  /** 这个会话该用的模型和思考等级：主人私聊 > 私聊/群聊 > dsh 默认模型（本插件新增思考等级）。 */
  private modelFor(target: Target): { agentOptions: { provider: string; model: string; reasoningEffort?: string } | undefined; modelText: string; chosen: { provider: string; model: string } | undefined; key: string } {
    const settings = this.deps.settings()
    const isGroup = target.isGroup
    const adminPrivate = !isGroup && settings.admins.includes(target.senderId)
    const pick = (v: { private: string; group: string; adminPrivate: string }): string => (adminPrivate ? v.adminPrivate : '') || (isGroup ? v.group : v.private)
    const modelText = pick(settings.models)
    const chosen = modelText !== '' ? parseModel(modelText) : undefined
    if (modelText !== '' && chosen === undefined) this.deps.log('warn', '模型「' + modelText + '」格式不对，应写成 提供方/模型；改用默认模型')
    const selection = chosen ?? this.deps.defaultModel()?.currentSelection()
    const effort: string = pick(settings.reasoning) || (selection !== undefined && 'reasoningEffort' in selection ? String(selection.reasoningEffort ?? '') : '')
    const agentOptions = selection ? { provider: selection.provider, model: selection.model, ...(effort ? { reasoningEffort: effort } : {}) } : undefined
    return { agentOptions, modelText, chosen, key: agentOptions ? agentOptions.provider + '/' + agentOptions.model + '#' + (agentOptions.reasoningEffort ?? '') : '' }
  }

  private async createChat(target: Target): Promise<Chat> {
    const umo = target.umo
    const settings = this.deps.settings()
    const sessionId = this.deps.store.get(umo) ?? dshSessionId(umo)
    const isGroup = target.isGroup
    const adminPrivate = !isGroup && settings.admins.includes(target.senderId)
    // 预设和模型：主人私聊 > 私聊/群聊 > 默认 > dsh 当前的默认预设（网页里选的，没选过就是部署默认）
    const presets = this.deps.presets()
    const presetId = (adminPrivate ? settings.presets.adminPrivate : '') || (isGroup ? settings.presets.group : settings.presets.private) || settings.presets.default || presets?.defaultId || undefined
    const { agentOptions, modelText, chosen, key: modelKey } = this.modelFor(target)
    const setup: AgentSetup | undefined = presets !== undefined && presetId !== undefined
      ? (async (agentCtx: unknown) => { await presets.mount(agentCtx, presetId) }) as unknown as AgentSetup
      : undefined
    // 本插件新增：建会话之前先登记它对应哪个 QQ 会话（预设里的插件在 setup 时就能查到）
    const info: SessionInfo = {
      umo,
      sessionId,
      platformId: target.session.platform_name,
      selfId: target.selfId,
      type: isGroup ? 'group' : 'private',
      ...(target.groupId !== undefined ? { groupId: target.groupId } : {}),
      ...(target.userId !== undefined ? { userId: target.userId } : {}),
      adminPrivate,
    }
    this.infos.set(sessionId, info)
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
      this.deps.log('info', '新建会话 ' + sessionId + '（' + umo + (presetId ? '，预设 ' + presetId : '') + (chosen ? '，模型 ' + modelText : '') + (agentOptions?.reasoningEffort ? '，思考 ' + agentOptions.reasoningEffort : '') + '）')
    }
    const chat: Chat = { umo, session: target.session, handle, lastText: '', send: target.send, info, fresh: !exists, modelKey, running: false }
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
      chat.running = true
    } else if (event.type === 'assistant/message') {
      const text = (event.data.message.content as ReadonlyArray<{ type: string; text?: string }>)
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('')
      if (text.trim() !== '') chat.lastText = text
    } else if (event.type === 'turn/end') {
      chat.running = false
      const text = chat.lastText
      chat.lastText = ''
      if (text.trim() === '') return
      // 本插件新增：她决定这次不说话（主动唤醒时）
      const token = this.deps.settings().silenceToken.trim()
      if (token !== '' && text.trim().startsWith(token)) {
        this.deps.log('info', umo + '：她决定不发')
        return
      }
      const reply: MessageChain = { chain: [Plain(text)] }
      // 本插件新增：像真人一样按打字速度等一会儿，群里守发言频率
      void this.pacer.run(umo, chat.info.type === 'group', text, () => chat.send(reply)).then(result => {
        if (result === 'dropped') return
        this.notifySent({ umo, session: chat.session, text, chain: reply, source: 'reply', time: Date.now() })
      }, e => {
        this.deps.log('error', '发送回复失败（' + umo + '）: ' + (e instanceof Error ? e.message : String(e)))
      })
    }
  }

  /** 发 'napcat/sent'；监听器出错不影响发送。 */
  notifySent(payload: SentPayload): void {
    try {
      this.deps.sent(payload)
    } catch (e) {
      this.deps.log('warn', 'napcat/sent 监听器出错: ' + errText(e))
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
