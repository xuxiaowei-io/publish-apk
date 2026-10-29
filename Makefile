# Set shell to bash for better compatibility
SHELL := /usr/bin/env bash

# Set default target when running 'make' without arguments
.DEFAULT_GOAL := help

# 本文件定义的变量一律以 HUAWEI_ / GOOGLE_ / CERT_ / PROFILE_ / HARMONY_ 开头（SHELL、MAKEFILE_LIST 等是 make 自带的特殊变量），
# 因为系统环境里可能已经存在 PRIVATE_KEY、APP_ID、ARGS 这类通用名字：make 的 `?=` 会直接
# 继承同名环境变量，于是 `make huawei-service-account` 会莫名其妙地带上 --private-key。
#
# 华为可选变量（名字与命令读取的环境变量一致）：
#   HUAWEI_KID / HUAWEI_ISS
#                             等价于 service-account 的 --kid / --iss
#   HUAWEI_PRIVATE_KEY        私钥 PEM 文件路径，等价于 --private-key
#   HUAWEI_PRIVATE_KEY_DATA   私钥 PEM 数据，等价于 --private-key-data
#   HUAWEI_IAT                JWT 签发时间（UTC 秒级时间戳），等价于 service-account 的 --iat
#   HUAWEI_CLIENT_ID / HUAWEI_CLIENT_SECRET
#                             等价于 client-credentials 的 --client-id / --client-secret
#   HUAWEI_APP_ID / HUAWEI_FILE_NAME / HUAWEI_CONTENT_LENGTH
#                             等价于上传类命令的 --app-id / --file-name / --content-length
#   HUAWEI_FILE               本地文件路径，等价于上传类命令的 --file：
#                             *-upload-url 用它补 --file-name 与 --content-length
#                             *-upload-file 只支持这种写法（必须给出本地文件）
#   HUAWEI_TOKEN              等价于上传类命令的 --token（JWT 或 access_token）
#   HUAWEI_OBJECT_ID          等价于 *-upload-file-package-info-update 的 --object-id
#                             （给出后跳过上传，只做登记；不给则由命令自己上传）
#   HUAWEI_RELEASE_TYPE / HUAWEI_RELEASE_PHASE
#                             等价于 *-upload-file-package-info-update 的 --release-type / --release-phase
#                             （取值范围随安装包后缀不同：.app 用 1/7 与 0/3；.apk 等用 1/3，没有 release-phase）
#   HUAWEI_VERBOSE            等价于 --verbose：1/true/yes/on 开启日志，0/false/no/off 关闭
#   HUAWEI_ARGS               追加到命令末尾的额外参数，例如 HUAWEI_ARGS="--verbose"
#   （HUAWEI_API_BASE 只有环境变量形式，命令直接读取，不作变量转发）
#
# Google Play 可选变量（名字与命令读取的环境变量一致）：
#   GOOGLE_PACKAGE_NAME       等价于 upload-aab 的 --package-name
#   GOOGLE_FILE               .aab 文件路径，等价于 --file
#   GOOGLE_SERVICE_ACCOUNT    服务账号 JSON 文件路径，等价于 --service-account
#   GOOGLE_SERVICE_ACCOUNT_DATA
#                             服务账号 JSON 数据，等价于 --service-account-data；
#                             JSON 含双引号，**不作选项转发**，由 make 导出为环境变量后命令自行读取
#   GOOGLE_CLIENT_EMAIL       服务账号 JSON 的 client_email，等价于 --client-email
#   GOOGLE_PRIVATE_KEY        私钥 PEM 文件路径，等价于 --private-key
#   GOOGLE_PRIVATE_KEY_DATA   私钥 PEM 数据，等价于 --private-key-data；
#                             多行 PEM **不作选项转发**，由 make 导出为环境变量后命令自行读取
#   GOOGLE_TOKEN              access_token，等价于 --token
#   GOOGLE_TRACK              轨道名，等价于 --track（不给则只上传 bundle）
#   GOOGLE_RELEASE_STATUS / GOOGLE_RELEASE_NAME / GOOGLE_RELEASE_NOTES
#   GOOGLE_RELEASE_NOTES_LANGUAGE / GOOGLE_USER_FRACTION
#                             等价于 upload-aab 的同名选项
#   GOOGLE_CHANGES_NOT_SENT_FOR_REVIEW
#                             等价于 --changes-not-sent-for-review（托管发布时留待人工送审）
#   GOOGLE_VERBOSE            等价于 --verbose：1/true/yes/on 开启日志，0/false/no/off 关闭
#   GOOGLE_ARGS               追加到命令末尾的额外参数，例如 GOOGLE_ARGS="--verbose"
#   （GOOGLE_TOKEN_URI / GOOGLE_API_BASE 只有环境变量形式，命令直接读取，不作变量转发；
#     GOOGLE_TOKEN_URI 虽然也有 --token-uri 选项，但从 make 传值容易出现引号问题，统一走环境变量）
#
# 证书查看可选变量（与厂商无关）：
#   CERT_FILE     证书 / PKCS#12 文件路径，等价于 cert 的 --file（必填，没有默认文件）
#   CERT_PASSWORD PKCS#12 密钥库密码；只经环境变量传给子进程，**不作选项转发**
#                 （密码不进入命令行参数；也可用 cert 的 --password，但不推荐）
#   CERT_VERBOSE  等价于 --verbose：1/true/yes/on 输出全部字段，0/false/no/off 关闭
#   CERT_ARGS     追加到 cert 命令末尾的额外参数，例如 CERT_ARGS="--verbose"
#
# P7B Profile 查看可选变量（与厂商无关）：
#   PROFILE_FILE      P7B 文件路径，等价于 profile 的 --file（必填，没有默认文件）
#   PROFILE_VERBOSE   等价于 --verbose：1/true/yes/on 输出全部字段，0/false/no/off 关闭
#   PROFILE_ARGS      追加到 profile 命令末尾的额外参数，例如 PROFILE_ARGS="--verbose"
#
# HAP 安装包查看可选变量（与厂商无关）：
#   HAP_FILE      HAP 文件路径，等价于 hap 的 --file（必填，没有默认文件）
#   HAP_VERBOSE   等价于 --verbose：1/true/yes/on 输出全部字段，0/false/no/off 关闭
#   HAP_ARGS      追加到 hap 命令末尾的额外参数，例如 HAP_ARGS="--verbose"
#
# APP 安装包查看可选变量（与厂商无关）：
#   APP_FILE      APP 文件路径，等价于 app 的 --file（必填，没有默认文件）
#   APP_VERBOSE   等价于 --verbose：1/true/yes/on 输出全部字段，0/false/no/off 关闭
#   APP_ARGS      追加到 app 命令末尾的额外参数，例如 APP_ARGS="--verbose"
#
# APK 安装包查看可选变量（与厂商无关）：
#   APK_FILE      APK 文件路径，等价于 apk 的 --file（必填，没有默认文件）
#   APK_VERBOSE   等价于 --verbose：1/true/yes/on 输出全部字段，0/false/no/off 关闭
#   APK_ARGS      追加到 apk 命令末尾的额外参数，例如 APK_ARGS="--verbose"
#
# AAB 安装包查看可选变量（与厂商无关）：
#   AAB_FILE      AAB 文件路径，等价于 aab 的 --file（必填，没有默认文件）
#   AAB_VERBOSE   等价于 --verbose：1/true/yes/on 输出全部字段，0/false/no/off 关闭
#   AAB_ARGS      追加到 aab 命令末尾的额外参数，例如 AAB_ARGS="--verbose"
#
# 鸿蒙签名配置可选变量（与命令读取的 HARMONY_* 环境变量同名）：
#   HARMONY_STORE_FILE / HARMONY_PROFILE
#                     p12 / p7b 路径；两者也接受 BASE64，等价于 --store-file / --profile
#   HARMONY_STORE_FILE_OUT / HARMONY_PROFILE_OUT
#                     p12 / p7b 内容/复制目标，等价于 --store-file-out / --profile-out
#   HARMONY_CERTPATH  证书 .cer 路径，或 PEM 内容 / BASE64（内容含换行时建议用环境变量传入）
#   HARMONY_CERTPATH_OUT
#                     证书内容/复制目标，等价于 --certpath-out（默认 .p12 同级 certpath.cer）
#   HARMONY_KEY_ALIAS 密钥别名，等价于 --key-alias（不传时用 keytool 自动识别）
#   HARMONY_SIGN_ALG  签名算法，等价于 --sign-alg，默认 SHA256withECDSA
#   HARMONY_CONFIG    build-profile.json5 路径，等价于 --config
#   HARMONY_SIGNING_NAME / HARMONY_PRODUCT
#                     等价于 --name / --product
#   HARMONY_STORE_PASSWORD / HARMONY_KEY_PASSWORD
#                     明文口令；只走环境变量或交互输入，**不作选项转发**（密码不进命令行）
#   HARMONY_VERBOSE   等价于 --verbose：输出 .p12 / .cer / .p7b 全部字段
#   HARMONY_ARGS      追加到 signing-config 命令末尾的额外参数，例如 HARMONY_ARGS="--write"
#
# 转发规则：只有「make 命令行上显式传入」的变量才转成选项
#   make huawei-service-account HUAWEI_KID=xxx HUAWEI_PRIVATE_KEY=./private.pem
#   make google-upload-aab GOOGLE_PACKAGE_NAME=com.example.app GOOGLE_TRACK=internal
# 环境变量（包括 source .env 进来的）一律不转发，交给命令自己读取，原因有三：
#   1. 密钥不进命令行参数（ps 看不到），也不会被 make 回显到终端/CI 日志里；
#   2. 环境里的值不会被当成「显式选项」回传，避免旧变量残留时绕过程序内部的优先级判断；
#   3. make 命令行上给出的变量本来就会导出给子进程，所以 HUAWEI_VERBOSE / HUAWEI_API_BASE
#      这类不需要转发的变量照样生效（--verbose 是开关，转成 `--verbose "0"` 反而无法表达「关闭」）。
# 业务目标已用 @ 关闭命令回显，避免密钥打到日志里。
#
# Android keystore 校验可选变量（命令与 CI 读同名 ANDROID_* 环境变量）：
#   ANDROID_KEYSTORE_BASE64   密钥库的 BASE64 内容，等价于 --base64
#   ANDROID_KEYSTORE_FILE     密钥库路径，等价于 --file（ANDROID_KEYSTORE 也可）
#   ANDROID_KEY_ALIAS         私钥别名，等价于 --key-alias
#   ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_PASSWORD
#                             明文口令；只走环境变量或交互输入，**不作选项转发**（密码不进命令行）
#   ANDROID_KEYSTORE_ARGS     追加到 keystore 命令末尾的额外参数
#
#   与 --base64 / ANDROID_KEYSTORE_BASE64 同用时，ANDROID_KEYSTORE_FILE 是**输出**路径：
#   校验通过后把解码出来的密钥库原文写进去；只给 BASE64 时用临时文件校验，不落盘。
HUAWEI_KID ?=
HUAWEI_ISS ?=
HUAWEI_PRIVATE_KEY ?=
HUAWEI_PRIVATE_KEY_DATA ?=
HUAWEI_IAT ?=
HUAWEI_CLIENT_ID ?=
HUAWEI_CLIENT_SECRET ?=
HUAWEI_APP_ID ?=
HUAWEI_FILE ?=
HUAWEI_FILE_NAME ?=
HUAWEI_CONTENT_LENGTH ?=
HUAWEI_TOKEN ?=
HUAWEI_OBJECT_ID ?=
HUAWEI_RELEASE_TYPE ?=
HUAWEI_RELEASE_PHASE ?=
HUAWEI_VERBOSE ?=
HUAWEI_ARGS ?=
GOOGLE_PACKAGE_NAME ?=
GOOGLE_FILE ?=
GOOGLE_SERVICE_ACCOUNT ?=
GOOGLE_SERVICE_ACCOUNT_DATA ?=
GOOGLE_CLIENT_EMAIL ?=
GOOGLE_PRIVATE_KEY ?=
GOOGLE_PRIVATE_KEY_DATA ?=
GOOGLE_TOKEN ?=
GOOGLE_TRACK ?=
GOOGLE_RELEASE_STATUS ?=
GOOGLE_RELEASE_NAME ?=
GOOGLE_RELEASE_NOTES ?=
GOOGLE_RELEASE_NOTES_LANGUAGE ?=
GOOGLE_USER_FRACTION ?=
GOOGLE_CHANGES_NOT_SENT_FOR_REVIEW ?=
GOOGLE_VERBOSE ?=
GOOGLE_ARGS ?=
CERT_FILE ?=
CERT_PASSWORD ?=
CERT_VERBOSE ?=
CERT_ARGS ?=
PROFILE_FILE ?=
PROFILE_VERBOSE ?=
PROFILE_ARGS ?=
HAP_FILE ?=
HAP_VERBOSE ?=
HAP_ARGS ?=
APP_FILE ?=
APP_VERBOSE ?=
APP_ARGS ?=
APK_FILE ?=
APK_VERBOSE ?=
APK_ARGS ?=
AAB_FILE ?=
AAB_VERBOSE ?=
AAB_ARGS ?=
ANDROID_KEYSTORE_BASE64 ?=
ANDROID_KEYSTORE_FILE ?=
ANDROID_KEY_ALIAS ?=
ANDROID_KEYSTORE_PASSWORD ?=
ANDROID_KEY_PASSWORD ?=
KEYSTORE_ARGS ?=
HARMONY_STORE_FILE ?=
HARMONY_STORE_FILE_OUT ?=
HARMONY_CERTPATH ?=
HARMONY_CERTPATH_OUT ?=
HARMONY_PROFILE ?=
HARMONY_PROFILE_OUT ?=
HARMONY_KEY_ALIAS ?=
HARMONY_SIGN_ALG ?=
HARMONY_CONFIG ?=
HARMONY_SIGNING_NAME ?=
HARMONY_PRODUCT ?=
HARMONY_ARGS ?=

