#!/usr/bin/env bash
set -euo pipefail

# Double-click helper for macOS. The first run asks for the unpacked
# extension ID; setup-native-host.sh saves it so later runs are automatic.
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BROWSER="${YTDLP_BROWSER:-chrome}"
EXTENSION_ID="${YTDLP_EXTENSION_ID:-}"
ID_FILE="$ROOT/.extension-id"

usage() {
  cat <<'EOF'
用法：
  双击本文件，或在终端执行：
  ./connect-native-host.command [扩展ID]

环境变量：
  YTDLP_BROWSER=chrome|edge
  YTDLP_NO_PAUSE=1    运行结束后不等待回车
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --browser)
      [[ $# -ge 2 ]] || { echo "[ERROR] --browser 需要 chrome 或 edge" >&2; exit 1; }
      BROWSER="$2"
      shift 2
      ;;
    --edge)
      BROWSER="edge"
      shift
      ;;
    --chrome)
      BROWSER="chrome"
      shift
      ;;
    *)
      if [[ -z "$EXTENSION_ID" ]]; then
        EXTENSION_ID="$1"
        shift
      else
        echo "[ERROR] 只能指定一个扩展 ID" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$EXTENSION_ID" && -f "$ID_FILE" ]]; then
  IFS= read -r EXTENSION_ID < "$ID_FILE" || true
fi

if [[ -z "$EXTENSION_ID" ]]; then
  EXTENSIONS_PAGE="chrome://extensions"
  [[ "$BROWSER" == "edge" ]] && EXTENSIONS_PAGE="edge://extensions"
  echo "请先在 $EXTENSIONS_PAGE 复制 YT-DLP YouTube Downloader 卡片上的 32 位扩展 ID。"
  read -r -p "请输入扩展 ID：" EXTENSION_ID
fi

case "$BROWSER" in
  chrome|edge) ;;
  *) echo "[ERROR] 浏览器只能是 chrome 或 edge：$BROWSER" >&2; exit 1 ;;
esac

"$ROOT/setup-native-host.sh" "$EXTENSION_ID" --browser "$BROWSER"

if command -v open >/dev/null 2>&1; then
  if [[ "$BROWSER" == "edge" ]]; then
    open "edge://extensions" >/dev/null 2>&1 || true
  else
    open "chrome://extensions" >/dev/null 2>&1 || true
  fi
fi

echo
echo "桥接已注册。请在扩展页面点击重新加载，再刷新 YouTube 页面。"
if [[ "${YTDLP_NO_PAUSE:-0}" != "1" ]]; then
  read -r -p "按回车关闭此窗口…" _ || true
fi
