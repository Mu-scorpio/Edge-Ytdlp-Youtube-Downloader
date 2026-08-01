const NATIVE_HOST = "com.local.ytdlp_downloader";
const DEFAULTS = { ytDlpPath: "", outputDirectory: "", proxyUrl: "socks5h://127.0.0.1:7890", autoUseBrowserCookies: true, cookiesFilePath: "" };
const MAX_SAVED_TASKS = 30;
const DEBUG_LOG_KEY = "debugLog";
const MAX_DEBUG_ENTRIES = 120;

let nativePort = null;
let bridgeError = "";
let bridgeReady = false;
let bridgeVersion = "";
let bridgeDiagnosis = null;
let bridgeYtDlp = "";
let bridgeWaiters = [];
const pendingInstall = new Map();
let debugQueue = Promise.resolve();
const tasks = new Map();
const taskStoreReady = chrome.storage.local.get({ downloadTasks: [] }).then(({ downloadTasks }) => {
  const restored = downloadTasks.map((task) => {
    if (["connecting", "queued", "downloading"].includes(task.status)) {
      return { ...task, status: "error", error: "扩展已重载，无法继续追踪此前的任务；请重新点击下载", updatedAt: Date.now() };
    }
    return task;
  });
  for (const task of restored) tasks.set(task.id, task);
  return chrome.storage.local.set({ downloadTasks: restored });
});

function debug(event, detail = {}) {
  const entry = { at: new Date().toISOString(), source: "background", event, detail };
  debugQueue = debugQueue.then(async () => {
    const { [DEBUG_LOG_KEY]: existing = [] } = await chrome.storage.local.get({ [DEBUG_LOG_KEY]: [] });
    const next = [...existing, entry].slice(-MAX_DEBUG_ENTRIES);
    await chrome.storage.local.set({ [DEBUG_LOG_KEY]: next });
    chrome.runtime.sendMessage({ type: "debug-update", entry }).catch(() => {});
  }).catch(() => {});
  return debugQueue;
}

debug("service-worker-started", { extensionId: chrome.runtime.id });

function taskId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function explainBridgeDisconnect(raw) {
  const message = String(raw || "").trim();
  const lower = message.toLowerCase();
  if (!message) {
    return (
      "本机桥接器已断开。\n" +
      "请在扩展目录运行: .\\setup-native-host.ps1 -ExtensionId \"" + chrome.runtime.id + "\"\n" +
      "然后在 edge://extensions 重新加载扩展。"
    );
  }
  if (/Specified native messaging host not found|host not found/i.test(message) || lower.includes("not found")) {
    return (
      "未找到本机桥接器（Native Messaging Host）。\n" +
      "新设备需要先注册桥接：\n" +
      "1. 在扩展目录打开 PowerShell\n" +
      "2. 运行 .\\setup-native-host.ps1 -ExtensionId \"" + chrome.runtime.id + "\"\n" +
      "3. 脚本会自动安装缺失的 yt-dlp / Node / FFmpeg（若可用 winget）\n" +
      "4. 在 edge://extensions 重新加载扩展并刷新 YouTube 页面\n" +
      `原始错误: ${message}`
    );
  }
  if (/Access to the specified native messaging host is forbidden|forbidden/i.test(message)) {
    return (
      "本机桥接器拒绝连接（扩展 ID 不匹配）。\n" +
      "请用当前扩展 ID 重新注册：\n" +
      ".\\setup-native-host.ps1 -ExtensionId \"" + chrome.runtime.id + "\"\n" +
      `原始错误: ${message}`
    );
  }
  if (/Native host has exited|host.*exited|Broken pipe/i.test(message)) {
    return (
      "本机桥接进程异常退出。\n" +
      "常见原因：Python 路径失效、native-host.py 被移动、或启动器损坏。\n" +
      "请重新运行 setup-native-host.ps1，并查看 %LOCALAPPDATA%\\YT-DLP-Edge\\bridge.log\n" +
      `原始错误: ${message}`
    );
  }
  return `${message}\n若刚换电脑或移动了扩展目录，请重新运行 setup-native-host.ps1。`;
}

async function persistTasks() {
  await taskStoreReady;
  const recent = [...tasks.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SAVED_TASKS);
  tasks.clear();
  for (const task of recent) tasks.set(task.id, task);
  await chrome.storage.local.set({ downloadTasks: recent });
}

async function publishTask(task) {
  task.updatedAt = Date.now();
  tasks.set(task.id, task);
  await persistTasks();
  chrome.runtime.sendMessage({ type: "download-update", task }).catch(() => {});
}

async function failActiveTasks(error) {
  await taskStoreReady;
  const active = [...tasks.values()].filter((task) => ["connecting", "queued", "downloading"].includes(task.status));
  await Promise.all(active.map((task) => publishTask({ ...task, status: "error", error })));
}

function settleBridgeWaiters(connected) {
  const waiters = bridgeWaiters;
  bridgeWaiters = [];
  for (const waiter of waiters) waiter(connected);
}