# $(call huaweiOption,变量名,选项名)：仅当该变量来自 make 命令行时，展开成 `选项 "值"`；
# 来自环境变量的值不展开（$(origin) 会返回 environment），由命令自己读取。
huaweiOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")

# Google 变量使用同一套转发规则
googleOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")

# 证书查看变量使用同一套转发规则
certOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")

# P7B Profile 变量使用同一套转发规则
profileOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")

# HAP 变量使用同一套转发规则
hapOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")

# APP 变量使用同一套转发规则
appOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")

# APK 变量使用同一套转发规则
apkOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")

# AAB 变量使用同一套转发规则
aabOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")

# 鸿蒙签名配置变量使用同一套转发规则（口令不在其中：只走环境变量或交互输入）
harmonyOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")

# 组合 signing-config 的参数
HARMONY_SIGNING_ARGS = $(call harmonyOption,HARMONY_STORE_FILE,--store-file) $(call harmonyOption,HARMONY_STORE_FILE_OUT,--store-file-out) $(call harmonyOption,HARMONY_CERTPATH,--certpath) $(call harmonyOption,HARMONY_CERTPATH_OUT,--certpath-out) $(call harmonyOption,HARMONY_PROFILE,--profile) $(call harmonyOption,HARMONY_PROFILE_OUT,--profile-out) $(call harmonyOption,HARMONY_KEY_ALIAS,--key-alias) $(call harmonyOption,HARMONY_SIGN_ALG,--sign-alg) $(call harmonyOption,HARMONY_CONFIG,--config) $(call harmonyOption,HARMONY_SIGNING_NAME,--name) $(call harmonyOption,HARMONY_PRODUCT,--product)

