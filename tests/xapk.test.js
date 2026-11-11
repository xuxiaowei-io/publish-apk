/**
 * xapk 端到端测试：`node tests/xapk.test.js`。
 *
 * 不联网、不依赖真实安装包：测试进程里用 Node 内置 zlib 构造 ZIP，
 * 再手写一份最小 Android 二进制 XML 作为内层 APK 的 AndroidManifest.xml，
 * 最后用子进程执行真实 CLI，覆盖默认输出、--verbose、环境变量与错误路径。
 *
 * 断言重点：
 *   - manifest.json + base / split APK 的汇总字段（包名、版本、SDK、ABI、DEX、拆分与 OBB）；
 *   - 默认输出附 --verbose 提示，--verbose 追加外层条目、manifest.json 与各 split 明细；
 *   - XAPK_FILE / XAPK_VERBOSE 环境变量；
 *   - 没有 manifest.json 时按内层 APK 推断；
 *   - 普通 APK、只有 manifest.json 的 ZIP 给出明确错误。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'

// ------------------------------------------------------------------ ZIP

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 用 deflate 构造标准 ZIP（本地头 + 中央目录 + EOCD） */
function zip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8')
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data)
    const compressed = deflateRawSync(data)
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + compressed.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, ...centralParts, eocd])
}

// ------------------------------------------------- Android 二进制 XML

/** 元素节点：attrs 的值统一按字符串属性写入 */
function node(name, attrs = {}, children = []) {
  return { name, attrs, children }
}

/**
 * 编码一份最小 Android 二进制 XML。
 *
 * 结构：XML 头 + 字符串池 + 嵌套的 start / end element chunk。
 * 属性值统一用 TYPE_STRING，足够让 src/apk.js 的解析器读出 manifest 字段。
 */
function binaryXml(root) {
  const strings = []
  const indexes = new Map()
  const intern = (value) => {
    let index = indexes.get(value)
    if (index === undefined) {
      index = strings.length
      indexes.set(value, index)
      strings.push(value)
    }
    return index
  }
  const indexOf = (value) => {
    const index = indexes.get(value)
    assert.notEqual(index, undefined, `字符串未收集: ${value}`)
    return index
  }
  const collect = (element) => {
    intern(element.name)
    for (const [name, value] of Object.entries(element.attrs)) {
      intern(name)
      intern(String(value))
    }
    for (const child of element.children) {
      collect(child)
    }
  }
  collect(root)

  // 字符串池：UTF-16，每个字符串前置 u16 长度
  const headerSize = 28
  const stringsStart = headerSize + strings.length * 4
  const dataParts = []
  const offsets = []
  let dataLength = 0
  for (const text of strings) {
    const encoded = Buffer.from(text, 'utf16le')
    const prefix = Buffer.alloc(2)
    prefix.writeUInt16LE(text.length, 0)
    offsets.push(dataLength)
    dataParts.push(prefix, encoded)
    dataLength += prefix.length + encoded.length
  }
  const poolSize = stringsStart + dataLength
  const pool = Buffer.alloc(poolSize)
  pool.writeUInt16LE(0x0001, 0)
  pool.writeUInt16LE(headerSize, 2)
  pool.writeUInt32LE(poolSize, 4)
  pool.writeUInt32LE(strings.length, 8)
  pool.writeUInt32LE(0, 12)
  pool.writeUInt32LE(0, 16)
  pool.writeUInt32LE(stringsStart, 20)
  offsets.forEach((offset, index) => pool.writeUInt32LE(offset, headerSize + index * 4))
  let poolOffset = stringsStart
  for (const part of dataParts) {
    part.copy(pool, poolOffset)
    poolOffset += part.length
  }

  const startChunk = (element) => {
    const attrs = Object.entries(element.attrs)
    const size = 16 + 20 + attrs.length * 20
    const chunk = Buffer.alloc(size)
    chunk.writeUInt16LE(0x0102, 0)
    chunk.writeUInt16LE(16, 2)
    chunk.writeUInt32LE(size, 4)
    chunk.writeUInt32LE(0xffffffff, 12)
    chunk.writeUInt32LE(0xffffffff, 16)
    chunk.writeUInt32LE(indexOf(element.name), 20)
    chunk.writeUInt16LE(20, 24)
    chunk.writeUInt16LE(20, 26)
    chunk.writeUInt16LE(attrs.length, 28)
    attrs.forEach(([name, value], index) => {
      const at = 36 + index * 20
      chunk.writeUInt32LE(0xffffffff, at)
      chunk.writeUInt32LE(indexOf(name), at + 4)
      chunk.writeUInt32LE(0xffffffff, at + 8)
      chunk.writeUInt16LE(8, at + 12)
      chunk.writeUInt8(0x03, at + 15)
      chunk.writeUInt32LE(indexOf(String(value)), at + 16)
    })
    return chunk
  }

  const endChunk = (element) => {
    const chunk = Buffer.alloc(24)
    chunk.writeUInt16LE(0x0103, 0)
    chunk.writeUInt16LE(16, 2)
    chunk.writeUInt32LE(24, 4)
    chunk.writeUInt32LE(0xffffffff, 12)
    chunk.writeUInt32LE(0xffffffff, 16)
    chunk.writeUInt32LE(indexOf(element.name), 20)
    return chunk
  }

  const chunks = []
  const walk = (element) => {
    chunks.push(startChunk(element))
    for (const child of element.children) {
      walk(child)
    }
    chunks.push(endChunk(element))
  }
  walk(root)

  const body = Buffer.concat([pool, ...chunks])
  const header = Buffer.alloc(8)
  header.writeUInt16LE(0x0003, 0)
  header.writeUInt16LE(8, 2)
  header.writeUInt32LE(8 + body.length, 4)
  return Buffer.concat([header, body])
}

