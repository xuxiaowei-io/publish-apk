/**
 * CNB（cnb.cool）Open API：Release 发布同步所需的接口封装。
 *
 * 本模块只认识 CNB，不认识「同步」这件事：release-sync.js 负责选发布、建标签、
 * 搬运附件等编排，本模块负责拼请求、鉴权、解析错误与流式传输文件。
 * 以后新增 Gitee / GitHub 时照本模块的形状另写一个适配器即可，见 release-sync.js 头部说明。
 *
 * 用到的接口（均来自 CNB Open API，服务地址 https://api.cnb.cool）：
 *   GET   /{repo}/-/releases/tags/{tag}                 按标签查发布
 *   GET   /{repo}/-/releases/latest                     最新发布
 *   GET   /{repo}/-/git/tags/{tag}                      按名字查标签
 *   POST  /{repo}/-/git/tags                            创建标签（target 可为分支名 / 提交 / 标签）
 *   POST  /{repo}/-/releases                            创建发布
 *   PATCH /{repo}/-/releases/{release_id}               更新发布
 *   GET   /{repo}/-/releases/download/{tag}/{filename}  下载附件（302 到有时效的地址）
 *   POST  /{repo}/-/releases/{release_id}/asset-upload-url
 *                                                      取附件预签名上传地址
 *   DELETE /{repo}/-/releases/{release_id}/assets/{asset_id}
 *                                                      删除附件（清理目标多余附件）
 *   PUT   <asset-upload-url 返回的 upload_url>           上传文件（预签名地址，不带令牌）
 *   POST  <asset-upload-url 返回的 verify_url>           确认附件上传
 *
 * 鉴权：Authorization: Bearer <访问令牌>，Accept: application/vnd.cnb.api+json。
 * 令牌只放进请求头，不写进 URL、日志或错误信息。
 *
 * 传输：附件先下载到调用方给的本地路径（流式写盘，可选校验 hash），
 * 再从该路径流式 PUT 到预签名地址，避免把 APK / AAB 整个读进内存。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 适配器标识，release-sync.js 的 provider 表用它区分平台 */
export const CNB_PROVIDER_ID = 'cnb'
/** 帮助文档与错误信息里的平台名称 */
export const CNB_LABEL = 'CNB'
/** 没写 host 时默认的平台与仓库地址前缀 */
export const CNB_DEFAULT_HOST = 'cnb.cool'
/** 认可的 CNB 网页域名（www 与裸域名等价） */
export const CNB_HOSTS = new Set(['cnb.cool', 'www.cnb.cool'])
/** API 服务地址；本地联调或企业代理用 CNB_API_BASE 覆盖 */
export const CNB_DEFAULT_API_BASE = 'https://api.cnb.cool'

const API_ACCEPT = 'application/vnd.cnb.api+json'
const USER_AGENT = 'publish-apk'
/** 普通 API 请求超时（30 秒）：不包含大文件传输 */
const REQUEST_TIMEOUT_MS = 30_000
/** 附件下载 / 上传超时（10 分钟）：大文件在慢网络下也够用 */
const TRANSFER_TIMEOUT_MS = 10 * 60_000
/** 下载时最多跟随的重定向次数（防止预签名地址异常时无限跳转） */
const MAX_REDIRECTS = 5
/** 权限提示用的固定文案，避免每个错误分支重复写 */
const RELEASE_READ_PERMISSION = 'repo-release:r'
const RELEASE_WRITE_PERMISSION = 'repo-release:rw'

/**
 * CNB API 返回的业务错误。
 *
 * 只带状态码、errcode、请求方法与路径：令牌永远不进错误信息。
 */
export class CnbApiError extends Error {
  constructor(message, { status, errcode, method, path } = {}) {
    super(message)
    this.name = 'CnbApiError'
    this.status = status
    this.errcode = errcode
    this.method = method
    this.path = path
  }
}

