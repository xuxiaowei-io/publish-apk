/**
 * HAP 安装包查看命令（`publish-apk hap`）。
 *
 * 定位：与具体应用市场无关的本地工具——
 *   - HAP 本质是 ZIP，读取 pack.info / module.json 输出包名、版本、模块、设备、API 等；
 *   - 检测 HAP 签名块（签名块 / Code Sign Block），区分 signed 与 unsigned；
 *   - --verbose 追加 ZIP 条目、签名子块与完整 pack.info / module.json。
 *
 * 本命令只读文件，不安装、不验签。签名块存在只说明「带签名结构」，
 * 证书链、摘要、Merkle 树的验签需要额外工具，输出里会明确标注「未验签」。
 * 不引入 npm 第三方依赖：ZIP 解析用 node:zlib，签名状态只解析块头。
 *
 * 退出代码与其它命令一致：0 成功，1 参数错误或文件读取 / 解析失败。
 */
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

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
import { renderHelp } from './help.js'
import { parseP7bDer } from './profile.js'

/** 命令名 */
const COMMAND_NAME = 'hap'
/** HAP 文件路径；必填 */
const OPTION_FILE = '--file'
/** 开关：输出全部字段 */
const OPTION_VERBOSE = '--verbose'
/** hap 支持的全部选项 */
const HAP_OPTIONS = new Set([OPTION_FILE, OPTION_VERBOSE])
/** hap 中的开关型选项 */
const HAP_FLAGS = new Set([OPTION_VERBOSE])
const HAP_MULTI_OPTIONS = new Set([OPTION_FILE])

/** HAP 文件路径，等价于 --file（必填） */
const ENV_FILE = 'HAP_FILE'
/** 开关：输出全部字段，等价于 --verbose */
const ENV_VERBOSE = 'HAP_VERBOSE'

/** app 命令的文件与开关环境变量 */
const ENV_APP_FILE = 'APP_FILE'
const ENV_APP_VERBOSE = 'APP_VERBOSE'

const VERBOSE_ON_VALUES = new Set(['1', 'true', 'yes', 'on'])
const VERBOSE_OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

/** ZIP 结构签名 */
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/** HAP 签名块尾部的两个 magic（v2 / v3） */
const HAP_SIGNATURE_MAGIC_V2 = Buffer.from('HAP Sig Block 42')
const HAP_SIGNATURE_MAGIC_V3 = Buffer.from('<hap sign block>')
/** HAP Code Sign Block 头部的 magic（小端 u64 的字节序） */
const CODE_SIGN_MAGIC = Buffer.from('cdfc8953c6c846e0', 'hex')

/** HAP 签名块类型 */
const SIGN_BLOCK_TYPES = new Map([
  [0x20000000, 'HAP 签名方案 v1'],
  [0x20000001, '未签名 Profile'],
  [0x20000002, '已签名 Profile'],
  [0x20000003, 'Code Sign Block'],
  [0x20000004, '密钥轮换'],
])

// -------------------------------------------------------------- 开关型参数

/** 解析 --verbose / HAP_VERBOSE */
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

