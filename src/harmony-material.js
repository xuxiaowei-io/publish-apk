/**
 * 鸿蒙 hvigor 签名 material 的生成与口令加解密。
 *
 * 背景：hvigor 的 build-profile.json5 不接受明文口令 ——
 * `signingConfigs[].material.storePassword` / `keyPassword` 是「用 material 里的 workKey
 * 加密过的十六进制串」，签名时由 hvigor 的 DecipherUtil 解密。解密的钥匙来自
 * **storeFile(.p12) 同级目录**下的 material/：
 *
 *   <storeFile 所在目录>/
 *     material/
 *       fd/0/<随机名>   16 字节随机数
 *       fd/1/<随机名>   16 字节随机数
 *       fd/2/<随机名>   16 字节随机数
 *       ac/<随机名>     salt
 *       ce/<随机名>     被 rootKey 加密过的 workKey
 *
 *   rootKey = pbkdf2(xor(fd/0, fd/1, fd/2, 固定分量).toString(), ac 里的 salt, 10000 轮, 16 字节, sha256)
 *   workKey = aes-128-gcm 解密 ce（用 rootKey 解）
 *   明文口令 = aes-128-gcm 解密 storePassword / keyPassword（用 workKey 解）
 *
 * 密文格式（DecipherUtil.decrypt 的读法）：4 字节大端 e + IV + 密文 + 16 字节 tag，
 * IV 长度 = 总长度 - 4 - e（DevEco 用 12 字节 IV，即 e = 密文长度 + 16）。
 * xor 结果要按 utf8 转成字符串再进 pbkdf2 —— hvigor 就是这么写的。
 *
 * 这份实现与 hvigor 的 DecipherUtil 对应；material 由 DevEco Studio 或本工具生成，
 * 与本机绑定：material 丢了，那两串密文就解不开（明文在手可以重新生成一套）。
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** DecipherUtil.component：固定的 16 字节分量，参与 rootKey 的 xor */
const FD_COMPONENT = Buffer.from([
  49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119,
])

const GCM_IV_LENGTH = 12
const GCM_TAG_LENGTH = 16

/** 密钥 / 口令落盘时一律 0600 */
export function writeSecret(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buffer, { mode: 0o600 })
  return file
}

function entriesOf(dir) {
  return fs.readdirSync(dir).filter((name) => name !== '.DS_Store')
}

/** hvigor 的 readDirBytes：目录下恰好一个文件，读它的内容 */
function readOnlyFile(dir) {
  const names = entriesOf(dir)
  if (names.length !== 1) {
    throw new Error(`${dir} 下应当恰好有 1 个文件，实际 ${names.length} 个`)
  }
  return fs.readFileSync(path.join(dir, names[0]))
}

function aesGcmEncrypt(key, plain) {
  const iv = randomBytes(GCM_IV_LENGTH)
  const cipher = createCipheriv('aes-128-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  // 4 字节大端 e = 密文长度 + tag 长度（从末尾往回数的起点，IV 长度 = 总长 - 4 - e）
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length + tag.length, 0)
  return Buffer.concat([head, iv, body, tag])
}

function aesGcmDecrypt(key, blob) {
  const tail = blob.readUInt32BE(0)
  const ivLength = blob.length - 4 - tail
  if (ivLength <= 0) {
    throw new Error('密文格式不对：按 4 字节前缀算出来的 IV 长度不是正数')
  }
  const decipher = createDecipheriv('aes-128-gcm', key, blob.subarray(4, 4 + ivLength))
  decipher.setAuthTag(blob.subarray(blob.length - GCM_TAG_LENGTH))
  return Buffer.concat([
    decipher.update(blob.subarray(4 + ivLength, blob.length - GCM_TAG_LENGTH)),
    decipher.final(),
  ])
}

/** 用 material 里的 workKey 把明文口令加密成 build-profile.json5 认识的那串十六进制 */
export function encryptSecret(workKey, plain) {
  return aesGcmEncrypt(workKey, Buffer.from(plain, 'utf8')).toString('hex')
}

