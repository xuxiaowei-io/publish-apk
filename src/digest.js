/**
 * 文件摘要工具（MD5 / SHA-1 / SHA-256 / SHA-512）。
 *
 * 各查看命令都要回答同一个问题：「手上这份文件、刚上传上去的文件，是不是同一个」。
 * 应用市场、分发渠道与下载页给出的校验值不统一，所以这里统一计算四种常用摘要：
 *   - 摘要覆盖文件全部字节（含 HAP / APK 签名块），不是包内某个条目；
 *   - 小写十六进制，长度固定（MD5 32 位、SHA-1 40 位、SHA-256 64 位、SHA-512 128 位），
 *     分别与 md5sum / sha1sum / sha256sum / sha512sum 输出一致；
 *   - 默认只输出 MD5 / SHA-1 / SHA-256，SHA-512 行较长、用得少，放入 --verbose；
 *   - 只依赖 node:crypto，不引入 npm 第三方包。
 */
import { createHash } from 'node:crypto'

/**
 * 帮助文档里的统一说明行：各命令的「说明」都引用它，避免口径不一致。
 */
export const DIGEST_HELP_NOTE =
  '说明: MD5 / SHA-1 / SHA-256 覆盖文件全部字节，小写十六进制，与 md5sum / sha1sum / sha256sum 一致；--verbose 追加 SHA-512'

/**
 * 计算文件（Buffer）的 MD5、SHA-1、SHA-256 与 SHA-512。
 *
 * @param {Buffer} buffer 文件全部字节
 * @returns {{ md5: string, sha1: string, sha256: string, sha512: string }} 小写十六进制摘要
 */
export function fileDigests(buffer) {
  return {
    md5: createHash('md5').update(buffer).digest('hex'),
    sha1: createHash('sha1').update(buffer).digest('hex'),
    sha256: createHash('sha256').update(buffer).digest('hex'),
    sha512: createHash('sha512').update(buffer).digest('hex'),
  }
}

/**
 * 摘要的输出行：默认 MD5、SHA-1、SHA-256，`verbose` 时追加 SHA-512。
 * 标签与顺序固定，保证各命令的输出可以互相 grep / diff。
 *
 * @param {{ md5: string, sha1: string, sha256: string, sha512: string } | null | undefined} digests 没有摘要时返回空数组
 * @param {boolean} verbose 是否追加 SHA-512
 * @returns {string[]}
 */
export function digestLines(digests, verbose = false) {
  if (digests === null || digests === undefined) {
    return []
  }
  const lines = [
    `MD5: ${digests.md5}`,
    `SHA-1: ${digests.sha1}`,
    `SHA-256: ${digests.sha256}`,
  ]
  if (verbose) {
    lines.push(`SHA-512: ${digests.sha512}`)
  }
  return lines
}
