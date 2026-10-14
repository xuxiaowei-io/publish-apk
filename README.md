# publish-apk

发布 APP 的命令行工具：为应用市场**获取鉴权令牌**与**文件上传地址**，供上传/发布流水线使用。
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

- **Service Account 方式**：用私钥在本地签发 PS256 JWT，直接作为 `Authorization: Bearer` 使用 → `service-account` / `service-account-upload-url`
- **API 客户端方式**：用 `client_id` + `client_secret` 调接口换取 `access_token`，业务接口除 Bearer 外还要带 `client_id` 头 → `client-credentials` / `client-credentials-upload-url`

| 命令 | 说明 | stdout |
| --- | --- | --- |
| `huawei service-account` | 用 Service Account 私钥签发 PS256 JWT | JWT |
| `huawei service-account-upload-url` | 确定 Token（本地签发优先，其次 `--token`）后获取文件上传地址 | 接口原始响应 JSON |
| `huawei client-credentials` | 用 API 客户端凭证换取 `access_token` | `access_token` |
| `huawei client-credentials-upload-url` | 确定 `access_token`（本地换取优先，其次 `--token`）后获取文件上传地址，并同时携带 `client_id` 头 | 接口原始响应 JSON |

### 示例

```bash
# 1. 签发 Service Account JWT
publish-apk huawei service-account \
  --kid <密钥ID> --iss <签发者> --private-key ./private.pem

# 2. 获取文件上传地址（token 已在环境变量里，或本命令用 service-account 参数本地签发）
RESP=$(publish-apk huawei service-account-upload-url \
  --app-id <应用ID> --file-name a1.apk --content-length 111223 \
  --kid <密钥ID> --iss <签发者> --private-key ./private.pem)

# 3. 按接口返回的方法与地址上传（请求头见 urlInfo.headers，其中含 OBS 签名所需信息）
curl -X "$(jq -r .urlInfo.method <<<"$RESP")" \
     -T a1.apk "$(jq -r .urlInfo.url <<<"$RESP")"

# 4. API 客户端方式：先换 access_token，再取上传地址
publish-apk huawei client-credentials --client-id <客户端ID> --client-secret <密钥>
publish-apk huawei client-credentials-upload-url \
  --app-id <应用ID> --file-name a1.apk --content-length 111223 \
  --client-id <客户端ID> --client-secret <密钥>
```

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
| `HUAWEI_FILE_NAME` | `--file-name` | 上传的文件名，如 `a1.apk` |
| `HUAWEI_CONTENT_LENGTH` | `--content-length` | 文件大小（字节，非负整数） |
| `HUAWEI_TOKEN` | `--token` | 已签发的 JWT 或 `access_token` |
| `HUAWEI_VERBOSE` | `--verbose` | 开启运行日志：`1`/`true`/`yes`/`on` 开启，`0`/`false`/`no`/`off` 关闭 |
| `HUAWEI_API_BASE` | —（仅环境变量） | 接口域名，默认 `https://connect-api.cloud.huawei.com`；其他区域（`connect-api-dre/dra/drru.cloud.huawei.com`）或本地联调时覆盖 |

示例（密钥全程只走环境变量，不出现在命令行参数里）：

```bash
export HUAWEI_KID=<密钥ID>
export HUAWEI_ISS=<签发者>
export HUAWEI_PRIVATE_KEY=./private.pem
export HUAWEI_APP_ID=<应用ID>
export HUAWEI_FILE_NAME=a1.apk
export HUAWEI_CONTENT_LENGTH=111223

publish-apk huawei service-account-upload-url
```

## 输出与退出代码约定

- `stdout`：只写结果（JWT / `access_token` / 接口原始响应 JSON），可直接被 `$(…)` 与 `jq` 取用。
- `stderr`：错误信息与 `--verbose` / `HUAWEI_VERBOSE` 的运行日志；日志中 **Token、`client_id`、私钥路径只显示掩码**，私钥数据永不写入日志。
- 用法错误（参数缺失、参数非法）：先输出对应帮助文档（`stdout`）、再输出错误（`stderr`），退出代码 `1`。
- 退出代码：`0` 成功，`1` 参数缺失、参数错误或调用失败。

## Makefile

仓库自带 [Makefile](Makefile) 封装常用调用，`make help` 查看全部目标：

```bash
make help                                       # 目标列表
make h                                           # 根帮助
make huawei-help                                 # huawei 子命令帮助
make huawei-service-account HUAWEI_KID=xxx HUAWEI_PRIVATE_KEY=./private.pem
make huawei-service-account-upload-url HUAWEI_APP_ID=xxx HUAWEI_FILE_NAME=a1.apk HUAWEI_CONTENT_LENGTH=111223
make huawei-client-credentials HUAWEI_CLIENT_ID=xxx HUAWEI_CLIENT_SECRET=xxx
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

以上文档归华为所有；本项目仅在帮助文档中做中文转述并给出链接，不复制其正文。

## License

[MIT](LICENSE) © 2026 徐晓伟
