/**
 * 命令行通用设施：程序名、退出代码、输出、帮助标记与选项解析。
 *
 * 本模块不含任何厂商信息——各厂商的命令与帮助文档放在各自的模块里
 * （如 src/huawei.js），只复用这里的工具函数。
 */
import process from 'node:process'

/** 程序名，帮助文档的「用法」「示例」里使用 */
export const PROGRAM = 'publish-apk'

/** 退出代码：成功 */
export const EXIT_OK = 0
/** 退出代码：参数缺失、参数错误或调用失败 */
export const EXIT_FAILURE = 1

/**
 * 参数错误：统一「stderr 记录错误日志 + stdout 输出对应帮助文档 + 退出代码 1」。
 *
 * help 传的是渲染好的帮助文档文本，因此本模块不需要知道任何厂商的帮助内容。
 */
export class UsageError extends Error {
  constructor(message, help) {
    super(message)
    this.name = 'UsageError'
    this.help = help
  }
}

export const stdout = (text) => process.stdout.write(`${text}\n`)
export const stderr = (text) => process.stderr.write(`${text}\n`)

/**
 * 写入 stdout 并在数据写完（或冲刷进管道）后 resolve，供顺序敏感的输出使用。
 *
 * 用法错误要「先用法、后错误」：帮助文档写 stdout、错误日志写 stderr，两个流各自独立，
 * 直接顺序调用时实际落地顺序取决于各流的缓冲，终端里常常先看到错误。因此这里提供可 await
 * 的写入，让调用方能在写完帮助文档之后再写错误日志。EPIPE 等写入错误不在这里处理
 * （由 installOutputGuards 决定忽略还是抛出），所以回调一律 resolve。
 */
export function writeStdout(text) {
  return new Promise((resolve) => {
    process.stdout.write(`${text}\n`, () => resolve())
  })
}

/**
 * 下游提前关闭管道时（例如 `... --help | head`、`| less` 后按 q、被工具截断输出），
 * Node 默认把 EPIPE 抛成未捕获异常，于是「看帮助文档」会变成打印堆栈 + 退出代码 1。
 * 帮助文档不该这样失败，所以静默忽略 EPIPE；其他写入错误照旧抛出。
 */
export function installOutputGuards() {
  const ignoreEpipe = (error) => {
    if (error?.code !== 'EPIPE') {
      throw error
    }
  }
  process.stdout.on('error', ignoreEpipe)
  process.stderr.on('error', ignoreEpipe)
}

/**
 * 帮助标记：子命令 help，或 -h / -help / --h / --help 等写法（忽略大小写）。
 *
 * 容错识别是为了保证「要帮助」永远不会被当成参数错误：
 *   help、-h、-help、--h、--help、--HELP、--help=true
 */
const HELP_REQUEST = /^(?:help|-{1,2}h(?:elp)?)$/i

/** 是否在请求帮助文档：去掉 `=value` 部分后按 HELP_REQUEST 判断 */
export function isHelpToken(token) {
  const index = token.indexOf('=')
  const name = index === -1 ? token : token.slice(0, index)
  return HELP_REQUEST.test(name)
}

/**
 * 判断某个 token 是否形如选项（--help、--private-key、--nope）。
 *
 * 注意：私钥 PEM 数据以 `-----BEGIN` 开头，即 `--` 后面紧跟 `-`，
 * 因此这里要求 `--` 后面必须是字母，避免把 PEM 数据误判成选项。
 */
const looksLikeOption = (token) => /^--[A-Za-z]/.test(token)

/**
 * 回显用户输入前的脱敏处理。
 *
 * 私钥 PEM 数据被误当成「未知选项 / 未知参数」时（例如把私钥当裸参数传进来），
 * 原样回显就会把整份密钥写进 stderr、CI 日志和工单里。这类值不逐字符掩码——
 * 几千个星号同样刷屏——而是整体替换为占位符，只保留字符数用于排查。
 * 判断依据：含 PEM 头、含换行，或长度明显超出选项名与常见路径。
 */
const SECRET_LIKE_TOKEN = /-----BEGIN|[\r\n]/
const SECRET_LIKE_TOKEN_LENGTH = 80

function redactToken(token) {
  if (SECRET_LIKE_TOKEN.test(token) || token.length > SECRET_LIKE_TOKEN_LENGTH) {
    return `(已省略，疑似敏感数据，共 ${token.length} 字符)`
  }
  return token
}

/** 拆分 `--private-key=./private.pem` 形式的选项，返回 [选项名, 内联值] */
function splitInlineOption(token) {
  if (!token.startsWith('--')) {
    return [token, undefined]
  }
  const index = token.indexOf('=')
  if (index === -1) {
    return [token, undefined]
  }
  return [token.slice(0, index), token.slice(index + 1)]
}

/** 读取环境变量：未设置或为空串时返回 undefined，避免空串被当成「已提供」 */
export function readEnv(env, name) {
  const value = env[name]
  return value === undefined || value === '' ? undefined : value
}

/**
 * 解析 `--name value` 与 `--name=value` 两种写法，各厂商命令共用同一套规则：
 *   - 只接受 allowed 里的选项名，其余报「未知选项」或「未知参数」
 *   - 同名选项重复出现报错、缺少参数值报错、值为空串报错
 *   - flags 里的开关型选项不带值，出现即为 true
 *
 * @param {string[]} argv 命令名之后的参数
 * @param {Set<string>} allowed 该命令允许的全部选项名（含开关）
 * @param {() => string} help 出错时附带的帮助文档（传函数是为了不在正常路径上白渲染）
 * @param {Set<string>} [flags] 开关型选项名，不接收参数值
 * @returns {Map<string, string | true>} 选项名 → 值（开关为 true）
 */
export function parseOptions(argv, allowed, help, flags = new Set()) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const [name, inlineValue] = splitInlineOption(token)

    if (!allowed.has(name)) {
      const kind = token.startsWith('-') ? '选项' : '参数'
      throw new UsageError(`未知${kind} "${redactToken(token)}"`, help())
    }
    if (options.has(name)) {
      throw new UsageError(`选项 "${name}" 重复指定`, help())
    }

    // 开关型选项：只认 `--verbose` 这种裸写法，写成 `--verbose=true` 属于误用
    if (flags.has(name)) {
      if (inlineValue !== undefined) {
        throw new UsageError(`选项 "${name}" 是开关，不接受参数值`, help())
      }
      options.set(name, true)
      continue
    }

    let value = inlineValue
    if (value === undefined) {
      value = argv[index + 1]
      if (value === undefined || looksLikeOption(value)) {
        throw new UsageError(`选项 "${name}" 缺少参数值`, help())
      }
      index += 1
    }
    if (value === '') {
      throw new UsageError(`选项 "${name}" 的值不能为空`, help())
    }
    options.set(name, value)
  }
  return options
}
