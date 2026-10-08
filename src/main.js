import { init, observeProperties, command, setProperty, getProperty } from "tauri-plugin-libmpv-api";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

const OBSERVED_PROPERTIES = [
  ["pause", "flag"],
  ["time-pos", "double", "none"],
  ["duration", "double", "none"],
  ["media-title", "string", "none"],
  ["volume", "double"],
  ["mute", "flag"],
  ["idle-active", "flag"],
];

const VIDEO_EXTENSIONS = ["mp4", "mkv", "webm", "avi", "mov", "wmv", "flv", "m4v", "ts", "mpg", "mpeg", "mp3", "flac", "wav", "ogg", "m4a"];
const SEEK_STEP = 10;
const HIDE_DELAY_MS = 3000;
const DOUBLE_TAP_MS = 300;

const $ = (id) => document.getElementById(id);
const els = {
  stage: $("stage"),
  empty: $("empty"),
  topbar: $("topbar"),
  controls: $("controls"),
  title: $("title"),
  tracksBtn: $("tracks"),
  tracksPanel: $("tracks-panel"),
  audioList: $("audio-list"),
  subList: $("sub-list"),
  seek: $("seek"),
  time: $("time"),
  duration: $("duration"),
  play: $("play"),
  mute: $("mute"),
  volume: $("volume"),
  hint: $("seek-hint"),
};

const state = { paused: true, idle: true, seeking: false };
const appWindow = getCurrentWindow();

// ---------- helpers ----------

function formatTime(sec) {
  if (sec == null || !isFinite(sec)) return "0:00";
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function paintRange(input) {
  const max = Number(input.max) || 1;
  input.style.setProperty("--pct", `${(Number(input.value) / max) * 100}%`);
}

// mpv calls are fire-and-forget from the UI; just log failures.
const mpv = (promise) => promise.catch((e) => console.error("mpv:", e));

// ---------- playback actions ----------

async function loadFile(path) {
  await mpv(command("loadfile", [path]));
  await mpv(setProperty("pause", false));
}

async function openFile() {
  const path = await open({
    multiple: false,
    filters: [{ name: "Media", extensions: VIDEO_EXTENSIONS }, { name: "All files", extensions: ["*"] }],
  });
  if (path) loadFile(path);
}

const togglePause = () => mpv(command("cycle", ["pause"]));
const seekBy = (sec) => mpv(command("seek", [sec, "relative"]));

async function toggleFullscreen() {
  await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
}

// ---------- controls visibility ----------

const barsHidden = () => els.controls.classList.contains("hidden");
const tracksOpen = () => !els.tracksPanel.classList.contains("hidden");

function setBarsHidden(hidden) {
  els.topbar.classList.toggle("hidden", hidden);
  els.controls.classList.toggle("hidden", hidden);
  document.body.style.cursor = hidden ? "none" : "";
}

let hideTimer;
function showControls() {
  setBarsHidden(false);
  clearTimeout(hideTimer);
  if (!state.paused && !state.idle && !tracksOpen()) {
    hideTimer = setTimeout(() => setBarsHidden(true), HIDE_DELAY_MS);
  }
}

let hintTimer;
function flashHint(text, side) {
  els.hint.textContent = text;
  els.hint.style.left = side === "left" ? "25%" : side === "right" ? "75%" : "50%";
  els.hint.classList.add("show");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => els.hint.classList.remove("show"), 600);
}

// ---------- touch / pointer gestures on the video area ----------
// Single tap: toggle controls. Double tap: left third = back, right third = forward,
// middle = play/pause.

let lastTap = 0;
let singleTapTimer;
els.stage.addEventListener("pointerup", (e) => {
  if (e.target.closest("button")) return;
  const now = performance.now();

  if (now - lastTap < DOUBLE_TAP_MS) {
    clearTimeout(singleTapTimer);
    lastTap = 0;
    const x = e.clientX / window.innerWidth;
    if (x < 1 / 3) {
      seekBy(-SEEK_STEP);
      flashHint(`« ${SEEK_STEP}s`, "left");
    } else if (x > 2 / 3) {
      seekBy(SEEK_STEP);
      flashHint(`${SEEK_STEP}s »`, "right");
    } else {
      togglePause();
    }
    return;
  }

  lastTap = now;
  singleTapTimer = setTimeout(() => {
    if (barsHidden()) showControls();
    else if (!state.paused) setBarsHidden(true);
  }, DOUBLE_TAP_MS);
});

// Mouse movement reveals controls (touch uses taps instead).
document.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") showControls();
});

// ---------- audio / subtitle picker ----------

function describeTrack(t) {
  const lang = t.lang ? t.lang.toUpperCase() : "";
  const name = t.title || lang || `Track ${t.id}`;
  const meta = [t.title && lang, t.codec, t.type === "audio" && t["demux-channel-count"] && `${t["demux-channel-count"]}ch`, t.default && "default", t.external && "external"]
    .filter(Boolean)
    .join(" · ");
  return { name, meta };
}

function trackItem({ name, meta, selected, onSelect }) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.className = selected ? "selected" : "";
  btn.innerHTML = `<span class="check">${selected ? "&#10003;" : ""}</span><span class="label"><span class="name"></span><span class="meta"></span></span>`;
  btn.querySelector(".name").textContent = name;
  btn.querySelector(".meta").textContent = meta;
  btn.onclick = onSelect;
  li.append(btn);
  return li;
}

