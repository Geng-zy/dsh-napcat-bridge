#!/usr/bin/env node
// 检查各个上游有没有新版本：拿最新版本和 upstreams.json 里的 aligned 比较。
// 有新版本不代表一定要改代码，但每一个都要按交接文档「什么时候要更新代码」一节逐项判断并记录结论。
// 用法：node scripts/check-upstreams.mjs（依赖也要查：pnpm outdated）
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = JSON.parse(readFileSync(join(ROOT, 'upstreams.json'), 'utf-8')).upstreams

const headers = { 'user-agent': 'dsh-napcat-bridge', accept: 'application/vnd.github+json' }
if (process.env.GITHUB_TOKEN) headers.authorization = 'Bearer ' + process.env.GITHUB_TOKEN
const get = async (url, raw = false) => {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(url + ' → HTTP ' + res.status)
  return raw ? res.text() : res.json()
}

const checks = {
  dsh: async () => {
    const tags = (await get('https://registry.npmjs.org/@deepseek-ai/dsh'))['dist-tags']
    return { latest: tags.latest, note: 'next=' + tags.next + ' alpha=' + tags.alpha }
  },
  astrbot: async () => ({ latest: (await get('https://api.github.com/repos/AstrBotDevs/AstrBot/releases/latest')).tag_name }),
  aiocqhttp: async () => ({ latest: (await get('https://pypi.org/pypi/aiocqhttp/json')).info.version }),
  napcat: async () => ({ latest: (await get('https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest')).tag_name }),
  linuxqq: async () => {
    const script = await get('https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh', true)
    const m = /linuxqq_target_version="([^"]+)"/.exec(script)
    return { latest: m ? m[1] : '（没找到，检查安装脚本是否改了写法）' }
  },
  qface: async () => {
    const c = await get('https://api.github.com/repos/koishijs/QFace/commits?path=public/assets/qq_emoji/_index.v2.json&per_page=1')
    return { latest: c[0].sha.slice(0, 7), note: '提交于 ' + c[0].commit.author.date }
  },
  ffmpeg: async () => {
    const rel = await get('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest')
    const names = rel.assets.map(a => a.name)
    const versions = names.map(n => /^ffmpeg-n(\d+\.\d+)-latest-linux64-lgpl-/.exec(n)?.[1]).filter(Boolean)
      .sort((a, b) => { const [x1, y1] = a.split('.').map(Number); const [x2, y2] = b.split('.').map(Number); return x1 - x2 || y1 - y2 })
    const sums = names.includes('checksums.sha256') ? '' : '；没有 checksums.sha256，一键安装会失败'
    return { latest: versions.length > 0 ? 'n' + versions.at(-1) : '（没找到 linux64 LGPL 包，检查命名是否变了）', note: '一键安装用的包' + sums }
  },
  node: async () => {
    const list = await get('https://nodejs.org/dist/index.json')
    return { latest: list.find(r => r.version.startsWith('v24.')).version.slice(1) }
  },
}

let changed = 0
for (const [name, check] of Object.entries(checks)) {
  try {
    const { latest, note } = await check()
    const aligned = base[name]?.aligned
    const same = latest === aligned
    if (!same) changed += 1
    console.log((same ? '  一致  ' : '★有新版') + '  ' + name.padEnd(10) + ' 对齐 ' + String(aligned).padEnd(14) + ' 最新 ' + latest + (note ? '（' + note + '）' : ''))
  } catch (e) {
    changed += 1
    console.log('✗查不到  ' + name.padEnd(10) + ' ' + (e instanceof Error ? e.message : String(e)))
  }
}
console.log()
console.log(changed === 0 ? '上游都没有新版本。还要运行 pnpm outdated 看依赖。' : '有 ' + changed + ' 项需要按交接文档逐项判断。还要运行 pnpm outdated 看依赖。')
