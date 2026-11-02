/**
 * release-sync：Gitee 源仓库 → CNB 目标仓库的端到端测试。
 *
 * 验证 Gitee 适配器的读取侧能力：
 *   - 只把 attach_files 当作发布附件，忽略 Gitee 自动生成的源码 zip/tar.gz；
 *   - 附件先经 Gitee download 接口下载（302 到对象存储时不带 access_token）；
 *   - Gitee 的 latest 信息映射到统一的 is_latest，CNB 目标据此设置 make_latest；
 *   - 目标标签仍按 CNB 默认 main 创建并创建发布。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const GITEE_TOKEN = 'gitee-source-token'
const CNB_TOKEN = 'cnb-target-token'
const GITEE_OWNER = 'gitee-owner'
const GITEE_REPO = 'gitee-src'
const CNB_REPO = 'cnb/dst'
const TAG = 'v1.0.0'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

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

async function startMock() {
  const state = {
    requests: [],
    uploads: [],
    confirmations: [],
    tagCreated: undefined,
    releaseCreated: undefined,
    base: '',
  }

  const giteeRelease = {
    id: 50,
    tag_name: TAG,
    name: 'Gitee 源发布',
    body: '## Gitee 源说明\n\n只有 Gitee 才有的说明。',
    prerelease: true,
    target_commitish: 'master',
    // Gitee 自动生成的源码包，不应被当成发布附件同步
    assets: [
      {
        name: `${TAG}.zip`,
        browser_download_url: `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/archive/refs/tags/${TAG}.zip`,
      },
    ],
  }
  const attachFiles = [
    {
      id: 77,
      name: 'app.apk',
      size: 5,
      browser_download_url: `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/releases/download/${TAG}/app.apk`,
    },
  ]

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const body = await readRequestBody(request)
      const record = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        authorization: request.headers.authorization,
        body,
      }
      state.requests.push(record)

      // ---------------- Gitee 源仓库 ----------------
      if (url.pathname.startsWith('/api/v5/repos/')) {
        if (url.searchParams.get('access_token') !== GITEE_TOKEN) {
          sendJson(response, 401, { message: 'token invalid' })
          return
        }
        const prefix = `/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}`
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/tags/${TAG}`) {
          sendJson(response, 200, giteeRelease)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/latest`) {
          sendJson(response, 200, giteeRelease)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/50/attach_files`) {
          const page = Number(url.searchParams.get('page') ?? '1')
          sendJson(response, 200, page === 1 ? attachFiles : [])
          return
        }
        if (
          request.method === 'GET' &&
          url.pathname === `${prefix}/releases/50/attach_files/77/download`
        ) {
          response.writeHead(302, { location: `${state.base}/storage/gitee/app.apk` })
          response.end()
          return
        }
      }
      if (request.method === 'GET' && url.pathname === '/storage/gitee/app.apk') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end('hello')
        return
      }

      // ---------------- CNB 目标仓库 ----------------
      if (url.pathname.startsWith(`/${CNB_REPO}/-/`)) {
        if (record.authorization !== `Bearer ${CNB_TOKEN}`) {
          sendJson(response, 401, { errcode: 16, errmsg: 'not logged in' })
          return
        }
        if (request.method === 'GET' && url.pathname === `/${CNB_REPO}/-/releases/tags/${TAG}`) {
          sendNotFound(response)
          return
        }
        if (request.method === 'GET' && url.pathname === `/${CNB_REPO}/-/git/tags/${TAG}`) {
          sendNotFound(response)
          return
        }
        if (request.method === 'POST' && url.pathname === `/${CNB_REPO}/-/git/tags`) {
          state.tagCreated = body
          sendJson(response, 201, { name: body.name, target: body.target })
          return
        }
        if (request.method === 'POST' && url.pathname === `/${CNB_REPO}/-/releases`) {
          state.releaseCreated = body
          sendJson(response, 201, { id: 'dst-1', ...body, assets: [] })
          return
        }
        if (
          request.method === 'POST' &&
          url.pathname === `/${CNB_REPO}/-/releases/dst-1/asset-upload-url`
        ) {
          sendJson(response, 201, {
            upload_url: `${state.base}/storage/cnb-upload/app.apk?signature=test`,
            verify_url: `${state.base}/${CNB_REPO}/-/releases/dst-1/asset-upload-confirmation/token/asset`,
            expires_in_sec: 600,
          })
          return
        }
      }
      if (request.method === 'PUT' && url.pathname === '/storage/cnb-upload/app.apk') {
        state.uploads.push(record)
        response.writeHead(200)
        response.end()
        return
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/${CNB_REPO}/-/releases/dst-1/asset-upload-confirmation/token/asset`
      ) {
        if (record.authorization !== `Bearer ${CNB_TOKEN}`) {
          sendJson(response, 401, { errcode: 16, errmsg: 'not logged in' })
          return
        }
        state.confirmations.push(record)
        sendJson(response, 200)
        return
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
        GITEE_TOKEN: '',
        GITEE_SOURCE_TOKEN: '',
        GITEE_TARGET_TOKEN: '',
        CNB_TOKEN: '',
        CNB_SOURCE_TOKEN: '',
        CNB_TARGET_TOKEN: '',
        RELEASE_SYNC_SOURCE_TOKEN: '',
        RELEASE_SYNC_TARGET_TOKEN: '',
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

{
  const mock = await startMock()
  try {
    const result = await runCli(
      [
        'release-sync',
        '--source',
        `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}`,
        '--target',
        `https://cnb.cool/${CNB_REPO}`,
        '--tag',
        TAG,
        '--source-api-base',
        `${mock.base}/api/v5`,
        '--target-api-base',
        mock.base,
      ],
      {
        GITEE_SOURCE_TOKEN: GITEE_TOKEN,
        CNB_TARGET_TOKEN: CNB_TOKEN,
      },
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^源发布: gitee\.com\/gitee-owner\/gitee-src@v1\.0\.0$/m)
    assert.match(result.stdout, /^目标发布: cnb\.cool\/cnb\/dst@v1\.0\.0（已创建）$/m)
    assert.match(result.stdout, /^附件: 1 个（已上传 1，跳过 0）$/m)

    // Gitee 自动生成的源码包没有被当作附件
    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].body.toString('utf8'), 'hello')
    assert.equal(mock.uploads[0].authorization, undefined)

    // 发布字段与 latest 映射
    assert.equal(mock.releaseCreated.name, 'Gitee 源发布')
    assert.equal(mock.releaseCreated.body, '## Gitee 源说明\n\n只有 Gitee 才有的说明。')
    assert.equal(mock.releaseCreated.prerelease, true)
    assert.equal(mock.releaseCreated.make_latest, 'true')
    assert.equal(mock.releaseCreated.target_commitish, 'main')

    // 标签仍按 CNB 默认 main 创建
    assert.deepEqual(mock.tagCreated, { name: TAG, target: 'main' })

    // Gitee 下载第一跳带 access_token，302 到对象存储后不带
    const giteeDownload = mock.requests.find(
      (item) =>
        item.path === `/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/50/attach_files/77/download`,
    )
    assert.equal(giteeDownload.query.access_token, GITEE_TOKEN)
    const storageDownload = mock.requests.find(
      (item) => item.path === '/storage/gitee/app.apk',
    )
    assert.equal(storageDownload.query.access_token, undefined)
    assert.equal(storageDownload.authorization, undefined)

    // CNB 目标确认上传
    assert.equal(mock.confirmations.length, 1)
    assert.equal(mock.confirmations[0].authorization, `Bearer ${CNB_TOKEN}`)
    assert.equal(mock.releaseCreated.assets, undefined)
  } finally {
    await mock.close()
  }
}

console.log('release-sync: Gitee 源 → CNB 目标测试通过')