# 组合 cert 的参数：CERT_FILE 只在 make 命令行给出时转成 --file；
# --verbose 是开关，由命令读取 CERT_VERBOSE（转成 `--verbose "0"` 无法表达「关闭」）
CERT_FILE_ARGS = $(call certOption,CERT_FILE,--file)

# 组合 profile 的参数：PROFILE_FILE 只在 make 命令行给出时转成 --file
PROFILE_FILE_ARGS = $(call profileOption,PROFILE_FILE,--file)

# 组合 hap 的参数：HAP_FILE 只在 make 命令行给出时转成 --file
HAP_FILE_ARGS = $(call hapOption,HAP_FILE,--file)

# 组合 app 的参数：APP_FILE 只在 make 命令行给出时转成 --file
APP_FILE_ARGS = $(call appOption,APP_FILE,--file)

# 组合 apk 的参数：APK_FILE 只在 make 命令行给出时转成 --file
APK_FILE_ARGS = $(call apkOption,APK_FILE,--file)

# 组合 aab 的参数：AAB_FILE 只在 make 命令行给出时转成 --file
AAB_FILE_ARGS = $(call aabOption,AAB_FILE,--file)

# keystore 变量使用同一套转发规则；BASE64 与两个口令不转发（由命令读环境变量）
keystoreOption = $(if $(filter command line,$(origin $(1))),$(2) "$($(1))")
KEYSTORE_FILE_ARGS = $(call keystoreOption,ANDROID_KEYSTORE_FILE,--file) $(call keystoreOption,ANDROID_KEY_ALIAS,--key-alias)

