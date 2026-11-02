/**
 * GitLink（gitlink.org.cn）API 适配器。
 *
 * GitLink 的接口与 Gitee / GitHub 不同：
 *   - API 前缀是 https://www.gitlink.org.cn/api；
 *   - 列表接口是 /{owner}/{repo}/releases.json，返回 { status, releases, total_count }；
 *   - Release 详情是 /{owner}/{repo}/releases/{version_id}.json；
 *   - 发布用 PUT /{owner}/{repo}/releases/{version_id}.json；
 *   - 附件在 release.attachments 中，上传接口为 POST /attachments.json（multipart）；
 *   - 标签列表是 /v1/{owner}/{repo}/tags.json。
 *
 * 附件上传：POST /attachments.json（multipart file）拿到附件 id，再用 Release 的
 * attachment_ids 关联发布。GitLink 的 attachment_ids 更新是追加语义，所以同名旧附件
 * 会先通过 DELETE /attachments/{id} 删除，再上传新文件。目标为 GitLink 时正常上传。
 * 源为 GitLink 时读取 attachments，附件可下载时再上传到 CNB / GitHub / GitCode。
 *
 * 鉴权：Authorization: Bearer <token>。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 适配器标识 */
export const GITLINK_PROVIDER_ID = 'gitlink'
/** 平台名称 */
export const GITLINK_LABEL = 'GitLink'
/** 网页域名 */
export const GITLINK_HOSTS = new Set(['gitlink.org.cn', 'www.gitlink.org.cn'])
/** 默认网页地址前缀 */
export const GITLINK_DEFAULT_HOST = 'gitlink.org.cn'
/** 默认 API 地址 */
export const GITLINK_DEFAULT_API_BASE = 'https://www.gitlink.org.cn/api'

const USER_AGENT = 'publish-apk'
const ACCEPT = 'application/json'
const REQUEST_TIMEOUT_MS = 30_000
const TRANSFER_TIMEOUT_MS = 10 * 60_000
const MAX_REDIRECTS = 5
const PER_PAGE = 20

const GITLINK_TOKEN_ENVS = {
  source: ['GITLINK_SOURCE_TOKEN', 'GITLINK_TOKEN'],
  target: ['GITLINK_TARGET_TOKEN', 'GITLINK_TOKEN'],
}

const GITLINK_API_BASE_ENVS = {
  source: ['GITLINK_SOURCE_API_BASE', 'GITLINK_API_BASE'],
  target: ['GITLINK_TARGET_API_BASE', 'GITLINK_API_BASE'],
}

/** GitLink API 业务错误 */
export class GitlinkApiError extends Error {
  constructor(message, { status, method, path } = {}) {
    super(message)
    this.name = 'GitlinkApiError'
    this.status = status
    this.method = method
    this.path = path
  }
}

