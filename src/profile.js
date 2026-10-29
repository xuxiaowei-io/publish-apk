/**
 * P7B Provisioning Profile 查看命令（`publish-apk profile`）。
 *
 * P7B 是 PKCS#7 SignedData 的常见后缀：华为 AppGallery 的 profile.p7b 在
 * encapContentInfo 里放一段 JSON（bundle name、type、validity、设备、权限等），
 * 在 certificates 里放 profile 的签名证书链，并用 signerInfos 对内容签名。
 *
 * 本命令只读本地文件，做三件事：
 *   1. 解析 PKCS#7 SignedData（DER 或 PEM），取出内嵌 JSON 与证书链；
 *   2. 默认输出 profile 常用字段与开发证书摘要，每行一条「标签: 值」；
 *   3. --verbose（或 PROFILE_VERBOSE=1）输出全部 JSON 字段、签名参数与完整的证书字段。
 *
 * 私钥不在 P7B 里，证书 PEM 原文也不打印；不引入 npm 依赖，P7B 解析完全用 Node 内置能力。
 *
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
import { renderHelp } from './help.js'

/** 命令名 */
const COMMAND_NAME = 'profile'
/** P7B 文件路径；必填 */
const OPTION_FILE = '--file'
/** 开关：输出全部字段 */
const OPTION_VERBOSE = '--verbose'
/** profile 支持的全部选项 */
const PROFILE_OPTIONS = new Set([OPTION_FILE, OPTION_VERBOSE])
/** profile 中的开关型选项（不带值） */
const PROFILE_FLAGS = new Set([OPTION_VERBOSE])

/** P7B 文件路径，等价于 --file（必填） */
const ENV_FILE = 'PROFILE_FILE'
/** 开关：输出全部字段，等价于 --verbose */
const ENV_VERBOSE = 'PROFILE_VERBOSE'

// -------------------------------------------------------------- 开关型参数

/** PROFILE_VERBOSE 里代表「开启」的取值 */
const VERBOSE_ON_VALUES = new Set(['1', 'true', 'yes', 'on'])
/** PROFILE_VERBOSE 里代表「关闭」的取值 */
const VERBOSE_OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

/** --verbose 的取值来源：命令行选项优先，其次环境变量 PROFILE_VERBOSE */
function resolveVerbose(options, env, help) {
  if (options.get(OPTION_VERBOSE) === true) {
    return true
  }
  const value = readEnv(env, ENV_VERBOSE)
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
    `环境变量 ${ENV_VERBOSE} 的值无效: "${value}"（开启用 1/true/yes/on，关闭用 0/false/no/off）`,
    help(),
  )
}

// ------------------------------------------------------------------ 帮助文档

/** profile 命令帮助文档 */
function renderProfileHelp() {
  return renderHelp({
    title: `${PROGRAM} ${COMMAND_NAME} - 查看 P7B Provisioning Profile`,
    usage: [`${PROGRAM} ${COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [
            `${OPTION_FILE} <路径>`,
            `P7B 文件路径（PKCS#7 SignedData，DER 或 PEM），必填（可用 ${ENV_FILE} 补齐）`,
          ],
          [
            OPTION_VERBOSE,
            `输出全部字段（含设备 ID、权限、签名参数与证书链）；命令行未给出时读取 ${ENV_VERBOSE}`,
          ],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_FILE, `P7B 文件路径，等价于 ${OPTION_FILE}`],
          [ENV_VERBOSE, '输出全部字段，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', 'profile 信息，每行一条「标签: 值」；--verbose 时输出全部字段'],
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
      `  ${PROGRAM} ${COMMAND_NAME} --file ./profile.p7b`,
      `  ${PROGRAM} ${COMMAND_NAME} --file ./profile.p7b --verbose`,
      `  ${ENV_FILE}=./profile.p7b ${PROGRAM} ${COMMAND_NAME}`,
      `  ${ENV_VERBOSE}=1 ${PROGRAM} ${COMMAND_NAME} --file ./profile.p7b`,
      '',
      '说明: 文件必须是 PKCS#7 SignedData（P7B）；华为 AppGallery 的 profile 内嵌 JSON',
      '说明: 默认输出 profile 常用字段与开发证书摘要；--verbose 追加全部 JSON 字段、签名参数与完整证书字段',
      '说明: 不输出证书 PEM 原文；P7B 里没有私钥',
      '说明: 内嵌数据不是合法 JSON 时仍会输出证书链，--verbose 会给出原因',
    ],
  })
}

