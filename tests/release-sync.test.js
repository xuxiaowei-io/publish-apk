/**
 * release-sync 端到端测试：`node tests/release-sync.test.js`。
 *
 * 不联网：测试进程里起一个本地 HTTP 服务模拟 CNB Open API，再用子进程执行真实 CLI，
 * 覆盖「查询源发布 → 基于分支建标签 → 创建 / 更新目标发布 → 下载并上传附件」全流程。
 *
 * 断言重点：
 *   - 请求路径、方法与 Bearer 令牌（源 / 目标各用各的）；
 *   - 发布字段（标题、说明、草稿、预发布、最新）与目标标签起点；
 *   - 附件内容原样搬运、同名附件覆盖、hash 一致时跳过；
 *   - 预签名上传不带 CNB 令牌；
 *   - --dry-run 不产生任何写请求；
 *   - 缺参数 / 不支持的平台给出明确错误。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { parseRepositoryValue } from '../src/release-sync.js'
import { CnbReleaseClient } from '../src/cnb.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = 'src/publish-apk.js'
const SOURCE_TOKEN = 'source-token'
const TARGET_TOKEN = 'target-token'
const SOURCE_REPO = 'org/src'
const TARGET_REPO = 'org/dst'
const TAG = 'v1.0.0'

/** 计算十六进制 sha256，用于构造附件元数据 */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** 读取请求体：JSON 解析，其它按 Buffer 保留 */
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
          // 解析失败时保留原始内容，便于断言失败时排查
        }
      }
      resolve(buffer)
    })
  })
}

