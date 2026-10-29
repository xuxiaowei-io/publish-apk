#!/usr/bin/env node
/**
 * publish-apk 命令行入口（根命令）。
 *
 * 本文件保持**厂商无关**：只负责根帮助、版本号与命令分发。
 * 各厂商的命令与帮助文档放在各自模块里（当前有 src/huawei.js 与 src/google.js），
 * 新增厂商时实现 runXxx(argv, env) 并在下面 VENDORS 注册一行即可；
 * 与厂商无关的工具命令（当前有 src/cert.js、src/profile.js、src/hap.js、src/apk.js）注册到 TOOLS。
 * apk.js 同时导出 apk / aab 两个命令：APK 与 AAB 的 Android 包查看工具。
 * hap.js 同时导出 hap / app 两个命令：HAP 单模块包与 APP 多模块包的查看工具。
 *
 * 根命令已支持的行为：
 *   1. node src/publish-apk.js              输出根帮助文档
 *   2. node src/publish-apk.js help         输出根帮助文档
 *   3. node src/publish-apk.js --help       输出根帮助文档
 *   4. node src/publish-apk.js -v           输出版本号
 *   5. node src/publish-apk.js <厂商> ...   分发给对应厂商模块（如 huawei / google）
 *   6. node src/publish-apk.js cert ...     查看证书 / PKCS#12 密钥库信息（与厂商无关的工具命令）
 *   7. node src/publish-apk.js profile ...  查看 P7B Provisioning Profile（与厂商无关的工具命令）
 *   8. node src/publish-apk.js hap ...      查看 HAP 安装包信息（与厂商无关的工具命令）
 *   9. node src/publish-apk.js app ...      查看 APP 安装包信息（与厂商无关的工具命令）
 *  10. node src/publish-apk.js apk ...      查看 APK 安装包信息（与厂商无关的工具命令）
 *  11. node src/publish-apk.js aab ...      查看 AAB 安装包信息（与厂商无关的工具命令）
 *  12. node src/publish-apk.js <未知命令>   先输出根帮助文档、再输出错误日志，退出代码 1
 *
 * 厂商命令的详细行为见各自模块的头部注释。
 *
 * 帮助文档写 stdout、错误日志写 stderr，两者分离（便于 `2>/dev/null`）；
 * 用法错误先输出帮助文档、再输出错误日志，保证「怎么用」出现在错误信息之前；
 * 帮助类写法（help、-h、-help、--help、--help=true 等）一律输出帮助文档且退出代码 0。
 */
import { createRequire } from 'node:module'
import process from 'node:process'

import {
  EXIT_FAILURE,
  EXIT_OK,
  PROGRAM,
  UsageError,
  installOutputGuards,
  isHelpToken,
  stderr,
  stdout,
  writeStdout,
} from './cli.js'
import { renderHelp } from './help.js'
import { certCommand } from './cert.js'
import { aabCommand, apkCommand } from './apk.js'
import { appCommand, hapCommand } from './hap.js'
import { googleCommand } from './google.js'
import { huaweiCommand } from './huawei.js'
import { keystoreCommand } from './keystore.js'
import { profileCommand } from './profile.js'

/**
 * 厂商命令表：厂商模块导出 { name, summary, run } 描述，这里注册即可。
 * 新增厂商（如小米）只需两步：
 *   import { xiaomiCommand } from './xiaomi.js'
 *   const VENDORS = [huaweiCommand, googleCommand, xiaomiCommand]
 * 根帮助的「命令」一栏会自动跟着更新。
 */
const VENDORS = [huaweiCommand, googleCommand]

/**
 * 与厂商无关的工具命令表：形状与厂商命令相同，但只操作本地文件与通用密码学数据，
 * 不属于任何应用市场。新增工具（如证书、签名校验）在这里注册。
 */
const TOOLS = [
  certCommand,
  profileCommand,
  hapCommand,
  appCommand,
  apkCommand,
  aabCommand,
  keystoreCommand,
]

/** 根命令总表：厂商命令 + 工具命令；根帮助与命令分发都以它为准 */
const COMMANDS = [...VENDORS, ...TOOLS]

const { version, author } = createRequire(import.meta.url)('../package.json')

/**
 * 作者信息条目：package.json 的 author 可以是字符串，也可以是 { name, email, url } 对象。
 * 只输出给出的字段，避免帮助文档里出现「主页: undefined」这类空行。
 */
function authorEntries(value) {
  if (typeof value === 'string') return [['姓名', value]]
  if (value === null || typeof value !== 'object') return []
  return [
    ['姓名', value.name],
    ['主页', value.url],
    ['邮箱', value.email],
  ].filter(([, text]) => typeof text === 'string' && text !== '')
}

/** 根帮助文档：无参数、help、--help、-h */
function renderRootHelp() {
  const authors = authorEntries(author)
  return renderHelp({
    title: `${PROGRAM} - 发布 APP`,
    usage: [`${PROGRAM} [命令] [选项]`],
    sections: [
      {
        title: '命令',
        entries: [
          ...COMMANDS.map(({ name, summary }) => [name, summary]),
          ['help', '显示帮助信息'],
        ],
      },
      {
        title: '选项',
        entries: [
          ['-h, --help', '显示帮助信息'],
          ['-v, --version', '显示版本号'],
        ],
      },
      ...(authors.length > 0 ? [{ title: '作者', entries: authors }] : []),
    ],
    notes: [
      '示例:',
      `  ${PROGRAM} <厂商>                 查看该厂商的子命令`,
      `  ${PROGRAM} <厂商> <命令> --help   查看该命令的帮助文档`,
      `  ${PROGRAM} cert --file <文件>      查看证书 / PKCS#12 密钥库信息`,
      `  ${PROGRAM} keystore --file <文件>  校验 Android 签名密钥库（口令 / 别名）`,
      `  ${PROGRAM} profile --file <文件>   查看 P7B Provisioning Profile`,
      `  ${PROGRAM} hap --file <文件>       查看 HAP 安装包信息`,
      `  ${PROGRAM} app --file <文件>       查看 APP 安装包信息`,
      `  ${PROGRAM} apk --file <文件>       查看 APK 安装包信息`,
      `  ${PROGRAM} aab --file <文件>       查看 AAB 安装包信息`,
    ],
  })
}

/** 根命令分发：只认识帮助、版本号与已注册的命令 */
async function run(argv, env) {
  const [command, ...rest] = argv
  if (command === undefined || isHelpToken(command)) {
    stdout(renderRootHelp())
    return EXIT_OK
  }
  if (command === '-v' || command === '--version') {
    stdout(version)
    return EXIT_OK
  }

  const commandEntry = COMMANDS.find((item) => item.name === command)
  if (commandEntry !== undefined) {
    return commandEntry.run(rest, env)
  }

  throw new UsageError(`未知命令 "${command}"`, renderRootHelp())
}

async function main() {
  installOutputGuards()
  try {
    // 厂商命令可能需要发起网络请求（如 huawei client-credentials），因此统一 await
    return await run(process.argv.slice(2), process.env)
  } catch (error) {
    if (error instanceof UsageError) {
      // 顺序：先用法、后错误。帮助文档在 stdout、错误日志在 stderr，两个流各自独立缓冲，
      // 所以先 await 帮助文档写完，再写错误日志，终端与重定向里都能看到「用法在前、错误在后」。
      await writeStdout(error.help)
      stderr('')
      stderr(`错误: ${error.message}`)
    } else {
      stderr(`错误: ${error.message}`)
    }
    return EXIT_FAILURE
  }
}

process.exitCode = await main()
