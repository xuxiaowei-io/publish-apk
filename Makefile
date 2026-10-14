# Set shell to bash for better compatibility
SHELL := /usr/bin/env bash

# Set default target when running 'make' without arguments
.DEFAULT_GOAL := help

# 本文件定义的变量一律以 HUAWEI_ 开头（SHELL、MAKEFILE_LIST 等是 make 自带的特殊变量），
# 因为系统环境里可能已经存在 PRIVATE_KEY、APP_ID、ARGS 这类通用名字：make 的 `?=` 会直接
# 继承同名环境变量，于是 `make huawei-service-account` 会莫名其妙地带上 --private-key。
#
# 可选变量（名字与命令读取的环境变量一致）：
#   HUAWEI_KID / HUAWEI_ISS
#                             等价于 service-account 的 --kid / --iss
#   HUAWEI_PRIVATE_KEY        私钥 PEM 文件路径，等价于 --private-key
#   HUAWEI_PRIVATE_KEY_DATA   私钥 PEM 数据，等价于 --private-key-data
#   HUAWEI_IAT                JWT 签发时间（UTC 秒级时间戳），等价于 service-account 的 --iat
#   HUAWEI_CLIENT_ID / HUAWEI_CLIENT_SECRET
#                             等价于 client-credentials 的 --client-id / --client-secret
#   HUAWEI_APP_ID / HUAWEI_FILE_NAME / HUAWEI_CONTENT_LENGTH
#                             等价于两个 *-upload-url 的 --app-id / --file-name / --content-length
#   HUAWEI_TOKEN              等价于两个 *-upload-url 的 --token（JWT 或 access_token）
#   HUAWEI_VERBOSE            等价于 --verbose：1/true/yes/on 开启日志，0/false/no/off 关闭
#   HUAWEI_ARGS               追加到命令末尾的额外参数，例如 HUAWEI_ARGS="--verbose"
#   （HUAWEI_API_BASE 只有环境变量形式，命令直接读取，不作变量转发）
#
# 转发规则：只有「make 命令行上显式传入」的变量才转成选项
#   make huawei-service-account HUAWEI_KID=xxx HUAWEI_PRIVATE_KEY=./private.pem
# 环境变量（包括 source .env 进来的）一律不转发，交给命令自己读取，原因有三：
#   1. 密钥不进命令行参数（ps 看不到），也不会被 make 回显到终端/CI 日志里；
#   2. 环境里的值不会被当成「显式选项」回传，避免旧变量残留时绕过程序内部的优先级判断；
#   3. make 命令行上给出的变量本来就会导出给子进程，所以 HUAWEI_VERBOSE / HUAWEI_API_BASE
#      这类不需要转发的变量照样生效（--verbose 是开关，转成 `--verbose "0"` 反而无法表达「关闭」）。
# 业务目标已用 @ 关闭命令回显，避免密钥打到日志里。
HUAWEI_KID ?=
HUAWEI_ISS ?=
HUAWEI_PRIVATE_KEY ?=
HUAWEI_PRIVATE_KEY_DATA ?=
HUAWEI_IAT ?=
HUAWEI_CLIENT_ID ?=
HUAWEI_CLIENT_SECRET ?=
HUAWEI_APP_ID ?=
HUAWEI_FILE_NAME ?=
HUAWEI_CONTENT_LENGTH ?=
HUAWEI_TOKEN ?=
HUAWEI_VERBOSE ?=
HUAWEI_ARGS ?=

# $(call huaweiOption,变量名,选项名)：仅当该变量来自 make 命令行时，展开成 `选项 "值"`；
# 来自环境变量的值不展开（$(origin) 会返回 environment），由命令自己读取。
huaweiOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")

# 组合 huawei service-account 的参数：命令行给哪个变量就转哪个选项，都不给则完全回退环境变量
# （HUAWEI_KID / HUAWEI_ISS / HUAWEI_PRIVATE_KEY / HUAWEI_PRIVATE_KEY_DATA / HUAWEI_IAT）
HUAWEI_SERVICE_ACCOUNT_ARGS = $(call huaweiOption,HUAWEI_KID,--kid) $(call huaweiOption,HUAWEI_ISS,--iss) $(call huaweiOption,HUAWEI_PRIVATE_KEY,--private-key) $(call huaweiOption,HUAWEI_PRIVATE_KEY_DATA,--private-key-data) $(call huaweiOption,HUAWEI_IAT,--iat)

# 两个 upload-url 命令共用的应用与文件参数（HUAWEI_APP_ID / HUAWEI_FILE_NAME / HUAWEI_CONTENT_LENGTH / HUAWEI_TOKEN）
HUAWEI_UPLOAD_FILE_ARGS = $(call huaweiOption,HUAWEI_APP_ID,--app-id) $(call huaweiOption,HUAWEI_FILE_NAME,--file-name) $(call huaweiOption,HUAWEI_CONTENT_LENGTH,--content-length) $(call huaweiOption,HUAWEI_TOKEN,--token)