/** 返回 JSON 响应 */
function sendJson(response, status, payload) {
  const text = payload === undefined ? '' : JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/vnd.cnb.api+json',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/** 返回 404（CNB 风格的错误体，客户端据此判断「还没有」） */
function sendNotFound(response) {
  sendJson(response, 404, { errcode: 404, errmsg: 'not found' })
}

/**
 * 启动模拟 CNB 服务。
 *
 * @param {{
 *   targetRelease?: object|null,
 *   targetTag?: object|null,
 *   sourceFiles?: Record<string, string>,
 *   tokens?: { source: string, target: string },
 * }} scenario
 */
async function startMockCnb(scenario = {}) {
  const state = {
    requests: [],
    sourceRelease: null,
    targetRelease: scenario.targetRelease ?? null,
    targetTag: scenario.targetTag ?? null,
    sourceFiles: scenario.sourceFiles ?? { 'app.apk': 'hello' },
    tokens: scenario.tokens ?? { source: SOURCE_TOKEN, target: TARGET_TOKEN },
    patchEmpty: scenario.patchEmpty === true,
    createEmpty: scenario.createEmpty === true,
    tagCreated: undefined,
    releaseCreated: undefined,
    releasePatched: undefined,
    uploads: [],
    confirmations: [],
    deletions: [],
    sourceDownloads: [],
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1')
      const body = await readRequestBody(request)
      const record = {
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        contentLength: request.headers['content-length'],
        body,
      }
      state.requests.push(record)

      const isApi =
        url.pathname.startsWith(`/${SOURCE_REPO}/-/`) || url.pathname.startsWith(`/${TARGET_REPO}/-/`)

      // 令牌校验：源 / 目标各用各的；对象存储（预签名地址）不允许带 CNB 令牌
      if (isApi) {
        const expected = url.pathname.startsWith(`/${SOURCE_REPO}/-/`)
          ? `Bearer ${state.tokens.source}`
          : `Bearer ${state.tokens.target}`
        if (record.authorization !== expected) {
          sendJson(response, 401, { errcode: 16, errmsg: 'not logged in' })
          return
        }
      }

      // ---- 源仓库：发布查询与下载 ----
      if (request.method === 'GET' && url.pathname === `/${SOURCE_REPO}/-/releases/latest`) {
        if (state.sourceRelease === null) {
          sendNotFound(response)
          return
        }
        sendJson(response, 200, state.sourceRelease)
        return
      }
      if (request.method === 'GET' && url.pathname === `/${SOURCE_REPO}/-/releases`) {
        // 按标签查不到时 release-sync 会回退到发布列表
        sendJson(response, 200, state.sourceRelease === null ? [] : [state.sourceRelease])
        return
      }
      if (
        request.method === 'GET' &&
        url.pathname.startsWith(`/${SOURCE_REPO}/-/releases/tags/`)
      ) {
        const tag = decodeURIComponent(url.pathname.slice(`/${SOURCE_REPO}/-/releases/tags/`.length))
        if (state.sourceRelease === null || state.sourceRelease.tag_name !== tag) {
          sendNotFound(response)
          return
        }
        sendJson(response, 200, state.sourceRelease)
        return
      }
      if (
        request.method === 'GET' &&
        url.pathname.startsWith(`/${SOURCE_REPO}/-/releases/download/`)
      ) {
        state.sourceDownloads.push(record)
        const filename = decodeURIComponent(url.pathname.split('/').pop())
        response.writeHead(302, { location: `${state.base}/storage/source/${encodeURIComponent(filename)}` })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/storage/source/')) {
        const filename = decodeURIComponent(url.pathname.slice('/storage/source/'.length))
        const content = state.sourceFiles[filename]
        if (content === undefined) {
          sendNotFound(response)
          return
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(content)
        return
      }

      // ---- 目标仓库：标签 ----
      if (request.method === 'GET' && url.pathname === `/${TARGET_REPO}/-/git/tags`) {
        sendJson(response, 200, state.targetTag === null ? [] : [state.targetTag])
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith(`/${TARGET_REPO}/-/git/tags/`)) {
        const tag = decodeURIComponent(url.pathname.slice(`/${TARGET_REPO}/-/git/tags/`.length))
        if (state.targetTag === null || state.targetTag.name !== tag) {
          sendNotFound(response)
          return
        }
        sendJson(response, 200, state.targetTag)
        return
      }
      if (request.method === 'POST' && url.pathname === `/${TARGET_REPO}/-/git/tags`) {
        state.tagCreated = body
        state.targetTag = { name: body.name, target: body.target }
        sendJson(response, 201, state.targetTag)
        return
      }

      // ---- 目标仓库：发布 ----
      if (request.method === 'GET' && url.pathname === `/${TARGET_REPO}/-/releases`) {
        sendJson(response, 200, state.targetRelease === null ? [] : [state.targetRelease])
        return
      }
      if (
        request.method === 'GET' &&
        url.pathname.startsWith(`/${TARGET_REPO}/-/releases/tags/`)
      ) {
        const tag = decodeURIComponent(url.pathname.slice(`/${TARGET_REPO}/-/releases/tags/`.length))
        if (state.targetRelease === null || state.targetRelease.tag_name !== tag) {
          sendNotFound(response)
          return
        }
        sendJson(response, 200, state.targetRelease)
        return
      }
      if (request.method === 'POST' && url.pathname === `/${TARGET_REPO}/-/releases`) {
        state.releaseCreated = body
        state.targetRelease = { id: 'dst-release-1', ...body, assets: [] }
        if (state.createEmpty) {
          // 模拟创建接口只回 204 空 body 的实现
          response.writeHead(204)
          response.end()
          return
        }
        sendJson(response, 201, state.targetRelease)
        return
      }
      if (
        request.method === 'PATCH' &&
        url.pathname === `/${TARGET_REPO}/-/releases/dst-release-1`
      ) {
        state.releasePatched = body
        state.targetRelease = { ...state.targetRelease, ...body }
        if (state.patchEmpty) {
          // 真实 CNB 的 PATCH 可能返回 204 / 空 body，客户端不能把它当发布数据
          response.writeHead(204)
          response.end()
          return
        }
        sendJson(response, 200, state.targetRelease)
        return
      }

      // 删除目标多余附件；返回 204 空 body
      if (
        request.method === 'DELETE' &&
        /^\/org\/dst\/-\/releases\/[^/]+\/assets\/[^/]+$/.test(url.pathname)
      ) {
        const assetId = decodeURIComponent(url.pathname.split('/').pop())
        state.deletions.push({ assetId, path: url.pathname })
        if (Array.isArray(state.targetRelease?.assets)) {
          state.targetRelease.assets = state.targetRelease.assets.filter(
            (asset) => String(asset.id) !== assetId,
          )
        }
        response.writeHead(204)
        response.end()
        return
      }

      // ---- 目标仓库：附件上传 ----
      if (
        request.method === 'POST' &&
        /^\/org\/dst\/-\/releases\/[^/]+\/asset-upload-url$/.test(url.pathname)
      ) {
        const assetName = String(body?.asset_name ?? 'asset')
        sendJson(response, 201, {
          upload_url: `${state.base}/storage/upload/${encodeURIComponent(assetName)}?signature=test`,
          verify_url: `${state.base}${url.pathname.replace(
            '/asset-upload-url',
            '/asset-upload-confirmation/token/asset',
          )}`,
          expires_in_sec: 600,
        })
        return
      }
      if (request.method === 'PUT' && url.pathname.startsWith('/storage/upload/')) {
        state.uploads.push({ ...record, filename: decodeURIComponent(url.pathname.slice('/storage/upload/'.length)) })
        response.writeHead(200)
        response.end()
        return
      }
      if (
        request.method === 'POST' &&
        /^\/org\/dst\/-\/releases\/[^/]+\/asset-upload-confirmation\//.test(url.pathname)
      ) {
        state.confirmations.push(record)
        sendJson(response, 200)
        return
      }

      sendNotFound(response)
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { errcode: 500, errmsg: 'mock error' })
      } else {
        response.end()
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.base = `http://127.0.0.1:${server.address().port}`
  state.setSourceRelease = (release) => {
    state.sourceRelease = release
  }
  state.close = async () => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    }
    await new Promise((resolve) => server.close(resolve))
  }
  return state
}

