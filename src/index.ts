// dsh 插件入口：照 AstrBot 的 aiocqhttp（OneBot v11）适配器，把 NapCat 接到 dsh。

import z from '@deepseek-ai/schemastery'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { AiocqhttpAdapter, AiocqhttpMessageEvent, MessageType, type AstrBotMessage, type MessageSession } from './adapter.js'
import { Bridge } from './bridge.js'
import type { MessageChain } from './components.js'
import type { Logger } from './onebot/server.js'

export * from './adapter.js'
export * from './components.js'
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
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

/** 插件收到的配置：每项都是可实时读取的引用（.get()），设置页保存后立即更新。 */
export type LiveConfig = { [K in keyof Config]: { get(): Config[K] } }

// 每项都标 .volatile()：dsh 的设置服务只对这种字段提供在线编辑，保存后插件不重启、直接读到新值。
export const Config: z<LiveConfig> = z.object({
  id: z.string().default('napcat').volatile().description('平台 ID，会话标识 unified_msg_origin 的第一段（AstrBot 的机器人 ID）'),
  ws_reverse_host: z.string().default('0.0.0.0').volatile().description('反向 WebSocket 监听地址（AstrBot 默认 0.0.0.0）'),
  ws_reverse_port: z.natural().max(65535).default(6199).volatile().description('反向 WebSocket 端口（AstrBot 默认 6199）'),
  ws_reverse_token: z.string().role('secret').default('').volatile().description('反向 WebSocket Token，与 NapCat 里填的一致；留空则不校验'),
  wake_prefix: z.array(z.string()).default(['/']).volatile().description('唤醒前缀（AstrBot 默认 ["/"]）'),
  friend_message_needs_wake_prefix: z.boolean().default(false).volatile().description('私聊是否也需要唤醒前缀'),
  ignore_bot_self_message: z.boolean().default(false).volatile().description('是否忽略机器人自己发出的消息'),
  workspacePath: z.string().default('').volatile().description('QQ 会话的工作目录（绝对路径）；留空用 dsh 进程当前目录'),
  agentPreset: z.string().default('').volatile().description('QQ 会话使用的 agent 预设 id；留空用默认预设'),
  identifier: z.boolean().default(true).volatile().description('群消息交给模型时前面加 [昵称(QQ号)]'),
  imageToModel: z.boolean().default(true).volatile().description('图片（含商城表情、引用消息里的图片）作为附件交给模型；模型要支持看图（如 deepseek-flash）'),
  maxImages: z.natural().default(0).volatile().description('一条消息最多交给模型几张图片；0 = 不限'),
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
  /** 按会话主动发送（AstrBot send_by_session） */
  sendBySession(session: MessageSession, chain: MessageChain): Promise<void>
  /** 已建立的会话 */
  sessions(): Array<{ umo: string; sessionId: string }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    napcat: NapcatService
  }
  interface Events {
    /** 每条转换好的 OneBot 消息/通知/请求；isWake 表示是否会交给模型 */
    'napcat/message'(abm: AstrBotMessage, event: AiocqhttpMessageEvent, isWake: boolean): void
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
  const get = <K extends keyof Config>(key: K): Config[K] => live[key].get()
  const log: Logger = (level, message) => {
    if (RANK[level] < RANK[get('logLevel')]) return
    const line = '[napcat-bridge] ' + message
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  const bridge: Bridge = new Bridge({
    agents: ctx.agents,
    defaultModel: () => ctx.get('agentDefaultModel' as never) as Context['agentDefaultModel'],
    presets: () => ctx.get('agentPresets' as never) as Context['agentPresets'],
    persistence: () => ctx.get('sessionPersistence' as never) as Context['sessionPersistence'],
    attachments: () => ctx.get('attachments' as never) as never,
    callAction: (action: string, params: Record<string, unknown>): Promise<any> => adapter.bot.callAction(action, params),
    onSessionEvent: listener => ctx.on('session/event' as never, ((session: Session, event: SessionEvent) => listener(session, event)) as never),
    emit: (abm, event, isWake) => ctx.emit('napcat/message', abm, event, isWake),
    settings: () => ({
      cwd: get('workspacePath') || process.cwd(),
      agentPreset: get('agentPreset'),
      wake: {
        wakePrefix: [...get('wake_prefix')],
        ignoreBotSelfMessage: get('ignore_bot_self_message'),
        friendMessageNeedsWakePrefix: get('friend_message_needs_wake_prefix'),
      },
      identifier: get('identifier'),
      imageToModel: get('imageToModel'),
      maxImages: get('maxImages'),
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
    callAction: (action, params = {}) => adapter.bot.callAction(action, params),
    sendBySession: (session, chain) => adapter.sendBySession(session, chain),
    sessions: () => bridge.sessions(),
  }
  ctx.provide('napcat', service)

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
  ctx.on('connection/request' as never, (async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => Promise<void>) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (!path.endsWith('/napcat-bridge/status')) return next()
    const body = JSON.stringify(await status())
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
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