function renderHapHelp() {
  return renderHelp({
    title: `${PROGRAM} ${COMMAND_NAME} - 查看 HAP 安装包信息`,
    usage: [`${PROGRAM} ${COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [`${OPTION_FILE} <路径...>`, `一个或多个 HAP 文件路径（支持 shell glob），必填（可用 ${ENV_FILE} 补齐）`],
          [
            OPTION_VERBOSE,
            `输出全部字段（ZIP 条目、签名子块、全部签名证书链、完整 pack.info / module.json）；命令行未给出时读取 ${ENV_VERBOSE}`,
          ],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_FILE, `HAP 文件路径，等价于 ${OPTION_FILE}`],
          [ENV_VERBOSE, '输出全部字段，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', 'HAP 包信息与签名证书，每行一条「标签: 值」；--verbose 时追加 ZIP 条目、完整证书链与原始 JSON'],
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
      `  ${PROGRAM} ${COMMAND_NAME} --file ./app-signed.hap`,
      `  ${PROGRAM} ${COMMAND_NAME} --file ./app-unsigned.hap --verbose`,
      `  ${ENV_FILE}=./app.hap ${PROGRAM} ${COMMAND_NAME}`,
      `  ${ENV_VERBOSE}=1 ${PROGRAM} ${COMMAND_NAME} --file ./app.hap`,
      '',
      '说明: --file 可以一次给多个文件（shell glob 也可），按顺序输出，文件之间空一行',
      '说明: HAP 是 ZIP，读取 pack.info / module.json；签名只检测 HAP 签名块并从内嵌 PKCS#7 提取证书，未执行验签',
      '说明: 默认每组证书只输出叶子证书；--verbose 输出完整证书链',
      '说明: signed / unsigned 的包内容通常相同，区别在是否带 HAP 签名块',
      '说明: 不输出证书 PEM 原文；HAP 里没有私钥',
    ],
  })
}

function renderAppHelp() {
  return renderHelp({
    title: `${PROGRAM} app - 查看 APP 安装包信息`,
    usage: [`${PROGRAM} app [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [`${OPTION_FILE} <路径...>`, `一个或多个 APP 文件路径（支持 shell glob），必填（可用 ${ENV_APP_FILE} 补齐）`],
          [
            OPTION_VERBOSE,
            `输出全部字段（ZIP 条目、签名子块、全部签名证书链、完整 pack.info / pac.json）；命令行未给出时读取 ${ENV_APP_VERBOSE}`,
          ],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_APP_FILE, `APP 文件路径，等价于 ${OPTION_FILE}`],
          [ENV_APP_VERBOSE, '输出全部字段，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', 'APP 包信息、内层模块与签名证书，每行一条「标签: 值」；--verbose 时追加 ZIP 条目、完整证书链与原始 JSON'],
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
      `  ${PROGRAM} app --file ./app-signed.app`,
      `  ${PROGRAM} app --file ./app-unsigned.app --verbose`,
      `  ${ENV_APP_FILE}=./app.app ${PROGRAM} app`,
      `  ${ENV_APP_VERBOSE}=1 ${PROGRAM} app --file ./app.app`,
      '',
      '说明: --file 可以一次给多个文件（shell glob 也可），按顺序输出，文件之间空一行',
      '说明: APP 是 ZIP，含 pac.json、pack.info 与一个或多个内层 .hap / .hsp；本命令读取外层信息',
      '说明: 签名块在外层，内层 HAP 可能没有单独签名；签名证书从外层 PKCS#7 提取，未执行验签',
      '说明: 默认每组证书只输出叶子证书；--verbose 输出完整证书链',
      '说明: 不输出证书 PEM 原文；APP 里没有私钥',
    ],
  })
}

// ------------------------------------------------------------------ ZIP 解析

/** 从文件尾部找 EOCD，返回中央目录位置与条目数 */
export function readEndOfCentralDirectory(buffer, help) {
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) {
      continue
    }
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength !== buffer.length) {
      continue
    }
    const count = buffer.readUInt16LE(offset + 10)
    const centralSize = buffer.readUInt32LE(offset + 12)
    const centralOffset = buffer.readUInt32LE(offset + 16)
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new UsageError('暂不支持 ZIP64 格式的 HAP', help())
    }
    if (centralOffset + centralSize > buffer.length) {
      throw new UsageError('ZIP 中央目录越界，文件可能已损坏', help())
    }
    return { count, centralOffset, centralSize }
  }
  throw new UsageError('不是有效的 ZIP / HAP（找不到 EOCD）', help())
}

/** 读取中央目录里的条目元数据（不立即解压） */
export function readZipEntries(buffer, eocd, help) {
  const entries = []
  let offset = eocd.centralOffset
  for (let index = 0; index < eocd.count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new UsageError(`ZIP 中央目录损坏（第 ${index + 1} 个条目）`, help())
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) {
      throw new UsageError('ZIP 条目名越界，文件可能已损坏', help())
    }
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new UsageError('暂不支持 ZIP64 格式的 HAP', help())
    }
    entries.push({
      name: buffer.subarray(nameStart, nameEnd).toString('utf8'),
      flags,
      method,
      compressedSize,
      size,
      localOffset,
    })
    offset = nameEnd + extraLength + commentLength
  }
  return entries
}

