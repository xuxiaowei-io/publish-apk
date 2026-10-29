/**
 * 华为应用市场命令（`publish-apk huawei ...`）。
 *
 * 厂商隔离：所有华为相关的东西都在本模块——
 *   - 命令与帮助文档（huawei / huawei service-account / huawei signing-config）
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
 *  10. node src/publish-apk.js huawei service-account-upload-file <必填参数>
 *      确定 Service Account Token（同 8）→ 调 GET /api/publish/v2/upload-url/for-obs 取上传地址
 *      → 把 --file 指向的文件按 urlInfo.method/headers PUT 到 urlInfo.url，
 *      成功时把文件对象 ID（urlInfo.objectId）写 stdout，退出代码 0
 *  11. node src/publish-apk.js huawei client-credentials-upload-file <必填参数>
 *      确定 access_token（同 9）→ 取址 → 上传，成功时同样输出 objectId，退出代码 0
 *  12. node src/publish-apk.js huawei service-account-upload-file-package-info-update <必填参数>
 *      确定 Token（同 8）→ 未给 --object-id 时走 10 的取址+上传拿到 objectId
 *      → 调 PUT /api/publish/v3/app-package-info 把 objectId 登记到 --app-id 上，
 *      stdout 写 objectId（与 10 一致），packageId 见 --verbose 日志，退出代码 0
 *      这是「上传 + 登记」的组合命令：只做 10/11 时文件只在对象存储里，控制台「软件包管理」看不到它
 *  13. node src/publish-apk.js huawei client-credentials-upload-file-package-info-update <必填参数>
 *      确定 access_token（同 9）→ 上传 + 登记，成功时同样输出 objectId，退出代码 0
 *      （8~11 的文件参数：--file 必填；--file-name 默认取该文件名；
 *      --content-length 只用于校验、会与实际文件大小比对，见 collectUploadFileParams）
 *  14. node src/publish-apk.js huawei signing-config <必填参数>
 *      用 .cer / .p7b / .p12 与明文口令生成鸿蒙 build-profile.json5 的 signingConfig：
 *      在 .p12 同级目录生成/复用 material，加密 storePassword / keyPassword，
 *      输出可直接粘贴的 signingConfig（--write 时写回现有 build-profile.json5），退出代码 0
 *
 * 环境变量：每个带值的选项都有同名环境变量兜底（选项优先），见各命令帮助文档的「环境变量」小节；
 * 开关型选项 --verbose 也有环境变量 HUAWEI_VERBOSE（1/true/yes/on 开启、0/false/no/off 关闭）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { request } from 'node:https'
import { basename } from 'node:path'

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
  normalizePemText,
  signJwt,
} from './jwt.js'
import { runHuaweiSigningConfig } from './huawei-signing.js'

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
/** 两个 upload-url 命令：本地文件路径，用来推导 --file-name 与 --content-length */
const OPTION_FILE = '--file'
/** 两个 upload-url 命令：上传后的文件名（不传时取 --file 的文件名） */
const OPTION_FILE_NAME = '--file-name'
/** 两个 upload-url 命令：文件大小（字节，不传时取 --file 的文件大小） */
const OPTION_CONTENT_LENGTH = '--content-length'

/**
 * huawei service-account-upload-url 支持的全部选项：
 * service-account 的选项（用来在本地签发 Token，优先级高于 --token）+ 应用与文件参数。
 */
const SERVICE_ACCOUNT_UPLOAD_URL_OPTIONS = new Set([
  ...SERVICE_ACCOUNT_OPTIONS,
  OPTION_TOKEN,
  OPTION_APP_ID,
  OPTION_FILE,
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
  OPTION_FILE,
  OPTION_FILE_NAME,
  OPTION_CONTENT_LENGTH,
])
/** huawei client-credentials-upload-url 中的开关型选项（不带值） */
const CLIENT_CREDENTIALS_UPLOAD_URL_FLAGS = new Set([OPTION_VERBOSE])

/**
 * huawei service-account-upload-file 支持的全部选项。
 *
 * 与 service-account-upload-url 相同（应用、文件与认证参数）；单独建表而不是共用同一个 Set，
 * 是为了让两个命令的选项集合能各自演进，也让「未知选项」报错时带的是本命令的帮助文档。
 */
const SERVICE_ACCOUNT_UPLOAD_FILE_OPTIONS = new Set(
  [...SERVICE_ACCOUNT_UPLOAD_URL_OPTIONS].filter((name) => name !== OPTION_CONTENT_LENGTH),
)
/** huawei service-account-upload-file 中的开关型选项（不带值） */
const SERVICE_ACCOUNT_UPLOAD_FILE_FLAGS = new Set([OPTION_VERBOSE])

/** huawei client-credentials-upload-file 支持的全部选项（同 client-credentials-upload-url，同样不接受 --content-length） */
const CLIENT_CREDENTIALS_UPLOAD_FILE_OPTIONS = new Set(
  [...CLIENT_CREDENTIALS_UPLOAD_URL_OPTIONS].filter((name) => name !== OPTION_CONTENT_LENGTH),
)
/** huawei client-credentials-upload-file 中的开关型选项（不带值） */
const CLIENT_CREDENTIALS_UPLOAD_FILE_FLAGS = new Set([OPTION_VERBOSE])

/**
 * 上传三步中的第三步：把已上传的文件登记成应用软件包。
 *
 * 前两步（取上传地址、上传文件到 OBS）只是把文件放进对象存储，
 * 控制台「软件包管理」里看不到；必须再登记一次才算完成——.app 走
 * PUT /api/publish/v3/app-package-info，.apk/.aab/.rpk/.hap 走
 * PUT /api/publish/v2/app-file-info（见 resolvePackageRegistration）。
 */
const OPTION_OBJECT_ID = '--object-id'
/** 登记软件包：应用发布方式（可选） */
const OPTION_RELEASE_TYPE = '--release-type'
/** 登记软件包：分阶段发布标识（可选） */
const OPTION_RELEASE_PHASE = '--release-phase'

/**
 * huawei service-account-upload-file-package-info-update 支持的全部选项：
 * service-account 的认证参数（用来本地签发 Token）+ 应用、文件与发布参数。
 */
const SERVICE_ACCOUNT_PACKAGE_INFO_OPTIONS = new Set([
  ...SERVICE_ACCOUNT_OPTIONS,
  OPTION_TOKEN,
  OPTION_APP_ID,
  OPTION_FILE,
  OPTION_FILE_NAME,
  OPTION_OBJECT_ID,
  OPTION_RELEASE_TYPE,
  OPTION_RELEASE_PHASE,
])
/** huawei service-account-upload-file-package-info-update 中的开关型选项（不带值） */
const SERVICE_ACCOUNT_PACKAGE_INFO_FLAGS = new Set([OPTION_VERBOSE])

/** huawei client-credentials-upload-file-package-info-update 支持的全部选项（认证换成 API 客户端） */
const CLIENT_CREDENTIALS_PACKAGE_INFO_OPTIONS = new Set([
  ...CLIENT_CREDENTIALS_OPTIONS,
  OPTION_TOKEN,
  OPTION_APP_ID,
  OPTION_FILE,
  OPTION_FILE_NAME,
  OPTION_OBJECT_ID,
  OPTION_RELEASE_TYPE,
  OPTION_RELEASE_PHASE,
])
/** huawei client-credentials-upload-file-package-info-update 中的开关型选项（不带值） */
const CLIENT_CREDENTIALS_PACKAGE_INFO_FLAGS = new Set([OPTION_VERBOSE])

const ENV_OBJECT_ID = 'HUAWEI_OBJECT_ID'
const ENV_RELEASE_TYPE = 'HUAWEI_RELEASE_TYPE'
const ENV_RELEASE_PHASE = 'HUAWEI_RELEASE_PHASE'

const ENV_TOKEN = 'HUAWEI_TOKEN'
const ENV_APP_ID = 'HUAWEI_APP_ID'
/** 本地文件路径，等价于 --file */
const ENV_FILE = 'HUAWEI_FILE'
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
 * 私钥来源在错误信息与日志里的展示文本。
 *
 * 路径属于敏感信息，统一掩码输出（如 /Use*****.pem）；PEM 数据、含换行的值和异常长的值
 * 连掩码都不做——几千个星号既刷屏又没意义——直接整体省略，只留字符数便于排查。
 * （PEM 的转义还原见 src/jwt.js 的 normalizePemText。）
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

/**
 * 登记 HarmonyOS 5 及以上软件包（.app）的接口路径（上传三步中的第三步）。
 *
 * 只认 HarmonyOS 5 及以上的 .app：Android 与 HarmonyOS 4 及以下的安装包
 * （.apk/.aab/.rpk/.hap）必须走 APP_FILE_INFO_PATH，见 fetchAppFileInfo。
 */
const APP_PACKAGE_INFO_PATH = '/api/publish/v3/app-package-info'

/** 登记 Android 与 HarmonyOS 4 及以下软件包（.apk/.aab/.rpk/.hap）的接口路径（同为第三步） */
const APP_FILE_INFO_PATH = '/api/publish/v2/app-file-info'

/** v2 更新应用文件信息接口里「软件包」的 fileType：RPK、APK、AAB 等都是 5 */
const PACKAGE_FILE_TYPE = 5

/**
 * 把已上传的文件登记成应用软件包（Publishing API：更新应用软件包信息，HarmonyOS 5 及以上）。
 *
 *   PUT {apiBase}/api/publish/v3/app-package-info?appId=…[&releaseType=…][&releasePhase=…]
 *   Authorization: Bearer <Service Account JWT 或 access_token>
 *   client_id: <客户端 ID>   —— 仅 API 客户端（client_credentials）方式需要
 *   { "fileName": …, "objectId": … }
 *
 * 不做这一步，文件只在对象存储里，控制台的「软件包管理」不会出现它。
 * objectId 来自「获取文件上传地址」的响应（也就是上传后我们写进 stdout 的那个值）。
 *
 * 注意：Android 与 HarmonyOS 4 及以下的安装包不能用这个接口，要用 fetchAppFileInfo；
 * 后缀不对时华为只回一个语焉不详的错误码（用 .apk 调本接口会得到 204144641
 * 「The suffix name of the software package is incorrect」）。
 *
 * @param {{ token: string, appId: string, fileName: string, objectId: string, releaseType?: string, releasePhase?: string, clientId?: string, apiBase?: string, timeoutMs?: number }} params
 * @returns {Promise<object>} 接口原始响应：{ ret, packageId? }
 */
export async function fetchAppPackageInfo({
  token,
  appId,
  fileName,
  objectId,
  releaseType,
  releasePhase,
  clientId,
  apiBase = API_BASE_CN,
  timeoutMs = 60_000,
}) {
  // appId 与两个发布参数都是本接口的查询参数（不是请求头），按华为文档的请求示例拼
  const url = new URL(`${apiBase}${APP_PACKAGE_INFO_PATH}`)
  url.searchParams.set('appId', appId)
  if (releaseType !== undefined) {
    url.searchParams.set('releaseType', releaseType)
  }
  if (releasePhase !== undefined) {
    url.searchParams.set('releasePhase', releasePhase)
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (clientId !== undefined) {
    headers.client_id = clientId
  }

  let response
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ fileName, objectId }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(`请求 ${url} 失败: ${error.message}`)
  }

  const text = await response.text()
  return parseAgcResponse(response, text, url.toString())
}

/**
 * 把已上传的文件登记成应用软件包（Publishing API：更新应用文件信息，Android 与 HarmonyOS 4 及以下）。
 *
 *   PUT {apiBase}/api/publish/v2/app-file-info?appId=…[&releaseType=…]
 *   Authorization: Bearer <Service Account JWT 或 access_token>
 *   client_id: <客户端 ID>   —— 仅 API 客户端（client_credentials）方式需要
 *   { "fileType": 5, "files": [{ "fileName": …, "fileDestUrl": … }] }
 *
 * 与 v3 的 app-package-info 是**互斥的两套接口**：这一套只认 Android 与 HarmonyOS 4 及以下
 * 的安装包（fileType 5 即 RPK / APK / AAB 等软件包），HarmonyOS 5 及以上的 .app 走 v3。
 *
 * 载荷里的 fileDestUrl 就是「获取文件上传地址」返回、上传后写进 stdout 的那个 objectId。
 * 名字别写反：华为**上传响应**里的字段拼作 fileDestUlr，而**本请求体**要求 fileDestUrl。
 *
 * @param {{ token: string, appId: string, fileName: string, objectId: string, releaseType?: string, clientId?: string, apiBase?: string, timeoutMs?: number }} params
 * @returns {Promise<object>} 接口原始响应：{ ret, pkgVersion? }
 */