/** 执行真实 CLI，返回退出代码与输出 */
function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // 避免本机环境里的 CNB 变量干扰测试
        CNB_TOKEN: '',
        CNB_SOURCE_TOKEN: '',
        CNB_TARGET_TOKEN: '',
        CNB_SOURCE_API_BASE: '',
        CNB_TARGET_API_BASE: '',
        CNB_API_BASE: '',
        RELEASE_SYNC_SOURCE: '',
        RELEASE_SYNC_TARGET: '',
        RELEASE_SYNC_TAG: '',
        RELEASE_SYNC_TARGET_BRANCH: '',
        RELEASE_SYNC_SOURCE_TOKEN: '',
        RELEASE_SYNC_TARGET_TOKEN: '',
        RELEASE_SYNC_SOURCE_API_BASE: '',
        RELEASE_SYNC_TARGET_API_BASE: '',
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

/** 构造源发布；asset.url 指向模拟服务 */
function sourceRelease(base, overrides = {}) {
  return {
    id: 'src-release-1',
    tag_name: TAG,
    name: `${TAG} 发布`,
    body: '## 更新\n- 修复 A\n- 优化 B',
    draft: false,
    prerelease: true,
    is_latest: true,
    assets: [
      {
        id: 'asset-1',
        name: 'app.apk',
        size: 5,
        url: `${base}/${SOURCE_REPO}/-/releases/download/${TAG}/app.apk`,
        content_type: 'application/vnd.android.package-archive',
        hash_algo: 'sha256',
        hash_value: sha256('hello'),
      },
    ],
    ...overrides,
  }
}

/** 统一的 release-sync 参数：仓库地址 + 模拟 API 地址 */
function syncArgs(base, extra = []) {
  return [
    'release-sync',
    '--source',
    `https://cnb.cool/${SOURCE_REPO}`,
    '--target',
    `cnb.cool/${TARGET_REPO}`,
    '--source-api-base',
    base,
    '--target-api-base',
    base,
    ...extra,
  ]
}

/** 统一的令牌环境变量 */
const TOKEN_ENV = {
  CNB_SOURCE_TOKEN: SOURCE_TOKEN,
  CNB_TARGET_TOKEN: TARGET_TOKEN,
}