/** 按文件名找条目；兼容前面带目录的打包方式 */
export function findZipEntry(entries, name) {
  return (
    entries.find((entry) => entry.name === name) ??
    entries.find((entry) => entry.name.endsWith(`/${name}`)) ??
    null
  )
}

/** 解压单个 ZIP 条目 */
export function readZipEntryData(buffer, entry, help) {
  if ((entry.flags & 0x1) !== 0) {
    throw new UsageError(`ZIP 条目已加密，无法读取: ${entry.name}`, help())
  }
  if (entry.localOffset + 30 > buffer.length) {
    throw new UsageError(`ZIP 条目的本地头越界: ${entry.name}`, help())
  }
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new UsageError(`ZIP 条目的本地头损坏: ${entry.name}`, help())
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buffer.length) {
    throw new UsageError(`ZIP 条目数据越界: ${entry.name}`, help())
  }
  const compressed = buffer.subarray(dataStart, dataEnd)
  let data
  if (entry.method === 0) {
    data = compressed
  } else if (entry.method === 8) {
    try {
      data = inflateRawSync(compressed)
    } catch (error) {
      throw new UsageError(`ZIP 条目解压失败: ${entry.name}: ${error.message}`, help())
    }
  } else {
    throw new UsageError(`不支持的 ZIP 压缩方法 ${entry.method}: ${entry.name}`, help())
  }
  if (data.length !== entry.size) {
    throw new UsageError(
      `ZIP 条目解压后大小不一致: ${entry.name}（${data.length} != ${entry.size}）`,
      help(),
    )
  }
  return data
}

/** 读取并解析 JSON 条目；不存在返回 null */
function readJsonEntry(buffer, entries, name, help) {
  const entry = findZipEntry(entries, name)
  if (entry === null) {
    return null
  }
  let text = readZipEntryData(buffer, entry, help).toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`HAP 的 ${name} 不是合法 JSON: ${error.message}`, help())
  }
}

// ------------------------------------------------------------------ 签名块

/**
 * 读取 HAP 签名块。
 *
 * 签名块紧邻 ZIP 中央目录之前，尾部固定为：
 *   u64 size
 *   u128 magic
 *   u32 version
 * 因此 magic 位于 centralOffset - 20，size 位于 centralOffset - 28。
 */
function readHapSignature(buffer, centralOffset) {
  if (centralOffset < 32) {
    return null
  }
  const magicOffset = centralOffset - 20
  const magic = buffer.subarray(magicOffset, magicOffset + 16)
  let magicVersion
  if (magic.equals(HAP_SIGNATURE_MAGIC_V3)) {
    magicVersion = 3
  } else if (magic.equals(HAP_SIGNATURE_MAGIC_V2)) {
    magicVersion = 2
  } else {
    // 少数只带 Code Sign Block 的包没有 HAP 签名块；校验头部，避免把普通资源里的
    // 同名字节误判成签名。
    const codeOffset = buffer.indexOf(CODE_SIGN_MAGIC)
    if (codeOffset < 0 || codeOffset + 32 > centralOffset) {
      return null
    }
    const codeVersion = buffer.readUInt32LE(codeOffset + 8)
    const codeBlockSize = buffer.readUInt32LE(codeOffset + 12)
    const codeSegmentNum = buffer.readUInt32LE(codeOffset + 16)
    const codeFlags = buffer.readUInt32LE(codeOffset + 20)
    if (
      codeVersion !== 1 ||
      codeSegmentNum !== 3 ||
      codeBlockSize < 32 ||
      codeOffset + codeBlockSize > centralOffset ||
      codeFlags < 0 ||
      codeFlags > 3
    ) {
      return null
    }
    return {
      fallback: true,
      version: codeVersion,
      size: codeBlockSize,
      count: 0,
      start: codeOffset,
      blocks: [],
    }
  }

  const version = buffer.readUInt32LE(centralOffset - 4)
  const sizeBig = buffer.readBigUInt64LE(centralOffset - 28)
  const count = buffer.readUInt32LE(centralOffset - 32)
  if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      magicVersion,
      version,
      size: 0,
      count,
      start: centralOffset,
      blocks: [],
      invalid: true,
    }
  }
  const size = Number(sizeBig)
  const start = centralOffset - size
  if (!Number.isSafeInteger(size) || size < 32 || start < 0 || start >= centralOffset) {
    return {
      magicVersion,
      version,
      size,
      count,
      start,
      blocks: [],
      invalid: true,
    }
  }

  const blocks = []
  for (let index = 0; index < count; index += 1) {
    const header = start + index * 12
    if (header + 12 > centralOffset) {
      break
    }
    const type = buffer.readUInt32LE(header)
    const length = buffer.readUInt32LE(header + 4)
    const offset = buffer.readUInt32LE(header + 8)
    const valueStart = start + offset
    const valueEnd = valueStart + length
    blocks.push({
      type,
      length,
      offset,
      valueStart,
      valueEnd,
      valueValid: valueStart >= start && valueEnd <= centralOffset,
    })
  }
  return { magicVersion, version, size, count, start, blocks }
}

