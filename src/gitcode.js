/**
 * GitCode（gitcode.com）Open API v5：Release 发布同步适配器。
 *
 * GitCode 的 Release API 与 Gitee 类似，但有几处关键差异：
 *   - API 域名是 https://api.gitcode.com/api/v5；
 *   - 更新 / 删除附件 / 下载 / 上传地址都按 **tag** 而非 release id；
 *   - 附件上传先 GET /releases/{tag}/upload_url 取预签名地址，再 PUT 文件；
 *   - Release 用 release_status（pre / latest）而不是 draft / make_latest 字段。
 *
 * 本模块用到的接口：
 *   GET   /repos/{owner}/{repo}/releases/tags/{tag}
 *   GET   /repos/{owner}/{repo}/releases/latest
 *   GET   /repos/{owner}/{repo}/releases
 *   POST  /repos/{owner}/{repo}/releases
 *   PATCH /repos/{owner}/{repo}/releases/{tag}
 *   GET   /repos/{owner}/{repo}/releases/{tag}/upload_url?file_name=...
 *   DELETE /repos/{owner}/{repo}/releases/{tag}/attach_files/{id}
 *   GET   /repos/{owner}/{repo}/releases/{tag}/attach_files/{file_name}/download
 *   GET   /repos/{owner}/{repo}/tags
 *   POST  /repos/{owner}/{repo}/tags
 *   GET   /repos/{owner}/{repo}                       仓库信息（默认分支）
 *
 * 鉴权：Authorization: Bearer <token>（GitCode 也支持 PRIVATE-TOKEN / access_token，
 * 这里统一用 Bearer，避免令牌进入 URL 与日志）。
 *
 * GitCode Release 的 assets 会包含自动生成的源码包（type=source）；同步只把带 id 的
 * 上传附件当作发布产物，避免误删源码包。上传附件带 digest（sha256），用于 SHA 跳过/替换。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 适配器标识 */
export const GITCODE_PROVIDER_ID = 'gitcode'
/** 平台名称 */
export const GITCODE_LABEL = 'GitCode'
/** 网页域名 */
export const GITCODE_HOSTS = new Set(['gitcode.com', 'www.gitcode.com'])
/** 默认网页地址前缀 */
export const GITCODE_DEFAULT_HOST = 'gitcode.com'
/** 默认 API 地址（注意不是网页域名） */
export const GITCODE_DEFAULT_API_BASE = 'https://api.gitcode.com/api/v5'

const USER_AGENT = 'publish-apk'
const ACCEPT = 'application/json'
const REQUEST_TIMEOUT_MS = 30_000
const TRANSFER_TIMEOUT_MS = 10 * 60_000
const MAX_REDIRECTS = 5
const PER_PAGE = 100

const GITCODE_TOKEN_ENVS = {
  source: ['GITCODE_SOURCE_TOKEN', 'GITCODE_TOKEN'],
  target: ['GITCODE_TARGET_TOKEN', 'GITCODE_TOKEN'],
}

const GITCODE_API_BASE_ENVS = {
  source: ['GITCODE_SOURCE_API_BASE', 'GITCODE_API_BASE'],
  target: ['GITCODE_TARGET_API_BASE', 'GITCODE_API_BASE'],
}

/** GitCode API 业务错误 */
export class GitcodeApiError extends Error {
  constructor(message, { status, method, path } = {}) {
    super(message)
    this.name = 'GitcodeApiError'
    this.status = status
    this.method = method
    this.path = path
  }
}

export function isGitcodeNotFound(error) {
  return error instanceof GitcodeApiError && error.status === 404
}

