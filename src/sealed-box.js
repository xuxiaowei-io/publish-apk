/**
 * libsodium 兼容的 sealed box（`crypto_box_seal`）实现，只依赖 Node 内置模块。
 *
 * GitHub 的 Actions 密钥接口要求先把值用 libsodium 的 sealed box 加密：
 *   ephemeral_pk || secretbox(k, nonce, message)
 *   k     = HSalsa20(X25519(ephemeral_sk, recipient_pk), 0)
 *   nonce = BLAKE2b-24(ephemeral_pk || recipient_pk)
 *
 * 为什么不引第三方库：
 *   - 本项目的运行环境要求只有 Node / OpenSSL / keytool，npm 包保持零依赖；
 *   - gh CLI 自带这套加密，但本功能按要求改为直接走 REST API + GITHUB_TOKEN，
 *     所以这里只补上「Node 内置 crypto 没有」的对称原语：
 *     HSalsa20 / XSalsa20、Poly1305、BLAKE2b（可变输出长度）。
 *     X25519 用 Node 内置的 `crypto.diffieHellman`，不自己实现椭圆曲线运算。
 *
 * 正确性由 tests/sealed-box.test.js 里的固定向量保证；这些向量先用 PyNaCl
 * （libsodium 的绑定）解密验证，再固化到仓库。
 *
 * 说明：这里用 BigInt / 普通数组实现，**不是常量时间**；它只服务于 CLI 的一次性上传，
 * 不作为通用密码库使用。X25519 用 Node 的 OpenSSL 实现，不自己写椭圆曲线运算。
 */
import { createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto'

/** sealed box 的固定开销：32 字节临时公钥 + 16 字节 Poly1305 认证标签 */
export const SEALED_BOX_OVERHEAD = 48

/** X25519 公钥 / 密钥长度 */
const KEY_BYTES = 32
/** XSalsa20 nonce 长度 */
const NONCE_BYTES = 24
/** Poly1305 认证标签长度 */
const TAG_BYTES = 16
/** SecretBox 的 MAC 前缀长度 */
const BOX_MAC_BYTES = 16

/** Salsa20 常量 "expand 32-byte k"（小端） */
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574])

const ZERO_NONCE_16 = Buffer.alloc(16)

// ------------------------------------------------------------------ 基础工具

/** 32 位循环左移 */
function rotl32(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

/** 从 Buffer 的小端位置读一个 uint32 */
function readUint32LE(buffer, offset) {
  return (
    (buffer[offset] |
      (buffer[offset + 1] << 8) |
      (buffer[offset + 2] << 16) |
      (buffer[offset + 3] << 24)) >>>
    0
  )
}

/** 把一个 uint32 以小端写入 Buffer */
function writeUint32LE(buffer, offset, value) {
  buffer[offset] = value & 0xff
  buffer[offset + 1] = (value >>> 8) & 0xff
  buffer[offset + 2] = (value >>> 16) & 0xff
  buffer[offset + 3] = (value >>> 24) & 0xff
}

/** Buffer 的小端字节序转 BigInt */
function littleEndianToBigInt(buffer) {
  let value = 0n
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(buffer[index])
  }
  return value
}

