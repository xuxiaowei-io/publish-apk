/**
 * GitLab（gitlab.com / 自建 GitLab）REST API v4：Release 发布同步适配器。
 *
 * GitLab Release 的 assets 只有：
 *   - sources：GitLab 自动生成的源码包；
 *   - links：发布者手工添加的「发布链接」（可指向任意 URL）。
 * GitLab 不支持往 Release 直接上传任意附件，因此目标为 GitLab 时走「下载表格」模式：
 * 不下载、不上传，只把源发布附件的下载地址写入发布说明。
 *
 * 用到的接口：
 *   GET   /projects/{id}/releases/{tag_name}
 *   GET   /projects/{id}/releases
 *   POST  /projects/{id}/releases
 *   PUT   /projects/{id}/releases/{tag_name}
 *   DELETE /projects/{id}/releases/{tag_name}/assets/links/{link_id}
 *   GET   /projects/{id}/repository/tags/{tag_name}
 *   POST  /projects/{id}/repository/tags
 *   GET   /projects/{id}                                  仓库信息（默认分支）
 *
 * 鉴权：PRIVATE-TOKEN: <token>（GitLab 也支持 OAuth Bearer，这里用私人令牌）。
 * id 使用 URL 编码的完整项目路径，支持 group/subgroup/project。
 *
 * 源为 GitLab 时，assets.links 会被当作「可下载链接」参与同步：
 *   - 目标为 GitLab / Gitee：只把链接写进表格，不下载；
 *   - 目标为 CNB / GitHub / GitCode：下载链接再上传为实际附件。
 * 注意 links 可能指向网页而非二进制文件，源链接是否可直接下载由发布者负责。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 适配器标识 */
export const GITLAB_PROVIDER_ID = 'gitlab'
/** 平台名称 */
export const GITLAB_LABEL = 'GitLab'
/** 网页域名 */
export const GITLAB_HOSTS = new Set(['gitlab.com', 'www.gitlab.com'])
/** 默认网页地址前缀 */
export const GITLAB_DEFAULT_HOST = 'gitlab.com'
/** 默认 API 地址 */
export const GITLAB_DEFAULT_API_BASE = 'https://gitlab.com/api/v4'

const USER_AGENT = 'publish-apk'
const ACCEPT = 'application/json'
const REQUEST_TIMEOUT_MS = 30_000
const TRANSFER_TIMEOUT_MS = 10 * 60_000
const MAX_REDIRECTS = 5
const PER_PAGE = 100

const GITLAB_TOKEN_ENVS = {
  source: ['GITLAB_SOURCE_TOKEN', 'GITLAB_TOKEN'],
  target: ['GITLAB_TARGET_TOKEN', 'GITLAB_TOKEN'],
}

const GITLAB_API_BASE_ENVS = {
  source: ['GITLAB_SOURCE_API_BASE', 'GITLAB_API_BASE'],
  target: ['GITLAB_TARGET_API_BASE', 'GITLAB_API_BASE'],
}

/** GitLab API 业务错误 */
export class GitlabApiError extends Error {
  constructor(message, { status, method, path } = {}) {
    super(message)
    this.name = 'GitlabApiError'
    this.status = status
    this.method = method
    this.path = path
  }
}

export function isGitlabNotFound(error) {
  return error instanceof GitlabApiError && error.status === 404
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      return { value: value.trim(), name }
    }
  }
  return undefined
}

/** 解析 GitLab 令牌 */
export function resolveGitlabToken(env, role) {
  const found = firstEnv(env, GITLAB_TOKEN_ENVS[role] ?? GITLAB_TOKEN_ENVS.source)
  if (found === undefined) {
    return undefined
  }
  return { token: found.value, source: found.name }
}

/** 规范化 API 地址 */
export function normalizeGitlabApiBase(value) {
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

/** 解析 API 地址：命令行 > 平台环境变量 > 默认值 */
export function resolveGitlabApiBase(env, role, override) {
  if (override !== undefined) {
    return normalizeGitlabApiBase(override)
  }
  const found = firstEnv(env, GITLAB_API_BASE_ENVS[role] ?? GITLAB_API_BASE_ENVS.source)
  return normalizeGitlabApiBase(found === undefined ? GITLAB_DEFAULT_API_BASE : found.value)
}

function bareUrl(value) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return value
  }
}

