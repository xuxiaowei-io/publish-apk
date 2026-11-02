/**
 * release-sync 的 Gitee 适配器端到端测试：`node tests/release-sync-gitee.test.js`。
 *
 * 覆盖需求：目标是 Gitee、源有产物时，不下载 / 不上传附件，
 * 直接在 Gitee 发布说明中生成 Markdown 下载表格（重复执行不重复追加）。
 *
 * 同时验证：
 *   - Gitee 默认分支探测（master/main）用于目标标签创建；
 *   - Gitee 目标不走附件下载 / 上传，直接生成表格；
 *   - 表格里的下载地址来自源发布，且不携带任何 access_token；
 *   - 第二次同步会删旧表格再生成，保持幂等。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { appendAssetTable } from '../src/release-sync.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const CNB_SOURCE_TOKEN = 'cnb-source-token'
const GITEE_TARGET_TOKEN = 'gitee-target-token'
const SOURCE_REPO = 'org/src'
const TARGET_OWNER = 'xuxiaowei'
const TARGET_REPO = 'gitee-target'
const TAG = 'v1.0.0'

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

const json = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() {
    return payload === undefined ? '' : JSON.stringify(payload)
  },
})

function readRequestBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const buffer = Buffer.concat(chunks)
      if (buffer.length === 0) {
        resolve(undefined)
        return
      }
      const type = String(request.headers['content-type'] ?? '')
      if (type.includes('application/json')) {
        try {
          resolve(JSON.parse(buffer.toString('utf8')))
          return
        } catch {
          // 保留原始 body
        }
      }
      resolve(buffer)
    })
  })
}

function sendJson(response, status, payload) {
  const text = payload === undefined ? '' : JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function sendNotFound(response) {
  sendJson(response, 404, { message: 'Not Found' })
}

/**
 * 模拟：CNB 源仓库 + Gitee 目标仓库。
 *
 * Gitee 目标应直接生成 Markdown 表格，不应发起源附件下载或 Gitee 附件上传。
 */
