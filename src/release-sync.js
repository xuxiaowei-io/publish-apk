/**
 * Git 发布同步命令（`publish-apk release-sync`）。
 *
 * 目标：把一个仓库的 Release（发布）同步到另一个仓库，内容包括
 *   1. 发布标题、发布说明（body）、草稿 / 预发布 / 是否最新；
 *   2. 全部发布产物（Release 附件），逐个下载后再上传到目标发布；
 *   3. 目标发布所需的标签：目标上没有该标签时，按 `--target-branch` 指定的分支创建；
 *   4. 目标上源没有的附件（多余附件）在最后删除，保证目标产物与源一致。
 *
 * 平台隔离：本文件只做「选发布 → 建标签 → 创建/更新发布 → 搬运附件」的编排，
 * 不认识 cnb.cool 的接口细节。平台能力由适配器提供，第一个适配器是 src/cnb.js：
 *
 *   {
 *     id, label, hosts, defaultHost,
 *     tokenEnvs: { source: [...], target: [...] },     // 令牌环境变量兜底
 *     apiBaseEnvs: { source: [...], target: [...] },   // API 地址环境变量兜底
 *     resolveToken(env, role), resolveApiBase(env, role, override),
 *     createClient({ repo, token, apiBase, fetchImpl }) -> {
 *       getReleaseByTag(tag), getLatestRelease(), getTag(tag),
 *       ensureTag(tag, branch), createRelease(fields), updateRelease(id, fields),
 *       downloadAsset(asset, destPath, { tag }),
 *       uploadAsset(releaseId, assetName, filePath, { overwrite, contentType }),
 *       deleteAsset(releaseId, assetId)
 *     }
 *   }
 *
 * 以后接 Gitee / GitHub：
 *   1. 照 src/cnb.js 的形状新增适配器（如 src/gitee.js、src/github-release.js）；
 *   2. 在下面的 PROVIDERS 里追加一行；
 *   3. 仓库地址解析会按 host 自动选择适配器，编排逻辑不用改。
 *     （GitHub 的 release API 与 CNB 接近，Gitee 需要按其接口调整标签 / 附件上传实现。）
 *
 * 为什么目标标签要基于分支重建：源仓库与目标仓库可能没有相同的提交历史，
 * 直接把源标签的 commit 搬到目标往往不可行；目标只关心「这个版本的发布」，
 * 因此标签指向目标仓库的指定分支。标签已存在时不移动，避免改写已有历史。
 *
 * 安全性：
 *   - 不删除发布；只删除目标上源不存在的附件（源响应缺少附件列表时跳过删除）；
 *   - 同名附件按 SHA 判断：一致跳过、不一致覆盖，重复执行是幂等的；
 *   - 令牌只走环境变量或选项，不写进日志；源 token 只需要读权限，目标 token 需要写权限；
 *   - `--dry-run` 只读源发布与目标状态，不创建标签、发布，也不上传或删除附件。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

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
import { cnbReleaseProvider } from './cnb.js'
import { renderHelp } from './help.js'

/** 根命令名 */
const COMMAND_NAME = 'release-sync'

/** 源仓库地址：https://cnb.cool/org/repo、cnb.cool/org/repo、git@cnb.cool:org/repo.git 或 org/repo */
const OPTION_SOURCE = '--source'
/** 目标仓库地址，写法同 --source */
const OPTION_TARGET = '--target'
/** 指定要同步的发布标签；不给时同步最新发布 */
const OPTION_TAG = '--tag'
/** 开关：同步最新发布（与 --tag 互斥；两者都不给时默认最新） */
const OPTION_LATEST = '--latest'
/** 目标标签不存在时，基于哪个分支创建（默认 main） */
const OPTION_TARGET_BRANCH = '--target-branch'
/** 源仓库令牌；也可用 RELEASE_SYNC_SOURCE_TOKEN / CNB_SOURCE_TOKEN / CNB_TOKEN */
const OPTION_SOURCE_TOKEN = '--source-token'
/** 目标仓库令牌；也可用 RELEASE_SYNC_TARGET_TOKEN / CNB_TARGET_TOKEN / CNB_TOKEN */
const OPTION_TARGET_TOKEN = '--target-token'
/** 源平台 API 地址（本地联调 / 代理）；默认取适配器的默认值 */
const OPTION_SOURCE_API_BASE = '--source-api-base'
/** 目标平台 API 地址（本地联调 / 代理） */
const OPTION_TARGET_API_BASE = '--target-api-base'
/** 开关：只打印计划，不写入目标 */
const OPTION_DRY_RUN = '--dry-run'
/** 开关：输出详细日志 */
const OPTION_VERBOSE = '--verbose'

const SYNC_OPTIONS = new Set([
  OPTION_SOURCE,
  OPTION_TARGET,
  OPTION_TAG,
  OPTION_LATEST,
  OPTION_TARGET_BRANCH,
  OPTION_SOURCE_TOKEN,
  OPTION_TARGET_TOKEN,
  OPTION_SOURCE_API_BASE,
  OPTION_TARGET_API_BASE,
  OPTION_DRY_RUN,
  OPTION_VERBOSE,
])

const SYNC_FLAGS = new Set([OPTION_LATEST, OPTION_DRY_RUN, OPTION_VERBOSE])

const ENV_SOURCE = 'RELEASE_SYNC_SOURCE'
const ENV_TARGET = 'RELEASE_SYNC_TARGET'
const ENV_TAG = 'RELEASE_SYNC_TAG'
const ENV_TARGET_BRANCH = 'RELEASE_SYNC_TARGET_BRANCH'
const ENV_SOURCE_TOKEN = 'RELEASE_SYNC_SOURCE_TOKEN'
const ENV_TARGET_TOKEN = 'RELEASE_SYNC_TARGET_TOKEN'
const ENV_SOURCE_API_BASE = 'RELEASE_SYNC_SOURCE_API_BASE'
const ENV_TARGET_API_BASE = 'RELEASE_SYNC_TARGET_API_BASE'
const ENV_VERBOSE = 'RELEASE_SYNC_VERBOSE'

/** 默认目标分支：CNB 仓库的默认分支通常是 main */
const DEFAULT_TARGET_BRANCH = 'main'

