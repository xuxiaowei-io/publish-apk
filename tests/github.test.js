/**
 * GitHub Actions 密钥客户端测试：`node tests/github.test.js`。
 *
 * 用注入的 fetchImpl 模拟 GitHub REST API，验证：
 *   - 仓库密钥 / 环境密钥的 URL、鉴权头、key_id 与 encrypted_value 结构；
 *   - 403/404 的错误提示与「已写入 N/M」；
 *   - 名字、48 KB 上限等本地预检不会发起请求。
 *
 * 加密值本身的可解密性由 tests/sealed-box.test.js 的固定向量保证。
 */
import assert from 'node:assert/strict'

import {
  GITHUB_SECRET_MAX_BYTES,
  resolveGithubApiUrl,
  resolveGithubRepo,
  resolveGithubToken,
  setGithubSecrets,
} from '../src/github.js'
import { SEALED_BOX_OVERHEAD } from '../src/sealed-box.js'

/** 与 sealed-box.test.js 相同的测试公钥 */
const PUBLIC_KEY = 'tFbnfU3vKWop2qTR+AvJrp9Zv9pre5zFWmUmpeNbCyA='
const API_URL = 'https://api.github.com'

/** 构造一个 fetch 响应桩 */
function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === undefined ? '' : JSON.stringify(payload)
    },
  }
}

/** 记录请求的 fetch 桩；publicKey 与 putStatus 可按需覆盖 */
function createFetchRecorder({ publicKey = { key_id: 'key-1', key: PUBLIC_KEY }, putStatus = 201, failAt = 0 } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    }
    calls.push(call)
    if (url.endsWith('/public-key')) {
      return jsonResponse(200, publicKey)
    }
    if (failAt !== 0 && calls.filter((item) => item.method === 'PUT').length === failAt) {
      return jsonResponse(403, { message: 'Resource not accessible by integration' })
    }
    return jsonResponse(putStatus, {})
  }
  return { calls, fetchImpl }
}

const BASE_OPTIONS = { repo: 'owner/repo', token: 'test-token', apiUrl: API_URL }

// 1) 仓库密钥：URL / 方法 / 鉴权 / key_id / 加密长度
{
  const variables = [
    ['HARMONY_KEY_ALIAS', 'release'],
    ['HARMONY_SIGN_ALG', 'SHA256withECDSA'],
  ]
  const { calls, fetchImpl } = createFetchRecorder()
  const written = await setGithubSecrets(variables, { ...BASE_OPTIONS, fetchImpl })
  assert.deepEqual(written, ['HARMONY_KEY_ALIAS', 'HARMONY_SIGN_ALG'])
  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, `${API_URL}/repos/owner/repo/actions/secrets/public-key`)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token')
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json')
  assert.equal(calls[0].headers['User-Agent'], 'publish-apk')
  for (const [index, [name, value]] of variables.entries()) {
    const call = calls[index + 1]
    assert.equal(call.url, `${API_URL}/repos/owner/repo/actions/secrets/${name}`)
    assert.equal(call.method, 'PUT')
    assert.equal(call.headers.Authorization, 'Bearer test-token')
    assert.equal(call.headers['Content-Type'], 'application/json')
    assert.equal(call.body.key_id, 'key-1')
    assert.deepEqual(Object.keys(call.body).sort(), ['encrypted_value', 'key_id'])
    assert.equal(
      Buffer.from(call.body.encrypted_value, 'base64').length,
      Buffer.byteLength(value, 'utf8') + SEALED_BOX_OVERHEAD,
    )
  }
}

// 2) 环境密钥：URL 带 environments/<环境>
{
  const { calls, fetchImpl } = createFetchRecorder()
  const written = await setGithubSecrets([['HARMONY_KEY_ALIAS', 'release']], {
    ...BASE_OPTIONS,
    environment: 'production',
    fetchImpl,
  })
  assert.deepEqual(written, ['HARMONY_KEY_ALIAS'])
  assert.equal(
    calls[0].url,
    `${API_URL}/repos/owner/repo/environments/production/secrets/public-key`,
  )
  assert.equal(
    calls[1].url,
    `${API_URL}/repos/owner/repo/environments/production/secrets/HARMONY_KEY_ALIAS`,
  )
}

// 3) 中途 403：带权限提示与「已成功写入 N/M」，且不回显密钥值
{
  const { fetchImpl } = createFetchRecorder({ failAt: 2 })
  await assert.rejects(
    () =>
      setGithubSecrets(
        [
          ['HARMONY_STORE_PASSWORD', 'top-secret-value'],
          ['HARMONY_KEY_PASSWORD', 'top-secret-value'],
        ],
        { ...BASE_OPTIONS, fetchImpl },
      ),
    (error) => {
      assert.match(error.message, /403/)
      assert.match(error.message, /Secrets 写权限/)
      assert.match(error.message, /已成功写入 1\/2 个/)
      assert.ok(!error.message.includes('top-secret-value'))
      return true
    },
  )
}

// 4) 401 / 404 的提示
{
  await assert.rejects(
    () =>
      setGithubSecrets([['HARMONY_KEY_ALIAS', 'release']], {
        ...BASE_OPTIONS,
        fetchImpl: async () => jsonResponse(401, { message: 'Bad credentials' }),
      }),
    /GITHUB_TOKEN 无效或已过期/,
  )

  await assert.rejects(
    () =>
      setGithubSecrets([['HARMONY_KEY_ALIAS', 'release']], {
        ...BASE_OPTIONS,
        environment: 'production',
        fetchImpl: async () => jsonResponse(404, { message: 'Not Found' }),
      }),
    /GitHub Environment 不存在/,
  )
}

// 5) 本地预检：超过 48 KB、非法名字、非法仓库都不发请求
{
  const { calls, fetchImpl } = createFetchRecorder()
  await assert.rejects(
    () =>
      setGithubSecrets([['HARMONY_KEY_ALIAS', 'x'.repeat(GITHUB_SECRET_MAX_BYTES)]], {
        ...BASE_OPTIONS,
        fetchImpl,
      }),
    /超过 GitHub 单个密钥上限/,
  )
  assert.equal(calls.length, 0)

  await assert.rejects(
    () => setGithubSecrets([['bad-name', 'x']], { ...BASE_OPTIONS, fetchImpl }),
    /密钥名不合法/,
  )
  assert.equal(calls.length, 0)

  await assert.rejects(
    () => setGithubSecrets([], { ...BASE_OPTIONS, repo: 'owner/repo/extra', fetchImpl }),
    /owner\/repo/,
  )
}

// 6) 仓库 / token / API 地址解析
{
  assert.deepEqual(resolveGithubRepo('owner/repo', {}), {
    owner: 'owner',
    repo: 'repo',
    full: 'owner/repo',
  })
  assert.deepEqual(resolveGithubRepo(undefined, { GITHUB_REPOSITORY: 'env-owner/env-repo' }), {
    owner: 'env-owner',
    repo: 'env-repo',
    full: 'env-owner/env-repo',
  })
  assert.throws(() => resolveGithubRepo('owner/repo/extra', {}), /owner\/repo/)
  assert.throws(() => resolveGithubToken({}), /未设置 GITHUB_TOKEN/)
  assert.equal(resolveGithubToken({ GITHUB_TOKEN: '  token  ' }), 'token')
  assert.equal(resolveGithubApiUrl({}), 'https://api.github.com')
  assert.equal(
    resolveGithubApiUrl({ GITHUB_API_URL: 'https://ghe.example.com/api/v3/' }),
    'https://ghe.example.com/api/v3',
  )
}

console.log('github: REST API 客户端测试通过')
