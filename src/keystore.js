/**
 * Android 签名密钥库工具（`publish-apk keystore` / `keystore-env` / `keystore-gen`）。
 *
 *   - `keystore`：校验已有 keystore 的口令 / 别名 / 私钥；
 *   - `keystore-env`：导出 CI 变量（BASE64 / 口令 / 别名）；
 *   - `keystore-gen`：用 keytool 快速生成 PKCS12 / JKS。
 *
 * 定位：与具体应用市场无关的本地工具 —— 拿 CI 里那套 Android 签名变量
 * （ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_FILE / ANDROID_KEYSTORE_PASSWORD /
 * ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD）先自检一遍，再决定要不要把它们交给 Gradle。
 *
 * 为什么需要它：Gradle 只在打包到 `packageRelease` 时才去开 keystore，口令或别名写错
 * 时既报得晚、又只给一句 `KeytoolException`，看不出是哪个变量错了。本命令提前用 keytool
 * 做三件事，任何一件不通过都直接以退出代码 1 停下：
 *   1. `keytool -list`            —— keystore 口令能不能打开密钥库；
 *   2. `keytool -list -alias`     —— 别名在不在（显式给了 --key-alias 时才单独查）；
 *   3. `keytool -certreq`         —— 用 storePassword + keyPassword 能不能真的解开私钥。
 *
 * 两种输入方式：
 *   - `--base64` / `ANDROID_KEYSTORE_BASE64`：密钥库的 BASE64 内容。此时再给
 *     `--file` / `ANDROID_KEYSTORE_FILE`，校验通过后就把解码出来的**密钥库原文**写到该路径；
 *     不给文件路径就落到临时文件校验，校验完删除，不留下任何东西。
 *   - `--file` / `ANDROID_KEYSTORE_FILE` / `ANDROID_KEYSTORE`：已有的密钥库文件路径。
 *
 * 口令处理：`--store-password` / `ANDROID_KEYSTORE_PASSWORD`；密钥口令默认跟 keystore 口令
 * 相同（Gradle 与 keytool 都这么兜底），不同时用 `--key-password` / `ANDROID_KEY_PASSWORD`。
 * 口令不会打印到 stdout / stderr；但 keytool 只接受 `-storepass` / `-keypass` 这种参数形式，
 * 所以校验期间会出现在本地 keytool 进程的 argv 里（与 huawei signing-config 的自检一致）。
 *
 * 输出：stdout 只写「标签: 值」校验结果（密钥库路径 / 大小 / 类型 / 别名 / 公钥 / 证书 /
 * 校验结论），stderr 只写落盘、备份与警告；退出代码 0 通过、1 参数错误或校验失败。
 */
import { spawnSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  EXIT_OK,
  PROGRAM,
  UsageError,
  isHelpToken,
  parseOptions,
  readEnv,
  stderr,
  stdout,
} from './cli.js'
import { renderHelp } from './help.js'

/** 命令名（根帮助与示例里使用） */
const COMMAND_NAME = 'keystore'
const GEN_COMMAND_NAME = 'keystore-gen'
const ENV_COMMAND_NAME = 'keystore-env'

/** 密钥库路径；与 --base64 同用时是解码后的输出路径 */
const OPTION_FILE = '--file'
/** 密钥库的 BASE64 内容 */
const OPTION_BASE64 = '--base64'
/** keystore 明文口令 */
const OPTION_STORE_PASSWORD = '--store-password'
/** 私钥别名；不传时用 keytool 自动识别 */
const OPTION_KEY_ALIAS = '--key-alias'
/** 私钥明文口令；默认与 keystore 口令相同 */
const OPTION_KEY_PASSWORD = '--key-password'
const OPTION_STORE_TYPE = '--store-type'
const OPTION_KEY_ALGORITHM = '--key-algorithm'
const OPTION_KEY_SIZE = '--key-size'
const OPTION_VALIDITY = '--validity'
const OPTION_DNAME = '--dname'
const OPTION_FORCE = '--force'
const OPTION_FORMAT = '--format'

const KEYSTORE_OPTIONS = new Set([
  OPTION_FILE,
  OPTION_BASE64,
  OPTION_STORE_PASSWORD,
  OPTION_KEY_ALIAS,
  OPTION_KEY_PASSWORD,
])
const KEYSTORE_FLAGS = new Set()

const GEN_OPTIONS = new Set([
  OPTION_FILE,
  OPTION_KEY_ALIAS,
  OPTION_STORE_PASSWORD,
  OPTION_STORE_TYPE,
  OPTION_KEY_ALGORITHM,
  OPTION_KEY_SIZE,
  OPTION_VALIDITY,
  OPTION_DNAME,
  OPTION_FORCE,
])
const GEN_FLAGS = new Set([OPTION_FORCE])

const ENV_OPTIONS = new Set([
  OPTION_FILE,
  OPTION_STORE_PASSWORD,
  OPTION_KEY_ALIAS,
  OPTION_KEY_PASSWORD,
  OPTION_FORMAT,
])
const ENV_FLAGS = new Set()

