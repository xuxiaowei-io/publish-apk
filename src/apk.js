/**
 * APK 安装包查看命令（`publish-apk apk`）。
 *
 * APK 本质是 ZIP：AndroidManifest.xml 是 Android 二进制 XML，签名可能是
 * JAR v1（META-INF/*.RSA 等）或 APK Signature Scheme v2 / v3 / v3.1。
 *
 * 本命令只读文件，不安装、不验签：
 *   - 解析二进制 AndroidManifest.xml，输出包名、版本、SDK、权限、启动 Activity；
 *   - 解析 APK Signing Block 与 META-INF v1 签名，输出签名方案与证书；
 *   - --verbose 追加 ZIP 条目、签名块 pair、完整证书链与全部权限 / Activity。
 *
 * 不引入 npm 第三方依赖；ZIP 解析复用 src/hap.js 的 node:zlib 实现。
 * 退出代码与其它命令一致：0 成功，1 参数错误或文件读取 / 解析失败。
 */
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  EXIT_OK,
  PROGRAM,
  UsageError,
  isHelpToken,
  parseOptions,
  readEnv,
  stdout,
} from './cli.js'
import { certificateDetailLines } from './cert.js'
import {
  addSignatureCertificates,
  findZipEntry,
  formatBytes,
  readEndOfCentralDirectory,
  readZipEntries,
  readZipEntryData,
} from './hap.js'
import { renderHelp } from './help.js'
import { parseP7bDer } from './profile.js'

const COMMAND_NAME = 'apk'
const AAB_COMMAND_NAME = 'aab'
const OPTION_FILE = '--file'
const OPTION_VERBOSE = '--verbose'
const APK_OPTIONS = new Set([OPTION_FILE, OPTION_VERBOSE])
const APK_FLAGS = new Set([OPTION_VERBOSE])
const APK_MULTI_OPTIONS = new Set([OPTION_FILE])
const AAB_OPTIONS = new Set([OPTION_FILE, OPTION_VERBOSE])
const AAB_FLAGS = new Set([OPTION_VERBOSE])
const AAB_MULTI_OPTIONS = new Set([OPTION_FILE])

const ENV_FILE = 'APK_FILE'
const ENV_VERBOSE = 'APK_VERBOSE'
const ENV_AAB_FILE = 'AAB_FILE'
const ENV_AAB_VERBOSE = 'AAB_VERBOSE'

const VERBOSE_ON_VALUES = new Set(['1', 'true', 'yes', 'on'])
const VERBOSE_OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

/** Android 二进制 XML chunk 类型 */
const XML_TYPE = 0x0003
const STRING_POOL_TYPE = 0x0001
const START_ELEMENT_TYPE = 0x0102
const END_ELEMENT_TYPE = 0x0103

/** Android 二进制 XML typed value */
const TYPE_NULL = 0x00
const TYPE_REFERENCE = 0x01
const TYPE_STRING = 0x03
const TYPE_FLOAT = 0x04
const TYPE_INT_DEC = 0x10
const TYPE_INT_HEX = 0x11
const TYPE_INT_BOOLEAN = 0x12

/** APK Signing Block magic 与 scheme id */
const APK_SIG_BLOCK_MAGIC = Buffer.from('APK Sig Block 42')
const APK_SIG_SCHEMES = new Map([
  [0x7109871a, 'APK Signature Scheme v2'],
  [0xf05368c0, 'APK Signature Scheme v3'],
  [0x1b93ad61, 'APK Signature Scheme v3.1'],
])
const APK_SIG_BLOCK_NAMES = new Map([
  ...APK_SIG_SCHEMES,
  [0x504b4453, 'Source Stamp'],
  [0x42726577, 'Verity Padding'],
])

// -------------------------------------------------------------- 开关型参数

function resolveVerbose(options, env, help, envName = ENV_VERBOSE) {
  if (options.get(OPTION_VERBOSE) === true) {
    return true
  }
  const value = readEnv(env, envName)
  if (value === undefined) {
    return false
  }
  const normalized = value.trim().toLowerCase()
  if (VERBOSE_ON_VALUES.has(normalized)) {
    return true
  }
  if (VERBOSE_OFF_VALUES.has(normalized)) {
    return false
  }
  throw new UsageError(
    `环境变量 ${envName} 的值无效: "${value}"（开启用 1/true/yes/on，关闭用 0/false/no/off）`,
    help(),
  )
}

// ------------------------------------------------------------------ 帮助文档