/** 404 在查标签 / 查发布时是「还没有」的正常结果，调用方据此决定创建 */
export function isCnbNotFound(error) {
  return error instanceof CnbApiError && error.status === 404
}

/** 从环境变量里取第一个非空值；空串按未设置处理 */
function firstEnv(env, names) {
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      return { value: value.trim(), name }
    }
  }
  return undefined
}

/**
 * 解析 CNB 访问令牌：--source-token / --target-token 由调用方优先处理，
 * 这里只负责平台自己的环境变量兜底（源和目标都允许共用 CNB_TOKEN）。
 */
const CNB_TOKEN_ENVS = {
  source: ['CNB_SOURCE_TOKEN', 'CNB_TOKEN'],
  target: ['CNB_TARGET_TOKEN', 'CNB_TOKEN'],
}

const CNB_API_BASE_ENVS = {
  source: ['CNB_SOURCE_API_BASE', 'CNB_API_BASE'],
  target: ['CNB_TARGET_API_BASE', 'CNB_API_BASE'],
}

export function resolveCnbToken(env, role) {
  const found = firstEnv(env, CNB_TOKEN_ENVS[role] ?? CNB_TOKEN_ENVS.source)
  if (found === undefined) {
    return undefined
  }
  return { token: found.value, source: found.name }
}

/**
 * 规范化 API 地址：只接受 http(s)，不允许内嵌用户名 / 口令、查询串或锚点，
 * 末尾斜杠统一去掉（拼接路径时不会再出现双斜杠）。
 */
export function normalizeCnbApiBase(value) {
  const text = String(value).trim()
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`API 地址无效: ${text}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`API 地址必须是 http(s): ${text}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('API 地址不能包含用户名或口令，请把令牌放到 --source-token / --target-token')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`API 地址不能带查询串或锚点: ${text}`)
  }
  return url.toString().replace(/\/+$/, '')
}

/**
 * 解析 CNB API 地址：命令行 > 平台环境变量 > 默认值。
 * 源与目标各有一套变量，CNB_API_BASE 对两者都生效。
 */
export function resolveCnbApiBase(env, role, override) {
  if (override !== undefined) {
    return normalizeCnbApiBase(override)
  }
  const found = firstEnv(env, CNB_API_BASE_ENVS[role] ?? CNB_API_BASE_ENVS.source)
  return normalizeCnbApiBase(found === undefined ? CNB_DEFAULT_API_BASE : found.value)
}

/** 仓库路径按段编码：org/repo 里的斜杠保留，段内字符（空格、# 等）编码 */
function encodeRepoPath(repo) {
  return repo
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** 去掉 URL 的查询串，错误信息里不暴露预签名参数 */
function bareUrl(value) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return value
  }
}

/** 网络层错误统一成「方法 + 地址 + 原因」，超时单独说清楚 */
function describeNetworkError(method, url, error) {
  const reason =
    error?.name === 'TimeoutError'
      ? '请求超时'
      : error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error)
  return new Error(`${method} ${bareUrl(url)} 失败: ${reason}`)
}

/** 把错误响应整理成可读文本；响应体是 HTML 时只截一小段，避免刷屏 */
function describeResponseError(response, data, text, method, url) {
  const errmsg =
    typeof data?.errmsg === 'string'
      ? data.errmsg
      : typeof data?.message === 'string'
        ? data.message
        : text.trim().slice(0, 300)
  const errcode = data?.errcode
  const suffix = errmsg === '' ? '' : `: ${errmsg}`
  const detail = errcode === undefined ? '' : `（errcode=${errcode}）`
  const lines = [`${method} ${bareUrl(url)} 返回 ${response.status}${detail}${suffix}`]
  if (response.status === 401) {
    lines.push('提示: 访问令牌无效或已过期，请检查 --source-token / --target-token（或 CNB_TOKEN）')
  } else if (response.status === 403) {
    lines.push(
      `提示: 令牌缺少权限；读取源发布需要 ${RELEASE_READ_PERMISSION}，创建标签 / 发布与上传附件需要 ${RELEASE_WRITE_PERMISSION}`,
    )
  } else if (response.status === 404) {
    lines.push('提示: 仓库、标签或发布不存在，或令牌没有访问权限')
  } else if (response.status === 429) {
    lines.push('提示: 请求过于频繁，稍后重试')
  } else if (response.status >= 500) {
    lines.push('提示: CNB 服务端错误，稍后重试')
  }
  return new CnbApiError(lines.join('\n'), {
    status: response.status,
    errcode,
    method,
    path: bareUrl(url),
  })
}