/** 密钥库路径，等价于 --file（也可用 ANDROID_KEYSTORE 补） */
const ENV_FILE = 'ANDROID_KEYSTORE_FILE'
/** ANDROID_KEYSTORE_FILE 的别名，只当文件路径用 */
const ENV_KEYSTORE = 'ANDROID_KEYSTORE'
/** 密钥库的 BASE64 内容，等价于 --base64 */
const ENV_BASE64 = 'ANDROID_KEYSTORE_BASE64'
/** keystore 明文口令，等价于 --store-password */
const ENV_STORE_PASSWORD = 'ANDROID_KEYSTORE_PASSWORD'
/** 私钥别名，等价于 --key-alias */
const ENV_KEY_ALIAS = 'ANDROID_KEY_ALIAS'
/** 私钥明文口令，等价于 --key-password */
const ENV_KEY_PASSWORD = 'ANDROID_KEY_PASSWORD'

/** BASE64 里的空白（粘贴长内容时常见） */
const BASE64_WHITESPACE = /\s+/g

/** 把字节数写成人看的大小 */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB（${bytes} 字节）`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB（${bytes} 字节）`
  }
  return `${bytes} 字节`
}

/** 只打印前 12 位指纹，用来区分密钥库，不输出内容本身 */
function fingerprint(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 12)
}

/** X.509 的 subject / issuer 是多行 `C=CN\nO=...`，压成一行便于 grep */
function formatDn(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(', ')
}

/** 公钥描述：RSA 带位数、EC 带曲线名，其它算法原样输出 */
function publicKeyDescription(certificate) {
  const key = certificate.publicKey
  const type = key.asymmetricKeyType
  const details = key.asymmetricKeyDetails ?? {}
  if (type === 'rsa') {
    return `RSA ${details.modulusLength ?? '?'} 位`
  }
  if (type === 'ec' || type === 'ecdsa') {
    return details.namedCurve ? `EC ${details.namedCurve}` : 'EC'
  }
  return type ?? '未知'
}

/** 证书时间转 ISO；日期解析失败时退回证书里的原始字符串 */
function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  return date.toISOString()
}

/** 剩余天数；已过期返回「已过期」 */
function remainingDays(validTo) {
  const date = validTo instanceof Date ? validTo : new Date(validTo)
  if (Number.isNaN(date.getTime())) {
    return '有效期未知'
  }
  const days = Math.floor((date.getTime() - Date.now()) / 86400000)
  return days >= 0 ? `剩余 ${days} 天` : '已过期'
}

/** 从 keytool -list 的输出里读密钥库类型；本地化输出也能认 */
function parseKeystoreType(output) {
  const match = /(?:Keystore type|密钥库类型)\s*[:：]\s*(\S+)/i.exec(output)
  return match?.[1]
}

/** 按文件头识别密钥库类型（keytool 输出认不出时的兜底） */
function keystoreTypeFromMagic(buffer) {
  if (buffer.length < 4) {
    return undefined
  }
  if (
    buffer[0] === 0xfe &&
    buffer[1] === 0xed &&
    buffer[2] === 0xfe &&
    buffer[3] === 0xed
  ) {
    return 'JKS'
  }
  if (
    buffer[0] === 0xce &&
    buffer[1] === 0xce &&
    buffer[2] === 0xce &&
    buffer[3] === 0xce
  ) {
    return 'JCEKS'
  }
  if (buffer[0] === 0x30) {
    return 'PKCS12'
  }
  return undefined
}

/**
 * 从 keytool -list 的输出里读第一个 PrivateKeyEntry 的别名。
 * 英文与中文 keytool 都会打印 `PrivateKeyEntry`，别名在第一个逗号前。
 */
function parseAlias(output) {
  for (const line of output.split(/\r?\n/)) {
    if (!/PrivateKeyEntry/.test(line)) {
      continue
    }
    const alias = line.split(',')[0].trim()
    if (alias !== '') {
      return alias
    }
  }
  return undefined
}

/** keytool 可执行文件；允许用 KEYTOOL 覆盖（与 huawei signing-config 一致） */
function keytoolBinary() {
  return process.env.KEYTOOL || 'keytool'
}

/** keytool 是否在 PATH 上 */
function keytoolAvailable() {
  const result = spawnSync(keytoolBinary(), ['-help'], { stdio: 'ignore' })
  return !result.error
}

/** 跑一次 keytool；失败时把 stderr / stdout 一起带回去，便于报错定位 */
function runKeytool(args) {
  const result = spawnSync(keytoolBinary(), args, { encoding: 'utf8' })
  if (result.error) {
    return { ok: false, detail: `调用 ${keytoolBinary()} 失败：${result.error.message}` }
  }
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim() || `退出码 ${result.status}`
    return { ok: false, detail }
  }
  return { ok: true, out: result.stdout }
}