// 1) 全新建标签 + 创建发布 + 搬运附件
{
  const mock = await startMockCnb({ targetRelease: null, targetTag: null })
  mock.setSourceRelease(sourceRelease(mock.base))
  try {
    const result = await runCli(
      syncArgs(mock.base, ['--tag', TAG, '--target-branch', 'release/1.0']),
      TOKEN_ENV,
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^源发布: cnb\.cool\/org\/src@v1\.0\.0$/m)
    assert.match(result.stdout, /^目标发布: cnb\.cool\/org\/dst@v1\.0\.0（已创建）$/m)
    assert.match(result.stdout, /^目标标签: v1\.0\.0（基于 release\/1\.0 创建）$/m)
    assert.match(result.stdout, /^附件: 1 个（已上传 1，跳过 0）$/m)
    assert.match(result.stdout, /^- app\.apk（5 B，已上传）$/m)

    assert.deepEqual(mock.tagCreated, { name: TAG, target: 'release/1.0' })
    assert.equal(mock.releaseCreated.tag_name, TAG)
    assert.equal(mock.releaseCreated.target_commitish, 'release/1.0')
    assert.equal(mock.releaseCreated.name, `${TAG} 发布`)
    assert.equal(mock.releaseCreated.body, '## 更新\n- 修复 A\n- 优化 B')
    assert.equal(mock.releaseCreated.draft, false)
    assert.equal(mock.releaseCreated.prerelease, true)
    assert.equal(mock.releaseCreated.make_latest, 'true')

    const uploadUrlRequest = mock.requests.find((item) => item.path.endsWith('/asset-upload-url'))
    assert.deepEqual(uploadUrlRequest.body, { asset_name: 'app.apk', size: 5, overwrite: true })

    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].body.toString('utf8'), 'hello')
    assert.equal(mock.uploads[0].authorization, undefined)
    assert.equal(mock.uploads[0].contentLength, '5')
    assert.equal(mock.uploads[0].contentType, 'application/vnd.android.package-archive')
    assert.equal(mock.confirmations.length, 1)
    assert.equal(mock.confirmations[0].authorization, `Bearer ${TARGET_TOKEN}`)
    assert.equal(mock.sourceDownloads.length, 1)
    assert.equal(mock.sourceDownloads[0].authorization, `Bearer ${SOURCE_TOKEN}`)
    assert.match(result.stderr, /app\.apk: 已上传/)
  } finally {
    await mock.close()
  }
}

// 2) 更新已有发布：字段更新、同名附件按 hash 决定跳过或覆盖
{
  const appHash = sha256('hello')
  const mock = await startMockCnb({
    targetRelease: {
      id: 'dst-release-1',
      tag_name: TAG,
      name: '旧标题',
      body: '旧说明',
      draft: false,
      prerelease: false,
      is_latest: false,
      assets: [
        {
          id: 'old-1',
          name: 'app.apk',
          size: 5,
          hash_algo: 'sha256',
          // 目标用 base64、源用十六进制，归一化后仍应判定为同一内容
          hash_value: Buffer.from(appHash, 'hex').toString('base64'),
        },
        { id: 'old-2', name: 'notes.txt', size: 6, hash_algo: 'sha256', hash_value: sha256('old!!!') },
      ],
    },
    targetTag: { name: TAG, target: 'main' },
    sourceFiles: { 'app.apk': 'hello', 'notes.txt': 'new!!!' },
  })
  mock.setSourceRelease(
    sourceRelease(mock.base, {
      name: '新标题',
      body: '新说明',
      prerelease: false,
      is_latest: true,
      assets: [
        {
          id: 'asset-1',
          name: 'app.apk',
          size: 5,
          url: `${mock.base}/${SOURCE_REPO}/-/releases/download/${TAG}/app.apk`,
          hash_algo: 'sha256',
          hash_value: appHash,
        },
        {
          id: 'asset-2',
          name: 'notes.txt',
          size: 6,
          url: `${mock.base}/${SOURCE_REPO}/-/releases/download/${TAG}/notes.txt`,
          hash_algo: 'sha256',
          hash_value: sha256('new!!!'),
        },
      ],
    }),
  )
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', TAG]), TOKEN_ENV)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^目标发布: cnb\.cool\/org\/dst@v1\.0\.0（已更新）$/m)
    assert.match(result.stdout, /^目标标签: v1\.0\.0（已存在）$/m)
    assert.match(result.stdout, /^附件: 2 个（已上传 1，跳过 1）$/m)
    assert.match(result.stdout, /^- app\.apk（5 B，目标已存在且 hash 一致）$/m)
    assert.match(result.stdout, /^- notes\.txt（6 B，已上传）$/m)

    assert.equal(mock.tagCreated, undefined)
    assert.deepEqual(mock.releasePatched, {
      name: '新标题',
      body: '新说明',
      draft: false,
      prerelease: false,
      make_latest: 'true',
    })
    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].filename, 'notes.txt')
    assert.equal(mock.uploads[0].body.toString('utf8'), 'new!!!')
    assert.match(result.stderr, /notes\.txt: 下载中/)
    assert.match(result.stderr, /app\.apk: 目标已存在且 hash 一致，跳过/)
  } finally {
    await mock.close()
  }
}

