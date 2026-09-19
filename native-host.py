#!/usr/bin/env python3
"""Cross-platform native-messaging bridge with yt-dlp progress events."""
import json
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

WRITE_LOCK = threading.Lock()
SYSTEM = platform.system()
IS_WINDOWS = SYSTEM == "Windows"
IS_MACOS = SYSTEM == "Darwin"
BRIDGE_VERSION = "1.8.0"
INSTALL_LOCK = threading.Lock()
DOWNLOAD_PRESETS = {
    "best": {"label": "最高质量", "format": "bestvideo*+bestaudio/best", "audio_only": False},
    "2160": {"label": "2160p", "format": "bestvideo[height<=2160]+bestaudio/best[height<=2160]", "audio_only": False},
    "1440": {"label": "1440p", "format": "bestvideo[height<=1440]+bestaudio/best[height<=1440]", "audio_only": False},
    "1080": {"label": "1080p", "format": "bestvideo[height<=1080]+bestaudio/best[height<=1080]", "audio_only": False},
    "720": {"label": "720p", "format": "bestvideo[height<=720]+bestaudio/best[height<=720]", "audio_only": False},
    "480": {"label": "480p", "format": "bestvideo[height<=480]+bestaudio/best[height<=480]", "audio_only": False},
    "360": {"label": "360p", "format": "bestvideo[height<=360]+bestaudio/best[height<=360]", "audio_only": False},
    "audio": {"label": "仅音频", "format": "bestaudio", "audio_only": True},
}


def prepend_runtime_paths():
    """Make Homebrew tools visible when Chrome was launched from Finder."""
    if not IS_MACOS:
        return
    candidates = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
    ]
    current = os.environ.get("PATH", "").split(os.pathsep)
    os.environ["PATH"] = os.pathsep.join(
        [path for path in candidates if path not in current] + current
    )


prepend_runtime_paths()


def default_browser_name():
    """Pick the browser used by the current platform when no name is supplied."""
    configured = os.environ.get("YTDLP_BROWSER", "").strip().lower()
    if configured in {"chrome", "edge", "chromium"}:
        return configured
    return "edge" if IS_WINDOWS else "chrome"


def normalize_browser_name(value):
    name = str(value or default_browser_name()).strip().lower()
    return name if name in {"chrome", "edge", "chromium"} else default_browser_name()


def browser_display_name(browser_name=None):
    return {
        "chrome": "Chrome",
        "edge": "Edge",
        "chromium": "Chromium",
    }.get(normalize_browser_name(browser_name), "浏览器")


def log_path():
    if IS_WINDOWS:
        root = Path(os.environ.get("LOCALAPPDATA", str(Path.home())))
    elif IS_MACOS:
        root = Path.home() / "Library" / "Logs"
    else:
        root = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state")))
    return root / "YT-DLP-Edge" / "bridge.log"


LOG_PATH = log_path()


def browser_preferences_paths(browser_name=None):
    """Return likely Preferences files for the selected browser."""
    browser = normalize_browser_name(browser_name)
    home = Path.home()
    if IS_WINDOWS:
        root = Path(os.environ.get("LOCALAPPDATA", str(home)))
        roots = {
            "chrome": root / "Google" / "Chrome" / "User Data",
            "edge": root / "Microsoft" / "Edge" / "User Data",
            "chromium": root / "Chromium" / "User Data",
        }
    elif IS_MACOS:
        root = home / "Library" / "Application Support"
        roots = {
            "chrome": root / "Google" / "Chrome",
            "edge": root / "Microsoft Edge",
            "chromium": root / "Chromium",
        }
    else:
        root = Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")))
        roots = {
            "chrome": root / "google-chrome",
            "edge": root / "microsoft-edge",
            "chromium": root / "chromium",
        }
    base = roots[browser]
    return [base / "Default" / "Preferences", base / "Preferences"]


def log(message):
    """Diagnostics only; native-messaging stdout must remain protocol-only."""
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


def browser_download_directory(browser_name=None):
    """Read the selected Chromium browser's configured download directory."""
    for preferences in browser_preferences_paths(browser_name):
        try:
            contents = preferences.read_text(encoding="utf-8", errors="ignore")
            match = re.search(r'"default_directory"\s*:\s*"((?:\\.|[^"\\])*)"', contents)
            if match:
                configured = json.loads(f'"{match.group(1)}"').strip()
                if configured:
                    return Path(configured).expanduser()
        except (OSError, json.JSONDecodeError):
            continue
    return Path.home() / "Downloads"


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) != 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    raw_message = sys.stdin.buffer.read(length)
    if len(raw_message) != length:
        return None
    return json.loads(raw_message.decode("utf-8"))


def write_message(payload):
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    with WRITE_LOCK:
        sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()


