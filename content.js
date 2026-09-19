const BUTTON_CLASS = "ytdlp-download-button";
const SURFACE_ATTRIBUTE = "data-ytdlp-surface";
const SUBTITLE_BRIDGE_SOURCE = "yt-dlp-edge-page-bridge-v2";
const DOWNLOAD_PRESETS = [
  { id: "2160", label: "2160p", detail: "4K" },
  { id: "1440", label: "1440p", detail: "2K" },
  { id: "1080", label: "1080p", detail: "默认，全高清" },
  { id: "720", label: "720p", detail: "高清" },
  { id: "480", label: "480p", detail: "标清" },
  { id: "360", label: "360p", detail: "省流" },
  { id: "best", label: "最高质量", detail: "自动选择最高画质" },
  { id: "audio", label: "仅音频", detail: "只下载音轨，不下载视频（按源格式保存）", audioOnly: true }
];
let toastElement;
let toastHideTimer;
let toastResetTimer;
const taskPollers = new Map();
const subtitleResolvers = new Map();
let subtitleBridgePromise;
let extensionContextAlive = true;
let downloadDialogElement;
let downloadDialogRequest;

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== SUBTITLE_BRIDGE_SOURCE) return;
  if (event.data.type === "active-subtitle-response") {
    const resolver = subtitleResolvers.get(event.data.requestId);
    if (!resolver) return;
    subtitleResolvers.delete(event.data.requestId);
    resolver(event.data.track || null);
    return;
  }
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

function setButtonState(button) {
  button.removeAttribute("data-download-state");
  button.setAttribute("aria-label", "使用 yt-dlp 下载");
  button.setAttribute("title", "使用 yt-dlp 下载");
}

function readableError(error) {
  const message = error?.message || String(error || "未知错误");
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const browser = /\bEdg\//i.test(userAgent) ? "edge" : "chrome";
  const setupCommand = /Macintosh|Mac OS X/i.test(userAgent)
    ? `./setup-native-host.sh ${chrome.runtime.id} --browser ${browser}`
    : `setup-native-host.bat ${chrome.runtime.id}`;
  const extensionsPage = browser === "edge" ? "edge://extensions" : "chrome://extensions";
  if (/Extension context invalidated/i.test(message)) {
    return "扩展已更新或重新加载，请刷新此 YouTube 页面后重试";
  }
  if (/Specified native messaging host not found|host not found/i.test(message)) {
    return `未注册本机桥接器。请在扩展目录运行 ${setupCommand}（会自动安装缺失下载工具），然后重新加载扩展`;
  }
  if (/Access to the specified native messaging host is forbidden/i.test(message)) {
    return `桥接器扩展 ID 不匹配。请用当前扩展 ID 重新运行 ${setupCommand}`;
  }
  if (/Could not establish connection|Receiving end does not exist/i.test(message)) {
    return `无法联系扩展后台。请在 ${extensionsPage} 确认扩展已启用，并刷新本页`;
  }
  return message;
}

function taskMediaType(task) {
  return task.mediaType || (task.downloadPreset === "audio" ? "audio" : "video");
}

function taskProgressValue(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(100, Math.max(0, Math.round(fallback || 0)));
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function taskProgressRows(task) {
  const fallback = taskProgressValue(task.progress);
  const fallbackSpeed = task.speed || "";
  const fallbackEta = task.eta || "";
  if (taskMediaType(task) === "audio") {
    return [{
      key: "audio",
      label: "音频",
      value: taskProgressValue(task.audioProgress, fallback),
      speed: task.audioSpeed || fallbackSpeed,
      eta: task.audioEta || fallbackEta
    }];
  }
  return [
    {
      key: "video",
      label: "视频",
      value: taskProgressValue(task.videoProgress, fallback),
      speed: task.videoSpeed || fallbackSpeed,
      eta: task.videoEta || fallbackEta
    },
    {
      key: "audio",
      label: "音频",
      value: taskProgressValue(task.audioProgress, task.status === "completed" ? fallback : 0),
      speed: task.audioSpeed || fallbackSpeed,
      eta: task.audioEta || fallbackEta
    }
  ];
}

function appendToastProgress(task) {
  const progress = document.createElement("div");
  progress.className = "ytdlp-download-toast__progress";
  progress.setAttribute("aria-label", "下载进度");
  for (const row of taskProgressRows(task)) {
    const progressRow = document.createElement("div");
    progressRow.className = "ytdlp-download-toast__progress-row";
    const progressHead = document.createElement("div");
    progressHead.className = "ytdlp-download-toast__progress-head";
    const label = document.createElement("span");
    label.className = "ytdlp-download-toast__progress-label";
    label.textContent = row.label;
    const metrics = document.createElement("span");
    metrics.className = "ytdlp-download-toast__progress-metrics";
    metrics.textContent = [row.speed, row.eta ? `剩余 ${row.eta}` : ""]
      .filter(Boolean)
      .join(" · ") || (task.status === "completed" ? "已完成" : "等待速度");
    const value = document.createElement("span");
    value.className = "ytdlp-download-toast__progress-value";
    value.textContent = `${row.value}%`;
    progressHead.append(label, metrics, value);
    const track = document.createElement("div");
    track.className = "ytdlp-download-toast__progress-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", `${row.label}进度 ${row.value}%`);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(row.value));
    const fill = document.createElement("span");
    fill.style.width = `${row.value}%`;
    track.append(fill);
    progressRow.append(progressHead, track);
    progress.append(progressRow);
  }
  return progress;
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
    downloading: taskMediaType(task) === "video" ? "正在下载" : `正在下载 ${taskProgressRows(task)[0].value}%`,
    completed: "下载完成",
    error: "下载失败"
  }[task.status] || "下载状态已更新";
  toastElement.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = status;
  const title = document.createElement("span");
  title.textContent = task.title || "YouTube video";
  const detail = document.createElement("small");
  const taskDetail = task.error
    || (task.subtitleError ? `字幕下载未完成：${task.subtitleError}` : "")
    || task.outputDirectory
    || "";
  detail.textContent = [task.formatLabel ? `下载：${task.formatLabel}` : "", taskDetail]
    .filter(Boolean)
    .join(" · ");
  toastElement.append(heading, title, appendToastProgress(task), detail);
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
  button.disabled = active;
  button.toggleAttribute("aria-busy", active);
  button.style.removeProperty("--download-progress");
  setButtonState(button);
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

