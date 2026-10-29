/**
 * 证书查看命令（`publish-apk cert`）。
 *
 * 定位：与具体应用市场无关的通用工具——读取 X.509 证书（PEM / DER），把信息逐行输出。
 * 证书文件必须用 --file（或环境变量 CERT_FILE）显式给出，不设默认值；
 * 本模块不假设文件名，certpath.cer 只是常见用法里的一个例子。
 *
 * 两条输出规则：
 *   1. 每行一条信息，形如「标签: 值」；主题 / 颁发者里的多行 DN 会合并成一行，
 *      避免一张证书的信息散成多行、无法用 grep/awk 取用。
 *   2. 默认只输出常用字段；加 --verbose（或 CERT_VERBOSE=1）输出全部字段，
 *      包括 DN 的每一项、三种指纹、公钥细节与 X.509 扩展。
 *      证书原文（PEM/DER）不打印：它是文件内容而不是「信息」，需要时直接读取文件。
 *
 * 为什么用 node:crypto 的 X509Certificate：项目约定零第三方依赖，node:crypto 自 Node 15.6
 * 起提供 X509Certificate，Node 18 已满足。它不提供签名算法与扩展解码（较新的 Node 才补了
 * signatureAlgorithm），因此本模块自带一个只读的 DER 解析器补齐这两类信息
 * （见 parseCertificateDer），不依赖 openssl 命令，Windows / CI 环境也能用。
 *
 * 退出代码与其它命令一致：0 成功，1 参数错误或文件读取 / 解析失败。
 */
import { createHash, X509Certificate } from 'node:crypto'
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
import { renderHelp } from './help.js'

/** 命令名（根帮助与示例里使用） */
const COMMAND_NAME = 'cert'
/** 证书文件路径；不传时读默认文件 */
const OPTION_FILE = '--file'
/** 开关：输出全部字段（默认只输出常用字段） */
const OPTION_VERBOSE = '--verbose'
/** cert 支持的全部选项 */
const CERT_OPTIONS = new Set([OPTION_FILE, OPTION_VERBOSE])
/** cert 中的开关型选项（不带值） */
const CERT_FLAGS = new Set([OPTION_VERBOSE])

/** 证书文件路径，等价于 --file（必填） */
const ENV_FILE = 'CERT_FILE'
/** 开关：输出全部字段，等价于 --verbose */
const ENV_VERBOSE = 'CERT_VERBOSE'

/** PEM 证书块；用非贪婪匹配，一张文件里可以有多张证书（证书链） */
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

// -------------------------------------------------------------- 开关型参数

/** CERT_VERBOSE 里代表「开启」的取值（大小写、首尾空白不敏感） */
const VERBOSE_ON_VALUES = new Set(['1', 'true', 'yes', 'on'])
/** CERT_VERBOSE 里代表「关闭」的取值；空串由 readEnv 归为「未设置」 */
const VERBOSE_OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

/**
 * --verbose 的取值来源：命令行选项优先，其次环境变量 CERT_VERBOSE。
 *
 * 与 huawei / google 的开关型选项一致：环境变量只认白名单，真值开启、假值关闭、
 * 其它值报用法错误。不采用「非空即开启」，否则 CERT_VERBOSE=0 会在 CI 日志里
 * 凭空多出全部字段，而无法识别的值被悄悄当成关闭又会丢掉排查信息。
 */
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