function renderApkHelp() {
  return renderHelp({
    title: `${PROGRAM} ${COMMAND_NAME} - 查看 APK 安装包信息`,
    usage: [`${PROGRAM} ${COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [`${OPTION_FILE} <路径...>`, `一个或多个 APK 文件路径（支持 shell glob），必填（可用 ${ENV_FILE} 补齐）`],
          [
            OPTION_VERBOSE,
            `输出全部字段（ZIP 条目、签名块 pair、完整证书链、全部权限 / Activity）；命令行未给出时读取 ${ENV_VERBOSE}`,
          ],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_FILE, `APK 文件路径，等价于 ${OPTION_FILE}`],
          [ENV_VERBOSE, '输出全部字段，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', 'APK 包信息与签名证书，每行一条「标签: 值」；--verbose 时追加 ZIP 条目、完整证书链与明细'],
          ['stderr', '错误信息'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功'],
          ['1', '参数缺失、参数错误或文件读取 / 解析失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} ${COMMAND_NAME} --file ./app-arm64-v8a-release.apk`,
      `  ${PROGRAM} ${COMMAND_NAME} --file ./app-armeabi-v7a-release.apk --verbose`,
      `  ${ENV_FILE}=./app.apk ${PROGRAM} ${COMMAND_NAME}`,
      `  ${ENV_VERBOSE}=1 ${PROGRAM} ${COMMAND_NAME} --file ./app.apk`,
      '',
      '说明: --file 可以一次给多个文件（shell glob 也可），按顺序输出，文件之间空一行',
      '说明: AndroidManifest.xml 是二进制 XML；本命令直接解析，不依赖 aapt / apkanalyzer',
      '说明: 签名只检测 JAR v1 与 APK Signature Scheme v2 / v3 / v3.1，未执行证书链与摘要验签',
      '说明: 默认每组证书只输出叶子证书；--verbose 输出完整证书链',
      '说明: 不输出证书 PEM 原文；APK 里没有私钥',
    ],
  })
}

function renderAabHelp() {
  return renderHelp({
    title: `${PROGRAM} ${AAB_COMMAND_NAME} - 查看 AAB 安装包信息`,
    usage: [`${PROGRAM} ${AAB_COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [`${OPTION_FILE} <路径...>`, `一个或多个 AAB 文件路径（支持 shell glob），必填（可用 ${ENV_AAB_FILE} 补齐）`],
          [
            OPTION_VERBOSE,
            `输出全部字段（ZIP 条目、完整证书链、全部权限 / Activity）；命令行未给出时读取 ${ENV_AAB_VERBOSE}`,
          ],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_AAB_FILE, `AAB 文件路径，等价于 ${OPTION_FILE}`],
          [ENV_AAB_VERBOSE, '输出全部字段，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', 'AAB 包信息、模块与签名证书，每行一条「标签: 值」；--verbose 时追加 ZIP 条目、完整证书链与明细'],
          ['stderr', '错误信息'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功'],
          ['1', '参数缺失、参数错误或文件读取 / 解析失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} ${AAB_COMMAND_NAME} --file ./app-release.aab`,
      `  ${PROGRAM} ${AAB_COMMAND_NAME} --file ./*.aab --verbose`,
      `  ${ENV_AAB_FILE}=./app.aab ${PROGRAM} ${AAB_COMMAND_NAME}`,
      `  ${ENV_AAB_VERBOSE}=1 ${PROGRAM} ${AAB_COMMAND_NAME} --file ./app.aab`,
      '',
      '说明: --file 可以一次给多个文件（shell glob 也可），按顺序输出，文件之间空一行',
      '说明: AAB 是 ZIP，Manifest 在 base/manifest/AndroidManifest.xml；本命令直接解析二进制 XML',
      '说明: AAB 使用 JAR v1 签名（META-INF/*.RSA 等），本命令提取证书但不执行验签',
      '说明: 默认每组证书只输出叶子证书；--verbose 输出完整证书链',
      '说明: 不输出证书 PEM 原文；AAB 里没有私钥',
    ],
  })
}

// ------------------------------------------------------------------ 二进制 XML

function readStringPool(buffer, chunkOffset, help) {
  const headerSize = buffer.readUInt16LE(chunkOffset + 2)
  const count = buffer.readUInt32LE(chunkOffset + 8)
  const flags = buffer.readUInt32LE(chunkOffset + 16)
  const stringsStart = buffer.readUInt32LE(chunkOffset + 20)
  const utf8 = (flags & 0x100) !== 0
  const offsetsStart = chunkOffset + headerSize
  const dataStart = chunkOffset + stringsStart
  const strings = []
  for (let index = 0; index < count; index += 1) {
    const relative = buffer.readUInt32LE(offsetsStart + index * 4)
    let offset = dataStart + relative
    let length
    if (utf8) {
      let first = buffer[offset]
      offset += 1
      if ((first & 0x80) !== 0) {
        length = ((first & 0x7f) << 8) | buffer[offset]
        offset += 1
      } else {
        length = first
      }
      strings.push(buffer.toString('utf8', offset, offset + length))
    } else {
      let first = buffer.readUInt16LE(offset)
      offset += 2
      if ((first & 0x8000) !== 0) {
        length = ((first & 0x7fff) << 16) | buffer.readUInt16LE(offset)
        offset += 2
      } else {
        length = first
      }
      strings.push(buffer.toString('utf16le', offset, offset + length * 2))
    }
  }
  return strings
}