function handleNativeMessage(message) {
  debug("native-message", { event: message?.event || "missing-event", hasTask: Boolean(message?.task?.id) });
  if (message?.event === "task" && message.task?.id) {
    publishTask(message.task);
  }
  if (message?.event === "pong") {
    bridgeError = "";
    bridgeReady = true;
    bridgeVersion = message.bridgeVersion || "";
    bridgeYtDlp = message.ytDlp || "";
    bridgeDiagnosis = message.diagnosis || null;
    settleBridgeWaiters(true);
  }
  if (message?.event === "diagnosis") {
    bridgeDiagnosis = message.diagnosis || null;
  }
  if (message?.event === "install-result") {
    const requestId = message.requestId;
    if (requestId && pendingInstall.has(requestId)) {
      const settle = pendingInstall.get(requestId);
      pendingInstall.delete(requestId);
      settle(message);
    }
    if (message.diagnosis) bridgeDiagnosis = message.diagnosis;
    chrome.runtime.sendMessage({ type: "install-update", result: message }).catch(() => {});
  }
  if (message?.event === "bridge-error") {
    bridgeError = message.error || "本机桥接器内部错误";
    debug("native-bridge-error", { error: bridgeError });
  }
}

function ensureNativePort() {
  if (nativePort) {
    debug("native-port-reused", { bridgeReady });
    return nativePort;
  }
  try {
    bridgeReady = false;
    debug("native-connect-attempt", { host: NATIVE_HOST });
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    debug("native-port-created");
    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(() => {
      const raw = chrome.runtime.lastError?.message || "";
      bridgeError = explainBridgeDisconnect(raw);
      debug("native-disconnected", { error: bridgeError, raw });
      bridgeReady = false;
      bridgeVersion = "";
      settleBridgeWaiters(false);
      for (const [id, settle] of pendingInstall) {
        settle({ ok: false, message: bridgeError, requestId: id });
      }
      pendingInstall.clear();
      nativePort = null;
      failActiveTasks(bridgeError);
    });
    nativePort.postMessage({ action: "ping" });
    debug("native-ping-sent");
    bridgeError = "";
    return nativePort;
  } catch (error) {
    bridgeError = explainBridgeDisconnect(error.message || "无法连接本机桥接器");
    debug("native-connect-threw", { error: bridgeError });
    nativePort = null;
    return null;
  }
}

async function waitForBridge(timeoutMs = 2500) {
  if (bridgeReady) return true;
  if (!ensureNativePort()) return false;
  if (bridgeReady) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      bridgeWaiters = bridgeWaiters.filter((waiter) => waiter !== finish);
      debug("native-ping-timeout", { timeoutMs, bridgeError });
      if (!bridgeError) {
        bridgeError = (
          `本机桥接器未在 ${timeoutMs / 1000} 秒内响应。\n` +
          "请确认已运行 setup-native-host.ps1，Python 可用，并查看 bridge.log。"
        );
      }
      resolve(false);
    }, timeoutMs);
    const finish = (connected) => {
      clearTimeout(timeout);
      resolve(connected);
    };
    bridgeWaiters.push(finish);
  });
}

async function readYouTubeCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "youtube.com" });
    return cookies.map(({ domain, hostOnly, path, secure, expirationDate, name, value }) => ({
      domain, hostOnly, path, secure, expirationDate, name, value
    }));
  } catch (error) {
    debug("youtube-cookie-read-failed", { error: error.message || String(error) });
    return [];
  }
}

function bridgeStatusPayload(connected) {
  return {
    ok: connected,
    bridgeError: bridgeError || (connected ? "" : "本机桥接器未响应"),
    bridgeVersion,
    ytDlp: bridgeYtDlp,
    diagnosis: bridgeDiagnosis,
    extensionId: chrome.runtime.id,
    setupCommand: `.\\setup-native-host.ps1 -ExtensionId "${chrome.runtime.id}"`
  };
}

async function startDownload(message) {
  await taskStoreReady;
  const settings = await chrome.storage.local.get(DEFAULTS);
  const browserCookies = settings.autoUseBrowserCookies ? await readYouTubeCookies() : [];
  debug("download-request", {
    proxyConfigured: Boolean(settings.proxyUrl),
    autoBrowserCookies: settings.autoUseBrowserCookies,
    browserCookieCount: browserCookies.length,
    cookiesFileConfigured: Boolean(settings.cookiesFilePath),
    subtitleTrack: message.subtitleTrack || null
  });
  const task = {
    id: taskId(),
    title: message.title || "YouTube video",
    url: message.url,
    outputDirectory: settings.outputDirectory || "默认：Edge 浏览器下载目录",
    status: "connecting",
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  await publishTask(task);
  debug("download-task-created", { taskId: task.id });

  const connected = await waitForBridge();
  const port = nativePort;
  if (!connected || !port) {
    task.status = "error";
    task.error = bridgeError || "本机桥接器未响应";
    await publishTask(task);
    debug("download-bridge-unavailable", { taskId: task.id, error: task.error });
    return { ok: false, error: task.error };
  }

  try {
    task.status = "queued";
    await publishTask(task);
    port.postMessage({
      action: "download",
      taskId: task.id,
      title: task.title,
      url: task.url,
      subtitleTrack: message.subtitleTrack || null,
      ytDlpPath: settings.ytDlpPath.trim(),
      outputDirectory: settings.outputDirectory.trim(),
      proxyUrl: normalizeProxyUrl(settings.proxyUrl),
      useEdgeCookies: false,
      cookiesFilePath: settings.cookiesFilePath.trim(),
      browserCookies
    });
    debug("download-sent-to-native", { taskId: task.id });
    return { ok: true, task };
  } catch (error) {
    task.status = "error";
    task.error = error.message || "无法发送下载任务";
    await publishTask(task);
    debug("download-post-failed", { taskId: task.id, error: task.error });
    return { ok: false, error: task.error };
  }
}

async function requestDiagnosis() {
  const connected = await waitForBridge();
  if (!connected || !nativePort) {
    return { ok: false, ...bridgeStatusPayload(false) };
  }
  const settings = await chrome.storage.local.get(DEFAULTS);
  nativePort.postMessage({ action: "diagnose", ytDlpPath: settings.ytDlpPath.trim() });
  // Wait briefly for diagnosis event; fall back to last pong diagnosis.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    ok: true,
    ...bridgeStatusPayload(true),
    diagnosis: bridgeDiagnosis
  };
}