def run_capture(command, timeout=120):
    """Run a process and capture combined output without opening a Windows console."""
    try:
        options = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "timeout": timeout,
            "check": False,
        }
        if IS_WINDOWS:
            options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        completed = subprocess.run(command, **options)
        text = decode_process_line(completed.stdout).strip()
        return completed.returncode, text
    except FileNotFoundError as error:
        return 127, str(error)
    except subprocess.TimeoutExpired:
        return 124, f"命令超时（{timeout}s）: {' '.join(map(str, command[:4]))}"
    except Exception as error:
        return 1, str(error)


def tool_version(command, timeout=15):
    code, output = run_capture(command, timeout=timeout)
    if code != 0:
        return None
    first = (output.splitlines() or [""])[0].strip()
    return first or "ok"


def resolve_ytdlp(configured_path):
    """Resolve yt-dlp executable or python -m yt_dlp fallback."""
    if configured_path:
        candidate = Path(configured_path).expanduser()
        if candidate.is_file():
            return [str(candidate)]
        raise ValueError(
            "设置中的 yt-dlp 路径不存在。\n"
            f"路径: {candidate}\n"
            "请在扩展设置中修正路径，或留空以使用 PATH / python -m yt_dlp。"
        )
    found = shutil.which("yt-dlp.exe") or shutil.which("yt-dlp")
    if found:
        return [found]
    # pip --user installs often put scripts outside PATH; module form still works.
    code, _ = run_capture([sys.executable, "-c", "import yt_dlp"], timeout=10)
    if code == 0:
        return [sys.executable, "-m", "yt_dlp"]
    raise ValueError(
        "未找到 yt-dlp。\n"
        "新设备请在扩展弹窗点击「安装缺失工具」，或在本机执行：\n"
        f'  {python_install_hint()}\n'
        "也可在设置中填写 yt-dlp 的完整路径。"
    )


def python_install_hint():
    return f'"{sys.executable}" -m pip install --user --upgrade "yt-dlp[default]"'


def diagnose_dependencies(configured_ytdlp_path=""):
    """Return readiness of runtime tools for the extension UI."""
    tools = {}

    # Python (the bridge itself)
    tools["python"] = {
        "ok": True,
        "label": "Python",
        "detail": f"{sys.version.split()[0]} ({sys.executable})",
        "required": True,
    }

    # yt-dlp
    ytdlp_ok = False
    ytdlp_detail = "未找到"
    ytdlp_command = None
    try:
        ytdlp_command = resolve_ytdlp(configured_ytdlp_path)
        version = tool_version([*ytdlp_command, "--version"])
        if version:
            ytdlp_ok = True
            ytdlp_detail = f"{version} · {' '.join(ytdlp_command)}"
        else:
            ytdlp_detail = f"可解析命令但 --version 失败: {' '.join(ytdlp_command)}"
    except ValueError as error:
        ytdlp_detail = str(error).split("\n")[0]
    tools["ytdlp"] = {
        "ok": ytdlp_ok,
        "label": "yt-dlp",
        "detail": ytdlp_detail,
        "required": True,
        "command": ytdlp_command,
    }

    # Node.js (YouTube EJS / JS challenges)
    node_path = shutil.which("node") or shutil.which("node.exe")
    node_version = tool_version([node_path, "--version"]) if node_path else None
    tools["node"] = {
        "ok": bool(node_version),
        "label": "Node.js",
        "detail": f"{node_version} ({node_path})" if node_version else "未找到（解析新版 YouTube 挑战需要）",
        "required": True,
        "installHint": "brew install node" if IS_MACOS else 'winget install -e --id OpenJS.NodeJS.LTS',
    }

    # FFmpeg (MP4 conversion and audio/video merging)
    ffmpeg_path = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    ffmpeg_version = None
    if ffmpeg_path:
        raw = tool_version([ffmpeg_path, "-version"])
        if raw:
            ffmpeg_version = raw.split("Copyright")[0].strip() or raw
    tools["ffmpeg"] = {
        "ok": bool(ffmpeg_version),
        "label": "FFmpeg",
        "detail": f"{ffmpeg_version} ({ffmpeg_path})" if ffmpeg_version else "未找到（MP4 转换和音视频合并需要）",
        "required": True,
        "installHint": "brew install ffmpeg" if IS_MACOS else "winget install -e --id Gyan.FFmpeg",
    }

    missing_required = [name for name, info in tools.items() if info.get("required") and not info.get("ok")]
    missing_optional = [name for name, info in tools.items() if not info.get("required") and not info.get("ok")]
    return {
        "ok": not missing_required,
        "tools": tools,
        "missingRequired": missing_required,
        "missingOptional": missing_optional,
        "bridgeVersion": BRIDGE_VERSION,
        "python": sys.executable,
        "logPath": str(LOG_PATH),
    }


def winget_available():
    return bool(shutil.which("winget") or shutil.which("winget.exe"))


def brew_available():
    return bool(shutil.which("brew"))


