/**
 * sealed box 固定向量测试：`node tests/sealed-box.test.js`。
 *
 * 向量先用 PyNaCl（libsodium 的绑定）解密验证，再固化到仓库；任何实现改动
 * 只要破坏了与 libsodium 的兼容性，这里就会失败。
 *
 * 下面的接收方私钥与临时私钥只用于测试，不用于任何真实环境：
 *   接收方私钥 tbh4CriB8QDSJjKRoY1MyOm3Uag9Odmrz0QzDagMFc4=
 *   临时私钥（JWK）见 EPHEMERAL_JWK
 */
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'

import { SEALED_BOX_OVERHEAD, sealBox } from '../src/sealed-box.js'

/** 测试专用接收方 X25519 公钥（对应上面注释里的私钥） */
const RECIPIENT_PUBLIC_KEY = Buffer.from('tFbnfU3vKWop2qTR+AvJrp9Zv9pre5zFWmUmpeNbCyA=', 'base64')

/** 测试专用临时密钥对（完整 JWK：x 与 d） */
const EPHEMERAL_JWK = {
  kty: 'OKP',
  crv: 'X25519',
  x: '3OMnjD7qWn37Hm_XPPuPfDVaVJo6BhJBRe3GwfLtUAM',
  d: 'kGJeTwS7toCI2PzTxoN4k68PqwDQJf2cHUsA63iuT04',
}

const ephemeralPrivateKey = createPrivateKey({ key: EPHEMERAL_JWK, format: 'jwk' })
const ephemeralKeyPair = {
  privateKey: ephemeralPrivateKey,
  publicKey: createPublicKey(ephemeralPrivateKey),
}

