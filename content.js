const BUTTON_CLASS = "ytdlp-download-button";
const SURFACE_ATTRIBUTE = "data-ytdlp-surface";
const SUBTITLE_BRIDGE_SOURCE = "yt-dlp-edge-subtitle-bridge-v1";
let toastElement;
let toastHideTimer;
let toastResetTimer;
const taskPollers = new Map();
const subtitleResolvers = new Map();
let subtitleBridgePromise;
let extensionContextAlive = true;

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== SUBTITLE_BRIDGE_SOURCE
      || event.data.type !== "active-subtitle-response") return;
  const resolver = subtitleResolvers.get(event.data.requestId);
  if (!resolver) return;
  subtitleResolvers.delete(event.data.requestId);
  resolver(event.data.track || null);
});

function diagnostic(event, detail = {}) {
  safeRuntimeMessage({ type: "debug-log", source: "content", event, detail });
}

function safeRuntimeMessage(message) {
  if (!extensionContextAlive) return Promise.resolve(null);
  try {
    return chrome.runtime.sendMessage(message).catch((error) => {
      if (/Extension context invalidated/i.test(error?.message || String(error))) extensionContextAlive = false;
      return null;
    });
  } catch (error) {
    if (/Extension context invalidated/i.test(error?.message || String(error))) extensionContextAlive = false;
    return Promise.resolve(null);
  }
}

function parseVideoUrl(href) {
  if (!href) return null;
  try {
    const url = new URL(href, location.origin);
    if (url.pathname !== "/watch" || !url.searchParams.has("v")) return null;
    return url;
  } catch {
    return null;
  }
}

function videoInfoFromContainer(container) {
  const links = [...container.querySelectorAll("a[href*='/watch']")];
  const videoLink = links.find((link) => parseVideoUrl(link.getAttribute("href")) && link.textContent.trim())
    || links.find((link) => parseVideoUrl(link.getAttribute("href")));
  const url = parseVideoUrl(videoLink?.getAttribute("href"));
  if (!url) return null;

  const titleElement = container.querySelector("a#video-title, #video-title, h3 a[href*='/watch'], yt-lockup-metadata-view-model a[href*='/watch']");
  return {
    url: url.href,
    title: titleElement?.getAttribute("title")
      || titleElement?.textContent.trim()
      || titleElement?.getAttribute("aria-label")
      || videoLink?.getAttribute("title")
      || videoLink?.textContent.trim()
      || videoLink?.getAttribute("aria-label")
      || "YouTube video"
  };
}

async function videoInfoFromWatchPage() {
  const url = parseVideoUrl(location.href);
  if (!url) return null;
  const titleElement = document.querySelector("ytd-watch-metadata h1 yt-formatted-string, ytd-watch-metadata h1, #title h1 yt-formatted-string");
  return {
    url: url.href,
    title: titleElement?.textContent.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, "") || "YouTube video",
    subtitleTrack: await activeSubtitleTrack()
  };
}

function subtitleTrackFromPlayer(player) {
  if (!player || typeof player.getOption !== "function") return null;
  try {
    const track = player.getOption("captions", "track");
    const languageCode = typeof track?.languageCode === "string" ? track.languageCode.trim() : "";
    if (!languageCode) return null;
    return {
      languageCode,
      kind: track.kind === "asr" ? "asr" : "manual",
      languageName: typeof track.languageName === "string" ? track.languageName.trim() : ""
    };
  } catch {
    return null;
  }
}

function ensureSubtitleBridge() {
  if (subtitleBridgePromise) return subtitleBridgePromise;
  subtitleBridgePromise = new Promise((resolve) => {
    let resourceUrl;
    try {
      resourceUrl = chrome.runtime.getURL("page-bridge.js");
    } catch (error) {
      if (/Extension context invalidated/i.test(error?.message || String(error))) extensionContextAlive = false;
      resolve(false);
      return;
    }
    const script = document.createElement("script");
    script.src = resourceUrl;
    script.onload = () => { script.remove(); resolve(true); };
    script.onerror = () => { script.remove(); resolve(false); };
    (document.head || document.documentElement).append(script);
  });
  return subtitleBridgePromise;
}