/** GitCode 在“仓库存在但没有任何 Release”时返回 400: 未找到 release */
export function isGitcodeNoRelease(error) {
  return (
    error instanceof GitcodeApiError &&
    error.status === 400 &&
    /未找到\s*release|release\s+not\s+found/i.test(error.message)
  )
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

/** 解析 GitCode 令牌 */
export function resolveGitcodeToken(env, role) {
  const found = firstEnv(env, GITCODE_TOKEN_ENVS[role] ?? GITCODE_TOKEN_ENVS.source)
  if (found === undefined) {
    return undefined
  }
  return { token: found.value, source: found.name }
}

/** 规范化 API 地址 */
export function normalizeGitcodeApiBase(value) {
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
export function resolveGitcodeApiBase(env, role, override) {
  if (override !== undefined) {
    return normalizeGitcodeApiBase(override)
  }
  const found = firstEnv(env, GITCODE_API_BASE_ENVS[role] ?? GITCODE_API_BASE_ENVS.source)
  return normalizeGitcodeApiBase(found === undefined ? GITCODE_DEFAULT_API_BASE : found.value)
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
    typeof data?.message === 'string'
      ? data.message
      : typeof data?.error_message === 'string'
        ? data.error_message
        : text.trim().slice(0, 300)
  const suffix = message === '' ? '' : `: ${message}`
  const lines = [`${method} ${bareUrl(url)} 返回 ${response.status}${suffix}`]
  if (response.status === 401) {
    lines.push('提示: GitCode 访问令牌无效或已过期，请检查 GITCODE_TOKEN / GITCODE_SOURCE_TOKEN / GITCODE_TARGET_TOKEN')
  } else if (response.status === 403) {
    lines.push('提示: GitCode 令牌缺少权限')
  } else if (response.status === 404) {
    lines.push('提示: GitCode 仓库、Release、Tag 或附件不存在，或令牌没有访问权限')
  } else if (response.status === 400) {
    lines.push('提示: GitCode 拒绝请求（常见原因：标签无效、目标分支不存在或附件参数不合法）')
  } else if (response.status === 429) {
    lines.push('提示: GitCode 请求过于频繁，稍后重试')
  } else if (response.status >= 500) {
    lines.push('提示: GitCode 服务端错误，稍后重试')
  }
  return new GitcodeApiError(lines.join('\n'), {
    status: response.status,
    method,
    path: bareUrl(url),
  })
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 把 digest 转成 hash_algo/hash_value；GitCode 可能给纯 hex 或 sha256:hex */
function digestFields(asset) {
  const digest = typeof asset?.digest === 'string' ? asset.digest.trim() : ''
  if (digest === '') {
    return {}
  }
  const index = digest.indexOf(':')
  if (index > 0 && index < digest.length - 1) {
    return {
      hash_algo: digest.slice(0, index).toLowerCase(),
      hash_value: digest.slice(index + 1),
    }
  }
  if (/^[0-9a-f]+$/i.test(digest)) {
    if (digest.length === 64) {
      return { hash_algo: 'sha256', hash_value: digest }
    }
    if (digest.length === 40) {
      return { hash_algo: 'sha1', hash_value: digest }
    }
    if (digest.length === 32) {
      return { hash_algo: 'md5', hash_value: digest }
    }
  }
  return {}
}

/** 只保留用户上传的附件；GitCode 的源码包 type=source，没有 id */
function isUploadedAsset(asset) {
  return (
    asset !== null &&
    typeof asset === 'object' &&
    asset.id !== undefined &&
    asset.type !== 'source'
  )
}

function normalizeAsset(asset, releaseTag) {
  return {
    ...asset,
    release_id: releaseTag,
    browser_download_url:
      typeof asset.browser_download_url === 'string'
        ? absoluteAssetUrl(asset.browser_download_url)
        : undefined,
    ...digestFields(asset),
  }
}

function absoluteAssetUrl(value) {
  if (typeof value !== 'string' || value === '') {
    return undefined
  }
  try {
    return new URL(value, 'https://gitcode.com').toString()
  } catch {
    return value
  }
}

/** release_status 映射：GitCode 用 pre / latest */
function releaseStatusFields(fields) {
  if (fields.prerelease === true) {
    return { release_status: 'pre' }
  }
  if (fields.make_latest === 'true' || fields.make_latest === true) {
    return { release_status: 'latest' }
  }
  return {}
}

/** 把 GitCode 发布补齐为统一形状 */
function normalizeRelease(release, { latestTag } = {}) {
  if (release === null || typeof release !== 'object' || Array.isArray(release)) {
    return release
  }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : undefined
  const assets = Array.isArray(release.assets)
    ? release.assets.filter(isUploadedAsset).map((asset) => normalizeAsset(asset, tag))
    : []
  const normalized = {
    ...release,
    // GitCode 的 Release 经常不回 id；用 tag 作为同步标识
    id: release.id ?? tag,
    assets,
  }
  if (
    release.release_status === 'latest' ||
    (latestTag !== undefined && tag !== undefined && latestTag === tag)
  ) {
    normalized.is_latest = true
  } else if (latestTag !== undefined) {
    normalized.is_latest = false
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

/** GitCode Open API 客户端 */
class GitcodeReleaseClient {
  constructor({
    repo,
    token,
    apiBase = GITCODE_DEFAULT_API_BASE,
    fetchImpl = fetch,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    transferTimeoutMs = TRANSFER_TIMEOUT_MS,
  }) {
    if (typeof repo !== 'string' || repo === '') {
      throw new Error('GitcodeReleaseClient 需要仓库路径')
    }
    if (typeof token !== 'string' || token === '') {
      throw new Error('GitcodeReleaseClient 需要访问令牌')
    }
    const parts = repo.split('/')
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      throw new Error(`GitCode 仓库地址需要 owner/repo 两段，实际: ${repo}`)
    }
    this.owner = parts[0]
    this.repo = parts[1]
    this.token = token
    this.apiBase = normalizeGitcodeApiBase(apiBase)
    this.fetchImpl = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.transferTimeoutMs = transferTimeoutMs
  }

  apiUrl(suffix, params = {}) {
    const url = new URL(
      `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`,
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
      Authorization: `Bearer ${this.token}`,
      'User-Agent': USER_AGENT,
    }
    if (json) {
      headers['Content-Type'] = 'application/json'
    }
    return headers
  }

  /** JSON 请求 */
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

  /** 最新发布 tag（GitCode 的 release id 可能为空，用 tag 比较更稳） */
  async getLatestTagSafe() {
    try {
      const latest = await this.request('/releases/latest')
      return typeof latest?.tag_name === 'string' ? latest.tag_name : undefined
    } catch {
      return undefined
    }
  }

  /** 按 Tag 查发布；Tag 带 / 且 404 时回退发布列表 */
  async getReleaseByTag(tag) {
    let release = null
    try {
      release = await this.request(`/releases/tags/${encodeURIComponent(tag)}`)
    } catch (error) {
      if (isGitcodeNoRelease(error)) {
        return null
      }
      if (!isGitcodeNotFound(error)) {
        throw error
      }
      if (!tag.includes('/')) {
        return null
      }
      const releases = await this.listAll('/releases')
      release = releases.find((item) => item?.tag_name === tag) ?? null
    }
    if (release === null) {
      return null
    }
    const latestTag = await this.getLatestTagSafe()
    return normalizeRelease(release, { latestTag })
  }

  /** 最新发布 */
  async getLatestRelease() {
    try {
      const release = await this.request('/releases/latest')
      return normalizeRelease(release, { latestTag: release?.tag_name })
    } catch (error) {
      if (isGitcodeNotFound(error) || isGitcodeNoRelease(error)) {
        return null
      }
      throw error
    }
  }

  /** 按名字查 Tag（GitCode 没有按名查询接口，翻标签列表） */
  async getTag(tag) {
    const tags = await this.listAll('/tags')
    return tags.find((item) => item?.name === tag) ?? null
  }

  /** 目标标签不存在时，基于 branch 创建 */
  async ensureTag(tag, branch) {
    const existing = await this.getTag(tag)
    if (existing !== null) {
      return { created: false, tag: existing }
    }
    try {
      const created = await this.request('/tags', {
        method: 'POST',
        body: { refs: branch, tag_name: tag },
      })
      return { created: true, tag: created }
    } catch (error) {
      if (error instanceof GitcodeApiError && [400, 403, 409, 422].includes(error.status)) {
        const raced = await this.getTag(tag)
        if (raced !== null) {
          return { created: false, tag: raced }
        }
      }
      throw error
    }
  }

  /** 仓库默认分支 */
  async getDefaultBranch() {
    const repo = await this.request('')
    return typeof repo?.default_branch === 'string' ? repo.default_branch : undefined
  }

  /** 创建发布 */
  async createRelease(fields) {
    const payload = {
      tag_name: fields.tag_name,
      name: typeof fields.name === 'string' && fields.name !== '' ? fields.name : fields.tag_name,
      body: typeof fields.body === 'string' ? fields.body : '',
      ...(fields.target_commitish === undefined
        ? {}
        : { target_commitish: fields.target_commitish }),
      ...releaseStatusFields(fields),
    }
    let release = await this.request('/releases', { method: 'POST', body: payload })
    if (release === null || typeof release !== 'object' || release.tag_name === undefined) {
      release = await this.getReleaseByTag(fields.tag_name)
    }
    if (release === null || typeof release !== 'object') {
      throw new Error(`创建 GitCode 发布 "${fields.tag_name}" 成功，但无法读取目标发布；请重跑`)
    }
    const latestTag = await this.getLatestTagSafe()
    return normalizeRelease(release, { latestTag })
  }

  /** 更新发布；GitCode PATCH 按 tag，且 name / body 必填 */
  async updateRelease(releaseId, fields, { tag } = {}) {
    const releaseTag = tag ?? releaseId
    const current = await this.request(`/releases/tags/${encodeURIComponent(String(releaseTag))}`)
    if (current === null || typeof current !== 'object') {
      throw new Error('读取 GitCode 发布失败：响应数据无效')
    }
    const payload = {
      name: typeof fields.name === 'string' ? fields.name : current.name,
      body: typeof fields.body === 'string' ? fields.body : current.body,
      ...releaseStatusFields(fields),
    }
    let updated = await this.request(
      `/releases/${encodeURIComponent(String(releaseTag))}`,
      { method: 'PATCH', body: payload },
    )
    const merged =
      updated !== null && typeof updated === 'object'
        ? { ...current, ...payload, ...updated }
        : { ...current, ...payload }
    const latestTag = await this.getLatestTagSafe()
    return normalizeRelease(merged, { latestTag })
  }

  /** 删除附件（GitCode 按 tag + 附件 id） */
  async deleteAsset(releaseId, assetId, { tag } = {}) {
    const releaseTag = tag ?? releaseId
    try {
      return await this.request(
        `/releases/${encodeURIComponent(String(releaseTag))}/attach_files/${encodeURIComponent(String(assetId))}`,
        { method: 'DELETE' },
      )
    } catch (error) {
      if (isGitcodeNotFound(error)) {
        return { alreadyDeleted: true }
      }
      throw error
    }
  }

  /** 下载附件；GitCode 路径按 tag + 文件名 */
  async downloadAsset(asset, destPath, { tag } = {}) {
    const releaseTag = tag ?? asset?.release_id
    if (releaseTag === undefined || typeof asset?.name !== 'string' || asset.name === '') {
      throw new Error(`下载附件 ${asset?.name ?? ''} 失败: 缺少 tag / 文件名`)
    }
    const url = this.apiUrl(
      `/releases/${encodeURIComponent(String(releaseTag))}/attach_files/${encodeURIComponent(asset.name)}/download`,
    )
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: '*/*',
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

  /** 上传附件：先取 upload_url，PUT 到 OBS，再返回本地文件信息 */
  async uploadAsset(releaseId, assetName, filePath, { contentType, tag } = {}) {
    const releaseTag = tag ?? releaseId
    // GitCode 没有覆盖参数：先删同名附件，避免重复
    const current = await this.request(`/releases/tags/${encodeURIComponent(String(releaseTag))}`)
    if (current !== null && typeof current === 'object' && Array.isArray(current.assets)) {
      for (const asset of current.assets.filter(isUploadedAsset)) {
        if (asset.name === assetName) {
          await this.deleteAsset(releaseId, asset.id, { tag: releaseTag })
        }
      }
    }

    const { size } = await stat(filePath)
    const options = await this.request(
      `/releases/${encodeURIComponent(String(releaseTag))}/upload_url`,
      { params: { file_name: assetName } },
    )
    const uploadUrl = options?.url
    const uploadHeaders = options?.headers
    if (typeof uploadUrl !== 'string' || uploadUrl === '') {
      throw new Error(`上传附件 ${assetName} 失败: GitCode 未返回 upload_url`)
    }
    if (uploadHeaders === null || typeof uploadHeaders !== 'object') {
      throw new Error(`上传附件 ${assetName} 失败: GitCode 未返回上传请求头`)
    }
    let absoluteUrl
    try {
      absoluteUrl = new URL(uploadUrl, `${this.apiBase}/`).toString()
    } catch {
      throw new Error(`上传附件 ${assetName} 失败: upload_url 无效`)
    }

    const headers = { ...uploadHeaders }
    headers['Content-Length'] = String(size)
    if (headers['Content-Type'] === undefined) {
      headers['Content-Type'] =
        typeof contentType === 'string' && contentType !== ''
          ? contentType
          : 'application/octet-stream'
    }
    let response
    try {
      const init = {
        method: 'PUT',
        headers,
        signal: AbortSignal.timeout(this.transferTimeoutMs),
      }
      if (size === 0) {
        init.body = Buffer.alloc(0)
      } else {
        init.body = Readable.toWeb(createReadStream(filePath))
        init.duplex = 'half'
      }
      response = await this.fetchImpl(absoluteUrl, init)
    } catch (error) {
      throw describeNetworkError('PUT', absoluteUrl, error)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `上传附件 ${assetName} 失败: HTTP ${response.status}${text === '' ? '' : `: ${text.trim().slice(0, 300)}`}`,
      )
    }
    return { name: assetName, size, release_id: releaseTag }
  }
}

/** GitCode 平台适配器 */
export const gitcodeReleaseProvider = {
  id: GITCODE_PROVIDER_ID,
  label: GITCODE_LABEL,
  hosts: GITCODE_HOSTS,
  defaultHost: GITCODE_DEFAULT_HOST,
  tokenEnvs: GITCODE_TOKEN_ENVS,
  apiBaseEnvs: GITCODE_API_BASE_ENVS,
  assetUploadDirectToTable: false,
  supportsDraft: false,
  // GitCode 能设置 latest，但不能明确“取消 latest”；false 时不提交该字段
  supportsMakeLatest: true,
  supportsMakeLatestFalse: false,
  resolveToken: resolveGitcodeToken,
  resolveApiBase: resolveGitcodeApiBase,
  createClient(options) {
    return new GitcodeReleaseClient(options)
  },
}

export { GitcodeReleaseClient }
