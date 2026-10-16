# Flinkynotes — Break Timer ("Focus") Documentation

Everything about the break-timer half of the app: the engine, its settings,
every surface that shows it (clock, pre-break pill, break screen, Home, tray),
and the exact semantics of every button. The notes/deck feature is **not**
covered here.

---

## 1. Overview

The timer is a **mini + long break state machine** with
custom break text and a 20-20-20 preset:

- **Mini breaks** — short, frequent eye rests (default: every **10 min**,
  lasting **20 s**).
- **Long breaks** — proper stand-up breaks (default: after every **3** mini
  breaks, lasting **5 min**).
- **Pre-break warning** — before each break, a small cursor-following pill
  appears (10 s before minis, 30 s before longs) so the break never ambushes you.
- **Break screen** — a fullscreen overlay per display that owns the screen for
  the break's duration, with Finish / Postpone / Skip / +1m / +5m / +15m.

All timing logic lives in **`src/main/focusEngine.js`** — a pure JavaScript
class with no Electron dependencies (fully unit-testable; exercised by
`tests/run.js`). Windowing, tray, IPC and guards live in **`src/main/main.js`**.

---

## 2. Architecture

```
┌─────────────────────┐   tick(1s)    ┌──────────────────────────────┐
│  FocusEngine        │◀───────────── │  main.js                     │
│  (pure logic)       │  events:      │  - 1s setInterval tick loop   │
│  focusEngine.js     │  prebreak /   │  - guards (idle/meeting/      │
│                     │  break-start /│    excluded apps)             │
│  phase, kind,       │  break-end    │  - windows: clock, pill,      │
│  phaseEndsAt,       │──────────────▶│    break0..N                  │
│  pausedUntil, …     │  actions      │  - tray menu, shortcuts       │
└─────────────────────┘  (doAction)   │  - IPC: focus:*               │
                                      └──────────────┬───────────────┘
                                                     │ webContents.send
                          ┌──────────────────────────┼──────────────────────┐
                          ▼                          ▼                      ▼
                   clock.html                  pill.html             break.html
                   (ring + menu)          (warning, follows       (fullscreen overlay,
                                           cursor)                per display)
```

- **Engine** owns *what is happening and when* (phases, deadlines, counters).
- **main.js** owns *how it reaches you* (windows, tray, sounds, guards).
- **Renderers** are dumb views: they receive state/ticks over IPC and send
  button presses back as `focusAction` strings.

### The 1-second tick loop (main.js)

```js
setInterval(() => {
  const guards = { meeting: manualMeeting, tickMs: 1000 };
  const evts = engine.tick(Date.now(), guards);
  for (const e of evts) {
    if (e.type === 'prebreak')     showPill(e.kind);        // warning pill
    else if (e.type === 'break-start') showBreak(e.kind);   // fullscreen overlay
    else if (e.type === 'break-end')   closeBreak();        // auto-end
    broadcastFocus(e);
  }
  // live countdown push to every window:
  BrowserWindow.getAllWindows().forEach(w =>
    w.webContents.send('focus:tick', { phase, remainingMs, endsAt, pausedUntil }));
}, 1000);
```

The tray menu text refreshes at most every 5 s, plus on every broadcast.

---

## 3. State machine

```
                ┌──────────── (interval elapsed) ─────────────┐
                │                                             │
                ▼                                             │
   ┌─────────────────┐  deadline   ┌────────────┐  pre-timer  ┌─────────┐
   │     FOCUS       │────────────▶│  PREBREAK  │────────────▶│  BREAK  │
   │ counting down   │             │ pill shows │             │ overlay │
   │ to next break   │             │ "in 10 s"  │             │         │
   └─────────────────┘             └────────────┘             └─────────┘
        ▲    ▲                                                  │
        │    │            (duration elapsed, unless             │
        │    └──────────── manualFinish) ───────────────────────┘
        │
        └── skip / postpone / +N / finish / pause — see §9
```

| Phase      | `kind`                | Meaning                                        |
|------------|-----------------------|------------------------------------------------|
| `focus`    | —                     | Working time; countdown to the next break      |
| `prebreak` | `mini` \| `long`      | Warning window; pill visible, break not yet on |
| `break`    | `mini` \| `long` \| `ondemand` | The break itself; overlay on screen   |

`kind: 'ondemand'` is only used as the default parameter of
`startBreakNow()`; the tray and clock always start explicit `mini`/`long`
breaks, so overlays are labelled correctly.

### State variables (engine internals)