async function activeSubtitleTrack() {
  const player = document.getElementById("movie_player");
  const directTrack = subtitleTrackFromPlayer(player);
  if (directTrack) return directTrack;
  if (!await ensureSubtitleBridge()) return null;

  const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      subtitleResolvers.delete(requestId);
      resolve(null);
    }, 1000);
    subtitleResolvers.set(requestId, (track) => {
      window.clearTimeout(timeout);
      resolve(track);
    });
    window.postMessage({ source: SUBTITLE_BRIDGE_SOURCE, type: "get-active-subtitle", requestId }, "*");
  });
}

function setButtonState(button, state, label) {
  button.dataset.downloadState = state;
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

function readableError(error) {
  const message = error?.message || String(error || "未知错误");
  if (/Extension context invalidated/i.test(message)) {
    return "扩展已更新或重新加载，请刷新此 YouTube 页面后重试";
  }
  if (/Specified native messaging host not found|host not found/i.test(message)) {
    return "未注册本机桥接器。请在扩展目录运行 setup-native-host.bat（会自动安装缺失下载工具），然后重新加载扩展";
  }
  if (/Access to the specified native messaging host is forbidden/i.test(message)) {
    return "桥接器扩展 ID 不匹配。请用当前扩展 ID 重新运行 setup-native-host.bat";
  }
  if (/Could not establish connection|Receiving end does not exist/i.test(message)) {
    return "无法联系扩展后台。请在 edge://extensions 确认扩展已启用，并刷新本页";
  }
  return message;
}

function showToast(task) {
  window.clearTimeout(toastHideTimer);
  window.clearTimeout(toastResetTimer);
  if (!toastElement?.isConnected) {
    toastElement = document.createElement("div");
    toastElement.className = "ytdlp-download-toast";
    document.documentElement.append(toastElement);
  }
  const status = {
    connecting: "正在连接本机下载器",
    queued: "已加入下载队列",
    downloading: `正在下载 ${Math.round(task.progress || 0)}%`,
    completed: "下载完成",
    error: "下载失败"
  }[task.status] || "下载状态已更新";
  toastElement.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = status;
  const title = document.createElement("span");
  title.textContent = task.title || "YouTube video";
  const detail = document.createElement("small");
  detail.textContent = task.error
    || (task.subtitleError ? `字幕下载未完成：${task.subtitleError}` : "")
    || task.outputDirectory
    || "";
  toastElement.append(heading, title, detail);
  toastElement.dataset.state = task.status;
  if (["completed", "error"].includes(task.status)) {
    const hideMs = task.status === "error" ? 12000 : 5000;
    toastHideTimer = window.setTimeout(() => toastElement?.remove(), hideMs);
    toastResetTimer = window.setTimeout(() => { toastElement = undefined; }, hideMs + 100);
  }
}

function applyTaskToButton(button, task) {
  if (!button?.isConnected) return;
  const active = ["connecting", "queued", "downloading"].includes(task.status);
  const percent = Math.round(task.progress || 0);
  button.disabled = active;
  button.style.setProperty("--download-progress", `${percent}%`);
  const percentElement = button.querySelector(".ytdlp-download-button__percent");
  if (percentElement) percentElement.textContent = task.status === "downloading" ? `${percent}%` : "";
  const label = {
    connecting: "正在连接本机下载器…",
    queued: "已加入下载队列",
    downloading: `正在下载：${percent}%`,
    completed: `下载完成：${task.outputDirectory || ""}`,
    error: `下载失败：${task.error || "未知错误"}`
  }[task.status];
  setButtonState(button, task.status, label || "使用 yt-dlp 下载");
  if (["completed", "error"].includes(task.status)) {
    const poller = taskPollers.get(task.id);
    if (poller) {
      window.clearInterval(poller);
      taskPollers.delete(task.id);
    }
  }
}

function watchTask(button, id) {
  const existing = taskPollers.get(id);
  if (existing) window.clearInterval(existing);
  const refreshTask = async () => {
    if (!extensionContextAlive) {
      window.clearInterval(taskPollers.get(id));
      taskPollers.delete(id);
      return;
    }
    if (!button.isConnected) {
      window.clearInterval(taskPollers.get(id));
      taskPollers.delete(id);
      return;
    }
    try {
      const result = await safeRuntimeMessage({ type: "get-downloads" });
      const task = result?.tasks?.find((candidate) => candidate.id === id);
      if (task) {
        applyTaskToButton(button, task);
        showToast(task);
      }
    } catch {
      // Native connection errors are surfaced by the task's next status update.
    }
  };
  taskPollers.set(id, window.setInterval(refreshTask, 750));
  window.setTimeout(refreshTask, 120);
}

function createDownloadButton(getVideoInfo, surface, videoId = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = BUTTON_CLASS;
  button.setAttribute(SURFACE_ATTRIBUTE, surface);
  button.setAttribute("aria-label", "使用 yt-dlp 下载");
  button.title = "使用 yt-dlp 下载";
  const svgNamespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(svgNamespace, "svg");
  icon.classList.add("ytdlp-download-button__icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const path = document.createElementNS(svgNamespace, "path");
  path.setAttribute("d", "M19 9h-4V3H9v6H5l7 7 7-7Zm-14 9v2h14v-2H5Z");
  icon.append(path);
  const percent = document.createElement("span");
  percent.className = "ytdlp-download-button__percent";
  button.append(icon, percent);
  if (videoId) button.dataset.videoId = videoId;

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    let video;
    try {
      video = await getVideoInfo();
      if (!video) return;

      diagnostic("download-button-clicked", {
        surface,
        videoId: new URL(video.url).searchParams.get("v"),
        subtitleTrack: video.subtitleTrack || null
      });

      setButtonState(button, "pending", "正在加入 yt-dlp 下载队列…");
      button.disabled = true;
      const result = await safeRuntimeMessage({ type: "download", ...video });
      if (!result) throw new Error("扩展已更新，请刷新此 YouTube 页面后重试");
      if (!result?.ok) throw new Error(result?.error || "无法加入下载队列");
      diagnostic("download-message-response", { ok: true, surface, taskId: result.task.id });
      button.dataset.taskId = result.task.id;
      button.dataset.videoId = videoIdOf(video);
      applyTaskToButton(button, result.task);
      showToast(result.task);
      watchTask(button, result.task.id);
      const latest = await safeRuntimeMessage({ type: "get-downloads" });
      const latestTask = latest?.tasks?.find((task) => task.id === result.task.id);
      if (latestTask) applyTaskToButton(button, latestTask);
    } catch (error) {
      const message = readableError(error);
      diagnostic("download-message-error", { error: message, surface });
      button.disabled = false;
      setButtonState(button, "error", `下载失败：${message}`);
      showToast({ status: "error", title: video?.title, error: message });
    }
  });

  return button;
}

