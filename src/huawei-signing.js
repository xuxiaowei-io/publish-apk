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
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
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
import { decryptSecret, encryptSecret, generateMaterial, readMaterialKey } from './harmony-material.js'
import { renderHelp } from './help.js'

/** 命令名（huawei 子命令） */
const COMMAND_NAME = 'signing-config'

const OPTION_STORE_FILE = '--store-file'
const OPTION_CERTPATH = '--certpath'
const OPTION_PROFILE = '--profile'
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

const SIGNING_OPTIONS = new Set([
  OPTION_STORE_FILE,
  OPTION_CERTPATH,
  OPTION_PROFILE,
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
])
const SIGNING_FLAGS = new Set([OPTION_WRITE, OPTION_NEW_MATERIAL, OPTION_NO_KEYTOOL])

const ENV_STORE_FILE = 'HARMONY_STORE_FILE'
const ENV_CERTPATH = 'HARMONY_CERTPATH'
const ENV_PROFILE = 'HARMONY_PROFILE'
const ENV_KEY_ALIAS = 'HARMONY_KEY_ALIAS'
const ENV_SIGN_ALG = 'HARMONY_SIGN_ALG'
const ENV_STORE_PASSWORD = 'HARMONY_STORE_PASSWORD'
const ENV_KEY_PASSWORD = 'HARMONY_KEY_PASSWORD'
const ENV_CONFIG = 'HARMONY_CONFIG'
const ENV_NAME = 'HARMONY_SIGNING_NAME'
const ENV_PRODUCT = 'HARMONY_PRODUCT'

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

// ------------------------------------------------------------------ 帮助文档

function renderSigningConfigHelp() {
  return renderHelp({
    title: `${PROGRAM} huawei ${COMMAND_NAME} - 生成鸿蒙 build-profile.json5 签名配置`,
    usage: [`${PROGRAM} huawei ${COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [`${OPTION_STORE_FILE} <文件>`, `鸿蒙签名密钥库 .p12，必填（可用 ${ENV_STORE_FILE} 补齐）`],
          [`${OPTION_CERTPATH} <文件>`, `鸿蒙签名证书 .cer，必填（可用 ${ENV_CERTPATH} 补齐）`],
          [`${OPTION_PROFILE} <文件>`, `鸿蒙 Provisioning Profile .p7b，必填（可用 ${ENV_PROFILE} 补齐）`],
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
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_STORE_FILE, `等价于 ${OPTION_STORE_FILE}`],
          [ENV_CERTPATH, `等价于 ${OPTION_CERTPATH}`],
          [ENV_PROFILE, `等价于 ${OPTION_PROFILE}`],
          [ENV_KEY_ALIAS, `等价于 ${OPTION_KEY_ALIAS}`],
          [ENV_SIGN_ALG, `等价于 ${OPTION_SIGN_ALG}`],
          [ENV_STORE_PASSWORD, `等价于 ${OPTION_STORE_PASSWORD}（推荐）`],
          [ENV_KEY_PASSWORD, `等价于 ${OPTION_KEY_PASSWORD}`],
          [ENV_CONFIG, `等价于 ${OPTION_CONFIG}`],
          [ENV_NAME, `等价于 ${OPTION_NAME}`],
          [ENV_PRODUCT, `等价于 ${OPTION_PRODUCT}`],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', '可以直接粘贴进 app.signingConfigs 的 signingConfig JSON'],
          ['stderr', '进度、material 位置、keytool 自检结果与 --write 的备份路径'],
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
      '说明: material 固定生成在 .p12 同级目录的 material/ 下；hvigor 的 DecipherUtil 从这里取 workKey',
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

// ------------------------------------------------------------------ 路径与 material

/** 解析并校验一个必须是普通文件的输入 */
function resolveExistingFile(value, label, help) {
  const absolute = path.resolve(value)
  if (!fs.existsSync(absolute)) {
    throw new UsageError(`${label}不存在: ${value}`, help)
  }
  if (!fs.statSync(absolute).isFile()) {
    throw new UsageError(`${label}不是普通文件: ${value}`, help)
  }
  return absolute
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

  const storeFileValue = options.get(OPTION_STORE_FILE) ?? readEnv(env, ENV_STORE_FILE)
  const certPathValue = options.get(OPTION_CERTPATH) ?? readEnv(env, ENV_CERTPATH)
  const profileValue = options.get(OPTION_PROFILE) ?? readEnv(env, ENV_PROFILE)
  const missing = []
  if (storeFileValue === undefined) missing.push(`${OPTION_STORE_FILE}（.p12）`)
  if (certPathValue === undefined) missing.push(`${OPTION_CERTPATH}（.cer）`)
  if (profileValue === undefined) missing.push(`${OPTION_PROFILE}（.p7b）`)
  if (missing.length > 0) {
    throw new UsageError(`缺少必填参数: ${missing.join('；')}`, renderSigningConfigHelp())
  }

  const storeFile = resolveExistingFile(storeFileValue, '.p12', renderSigningConfigHelp)
  const certpath = resolveExistingFile(certPathValue, '.cer', renderSigningConfigHelp)
  const profile = resolveExistingFile(profileValue, '.p7b', renderSigningConfigHelp)
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