// ------------------------------------------------------------------ 文件读取

/** 读取 P7B 文件；路径错误统一转成带帮助文档的用法错误 */
function readProfileFile(path, help) {
  try {
    return readFileSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new UsageError(`文件不存在: ${path}`, help())
    }
    throw new UsageError(`读取文件失败: ${path}: ${error.message}`, help())
  }
}

/** P7B 也可能是 PEM 包裹的 PKCS#7；是 PEM 就解出 DER，否则原样返回 */
function decodeP7bInput(buffer, path, help) {
  const text = buffer.toString('utf8')
  if (
    !text.includes('-----BEGIN PKCS7-----') &&
    !text.includes('-----BEGIN PKCS #7 SIGNED DATA-----')
  ) {
    // 只看文件开头：DER P7B 的内嵌 JSON 里也可能出现 certificate PEM 字符串
    if (text.trimStart().startsWith('-----BEGIN CERTIFICATE-----')) {
      throw new UsageError(`不是 P7B 文件: ${path}（这是 PEM 证书，请用 cert 命令）`, help())
    }
    return buffer
  }
  const match = /-----BEGIN (?:PKCS7|PKCS #7 SIGNED DATA)-----([\s\S]*?)-----END (?:PKCS7|PKCS #7 SIGNED DATA)-----/.exec(
    text,
  )
  if (match === null) {
    throw new UsageError(`P7B 文件格式无效: ${path}（PEM 头缺少结束标记）`, help())
  }
  const base64 = match[1].replace(/\s+/g, '')
  if (base64 === '') {
    throw new UsageError(`P7B 文件格式无效: ${path}（PEM 内容为空）`, help())
  }
  return Buffer.from(base64, 'base64')
}

// -------------------------------------------------------------- PKCS#7 解析

/** 只读 DER 解析器用到的标签 */
const TAG = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  OID: 0x06,
  SEQUENCE: 0x30,
  SET: 0x31,
  CONTEXT_0: 0xa0,
  CONTEXT_1: 0xa1,
}

/** 读取一个 DER TLV；返回内容区 [start, end) 与标签 */
function readTlv(buffer, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 > buffer.length) {
    throw new Error(`DER 读取越界（offset=${offset}）`)
  }
  const tag = buffer[offset]
  const firstLength = buffer[offset + 1]
  let length
  let headerLength
  if (firstLength < 0x80) {
    length = firstLength
    headerLength = 2
  } else {
    const byteCount = firstLength & 0x7f
    if (byteCount === 0 || byteCount > 4 || offset + 2 + byteCount > buffer.length) {
      throw new Error('DER 长度编码无效')
    }
    length = 0
    for (let index = 0; index < byteCount; index += 1) {
      length = length * 256 + buffer[offset + 2 + index]
    }
    headerLength = 2 + byteCount
  }
  const start = offset + headerLength
  const end = start + length
  if (end > buffer.length) {
    throw new Error('DER 长度超出缓冲区')
  }
  return { tag, start, end }
}

/** 解码 DER OID（content 部分） */
function decodeOid(buffer, tlv) {
  if (tlv.tag !== TAG.OID) {
    throw new Error('DER OID 标签无效')
  }
  const parts = []
  let value = 0
  let first = true
  for (let index = tlv.start; index < tlv.end; index += 1) {
    const byte = buffer[index]
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) {
      if (first) {
        if (value < 40) {
          parts.push(0, value)
        } else if (value < 80) {
          parts.push(1, value - 40)
        } else {
          parts.push(2, value - 80)
        }
        first = false
      } else {
        parts.push(value)
      }
      value = 0
    }
  }
  return parts.join('.')
}

/** 解码 DER INTEGER（只用于版本号这类小整数） */
function decodeInteger(buffer, tlv) {
  let value = 0
  for (let index = tlv.start; index < tlv.end; index += 1) {
    value = value * 256 + buffer[index]
  }
  return value
}

/** 解析 P7B，失败时统一转成带帮助文档的用法错误 */
function parseP7b(buffer, path, help) {
  const der = decodeP7bInput(buffer, path, help)
  try {
    return parseP7bDer(der)
  } catch (error) {
    throw new UsageError(`解析 P7B 失败: ${path}: ${error.message}`, help)
  }
}