# 组合 huawei service-account-upload-url 的参数：应用与文件参数在服务账号参数之前
HUAWEI_UPLOAD_URL_ARGS = $(HUAWEI_UPLOAD_FILE_ARGS) $(HUAWEI_SERVICE_ACCOUNT_ARGS)

# 组合 huawei client-credentials 的参数（HUAWEI_CLIENT_ID / HUAWEI_CLIENT_SECRET）
HUAWEI_CLIENT_CREDENTIALS_ARGS = $(call huaweiOption,HUAWEI_CLIENT_ID,--client-id) $(call huaweiOption,HUAWEI_CLIENT_SECRET,--client-secret)

# 组合 huawei client-credentials-upload-url 的参数：应用与文件参数在客户端参数之前
HUAWEI_CLIENT_CREDENTIALS_UPLOAD_URL_ARGS = $(HUAWEI_UPLOAD_FILE_ARGS) $(HUAWEI_CLIENT_CREDENTIALS_ARGS)

# Display help information with colored output
# Parses comments with '##' and formats them nicely
help: ## Show help information
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9._-]+:.*?## / {printf "\033[36m%-40s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# Mark targets as phony (not actual files)
.PHONY: help h \
	huawei-help \
	huawei-service-account-help huawei-service-account \
	huawei-service-account-upload-url-help huawei-service-account-upload-url \
	huawei-client-credentials-help huawei-client-credentials \
	huawei-client-credentials-upload-url-help huawei-client-credentials-upload-url \
	pack-check

h: ## 帮助文档
	node src/publish-apk.js

huawei-help: ## 华为 帮助文档
	node src/publish-apk.js huawei

huawei-service-account-help: ## 华为 Service Account JWT 帮助文档
	node src/publish-apk.js huawei service-account --help

huawei-service-account: ## 华为 Service Account JWT（HUAWEI_KID / HUAWEI_ISS / HUAWEI_PRIVATE_KEY[_DATA] / HUAWEI_IAT，HUAWEI_ARGS 追加参数，HUAWEI_VERBOSE 开启日志）
	@node src/publish-apk.js huawei service-account $(HUAWEI_SERVICE_ACCOUNT_ARGS) $(HUAWEI_ARGS)

huawei-service-account-upload-url-help: ## 华为 获取文件上传地址帮助文档
	node src/publish-apk.js huawei service-account-upload-url --help

huawei-service-account-upload-url: ## 华为 获取文件上传地址（HUAWEI_APP_ID / HUAWEI_FILE_NAME / HUAWEI_CONTENT_LENGTH，Token 同 service-account 含 HUAWEI_IAT）
	@node src/publish-apk.js huawei service-account-upload-url $(HUAWEI_UPLOAD_URL_ARGS) $(HUAWEI_ARGS)

huawei-client-credentials-help: ## 华为 获取 access_token 帮助文档
	node src/publish-apk.js huawei client-credentials --help

huawei-client-credentials: ## 华为 获取 access_token（HUAWEI_CLIENT_ID / HUAWEI_CLIENT_SECRET，HUAWEI_ARGS 追加参数，HUAWEI_VERBOSE 开启日志）
	@node src/publish-apk.js huawei client-credentials $(HUAWEI_CLIENT_CREDENTIALS_ARGS) $(HUAWEI_ARGS)

huawei-client-credentials-upload-url-help: ## 华为 获取文件上传地址（API 客户端）帮助文档
	node src/publish-apk.js huawei client-credentials-upload-url --help

huawei-client-credentials-upload-url: ## 华为 获取文件上传地址（API 客户端，HUAWEI_APP_ID / HUAWEI_FILE_NAME / HUAWEI_CONTENT_LENGTH，凭证同 client-credentials，HUAWEI_VERBOSE 开启日志）
	@node src/publish-apk.js huawei client-credentials-upload-url $(HUAWEI_CLIENT_CREDENTIALS_UPLOAD_URL_ARGS) $(HUAWEI_ARGS)

# ------------------------------------------------------------------ npm 发布物

# npm pack --dry-run 只打印「会打进包里的文件清单」，不会生成 .tgz，也不改动工作区，
# 因此可以作为发布前的检查项：确认 src 之外，package.json、README* 与 LICENSE* 也在包里。
# 注意 package.json 的 files 只写了 src，但 npm 永远会带上 package.json、README*、LICENSE*
# 以及 bin/main 指向的文件，所以这里不依赖 files 的写法，值得在发布前看一眼。
pack-check: ## 查看 npm 发布物内容（npm pack --dry-run，只打印清单、不生成 .tgz）
	npm pack --dry-run