/** 终端里问口令：不回显；Ctrl-C 退出码 130（与 shell 惯例一致） */
function promptHidden(question) {
  return new Promise((resolve) => {
    process.stderr.write(question)
    const stdin = process.stdin
    const wasRaw = stdin.isTTY ? stdin.isRaw : undefined
    if (stdin.isTTY) {
      stdin.setRawMode(true)
    }
    stdin.resume()
    let input = ''
    const cleanup = () => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) {
        stdin.setRawMode(Boolean(wasRaw))
      }
      stdin.pause()
    }
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          cleanup()
          process.stderr.write('\n')
          resolve(input)
          return
        }
        if (char === '\u0003') {
          cleanup()
          process.stderr.write('\n')
          process.exit(130)
        }
        if (char === '\u007f' || char === '\b') {
          input = input.slice(0, -1)
          continue
        }
        input += char
      }
    }
    stdin.on('data', onData)
  })
}

/** keystore 口令：命令行 → 环境变量 → 终端交互（仅 TTY） */
async function resolveStorePassword(options, env, help) {
  const direct = options.get(OPTION_STORE_PASSWORD)
  if (direct !== undefined) {
    return direct
  }
  const fromEnv = readEnv(env, ENV_STORE_PASSWORD)
  if (fromEnv !== undefined) {
    return fromEnv
  }
  if (!process.stdin.isTTY) {
    throw new UsageError(
      `缺少 keystore 口令：请用 ${OPTION_STORE_PASSWORD} 或环境变量 ${ENV_STORE_PASSWORD}` +
        '（非交互环境没有终端可以询问）',
      help,
    )
  }
  const value = await promptHidden('请输入 keystore 口令（明文，不回显）：')
  if (value === '') {
    throw new UsageError('keystore 口令不能为空', help)
  }
  return value
}

/** 解析 BASE64；允许中间有换行，也兼容 URL-safe 的 -_ */
function decodeKeystoreBase64(value, help) {
  const compact = value.replace(BASE64_WHITESPACE, '')
  if (compact === '') {
    throw new UsageError('BASE64 内容为空', help)
  }
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new UsageError('BASE64 内容不合法（只允许 A-Za-z0-9+/= 与换行）', help)
  }
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const buffer = Buffer.from(padded, 'base64')
  if (buffer.length === 0) {
    throw new UsageError('BASE64 解码后是空的，检查内容是否粘贴完整', help)
  }
  if (buffer.toString('base64').replace(/=+$/, '') !== padded.replace(/=+$/, '')) {
    throw new UsageError('BASE64 内容不是规范的编码（解码后重新编码与原文不一致）', help)
  }
  return buffer
}