def install_ytdlp():
    command = [sys.executable, "-m", "pip", "install", "--user", "--upgrade", "yt-dlp[default]"]
    log(f"Installing yt-dlp: {' '.join(command)}")
    code, output = run_capture(command, timeout=600)
    if code != 0 and IS_MACOS:
        # Homebrew Python may enforce PEP 668. Retry only on macOS, where the
        # user explicitly asked the extension to manage its local dependency.
        compatible_command = [
            sys.executable, "-m", "pip", "install", "--user", "--break-system-packages",
            "--upgrade", "yt-dlp[default]",
        ]
        retry_code, retry_output = run_capture(compatible_command, timeout=600)
        if retry_code == 0:
            code, output = retry_code, retry_output
    tail = "\n".join(output.splitlines()[-12:])
    if code != 0:
        if IS_MACOS and brew_available():
            brew_code, brew_output = run_capture(["brew", "install", "yt-dlp"], timeout=900)
            if brew_code == 0 and resolve_ytdlp_safe():
                return True, f"已通过 Homebrew 安装 yt-dlp。\n{tail}"
            tail = "\n".join(brew_output.splitlines()[-12:]) or tail
        return False, f"安装 yt-dlp 失败（退出码 {code}）。\n{tail}\n请手动执行: {python_install_hint()}"
    # Clear path cache after install
    try:
        resolve_ytdlp("")
        return True, f"yt-dlp 已安装/升级。\n{tail}"
    except ValueError:
        return True, (
            "pip 已完成，但当前进程仍可能找不到 yt-dlp 脚本目录。\n"
            "扩展会优先使用 python -m yt_dlp。若仍失败，请重新加载扩展后再试。\n"
            f"{tail}"
        )


def resolve_ytdlp_safe():
    try:
        return bool(resolve_ytdlp(""))
    except ValueError:
        return False


def install_with_winget(package_id, display_name, check_names):
    if not winget_available():
        return False, f"未找到 winget，无法自动安装 {display_name}。请手动安装后重试。"
    command = [
        "winget", "install", "-e", "--id", package_id,
        "--accept-package-agreements", "--accept-source-agreements",
        "--disable-interactivity",
    ]
    log(f"Installing {display_name} via winget: {package_id}")
    code, output = run_capture(command, timeout=900)
    tail = "\n".join(output.splitlines()[-15:])
    # Refresh PATH for this process from registry
    try:
        machine = os.environ.get("Path", "")
        user_key = r"Environment"
        # Best-effort: prepend common install locations is hard; re-read user PATH via PowerShell
        ps = [
            "powershell", "-NoProfile", "-Command",
            "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
        ]
        pcode, path_value = run_capture(ps, timeout=20)
        if pcode == 0 and path_value:
            os.environ["Path"] = path_value.strip()
    except Exception as error:
        log(f"PATH refresh failed: {error}")

    found = any(shutil.which(name) for name in check_names)
    if found:
        return True, f"{display_name} 安装成功。\n{tail}"
    if code == 0:
        return False, (
            f"{display_name} 的 winget 安装似乎已结束，但当前 PATH 仍找不到命令。\n"
            "请关闭 Edge 后重新打开，或注销 Windows 后再试。\n"
            f"{tail}"
        )
    return False, f"安装 {display_name} 失败（退出码 {code}）。\n{tail}\n也可手动执行: winget install -e --id {package_id}"


def install_with_brew(formula, display_name, check_names):
    """Install a macOS dependency through Homebrew when it is available."""
    if any(shutil.which(name) for name in check_names):
        return True, f"{display_name} 已存在，跳过"
    if not brew_available():
        return False, f"未找到 Homebrew，无法自动安装 {display_name}。请手动执行: brew install {formula}"
    command = ["brew", "install", formula]
    log(f"Installing {display_name} via Homebrew: {formula}")
    code, output = run_capture(command, timeout=900)
    tail = "\n".join(output.splitlines()[-15:])
    found = any(shutil.which(name) for name in check_names)
    if found:
        return True, f"{display_name} 安装成功。\n{tail}"
    return False, f"安装 {display_name} 失败（退出码 {code}）。\n{tail}\n也可手动执行: brew install {formula}"


def install_dependency(package_id, formula, display_name, check_names):
    if IS_MACOS:
        return install_with_brew(formula, display_name, check_names)
    if IS_WINDOWS:
        return install_with_winget(package_id, display_name, check_names)
    return False, f"当前系统不支持自动安装 {display_name}，请手动安装后重试。"


