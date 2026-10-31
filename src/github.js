/**
 * GitHub Actions 密钥写入：直接调用 GitHub REST API，不依赖 gh CLI。
 *
 * 鉴权与地址全部来自环境变量：
 *   - GITHUB_TOKEN：必填；需要目标仓库的 Secrets 写权限
 *     （fine-grained: Secrets 读写；classic: repo 权限）。
 *     注意：GitHub Actions 自动注入的 GITHUB_TOKEN 通常没有 Secrets 写权限，
 *     CI 里请把有权限的 PAT 存成 Secret，再以 GITHUB_TOKEN 传给本命令。
 *   - GITHUB_REPOSITORY：可选；Actions 自动注入的 owner/repo，未给 --github-repo 时用它。
 *   - GITHUB_API_URL：可选；默认 https://api.github.com，GitHub Enterprise 填 .../api/v3。
 *
 * 写入前的值必须用 libsodium sealed box 加密（见 src/sealed-box.js），
 * 这里只负责取公钥、加密、PUT，并且错误信息只带密钥名，不回显值。
 */
import { spawnSync } from 'node:child_process'

import { SEALED_BOX_OVERHEAD, sealBox } from './sealed-box.js'

/** GitHub 单个密钥的上限：48 KB（按 REST API 的 encrypted_value 计） */
export const GITHUB_SECRET_MAX_BYTES = 48 * 1024

const DEFAULT_API_URL = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 30_000
const USER_AGENT = 'publish-apk'
/** GitHub 密钥名的合法格式 */
const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 把 `owner/repo` 拆成两段。
 *
 * 只接受两段：GitHub Enterprise 的 API 地址由 GITHUB_API_URL 决定，不混在仓库名里，
 * 避免 `host/owner/repo` 与 `owner/repo` 两种写法在 URL 拼接时产生歧义。
 */
function parseRepository(value, label) {
  const text = String(value).trim()
  const parts = text.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`${label} 需要 owner/repo 形式，实际: ${text}`)
  }
  return { owner: parts[0], repo: parts[1], full: `${parts[0]}/${parts[1]}` }
}

/** 从 git remote get-url origin 读取仓库地址；读不到时返回 undefined */
function readGitRemoteUrl() {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.error || result.status !== 0) {
    return undefined
  }
  const url = result.stdout.trim()
  return url === '' ? undefined : url
}

/**
 * 从常见的 git remote 写法里解析 owner/repo：
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   ssh://git@host:2222/owner/repo.git
 * 解析不了时返回 undefined，由调用方给出统一的提示。
 */
function parseRemoteUrl(value) {
  const text = value.trim()
  const scp = /^[^@\s/]+@[^:\s/]+:([^/\s]+)\/([^/\s]+)$/.exec(text)
  if (scp !== null) {
    const repo = scp[2].replace(/\.git$/, '')
    return repo === '' ? undefined : { owner: scp[1], repo, full: `${scp[1]}/${repo}` }
  }
  try {
    const url = new URL(text)
    const parts = url.pathname.split('/').filter((part) => part !== '')
    if (parts.length >= 2) {
      const repo = parts[parts.length - 1].replace(/\.git$/, '')
      const owner = parts[parts.length - 2]
      if (repo !== '' && owner !== '') {
        return { owner, repo, full: `${owner}/${repo}` }
      }
    }
  } catch {
    // 不是 URL，继续按 owner/repo 试一次
  }
  const plain = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(text)
  if (plain !== null) {
    return { owner: plain[1], repo: plain[2], full: `${plain[1]}/${plain[2]}` }
  }
  return undefined
}

/**
 * 解析目标仓库，优先级：--github-repo > GITHUB_REPOSITORY > 当前 git remote。
 *
 * @param {string|undefined} repo 命令行 --github-repo
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {{ owner: string, repo: string, full: string }}
 */
export function resolveGithubRepo(repo, env) {
  if (repo !== undefined) {
    return parseRepository(repo, '--github-repo')
  }
  const fromEnv = env.GITHUB_REPOSITORY
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return parseRepository(fromEnv, 'GITHUB_REPOSITORY')
  }
  const remote = readGitRemoteUrl()
  const parsed = remote === undefined ? undefined : parseRemoteUrl(remote)
  if (parsed === undefined) {
    throw new Error(
      '无法确定 GitHub 仓库：请用 --github-repo owner/repo 指定，或设置 GITHUB_REPOSITORY，或在带 origin 的 git 仓库里运行',
    )
  }
  return parsed
}

/** 读取 GITHUB_TOKEN；没有 token 时在本地直接失败，不发起请求 */
export function resolveGithubToken(env) {
  const value = env.GITHUB_TOKEN
  if (value === undefined || value.trim() === '') {
    throw new Error(
      '未设置 GITHUB_TOKEN；请用环境变量提供（需要仓库 Secrets 写权限：fine-grained 的 Secrets 读写，classic 的 repo）',
    )
  }
  return value.trim()
}

