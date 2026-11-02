/**
 * GitHub REST API：Release 发布同步适配器。
 *
 * 与 src/cnb.js / src/gitee.js 一样，本模块只认识 GitHub，不认识同步编排。
 * 用到的接口：
 *   GET   /repos/{owner}/{repo}/releases/tags/{tag}                 按 Tag 查发布
 *   GET   /repos/{owner}/{repo}/releases/latest                     最新发布
 *   GET   /repos/{owner}/{repo}/releases                           发布列表（Tag 带 / 时回退）
 *   POST  /repos/{owner}/{repo}/releases                           创建发布
 *   PATCH /repos/{owner}/{repo}/releases/{id}                      更新发布
 *   GET   /repos/{owner}/{repo}/releases/{id}/assets               附件列表
 *   POST  https://uploads.github.com/repos/{owner}/{repo}/releases/{id}/assets?name=...
 *                                                                  上传附件
 *   DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}         删除附件
 *   GET   /repos/{owner}/{repo}/releases/assets/{asset_id}          下载附件（Accept: octet-stream）
 *   GET   /repos/{owner}/{repo}/git/ref/tags/{tag}                  标签 ref
 *   GET   /repos/{owner}/{repo}/git/ref/heads/{branch}              分支 ref（取 SHA）
 *   POST  /repos/{owner}/{repo}/git/refs                            创建标签 ref
 *   GET   /repos/{owner}/{repo}                                    仓库信息（默认分支）
 *
 * 鉴权：Authorization: Bearer <token>；API 版本头 X-GitHub-Api-Version: 2022-11-28。
 *
 * GitHub Release 自带附件上传能力，所以 GitHub 目标仍走「下载源附件 → 删除同名旧附件 →
 * 上传新附件」的流程；GitHub 的 asset 对象带 `digest`（形如 sha256:...），
 * 会被映射成 hash_algo / hash_value，供编排层按 SHA 跳过或替换。
 *
 * 上传域名与 API 域名不同：
 *   - github.com：API https://api.github.com，上传 https://uploads.github.com
 *   - GitHub Enterprise：API .../api/v3，上传 .../api/uploads
 *   - 自定义 / 本地联调：默认沿用 API 地址，也可用 GITHUB_*_UPLOAD_BASE 覆盖。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 适配器标识 */
export const GITHUB_PROVIDER_ID = 'github'
/** 平台名称 */
export const GITHUB_LABEL = 'GitHub'
/** 网页域名 */
export const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
/** 默认网页地址前缀 */
export const GITHUB_DEFAULT_HOST = 'github.com'
/** 默认 API 地址 */
export const GITHUB_DEFAULT_API_BASE = 'https://api.github.com'
/** github.com 的附件上传地址 */
export const GITHUB_DEFAULT_UPLOAD_BASE = 'https://uploads.github.com'

const USER_AGENT = 'publish-apk'
const API_VERSION = '2022-11-28'
const ACCEPT = 'application/vnd.github+json'
const REQUEST_TIMEOUT_MS = 30_000
const TRANSFER_TIMEOUT_MS = 10 * 60_000
const MAX_REDIRECTS = 5
const PER_PAGE = 100

const GITHUB_TOKEN_ENVS = {
  source: ['GITHUB_SOURCE_TOKEN', 'GITHUB_TOKEN'],
  target: ['GITHUB_TARGET_TOKEN', 'GITHUB_TOKEN'],
}

const GITHUB_API_BASE_ENVS = {
  // GITHUB_API_URL 是 GitHub Actions / GHES 常用变量，作为最后兜底
  source: ['GITHUB_SOURCE_API_BASE', 'GITHUB_API_BASE', 'GITHUB_API_URL'],
  target: ['GITHUB_TARGET_API_BASE', 'GITHUB_API_BASE', 'GITHUB_API_URL'],
}

const GITHUB_UPLOAD_BASE_ENVS = {
  source: ['GITHUB_SOURCE_UPLOAD_BASE', 'GITHUB_UPLOAD_BASE'],
  target: ['GITHUB_TARGET_UPLOAD_BASE', 'GITHUB_UPLOAD_BASE'],
}

/** GitHub API 业务错误 */
export class GithubApiError extends Error {
  constructor(message, { status, method, path } = {}) {
    super(message)
    this.name = 'GithubApiError'
    this.status = status
    this.method = method
    this.path = path
  }
}