/** 把 base64 解码出来的密钥库写到目标路径；已存在相同内容则复用，不同则先备份 */
function writeKeystoreFile(outPath, buffer, help) {
  const absolute = path.resolve(outPath)
  if (fs.existsSync(absolute)) {
    if (!fs.statSync(absolute).isFile()) {
      throw new UsageError(`keystore 输出路径不是普通文件: ${outPath}`, help)
    }
    const existing = fs.readFileSync(absolute)
    if (existing.equals(buffer)) {
      return { path: absolute, reused: true }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${absolute}.bak-${stamp}`
    fs.copyFileSync(absolute, backup)
    stderr(`警告: 已有 keystore 不同，已备份到 ${backup}`)
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, buffer, { mode: 0o600 })
  fs.chmodSync(absolute, 0o600)
  return { path: absolute, reused: false }
}

/**
 * 用 keytool 校验一份 keystore：口令、别名、私钥口令，并导出证书。
 * 任何一步失败都直接抛错（不带帮助文档，避免把「口令错误」渲染成用法错误）。
 */
function verifyKeystore(file, buffer, { alias, storePassword, keyPassword }) {
  if (!keytoolAvailable()) {
    throw new Error(
      `找不到 keytool（${keytoolBinary()}）：校验 Android keystore 需要 JDK；` +
        '请把 keytool 放进 PATH，或用 KEYTOOL=/path/to/keytool 指定',
    )
  }
  const list = runKeytool([
    '-list',
    '-keystore',
    file,
    '-storepass',
    storePassword,
  ])
  if (!list.ok) {
    throw new Error(`keystore 口令校验失败（keytool -list）：${list.detail}`)
  }

  const discovered = parseAlias(list.out)
  const usedAlias = alias ?? discovered
  if (usedAlias === undefined) {
    throw new Error(
      'keytool 没有在 keystore 里找到 PrivateKeyEntry（私钥条目）；' +
        '确认这是一份签名 keystore，而不是只放证书的 truststore',
    )
  }

  if (alias !== undefined) {
    const aliasList = runKeytool([
      '-list',
      '-alias',
      alias,
      '-keystore',
      file,
      '-storepass',
      storePassword,
    ])
    if (!aliasList.ok) {
      throw new Error(`别名校验失败（keytool -list -alias ${alias}）：${aliasList.detail}`)
    }
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-apk-keystore-'))
  try {
    const certreq = runKeytool([
      '-certreq',
      '-keystore',
      file,
      '-storepass',
      storePassword,
      '-alias',
      usedAlias,
      '-keypass',
      keyPassword,
      '-file',
      path.join(scratch, 'check.csr'),
    ])
    if (!certreq.ok) {
      throw new Error(`密钥口令校验失败（keytool -certreq 解不开私钥）：${certreq.detail}`)
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }

  const exported = runKeytool([
    '-exportcert',
    '-rfc',
    '-alias',
    usedAlias,
    '-keystore',
    file,
    '-storepass',
    storePassword,
  ])
  if (!exported.ok) {
    throw new Error(`证书导出失败（keytool -exportcert）：${exported.detail}`)
  }
  let certificate
  try {
    certificate = new X509Certificate(exported.out)
  } catch (error) {
    throw new Error(`keytool 导出的证书解析失败：${error.message}`)
  }

  const type = parseKeystoreType(list.out) ?? keystoreTypeFromMagic(buffer) ?? '未知'
  return {
    alias: usedAlias,
    type,
    certificate,
    publicKey: publicKeyDescription(certificate),
    storePasswordOk: true,
    keyPasswordOk: true,
  }
}

/** 字节摘要格式化成 keytool 那种 XX:XX:... 大写形式 */
function formatColonHex(buffer, algorithm) {
  return createHash(algorithm)
    .update(buffer)
    .digest('hex')
    .match(/../g)
    .join(':')
    .toUpperCase()
}

/** 校验结果：一行一条「标签: 值」，便于 grep / awk */
function renderReport(displayPath, buffer, info) {
  const certificate = info.certificate
  const notBefore = certificate.validFromDate ?? certificate.validFrom
  const notAfter = certificate.validToDate ?? certificate.validTo
  return [
    `密钥库: ${displayPath}`,
    `大小: ${formatSize(buffer.length)}`,
    `SHA-256: ${fingerprint(buffer)}（前 12 位）`,
    `类型: ${info.type}`,
    `别名: ${info.alias}`,
    '条目: PrivateKeyEntry（keytool -certreq 已解开私钥）',
    `公钥: ${info.publicKey}`,
    `证书主题: ${formatDn(certificate.subject)}`,
    `证书颁发者: ${formatDn(certificate.issuer)}`,
    `证书序列号: ${certificate.serialNumber}`,
    `证书有效期: ${formatDate(notBefore)} ~ ${formatDate(notAfter)}（${remainingDays(notAfter)}）`,
    `证书 MD5: ${formatColonHex(certificate.raw, 'md5')}`,
    `证书 SHA-256: ${certificate.fingerprint256}`,
    '校验: 通过（keystore 口令 / 别名 / 密钥口令均正确）',
  ].join('\n')
}

/** keystore 命令帮助文档 */
function renderKeystoreHelp() {
  return renderHelp({
    title: `${PROGRAM} ${COMMAND_NAME} - 校验 Android 签名密钥库`,
    usage: [`${PROGRAM} ${COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [
            `${OPTION_FILE} <路径>`,
            `keystore 路径。与 ${OPTION_BASE64} 同用时是解码后的输出路径；单独使用时是输入文件（可用 ${ENV_FILE} / ${ENV_KEYSTORE} 补齐）`,
          ],
          [
            `${OPTION_BASE64} <BASE64>`,
            `keystore 的 BASE64 内容（可用 ${ENV_BASE64} 补齐；内容长，建议只用环境变量）`,
          ],
          [
            `${OPTION_STORE_PASSWORD} <口令>`,
            `keystore 明文口令（可用 ${ENV_STORE_PASSWORD} 补齐；会进入 shell 历史 / ps，建议用环境变量）`,
          ],
          [
            `${OPTION_KEY_ALIAS} <别名>`,
            `私钥别名（可用 ${ENV_KEY_ALIAS} 补齐）；不传时用 keytool -list 自动识别`,
          ],
          [
            `${OPTION_KEY_PASSWORD} <口令>`,
            `私钥明文口令（可用 ${ENV_KEY_PASSWORD} 补齐）；不传时用 keystore 口令`,
          ],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_FILE, `keystore 路径，等价于 ${OPTION_FILE}（${ENV_KEYSTORE} 也可）`],
          [ENV_BASE64, `keystore 的 BASE64 内容，等价于 ${OPTION_BASE64}`],
          [ENV_STORE_PASSWORD, `keystore 明文口令，等价于 ${OPTION_STORE_PASSWORD}`],
          [ENV_KEY_ALIAS, `私钥别名，等价于 ${OPTION_KEY_ALIAS}`],
          [ENV_KEY_PASSWORD, `私钥明文口令，等价于 ${OPTION_KEY_PASSWORD}`],
          ['KEYTOOL', 'keytool 可执行文件，默认 PATH 上的 keytool'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', '校验结果（密钥库 / 大小 / 类型 / 别名 / 公钥 / 证书 / 校验结论），每行一条「标签: 值」'],
          ['stderr', '落盘、备份与警告；口令不会输出'],
          ['退出代码', '0 校验通过；1 参数缺失、参数错误、keytool 校验失败或文件读写失败'],
        ],
      },
    ],
    notes: [
      '说明: 校验依赖 JDK 的 keytool；口令会通过 -storepass / -keypass 传给本地 keytool 进程',
      '说明: 只给 BASE64 时写到临时文件校验，校验完删除；校验通过后才按文件路径落盘',
      '说明: 已存在不同内容的 keystore 会先备份为 <文件>.bak-<时间戳> 再覆盖，权限固定 0600',
      '示例:',
      `  ${PROGRAM} ${COMMAND_NAME} --file ./release.p12 --store-password <口令> --key-alias release`,
      `  ANDROID_KEYSTORE_BASE64="$(openssl base64 -A -in release.p12)" \\`,
      `    ANDROID_KEYSTORE_PASSWORD=<口令> ANDROID_KEY_ALIAS=release \\`,
      `    ${PROGRAM} ${COMMAND_NAME} --file ./release.p12`,
      `  ${PROGRAM} ${COMMAND_NAME} --help`,
    ],
  })
}

