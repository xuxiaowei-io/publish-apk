/**
 * 华为应用市场命令（`publish-apk huawei ...`）。
 *
 * 厂商隔离：所有华为相关的东西都在本模块——
 *   - 命令与帮助文档（huawei / huawei service-account）
 *   - JWT 固定值：typ、alg、aud、exp 相对 iat 的偏移
 *   - 华为特有的选项与环境变量（--kid/--iss、HUAWEI_KID/HUAWEI_ISS 等）
 *
 * publish-apk.js 只做根命令分发，不出现任何华为字样。
 * 将来新增小米等厂商，照本模块的形状新增 src/xiaomi.js，
 * 然后在 publish-apk.js 的 VENDORS 里注册一行即可。
 *
 * 已支持的行为：
 *   1. node src/publish-apk.js huawei               输出 huawei 帮助文档
 *   2. node src/publish-apk.js huawei help          输出 huawei 帮助文档
 *   3. node src/publish-apk.js huawei --help        输出 huawei 帮助文档
 *   4. node src/publish-apk.js huawei service-account
 *      输出 service-account 帮助文档，并在 stderr 记录缺少的必填参数
 *      （--kid、--iss、--private-key/--private-key-data，也支持环境变量
 *      HUAWEI_KID、HUAWEI_ISS、HUAWEI_PRIVATE_KEY），退出代码 1
 *   5. node src/publish-apk.js huawei service-account --help  输出 service-account 帮助文档
 *   6. node src/publish-apk.js huawei service-account <必填参数>
 *      用私钥签发 PS256 JWT（node:crypto 实现，无第三方依赖），签名结果写 stdout，退出代码 0
 *   7. node src/publish-apk.js huawei client-credentials <必填参数>
 *      用 API 客户端的 client_id + client_secret 调 POST /api/oauth2/v1/token 换取 access_token，
 *      access_token 写 stdout，退出代码 0
 *   8. node src/publish-apk.js huawei service-account-upload-url <必填参数>
 *      确定 Service Account Token（命令行 service-account 参数本地签发优先，其次 --token），
 *      再调 GET /api/publish/v2/upload-url/for-obs 获取文件上传地址，
 *      接口原始响应 JSON（含 urlInfo.url/method/headers）写 stdout，退出代码 0
 *   9. node src/publish-apk.js huawei client-credentials-upload-url <必填参数>
 *      确定 access_token（命令行 client-credentials 参数本地换取优先，其次 --token），
 *      再调同一个接口获取文件上传地址，并按 API 客户端方式同时携带 client_id 头，
 *      接口原始响应 JSON 写 stdout，退出代码 0
 *
 * 环境变量：每个带值的选项都有同名环境变量兜底（选项优先），见各命令帮助文档的「环境变量」小节；
 * 开关型选项 --verbose 也有环境变量 HUAWEI_VERBOSE（1/true/yes/on 开启、0/false/no/off 关闭）。
 */
import { existsSync, readFileSync } from 'node:fs'

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
  maskJwtClaims,
  maskJwtHeader,
  maskValue,
  signJwt,
} from './jwt.js'

// ---------------------------------------------------------------- JWT 固定值

/** JWT 请求头 typ（数据类型），华为固定为 JWT */
export const JWT_HEADER_TYP = 'JWT'
/** JWT 请求头 alg（算法类型），华为固定为 PS256（RSA-PSS + SHA-256） */
export const JWT_HEADER_ALG = 'PS256'
/** JWT 载荷 aud（接收方），华为固定为换取令牌的接口地址 */
export const JWT_CLAIM_AUD = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token'
/** JWT 载荷 exp 相对 iat 的偏移（秒），华为要求到期时间比签发时间晚 3600 秒 */
export const JWT_CLAIM_EXP_OFFSET_SECONDS = 3600

/**
 * 生成华为 JWT 请求头：{ alg: 'PS256', typ: 'JWT', kid }
 *
 * 注意：这里返回的是**真实**请求头，kid 必须是完整值，
 * 否则华为无法用密钥 ID 校验签名。掩码只用于展示，见 maskJwtHeader。
 */
function createJwtHeader(kid) {
  return { alg: JWT_HEADER_ALG, typ: JWT_HEADER_TYP, kid }
}

/**
 * 生成华为 JWT 载荷：{ iss, aud, iat, exp }
 *
 * exp（到期时间）由 iat 推导：恒为 iat + JWT_CLAIM_EXP_OFFSET_SECONDS。
 */
function createJwtClaims({ iss, iat }) {
  if (typeof iss !== 'string' || iss === '') {
    // 兜底防线：iss 缺失时 JSON.stringify 会静默丢掉该字段，生成出的 JWT 无法通过校验
    throw new Error('createJwtClaims 需要非空的 iss（JWT 签发者）')
  }
  const issuedAt = iat ?? currentUnixSeconds()
  return {
    iss,
    aud: JWT_CLAIM_AUD,
    iat: issuedAt,
    exp: issuedAt + JWT_CLAIM_EXP_OFFSET_SECONDS,
  }
}

// ------------------------------------------------------- 选项名与环境变量名

/** 私钥来源一：私钥 PEM 文件的路径 */
const OPTION_PRIVATE_KEY = '--private-key'
/** 私钥来源二：直接传入的私钥 PEM 数据 */
const OPTION_PRIVATE_KEY_DATA = '--private-key-data'
/** JWT 请求头中的密钥 ID */
const OPTION_KID = '--kid'
/** JWT 载荷中的签发者 iss */
const OPTION_ISS = '--iss'
/** JWT 载荷中的签发时间（UTC 秒级时间戳），不传则取当前时间 */
const OPTION_IAT = '--iat'
/** 开关：输出运行日志（默认只输出 Token，保持 stdout/stderr 干净） */
const OPTION_VERBOSE = '--verbose'
/** huawei service-account 支持的全部选项 */
const SERVICE_ACCOUNT_OPTIONS = new Set([
  OPTION_PRIVATE_KEY,
  OPTION_PRIVATE_KEY_DATA,
  OPTION_KID,
  OPTION_ISS,
  OPTION_IAT,
  OPTION_VERBOSE,
])
/** huawei service-account 中的开关型选项（不带值） */
const SERVICE_ACCOUNT_FLAGS = new Set([OPTION_VERBOSE])

const ENV_KID = 'HUAWEI_KID'
const ENV_ISS = 'HUAWEI_ISS'
/** 私钥 PEM 文件路径，等价于 --private-key（与 ENV_PRIVATE_KEY_DATA 二选一） */
const ENV_PRIVATE_KEY = 'HUAWEI_PRIVATE_KEY'
/** 私钥 PEM 数据，等价于 --private-key-data（与 ENV_PRIVATE_KEY 二选一） */
const ENV_PRIVATE_KEY_DATA = 'HUAWEI_PRIVATE_KEY_DATA'
/** JWT 签发时间（UTC 秒级时间戳），等价于 --iat */
const ENV_IAT = 'HUAWEI_IAT'
/**
 * 开关型环境变量，等价于 --verbose。
 *
 * 开关型选项没有「值」的概念，而环境变量天生是字符串，因此取值只认白名单里的真值/假值
 * （见 resolveVerbose）：`HUAWEI_VERBOSE=0` 必须真的关闭日志，而不是被当成「非空即开启」。
 */
const ENV_VERBOSE = 'HUAWEI_VERBOSE'

/** huawei client-credentials：API 客户端 ID */
const OPTION_CLIENT_ID = '--client-id'
/** huawei client-credentials：API 客户端密钥 */
const OPTION_CLIENT_SECRET = '--client-secret'
/** huawei client-credentials 支持的全部选项 */
const CLIENT_CREDENTIALS_OPTIONS = new Set([OPTION_CLIENT_ID, OPTION_CLIENT_SECRET, OPTION_VERBOSE])
/** huawei client-credentials 中的开关型选项（不带值） */
const CLIENT_CREDENTIALS_FLAGS = new Set([OPTION_VERBOSE])

const ENV_CLIENT_ID = 'HUAWEI_CLIENT_ID'
const ENV_CLIENT_SECRET = 'HUAWEI_CLIENT_SECRET'