# 组合 huawei service-account 的参数：命令行给哪个变量就转哪个选项，都不给则完全回退环境变量
# （HUAWEI_KID / HUAWEI_ISS / HUAWEI_PRIVATE_KEY / HUAWEI_PRIVATE_KEY_DATA / HUAWEI_IAT）
HUAWEI_SERVICE_ACCOUNT_ARGS = $(call huaweiOption,HUAWEI_KID,--kid) $(call huaweiOption,HUAWEI_ISS,--iss) $(call huaweiOption,HUAWEI_PRIVATE_KEY,--private-key) $(call huaweiOption,HUAWEI_PRIVATE_KEY_DATA,--private-key-data) $(call huaweiOption,HUAWEI_IAT,--iat)

# 四个上传类命令（*-upload-url 与 *-upload-file）共用的应用与文件参数
# （HUAWEI_APP_ID / HUAWEI_FILE / HUAWEI_FILE_NAME / HUAWEI_CONTENT_LENGTH / HUAWEI_TOKEN）
HUAWEI_UPLOAD_FILE_ARGS = $(call huaweiOption,HUAWEI_APP_ID,--app-id) $(call huaweiOption,HUAWEI_FILE,--file) $(call huaweiOption,HUAWEI_FILE_NAME,--file-name) $(call huaweiOption,HUAWEI_CONTENT_LENGTH,--content-length) $(call huaweiOption,HUAWEI_TOKEN,--token)