| Variable          | Purpose                                                        |
|-------------------|----------------------------------------------------------------|
| `phase`           | `focus` / `prebreak` / `break`                                 |
| `kind`            | Which break flavour the current cycle is                       |
| `phaseEndsAt`     | Absolute deadline (ms epoch) of the current phase              |
| `minisSinceLong`  | Mini breaks since the last long one (drives `longEvery`)       |
| `postponesUsed`   | Postpone counter (informational)                               |
| `pausedUntil`     | Absolute end of an explicit pause (0 = not paused)             |
| `skipVisibleAt`   | Display hint only — when the overlay may reveal Skip           |
| `message`         | `{ title, desc, idea }` for the break screen                   |
| `remainingMs`     | Last computed countdown (kept fresh for IPC readers)           |
| `deferredReason`  | Why the timer is currently being held back (guard), or `null` |

On app start the engine is configured from saved settings and **reset** —
the countdown always begins a fresh focus period; in-progress breaks do not
survive a restart.

---

## 4. Countdown formatting (important invariant)

Every countdown in the app — clock ring, pill, break screen, tray text,
Home — formats with **`Math.ceil`, never `Math.round`**:

```js
const s = Math.max(0, Math.ceil(ms / 1000));   // 300000ms → 5:00, never 4:59
return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
```

This was learned the hard way: rounding made a fresh 5-minute pause display
4:59 immediately, which read as "the +5m button lost a minute".

---

## 5. Settings reference

Settings persist under the `focus` key (JSON store in the user-data folder)
and are merged over these defaults:

| Key                 | Default        | Unit  | Description |
|---------------------|----------------|-------|-------------|
| `enabled`           | `true`         | —     | Master switch for every break |
| `miniEnabled`       | `true`         | —     | Mini breaks on/off (long breaks keep their own cadence) |
| `miniIntervalMs`    | `600000` (10m) | ms    | Time between mini breaks |
| `miniDurationMs`    | `20000` (20s)  | ms    | Length of a mini break |
| `preMiniMs`         | `10000` (10s)  | ms    | Warning pill lead time before a mini break |
| `longEnabled`       | `true`         | —     | Long breaks on/off |
| `longEvery`         | `3`            | count | A long break replaces every Nth mini break |
| `longDurationMs`    | `300000` (5m)  | ms    | Length of a long break |
| `preLongMs`         | `30000` (30s)  | ms    | Warning pill lead time before a long break |
| `postponeMiniMs`    | `120000` (2m)  | ms    | How far Postpone pushes a mini break |
| `postponeLongMs`    | `300000` (5m)  | ms    | How far Postpone pushes a long break |
| `allowSkip`         | `true`         | —     | Offer a Skip button during breaks |
| `allowPostpone`     | `true`         | —     | Offer Postpone during breaks |
| `strictMini`        | `false`        | —     | No skip, no postpone on mini breaks |
| `strictLong`        | `false`        | —     | No skip, no postpone on long breaks |
| `manualFinish`      | `false`        | —     | Breaks end **only** when the user presses Finish |
| `overlayTitle`      | `'Time to look away'` | — | Break-screen heading |
| `overlayDesc`       | `'Rest your eyes — gaze at something far away.'` | — | Break-screen message |
| `breakIdeas`        | `true`         | —     | Append a random activity suggestion to the message |
| `showOnAllScreens`  | `true`         | —     | One fullscreen overlay per display |
| `sound`             | `true`         | —     | Chime when the break screen opens |
| `volume`            | `0.7`          | 0–1   | Chime volume |
| `preset`            | `'classic'`  | —     | Which recipe the numbers came from |

**Dormant keys** (in defaults, no UI, no engine behaviour — left for future
work, intentionally not surfaced):
`lunchEnabled`, `lunchAt`, `lunchDurationMs`.

---

## 6. Presets

Applied from Home → Break settings → Presets. A preset **writes its numbers
into the settings**, it is not a separate mode — you can pick one and then
tune any value.

| Preset          | Effect |
|-----------------|--------|
| `classic`     | Defaults: mini 10 m / 20 s, long every 3 / 5 m |
| `20-20-20`      | Mini every **20 min** for **20 s**, **long breaks off** — the classic eye-strain rule |

---

## 7. Engine API (focusEngine.js)

All methods are synchronous; `tick()` returns a list of events.

### Lifecycle

| Method | Behaviour |
|--------|-----------|
| `reset()` | `phase='focus'`, `phaseEndsAt = now + miniIntervalMs`, counters zeroed, fresh message |
| `configure(patch)` | Shallow-merge new settings (does not restart the current phase) |

