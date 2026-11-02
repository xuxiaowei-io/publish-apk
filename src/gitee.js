/**
 * Gitee（gitee.com）Open API v5：Release 发布同步适配器。
 *
 * 与 src/cnb.js 一样，本模块只认识 Gitee，不认识「同步」的编排逻辑。
 * 用到的接口（服务地址默认 https://gitee.com/api/v5）：
 *   GET   /repos/{owner}/{repo}/releases/tags/{tag}                  按 Tag 查发布
 *   GET   /repos/{owner}/{repo}/releases/latest                      最新发布
 *   GET   /repos/{owner}/{repo}/releases/{id}                        按 ID 查发布
 *   GET   /repos/{owner}/{repo}/releases                              发布列表（Tag 带 / 时回退）
 *   POST  /repos/{owner}/{repo}/releases                              创建发布
 *   PATCH /repos/{owner}/{repo}/releases/{id}                         更新发布
 *   GET   /repos/{owner}/{repo}/releases/{id}/attach_files            发布附件列表
 *   DELETE /repos/{owner}/{repo}/releases/{id}/attach_files/{fileId}  删除附件
 *   GET   /repos/{owner}/{repo}/releases/{id}/attach_files/{fileId}/download
 *                                                                     下载附件（通常 302）
 *   GET   /repos/{owner}/{repo}/tags                                  标签列表（按名字查找）
 *   POST  /repos/{owner}/{repo}/tags                                  创建标签
 *   GET   /repos/{owner}/{repo}                                       仓库信息（默认分支）
 *
 * 鉴权：access_token 查询参数（Gitee v5 所有接口都接受）。令牌只放在查询串里，
 * 错误信息与日志会去掉查询串，不会回显令牌。
 *
 * 两个 Gitee 特性会直接影响同步编排：
 *   1. Release 的 assets 里通常有自动生成的源码 zip/tar.gz，它们不是用户上传的附件。
 *      这里只把 attach_files 的返回当作可同步产物，避免误删自动产物。
 *   2. 目标为 Gitee 时默认不下载 / 不上传附件，由 release-sync.js 直接使用
 *      源发布附件地址生成 Markdown 下载表格，避免大文件白下载与附件安全拦截。
 */
import { createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 适配器标识 */
export const GITEE_PROVIDER_ID = 'gitee'
/** 平台名称 */
export const GITEE_LABEL = 'Gitee'
/** 网页域名 */
export const GITEE_HOSTS = new Set(['gitee.com', 'www.gitee.com'])
/** 默认网页地址前缀 */
export const GITEE_DEFAULT_HOST = 'gitee.com'
/** 默认 Open API 地址 */
export const GITEE_DEFAULT_API_BASE = 'https://gitee.com/api/v5'

const USER_AGENT = 'publish-apk'
const REQUEST_TIMEOUT_MS = 30_000
const TRANSFER_TIMEOUT_MS = 10 * 60_000
const MAX_REDIRECTS = 5
const PER_PAGE = 100
/** 这些状态说明附件列表接口不可用（不是普通 404「没有附件」） */
const ATTACH_UNAVAILABLE_STATUSES = new Set([402, 403, 404, 405, 422, 501])

const GITEE_TOKEN_ENVS = {
  source: ['GITEE_SOURCE_TOKEN', 'GITEE_TOKEN'],
  target: ['GITEE_TARGET_TOKEN', 'GITEE_TOKEN'],
}

const GITEE_API_BASE_ENVS = {
  source: ['GITEE_SOURCE_API_BASE', 'GITEE_API_BASE'],
  target: ['GITEE_TARGET_API_BASE', 'GITEE_API_BASE'],
}

/** Gitee API 业务错误；错误信息不含 access_token */
export class GiteeApiError extends Error {
  constructor(message, { status, method, path } = {}) {
    super(message)
    this.name = 'GiteeApiError'
    this.status = status
    this.method = method
    this.path = path
  }
}

/** 附件列表接口不可用（例如账号没有附件能力）；调用方按「没有附件」处理并标记 */
class GiteeAttachUnavailableError extends Error {
  constructor(message, { status } = {}) {
    super(message)
    this.name = 'GiteeAttachUnavailableError'
    this.status = status
  }
}

/** 404 在查发布 / 标签时是「还没有」 */
export function isGiteeNotFound(error) {
  return error instanceof GiteeApiError && error.status === 404
}

/** 从环境变量取第一个非空值 */
function firstEnv(env, names) {
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      return { value: value.trim(), name }
    }
  }
  return undefined
}