# 组合 huawei service-account-upload-url 的参数：应用与文件参数在服务账号参数之前
HUAWEI_UPLOAD_URL_ARGS = $(HUAWEI_UPLOAD_FILE_ARGS) $(HUAWEI_SERVICE_ACCOUNT_ARGS)

# 组合 huawei client-credentials 的参数（HUAWEI_CLIENT_ID / HUAWEI_CLIENT_SECRET）
HUAWEI_CLIENT_CREDENTIALS_ARGS = $(call huaweiOption,HUAWEI_CLIENT_ID,--client-id) $(call huaweiOption,HUAWEI_CLIENT_SECRET,--client-secret)

# 组合 huawei client-credentials-upload-url 的参数：应用与文件参数在客户端参数之前
HUAWEI_CLIENT_CREDENTIALS_UPLOAD_URL_ARGS = $(HUAWEI_UPLOAD_FILE_ARGS) $(HUAWEI_CLIENT_CREDENTIALS_ARGS)

# 两个 package-info-update 命令共用的登记参数
# （HUAWEI_APP_ID / HUAWEI_FILE_NAME / HUAWEI_OBJECT_ID / HUAWEI_RELEASE_TYPE / HUAWEI_RELEASE_PHASE / HUAWEI_TOKEN）
HUAWEI_PACKAGE_INFO_ARGS = $(call huaweiOption,HUAWEI_APP_ID,--app-id) $(call huaweiOption,HUAWEI_FILE_NAME,--file-name) $(call huaweiOption,HUAWEI_OBJECT_ID,--object-id) $(call huaweiOption,HUAWEI_RELEASE_TYPE,--release-type) $(call huaweiOption,HUAWEI_RELEASE_PHASE,--release-phase) $(call huaweiOption,HUAWEI_TOKEN,--token)

# 组合 huawei service-account-upload-file-package-info-update 的参数
# （未给 HUAWEI_OBJECT_ID 时要自己上传，所以还要带 --file：复用 HUAWEI_UPLOAD_FILE_ARGS 里的 --file）
HUAWEI_SERVICE_ACCOUNT_UPLOAD_FILE_PACKAGE_INFO_ARGS = $(HUAWEI_PACKAGE_INFO_ARGS) $(call huaweiOption,HUAWEI_FILE,--file) $(HUAWEI_SERVICE_ACCOUNT_ARGS)

# 组合 huawei client-credentials-upload-file-package-info-update 的参数
HUAWEI_CLIENT_CREDENTIALS_UPLOAD_FILE_PACKAGE_INFO_ARGS = $(HUAWEI_PACKAGE_INFO_ARGS) $(call huaweiOption,HUAWEI_FILE,--file) $(HUAWEI_CLIENT_CREDENTIALS_ARGS)

