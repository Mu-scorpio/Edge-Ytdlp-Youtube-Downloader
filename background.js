const NATIVE_HOST = "com.local.ytdlp_downloader";
const DEFAULTS = { ytDlpPath: "", outputDirectory: "", proxyUrl: "socks5h://127.0.0.1:7890", autoUseBrowserCookies: true, cookiesFilePath: "" };
const MAX_SAVED_TASKS = 30;
const DEBUG_LOG_KEY = "debugLog";
const MAX_DEBUG_ENTRIES = 120;

let nativePort = null;
let bridgeError = "";
let bridgeReady = false;
let bridgeWaiters = [];
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
    settleBridgeWaiters(true);
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
      bridgeError = chrome.runtime.lastError?.message || "本机桥接器已断开";
      debug("native-disconnected", { error: bridgeError });
      bridgeReady = false;
      settleBridgeWaiters(false);
      nativePort = null;
      failActiveTasks(bridgeError);
    });
    nativePort.postMessage({ action: "ping" });
    debug("native-ping-sent");
    bridgeError = "";
    return nativePort;
  } catch (error) {
    bridgeError = error.message || "无法连接本机桥接器";
    debug("native-connect-threw", { error: bridgeError });
    nativePort = null;
    return null;
  }
}

async function waitForBridge() {
  if (bridgeReady) return true;
  if (!ensureNativePort()) return false;
  if (bridgeReady) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      bridgeWaiters = bridgeWaiters.filter((waiter) => waiter !== finish);
      debug("native-ping-timeout", { timeoutMs: 1600, bridgeError });
      resolve(false);
    }, 1600);
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

async function startDownload(message) {
  await taskStoreReady;
  const settings = await chrome.storage.local.get(DEFAULTS);
  const browserCookies = settings.autoUseBrowserCookies ? await readYouTubeCookies() : [];
  debug("download-request", { proxyConfigured: Boolean(settings.proxyUrl), autoBrowserCookies: settings.autoUseBrowserCookies, browserCookieCount: browserCookies.length, cookiesFileConfigured: Boolean(settings.cookiesFilePath) });
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
    task.error = bridgeError || "本机桥接器未在 1.6 秒内响应";
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
      sendResponse({ ok: connected, tasks: [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt), bridgeError: bridgeError || (connected ? "" : "本机桥接器未响应") });
      return;
    }
    if (message.type === "ping") {
      const connected = await waitForBridge();
      sendResponse({ ok: connected, error: bridgeError || (connected ? "" : "本机桥接器未响应") });
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
