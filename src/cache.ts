// 本插件新增（不在 AstrBot 里）：带过期时间和容量上限的简单缓存。

export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>()

  constructor(private readonly ttlMs: number, private readonly max: number) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key)
    if (hit === undefined) return undefined
    if (hit.expires <= Date.now()) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, { value, expires: Date.now() + this.ttlMs })
    // Map 按插入顺序迭代，超出上限时删最早的
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  /** 同一个 key 并发请求只发一次；结果（包括失败时的 fallback）缓存起来。 */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const cached = this.get(key)
    if (cached !== undefined) return cached
    const pending = this.pending.get(key)
    if (pending !== undefined) return pending
    const task = load().then(value => {
      this.set(key, value)
      return value
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }

  private readonly pending = new Map<string, Promise<V>>()
}
