# Flinkynotes for Windows

Local-only Windows desktop app (Electron, no telemetry, no accounts, no network)
combining break reminders with edge-docked sticky notes in one tray process.

Flinkynotes is an open-source reimplementation inspired by Lookaway
(lookaway.com) and Holdmynotes.

## Features

### Break reminders
- **Mini + long breaks** — short eye rests (default every 10 min for 20 s) and
  proper stand-up breaks (default every 3rd mini for 5 min), with a
  **pre-break warning pill** so a break never ambushes you.
- **Fullscreen break overlay** on one or all displays, with break ideas,
  chime, strict mode, manual finish, skip/postpone control, `+1m/+5m/+15m`
  defer, additive snooze, pause-for-an-hour and pause-until-morning.
- **Classic + 20-20-20 presets**, fully tunable intervals and durations.

### Pomodoro timer
- Floating clock window with work / short-break / long-break cycles,
  per-cycle long breaks, day-rolled counters, subjects, and a productivity
  report (today, week, month, best day).

### Edge-docked sticky notes
- A **note deck on the right screen edge**: shingled tabs, hover previews,
  floating editors, pin/lock, hideable edge strip.
- **Checklist editor**: every line gets a real checkbox with inline editing
  (`Enter` adds a row, `Backspace` merges, `Ctrl+T` toggles, multi-line paste
  splits into rows, `Ctrl+F` finds across rows), plus a raw **Text view**
  fallback — both edit the same plain-text body.
- Encrypted at rest (AES-256-GCM), searchable list with archive, import/export
  (Markdown + `.stickynotes.json`), quick capture to new or existing notes.

### Wellness, nudges, schedule
- **Wellness dashboard**: health score (`100 − 5×skipped − 1×postponed − 3 per
  40m+ session`), streaks, screen time, taken/skipped/postponed counts, week
  chart — all updating live as breaks happen.
- **Nudges**: posture and blink reminders plus your own custom reminders on a
  schedule, delivered as quiet notifications.
- **Work schedule**: breaks only fire inside your active hours; outside them
  the countdown holds still. One-click meeting pause from the tray.

### Tray-first, keyboard-driven
- Tray icon with live countdown tooltip, full break/note/pomodoro menu, and
  double-click to open Home.
- Global shortcuts: `Alt+Ctrl+N` new note · `Alt+Ctrl+A` all notes ·
  `Alt+Ctrl+L` archive · `Alt+Ctrl+T` break settings · `Alt+Ctrl+H` home ·
  `Ctrl+Shift+Space` quick capture · break screen `Ctrl+X`/`Esc` skip ·
  editor `Esc` tuck, `Ctrl+T` task, `Ctrl+F` find, `Ctrl+S` save.

## Install

Download **`Flinkynotes Setup 1.0.0.exe`** (per-user installer, desktop
shortcut) or **`Flinkynotes 1.0.0.exe`** (portable, runs anywhere) from the
[v1.0.0 release](../../releases/tag/v1.0.0).

Installers are unsigned, so Windows SmartScreen warns on first run — this is
expected for an independent open-source build.

Optional: Home → System → **Start with Windows** signs you in to tray-only
(no extra window at login).

## Where data lives

Everything stays on your machine:

- Settings: `%APPDATA%\Flinkynotes\settings.json`
- Wellness stats: `%APPDATA%\Flinkynotes\wellness.json`
- Notes DB + key: `%APPDATA%\Flinkynotes\notes\{notes.json,data.key}`

Note bodies are AES-256-GCM encrypted (key in `data.key`, owner-only). On the
first packaged run after the brand rename, data is carried over once from the
old pre-rename folder. Uninstall the app any time — delete the folder above to
remove every trace.

## Build from source

```powershell
npm install
npm start          # run the app
npm test           # unit tests (pure engines, no Electron needed)
npm run dist       # Windows portable + NSIS setup into dist/
```

Requires Node.js (Electron 33 bundles Node 20). There are **zero runtime
dependencies** — only `electron`, `electron-builder` (and `rcedit` for the
build-time icon step) as devDependencies.

## Architecture (overview)

- **Main process** (`src/main/`) owns windows, tray, the 1 s tick, IPC,
  placement and persistence. Pure, testable engines (`focusEngine`,
  `pomodoroEngine`, `wellness`, `nudges`, `scheduleGuard`, `deckLayout`,
  `geometry`, `checklist`) have no Electron imports and are exercised by
  `node tests/run.js` (51 tests).
- **Renderers are dumb views** (`src/renderer/`): they render state received
  over IPC (`window.api` bridge, `contextIsolation` on every window) and send
  button presses back. Main owns all timing, guards and window bounds.
- **Deck placement**: the renderer reports window-local content rects with a
  generation stamp; main translates by its own bounds origin and resizes the
  native window to hug content (center on rest/wake/structural change, glue
  on preview show/hide). The hide-edge-strip toggle is driven by main, so it
  recovers without a restart.
- **Storage**: atomic tmp-file + rename writes everywhere; notes bodies stay
  plain text (`☐`/`☑`, `- [ ]`/`- [x]`) so encryption, export/import, deck
  previews and stats always agree via the shared `checklist` module.

Deep dives live in [`docs/`](docs/):

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full technical reference:
  processes, windows, IPC contract, engines, storage, placement pipeline,
  conventions, testing, build & release.
- [`docs/TIMER.md`](docs/TIMER.md) — break-timer subsystem in depth.
- [`docs/V3-DECK.md`](docs/V3-DECK.md) — note-deck reconstruction notes.
- [`docs/FEATURE-PORTS.md`](docs/FEATURE-PORTS.md) — feature ports.
- [`docs/THEME.md`](docs/THEME.md) — theme mapping.

## License

MIT — see [LICENSE](LICENSE).