export async function fetchAppFileInfo({
  token,
  appId,
  fileName,
  objectId,
  releaseType,
  clientId,
  apiBase = API_BASE_CN,
  timeoutMs = 60_000,
}) {
  // appId 与 releaseType 是查询参数；本接口没有 releasePhase（Android 的分阶段由 releaseType=3 表达）
  const url = new URL(`${apiBase}${APP_FILE_INFO_PATH}`)
  url.searchParams.set('appId', appId)
  if (releaseType !== undefined) {
    url.searchParams.set('releaseType', releaseType)
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (clientId !== undefined) {
    headers.client_id = clientId
  }

  let response
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        fileType: PACKAGE_FILE_TYPE,
        files: [{ fileName, fileDestUrl: objectId }],
      }),
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
 * 读取 --file / HUAWEI_FILE 指向的本地文件大小（字节）。
 *
 * 调用前需确认「确实需要从文件推导」，因为它同时承担路径校验：
 * 路径不存在、不是普通文件、大小超出安全整数范围都会抛用法错误（附帮助文档）。
 *
 * 错误信息里**完整**给出路径（不做掩码）：这是使用者自己刚在命令行/环境变量里给出的输入，
 * 不知道是哪个路径就无法修正；与私钥路径不同，待上传的文件路径本身不是凭证。
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

/**
 * 收集两个 upload-url 命令共用的应用与文件参数（选项优先，其次环境变量）。
 *
 * --file / HUAWEI_FILE 是「本地文件」这个输入的单一来源，用来补两个缺失项：
 *   --file-name       → 取该文件的文件名（basename）
 *   --content-length  → 取该文件的字节数
 * 两者都可以被显式值覆盖（显式优先），所以 --content-length 不再是必填项；
 * 反过来，只要其中一项还缺着，就需要读文件，此时路径非法会直接报错。
 * 两项都由显式值给出时完全不读文件，也就不会因为路径不存在而失败——`--file` 只用于补缺。
 *
 * 缺失项不在这里抛错，而是回传 missing 数组：调用方要把它与「Token 来源缺失」等其它问题
 * 合并成一条错误信息，避免调用方逐个试错。
 *
 * @returns {{ appId?: string, fileName?: string, contentLength?: string, file?: string, derivedFromFile: string[], missing: string[] }}
 *   file / derivedFromFile 仅在「本次真的用它推导了某一项」时回传，供 --verbose 日志说明来源
 */
function collectUploadUrlParams(options, env, help) {
  const appId = options.get(OPTION_APP_ID) ?? readEnv(env, ENV_APP_ID)
  const file = options.get(OPTION_FILE) ?? readEnv(env, ENV_FILE)
  // 显式值：命令行选项优先，其次各自的环境变量
  let fileName = options.get(OPTION_FILE_NAME) ?? readEnv(env, ENV_FILE_NAME)
  let contentLength = options.get(OPTION_CONTENT_LENGTH) ?? readEnv(env, ENV_CONTENT_LENGTH)

  const needsFile = file !== undefined && (fileName === undefined || contentLength === undefined)
  const derivedFromFile = []
  if (needsFile) {
    const origin = options.has(OPTION_FILE) ? OPTION_FILE : `${ENV_FILE} 环境变量`
    const size = localFileSize(file, origin, help)
    if (fileName === undefined) {
      fileName = basename(file)
      derivedFromFile.push(OPTION_FILE_NAME)
    }
    if (contentLength === undefined) {
      contentLength = String(size)
      derivedFromFile.push(OPTION_CONTENT_LENGTH)
    }
  }

  const missing = []
  if (appId === undefined) {
    missing.push(`${OPTION_APP_ID}（应用 ID），可用环境变量 ${ENV_APP_ID}`)
  }
  if (fileName === undefined) {
    missing.push(
      `${OPTION_FILE_NAME}（文件名），可用环境变量 ${ENV_FILE_NAME}，` +
        `或给 ${OPTION_FILE} 由本地文件名推导`,
    )
  }
  if (contentLength === undefined) {
    missing.push(
      `${OPTION_CONTENT_LENGTH}（文件大小，字节），可用环境变量 ${ENV_CONTENT_LENGTH}，` +
        `或给 ${OPTION_FILE} 由本地文件大小推导`,
    )
  }
  return {
    appId,
    fileName,
    contentLength,
    file: needsFile ? file : undefined,
    derivedFromFile,
    missing,
  }
}

/** --token 模式下日志里展示的来源名（区分命令行与环境变量，两个 upload-url 命令共用） */
function tokenOptionSource(options) {
  return options.get(OPTION_TOKEN) !== undefined ? OPTION_TOKEN : `${ENV_TOKEN} 环境变量`
}

/**
 * 请求「获取文件上传地址」，成功时回传接口原始响应（四个上传命令共用）：
 *   - *-upload-url  把响应 JSON 原样写到 stdout
 *   - *-upload-file 继续用 urlInfo.url/method/headers 上传文件
 *
 * 失败属于运行期问题（不是用法问题），只打印错误日志、不打印帮助文档。
 *
 * @returns {Promise<{ data: object, urlInfo: object } | null>} null 表示失败（已打印错误日志）
 */
async function fetchUploadUrlAndParams({ token, clientId, appId, fileName, contentLength, apiBase }) {
  let data
  try {
    data = await fetchUploadUrl({ token, clientId, appId, fileName, contentLength, apiBase })
  } catch (error) {
    stderr(`错误: 获取文件上传地址失败: ${error.message}`)
    return null
  }

  const urlInfo = data?.urlInfo
  if (typeof urlInfo?.url !== 'string' || urlInfo.url === '') {
    stderr('错误: 获取文件上传地址失败: 响应中未包含 urlInfo.url')
    return null
  }
  return { data, urlInfo }
}

/**
 * 「已获取文件上传地址」的 --verbose 日志（四个上传命令共用）。
 *
 * Token、client_id 只打印掩码；本地路径按原样打印——它不是凭证，出问题时正是靠它定位是哪个文件。
 */
function logUploadUrlDetails({
  apiBase,
  token,
  tokenSource,
  clientId,
  appId,
  fileName,
  contentLength,
  file,
  derivedFromFile,
  urlInfo,
}) {
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
  // 括号里只列出真的由文件推导的项，避免把显式给出的值说成推导来的
  if (file !== undefined && derivedFromFile.length > 0) {
    stderr(`  文件:          ${file}（${derivedFromFile.join(' / ')} 由该文件推导）`)
  }
  if (urlInfo.objectId !== undefined) {
    stderr(`  objectId:      ${urlInfo.objectId}`)
  }
  stderr(`  上传方式:      ${urlInfo.method} ${urlInfo.url}`)
}

// ------------------------------------------- 两种认证方式的 Token 解析（共用）

/**
 * Service Account 方式的 Token 解析（service-account-upload-url 与 service-account-upload-file 共用）。
 *
 * 来源优先级（高 → 低）：
 *   1. 命令行显式给出的 service-account 参数（--kid/--iss/--private-key/--private-key-data）
 *      —— 本地签发 JWT，缺失的项仍可用 HUAWEI_KID/HUAWEI_ISS/HUAWEI_PRIVATE_KEY 补齐
 *   2. --token（或环境变量 HUAWEI_TOKEN）—— 直接使用已签发的 Token
 *   3. 环境变量里已有的完整 Service Account 凭证 —— 本地签发 JWT
 *
 * 把 --token 排在环境变量之前，是为了让 source 了 .env 的环境里 --token 依然生效；
 * 把显式 service-account 参数排在 --token 之前，则是「本地签发优先」。
 *
 * 「没有 Token 来源」不以抛错的方式回报，而是回传 missing：调用方要把它与文件参数的缺失
 * 合并成一条错误信息（与重构前的行为一致），一次告诉使用者所有要补的参数。
 *
 * @returns {{ missing: [string] } | null | { token: string, source: string }}
 *   missing —— 缺 Token 来源（值为要补的参数描述）
 *   null —— 运行期失败（私钥不可用等，已打印错误日志）
 *   其余 —— 成功，token 为真实值，source 为 --verbose 日志里的来源描述
 */
function resolveServiceAccountToken(options, env, help, verbose) {
  const token = options.get(OPTION_TOKEN) ?? readEnv(env, ENV_TOKEN)
  const usesServiceAccountOptions = [
    OPTION_KID,
    OPTION_ISS,
    OPTION_PRIVATE_KEY,
    OPTION_PRIVATE_KEY_DATA,
  ].some((name) => options.has(name))

  if (!usesServiceAccountOptions && token === undefined && !hasEnvServiceAccountCredentials(env)) {
    return {
      missing: [
        `${OPTION_TOKEN}（Service Account Token），或 service-account 参数（${OPTION_KID} / ${OPTION_ISS} / ` +
          `${OPTION_PRIVATE_KEY} / ${OPTION_PRIVATE_KEY_DATA}，本地签发 Token）`,
      ],
    }
  }

  if (usesServiceAccountOptions || token === undefined) {
    // 本地签发：命令行显式给出 service-account 参数，或没有任何 Token 但环境变量里凭证齐全
    const signed = issueServiceAccountJwt(options, env, help)
    if (signed === null) {
      // 私钥不可用等运行期失败：issueServiceAccountJwt 已打印错误日志，这里只回报失败
      return null
    }
    if (verbose) {
      stderr('已生成 JWT 签名（PS256）')
      logJwtDetails(signed)
    }
    return {
      token: signed.jwt,
      source: usesServiceAccountOptions ? 'service-account 参数（本地签发）' : '环境变量凭证（本地签发）',
    }
  }

  return { token, source: tokenOptionSource(options) }
}

/**
 * API 客户端方式（client_credentials）的 Token 解析
 * （client-credentials-upload-url 与 client-credentials-upload-file 共用）。
 *
 * 来源优先级（高 → 低）：
 *   1. 命令行显式给出的 client-credentials 参数（--client-id / --client-secret）
 *      —— 本地换取 access_token，缺失的项仍可用 HUAWEI_CLIENT_ID / HUAWEI_CLIENT_SECRET 补齐
 *   2. --token（或环境变量 HUAWEI_TOKEN）—— 直接使用已换取的 access_token
 *   3. 环境变量里已有的完整 API 客户端凭证 —— 本地换取 access_token
 *
 * 「缺 Token 来源」同样以 missing 回传，由调用方与文件参数的缺失合并成一条错误信息。
 *
 * apiBase 一同回传：调用方请求业务接口时要用同一个域名，而它可能被 HUAWEI_API_BASE 覆盖，
 * 调用方不必再自己读一次环境变量。
 *
 * @returns {Promise<{ missing: [string] } | null | { token: string, clientId?: string, apiBase: string, source: string }>}
 *   missing —— 缺 Token 来源（值为要补的参数描述，可能不止一条）
 *   null —— 运行期失败（换取 access_token 失败，已打印错误日志）
 *   其余 —— 成功
 */
