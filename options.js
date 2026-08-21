const form = document.querySelector("#settings-form");
const pathInput = document.querySelector("#yt-dlp-path");
const directoryInput = document.querySelector("#output-directory");
const proxyInput = document.querySelector("#proxy-url");
const browserCookiesInput = document.querySelector("#auto-browser-cookies");
const cookiesFileInput = document.querySelector("#cookies-file-path");
const message = document.querySelector("#message");
const setupCommand = document.querySelector("#setup-command");
const depsSummary = document.querySelector("#deps-summary");

function showMessage(text, type = "") {
  message.textContent = text;
  message.className = type;
}

async function restoreSettings() {
  const settings = await chrome.storage.local.get({ ytDlpPath: "", outputDirectory: "", proxyUrl: "socks5h://127.0.0.1:7890", autoUseBrowserCookies: true, cookiesFilePath: "" });
  if (/^http:\/\/(?:127\.0\.0\.1|localhost):7890\/?$/i.test(settings.proxyUrl)) {
    settings.proxyUrl = "socks5h://127.0.0.1:7890";
    await chrome.storage.local.set({ proxyUrl: settings.proxyUrl });
  }
  pathInput.value = settings.ytDlpPath;
  directoryInput.value = settings.outputDirectory;
  proxyInput.value = settings.proxyUrl;
  browserCookiesInput.checked = settings.autoUseBrowserCookies !== false;
  cookiesFileInput.value = settings.cookiesFilePath;
}

async function loadSetupInfo() {
  try {
    const info = await chrome.runtime.sendMessage({ type: "get-setup-info" });
    const command = info?.setupCommand || `setup-native-host.bat ${chrome.runtime.id}`;
    setupCommand.textContent = command;
  } catch {
    setupCommand.textContent = `setup-native-host.bat ${chrome.runtime.id}`;
  }
}

async function refreshDiagnosis() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "diagnose" });
    if (!result?.ok) {
      depsSummary.textContent = result?.bridgeError || result?.error || "桥接未连接。请先运行上方安装命令。";
      depsSummary.className = "hint error-text";
      return;
    }
    const tools = result.diagnosis?.tools || {};
    const parts = ["python", "ytdlp", "node", "ffmpeg"].map((key) => {
      const item = tools[key];
      if (!item) return null;
      return `${item.label}: ${item.ok ? "就绪" : "缺失"}`;
    }).filter(Boolean);
    const ver = result.bridgeVersion ? `桥接 v${result.bridgeVersion} · ` : "";
    depsSummary.textContent = ver + (parts.join(" · ") || "已连接");
    depsSummary.className = result.diagnosis?.ok ? "hint ok-text" : "hint warn-text";
  } catch (error) {
    depsSummary.textContent = error.message || String(error);
    depsSummary.className = "hint error-text";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({
    ytDlpPath: pathInput.value.trim(),
    outputDirectory: directoryInput.value.trim(),
    proxyUrl: proxyInput.value.trim(),
    autoUseBrowserCookies: browserCookiesInput.checked,
    cookiesFilePath: cookiesFileInput.value.trim()
  });
  showMessage("设置已保存。", "ok");
});

document.querySelector("#test-bridge").addEventListener("click", async () => {
  showMessage("正在测试…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "ping" });
    if (!result?.ok) throw new Error(result?.error || result?.bridgeError || "桥接器未响应");
    const ver = result.bridgeVersion ? ` · 桥接 v${result.bridgeVersion}` : "";
    showMessage(`桥接器可用：${result.ytDlp || "已连接"}${ver}`, "ok");
    await refreshDiagnosis();
  } catch (error) {
    showMessage(`连接失败：${error.message}`, "error");
  }
});

document.querySelector("#copy-setup").addEventListener("click", async () => {
  await navigator.clipboard.writeText(setupCommand.textContent);
  showMessage("安装命令已复制。", "ok");
});

document.querySelector("#install-tools").addEventListener("click", async () => {
  showMessage("正在安装缺失工具（可能需要几分钟）…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "install-tools" });
    if (!result?.ok && !result?.diagnosis) {
      throw new Error(result?.message || result?.bridgeError || "安装失败");
    }
    showMessage(result.message || (result.ok ? "安装完成" : "部分工具可能仍缺失，请查看详情"), result.ok ? "ok" : "error");
    await refreshDiagnosis();
  } catch (error) {
    showMessage(`安装失败：${error.message}`, "error");
  }
});

restoreSettings();
loadSetupInfo();
refreshDiagnosis();
