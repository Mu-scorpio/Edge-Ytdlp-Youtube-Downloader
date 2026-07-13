const statusElement = document.querySelector("#status");
const taskList = document.querySelector("#task-list");
const debugLogElement = document.querySelector("#debug-log");
let currentTasks = [];

const stateLabel = { connecting: "正在连接", queued: "等待开始", downloading: "正在下载", completed: "已完成", error: "下载失败" };
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function renderTasks(tasks) {
  currentTasks = tasks;
  if (!tasks.length) { taskList.innerHTML = '<p class="empty">暂无下载任务</p>'; return; }
  taskList.innerHTML = tasks.map((task) => {
    const progress = Math.round(task.progress || 0);
    const detail = task.error || task.filePath || task.outputDirectory || "等待本机下载器确认保存目录";
    const eta = task.status === "downloading" && task.eta ? ` · 剩余 ${task.eta}` : "";
    return `<article class="task ${escapeHtml(task.status)}">
      <div class="task__row"><span class="task__title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span><span class="task__state ${escapeHtml(task.status)}">${stateLabel[task.status] || task.status}${task.status === "downloading" ? ` ${progress}%` : ""}</span></div>
      <div class="progress" aria-label="下载进度 ${progress}%"><span style="width:${progress}%"></span></div>
      <div class="task__meta">${escapeHtml(detail)}${escapeHtml(eta)}</div>
      ${task.outputDirectory ? `<div class="task__meta path" title="${escapeHtml(task.outputDirectory)}">保存到：${escapeHtml(task.outputDirectory)} <button class="task__copy" data-path="${escapeHtml(task.outputDirectory)}" type="button">复制</button></div>` : ""}
    </article>`;
  }).join("");
}

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: "get-downloads" });
  renderTasks(result?.tasks || []);
  if (!result?.ok || result?.bridgeError) { statusElement.textContent = `本机桥接器未连接：${result?.bridgeError || "未知错误"}`; statusElement.className = "status error"; }
  else { statusElement.textContent = "本机下载器已连接；进度实时更新"; statusElement.className = "status ok"; }
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
refresh();
refreshDebug();