function attributeValue(buffer, offset, offsetEnd, strings) {
  const rawValue = buffer.readUInt32LE(offset + 8)
  if (rawValue !== 0xffffffff && strings[rawValue] !== undefined) {
    return strings[rawValue]
  }
  const dataType = buffer[offset + 15]
  const data = buffer.readUInt32LE(offset + 16)
  if (offsetEnd > buffer.length) {
    return undefined
  }
  switch (dataType) {
    case TYPE_NULL:
      return null
    case TYPE_STRING:
      return strings[data]
    case TYPE_REFERENCE:
      return `@0x${data.toString(16)}`
    case TYPE_INT_DEC:
      return data
    case TYPE_INT_HEX:
      return `0x${data.toString(16)}`
    case TYPE_INT_BOOLEAN:
      return data !== 0
    case TYPE_FLOAT:
      return buffer.readFloatLE(offset + 16)
    default:
      return `0x${data.toString(16)}`
  }
}

/** 解析 Android 二进制 XML，返回元素树 */
function parseBinaryXml(buffer, help) {
  if (buffer.length < 8 || buffer.readUInt16LE(0) !== XML_TYPE) {
    throw new UsageError('AndroidManifest.xml 不是 Android 二进制 XML', help())
  }
  const headerSize = buffer.readUInt16LE(2)
  const totalSize = buffer.readUInt32LE(4)
  const end = Math.min(buffer.length, totalSize)
  let offset = headerSize
  let strings = []

  const root = { name: '#document', attrs: {}, children: [] }
  const stack = [root]
  while (offset + 8 <= end) {
    const type = buffer.readUInt16LE(offset)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    if (chunkSize === 0 || offset + chunkSize > end) {
      break
    }
    if (type === STRING_POOL_TYPE) {
      strings = readStringPool(buffer, offset, help)
    } else if (type === START_ELEMENT_TYPE) {
      const elementHeaderSize = buffer.readUInt16LE(offset + 2)
      const ext = offset + elementHeaderSize
      if (ext + 20 > offset + chunkSize) {
        throw new UsageError('AndroidManifest.xml 的 start element 越界', help())
      }
      const name = strings[buffer.readUInt32LE(ext + 4)]
      const attributeStart = buffer.readUInt16LE(ext + 8)
      const attributeSize = buffer.readUInt16LE(ext + 10)
      const attributeCount = buffer.readUInt16LE(ext + 12)
      const attrs = {}
      for (let index = 0; index < attributeCount; index += 1) {
        const attrOffset = ext + attributeStart + index * attributeSize
        if (attrOffset + attributeSize > offset + chunkSize) {
          throw new UsageError('AndroidManifest.xml 的 attribute 越界', help())
        }
        const attrName = strings[buffer.readUInt32LE(attrOffset + 4)]
        if (attrName !== undefined) {
          attrs[attrName] = attributeValue(
            buffer,
            attrOffset,
            offset + chunkSize,
            strings,
          )
        }
      }
      const element = { name, attrs, children: [] }
      stack[stack.length - 1].children.push(element)
      stack.push(element)
    } else if (type === END_ELEMENT_TYPE) {
      if (stack.length > 1) {
        stack.pop()
      }
    }
    offset += chunkSize
  }
  return root
}

/** 读取 protobuf varint */
function readProtoVarint(buffer, offset, end) {
  let value = 0
  let shift = 0
  while (offset < end) {
    const byte = buffer[offset]
    offset += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) {
      return { value, offset }
    }
    shift += 7
    if (shift > 63) {
      throw new Error('protobuf varint 过长')
    }
  }
  throw new Error('protobuf varint 越界')
}