// 3) PATCH 返回空 body 的重试：SHA 相同跳过、不同覆盖、目标多余附件删除
{
  const mock = await startMockCnb({
    patchEmpty: true,
    targetRelease: {
      id: 'dst-release-1',
      tag_name: TAG,
      name: '旧标题',
      body: '旧说明',
      draft: false,
      prerelease: false,
      is_latest: false,
      assets: [
        { id: 'same-1', name: 'same.txt', size: 5, hash_algo: 'sha256', hash_value: sha256('hello') },
        { id: 'change-1', name: 'change.txt', size: 5, hash_algo: 'sha256', hash_value: sha256('old!!') },
        { id: 'extra-1', name: 'extra.txt', size: 5, hash_algo: 'sha256', hash_value: sha256('extra') },
      ],
    },
    targetTag: { name: TAG, target: 'main' },
    sourceFiles: { 'same.txt': 'hello', 'change.txt': 'new!!' },
  })
  const asset = (name, content) => ({
    id: `src-${name}`,
    name,
    size: content.length,
    url: `${mock.base}/${SOURCE_REPO}/-/releases/download/${TAG}/${name}`,
    hash_algo: 'sha256',
    hash_value: sha256(content),
  })
  mock.setSourceRelease(
    sourceRelease(mock.base, {
      name: '新标题',
      body: '新说明',
      is_latest: true,
      assets: [asset('same.txt', 'hello'), asset('change.txt', 'new!!')],
    }),
  )
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', TAG]), TOKEN_ENV)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^目标发布: cnb\.cool\/org\/dst@v1\.0\.0（已更新）$/m)
    assert.match(
      result.stdout,
      /^附件: 2 个（已上传 1，跳过 1，删除多余 1）$/m,
    )
    assert.match(result.stdout, /^- same\.txt（5 B，目标已存在且 hash 一致）$/m)
    assert.match(result.stdout, /^- change\.txt（5 B，已上传）$/m)
    assert.match(result.stdout, /^- extra\.txt（5 B，已从目标删除）$/m)

    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].filename, 'change.txt')
    assert.equal(mock.uploads[0].body.toString('utf8'), 'new!!')
    assert.deepEqual(mock.deletions.map((item) => item.assetId), ['extra-1'])
    assert.match(result.stderr, /多余附件 1\/1 extra\.txt: 已删除/)
  } finally {
    await mock.close()
  }
}

// 4) 发布字段完全一致：不调用 PATCH，附件全部 SHA 跳过
{
  const mock = await startMockCnb({
    targetRelease: {
      id: 'dst-release-1',
      tag_name: TAG,
      name: `${TAG} 发布`,
      body: '## 更新\n- 修复 A\n- 优化 B',
      draft: false,
      prerelease: true,
      is_latest: true,
      assets: [
        { id: 'same-1', name: 'app.apk', size: 5, hash_algo: 'sha256', hash_value: sha256('hello') },
      ],
    },
    targetTag: { name: TAG, target: 'main' },
  })
  mock.setSourceRelease(sourceRelease(mock.base))
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', TAG]), TOKEN_ENV)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^目标发布: cnb\.cool\/org\/dst@v1\.0\.0（已存在，无需更新）$/m)
    assert.match(result.stdout, /^附件: 1 个（已上传 0，跳过 1）$/m)
    assert.equal(mock.releasePatched, undefined)
    assert.equal(mock.uploads.length, 0)
  } finally {
    await mock.close()
  }
}

// 5) 源发布没有附件：删除目标上全部多余附件
{
  const mock = await startMockCnb({
    patchEmpty: true,
    targetRelease: {
      id: 'dst-release-1',
      tag_name: TAG,
      name: TAG,
      body: '',
      is_latest: false,
      assets: [
        { id: 'extra-a', name: 'a.txt', size: 1, hash_algo: 'sha256', hash_value: sha256('a') },
        { id: 'extra-b', name: 'b.txt', size: 1, hash_algo: 'sha256', hash_value: sha256('b') },
      ],
    },
    targetTag: { name: TAG, target: 'main' },
  })
  mock.setSourceRelease(sourceRelease(mock.base, { assets: [] }))
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', TAG]), TOKEN_ENV)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^附件: 0 个（已上传 0，跳过 0，删除多余 2）$/m)
    assert.deepEqual(mock.deletions.map((item) => item.assetId), ['extra-a', 'extra-b'])
    assert.equal(mock.uploads.length, 0)
  } finally {
    await mock.close()
  }
}