async function startMock({ initialBody } = {}) {
  const state = {
    requests: [],
    targetTag: initialBody === undefined ? null : { name: TAG, commit: { sha: 'old' } },
    targetRelease:
      initialBody === undefined
        ? null
        : {
            id: 100,
            tag_name: TAG,
            name: `${TAG} CNB 发布`,
            body: initialBody,
            prerelease: false,
            assets: [],
          },
    tagCreated: undefined,
    releaseCreated: undefined,
    releasePatched: [],
    attachUploads: [],
    defaultBranchRequested: false,
    base: '',
  }

  const sourceRelease = () => ({
    id: 'cnb-release-1',
    tag_name: TAG,
    name: `${TAG} CNB 发布`,
    body: '## 源发布说明\n\n来自 CNB 的说明。',
    draft: false,
    prerelease: false,
    is_latest: false,
    assets: [
      {
        id: 'cnb-asset-1',
        name: 'app.apk',
        size: 5,
        url: `${state.base}/${SOURCE_REPO}/-/releases/download/${TAG}/app.apk`,
        browser_download_url: `https://cnb.cool/${SOURCE_REPO}/-/releases/download/${TAG}/app.apk`,
        content_type: 'application/vnd.android.package-archive',
        hash_algo: 'sha256',
        hash_value: sha256('hello'),
      },
    ],
  })

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const body = await readRequestBody(request)
      const record = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body,
      }
      state.requests.push(record)

      // ---------------- CNB 源仓库 ----------------
      if (url.pathname.startsWith(`/${SOURCE_REPO}/-/`)) {
        if (record.authorization !== `Bearer ${CNB_SOURCE_TOKEN}`) {
          sendJson(response, 401, { errcode: 16, errmsg: 'not logged in' })
          return
        }
        if (request.method === 'GET' && url.pathname === `/${SOURCE_REPO}/-/releases/tags/${TAG}`) {
          sendJson(response, 200, sourceRelease())
          return
        }
        if (
          request.method === 'GET' &&
          url.pathname === `/${SOURCE_REPO}/-/releases/download/${TAG}/app.apk`
        ) {
          response.writeHead(302, { location: `${state.base}/storage/source/app.apk` })
          response.end()
          return
        }
      }
      if (request.method === 'GET' && url.pathname === '/storage/source/app.apk') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end('hello')
        return
      }

      // ---------------- Gitee 目标仓库 ----------------
      if (url.pathname.startsWith('/api/v5/repos/')) {
        if (url.searchParams.get('access_token') !== GITEE_TARGET_TOKEN) {
          sendJson(response, 401, { message: 'token invalid' })
          return
        }
        const prefix = `/api/v5/repos/${TARGET_OWNER}/${TARGET_REPO}`

        if (request.method === 'GET' && url.pathname === prefix) {
          state.defaultBranchRequested = true
          sendJson(response, 200, { default_branch: 'master' })
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/tags`) {
          const page = Number(url.searchParams.get('page') ?? '1')
          sendJson(response, 200, page === 1 && state.targetTag !== null ? [state.targetTag] : [])
          return
        }
        if (request.method === 'POST' && url.pathname === `${prefix}/tags`) {
          state.tagCreated = body
          state.targetTag = { name: body.tag_name, commit: { sha: 'abc' } }
          sendJson(response, 201, state.targetTag)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/latest`) {
          if (state.targetRelease === null) {
            sendNotFound(response)
            return
          }
          sendJson(response, 200, state.targetRelease)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/tags/${TAG}`) {
          if (state.targetRelease === null) {
            sendNotFound(response)
            return
          }
          sendJson(response, 200, state.targetRelease)
          return
        }
        if (request.method === 'POST' && url.pathname === `${prefix}/releases`) {
          state.releaseCreated = body
          state.targetRelease = {
            id: 100,
            tag_name: body.tag_name,
            name: body.name,
            body: body.body,
            target_commitish: body.target_commitish,
            prerelease: body.prerelease === true,
            assets: [
              {
                name: `${body.tag_name}.zip`,
                browser_download_url: `https://gitee.com/${TARGET_OWNER}/${TARGET_REPO}/archive/refs/tags/${body.tag_name}.zip`,
              },
            ],
          }
          sendJson(response, 201, state.targetRelease)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/100`) {
          sendJson(response, 200, state.targetRelease)
          return
        }
        if (request.method === 'PATCH' && url.pathname === `${prefix}/releases/100`) {
          state.releasePatched.push(body)
          state.targetRelease = { ...state.targetRelease, ...body }
          sendJson(response, 200, state.targetRelease)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/100/attach_files`) {
          sendJson(response, 200, [])
          return
        }
        if (request.method === 'POST' && url.pathname === `${prefix}/releases/100/attach_files`) {
          // 直接表格模式下不应走到这里；记录后返回 403 便于断言
          state.attachUploads.push(record)
          sendJson(response, 403, { message: '当前账号不支持上传发布附件' })
          return
        }
        if (request.method === 'DELETE' && url.pathname.startsWith(`${prefix}/releases/100/attach_files/`)) {
          response.writeHead(204)
          response.end()
          return
        }
      }

      sendNotFound(response)
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { message: 'mock error' })
      } else {
        response.end()
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.base = `http://127.0.0.1:${server.address().port}`
  state.close = async () => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    }
    await new Promise((resolve) => server.close(resolve))
  }
  return state
}

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CNB_TOKEN: '',
        CNB_SOURCE_TOKEN: '',
        CNB_TARGET_TOKEN: '',
        CNB_SOURCE_API_BASE: '',
        CNB_TARGET_API_BASE: '',
        CNB_API_BASE: '',
        GITEE_TOKEN: '',
        GITEE_SOURCE_TOKEN: '',
        GITEE_TARGET_TOKEN: '',
        GITEE_SOURCE_API_BASE: '',
        GITEE_TARGET_API_BASE: '',
        GITEE_API_BASE: '',
        RELEASE_SYNC_SOURCE: '',
        RELEASE_SYNC_TARGET: '',
        RELEASE_SYNC_TAG: '',
        RELEASE_SYNC_TARGET_BRANCH: '',
        RELEASE_SYNC_SOURCE_TOKEN: '',
        RELEASE_SYNC_TARGET_TOKEN: '',
        RELEASE_SYNC_SOURCE_API_BASE: '',
        RELEASE_SYNC_TARGET_API_BASE: '',
        RELEASE_SYNC_VERBOSE: '',
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const ARGS = (base) => [
  'release-sync',
  '--source',
  `https://cnb.cool/${SOURCE_REPO}`,
  '--target',
  `https://gitee.com/${TARGET_OWNER}/${TARGET_REPO}`,
  '--tag',
  TAG,
  '--source-api-base',
  base,
  '--target-api-base',
  `${base}/api/v5`,
]

const TOKENS = {
  CNB_SOURCE_TOKEN: CNB_SOURCE_TOKEN,
  GITEE_TARGET_TOKEN: GITEE_TARGET_TOKEN,
}