function directChildOf(container, node) {
  let current = node;
  while (current?.parentElement && current.parentElement !== container) current = current.parentElement;
  return current?.parentElement === container ? current : null;
}

function addSearchButtons(root) {
  const selector = "ytd-search ytd-video-renderer, ytd-two-column-search-results-renderer ytd-video-renderer";
  const renderers = [
    ...(root.matches?.(selector) ? [root] : []),
    ...root.querySelectorAll(selector)
  ];
  for (const renderer of renderers) {
    if (renderer.querySelector(`.${BUTTON_CLASS}[${SURFACE_ATTRIBUTE}="search"]`)) continue;
    const menu = renderer.querySelector("#menu ytd-menu-renderer");
    const originalMenuButton = menu?.querySelector("yt-icon-button");
    const video = videoInfoFromContainer(renderer);
    if (!menu || !originalMenuButton || !video) continue;
    menu.insertBefore(createDownloadButton(() => videoInfoFromContainer(renderer), "search", videoIdOf(video)), originalMenuButton);
  }
}

function addPlaylistButtons(root) {
  if (location.pathname !== "/playlist") return;
  const selector = "ytd-browse yt-lockup-view-model, ytd-browse ytd-playlist-video-renderer";
  const renderers = [
    ...(root.matches?.(selector) ? [root] : []),
    ...root.querySelectorAll(selector)
  ];
  for (const renderer of renderers) {
    if (renderer.querySelector(`.${BUTTON_CLASS}[${SURFACE_ATTRIBUTE}="playlist"]`)) continue;
    const video = videoInfoFromContainer(renderer);
    if (!video) continue;

    const menuModel = renderer.querySelector("yt-lockup-metadata-view-model button-view-model, #menu ytd-menu-renderer, ytd-menu-renderer");
    const menuButton = menuModel?.querySelector("button, yt-icon-button");
    if (!menuModel || !menuButton) continue;
    menuModel.before(createDownloadButton(() => videoInfoFromContainer(renderer), "playlist", videoIdOf(video)));
  }
}