// 6) --dry-run 展示待删除的目标多余附件，但不发删除请求
{
  const mock = await startMockCnb({
    targetRelease: {
      id: 'dst-release-1',
      tag_name: TAG,
      name: TAG,
      body: '',
      is_latest: false,
      assets: [
        { id: 'extra-1', name: 'extra.txt', size: 5, hash_algo: 'sha256', hash_value: sha256('extra') },
      ],
    },
    targetTag: { name: TAG, target: 'main' },
  })
  mock.setSourceRelease(
    sourceRelease(mock.base, {
      assets: [
        {
          id: 'src-1',
          name: 'app.apk',
          size: 5,
          url: `${mock.base}/${SOURCE_REPO}/-/releases/download/${TAG}/app.apk`,
          hash_algo: 'sha256',
          hash_value: sha256('hello'),
        },
      ],
    }),
  )
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', TAG, '--dry-run']), TOKEN_ENV)
    assert.equal(result.code, 0, result.stderr)
    assert.match(
      result.stdout,
      /^附件: 1 个（待上传 1，已存在且 hash 一致 0，待删除多余 1）$/m,
    )
    assert.match(result.stdout, /^- extra\.txt（5 B，将从目标删除）$/m)
    assert.deepEqual(
      mock.requests.filter((item) => item.method !== 'GET'),
      [],
    )
    assert.equal(mock.deletions.length, 0)
  } finally {
    await mock.close()
  }
}

// 7) --dry-run：只读，不创建标签 / 发布，不上传附件
{
  const mock = await startMockCnb({ targetRelease: null, targetTag: null })
  mock.setSourceRelease(sourceRelease(mock.base))
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', TAG, '--dry-run']), TOKEN_ENV)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^\[dry-run\] 未修改任何内容$/m)
    assert.match(result.stdout, /^目标发布: cnb\.cool\/org\/dst@v1\.0\.0（将创建）$/m)
    assert.match(result.stdout, /^目标标签: v1\.0\.0（将基于 main 创建）$/m)
    assert.match(result.stdout, /^附件: 1 个（待上传 1，已存在且 hash 一致 0）$/m)
    assert.match(result.stdout, /^- app\.apk（5 B，待上传）$/m)

    const writes = mock.requests.filter((item) => item.method !== 'GET')
    assert.deepEqual(writes, [])
    assert.equal(mock.tagCreated, undefined)
    assert.equal(mock.releaseCreated, undefined)
  } finally {
    await mock.close()
  }
}

// 8) 不传 --tag：同步最新发布；源 / 目标可用同一个 CNB_TOKEN
{
  const mock = await startMockCnb({
    targetRelease: null,
    targetTag: null,
    tokens: { source: 'shared-token', target: 'shared-token' },
  })
  mock.setSourceRelease(
    sourceRelease(mock.base, {
      tag_name: 'v2.0.0',
      name: 'v2.0.0',
      assets: [],
    }),
  )
  try {
    // 源 / 目标 / API 地址全部走环境变量，令牌用两者共用的 CNB_TOKEN
    const result = await runCli(['release-sync'], {
      CNB_TOKEN: 'shared-token',
      RELEASE_SYNC_SOURCE: `https://cnb.cool/${SOURCE_REPO}`,
      RELEASE_SYNC_TARGET: `cnb.cool/${TARGET_REPO}`,
      RELEASE_SYNC_SOURCE_API_BASE: mock.base,
      RELEASE_SYNC_TARGET_API_BASE: mock.base,
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^源发布: cnb\.cool\/org\/src@v2\.0\.0$/m)
    assert.match(result.stdout, /^目标发布: cnb\.cool\/org\/dst@v2\.0\.0（已创建）$/m)
    assert.match(result.stdout, /^附件: 无$/m)
    assert.equal(mock.releaseCreated.tag_name, 'v2.0.0')
  } finally {
    await mock.close()
  }
}

// 9) 标签名带 `/`：目标查不到时走列表回退，再按分支创建
{
  const slashTag = 'release/v1.0.0'
  const mock = await startMockCnb({ targetRelease: null, targetTag: null })
  mock.setSourceRelease(
    sourceRelease(mock.base, {
      tag_name: slashTag,
      name: slashTag,
      assets: [],
    }),
  )
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', slashTag]), TOKEN_ENV)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`^源发布: cnb\\.cool/org/src@${slashTag}$`, 'm'))
    assert.match(result.stdout, new RegExp(`^目标标签: ${slashTag}（基于 main 创建）$`, 'm'))
    assert.deepEqual(mock.tagCreated, { name: slashTag, target: 'main' })
    assert.equal(mock.releaseCreated.tag_name, slashTag)
  } finally {
    await mock.close()
  }
}

