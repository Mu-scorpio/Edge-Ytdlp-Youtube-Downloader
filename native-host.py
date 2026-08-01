#!/usr/bin/env python3
"""Persistent Windows native-messaging bridge with yt-dlp progress events."""
import json
import os
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
LOG_PATH = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "YT-DLP-Edge" / "bridge.log"
BRIDGE_VERSION = "1.4.0"
INSTALL_LOCK = threading.Lock()


def log(message):
    """Diagnostics only; native-messaging stdout must remain protocol-only."""
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


def browser_download_directory():
    """Read Edge's configured download directory, with the Windows default as fallback."""
    preferences = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Edge" / "User Data" / "Default" / "Preferences"
    try:
        contents = preferences.read_text(encoding="utf-8", errors="ignore")
        match = re.search(r'"default_directory"\s*:\s*"((?:\\.|[^"\\])*)"', contents)
        if match:
            configured = json.loads(f'"{match.group(1)}"').strip()
            if configured:
                return Path(configured).expanduser()
    except OSError:
        pass
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
    """Run a process hidden on Windows and capture combined output."""
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            creationflags=creation_flags,
            check=False,
        )
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
            "设置中的 yt-dlp.exe 路径不存在。\n"
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
        '  py -m pip install --user --upgrade "yt-dlp[default]"\n'
        "也可在设置中填写 yt-dlp.exe 的完整路径。"
    )


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
        "installHint": 'winget install -e --id OpenJS.NodeJS.LTS',
    }

    # FFmpeg (merge high quality streams)
    ffmpeg_path = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    ffmpeg_version = None
    if ffmpeg_path:
        raw = tool_version([ffmpeg_path, "-version"])
        if raw:
            ffmpeg_version = raw.split("Copyright")[0].strip() or raw
    tools["ffmpeg"] = {
        "ok": bool(ffmpeg_version),
        "label": "FFmpeg",
        "detail": f"{ffmpeg_version} ({ffmpeg_path})" if ffmpeg_version else "未找到（高画质音视频合并需要）",
        "required": False,
        "installHint": "winget install -e --id Gyan.FFmpeg",
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


def install_ytdlp():
    command = [sys.executable, "-m", "pip", "install", "--user", "--upgrade", "yt-dlp[default]"]
    log(f"Installing yt-dlp: {' '.join(command)}")
    code, output = run_capture(command, timeout=600)
    tail = "\n".join(output.splitlines()[-12:])
    if code != 0:
        return False, f"安装 yt-dlp 失败（退出码 {code}）。\n{tail}\n请手动执行: py -m pip install --user --upgrade \"yt-dlp[default]\""
    # Clear path cache after install
    try:
        resolve_ytdlp("")
        return True, f"yt-dlp 已安装/升级。\n{tail}"
    except ValueError:
        return True, (
            "pip 已完成，但当前进程仍可能找不到 yt-dlp 脚本目录。\n"
            "扩展会优先使用 python -m yt_dlp。若仍失败，请重新加载扩展或注销后再试。\n"
            f"{tail}"
        )


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
                ok, detail = install_with_winget("OpenJS.NodeJS.LTS", "Node.js LTS", ["node", "node.exe"])
                steps.append({"tool": "node", "ok": ok, "detail": detail})
                overall_ok = overall_ok and ok
            else:
                steps.append({"tool": "node", "ok": True, "detail": "已存在，跳过"})

            if not before["tools"]["ffmpeg"]["ok"]:
                ok, detail = install_with_winget("Gyan.FFmpeg", "FFmpeg", ["ffmpeg", "ffmpeg.exe"])
                steps.append({"tool": "ffmpeg", "ok": ok, "detail": detail})
                # FFmpeg is optional for basic downloads
                if not ok:
                    steps[-1]["detail"] += "\n（FFmpeg 可选：无合并时部分高画质任务可能失败）"
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
        return "下载失败，但未捕获到具体错误输出。请查看桥接日志 %LOCALAPPDATA%\\YT-DLP-Edge\\bridge.log"

    patterns = [
        (
            r"Sign in to confirm you.?re not a bot|confirm you.?re not a bot",
            "YouTube 要求登录验证（机器人检测）。\n"
            "处理建议：\n"
            "1. 在 Edge 打开 youtube.com 并确保已登录；\n"
            "2. 扩展设置中保持「自动使用 Edge Cookie」开启；\n"
            "3. 确认代理出口与浏览器一致（默认 socks5h://127.0.0.1:7890）；\n"
            "4. 刷新页面后重试。",
        ),
        (
            r"Requested format is not available|Only images are available|storyboard",
            "未拿到可用视频格式（常见于 yt-dlp/EJS 过旧或 JS 挑战失败）。\n"
            "处理建议：\n"
            "1. 扩展弹窗点击「安装缺失工具」升级 yt-dlp[default]；\n"
            "2. 确认已安装 Node.js；\n"
            "3. 手动: py -m pip install --user --upgrade \"yt-dlp[default]\"",
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
            "FFmpeg 不可用，高画质音视频无法合并。\n"
            "请点击扩展弹窗「安装缺失工具」，或执行: winget install -e --id Gyan.FFmpeg",
        ),
        (
            r"node(\.exe)?.*(not found|不是内部或外部命令|No such file)|js runtime|JavaScript runtime",
            "未找到 Node.js，无法处理 YouTube JavaScript 挑战。\n"
            "请点击「安装缺失工具」，或执行: winget install -e --id OpenJS.NodeJS.LTS",
        ),
        (
            r"yt-dlp.*(not found|不是内部或外部命令)|No such file or directory.*yt-dlp",
            "未找到 yt-dlp。\n请点击「安装缺失工具」，或: py -m pip install --user --upgrade \"yt-dlp[default]\"",
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
    """Write Chrome cookie API values as a disposable Netscape cookie file."""
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


def run_download(task, command, subtitle_command=None, temporary_cookie_file=None):
    last_output = []
    try:
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=False, bufsize=0,
            creationflags=creation_flags, close_fds=True,
        )
        log(f"yt-dlp started for task {task['id']} (pid={process.pid})")
        task["status"] = "downloading"
        emit_task(task)
        for line in process.stdout:
            text = decode_process_line(line).strip()
            if text.startswith("YT_DLP_PROGRESS:"):
                _, percent, eta = text.split(":", 2)
                match = re.search(r"\d+(?:\.\d+)?", percent)
                if match:
                    task["progress"] = min(100, max(0, float(match.group())))
                task["eta"] = "" if eta == "NA" else eta
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
                    subtitle_process = subprocess.Popen(
                        subtitle_command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=False, bufsize=0,
                        creationflags=creation_flags, close_fds=True,
                    )
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

    # Soft-check optional tools and log; node is strongly recommended
    diagnosis = diagnose_dependencies(message.get("ytDlpPath", ""))
    if not diagnosis["tools"]["node"]["ok"]:
        log("WARNING: Node.js missing; YouTube JS challenges may fail")
    if not diagnosis["tools"]["ffmpeg"]["ok"]:
        log("WARNING: FFmpeg missing; high-quality merges may fail")

    output_dir = Path(message.get("outputDirectory") or browser_download_directory()).expanduser()
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ValueError(
            f"无法创建下载目录: {output_dir}\n原因: {error}\n请在扩展设置中更换可写的下载目录。"
        ) from error

    proxy_url = str(message.get("proxyUrl") or "").strip()
    if re.fullmatch(r"http://(?:127\.0\.0\.1|localhost):7890/?", proxy_url, re.IGNORECASE):
        proxy_url = "socks5h://127.0.0.1:7890"
    use_edge_cookies = message.get("useEdgeCookies", True) is not False
    cookies_file_path = str(message.get("cookiesFilePath") or "").strip()
    browser_cookies = message.get("browserCookies") or []
    if cookies_file_path and not Path(cookies_file_path).expanduser().is_file():
        raise ValueError(
            f"备用 cookies.txt 不存在: {cookies_file_path}\n"
            "请修正设置中的路径，或改用自动 Edge Cookie。"
        )
    task = {
        "id": message["taskId"], "title": message.get("title") or "YouTube video", "url": url,
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

    def inject_after_launcher(command, extra):
        """Insert CLI flags immediately after the yt-dlp launcher tokens."""
        if not command:
            return
        command[launcher_len:launcher_len] = extra

    command = [
        *yt_dlp_cmd, *option_block, "--progress",
        "--progress-template", "download:YT_DLP_PROGRESS:%(progress._percent_str)s:%(progress.eta)s",
        "--print", "after_move:YT_DLP_FILE:%(filepath)s", "-P", str(output_dir), url,
    ]
    subtitle_track = normalize_subtitle_track(message.get("subtitleTrack"))
    subtitle_command = None
    if subtitle_track:
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
    elif use_edge_cookies:
        for candidate in (command, subtitle_command):
            inject_after_launcher(candidate, ["--cookies-from-browser", "edge"])
    subtitle_summary = "none"
    if subtitle_track:
        subtitle_summary = f"{subtitle_track['languageCode']}/{subtitle_track['kind']}"
    log(
        f"Queued task {task['id']} (output={output_dir}, subtitles={subtitle_summary}, "
        f"proxy={bool(proxy_url)}, cookiesFile={bool(cookies_file_path)}, "
        f"browserCookies={len(browser_cookies)}, "
        f"edgeCookies={use_edge_cookies and not cookies_file_path and not browser_cookies}, "
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
                log("Native bridge closed by Edge")
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
