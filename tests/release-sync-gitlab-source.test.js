/**
 * release-sync：GitLab 源 → CNB 目标端到端测试。
 *
 * 验证 GitLab 读取侧：
 *   - assets.sources 是自动源码包，忽略；
 *   - assets.links 作为发布产物，下载后上传到 CNB；
 *   - Release 按 tag 查询，最新发布按 released_at 列表取第一条；
 *   - 外部/同源链接的令牌发送策略。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const GITLAB_TOKEN = 'gitlab-source-token'
const CNB_TOKEN = 'cnb-target-token'
const PROJECT = 'group/sub/src'
const CNB_REPO = 'cnb/dst'
const TAG = 'v1.0.0'

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
  sendJson(response, 404, { message: '404 Not Found' })
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

  const projectPath = `/api/v4/projects/${encodeURIComponent(PROJECT)}`
  const release = {
    tag_name: TAG,
    name: 'GitLab 源发布',
    description: '## GitLab 源说明',
    released_at: '2026-01-01T00:00:00Z',
    assets: {
      count: 5,
      sources: [
        { format: 'zip', url: `https://gitlab.com/${PROJECT}/-/archive/${TAG}/project-${TAG}.zip` },
        { format: 'tar.gz', url: `https://gitlab.com/${PROJECT}/-/archive/${TAG}/project-${TAG}.tar.gz` },
      ],
      links: [
        {
          id: 77,
          name: 'app.apk',
          url: null,
          link_type: 'other',
        },
      ],
    },
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const body = await readRequestBody(request)
      const record = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        privateToken: request.headers['private-token'],
        authorization: request.headers.authorization,
        body,
      }
      state.requests.push(record)

      // ---------------- GitLab 源项目 ----------------
      if (url.pathname === projectPath || url.pathname.startsWith(`${projectPath}/`)) {
        if (record.privateToken !== GITLAB_TOKEN) {
          sendJson(response, 401, { message: '401 Unauthorized' })
          return
        }
        if (request.method === 'GET' && url.pathname === `${projectPath}/releases/${TAG}`) {
          sendJson(response, 200, release)
          return
        }
        if (request.method === 'GET' && url.pathname === `${projectPath}/releases`) {
          sendJson(response, 200, [release])
          return
        }
      }
      if (request.method === 'GET' && url.pathname === '/storage/gitlab/app.apk') {
        // GitLab 同源链接会带 PRIVATE-TOKEN；这里只校验内容
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end('hello')
        return
      }

      // ---------------- CNB 目标仓库 ----------------
      if (url.pathname.startsWith(`/${CNB_REPO}/-/`)) {
        if (record.privateToken !== undefined) {
          sendJson(response, 400, { message: 'unexpected token' })
          return
        }
        if (request.headers.authorization !== `Bearer ${CNB_TOKEN}`) {
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
        if (request.headers.authorization !== `Bearer ${CNB_TOKEN}`) {
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
  release.assets.links[0].url = `${state.base}/storage/gitlab/app.apk`
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
        GITLAB_TOKEN: '',
        GITLAB_SOURCE_TOKEN: '',
        GITLAB_TARGET_TOKEN: '',
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
        `https://gitlab.com/${PROJECT}`,
        '--target',
        `https://cnb.cool/${CNB_REPO}`,
        '--tag',
        TAG,
        '--source-api-base',
        `${mock.base}/api/v4`,
        '--target-api-base',
        mock.base,
      ],
      {
        GITLAB_SOURCE_TOKEN: GITLAB_TOKEN,
        CNB_TARGET_TOKEN: CNB_TOKEN,
      },
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^源发布: gitlab\.com\/group\/sub\/src@v1\.0\.0$/m)
    assert.match(result.stdout, /^附件: 1 个（已上传 1，跳过 0）$/m)

    assert.equal(mock.releaseCreated.name, 'GitLab 源发布')
    assert.equal(mock.releaseCreated.body, '## GitLab 源说明')
    assert.equal(mock.releaseCreated.make_latest, 'true')
    assert.deepEqual(mock.tagCreated, { name: TAG, target: 'main' })

    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].body.toString('utf8'), 'hello')
    assert.equal(mock.uploads[0].authorization, undefined)

    const download = mock.requests.find((item) => item.path === '/storage/gitlab/app.apk')
    assert.equal(download.privateToken, GITLAB_TOKEN)
    assert.equal(mock.confirmations.length, 1)
    assert.equal(mock.confirmations[0].authorization, `Bearer ${CNB_TOKEN}`)
  } finally {
    await mock.close()
  }
}

console.log('release-sync: GitLab 源 → CNB 目标测试通过')