/** 判断响应是否是重定向 */
function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** hash 算法名归一化；认不出时返回 undefined（不校验，但也不误报） */
function normalizeHashAlgo(value) {
  if (typeof value !== 'string') {
    return undefined
  }
  const algo = value.trim().toLowerCase().replace(/[-_]/g, '')
  if (algo === 'sha256' || algo === 'sha1' || algo === 'md5' || algo === 'sha512') {
    return algo
  }
  return undefined
}

/**
 * 校验下载内容的 hash。
 *
 * CNB 的 hash_value 可能是十六进制、base64，或带 `sha256:` 前缀；这里三种都认，
 * 认不出就返回 false，由调用方报「hash 不一致」而不是静默放过。
 */
function hashMatches(buffer, expected) {
  let text = String(expected).trim()
  const colon = text.indexOf(':')
  if (colon !== -1) {
    text = text.slice(colon + 1).trim()
  }
  const hex = buffer.toString('hex').toLowerCase()
  const base64 = buffer.toString('base64')
  const normalized = text.toLowerCase()
  if (/^[0-9a-f]+$/.test(normalized) && normalized.length === hex.length) {
    return normalized === hex
  }
  return text === base64
}

/** 附件下载 / 上传走的时间上限；调用方可覆盖（测试用短超时） */
class CnbReleaseClient {
  constructor({
    repo,
    token,
    apiBase = CNB_DEFAULT_API_BASE,
    fetchImpl = fetch,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    transferTimeoutMs = TRANSFER_TIMEOUT_MS,
  }) {
    if (typeof repo !== 'string' || repo === '') {
      throw new Error('CnbReleaseClient 需要仓库路径')
    }
    if (typeof token !== 'string' || token === '') {
      throw new Error('CnbReleaseClient 需要访问令牌')
    }
    this.repo = repo
    this.token = token
    this.apiBase = normalizeCnbApiBase(apiBase)
    this.fetchImpl = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.transferTimeoutMs = transferTimeoutMs
  }

  /** 仓库内 API 路径：/{repo}/-/... */
  apiUrl(suffix) {
    return `${this.apiBase}/${encodeRepoPath(this.repo)}/-/${suffix}`
  }

  /** 带 Bearer 的 JSON 请求 */
  async request(suffix, { method = 'GET', body, timeoutMs = this.requestTimeoutMs } = {}) {
    return this.fetchJson(this.apiUrl(suffix), { method, body, timeoutMs })
  }

  /** 带 Bearer 的 JSON 请求（可传绝对地址，用于 verify_url） */
  async fetchJson(url, { method = 'GET', body, timeoutMs = this.requestTimeoutMs, displayUrl } = {}) {
    const shown = displayUrl ?? url
    const headers = {
      Accept: API_ACCEPT,
      Authorization: `Bearer ${this.token}`,
      'User-Agent': USER_AGENT,
    }
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let response
    try {
      response = await this.fetchImpl(url, init)
    } catch (error) {
      throw describeNetworkError(method, shown, error)
    }
    const text = await response.text()
    let data
    if (text !== '') {
      try {
        data = JSON.parse(text)
      } catch {
        data = undefined
      }
    }
    if (!response.ok) {
      throw describeResponseError(response, data, text, method, shown)
    }
    return data
  }