# 组合 google 服务账号凭据的参数：完整 JSON 或分项字段二选一。
# GOOGLE_SERVICE_ACCOUNT_DATA / GOOGLE_PRIVATE_KEY_DATA 含双引号或多行 PEM，
# 只经环境变量传入（make 命令行变量会导出给子进程），见文件头的说明。
GOOGLE_CREDENTIALS_ARGS = $(call googleOption,GOOGLE_SERVICE_ACCOUNT,--service-account) $(call googleOption,GOOGLE_CLIENT_EMAIL,--client-email) $(call googleOption,GOOGLE_PRIVATE_KEY,--private-key)

# 组合 google access-token 的参数
GOOGLE_ACCESS_TOKEN_ARGS = $(GOOGLE_CREDENTIALS_ARGS)

# 组合 google upload-aab 的参数
# （GOOGLE_PACKAGE_NAME / GOOGLE_FILE / 服务账号凭据 / GOOGLE_TOKEN / GOOGLE_TRACK /
#   GOOGLE_RELEASE_STATUS / GOOGLE_RELEASE_NAME / GOOGLE_RELEASE_NOTES /
#   GOOGLE_RELEASE_NOTES_LANGUAGE / GOOGLE_USER_FRACTION）
GOOGLE_UPLOAD_AAB_ARGS = $(call googleOption,GOOGLE_PACKAGE_NAME,--package-name) $(call googleOption,GOOGLE_FILE,--file) $(GOOGLE_CREDENTIALS_ARGS) $(call googleOption,GOOGLE_TOKEN,--token) $(call googleOption,GOOGLE_TRACK,--track) $(call googleOption,GOOGLE_RELEASE_STATUS,--release-status) $(call googleOption,GOOGLE_RELEASE_NAME,--release-name) $(call googleOption,GOOGLE_RELEASE_NOTES,--release-notes) $(call googleOption,GOOGLE_RELEASE_NOTES_LANGUAGE,--release-notes-language) $(call googleOption,GOOGLE_USER_FRACTION,--user-fraction)

# Display help information with colored output
# Parses comments with '##' and formats them nicely
help: ## Show help information
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9._-]+:.*?## / {printf "\033[36m%-70s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# Mark targets as phony (not actual files)
.PHONY: help h \
	cert-help cert \
	keystore-help keystore \
	profile-help profile \
	huawei-help \
	huawei-signing-config-help huawei-signing-config \
	huawei-service-account-help huawei-service-account \
	huawei-service-account-upload-url-help huawei-service-account-upload-url \
	huawei-service-account-upload-file-help huawei-service-account-upload-file \
	huawei-service-account-upload-file-package-info-update-help huawei-service-account-upload-file-package-info-update \
	huawei-client-credentials-help huawei-client-credentials \
	huawei-client-credentials-upload-url-help huawei-client-credentials-upload-url \
	huawei-client-credentials-upload-file-help huawei-client-credentials-upload-file \
	huawei-client-credentials-upload-file-package-info-update-help huawei-client-credentials-upload-file-package-info-update \
	google-help \
	google-access-token-help google-access-token \
	google-upload-aab-help google-upload-aab \
	pack-check

h: ## 帮助文档
	node src/publish-apk.js

# ---------------------------------------------------------------- 证书查看

cert-help: ## 查看证书 / PKCS#12 密钥库帮助文档
	node src/publish-apk.js cert --help

cert: ## 查看证书 / PKCS#12 密钥库信息（CERT_FILE 必填；CERT_PASSWORD 传 PKCS#12 密码；CERT_VERBOSE 输出全部字段）
	@node src/publish-apk.js cert $(CERT_FILE_ARGS) $(CERT_ARGS)

# ---------------------------------------------------------------- P7B Profile

profile-help: ## 查看 P7B Provisioning Profile 帮助文档
	node src/publish-apk.js profile --help

profile: ## 查看 P7B Provisioning Profile（PROFILE_FILE 必填；PROFILE_VERBOSE 输出全部字段）
	@node src/publish-apk.js profile $(PROFILE_FILE_ARGS) $(PROFILE_ARGS)

# ---------------------------------------------------------------- HAP 安装包

hap-help: ## 查看 HAP 安装包帮助文档
	node src/publish-apk.js hap --help

hap: ## 查看 HAP 安装包信息（HAP_FILE 必填；HAP_VERBOSE 输出全部字段）
	@node src/publish-apk.js hap $(HAP_FILE_ARGS) $(HAP_ARGS)

app-help: ## 查看 APP 安装包帮助文档
	node src/publish-apk.js app --help