// 1) Gitee 目标：不下载、不上传，直接生成 Markdown 下载表格
{
  const mock = await startMock()
  try {
    const dry = await runCli([...ARGS(mock.base), '--dry-run'], TOKENS)
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout, /目标平台将生成 Markdown 下载表格/)
    assert.equal(mock.tagCreated, undefined)
    assert.equal(mock.releaseCreated, undefined)
    assert.equal(
      mock.requests.filter((item) => item.path.includes('/releases/download/')).length,
      0,
    )

    const result = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /跳过附件下载/)
    assert.match(result.stdout, /目标平台使用 Markdown 下载表格/)
    assert.match(result.stdout, /app\.apk（5 B，下载地址见发布说明）/)

    // 目标标签基于 Gitee 仓库默认分支 master 创建
    assert.deepEqual(mock.tagCreated, { refs: 'master', tag_name: TAG })
    assert.equal(mock.releaseCreated.tag_name, TAG)
    assert.equal(mock.releaseCreated.target_commitish, 'master')
    assert.equal(mock.releaseCreated.name, `${TAG} CNB 发布`)

    // 没有下载源附件，也没有尝试上传
    assert.equal(mock.attachUploads.length, 0)
    assert.equal(
      mock.requests.filter((item) => item.path.includes('/releases/download/')).length,
      0,
    )
    assert.equal(mock.requests.filter((item) => item.path.startsWith('/storage/')).length, 0)

    // 创建发布时 body 已经是「源说明 + 下载表格」，不需要后续 PATCH
    assert.equal(mock.releasePatched.length, 0)
    const tableBody = mock.releaseCreated.body
    assert.match(tableBody, /^## 源发布说明/)
    assert.match(tableBody, /<!-- release-sync:assets:start -->/)
    assert.match(tableBody, /## 发布产物/)
    assert.match(tableBody, /\| app\.apk \| 5 B \| `[0-9a-f]{64}` \| \[下载\]/)
    assert.match(
      tableBody,
      /https:\/\/cnb\.cool\/org\/src\/-\/releases\/download\/v1\.0\.0\/app\.apk/,
    )
    assert.ok(!tableBody.includes('access_token'))

    // 2) 再跑一次：字段与表格都没变化，不重复追加
    const second = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /^目标发布: .*（已存在，无需更新）$/m)
    assert.equal(mock.releasePatched.length, 0)
    const latestBody = mock.targetRelease.body
    assert.equal(
      (latestBody.match(/<!-- release-sync:assets:start -->/g) ?? []).length,
      1,
    )
    assert.equal((latestBody.match(/<!-- release-sync:assets:end -->/g) ?? []).length, 1)
    assert.equal((latestBody.match(/\| app\.apk \|/g) ?? []).length, 1)
  } finally {
    await mock.close()
  }
}

// 2) 目标发布已存在但 body 没有表格：PATCH 成「源说明 + 表格」，不下载附件
{
  const mock = await startMock({ initialBody: '旧的发布说明' })
  try {
    const result = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(mock.releasePatched.length, 1)
    assert.match(mock.releasePatched[0].body, /^## 源发布说明/)
    assert.match(mock.releasePatched[0].body, /<!-- release-sync:assets:start -->/)
    assert.match(result.stdout, /目标平台使用 Markdown 下载表格/)
    assert.equal(
      mock.requests.filter((item) => item.path.includes('/releases/download/')).length,
      0,
    )
    assert.equal(mock.requests.filter((item) => item.path.startsWith('/storage/')).length, 0)
    assert.equal(mock.attachUploads.length, 0)
  } finally {
    await mock.close()
  }
}

// 3) appendAssetTable 纯函数：无附件时清掉旧表格，重复追加不重复
// 3) appendAssetTable 纯函数：无附件时清掉旧表格，重复追加不重复
{
  const assets = [
    {
      name: 'a|b.apk',
      size: 5,
      browser_download_url: 'https://example.com/a.apk?access_token=secret',
      hash_algo: 'sha256',
      hash_value: sha256('hello'),
    },
  ]
  const once = appendAssetTable('说明', assets, { sourceLabel: 'cnb.cool/org/src' })
  assert.match(once, /说明\n\n<!-- release-sync:assets:start -->/)
  assert.match(once, /a\\\|b\.apk/)
  assert.match(once, /https:\/\/example\.com\/a\.apk/)
  assert.ok(!once.includes('access_token'))
  const twice = appendAssetTable(once, assets, { sourceLabel: 'cnb.cool/org/src' })
  assert.equal((twice.match(/<!-- release-sync:assets:start -->/g) ?? []).length, 1)
  assert.equal(appendAssetTable(twice, []), '说明')
}

console.log('release-sync: Gitee 目标下载表格测试通过')
