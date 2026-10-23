// dsh 一侧：替代 AstrBot 的事件队列和流水线里与连接有关的部分。
// - 每条转换好的消息都通过 ctx 事件 'napcat/message' 广播（给记忆等其他插件用）；
// - 按 AstrBot WakingCheckStage 的默认规则判断是否唤醒；唤醒后把 message_str 交给
//   unified_msg_origin 对应的 dsh 会话；
// - 会话一轮结束时，把模型最后一条回复的文字原样发回（AstrBot 平台不支持流式时也是整条发）。

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  AiocqhttpMessageEvent, MessageType, sessionToString,
  type AstrBotMessage, type MessageSession,
} from './adapter.js'
import { Plain, type Component } from './components.js'
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
  /** 广播给其他插件 */
  emit(abm: AstrBotMessage, event: AiocqhttpMessageEvent, isWake: boolean): void
  cwd: string
  agentPreset: string
  wake: WakeConfig
  log: Logger
}

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
export function wakingCheck(event: AiocqhttpMessageEvent, wake: WakeConfig): { isWake: boolean; messageStr: string; stop: boolean } {
  if (wake.ignoreBotSelfMessage && event.getSelfId() === event.getSenderId()) {
    return { isWake: false, messageStr: event.message_str, stop: true }
  }
  let messageStr = event.message_str.trim()
  const messages: Component[] = event.message_obj.message
  let isWake = false
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
  return { isWake, messageStr, stop: false }
}

export class Bridge {
  private readonly chats = new Map<string, Chat>()
  private readonly bySession = new Map<string, string>()
  private readonly creating = new Map<string, Promise<Chat>>()
  private readonly off: () => void

  constructor(private readonly deps: BridgeDeps) {
    this.off = deps.onSessionEvent((session, event) => this.onSessionEvent(session, event))
  }

  /** 适配器 handle_msg 的去处。 */
  async handle(abm: AstrBotMessage, event: AiocqhttpMessageEvent): Promise<void> {
    const { isWake, messageStr, stop } = wakingCheck(event, this.deps.wake)
    try {
      this.deps.emit(abm, event, isWake && !stop)
    } catch (e) {
      this.deps.log('warn', 'napcat/message 监听器出错: ' + (e instanceof Error ? e.message : String(e)))
    }
    if (stop || !isWake) return
    // 只有消息事件带文字；通知/请求的 message_str 为空，不交给模型
    if (messageStr === '') return
    const chat = await this.ensureChat(event)
    chat.replyTo = event
    chat.handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: messageStr }],
      source: { kind: 'plugin:napcat-bridge' },
    }))
  }

  private ensureChat(event: AiocqhttpMessageEvent): Promise<Chat> {
    const umo = event.unified_msg_origin
    const existing = this.chats.get(umo)
    if (existing !== undefined) return Promise.resolve(existing)
    const pending = this.creating.get(umo)
    if (pending !== undefined) return pending
    const task = this.createChat(umo, event).finally(() => this.creating.delete(umo))
    this.creating.set(umo, task)
    return task
  }

  private async createChat(umo: string, event: AiocqhttpMessageEvent): Promise<Chat> {
    const sessionId = dshSessionId(umo)
    const selection = this.deps.defaultModel()?.currentSelection()
    const agentOptions = selection ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } : undefined
    const presetId = this.deps.agentPreset || undefined
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
        meta: { cwd: this.deps.cwd, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
        agentOptions: agentOptions as never,
        setup,
      })
      this.deps.log('info', '新建会话 ' + sessionId + '（' + umo + '）')
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
