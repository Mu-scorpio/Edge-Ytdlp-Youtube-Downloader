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
BRIDGE_VERSION = "1.1.0"


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


def resolve_ytdlp(configured_path):
    if configured_path:
        candidate = Path(configured_path).expanduser()
        if candidate.is_file():
            return str(candidate)
        raise ValueError("Configured yt-dlp.exe path was not found")
    found = shutil.which("yt-dlp.exe") or shutil.which("yt-dlp")
    if not found:
        raise ValueError("yt-dlp.exe was not found in PATH; set its full path in the extension settings")
    return found


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


def emit_task(task):
    task["updatedAt"] = int(time.time() * 1000)
    write_message({"event": "task", "task": task.copy()})


def run_download(task, command, temporary_cookie_file=None):
    last_output = []
    try:
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=creation_flags, close_fds=True,
        )
        log(f"yt-dlp started for task {task['id']} (pid={process.pid})")
        task["status"] = "downloading"
        emit_task(task)
        for line in process.stdout:
            text = line.strip()
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
                last_output = last_output[-8:]
        exit_code = process.wait()
        if exit_code == 0:
            task["status"] = "completed"
            task["progress"] = 100
            task.pop("error", None)
        else:
            task["status"] = "error"
            task["error"] = last_output[-1] if last_output else f"yt-dlp exited with code {exit_code}"
        log(f"yt-dlp finished for task {task['id']} with exit code {exit_code}")
        emit_task(task)
    except Exception as error:
        log(f"yt-dlp process error for task {task['id']}: {error}")
        task["status"] = "error"
        task["error"] = str(error)
        emit_task(task)
    finally:
        if temporary_cookie_file:
            try:
                Path(temporary_cookie_file).unlink(missing_ok=True)
            except OSError:
                pass


def queue_download(message):
    url = message.get("url", "")
    if not isinstance(url, str) or not is_youtube_video_url(url):
        raise ValueError("Only youtube.com/watch video URLs are allowed")
    yt_dlp = resolve_ytdlp(message.get("ytDlpPath", ""))
    output_dir = Path(message.get("outputDirectory") or browser_download_directory()).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)
    proxy_url = str(message.get("proxyUrl") or "").strip()
    if re.fullmatch(r"http://(?:127\.0\.0\.1|localhost):7890/?", proxy_url, re.IGNORECASE):
        proxy_url = "socks5h://127.0.0.1:7890"
    use_edge_cookies = message.get("useEdgeCookies", True) is not False
    cookies_file_path = str(message.get("cookiesFilePath") or "").strip()
    browser_cookies = message.get("browserCookies") or []
    if cookies_file_path and not Path(cookies_file_path).expanduser().is_file():
        raise ValueError("Configured cookies.txt file was not found")
    task = {
        "id": message["taskId"], "title": message.get("title") or "YouTube video", "url": url,
        "outputDirectory": str(output_dir), "status": "queued", "progress": 0,
        "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000),
    }
    command = [
        yt_dlp, "--ignore-config", "--no-playlist", "--windows-filenames", "--newline", "--progress",
        "--js-runtimes", "node", "--remote-components", "ejs:github",
        "--legacy-server-connect", "--socket-timeout", "20",
        "--retries", "10", "--fragment-retries", "10", "--extractor-retries", "5",
        "--retry-sleep", "extractor:1",
        "--progress-template", "download:YT_DLP_PROGRESS:%(progress._percent_str)s:%(progress.eta)s",
        "--print", "after_move:YT_DLP_FILE:%(filepath)s", "-P", str(output_dir), url,
    ]
    if proxy_url:
        command[1:1] = ["--proxy", proxy_url]
    temporary_cookie_file = None
    if cookies_file_path:
        command[1:1] = ["--cookies", str(Path(cookies_file_path).expanduser())]
    elif browser_cookies:
        temporary_cookie_file = write_browser_cookies(browser_cookies)
        command[1:1] = ["--cookies", str(temporary_cookie_file)]
    elif use_edge_cookies:
        command[1:1] = ["--cookies-from-browser", "edge"]
    log(f"Queued task {task['id']} (output={output_dir}, proxy={bool(proxy_url)}, cookiesFile={bool(cookies_file_path)}, browserCookies={len(browser_cookies)}, edgeCookies={use_edge_cookies and not cookies_file_path and not browser_cookies})")
    emit_task(task)
    threading.Thread(target=run_download, args=(task, command, temporary_cookie_file), daemon=True).start()


def main():
    log(f"Native bridge {BRIDGE_VERSION} started")
    while True:
        try:
            message = read_message()
            if message is None:
                log("Native bridge closed by Edge")
                return
            action = message.get("action")
            log(f"Received action: {action}")
            if action == "ping":
                try:
                    value = resolve_ytdlp("")
                except ValueError:
                    value = "yt-dlp path can be set in extension settings"
                write_message({"event": "pong", "ok": True, "ytDlp": value, "bridgeVersion": BRIDGE_VERSION})
            elif action == "download":
                try:
                    queue_download(message)
                except Exception as error:
                    emit_task({
                        "id": message.get("taskId", "unknown"), "title": message.get("title", "YouTube video"),
                        "status": "error", "progress": 0, "error": str(error),
                        "createdAt": int(time.time() * 1000), "updatedAt": int(time.time() * 1000),
                    })
        except Exception as error:
            log(f"Bridge error: {error}")
            write_message({"event": "bridge-error", "error": str(error)})


if __name__ == "__main__":
    main()
