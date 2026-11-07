#!/bin/bash
# Libretv2Strm —— 飞牛 fnOS 双架构 fpk 打包（arm + x86）
#
# 用法：
#   VENDOR_DIR=/path/to/vendor bash scripts/pack-fpk.sh
#
# 依赖（打包前先准备好）：
#   1. libretv/.next/standalone   —— 由 `NODE_OPTIONS= DOCKER_BUILD=1 npm run build` 产出
#   2. $VENDOR_DIR/{arm,x86}/       —— 提供两套 Node 运行时与 sharp 原生模块，见 docs/打包说明.md
#
# 环境变量：
#   VENDOR_DIR   运行时来源目录，默认 .vendor
#   OUT_DIR      输出目录，默认 dist
#   VERSION      版本号，默认取 libretv-fpk/manifest 里的 version
#
# 必须遵守的 fpk 规矩（踩过的坑）：
#   1. app.tgz 顶层必须是 server/ runtime/ ui/ config/，不能多套一层 app/
#   2. Node 运行时目录名必须是 node-arm64 / node-x64
#   3. manifest.checksum = md5(app.tgz)
#   4. app.tgz 必须含 public/
#   5. wizard/ 下的文件直接落在 fpk 顶层 wizard/ 里，不能套成 wizard/wizard/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="${ROOT}/libretv"
FPKD="${ROOT}/libretv-fpk"
VENDOR="${VENDOR_DIR:-${ROOT}/.vendor}"
OUT="${OUT_DIR:-${ROOT}/dist}"
VERSION="${VERSION:-$(awk -F'= *' '/^version[[:space:]]*=/{print $2; exit}' "${FPKD}/manifest" | tr -d '[:space:]')}"
STAGE="${STAGE_DIR:-${TMPDIR:-/tmp}/libretv2strm-pack-${VERSION}}"
PKG="libretv2strm"

die() { echo "❌ $*" >&2; exit 1; }

[ -d "${LIB}/.next/standalone" ] || die "缺 ${LIB}/.next/standalone，先跑 npm run build"
[ -d "${FPKD}/wizard" ] || die "缺 ${FPKD}/wizard"
[ -n "${VERSION}" ] || die "无法确定版本号"

rm -rf "${STAGE}" && mkdir -p "${STAGE}" "${OUT}"

echo "0) 预检：版本号与构建产物里的功能标记"
grep -q "\"version\": \"${VERSION}\"" "${LIB}/package.json" \
  || die "libretv/package.json 的 version 不是 ${VERSION}（改完记得重新 build，APP_VERSION 是构建时注入的）"
for marker in 跳过标记 控制栏自动隐藏 自动刷新周期; do
  grep -rq "${marker}" "${LIB}/.next/static" \
    || die "构建产物缺「${marker}」——很可能用了旧的 .next"
done
echo "   ✅ ${VERSION}，三项功能标记均在产物中"

