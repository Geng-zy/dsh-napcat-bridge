// 本插件新增：发消息的节奏，让她像真人一样回消息。
//   1. 打字速度：发之前按「每分钟打几个字」等一会儿（有最短、最长等待），私聊和群聊可以分别开关；
//   2. 群里的发言频率：同一个群两条之间至少隔几秒，一段时间里最多发几条；超出就排队等，等太久（默认 2 分钟）就不发了。
// 同一个会话的消息按顺序一条一条发，不会因为后一条更短就先发出去。
// 只管她自己的回复（包括主动聊天时的回复）；其他插件用 ctx.napcat.sendBySession 发的不经过这里。

export interface PaceSettings {
  typingPrivate: boolean
  typingGroup: boolean
  /** 每分钟打几个字 */
  charsPerMinute: number
  typingMinSeconds: number
  typingMaxSeconds: number
  /** 同一个群两条之间至少隔几秒（0 = 不限） */
  groupMinGapSeconds: number
  /** 一段时间里最多发几条（0 = 不限） */
  groupMaxPerWindow: number
  groupWindowSeconds: number
  /** 为了守频率最多等几秒，超过就不发了 */
  maxWaitSeconds: number
}

export interface PacerDeps {
  settings(): PaceSettings
  log(level: 'debug' | 'info' | 'warn', message: string): void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** 按打字速度要等多久（毫秒）。 */
export function typingDelay(text: string, isGroup: boolean, s: PaceSettings): number {
  if (!(isGroup ? s.typingGroup : s.typingPrivate) || s.charsPerMinute <= 0) return 0
  const chars = [...text.replace(/\s+/g, '')].length
  const seconds = (chars * 60) / s.charsPerMinute
  const lo = Math.max(0, s.typingMinSeconds)
  const hi = Math.max(lo, s.typingMaxSeconds)
  return Math.round(Math.min(hi, Math.max(lo, seconds)) * 1000)
}

/** 为了守群里的发言频率还要等多久（毫秒）；sent 是这个群最近发出的时间（从早到晚）。 */
export function rateDelay(sent: readonly number[], now: number, s: PaceSettings): number {
  let wait = 0
  const last = sent[sent.length - 1]
  if (s.groupMinGapSeconds > 0 && last !== undefined) wait = Math.max(wait, last + s.groupMinGapSeconds * 1000 - now)
  if (s.groupMaxPerWindow > 0) {
    const windowMs = Math.max(1, s.groupWindowSeconds) * 1000
    const recent = sent.filter(t => t > now - windowMs)
    if (recent.length >= s.groupMaxPerWindow) wait = Math.max(wait, recent[recent.length - s.groupMaxPerWindow] + windowMs - now)
  }
  return Math.max(0, wait)
}

export class Pacer {
  private queues = new Map<string, Promise<unknown>>()
  private sent = new Map<string, number[]>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: PacerDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  }

  /** 排进这个会话的队列，等打字、守频率，然后发。返回发了没有。 */
  run(umo: string, isGroup: boolean, text: string, send: () => Promise<void>): Promise<'sent' | 'dropped'> {
    const prev = this.queues.get(umo) ?? Promise.resolve()
    const job = prev.catch(() => undefined).then(() => this.one(umo, isGroup, text, send))
    this.queues.set(umo, job)
    void job.finally(() => { if (this.queues.get(umo) === job) this.queues.delete(umo) }).catch(() => undefined)
    return job
  }

  private async one(umo: string, isGroup: boolean, text: string, send: () => Promise<void>): Promise<'sent' | 'dropped'> {
    const s = this.deps.settings()
    const start = this.now()
    const typing = typingDelay(text, isGroup, s)
    if (typing > 0) await this.sleep(typing)
    if (isGroup) {
      const windowMs = Math.max(1, s.groupWindowSeconds, s.groupMinGapSeconds) * 1000
      const history = (this.sent.get(umo) ?? []).filter(t => t > this.now() - windowMs)
      const wait = rateDelay(history, this.now(), s)
      if (wait > 0) {
        if (this.now() + wait - start > Math.max(0, s.maxWaitSeconds) * 1000 + typing) {
          this.deps.log('warn', umo + '：群里发得太频繁，这条等太久了，不发（' + text.slice(0, 30) + '）')
          return 'dropped'
        }
        this.deps.log('debug', umo + '：守群里的发言频率，等 ' + Math.round(wait / 1000) + ' 秒再发')
        await this.sleep(wait)
      }
    }
    await send()
    if (isGroup) {
      const windowMs = Math.max(1, s.groupWindowSeconds, s.groupMinGapSeconds) * 1000
      const now = this.now()
      this.sent.set(umo, [...(this.sent.get(umo) ?? []).filter(t => t > now - windowMs), now])
    }
    return 'sent'
  }
}
