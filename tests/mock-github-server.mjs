/**
 * CI 用的 GitHub Actions 密钥 API 桩：不联网、不需要 token，只验证请求形状。
 *
 * 用法：
 *   MOCK_GITHUB_LOG=/tmp/calls.jsonl node tests/mock-github-server.mjs
 *   # stdout 输出监听端口，例如 51234
 *
 * 支持的请求：
 *   GET  .../secrets/public-key  -> { key_id: "test-key", key: <32 字节测试公钥> }
 *   PUT  .../secrets/<名字>      -> 201
 * 每个请求（含 PUT 的加密值）追加一行 JSON 到 MOCK_GITHUB_LOG，供测试脚本断言。
 */
import fs from 'node:fs'
import http from 'node:http'

/** 与 tests/sealed-box.test.js 相同的测试公钥，仅用于 CI */
const PUBLIC_KEY = 'tFbnfU3vKWop2qTR+AvJrp9Zv9pre5zFWmUmpeNbCyA='
const logFile = process.env.MOCK_GITHUB_LOG

const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    let parsedBody
    if (body !== '') {
      try {
        parsedBody = JSON.parse(body)
      } catch {
        parsedBody = body
      }
    }
    if (logFile !== undefined) {
      fs.appendFileSync(
        logFile,
        `${JSON.stringify({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          body: parsedBody,
        })}\n`,
      )
    }
    if (request.method === 'GET' && request.url.endsWith('/public-key')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ key_id: 'test-key', key: PUBLIC_KEY }))
      return
    }
    if (request.method === 'PUT') {
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`)
})