/** 解析 protobuf 消息的字段列表 */
function parseProtoFields(buffer) {
  const fields = []
  let offset = 0
  while (offset < buffer.length) {
    const key = readProtoVarint(buffer, offset, buffer.length)
    offset = key.offset
    const field = Math.floor(key.value / 8)
    const wire = key.value & 0x7
    if (wire === 0) {
      const item = readProtoVarint(buffer, offset, buffer.length)
      fields.push({ field, wire, value: item.value })
      offset = item.offset
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw new Error('protobuf fixed64 越界')
      fields.push({ field, wire, value: buffer.subarray(offset, offset + 8) })
      offset += 8
    } else if (wire === 2) {
      const item = readProtoVarint(buffer, offset, buffer.length)
      offset = item.offset
      if (offset + item.value > buffer.length) throw new Error('protobuf length 越界')
      fields.push({ field, wire, value: buffer.subarray(offset, offset + item.value) })
      offset += item.value
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw new Error('protobuf fixed32 越界')
      fields.push({ field, wire, value: buffer.subarray(offset, offset + 4) })
      offset += 4
    } else {
      throw new Error(`不支持的 protobuf wire type ${wire}`)
    }
  }
  return fields
}

function protoString(fields, field) {
  const item = fields.find((entry) => entry.field === field && entry.wire === 2)
  return item === undefined ? undefined : item.value.toString('utf8')
}

/** 解析 AAB 里的 protobuf XML XmlAttribute */
function decodeProtoAttribute(buffer) {
  const fields = parseProtoFields(buffer)
  const name = protoString(fields, 2)
  const value = protoString(fields, 3)
  const resource = fields.find((entry) => entry.field === 5 && entry.wire === 0)?.value
  if (name === undefined) {
    return undefined
  }
  return [name, value ?? (resource === undefined ? undefined : `@0x${resource.toString(16)}`)]
}

/** 解析 AAB 里的 protobuf XML XmlElement */
function decodeProtoElement(buffer) {
  const fields = parseProtoFields(buffer)
  const name = protoString(fields, 3) ?? protoString(fields, 2)
  if (name === undefined) {
    return undefined
  }
  const attrs = {}
  for (const field of fields) {
    if (field.field === 4 && field.wire === 2) {
      const attribute = decodeProtoAttribute(field.value)
      if (attribute !== undefined) {
        attrs[attribute[0]] = attribute[1]
      }
    }
  }
  const children = []
  for (const field of fields) {
    if (field.field === 5 && field.wire === 2) {
      const child = decodeProtoNode(field.value)
      if (child !== undefined) {
        children.push(child)
      }
    }
  }
  return { name, attrs, children }
}

/** 解析 AAB 里的 protobuf XML XmlNode */
function decodeProtoNode(buffer) {
  const fields = parseProtoFields(buffer)
  const element = fields.find((entry) => entry.field === 1 && entry.wire === 2)
  return element === undefined ? undefined : decodeProtoElement(element.value)
}

/** 把 AAB 的 protobuf XML 转成和二进制 XML 相同的元素树 */
function parseProtoXml(buffer, help) {
  try {
    const manifest = decodeProtoNode(buffer)
    if (manifest === undefined) {
      throw new Error('没有 manifest 元素')
    }
    return { name: '#document', attrs: {}, children: [manifest] }
  } catch (error) {
    throw new UsageError(`AndroidManifest.xml 不是合法的 protobuf XML: ${error.message}`, help())
  }
}

// ------------------------------------------------------------------ Manifest

function child(element, name) {
  return element?.children.find((item) => item.name === name)
}

function children(element, name) {
  return element?.children.filter((item) => item.name === name) ?? []
}

function normalizeClassName(name, packageName) {
  if (typeof name !== 'string' || name === '') {
    return undefined
  }
  if (name.startsWith('.')) {
    return `${packageName}${name}`
  }
  if (!name.includes('.')) {
    return `${packageName}.${name}`
  }
  return name
}

function hasLauncher(intentFilter) {
  const actions = children(intentFilter, 'action').map((item) => item.attrs.name)
  const categories = children(intentFilter, 'category').map((item) => item.attrs.name)
  return (
    actions.includes('android.intent.action.MAIN') &&
    categories.includes('android.intent.category.LAUNCHER')
  )
}

function booleanValue(value) {
  if (value === true || value === 'true') {
    return true
  }
  if (value === false || value === 'false') {
    return false
  }
  return value
}