// ------------------------------------------------------------- 测试数据

const PACKAGE_NAME = 'com.example.demo'

/** 构造内层 APK：二进制 Manifest + 可选 dex / 原生库 */
function buildApk({ versionName, abi, dex }) {
  const manifest = node(
    'manifest',
    {
      package: PACKAGE_NAME,
      versionCode: '25',
      versionName,
    },
    [
      node('uses-sdk', { minSdkVersion: '26', targetSdkVersion: '36' }),
      node('uses-permission', { name: 'android.permission.INTERNET' }),
      node('application', { label: 'Demo App' }, [
        node('activity', { name: '.MainActivity' }, [
          node('intent-filter', {}, [
            node('action', { name: 'android.intent.action.MAIN' }),
            node('category', { name: 'android.intent.category.LAUNCHER' }),
          ]),
        ]),
      ]),
    ],
  )
  const entries = [{ name: 'AndroidManifest.xml', data: binaryXml(manifest) }]
  if (dex === true) {
    entries.push({ name: 'classes.dex', data: Buffer.from('dex\n035\0', 'binary') })
  }
  if (abi !== undefined) {
    entries.push({ name: `lib/${abi}/libdemo.so`, data: Buffer.from('ELF', 'binary') })
  }
  return zip(entries)
}

const MANIFEST_JSON = {
  xapk_version: 2,
  package_name: PACKAGE_NAME,
  name: 'Demo App',
  version_code: '25',
  version_name: '1.2.3',
  min_sdk_version: '26',
  target_sdk_version: '36',
  permissions: ['android.permission.INTERNET'],
  icon: 'icon.png',
  split_apks: [
    { file: `${PACKAGE_NAME}.apk`, id: 'base' },
    { file: 'config.arm64_v8a.apk', id: 'config.arm64_v8a' },
    { file: 'config.en.apk', id: 'config.en' },
  ],
}

const OBB_NAME = `Android/obb/${PACKAGE_NAME}/main.1.${PACKAGE_NAME}.obb`