/**
 * 现场生成一套 material。
 *
 * @param {string} dir material 目录（与 .p12 同级）
 * @param {Buffer} workKey 16 字节 workKey
 */
export function generateMaterial(dir, workKey) {
  const randomName = () => randomBytes(16).toString('hex')
  const fds = [0, 1, 2].map((index) => {
    const bytes = randomBytes(16)
    writeSecret(path.join(dir, 'fd', String(index), randomName()), bytes)
    return bytes
  })
  const salt = randomBytes(16)
  writeSecret(path.join(dir, 'ac', randomName()), salt)

  const xor = Buffer.from(fds[0])
  for (const bytes of fds.slice(1)) {
    for (let index = 0; index < 16; index += 1) {
      xor[index] ^= bytes[index]
    }
  }
  for (let index = 0; index < 16; index += 1) {
    xor[index] ^= FD_COMPONENT[index]
  }
  const rootKey = pbkdf2Sync(xor.toString(), salt, 1e4, 16, 'sha256')
  writeSecret(path.join(dir, 'ce', randomName()), aesGcmEncrypt(rootKey, workKey))

  // material 是解开密文口令的钥匙：目录 0700，文件 0600
  for (const target of [dir, path.join(dir, 'fd'), path.join(dir, 'ac'), path.join(dir, 'ce')]) {
    fs.chmodSync(target, 0o700)
  }
  for (const index of ['0', '1', '2']) {
    fs.chmodSync(path.join(dir, 'fd', index), 0o700)
  }
  return workKey
}

/** 从 material 目录（.p12 同级那个 material/）解出 workKey */
export function readMaterialKey(materialDir) {
  const dir = path.resolve(materialDir)
  const fdRoot = path.join(dir, 'fd')
  if (!fs.existsSync(fdRoot) || !fs.statSync(fdRoot).isDirectory()) {
    throw new Error(`找不到 material 的 fd 目录：${fdRoot}（material 目录与 .p12 必须同级）`)
  }
  const fdNames = entriesOf(fdRoot)
  if (fdNames.length !== 3) {
    throw new Error(`${fdRoot} 下应当有 3 个子目录（fd/0、fd/1、fd/2），实际 ${fdNames.length} 个`)
  }
  const fds = fdNames.map((name) => readOnlyFile(path.join(fdRoot, name)))
  for (const bytes of fds) {
    if (bytes.length !== 16) {
      throw new Error(`${fdRoot} 下的分量应当是 16 字节，实际 ${bytes.length} 字节`)
    }
  }
  const salt = readOnlyFile(path.join(dir, 'ac'))
  const ce = readOnlyFile(path.join(dir, 'ce'))
  const xor = Buffer.from(fds[0])
  for (const bytes of fds.slice(1)) {
    for (let index = 0; index < 16; index += 1) {
      xor[index] ^= bytes[index]
    }
  }
  for (let index = 0; index < 16; index += 1) {
    xor[index] ^= FD_COMPONENT[index]
  }
  const rootKey = pbkdf2Sync(xor.toString(), salt, 1e4, 16, 'sha256')
  return aesGcmDecrypt(rootKey, ce)
}

/** 把 build-profile.json5 里的密文口令解成明文（本工具生成时用于往返自检） */
export function decryptSecret(materialDir, encryptedHex, label = '口令') {
  if (
    typeof encryptedHex !== 'string' ||
    !/^[0-9a-fA-F]+$/.test(encryptedHex) ||
    encryptedHex.length % 2 !== 0
  ) {
    throw new Error(`${label} 不是十六进制密文，无法解密`)
  }
  const blob = Buffer.from(encryptedHex, 'hex')
  if (blob.length < 32) {
    throw new Error(`${label} 只有 ${blob.length} 字节，不是 hvigor 认识的密文`)
  }
  return aesGcmDecrypt(readMaterialKey(materialDir), blob).toString('utf8')
}