function validDownloadPreset(presetId, presets = DOWNLOAD_PRESETS) {
  return presets.some((preset) => preset.id === presetId) ? presetId : "1080";
}

function focusDownloadDialogElement(element) {
  if (!element?.isConnected || typeof element.focus !== "function") return;
  try { element.focus({ preventScroll: true }); } catch { element.focus(); }
}

function updateDownloadDialogSelection(presetId) {
  if (!downloadDialogRequest || !downloadDialogElement) return;
  const selected = validDownloadPreset(presetId, downloadDialogRequest.presets);
  downloadDialogRequest.selectedPreset = selected;
  const select = downloadDialogElement.querySelector(".ytdlp-download-dialog__select");
  if (select && select.value !== selected) select.value = selected;
}

function closeDownloadDialog(presetId = null) {
  const request = downloadDialogRequest;
  if (!request) return;
  const selectedPreset = presetId ? validDownloadPreset(presetId, request.presets) : null;
  downloadDialogRequest = null;
  if (downloadDialogElement) {
    downloadDialogElement.hidden = true;
    downloadDialogElement.setAttribute("aria-hidden", "true");
  }
  request.resolve(selectedPreset);
  focusDownloadDialogElement(request.previousFocus);
}

function renderDownloadDialogOptions(selectedPreset, presets = DOWNLOAD_PRESETS) {
  const optionsElement = downloadDialogElement.querySelector(".ytdlp-download-dialog__options");
  const select = optionsElement.querySelector(".ytdlp-download-dialog__select");
  if (!select) return;
  select.replaceChildren();
  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.detail ? `${preset.label} · ${preset.detail}` : preset.label;
    select.append(option);
  }
  select.value = validDownloadPreset(selectedPreset, presets);
  select.disabled = !downloadDialogRequest?.ready;
}

