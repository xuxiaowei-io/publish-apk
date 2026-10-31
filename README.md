# publish-apk

发布 APP 的命令行工具：为应用市场**获取鉴权令牌**、**上传安装包**并**登记软件包 / 发布版本**，供上传/发布流水线使用。
当前支持华为应用市场（AppGallery Connect / AGC Connect API）与 Google Play（Android Publisher API v3）。
另提供一组与厂商无关的本地命令：`cert`（证书 / PKCS#12 密钥库）、`profile`（P7B Provisioning Profile）、
`keystore`（校验 Android 签名密钥库的口令 / 别名，BASE64 可落盘）、`keystore-env`（导出 CI 变量）、
`keystore-config`（由 BASE64 / 变量生成 `keystore.properties`）与 `keystore-gen`（快速生成密钥库）。
华为侧另有 `huawei signing-config`，用 `.cer` / `.p7b` / `.p12` 与明文口令生成 `build-profile.json5` 的签名配置。

- 纯 Node.js 实现，**无任何 npm 第三方依赖**（Node 内置模块；查看 PKCS#12 时调用系统 `openssl`，
  校验 Android keystore 时调用 JDK `keytool`）
- `stdout` 只写结果、`stderr` 只写日志与错误，便于 `TOKEN=$(publish-apk …)` 与管道取用
- 厂商隔离：根命令不认识任何厂商，华为相关实现全部在 [src/huawei.js](src/huawei.js)，Google Play 相关实现全部在 [src/google.js](src/google.js)；
  与厂商无关的证书 / 密钥库查看在 [src/cert.js](src/cert.js)，P7B profile 查看在 [src/profile.js](src/profile.js)，
  Android keystore 校验在 [src/keystore.js](src/keystore.js)

> 状态：`0.0.1-alpha.x` 早期版本，参数与输出可能调整，请以 `--help` 为准。

## 声明：与各应用商店无关