for ARCH in arm x86; do
  echo ""
  echo "═══ 构建 ${ARCH} ═══"
  APP="${STAGE}/${ARCH}/approot"
  META="${STAGE}/${ARCH}/meta"
  mkdir -p "${APP}/server" "${META}"

  if [ "${ARCH}" = "arm" ]; then
    RUNTIME_DIR="node-arm64"
    SHARP_ARCH="linux-arm64"
    NODE_MATCH="ARM aarch64"
  else
    RUNTIME_DIR="node-x64"
    SHARP_ARCH="linux-x64"
    NODE_MATCH="x86-64"
  fi

  echo "1) 复制 standalone 产物"
  cp "${LIB}/.next/standalone/server.js" "${APP}/server/"
  cp "${LIB}/.next/standalone/package.json" "${APP}/server/"
  cp -r "${LIB}/.next/standalone/.next" "${APP}/server/.next"
  cp -r "${LIB}/.next/static" "${APP}/server/.next/static"
  if [ -d "${LIB}/.next/standalone/public" ]; then
    cp -r "${LIB}/.next/standalone/public" "${APP}/server/public"
  else
    cp -r "${LIB}/public" "${APP}/server/public"
  fi
  rsync -a --exclude='.cache' "${LIB}/.next/standalone/node_modules/" "${APP}/server/node_modules/"

  echo "2) 换成本架构 sharp 原生模块"
  rm -rf "${APP}/server/node_modules/@img/"sharp-darwin* \
         "${APP}/server/node_modules/@img/"sharp-libvips-darwin*
  rm -rf "${APP}/server/node_modules/@img/sharp-linux-arm64" \
         "${APP}/server/node_modules/@img/sharp-linux-x64" \
         "${APP}/server/node_modules/@img/sharp-libvips-linux-arm64" \
         "${APP}/server/node_modules/@img/sharp-libvips-linux-x64"
  mkdir -p "${APP}/server/node_modules/@img"
  cp -r "${VENDOR}/${ARCH}/server/node_modules/@img/sharp-${SHARP_ARCH}" \
        "${APP}/server/node_modules/@img/"
  cp -r "${VENDOR}/${ARCH}/server/node_modules/@img/sharp-libvips-${SHARP_ARCH}" \
        "${APP}/server/node_modules/@img/"
  if [ -d "${VENDOR}/${ARCH}/server/node_modules/@img/sharp-wasm32" ]; then
    cp -r "${VENDOR}/${ARCH}/server/node_modules/@img/sharp-wasm32" \
          "${APP}/server/node_modules/@img/"
  fi

  echo "3) Node 运行时（目录名 ${RUNTIME_DIR}）"
  mkdir -p "${APP}/runtime/${RUNTIME_DIR}/bin"
  cp "${VENDOR}/${ARCH}/runtime/${RUNTIME_DIR}/bin/node" "${APP}/runtime/${RUNTIME_DIR}/bin/node"
  chmod 755 "${APP}/runtime/${RUNTIME_DIR}/bin/node"

  echo "4) ui 与 config"
  cp -r "${FPKD}/ui" "${APP}/ui"
  cp -r "${FPKD}/config" "${APP}/config"

  echo "5) 打包 app.tgz"
  ( cd "${APP}" && tar czf "${META}/app.tgz" server runtime ui config )
  echo "   顶层条目: $(tar -tzf "${META}/app.tgz" | cut -d/ -f1 | sort -u | tr '\n' ' ')"

  echo "6) FPK 元数据"
  mkdir -p "${META}/cmd" "${META}/config" "${META}/wizard"
  cp -r "${FPKD}/cmd/." "${META}/cmd/"
  cp -r "${FPKD}/config/." "${META}/config/"
  cp -r "${FPKD}/wizard/." "${META}/wizard/"
  cp "${FPKD}/ICON.PNG" "${META}/ICON.PNG"
  cp "${FPKD}/ICON_256.PNG" "${META}/ICON_256.PNG"
  sed -e "s/^platform[[:space:]]*=.*/platform              = ${ARCH}/" \
      -e "s/^version[[:space:]]*=.*/version               = ${VERSION}/" \
      "${FPKD}/manifest" > "${META}/manifest"
  chmod 755 "${META}/cmd/main" 2>/dev/null || true

  echo "7) 回填 checksum"
  SUM="$( (md5 -q "${META}/app.tgz" 2>/dev/null || md5sum "${META}/app.tgz" | awk '{print $1}') )"
  python3 - "${META}" "${SUM}" <<'PY'
import re, sys
meta, sum_ = sys.argv[1], sys.argv[2]
p = meta + '/manifest'
s = open(p, encoding='utf-8').read()
if re.search(r'^checksum\s*=', s, re.M):
    s = re.sub(r'^checksum\s*=.*$', f'checksum              = {sum_}', s, flags=re.M)
else:
    s = s.rstrip('\n') + f'\nchecksum              = {sum_}\n'
open(p, 'w', encoding='utf-8').write(s)
print('   checksum =', sum_)
PY

  echo "8) 生成 fpk"
  ( cd "${META}" && tar czf "${OUT}/${PKG}-${VERSION}-${ARCH}.fpk" \
      app.tgz cmd config ICON.PNG ICON_256.PNG manifest wizard )

  echo "9) 校验"
  file "${APP}/runtime/${RUNTIME_DIR}/bin/node" | grep -q "${NODE_MATCH}" \
    || die "Node 运行时架构不匹配（期望 ${NODE_MATCH}）"
  for f in install upgrade config uninstall; do
    [ -f "${META}/wizard/${f}" ] || die "wizard/${f} 缺失"
  done
  [ -d "${META}/wizard/wizard" ] && die "wizard 嵌套（wizard/wizard），fnOS 会找不到向导"
  grep -q 'wizard_password' "${META}/wizard/install" || die "安装向导缺密码字段"
  grep -q 'PASSWORD not configured' "${META}/cmd/main" || die "cmd/main 缺空密码放行"
  grep -q "^version               = ${VERSION}$" "${META}/manifest" || die "manifest 版本不对"
  tar tzf "${META}/app.tgz" | grep -q 'server/.next' || die "app.tgz 缺 .next"
  grep -rq '跳过标记' "${APP}/server/.next/static" || die "包内缺「跳过标记」"
  echo "   wizard/ ✅ $(ls "${META}/wizard" | tr '\n' ' ')"
  echo "   运行时 ✅ ${RUNTIME_DIR} (${NODE_MATCH})"
  echo "   新功能 ✅ 跳过标记 / 控制栏自动隐藏 / 自动刷新周期"
  ls -lh "${OUT}/${PKG}-${VERSION}-${ARCH}.fpk"
done

echo ""
echo "═══ 完成 ═══"
( cd "${OUT}" && shasum -a 256 "${PKG}-${VERSION}-"*.fpk | tee SHA256SUMS.txt )
