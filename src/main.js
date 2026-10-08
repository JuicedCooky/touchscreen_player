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
  centerControls: $("center-controls"),
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
  els.centerControls.classList.toggle("hidden", hidden);
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
// General-tab settings are rows of segmented buttons. All edits in the dialog (any tab,
// including the full-screen editors) go into `draft` and only take effect on Confirm.
// Saved values persist in localStorage and are re-applied to mpv on startup.

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
const DEFAULTS = {
  ...Object.fromEntries(SETTINGS.map((s) => [s.key, s.default])),
  tapZones: DEFAULT_TAP_ZONES,
  controlsLayout: "bar", // "bar": play/skip buttons in the bottom bar; "center": large, mid-screen
};
// How to apply settings that aren't rows in the General tab.
const EXTRA_APPLY = { controlsLayout: (v) => applyControlsLayout(v) };
// Which settings each tab's "Reset this tab" resets.
const TAB_KEYS = {
  general: SETTINGS.map((s) => s.key),
  customize: ["tapZones", "controlsLayout"],
};

const clone = (obj) => structuredClone(obj);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const settings = clone(DEFAULTS);
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {});
} catch {}
if (!Array.isArray(settings.tapZones) || settings.tapZones.length !== 2) settings.tapZones = DEFAULT_TAP_ZONES;
if (!["bar", "center"].includes(settings.controlsLayout)) settings.controlsLayout = DEFAULTS.controlsLayout;

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}

function updateSkipLabels() {
  els.back.innerHTML = `&#8634; ${settings.seekStep}`;
  els.fwd.innerHTML = `${settings.seekStep} &#8635;`;
}

let draft = clone(settings);
let activeTab = "general";

function renderSettings() {
  renderGeneralTab();
  const [l, r] = draft.tapZones;
  $("layout-value").textContent = `Playback buttons: ${draft.controlsLayout === "center" ? "Centered" : "In bottom bar"}`;
  $("zones-value").textContent =`Current: ${[l, r - l, 1 - r].map((f) => Math.round(f * 100)).join("% / ")}%`;

  const allSame = (a, b, keys = Object.keys(DEFAULTS)) => keys.every((k) => same(a[k], b[k]));
  $("settings-confirm").disabled = allSame(draft, settings);
  $("settings-reset-all").disabled = allSame(draft, DEFAULTS);
  $("settings-reset-tab").disabled = allSame(draft, DEFAULTS, TAB_KEYS[activeTab]);
}

function renderGeneralTab() {
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
        btn.classList.toggle("selected", draft[def.key] === value);
        btn.onclick = () => {
          draft[def.key] = value;
          renderSettings();
        };
        group.append(btn);
      }
      row.append(h, group);
      return row;
    }),
  );
}

// Opening always starts a fresh draft, so closing the dialog any other way than
// Confirm (Cancel, ✕, backdrop, Esc) discards pending changes.
$("settings").onclick = () => {
  draft = clone(settings);
  renderSettings();
  openModal(els.settingsPanel);
};

$("settings-cancel").onclick = closeModals;

$("settings-reset-all").onclick = async () => {
  const ok = await askConfirm({
    title: "Reset all settings?",
    message: "Every setting in every tab will go back to its default. Nothing is saved until you press Confirm.",
    action: "Reset all",
  });
  if (!ok) return;
  draft = clone(DEFAULTS);
  renderSettings();
};

$("settings-reset-tab").onclick = async () => {
  const tabName = els.settingsPanel.querySelector(`[data-tab="${activeTab}"]`).textContent;
  const ok = await askConfirm({
    title: `Reset ${tabName} settings?`,
    message: `Settings in the ${tabName} tab will go back to their defaults. Nothing is saved until you press Confirm.`,
    action: "Reset tab",
  });
  if (!ok) return;
  for (const key of TAB_KEYS[activeTab]) draft[key] = clone(DEFAULTS[key]);
  renderSettings();
};

$("settings-confirm").onclick = () => {
  for (const key of Object.keys(DEFAULTS)) {
    if (same(draft[key], settings[key])) continue;
    settings[key] = clone(draft[key]);
    const apply = SETTINGS.find((s) => s.key === key)?.apply ?? EXTRA_APPLY[key];
    apply?.(settings[key]);
  }
  Object.assign(settings, clone(draft));
  saveSettings();
  closeModals();
};

const tabs = els.settingsPanel.querySelectorAll("[data-tab]");
tabs.forEach((tab) => {
  tab.onclick = () => {
    activeTab = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    els.settingsPanel.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.panel !== tab.dataset.tab);
    });
    renderSettings();
  };
});

// ---------- full-screen editors (opened from the Customize UI tab) ----------
// Each editor is a `.customize` screen with a [data-cancel] button; closing one returns
// to the Settings dialog.

const openEditor = () => document.querySelector(".customize:not(.hidden)");

