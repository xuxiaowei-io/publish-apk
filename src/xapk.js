/**
 * XAPK 安装包查看命令（`publish-apk xapk`）。
 *
 * XAPK 是第三方渠道（如 APKPure）使用的分发格式，外层是 ZIP：
 *   - manifest.json：分发元数据（包名、版本、SDK、权限、split_apks 列表等）；
 *   - icon.png：应用图标；
 *   - 一个 base APK 与若干 config split APK（如 config.arm64_v8a.apk）；
 *   - 可能还有 OBB 扩展文件（Android/obb/<包名>/*.obb）。
 *
 * 本命令只读文件，不安装、不验签：
 *   - 读取 manifest.json 与全部内层 APK；
 *   - 包名 / 版本 / SDK / 权限 / 启动 Activity 以 base APK 的 AndroidManifest.xml 为准，
 *     manifest.json 作为分发元数据对照；
 *   - 汇总 ABI、DEX、拆分 APK 与 OBB，并输出 base APK 的签名方案与证书；
 *   - --verbose 追加外层 ZIP 条目、manifest.json 原文、各 split 明细、签名块 pair、
 *     完整证书链与全部 Activity。
 *
 * 不引入 npm 第三方依赖；ZIP / 二进制 XML / 签名解析复用 src/apk.js 与 src/hap.js。
 * 退出代码与其它命令一致：0 成功，1 参数错误或文件读取 / 解析失败。
 */
import {
  EXIT_OK,
  PROGRAM,
  UsageError,
  isHelpToken,
  parseOptions,
  readEnv,
  stdout,
} from './cli.js'
import { renderHelp } from './help.js'
import {
  addSignatureCertificates,
  findZipEntry,
  formatBytes,
  readEndOfCentralDirectory,
  readZipEntries,
  readZipEntryData,
} from './hap.js'
import {
  manifestLines,
  parseApk,
  readPackageFile,
  readV1Certificates,
  resolveVerbose,
  signatureLabel,
  signingBlockLines,
  zipEntryLines,
} from './apk.js'

const COMMAND_NAME = 'xapk'
const OPTION_FILE = '--file'
const OPTION_VERBOSE = '--verbose'
const XAPK_OPTIONS = new Set([OPTION_FILE, OPTION_VERBOSE])
const XAPK_FLAGS = new Set([OPTION_VERBOSE])
const XAPK_MULTI_OPTIONS = new Set([OPTION_FILE])

const ENV_FILE = 'XAPK_FILE'
const ENV_VERBOSE = 'XAPK_VERBOSE'

// ------------------------------------------------------------------ 帮助文档