async function resolveClientCredentialsToken(options, env, help, verbose) {
  const apiBase = readEnv(env, ENV_API_BASE) ?? API_BASE_CN
  const clientId = options.get(OPTION_CLIENT_ID) ?? readEnv(env, ENV_CLIENT_ID)
  const clientSecret = options.get(OPTION_CLIENT_SECRET) ?? readEnv(env, ENV_CLIENT_SECRET)
  const token = options.get(OPTION_TOKEN) ?? readEnv(env, ENV_TOKEN)

  const canExchangeToken = clientId !== undefined && clientSecret !== undefined
  const usesClientCredentialsOptions = [OPTION_CLIENT_ID, OPTION_CLIENT_SECRET].some((name) =>
    options.has(name),
  )
  // 换取 access_token 需要客户端 ID 与密钥都齐全（缺的项可由环境变量补齐）；
  // 只有「命令行给了客户端参数」或「根本没有 --token」时才真的走换取，否则 --token 优先。
  // 这样 `--client-id X --token Y`（已有 access_token，只是补一个 client_id 头）不会被误判成
  // 缺少 --client-secret——帮助文档里写明这种用法是允许的。
  const exchangesToken = canExchangeToken && (usesClientCredentialsOptions || token === undefined)

  if (!exchangesToken && token === undefined) {
    if (clientId === undefined && clientSecret === undefined) {
      return {
        missing: [
          `${OPTION_TOKEN}（access_token），或 client-credentials 参数（${OPTION_CLIENT_ID} / ` +
            `${OPTION_CLIENT_SECRET}，本地换取 access_token）`,
        ],
      }
    }
    // 只给了一个客户端参数：把缺的另一个点出来，比笼统提示更好定位
    const missing = []
    if (clientId === undefined) {
      missing.push(`${OPTION_CLIENT_ID}（客户端 ID），可用环境变量 ${ENV_CLIENT_ID}`)
    }
    if (clientSecret === undefined) {
      missing.push(`${OPTION_CLIENT_SECRET}（客户端密钥），可用环境变量 ${ENV_CLIENT_SECRET}`)
    }
    return { missing }
  }

  if (!exchangesToken) {
    return { token, clientId, apiBase, source: tokenOptionSource(options) }
  }

  // 本地换取：命令行显式给出客户端参数，或没有任何 Token 但环境变量里凭证齐全
  let data
  try {
    data = await fetchClientCredentialsToken({ clientId, clientSecret, apiBase })
  } catch (error) {
    // 网络/接口失败属于运行期问题，不是用法问题，所以只报错不打印帮助文档
    stderr(`错误: 获取 access_token 失败: ${error.message}`)
    return null
  }

  const fetched = data?.access_token
  if (typeof fetched !== 'string' || fetched === '') {
    stderr('错误: 获取 access_token 失败: 响应中未包含 access_token')
    return null
  }

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

  return {
    token: fetched,
    clientId,
    apiBase,
    source: usesClientCredentialsOptions ? 'client-credentials 参数（本地换取）' : '环境变量凭证（本地换取）',
  }
}


// --------------------------------------- huawei service-account-upload-url

/**
 * huawei service-account-upload-url：先用 Service Account 确定 Token，再换取文件上传地址。
 *
 * Token 来源优先级见 resolveServiceAccountToken（本地签发优先，其次 --token）。
 * 输出接口原始响应 JSON：上传文件还必须用到 urlInfo.method 与 urlInfo.headers。
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

  const { appId, fileName, contentLength, file, derivedFromFile, missing } = collectUploadUrlParams(
    options,
    env,
    renderHuaweiServiceAccountUploadUrlHelp,
  )

  // 认证参数与文件参数都收齐后一次性报错：使用者一眼能看到所有要补的参数，不必逐个试错
  const auth = resolveServiceAccountToken(options, env, renderHuaweiServiceAccountUploadUrlHelp, verbose)
  if (auth !== null && auth.missing !== undefined) {
    missing.push(...auth.missing)
  }
  if (missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${missing.join('；')}`, renderHuaweiServiceAccountUploadUrlHelp())
  }
  if (auth === null) {
    return EXIT_FAILURE
  }

  // 这两个参数在华为侧都是 Java Long，先本地校验，避免拿到 HTTP 400 的反序列化报错
  assertNonNegativeInteger(appId, OPTION_APP_ID, '应用 ID', renderHuaweiServiceAccountUploadUrlHelp)
  assertNonNegativeInteger(
    contentLength,
    OPTION_CONTENT_LENGTH,
    '文件大小（字节）',
    renderHuaweiServiceAccountUploadUrlHelp,
  )

  // 域名可用 HUAWEI_API_BASE 覆盖（区域不同域名不同），所以日志里打印实际用到的地址
  const apiBase = readEnv(env, ENV_API_BASE) ?? API_BASE_CN
  const result = await fetchUploadUrlAndParams({
    token: auth.token,
    appId,
    fileName,
    contentLength,
    apiBase,
  })
  if (result === null) {
    return EXIT_FAILURE
  }

  if (verbose) {
    logUploadUrlDetails({
      apiBase,
      token: auth.token,
      tokenSource: auth.source,
      appId,
      fileName,
      contentLength,
      file,
      derivedFromFile,
      urlInfo: result.urlInfo,
    })
  }

  // 默认输出接口原始响应 JSON：上传文件必须用到 urlInfo.method 与 urlInfo.headers，
  // 只输出 url 会丢掉这两项（响应其它字段也一并保留，便于按需 jq 取用）
  stdout(JSON.stringify(result.data))
  return EXIT_OK
}

// ------------------------------------ huawei client-credentials-upload-url

/**
 * huawei client-credentials-upload-url：先用 API 客户端凭证换 access_token，再换取文件上传地址。
 *
 * Token 来源优先级见 resolveClientCredentialsToken（本地换取优先，其次 --token）。
 * 与 Service Account 方式的差别：API 客户端方式按华为要求还要带 client_id 请求头。
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

  const { appId, fileName, contentLength, file, derivedFromFile, missing } = collectUploadUrlParams(
    options,
    env,
    renderHuaweiClientCredentialsUploadUrlHelp,
  )

  // 认证参数与文件参数都收齐后一次性报错：使用者一眼能看到所有要补的参数，不必逐个试错
  const auth = await resolveClientCredentialsToken(
    options,
    env,
    renderHuaweiClientCredentialsUploadUrlHelp,
    verbose,
  )
  if (auth !== null && auth.missing !== undefined) {
    missing.push(...auth.missing)
  }
  if (missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${missing.join('；')}`, renderHuaweiClientCredentialsUploadUrlHelp())
  }
  if (auth === null) {
    return EXIT_FAILURE
  }

  // 这两个参数在华为侧都是 Java Long，先本地校验，避免拿到 HTTP 400 的反序列化报错
  assertNonNegativeInteger(appId, OPTION_APP_ID, '应用 ID', renderHuaweiClientCredentialsUploadUrlHelp)
  assertNonNegativeInteger(
    contentLength,
    OPTION_CONTENT_LENGTH,
    '文件大小（字节）',
    renderHuaweiClientCredentialsUploadUrlHelp,
  )

  const result = await fetchUploadUrlAndParams({
    token: auth.token,
    clientId: auth.clientId,
    appId,
    fileName,
    contentLength,
    apiBase: auth.apiBase,
  })
  if (result === null) {
    return EXIT_FAILURE
  }

  if (verbose) {
    logUploadUrlDetails({
      apiBase: auth.apiBase,
      token: auth.token,
      tokenSource: auth.source,
      clientId: auth.clientId,
      appId,
      fileName,
      contentLength,
      file,
      derivedFromFile,
      urlInfo: result.urlInfo,
    })
  }

  stdout(JSON.stringify(result.data))
  return EXIT_OK
}

// --------------------------------------- huawei *-upload-file 的公共部分

/**
 * 收集两个 upload-file 命令共用的应用与文件参数（选项优先，其次环境变量）。
 *
 * 与 collectUploadUrlParams 的区别：这里 **必须** 拿到本地文件，因为「上传文件」这件事本身
 * 不能只靠文件名与字节数完成。由此产生两条规则：
 *   1. --file 必填（选项或 HUAWEI_FILE），没有「--file-name + --content-length」这种免文件写法；
 *   2. 文件大小恒取本地文件的实际字节数，--content-length 不参与（本命令已不接受该选项）。
 *      华为要求上传的字节数必须与获取上传地址时填写的 contentLength 一致，
 *      保留「显式值优先」只会在写错时让上传在华为侧失败，不如直接不给这个后门。
 *
 * 应用参数的缺失不以抛错的方式回报（与 collectUploadUrlParams 一致），而是放进 missing，
 * 让调用方与「缺 Token 来源」合并成一条错误信息；文件相关的错误在参数齐了之后才会出现。
 *
 * @returns {{ appId?: string, file?: string, fileName?: string, size?: number, missing: string[] }}
 *   missing 非空时后四个字段都不可用；两个都齐时 size 一定存在，fileName 也已由 --file 兜底
 */
function collectUploadFileParams(options, env, help, fileNameFromPackageInfo) {
  const appId = options.get(OPTION_APP_ID) ?? readEnv(env, ENV_APP_ID)
  const file = options.get(OPTION_FILE) ?? readEnv(env, ENV_FILE)
  // 组合命令（upload-file-package-info-update）已经确定过文件名，传进来即可，
  // 免得「上传用的名字」与「登记用的名字」各算一次、算出两个不同的值
  let fileName = fileNameFromPackageInfo ?? options.get(OPTION_FILE_NAME) ?? readEnv(env, ENV_FILE_NAME)

  const missing = []
  if (appId === undefined) {
    missing.push(`${OPTION_APP_ID}（应用 ID），可用环境变量 ${ENV_APP_ID}`)
  }
  if (file === undefined) {
    missing.push(`${OPTION_FILE}（本地文件路径），可用环境变量 ${ENV_FILE}`)
  }
  if (missing.length > 0) {
    return { appId, file, fileName, missing }
  }

  // 路径校验：大小以它为前提下，不存在就没必要继续
  const size = localFileSize(file, options.has(OPTION_FILE) ? OPTION_FILE : `${ENV_FILE} 环境变量`, help)
  // 没显式给文件名时取本地文件名：取址与登记必须用同一个文件名，所以只在这里算一次
  if (fileName === undefined) {
    fileName = basename(file)
  }

  return { appId, file, fileName, size, missing }
}

/**
 * 读取待上传文件的内容。
 *
 * 与 localFileSize 的「大小」分开：这里才真的把文件读进内存。文件在两者之间被删掉、
 * 或者实际读到的字节数与 stat 的结果不一致时，用实际字节数覆盖——上传的字节数必须与
 * 获取上传地址时填写的 contentLength 一致，宁可在这里停下也不要让华为侧报签名错误。
 *
 * @returns {{ body: Buffer, size: number }} size 为实际读到的字节数
 */
function readUploadFile(path) {
  let body
  try {
    body = readFileSync(path)
  } catch (error) {
    throw new Error(`读取文件失败: ${path}: ${error.message}`)
  }
  return { body, size: body.length }
}

/**
 * 把 urlInfo.headers 整理成可原样发出的请求头。
 *
 * 键名大小写不敏感地去重（后出现的覆盖先出现的），并丢掉空值：
 * OBS 预签名地址把参与签名的头部固化在签名里，多一个、少一个、值不对都会得到
 * 「Calculated signature does not match」，所以这里除了 Content-Length 之外不添加任何头部。
 */
function normalizeUploadHeaders(headers) {
  const normalized = new Map()
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || value === '') {
      continue
    }
    normalized.set(name.toLowerCase(), [name, value])
  }
  return Object.fromEntries(normalized.values())
}

/**
 * 用 urlInfo 给出的地址、方法与请求头上传文件（华为「上传文件」接口）。
 *
 *   PUT {urlInfo.url}
 *   Content-Type: application/octet-stream（取自 urlInfo.headers）
 *   Body: 文件二进制内容，字节数必须与获取上传地址时填写的 contentLength 一致
 *
 * 为什么不用 fetch：华为要求把 urlInfo.headers 里的 Host 与 user-agent **原样**发出
 * （它们是 OBS 签名的一部分），而 undici（Node 内置 fetch）会用连接目标覆盖 Host 头，
 * 于是签名必然不匹配。这里改用 node:https，并关闭 setHost，让 Host 真正由我们指定。
 *
 * 关闭 setHost 后必须自己管 SNI：连接目标取 target.hostname（握手用的地址不会因为 Host 改写而变），
 * 并且只在它是域名时才传 servername——Node 不允许把 servername 设成 IP（会直接抛错），
 * 而 IP 地址本来也没有 SNI。
 *
 * 大文件说明：请求体一次性读进内存（见 readUploadFile），因此可上传的文件大小受 Node 堆上限约束，
 * 超大安装包需要改成流式上传（流式与「实际字节数」校验、重试都会更复杂，这里先取简单可靠的做法）。
 *
 * @returns {Promise<{ status: number, location?: string, body: string }>}
 */