/** 签名块状态文案 */
function signatureLabel(signature, kind = 'HAP') {
  const blockName = kind === 'APP' ? 'APP 签名块' : 'HAP 签名块'
  if (signature === null) {
    return `未签名（未检测到 ${blockName}）`
  }
  if (signature.fallback) {
    return `已签名（检测到 ${kind} Code Sign Block；未验签）`
  }
  if (signature.invalid) {
    return `已签名（${blockName}头异常；未验签）`
  }
  const version =
    signature.version === undefined || signature.version === null
      ? ''
      : ` v${signature.version}`
  return `已签名（${blockName}${version}，${signature.count} 个子块；未验签）`
}

/** 从 HAP 签名块里的 PKCS#7 子块提取证书链 */
function collectHapSignatureCertificates(signature, buffer) {
  if (signature === null || signature.fallback || signature.invalid) {
    return []
  }
  const groups = []
  for (const block of signature.blocks) {
    if (block.type !== 0x20000000 && block.type !== 0x20000002) {
      continue
    }
    const label = block.type === 0x20000000 ? 'HAP 签名方案 v1' : 'Profile 签名'
    if (!block.valueValid) {
      groups.push({ label, certificates: [], error: '签名子块数据越界' })
      continue
    }
    try {
      const p7b = parseP7bDer(buffer.subarray(block.valueStart, block.valueEnd))
      groups.push({ label, certificates: p7b.certificates })
    } catch (error) {
      groups.push({ label, certificates: [], error: error.message })
    }
  }
  return groups.sort((left, right) => {
    const order = (label) => (label === 'HAP 签名方案 v1' ? 0 : 1)
    return order(left.label) - order(right.label)
  })
}

/** 证书链里找出叶子证书（不作为任何其它证书的颁发者）；找不到时退回第一张 */
function leafCertificate(certificates) {
  const issuerSubjects = new Set(certificates.map((certificate) => certificate.issuer))
  return (
    certificates.find((certificate) => !issuerSubjects.has(certificate.subject)) ??
    certificates[0]
  )
}

/** 证书链排序：叶子 -> 中间 CA -> 根，找不到的证书按原顺序追加 */
function orderCertificateChain(certificates) {
  const leaf = leafCertificate(certificates)
  const bySubject = new Map(certificates.map((certificate) => [certificate.subject, certificate]))
  const ordered = [leaf]
  const seen = new Set([leaf])
  let current = leaf
  while (true) {
    const issuer = bySubject.get(current.issuer)
    if (issuer === undefined || seen.has(issuer)) {
      break
    }
    ordered.push(issuer)
    seen.add(issuer)
    current = issuer
  }
  for (const certificate of certificates) {
    if (!seen.has(certificate)) {
      ordered.push(certificate)
    }
  }
  return ordered
}

/** 输出签名证书；默认只输出每组的第一张，--verbose 输出完整证书链 */
export function addSignatureCertificates(lines, groups, verbose) {
  if (groups.length === 0) {
    return
  }
  lines.push('', '签名证书:')
  for (const group of groups) {
    if (group.error !== undefined) {
      lines.push(`${group.label}: 解析失败（${group.error}）`)
      continue
    }
    if (group.certificates.length === 0) {
      lines.push(`${group.label}: 未找到证书`)
      continue
    }
    lines.push(`${group.label}: ${group.certificates.length} 张`)
    const chain = orderCertificateChain(group.certificates)
    const selected = verbose ? chain : chain.slice(0, 1)
    selected.forEach((certificate, index) => {
      lines.push(`证书 #${index + 1}:`)
      for (const detail of certificateDetailLines(certificate, verbose)) {
        lines.push(`  ${detail}`)
      }
    })
    if (!verbose && group.certificates.length > 1) {
      lines.push(`  （证书链其余 ${group.certificates.length - 1} 张用 --verbose 查看）`)
    }
  }
}

