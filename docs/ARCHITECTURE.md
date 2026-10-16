# Flinkynotes — Architecture

Production reference for the v1.0.0 codebase.
Covers the runtime as built
(`BUILD 2026-10-15.1`, Electron 33, zero runtime dependencies).
Subsystem deep-dives live in [`TIMER.md`](TIMER.md) (break timer),
[`V3-DECK.md`](V3-DECK.md) (deck reconstruction history),
[`FEATURE-PORTS.md`](FEATURE-PORTS.md) (feature ports) and
[`THEME.md`](THEME.md) (theme mapping).

Contents:

1. [System overview](#1-system-overview)
2. [Processes and the preload bridge](#2-processes-and-the-preload-bridge)
3. [Main-process modules](#3-main-process-modules)
4. [Windows inventory](#4-windows-inventory)
5. [IPC contract](#5-ipc-contract)
6. [Deck placement pipeline](#6-deck-placement-pipeline)
7. [Notes data model and storage](#7-notes-data-model-and-storage)
8. [Timer state machines](#8-timer-state-machines)
9. [Wellness, nudges, schedule](#9-wellness-nudges-schedule)
10. [Tray, shortcuts, lifecycle](#10-tray-shortcuts-lifecycle)
11. [Settings reference](#11-settings-reference)
12. [Cross-cutting conventions](#12-cross-cutting-conventions)
13. [Testing](#13-testing)
14. [Build, icons and release](#14-build-icons-and-release)
15. [Known limitations](#15-known-limitations)

---

## 1. System overview

```
┌──────────────────────────────────────────────────────────────┐
│  MAIN PROCESS  src/main/main.js (+ pure engines/stores)      │
│  - owns: windows, tray, 1s tick, IPC handlers, placement     │
│  - pure logic (testable): focusEngine, pomodoroEngine,       │
│    wellness, nudges, scheduleGuard, deckLayout, geometry,     │
│    noteSizes · I/O stores: jsonStore, notesStore             │
└───────────────┬──────────────────────────────┬───────────────┘
                │  preload.js (contextBridge)  │
                │  invoke (request/response)   │
                │  send/on (fire-and-forget)   │
┌───────────────┴──────────────┐  ┌─────────────┴───────────────┐
│  RENDERERS (dumb views)      │  │  OS / Electron services     │
│  deck · editor · clock ·     │  │  powerMonitor · tasklist    │
│  home · break · pill ·       │  │  Notification · Tray · Menu │
│  all · capture               │  │  globalShortcut · dialog    │
└──────────────────────────────┘  └─────────────────────────────┘
```

Design rules:

- **Renderers are dumb views.** They render state received over IPC and send
  button presses back. All timing, guards, persistence and window management
  live in main.
- **Engines are pure.** `focusEngine`, `pomodoroEngine`, `wellness`,
  `nudges`, `scheduleGuard`, `deckLayout`, `geometry`, `noteSizes` have no
  Electron imports (except `fs`/`path`/`crypto` in stores) and are exercised
  by `node tests/run.js` (33 tests).
- **Local-only.** No network calls, accounts, or telemetry. Bodies are
  AES-256-GCM encrypted at rest; the key is a 0600-mode local file.

## 2. Processes and the preload bridge

`src/main/preload.js` exposes a single `window.api` object via
`contextBridge` (`contextIsolation: true`, `nodeIntegration: false` on every
window). Two call shapes:

| Shape | Mechanism | Used for |
| --- | --- | --- |
| `invoke` / `handle` | Request/response, awaited | State reads, mutations (`focus:state`, `notes:update`, `deck:save`, …) |
| `send` / `on` | Fire-and-forget events | Tucks, zones, stage echoes, ticks, pushes (`note:tuck`, `deck:zones`, `focus:tick`, `notes:changed`, …) |

Historical note: a tuck sent with `invoke` against an `on`-only handler never
ran on Electron 33, which once made Delete/Archive/Close silently dead. The
rule is: **match the shape on both ends** (`tuckNote` uses `send`, main uses
`ipcMain.on`).

## 3. Main-process modules

| Module | Role | Electron deps |
| --- | --- | --- |
| `main.js` (~1100 lines) | Windows, tray, loops, all IPC handlers, deck placement, harnesses | All |
| `focusEngine.js` | Break state machine `focus → prebreak → break → focus`; snooze/postpone/defer/skip/finish; presets | None |
| `pomodoroEngine.js` | Pomodoro states `idle/work/shortBreak/longBreak/paused`; per-cycle long break; day-rolled counter; context-aware skip | None |
| `wellness.js` | `WellnessStore` over a JSON file: daily counters, session lengths, health score, streak, week | `fs`, `path` |
| `nudges.js` | Posture/blink/custom-reminder scheduler (`due()` + re-arm); reminder presets | `crypto` |
| `scheduleGuard.js` | Work-schedule active-hours check (`1=Mon..7=Sun`, overnight-aware) | None |
| `deckLayout.js` | Pure deck-window math: zone union, bounds, pitch, placement policy | None (+`geometry`) |
| `geometry.js` | `clamp`, top-band clock clamp, shingle-pitch sizing | None |
| `noteSizes.js` | Editor presets compact/classic/large; pristine-blank reuse test | None |
| `jsonStore.js` | Atomic JSON key/value store (tmp-file + rename); replaces `electron-store` (v10 is ESM-only and silently no-op'd under `require`) | `electron` (`app` path) |
| `notesStore.js` | Encrypted notes DB (see §7) | `electron` (`app` path), `fs`, `path`, `crypto` |
| `checklist.js` | Pure checklist model shared by store + editor (`parseRows`/`serializeRows`/`countTasks`/…); UMD-guarded | None |
| `dataPaths.js` | On-disk rebrand migration (settings + notes dir renames, idempotent); pure + tested | `fs`, `path` |
| `preload.js` | `window.api` bridge (see §2, §5) | `electron` |

## 4. Windows inventory

All windows: `contextIsolation: true`, `hasShadow: false`,
`<title>Flinkynotes</title>` (taskbar/Alt-Tab label),
`icon: faviconPath()` (see §14 for the asar caveat), `skipTaskbar: true`
except Home. Helper `mkWin(name, file, opts, show)` reuses a live window
(`show()` + `focus()`) instead of duplicating it.

| Key | File | Geometry / flags | Purpose |
| --- | --- | --- | --- |
| `wins.deck` | `deck.html` | Boot 24×132 right-edge; `frame:false, transparent, alwaysOnTop(screen-saver), resizable:false, focusable:false`; min 8×8; visible-on-all-workspaces | Edge rail; resized every zones message to hug content (§6) |
| `editors: Map<noteId\|__scratch__>` | `editor.html` | Size from `noteDims(deck.noteSize)`; `frame:false, transparent, alwaysOnTop, resizable`, min 300×280, `show:false`; `_ready/_queue/_painted/_showPending/_noteId` lifecycle fields | One floating note per id; hidden (tucked), never destroyed, while its note exists |
| `wins.clock` | `clock.html` | 248×336 → hug-fit 200–600px; `frame:false, transparent, alwaysOnTop(screen-saver), resizable:false` | Floating timer, toggled from deck disc, follows the deck |
| `wins.home` | `home.html` | 1060×700, `frame:false`, taskbar-visible | Dashboard + all settings; `home:view` deep-links 250ms after show |
| `wins.breakN` | `break.html` | Fullscreen per display (or primary only); `alwaysOnTop(screen-saver)` | Break overlay; closed on `break-end`/finish |
| `wins.pill` | `pill.html` | 320×112 top-centre primary display; `focusable:false` | Pre-break warning with Start now / +1m / +5m / +15m / × |
| `wins.all` | `all.html` | 980×640, shown immediately | Searchable note list + archive filter + import/export |
| `wins.capture` | `capture.html` | 420×260, shown immediately | Quick capture to new/existing note (⌘1–6) |

Editors queue `editor:open` until `did-finish-load` and defer first show until
`ready-to-show`, so rapid tab clicks can neither lose nor double-open a note
(`openSeq` guard renderer-side).

## 5. IPC contract

### 5.1 Focus / breaks

| Channel | Shape | Payload |
| --- | --- | --- |
| `focus:state` | invoke → | `{phase, kind, remainingMs, endsAt, deferred, msg, pausedUntil, settings}` |
| `focus:action` | invoke `(action, arg)` → `true` | `start-now, start-long, finish, skip, postpone, +1/+5/+15, snooze1/snooze5, pause1h, pauseMorning, toggle` |
| `focus:getSettings` / `focus:saveSettings` | invoke | Get / merge + persist + broadcast |
| `focus:event` | send → all | Break transitions and settings changes |
| `focus:tick` | send → all, every 1s | `{phase, remainingMs, endsAt, pausedUntil}` (renderers interpolate locally between ticks) |

### 5.2 Notes / editors

| Channel | Shape | Payload |
| --- | --- | --- |
| `notes:list/get/create/update/remove/restore/reorder` | invoke | CRUD over the encrypted store; every mutation broadcasts `notes:changed` |
| `notes:export(kind)` / `notes:import()` | invoke | `json` (`flinkynotes.stickynotes.json`, accepts legacy `.stickies.json`), `single` md (`flinkynotes-notes.md`), per-note `md/txt`; file dialog + `shell.showItemInFolder` |
| `notes:quickCapture(text, destId)` | invoke | Append to note or create |
| `notes:changed` / `notes:open(ids)` | send → all | Mutation ping / visible-editor ids (deck hides open notes' tabs) |
| `editor:open(noteId)` | send → one editor | Queued until ready |
| `note:tuck` | send (no payload) | Sender window hides; resolves via `w._noteId`, else hides sender directly — a tuck click never no-ops |

### 5.3 Deck

| Channel | Shape | Payload |
| --- | --- | --- |
| `deck:get` | invoke → | `{...deckSettings, openIds, waH}` (`waH` from the cursor's display) |
| `deck:save` | invoke `(patch)` → merged | Persists, pushes `deck:stage` + full `deck:settings`; main drives hide/show deterministically (last-good/boot geometry), zones only refine bounds |
| `deck:settings` | send → deck | Full deck settings pushed by `deck:save`; renderer applies + re-renders + fresh zones (hide-strip toggle recovers live) |
| `deck:stage` | both | Renderer → main (no echo); main → renderer `{stage, keepOpen}` |
| `deck:pointer(bool)` | send | Cancels programmatic auto-fold while exploring |
| `deck:zones` | send `{gen, rects, sig}` | Window-local content rects + monotonic generation + structural signature; stale `gen` dropped |
| `deck:debug` | — | Dead channel: `preload` exposes a sender, main registers no handler |

### 5.4 Clock / break / pill

| Channel | Shape | Payload |
| --- | --- | --- |
| `win:open('clock')` | invoke | Toggles the clock window |
| `clock:fit(h)` | send | Panel height; main clamps 200–600px and resizes if >1px off |
| `break:start` / `break:chime` | send → break win | `{kind, msg, durationMs, endsAt, strict, manual, allowSkip, allowPostpone}` / `{volume}` |
| `pill:start` / `pill:dismiss` | send / invoke | `{kind, endsAt}` / closes pill |
| `home:view` / `all:filter` | send | Deep-link view / list filter |

### 5.5 Wellness / pomodoro / nudges / schedule / system

`wellness:get/summary/pomoStats`, `wellness:changed` (send → all on
break taken/skipped/postponed, pomodoro done — Home refreshes live),
`features:get/save`,
`pomo:get/save/action` (`startWork/startBreak/pause/resume/reset/skip`) +
`pomo:event`, `nudges:get/save/add/update/remove` + `nudge:fire`,
`schedule:get/save`, `sys:get` (`{autostart, openAtLogin, unpackaged, build}` — OS truth alongside the stored flag) / `sys:save`
(explicit `path` + `--hidden` login item; unpackaged runs never register;
an unpackaged startup that finds a registered item removes the stale
bare-Electron entry once and logs `[autostart] removed …`),
`win:open/closeSelf/hideSelf/min/maxToggle`.

## 6. Deck placement pipeline

The deck window has no fixed geometry: the renderer reports what it shows,
main sizes the native window to hug it. Invariants that keep it stable:

- Renderer measures with `offset*` only — never `getBoundingClientRect`
  mid-transition (transform phantom pixels) and never `window.innerWidth`
  (layout truth is `deckRoot.offsetWidth`; height budget is `waH` from
  `deck:get`, since budgeting off the zones-driven height is a feedback loop).
- Zones are window-local + generation-stamped; main translates by its own
  `getBounds()` origin and drops stale generations.
- Rest always centers; wake crossings and structural changes center on the
  screen center (deterministic for any note count — no remembered position to
  drift); preview show/hide glues 1:1 so cards never jump (`decideDeckPlacement`).
- Glue references are rebased onto applied bounds in local space
  (`rebaseContentY`); a 1px tolerance absorbs fractional-DPI rounding (125%
  turns rest height 97 DIP into 121.25 physical px); `DECK_PAD = 6`.
- Fold owner is the renderer (it sees the pointer); main only wakes via the
  120ms edge poll and never folds. Timings: preview show 120ms / hide 110ms,
  fold 900ms off-content / 260ms on leave, resize re-measure 80ms.

Pipeline per `deck:zones`: translate → union → policy (`center`/`glue`) →
bounds (right-edge snap, work-area clamp) → tolerance-guarded `setBounds` →
re-assert topmost `screen-saver` on show. Verified by `--deckdrive` (13 zones
→ 5 bounds over two wake/hover/add/remove/fold cycles, fan y identical).

## 7. Notes data model and storage

Record: `{id (uuid), title (≤80ch), tags[] (≤12, from #tags), color (paper
hex), bodyEnc, archived, pinned, order, todoMode (legacy), createdAt/updatedAt (ISO)}`.
Derived at read time: `body`, `done/total` task progress via `checklist.countTasks`
(`☐/☑`, `- [ ]/- [x]` — one module, so editor/deck/Home/All notes agree).
Lives in `%APPDATA%\Flinkynotes\notes\{notes.json,data.key}` (migrated once
from the pre-rename dir; see `dataPaths.js`).

- Bodies are AES-256-GCM, envelope `gcm1.<iv>.<tag>.<ct>` (base64); key is 32
  random bytes in `data.key` (0600). Undecryptable bodies read as `''`, never
  throw. Writes are tmp-file + rename.
- Sort: pinned first, then `updatedAt` desc. `+ New` reuses a pristine blank
  only (empty body *and* untitled — `isReusableEmpty`).
- Colors: 8 Paper/Dash/Ink triples (`notesStore.PALETTE`,
  mirrored in deck/editor CSS variables).
- Export: single md (`flinkynotes-notes.md`) / `flinkynotes.stickynotes.json`
  (imports accept legacy `.stickies.json` too) / per-note md+frontmatter/txt;
  import reverses md markers and frontmatter.
- Editor is a checklist editor (one row per line: real checkbox +
  inline-editable text, Enter/Backspace/paste/find/a11y) with a raw
  "Text view" fallback — both serialize to the same `body`, so no body
  migration exists. Lifecycle: single 300ms title+body debounce → one
  `notesUpdate({title, body})`; `flushAll()` always runs *before* tuck, so the
  last keystroke persists; `openSeq` drops stale opens; ghost-tuck closes the
  window if its note disappears underneath it; Delete is two-step
  (arm `Sure?`, 3s disarm) then remove + immediate tuck; Archive updates +
  immediate tuck (restorable in Home → Notes → Archived).

## 8. Timer state machines

**Focus** (`focusEngine`, pure): `focus → prebreak → break → focus`.
Defaults: mini every 10 min for 20 s (warn 10 s), long every 3rd mini for
5 min (warn 30 s); `20-20-20` preset = mini 20 min/20 s, longs off;
`classic` preset = defaults. Guards: meeting toggle and schedule hold defer
the focus deadline tick-by-tick instead of accumulating (no idle/process
guards — removed end-to-end in v1.0.0). Actions: `start-now/start-long`
(immediate mini/long), `finish` (always ends, even strict/manual), `skip`
(blocked only by strict settings — never time-gated), `postpone`
(+2m/+5m), `+1/+5/+15` (`deferNextBreak`: ends this break, same screen
returns after exactly that long, cadence counters untouched),
`snooze1/snooze5` (additive deadline push, ignored mid-break),
`pause1h/pauseMorning (07:00)`, `toggle`. Break ideas: 12 mini + 10 long
suggestions appended when enabled.

**Pomodoro** (`pomodoroEngine`, pure): `idle/work/shortBreak/longBreak/paused`
with `pausedFrom`; long break every Nth (`pomodorosPerCycle`, default 4);
day-rolled `completedToday`; explicit Start opts in (`enabled=true`);
context-aware `skip` (work→break uncounted, break→next work, pause→follows
`pausedFrom`). Ticked by the shared 1s loop; main broadcasts every tick while
running so countdowns move each second.

## 9. Wellness, nudges, schedule

- **Wellness** (`WellnessStore` over `wellness.json`): per-day counters
  (taken/skipped/postponed, pomodoros + `{t, subject}` sessions,
  posture/custom takes, screen minutes, session lengths). Health score:
  `100 − 5·skipped − 1·postponed − 3 per session > 40 min`,
  clamped 0–100. One break = one count at break end (auto-finish/Finish;
  Skip/Postpone touch only their counters), guarded per break instance.
  Screen time is live (`summary.screenLive` includes the running session;
  flushed on quit). Streak = consecutive qualifying days (taken > 0,
  skipped = 0); today never zeroes a run — a non-qualifying today counts
  from yesterday. Week bars: green ≥80, amber 55–79, red below.
  `wellness:pomoStats` tallies today/week×7/month + best from `daysMap()`.
- **Nudges** (30s poll, feature-gated): posture (30m), blink (10m), custom
  name/message/interval reminders with presets; each `due()` re-arms so
  re-enabling never bursts; fires `nudge:fire` + quiet OS `Notification`.
- **Schedule guard**: active days (Mon=1..Sun=7) + start/end (overnight-aware);
  outside hours the 1s loop holds breaks without consuming them. `enabled:
  false` means always active.

## 10. Tray, shortcuts, lifecycle

**Tray** (tooltip + 14-row menu, rebuilt on every broadcast and every 5th
tick): live-state header (`On break (m:ss)` / `Break in` / `Paused until` /
`Paused (reason)` / `Breaks off` / `Next break in`), Open home, Start
break/long, Finish, Skip, Pause 1 hour, meeting checkbox, New note, Pomodoro
start, Break settings (`Alt+Ctrl+T`), Disable/Enable, **Restart app**
(`app.relaunch()` + quit — the reliable way to pick up a new build), Quit.
Double-click opens Home.

**Global shortcuts:** `Alt+Ctrl+N` new note · `Alt+Ctrl+A` all notes ·
`Alt+Ctrl+L` archived · `Alt+Ctrl+T` break settings · `Alt+Ctrl+H` home ·
`Ctrl+Shift+Space` quick capture · break screen `Ctrl+X`/`Esc` skip ·
editor `Esc/T/P/F/S` + find `Enter/Esc`.

**Lifecycle:** single-instance lock (second launch only wakes the deck and
logs — it never opens Home); `window-all-closed` is swallowed (tray app);
`will-quit` unregisters shortcuts + flushes the wellness session; first
interactive run opens Home once (`seenHome`; `--hidden`/login launches never
open Home); every window creation logs `[win] home reason=…`;
`BUILD` (`2026-10-15.1`) is logged at startup and shown in Home → System and
the tray header so bug reports tie to exact code.

## 11. Settings reference

Persisted in `settings.json` (atomic tmp+rename writes; migrated once from
`settings-v3.json`):

| Key | Contents |
| --- | --- |
| `focus` | Full `FocusEngine` settings (see §8 + `FOCUS_SECTIONS` in home; preset `classic`/`20-20-20`/`custom`) |
| `deck` | `noteSize` (compact/classic/large), `keepOpen`, `hidePill` (right edge only; always visible on all workspaces incl. fullscreen) |
| `pomo` | `PomodoroEngine` settings + subjects + `currentSubjectId` |
| `nudges` | Toggles, intervals, `custom[]` (with `nextAt`) |
| `schedule` | `SCHEDULE_DEFAULTS` + days/hours |
| `features` | Master toggles: breaks, pomodoro, posture, blink, customReminders, stats, healthScore, workSchedule |
| `autostart`, `seenHome` | Login item (`--hidden` launch), first-run flag |

## 12. Cross-cutting conventions

- **Countdowns use `Math.ceil`, never `Math.round`** — a fresh 300000ms pause
  reads 299.x s after IPC delay; rounding rendered `4:59` ("lost a minute").
  Enforced in every formatter (main `fmt`, all renderers) and pinned by the
  `ceil-invariant` test.
- **Frameless click guard:** any button inside a `-webkit-app-region: drag`
  element silently swallows clicks — every control in draggable headers,
  footers and the clock header carries `no-drag` (plus a mousedown/click
  press-guard for the WM_MOUSEACTIVATE first-click eat on inactive windows).
- **Stale guards:** `loadSeq`/`openSeq` (deck/all/editor) drop out-of-order
  async renders; `zonesGen` drops stale deck reports.
- **Atomic writes everywhere** (`*.tmp` + rename) for settings, notes DB and
  wellness — a crash mid-save can't corrupt state.
- **Renderer never positions windows** (except reporting `clock:fit`
  height): main owns all bounds from zones + policy.

## 13. Testing

- **Unit** (`npm test` → `node tests/run.js`, no Electron): **47 tests** —
  ceil invariant, focus defer/snooze, pomodoro transitions/skip/pause/day-roll,
  health-score formula, nudge re-arm, schedule windows, shingle pitch, clock
  band clamp, note sizes, blank reuse, deck union/center/glue/clamp/pitch,
  center-restore, rebase stability, placement policy, brand guard,
  third-party guard, data-path migration, preset migration, checklist
  (roundtrip/count/toggle/forms/continuation/insert-merge/parity),
  wellness single-count/streak/live-minutes.
- **Dynamics** (`npx electron . --deckdrive <json>`): scripted
  wake → hover → add/remove note → leave → fold ×2 with a 120ms
  visibility/bounds watch; asserts hover costs zero resizes and the fan
  returns to the identical rect.
- **Toggle** (`npx electron . --toggleprobe <json>`): 5 hide-strip ON/OFF
  cycles with visibility/bounds/zones per step.
- **Visual** (`--deckshot <png>`): captures deck fan plus clock window
  (with DOM diagnostics) for regression review.
- **Ghost** (`--ghostprobe <json>`): creates notes and proves
  delete/archive/× hide their windows, with store + DOM snapshots.

## 14. Build, icons and release

`electron-builder --win portable nsis` (`electron-builder ^25.1.8`) emits
`dist/Flinkynotes 1.0.0.exe` (portable) and
`dist/Flinkynotes Setup 1.0.0.exe` (NSIS, per-user, desktop shortcut,
`runAfterFinish: false`).
Build stays unsigned — SmartScreen warns on first run — but the brand icon +
Flinkynotes VersionInfo are embedded via an explicit `afterPack` rcedit step
(`scripts/afterPack.js`, standalone rcedit binary). Rationale: the stock
`winCodeSign` toolchain cannot even be extracted on machines without symlink
privilege, and `signAndEditExecutable: false` alone would ship Electron's
identity to taskbar/toasts again — so the builder skips exe editing and the
hook brands the packed exe before the portable/NSIS targets are built from
it. Uninstall removes the autostart Run entry (`build/installer.nsh`).

Icon pipeline (three layers, all required):
1. `win.icon: assets/Logo/favicon.ico` embeds the brand mark in the exe
   (what shortcuts show).
2. Every `BrowserWindow` passes `icon: faviconPath()` (what taskbar/Alt+Tab
   show for that window).
3. `asarUnpack: [assets/Logo/favicon.ico]` + runtime preference for
   `app.asar.unpacked/...` — native icon loading **silently fails for files
   inside `app.asar`**, which once left every packaged window on the Electron
   default icon. A startup log line (`icon … empty=`) proves the load; the
   tray has a teal-dot fallback.

`AppUserModelId com.flinkynotes.app` is set pre-ready so toasts/taskbar group
under the brand (dev runs still report `electron.app.Electron` — the host
exe *is* Electron there). Never use `app.setName` — it would relocate the
user-data dir.

## 15. Known limitations

- Timers reset on restart by design (fresh focus period; breaks are ephemeral).
- Strict modes remove Skip/Postpone; Finish always remains. `manualFinish`
  holds breaks open until Finish.
- Meeting mode is a manual tray toggle; no calendar/DND/fullscreen sensing.
- Right-edge deck only.
- `notes:reorder` is implemented but the deck sorts by pin/`updatedAt`.
- v1.0.0 is the first official release (portable + NSIS, unsigned).
