/**
 * `publish-apk huawei signing-config`：用 .cer / .p7b / .p12 与明文口令，
 * 生成鸿蒙 build-profile.json5 里 signingConfigs[].material 需要的配置。
 *
 * 为什么需要这个命令：
 *   - build-profile.json5 的 material.storePassword / keyPassword 不是明文，而是用
 *     **.p12 同级目录下 material/** 里的 workKey 加密过的十六进制串（hvigor 的 DecipherUtil）；
 *   - material 由 DevEco Studio 生成、与本机绑定；手写配置或换一套证书时，
 *     不知道这两个密文怎么算；
 *   - 本命令复用 src/harmony-material.js 的算法：先复用/生成 material，再用它加密口令，
 *     最后输出可直接粘贴的 signingConfig（或 --write 写回现有配置）。
 *
 * 安全约定：
 *   - stdout 只输出签名配置（含密文口令），日志/进度写 stderr；
 *   - 明文口令不会出现在输出里；--store-password 会进 shell 历史 / ps，建议用
 *     HARMONY_STORE_PASSWORD 环境变量，或在终端里交互输入；
 *   - material 是解开密文的唯一钥匙，不能删、不能入库。
 *
 * `publish-apk huawei signing-env` 是反向操作：从 build-profile.json5 解出 CI 变量；
 * 加 --github 时改为通过 GitHub REST API 一键写入 Actions 密钥，stdout 只列变量名。
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  EXIT_OK,
  PROGRAM,
  UsageError,
  isHelpToken,
  parseOptions,
  readEnv,
  stderr,
  stdout,
} from './cli.js'
import { certificateDetailLines, readPkcs12, renderPkcs12 } from './cert.js'
import {
  resolveGithubApiUrl,
  resolveGithubRepo,
  resolveGithubToken,
  setGithubSecrets,
} from './github.js'
import { decryptSecret, encryptSecret, generateMaterial, readMaterialKey } from './harmony-material.js'
import { profileInfoLines } from './profile.js'
import { normalizePemText } from './jwt.js'
import { renderHelp } from './help.js'

/** 命令名（huawei 子命令） */
const COMMAND_NAME = 'signing-config'
const PASSWORDS_COMMAND_NAME = 'signing-passwords'
const MATERIAL_COMMAND_NAME = 'signing-material'
const MATERIAL_ENV_COMMAND_NAME = 'signing-material-env'
const ENV_COMMAND_NAME = 'signing-env'

const OPTION_STORE_FILE = '--store-file'
const OPTION_STORE_FILE_OUT = '--store-file-out'
const OPTION_CERTPATH = '--certpath'
const OPTION_CERTPATH_OUT = '--certpath-out'
const OPTION_PROFILE = '--profile'
const OPTION_PROFILE_OUT = '--profile-out'
const OPTION_KEY_ALIAS = '--key-alias'
const OPTION_SIGN_ALG = '--sign-alg'
const OPTION_STORE_PASSWORD = '--store-password'
const OPTION_KEY_PASSWORD = '--key-password'
const OPTION_STORE_PASSWORD_FILE = '--store-password-file'
const OPTION_KEY_PASSWORD_FILE = '--key-password-file'
const OPTION_CONFIG = '--config'
const OPTION_NAME = '--name'
const OPTION_PRODUCT = '--product'
const OPTION_WRITE = '--write'
const OPTION_NEW_MATERIAL = '--new-material'
const OPTION_NO_KEYTOOL = '--no-keytool'
/** signing-material-env：要求 store / cert / profile / 口令齐全 */
const OPTION_REQUIRE_ALL = '--require-all'
const OPTION_FORMAT = '--format'
const OPTION_SEPARATOR = '--separator'
const OPTION_VERBOSE = '--verbose'
/** signing-env：把导出的变量直接写入 GitHub Actions 密钥（GitHub REST API + GITHUB_TOKEN） */
const OPTION_GITHUB = '--github'
const OPTION_GITHUB_REPO = '--github-repo'
const OPTION_GITHUB_ENV = '--github-env'

const SIGNING_OPTIONS = new Set([
  OPTION_STORE_FILE,
  OPTION_STORE_FILE_OUT,
  OPTION_CERTPATH,
  OPTION_CERTPATH_OUT,
  OPTION_PROFILE,
  OPTION_PROFILE_OUT,
  OPTION_KEY_ALIAS,
  OPTION_SIGN_ALG,
  OPTION_STORE_PASSWORD,
  OPTION_KEY_PASSWORD,
  OPTION_STORE_PASSWORD_FILE,
  OPTION_KEY_PASSWORD_FILE,
  OPTION_CONFIG,
  OPTION_NAME,
  OPTION_PRODUCT,
  OPTION_WRITE,
  OPTION_NEW_MATERIAL,
  OPTION_NO_KEYTOOL,
  OPTION_VERBOSE,
])
const SIGNING_FLAGS = new Set([OPTION_WRITE, OPTION_NEW_MATERIAL, OPTION_NO_KEYTOOL, OPTION_VERBOSE])

const PASSWORD_OPTIONS = new Set([
  OPTION_CONFIG,
  OPTION_NAME,
  OPTION_PRODUCT,
  OPTION_STORE_PASSWORD,
  OPTION_KEY_PASSWORD,
  OPTION_STORE_PASSWORD_FILE,
  OPTION_KEY_PASSWORD_FILE,
  OPTION_NO_KEYTOOL,
  OPTION_NEW_MATERIAL,
])
const PASSWORD_FLAGS = new Set([OPTION_NO_KEYTOOL, OPTION_NEW_MATERIAL])

const OPTION_SET = '--set'
const MATERIAL_OPTIONS = new Set([OPTION_CONFIG, OPTION_NAME, OPTION_PRODUCT, OPTION_SET])
const MATERIAL_FLAGS = new Set()
const MATERIAL_MULTI_OPTIONS = new Set([OPTION_SET])
const MATERIAL_EDITABLE_FIELDS = new Set([
  'storeFile',
  'certpath',
  'profile',
  'keyAlias',
  'signAlg',
])

const MATERIAL_ENV_OPTIONS = new Set([
  OPTION_CONFIG,
  OPTION_NAME,
  OPTION_PRODUCT,
  OPTION_NO_KEYTOOL,
  OPTION_NEW_MATERIAL,
  OPTION_REQUIRE_ALL,
])
const MATERIAL_ENV_FLAGS = new Set([OPTION_NO_KEYTOOL, OPTION_NEW_MATERIAL, OPTION_REQUIRE_ALL])

const ENV_OPTIONS = new Set([
  OPTION_CONFIG,
  OPTION_PRODUCT,
  OPTION_NAME,
  OPTION_FORMAT,
  OPTION_SEPARATOR,
  OPTION_GITHUB,
  OPTION_GITHUB_REPO,
  OPTION_GITHUB_ENV,
])
const ENV_FLAGS = new Set([OPTION_GITHUB])

const ENV_STORE_FILE = 'HARMONY_STORE_FILE'
const ENV_STORE_FILE_BASE64 = 'HARMONY_STORE_FILE_BASE64'
const ENV_STORE_FILE_OUT = 'HARMONY_STORE_FILE_OUT'
const ENV_CERTPATH = 'HARMONY_CERTPATH'
const ENV_CERT = 'HARMONY_CERT'
const ENV_CERTPATH_BASE64 = 'HARMONY_CERTPATH_BASE64'
const ENV_CERT_BASE64 = 'HARMONY_CERT_BASE64'
const ENV_CERTPATH_OUT = 'HARMONY_CERTPATH_OUT'
const ENV_PROFILE = 'HARMONY_PROFILE'
const ENV_PROFILE_BASE64 = 'HARMONY_PROFILE_BASE64'
const ENV_PROFILE_OUT = 'HARMONY_PROFILE_OUT'
const ENV_KEY_ALIAS = 'HARMONY_KEY_ALIAS'
const ENV_SIGN_ALG = 'HARMONY_SIGN_ALG'
const ENV_STORE_PASSWORD = 'HARMONY_STORE_PASSWORD'
const ENV_KEY_PASSWORD = 'HARMONY_KEY_PASSWORD'
const ENV_CONFIG = 'HARMONY_CONFIG'
const ENV_NAME = 'HARMONY_SIGNING_NAME'
const ENV_PRODUCT = 'HARMONY_PRODUCT'
const ENV_VERBOSE = 'HARMONY_VERBOSE'

const DEFAULT_SIGN_ALG = 'SHA256withECDSA'
const DEFAULT_CONFIG = 'build-profile.json5'
const DEFAULT_NAME = 'default'

const MATERIAL_FIELDS = [
  'certpath',
  'keyAlias',
  'keyPassword',
  'profile',
  'signAlg',
  'storeFile',
  'storePassword',
]

const VERBOSE_ON_VALUES = new Set(['1', 'true', 'yes', 'on'])
const VERBOSE_OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

/** 解析 --verbose / HARMONY_VERBOSE */
function resolveSigningVerbose(options, env, help) {
  if (options.get(OPTION_VERBOSE) === true) {
    return true
  }
  const value = readEnv(env, ENV_VERBOSE)
  if (value === undefined) {
    return false
  }
  const normalized = value.trim().toLowerCase()
  if (VERBOSE_ON_VALUES.has(normalized)) {
    return true
  }
  if (VERBOSE_OFF_VALUES.has(normalized)) {
    return false
  }
  throw new UsageError(
    `环境变量 ${ENV_VERBOSE} 的值无效: "${value}"（开启用 1/true/yes/on，关闭用 0/false/no/off）`,
    help(),
  )
}

// ------------------------------------------------------------------ 帮助文档

function renderSigningConfigHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei ${COMMAND_NAME} - 生成鸿蒙 build-profile.json5 签名配置`,
    usage: [`${PROGRAM} huawei ${COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [
            `${OPTION_STORE_FILE} <文件|BASE64>`,
            `鸿蒙签名密钥库 .p12 路径，或直接给 BASE64，必填（可用 ${ENV_STORE_FILE} / ${ENV_STORE_FILE_BASE64} 补齐）`,
          ],
          [
            `${OPTION_STORE_FILE_OUT} <文件>`,
            `p12 内容/复制目标；默认当前目录的 storeFile.p12（可用 ${ENV_STORE_FILE_OUT} 补齐）`,
          ],
          [
            `${OPTION_CERTPATH} <文件|PEM|BASE64>`,
            `鸿蒙签名证书 .cer 路径，或直接给 PEM 内容 / BASE64（DER 或 PEM），必填（可用 ${ENV_CERTPATH} 补齐）`,
          ],
          [
            `${OPTION_CERTPATH_OUT} <文件>`,
            `证书内容/复制目标；默认 .p12 同级的 certpath.cer（可用 ${ENV_CERTPATH_OUT} 补齐）`,
          ],
          [
            `${OPTION_PROFILE} <文件|BASE64>`,
            `鸿蒙 Provisioning Profile .p7b 路径，或直接给 BASE64，必填（可用 ${ENV_PROFILE} / ${ENV_PROFILE_BASE64} 补齐）`,
          ],
          [
            `${OPTION_PROFILE_OUT} <文件>`,
            `profile 内容/复制目标；默认 .p12 同级的 profile.p7b（可用 ${ENV_PROFILE_OUT} 补齐）`,
          ],
          [`${OPTION_KEY_ALIAS} <别名>`, `p12 里的密钥别名；不传时用 keytool 自动读取（可用 ${ENV_KEY_ALIAS} 补齐）`],
          [`${OPTION_SIGN_ALG} <算法>`, `签名算法，默认 ${DEFAULT_SIGN_ALG}（可用 ${ENV_SIGN_ALG} 补齐）`],
          [
            `${OPTION_STORE_PASSWORD} <明文>`,
            `.p12 明文口令；会进入 ps / shell 历史，建议用 ${ENV_STORE_PASSWORD} 或交互输入`,
          ],
          [
            `${OPTION_KEY_PASSWORD} <明文>`,
            `密钥明文口令；默认与 ${OPTION_STORE_PASSWORD} 相同（可用 ${ENV_KEY_PASSWORD} 补齐）`,
          ],
          [`${OPTION_STORE_PASSWORD_FILE} <文件>`, `从文件第一行读 .p12 口令；- 表示 stdin`],
          [`${OPTION_KEY_PASSWORD_FILE} <文件>`, `从文件第一行读密钥口令；- 表示 stdin`],
          [
            `${OPTION_CONFIG} <文件>`,
            `build-profile.json5 路径，默认 ./${DEFAULT_CONFIG}；--write / --product 时需要（可用 ${ENV_CONFIG} 补齐）`,
          ],
          [`${OPTION_NAME} <名字>`, `要更新/输出的 signingConfig 名字，默认 ${DEFAULT_NAME}（可用 ${ENV_NAME} 补齐）`],
          [`${OPTION_PRODUCT} <产品>`, `按 products[].name 找到它挂的 signingConfig 作为名字（可用 ${ENV_PRODUCT} 补齐）`],
          [OPTION_WRITE, '把生成的 material 写回 build-profile.json5（只更新同名 signingConfig，改前备份）'],
          [OPTION_NEW_MATERIAL, 'material 已存在也重造一套（旧的挪成 material.bak-<时间戳>）'],
          [OPTION_NO_KEYTOOL, '跳过 keytool 别名发现与「口令能否打开 p12」的自检'],
          [OPTION_VERBOSE, `输出 .p12 / .cer / .p7b 的详细信息（默认输出常用字段）；命令行未给出时读取 ${ENV_VERBOSE}`],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_STORE_FILE, `等价于 ${OPTION_STORE_FILE}；可以是路径或 BASE64`],
          [ENV_STORE_FILE_BASE64, `BASE64 的 .p12，等价于 ${OPTION_STORE_FILE}`],
          [ENV_STORE_FILE_OUT, `等价于 ${OPTION_STORE_FILE_OUT}`],
          [ENV_CERTPATH, `等价于 ${OPTION_CERTPATH}；可以是路径、PEM 内容或 BASE64`],
          [ENV_CERT, `证书来源别名，等价于 ${OPTION_CERTPATH}`],
          [ENV_CERTPATH_BASE64, `BASE64 证书（DER / PEM），等价于 ${OPTION_CERTPATH}`],
          [ENV_CERT_BASE64, `BASE64 证书别名，等价于 ${OPTION_CERTPATH}`],
          [ENV_CERTPATH_OUT, `等价于 ${OPTION_CERTPATH_OUT}`],
          [ENV_PROFILE, `等价于 ${OPTION_PROFILE}；可以是路径或 BASE64`],
          [ENV_PROFILE_BASE64, `BASE64 的 .p7b，等价于 ${OPTION_PROFILE}`],
          [ENV_PROFILE_OUT, `等价于 ${OPTION_PROFILE_OUT}`],
          [ENV_KEY_ALIAS, `等价于 ${OPTION_KEY_ALIAS}`],
          [ENV_SIGN_ALG, `等价于 ${OPTION_SIGN_ALG}`],
          [ENV_STORE_PASSWORD, `等价于 ${OPTION_STORE_PASSWORD}（推荐）`],
          [ENV_KEY_PASSWORD, `等价于 ${OPTION_KEY_PASSWORD}`],
          [ENV_CONFIG, `等价于 ${OPTION_CONFIG}`],
          [ENV_NAME, `等价于 ${OPTION_NAME}`],
          [ENV_PRODUCT, `等价于 ${OPTION_PRODUCT}`],
          [ENV_VERBOSE, '输出签名材料详细信息，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', '可以直接粘贴进 app.signingConfigs 的 signingConfig JSON（保持纯 JSON，方便管道）'],
          ['stderr', '签名材料信息（.p12 / .cer / .p7b）、进度、material 位置、keytool 自检结果与 --write 的备份路径'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功'],
          ['1', '参数缺失、参数错误、文件读取 / 校验失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${ENV_STORE_PASSWORD}=<p12口令> ${PROGRAM} huawei ${COMMAND_NAME} \\`,
      `    --store-file ./storeFile.p12 --certpath ./certpath.cer --profile ./profile.p7b \\`,
      `    --key-alias dev --name default --write --config ./build-profile.json5`,
      `  ${PROGRAM} huawei ${COMMAND_NAME} --store-file ./storeFile.p12 \\`,
      `    --certpath ./certpath.cer --profile ./profile.p7b`,
      '',
      '说明: 默认在 stderr 输出 .p12 / .cer / .p7b 的材料信息；--verbose 输出全部字段',
      '说明: material 固定生成在 .p12 同级目录的 material/ 下；hvigor 的 DecipherUtil 从这里取 workKey',
      '说明: --store-file / HARMONY_STORE_FILE / HARMONY_STORE_FILE_BASE64 支持 .p12 路径或 BASE64；内容会写到 --store-file-out 或当前目录的 storeFile.p12',
      '说明: --profile / HARMONY_PROFILE / HARMONY_PROFILE_BASE64 支持 .p7b 路径或 BASE64；内容会写到 --profile-out 或 .p12 同级的 profile.p7b',
      '说明: 覆盖已有 .p12 前会先备份；内容与现有文件相同则直接复用',
      '说明: --certpath / HARMONY_CERTPATH 支持 .cer 路径、PEM 内容、BASE64（DER 或 PEM）；内容会写到 --certpath-out 或 .p12 同级的 certpath.cer',
      '说明: 覆盖已有证书前会先备份；内容与现有证书相同则直接复用',
      '说明: material 与本机绑定，删掉后两串密文就无法解密；它和 .p12 一样不能入库',
      '说明: --write 只更新已存在的同名 signingConfig 的 material；没有同名配置时请把 stdout 的块手工粘贴进去',
      '说明: keytool 自检会把明文口令作为本地 keytool 的参数传入；没有 JDK / 不想自检时加 --no-keytool',
      '说明: 没有给 --key-alias 且 keytool 不可用时，命令无法自动识别别名，会直接报错',
    ],
  })
}

// ------------------------------------------------------------------ 开关与密码

function resolvePasswordFromFile(file, label, help) {
  const target = file === '-' ? 0 : path.resolve(file)
  if (file !== '-' && !fs.existsSync(target)) {
    throw new UsageError(`${label}文件不存在: ${file}`, help)
  }
  const text = fs.readFileSync(target, 'utf8')
  const value = text.split(/\r?\n/, 1)[0]
  if (value === '') {
    throw new UsageError(`${label}文件是空的: ${file}`, help)
  }
  return value
}

/** 终端里问口令：不回显；Ctrl-C 退出码 130（与 shell 惯例一致） */
function promptHidden(question) {
  return new Promise((resolve) => {
    process.stderr.write(question)
    const stdin = process.stdin
    const wasRaw = stdin.isTTY ? stdin.isRaw : undefined
    if (stdin.isTTY) {
      stdin.setRawMode(true)
    }
    stdin.resume()
    let input = ''
    const cleanup = () => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) {
        stdin.setRawMode(Boolean(wasRaw))
      }
      stdin.pause()
    }
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          cleanup()
          process.stderr.write('\n')
          resolve(input)
          return
        }
        if (char === '\u0003') {
          cleanup()
          process.stderr.write('\n')
          process.exit(130)
        }
        if (char === '\u007f' || char === '\b') {
          input = input.slice(0, -1)
          continue
        }
        input += char
      }
    }
    stdin.on('data', onData)
  })
}

/**
 * 解析一个口令：
 *   命令行选项 → 口令文件 → 同名环境变量 → fallback（密钥口令跟 .p12 口令）
 *   → 终端交互（仅 TTY）。
 */
async function resolvePassword({ options, env, option, fileOption, envName, label, fallback, help }) {
  const direct = options.get(option)
  if (direct !== undefined) {
    return { value: direct, source: option }
  }
  const file = options.get(fileOption)
  if (file !== undefined) {
    if (fallback !== undefined && file === '-' && options.get(OPTION_STORE_PASSWORD_FILE) === '-') {
      throw new UsageError('两个口令文件不能都用 -（stdin 只能读一次）', help)
    }
    return { value: resolvePasswordFromFile(file, label, help), source: `${fileOption} ${file}` }
  }
  const fromEnv = readEnv(env, envName)
  if (fromEnv !== undefined) {
    return { value: fromEnv, source: `环境变量 ${envName}` }
  }
  if (fallback !== undefined) {
    return { value: fallback, source: undefined }
  }
  if (!process.stdin.isTTY) {
    throw new UsageError(
      `缺少 ${label}: 请用 ${option}、${fileOption} 或环境变量 ${envName}（非交互环境没有终端可以询问）`,
      help,
    )
  }
  const value = await promptHidden(`请输入 ${label}（明文，不回显）：`)
  if (value === '') {
    throw new UsageError(`${label}不能为空`, help)
  }
  return { value, source: '交互输入' }
}

/** 口令指纹：只打印前 12 位，用来核对来源，不把口令写进日志 */
function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

// ------------------------------------------------------------------ keytool

function keytoolBinary() {
  return process.env.KEYTOOL || 'keytool'
}

function keytoolAvailable() {
  const result = spawnSync(keytoolBinary(), ['-help'], { stdio: 'ignore' })
  return !result.error
}

function runKeytool(args) {
  const result = spawnSync(keytoolBinary(), args, { encoding: 'utf8' })
  if (result.error) {
    return { ok: false, detail: `调用 ${keytoolBinary()} 失败：${result.error.message}` }
  }
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim() || `退出码 ${result.status}`
    return { ok: false, detail }
  }
  return { ok: true, out: result.stdout }
}

/** 从 keytool -list 的输出里读第一个 PrivateKeyEntry 的别名 */
function discoverAlias(storeFile, storePassword) {
  const result = runKeytool([
    '-list',
    '-keystore',
    storeFile,
    '-storepass',
    storePassword,
  ])
  if (!result.ok) {
    return { ok: false, detail: result.detail }
  }
  const lines = result.out.split('\n').map((line) => line.trim()).filter(Boolean)
  const entry =
    lines.find((line) => /PrivateKeyEntry/i.test(line)) ??
    lines.find((line) => line.split(',').length >= 3)
  if (!entry) {
    return { ok: false, detail: '这个 keystore 里没有私钥条目（keytool -list 没找到 PrivateKeyEntry）' }
  }
  return { ok: true, alias: entry.split(',')[0].trim() }
}

/** 用 keytool -certreq 真正解锁一次私钥，确认 storePassword / keyPassword / alias 三者对得上 */
function verifyPasswordPair(storeFile, storePassword, keyPassword, alias) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-apk-huawei-'))
  try {
    return runKeytool([
      '-certreq',
      '-keystore',
      storeFile,
      '-storepass',
      storePassword,
      '-alias',
      alias,
      '-keypass',
      keyPassword,
      '-file',
      path.join(scratch, 'check.csr'),
    ])
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

function renderSigningPasswordsHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei ${PASSWORDS_COMMAND_NAME} - 补充 build-profile.json5 的口令`,
    usage: [`${PROGRAM} huawei ${PASSWORDS_COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '作用',
        entries: [
          [
            '只补充',
            '已有 build-profile.json5 的 signingConfigs[].material.keyPassword / storePassword；其它 material 字段保持不变',
          ],
          [
            'material',
            '按 .p12 同级目录的 material/ 加密；不存在时自动生成，已有可用 material 复用',
          ],
        ],
      },
      {
        title: '选项',
        entries: [
          [
            `${OPTION_CONFIG} <文件>`,
            `build-profile.json5 路径，默认 ./${DEFAULT_CONFIG}（可用 ${ENV_CONFIG} 补齐）`,
          ],
          [`${OPTION_NAME} <名字>`, `要补充的 signingConfig 名字，默认 ${DEFAULT_NAME}（可用 ${ENV_NAME} 补齐）`],
          [`${OPTION_PRODUCT} <产品>`, `按 products[].name 找到它挂的 signingConfig（可用 ${ENV_PRODUCT} 补齐）`],
          [
            `${OPTION_STORE_PASSWORD} <明文>`,
            `.p12 明文口令；建议用 ${ENV_STORE_PASSWORD} 或交互输入`,
          ],
          [
            `${OPTION_KEY_PASSWORD} <明文>`,
            `密钥明文口令；默认与 ${OPTION_STORE_PASSWORD} 相同`,
          ],
          [`${OPTION_STORE_PASSWORD_FILE} <文件>`, '从文件第一行读 .p12 口令；- 表示 stdin'],
          [`${OPTION_KEY_PASSWORD_FILE} <文件>`, '从文件第一行读密钥口令；- 表示 stdin'],
          [OPTION_NEW_MATERIAL, 'material 已存在也重造一套（旧的挪成 material.bak-<时间戳>）'],
          [OPTION_NO_KEYTOOL, '跳过 keytool 别名发现与「口令能否打开 p12」的自检'],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_CONFIG, `等价于 ${OPTION_CONFIG}`],
          [ENV_NAME, `等价于 ${OPTION_NAME}`],
          [ENV_PRODUCT, `等价于 ${OPTION_PRODUCT}`],
          [ENV_STORE_PASSWORD, `等价于 ${OPTION_STORE_PASSWORD}`],
          [ENV_KEY_PASSWORD, `等价于 ${OPTION_KEY_PASSWORD}`],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', '补充结果（配置 / signingConfig / 密钥库 / 别名 / material / 备份）'],
          ['stderr', '进度、keytool 自检结果与警告；明文口令不会输出'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功'],
          ['1', '参数缺失、配置 / 密钥库校验失败或写回失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${ENV_STORE_PASSWORD}=<p12口令> ${PROGRAM} huawei ${PASSWORDS_COMMAND_NAME} \\`,
      `    --config ./build-profile.json5 --name default`,
      '',
      '说明: 不需要 certpath / profile；只改 keyPassword / storePassword，其它 material 字段和注释保持不变',
      '说明: 明文口令会用 .p12 同级 material/ 的 workKey 加密后再写入，不会写入明文',
      '说明: 写回前会备份到 build-profile.json5 所在目录的 .signing/backup/',
      '说明: 没有 keytool / 不想自检时加 --no-keytool；别名取 material.keyAlias',
    ],
  })
}

function renderSigningMaterialHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei ${MATERIAL_COMMAND_NAME} - 替换 build-profile.json5 的 material 字段`,
    usage: [`${PROGRAM} huawei ${MATERIAL_COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '作用',
        entries: [
          [
            '只替换',
            '目标 signingConfigs[].material 中指定的字段；其它字段、顺序与注释保持不变',
          ],
          [
            '可改字段',
            'storeFile / certpath / profile / keyAlias / signAlg；口令请用 signing-passwords',
          ],
        ],
      },
      {
        title: '选项',
        entries: [
          [
            `${OPTION_CONFIG} <文件>`,
            `build-profile.json5 路径，默认 ./${DEFAULT_CONFIG}（可用 ${ENV_CONFIG} 补齐）`,
          ],
          [`${OPTION_NAME} <名字>`, `要修改的 signingConfig 名字，默认 ${DEFAULT_NAME}（可用 ${ENV_NAME} 补齐）`],
          [`${OPTION_PRODUCT} <产品>`, `按 products[].name 找到它挂的 signingConfig（可用 ${ENV_PRODUCT} 补齐）`],
          [
            `${OPTION_SET} <字段=值>`,
            '要替换的 material 字段，可重复；例如 --set storeFile=./storeFile.p12 --set keyAlias=release',
          ],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_CONFIG, `等价于 ${OPTION_CONFIG}`],
          [ENV_NAME, `等价于 ${OPTION_NAME}`],
          [ENV_PRODUCT, `等价于 ${OPTION_PRODUCT}`],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', '替换结果（配置 / signingConfig / 替换的字段 / 备份）'],
          ['stderr', '进度与警告'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功'],
          ['1', '参数缺失、配置 / material 校验失败或写回失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} huawei ${MATERIAL_COMMAND_NAME} --config ./build-profile.json5 --name default \\`,
      `    --set storeFile=./storeFile.p12 --set keyAlias=release`,
      '',
      '说明: 只改指定字段，不重新生成 material、不改口令；口令空白请用 signing-passwords',
      '说明: 写回前备份到 build-profile.json5 所在目录的 .signing/backup/，写后回读校验',
      '说明: keyPassword / storePassword 不接受 --set；请用 huawei signing-passwords 加密后写入',
    ],
  })
}

function renderSigningMaterialEnvHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei ${MATERIAL_ENV_COMMAND_NAME} - 用 CI 环境变量替换 material`,
    usage: [`${PROGRAM} huawei ${MATERIAL_ENV_COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '作用',
        entries: [
          [
            '流程',
            '读取 HARMONY_* 环境变量 → 校验证书 / Profile / p12 / 口令 → 替换目标 material 的对应字段',
          ],
          [
            '校验',
            '证书、Profile、p12 内容先解析；有口令时用 keytool 自检；全部通过后才写回配置',
          ],
        ],
      },
      {
        title: '选项',
        entries: [
          [
            `${OPTION_CONFIG} <文件>`,
            `build-profile.json5 路径，默认 ./${DEFAULT_CONFIG}（可用 ${ENV_CONFIG} 补齐）`,
          ],
          [`${OPTION_NAME} <名字>`, `要修改的 signingConfig 名字，默认 ${DEFAULT_NAME}（可用 ${ENV_NAME} 补齐）`],
          [`${OPTION_PRODUCT} <产品>`, `按 products[].name 找到它挂的 signingConfig（可用 ${ENV_PRODUCT} 补齐）`],
          [OPTION_NO_KEYTOOL, '跳过 keytool 口令自检（仍会校验证书 / Profile / p12 内容）'],
          [OPTION_NEW_MATERIAL, 'material 已存在也重造一套（旧的挪成 material.bak-<时间戳>）'],
          [OPTION_REQUIRE_ALL, '要求 store / cert / profile / 口令齐全；缺一项直接失败（CI 用）'],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_STORE_FILE, 'p12 路径或 BASE64，替换 material.storeFile'],
          [ENV_STORE_FILE_BASE64, 'p12 的 BASE64，替换 material.storeFile'],
          [ENV_STORE_FILE_OUT, 'p12 内容输出路径；不传时按 storeFile 默认规则'],
          [ENV_CERTPATH, '证书路径 / PEM / BASE64，替换 material.certpath'],
          [ENV_CERT, '证书来源别名'],
          [ENV_CERTPATH_BASE64, '证书 BASE64'],
          [ENV_CERT_BASE64, '证书 BASE64 别名'],
          [ENV_CERTPATH_OUT, '证书内容输出路径'],
          [ENV_PROFILE, 'P7B 路径或 BASE64，替换 material.profile'],
          [ENV_PROFILE_BASE64, 'P7B 的 BASE64'],
          [ENV_PROFILE_OUT, 'P7B 内容输出路径'],
          [ENV_KEY_ALIAS, '替换 material.keyAlias'],
          [ENV_SIGN_ALG, '替换 material.signAlg'],
          [ENV_STORE_PASSWORD, 'p12 口令；同时更新 storePassword / keyPassword'],
          [ENV_KEY_PASSWORD, '密钥口令；默认与 storePassword 相同'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', '替换结果（配置 / signingConfig / 替换字段 / material / 备份）'],
          ['stderr', '校验进度、警告；明文口令不会输出'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功'],
          ['1', '参数缺失、环境变量内容校验失败或写回失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${ENV_STORE_FILE_BASE64}=... ${ENV_CERTPATH_BASE64}=... ${ENV_PROFILE_BASE64}=... \\`,
      `    ${ENV_STORE_PASSWORD}=<口令> ${PROGRAM} huawei ${MATERIAL_ENV_COMMAND_NAME} \\`,
      `    --config ./build-profile.json5 --name default`,
      '',
      '说明: 至少提供一个 HARMONY_* 材料变量；没有提供的字段保持原值',
      '说明: 有 HARMONY_STORE_PASSWORD 时按 .p12 同级 material/ 加密并同时更新两串口令',
      '说明: 只给 HARMONY_KEY_PASSWORD 时需要同时给 HARMONY_STORE_PASSWORD 才能校验 / 加密',
      '说明: 写回前备份到 .signing/backup/，写后回读校验',
    ],
  })
}

function renderSigningEnvHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei ${ENV_COMMAND_NAME} - 导出鸿蒙签名 CI 变量`,
    usage: [`${PROGRAM} huawei ${ENV_COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '作用',
        entries: [
          [
            '输入',
            '按 build-profile.json5 的 product / signingConfig 读取 material、p12、证书、Profile 与密文口令',
          ],
          [
            '输出',
            '七个 HARMONY_* 变量；加 --github 时改为写入 GitHub Actions 密钥（stdout 只列变量名）',
          ],
        ],
      },
      {
        title: '选项',
        entries: [
          [
            `${OPTION_CONFIG} <文件>`,
            `build-profile.json5 路径，默认 ./${DEFAULT_CONFIG}（可用 ${ENV_CONFIG} 补齐）`,
          ],
          [`${OPTION_PRODUCT} <产品>`, `按 products[].name 找到它挂的 signingConfig（可用 ${ENV_PRODUCT} 补齐）`],
          [`${OPTION_NAME} <名字>`, `不按产品时直接指定 signingConfig，默认 ${DEFAULT_NAME}（可用 ${ENV_NAME} 补齐）`],
          [OPTION_FORMAT, '输出格式：env（默认）/ shell / json；与 --github 不能同时使用'],
          [OPTION_SEPARATOR, 'env 输出的分隔符：默认 =；可设为 :；与 --github 不能同时使用'],
          [OPTION_GITHUB, '经 GitHub REST API 写入 Actions 密钥（用 GITHUB_TOKEN）'],
          [`${OPTION_GITHUB_REPO} <owner/repo>`, '目标仓库；默认取 GITHUB_REPOSITORY 或当前 git remote；给出即启用 --github'],
          [`${OPTION_GITHUB_ENV} <环境>`, '写入 GitHub Environment 密钥（环境需已存在）；给出即启用 --github'],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_CONFIG, `等价于 ${OPTION_CONFIG}`],
          [ENV_PRODUCT, `等价于 ${OPTION_PRODUCT}`],
          [ENV_NAME, `等价于 ${OPTION_NAME}`],
          ['GITHUB_TOKEN', '--github 必填：需要仓库 Secrets 写权限（fine-grained 的 Secrets 读写；classic 的 repo）'],
          ['GITHUB_REPOSITORY', '--github 可选：owner/repo，GitHub Actions 自动注入'],
          ['GITHUB_API_URL', '--github 可选：API 地址，默认 https://api.github.com（GHES 用 .../api/v3）'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', '默认七个 HARMONY_* 变量（BASE64 单行；口令为明文）；--github 时只列写入的变量名'],
          ['stderr', '明文口令警告与错误信息；--github 时不输出任何值'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功'],
          ['1', '配置 / 产品 / material / 文件校验失败、口令解密失败或 GitHub 写入失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} huawei ${ENV_COMMAND_NAME} --config ./build-profile.json5 --product prod`,
      `  ${PROGRAM} huawei ${ENV_COMMAND_NAME} --config ./build-profile.json5 --product prod --format shell`,
      `  ${PROGRAM} huawei ${ENV_COMMAND_NAME} --config ./build-profile.json5 --name default --format json`,
      `  ${PROGRAM} huawei ${ENV_COMMAND_NAME} --config ./build-profile.json5 --product prod --github`,
      `  ${PROGRAM} huawei ${ENV_COMMAND_NAME} --config ./build-profile.json5 --product prod --github \\`,
      `    --github-repo owner/repo --github-env production`,
      '',
      '警告: 默认输出包含明文口令，不要写入日志、提交仓库或公开分享',
      '说明: --github 直接调 GitHub REST API，不依赖 gh CLI；值用 libsodium sealed box 加密后上传',
      '说明: Actions 内置的 GITHUB_TOKEN 通常不能写 Secrets；CI 里请用有 Secrets 写权限的 PAT',
      '说明: --github-env 要求对应的 GitHub Environment 已存在',
      '说明: --github 与 --format / --separator 不能同时使用（后两者只控制 stdout）',
      '说明: material 必须与 material.storeFile 指向的 .p12 同级；本命令只读不写',
      '说明: p12 / 证书 / Profile 必须存在，口令必须能用 material 解密',
    ],
  })
}

// ------------------------------------------------------------------ 路径与 material

/** 错误信息里只给证书来源的简短描述，避免把整段 PEM / BASE64 回显 */
function describeSource(value) {
  if (value.includes('-----BEGIN') || value.length > 120) {
    return `(已省略，共 ${value.length} 字符)`
  }
  return value
}

function certificatePemFromText(value) {
  const blocks = [
    ...normalizePemText(value).matchAll(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ),
  ].map((match) => match[0])
  if (blocks.length === 0) {
    return null
  }
  const pem = `${blocks.join('\n')}\n`
  try {
    return { certificate: new X509Certificate(pem), pem }
  } catch {
    return null
  }
}