/** BigInt 转固定长度的小端 Buffer（高位截断） */
function bigIntToLittleEndian(value, length) {
  const output = Buffer.alloc(length)
  let rest = value
  for (let index = 0; index < length; index += 1) {
    output[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return output
}

// ------------------------------------------------------------------ Salsa20 / XSalsa20

/** Salsa20 的四分之一轮 */
function quarterRound(state, a, b, c, d) {
  state[b] ^= rotl32((state[a] + state[d]) >>> 0, 7)
  state[c] ^= rotl32((state[b] + state[a]) >>> 0, 9)
  state[d] ^= rotl32((state[c] + state[b]) >>> 0, 13)
  state[a] ^= rotl32((state[d] + state[c]) >>> 0, 18)
}

/** Salsa20 的 20 轮（10 个双轮），原地修改 state */
function salsa20Rounds(state) {
  for (let round = 0; round < 10; round += 1) {
    // 列轮
    quarterRound(state, 0, 4, 8, 12)
    quarterRound(state, 5, 9, 13, 1)
    quarterRound(state, 10, 14, 2, 6)
    quarterRound(state, 15, 3, 7, 11)
    // 行轮
    quarterRound(state, 0, 1, 2, 3)
    quarterRound(state, 5, 6, 7, 4)
    quarterRound(state, 10, 11, 8, 9)
    quarterRound(state, 15, 12, 13, 14)
  }
}

/** Salsa20 块函数：20 轮后加上输入 state（HSalsa20 不加） */
function salsa20Block(input) {
  const state = new Uint32Array(input)
  salsa20Rounds(state)
  const output = new Uint32Array(16)
  for (let index = 0; index < 16; index += 1) {
    output[index] = (state[index] + input[index]) >>> 0
  }
  return output
}

/** HSalsa20：由 32 字节 key 与 16 字节 nonce 派生 32 字节子密钥 */
function hsalsa20(key, nonce16) {
  if (key.length !== KEY_BYTES || nonce16.length !== 16) {
    throw new Error('HSalsa20 的 key 必须是 32 字节、nonce 必须是 16 字节')
  }
  const state = new Uint32Array(16)
  state[0] = SIGMA[0]
  state[5] = SIGMA[1]
  state[10] = SIGMA[2]
  state[15] = SIGMA[3]
  for (let index = 0; index < 4; index += 1) {
    state[1 + index] = readUint32LE(key, index * 4)
    state[11 + index] = readUint32LE(key, 16 + index * 4)
    state[6 + index] = readUint32LE(nonce16, index * 4)
  }
  salsa20Rounds(state)
  // HSalsa20 输出固定取这 8 个字，且不再加回输入 state
  const words = [state[0], state[5], state[10], state[15], state[6], state[7], state[8], state[9]]
  const output = Buffer.alloc(KEY_BYTES)
  for (let index = 0; index < words.length; index += 1) {
    writeUint32LE(output, index * 4, words[index])
  }
  return output
}

/** 生成 XSalsa20 密钥流：HSalsa20 派生 subkey，再按 64 位计数器展开 Salsa20 */
function xsalsa20Keystream(length, nonce24, key) {
  if (nonce24.length !== NONCE_BYTES) {
    throw new Error('XSalsa20 的 nonce 必须是 24 字节')
  }
  const subkey = hsalsa20(key, nonce24.subarray(0, 16))
  const state = new Uint32Array(16)
  state[0] = SIGMA[0]
  state[5] = SIGMA[1]
  state[10] = SIGMA[2]
  state[15] = SIGMA[3]
  for (let index = 0; index < 4; index += 1) {
    state[1 + index] = readUint32LE(subkey, index * 4)
    state[11 + index] = readUint32LE(subkey, 16 + index * 4)
  }
  state[6] = readUint32LE(nonce24, 16)
  state[7] = readUint32LE(nonce24, 20)

  const blocks = Math.ceil(length / 64)
  const stream = Buffer.alloc(blocks * 64)
  for (let block = 0; block < blocks; block += 1) {
    state[8] = block >>> 0
    state[9] = Math.floor(block / 0x100000000) >>> 0
    const words = salsa20Block(state)
    for (let index = 0; index < 16; index += 1) {
      writeUint32LE(stream, block * 64 + index * 4, words[index])
    }
  }
  return stream.subarray(0, length)
}

// ------------------------------------------------------------------ Poly1305

const POLY1305_P = (1n << 130n) - 5n
const POLY1305_R_MASK = 0x0ffffffc0ffffffc0ffffffc0fffffffn
const POLY1305_S_MASK = (1n << 128n) - 1n

/** Poly1305 一次性认证码（RFC 8439），用 BigInt 做模运算，逻辑简单且不易写错 */
function poly1305(message, key) {
  if (key.length !== KEY_BYTES) {
    throw new Error('Poly1305 的 key 必须是 32 字节')
  }
  const r = littleEndianToBigInt(key.subarray(0, 16)) & POLY1305_R_MASK
  const s = littleEndianToBigInt(key.subarray(16, 32))
  let accumulator = 0n
  for (let offset = 0; offset < message.length; offset += 16) {
    const block = message.subarray(offset, Math.min(offset + 16, message.length))
    // 每块末尾补 1 位（完整块是 2^128，最后一块按实际长度）
    const number = littleEndianToBigInt(block) + (1n << BigInt(block.length * 8))
    accumulator = ((accumulator + number) * r) % POLY1305_P
  }
  return bigIntToLittleEndian((accumulator + s) & POLY1305_S_MASK, TAG_BYTES)
}

/** libsodium 的 crypto_secretbox_xsalsa20poly1305：输出 tag || 密文 */
function secretbox(message, nonce24, key) {
  const stream = xsalsa20Keystream(BOX_MAC_BYTES * 2 + message.length, nonce24, key)
  const ciphertext = Buffer.alloc(message.length)
  for (let index = 0; index < message.length; index += 1) {
    ciphertext[index] = message[index] ^ stream[BOX_MAC_BYTES * 2 + index]
  }
  const tag = poly1305(ciphertext, stream.subarray(0, BOX_MAC_BYTES * 2))
  return Buffer.concat([tag, ciphertext])
}

// ------------------------------------------------------------------ BLAKE2b（可变输出长度）

const BLAKE2B_IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
]

const BLAKE2B_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
]

const MASK64 = (1n << 64n) - 1n

/** 64 位循环右移 */
function rotr64(value, shift) {
  return ((value >> BigInt(shift)) | (value << BigInt(64 - shift))) & MASK64
}

/** BLAKE2b 的 G 函数 */
function blake2bMix(state, a, b, c, d, x, y) {
  state[a] = (state[a] + state[b] + x) & MASK64
  state[d] = rotr64(state[d] ^ state[a], 32)
  state[c] = (state[c] + state[d]) & MASK64
  state[b] = rotr64(state[b] ^ state[c], 24)
  state[a] = (state[a] + state[b] + y) & MASK64
  state[d] = rotr64(state[d] ^ state[a], 16)
  state[c] = (state[c] + state[d]) & MASK64
  state[b] = rotr64(state[b] ^ state[c], 63)
}