  /**
   * 分页读取一个列表接口的全部条目。
   *
   * 标签名允许包含 `/`，按名字查标签 / 发布时路径里的 `%2F` 可能被网关拒绝，
   * 此时回退到列表接口按字段匹配。列表接口默认每页 10 条，这里显式要 100 条；
   * 一直翻到空页为止，不依赖服务端是否真的接受 page_size。
   */
  async listAll(suffix, pageSize = 100) {
    const items = []
    for (let page = 1; page <= 100; page += 1) {
      const batch = await this.request(`${suffix}?page=${page}&page_size=${pageSize}`)
      if (!Array.isArray(batch) || batch.length === 0) {
        break
      }
      items.push(...batch)
    }
    return items
  }

  /** 按标签查发布；标签带 `/` 且 404 时回退到发布列表（兼容 `%2F` 被网关拒绝） */
  async getReleaseByTag(tag) {
    try {
      return await this.request(`releases/tags/${encodeURIComponent(tag)}`)
    } catch (error) {
      if (!isCnbNotFound(error)) {
        throw error
      }
      if (!tag.includes('/')) {
        return null
      }
      const releases = await this.listAll('releases')
      return releases.find((release) => release?.tag_name === tag) ?? null
    }
  }

  /** 最新发布；仓库没有发布时返回 null */
  async getLatestRelease() {
    try {
      return await this.request('releases/latest')
    } catch (error) {
      if (isCnbNotFound(error)) {
        return null
      }
      throw error
    }
  }

  /** 按名字查标签；标签带 `/` 且 404 时回退到标签列表（兼容 `%2F`） */
  async getTag(tag) {
    try {
      return await this.request(`git/tags/${encodeURIComponent(tag)}`)
    } catch (error) {
      if (!isCnbNotFound(error)) {
        throw error
      }
      if (!tag.includes('/')) {
        return null
      }
      const tags = await this.listAll('git/tags')
      return tags.find((item) => item?.name === tag) ?? null
    }
  }

  /**
   * 确保标签存在：不存在则基于 branch 创建（轻量标签）。
   * 已存在时不移动标签，返回 created=false；并发创建撞车时重新查询一次。
   */
  async ensureTag(tag, branch) {
    const existing = await this.getTag(tag)
    if (existing !== null) {
      return { created: false, tag: existing }
    }
    try {
      const created = await this.request('git/tags', {
        method: 'POST',
        body: { name: tag, target: branch },
      })
      return { created: true, tag: created }
    } catch (error) {
      // 并发运行或上一次执行已创建：重新查询，确认存在就按「已存在」处理
      if (
        error instanceof CnbApiError &&
        (error.status === 409 || error.status === 400 || error.status === 422 || /exist|已存在|重复/i.test(error.message))
      ) {
        const raced = await this.getTag(tag)
        if (raced !== null) {
          return { created: false, tag: raced }
        }
      }
      throw error
    }
  }

  /** 创建发布；字段由 release-sync.js 决定（tag_name、target_commitish、name、body 等） */
  async createRelease(fields) {
    return this.request('releases', { method: 'POST', body: fields })
  }

  /** 更新发布；只传需要改的字段 */
  async updateRelease(releaseId, fields) {
    return this.request(`releases/${encodeURIComponent(String(releaseId))}`, {
      method: 'PATCH',
      body: fields,
    })
  }

  /**
   * 删除目标发布上的一个附件。
   *
   * 同步时源发布没有、目标却存在的附件需要清掉；CNB 的 DELETE 可能返回 200 空 body
   * 或 204，fetchJson 对空 body 返回 undefined，调用方不需要返回值。
   */
  async deleteAsset(releaseId, assetId) {
    try {
      return await this.request(
        `releases/${encodeURIComponent(String(releaseId))}/assets/${encodeURIComponent(String(assetId))}`,
        { method: 'DELETE' },
      )
    } catch (error) {
      // 并发重跑时附件可能已被删掉；404 视为「已经不存在」，保证删除是幂等的
      if (isCnbNotFound(error)) {
        return { alreadyDeleted: true }
      }
      throw error
    }
  }

