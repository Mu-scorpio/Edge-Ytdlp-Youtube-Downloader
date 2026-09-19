#!/usr/bin/env bash
set -euo pipefail

# macOS Native Messaging setup for Chrome / Edge.
# Usage: ./setup-native-host.sh <extension-id> [--browser chrome|edge] [--skip-tools]

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ID=""
BROWSER="${YTDLP_BROWSER:-chrome}"
PYTHON_PATH=""
SKIP_TOOLS=0
INTERACTIVE=0

usage() {
  cat <<'EOF'
用法：
  ./setup-native-host.sh <扩展ID>
  ./setup-native-host.sh <扩展ID> --browser chrome|edge
  ./setup-native-host.sh <扩展ID> --skip-tools
  ./setup-native-host.sh <扩展ID> --python /path/to/python3

扩展 ID 必须是加载解压缩扩展后，在 chrome://extensions 或 edge://extensions
看到的 32 位 a-p 字符串。
EOF
}

if [[ $# -eq 0 ]]; then
  INTERACTIVE=1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tools)
      SKIP_TOOLS=1
      shift
      ;;
    --browser)
      [[ $# -ge 2 ]] || { echo "[ERROR] --browser 需要 chrome 或 edge" >&2; exit 1; }
      BROWSER="$2"
      shift 2
      ;;
    --python)
      [[ $# -ge 2 ]] || { echo "[ERROR] --python 需要 Python 路径" >&2; exit 1; }
      PYTHON_PATH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -* )
      echo "[ERROR] 未知参数：$1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -z "$EXTENSION_ID" ]]; then
        EXTENSION_ID="$1"
      else
        echo "[ERROR] 只能指定一个扩展 ID" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$EXTENSION_ID" ]]; then
  read -r -p "请输入当前扩展 ID（32 位 a-p 字符）：" EXTENSION_ID
fi

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "[ERROR] 扩展 ID 必须恰好是 32 个 a-p 之间的字母：$EXTENSION_ID" >&2
  exit 1
fi

case "$BROWSER" in
  chrome)
    NATIVE_HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    EXTENSIONS_PAGE="chrome://extensions"
    ;;
  edge)
    NATIVE_HOST_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    EXTENSIONS_PAGE="edge://extensions"
    ;;
  *)
    echo "[ERROR] --browser 只能是 chrome 或 edge：$BROWSER" >&2
    exit 1
    ;;
esac

HOST_NAME="com.local.ytdlp_downloader"
HOST_SCRIPT="$ROOT/native-host.py"
LAUNCHER="$ROOT/native-host"
HOST_MANIFEST="$NATIVE_HOST_DIR/$HOST_NAME.json"

if [[ ! -f "$HOST_SCRIPT" ]]; then
  echo "[ERROR] 找不到 native-host.py：$HOST_SCRIPT" >&2
  exit 1
fi

find_python() {
  if [[ -n "$PYTHON_PATH" ]]; then
    [[ -x "$PYTHON_PATH" ]] || { echo "[ERROR] Python 不可执行：$PYTHON_PATH" >&2; exit 1; }
    "$PYTHON_PATH" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' \
      || { echo "[ERROR] Python 版本必须是 3.9 或更高：$PYTHON_PATH" >&2; exit 1; }
    return
  fi

  local candidate
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      candidate="$(command -v "$candidate")"
      if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
        PYTHON_PATH="$candidate"
        return
      fi
    fi
  done
}

find_python
if [[ -z "$PYTHON_PATH" && "$SKIP_TOOLS" -eq 0 && -x "$(command -v brew 2>/dev/null || true)" ]]; then
  echo "[..] 未找到 Python 3.9+，尝试通过 Homebrew 安装 Python 3.12…"
  brew install python@3.12 || true
  find_python
fi
if [[ -z "$PYTHON_PATH" ]]; then
  echo "[ERROR] 需要 Python 3.9+。请先安装 Python，或使用 --python 指定路径。" >&2
  exit 1
fi
echo "[OK] Python: $PYTHON_PATH"

if [[ "$SKIP_TOOLS" -eq 1 ]]; then
  echo "[WARN] 已跳过依赖安装（--skip-tools）。"
else
  if "$PYTHON_PATH" -c 'import yt_dlp' >/dev/null 2>&1; then
    echo "[OK] yt-dlp: ready"
  else
    echo "[..] 安装/升级 yt-dlp[default]…"
    if ! "$PYTHON_PATH" -m pip install --user --upgrade 'yt-dlp[default]'; then
      "$PYTHON_PATH" -m pip install --user --break-system-packages --upgrade 'yt-dlp[default]'
    fi
  fi

  if command -v node >/dev/null 2>&1; then
    echo "[OK] Node.js: ready"
  elif command -v brew >/dev/null 2>&1; then
    echo "[..] 安装 Node.js…"
    brew install node
  else
    echo "[WARN] 缺少 Node.js，且未找到 Homebrew；请手动执行：brew install node"
  fi

  if command -v ffmpeg >/dev/null 2>&1; then
    echo "[OK] FFmpeg: ready"
  elif command -v brew >/dev/null 2>&1; then
    echo "[..] 安装 FFmpeg…"
    brew install ffmpeg
  else
    echo "[WARN] 缺少 FFmpeg，且未找到 Homebrew；请手动执行：brew install ffmpeg"
  fi
fi

mkdir -p "$NATIVE_HOST_DIR"

"$PYTHON_PATH" - "$LAUNCHER" "$HOST_SCRIPT" "$PYTHON_PATH" <<'PY'
import shlex
import sys
from pathlib import Path

launcher, host_script, python_path = map(Path, sys.argv[1:])
content = "\n".join([
    "#!/bin/sh",
    'export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$PATH"',
    "export PYTHONUTF8=1",
    f"exec {shlex.quote(str(python_path))} {shlex.quote(str(host_script))} \"$@\"",
    "",
])
launcher.write_text(content, encoding="utf-8")
launcher.chmod(0o755)
PY
echo "[OK] Launcher: $LAUNCHER"

"$PYTHON_PATH" - "$HOST_MANIFEST" "$LAUNCHER" "$EXTENSION_ID" "$HOST_NAME" "$BROWSER" <<'PY'
import json
import os
import sys
from pathlib import Path

manifest_path, launcher, extension_id, host_name, browser = sys.argv[1:]
payload = {
    "name": host_name,
    "description": f"Local yt-dlp bridge for {browser.title()}",
    "path": os.path.abspath(launcher),
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"],
}
Path(manifest_path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
echo "[OK] Native Messaging manifest: $HOST_MANIFEST"

printf '%s\n' "$EXTENSION_ID" > "$ROOT/.extension-id"
chmod 600 "$ROOT/.extension-id"
echo "[OK] Saved extension ID: $ROOT/.extension-id"

echo
echo "=== Setup complete ==="
echo "Browser:      $BROWSER"
echo "Extension ID: $EXTENSION_ID"
echo "Next steps:"
echo "  1. Open $EXTENSIONS_PAGE and reload this extension"
echo "  2. Refresh any open YouTube tabs"
echo "  3. Click the extension icon and confirm the bridge is connected"
echo
echo "Bridge log: $HOME/Library/Logs/YT-DLP-Edge/bridge.log"
echo "To unregister: rm -f '$HOST_MANIFEST'"

if [[ "$INTERACTIVE" -eq 1 ]]; then
  echo
  read -r -p "按回车关闭此窗口…" _ || true
fi