/** 构造 XAPK；includeManifest=false 时用于验证「没有 manifest.json 时按内层 APK 推断」 */
function buildXapk({ includeManifest = true } = {}) {
  const entries = [
    { name: `${PACKAGE_NAME}.apk`, data: buildApk({ versionName: '1.2.3', dex: true }) },
    {
      name: 'config.arm64_v8a.apk',
      data: buildApk({ abi: 'arm64-v8a', dex: false }),
    },
    { name: 'config.en.apk', data: buildApk({ dex: false }) },
    { name: 'icon.png', data: Buffer.from('fake-png', 'binary') },
    { name: OBB_NAME, data: Buffer.from('fake-obb', 'binary') },
  ]
  if (includeManifest) {
    entries.push({ name: 'manifest.json', data: JSON.stringify(MANIFEST_JSON) })
  }
  return zip(entries)
}

// ------------------------------------------------------------------ CLI

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, XAPK_FILE: '', XAPK_VERBOSE: '', ...env },
  })
}

function assertIncludes(text, expected, label) {
  assert.ok(text.includes(expected), `${label} 缺少: ${expected}\n---\n${text}`)
}

function assertNotIncludes(text, unexpected, label) {
  assert.ok(!text.includes(unexpected), `${label} 不应出现: ${unexpected}\n---\n${text}`)
}

// ------------------------------------------------------------------ 用例