function ensureDownloadDialog() {
  if (downloadDialogElement?.isConnected) return downloadDialogElement;
  const dialog = document.createElement("div");
  dialog.className = "ytdlp-download-dialog";
  dialog.hidden = true;
  dialog.setAttribute("aria-hidden", "true");

  const backdrop = document.createElement("div");
  backdrop.className = "ytdlp-download-dialog__backdrop";
  backdrop.dataset.ytdlpDialogClose = "true";
  backdrop.setAttribute("aria-hidden", "true");

  const panel = document.createElement("section");
  panel.className = "ytdlp-download-dialog__panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "ytdlp-download-dialog-title");
  panel.tabIndex = -1;

  const heading = document.createElement("header");
  heading.className = "ytdlp-download-dialog__heading";
  const headingCopy = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "ytdlp-download-dialog__eyebrow";
  eyebrow.textContent = "下载选项";
  const title = document.createElement("h2");
  title.id = "ytdlp-download-dialog-title";
  title.textContent = "选择清晰度";
  const videoTitle = document.createElement("p");
  videoTitle.className = "ytdlp-download-dialog__video-title";
  const availability = document.createElement("p");
  availability.className = "ytdlp-download-dialog__availability";
  availability.setAttribute("aria-live", "polite");
  headingCopy.append(eyebrow, title, videoTitle, availability);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ytdlp-download-dialog__close";
  close.dataset.ytdlpDialogClose = "true";
  close.setAttribute("aria-label", "关闭下载选项");
  close.textContent = "关闭";
  heading.append(headingCopy, close);

  const options = document.createElement("div");
  options.className = "ytdlp-download-dialog__options";
  const selectLabel = document.createElement("label");
  selectLabel.className = "ytdlp-download-dialog__select-label";
  const selectCaption = document.createElement("span");
  selectCaption.textContent = "下载清晰度";
  const select = document.createElement("select");
  select.className = "ytdlp-download-dialog__select";
  select.setAttribute("aria-label", "下载清晰度");
  select.addEventListener("change", () => updateDownloadDialogSelection(select.value));
  selectLabel.append(selectCaption, select);
  options.append(selectLabel);

  const footer = document.createElement("footer");
  footer.className = "ytdlp-download-dialog__footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ytdlp-download-dialog__cancel";
  cancel.dataset.ytdlpDialogClose = "true";
  cancel.textContent = "取消";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "ytdlp-download-dialog__confirm";
  confirm.disabled = true;
  confirm.textContent = "开始下载";
  footer.append(cancel, confirm);

  panel.append(heading, options, footer);
  dialog.append(backdrop, panel);
  (document.documentElement || document.body).append(dialog);

  dialog.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-ytdlp-dialog-close]")) {
      closeDownloadDialog();
      return;
    }
    if (target?.closest(".ytdlp-download-dialog__confirm")) {
      if (!downloadDialogRequest?.ready) return;
      closeDownloadDialog(downloadDialogRequest?.selectedPreset || "1080");
    }
  });
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (!downloadDialogRequest) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDownloadDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...panel.querySelectorAll("button:not([disabled]), select:not([disabled])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      focusDownloadDialogElement(last);
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      focusDownloadDialogElement(first);
    }
  });
  downloadDialogElement = dialog;
  return dialog;
}

function requestDownloadPreset(video, button) {
  const dialog = ensureDownloadDialog();
  if (downloadDialogRequest) closeDownloadDialog();
  const selectedPreset = "1080";
  const videoTitle = dialog.querySelector(".ytdlp-download-dialog__video-title");
  const availability = dialog.querySelector(".ytdlp-download-dialog__availability");
  const confirm = dialog.querySelector(".ytdlp-download-dialog__confirm");
  videoTitle.textContent = video?.title || "YouTube video";
  availability.textContent = "手动选择清晰度，默认 1080p；视频不提供时将自动回退";
  confirm.disabled = false;
  dialog.hidden = false;
  dialog.setAttribute("aria-hidden", "false");
  let request;
  const selectionPromise = new Promise((resolve) => {
    request = {
      resolve,
      selectedPreset,
      presets: DOWNLOAD_PRESETS,
      ready: true,
      previousFocus: document.activeElement || button
    };
    downloadDialogRequest = request;
    renderDownloadDialogOptions(selectedPreset, DOWNLOAD_PRESETS);
    updateDownloadDialogSelection(selectedPreset);
    window.setTimeout(() => {
      focusDownloadDialogElement(dialog.querySelector(".ytdlp-download-dialog__select"));
    }, 0);
  });
  return selectionPromise;
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
  button.append(icon);
  if (videoId) button.dataset.videoId = videoId;

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.dialogPending === "true") return;
    button.dataset.dialogPending = "true";
    let video;
    try {
      video = await getVideoInfo();
      if (!video) {
        delete button.dataset.dialogPending;
        return;
      }

      diagnostic("download-button-clicked", {
        surface,
        videoId: new URL(video.url).searchParams.get("v"),
        subtitleTrack: video.subtitleTrack || null
      });

      const downloadPreset = await requestDownloadPreset(video, button);
      if (!downloadPreset) {
        delete button.dataset.dialogPending;
        return;
      }
      diagnostic("download-preset-selected", { surface, downloadPreset });
      delete button.dataset.dialogPending;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      const result = await safeRuntimeMessage({ type: "download", ...video, downloadPreset });
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
      delete button.dataset.dialogPending;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      setButtonState(button);
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
  button.removeAttribute("aria-busy");
  delete button.dataset.downloadState;
  delete button.dataset.taskId;
  button.style.removeProperty("--download-progress");
  setButtonState(button);
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

document.addEventListener("yt-navigate-start", () => closeDownloadDialog());
document.addEventListener("yt-navigate-finish", scanCurrentPage);
window.addEventListener("popstate", () => { closeDownloadDialog(); scanCurrentPage(); });

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "download-update" || !message.task) return;
  document.querySelectorAll(`.${BUTTON_CLASS}[data-task-id="${CSS.escape(message.task.id)}"]`)
    .forEach((button) => applyTaskToButton(button, message.task));
  showToast(message.task);
});