def install_missing_tools(auto_only_ytdlp=False):
    """Install missing runtime tools. Returns a structured result for the UI."""
    with INSTALL_LOCK:
        before = diagnose_dependencies()
        steps = []
        overall_ok = True

        if not before["tools"]["ytdlp"]["ok"]:
            ok, detail = install_ytdlp()
            steps.append({"tool": "ytdlp", "ok": ok, "detail": detail})
            overall_ok = overall_ok and ok
        else:
            steps.append({"tool": "ytdlp", "ok": True, "detail": "已存在，跳过"})

        if not auto_only_ytdlp:
            if not before["tools"]["node"]["ok"]:
                ok, detail = install_dependency("OpenJS.NodeJS.LTS", "node", "Node.js LTS", ["node", "node.exe"])
                steps.append({"tool": "node", "ok": ok, "detail": detail})
                overall_ok = overall_ok and ok
            else:
                steps.append({"tool": "node", "ok": True, "detail": "已存在，跳过"})

            if not before["tools"]["ffmpeg"]["ok"]:
                ok, detail = install_dependency("Gyan.FFmpeg", "ffmpeg", "FFmpeg", ["ffmpeg", "ffmpeg.exe"])
                steps.append({"tool": "ffmpeg", "ok": ok, "detail": detail})
                if not ok:
                    steps[-1]["detail"] += "\n（FFmpeg 是普通视频输出 MP4 所必需的组件）"
            else:
                steps.append({"tool": "ffmpeg", "ok": True, "detail": "已存在，跳过"})

        after = diagnose_dependencies()
        summary_lines = []
        for step in steps:
            mark = "OK" if step["ok"] else "FAIL"
            summary_lines.append(f"[{mark}] {step['tool']}: {step['detail'].splitlines()[0]}")
        message = "\n".join(summary_lines)
        log(f"install-tools finished ok={overall_ok and after['ok']}: {message}")
        return {
            "ok": after["ok"],
            "message": message,
            "steps": steps,
            "diagnosis": after,
        }


def humanize_error(raw_error):
    """Map common yt-dlp / environment failures to actionable Chinese guidance."""
    text = (raw_error or "").strip()
    if not text:
        return f"下载失败，但未捕获到具体错误输出。请查看桥接日志 {LOG_PATH}"

    patterns = [
        (
            r"Sign in to confirm you.?re not a bot|confirm you.?re not a bot",
            "YouTube 要求登录验证（机器人检测）。\n"
            "处理建议：\n"
            "1. 在当前浏览器打开 youtube.com 并确保已登录；\n"
            "2. 扩展设置中保持「自动使用浏览器 Cookie」开启；\n"
            "3. 确认代理出口与浏览器一致（默认 socks5h://127.0.0.1:7890）；\n"
            "4. 刷新页面后重试。",
        ),
        (
            r"Requested format is not available|Only images are available|storyboard",
            "未拿到可用视频格式（常见于 yt-dlp/EJS 过旧或 JS 挑战失败）。\n"
            "处理建议：\n"
            "1. 扩展弹窗点击「安装缺失工具」升级 yt-dlp[default]；\n"
            "2. 确认已安装 Node.js；\n"
            f"3. 手动: {python_install_hint()}",
        ),
        (
            r"Unable to download API page|HTTP Error 429|Too Many Requests",
            "请求过于频繁或被限流（HTTP 429）。\n请稍后重试；若使用代理，可更换节点或暂时关闭代理。",
        ),
        (
            r"SSL: UNEXPECTED_EOF|SSLEOFError|EOF occurred in violation of protocol",
            "TLS 连接被中断。本机 7890 的 HTTP 代理常有此问题。\n"
            "请改用 socks5h://127.0.0.1:7890，或在设置中清空代理后直连重试。",
        ),
        (
            r"Failed to establish a new connection|Connection refused|WinError 10061|No connection could be made",
            "无法连接网络/代理。\n"
            "若设置了代理，请确认代理软件已启动且端口正确；不需要代理时请清空扩展中的代理地址。",
        ),
        (
            r"ffmpeg|ffprobe",
            "FFmpeg 不可用，普通视频无法输出 MP4 或完成音视频合并。\n"
            "请点击扩展弹窗「安装缺失工具」，或按系统执行: brew install ffmpeg / winget install -e --id Gyan.FFmpeg",
        ),
        (
            r"node(\.exe)?.*(not found|不是内部或外部命令|No such file)|js runtime|JavaScript runtime",
            "未找到 Node.js，无法处理 YouTube JavaScript 挑战。\n"
            "请点击「安装缺失工具」，或按系统执行: brew install node / winget install -e --id OpenJS.NodeJS.LTS",
        ),
        (
            r"yt-dlp.*(not found|不是内部或外部命令)|No such file or directory.*yt-dlp",
            f"未找到 yt-dlp。\n请点击「安装缺失工具」，或: {python_install_hint()}",
        ),
        (
            r"Private video|This video is private|Video unavailable|copyright",
            "视频不可用（私密、删除或版权限制）。请确认链接可在浏览器中正常播放。",
        ),
        (
            r"HTTP Error 403|Forbidden",
            "服务器拒绝访问（HTTP 403）。\n请确认已登录 YouTube，Cookie 有效，并尝试同步代理设置后重试。",
        ),
        (
            r"timed? ?out|Timeout|Read timed out",
            "网络超时。\n请检查网络/代理，或稍后重试；也可在设置中调整代理地址。",
        ),
    ]
    for pattern, advice in patterns:
        if re.search(pattern, text, re.IGNORECASE):
            return f"{advice}\n\n原始错误: {text}"
    return text