function uploadFileToObs({ url, method, headers, body }) {
  let target
  try {
    target = new URL(url)
  } catch {
    return Promise.reject(new Error(`上传地址不是合法 URL: ${url}`))
  }
  if (target.protocol !== 'https:') {
    return Promise.reject(new Error(`上传地址必须是 https: ${url}`))
  }

  return new Promise((resolve, reject) => {
    const options = {
      host: target.hostname,
      port: target.port === '' ? 443 : target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: { ...headers, 'Content-Length': body.length },
      setHost: false,
    }
    if (isIP(target.hostname) === 0) {
      options.servername = target.hostname
    }

    const req = request(
      options,
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              location: res.headers.location,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          } catch (error) {
            reject(error)
          }
        })
        res.on('error', reject)
      },
    )
    // 上传中断（网络断开、内存不足等）会走到这里；华为侧只会看到一个不完整的对象，不会返回成功
    req.on('error', (error) => reject(new Error(`上传请求失败: ${error.message}`)))
    req.end(body)
  })
}

/**
 * 整理华为「上传文件」接口的失败信息。
 *
 * 两种失败形态：
 *   - OBS 返回非 2xx —— 响应体是 XML（<Error><Code>…</Code><Message>…</Message></Error>）
 *   - 3xx —— 预签名地址有效期内一般不会重定向，真出现时说明地址/域名不对，把 Location 带出来便于排查
 * 成功时响应体为空（HTTP 200），这里不解析它，只把状态码与 Location 回传给调用方判断。
 */
function describeUploadFailure({ status, location, body }) {
  if (status >= 300 && status < 400) {
    return `HTTP ${status} 重定向到 ${location ?? '(未返回 Location)'}`
  }
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1]
  const message = /<Message>([^<]*)<\/Message>/.exec(body)?.[1]
  const detail = body === '' ? '（响应体为空）' : body.slice(0, 300)
  if (code !== undefined) {
    return `HTTP ${status} code=${code} message=${message ?? '(无描述)'}`
  }
  return `HTTP ${status}: ${detail}`
}

/**
 * --verbose 时打印上传请求概况（见 uploadFileToObs：除了 Content-Length 不添加任何头部，
 * 这里打印的头部名与真正发出的完全一致）。Authorization 只打印掩码。
 */
function logUploadRequest({ url, method, headers, contentLength }) {
  stderr('开始上传文件')
  stderr(`  请求地址:      ${method} ${url}`)
  stderr(`  contentLength: ${contentLength}`)
  stderr(`  请求头:        ${Object.keys(headers).join(', ')}, Content-Length`)
  if (headers.Authorization !== undefined) {
    stderr(`  Authorization: ${maskValue(headers.Authorization)}`)
  }
}

/** --verbose 时打印上传结果 */
function logUploadResult({ objectId, status }) {
  stderr('已上传文件')
  stderr(`  上传结果:      HTTP ${status}`)
  if (objectId !== undefined) {
    stderr(`  objectId:      ${objectId}`)
  }
}

/**
 * 把 urlInfo.headers 整理成上传请求头（IDEMPOTENT：只读 urlInfo，可重复调用）。
 *
 * 补两条华为文档要求、但响应里可能缺失的规则：
 *   - Content-Type 缺失时补 application/octet-stream（它是必选头）
 *   - Content-Length 一律丢弃，由实际 body 长度决定，避免用错旧值
 */
function buildUploadHeaders(urlInfo) {
  const headers = normalizeUploadHeaders(urlInfo.headers ?? {})
  if (headers['content-type'] === undefined) {
    headers['Content-Type'] = 'application/octet-stream'
  }
  if (headers['content-length'] !== undefined) {
    delete headers['Content-Length']
  }
  return headers
}

/** urlInfo.method 缺失时按接口约定回退为 PUT */
function uploadMethod(urlInfo) {
  return typeof urlInfo.method === 'string' && urlInfo.method !== '' ? urlInfo.method : 'PUT'
}

/**
 * 「读取文件 → 校验大小 → PUT 到 urlInfo.url」这一步（IDEMPOTENT：不改动 urlInfo）。
 *
 * 独立出来是为了让 *-upload-file 与 *-upload-file-package-info-update 共用同一套上传逻辑：
 * 取址用的 contentLength 与上传的字节数都取自本地文件，前者是 stat 得到的 size，
 * 后者是真正读出来的字节数。两者不一致说明文件在取址与上传之间被改过，
 * 这时直接用实际字节数上传必然会因为「与 contentLength 不符」失败，所以在本地就先报错。
 * 日志（--verbose）也在这里打印，两个命令的输出格式因此保持一致。
 *
 * @returns {Promise<{ objectId?: string, status: number } | null>} null 表示失败（已打印错误日志）
 */
async function uploadFileToObsWithResult({ urlInfo, file, size, verbose }) {
  let read
  try {
    read = readUploadFile(file)
  } catch (error) {
    stderr(`错误: ${error.message}`)
    return null
  }

  if (read.size !== size) {
    stderr(
      `错误: 文件在获取上传地址后发生变化: ${file}，` +
        `取址时 ${size} 字节，上传时 ${read.size} 字节；请重试`,
    )
    return null
  }

  const headers = buildUploadHeaders(urlInfo)
  const method = uploadMethod(urlInfo)
  if (verbose) {
    logUploadRequest({ url: urlInfo.url, method, headers, contentLength: read.size })
  }

  let response
  try {
    response = await uploadFileToObs({ url: urlInfo.url, method, headers, body: read.body })
  } catch (error) {
    stderr(`错误: 上传文件失败: ${error.message}`)
    return null
  }

  if (response.status !== 200) {
    stderr(`错误: 上传文件失败: ${describeUploadFailure(response)}`)
    return null
  }

  if (verbose) {
    logUploadResult({ objectId: urlInfo.objectId, status: response.status })
  }
  return { objectId: urlInfo.objectId, status: response.status }
}

/**
 * 两个 upload-file 命令共用的执行流程：
 *   取址（GET /api/publish/v2/upload-url/for-obs）→ 上传（PUT urlInfo.url）→ 输出 objectId
 *
 * 取址用的 contentLength 与上传的字节数都取自本地文件：前者是 size（stat 得到），
 * 后者是真正读出来的字节数。两者不一致说明文件在取址与上传之间被改过，
 * 这时直接用实际字节数上传必然会因为「与 contentLength 不符」失败，所以在本地就先报错。
 *
 * @returns {Promise<number>} 退出代码（EXIT_OK / EXIT_FAILURE）
 */
async function uploadFileWithAuth({
  file,
  fileName,
  appId,
  size,
  apiBase,
  token,
  tokenSource,
  clientId,
  verbose,
}) {
  const result = await fetchUploadUrlAndParams({
    token,
    clientId,
    appId,
    fileName,
    // 取址用的 contentLength 一律取本地文件的实际字节数（见 collectUploadFileParams）
    contentLength: String(size),
    apiBase,
  })
  if (result === null) {
    return EXIT_FAILURE
  }

  if (verbose) {
    logUploadUrlDetails({
      apiBase,
      token,
      tokenSource,
      clientId,
      appId,
      fileName,
      contentLength: size,
      file,
      // 文件名与文件大小在这里都是本命令自己从文件得到的，没有「显式值」这一说
      derivedFromFile: [],
      urlInfo: result.urlInfo,
    })
  }

  const uploaded = await uploadFileToObsWithResult({ urlInfo: result.urlInfo, file, size, verbose })
  if (uploaded === null) {
    return EXIT_FAILURE
  }

  // 默认只输出 objectId：它是后续接口（如 *-upload-file-package-info-update）要用的文件对象 ID，
  // 便于 OBJECT_ID=$(publish-apk huawei …-upload-file …) 这样取用。
  // objectId 理论上必然存在（华为文档标为必选），真缺了就退回整个 urlInfo 的 JSON。
  stdout(uploaded.objectId === undefined ? JSON.stringify(result.urlInfo) : uploaded.objectId)
  return EXIT_OK
}

// ---------------------------------------- huawei service-account-upload-file

/** 文件上传地址有效期（华为文档：约 5 分钟），用来说明「取址与上传必须紧接着做」 */
const UPLOAD_URL_TTL_NOTE = '上传地址有效期约 5 分钟（华为文档），所以本命令把取址与上传递串完成'

/**
 * huawei service-account-upload-file：先用 Service Account 确定 Token，再取址并上传文件。
 *
 * Token 来源优先级见 resolveServiceAccountToken（本地签发优先，其次 --token）。
 */
async function runHuaweiServiceAccountUploadFile(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderHuaweiServiceAccountUploadFileHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    SERVICE_ACCOUNT_UPLOAD_FILE_OPTIONS,
    renderHuaweiServiceAccountUploadFileHelp,
    SERVICE_ACCOUNT_UPLOAD_FILE_FLAGS,
  )
  const verbose = resolveVerbose(options, env, renderHuaweiServiceAccountUploadFileHelp)

  const params = collectUploadFileParams(options, env, renderHuaweiServiceAccountUploadFileHelp)
  const auth = resolveServiceAccountToken(options, env, renderHuaweiServiceAccountUploadFileHelp, verbose)
  if (auth !== null && auth.missing !== undefined) {
    params.missing.push(...auth.missing)
  }
  if (params.missing.length > 0) {
    throw new UsageError(
      `缺少必填参数: ${params.missing.join('；')}`,
      renderHuaweiServiceAccountUploadFileHelp(),
    )
  }
  if (auth === null) {
    return EXIT_FAILURE
  }

  const { appId, file, fileName, size } = params
  assertNonNegativeInteger(appId, OPTION_APP_ID, '应用 ID', renderHuaweiServiceAccountUploadFileHelp)

  return uploadFileWithAuth({
    file,
    fileName,
    appId,
    size,
    apiBase: readEnv(env, ENV_API_BASE) ?? API_BASE_CN,
    token: auth.token,
    tokenSource: auth.source,
    verbose,
  })
}

// ------------------------------------ huawei client-credentials-upload-file

/**
 * huawei client-credentials-upload-file：先用 API 客户端凭证换 access_token，再取址并上传文件。
 *
 * Token 来源优先级见 resolveClientCredentialsToken（本地换取优先，其次 --token）。
 * API 客户端方式按华为要求取址时还要带 client_id 请求头。
 */
async function runHuaweiClientCredentialsUploadFile(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderHuaweiClientCredentialsUploadFileHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    CLIENT_CREDENTIALS_UPLOAD_FILE_OPTIONS,
    renderHuaweiClientCredentialsUploadFileHelp,
    CLIENT_CREDENTIALS_UPLOAD_FILE_FLAGS,
  )
  const verbose = resolveVerbose(options, env, renderHuaweiClientCredentialsUploadFileHelp)

  const params = collectUploadFileParams(options, env, renderHuaweiClientCredentialsUploadFileHelp)
  const auth = await resolveClientCredentialsToken(
    options,
    env,
    renderHuaweiClientCredentialsUploadFileHelp,
    verbose,
  )
  if (auth !== null && auth.missing !== undefined) {
    params.missing.push(...auth.missing)
  }
  if (params.missing.length > 0) {
    throw new UsageError(
      `缺少必填参数: ${params.missing.join('；')}`,
      renderHuaweiClientCredentialsUploadFileHelp(),
    )
  }
  if (auth === null) {
    return EXIT_FAILURE
  }

  const { appId, file, fileName, size } = params
  assertNonNegativeInteger(appId, OPTION_APP_ID, '应用 ID', renderHuaweiClientCredentialsUploadFileHelp)

  return uploadFileWithAuth({
    file,
    fileName,
    appId,
    size,
    apiBase: auth.apiBase,
    token: auth.token,
    tokenSource: auth.source,
    clientId: auth.clientId,
    verbose,
  })
}

// ----------------------------- huawei *-upload-file-package-info-update 的公共部分

/**
 * 登记软件包的两套接口：华为按安装包后缀区分，且**不能串用**。
 *
 *   - HarmonyOS 5 及以上（.app）：PUT /api/publish/v3/app-package-info
 *     载荷 { fileName, objectId }；发布参数 releaseType 1/7、releasePhase 0/3；返回 packageId
 *   - Android 与 HarmonyOS 4 及以下（.apk/.aab/.rpk/.hap）：PUT /api/publish/v2/app-file-info
 *     载荷 { fileType: 5, files: [{ fileName, fileDestUrl }] }；发布参数 releaseType 1/3；返回 pkgVersion
 *
 * 后缀选错时华为只回一个语焉不详的错误：用 .apk 调 v3 会得到 204144641
 * 「[AppGalleryConnectPublishService]The suffix name of the software package is incorrect」。
 * 所以这里按后缀自己选接口，不让使用者用选项去指定——选错只会在华为侧失败。
 */
