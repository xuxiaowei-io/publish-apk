/**
 * release-sync：CNB 源 → GitLab 目标端到端测试。
 *
 * GitLab 目标流程：
 *   1. 目标标签基于分支创建；
 *   2. 附件先 PUT 到 Generic Package Registry：
 *      /projects/:id/packages/generic/release-sync/:tag/:file
 *   3. 再创建 / 更新 Release Link，指向通用包地址；
 *   4. 同名 package file 先删除，避免 GitLab 同版本重复上传变成追加；
 *   5. 只清理 release-sync 管理的 package 链接，手工链接保留。
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
const PACKAGE = 'release-sync'
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

async function startMock() {
  const state = {
    requests: [],
    tag: null,
    release: null,
    links: [],
    packages: [],
    packageFiles: [],
    packageUploads: [],
    packageDeletes: [],
    linkCreates: [],
    linkUpdates: [],
    deletedLinks: [],
    releaseCreated: undefined,
    releaseUpdated: [],
    downloads: 0,
    base: '',
  }
  let nextPackageId = 1
  let nextFileId = 1
  let nextLinkId = 1

  const projectPath = `/api/v4/projects/${encodeURIComponent(PROJECT)}`
  const withRelease = () =>
    state.release === null
      ? null
      : {
          ...state.release,
          assets: {
            count: state.links.length,
            links: state.links,
            sources: [
              { format: 'zip', url: `https://gitlab.com/${PROJECT}/-/archive/${TAG}/project-${TAG}.zip` },
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
        contentType: request.headers['content-type'],
        body,
      }
      state.requests.push(record)

      // ---------------- CNB 源仓库 ----------------
      if (url.pathname.startsWith(`/${SOURCE_REPO}/-/`)) {
        if (request.headers.authorization !== `Bearer ${CNB_TOKEN}`) {
          sendJson(response, 401, { errcode: 16, errmsg: 'not logged in' })
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
        if (request.method === 'GET' && url.pathname.endsWith(`/releases/download/${TAG}/app.apk`)) {
          state.downloads += 1
          response.writeHead(302, { location: `${state.base}/storage/source/app.apk` })
          response.end()
          return
        }
        if (request.method === 'GET' && url.pathname.endsWith(`/releases/download/${TAG}/notes.txt`)) {
          state.downloads += 1
          response.writeHead(302, { location: `${state.base}/storage/source/notes.txt` })
          response.end()
          return
        }
      }
      if (request.method === 'GET' && url.pathname === '/storage/source/app.apk') {
        response.writeHead(200, { 'content-type': 'application/vnd.android.package-archive' })
        response.end('hello')
        return
      }
      if (request.method === 'GET' && url.pathname === '/storage/source/notes.txt') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('note')
        return
      }

      // ---------------- GitLab 目标项目 ----------------
      if (url.pathname === projectPath) {
        if (record.privateToken !== GITLAB_TOKEN) {
          sendJson(response, 401, { message: '401 Unauthorized' })
          return
        }
        sendJson(response, 200, {
          id: 88403877,
          path_with_namespace: PROJECT,
          default_branch: 'main',
          web_url: `https://gitlab.com/${PROJECT}`,
        })
        return
      }
      if (url.pathname === `${projectPath}/repository/tags/${TAG}`) {
        if (state.tag === null) {
          sendJson(response, 404, { message: '404 Not Found' })
          return
        }
        sendJson(response, 200, state.tag)
        return
      }
      if (url.pathname === `${projectPath}/repository/tags` && request.method === 'POST') {
        state.tag = { name: body.tag_name, commit: { id: 'branch-sha' } }
        sendJson(response, 201, state.tag)
        return
      }
      if (url.pathname === `${projectPath}/releases` && request.method === 'GET') {
        sendJson(response, 200, state.release === null ? [] : [withRelease()])
        return
      }
      if (url.pathname === `${projectPath}/releases` && request.method === 'POST') {
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
        if (state.release === null) {
          sendJson(response, 404, { message: '404 Not Found' })
          return
        }
        sendJson(response, 200, withRelease())
        return
      }
      if (url.pathname === `${projectPath}/releases/${TAG}` && request.method === 'PUT') {
        state.releaseUpdated.push(body)
        state.release = { ...state.release, ...body }
        sendJson(response, 200, withRelease())
        return
      }

      // Release links
      if (url.pathname === `${projectPath}/releases/${TAG}/assets/links` && request.method === 'GET') {
        sendJson(response, 200, state.links)
        return
      }
      if (url.pathname === `${projectPath}/releases/${TAG}/assets/links` && request.method === 'POST') {
        state.linkCreates.push(body)
        const link = { id: nextLinkId, ...body }
        nextLinkId += 1
        state.links.push(link)
        sendJson(response, 201, link)
        return
      }
      if (url.pathname.startsWith(`${projectPath}/releases/${TAG}/assets/links/`) && request.method === 'PUT') {
        const id = Number(url.pathname.split('/').pop())
        state.linkUpdates.push({ id, body })
        const link = state.links.find((item) => item.id === id)
        if (link !== undefined) {
          Object.assign(link, body)
        }
        sendJson(response, 200, link)
        return
      }
      if (url.pathname.startsWith(`${projectPath}/releases/${TAG}/assets/links/`) && request.method === 'DELETE') {
        const id = Number(url.pathname.split('/').pop())
        state.deletedLinks.push(id)
        state.links = state.links.filter((item) => item.id !== id)
        response.writeHead(204)
        response.end()
        return
      }

      // Generic package registry
      if (url.pathname === `${projectPath}/packages` && request.method === 'GET') {
        sendJson(response, 200, state.packages)
        return
      }
      if (url.pathname === `${projectPath}/packages/1/package_files` && request.method === 'GET') {
        sendJson(response, 200, state.packageFiles)
        return
      }
      if (
        url.pathname.startsWith(`${projectPath}/packages/1/package_files/`) &&
        request.method === 'DELETE'
      ) {
        const id = Number(url.pathname.split('/').pop())
        state.packageDeletes.push(id)
        state.packageFiles = state.packageFiles.filter((item) => item.id !== id)
        response.writeHead(204)
        response.end()
        return
      }
      if (
        url.pathname.startsWith(`${projectPath}/packages/generic/${PACKAGE}/${TAG}/`) &&
        request.method === 'PUT'
      ) {
        const fileName = decodeURIComponent(url.pathname.split('/').pop())
        state.packageUploads.push({
          name: fileName,
          size: body === undefined ? 0 : body.length,
          body,
          privateToken: record.privateToken,
          contentType: record.contentType,
        })
        if (state.packages.length === 0) {
          state.packages.push({ id: nextPackageId, name: PACKAGE, version: TAG, package_type: 'generic' })
        }
        const file = {
          id: nextFileId,
          package_id: nextPackageId,
          file_name: fileName,
          size: body === undefined ? 0 : body.length,
          file_sha256: sha256(body?.toString('utf8') ?? ''),
        }
        nextFileId += 1
        state.packageFiles.push(file)
        response.writeHead(201)
        response.end()
        return
      }

      sendJson(response, 404, { message: '404 Not Found' })
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
  '--package-name',
  PACKAGE,
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
    assert.match(result.stdout, /^附件: 2 个（已上传 2，跳过 0）$/m)

    assert.deepEqual(mock.tagCreated ?? mock.tag, { name: TAG, commit: { id: 'branch-sha' } })
    assert.equal(mock.releaseCreated.name, `${TAG} CNB 发布`)
    assert.equal(mock.releaseCreated.tag_name, TAG)
    assert.equal(mock.releaseCreated.ref, 'main')
    assert.equal(mock.releaseCreated.description, '## CNB 源说明')
    assert.equal(Object.hasOwn(mock.releaseCreated, 'draft'), false)
    assert.equal(Object.hasOwn(mock.releaseCreated, 'prerelease'), false)
    assert.equal(Object.hasOwn(mock.releaseCreated, 'make_latest'), false)

    assert.equal(mock.downloads, 2)
    assert.equal(mock.packageUploads.length, 2)
    assert.equal(mock.packageUploads[0].name, 'app.apk')
    assert.equal(mock.packageUploads[0].privateToken, GITLAB_TOKEN)
    assert.equal(mock.packageUploads[0].body.toString('utf8'), 'hello')
    assert.equal(mock.packageUploads[1].name, 'notes.txt')
    assert.equal(mock.packageUploads[1].body.toString('utf8'), 'note')

    assert.equal(mock.linkCreates.length, 2)
    assert.equal(
      mock.linkCreates[0].url,
      `${mock.base}/api/v4/projects/88403877/packages/generic/${PACKAGE}/${TAG}/app.apk`,
    )
    assert.equal(mock.linkCreates[0].link_type, 'package')
    assert.equal(mock.links.length, 2)

    // 第二次：同名 package file 删除后重传；Release Link 更新；手工链接保留
    mock.links.push({
      id: 999,
      name: 'manual-doc',
      url: 'https://example.com/docs',
      link_type: 'other',
    })
    mock.links.push({
      id: 998,
      name: 'old.bin',
      url: `${mock.base}/api/v4/projects/88403877/packages/generic/${PACKAGE}/${TAG}/old.bin`,
      link_type: 'package',
    })
    mock.packageFiles.push({
      id: 100,
      package_id: 1,
      file_name: 'old.bin',
      size: 3,
      file_sha256: sha256('old'),
    })
    const second = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /^附件: 2 个（已上传 2，跳过 0，删除多余 1）$/m)
    assert.equal(mock.packageUploads.length, 4)
    assert.equal(mock.packageDeletes.includes(1), true)
    assert.equal(mock.packageDeletes.includes(2), true)
    assert.equal(mock.packageDeletes.includes(100), true)
    assert.equal(mock.linkUpdates.length, 2)
    assert.deepEqual(mock.deletedLinks, [998])
    assert.equal(mock.links.some((link) => link.id === 999), true)
    assert.equal(mock.links.some((link) => link.id === 998), false)
    assert.equal(mock.releaseUpdated.length, 0)
  } finally {
    await mock.close()
  }
}

// 目标为 GitLab 但未指定软件包名：应直接报参数错误
{
  const missing = await runCli(
    [
      'release-sync',
      '--source',
      `https://cnb.cool/${SOURCE_REPO}`,
      '--target',
      `https://gitlab.com/${PROJECT}`,
      '--tag',
      TAG,
      '--source-token',
      'x',
      '--target-token',
      'y',
    ],
    {},
  )
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /目标为 GitLab 时必须指定软件包名/)
}

console.log('release-sync: CNB 源 → GitLab 目标测试通过')