export function isGithubNotFound(error) {
  return error instanceof GithubApiError && error.status === 404
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

/** 解析 GitHub 令牌 */
export function resolveGithubToken(env, role) {
  const found = firstEnv(env, GITHUB_TOKEN_ENVS[role] ?? GITHUB_TOKEN_ENVS.source)
  if (found === undefined) {
    return undefined
  }
  return { token: found.value, source: found.name }
}

/** 规范化 API / 上传地址 */
function normalizeGithubBase(value, label) {
  const text = String(value).trim()
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`${label}无效: ${text}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}必须是 http(s): ${text}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${label}不能包含用户名或口令，请把令牌放到 --source-token / --target-token`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`${label}不能带查询串或锚点: ${text}`)
  }
  return url.toString().replace(/\/+$/, '')
}

export function normalizeGithubApiBase(value) {
  return normalizeGithubBase(value, 'API 地址')
}

/** 解析 GitHub API 地址：命令行 > 平台环境变量 > 默认值 */
export function resolveGithubApiBase(env, role, override) {
  if (override !== undefined) {
    return normalizeGithubApiBase(override)
  }
  const found = firstEnv(env, GITHUB_API_BASE_ENVS[role] ?? GITHUB_API_BASE_ENVS.source)
  return normalizeGithubApiBase(found === undefined ? GITHUB_DEFAULT_API_BASE : found.value)
}

/**
 * 解析附件上传地址。
 *
 * 默认按 API 地址推断：github.com 用 uploads.github.com，GHES 用 /api/uploads，
 * 自定义联调地址沿用 API 地址；GITHUB_*_UPLOAD_BASE 可显式覆盖。
 */
export function resolveGithubUploadBase(env, role, apiBaseOverride) {
  const names = GITHUB_UPLOAD_BASE_ENVS[role] ?? GITHUB_UPLOAD_BASE_ENVS.source
  const found = firstEnv(env, names)
  if (found !== undefined) {
    return normalizeGithubBase(found.value, '上传地址')
  }
  if (apiBaseOverride !== undefined) {
    return deriveGithubUploadBase(normalizeGithubApiBase(apiBaseOverride))
  }
  const apiFound = firstEnv(env, GITHUB_API_BASE_ENVS[role] ?? GITHUB_API_BASE_ENVS.source)
  const apiBase = normalizeGithubApiBase(
    apiFound === undefined ? GITHUB_DEFAULT_API_BASE : apiFound.value,
  )
  return deriveGithubUploadBase(apiBase)
}

/** 从 API 地址推断上传地址 */
function deriveGithubUploadBase(apiBase) {
  const url = new URL(apiBase)
  if (url.hostname === 'api.github.com' && (url.pathname === '/' || url.pathname === '')) {
    return GITHUB_DEFAULT_UPLOAD_BASE
  }
  if (url.pathname.replace(/\/+$/, '').endsWith('/api/v3')) {
    return `${url.origin}/api/uploads`
  }
  return apiBase
}

/** 去掉查询串，错误信息不暴露敏感参数 */
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

/** 把 GitHub 错误响应整理成可读文本；GitHub 通常是 { message } */
function describeResponseError(response, data, text, method, url) {
  const message =
    typeof data?.message === 'string' ? data.message : text.trim().slice(0, 300)
  const suffix = message === '' ? '' : `: ${message}`
  const lines = [`${method} ${bareUrl(url)} 返回 ${response.status}${suffix}`]
  if (response.status === 401) {
    lines.push('提示: GitHub 访问令牌无效或已过期')
  } else if (response.status === 403) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    if (remaining === '0') {
      lines.push('提示: GitHub API 速率限制已用尽，稍后重试')
    } else {
      lines.push('提示: GitHub 令牌缺少权限（目标仓库需要 Contents 读写权限）')
    }
  } else if (response.status === 404) {
    lines.push('提示: GitHub 仓库、Release、Tag 或附件不存在，或令牌没有访问权限')
  } else if (response.status === 422) {
    lines.push('提示: GitHub 拒绝请求（常见原因：同名附件已存在、标签无效或目标分支不存在）')
  } else if (response.status === 429) {
    lines.push('提示: GitHub 请求过于频繁，稍后重试')
  } else if (response.status >= 500) {
    lines.push('提示: GitHub 服务端错误，稍后重试')
  }
  return new GithubApiError(lines.join('\n'), {
    status: response.status,
    method,
    path: bareUrl(url),
  })
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 把 ref 的各个路径段编码，保留 /（GitHub 的 git/ref 接口支持带 / 的 ref） */
function encodeRefPath(value) {
  return String(value)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** GitHub digest（sha256:...）转成编排层使用的 hash 字段 */
function digestFields(asset) {
  if (typeof asset?.digest !== 'string') {
    return {}
  }
  const digest = asset.digest.trim()
  const index = digest.indexOf(':')
  if (index <= 0 || index === digest.length - 1) {
    return {}
  }
  return {
    hash_algo: digest.slice(0, index).toLowerCase(),
    hash_value: digest.slice(index + 1),
  }
}

/** 把 GitHub asset 转成统一形状 */
function normalizeAsset(asset, releaseId) {
  return {
    ...asset,
    release_id: releaseId,
    ...digestFields(asset),
  }
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

/** 计算本地文件 SHA-256（上传失败后核对 GitHub 是否已实际落盘） */
async function sha256File(filePath) {
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk)
      callback()
    },
  })
  await pipeline(createReadStream(filePath), tap)
  return hash.digest('hex')
}