const HARMONYOS_PACKAGE_REGISTRATION = {
  /** 登记接口路径 */
  path: APP_PACKAGE_INFO_PATH,
  /** 调该接口的函数（两个接口的入参形状相同，只有载荷与查询参数不同） */
  request: fetchAppPackageInfo,
  /** 文档标题，出错信息里带上它便于对着华为文档排查 */
  title: '更新应用软件包信息',
  /** 适用平台（帮助文档与日志里显示） */
  platform: 'HarmonyOS 5 及以上',
  /** 走本接口的后缀（小写，不含点） */
  suffixes: ['app'],
  /** releaseType 允许取值与文字说明（华为文档给出的范围） */
  releaseTypes: new Set(['1', '7']),
  releaseTypeValues: '1 全网、7 企业非公开发布',
  /** releasePhase 允许取值；null 表示该接口没有这个参数 */
  releasePhases: new Set(['0', '3']),
  /** 响应里的软件包标识字段（后续查询编译状态要用） */
  identifier: 'packageId',
}

const LEGACY_PACKAGE_REGISTRATION = {
  path: APP_FILE_INFO_PATH,
  request: fetchAppFileInfo,
  title: '更新应用文件信息',
  platform: 'Android 与 HarmonyOS 4 及以下',
  suffixes: ['apk', 'aab', 'rpk', 'hap'],
  releaseTypes: new Set(['1', '3']),
  releaseTypeValues: '1 全网、3 分阶段',
  // v2 接口没有 releasePhase：Android 的分阶段发布由 releaseType=3 表达
  releasePhases: null,
  identifier: 'pkgVersion',
}

/** 两套登记接口的全部取值（校验与帮助文案共用，顺序固定） */
const PACKAGE_REGISTRATIONS = [HARMONYOS_PACKAGE_REGISTRATION, LEGACY_PACKAGE_REGISTRATION]

/** 后缀（小写）→ 登记接口 */
const PACKAGE_REGISTRATION_BY_SUFFIX = new Map(
  PACKAGE_REGISTRATIONS.flatMap((registration) =>
    registration.suffixes.map((suffix) => [suffix, registration]),
  ),
)

/** 帮助文档里用的后缀清单，如 ".app"、".apk、.aab、.rpk、.hap" */
function describeSuffixes({ suffixes }) {
  return suffixes.map((suffix) => `.${suffix}`).join('、')
}

/** 取文件名的后缀（最后一个 "." 之后的部分，大小写不敏感）；没有 "." 时返回空串 */
function fileSuffix(fileName) {
  const index = fileName.lastIndexOf('.')
  return index === -1 ? '' : fileName.slice(index + 1).toLowerCase()
}

/**
 * 按文件名后缀确定登记软件包用哪套接口。
 *
 * 认不出的后缀直接报用法错误：与其发出去换回 204144641（后缀不对），
 * 不如在本地说清支持哪些后缀。
 */
function resolvePackageRegistration(fileName, help) {
  const registration = PACKAGE_REGISTRATION_BY_SUFFIX.get(fileSuffix(fileName))
  if (registration === undefined) {
    const supported = PACKAGE_REGISTRATIONS.map(
      (item) => `${describeSuffixes(item)}（${item.platform}）`,
    ).join('；')
    throw new UsageError(
      `无法从文件名 "${fileName}" 判断登记软件包的接口，支持的后缀: ${supported}`,
      help(),
    )
  }
  return registration
}

/**
 * 校验取值是否在允许集合内，不在则报用法错误。
 *
 * 与 assertNonNegativeInteger 一样，把「华为侧只会回 400」的输入先在本地拦下。
 */
function assertAllowedValue(value, option, label, allowed, help) {
  if (!allowed.has(value)) {
    throw new UsageError(
      `选项 "${option}" 需要${label}，取值范围 ${[...allowed].join(' / ')}，实际收到 "${value}"`,
      help,
    )
  }
}

/**
 * 两个 upload-file-package-info-update 命令共用的发布参数校验（给了才校验）。
 *
 * 取值范围取决于最终走哪套接口（见 resolvePackageRegistration）：
 * 两套接口的 releaseType 取值不同，v2 那套根本没有 releasePhase。
 */
function assertRequiredArguments({ releaseType, releasePhase }, registration, help) {
  if (releaseType !== undefined) {
    assertAllowedValue(
      releaseType,
      OPTION_RELEASE_TYPE,
      `应用发布方式（${registration.platform}，${registration.releaseTypeValues}）`,
      registration.releaseTypes,
      help,
    )
  }
  if (releasePhase !== undefined) {
    if (registration.releasePhases === null) {
      throw new UsageError(
        `选项 "${OPTION_RELEASE_PHASE}" 只适用于 ${describeSuffixes(HARMONYOS_PACKAGE_REGISTRATION)}` +
          `（${HARMONYOS_PACKAGE_REGISTRATION.platform}）；${describeSuffixes(registration)} 的分阶段发布用 ` +
          `${OPTION_RELEASE_TYPE} 3 表达`,
        help(),
      )
    }
    assertAllowedValue(releasePhase, OPTION_RELEASE_PHASE, '分阶段发布标识', registration.releasePhases, help)
  }
}

/**
 * 收集两个 upload-file-package-info-update 命令共用的应用、对象与发布参数（选项优先，其次环境变量）。
 *
 * fileName 不在这里决定：它必须同时用于取址、上传与登记（华为按后缀校验，三处不一致会失败），
 * 所以统一由 collectUploadFileParams 算一次（见那里的 basename 推导）。
 * 缺失项以 missing 回报，由调用方与「缺 Token 来源」「缺 --file」合并成一条错误信息。
 *
 * @returns {{ appId?: string, objectId?: string, releaseType?: string, releasePhase?: string, missing: string[] }}
 */
function collectPackageInfoParams(options, env) {
  const appId = options.get(OPTION_APP_ID) ?? readEnv(env, ENV_APP_ID)
  const objectId = options.get(OPTION_OBJECT_ID) ?? readEnv(env, ENV_OBJECT_ID)
  const releaseType = options.get(OPTION_RELEASE_TYPE) ?? readEnv(env, ENV_RELEASE_TYPE)
  const releasePhase = options.get(OPTION_RELEASE_PHASE) ?? readEnv(env, ENV_RELEASE_PHASE)
  // 只登记（给了 object-id）时才用得上：此时 HUAWEI_FILE 按「已上传的文件名」理解，
  // 上传路径下文件名由 collectUploadFileParams 从本地路径推导（basename），不走这里
  const fileName = options.get(OPTION_FILE_NAME) ?? readEnv(env, ENV_FILE_NAME) ?? readEnv(env, ENV_FILE)

  const missing = []
  if (appId === undefined) {
    missing.push(`${OPTION_APP_ID}（应用 ID），可用环境变量 ${ENV_APP_ID}`)
  }

  return { appId, objectId, releaseType, releasePhase, fileName, missing }
}


/**
 * --verbose 时打印登记请求概况。
 * Token 与 client_id 只打印掩码；objectId 是文件在服务器上的路径，不是凭证，按原样打印。
 */
function logPackageRequest({
  registration,
  apiBase,
  token,
  tokenSource,
  clientId,
  appId,
  fileName,
  objectId,
  releaseType,
  releasePhase,
}) {
  stderr('开始登记软件包')
  stderr(`  请求地址:      PUT ${apiBase}${registration.path}`)
  stderr(`  接口归属:      ${registration.title}（${registration.platform}）`)
  stderr(`  Token 来源:    ${tokenSource}`)
  stderr(`  Token:         ${maskValue(token)}`)
  if (clientId !== undefined) {
    stderr(`  client_id:     ${maskValue(clientId)}`)
  }
  stderr(`  appId:         ${appId}`)
  stderr(`  fileName:      ${fileName}`)
  stderr(`  objectId:      ${objectId}`)
  if (releaseType !== undefined) {
    stderr(`  releaseType:   ${releaseType}`)
  }
  if (releasePhase !== undefined) {
    stderr(`  releasePhase:  ${releasePhase}`)
  }
}

/**
 * 从登记响应里取软件包标识：v3（.app）是 packageId 字符串，v2 是 pkgVersion 字符串数组。
 * 它是后续接口（查询软件包编译状态）要用的值，也是本流程的输出。
 */
function packageIdentifier(registration, data) {
  if (registration.identifier !== 'pkgVersion') {
    return data?.packageId
  }
  const versions = data?.pkgVersion
  return Array.isArray(versions) ? versions[0] : undefined
}

/**
 * 两个 upload-file-package-info-update 命令共用的登记流程：
 * 按后缀选好接口（见 resolvePackageRegistration）后 PUT，并取出软件包标识。
 *
 * @returns {Promise<number>} 退出代码（EXIT_OK / EXIT_FAILURE）
 */
async function registerAppPackage({
  registration,
  appId,
  fileName,
  objectId,
  releaseType,
  releasePhase,
  apiBase,
  token,
  tokenSource,
  clientId,
  verbose,
  alsoPrintObjectId = false,
}) {
  if (verbose) {
    logPackageRequest({
      registration,
      apiBase,
      token,
      tokenSource,
      clientId,
      appId,
      fileName,
      objectId,
      releaseType,
      releasePhase,
    })
  }

  let data
  try {
    // 入参形状两套接口通用：v2 那边会忽略用不到的 releasePhase（它没有这个参数）
    data = await registration.request({
      token,
      clientId,
      appId,
      fileName,
      objectId,
      releaseType,
      releasePhase,
      apiBase,
    })
  } catch (error) {
    // 网络/接口失败属于运行期问题，不是用法问题，所以只报错不打印帮助文档
    stderr(`错误: ${registration.title}失败: ${error.message}`)
    return EXIT_FAILURE
  }

  const identifier = packageIdentifier(registration, data)
  if (verbose) {
    stderr('已登记软件包')
    if (identifier !== undefined) {
      // 与上面的对齐保持一致（"packageId:" / "pkgVersion:" 都补到 15 列）
      stderr(`  ${`${registration.identifier}:`.padEnd(15)}${identifier}`)
    }
    stderr(`  响应:          ${JSON.stringify(data)}`)
  }

  // 组合命令（上传 + 登记）输出 objectId，与 *-upload-file 保持一致；
  // 只登记的命令输出软件包标识（packageId 或 pkgVersion，用于查询编译状态）。
  // 两者都是可选字段，缺了就退回整个响应 JSON，避免输出空行。
  if (alsoPrintObjectId) {
    stdout(objectId === undefined ? JSON.stringify(data) : String(objectId))
  } else {
    stdout(identifier === undefined ? JSON.stringify(data) : String(identifier))
  }
  return EXIT_OK
}

// --------------------------- huawei *-upload-file-package-info-update

/**
 * 两个 upload-file-package-info-update 命令共用的执行流程：**上传文件**并**登记软件包**。
 *
 * objectId 的来源二选一：
 *   - 已给出 --object-id / HUAWEI_OBJECT_ID —— 直接登记（适用于文件已在别处上传好）
 *   - 未给出 —— 自己走完 *-upload-file 的那套逻辑（取址 → PUT 到 urlInfo.url）拿到 objectId 再登记
 *
 * 登记完成后 stdout 输出的是 **objectId**（上传产物的标识，与 *-upload-file 一致），
 * 软件包标识（.app 的 packageId、.apk 等的 pkgVersion）只出现在 --verbose 日志里——
 * 本命令的重点是「文件传上去并且登记好了」。
 *
 * @returns {Promise<number>} 退出代码（EXIT_OK / EXIT_FAILURE）
 */