/** 读取 API 地址：GITHUB_API_URL（Actions / GHES）或 https://api.github.com */
export function resolveGithubApiUrl(env) {
  const value = env.GITHUB_API_URL
  const url = value === undefined || value.trim() === '' ? DEFAULT_API_URL : value.trim()
  return url.replace(/\/+$/, '')
}

/** 组装仓库密钥 / 环境密钥的 REST 路径 */
function secretsPath(owner, repo, environment) {
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  if (environment === undefined) {
    return `${prefix}/actions/secrets`
  }
  return `${prefix}/environments/${encodeURIComponent(environment)}/secrets`
}

/** 把 API 的失败响应整理成可读错误；只带状态、message 与权限提示，绝不带密钥值 */
function describeApiError(response, data, text) {
  const message = typeof data?.message === 'string' ? data.message : text.trim().slice(0, 300)
  const lines = [`GitHub API 返回 ${response.status}${message === '' ? '' : `: ${message}`}`]
  if (response.status === 401) {
    lines.push('提示: GITHUB_TOKEN 无效或已过期')
  } else if (response.status === 403) {
    lines.push(
      '提示: GITHUB_TOKEN 需要仓库的 Secrets 写权限（fine-grained: Secrets 读写；classic: repo）',
    )
  } else if (response.status === 404) {
    lines.push('提示: 仓库或 GitHub Environment 不存在，或 GITHUB_TOKEN 没有访问权限')
  }
  return lines.join('\n')
}

/** 发一次 GitHub API 请求，返回解析后的 JSON（204 时返回 undefined） */
async function githubRequest(url, { token, method = 'GET', body, fetchImpl }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '请求超时（30 秒）' : error?.message
    throw new Error(`请求 GitHub API 失败: ${reason}`)
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
    throw new Error(describeApiError(response, data, text))
  }
  return data
}

/** 取当前作用域的 Actions 公钥；仓库密钥与环境密钥使用不同端点 */
async function fetchPublicKey(path, options) {
  const data = await githubRequest(`${options.apiUrl}${path}/public-key`, options)
  if (typeof data?.key_id !== 'string' || typeof data?.key !== 'string') {
    throw new Error('GitHub 公钥响应缺少 key_id / key')
  }
  const key = Buffer.from(data.key, 'base64')
  if (key.length !== 32) {
    throw new Error(`GitHub 公钥应为 32 字节，实际 ${key.length} 字节`)
  }
  return { keyId: data.key_id, key }
}

/**
 * 把 [变量名, 值] 逐条写成 GitHub Actions 密钥，返回成功写入的变量名。
 *
 * @param {[string, string][]} variables 变量名与值（顺序即写入顺序）
 * @param {{ repo: string, environment?: string, token: string, apiUrl: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string[]>} 已写入的变量名
 */
export async function setGithubSecrets(variables, options) {
  const { owner, repo } = parseRepository(options.repo, '--github-repo')
  const fetchImpl = options.fetchImpl ?? fetch

  // 先在本地检查名字与大小：GitHub 的 48 KB 上限针对加密后的 encrypted_value，
  // 提前算出 base64 长度，避免写到一半才发现某个值放不下。
  for (const [name, value] of variables) {
    if (!SECRET_NAME_PATTERN.test(name)) {
      throw new Error(`GitHub 密钥名不合法: ${name}（只允许字母、数字、下划线，且不能以数字开头）`)
    }
    const bytes = Buffer.byteLength(String(value), 'utf8')
    const encodedLength = Math.ceil((bytes + SEALED_BOX_OVERHEAD) / 3) * 4
    if (encodedLength > GITHUB_SECRET_MAX_BYTES) {
      throw new Error(
        `${name} 加密后约 ${encodedLength} 字节，超过 GitHub 单个密钥上限 ${GITHUB_SECRET_MAX_BYTES / 1024} KB`,
      )
    }
  }

  const path = secretsPath(owner, repo, options.environment)
  const { keyId, key } = await fetchPublicKey(path, { ...options, fetchImpl })

  // 先全部加密再写入：加密阶段失败不会留下半套密钥
  const payloads = variables.map(([name, value]) => ({
    name,
    encryptedValue: sealBox(String(value), key).toString('base64'),
  }))

  const written = []
  try {
    for (const { name, encryptedValue } of payloads) {
      await githubRequest(`${options.apiUrl}${path}/${encodeURIComponent(name)}`, {
        token: options.token,
        apiUrl: options.apiUrl,
        fetchImpl,
        method: 'PUT',
        body: { encrypted_value: encryptedValue, key_id: keyId },
      })
      written.push(name)
    }
  } catch (error) {
    if (written.length > 0) {
      error.message = `${error.message}\n已成功写入 ${written.length}/${variables.length} 个，重跑会覆盖同名密钥`
    }
    throw error
  }
  return written
}