const dir = mkdtempSync(join(tmpdir(), 'publish-apk-xapk-'))
try {
  const xapkPath = join(dir, 'demo.xapk')
  writeFileSync(xapkPath, buildXapk())
  const apkPath = join(dir, `${PACKAGE_NAME}.apk`)
  writeFileSync(apkPath, buildApk({ versionName: '1.2.3', dex: true }))
  const noManifestPath = join(dir, 'no-manifest.xapk')
  writeFileSync(noManifestPath, buildXapk({ includeManifest: false }))
  const manifestOnlyPath = join(dir, 'manifest-only.xapk')
  writeFileSync(
    manifestOnlyPath,
    zip([{ name: 'manifest.json', data: JSON.stringify(MANIFEST_JSON) }]),
  )

  {
    const result = run(['xapk', '--file', xapkPath])
    assert.equal(result.status, 0, result.stderr)
    for (const expected of [
      '格式: XAPK / ZIP（6 个条目）',
      'XAPK 版本: 2',
      '应用名: Demo App',
      `包名: ${PACKAGE_NAME}`,
      '版本: 1.2.3 (25)',
      'Min SDK: 26',
      'Target SDK: 36',
      'ABI: arm64-v8a',
      'DEX: 1 个',
      '权限: android.permission.INTERNET',
      `启动 Activity: ${PACKAGE_NAME}.MainActivity`,
      '签名: 未签名（未检测到 APK 签名）',
      '拆分 APK: 3 个（base + 2 个 split）',
      `- base: ${PACKAGE_NAME}.apk`,
      '- config.arm64_v8a: config.arm64_v8a.apk',
      `OBB: ${OBB_NAME}`,
      '（加 --verbose 查看全部字段',
    ]) {
      assertIncludes(result.stdout, expected, '默认输出')
    }
    assertNotIncludes(result.stdout, 'manifest.json:', '默认输出')
  }

  {
    const result = run(['xapk', '--file', xapkPath, '--verbose'])
    assert.equal(result.status, 0, result.stderr)
    for (const expected of [
      'XAPK 外层条目:',
      'manifest.json:',
      '"xapk_version":2',
      '图标: icon.png',
      '拆分 APK 明细:',
      'base APK 签名块:',
      '无（可能是 JAR v1 或未签名）',
      'Manifest（base APK）:',
      '应用标签: Demo App',
      `- ${PACKAGE_NAME}.MainActivity（启动）`,
    ]) {
      assertIncludes(result.stdout, expected, '--verbose 输出')
    }
    assertNotIncludes(result.stdout, '（加 --verbose 查看全部字段', '--verbose 输出')
  }

  {
    const result = run(['xapk'], { XAPK_FILE: xapkPath })
    assert.equal(result.status, 0, result.stderr)
    assertIncludes(result.stdout, `包名: ${PACKAGE_NAME}`, 'XAPK_FILE')
  }

  {
    const result = run(['xapk'], { XAPK_FILE: xapkPath, XAPK_VERBOSE: '1' })
    assert.equal(result.status, 0, result.stderr)
    assertIncludes(result.stdout, '拆分 APK 明细:', 'XAPK_VERBOSE')
  }

  {
    const result = run(['xapk', '--help'])
    assert.equal(result.status, 0, result.stderr)
    assertIncludes(result.stdout, '查看 XAPK 安装包信息', '帮助')
    assertIncludes(result.stdout, 'XAPK_FILE', '帮助')
  }

  {
    const result = run(['xapk', '--file', noManifestPath])
    assert.equal(result.status, 0, result.stderr)
    assertIncludes(result.stdout, `包名: ${PACKAGE_NAME}`, '无 manifest.json')
    assertNotIncludes(result.stdout, 'XAPK 版本:', '无 manifest.json')
    assertIncludes(result.stdout, '拆分 APK: 3 个', '无 manifest.json')
    const verbose = run(['xapk', '--file', noManifestPath, '--verbose'])
    assertIncludes(verbose.stdout, '未找到 manifest.json', '无 manifest.json --verbose')
  }

  {
    const result = run(['xapk', '--file', apkPath])
    assert.equal(result.status, 1)
    assertIncludes(result.stderr, '不是 XAPK', '普通 APK')
    assertIncludes(result.stderr, 'apk 命令', '普通 APK')
    assertIncludes(result.stdout, '用法:', '普通 APK')
  }

  {
    const brokenPath = join(dir, 'broken-split.xapk')
    writeFileSync(
      brokenPath,
      zip([
        { name: `${PACKAGE_NAME}.apk`, data: buildApk({ versionName: '1.2.3', dex: true }) },
        { name: 'broken.apk', data: Buffer.from('not a zip') },
        {
          name: 'manifest.json',
          data: JSON.stringify({
            ...MANIFEST_JSON,
            split_apks: [
              { file: `${PACKAGE_NAME}.apk`, id: 'base' },
              { file: 'broken.apk', id: 'config.broken' },
            ],
          }),
        },
      ]),
    )
    const result = run(['xapk', '--file', brokenPath])
    assert.equal(result.status, 0, result.stderr)
    assertIncludes(result.stdout, `包名: ${PACKAGE_NAME}`, '损坏的 split')
    assertIncludes(result.stdout, '- config.broken: broken.apk', '损坏的 split')
    assertIncludes(result.stdout, '解析失败：', '损坏的 split')
  }

  {
    const missingPath = join(dir, 'missing-split.xapk')
    writeFileSync(
      missingPath,
      zip([
        { name: `${PACKAGE_NAME}.apk`, data: buildApk({ versionName: '1.2.3', dex: true }) },
        {
          name: 'manifest.json',
          data: JSON.stringify({
            ...MANIFEST_JSON,
            split_apks: [
              { file: `${PACKAGE_NAME}.apk`, id: 'base' },
              { file: 'config.en.apk', id: 'config.en' },
            ],
          }),
        },
      ]),
    )
    const result = run(['xapk', '--file', missingPath])
    assert.equal(result.status, 0, result.stderr)
    assertIncludes(
      result.stdout,
      '注意: manifest.json 声明的拆分 APK 不在包内: config.en.apk',
      '缺失的 split',
    )
  }

  {
    const result = run(['xapk', '--file', xapkPath], { XAPK_VERBOSE: 'maybe' })
    assert.equal(result.status, 1)
    assertIncludes(result.stderr, 'XAPK_VERBOSE', 'XAPK_VERBOSE 非法值')
  }

  {
    const result = run(['xapk', '--file', manifestOnlyPath])
    assert.equal(result.status, 1)
    assertIncludes(result.stderr, '里没有内层 APK', '只有 manifest.json')
  }

  {
    const result = run(['xapk', '--file', xapkPath, xapkPath])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.split(`文件: ${xapkPath}`).length - 1, 2)
  }

  console.log('xapk.test.js: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
