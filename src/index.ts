// dsh 插件入口：照 AstrBot 的 aiocqhttp（OneBot v11）适配器，把 NapCat 接到 dsh。

import z from '@deepseek-ai/schemastery'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { AiocqhttpAdapter, AiocqhttpMessageEvent, MessageType, sessionToString, type AstrBotMessage, type MessageSession } from './adapter.js'
import { Bridge, type PromptPayload, type SentPayload, type SessionChange, type SessionInfo } from './bridge.js'
import type { MessageChain } from './components.js'
import { findFfmpeg, installFfmpeg, platformTag, type InstallState } from './ffmpeg.js'
import { Media, type ModelPart } from './media.js'
import type { Logger } from './onebot/server.js'
import { SessionStore, defaultDataDir } from './store.js'
import { join } from 'node:path'

export * from './adapter.js'
export * from './components.js'
export type { PromptPayload, SentPayload, SessionChange, SessionInfo } from './bridge.js'
export type { Converted, Media, ModelPart } from './media.js'
export { ActionFailed, ApiNotAvailable, NetworkError } from './onebot/errors.js'

export interface Config {
  id: string
  ws_reverse_host: string
  ws_reverse_port: number
  ws_reverse_token: string
  wake_prefix: string[]
  friend_message_needs_wake_prefix: boolean
  ignore_bot_self_message: boolean
  workspacePath: string
  agentPreset: string
  identifier: boolean
  imageToModel: boolean
  maxImages: number
  admins: string[]
  whitelistEnabled: boolean
  whitelist: string[]
  whitelistIgnoreAdminOnGroup: boolean
  whitelistIgnoreAdminOnFriend: boolean
  whitelistLog: boolean
  rateLimitCount: number
  rateLimitSeconds: number
  rateLimitStrategy: 'stall' | 'discard'
  emptyMentionWaiting: boolean
  emptyMentionNeedReply: boolean
  uniqueSession: boolean
  datetimeReminder: boolean
  timezone: string
  groupNameDisplay: boolean
  markAdmin: boolean
  commandsEnabled: boolean
  noPermissionReply: boolean
  privateAgentPreset: string
  groupAgentPreset: string
  adminPrivateAgentPreset: string
  privateModel: string
  groupModel: string
  adminPrivateModel: string
  adminPrivateReasoning: 'off' | 'low' | 'high' | 'max'
  privateReasoning: 'off' | 'low' | 'high' | 'max'
  groupReasoning: 'off' | 'low' | 'high' | 'max'
  sttMode: 'off' | 'command' | 'openai'
  sttCommand: string
  sttApiUrl: string
  sttApiKey: string
  sttModel: string
  videoFrames: boolean
  videoMaxFrames: number
  videoSecondsPerFrame: number
  videoMaxEdge: number
  videoMaxMB: number
  videoMaxMinutes: number
  videoTimeoutSeconds: number
  ffmpegPath: string
  silenceToken: string
  typingPrivate: boolean
  typingGroup: boolean
  typingCharsPerMinute: number
  typingMinSeconds: number
  typingMaxSeconds: number
  groupMinGapSeconds: number
  groupMaxPerWindow: number
  groupWindowSeconds: number
  sendMaxWaitSeconds: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/** 插件收到的配置：每项都是可实时读取的引用（.get()），设置页保存后立即更新。 */
export type LiveConfig = { [K in keyof Config]: { get(): Config[K] } }

// 每项都标 .volatile()：dsh 的设置服务只对这种字段提供在线编辑，保存后插件不重启、直接读到新值。
export const Config: z<LiveConfig> = z.object({
  id: z.string().default('napcat').volatile().description('平台 ID，会话标识 unified_msg_origin 的第一段（AstrBot 的机器人 ID）'),
  ws_reverse_host: z.string().default('0.0.0.0').volatile().description('反向 WebSocket 监听地址（AstrBot 默认 0.0.0.0）'),
  ws_reverse_port: z.natural().max(65535).default(6199).volatile().description('反向 WebSocket 端口（AstrBot 默认 6199）'),
  ws_reverse_token: z.string().role('secret').volatile().description('反向 WebSocket Token，与 NapCat 里填的一致；留空则不校验'),
  wake_prefix: z.array(z.string()).default(['/']).volatile().description('唤醒前缀（AstrBot 默认 ["/"]）'),
  friend_message_needs_wake_prefix: z.boolean().default(false).volatile().description('私聊是否也需要唤醒前缀'),
  ignore_bot_self_message: z.boolean().default(false).volatile().description('是否忽略机器人自己发出的消息'),
  workspacePath: z.string().default('').volatile().description('QQ 会话的工作目录（绝对路径）；留空用 dsh 进程当前目录'),
  agentPreset: z.string().default('').volatile().description('QQ 会话使用的 agent 预设 id；留空用默认预设'),
  identifier: z.boolean().default(true).volatile().description('群消息交给模型时前面加 [昵称(QQ号)]'),
  imageToModel: z.boolean().default(true).volatile().description('图片（含商城表情、引用消息里的图片）作为附件交给模型；模型要支持看图（如 deepseek-flash）'),
  maxImages: z.natural().default(0).volatile().description('一条消息最多交给模型几张图片；0 = 不限'),
  // 访问控制（AstrBot platform_settings / admins_id）
  admins: z.array(z.string()).default([]).volatile().description('管理员 QQ 号'),
  whitelistEnabled: z.boolean().default(true).volatile().description('启用白名单（名单为空时不检查）'),
  whitelist: z.array(z.string()).default([]).volatile().description('白名单：群号、QQ 号（私聊）或完整会话标识'),
  whitelistIgnoreAdminOnGroup: z.boolean().default(true).volatile().description('群里管理员不受白名单限制'),
  whitelistIgnoreAdminOnFriend: z.boolean().default(true).volatile().description('私聊管理员不受白名单限制'),
  whitelistLog: z.boolean().default(true).volatile().description('不在白名单时记日志'),
  rateLimitCount: z.natural().default(30).volatile().description('频率限制：时间窗口内最多处理几条（0 = 不限）'),
  rateLimitSeconds: z.natural().min(1).default(60).volatile().description('频率限制：时间窗口（秒）'),
  rateLimitStrategy: z.union(['stall', 'discard']).default('stall').volatile().description('超出后：stall 排队等，discard 丢弃'),
  // 唤醒
  emptyMentionWaiting: z.boolean().default(true).volatile().description('只 @ 她不说话时，等这个人 60 秒内的下一条'),
  emptyMentionNeedReply: z.boolean().default(true).volatile().description('只 @ 她时先让她问一句'),
  uniqueSession: z.boolean().default(false).volatile().description('群里每人单独一个会话'),
  // 交给模型的内容
  datetimeReminder: z.boolean().default(true).volatile().description('告诉模型当前时间'),
  timezone: z.string().default('Asia/Shanghai').volatile().description('时区'),
  groupNameDisplay: z.boolean().default(true).volatile().description('告诉模型群名'),
  markAdmin: z.boolean().default(true).volatile().description('发送者是管理员时告诉模型'),
  // 指令
  commandsEnabled: z.boolean().default(true).volatile().description('启用 QQ 里的指令（/help /sid /new /reset /stop）'),
  noPermissionReply: z.boolean().default(true).volatile().description('没有权限用指令时回一句'),
  // 按聊天类型选预设和模型（只影响新建的会话）
  privateAgentPreset: z.string().default('').volatile().description('私聊用的预设'),
  groupAgentPreset: z.string().default('').volatile().description('群聊用的预设'),
  adminPrivateAgentPreset: z.string().default('').volatile().description('管理员私聊用的预设'),
  privateModel: z.string().default('').volatile().description('私聊用的模型（提供方/模型）'),
  groupModel: z.string().default('').volatile().description('群聊用的模型（提供方/模型）'),
  adminPrivateModel: z.string().default('').volatile().description('管理员私聊用的模型（提供方/模型）'),
  adminPrivateReasoning: z.union(['off', 'low', 'high', 'max']).default('high').volatile().description('管理员私聊的思考等级（DeepSeek：off 不思考，low / high / max 越来越深）'),
  privateReasoning: z.union(['off', 'low', 'high', 'max']).default('low').volatile().description('其他私聊的思考等级'),
  groupReasoning: z.union(['off', 'low', 'high', 'max']).default('low').volatile().description('群聊的思考等级'),
  // 语音转文字
  sttMode: z.union(['off', 'command', 'openai']).default('off').volatile().description('语音转文字：off 关闭，command 本机命令，openai 兼容接口'),
  sttCommand: z.string().default('').volatile().description('本机命令，{file} 换成语音文件路径，输出就是文字'),
  sttApiUrl: z.string().default('').volatile().description('OpenAI 兼容接口地址（到 /v1 为止）'),
  sttApiKey: z.string().role('secret').volatile().description('接口 Key'),
  sttModel: z.string().default('').volatile().description('转写模型名'),
  // 视频（本插件新增）：用 ffmpeg 截几张画面当图片交给模型
  videoFrames: z.boolean().default(true).volatile().description('视频抽帧：截几张画面交给模型（找不到 ffmpeg 时自动当作关闭）'),
  videoMaxFrames: z.natural().min(1).default(4).volatile().description('每个视频最多截几张'),
  videoSecondsPerFrame: z.natural().min(1).default(5).volatile().description('短视频少截：每多少秒最多一张'),
  videoMaxEdge: z.natural().min(64).default(1024).volatile().description('截图最长边（像素）'),
  videoMaxMB: z.natural().min(1).default(100).volatile().description('超过这么大（MB）只截封面'),
  videoMaxMinutes: z.natural().min(1).default(10).volatile().description('超过这么长（分钟）只截封面'),
  videoTimeoutSeconds: z.natural().min(5).default(30).volatile().description('处理一个视频最多用几秒，超时只写 [视频]'),
  ffmpegPath: z.string().default('').volatile().description('ffmpeg 位置；留空先找插件自己装的，再找系统里的'),
  silenceToken: z.string().default('[不发]').volatile().description('她的回复以这个开头时不发出去（主动唤醒时她决定不说话用）'),
  typingPrivate: z.boolean().default(true).volatile().description('私聊里按打字速度等一会儿再发'),
  typingGroup: z.boolean().default(true).volatile().description('群里按打字速度等一会儿再发'),
  typingCharsPerMinute: z.natural().default(60).volatile().description('打字速度：每分钟几个字（0 = 不等）'),
  typingMinSeconds: z.natural().default(2).volatile().description('打字最少等几秒'),
  typingMaxSeconds: z.natural().default(30).volatile().description('打字最多等几秒'),
  groupMinGapSeconds: z.natural().default(5).volatile().description('同一个群她两条消息之间至少隔几秒（0 = 不限）'),
  groupMaxPerWindow: z.natural().default(5).volatile().description('同一个群一段时间里她最多发几条（0 = 不限）'),
  groupWindowSeconds: z.natural().min(1).default(60).volatile().description('上面那段时间是几秒'),
  sendMaxWaitSeconds: z.natural().default(120).volatile().description('为了守发言频率最多等几秒，超过就不发了'),
  logLevel: z.union(['debug', 'info', 'warn', 'error']).default('info').volatile().description('日志级别'),
}) as never

export const name = 'dsh-napcat-bridge'
// agentDefaultModel / agentPresets / sessionPersistence 是可选的，用到时再 ctx.get
export const inject = ['agents']

/** 给其他插件（如记忆插件）用的服务：ctx.napcat */
export interface NapcatService {
  adapter: AiocqhttpAdapter
  /** 调用任意 OneBot API */
  callAction(action: string, params?: Record<string, unknown>): Promise<any>
  /** 按会话主动发送（AstrBot send_by_session）；发出后也会发 'napcat/sent' */
  sendBySession(session: MessageSession, chain: MessageChain): Promise<void>
  /** 已建立的会话 */
  sessions(): Array<{ umo: string; sessionId: string }>
  /** dsh 会话 id → 对应的 QQ 会话（私聊/群聊、QQ 号、群号、是不是主人私聊）；不是 QQ 会话时 undefined */
  sessionInfo(sessionId: string): SessionInfo | undefined
  /** QQ 会话（unified_msg_origin）→ 当前的会话信息 */
  sessionInfoByUmo(umo: string): SessionInfo | undefined
  /** 让某个 QQ 会话换一个新的 dsh 会话（旧的留在 dsh 里，下一条消息进新会话） */
  rotateSession(umo: string): Promise<{ oldSessionId: string; newSessionId: string }>
  /** 图片、语音、视频 → 模型内容（按插件一的设置：语音转文字、视频抽帧、图片数量） */
  media: Media
  /** 主动唤醒她：给这个 QQ 会话发一条内容，她一轮说完的回复照常发到 QQ（以「不发」暗号开头时不发） */
  wake(umo: string, content: ModelPart[] | string): Promise<{ sessionId: string }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    napcat: NapcatService
  }
  interface Events {
    /** 每条转换好的 OneBot 消息/通知/请求；isWake 表示是否会交给模型 */
    'napcat/message'(abm: AstrBotMessage, event: AiocqhttpMessageEvent, isWake: boolean): void
    /** 交给模型之前（serial）：监听者可以直接改 payload.content，往前后加文字或图片 */
    'napcat/prompt'(payload: PromptPayload): void | Promise<void>
    /** 她发出了一条 QQ 消息 */
    'napcat/sent'(payload: SentPayload): void
    /** QQ 会话换了新的 dsh 会话（/new、/reset 或 rotateSession） */
    'napcat/session-changed'(change: SessionChange): void
  }
}