function manifestFromDocument(document, help) {
  const manifest = child(document, 'manifest')
  if (manifest === undefined) {
    throw new UsageError('AndroidManifest.xml 缺少 manifest 根元素', help())
  }
  const packageName = manifest.attrs.package
  const usesSdk = child(manifest, 'uses-sdk')
  const application = child(manifest, 'application')
  const permissionElements = [
    ...children(manifest, 'uses-permission'),
    ...children(manifest, 'uses-permission-sdk-23'),
  ]
  const permissions = permissionElements
    .map((item) => item.attrs.name)
    .filter((name) => typeof name === 'string')
  const activities = [
    ...children(application, 'activity'),
    ...children(application, 'activity-alias'),
  ].map((item) => {
    const rawName = item.attrs.name
    const name = normalizeClassName(rawName, packageName)
    return {
      name,
      rawName,
      launcher: children(item, 'intent-filter').some(hasLauncher),
    }
  })
  const launcher = activities.find((item) => item.launcher)
  return {
    packageName,
    versionCode: manifest.attrs.versionCode,
    versionName: manifest.attrs.versionName,
    compileSdkVersion: manifest.attrs.compileSdkVersion,
    minSdkVersion: usesSdk?.attrs.minSdkVersion,
    targetSdkVersion: usesSdk?.attrs.targetSdkVersion,
    label: application?.attrs.label,
    debuggable: booleanValue(application?.attrs.debuggable),
    allowBackup: booleanValue(application?.attrs.allowBackup),
    permissions,
    activities,
    launcher,
    usesFeatures: children(manifest, 'uses-feature')
      .map((item) => item.attrs.name)
      .filter((name) => typeof name === 'string'),
  }
}

function extractManifest(buffer, help) {
  return manifestFromDocument(parseBinaryXml(buffer, help), help)
}

// ------------------------------------------------------------------ 签名

function readU32(buffer, offset, end) {
  if (offset < 0 || offset + 4 > end) {
    throw new Error('签名数据长度越界')
  }
  return buffer.readUInt32LE(offset)
}

/** 解析 v2 / v3 / v3.1 signer 里的证书；返回 DER 证书列表 */
function readSchemeCertificates(value) {
  const certificates = []
  const signersLength = readU32(value, 0, value.length)
  let offset = 4
  const signersEnd = offset + signersLength
  if (signersEnd > value.length) {
    throw new Error('signers 长度越界')
  }
  while (offset < signersEnd) {
    const signerLength = readU32(value, offset, signersEnd)
    offset += 4
    const signerEnd = offset + signerLength
    if (signerEnd > signersEnd) {
      throw new Error('signer 长度越界')
    }
    const signedDataLength = readU32(value, offset, signerEnd)
    offset += 4
    const signedDataEnd = offset + signedDataLength
    if (signedDataEnd > signerEnd) {
      throw new Error('signed data 长度越界')
    }
    const digestsLength = readU32(value, offset, signedDataEnd)
    offset += 4 + digestsLength
    const certificatesLength = readU32(value, offset, signedDataEnd)
    offset += 4
    const certificatesEnd = offset + certificatesLength
    if (certificatesEnd > signedDataEnd) {
      throw new Error('certificates 长度越界')
    }
    while (offset < certificatesEnd) {
      const certificateLength = readU32(value, offset, certificatesEnd)
      offset += 4
      if (offset + certificateLength > certificatesEnd) {
        throw new Error('certificate 长度越界')
      }
      certificates.push(value.subarray(offset, offset + certificateLength))
      offset += certificateLength
    }
    offset = signerEnd
  }
  return certificates
}

/** 读取 APK Signing Block（v2 / v3 / v3.1），返回 pair 与证书 */
function readApkSigningBlock(buffer, centralOffset, help) {
  if (centralOffset < 32) {
    return { pairs: [], schemes: [] }
  }
  const magic = buffer.subarray(centralOffset - 16, centralOffset)
  if (!magic.equals(APK_SIG_BLOCK_MAGIC)) {
    return { pairs: [], schemes: [] }
  }
  const sizeBig = buffer.readBigUInt64LE(centralOffset - 24)
  if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UsageError('APK Signing Block 太大', help())
  }
  const size = Number(sizeBig)
  const start = centralOffset - size - 8
  if (size < 24 || start < 0 || start + 8 > centralOffset) {
    throw new UsageError('APK Signing Block 大小异常', help())
  }
  if (Number(buffer.readBigUInt64LE(start)) !== size) {
    throw new UsageError('APK Signing Block 首尾大小不一致', help())
  }
  const pairs = []
  const schemes = []
  let offset = start + 8
  const pairsEnd = centralOffset - 24
  while (offset + 12 <= pairsEnd) {
    const pairLength = Number(buffer.readBigUInt64LE(offset))
    const id = buffer.readUInt32LE(offset + 8)
    const valueStart = offset + 12
    const pairEnd = offset + 8 + pairLength
    if (pairLength < 4 || pairEnd > pairsEnd) {
      break
    }
    pairs.push({ id, length: pairLength })
    const scheme = APK_SIG_SCHEMES.get(id)
    if (scheme !== undefined) {
      try {
        const derCertificates = readSchemeCertificates(
          buffer.subarray(valueStart, pairEnd),
        )
        const certificates = derCertificates.map(
          (der) => new X509Certificate(der),
        )
        schemes.push({ scheme, certificates })
      } catch (error) {
        schemes.push({ scheme, certificates: [], error: error.message })
      }
    }
    offset = pairEnd
  }
  return { pairs, schemes }
}