// ------------------------------------------------------------------ 输出

function pick(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '')
}

function values(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

function names(value) {
  return values(value)
    .map((item) => (typeof item === 'string' ? item : item?.name))
    .filter((item) => typeof item === 'string' && item !== '')
}

export function formatBytes(size) {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = size
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return index === 0 ? `${size} B` : `${value.toFixed(1)} ${units[index]}`
}

function renderHap(
  path,
  size,
  entries,
  pack,
  moduleJson,
  signature,
  certificateGroups,
  verbose,
  options = {},
) {
  const kind = options.kind ?? 'HAP'
  const pac = options.pac ?? null
  const innerModules = options.innerModules ?? []
  const summary = pack?.summary ?? {}
  const packApp = summary.app ?? {}
  const packVersion = packApp.version ?? {}
  const summaryModules = values(summary.modules)
  const summaryModule = summaryModules[0] ?? {}
  const distro = summaryModule.distro ?? {}
  const api = summaryModule.apiVersion ?? {}
  const packageInfo = values(pack?.packages)[0] ?? {}
  const packageNames = values(pack?.packages)
    .map((item) => item?.name)
    .filter((item) => typeof item === 'string' && item !== '')
  const app = moduleJson?.app ?? {}
  const module = moduleJson?.module ?? {}

  const bundleName = pick(app.bundleName, packApp.bundleName)
  const versionName = pick(app.versionName, packVersion.name)
  const versionCode = pick(app.versionCode, packVersion.code)
  const build = pick(app.buildVersion, packVersion.build)
  const bundleType = pick(app.bundleType, packApp.bundleType)
  const moduleName = pick(module.name, distro.moduleName)
  const moduleType = pick(module.type, distro.moduleType, packageInfo.moduleType)
  const deviceTypes = values(pick(module.deviceTypes, summaryModule.deviceType, packageInfo.deviceType))
  const abilities = names(pick(module.abilities, summaryModule.abilities))
  const mainAbility = pick(summaryModule.mainAbility, module.mainElement)
  const permissions = names(module.requestPermissions)
  const label = pick(app.label)
  const vendor = pick(app.vendor)
  const compileSdk = pick(app.compileSdkVersion)
  const compileSdkType = pick(app.compileSdkType)
  const minApi = pick(api.compatible, app.minAPIVersion)
  const targetApi = pick(api.target, app.targetAPIVersion)
  const releaseType = pick(api.releaseType, app.apiReleaseType)
  const deliveryWithInstall = pick(
    module.deliveryWithInstall,
    distro.deliveryWithInstall,
    packageInfo.deliveryWithInstall,
  )
  const installationFree = pick(module.installationFree, distro.installationFree)
  const buildMode = pick(app.buildMode)
  const debug = typeof app.debug === 'boolean' ? app.debug : undefined

  const lines = [
    `文件: ${path}`,
    `大小: ${formatBytes(size)}（${size} 字节）`,
    `格式: ${kind} / ZIP（${entries.length} 个条目）`,
    `签名: ${signatureLabel(signature, kind)}`,
  ]

  if (bundleName !== undefined) {
    lines.push(`包名: ${bundleName}`)
  }
  if (bundleType !== undefined) {
    lines.push(`包类型: ${bundleType}`)
  }
  if (versionName !== undefined || versionCode !== undefined) {
    const version = [versionName, versionCode === undefined ? '' : `(${versionCode})`]
      .filter(Boolean)
      .join(' ')
    lines.push(`版本: ${version}`)
  }
  if (build !== undefined) {
    lines.push(`构建号: ${build}`)
  }
  if (moduleName !== undefined || moduleType !== undefined) {
    const moduleText = [moduleName, moduleType === undefined ? '' : `（${moduleType}）`]
      .filter(Boolean)
      .join('')
    lines.push(`模块: ${moduleText}`)
  }
  if (deviceTypes.length > 0) {
    lines.push(`设备: ${deviceTypes.join('、')}`)
  }
  if (mainAbility !== undefined) {
    lines.push(`主 Ability: ${mainAbility}`)
  }
  if (abilities.length > 1) {
    lines.push(`Abilities: ${abilities.join('、')}`)
  }
  if (minApi !== undefined || targetApi !== undefined) {
    const apiText =
      [
        minApi === undefined ? '' : `兼容 ${minApi}`,
        targetApi === undefined ? '' : `目标 ${targetApi}`,
      ]
        .filter(Boolean)
        .join(' / ') + (releaseType === undefined ? '' : `（${releaseType}）`)
    lines.push(`API: ${apiText}`)
  }
  if (deliveryWithInstall !== undefined || installationFree !== undefined) {
    const install = []
    if (deliveryWithInstall === true) {
      install.push('随应用安装')
    } else if (deliveryWithInstall === false) {
      install.push('按需安装')
    }
    if (installationFree === true) {
      install.push('免安装')
    }
    if (install.length > 0) {
      lines.push(`安装: ${install.join('，')}`)
    }
  }
  if (buildMode !== undefined) {
    lines.push(`构建模式: ${buildMode}`)
  }
  if (debug !== undefined) {
    lines.push(`调试: ${debug ? '是' : '否'}`)
  }
  if (permissions.length > 0) {
    lines.push(`权限: ${permissions.join('、')}`)
  }
  if (kind === 'APP') {
    for (const item of innerModules) {
      lines.push(`内层模块: ${item.name}（${formatBytes(item.size)}）`)
    }
    if (pac !== null) {
      const dataProcess = values(pac.dataProcess).length
      const specialApis = values(pac.specialAPIs).length
      lines.push(`pac.json: 数据处理 ${dataProcess} 项、特殊 API ${specialApis} 项`)
    }
  }
  addSignatureCertificates(lines, certificateGroups, verbose)
  if (signature !== null && certificateGroups.length === 0) {
    lines.push('', '签名证书: 未解析到证书（仅检测到签名块）')
  }
  if (verbose) {
    if (label !== undefined) {
      lines.push(`应用标签: ${label}`)
    }
    if (vendor !== undefined) {
      lines.push(`厂商: ${vendor}`)
    }
    if (compileSdk !== undefined || compileSdkType !== undefined) {
      const sdk = [compileSdk, compileSdkType === undefined ? '' : `（${compileSdkType}）`]
        .filter(Boolean)
        .join('')
      lines.push(`编译 SDK: ${sdk}`)
    }
    if (packageNames.length > 0) {
      lines.push(`模块包: ${packageNames.join('、')}`)
    }

    lines.push('', '签名块:')
    if (signature === null) {
      lines.push('无')
    } else if (signature.fallback) {
      lines.push(`Code Sign Block 偏移: ${signature.start}`)
    } else {
      lines.push(`版本: ${signature.version}`)
      lines.push(`大小: ${signature.size} 字节`)
      lines.push(`子块数量: ${signature.count}`)
      lines.push(`起始偏移: ${signature.start}`)
      for (const block of signature.blocks) {
        const name = SIGN_BLOCK_TYPES.get(block.type) ?? '未知类型'
        lines.push(`- 0x${block.type.toString(16)} ${name}，${block.length} 字节`)
      }
    }

    lines.push('', 'ZIP 条目:')
    for (const entry of entries) {
      const method = entry.method === 0 ? 'store' : entry.method === 8 ? 'deflate' : `method ${entry.method}`
      lines.push(`- ${entry.name}（${entry.size} 字节，${method}）`)
    }

    if (pack !== null) {
      lines.push('', `pack.info: ${JSON.stringify(pack)}`)
    }
    if (moduleJson !== null) {
      lines.push(`module.json: ${JSON.stringify(moduleJson)}`)
    }
    if (pac !== null) {
      lines.push(`pac.json: ${JSON.stringify(pac)}`)
    }
  }

  return lines.join('\n')
}

// ------------------------------------------------------------------ 命令入口

/** 按 HAP 文件读取 ZIP、pack.info、module.json 与签名块 */
function parseHap(buffer, path, help) {
  const eocd = readEndOfCentralDirectory(buffer, help)
  const entries = readZipEntries(buffer, eocd, help)
  const pack = readJsonEntry(buffer, entries, 'pack.info', help)
  const moduleJson = readJsonEntry(buffer, entries, 'module.json', help)
  if (pack === null && moduleJson === null) {
    throw new UsageError(
      `不是 HAP：${path} 里没有 pack.info 或 module.json`,
      help(),
    )
  }
  const signature = readHapSignature(buffer, eocd.centralOffset)
  return { entries, pack, moduleJson, signature }
}

/** 按 APP 文件读取外层 ZIP、pack.info、pac.json、内层模块与签名块 */
function parseApp(buffer, path, help) {
  const eocd = readEndOfCentralDirectory(buffer, help)
  const entries = readZipEntries(buffer, eocd, help)
  const pack = readJsonEntry(buffer, entries, 'pack.info', help)
  const pac = readJsonEntry(buffer, entries, 'pac.json', help)
  if (pack === null && pac === null) {
    throw new UsageError(
      `不是 APP：${path} 里没有 pack.info 或 pac.json`,
      help(),
    )
  }
  const innerModules = entries.filter((entry) => /\.(hap|hsp)$/i.test(entry.name))
  const signature = readHapSignature(buffer, eocd.centralOffset)
  return { entries, pack, pac, innerModules, signature }
}

function readHapFile(path, help) {
  try {
    return readFileSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new UsageError(`文件不存在: ${path}`, help())
    }
    throw new UsageError(`读取文件失败: ${path}: ${error.message}`, help())
  }
}