export function isGitlinkNotFound(error) {
  return error instanceof GitlinkApiError && error.status === 404
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

/** 解析 GitLink 令牌 */
export function resolveGitlinkToken(env, role) {
  const found = firstEnv(env, GITLINK_TOKEN_ENVS[role] ?? GITLINK_TOKEN_ENVS.source)
  if (found === undefined) {
    return undefined
  }
  return { token: found.value, source: found.name }
}

/** 规范化 API 地址 */
export function normalizeGitlinkApiBase(value) {
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
export function resolveGitlinkApiBase(env, role, override) {
  if (override !== undefined) {
    return normalizeGitlinkApiBase(override)
  }
  const found = firstEnv(env, GITLINK_API_BASE_ENVS[role] ?? GITLINK_API_BASE_ENVS.source)
  return normalizeGitlinkApiBase(found === undefined ? GITLINK_DEFAULT_API_BASE : found.value)
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
  const message =
    typeof data?.message === 'string' ? data.message : text.trim().slice(0, 300)
  const suffix = message === '' ? '' : `: ${message}`
  const lines = [`${method} ${bareUrl(url)} 返回 ${response.status}${suffix}`]
  if (response.status === 401) {
    lines.push('提示: GitLink 访问令牌无效或已过期，请检查 GITLINK_TOKEN / GITLINK_SOURCE_TOKEN / GITLINK_TARGET_TOKEN')
  } else if (response.status === 403) {
    lines.push('提示: GitLink 令牌缺少权限')
  } else if (response.status === 404) {
    lines.push('提示: GitLink 项目、Release 或 Tag 不存在，或令牌没有访问权限')
  } else if (response.status === 400) {
    lines.push('提示: GitLink 拒绝请求（常见原因：标签无效、目标分支不存在或参数不合法）')
  } else if (response.status === 429) {
    lines.push('提示: GitLink 请求过于频繁，稍后重试')
  } else if (response.status >= 500) {
    lines.push('提示: GitLink 服务端错误，稍后重试')
  }
  return new GitlinkApiError(lines.join('\n'), {
    status: response.status,
    method,
    path: bareUrl(url),
  })
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 把 "4.9 MB" 之类的 GitLink filesize 解析成字节数 */
function parseFileSize(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?i?b)\s*$/i.exec(value)
  if (match === null) {
    return undefined
  }
  const amount = Number(match[1])
  const unit = match[2].toUpperCase()
  const factors = {
    B: 1,
    KB: 1000,
    KIB: 1024,
    MB: 1000 ** 2,
    MIB: 1024 ** 2,
    GB: 1000 ** 3,
    GIB: 1024 ** 3,
    TB: 1000 ** 4,
    TIB: 1024 ** 4,
  }
  const factor = factors[unit]
  return factor === undefined || !Number.isFinite(amount) ? undefined : Math.round(amount * factor)
}

function absoluteAssetUrl(value, apiBase) {
  if (typeof value !== 'string' || value === '') {
    return undefined
  }
  if (/^https?:\/\//i.test(value)) {
    return value
  }
  try {
    return new URL(value, apiBase).toString()
  } catch {
    return value
  }
}

/** GitLink 的 draft 是状态文本：稳定 / 草稿 / 预发布 */
function draftFlags(release) {
  const status = typeof release?.draft === 'string' ? release.draft : ''
  if (status === '草稿') {
    return { draft: true, prerelease: false }
  }
  if (status === '预发布') {
    return { draft: false, prerelease: true }
  }
  return { draft: false, prerelease: false }
}

/** 把 GitLink attachment 转成统一附件形状 */
function normalizeAttachment(attachment, tag, apiBase) {
  if (attachment === null || typeof attachment !== 'object') {
    return null
  }
  const id = attachment.id
  if (id === undefined || id === null) {
    return null
  }
  const name =
    typeof attachment.title === 'string' && attachment.title !== ''
      ? attachment.title
      : `asset-${id}`
  return {
    id,
    name,
    size: parseFileSize(attachment.filesize),
    // GitLink 的 filesize 是 "4.9 MB" 这种展示值，不参与精确大小校验
    size_approx: true,
    content_type:
      typeof attachment.content_type === 'string' ? attachment.content_type : undefined,
    browser_download_url: absoluteAssetUrl(attachment.url, apiBase),
    release_id: tag,
  }
}

/** 把 GitLink Release 补齐为统一形状 */
function normalizeRelease(release, { latestTag, apiBase } = {}) {
  if (release === null || typeof release !== 'object' || Array.isArray(release)) {
    return null
  }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : undefined
  const attachments = Array.isArray(release.attachments) ? release.attachments : []
  const assets = attachments
    .map((attachment) => normalizeAttachment(attachment, tag, apiBase))
    .filter((asset) => asset !== null)
  const flags = draftFlags(release)
  const normalized = {
    ...release,
    id: release.version_id ?? release.id ?? tag,
    body: typeof release.body === 'string' ? release.body : '',
    draft: flags.draft,
    prerelease: flags.prerelease,
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

/** GitLink API 客户端 */
class GitlinkReleaseClient {
  constructor({
    repo,
    token,
    apiBase = GITLINK_DEFAULT_API_BASE,
    fetchImpl = fetch,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    transferTimeoutMs = TRANSFER_TIMEOUT_MS,
  }) {
    if (typeof repo !== 'string' || repo === '') {
      throw new Error('GitlinkReleaseClient 需要仓库路径')
    }
    if (typeof token !== 'string' || token === '') {
      throw new Error('GitlinkReleaseClient 需要访问令牌')
    }
    const parts = repo.split('/')
    if (parts.length < 2 || parts.some((part) => part === '')) {
      throw new Error(`GitLink 仓库地址需要 owner/repo，实际: ${repo}`)
    }
    this.repo = repo
    this.token = token
    this.apiBase = normalizeGitlinkApiBase(apiBase)
    this.fetchImpl = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.transferTimeoutMs = transferTimeoutMs
  }

  /** /{owner}/{repo}... */
  apiUrl(suffix, params = {}) {
    const [owner, repo] = this.repo.split('/')
    const url = new URL(`${this.apiBase}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`)
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
      Authorization: `Bearer ${this.token}`,
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
    // GitLink 业务错误经常用 HTTP 200 + status 非 0 表达
    if (data !== null && typeof data === 'object' && typeof data.status === 'number' && data.status !== 0) {
      const message = typeof data.message === 'string' ? data.message : `status=${data.status}`
      const notFound = data.status === 404 || /不存在|not found/i.test(message)
      throw new GitlinkApiError(
        `${method} ${bareUrl(url)} 返回业务错误 ${data.status}: ${message}`,
        {
          status: notFound ? 404 : data.status === 403 ? 403 : data.status === 401 ? 401 : 400,
          method,
          path: bareUrl(url),
        },
      )
    }
    return data
  }

  /** 分页读取 releases */
  async listReleases() {
    const releases = []
    for (let page = 1; page <= 100; page += 1) {
      const data = await this.request('/releases.json', {
        params: { page, limit: PER_PAGE },
      })
      const batch = Array.isArray(data?.releases) ? data.releases : []
      if (batch.length === 0) {
        break
      }
      releases.push(...batch)
      if (batch.length < PER_PAGE) {
        break
      }
    }
    return releases
  }

  /** 最新发布 tag（release 列表默认按时间倒序） */
  async getLatestTagSafe() {
    try {
      const data = await this.request('/releases.json', { params: { page: 1, limit: 1 } })
      return Array.isArray(data?.releases) && data.releases.length > 0
        ? data.releases[0]?.tag_name
        : undefined
    } catch {
      return undefined
    }
  }

  async getReleaseByTag(tag) {
    const releases = await this.listReleases()
    const release = releases.find((item) => item?.tag_name === tag) ?? null
    if (release === null) {
      return null
    }
    const latestTag = releases.length > 0 ? releases[0]?.tag_name : undefined
    return normalizeRelease(release, { latestTag, apiBase: this.apiBase })
  }

  async getLatestRelease() {
    const data = await this.request('/releases.json', { params: { page: 1, limit: 1 } })
    const release = Array.isArray(data?.releases) ? data.releases[0] : undefined
    return release === undefined
      ? null
      : normalizeRelease(release, { latestTag: release?.tag_name, apiBase: this.apiBase })
  }

  /** 标签列表；GitLink 只有 /v1/{owner}/{repo}/tags.json */
  async getTag(tag) {
    const [owner, repo] = this.repo.split('/')
    const url = new URL(`${this.apiBase}/v1/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags.json`)
    url.searchParams.set('page', '1')
    url.searchParams.set('limit', '100')
    let response
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error) {
      throw describeNetworkError('GET', url.toString(), error)
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
      throw describeResponseError(response, data, text, 'GET', url.toString())
    }
    if (data?.status !== undefined && data.status !== 0) {
      throw new GitlinkApiError(
        `GET ${bareUrl(url.toString())} 返回业务错误 ${data.status}: ${data.message ?? ''}`,
        {
          status: data.status === 401 ? 401 : data.status === 403 ? 403 : 404,
          method: 'GET',
          path: bareUrl(url.toString()),
        },
      )
    }
    const tags = Array.isArray(data?.tags) ? data.tags : []
    return tags.find((item) => item?.name === tag) ?? null
  }

  /**
   * GitLink 没有可用的“按分支创建标签”独立接口；创建 Release 时传 target_commitish，
   * GitLink 会按目标分支自动建标签。因此这里只在标签已存在时返回 created=false，
   * 标签不存在时返回 created=true（由后续 createRelease 完成实际创建）。
   */
  async ensureTag(tag, branch) {
    const existing = await this.getTag(tag)
    if (existing !== null) {
      return { created: false, tag: existing }
    }
    return { created: true, tag: null, deferred: true, branch }
  }

  async getDefaultBranch() {
    const [owner, repo] = this.repo.split('/')
    const url = `${this.apiBase}/v1/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    let response
    try {
      response = await this.fetchImpl(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error) {
      throw describeNetworkError('GET', url, error)
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
      throw describeResponseError(response, data, text, 'GET', url)
    }
    return typeof data?.default_branch === 'string' ? data.default_branch : undefined
  }

  async createRelease(fields) {
    const payload = {
      tag_name: fields.tag_name,
      name: typeof fields.name === 'string' && fields.name !== '' ? fields.name : fields.tag_name,
      body: typeof fields.body === 'string' ? fields.body : '',
      target_commitish: fields.target_commitish,
      draft: fields.draft === true,
      prerelease: fields.prerelease === true,
    }
    if (Array.isArray(fields.attachment_ids)) {
      payload.attachment_ids = fields.attachment_ids
    }
    await this.request('/releases.json', { method: 'POST', body: payload })
    // GitLink 创建接口通常只返回 status/message，需要按 tag 回查
    const release = await this.getReleaseByTag(fields.tag_name)
    if (release === null) {
      throw new Error(`创建 GitLink 发布 "${fields.tag_name}" 成功，但无法读取目标发布；请重跑`)
    }
    return release
  }

  async updateRelease(releaseId, fields, { tag } = {}) {
    const releaseTag = tag
    const current =
      releaseTag === undefined ? null : await this.getReleaseByTag(String(releaseTag))
    if (current === null) {
      throw new Error('读取 GitLink 发布失败：找不到目标发布')
    }
    const payload = {
      name: typeof fields.name === 'string' ? fields.name : current.name,
      body: typeof fields.body === 'string' ? fields.body : current.body,
      tag_name: current.tag_name,
      target_commitish: current.target_commitish,
      draft: typeof fields.draft === 'boolean' ? fields.draft : current.draft === true,
      prerelease:
        typeof fields.prerelease === 'boolean' ? fields.prerelease : current.prerelease === true,
    }
    if (Array.isArray(fields.attachment_ids)) {
      payload.attachment_ids = fields.attachment_ids
    }
    const versionId = current.version_id ?? releaseId ?? current.id
    await this.request(`/releases/${encodeURIComponent(String(versionId))}`, {
      method: 'PUT',
      body: payload,
    })
    const updated = await this.getReleaseByTag(String(current.tag_name))
    return updated ?? current
  }

  /**
   * 上传附件：POST /attachments.json（multipart file），拿到附件 id 后
   * 用 attachment_ids 把附件关联到目标 Release。
   */
  async uploadAsset(releaseId, assetName, filePath, { contentType, tag } = {}) {
    const releaseTag = tag ?? releaseId
    if (releaseTag === undefined || releaseTag === null || releaseTag === '') {
      throw new Error(`上传附件 ${assetName} 失败: 缺少发布 tag`)
    }
    // 先取当前发布并删掉同名旧附件；GitLink 的 attachment_ids 更新是追加语义。
    const current = await this.getReleaseByTag(String(releaseTag))
    if (current === null) {
      throw new Error(`上传附件 ${assetName} 失败: 找不到目标发布 "${releaseTag}"`)
    }
    for (const item of current.assets) {
      if (item.name === assetName) {
        await this.deleteAsset(current.id, item.id)
      }
    }
    const { size } = await stat(filePath)
    const boundary = `----publish-apk-${randomUUID()}`
    const safeName = String(assetName).replace(/["\r\n]/g, '_')
    const type =
      typeof contentType === 'string' && contentType !== ''
        ? contentType
        : 'application/octet-stream'
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        `Content-Type: ${type}\r\n\r\n`,
    )
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`)
    const uploadUrl = `${this.apiBase}/attachments.json`
    const init = {
      method: 'POST',
      headers: {
        Accept: ACCEPT,
        Authorization: `Bearer ${this.token}`,
        'User-Agent': USER_AGENT,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(preamble.length + size + epilogue.length),
      },
      signal: AbortSignal.timeout(this.transferTimeoutMs),
    }
    if (size === 0) {
      init.body = Buffer.concat([preamble, epilogue])
    } else {
      init.body = Readable.toWeb(
        Readable.from(
          (async function* body() {
            yield preamble
            for await (const chunk of createReadStream(filePath)) {
              yield chunk
            }
            yield epilogue
          })(),
        ),
      )
      init.duplex = 'half'
    }
    let response
    try {
      response = await this.fetchImpl(uploadUrl, init)
    } catch (error) {
      throw describeNetworkError('POST', uploadUrl, error)
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
      throw describeResponseError(response, data, text, 'POST', uploadUrl)
    }
    if (data !== null && typeof data === 'object' && typeof data.status === 'number' && data.status !== 0) {
      throw new GitlinkApiError(
        `POST ${bareUrl(uploadUrl)} 返回业务错误 ${data.status}: ${data.message ?? ''}`,
        { status: data.status === 401 ? 401 : data.status === 403 ? 403 : 400, method: 'POST', path: bareUrl(uploadUrl) },
      )
    }
    const attachment = data?.data ?? data
    if (attachment === null || typeof attachment !== 'object' || attachment.id === undefined) {
      throw new Error(`上传附件 ${assetName} 失败: GitLink 未返回附件 id`)
    }

    await this.updateRelease(current.id, { attachment_ids: [attachment.id] }, { tag: releaseTag })
    return attachment
  }

  /** 删除附件：DELETE /api/attachments/{id}（同名旧附件先删再传） */
  async deleteAsset(releaseId, assetId) {
    if (assetId === undefined || assetId === null || assetId === '') {
      throw new Error('删除 GitLink 附件失败: 缺少附件 id')
    }
    const url = `${this.apiBase}/attachments/${encodeURIComponent(String(assetId))}`
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error) {
      throw describeNetworkError('DELETE', url, error)
    }
    const text = await response.text()
    if (response.status === 404) {
      return { alreadyDeleted: true }
    }
    if (!response.ok) {
      throw describeResponseError(response, undefined, text, 'DELETE', url)
    }
    return { deleted: true }
  }

  async downloadAsset(asset, destPath) {
    const url = asset?.browser_download_url
    if (typeof url !== 'string' || url === '') {
      throw new Error(`下载附件 ${asset?.name ?? ''} 失败: 缺少下载地址`)
    }
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`下载附件 ${asset.name} 失败: 下载地址无效`)
    }
    const apiHost = new URL(this.apiBase).hostname
    const headers = { Accept: '*/*', 'User-Agent': USER_AGENT }
    if (parsed.hostname === apiHost) {
      headers.Authorization = `Bearer ${this.token}`
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
    if (
      asset.size_approx !== true &&
      Number.isFinite(expectedSize) &&
      expectedSize >= 0 &&
      expectedSize !== size
    ) {
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
}

/** GitLink 平台适配器 */
export const gitlinkReleaseProvider = {
  id: GITLINK_PROVIDER_ID,
  label: GITLINK_LABEL,
  hosts: GITLINK_HOSTS,
  defaultHost: GITLINK_DEFAULT_HOST,
  tokenEnvs: GITLINK_TOKEN_ENVS,
  apiBaseEnvs: GITLINK_API_BASE_ENVS,
  // GitLink 附件上传到 /attachments.json 后用 attachment_ids 关联发布
  supportsMakeLatest: false,
  resolveToken: resolveGitlinkToken,
  resolveApiBase: resolveGitlinkApiBase,
  createClient(options) {
    return new GitlinkReleaseClient(options)
  },
}

export { GitlinkReleaseClient }
