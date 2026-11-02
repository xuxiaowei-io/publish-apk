/**
 * release-sync：CNB 源 → GitCode 目标端到端测试。
 *
 * 覆盖 GitCode 特有行为：
 *   - Release 更新 / 附件路径都按 tag，而不是 release id；
 *   - Release 不返回 id 时用 tag 作为同步标识；
 *   - 附件先 GET upload_url，再 PUT 到预签名地址（带 x-obs-* 头）；
 *   - upload_url 的 PUT 完成后，Release 的 assets 才出现附件；
 *   - digest 一致跳过、不一致先删同名再传；多余附件删除。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { GitcodeReleaseClient } from '../src/gitcode.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const CNB_TOKEN = 'cnb-source-token'
const GITCODE_TOKEN = 'gitcode-target-token'
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

function sendNotFound(response) {
  sendJson(response, 404, { message: 'Not Found' })
}

async function startMock() {
  const state = {
    requests: [],
    tag: null,
    release: null,
    assets: [],
    tagCreated: undefined,
    releaseCreated: undefined,
    releasePatched: [],
    uploads: [],
    deletions: [],
    base: '',
  }
  let nextAssetId = 10

  const withAssets = () => (state.release === null ? null : { ...state.release, assets: state.assets })

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const body = await readRequestBody(request)
      const record = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        authorization: request.headers.authorization,
        headers: request.headers,
        body,
      }
      state.requests.push(record)

      // ---------------- CNB 源仓库 ----------------
      if (url.pathname.startsWith(`/${SOURCE_REPO}/-/`)) {
        if (record.authorization !== `Bearer ${CNB_TOKEN}`) {
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
                url: `${state.base}/${SOURCE_REPO}/-/releases/download/${TAG}/app.apk`,
                content_type: 'application/vnd.android.package-archive',
                hash_algo: 'sha256',
                hash_value: sha256('hello'),
              },
            ],
          })
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

      // ---------------- GitCode 目标仓库 ----------------
      if (url.pathname.startsWith(`/api/v5/repos/${OWNER}/${REPO}`)) {
        if (record.authorization !== `Bearer ${GITCODE_TOKEN}`) {
          sendJson(response, 401, { message: '401 Unauthorized' })
          return
        }
        const prefix = `/api/v5/repos/${OWNER}/${REPO}`
        if (request.method === 'GET' && url.pathname === prefix) {
          sendJson(response, 200, { default_branch: 'main' })
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/tags`) {
          const page = Number(url.searchParams.get('page') ?? '1')
          sendJson(response, 200, page === 1 && state.tag !== null ? [state.tag] : [])
          return
        }
        if (request.method === 'POST' && url.pathname === `${prefix}/tags`) {
          state.tagCreated = body
          state.tag = { name: body.tag_name, commit: { sha: 'branch-sha' } }
          sendJson(response, 200, state.tag)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/latest`) {
          if (state.release === null) {
            sendNotFound(response)
            return
          }
          sendJson(response, 200, withAssets())
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/tags/${TAG}`) {
          if (state.release === null) {
            sendNotFound(response)
            return
          }
          sendJson(response, 200, withAssets())
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases`) {
          const page = Number(url.searchParams.get('page') ?? '1')
          sendJson(response, 200, page === 1 && state.release !== null ? [withAssets()] : [])
          return
        }
        if (request.method === 'POST' && url.pathname === `${prefix}/releases`) {
          state.releaseCreated = body
          state.release = {
            // GitCode 经常不返回 id；同步层应回退到 tag
            tag_name: body.tag_name,
            name: body.name,
            body: body.body,
            target_commitish: body.target_commitish,
            prerelease: body.release_status === 'pre',
            release_status: body.release_status ?? 'none',
          }
          sendJson(response, 200, withAssets())
          return
        }
        if (request.method === 'PATCH' && url.pathname === `${prefix}/releases/${TAG}`) {
          state.releasePatched.push(body)
          state.release = { ...state.release, ...body }
          sendJson(response, 200, withAssets())
          return
        }
        if (
          request.method === 'GET' &&
          url.pathname === `${prefix}/releases/${TAG}/upload_url`
        ) {
          const name = url.searchParams.get('file_name')
          sendJson(response, 200, {
            url: `${state.base}/storage/gitcode-upload/${encodeURIComponent(name)}?signature=test`,
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-obs-meta-project-id': 'project',
              'x-obs-acl': 'public-read',
              'x-obs-callback': 'callback',
            },
          })
          return
        }
        if (
          request.method === 'DELETE' &&
          url.pathname.startsWith(`${prefix}/releases/${TAG}/attach_files/`)
        ) {
          const id = Number(url.pathname.split('/').pop())
          state.deletions.push(id)
          state.assets = state.assets.filter((asset) => asset.id !== id)
          response.writeHead(204)
          response.end()
          return
        }
      }
      if (request.method === 'PUT' && url.pathname.startsWith('/storage/gitcode-upload/')) {
        const name = decodeURIComponent(url.pathname.slice('/storage/gitcode-upload/'.length))
        state.uploads.push(record)
        const asset = {
          id: nextAssetId,
          name,
          size: body === undefined ? 0 : body.length,
          type: 'attach',
          digest: `sha256:${sha256(body?.toString('utf8') ?? '')}`,
          browser_download_url: `https://gitcode.com/${OWNER}/${REPO}/releases/download/${TAG}/${name}`,
        }
        nextAssetId += 1
        state.assets.push(asset)
        response.writeHead(200)
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
        GITCODE_TOKEN: '',
        GITCODE_SOURCE_TOKEN: '',
        GITCODE_TARGET_TOKEN: '',
        GITCODE_SOURCE_API_BASE: '',
        GITCODE_TARGET_API_BASE: '',
        GITCODE_API_BASE: '',
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
  `https://gitcode.com/${OWNER}/${REPO}`,
  '--tag',
  TAG,
  '--source-api-base',
  base,
  '--target-api-base',
  `${base}/api/v5`,
]

const TOKENS = {
  CNB_SOURCE_TOKEN: CNB_TOKEN,
  GITCODE_TARGET_TOKEN: GITCODE_TOKEN,
}

{
  const mock = await startMock()
  try {
    const result = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^目标发布: gitcode\.com\/owner\/repo@v1\.0\.0（已创建）$/m)
    assert.match(result.stdout, /^附件: 1 个（已上传 1，跳过 0）$/m)

    assert.deepEqual(mock.tagCreated, { refs: 'main', tag_name: TAG })
    assert.equal(mock.releaseCreated.tag_name, TAG)
    assert.equal(mock.releaseCreated.target_commitish, 'main')
    assert.equal(mock.releaseCreated.name, `${TAG} CNB 发布`)
    assert.equal(mock.releaseCreated.body, '## CNB 源说明')
    assert.equal(mock.releaseCreated.release_status, 'latest')

    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].body.toString('utf8'), 'hello')
    assert.equal(mock.uploads[0].authorization, undefined)
    assert.equal(mock.uploads[0].headers['x-obs-callback'], 'callback')
    assert.equal(mock.uploads[0].headers['x-obs-acl'], 'public-read')

    // 目标 Release 字段改成旧的 + 多一个附件：第二次应 PATCH by tag、按 digest 跳过、删除多余
    mock.release = { ...mock.release, name: '旧标题', body: '旧说明', release_status: 'none' }
    mock.assets.push({
      id: 999,
      name: 'extra.txt',
      size: 4,
      type: 'attach',
      digest: `sha256:${sha256('junk')}`,
    })
    const second = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /^附件: 1 个（已上传 0，跳过 1，删除多余 1）$/m)
    assert.equal(mock.uploads.length, 1)
    assert.deepEqual(mock.deletions, [999])
    assert.equal(mock.releasePatched.length, 1)
    assert.equal(mock.releasePatched[0].name, `${TAG} CNB 发布`)
    assert.equal(mock.releasePatched[0].body, '## CNB 源说明')
    assert.equal(mock.releasePatched[0].release_status, 'latest')

    // 目标 app.apk digest 改成旧的：第三次应删同名旧附件再上传
    mock.assets = mock.assets.map((asset) =>
      asset.name === 'app.apk' ? { ...asset, digest: `sha256:${sha256('old!!')}` } : asset,
    )
    const third = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(third.code, 0, third.stderr)
    assert.match(third.stdout, /^附件: 1 个（已上传 1，跳过 0）$/m)
    assert.equal(mock.uploads.length, 2)
    assert.ok(mock.deletions.includes(10))
    assert.equal(
      mock.assets.find((asset) => asset.name === 'app.apk').digest,
      `sha256:${sha256('hello')}`,
    )
  } finally {
    await mock.close()
  }
}

// GitCode 在“仓库存在但没有任何 Release”时返回 400: 未找到 release，应视为空
{
  const fetchImpl = async () =>
    new Response(JSON.stringify({ message: '未找到 release' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  const client = new GitcodeReleaseClient({ repo: 'owner/repo', token: 'token', fetchImpl })
  assert.equal(await client.getLatestRelease(), null)
  assert.equal(await client.getReleaseByTag(TAG), null)
}

console.log('release-sync: CNB 源 → GitCode 目标测试通过')
