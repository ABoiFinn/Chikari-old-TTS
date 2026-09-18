// ==UserScript==
// @name         Chikari Local Reader (Kokoro)
// @namespace    local.tts.reader
// @version      3.0
// @description  Read chikari.moe chapters aloud using your own local Kokoro TTS server instead of the site's built-in TTS.
// @match        https://chikari.moe/novels/*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict";

  const SERVER = "http://127.0.0.1:8791";

  const VOICE_GROUPS = [
    {
      label: "English (US)",
      voices: [
        { id: "af_alloy", label: "Alloy" },
        { id: "af_aoede", label: "Aoede" },
        { id: "af_bella", label: "Bella" },
        { id: "af_heart", label: "Heart" },
        { id: "af_jessica", label: "Jessica" },
        { id: "af_kore", label: "Kore" },
        { id: "af_nicole", label: "Nicole" },
        { id: "af_nova", label: "Nova" },
        { id: "af_river", label: "River" },
        { id: "af_sarah", label: "Sarah" },
        { id: "af_sky", label: "Sky" },
        { id: "am_adam", label: "Adam" },
        { id: "am_echo", label: "Echo" },
        { id: "am_eric", label: "Eric" },
        { id: "am_fenrir", label: "Fenrir" },
        { id: "am_liam", label: "Liam" },
        { id: "am_michael", label: "Michael" },
        { id: "am_onyx", label: "Onyx" },
        { id: "am_puck", label: "Puck" },
        { id: "am_santa", label: "Santa" },
      ],
    },
    {
      label: "English (UK)",
      voices: [
        { id: "bf_alice", label: "Alice" },
        { id: "bf_emma", label: "Emma" },
        { id: "bf_isabella", label: "Isabella" },
        { id: "bf_lily", label: "Lily" },
        { id: "bm_daniel", label: "Daniel" },
        { id: "bm_fable", label: "Fable" },
        { id: "bm_george", label: "George" },
        { id: "bm_lewis", label: "Lewis" },
      ],
    },
  ];
  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

  const ICON_PLAY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5-13-7.5Z"/></svg>';
  const ICON_PAUSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1"/><rect x="13.5" y="4" width="4.5" height="16" rx="1"/></svg>';
  const ICON_PREV = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2.2v14H6V5Zm3.5 7 11-7v14l-11-7Z"/></svg>';
  const ICON_NEXT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18 5h-2.2v14H18V5ZM14.5 12l-11-7v14l11-7Z"/></svg>';
  const ICON_CLOSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5 5 19"/></svg>';
  const ICON_DOTS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  const ICON_HEADPHONES = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="3" y="13" width="5" height="7" rx="1.5"/><rect x="16" y="13" width="5" height="7" rx="1.5"/></svg>';

  // state: "idle" | "loading" | "playing" | "paused"
  let state = "idle";
  let currentAudio = null;
  let currentAudioUrl = null;
  let seeking = false;
  // The synthesis job for THIS page's own chapter, if one is in flight.
  // Never used for a preload job -- those must keep running after we navigate away.
  let currentJobId = null;

  function el(id) {
    return document.getElementById(id);
  }

  function parseChapter(pathname) {
    const m = pathname.match(/\/novels\/([^/]+)\/([0-9.]+)/);
    if (!m) return null;
    return { slug: m[1], number: m[2] };
  }

  function cleanText(body) {
    return body
      .split("\n")
      .filter((ln) => !/^[\s*_-]+$/.test(ln.trim() || "x"))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function fetchChapterText(slug, number) {
    const res = await fetch(`/api/novels/${slug}/chapters/${number}/read`);
    if (!res.ok) throw new Error(`Chapter fetch failed: ${res.status}`);
    const data = await res.json();
    return cleanText(data.body);
  }

  function gmGet(url, responseType) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType,
        onload: (r) => (r.status === 200 ? resolve(r.response) : reject(new Error(`HTTP ${r.status}`))),
        onerror: () => reject(new Error("Local server unreachable (is server.py running?)")),
      });
    });
  }

  function gmPostJson(url, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(payload),
        onload: (r) => (r.status === 200 ? resolve(JSON.parse(r.responseText)) : reject(new Error(`HTTP ${r.status}`))),
        onerror: () => reject(new Error("Local server unreachable (is server.py running?)")),
      });
    });
  }

  function gmGetProgress(jobId) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `${SERVER}/speak/progress/${jobId}`,
        onload: (r) => resolve(JSON.parse(r.responseText)),
        onerror: () => reject(new Error("Local server unreachable")),
      });
    });
  }

  function startSynthesisJob(text, settings, background = false) {
    return gmPostJson(`${SERVER}/speak/start`, { text, ...settings, background });
  }

  async function waitForJobAudio(jobId, onProgress) {
    while (true) {
      const prog = await gmGetProgress(jobId);
      if (onProgress) onProgress(prog.done, prog.total);
      if (prog.status === "done") break;
      if (prog.status === "error") throw new Error(prog.error || "synthesis failed");
      if (prog.status === "cancelled") throw new Error("cancelled");
      await new Promise((r) => setTimeout(r, 300));
    }
    return gmGet(`${SERVER}/speak/audio/${jobId}`, "blob");
  }

  async function synthesize(text, settings, onProgress, path) {
    const { job_id } = await startSynthesisJob(text, settings);
    currentJobId = job_id;
    if (path) saveCurrentJob(path, settings, job_id);
    const blob = await waitForJobAudio(job_id, onProgress);
    currentJobId = null;
    return blob;
  }

  // Wraps waitForJobAudio so a stale reference (server restarted, job was
  // pruned, or it got cancelled/errored before finishing) is treated as a
  // cache miss instead of a hard failure -- the caller just falls through to
  // synthesizing fresh.
  async function tryReuseJob(jobId, onProgress) {
    try {
      return await waitForJobAudio(jobId, onProgress);
    } catch (err) {
      console.warn("Local Reader: cached job no longer usable, resynthesizing", err);
      return null;
    }
  }

  // Fire-and-forget: tell the server to stop a job we no longer care about.
  function cancelJob(jobId) {
    if (!jobId) return;
    try {
      navigator.sendBeacon(`${SERVER}/speak/cancel/${jobId}`);
    } catch {
      // best-effort only
    }
  }

  function adjacentChapterHref(direction) {
    const links = Array.from(document.querySelectorAll('a[href*="/novels/"]'));
    const here = parseChapter(location.pathname);
    if (!here) return null;
    const target = `/novels/${here.slug}/`;
    let best = null;
    for (const a of links) {
      const url = new URL(a.getAttribute("href"), location.origin);
      if (!url.pathname.startsWith(target)) continue;
      const m = url.pathname.match(/\/novels\/[^/]+\/([0-9.]+)/);
      if (!m) continue;
      const num = parseFloat(m[1]);
      const cur = parseFloat(here.number);
      if (direction > 0 && num > cur && (best === null || num < best.num)) best = { num, path: url.pathname };
      if (direction < 0 && num < cur && (best === null || num > best.num)) best = { num, path: url.pathname };
    }
    return best ? best.path : null;
  }

  function goToChapter(path) {
    if (!path) return;
    GM_setValue("lr_autoplay_pending", "1");
    location.href = path;
  }

  function getMatchingPreload(path, settings) {
    const p = GM_getValue("lr_preload", null);
    if (p && p.path === path && p.voice === settings.voice && p.speed === settings.speed && p.engine === settings.engine) {
      return p;
    }
    return null;
  }

  // Remembers the synthesis job for whatever chapter this page is currently
  // on, so reloading the same chapter can reuse it instead of resynthesizing
  // from scratch -- as long as the server process is still the same one and
  // hasn't pruned or cancelled it (see tryReuseJob).
  function saveCurrentJob(path, settings, jobId) {
    GM_setValue("lr_current_job", { path, jobId, voice: settings.voice, speed: settings.speed, engine: settings.engine });
  }

  function getMatchingCurrentJob(path, settings) {
    const j = GM_getValue("lr_current_job", null);
    if (j && j.path === path && j.voice === settings.voice && j.speed === settings.speed && j.engine === settings.engine) {
      return j.jobId;
    }
    return null;
  }

  // Where playback was left off in whatever chapter was last playing --
  // a single slot, not a per-chapter history, so it only ever helps you
  // resume the one you most recently paused/left.
  function savePosition(path, settings, time) {
    GM_setValue("lr_position", { path, voice: settings.voice, speed: settings.speed, time });
  }

  function getMatchingPosition(path, settings) {
    const p = GM_getValue("lr_position", null);
    if (p && p.path === path && p.voice === settings.voice && p.speed === settings.speed) {
      return p.time;
    }
    return 0;
  }

  function clearPosition() {
    GM_setValue("lr_position", null);
  }

  async function schedulePreloadNextChapter(settings) {
    if (!settings.preloadNext) return;
    const nextPath = adjacentChapterHref(1);
    if (!nextPath) return;
    const m = nextPath.match(/\/novels\/([^/]+)\/([0-9.]+)/);
    if (!m) return;
    try {
      const text = await fetchChapterText(m[1], m[2]);
      const { job_id } = await startSynthesisJob(text, settings, true);
      GM_setValue("lr_preload", { path: nextPath, jobId: job_id, voice: settings.voice, speed: settings.speed, engine: settings.engine });
    } catch (err) {
      console.warn("Local Reader: preload failed", err);
    }
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function setStatus(text) {
    const node = el("lr-status");
    node.textContent = text;
    node.title = text;
  }

  function setProgress(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    setStatus(`Synthesizing... ${pct}%`);
  }

  function updatePlayButton() {
    const btn = el("lr-play");
    if (state === "loading") {
      btn.innerHTML = '<span class="lr-spinner"></span>';
      btn.disabled = true;
    } else if (state === "playing") {
      btn.innerHTML = ICON_PAUSE;
      btn.disabled = false;
    } else {
      btn.innerHTML = ICON_PLAY;
      btn.disabled = false;
    }
  }

  let lastPositionSave = 0;

  function updateSeekUI() {
    if (!currentAudio || seeking) return;
    const dur = currentAudio.duration || 0;
    const pct = dur ? (currentAudio.currentTime / dur) * 100 : 0;
    el("lr-seek").value = currentAudio.currentTime;
    el("lr-seek").max = dur;
    el("lr-fill").style.width = pct + "%";
    if (state === "playing") setStatus(`Reading · ${fmtTime(currentAudio.currentTime)} / ${fmtTime(dur)}`);
    else if (state === "paused") setStatus(`Paused · ${fmtTime(currentAudio.currentTime)} / ${fmtTime(dur)}`);

    const now = Date.now();
    if (now - lastPositionSave > 3000) {
      lastPositionSave = now;
      savePosition(location.pathname, getSettings(), currentAudio.currentTime);
    }
  }

  function attachAudioHandlers(audio, settings) {
    audio.addEventListener("timeupdate", updateSeekUI);
    audio.addEventListener("loadedmetadata", updateSeekUI);
    audio.addEventListener("play", () => {
      state = "playing";
      updatePlayButton();
      updateSeekUI();
    });
    audio.addEventListener("pause", () => {
      if (state !== "idle") state = "paused";
      updatePlayButton();
      if (!audio.ended) updateSeekUI();
    });
    audio.addEventListener("ended", () => {
      state = "idle";
      updatePlayButton();
      setStatus("Finished");
      clearPosition();
      if (settings.autoAdvance) {
        const next = adjacentChapterHref(1);
        if (next) goToChapter(next);
        else setStatus("No next chapter");
      }
    });
  }

  async function playFromScratch() {
    const here = parseChapter(location.pathname);
    if (!here) {
      setStatus("Not a chapter page");
      return;
    }
    state = "loading";
    updatePlayButton();
    const settings = getSettings();
    try {
      let blob = null;

      const preload = getMatchingPreload(location.pathname, settings);
      if (preload) {
        GM_setValue("lr_preload", null);
        currentJobId = preload.jobId;
        setStatus("Finishing preload...");
        blob = await tryReuseJob(preload.jobId, setProgress);
        currentJobId = null;
      }

      if (!blob) {
        const cachedJobId = getMatchingCurrentJob(location.pathname, settings);
        if (cachedJobId) {
          currentJobId = cachedJobId;
          setStatus("Resuming...");
          blob = await tryReuseJob(cachedJobId, setProgress);
          currentJobId = null;
        }
      }

      if (!blob) {
        setStatus("Fetching chapter...");
        const text = await fetchChapterText(here.slug, here.number);
        setStatus("Synthesizing... 0%");
        blob = await synthesize(text, settings, setProgress, location.pathname);
      }

      currentAudioUrl = URL.createObjectURL(blob);
      currentAudio = new Audio(currentAudioUrl);
      const resumeAt = getMatchingPosition(location.pathname, settings);
      if (resumeAt > 0) currentAudio.currentTime = resumeAt;
      attachAudioHandlers(currentAudio, settings);
      currentAudio.play();
      schedulePreloadNextChapter(settings);
    } catch (err) {
      console.error(err);
      setStatus("Error: " + err.message);
      state = "idle";
      currentJobId = null;
      updatePlayButton();
    }
  }

  function onPlayClick() {
    if (state === "playing") {
      currentAudio.pause();
      return;
    }
    if (state === "paused" && currentAudio) {
      currentAudio.play();
      return;
    }
    if (currentAudio && currentAudio.ended) {
      currentAudio.currentTime = 0;
      currentAudio.play();
      return;
    }
    playFromScratch();
  }

  function getSettings() {
    return {
      engine: GM_getValue("lr_engine", "kokoro"),
      voice: GM_getValue("lr_voice", "am_michael"),
      speed: parseFloat(GM_getValue("lr_speed", "1.0")),
      autoAdvance: GM_getValue("lr_auto_advance", "1") === "1",
      preloadNext: GM_getValue("lr_preload_next", "1") === "1",
    };
  }

  function resetForNewChapter() {
    if (currentJobId) {
      cancelJob(currentJobId);
      currentJobId = null;
    }
    const preload = GM_getValue("lr_preload", null);
    if (preload) {
      cancelJob(preload.jobId);
      GM_setValue("lr_preload", null);
    }
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = null;
    }
    // Speed changes the audio's own timeline, so a saved position in seconds
    // no longer points at the same spot in the chapter.
    clearPosition();
    state = "idle";
    updatePlayButton();
    setStatus("Ready");
    el("lr-seek").value = 0;
    el("lr-fill").style.width = "0%";
  }

  function buildStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #lr-panel, #lr-reopen {
        position: fixed; bottom: 20px; right: 20px; z-index: 999999;
        font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      }
      #lr-panel {
        width: 340px;
        max-width: calc(100vw - 40px);
        background: #16181c;
        color: #eceef0;
        border-radius: 16px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06);
      }
      #lr-track {
        position: relative;
        height: 4px;
        background: rgba(255,255,255,0.1);
        border-radius: 16px 16px 0 0;
        overflow: hidden;
      }
      #lr-fill {
        position: absolute; left: 0; top: 0; bottom: 0;
        width: 0%;
        background: #FF004F;
        border-radius: 0 3px 3px 0;
      }
      #lr-seek {
        position: absolute; inset: -6px 0;
        width: 100%; height: 16px;
        margin: 0; opacity: 0; cursor: pointer;
        -webkit-appearance: none;
      }
      .lr-row {
        display: flex; align-items: center; gap: 6px;
        padding: 10px 12px 12px;
      }
      .lr-icon-btn {
        background: none; border: none; color: #aab0b8;
        width: 30px; height: 30px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; flex: none;
        transition: background 0.15s, color 0.15s;
      }
      .lr-icon-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
      #lr-play {
        width: 34px; height: 34px;
        background: #FF004F; color: #fff;
        border: none; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; flex: none;
        margin: 0 2px;
      }
      #lr-play:hover { background: #FF3D71; }
      #lr-play svg { margin-left: 1px; }
      #lr-status {
        font-size: 12.5px; color: #9aa2ab;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
        margin-right: auto;
        padding-left: 2px;
      }
      .lr-select-wrap { position: relative; }
      .lr-select {
        appearance: none; -webkit-appearance: none;
        background: #23262b; color: #eceef0;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        font-size: 12.5px; font-weight: 600;
        padding: 6px 26px 6px 10px;
        cursor: pointer;
        width: 100%;
        box-sizing: border-box;
      }
      .lr-select:hover { background: #2b2f35; }
      .lr-select-wrap::after {
        content: "";
        position: absolute; right: 10px; top: 50%;
        width: 6px; height: 6px;
        border-right: 1.5px solid #9aa2ab; border-bottom: 1.5px solid #9aa2ab;
        transform: translateY(-70%) rotate(45deg);
        pointer-events: none;
      }
      .lr-spinner {
        width: 13px; height: 13px;
        border: 2px solid rgba(255,255,255,0.35);
        border-top-color: #fff;
        border-radius: 50%;
        animation: lr-spin 0.7s linear infinite;
      }
      @keyframes lr-spin { to { transform: rotate(360deg); } }
      #lr-reopen {
        width: 44px; height: 44px;
        background: #16181c; color: #eceef0;
        border-radius: 50%; border: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
      }
      #lr-reopen:hover { background: #1e2126; }
      #lr-menu {
        position: absolute;
        bottom: calc(100% + 8px);
        right: 12px;
        width: 190px;
        background: #1c1f24;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        padding: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.45);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      #lr-menu[hidden] { display: none; }
      .lr-menu-field {
        display: flex; flex-direction: column; gap: 4px;
        font-size: 11.5px; font-weight: 600; letter-spacing: 0.03em;
        text-transform: uppercase; color: #7d848c;
      }
      .lr-preload-row {
        display: flex; align-items: center; gap: 7px;
        font-size: 12.5px; color: #d7dade;
        cursor: pointer;
        user-select: none;
        border-top: 1px solid rgba(255,255,255,0.08);
        margin-top: 2px;
        padding-top: 10px;
      }
      .lr-preload-row input { cursor: pointer; }
    `;
    document.head.appendChild(style);
  }

  function voiceOptionsHtml() {
    const current = getSettings().voice;
    return VOICE_GROUPS.map(
      (g) =>
        `<optgroup label="${g.label}">` +
        g.voices.map((v) => `<option value="${v.id}" ${v.id === current ? "selected" : ""}>${v.label}</option>`).join("") +
        `</optgroup>`
    ).join("");
  }

  function speedOptionsHtml() {
    const current = getSettings().speed;
    return SPEEDS.map((s) => `<option value="${s}" ${s === current ? "selected" : ""}>${s}×</option>`).join("");
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = "lr-panel";
    panel.innerHTML = `
      <div id="lr-track">
        <div id="lr-fill"></div>
        <input id="lr-seek" type="range" min="0" max="0" value="0" step="0.1">
      </div>
      <div class="lr-row">
        <button id="lr-prev" class="lr-icon-btn" title="Previous chapter">${ICON_PREV}</button>
        <button id="lr-play" title="Play/Pause">${ICON_PLAY}</button>
        <button id="lr-next" class="lr-icon-btn" title="Next chapter">${ICON_NEXT}</button>
        <span id="lr-status">Ready</span>
        <button id="lr-more" class="lr-icon-btn" title="Settings">${ICON_DOTS}</button>
        <button id="lr-close" class="lr-icon-btn" title="Hide">${ICON_CLOSE}</button>
      </div>
      <div id="lr-menu" hidden>
        <label class="lr-menu-field">
          Voice
          <div class="lr-select-wrap">
            <select id="lr-voice" class="lr-select">${voiceOptionsHtml()}</select>
          </div>
        </label>
        <label class="lr-menu-field">
          Speed
          <div class="lr-select-wrap">
            <select id="lr-speed" class="lr-select">${speedOptionsHtml()}</select>
          </div>
        </label>
        <label class="lr-preload-row" title="Synthesize the next chapter in the background while you're reading this one">
          <input id="lr-preload" type="checkbox" ${getSettings().preloadNext ? "checked" : ""}> Preload next chapter
        </label>
      </div>
    `;
    document.body.appendChild(panel);

    el("lr-play").onclick = onPlayClick;
    el("lr-prev").onclick = () => goToChapter(adjacentChapterHref(-1));
    el("lr-next").onclick = () => goToChapter(adjacentChapterHref(1));

    el("lr-seek").addEventListener("mousedown", () => (seeking = true));
    el("lr-seek").addEventListener("touchstart", () => (seeking = true));
    el("lr-seek").addEventListener("input", (e) => {
      const dur = currentAudio ? currentAudio.duration : 0;
      const pct = dur ? (parseFloat(e.target.value) / dur) * 100 : 0;
      el("lr-fill").style.width = pct + "%";
    });
    el("lr-seek").addEventListener("change", (e) => {
      if (currentAudio) currentAudio.currentTime = parseFloat(e.target.value);
      seeking = false;
    });

    el("lr-voice").onchange = (e) => {
      GM_setValue("lr_voice", e.target.value);
      resetForNewChapter();
    };
    el("lr-speed").onchange = (e) => {
      GM_setValue("lr_speed", e.target.value);
      resetForNewChapter();
    };
    el("lr-close").onclick = () => {
      panel.style.display = "none";
      showReopenButton();
    };
    el("lr-preload").onchange = (e) => {
      GM_setValue("lr_preload_next", e.target.checked ? "1" : "0");
      if (!e.target.checked) GM_setValue("lr_preload", null);
    };

    el("lr-more").onclick = (e) => {
      e.stopPropagation();
      el("lr-menu").hidden = !el("lr-menu").hidden;
    };
    document.addEventListener("click", (e) => {
      const menu = el("lr-menu");
      if (!menu || menu.hidden) return;
      if (!menu.contains(e.target) && e.target !== el("lr-more")) menu.hidden = true;
    });
  }

  function showReopenButton() {
    let btn = document.getElementById("lr-reopen");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "lr-reopen";
      btn.title = "Show Local Reader";
      btn.innerHTML = ICON_HEADPHONES;
      btn.onclick = () => {
        btn.remove();
        el("lr-panel").style.display = "block";
      };
      document.body.appendChild(btn);
    }
  }

  buildStyles();
  buildPanel();

  // Leaving the page (reload, navigating away, closing the tab) abandons
  // whatever this page's own chapter job was doing -- tell the server so it
  // stops competing with whatever job starts next. Never cancels a preload
  // job (that one belongs to the next chapter, tracked separately).
  window.addEventListener("pagehide", () => cancelJob(currentJobId));

  if (GM_getValue("lr_autoplay_pending", "0") === "1") {
    GM_setValue("lr_autoplay_pending", "0");
    window.addEventListener("load", () => setTimeout(onPlayClick, 500));
  }
})();