/**
 * 解析 PKCS#7 SignedData。
 *
 * ContentInfo ::= SEQUENCE { contentType OID, content [0] EXPLICIT ANY }
 * SignedData  ::= SEQUENCE {
 *   version INTEGER,
 *   digestAlgorithms SET,
 *   encapContentInfo SEQUENCE { eContentType OID, eContent [0] EXPLICIT OCTET STRING OPTIONAL },
 *   certificates [0] IMPLICIT SET OF Certificate OPTIONAL,
 *   crls [1] IMPLICIT SET OF CertificateList OPTIONAL,
 *   signerInfos SET
 * }
 */
export function parseP7bDer(der) {
  const contentInfo = readTlv(der, 0)
  if (contentInfo.tag !== TAG.SEQUENCE) {
    throw new Error('不是 PKCS#7 SignedData（P7B）文件')
  }
  const contentTypeTlv = readTlv(der, contentInfo.start)
  if (contentTypeTlv.tag !== TAG.OID) {
    throw new Error('不是 PKCS#7 SignedData（P7B）文件')
  }
  const contentType = decodeOid(der, contentTypeTlv)
  if (contentType !== '1.2.840.113549.1.7.2') {
    throw new Error(`不是 PKCS#7 SignedData（ContentType=${contentType}）`)
  }
  const wrapper = readTlv(der, contentTypeTlv.end)
  if (wrapper.tag !== TAG.CONTEXT_0) {
    throw new Error('SignedData 缺少 [0] 包装')
  }
  const signedData = readTlv(der, wrapper.start)
  if (signedData.tag !== TAG.SEQUENCE) {
    throw new Error('SignedData 不是 SEQUENCE')
  }

  let offset = signedData.start
  const versionTlv = readTlv(der, offset)
  offset = versionTlv.end
  const digestSet = readTlv(der, offset)
  offset = digestSet.end
  const encap = readTlv(der, offset)
  offset = encap.end

  let inner = encap.start
  const eContentTypeTlv = readTlv(der, inner)
  inner = eContentTypeTlv.end
  const eContentType = decodeOid(der, eContentTypeTlv)
  let content
  if (inner < encap.end) {
    const eContentWrapper = readTlv(der, inner)
    if (eContentWrapper.tag !== TAG.CONTEXT_0) {
      throw new Error('encapContentInfo 的 eContent 不是 [0]')
    }
    const octetString = readTlv(der, eContentWrapper.start)
    if (octetString.tag !== TAG.OCTET_STRING) {
      throw new Error('eContent 不是 OCTET STRING')
    }
    content = der.subarray(octetString.start, octetString.end)
  }

  let certificates = []
  let signerInfos = []
  while (offset < signedData.end) {
    const field = readTlv(der, offset)
    if (field.tag === TAG.CONTEXT_0) {
      certificates = parseCertificates(der, field)
    } else if (field.tag === TAG.SET) {
      signerInfos = parseSignerInfos(der, field)
    }
    offset = field.end
  }

  return {
    version: decodeInteger(der, versionTlv),
    contentType,
    eContentType,
    digestAlgorithms: parseAlgorithmSet(der, digestSet),
    content,
    certificates,
    signerInfos,
  }
}

/** certificates [0] IMPLICIT SET OF Certificate：内容直接是一串 Certificate SEQUENCE */
function parseCertificates(der, wrapper) {
  const certificates = []
  let offset = wrapper.start
  while (offset < wrapper.end) {
    const certificate = readTlv(der, offset)
    if (certificate.tag !== TAG.SEQUENCE) {
      throw new Error('certificate 不是 SEQUENCE')
    }
    certificates.push(new X509Certificate(der.subarray(offset, certificate.end)))
    offset = certificate.end
  }
  return certificates
}

/** AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY } */
function algorithmOid(der, algorithm) {
  const oidTlv = readTlv(der, algorithm.start)
  return decodeOid(der, oidTlv)
}

/** digestAlgorithms SET OF AlgorithmIdentifier */
function parseAlgorithmSet(der, set) {
  const algorithms = []
  let offset = set.start
  while (offset < set.end) {
    const algorithm = readTlv(der, offset)
    algorithms.push(algorithmOid(der, algorithm))
    offset = algorithm.end
  }
  return algorithms
}

