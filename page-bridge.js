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

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data.type !== "get-active-subtitle") return;
    window.postMessage({
      source: SOURCE,
      type: "active-subtitle-response",
      requestId: event.data.requestId,
      track: activeSubtitleTrack()
    }, "*");
  });
})();