// Lets a panel be dragged around by any part that isn't a button, kept inside the window.
// Dragging switches it from its CSS-centered position to explicit left/top pixels;
// resetPanelPosition() hands positioning back to the stylesheet.
function makeDraggable(panel) {
  let start = null;
  panel.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, w: rect.width, h: rect.height };
    Object.assign(panel.style, { left: `${rect.left}px`, top: `${rect.top}px`, bottom: "auto", transform: "none" });
    panel.setPointerCapture(e.pointerId);
    panel.classList.add("dragging");
  });
  panel.addEventListener("pointermove", (e) => {
    if (!start) return;
    const left = Math.min(window.innerWidth - start.w, Math.max(0, start.left + e.clientX - start.x));
    const top = Math.min(window.innerHeight - start.h, Math.max(0, start.top + e.clientY - start.y));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  const stop = () => {
    start = null;
    panel.classList.remove("dragging");
  };
  panel.addEventListener("pointerup", stop);
  panel.addEventListener("pointercancel", stop);
}

function resetPanelPosition(panel) {
  panel.style.removeProperty("left");
  panel.style.removeProperty("top");
  panel.style.removeProperty("bottom");
  panel.style.removeProperty("transform");
}

document.querySelectorAll(".customize-panel").forEach(makeDraggable);

function showEditor(editor) {
  editor.querySelectorAll(".customize-panel").forEach(resetPanelPosition);
  els.settingsPanel.classList.add("hidden");
  editor.classList.remove("hidden");
  document.body.classList.add("customizing");
}

function closeEditor() {
  document.querySelectorAll(".customize").forEach((ed) => ed.classList.add("hidden"));
  document.body.classList.remove("customizing");
  openModal(els.settingsPanel);
}

// ---------- controls layout ----------
// Moves the back / play / forward buttons between the bottom bar and the
// mid-screen container. The buttons keep their ids and handlers either way.

const playbackButtons = () => [els.back, els.play, els.fwd];

function applyControlsLayout(layout) {
  if (layout === "center") els.centerControls.append(...playbackButtons());
  else els.controls.querySelector(".button-row").prepend(...playbackButtons());
}

// ---------- layout customizer ----------
// Shows non-interactive copies of the live bars in place. The toolbar's layout toggle
// is previewed by temporarily applying it to the (hidden) real controls and re-cloning;
// closing the editor restores the saved layout. Save puts the choice in the settings draft.

let layoutChoice = DEFAULTS.controlsLayout;

function renderLayoutPreview() {
  applyControlsLayout(layoutChoice);
  const preview = [els.topbar, els.controls, els.centerControls].map((bar) => {
    const copy = bar.cloneNode(true);
    copy.removeAttribute("id");
    copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    copy.classList.remove("hidden");
    copy.inert = true;
    return copy;
  });
  $("customize-preview").replaceChildren(...preview);
  els.customize.querySelectorAll("[data-layout]").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.layout === layoutChoice);
  });
}

function openCustomize() {
  layoutChoice = draft.controlsLayout;
  renderLayoutPreview();
  showEditor(els.customize);
}

function closeCustomize() {
  applyControlsLayout(settings.controlsLayout);
  $("customize-preview").replaceChildren();
  closeEditor();
}

els.customize.querySelectorAll("[data-layout]").forEach((btn) => {
  btn.onclick = () => {
    layoutChoice = btn.dataset.layout;
    renderLayoutPreview();
  };
});

$("open-customize").onclick = openCustomize;
$("customize-cancel").onclick = closeCustomize;
$("customize-save").onclick = () => {
  draft.controlsLayout = layoutChoice;
  closeCustomize();
  renderSettings();
};

// ---------- double-tap zone editor ----------
// Two draggable dividers split the screen into skip-back / play-pause / skip-forward
// areas. Save copies the editor's working values into the settings draft; they're only
// stored when the Settings dialog is confirmed.

const MIN_ZONE = 0.1; // no zone may be narrower than 10% of the width
const zonesEl = $("zones");
const zoneEls = zonesEl.querySelectorAll(".zone");
const dividerEls = zonesEl.querySelectorAll(".divider");
let zonesDraft = [...DEFAULT_TAP_ZONES];

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
  zonesDraft = [...draft.tapZones];
  renderZones();
  showEditor(zonesEl);
};
$("zones-reset").onclick = () => {
  zonesDraft = [...DEFAULT_TAP_ZONES];
  renderZones();
};
$("zones-cancel").onclick = closeEditor;
$("zones-save").onclick = () => {
  draft.tapZones = [...zonesDraft];
  closeEditor();
  renderSettings();
};

// ---------- confirmation box ----------
// askConfirm() shows a yes/no box above everything else and resolves to true only if
// the action button is pressed. Cancel, Esc and tapping outside resolve to false.

const confirmEl = $("confirm");
let resolveConfirm = null;

function askConfirm({ title, message, action }) {
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-yes").textContent = action;
  confirmEl.classList.remove("hidden");
  $("confirm-no").focus(); // the safe choice gets focus, so a stray Enter doesn't reset
  return new Promise((resolve) => (resolveConfirm = resolve));
}

function answerConfirm(ok) {
  confirmEl.classList.add("hidden");
  resolveConfirm?.(ok);
  resolveConfirm = null;
}

const confirmOpen = () => !confirmEl.classList.contains("hidden");
$("confirm-yes").onclick = () => answerConfirm(true);
$("confirm-no").onclick = () => answerConfirm(false);
confirmEl.addEventListener("click", (e) => {
  if (e.target === confirmEl) answerConfirm(false);
});

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
  if (confirmOpen()) {
    if (e.key === "Escape") answerConfirm(false);
    return;
  }
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
      document.body.classList.toggle("idle", data);
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
  applyControlsLayout(settings.controlsLayout);
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