app: ## 查看 APP 安装包信息（APP_FILE 必填；APP_VERBOSE 输出全部字段）
	@node src/publish-apk.js app $(APP_FILE_ARGS) $(APP_ARGS)

apk-help: ## 查看 APK 安装包帮助文档
	node src/publish-apk.js apk --help

apk: ## 查看 APK 安装包信息（APK_FILE 必填；APK_VERBOSE 输出全部字段）
	@node src/publish-apk.js apk $(APK_FILE_ARGS) $(APK_ARGS)

aab-help: ## 查看 AAB 安装包帮助文档
	node src/publish-apk.js aab --help

aab: ## 查看 AAB 安装包信息（AAB_FILE 必填；AAB_VERBOSE 输出全部字段）
	@node src/publish-apk.js aab $(AAB_FILE_ARGS) $(AAB_ARGS)

# ------------------------------------------------------- Android keystore

keystore-help: ## 校验 Android 签名密钥库帮助文档
	node src/publish-apk.js keystore --help

keystore: ## 校验 Android 签名密钥库（ANDROID_KEYSTORE_FILE / ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS；BASE64 + FILE 时先落盘）
	@node src/publish-apk.js keystore $(KEYSTORE_FILE_ARGS) $(KEYSTORE_ARGS)

# ------------------------------------------------------------------- 华为

huawei-help: ## 华为 帮助文档
	node src/publish-apk.js huawei

huawei-service-account-help: ## 华为 Service Account JWT 帮助文档
	node src/publish-apk.js huawei service-account --help

huawei-service-account: ## 华为 Service Account JWT（HUAWEI_KID / HUAWEI_ISS / HUAWEI_PRIVATE_KEY[_DATA] / HUAWEI_IAT，HUAWEI_ARGS 追加参数，HUAWEI_VERBOSE 开启日志）
	@node src/publish-apk.js huawei service-account $(HUAWEI_SERVICE_ACCOUNT_ARGS) $(HUAWEI_ARGS)

huawei-service-account-upload-url-help: ## 华为 获取文件上传地址帮助文档
	node src/publish-apk.js huawei service-account-upload-url --help

huawei-service-account-upload-url: ## 华为 获取文件上传地址（HUAWEI_APP_ID，文件用 HUAWEI_FILE 或 HUAWEI_FILE_NAME+HUAWEI_CONTENT_LENGTH，Token 同 service-account 含 HUAWEI_IAT）
	@node src/publish-apk.js huawei service-account-upload-url $(HUAWEI_UPLOAD_URL_ARGS) $(HUAWEI_ARGS)

huawei-service-account-upload-file-help: ## 华为 上传文件帮助文档
	node src/publish-apk.js huawei service-account-upload-file --help

huawei-service-account-upload-file: ## 华为 上传文件（HUAWEI_APP_ID / HUAWEI_FILE 必填，Token 同 service-account 含 HUAWEI_IAT，输出 objectId）
	@node src/publish-apk.js huawei service-account-upload-file $(HUAWEI_UPLOAD_URL_ARGS) $(HUAWEI_ARGS)

huawei-client-credentials-help: ## 华为 获取 access_token 帮助文档
	node src/publish-apk.js huawei client-credentials --help

huawei-client-credentials: ## 华为 获取 access_token（HUAWEI_CLIENT_ID / HUAWEI_CLIENT_SECRET，HUAWEI_ARGS 追加参数，HUAWEI_VERBOSE 开启日志）
	@node src/publish-apk.js huawei client-credentials $(HUAWEI_CLIENT_CREDENTIALS_ARGS) $(HUAWEI_ARGS)

huawei-client-credentials-upload-url-help: ## 华为 获取文件上传地址（API 客户端）帮助文档
	node src/publish-apk.js huawei client-credentials-upload-url --help

huawei-client-credentials-upload-url: ## 华为 获取文件上传地址（API 客户端，HUAWEI_APP_ID，文件用 HUAWEI_FILE 或 HUAWEI_FILE_NAME+HUAWEI_CONTENT_LENGTH，凭证同 client-credentials，HUAWEI_VERBOSE 开启日志）
	@node src/publish-apk.js huawei client-credentials-upload-url $(HUAWEI_CLIENT_CREDENTIALS_UPLOAD_URL_ARGS) $(HUAWEI_ARGS)

huawei-client-credentials-upload-file-help: ## 华为 上传文件（API 客户端）帮助文档
	node src/publish-apk.js huawei client-credentials-upload-file --help

