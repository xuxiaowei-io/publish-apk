/**
 * release-sync：GitHub 源 → CNB 目标端到端测试。
 *
 * 覆盖：
 *   - GitHub Release 按 Tag / latest 查询；
 *   - GitHub 附件列表与 digest → 统一 hash 字段；
 *   - GitHub 附件下载（302 到对象存储时不带令牌）；
 *   - 下载后上传到 CNB 目标，并同步 latest / prerelease。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const GITHUB_TOKEN = 'github-source-token'
const CNB_TOKEN = 'cnb-target-token'
const GITHUB_OWNER = 'gh'
const GITHUB_REPO = 'src'
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
    tagCreated: undefined,
    releaseCreated: undefined,
    uploads: [],
    confirmations: [],
    base: '',
  }

  const release = {
    id: 50,
    tag_name: TAG,
    name: 'GitHub 源发布',
    body: '## GitHub 源说明',
    draft: false,
    prerelease: true,
  }
  const asset = {
    id: 77,
    name: 'app.apk',
    size: 5,
    content_type: 'application/vnd.android.package-archive',
    digest: `sha256:${sha256('hello')}`,
    url: null,
    browser_download_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${TAG}/app.apk`,
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const body = await readRequestBody(request)
      const record = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        authorization: request.headers.authorization,
        accept: request.headers.accept,
        contentType: request.headers['content-type'],
        body,
      }
      state.requests.push(record)

      // ---------------- GitHub 源仓库 ----------------
      if (url.pathname.startsWith(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}`)) {
        if (record.authorization !== `Bearer ${GITHUB_TOKEN}`) {
          sendJson(response, 401, { message: 'Bad credentials' })
          return
        }
        const prefix = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/tags/${TAG}`) {
          sendJson(response, 200, release)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/latest`) {
          sendJson(response, 200, release)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/50/assets`) {
          const page = Number(url.searchParams.get('page') ?? '1')
          sendJson(
            response,
            200,
            page === 1
              ? [
                  {
                    ...asset,
                    url: `${state.base}${prefix}/releases/assets/77`,
                  },
                ]
              : [],
          )
          return
        }
        if (
          request.method === 'GET' &&
          url.pathname === `${prefix}/releases/assets/77`
        ) {
          if (record.accept !== 'application/octet-stream') {
            sendJson(response, 415, { message: 'Accept must be application/octet-stream' })
            return
          }
          response.writeHead(302, { location: `${state.base}/storage/github/app.apk` })
          response.end()
          return
        }
      }
      if (request.method === 'GET' && url.pathname === '/storage/github/app.apk') {
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
        GITHUB_TOKEN: '',
        GITHUB_SOURCE_TOKEN: '',
        GITHUB_TARGET_TOKEN: '',
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
        `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
        '--target',
        `https://cnb.cool/${CNB_REPO}`,
        '--tag',
        TAG,
        '--source-api-base',
        mock.base,
        '--target-api-base',
        mock.base,
      ],
      {
        GITHUB_SOURCE_TOKEN: GITHUB_TOKEN,
        CNB_TARGET_TOKEN: CNB_TOKEN,
      },
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^源发布: github\.com\/gh\/src@v1\.0\.0$/m)
    assert.match(result.stdout, /^目标发布: cnb\.cool\/cnb\/dst@v1\.0\.0（已创建）$/m)
    assert.match(result.stdout, /^附件: 1 个（已上传 1，跳过 0）$/m)

    assert.equal(mock.releaseCreated.name, 'GitHub 源发布')
    assert.equal(mock.releaseCreated.body, '## GitHub 源说明')
    assert.equal(mock.releaseCreated.prerelease, true)
    assert.equal(mock.releaseCreated.make_latest, 'true')
    assert.deepEqual(mock.tagCreated, { name: TAG, target: 'main' })

    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].body.toString('utf8'), 'hello')
    assert.equal(mock.uploads[0].authorization, undefined)

    const download = mock.requests.find(
      (item) => item.path === `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/assets/77`,
    )
    assert.equal(download.authorization, `Bearer ${GITHUB_TOKEN}`)
    assert.equal(download.accept, 'application/octet-stream')
    const storage = mock.requests.find((item) => item.path === '/storage/github/app.apk')
    assert.equal(storage.authorization, undefined)
    assert.equal(storage.query.access_token, undefined)

    assert.equal(mock.confirmations.length, 1)
    assert.equal(mock.confirmations[0].authorization, `Bearer ${CNB_TOKEN}`)
  } finally {
    await mock.close()
  }
}

console.log('release-sync: GitHub 源 → CNB 目标测试通过')