// 10) 目标标签已存在、发布不存在：不重复建标签，直接创建发布
{
  const mock = await startMockCnb({
    targetRelease: null,
    targetTag: { name: TAG, target: 'main' },
  })
  mock.setSourceRelease(sourceRelease(mock.base))
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', TAG]), TOKEN_ENV)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^目标标签: v1\.0\.0（已存在）$/m)
    assert.match(result.stdout, /^目标发布: cnb\.cool\/org\/dst@v1\.0\.0（已创建）$/m)
    assert.equal(mock.tagCreated, undefined)
    assert.equal(mock.releaseCreated.tag_name, TAG)
    assert.equal(mock.releaseCreated.target_commitish, 'main')
  } finally {
    await mock.close()
  }
}

// 11) 创建接口返回空 body：按标签回查后再继续（没有附件时也能完成）
{
  const mock = await startMockCnb({
    targetRelease: null,
    targetTag: null,
    createEmpty: true,
  })
  mock.setSourceRelease(sourceRelease(mock.base, { assets: [] }))
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', TAG]), TOKEN_ENV)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^目标发布: cnb\.cool\/org\/dst@v1\.0\.0（已创建）$/m)
    assert.match(result.stdout, /^附件: 无$/m)
    assert.equal(mock.releaseCreated.tag_name, TAG)
    const targetReads = mock.requests.filter(
      (item) =>
        item.method === 'GET' &&
        item.path === `/${TARGET_REPO}/-/releases/tags/${TAG}`,
    )
    // 第一次查询确认不存在，创建后因空 body 再回查一次
    assert.equal(targetReads.length, 2)
  } finally {
    await mock.close()
  }
}

// 12) 空附件（0 字节）：Content-Length 为 0，不走流式上传
{
  const mock = await startMockCnb({
    targetRelease: null,
    targetTag: null,
    sourceFiles: { 'empty.txt': '' },
  })
  mock.setSourceRelease(
    sourceRelease(mock.base, {
      tag_name: TAG,
      name: TAG,
      assets: [
        {
          id: 'asset-empty',
          name: 'empty.txt',
          size: 0,
          url: `${mock.base}/${SOURCE_REPO}/-/releases/download/${TAG}/empty.txt`,
          hash_algo: 'sha256',
          hash_value: sha256(''),
        },
      ],
    }),
  )
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', TAG]), TOKEN_ENV)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^- empty\.txt（0 B，已上传）$/m)
    assert.equal(mock.uploads.length, 1)
    assert.equal(mock.uploads[0].filename, 'empty.txt')
    assert.equal(mock.uploads[0].contentLength, '0')
    assert.equal(mock.uploads[0].body, undefined)
  } finally {
    await mock.close()
  }
}

// 13) 参数与平台错误：本地直接失败，不发起请求
{
  const unsupported = await runCli([
    'release-sync',
    '--source',
    'gitlab.com/owner/repo',
    '--target',
    'org/dst',
    '--source-token',
    'x',
    '--target-token',
    'y',
  ])
  assert.equal(unsupported.code, 1)
  assert.match(unsupported.stderr, /暂不支持 gitlab\.com/)
  assert.match(unsupported.stderr, /其它平台/)
  assert.match(unsupported.stderr, /gitee\.com/)

  const missingToken = await runCli([
    'release-sync',
    '--source',
    'org/src',
    '--target',
    'org/dst',
    '--source-token',
    'x',
  ])
  assert.equal(missingToken.code, 1)
  assert.match(missingToken.stderr, /目标仓库令牌/)
  assert.match(missingToken.stderr, /CNB_TARGET_TOKEN/)

  const conflict = await runCli([
    'release-sync',
    '--source',
    'org/src',
    '--target',
    'org/dst',
    '--tag',
    TAG,
    '--latest',
  ])
  assert.equal(conflict.code, 1)
  assert.match(conflict.stderr, /不能同时使用/)

  const missingRepo = await runCli(['release-sync'])
  assert.equal(missingRepo.code, 1)
  assert.match(missingRepo.stdout, /用法:/)
  assert.match(missingRepo.stderr, /缺少必填参数/)
}

