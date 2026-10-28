/**
 * Google Play 命令（`publish-apk google ...`）。
 *
 * 厂商隔离：所有 Google Play 相关的东西都在本模块——
 *   - 命令与帮助文档（google / google access-token / google upload-aab）
 *   - 服务账号鉴权：用完整 JSON 或 client_email/private_key 分项字段本地签发 RS256 JWT，
 *     再换取 OAuth 2.0 access_token
 *   - Android Publisher API v3 的 edits / bundles / tracks 调用
 *
 * 与华为最大的不同是**修改模型**：Android Publisher 的每次发布都发生在一次 edit 里
 * （创建 edit → 上传 bundle → 更新轨道 → commit），只有 commit 之后修改才真正生效。
 * 中途失败时本模块会尽力 delete 这个 edit，避免留下半成品修改。
 *
 * 已支持的行为：
 *   1. node src/publish-apk.js google
 *      输出 google 帮助文档
 *   2. node src/publish-apk.js google access-token [选项]
 *      用服务账号 JSON 换取 access_token，写 stdout，退出代码 0
 *   3. node src/publish-apk.js google upload-aab [选项]
 *      创建 edit → 上传 .aab → （给了 --track 时）更新轨道 → commit，
 *      成功时把 bundle 的 versionCode 写 stdout，退出代码 0
 *
 * 环境变量：每个带值的选项都有同名环境变量兜底（选项优先），见各命令帮助文档；
 * 开关型选项 --verbose 也有环境变量 GOOGLE_VERBOSE（1/true/yes/on 开启、0/false/no/off 关闭）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'

import {
  EXIT_FAILURE,
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
import {
  currentUnixSeconds,
  maskValue,
  normalizePemText,
  signJwt,
} from './jwt.js'

// ------------------------------------------------------------- Google 固定值

/** Android Publisher API 域名；可用 GOOGLE_API_BASE 覆盖（本地联调或代理） */
export const API_BASE = 'https://androidpublisher.googleapis.com'
/** 业务接口路径前缀 */
const API_PATH_PREFIX = '/androidpublisher/v3'
/** 上传接口路径前缀（Google 的媒体上传走 /upload 前缀） */
const UPLOAD_PATH_PREFIX = '/upload/androidpublisher/v3'
/** Android Publisher 需要的 OAuth 2.0 scope */
export const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
/** 服务账号 JSON 里 token_uri 缺失时的默认值 */
export const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
/** 服务账号 JWT 换取 access_token 的 grant_type */
const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
/** 服务账号 JWT 的有效期（秒）：Google 允许最长 1 小时 */
const JWT_LIFETIME_SECONDS = 3600

/** 换取 access_token 的超时（Google 令牌接口通常很快） */
const TOKEN_TIMEOUT_MS = 60_000
/** 普通业务接口的超时 */
const REQUEST_TIMEOUT_MS = 60_000
/** 上传 .aab 的超时：官方建议至少 2 分钟，这里放宽到 10 分钟 */
const UPLOAD_TIMEOUT_MS = 10 * 60_000

/** 应用包名的合法格式：至少两段，每段以字母开头，只含字母、数字、下划线 */
const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/

/** 轨道发布状态（Google Release.status 的全部取值） */
const RELEASE_STATUSES = ['draft', 'inProgress', 'halted', 'completed']
const RELEASE_STATUS_SET = new Set(RELEASE_STATUSES)

// --------------------------------------------------------- 选项名与环境变量名

/** 应用包名（如 com.example.app） */
const OPTION_PACKAGE_NAME = '--package-name'
/** 本地 .aab 文件路径 */
const OPTION_FILE = '--file'
/** 服务账号 JSON 密钥文件路径 */
const OPTION_SERVICE_ACCOUNT = '--service-account'
/** 服务账号 JSON 数据（与文件二选一） */
const OPTION_SERVICE_ACCOUNT_DATA = '--service-account-data'
/** 服务账号 JSON 的 client_email（分项参数，与 --service-account / --service-account-data 互斥） */
const OPTION_CLIENT_EMAIL = '--client-email'
/** 服务账号私钥 PEM 文件路径（分项参数，与 --private-key-data 二选一） */
const OPTION_PRIVATE_KEY = '--private-key'
/** 服务账号私钥 PEM 数据（分项参数，与 --private-key 二选一） */
const OPTION_PRIVATE_KEY_DATA = '--private-key-data'
/** 令牌接口地址（覆盖 JSON 的 token_uri / 默认地址） */
const OPTION_TOKEN_URI = '--token-uri'
/** 已换取的 access_token */
const OPTION_TOKEN = '--token'
/** 发布到哪个轨道（不给则只上传 bundle） */
const OPTION_TRACK = '--track'
/** 轨道发布状态 */
const OPTION_RELEASE_STATUS = '--release-status'
/** 轨道发布名称 */
const OPTION_RELEASE_NAME = '--release-name'
/** 轨道发布说明 */
const OPTION_RELEASE_NOTES = '--release-notes'
/** 发布说明语言（BCP-47，如 zh-CN、en-US） */
const OPTION_RELEASE_NOTES_LANGUAGE = '--release-notes-language'
/** 分阶段发布比例（0 与 1 之间，不含两端） */
const OPTION_USER_FRACTION = '--user-fraction'
/** 开关：提交时 changesNotSentForReview=true（托管发布 / 变更待人工送审） */
const OPTION_CHANGES_NOT_SENT_FOR_REVIEW = '--changes-not-sent-for-review'
/** 开关：输出运行日志 */
const OPTION_VERBOSE = '--verbose'

/** 应用包名，等价于 --package-name */
const ENV_PACKAGE_NAME = 'GOOGLE_PACKAGE_NAME'
/** 本地 .aab 文件路径，等价于 --file */
const ENV_FILE = 'GOOGLE_FILE'
/** 服务账号 JSON 文件路径，等价于 --service-account */
const ENV_SERVICE_ACCOUNT = 'GOOGLE_SERVICE_ACCOUNT'
/** 服务账号 JSON 数据，等价于 --service-account-data */
const ENV_SERVICE_ACCOUNT_DATA = 'GOOGLE_SERVICE_ACCOUNT_DATA'
/** 服务账号 JSON 的 client_email，等价于 --client-email */
const ENV_CLIENT_EMAIL = 'GOOGLE_CLIENT_EMAIL'
/** 服务账号私钥 PEM 文件路径，等价于 --private-key */
const ENV_PRIVATE_KEY = 'GOOGLE_PRIVATE_KEY'
/** 服务账号私钥 PEM 数据，等价于 --private-key-data */
const ENV_PRIVATE_KEY_DATA = 'GOOGLE_PRIVATE_KEY_DATA'
/** access_token，等价于 --token */
const ENV_TOKEN = 'GOOGLE_TOKEN'
/** 轨道名，等价于 --track */
const ENV_TRACK = 'GOOGLE_TRACK'
/** 轨道发布状态，等价于 --release-status */
const ENV_RELEASE_STATUS = 'GOOGLE_RELEASE_STATUS'
/** 轨道发布名称，等价于 --release-name */
const ENV_RELEASE_NAME = 'GOOGLE_RELEASE_NAME'
/** 轨道发布说明，等价于 --release-notes */
const ENV_RELEASE_NOTES = 'GOOGLE_RELEASE_NOTES'
/** 发布说明语言，等价于 --release-notes-language */
const ENV_RELEASE_NOTES_LANGUAGE = 'GOOGLE_RELEASE_NOTES_LANGUAGE'
/** 分阶段发布比例，等价于 --user-fraction */
const ENV_USER_FRACTION = 'GOOGLE_USER_FRACTION'
/** 开关：提交时 changesNotSentForReview=true，等价于 --changes-not-sent-for-review */
const ENV_CHANGES_NOT_SENT_FOR_REVIEW = 'GOOGLE_CHANGES_NOT_SENT_FOR_REVIEW'
/** 开关：输出运行日志，等价于 --verbose */
const ENV_VERBOSE = 'GOOGLE_VERBOSE'
/** 令牌接口地址覆盖项，等价于 --token-uri（默认取服务账号 JSON 的 token_uri） */
const ENV_TOKEN_URI = 'GOOGLE_TOKEN_URI'
/** 接口域名覆盖项（默认 https://androidpublisher.googleapis.com） */
const ENV_API_BASE = 'GOOGLE_API_BASE'

/** google access-token 支持的全部选项 */
const ACCESS_TOKEN_OPTIONS = new Set([
  OPTION_SERVICE_ACCOUNT,
  OPTION_SERVICE_ACCOUNT_DATA,
  OPTION_CLIENT_EMAIL,
  OPTION_PRIVATE_KEY,
  OPTION_PRIVATE_KEY_DATA,
  OPTION_TOKEN_URI,
  OPTION_VERBOSE,
])
/** google access-token 中的开关型选项 */
const ACCESS_TOKEN_FLAGS = new Set([OPTION_VERBOSE])

/** google upload-aab 支持的全部选项 */
const UPLOAD_AAB_OPTIONS = new Set([
  OPTION_PACKAGE_NAME,
  OPTION_FILE,
  OPTION_SERVICE_ACCOUNT,
  OPTION_SERVICE_ACCOUNT_DATA,
  OPTION_CLIENT_EMAIL,
  OPTION_PRIVATE_KEY,
  OPTION_PRIVATE_KEY_DATA,
  OPTION_TOKEN_URI,
  OPTION_TOKEN,
  OPTION_TRACK,
  OPTION_RELEASE_STATUS,
  OPTION_RELEASE_NAME,
  OPTION_RELEASE_NOTES,
  OPTION_RELEASE_NOTES_LANGUAGE,
  OPTION_USER_FRACTION,
  OPTION_CHANGES_NOT_SENT_FOR_REVIEW,
  OPTION_VERBOSE,
])
/** google upload-aab 中的开关型选项 */
const UPLOAD_AAB_FLAGS = new Set([
  OPTION_CHANGES_NOT_SENT_FOR_REVIEW,
  OPTION_VERBOSE,
])