def write_browser_cookies(cookies):
    """Write browser cookie API values as a disposable Netscape cookie file."""
    descriptor, raw_path = tempfile.mkstemp(prefix="ytdlp-edge-", suffix=".cookies.txt")
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("# Netscape HTTP Cookie File\n")
        for cookie in cookies:
            domain = str(cookie.get("domain") or "").replace("\t", "").replace("\r", "").replace("\n", "")
            name = str(cookie.get("name") or "").replace("\t", "").replace("\r", "").replace("\n", "")
            value = str(cookie.get("value") or "").replace("\t", "").replace("\r", "").replace("\n", "")
            if not domain or not name:
                continue
            path = str(cookie.get("path") or "/").replace("\t", "").replace("\r", "").replace("\n", "")
            subdomains = "FALSE" if cookie.get("hostOnly") else "TRUE"
            secure = "TRUE" if cookie.get("secure") else "FALSE"
            expires = int(cookie.get("expirationDate") or 0)
            handle.write(f"{domain}\t{subdomains}\t{path}\t{secure}\t{expires}\t{name}\t{value}\n")
    return Path(raw_path)


def is_youtube_video_url(value):
    parsed = urlparse(value)
    return (parsed.scheme == "https" and parsed.netloc.lower() in {"www.youtube.com", "youtube.com", "m.youtube.com"}
            and parsed.path == "/watch" and "v=" in parsed.query)


def normalize_subtitle_track(value):
    """Accept only a language track reported by the current YouTube player."""
    if not isinstance(value, dict):
        return None
    language_code = str(value.get("languageCode") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", language_code):
        return None
    kind = "asr" if value.get("kind") == "asr" else "manual"
    return {"languageCode": language_code, "kind": kind}


def normalize_download_preset(value):
    """Accept only the format presets exposed by the page dialog."""
    preset = str(value or "1080").strip().lower()
    return preset if preset in DOWNLOAD_PRESETS else "1080"


def download_profile_for_preset(preset):
    """Return the fixed manual preset selected by the page dialog."""
    return DOWNLOAD_PRESETS.get(preset, DOWNLOAD_PRESETS["1080"])


def emit_task(task):
    task["updatedAt"] = int(time.time() * 1000)
    write_message({"event": "task", "task": task.copy()})


def decode_process_line(value):
    """Decode yt-dlp output from either UTF-8 or the Windows Chinese code page."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    for encoding in ("utf-8", "gb18030", "cp1252"):
        try:
            return value.decode(encoding)
        except UnicodeDecodeError:
            continue
    return value.decode("utf-8", errors="replace")


def codec_is_present(value):
    """Return whether a yt-dlp codec field identifies a real media stream."""
    return str(value or "").strip().lower() not in {"", "na", "none", "unknown"}


def progress_stream_kind(video_codec, audio_codec):
    """Classify a progress event as video, audio, or a combined media file."""
    has_video = codec_is_present(video_codec)
    has_audio = codec_is_present(audio_codec)
    if has_video and has_audio:
        return "combined"
    if has_audio:
        return "audio"
    return "video"


def format_download_speed(value):
    """Format yt-dlp's bytes-per-second value for the task UI."""
    raw = str(value or "").strip()
    if raw.lower() in {"", "na", "none", "unknown"}:
        return ""
    try:
        speed = float(raw)
    except (TypeError, ValueError):
        return raw
    if speed < 1024:
        return f"{speed:.0f} B/s"
    units = ("KiB/s", "MiB/s", "GiB/s", "TiB/s")
    scaled = speed
    for unit in units:
        scaled /= 1024
        if scaled < 1024 or unit == units[-1]:
            return f"{scaled:.1f} {unit}" if scaled < 10 else f"{scaled:.0f} {unit}"
    return ""


def format_download_eta(value):
    """Format yt-dlp's ETA seconds as a compact human-readable duration."""
    raw = str(value or "").strip()
    if raw.lower() in {"", "na", "none", "unknown", "inf", "infinite"}:
        return ""
    try:
        seconds = max(0, int(float(raw)))
    except (TypeError, ValueError):
        return raw
    if seconds < 60:
        return f"00:{seconds:02d}"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes:02d}:{seconds:02d}"
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def update_media_progress(task, stream_kind, progress, speed, eta):
    """Store per-stream progress while keeping a compatibility overall value."""
    media_type = task.get("mediaType", "video")
    if media_type == "audio":
        task["audioProgress"] = progress
        task["audioSpeed"] = speed
        task["audioEta"] = eta
        task["progress"] = progress
        task["speed"] = speed
        task["eta"] = eta
        return

    if stream_kind == "audio":
        task["audioProgress"] = progress
        task["audioSpeed"] = speed
        task["audioEta"] = eta
    elif stream_kind == "combined":
        task["videoProgress"] = progress
        task["audioProgress"] = progress
        task["videoSpeed"] = speed
        task["audioSpeed"] = speed
        task["videoEta"] = eta
        task["audioEta"] = eta
    else:
        task["videoProgress"] = progress
        task["videoSpeed"] = speed
        task["videoEta"] = eta

    video_progress = task.get("videoProgress")
    audio_progress = task.get("audioProgress")
    if video_progress is not None and audio_progress is not None:
        candidate_progress = round((video_progress + audio_progress) / 2, 1)
    elif video_progress is not None:
        candidate_progress = video_progress
    elif audio_progress is not None:
        candidate_progress = audio_progress
    else:
        candidate_progress = task.get("progress") or 0
    task["progress"] = max(float(task.get("progress") or 0), candidate_progress)
    task["speed"] = speed
    task["eta"] = eta