// 14) 令牌错误：401 有明确提示，且错误信息不回显令牌
{
  const mock = await startMockCnb({ targetRelease: null, targetTag: null })
  mock.setSourceRelease(sourceRelease(mock.base))
  try {
    const result = await runCli(syncArgs(mock.base, ['--tag', TAG]), {
      CNB_SOURCE_TOKEN: SOURCE_TOKEN,
      CNB_TARGET_TOKEN: 'wrong-secret-token',
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /401/)
    assert.match(result.stderr, /访问令牌无效或已过期/)
    assert.ok(!result.stderr.includes('wrong-secret-token'))
  } finally {
    await mock.close()
  }
}

// 15) 仓库地址解析：CNB 组织名带点时不能被误判成平台域名
{
  assert.equal(
    parseRepositoryValue('https://cnb.cool/xuxiaowei.io/publish-apk.git').repo,
    'xuxiaowei.io/publish-apk',
  )
  assert.equal(
    parseRepositoryValue('cnb.cool/xuxiaowei.io/publish-apk').repo,
    'xuxiaowei.io/publish-apk',
  )
  assert.equal(parseRepositoryValue('xuxiaowei.io/publish-apk').repo, 'xuxiaowei.io/publish-apk')
  assert.equal(
    parseRepositoryValue('git@cnb.cool:xuxiaowei.io/publish-apk.git').repo,
    'xuxiaowei.io/publish-apk',
  )
  assert.equal(parseRepositoryValue('org/repo').display, 'cnb.cool/org/repo')
  assert.throws(() => parseRepositoryValue('gitlab.com/owner/repo'), /暂不支持 gitlab\.com/)
  assert.throws(() => parseRepositoryValue('https://gitlab.com/owner/repo'), /暂不支持 gitlab\.com/)
  assert.throws(() => parseRepositoryValue('onlyone'), /组织\/仓库/)
  assert.throws(() => parseRepositoryValue('https://cnb.cool/org/repo?x=1'), /查询串/)
}

// 16) 标签名带 `/`：按标签查 404 时回退到列表接口
{
  const calls = []
  const json = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload)
    },
  })
  const fetchImpl = async (url) => {
    calls.push(url)
    const page = Number(new URL(url).searchParams.get('page') ?? '1')
    if (url.includes('/releases/tags/')) {
      return json(404, { errcode: 404, errmsg: 'not found' })
    }
    if (url.includes('/releases?')) {
      return json(200, page === 1 ? [{ id: 'r-1', tag_name: 'release/v1.0.0' }] : [])
    }
    if (url.includes('/git/tags/')) {
      return json(404, { errcode: 404, errmsg: 'not found' })
    }
    return json(200, page === 1 ? [{ name: 'release/v1.0.0', target: 'main' }] : [])
  }
  const client = new CnbReleaseClient({
    repo: SOURCE_REPO,
    token: 'token',
    apiBase: 'https://api.cnb.cool',
    fetchImpl,
  })
  const release = await client.getReleaseByTag('release/v1.0.0')
  assert.equal(release.tag_name, 'release/v1.0.0')
  assert.equal(
    calls[0],
    `https://api.cnb.cool/${SOURCE_REPO}/-/releases/tags/release%2Fv1.0.0`,
  )
  assert.match(calls[1], /\/releases\?page=1&page_size=100$/)

  const tag = await client.getTag('release/v1.0.0')
  assert.equal(tag.name, 'release/v1.0.0')
  assert.ok(calls.some((url) => /\/git\/tags\?page=1&page_size=100$/.test(url)))

  // 不含 `/` 的标签 404 就是没有，不再多查一次列表
  calls.length = 0
  const missing = await client.getReleaseByTag('v9.9.9')
  assert.equal(missing, null)
  assert.equal(calls.length, 1)
}

console.log('release-sync: CNB 发布同步测试通过')