// -------------------------------------------------------------- 开关型参数

/** 开关型环境变量里代表「开启」的取值（大小写、首尾空白不敏感） */
const SWITCH_TRUE = new Set(['1', 'true', 'yes', 'on'])
/** 开关型环境变量里代表「关闭」的取值；空串由 readEnv 归为「未设置」 */
const SWITCH_FALSE = new Set(['0', 'false', 'no', 'off'])

/**
 * 开关型选项的取值来源：命令行选项优先，其次同名环境变量。
 *
 * 环境变量的值只认白名单：真值开启、假值关闭、其它值报用法错误。
 * 这样 `GOOGLE_VERBOSE=0` 会真的关闭日志，而无法识别的值不会悄悄吞掉排查信息。
 */
function resolveSwitch(options, env, option, envName, help) {
  if (options.has(option)) {
    return true
  }
  const raw = readEnv(env, envName)
  if (raw === undefined) {
    return false
  }
  const value = raw.trim().toLowerCase()
  if (SWITCH_TRUE.has(value)) {
    return true
  }
  if (SWITCH_FALSE.has(value)) {
    return false
  }
  throw new UsageError(
    `环境变量 ${envName} 的取值无法识别: "${raw}"（可用 1/true/yes/on 或 0/false/no/off）`,
    help(),
  )
}

/** --verbose / GOOGLE_VERBOSE */
function resolveVerbose(options, env, help) {
  return resolveSwitch(options, env, OPTION_VERBOSE, ENV_VERBOSE, help)
}

// -------------------------------------------------------------- 服务账号读取

/**
 * 服务账号来源在错误信息与日志里的展示文本。
 *
 * JSON 数据本身就是凭证：绝不打字面量、也不做「几千个星号」的掩码，只保留字符数；
 * 文件路径同样属于敏感信息，用 maskValue 掩码（如 /Use*****.json）。
 */