const VERBOSE_ON_VALUES = new Set(['1', 'true', 'yes', 'on'])
const VERBOSE_OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

/**
 * 平台适配器表：顺序即默认顺序；目前只有 CNB。
 * 新增平台时在这里追加，并把它的 host 写进适配器的 hosts。
 */
const PROVIDERS = [cnbReleaseProvider]

/** 省略 host 时按 CNB 处理（目前唯一已实现的平台） */
const DEFAULT_PROVIDER = cnbReleaseProvider

/**
 * 已知但尚未实现适配器的平台。
 *
 * 只在「裸地址」的第一段恰好是这些域名时给出明确提示；像 `xuxiaowei.io/publish-apk`
 * 这样的 CNB 组织名本身带点，不能因为第一段像域名就误判成 GitHub / Gitee。
 */
const UNSUPPORTED_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'gitee.com',
  'www.gitee.com',
  'gitlab.com',
  'www.gitlab.com',
  'gitcode.com',
  'www.gitcode.com',
  'gitlink.org.cn',
  'www.gitlink.org.cn',
])

// ------------------------------------------------------------------ 仓库解析

/** 查找能处理该 host 的适配器 */
function findProviderByHost(host) {
  return PROVIDERS.find((provider) => provider.hosts.has(host))
}

/** 当前已实现的平台域名，拼错误信息用 */
function supportedHosts() {
  const hosts = PROVIDERS.flatMap((provider) => [...provider.hosts])
  return [...new Set(hosts)].join('、')
}

/** 把 URL / SCP 写法里的单个路径段解码；解码失败说明地址写错了 */
function decodeRepoSegment(segment) {
  let decoded
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    throw new Error(`仓库地址包含无效的转义: ${segment}`)
  }
  if (decoded.includes('/')) {
    throw new Error(`仓库路径段不能包含斜杠: ${segment}`)
  }
  return decoded
}

/**
 * 规范化仓库路径：去掉首尾斜杠与 `.git` 后缀，拒绝空段、`.`、`..`。
 *
 * @param {string[]} segments 路径段（已解码）
 * @param {boolean} stripGit 是否去掉最后一段的 .git
 */
function normalizeRepoPath(segments, stripGit = true) {
  const parts = [...segments]
  if (stripGit && parts.length > 0 && parts[parts.length - 1].toLowerCase().endsWith('.git')) {
    parts[parts.length - 1] = parts[parts.length - 1].slice(0, -4)
  }
  if (parts.length < 2) {
    throw new Error('仓库地址需要「组织/仓库」两段，例如 cnb.cool/org/repo 或 org/repo')
  }
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('仓库地址不能包含空路径段、"." 或 ".."')
  }
  return parts.join('/')
}

/**
 * 解析仓库地址，返回 { provider, host, repo, display, webUrl }。
 *
 * 支持的写法：
 *   https://cnb.cool/org/repo(.git)
 *   cnb.cool/org/repo
 *   git@cnb.cool:org/repo.git
 *   org/repo（省略 host，按当前唯一实现的 CNB 处理）
 *
 * 裸地址的歧义处理：
 *   - 第一段恰好是已实现的平台域名 → 平台 + 后面的路径；
 *   - 第一段恰好是已知未实现的平台域名 → 明确报「暂不支持」；
 *   - 其它情况（包括 `xuxiaowei.io/publish-apk` 这种带点的组织名）→ 按默认平台 + 完整路径。
 *
 * @param {string} value 命令行 / 环境变量里的仓库地址
 * @returns {{ provider: object, host: string, repo: string, display: string, webUrl: string }}
 */
export function parseRepositoryValue(value) {
  const text = String(value ?? '').trim()
  if (text === '') {
    throw new Error('仓库地址不能为空')
  }

  let host
  let segments
  let decodeSegments = false

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url
    try {
      url = new URL(text)
    } catch {
      throw new Error(`仓库地址无效: ${text}`)
    }
    if (url.search !== '' || url.hash !== '') {
      throw new Error(`仓库地址不能带查询串或锚点: ${text}`)
    }
    host = url.hostname.toLowerCase()
    segments = url.pathname.split('/')
    decodeSegments = true
  } else {
    const scp = /^([^@\s/]+)@([^:\s/]+):(.+)$/.exec(text)
    if (scp !== null) {
      host = scp[2].toLowerCase()
      segments = scp[3].split('/')
    } else {
      segments = text.split('/')
    }
  }

  if (segments === undefined) {
    throw new Error(`仓库地址无效: ${text}`)
  }
  // 去掉首尾空段（https://host/org/repo/ 与 /org/repo 都常见）
  while (segments.length > 0 && segments[0] === '') {
    segments.shift()
  }
  while (segments.length > 0 && segments[segments.length - 1] === '') {
    segments.pop()
  }
  if (decodeSegments) {
    segments = segments.map(decodeRepoSegment)
  }

  let provider
  if (host !== undefined) {
    provider = findProviderByHost(host)
    if (provider === undefined) {
      if (UNSUPPORTED_HOSTS.has(host)) {
        throw new Error(
          `暂不支持 ${host}：当前只实现了 CNB（cnb.cool）的发布同步，` +
            'Gitee / GitHub 等平台的适配器后续加入',
        )
      }
      throw new Error(
        `暂不支持 Git 平台 "${host}"：当前支持 ${supportedHosts()}；` +
          '其它平台可按 src/cnb.js 的形状新增适配器',
      )
    }
  } else {
    // 裸地址：只有第一段恰好是已知域名时才当成 host
    const first = segments[0]?.toLowerCase()
    const known = first === undefined ? undefined : findProviderByHost(first)
    if (known !== undefined) {
      provider = known
      host = first
      segments = segments.slice(1)
    } else if (first !== undefined && UNSUPPORTED_HOSTS.has(first)) {
      throw new Error(
        `暂不支持 ${first}：当前只实现了 CNB（cnb.cool）的发布同步，` +
          'Gitee / GitHub 等平台的适配器后续加入',
      )
    } else {
      provider = DEFAULT_PROVIDER
      host = provider.defaultHost
    }
  }

  const repo = normalizeRepoPath(segments)
  const canonicalHost = provider.defaultHost
  return {
    provider,
    host: canonicalHost,
    repo,
    display: `${canonicalHost}/${repo}`,
    webUrl: `https://${canonicalHost}/${repo}`,
  }
}

