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
const HIDE_DELAY_MS = 3000;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 12; // movement allowed before a press stops counting as a tap
const SWIPE_MIN_PX = 60;
const SWIPE_MAX_MS = 600;

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
  settingsPanel: $("settings-panel"),
  settingsBody: $("settings-body"),
  customize: $("customize"),
  back: $("back"),
  fwd: $("fwd"),
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
const modalOpen = () => !!document.querySelector(".modal:not(.hidden)");

function setBarsHidden(hidden) {
  els.topbar.classList.toggle("hidden", hidden);
  els.controls.classList.toggle("hidden", hidden);
  document.body.style.cursor = hidden ? "none" : "";
}

let hideTimer;
function showControls() {
  setBarsHidden(false);
  clearTimeout(hideTimer);
  if (!state.paused && !state.idle && !modalOpen()) {
    hideTimer = setTimeout(() => setBarsHidden(true), HIDE_DELAY_MS);
  }
}

let hintTimer;
function flashHint(text, side) {
  els.hint.textContent = text;
  // Center the hint in the double-tap zone it belongs to.
  const [leftEdge, rightEdge] = settings.tapZones;
  const pos = side === "left" ? leftEdge / 2 : side === "right" ? (1 + rightEdge) / 2 : (leftEdge + rightEdge) / 2;
  els.hint.style.left = `${pos * 100}%`;
  els.hint.classList.add("show");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => els.hint.classList.remove("show"), 600);
}

// ---------- touch / pointer gestures on the video area ----------
// Single tap: toggle controls. Double tap: left third = back, right third = forward,
// middle = play/pause. Horizontal swipe: right = forward, left = back.
// Works for touch, pen and mouse (double-click / click-drag).

function skip(direction) {
  const step = settings.seekStep * direction;
  seekBy(step);
  flashHint(direction < 0 ? `« ${-step}s` : `${step}s »`, direction < 0 ? "left" : "right");
}

let press = null; // { id, x, y, t } of the pointer currently down on the stage
let lastTap = 0;
let singleTapTimer;

els.stage.addEventListener("pointerdown", (e) => {
  if (!e.isPrimary || e.target.closest("button")) return;
  press = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
  // Keep receiving the pointer even if a swipe ends over one of the bars.
  els.stage.setPointerCapture(e.pointerId);
});

els.stage.addEventListener("pointercancel", () => (press = null));

els.stage.addEventListener("pointerup", (e) => {
  if (!press || e.pointerId !== press.id) return;
  const now = performance.now();
  const dx = e.clientX - press.x;
  const dy = e.clientY - press.y;
  const dt = now - press.t;
  press = null;
  // Swipe: a quick, mostly-horizontal flick.
  if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > 2 * Math.abs(dy) && dt <= SWIPE_MAX_MS) {
    clearTimeout(singleTapTimer);
    lastTap = 0;
    skip(Math.sign(dx));
    return;
  }
  // Any other drag is neither a tap nor a swipe.
  if (Math.hypot(dx, dy) > TAP_SLOP_PX) return;

  if (now - lastTap < DOUBLE_TAP_MS) {
    clearTimeout(singleTapTimer);
    lastTap = 0;
    const x = e.clientX / window.innerWidth;
    const [leftEdge, rightEdge] = settings.tapZones;
    if (x < leftEdge) skip(-1);
    else if (x > rightEdge) skip(1);
    else {
      flashHint(state.paused ? "▶" : "❚❚", "center");
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

els.tracksBtn.onclick = async () => {
  await renderTracks();
  openModal(els.tracksPanel);
};

// ---------- settings ----------
// Each setting is a row of segmented buttons; values persist in localStorage and are
// re-applied to mpv on startup.

const SETTINGS = [
  {
    key: "seekStep",
    label: "Skip step (buttons & double-tap)",
    default: 10,
    options: [[5, "5s"], [10, "10s"], [15, "15s"], [30, "30s"]],
    apply: updateSkipLabels,
  },
  {
    key: "subScale",
    label: "Subtitle size",
    default: 1,
    options: [[0.75, "Small"], [1, "Normal"], [1.4, "Large"], [1.8, "Extra large"]],
    apply: (v) => mpv(command("set", ["sub-scale", String(v)])),
  },
  {
    key: "hwdec",
    label: "Hardware decoding",
    default: "auto-safe",
    options: [["auto-safe", "On"], ["no", "Off"]],
    apply: (v) => mpv(command("set", ["hwdec", v])),
  },
];

const STORAGE_KEY = "touch-player-settings";
// Double-tap zone boundaries as fractions of the window width: [left|center, center|right].
const DEFAULT_TAP_ZONES = [1 / 3, 2 / 3];
const settings = Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));
settings.tapZones = DEFAULT_TAP_ZONES;
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {});
} catch {}
if (!Array.isArray(settings.tapZones) || settings.tapZones.length !== 2) settings.tapZones = DEFAULT_TAP_ZONES;

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}

function updateSkipLabels() {
  els.back.innerHTML = `&#8634; ${settings.seekStep}`;
  els.fwd.innerHTML = `${settings.seekStep} &#8635;`;
}

function changeSetting(def, value) {
  settings[def.key] = value;
  saveSettings();
  def.apply(value);
  renderSettings();
}