/** service-account-upload-url 与 client-credentials-upload-url：已签发的 Token（JWT 或 access_token） */
const OPTION_TOKEN = '--token'
/** 两个 upload-url 命令：应用 ID（AppGallery Connect 的 appId） */
const OPTION_APP_ID = '--app-id'
/** 两个 upload-url 命令：上传后的文件名 */
const OPTION_FILE_NAME = '--file-name'
/** 两个 upload-url 命令：文件大小（字节） */
const OPTION_CONTENT_LENGTH = '--content-length'

/**
 * huawei service-account-upload-url 支持的全部选项：
 * service-account 的选项（用来在本地签发 Token，优先级高于 --token）+ 应用与文件参数。
 */
const SERVICE_ACCOUNT_UPLOAD_URL_OPTIONS = new Set([
  ...SERVICE_ACCOUNT_OPTIONS,
  OPTION_TOKEN,
  OPTION_APP_ID,
  OPTION_FILE_NAME,
  OPTION_CONTENT_LENGTH,
])
/** huawei service-account-upload-url 中的开关型选项（不带值） */
const SERVICE_ACCOUNT_UPLOAD_URL_FLAGS = new Set([OPTION_VERBOSE])

/**
 * huawei client-credentials-upload-url 支持的全部选项：
 * client-credentials 的选项（用来在本地换取 access_token，优先级高于 --token）+ 应用与文件参数。
 */
const CLIENT_CREDENTIALS_UPLOAD_URL_OPTIONS = new Set([
  ...CLIENT_CREDENTIALS_OPTIONS,
  OPTION_TOKEN,
  OPTION_APP_ID,
  OPTION_FILE_NAME,
  OPTION_CONTENT_LENGTH,
])
/** huawei client-credentials-upload-url 中的开关型选项（不带值） */
const CLIENT_CREDENTIALS_UPLOAD_URL_FLAGS = new Set([OPTION_VERBOSE])

const ENV_TOKEN = 'HUAWEI_TOKEN'
const ENV_APP_ID = 'HUAWEI_APP_ID'
const ENV_FILE_NAME = 'HUAWEI_FILE_NAME'
const ENV_CONTENT_LENGTH = 'HUAWEI_CONTENT_LENGTH'

/**
 * 接口域名覆盖项。
 *
 * 默认中国大陆（connect-api.cloud.huawei.com）；其他区域是 connect-api-dre / dra / drru，
 * 另外本地联调时也可以指向自建服务。
 */
const ENV_API_BASE = 'HUAWEI_API_BASE'

// -------------------------------------------------------------- 开关型参数

/** HUAWEI_VERBOSE 里代表「开启」的取值（大小写、首尾空白不敏感） */
const VERBOSE_ON_VALUES = new Set(['1', 'true', 'yes', 'y', 'on'])
/** HUAWEI_VERBOSE 里代表「关闭」的取值；空串由 readEnv 归为「未设置」 */
const VERBOSE_OFF_VALUES = new Set(['0', 'false', 'no', 'n', 'off'])

/**
 * --verbose 的取值来源：命令行选项优先，其次环境变量 HUAWEI_VERBOSE。
 *
 * 四个 huawei 命令都只在「命令行没写 --verbose」时才看环境变量，
 * 这样 `HUAWEI_VERBOSE=1 make huawei-service-account` 与写成选项的结果完全一致。
 *
 * 环境变量的值只认白名单：真值开启、假值关闭、其它值报用法错误。之所以不采用
 * 「非空即开启」，是因为开关型选项没有值可写，`HUAWEI_VERBOSE=0` 这种明确关闭的写法
 * 如果被当成开启，会在 CI 日志里凭空多出运行日志（其中含掩码后的凭证信息）；
 * 反之若把无法识别的值悄悄当成关闭，排查时又会丢掉日志。两者都不如直接报错。
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

// ------------------------------------------------------------------ 私钥读取

/**
 * 还原因环境文件 / shell 转义而变形的 PEM 文本。
 *
 * 典型场景：`.env` 里写成 `HUAWEI_PRIVATE_KEY="-----BEGIN...\nMIIB...\n"`，
 * 但 `source .env` 时 bash、zsh 都不会解释双引号内的 `\n`，变量里存的是
 * 「一行文本 + 字面量反斜杠 n」，PEM 解码必然失败（DECODER routines::unsupported）。
 *
 * PEM 的合法字符集（base64、+、/、=、-、换行）里没有反斜杠，
 * 因此在这些转义序列存在、且没有真实换行时把它们还原成换行是安全的。
 */
function normalizePemText(text) {
  if (text.includes('\n')) {
    return text
  }
  return text.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').replaceAll('\\r', '\n')
}

/**
 * 私钥来源在错误信息与日志里的展示文本。
 *
 * 路径属于敏感信息，统一掩码输出（如 /Use*****.pem）；PEM 数据、含换行的值和异常长的值
 * 连掩码都不做——几千个星号既刷屏又没意义——直接整体省略，只留字符数便于排查。
 */
function describePrivateKeySource(value) {
  if (value.includes('-----BEGIN') || /[\r\n]/.test(value) || value.length > 120) {
    return `(已省略，共 ${value.length} 字符)`
  }
  return maskValue(value)
}

/**
 * 从文件读取私钥 PEM 文本。
 *
 * help 提供出错时附带的帮助文档（service-account 与 service-account-upload-url 各有一份），
 * origin 用于标注该路径来自哪个选项或环境变量。
 */
function privateKeyFromFile(path, help, origin = '') {
  const from = origin ? `（来自 ${origin}）` : ''
  const shown = describePrivateKeySource(path)
  if (path.includes('-----BEGIN')) {
    // 私钥数据被当成文件路径：只提示该改用哪个来源，绝不回显数据
    throw new UsageError(
      `私钥路径无效: ${shown}${from}；该值是 PEM 数据，请改用 ${OPTION_PRIVATE_KEY_DATA} ` +
        `或环境变量 ${ENV_PRIVATE_KEY_DATA}`,
      help(),
    )
  }
  if (!existsSync(path)) {
    throw new UsageError(`私钥文件不存在: ${shown}${from}`, help())
  }
  const content = readFileSync(path, 'utf8')
  if (!content.includes('-----BEGIN')) {
    throw new UsageError(`私钥文件内容无效: ${shown}${from}（缺少 PEM 头 "-----BEGIN"）`, help())
  }
  return { description: `文件 ${shown}${from}`, content: normalizePemText(content) }
}

/**
 * 直接接收私钥 PEM 数据；help 提供出错时附带的帮助文档。
 *
 * 数据本身是最高敏感级别的信息：这里只用 label（选项名或环境变量名）标注来源，
 * 任何错误信息与日志都不得出现私钥内容，因此 description 就是 label。
 */
function privateKeyFromData(data, help, label) {
  if (!data.includes('-----BEGIN')) {
    throw new UsageError(`私钥数据无效: ${label}（缺少 PEM 头 "-----BEGIN"）`, help())
  }
  return { description: label, content: normalizePemText(data) }
}

/**
 * 收集私钥来源（只定位来源，不读取、不解码，便于把「缺失」与其它必填项合并成一条提示）。
 *
 * 优先级：命令行选项 > 环境变量。只要命令行给出 --private-key 或 --private-key-data，
 * 就完全忽略 HUAWEI_PRIVATE_KEY / HUAWEI_PRIVATE_KEY_DATA，避免本地 .env 里另有私钥时
 * 报出「选项与环境变量冲突」这种无谓错误；命令行同时给出两个来源属于明确误用，报错。
 *
 * 环境变量层两个都存在时**不报错**，而是「数据优先」并打印一行提示，原因是：
 *   - 变量改名（HUAWEI_PRIVATE_KEY 改为文件路径、数据另用 HUAWEI_PRIVATE_KEY_DATA）后，
 *     已经 source 过旧 .env 的 shell 里会一直留着旧变量（source 不会 unset 旧名字），
 *     硬报错会让命令在改名后直接不可用；
 *   - 旧变量残留的往往正是旧版的 PEM 数据，若「路径优先」会被当成文件路径读而失败，
 *     数据优先则两种情况（残留路径、残留数据）都能正常签发。
 *
 * 两个层级都区分「文件路径」与「PEM 数据」：前者用 HUAWEI_PRIVATE_KEY / --private-key，
 * 后者用 HUAWEI_PRIVATE_KEY_DATA / --private-key-data，不再靠内容猜测。
 */
