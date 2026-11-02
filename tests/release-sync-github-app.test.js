/**
 * release-sync：CNB 源 → GitHub 目标，`.app` 附件打包测试。
 *
 * GitHub Release 会拒绝 `.app` 后缀；目标为 GitHub 时应先打成 zip：
 *   mac.app -> mac.app.zip
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const CNB_TOKEN = 'cnb-source-token'
const GITHUB_TOKEN = 'github-target-token'
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
    tag: null,
    release: null,
    assets: [],
    uploads: [],
    deletions: [],
    base: '',
  }
  let nextAssetId = 10

  const releaseObject = () =>
    state.release === null ? null : { ...state.release, assets: state.assets }

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

      // ---------------- CNB 源仓库 ----------------
      if (url.pathname.startsWith(`/${SOURCE_REPO}/-/`)) {
        if (request.headers.authorization !== `Bearer ${CNB_TOKEN}`) {
          sendJson(response, 401, { errcode: 16, errmsg: 'not logged in' })
          return
        }
        if (request.method === 'GET' && url.pathname === `/${SOURCE_REPO}/-/releases/tags/${TAG}`) {
          sendJson(response, 200, {
            id: 'cnb-1',
            tag_name: TAG,
            name: 'macOS app',
            body: 'notes',
            draft: false,
            prerelease: false,
            is_latest: true,
            assets: [
              {
                id: 'cnb-asset-1',
                name: 'mac.app',
                size: 3,
                content_type: 'application/octet-stream',
                hash_algo: 'sha256',
                hash_value: sha256('app'),
                browser_download_url: `https://cnb.cool/${SOURCE_REPO}/-/releases/download/${TAG}/mac.app`,
              },
            ],
          })
          return
        }
        if (request.method === 'GET' && url.pathname === `/${SOURCE_REPO}/-/releases/download/${TAG}/mac.app`) {
          response.writeHead(302, { location: `${state.base}/storage/mac.app` })
          response.end()
          return
        }
      }
      if (request.method === 'GET' && url.pathname === '/storage/mac.app') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end('app')
        return
      }

      // ---------------- GitHub 目标仓库 ----------------
      if (url.pathname.startsWith(`/repos/${OWNER}/${REPO}`)) {
        if (request.headers.authorization !== `Bearer ${GITHUB_TOKEN}`) {
          sendJson(response, 401, { message: 'Bad credentials' })
          return
        }
        const prefix = `/repos/${OWNER}/${REPO}`
        if (request.method === 'GET' && url.pathname === prefix) {
          sendJson(response, 200, { default_branch: 'main' })
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/git/ref/tags/${TAG}`) {
          if (state.tag === null) {
            sendJson(response, 404, { message: 'Not Found' })
            return
          }
          sendJson(response, 200, state.tag)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/git/ref/heads/main`) {
          sendJson(response, 200, { object: { sha: 'branch-sha' } })
          return
        }
        if (request.method === 'POST' && url.pathname === `${prefix}/git/refs`) {
          state.tag = { ref: body.ref, object: { sha: body.sha } }
          sendJson(response, 201, state.tag)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/tags/${TAG}`) {
          if (state.release === null) {
            sendJson(response, 404, { message: 'Not Found' })
            return
          }
          sendJson(response, 200, releaseObject())
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/latest`) {
          if (state.release === null) {
            sendJson(response, 404, { message: 'Not Found' })
            return
          }
          sendJson(response, 200, releaseObject())
          return
        }
        if (request.method === 'POST' && url.pathname === `${prefix}/releases`) {
          state.release = {
            id: 1,
            tag_name: body.tag_name,
            name: body.name,
            body: body.body,
            draft: body.draft === true,
            prerelease: body.prerelease === true,
          }
          sendJson(response, 201, releaseObject())
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/1/assets`) {
          const page = Number(url.searchParams.get('page') ?? '1')
          sendJson(response, 200, page === 1 ? state.assets : [])
          return
        }
        if (request.method === 'POST' && url.pathname === `${prefix}/releases/1/assets`) {
          state.uploads.push(record)
          const asset = {
            id: nextAssetId,
            name: url.searchParams.get('name'),
            size: body === undefined ? 0 : body.length,
            digest: `sha256:${sha256(body?.toString('utf8') ?? '')}`,
            browser_download_url: `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${url.searchParams.get('name')}`,
          }
          nextAssetId += 1
          state.assets.push(asset)
          sendJson(response, 201, asset)
          return
        }
        if (request.method === 'DELETE' && url.pathname.startsWith(`${prefix}/releases/assets/`)) {
          const id = Number(url.pathname.split('/').pop())
          state.deletions.push(id)
          state.assets = state.assets.filter((asset) => asset.id !== id)
          response.writeHead(204)
          response.end()
          return
        }
      }

      sendJson(response, 404, { message: 'Not Found' })
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
        GITHUB_TOKEN: '',
        GITHUB_SOURCE_TOKEN: '',
        GITHUB_TARGET_TOKEN: '',
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
        `https://cnb.cool/${SOURCE_REPO}`,
        '--target',
        `https://github.com/${OWNER}/${REPO}`,
        '--tag',
        TAG,
        '--source-api-base',
        mock.base,
        '--target-api-base',
        mock.base,
      ],
      {
        CNB_SOURCE_TOKEN: CNB_TOKEN,
        GITHUB_TARGET_TOKEN: GITHUB_TOKEN,
      },
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^附件: 1 个（已上传 1，跳过 0）$/m)
    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].query.name, 'mac.app.zip')
    const zip = mock.uploads[0].body
    assert.equal(zip.subarray(0, 2).toString('latin1'), 'PK')
    assert.match(zip.toString('latin1'), /mac\.app/)
    assert.equal(zip.includes(Buffer.from('app')), true)
    assert.deepEqual(
      mock.assets.map((asset) => asset.name),
      ['mac.app.zip'],
    )
  } finally {
    await mock.close()
  }
}

console.log('release-sync: GitHub 目标 .app 打包测试通过')
