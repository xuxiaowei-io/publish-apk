/**
 * keystore-config 测试：`node tests/keystore-config.test.js`。
 *
 * 只验证「变量 → keystore.properties」这一层，不依赖 keytool / JDK：
 *   - ANDROID_KEYSTORE_BASE64 先解码落到 storeFile，再生成配置；
 *   - 默认输出 keystore.properties，内容与顺序固定，权限 0600；
 *   - 相同内容复用，不同内容默认拒绝，--force 先备份再覆盖；
 *   - --out -、--file / --store-file / ANDROID_STORE_FILE 的优先级；
 *   - Java Properties 转义（反斜杠、行首空格、非 ASCII）与换行拒绝。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../src/publish-apk.js', import.meta.url))
const COMMAND = 'keystore-config'

/** 最小 PKCS#12 文件头（0x30）；本测试只验证解码落盘，不解析内容 */
const KEYSTORE_BYTES = Buffer.concat([Buffer.from([0x30, 0x82, 0x00, 0x10]), Buffer.alloc(32, 0x7a)])
const KEYSTORE_BASE64 = KEYSTORE_BYTES.toString('base64')

/** 从当前环境里去掉 Android 变量，避免宿主环境影响断言 */
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('ANDROID_')),
)

function runConfig(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, COMMAND, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, ...env },
  })
}

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function listBackups(dir, name) {
  return fs.readdirSync(dir).filter((entry) => entry.startsWith(`${name}.bak-`))
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-apk-keystore-config-'))
try {
  const configFile = path.join(dir, 'keystore.properties')
  const keystoreName = 'publish_apk_demo.keystore'
  const sampleEnv = {
    ANDROID_KEYSTORE_BASE64: KEYSTORE_BASE64,
    ANDROID_KEY_ALIAS: 'publish_apk_demo',
    ANDROID_KEYSTORE_PASSWORD: 'store-secret',
    ANDROID_KEY_PASSWORD: 'key-secret',
  }
  const sampleContent =
    `storeFile=${keystoreName}\n` +
    'keyAlias=publish_apk_demo\n' +
    'storePassword=store-secret\n' +
    'keyPassword=key-secret\n'

  // 1) BASE64 + --store-file + 默认配置路径：先落盘 keystore，再写配置
  {
    const result = runConfig(['--store-file', keystoreName], { cwd: dir, env: sampleEnv })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readFileSync(path.join(dir, keystoreName)), KEYSTORE_BYTES)
    assert.equal(read(configFile), sampleContent)
    assert.match(result.stdout, /^配置文件: /m)
    assert.match(result.stdout, /^storeFile: publish_apk_demo\.keystore$/m)
    assert.match(result.stdout, /^keyAlias: publish_apk_demo$/m)
    assert.ok(!result.stdout.includes('store-secret'))
    assert.ok(!result.stderr.includes('store-secret'))
    assert.ok(!result.stdout.includes('key-secret'))
    assert.ok(!result.stderr.includes('key-secret'))
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(configFile).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.join(dir, keystoreName)).mode & 0o777, 0o600)
    }
  }

  // 2) 相同内容复用：keystore 与配置文件都不产生备份
  {
    const result = runConfig(['--store-file', keystoreName], { cwd: dir, env: sampleEnv })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /keystore 已写入: .*（与现有文件相同，复用）/)
    assert.match(result.stderr, /（与现有文件相同，复用）/)
    assert.deepEqual(listBackups(dir, 'keystore.properties'), [])
  }

  // 3) 配置内容不同默认拒绝；--force 先备份再覆盖
  {
    const result = runConfig(['--store-file', keystoreName], {
      cwd: dir,
      env: { ...sampleEnv, ANDROID_KEY_PASSWORD: 'changed-secret' },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /配置文件已存在且内容不同/)
    assert.equal(read(configFile), sampleContent)
    assert.deepEqual(listBackups(dir, 'keystore.properties'), [])

    const forced = runConfig(['--store-file', keystoreName, '--force'], {
      cwd: dir,
      env: { ...sampleEnv, ANDROID_KEY_PASSWORD: 'changed-secret' },
    })
    assert.equal(forced.status, 0, forced.stderr)
    assert.ok(read(configFile).includes('keyPassword=changed-secret\n'))
    const backups = listBackups(dir, 'keystore.properties')
    assert.equal(backups.length, 1)
    assert.equal(read(path.join(dir, backups[0])), sampleContent)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dir, backups[0])).mode & 0o777, 0o600)
    }
  }

  // 4) --out -：stdout 原样输出，stderr 有明文警告
  {
    const result = runConfig(
      [
        '--store-file',
        'pipe.keystore',
        '--store-password',
        'pipe-secret',
        '--out',
        '-',
      ],
      {
        cwd: dir,
        env: {
          ANDROID_KEYSTORE_BASE64: KEYSTORE_BASE64,
          ANDROID_KEY_ALIAS: 'release',
        },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      result.stdout,
      'storeFile=pipe.keystore\nkeyAlias=release\nstorePassword=pipe-secret\nkeyPassword=pipe-secret\n',
    )
    assert.match(result.stderr, /明文口令/)
  }

  // 5) Java Properties 转义：反斜杠、行首空格、非 ASCII
  {
    const result = runConfig(
      [
        '--store-file',
        'C:\\keys\\my keystore.p12',
        '--key-alias',
        'release key',
        '--store-password',
        '  p@ss=word',
        '--key-password',
        '口令',
        '--out',
        'escaped.properties',
      ],
      { cwd: dir },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      read(path.join(dir, 'escaped.properties')),
      [
        'storeFile=C:\\\\keys\\\\my keystore.p12',
        'keyAlias=release key',
        'storePassword=\\ \\ p@ss=word',
        'keyPassword=\\u53e3\\u4ee4',
      ].join('\n') + '\n',
    )
  }

  // 6) --file 是 --store-file 的别名；--config 是 --out 的别名
  {
    const result = runConfig(
      [
        '--file',
        '../alias.keystore',
        '--key-alias',
        'alias',
        '--store-password',
        'alias-secret',
        '--config',
        'alias.properties',
      ],
      { cwd: dir },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      read(path.join(dir, 'alias.properties')),
      'storeFile=../alias.keystore\nkeyAlias=alias\nstorePassword=alias-secret\nkeyPassword=alias-secret\n',
    )
  }

  // 7) ANDROID_STORE_FILE 优先于 ANDROID_KEYSTORE_FILE，ANDROID_KEYSTORE_CONFIG 指定输出
  {
    const result = runConfig([], {
      cwd: dir,
      env: {
        ANDROID_STORE_FILE: 'env.keystore',
        ANDROID_KEYSTORE_FILE: 'ignored.keystore',
        ANDROID_KEY_ALIAS: 'env-alias',
        ANDROID_KEYSTORE_PASSWORD: 'env-secret',
        ANDROID_KEYSTORE_CONFIG: 'env.properties',
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      read(path.join(dir, 'env.properties')),
      'storeFile=env.keystore\nkeyAlias=env-alias\nstorePassword=env-secret\nkeyPassword=env-secret\n',
    )
  }

  // 8) 只给 BASE64 / 别名 / 口令：storeFile 默认 ./<别名>.keystore，配置默认 keystore.properties
  {
    const result = runConfig(['--config', 'defaulted.properties'], {
      cwd: dir,
      env: {
        ANDROID_KEYSTORE_BASE64: KEYSTORE_BASE64,
        ANDROID_KEY_ALIAS: 'defaulted',
        ANDROID_KEYSTORE_PASSWORD: 'default-secret',
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'defaulted.keystore')), KEYSTORE_BYTES)
    assert.equal(
      read(path.join(dir, 'defaulted.properties')),
      'storeFile=./defaulted.keystore\nkeyAlias=defaulted\nstorePassword=default-secret\nkeyPassword=default-secret\n',
    )
  }

  // 9) 没给 BASE64 又没有 storeFile：直接报错，不写文件
  {
    const result = runConfig([], {
      cwd: dir,
      env: {
        ANDROID_KEY_ALIAS: 'release',
        ANDROID_KEYSTORE_PASSWORD: 'secret',
        ANDROID_KEYSTORE_CONFIG: 'missing.properties',
      },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /缺少 storeFile/)
    assert.equal(fs.existsSync(path.join(dir, 'missing.properties')), false)
  }

  // 10) BASE64 不是密钥库：拒绝，不落盘
  {
    const result = runConfig(['--store-file', 'invalid.keystore'], {
      cwd: dir,
      env: {
        ANDROID_KEYSTORE_BASE64: Buffer.from('not-a-keystore').toString('base64'),
        ANDROID_KEY_ALIAS: 'release',
        ANDROID_KEYSTORE_PASSWORD: 'secret',
        ANDROID_KEYSTORE_CONFIG: 'invalid.properties',
      },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /文件头无法识别/)
    assert.equal(fs.existsSync(path.join(dir, 'invalid.keystore')), false)
    assert.equal(fs.existsSync(path.join(dir, 'invalid.properties')), false)
  }

  // 11) 口令含换行 / NUL 时拒绝，避免写出损坏的 properties
  {
    const result = runConfig([], {
      cwd: dir,
      env: {
        ANDROID_KEYSTORE_FILE: 'release.keystore',
        ANDROID_KEY_ALIAS: 'release',
        ANDROID_KEYSTORE_PASSWORD: 'line1\nline2',
        ANDROID_KEYSTORE_CONFIG: 'newline.properties',
      },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /不能包含换行或 NUL 字符/)
    assert.equal(fs.existsSync(path.join(dir, 'newline.properties')), false)
  }

  // 12) 输出路径与 storeFile 相同：拒绝，避免把配置文件写成 keystore
  {
    const result = runConfig(
      [
        '--store-file',
        'keystore.properties',
        '--key-alias',
        'release',
        '--store-password',
        'secret',
        '--out',
        'keystore.properties',
      ],
      { cwd: dir },
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /不能与 storeFile 相同/)
  }

  console.log('keystore-config: 变量生成配置文件测试通过')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