// ------------------------------------------------------------------ 选项解析

/** 读取字符串选项：命令行优先，其次环境变量；空串按未设置处理 */
function optionOrEnv(options, env, option, envName) {
  const fromOption = options.get(option)
  if (typeof fromOption === 'string') {
    return fromOption
  }
  return readEnv(env, envName)
}

/** RELEASE_SYNC_VERBOSE 的取值校验：开关型环境变量必须能明确表达开 / 关 */
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

/**
 * 解析令牌：命令行 > 通用环境变量 > 平台自己的环境变量。
 *
 * 通用变量由本命令定义，平台变量由适配器给出（CNB 是 CNB_SOURCE_TOKEN /
 * CNB_TARGET_TOKEN，以及两者共用的 CNB_TOKEN），便于以后加 Gitee / GitHub。
 */
function resolveSyncToken(options, env, role, provider) {
  const option = role === 'source' ? OPTION_SOURCE_TOKEN : OPTION_TARGET_TOKEN
  const fromOption = options.get(option)
  if (typeof fromOption === 'string' && fromOption.trim() !== '') {
    return { token: fromOption.trim(), source: option }
  }
  const genericName = role === 'source' ? ENV_SOURCE_TOKEN : ENV_TARGET_TOKEN
  const fromEnv = readEnv(env, genericName)
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return { token: fromEnv.trim(), source: genericName }
  }
  const resolved = provider.resolveToken(env, role)
  if (resolved !== undefined) {
    return resolved
  }
  return undefined
}

/** 拼「缺少令牌」时提示的环境变量名 */
function tokenEnvNames(role, provider) {
  const generic = role === 'source' ? ENV_SOURCE_TOKEN : ENV_TARGET_TOKEN
  const platform = provider.tokenEnvs?.[role] ?? []
  return [generic, ...platform]
}

/** 把仓库解析错误转成带帮助文档的用法错误 */
function parseRepositoryOrUsage(value, label, help) {
  try {
    return parseRepositoryValue(value)
  } catch (error) {
    throw new UsageError(`${label} ${error.message}`, help())
  }
}

/** 把适配器的 API 地址错误转成用法错误 */
function resolveApiBaseOrUsage(provider, env, role, override, option, help) {
  try {
    return provider.resolveApiBase(env, role, override)
  } catch (error) {
    throw new UsageError(`${option} ${error.message}`, help())
  }
}

// ------------------------------------------------------------------ 帮助文档