function collectPrivateKeySources(options, env, help) {
  const pathOption = options.get(OPTION_PRIVATE_KEY)
  const dataOption = options.get(OPTION_PRIVATE_KEY_DATA)
  if (pathOption !== undefined && dataOption !== undefined) {
    throw new UsageError(
      `选项 "${OPTION_PRIVATE_KEY}" 与 "${OPTION_PRIVATE_KEY_DATA}" 不能同时使用`,
      help(),
    )
  }
  if (pathOption !== undefined || dataOption !== undefined) {
    return { path: pathOption, pathOrigin: '', data: dataOption, dataOrigin: OPTION_PRIVATE_KEY_DATA }
  }

  const path = readEnv(env, ENV_PRIVATE_KEY)
  const data = readEnv(env, ENV_PRIVATE_KEY_DATA)
  if (path !== undefined && data !== undefined) {
    // 提示写 stderr：stdout 仍只有结果（JWT / JSON），不影响 JWT=$(…) 取用
    stderr(
      `提示: 环境变量 ${ENV_PRIVATE_KEY} 与 ${ENV_PRIVATE_KEY_DATA} 同时存在，本次使用 ` +
        `${ENV_PRIVATE_KEY_DATA}（私钥数据）；如需改用私钥文件请传 ${OPTION_PRIVATE_KEY}，` +
        `或执行 unset ${ENV_PRIVATE_KEY}`,
    )
    return {
      path: undefined,
      pathOrigin: `${ENV_PRIVATE_KEY} 环境变量`,
      data,
      dataOrigin: `${ENV_PRIVATE_KEY_DATA} 环境变量`,
    }
  }
  return {
    path,
    pathOrigin: `${ENV_PRIVATE_KEY} 环境变量`,
    data,
    dataOrigin: `${ENV_PRIVATE_KEY_DATA} 环境变量`,
  }
}

// ------------------------------------------------------------------ huawei service-account

/**
 * 解析 Service Account 参数并本地签发 JWT。
 *
 * huawei service-account 与 huawei service-account-upload-url 共用本函数：
 * 两个命令的凭证参数、缺失项提示与 JWT 内容必须完全一致，所以只保留这一份解析逻辑
 * （选项优先、环境变量兜底；--kid、--iss、私钥来源三项缺一不可）。
 *
 * @param {Map<string, string | true>} options parseOptions 的解析结果
 * @param {NodeJS.ProcessEnv} env 进程环境变量
 * @param {() => string} help 出错时附带的帮助文档（传函数是为了不在正常路径上白渲染）
 * @returns {{ jwt: string, jwtHeader: object, jwtClaims: object, privateKey: { description: string, content: string } }}
 */
function resolveServiceAccountSigning(options, env, help) {
  const privateKeySource = collectPrivateKeySources(options, env, help)

  // --kid、--iss 必填：命令行选项优先，其次环境变量
  const kid = options.get(OPTION_KID) ?? readEnv(env, ENV_KID)
  const iss = options.get(OPTION_ISS) ?? readEnv(env, ENV_ISS)

  // 一次性列出全部缺失的必填项，避免调用方逐个试错；顺序与帮助文档的「选项」一致
  const missing = []
  if (kid === undefined) {
    missing.push(`${OPTION_KID}（密钥 ID），可用环境变量 ${ENV_KID}`)
  }
  if (iss === undefined) {
    missing.push(`${OPTION_ISS}（签发者），可用环境变量 ${ENV_ISS}`)
  }
  if (privateKeySource.path === undefined && privateKeySource.data === undefined) {
    missing.push(
      `${OPTION_PRIVATE_KEY}（文件路径）或 ${OPTION_PRIVATE_KEY_DATA}（PEM 数据），` +
        `可用环境变量 ${ENV_PRIVATE_KEY} / ${ENV_PRIVATE_KEY_DATA}`,
    )
  }
  if (missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${missing.join('；')}`, help())
  }

  // 1. PEM 数据：--private-key-data "$(cat private.pem)" / HUAWEI_PRIVATE_KEY_DATA
  // 2. 文件路径：--private-key ./private.pem / HUAWEI_PRIVATE_KEY
  // 两者都由 collectPrivateKeySources 保证不会同时出现
  const privateKey =
    privateKeySource.data !== undefined
      ? privateKeyFromData(privateKeySource.data, help, privateKeySource.dataOrigin)
      : privateKeyFromFile(privateKeySource.path, help, privateKeySource.pathOrigin)

  // --iat 可选：选项优先、环境变量其次，两处都没有则取当前时间，给出时必须是 UTC 秒级时间戳
  const iatOption = options.get(OPTION_IAT) ?? readEnv(env, ENV_IAT)
  let iat
  if (iatOption !== undefined) {
    iat = Number(iatOption)
    if (!/^\d+$/.test(iatOption) || !Number.isSafeInteger(iat)) {
      // 报错时点明值来自选项还是环境变量，否则只写 "--iat" 会让人找不到该改哪里
      const source = options.has(OPTION_IAT) ? `选项 "${OPTION_IAT}"` : `环境变量 ${ENV_IAT}`
      throw new UsageError(
        `${source} 需要 UTC 秒级时间戳（非负整数），实际收到 "${iatOption}"`,
        help(),
      )
    }
  }

  // jwtHeader / jwtClaims 是真实值（kid、iss 完整），日志里只打印掩码版本
  const jwtHeader = createJwtHeader(kid)
  const jwtClaims = createJwtClaims({ iss, iat })

  return {
    jwt: signJwt({ header: jwtHeader, claims: jwtClaims, privateKey: privateKey.content }),
    jwtHeader,
    jwtClaims,
    privateKey,
  }
}

/**
 * 调用 resolveServiceAccountSigning 并统一处理两类失败：
 *   - 用法错误（UsageError）：继续抛出，由根命令打印错误日志 + 对应帮助文档
 *   - 运行期错误（私钥不可用等）：打印错误日志并返回 null，调用方据此返回退出代码 1（不打印帮助文档）
 */
function issueServiceAccountJwt(options, env, help) {
  try {
    return resolveServiceAccountSigning(options, env, help)
  } catch (error) {
    if (error instanceof UsageError) {
      throw error
    }
    stderr(`错误: JWT 签名失败: ${error.message}`)
    return null
  }
}

/** --verbose 时打印 JWT 的掩码信息（两个命令共用；kid、iss 只展示掩码，私钥来源用描述文本） */
function logJwtDetails(signed) {
  stderr(`  JWT 头:   ${JSON.stringify(maskJwtHeader(signed.jwtHeader))}`)
  stderr(`  JWT 载荷: ${JSON.stringify(maskJwtClaims(signed.jwtClaims))}`)
  stderr(`  私钥来源: ${signed.privateKey.description}`)
}

/** huawei service-account：解析选项、校验必填项，然后用私钥签发 JWT */
function runHuaweiServiceAccount(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderHuaweiServiceAccountHelp())
    return EXIT_OK
  }

  const options = parseOptions(argv, SERVICE_ACCOUNT_OPTIONS, renderHuaweiServiceAccountHelp, SERVICE_ACCOUNT_FLAGS)
  const verbose = resolveVerbose(options, env, renderHuaweiServiceAccountHelp)

  const signed = issueServiceAccountJwt(options, env, renderHuaweiServiceAccountHelp)
  if (signed === null) {
    return EXIT_FAILURE
  }

  // 默认只输出 Token：stdout 写签名结果，stderr 保持干净，便于 `JWT=$(...)` 与管道取用；
  // 需要排查时加 --verbose 才打印下面这些（掩码后的）运行日志。
  // 顺序上先日志、后 Token：在终端里日志在上、结果落在最后一行，方便复制。
  if (verbose) {
    stderr('已生成 JWT 签名（PS256）')
    logJwtDetails(signed)
  }
  stdout(signed.jwt)
  return EXIT_OK
}

// ------------------------------------------------------- AGC Connect API 通用

/** 用 client_id + client_secret 换取 access_token 的接口路径 */
const CLIENT_CREDENTIALS_PATH = '/api/oauth2/v1/token'
/** AGC Connect API 域名（中国大陆）；其他区域是 connect-api-dre/dra/drru.cloud.huawei.com */
export const API_BASE_CN = 'https://connect-api.cloud.huawei.com'

/**
 * 解析华为接口响应，统一处理三类失败（各接口共用）。
 *
 *   1. HTTP 非 2xx —— 网关/服务层拒绝，常见形态是 403/401 且响应体为空
 *   2. 响应体为空或非 JSON
 *   3. HTTP 200 但业务层 ret.code 非 0 —— 华为把业务错误也放在 200 里返回
 *
 * @param {Response} response fetch 响应
 * @param {string} text 已读取的响应体
 * @param {string} target 请求地址（含域名），用于错误信息里定位；区域不同域名不同，必须带上
 */
function parseAgcResponse(response, text, target) {
  if (!response.ok) {
    // 失败时把状态行与响应体一并带出来：状态行里的 reason phrase 往往才是关键信息
    // （例如 403 do not has permission），丢掉它只剩空响应体就无从判断
    const detail = text === '' ? '（响应体为空）' : text.slice(0, 300)
    let ret = ''
    try {
      const parsed = JSON.parse(text)
      if (parsed?.ret?.code !== undefined) {
        ret = ` ret.code=${parsed.ret.code} ${parsed.ret.msg ?? ''}`
      }
    } catch {
      // 失败响应本来就可能不是 JSON，直接用原文
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}${ret} @ ${target}: ${detail}`)
  }

  if (text === '') {
    throw new Error(`HTTP ${response.status} 但响应体为空 @ ${target}`)
  }

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`响应不是合法 JSON（HTTP ${response.status}）: ${text.slice(0, 200)}`)
  }

  const code = data?.ret?.code
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`AGC 返回错误码 ${code}: ${data.ret?.msg ?? '(无描述)'}`)
  }
  return data
}