async function uploadFileAndUpdatePackageInfo({
  registration,
  appId,
  fileName,
  file,
  size,
  objectId,
  releaseType,
  releasePhase,
  apiBase,
  token,
  tokenSource,
  clientId,
  verbose,
}) {
  let uploadedObjectId = objectId
  if (uploadedObjectId === undefined) {
    // 与 *-upload-file 完全相同的取址逻辑：contentLength 取本地文件的实际字节数
    const result = await fetchUploadUrlAndParams({
      token,
      clientId,
      appId,
      fileName,
      contentLength: String(size),
      apiBase,
    })
    if (result === null) {
      return EXIT_FAILURE
    }

    if (verbose) {
      logUploadUrlDetails({
        apiBase,
        token,
        tokenSource,
        clientId,
        appId,
        fileName,
        contentLength: size,
        file,
        // 文件名与文件大小都取自本地文件，没有「显式值」这一说
        derivedFromFile: [],
        urlInfo: result.urlInfo,
      })
    }

    const uploaded = await uploadFileToObsWithResult({ urlInfo: result.urlInfo, file, size, verbose })
    if (uploaded === null) {
      return EXIT_FAILURE
    }
    if (uploaded.objectId === undefined) {
      stderr('错误: 上传成功但响应中未包含 urlInfo.objectId，无法登记软件包')
      return EXIT_FAILURE
    }
    uploadedObjectId = uploaded.objectId
  } else if (verbose) {
    stderr('复用已上传的文件（未取址、未上传）')
  }

  return registerAppPackage({
    registration,
    appId,
    fileName,
    objectId: uploadedObjectId,
    releaseType,
    releasePhase,
    apiBase,
    token,
    tokenSource,
    clientId,
    verbose,
    alsoPrintObjectId: true,
  })
}

// ---------------------- huawei service-account-upload-file-package-info-update

/**
 * huawei service-account-upload-file-package-info-update：
 * 确定 Service Account Token 后「上传文件 + 登记软件包」（未给 --object-id 时自己上传）。
 *
 * Token 来源优先级见 resolveServiceAccountToken（本地签发优先，其次 --token）。
 */
async function runHuaweiServiceAccountUploadFilePackageInfo(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderHuaweiServiceAccountUploadFilePackageInfoHelp())
    return EXIT_OK
  }

  const help = renderHuaweiServiceAccountUploadFilePackageInfoHelp
  const options = parseOptions(
    argv,
    SERVICE_ACCOUNT_PACKAGE_INFO_OPTIONS,
    help,
    SERVICE_ACCOUNT_PACKAGE_INFO_FLAGS,
  )
  const verbose = resolveVerbose(options, env, help)

  // 全部必填项一次收齐，让使用者一眼看到所有要补的参数
  const params = collectPackageInfoParams(options, env)
  const auth = resolveServiceAccountToken(options, env, help, verbose)
  if (auth !== null && auth.missing !== undefined) {
    params.missing.push(...auth.missing)
  }
  const uploads = params.objectId === undefined
  // 未给 object-id 时要自己上传：--file 必填，且 fileName 一律由文件名推导（见 collectUploadFileParams）
  if (uploads) {
    if ((options.get(OPTION_FILE) ?? readEnv(env, ENV_FILE)) === undefined) {
      params.missing.push(
        `${OPTION_FILE}（本地文件路径；未给 ${OPTION_OBJECT_ID} 时本命令自己上传，文件名也由它推导），` +
          `可用环境变量 ${ENV_FILE}；或改用 ${OPTION_OBJECT_ID} 与 ${OPTION_FILE_NAME} 只做登记`,
      )
    }
  } else if (params.fileName === undefined) {
    params.missing.push(
      `${OPTION_FILE_NAME}（文件名，含后缀），可用环境变量 ${ENV_FILE}（此时按已上传的文件名使用）或 ` +
        `${ENV_FILE_NAME}`,
    )
  }
  if (params.missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${params.missing.join('；')}`, help())
  }
  if (auth === null) {
    return EXIT_FAILURE
  }

  const { appId, objectId, releaseType, releasePhase } = params
  // 上传路径下由 collectUploadFileParams 统一算出 fileName（basename）与 size；
  // 只登记路径下不读文件，fileName 直接按已上传的文件名使用
  const upload = uploads ? collectUploadFileParams(options, env, help) : {}
  const fileName = uploads ? upload.fileName : params.fileName
  // 登记接口由文件名后缀决定（两套接口不能串用），发布参数的取值范围也随之不同；
  // 先定下来再上传，免得传完几十 MB 才因为后缀或参数不合规失败
  const registration = resolvePackageRegistration(fileName, help)
  assertRequiredArguments({ releaseType, releasePhase }, registration, help)

  return uploadFileAndUpdatePackageInfo({
    registration,
    appId,
    fileName,
    file: upload.file,
    size: upload.size,
    objectId,
    releaseType,
    releasePhase,
    apiBase: readEnv(env, ENV_API_BASE) ?? API_BASE_CN,
    token: auth.token,
    tokenSource: auth.source,
    verbose,
  })
}

// -------------------- huawei client-credentials-upload-file-package-info-update

/**
 * huawei client-credentials-upload-file-package-info-update：
 * 换 access_token 后「上传文件 + 登记软件包」（未给 --object-id 时自己上传）。
 *
 * Token 来源优先级见 resolveClientCredentialsToken（本地换取优先，其次 --token）。
 * API 客户端方式按华为要求取上传地址与登记软件包时都要带 client_id 请求头。
 */
async function runHuaweiClientCredentialsUploadFilePackageInfo(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderHuaweiClientCredentialsUploadFilePackageInfoHelp())
    return EXIT_OK
  }

  const help = renderHuaweiClientCredentialsUploadFilePackageInfoHelp
  const options = parseOptions(
    argv,
    CLIENT_CREDENTIALS_PACKAGE_INFO_OPTIONS,
    help,
    CLIENT_CREDENTIALS_PACKAGE_INFO_FLAGS,
  )
  const verbose = resolveVerbose(options, env, help)

  // 全部必填项一次收齐，让使用者一眼看到所有要补的参数
  const params = collectPackageInfoParams(options, env)
  const auth = await resolveClientCredentialsToken(options, env, help, verbose)
  if (auth !== null && auth.missing !== undefined) {
    params.missing.push(...auth.missing)
  }
  const uploads = params.objectId === undefined
  // 未给 object-id 时要自己上传：--file 必填，且 fileName 一律由文件名推导（见 collectUploadFileParams）
  if (uploads) {
    if ((options.get(OPTION_FILE) ?? readEnv(env, ENV_FILE)) === undefined) {
      params.missing.push(
        `${OPTION_FILE}（本地文件路径；未给 ${OPTION_OBJECT_ID} 时本命令自己上传，文件名也由它推导），` +
          `可用环境变量 ${ENV_FILE}；或改用 ${OPTION_OBJECT_ID} 与 ${OPTION_FILE_NAME} 只做登记`,
      )
    }
  } else if (params.fileName === undefined) {
    params.missing.push(
      `${OPTION_FILE_NAME}（文件名，含后缀），可用环境变量 ${ENV_FILE}（此时按已上传的文件名使用）或 ` +
        `${ENV_FILE_NAME}`,
    )
  }
  if (params.missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${params.missing.join('；')}`, help())
  }
  if (auth === null) {
    return EXIT_FAILURE
  }

  const { appId, objectId, releaseType, releasePhase } = params
  // 上传路径下由 collectUploadFileParams 统一算出 fileName（basename）与 size；
  // 只登记路径下不读文件，fileName 直接按已上传的文件名使用
  const upload = uploads ? collectUploadFileParams(options, env, help) : {}
  const fileName = uploads ? upload.fileName : params.fileName
  // 登记接口由文件名后缀决定（两套接口不能串用），发布参数的取值范围也随之不同；
  // 先定下来再上传，免得传完几十 MB 才因为后缀或参数不合规失败
  const registration = resolvePackageRegistration(fileName, help)
  assertRequiredArguments({ releaseType, releasePhase }, registration, help)

  return uploadFileAndUpdatePackageInfo({
    registration,
    appId,
    fileName,
    file: upload.file,
    size: upload.size,
    objectId,
    releaseType,
    releasePhase,
    apiBase: auth.apiBase,
    token: auth.token,
    tokenSource: auth.source,
    clientId: auth.clientId,
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
          ['service-account-upload-file', '上传文件（Service Account）'],
          ['service-account-upload-file-package-info-update', '上传文件并登记软件包（Service Account）'],
          ['client-credentials', '获取 access_token（API 客户端）'],
          ['client-credentials-upload-url', '获取文件上传地址（API 客户端）'],
          ['client-credentials-upload-file', '上传文件（API 客户端）'],
          ['client-credentials-upload-file-package-info-update', '上传文件并登记软件包（API 客户端）'],
          ['signing-config', '生成鸿蒙 build-profile.json5 签名配置'],
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
      `  ${PROGRAM} huawei service-account-upload-url --app-id <应用ID> --file ./a1.apk \\`,
      `    --kid <密钥ID> --iss <签发者> --private-key ./private.pem`,
      `  ${PROGRAM} huawei service-account-upload-file --app-id <应用ID> --file ./a1.apk \\`,
      `    --kid <密钥ID> --iss <签发者> --private-key ./private.pem`,
      `  ${PROGRAM} huawei service-account-upload-file-package-info-update --app-id <应用ID> \\`,
      `    --file ./a1.apk --kid <密钥ID> --iss <签发者> --private-key ./private.pem`,
      `  ${PROGRAM} huawei signing-config --store-file ./storeFile.p12 \\`,
      `    --certpath ./certpath.cer --profile ./profile.p7b --key-alias dev --write`,
    ],
  })
}

/**
 * 华为原始文档：获取服务端授权（服务器鉴权）。
 *
 * 华为把两套鉴权方式写在同一篇文档里，本项目两套都实现，因此共享同一个出处：
 *   - Service Account 方式：私钥本地签发 PS256 JWT（见 huawei service-account）
 *   - API 客户端方式：client_id + client_secret 换取 access_token（见 huawei client-credentials）
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
  ['--file <文件>', '本地文件路径：用它的文件名补 --file-name、用它的字节数补 --content-length'],
  ['--file-name <文件名>', '上传的文件名，如 a1.apk；给出 --file 且未显式指定时取该文件的文件名'],
  ['--content-length <字节>', '文件大小（字节，非负整数）；给出 --file 且未显式指定时取该文件大小'],
]

const UPLOAD_URL_PARAM_ENV = [
  [ENV_APP_ID, '应用 ID，等价于 --app-id'],
  [ENV_FILE, '本地文件路径，等价于 --file'],
  [ENV_FILE_NAME, '文件名，等价于 --file-name'],
  [ENV_CONTENT_LENGTH, '文件大小（字节），等价于 --content-length'],
]

/**
 * 两个 upload-url 命令共用的「应用与文件参数」说明：把 --file 的补缺规则一次讲清。
 * 规则本身写在 collectUploadUrlParams 里，这里只是同一套规则的文字版，改一处必须改另一处。
 */
