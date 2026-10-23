#!/usr/bin/env node
// 重新生成 src/qface.ts（QQ 小黄脸编号 → 名字）。
// 数据：koishijs/QFace（MIT，Copyright Shigma）
//   1. 仓库 public/assets/qq_emoji/_index.v2.json 最新一次提交的数字编号部分，优先；
//   2. 上面没有的旧编号，用 npm 包 qface 1.4.1 的 lib/data.json 补上（早年下架的表情）。
// 用法：node scripts/update-qface.mjs
// 跑完看输出里"新增 / 改名"，把来源提交号写进 NOTICE.md 和 CHANGELOG.md。
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'qface.ts')
const getJson = async url => {
  const res = await fetch(url, { headers: { 'user-agent': 'dsh-napcat-bridge' } })
  if (!res.ok) throw new Error(url + ' → HTTP ' + res.status)
  return res.json()
}

const commits = await getJson('https://api.github.com/repos/koishijs/QFace/commits?path=public/assets/qq_emoji/_index.v2.json&per_page=1')
const sha = commits[0].sha
const v2 = await getJson('https://raw.githubusercontent.com/koishijs/QFace/' + sha + '/public/assets/qq_emoji/_index.v2.json')
// 旧数据：仓库 lib/data.json，和 npm 包 qface 1.4.1 里的是同一份
const old = await getJson('https://raw.githubusercontent.com/koishijs/QFace/' + sha + '/lib/data.json')

const names = {}
for (const [id, def] of Object.entries(v2.emojis)) {
  if (/^\d+$/.test(id)) names[id] = String(def.describe ?? '').replace(/^\//, '')
}
let filled = 0
for (const e of old) {
  const id = String(e.QSid)
  if (!(id in names)) {
    names[id] = String(e.QDes).replace(/^\//, '')
    filled += 1
  }
}

// 和现有文件比较，方便写更新记录
let before = {}
try {
  const { QFACE } = await import(join(ROOT, 'lib', 'qface.js'))
  before = QFACE
} catch {
  // 还没编译过就不比较
}
const added = Object.keys(names).filter(k => !(k in before))
const renamed = Object.keys(names).filter(k => k in before && before[k] !== names[k]).map(k => k + ' ' + before[k] + '→' + names[k])

const keys = Object.keys(names).sort((a, b) => Number(a) - Number(b))
const lines = [
  '// QQ 小黄脸（face 段）编号 → 名字。由 scripts/update-qface.mjs 生成，不要手改。',
  '// 数据来源（都是 MIT，作者 Shigma，https://github.com/koishijs/QFace）：',
  '//   1. 仓库 public/assets/qq_emoji/_index.v2.json（提交 ' + sha.slice(0, 7) + '，' + String(v2.syncedAt).slice(0, 10) + ' 从 QQ 同步）的数字编号部分，优先使用；',
  '//   2. 上面没有的旧编号，用仓库 lib/data.json（即 npm 包 qface 1.4.1 的数据）补上（早年下架的表情，旧消息里仍可能出现）。',
  '// 表情名字本身是 QQ（腾讯）的；这里只用编号和名字，不含图片。共 ' + keys.length + ' 个。',
  'export const QFACE: Record<string, string> = {',
  ...keys.map(k => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(names[k]) + ','),
  '}',
]
writeFileSync(OUT, lines.join('\n') + '\n')
console.log('来源提交：' + sha.slice(0, 7) + '（同步于 ' + v2.syncedAt + '）')
console.log('共 ' + keys.length + ' 个，最大编号 ' + keys.at(-1) + '，旧数据补了 ' + filled + ' 个')
console.log('新增 ' + added.length + ' 个：' + added.slice(0, 30).join(' '))
console.log('改名 ' + renamed.length + ' 个：' + renamed.join('；'))
