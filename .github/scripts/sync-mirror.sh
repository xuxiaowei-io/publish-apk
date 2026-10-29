#!/usr/bin/env bash
#
# 把源仓库的所有分支与所有标签镜像到目标仓库。
#
# 用法：
#   sync-mirror.sh <源仓库 URL> <目标仓库 URL>
#
# 环境变量：
#   SOURCE_TOKEN     源仓库访问令牌；用于 GitHub 时用户名固定为 x-access-token
#   TARGET_USERNAME  目标平台用户名（CNB 固定为 cnb）
#   TARGET_TOKEN     目标平台访问令牌
#   TARGET_NAME      目标平台名称，仅用于日志
#
# 行为：
#   1. 镜像克隆源仓库，一次拿到 refs/heads/* 与 refs/tags/*
#   2. 强制推送全部分支与标签（上游 rebase/amend 后也能对齐）
#   3. 删除目标上多出的分支与标签（上游已删除），目标默认分支除外
#
# 令牌只放在 Authorization 请求头里，不写进 URL、remote 配置或日志。

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "用法: $0 <源仓库 URL> <目标仓库 URL>" >&2
  exit 2
fi

source_url="$1"
target_url="$2"
target_name="${TARGET_NAME:-target}"

if [ -z "${TARGET_TOKEN:-}" ]; then
  echo "缺少 ${target_name} 的访问令牌（TARGET_TOKEN）" >&2
  exit 1
fi
if [ -z "${TARGET_USERNAME:-}" ]; then
  echo "缺少 ${target_name} 的用户名（TARGET_USERNAME）" >&2
  exit 1
fi

basic_auth() {
  printf '%s:%s' "$1" "$2" | base64 | tr -d '\n'
}

source_auth="$(basic_auth x-access-token "${SOURCE_TOKEN:-}")"
target_auth="$(basic_auth "$TARGET_USERNAME" "$TARGET_TOKEN")"

# 每次运行使用独立目录，避免并发运行时互相覆盖
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
mirror="$workdir/source.git"

# 镜像克隆：只有 refs/heads/* 与 refs/tags/*，不会出现 refs/remotes/origin/HEAD 之类的干扰项
# 没有源令牌时匿名克隆，避免把空口令的 Authorization 头发给公开仓库
if [ -n "${SOURCE_TOKEN:-}" ]; then
  git -c "http.extraHeader=Authorization: Basic ${source_auth}" \
    clone --mirror --quiet "$source_url" "$mirror"
else
  git clone --mirror --quiet "$source_url" "$mirror"
fi

# 目标仓库的默认分支不删除：平台通常禁止删除默认分支，删除也会改变仓库入口
# awk 不提前 exit，避免 ls-remote 写到已关闭的管道而触发 SIGPIPE
default_ref="$(
  git -c "http.extraHeader=Authorization: Basic ${target_auth}" \
    ls-remote --symref "$target_url" HEAD |
    awk '/^ref:/ { print $2 }'
)"

# 全部分支、全部标签一次推送；--force 让被 rebase/amend 过的分支也能对齐
git -c "http.extraHeader=Authorization: Basic ${target_auth}" \
  -C "$mirror" push --quiet --force "$target_url" \
  'refs/heads/*:refs/heads/*' \
  'refs/tags/*:refs/tags/*'

# 目标上多出的 ref：上游已删除的分支/标签，同步删除（默认分支除外）
stale=()
while IFS=$'\t' read -r _sha ref; do
  [ -n "$ref" ] || continue
  case "$ref" in *'^{}') continue ;; esac   # 附注标签会多出一行 peel 记录
  if [ "$ref" = "$default_ref" ]; then
    continue
  fi
  if git -C "$mirror" show-ref --verify --quiet "$ref"; then
    continue
  fi
  stale+=("$ref")
done < <(git -c "http.extraHeader=Authorization: Basic ${target_auth}" \
           ls-remote --heads --tags "$target_url")

if [ "${#stale[@]}" -gt 0 ]; then
  printf '删除 %s 上多余的 ref：%s\n' "$target_name" "${stale[*]}"
  git -c "http.extraHeader=Authorization: Basic ${target_auth}" \
    -C "$mirror" push --quiet "$target_url" --delete "${stale[@]}"
fi

# 输出同步结果，GitHub Actions 会把它写进 job 日志
printf '已同步到 %s\n' "$target_name"
git -C "$mirror" for-each-ref --format='  %(refname:short)' refs/heads refs/tags