/** release-sync 命令帮助文档 */
function renderReleaseSyncHelp() {
  return renderHelp({
    title: `${PROGRAM} ${COMMAND_NAME} - 同步 Git 平台的发布（Release）`,
    usage: [`${PROGRAM} ${COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [
            `${OPTION_SOURCE} <仓库>`,
            `源仓库（提供发布与附件），必填。支持 https://cnb.cool/org/repo、cnb.cool/org/repo、git@cnb.cool:org/repo.git 或 org/repo；可用 ${ENV_SOURCE} 补齐`,
          ],
          [
            `${OPTION_TARGET} <仓库>`,
            `目标仓库（接收发布与附件），必填，写法同 ${OPTION_SOURCE}；可用 ${ENV_TARGET} 补齐`,
          ],
          [
            `${OPTION_TAG} <标签>`,
            `要同步的发布标签，如 v1.0.0；不给时同步最新发布。可用 ${ENV_TAG} 补齐`,
          ],
          [
            OPTION_LATEST,
            `同步最新发布（与 ${OPTION_TAG} 互斥；两者都不给时默认最新）`,
          ],
          [
            `${OPTION_TARGET_BRANCH} <分支>`,
            `目标标签不存在时基于哪个分支创建，默认 ${DEFAULT_TARGET_BRANCH}；可用 ${ENV_TARGET_BRANCH} 补齐`,
          ],
          [
            `${OPTION_SOURCE_TOKEN} <令牌>`,
            `源仓库访问令牌（读取发布与下载附件）；建议用环境变量，避免进入 ps / shell 历史`,
          ],
          [
            `${OPTION_TARGET_TOKEN} <令牌>`,
            `目标仓库访问令牌（创建标签 / 发布、上传附件）；建议用环境变量`,
          ],
          [
            `${OPTION_SOURCE_API_BASE} <地址>`,
            `源平台 API 地址，默认 https://api.cnb.cool（本地联调 / 代理时覆盖）`,
          ],
          [
            `${OPTION_TARGET_API_BASE} <地址>`,
            `目标平台 API 地址，默认 https://api.cnb.cool（本地联调 / 代理时覆盖）`,
          ],
          [OPTION_DRY_RUN, '只读取源发布与目标状态并打印计划，不创建标签 / 发布、不上传或删除附件'],
          [OPTION_VERBOSE, `输出详细日志（含接口地址、发布 ID、校验结果）；也可用 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_SOURCE, `源仓库，等价于 ${OPTION_SOURCE}`],
          [ENV_TARGET, `目标仓库，等价于 ${OPTION_TARGET}`],
          [ENV_TAG, `发布标签，等价于 ${OPTION_TAG}`],
          [ENV_TARGET_BRANCH, `目标标签的起始分支，等价于 ${OPTION_TARGET_BRANCH}，默认 ${DEFAULT_TARGET_BRANCH}`],
          [
            ENV_SOURCE_TOKEN,
            `源仓库令牌；未设置时依次读 CNB_SOURCE_TOKEN、CNB_TOKEN（当前 CNB 适配器）`,
          ],
          [
            ENV_TARGET_TOKEN,
            `目标仓库令牌；未设置时依次读 CNB_TARGET_TOKEN、CNB_TOKEN（当前 CNB 适配器）`,
          ],
          [ENV_SOURCE_API_BASE, `源平台 API 地址，等价于 ${OPTION_SOURCE_API_BASE}`],
          [ENV_TARGET_API_BASE, `目标平台 API 地址，等价于 ${OPTION_TARGET_API_BASE}`],
          [ENV_VERBOSE, '输出详细日志，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
          ['CNB_SOURCE_TOKEN / CNB_TARGET_TOKEN / CNB_TOKEN', 'CNB 平台令牌；源与目标可用同一个 CNB_TOKEN'],
          ['CNB_SOURCE_API_BASE / CNB_TARGET_API_BASE / CNB_API_BASE', 'CNB API 地址；CNB_API_BASE 对源与目标都生效'],
        ],
      },
      {
        title: '仓库写法',
        entries: [
          ['https://cnb.cool/org/repo', '完整网页地址，可带 .git 后缀'],
          ['cnb.cool/org/repo', '省略协议'],
          ['git@cnb.cool:org/repo.git', 'SCP 风格 SSH 地址'],
          ['org/repo', `省略 host 时按当前唯一实现的 ${DEFAULT_PROVIDER.label} 处理（组织名可带点，如 xuxiaowei.io/repo）`],
        ],
      },
      {
        title: '同步内容',
        entries: [
          ['发布字段', '标题（name）、发布说明（body）、草稿（draft）、预发布（prerelease）、是否最新（is_latest）'],
          ['发布产物', '源发布的全部附件；同名附件两端 SHA 一致时跳过，不一致时覆盖上传'],
          ['目标多余附件', '目标有、源没有的附件在同步后删除（按文件名判断）'],
          ['目标标签', `目标上没有该标签时，基于 ${OPTION_TARGET_BRANCH} 指定的分支创建；已存在时不移动`],
          ['不删除发布', '目标上多出的发布不会被删除（每次只同步当前标签）'],
          ['草稿 / 预发布', '按源发布原样同步；draft 发布同样会搬运附件'],
          ['安全兜底', '源发布响应没有附件列表时，跳过“删除目标多余附件”，避免误删'],
        ],
      },
      {
        title: '权限（CNB）',
        entries: [
          ['源仓库', 'repo-release:r（读取发布、下载附件）'],
          ['目标仓库', 'repo-release:rw（创建标签、创建 / 更新发布、上传 / 确认 / 删除附件）'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', '同步结果摘要：源 / 目标发布、目标标签、附件上传 / 跳过 / 删除情况'],
          ['stderr', '过程日志与错误信息（--verbose 时更详细；令牌不打印）'],
          ['--dry-run', 'stdout 输出计划（含待删除的目标多余附件），不写入目标；仍会读取源发布与目标状态'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功（含 --dry-run）'],
          ['1', '参数缺失 / 参数错误 / 平台不支持 / 接口或传输失败'],
        ],
      },
      {
        title: '当前支持',
        entries: [
          ['CNB（cnb.cool）', '已实现发布、标签、附件上传与下载'],
          ['Gitee / GitHub 等', '适配器接口已预留，后续按 src/cnb.js 的形状加入'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} ${COMMAND_NAME} --source https://cnb.cool/org/source \\`,
      `    --target https://cnb.cool/org/target --tag v1.0.0 --target-branch main`,
      `  ${PROGRAM} ${COMMAND_NAME} --source org/source --target org/target   # 同步最新发布`,
      `  CNB_TOKEN=<令牌> ${PROGRAM} ${COMMAND_NAME} --source org/source --target org/target --tag v1.0.0`,
      `  ${PROGRAM} ${COMMAND_NAME} --source org/source --target org/target --tag v1.0.0 --dry-run`,
      '',
      '说明:',
      `  - ${OPTION_TAG} 与 ${OPTION_LATEST} 不能同时使用；都不给时同步最新发布。`,
      `  - 目标标签已存在时不会移动；如需换起点，请先在目标仓库删除该标签再重跑。`,
      '  - 附件先下载到系统临时目录，再流式上传；结束后自动清理临时文件。',
      '  - 重跑时同名附件先比 SHA：一致跳过、不一致覆盖；目标多出的附件会被删除。',
    ],
  })
}

// ------------------------------------------------------------------ 同步实现

/** 附件对象是否可用（name 必须是非空字符串） */
function isAsset(asset) {
  return asset !== null && typeof asset === 'object' && typeof asset.name === 'string' && asset.name !== ''
}

/** 发布对象是否可当作 api.Release 使用（排除 null / 数组 / 空 body） */
function isReleaseObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 发布对象是否带可用 id（上传 / 删除附件都需要） */
function hasReleaseId(value) {
  return isReleaseObject(value) && value.id !== undefined && value.id !== null && value.id !== ''
}

/** 各 SHA / MD5 摘要的十六进制长度，用于区分 hash_value 是十六进制还是 base64 */
const HASH_HEX_LENGTHS = {
  md5: 32,
  sha1: 40,
  sha256: 64,
  sha512: 128,
}

/**
 * 把 hash_value 归一化成十六进制，便于源 / 目标的十六进制与 base64 写法互相比较。
 * 认不出时保留原值（只在两端写法完全一致时才判定相同），不会误判为一致。
 */
function normalizeHashValue(algo, value) {
  let text = value.trim()
  const colon = text.indexOf(':')
  if (colon !== -1) {
    text = text.slice(colon + 1).trim()
  }
  if (text === '') {
    return undefined
  }
  const expectedHexLength = HASH_HEX_LENGTHS[algo]
  if (
    expectedHexLength !== undefined &&
    text.length === expectedHexLength &&
    /^[0-9a-f]+$/i.test(text)
  ) {
    return text.toLowerCase()
  }
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    const buffer = Buffer.from(base64, 'base64')
    const canonical = buffer.toString('base64').replace(/=+$/, '')
    const same = canonical === base64.replace(/=+$/, '')
    if (same && (expectedHexLength === undefined || buffer.length * 2 === expectedHexLength)) {
      return buffer.toString('hex')
    }
  }
  return text
}

/** hash_algo + hash_value 归一化成可比较的字符串；缺任意一项返回 undefined */
function assetHash(asset) {
  const algo = String(asset?.hash_algo ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-_]/g, '')
  const value = asset?.hash_value
  if (algo === '' || typeof value !== 'string' || value.trim() === '') {
    return undefined
  }
  const normalized = normalizeHashValue(algo, value)
  return normalized === undefined ? undefined : `${algo}:${normalized}`
}