/** GitHub REST 客户端 */
class GithubReleaseClient {
  constructor({
    repo,
    token,
    apiBase = GITHUB_DEFAULT_API_BASE,
    uploadBase,
    fetchImpl = fetch,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    transferTimeoutMs = TRANSFER_TIMEOUT_MS,
  }) {
    if (typeof repo !== 'string' || repo === '') {
      throw new Error('GithubReleaseClient 需要仓库路径')
    }
    if (typeof token !== 'string' || token === '') {
      throw new Error('GithubReleaseClient 需要访问令牌')
    }
    const parts = repo.split('/')
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      throw new Error(`GitHub 仓库地址需要 owner/repo 两段，实际: ${repo}`)
    }
    this.owner = parts[0]
    this.repo = parts[1]
    this.token = token
    this.apiBase = normalizeGithubApiBase(apiBase)
    this.uploadBase =
      uploadBase === undefined ? deriveGithubUploadBase(this.apiBase) : normalizeGithubBase(uploadBase, '上传地址')
    this.fetchImpl = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.transferTimeoutMs = transferTimeoutMs
  }

  /** /repos/{owner}/{repo}... */
  apiUrl(suffix) {
    return `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`
  }

  /** GitHub 附件上传地址（uploads.github.com 或 GHES 的 /api/uploads） */
  uploadUrl(releaseId, assetName) {
    return `${this.uploadBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/releases/${encodeURIComponent(String(releaseId))}/assets?name=${encodeURIComponent(assetName)}`
  }

  headers({ json = false } = {}) {
    const headers = {
      Accept: ACCEPT,
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    }
    if (json) {
      headers['Content-Type'] = 'application/json'
    }
    return headers
  }

  /** JSON 请求 */
  async request(suffix, { method = 'GET', body, timeoutMs = this.requestTimeoutMs } = {}) {
    const url = this.apiUrl(suffix)
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

  /** 分页读取列表，直到空页 */
  async listAll(suffix) {
    const items = []
    for (let page = 1; page <= 100; page += 1) {
      const separator = suffix.includes('?') ? '&' : '?'
      const batch = await this.request(`${suffix}${separator}page=${page}&per_page=${PER_PAGE}`)
      if (!Array.isArray(batch) || batch.length === 0) {
        break
      }
      items.push(...batch)
    }
    return items
  }

  /** 发布附件列表（GitHub 的 release.assets 可能分页，单独取全） */
  async getAssets(releaseId) {
    const assets = await this.listAll(
      `/releases/${encodeURIComponent(String(releaseId))}/assets`,
    )
    return assets
      .filter((asset) => asset !== null && typeof asset === 'object' && asset.id !== undefined)
      .map((asset) => normalizeAsset(asset, releaseId))
  }

  /** 最新发布 ID（用于 is_latest）；失败不影响主体同步 */
  async getLatestIdSafe() {
    try {
      const latest = await this.request('/releases/latest')
      return latest !== null && typeof latest === 'object' ? latest.id : undefined
    } catch {
      return undefined
    }
  }

  /** 把 GitHub 发布补齐为统一形状：附件列表 + is_latest */
  async normalizeRelease(release, { latestId } = {}) {
    if (release === null || typeof release !== 'object' || Array.isArray(release)) {
      return release
    }
    const assets = await this.getAssets(release.id)
    const normalized = { ...release, assets }
    if (latestId !== undefined) {
      normalized.is_latest = String(latestId) === String(release.id)
    }
    return normalized
  }

  /** 按 Tag 查发布；Tag 带 / 且 404 时回退到发布列表 */
  async getReleaseByTag(tag) {
    let release = null
    try {
      release = await this.request(`/releases/tags/${encodeRefPath(tag)}`)
    } catch (error) {
      if (!isGithubNotFound(error)) {
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
    const latestId = await this.getLatestIdSafe()
    return this.normalizeRelease(release, { latestId })
  }

  /** 最新发布 */
  async getLatestRelease() {
    try {
      const release = await this.request('/releases/latest')
      return this.normalizeRelease(release, { latestId: release?.id })
    } catch (error) {
      if (isGithubNotFound(error)) {
        return null
      }
      throw error
    }
  }

  /** 查询标签 ref；不存在返回 null */
  async getTag(tag) {
    try {
      return await this.request(`/git/ref/tags/${encodeRefPath(tag)}`)
    } catch (error) {
      if (isGithubNotFound(error)) {
        return null
      }
      throw error
    }
  }

  /** 取分支 / commit 的 SHA */
  async getBranchSha(branch) {
    try {
      const ref = await this.request(`/git/ref/heads/${encodeRefPath(branch)}`)
      if (typeof ref?.object?.sha === 'string' && ref.object.sha !== '') {
        return ref.object.sha
      }
    } catch (error) {
      if (!isGithubNotFound(error)) {
        throw error
      }
    }
    const commit = await this.request(`/commits/${encodeRefPath(branch)}`)
    if (typeof commit?.sha === 'string' && commit.sha !== '') {
      return commit.sha
    }
    throw new Error(`无法解析 GitHub 分支 / 提交 "${branch}" 的 SHA`)
  }

  /** 目标标签不存在时，基于 branch 创建轻量标签 ref */
  async ensureTag(tag, branch) {
    const existing = await this.getTag(tag)
    if (existing !== null) {
      return { created: false, tag: existing }
    }
    const sha = await this.getBranchSha(branch)
    try {
      const created = await this.request('/git/refs', {
        method: 'POST',
        body: { ref: `refs/tags/${tag}`, sha },
      })
      return { created: true, tag: created }
    } catch (error) {
      if (error instanceof GithubApiError && [409, 422].includes(error.status)) {
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
      target_commitish: fields.target_commitish,
      name:
        typeof fields.name === 'string' && fields.name !== '' ? fields.name : fields.tag_name,
      body: typeof fields.body === 'string' ? fields.body : '',
    }
    if (fields.draft !== undefined) {
      payload.draft = fields.draft === true
    }
    if (fields.prerelease !== undefined) {
      payload.prerelease = fields.prerelease === true
    }
    if (typeof fields.make_latest === 'string') {
      payload.make_latest = fields.make_latest
    }
    let release = await this.request('/releases', { method: 'POST', body: payload })
    if (release === null || typeof release !== 'object' || release.id === undefined) {
      release = await this.getReleaseByTag(fields.tag_name)
    }
    if (release === null || typeof release !== 'object' || release.id === undefined) {
      throw new Error(`创建 GitHub 发布 "${fields.tag_name}" 成功，但无法读取目标发布（缺少 id）；请重跑`)
    }
    return { ...release, assets: [] }
  }

  /** 更新发布；只提交 GitHub 支持的字段 */
  async updateRelease(releaseId, fields) {
    const payload = {}
    if (typeof fields.name === 'string') {
      payload.name = fields.name
    }
    if (typeof fields.body === 'string') {
      payload.body = fields.body
    }
    if (fields.draft !== undefined) {
      payload.draft = fields.draft === true
    }
    if (fields.prerelease !== undefined) {
      payload.prerelease = fields.prerelease === true
    }
    if (typeof fields.make_latest === 'string') {
      payload.make_latest = fields.make_latest
    }
    let release = await this.request(
      `/releases/${encodeURIComponent(String(releaseId))}`,
      { method: 'PATCH', body: payload },
    )
    if (release === null || typeof release !== 'object') {
      release = await this.request(`/releases/${encodeURIComponent(String(releaseId))}`)
    }
    if (release === null || typeof release !== 'object') {
      throw new Error('更新 GitHub 发布失败：响应数据无效')
    }
    return { ...release, assets: [] }
  }

  /** 删除附件；GitHub 删除接口不需要 release_id */
  async deleteAsset(releaseId, assetId) {
    try {
      return await this.request(
        `/releases/assets/${encodeURIComponent(String(assetId))}`,
        { method: 'DELETE' },
      )
    } catch (error) {
      if (isGithubNotFound(error)) {
        return { alreadyDeleted: true }
      }
      throw error
    }
  }

  /** 下载附件到本地文件，校验大小 / digest */
  async downloadAsset(asset, destPath) {
    if (asset?.id === undefined) {
      throw new Error(`下载附件 ${asset?.name ?? ''} 失败: 缺少附件 id`)
    }
    const url =
      typeof asset.url === 'string' && asset.url !== ''
        ? asset.url
        : this.apiUrl(`/releases/assets/${encodeURIComponent(String(asset.id))}`)
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/octet-stream',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': API_VERSION,
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
        // 对象存储的预签名地址不再带 GitHub 令牌
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

  /** 上传附件：GitHub 不允许同名附件，先删同名再上传 */
  async uploadAsset(releaseId, assetName, filePath, { contentType } = {}) {
    const existing = await this.getAssets(releaseId)
    for (const asset of existing) {
      if (asset.name !== assetName) {
        continue
      }
      await this.deleteAsset(releaseId, asset.id)
    }

    const { size } = await stat(filePath)
    const url = this.uploadUrl(releaseId, assetName)
    let response
    try {
      const init = {
        method: 'POST',
        headers: {
          Accept: ACCEPT,
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
          'Content-Type':
            typeof contentType === 'string' && contentType !== ''
              ? contentType
              : 'application/octet-stream',
          'Content-Length': String(size),
        },
        signal: AbortSignal.timeout(this.transferTimeoutMs),
      }
      if (size === 0) {
        init.body = Buffer.alloc(0)
      } else {
        init.body = Readable.toWeb(createReadStream(filePath))
        init.duplex = 'half'
      }
      response = await this.fetchImpl(url, init)
    } catch (error) {
      const verified = await this.verifyUploadedAsset(releaseId, assetName, filePath, size)
      if (verified !== null) {
        return { ...verified, release_id: releaseId }
      }
      throw describeNetworkError('POST', url, error)
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
      // GitHub 偶尔会在附件已经落盘后仍返回 404（例如安全扫描 / 代理抖动）。
      // 先按同名 + 大小 + sha256 核对目标附件，确认存在就按成功处理，避免重复上传。
      const verified = await this.verifyUploadedAsset(releaseId, assetName, filePath, size)
      if (verified !== null) {
        return { ...verified, release_id: releaseId }
      }
      throw describeResponseError(response, data, text, 'POST', url)
    }
    return {
      ...(data !== null && typeof data === 'object' ? data : {}),
      release_id: releaseId,
    }
  }

  /**
   * 上传失败后核对目标 Release 是否已有同名且内容一致的附件。
   * 只接受 GitHub 返回的 sha256 digest；没有 digest 时不做“猜测成功”。
   */
  async verifyUploadedAsset(releaseId, assetName, filePath, size) {
    let assets
    try {
      assets = await this.getAssets(releaseId)
    } catch {
      return null
    }
    const candidates = assets.filter((asset) => asset.name === assetName)
    if (candidates.length === 0) {
      return null
    }
    let localHash
    try {
      localHash = await sha256File(filePath)
    } catch {
      return null
    }
    for (const asset of candidates) {
      const digest = typeof asset.digest === 'string' ? asset.digest.toLowerCase() : ''
      const digestHex = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : undefined
      if (Number(asset.size) === size && digestHex === localHash) {
        return asset
      }
    }
    return null
  }
}

/** GitHub 平台适配器 */
export const githubReleaseProvider = {
  id: GITHUB_PROVIDER_ID,
  label: GITHUB_LABEL,
  hosts: GITHUB_HOSTS,
  defaultHost: GITHUB_DEFAULT_HOST,
  tokenEnvs: GITHUB_TOKEN_ENVS,
  apiBaseEnvs: GITHUB_API_BASE_ENVS,
  uploadBaseEnvs: GITHUB_UPLOAD_BASE_ENVS,
  // GitHub 支持附件上传，且支持 draft / make_latest
  assetUploadDirectToTable: false,
  supportsDraft: true,
  supportsMakeLatest: true,
  resolveToken: resolveGithubToken,
  resolveApiBase: resolveGithubApiBase,
  createClient(options) {
    const uploadBase = resolveGithubUploadBase(
      options.env ?? {},
      options.role ?? 'target',
      options.apiBase,
    )
    return new GithubReleaseClient({ ...options, uploadBase })
  },
}

export { GithubReleaseClient }