/**
 * 从选项 / 环境变量的值里解析证书内容。
 *
 * 支持：
 *   - PEM 文本（真实换行，或 `\n` 转义）
 *   - BASE64：DER 证书，或 BASE64 后再包一层 PEM
 * 不是证书内容时返回 null，由调用方按路径处理。
 */
function certificateFromValue(value) {
  const text = value.trim()
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    return certificatePemFromText(value)
  }
  const compact = value.replace(/\s+/g, '')
  if (compact === '' || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    return null
  }
  try {
    const base64 = compact.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(base64, 'base64')
    const decodedText = decoded.toString('utf8')
    if (decodedText.includes('-----BEGIN CERTIFICATE-----')) {
      return certificatePemFromText(decodedText)
    }
    const certificate = new X509Certificate(decoded)
    return { certificate, pem: `${certificate.toString().trim()}\n` }
  } catch {
    return null
  }
}

/** 读取证书文件，并转成统一的 PEM 文本 */
function readCertificateFile(file, help) {
  let buffer
  try {
    buffer = fs.readFileSync(file)
  } catch (error) {
    throw new UsageError(`读取证书失败: ${file}: ${error.message}`, help)
  }
  try {
    const certificate = new X509Certificate(buffer)
    return { certificate, pem: `${certificate.toString().trim()}\n` }
  } catch (error) {
    throw new UsageError(`证书解析失败: ${file}: ${error.message}`, help)
  }
}