async function requestInstallTools(ytdlpOnly = false) {
  const connected = await waitForBridge(4000);
  if (!connected || !nativePort) {
    return {
      ok: false,
      message: bridgeError || "无法连接本机桥接器，请先运行 setup-native-host.ps1",
      ...bridgeStatusPayload(false)
    };
  }
  const requestId = taskId();
  const resultPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingInstall.delete(requestId);
      resolve({
        ok: false,
        message: "安装超时（超过 15 分钟）。请查看 bridge.log 或在 PowerShell 中手动安装依赖。",
        requestId
      });
    }, 15 * 60 * 1000);
    pendingInstall.set(requestId, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
  nativePort.postMessage({ action: "install-tools", requestId, ytdlpOnly: Boolean(ytdlpOnly) });
  debug("install-tools-sent", { requestId, ytdlpOnly });
  const result = await resultPromise;
  if (result.diagnosis) bridgeDiagnosis = result.diagnosis;
  return {
    ok: Boolean(result.ok),
    message: result.message || (result.ok ? "安装完成" : "安装失败"),
    steps: result.steps || [],
    diagnosis: result.diagnosis || bridgeDiagnosis,
    ...bridgeStatusPayload(bridgeReady)
  };
}

function normalizeProxyUrl(value) {
  const proxyUrl = String(value || "").trim();
  if (/^http:\/\/(?:127\.0\.0\.1|localhost):7890\/?$/i.test(proxyUrl)) {
    return "socks5h://127.0.0.1:7890";
  }
  return proxyUrl;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;
  (async () => {
    if (message.type === "debug-log") {
      const entry = { at: new Date().toISOString(), source: message.source || "content", event: message.event || "event", detail: message.detail || {} };
      const { [DEBUG_LOG_KEY]: existing = [] } = await chrome.storage.local.get({ [DEBUG_LOG_KEY]: [] });
      const next = [...existing, entry].slice(-MAX_DEBUG_ENTRIES);
      await chrome.storage.local.set({ [DEBUG_LOG_KEY]: next });
      chrome.runtime.sendMessage({ type: "debug-update", entry }).catch(() => {});
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "get-debug-log") {
      const { [DEBUG_LOG_KEY]: entries = [] } = await chrome.storage.local.get({ [DEBUG_LOG_KEY]: [] });
      sendResponse({ ok: true, entries });
      return;
    }
    if (message.type === "clear-debug-log") {
      await chrome.storage.local.set({ [DEBUG_LOG_KEY]: [] });
      sendResponse({ ok: true });
      return;
    }
    debug("runtime-message", { type: message.type || "unknown" });
    if (message.type === "download") {
      sendResponse(await startDownload(message));
      return;
    }
    if (message.type === "get-downloads") {
      await taskStoreReady;
      const connected = await waitForBridge();
      sendResponse({
        ...bridgeStatusPayload(connected),
        tasks: [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      });
      return;
    }
    if (message.type === "ping") {
      const connected = await waitForBridge();
      sendResponse({
        ...bridgeStatusPayload(connected),
        error: bridgeError || (connected ? "" : "本机桥接器未响应")
      });
      return;
    }
    if (message.type === "diagnose") {
      sendResponse(await requestDiagnosis());
      return;
    }
    if (message.type === "install-tools") {
      sendResponse(await requestInstallTools(message.ytdlpOnly));
      return;
    }
    if (message.type === "get-setup-info") {
      sendResponse({
        ok: true,
        extensionId: chrome.runtime.id,
        setupCommand: `.\\setup-native-host.ps1 -ExtensionId "${chrome.runtime.id}"`
      });
      return;
    }
    if (message.type === "clear-downloads") {
      await taskStoreReady;
      for (const [id, task] of tasks) {
        if (["completed", "error"].includes(task.status)) tasks.delete(id);
      }
      await persistTasks();
      sendResponse({ ok: true });
    }
  })().catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
