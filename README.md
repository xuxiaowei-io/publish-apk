# publish-apk

发布 APP 的命令行工具：为应用市场**获取鉴权令牌**、**获取文件上传地址**、**上传文件**并**登记软件包**，供上传/发布流水线使用。
当前支持华为应用市场（AppGallery Connect / AGC Connect API）。

- 纯 Node.js 实现，**无任何第三方依赖**（只用 `node:crypto`、`node:fs`、内置 `fetch`）
- `stdout` 只写结果、`stderr` 只写日志与错误，便于 `TOKEN=$(publish-apk …)` 与管道取用
- 厂商隔离：根命令不认识任何厂商，华为相关实现全部在 [src/huawei.js](src/huawei.js)

> 状态：`0.0.1-alpha.x` 早期版本，参数与输出可能调整，请以 `--help` 为准。

## 声明：与华为及其他应用商店无关

- 本项目是**个人/社区开源工具，不是华为官方产品**，与华为技术有限公司及其关联公司**没有任何隶属、合作、赞助或背书关系**。
- 本项目与 Google Play、小米应用商店、OPPO 软件商店、vivo 应用商店等**任何其他应用商店/分发平台同样没有任何关系**。将来若新增对其他厂商的支持，同样与该厂商无隶属或背书关系。
- "华为""HUAWEI""AppGallery""AppGallery Connect""AGC"等是华为的商标。本项目仅在**描述性意义**上使用这些名称（指明所调用的服务），不主张任何商标权利；[MIT 许可证](LICENSE) 也不授予任何商标使用权。
- 本项目调用的接口地址、路径、参数与错误码均来自厂商**公开文档**；帮助文档只做中文转述并给出原文链接，不复制厂商文档正文，见 [参考文档](#参考文档上游)。

## 免责声明与责任限制

- 本软件按**"现状"（AS IS）**提供，不附带任何明示或默示担保，包括但不限于适销性、特定用途适用性及非侵权担保。
- 本工具会使用**你提供的签名私钥 / 客户端密钥**调用厂商的接口。相关操作可能**直接影响线上发布**（创建版本、上传安装包、提交审核等），部分操作**不可撤销**。请先在小号/测试应用上验证，并自行做好密钥管理与版本备份。
- 在任何情况下，作者或版权持有人均不对因使用或无法使用本软件而产生的任何索赔、损害或其他责任负责，无论其源自合同诉讼、侵权行为或其他方式。
- 使用本工具还需遵守厂商的开发者协议与平台规则（如华为开发者协议、AGC 平台规范）、以及适用的法律法规。相关合规责任由使用者自行承担。
- 本节与 [LICENSE](LICENSE) 中的条款共同适用；若两者冲突，以 [LICENSE](LICENSE) 为准。本节不构成法律意见。

## 环境要求

- Node.js **>= 18**（使用内置 `fetch` 与 `AbortSignal.timeout`）

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
publish-apk huawei                # huawei 子命令帮助
publish-apk huawei <命令> --help   # 某个子命令的帮助文档
```

### huawei 子命令

华为的《获取服务端授权》（服务器鉴权）文档里写着**两套鉴权方式**，本项目两套都实现了：

- **Service Account 方式**：用私钥在本地签发 PS256 JWT，直接作为 `Authorization: Bearer` 使用 → `service-account` / `service-account-upload-url` / `service-account-upload-file` / `service-account-upload-file-package-info-update`
- **API 客户端方式**：用 `client_id` + `client_secret` 调接口换取 `access_token`，业务接口除 Bearer 外还要带 `client_id` 头 → `client-credentials` / `client-credentials-upload-url` / `client-credentials-upload-file` / `client-credentials-upload-file-package-info-update`

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

## 环境变量

带值的选项都有同名环境变量兜底，**命令行选项优先**；开关型选项 `--verbose` 对应 `HUAWEI_VERBOSE`，取值规则见下表。

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

## 常见华为错误码

登记软件包时遇到的错误码，多数不是请求写法问题，而是**应用/版本当前状态**不允许修改：

| 错误码 | 华为描述 | 含义与处理 |
| --- | --- | --- |
| `204144641` | `The suffix name of the software package is incorrect` | 用 v3 接口登记 `.apk` 等非 `.app` 安装包。本工具已按后缀自动选接口；手写请求时 `.apk`/`.aab`/`.rpk`/`.hap` 要调 `/api/publish/v2/app-file-info` |
| `204144647` | `[cds]update service failed … can't be edited service` | 应用版本处于**审核中**（`app-info` 的 `releaseState` 为 `4`）或分阶段发布中，此时不允许更新文件信息。等版本回到可编辑状态（如 `0` 已上架、`7` 草稿）再试；注意华为**仍可能**把这次软件包加进「软件包管理」列表 |
| `204144743` | `app state can not be modified!` | 同上：应用正在审核（例如首次审核），不允许修改 |

## 输出与退出代码约定

- `stdout`：只写结果（JWT / `access_token` / 接口原始响应 JSON / `objectId`），可直接被 `$(…)` 与 `jq` 取用。
- `stderr`：错误信息与 `--verbose` / `HUAWEI_VERBOSE` 的运行日志；日志中 **Token、`client_id`、私钥路径只显示掩码**，私钥数据永不写入日志（`--file` 的本地路径按原样打印，它不是凭证，出错时正是靠它定位）。
- 用法错误（参数缺失、参数非法）：先输出对应帮助文档（`stdout`）、再输出错误（`stderr`），退出代码 `1`。
- 退出代码：`0` 成功，`1` 参数缺失、参数错误或调用失败。

## Makefile

仓库自带 [Makefile](Makefile) 封装常用调用，`make help` 查看全部目标：

```bash
make help                                       # 目标列表
make h                                           # 根帮助
make huawei-help                                 # huawei 子命令帮助
make huawei-service-account HUAWEI_KID=xxx HUAWEI_PRIVATE_KEY=./private.pem
make huawei-service-account-upload-url HUAWEI_APP_ID=xxx HUAWEI_FILE=./a1.apk
make huawei-service-account-upload-file HUAWEI_APP_ID=xxx HUAWEI_FILE=./a1.apk
make huawei-client-credentials HUAWEI_CLIENT_ID=xxx HUAWEI_CLIENT_SECRET=xxx
make huawei-client-credentials-upload-file HUAWEI_APP_ID=xxx HUAWEI_FILE=./a1.apk
make huawei-service-account-upload-file-package-info-update HUAWEI_APP_ID=xxx HUAWEI_FILE=./a1.apk
make pack-check                                  # 查看 npm 发布物内容（npm pack --dry-run，只打印清单、不生成 .tgz）
```

设计约定：**只有 make 命令行上显式传入的变量才转成选项**；来自环境变量（含 `source .env`）的值一律不转发，交给命令自己读取，以免密钥进入命令行参数（`ps` 可见）或被 make 回显到 CI 日志。`HUAWEI_VERBOSE` 与 `HUAWEI_API_BASE` 无需转发——make 会把命令行变量导出给子进程，命令直接读取（`--verbose` 是开关，转成选项反而无法表达"关闭"）。

`make pack-check` 只做发布前检查：打印会打进 npm 包的文件清单，不改动工作区。`package.json` 的 `files` 只写了 `src`，但 npm 无论 `files` 怎么写都会带上 `package.json`、`README*` 与 `LICENSE*`（以及 `bin`/`main` 指向的文件），所以 `LICENSE` 与 `README.md` 不需要写进 `files`。

## 参考文档（上游）

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

## License

[MIT](LICENSE) © 2026 徐晓伟