/**
 * 用 API 客户端的 client_id + client_secret 换取 access_token。
 *
 *   POST {apiBase}/api/oauth2/v1/token
 *   Content-Type: application/json
 *   { "grant_type": "client_credentials", "client_id": …, "client_secret": … }
 *
 * 与 Service Account 的区别：这条链路拿到的是 access_token 本身
 * （后续按 Authorization: Bearer <access_token> 调用业务接口）。
 *
 * @param {{ clientId: string, clientSecret: string, apiBase?: string, timeoutMs?: number }} params
 * @returns {Promise<object>} 接口原始响应：{ access_token, token_type, expires_in, … }
 */
export async function fetchClientCredentialsToken({
  clientId,
  clientSecret,
  apiBase = API_BASE_CN,
  timeoutMs = 60_000,
}) {
  const url = `${apiBase}${CLIENT_CREDENTIALS_PATH}`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`请求 ${url} 失败: ${error.message}`)
  }

  const text = await response.text()
  return parseAgcResponse(response, text, url)
}


/** AGC「获取文件上传地址」接口路径（Service Account 与 API 客户端两种认证方式共用） */
const UPLOAD_URL_PATH = '/api/publish/v2/upload-url/for-obs'

/**
 * 获取文件上传地址（Upload Management API）。
 *
 *   GET {apiBase}/api/publish/v2/upload-url/for-obs?appId=…&fileName=…&contentLength=…
 *   Authorization: Bearer <Service Account JWT 或 access_token>
 *   client_id: <客户端 ID>   —— 仅 API 客户端（client_credentials）方式需要
 *
 * 三个查询参数都是必填：华为侧按 Java Long 反序列化 appId 与 contentLength，
 * 参数缺失或非法一律返回 HTTP 400（响应体是 { "message": … }，没有 ret 字段）。
 *
 * @param {{ token: string, appId: string, fileName: string, contentLength: string | number, clientId?: string, apiBase?: string, timeoutMs?: number }} params
 * @returns {Promise<object>} 接口原始响应：{ ret, urlInfo: { objectId, url, method, headers } }
 */
export async function fetchUploadUrl({
  token,
  appId,
  fileName,
  contentLength,
  clientId,
  apiBase = API_BASE_CN,
  timeoutMs = 60_000,
}) {
  // 用 URL 拼查询串：fileName 里的中文、空格等字符会按需百分号编码
  const url = new URL(`${apiBase}${UPLOAD_URL_PATH}`)
  url.searchParams.set('appId', appId)
  url.searchParams.set('fileName', fileName)
  url.searchParams.set('contentLength', String(contentLength))

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
  if (clientId !== undefined) {
    // API 客户端方式要求同时携带 client_id；实测多带这个头不影响 Service Account 方式（同样 200）
    headers.client_id = clientId
  }

  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`请求 ${url} 失败: ${error.message}`)
  }

  const text = await response.text()
  return parseAgcResponse(response, text, url.toString())
}


// ------------------------------------------------- huawei client-credentials