function renderXapkHelp() {
  return renderHelp({
    title: `${PROGRAM} ${COMMAND_NAME} - 查看 XAPK 安装包信息`,
    usage: [`${PROGRAM} ${COMMAND_NAME} [选项]`],
    sections: [
      {
        title: '选项',
        entries: [
          [`${OPTION_FILE} <路径...>`, `一个或多个 XAPK 文件路径（支持 shell glob），必填（可用 ${ENV_FILE} 补齐）`],
          [
            OPTION_VERBOSE,
            `输出全部字段（外层 ZIP 条目、manifest.json、各 split 明细、签名块 pair、完整证书链与全部 Activity）；命令行未给出时读取 ${ENV_VERBOSE}`,
          ],
          ['-h, --help', '显示帮助信息'],
        ],
      },
      {
        title: '环境变量',
        entries: [
          [ENV_FILE, `XAPK 文件路径，等价于 ${OPTION_FILE}`],
          [ENV_VERBOSE, '输出全部字段，1/true/yes/on 开启、0/false/no/off 关闭，等价于 --verbose'],
        ],
      },
      {
        title: '输出',
        entries: [
          ['stdout', 'XAPK 包信息、拆分 APK 与签名证书，每行一条「标签: 值」；--verbose 时追加外层 ZIP 条目、manifest.json 与明细'],
          ['stderr', '错误信息'],
        ],
      },
      {
        title: '退出代码',
        entries: [
          ['0', '成功'],
          ['1', '参数缺失、参数错误或文件读取 / 解析失败'],
        ],
      },
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} ${COMMAND_NAME} --file ./app-1.0.0.xapk`,
      `  ${PROGRAM} ${COMMAND_NAME} --file ./*.xapk --verbose`,
      `  ${ENV_FILE}=./app.xapk ${PROGRAM} ${COMMAND_NAME}`,
      `  ${ENV_VERBOSE}=1 ${PROGRAM} ${COMMAND_NAME} --file ./app.xapk`,
      '',
      '说明: --file 可以一次给多个文件（shell glob 也可），按顺序输出，文件之间空一行',
      '说明: XAPK 是第三方渠道的分发格式，外层 ZIP 含 manifest.json、icon.png、base APK 与 config split APK，可能还有 OBB',
      '说明: 包名 / 版本 / SDK / 权限 / 启动 Activity 优先取自 base APK 的 AndroidManifest.xml，manifest.json 用于分发元数据对照',
      '说明: 内层 APK 逐个解析；签名只检测 JAR v1 与 APK Signature Scheme v2 / v3 / v3.1，未执行证书链与摘要验签',
      '说明: 签名证书默认输出 base APK 的叶子证书 MD5 / SHA-256 指纹；--verbose 输出完整证书链与各 split 明细',
      '说明: 不输出证书 PEM 原文；XAPK 里没有私钥',
    ],
  })
}

// -------------------------------------------------------------- 字段与拆分

/** 把 manifest.json 里的字符串 / 数字统一成非空字符串 */
function textOf(value) {
  if (typeof value === 'string' && value !== '') {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

/** manifest.json 里字符串数组字段的安全读取 */
function listOf(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item !== '')
    : []
}

/** 版本行文本：`1.0.0 (25)` / `1.0.0` / `(25)`；都没有时返回 undefined */
function versionText(versionName, versionCode) {
  const name = textOf(versionName)
  const code = textOf(versionCode)
  if (name === undefined && code === undefined) {
    return undefined
  }
  if (name === undefined) {
    return `(${code})`
  }
  return code === undefined ? name : `${name} (${code})`
}

/** APK 文件名去掉目录与 .apk 后缀，作为 split 标识的兜底 */
function splitIdOf(name) {
  const base = name.split('/').pop() ?? name
  return base.replace(/\.apk$/i, '')
}

/** 读取并解析 manifest.json；没有时返回 undefined */
function readMetadata(buffer, entries, help) {
  const entry = findZipEntry(entries, 'manifest.json')
  if (entry === null) {
    return { metadata: undefined, text: undefined }
  }
  let text = readZipEntryData(buffer, entry, help).toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  let metadata
  try {
    metadata = JSON.parse(text)
  } catch (error) {
    throw new UsageError(`XAPK 的 manifest.json 不是合法 JSON: ${error.message}`, help())
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new UsageError('XAPK 的 manifest.json 不是 JSON 对象', help())
  }
  return { metadata, text }
}

/**
 * 找出外层 ZIP 里的内层 APK。
 *
 * 优先按 manifest.json 的 split_apks 顺序（base 在前的渠道最直观），
 * 再把 manifest.json 没声明的 .apk 追加进来；声明的文件不存在时记入 missing。
 */
function collectSplits(entries, metadata) {
  const apkEntries = entries.filter((entry) => /\.apk$/i.test(entry.name))
  const byName = new Map(apkEntries.map((entry) => [entry.name, entry]))
  const splits = []
  const used = new Set()
  const missing = []
  const declared = Array.isArray(metadata?.split_apks) ? metadata.split_apks : []
  for (const item of declared) {
    const file = typeof item === 'string' ? item : textOf(item?.file)
    if (file === undefined) {
      continue
    }
    const entry =
      byName.get(file) ??
      apkEntries.find((candidate) => candidate.name.endsWith(`/${file}`))
    if (entry === undefined) {
      missing.push(file)
      continue
    }
    if (used.has(entry.name)) {
      continue
    }
    used.add(entry.name)
    const id = typeof item === 'object' && item !== null ? textOf(item.id) : undefined
    splits.push({ entry, id: id ?? splitIdOf(entry.name) })
  }
  for (const entry of apkEntries) {
    if (used.has(entry.name)) {
      continue
    }
    splits.push({ entry, id: splitIdOf(entry.name) })
  }
  return { splits, missing }
}

/** 选出 base APK：优先 manifest.json 的 id=base，其次 <包名>.apk，最后第一个非 config 的 APK */
function baseIndexOf(splits, metadata) {
  const declared = splits.findIndex((split) => split.id.toLowerCase() === 'base')
  if (declared !== -1) {
    return declared
  }
  const packageName = textOf(metadata?.package_name)
  if (packageName !== undefined) {
    const file = `${packageName}.apk`
    const index = splits.findIndex(
      (split) => split.entry.name === file || split.entry.name.endsWith(`/${file}`),
    )
    if (index !== -1) {
      return index
    }
  }
  const index = splits.findIndex(
    (split) => !/^config[._-]/i.test(split.id) && !/^split_config/i.test(split.id),
  )
  return index === -1 ? 0 : index
}

/** 逐个解析内层 APK；单个 split 失败不影响整体，错误记在 split.error 上 */
function parseSplits(path, buffer, splits, help) {
  for (const split of splits) {
    let inner
    try {
      inner = readZipEntryData(buffer, split.entry, help)
    } catch (error) {
      split.error = error.message
      continue
    }
    try {
      const parsed = parseApk(inner, `${path}!/${split.entry.name}`, help)
      split.parsed = parsed
      split.v1 = readV1Certificates(inner, parsed.entries, help)
    } catch (error) {
      split.error = error.message
    }
  }
}

/** 读取外层 ZIP、manifest.json 与全部内层 APK */
function summarizeXapk(buffer, path, help) {
  const eocd = readEndOfCentralDirectory(buffer, help)
  const entries = readZipEntries(buffer, eocd, help)
  const { metadata, text } = readMetadata(buffer, entries, help)
  if (metadata === undefined && !entries.some((entry) => /\.apk$/i.test(entry.name))) {
    throw new UsageError(
      `不是 XAPK：${path} 里没有 manifest.json 或内层 APK（查看单个 APK 用 apk 命令，AAB 用 aab 命令）`,
      help(),
    )
  }
  const { splits, missing } = collectSplits(entries, metadata)
  if (splits.length === 0) {
    throw new UsageError(`不是 XAPK：${path} 里没有内层 APK`, help())
  }
  const baseIndex = baseIndexOf(splits, metadata)
  parseSplits(path, buffer, splits, help)
  return { entries, metadata, metadataText: text, splits, baseIndex, missing }
}

/** split 的 ABI 列表（来自 lib/<abi>/ 目录） */
function abisOf(split) {
  if (split.parsed === undefined) {
    return []
  }
  return [
    ...new Set(
      split.parsed.entries
        .map((entry) => /^lib\/([^/]+)\//.exec(entry.name)?.[1])
        .filter((value) => typeof value === 'string'),
    ),
  ]
}

/** split 里的 DEX 数量 */
function dexCountOf(split) {
  if (split.parsed === undefined) {
    return 0
  }
  return split.parsed.entries.filter((entry) => /(^|\/)classes\d*\.dex$/i.test(entry.name)).length
}

/** split 的签名证书分组（JAR v1 + APK Signature Scheme v2 / v3 / v3.1） */
function certificateGroupsOf(split) {
  if (split.parsed === undefined) {
    return []
  }
  return [
    ...(split.v1 ?? []),
    ...split.parsed.signing.schemes.map((item) => ({
      label: item.scheme,
      certificates: item.certificates,
      error: item.error,
    })),
  ]
}

// ------------------------------------------------------------------ 输出

function xapkLines(path, buffer, summary, verbose) {
  const { entries, metadata, splits, baseIndex, missing } = summary
  const base = splits[baseIndex]
  const baseManifest = base?.parsed?.manifest
  const packageName = baseManifest?.packageName ?? textOf(metadata?.package_name)
  const version = versionText(
    baseManifest?.versionName ?? metadata?.version_name,
    baseManifest?.versionCode ?? metadata?.version_code,
  )
  const minSdk = baseManifest?.minSdkVersion ?? textOf(metadata?.min_sdk_version)
  const targetSdk = baseManifest?.targetSdkVersion ?? textOf(metadata?.target_sdk_version)
  const permissions =
    baseManifest !== undefined && baseManifest.permissions.length > 0
      ? baseManifest.permissions
      : listOf(metadata?.permissions)
  const abis = [...new Set(splits.flatMap(abisOf))]
  const dexCount = splits.reduce((sum, split) => sum + dexCountOf(split), 0)
  const obbEntries = entries.filter((entry) => /\.obb$/i.test(entry.name))

  const lines = [
    `文件: ${path}`,
    `大小: ${formatBytes(buffer.length)}（${buffer.length} 字节）`,
    `格式: XAPK / ZIP（${entries.length} 个条目）`,
  ]
  const xapkVersion = textOf(metadata?.xapk_version)
  if (xapkVersion !== undefined) {
    lines.push(`XAPK 版本: ${xapkVersion}`)
  }
  const appName = textOf(metadata?.name)
  if (appName !== undefined) {
    lines.push(`应用名: ${appName}`)
  }
  if (packageName !== undefined) {
    lines.push(`包名: ${packageName}`)
  }
  if (version !== undefined) {
    lines.push(`版本: ${version}`)
  }
  if (minSdk !== undefined) {
    lines.push(`Min SDK: ${minSdk}`)
  }
  if (targetSdk !== undefined) {
    lines.push(`Target SDK: ${targetSdk}`)
  }
  if (abis.length > 0) {
    lines.push(`ABI: ${abis.join('、')}`)
  }
  lines.push(`DEX: ${dexCount} 个`)
  if (permissions.length > 0) {
    lines.push(`权限: ${permissions.join('、')}`)
  }
  if (baseManifest?.launcher?.name !== undefined) {
    lines.push(`启动 Activity: ${baseManifest.launcher.name}`)
  }
  const signature =
    base?.parsed === undefined
      ? `无法解析（base APK: ${base?.error ?? '未找到'}）`
      : signatureLabel(base.v1 ?? [], base.parsed.signing.schemes)
  lines.push(`签名: ${signature}`)
  lines.push(
    splits.length === 1
      ? '拆分 APK: 1 个（仅 base，无 split）'
      : `拆分 APK: ${splits.length} 个（base + ${splits.length - 1} 个 split）`,
  )
  for (const [index, split] of splits.entries()) {
    const label = index === baseIndex ? 'base' : split.id || 'split'
    const state = split.error === undefined ? '' : `，解析失败：${split.error}`
    lines.push(`- ${label}: ${split.entry.name}（${formatBytes(split.entry.size)}${state}）`)
  }
  lines.push(
    obbEntries.length === 0
      ? 'OBB: 无'
      : `OBB: ${obbEntries
          .map((entry) => `${entry.name}（${formatBytes(entry.size)}）`)
          .join('、')}`,
  )
  if (missing.length > 0) {
    lines.push(`注意: manifest.json 声明的拆分 APK 不在包内: ${missing.join('、')}`)
  }
  addSignatureCertificates(lines, certificateGroupsOf(base), verbose, { md5: true })
  if (!verbose) {
    lines.push(
      '',
      '（加 --verbose 查看全部字段：外层 ZIP 条目、manifest.json、各 split 明细与完整证书链）',
    )
  }
  return lines
}

function xapkVerboseLines(lines, summary) {
  const { entries, metadata, metadataText, splits, baseIndex, missing } = summary
  zipEntryLines(lines, entries, 'XAPK 外层条目:')

  lines.push('', 'manifest.json:')
  lines.push(
    metadataText === undefined
      ? '未找到 manifest.json（按内层 APK 推断）'
      : metadataText.trim(),
  )

  if (metadata !== undefined) {
    const icon = textOf(metadata.icon)
    if (icon !== undefined) {
      const iconEntry = findZipEntry(entries, icon)
      if (iconEntry !== null) {
        lines.push(`图标: ${iconEntry.name}（${iconEntry.size} 字节）`)
      }
    }
    if (missing.length > 0) {
      lines.push(`注意: manifest.json 声明的拆分 APK 不在包内: ${missing.join('、')}`)
    }
  }

  lines.push('', '拆分 APK 明细:')
  for (const [index, split] of splits.entries()) {
    const label = index === baseIndex ? 'base' : split.id || 'split'
    lines.push(`- ${split.entry.name}（${label}，${split.entry.size} 字节）`)
    if (split.error !== undefined) {
      lines.push(`  解析失败: ${split.error}`)
      continue
    }
    const manifest = split.parsed.manifest
    if (manifest.packageName !== undefined) {
      lines.push(`  包名: ${manifest.packageName}`)
    }
    const version = versionText(manifest.versionName, manifest.versionCode)
    if (version !== undefined) {
      lines.push(`  版本: ${version}`)
    }
    if (manifest.minSdkVersion !== undefined) {
      lines.push(`  Min SDK: ${manifest.minSdkVersion}`)
    }
    if (manifest.targetSdkVersion !== undefined) {
      lines.push(`  Target SDK: ${manifest.targetSdkVersion}`)
    }
    const abis = abisOf(split)
    if (abis.length > 0) {
      lines.push(`  ABI: ${abis.join('、')}`)
    }
    lines.push(`  DEX: ${dexCountOf(split)} 个`)
    lines.push(`  签名: ${signatureLabel(split.v1 ?? [], split.parsed.signing.schemes)}`)
    lines.push(`  ZIP 条目: ${split.parsed.entries.length} 个`)
  }

  const base = splits[baseIndex]
  if (base?.parsed === undefined) {
    return
  }

  if (metadata !== undefined && base.parsed.manifest.packageName !== undefined) {
    const declaredPackage = textOf(metadata.package_name)
    if (
      declaredPackage !== undefined &&
      declaredPackage !== base.parsed.manifest.packageName
    ) {
      lines.push(
        '',
        `注意: manifest.json 的包名 ${declaredPackage} 与 base APK 的包名 ${base.parsed.manifest.packageName} 不一致`,
      )
    }
  }

  signingBlockLines(lines, base.parsed.signing, 'base APK 签名块:')
  manifestLines(lines, base.parsed.manifest, 'Manifest（base APK）:')
}

// ------------------------------------------------------------------ 命令入口

function runXapk(argv, env) {
  if (argv.some((token) => isHelpToken(token))) {
    stdout(renderXapkHelp())
    return EXIT_OK
  }

  const options = parseOptions(
    argv,
    XAPK_OPTIONS,
    renderXapkHelp,
    XAPK_FLAGS,
    XAPK_MULTI_OPTIONS,
  )
  const verbose = resolveVerbose(options, env, renderXapkHelp, ENV_VERBOSE)
  const envPath = readEnv(env, ENV_FILE)
  const optionPaths = options.get(OPTION_FILE)
  const paths =
    optionPaths === undefined
      ? envPath === undefined
        ? undefined
        : [envPath]
      : Array.isArray(optionPaths)
        ? optionPaths
        : [optionPaths]
  if (paths === undefined) {
    throw new UsageError(
      `缺少必填参数: ${OPTION_FILE}（XAPK 文件路径，可多个），可用环境变量 ${ENV_FILE}`,
      renderXapkHelp(),
    )
  }

  for (const [index, path] of paths.entries()) {
    const buffer = readPackageFile(path, renderXapkHelp)
    const summary = summarizeXapk(buffer, path, renderXapkHelp)
    const lines = xapkLines(path, buffer, summary, verbose)
    if (verbose) {
      xapkVerboseLines(lines, summary)
    }
    stdout(lines.join('\n'))
    if (index < paths.length - 1) {
      stdout('')
    }
  }
  return EXIT_OK
}

export const xapkCommand = {
  name: COMMAND_NAME,
  summary: '查看 XAPK 安装包信息（manifest.json / 拆分 APK / 签名证书）',
  run: runXapk,
}
