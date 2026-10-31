#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
. app/student/network-mac.sh
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "Linux 安装包目前支持 x86_64 桌面系统。Windows / Mac 请使用对应启动文件。"
  exit 1
fi
runtime="$PWD/runtime/linux-x64"
node="$runtime/bin/node"
if [ "${1:-}" = '--node-only' ] && [ -x "$node" ] && "$node" --version >/dev/null 2>&1; then exit 0; fi
mkdir -p runtime
if ! mkdir runtime/.install-lock 2>/dev/null; then
  echo "已有下载窗口正在运行，请回到原窗口等待完成。"
  exit 1
fi
temp=""
cleanup() {
  [ -z "$temp" ] || rm -rf -- "$temp"
  rmdir runtime/.install-lock
}
trap cleanup EXIT
trap 'exit 130' INT TERM
temp=$(mktemp -d "$PWD/runtime/.download.XXXXXX")
filename=node-v24.21.0-linux-x64.tar.gz
if [ ! -x "$node" ] || ! "$node" --version >/dev/null 2>&1 || [ ! -f "$runtime/lib/node_modules/npm/bin/npm-cli.js" ]; then
  echo "[1/3] 下载 Linux 运行环境……"
  if ! curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 --connect-timeout 8 --max-time 180 \
    "https://nodejs.org/dist/v24.21.0/$filename" -o "$temp/$filename"; then
    echo "正在切换下载地址……"
    curl --silent --show-error --fail --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 10 --max-time 900 \
      "https://cdn.npmmirror.com/binaries/node/v24.21.0/$filename" -o "$temp/$filename"
  fi
  echo "校验并解压运行环境……"
  awk -v file="$filename" '$2 == file' 依赖校验.sha256 > "$temp/check.sha256"
  [ -s "$temp/check.sha256" ] || { echo "缺少运行环境校验值，请重新完整解压安装包。"; exit 1; }
  (cd "$temp" && sha256sum --check check.sha256 && tar -xzf "$filename")
  rm -rf -- "$runtime"
  mv "$temp/node-v24.21.0-linux-x64" "$runtime"
fi
if [ "${1:-}" = '--node-only' ]; then exit 0; fi
export PATH="$runtime/bin:$PATH"
if ! "$node" app/student/start.mjs --check >/dev/null 2>&1; then
  echo "[2/3] 安装浏览器连接组件……"
  (cd app && "$node" "$runtime/lib/node_modules/npm/bin/npm-cli.js" ci --ignore-scripts --omit=optional \
    --no-audit --no-fund --registry=https://registry.npmjs.org --cache "$PWD/../runtime/npm-cache")
fi
echo "[3/3] 准备 Firefox 自动化组件（已有组件会复用）……"
(cd app && "$node" node_modules/playwright/cli.js install firefox)
"$node" app/student/start.mjs --check
echo "Linux 安装完成。"
