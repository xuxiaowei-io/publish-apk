/**
 * release-sync：CNB 源 → GitHub 目标端到端测试。
 *
 * 覆盖：
 *   - GitHub 目标标签基于仓库默认分支创建（git/refs）；
 *   - 发布创建 / 更新、附件上传；
 *   - GitHub asset digest 与 CNB hash 对比：一致跳过、不一致先删后传；
 *   - 目标多余附件删除；
 *   - 上传地址、鉴权与 GitHub API 版本头。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { resolveGithubUploadBase } from '../src/github-release.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const CNB_TOKEN = 'cnb-source-token'
const GITHUB_TOKEN = 'github-target-token'
const SOURCE_REPO = 'org/src'
const GITHUB_OWNER = 'owner'
const GITHUB_REPO = 'repo'
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
    refCreated: undefined,
    releaseCreated: undefined,
    releasePatched: [],
    uploads: [],
    deletions: [],
    upload404: false,
    base: '',
  }
  let nextAssetId = 10

  const releaseObject = () =>
    state.release === null
      ? null
      : {
          ...state.release,
          assets: state.assets,
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
        apiVersion: request.headers['x-github-api-version'],
        contentType: request.headers['content-type'],
        contentLength: request.headers['content-length'],
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
            is_latest: false,
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

      // ---------------- GitHub 目标仓库 ----------------
      if (url.pathname.startsWith(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}`)) {
        if (record.authorization !== `Bearer ${GITHUB_TOKEN}`) {
          sendJson(response, 401, { message: 'Bad credentials' })
          return
        }
        const prefix = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`
        if (request.method === 'GET' && url.pathname === prefix) {
          sendJson(response, 200, { default_branch: 'main' })
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/git/ref/tags/${TAG}`) {
          if (state.tag === null) {
            sendNotFound(response)
            return
          }
          sendJson(response, 200, state.tag)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/git/ref/heads/main`) {
          sendJson(response, 200, { ref: 'refs/heads/main', object: { sha: 'branch-sha' } })
          return
        }
        if (request.method === 'POST' && url.pathname === `${prefix}/git/refs`) {
          state.refCreated = body
          state.tag = { ref: body.ref, object: { sha: body.sha, type: 'commit' } }
          sendJson(response, 201, state.tag)
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/latest`) {
          if (state.release === null) {
            sendNotFound(response)
            return
          }
          sendJson(response, 200, releaseObject())
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/tags/${TAG}`) {
          if (state.release === null) {
            sendNotFound(response)
            return
          }
          sendJson(response, 200, releaseObject())
          return
        }
        if (request.method === 'GET' && url.pathname === `${prefix}/releases`) {
          sendJson(response, 200, state.release === null ? [] : [releaseObject()])
          return
        }
        if (request.method === 'POST' && url.pathname === `${prefix}/releases`) {
          state.releaseCreated = body
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
        if (request.method === 'GET' && url.pathname === `${prefix}/releases/1`) {
          sendJson(response, 200, releaseObject())
          return
        }
        if (request.method === 'PATCH' && url.pathname === `${prefix}/releases/1`) {
          state.releasePatched.push(body)
          state.release = { ...state.release, ...body }
          sendJson(response, 200, releaseObject())
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
            content_type: request.headers['content-type'],
            digest: `sha256:${sha256(body?.toString('utf8') ?? '')}`,
            url: `${state.base}${prefix}/releases/assets/${nextAssetId}`,
            browser_download_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${TAG}/app.apk`,
          }
          nextAssetId += 1
          state.assets.push(asset)
          if (state.upload404) {
            // 模拟 GitHub 偶发的「附件已落盘但返回 404」
            sendJson(response, 404, { message: 'Not Found' })
            return
          }
          sendJson(response, 201, asset)
          return
        }
        if (
          request.method === 'DELETE' &&
          url.pathname.startsWith(`${prefix}/releases/assets/`)
        ) {
          const id = Number(url.pathname.split('/').pop())
          state.deletions.push(id)
          state.assets = state.assets.filter((asset) => asset.id !== id)
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
        GITHUB_TOKEN: '',
        GITHUB_SOURCE_TOKEN: '',
        GITHUB_TARGET_TOKEN: '',
        GITHUB_SOURCE_API_BASE: '',
        GITHUB_TARGET_API_BASE: '',
        GITHUB_API_BASE: '',
        GITHUB_API_URL: '',
        GITHUB_SOURCE_UPLOAD_BASE: '',
        GITHUB_TARGET_UPLOAD_BASE: '',
        GITHUB_UPLOAD_BASE: '',
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
  `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
  '--tag',
  TAG,
  '--source-api-base',
  base,
  '--target-api-base',
  base,
  '--make-latest',
  'true',
]

const TOKENS = {
  CNB_SOURCE_TOKEN: CNB_TOKEN,
  GITHUB_TARGET_TOKEN: GITHUB_TOKEN,
}

// 1) 创建标签 / 发布并上传附件；第二次按 digest 跳过并删除多余附件
{
  const mock = await startMock()
  try {
    const result = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^目标发布: github\.com\/owner\/repo@v1\.0\.0（已创建）$/m)
    assert.match(result.stdout, /^附件: 1 个（已上传 1，跳过 0）$/m)

    assert.deepEqual(mock.refCreated, { ref: `refs/tags/${TAG}`, sha: 'branch-sha' })
    assert.equal(mock.releaseCreated.tag_name, TAG)
    assert.equal(mock.releaseCreated.target_commitish, 'main')
    assert.equal(mock.releaseCreated.name, `${TAG} CNB 发布`)
    assert.equal(mock.releaseCreated.body, '## CNB 源说明')
    assert.equal(mock.releaseCreated.draft, false)
    assert.equal(mock.releaseCreated.prerelease, false)
    assert.equal(mock.releaseCreated.make_latest, 'true')

    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].query.name, 'app.apk')
    assert.equal(mock.uploads[0].authorization, `Bearer ${GITHUB_TOKEN}`)
    assert.equal(mock.uploads[0].apiVersion, '2022-11-28')
    assert.equal(mock.uploads[0].contentType, 'application/vnd.android.package-archive')
    assert.equal(mock.uploads[0].body.toString('utf8'), 'hello')

    // 目标发布创建后补一个多余附件，第二次应删除
    mock.assets.push({
      id: 999,
      name: 'extra.txt',
      size: 4,
      digest: `sha256:${sha256('junk')}`,
      browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/extra.txt',
    })
    const second = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /^附件: 1 个（已上传 0，跳过 1，删除多余 1）$/m)
    assert.equal(mock.uploads.length, 1)
    assert.deepEqual(mock.deletions, [999])
    assert.equal(mock.releasePatched.length, 0)

    // 把目标 app.apk 的 digest 改成旧的：第三次应删旧再传新；
    // 同时模拟上传接口返回 404，但附件实际已落盘，客户端应核对 digest 后按成功处理
    mock.assets = mock.assets.map((asset) =>
      asset.name === 'app.apk' ? { ...asset, digest: `sha256:${sha256('old!!')}` } : asset,
    )
    mock.upload404 = true
    const third = await runCli(ARGS(mock.base), TOKENS)
    assert.equal(third.code, 0, third.stderr)
    assert.match(third.stdout, /^附件: 1 个（已上传 1，跳过 0）$/m)
    assert.equal(mock.uploads.length, 2)
    assert.ok(mock.deletions.includes(10)) // 第一次上传的 app.apk id
    assert.equal(mock.assets.find((asset) => asset.name === 'app.apk').digest, `sha256:${sha256('hello')}`)
  } finally {
    await mock.close()
  }
}

// 2) 上传地址推断：github.com / GHES / 自定义
{
  assert.equal(
    resolveGithubUploadBase({}, 'target', 'https://api.github.com'),
    'https://uploads.github.com',
  )
  assert.equal(
    resolveGithubUploadBase({}, 'target', 'https://ghe.example.com/api/v3'),
    'https://ghe.example.com/api/uploads',
  )
  assert.equal(
    resolveGithubUploadBase(
      { GITHUB_TARGET_UPLOAD_BASE: 'https://uploads.example.com' },
      'target',
      'https://api.github.com',
    ),
    'https://uploads.example.com',
  )
  assert.equal(
    resolveGithubUploadBase({}, 'target', 'http://127.0.0.1:1234'),
    'http://127.0.0.1:1234',
  )
}

// --make-latest 非法值应直接报参数错误
{
  const invalid = await runCli(
    [
      'release-sync',
      '--source',
      `https://cnb.cool/${SOURCE_REPO}`,
      '--target',
      `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
      '--tag',
      TAG,
      '--make-latest',
      'maybe',
      '--source-token',
      'x',
      '--target-token',
      'y',
    ],
    {},
  )
  assert.equal(invalid.code, 1)
  assert.match(invalid.stderr, /--make-latest 只能是 true \/ false/)
}

console.log('release-sync: CNB 源 → GitHub 目标测试通过')