function emptyNote(text) {
  const li = document.createElement("li");
  li.className = "empty-note";
  li.textContent = text;
  return li;
}

async function renderTracks() {
  let tracks = [];
  try {
    // Read as a JSON string: libmpv-wrapper's "node" conversion crashes on track-list.
    tracks = JSON.parse((await getProperty("track-list", "string")) || "[]");
  } catch (e) {
    console.error("mpv: track-list", e);
  }
  const audio = tracks.filter((t) => t.type === "audio");
  const subs = tracks.filter((t) => t.type === "sub");

  // aid/sid reject numeric values via setProperty, so go through the string-based `set` command.
  const select = (prop, value) => async () => {
    await mpv(command("set", [prop, String(value)]));
    renderTracks();
  };

  els.audioList.replaceChildren(
    ...(audio.length
      ? audio.map((t) => trackItem({ ...describeTrack(t), selected: t.selected, onSelect: select("aid", t.id) }))
      : [emptyNote("No audio tracks")]),
  );
  els.subList.replaceChildren(
    trackItem({ name: "Off", meta: "", selected: !subs.some((t) => t.selected), onSelect: select("sid", "no") }),
    ...subs.map((t) => trackItem({ ...describeTrack(t), selected: t.selected, onSelect: select("sid", t.id) })),
  );
}

async function openTracks() {
  await renderTracks();
  els.tracksPanel.classList.remove("hidden");
  showControls();
}

function closeTracks() {
  els.tracksPanel.classList.add("hidden");
  showControls();
}

els.tracksBtn.onclick = openTracks;
$("tracks-close").onclick = closeTracks;
// Tapping the dimmed backdrop (outside the dialog) closes it.
els.tracksPanel.addEventListener("click", (e) => {
  if (e.target === els.tracksPanel) closeTracks();
});

// ---------- control bars ----------

$("open").onclick = openFile;
$("open-big").onclick = openFile;
$("back").onclick = () => seekBy(-SEEK_STEP);
$("fwd").onclick = () => seekBy(SEEK_STEP);
$("fullscreen").onclick = toggleFullscreen;
els.play.onclick = togglePause;
els.mute.onclick = () => mpv(command("cycle", ["mute"]));

els.seek.addEventListener("input", () => {
  state.seeking = true;
  els.time.textContent = formatTime(Number(els.seek.value));
  paintRange(els.seek);
  showControls();
});
els.seek.addEventListener("change", async () => {
  await mpv(command("seek", [Number(els.seek.value), "absolute"]));
  state.seeking = false;
});

els.volume.addEventListener("input", () => {
  paintRange(els.volume);
  mpv(setProperty("volume", Number(els.volume.value)));
  showControls();
});

document.addEventListener("keydown", (e) => {
  if (tracksOpen()) {
    if (e.key === "Escape") closeTracks();
    return;
  }
  switch (e.key) {
    case " ":
      togglePause();
      break;
    case "ArrowLeft":
      seekBy(-5);
      break;
    case "ArrowRight":
      seekBy(5);
      break;
    case "f":
      toggleFullscreen();
      break;
    case "Escape":
      appWindow.setFullscreen(false);
      break;
    default:
      return;
  }
  e.preventDefault();
  showControls();
});

// Drag & drop a file onto the window to play it.
getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === "drop" && event.payload.paths.length) {
    loadFile(event.payload.paths[0]);
  }
});

// ---------- mpv state -> UI ----------

function updatePlayIcon() {
  els.play.innerHTML = state.paused || state.idle ? "&#9654;" : "&#10074;&#10074;";
}

function onProperty({ name, data }) {
  switch (name) {
    case "pause":
      state.paused = data;
      updatePlayIcon();
      showControls();
      break;
    case "time-pos":
      if (state.seeking) break;
      els.seek.value = data ?? 0;
      els.time.textContent = formatTime(data);
      paintRange(els.seek);
      break;
    case "duration":
      els.seek.max = data ?? 0;
      els.duration.textContent = formatTime(data);
      paintRange(els.seek);
      break;
    case "media-title":
      els.title.textContent = data ?? "";
      break;
    case "volume":
      els.volume.value = data;
      paintRange(els.volume);
      break;
    case "mute":
      els.mute.innerHTML = data ? "&#128263;" : "&#128266;";
      break;
    case "idle-active":
      state.idle = data;
      els.empty.classList.toggle("hidden", !data);
      els.tracksBtn.disabled = data;
      if (data && tracksOpen()) closeTracks();
      updatePlayIcon();
      showControls();
      break;
  }
}

async function start() {
  paintRange(els.volume);
  try {
    // Listen first so the initial property values emitted during init aren't missed.
    await observeProperties(OBSERVED_PROPERTIES, onProperty);
    await init({
      initialOptions: {
        vo: "gpu-next",
        hwdec: "auto-safe",
        "keep-open": "yes",
        "force-window": "yes",
        idle: "yes",
      },
      observedProperties: OBSERVED_PROPERTIES,
    });
  } catch (e) {
    console.error("mpv init failed:", e);
    els.empty.innerHTML = `<p>Failed to start mpv:<br>${String(e)}</p><p>Run <code>npm run setup-lib</code> and restart.</p>`;
  }
}

start();