/** keystore 命令：解析参数 → 取 BASE64 / 文件 → keytool 校验 →（可选）落盘 → 输出结果 */
async function runKeystore(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderKeystoreHelp())
    return EXIT_OK
  }

  const options = parseOptions(argv, KEYSTORE_OPTIONS, renderKeystoreHelp, KEYSTORE_FLAGS)
  const base64 = options.get(OPTION_BASE64) ?? readEnv(env, ENV_BASE64)
  const fileValue =
    options.get(OPTION_FILE) ?? readEnv(env, ENV_FILE) ?? readEnv(env, ENV_KEYSTORE)
  const alias = options.get(OPTION_KEY_ALIAS) ?? readEnv(env, ENV_KEY_ALIAS)

  if (base64 === undefined && fileValue === undefined) {
    throw new UsageError(
      `缺少 keystore：请用 ${OPTION_FILE} 指定文件，或用 ${OPTION_BASE64} / ${ENV_BASE64} 给 BASE64 内容`,
      renderKeystoreHelp(),
    )
  }

  const storePassword = await resolveStorePassword(options, env, renderKeystoreHelp)
  const keyPassword =
    options.get(OPTION_KEY_PASSWORD) ?? readEnv(env, ENV_KEY_PASSWORD) ?? storePassword

  if (base64 !== undefined) {
    const buffer = decodeKeystoreBase64(base64, renderKeystoreHelp)
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-apk-keystore-'))
    const tempFile = path.join(scratch, 'keystore')
    fs.writeFileSync(tempFile, buffer, { mode: 0o600 })
    try {
      const info = verifyKeystore(tempFile, buffer, { alias, storePassword, keyPassword })
      let displayPath = '（临时文件，校验后已删除）'
      if (fileValue !== undefined) {
        const written = writeKeystoreFile(fileValue, buffer, renderKeystoreHelp())
        displayPath = written.path
        stderr(
          `keystore 已写入: ${written.path}${written.reused ? '（与现有文件相同，复用）' : ''}`,
        )
      }
      stdout(renderReport(displayPath, buffer, info))
      return EXIT_OK
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  }

  const absolute = path.resolve(fileValue)
  if (!fs.existsSync(absolute)) {
    const looksLikeBase64 = /^[A-Za-z0-9+/=_\s]{64,}$/.test(fileValue)
    throw new UsageError(
      looksLikeBase64
        ? `${ENV_KEYSTORE} 看起来是 BASE64，请改用 ${ENV_BASE64} / ${OPTION_BASE64} 传入内容`
        : `keystore 文件不存在: ${fileValue}`,
      renderKeystoreHelp(),
    )
  }
  if (!fs.statSync(absolute).isFile()) {
    throw new UsageError(`keystore 路径不是普通文件: ${fileValue}`, renderKeystoreHelp())
  }
  const buffer = fs.readFileSync(absolute)
  const info = verifyKeystore(absolute, buffer, { alias, storePassword, keyPassword })
  stdout(renderReport(absolute, buffer, info))
  return EXIT_OK
}