function describeServiceAccountSource(value) {
  if (/[{[\r\n]/.test(value) || value.length > 120) {
    return `(已省略，共 ${value.length} 字符)`
  }
  return maskValue(value)
}

/** 分项参数：与服务账号 JSON 二选一（--token-uri 是独立覆盖项，不参与互斥判断） */
const SERVICE_ACCOUNT_FIELD_OPTIONS = [
  OPTION_CLIENT_EMAIL,
  OPTION_PRIVATE_KEY,
  OPTION_PRIVATE_KEY_DATA,
]

/** 服务账号分项参数在错误信息与日志里的展示文本（私钥数据整体省略） */
function describePrivateKeySource(value) {
  if (value.includes('-----BEGIN') || /[\r\n]/.test(value) || value.length > 120) {
    return `(已省略，共 ${value.length} 字符)`
  }
  return maskValue(value)
}

/** 命令行是否显式给出了服务账号 JSON 参数 */
function hasServiceAccountJsonOptions(options) {
  return options.has(OPTION_SERVICE_ACCOUNT) || options.has(OPTION_SERVICE_ACCOUNT_DATA)
}

/** 命令行是否显式给出了服务账号分项参数 */
function hasServiceAccountFieldOptions(options) {
  return SERVICE_ACCOUNT_FIELD_OPTIONS.some((name) => options.has(name))
}

/** 命令行是否显式给出了任一种服务账号凭据（JSON 或分项） */
function hasServiceAccountOptions(options) {
  return hasServiceAccountJsonOptions(options) || hasServiceAccountFieldOptions(options)
}

/** 环境变量里是否已有服务账号凭据（JSON 或分项，任一） */
function hasEnvServiceAccount(env) {
  return (
    readEnv(env, ENV_SERVICE_ACCOUNT) !== undefined ||
    readEnv(env, ENV_SERVICE_ACCOUNT_DATA) !== undefined ||
    readEnv(env, ENV_CLIENT_EMAIL) !== undefined ||
    readEnv(env, ENV_PRIVATE_KEY) !== undefined ||
    readEnv(env, ENV_PRIVATE_KEY_DATA) !== undefined
  )
}

/** 「需要哪些凭据」的统一提示文案（access-token 与 upload-aab 共用） */
function serviceAccountMissingHint() {
  return (
    `${OPTION_SERVICE_ACCOUNT}（JSON 文件）、${OPTION_SERVICE_ACCOUNT_DATA}（JSON 数据），` +
    `或分项参数 ${OPTION_CLIENT_EMAIL} + ${OPTION_PRIVATE_KEY}/${OPTION_PRIVATE_KEY_DATA}；` +
    `可用环境变量 ${ENV_SERVICE_ACCOUNT} / ${ENV_SERVICE_ACCOUNT_DATA} / ${ENV_CLIENT_EMAIL} / ` +
    `${ENV_PRIVATE_KEY} / ${ENV_PRIVATE_KEY_DATA}`
  )
}

/**
 * 收集命令行/环境变量里的分项凭据（client_email + 私钥）。
 *
 * 规则与 huawei 模块一致：
 *   - 命令行给了私钥来源（--private-key 或 --private-key-data）时，完全忽略环境变量里的私钥来源；
 *     同时给出两者属于明确误用，报错。
 *   - 命令行没给私钥时用环境变量；环境变量层两者都在时「数据优先」并提示
 *     （变量改名后旧的 .env 可能只留下其中一个变量，硬报错会让命令直接不可用）。
 *   - client_email 单独按「选项优先、环境变量兜底」处理，便于与私钥来自不同来源。
 */
function collectServiceAccountFields(options, env) {
  const clientEmail = options.get(OPTION_CLIENT_EMAIL) ?? readEnv(env, ENV_CLIENT_EMAIL)
  const clientEmailOrigin = options.has(OPTION_CLIENT_EMAIL)
    ? OPTION_CLIENT_EMAIL
    : `${ENV_CLIENT_EMAIL} 环境变量`

  const pathOption = options.get(OPTION_PRIVATE_KEY)
  const dataOption = options.get(OPTION_PRIVATE_KEY_DATA)
  if (pathOption !== undefined && dataOption !== undefined) {
    return {
      clientEmail,
      clientEmailOrigin,
      conflict: `选项 "${OPTION_PRIVATE_KEY}" 与 "${OPTION_PRIVATE_KEY_DATA}" 不能同时使用`,
    }
  }

  if (pathOption !== undefined || dataOption !== undefined) {
    return {
      clientEmail,
      clientEmailOrigin,
      privateKeyPath: pathOption,
      privateKeyPathOrigin: OPTION_PRIVATE_KEY,
      privateKeyData: dataOption,
      privateKeyDataOrigin: OPTION_PRIVATE_KEY_DATA,
    }
  }

  const envPath = readEnv(env, ENV_PRIVATE_KEY)
  const envData = readEnv(env, ENV_PRIVATE_KEY_DATA)
  if (envPath !== undefined && envData !== undefined) {
    stderr(
      `提示: 环境变量 ${ENV_PRIVATE_KEY} 与 ${ENV_PRIVATE_KEY_DATA} 同时存在，本次使用 ` +
        `${ENV_PRIVATE_KEY_DATA}（私钥数据）；如需改用私钥文件请传 ${OPTION_PRIVATE_KEY}，` +
        `或执行 unset ${ENV_PRIVATE_KEY}`,
    )
    return {
      clientEmail,
      clientEmailOrigin,
      privateKeyPathOrigin: `${ENV_PRIVATE_KEY} 环境变量`,
      privateKeyData: envData,
      privateKeyDataOrigin: `${ENV_PRIVATE_KEY_DATA} 环境变量`,
    }
  }

  return {
    clientEmail,
    clientEmailOrigin,
    privateKeyPath: envPath,
    privateKeyPathOrigin: `${ENV_PRIVATE_KEY} 环境变量`,
    privateKeyData: envData,
    privateKeyDataOrigin: `${ENV_PRIVATE_KEY_DATA} 环境变量`,
  }
}

/**
 * 收集服务账号来源（只定位来源，不读取、不解析，便于把「缺失」与其它必填项合并成一条提示）。
 *
 * 优先级（高 → 低）：
 *   1. 命令行 JSON 参数（--service-account / --service-account-data）—— 完整 JSON
 *   2. 命令行分项参数（--client-email + --private-key/--private-key-data）
 *   3. 环境变量 JSON（GOOGLE_SERVICE_ACCOUNT / GOOGLE_SERVICE_ACCOUNT_DATA）
 *   4. 环境变量分项（GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY/GOOGLE_PRIVATE_KEY_DATA）
 *
 * 命令行同时给出 JSON 与分项参数属于明确误用，报错；命令行给了 JSON 时不再读取环境变量。
 * 环境变量层 JSON 与分项同时存在时「JSON 优先」并提示。
 *
 * @returns {null | { kind: 'json', path?: string, pathOrigin: string, data?: string, dataOrigin: string }
 *   | { kind: 'fields', clientEmail?: string, clientEmailOrigin: string, privateKeyPath?: string,
 *       privateKeyPathOrigin: string, privateKeyData?: string, privateKeyDataOrigin: string }}
 */
function collectServiceAccountSource(options, env, help) {
  const usesJsonOptions = hasServiceAccountJsonOptions(options)
  const usesFieldOptions = hasServiceAccountFieldOptions(options)

  if (usesJsonOptions && usesFieldOptions) {
    throw new UsageError(
      `选项 "${OPTION_SERVICE_ACCOUNT}" / "${OPTION_SERVICE_ACCOUNT_DATA}" 与分项参数 ` +
        `"${OPTION_CLIENT_EMAIL}" / "${OPTION_PRIVATE_KEY}" / "${OPTION_PRIVATE_KEY_DATA}" 不能同时使用`,
      help(),
    )
  }

  if (usesJsonOptions) {
    const pathOption = options.get(OPTION_SERVICE_ACCOUNT)
    const dataOption = options.get(OPTION_SERVICE_ACCOUNT_DATA)
    if (pathOption !== undefined && dataOption !== undefined) {
      throw new UsageError(
        `选项 "${OPTION_SERVICE_ACCOUNT}" 与 "${OPTION_SERVICE_ACCOUNT_DATA}" 不能同时使用`,
        help(),
      )
    }
    return {
      kind: 'json',
      path: pathOption,
      pathOrigin: OPTION_SERVICE_ACCOUNT,
      data: dataOption,
      dataOrigin: OPTION_SERVICE_ACCOUNT_DATA,
    }
  }

  if (usesFieldOptions) {
    const fields = collectServiceAccountFields(options, env)
    if (fields.conflict !== undefined) {
      throw new UsageError(fields.conflict, help())
    }
    return { kind: 'fields', ...fields }
  }

  const path = readEnv(env, ENV_SERVICE_ACCOUNT)
  const data = readEnv(env, ENV_SERVICE_ACCOUNT_DATA)
  const envFieldsPresent = [
    ENV_CLIENT_EMAIL,
    ENV_PRIVATE_KEY,
    ENV_PRIVATE_KEY_DATA,
  ].some((name) => readEnv(env, name) !== undefined)

  if (path !== undefined || data !== undefined) {
    if (path !== undefined && data !== undefined) {
      stderr(
        `提示: 环境变量 ${ENV_SERVICE_ACCOUNT} 与 ${ENV_SERVICE_ACCOUNT_DATA} 同时存在，本次使用 ` +
          `${ENV_SERVICE_ACCOUNT_DATA}（JSON 数据）；如需改用密钥文件请传 ${OPTION_SERVICE_ACCOUNT}，` +
          `或执行 unset ${ENV_SERVICE_ACCOUNT}`,
      )
    } else if (envFieldsPresent) {
      stderr(
        `提示: 环境变量同时提供了服务账号 JSON 与分项字段，本次使用完整 JSON；` +
          `如需改用分项字段请执行 unset ${ENV_SERVICE_ACCOUNT} ${ENV_SERVICE_ACCOUNT_DATA}`,
      )
    }
    return {
      kind: 'json',
      path: data === undefined ? path : undefined,
      pathOrigin: `${ENV_SERVICE_ACCOUNT} 环境变量`,
      data,
      dataOrigin: `${ENV_SERVICE_ACCOUNT_DATA} 环境变量`,
    }
  }

  if (envFieldsPresent) {
    return { kind: 'fields', ...collectServiceAccountFields(options, env) }
  }

  return null
}

/**
 * 读取并校验服务账号 JSON，返回换取令牌需要的字段。
 *
 * 校验失败一律是用法错误（附帮助文档），错误信息里只含字段名与路径的掩码，
 * 绝不回显 JSON 内容或 private_key。
 *
 * @returns {{ clientEmail: string, privateKey: string, tokenUri: string, projectId?: string, privateKeyId?: string, description: string }}
 */
function loadServiceAccountJson({ path, pathOrigin, data, dataOrigin }, help) {
  let text
  let description
  if (data !== undefined) {
    text = data
    description = dataOrigin
  } else {
    const shown = describeServiceAccountSource(path)
    if (path.trimStart().startsWith('{')) {
      // JSON 数据被当成文件路径：只提示该改用哪个来源，绝不回显数据
      throw new UsageError(
        `服务账号文件路径无效: ${shown}（来自 ${pathOrigin}）；该值是 JSON 数据，请改用 ` +
          `${OPTION_SERVICE_ACCOUNT_DATA} 或环境变量 ${ENV_SERVICE_ACCOUNT_DATA}`,
        help(),
      )
    }
    if (!existsSync(path)) {
      throw new UsageError(`服务账号文件不存在: ${shown}（来自 ${pathOrigin}）`, help())
    }
    let stats
    try {
      stats = statSync(path)
    } catch (error) {
      throw new UsageError(
        `读取服务账号文件失败: ${shown}（${error.code ?? '未知错误'}）`,
        help(),
      )
    }
    if (!stats.isFile()) {
      throw new UsageError(`不是普通文件: ${shown}（来自 ${pathOrigin}）`, help())
    }
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      throw new UsageError(
        `读取服务账号文件失败: ${shown}（${error.code ?? '未知错误'}）`,
        help(),
      )
    }
    description = `文件 ${shown}（来自 ${pathOrigin}）`
  }

  let json
  try {
    json = JSON.parse(text)
  } catch {
    // 故意不展示 JSON.parse 的错误信息：新版 Node 会在错误里带上输入片段，
    // 而输入是服务账号 JSON（含私钥），只能整体省略，只提示怎么自查。
    throw new UsageError(
      `服务账号 JSON 解析失败（${description}）: 不是合法 JSON，` +
        `请用 jq . 校验密钥文件是否完整`,
      help(),
    )
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new UsageError(`服务账号 JSON 内容无效（${description}）: 顶层必须是对象`, help())
  }
  if (json.type !== undefined && json.type !== 'service_account') {
    throw new UsageError(
      `服务账号 JSON 的 type 不是 "service_account"（实际为 "${json.type}"）: ${description}`,
      help(),
    )
  }

  const clientEmail = json.client_email
  if (typeof clientEmail !== 'string' || clientEmail.trim() === '') {
    throw new UsageError(
      `服务账号 JSON 缺少 client_email 字段（${description}）；请在 Google Cloud 控制台重新下载 JSON 密钥`,
      help(),
    )
  }

  const privateKeyText = json.private_key
  if (typeof privateKeyText !== 'string' || privateKeyText === '') {
    throw new UsageError(
      `服务账号 JSON 缺少 private_key 字段（${description}）；请在 Google Cloud 控制台重新下载 JSON 密钥`,
      help(),
    )
  }
  // JSON 里的 \n 会被 JSON.parse 还原成真实换行；这里再兜底处理被双重转义的 PEM
  const privateKey = normalizePemText(privateKeyText)
  if (!privateKey.includes('-----BEGIN')) {
    throw new UsageError(
      `服务账号 JSON 的 private_key 不是 PEM 数据（${description}，缺少 "-----BEGIN"）`,
      help(),
    )
  }

  const tokenUri =
    typeof json.token_uri === 'string' && json.token_uri !== '' ? json.token_uri : DEFAULT_TOKEN_URI

  return {
    clientEmail,
    privateKey,
    tokenUri,
    projectId: typeof json.project_id === 'string' ? json.project_id : undefined,
    privateKeyId: typeof json.private_key_id === 'string' ? json.private_key_id : undefined,
    description,
  }
}

/**
 * 读取并校验分项凭据（client_email + PEM 私钥）。
 *
 * 这是「把服务账号 JSON 里的属性拆开传」的入口，字段与 JSON 的对应关系：
 *   client_email → --client-email / GOOGLE_CLIENT_EMAIL
 *   private_key  → --private-key-data / GOOGLE_PRIVATE_KEY_DATA（或存成 PEM 文件用 --private-key）
 *   token_uri    → --token-uri / GOOGLE_TOKEN_URI（可选，默认 oauth2.googleapis.com）
 * project_id、private_key_id 不参与 RS256 JWT 鉴权，因此不需要传。
 *
 * 校验失败一律是用法错误（附帮助文档）；错误信息只含路径的掩码，私钥数据永不回显。
 *
 * @returns {{ clientEmail: string, privateKey: string, tokenUri: string, description: string }}
 */
function loadServiceAccountFields(
  {
    clientEmail,
    clientEmailOrigin,
    privateKeyPath,
    privateKeyPathOrigin,
    privateKeyData,
    privateKeyDataOrigin,
  },
  help,
) {
  const missing = []
  if (clientEmail === undefined || clientEmail.trim() === '') {
    missing.push(`${OPTION_CLIENT_EMAIL}（client_email），可用环境变量 ${ENV_CLIENT_EMAIL}`)
  }
  if (privateKeyPath === undefined && privateKeyData === undefined) {
    missing.push(
      `${OPTION_PRIVATE_KEY}（PEM 文件）或 ${OPTION_PRIVATE_KEY_DATA}（PEM 数据），` +
        `可用环境变量 ${ENV_PRIVATE_KEY} / ${ENV_PRIVATE_KEY_DATA}`,
    )
  }
  if (missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${missing.join('；')}`, help())
  }
  if (privateKeyPath !== undefined && privateKeyData !== undefined) {
    throw new UsageError(
      `选项 "${OPTION_PRIVATE_KEY}" 与 "${OPTION_PRIVATE_KEY_DATA}" 不能同时使用`,
      help(),
    )
  }

  let privateKeyText
  let privateKeyDescription
  if (privateKeyData !== undefined) {
    privateKeyText = privateKeyData
    privateKeyDescription = privateKeyDataOrigin
  } else {
    const shown = describePrivateKeySource(privateKeyPath)
    if (privateKeyPath.includes('-----BEGIN')) {
      throw new UsageError(
        `私钥路径无效: ${shown}（来自 ${privateKeyPathOrigin}）；该值是 PEM 数据，请改用 ` +
          `${OPTION_PRIVATE_KEY_DATA} 或环境变量 ${ENV_PRIVATE_KEY_DATA}`,
        help(),
      )
    }
    if (!existsSync(privateKeyPath)) {
      throw new UsageError(`私钥文件不存在: ${shown}（来自 ${privateKeyPathOrigin}）`, help())
    }
    let stats
    try {
      stats = statSync(privateKeyPath)
    } catch (error) {
      throw new UsageError(
        `读取私钥文件失败: ${shown}（${error.code ?? '未知错误'}）`,
        help(),
      )
    }
    if (!stats.isFile()) {
      throw new UsageError(`不是普通文件: ${shown}（来自 ${privateKeyPathOrigin}）`, help())
    }
    try {
      privateKeyText = readFileSync(privateKeyPath, 'utf8')
    } catch (error) {
      throw new UsageError(
        `读取私钥文件失败: ${shown}（${error.code ?? '未知错误'}）`,
        help(),
      )
    }
    privateKeyDescription = `文件 ${shown}（来自 ${privateKeyPathOrigin}）`
  }

  // 文件与环境变量都可能因 shell 转义留下字面量 \n，这里统一还原
  const privateKey = normalizePemText(privateKeyText)
  if (!privateKey.includes('-----BEGIN')) {
    throw new UsageError(
      `私钥内容无效: ${privateKeyDescription}（缺少 PEM 头 "-----BEGIN"）`,
      help(),
    )
  }

  return {
    clientEmail,
    privateKey,
    tokenUri: DEFAULT_TOKEN_URI,
    description: `分项参数（client_email 来自 ${clientEmailOrigin}，私钥来自 ${privateKeyDescription}）`,
  }
}

/** 按来源类型读取并校验服务账号凭据 */
function loadServiceAccount(source, help) {
  return source.kind === 'json'
    ? loadServiceAccountJson(source, help)
    : loadServiceAccountFields(source, help)
}

// ---------------------------------------------------------- Google 响应处理

/**
 * 从 Google 的错误响应里整理出可读信息。
 *
 * 两类错误体：
 *   - OAuth 令牌接口：{ "error": "invalid_grant", "error_description": "…" }
 *   - 业务接口：{ "error": { "code": 403, "message": "…", "status": "PERMISSION_DENIED",
 *                            "errors": [{ "reason": "…", "message": "…" }] } }
 * 解析不出来时退回响应原文（截断），至少保留状态码与一小段响应体便于排查。
 */
function describeGoogleError(text) {
  if (text === '') {
    return '（响应体为空）'
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return text.slice(0, 300)
  }
  const error = parsed?.error
  if (typeof error === 'string') {
    const description = parsed?.error_description
    return typeof description === 'string' && description !== ''
      ? `${error}: ${description}`
      : error
  }
  if (error !== null && typeof error === 'object') {
    const reason = Array.isArray(error.errors)
      ? error.errors.find((item) => typeof item?.reason === 'string')?.reason
      : undefined
    const message = typeof error.message === 'string' ? error.message : error.status
    const detail = [message, reason === undefined ? undefined : `reason=${reason}`]
      .filter((item) => typeof item === 'string' && item !== '')
      .join('；')
    return detail === '' ? text.slice(0, 300) : detail
  }
  if (typeof parsed?.message === 'string') {
    return parsed.message
  }
  return text.slice(0, 300)
}

/**
 * 解析 Google 接口响应，统一处理三类失败（各接口共用）。
 *
 *   1. HTTP 非 2xx —— 网关或服务层拒绝
 *   2. HTTP 2xx 但响应体非 JSON —— 正常业务响应一定是 JSON
 *   3. 成功响应体为空 —— DELETE edit 返回 204，属于正常情况，回传 {}
 *
 * @param {Response} response fetch 响应
 * @param {string} text 已读取的响应体
 * @param {string} target 请求地址（含域名），用于错误信息里定位
 */
function parseGoogleResponse(response, text, target) {
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} @ ${target}: ${describeGoogleError(text)}`,
    )
  }
  if (text === '') {
    return {}
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`响应不是合法 JSON（HTTP ${response.status}）: ${text.slice(0, 200)}`)
  }
}