function addWatchButton() {
  if (location.pathname !== "/watch" || !parseVideoUrl(location.href)) return;
  const menu = document.querySelector("ytd-watch-metadata ytd-menu-renderer");
  if (!menu || menu.querySelector(`.${BUTTON_CLASS}[${SURFACE_ATTRIBUTE}="watch"]`)) return;

  const moreButton = menu.querySelector(
    ":scope > yt-icon-button, :scope > yt-button-shape button[aria-label*='More'], :scope > yt-button-shape button[aria-label*='更多'], button[aria-label*='More actions'], button[aria-label*='更多操作']"
  );
  const insertionPoint = directChildOf(menu, moreButton);
  if (!insertionPoint) return;
  menu.insertBefore(createDownloadButton(videoInfoFromWatchPage, "watch", currentWatchVideoId()), insertionPoint);
}

function addButtons(root = document) {
  addSearchButtons(root);
  addPlaylistButtons(root);
  addWatchButton();
}

function scheduleButtonScan(root = document) {
  window.requestAnimationFrame(() => addButtons(root));
}

function currentWatchVideoId() {
  const url = parseVideoUrl(location.href);
  return url ? (url.searchParams.get("v") || "") : "";
}

function videoIdOf(video) {
  try {
    return video?.url ? (new URL(video.url).searchParams.get("v") || "") : "";
  } catch {
    return "";
  }
}

function resetButtonState(button) {
  const taskId = button.dataset.taskId;
  if (taskId && taskPollers.has(taskId)) {
    window.clearInterval(taskPollers.get(taskId));
    taskPollers.delete(taskId);
  }
  button.disabled = false;
  delete button.dataset.downloadState;
  delete button.dataset.taskId;
  button.style.removeProperty("--download-progress");
  const percentElement = button.querySelector(".ytdlp-download-button__percent");
  if (percentElement) percentElement.textContent = "";
  button.setAttribute("aria-label", "使用 yt-dlp 下载");
  button.title = "使用 yt-dlp 下载";
}

function resetStaleButtons() {
  const currentId = currentWatchVideoId();
  document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((button) => {
    if (button.dataset.videoId && button.dataset.videoId === currentId) return;
    resetButtonState(button);
  });
}

function scanCurrentPage() {
  resetStaleButtons();
  addButtons();
  for (const delay of [250, 750, 1500, 3000]) {
    window.setTimeout(() => addButtons(), delay);
  }
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) scheduleButtonScan(node);
    }
  }
});

function startContentScript() {
  scanCurrentPage();
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.documentElement) {
  startContentScript();
} else {
  document.addEventListener("DOMContentLoaded", startContentScript, { once: true });
}

document.addEventListener("yt-navigate-finish", scanCurrentPage);
window.addEventListener("popstate", scanCurrentPage);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "download-update" || !message.task) return;
  document.querySelectorAll(`.${BUTTON_CLASS}[data-task-id="${CSS.escape(message.task.id)}"]`)
    .forEach((button) => applyTaskToButton(button, message.task));
  showToast(message.task);
});
