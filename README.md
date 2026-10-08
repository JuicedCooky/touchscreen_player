# touchscreen_player

A simple touch-friendly video player for Windows, built with [Tauri 2](https://v2.tauri.app/) and libmpv
(via [`tauri-plugin-libmpv`](https://github.com/nini22P/tauri-plugin-libmpv)).

mpv renders directly into the native window; the webview is transparent and draws the controls on top.

## Setup

Prerequisites: Rust, Node.js, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (WebView2, MSVC build tools).

```sh
npm install
npm run setup-lib   # downloads libmpv-2.dll + libmpv-wrapper.dll into src-tauri/lib (gitignored)
npm run tauri dev
```

Build an installer with `npm run tauri build`. The DLLs in `src-tauri/lib` are bundled as resources.

## Controls

| Action | Touch | Mouse / keyboard |
| --- | --- | --- |
| Show / hide controls | Tap | Move mouse |
| Skip back / forward (step set in Settings, default 10 s) | Double-tap left / right third, or swipe left / right | ← / → (±5 s) |
| Play / pause | Double-tap center | Space |
| Fullscreen | ⛶ button | F / Esc |
| Open file | Open button (top bar) or drag & drop | |
| Audio / subtitle tracks | Audio / Subs button (top bar) | Esc closes the picker |

## Layout

- `index.html`, `src/` — UI (vanilla JS + Vite), talks to mpv through `tauri-plugin-libmpv-api`
- `src-tauri/` — Tauri app; registers the `libmpv` and `dialog` plugins
