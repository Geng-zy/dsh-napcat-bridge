// 移植自 aiocqhttp（MIT）：CQHttp 的反向 WebSocket 部分 + api_impl.WebSocketReverseApi/ResultStore + bus.EventBus。
// 只保留 AstrBot 用到的 use_ws_reverse=True 路径（AstrBot 不配 api_root，HTTP API/HTTP 上报都不启用）。

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { ActionFailed, ApiNotAvailable, NetworkError } from './errors.js'
import { eventFromPayload, eventName, type OneBotEvent } from './event.js'

export type Handler = (event: OneBotEvent) => unknown | Promise<unknown>
export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

/** CQHttp 反向 WS 的路由（strict_slashes=False，结尾斜杠也接受）。 */
const WS_PATHS = new Set(['/ws', '/ws/event', '/ws/api'])

/** aiocqhttp.bus.EventBus：按 a.b.c → a.b → a 逐级触发订阅者，返回各结果。 */
class EventBus {
  private readonly subscribers = new Map<string, Handler[]>()

  subscribe(event: string, func: Handler): void {
    const list = this.subscribers.get(event) ?? []
    list.push(func)
    this.subscribers.set(event, list)
  }

  async emit(event: string, payload: OneBotEvent): Promise<unknown[]> {
    const results: unknown[] = []
    let current = event
    while (true) {
      const funcs = this.subscribers.get(current) ?? []
      results.push(...await Promise.all(funcs.map(f => f(payload))))
      const dot = current.lastIndexOf('.')
      if (dot < 0) break
      current = current.slice(0, dot)
    }
    return results
  }
}

/** api_impl._SequenceGenerator */
let seqCounter = 0
const nextSeq = (): number => {
  seqCounter += 1
  return seqCounter
}

interface Pending {
  resolve: (result: Record<string, any>) => void
  timer: NodeJS.Timeout
}

export interface CQHttpOptions {
  /** AstrBot：ws_reverse_token */
  accessToken?: string
  /** AstrBot：api_timeout_sec=180 */
  apiTimeoutSec?: number
  log: Logger
}

interface WsState {
  selfId: string
  isApi: boolean
  isEvent: boolean
}

/**
 * aiocqhttp.CQHttp（反向 WS）。NapCat 作为客户端连进来，
 * X-Client-Role 为 Universal / Event / API，X-Self-ID 为机器人 QQ 号。
 */
export class CQHttp {
  private readonly bus = new EventBus()
  private readonly accessToken: string
  private readonly timeoutMs: number
  private readonly log: Logger
  /** _wsr_api_clients: self_id → ws */
  readonly apiClients = new Map<string, WebSocket>()
  /** _wsr_event_clients */
  readonly eventClients = new Set<WebSocket>()
  /** ResultStore._futures */
  private readonly futures = new Map<number, Pending>()
  private readonly states = new WeakMap<WebSocket, WsState>()
  private http: Server | undefined
  private wss: WebSocketServer | undefined

  constructor(options: CQHttpOptions) {
    this.accessToken = options.accessToken ?? ''
    this.timeoutMs = (options.apiTimeoutSec ?? 180) * 1000
    this.log = options.log
  }

  /** bot.on(*event_names) */
  on(...names: string[]): (func: Handler) => Handler {
    return (func: Handler) => {
      for (const name of names) this.bus.subscribe(name, func)
      return func
    }
  }

  /** bot.on_message(*types) → message.{type} */
  onMessage(...types: string[]): (func: Handler) => Handler {
    return this.on(...(types.length > 0 ? types.map(t => 'message.' + t) : ['message']))
  }

  /** bot.on_notice(*types) */
  onNotice(...types: string[]): (func: Handler) => Handler {
    return this.on(...(types.length > 0 ? types.map(t => 'notice.' + t) : ['notice']))
  }

  /** bot.on_request(*types) */
  onRequest(...types: string[]): (func: Handler) => Handler {
    return this.on(...(types.length > 0 ? types.map(t => 'request.' + t) : ['request']))
  }

  /** bot.on_websocket_connection → on_meta_event('lifecycle.connect') */
  onWebsocketConnection(func: Handler): Handler {
    return this.on('meta_event.lifecycle.connect')(func)
  }