/** 解析 Gitee 令牌：--source-token / --target-token 由调用方优先处理 */
export function resolveGiteeToken(env, role) {
  const found = firstEnv(env, GITEE_TOKEN_ENVS[role] ?? GITEE_TOKEN_ENVS.source)
  if (found === undefined) {
    return undefined
  }
  return { token: found.value, source: found.name }
}

/** 规范化 API 地址：只接受 http(s)，不允许内嵌凭证、查询串或锚点 */
export function normalizeGiteeApiBase(value) {
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

/** 解析 Gitee API 地址：命令行 > 平台环境变量 > 默认值 */
export function resolveGiteeApiBase(env, role, override) {
  if (override !== undefined) {
    return normalizeGiteeApiBase(override)
  }
  const found = firstEnv(env, GITEE_API_BASE_ENVS[role] ?? GITEE_API_BASE_ENVS.source)
  return normalizeGiteeApiBase(found === undefined ? GITEE_DEFAULT_API_BASE : found.value)
}

/** 去掉 URL 的查询串（Gitee 的令牌在查询串里） */
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

/** 把 Gitee 错误响应整理成可读文本；Gitee 通常是 { message } */
function describeResponseError(response, data, text, method, url) {
  const message =
    typeof data?.message === 'string'
      ? data.message
      : typeof data?.error === 'string'
        ? data.error
        : text.trim().slice(0, 300)
  const suffix = message === '' ? '' : `: ${message}`
  const lines = [`${method} ${bareUrl(url)} 返回 ${response.status}${suffix}`]
  if (response.status === 401) {
    lines.push('提示: Gitee 访问令牌无效或已过期，请检查 GITEE_TOKEN / GITEE_SOURCE_TOKEN / GITEE_TARGET_TOKEN')
  } else if (response.status === 403) {
    lines.push('提示: Gitee 令牌缺少权限，或当前账号 / 套餐不允许该操作')
  } else if (response.status === 404) {
    lines.push('提示: Gitee 仓库、Release、Tag 或附件不存在，或令牌没有访问权限')
  } else if (response.status === 429) {
    lines.push('提示: Gitee 请求过于频繁，稍后重试')
  } else if (response.status >= 500) {
    lines.push('提示: Gitee 服务端错误，稍后重试')
  }
  return new GiteeApiError(lines.join('\n'), {
    status: response.status,
    method,
    path: bareUrl(url),
  })
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Gitee Release 对象判断 */
function isReleaseObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Gitee 返回的附件下载地址可能是相对路径，补成绝对地址 */
function absoluteAssetUrl(value) {
  if (typeof value !== 'string' || value === '') {
    return undefined
  }
  try {
    return new URL(value, 'https://gitee.com').toString()
  } catch {
    return value
  }
}

/** 附件列表接口是否因能力缺失而不可用 */
function isAttachUnavailableStatus(status) {
  return ATTACH_UNAVAILABLE_STATUSES.has(status)
}

/** Gitee Open API 客户端（只暴露同步需要的方法） */
class GiteeReleaseClient {
  constructor({
    repo,
    token,
    apiBase = GITEE_DEFAULT_API_BASE,
    fetchImpl = fetch,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    transferTimeoutMs = TRANSFER_TIMEOUT_MS,
  }) {
    if (typeof repo !== 'string' || repo === '') {
      throw new Error('GiteeReleaseClient 需要仓库路径')
    }
    if (typeof token !== 'string' || token === '') {
      throw new Error('GiteeReleaseClient 需要访问令牌')
    }
    const parts = repo.split('/')
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      throw new Error(`Gitee 仓库地址需要 owner/repo 两段，实际: ${repo}`)
    }
    this.owner = parts[0]
    this.repo = parts[1]
    this.token = token
    this.apiBase = normalizeGiteeApiBase(apiBase)
    this.fetchImpl = fetchImpl
    this.requestTimeoutMs = requestTimeoutMs
    this.transferTimeoutMs = transferTimeoutMs
  }

  /** 拼仓库 API 地址，并附上 access_token 查询参数 */
  apiUrl(suffix, params = {}) {
    const url = new URL(
      `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`,
    )
    url.searchParams.set('access_token', this.token)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  /** JSON 请求；body 为 undefined 时发 GET */
  async request(suffix, { method = 'GET', body, params, timeoutMs = this.requestTimeoutMs } = {}) {
    const url = this.apiUrl(suffix, params)
    const headers = {
      Accept: 'application/json',
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

  /** 分页读取列表接口，直到空页 */
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

  /** 读取发布附件；接口不可用时抛出 GiteeAttachUnavailableError */
  async getAttachFiles(releaseId) {
    try {
      const files = await this.listAll(
        `/releases/${encodeURIComponent(String(releaseId))}/attach_files`,
      )
      return files
        .filter((file) => file !== null && typeof file === 'object' && file.id !== undefined)
        .map((file) => ({
          ...file,
          release_id: releaseId,
          browser_download_url: absoluteAssetUrl(file.browser_download_url),
        }))
    } catch (error) {
      if (error instanceof GiteeApiError && isAttachUnavailableStatus(error.status)) {
        throw new GiteeAttachUnavailableError(error.message, { status: error.status })
      }
      throw error
    }
  }

  /** 读取附件；不可用时按「没有附件」处理，并在发布对象上留下标记 */
  async getAttachFilesSafe(releaseId) {
    try {
      return { files: await this.getAttachFiles(releaseId), unavailable: false }
    } catch (error) {
      if (error instanceof GiteeAttachUnavailableError) {
        return { files: [], unavailable: true }
      }
      throw error
    }
  }

  /** 取最新发布 ID（用于判断 by-tag 的发布是否最新）；失败不影响主体同步 */
  async getLatestIdSafe() {
    try {
      const latest = await this.request('/releases/latest')
      return isReleaseObject(latest) ? latest.id : undefined
    } catch {
      return undefined
    }
  }

  /** 把 Gitee 原始发布转成同步用的统一形状：附件只取 attach_files */
  async normalizeRelease(release, { latestId } = {}) {
    if (!isReleaseObject(release)) {
      return release
    }
    const { files, unavailable } = await this.getAttachFilesSafe(release.id)
    const normalized = {
      ...release,
      assets: files,
      ...(unavailable ? { asset_list_unavailable: true } : {}),
    }
    if (latestId !== undefined) {
      normalized.is_latest = String(latestId) === String(release.id)
    }
    return normalized
  }

  /** 按 Tag 查发布；Tag 带 / 且 404 时回退到发布列表 */
  async getReleaseByTag(tag) {
    let release = null
    try {
      release = await this.request(`/releases/tags/${encodeURIComponent(tag)}`)
    } catch (error) {
      if (!isGiteeNotFound(error)) {
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
      if (isGiteeNotFound(error)) {
        return null
      }
      throw error
    }
  }

  /** 按名字查 Tag：Gitee 没有按名查询接口，只能翻标签列表 */
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
      // 并发重跑时标签可能刚被创建；重新查询确认
      if (error instanceof GiteeApiError && [400, 403, 409, 422].includes(error.status)) {
        const raced = await this.getTag(tag)
        if (raced !== null) {
          return { created: false, tag: raced }
        }
      }
      throw error
    }
  }

  /** 创建发布；Gitee 要求 name / body / target_commitish */
  async createRelease(fields) {
    const payload = {
      tag_name: fields.tag_name,
      name: typeof fields.name === 'string' && fields.name !== '' ? fields.name : fields.tag_name,
      body: typeof fields.body === 'string' ? fields.body : '',
      target_commitish: fields.target_commitish,
    }
    if (fields.prerelease !== undefined) {
      payload.prerelease = fields.prerelease === true
    }
    let release = await this.request('/releases', { method: 'POST', body: payload })
    if (!isReleaseObject(release) || release.id === undefined || release.id === null) {
      // 201 但空 body / 缺少 id：按标签回查一次
      release = await this.getReleaseByTag(fields.tag_name)
    }
    if (!isReleaseObject(release) || release.id === undefined || release.id === null) {
      throw new Error(`创建 Gitee 发布 "${fields.tag_name}" 成功，但无法读取目标发布（缺少 id）；请重跑`)
    }
    return { ...release, assets: Array.isArray(release.assets) ? release.assets : [] }
  }

  /** 更新发布；Gitee PATCH 要求 tag_name / name / body，先读当前值再合并 */
  async updateRelease(releaseId, fields) {
    const current = await this.request(`/releases/${encodeURIComponent(String(releaseId))}`)
    if (!isReleaseObject(current)) {
      throw new Error('读取 Gitee 发布失败：响应数据无效')
    }
    const payload = {
      tag_name: current.tag_name,
      name: typeof fields.name === 'string' ? fields.name : current.name,
      body: typeof fields.body === 'string' ? fields.body : current.body,
    }
    if (fields.prerelease !== undefined) {
      payload.prerelease = fields.prerelease === true
    } else if (current.prerelease !== undefined) {
      payload.prerelease = current.prerelease === true
    }
    let updated = await this.request(`/releases/${encodeURIComponent(String(releaseId))}`, {
      method: 'PATCH',
      body: payload,
    })
    if (!isReleaseObject(updated)) {
      // PATCH 可能返回空 body；按提交的字段合并
      updated = {}
    }
    return {
      ...current,
      ...payload,
      ...updated,
      id: updated.id ?? current.id,
      // 响应里的 assets 可能是自动生成的源码包，不能当作同步附件
      assets: [],
    }
  }

  /** 删除附件；404 视为已经不存在 */
  async deleteAsset(releaseId, assetId) {
    try {
      return await this.request(
        `/releases/${encodeURIComponent(String(releaseId))}/attach_files/${encodeURIComponent(String(assetId))}`,
        { method: 'DELETE' },
      )
    } catch (error) {
      if (error instanceof GiteeApiError && error.status === 404) {
        return { alreadyDeleted: true }
      }
      throw error
    }
  }

  /** 下载 Gitee 发布附件到本地文件，校验大小 */
  async downloadAsset(asset, destPath) {
    const releaseId = asset?.release_id
    if (releaseId === undefined || asset?.id === undefined) {
      throw new Error(`下载附件 ${asset?.name ?? ''} 失败: 缺少 release_id / 附件 id`)
    }
    const url = this.apiUrl(
      `/releases/${encodeURIComponent(String(releaseId))}/attach_files/${encodeURIComponent(String(asset.id))}/download`,
    )
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/octet-stream',
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
        // 预签名下载地址不再带 access_token
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
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath))
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
    return { size }
  }

  /** 查询仓库默认分支；用于未显式给 --target-branch 时创建标签 */
  async getDefaultBranch() {
    const repo = await this.request('')
    return typeof repo?.default_branch === 'string' ? repo.default_branch : undefined
  }
}

/** Gitee 平台适配器 */
export const giteeReleaseProvider = {
  id: GITEE_PROVIDER_ID,
  label: GITEE_LABEL,
  hosts: GITEE_HOSTS,
  defaultHost: GITEE_DEFAULT_HOST,
  tokenEnvs: GITEE_TOKEN_ENVS,
  apiBaseEnvs: GITEE_API_BASE_ENVS,
  // 默认不再下载源产物再尝试上传：直接生成下载表格，避免大文件白下载
  assetUploadDirectToTable: true,
  // Gitee 没有 draft / make_latest 字段
  supportsDraft: false,
  supportsMakeLatest: false,
  resolveToken: resolveGiteeToken,
  resolveApiBase: resolveGiteeApiBase,
  createClient(options) {
    return new GiteeReleaseClient(options)
  },
}

/** 导出给测试直接构造客户端 */
export { GiteeReleaseClient }