huawei-client-credentials-upload-file: ## 华为 上传文件（API 客户端，HUAWEI_APP_ID / HUAWEI_FILE 必填，凭证同 client-credentials，输出 objectId）
	@node src/publish-apk.js huawei client-credentials-upload-file $(HUAWEI_CLIENT_CREDENTIALS_UPLOAD_URL_ARGS) $(HUAWEI_ARGS)

huawei-service-account-upload-file-package-info-update-help: ## 华为 上传文件并登记软件包帮助文档
	node src/publish-apk.js huawei service-account-upload-file-package-info-update --help

huawei-service-account-upload-file-package-info-update: ## 华为 上传文件并登记软件包（HUAWEI_APP_ID / HUAWEI_FILE_NAME 必填；未给 HUAWEI_OBJECT_ID 时自己上传，要 HUAWEI_FILE；输出 objectId）
	@node src/publish-apk.js huawei service-account-upload-file-package-info-update $(HUAWEI_SERVICE_ACCOUNT_UPLOAD_FILE_PACKAGE_INFO_ARGS) $(HUAWEI_ARGS)

huawei-client-credentials-upload-file-package-info-update-help: ## 华为 上传文件并登记软件包（API 客户端）帮助文档
	node src/publish-apk.js huawei client-credentials-upload-file-package-info-update --help

huawei-client-credentials-upload-file-package-info-update: ## 华为 上传文件并登记软件包（API 客户端，HUAWEI_APP_ID / HUAWEI_FILE_NAME 必填；未给 HUAWEI_OBJECT_ID 时自己上传，要 HUAWEI_FILE；输出 objectId）
	@node src/publish-apk.js huawei client-credentials-upload-file-package-info-update $(HUAWEI_CLIENT_CREDENTIALS_UPLOAD_FILE_PACKAGE_INFO_ARGS) $(HUAWEI_ARGS)

huawei-signing-config-help: ## 华为 生成鸿蒙 build-profile.json5 签名配置帮助文档
	node src/publish-apk.js huawei signing-config --help

huawei-signing-config: ## 华为 生成鸿蒙 build-profile.json5 签名配置（HARMONY_STORE_FILE / HARMONY_CERTPATH / HARMONY_PROFILE 必填，p12 / p7b 可用 BASE64；口令用 HARMONY_STORE_PASSWORD；HARMONY_ARGS 追加 --write 等）
	@node src/publish-apk.js huawei signing-config $(HARMONY_SIGNING_ARGS) $(HARMONY_ARGS)

# ------------------------------------------------------------- Google Play

google-help: ## Google Play 帮助文档
	node src/publish-apk.js google

google-access-token-help: ## Google Play 获取 access_token 帮助文档
	node src/publish-apk.js google access-token --help

google-access-token: ## Google Play 获取 access_token（完整 JSON 用 GOOGLE_SERVICE_ACCOUNT[_DATA]，分项用 GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY[_DATA]，GOOGLE_ARGS 追加参数）
	@node src/publish-apk.js google access-token $(GOOGLE_ACCESS_TOKEN_ARGS) $(GOOGLE_ARGS)

google-upload-aab-help: ## Google Play 上传 .aab 帮助文档
	node src/publish-apk.js google upload-aab --help

google-upload-aab: ## Google Play 上传 .aab（GOOGLE_PACKAGE_NAME / GOOGLE_FILE 必填，凭证用完整 JSON、分项字段或 GOOGLE_TOKEN，GOOGLE_TRACK 发布到轨道，输出 versionCode）
	@node src/publish-apk.js google upload-aab $(GOOGLE_UPLOAD_AAB_ARGS) $(GOOGLE_ARGS)

# ------------------------------------------------------------------ npm 发布物

# npm pack --dry-run 只打印「会打进包里的文件清单」，不会生成 .tgz，也不改动工作区，
# 因此可以作为发布前的检查项：确认 src 之外，package.json、README* 与 LICENSE* 也在包里。
# 注意 package.json 的 files 只写了 src，但 npm 永远会带上 package.json、README*、LICENSE*
# 以及 bin/main 指向的文件，所以这里不依赖 files 的写法，值得在发布前看一眼。
pack-check: ## 查看 npm 发布物内容（npm pack --dry-run，只打印清单、不生成 .tgz）
	npm pack --dry-run