/**
 * 判断目标上同名附件是否已与源附件一致。
 *
 * 只有两端都给出 hash 且（算法 + 值）一致、大小也不冲突时才跳过上传；
 * 缺 hash 时宁可重传，也不靠文件名猜内容是否相同。
 */
function sameAsset(source, target) {
  const sourceHash = assetHash(source)
  const targetHash = assetHash(target)
  if (sourceHash === undefined || targetHash === undefined || sourceHash !== targetHash) {
    return false
  }
  const sourceSize = Number(source.size)
  const targetSize = Number(target.size)
  if (Number.isFinite(sourceSize) && Number.isFinite(targetSize) && sourceSize !== targetSize) {
    return false
  }
  return true
}

/** 目标发布的字段是否与源发布不同（相同则不必 PATCH，减少无意义写入） */
function releaseNeedsUpdate(fields, target) {
  if (Object.hasOwn(fields, 'name') && fields.name !== target.name) {
    return true
  }
  if (Object.hasOwn(fields, 'body') && fields.body !== target.body) {
    return true
  }
  if (Object.hasOwn(fields, 'draft') && fields.draft !== target.draft) {
    return true
  }
  if (Object.hasOwn(fields, 'prerelease') && fields.prerelease !== target.prerelease) {
    return true
  }
  if (Object.hasOwn(fields, 'make_latest')) {
    const desired = fields.make_latest === 'true'
    if (target.is_latest !== desired) {
      return true
    }
  }
  return false
}

/** 人类可读的文件大小；用于日志与摘要 */
function formatSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) {
    return '大小未知'
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return index === 0 ? `${value} B` : `${size.toFixed(1)} ${units[index]}`
}

/** 临时文件的安全文件名：去掉路径与特殊字符，保留扩展名 */
function safeAssetFileName(name, index) {
  const base = basename(String(name)).replace(/[^\w.@+-]/g, '_')
  return `${index}-${base === '' ? 'asset' : base}`
}

/** 摘要里的目标发布状态 */
function releaseActionLabel(action, dryRun) {
  if (dryRun) {
    if (action === 'unchanged') {
      return '已存在，无需更新'
    }
    return action === 'update' ? '已存在，将更新' : '将创建'
  }
  if (action === 'created') {
    return '已创建'
  }
  if (action === 'updated') {
    return '已更新'
  }
  return '已存在，无需更新'
}

/** 摘要里的目标标签状态 */
function tagActionLabel(tagExisted, targetBranch, dryRun) {
  if (dryRun) {
    return tagExisted ? '已存在' : `将基于 ${targetBranch} 创建`
  }
  return tagExisted ? '已存在' : `基于 ${targetBranch} 创建`
}

/**
 * 渲染同步结果摘要（写 stdout）。
 *
 * 行格式保持稳定，便于 CI 里 grep；附件逐行列出状态与大小。
 */
function renderSummary({
  source,
  target,
  tag,
  targetBranch,
  dryRun,
  releaseAction,
  tagExisted,
  decisions,
  uploaded,
  skipped,
  extras = [],
  deleted = [],
}) {
  const lines = []
  if (dryRun) {
    lines.push('[dry-run] 未修改任何内容')
  }
  lines.push(`源发布: ${source.display}@${tag}`)
  lines.push(`目标发布: ${target.display}@${tag}（${releaseActionLabel(releaseAction, dryRun)}）`)
  lines.push(`目标标签: ${tag}（${tagActionLabel(tagExisted, targetBranch, dryRun)}）`)
  lines.push('同步内容: 标题、发布说明、草稿、预发布、最新状态、发布附件、多余附件清理')
  if (decisions.length === 0 && extras.length === 0) {
    lines.push('附件: 无')
    return lines.join('\n')
  }

  const uploadedByName = new Map(uploaded.map((item) => [item.name, item]))
  const extraState =
    extras.length === 0
      ? ''
      : dryRun
        ? `，待删除多余 ${extras.length}`
        : `，删除多余 ${deleted.length}${deleted.length === extras.length ? '' : `/${extras.length}`}`
  if (dryRun) {
    lines.push(
      `附件: ${decisions.length} 个（待上传 ${decisions.filter((item) => !item.skip).length}，` +
        `已存在且 hash 一致 ${decisions.filter((item) => item.skip).length}${extraState}）`,
    )
  } else {
    lines.push(
      `附件: ${decisions.length} 个（已上传 ${uploaded.length}，跳过 ${skipped.length}${extraState}）`,
    )
  }
  for (const decision of decisions) {
    const { asset, skip } = decision
    if (skip) {
      lines.push(`- ${asset.name}（${formatSize(asset.size)}，目标已存在且 hash 一致）`)
      continue
    }
    if (dryRun) {
      lines.push(`- ${asset.name}（${formatSize(asset.size)}，待上传）`)
      continue
    }
    const result = uploadedByName.get(asset.name)
    lines.push(`- ${asset.name}（${formatSize(result?.size ?? asset.size)}，已上传）`)
  }
  const deletedNames = new Set(deleted.map((item) => item.name))
  for (const asset of extras) {
    const state = dryRun
      ? '将从目标删除'
      : deletedNames.has(asset.name)
        ? '已从目标删除'
        : '未删除'
    lines.push(`- ${asset.name}（${formatSize(asset.size)}，${state}）`)
  }
  return lines.join('\n')
}

/**
 * 同步一个发布。
 *
 * @param {string[]} argv `release-sync` 之后的参数
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {Promise<number>} 退出代码
 */