/** huawei client-credentials：用 API 客户端凭证换取 access_token */
async function runHuaweiClientCredentials(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderHuaweiClientCredentialsHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    CLIENT_CREDENTIALS_OPTIONS,
    renderHuaweiClientCredentialsHelp,
    CLIENT_CREDENTIALS_FLAGS,
  )
  const verbose = resolveVerbose(options, env, renderHuaweiClientCredentialsHelp)

  const clientId = options.get(OPTION_CLIENT_ID) ?? readEnv(env, ENV_CLIENT_ID)
  const clientSecret = options.get(OPTION_CLIENT_SECRET) ?? readEnv(env, ENV_CLIENT_SECRET)

  const missing = []
  if (clientId === undefined) {
    missing.push(`${OPTION_CLIENT_ID}（客户端 ID），可用环境变量 ${ENV_CLIENT_ID}`)
  }
  if (clientSecret === undefined) {
    missing.push(`${OPTION_CLIENT_SECRET}（客户端密钥），可用环境变量 ${ENV_CLIENT_SECRET}`)
  }
  if (missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${missing.join('；')}`, renderHuaweiClientCredentialsHelp())
  }

  // 域名可用 HUAWEI_API_BASE 覆盖（区域不同域名不同），所以日志里打印实际用到的地址
  const apiBase = readEnv(env, ENV_API_BASE) ?? API_BASE_CN

  let data
  try {
    data = await fetchClientCredentialsToken({ clientId, clientSecret, apiBase })
  } catch (error) {
    // 网络/接口失败属于运行期问题，不是用法问题，所以只报错不打印帮助文档
    stderr(`错误: 获取 access_token 失败: ${error.message}`)
    return EXIT_FAILURE
  }

  const accessToken = data?.access_token
  if (typeof accessToken !== 'string' || accessToken === '') {
    stderr('错误: 获取 access_token 失败: 响应中未包含 access_token')
    return EXIT_FAILURE
  }

  // 与其它命令一致：默认只输出结果，--verbose 才打印日志，且日志在前、结果在后
  // client_id 与 client_secret 都只输出掩码版本，避免密钥落进日志
  if (verbose) {
    stderr('已获取 access_token')
    stderr(`  请求地址:      POST ${apiBase}${CLIENT_CREDENTIALS_PATH}`)
    stderr(`  client_id:     ${maskValue(clientId)}`)
    stderr(`  client_secret: ${maskValue(clientSecret)}`)
    // 这两个字段华为不一定都返回，缺哪个就不打印哪个，避免出现「未返回」这种噪音
    if (data.token_type !== undefined) {
      stderr(`  token_type:    ${data.token_type}`)
    }
    if (data.expires_in !== undefined) {
      stderr(`  expires_in:    ${data.expires_in} 秒`)
    }
  }
  stdout(accessToken)
  return EXIT_OK
}

// ------------------------------------------- 文件上传地址命令的公共部分

/**
 * 环境变量里是否已有完整的 Service Account 凭证。
 *
 * 只在「命令行既没有 service-account 参数、也没有 --token」时才会用到，
 * 也就是优先级最低的一档，保证 source 了 .env 的环境里仍可直接执行本命令。
 */
function hasEnvServiceAccountCredentials(env) {
  return (
    readEnv(env, ENV_KID) !== undefined &&
    readEnv(env, ENV_ISS) !== undefined &&
    (readEnv(env, ENV_PRIVATE_KEY) !== undefined || readEnv(env, ENV_PRIVATE_KEY_DATA) !== undefined)
  )
}

/**
 * appId、contentLength 在华为侧都是 Java Long，非法值只会换来 HTTP 400 的反序列化堆栈，
 * 因此这里先按「十进制非负整数」拦下，错误信息对调用方更友好。
 */
function assertNonNegativeInteger(value, option, label, help) {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`选项 "${option}" 需要${label}（非负整数），实际收到 "${value}"`, help())
  }
}

/**
 * 收集两个 upload-url 命令共用的应用与文件参数（选项优先，其次环境变量）。
 *
 * 缺失项不在这里抛错，而是回传 missing 数组：调用方要把它与「Token 来源缺失」等其它问题
 * 合并成一条错误信息，避免调用方逐个试错。
 *
 * @returns {{ appId?: string, fileName?: string, contentLength?: string, missing: string[] }}
 */
function collectUploadUrlParams(options, env) {
  const appId = options.get(OPTION_APP_ID) ?? readEnv(env, ENV_APP_ID)
  const fileName = options.get(OPTION_FILE_NAME) ?? readEnv(env, ENV_FILE_NAME)
  const contentLength = options.get(OPTION_CONTENT_LENGTH) ?? readEnv(env, ENV_CONTENT_LENGTH)

  const missing = []
  if (appId === undefined) {
    missing.push(`${OPTION_APP_ID}（应用 ID），可用环境变量 ${ENV_APP_ID}`)
  }
  if (fileName === undefined) {
    missing.push(`${OPTION_FILE_NAME}（文件名），可用环境变量 ${ENV_FILE_NAME}`)
  }
  if (contentLength === undefined) {
    missing.push(`${OPTION_CONTENT_LENGTH}（文件大小，字节），可用环境变量 ${ENV_CONTENT_LENGTH}`)
  }
  return { appId, fileName, contentLength, missing }
}

/** --token 模式下日志里展示的来源名（区分命令行与环境变量，两个 upload-url 命令共用） */
function tokenOptionSource(options) {
  return options.get(OPTION_TOKEN) !== undefined ? OPTION_TOKEN : `${ENV_TOKEN} 环境变量`
}

/**
 * 请求「获取文件上传地址」并按统一约定输出（两个 upload-url 命令共用）：
 *   stdout —— 接口原始响应 JSON（含上传必需的 urlInfo.method 与 urlInfo.headers）
 *   stderr —— --verbose 的运行日志（Token、client_id 只打印掩码）
 *
 * @returns {Promise<number>} 退出代码（EXIT_OK / EXIT_FAILURE）
 */
async function fetchUploadUrlAndPrint({
  token,
  tokenSource,
  clientId,
  appId,
  fileName,
  contentLength,
  apiBase,
  verbose,
}) {
  let data
  try {
    data = await fetchUploadUrl({ token, clientId, appId, fileName, contentLength, apiBase })
  } catch (error) {
    // 网络/接口失败属于运行期问题，不是用法问题，所以只报错不打印帮助文档
    stderr(`错误: 获取文件上传地址失败: ${error.message}`)
    return EXIT_FAILURE
  }

  const urlInfo = data?.urlInfo
  if (typeof urlInfo?.url !== 'string' || urlInfo.url === '') {
    stderr('错误: 获取文件上传地址失败: 响应中未包含 urlInfo.url')
    return EXIT_FAILURE
  }

  if (verbose) {
    stderr('已获取文件上传地址')
    stderr(`  请求地址:      GET ${apiBase}${UPLOAD_URL_PATH}`)
    stderr(`  Token 来源:    ${tokenSource}`)
    stderr(`  Token:         ${maskValue(token)}`)
    if (clientId !== undefined) {
      stderr(`  client_id:     ${maskValue(clientId)}`)
    }
    stderr(`  appId:         ${appId}`)
    stderr(`  fileName:      ${fileName}`)
    stderr(`  contentLength: ${contentLength}`)
    if (urlInfo.objectId !== undefined) {
      stderr(`  objectId:      ${urlInfo.objectId}`)
    }
    stderr(`  上传方式:      ${urlInfo.method} ${urlInfo.url}`)
  }

  // 默认输出接口原始响应 JSON：上传文件必须用到 urlInfo.method 与 urlInfo.headers，
  // 只输出 url 会丢掉这两项（响应其它字段也一并保留，便于按需 jq 取用）
  stdout(JSON.stringify(data))
  return EXIT_OK
}

// --------------------------------------- huawei service-account-upload-url

/**
 * huawei service-account-upload-url：先用 Service Account 确定 Token，再换取文件上传地址。
 *
 * Token 来源优先级（高 → 低）：
 *   1. 命令行显式给出的 service-account 参数（--kid/--iss/--private-key/--private-key-data）
 *      —— 本地签发 JWT，缺失的项仍可用 HUAWEI_KID/HUAWEI_ISS/HUAWEI_PRIVATE_KEY 补齐
 *   2. --token（或环境变量 HUAWEI_TOKEN）—— 直接使用已签发的 Token
 *   3. 环境变量里已有的完整 Service Account 凭证 —— 本地签发 JWT
 *
 * 把 --token 排在环境变量之前，是为了让 source 了 .env 的环境里 --token 依然生效；
 * 把显式 service-account 参数排在 --token 之前，则是「本地签发优先」。
 */
async function runHuaweiServiceAccountUploadUrl(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderHuaweiServiceAccountUploadUrlHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    SERVICE_ACCOUNT_UPLOAD_URL_OPTIONS,
    renderHuaweiServiceAccountUploadUrlHelp,
    SERVICE_ACCOUNT_UPLOAD_URL_FLAGS,
  )
  const verbose = resolveVerbose(options, env, renderHuaweiServiceAccountUploadUrlHelp)

  const { appId, fileName, contentLength, missing } = collectUploadUrlParams(options, env)
  const token = options.get(OPTION_TOKEN) ?? readEnv(env, ENV_TOKEN)

  const usesServiceAccountOptions = [
    OPTION_KID,
    OPTION_ISS,
    OPTION_PRIVATE_KEY,
    OPTION_PRIVATE_KEY_DATA,
  ].some((name) => options.has(name))
  if (!usesServiceAccountOptions && token === undefined && !hasEnvServiceAccountCredentials(env)) {
    missing.push(
      `${OPTION_TOKEN}（Service Account Token），或 service-account 参数（${OPTION_KID} / ${OPTION_ISS} / ` +
        `${OPTION_PRIVATE_KEY} / ${OPTION_PRIVATE_KEY_DATA}，本地签发 Token）`,
    )
  }
  if (missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${missing.join('；')}`, renderHuaweiServiceAccountUploadUrlHelp())
  }

  // 这两个参数在华为侧都是 Java Long，先本地校验，避免拿到 HTTP 400 的反序列化报错
  assertNonNegativeInteger(appId, OPTION_APP_ID, '应用 ID', renderHuaweiServiceAccountUploadUrlHelp)
  assertNonNegativeInteger(
    contentLength,
    OPTION_CONTENT_LENGTH,
    '文件大小（字节）',
    renderHuaweiServiceAccountUploadUrlHelp,
  )

  let accessToken
  let tokenSource
  if (usesServiceAccountOptions || token === undefined) {
    // 本地签发：命令行显式给出 service-account 参数，或没有任何 Token 但环境变量里凭证齐全
    const signed = issueServiceAccountJwt(options, env, renderHuaweiServiceAccountUploadUrlHelp)
    if (signed === null) {
      return EXIT_FAILURE
    }
    accessToken = signed.jwt
    tokenSource = usesServiceAccountOptions ? 'service-account 参数（本地签发）' : '环境变量凭证（本地签发）'
    if (verbose) {
      stderr('已生成 JWT 签名（PS256）')
      logJwtDetails(signed)
    }
  } else {
    accessToken = token
    tokenSource = tokenOptionSource(options)
  }

  return fetchUploadUrlAndPrint({
    token: accessToken,
    tokenSource,
    appId,
    fileName,
    contentLength,
    // 域名可用 HUAWEI_API_BASE 覆盖（区域不同域名不同），所以日志里打印实际用到的地址
    apiBase: readEnv(env, ENV_API_BASE) ?? API_BASE_CN,
    verbose,
  })
}

// ------------------------------------ huawei client-credentials-upload-url