/** 读取 META-INF v1 JAR 签名证书 */
function readV1Certificates(buffer, entries, help) {
  const signatureEntries = entries.filter((entry) =>
    /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(entry.name),
  )
  return signatureEntries.map((entry) => {
    try {
      const p7b = parseP7bDer(readZipEntryData(buffer, entry, help))
      return { label: `JAR v1 签名（${entry.name}）`, certificates: p7b.certificates }
    } catch (error) {
      return {
        label: `JAR v1 签名（${entry.name}）`,
        certificates: [],
        error: error.message,
      }
    }
  })
}

function signatureLabel(v1Groups, schemes, kind = 'APK') {
  const parts = []
  if (v1Groups.length > 0) {
    parts.push('JAR v1')
  }
  for (const item of schemes) {
    parts.push(item.scheme)
  }
  if (parts.length === 0) {
    return kind === 'AAB' ? '未签名（未检测到 AAB 签名）' : '未签名（未检测到 APK 签名）'
  }
  return `已签名（${parts.join(' + ')}；未验签）`
}

// ------------------------------------------------------------------ 输出

function apkLines(buffer, path, entries, manifest, signing, verbose) {
  const v1Groups = readV1Certificates(buffer, entries, renderApkHelp)
  const certificateGroups = [
    ...v1Groups,
    ...signing.schemes.map((item) => ({
      label: item.scheme,
      certificates: item.certificates,
      error: item.error,
    })),
  ]
  const abis = [
    ...new Set(
      entries
        .map((entry) => /^lib\/([^/]+)\//.exec(entry.name)?.[1])
        .filter((value) => typeof value === 'string'),
    ),
  ]
  const dexCount = entries.filter((entry) => /(^|\/)classes\d*\.dex$/i.test(entry.name)).length
  const lines = [
    `文件: ${path}`,
    `大小: ${formatBytes(buffer.length)}（${buffer.length} 字节）`,
    `格式: APK / ZIP（${entries.length} 个条目）`,
    `签名: ${signatureLabel(v1Groups, signing.schemes)}`,
  ]
  if (manifest.packageName !== undefined) {
    lines.push(`包名: ${manifest.packageName}`)
  }
  if (manifest.versionName !== undefined || manifest.versionCode !== undefined) {
    const version = [
      manifest.versionName,
      manifest.versionCode === undefined ? '' : `(${manifest.versionCode})`,
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(`版本: ${version}`)
  }
  if (manifest.minSdkVersion !== undefined) {
    lines.push(`Min SDK: ${manifest.minSdkVersion}`)
  }
  if (manifest.targetSdkVersion !== undefined) {
    lines.push(`Target SDK: ${manifest.targetSdkVersion}`)
  }
  if (manifest.compileSdkVersion !== undefined) {
    lines.push(`编译 SDK: ${manifest.compileSdkVersion}`)
  }
  if (abis.length > 0) {
    lines.push(`ABI: ${abis.join('、')}`)
  }
  lines.push(`DEX: ${dexCount} 个`)
  if (manifest.permissions.length > 0) {
    lines.push(`权限: ${manifest.permissions.join('、')}`)
  }
  if (manifest.launcher?.name !== undefined) {
    lines.push(`启动 Activity: ${manifest.launcher.name}`)
  }
  if (manifest.debuggable !== undefined) {
    lines.push(`调试: ${manifest.debuggable === true ? '是' : '否'}`)
  }
  addSignatureCertificates(lines, certificateGroups, verbose)
  if (signing.schemes.length > 0 && certificateGroups.length === 0) {
    lines.push('', '签名证书: 未解析到证书（仅检测到签名块）')
  }
  return { lines, v1Groups, certificateGroups }
}

function verboseLines(lines, entries, manifest, signing) {
  lines.push('', 'APK 签名块:')
  if (signing.pairs.length === 0) {
    lines.push('无（可能是 JAR v1 或未签名）')
  } else {
    for (const pair of signing.pairs) {
      const name = APK_SIG_BLOCK_NAMES.get(pair.id) ?? '未知类型'
      lines.push(`- 0x${pair.id.toString(16)} ${name}，${pair.length} 字节`)
    }
  }

  lines.push('', 'ZIP 条目:')
  for (const entry of entries) {
    const method =
      entry.method === 0 ? 'store' : entry.method === 8 ? 'deflate' : `method ${entry.method}`
    lines.push(`- ${entry.name}（${entry.size} 字节，${method}）`)
  }

  lines.push('', 'Manifest:')
  if (manifest.label !== undefined) {
    lines.push(`应用标签: ${manifest.label}`)
  }
  if (manifest.allowBackup !== undefined) {
    lines.push(`允许备份: ${manifest.allowBackup === true ? '是' : '否'}`)
  }
  if (manifest.usesFeatures.length > 0) {
    lines.push(`特性: ${manifest.usesFeatures.join('、')}`)
  }
  if (manifest.activities.length > 0) {
    lines.push('Activity:')
    for (const activity of manifest.activities) {
      lines.push(`- ${activity.name}${activity.launcher ? '（启动）' : ''}`)
    }
  }

}

// ------------------------------------------------------------------ 命令入口

function readApkFile(path, help) {
  try {
    return readFileSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new UsageError(`文件不存在: ${path}`, help())
    }
    throw new UsageError(`读取文件失败: ${path}: ${error.message}`, help())
  }
}

function parseApk(buffer, path, help) {
  const eocd = readEndOfCentralDirectory(buffer, help)
  const entries = readZipEntries(buffer, eocd, help)
  const manifestEntry = findZipEntry(entries, 'AndroidManifest.xml')
  if (manifestEntry === null) {
    throw new UsageError(`不是 APK：${path} 里没有 AndroidManifest.xml`, help())
  }
  const manifest = extractManifest(readZipEntryData(buffer, manifestEntry, help), help)
  const signing = readApkSigningBlock(buffer, eocd.centralOffset, help)
  return { entries, manifest, signing }
}

function runApk(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderApkHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    APK_OPTIONS,
    renderApkHelp,
    APK_FLAGS,
    APK_MULTI_OPTIONS,
  )
  const verbose = resolveVerbose(options, env, renderApkHelp)
  const envPath = readEnv(env, ENV_FILE)
  const optionPaths = options.get(OPTION_FILE)
  const paths =
    optionPaths === undefined
      ? envPath === undefined
        ? undefined
        : [envPath]
      : Array.isArray(optionPaths)
        ? optionPaths
        : [optionPaths]
  if (paths === undefined) {
    throw new UsageError(
      `缺少必填参数: ${OPTION_FILE}（APK 文件路径，可多个），可用环境变量 ${ENV_FILE}`,
      renderApkHelp(),
    )
  }

  for (const [index, path] of paths.entries()) {
    const buffer = readApkFile(path, renderApkHelp)
    const parsed = parseApk(buffer, path, renderApkHelp)
    const { lines } = apkLines(
      buffer,
      path,
      parsed.entries,
      parsed.manifest,
      parsed.signing,
      verbose,
    )
    if (verbose) {
      verboseLines(lines, parsed.entries, parsed.manifest, parsed.signing)
    }
    stdout(lines.join('\n'))
    if (index < paths.length - 1) {
      stdout('')
    }
  }
  return EXIT_OK
}