async function runReleaseSync(argv, env) {
  // 只把手写位置的 help 或选项形式的 -h/--help 当帮助请求；
  // 避免把 `--tag help` 这种「标签名恰好叫 help」的值误判成求助。
  const wantsHelp = argv.some(
    (token, index) => isHelpToken(token) && (index === 0 || token.startsWith('-')),
  )
  if (wantsHelp) {
    stdout(renderReleaseSyncHelp())
    return EXIT_OK
  }

  const options = parseOptions(argv, SYNC_OPTIONS, renderReleaseSyncHelp, SYNC_FLAGS)
  const verbose = resolveVerbose(options, env, renderReleaseSyncHelp)
  const dryRun = options.get(OPTION_DRY_RUN) === true

  const sourceValue = optionOrEnv(options, env, OPTION_SOURCE, ENV_SOURCE)
  const targetValue = optionOrEnv(options, env, OPTION_TARGET, ENV_TARGET)
  const tagOption = options.get(OPTION_TAG)
  const latest = options.get(OPTION_LATEST) === true
  if (typeof tagOption === 'string' && latest) {
    throw new UsageError(
      `${OPTION_TAG} 与 ${OPTION_LATEST} 不能同时使用：前者指定标签，后者取最新发布`,
      renderReleaseSyncHelp(),
    )
  }
  const rawTag = latest ? undefined : optionOrEnv(options, env, OPTION_TAG, ENV_TAG)
  const tagValue = rawTag === undefined ? undefined : rawTag.trim() || undefined
  const targetBranch =
    (optionOrEnv(options, env, OPTION_TARGET_BRANCH, ENV_TARGET_BRANCH) ?? DEFAULT_TARGET_BRANCH).trim()

  const missing = []
  if (sourceValue === undefined) {
    missing.push(`${OPTION_SOURCE}（源仓库），可用环境变量 ${ENV_SOURCE}`)
  }
  if (targetValue === undefined) {
    missing.push(`${OPTION_TARGET}（目标仓库），可用环境变量 ${ENV_TARGET}`)
  }
  if (missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${missing.join('；')}`, renderReleaseSyncHelp())
  }
  if (targetBranch === '' || /\s/.test(targetBranch)) {
    throw new UsageError(
      `${OPTION_TARGET_BRANCH} 不能为空或包含空白字符，实际: "${targetBranch}"`,
      renderReleaseSyncHelp(),
    )
  }

  const source = parseRepositoryOrUsage(sourceValue, OPTION_SOURCE, renderReleaseSyncHelp)
  const target = parseRepositoryOrUsage(targetValue, OPTION_TARGET, renderReleaseSyncHelp)
  if (source.provider.id === target.provider.id && source.repo.toLowerCase() === target.repo.toLowerCase()) {
    throw new UsageError(
      `源仓库与目标仓库相同（${source.display}），请指定不同的 --source / --target`,
      renderReleaseSyncHelp(),
    )
  }

  const sourceToken = resolveSyncToken(options, env, 'source', source.provider)
  const targetToken = resolveSyncToken(options, env, 'target', target.provider)
  const missingTokens = []
  if (sourceToken === undefined) {
    missingTokens.push(
      `源仓库令牌（${OPTION_SOURCE_TOKEN}），可用环境变量 ${tokenEnvNames('source', source.provider).join(' / ')}`,
    )
  }
  if (targetToken === undefined) {
    missingTokens.push(
      `目标仓库令牌（${OPTION_TARGET_TOKEN}），可用环境变量 ${tokenEnvNames('target', target.provider).join(' / ')}`,
    )
  }
  if (missingTokens.length > 0) {
    throw new UsageError(`缺少必填参数: ${missingTokens.join('；')}`, renderReleaseSyncHelp())
  }

  const sourceApiBase = resolveApiBaseOrUsage(
    source.provider,
    env,
    'source',
    options.get(OPTION_SOURCE_API_BASE) ?? readEnv(env, ENV_SOURCE_API_BASE),
    OPTION_SOURCE_API_BASE,
    renderReleaseSyncHelp,
  )
  const targetApiBase = resolveApiBaseOrUsage(
    target.provider,
    env,
    'target',
    options.get(OPTION_TARGET_API_BASE) ?? readEnv(env, ENV_TARGET_API_BASE),
    OPTION_TARGET_API_BASE,
    renderReleaseSyncHelp,
  )

  const log = (message) => stderr(message)
  const debug = verbose ? log : () => {}

  log(`同步发布: ${source.display} -> ${target.display}`)
  if (dryRun) {
    log('[dry-run] 只读取，不写入目标仓库')
  }
  debug(`  源 API: ${sourceApiBase}`)
  debug(`  目标 API: ${targetApiBase}`)
  if (sourceToken.source !== undefined) {
    debug(`  源令牌来源: ${sourceToken.source}`)
  }
  if (targetToken.source !== undefined) {
    debug(`  目标令牌来源: ${targetToken.source}`)
  }

  const sourceClient = source.provider.createClient({
    repo: source.repo,
    token: sourceToken.token,
    apiBase: sourceApiBase,
  })
  const targetClient = target.provider.createClient({
    repo: target.repo,
    token: targetToken.token,
    apiBase: targetApiBase,
  })

  // 1) 读取源发布
  let sourceRelease
  try {
    sourceRelease =
      tagValue === undefined ? await sourceClient.getLatestRelease() : await sourceClient.getReleaseByTag(tagValue)
  } catch (error) {
    throw new Error(`读取源发布失败: ${error.message}`)
  }
  if (sourceRelease === null) {
    throw new Error(
      tagValue === undefined
        ? `源仓库 ${source.display} 没有任何发布（或令牌无权访问）`
        : `源仓库 ${source.display} 中不存在标签 "${tagValue}" 的发布（或令牌无权访问）`,
    )
  }
  if (typeof sourceRelease !== 'object' || sourceRelease === null) {
    throw new Error(`源仓库 ${source.display} 返回的发布数据无效`)
  }

  const sourceTag =
    typeof sourceRelease.tag_name === 'string' && sourceRelease.tag_name.trim() !== ''
      ? sourceRelease.tag_name.trim()
      : tagValue
  if (sourceTag === undefined || sourceTag === '') {
    throw new Error('源发布没有 tag_name，无法确定目标标签')
  }
  if (tagValue !== undefined && sourceTag !== tagValue) {
    debug(`  注意: 接口返回的 tag_name 是 "${sourceTag}"，与 --tag "${tagValue}" 不同，以接口为准`)
  }

  // 2) 组装要同步的发布字段
  const releaseFields = {}
  if (typeof sourceRelease.name === 'string') {
    // 源标题为空时用标签名兜底（与 CNB 创建发布时的默认标题一致）
    releaseFields.name = sourceRelease.name !== '' ? sourceRelease.name : sourceTag
  }
  if (typeof sourceRelease.body === 'string') {
    releaseFields.body = sourceRelease.body
  }
  if (typeof sourceRelease.draft === 'boolean') {
    releaseFields.draft = sourceRelease.draft
  }
  if (typeof sourceRelease.prerelease === 'boolean') {
    releaseFields.prerelease = sourceRelease.prerelease
  }
  if (typeof sourceRelease.is_latest === 'boolean') {
    // 显式传 true / false：避免目标平台按创建时间默认把旧版本设成最新
    releaseFields.make_latest = sourceRelease.is_latest ? 'true' : 'false'
  }

  log(`源发布: ${source.display}@${sourceTag}${releaseFields.name === undefined ? '' : `（${releaseFields.name}）`}`)
  if (sourceRelease.id !== undefined) {
    debug(`  源发布 ID: ${sourceRelease.id}`)
  }
  debug(`  发布说明: ${typeof releaseFields.body === 'string' ? `${releaseFields.body.length} 字符` : '无'}`)
  debug(`  草稿: ${releaseFields.draft === true ? '是' : '否'}，预发布: ${releaseFields.prerelease === true ? '是' : '否'}，最新: ${releaseFields.make_latest ?? '未声明'}`)

  // 3) 读取目标发布；dry-run 时再查一次标签状态，正式同步由 ensureTag 统一处理
  let targetRelease
  try {
    targetRelease = await targetClient.getReleaseByTag(sourceTag)
  } catch (error) {
    throw new Error(`读取目标发布失败: ${error.message}`)
  }
  if (
    targetRelease !== null &&
    (typeof targetRelease !== 'object' || Array.isArray(targetRelease))
  ) {
    throw new Error(`目标仓库 ${target.display} 返回的发布数据无效`)
  }

  let targetTag = null
  if (dryRun) {
    try {
      targetTag = await targetClient.getTag(sourceTag)
    } catch (error) {
      throw new Error(`读取目标标签失败: ${error.message}`)
    }
  }

  const sourceAssetsKnown = Array.isArray(sourceRelease.assets)
  const sourceAssets = sourceAssetsKnown ? sourceRelease.assets.filter(isAsset) : []
  const sourceAssetNames = new Set(sourceAssets.map((asset) => asset.name))
  const targetAssetMap = new Map()
  if (targetRelease !== null && Array.isArray(targetRelease.assets)) {
    for (const asset of targetRelease.assets.filter(isAsset)) {
      targetAssetMap.set(asset.name, asset)
    }
  }
  const decisions = sourceAssets.map((asset) => {
    const existing = targetAssetMap.get(asset.name)
    return {
      asset,
      existing,
      skip: existing !== undefined && sameAsset(asset, existing),
    }
  })
  // 源附件列表缺失时不能判断哪些是「目标多余」，宁可不删也不误删
  const extraAssets = sourceAssetsKnown
    ? [...targetAssetMap.values()].filter((asset) => !sourceAssetNames.has(asset.name))
    : []
  if (!sourceAssetsKnown) {
    log('警告: 源发布响应没有附件列表，跳过删除目标多余附件')
  }

  // 4) --dry-run：只输出计划
  if (dryRun) {
    log('目标标签: ' + (targetTag === null ? `将基于 ${targetBranch} 创建` : '已存在'))
    for (const [index, decision] of decisions.entries()) {
      log(
        `附件 ${index + 1}/${decisions.length} ${decision.asset.name}: ` +
          (decision.skip ? '目标已存在且 hash 一致，将跳过' : '待下载并上传'),
      )
    }
    for (const [index, asset] of extraAssets.entries()) {
      log(`多余附件 ${index + 1}/${extraAssets.length} ${asset.name}: 目标有、源没有，将删除`)
    }
    stdout(
      renderSummary({
        source,
        target,
        tag: sourceTag,
        targetBranch,
        dryRun: true,
        releaseAction:
          targetRelease === null
            ? 'create'
            : Object.keys(releaseFields).length > 0 && releaseNeedsUpdate(releaseFields, targetRelease)
              ? 'update'
              : 'unchanged',
        tagExisted: targetTag !== null,
        decisions,
        uploaded: [],
        skipped: [],
        extras: extraAssets,
        deleted: [],
      }),
    )
    return EXIT_OK
  }

  // 5) 确保目标标签存在（不存在时基于目标分支创建）
  let tagResult
  try {
    tagResult = await targetClient.ensureTag(sourceTag, targetBranch)
  } catch (error) {
    throw new Error(
      `创建 / 查询目标标签 "${sourceTag}" 失败: ${error.message}\n` +
        `提示: 目标标签不存在时会基于分支 "${targetBranch}" 创建，请确认该分支存在，或用 ${OPTION_TARGET_BRANCH} 指定别的分支`,
    )
  }
  // ensureTag 返回 created=false 时，以实际查询结果为准：可能本次刚被并发创建
  const tagExisted = tagResult.created !== true
  log(`目标标签: ${sourceTag}（${tagExisted ? '已存在' : `基于 ${targetBranch} 创建`}）`)

  // 6) 创建或更新目标发布
  let releaseAction
  const previousReleaseId = targetRelease === null ? undefined : targetRelease.id
  let previousAssets = targetRelease !== null && Array.isArray(targetRelease.assets) ? targetRelease.assets : []
  if (targetRelease === null) {
    let created
    try {
      created = await targetClient.createRelease({
        tag_name: sourceTag,
        target_commitish: targetBranch,
        ...releaseFields,
      })
    } catch (error) {
      throw new Error(`创建目标发布 "${sourceTag}" 失败: ${error.message}`)
    }
    if (!hasReleaseId(created)) {
      // 有的实现 201 只回空 body；按标签回查一次，避免拿不到 id 无法上传附件
      debug('  创建发布接口未返回可用发布数据，按标签重新读取')
      try {
        created = await targetClient.getReleaseByTag(sourceTag)
      } catch (error) {
        throw new Error(`创建目标发布 "${sourceTag}" 后读取失败: ${error.message}`)
      }
      if (!hasReleaseId(created)) {
        throw new Error(`创建目标发布 "${sourceTag}" 成功，但无法读取目标发布（缺少 id）；请重跑`)
      }
    }
    targetRelease = created
    releaseAction = 'created'
    log(`目标发布: ${target.display}@${sourceTag}（已创建）`)
  } else {
    if (Object.keys(releaseFields).length > 0 && releaseNeedsUpdate(releaseFields, targetRelease)) {
      const previous = targetRelease
      let updated
      try {
        updated = await targetClient.updateRelease(previous.id, releaseFields)
      } catch (error) {
        throw new Error(`更新目标发布 "${sourceTag}" 失败: ${error.message}`)
      }
      // CNB 的 PATCH 可能返回 204 / 空 body；不能把空响应当成发布数据。
      // 能确认是发布对象时以服务端字段为准，否则按本次提交的字段合并旧的发布对象。
      const updatedHasId = hasReleaseId(updated)
      const validUpdated =
        updatedHasId ||
        (isReleaseObject(updated) && typeof updated.tag_name === 'string')
      targetRelease = validUpdated
        ? {
            ...previous,
            ...releaseFields,
            ...updated,
            id: updatedHasId ? updated.id : previous.id,
            assets: Array.isArray(updated.assets) ? updated.assets : previous.assets,
          }
        : { ...previous, ...releaseFields }
      releaseAction = 'updated'
      log(`目标发布: ${target.display}@${sourceTag}（已更新）`)
    } else {
      releaseAction = 'unchanged'
      log(`目标发布: ${target.display}@${sourceTag}（已存在，无字段需要更新）`)
    }
  }
  if (!isReleaseObject(targetRelease)) {
    throw new Error('目标平台返回的发布数据无效')
  }
  const releaseId = targetRelease.id ?? previousReleaseId
  if (releaseId === undefined || releaseId === null || releaseId === '') {
    throw new Error('目标发布缺少 id，无法上传附件')
  }
  debug(`  目标发布 ID: ${releaseId}`)

  // 更新接口偶尔只回部分字段：附件列表缺失时沿用更新前的列表
  if (!Array.isArray(targetRelease.assets)) {
    targetRelease.assets = previousAssets
  }
  previousAssets = []

  // 7) 搬运源附件（SHA 一致跳过 / 不一致覆盖），再删除目标多余附件
  if (decisions.length === 0) {
    log(
      extraAssets.length === 0
        ? '源发布没有附件，跳过附件同步'
        : '源发布没有附件，只清理目标多余附件',
    )
  }

  let tempDir
  const uploaded = []
  const skipped = []
  const deleted = []
  try {
    // 全部附件都已存在且 hash 一致时不需要临时目录
    if (decisions.some((decision) => !decision.skip)) {
      tempDir = await mkdtemp(join(tmpdir(), 'publish-apk-release-'))
    }
    for (const [index, decision] of decisions.entries()) {
      const { asset, skip } = decision
      const label = `附件 ${index + 1}/${decisions.length} ${asset.name}`
      if (skip) {
        skipped.push(asset.name)
        log(`${label}: 目标已存在且 hash 一致，跳过`)
        debug(`  大小: ${formatSize(asset.size)}，hash: ${assetHash(asset)}`)
        continue
      }

      log(`${label}: 下载中（${formatSize(asset.size)}）`)
      const dest = join(tempDir, safeAssetFileName(asset.name, index + 1))
      let downloaded
      try {
        downloaded = await sourceClient.downloadAsset(asset, dest, { tag: sourceTag })
      } catch (error) {
        throw new Error(`下载 ${label} 失败: ${error.message}`)
      }
      debug(
        `  下载完成: ${downloaded.size} 字节` +
          (downloaded.hash === undefined ? '' : `，${downloaded.hashAlgo}=${downloaded.hash}`),
      )

      log(`${label}: 上传中`)
      try {
        await targetClient.uploadAsset(releaseId, asset.name, dest, {
          overwrite: true,
          contentType: asset.content_type,
        })
      } catch (error) {
        throw new Error(`上传 ${label} 失败: ${error.message}`)
      }
      uploaded.push({ name: asset.name, size: downloaded.size })
      log(`${label}: 已上传`)
    }

    // 目标有、源没有的附件：按文件名判断，逐个删除
    for (const [index, asset] of extraAssets.entries()) {
      const label = `多余附件 ${index + 1}/${extraAssets.length} ${asset.name}`
      if (asset.id === undefined || asset.id === null || asset.id === '') {
        throw new Error(`删除 ${label} 失败: 附件缺少 id`)
      }
      log(`${label}: 删除中`)
      try {
        await targetClient.deleteAsset(releaseId, asset.id)
      } catch (error) {
        throw new Error(`删除 ${label} 失败: ${error.message}`)
      }
      deleted.push({ name: asset.name, size: asset.size })
      log(`${label}: 已删除`)
    }
  } catch (error) {
    const processed = uploaded.length + skipped.length
    const notes = []
    if (decisions.length > 0) {
      notes.push(`已处理 ${processed}/${decisions.length} 个源附件`)
    }
    if (deleted.length > 0) {
      notes.push(`已删除 ${deleted.length}/${extraAssets.length} 个多余附件`)
    }
    if (notes.length > 0) {
      error.message +=
        `\n${notes.join('，')}；` +
        '已创建 / 更新的发布与已上传的附件会保留，重跑会按 SHA 跳过或覆盖同名附件，并继续清理多余附件'
    }
    throw error
  } finally {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // 8) 输出结果摘要
  stdout(
    renderSummary({
      source,
      target,
      tag: sourceTag,
      targetBranch,
      dryRun: false,
      releaseAction,
      tagExisted,
      decisions,
      uploaded,
      skipped,
      extras: extraAssets,
      deleted,
    }),
  )
  return EXIT_OK
}

/**
 * release-sync 命令描述，由 publish-apk.js 注册到工具命令表。
 */
export const releaseSyncCommand = {
  name: COMMAND_NAME,
  summary: '同步 Git 平台的发布（发布说明与附件）',
  run: runReleaseSync,
}