const UPLOAD_URL_FILE_NOTES = [
  `说明: ${OPTION_FILE} 只用来补缺失项：${OPTION_FILE_NAME} 取该文件的文件名，${OPTION_CONTENT_LENGTH} 取该文件的字节数`,
  `说明: ${OPTION_FILE_NAME} / ${OPTION_CONTENT_LENGTH} 显式给出（选项或环境变量）时以显式值为准，此时不再读文件`,
  `说明: 只有真的需要从文件推导时才读它，因此那时路径必须存在且是普通文件，否则直接报用法错误`,
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
    `  RESP=$(${PROGRAM} huawei ${command} --app-id <应用ID> --file ./a1.apk)`,
    `  curl -X "$(jq -r .urlInfo.method <<<"$RESP")" -T a1.apk "$(jq -r .urlInfo.url <<<"$RESP")"`,
    ...UPLOAD_URL_FILE_NOTES,
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
      `  ${PROGRAM} huawei service-account-upload-url --app-id <应用ID> --file ./a1.apk --token <Token>`,
      `  ${PROGRAM} huawei service-account-upload-url --app-id <应用ID> --file ./a1.apk \\`,
      `    --kid <密钥ID> --iss <签发者> --private-key ./private.pem`,
      `  ${PROGRAM} huawei service-account-upload-url --app-id <应用ID> --file ./a1.apk --file-name a1-release.apk`,
      `  ${ENV_APP_ID}=<应用ID> ${ENV_FILE}=./a1.apk ${ENV_TOKEN}=<Token> ${PROGRAM} huawei service-account-upload-url`,
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
      `  ${PROGRAM} huawei client-credentials-upload-url --app-id <应用ID> --file ./a1.apk --token <access_token>`,
      `  ${PROGRAM} huawei client-credentials-upload-url --app-id <应用ID> --file ./a1.apk \\`,
      `    --client-id <客户端ID> --client-secret <客户端密钥>`,
      `  ${ENV_APP_ID}=<应用ID> ${ENV_FILE}=./a1.apk \\`,
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

/** 华为原始文档：上传文件（Upload Management API） */
const UPLOAD_FILE_DOC_URL =
  'https://developer.huawei.com/consumer/cn/doc/doccenter-connect-api/agc-help-upload-api-upload-file-0000002271160621'

/**
 * 两个 upload-file 命令共用的帮助片段：应用与文件参数、输出、退出代码。
 * 两个命令的差别只在「Token 怎么来」，这些内容必须保持一致，所以只写一份。
 */
const UPLOAD_FILE_PARAM_OPTIONS = [
  ['--app-id <应用 ID>', 'AppGallery Connect 的 appId（非负整数），必填'],
  ['--file <文件>', '待上传的本地文件路径（选项或环境变量），必填；文件名与文件大小都取自它'],
  ['--file-name <文件名>', `上传后的文件名（含后缀），默认取 --file 的文件名（可用 ${ENV_FILE_NAME}）`],
]

const UPLOAD_FILE_PARAM_ENV = [
  [ENV_APP_ID, '应用 ID，等价于 --app-id'],
  [ENV_FILE, '待上传的本地文件路径，等价于 --file'],
  [ENV_FILE_NAME, '上传后的文件名，等价于 --file-name'],
]

/**
 * 两个 upload-file 命令共用的「文件参数」说明。
 * 规则本身写在 collectUploadFileParams 里，这里只是同一套规则的文字版，改一处必须改另一处。
 */
const UPLOAD_FILE_NOTES = [
  `说明: 文件名与文件大小都取自 ${OPTION_FILE}（${ENV_CONTENT_LENGTH} 已不参与本命令）`,
  '说明: 华为要求上传的字节数与取址时填写的 contentLength 一致，因此文件大小恒取本地文件实际字节数',
  '说明: 本命令只把文件传到对象存储，控制台「软件包管理」里还看不到它',
  '说明: 要让它出现在软件包管理里，需再用 *-upload-file-package-info-update 把 objectId 登记到应用上',
  `说明: ${UPLOAD_URL_TTL_NOTE}`,
  '说明: 上传请求头完全取自 urlInfo.headers（含 Host 与 user-agent，它们是 OBS 签名的一部分），不做增删',
  '说明: 文件内容一次性读入内存，超大安装包（数 GB）需要更多内存',
  `说明: 默认只把 objectId 写到 stdout，加 --verbose 才输出运行日志（stderr，先日志后结果）`,
  `说明: Token、client_id、Authorization 只以掩码形式出现在日志里，私钥数据不会写入日志`,
  `原始文档: ${UPLOAD_FILE_DOC_URL}`,
]

/** 两个 upload-file 命令共用的「输出」与「退出代码」小节 */
function uploadFileResultSections() {
  return [
    {
      title: '输出',
      entries: [
        ['stdout', '文件在文件服务器中的 objectId（单个字符串）'],
        ['stderr', '--verbose 时的运行日志（Token、Authorization 只打印掩码）；默认不打印'],
      ],
    },
    {
      title: '退出代码',
      entries: [
        ['0', '成功'],
        ['1', '参数缺失、参数错误或上传失败'],
      ],
    },
  ]
}

/** huawei service-account-upload-file 帮助文档：参数缺失时的提示输出、以及 --help */
function renderHuaweiServiceAccountUploadFileHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei service-account-upload-file - 上传文件（Service Account）`,
    usage: [`${PROGRAM} huawei service-account-upload-file [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          ...UPLOAD_FILE_PARAM_OPTIONS,
          ['--token <Token>', '已签发的 Service Account Token；未给出 service-account 参数时使用'],
          ['--kid <密钥 ID>', `service-account：JWT 请求头中的 kid，给出后本地签发 Token（可用 ${ENV_KID} 补齐）`],
          ['--iss <签发者>', `service-account：JWT 载荷中的 iss（可用 ${ENV_ISS} 补齐）`],
          ['--private-key <文件>', 'service-account：私钥 PEM 文件路径（与 --private-key-data 二选一）'],
          ['--private-key-data <PEM>', 'service-account：直接传入私钥 PEM 数据（与 --private-key 二选一）'],
          ['--iat <秒>', `service-account：JWT 签发时间（UTC 秒级时间戳），默认当前时间（可用 ${ENV_IAT} 补齐）`],
          ['--verbose', `输出运行日志（默认只输出 objectId，日志不打印）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          ...UPLOAD_FILE_PARAM_ENV,
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
          ['步骤 1', `GET ${API_BASE_CN}${UPLOAD_URL_PATH}?appId=…&fileName=…&contentLength=…`],
          ['步骤 1 头部', 'Authorization: Bearer <Service Account Token>'],
          ['步骤 2', 'PUT <步骤 1 返回的 urlInfo.url>（方法与请求头取自 urlInfo）'],
          ['步骤 2 头部', '原样发送 urlInfo.headers：Authorization、x-amz-content-sha256、x-amz-date、Host、user-agent、Content-Type'],
          ['步骤 2 载荷', '文件二进制内容，Content-Type 为 application/octet-stream'],
        ],
      },
      ...uploadFileResultSections(),
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} huawei service-account-upload-file --app-id <应用ID> --file ./a1.apk --token <Token>`,
      `  ${PROGRAM} huawei service-account-upload-file --app-id <应用ID> --file ./a1.apk \\`,
      `    --kid <密钥ID> --iss <签发者> --private-key ./private.pem`,
      `  ${PROGRAM} huawei service-account-upload-file --app-id <应用ID> --file ./a1.apk --file-name a1-release.apk`,
      `  ${ENV_APP_ID}=<应用ID> ${ENV_FILE}=./a1.apk ${ENV_TOKEN}=<Token> ${PROGRAM} huawei service-account-upload-file`,
      `  OBJECT_ID=$(${PROGRAM} huawei service-account-upload-file --app-id <应用ID> --file ./a1.apk)`,
      '',
      `说明: --iat 与 ${ENV_IAT} 只作用于本地签发的 JWT，用 --token 时忽略`,
      ...UPLOAD_FILE_NOTES,
    ],
  })
}

/** huawei client-credentials-upload-file 帮助文档：参数缺失时的提示输出、以及 --help */
function renderHuaweiClientCredentialsUploadFileHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei client-credentials-upload-file - 上传文件（API 客户端）`,
    usage: [`${PROGRAM} huawei client-credentials-upload-file [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          ...UPLOAD_FILE_PARAM_OPTIONS,
          ['--token <access_token>', '已换取的 access_token；本地换取未触发时使用（也可与 --client-id 搭配，仅补 client_id 头）'],
          [
            '--client-id <客户端 ID>',
            `client-credentials：API 客户端 ID，给出后本地换取 access_token（可用 ${ENV_CLIENT_ID} 补齐）`,
          ],
          ['--client-secret <密钥>', `client-credentials：API 客户端密钥（可用 ${ENV_CLIENT_SECRET} 补齐）`],
          ['--verbose', `输出运行日志（默认只输出 objectId，日志不打印）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          ...UPLOAD_FILE_PARAM_ENV,
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
          ['步骤 1', `GET ${API_BASE_CN}${UPLOAD_URL_PATH}?appId=…&fileName=…&contentLength=…`],
          ['步骤 1 头部', 'Authorization: Bearer <access_token> 与 client_id: <客户端 ID>（API 客户端方式两个都要）'],
          ['步骤 2', 'PUT <步骤 1 返回的 urlInfo.url>（方法与请求头取自 urlInfo）'],
          ['步骤 2 头部', '原样发送 urlInfo.headers：Authorization、x-amz-content-sha256、x-amz-date、Host、user-agent、Content-Type'],
          ['步骤 2 载荷', '文件二进制内容，Content-Type 为 application/octet-stream'],
        ],
      },
      ...uploadFileResultSections(),
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} huawei client-credentials-upload-file --app-id <应用ID> --file ./a1.apk --token <access_token>`,
      `  ${PROGRAM} huawei client-credentials-upload-file --app-id <应用ID> --file ./a1.apk \\`,
      `    --client-id <客户端ID> --client-secret <客户端密钥>`,
      `  ${ENV_APP_ID}=<应用ID> ${ENV_FILE}=./a1.apk \\`,
      `    ${ENV_CLIENT_ID}=<客户端ID> ${ENV_CLIENT_SECRET}=<密钥> ${PROGRAM} huawei client-credentials-upload-file`,
      `  OBJECT_ID=$(${PROGRAM} huawei client-credentials-upload-file --app-id <应用ID> --file ./a1.apk)`,
      '',
      `说明: 用 --token 时，只要给得出 client_id（${OPTION_CLIENT_ID} 或 ${ENV_CLIENT_ID}）就一并作为 client_id 头发出`,
      ...UPLOAD_FILE_NOTES,
    ],
  })
}

/** 华为原始文档：更新应用软件包信息（Publishing API，上传三步中的第三步，HarmonyOS 5 及以上） */
const PACKAGE_INFO_DOC_URL =
  'https://developer.huawei.com/consumer/cn/doc/doccenter-connect-api/agc-help-publish-api-app-package-info-update-0000002236201250'

/** 华为原始文档：更新应用文件信息（Publishing API，上传三步中的第三步，HarmonyOS 3.1/4.0 及以下、Android） */
const APP_FILE_INFO_DOC_URL =
  'https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-References/agcapi-app-file-info-0000001111685202'

/**
 * 两个 upload-file-package-info-update 命令共用的帮助片段：应用、文件与发布参数，以及输出与退出代码。
 * 两个命令的差别只在「Token 怎么来」，这些内容必须保持一致，所以只写一份。
 */
const PACKAGE_INFO_PARAM_OPTIONS = [
  ['--app-id <应用 ID>', 'AppGallery Connect 的 appId，必填'],
  ['--file <文件>', `待上传的本地文件路径；未给 ${OPTION_OBJECT_ID} 时必填（本命令自己上传）`],
  ['--file-name <文件名>', `文件名（含后缀），必填；后缀决定走哪套登记接口（见下），可用 ${ENV_FILE}（未给 --file 时）或 ${ENV_FILE_NAME}`],
  [OPTION_OBJECT_ID + ' <对象 ID>', `已上传文件的 objectId；给出则跳过取址与上传，直接登记（可用 ${ENV_OBJECT_ID}）`],
  ['--release-type <取值>', `应用发布方式，默认 1；取值随接口不同（见下），可用 ${ENV_RELEASE_TYPE}`],
  ['--release-phase <0|3>', `分阶段发布标识：0 全网、3 分阶段，默认 0；只有 .app 有该参数（可用 ${ENV_RELEASE_PHASE}）`],
]

const PACKAGE_INFO_PARAM_ENV = [
  [ENV_APP_ID, '应用 ID，等价于 --app-id'],
  [ENV_FILE, '待上传的本地文件路径，等价于 --file（也作为 --file-name 的默认值）'],
  [ENV_FILE_NAME, '文件名（含后缀），等价于 --file-name'],
  [ENV_OBJECT_ID, '已上传文件的 objectId，等价于 --object-id'],
  [ENV_RELEASE_TYPE, '应用发布方式，等价于 --release-type'],
  [ENV_RELEASE_PHASE, '分阶段发布标识，等价于 --release-phase'],
]

/**
 * 两个 upload-file-package-info-update 命令共用的「登记的接口」小节。
 *
 * 华为把登记软件包拆成了两套互斥的接口，只能按安装包后缀选（见 resolvePackageRegistration）：
 * 这里把「后缀 → 接口 → 载荷 → 发布参数 → 返回的软件包标识」一次列清，
 * 免得使用者按 HarmonyOS 文档去登记 .apk，只换回 204144641（后缀不对）。
 */