- 本项目是**个人/社区开源工具，不是华为、Google 官方产品**，与华为技术有限公司、Google LLC 及其关联公司**没有任何隶属、合作、赞助或背书关系**。
- 本项目与 Google Play、小米应用商店、OPPO 软件商店、vivo 应用商店等**任何应用商店/分发平台同样没有任何隶属、合作、赞助或背书关系**；支持某个平台只表示本工具能调用它的公开接口。
- "华为""HUAWEI""AppGallery""AppGallery Connect""AGC""Google""Google Play""Android"等是各自权利人的商标。本项目仅在**描述性意义**上使用这些名称（指明所调用的服务），不主张任何商标权利；[MIT 许可证](LICENSE) 也不授予任何商标使用权。
- 本项目调用的接口地址、路径、参数与错误码均来自厂商**公开文档**；帮助文档只做中文转述并给出原文链接，不复制厂商文档正文，见 [参考文档](#参考文档上游)。

## 免责声明与责任限制

- 本软件按**"现状"（AS IS）**提供，不附带任何明示或默示担保，包括但不限于适销性、特定用途适用性及非侵权担保。
- 本工具会使用**你提供的签名私钥 / 客户端密钥**调用厂商的接口。相关操作可能**直接影响线上发布**（创建版本、上传安装包、提交审核、发布到轨道等），部分操作**不可撤销**。请先在小号/测试应用上验证，并自行做好密钥管理与版本备份。
- 在任何情况下，作者或版权持有人均不对因使用或无法使用本软件而产生的任何索赔、损害或其他责任负责，无论其源自合同诉讼、侵权行为或其他方式。
- 使用本工具还需遵守厂商的开发者协议与平台规则（如华为开发者协议、AGC 平台规范、Google API 服务条款、Google Play 开发者计划政策）、以及适用的法律法规。相关合规责任由使用者自行承担。
- 本节与 [LICENSE](LICENSE) 中的条款共同适用；若两者冲突，以 [LICENSE](LICENSE) 为准。本节不构成法律意见。

## 环境要求

- Node.js **>= 18**（使用内置 `fetch` 与 `AbortSignal.timeout`）
- 查看 PKCS#12（如 `storeFile.p12`）需要系统 `openssl` 命令（OpenSSL 1.1.1+ / LibreSSL）；其它功能只依赖 Node 内置模块
- `keystore` / `keystore-env` / `keystore-gen` 校验或生成 Android 签名密钥库需要 JDK 的 `keytool`
  （`KEYTOOL=/path/to/keytool` 可指定）；`keystore-config` 只按变量生成配置文件，不调用 keytool
- `huawei signing-config` 的 keytool 自检是可选的：没有 JDK / keytool 时用 `--key-alias` 指定别名即可
- 一键把鸿蒙签名变量写入 GitHub Actions 密钥（`huawei signing-env --github`）需要环境变量
  `GITHUB_TOKEN`（仓库 Secrets 写权限）；加密用 Node 内置模块实现，不需要 `gh` / libsodium

## 安装

```bash
# 全局安装
npm install -g publish-apk

# 或免安装直接运行
npx publish-apk huawei --help
```

仓库内开发时可直接执行：

```bash
node src/publish-apk.js huawei --help
```

## 命令

```bash
publish-apk                       # 根帮助
publish-apk -v                    # 版本号
publish-apk cert --file ./certpath.cer                    # 查看证书
publish-apk cert --file ./storeFile.p12 --password <密码>  # 查看 PKCS#12 密钥库
publish-apk keystore --file ./release.p12 --store-password <口令> --key-alias release  # 校验 Android 签名密钥库
publish-apk keystore-env --file ./release.p12  # 导出 CI 变量（含明文口令）
GITHUB_TOKEN=... publish-apk keystore-env --file ./release.p12 --github  # 一键写入 GitHub Actions 密钥
ANDROID_KEYSTORE_BASE64=... ANDROID_KEYSTORE_PASSWORD=... ANDROID_KEY_ALIAS=... \
  publish-apk keystore-config --store-file ../../publish_apk_demo.keystore  # 生成 keystore.properties
publish-apk keystore-gen --file ./release.p12 --key-alias release  # 快速生成 Android keystore
ANDROID_KEYSTORE_BASE64=... ANDROID_KEYSTORE_PASSWORD=... publish-apk keystore  # 校验 CI 变量
publish-apk profile --file ./profile.p7b                  # 查看 P7B Provisioning Profile
publish-apk hap --file ./app-signed.hap                    # 查看 HAP 安装包信息
publish-apk hap --file ./*.hap                             # 一次查看多个 HAP
publish-apk app --file ./app-signed.app                    # 查看 APP 安装包信息
publish-apk app --file ./*.app                             # 一次查看多个 APP
publish-apk apk --file ./app-arm64-v8a-release.apk        # 查看 APK 安装包信息
publish-apk aab --file ./app-release.aab                  # 查看 AAB 安装包信息
publish-apk apk --file ./*.apk                             # 一次查看多个 APK
publish-apk aab --file ./*.aab                             # 一次查看多个 AAB
```

`huawei` 子命令（华为应用市场 / AppGallery Connect）：

```bash
publish-apk huawei                # huawei 子命令帮助
publish-apk huawei <命令> --help   # 某个子命令的帮助文档
publish-apk huawei service-account --kid <密钥ID> --iss <签发者> \
  --private-key ./private.pem                              # 签发 Service Account JWT
publish-apk huawei service-account-upload-url --app-id <应用ID> \
  --file ./a1.apk --token <Token>                          # 获取文件上传地址
publish-apk huawei service-account-upload-file --app-id <应用ID> \
  --file ./a1.apk --token <Token>                          # 上传到对象存储（objectId）
publish-apk huawei service-account-upload-file-package-info-update --app-id <应用ID> \
  --file ./a1.apk --token <Token>                          # 上传并登记软件包
publish-apk huawei client-credentials --client-id <客户端ID> \
  --client-secret <客户端密钥>                              # 换取 access_token
publish-apk huawei client-credentials-upload-url --app-id <应用ID> \
  --file ./a1.apk --client-id <客户端ID> --token <access_token>  # 获取文件上传地址
publish-apk huawei client-credentials-upload-file --app-id <应用ID> \
  --file ./a1.apk --client-id <客户端ID> --token <access_token>  # 上传到对象存储（objectId）
publish-apk huawei client-credentials-upload-file-package-info-update --app-id <应用ID> \
  --file ./a1.apk --client-id <客户端ID> --token <access_token>  # 上传并登记软件包
publish-apk huawei signing-config --store-file ./storeFile.p12 \
  --certpath ./certpath.cer --profile ./profile.p7b        # 生成鸿蒙签名配置
publish-apk huawei signing-passwords --config ./build-profile.json5  # 只补 material 两串口令
publish-apk huawei signing-material --config ./build-profile.json5 \
  --set storeFile=./storeFile.p12                          # 替换 material 字段
HARMONY_STORE_FILE_BASE64=... HARMONY_CERTPATH_BASE64=... \
  HARMONY_PROFILE_BASE64=... publish-apk huawei signing-material-env  # 用 HARMONY_* 校验并替换 material
publish-apk huawei signing-env --config ./build-profile.json5 --product prod  # 导出鸿蒙签名 CI 变量
publish-apk huawei signing-env --config ./build-profile.json5 --product prod --github  # 一键写入 GitHub Actions 密钥
```

`google` 子命令（Google Play）：

```bash
publish-apk google                # google 子命令帮助
publish-apk google <命令> --help   # 某个子命令的帮助文档
publish-apk google access-token --service-account ./google-play-service-account.json  # 换取 access_token
publish-apk google upload-aab --package-name com.example.app \
  --file ./app-release.aab --service-account ./google-play-service-account.json  # 上传 .aab（stdout 是 versionCode）
publish-apk google upload-aab --package-name com.example.app \
  --file ./app-release.aab --service-account ./google-play-service-account.json \
  --track internal                                        # 上传并发布到内部测试轨道
publish-apk google upload-aab --package-name com.example.app \
  --file ./app-release.aab --token <access_token> --track production \
  --release-status inProgress --user-fraction 0.1         # 10% 分阶段发布
publish-apk google upload-aab --package-name com.example.app \
  --file ./app-release.aab --client-email <服务账号邮箱> \
  --private-key ./service-account.pem --track production   # 分项凭据（CI 分层存 Secret）
```

### 为什么会有查看证书 / profile / keystore / HAP / APP / APK / AAB 的命令？

本项目的主流程是把手机 APP 上传到应用商店；`cert` / `profile` / `keystore` 是**签名材料的本地核对工具**，`hap` / `app` / `apk` / `aab` 是**安装包的本地核对工具**，都不是上传流程中的一步。

华为鸿蒙 APP 在打包 / 签名时需要 `.cer`、`.p12`、`.p7b` 三类文件。同一开发者账号下往往有多套证书与 Profile，文件名、别名、Bundle、有效期、设备范围都很接近，容易拿错；`cert` / `profile` 把关键字段逐行列出，**主要用于区分多个鸿蒙证书 / Profile，确认当前签名配置用的是哪一份**。`hap` / `app` / `apk` / `aab` 则用于核对构建产物本身，尤其是区分同名的 `signed.*` 与 `unsigned.*`：

| 文件 | 作用 | 查看方式 |
| --- | --- | --- |
| `.cer` | X.509 证书 / 证书链（如 `certpath.cer`） | `publish-apk cert --file ./certpath.cer` |
| `.p12` | PKCS#12 密钥库（如 `storeFile.p12`，含私钥与证书，需要密码） | `publish-apk cert --file ./storeFile.p12 --password <密码>` |
| `.p7b` | 鸿蒙 Provisioning Profile（Bundle、有效期、设备、权限、证书链） | `publish-apk profile --file ./profile.p7b` |
| `.hap` | 鸿蒙单模块安装包（包名、版本、模块、设备、API、签名状态） | `publish-apk hap --file ./app-signed.hap` |
| `.app` | 鸿蒙 App Pack（外层包信息、内层 HAP / HSP、签名状态） | `publish-apk app --file ./app-signed.app` |
| `.apk` | Android 安装包（包名、SDK、ABI、权限、签名证书） | `publish-apk apk --file ./app-arm64-v8a-release.apk` |
| `.aab` | Android App Bundle（包名、SDK、模块、ABI、签名证书） | `publish-apk aab --file ./app-release.aab` |

Android 的签名密钥库（`.jks` / `.keystore` / `.p12`）用 `keystore` 校验：它不仅看证书，还会用
`keytool` 确认 keystore 口令、别名与私钥口令是否配套，并支持把 `ANDROID_KEYSTORE_BASE64` 解码后
写到 `ANDROID_KEYSTORE_FILE`。需要从零生成一份时用 `keystore-gen`，默认生成 PKCS#12 并自动校验。
要把 CI 里的 BASE64 / 口令 / 别名写成 Gradle 读取的 `keystore.properties`（并把 BASE64 落盘成
keystore 文件）时用 `keystore-config`。详见下面的 `keystore` / `keystore-config` / `keystore-gen` 小节。

查看 `.p12` 不会输出私钥内容，`profile` 也不会输出证书 PEM 原文，`hap` / `app` / `apk` / `aab` 只读包内信息与签名块头；这些命令只读取本地文件，不会访问应用商店。

### cert（查看证书 / PKCS#12 密钥库信息）

与厂商无关的本地工具：读取 X.509 证书或 PKCS#12 密钥库，把信息**每行一条**写到 `stdout`。
文件必须用 `--file`（或环境变量 `CERT_FILE`）显式指定，**没有默认文件**。

```bash
publish-apk cert --file ./certpath.cer           # 只输出常用字段
publish-apk cert --file ./certpath.cer --verbose # 输出全部字段
CERT_FILE=./certpath.cer publish-apk cert        # 环境变量形式
CERT_PASSWORD=<密码> publish-apk cert --file ./storeFile.p12
publish-apk cert --file ./storeFile.p12 --password <密码> --verbose
CERT_VERBOSE=1 publish-apk cert --file ./a.cer   # 环境变量开启全部字段
```

- 证书默认字段：主题、颁发者、生效 / 到期时间、状态（剩余天数）、版本、序列号、签名算法、公钥算法、SHA-256 指纹、是否 CA、是否自签名。
- `--verbose` / `CERT_VERBOSE=1` 追加：主题与颁发者的每一项、GMT 时间、SHA-1 / SHA-512 指纹、公钥曲线 / 位数 / 指纹，
  以及 X.509 扩展（Key Usage、Basic Constraints、SKI / AKI、SAN、EKU、AIA、CRL 分发点、证书策略等）。
- PEM 文件可以包含多张证书（证书链），按文件里的顺序逐张输出，并以 `证书 #N:` 分隔；DER 文件按一张证书处理。
- PKCS#12（`.p12` / `.pfx`，Android 的 `storeFile`）输出密钥数量、证书数量、每个别名的密钥算法与证书链；
  `--verbose` 追加 MAC / 加密参数、`localKeyID`、密钥曲线 / 位数与全部证书字段。私钥只显示算法，不输出任何密钥材料。
- PKCS#12 密码用 `--password` 或 `CERT_PASSWORD` 传入；不传时先尝试空密码，失败再提示需要密码。
  `--password` 会进入 `ps` / shell 历史，建议用 `CERT_PASSWORD`。PKCS#12 只使用一个密码（Android 的 `storePassword`；`keyPassword` 通常与之相同）。
- PKCS#12 需要系统 `openssl` 命令（OpenSSL 1.1.1+ / LibreSSL）；项目仍然没有 npm 第三方依赖。
- 输出是「标签: 值」的纯文本，值里的换行会被压成空格，保证一条信息只占一行；证书原文（PEM/DER）与私钥内容不打印。
- `--verbose` 表示「输出全部字段」，不是运行日志；证书与密钥库信息属于结果，统一写 `stdout`。

### profile（查看 P7B Provisioning Profile）

与厂商无关的 P7B 查看工具：解析 PKCS#7 SignedData（DER / PEM），输出 profile 常用字段。
华为 AppGallery 的 `profile.p7b` 内嵌一段 JSON（bundle、类型、有效期、设备、权限）与证书链。
文件必须用 `--file`（或环境变量 `PROFILE_FILE`）显式指定，**没有默认文件**。

```bash
publish-apk profile --file ./profile.p7b           # 只输出常用字段
publish-apk profile --file ./profile.p7b --verbose # 输出全部字段
PROFILE_FILE=./profile.p7b publish-apk profile     # 环境变量形式
PROFILE_VERBOSE=1 publish-apk profile --file ./profile.p7b
```

- 默认输出：类型、版本名称 / 代码、UUID、签发者、Bundle、开发者 ID、App ID、APL、App Feature、
  生效 / 到期时间、状态（剩余天数）、设备数量、权限 / ACL / 应用特权 / 应用服务数量、签名证书数量、
  开发证书 / 发布证书摘要。
- `--verbose` / `PROFILE_VERBOSE=1` 追加：P7B 的摘要 / 签名算法与签名者、全部 JSON 字段
  （设备 UDID、权限、ACL、服务能力等逐项一行）、签名证书链与开发 / 发布证书的完整字段。
- 支持 DER 与 PEM 包裹的 PKCS#7；不输出证书 PEM 原文，P7B 里没有私钥。
- 内嵌数据不是 JSON（例如纯证书 P7B）时仍会统计签名证书，并在 `--verbose` 里输出完整证书链与原因。

### keystore（校验 Android 签名密钥库）

与厂商无关的本地工具：把 CI 里那套 Android 签名变量先校验一遍，避免等到 Gradle 的
`packageRelease` 才报 `KeytoolException`（那时既晚，又看不出是哪个变量错了）。校验用 JDK 的
`keytool`，依次确认三件事：

1. `keytool -list` 能打开密钥库 —— `ANDROID_KEYSTORE_PASSWORD` 正确；
2. 别名存在 —— `ANDROID_KEY_ALIAS` 正确（不传时自动识别第一个 `PrivateKeyEntry`）；
3. `keytool -certreq` 能用 `ANDROID_KEY_PASSWORD` 解开私钥 —— 默认与 keystore 口令相同。

输入有两种，可组合：

- `--base64` / `ANDROID_KEYSTORE_BASE64`：密钥库的 BASE64 内容。此时再给
  `--file` / `ANDROID_KEYSTORE_FILE`，校验通过后会把解码出来的**密钥库原文**写到该路径；
  不给文件路径就落到临时文件校验，结束后删除，不留下任何东西。
- `--file` / `ANDROID_KEYSTORE_FILE` / `ANDROID_KEYSTORE`：已有的密钥库文件路径。

```bash
# 已有文件：文件 + 口令 + 别名
publish-apk keystore --file ./release.p12 --store-password <口令> --key-alias release

# CI 变量原样使用：BASE64 + 口令 + 别名，并把密钥库落盘到 ANDROID_KEYSTORE_FILE
ANDROID_KEYSTORE_BASE64="$(openssl base64 -A -in release.p12)" \
ANDROID_KEYSTORE_PASSWORD=<口令> ANDROID_KEY_ALIAS=release \
ANDROID_KEYSTORE_FILE=./release.p12 \
publish-apk keystore

# 只校验 BASE64，不落盘（临时文件校验后删除）
ANDROID_KEYSTORE_BASE64=... ANDROID_KEYSTORE_PASSWORD=... publish-apk keystore
```

- `--file` 与 BASE64 同用时是**输出**路径；单独使用时是**输入**路径。
- stdout 输出：密钥库路径、大小、SHA-256 前 12 位、类型、别名、公钥、证书主题 / 颁发者 / 序列号 /
  有效期 / MD5、SHA-256 指纹，最后一行是「校验: 通过」。每行一条「标签: 值」。
- 落盘时权限固定 `0600`；已存在相同内容则复用，不同内容会先备份为 `<文件>.bak-<时间戳>` 再覆盖。
- 口令不会打印到 stdout / stderr；但 `keytool` 只接受 `-storepass` / `-keypass` 参数形式，
  校验期间会出现在本地 keytool 进程的 argv 里（与 `huawei signing-config` 的口令自检一致）。
- `--store-password` / `--key-password` 会进入 shell 历史与 `ps`，建议用
  `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_PASSWORD`；非交互环境没有给口令时直接报错。
- 校验失败（口令错、别名不存在、私钥口令错、`keytool` 不可用）以退出代码 `1` 结束，不会写输出文件。

### keystore-env（导出 Android keystore 的 CI 变量）

把一份 keystore 文件导出成 CI 可直接配置的变量。默认输出四个：

| 变量 | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的单行 BASE64；加 `--no-base64` 可去掉 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 明文口令 |
| `ANDROID_KEY_ALIAS` | 私钥别名（不传 `--key-alias` 时由 keytool 自动识别） |
| `ANDROID_KEY_PASSWORD` | 私钥明文口令（默认与 keystore 口令相同） |
| `ANDROID_KEYSTORE_FILE` | 可选；加 `--include-file` 输出 keystore 的绝对路径，给本地 `signing.env` 用 |


```bash
# 默认 env 格式：KEY="value"，一行一个，适合逐项复制到 CI 变量
ANDROID_KEYSTORE_PASSWORD=<口令> publish-apk keystore-env --file ./release.p12

# 冒号分隔：KEY: "value"
ANDROID_KEYSTORE_PASSWORD=<口令> publish-apk keystore-env --file ./release.p12 --separator :

# shell 格式：export KEY='...'，单引号安全转义，可 source / eval
ANDROID_KEYSTORE_PASSWORD=<口令> publish-apk keystore-env --file ./release.p12 --format shell

# JSON 格式
ANDROID_KEYSTORE_PASSWORD=<口令> publish-apk keystore-env --file ./release.p12 --format json > keystore.json

# 生成可直接 source 的本地签名环境（要文件路径，不要 BASE64）
ANDROID_KEYSTORE_PASSWORD=<口令> publish-apk keystore-env --file ./release.p12 \
  --format shell --include-file --no-base64 > .signing/android.env
```

- 生成变量前会用 keytool 校验 keystore 口令、别名与私钥口令，校验失败不会输出变量。
- `--key-alias` / `ANDROID_KEY_ALIAS` 不传时自动识别；`--key-password` / `ANDROID_KEY_PASSWORD`
  不传时使用 keystore 口令。
- `--include-file` 额外输出 `ANDROID_KEYSTORE_FILE`；`--no-base64` 去掉 `ANDROID_KEYSTORE_BASE64`。
  两者一起用适合生成 `.signing/android.env`，避免把整份 BASE64 再塞进本地环境。
- `env` 格式的值用双引号包起来并转义特殊字符，适合逐项复制到 CI 变量；`shell` 格式适合本地
  `source`；`json` 格式适合脚本解析。
- **警告：默认输出包含明文口令**，不要写入日志、提交仓库或公开分享；`stdout` 只有变量，
  `stderr` 只有警告与错误。
- 依赖 JDK 的 `keytool`；可用 `KEYTOOL=/path/to/keytool` 指定。

#### 一键写入 GitHub Actions 密钥（`--github`）

`--github` 把导出的变量（默认 4 个，规则同 stdout）逐个通过 GitHub REST API 写入
Actions 密钥；stdout 只列变量名，不输出任何值：

```bash
# 写入当前仓库（GITHUB_REPOSITORY 或 git remote origin 推断）
GITHUB_TOKEN=<token> publish-apk keystore-env --file ./release.p12 --github

# 指定仓库与 GitHub Environment
GITHUB_TOKEN=<token> publish-apk keystore-env --file ./release.p12 \
  --github --github-repo owner/repo --github-env production
```

- 与 `huawei signing-env --github` 共用同一套实现（[src/github.js](src/github.js)）：
  值用 libsodium sealed box 加密后上传，请求体只有 `encrypted_value` 与 `key_id`。
- `GITHUB_TOKEN` 需要仓库 Secrets 写权限：fine-grained 的 `Secrets: Read and write`，
  classic 的 `repo`。Actions 内置的 `GITHUB_TOKEN` 通常不能写 Secrets，CI 里请用有权限的 PAT。
- 省略 `--github-repo` 时先看 `GITHUB_REPOSITORY`，再按当前 git remote origin 推断；
  GHES 用 `GITHUB_API_URL=https://host/api/v3`。
- 写入的变量与 stdout 一致：默认 4 个；`--include-file` 加 `ANDROID_KEYSTORE_FILE`，
  `--no-base64` 去掉 `ANDROID_KEYSTORE_BASE64`。`--include-file` 写的是本机绝对路径，
  CI 里未必适用，一般不要与 `--github` 同用。
- 48 KB 上限按加密后的 `encrypted_value` 计算；超过时本地失败，不发起请求。
- `--github` 不能与 `--format` / `--separator` 同时使用；`--github-env` 要求环境已存在。
- 中途失败会提示已成功写入的个数；重跑会覆盖同名密钥。

### keystore-config（由变量生成 keystore.properties）

与厂商无关的本地工具：读取 `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` /
`ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`，生成 Gradle 读取的 `keystore.properties`：

```properties
storeFile=../../publish_apk_demo.keystore
keyAlias=publish_apk_demo
storePassword=xxx
keyPassword=xxx
```

给了 `ANDROID_KEYSTORE_BASE64` / `--base64` 时，先把 BASE64 解码写到 `storeFile`
（权限固定 `0600`），再写配置文件；`storeFile` 的值原样写进配置，不会改成绝对路径。

```bash
# 用 CI 变量生成：BASE64 落盘到 ../../publish_apk_demo.keystore，配置写到 app/keystore.properties
ANDROID_KEYSTORE_BASE64="$(openssl base64 -A -in publish_apk_demo.keystore)" \
ANDROID_KEYSTORE_PASSWORD=<口令> \
ANDROID_KEY_ALIAS=publish_apk_demo \
ANDROID_KEY_PASSWORD=<口令> \
publish-apk keystore-config \
  --store-file ../../publish_apk_demo.keystore --out ./app/keystore.properties

# 默认输出 ./keystore.properties；没给 storeFile 时默认 ./<别名>.keystore
ANDROID_KEYSTORE_BASE64=... ANDROID_KEYSTORE_PASSWORD=<口令> \
  ANDROID_KEY_ALIAS=publish_apk_demo publish-apk keystore-config

# 只写配置（不落盘 keystore）：直接给 storeFile
publish-apk keystore-config --store-file ./release.jks --key-alias release --store-password <口令>
```

- `--store-file` / `--file` / `ANDROID_STORE_FILE` / `ANDROID_KEYSTORE_FILE` / `ANDROID_KEYSTORE`
  指定 `storeFile`；给了 BASE64 时它也是解码后的落盘路径。
- `--out` / `--config` / `ANDROID_KEYSTORE_CONFIG` 指定配置文件路径，默认 `./keystore.properties`；
  `--out -` 把配置内容写到 `stdout`（含明文口令）。
- 配置文件权限固定 `0600`；已存在相同内容时复用，内容不同时默认拒绝，`--force` 会先备份为
  `<文件>.bak-<时间戳>` 再覆盖。
- 写出的 `storePassword` / `keyPassword` 是明文；`keyPassword` 不传时用 `storePassword`。
- 本命令**不调用 keytool**，只检查 BASE64 解码后的文件头（JKS / JCEKS / PKCS12）。
  需要校验口令 / 别名时，先运行 `keystore`。
- 值按 Java `.properties` 规则转义：反斜杠、行首空格与非 ASCII 字符会被转义，Gradle 能正确还原。

### keystore-gen（快速生成 Android 签名密钥库）

与厂商无关的本地工具：用 JDK 的 `keytool -genkeypair` 快速生成一份 Android 签名 keystore，
生成后立即用 `keystore` 同样的逻辑校验口令、别名与私钥，并输出校验报告。

```bash
# 最简：默认 ./release.p12、别名 release、PKCS12、RSA 2048、10000 天
ANDROID_KEYSTORE_PASSWORD=<口令> publish-apk keystore-gen

# 指定文件 / 别名 / 类型
ANDROID_KEYSTORE_PASSWORD=<口令> publish-apk keystore-gen \
  --file ./release.jks --key-alias myapp --store-type JKS

# 自定义 DN、算法、位数、有效期；已有文件先备份再覆盖
ANDROID_KEYSTORE_PASSWORD=<口令> publish-apk keystore-gen \
  --file ./release.p12 --key-alias release --force \
  --dname "CN=MyApp, OU=Android, O=MyOrg, L=Unknown, ST=Unknown, C=CN" \
  --key-algorithm EC --key-size 256 --validity 3650
```

- 文件名后缀不限（`.p12` / `.jks` / `.keystore` / 无后缀均可）；内容类型只看 `--store-type`，不根据后缀推断。
- 默认值：`--file ./release.p12`、`--key-alias release`、`--store-type PKCS12`、
  `--key-algorithm RSA`、`--key-size 2048`、`--validity 10000`，
  `--dname "CN=Android Release, OU=Android, O=Android, L=Unknown, ST=Unknown, C=US"`。
- 口令至少 6 位；`--store-password` / `ANDROID_KEYSTORE_PASSWORD`，非交互环境没给口令会直接报错，
  交互环境会提示输入两次。PKCS12 / JKS 的 keyPassword 都与 storePassword 相同。
- 目标文件已存在时默认拒绝；加 `--force` 会先备份为 `<文件>.bak-<时间戳>` 再覆盖。
- 生成后自动校验，`stdout` 输出与 `keystore` 相同的报告；落盘权限固定 `0600`。
- 口令不会打印；但 keytool 只接受 `-storepass` / `-keypass` 参数形式，生成期间会出现在本地
  keytool 进程的 argv 里（与 `keystore` / `huawei signing-config` 一致）。
- 依赖 JDK 的 `keytool`；可用 `KEYTOOL=/path/to/keytool` 指定。

### hap（查看 HAP 安装包信息）

HAP 是 HarmonyOS 的安装包，本质是 ZIP：`pack.info` / `module.json` 记录包名、版本、模块、设备、API，
签名包还会在 ZIP 中央目录前带 HAP 签名块。本命令用于核对
`signed.hap` 与 `unsigned.hap` 的包信息，并判断是否带签名块。
文件必须用 `--file`（或环境变量 `HAP_FILE`）显式指定，**没有默认文件**。

```bash
publish-apk hap --file ./app-signed.hap            # signed / unsigned 都适用
publish-apk hap --file ./*.hap                     # 一次查看多个 HAP，按顺序输出
publish-apk hap --file ./app-unsigned.hap --verbose
HAP_FILE=./app.hap publish-apk hap                 # 环境变量形式
HAP_VERBOSE=1 publish-apk hap --file ./app.hap
```

- `--file` 支持一次给多个文件，也支持 shell glob（如 `./*.hap`）；按参数顺序逐个输出，文件之间空一行。
- 默认输出：文件大小、ZIP 条目数、签名状态、Profile 类型（`release` / `debug`）、包名、版本 / 构建号、构建信息（`debug` / `buildMode` / `bundleType`）、
  模块、设备、主 Ability、API 兼容 / 目标版本与原始 API 值（`min` / `target` / `compileSdk`）、安装方式、权限，
  以及签名证书（HAP 签名方案与 Profile 签名各取叶子证书）。
- `--verbose` / `HAP_VERBOSE=1` 追加：应用标签、厂商、模块包名，
  HAP 签名块版本 / 大小 / 子块类型，全部 ZIP 条目、完整签名证书链，以及完整 `pack.info` / `module.json`。
- Profile 类型取自 HAP 签名块内嵌 profile JSON 的 `type`（`release` / `debug`）；unsigned 包输出 `未签名`。
- 构建信息行形如 `构建: debug=false, buildMode=release, bundleType=app`；APP 从第一个内层 HAP 读取。
- API 原始值来自 `module.json` 的 `app.minAPIVersion` / `targetAPIVersion` / `compileSdkVersion`；
  `pack.info` 的兼容 / 目标版本（10 / 26）仍会单独输出。
- 签名证书从 HAP 签名块内嵌的 PKCS#7 中提取；默认输出每组叶子证书，`--verbose` 输出完整证书链。
  证书字段与 `cert` 命令一致，但不输出证书 PEM 原文。
- 签名状态只检测 HAP 签名块（以及 Code Sign Block），**不执行证书链、摘要或 Merkle 树验签**；
  输出里会明确写「未验签」。signed / unsigned 的包内容通常相同，区别在是否带签名块。
- HAP 解析只使用 Node 内置能力（ZIP 中央目录 + `node:zlib`），不依赖 JDK、`openssl` 或 npm 第三方包。
- 不输出证书 PEM 原文；HAP 里没有私钥。

### app（查看 APP 安装包信息）

APP 是 HarmonyOS 的 App Pack，本质也是 ZIP：外层有 `pack.info`、`pac.json`，并包含一个或多个
内层 `.hap` / `.hsp`。签名包会在外层 ZIP 中央目录前带 HAP 签名块；内层 HAP 可能没有单独签名。
本命令用于核对 `signed.app` / `unsigned.app` 的外层包信息、内层模块与签名证书。
文件必须用 `--file`（或环境变量 `APP_FILE`）显式指定，**没有默认文件**。

```bash
publish-apk app --file ./app-signed.app            # signed / unsigned 都适用
publish-apk app --file ./*.app                     # 一次查看多个 APP，按顺序输出
publish-apk app --file ./app-unsigned.app --verbose
APP_FILE=./app.app publish-apk app                 # 环境变量形式
APP_VERBOSE=1 publish-apk app --file ./app.app
```

- `--file` 支持一次给多个文件，也支持 shell glob（如 `./*.app`）；按参数顺序逐个输出，文件之间空一行。
- 默认输出：文件大小、ZIP 条目数、外层签名状态、Profile 类型（`release` / `debug`）、包名、版本 / 构建号、构建信息（`debug` / `buildMode` / `bundleType`）、
  模块、设备、主 Ability、API 兼容 / 目标版本与原始 API 值（`min` / `target` / `compileSdk`）、安装方式、权限、
  内层模块列表，以及外层签名证书（HAP 签名方案与 Profile 签名各取叶子证书）。
- `--verbose` / `APP_VERBOSE=1` 追加：应用标签、厂商、模块包名，
  外层签名块版本 / 大小 / 子块类型，全部 ZIP 条目、完整签名证书链，以及完整 `pack.info` / `pac.json`。
- Profile 类型取自 APP 外层签名块内嵌 profile JSON 的 `type`（`release` / `debug`）；unsigned 包输出 `未签名`。
- 构建信息行形如 `构建: debug=false, buildMode=release, bundleType=app`。
- API 原始值来自内层 HAP `module.json` 的 `app.minAPIVersion` / `targetAPIVersion` / `compileSdkVersion`；
  外层 `pack.info` 的兼容 / 目标版本仍会单独输出。
- 签名证书从外层 HAP 签名块内嵌的 PKCS#7 中提取；默认输出每组叶子证书，`--verbose` 输出完整证书链。
  证书字段与 `cert` 命令一致，但不输出证书 PEM 原文。
- 外层签名只做检测，**不执行证书链、摘要或 Merkle 树验签**；输出里会明确写「未验签」。
- APP 解析只使用 Node 内置能力（ZIP 中央目录 + `node:zlib`），不依赖 JDK、`openssl` 或 npm 第三方包。

### apk（查看 APK 安装包信息）

APK 是 Android 安装包，本质也是 ZIP：`AndroidManifest.xml` 是 Android 二进制 XML，
签名可能是 JAR v1（`META-INF/*.RSA` 等）或 APK Signature Scheme v2 / v3 / v3.1。
本命令直接解析二进制 Manifest 与 APK Signing Block，不依赖 `aapt` / `apkanalyzer`。
文件必须用 `--file`（或环境变量 `APK_FILE`）显式指定，**没有默认文件**。

```bash
publish-apk apk --file ./app-arm64-v8a-release.apk
publish-apk apk --file ./*.apk                     # 一次查看多个 APK，按顺序输出
publish-apk apk --file ./app-armeabi-v7a-release.apk --verbose
APK_FILE=./app.apk publish-apk apk
APK_VERBOSE=1 publish-apk apk --file ./app.apk
```

- `--file` 支持一次给多个文件，也支持 shell glob（如 `./*.apk`）；按参数顺序逐个输出，文件之间空一行。
- 默认输出：文件大小、ZIP 条目数、签名状态与签名方案、包名、版本 / versionCode、
  Min / Target / 编译 SDK、ABI、DEX 数量、权限、启动 Activity，以及签名证书（叶子证书）。
- `--verbose` / `APK_VERBOSE=1` 追加：应用标签、允许备份、uses-feature、全部 Activity，
  APK Signing Block 的 pair（v2 / v3 / v3.1 / Source Stamp / Verity Padding）、
  全部 ZIP 条目与完整签名证书链。
- 签名只做检测，**不执行证书链、摘要或签名验签**；输出里会明确写「未验签」。
- 应用标签是资源引用（如 `@0x7f090001`）时不会解析 `resources.arsc`，`--verbose` 会原样输出。
- APK 解析只使用 Node 内置能力（ZIP 中央目录 + `node:zlib`），不依赖 JDK、`openssl` 或 npm 第三方包。
- 不输出证书 PEM 原文；APK 里没有私钥。

### aab（查看 AAB 安装包信息）

AAB 是 Android App Bundle，本质也是 ZIP：Manifest 在 `base/manifest/AndroidManifest.xml`，
并使用 **protobuf XML** 编码；签名通常是 JAR v1（`META-INF/*.RSA` 等），不是 APK v2 签名块。
本命令直接解析 protobuf XML 与 JAR v1 签名，不依赖 `bundletool` / `aapt` / `apkanalyzer`。
文件必须用 `--file`（或环境变量 `AAB_FILE`）显式指定，**没有默认文件**。

```bash
publish-apk aab --file ./app-release.aab
publish-apk aab --file ./*.aab                     # 一次查看多个 AAB，按顺序输出
publish-apk aab --file ./app-release.aab --verbose
AAB_FILE=./app.aab publish-apk aab
AAB_VERBOSE=1 publish-apk aab --file ./app.aab
```

- `--file` 支持一次给多个文件，也支持 shell glob（如 `./*.aab`）；按参数顺序逐个输出，文件之间空一行。
- 默认输出：文件大小、ZIP 条目数、JAR v1 签名状态、包名、版本 / versionCode、
  Min / Target / 编译 SDK、模块列表、ABI、DEX 数量、权限、启动 Activity，以及签名证书（叶子证书）。
- `--verbose` / `AAB_VERBOSE=1` 追加：应用标签、允许备份、uses-feature、全部 Activity、
  `BundleConfig.pb` 大小、全部 ZIP 条目与完整签名证书链。
- 签名只做检测，**不执行证书链、摘要或签名验签**；输出里会明确写「未验签」。
- 应用标签是资源引用（如 `@string/app_name`）时不会解析 AAB 资源，`--verbose` 会原样输出。
- AAB 解析只使用 Node 内置能力（ZIP 中央目录 + `node:zlib` + 自带 protobuf 解析），
  不依赖 JDK、`openssl`、`bundletool` 或 npm 第三方包。
- 不输出证书 PEM 原文；AAB 里没有私钥。

### huawei 子命令

华为的《获取服务端授权》（服务器鉴权）文档里写着**两套鉴权方式**，本项目两套都实现了：

- **Service Account 方式**：用私钥在本地签发 PS256 JWT，直接作为 `Authorization: Bearer` 使用 → `service-account` / `service-account-upload-url` / `service-account-upload-file` / `service-account-upload-file-package-info-update`
- **API 客户端方式**：用 `client_id` + `client_secret` 调接口换取 `access_token`，业务接口除 Bearer 外还要带 `client_id` 头 → `client-credentials` / `client-credentials-upload-url` / `client-credentials-upload-file` / `client-credentials-upload-file-package-info-update`
- **鸿蒙签名配置**：用 `.cer` / `.p7b` / `.p12` 与明文口令生成 `build-profile.json5` 的 `material`（含 material 目录与两串密文口令）→ `signing-config`

| 命令 | 说明 | stdout |
| --- | --- | --- |
| `huawei service-account` | 用 Service Account 私钥签发 PS256 JWT | JWT |
| `huawei service-account-upload-url` | 确定 Token（本地签发优先，其次 `--token`）后获取文件上传地址 | 接口原始响应 JSON |
| `huawei service-account-upload-file` | 确定 Token 后取上传地址，并把本地文件上传上去 | 文件对象 ID（`objectId`） |
| `huawei service-account-upload-file-package-info-update` | 确定 Token 后**上传文件并登记软件包**（未给 `--object-id` 时自己上传） | 文件对象 ID（`objectId`） |
| `huawei client-credentials` | 用 API 客户端凭证换取 `access_token` | `access_token` |
| `huawei client-credentials-upload-url` | 确定 `access_token`（本地换取优先，其次 `--token`）后获取文件上传地址，并同时携带 `client_id` 头 | 接口原始响应 JSON |
| `huawei client-credentials-upload-file` | 同上确定 `access_token` 后取上传地址并上传本地文件 | 文件对象 ID（`objectId`） |
| `huawei client-credentials-upload-file-package-info-update` | 同上确定 `access_token` 后**上传文件并登记软件包**（未给 `--object-id` 时自己上传） | 文件对象 ID（`objectId`） |
| `huawei signing-config` | 用 `.cer` / `.p7b` / `.p12` 与明文口令生成鸿蒙签名配置（material + 密文口令） | `signingConfig` JSON |
| `huawei signing-passwords` | 只补充已有 `build-profile.json5` 的 `keyPassword` / `storePassword` | 补充结果 |
| `huawei signing-material` | 用 `--set 字段=值` 替换 material 字段 | 替换结果 |
| `huawei signing-material-env` | 用 `HARMONY_*` 环境变量先校验再替换 material | 替换结果 |
| `huawei signing-env` | 按产品导出鸿蒙签名 CI 变量（BASE64 / 口令），可一键写入 GitHub Actions 密钥 | 七个 `HARMONY_*` 变量；`--github` 时只列变量名 |

#### 上传与鉴权类命令的共用选项

两套鉴权各有 4 个命令，选项一一对应：`service-account*` 用 `--kid` / `--iss` / 私钥，`client-credentials*` 用
`--client-id` / `--client-secret`；其余同名选项含义完全相同。下表只列这两族共用的业务选项，每个子命令另有
一段「必填 / 凭据 / stdout / 示例」。

| 选项 | 环境变量 | 适用命令 | 说明 |
| --- | --- | --- | --- |
| `--app-id <应用ID>` | `HUAWEI_APP_ID` | `*-upload-*` | AppGallery Connect 的 `appId`（非负整数），**必填** |
| `--file <路径>` | `HUAWEI_FILE` | `*-upload-*` | `*-upload-url` 用它补 `--file-name` / `--content-length`；`*-upload-file*` 要求它指向待上传的普通文件 |
| `--file-name <文件名>` | `HUAWEI_FILE_NAME` | `*-upload-*` | 上传后的对象名（含后缀）；不给时取 `--file` 的 basename，后缀决定走哪套登记接口 |
| `--content-length <字节>` | `HUAWEI_CONTENT_LENGTH` | 仅 `*-upload-url` | 文件大小；不给时取 `--file` 的字节数；`*-upload-file*` 不接受该选项 |
| `--object-id <对象ID>` | `HUAWEI_OBJECT_ID` | 仅 `*-upload-file-package-info-update` | 已上传文件的 `objectId`；给了就跳过取址与上传，只做登记 |
| `--release-type <取值>` | `HUAWEI_RELEASE_TYPE` | 仅 `*-upload-file-package-info-update` | 发布方式，默认 `1`：`.app` 取 `1` 全网 / `7` 企业非公开，`.apk` 等取 `1` 全网 / `3` 分阶段 |
| `--release-phase <取值>` | `HUAWEI_RELEASE_PHASE` | 仅 `*-upload-file-package-info-update` | `0` 全网 / `3` 分阶段，默认 `0`；只有 `.app`（v3 接口）接受 |
| `--token <Token>` | `HUAWEI_TOKEN` | `*-upload-*` | 已签发的 JWT 或 `access_token`；本地签发 / 换取未触发时才用它（取舍顺序见各系列的「凭据」行） |
| `--verbose` | `HUAWEI_VERBOSE` | 全部 | 运行日志写 `stderr`；Token / `client_id` / 私钥路径只显示掩码 |
| `-h` / `--help` | — | 全部 | 该子命令的帮助（写 `stdout`） |

`HUAWEI_API_BASE` 只走环境变量，用于覆盖接口域名（默认 `https://connect-api.cloud.huawei.com`）。

### huawei service-account 系列（签发 JWT 与上传）

这四个命令是同一条流水线的四个档位：只签 Token → 只取上传地址 → 上传到对象存储 → 上传并登记软件包。

凭据选项（4 个命令通用，`--iat` 只作用于本地签发的 JWT）：

| 选项 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `--kid <密钥ID>` | 需要本地签发时必填 | `HUAWEI_KID` | JWT 请求头 `kid` |
| `--iss <签发者>` | 需要本地签发时必填 | `HUAWEI_ISS` | JWT 载荷 `iss` |
| `--private-key <文件>` | 与下一项二选一 | `HUAWEI_PRIVATE_KEY` | 私钥 PEM 文件路径 |
| `--private-key-data <PEM>` | 与上一项二选一 | `HUAWEI_PRIVATE_KEY_DATA` | 私钥 PEM 文本；环境变量层两者都在时**数据优先**并在 `stderr` 提示 |
| `--iat <秒>` | 否 | `HUAWEI_IAT` | JWT 签发时间（UTC 秒级时间戳）；默认当前时间，`exp` 恒为 `iat + 3600` |

#### huawei service-account

| 项 | 说明 |
| --- | --- |
| 必填 | `--kid`、`--iss` 与私钥（`--private-key` 或 `--private-key-data`） |
| 作用 | 只在本地签发 PS256 JWT，不访问任何接口 |
| stdout | JWT 字符串，可直接作为 `Authorization: Bearer` 使用 |
| 可选 | `--iat`、`--verbose` |

```bash
publish-apk huawei service-account --kid <密钥ID> --iss <签发者> --private-key ./private.pem

HUAWEI_KID=<密钥ID> HUAWEI_ISS=<签发者> \
  HUAWEI_PRIVATE_KEY_DATA="$(cat private.pem)" publish-apk huawei service-account
```

#### huawei service-account-upload-url

| 项 | 说明 |
| --- | --- |
| 必填 | `--app-id`；`--file`（或把 `--file-name` 与 `--content-length` 都显式给出） |
| 凭据 | 按序取：命令行 Service Account 凭据（本地签发）→ `--token` → `HUAWEI_*` 环境变量凭据 |
| stdout | 取址接口的原始响应 JSON（`urlInfo.url` / `method` / `headers` / `objectId`） |
| 说明 | 只取地址、不上传；上传要按 `urlInfo.method` 与 `urlInfo.headers` 自己发（见「上传一个安装包分三步」） |

```bash
RESP=$(publish-apk huawei service-account-upload-url \
  --app-id <应用ID> --file ./a1.apk \
  --kid <密钥ID> --iss <签发者> --private-key ./private.pem)
```

#### huawei service-account-upload-file

| 项 | 说明 |
| --- | --- |
| 必填 | `--app-id`、`--file`（待上传的普通文件；文件名与大小都取自它） |
| 凭据 | 命令行 Service Account 凭据（本地签发）→ `--token` → `HUAWEI_*` 环境变量凭据 |
| stdout | `objectId` |
| 不接受 | `--content-length`（大小恒取本地实际字节数，否则 OBS 签名校验失败） |
| 说明 | 只上传到对象存储，后台「软件包管理」看不到；要登记请用下一个命令 |

```bash
OBJECT_ID=$(publish-apk huawei service-account-upload-file \
  --app-id <应用ID> --file ./a1.apk \
  --kid <密钥ID> --iss <签发者> --private-key ./private.pem)
```

#### huawei service-account-upload-file-package-info-update

| 项 | 说明 |
| --- | --- |
| 必填 | `--app-id`；未给 `--object-id` 时还要 `--file`；`--file-name`（不给时取 `--file` 的 basename） |
| 凭据 | 命令行 Service Account 凭据（本地签发）→ `--token` → `HUAWEI_*` 环境变量凭据；登记接口也带同一个 Token |
| stdout | `objectId`（复用 `--object-id` 时原样回显） |
| 软件包标识 | 登记返回的 `.app` → `packageId`、`.apk` 等 → `pkgVersion`，只在 `--verbose` 日志里 |
| 后缀 | `.app` 走 `PUT /api/publish/v3/app-package-info`（`--release-type` 取 `1` / `7`，并支持 `--release-phase`）；`.apk` / `.aab` / `.rpk` / `.hap` 走 `PUT /api/publish/v2/app-file-info`（`--release-type` 取 `1` / `3`）；认不出的后缀在本地报错 |

```bash
# 三步都走：取址 → 上传 → 登记
publish-apk huawei service-account-upload-file-package-info-update \
  --app-id <应用ID> --file ./a1.apk --release-type 1 \
  --kid <密钥ID> --iss <签发者> --private-key ./private.pem

# 文件已在别处上传：只登记
publish-apk huawei service-account-upload-file-package-info-update \
  --app-id <应用ID> --file-name a1.apk --object-id "$OBJECT_ID" --token <Token>
```

### huawei client-credentials 系列（换取 access_token 与上传）

与 Service Account 系列一一对应：多一步用 `client_id` + `client_secret` 换 `access_token`，业务接口除
`Authorization: Bearer` 外还要带 `client_id` 头。

凭据选项（4 个命令通用）：

| 选项 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `--client-id <客户端ID>` | 需要本地换取时必填 | `HUAWEI_CLIENT_ID` | API 客户端 ID；业务接口也用它作 `client_id` 头 |
| `--client-secret <密钥>` | 需要本地换取时必填 | `HUAWEI_CLIENT_SECRET` | API 客户端密钥；只用来换 `access_token`，不发往业务接口 |

#### huawei client-credentials

| 项 | 说明 |
| --- | --- |
| 必填 | `--client-id`、`--client-secret` |
| stdout | `access_token`（`token_type` / `expires_in` 见 `--verbose` 日志） |
| 请求 | `POST /api/oauth2/v1/token`，JSON 体 `grant_type=client_credentials` + `client_id` + `client_secret` |

```bash
publish-apk huawei client-credentials --client-id <客户端ID> --client-secret <客户端密钥>
HUAWEI_CLIENT_ID=<客户端ID> HUAWEI_CLIENT_SECRET=<客户端密钥> publish-apk huawei client-credentials
```

#### huawei client-credentials-upload-url

| 项 | 说明 |
| --- | --- |
| 必填 | `--app-id`；`--file`（或把 `--file-name` 与 `--content-length` 都显式给出） |
| 凭据 | 按序取：命令行 `--client-id` + `--client-secret`（本地换取）→ `--token` → `HUAWEI_*` 环境变量凭据 |
| stdout | 取址接口的原始响应 JSON |
| 说明 | 用 `--token` 时，只要给得出 `--client-id`（或 `HUAWEI_CLIENT_ID`），仍会带上 `client_id` 头 |

```bash
RESP=$(publish-apk huawei client-credentials-upload-url \
  --app-id <应用ID> --file ./a1.apk \
  --client-id <客户端ID> --client-secret <客户端密钥>)
```

#### huawei client-credentials-upload-file

| 项 | 说明 |
| --- | --- |
| 必填 | `--app-id`、`--file` |
| 凭据 | 命令行 `--client-id` + `--client-secret`（本地换取）→ `--token` → `HUAWEI_*` 环境变量凭据 |
| stdout | `objectId` |
| 不接受 | `--content-length`（大小恒取本地实际字节数） |

```bash
OBJECT_ID=$(publish-apk huawei client-credentials-upload-file \
  --app-id <应用ID> --file ./a1.apk \
  --client-id <客户端ID> --client-secret <客户端密钥>)
```

#### huawei client-credentials-upload-file-package-info-update

| 项 | 说明 |
| --- | --- |
| 必填 | `--app-id`；未给 `--object-id` 时还要 `--file`；`--file-name`（不给时取 `--file` 的 basename） |
| 凭据 | 命令行 `--client-id` + `--client-secret`（本地换取）→ `--token` → `HUAWEI_*` 环境变量凭据；登记接口也带 `client_id` 头 |
| stdout | `objectId`（软件包标识见 `--verbose` 日志） |
| 后缀 | 与 Service Account 那套完全一致：`.app` 走 v3、`.apk` 等走 v2，按 `--file-name` 后缀自动选 |

```bash
publish-apk huawei client-credentials-upload-file-package-info-update \
  --app-id <应用ID> --file ./a1.app --release-type 7 --release-phase 3 \
  --client-id <客户端ID> --client-secret <客户端密钥>

# 文件已在别处上传：只登记
publish-apk huawei client-credentials-upload-file-package-info-update \
  --app-id <应用ID> --file-name a1.apk --object-id "$OBJECT_ID" \
  --token <access_token> --client-id <客户端ID>
```

### 生成鸿蒙签名配置（`huawei signing-config`）

鸿蒙 `build-profile.json5` 的 `app.signingConfigs[].material` 里，`storePassword` / `keyPassword`
不是明文，而是用 `.p12` 同级目录下 `material/` 里的 workKey 加密过的十六进制串。
本命令把「选文件 + 输明文口令 + 生成 material + 加密口令」合成一步。

| 选项 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `--store-file <文件/BASE64>` | 是 | `HARMONY_STORE_FILE` / `HARMONY_STORE_FILE_BASE64` | `.p12` 路径，或直接给 BASE64 |
| `--store-file-out <文件>` | 否 | `HARMONY_STORE_FILE_OUT` | `.p12` 内容 / 复制目标；默认当前目录的 `storeFile.p12` |
| `--certpath <文件/PEM/BASE64>` | 是 | `HARMONY_CERTPATH`（别名 `HARMONY_CERT` / `HARMONY_CERTPATH_BASE64` / `HARMONY_CERT_BASE64`） | `.cer` 路径、PEM 内容或 BASE64（DER / PEM） |
| `--certpath-out <文件>` | 否 | `HARMONY_CERTPATH_OUT` | 证书内容 / 复制目标；默认 `.p12` 同级的 `certpath.cer` |
| `--profile <文件/BASE64>` | 是 | `HARMONY_PROFILE` / `HARMONY_PROFILE_BASE64` | `.p7b` 路径，或直接给 BASE64 |
| `--profile-out <文件>` | 否 | `HARMONY_PROFILE_OUT` | profile 内容 / 复制目标；默认 `.p12` 同级的 `profile.p7b` |
| `--key-alias <别名>` | 否 | `HARMONY_KEY_ALIAS` | `.p12` 里的密钥别名；不传时用 keytool 读取 |
| `--sign-alg <算法>` | 否 | `HARMONY_SIGN_ALG` | 签名算法，默认 `SHA256withECDSA` |
| `--store-password <明文>` | 否 | `HARMONY_STORE_PASSWORD` | `.p12` 明文口令；不给时交互输入，给了会进 `ps` / shell 历史 |
| `--key-password <明文>` | 否 | `HARMONY_KEY_PASSWORD` | 密钥明文口令；默认与 `--store-password` 相同 |
| `--store-password-file <文件>` | 否 | — | 从文件第一行读 `.p12` 口令，`-` 表示 stdin |
| `--key-password-file <文件>` | 否 | — | 从文件第一行读密钥口令，`-` 表示 stdin |
| `--config <文件>` | 否 | `HARMONY_CONFIG` | `build-profile.json5` 路径，默认 `./build-profile.json5`；`--write` / `--product` 时需要 |
| `--name <名字>` | 否 | `HARMONY_SIGNING_NAME` | 要更新 / 输出的 `signingConfig`，默认 `default` |
| `--product <产品>` | 否 | `HARMONY_PRODUCT` | 按 `products[].name` 找它挂的 `signingConfig` |
| `--write` | 否 | — | 写回 `build-profile.json5`（只更新同名 `signingConfig`，改前备份） |
| `--new-material` | 否 | — | material 已存在也重造一套（旧的挪成 `material.bak-<时间戳>`） |
| `--no-keytool` | 否 | — | 跳过 keytool 别名发现与口令自检 |
| `--verbose` | 否 | `HARMONY_VERBOSE` | 输出 `.p12` / `.cer` / `.p7b` 的全部字段（`stderr`） |

```bash
HARMONY_STORE_PASSWORD=<p12口令> publish-apk huawei signing-config \
  --store-file ./storeFile.p12 \
  --certpath ./certpath.cer \
  --profile ./profile.p7b \
  --key-alias dev \
  --config ./build-profile.json5 \
  --name default \
  --write

# 同时查看 .p12 / .cer / .p7b 的材料信息（stderr）
HARMONY_STORE_PASSWORD=<p12口令> publish-apk huawei signing-config \
  --store-file ./storeFile.p12 --certpath ./certpath.cer --profile ./profile.p7b \
  --key-alias dev --verbose
```

证书也可以不落成 `.cer` 文件，直接把内容或 BASE64 放进环境变量：

```bash
# PEM 内容
HARMONY_STORE_PASSWORD=<p12口令> HARMONY_CERTPATH="$(cat certpath.cer)" \
  publish-apk huawei signing-config --store-file ./storeFile.p12 \
  --profile ./profile.p7b --certpath-out ./certpath.cer

# BASE64（DER 证书）
HARMONY_STORE_PASSWORD=<p12口令> \
HARMONY_CERTPATH_BASE64="$(openssl x509 -in certpath.cer -outform DER | openssl base64 -A)" \
  publish-apk huawei signing-config --store-file ./storeFile.p12 \
  --profile ./profile.p7b --certpath-out ./certpath.cer

# .p12 也可以来自 BASE64
HARMONY_STORE_PASSWORD=<p12口令> \
HARMONY_STORE_FILE_BASE64="$(openssl base64 -A -in storeFile.p12)" \
  publish-apk huawei signing-config --store-file-out ./storeFile.p12 \
  --certpath ./certpath.cer --profile ./profile.p7b

# .p7b 也可以来自 BASE64
HARMONY_STORE_PASSWORD=<p12口令> \
HARMONY_PROFILE_BASE64="$(openssl base64 -A -in profile.p7b)" \
  publish-apk huawei signing-config --store-file ./storeFile.p12 \
  --certpath ./certpath.cer --profile-out ./profile.p7b
```

- `.p12` / `.cer` / `.p7b` 都必填；`material/` 固定生成在 `.p12` 同级目录（hvigor 的 DecipherUtil 从这里取 workKey），已有可用 material 会复用。
- `--store-file` / `HARMONY_STORE_FILE` / `HARMONY_STORE_FILE_BASE64` 除了 `.p12` 路径，也接受 **BASE64**；内容会写到 `--store-file-out`，未给时写到当前目录的 `storeFile.p12`；已有不同文件会先备份再覆盖。
- `--certpath` / `HARMONY_CERTPATH` 除了 `.cer` 路径，也接受 **PEM 内容**或 **BASE64**（DER 或 PEM）；内容会写到 `--certpath-out`，未给时写到 `.p12` 同级的 `certpath.cer`；已有不同证书会先备份再覆盖。
- `--profile` / `HARMONY_PROFILE` / `HARMONY_PROFILE_BASE64` 除了 `.p7b` 路径，也接受 **BASE64**；内容会写到 `--profile-out`，未给时写到 `.p12` 同级的 `profile.p7b`；已有不同 profile 会先备份再覆盖。
- 默认在 `stderr` 输出 `.p12` / `.cer` / `.p7b` 的材料信息（复用 `cert` / `profile` 的字段）；`--verbose` / `HARMONY_VERBOSE=1` 输出全部字段。
- `--key-alias` 不传时用 `keytool` 从 `.p12` 读取；keytool 还会用 `-certreq` 自检两个明文口令能否打开私钥。
- 不给 `--write` 时只把 `signingConfig` JSON 写到 `stdout`，方便手工粘贴；`--write` 只更新同名 `signingConfig` 的 `material`，改前备份到 `build-profile.json5` 所在目录的 `.signing/backup/`。
- 明文口令优先用 `HARMONY_STORE_PASSWORD` / `HARMONY_KEY_PASSWORD`，也可以交互输入；`--store-password` / `--key-password` 会进入 shell 历史，不推荐。
- material 是解开两串密文的唯一钥匙，不能删除、不能入库；`--new-material` 可重造一套（旧的自动备份）。

### 只补充 build-profile.json5 的口令（`huawei signing-passwords`）

已有 `build-profile.json5` 里 `material.storeFile` / `keyAlias` / `certpath` / `profile` 都齐了，
只缺 `keyPassword` / `storePassword`（例如刚 clone 下来、口令字段为空）时，用这个命令。

| 选项 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `--config <文件>` | 否 | `HARMONY_CONFIG` | `build-profile.json5` 路径，默认 `./build-profile.json5` |
| `--name <名字>` | 否 | `HARMONY_SIGNING_NAME` | 要补充的 `signingConfig`，默认 `default` |
| `--product <产品>` | 否 | `HARMONY_PRODUCT` | 按 `products[].name` 找它挂的 `signingConfig` |
| `--store-password <明文>` | 否 | `HARMONY_STORE_PASSWORD` | `.p12` 明文口令；不推荐走命令行 |
| `--key-password <明文>` | 否 | `HARMONY_KEY_PASSWORD` | 密钥明文口令；默认与 `--store-password` 相同 |
| `--store-password-file <文件>` | 否 | — | 从文件第一行读 `.p12` 口令，`-` 表示 stdin |
| `--key-password-file <文件>` | 否 | — | 从文件第一行读密钥口令，`-` 表示 stdin |
| `--new-material` | 否 | — | material 已存在也重造一套（旧的挪成 `material.bak-<时间戳>`） |
| `--no-keytool` | 否 | — | 跳过 keytool 别名发现与口令自检 |

口令必填，四选一：环境变量、命令行选项、口令文件、交互输入（非交互环境都没有时直接报错）。

```bash
HARMONY_STORE_PASSWORD=<p12口令> publish-apk huawei signing-passwords \
  --config ./build-profile.json5 --name default
```

- 只改目标 `signingConfig` 的 `keyPassword` / `storePassword`，其它 `material` 字段与注释保持不变。
- `--store-file` 不需要：密钥库取 `material.storeFile`，别名取 `material.keyAlias`。
- `--config` 默认 `./build-profile.json5`；`--name` 默认 `default`；也可用 `--product` 按产品找配置。
- 口令用 `HARMONY_STORE_PASSWORD` / `HARMONY_KEY_PASSWORD`（或 `--store-password` /
  `--key-password` / 口令文件 / 交互输入）；`keyPassword` 未给时默认等于 `storePassword`。
- 明文口令会用 `.p12` 同级 `material/` 的 workKey 加密后写入；material 不存在时自动生成，已有可用
  material 复用，`--new-material` 可重造。
- 写回前备份到 `build-profile.json5` 同级的 `.signing/backup/`；回读校验两个字段。
- 默认用 `keytool` 校验口令 / 别名；没有 JDK 或不想自检时加 `--no-keytool`。

### 手工替换 material 字段（`huawei signing-material`）

只想改签名配置里的路径 / 别名（不重新生成 material、不动口令）时用这个命令；口令请用
`huawei signing-passwords`。

| 选项 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `--config <文件>` | 否 | `HARMONY_CONFIG` | `build-profile.json5` 路径，默认 `./build-profile.json5` |
| `--name <名字>` | 否 | `HARMONY_SIGNING_NAME` | 要修改的 `signingConfig`，默认 `default` |
| `--product <产品>` | 否 | `HARMONY_PRODUCT` | 按 `products[].name` 找它挂的 `signingConfig` |
| `--set <字段=值>` | 是（可重复） | — | 要替换的 `material` 字段，可改 `storeFile` / `certpath` / `profile` / `keyAlias` / `signAlg` |

```bash
publish-apk huawei signing-material --config ./build-profile.json5 --name default \
  --set storeFile=./storeFile.p12 --set keyAlias=release
```

- `stdout` 输出替换结果（配置 / `signingConfig` / 替换的字段 / 备份），`stderr` 只有进度与警告。
- 只改指定字段，其它字段、顺序与注释保持不变；写回前备份到 `.signing/backup/`，写后回读校验。
- `keyPassword` / `storePassword` 不接受 `--set`：它们是密文，必须用 `huawei signing-passwords` 或
  `huawei signing-material-env` 加密后写入。

### 用环境变量替换 material（`huawei signing-material-env`）

CI 里通常把签名材料放在环境变量中；这个命令先校验，再把通过校验的内容替换到
`build-profile.json5` 的 `material`。

| 选项 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `--config <文件>` | 否 | `HARMONY_CONFIG` | `build-profile.json5` 路径，默认 `./build-profile.json5` |
| `--name <名字>` | 否 | `HARMONY_SIGNING_NAME` | 要修改的 `signingConfig`，默认 `default` |
| `--product <产品>` | 否 | `HARMONY_PRODUCT` | 按 `products[].name` 找它挂的 `signingConfig` |
| `--no-keytool` | 否 | — | 跳过 keytool 口令自检（仍会校验证书 / Profile / p12 内容） |
| `--new-material` | 否 | — | material 已存在也重造一套（旧的挪成 `material.bak-<时间戳>`） |
| `--require-all` | 否 | — | 要求 store / cert / profile / 口令齐全，缺一项直接失败（CI 用） |

签名材料本身来自下列 `HARMONY_*` 环境变量，命令行没有对应选项：

```bash
HARMONY_STORE_FILE_BASE64=... \
HARMONY_CERTPATH_BASE64=... \
HARMONY_PROFILE_BASE64=... \
HARMONY_STORE_PASSWORD=<p12口令> \
publish-apk huawei signing-material-env \
  --config ./build-profile.json5 --name default --require-all
```

- 支持的 `HARMONY_*` 变量：
  - `HARMONY_STORE_FILE` / `HARMONY_STORE_FILE_BASE64` → `material.storeFile`
  - `HARMONY_CERTPATH` / `HARMONY_CERT` / `HARMONY_CERTPATH_BASE64` / `HARMONY_CERT_BASE64` → `material.certpath`
  - `HARMONY_PROFILE` / `HARMONY_PROFILE_BASE64` → `material.profile`
  - `HARMONY_KEY_ALIAS` → `material.keyAlias`
  - `HARMONY_SIGN_ALG` → `material.signAlg`
  - `HARMONY_STORE_PASSWORD` / `HARMONY_KEY_PASSWORD` → 加密后更新两串口令
  - `HARMONY_*_OUT` 控制 BASE64 / 内容落盘位置
- 先校验证书 / Profile / p12 内容；有口令时还会用 `keytool` 自检；全部通过后才写回。
- 没有提供的变量保持原值；只替换提供的字段。
- `--require-all` 要求 store / cert / profile / 口令齐全，缺一项直接失败；CI 用这个开关保证
  不会拿半套材料继续打包。
- 口令通过 `.p12` 同级 `material/` 加密；material 不存在时自动生成，`--new-material` 可重造。
- 写回前备份到 `.signing/backup/`，写后回读校验。
- 只给 `HARMONY_KEY_PASSWORD` 时还需要 `HARMONY_STORE_PASSWORD` 才能校验 / 加密。
- 如果只想手工替换路径 / 别名，用 `huawei signing-material --set 字段=值`；只补口令用
  `huawei signing-passwords`。

### 按产品导出鸿蒙签名 CI 变量（`huawei signing-env`）

从 `build-profile.json5` 的 `products[].name` 找到对应 `signingConfig`，读取 material、p12、
证书、Profile 与密文口令，导出 CI 需要的七个变量。

| 选项 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `--config <文件>` | 否 | `HARMONY_CONFIG` | `build-profile.json5` 路径，默认 `./build-profile.json5` |
| `--product <产品>` | 否 | `HARMONY_PRODUCT` | 按产品名找它挂的 `signingConfig` |
| `--name <名字>` | 否 | `HARMONY_SIGNING_NAME` | 不按产品时直接指定 `signingConfig`，默认 `default` |
| `--format <env/shell/json>` | 否 | — | 输出格式，默认 `env`；`shell` 用单引号安全转义，`json` 便于脚本解析；不能与 `--github` 同用 |
| `--separator <字符>` | 否 | — | `env` 格式的分隔符，默认 `=`；只支持 `=` 与 `:`，且不能用于其它格式；不能与 `--github` 同用 |
| `--github` | 否 | — | 经 GitHub REST API 把七个变量写入 Actions 密钥（用 `GITHUB_TOKEN`）；stdout 只列变量名 |
| `--github-repo <owner/repo>` | 否 | — | 目标仓库；默认取 `GITHUB_REPOSITORY` 或当前 git remote；给出即启用 `--github` |
| `--github-env <环境>` | 否 | — | 写入 GitHub Environment 密钥（环境需已存在）；给出即启用 `--github` |

```bash
publish-apk huawei signing-env --config ./build-profile.json5 --product prod

# 冒号分隔：HARMONY_*: "..."
publish-apk huawei signing-env --config ./build-profile.json5 --product prod --separator :

# 一键写入当前仓库的 GitHub Actions 密钥（需 GITHUB_TOKEN）
publish-apk huawei signing-env --config ./build-profile.json5 --product prod --github

# 指定仓库与 GitHub Environment
publish-apk huawei signing-env --config ./build-profile.json5 --product prod \
  --github --github-repo owner/repo --github-env production
```

默认输出：

```text
HARMONY_STORE_FILE_BASE64="..."
HARMONY_PROFILE_BASE64="..."
HARMONY_CERTPATH_BASE64="..."
HARMONY_STORE_PASSWORD="<明文>"
HARMONY_KEY_PASSWORD="<明文>"
HARMONY_KEY_ALIAS="release"
HARMONY_SIGN_ALG="SHA256withECDSA"
```

- `--product` 按产品名找它挂的 `signingConfig`；也可用 `--name` 直接指定签名配置。
- 只读：不会改 `build-profile.json5`、material 或 p12。
- 要求 `material` 与 `material.storeFile` 指向的 `.p12` 同级，且口令能用 material 解密。
- p12 / 证书 / Profile 路径相对 `build-profile.json5` 解析；文件必须存在。
- `--format env|shell|json`，默认 `env`；`shell` 用单引号安全转义，`json` 便于脚本解析。
- **警告：默认 stdout 包含明文口令**，不要写入日志、提交仓库或公开分享；用 `--github`
  可以完全不在终端显示值。

#### 一键写入 GitHub Actions 密钥（`--github`）

`--github` 不把值打印到终端，而是逐个通过 GitHub REST API 写入 Actions 密钥，
stdout 只有目标和变量名：

```text
GitHub 仓库: owner/repo
密钥范围: Environment（production）
已写入 7 个密钥:
- HARMONY_STORE_FILE_BASE64
- HARMONY_PROFILE_BASE64
- HARMONY_CERTPATH_BASE64
- HARMONY_STORE_PASSWORD
- HARMONY_KEY_PASSWORD
- HARMONY_KEY_ALIAS
- HARMONY_SIGN_ALG
```

- 需要环境变量 `GITHUB_TOKEN`，且令牌有目标仓库的 **Secrets 写权限**：
  fine-grained token 勾选 `Secrets: Read and write`，classic token 选 `repo`。
- GitHub Actions 自动注入的 `GITHUB_TOKEN` 通常**不能写 Secrets**；CI 里请把有权限的 PAT
  存成 Secret，再以 `GITHUB_TOKEN` 传给本命令，例如 `GITHUB_TOKEN: ${{ secrets.GH_PAT }}`。
- 值在本地用 libsodium sealed box（`crypto_box_seal`）加密后上传；请求体里只有
  `encrypted_value` 与 `key_id`，明文不落地；错误信息只带变量名，不回显值。
- 省略 `--github-repo` 时先看 `GITHUB_REPOSITORY`（Actions 自动注入），再按当前 git
  remote 的 origin 推断；GitHub Enterprise 用 `GITHUB_API_URL=https://host/api/v3` 指定 API 地址。
- 七个变量一次写完；某个失败时错误会指出失败项与已成功写入的个数，重跑即可（同名密钥被覆盖）。
- 48 KB 上限按加密后的 `encrypted_value` 计算，超过时本地直接失败，不会发起请求。
- `--github-env` 要求对应的 GitHub Environment 已存在；否则 GitHub 返回 404。
- `--github` 不能与 `--format` / `--separator` 同时使用；后两者只控制 stdout。
- 写入后在 workflow 里用 `${{ secrets.HARMONY_STORE_FILE_BASE64 }}` 等引用即可，
  `huawei signing-material-env` 直接读取同名的 `HARMONY_*` 环境变量。

### 上传一个安装包分三步

只做前两步时文件**只躺在华为对象存储里，控制台「软件包管理」看不到它**，必须再调第三步登记：

| 步骤 | 接口 | 谁来调 |
| --- | --- | --- |
| 1. 取上传地址 | `GET /api/publish/v2/upload-url/for-obs` | `*-upload-url` / `*-upload-file` / `*-upload-file-package-info-update` |
| 2. 上传到 OBS | `PUT urlInfo.url` | `*-upload-file` / `*-upload-file-package-info-update` |
| 3. 登记为应用软件包 | `.app` → `PUT /api/publish/v3/app-package-info`；`.apk` 等 → `PUT /api/publish/v2/app-file-info` | `*-upload-file-package-info-update` |

第三步的接口**按安装包后缀自动二选一**（华为把它拆成了两套互斥的接口，串用会失败）：

| 后缀 | 登记接口 | 载荷 | `--release-type` | 返回的软件包标识 |
| --- | --- | --- | --- | --- |
| `.app`（HarmonyOS 5 及以上） | `PUT /api/publish/v3/app-package-info?appId=…[&releaseType=…][&releasePhase=…]` | `{"fileName":…,"objectId":…}` | `1` 全网 / `7` 企业非公开发布 | `packageId` |
| `.apk`、`.aab`、`.rpk`、`.hap`（Android 与 HarmonyOS 4 及以下） | `PUT /api/publish/v2/app-file-info?appId=…[&releaseType=…]` | `{"fileType":5,"files":[{"fileName":…,"fileDestUrl":…}]}` | `1` 全网 / `3` 分阶段 | `pkgVersion` |

- 用 `.apk` 去调 v3 接口会被华为按后缀拦下：`AGC 返回错误码 204144641: [AppGalleryConnectPublishService]The suffix name of the software package is incorrect`。
- `--release-phase`（`0` 全网 / `3` 分阶段）只有 `.app` 那套接口有；`.apk` 等的分阶段发布用 `--release-type 3`。
- 后缀写错、认不出的后缀（如 `.exe`）会在**本地**报用法错误，不会等上传完才失败。

三种用法按需选：

```bash
# A. 只要上传地址，上传自己来（脚本里用 curl，最灵活）
publish-apk huawei service-account-upload-url --app-id <应用ID> --file ./a1.apk --token <Token>

# B. 上传到对象存储（输出 objectId；后台「软件包管理」里还看不到）
OBJECT_ID=$(publish-apk huawei service-account-upload-file \
  --app-id <应用ID> --file ./a1.apk --token <Token>)

# C. 上传 + 登记，一条命令走完三步（最省事；输出 objectId，软件包标识见 --verbose）
publish-apk huawei service-account-upload-file-package-info-update \
  --app-id <应用ID> --file ./a1.apk --kid <密钥ID> --iss <签发者> --private-key ./private.pem

# C'. 文件已经在别处上传过：给 --object-id 就跳过上传，只做登记
publish-apk huawei service-account-upload-file-package-info-update \
  --app-id <应用ID> --file-name a1.apk --object-id "$OBJECT_ID" --token <Token>
```

用法 C 里 `--file` 一条就够：**文件名取它的 basename、文件大小取它的字节数**。
这三个值（取址的 `fileName` 与 `contentLength`、登记时的 `fileName`）都取自同一处，
不会出现「上传用的名字」与「登记用的名字」不一致——华为按后缀校验，不一致就会失败。
想指定上传后的名字就加 `--file-name`（此时以它为准，后缀也以它为准）。

### 示例

```bash
# 1. 签发 Service Account JWT
publish-apk huawei service-account \
  --kid <密钥ID> --iss <签发者> --private-key ./private.pem

# 2. 获取文件上传地址（token 已在环境变量里，或本命令用 service-account 参数本地签发）
#    --file 会用本地文件的文件名补 --file-name、用它的字节数补 --content-length
RESP=$(publish-apk huawei service-account-upload-url \
  --app-id <应用ID> --file ./a1.apk \
  --kid <密钥ID> --iss <签发者> --private-key ./private.pem)

# 3. 按接口返回的方法与地址上传（请求头见 urlInfo.headers，其中含 OBS 签名所需信息）
curl -X "$(jq -r .urlInfo.method <<<"$RESP")" \
     -T a1.apk "$(jq -r .urlInfo.url <<<"$RESP")"

# 3'. 或者一步到位：取地址 + 上传，stdout 直接是 objectId
OBJECT_ID=$(publish-apk huawei service-account-upload-file \
  --app-id <应用ID> --file ./a1.apk \
  --kid <密钥ID> --iss <签发者> --private-key ./private.pem)

# 3''. 或者一条命令做完第 2+3 步：上传 + 登记（不做第 3 步，后台「软件包管理」里看不到）
publish-apk huawei service-account-upload-file-package-info-update \
  --app-id <应用ID> --file ./a1.apk \
  --kid <密钥ID> --iss <签发者> --private-key ./private.pem

# 4. API 客户端方式：先换 access_token，再取上传地址（或直接上传）
publish-apk huawei client-credentials --client-id <客户端ID> --client-secret <密钥>
publish-apk huawei client-credentials-upload-url \
  --app-id <应用ID> --file ./a1.apk \
  --client-id <客户端ID> --client-secret <密钥>
publish-apk huawei client-credentials-upload-file \
  --app-id <应用ID> --file ./a1.apk \
  --client-id <客户端ID> --client-secret <密钥>
```

### 文件参数：`--file` / `--file-name` / `--content-length`

两个 `*-upload-url` 命令都要把 `fileName` 与 `contentLength` 作为查询参数发给华为接口，这两个值可以自动推导，不必手算：

| 参数 | 是否必填 | 说明 |
| --- | --- | --- |
| `--file <路径>` | 否 | **本地文件路径**，用来补下面两项：文件名取它的 basename，大小取它的字节数（`HUAWEI_FILE`） |
| `--file-name <文件名>` | 否 | 上传后的对象名；显式给出时以它为准，否则取 `--file` 的文件名 |
| `--content-length <字节>` | 否 | 文件大小；显式给出时以它为准，否则取 `--file` 的大小 |

- 规则是「**`--file` 只补缺**」：`--file-name` / `--content-length`（命令行或环境变量）给了哪个就听哪个，都没给才从 `--file` 推导。
- 只有真的需要推导时才读文件：两项都显式给出时，`--file` 不会被读取，路径不存在也不会报错。
- 反过来，只要还缺一项，`--file` 就必须指向存在的**普通文件**，否则报用法错误（目录、路径写错都会被拦下）。
- 与 `--token` 之类一样，`--file-name` / `--content-length` 没有 `--file` 时仍然可用，行为与旧版本完全一致。

```bash
# 只给文件，其余自动推导（fileName=a1.apk，contentLength=文件字节数）
publish-apk huawei service-account-upload-url --app-id <应用ID> --file ./a1.apk --token <Token>

# 文件在本地叫 a1.apk，但希望上传后叫 a1-release.apk：显式覆盖名字，大小仍然自动推导
publish-apk huawei service-account-upload-url --app-id <应用ID> --file ./a1.apk --file-name a1-release.apk

# 不读本地文件，完全手工指定（旧写法，仍然支持）
publish-apk huawei service-account-upload-url --app-id <应用ID> --file-name a1.apk --content-length 111223
```

两个 `*-upload-file` 命令的规则不同——它们**必须**有本地文件，因为要上传的就是它的内容：

| 参数 | 是否必填 | 说明 |
| --- | --- | --- |
| `--file <路径>` | **是** | 待上传的本地文件（`HUAWEI_FILE`）；文件名与文件大小都取它 |
| `--file-name <文件名>` | 否 | 上传后的对象名；默认取 `--file` 的文件名 |

- 华为要求上传的字节数与取址时填写的 `contentLength` 一致，所以文件大小**恒取本地文件的实际字节数**；`--content-length` 在本命令里已不接受（写错也不会静默失败，而是直接报未知选项）。
- `--file-name` 与 `--file` 一致时，华为侧的文件后缀校验才容易过（华为要求后缀与取址时的 `fileName` 相同）。
- 大文件注意：文件内容会一次性读入内存，数 GB 的安装包需要给 Node 更多内存（后续可改为流式上传）。
- 本命令**不会**让软件包出现在后台：它只把文件传到对象存储。
  想一条命令走完「上传 + 登记」，用 `*-upload-file-package-info-update`（见上面的「上传一个安装包分三步」）。

### 组合命令：`*-upload-file-package-info-update`

它在 `*-upload-file` 的基础上多接一步「登记软件包」，两种用法：

| 场景 | 参数 | 行为 |
| --- | --- | --- |
| 文件还没上传 | `--app-id` + `--file`（`--file-name` 可选） | 取址 → 上传 → 登记，**三步都走**（与 `*-upload-file` 完全相同的上传逻辑） |
| 文件已上传过 | `--app-id` + `--file-name` + `--object-id` | 跳过取址与上传，只登记（此时不需要 `--file`，连路径都不读） |

- `stdout` 是 **`objectId`**（与 `*-upload-file` 一致）；登记接口返回的软件包标识只在 `--verbose` 日志里
  （`.app` 是 `packageId`，`.apk` 等是 `pkgVersion`，两者都用于查询软件包编译状态）。
- 想显式指定上传后的名字就加 `--file-name`，它同时用于取址、上传与登记三处，保证一致；登记走哪套接口也由它的后缀决定。

### 上传是怎么发的（`*-upload-file`）

上传是 `PUT urlInfo.url`，请求头**完全照抄** `urlInfo.headers`（`Authorization`、`x-amz-content-sha256`、`x-amz-date`、`Host`、
`user-agent`、`Content-Type`），除了按实际字节数补 `Content-Length` 之外不增删任何头部：

- 这些头部是 **OBS 预签名**的一部分，多一个、少一个、值不对都会得到 `SignatureDoesNotMatch`。
- 因此上传没有走 Node 内置 `fetch`（undici 会用连接目标覆盖 `Host`，签名必然不匹配），而是用 `node:https` 原样发送 `Host`。
  实测对比（本地服务回显收到的头部）：`fetch` 把 `Host` 改成连接目标，并额外加上 `accept`、`accept-language`、`sec-fetch-mode` 等头部；`node:https` 配上 `setHost: false` 后收到的头部与期望完全一致。
- 地址有效期为**约 5 分钟**，所以本命令把"取地址 → 上传"串在一条命令里完成，中间不做别的耗时操作。
- 上传成功时华为只返回 HTTP 200（响应体为空），因此 `stdout` 输出的是取址响应里的 `objectId`——后续接口（如上传软件包）需要它。

### google 子命令

Google Play 走 **Android Publisher API v3**，鉴权用**服务账号 JSON 密钥**：本地签发 RS256 JWT → 换取 OAuth 2.0 `access_token`：

| 命令 | 说明 | stdout |
| --- | --- | --- |
| `google access-token` | 用服务账号 JSON 换取 `access_token` | `access_token` |
| `google upload-aab` | 创建 edit → 上传 `.aab` →（可选）更新轨道 → 提交 edit | bundle 的 `versionCode` |

#### google access-token

| 选项 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `--service-account <文件>` | 与下一项二选一（或用分项） | `GOOGLE_SERVICE_ACCOUNT` | 服务账号 JSON 密钥文件路径 |
| `--service-account-data <JSON>` | 与上一项二选一 | `GOOGLE_SERVICE_ACCOUNT_DATA` | 直接给 JSON 文本（与文件互斥） |
| `--client-email <邮箱>` | 用分项时必填 | `GOOGLE_CLIENT_EMAIL` | JSON 的 `client_email` |
| `--private-key <文件>` | 分项二选一 | `GOOGLE_PRIVATE_KEY` | 私钥 PEM 文件 |
| `--private-key-data <PEM>` | 分项二选一 | `GOOGLE_PRIVATE_KEY_DATA` | 私钥 PEM 文本（建议只走环境变量） |
| `--token-uri <地址>` | 否 | `GOOGLE_TOKEN_URI` | 默认取 JSON 的 `token_uri`，再退回 `https://oauth2.googleapis.com/token` |
| `--verbose` | 否 | `GOOGLE_VERBOSE` | 运行日志写 `stderr`；`client_email` 只显示掩码 |

- `stdout` 只有 `access_token`（有效期约 1 小时），本命令只换令牌、不碰应用。
- 完整 JSON 与分项不能同时给；`--service-account` 与 `--service-account-data` 也互斥。
- 凭据优先级：命令行 JSON → 命令行分项 → 环境变量 JSON → 环境变量分项。

#### google upload-aab

| 选项 | 必填 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `--package-name <包名>` | 是 | `GOOGLE_PACKAGE_NAME` | 如 `com.example.app` |
| `--file <路径>` | 是 | `GOOGLE_FILE` | `.aab` 文件；后缀、包名、发布状态、比例都在本地先校验 |
| `--service-account <文件>` | 未给 `--token` 时 | `GOOGLE_SERVICE_ACCOUNT` | 服务账号 JSON 密钥文件路径 |
| `--service-account-data <JSON>` | 未给 `--token` 时（与上一项二选一） | `GOOGLE_SERVICE_ACCOUNT_DATA` | 直接给 JSON 文本 |
| `--client-email <邮箱>` | 用分项时必填 | `GOOGLE_CLIENT_EMAIL` | JSON 的 `client_email` |
| `--private-key <文件>` | 分项二选一 | `GOOGLE_PRIVATE_KEY` | 私钥 PEM 文件 |
| `--private-key-data <PEM>` | 分项二选一 | `GOOGLE_PRIVATE_KEY_DATA` | 私钥 PEM 文本 |
| `--token-uri <地址>` | 否 | `GOOGLE_TOKEN_URI` | 令牌接口地址 |
| `--token <access_token>` | 否 | `GOOGLE_TOKEN` | 已换取的令牌；给了就不再用凭据换取 |
| `--track <轨道>` | 否 | `GOOGLE_TRACK` | 轨道标识；不给则只上传 bundle、不进入任何轨道 |
| `--release-status <状态>` | 否 | `GOOGLE_RELEASE_STATUS` | `completed`（默认）/ `draft` / `inProgress` / `halted` |
| `--release-name <名称>` | 否 | `GOOGLE_RELEASE_NAME` | 轨道发布名称 |
| `--release-notes <文本>` | 否 | `GOOGLE_RELEASE_NOTES` | 发布说明；较长时用 `"$(cat notes.txt)"` |
| `--release-notes-language <语言>` | 否 | `GOOGLE_RELEASE_NOTES_LANGUAGE` | BCP-47，默认 `zh-CN` |
| `--user-fraction <比例>` | 否 | `GOOGLE_USER_FRACTION` | 分阶段比例（0 与 1 之间）；`inProgress` 时必填 |
| `--changes-not-sent-for-review` | 否 | `GOOGLE_CHANGES_NOT_SENT_FOR_REVIEW` | 提交时置 `changesNotSentForReview=true`，变更留待人工送审 |
| `--verbose` | 否 | `GOOGLE_VERBOSE` | 运行日志写 `stderr`；Token 只显示掩码 |

- `stdout` 是 bundle 的 `versionCode`；只有 commit 成功修改才生效，失败时会尽力删除未提交的 edit。
- 凭据优先级：命令行 JSON → 命令行分项 → `--token` → 环境变量 JSON → 环境变量分项。

### 上传一个 .aab 分四步

| 步骤 | 接口 | 谁来调 |
| --- | --- | --- |
| 1. 创建 edit | `POST /androidpublisher/v3/applications/{packageName}/edits` | `google upload-aab` |
| 2. 上传 bundle | `POST /upload/androidpublisher/v3/applications/{packageName}/edits/{editId}/bundles?uploadType=resumable` 取会话地址，再 `PUT` 会话地址上传文件内容 | `google upload-aab` |
| 3. 更新轨道 | `PUT /androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}` | 给了 `--track` 时 |
| 4. 提交 edit | `POST /androidpublisher/v3/applications/{packageName}/edits/{editId}:commit` | `google upload-aab` |

- **只有第 4 步提交成功，修改才真正生效**。中途失败时命令会尽力 `DELETE` 这个 edit：已上传的 bundle 一并丢弃，不留下半成品。
- 不给 `--track` 时只上传 bundle 并提交，**不进入任何轨道**；给了 `--track` 才创建 / 更新对应轨道的发布。
- `.aab` 后缀、包名、发布状态、分阶段比例都会在**本地**先校验，不会等传完才失败。
- 上传用 Google 的 **resumable upload**（先取会话地址、再 PUT 文件内容），这是官方对大文件的做法；`.aab` 仍会一次性读入内存，超大包需给 Node 更多内存。
- 若提交返回 `changesNotSentForReview`（例如应用启用了**托管发布（managed publishing）**）：加 `--changes-not-sent-for-review`（或 `GOOGLE_CHANGES_NOT_SENT_FOR_REVIEW=1`），变更会留在 Play 控制台等待人工送审。

`--track` 的取值是轨道标识：`production`（正式版）、`beta`、`alpha`、`internal`（内部测试），或其他自定义轨道名（外形轨道如 `wear:production` 也可直接传）。给了 `--track` 时的发布状态：

| `--release-status` | 含义 |
| --- | --- |
| `completed` | 全部用户可更新（默认） |
| `draft` | 仅保存为草稿，需要人工在 Play 控制台发起发布 |
| `inProgress` | 分阶段发布，**必须**同时给出 `--user-fraction`（0 与 1 之间，如 `0.1` 表示 10% 用户） |
| `halted` | 暂停分阶段发布，可配合 `--user-fraction` 调整比例 |

```bash
# 1. 用服务账号换 access_token
publish-apk google access-token --service-account ./google-play-service-account.json

# 2. 只上传 .aab（不发布到轨道），stdout 是 versionCode
publish-apk google upload-aab \
  --package-name com.example.app --file ./app-release.aab \
  --service-account ./google-play-service-account.json

# 3. 上传并发布到内部测试轨道（默认 completed）
publish-apk google upload-aab \
  --package-name com.example.app --file ./app-release.aab \
  --service-account ./google-play-service-account.json --track internal

# 4. 正式轨道 + 发布说明（默认语言 zh-CN，可用 --release-notes-language 改）
publish-apk google upload-aab \
  --package-name com.example.app --file ./app-release.aab \
  --service-account ./google-play-service-account.json --track production \
  --release-notes "修复若干问题"

# 5. 10% 分阶段发布
publish-apk google upload-aab \
  --package-name com.example.app --file ./app-release.aab \
  --service-account ./google-play-service-account.json --track production \
  --release-status inProgress --user-fraction 0.1

# 6. 已有 access_token（例如由别处换取），不必再给服务账号
publish-apk google upload-aab --package-name com.example.app --file ./app-release.aab \
  --token "$GOOGLE_TOKEN" --track beta
```

### Google Play 服务账号准备

1. 在 Google Cloud 控制台创建项目，并启用 **Google Play Developer API**；
2. 创建服务账号并生成 **JSON 密钥**（含 `client_email`、`private_key`、`token_uri`）；
3. 在 Google Play 控制台的「用户和权限」里邀请该 `client_email`，按需授予 **Release to testing tracks**、
   **Release to production, exclude devices, and use app signing by Google Play** 等权限；
4. 应用的**第一个版本仍需在 Play 控制台手动上传**，之后才能用 API 上传后续版本。

凭据有两种传法，任选其一：

**方式 A：完整 JSON**（推荐，字段不易拼错）

- `--service-account <文件>` / `GOOGLE_SERVICE_ACCOUNT`
- `--service-account-data <JSON>` / `GOOGLE_SERVICE_ACCOUNT_DATA`

**方式 B：把 JSON 里的属性拆开传**（适合 CI 把各字段存成独立 Secret）

| JSON 字段 | 命令行选项 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `client_email` | `--client-email` | `GOOGLE_CLIENT_EMAIL` | 必填 |
| `private_key` | `--private-key-data` | `GOOGLE_PRIVATE_KEY_DATA` | 必填，PEM 数据；也可存成 PEM 文件后用 `--private-key` / `GOOGLE_PRIVATE_KEY` |
| `token_uri` | `--token-uri` | `GOOGLE_TOKEN_URI` | 可选，默认 `https://oauth2.googleapis.com/token` |
| `project_id`、`private_key_id` | — | — | 不参与 RS256 JWT 鉴权，无需传递 |

```bash
# 方式 B：命令行分项参数
publish-apk google upload-aab \
  --package-name com.example.app --file ./app-release.aab \
  --client-email publisher@project.iam.gserviceaccount.com \
  --private-key ./service-account.pem --track internal

# 方式 B：环境变量（私钥建议只走环境变量，避免出现在 ps / CI 日志里）
export GOOGLE_CLIENT_EMAIL=publisher@project.iam.gserviceaccount.com
export GOOGLE_PRIVATE_KEY_DATA="$(cat service-account.pem)"
publish-apk google upload-aab --package-name com.example.app --file ./app-release.aab --track internal
```

凭据优先级（高 → 低）：命令行 JSON → 命令行分项 → 环境变量 JSON → 环境变量分项。
命令行 JSON 与分项不能同时给；环境变量层两者都在时优先完整 JSON 并在 stderr 提示。

本工具只支持**服务账号 JSON 密钥**（`type` 为 `service_account`）或它的分项字段；Workload Identity Federation / ADC 生成的凭据文件暂不支持。

## 环境变量

带值的选项都有同名环境变量兜底，**命令行选项优先**；开关型选项 `--verbose` 对应各命令的 `*_VERBOSE`（`cert` 用 `CERT_VERBOSE`，`profile` 用 `PROFILE_VERBOSE`，`hap` 用 `HAP_VERBOSE`，`app` 用 `APP_VERBOSE`，`apk` 用 `APK_VERBOSE`，`aab` 用 `AAB_VERBOSE`），取值规则见下表。

### 证书（`CERT_*`）

| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `CERT_FILE` | `--file` | 证书 / PKCS#12 文件路径（PEM / DER / `.p12` / `.pfx`）；**必填**，没有默认文件 |
| `CERT_PASSWORD` | `--password` | PKCS#12 密钥库密码；建议用环境变量，避免密码进入 `ps` / shell 历史 |
| `CERT_VERBOSE` | `--verbose` | 输出全部字段：`1`/`true`/`yes`/`on` 开启，`0`/`false`/`no`/`off` 关闭 |

### P7B Profile（`PROFILE_*`）

| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `PROFILE_FILE` | `--file` | P7B 文件路径（PKCS#7 SignedData，DER / PEM）；**必填**，没有默认文件 |
| `PROFILE_VERBOSE` | `--verbose` | 输出全部字段：`1`/`true`/`yes`/`on` 开启，`0`/`false`/`no`/`off` 关闭 |

### HAP 安装包（`HAP_*`）

| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `HAP_FILE` | `--file` | HAP 文件路径；**必填**，没有默认文件 |
| `HAP_VERBOSE` | `--verbose` | 输出全部字段：`1`/`true`/`yes`/`on` 开启，`0`/`false`/`no`/`off` 关闭 |

### APP 安装包（`APP_*`）

| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `APP_FILE` | `--file` | APP 文件路径；**必填**，没有默认文件 |
| `APP_VERBOSE` | `--verbose` | 输出全部字段：`1`/`true`/`yes`/`on` 开启，`0`/`false`/`no`/`off` 关闭 |

### APK 安装包（`APK_*`）

| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `APK_FILE` | `--file` | APK 文件路径；**必填**，没有默认文件 |
| `APK_VERBOSE` | `--verbose` | 输出全部字段：`1`/`true`/`yes`/`on` 开启，`0`/`false`/`no`/`off` 关闭 |

### AAB 安装包（`AAB_*`）

| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `AAB_FILE` | `--file` | AAB 文件路径；**必填**，没有默认文件 |
| `AAB_VERBOSE` | `--verbose` | 输出全部字段：`1`/`true`/`yes`/`on` 开启，`0`/`false`/`no`/`off` 关闭 |

### Android keystore（`ANDROID_*`）

| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `--base64` | 密钥库的 BASE64 内容；`keystore` 与文件路径同用时先解码落盘，`keystore-config` 先解码写成 `storeFile` |
| `ANDROID_KEYSTORE_FILE` | `--file` | 密钥库路径；`keystore` 与 BASE64 同用时是输出路径，单独用时是输入文件；`keystore-config` 用作 `storeFile`；`keystore-gen` 用作输出路径 |
| `ANDROID_KEYSTORE` | `--file` | `ANDROID_KEYSTORE_FILE` 的别名，只当文件路径用 |
| `ANDROID_STORE_FILE` | `--store-file` | `keystore-config` 写进配置的 `storeFile`，也是 BASE64 解码后的落盘路径；未设置时取 `ANDROID_KEYSTORE_FILE` |
| `ANDROID_KEYSTORE_CONFIG` | `--out` | `keystore-config` 的配置文件输出路径，默认 `keystore.properties` |
| `ANDROID_KEYSTORE_PASSWORD` | `--store-password` | keystore 明文口令；`keystore` / `keystore-env` / `keystore-config` / `keystore-gen` 共用；建议用环境变量，避免进入 `ps` / shell 历史 |
| `ANDROID_KEY_ALIAS` | `--key-alias` | 私钥别名；`keystore` 不传时自动识别，`keystore-config` 写入 `keyAlias`，`keystore-gen` 默认 `release` |
| `ANDROID_KEY_PASSWORD` | `--key-password` | 私钥明文口令；不传时用 keystore 口令；`keystore-config` 写入 `keyPassword` |
| `KEYTOOL` | —（仅环境变量） | `keytool` 可执行文件，默认 PATH 上的 `keytool` |

```bash
# 已有 keystore 文件
ANDROID_KEYSTORE_FILE=./release.p12 \
ANDROID_KEYSTORE_PASSWORD=<口令> ANDROID_KEY_ALIAS=release \
publish-apk keystore

# BASE64 + 输出文件：先落盘再校验
ANDROID_KEYSTORE_BASE64="$(openssl base64 -A -in release.p12)" \
ANDROID_KEYSTORE_FILE=./release.p12 \
ANDROID_KEYSTORE_PASSWORD=<口令> ANDROID_KEY_ALIAS=release \
publish-apk keystore

# BASE64 + 口令 + 别名：生成 keystore.properties（先落盘 storeFile）
ANDROID_KEYSTORE_BASE64="$(openssl base64 -A -in publish_apk_demo.keystore)" \
ANDROID_KEYSTORE_PASSWORD=<口令> ANDROID_KEY_ALIAS=publish_apk_demo \
ANDROID_KEY_PASSWORD=<口令> \
publish-apk keystore-config --store-file ../../publish_apk_demo.keystore --out ./app/keystore.properties
```

### 华为（`HUAWEI_*`）


| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `HUAWEI_KID` | `--kid` | JWT 请求头中的密钥 ID |
| `HUAWEI_ISS` | `--iss` | JWT 载荷中的签发者 |
| `HUAWEI_PRIVATE_KEY` | `--private-key` | 私钥 PEM 文件路径 |
| `HUAWEI_PRIVATE_KEY_DATA` | `--private-key-data` | 私钥 PEM 数据（与前者二选一；两者都在时**数据优先**并在 stderr 提示） |
| `HUAWEI_IAT` | `--iat` | JWT 签发时间（UTC 秒级时间戳），默认当前时间 |
| `HUAWEI_CLIENT_ID` | `--client-id` | API 客户端 ID |
| `HUAWEI_CLIENT_SECRET` | `--client-secret` | API 客户端密钥 |
| `HUAWEI_APP_ID` | `--app-id` | AppGallery Connect 的 `appId`（非负整数） |
| `HUAWEI_FILE` | `--file` | 本地文件路径；`*-upload-url` 用它补 `--file-name` 与 `--content-length`，`*-upload-file` 则必须给出 |
| `HUAWEI_FILE_NAME` | `--file-name` | 上传的文件名，如 `a1.apk`；未显式给出时取 `HUAWEI_FILE` 的文件名 |
| `HUAWEI_CONTENT_LENGTH` | `--content-length` | 文件大小（字节，非负整数）；只有 `*-upload-url` 用它（未给出时取 `HUAWEI_FILE` 的字节数），`*-upload-file` 不接受该选项 |
| `HUAWEI_TOKEN` | `--token` | 已签发的 JWT 或 `access_token` |
| `HUAWEI_OBJECT_ID` | `--object-id` | `*-upload-file-package-info-update`：已上传文件的 `objectId`；给出则跳过上传，只做登记 |
| `HUAWEI_RELEASE_TYPE` | `--release-type` | `*-upload-file-package-info-update`：应用发布方式，默认 `1`；`.app` 用 `1` 全网 / `7` 企业非公开发布，`.apk` 等用 `1` 全网 / `3` 分阶段 |
| `HUAWEI_RELEASE_PHASE` | `--release-phase` | `*-upload-file-package-info-update`：分阶段发布标识，`0` 全网 / `3` 分阶段；只有 `.app`（v3 接口）有这个参数 |
| `HUAWEI_VERBOSE` | `--verbose` | 开启运行日志：`1`/`true`/`yes`/`on` 开启，`0`/`false`/`no`/`off` 关闭 |
| `HUAWEI_API_BASE` | —（仅环境变量） | 接口域名，默认 `https://connect-api.cloud.huawei.com`；其他区域（`connect-api-dre/dra/drru.cloud.huawei.com`）或本地联调时覆盖 |

示例（密钥全程只走环境变量，不出现在命令行参数里；文件大小由 `HUAWEI_FILE` 自动推导）：

```bash
export HUAWEI_KID=<密钥ID>
export HUAWEI_ISS=<签发者>
export HUAWEI_PRIVATE_KEY=./private.pem
export HUAWEI_APP_ID=<应用ID>
export HUAWEI_FILE=./a1.apk

publish-apk huawei service-account-upload-url
```

如果本机拿不到文件（例如由别的步骤产出），就用 `HUAWEI_FILE_NAME` + `HUAWEI_CONTENT_LENGTH` 显式给出这两个值
（这只适用于 `*-upload-url`；`*-upload-file` 必须能读到本地文件）。

### 鸿蒙签名配置（`HARMONY_*`）

| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `HARMONY_STORE_FILE` | `--store-file` | 鸿蒙签名密钥库 `.p12` 路径，或 BASE64 |
| `HARMONY_STORE_FILE_BASE64` | `--store-file` | BASE64 的 `.p12`（别名） |
| `HARMONY_STORE_FILE_OUT` | `--store-file-out` | p12 内容/复制目标；默认当前目录的 `storeFile.p12` |
| `HARMONY_CERTPATH` | `--certpath` | 鸿蒙签名证书 `.cer` 路径，或直接给 PEM 内容 / BASE64（DER 或 PEM）；也接受 `HARMONY_CERT`、`HARMONY_CERTPATH_BASE64`、`HARMONY_CERT_BASE64` |
| `HARMONY_CERTPATH_OUT` | `--certpath-out` | 证书内容/复制目标；默认 `.p12` 同级的 `certpath.cer` |
| `HARMONY_PROFILE` | `--profile` | 鸿蒙 Provisioning Profile `.p7b` 路径，或 BASE64 |
| `HARMONY_PROFILE_BASE64` | `--profile` | BASE64 的 `.p7b`（别名） |
| `HARMONY_PROFILE_OUT` | `--profile-out` | profile 内容/复制目标；默认 `.p12` 同级的 `profile.p7b` |
| `HARMONY_KEY_ALIAS` | `--key-alias` | p12 里的密钥别名；不传时用 keytool 自动读取 |
| `HARMONY_SIGN_ALG` | `--sign-alg` | 签名算法，默认 `SHA256withECDSA` |
| `HARMONY_STORE_PASSWORD` | `--store-password` | `.p12` 明文口令；推荐用环境变量/交互输入；make 只把它作为环境变量传给子进程，不转成 `--store-password` |
| `HARMONY_KEY_PASSWORD` | `--key-password` | 密钥明文口令；默认与 `HARMONY_STORE_PASSWORD` 相同 |
| `HARMONY_VERBOSE` | `--verbose` | 输出 `.p12` / `.cer` / `.p7b` 全部字段；`1`/`true`/`yes`/`on` 开启，`0`/`false`/`no`/`off` 关闭 |
| `HARMONY_CONFIG` | `--config` | `build-profile.json5` 路径，默认 `./build-profile.json5` |
| `HARMONY_SIGNING_NAME` | `--name` | 要更新/输出的 signingConfig 名字，默认 `default` |
| `HARMONY_PRODUCT` | `--product` | 按产品名找它挂的 signingConfig 作为名字 |

### GitHub Actions 密钥（`GITHUB_*`）

只用于 `huawei signing-env --github` 与 `keystore-env --github`；不会影响其它命令。

| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | — | `--github` 必填；需要仓库 Secrets 写权限（fine-grained 的 Secrets 读写，classic 的 `repo`） |
| `GITHUB_REPOSITORY` | `--github-repo` | `owner/repo`；Actions 自动注入；未给 `--github-repo` 时用它 |
| `GITHUB_API_URL` | — | API 地址，默认 `https://api.github.com`；GitHub Enterprise 用 `https://host/api/v3` |

### Google Play（`GOOGLE_*`）

| 环境变量 | 等价选项 | 说明 |
| --- | --- | --- |
| `GOOGLE_PACKAGE_NAME` | `--package-name` | Google Play 应用包名，如 `com.example.app` |
| `GOOGLE_FILE` | `--file` | `.aab` 文件路径 |
| `GOOGLE_SERVICE_ACCOUNT` | `--service-account` | 服务账号 JSON 密钥文件路径（完整 JSON） |
| `GOOGLE_SERVICE_ACCOUNT_DATA` | `--service-account-data` | 服务账号 JSON 数据（与前者二选一；两者都在时**数据优先**并在 stderr 提示） |
| `GOOGLE_CLIENT_EMAIL` | `--client-email` | 服务账号 JSON 的 `client_email`（分项字段） |
| `GOOGLE_PRIVATE_KEY` | `--private-key` | 私钥 PEM 文件路径（分项字段，与 `GOOGLE_PRIVATE_KEY_DATA` 二选一） |
| `GOOGLE_PRIVATE_KEY_DATA` | `--private-key-data` | 私钥 PEM 数据（分项字段；建议只走环境变量） |
| `GOOGLE_TOKEN` | `--token` | 已换取的 `access_token` |
| `GOOGLE_TRACK` | `--track` | 发布到哪个轨道；不给则只上传 bundle |
| `GOOGLE_RELEASE_STATUS` | `--release-status` | 轨道发布状态，默认 `completed` |
| `GOOGLE_RELEASE_NAME` | `--release-name` | 轨道发布名称 |
| `GOOGLE_RELEASE_NOTES` | `--release-notes` | 轨道发布说明 |
| `GOOGLE_RELEASE_NOTES_LANGUAGE` | `--release-notes-language` | 发布说明语言（BCP-47），默认 `zh-CN` |
| `GOOGLE_USER_FRACTION` | `--user-fraction` | 分阶段发布比例（0 与 1 之间） |
| `GOOGLE_CHANGES_NOT_SENT_FOR_REVIEW` | `--changes-not-sent-for-review` | 提交时 `changesNotSentForReview=true`（托管发布时变更留待人工送审）；`1`/`true`/`yes`/`on` 开启 |
| `GOOGLE_VERBOSE` | `--verbose` | 开启运行日志：`1`/`true`/`yes`/`on` 开启，`0`/`false`/`no`/`off` 关闭 |
| `GOOGLE_TOKEN_URI` | `--token-uri` | 令牌接口地址；默认取服务账号 JSON 的 `token_uri`（`https://oauth2.googleapis.com/token`） |
| `GOOGLE_API_BASE` | —（仅环境变量） | 接口域名，默认 `https://androidpublisher.googleapis.com`；本地联调或代理时覆盖 |

示例（密钥全程只走环境变量，不出现在命令行参数里）：

```bash
export GOOGLE_SERVICE_ACCOUNT=./google-play-service-account.json
export GOOGLE_PACKAGE_NAME=com.example.app
export GOOGLE_FILE=./app-release.aab
export GOOGLE_TRACK=internal

publish-apk google upload-aab
```

`upload-aab` 的 Token 来源优先级（高 → 低）：命令行 JSON 参数 → 命令行分项参数（两者都是本地换取）→
`--token`（或 `GOOGLE_TOKEN`）→ 环境变量 JSON → 环境变量分项（本地换取）。

## 常见华为错误码

登记软件包时遇到的错误码，多数不是请求写法问题，而是**应用/版本当前状态**不允许修改：

| 错误码 | 华为描述 | 含义与处理 |
| --- | --- | --- |
| `204144641` | `The suffix name of the software package is incorrect` | 用 v3 接口登记 `.apk` 等非 `.app` 安装包。本工具已按后缀自动选接口；手写请求时 `.apk`/`.aab`/`.rpk`/`.hap` 要调 `/api/publish/v2/app-file-info` |
| `204144647` | `[cds]update service failed … can't be edited service` | 应用版本处于**审核中**（`app-info` 的 `releaseState` 为 `4`）或分阶段发布中，此时不允许更新文件信息。等版本回到可编辑状态（如 `0` 已上架、`7` 草稿）再试；注意华为**仍可能**把这次软件包加进「软件包管理」列表 |
| `204144743` | `app state can not be modified!` | 同上：应用正在审核（例如首次审核），不允许修改 |

## 常见 Google Play 错误

服务账号换取令牌成功不代表有发布权限；下面几类错误最常见：

| HTTP / 错误 | 含义与处理 |
| --- | --- |
| `401 invalid_grant` | 服务账号 JSON 与项目不匹配、私钥损坏，或本机时间偏差过大（JWT 的 `iat` / `exp`）。检查系统时间并重新下载密钥 |
| `403 PERMISSION_DENIED` | 服务账号未在 Play 控制台「用户和权限」中被邀请，或缺少对应轨道 / 正式版的发布权限 |
| `404 applicationNotFound` | `--package-name` 写错，或应用尚未在 Play 控制台创建 |
| `400` 上传或更新轨道失败 | 常见原因：`.aab` 损坏或签名不对、versionCode 已存在且未提升、上一版本还在处理中（稍后重试）、`inProgress` 缺少 `userFraction` |

## 输出与退出代码约定

- `stdout`：只写结果（JWT / `access_token` / 接口原始响应 JSON / `objectId` / `versionCode` / 证书、PKCS#12、P7B profile 与 Android keystore 信息 / `signingConfig` JSON），可直接被 `$(…)` 与 `jq` 取用。
- `stderr`：错误信息与 `--verbose` / `HUAWEI_VERBOSE` / `GOOGLE_VERBOSE` 的运行日志；日志中 **Token、`client_id`、私钥路径、服务账号路径只显示掩码**，私钥与服务账号 JSON 数据永不写入日志（`--file` 的本地路径按原样打印，它不是凭证，出错时正是靠它定位）。
- `cert` 的 `--verbose` / `CERT_VERBOSE` 是「输出全部证书 / 密钥库字段」而不是运行日志，信息统一写 `stdout`；PKCS#12 的私钥内容不会被输出。
- `profile` 的 `--verbose` / `PROFILE_VERBOSE` 输出全部 profile JSON 字段与证书字段，信息同样写 `stdout`。
- `keystore` 的 `stdout` 是校验结果（密钥库 / 大小 / 类型 / 别名 / 公钥 / 证书 / 校验结论），落盘与备份路径写 `stderr`；口令不会打印。
- `keystore-config` 的 `stdout` 是配置文件路径与 `storeFile` / `keyAlias`；配置内容（含明文口令）只写入权限 `0600` 的文件，`--out -` 时才原样写 `stdout`。
- `huawei signing-config` 的 `stdout` 是 `signingConfig` JSON（含密文口令），保持纯 JSON；`.p12` / `.cer` / `.p7b` 材料信息、material 路径、keytool 自检结果与 `--write` 备份路径都写 `stderr`；明文口令不会打印。
- `huawei signing-env` 默认 `stdout` 是七个 `HARMONY_*` 变量（含明文口令）；`--github` 时 `stdout` 只有写入结果（仓库 / 范围 / 变量名），值不输出。
- 用法错误（参数缺失、参数非法）：先输出对应帮助文档（`stdout`）、再输出错误（`stderr`），退出代码 `1`。
- 退出代码：`0` 成功，`1` 参数缺失、参数错误或调用失败。

## Makefile

仓库自带 [Makefile](Makefile) 封装常用调用，`make help` 查看全部目标：

```bash
make help                                       # 目标列表
make h                                           # 根帮助
make cert CERT_FILE=./certpath.cer               # 查看证书
CERT_PASSWORD=<密码> make cert CERT_FILE=./storeFile.p12  # 查看 PKCS#12（密码只走环境变量）
make cert-help                                   # cert 命令帮助
make keystore ANDROID_KEYSTORE_FILE=./release.p12 ANDROID_KEY_ALIAS=release  # 校验 Android keystore（口令走环境变量）
ANDROID_KEYSTORE_BASE64="$(openssl base64 -A -in release.p12)" \
  ANDROID_KEYSTORE_PASSWORD=<口令> make keystore ANDROID_KEYSTORE_FILE=./release.p12
make keystore-help                               # keystore 命令帮助
ANDROID_KEYSTORE_PASSWORD=<口令> make keystore-env \
  KEYSTORE_ENV_ARGS="--file ./release.p12 --github --github-repo owner/repo"  # 一键写入 GitHub 密钥
ANDROID_KEYSTORE_BASE64="$(openssl base64 -A -in publish_apk_demo.keystore)" \
  ANDROID_KEYSTORE_PASSWORD=<口令> ANDROID_KEY_ALIAS=publish_apk_demo \
  ANDROID_STORE_FILE=../../publish_apk_demo.keystore \
  make keystore-config KEYSTORE_CONFIG_ARGS="--out ./app/keystore.properties"  # 生成 keystore.properties
make keystore-config-help                        # keystore-config 命令帮助
make profile PROFILE_FILE=./profile.p7b          # 查看 P7B Provisioning Profile
make profile-help                                # profile 命令帮助
make hap HAP_FILE=./app-signed.hap               # 查看 HAP 安装包信息
make hap-help                                    # hap 命令帮助
make app APP_FILE=./app-signed.app               # 查看 APP 安装包信息
make app-help                                    # app 命令帮助
make apk APK_FILE=./app-arm64-v8a-release.apk    # 查看 APK 安装包信息
make apk-help                                    # apk 命令帮助
make aab AAB_FILE=./app-release.aab              # 查看 AAB 安装包信息
make aab-help                                    # aab 命令帮助
HARMONY_STORE_PASSWORD=<p12口令> make huawei-signing-config \
  HARMONY_STORE_FILE=./storeFile.p12 HARMONY_CERTPATH=./certpath.cer \
  HARMONY_PROFILE=./profile.p7b HARMONY_SIGNING_NAME=default HARMONY_ARGS="--write"
make huawei-signing-config-help                  # 鸿蒙签名配置帮助
HARMONY_STORE_PASSWORD=<p12口令> make huawei-signing-passwords HARMONY_CONFIG=./build-profile.json5 HARMONY_SIGNING_NAME=default
make huawei-signing-material HARMONY_CONFIG=./build-profile.json5 HARMONY_ARGS="--set storeFile=./storeFile.p12 --set keyAlias=release"
HARMONY_STORE_FILE_BASE64=... make huawei-signing-material-env HARMONY_CONFIG=./build-profile.json5 HARMONY_SIGNING_NAME=default
make huawei-signing-env HARMONY_CONFIG=./build-profile.json5 HARMONY_PRODUCT=prod HARMONY_ARGS="--format env"
make huawei-signing-env HARMONY_CONFIG=./build-profile.json5 HARMONY_PRODUCT=prod \
  HARMONY_ARGS="--github --github-repo owner/repo"   # 一键写入 GitHub Actions 密钥
make huawei-signing-passwords-help               # 只补充 keyPassword/storePassword 帮助
make huawei-help                                 # huawei 子命令帮助
make huawei-service-account HUAWEI_KID=xxx HUAWEI_PRIVATE_KEY=./private.pem
make huawei-service-account-upload-url HUAWEI_APP_ID=xxx HUAWEI_FILE=./a1.apk
make huawei-service-account-upload-file HUAWEI_APP_ID=xxx HUAWEI_FILE=./a1.apk
make huawei-client-credentials HUAWEI_CLIENT_ID=xxx HUAWEI_CLIENT_SECRET=xxx
make huawei-client-credentials-upload-file HUAWEI_APP_ID=xxx HUAWEI_FILE=./a1.apk
make huawei-service-account-upload-file-package-info-update HUAWEI_APP_ID=xxx HUAWEI_FILE=./a1.apk
make google-help                                 # google 子命令帮助
make google-access-token GOOGLE_SERVICE_ACCOUNT=./google-play-service-account.json
make google-upload-aab GOOGLE_PACKAGE_NAME=com.example.app GOOGLE_FILE=./app-release.aab GOOGLE_TRACK=internal
make google-upload-aab GOOGLE_PACKAGE_NAME=com.example.app GOOGLE_FILE=./app-release.aab \
  GOOGLE_CLIENT_EMAIL=xxx@project.iam.gserviceaccount.com GOOGLE_PRIVATE_KEY=./service-account.pem
make pack-check                                  # 查看 npm 发布物内容（npm pack --dry-run，只打印清单、不生成 .tgz）
```

设计约定：**只有 make 命令行上显式传入的变量才转成选项**；来自环境变量（含 `source .env`）的值一律不转发，交给命令自己读取，以免密钥进入命令行参数（`ps` 可见）或被 make 回显到 CI 日志。`HUAWEI_VERBOSE`、`GOOGLE_VERBOSE`、`CERT_VERBOSE`、`CERT_PASSWORD`、`PROFILE_VERBOSE`、`HAP_VERBOSE`、`APP_VERBOSE`、`APK_VERBOSE`、`AAB_VERBOSE`、`HARMONY_VERBOSE`、`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_PASSWORD`、`ANDROID_STORE_FILE`、`ANDROID_KEYSTORE_CONFIG`、`HARMONY_STORE_PASSWORD`、`HARMONY_KEY_PASSWORD`、`GITHUB_TOKEN`、`GITHUB_REPOSITORY`、`GITHUB_API_URL`、`GOOGLE_CHANGES_NOT_SENT_FOR_REVIEW`、`HUAWEI_API_BASE`、`GOOGLE_API_BASE`、`GOOGLE_TOKEN_URI` 无需转发——make 会把命令行变量导出给子进程，命令直接读取（开关型选项转成选项反而无法表达"关闭"）。`CERT_PASSWORD`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_PASSWORD`、`HARMONY_STORE_PASSWORD`、`HARMONY_KEY_PASSWORD` 还刻意不转成 `--password` / `--store-password` / `--key-password`，避免密码进入子进程的 argv。`GOOGLE_SERVICE_ACCOUNT_DATA` 含双引号、`GOOGLE_PRIVATE_KEY_DATA` 是多行 PEM，也刻意不作选项转发，同样由子进程从环境变量读取。

`make pack-check` 只做发布前检查：打印会打进 npm 包的文件清单，不改动工作区。`package.json` 的 `files` 只写了 `src`，但 npm 无论 `files` 怎么写都会带上 `package.json`、`README*` 与 `LICENSE*`（以及 `bin`/`main` 指向的文件），所以 `LICENSE` 与 `README.md` 不需要写进 `files`。

## 参考文档（上游）

### Node.js

- `X509Certificate`（`cert` 命令读取证书所用的内置能力）：
  <https://nodejs.org/api/crypto.html#class-x509certificate>

### OpenSSL

- `openssl-pkcs12`（`cert` 命令查看 PKCS#12 时调用的系统命令）：
  <https://docs.openssl.org/master/man1/openssl-pkcs12/>

### Java / keytool

- `keytool`（`keystore` 命令校验 Android keystore、`huawei signing-config` 自检时调用的 JDK 工具）：
  <https://docs.oracle.com/en/java/javase/21/docs/specs/man/keytool.html>

### PKCS#7 / CMS

- PKCS #7 / CMS SignedData（`profile` 命令解析的 P7B 结构）：
  <https://datatracker.ietf.org/doc/html/rfc5652>

### 华为

- 获取服务端授权（服务器鉴权）——**Service Account 方式**与**API 客户端方式**都写在这一篇里：
  <https://developer.huawei.com/consumer/cn/doc/doccenter-connect-api/agc-help-connect-api-obtain-server-auth-0000002271134661>
- 获取文件上传地址（Upload Management API）：
  <https://developer.huawei.com/consumer/cn/doc/doccenter-connect-api/agc-help-upload-api-upload-url-0000002236201294>
- 上传文件（Upload Management API）：
  <https://developer.huawei.com/consumer/cn/doc/doccenter-connect-api/agc-help-upload-api-upload-file-0000002271160621>
- 更新应用软件包信息（Publishing API，上传三步中的第三步，HarmonyOS 5 及以上，`.app`）：
  <https://developer.huawei.com/consumer/cn/doc/doccenter-connect-api/agc-help-publish-api-app-package-info-update-0000002236201250>
- 更新应用文件信息（Publishing API，上传三步中的第三步，HarmonyOS 3.1/4.0 及以下、Android，`.apk`/`.aab`/`.rpk`/`.hap`）：
  <https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-References/agcapi-app-file-info-0000001111685202>

以上文档归华为所有；本项目仅在帮助文档中做中文转述并给出链接，不复制其正文。

### Google Play

- 接入准备（创建 Google Cloud 项目、启用 API、服务账号与 Play 控制台授权）：
  <https://developers.google.com/android-publisher/getting_started?hl=zh-cn>
- Edits（edit 的生命周期与提交）：
  <https://developers.google.com/android-publisher/edits?hl=zh-cn>
- 上传 `.aab`（`edits.bundles.upload`）：
  <https://developers.google.com/android-publisher/api-ref/rest/v3/edits.bundles/upload?hl=zh-cn>
- 轨道与发布（`Track` / `Release` 字段、发布状态）：
  <https://developers.google.com/android-publisher/tracks?hl=zh-cn>
- 服务账号 OAuth 2.0（JWT Bearer 换取 `access_token`）：
  <https://developers.google.com/identity/protocols/oauth2/service-account>

以上文档归 Google 所有；本项目仅在帮助文档中做中文转述并给出链接，不复制其正文。

## License

[MIT](LICENSE) © 2026 徐晓伟