function runHap(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderHapHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    HAP_OPTIONS,
    renderHapHelp,
    HAP_FLAGS,
    HAP_MULTI_OPTIONS,
  )
  const verbose = resolveVerbose(options, env, renderHapHelp)
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
      `缺少必填参数: ${OPTION_FILE}（HAP 文件路径，可多个），可用环境变量 ${ENV_FILE}`,
      renderHapHelp(),
    )
  }

  for (const [index, path] of paths.entries()) {
    const buffer = readHapFile(path, renderHapHelp)
    const parsed = parseHap(buffer, path, renderHapHelp)
    const certificateGroups = collectHapSignatureCertificates(parsed.signature, buffer)
    stdout(
      renderHap(
        path,
        buffer.length,
        parsed.entries,
        parsed.pack,
        parsed.moduleJson,
        parsed.signature,
        certificateGroups,
        verbose,
      ),
    )
    if (index < paths.length - 1) {
      stdout('')
    }
  }
  return EXIT_OK
}

function runApp(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderAppHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    HAP_OPTIONS,
    renderAppHelp,
    HAP_FLAGS,
    HAP_MULTI_OPTIONS,
  )
  const verbose = resolveVerbose(options, env, renderAppHelp, ENV_APP_VERBOSE)
  const envPath = readEnv(env, ENV_APP_FILE)
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
      `缺少必填参数: ${OPTION_FILE}（APP 文件路径，可多个），可用环境变量 ${ENV_APP_FILE}`,
      renderAppHelp(),
    )
  }

  for (const [index, path] of paths.entries()) {
    const buffer = readHapFile(path, renderAppHelp)
    const parsed = parseApp(buffer, path, renderAppHelp)
    const certificateGroups = collectHapSignatureCertificates(parsed.signature, buffer)
    stdout(
      renderHap(
        path,
        buffer.length,
        parsed.entries,
        parsed.pack,
        null,
        parsed.signature,
        certificateGroups,
        verbose,
        { kind: 'APP', pac: parsed.pac, innerModules: parsed.innerModules },
      ),
    )
    if (index < paths.length - 1) {
      stdout('')
    }
  }
  return EXIT_OK
}

/** app 命令描述，由 publish-apk.js 注册到根命令表 */
export const appCommand = {
  name: 'app',
  summary: '查看 APP 安装包信息（包名 / 版本 / 内层模块 / 签名）',
  run: runApp,
}

/** hap 命令描述，由 publish-apk.js 注册到根命令表 */
export const hapCommand = {
  name: COMMAND_NAME,
  summary: '查看 HAP 安装包信息（包名 / 版本 / API / 签名）',
  run: runHap,
}