function aabLines(buffer, path, entries, manifest, v1Groups, verbose) {
  const modules = [
    ...new Set(
      entries
        .map((entry) => /^([^/]+)\/manifest\/AndroidManifest\.xml$/.exec(entry.name)?.[1])
        .filter((value) => typeof value === 'string'),
    ),
  ]
  const abis = [
    ...new Set(
      entries
        .map((entry) => /(?:^|\/)lib\/([^/]+)\//.exec(entry.name)?.[1])
        .filter((value) => typeof value === 'string'),
    ),
  ]
  const dexCount = entries.filter((entry) => /(^|\/)dex\/classes\d*\.dex$/i.test(entry.name)).length
  const lines = [
    `文件: ${path}`,
    `大小: ${formatBytes(buffer.length)}（${buffer.length} 字节）`,
    `格式: AAB / ZIP（${entries.length} 个条目）`,
    `签名: ${signatureLabel(v1Groups, [], 'AAB')}`,
  ]
  if (manifest.packageName !== undefined) {
    lines.push(`包名: ${manifest.packageName}`)
  }
  if (manifest.versionName !== undefined || manifest.versionCode !== undefined) {
    const version = [
      manifest.versionName,
      manifest.versionCode === undefined ? '' : `(${manifest.versionCode})`,
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(`版本: ${version}`)
  }
  if (manifest.minSdkVersion !== undefined) {
    lines.push(`Min SDK: ${manifest.minSdkVersion}`)
  }
  if (manifest.targetSdkVersion !== undefined) {
    lines.push(`Target SDK: ${manifest.targetSdkVersion}`)
  }
  if (manifest.compileSdkVersion !== undefined) {
    lines.push(`编译 SDK: ${manifest.compileSdkVersion}`)
  }
  if (modules.length > 0) {
    lines.push(`模块: ${modules.join('、')}`)
  }
  if (abis.length > 0) {
    lines.push(`ABI: ${abis.join('、')}`)
  }
  lines.push(`DEX: ${dexCount} 个`)
  if (manifest.permissions.length > 0) {
    lines.push(`权限: ${manifest.permissions.join('、')}`)
  }
  if (manifest.launcher?.name !== undefined) {
    lines.push(`启动 Activity: ${manifest.launcher.name}`)
  }
  if (manifest.debuggable !== undefined) {
    lines.push(`调试: ${manifest.debuggable === true ? '是' : '否'}`)
  }
  addSignatureCertificates(lines, v1Groups, verbose)
  return lines
}

function verboseAabLines(lines, entries, manifest) {
  lines.push('', 'ZIP 条目:')
  for (const entry of entries) {
    const method =
      entry.method === 0 ? 'store' : entry.method === 8 ? 'deflate' : `method ${entry.method}`
    lines.push(`- ${entry.name}（${entry.size} 字节，${method}）`)
  }

  const bundleConfig = findZipEntry(entries, 'BundleConfig.pb')
  if (bundleConfig !== null) {
    lines.push('', `BundleConfig.pb: ${bundleConfig.size} 字节`)
  }

  lines.push('', 'Manifest:')
  if (manifest.label !== undefined) {
    lines.push(`应用标签: ${manifest.label}`)
  }
  if (manifest.allowBackup !== undefined) {
    lines.push(`允许备份: ${manifest.allowBackup === true ? '是' : '否'}`)
  }
  if (manifest.usesFeatures.length > 0) {
    lines.push(`特性: ${manifest.usesFeatures.join('、')}`)
  }
  if (manifest.activities.length > 0) {
    lines.push('Activity:')
    for (const activity of manifest.activities) {
      lines.push(`- ${activity.name}${activity.launcher ? '（启动）' : ''}`)
    }
  }
}

function parseAab(buffer, path, help) {
  const eocd = readEndOfCentralDirectory(buffer, help)
  const entries = readZipEntries(buffer, eocd, help)
  const manifestEntry =
    findZipEntry(entries, 'base/manifest/AndroidManifest.xml') ??
    entries.find((entry) => /\/manifest\/AndroidManifest\.xml$/.test(entry.name))
  if (manifestEntry === undefined || manifestEntry === null) {
    throw new UsageError(`不是 AAB：${path} 里没有 */manifest/AndroidManifest.xml`, help())
  }
  const manifest = manifestFromDocument(
    parseProtoXml(readZipEntryData(buffer, manifestEntry, help), help),
    help,
  )
  const v1Groups = readV1Certificates(buffer, entries, help)
  return { entries, manifest, v1Groups }
}

function runAab(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderAabHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    AAB_OPTIONS,
    renderAabHelp,
    AAB_FLAGS,
    AAB_MULTI_OPTIONS,
  )
  const verbose = resolveVerbose(options, env, renderAabHelp, ENV_AAB_VERBOSE)
  const envPath = readEnv(env, ENV_AAB_FILE)
  const optionPaths = options.get(OPTION_FILE)
  const paths =
    optionPaths === undefined
      ? envPath === undefined
        ? undefined
        : [envPath]
      : Array.isArray(optionPaths)
        ? optionPaths
        : [optionPaths]
  if (paths === undefined) {
    throw new UsageError(
      `缺少必填参数: ${OPTION_FILE}（AAB 文件路径，可多个），可用环境变量 ${ENV_AAB_FILE}`,
      renderAabHelp(),
    )
  }

  for (const [index, path] of paths.entries()) {
    const buffer = readApkFile(path, renderAabHelp)
    const parsed = parseAab(buffer, path, renderAabHelp)
    const lines = aabLines(
      buffer,
      path,
      parsed.entries,
      parsed.manifest,
      parsed.v1Groups,
      verbose,
    )
    if (verbose) {
      verboseAabLines(lines, parsed.entries, parsed.manifest)
    }
    stdout(lines.join('\n'))
    if (index < paths.length - 1) {
      stdout('')
    }
  }
  return EXIT_OK
}

export const aabCommand = {
  name: AAB_COMMAND_NAME,
  summary: '查看 AAB 安装包信息（包名 / SDK / 模块 / 签名证书）',
  run: runAab,
}

export const apkCommand = {
  name: COMMAND_NAME,
  summary: '查看 APK 安装包信息（包名 / SDK / ABI / 签名证书）',
  run: runApk,
}