/**
 * huawei client-credentials-upload-url：先用 API 客户端凭证换 access_token，再换取文件上传地址。
 *
 * Token 来源优先级（高 → 低）：
 *   1. 命令行显式给出的 client-credentials 参数（--client-id / --client-secret）
 *      —— 本地换取 access_token，缺失的项仍可用 HUAWEI_CLIENT_ID / HUAWEI_CLIENT_SECRET 补齐
 *   2. --token（或环境变量 HUAWEI_TOKEN）—— 直接使用已换取的 access_token
 *   3. 环境变量里已有的完整 API 客户端凭证 —— 本地换取 access_token
 *
 * 与 Service Account 方式的差别：API 客户端方式按华为要求还要带 client_id 请求头。
 * 本地换取时一定知道 client_id，必然带上；用 --token 时，只要给得出 client_id
 * （--client-id 或 HUAWEI_CLIENT_ID）就一并带上。实测多带这个头不影响 Service Account 方式。
 */
async function runHuaweiClientCredentialsUploadUrl(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderHuaweiClientCredentialsUploadUrlHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    CLIENT_CREDENTIALS_UPLOAD_URL_OPTIONS,
    renderHuaweiClientCredentialsUploadUrlHelp,
    CLIENT_CREDENTIALS_UPLOAD_URL_FLAGS,
  )
  const verbose = resolveVerbose(options, env, renderHuaweiClientCredentialsUploadUrlHelp)

  const { appId, fileName, contentLength, missing } = collectUploadUrlParams(options, env)
  const clientId = options.get(OPTION_CLIENT_ID) ?? readEnv(env, ENV_CLIENT_ID)
  const clientSecret = options.get(OPTION_CLIENT_SECRET) ?? readEnv(env, ENV_CLIENT_SECRET)
  const token = options.get(OPTION_TOKEN) ?? readEnv(env, ENV_TOKEN)

  const canExchangeToken = clientId !== undefined && clientSecret !== undefined
  const usesClientCredentialsOptions = [OPTION_CLIENT_ID, OPTION_CLIENT_SECRET].some((name) => options.has(name))
  // 换取 access_token 需要客户端 ID 与密钥都齐全（缺的项可由环境变量补齐）；
  // 只有「命令行给了客户端参数」或「根本没有 --token」时才真的走换取，否则 --token 优先。
  // 这样 `--client-id X --token Y`（已有 access_token，只是补一个 client_id 头）不会被误判成
  // 缺少 --client-secret——帮助文档里写明这种用法是允许的。
  const exchangesToken = canExchangeToken && (usesClientCredentialsOptions || token === undefined)
  if (!exchangesToken && token === undefined) {
    if (clientId === undefined && clientSecret === undefined) {
      missing.push(
        `${OPTION_TOKEN}（access_token），或 client-credentials 参数（${OPTION_CLIENT_ID} / ` +
          `${OPTION_CLIENT_SECRET}，本地换取 access_token）`,
      )
    } else {
      // 只给了一个客户端参数：把缺的另一个点出来，比笼统提示更好定位
      if (clientId === undefined) {
        missing.push(`${OPTION_CLIENT_ID}（客户端 ID），可用环境变量 ${ENV_CLIENT_ID}`)
      }
      if (clientSecret === undefined) {
        missing.push(`${OPTION_CLIENT_SECRET}（客户端密钥），可用环境变量 ${ENV_CLIENT_SECRET}`)
      }
    }
  }
  if (missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${missing.join('；')}`, renderHuaweiClientCredentialsUploadUrlHelp())
  }

  // 这两个参数在华为侧都是 Java Long，先本地校验，避免拿到 HTTP 400 的反序列化报错
  assertNonNegativeInteger(appId, OPTION_APP_ID, '应用 ID', renderHuaweiClientCredentialsUploadUrlHelp)
  assertNonNegativeInteger(
    contentLength,
    OPTION_CONTENT_LENGTH,
    '文件大小（字节）',
    renderHuaweiClientCredentialsUploadUrlHelp,
  )

  // 域名可用 HUAWEI_API_BASE 覆盖（区域不同域名不同），所以日志里打印实际用到的地址
  const apiBase = readEnv(env, ENV_API_BASE) ?? API_BASE_CN

  let accessToken
  let tokenSource
  if (exchangesToken) {
    // 本地换取：命令行显式给出客户端参数，或没有任何 Token 但环境变量里凭证齐全
    let data
    try {
      data = await fetchClientCredentialsToken({ clientId, clientSecret, apiBase })
    } catch (error) {
      // 网络/接口失败属于运行期问题，不是用法问题，所以只报错不打印帮助文档
      stderr(`错误: 获取 access_token 失败: ${error.message}`)
      return EXIT_FAILURE
    }

    const fetched = data?.access_token
    if (typeof fetched !== 'string' || fetched === '') {
      stderr('错误: 获取 access_token 失败: 响应中未包含 access_token')
      return EXIT_FAILURE
    }
    accessToken = fetched
    tokenSource = usesClientCredentialsOptions
      ? 'client-credentials 参数（本地换取）'
      : '环境变量凭证（本地换取）'

    // client_id 与 client_secret 只输出掩码版本，避免密钥落进日志
    if (verbose) {
      stderr('已换取 access_token')
      stderr(`  请求地址:      POST ${apiBase}${CLIENT_CREDENTIALS_PATH}`)
      stderr(`  client_id:     ${maskValue(clientId)}`)
      stderr(`  client_secret: ${maskValue(clientSecret)}`)
      // 这两个字段华为不一定都返回，缺哪个就不打印哪个，避免出现「未返回」这种噪音
      if (data.token_type !== undefined) {
        stderr(`  token_type:    ${data.token_type}`)
      }
      if (data.expires_in !== undefined) {
        stderr(`  expires_in:    ${data.expires_in} 秒`)
      }
    }
  } else {
    accessToken = token
    tokenSource = tokenOptionSource(options)
  }

  return fetchUploadUrlAndPrint({
    token: accessToken,
    tokenSource,
    // API 客户端方式需要 client_id 头：本地换取时必然知道，--token 模式下知道就带上
    clientId,
    appId,
    fileName,
    contentLength,
    apiBase,
    verbose,
  })
}

// ------------------------------------------------------------------ 帮助文档

/** huawei 帮助文档：huawei、huawei help、huawei --help */
function renderHuaweiHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei - 华为应用市场`,
    usage: [`${PROGRAM} huawei <命令> [选项]`],
    sections: [
      {
        title: '命令',
        entries: [
          ['service-account', '签发 Service Account JWT'],
          ['service-account-upload-url', '获取文件上传地址（Service Account）'],
          ['client-credentials', '获取 access_token（API 客户端）'],
          ['client-credentials-upload-url', '获取文件上传地址（API 客户端）'],
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
      `  ${PROGRAM} huawei service-account --kid <密钥ID> --iss <签发者> --private-key ./private.pem`,
      `  ${PROGRAM} huawei service-account-upload-url --app-id <应用ID> --file-name a1.apk --content-length 111223 \\`,
      `    --kid <密钥ID> --iss <签发者> --private-key ./private.pem`,
    ],
  })
}

/**
 * 华为原始文档：获取服务器鉴权（Service Account JWT）。
 *
 * 帮助文档里给出出处，便于对照华为侧的参数含义与固定值要求。
 */
const AUTH_DOC_URL =
  'https://developer.huawei.com/consumer/cn/doc/doccenter-connect-api/agc-help-connect-api-obtain-server-auth-0000002271134661'

