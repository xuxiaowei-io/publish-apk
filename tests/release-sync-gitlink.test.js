/**
 * release-sync：CNB 源 → GitLink 目标端到端测试。
 *
 * GitLink 附件流程：
 *   1. POST /api/attachments.json（multipart file）上传附件，拿到附件 id；
 *   2. PUT /api/{owner}/{repo}/releases/{version_id}，把附件 id 写入 attachment_ids；
 *   3. 同名附件先移出 attachment_ids，再加入新 id。
 *
 * 目标标签由 create release 的 target_commitish 自动创建；目标已有附件保留。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const CNB_TOKEN = 'cnb-source-token'
const GITLINK_TOKEN = 'gitlink-target-token'
const SOURCE_REPO = 'org/src'
const OWNER = 'owner'
const REPO = 'repo'
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
    release: null,
    tags: [],
    releaseCreated: undefined,
    releaseUpdated: [],
    attachments: [],
    deletions: [],
    uploads: [],
    downloads: 0,
    base: '',
  }
  let nextAttachmentId = 1

  const withRelease = () =>
    state.release === null ? null : { ...state.release, attachments: state.attachments }

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

      // ---------------- GitLink 目标仓库 ----------------
      if (url.pathname === `/api/v1/${OWNER}/${REPO}`) {
        if (request.headers.authorization !== `Bearer ${GITLINK_TOKEN}`) {
          sendJson(response, 200, { status: 401, message: '请登录后再操作' })
          return
        }
        sendJson(response, 200, { default_branch: 'master', full_name: `${OWNER}/${REPO}` })
        return
      }
      if (url.pathname === `/api/v1/${OWNER}/${REPO}/tags.json`) {
        if (request.headers.authorization !== `Bearer ${GITLINK_TOKEN}`) {
          sendJson(response, 200, { status: 401, message: '请登录后再操作' })
          return
        }
        const page = Number(url.searchParams.get('page') ?? '1')
        sendJson(response, 200, {
          status: 0,
          message: '响应成功',
          total_count: state.tags.length,
          tags: page === 1 ? state.tags : [],
        })
        return
      }
      if (url.pathname === '/api/attachments.json') {
        if (request.method === 'POST') {
          if (request.headers.authorization !== `Bearer ${GITLINK_TOKEN}`) {
            sendJson(response, 200, { status: 401, message: '请登录后再操作' })
            return
          }
          state.uploads.push(record)
          const text = body?.toString('latin1') ?? ''
          const name = /filename="([^"]+)"/.exec(text)?.[1] ?? `asset-${nextAttachmentId}`
          const attachment = {
            id: nextAttachmentId,
            title: name,
            filesize: '5 B',
            url: `/${OWNER}/${REPO}/releases/download/${TAG}/${name}`,
            content_type: 'application/octet-stream',
          }
          state.attachments.push(attachment)
          nextAttachmentId += 1
          sendJson(response, 200, attachment)
          return
        }
      }
      if (url.pathname === `/api/${OWNER}/${REPO}/releases.json`) {
        if (request.headers.authorization !== `Bearer ${GITLINK_TOKEN}`) {
          sendJson(response, 200, { status: 401, message: '请登录后再操作' })
          return
        }
        if (request.method === 'GET') {
          const page = Number(url.searchParams.get('page') ?? '1')
          sendJson(response, 200, {
            status: 0,
            message: '响应成功',
            total_count: state.release === null ? 0 : 1,
            releases: page === 1 && state.release !== null ? [withRelease()] : [],
          })
          return
        }
        if (request.method === 'POST') {
          state.releaseCreated = body
          state.release = {
            version_id: 1,
            id: 'release-1',
            tag_name: body.tag_name,
            target_commitish: body.target_commitish,
            name: body.name,
            body: body.body,
            draft: body.draft ? '草稿' : body.prerelease ? '预发布' : '稳定',
            attachments: [],
          }
          state.tags = [{ name: body.tag_name }]
          sendJson(response, 200, { status: 0, message: '响应成功' })
          return
        }
      }
      if (url.pathname === `/api/${OWNER}/${REPO}/releases/1` && request.method === 'PUT') {
        if (request.headers.authorization !== `Bearer ${GITLINK_TOKEN}`) {
          sendJson(response, 200, { status: 401, message: '请登录后再操作' })
          return
        }
        state.releaseUpdated.push(body)
        state.release = {
          ...state.release,
          name: body.name,
          body: body.body,
          draft: body.draft ? '草稿' : body.prerelease ? '预发布' : '稳定',
        }
        // GitLink 的 attachment_ids 更新是追加语义
        if (Array.isArray(body.attachment_ids)) {
          for (const id of body.attachment_ids) {
            if (!state.attachments.some((item) => Number(item.id) === Number(id))) {
              state.attachments.push({ id, title: `attachment-${id}` })
            }
          }
        }
        sendJson(response, 200, { status: 0, message: '响应成功' })
        return
      }

      if (url.pathname.startsWith('/api/attachments/') && request.method === 'DELETE') {
        if (request.headers.authorization !== `Bearer ${GITLINK_TOKEN}`) {
          sendJson(response, 200, { status: 401, message: '请登录后再操作' })
          return
        }
        const id = Number(url.pathname.split('/').pop())
        state.deletions.push(id)
        state.attachments = state.attachments.filter((item) => Number(item.id) !== id)
        sendJson(response, 200, { status: 0, message: '删除成功' })
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
  // 模拟“上传后附件落库”
  state.addAttachment = (attachment) => {
    state.attachments.push(attachment)
  }
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
        GITLINK_TOKEN: '',
        GITLINK_SOURCE_TOKEN: '',
        GITLINK_TARGET_TOKEN: '',
        GITLINK_SOURCE_API_BASE: '',
        GITLINK_TARGET_API_BASE: '',
        GITLINK_API_BASE: '',
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
  `https://gitlink.org.cn/${OWNER}/${REPO}`,
  '--tag',
  TAG,
  '--source-api-base',
  base,
  '--target-api-base',
  `${base}/api`,
]

const TOKENS = {
  CNB_SOURCE_TOKEN: CNB_TOKEN,
  GITLINK_TARGET_TOKEN: GITLINK_TOKEN,
}

{
  const mock = await startMock()
  try {
    const result = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^目标发布: gitlink\.org\.cn\/owner\/repo@v1\.0\.0（已创建）$/m)
    assert.match(result.stdout, /^附件: 2 个（已上传 2，跳过 0）$/m)

    assert.equal(mock.releaseCreated.tag_name, TAG)
    assert.equal(mock.releaseCreated.target_commitish, 'master')
    assert.equal(mock.releaseCreated.name, `${TAG} CNB 发布`)
    assert.equal(mock.releaseCreated.body, '## CNB 源说明')
    assert.equal(mock.releaseCreated.draft, false)
    assert.equal(mock.releaseCreated.prerelease, false)
    assert.equal(mock.releaseCreated.attachment_ids, undefined)

    assert.equal(mock.uploads.length, 2)
    assert.equal(mock.uploads[0].authorization, `Bearer ${GITLINK_TOKEN}`)
    assert.match(mock.uploads[0].contentType, /^multipart\/form-data; boundary=/)
    assert.match(mock.uploads[0].body.toString('latin1'), /filename="app\.apk"/)
    assert.equal(mock.downloads, 2)

    assert.equal(mock.releaseUpdated.length, 2)
    assert.deepEqual(mock.releaseUpdated[0].attachment_ids, [1])
    assert.deepEqual(mock.releaseUpdated[1].attachment_ids, [2])
    assert.equal(mock.attachments.length, 2)
    assert.deepEqual(
      mock.attachments.map((item) => item.title),
      ['app.apk', 'notes.txt'],
    )
    assert.deepEqual(mock.tags.map((tag) => tag.name), [TAG])

    // 第二次：GitLink 附件无 SHA，会重新上传；同名旧附件删除，目标多余附件清理
    mock.attachments.push({
      id: 999,
      title: 'extra.txt',
      filesize: '4 B',
      url: `/${OWNER}/${REPO}/releases/download/${TAG}/extra.txt`,
    })
    const second = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /^附件: 2 个（已上传 2，跳过 0，删除多余 1）$/m)
    assert.equal(mock.uploads.length, 4)
    assert.equal(mock.deletions.includes(999), true)
    assert.equal(mock.attachments.some((item) => item.id === 999), false)
    assert.deepEqual(
      mock.attachments.map((item) => item.title).sort(),
      ['app.apk', 'notes.txt'],
    )
  } finally {
    await mock.close()
  }
}

console.log('release-sync: CNB 源 → GitLink 目标测试通过')