const VECTORS = [
  {
    name: 'empty',
    message: '',
    sealed: '3OMnjD7qWn37Hm/XPPuPfDVaVJo6BhJBRe3GwfLtUANC3751CqwTqU1zeyz9POej',
  },
  {
    name: 'one-byte',
    message: 'a',
    sealed: '3OMnjD7qWn37Hm/XPPuPfDVaVJo6BhJBRe3GwfLtUAMORUM/BRtOfk3cWzjTqSPCRA==',
  },
  {
    name: 'hello',
    message: 'hello world',
    sealed: '3OMnjD7qWn37Hm/XPPuPfDVaVJo6BhJBRe3GwfLtUAPwsIGSnZ1i2+x1wL8rz2viTYQ+Jy3my0yxLew=',
  },
  {
    name: 'block-16',
    message: 'x'.repeat(16),
    sealed:
      '3OMnjD7qWn37Hm/XPPuPfDVaVJo6BhJBRe3GwfLtUAPLVTcAP7zzdZk8W8gGxbrxXZkqMzq+xFu7OfC/bsK6JQ==',
  },
  {
    name: 'block-17',
    message: 'x'.repeat(17),
    sealed:
      '3OMnjD7qWn37Hm/XPPuPfDVaVJo6BhJBRe3GwfLtUAMRoWsY1wzRwEq8k3cwULejXZkqMzq+xFu7OfC/bsK6JUA=',
  },
  {
    name: 'block-32',
    message: 'x'.repeat(32),
    sealed:
      '3OMnjD7qWn37Hm/XPPuPfDVaVJo6BhJBRe3GwfLtUAOXXWCE9Q7E2qPHeNa/ZInnXZkqMzq+xFu7OfC/bsK6JUDj/qo3RdhvwFPUIPFQtTQ=',
  },
  {
    name: 'utf8',
    message: '中文消息 🚀',
    sealed: '3OMnjD7qWn37Hm/XPPuPfDVaVJo6BhJBRe3GwfLtUANlaDsaCdEI5ie8MZPSk4RswVn/rdRBWpVLpwloNkpdx7g=',
  },
  {
    name: 'long-1000',
    message: 'y'.repeat(1000),
    sealed:
      '3OMnjD7qWn37Hm/XPPuPfDVaVJo6BhJBRe3GwfLtUAMoUZB8ufeP7HjcdOV1hXAHXJgrMju/xVq6OPG+b8O7JEHi/6s2RNluwVLVIfBRtDUG8o1LEnneoigVDnM2WJcivSi0ct/Z3y3I5X4uFiJLxhHP3GWvYPwXw/w2pxiWE8o+4paaTZ6wwKgwFQESwqr5fcZBFKIy8kKRCncIy2eYWrZoDsAAl0Ax48slOPsIs7T24rYD6m+c1FXhOlWtkz294sxaVX2HMmpsreLiQiDHZRQlg4O7uGQwPEH0NbvhNGbrMRAmggD/EVOfM7IRPQDuZ/7Y3nbJzcHG0VRaTn8v9jXINVHKHKOK6RPD2E5mF8N+OoWv1XhTkmbwOHaxTFiqPm38AEnZIw7Z0/xIbjOc/YWvqs3F2aBAQ0NRf8BH1yj3Nnxxi8DwSGnKjQi3hgaRSIdVxO6Jfh3pTDRUfsHNcu8k4UkYMRCRd+RuvGJZqQShbNr3ZQGWCCXhCA2f8DXjpb+1phth1N8hY2Q1LqBiTaCNQY2XyIA71dALDgL7H01frT0PCV26nEXYx3+dFVZFWYaVpxU4xJvyndV49i4BjhLOoa68QXi4VirPHwcvZoPZiWSsJtfnMLk9EAp/J7K55sYD64tRmceI3ylsjrVrFZDq/t8WfAxjSpoplUWcAhdu6Rb2feDl+FoKSYmrZVvY/HiX6vrcRr3NkZiPcA6QHVmcEaepOn8AFmbx1xs0/yHaidVvo/FnqfcfrrkcaypqmvbJyItvvvYKf+MkbreBXN7LTbpnFaUshY1LTomxzX0EQRk1PyP2xmT3MrEPO/qd8szMy83r3rR5JvJX3WBTH1xP04DG3Q51spv7ZxJb2uo9JsCwViZ+C0qZmd2cKP0f97U07rpj0sBj4kuedXslGJlyoRInKxxE4toXibTmGJU+3O0paWtNmMiwccZN6pvLX3wmzHrpN2/YRmD/Pxv5R80hgDCTKjYUBtiHDGY6iEXWZoCphSh3QEs0IdHlZxyrq/OyEhZgF5Mwdacbrz1VYYmYkVAzk8KPN6Dk5XlrS39RPbpPbiN3R+BI/LsAHxgGOGEp6wiQbKtN98avwJOkjLrbPl++bdAfzSX+yXu066A5/A+eW9tchoWABXCTolRKqGY0iTA3MtT+dB16hBOoazXlC7th0/9qs5fa7ufa57kGjvbt8Fu2JcMxN3uJcPl/C6TEHiNE5bMj3tssTVvct7rFOKX5ZpybAnBUsAeMqugavDU2x9Y0yRrQQKJue+hJi8FVwtLG68nqbdCYMoa+uRWsI1QpTqeRgqF7is39BSRG7EP7db7/Tu+QZUr23PaZZAfPkZ8/bn0GJ3MFtMgkxHsDtGV/Mxx8Vbio2jOnVBRldIz7RdkBvw==',
  },
]

for (const { name, message, sealed } of VECTORS) {
  const actual = sealBox(message, RECIPIENT_PUBLIC_KEY, { ephemeralKeyPair }).toString('base64')
  assert.equal(actual, sealed, `sealed box 向量不匹配: ${name}`)
  const expectedLength = Buffer.byteLength(message, 'utf8') + SEALED_BOX_OVERHEAD
  assert.equal(Buffer.from(actual, 'base64').length, expectedLength, `sealed box 长度不对: ${name}`)
}

// 接收方公钥不是 32 字节时必须在本地失败，不能带着错误数据发请求
assert.throws(() => sealBox('x', Buffer.alloc(31)), /32 字节/)

console.log(`sealed box: ${VECTORS.length} 个固定向量通过（与 libsodium 兼容）`)