function packageRegistrationSections() {
  return [
    {
      title: '登记的接口（按 --file-name 的后缀二选一，不能串用）',
      entries: [
        [
          describeSuffixes(HARMONYOS_PACKAGE_REGISTRATION),
          `${HARMONYOS_PACKAGE_REGISTRATION.platform}：PUT {域名}${APP_PACKAGE_INFO_PATH}?appId=…[&releaseType=…][&releasePhase=…]，` +
            '载荷 {"fileName":"a1.app","objectId":"CN/…/xxx.app"}，返回 packageId',
        ],
        [
          describeSuffixes(LEGACY_PACKAGE_REGISTRATION),
          `${LEGACY_PACKAGE_REGISTRATION.platform}：PUT {域名}${APP_FILE_INFO_PATH}?appId=…[&releaseType=…]，` +
            '载荷 {"fileType":5,"files":[{"fileName":"a1.apk","fileDestUrl":"CN/…/xxx.apk"}]}，返回 pkgVersion',
        ],
        [
          '--release-type',
          `应用发布方式，默认 1：${describeSuffixes(HARMONYOS_PACKAGE_REGISTRATION)} 用 ` +
            `${HARMONYOS_PACKAGE_REGISTRATION.releaseTypeValues}；${describeSuffixes(LEGACY_PACKAGE_REGISTRATION)} 用 ` +
            `${LEGACY_PACKAGE_REGISTRATION.releaseTypeValues}`,
        ],
        [
          '--release-phase',
          `分阶段发布标识，默认 0：0 全网、3 分阶段；只有 ${describeSuffixes(HARMONYOS_PACKAGE_REGISTRATION)} 有该参数，` +
            `${describeSuffixes(LEGACY_PACKAGE_REGISTRATION)} 的分阶段发布用 --release-type 3 表达`,
        ],
        ['软件包标识', '登记成功后用于查询软件包编译状态：.app 是 packageId，.apk 等是 pkgVersion（见 --verbose）'],
      ],
    },
  ]
}

/**
 * 两个 upload-file-package-info-update 命令共用的说明：把「上传三步」讲清，
 * 并说明本命令是如何把第 2、3 步（上传、登记）合成一条命令的。
 */
const PACKAGE_INFO_NOTES = [
  '说明: 上传文件分三步——取上传地址、上传到 OBS、登记软件包；本命令把后两步一次做完',
  `说明: 不传 ${OPTION_OBJECT_ID} 时本命令自己走 取址 + 上传（与 *-upload-file 完全相同的逻辑），再登记`,
  `说明: 传了 ${OPTION_OBJECT_ID} 时就跳过取址与上传，只做登记（复用别处已上传的文件，此时不需要 --file）`,
  '说明: 只做取址 + 上传（即 *-upload-file）时文件只在对象存储里，控制台「软件包管理」看不到它',
  `说明: ${OPTION_OBJECT_ID} 可来自 *-upload-file 的 stdout（或 *-upload-url 响应里的 urlInfo.objectId）`,
  `说明: ${OPTION_FILE_NAME} 必须与取上传地址时用的文件名一致（含后缀）；文件名后缀同时决定走哪套登记接口，认不出的后缀在本地就报错`,
  `说明: 用 .apk 等去调 v3 接口会被华为按后缀拦下（错误码 204144641「The suffix name of the software package is incorrect」），所以两套接口由本命令按后缀自动选`,
  '说明: 应用版本处于「审核中」或分阶段发布中时，登记会返回 204144647（更新服务失败），需等版本回到可编辑状态再试；实测此时华为仍会把软件包加进「软件包管理」列表',
  `说明: 未给 ${OPTION_FILE_NAME} 时，文件名取 ${OPTION_FILE} 的 basename（只取文件名，不带目录）`,
  `说明: 复用 ${OPTION_OBJECT_ID}（只登记）时，${ENV_FILE} 按「已上传的文件名」理解，不做路径解析`,
  '说明: 取上传地址与上传文件用 octet-stream，登记软件包用 application/json，是两个不同的请求',
  '说明: 默认只把 objectId 写到 stdout（软件包标识见 --verbose），加 --verbose 才输出运行日志（stderr，先日志后结果）',
  '说明: Token、client_id、Authorization 只以掩码形式出现在日志里，私钥数据不会写入日志',
  `原始文档（HarmonyOS 5 及以上）: ${PACKAGE_INFO_DOC_URL}`,
  `原始文档（Android 与 HarmonyOS 4 及以下）: ${APP_FILE_INFO_DOC_URL}`,
]

/** 两个 upload-file-package-info-update 命令共用的「输出」与「退出代码」小节 */
function packageInfoResultSections() {
  return [
    {
      title: '输出',
      entries: [
        ['stdout', 'objectId（上传产物的对象 ID，与 *-upload-file 一致；复用 --object-id 时原样回显）'],
        ['stderr', '--verbose 时的运行日志：含登记结果（.app 的 packageId、.apk 等的 pkgVersion；Token、client_id 只打印掩码）'],
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

/** huawei service-account-upload-file-package-info-update 帮助文档：参数缺失时的提示输出、以及 --help */
function renderHuaweiServiceAccountUploadFilePackageInfoHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei service-account-upload-file-package-info-update - 上传文件并登记软件包（Service Account）`,
    usage: [`${PROGRAM} huawei service-account-upload-file-package-info-update [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          ...PACKAGE_INFO_PARAM_OPTIONS,
          ['--token <Token>', '已签发的 Service Account Token；未给出 service-account 参数时使用'],
          ['--kid <密钥 ID>', `service-account：JWT 请求头中的 kid，给出后本地签发 Token（可用 ${ENV_KID} 补齐）`],
          ['--iss <签发者>', `service-account：JWT 载荷中的 iss（可用 ${ENV_ISS} 补齐）`],
          ['--private-key <文件>', 'service-account：私钥 PEM 文件路径（与 --private-key-data 二选一）'],
          ['--private-key-data <PEM>', 'service-account：直接传入私钥 PEM 数据（与 --private-key 二选一）'],
          ['--iat <秒>', `service-account：JWT 签发时间（UTC 秒级时间戳），默认当前时间（可用 ${ENV_IAT} 补齐）`],
          ['--verbose', `输出运行日志（含软件包标识：.app 是 packageId、.apk 等是 pkgVersion；默认只输出 objectId）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          ...PACKAGE_INFO_PARAM_ENV,
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
      ...packageRegistrationSections(),
      {
        title: '请求（未给 --object-id 时三步都走）',
        entries: [
          ['1. 取址', `GET ${API_BASE_CN}${UPLOAD_URL_PATH}?appId=…&fileName=…&contentLength=…`],
          ['2. 上传', 'PUT <步骤 1 返回的 urlInfo.url>，请求头原样取自 urlInfo.headers'],
          ['3. 登记', `PUT ${API_BASE_CN}${APP_PACKAGE_INFO_PATH}（.app）或 ${API_BASE_CN}${APP_FILE_INFO_PATH}（.apk 等）`],
          ['步骤 3 头部', 'Authorization: Bearer <Service Account Token> 与 Content-Type: application/json'],
          ['步骤 3 载荷', '.app：{"fileName":"a1.app","objectId":"CN/…/xxx.app"}；.apk 等：{"fileType":5,"files":[{"fileName":"a1.apk","fileDestUrl":"CN/…/xxx.apk"}]}'],
        ],
      },
      ...packageInfoResultSections(),
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} huawei service-account-upload-file-package-info-update --app-id <应用ID> \\`,
      `    --file ./a1.apk --kid <密钥ID> --iss <签发者> --private-key ./private.pem`,
      `  ${PROGRAM} huawei service-account-upload-file-package-info-update --app-id <应用ID> \\`,
      `    --file ./a1.apk --token <Token> --release-type 3`,
      '  # .app（HarmonyOS 5 及以上）走另一套接口，releaseType 取 1 / 7',
      `  ${PROGRAM} huawei service-account-upload-file-package-info-update --app-id <应用ID> \\`,
      `    --file ./a1.app --token <Token> --release-type 7 --release-phase 3`,
      '  # 文件已上传过：只登记，不再上传',
      `  ${PROGRAM} huawei service-account-upload-file-package-info-update --app-id <应用ID> \\`,
      `    --file-name a1.apk --object-id CN/2026…/xxx.apk --token <Token>`,
      `  ${ENV_APP_ID}=<应用ID> ${ENV_FILE}=./a1.apk ${ENV_TOKEN}=<Token> ${PROGRAM} huawei service-account-upload-file-package-info-update`,
      '',
      `说明: --iat 与 ${ENV_IAT} 只作用于本地签发的 JWT，用 --token 时忽略`,
      ...PACKAGE_INFO_NOTES,
    ],
  })
}

/** huawei client-credentials-upload-file-package-info-update 帮助文档：参数缺失时的提示输出、以及 --help */
function renderHuaweiClientCredentialsUploadFilePackageInfoHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei client-credentials-upload-file-package-info-update - 上传文件并登记软件包（API 客户端）`,
    usage: [`${PROGRAM} huawei client-credentials-upload-file-package-info-update [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          ...PACKAGE_INFO_PARAM_OPTIONS,
          ['--token <access_token>', '已换取的 access_token；本地换取未触发时使用（也可与 --client-id 搭配，仅补 client_id 头）'],
          [
            '--client-id <客户端 ID>',
            `client-credentials：API 客户端 ID，给出后本地换取 access_token（可用 ${ENV_CLIENT_ID} 补齐）`,
          ],
          ['--client-secret <密钥>', `client-credentials：API 客户端密钥（可用 ${ENV_CLIENT_SECRET} 补齐）`],
          ['--verbose', `输出运行日志（含软件包标识：.app 是 packageId、.apk 等是 pkgVersion；默认只输出 objectId）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          ...PACKAGE_INFO_PARAM_ENV,
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
      ...packageRegistrationSections(),
      {
        title: '请求（未给 --object-id 时三步都走）',
        entries: [
          ['1. 取址', `GET ${API_BASE_CN}${UPLOAD_URL_PATH}?appId=…&fileName=…&contentLength=…`],
          ['2. 上传', 'PUT <步骤 1 返回的 urlInfo.url>，请求头原样取自 urlInfo.headers'],
          ['3. 登记', `PUT ${API_BASE_CN}${APP_PACKAGE_INFO_PATH}（.app）或 ${API_BASE_CN}${APP_FILE_INFO_PATH}（.apk 等）`],
          ['步骤 3 头部', 'Authorization: Bearer <access_token>、client_id: <客户端 ID>、Content-Type: application/json'],
          ['步骤 3 载荷', '.app：{"fileName":"a1.app","objectId":"CN/…/xxx.app"}；.apk 等：{"fileType":5,"files":[{"fileName":"a1.apk","fileDestUrl":"CN/…/xxx.apk"}]}'],
        ],
      },
      ...packageInfoResultSections(),
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} huawei client-credentials-upload-file-package-info-update --app-id <应用ID> \\`,
      `    --file ./a1.apk --client-id <客户端ID> --client-secret <客户端密钥>`,
      `  ${PROGRAM} huawei client-credentials-upload-file-package-info-update --app-id <应用ID> \\`,
      `    --file ./a1.apk --token <access_token> --release-type 3`,
      '  # .app（HarmonyOS 5 及以上）走另一套接口，releaseType 取 1 / 7',
      `  ${PROGRAM} huawei client-credentials-upload-file-package-info-update --app-id <应用ID> \\`,
      `    --file ./a1.app --token <access_token> --release-type 7 --release-phase 3`,
      '  # 文件已上传过：只登记，不再上传',
      `  ${PROGRAM} huawei client-credentials-upload-file-package-info-update --app-id <应用ID> \\`,
      `    --file-name a1.apk --object-id CN/2026…/xxx.apk --token <access_token>`,
      '',
      `说明: 用 --token 时，只要给得出 client_id（${OPTION_CLIENT_ID} 或 ${ENV_CLIENT_ID}）就一并作为 client_id 头发出`,
      ...PACKAGE_INFO_NOTES,
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
  if (command === 'service-account-upload-file') {
    return runHuaweiServiceAccountUploadFile(rest, env)
  }
  if (command === 'client-credentials-upload-file') {
    return runHuaweiClientCredentialsUploadFile(rest, env)
  }
  if (command === 'service-account-upload-file-package-info-update') {
    return runHuaweiServiceAccountUploadFilePackageInfo(rest, env)
  }
  if (command === 'client-credentials-upload-file-package-info-update') {
    return runHuaweiClientCredentialsUploadFilePackageInfo(rest, env)
  }
  if (command === 'signing-config') {
    return runHuaweiSigningConfig(rest, env)
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
