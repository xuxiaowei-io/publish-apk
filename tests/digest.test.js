/**
 * 文件摘要测试：`node tests/digest.test.js`。
 *
 * 验证两件事：
 *   1. src/digest.js 的 MD5 / SHA-1 / SHA-256 / SHA-512 与 node:crypto 直算结果一致、长度固定、输出行顺序固定；
 *   2. hap 命令默认在「文件 / 大小」之后输出 MD5 / SHA-1 / SHA-256，SHA-512 只在 --verbose 出现。
 *
 * HAP 用最小自造包（仅 pack.info + module.json，store 方式打包），不依赖 DevEco 构建产物。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { DIGEST_HELP_NOTE, digestLines, fileDigests } from '../src/digest.js'

const CLI = fileURLToPath(new URL('../src/publish-apk.js', import.meta.url))

/** 去掉宿主环境的 HAP 变量，避免影响断言 */
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('HAP_')),
)

/** CRC32（ZIP 本地头 / 中央目录需要；本测试的解析器不校验，但保持目录结构合法） */
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 用 store（method 0）方式写一个最小的合法 ZIP */
function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)

    locals.push(local, nameBuffer, data)
    centrals.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }

  const localBlock = Buffer.concat(locals)
  const centralBlock = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBlock.length, 12)
  eocd.writeUInt32LE(localBlock.length, 16)

  return Buffer.concat([localBlock, centralBlock, eocd])
}

/** 最小 HAP：pack.info + module.json */
function buildHap() {
  const packInfo = {
    summary: {
      app: { bundleName: 'com.example.digest', version: { name: '1.0.0', code: 1 } },
      modules: [
        {
          mainAbility: 'EntryAbility',
          distro: { moduleName: 'entry', moduleType: 'entry' },
          deviceType: ['phone'],
        },
      ],
    },
    packages: [{ name: 'entry', moduleType: 'entry' }],
  }
  const moduleJson = {
    app: {
      bundleName: 'com.example.digest',
      versionName: '1.0.0',
      versionCode: 1,
      minAPIVersion: 10,
      targetAPIVersion: 12,
    },
    module: {
      name: 'entry',
      type: 'entry',
      deviceTypes: ['phone'],
      mainElement: 'EntryAbility',
      abilities: [{ name: 'EntryAbility' }],
    },
  }
  return zip([
    { name: 'pack.info', data: Buffer.from(JSON.stringify(packInfo)) },
    { name: 'module.json', data: Buffer.from(JSON.stringify(moduleJson)) },
  ])
}

function runHap(filePath, ...args) {
  return spawnSync(process.execPath, [CLI, 'hap', '--file', filePath, ...args], {
    encoding: 'utf8',
    env: { ...BASE_ENV, HAP_FILE: '', HAP_VERBOSE: '' },
  })
}

// ---------------------------------------------------------------- 单元断言

{
  const data = Buffer.from('publish-apk digest test\n')
  const digests = fileDigests(data)
  assert.equal(digests.md5, createHash('md5').update(data).digest('hex'), 'MD5 与 node:crypto 一致')
  assert.equal(digests.sha1, createHash('sha1').update(data).digest('hex'), 'SHA-1 与 node:crypto 一致')
  assert.equal(digests.sha256, createHash('sha256').update(data).digest('hex'), 'SHA-256 与 node:crypto 一致')
  assert.equal(digests.sha512, createHash('sha512').update(data).digest('hex'), 'SHA-512 与 node:crypto 一致')
  assert.equal(digests.md5.length, 32, 'MD5 长度 32')
  assert.equal(digests.sha1.length, 40, 'SHA-1 长度 40')
  assert.equal(digests.sha256.length, 64, 'SHA-256 长度 64')
  assert.equal(digests.sha512.length, 128, 'SHA-512 长度 128')
  assert.match(digests.md5, /^[0-9a-f]{32}$/, 'MD5 是小写十六进制')
  assert.match(digests.sha1, /^[0-9a-f]{40}$/, 'SHA-1 是小写十六进制')
  assert.match(digests.sha256, /^[0-9a-f]{64}$/, 'SHA-256 是小写十六进制')
  assert.match(digests.sha512, /^[0-9a-f]{128}$/, 'SHA-512 是小写十六进制')
}

{
  const digests = {
    md5: 'a'.repeat(32),
    sha1: 'b'.repeat(40),
    sha256: 'c'.repeat(64),
    sha512: 'd'.repeat(128),
  }
  assert.deepEqual(
    digestLines(digests),
    [
      `MD5: ${'a'.repeat(32)}`,
      `SHA-1: ${'b'.repeat(40)}`,
      `SHA-256: ${'c'.repeat(64)}`,
    ],
    '默认摘要行固定为 MD5 / SHA-1 / SHA-256',
  )
  assert.deepEqual(
    digestLines(digests, true),
    [
      `MD5: ${'a'.repeat(32)}`,
      `SHA-1: ${'b'.repeat(40)}`,
      `SHA-256: ${'c'.repeat(64)}`,
      `SHA-512: ${'d'.repeat(128)}`,
    ],
    '--verbose 追加 SHA-512 且顺序固定',
  )
  assert.deepEqual(digestLines(null), [], 'null 不输出摘要行')
  assert.deepEqual(digestLines(undefined), [], 'undefined 不输出摘要行')
}

// ---------------------------------------------------------------- 命令断言

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-apk-digest-'))
try {
  const hapPath = path.join(dir, 'digest.hap')
  const hap = buildHap()
  fs.writeFileSync(hapPath, hap)

  const result = runHap(hapPath)
  assert.equal(result.status, 0, result.stderr)
  const expected = fileDigests(hap)
  assert.ok(result.stdout.includes(`MD5: ${expected.md5}`), `默认输出缺少 MD5\n${result.stdout}`)
  assert.ok(result.stdout.includes(`SHA-1: ${expected.sha1}`), `默认输出缺少 SHA-1\n${result.stdout}`)
  assert.ok(result.stdout.includes(`SHA-256: ${expected.sha256}`), `默认输出缺少 SHA-256\n${result.stdout}`)
  assert.ok(!result.stdout.includes('SHA-512:'), `默认输出不应有 SHA-512\n${result.stdout}`)

  const md5Index = result.stdout.indexOf('MD5:')
  const sha1Index = result.stdout.indexOf('SHA-1:')
  const sha256Index = result.stdout.indexOf('SHA-256:')
  const formatIndex = result.stdout.indexOf('格式: HAP')
  assert.ok(md5Index > -1 && md5Index < sha1Index, 'MD5 在 SHA-1 之前')
  assert.ok(sha1Index < sha256Index, 'SHA-1 在 SHA-256 之前')
  assert.ok(sha256Index < formatIndex, '摘要位于「文件 / 大小」与「格式」之间')

  const verbose = runHap(hapPath, '--verbose')
  assert.equal(verbose.status, 0, verbose.stderr)
  assert.ok(verbose.stdout.includes(`SHA-512: ${expected.sha512}`), `--verbose 缺少 SHA-512\n${verbose.stdout}`)
  assert.ok(verbose.stdout.indexOf('SHA-512:') < verbose.stdout.indexOf('格式: HAP'), '--verbose 的 SHA-512 位于摘要区')

  const help = spawnSync(process.execPath, [CLI, 'hap', '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.ok(help.stdout.includes(DIGEST_HELP_NOTE), '帮助文档缺少摘要说明')

  console.log('digest.test.js: ok')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