/** 请求地址：失败信息里带上完整地址，便于按域名/路径排查 */
function apiUrl(apiBase, prefix, path) {
  return `${apiBase}${prefix}${path}`
}

/**
 * 调 Android Publisher 的普通（非上传）接口。
 *
 * @param {{ token: string, apiBase: string, method: string, path: string, body?: object, timeoutMs?: number }} params
 * @returns {Promise<object>} 解析后的 JSON；空响应体回传 {}
 */
async function callAndroidPublisher({
  token,
  apiBase,
  method,
  path,
  body,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const url = apiUrl(apiBase, API_PATH_PREFIX, path)
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`请求 ${url} 失败: ${error.message}`)
  }

  const text = await response.text()
  return parseGoogleResponse(response, text, url)
}

/**
 * 用服务账号换取 access_token（OAuth 2.0 JWT Bearer 流程）。
 *
 *   POST {token_uri}
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<RS256 JWT>
 *
 * JWT 载荷固定为 { iss: client_email, scope, aud: token_uri, iat, exp }，
 * 这是 Google 服务账号「无用户交互」换取令牌的标准写法，不需要 kid（由私钥签名定位密钥）。
 *
 * @param {{ clientEmail: string, privateKey: string, tokenUri?: string, scope?: string, timeoutMs?: number }} params
 * @returns {Promise<object>} 令牌接口原始响应：{ access_token, token_type, expires_in, … }
 */
export async function fetchServiceAccountAccessToken({
  clientEmail,
  privateKey,
  tokenUri = DEFAULT_TOKEN_URI,
  scope = ANDROID_PUBLISHER_SCOPE,
  timeoutMs = TOKEN_TIMEOUT_MS,
}) {
  const iat = currentUnixSeconds()
  const assertion = signJwt({
    header: { alg: 'RS256', typ: 'JWT' },
    claims: {
      iss: clientEmail,
      scope,
      aud: tokenUri,
      iat,
      exp: iat + JWT_LIFETIME_SECONDS,
    },
    privateKey,
    algorithm: 'RS256',
  })

  const form = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion,
  })

  let response
  try {
    response = await fetch(tokenUri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`请求 ${tokenUri} 失败: ${error.message}`)
  }

  const text = await response.text()
  return parseGoogleResponse(response, text, tokenUri)
}

// ------------------------------------------------------------ Token 解析

/** --token 模式下日志里展示的来源名（区分命令行与环境变量） */
function tokenOptionSource(options) {
  return options.get(OPTION_TOKEN) !== undefined ? OPTION_TOKEN : `${ENV_TOKEN} 环境变量`
}

/**
 * 决定这次用哪种 Token 来源（不发起任何网络请求，便于先与其他必填项一起报缺失）。
 *
 * 来源优先级（高 → 低）与 huawei 模块保持一致：
 *   1. 命令行显式给出的服务账号参数（--service-account / --service-account-data）
 *      —— 本地换取 access_token
 *   2. --token（或环境变量 GOOGLE_TOKEN）—— 直接使用已换取的 access_token
 *   3. 环境变量里已有的服务账号凭证 —— 本地换取 access_token
 *
 * @returns {{ missing: string[] } | { kind: 'token', token: string, source: string } | { kind: 'service-account', source: string }}
 */
function planAccessToken(options, env) {
  const token = options.get(OPTION_TOKEN) ?? readEnv(env, ENV_TOKEN)
  const usesOptions = hasServiceAccountOptions(options)

  if (!usesOptions && token === undefined && !hasEnvServiceAccount(env)) {
    return {
      missing: [
        `${OPTION_TOKEN}（access_token），或服务账号凭据（本地换取 access_token）：` +
          serviceAccountMissingHint(),
      ],
    }
  }

  if (usesOptions || token === undefined) {
    return {
      kind: 'service-account',
      source: usesOptions ? 'service-account 参数（本地换取）' : '环境变量凭证（本地换取）',
    }
  }

  return { kind: 'token', token, source: tokenOptionSource(options) }
}

/** --verbose 时打印令牌换取结果（Token、client_email 只打印掩码，私钥永不写入日志） */
function logAccessTokenDetails({ tokenUri, account, data, token }) {
  stderr('已换取 access_token')
  stderr(`  请求地址:      POST ${tokenUri}`)
  stderr(`  服务账号:      ${maskValue(account.clientEmail)}`)
  if (account.privateKeyId !== undefined) {
    stderr(`  私钥 ID:       ${maskValue(account.privateKeyId)}`)
  }
  if (account.projectId !== undefined) {
    stderr(`  项目:          ${account.projectId}`)
  }
  stderr(`  scope:         ${ANDROID_PUBLISHER_SCOPE}`)
  stderr(`  服务账号来源:  ${account.description}`)
  stderr(`  Token:         ${maskValue(token)}`)
  // 这两个字段 Google 不一定都返回，缺哪个就不打印哪个，避免噪音
  if (data.token_type !== undefined) {
    stderr(`  token_type:    ${data.token_type}`)
  }
  if (data.expires_in !== undefined) {
    stderr(`  expires_in:    ${data.expires_in} 秒`)
  }
}

/**
 * 用服务账号换取 access_token，失败时打印错误日志并回传 null。
 *
 * @returns {Promise<{ token: string, account: object } | null>}
 */
async function exchangeAccessToken({ options, env, help, verbose }) {
  const source = collectServiceAccountSource(options, env, help)
  if (source === null) {
    // 调用方已检查过凭据是否存在；这里兜底，避免空来源进入加载器
    throw new UsageError(`缺少必填参数: ${serviceAccountMissingHint()}`, help())
  }
  const account = loadServiceAccount(source, help)
  // 地址优先级：--token-uri > GOOGLE_TOKEN_URI > JSON 的 token_uri > 默认地址
  const tokenUri =
    options.get(OPTION_TOKEN_URI) ?? readEnv(env, ENV_TOKEN_URI) ?? account.tokenUri

  let data
  try {
    data = await fetchServiceAccountAccessToken({
      clientEmail: account.clientEmail,
      privateKey: account.privateKey,
      tokenUri,
    })
  } catch (error) {
    // 网络/接口失败属于运行期问题，不是用法问题，所以只报错不打印帮助文档
    stderr(`错误: 换取 access_token 失败: ${error.message}`)
    return null
  }

  const token = data?.access_token
  if (typeof token !== 'string' || token === '') {
    stderr('错误: 换取 access_token 失败: 响应中未包含 access_token')
    return null
  }

  if (verbose) {
    logAccessTokenDetails({ tokenUri, account, data, token })
  }
  return { token, account }
}

// --------------------------------------------------------- 文件与参数校验

/**
 * 本地文件大小（字节），同时承担路径校验。
 *
 * 与 huawei 模块的规则一致：不存在、不是普通文件、大小超出安全整数范围都抛用法错误。
 * 待上传的文件路径本身不是凭证，错误信息里完整给出，便于定位。
 */