/** cert 命令帮助文档：--help、无参数以外的调用失败也会复用它 */
function renderCertHelp() {
  return renderHelp({
    title: `${PROGRAM} ${COMMAND_NAME} - 查看证书信息`,
    usage: [`${PROGRAM} ${COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [
            `${OPTION_FILE} <路径>`,
            `证书文件路径（PEM 或 DER，PEM 可含多张证书），必填（可用 ${ENV_FILE} 补齐）`,
          ],
          [
            OPTION_VERBOSE,
            `输出全部证书信息（默认只输出常用字段）；命令行未给出时读取 ${ENV_VERBOSE}`,
          ],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_FILE, `证书文件路径，等价于 ${OPTION_FILE}`],
          [ENV_VERBOSE, '输出全部证书信息，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', '证书信息，每行一条「标签: 值」；--verbose 时输出全部字段'],
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
      `  ${PROGRAM} ${COMMAND_NAME} --file ./certpath.cer`,
      `  ${PROGRAM} ${COMMAND_NAME} --file ./certpath.cer --verbose`,
      `  ${ENV_FILE}=./certpath.cer ${PROGRAM} ${COMMAND_NAME}`,
      `  ${ENV_VERBOSE}=1 ${PROGRAM} ${COMMAND_NAME} --file ./certpath.cer`,
      '',
      '说明: 必须用 --file 或 CERT_FILE 指定证书文件，不提供默认文件',
      '说明: 文件不存在、为空或不是合法证书时报错并退出 1',
      '说明: --verbose 是「输出全部字段」，不是运行日志；证书信息属于结果，统一写 stdout',
      '说明: 证书原文（PEM/DER）不输出，需要时直接读取 --file 指向的文件',
    ],
  })
}

// ------------------------------------------------------------------ 文件读取

/**
 * 读取证书文件并解析成 X509Certificate 列表。
 *
 * 支持两种格式：
 *   - PEM：按 `-----BEGIN CERTIFICATE-----` 块切分，一份文件里可以有多张证书（证书链）；
 *   - DER：整个文件就是一张证书的 DER 编码。
 *
 * 只要文件里出现 PEM 头就按 PEM 处理；有头但没有结束标记时报「格式无效」，
 * 而不是把半截文本丢给 X509Certificate 换一个更难懂的 OpenSSL 错误。
 *
 * @returns {{ format: 'PEM' | 'DER', size: number, certificates: X509Certificate[] }}
 */
function readCertificates(path, help) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    // 路径是使用者刚给出的输入：原样给出，便于对照 --file / CERT_FILE 的值
    if (error.code === 'ENOENT') {
      throw new UsageError(`证书文件不存在: ${path}`, help())
    }
    throw new UsageError(`读取证书文件失败: ${path}: ${error.message}`, help())
  }

  const text = buffer.toString('utf8')
  const blocks = [...text.matchAll(PEM_BLOCK)].map((match) => match[0])
  if (blocks.length > 0) {
    return {
      format: 'PEM',
      size: buffer.length,
      certificates: blocks.map((block, index) => parseCertificate(block, path, index, help)),
    }
  }
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    throw new UsageError(`证书文件格式无效: ${path}（PEM 缺少 ${'-----END CERTIFICATE-----'}）`, help())
  }

  return {
    format: 'DER',
    size: buffer.length,
    certificates: [parseCertificate(buffer, path, 0, help)],
  }
}

/** 解析单张证书；失败时把文件与序号带进错误信息，方便在证书链里定位 */
function parseCertificate(data, path, index, help) {
  try {
    return new X509Certificate(data)
  } catch (error) {
    const position = index === 0 ? '' : `（第 ${index + 1} 张证书）`
    throw new UsageError(`证书解析失败: ${path}${position}: ${error.message}`, help())
  }
}

// ------------------------------------------------------------------ 输出文本

/** 组装成「标签: 值」的一行；值里的换行统一压成空格，保证一条信息只占一行 */
function line(label, value) {
  return `${label}: ${String(value).replace(/[\r\n]+/g, ' ')}`
}

/** 把主题 / 颁发者的多行 DN 合并成一行 */
function oneLineName(name) {
  return name.split('\n').map((item) => item.trim()).filter((item) => item !== '').join(', ')
}

/** 日期转 UTC ISO 8601；Date 非法时退回证书里的原始字符串 */
function isoDate(date, fallback) {
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

/** 两个日期相差的天数（向上取整，今天之内算 1 天） */
function daysBetween(from, to) {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 86_400_000))
}

/** 证书当前状态：未生效 / 有效 / 已过期，并给出相差天数 */
function describeValidity(notBefore, notAfter, now = new Date()) {
  if (now < notBefore) {
    return `未生效（还有 ${daysBetween(now, notBefore)} 天）`
  }
  if (now > notAfter) {
    return `已过期（已过期 ${daysBetween(notAfter, now)} 天）`
  }
  return `有效（剩余 ${daysBetween(now, notAfter)} 天）`
}

/** EC 曲线名 → 位数（Node 的 KeyObject 不直接给出 EC 位数） */
const EC_CURVE_BITS = {
  prime256v1: 256,
  secp256r1: 256,
  secp256k1: 256,
  secp384r1: 384,
  secp521r1: 521,
}

/** EC 曲线名 → 常见别名（Node 用 OpenSSL 名字，这里补上 NIST 名字） */
const EC_CURVE_NIST = {
  prime256v1: 'P-256',
  secp256r1: 'P-256',
  secp384r1: 'P-384',
  secp521r1: 'P-521',
  secp256k1: 'K-256',
}

/** 公钥算法的一句话描述（默认字段） */
function describePublicKey(key) {
  const type = key.asymmetricKeyType
  const details = key.asymmetricKeyDetails ?? {}
  if (type === 'rsa' || type === 'rsa-pss') {
    const bits = details.modulusLength === undefined ? '' : `，${details.modulusLength} 位`
    return `${type.toUpperCase()}${bits}`
  }
  if (type === 'ec') {
    const curve = details.namedCurve
    const bits = curve === undefined ? undefined : EC_CURVE_BITS[curve]
    if (curve === undefined) {
      return 'EC'
    }
    return `EC（${curve}${bits === undefined ? '' : `，${bits} 位`}）`
  }
  if (type === 'ed25519') {
    return 'Ed25519（256 位）'
  }
  if (type === 'ed448') {
    return 'Ed448（448 位）'
  }
  if (type === 'dsa') {
    return 'DSA'
  }
  if (type === 'dh') {
    return 'DH'
  }
  return type ?? '未知'
}

/** 自签名判断：主题与颁发者同名且能用自身公钥验签；无法验签时如实写「未知」 */
function describeSelfSigned(certificate) {
  const sameName = certificate.subject === certificate.issuer
  if (!sameName) {
    return '否'
  }
  try {
    return certificate.verify(certificate.publicKey) ? '是' : '否'
  } catch {
    return '未知（无法用自身公钥验签）'
  }
}

/** 公钥 SPKI 的 SHA-256 指纹（全部字段时输出） */
function publicKeyFingerprint(key) {
  try {
    const spki = key.export({ type: 'spki', format: 'der' })
    return formatHex(createHash('sha256').update(spki).digest())
  } catch {
    return '未知'
  }
}

/** 字节转大写、冒号分隔的十六进制（指纹、Key Identifier 用） */
function formatHex(buffer) {
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':')
}

/** 序列号的十进制形式；超过 Number 安全整数范围时用 BigInt */
function serialDecimal(serialNumber) {
  try {
    return BigInt(`0x${serialNumber}`).toString(10)
  } catch {
    return undefined
  }
}

/** 一行的字段集合：同一张证书的默认字段与 --verbose 追加字段都从这里生成 */
function certificateLines(certificate, verbose, parsed) {
  const lines = []

  lines.push(line('主题', oneLineName(certificate.subject)))
  if (verbose) {
    for (const item of certificate.subject.split('\n')) {
      if (item.trim() !== '') {
        lines.push(line('主题项', item.trim()))
      }
    }
  }

  lines.push(line('颁发者', oneLineName(certificate.issuer)))
  if (verbose) {
    for (const item of certificate.issuer.split('\n')) {
      if (item.trim() !== '') {
        lines.push(line('颁发者项', item.trim()))
      }
    }
  }

  lines.push(line('生效时间', isoDate(certificate.validFromDate, certificate.validFrom)))
  if (verbose) {
    lines.push(line('生效时间(GMT)', certificate.validFrom))
  }
  lines.push(line('到期时间', isoDate(certificate.validToDate, certificate.validTo)))
  if (verbose) {
    lines.push(line('到期时间(GMT)', certificate.validTo))
  }
  lines.push(line('状态', describeValidity(certificate.validFromDate, certificate.validToDate)))

  lines.push(line('版本', parsed === null ? '未知' : `${parsed.version}（X.509v${parsed.version}）`))
  const decimal = serialDecimal(certificate.serialNumber)
  lines.push(
    line(
      '序列号',
      verbose && decimal !== undefined
        ? `${certificate.serialNumber.toUpperCase()}（十进制 ${decimal}）`
        : certificate.serialNumber.toUpperCase(),
    ),
  )

  const signature = describeSignatureAlgorithm(certificate, parsed)
  lines.push(line('签名算法', signature))

  lines.push(line('公钥算法', describePublicKey(certificate.publicKey)))
  if (verbose) {
    const details = certificate.publicKey.asymmetricKeyDetails ?? {}
    lines.push(line('公钥类型', certificate.publicKey.asymmetricKeyType ?? '未知'))
    if (details.namedCurve !== undefined) {
      const nist = EC_CURVE_NIST[details.namedCurve]
      lines.push(line('公钥曲线', `${details.namedCurve}${nist === undefined ? '' : `（NIST ${nist}）`}`))
    }
    if (details.modulusLength !== undefined) {
      lines.push(line('公钥位数', `${details.modulusLength} 位`))
    } else if (details.namedCurve !== undefined && EC_CURVE_BITS[details.namedCurve] !== undefined) {
      lines.push(line('公钥位数', `${EC_CURVE_BITS[details.namedCurve]} 位`))
    }
    lines.push(line('公钥指纹(SHA-256)', publicKeyFingerprint(certificate.publicKey)))
  }

  if (verbose) {
    lines.push(line('SHA-1 指纹', certificate.fingerprint))
  }
  lines.push(line('SHA-256 指纹', certificate.fingerprint256))
  if (verbose) {
    lines.push(line('SHA-512 指纹', certificate.fingerprint512))
  }

  lines.push(line('是否 CA', certificate.ca ? '是' : '否'))
  lines.push(line('是否自签名', describeSelfSigned(certificate)))

  if (verbose) {
    lines.push(...extensionLines(parsed))
    if (parsed === null) {
      lines.push(line('X.509 扩展', '解析失败（仅输出证书基础字段）'))
    }
  }

  return lines
}

/** 一张证书的全部输出行；多张证书时用 `#N` 标题分隔 */
function renderCertificates(path, { format, size, certificates }, verbose) {
  const lines = [
    line('文件', path),
    line('格式', format),
    ...(verbose ? [line('文件大小', `${size} 字节`)] : []),
    line('证书数量', certificates.length),
  ]

  certificates.forEach((certificate, index) => {
    const parsed = parseCertificateDerSafe(certificate.raw)
    if (certificates.length > 1) {
      lines.push('', `证书 #${index + 1}:`)
    }
    lines.push(...certificateLines(certificate, verbose, parsed))
  })

  return lines.join('\n')
}

// ------------------------------------------------------------- DER 解析（补齐）

/**
 * 只读 DER 解析器支持的标签。
 *
 * 不追求实现完整的 X.509：只取 node:crypto 没暴露的两类信息——签名算法 OID、X.509 扩展。
 * 解析对象是 X509Certificate.raw（已经由 OpenSSL 校验过的合法 DER），所以这里不做
 * 防御式递归，读到越界或长度不对就抛错，由调用方降级为「未知」。
 */
const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  OID: 0x06,
  SEQUENCE: 0x30,
  CONTEXT_0: 0xa0,
  CONTEXT_3: 0xa3,
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

/** 解码 DER INTEGER（只用于版本号、pathLen 这类小整数） */
function decodeInteger(buffer, tlv) {
  let value = 0
  for (let index = tlv.start; index < tlv.end; index += 1) {
    value = value * 256 + buffer[index]
  }
  return value
}

/**
 * 解析证书 DER，取出：
 *   - version：1/2/3（X.509 版本）
 *   - signatureAlgorithmOid：签名算法 OID（Node 18 没有 signatureAlgorithm 属性）
 *   - extensions：{ oid, critical, value }[]，value 是 extnValue OCTET STRING 的内容
 */
function parseCertificateDer(der) {
  const certificate = readTlv(der, 0)
  if (certificate.tag !== TAG.SEQUENCE) {
    throw new Error('证书不是 DER SEQUENCE')
  }
  const tbs = readTlv(der, certificate.start)
  if (tbs.tag !== TAG.SEQUENCE) {
    throw new Error('TBSCertificate 不是 DER SEQUENCE')
  }
  const signatureAlgorithm = readTlv(der, tbs.end)
  const signatureAlgorithmOid = decodeOidInSequence(der, signatureAlgorithm)

  let offset = tbs.start
  let version = 1
  let field = readTlv(der, offset)
  if (field.tag === TAG.CONTEXT_0) {
    const versionTlv = readTlv(der, field.start)
    version = decodeInteger(der, versionTlv) + 1
    offset = field.end
    field = readTlv(der, offset)
  }
  // serialNumber
  offset = field.end
  // signature（TBSCertificate 里的 AlgorithmIdentifier）
  field = readTlv(der, offset)
  offset = field.end
  // issuer / validity / subject / subjectPublicKeyInfo
  for (let skip = 0; skip < 4; skip += 1) {
    field = readTlv(der, offset)
    offset = field.end
  }

  let extensions = []
  while (offset < tbs.end) {
    field = readTlv(der, offset)
    if (field.tag === TAG.CONTEXT_3) {
      extensions = parseExtensions(der, field)
    }
    offset = field.end
  }

  return { version, signatureAlgorithmOid, extensions }
}

/** AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY } */
function decodeOidInSequence(buffer, tlv) {
  if (tlv.tag !== TAG.SEQUENCE) {
    throw new Error('AlgorithmIdentifier 不是 DER SEQUENCE')
  }
  const oidTlv = readTlv(buffer, tlv.start)
  return decodeOid(buffer, oidTlv)
}

/** Extensions ::= SEQUENCE OF Extension；[3] 是 EXPLICIT 标记，先剥掉外层 SEQUENCE */
function parseExtensions(buffer, wrapper) {
  const outer = readTlv(buffer, wrapper.start)
  if (outer.tag !== TAG.SEQUENCE || outer.end !== wrapper.end) {
    throw new Error('Extensions 不是 DER SEQUENCE')
  }
  const extensions = []
  let offset = outer.start
  while (offset < outer.end) {
    const extension = readTlv(buffer, offset)
    let inner = extension.start
    const oidTlv = readTlv(buffer, inner)
    const oid = decodeOid(buffer, oidTlv)
    inner = oidTlv.end

    let critical = false
    let next = readTlv(buffer, inner)
    if (next.tag === TAG.BOOLEAN) {
      critical = buffer[next.start] !== 0
      inner = next.end
      next = readTlv(buffer, inner)
    }
    if (next.tag !== TAG.OCTET_STRING) {
      throw new Error(`扩展 ${oid} 的 extnValue 不是 OCTET STRING`)
    }
    extensions.push({ oid, critical, value: buffer.subarray(next.start, next.end) })
    offset = extension.end
  }
  return extensions
}

/** 解析失败时返回 null：基础字段照常输出，扩展部分降级 */
function parseCertificateDerSafe(der) {
  try {
    return parseCertificateDer(der)
  } catch {
    return null
  }
}

// ------------------------------------------------------------- 签名算法

/**
 * 常见签名算法 OID → 名称。
 *
 * Node 26 起 X509Certificate 自带 signatureAlgorithm / signatureAlgorithmOid，
 * 但项目 engines 是 >=18；这里自带映射，保证老版本 Node 也能输出签名算法。
 */
const SIGNATURE_ALGORITHMS = {
  '1.2.840.113549.1.1.4': 'md5WithRSAEncryption',
  '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption',
  '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
  '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption',
  '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
  '1.2.840.113549.1.1.14': 'sha224WithRSAEncryption',
  '1.2.840.10040.4.3': 'dsa-with-SHA1',
  '1.2.840.10045.4.1': 'ecdsa-with-SHA1',
  '1.2.840.10045.4.3.1': 'ecdsa-with-SHA224',
  '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256',
  '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384',
  '1.2.840.10045.4.3.4': 'ecdsa-with-SHA512',
  '2.16.840.1.101.3.4.3.2': 'dsa-with-SHA256',
  '1.3.101.112': 'Ed25519',
  '1.3.101.113': 'Ed448',
}

/** 签名算法：优先用自带 DER 解析的 OID，其次用新版 Node 的属性 */
function describeSignatureAlgorithm(certificate, parsed) {
  const oid = parsed?.signatureAlgorithmOid ?? certificate.signatureAlgorithmOid
  const name =
    (oid === undefined ? undefined : SIGNATURE_ALGORITHMS[oid]) ??
    certificate.signatureAlgorithm ??
    (oid === undefined ? undefined : oid)
  if (oid === undefined || name === oid) {
    return name ?? '未知'
  }
  return `${name} (${oid})`
}

// ------------------------------------------------------------- X.509 扩展

/** X.509 Key Usage 的位 → 名称（顺序即 RFC 5280 的 bit 0..8） */
const KEY_USAGE_NAMES = [
  '数字签名',
  '内容承诺',
  '密钥加密',
  '数据加密',
  '密钥协商',
  '证书签名',
  'CRL 签名',
  '仅加密',
  '仅解密',
]

/** Extended Key Usage 常见 OID → 名称 */
const EXTENDED_KEY_USAGE_NAMES = {
  '1.3.6.1.5.5.7.3.1': 'TLS Web 服务器认证',
  '1.3.6.1.5.5.7.3.2': 'TLS Web 客户端认证',
  '1.3.6.1.5.5.7.3.3': '代码签名',
  '1.3.6.1.5.5.7.3.4': '电子邮件保护',
  '1.3.6.1.5.5.7.3.8': '时间戳',
  '1.3.6.1.5.5.7.3.9': 'OCSP 签名',
  '2.5.29.37.0': '任意扩展密钥用途',
}

/** Authority Information Access 的访问方式 OID → 名称 */
const ACCESS_METHOD_NAMES = {
  '1.3.6.1.5.5.7.48.1': 'OCSP',
  '1.3.6.1.5.5.7.48.2': 'CA Issuers',
  '1.3.6.1.5.5.7.48.3': '时间戳',
  '1.3.6.1.5.5.7.48.5': 'CA Repository',
}

/** 按扩展 OID 输出可读信息；认不出的扩展输出 OID、critical 与十六进制内容 */
function extensionLines(parsed) {
  if (parsed === null) {
    return []
  }
  const lines = []
  for (const extension of parsed.extensions) {
    const suffix = extension.critical ? '（critical）' : ''
    try {
      switch (extension.oid) {
        case '2.5.29.15':
          lines.push(line(`密钥用途（Key Usage）${suffix}`, decodeKeyUsage(extension.value)))
          break
        case '2.5.29.19':
          lines.push(line(`基本约束（Basic Constraints）${suffix}`, decodeBasicConstraints(extension.value)))
          break
        case '2.5.29.14':
          lines.push(line('主题密钥标识（Subject Key Identifier）', decodeKeyIdentifier(extension.value)))
          break
        case '2.5.29.35':
          lines.push(line('颁发者密钥标识（Authority Key Identifier）', decodeAuthorityKeyIdentifier(extension.value)))
          break
        case '2.5.29.17':
          lines.push(...decodeSubjectAlternativeName(extension.value))
          break
        case '2.5.29.18':
          lines.push(...decodeIssuerAlternativeName(extension.value))
          break
        case '2.5.29.37':
          lines.push(...decodeExtendedKeyUsage(extension.value))
          break
        case '2.5.29.31':
          lines.push(line('CRL 分发点（CRL Distribution Points）', decodeCrlDistributionPoints(extension.value)))
          break
        case '2.5.29.32':
          lines.push(...decodeCertificatePolicies(extension.value))
          break
        case '1.3.6.1.5.5.7.1.1':
          lines.push(...decodeAuthorityInfoAccess(extension.value))
          break
        case '1.3.6.1.5.5.7.1.11':
          lines.push(...decodeSubjectInfoAccess(extension.value))
          break
        default:
          lines.push(line(`扩展 ${extension.oid}${suffix}`, formatHexSummary(extension.value)))
      }
    } catch (error) {
      // 单个扩展解不出来不影响其它字段；把原因写出来，避免「静默少了信息」
      lines.push(line(`扩展 ${extension.oid}${suffix}`, `解析失败: ${error.message}`))
    }
  }
  return lines
}

/** 密钥用途：extnValue 里是一个 BIT STRING，bit 0..8 对应 RFC 5280 的用途 */
function decodeKeyUsage(value) {
  const bitString = readTlv(value, 0)
  if (bitString.tag !== TAG.BIT_STRING) {
    throw new Error('Key Usage 不是 BIT STRING')
  }
  const bytes = value.subarray(bitString.start + 1, bitString.end)
  const usages = []
  for (let index = 0; index < KEY_USAGE_NAMES.length; index += 1) {
    const byte = bytes[Math.floor(index / 8)]
    if (byte !== undefined && (byte & (0x80 >> (index % 8))) !== 0) {
      usages.push(KEY_USAGE_NAMES[index])
    }
  }
  return usages.length > 0 ? usages.join('、') : '无'
}

/** 基本约束：SEQUENCE { cA BOOLEAN DEFAULT FALSE, pathLenConstraint INTEGER OPTIONAL } */
function decodeBasicConstraints(value) {
  const sequence = readTlv(value, 0)
  if (sequence.tag !== TAG.SEQUENCE) {
    throw new Error('Basic Constraints 不是 SEQUENCE')
  }
  let ca = false
  let pathLength
  let offset = sequence.start
  while (offset < sequence.end) {
    const field = readTlv(value, offset)
    if (field.tag === TAG.BOOLEAN) {
      ca = value[field.start] !== 0
    } else if (field.tag === TAG.INTEGER) {
      pathLength = decodeInteger(value, field)
    }
    offset = field.end
  }
  return `CA:${ca ? 'TRUE' : 'FALSE'}${pathLength === undefined ? '' : `，pathLen:${pathLength}`}`
}

/** Subject Key Identifier：extnValue 里是 OCTET STRING */
function decodeKeyIdentifier(value) {
  const octetString = readTlv(value, 0)
  if (octetString.tag !== TAG.OCTET_STRING) {
    throw new Error('Subject Key Identifier 不是 OCTET STRING')
  }
  return formatHex(value.subarray(octetString.start, octetString.end))
}

/** Authority Key Identifier：SEQUENCE 里 [0] keyIdentifier 是隐式标记的 OCTET STRING */
function decodeAuthorityKeyIdentifier(value) {
  const sequence = readTlv(value, 0)
  if (sequence.tag !== TAG.SEQUENCE) {
    throw new Error('Authority Key Identifier 不是 SEQUENCE')
  }
  let offset = sequence.start
  while (offset < sequence.end) {
    const field = readTlv(value, offset)
    if (field.tag === 0x80) {
      return formatHex(value.subarray(field.start, field.end))
    }
    offset = field.end
  }
  return '（未包含 keyIdentifier）'
}

/** GeneralNames → 可读名称；SAN / IAN / AIA 共用 */
function decodeGeneralNames(buffer, sequence) {
  if (sequence.tag !== TAG.SEQUENCE) {
    throw new Error('GeneralNames 不是 SEQUENCE')
  }
  const names = []
  let offset = sequence.start
  while (offset < sequence.end) {
    const name = readTlv(buffer, offset)
    names.push(formatGeneralName(buffer, name))
    offset = name.end
  }
  return names
}

/** GeneralName 的各分支（dNSName、URI、IP 等） */
function formatGeneralName(buffer, tlv) {
  const content = buffer.subarray(tlv.start, tlv.end)
  switch (tlv.tag) {
    case 0x81:
      return `email:${content.toString('utf8')}`
    case 0x82:
      return `DNS:${content.toString('utf8')}`
    case 0x86:
      return `URI:${content.toString('utf8')}`
    case 0x87:
      return `IP:${formatIpAddress(content)}`
    case 0x88:
      // registeredID 用 [8] 隐式标记，内容与 OID 的 content 相同，补一个虚拟标签交给 decodeOid
      return `RID:${decodeOid(buffer, { tag: TAG.OID, start: tlv.start, end: tlv.end })}`
    case 0xa4:
      return `DirName:${formatHexSummary(content)}`
    default:
      return `tag 0x${tlv.tag.toString(16)}:${formatHexSummary(content)}`
  }
}

/** IP 地址的二进制形式转文本（SAN 里的 iPAddress） */
function formatIpAddress(buffer) {
  if (buffer.length === 4) {
    return [...buffer].join('.')
  }
  if (buffer.length === 16) {
    const groups = []
    for (let index = 0; index < 16; index += 2) {
      groups.push(buffer.readUInt16BE(index).toString(16))
    }
    return groups.join(':')
  }
  return formatHex(buffer)
}

/** Subject Alternative Name：每个名称一行，便于逐条查看 */
function decodeSubjectAlternativeName(value) {
  const sequence = readTlv(value, 0)
  const names = decodeGeneralNames(value, sequence)
  return names.length === 0
    ? [line('主体备用名称（Subject Alternative Name）', '（空）')]
    : names.map((name) => line('主体备用名称（Subject Alternative Name）', name))
}

/** Issuer Alternative Name：与 SAN 同构 */
function decodeIssuerAlternativeName(value) {
  const sequence = readTlv(value, 0)
  const names = decodeGeneralNames(value, sequence)
  return names.length === 0
    ? [line('颁发者备用名称（Issuer Alternative Name）', '（空）')]
    : names.map((name) => line('颁发者备用名称（Issuer Alternative Name）', name))
}

/** Extended Key Usage：SEQUENCE OF OID，每个用途一行 */
function decodeExtendedKeyUsage(value) {
  const sequence = readTlv(value, 0)
  if (sequence.tag !== TAG.SEQUENCE) {
    throw new Error('Extended Key Usage 不是 SEQUENCE')
  }
  const usages = []
  let offset = sequence.start
  while (offset < sequence.end) {
    const field = readTlv(value, offset)
    const oid = decodeOid(value, field)
    const name = EXTENDED_KEY_USAGE_NAMES[oid]
    usages.push(name === undefined ? oid : `${name} (${oid})`)
    offset = field.end
  }
  return usages.length === 0
    ? [line('扩展密钥用途（Extended Key Usage）', '（空）')]
    : usages.map((usage) => line('扩展密钥用途（Extended Key Usage）', usage))
}

/**
 * CRL 分发点：结构嵌套较深（DistributionPoint → DistributionPointName → GeneralNames），
 * 这里递归收集所有 GeneralName 分支，输出其中的 URI / DNS / IP。
 */
function decodeCrlDistributionPoints(value) {
  const names = []
  collectGeneralNames(value, readTlv(value, 0), names)
  return names.length > 0 ? names.join('、') : '（未包含可读地址）'
}

/** 递归遍历 DER，收集 GeneralName 分支（CRL 分发点用） */
function collectGeneralNames(buffer, tlv, names) {
  if ([0x81, 0x82, 0x86, 0x87, 0x88].includes(tlv.tag)) {
    names.push(formatGeneralName(buffer, tlv))
    return
  }
  if ((tlv.tag & 0x20) === 0) {
    return
  }
  let offset = tlv.start
  while (offset < tlv.end) {
    const field = readTlv(buffer, offset)
    collectGeneralNames(buffer, field, names)
    offset = field.end
  }
}

/** Certificate Policies：SEQUENCE OF PolicyInformation，每个策略 OID 一行 */
function decodeCertificatePolicies(value) {
  const sequence = readTlv(value, 0)
  if (sequence.tag !== TAG.SEQUENCE) {
    throw new Error('Certificate Policies 不是 SEQUENCE')
  }
  const policies = []
  let offset = sequence.start
  while (offset < sequence.end) {
    const information = readTlv(value, offset)
    const oidTlv = readTlv(value, information.start)
    policies.push(decodeOid(value, oidTlv))
    offset = information.end
  }
  return policies.length === 0
    ? [line('证书策略（Certificate Policies）', '（空）')]
    : policies.map((oid) => line('证书策略（Certificate Policies）', oid))
}

/** Authority / Subject Information Access 的公共解码：AccessDescription 序列 */
function decodeInformationAccess(value, label) {
  const sequence = readTlv(value, 0)
  if (sequence.tag !== TAG.SEQUENCE) {
    throw new Error(`${label} 不是 SEQUENCE`)
  }
  const entries = []
  let offset = sequence.start
  while (offset < sequence.end) {
    const description = readTlv(value, offset)
    let inner = description.start
    const methodTlv = readTlv(value, inner)
    const method = decodeOid(value, methodTlv)
    inner = methodTlv.end
    const location = readTlv(value, inner)
    entries.push({
      method: ACCESS_METHOD_NAMES[method] ?? `${label} ${method}`,
      location: formatGeneralName(value, location),
    })
    offset = description.end
  }
  return entries
}

/** Authority Information Access：OCSP / CA Issuers 地址 */
function decodeAuthorityInfoAccess(value) {
  return decodeInformationAccess(value, 'AIA').map((entry) =>
    line(`${entry.method}`, entry.location),
  )
}

/** Subject Information Access：CA Repository / 时间戳地址 */
function decodeSubjectInfoAccess(value) {
  return decodeInformationAccess(value, 'SIA').map((entry) =>
    line(`${entry.method}`, entry.location),
  )
}

/** 未知扩展 / 无法解析内容时的十六进制摘要；过长的值截断，避免一行刷屏 */
function formatHexSummary(buffer) {
  if (buffer.length === 0) {
    return '（空）'
  }
  const shown = 32
  const hex = formatHex(buffer.subarray(0, shown))
  return buffer.length > shown ? `${hex} …（共 ${buffer.length} 字节）` : hex
}

// ------------------------------------------------------------------ 命令入口

/** cert 命令：解析选项、读取证书并输出信息 */
function runCert(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderCertHelp())
    return EXIT_OK
  }

  const options = parseOptions(argv, CERT_OPTIONS, renderCertHelp, CERT_FLAGS)
  const verbose = resolveVerbose(options, env, renderCertHelp)
  const path = options.get(OPTION_FILE) ?? readEnv(env, ENV_FILE)
  if (path === undefined) {
    throw new UsageError(
      `缺少必填参数: ${OPTION_FILE}（证书文件路径），可用环境变量 ${ENV_FILE}`,
      renderCertHelp(),
    )
  }

  const certificates = readCertificates(path, renderCertHelp)
  stdout(renderCertificates(path, certificates, verbose))
  return EXIT_OK
}

/**
 * 证书命令描述，由 publish-apk.js 注册到根命令表。
 *
 * 与 huawei / google 不同，cert 不属于任何厂商：它只读本地证书文件，
 * 因此单独放在 TOOLS 里，而不是 VENDORS。
 */
export const certCommand = {
  name: COMMAND_NAME,
  summary: '查看证书信息',
  run: runCert,
}
