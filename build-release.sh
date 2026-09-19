#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$ROOT/dist"
OUTPUT="$OUTPUT_DIR/edge-ytdlp-youtube-downloader.zip"

command -v zip >/dev/null 2>&1 || {
  echo "[ERROR] 未找到 zip，请先安装系统压缩工具。" >&2
  exit 1
}

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT"

(
  cd "$ROOT"
  zip -q -r "$OUTPUT" \
    manifest.json \
    background.js \
    content.js \
    content.css \
    page-bridge.js \
    popup.html \
    popup.css \
    popup.js \
    options.html \
    options.css \
    options.js \
    native-host.py \
    setup-native-host.bat \
    setup-native-host.sh \
    connect-native-host.command \
    icons \
    docs \
    README.md \
    CHANGELOG.md \
    LICENSE
)

echo "[OK] Release package: $OUTPUT"