function localFileSize(path, origin, help) {
  if (!existsSync(path)) {
    throw new UsageError(`文件不存在: ${path}（来自 ${origin}）`, help())
  }
  const stats = statSync(path)
  if (!stats.isFile()) {
    throw new UsageError(`不是普通文件: ${path}（来自 ${origin}）`, help())
  }
  if (!Number.isSafeInteger(stats.size)) {
    throw new UsageError(`文件大小超出可表示范围: ${path}（来自 ${origin}）`, help())
  }
  return stats.size
}

/** 取文件名的后缀（最后一个 "." 之后的部分，大小写不敏感）；没有 "." 时返回空串 */
function fileSuffix(fileName) {
  const index = fileName.lastIndexOf('.')
  return index === -1 ? '' : fileName.slice(index + 1).toLowerCase()
}

/**
 * 收集 google upload-aab 的参数（选项优先，其次环境变量）。
 *
 * 缺失项不在这里抛错，而是回传 missing：调用方要把它与「Token 来源缺失」合并成一条错误信息。
 *
 * @returns {{
 *   packageName?: string, file?: string, fileOrigin: string, track?: string, releaseStatus?: string,
 *   releaseName?: string, releaseNotes?: string, releaseNotesLanguage?: string,
 *   userFraction?: string, missing: string[]
 * }}
 */
function collectUploadAabParams(options, env) {
  const packageName = options.get(OPTION_PACKAGE_NAME) ?? readEnv(env, ENV_PACKAGE_NAME)
  const file = options.get(OPTION_FILE) ?? readEnv(env, ENV_FILE)
  // 供文件相关的错误信息标注来源：命令行给出时是 --file，否则是环境变量
  const fileOrigin = options.has(OPTION_FILE) ? OPTION_FILE : `${ENV_FILE} 环境变量`
  const track = options.get(OPTION_TRACK) ?? readEnv(env, ENV_TRACK)
  const releaseStatus = options.get(OPTION_RELEASE_STATUS) ?? readEnv(env, ENV_RELEASE_STATUS)
  const releaseName = options.get(OPTION_RELEASE_NAME) ?? readEnv(env, ENV_RELEASE_NAME)
  const releaseNotes = options.get(OPTION_RELEASE_NOTES) ?? readEnv(env, ENV_RELEASE_NOTES)
  const releaseNotesLanguage =
    options.get(OPTION_RELEASE_NOTES_LANGUAGE) ?? readEnv(env, ENV_RELEASE_NOTES_LANGUAGE)
  const userFraction = options.get(OPTION_USER_FRACTION) ?? readEnv(env, ENV_USER_FRACTION)

  const missing = []
  if (packageName === undefined) {
    missing.push(`${OPTION_PACKAGE_NAME}（应用包名），可用环境变量 ${ENV_PACKAGE_NAME}`)
  }
  if (file === undefined) {
    missing.push(`${OPTION_FILE}（.aab 文件路径），可用环境变量 ${ENV_FILE}`)
  }

  return {
    packageName,
    file,
    fileOrigin,
    track,
    releaseStatus,
    releaseName,
    releaseNotes,
    releaseNotesLanguage,
    userFraction,
    missing,
  }
}

/** 校验小数比例：必须满足 0 < 值 < 1（Google 的 userFraction 不含两端） */
function parseUserFraction(value, help) {
  const fraction = Number(value)
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    throw new UsageError(
      `选项 "${OPTION_USER_FRACTION}" 需要 0 与 1 之间的小数（不含 0 和 1），实际收到 "${value}"`,
      help(),
    )
  }
  return fraction
}

/**
 * 校验并规范化 upload-aab 的本地参数（不发起网络请求）。
 *
 * 这些规则在 Google 侧都只会换回一个语焉不详的 400，先在本地拦下能给出更直接的提示。
 *
 * @returns {{ packageName: string, file: string, size: number, track?: string,
 *   releaseStatus?: string, releaseName?: string, releaseNotes?: string,
 *   releaseNotesLanguage?: string, userFraction?: number }}
 */
function validateUploadAabParams(params, help) {
  const { packageName, file, track } = params

  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new UsageError(
      `选项 "${OPTION_PACKAGE_NAME}" 需要合法的应用包名（至少两段、每段以字母开头，` +
        `只能含字母/数字/下划线，如 com.example.app），实际收到 "${packageName}"`,
      help(),
    )
  }

  if (fileSuffix(file) !== 'aab') {
    throw new UsageError(
      `选项 "${OPTION_FILE}" 需要 .aab 文件（Android App Bundle），实际收到 "${file}"`,
      help(),
    )
  }
  const origin = params.fileOrigin
  const size = localFileSize(file, origin, help)

  if (track !== undefined && (track.trim() === '' || /[\s/]/.test(track))) {
    throw new UsageError(
      `选项 "${OPTION_TRACK}" 需要合法的轨道名（不能含空白或 "/"，如 production、beta、internal），` +
        `实际收到 "${track}"`,
      help(),
    )
  }

  const hasReleaseOptions = [
    params.releaseStatus,
    params.releaseName,
    params.releaseNotes,
    params.releaseNotesLanguage,
    params.userFraction,
  ].some((value) => value !== undefined)
  if (track === undefined && hasReleaseOptions) {
    throw new UsageError(
      `选项 ${OPTION_RELEASE_STATUS} / ${OPTION_RELEASE_NAME} / ${OPTION_RELEASE_NOTES} / ` +
        `${OPTION_RELEASE_NOTES_LANGUAGE} / ${OPTION_USER_FRACTION} 只在给出 ${OPTION_TRACK} 时可用`,
      help(),
    )
  }

  if (track === undefined) {
    return { packageName, file, size }
  }

  const releaseStatus = params.releaseStatus ?? 'completed'
  if (!RELEASE_STATUS_SET.has(releaseStatus)) {
    throw new UsageError(
      `选项 "${OPTION_RELEASE_STATUS}" 需要以下状态之一: ${RELEASE_STATUSES.join(' / ')}，` +
        `实际收到 "${releaseStatus}"`,
      help(),
    )
  }

  if (params.releaseNotesLanguage !== undefined && params.releaseNotes === undefined) {
    throw new UsageError(
      `选项 "${OPTION_RELEASE_NOTES_LANGUAGE}" 需要与 "${OPTION_RELEASE_NOTES}" 一起使用`,
      help(),
    )
  }

  let userFraction
  if (params.userFraction !== undefined) {
    if (releaseStatus !== 'inProgress' && releaseStatus !== 'halted') {
      throw new UsageError(
        `选项 "${OPTION_USER_FRACTION}" 只适用于 ${OPTION_RELEASE_STATUS} 为 inProgress / halted 时`,
        help(),
      )
    }
    userFraction = parseUserFraction(params.userFraction, help)
  } else if (releaseStatus === 'inProgress') {
    throw new UsageError(
      `发布状态为 inProgress 时必须给出 "${OPTION_USER_FRACTION}"（0 与 1 之间的小数）`,
      help(),
    )
  }

  return {
    packageName,
    file,
    size,
    track,
    releaseStatus,
    releaseName: params.releaseName,
    releaseNotes: params.releaseNotes,
    // 只在真的有发布说明时才带语言；默认 zh-CN（本项目主要面向中文应用）
    releaseNotesLanguage:
      params.releaseNotes === undefined ? undefined : (params.releaseNotesLanguage ?? 'zh-CN'),
    userFraction,
  }
}

// ------------------------------------------------------------- 上传与提交

/** 应用级接口路径：/applications/{packageName} */
function applicationPath(packageName) {
  return `/applications/${encodeURIComponent(packageName)}`
}

/** edit 级接口路径：/applications/{packageName}/edits/{editId} */
function editPath(packageName, editId) {
  return `${applicationPath(packageName)}/edits/${encodeURIComponent(editId)}`
}

/**
 * 从上传响应里取 versionCode。
 *
 * Google 的 Bundle.versionCode 是 int64：JSON 里既可能是数字，也可能按 protobuf JSON 约定
 * 编码成字符串。两种都接受，统一转成十进制字符串，因为它要作为 Track.release.versionCodes
 * 的元素（该字段是 string 数组）。
 */
function normalizeVersionCode(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value) && value !== '0') {
    return value
  }
  return undefined
}

/**
 * 发起 resumable 上传，拿到会话地址。
 *
 *   POST {apiBase}/upload/androidpublisher/v3/applications/{packageName}/edits/{editId}/bundles
 *        ?uploadType=resumable
 *   Authorization: Bearer <access_token>
 *   Content-Type: application/json; charset=UTF-8
 *   X-Upload-Content-Type: application/octet-stream
 *   X-Upload-Content-Length: <文件字节数>
 *   Body: {}（本次上传没有额外的 metadata）
 *
 * 响应成功时 Body 为空，真正有用的信息在 **Location 头**里：那是随后 PUT 文件内容的会话地址。
 *
 * @returns {Promise<string>} resumable 会话地址
 */
async function initiateBundleUpload({ token, apiBase, packageName, editId, size }) {
  const url = `${apiUrl(apiBase, UPLOAD_PATH_PREFIX, editPath(packageName, editId))}/bundles?uploadType=resumable`

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(size),
        Accept: 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`请求 ${url} 失败: ${error.message}`)
  }

  const text = await response.text()
  // 只为错误处理解析响应；成功时响应体可能是空的（见 parseGoogleResponse）
  parseGoogleResponse(response, text, url)

  const sessionUri = response.headers.get('location')
  if (typeof sessionUri !== 'string' || sessionUri === '') {
    throw new Error('发起上传失败: 响应中未包含 Location 头（resumable 会话地址）')
  }
  return sessionUri
}