### Pausing

| Method | Behaviour |
|--------|-----------|
| `pauseFor(ms)` | Parks everything for `ms`: sets `pausedUntil`, forces `phase='focus'`, next break lands `ms + miniIntervalMs` after now. `remainingMs` updated immediately so UIs never show a stale pre-pause value. |
| `pauseUntilMorning()` | `pauseFor()` until **07:00 tomorrow** |

### Starting breaks

| Method | Behaviour |
|--------|-----------|
| `startBreakNow(kind, durationMs?)` | Immediate `break` phase; duration = given, else long/mini default. Picks a fresh message. `skipVisibleAt = now + min(60 s, duration/2)`. |
| `deferNextBreak(ms)` | **The break-screen +1m/+5m/+15m.** Ends the current break *now* and brings it back after exactly `ms`. Crucially it is **not** a cycle restart: `minisSinceLong` and `postponesUsed` are untouched, so the long-break cadence keeps its place. (The old implementation used `pauseFor()`, which re-armed the whole mini interval — users saw "the buttons entirely reset the timer".) |

### During a break

| Method | Guarded by | Behaviour |
|--------|------------|-----------|
| `skip()` | `allowSkip`, `strictMini/strictLong` | Ends the break, next focus period = `miniIntervalMs`. Explicit Skip clicks are **never time-gated** (`skipVisibleAt` is display-only) — an always-clickable-but-ignored button read as dead. Blocked only by strict/settings; on block the overlay deliberately stays up (closing it while `phase='break'` caused an invisible stuck break). |
| `finishBreak()` | none | Always ends the break, even in strict/manual modes. Next focus = `miniIntervalMs`. |
| `postpone()` | `allowPostpone`, strict | Back to focus, deadline = `now + postponeMiniMs/LongMs`, increments `postponesUsed`. |

### Clock snooze

| Method | Behaviour |
|--------|-----------|
| `snooze(ms)` | **Additive** push of the current deadline: 3:33 remaining + `snooze(60000)` → 4:33. Extends an active pause if one is running; delays a focus/prebreak deadline otherwise; **ignored mid-break** (the clock is hidden then, so this never conflicts with `deferNextBreak`). |

### Ticking

```js
tick(now, guards) → [{ type: 'prebreak'|'break-start'|'break-end', kind }]
```

1. If `enabled === false` → no events, countdown frozen.
2. If `now < pausedUntil` → update `remainingMs`, no events.
3. If any guard is active (`idle`, `meeting`, `excluded`, `dnd`, `fullscreen`)
   → **defer**: while in `focus`, the deadline is pushed forward one tick
   (1 s) per tick, so the remaining time visibly holds still; sets
   `deferredReason` (shown as "Deferred" on the clock and in the tray).
4. `focus` past deadline → decide mini vs long
   (`longEnabled && minisSinceLong + 1 >= longEvery` → long, counter resets;
   otherwise mini, counter increments). If minis are disabled and no long is
   due, the deadline simply rolls to the next slot — long breaks still arrive
   on cadence. Enters `prebreak` for `preMiniMs`/`preLongMs`, picks the
   message, emits `prebreak`.
5. `prebreak` past deadline → enters `break`, emits `break-start`.
6. `break` past deadline → (unless `manualFinish`) back to focus,
   emits `break-end`.

---

## 8. Guards — when the timer holds back

| Guard | Source | Effect |
|-------|--------|--------|
| **In a meeting** | Tray checkbox "Mark as in a meeting" (manual toggle) | Timer deferred until unticked |
| **Schedule** | Work-schedule active hours (`scheduleGuard`) | Outside hours the countdown holds still |

While deferred/held, the focus deadline is pushed forward tick-by-tick, so
nothing accumulates "in the background" — the countdown simply holds.
Guards only defer `focus`; they never interrupt an already running break.
(Idle and process-exclusion guards were removed end-to-end in v1.0.0.)

---

## 9. Actions — every button and what it does

All surfaces funnel into one handler, `doAction(action)` (IPC `focus:action`):