/** keystore-gen 帮助文档 */
function renderKeystoreGenHelp() {
  return renderHelp({
    title: `${PROGRAM} ${GEN_COMMAND_NAME} - 快速生成 Android 签名密钥库`,
    usage: [`${PROGRAM} ${GEN_COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [
            `${OPTION_FILE} <路径>`,
            `输出 keystore 路径，后缀不限，默认 ./release.p12（可用 ${ENV_FILE} / ${ENV_KEYSTORE} 补齐）`,
          ],
          [`${OPTION_KEY_ALIAS} <别名>`, `私钥别名，默认 release（可用 ${ENV_KEY_ALIAS} 补齐）`],
          [
            `${OPTION_STORE_PASSWORD} <明文>`,
            `keystore / 私钥口令；至少 6 位。建议用 ${ENV_STORE_PASSWORD} 或交互输入（会进入 keytool 进程参数）`,
          ],
          [`${OPTION_STORE_TYPE} <类型>`, 'keystore 类型：PKCS12（默认）或 JKS'],
          [`${OPTION_KEY_ALGORITHM} <算法>`, '密钥算法，默认 RSA（也可用 EC / DSA）'],
          [`${OPTION_KEY_SIZE} <位数>`, '密钥位数，默认 2048'],
          [`${OPTION_VALIDITY} <天数>`, '证书有效期，默认 10000 天'],
          [
            `${OPTION_DNAME} <DN>`,
            '证书主题，默认 CN=Android Release, OU=Android, O=Android, L=Unknown, ST=Unknown, C=US',
          ],
          [OPTION_FORCE, '目标文件已存在时先备份为 .bak-<时间戳> 再覆盖；默认拒绝覆盖'],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_FILE, `输出 keystore 路径，等价于 ${OPTION_FILE}`],
          [ENV_KEYSTORE, `${ENV_FILE} 的别名`],
          [ENV_KEY_ALIAS, `私钥别名，等价于 ${OPTION_KEY_ALIAS}`],
          [ENV_STORE_PASSWORD, `keystore / 私钥口令，等价于 ${OPTION_STORE_PASSWORD}（推荐）`],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', '生成后的校验报告（文件 / 类型 / 别名 / 公钥 / 证书 / 校验结论）'],
          ['stderr', '生成进度、覆盖前的备份路径与警告；口令不会输出'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '生成并校验通过'],
          ['1', '参数错误、文件已存在（未加 --force）、keytool 失败或校验失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} ${GEN_COMMAND_NAME} --file ./release.p12 --key-alias release`,
      `  ANDROID_KEYSTORE_PASSWORD=<口令> ${PROGRAM} ${GEN_COMMAND_NAME} --file ./release.jks --store-type JKS`,
      `  ${PROGRAM} ${GEN_COMMAND_NAME} --file ./release.p12 --dname "CN=MyApp, OU=Android, O=MyOrg, L=Unknown, ST=Unknown, C=CN"`,
      '',
      '说明: 依赖 JDK 的 keytool；口令会通过 -storepass / -keypass 传给本地 keytool 进程',
      '说明: 生成后会自动用 keytool 校验口令、别名与私钥，并输出校验报告',
      '说明: PKCS12 / JKS 的 keyPassword 均与 storePassword 相同',
      '说明: 目标文件默认 release.p12；后缀不限，类型由 --store-type 决定，不根据后缀推断',
      '说明: 已有文件默认拒绝，--force 会先备份再覆盖',
    ],
  })
}

function validateGenerationPassword(value) {
  if (/[\r\n\0]/.test(value)) {
    throw new UsageError('keystore 口令不能包含换行或 NUL 字符', renderKeystoreGenHelp())
  }
  if ([...value].length < 6) {
    throw new UsageError('keystore 口令至少需要 6 位', renderKeystoreGenHelp())
  }
  return value
}

/** keystore-gen 口令：命令行 → 环境变量 → 两次交互输入 */
async function resolveGenerationPassword(options, env) {
  const direct = options.get(OPTION_STORE_PASSWORD) ?? readEnv(env, ENV_STORE_PASSWORD)
  if (direct !== undefined) {
    return validateGenerationPassword(direct)
  }
  if (!process.stdin.isTTY) {
    throw new UsageError(
      `缺少 keystore 口令：请用 ${OPTION_STORE_PASSWORD} 或环境变量 ${ENV_STORE_PASSWORD}` +
        '（非交互环境没有终端可以询问）',
      renderKeystoreGenHelp(),
    )
  }
  const first = await promptHidden('请输入新 keystore 口令（至少 6 位，不回显）：')
  const second = await promptHidden('请再次输入 keystore 口令：')
  if (first !== second) {
    throw new UsageError('两次输入的 keystore 口令不一致', renderKeystoreGenHelp())
  }
  return validateGenerationPassword(first)
}

function positiveInteger(value, label, min, help) {
  const normalized = String(value).trim()
  if (!/^\d+$/.test(normalized) || Number(normalized) < min) {
    throw new UsageError(`${label}必须是大于等于 ${min} 的整数: ${value}`, help)
  }
  return Number(normalized)
}

function validateDname(value, help) {
  if (value.trim() === '' || /[\r\n\0]/.test(value)) {
    throw new UsageError('dname 不能为空，也不能包含换行或 NUL 字符', help)
  }
  return value
}