/**
 * 上传 .aab 到已有 edit（Google 的 resumable media upload）。
 *
 *   1. POST .../bundles?uploadType=resumable → 取 Location 会话地址（见 initiateBundleUpload）
 *   2. PUT <会话地址>，Content-Type: application/octet-stream，Body 为文件内容 → 返回 Bundle
 *
 * 为什么用 resumable 而不是 simple（uploadType=media）：Android App Bundle 通常有几十 MB，
 * 超过 Google 对 simple upload 的建议上限（约 5 MB）；resumable 是官方对大文件的做法，
 * 也是 fastlane / gradle-play-publisher 采用的路径。本次实现一次 PUT 传完整文件（不再分块），
 * 会话地址本身已含授权信息，因此 PUT 时不再带 Authorization。
 *
 * 大文件说明：文件一次性读入内存（见 uploadAabAndCommit），可上传大小受 Node 堆上限约束；
 * 官方建议上传接口的超时至少 2 分钟，这里用 UPLOAD_TIMEOUT_MS。
 *
 * @returns {Promise<object>} Bundle：{ versionCode, sha1, sha256, size }
 */
async function uploadBundle({ token, apiBase, packageName, editId, body }) {
  const sessionUri = await initiateBundleUpload({
    token,
    apiBase,
    packageName,
    editId,
    size: body.length,
  })

  let response
  try {
    response = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
      },
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`上传会话 ${sessionUri} 请求失败: ${error.message}`)
  }

  const text = await response.text()
  return parseGoogleResponse(response, text, sessionUri)
}

/** --verbose 时打印本次发布计划（Token、服务账号只打印掩码；本地路径按原样打印） */
function logUploadPlan({ plan, params }) {
  stderr('开始发布到 Google Play')
  stderr(`  应用包名:      ${params.packageName}`)
  stderr(`  文件:          ${params.file}`)
  stderr(`  文件大小:      ${params.size} 字节`)
  stderr(`  Token 来源:    ${plan.source}`)
  stderr(`  Token:         ${maskValue(plan.token)}`)
  if (params.track === undefined) {
    stderr('  轨道:          (未指定，只上传 bundle，不发布到任何轨道)')
  } else {
    stderr(`  轨道:          ${params.track}`)
    stderr(`  发布状态:      ${params.releaseStatus}`)
    if (params.releaseName !== undefined) {
      stderr(`  发布名称:      ${params.releaseName}`)
    }
    if (params.releaseNotes !== undefined) {
      stderr(`  发布说明:      [${params.releaseNotesLanguage}] ${params.releaseNotes}`)
    }
    if (params.userFraction !== undefined) {
      stderr(`  分阶段比例:    ${params.userFraction}`)
    }
  }
}

/**
 * 完整的发布流程：创建 edit → 上传 .aab →（可选）更新轨道 → commit。
 *
 * 失败处理：只要 edit 还没 commit，就尽力 delete 它。这是 Google 推荐的做法——
 * 未提交的 edit 会把上传的 bundle 一并丢弃，避免「传了一半但没发布」的中间状态。
 *
 * @returns {Promise<number>} 退出代码（EXIT_OK / EXIT_FAILURE）
 */
async function uploadAabAndCommit({
  apiBase,
  token,
  plan,
  params,
  changesNotSentForReview,
  verbose,
}) {
  if (verbose) {
    logUploadPlan({ plan, params })
  }

  // 先把文件读进内存再创建 edit：本地读失败不该留下一个待清理的 edit
  let body
  try {
    body = readFileSync(params.file)
  } catch (error) {
    stderr(`错误: 读取文件失败: ${params.file}: ${error.message}`)
    return EXIT_FAILURE
  }
  if (body.length !== params.size) {
    stderr(
      `错误: 文件在大小校验之后发生变化: ${params.file}，` +
        `校验时 ${params.size} 字节，读取时 ${body.length} 字节；请重试`,
    )
    return EXIT_FAILURE
  }

  let edit
  try {
    edit = await callAndroidPublisher({
      token,
      apiBase,
      method: 'POST',
      path: `${applicationPath(params.packageName)}/edits`,
      body: {},
    })
  } catch (error) {
    stderr(`错误: 创建 edit 失败: ${error.message}`)
    return EXIT_FAILURE
  }

  const editId = edit?.id
  if (typeof editId !== 'string' || editId === '') {
    stderr('错误: 创建 edit 失败: 响应中未包含 edit.id')
    return EXIT_FAILURE
  }

  if (verbose) {
    stderr('已创建 edit')
    stderr(`  editId:        ${editId}`)
    if (edit.expiryTime !== undefined) {
      stderr(`  过期时间:      ${edit.expiryTime}`)
    }
  }

  /**
   * 打印错误、丢弃未提交的 edit，并返回失败退出代码。
   * 丢弃本身失败只作为警告：edit 会自行过期，真正的问题仍是上面那条错误。
   */
  const fail = async (message) => {
    stderr(`错误: ${message}`)
    try {
      await callAndroidPublisher({
        token,
        apiBase,
        method: 'DELETE',
        path: editPath(params.packageName, editId),
      })
      if (verbose) {
        stderr('已丢弃未提交的 edit')
      }
    } catch (error) {
      stderr(`警告: 丢弃 edit 失败（若 commit 已生效可忽略）: ${error.message}`)
    }
    return EXIT_FAILURE
  }

  if (verbose) {
    stderr('开始上传 .aab')
    const uploadPath = `${apiUrl(apiBase, UPLOAD_PATH_PREFIX, editPath(params.packageName, editId))}/bundles`
    stderr(`  发起地址:      POST ${uploadPath}?uploadType=resumable`)
    stderr(`  uploadType:    resumable`)
    stderr(`  Content-Type:  application/octet-stream`)
    stderr(`  字节数:        ${body.length}`)
  }

  let bundle
  try {
    bundle = await uploadBundle({
      token,
      apiBase,
      packageName: params.packageName,
      editId,
      body,
    })
  } catch (error) {
    return fail(`上传 .aab 失败: ${error.message}`)
  }

  const versionCode = normalizeVersionCode(bundle?.versionCode)
  if (verbose) {
    stderr('已上传 .aab')
    stderr(`  versionCode:   ${versionCode ?? '(响应未返回)'}`)
    if (bundle?.sha256 !== undefined) {
      stderr(`  sha256:        ${bundle.sha256}`)
    }
    if (bundle?.size !== undefined) {
      stderr(`  服务器大小:    ${bundle.size} 字节`)
    }
  }

  if (params.track !== undefined) {
    if (versionCode === undefined) {
      return fail(`上传 .aab 失败: 响应中未包含 versionCode，无法更新轨道 "${params.track}"`)
    }

    const release = {
      status: params.releaseStatus,
      versionCodes: [versionCode],
    }
    if (params.releaseName !== undefined) {
      release.name = params.releaseName
    }
    if (params.releaseNotes !== undefined) {
      release.releaseNotes = [
        { language: params.releaseNotesLanguage, text: params.releaseNotes },
      ]
    }
    if (params.userFraction !== undefined) {
      release.userFraction = params.userFraction
    }

    if (verbose) {
      stderr('开始更新轨道')
      const trackPath = `${apiUrl(apiBase, API_PATH_PREFIX, editPath(params.packageName, editId))}/tracks/${encodeURIComponent(params.track)}`
      stderr(`  请求地址:      PUT ${trackPath}`)
      stderr(`  请求体:        ${JSON.stringify({ track: params.track, releases: [release] })}`)
    }

    try {
      const track = await callAndroidPublisher({
        token,
        apiBase,
        method: 'PUT',
        path: `${editPath(params.packageName, editId)}/tracks/${encodeURIComponent(params.track)}`,
        body: { track: params.track, releases: [release] },
      })
      if (verbose) {
        stderr('已更新轨道')
        stderr(`  track:         ${track?.track ?? params.track}`)
        const codes = track?.releases?.[0]?.versionCodes
        if (Array.isArray(codes)) {
          stderr(`  versionCodes:  ${codes.join(', ')}`)
        }
      }
    } catch (error) {
      return fail(`更新轨道 "${params.track}" 失败: ${error.message}`)
    }
  }

  const commitQuery = changesNotSentForReview ? '?changesNotSentForReview=true' : ''
  if (verbose) {
    stderr('开始提交 edit')
    const commitPath = `${apiUrl(apiBase, API_PATH_PREFIX, editPath(params.packageName, editId))}:commit`
    stderr(`  请求地址:      POST ${commitPath}${commitQuery}`)
    if (changesNotSentForReview) {
      stderr('  changesNotSentForReview: true（变更留在控制台，待人工送审）')
    }
  }

  try {
    await callAndroidPublisher({
      token,
      apiBase,
      method: 'POST',
      // commit 的请求体必须为空（Google 文档），只通过查询参数控制行为
      path: `${editPath(params.packageName, editId)}:commit${commitQuery}`,
    })
  } catch (error) {
    if (!changesNotSentForReview && /changesNotSentForReview/i.test(error.message)) {
      stderr(
        `提示: 该应用可能启用了托管发布（managed publishing）；可加 ${OPTION_CHANGES_NOT_SENT_FOR_REVIEW} ` +
          '重试，变更会留在 Play 控制台等待人工送审',
      )
    }
    return fail(`提交 edit 失败: ${error.message}`)
  }

  if (verbose) {
    stderr('已提交 edit，修改已生效')
  }

  // stdout 只写结果：versionCode（字符串）是后续查询/发布要用的值。
  // 理论上 Bundle 一定返回 versionCode；真缺了就退回整个上传响应 JSON，避免输出空行。
  stdout(versionCode === undefined ? JSON.stringify(bundle) : versionCode)
  return EXIT_OK
}

// --------------------------------------------------------- google access-token

/** google access-token：用服务账号 JSON 换取 access_token */
async function runGoogleAccessToken(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderGoogleAccessTokenHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    ACCESS_TOKEN_OPTIONS,
    renderGoogleAccessTokenHelp,
    ACCESS_TOKEN_FLAGS,
  )
  const verbose = resolveVerbose(options, env, renderGoogleAccessTokenHelp)

  if (!hasServiceAccountOptions(options) && !hasEnvServiceAccount(env)) {
    throw new UsageError(
      `缺少必填参数: ${serviceAccountMissingHint()}`,
      renderGoogleAccessTokenHelp(),
    )
  }

  const result = await exchangeAccessToken({
    options,
    env,
    help: renderGoogleAccessTokenHelp,
    verbose,
  })
  if (result === null) {
    return EXIT_FAILURE
  }

  stdout(result.token)
  return EXIT_OK
}

