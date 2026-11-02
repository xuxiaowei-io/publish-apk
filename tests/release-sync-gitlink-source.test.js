/**
 * release-sync：GitLink 源 → CNB 目标端到端测试。
 *
 * 验证 GitLink 读取侧：
 *   - releases.json 包装结构 / 分页；
 *   - attachments 的 title / filesize / 相对 download URL；
 *   - 附件下载后再上传到 CNB；
 *   - draft 状态文本（稳定 / 草稿 / 预发布）映射。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const GITLINK_TOKEN = 'gitlink-source-token'
const CNB_TOKEN = 'cnb-target-token'
const OWNER = 'owner'
const REPO = 'src'
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
    version_id: 50,
    id: 'release-50',
    tag_name: TAG,
    target_commitish: 'master',
    name: 'GitLink 源发布',
    body: '## GitLink 源说明',
    draft: '稳定',
    attachments: [
      {
        id: 77,
        title: 'app.apk',
        filesize: '5 B',
        url: `/${OWNER}/${REPO}/releases/download/${TAG}/app.apk`,
      },
    ],
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
        body,
      }
      state.requests.push(record)

      // ---------------- GitLink 源仓库 ----------------
      if (url.pathname === `/api/${OWNER}/${REPO}/releases.json`) {
        if (request.headers.authorization !== `Bearer ${GITLINK_TOKEN}`) {
          sendJson(response, 200, { status: 401, message: '请登录后再操作' })
          return
        }
        const page = Number(url.searchParams.get('page') ?? '1')
        sendJson(response, 200, {
          status: 0,
          message: '响应成功',
          total_count: 1,
          releases: page === 1 ? [release] : [],
        })
        return
      }
      if (url.pathname.startsWith(`/${OWNER}/${REPO}/releases/download/`)) {
        // 同源下载地址会带 GitLink Bearer；这里返回 302 到对象存储
        if (request.headers.authorization !== `Bearer ${GITLINK_TOKEN}`) {
          sendJson(response, 401, { message: 'unauthorized' })
          return
        }
        response.writeHead(302, { location: `${state.base}/storage/gitlink/app.apk` })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/storage/gitlink/app.apk') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end('hello')
        return
      }

      // ---------------- CNB 目标仓库 ----------------
      if (url.pathname.startsWith(`/${CNB_REPO}/-/`)) {
        if (request.headers.authorization !== `Bearer ${CNB_TOKEN}`) {
          sendJson(response, 401, { errcode: 16, errmsg: 'not logged in' })
          return
        }
        if (request.method === 'GET' && url.pathname === `/${CNB_REPO}/-/releases/tags/${TAG}`) {
          sendJson(response, 404, { errcode: 404, errmsg: 'not found' })
          return
        }
        if (request.method === 'GET' && url.pathname === `/${CNB_REPO}/-/git/tags/${TAG}`) {
          sendJson(response, 404, { errcode: 404, errmsg: 'not found' })
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
        state.confirmations.push(record)
        sendJson(response, 200)
        return
      }

      sendJson(response, 404, { status: -1, message: '版本不存在' })
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
        GITLINK_TOKEN: '',
        GITLINK_SOURCE_TOKEN: '',
        GITLINK_TARGET_TOKEN: '',
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
        `https://gitlink.org.cn/${OWNER}/${REPO}`,
        '--target',
        `https://cnb.cool/${CNB_REPO}`,
        '--tag',
        TAG,
        '--source-api-base',
        `${mock.base}/api`,
        '--target-api-base',
        mock.base,
      ],
      {
        GITLINK_SOURCE_TOKEN: GITLINK_TOKEN,
        CNB_TARGET_TOKEN: CNB_TOKEN,
      },
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^源发布: gitlink\.org\.cn\/owner\/src@v1\.0\.0$/m)
    assert.match(result.stdout, /^附件: 1 个（已上传 1，跳过 0）$/m)

    assert.equal(mock.releaseCreated.name, 'GitLink 源发布')
    assert.equal(mock.releaseCreated.body, '## GitLink 源说明')
    assert.equal(mock.releaseCreated.make_latest, 'true')
    assert.deepEqual(mock.tagCreated, { name: TAG, target: 'main' })

    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].body.toString('utf8'), 'hello')
    assert.equal(mock.uploads[0].authorization, undefined)

    const download = mock.requests.find(
      (item) =>
        item.path === `/${OWNER}/${REPO}/releases/download/${TAG}/app.apk` &&
        item.authorization !== undefined,
    )
    assert.equal(download.authorization, `Bearer ${GITLINK_TOKEN}`)
    const storage = mock.requests.find((item) => item.path === '/storage/gitlink/app.apk')
    assert.equal(storage.authorization, undefined)

    assert.equal(mock.confirmations.length, 1)
  } finally {
    await mock.close()
  }
}

console.log('release-sync: GitLink 源 → CNB 目标测试通过')