async function runKeystoreGen(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderKeystoreGenHelp())
    return EXIT_OK
  }

  const options = parseOptions(argv, GEN_OPTIONS, renderKeystoreGenHelp, GEN_FLAGS)
  const fileValue =
    options.get(OPTION_FILE) ?? readEnv(env, ENV_FILE) ?? readEnv(env, ENV_KEYSTORE) ?? 'release.p12'
  const alias = options.get(OPTION_KEY_ALIAS) ?? readEnv(env, ENV_KEY_ALIAS) ?? 'release'
  if (alias.trim() === '' || /[\r\n\0]/.test(alias)) {
    throw new UsageError('别名不能为空，也不能包含换行或 NUL 字符', renderKeystoreGenHelp())
  }

  const storeType = String(options.get(OPTION_STORE_TYPE) ?? 'PKCS12').toUpperCase()
  if (storeType !== 'PKCS12' && storeType !== 'JKS') {
    throw new UsageError(`不支持的 keystore 类型: ${storeType}（仅支持 PKCS12 / JKS）`, renderKeystoreGenHelp())
  }
  const keyAlgorithm = String(options.get(OPTION_KEY_ALGORITHM) ?? 'RSA').toUpperCase()
  if (!/^[A-Za-z0-9]+$/.test(keyAlgorithm)) {
    throw new UsageError(`密钥算法不合法: ${keyAlgorithm}`, renderKeystoreGenHelp())
  }
  const keySize = positiveInteger(
    options.get(OPTION_KEY_SIZE) ?? '2048',
    '密钥位数',
    256,
    renderKeystoreGenHelp(),
  )
  const validity = positiveInteger(
    options.get(OPTION_VALIDITY) ?? '10000',
    '有效期天数',
    1,
    renderKeystoreGenHelp(),
  )
  const dname = validateDname(
    options.get(OPTION_DNAME) ??
      'CN=Android Release, OU=Android, O=Android, L=Unknown, ST=Unknown, C=US',
    renderKeystoreGenHelp(),
  )
  const force = options.get(OPTION_FORCE) === true
  const password = await resolveGenerationPassword(options, env)

  const absolute = path.resolve(fileValue)
  if (fs.existsSync(absolute)) {
    if (!fs.statSync(absolute).isFile()) {
      throw new UsageError(`keystore 输出路径不是普通文件: ${fileValue}`, renderKeystoreGenHelp())
    }
    if (!force) {
      throw new UsageError(
        `keystore 已存在: ${absolute}；如需覆盖请加 ${OPTION_FORCE}（会先备份）`,
        renderKeystoreGenHelp(),
      )
    }
  }
  if (!keytoolAvailable()) {
    throw new UsageError(
      `找不到 keytool（${keytoolBinary()}）：生成 Android keystore 需要 JDK；` +
        '请安装 JDK 或设置 KEYTOOL 环境变量',
      renderKeystoreGenHelp(),
    )
  }

  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const scratch = fs.mkdtempSync(path.join(path.dirname(absolute), '.keystore-gen-'))
  const tempFile = path.join(scratch, 'keystore')
  try {
    const result = runKeytool([
      '-genkeypair',
      '-noprompt',
      '-keystore',
      tempFile,
      '-storetype',
      storeType,
      '-alias',
      alias,
      '-keyalg',
      keyAlgorithm,
      '-keysize',
      String(keySize),
      '-validity',
      String(validity),
      '-dname',
      dname,
      '-storepass',
      password,
      '-keypass',
      password,
    ])
    if (!result.ok) {
      throw new UsageError(`keytool 生成 keystore 失败: ${result.detail}`, renderKeystoreGenHelp())
    }

    const buffer = fs.readFileSync(tempFile)
    const info = verifyKeystore(tempFile, buffer, {
      alias,
      storePassword: password,
      keyPassword: password,
    })

    if (fs.existsSync(absolute)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backup = `${absolute}.bak-${stamp}`
      fs.copyFileSync(absolute, backup)
      stderr(`警告: 已有 keystore，已备份到 ${backup}`)
    }
    fs.renameSync(tempFile, absolute)
    fs.chmodSync(absolute, 0o600)
    stderr(`keystore 已生成: ${absolute}`)
    stdout(renderReport(absolute, buffer, info))
    return EXIT_OK
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/** shell 单引号安全引用 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** keystore-env 帮助文档 */
function renderKeystoreEnvHelp() {
  return renderHelp({
    title: `${PROGRAM} ${ENV_COMMAND_NAME} - 导出 Android keystore 的 CI 变量`,
    usage: [`${PROGRAM} ${ENV_COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [
            `${OPTION_FILE} <路径>`,
            `keystore 文件路径，必填（可用 ${ENV_FILE} / ${ENV_KEYSTORE} 补齐）`,
          ],
          [
            `${OPTION_STORE_PASSWORD} <明文>`,
            `keystore 明文口令；建议用 ${ENV_STORE_PASSWORD} 或交互输入`,
          ],
          [`${OPTION_KEY_ALIAS} <别名>`, `私钥别名；不传时用 keytool 自动识别（可用 ${ENV_KEY_ALIAS} 补齐）`],
          [
            `${OPTION_KEY_PASSWORD} <明文>`,
            `私钥明文口令；默认与 keystore 口令相同（可用 ${ENV_KEY_PASSWORD} 补齐）`,
          ],
          [
            `${OPTION_FORMAT} <env|shell|json>`,
            '输出格式，默认 env（KEY=value，一行一个）；shell 输出 export KEY=...；json 输出对象',
          ],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_FILE, `keystore 文件路径，等价于 ${OPTION_FILE}`],
          [ENV_KEYSTORE, `${ENV_FILE} 的别名`],
          [ENV_STORE_PASSWORD, `keystore 明文口令，等价于 ${OPTION_STORE_PASSWORD}`],
          [ENV_KEY_ALIAS, `私钥别名，等价于 ${OPTION_KEY_ALIAS}`],
          [ENV_KEY_PASSWORD, `私钥明文口令，等价于 ${OPTION_KEY_PASSWORD}`],
        ],
      },
      {
        title: '输出',
        entries: [
          [
            'stdout',
            'ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD',
          ],
          ['stderr', '明文口令警告与错误信息'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功'],
          ['1', '参数错误、口令 / 别名校验失败或文件读取失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} ${ENV_COMMAND_NAME} --file ./release.p12`,
      `  ANDROID_KEYSTORE_PASSWORD=<口令> ${PROGRAM} ${ENV_COMMAND_NAME} --file ./release.p12 --format shell`,
      `  ${PROGRAM} ${ENV_COMMAND_NAME} --file ./release.p12 --format json > keystore.json`,
      '',
      '警告: 输出包含明文口令，请勿写入日志、提交仓库或公开分享',
      '说明: 生成前会用 keytool 校验 keystore 口令、别名与私钥口令',
      '说明: ANDROID_KEYSTORE_BASE64 是单行 BASE64，可直接配置到 CI 变量',
      '说明: shell 格式用单引号安全转义，可 eval/source；env 格式适合逐项复制到 CI 变量',
    ],
  })
}

function renderKeystoreEnvVariables(buffer, alias, storePassword, keyPassword, format, help) {
  const values = [
    ['ANDROID_KEYSTORE_BASE64', buffer.toString('base64')],
    ['ANDROID_KEYSTORE_PASSWORD', storePassword],
    ['ANDROID_KEY_ALIAS', alias],
    ['ANDROID_KEY_PASSWORD', keyPassword],
  ]
  if (format === 'env') {
    return values.map(([name, value]) => `${name}=${value}`).join('\n')
  }
  if (format === 'shell') {
    return values.map(([name, value]) => `export ${name}=${shellQuote(value)}`).join('\n')
  }
  if (format === 'json') {
    return JSON.stringify(Object.fromEntries(values), null, 2)
  }
  throw new UsageError(`不支持的输出格式: ${format}（仅支持 env / shell / json）`, help)
}

async function runKeystoreEnv(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderKeystoreEnvHelp())
    return EXIT_OK
  }

  const options = parseOptions(argv, ENV_OPTIONS, renderKeystoreEnvHelp, ENV_FLAGS)
  const fileValue =
    options.get(OPTION_FILE) ?? readEnv(env, ENV_FILE) ?? readEnv(env, ENV_KEYSTORE)
  if (fileValue === undefined) {
    throw new UsageError(
      `缺少 keystore：请用 ${OPTION_FILE} 指定文件，或用环境变量 ${ENV_FILE} / ${ENV_KEYSTORE} 补齐`,
      renderKeystoreEnvHelp(),
    )
  }
  const format = String(options.get(OPTION_FORMAT) ?? 'env').trim().toLowerCase()
  if (!['env', 'shell', 'json'].includes(format)) {
    throw new UsageError(`不支持的输出格式: ${format}（仅支持 env / shell / json）`, renderKeystoreEnvHelp())
  }

  const absolute = path.resolve(fileValue)
  if (!fs.existsSync(absolute)) {
    throw new UsageError(`keystore 文件不存在: ${fileValue}`, renderKeystoreEnvHelp())
  }
  if (!fs.statSync(absolute).isFile()) {
    throw new UsageError(`keystore 路径不是普通文件: ${fileValue}`, renderKeystoreEnvHelp())
  }

  const storePassword = await resolveStorePassword(options, env, renderKeystoreEnvHelp)
  const keyPassword =
    options.get(OPTION_KEY_PASSWORD) ?? readEnv(env, ENV_KEY_PASSWORD) ?? storePassword
  if (/[\r\n\0]/.test(storePassword)) {
    throw new UsageError('keystore 口令不能包含换行或 NUL 字符', renderKeystoreEnvHelp())
  }
  if (/[\r\n\0]/.test(keyPassword)) {
    throw new UsageError('密钥口令不能包含换行或 NUL 字符', renderKeystoreEnvHelp())
  }

  const buffer = fs.readFileSync(absolute)
  const info = verifyKeystore(absolute, buffer, {
    alias: options.get(OPTION_KEY_ALIAS) ?? readEnv(env, ENV_KEY_ALIAS),
    storePassword,
    keyPassword,
  })
  stderr('警告: 输出包含明文口令，请勿写入日志、提交仓库或公开分享')
  stdout(
    renderKeystoreEnvVariables(buffer, info.alias, storePassword, keyPassword, format, renderKeystoreEnvHelp()),
  )
  return EXIT_OK
}

export const keystoreEnvCommand = {
  name: ENV_COMMAND_NAME,
  summary: '导出 Android keystore 的 CI 变量（BASE64 / 口令 / 别名）',
  run: runKeystoreEnv,
}

export const keystoreGenCommand = {
  name: GEN_COMMAND_NAME,
  summary: '快速生成 Android 签名密钥库（keytool）',
  run: runKeystoreGen,
}

export const keystoreCommand = {
  name: COMMAND_NAME,
  summary: '校验 Android 签名密钥库与口令 / 别名（BASE64 可落盘）',
  run: runKeystore,
}