def run_download(task, command, subtitle_command=None, temporary_cookie_file=None):
    last_output = []
    try:
        options = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "text": False,
            "bufsize": 0,
            "close_fds": True,
        }
        if IS_WINDOWS:
            options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen(command, **options)
        log(f"yt-dlp started for task {task['id']} (pid={process.pid})")
        task["status"] = "downloading"
        emit_task(task)
        for line in process.stdout:
            text = decode_process_line(line).strip()
            if text.startswith("YT_DLP_PROGRESS|"):
                parts = text.split("|", 5)
                if len(parts) >= 6:
                    _, percent, speed, eta, video_codec, audio_codec = parts
                elif len(parts) == 5:
                    _, percent, eta, video_codec, audio_codec = parts
                    speed = ""
                else:
                    continue
                match = re.search(r"\d+(?:\.\d+)?", percent)
                if match:
                    progress = min(100, max(0, float(match.group())))
                    update_media_progress(
                        task,
                        progress_stream_kind(video_codec, audio_codec),
                        progress,
                        format_download_speed(speed),
                        format_download_eta(eta),
                    )
                emit_task(task)
            elif text.startswith("YT_DLP_PROGRESS:"):
                _, percent, eta = text.split(":", 2)
                match = re.search(r"\d+(?:\.\d+)?", percent)
                if match:
                    progress = min(100, max(0, float(match.group())))
                    update_media_progress(task, "video", progress, "", format_download_eta(eta))
                emit_task(task)
            elif text.startswith("YT_DLP_FILE:"):
                task["filePath"] = text.removeprefix("YT_DLP_FILE:")
                emit_task(task)
            elif text:
                last_output.append(text)
                last_output = last_output[-12:]
        exit_code = process.wait()
        if exit_code == 0:
            if subtitle_command:
                subtitle_output = []
                try:
                    subtitle_process = subprocess.Popen(subtitle_command, **options)
                    log(f"subtitle download started for task {task['id']} (pid={subtitle_process.pid})")
                    for line in subtitle_process.stdout:
                        text = decode_process_line(line).strip()
                        if text:
                            subtitle_output.append(text)
                            subtitle_output = subtitle_output[-8:]
                    subtitle_exit_code = subtitle_process.wait()
                    if subtitle_exit_code == 0:
                        task["subtitleStatus"] = "completed"
                        task.pop("subtitleError", None)
                    else:
                        raw = subtitle_output[-1] if subtitle_output else f"yt-dlp exited with code {subtitle_exit_code}"
                        task["subtitleStatus"] = "error"
                        task["subtitleError"] = humanize_error(raw)
                        log(f"subtitle download failed for task {task['id']} with exit code {subtitle_exit_code}: {' | '.join(subtitle_output[-3:])}")
                except Exception as subtitle_error:
                    task["subtitleStatus"] = "error"
                    task["subtitleError"] = humanize_error(str(subtitle_error))
                    log(f"subtitle download exception for task {task['id']}: {subtitle_error}")
            else:
                task["subtitleStatus"] = "skipped"
            task["status"] = "completed"
            task["progress"] = 100
            if task.get("mediaType") == "audio":
                task["audioProgress"] = 100
                task["audioSpeed"] = ""
                task["audioEta"] = ""
            else:
                task["videoProgress"] = 100
                task["audioProgress"] = 100
                task["videoSpeed"] = ""
                task["audioSpeed"] = ""
                task["videoEta"] = ""
                task["audioEta"] = ""
            task["speed"] = ""
            task["eta"] = ""
            task.pop("error", None)
        else:
            raw = last_output[-1] if last_output else f"yt-dlp exited with code {exit_code}"
            # Prefer more informative lines from the tail when the last line is too generic
            joined = "\n".join(last_output[-5:])
            task["status"] = "error"
            task["error"] = humanize_error(joined if len(joined) > len(raw) else raw)
            log(f"yt-dlp failed for task {task['id']} with exit code {exit_code}: {' | '.join(last_output[-3:])}")
        log(f"yt-dlp finished for task {task['id']} with exit code {exit_code}")
        emit_task(task)
    except Exception as error:
        log(f"yt-dlp process error for task {task['id']}: {error}")
        task["status"] = "error"
        task["error"] = humanize_error(str(error))
        emit_task(task)
    finally:
        if temporary_cookie_file:
            try:
                Path(temporary_cookie_file).unlink(missing_ok=True)
            except OSError:
                pass