/**
 * signerInfos SET OF SignerInfo。
 *
 * 这里只取摘要算法与签名算法用于展示；签名验证需要按 CMS 规则重算 signedAttrs，
 * 超出「查看 profile」的范围，因此不做。
 */
function parseSignerInfos(der, set) {
  const signers = []
  let offset = set.start
  while (offset < set.end) {
    const signer = readTlv(der, offset)
    let inner = signer.start
    inner = readTlv(der, inner).end // version
    inner = readTlv(der, inner).end // sid（issuerAndSerialNumber 或 [0] subjectKeyIdentifier）
    const digestAlgorithm = readTlv(der, inner)
    inner = digestAlgorithm.end

    let next = readTlv(der, inner)
    if (next.tag === TAG.CONTEXT_0) {
      inner = next.end // signedAttrs
      next = readTlv(der, inner)
    }
    const signatureAlgorithm = next
    inner = signatureAlgorithm.end
    inner = readTlv(der, inner).end // signature OCTET STRING

    signers.push({
      digestOid: algorithmOid(der, digestAlgorithm),
      signatureOid: algorithmOid(der, signatureAlgorithm),
    })
    offset = signer.end
  }
  return signers
}

// ------------------------------------------------------------ profile JSON

/** 从 eContent 里解析 JSON；不是 JSON 时保留原因，证书链仍照常输出 */
function parseProfilePayload(content) {
  if (content === undefined) {
    return { json: null, text: null, reason: 'P7B 未包含内嵌数据' }
  }
  const text = content.toString('utf8').replace(/^\uFEFF/, '')
  const trimmed = text.trim()
  if (trimmed === '') {
    return { json: null, text, reason: '内嵌数据为空' }
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { json: null, text, reason: '内嵌数据不是 JSON' }
  }
  try {
    return { json: JSON.parse(trimmed), text, reason: null }
  } catch (error) {
    return { json: null, text, reason: `JSON 解析失败: ${error.message}` }
  }
}

/** profile JSON 里所有 PEM 证书（development-certificate / distribution-certificate 等） */
function collectJsonCertificates(json, help) {
  const certificates = []
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        visit(child, path === '' ? key : `${path}.${key}`)
      }
      return
    }
    if (typeof value === 'string' && value.includes('-----BEGIN CERTIFICATE-----')) {
      try {
        certificates.push({
          certificate: new X509Certificate(value),
          role: roleForCertificatePath(path),
          path,
        })
      } catch (error) {
        throw new UsageError(`内嵌证书解析失败: ${path}: ${error.message}`, help)
      }
    }
  }
  visit(json, '')
  return certificates
}

/** 从 JSON 字段名推断证书用途 */
function roleForCertificatePath(path) {
  if (path.endsWith('development-certificate')) {
    return '开发证书'
  }
  if (path.endsWith('distribution-certificate')) {
    return '发布证书'
  }
  return '内嵌证书'
}

/** 把 JSON 展平成「路径 = 值」；证书 PEM 不展开，留给证书详情 */
function flattenJson(value, path, out) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push([path, '[]'])
      return
    }
    value.forEach((item, index) => flattenJson(item, `${path}[${index}]`, out))
    return
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) {
      out.push([path, '{}'])
      return
    }
    for (const key of keys) {
      const child = value[key]
      const nextPath = path === '' ? key : `${path}.${key}`
      if (typeof child === 'string' && child.includes('-----BEGIN CERTIFICATE-----')) {
        out.push([nextPath, '（PEM 证书，见下方证书详情）'])
      } else {
        flattenJson(child, nextPath, out)
      }
    }
    return
  }
  out.push([path, value === null ? 'null' : String(value)])
}

// ------------------------------------------------------------------ 输出文本

/** 组装成「标签: 值」的一行；值里的换行压成空格，保证一条信息只占一行 */
function line(label, value) {
  return `${label}: ${String(value).replace(/[\r\n]+/g, ' ')}`
}

/** 多行 DN 合并成一行 */
function oneLineName(name) {
  return name
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .join(', ')
}

/** 缺失值统一显示「（无）」 */
function text(value) {
  return value === undefined || value === null || value === '' ? '（无）' : String(value)
}

/** 超长值截断，避免一行刷屏 */
function shorten(value) {
  const textValue = String(value)
  return textValue.length > 500 ? `${textValue.slice(0, 500)}…` : textValue
}

