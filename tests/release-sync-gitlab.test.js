/**
 * release-sync：CNB 源 → GitLab 目标端到端测试。
 *
 * GitLab Release 不能上传任意附件，目标是：
 *   - 目标标签基于分支创建；
 *   - 发布说明直接生成 Markdown 下载表格；
 *   - 不下载源附件、不上传 GitLab 附件；
 *   - 目标已有 Release Link 属于发布者内容，保留不删；
 *   - Release 按 tag 更新（GitLab 没有 release id）。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const CNB_TOKEN = 'cnb-source-token'
const GITLAB_TOKEN = 'gitlab-target-token'
const SOURCE_REPO = 'org/src'
const PROJECT = 'group/sub/project'
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
  sendJson(response, 404, { message: '404 Not Found' })
}

async function startMock() {
  const state = {
    requests: [],
    tag: null,
    release: null,
    links: [],
    tagCreated: undefined,
    releaseCreated: undefined,
    releaseUpdated: [],
    deletedLinks: [],
    downloads: 0,
    base: '',
  }

  const projectPath = `/api/v4/projects/${encodeURIComponent(PROJECT)}`
  const withRelease = () =>
    state.release === null
      ? null
      : {
          ...state.release,
          assets: {
            count: 4 + state.links.length,
            sources: [
              { format: 'zip', url: `https://gitlab.com/${PROJECT}/-/archive/${TAG}/project-${TAG}.zip` },
            ],
            links: state.links,
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
        body,
      }
      state.requests.push(record)

      // ---------------- CNB 源仓库 ----------------
      if (url.pathname.startsWith(`/${SOURCE_REPO}/-/`)) {
        if (record.privateToken !== undefined) {
          // CNB 源不应收到 GitLab 令牌
          sendJson(response, 400, { message: 'unexpected token' })
          return
        }
        if (request.method === 'GET' && url.pathname === `/${SOURCE_REPO}/-/releases/tags/${TAG}`) {
          sendJson(response, 200, {
            id: 'cnb-release-1',
            tag_name: TAG,
            name: `${TAG} CNB 发布`,
            body: '## CNB 源说明',
            draft: false,
            prerelease: false,
            is_latest: true,
            assets: [
              {
                id: 'cnb-asset-1',
                name: 'app.apk',
                size: 5,
                content_type: 'application/vnd.android.package-archive',
                hash_algo: 'sha256',
                hash_value: sha256('hello'),
                browser_download_url: `https://cnb.cool/${SOURCE_REPO}/-/releases/download/${TAG}/app.apk`,
              },
              {
                id: 'cnb-asset-2',
                name: 'notes.txt',
                size: 4,
                content_type: 'text/plain',
                hash_algo: 'sha256',
                hash_value: sha256('note'),
                browser_download_url: `https://cnb.cool/${SOURCE_REPO}/-/releases/download/${TAG}/notes.txt`,
              },
            ],
          })
          return
        }
        // 目标为 GitLab 时不应下载源附件；若发生，返回 500 让测试失败得更明确
        if (url.pathname.includes('/releases/download/')) {
          state.downloads += 1
          sendJson(response, 500, { message: 'unexpected download' })
          return
        }
      }

      // ---------------- GitLab 目标项目 ----------------
      if (url.pathname === projectPath) {
        if (record.privateToken !== GITLAB_TOKEN) {
          sendJson(response, 401, { message: '401 Unauthorized' })
          return
        }
        sendJson(response, 200, { path_with_namespace: PROJECT, default_branch: 'main' })
        return
      }
      if (url.pathname === `${projectPath}/repository/tags/${TAG}`) {
        if (record.privateToken !== GITLAB_TOKEN) {
          sendJson(response, 401, { message: '401 Unauthorized' })
          return
        }
        if (state.tag === null) {
          sendNotFound(response)
          return
        }
        sendJson(response, 200, state.tag)
        return
      }
      if (url.pathname === `${projectPath}/repository/tags`) {
        if (request.method === 'POST') {
          if (record.privateToken !== GITLAB_TOKEN) {
            sendJson(response, 401, { message: '401 Unauthorized' })
            return
          }
          state.tagCreated = body
          state.tag = { name: body.tag_name, commit: { id: 'branch-sha' } }
          sendJson(response, 201, state.tag)
          return
        }
      }
      if (url.pathname === `${projectPath}/releases` && request.method === 'GET') {
        if (record.privateToken !== GITLAB_TOKEN) {
          sendJson(response, 401, { message: '401 Unauthorized' })
          return
        }
        sendJson(response, 200, state.release === null ? [] : [withRelease()])
        return
      }
      if (url.pathname === `${projectPath}/releases` && request.method === 'POST') {
        if (record.privateToken !== GITLAB_TOKEN) {
          sendJson(response, 401, { message: '401 Unauthorized' })
          return
        }
        state.releaseCreated = body
        state.release = {
          tag_name: body.tag_name,
          name: body.name,
          description: body.description,
          released_at: '2026-01-01T00:00:00Z',
        }
        sendJson(response, 201, withRelease())
        return
      }
      if (url.pathname === `${projectPath}/releases/${TAG}` && request.method === 'GET') {
        if (record.privateToken !== GITLAB_TOKEN) {
          sendJson(response, 401, { message: '401 Unauthorized' })
          return
        }
        if (state.release === null) {
          sendNotFound(response)
          return
        }
        sendJson(response, 200, withRelease())
        return
      }
      if (url.pathname === `${projectPath}/releases/${TAG}` && request.method === 'PUT') {
        if (record.privateToken !== GITLAB_TOKEN) {
          sendJson(response, 401, { message: '401 Unauthorized' })
          return
        }
        state.releaseUpdated.push(body)
        state.release = { ...state.release, ...body }
        sendJson(response, 200, withRelease())
        return
      }
      if (
        url.pathname.startsWith(`${projectPath}/releases/${TAG}/assets/links/`) &&
        request.method === 'DELETE'
      ) {
        if (record.privateToken !== GITLAB_TOKEN) {
          sendJson(response, 401, { message: '401 Unauthorized' })
          return
        }
        const id = Number(url.pathname.split('/').pop())
        state.deletedLinks.push(id)
        state.links = state.links.filter((link) => link.id !== id)
        response.writeHead(204)
        response.end()
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
        CNB_TOKEN: '',
        CNB_SOURCE_TOKEN: '',
        CNB_TARGET_TOKEN: '',
        GITLAB_TOKEN: '',
        GITLAB_SOURCE_TOKEN: '',
        GITLAB_TARGET_TOKEN: '',
        GITLAB_SOURCE_API_BASE: '',
        GITLAB_TARGET_API_BASE: '',
        GITLAB_API_BASE: '',
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

const ARGS = (base) => [
  'release-sync',
  '--source',
  `https://cnb.cool/${SOURCE_REPO}`,
  '--target',
  `https://gitlab.com/${PROJECT}`,
  '--tag',
  TAG,
  '--source-api-base',
  base,
  '--target-api-base',
  `${base}/api/v4`,
]

const TOKENS = {
  CNB_SOURCE_TOKEN: CNB_TOKEN,
  GITLAB_TARGET_TOKEN: GITLAB_TOKEN,
}

{
  const mock = await startMock()
  try {
    const result = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^目标发布: gitlab\.com\/group\/sub\/project@v1\.0\.0（已创建）$/m)
    assert.match(result.stdout, /目标平台不支持附件上传/)
    assert.match(result.stdout, /附件: 2 个（目标平台不支持附件上传/)

    assert.deepEqual(mock.tagCreated, { tag_name: TAG, ref: 'main' })
    assert.equal(mock.releaseCreated.name, `${TAG} CNB 发布`)
    assert.equal(mock.releaseCreated.tag_name, TAG)
    assert.equal(mock.releaseCreated.ref, 'main')
    assert.equal(Object.hasOwn(mock.releaseCreated, 'draft'), false)
    assert.equal(Object.hasOwn(mock.releaseCreated, 'prerelease'), false)
    assert.equal(Object.hasOwn(mock.releaseCreated, 'make_latest'), false)
    assert.match(mock.releaseCreated.description, /## CNB 源说明/)
    assert.match(mock.releaseCreated.description, /<!-- release-sync:assets:start -->/)
    assert.match(mock.releaseCreated.description, /目标平台 GitLab 不支持上传发布附件/)
    assert.match(mock.releaseCreated.description, /https:\/\/cnb\.cool\/org\/src\/-\/releases\/download\/v1\.0\.0\/app\.apk/)
    assert.match(mock.releaseCreated.description, /https:\/\/cnb\.cool\/org\/src\/-\/releases\/download\/v1\.0\.0\/notes\.txt/)

    // 目标为 GitLab：不下载源附件、不上传附件
    assert.equal(mock.downloads, 0)
    assert.equal(mock.requests.filter((item) => item.method === 'POST' && item.path.includes('/assets')).length, 0)

    // 第二次：目标说明改成旧的 + 多一个 Release Link，应更新表格但保留 Link
    mock.release = { ...mock.release, description: '旧说明' }
    mock.links.push({ id: 999, name: 'extra.txt', url: 'https://example.com/extra.txt', link_type: 'other' })
    const second = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /目标平台不支持附件上传/)
    assert.equal(mock.releaseUpdated.length, 1)
    assert.match(mock.releaseUpdated[0].description, /<!-- release-sync:assets:start -->/)
    assert.deepEqual(mock.deletedLinks, [])
    assert.ok(mock.links.some((link) => link.id === 999))
    assert.equal(mock.downloads, 0)
  } finally {
    await mock.close()
  }
}

console.log('release-sync: CNB 源 → GitLab 目标测试通过')
