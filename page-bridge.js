(() => {
  const SOURCE = "yt-dlp-edge-page-bridge-v2";
  if (window.__ytDlpPageBridgeV2Installed) return;
  window.__ytDlpPageBridgeV2Installed = true;

  function activeSubtitleTrack() {
    const player = document.getElementById("movie_player");
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

  function availableFormats() {
    const player = document.getElementById("movie_player");
    let response = null;
    try {
      if (player && typeof player.getPlayerResponse === "function") {
        response = player.getPlayerResponse();
      }
    } catch {
      response = null;
    }
    if (typeof response === "string") {
      try { response = JSON.parse(response); } catch { response = null; }
    }
    response = response || window.ytInitialPlayerResponse || null;
    if (!response && window.ytplayer?.config?.args?.player_response) {
      try { response = JSON.parse(window.ytplayer.config.args.player_response); } catch { response = null; }
    }
    const streamingData = response?.streamingData || {};
    const formats = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];
    const heights = [...new Set(formats
      .filter((format) => format && format.vcodec && format.vcodec !== "none" && format.vcodec !== "mjpeg")
      .map((format) => Number(format.height))
      .filter((height) => Number.isInteger(height) && height >= 144 && height <= 4320))]
      .sort((left, right) => right - left);
    return { heights, hasAudio: formats.some((format) => format && format.acodec && format.acodec !== "none") };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data.type !== "get-active-subtitle") return;
    window.postMessage({
      source: SOURCE,
      type: "active-subtitle-response",
      requestId: event.data.requestId,
      track: activeSubtitleTrack()
    }, "*");
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data.type !== "get-available-formats") return;
    window.postMessage({
      source: SOURCE,
      type: "available-formats-response",
      requestId: event.data.requestId,
      formats: availableFormats()
    }, "*");
  });
})();
