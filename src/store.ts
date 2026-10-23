// 本插件新增：记住每个 QQ 会话当前用的 dsh 会话 id（/new、/reset 之后会换成新的）。
// 存在 <DSH_HOME>/napcat-bridge/sessions.json，原子写（先写临时文件再改名）。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function defaultDataDir(): string {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'napcat-bridge')
}

export class SessionStore {
  private map: Record<string, string> = {}

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'))
      if (parsed !== null && typeof parsed === 'object') this.map = parsed
    } catch {
      this.map = {}
    }
  }

  get(umo: string): string | undefined {
    return this.map[umo]
  }

  set(umo: string, sessionId: string): void {
    this.map[umo] = sessionId
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.map, null, 2))
    renameSync(tmp, this.file)
  }
}