/** 把证书写到 outPath；已存在相同证书则复用，不同则先备份再覆盖 */
function writeCertificateFile(outPath, source, help) {
  const absolute = path.resolve(outPath)
  if (fs.existsSync(absolute)) {
    if (!fs.statSync(absolute).isFile()) {
      throw new UsageError(`证书输出路径不是普通文件: ${outPath}`, help)
    }
    let existing
    try {
      existing = new X509Certificate(fs.readFileSync(absolute))
    } catch {
      existing = null
    }
    if (existing !== null && existing.fingerprint256 === source.certificate.fingerprint256) {
      return { path: absolute, reused: true }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${absolute}.bak-${stamp}`
    fs.copyFileSync(absolute, backup)
    stderr(`警告: 已有证书不同或无法解析，已备份到 ${backup}`)
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, source.pem, { mode: 0o644 })
  return { path: absolute, reused: false }
}

/**
 * 解析证书来源并返回最终写进 build-profile.json5 的 certpath。
 *
 * value 是路径时直接用（给了 outValue 则复制到 outValue）；
 * value 是 PEM / BASE64 时写到 outValue，未给时写到 .p12 同级的 certpath.cer。
 */
function resolveCertificate(value, outValue, storeFile, help) {
  const absolute = path.resolve(value)
  if (fs.existsSync(absolute)) {
    if (!fs.statSync(absolute).isFile()) {
      throw new UsageError(`证书路径不是普通文件: ${value}`, help)
    }
    const source = readCertificateFile(absolute, help)
    if (outValue === undefined) {
      return absolute
    }
    const written = writeCertificateFile(outValue, source, help)
    stderr(`证书已写入: ${written.path}${written.reused ? '（与现有证书相同，复用）' : ''}`)
    return written.path
  }

  const source = certificateFromValue(value)
  if (source === null) {
    throw new UsageError(
      `证书文件不存在，内容也不是合法的 PEM / BASE64 证书: ${describeSource(value)}`,
      help,
    )
  }
  const target = outValue ?? path.join(path.dirname(storeFile), 'certpath.cer')
  const written = writeCertificateFile(target, source, help)
  stderr(`证书内容已写入: ${written.path}${written.reused ? '（与现有证书相同，复用）' : ''}`)
  return written.path
}

/**
 * 按顺序尝试多个证书来源（环境变量别名可能同时存在）。
 *
 * 命令行 --certpath 只尝试它自己（显式输错应当报错，而不是悄悄改用环境变量）；
 * 环境变量层按 HARMONY_CERTPATH → HARMONY_CERT → HARMONY_CERTPATH_BASE64 → HARMONY_CERT_BASE64
 * 依次尝试，前一个不是合法路径 / 内容时再试下一个。
 */
function resolveCertificateCandidates(values, outValue, storeFile, help) {
  let lastError
  for (const value of values) {
    try {
      return resolveCertificate(value, outValue, storeFile, help)
    } catch (error) {
      if (!(error instanceof UsageError)) {
        throw error
      }
      lastError = error
    }
  }
  throw lastError ?? new UsageError('证书来源为空', help)
}

/**
 * 判断 BASE64 解出来的字节像不像 PKCS#12。
 *
 * PFX ::= SEQUENCE { version INTEGER (3), ... }，所以内容开头必须是 `02 01 03`；
 * 证书也是 DER SEQUENCE（0x30），只看首字节会把 .cer 误当成 .p12。
 */
function looksLikePkcs12(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x30) {
    return false
  }
  let offset = 1
  const firstLength = buffer[offset]
  offset += 1
  if ((firstLength & 0x80) !== 0) {
    const byteCount = firstLength & 0x7f
    if (byteCount === 0 || byteCount > 4 || offset + byteCount > buffer.length) {
      return false
    }
    offset += byteCount
  }
  return (
    offset + 3 <= buffer.length &&
    buffer[offset] === 0x02 &&
    buffer[offset + 1] === 0x01 &&
    buffer[offset + 2] === 0x03
  )
}

/** 从选项 / 环境变量值解析 BASE64 的 PKCS#12；不是 BASE64 或不是 PKCS#12 返回 null */
function base64StoreFileFromValue(value) {
  const compact = value.replace(/\s+/g, '')
  if (compact === '' || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    return null
  }
  try {
    const base64 = compact.replace(/-/g, '+').replace(/_/g, '/')
    const buffer = Buffer.from(base64, 'base64')
    return looksLikePkcs12(buffer) ? buffer : null
  } catch {
    return null
  }
}

/** 把 p12 写到 outPath；已存在且字节相同则复用，不同则先备份再覆盖 */
function writeStoreFile(outPath, buffer, help) {
  const absolute = path.resolve(outPath)
  if (fs.existsSync(absolute)) {
    if (!fs.statSync(absolute).isFile()) {
      throw new UsageError(`storeFile 输出路径不是普通文件: ${outPath}`, help)
    }
    const existing = fs.readFileSync(absolute)
    if (existing.equals(buffer)) {
      return { path: absolute, reused: true }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${absolute}.bak-${stamp}`
    fs.copyFileSync(absolute, backup)
    stderr(`警告: 已有 storeFile 不同，已备份到 ${backup}`)
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, buffer, { mode: 0o600 })
  return { path: absolute, reused: false }
}

/**
 * 解析 .p12 来源并返回最终写进 build-profile.json5 的 storeFile。
 *
 * value 是路径时直接用（给了 outValue 则复制到 outValue）；
 * value 是 BASE64 时写到 outValue，未给时写到当前目录的 storeFile.p12。
 */
function resolveStoreFile(value, outValue, help) {
  const absolute = path.resolve(value)
  if (fs.existsSync(absolute)) {
    if (!fs.statSync(absolute).isFile()) {
      throw new UsageError(`storeFile 路径不是普通文件: ${value}`, help)
    }
    const buffer = fs.readFileSync(absolute)
    if (outValue === undefined) {
      return absolute
    }
    const written = writeStoreFile(outValue, buffer, help)
    stderr(`storeFile 已写入: ${written.path}${written.reused ? '（与现有文件相同，复用）' : ''}`)
    return written.path
  }

  const buffer = base64StoreFileFromValue(value)
  if (buffer === null) {
    throw new UsageError(
      `storeFile 文件不存在，内容也不是合法的 BASE64 PKCS#12: ${describeSource(value)}`,
      help,
    )
  }
  const target = outValue ?? path.resolve('storeFile.p12')
  const written = writeStoreFile(target, buffer, help)
  stderr(`storeFile 内容已写入: ${written.path}${written.reused ? '（与现有文件相同，复用）' : ''}`)
  return written.path
}

/** 按顺序尝试多个 .p12 来源；命令行 --store-file 只尝试它自己 */
function resolveStoreFileCandidates(values, outValue, help) {
  let lastError
  for (const value of values) {
    try {
      return resolveStoreFile(value, outValue, help)
    } catch (error) {
      if (!(error instanceof UsageError)) {
        throw error
      }
      lastError = error
    }
  }
  throw lastError ?? new UsageError('.p12 来源为空', help)
}

/** SignedData OID：1.2.840.113549.1.7.2 */
const SIGNED_DATA_OID = Buffer.from('06092a864886f70d010702', 'hex')

/** 取 DER SEQUENCE 的内容起点；不是 SEQUENCE 返回 -1 */
function derSequenceContentOffset(buffer) {
  if (buffer.length < 2 || buffer[0] !== 0x30) {
    return -1
  }
  let offset = 1
  const firstLength = buffer[offset]
  offset += 1
  if ((firstLength & 0x80) !== 0) {
    const byteCount = firstLength & 0x7f
    if (byteCount === 0 || byteCount > 4 || offset + byteCount > buffer.length) {
      return -1
    }
    offset += byteCount
  }
  return offset
}

/** 判断 DER 是不是 PKCS#7 SignedData（P7B） */
function looksLikePkcs7(buffer) {
  const offset = derSequenceContentOffset(buffer)
  return (
    offset >= 0 &&
    offset + SIGNED_DATA_OID.length <= buffer.length &&
    buffer.subarray(offset, offset + SIGNED_DATA_OID.length).equals(SIGNED_DATA_OID)
  )
}

/** 从 PEM PKCS#7 文本里取出 DER；不是 SignedData 返回 null */
function profileDerFromPemText(text) {
  const match =
    /-----BEGIN (?:PKCS7|PKCS #7 SIGNED DATA)-----([\s\S]*?)-----END (?:PKCS7|PKCS #7 SIGNED DATA)-----/.exec(
      text,
    )
  if (match === null) {
    return null
  }
  const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
  return looksLikePkcs7(der) ? der : null
}

/** 从选项 / 环境变量值解析 BASE64（DER 或 PEM）的 P7B；不是 p7b 返回 null */
function profileDerFromValue(value) {
  const text = value.trim()
  if (
    text.includes('-----BEGIN PKCS7-----') ||
    text.includes('-----BEGIN PKCS #7 SIGNED DATA-----')
  ) {
    return profileDerFromPemText(text)
  }
  const compact = value.replace(/\s+/g, '')
  if (compact === '' || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    return null
  }
  try {
    const der = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const decodedText = der.toString('utf8')
    if (
      decodedText.includes('-----BEGIN PKCS7-----') ||
      decodedText.includes('-----BEGIN PKCS #7 SIGNED DATA-----')
    ) {
      return profileDerFromPemText(decodedText)
    }
    return looksLikePkcs7(der) ? der : null
  } catch {
    return null
  }
}

/** 把 profile 写到 outPath；已存在且字节相同则复用，不同则先备份再覆盖 */
function writeProfileFile(outPath, buffer, help) {
  const absolute = path.resolve(outPath)
  if (fs.existsSync(absolute)) {
    if (!fs.statSync(absolute).isFile()) {
      throw new UsageError(`profile 输出路径不是普通文件: ${outPath}`, help)
    }
    const existing = fs.readFileSync(absolute)
    if (existing.equals(buffer)) {
      return { path: absolute, reused: true }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${absolute}.bak-${stamp}`
    fs.copyFileSync(absolute, backup)
    stderr(`警告: 已有 profile 不同，已备份到 ${backup}`)
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, buffer, { mode: 0o644 })
  return { path: absolute, reused: false }
}

/**
 * 解析 .p7b 来源并返回最终写进 build-profile.json5 的 profile。
 *
 * value 是路径时直接用（给了 outValue 则复制到 outValue）；
 * value 是 BASE64 / PEM 内容时写到 outValue，未给时写到 .p12 同级的 profile.p7b。
 */
function resolveProfile(value, outValue, storeFile, help) {
  const absolute = path.resolve(value)
  if (fs.existsSync(absolute)) {
    if (!fs.statSync(absolute).isFile()) {
      throw new UsageError(`profile 路径不是普通文件: ${value}`, help)
    }
    const buffer = fs.readFileSync(absolute)
    if (outValue === undefined) {
      return absolute
    }
    const written = writeProfileFile(outValue, buffer, help)
    stderr(`profile 已写入: ${written.path}${written.reused ? '（与现有文件相同，复用）' : ''}`)
    return written.path
  }

  const der = profileDerFromValue(value)
  if (der === null) {
    throw new UsageError(
      `profile 文件不存在，内容也不是合法的 BASE64 PKCS#7: ${describeSource(value)}`,
      help,
    )
  }
  const target = outValue ?? path.join(path.dirname(storeFile), 'profile.p7b')
  const written = writeProfileFile(target, der, help)
  stderr(`profile 内容已写入: ${written.path}${written.reused ? '（与现有文件相同，复用）' : ''}`)
  return written.path
}

/** 按顺序尝试多个 .p7b 来源；命令行 --profile 只尝试它自己 */
function resolveProfileCandidates(values, outValue, storeFile, help) {
  let lastError
  for (const value of values) {
    try {
      return resolveProfile(value, outValue, storeFile, help)
    } catch (error) {
      if (!(error instanceof UsageError)) {
        throw error
      }
      lastError = error
    }
  }
  throw lastError ?? new UsageError('.p7b 来源为空', help)
}

/** 备份已有 material 目录，避免 --new-material 直接把旧钥匙覆盖掉 */
function backupMaterial(materialDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${materialDir}.bak-${stamp}`
  fs.renameSync(materialDir, backup)
  stderr(`警告: 旧的 material 已挪到 ${backup}`)
  stderr('警告: 用同一份 material 的其它 signingConfig，其密文口令也需要重新生成')
}

/** 复用或生成 material，返回 workKey 与说明 */
function prepareMaterial(materialDir, newMaterial, help) {
  const existing = fs.existsSync(materialDir)
  if (existing && !fs.statSync(materialDir).isDirectory()) {
    throw new UsageError(`material 路径不是目录: ${materialDir}`, help)
  }
  if (existing && newMaterial) {
    backupMaterial(materialDir)
  }
  if (fs.existsSync(materialDir)) {
    try {
      return { workKey: readMaterialKey(materialDir), note: '复用已有 material' }
    } catch (error) {
      throw new UsageError(
        `${materialDir} 已存在但读不出 workKey（${error.message}）；` +
          `先修好它，或加 ${OPTION_NEW_MATERIAL} 重造一套`,
        help,
      )
    }
  }
  const workKey = randomBytes(16)
  generateMaterial(materialDir, workKey)
  return { workKey, note: '现场生成 material' }
}

// ------------------------------------------------------------------ build-profile 写入

function skipString(text, index) {
  const quote = text[index]
  let cursor = index + 1
  while (cursor < text.length) {
    if (text[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (text[cursor] === quote) {
      return cursor + 1
    }
    cursor += 1
  }
  return text.length
}

function findContainerEnd(text, openIndex) {
  let depth = 0
  let cursor = openIndex
  while (cursor < text.length) {
    const char = text[cursor]
    if (char === '"' || char === "'") {
      cursor = skipString(text, cursor)
      continue
    }
    if (char === '/' && text[cursor + 1] === '/') {
      const end = text.indexOf('\n', cursor)
      cursor = end < 0 ? text.length : end + 1
      continue
    }
    if (char === '/' && text[cursor + 1] === '*') {
      const end = text.indexOf('*/', cursor + 2)
      cursor = end < 0 ? text.length : end + 2
      continue
    }
    if (char === '[' || char === '{') {
      depth += 1
    } else if (char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) {
        return cursor
      }
    }
    cursor += 1
  }
  return -1
}

function stringField(text, key) {
  // 要求 key 前面是 { / [ / 逗号或空白，避免把 bundle-name 这类键里的 name 子串也匹配进来
  const match = new RegExp(`(?:^|[,{\\s\\[])["']?${key}["']?\\s*:\\s*"([^"]*)"`).exec(text)
  if (!match) {
    return undefined
  }
  // 回读校验时 Windows 路径里的反斜杠在 JSON 文本中是转义过的，先解回原值再比较
  try {
    return JSON.parse(`"${match[1]}"`)
  } catch {
    return match[1]
  }
}

/** signingConfigs 数组里每一项：{ name, start, end, text } */
function readSigningConfigs(text) {
  const arrayMatch = /["']?signingConfigs["']?\s*:\s*\[/.exec(text)
  if (!arrayMatch) {
    return []
  }
  const arrayOpen = arrayMatch.index + arrayMatch[0].length - 1
  const arrayClose = findContainerEnd(text, arrayOpen)
  if (arrayClose < 0) {
    return []
  }
  const entries = []
  let cursor = arrayOpen + 1
  while (cursor < arrayClose) {
    const open = text.indexOf('{', cursor)
    if (open < 0 || open > arrayClose) {
      break
    }
    const close = findContainerEnd(text, open)
    if (close < 0 || close > arrayClose) {
      break
    }
    const entryText = text.slice(open, close + 1)
    entries.push({
      name: stringField(entryText, 'name'),
      start: open,
      end: close + 1,
      text: entryText,
    })
    cursor = close + 1
  }
  return entries
}

/** products 数组里每一项：{ name, signingConfig } */
function readProducts(text) {
  const arrayMatch = /["']?products["']?\s*:\s*\[/.exec(text)
  if (!arrayMatch) {
    return []
  }
  const arrayOpen = arrayMatch.index + arrayMatch[0].length - 1
  const arrayClose = findContainerEnd(text, arrayOpen)
  if (arrayClose < 0) {
    return []
  }
  const items = []
  let cursor = arrayOpen + 1
  while (cursor < arrayClose) {
    const open = text.indexOf('{', cursor)
    if (open < 0 || open > arrayClose) {
      break
    }
    const close = findContainerEnd(text, open)
    if (close < 0 || close > arrayClose) {
      break
    }
    const entryText = text.slice(open, close + 1)
    items.push({
      name: stringField(entryText, 'name'),
      signingConfig: stringField(entryText, 'signingConfig'),
    })
    cursor = close + 1
  }
  return items
}

/** 生成 material 对象的 JSON5 文本（字段顺序与 DevEco 一致） */
function materialText(material, indent) {
  const fieldIndent = `${indent}    `
  const closeIndent = `${indent}  `
  const fields = MATERIAL_FIELDS.map(
    (key, index) =>
      `${fieldIndent}${JSON.stringify(key)}: ${JSON.stringify(material[key])}` +
      (index < MATERIAL_FIELDS.length - 1 ? ',' : ''),
  )
  return ['{', ...fields, `${closeIndent}}`].join('\n')
}

/** 只替换目标 signingConfig 的 material 对象，保留 name / type / 注释与其它配置 */
function patchSigningConfig(configText, entry, material) {
  const lineStart = configText.lastIndexOf('\n', entry.start) + 1
  const indent = /^[ \t]*/.exec(configText.slice(lineStart, entry.start))[0]
  const block = materialText(material, indent)
  const materialMatch = /["']?material["']?\s*:\s*\{/.exec(entry.text)
  let patchedEntry
  if (materialMatch) {
    const open = materialMatch.index + materialMatch[0].length - 1
    const close = findContainerEnd(entry.text, open)
    if (close < 0) {
      throw new Error('signingConfig 的 material 对象没有闭合')
    }
    patchedEntry = entry.text.slice(0, open) + block + entry.text.slice(close + 1)
  } else {
    const close = entry.text.lastIndexOf('}')
    const before = entry.text.slice(0, close).replace(/\s*$/, '')
    const needComma = !before.endsWith('{') && !before.endsWith(',')
    patchedEntry = `${before}${needComma ? ',' : ''}\n${indent}  "material": ${block}\n${indent}}`
  }
  return configText.slice(0, entry.start) + patchedEntry + configText.slice(entry.end)
}

/** 写回 build-profile.json5；改前备份，写完回读校验 */
function writeSigningConfig(configFile, name, material, help) {
  if (!fs.existsSync(configFile)) {
    throw new UsageError(`build-profile.json5 不存在: ${configFile}`, help)
  }
  const original = fs.readFileSync(configFile, 'utf8')
  const entries = readSigningConfigs(original)
  if (entries.length === 0) {
    throw new UsageError(`${configFile} 里没有 signingConfigs，无法 --write`, help)
  }
  const entry = entries.find((item) => item.name === name)
  if (!entry) {
    throw new UsageError(
      `${configFile} 的 signingConfigs 里没有名为 ${name} 的配置` +
        `（有：${entries.map((item) => item.name ?? '(未命名)').join('、')}）；` +
        '可以不加 --write，把 stdout 的块手工粘贴进去',
      help,
    )
  }
  const patched = patchSigningConfig(original, entry, material)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(path.dirname(configFile), '.signing', 'backup')
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const backup = path.join(backupDir, `${path.basename(configFile)}.bak-${stamp}`)
  fs.copyFileSync(configFile, backup)
  fs.writeFileSync(configFile, patched)

  // 回读校验：确认签名字段真的写进去了，别把错误拖到 hvigor 签名阶段
  const reread = readSigningConfigs(fs.readFileSync(configFile, 'utf8')).find(
    (item) => item.name === name,
  )
  if (!reread) {
    throw new Error(`写回后找不到签名配置 ${name}；备份在 ${backup}，可用 cp 还原`)
  }
  for (const key of MATERIAL_FIELDS) {
    if (stringField(reread.text, key) !== material[key]) {
      throw new Error(
        `写回后 ${key} 与生成值不一致；备份在 ${backup}，可用 cp ${backup} ${configFile} 还原`,
      )
    }
  }
  return backup
}

/** 输出签名材料信息（写 stderr，保持 stdout 的 signingConfig JSON 纯净） */
function emitMaterialInfo({ storeFile, certpath, profile, password, verbose }) {
  stderr('签名材料信息:')
  try {
    const p12 = readPkcs12(storeFile, password, renderSigningConfigHelp)
    const size = fs.statSync(storeFile).size
    stderr(`  --- .p12: ${storeFile} ---`)
    for (const line of renderPkcs12(storeFile, { size, ...p12 }, verbose).split('\n')) {
      stderr(`  ${line}`)
    }
  } catch (error) {
    stderr(`警告: 读取 .p12 信息失败: ${error.message}`)
  }

  try {
    const certificate = new X509Certificate(fs.readFileSync(certpath))
    stderr(`  --- .cer: ${certpath} ---`)
    for (const line of certificateDetailLines(certificate, verbose)) {
      stderr(`  ${line}`)
    }
  } catch (error) {
    stderr(`警告: 读取 .cer 信息失败: ${error.message}`)
  }

  try {
    const buffer = fs.readFileSync(profile)
    stderr(`  --- .p7b: ${profile} ---`)
    for (const line of profileInfoLines(buffer, profile, renderSigningConfigHelp, verbose)) {
      stderr(`  ${line}`)
    }
  } catch (error) {
    stderr(`警告: 读取 .p7b 信息失败: ${error.message}`)
  }
}

/** 从 signingConfigs / products 里选出目标 signingConfig */
function selectSigningConfig(text, productName, name, help) {
  let targetName = name ?? DEFAULT_NAME
  if (productName !== undefined) {
    const product = readProducts(text).find((item) => item.name === productName)
    if (product === undefined) {
      throw new UsageError(`products 里没有名为 ${productName} 的产品`, help)
    }
    if (product.signingConfig === undefined) {
      throw new UsageError(`产品 ${productName} 没有配置 signingConfig`, help)
    }
    targetName = product.signingConfig
  }
  const entries = readSigningConfigs(text)
  const entry = entries.find((item) => item.name === targetName)
  if (entry === undefined) {
    throw new UsageError(
      `signingConfigs 里没有名为 ${targetName} 的配置` +
        `（有：${entries.map((item) => item.name ?? '(未命名)').join('、')}）`,
      help,
    )
  }
  return { entry, name: targetName }
}

/** 只替换 material 文本里的一个字符串字段；字段缺失时插到末尾 */
function setMaterialStringField(text, key, value) {
  const pattern = new RegExp(`((?:^|[,{\\s])["']?${key}["']?\\s*:\\s*)"([^"]*)"`)
  if (pattern.test(text)) {
    return text.replace(pattern, (_, prefix) => `${prefix}${JSON.stringify(value)}`)
  }
  const close = text.lastIndexOf('}')
  if (close < 0) {
    throw new Error('material 对象没有闭合')
  }
  const before = text.slice(0, close).replace(/\s*$/, '')
  const indentMatch = /\n([ \t]+)["']?[\w-]+["']?\s*:/.exec(text)
  const fieldIndent = indentMatch?.[1] ?? '  '
  const closeIndent = fieldIndent.length >= 2 ? fieldIndent.slice(0, -2) : ''
  const comma = before.endsWith('{') || before.endsWith(',') ? '' : ','
  return `${before}${comma}\n${fieldIndent}${JSON.stringify(key)}: ${JSON.stringify(value)}\n${closeIndent}}`
}

/** 只替换目标 material 的指定字符串字段，保留其它字段与注释 */
function patchMaterialFields(configText, entry, fields, help) {
  const materialMatch = /["']?material["']?\s*:\s*\{/.exec(entry.text)
  if (!materialMatch) {
    throw new UsageError('signingConfig 没有 material 对象，无法替换字段', help)
  }
  const open = materialMatch.index + materialMatch[0].length - 1
  const close = findContainerEnd(entry.text, open)
  if (close < 0) {
    throw new UsageError('signingConfig 的 material 对象没有闭合', help)
  }
  let materialText = entry.text.slice(open, close + 1)
  for (const [key, value] of Object.entries(fields)) {
    materialText = setMaterialStringField(materialText, key, value)
  }
  const patchedEntry = entry.text.slice(0, open) + materialText + entry.text.slice(close + 1)
  return configText.slice(0, entry.start) + patchedEntry + configText.slice(entry.end)
}

/** 只改目标 signingConfig 的 keyPassword / storePassword */
function patchMaterialPasswords(configText, entry, keyPasswordHex, storePasswordHex, help) {
  return patchMaterialFields(
    configText,
    entry,
    { keyPassword: keyPasswordHex, storePassword: storePasswordHex },
    help,
  )
}

/** 写回 build-profile.json5；备份后回读校验两个口令字段 */
function writePatchedConfig(configFile, patched, name, expected, help) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(path.dirname(configFile), '.signing', 'backup')
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const backup = path.join(backupDir, `${path.basename(configFile)}.bak-${stamp}`)
  fs.copyFileSync(configFile, backup)
  fs.writeFileSync(configFile, patched)

  const reread = readSigningConfigs(fs.readFileSync(configFile, 'utf8')).find(
    (item) => item.name === name,
  )
  if (!reread) {
    throw new Error(`写回后找不到签名配置 ${name}；备份在 ${backup}，可用 cp 还原`)
  }
  for (const [key, value] of Object.entries(expected)) {
    if (stringField(reread.text, key) !== value) {
      throw new Error(
        `写回后 ${key} 不一致；备份在 ${backup}，可用 cp ${backup} ${configFile} 还原`,
      )
    }
  }
  return backup
}

/** 只补充 build-profile.json5 里 keyPassword / storePassword 的命令入口 */
export async function runHuaweiSigningPasswords(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderSigningPasswordsHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    PASSWORD_OPTIONS,
    renderSigningPasswordsHelp,
    PASSWORD_FLAGS,
  )
  const configFile = path.resolve(
    options.get(OPTION_CONFIG) ?? readEnv(env, ENV_CONFIG) ?? DEFAULT_CONFIG,
  )
  if (!fs.existsSync(configFile)) {
    throw new UsageError(`build-profile.json5 不存在: ${configFile}`, renderSigningPasswordsHelp())
  }
  const configText = fs.readFileSync(configFile, 'utf8')
  const productName = options.get(OPTION_PRODUCT) ?? readEnv(env, ENV_PRODUCT)
  const name = options.get(OPTION_NAME) ?? readEnv(env, ENV_NAME)
  const { entry, name: targetName } = selectSigningConfig(
    configText,
    productName,
    name,
    renderSigningPasswordsHelp(),
  )

  const storeFileValue = stringField(entry.text, 'storeFile')
  if (storeFileValue === undefined || storeFileValue.trim() === '') {
    throw new UsageError(
      '目标 signingConfig 的 material.storeFile 为空；请先用 signing-config 生成完整配置',
      renderSigningPasswordsHelp(),
    )
  }
  const storeFile = path.resolve(path.dirname(configFile), storeFileValue)
  if (!fs.existsSync(storeFile)) {
    throw new UsageError(`material.storeFile 不存在: ${storeFile}`, renderSigningPasswordsHelp())
  }
  if (!fs.statSync(storeFile).isFile()) {
    throw new UsageError(`material.storeFile 不是普通文件: ${storeFile}`, renderSigningPasswordsHelp())
  }
  const keyAlias = stringField(entry.text, 'keyAlias')
  if (keyAlias === undefined || keyAlias.trim() === '') {
    throw new UsageError(
      '目标 signingConfig 的 material.keyAlias 为空；请先用 signing-config 生成完整配置',
      renderSigningPasswordsHelp(),
    )
  }

  const storePassword = await resolvePassword({
    options,
    env,
    option: OPTION_STORE_PASSWORD,
    fileOption: OPTION_STORE_PASSWORD_FILE,
    envName: ENV_STORE_PASSWORD,
    label: '.p12 口令',
    help: renderSigningPasswordsHelp,
  })
  const keyPassword = await resolvePassword({
    options,
    env,
    option: OPTION_KEY_PASSWORD,
    fileOption: OPTION_KEY_PASSWORD_FILE,
    envName: ENV_KEY_PASSWORD,
    label: '密钥口令',
    fallback: storePassword.value,
    help: renderSigningPasswordsHelp,
  })

  const noKeytool = options.get(OPTION_NO_KEYTOOL) === true
  if (!noKeytool) {
    if (!keytoolAvailable()) {
      stderr('警告: 没有找到 keytool，跳过「口令 / 别名能否打开 .p12」的自检')
    } else {
      const pair = verifyPasswordPair(
        storeFile,
        storePassword.value,
        keyPassword.value,
        keyAlias,
      )
      if (!pair.ok) {
        throw new UsageError(
          `keytool 用这套口令打不开别名 ${keyAlias} 的私钥: ${pair.detail}`,
          renderSigningPasswordsHelp(),
        )
      }
      stderr(`keytool 自检通过: 别名 ${keyAlias} 的私钥可以用这套口令打开`)
    }
  } else {
    stderr('按 --no-keytool 跳过 keytool 自检')
  }

  const materialDir = path.join(path.dirname(storeFile), 'material')
  const { workKey, note } = prepareMaterial(
    materialDir,
    options.get(OPTION_NEW_MATERIAL) === true,
    renderSigningPasswordsHelp,
  )
  const storePasswordHex = encryptSecret(workKey, storePassword.value)
  const keyPasswordHex = encryptSecret(workKey, keyPassword.value)
  for (const [label, hex, plain] of [
    ['storePassword', storePasswordHex, storePassword.value],
    ['keyPassword', keyPasswordHex, keyPassword.value],
  ]) {
    if (decryptSecret(materialDir, hex, label) !== plain) {
      throw new Error(`${label} 加密后解不回原文（这是本工具的 bug，请不要写进配置）`)
    }
  }

  const patched = patchMaterialPasswords(
    configText,
    entry,
    keyPasswordHex,
    storePasswordHex,
    renderSigningPasswordsHelp(),
  )
  const backup = writePatchedConfig(
    configFile,
    patched,
    targetName,
    { keyPassword: keyPasswordHex, storePassword: storePasswordHex },
    renderSigningPasswordsHelp(),
  )

  const lines = [
    `配置: ${configFile}`,
    `签名配置: ${targetName}`,
    `密钥库: ${storeFile}`,
    `别名: ${keyAlias}`,
    `material: ${materialDir}（${note}）`,
    'keyPassword: 已补充',
    'storePassword: 已补充',
    `备份: ${backup}`,
  ]
  if (storePassword.value === keyPassword.value) {
    stderr('提示: keyPassword 与 storePassword 相同')
  }
  stderr(`已补充 ${targetName} 的 keyPassword / storePassword；备份在 ${backup}`)
  stdout(lines.join('\n'))
  return EXIT_OK
}

/** 替换 build-profile.json5 的 material 字段 */
export function runHuaweiSigningMaterial(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderSigningMaterialHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    MATERIAL_OPTIONS,
    renderSigningMaterialHelp,
    MATERIAL_FLAGS,
    MATERIAL_MULTI_OPTIONS,
  )
  const configFile = path.resolve(
    options.get(OPTION_CONFIG) ?? readEnv(env, ENV_CONFIG) ?? DEFAULT_CONFIG,
  )
  if (!fs.existsSync(configFile)) {
    throw new UsageError(`build-profile.json5 不存在: ${configFile}`, renderSigningMaterialHelp())
  }
  const configText = fs.readFileSync(configFile, 'utf8')
  const productName = options.get(OPTION_PRODUCT) ?? readEnv(env, ENV_PRODUCT)
  const name = options.get(OPTION_NAME) ?? readEnv(env, ENV_NAME)
  const { entry, name: targetName } = selectSigningConfig(
    configText,
    productName,
    name,
    renderSigningMaterialHelp(),
  )

  const rawSet = options.get(OPTION_SET)
  const values = rawSet === undefined ? [] : Array.isArray(rawSet) ? rawSet : [rawSet]
  if (values.length === 0) {
    throw new UsageError(
      `至少需要一个 ${OPTION_SET} <字段=值>，例如 ${OPTION_SET} storeFile=./storeFile.p12`,
      renderSigningMaterialHelp(),
    )
  }
  const fields = {}
  for (const raw of values) {
    const index = raw.indexOf('=')
    if (index <= 0) {
      throw new UsageError(`--set 需要 <字段=值> 形式: ${raw}`, renderSigningMaterialHelp())
    }
    const key = raw.slice(0, index).trim()
    const value = raw.slice(index + 1)
    if (key === 'keyPassword' || key === 'storePassword') {
      throw new UsageError(
        `${key} 请用 huawei signing-passwords 补充（会按 material 加密），不要直接 --set`,
        renderSigningMaterialHelp(),
      )
    }
    if (!MATERIAL_EDITABLE_FIELDS.has(key)) {
      throw new UsageError(
        `不支持替换 material.${key}；可替换: ${[...MATERIAL_EDITABLE_FIELDS].join(' / ')}`,
        renderSigningMaterialHelp(),
      )
    }
    if (value === '' || /[\r\n\0]/.test(value)) {
      throw new UsageError(`${key} 的值不能为空，也不能包含换行或 NUL 字符`, renderSigningMaterialHelp())
    }
    fields[key] = value
  }

  const patched = patchMaterialFields(configText, entry, fields, renderSigningMaterialHelp())
  const backup = writePatchedConfig(
    configFile,
    patched,
    targetName,
    fields,
    renderSigningMaterialHelp(),
  )

  const lines = [
    `配置: ${configFile}`,
    `签名配置: ${targetName}`,
    '替换:',
  ]
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`- ${key}=${value}`)
  }
  lines.push(`备份: ${backup}`)
  stderr(`已替换 ${targetName} 的 material 字段；备份在 ${backup}`)
  stdout(lines.join('\n'))
  return EXIT_OK
}

/** 用 CI 环境变量校验并替换 build-profile.json5 的 material */
export async function runHuaweiSigningMaterialEnv(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderSigningMaterialEnvHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    MATERIAL_ENV_OPTIONS,
    renderSigningMaterialEnvHelp,
    MATERIAL_ENV_FLAGS,
  )
  const configFile = path.resolve(
    options.get(OPTION_CONFIG) ?? readEnv(env, ENV_CONFIG) ?? DEFAULT_CONFIG,
  )
  if (!fs.existsSync(configFile)) {
    throw new UsageError(`build-profile.json5 不存在: ${configFile}`, renderSigningMaterialEnvHelp())
  }
  const configText = fs.readFileSync(configFile, 'utf8')
  const productName = options.get(OPTION_PRODUCT) ?? readEnv(env, ENV_PRODUCT)
  const name = options.get(OPTION_NAME) ?? readEnv(env, ENV_NAME)
  const { entry, name: targetName } = selectSigningConfig(
    configText,
    productName,
    name,
    renderSigningMaterialEnvHelp(),
  )

  const fields = {}
  const storeValues = [
    readEnv(env, ENV_STORE_FILE),
    readEnv(env, ENV_STORE_FILE_BASE64),
  ].filter((value) => value !== undefined)
  const certValues = [
    readEnv(env, ENV_CERTPATH),
    readEnv(env, ENV_CERT),
    readEnv(env, ENV_CERTPATH_BASE64),
    readEnv(env, ENV_CERT_BASE64),
  ].filter((value) => value !== undefined)
  const profileValues = [
    readEnv(env, ENV_PROFILE),
    readEnv(env, ENV_PROFILE_BASE64),
  ].filter((value) => value !== undefined)
  const keyAliasEnv = readEnv(env, ENV_KEY_ALIAS)
  const signAlgEnv = readEnv(env, ENV_SIGN_ALG)
  const storePasswordEnv = readEnv(env, ENV_STORE_PASSWORD)
  const keyPasswordEnv = readEnv(env, ENV_KEY_PASSWORD)

  if (options.get(OPTION_REQUIRE_ALL) === true) {
    const missing = []
    if (storeValues.length === 0) missing.push(`${ENV_STORE_FILE} / ${ENV_STORE_FILE_BASE64}`)
    if (certValues.length === 0) missing.push(`${ENV_CERTPATH} / ${ENV_CERTPATH_BASE64}`)
    if (profileValues.length === 0) missing.push(`${ENV_PROFILE} / ${ENV_PROFILE_BASE64}`)
    if (storePasswordEnv === undefined) missing.push(ENV_STORE_PASSWORD)
    if (missing.length > 0) {
      throw new UsageError(
        `${OPTION_REQUIRE_ALL} 缺少：${missing.join('、')}`,
        renderSigningMaterialEnvHelp(),
      )
    }
  }

  const configStoreFileValue = stringField(entry.text, 'storeFile')
  let storeFile =
    configStoreFileValue === undefined || configStoreFileValue.trim() === ''
      ? undefined
      : path.resolve(path.dirname(configFile), configStoreFileValue)
  if (storeValues.length > 0) {
    storeFile = resolveStoreFileCandidates(
      storeValues,
      readEnv(env, ENV_STORE_FILE_OUT),
      renderSigningMaterialEnvHelp,
    )
    fields.storeFile = storeFile
  }
  if (certValues.length > 0 || profileValues.length > 0 || storePasswordEnv !== undefined) {
    if (storeFile === undefined) {
      throw new UsageError(
        'material.storeFile 为空；替换证书 / Profile 或口令需要先提供 HARMONY_STORE_FILE',
        renderSigningMaterialEnvHelp(),
      )
    }
    if (!fs.existsSync(storeFile)) {
      throw new UsageError(`material.storeFile 不存在: ${storeFile}`, renderSigningMaterialEnvHelp())
    }
    if (!fs.statSync(storeFile).isFile()) {
      throw new UsageError(`material.storeFile 不是普通文件: ${storeFile}`, renderSigningMaterialEnvHelp())
    }
  }
  if (certValues.length > 0) {
    fields.certpath = resolveCertificateCandidates(
      certValues,
      readEnv(env, ENV_CERTPATH_OUT),
      storeFile,
      renderSigningMaterialEnvHelp,
    )
  }
  if (profileValues.length > 0) {
    fields.profile = resolveProfileCandidates(
      profileValues,
      readEnv(env, ENV_PROFILE_OUT),
      storeFile,
      renderSigningMaterialEnvHelp,
    )
  }
  if (keyAliasEnv !== undefined) {
    if (/[\r\n\0]/.test(keyAliasEnv) || keyAliasEnv.trim() === '') {
      throw new UsageError('HARMONY_KEY_ALIAS 不能为空，也不能包含换行或 NUL 字符', renderSigningMaterialEnvHelp())
    }
    fields.keyAlias = keyAliasEnv
  }
  if (signAlgEnv !== undefined) {
    if (/[\r\n\0]/.test(signAlgEnv) || signAlgEnv.trim() === '') {
      throw new UsageError('HARMONY_SIGN_ALG 不能为空，也不能包含换行或 NUL 字符', renderSigningMaterialEnvHelp())
    }
    fields.signAlg = signAlgEnv
  }

  let materialDir
  let materialNote
  if (keyPasswordEnv !== undefined && storePasswordEnv === undefined) {
    throw new UsageError(
      '只给 HARMONY_KEY_PASSWORD 时还需要 HARMONY_STORE_PASSWORD，才能校验 / 加密',
      renderSigningMaterialEnvHelp(),
    )
  }
  if (storePasswordEnv !== undefined) {
    if (storeFile === undefined) {
      throw new UsageError('更新口令需要 material.storeFile 或 HARMONY_STORE_FILE', renderSigningMaterialEnvHelp())
    }
    if (/[\r\n\0]/.test(storePasswordEnv)) {
      throw new UsageError('HARMONY_STORE_PASSWORD 不能包含换行或 NUL 字符', renderSigningMaterialEnvHelp())
    }
    const keyPassword = keyPasswordEnv ?? storePasswordEnv
    if (/[\r\n\0]/.test(keyPassword)) {
      throw new UsageError('HARMONY_KEY_PASSWORD 不能包含换行或 NUL 字符', renderSigningMaterialEnvHelp())
    }

    let alias = keyAliasEnv ?? stringField(entry.text, 'keyAlias')
    const noKeytool = options.get(OPTION_NO_KEYTOOL) === true
    if (!noKeytool) {
      if (!keytoolAvailable()) {
        if (!alias) {
          throw new UsageError(
            'PATH 上没有 keytool，无法自动识别 .p12 的密钥别名；请用 HARMONY_KEY_ALIAS 指定',
            renderSigningMaterialEnvHelp(),
          )
        }
        stderr('警告: 没有找到 keytool，跳过「口令 / 别名能否打开 .p12」的自检')
      } else {
        if (!alias) {
          const found = discoverAlias(storeFile, storePasswordEnv)
          if (!found.ok) {
            throw new UsageError(`keytool 读不出 .p12 的别名: ${found.detail}`, renderSigningMaterialEnvHelp())
          }
          alias = found.alias
          fields.keyAlias = alias
          stderr(`从 .p12 读取到密钥别名: ${alias}`)
        }
        const pair = verifyPasswordPair(storeFile, storePasswordEnv, keyPassword, alias)
        if (!pair.ok) {
          throw new UsageError(
            `keytool 用这套口令打不开别名 ${alias} 的私钥: ${pair.detail}`,
            renderSigningMaterialEnvHelp(),
          )
        }
        stderr(`keytool 自检通过: 别名 ${alias} 的私钥可以用这套口令打开`)
      }
    } else if (!alias) {
      throw new UsageError(
        '--no-keytool 需要同时用 HARMONY_KEY_ALIAS 指定别名',
        renderSigningMaterialEnvHelp(),
      )
    }

    materialDir = path.join(path.dirname(storeFile), 'material')
    const prepared = prepareMaterial(
      materialDir,
      options.get(OPTION_NEW_MATERIAL) === true,
      renderSigningMaterialEnvHelp,
    )
    materialNote = prepared.note
    const storePasswordHex = encryptSecret(prepared.workKey, storePasswordEnv)
    const keyPasswordHex = encryptSecret(prepared.workKey, keyPassword)
    for (const [label, hex, plain] of [
      ['storePassword', storePasswordHex, storePasswordEnv],
      ['keyPassword', keyPasswordHex, keyPassword],
    ]) {
      if (decryptSecret(materialDir, hex, label) !== plain) {
        throw new Error(`${label} 加密后解不回原文（这是本工具的 bug，请不要写进配置）`)
      }
    }
    fields.storePassword = storePasswordHex
    fields.keyPassword = keyPasswordHex
  }

  if (Object.keys(fields).length === 0) {
    throw new UsageError(
      '没有可替换的 HARMONY_* 材料变量；至少提供 store/cert/profile/alias/signAlg/password 之一',
      renderSigningMaterialEnvHelp(),
    )
  }

  const patched = patchMaterialFields(configText, entry, fields, renderSigningMaterialEnvHelp())
  const backup = writePatchedConfig(
    configFile,
    patched,
    targetName,
    fields,
    renderSigningMaterialEnvHelp(),
  )

  const lines = [
    `配置: ${configFile}`,
    `签名配置: ${targetName}`,
    '替换:',
  ]
  for (const key of ['storeFile', 'certpath', 'profile', 'keyAlias', 'signAlg']) {
    if (fields[key] !== undefined) {
      lines.push(`- ${key}=${fields[key]}`)
    }
  }
  if (fields.storePassword !== undefined) {
    lines.push('- storePassword: 已更新')
    lines.push('- keyPassword: 已更新')
  }
  if (materialDir !== undefined) {
    lines.push(`material: ${materialDir}（${materialNote}）`)
  }
  lines.push(`备份: ${backup}`)
  stderr(`已用环境变量替换 ${targetName} 的 material 字段；备份在 ${backup}`)
  stdout(lines.join('\n'))
  return EXIT_OK
}

/** shell 单引号安全引用 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** env 格式的值加双引号，并转义会破坏 shell / dotenv 的字符 */
function quoteEnvValue(value) {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`')}"`
}

/** 读文件并转单行 BASE64；文件不存在直接报错 */
function fileBase64(file, label, help) {
  if (!fs.existsSync(file)) {
    throw new UsageError(`${label} 不存在: ${file}`, help)
  }
  if (!fs.statSync(file).isFile()) {
    throw new UsageError(`${label} 不是普通文件: ${file}`, help)
  }
  return fs.readFileSync(file).toString('base64')
}

/** 导出 build-profile.json5 对应产品的 CI 变量 */
export async function runHuaweiSigningEnv(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderSigningEnvHelp())
    return EXIT_OK
  }

  const options = parseOptions(argv, ENV_OPTIONS, renderSigningEnvHelp, ENV_FLAGS)

  // GitHub 写入的配置先在本地校验完（仓库 / token / API 地址），再读 material：
  // token 缺失这类错误不该等到解完密文口令才报出来。
  const githubRepoOption = options.get(OPTION_GITHUB_REPO)
  const githubEnvironment = options.get(OPTION_GITHUB_ENV)
  const github =
    options.get(OPTION_GITHUB) === true ||
    githubRepoOption !== undefined ||
    githubEnvironment !== undefined
  let githubTarget
  if (github) {
    if (options.has(OPTION_FORMAT)) {
      throw new UsageError(
        `${OPTION_GITHUB} 不能与 ${OPTION_FORMAT} 一起使用：写入 GitHub 时 stdout 只输出变量名`,
        renderSigningEnvHelp(),
      )
    }
    if (options.has(OPTION_SEPARATOR)) {
      throw new UsageError(
        `${OPTION_GITHUB} 不能与 ${OPTION_SEPARATOR} 一起使用：分隔符只用于 stdout`,
        renderSigningEnvHelp(),
      )
    }
    if (githubRepoOption !== undefined && !/^[^\s/]+\/[^\s/]+$/.test(githubRepoOption)) {
      throw new UsageError(
        `${OPTION_GITHUB_REPO} 需要 owner/repo 形式，实际: ${githubRepoOption}`,
        renderSigningEnvHelp(),
      )
    }
    githubTarget = {
      repo: resolveGithubRepo(githubRepoOption, env),
      token: resolveGithubToken(env),
      apiUrl: resolveGithubApiUrl(env),
    }
  }

  const configFile = path.resolve(
    options.get(OPTION_CONFIG) ?? readEnv(env, ENV_CONFIG) ?? DEFAULT_CONFIG,
  )
  if (!fs.existsSync(configFile)) {
    throw new UsageError(`build-profile.json5 不存在: ${configFile}`, renderSigningEnvHelp())
  }
  const configText = fs.readFileSync(configFile, 'utf8')
  const productName = options.get(OPTION_PRODUCT) ?? readEnv(env, ENV_PRODUCT)
  const name = options.get(OPTION_NAME) ?? readEnv(env, ENV_NAME)
  const { entry, name: targetName } = selectSigningConfig(
    configText,
    productName,
    name,
    renderSigningEnvHelp(),
  )

  const values = {}
  for (const key of [
    'storeFile',
    'certpath',
    'profile',
    'storePassword',
    'keyPassword',
    'keyAlias',
    'signAlg',
  ]) {
    const value = stringField(entry.text, key)
    if (value === undefined || value.trim() === '') {
      throw new UsageError(
        `签名配置 ${targetName} 的 material.${key} 为空；请先用 signing-config 生成完整配置`,
        renderSigningEnvHelp(),
      )
    }
    values[key] = value
  }

  const configDir = path.dirname(configFile)
  const storeFile = path.resolve(configDir, values.storeFile)
  const certpath = path.resolve(configDir, values.certpath)
  const profile = path.resolve(configDir, values.profile)
  const materialDir = path.join(path.dirname(storeFile), 'material')
  let storePassword
  let keyPassword
  try {
    storePassword = decryptSecret(materialDir, values.storePassword, 'storePassword')
    keyPassword = decryptSecret(materialDir, values.keyPassword, 'keyPassword')
  } catch (error) {
    throw new UsageError(`material 口令解密失败: ${error.message}`, renderSigningEnvHelp())
  }
  for (const [label, value] of [
    ['storePassword', storePassword],
    ['keyPassword', keyPassword],
  ]) {
    if (/[\r\n\0]/.test(value)) {
      throw new UsageError(`${label} 包含换行或 NUL 字符，无法导出为环境变量`, renderSigningEnvHelp())
    }
  }

  const variables = [
    ['HARMONY_STORE_FILE_BASE64', fileBase64(storeFile, '.p12', renderSigningEnvHelp())],
    ['HARMONY_PROFILE_BASE64', fileBase64(profile, 'Profile', renderSigningEnvHelp())],
    ['HARMONY_CERTPATH_BASE64', fileBase64(certpath, '证书', renderSigningEnvHelp())],
    ['HARMONY_STORE_PASSWORD', storePassword],
    ['HARMONY_KEY_PASSWORD', keyPassword],
    ['HARMONY_KEY_ALIAS', values.keyAlias],
    ['HARMONY_SIGN_ALG', values.signAlg],
  ]

  const format = String(options.get(OPTION_FORMAT) ?? 'env').trim().toLowerCase()
  const separator = options.get(OPTION_SEPARATOR)

  // 写入 GitHub Actions 密钥：显式 --github，或给了 --github-repo / --github-env（后两者隐含 --github）。
  // 这条路径不输出任何值；值只在内存里用 libsodium sealed box 加密后 PUT 给 GitHub。
  if (github) {
    const written = await setGithubSecrets(variables, {
      repo: githubTarget.repo.full,
      environment: githubEnvironment,
      token: githubTarget.token,
      apiUrl: githubTarget.apiUrl,
    })
    const scope =
      githubEnvironment === undefined ? '仓库' : `Environment（${githubEnvironment}）`
    stdout(
      [
        `GitHub 仓库: ${githubTarget.repo.full}`,
        `密钥范围: ${scope}`,
        `已写入 ${written.length} 个密钥:`,
        ...written.map((item) => `- ${item}`),
      ].join('\n'),
    )
    return EXIT_OK
  }

  if (separator !== undefined && format !== 'env') {
    throw new UsageError(`--separator 只用于 env 格式；当前是 ${format}`, renderSigningEnvHelp())
  }
  if (separator !== undefined && separator !== '=' && separator !== ':') {
    throw new UsageError(`--separator 只支持 = 或 :，实际: ${separator}`, renderSigningEnvHelp())
  }
  const between = separator === ':' ? ': ' : '='
  let output
  if (format === 'env') {
    output = variables.map(([key, value]) => `${key}${between}${quoteEnvValue(value)}`).join('\n')
  } else if (format === 'shell') {
    output = variables.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('\n')
  } else if (format === 'json') {
    output = JSON.stringify(Object.fromEntries(variables), null, 2)
  } else {
    throw new UsageError(`不支持的输出格式: ${format}（仅支持 env / shell / json）`, renderSigningEnvHelp())
  }

  stderr('警告: stdout 包含明文口令，请勿写入日志、提交仓库或公开分享')
  stdout(output)
  return EXIT_OK
}

// ------------------------------------------------------------------ 命令入口

export async function runHuaweiSigningConfig(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderSigningConfigHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    SIGNING_OPTIONS,
    renderSigningConfigHelp,
    SIGNING_FLAGS,
  )
  const verbose = resolveSigningVerbose(options, env, renderSigningConfigHelp)

  const storeOptionValue = options.get(OPTION_STORE_FILE)
  const storeEnvValues = [
    readEnv(env, ENV_STORE_FILE),
    readEnv(env, ENV_STORE_FILE_BASE64),
  ].filter((value) => value !== undefined)
  const storeValues = storeOptionValue === undefined ? storeEnvValues : [storeOptionValue]
  const certOptionValue = options.get(OPTION_CERTPATH)
  const certEnvValues = [
    readEnv(env, ENV_CERTPATH),
    readEnv(env, ENV_CERT),
    readEnv(env, ENV_CERTPATH_BASE64),
    readEnv(env, ENV_CERT_BASE64),
  ].filter((value) => value !== undefined)
  const certValues = certOptionValue === undefined ? certEnvValues : [certOptionValue]
  const profileOptionValue = options.get(OPTION_PROFILE)
  const profileEnvValues = [
    readEnv(env, ENV_PROFILE),
    readEnv(env, ENV_PROFILE_BASE64),
  ].filter((value) => value !== undefined)
  const profileValues = profileOptionValue === undefined ? profileEnvValues : [profileOptionValue]
  const missing = []
  if (storeValues.length === 0) missing.push(`${OPTION_STORE_FILE}（.p12 / BASE64）`)
  if (certValues.length === 0) missing.push(`${OPTION_CERTPATH}（.cer / PEM / BASE64）`)
  if (profileValues.length === 0) missing.push(`${OPTION_PROFILE}（.p7b / BASE64）`)
  if (missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${missing.join('；')}`, renderSigningConfigHelp())
  }

  const storeFileOutValue =
    options.get(OPTION_STORE_FILE_OUT) ?? readEnv(env, ENV_STORE_FILE_OUT)
  const storeFile = resolveStoreFileCandidates(
    storeValues,
    storeFileOutValue,
    renderSigningConfigHelp,
  )
  const signAlg =
    options.get(OPTION_SIGN_ALG) ?? readEnv(env, ENV_SIGN_ALG) ?? DEFAULT_SIGN_ALG

  const noKeytool = options.get(OPTION_NO_KEYTOOL) === true
  const storePassword = await resolvePassword({
    options,
    env,
    option: OPTION_STORE_PASSWORD,
    fileOption: OPTION_STORE_PASSWORD_FILE,
    envName: ENV_STORE_PASSWORD,
    label: '.p12 口令',
    help: renderSigningConfigHelp,
  })
  stderr(
    `.p12 口令来源: ${storePassword.source}（${[...storePassword.value].length} 字符，` +
      `sha256 前 12: ${fingerprint(storePassword.value)}）`,
  )

  const keyPassword = await resolvePassword({
    options,
    env,
    option: OPTION_KEY_PASSWORD,
    fileOption: OPTION_KEY_PASSWORD_FILE,
    envName: ENV_KEY_PASSWORD,
    label: '密钥口令',
    fallback: storePassword.value,
    help: renderSigningConfigHelp,
  })
  const samePassword = keyPassword.value === storePassword.value

  let keyAlias = options.get(OPTION_KEY_ALIAS) ?? readEnv(env, ENV_KEY_ALIAS)
  if (!noKeytool) {
    if (!keytoolAvailable()) {
      if (!keyAlias) {
        throw new UsageError(
          'PATH 上没有 keytool，无法自动识别 .p12 的密钥别名；请用 --key-alias 指定',
          renderSigningConfigHelp(),
        )
      }
      stderr('警告: 没有找到 keytool，跳过「口令 / 别名能否打开 .p12」的自检')
    } else {
      if (!keyAlias) {
        const found = discoverAlias(storeFile, storePassword.value)
        if (!found.ok) {
          throw new UsageError(
            `keytool 读不出 .p12 的别名: ${found.detail}`,
            renderSigningConfigHelp(),
          )
        }
        keyAlias = found.alias
        stderr(`从 .p12 读取到密钥别名: ${keyAlias}`)
      }
      const pair = verifyPasswordPair(storeFile, storePassword.value, keyPassword.value, keyAlias)
      if (!pair.ok) {
        throw new UsageError(
          `keytool 用这套口令打不开别名 ${keyAlias} 的私钥: ${pair.detail}`,
          renderSigningConfigHelp(),
        )
      }
      stderr(`keytool 自检通过: 别名 ${keyAlias} 的私钥可以用这套口令打开`)
    }
  } else {
    if (!keyAlias) {
      throw new UsageError(
        '--no-keytool 需要同时用 --key-alias 指定别名（否则无法自动识别）',
        renderSigningConfigHelp(),
      )
    }
    stderr('按 --no-keytool 跳过 keytool 自检')
  }
  if (!keyAlias) {
    throw new UsageError('密钥别名不能为空', renderSigningConfigHelp())
  }

  const certOutValue = options.get(OPTION_CERTPATH_OUT) ?? readEnv(env, ENV_CERTPATH_OUT)
  const certpath = resolveCertificateCandidates(
    certValues,
    certOutValue,
    storeFile,
    renderSigningConfigHelp,
  )

  const profileOutValue = options.get(OPTION_PROFILE_OUT) ?? readEnv(env, ENV_PROFILE_OUT)
  const profile = resolveProfileCandidates(
    profileValues,
    profileOutValue,
    storeFile,
    renderSigningConfigHelp,
  )

  emitMaterialInfo({
    storeFile,
    certpath,
    profile,
    password: storePassword.value,
    verbose,
  })

  const materialDir = path.join(path.dirname(storeFile), 'material')
  const { workKey, note } = prepareMaterial(
    materialDir,
    options.get(OPTION_NEW_MATERIAL) === true,
    renderSigningConfigHelp,
  )
  const storePasswordHex = encryptSecret(workKey, storePassword.value)
  const keyPasswordHex = encryptSecret(workKey, keyPassword.value)
  for (const [label, hex, plain] of [
    ['storePassword', storePasswordHex, storePassword.value],
    ['keyPassword', keyPasswordHex, keyPassword.value],
  ]) {
    if (decryptSecret(materialDir, hex, label) !== plain) {
      throw new Error(`${label} 加密后解不回原文（这是本工具的 bug，请不要把结果写进配置）`);
    }
  }
  stderr(`material: ${materialDir}（${note}）`)

  const material = {
    certpath,
    keyAlias,
    keyPassword: keyPasswordHex,
    profile,
    signAlg,
    storeFile,
    storePassword: storePasswordHex,
  }

  const configFile = path.resolve(
    options.get(OPTION_CONFIG) ?? readEnv(env, ENV_CONFIG) ?? DEFAULT_CONFIG,
  )
  const productName = options.get(OPTION_PRODUCT) ?? readEnv(env, ENV_PRODUCT)
  const write = options.get(OPTION_WRITE) === true

  let name = options.get(OPTION_NAME) ?? readEnv(env, ENV_NAME)
  let configText
  if (write || productName !== undefined) {
    if (!fs.existsSync(configFile)) {
      throw new UsageError(`build-profile.json5 不存在: ${configFile}`, renderSigningConfigHelp())
    }
    configText = fs.readFileSync(configFile, 'utf8')
  }
  if (productName !== undefined) {
    const product = readProducts(configText).find((item) => item.name === productName)
    if (!product) {
      throw new UsageError(
        `${configFile} 里没有名为 ${productName} 的产品`,
        renderSigningConfigHelp(),
      )
    }
    if (!product.signingConfig) {
      throw new UsageError(
        `产品 ${productName} 没有配 signingConfig，无法确定要更新哪一份`,
        renderSigningConfigHelp(),
      )
    }
    if (!name) {
      name = product.signingConfig.slice(product.signingConfig.lastIndexOf('.') + 1)
    }
  }
  name ??= DEFAULT_NAME

  const signingConfig = {
    name,
    type: 'HarmonyOS',
    material,
  }

  if (write) {
    const backup = writeSigningConfig(configFile, name, material, renderSigningConfigHelp)
    stderr(`已写回 ${configFile} 的 signingConfig ${name}`);
    stderr(`改前备份: ${backup}`);
  }

  if (samePassword) {
    stderr('提示: keyPassword 与 storePassword 相同；hvigor 默认也会用 storePassword 兜底，keyPassword 可省略');
  }
  stderr(`签名算法: ${signAlg}`);
  stderr('注意: material 与本机绑定，不能删除或入库；明文口令在手时可以用本命令重新生成一套');

  stdout(JSON.stringify(signingConfig, null, 2))
  return EXIT_OK
}