// ----------------------------------------------------------- google upload-aab

/** google upload-aab：上传 .aab，必要时发布到指定轨道 */
async function runGoogleUploadAab(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderGoogleUploadAabHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    UPLOAD_AAB_OPTIONS,
    renderGoogleUploadAabHelp,
    UPLOAD_AAB_FLAGS,
  )
  const verbose = resolveVerbose(options, env, renderGoogleUploadAabHelp)
  const changesNotSentForReview = resolveSwitch(
    options,
    env,
    OPTION_CHANGES_NOT_SENT_FOR_REVIEW,
    ENV_CHANGES_NOT_SENT_FOR_REVIEW,
    renderGoogleUploadAabHelp,
  )

  const params = collectUploadAabParams(options, env)
  const plan = planAccessToken(options, env)
  if (plan.missing !== undefined) {
    params.missing.push(...plan.missing)
  }
  if (params.missing.length > 0) {
    throw new UsageError(
      `缺少必填参数: ${params.missing.join('；')}`,
      renderGoogleUploadAabHelp(),
    )
  }

  // 本地参数一次校验完再联网：包名、后缀、文件、轨道与发布参数都给了才继续
  const validated = validateUploadAabParams(params, renderGoogleUploadAabHelp)

  const apiBase = (readEnv(env, ENV_API_BASE) ?? API_BASE).replace(/\/+$/, '')
  const auth =
    plan.kind === 'token'
      ? plan
      : await exchangeAccessToken({
          options,
          env,
          help: renderGoogleUploadAabHelp,
          verbose,
        })
  if (auth === null) {
    return EXIT_FAILURE
  }

  return uploadAabAndCommit({
    apiBase,
    token: auth.token,
    // source 用「来源判定」阶段的描述：换取的来源在 plan 里已经确定，与 auth 内容无关
    plan: { token: auth.token, source: plan.source },
    params: validated,
    changesNotSentForReview,
    verbose,
  })
}

// ------------------------------------------------------------------ 帮助文档

/** Google 原始文档：接入准备（创建项目、启用 API、服务账号授权） */
const GETTING_STARTED_DOC_URL = 'https://developers.google.com/android-publisher/getting_started?hl=zh-cn'
/** Google 原始文档：服务账号 OAuth 2.0（JWT Bearer 换取 access_token） */
const SERVICE_ACCOUNT_DOC_URL =
  'https://developers.google.com/identity/protocols/oauth2/service-account'
/** Google 原始文档：Edits（创建、提交、删除 edit） */
const EDITS_DOC_URL = 'https://developers.google.com/android-publisher/edits?hl=zh-cn'
/** Google 原始文档：上传 .aab 接口 */
const BUNDLE_UPLOAD_DOC_URL =
  'https://developers.google.com/android-publisher/api-ref/rest/v3/edits.bundles/upload?hl=zh-cn'
/** Google 原始文档：轨道与发布（Track / Release 字段、发布状态） */
const TRACKS_DOC_URL = 'https://developers.google.com/android-publisher/tracks?hl=zh-cn'

