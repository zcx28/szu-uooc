#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
umask 077
if [ ! -f app/student/install-linux.sh ] || [ ! -f app/student/network-mac.sh ]; then
  echo "请重新完整解压安装包，再运行 Linux 启动文件。"
  exit 1
fi
. app/student/network-mac.sh
bash app/student/install-linux.sh
runtime="$PWD/runtime/linux-x64"
node="$runtime/bin/node"
if [ "$#" -gt 0 ]; then "$node" app/student/start.mjs "$@"; exit "$?"; fi

# start.mjs writes this unique notification only after the console is ready.
ready=$(mktemp "$PWD/runtime/launch.XXXXXX")
rm -- "$ready"
trap 'rm -f -- "$ready"' EXIT
nohup "$node" app/student/start.mjs --ready-file "$ready" > "$runtime/console.log" 2>&1 < /dev/null &
pid=$!
for ((i=0; i<80; i++)); do
  if [ -f "$ready" ]; then
    echo "szu-uooc 控制台已在浏览器中打开。访问地址："
    "$node" -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"); console.log(JSON.parse(fs.readFileSync(path.join(os.homedir(),".config/szu-uooc/console-address.json"),"utf8")).url);'
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    if wait "$pid"; then status=1; else status=$?; fi
    echo "启动失败，日志：$runtime/console.log"
    tail -n 5 "$runtime/console.log"
    exit "$status"
  fi
  sleep 0.25
done
echo "控制台启动超时，请查看 $runtime/console.log。"
exit 1