type Context = CordisContext & {
  agents: AgentRegistry
  agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } | undefined }
  agentPresets?: { mount(agentCtx: unknown, id?: string): Promise<{ id: string }> }
  sessionPersistence?: { stat(id: string): Promise<object | undefined> }
}

const RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const

/** 多久检查一次监听地址/端口有没有被设置页改过。 */
const ADDRESS_POLL_MS = 1000

export function apply(ctx: Context, live: LiveConfig): void {
  // 密钥字段不设默认值（设置页才能分清"没设置"和"设成空"），读不到时当空字符串
  const get = <K extends keyof Config>(key: K): Config[K] => (live[key]?.get() ?? (key === 'ws_reverse_token' || key === 'sttApiKey' ? '' : undefined)) as Config[K]
  const log: Logger = (level, message) => {
    if (RANK[level] < RANK[get('logLevel')]) return
    const line = '[napcat-bridge] ' + message
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  const callAction = (action: string, params: Record<string, unknown> = {}): Promise<any> => adapter.bot.callAction(action, params)
  const videoSettings = () => ({
    enabled: get('videoFrames'),
    maxFrames: get('videoMaxFrames'),
    secondsPerFrame: get('videoSecondsPerFrame'),
    maxEdge: get('videoMaxEdge'),
    maxMB: get('videoMaxMB'),
    maxMinutes: get('videoMaxMinutes'),
    timeoutSeconds: get('videoTimeoutSeconds'),
    ffmpegPath: get('ffmpegPath'),
  })
  const sttSettings = () => ({ mode: get('sttMode'), command: get('sttCommand'), apiUrl: get('sttApiUrl'), apiKey: get('sttApiKey'), model: get('sttModel') })
  const media = new Media({
    callAction,
    attachments: () => ctx.get('attachments' as never) as never,
    settings: () => ({ imageToModel: get('imageToModel'), maxImages: get('maxImages'), stt: sttSettings(), video: videoSettings() }),
    log,
  })

  const bridge: Bridge = new Bridge({
    agents: ctx.agents,
    defaultModel: () => ctx.get('agentDefaultModel' as never) as Context['agentDefaultModel'],
    presets: () => ctx.get('agentPresets' as never) as Context['agentPresets'],
    persistence: () => ctx.get('sessionPersistence' as never) as Context['sessionPersistence'],
    media,
    callAction,
    onSessionEvent: listener => ctx.on('session/event' as never, ((session: Session, event: SessionEvent) => listener(session, event)) as never),
    emit: (abm, event, isWake) => ctx.emit('napcat/message', abm, event, isWake),
    prompt: payload => ctx.serial('napcat/prompt', payload),
    sent: payload => ctx.emit('napcat/sent', payload),
    sessionChanged: change => ctx.emit('napcat/session-changed', change),
    sendBySession: (session, chain) => adapter.sendBySession(session, chain),
    selfId: () => adapter.bot.connections()[0]?.selfId as string | undefined,
    store: new SessionStore(join(defaultDataDir(), 'sessions.json')),
    settings: () => ({
      cwd: get('workspacePath') || process.cwd(),
      wake: {
        wakePrefix: [...get('wake_prefix')],
        ignoreBotSelfMessage: get('ignore_bot_self_message'),
        friendMessageNeedsWakePrefix: get('friend_message_needs_wake_prefix'),
      },
      identifier: get('identifier'),
      imageToModel: get('imageToModel'),
      maxImages: get('maxImages'),
      admins: get('admins').map(String),
      whitelist: {
        enabled: get('whitelistEnabled'),
        ids: get('whitelist').map(String),
        ignoreAdminOnGroup: get('whitelistIgnoreAdminOnGroup'),
        ignoreAdminOnFriend: get('whitelistIgnoreAdminOnFriend'),
        log: get('whitelistLog'),
      },
      rateLimit: { count: get('rateLimitCount'), seconds: get('rateLimitSeconds'), strategy: get('rateLimitStrategy') },
      emptyMention: { waiting: get('emptyMentionWaiting'), needReply: get('emptyMentionNeedReply') },
      uniqueSession: get('uniqueSession'),
      reminder: { datetime: get('datetimeReminder'), timezone: get('timezone'), groupName: get('groupNameDisplay'), markAdmin: get('markAdmin') },
      commands: { enabled: get('commandsEnabled'), noPermissionReply: get('noPermissionReply') },
      presets: { default: get('agentPreset'), private: get('privateAgentPreset'), group: get('groupAgentPreset'), adminPrivate: get('adminPrivateAgentPreset') },
      models: { private: get('privateModel'), group: get('groupModel'), adminPrivate: get('adminPrivateModel') },
      reasoning: { private: get('privateReasoning'), group: get('groupReasoning'), adminPrivate: get('adminPrivateReasoning') },
      stt: sttSettings(),
      video: videoSettings(),
      silenceToken: get('silenceToken') ?? '[不发]',
      pace: {
        typingPrivate: get('typingPrivate'), typingGroup: get('typingGroup'), charsPerMinute: get('typingCharsPerMinute'),
        typingMinSeconds: get('typingMinSeconds'), typingMaxSeconds: get('typingMaxSeconds'),
        groupMinGapSeconds: get('groupMinGapSeconds'), groupMaxPerWindow: get('groupMaxPerWindow'), groupWindowSeconds: get('groupWindowSeconds'),
        maxWaitSeconds: get('sendMaxWaitSeconds'),
      },
    }),
    log,
  })

  const adapter: AiocqhttpAdapter = new AiocqhttpAdapter({
    id: () => get('id'),
    ws_reverse_host: get('ws_reverse_host'),
    ws_reverse_port: get('ws_reverse_port'),
    ws_reverse_token: () => get('ws_reverse_token'),
    log,
    onMessage: (abm, event): Promise<void> => bridge.handle(abm, event),
  })

  const service: NapcatService = {
    adapter,
    callAction,
    sendBySession: async (session, chain) => {
      await adapter.sendBySession(session, chain)
      const text = chain.chain.filter(c => c.type === 'Plain').map(c => String(c.text ?? '')).join('')
      bridge.notifySent({ umo: sessionToString(session), session, text, chain, source: 'service', time: Date.now() })
    },
    sessions: () => bridge.sessions(),
    sessionInfo: sessionId => bridge.sessionInfo(sessionId),
    sessionInfoByUmo: umo => bridge.sessionInfoByUmo(umo),
    rotateSession: umo => bridge.rotateSession(umo),
    media,
    wake: (umo, content) => bridge.wake(umo, content),
  }
  ctx.provide('napcat', service)

  // 视频抽帧用的 ffmpeg：设置页查状态、一键安装
  let install: InstallState = { state: 'idle' }
  const ffmpegStatus = async (fresh: boolean): Promise<Record<string, unknown>> => {
    const found = await findFfmpeg(get('ffmpegPath'), fresh)
    return {
      found: found ?? null,
      installSupported: platformTag() !== undefined,
      platform: process.platform + '-' + process.arch,
      install,
    }
  }
  const startInstall = (): void => {
    if (['downloading', 'verifying', 'extracting'].includes(install.state)) return
    install = { state: 'downloading' }
    log('info', '开始安装 ffmpeg')
    installFfmpeg({ onProgress: next => { install = next } }).then(found => {
      install = { state: 'done', version: found.version, finishedAt: Date.now() }
      log('info', 'ffmpeg 已安装：' + found.version)
    }, (error: unknown) => {
      install = { state: 'failed', error: errText(error), finishedAt: Date.now() }
      log('error', '安装 ffmpeg 失败: ' + errText(error))
    })
  }

  // 设置页「测试连接」：GET <dsh>/api/napcat-bridge/status。
  // 挂在 dsh 的 /api 钩子上，请求先通过 dsh 网页的登录校验才会到这里；返回里不含 Token。
  const status = async (): Promise<Record<string, unknown>> => {
    const bot = adapter.bot
    const connections = bot.connections()
    let login: { user_id: unknown; nickname: unknown } | undefined
    let loginError: string | undefined
    if (connections.length > 0) {
      try {
        const info = await Promise.race([
          bot.callAction('get_login_info', { self_id: connections[0].selfId }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('5 秒内没有回应')), 5000)),
        ]) as Record<string, unknown> | null
        login = { user_id: info?.user_id, nickname: info?.nickname }
      } catch (error) {
        loginError = error instanceof Error ? error.message : String(error)
      }
    }
    const rejected = bot.lastRejected !== undefined && Date.now() - bot.lastRejected.at < 10 * 60_000 ? bot.lastRejected : undefined
    return {
      listening: bot.listening,
      address: get('ws_reverse_host') + ':' + get('ws_reverse_port'),
      tokenSet: get('ws_reverse_token') !== '',
      connections,
      login,
      loginError,
      lastRejected: rejected,
    }
  }
  // 视频：GET <dsh>/api/napcat-bridge/ffmpeg 查状态；POST <dsh>/api/napcat-bridge/ffmpeg/install 开始安装
  ctx.on('connection/request' as never, (async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => Promise<void>) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const json = (code: number, value: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (path.endsWith('/napcat-bridge/status')) return json(200, await status())
    if (path.endsWith('/napcat-bridge/ffmpeg') && req.method === 'GET') return json(200, await ffmpegStatus(true))
    if (path.endsWith('/napcat-bridge/ffmpeg/install')) {
      if (req.method !== 'POST') return json(405, { error: 'POST only' })
      startInstall()
      return json(200, await ffmpegStatus(false))
    }
    return next()
  }) as never)

  // 本插件自带设置页（client.js），告诉 dsh 不用按 schema 自动生成表单
  ctx.inject(['settings'], child => {
    child.effect(() => (child as any).settings.configure({ auto: false }, ctx.fiber), 'napcat-bridge: settings policy')
  })

  const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  ctx.effect(() => {
    let address = get('ws_reverse_host') + ':' + get('ws_reverse_port')
    let switching: Promise<void> = adapter.run().then(
      () => log('info', '反向 WebSocket 已监听 ' + address),
      (error: unknown) => log('error', '启动反向 WebSocket 失败: ' + errText(error)),
    )
    // 设置页改了监听地址或端口：关掉旧的服务，用新地址重新监听（NapCat 会自动重连）
    const timer = setInterval(() => {
      const host = get('ws_reverse_host')
      const port = get('ws_reverse_port')
      const next = host + ':' + port
      if (next === address) return
      address = next
      switching = switching.then(() => adapter.restart(host, port)).then(
        () => log('info', '监听地址已改为 ' + next),
        (error: unknown) => log('error', '改用新监听地址失败: ' + errText(error)),
      )
    }, ADDRESS_POLL_MS)
    return async () => {
      clearInterval(timer)
      await switching
      await adapter.terminate()
      await bridge.dispose()
    }
  }, 'napcat-bridge')
}

export { MessageType }