function describeNetworkError(method, url, error) {
  const reason =
    error?.name === 'TimeoutError'
      ? '请求超时'
      : error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error)
  return new Error(`${method} ${bareUrl(url)} 失败: ${reason}`)
}

function describeResponseError(response, data, text, method, url) {
  let message = ''
  if (typeof data?.message === 'string') {
    message = data.message
  } else if (data?.message !== undefined) {
    message = JSON.stringify(data.message)
  } else if (typeof data?.error === 'string') {
    message = data.error
  } else {
    message = text.trim().slice(0, 300)
  }
  const suffix = message === '' ? '' : `: ${message}`
  const lines = [`${method} ${bareUrl(url)} 返回 ${response.status}${suffix}`]
  if (response.status === 401) {
    lines.push('提示: GitLab 访问令牌无效或已过期，请检查 GITLAB_TOKEN / GITLAB_SOURCE_TOKEN / GITLAB_TARGET_TOKEN')
  } else if (response.status === 403) {
    lines.push('提示: GitLab 令牌缺少权限（需要 api 或 write_repository 等）')
  } else if (response.status === 404) {
    lines.push('提示: GitLab 项目、Release 或 Tag 不存在，或令牌没有访问权限')
  } else if (response.status === 400) {
    lines.push('提示: GitLab 拒绝请求（常见原因：标签已存在、分支不存在或 Release 参数不合法）')
  } else if (response.status === 429) {
    lines.push('提示: GitLab 请求过于频繁，稍后重试')
  } else if (response.status >= 500) {
    lines.push('提示: GitLab 服务端错误，稍后重试')
  }
  return new GitlabApiError(lines.join('\n'), {
    status: response.status,
    method,
    path: bareUrl(url),
  })
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 把 GitLab release link 转成统一附件形状 */
function normalizeAsset(link, tag, index) {
  if (link === null || typeof link !== 'object' || typeof link.url !== 'string') {
    return null
  }
  return {
    id: link.id ?? `${tag}:link-${index + 1}`,
    name: typeof link.name === 'string' && link.name !== '' ? link.name : `asset-${index + 1}`,
    browser_download_url:
      typeof link.direct_asset_url === 'string' && link.direct_asset_url !== ''
        ? link.direct_asset_url
        : link.url,
    url: link.url,
    link_type: link.link_type,
    release_id: tag,
  }
}

/** 把 GitLab 发布补齐为统一形状；sources 是自动源码包，忽略 */
function normalizeRelease(release, { latestTag } = {}) {
  if (release === null || typeof release !== 'object' || Array.isArray(release)) {
    return release
  }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : undefined
  const links = Array.isArray(release.assets?.links) ? release.assets.links : []
  const assets = links
    .map((link, index) => normalizeAsset(link, tag, index))
    .filter((asset) => asset !== null)
  const normalized = {
    ...release,
    // GitLab 用 description 表示发布说明；编排层统一用 body
    body:
      typeof release.description === 'string'
        ? release.description
        : release.body,
    // GitLab Release 没有数值 id；用 tag 作为同步标识
    id: release.tag_name,
    assets,
  }
  if (latestTag !== undefined && tag !== undefined) {
    normalized.is_latest = latestTag === tag
  }
  return normalized
}

const HASH_ALGOS = new Set(['sha256', 'sha1', 'md5', 'sha512'])

function normalizeHashAlgo(value) {
  const algo = String(value ?? '').trim().toLowerCase().replace(/[-_]/g, '')
  return HASH_ALGOS.has(algo) ? algo : undefined
}

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

/** GitLab REST 客户端 */
class GitlabReleaseClient {
  constructor({
    repo,
    token,
    apiBase = GITLAB_DEFAULT_API_BASE,
    fetchImpl = fetch,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    transferTimeoutMs = TRANSFER_TIMEOUT_MS,
  }) {
    if (typeof repo !== 'string' || repo === '') {
      throw new Error('GitlabReleaseClient 需要项目路径')
    }
    if (typeof token !== 'string' || token === '') {
      throw new Error('GitlabReleaseClient 需要访问令牌')
    }
    const parts = repo.split('/')
    if (parts.length < 2 || parts.some((part) => part === '')) {
      throw new Error(`GitLab 项目路径需要至少 group/project 两段，实际: ${repo}`)
    }
    this.repo = repo
    this.token = token
    this.apiBase = normalizeGitlabApiBase(apiBase)
    this.fetchImpl = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.transferTimeoutMs = transferTimeoutMs
  }

  /** /projects/{urlencoded-path}... */
  apiUrl(suffix, params = {}) {
    const url = new URL(
      `${this.apiBase}/projects/${encodeURIComponent(this.repo)}${suffix}`,
    )
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  headers({ json = false } = {}) {
    const headers = {
      Accept: ACCEPT,
      'PRIVATE-TOKEN': this.token,
      'User-Agent': USER_AGENT,
    }
    if (json) {
      headers['Content-Type'] = 'application/json'
    }
    return headers
  }

  async request(suffix, { method = 'GET', body, params, timeoutMs = this.requestTimeoutMs } = {}) {
    const url = this.apiUrl(suffix, params)
    const init = {
      method,
      headers: this.headers({ json: body !== undefined }),
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }
    let response
    try {
      response = await this.fetchImpl(url, init)
    } catch (error) {
      throw describeNetworkError(method, url, error)
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
      throw describeResponseError(response, data, text, method, url)
    }
    return data
  }

  /** 分页读取列表 */
  async listAll(suffix, params = {}) {
    const items = []
    for (let page = 1; page <= 100; page += 1) {
      const batch = await this.request(suffix, {
        params: { ...params, page, per_page: PER_PAGE },
      })
      if (!Array.isArray(batch) || batch.length === 0) {
        break
      }
      items.push(...batch)
    }
    return items
  }

  /** 最新发布 tag（GitLab 没有 latest 接口，按 released_at 倒序取第一条） */
  async getLatestTagSafe() {
    try {
      const releases = await this.request('/releases', {
        params: { per_page: 1, order_by: 'released_at', sort: 'desc' },
      })
      return Array.isArray(releases) && releases.length > 0
        ? releases[0]?.tag_name
        : undefined
    } catch {
      return undefined
    }
  }

  /** 按 Tag 查发布 */
  async getReleaseByTag(tag) {
    let release
    try {
      release = await this.request(`/releases/${encodeURIComponent(tag)}`)
    } catch (error) {
      if (isGitlabNotFound(error)) {
        return null
      }
      throw error
    }
    const latestTag = await this.getLatestTagSafe()
    return normalizeRelease(release, { latestTag })
  }

  /** 最新发布 */
  async getLatestRelease() {
    const releases = await this.request('/releases', {
      params: { per_page: 1, order_by: 'released_at', sort: 'desc' },
    })
    if (!Array.isArray(releases) || releases.length === 0) {
      return null
    }
    const release = releases[0]
    return normalizeRelease(release, { latestTag: release?.tag_name })
  }

  /** 查询 Tag；不存在返回 null */
  async getTag(tag) {
    try {
      return await this.request(`/repository/tags/${encodeURIComponent(tag)}`)
    } catch (error) {
      if (isGitlabNotFound(error)) {
        return null
      }
      throw error
    }
  }

  /** 目标标签不存在时，基于 branch 创建 */
  async ensureTag(tag, branch) {
    const existing = await this.getTag(tag)
    if (existing !== null) {
      return { created: false, tag: existing }
    }
    try {
      const created = await this.request('/repository/tags', {
        method: 'POST',
        body: { tag_name: tag, ref: branch },
      })
      return { created: true, tag: created }
    } catch (error) {
      if (error instanceof GitlabApiError && [400, 409, 422].includes(error.status)) {
        const raced = await this.getTag(tag)
        if (raced !== null) {
          return { created: false, tag: raced }
        }
      }
      throw error
    }
  }

  /** 项目默认分支 */
  async getDefaultBranch() {
    const project = await this.request('')
    return typeof project?.default_branch === 'string' ? project.default_branch : undefined
  }

  /** 创建发布 */
  async createRelease(fields) {
    const payload = {
      name: typeof fields.name === 'string' && fields.name !== '' ? fields.name : fields.tag_name,
      tag_name: fields.tag_name,
      description: typeof fields.body === 'string' ? fields.body : '',
    }
    if (typeof fields.target_commitish === 'string' && fields.target_commitish !== '') {
      payload.ref = fields.target_commitish
    }
    let release = await this.request('/releases', { method: 'POST', body: payload })
    if (release === null || typeof release !== 'object' || release.tag_name === undefined) {
      release = await this.getReleaseByTag(fields.tag_name)
    }
    if (release === null || typeof release !== 'object') {
      throw new Error(`创建 GitLab 发布 "${fields.tag_name}" 成功，但无法读取目标发布；请重跑`)
    }
    const latestTag = await this.getLatestTagSafe()
    return normalizeRelease(release, { latestTag })
  }

  /** 更新发布；GitLab 按 tag PATCH/PUT，name / description 必填 */
  async updateRelease(releaseId, fields, { tag } = {}) {
    const releaseTag = tag ?? releaseId
    const current = await this.request(`/releases/${encodeURIComponent(String(releaseTag))}`)
    if (current === null || typeof current !== 'object') {
      throw new Error('读取 GitLab 发布失败：响应数据无效')
    }
    const payload = {
      name: typeof fields.name === 'string' ? fields.name : current.name,
      description: typeof fields.body === 'string' ? fields.body : current.description,
    }
    let updated = await this.request(
      `/releases/${encodeURIComponent(String(releaseTag))}`,
      { method: 'PUT', body: payload },
    )
    if (updated === null || typeof updated !== 'object') {
      updated = { ...current, ...payload }
    }
    const merged = { ...current, ...payload, ...updated }
    const latestTag = await this.getLatestTagSafe()
    return normalizeRelease(merged, { latestTag })
  }

  /** 删除目标 Release 的附件链接（表格模式清理多余链接） */
  async deleteAsset(releaseId, assetId, { tag } = {}) {
    const releaseTag = tag ?? releaseId
    try {
      return await this.request(
        `/releases/${encodeURIComponent(String(releaseTag))}/assets/links/${encodeURIComponent(String(assetId))}`,
        { method: 'DELETE' },
      )
    } catch (error) {
      if (isGitlabNotFound(error)) {
        return { alreadyDeleted: true }
      }
      throw error
    }
  }

  /** 下载 GitLab Release link 指向的地址 */
  async downloadAsset(asset, destPath) {
    const url = asset?.browser_download_url ?? asset?.url
    if (typeof url !== 'string' || url === '') {
      throw new Error(`下载附件 ${asset?.name ?? ''} 失败: 缺少链接地址`)
    }
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`下载附件 ${asset.name} 失败: 链接地址无效`)
    }
    // 仅当链接与 GitLab 同源时才带私人令牌，避免把令牌发给外部站点
    const apiHost = new URL(this.apiBase).hostname
    const sendToken = parsed.hostname === apiHost
    const headers = { Accept: '*/*', 'User-Agent': USER_AGENT }
    if (sendToken) {
      headers['PRIVATE-TOKEN'] = this.token
    }
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
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

  /** GitLab Release 不支持直接上传附件，目标为 GitLab 时编排层走表格模式 */
  async uploadAsset() {
    throw new Error('GitLab Release 不支持直接上传附件；请使用下载表格模式')
  }
}

/** GitLab 平台适配器 */
export const gitlabReleaseProvider = {
  id: GITLAB_PROVIDER_ID,
  label: GITLAB_LABEL,
  hosts: GITLAB_HOSTS,
  defaultHost: GITLAB_DEFAULT_HOST,
  tokenEnvs: GITLAB_TOKEN_ENVS,
  apiBaseEnvs: GITLAB_API_BASE_ENVS,
  // GitLab Release 只有 links/sources，不能上传任意文件；直接生成下载表格
  assetUploadDirectToTable: true,
  // Release Links 可能是文档等非产物链接，保留目标现有链接，不做“多余附件删除”
  preserveTargetAssets: true,
  supportsDraft: false,
  supportsPrerelease: false,
  supportsMakeLatest: false,
  resolveToken: resolveGitlabToken,
  resolveApiBase: resolveGitlabApiBase,
  createClient(options) {
    return new GitlabReleaseClient(options)
  },
}

export { GitlabReleaseClient }
