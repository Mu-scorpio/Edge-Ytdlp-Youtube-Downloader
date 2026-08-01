const statusElement = document.querySelector("#status");
const taskList = document.querySelector("#task-list");
const debugLogElement = document.querySelector("#debug-log");
const depsList = document.querySelector("#deps-list");
const setupHint = document.querySelector("#setup-hint");
const installMessage = document.querySelector("#install-message");
const installButton = document.querySelector("#install-tools");
let currentTasks = [];

const stateLabel = { connecting: "正在连接", queued: "等待开始", downloading: "正在下载", completed: "已完成", error: "下载失败" };
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function renderTasks(tasks) {
  currentTasks = tasks;
  if (!tasks.length) { taskList.innerHTML = '<p class="empty">暂无下载任务</p>'; return; }
  taskList.innerHTML = tasks.map((task) => {
    const progress = Math.round(task.progress || 0);
    const detail = task.error || task.subtitleError || task.outputDirectory || "等待本机下载器确认保存目录";
    const eta = task.status === "downloading" && task.eta ? ` · 剩余 ${task.eta}` : "";
    return `<article class="task ${escapeHtml(task.status)}">
      <div class="task__row"><span class="task__title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span><span class="task__state ${escapeHtml(task.status)}">${stateLabel[task.status] || task.status}${task.status === "downloading" ? ` ${progress}%` : ""}</span></div>
      <div class="progress" aria-label="下载进度 ${progress}%"><span style="width:${progress}%"></span></div>
      <div class="task__meta multi">${escapeHtml(detail)}${escapeHtml(eta)}</div>
      ${task.outputDirectory ? `<div class="task__meta path" title="${escapeHtml(task.outputDirectory)}">保存到：${escapeHtml(task.outputDirectory)} <button class="task__copy" data-path="${escapeHtml(task.outputDirectory)}" type="button">复制</button></div>` : ""}
    </article>`;
  }).join("");
}

function renderDeps(result) {
  const diagnosis = result?.diagnosis;
  const tools = diagnosis?.tools;
  if (!result?.ok) {
    depsList.innerHTML = `<li class="deps-item bad">桥接未连接</li>`;
    setupHint.hidden = false;
    setupHint.textContent = result?.setupCommand
      ? `新设备请在扩展目录运行：${result.setupCommand}`
      : "请先运行 setup-native-host.bat 注册本机桥接器。";
    installButton.disabled = true;
    return;
  }

  setupHint.hidden = true;
  installButton.disabled = false;

  if (!tools) {
    depsList.innerHTML = `<li class="deps-item muted">桥接已连接，等待依赖详情…</li>`;
    return;
  }

  const order = ["python", "ytdlp", "node", "ffmpeg"];
  depsList.innerHTML = order.map((key) => {
    const item = tools[key];
    if (!item) return "";
    const cls = item.ok ? "ok" : (item.required ? "bad" : "warn");
    const mark = item.ok ? "✓" : (item.required ? "✗" : "!");
    return `<li class="deps-item ${cls}" title="${escapeHtml(item.detail || "")}"><span class="mark">${mark}</span><span class="name">${escapeHtml(item.label)}</span><span class="detail">${escapeHtml(item.detail || "")}</span></li>`;
  }).join("");

  const missingRequired = diagnosis.missingRequired || [];
  const missingOptional = diagnosis.missingOptional || [];
  if (missingRequired.length || missingOptional.length) {
    installMessage.textContent = missingRequired.length
      ? `缺少必需工具：${missingRequired.join(", ")}。可点击「安装缺失工具」。`
      : `可选工具缺失：${missingOptional.join(", ")}（高画质合并可能需要 FFmpeg）。`;
    installMessage.className = "install-message warn";
  } else {
    installMessage.textContent = diagnosis.bridgeVersion
      ? `依赖就绪 · 桥接 v${diagnosis.bridgeVersion}`
      : "依赖就绪";
    installMessage.className = "install-message ok";
  }
}

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: "get-downloads" });
  renderTasks(result?.tasks || []);
  if (!result?.ok || result?.bridgeError) {
    statusElement.textContent = `本机桥接器未连接`;
    statusElement.title = result?.bridgeError || "未知错误";
    statusElement.className = "status error";
    setupHint.hidden = false;
    setupHint.textContent = (result?.bridgeError || "未知错误") +
      (result?.setupCommand ? `\n\n新设备安装命令：\n${result.setupCommand}` : "");
  } else {
    const ver = result.bridgeVersion ? ` v${result.bridgeVersion}` : "";
    statusElement.textContent = `本机下载器已连接${ver}；进度实时更新`;
    statusElement.title = result.ytDlp || "";
    statusElement.className = "status ok";
  }
  renderDeps(result);
}