def ensure_ytdlp_ready(configured_path, auto_install=True):
    """Resolve yt-dlp, optionally installing it when missing on a new device."""
    try:
        return resolve_ytdlp(configured_path)
    except ValueError:
        if not auto_install or configured_path:
            raise
        log("yt-dlp missing; attempting automatic pip install")
        ok, detail = install_ytdlp()
        log(f"auto-install yt-dlp: ok={ok} {detail.splitlines()[0] if detail else ''}")
        if not ok:
            raise ValueError(detail) from None
        return resolve_ytdlp(configured_path)


def queue_download(message):
    url = message.get("url", "")
    if not isinstance(url, str) or not is_youtube_video_url(url):
        raise ValueError(
            "仅支持标准 YouTube 视频链接。\n"
            "需要形如 https://www.youtube.com/watch?v=视频ID 的地址。\n"
            f"收到: {url or '(空)'}"
        )
    yt_dlp_cmd = ensure_ytdlp_ready(message.get("ytDlpPath", ""), auto_install=True)
    download_preset = normalize_download_preset(message.get("downloadPreset"))
    download_profile = download_profile_for_preset(download_preset)

    # Check runtime tools and keep a useful log entry before starting the task.
    diagnosis = diagnose_dependencies(message.get("ytDlpPath", ""))
    if not diagnosis["tools"]["node"]["ok"]:
        log("WARNING: Node.js missing; YouTube JS challenges may fail")
    if not diagnosis["tools"]["ffmpeg"]["ok"]:
        log("WARNING: FFmpeg missing; normal video downloads cannot be converted to MP4")

    browser_name = normalize_browser_name(message.get("browserName"))
    output_dir = Path(message.get("outputDirectory") or browser_download_directory(browser_name)).expanduser()
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ValueError(
            f"无法创建下载目录: {output_dir}\n原因: {error}\n请在扩展设置中更换可写的下载目录。"
        ) from error

    proxy_url = str(message.get("proxyUrl") or "").strip()
    if re.fullmatch(r"http://(?:127\.0\.0\.1|localhost):7890/?", proxy_url, re.IGNORECASE):
        proxy_url = "socks5h://127.0.0.1:7890"
    use_browser_cookies = message.get(
        "useBrowserCookies",
        message.get("useEdgeCookies", True),
    ) is not False
    cookies_file_path = str(message.get("cookiesFilePath") or "").strip()
    browser_cookies = message.get("browserCookies") or []
    if cookies_file_path and not Path(cookies_file_path).expanduser().is_file():
        raise ValueError(
            f"备用 cookies.txt 不存在: {cookies_file_path}\n"
            "请修正设置中的路径，或改用自动浏览器 Cookie。"
        )
    task = {
        "id": message["taskId"], "title": message.get("title") or "YouTube video", "url": url,
        "downloadPreset": download_preset, "formatLabel": download_profile["label"],
        "mediaType": "audio" if download_profile["audio_only"] else "video",
        "videoProgress": None if download_profile["audio_only"] else 0,
        "audioProgress": 0,
        "videoSpeed": "", "audioSpeed": "",
        "videoEta": "", "audioEta": "",
        "outputDirectory": str(output_dir), "status": "queued", "progress": 0,
        "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000),
    }
    # Options must come after the full launcher (yt-dlp.exe OR python -m yt_dlp).
    launcher_len = len(yt_dlp_cmd)
    option_block = [
        "--ignore-config", "--no-playlist", "--windows-filenames", "--newline",
        "--js-runtimes", "node", "--remote-components", "ejs:github",
        "--legacy-server-connect", "--socket-timeout", "20",
        "--retries", "10", "--fragment-retries", "10", "--extractor-retries", "5",
        "--retry-sleep", "extractor:1",
        "--retry-sleep", "http:exp=1:20", "--retry-sleep", "fragment:exp=1:20",
    ]
    postprocess_options = [] if download_profile["audio_only"] else [
        "--merge-output-format", "mp4", "--recode-video", "mp4",
    ]

    def inject_after_launcher(command, extra):
        """Insert CLI flags immediately after the yt-dlp launcher tokens."""
        if not command:
            return
        command[launcher_len:launcher_len] = extra

    command = [
        *yt_dlp_cmd, *option_block, *postprocess_options, "--format", download_profile["format"], "--progress",
        "--progress-template", "download:YT_DLP_PROGRESS|%(progress._percent_str)s|%(progress.speed)s|%(progress.eta)s|%(info.vcodec)s|%(info.acodec)s",
        "--print", "after_move:YT_DLP_FILE:%(filepath)s", "-P", str(output_dir), url,
    ]
    subtitle_track = normalize_subtitle_track(message.get("subtitleTrack"))
    subtitle_command = None
    if subtitle_track and not download_profile["audio_only"]:
        subtitle_flag = "--write-auto-subs" if subtitle_track["kind"] == "asr" else "--write-subs"
        subtitle_command = [
            *yt_dlp_cmd, *option_block, "--skip-download", subtitle_flag,
            "--sub-langs", subtitle_track["languageCode"], "--sub-format", "vtt/srt/best",
            "-P", str(output_dir), url,
        ]
    if proxy_url:
        for candidate in (command, subtitle_command):
            inject_after_launcher(candidate, ["--proxy", proxy_url])
    temporary_cookie_file = None
    if cookies_file_path:
        for candidate in (command, subtitle_command):
            inject_after_launcher(candidate, ["--cookies", str(Path(cookies_file_path).expanduser())])
    elif browser_cookies:
        temporary_cookie_file = write_browser_cookies(browser_cookies)
        for candidate in (command, subtitle_command):
            inject_after_launcher(candidate, ["--cookies", str(temporary_cookie_file)])
    elif use_browser_cookies:
        for candidate in (command, subtitle_command):
            inject_after_launcher(candidate, ["--cookies-from-browser", browser_name])
    subtitle_summary = "none"
    if subtitle_track:
        subtitle_summary = "skipped-audio" if download_profile["audio_only"] else f"{subtitle_track['languageCode']}/{subtitle_track['kind']}"
    log(
        f"Queued task {task['id']} (output={output_dir}, preset={download_preset}, subtitles={subtitle_summary}, "
        f"proxy={bool(proxy_url)}, cookiesFile={bool(cookies_file_path)}, "
        f"browserCookies={len(browser_cookies)}, "
        f"browser={browser_name}, "
        f"browserCookiesFallback={use_browser_cookies and not cookies_file_path and not browser_cookies}, "
        f"ytdlp={' '.join(yt_dlp_cmd)})"
    )
    emit_task(task)
    threading.Thread(target=run_download, args=(task, command, subtitle_command, temporary_cookie_file), daemon=True).start()