/** 把 JSON 里的 Unix 秒转成 Date；非法值返回 undefined */
function dateFromUnix(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value)) {
    return undefined
  }
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** 日期转 UTC ISO 8601；Date 非法时退回证书里的原始字符串 */
function isoDate(date, fallback) {
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

/** 两个日期相差的天数（向上取整） */
function daysBetween(from, to) {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 86_400_000))
}

/** profile 当前状态：未生效 / 有效 / 已过期 */
function describeValidity(notBefore, notAfter, now = new Date()) {
  if (now < notBefore) {
    return `未生效（还有 ${daysBetween(now, notBefore)} 天）`
  }
  if (now > notAfter) {
    return `已过期（已过期 ${daysBetween(notAfter, now)} 天）`
  }
  return `有效（剩余 ${daysBetween(now, notAfter)} 天）`
}

/** 常见 OID → 名称 */
const OID_NAMES = {
  '1.2.840.113549.1.7.1': 'data',
  '1.2.840.113549.1.7.2': 'signedData',
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
  '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption',
  '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
  '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption',
  '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
  '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256',
  '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384',
  '1.2.840.10045.4.3.4': 'ecdsa-with-SHA512',
  '1.3.101.112': 'Ed25519',
  '1.3.101.113': 'Ed448',
}

/** OID 的可读名称；未知 OID 原样返回 */
function oidName(oid) {
  const name = OID_NAMES[oid]
  return name === undefined ? oid : `${name} (${oid})`
}

/** 取对象字段；非对象返回空对象，避免 profile 字段缺失时抛错 */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** 取数组字段；非数组返回空数组 */
function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** profile 的常用字段 */
function addProfileFields(lines, json, verbose) {
  const bundle = asObject(json['bundle-info'])
  const debug = asObject(json['debug-info'])
  const validity = asObject(json.validity)
  const devices = asArray(debug['device-ids'])
  const permissions = asObject(json.permissions)
  const acls = asArray(asObject(json.acls)['allowed-acls'])
  const privileges = asArray(json['app-privilege-capabilities'])
  const services = asObject(json['app-services-capabilities'])
  const notBefore = dateFromUnix(validity['not-before'])
  const notAfter = dateFromUnix(validity['not-after'])

  lines.push(line('类型', text(json.type)))
  lines.push(line('版本名称', text(json['version-name'])))
  lines.push(line('版本代码', text(json['version-code'])))
  lines.push(line('UUID', text(json.uuid)))
  lines.push(line('签发者', text(json.issuer)))
  lines.push(line('Bundle', text(bundle['bundle-name'])))
  lines.push(line('开发者 ID', text(bundle['developer-id'])))
  lines.push(line('App ID', text(bundle['app-identifier'])))
  lines.push(line('APL', text(bundle.apl)))
  lines.push(line('App Feature', text(bundle['app-feature'])))
  if (notBefore !== undefined && notAfter !== undefined) {
    lines.push(line('生效时间', notBefore.toISOString()))
    lines.push(line('到期时间', notAfter.toISOString()))
    lines.push(line('状态', describeValidity(notBefore, notAfter)))
  } else {
    lines.push(line('有效期', '（无）'))
  }
  lines.push(line('设备 ID 类型', text(debug['device-id-type'])))
  lines.push(line('设备数量', devices.length))
  lines.push(line('权限数量', Object.keys(permissions).length))
  lines.push(line('ACL 数量', acls.length))
  lines.push(line('应用特权数量', privileges.length))
  lines.push(line('应用服务数量', Object.keys(services).length))

  if (verbose) {
    if (validity['not-before'] !== undefined) {
      lines.push(line('生效时间(Unix)', validity['not-before']))
    }
    if (validity['not-after'] !== undefined) {
      lines.push(line('到期时间(Unix)', validity['not-after']))
    }
    const flat = []
    flattenJson(json, '', flat)
    for (const [fieldPath, value] of flat) {
      lines.push(line('字段', fieldPath === '' ? shorten(value) : `${fieldPath} = ${shorten(value)}`))
    }
  }
}

