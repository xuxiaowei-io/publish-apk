/**
 * JWT 工具：厂商无关。
 *
 * 这里只做 JWT 本身的事情——时间戳、日志掩码、PEM 还原、RS256/PS256 签名，
 * 不包含任何厂商的固定值（华为的 typ/alg/aud/exp 偏移见 src/huawei.js，
 * Google 的 iss/scope/aud 见 src/google.js）。
 *
 * 签名只使用 Node 内置的 node:crypto，不引入任何第三方依赖。
 *
 * 两种 RSA 签名算法对应两家厂商的服务账号鉴权：
 *   RS256 —— RSASSA-PKCS1-v1_5 + SHA-256，Google 服务账号
 *   PS256 —— RSASSA-PSS + SHA-256，华为 Service Account
 */
import {
  constants,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'

/**
 * 当前 UTC 秒级时间戳，即 `iat` 的默认值。
 *
 * JWT 的时间戳统一为「自 UTC 1970-01-01 00:00:00 起的秒数」，
 * 因此这里不能用毫秒值，必须除以 1000 向下取整。
 */
export function currentUnixSeconds(now = Date.now()) {
  return Math.floor(now / 1000)
}

/**
 * 部分掩码：保留首尾各若干位，中间用 `*` 代替，用于日志与帮助文档展示，
 * 避免把完整的 kid、iss 落到日志里。
 *
 * 规则（保留的位数随长度递减，保证至少掩掉一半）：
 *   长度 ≥ 12  保留首尾各 4 位，如 `abcd****wxyz`
 *   长度 8 ~ 11 保留首尾各 2 位
 *   长度 5 ~ 7  保留首尾各 1 位
 *   长度 ≤ 4   只保留最后 1 位
 *   空值       显示为 `(未设置)`
 */
export function maskValue(value) {
  const text = String(value ?? '')
  if (text === '') {
    return '(未设置)'
  }
  if (text.length <= 4) {
    return `${'*'.repeat(text.length - 1)}${text.slice(-1)}`
  }
  const keep = text.length >= 12 ? 4 : text.length >= 8 ? 2 : 1
  return `${text.slice(0, keep)}${'*'.repeat(text.length - keep * 2)}${text.slice(-keep)}`
}

/** 生成用于展示的 JWT 头：仅 kid 部分掩码，其余字段原样 */
export function maskJwtHeader(header) {
  return { ...header, kid: maskValue(header.kid) }
}

/** 生成用于展示的 JWT 载荷：仅 iss 部分掩码，其余字段原样 */
export function maskJwtClaims(claims) {
  return { ...claims, iss: maskValue(claims.iss) }
}

/** 文本 → base64url（JWT 三段都用 base64url 且不带 `=` 填充） */
function base64UrlEncode(text) {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/**
 * 各算法的签名参数：签名与自检验签必须完全一致。
 *
 *   PS256：两个值都必须显式指定，写错会得到一个本机不报错、但服务端验签失败的 JWT：
 *          padding:    RSA_PKCS1_PSS_PADDING —— 不能用 Node 默认的 PKCS#1 v1.5
 *          saltLength: RSA_PSS_SALTLEN_DIGEST —— RFC 7518 规定 PS256 的盐长等于摘要长度（32 字节）
 *   RS256：PKCS#1 v1.5，无盐长参数；显式写出 padding 以免受 Node 默认值变化影响
 */
const SIGN_OPTIONS = {
  PS256: {
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  },
  RS256: {
    padding: constants.RSA_PKCS1_PADDING,
  },
}

/**
 * 还原因环境文件 / shell 转义而变形的 PEM 文本。
 *
 * 典型场景：`.env` 里写成 `PRIVATE_KEY="-----BEGIN...\nMIIB...\n"`，
 * 但 `source .env` 时 bash、zsh 都不会解释双引号内的 `\n`，变量里存的是
 * 「一行文本 + 字面量反斜杠 n」，PEM 解码必然失败（DECODER routines::unsupported）。
 *
 * PEM 的合法字符集（base64、+、/、=、-、换行）里没有反斜杠，
 * 因此在这些转义序列存在、且没有真实换行时把它们还原成换行是安全的。
 */
export function normalizePemText(text) {
  if (text.includes('\n')) {
    return text
  }
  return text.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').replaceAll('\\r', '\n')
}

/**
 * RSA 签名必须使用 RSA 私钥。
 *
 * 关键：Node 的 crypto.sign 传入 EC 密钥时不会报错，而是静默改用 ECDSA，
 * 于是产出一个「头部写着 RS256/PS256、实际是 ECDSA」的 JWT，只有服务端才会验签失败。
 * 所以这里主动校验密钥类型与长度。
 */
function assertRsaPrivateKey(key, algorithm) {
  const { asymmetricKeyType, asymmetricKeyDetails } = key
  if (asymmetricKeyType !== 'rsa' && asymmetricKeyType !== 'rsa-pss') {
    throw new Error(`${algorithm} 需要 RSA 私钥，当前密钥类型为 ${asymmetricKeyType}`)
  }
  const modulusLength = asymmetricKeyDetails?.modulusLength ?? 0
  if (modulusLength < 2048) {
    throw new Error(`${algorithm} 需要 RSA 密钥长度 ≥ 2048 位，当前为 ${modulusLength} 位`)
  }
}

/**
 * 用私钥签发 JWT，只用 node:crypto。
 *
 * @param {{ header: object, claims: object, privateKey: string, algorithm?: 'PS256' | 'RS256' }} jwt
 *   privateKey 为 PEM 文本，PKCS#8（BEGIN PRIVATE KEY）与 PKCS#1（BEGIN RSA PRIVATE KEY）都支持；
 *   algorithm 默认 PS256（华为），Google 服务账号用 RS256
 * @returns {string} header.payload.signature
 */
export function signJwt({ header, claims, privateKey, algorithm = 'PS256' }) {
  const signOptions = SIGN_OPTIONS[algorithm]
  if (signOptions === undefined) {
    throw new Error(`不支持的 JWT 签名算法 ${algorithm}，仅支持 ${Object.keys(SIGN_OPTIONS).join(' / ')}`)
  }
  // 头部 alg 与实际签名算法必须一致，否则会得到一个「声明与实现不符」的 JWT
  if (header?.alg !== algorithm) {
    throw new Error(`JWT 头 alg 为 ${header?.alg ?? '(未设置)'}，与签名算法 ${algorithm} 不一致`)
  }

  const key = createPrivateKey(privateKey)
  assertRsaPrivateKey(key, algorithm)

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`
  const data = Buffer.from(signingInput, 'utf8')
  const signature = cryptoSign('sha256', data, { key, ...signOptions })

  // 自检：用同一密钥导出的公钥验一次。Node 对参数错误不会报错，只会在服务端才暴露，
  // 因此这里把「签完自己先验一遍」作为最后一道防线。
  const verified = cryptoVerify(
    'sha256',
    data,
    { key: createPublicKey(key), ...signOptions },
    signature,
  )
  if (!verified) {
    throw new Error('JWT 自检失败：生成的签名未通过本机验签')
  }

  return `${signingInput}.${signature.toString('base64url')}`
}
