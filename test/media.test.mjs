// 单元测试：视频抽帧的时间点、时长解析、ffmpeg 一键安装（假的下载，不联网）。
// 用法：node --test test/（先 pnpm run build）
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { checksumFor, formatDuration, installFfmpeg, parseDuration, pickAsset, planFrames, platformTag } from '../lib/ffmpeg.js'

const S = { maxFrames: 4, secondsPerFrame: 5 }

test('截图时间点：整段平均分布，短视频少截，第一张在开头附近', () => {
  assert.deepEqual(planFrames(32, S), [0.5, 8.5, 16.5, 24.5])
  assert.deepEqual(planFrames(10, S), [0.5, 5.5])
  assert.deepEqual(planFrames(3, S), [0.5])
  assert.deepEqual(planFrames(0.4, S), [0.2])
  assert.deepEqual(planFrames(undefined, S), [0])
  assert.equal(planFrames(3600, S).length, 4)
  assert.equal(planFrames(3600, { maxFrames: 1, secondsPerFrame: 5 }).length, 1)
})

test('从 ffmpeg 输出读时长', () => {
  assert.equal(parseDuration('Input #0, mov\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 1 kb/s'), 62.5)
  assert.equal(parseDuration('  Duration: 01:00:00.00,'), 3600)
  assert.equal(parseDuration('Duration: N/A'), undefined)
  assert.equal(formatDuration(32.04), '0:32')
  assert.equal(formatDuration(3725), '1:02:05')
})

test('挑下载包：最新正式版分支的 LGPL 版；只支持 Linux', () => {
  const names = [
    'checksums.sha256',
    'ffmpeg-master-latest-linux64-lgpl.tar.xz',
    'ffmpeg-n8.1-latest-linux64-lgpl-8.1.tar.xz',
    'ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz',
    'ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz',
    'ffmpeg-n9.0-latest-linuxarm64-lgpl-9.0.tar.xz',
    'ffmpeg-n10.0-latest-win64-lgpl-10.0.zip',
  ]
  assert.equal(pickAsset(names, 'linux64'), 'ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz')
  assert.equal(pickAsset(names, 'linuxarm64'), 'ffmpeg-n9.0-latest-linuxarm64-lgpl-9.0.tar.xz')
  assert.equal(platformTag('linux', 'x64'), 'linux64')
  assert.equal(platformTag('linux', 'arm64'), 'linuxarm64')
  assert.equal(platformTag('darwin', 'arm64'), undefined)
  assert.equal(checksumFor('abc\n' + 'a'.repeat(64) + '  x.tar.xz\n' + 'b'.repeat(64) + '  y.tar.xz\n', 'y.tar.xz'), 'b'.repeat(64))
  assert.equal(checksumFor('', 'y.tar.xz'), undefined)
})

/** 做一个假的 BtbN 发布：tar.xz 里有 bin/ffmpeg（一个会报版本的脚本）。 */
function fakeRelease(tamper = false) {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-rel-'))
  const name = 'ffmpeg-n9.0-latest-linux64-lgpl-9.0'
  mkdirSync(join(root, name, 'bin'), { recursive: true })
  writeFileSync(join(root, name, 'bin', 'ffmpeg'), '#!/bin/sh\necho "ffmpeg version n9.0-fake"\n')
  chmodSync(join(root, name, 'bin', 'ffmpeg'), 0o755)
  const archive = join(root, name + '.tar.xz')
  execFileSync('tar', ['-cJf', archive, '-C', root, name])
  const bytes = readFileSync(archive)
  const sum = tamper ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')
  const base = 'https://example.invalid/'
  const release = { assets: [
    { name: name + '.tar.xz', browser_download_url: base + name + '.tar.xz', size: bytes.length },
    { name: 'checksums.sha256', browser_download_url: base + 'checksums.sha256' },
  ] }
  const fakeFetch = async url => {
    if (url === 'https://api.example.invalid/release') return new Response(JSON.stringify(release))
    if (url === base + 'checksums.sha256') return new Response(sum + '  ' + name + '.tar.xz\n')
    if (url === base + name + '.tar.xz') return new Response(bytes)
    return new Response('not found', { status: 404 })
  }
  return { fakeFetch, dir: join(root, 'install') }
}

test('一键安装：下载、核对 SHA256、解压出 ffmpeg 并能运行', async () => {
  const { fakeFetch, dir } = fakeRelease()
  const states = []
  const found = await installFfmpeg({ releaseApi: 'https://api.example.invalid/release', platform: 'linux', arch: 'x64', dir, fetch: fakeFetch, onProgress: s => states.push(s.state) })
  assert.equal(found.path, join(dir, 'ffmpeg'))
  assert.equal(found.version, 'ffmpeg version n9.0-fake')
  assert.ok(states.includes('verifying') && states.includes('extracting'))
})

test('一键安装：SHA256 对不上时不安装', async () => {
  const { fakeFetch, dir } = fakeRelease(true)
  await assert.rejects(
    installFfmpeg({ releaseApi: 'https://api.example.invalid/release', platform: 'linux', arch: 'x64', dir, fetch: fakeFetch }),
    /SHA256 对不上/,
  )
  assert.equal(existsSync(join(dir, 'ffmpeg')), false)
})

test('一键安装：不支持的平台直接说明', async () => {
  await assert.rejects(installFfmpeg({ platform: 'darwin', arch: 'arm64' }), /只支持 Linux/)
})

test('一键安装：连不上 GitHub 时告诉怎么用系统软件源装', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-offline-'))
  const offline = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(
    installFfmpeg({ releaseApi: 'https://api.example.invalid/release', platform: 'linux', arch: 'x64', dir, fetch: offline }),
    /连不上 GitHub[\s\S]*sudo apt install -y ffmpeg[\s\S]*fetch failed/,
  )
})
