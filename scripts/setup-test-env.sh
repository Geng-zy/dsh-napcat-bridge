#!/usr/bin/env bash
# 准备测试环境：官方 Node + 指定版本的 dsh，装在 .cache/test-env（不进 git）。
#
# 为什么不用 dsh 桌面版自带的 Node：它带苹果签名限制，加载不了第三方原生模块，dsh 起不来。
#
# 用法：scripts/setup-test-env.sh
# 可选环境变量：
#   TEST_ENV_DIR  装到哪里（默认 <仓库>/.cache/test-env）
#   NODE_VERSION  Node 版本（默认 24.22.1）
#   DSH_VERSION   dsh 版本（默认 0.2.1-rc.2，换成服务器上实际跑的版本）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="${TEST_ENV_DIR:-$ROOT/.cache/test-env}"
NODE_VERSION="${NODE_VERSION:-24.22.1}"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.2}"
PNPM_VERSION="11.28.5"

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) echo "不支持的系统：$(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$ENV_DIR"
NODE_DIR="$ENV_DIR/node"
if [ ! -x "$NODE_DIR/bin/node" ] || [ "$("$NODE_DIR/bin/node" --version)" != "v$NODE_VERSION" ]; then
  NAME="node-v$NODE_VERSION-$OS-$ARCH.tar.gz"
  TMP="$(mktemp -d)"
  echo "下载 Node $NODE_VERSION（$OS-$ARCH）…"
  curl -fsSL -o "$TMP/$NAME" "https://nodejs.org/dist/v$NODE_VERSION/$NAME"
  curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  WANT="$(grep " $NAME\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  GOT="$(shasum -a 256 "$TMP/$NAME" 2>/dev/null | awk '{print $1}' || sha256sum "$TMP/$NAME" | awk '{print $1}')"
  if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then echo "Node 安装包校验失败" >&2; rm -rf "$TMP"; exit 1; fi
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$NAME" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP"
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "Node：$(node --version)"

DSH_DIR="$ENV_DIR/dsh"
mkdir -p "$DSH_DIR"
if [ ! -x "$DSH_DIR/node_modules/.bin/dsh" ] || [ "$("$DSH_DIR/node_modules/.bin/dsh" --version 2>/dev/null)" != "$DSH_VERSION" ]; then
  echo "安装 dsh $DSH_VERSION（几百个包，要几分钟）…"
  (cd "$DSH_DIR" && echo '{"name":"dsh-test-env","private":true}' > package.json \
    && npx --yes "pnpm@$PNPM_VERSION" add "@deepseek-ai/dsh@$DSH_VERSION" --dangerously-allow-all-builds >/dev/null)
fi
echo "dsh：$("$DSH_DIR/node_modules/.bin/dsh" --version)"
echo
echo "测试环境就绪：$ENV_DIR"
echo "scripts/check.sh 会自动用它。"