  /** 附件下载地址：优先用 API 返回的 url，缺失时按标签 + 文件名拼 */
  assetDownloadUrl(asset, tag) {
    const raw =
      typeof asset?.url === 'string' && asset.url !== ''
        ? asset.url
        : this.apiUrl(
            `releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`,
          )
    try {
      // url 可能是相对路径；统一补成绝对地址，fetch 需要
      return new URL(raw, `${this.apiBase}/`).toString()
    } catch {
      return raw
    }
  }

  /**
   * 下载附件到 destPath，流式写盘并校验大小 / hash。
   *
   * 下载接口会 302 到有时效的对象存储地址：第一跳带令牌，后续跳转不带令牌，
   * 避免把 CNB 访问令牌发给对象存储。
   *
   * @returns {Promise<{ size: number, hashAlgo?: string, hash?: string }>}
   */
  async downloadAsset(asset, destPath, { tag } = {}) {
    const url = this.assetDownloadUrl(asset, tag)
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: API_ACCEPT,
          Authorization: `Bearer ${this.token}`,
          'User-Agent': USER_AGENT,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.transferTimeoutMs),
      })
    } catch (error) {
      throw describeNetworkError('GET', url, error)
    }

    let redirects = 0
    while (isRedirect(response.status)) {
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`下载附件 ${asset.name} 失败: 重定向次数超过 ${MAX_REDIRECTS} 次`)
      }
      redirects += 1
      const location = response.headers.get('location')
      if (typeof location !== 'string' || location === '') {
        throw new Error(`下载附件 ${asset.name} 失败: 重定向响应缺少 Location`)
      }
      const next = new URL(location, url).toString()
      await response.body?.cancel()
      try {
        // 预签名地址自带鉴权参数，不能再带 CNB 的 Authorization
        response = await this.fetchImpl(next, {
          method: 'GET',
          signal: AbortSignal.timeout(this.transferTimeoutMs),
        })
      } catch (error) {
        throw describeNetworkError('GET', next, error)
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `下载附件 ${asset.name} 失败: HTTP ${response.status}${text === '' ? '' : `: ${text.trim().slice(0, 300)}`}`,
      )
    }
    if (response.body === null) {
      throw new Error(`下载附件 ${asset.name} 失败: 响应没有内容`)
    }

    const hashAlgo = normalizeHashAlgo(asset.hash_algo)
    const expectedHash =
      typeof asset.hash_value === 'string' && asset.hash_value !== '' ? asset.hash_value : undefined
    const hasher = hashAlgo !== undefined && expectedHash !== undefined ? createHash(hashAlgo) : undefined
    const tap = new Transform({
      transform(chunk, encoding, callback) {
        if (hasher !== undefined) {
          hasher.update(chunk)
        }
        callback(null, chunk)
      },
    })

    try {
      await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(destPath))
    } catch (error) {
      throw new Error(`下载附件 ${asset.name} 写入本地文件失败: ${error.message}`)
    }

    const { size } = await stat(destPath)
    const expectedSize = Number(asset.size)
    if (Number.isFinite(expectedSize) && expectedSize >= 0 && expectedSize !== size) {
      throw new Error(
        `附件 ${asset.name} 大小不一致: 接口声明 ${expectedSize} 字节，实际下载 ${size} 字节`,
      )
    }
    if (hasher !== undefined) {
      const digest = hasher.digest()
      if (!hashMatches(digest, expectedHash)) {
        throw new Error(
          `附件 ${asset.name} 的 ${hashAlgo} 校验失败: 接口声明 ${expectedHash}，实际 ${digest.toString('hex')}`,
        )
      }
      return { size, hashAlgo, hash: digest.toString('hex') }
    }
    return { size }
  }

  /**
   * 上传附件：取预签名地址 → PUT 文件 → 调确认接口。
   * 同名附件用 overwrite 覆盖，保证重复执行仍得到源附件的内容。
   */
  async uploadAsset(releaseId, assetName, filePath, { overwrite = true, contentType } = {}) {
    const { size } = await stat(filePath)
    const options = await this.request(
      `releases/${encodeURIComponent(String(releaseId))}/asset-upload-url`,
      {
        method: 'POST',
        body: { asset_name: assetName, size, overwrite },
      },
    )
    const uploadUrl = options?.upload_url
    const verifyUrl = options?.verify_url
    if (typeof uploadUrl !== 'string' || uploadUrl === '') {
      throw new Error(`上传附件 ${assetName} 失败: CNB 未返回 upload_url`)
    }
    if (typeof verifyUrl !== 'string' || verifyUrl === '') {
      throw new Error(`上传附件 ${assetName} 失败: CNB 未返回 verify_url`)
    }
    let absoluteUploadUrl
    try {
      absoluteUploadUrl = new URL(uploadUrl, `${this.apiBase}/`).toString()
    } catch {
      throw new Error(`上传附件 ${assetName} 失败: upload_url 无效`)
    }

    await this.putFile(absoluteUploadUrl, filePath, size, assetName, contentType)
    await this.confirmAsset(verifyUrl, assetName)
    return { size }
  }

  /** PUT 文件到预签名地址；不带 CNB 令牌，文件名与大小来自本地文件 */
  async putFile(url, filePath, size, assetName, contentType) {
    let response
    try {
      const init = {
        method: 'PUT',
        headers: {
          'Content-Type':
            typeof contentType === 'string' && contentType !== ''
              ? contentType
              : 'application/octet-stream',
          'Content-Length': String(size),
        },
        signal: AbortSignal.timeout(this.transferTimeoutMs),
      }
      if (size === 0) {
        // 空文件用空 Buffer，避免部分 fetch 实现对「空流 + Content-Length: 0」处理不一致
        init.body = Buffer.alloc(0)
      } else {
        init.body = Readable.toWeb(createReadStream(filePath))
        init.duplex = 'half'
      }
      response = await this.fetchImpl(url, init)
    } catch (error) {
      throw describeNetworkError('PUT', '<upload_url>', error)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `上传附件 ${assetName} 失败: HTTP ${response.status}${text === '' ? '' : `: ${text.trim().slice(0, 300)}`}`,
      )
    }
  }

  /** 确认附件上传完成；verify_url 可能是绝对地址，也可能是相对 API 根路径 */
  async confirmAsset(verifyUrl, assetName) {
    let url
    try {
      url = new URL(verifyUrl, `${this.apiBase}/`).toString()
    } catch {
      throw new Error(`确认附件 ${assetName} 失败: verify_url 无效`)
    }
    try {
      // verify_url 的路径里带 upload_token，错误信息不打印原地址
      await this.fetchJson(url, { method: 'POST', displayUrl: '<verify_url>' })
    } catch (error) {
      throw new Error(`确认附件 ${assetName} 失败: ${error.message}`)
    }
  }
}

/**
 * CNB 平台适配器：release-sync.js 只依赖下面的形状。
 *
 * hosts 用于从仓库地址里认平台；defaultHost 是省略 host 时的默认平台；
 * createClient 返回的对象实现 getReleaseByTag / getLatestRelease / getTag /
 * ensureTag / createRelease / updateRelease / downloadAsset / uploadAsset / deleteAsset。
 */
export const cnbReleaseProvider = {
  id: CNB_PROVIDER_ID,
  label: CNB_LABEL,
  hosts: CNB_HOSTS,
  defaultHost: CNB_DEFAULT_HOST,
  tokenEnvs: CNB_TOKEN_ENVS,
  apiBaseEnvs: CNB_API_BASE_ENVS,
  resolveToken: resolveCnbToken,
  resolveApiBase: resolveCnbApiBase,
  createClient(options) {
    return new CnbReleaseClient(options)
  },
}

/** 导出给测试直接用：不经过 provider 也能构造客户端 */
export { CnbReleaseClient }