/** google 帮助文档：google、google help、google --help */
function renderGoogleHelp() {
  return renderHelp({
    title: `${PROGRAM} google - Google Play`,
    usage: [`${PROGRAM} google <命令> [选项]`],
    sections: [
      {
        title: '命令',
        entries: [
          ['access-token', '用服务账号 JSON 换取 access_token'],
          ['upload-aab', '上传 .aab（可选发布到轨道）'],
          ['help', '显示帮助信息'],
        ],
      },
      {
        title: '选项',
        entries: [['-h, --help', '显示帮助信息']],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} google access-token --service-account ./google-play-service-account.json`,
      `  ${PROGRAM} google upload-aab --package-name com.example.app --file ./app-release.aab \\`,
      `    --service-account ./google-play-service-account.json`,
      `  ${PROGRAM} google upload-aab --package-name com.example.app --file ./app-release.aab \\`,
      `    --service-account ./google-play-service-account.json --track internal`,
    ],
  })
}

/** google access-token 帮助文档：参数缺失时的提示输出、以及 --help */
function renderGoogleAccessTokenHelp() {
  return renderHelp({
    title: `${PROGRAM} google access-token - 用服务账号换取 access_token`,
    usage: [`${PROGRAM} google access-token [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          ['--service-account <文件>', '服务账号 JSON 密钥文件路径（与 --service-account-data 二选一）'],
          ['--service-account-data <JSON>', '直接传入服务账号 JSON 数据（与 --service-account 二选一）'],
          ['--client-email <邮箱>', '分项参数：服务账号 JSON 的 client_email（与 JSON 参数二选一）'],
          ['--private-key <文件>', '分项参数：私钥 PEM 文件路径（与 --private-key-data 二选一）'],
          ['--private-key-data <PEM>', '分项参数：私钥 PEM 数据（建议走环境变量，避免进入 ps）'],
          ['--token-uri <地址>', `令牌接口地址，默认取 JSON 的 token_uri 或 ${DEFAULT_TOKEN_URI}`],
          ['--verbose', `输出运行日志（默认只输出结果）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_SERVICE_ACCOUNT, '服务账号 JSON 文件路径，等价于 --service-account'],
          [ENV_SERVICE_ACCOUNT_DATA, '服务账号 JSON 数据，等价于 --service-account-data'],
          [ENV_CLIENT_EMAIL, 'client_email，等价于 --client-email'],
          [ENV_PRIVATE_KEY, '私钥 PEM 文件路径，等价于 --private-key'],
          [ENV_PRIVATE_KEY_DATA, '私钥 PEM 数据，等价于 --private-key-data'],
          [ENV_TOKEN_URI, '令牌接口地址，等价于 --token-uri'],
          [ENV_VERBOSE, '输出运行日志，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
        ],
      },
      {
        title: '凭据来源（优先级从高到低）',
        entries: [
          ['1. 命令行凭据', '--service-account / --service-account-data（完整 JSON），或 --client-email + --private-key / --private-key-data（分项；两者互斥）'],
          ['2. 环境变量 JSON', `${ENV_SERVICE_ACCOUNT} / ${ENV_SERVICE_ACCOUNT_DATA}`],
          ['3. 环境变量分项', `${ENV_CLIENT_EMAIL} + ${ENV_PRIVATE_KEY} / ${ENV_PRIVATE_KEY_DATA}`],
        ],
      },
      {
        title: '鉴权流程',
        entries: [
          ['1. 本地签 JWT', '用服务账号私钥签发 RS256 JWT：iss=client_email、scope=androidpublisher、aud=token_uri、exp=iat+3600'],
          ['2. 换取令牌', `POST token_uri，grant_type=${JWT_BEARER_GRANT_TYPE}`],
          ['3. 输出', '把响应里的 access_token 写到 stdout'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', 'access_token（可直接作为 Authorization: Bearer 令牌使用）'],
          ['stderr', '--verbose 时的运行日志（Token、client_email 只打印掩码）；默认不打印'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功'],
          ['1', '参数缺失、参数错误或调用失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} google access-token --service-account ./google-play-service-account.json`,
      `  ${PROGRAM} google access-token --service-account-data "$(cat service-account.json)" --verbose`,
      '  # 把 JSON 里的属性拆开传：client_email + 私钥 PEM',
      `  ${PROGRAM} google access-token --client-email publisher@project.iam.gserviceaccount.com \\`,
      `    --private-key ./service-account.pem`,
      `  ${ENV_CLIENT_EMAIL}=publisher@project.iam.gserviceaccount.com \\`,
      `    ${ENV_PRIVATE_KEY_DATA}="$(cat service-account.pem)" ${PROGRAM} google access-token`,
      `  ${ENV_SERVICE_ACCOUNT}=./google-play-service-account.json ${PROGRAM} google access-token`,
      '',
      `说明: 分项参数对应 JSON 字段：client_email → ${OPTION_CLIENT_EMAIL}，private_key → ${OPTION_PRIVATE_KEY_DATA}`,
      `说明: project_id、private_key_id 不参与 RS256 JWT 鉴权，不需要传递`,
      `说明: 私钥数据建议走环境变量 ${ENV_PRIVATE_KEY_DATA}；命令行参数会出现在 ps 中`,
      `说明: access_token 有效期约 1 小时，CI 里每次发布重新换取即可，不需要缓存`,
      `说明: 服务账号 JSON / 私钥数据不会写入日志与错误信息；文件路径在日志里掩码显示（如 /Use*****.json）`,
      '说明: 只支持服务账号 JSON 密钥（type = service_account）或它的分项字段；Workload Identity Federation / ADC 凭据暂不支持',
      `说明: 命令行同时给出 ${OPTION_SERVICE_ACCOUNT} 与 ${OPTION_SERVICE_ACCOUNT_DATA} 会报错；` +
        `环境变量层两者都在时优先用 ${ENV_SERVICE_ACCOUNT_DATA} 并提示`,
      '说明: 命令行同时给出 JSON 参数与分项参数也会报错；环境变量层两者都在时优先用完整 JSON 并提示',
      `说明: 服务账号需在 Google Play 控制台「用户和权限」中被授予发布权限，否则换取令牌成功但业务接口返回 403`,
      `原始文档: ${SERVICE_ACCOUNT_DOC_URL}`,
      `原始文档: ${GETTING_STARTED_DOC_URL}`,
    ],
  })
}

/** google upload-aab 帮助文档：参数缺失时的提示输出、以及 --help */
function renderGoogleUploadAabHelp() {
  return renderHelp({
    title: `${PROGRAM} google upload-aab - 上传 .aab 到 Google Play`,
    usage: [`${PROGRAM} google upload-aab [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          ['--package-name <包名>', 'Google Play 应用包名（如 com.example.app），必填'],
          ['--file <文件>', '.aab 文件路径（Android App Bundle），必填'],
          ['--service-account <文件>', '服务账号 JSON 密钥文件路径（与 --service-account-data、分项参数互斥；未给 --token 时需要）'],
          ['--service-account-data <JSON>', '直接传入服务账号 JSON 数据（与 --service-account、分项参数互斥）'],
          ['--client-email <邮箱>', '分项参数：服务账号 JSON 的 client_email（与 JSON 参数二选一）'],
          ['--private-key <文件>', '分项参数：私钥 PEM 文件路径（与 --private-key-data 二选一）'],
          ['--private-key-data <PEM>', '分项参数：私钥 PEM 数据（建议走环境变量，避免进入 ps）'],
          ['--token-uri <地址>', `令牌接口地址，默认取 JSON 的 token_uri 或 ${DEFAULT_TOKEN_URI}`],
          ['--token <access_token>', '已换取的 access_token；未给出服务账号凭据时使用'],
          ['--track <轨道>', '发布到哪个轨道（production / beta / alpha / internal / 自定义轨道名）；不给则只上传 bundle'],
          ['--release-status <状态>', `--track 时的发布状态：completed（默认）/ draft / inProgress / halted`],
          ['--release-name <名称>', '--track 时的发布名称（可选）'],
          ['--release-notes <文本>', '--track 时的发布说明（可选；较长时可用 "$(cat notes.txt)"）'],
          ['--release-notes-language <语言>', '发布说明语言（BCP-47，默认 zh-CN，如 en-US）'],
          ['--user-fraction <比例>', `分阶段发布比例，0 与 1 之间的小数；仅 --release-status 为 inProgress / halted 时使用`],
          ['--changes-not-sent-for-review', '提交时设置 changesNotSentForReview=true：变更留在 Play 控制台，需人工送审（托管发布）'],
          ['--verbose', `输出运行日志（默认只输出 versionCode）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_PACKAGE_NAME, '应用包名，等价于 --package-name'],
          [ENV_FILE, '.aab 文件路径，等价于 --file'],
          [ENV_SERVICE_ACCOUNT, '服务账号 JSON 文件路径，等价于 --service-account'],
          [ENV_SERVICE_ACCOUNT_DATA, '服务账号 JSON 数据，等价于 --service-account-data'],
          [ENV_CLIENT_EMAIL, 'client_email，等价于 --client-email'],
          [ENV_PRIVATE_KEY, '私钥 PEM 文件路径，等价于 --private-key'],
          [ENV_PRIVATE_KEY_DATA, '私钥 PEM 数据，等价于 --private-key-data'],
          [ENV_TOKEN, 'access_token，等价于 --token'],
          [ENV_TRACK, '轨道名，等价于 --track'],
          [ENV_RELEASE_STATUS, '发布状态，等价于 --release-status'],
          [ENV_RELEASE_NAME, '发布名称，等价于 --release-name'],
          [ENV_RELEASE_NOTES, '发布说明，等价于 --release-notes'],
          [ENV_RELEASE_NOTES_LANGUAGE, '发布说明语言，等价于 --release-notes-language'],
          [ENV_USER_FRACTION, '分阶段发布比例，等价于 --user-fraction'],
          [ENV_CHANGES_NOT_SENT_FOR_REVIEW, '提交时使用 changesNotSentForReview=true，1/true/yes/on 开启、0/false/no/off 关闭'],
          [ENV_VERBOSE, '输出运行日志，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
          [ENV_TOKEN_URI, '令牌接口地址，等价于 --token-uri'],
          [ENV_API_BASE, `接口域名，默认 ${API_BASE}（本地联调或代理时覆盖）`],
        ],
      },
      {
        title: 'Token 来源（优先级从高到低）',
        entries: [
          ['1. 命令行凭据', '--service-account / --service-account-data（完整 JSON），或 --client-email + --private-key / --private-key-data（分项；两者互斥）'],
          ['2. --token', `使用给定的 access_token，也可用环境变量 ${ENV_TOKEN}`],
          ['3. 环境变量 JSON', `以上都没有、但 ${ENV_SERVICE_ACCOUNT} 或 ${ENV_SERVICE_ACCOUNT_DATA} 已设置时，本地换取 access_token`],
          ['4. 环境变量分项', `以上都没有、但 ${ENV_CLIENT_EMAIL} 与 ${ENV_PRIVATE_KEY} / ${ENV_PRIVATE_KEY_DATA} 已设置时，本地换取 access_token`],
        ],
      },
      {
        title: '执行步骤',
        entries: [
          ['1. 创建 edit', `POST ${API_BASE}${API_PATH_PREFIX}/applications/{packageName}/edits`],
          ['2. 上传 bundle', `POST ${API_BASE}${UPLOAD_PATH_PREFIX}/applications/{packageName}/edits/{editId}/bundles?uploadType=resumable 取会话地址，再 PUT 会话地址上传文件内容`],
          ['3. 更新轨道', `PUT ${API_BASE}${API_PATH_PREFIX}/applications/{packageName}/edits/{editId}/tracks/{track}（仅给了 --track 时）`],
          ['4. 提交 edit', `POST ${API_BASE}${API_PATH_PREFIX}/applications/{packageName}/edits/{editId}:commit`],
        ],
      },
      {
        title: '发布状态（--release-status）',
        entries: [
          ['completed', '全部用户可更新（默认）'],
          ['draft', '仅保存为草稿，需要人工在控制台发起发布'],
          ['inProgress', `分阶段发布，必须同时给出 --user-fraction（如 0.1 表示 10% 用户）`],
          ['halted', '暂停分阶段发布，可配合 --user-fraction 调整比例'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', 'bundle 的 versionCode（十进制字符串）；响应异常缺失时退回整个上传响应 JSON'],
          ['stderr', '--verbose 时的运行日志（Token、client_email 只打印掩码）；默认不打印'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功（edit 已 commit，修改已生效）'],
          ['1', '参数缺失、参数错误或调用失败（未提交的 edit 会被尽力删除）'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} google upload-aab --package-name com.example.app --file ./app-release.aab \\`,
      `    --service-account ./google-play-service-account.json`,
      '  # 上传后发布到内部测试轨道',
      `  ${PROGRAM} google upload-aab --package-name com.example.app --file ./app-release.aab \\`,
      `    --service-account ./google-play-service-account.json --track internal`,
      '  # 把 JSON 属性拆开传（client_email + PEM 私钥）',
      `  ${PROGRAM} google upload-aab --package-name com.example.app --file ./app-release.aab \\`,
      `    --client-email publisher@project.iam.gserviceaccount.com --private-key ./service-account.pem \\`,
      `    --track internal`,
      '  # 正式轨道 + 发布说明；直接使用已换取的 access_token',
      `  ${PROGRAM} google upload-aab --package-name com.example.app --file ./app-release.aab \\`,
      `    --token <access_token> --track production --release-notes "修复若干问题"`,
      '  # 10% 分阶段发布',
      `  ${PROGRAM} google upload-aab --package-name com.example.app --file ./app-release.aab \\`,
      `    --token <access_token> --track production --release-status inProgress --user-fraction 0.1`,
      '',
      '说明: 应用的第一个版本仍需在 Google Play 控制台手动上传，之后才能用 API 发布',
      '说明: 服务账号需在 Play 控制台「用户和权限」中被邀请并授予对应轨道/正式版的发布权限',
      '说明: 只有 commit 之后修改才生效；任一步失败都会尽力删除未提交的 edit（已上传的 bundle 一并丢弃）',
      '说明: 不给 --track 时只把 .aab 上传到应用的 bundle 库并 commit，不会进入任何轨道',
      '说明: 上传用 resumable 协议（先 POST 取会话地址，再 PUT 文件内容），适配大文件',
      `说明: ${OPTION_USER_FRACTION} 只用于分阶段发布；inProgress 必须给出，且取值必须大于 0 小于 1`,
      `说明: 提交返回 changesNotSentForReview 时（例如应用使用托管发布），` +
        `加 ${OPTION_CHANGES_NOT_SENT_FOR_REVIEW}（或 ${ENV_CHANGES_NOT_SENT_FOR_REVIEW}=1）后变更留在控制台等待人工送审`,
      '说明: 自定义轨道名直接传入即可（如 wear:production、automotive:production 等外形（form factor）轨道前缀）',
      '说明: .aab 会一次性读入内存，数 GB 的包需要给 Node 更多内存；上传接口超时为 10 分钟',
      `说明: 分项参数对应 JSON 字段：client_email → ${OPTION_CLIENT_EMAIL}，private_key → ${OPTION_PRIVATE_KEY_DATA}`,
      `说明: 私钥数据建议走环境变量 ${ENV_PRIVATE_KEY_DATA}；命令行参数会出现在 ps 中`,
      `说明: 命令行同时给出 JSON 参数与分项参数会报错；` +
        `环境变量层 JSON 与分项都在时优先用 JSON；服务账号 JSON / 私钥数据不会写入日志`,
      `原始文档: ${EDITS_DOC_URL}`,
      `原始文档: ${BUNDLE_UPLOAD_DOC_URL}`,
      `原始文档: ${TRACKS_DOC_URL}`,
      `原始文档: ${GETTING_STARTED_DOC_URL}`,
    ],
  })
}

// ------------------------------------------------------------------ 命令分发

/** google 子命令分发 */
async function runGoogle(argv, env) {
  const [command, ...rest] = argv
  if (command === undefined || isHelpToken(command)) {
    stdout(renderGoogleHelp())
    return EXIT_OK
  }
  if (command === 'access-token') {
    return runGoogleAccessToken(rest, env)
  }
  if (command === 'upload-aab') {
    return runGoogleUploadAab(rest, env)
  }
  throw new UsageError(`未知命令 "google ${command}"`, renderGoogleHelp())
}

/**
 * Google Play 命令描述，由 publish-apk.js 注册到厂商表中。
 *
 * 命令名与摘要是 Google 自己的信息，因此放在本模块而不是根入口。
 */
export const googleCommand = {
  name: 'google',
  summary: 'Google Play 相关命令',
  run: runGoogle,
}