  /** bot.run_task(host, port)：启动服务器。 */
  async run(host: string, port: number): Promise<void> {
    const http = createServer((_req, res) => {
      // AstrBot 只启用反向 WS；HTTP 上报路由（POST /）在没有 api_root/secret 时也存在，
      // 但 AstrBot 场景下 NapCat 只走 WS，这里对普通 HTTP 请求返回 404。
      res.statusCode = 404
      res.end()
    })
    const wss = new WebSocketServer({ noServer: true })
    http.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '') || '/'
      if (!WS_PATHS.has(path)) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      const denied = this.checkAuth(req)
      if (denied !== undefined) {
        socket.write('HTTP/1.1 ' + denied + '\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, ws => this.handleWsr(ws, req))
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(port, host, () => {
        http.off('error', reject)
        resolve()
      })
    })
    this.http = http
    this.wss = wss
  }

  /** _handle_wsr 的鉴权部分：Authorization: Token|Bearer <token>，缺失 401，不符 403。 */
  private checkAuth(req: IncomingMessage): string | undefined {
    if (this.accessToken === '') return undefined
    const auth = String(req.headers.authorization ?? '')
    const m = /^(?:[Tt]oken|[Bb]earer) (\S+)$/.exec(auth)
    if (m === null) {
      this.log('warn', 'authorization header is missed')
      return '401 Unauthorized'
    }
    if (m[1].trim() !== this.accessToken) {
      this.log('warn', 'authorization header is invalid')
      return '403 Forbidden'
    }
    return undefined
  }

  /** _handle_wsr：按 X-Client-Role 分为 event / api / universal。 */
  private handleWsr(ws: WebSocket, req: IncomingMessage): void {
    const role = String(req.headers['x-client-role'] ?? '').toLowerCase()
    const selfId = String(req.headers['x-self-id'] ?? '')
    const state: WsState = {
      selfId,
      isApi: role === 'api' || role === 'universal',
      isEvent: role === 'event' || role === 'universal',
    }
    if (!state.isApi && !state.isEvent) {
      ws.close()
      return
    }
    this.states.set(ws, state)
    if (state.isApi) this.apiClients.set(selfId, ws)
    if (state.isEvent) this.eventClients.add(ws)

    ws.on('message', data => {
      let payload: unknown
      try {
        payload = JSON.parse(data.toString())
      } catch {
        payload = null
      }
      if (role === 'api') {
        // _handle_wsr_api：全部当 API 结果
        if (payload !== null && typeof payload === 'object') this.addResult(payload as Record<string, any>)
        return
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return
      const obj = payload as Record<string, any>
      if (role === 'event' || 'post_type' in obj) {
        void this.handleEventWithResponse(obj, ws)
      } else if (Object.keys(obj).length > 0) {
        this.addResult(obj)
      }
    })
    ws.on('close', () => {
      if (state.isEvent) this.eventClients.delete(ws)
      // 允许通配连接（self_id 可能是 '*'），先检查存在再删除
      if (state.isApi && this.apiClients.get(selfId) === ws) this.apiClients.delete(selfId)
    })
    ws.on('error', error => this.log('warn', 'websocket error: ' + error.message))
  }

  /** ResultStore.add */
  private addResult(result: Record<string, any>): void {
    const echo = result.echo
    if (echo !== null && typeof echo === 'object' && Number.isInteger(echo.seq)) {
      const pending = this.futures.get(echo.seq)
      if (pending !== undefined) pending.resolve(result)
    }
  }

  /** _handle_event */
  private async handleEvent(payload: Record<string, any>): Promise<unknown> {
    const ev = eventFromPayload(payload)
    if (ev === null) return undefined
    const name = eventName(ev)
    this.log('debug', 'received event: ' + name)
    const results = (await this.bus.emit(name, ev)).filter(r => r !== undefined && r !== null)
    return results.length > 0 ? results[0] : undefined
  }

  /** _handle_event_with_response：处理函数返回 dict 时走 .handle_quick_operation_async。 */
  private async handleEventWithResponse(payload: Record<string, any>, ws: WebSocket): Promise<void> {
    let response: unknown
    try {
      response = await this.handleEvent(payload)
    } catch (error) {
      this.log('error', 'event handler failed: ' + (error instanceof Error ? error.message : String(error)))
      return
    }
    if (response !== null && typeof response === 'object' && !Array.isArray(response)) {
      const context = { ...payload }
      delete context.message
      delete context.raw_message
      delete context.comment
      delete context.sender
      try {
        await this.callAction('.handle_quick_operation_async', { self_id: payload.self_id, context, operation: response }, ws)
      } catch {
        // aiocqhttp 吞掉 Error
      }
    }
  }

  /**
   * WebSocketReverseApi.call_action：
   * 指定 self_id 时用对应连接；否则在事件处理中用事件来源连接；否则只有一个连接时用它。
   * 返回 data 字段；status=failed 抛 ActionFailed；超时抛 NetworkError。
   */
  async callAction(action: string, params: Record<string, unknown> = {}, eventWs?: WebSocket): Promise<any> {
    let apiWs: WebSocket | undefined
    if (params.self_id !== undefined && params.self_id !== null && params.self_id !== '') {
      apiWs = this.apiClients.get(String(params.self_id))
    } else if (eventWs !== undefined && this.eventClients.has(eventWs)) {
      const state = this.states.get(eventWs)
      if (state !== undefined) apiWs = this.apiClients.get(state.selfId)
    } else if (this.apiClients.size === 1) {
      apiWs = [...this.apiClients.values()][0]
    }
    if (apiWs === undefined) throw new ApiNotAvailable()

    const seq = nextSeq()
    const result = await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.futures.delete(seq)
        reject(new NetworkError('WebSocket API call timeout'))
      }, this.timeoutMs)
      this.futures.set(seq, {
        resolve: value => {
          clearTimeout(timer)
          this.futures.delete(seq)
          resolve(value)
        },
        timer,
      })
      apiWs.send(JSON.stringify({ action, params, echo: { seq } }), error => {
        if (error) {
          clearTimeout(timer)
          this.futures.delete(seq)
          reject(new NetworkError(error.message))
        }
      })
    })
    // _handle_api_result
    if (result.status === 'failed') throw new ActionFailed(result)
    return result.data
  }

  /** bot.send_private_msg(**params) */
  sendPrivateMsg(params: Record<string, unknown>): Promise<any> {
    return this.callAction('send_private_msg', params)
  }

  /** bot.send_group_msg(**params) */
  sendGroupMsg(params: Record<string, unknown>): Promise<any> {
    return this.callAction('send_group_msg', params)
  }

  /** bot.send(event, message)：向触发事件的主体发送（send_msg）。 */
  send(event: OneBotEvent, message: unknown): Promise<any> {
    const params: Record<string, unknown> = {}
    for (const key of ['message_type', 'user_id', 'group_id', 'discuss_id']) {
      if (key in event) params[key] = event[key]
    }
    params.message = message
    if (!('message_type' in params)) {
      if ('group_id' in params) params.message_type = 'group'
      else if ('discuss_id' in params) params.message_type = 'discuss'
      else if ('user_id' in params) params.message_type = 'private'
    }
    if (event.self_id !== undefined) params.self_id = event.self_id
    return this.callAction('send_msg', params)
  }

  /** 关闭所有反向 WS 连接（AstrBot _close_reverse_ws_connections）并停止服务器。 */
  async close(): Promise<void> {
    const clients = new Set<WebSocket>([...this.apiClients.values(), ...this.eventClients])
    for (const ws of clients) {
      try {
        ws.close(1000, 'Adapter shutdown')
      } catch {
        // 忽略
      }
    }
    this.apiClients.clear()
    this.eventClients.clear()
    for (const [seq, pending] of this.futures) {
      clearTimeout(pending.timer)
      this.futures.delete(seq)
    }
    this.wss?.close()
    await new Promise<void>(resolve => {
      if (this.http === undefined) return resolve()
      this.http.close(() => resolve())
      this.http.closeAllConnections?.()
    })
    this.http = undefined
    this.wss = undefined
  }
}