/** huawei service-account 帮助文档：参数缺失时的提示输出、以及 --help */
function renderHuaweiServiceAccountHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei service-account - 签发 Service Account JWT`,
    usage: [`${PROGRAM} huawei service-account [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          ['--kid <密钥 ID>', 'JWT 请求头中的 kid，必填'],
          ['--iss <签发者>', 'JWT 载荷中的 iss，必填'],
          ['--private-key <文件>', '私钥 PEM 文件路径（与 --private-key-data 二选一，必填）'],
          ['--private-key-data <PEM>', '直接传入私钥 PEM 数据（与 --private-key 二选一，必填）'],
          ['--iat <秒>', `JWT 签发时间（UTC 秒级时间戳），默认当前时间（可用 ${ENV_IAT} 补齐）`],
          ['--verbose', `输出运行日志（默认只输出结果，日志不打印）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_KID, '密钥 ID，等价于 --kid'],
          [ENV_ISS, '签发者，等价于 --iss'],
          [ENV_PRIVATE_KEY, '私钥 PEM 文件路径，等价于 --private-key'],
          [ENV_PRIVATE_KEY_DATA, '私钥 PEM 数据，等价于 --private-key-data'],
          [ENV_IAT, 'JWT 签发时间（UTC 秒级时间戳），等价于 --iat'],
          [ENV_VERBOSE, '输出运行日志，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
        ],
      },
      {
        title: 'JWT 头',
        entries: [
          ['alg', `${JWT_HEADER_ALG}（华为固定值，不可修改）`],
          ['typ', `${JWT_HEADER_TYP}（华为固定值，不可修改）`],
          ['kid', `取自 --kid，未指定时读取环境变量 ${ENV_KID}；日志中部分掩码显示（如 abcd****wxyz）`],
        ],
      },
      {
        title: 'JWT 载荷',
        entries: [
          ['iss', `JWT 签发者；取自 --iss，未指定时读取环境变量 ${ENV_ISS}；日志中部分掩码显示（如 abcd****wxyz）`],
          ['aud', `${JWT_CLAIM_AUD}（华为固定值，不可修改）`],
          ['iat', `JWT 签发时间，UTC 秒级时间戳；默认当前时间，可用 --iat 或环境变量 ${ENV_IAT} 覆盖`],
          ['exp', `JWT 到期时间，UTC 秒级时间戳；恒为 iat + ${JWT_CLAIM_EXP_OFFSET_SECONDS} 秒`],
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
      `  ${PROGRAM} huawei service-account --kid <密钥ID> --iss <签发者> --private-key ./private.pem`,
      `  ${PROGRAM} huawei service-account --kid <密钥ID> --iss <签发者> --private-key ./private.pem --verbose`,
      `  ${PROGRAM} huawei service-account --kid <密钥ID> --iss <签发者> --private-key-data "$(cat private.pem)"`,
      `  ${ENV_KID}=<密钥ID> ${ENV_ISS}=<签发者> ${ENV_PRIVATE_KEY}=./private.pem ${PROGRAM} huawei service-account`,
      `  ${ENV_KID}=<密钥ID> ${ENV_ISS}=<签发者> ${ENV_PRIVATE_KEY_DATA}="$(cat private.pem)" ${PROGRAM} huawei service-account`,
      `  ${ENV_KID}=<密钥ID> ${ENV_ISS}=<签发者> ${ENV_PRIVATE_KEY}=./private.pem ${ENV_IAT}=1700000000 ${PROGRAM} huawei service-account`,
      '',
      `说明: --private-key 与 --private-key-data 不能同时使用；环境变量层两者都有时优先用 ${ENV_PRIVATE_KEY_DATA}（数据优先）并在 stderr 提示`,
      `说明: 私钥路径在错误信息与 --verbose 日志中掩码显示（如 /Use*****.pem），私钥数据不会写入日志`,
      `说明: 命令行给出 --private-key / --private-key-data 时不再读取上述两个私钥环境变量`,
      `说明: --iat、--verbose 都是「选项优先、环境变量兜底」：命令行给出选项时 ${ENV_IAT} / ${ENV_VERBOSE} 不再生效`,
      `说明: 默认只把 JWT 写到 stdout，不打印任何日志；加 --verbose（或 ${ENV_VERBOSE}=1）才输出运行日志（stderr，先日志后结果）`,
      `说明: 输出的 PS256 JWT 可直接作为 Authorization: Bearer 令牌使用，无需再换 access_token`,
      `原始文档: ${AUTH_DOC_URL}`,
    ],
  })
}


/** 华为原始文档：获取文件上传地址（Upload Management API） */
const UPLOAD_URL_DOC_URL =
  'https://developer.huawei.com/consumer/cn/doc/doccenter-connect-api/agc-help-upload-api-upload-url-0000002236201294'

/**
 * 两个 upload-url 命令共用的帮助片段：应用与文件参数、输出与退出代码、上传示例。
 * 两个命令的差别只在「Token 怎么来」，这些内容必须保持一致，所以只写一份。
 */
const UPLOAD_URL_PARAM_OPTIONS = [
  ['--app-id <应用 ID>', 'AppGallery Connect 的 appId（非负整数），必填'],
  ['--file-name <文件名>', '上传的文件名，如 a1.apk，必填'],
  ['--content-length <字节>', '文件大小（字节，非负整数），必填'],
]

const UPLOAD_URL_PARAM_ENV = [
  [ENV_APP_ID, '应用 ID，等价于 --app-id'],
  [ENV_FILE_NAME, '文件名，等价于 --file-name'],
  [ENV_CONTENT_LENGTH, '文件大小（字节），等价于 --content-length'],
]

/** 两个 upload-url 命令共用的「输出」与「退出代码」小节 */
function uploadUrlResultSections() {
  return [
    {
      title: '输出',
      entries: [
        ['stdout', '接口原始响应 JSON：{"ret":…,"urlInfo":{"objectId":…,"url":…,"method":…,"headers":…}}'],
        ['stderr', '--verbose 时的运行日志（Token、client_id 只打印掩码）；默认不打印'],
      ],
    },
    {
      title: '退出代码',
      entries: [
        ['0', '成功'],
        ['1', '参数缺失、参数错误或调用失败'],
      ],
    },
  ]
}

/** 两个 upload-url 命令共用的上传示例与说明；command 为子命令名（如 service-account-upload-url） */
function uploadUrlExampleNotes(command) {
  return [
    '说明: urlInfo.url 是上传地址，urlInfo.method 与 urlInfo.headers 是上传必须使用的方法与请求头',
    '上传示例（请求头见 urlInfo.headers，其中有 OBS 签名需要的信息）:',
    `  RESP=$(${PROGRAM} huawei ${command} --app-id <应用ID> --file-name a1.apk --content-length 111223)`,
    `  curl -X "$(jq -r .urlInfo.method <<<"$RESP")" -T a1.apk "$(jq -r .urlInfo.url <<<"$RESP")"`,
    `说明: 默认只把响应 JSON 写到 stdout，加 --verbose 才输出运行日志（stderr，先日志后结果）`,
    `说明: 私钥路径、Token、client_id 只以掩码形式出现在日志里，私钥数据不会写入日志`,
    `原始文档: ${UPLOAD_URL_DOC_URL}`,
  ]
}

/** huawei service-account-upload-url 帮助文档：参数缺失时的提示输出、以及 --help */
function renderHuaweiServiceAccountUploadUrlHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei service-account-upload-url - 获取文件上传地址（Service Account）`,
    usage: [`${PROGRAM} huawei service-account-upload-url [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          ...UPLOAD_URL_PARAM_OPTIONS,
          ['--token <Token>', '已签发的 Service Account Token；未给出 service-account 参数时使用'],
          ['--kid <密钥 ID>', `service-account：JWT 请求头中的 kid，给出后本地签发 Token（可用 ${ENV_KID} 补齐）`],
          ['--iss <签发者>', `service-account：JWT 载荷中的 iss（可用 ${ENV_ISS} 补齐）`],
          ['--private-key <文件>', 'service-account：私钥 PEM 文件路径（与 --private-key-data 二选一）'],
          ['--private-key-data <PEM>', 'service-account：直接传入私钥 PEM 数据（与 --private-key 二选一）'],
          ['--iat <秒>', `service-account：JWT 签发时间（UTC 秒级时间戳），默认当前时间（可用 ${ENV_IAT} 补齐）`],
          ['--verbose', `输出运行日志（默认只输出结果，日志不打印）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          ...UPLOAD_URL_PARAM_ENV,
          [ENV_TOKEN, 'Service Account Token，等价于 --token'],
          [ENV_KID, 'service-account 密钥 ID，等价于 --kid'],
          [ENV_ISS, 'service-account 签发者，等价于 --iss'],
          [ENV_PRIVATE_KEY, 'service-account 私钥 PEM 文件路径'],
          [ENV_PRIVATE_KEY_DATA, 'service-account 私钥 PEM 数据'],
          [ENV_IAT, 'service-account JWT 签发时间（UTC 秒级时间戳），等价于 --iat'],
          [ENV_VERBOSE, '输出运行日志，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
          [ENV_API_BASE, `接口域名，默认 ${API_BASE_CN}（其他区域或本地联调时覆盖）`],
        ],
      },
      {
        title: 'Token 来源（优先级从高到低）',
        entries: [
          ['1. service-account 选项', '命令行给出 --kid / --iss / --private-key / --private-key-data 时本地签发 JWT，缺失项由环境变量补齐'],
          ['2. --token', `使用给定的 Service Account Token，也可用环境变量 ${ENV_TOKEN}`],
          ['3. 环境变量凭证', `以上都没有、但 ${ENV_KID} / ${ENV_ISS} 与 ${ENV_PRIVATE_KEY}（或 ${ENV_PRIVATE_KEY_DATA}）都已设置时，本地签发 JWT`],
        ],
      },
      {
        title: '请求',
        entries: [
          ['方法', 'GET'],
          ['地址', `${API_BASE_CN}${UPLOAD_URL_PATH}?appId=…&fileName=…&contentLength=…`],
          ['头部', 'Authorization: Bearer <Service Account Token>（Service Account 的 PS256 JWT）'],
        ],
      },
      ...uploadUrlResultSections(),
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} huawei service-account-upload-url --app-id <应用ID> --file-name a1.apk --content-length 111223 --token <Token>`,
      `  ${PROGRAM} huawei service-account-upload-url --app-id <应用ID> --file-name a1.apk --content-length 111223 \\`,
      `    --kid <密钥ID> --iss <签发者> --private-key ./private.pem`,
      `  ${ENV_APP_ID}=<应用ID> ${ENV_FILE_NAME}=a1.apk ${ENV_CONTENT_LENGTH}=111223 ${ENV_TOKEN}=<Token> ${PROGRAM} huawei service-account-upload-url`,
      '',
      `说明: --iat 与 ${ENV_IAT} 只作用于本地签发的 JWT，用 --token 时忽略`,
      ...uploadUrlExampleNotes('service-account-upload-url'),
    ],
  })
}

/** huawei client-credentials-upload-url 帮助文档：参数缺失时的提示输出、以及 --help */
function renderHuaweiClientCredentialsUploadUrlHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei client-credentials-upload-url - 获取文件上传地址（API 客户端）`,
    usage: [`${PROGRAM} huawei client-credentials-upload-url [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          ...UPLOAD_URL_PARAM_OPTIONS,
          ['--token <access_token>', '已换取的 access_token；本地换取未触发时使用（也可与 --client-id 搭配，仅补 client_id 头）'],
          [
            '--client-id <客户端 ID>',
            `client-credentials：API 客户端 ID，给出后本地换取 access_token（可用 ${ENV_CLIENT_ID} 补齐）`,
          ],
          ['--client-secret <密钥>', `client-credentials：API 客户端密钥（可用 ${ENV_CLIENT_SECRET} 补齐）`],
          ['--verbose', `输出运行日志（默认只输出结果，日志不打印）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          ...UPLOAD_URL_PARAM_ENV,
          [ENV_TOKEN, 'access_token，等价于 --token'],
          [ENV_CLIENT_ID, 'API 客户端 ID，等价于 --client-id'],
          [ENV_CLIENT_SECRET, 'API 客户端密钥，等价于 --client-secret'],
          [ENV_VERBOSE, '输出运行日志，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
          [ENV_API_BASE, `接口域名，默认 ${API_BASE_CN}（其他区域或本地联调时覆盖）`],
        ],
      },
      {
        title: 'Token 来源（优先级从高到低）',
        entries: [
          ['1. client-credentials 选项', '命令行同时给出 --client-id 与 --client-secret（缺的项由环境变量补齐）时本地换取 access_token'],
          ['2. --token', `使用给定的 access_token，也可用环境变量 ${ENV_TOKEN}`],
          ['3. 环境变量凭证', `以上都没有、但 ${ENV_CLIENT_ID} / ${ENV_CLIENT_SECRET} 都已设置时，本地换取 access_token`],
        ],
      },
      {
        title: '请求',
        entries: [
          ['方法', 'GET'],
          ['地址', `${API_BASE_CN}${UPLOAD_URL_PATH}?appId=…&fileName=…&contentLength=…`],
          ['头部', 'Authorization: Bearer <access_token> 与 client_id: <客户端 ID>（API 客户端方式两个都要）'],
        ],
      },
      ...uploadUrlResultSections(),
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} huawei client-credentials-upload-url --app-id <应用ID> --file-name a1.apk --content-length 111223 --token <access_token>`,
      `  ${PROGRAM} huawei client-credentials-upload-url --app-id <应用ID> --file-name a1.apk --content-length 111223 \\`,
      `    --client-id <客户端ID> --client-secret <客户端密钥>`,
      `  ${ENV_APP_ID}=<应用ID> ${ENV_FILE_NAME}=a1.apk ${ENV_CONTENT_LENGTH}=111223 \\`,
      `    ${ENV_CLIENT_ID}=<客户端ID> ${ENV_CLIENT_SECRET}=<密钥> ${PROGRAM} huawei client-credentials-upload-url`,
      '',
      `说明: 用 --token 时，只要给得出 client_id（${OPTION_CLIENT_ID} 或 ${ENV_CLIENT_ID}）就一并作为 client_id 头发出`,
      ...uploadUrlExampleNotes('client-credentials-upload-url'),
    ],
  })
}


/** huawei client-credentials 帮助文档：参数缺失时的提示输出、以及 --help */
function renderHuaweiClientCredentialsHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei client-credentials - 获取 access_token（client_credentials）`,
    usage: [`${PROGRAM} huawei client-credentials [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          ['--client-id <客户端 ID>', 'API 客户端 ID，必填'],
          ['--client-secret <密钥>', 'API 客户端密钥，必填'],
          ['--verbose', `输出运行日志（默认只输出 access_token，日志不打印）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_CLIENT_ID, 'API 客户端 ID，等价于 --client-id'],
          [ENV_CLIENT_SECRET, 'API 客户端密钥，等价于 --client-secret'],
          [ENV_VERBOSE, '输出运行日志，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
          [ENV_API_BASE, `接口域名，默认 ${API_BASE_CN}（其他区域或本地联调时覆盖）`],
        ],
      },
      {
        title: '请求',
        entries: [
          ['方法', 'POST'],
          ['地址', `${API_BASE_CN}${CLIENT_CREDENTIALS_PATH}`],
          ['头部', 'Content-Type: application/json'],
          ['载荷', '{"grant_type":"client_credentials","client_id":…,"client_secret":…}'],
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
      `  ${PROGRAM} huawei client-credentials --client-id <客户端ID> --client-secret <客户端密钥>`,
      `  ${PROGRAM} huawei client-credentials --client-id <客户端ID> --client-secret <客户端密钥> --verbose`,
      `  ${ENV_CLIENT_ID}=<客户端ID> ${ENV_CLIENT_SECRET}=<客户端密钥> ${PROGRAM} huawei client-credentials`,
      '',
      `说明: 默认只把 access_token 写到 stdout，便于 TOKEN=$(${PROGRAM} huawei client-credentials …) 取用`,
      `说明: token_type 与 expires_in 见 --verbose 日志；该 access_token 按 Authorization: Bearer 使用`,
      `原始文档: ${AUTH_DOC_URL}`,
    ],
  })
}

// ------------------------------------------------------------------ 命令分发

/** huawei 子命令分发 */
async function runHuawei(argv, env) {
  const [command, ...rest] = argv
  if (command === undefined || isHelpToken(command)) {
    stdout(renderHuaweiHelp())
    return EXIT_OK
  }
  if (command === 'service-account') {
    return runHuaweiServiceAccount(rest, env)
  }
  if (command === 'service-account-upload-url') {
    return runHuaweiServiceAccountUploadUrl(rest, env)
  }
  if (command === 'client-credentials') {
    return runHuaweiClientCredentials(rest, env)
  }
  if (command === 'client-credentials-upload-url') {
    return runHuaweiClientCredentialsUploadUrl(rest, env)
  }
  throw new UsageError(`未知命令 "huawei ${command}"`, renderHuaweiHelp())
}

/**
 * 华为命令描述，由 publish-apk.js 注册到厂商表中。
 *
 * 命令名与摘要是华为自己的信息，因此放在本模块而不是根入口，
 * 这样根入口完全不需要知道「华为」这两个字。
 */
export const huaweiCommand = {
  name: 'huawei',
  summary: '华为应用市场相关命令',
  run: runHuawei,
}