def main():
    log(f"Native bridge {BRIDGE_VERSION} started (python={sys.executable})")
    while True:
        try:
            message = read_message()
            if message is None:
                log("Native bridge closed by browser")
                return
            action = message.get("action")
            log(f"Received action: {action}")
            if action == "ping":
                diagnosis = diagnose_dependencies(message.get("ytDlpPath", ""))
                ytdlp_detail = diagnosis["tools"]["ytdlp"]["detail"]
                write_message({
                    "event": "pong",
                    "ok": True,
                    "ytDlp": ytdlp_detail,
                    "bridgeVersion": BRIDGE_VERSION,
                    "diagnosis": diagnosis,
                })
            elif action == "diagnose":
                diagnosis = diagnose_dependencies(message.get("ytDlpPath", ""))
                write_message({"event": "diagnosis", "ok": diagnosis["ok"], "diagnosis": diagnosis})
            elif action == "install-tools":
                # Install may take minutes; run on a worker and reply when done.
                def worker():
                    try:
                        result = install_missing_tools(auto_only_ytdlp=bool(message.get("ytdlpOnly")))
                        write_message({
                            "event": "install-result",
                            "ok": result["ok"],
                            "message": result["message"],
                            "steps": result["steps"],
                            "diagnosis": result["diagnosis"],
                            "requestId": message.get("requestId"),
                        })
                    except Exception as error:
                        log(f"install-tools error: {error}")
                        write_message({
                            "event": "install-result",
                            "ok": False,
                            "message": humanize_error(str(error)),
                            "requestId": message.get("requestId"),
                        })
                threading.Thread(target=worker, daemon=True).start()
            elif action == "download":
                try:
                    queue_download(message)
                except Exception as error:
                    emit_task({
                        "id": message.get("taskId", "unknown"), "title": message.get("title", "YouTube video"),
                        "status": "error", "progress": 0, "error": humanize_error(str(error)),
                        "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000),
                    })
        except Exception as error:
            log(f"Bridge error: {error}")
            write_message({"event": "bridge-error", "error": humanize_error(str(error))})


if __name__ == "__main__":
    main()