async function refreshDeps() {
  installMessage.textContent = "正在检测依赖…";
  installMessage.className = "install-message";
  const result = await chrome.runtime.sendMessage({ type: "diagnose" });
  renderDeps(result);
  if (!result?.ok) {
    statusElement.textContent = "本机桥接器未连接";
    statusElement.className = "status error";
    statusElement.title = result?.bridgeError || result?.error || "";
  }
}

async function refreshDebug() {
  const result = await chrome.runtime.sendMessage({ type: "get-debug-log" });
  const lines = (result?.entries || []).slice(-40).map((entry) => {
    const time = entry.at ? new Date(entry.at).toLocaleTimeString() : "--:--:--";
    const detail = Object.keys(entry.detail || {}).length ? ` ${JSON.stringify(entry.detail)}` : "";
    return `[${time}] ${entry.source}: ${entry.event}${detail}`;
  });
  debugLogElement.textContent = lines.join("\n") || "暂无日志";
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "debug-update") { refreshDebug(); return; }
  if (message?.type === "install-update" && message.result) {
    installMessage.textContent = message.result.message || (message.result.ok ? "安装完成" : "安装结束");
    installMessage.className = message.result.ok ? "install-message ok" : "install-message error";
    if (message.result.diagnosis) {
      renderDeps({ ok: true, diagnosis: message.result.diagnosis });
    }
    return;
  }
  if (message?.type !== "download-update") return;
  const index = currentTasks.findIndex((task) => task.id === message.task.id);
  if (index >= 0) currentTasks[index] = message.task; else currentTasks.unshift(message.task);
  renderTasks(currentTasks.sort((a, b) => b.updatedAt - a.updatedAt));
});

taskList.addEventListener("click", async (event) => {
  const button = event.target.closest(".task__copy");
  if (!button) return;
  await navigator.clipboard.writeText(button.dataset.path);
  button.textContent = "已复制";
  window.setTimeout(() => { button.textContent = "复制"; }, 1200);
});

document.querySelector("#open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.querySelector("#clear-finished").addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "clear-downloads" }); refresh(); });
document.querySelector("#copy-debug").addEventListener("click", async () => { await navigator.clipboard.writeText(debugLogElement.textContent); });
document.querySelector("#clear-debug").addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "clear-debug-log" }); refreshDebug(); });
document.querySelector("#refresh-deps").addEventListener("click", () => refreshDeps());

installButton.addEventListener("click", async () => {
  installButton.disabled = true;
  installMessage.textContent = "正在安装缺失工具（可能需要几分钟，请勿关闭弹窗）…";
  installMessage.className = "install-message";
  try {
    const result = await chrome.runtime.sendMessage({ type: "install-tools" });
    installMessage.textContent = result?.message || (result?.ok ? "安装完成" : "安装失败");
    installMessage.className = result?.ok ? "install-message ok" : "install-message error";
    if (result?.diagnosis) renderDeps({ ok: result.ok || Boolean(result.diagnosis), diagnosis: result.diagnosis, setupCommand: result.setupCommand, bridgeError: result.bridgeError });
    await refresh();
  } catch (error) {
    installMessage.textContent = error.message || String(error);
    installMessage.className = "install-message error";
  } finally {
    installButton.disabled = false;
  }
});

refresh();
refreshDebug();
// Second pass after diagnose for richer tool details
window.setTimeout(() => refreshDeps(), 500);