function renderSettings() {
  els.settingsBody.replaceChildren(
    ...SETTINGS.map((def) => {
      const row = document.createElement("section");
      row.className = "setting";
      const h = document.createElement("h3");
      h.textContent = def.label;
      const group = document.createElement("div");
      group.className = "segmented";
      for (const [value, label] of def.options) {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.classList.toggle("selected", settings[def.key] === value);
        btn.onclick = () => changeSetting(def, value);
        group.append(btn);
      }
      row.append(h, group);
      return row;
    }),
  );
}

$("settings").onclick = () => {
  renderSettings();
  openModal(els.settingsPanel);
};

const tabs = els.settingsPanel.querySelectorAll("[data-tab]");
tabs.forEach((tab) => {
  tab.onclick = () => {
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    els.settingsPanel.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.panel !== tab.dataset.tab);
    });
  };
});

// ---------- full-screen editors (opened from the Customize UI tab) ----------
// Each editor is a `.customize` screen with a [data-cancel] button; closing one returns
// to the Settings dialog.

const openEditor = () => document.querySelector(".customize:not(.hidden)");

function showEditor(editor) {
  els.settingsPanel.classList.add("hidden");
  editor.classList.remove("hidden");
  document.body.classList.add("customizing");
}

function closeEditor() {
  document.querySelectorAll(".customize").forEach((ed) => ed.classList.add("hidden"));
  document.body.classList.remove("customizing");
  openModal(els.settingsPanel);
}

// ---------- layout customizer ----------
// Shows non-interactive copies of the live bars in place. Save is a stub until the
// layout becomes editable.

function openCustomize() {
  const preview = [els.topbar, els.controls].map((bar) => {
    const copy = bar.cloneNode(true);
    copy.removeAttribute("id");
    copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    copy.classList.remove("hidden");
    copy.inert = true;
    return copy;
  });
  $("customize-preview").replaceChildren(...preview);
  showEditor(els.customize);
}

function closeCustomize() {
  $("customize-preview").replaceChildren();
  closeEditor();
}

$("open-customize").onclick = openCustomize;
$("customize-cancel").onclick = closeCustomize;
$("customize-save").onclick = closeCustomize; // nothing to persist yet

// ---------- double-tap zone editor ----------
// Two draggable dividers split the screen into skip-back / play-pause / skip-forward
// areas. Edits go to a draft that is only stored on Save.

const MIN_ZONE = 0.1; // no zone may be narrower than 10% of the width
const zonesEl = $("zones");
const zoneEls = zonesEl.querySelectorAll(".zone");
const dividerEls = zonesEl.querySelectorAll(".divider");
let zonesDraft = [...settings.tapZones];

function renderZones() {
  const edges = [0, ...zonesDraft, 1];
  zoneEls.forEach((zone, i) => {
    zone.style.left = `${edges[i] * 100}%`;
    zone.style.width = `${(edges[i + 1] - edges[i]) * 100}%`;
    zone.querySelector(".zone-pct").textContent = `${Math.round((edges[i + 1] - edges[i]) * 100)}%`;
  });
  dividerEls.forEach((div, i) => (div.style.left = `${zonesDraft[i] * 100}%`));
}

dividerEls.forEach((div, i) => {
  div.addEventListener("pointerdown", (e) => {
    div.setPointerCapture(e.pointerId);
    div.classList.add("dragging");
  });
  div.addEventListener("pointermove", (e) => {
    if (!div.hasPointerCapture(e.pointerId)) return;
    const lo = i === 0 ? MIN_ZONE : zonesDraft[0] + MIN_ZONE;
    const hi = i === 0 ? zonesDraft[1] - MIN_ZONE : 1 - MIN_ZONE;
    zonesDraft[i] = Math.min(hi, Math.max(lo, e.clientX / window.innerWidth));
    renderZones();
  });
  const stop = () => div.classList.remove("dragging");
  div.addEventListener("pointerup", stop);
  div.addEventListener("pointercancel", stop);
});

$("open-zones").onclick = () => {
  zonesDraft = [...settings.tapZones];
  renderZones();
  showEditor(zonesEl);
};
$("zones-reset").onclick = () => {
  zonesDraft = [...DEFAULT_TAP_ZONES];
  renderZones();
};
$("zones-cancel").onclick = closeEditor;
$("zones-save").onclick = () => {
  settings.tapZones = [...zonesDraft];
  saveSettings();
  closeEditor();
};

// ---------- modals ----------

function openModal(panel) {
  panel.classList.remove("hidden");
  showControls();
}

function closeModals() {
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
  showControls();
}

document.querySelectorAll(".modal").forEach((modal) => {
  // Tapping the dimmed backdrop (outside the dialog) closes it.
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("[data-close]")) closeModals();
  });
});

// ---------- control bars ----------

$("open").onclick = openFile;
$("open-big").onclick = openFile;
els.back.onclick = () => seekBy(-settings.seekStep);
els.fwd.onclick = () => seekBy(settings.seekStep);
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
  const editor = openEditor();
  if (editor) {
    if (e.key === "Escape") editor.querySelector("[data-cancel]").click();
    return;
  }
  if (modalOpen()) {
    if (e.key === "Escape") closeModals();
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
      if (data) els.tracksPanel.classList.add("hidden");
      updatePlayIcon();
      showControls();
      break;
  }
}

async function start() {
  paintRange(els.volume);
  updateSkipLabels();
  try {
    // Listen first so the initial property values emitted during init aren't missed.
    await observeProperties(OBSERVED_PROPERTIES, onProperty);
    await init({
      initialOptions: {
        vo: "gpu-next",
        hwdec: settings.hwdec,
        "sub-scale": String(settings.subScale),
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