/** BLAKE2b 压缩函数（一个 128 字节块） */
function blake2bCompress(hash, block, counter, final) {
  const message = new Array(16)
  for (let index = 0; index < 16; index += 1) {
    message[index] = littleEndianToBigInt(block.subarray(index * 8, index * 8 + 8))
  }
  const state = new Array(16)
  for (let index = 0; index < 8; index += 1) {
    state[index] = hash[index]
    state[index + 8] = BLAKE2B_IV[index]
  }
  state[12] ^= counter & MASK64
  state[13] ^= (counter >> 64n) & MASK64
  if (final) {
    state[14] ^= MASK64
  }
  for (let round = 0; round < 12; round += 1) {
    const sigma = BLAKE2B_SIGMA[round]
    blake2bMix(state, 0, 4, 8, 12, message[sigma[0]], message[sigma[1]])
    blake2bMix(state, 1, 5, 9, 13, message[sigma[2]], message[sigma[3]])
    blake2bMix(state, 2, 6, 10, 14, message[sigma[4]], message[sigma[5]])
    blake2bMix(state, 3, 7, 11, 15, message[sigma[6]], message[sigma[7]])
    blake2bMix(state, 0, 5, 10, 15, message[sigma[8]], message[sigma[9]])
    blake2bMix(state, 1, 6, 11, 12, message[sigma[10]], message[sigma[11]])
    blake2bMix(state, 2, 7, 8, 13, message[sigma[12]], message[sigma[13]])
    blake2bMix(state, 3, 4, 9, 14, message[sigma[14]], message[sigma[15]])
  }
  for (let index = 0; index < 8; index += 1) {
    hash[index] = (hash[index] ^ state[index] ^ state[index + 8]) & MASK64
  }
}

/** BLAKE2b：支持 1..64 字节输出长度（BLAKE2b 的块大小是 128 字节） */
function blake2b(input, outputLength) {
  if (!Number.isInteger(outputLength) || outputLength < 1 || outputLength > 64) {
    throw new Error(`BLAKE2b 输出长度必须是 1..64，实际: ${outputLength}`)
  }
  const hash = [...BLAKE2B_IV]
  // 参数块：digest_length | key_length << 8 | fanout << 16 | depth << 24
  hash[0] ^= 0x01010000n ^ BigInt(outputLength)
  const blockSize = 128
  const blocks = Math.max(1, Math.ceil(input.length / blockSize))
  for (let index = 0; index < blocks; index += 1) {
    const block = Buffer.alloc(blockSize)
    input.copy(block, 0, index * blockSize, Math.min((index + 1) * blockSize, input.length))
    const final = index === blocks - 1
    const counter = final ? BigInt(input.length) : BigInt((index + 1) * blockSize)
    blake2bCompress(hash, block, counter, final)
  }
  const full = Buffer.concat(hash.map((word) => bigIntToLittleEndian(word, 8)))
  return full.subarray(0, outputLength)
}

// ------------------------------------------------------------------ sealed box

/** 从 Node KeyObject 取 X25519 原始 32 字节公钥 */
function rawPublicKey(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' })
  if (jwk.kty !== 'OKP' || jwk.crv !== 'X25519' || typeof jwk.x !== 'string') {
    throw new Error('不是 X25519 公钥')
  }
  return Buffer.from(jwk.x, 'base64url')
}

/** 用原始 32 字节构造 Node 公钥对象 */
function publicKeyFromRaw(raw) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
    format: 'jwk',
  })
}

/**
 * 生成 libsodium 兼容的 sealed box。
 *
 * @param {Buffer|string} message 明文（UTF-8 字符串或 Buffer）
 * @param {Buffer} recipientPublicKey 接收方 X25519 公钥（32 字节）
 * @param {{ ephemeralKeyPair?: { publicKey: import('node:crypto').KeyObject, privateKey: import('node:crypto').KeyObject } }} [options]
 *   仅供测试注入固定的临时密钥对，生产路径不传。
 * @returns {Buffer} ephemeral_pk（32 字节）|| tag（16 字节）|| 密文
 */
export function sealBox(message, recipientPublicKey, options = {}) {
  const plaintext = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8')
  if (!Buffer.isBuffer(recipientPublicKey) || recipientPublicKey.length !== KEY_BYTES) {
    throw new Error('接收方公钥必须是 32 字节')
  }
  const ephemeral = options.ephemeralKeyPair ?? generateKeyPairSync('x25519')
  const ephemeralPublicKey = rawPublicKey(ephemeral.publicKey)
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: publicKeyFromRaw(recipientPublicKey),
  })
  if (shared.length !== KEY_BYTES || shared.every((byte) => byte === 0)) {
    throw new Error('X25519 共享密钥无效（接收方公钥可能不可用）')
  }
  const key = hsalsa20(shared, ZERO_NONCE_16)
  const nonce = blake2b(Buffer.concat([ephemeralPublicKey, recipientPublicKey]), NONCE_BYTES)
  return Buffer.concat([ephemeralPublicKey, secretbox(plaintext, nonce, key)])
}
