const form = document.querySelector("#settings-form");
const pathInput = document.querySelector("#yt-dlp-path");
const directoryInput = document.querySelector("#output-directory");
const proxyInput = document.querySelector("#proxy-url");
const browserCookiesInput = document.querySelector("#auto-browser-cookies");
const cookiesFileInput = document.querySelector("#cookies-file-path");
const message = document.querySelector("#message");

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
    if (!result?.ok) throw new Error(result?.error || "桥接器未响应");
    showMessage(`桥接器可用：${result.ytDlp || "已连接"}`, "ok");
  } catch (error) {
    showMessage(`连接失败：${error.message}`, "error");
  }
});

restoreSettings();