| Action | Sent by | Semantics |
|--------|---------|-----------|
| `start-now` | Clock "Start break", pill "Start now", tray | Immediate **mini** break |
| `start-long` | Clock "Long break", tray | Immediate **long** break |
| `finish` | Break screen "Finish", tray "Finish break" | Ends the break — **always**, even strict/manual |
| `skip` | Break screen "Skip (Ctrl+X)", Esc, tray "Skip to next" | Skip the current break (blocked by strict/allowSkip; overlay stays up if blocked) |
| `postpone` | Break screen "Postpone" | Push back by postpone 2 m / 5 m (blocked by strict/allowPostpone) |
| `+1` / `+5` / `+15` | Break screen & pill | **`deferNextBreak`** — screen closes now, returns after exactly that long; counters preserved; clock re-shown |
| `snooze1` / `snooze5` | Clock menu "+1m" / "+5m" | **Additive** deadline push (3:33 → 4:33); no phase change; ignored mid-break |
| `pause1h` | Tray "Pause 1 hour" | `pauseFor(1 h)` |
| `pauseMorning` | IPC (available; not on a surface yet) | Pause until 07:00 tomorrow |
| `toggle` | Clock "Disable/Enable", tray | Flip `enabled`, persist, broadcast |

Two deliberately different "+m" families:

- **On the break screen** (`+1m/+5m/+15m`): the break is *over*, and the same
  screen comes back after that exact delay. This answers "go away for a bit"
  while a break is ringing.
- **On the clock** (`+1m/+5m`): the break hasn't happened yet; its deadline
  just moves later. This answers "not now, push it back".

---

## 10. User surfaces

### 10.1 Clock widget (`clock.html`)

A small semi-transparent **ring bubble** pinned **top-centre** by default.

- **Bubble**: SVG progress ring (r=28, circumference 175.93) + countdown.
  Ring colour by state: teal `#5eead4` (focus), amber `#f3c04c`
  (paused / deferred / prebreak), red `#ff7a6b` (on break), grey `#8b93a0`
  (disabled).
- **Panel** (opens on click): state title + countdown + subtitle, then
  - `+1m` / `+5m` — additive snooze
  - **Start break** / **Long break** — immediate breaks
  - **Break settings** — opens Home on the focus tab
  - **Disable / Enable** — master toggle
- **Interaction**: click bubble toggles the panel; clicking anywhere in the
  widget's box while closed also opens it; auto-closes **650 ms** after the
  pointer leaves (900 ms grace right after opening). Escape closes it.
- **Dragging**: the bubble can be dragged, but only along the **top band** of
  the screen (X: full work-area width; Y: a 120 px strip below the top edge) —
  `clampClockPos()` in `geometry.js`. Position persists (`clockPos`).
- The renderer measures its own panel height and reports it (`clock:fit`) so
  main sizes the window to content exactly — no clipped footers.
- Re-renders every second locally, computing countdowns from the **wall
  clock** (`endsAt - now`) rather than stale snapshots.
- Click-through: while closed, only the bubble is interactive; while open, the
  whole panel box is. The main-process `interactPoll` (60 ms) flips
  `setIgnoreMouseEvents` accordingly.

### 10.2 Pre-break pill (`pill.html`)

- A 320×104 non-focusable popup shown during **prebreak** (10 s / 30 s lead).
- Reads "Break in m:ss — almost time…" with **Start now**, `+1m`, `+5m`,
  `+15m`.
- **Follows the cursor**: repositioned every 120 ms to cursor + (24, 24) px,
  clamped inside the display's work area — the break warning always travels
  with you.
- Countdown updates every 250 ms locally.

### 10.3 Break screen (`break.html`)

- One **fullscreen, always-on-top (`screen-saver` level), frameless** window
  per display (or primary only when `showOnAllScreens` is off), background
  `#0e2a3a`.
- Content: kicker ("MINI BREAK" / "LONG BREAK"), the heading, the message
  (with `Try: <idea>` line when break ideas are on), a live countdown
  (`m:ss`, 250 ms refresh), and the button row:
  - **Finish** (primary) — ends the break now, always allowed
  - **Postpone** — hidden in strict mode or when postponing is disallowed
  - **`+1m` / `+5m` / `+15m`** — "bring this screen back after that long"
  - **Skip (Ctrl+X)** — shown when not strict and skipping allowed
- **Keyboard**: `Ctrl+X` → skip; `Esc` → skip (suppressed in strict mode).
- **Chime**: on open, a 660 Hz sine via WebAudio, 0.9 s, gain = volume × 0.2.
- **Auto-end**: unless `manualFinish`, the overlay itself calls `finish` when
  the countdown hits zero; main also ends it on the engine's `break-end`
  event.
- The clock widget is hidden while a break is up and re-shown when it closes.

### 10.4 Home → Break settings

The full settings form (opened via clock "Break settings", tray
"Break timer settings", or **Alt+Ctrl+T**), grouped as:

1. **Presets** — preset picker, master on/off
2. **Mini breaks** — toggle, every (min), lasting (sec), warn me first (sec)
3. **Long breaks** — toggle, after every N minis, lasting (min), warn (sec)
4. **Behaviour** — allow skip, allow postpone, strict mini, strict long,
   manual finish
5. **While you work** — pause when idle for (min), pause-while-these-run
   (comma-separated process names)
6. **Break screen** — heading, message, suggest-an-idea, show on all
   displays, play a chime, chime volume

Every control writes through `focus:saveSettings` → `engine.configure()` +
persist + broadcast, so changes apply immediately without a restart.

### 10.5 Tray menu

Tooltip and the first (disabled) row always show the live state:

| State | Text |
|-------|------|
| On break | `On break (m:ss)` |
| Prebreak | `Break in m:ss — hover pill to start` |
| Paused | `Paused until H:MM` |
| Deferred | `Paused (<reason>) — m:ss left` |
| Focus | `Next break in m:ss` |

Menu: Open home · Start break now · Start long break now · Finish break /
Skip to next · Pause 1 hour · **Mark as in a meeting** (checkbox) · note
shortcuts · Break timer settings (**Alt+Ctrl+T**) · Disable/Enable breaks ·
Quit. Double-click on the tray icon opens Home.

---

## 11. Global keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Ctrl+T` | Open Break timer settings |
| `Alt+Ctrl+H` | Open Home |
| `Ctrl+X` | Skip current break (while the break screen is up) |
| `Esc` | Skip current break (break screen, non-strict) / close clock panel |

---

## 12. IPC surface (timer-related)

**Invoked by renderers** (`ipcMain.handle`):

| Channel | Payload → result |
|---------|------------------|
| `focus:state` | → `{ phase, kind, remainingMs, endsAt, deferred, msg, pausedUntil, settings }` |
| `focus:action` | `(action, arg)` → runs `doAction`, returns `true` |
| `focus:getSettings` | → current merged settings |
| `focus:saveSettings` | `(settings)` → merged into engine, persisted, broadcast; returns the new settings |
| `clock:fit` | `(height)` → main resizes the clock window (bounds sanity-checked 160–900 px) |
| `clock:move` / `clock:moveEnd` | Drag events; move is clamped to the top band, moveEnd persists the position |

**Sent by main**:

| Channel | Payload |
|---------|---------|
| `focus:tick` | `{ phase, remainingMs, endsAt, pausedUntil }` — every second, every window |
| `focus:event` | `{ type: 'prebreak' \| 'break-start' \| 'break-end' \| 'action' \| 'settings', … }` |
| `break:start` | `{ kind, msg, durationMs, endsAt, strict, manual, allowSkip, allowPostpone }` |
| `break:chime` | `{ volume }` |
| `pill:start` | `{ kind, endsAt }` |
| `clock:stage` | `{ open }` — panel open/close mirror |

---

## 13. Persistence

- **Focus settings** → `focus` key in the JSON store (user-data folder,
  local-only; merged over engine defaults on boot).
- **Clock position** → `clockPos` key, clamped to the top band on read.
- **First run** → Home opens once automatically (`seenHome` flag).
- Nothing leaves the machine: no telemetry, no network.

---

## 14. Break ideas

Two built-in pools, appended to the message when `breakIdeas` is on:

- **Mini** (12): look 20 ft away for 20 seconds · roll your shoulders ·
  blink fully 10 times · stand and stretch tall · shake out your hands ·
  5 slow breaths · look left/right/up/down · unclench your jaw ·
  drop shoulders from ears · focus far-then-near · wiggle your toes ·
  drink water
- **Long** (10): walk away from the screen · 10 squats · make tea mindfully ·
  tidy one small area · step outside · stretch neck side to side ·
  call or text someone you like · 2-minute tidy · foam-roll your back ·
  eat a piece of fruit slowly

A fresh idea is picked each time a cycle enters prebreak.

---

## 15. Known limitations / design notes

- **Timers don't persist across restarts** — the engine resets to a fresh
  focus period on launch (by design; breaks are ephemeral).
- **`manualFinish`** makes breaks endless until you press Finish; the
  countdown still runs to zero but nothing closes.
- **Strict mode** (`strictMini`/`strictLong`) removes Postpone and Skip from
  the break screen; Finish always remains.
- **Skip's next interval** for long breaks falls back to `miniIntervalMs`
  (`longIntervalFallbackMs` is consulted but has no default).
- **Meeting mode is manual** (tray checkbox) — there is no calendar or
  DND integration.
- **Dormant settings** (lunch schedule) are
  stored but unimplemented and deliberately hidden from the UI.