/** P7B 自身的签名参数（--verbose） */
function addSignatureFields(lines, p7b) {
  lines.push(line('内容类型', oidName(p7b.contentType)))
  lines.push(line('内嵌内容类型', oidName(p7b.eContentType)))
  lines.push(line('SignedData 版本', p7b.version))
  if (p7b.digestAlgorithms.length > 0) {
    lines.push(line('摘要算法', p7b.digestAlgorithms.map(oidName).join('、')))
  }
  lines.push(line('签名者数量', p7b.signerInfos.length))
  p7b.signerInfos.forEach((signer, index) => {
    const suffix = p7b.signerInfos.length > 1 ? ` #${index + 1}` : ''
    lines.push(line(`签名者摘要算法${suffix}`, oidName(signer.digestOid)))
    lines.push(line(`签名者签名算法${suffix}`, oidName(signer.signatureOid)))
  })
}

/** 渲染 P7B 信息 */
function renderProfile(path, size, p7b, payload, jsonCertificates, verbose) {
  const lines = [line('文件', path), line('格式', 'PKCS#7 / P7B')]
  if (verbose) {
    lines.push(line('文件大小', `${size} 字节`))
    addSignatureFields(lines, p7b)
  }

  if (payload.json !== null && typeof payload.json === 'object' && !Array.isArray(payload.json)) {
    addProfileFields(lines, payload.json, verbose)
  } else {
    lines.push(line('内嵌数据', payload.reason ?? '内嵌数据不是 JSON 对象'))
    if (verbose && payload.text !== null) {
      lines.push(line('内嵌文本', shorten(payload.text)))
    }
  }

  lines.push(line('签名证书数量', p7b.certificates.length))
  for (const role of ['开发证书', '发布证书']) {
    const item = jsonCertificates.find((certificate) => certificate.role === role)
    if (item !== undefined) {
      lines.push(line(role, oneLineName(item.certificate.subject)))
      lines.push(line(`${role}到期时间`, isoDate(item.certificate.validToDate, item.certificate.validTo)))
    }
  }

  if (verbose) {
    const p7bFingerprints = new Set(p7b.certificates.map((certificate) => certificate.fingerprint256))
    p7b.certificates.forEach((certificate, index) => {
      lines.push('', `签名证书 #${index + 1}:`)
      lines.push(...certificateDetailLines(certificate, true))
    })
    jsonCertificates.forEach((item, index) => {
      if (p7bFingerprints.has(item.certificate.fingerprint256)) {
        return
      }
      const label = jsonCertificates.length > 1 ? `${item.role} #${index + 1}` : item.role
      lines.push('', `${label}:`)
      lines.push(...certificateDetailLines(item.certificate, true))
    })
  }

  return lines.join('\n')
}

// ------------------------------------------------------------------ 命令入口

/** 解析 P7B 并返回 profile / 证书信息的行；供 profile 与 signing-config 共用 */
export function profileInfoLines(buffer, path, help, verbose = false) {
  const p7b = parseP7b(buffer, path, help)
  const payload = parseProfilePayload(p7b.content)
  const jsonCertificates =
    payload.json === null ? [] : collectJsonCertificates(payload.json, help)
  return renderProfile(path, buffer.length, p7b, payload, jsonCertificates, verbose).split('\n')
}

/** profile 命令：解析选项、读取 P7B 并输出 profile / 证书信息 */
function runProfile(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderProfileHelp())
    return EXIT_OK
  }

  const options = parseOptions(argv, PROFILE_OPTIONS, renderProfileHelp, PROFILE_FLAGS)
  const verbose = resolveVerbose(options, env, renderProfileHelp)
  const path = options.get(OPTION_FILE) ?? readEnv(env, ENV_FILE)
  if (path === undefined) {
    throw new UsageError(
      `缺少必填参数: ${OPTION_FILE}（P7B 文件路径），可用环境变量 ${ENV_FILE}`,
      renderProfileHelp(),
    )
  }

  const buffer = readProfileFile(path, renderProfileHelp)
  const p7b = parseP7b(buffer, path, renderProfileHelp)
  const payload = parseProfilePayload(p7b.content)
  const jsonCertificates =
    payload.json === null ? [] : collectJsonCertificates(payload.json, renderProfileHelp)

  stdout(renderProfile(path, buffer.length, p7b, payload, jsonCertificates, verbose))
  return EXIT_OK
}

/** profile 命令描述，由 publish-apk.js 注册到根命令表 */
export const profileCommand = {
  name: COMMAND_NAME,
  summary: '查看 P7B Provisioning Profile',
  run: runProfile,
}
