// Flinkynotes — main process (Electron, Windows).
// Break engine (TIMER.md focusEngine) + encrypted notesStore + wellness ports.
// Local-only, no telemetry.
'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, globalShortcut, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { FocusEngine, DEFAULTS: FOCUS_DEFAULTS } = require('./focusEngine');
const { store } = require('./notesStore');
const { JsonStore } = require('./jsonStore');
const { noteDims } = require('./noteSizes');
const { PomodoroEngine, POMO_DEFAULTS } = require('./pomodoroEngine');
const { WellnessStore, dateKey } = require('./wellness');
const { NudgeEngine, NUDGE_DEFAULTS } = require('./nudges');
const { SCHEDULE_DEFAULTS, isActiveNow } = require('./scheduleGuard');

// Build fingerprint: shown in Home → System and logged at startup so a
// reported bug can always be tied to the exact code running ("works here,
// broken there" almost always means a stale instance — the singleton makes
// new launches quit silently while the old build keeps running).
const BUILD = '2026-10-15.1';

// Windows groups taskbar icons and names toast notifications by
// AppUserModelID. Without this, toasts arrive as "electron.app.Electron"
// (in dev they still do — the host exe is Electron itself; packaged builds
// report Flinkynotes). Must run before ready; never use app.setName here —
// that would relocate the user-data dir.
try { app.setAppUserModelId('com.flinkynotes.app'); } catch {}

// Pre-rename user-data folder. Single intentional old-brand reference.
// The brand-name-consistent test allowlists exactly this line.
// package.json name (flinkynotes) determines the current user-data folder.
const LEGACY_APP_DIR = 'Flickynotes';

const settings = new JsonStore({ name: 'settings' });

const FEATURE_DEFAULTS = {
  breaks: true, pomodoro: true, posture: true, blink: true,
  customReminders: true, stats: true, healthScore: true,
  workSchedule: false,
};
function getFeatures() { return { ...FEATURE_DEFAULTS, ...(settings.get('features', {})) }; }
function getFocusSettings() {
  const merged = { ...FOCUS_DEFAULTS, ...(settings.get('focus', {})) };
  if (merged.preset !== 'classic' && merged.preset !== '20-20-20' && merged.preset !== 'custom') {
    merged.preset = 'classic';
    try { settings.set('focus', merged); } catch {}
  }
  return merged;
}
function setFocusSettings(s) { settings.set('focus', s); }
function getDeckSettings() {
  const saved = settings.get('deck', {});
  let touched = false;
  if (saved && typeof saved === 'object') {
    for (const k of ['edge', 'showOverFullscreen']) {
      if (Object.prototype.hasOwnProperty.call(saved, k)) { delete saved[k]; touched = true; }
    }
    if (touched) { try { settings.set('deck', saved); } catch {} }
  }
  return { keepOpen: false, hidePill: false, noteSize: 'classic', ...(saved || {}) };
}
// Floating-note dimensions come from the Notes → Edge deck size preset.
function noteWH() { const d = noteDims(getDeckSettings().noteSize); return { w: d.w, h: d.h }; }
function getPomoSettings() { return { ...POMO_DEFAULTS, ...(settings.get('pomo', {})) }; }
function getNudgeSettings() { return { ...NUDGE_DEFAULTS, ...(settings.get('nudges', {})) }; }
function getSchedule() { return { ...SCHEDULE_DEFAULTS, ...(settings.get('schedule', {})) }; }

const engine = new FocusEngine(getFocusSettings());
const pomo = new PomodoroEngine(getPomoSettings());
const nudges = new NudgeEngine(getNudgeSettings());
let wellness = null;

let tray = null;
let wins = {};
let manualMeeting = false;
let deckStage = 'rest';
let deckAutoRest = null, deckQuietUntil = 0;

const R = (f) => path.join(__dirname, '..', 'renderer', f);
const preloadPath = () => path.join(__dirname, 'preload.js');

// Headless dynamics probe (dev only, --deckdrive): counts zones messages and
// native resizes so hover/fold storms show up as numbers, not screenshots.
const DRIVE = process.argv.includes('--deckdrive');
const driveLog = DRIVE ? { zones: [], bounds: [], t0: Date.now() } : null;
function driveMark(kind, info) {
  if (driveLog) driveLog[kind].push({ at: Date.now() - driveLog.t0, ...(info || {}) });
}

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const fmt = (ms) => {
  const s = Math.max(0, Math.ceil((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function faviconPath() {
  // Packaged builds run from inside app.asar, and native icon loading needs
  // a real file — not an asar virtual path (silently yields the Electron
  // default icon in taskbar/Alt+Tab). The builder unpacks this file
  // (see asarUnpack in package.json); dev runs use the source tree directly.
  try {
    if (app.isPackaged) {
      const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'Logo', 'favicon.ico');
      if (fs.existsSync(unpacked)) return unpacked;
    }
  } catch {}
  return path.join(__dirname, '..', '..', 'assets', 'Logo', 'favicon.ico');
}
function iconImage() {
  // Flinkynotes brand mark, with the old teal dot as a last-resort fallback.
  try {
    const img = nativeImage.createFromPath(faviconPath());
    if (!img.isEmpty()) return img;
  } catch {}
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR4AWNgGPAgDPz//z9QJjBqNKKgaTQaqJo0GqiaNBoomjQaKJo0GiiadBoopk0GgAAgwAAmBqYvdYpOUAAAAAASUVORK5CYII=';
  return nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
}

function mkWin(name, file, opts, show = false) {
  if (wins[name] && !wins[name].isDestroyed()) { const w = wins[name]; w.show(); w.focus(); return w; }
  const w = new BrowserWindow({
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
    ...opts, hasShadow: false, show: false,
    icon: faviconPath(),
  });
  if (show) w.webContents.once('ready-to-show', () => { try { w.show(); } catch {} });
  w.loadFile(R(file));
  w.on('closed', () => { delete wins[name]; });
  wins[name] = w;
  return w;
}

/* ---------- deck: the native window hugs visible content ----------
   deck protocol (see deckLayout.js + deck.html header):
   - Renderer reports WINDOW-LOCAL content rects (offset*-measured, never
     innerWidth/innerHeight, never client rects) with a generation counter.
   - Main translates by its own bounds origin (self-consistent: identical
     content → identical screen union → the equality guard suppresses
     resizes, so hovers cost zero native resizes).
   - Right edge only. Rest, wakes, and structural changes center
     on the screen center; preview show/hide glues so cards never jump.
   - Fold owner is the renderer (it sees the pointer). Main only WAKES via
     the edge poll below; there is deliberately no watchdog fold — two fold
     owners bounced wake→fold→wake. */
const { computeDeckBounds, restoreCenterY, unionZones, rebaseContentY, decideDeckPlacement, restBootBounds } = require('./deckLayout');
let deckZonesLocal = []; // last content rects from renderer, window-local
let deckGen = 0; // last applied generation; stale sends are dropped
let deckCenterNext = false; // fresh placement on the next bounds pass
let deckPrevBounds = null; // last bounds main applied (glue reference)
let deckPrevContentY = null; // screen-space union top of the last placed pass
let deckSigCur = ''; // structural signature of the latest zones message
let lastSig = null; // signature of the last applied pass
// The deck lives where the user is, not always on the primary display.
// Every placement, wake check, and budget uses the cursor's display.
function cursorDisplay() {
  try { return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); }
  catch { try { return screen.getPrimaryDisplay(); } catch { return null; } }
}
function applyDeckBounds() {
  const w = wins.deck;
  if (!w || w.isDestroyed()) return;
  if (!deckZonesLocal.length) {
    // Nothing on screen (rest + hidden pill, or pre-first-paint): hide so
    // not a single pixel can intercept clicks. Wake still works — the
    // cursor poll drives setDeckStage, the hidden renderer re-renders the
    // fan, and its zones message brings the window back.
    try { w.hide(); } catch {}
    return;
  }
  const disp = cursorDisplay();
  const wa = (disp && disp.workArea) || screen.getPrimaryDisplay().workArea;
  let org;
  try { org = w.getBounds(); } catch { return; }
  const screenZones = [];
  for (const r of deckZonesLocal) {
    if (!r) continue;
    const zw = r.width ?? r.w ?? 0, zh = r.height ?? r.h ?? 0;
    if (zw < 2 || zh < 2) continue;
    screenZones.push({ x: org.x + (r.x ?? 0), y: org.y + (r.y ?? 0), w: zw, h: zh });
  }
  if (!screenZones.length) { try { w.hide(); } catch {} return; }
  // Placement policy (deckLayout.decideDeckPlacement): rest, wake crossings
  // and structural changes (sig) all center on the screen center — one
  // deterministic place no matter how many notes. Flyout-only changes glue
  // so open cards never jump. Center ignores the union position and glue
  // chases the live origin — no branch can teleport from a stale message.
  const sigChanged = lastSig !== null && deckSigCur !== lastSig;
  const policy = decideDeckPlacement({ stage: deckStage, crossing: deckCenterNext, sigChanged });
  let b;
  if (policy === 'glue') {
    b = computeDeckBounds(screenZones, wa, {
      center: false, prevBounds: deckPrevBounds || org, prevContentY: deckPrevContentY,
    });
  } else {
    const c = computeDeckBounds(screenZones, wa, { center: true });
    if (!c.visible) { try { w.hide(); } catch {} return; }
    b = { ...c, y: restoreCenterY(wa.y + wa.height / 2, c.h, wa) };
  }
  if (!b.visible) { try { w.hide(); } catch {} return; }
  deckCenterNext = false;
  lastSig = deckSigCur;
  deckPrevBounds = { x: b.x, y: b.y, w: b.w, h: b.h };
  // Rebase glue onto the APPLIED bounds in local space (see rebaseContentY):
  // a screen-space contentY from the pre-move origin would re-apply the move
  // delta on the next pass and park the deck at the top.
  const localU = unionZones(deckZonesLocal);
  deckPrevContentY = rebaseContentY(b, localU ? localU.y : 0);
  try {
    const got = w.getBounds();
    // 1px tolerance: on fractional-DPI displays (e.g. 125%) the OS rounds
    // physical pixels, so getBounds can come back 1px off a computed bound
    // forever (rest h=97 → 121.25 physical → endless re-apply + repaint
    // flash). The offset is constant, never accumulating, and the 6px pad
    // absorbs it — re-applying every zones message is the real glitch.
    const same = Math.abs(got.x - b.x) <= 1 && Math.abs(got.y - b.y) <= 1 &&
      Math.abs(got.width - b.w) <= 1 && Math.abs(got.height - b.h) <= 1;
    if (!same) {
      w.setBounds({ x: b.x, y: b.y, width: b.w, height: b.h });
      driveMark('bounds', DRIVE ? { x: b.x, y: b.y, w: b.w, h: b.h, got: [got.x, got.y, got.width, got.height].join(',') } : { x: b.x, y: b.y, w: b.w, h: b.h });
    }
  } catch {}
  if (getDeckSettings().hidePill && deckStage === 'rest') { try { w.hide(); } catch {} }
  else if (!w.isVisible()) {
    // Re-assert topmost on every show: nothing may bury the deck.
    try { w.setAlwaysOnTop(true, 'screen-saver'); } catch {}
    try { w.showInactive(); } catch {}
  }
}
function ensureDeck() {
  if (wins.deck && !wins.deck.isDestroyed()) return wins.deck;
  const disp = cursorDisplay();
  const wa = (disp && disp.workArea) || screen.getPrimaryDisplay().workArea;
  // Right edge only: 24px boot rect, vertically centered.
  const b = { x: wa.x + wa.width - 24, y: Math.round(wa.y + wa.height / 2 - 66), width: 24, height: 132 };
  const w = new BrowserWindow({
    ...b, show: false, frame: false, transparent: true, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: false,
    icon: faviconPath(),
    webPreferences: { preload: preloadPath(), contextIsolation: true },
  });
  w.setMinimumSize(8, 8);
  w.loadFile(R('deck.html'));
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.webContents.once('did-finish-load', () => {
    // Fresh renderer: its generation counter restarts at 0 — accept all.
    deckGen = 0; deckZonesLocal = []; deckPrevBounds = null; deckPrevContentY = null;
    try { w.webContents.send('deck:stage', { stage: deckStage, keepOpen: !!getDeckSettings().keepOpen }); } catch {}
  });
  wins.deck = w;
  w.on('closed', () => { delete wins.deck; });
  return w;
}
function setDeckStage(stage, opts = {}) {
  // echo: mirror back to the deck renderer (skip when the call ORIGINATED
  // there — the echo repainted every gesture twice). autoFold: main-owned
  // fold timer for programmatic opens; the cursor-poll wake leaves folding
  // to the renderer, which alone sees the pointer (single fold owner).
  const { echo = true, autoFold = true } = opts;
  const w = ensureDeck();
  const keep = !!getDeckSettings().keepOpen;
  if (stage === 'rest' && keep) stage = 'fan';
  // Center on rest<->fan crossings AND structural changes (the zones sig);
  // preview show/hide glues in place — recentering those reseated the window
  // on every hover and read as teleporting (the y132<->y264 flip in the old
  // drive traces). The policy itself lives in deckLayout.decideDeckPlacement.
  if ((deckStage === 'rest') !== (stage === 'rest')) deckCenterNext = true;
  deckStage = stage;
  // No native bounds/ignore fiddling here: the renderer's zones message that
  // follows every stage change drives applyDeckBounds.
  deckQuietUntil = Date.now() + 900;
  if (!keep && stage !== 'rest' && autoFold) {
    // Programmatic opens fold again unless the pointer is exploring the deck.
    try {
      const c = screen.getCursorScreenPoint();
      const b = w.getBounds();
      const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
      if (!inside) scheduleDeckRest(2600);
    } catch {}
  }
  if (echo) { try { w.webContents.send('deck:stage', { stage, keepOpen: keep }); } catch {} }
  return w;
}
function scheduleDeckRest(ms = 2600) {
  clearTimeout(deckAutoRest);
  if (getDeckSettings().keepOpen) return;
  deckAutoRest = setTimeout(() => { if (deckStage !== 'rest') setDeckStage('rest'); }, ms);
}
function applyDeckVisibility() {
  // Show/hide is owned by applyDeckBounds (zones-driven). This only enforces
  // the hidden-pill setting so an un-sized window is never flashed.
  const w = wins.deck;
  if (!w || w.isDestroyed()) return;
  if (getDeckSettings().hidePill && deckStage === 'rest') { try { w.hide(); } catch {} }
}
// Main owns deck visibility deterministically (hide-strip toggle, Task 8
// rework): renderer zones only REFINE geometry via applyDeckBounds, never
// gate a show — zones from a hidden window cannot be relied on (rAF can be
// throttled while hidden), and fan zones must never re-show a hidden strip.
function showDeckRestNow(w) {
  try {
    if (deckStage === 'rest') {
      let b = null;
      if (deckPrevBounds) {
        b = { x: deckPrevBounds.x, y: deckPrevBounds.y, w: deckPrevBounds.w, h: deckPrevBounds.h };
      } else {
        const disp = cursorDisplay();
        const wa = (disp && disp.workArea) || screen.getPrimaryDisplay().workArea;
        const boot = restBootBounds(wa);
        b = { x: boot.x, y: boot.y, w: boot.w, h: boot.h };
      }
      try { w.setBounds(b); } catch {}
    }
    try { w.setAlwaysOnTop(true, 'screen-saver'); } catch {}
    try { w.showInactive(); } catch {}
  } catch {}
}
// Single funnel for deck settings writes: the IPC handler and the
// --toggleprobe harness exercise this same path.
function applyDeckSave(patch) {
  const cur = getDeckSettings();
  // The Home renderer echoes the whole deck:get payload (incl. transient
  // openIds/waH) — strip those so persisted settings stay clean.
  const clean = { ...(patch || {}) };
  delete clean.openIds;
  delete clean.waH;
  const next = { ...cur, ...clean };
  settings.set('deck', next);
  const turningOn = !!next.hidePill && !cur.hidePill;
  const turningOff = !next.hidePill && !!cur.hidePill;
  let w = wins.deck && !wins.deck.isDestroyed() ? wins.deck : null;
  if (turningOff && !w) w = ensureDeck();
  if (w && !w.isDestroyed()) {
    try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
    if (turningOn) {
      // Fold to rest first so in-flight fan zones can't re-show the strip,
      // push rest + settings so the renderer re-renders pill-less, then hide
      // synchronously — no flash of the strip possible. Drop the cached
      // bounds too so a later OFF never flashes a stale fan-sized window.
      clearTimeout(deckAutoRest);
      deckStage = 'rest';
      deckCenterNext = false;
      deckPrevBounds = null;
      try { w.webContents.send('deck:stage', { stage: 'rest', keepOpen: !!next.keepOpen }); } catch {}
      try { w.webContents.send('deck:settings', { ...next }); } catch {}
      try { w.hide(); } catch {}
    } else if (turningOff) {
      // Deterministic re-show within the IPC round-trip: last-good or boot
      // geometry now, exact hug bounds when the next zones message lands.
      // Never waits on the edge poll or the cursor position.
      deckQuietUntil = 0;
      deckCenterNext = true;
      try { w.webContents.send('deck:stage', { stage: deckStage, keepOpen: !!next.keepOpen }); } catch {}
      try { w.webContents.send('deck:settings', { ...next }); } catch {}
      showDeckRestNow(w);
    } else {
      try { w.webContents.send('deck:stage', { stage: deckStage, keepOpen: !!next.keepOpen }); } catch {}
      try { w.webContents.send('deck:settings', { ...next }); } catch {}
      applyDeckVisibility();
    }
  }
  return { ...next, openIds: openNoteIds() };
}

/* ---------- editors (one window per note) ---------- */
const editors = new Map();
function editorWindows() { return [...editors.values()].filter(w => w && !w.isDestroyed()); }
function openNoteIds() {
  const ids = [];
  editorWindows().forEach((w) => { try { if (w.isVisible() && w._noteId) ids.push(w._noteId); } catch {} });
  return ids;
}
function broadcastOpenNotes() {
  const ids = openNoteIds();
  BrowserWindow.getAllWindows().forEach((w) => { try { w.webContents.send('notes:open', ids); } catch {} });
}
function ensureEditor(noteId) {
  const key = noteId || '__scratch__';
  const existing = editors.get(key);
  if (existing && !existing.isDestroyed()) return existing;
  const { w: NW, h: NH } = noteWH();
  const w = new BrowserWindow({
    width: NW, height: NH, frame: false, transparent: true, alwaysOnTop: true, hasShadow: false,
    skipTaskbar: true, resizable: true, show: false, minWidth: 300, minHeight: 280,
    icon: faviconPath(),
    webPreferences: { preload: preloadPath(), contextIsolation: true },
  });
  w._noteId = noteId || null;
  w._painted = false; w._showPending = 0; w._ready = false; w._queue = [];
  w.loadFile(R('editor.html'));
  w.webContents.once('ready-to-show', () => {
    w._painted = true;
    if (w._showPending) { const m = w._showPending; w._showPending = 0; try { m === 2 ? w.showInactive() : w.show(); } catch {} }
  });
  w.webContents.once('did-finish-load', () => {
    w._ready = true;
    const q = w._queue; w._queue = [];
    q.forEach(([c, p]) => { try { w.webContents.send(c, p); } catch {} });
  });
  w.on('closed', () => { editors.delete(key); broadcastOpenNotes(); });
  editors.set(key, w);
  return w;
}
function sendToEditor(chan, payload, noteId) {
  const w = editors.get(noteId || '__scratch__');
  if (!w || w.isDestroyed()) return;
  if (w._ready) { try { w.webContents.send(chan, payload); } catch {} }
  else w._queue.push([chan, payload]);
}
function positionEditorDefault(w) {
  const disp = cursorDisplay();
  const d = disp || screen.getPrimaryDisplay();
  const deckW = 96; // tight deck bounds: clear the rail + a little air
  const { w: NW, h: NH } = noteWH();
  const x = d.workArea.x + d.workArea.width - deckW - 24 - NW;
  let y = d.workArea.y + Math.min(110, Math.max(24, Math.round(d.workArea.height * 0.14)));
  const off = (editors.size % 6) * 26;
  y = Math.min(y + off, d.workArea.y + Math.max(0, d.workArea.height - NH));
  w.setBounds({ x: Math.round(clamp(x - off, d.workArea.x, d.workArea.x + Math.max(0, d.workArea.width - NW))), y: Math.round(y), width: NW, height: NH });
}
function openEditor(noteId, opts = {}) {
  if (!noteId) { const n = store.create({}); broadcastNotes(); noteId = n.id; }
  const w = ensureEditor(noteId);
  sendToEditor('editor:open', noteId, noteId);
  let visible = false;
  try { visible = w.isVisible(); } catch {}
  if (!visible) {
    positionEditorDefault(w);
    if (!w._painted) w._showPending = opts.silent ? 2 : 1;
    else try { opts.silent ? w.showInactive() : w.show(); } catch {}
    broadcastOpenNotes();
  } else if (!opts.silent) { try { w.focus(); } catch {} }
  return w;
}
function tuckEditor(noteId) {
  const w = editors.get(noteId);
  if (w && !w.isDestroyed()) { try { w.hide(); } catch {} broadcastOpenNotes(); setDeckStage('fan'); }
}

/* ---------- clock window: floating timer, opened like a note ----------
 * The deck's clock disc toggles this singleton (win:open 'clock'). It lives
 * left of the deck, following it, and hides on toggle/×/Esc. Same actions
 * as the old in-deck sheet (TIMER.md §9 clock family: additive snooze). */
const CLOCK_W = 248, CLOCK_H = 336;
function ensureClock() {
  if (wins.clock && !wins.clock.isDestroyed()) return wins.clock;
  const w = new BrowserWindow({
    width: CLOCK_W, height: CLOCK_H, frame: false, transparent: true, alwaysOnTop: true, hasShadow: false,
    skipTaskbar: true, resizable: false, show: false,
    icon: faviconPath(),
    webPreferences: { preload: preloadPath(), contextIsolation: true },
  });
  w.loadFile(R('clock.html'));
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.on('closed', () => { delete wins.clock; });
  wins.clock = w;
  return w;
}
function positionClock(w) {
  // Left of the deck, centered on it (follows the deck); falls back to the
  // cursor display's right-center when the deck is hidden.
  let ax, cy;
  try {
    const dw = wins.deck;
    if (dw && !dw.isDestroyed() && dw.isVisible()) {
      const b = dw.getBounds();
      ax = b.x; cy = b.y + b.height / 2;
    }
  } catch {}
  const disp = cursorDisplay();
  const wa = (disp && disp.workArea) || screen.getPrimaryDisplay().workArea;
  if (ax === undefined) { ax = wa.x + wa.width; cy = wa.y + wa.height / 2; }
  const x = Math.round(Math.min(Math.max(ax - CLOCK_W - 12, wa.x), wa.x + Math.max(0, wa.width - CLOCK_W)));
  const y = Math.round(Math.min(Math.max(cy - CLOCK_H / 2, wa.y), wa.y + Math.max(0, wa.height - CLOCK_H)));
  try { w.setBounds({ x, y, width: CLOCK_W, height: CLOCK_H }); } catch {}
}
function toggleClockWindow() {
  const w = ensureClock();
  let visible = false;
  try { visible = w.isVisible(); } catch {}
  if (visible) { try { w.hide(); } catch {} return w; }
  positionClock(w);
  try { w.show(); } catch {}
  return w;
}

/* ---------- home / break / pill ---------- */
function openHome(view, reason) {
  console.log(`[win] home reason=${reason || 'shortcut'}`);
  const w = mkWin('home', 'home.html', { width: 1060, height: 700, frame: false, show: false });
  try {
    if (!w.isVisible()) w.show(); else w.focus();
    if (view) setTimeout(() => { try { w.webContents.send('home:view', view); } catch {} }, 250);
  } catch {}
  return w;
}
function showBreak(kind) {
  const s = engine.s;
  closePill();
  breakCounted = false;
  const displays = screen.getAllDisplays();
  displays.slice(0, s.showOnAllScreens ? displays.length : 1).forEach((d, i) => {
    const name = 'break' + i;
    if (wins[name] && !wins[name].isDestroyed()) { try { wins[name].close(); } catch {} }
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, fullscreen: true, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
      icon: faviconPath(),
      webPreferences: { preload: preloadPath(), contextIsolation: true },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.loadFile(R('break.html'));
    w.webContents.once('did-finish-load', () => {
      try {
        w.webContents.send('break:start', {
          kind, msg: engine.message,
          durationMs: kind === 'long' ? s.longDurationMs : s.miniDurationMs,
          endsAt: engine.phaseEndsAt,
          strict: kind === 'long' ? s.strictLong : s.strictMini,
          manual: !!s.manualFinish, allowSkip: !!s.allowSkip, allowPostpone: !!s.allowPostpone,
        });
        w.webContents.send('break:chime', { volume: s.volume });
      } catch {}
    });
    w.on('closed', () => { delete wins[name]; });
    wins[name] = w;
  });
}
function closeBreak() {
  Object.keys(wins).filter(k => k.startsWith('break')).forEach(k => { try { wins[k].close(); } catch {} });
}
function showPill(kind) {
  // Fixed top-centre warning — never cursor-following (a pill that runs away
  // from the pointer cannot be clicked). × dismisses the warning; the break
  // itself still starts on schedule.
  closePill();
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 320, h = 112;
  const x = Math.round(wa.x + wa.width / 2 - w / 2);
  const y = Math.min(wa.y + 72, wa.y + Math.max(0, wa.height - h));
  const win = new BrowserWindow({
    x, y, width: w, height: h, frame: false, transparent: true, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: false,
    icon: faviconPath(),
    webPreferences: { preload: preloadPath(), contextIsolation: true },
  });
  win.loadFile(R('pill.html'));
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.once('did-finish-load', () => { try { win.webContents.send('pill:start', { kind, endsAt: engine.phaseEndsAt }); } catch {} });
  win.on('closed', () => { delete wins.pill; });
  wins.pill = win;
}
function closePill() {
  if (wins.pill && !wins.pill.isDestroyed()) { try { wins.pill.close(); } catch {} }
  delete wins.pill;
}

/* ---------- focus actions ---------- */
function broadcastFocus(evt) {
  BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('focus:event', evt); } catch {} });
  updateTrayMenu();
}
// One break = one wellness count (Task 10, D8). Counted at break END only
// (auto-finish, Finish); Skip/Postpone increment only their own counters.
// Starting a break increments nothing. Guarded per break instance so a
// start+auto-finish pair can never double-count.
let breakCounted = true;
function countBreakTaken() {
  if (breakCounted) return;
  breakCounted = true;
  try { wellness.breakTaken(); } catch {}
  broadcastWellness();
}
function broadcastWellness() {
  BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('wellness:changed'); } catch {} });
}
function doAction(action, arg) {
  const f = getFeatures();
  if (!f.breaks && !['toggle'].includes(action)) return;
  switch (action) {
    case 'start-now': engine.startBreakNow('mini'); closePill(); showBreak('mini'); broadcastFocus({ type: 'break-start' }); break;
    case 'start-long': engine.startBreakNow('long'); closePill(); showBreak('long'); broadcastFocus({ type: 'break-start' }); break;
    case 'finish': engine.finishBreak(); closeBreak(); closePill(); countBreakTaken(); broadcastFocus({ type: 'break-end' }); break;
    case 'skip': if (engine.skip()) { breakCounted = true; try { wellness.breakSkipped(); } catch {} broadcastWellness(); closeBreak(); closePill(); broadcastFocus({ type: 'break-end' }); } break;
    case 'postpone': if (engine.postpone()) { breakCounted = true; try { wellness.breakPostponed(); } catch {} broadcastWellness(); closeBreak(); closePill(); broadcastFocus({ type: 'action' }); } break;
    case '+1': engine.deferNextBreak(60000); closeBreak(); closePill(); broadcastFocus({ type: 'action' }); break;
    case '+5': engine.deferNextBreak(5 * 60000); closeBreak(); closePill(); broadcastFocus({ type: 'action' }); break;
    case '+15': engine.deferNextBreak(15 * 60000); closeBreak(); closePill(); broadcastFocus({ type: 'action' }); break;
    case 'snooze1': engine.snooze(60000); broadcastFocus({ type: 'action' }); break;
    case 'snooze5': engine.snooze(5 * 60000); broadcastFocus({ type: 'action' }); break;
    case 'pause1h': engine.pauseFor(3600000); closeBreak(); closePill(); broadcastFocus({ type: 'action' }); break;
    case 'pauseMorning': engine.pauseUntilMorning(); broadcastFocus({ type: 'action' }); break;
    case 'toggle': engine.configure({ enabled: !engine.s.enabled }); setFocusSettings(engine.s); broadcastFocus({ type: 'settings' }); break;
  }
}

/* ---------- tray ---------- */
function trayText() {
  const now = Date.now();
  if (engine.phase === 'break') return `On break (${fmt(engine.phaseEndsAt - now)})`;
  if (engine.phase === 'prebreak') return `Break in ${fmt(engine.phaseEndsAt - now)}`;
  if (now < engine.pausedUntil) return `Paused until ${new Date(engine.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (engine.deferredReason) return `Paused (${engine.deferredReason}) — ${fmt(engine.remainingMs)} left`;
  if (!engine.s.enabled) return 'Breaks off';
  return `Next break in ${fmt(engine.remainingMs)}`;
}
function updateTrayMenu() {
  if (!tray) return;
  try {
    tray.setToolTip(`Flinkynotes ${BUILD} — ` + trayText());
    const s = engine.s;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Flinkynotes ${BUILD} · ${trayText()}`, enabled: false },
      { type: 'separator' },
      { label: 'Open home', click: () => openHome(null, 'tray') },
      { label: 'Start break now', click: () => doAction('start-now') },
      { label: 'Start long break now', click: () => doAction('start-long') },
      { label: 'Finish break', click: () => doAction('finish') },
      { label: 'Skip to next', click: () => doAction('skip') },
      { label: 'Pause 1 hour', click: () => doAction('pause1h') },
      { label: manualMeeting ? '✓ In a meeting (paused)' : 'Mark as in a meeting', type: 'checkbox', checked: manualMeeting, click: () => { manualMeeting = !manualMeeting; updateTrayMenu(); } },
      { type: 'separator' },
      { label: 'New note', accelerator: 'Alt+Ctrl+N', click: () => { const n = store.create({}); broadcastNotes(); setDeckStage('fan'); openEditor(n.id); } },
      { label: 'Pomodoro: start work', click: () => { pomo.startWork(); broadcastPomo(); } },
      { label: 'Break timer settings', accelerator: 'Alt+Ctrl+T', click: () => openHome('focus', 'tray') },
      { label: s.enabled ? 'Disable breaks' : 'Enable breaks', click: () => doAction('toggle') },
      { label: 'Restart app', click: () => { try { app.relaunch(); } catch {} app.quit(); } },
      { label: 'Quit', click: () => app.quit() },
    ]));
  } catch {}
}
function broadcastNotes() {
  BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('notes:changed'); } catch {} });
}
function broadcastPomo() {
  const st = pomo.status();
  BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('pomo:event', st); } catch {} });
  updateTrayMenu();
}
function fireNudge(n) {
  BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('nudge:fire', n); } catch {} });
  try {
    if (Notification.isSupported()) {
      const note = new Notification({ title: n.title, body: n.body, silent: true, icon: iconImage() });
      note.show();
    }
  } catch {}
  if (n.kind === 'custom') { try { wellness.customTaken(); } catch {} broadcastWellness(); }
  if (n.kind === 'posture') { try { wellness.postureTaken(); } catch {} broadcastWellness(); }
}

/* ---------- IPC ---------- */
function registerIpc() {
  ipcMain.handle('focus:state', () => ({ phase: engine.phase, kind: engine.kind, remainingMs: engine.remainingMs, endsAt: engine.phaseEndsAt, deferred: engine.deferredReason || null, msg: engine.message, pausedUntil: engine.pausedUntil, settings: engine.s }));
  ipcMain.handle('focus:action', (_e, action, arg) => { doAction(action, arg); return true; });
  ipcMain.handle('focus:getSettings', () => getFocusSettings());
  ipcMain.handle('focus:saveSettings', (_e, s) => { engine.configure(s); setFocusSettings(engine.s); broadcastFocus({ type: 'settings' }); return engine.s; });

  ipcMain.handle('notes:list', (_e, o) => store.list(o || {}));
  ipcMain.handle('notes:get', (_e, id) => store.get(id));
  ipcMain.handle('notes:create', (_e, o) => { const n = store.create(o || {}); broadcastNotes(); return n; });
  ipcMain.handle('notes:update', (_e, id, patch) => { const n = store.update(id, patch || {}); broadcastNotes(); return n; });
  ipcMain.handle('notes:remove', (_e, id) => { store.remove(id); broadcastNotes(); return true; });
  ipcMain.handle('notes:restore', (_e, snap) => { const n = store.restore(snap); broadcastNotes(); return n; });
  ipcMain.handle('notes:reorder', (_e, ids) => { store.reorder(ids || []); broadcastNotes(); return true; });
  ipcMain.handle('notes:export', async (_e, kind) => { try { const p = store.exportAll(kind); try { shell.showItemInFolder(p); } catch {} return p; } catch { return null; } });
  ipcMain.handle('notes:import', async () => {
    try {
      const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Notes', extensions: ['md', 'txt', 'json'] }] });
      if (r.canceled) return 0;
      const c = store.importFiles(r.filePaths);
      broadcastNotes();
      return c;
    } catch { return 0; }
  });
  ipcMain.handle('notes:quickCapture', (_e, text, destId) => {
    const t = String(text || '').trim();
    if (!t) return null;
    let n = destId ? store.get(destId) : null;
    if (n) { const body = (n.body ? n.body + '\n' : '') + t; n = store.update(n.id, { body }); }
    else n = store.create({ body: t });
    broadcastNotes();
    return n;
  });

  ipcMain.handle('deck:get', () => {
    // waH lets the renderer budget layout against the SCREEN, never the
    // zones-driven window height (budgeting off that oscillates). Uses the
    // cursor's display — the deck lives where the user is.
    let waH = 0;
    try { const disp = cursorDisplay(); waH = (disp && disp.workArea.height) || screen.getPrimaryDisplay().workArea.height || 0; } catch {}
    return { ...getDeckSettings(), openIds: openNoteIds(), waH };
  });
  ipcMain.handle('deck:save', (_e, d) => applyDeckSave(d));
  ipcMain.handle('sys:get', () => {
    let osOpen = false;
    try { osOpen = !!app.getLoginItemSettings().openAtLogin; } catch {}
    return { autostart: !!settings.get('autostart', false), openAtLogin: osOpen, unpackaged: !app.isPackaged, build: BUILD };
  });
  ipcMain.handle('sys:save', (_e, d) => {
    const want = !!((d || {}).autostart);
    settings.set('autostart', want);
    // Unpackaged runs (npm start) must never register a login item —
    // dev Electron would register itself as the login app.
    if (!app.isPackaged) return { autostart: want, openAtLogin: false, unpackaged: true };
    try {
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      if (want) app.setLoginItemSettings({ openAtLogin: true, path: exe, args: ['--hidden'] });
      else app.setLoginItemSettings({ openAtLogin: false, path: exe, args: ['--hidden'] });
    } catch {}
    let osOpen = false;
    try { osOpen = !!app.getLoginItemSettings().openAtLogin; } catch {}
    return { autostart: want, openAtLogin: osOpen, unpackaged: false };
  });
  ipcMain.handle('win:open', (_e, name, arg) => {
    if (name === 'editor') return !!openEditor(arg);
    if (name === 'clock') { toggleClockWindow(); return true; }
    if (name === 'home') { openHome(arg, 'shortcut'); return true; }
    if (name === 'all' || name === 'archive') {
      const w = mkWin('all', 'all.html', { width: 980, height: 640 }, true);
      if (arg || name === 'archive') w.webContents.once('did-finish-load', () => { try { w.webContents.send('all:filter', arg || 'archived'); } catch {} });
      return true;
    }
    if (name === 'capture') { mkWin('capture', 'capture.html', { width: 420, height: 260 }, true); return true; }
    return false;
  });
  ipcMain.handle('win:closeSelf', (e) => { try { BrowserWindow.fromWebContents(e.sender).close(); } catch {} });
  ipcMain.handle('win:hideSelf', (e) => { try { BrowserWindow.fromWebContents(e.sender).hide(); } catch {} return true; });
  ipcMain.handle('win:min', (e) => { try { BrowserWindow.fromWebContents(e.sender).minimize(); } catch {} return true; });
  ipcMain.handle('win:maxToggle', (e) => {
    try {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w.isMaximized()) w.unmaximize(); else w.maximize();
    } catch {}
  });

  // wellness
  ipcMain.handle('wellness:get', () => wellness.today());
  ipcMain.handle('wellness:summary', () => wellness.summary());
  // Productivity report: completed pomodoros today / last 7 days / last 30.
  // bySubject counts come from per-session records; days recorded before
  // subjects existed still count toward totals.
  ipcMain.handle('wellness:pomoStats', () => {
    const days = wellness.daysMap();
    const now = new Date();
    const keys = (n) => {
      const out = [];
      for (let i = n - 1; i >= 0; i--) {
        const dt = new Date(now);
        dt.setDate(now.getDate() - i);
        out.push(dateKey(dt));
      }
      return out;
    };
    const tally = (ks) => {
      let total = 0;
      const bySubject = {};
      for (const k of ks) {
        const d = days[k];
        if (!d) continue;
        const sessions = Array.isArray(d.sessions) ? d.sessions : [];
        total += sessions.length || d.pomodoros || 0;
        for (const s of sessions) {
          const id = s.subject || '__none__';
          bySubject[id] = (bySubject[id] || 0) + 1;
        }
      }
      return { total, bySubject };
    };
    const weekKeys = keys(7);
    const monthKeys = keys(30);
    const week = weekKeys.map(k => {
      const d = days[k];
      const sessions = d && Array.isArray(d.sessions) ? d.sessions : [];
      return { date: k, total: sessions.length || (d && d.pomodoros) || 0 };
    });
    const month = tally(monthKeys);
    let best = { date: null, total: 0 };
    for (const w of week) { if (w.total > best.total) best = w; }
    return { today: tally([dateKey(now)]), week, month, best };
  });
  ipcMain.handle('features:get', () => getFeatures());
  ipcMain.handle('features:save', (_e, f) => {
    const next = { ...getFeatures(), ...(f || {}) };
    settings.set('features', next);
    engine.configure({ enabled: next.breaks ? getFocusSettings().enabled : false });
    return next;
  });
  ipcMain.handle('pomo:get', () => ({ settings: pomo.s, status: pomo.status() }));
  ipcMain.handle('pomo:save', (_e, s) => { pomo.configure(s || {}); settings.set('pomo', pomo.s); broadcastPomo(); return pomo.s; });
  ipcMain.handle('pomo:action', (_e, a) => {
    if (a === 'startWork') pomo.startWork();
    else if (a === 'startBreak') pomo.startBreak();
    else if (a === 'pause') pomo.pause();
    else if (a === 'resume') pomo.resume();
    else if (a === 'reset') pomo.reset();
    else if (a === 'skip') pomo.skip();
    settings.set('pomo', pomo.s);
    broadcastPomo();
    return pomo.status();
  });
  ipcMain.handle('nudges:get', () => nudges.serialize());
  ipcMain.handle('nudges:save', (_e, s) => { nudges.configure(s || {}); settings.set('nudges', nudges.serialize()); return nudges.serialize(); });
  ipcMain.handle('nudges:add', (_e, r) => { const n = nudges.addCustom(r || {}); settings.set('nudges', nudges.serialize()); return n; });
  ipcMain.handle('nudges:update', (_e, id, p) => { const n = nudges.updateCustom(id, p || {}); settings.set('nudges', nudges.serialize()); return n; });
  ipcMain.handle('nudges:remove', (_e, id) => { nudges.removeCustom(id); settings.set('nudges', nudges.serialize()); return true; });
  ipcMain.handle('schedule:get', () => getSchedule());
  ipcMain.handle('schedule:save', (_e, s) => { const n = { ...getSchedule(), ...(s || {}) }; settings.set('schedule', n); return n; });
  ipcMain.handle('pill:dismiss', () => { closePill(); return true; });

  ipcMain.on('deck:stage', (e, stage) => { try { setDeckStage(String(stage), { echo: false }); } catch {} });
  ipcMain.on('deck:pointer', (_e, inside) => {
    // Renderer-owned folding: the only main-owned fold is the programmatic
    // autoRest below, which a pointer exploring the deck cancels.
    if (inside) clearTimeout(deckAutoRest);
  });
  ipcMain.on('deck:zones', (_e, z) => {
    // Stale generations (e.g., a resize echo from before a rebuild) are
    // dropped — only the newest layout may move the native window.
    const gen = z && Number.isFinite(z.gen) ? z.gen : 0;
    if (gen < deckGen) return;
    deckGen = gen;
    // Content rects (window-local) drive the native window bounds — tight
    // around pill / rail+tabs / preview / clock, nothing else.
    deckZonesLocal = (z && Array.isArray(z.rects)) ? z.rects : [];
    deckSigCur = (z && typeof z.sig === 'string') ? z.sig : '';
    driveMark('zones', DRIVE ? {
      n: deckZonesLocal.length, stage: deckStage, policy: decideDeckPlacement({
        stage: deckStage, crossing: deckCenterNext,
        sigChanged: lastSig !== null && deckSigCur !== lastSig,
      }),
      rects: deckZonesLocal.map(r => [r.x, r.y, r.width ?? r.w, r.height ?? r.h].join(',')),
    } : { n: deckZonesLocal.length, stage: deckStage });
    applyDeckBounds();
  });
  ipcMain.on('note:tuck', (e) => {
    try {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w || w.isDestroyed()) return;
      // A tuck click must never no-op: hide the sender even if its note id
      // can't be resolved (stale window, already-removed note).
      if (w._noteId) tuckEditor(w._noteId);
      else { try { w.hide(); } catch {} }
    } catch {}
  });
  ipcMain.on('clock:fit', (e, h) => {
    // The clock window hugs its panel (no dead transparent pad eating
    // clicks next to it). Bounds sanity-checked like the old clock widget.
    try {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w || w.isDestroyed()) return;
      const hh = Math.min(600, Math.max(200, Math.round(Number(h) || CLOCK_H)));
      const b = w.getBounds();
      if (Math.abs(b.height - hh) > 1) w.setBounds({ x: b.x, y: b.y, width: b.width, height: hh });
    } catch {}
  });
}

function registerShortcuts() {
  try {
    globalShortcut.register('Alt+CommandOrControl+N', () => { const n = store.create({}); broadcastNotes(); setDeckStage('fan'); openEditor(n.id); });
    globalShortcut.register('Alt+CommandOrControl+A', () => { mkWin('all', 'all.html', { width: 980, height: 640 }, true); });
    globalShortcut.register('Alt+CommandOrControl+L', () => {
      const w = mkWin('all', 'all.html', { width: 980, height: 640 }, true);
      w.webContents.once('did-finish-load', () => { try { w.webContents.send('all:filter', 'archived'); } catch {} });
    });
    globalShortcut.register('Alt+CommandOrControl+T', () => openHome('focus', 'shortcut'));
    globalShortcut.register('Alt+CommandOrControl+H', () => openHome(null, 'shortcut'));
    globalShortcut.register('CommandOrControl+Shift+Space', () => { mkWin('capture', 'capture.html', { width: 420, height: 260 }, true); });
  } catch {}
}

/* ---------- main tick ---------- */
let tickCount = 0;
function startLoops() {
  setInterval(() => {
    tickCount++;
    const f = getFeatures();
    const sched = getSchedule();
    const inSchedule = isActiveNow(sched);
    const schedHold = f.workSchedule && sched.enabled && !inSchedule;
    const meeting = manualMeeting;
    const guards = { meeting, tickMs: 1000 };
    let evts = [];
    if (f.breaks && !schedHold) {
      evts = engine.tick(Date.now(), guards);
      for (const e of evts) {
        if (e.type === 'prebreak') showPill(e.kind);
        else if (e.type === 'break-start') showBreak(e.kind);
        else if (e.type === 'break-end') { closeBreak(); countBreakTaken(); }
        broadcastFocus(e);
      }
    } else {
      engine.remainingMs = Math.max(0, engine.phaseEndsAt - Date.now());
    }
    // pomodoro shares the 1s loop. Broadcast every tick while running so the
    // Home countdown moves every second — the old every-5th-tick push is what
    // made 22:45 jump straight to 22:40.
    if (f.pomodoro) {
      const pe = pomo.tick();
      if (pe.length) {
        for (const e of pe) {
          if (e.type === 'pomodoro-work-done') { try { wellness.pomodoroDone(pomo.s.currentSubjectId); } catch {} broadcastWellness(); }
        }
        broadcastPomo();
      } else if (pomo.state !== 'idle' && pomo.state !== 'paused') {
        broadcastPomo();
      }
    }
    BrowserWindow.getAllWindows().forEach(w => {
      try { w.webContents.send('focus:tick', { phase: engine.phase, remainingMs: engine.remainingMs, endsAt: engine.phaseEndsAt, pausedUntil: engine.pausedUntil }); } catch {}
    });
    if (tickCount % 5 === 0) updateTrayMenu();
  }, 1000);

  setInterval(() => {
    const f = getFeatures();
    if (!f.posture && !f.blink && !f.customReminders) return;
    const s = nudges.s;
    const gated = {
      ...s,
      postureEnabled: f.posture && s.postureEnabled,
      blinkEnabled: f.blink && s.blinkEnabled,
      customEnabled: f.customReminders && s.customEnabled,
    };
    const keep = nudges.s;
    nudges.s = gated;
    const due = nudges.due(Date.now());
    nudges.s = keep;
    // re-arm real timers even when gated off so enabling later doesn't burst
    nudges.due(0).length;
    for (const n of due) fireNudge(n);
  }, 30000);

  // deck cursor poll: wakes a hidden/resting deck when the pointer reaches
  // the right edge of whichever display the pointer is on. Folding belongs
  // to the renderer alone (it sees the pointer) — this poll deliberately
  // never folds, so a wake can never bounce straight back shut.
  setInterval(() => {
    try {
      const w = wins.deck;
      if (!w || w.isDestroyed()) return;
      if (getDeckSettings().hidePill || getDeckSettings().keepOpen) return;
      if (Date.now() < deckQuietUntil) return;
      if (deckStage !== 'rest') return;
      const c = screen.getCursorScreenPoint();
      const disp = cursorDisplay();
      const wa = (disp && disp.workArea) || screen.getPrimaryDisplay().workArea;
      const near = c.x >= wa.x + wa.width - 30;
      if (near && c.y > wa.y + 56) setDeckStage('fan', { autoFold: false });
    } catch {}
  }, 120);
}

async function createTray() {
  try {
    tray = new Tray(iconImage());
    tray.setToolTip('Flinkynotes');
    tray.on('double-click', () => openHome(null, 'tray'));
    updateTrayMenu();
  } catch {}
}

// One instance only: a second copy would stack a twin deck/clock over this
// one and read as rendering chaos.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
// A second launch never starts a second app (single-instance lock): the new
// process quits and THIS handler acknowledges. It used to open Home, which
// read as "a window appears in the middle for no reason" on every relaunch
// attempt — and worse, the old build kept running, so fixes never took
// effect. Now it just wakes the deck and logs, so the attempt is visible.
app.on('second-instance', () => {
  console.log(`Flinkynotes build ${BUILD}: second launch ignored (already running)`);
  try { setDeckStage('fan', { autoFold: false }); } catch {}
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  console.log(`Flinkynotes build ${BUILD} starting`);
  try {
    const ip = faviconPath();
    const loaded = nativeImage.createFromPath(ip);
    console.log(`Flinkynotes icon ${ip} empty=${loaded.isEmpty()}`);
  } catch (e) { console.log(`Flinkynotes icon failed: ${e && e.message}`); }
  // Stale bare-Electron autostart entry: an unpackaged run that finds a
  // registered login item is looking at the pre-v1.0.0 bad registration
  // (bare electron.exe, opens the Electron demo window at sign-in — never
  // what the user wants). Remove it once and log; packaged runs never touch
  // the entry. Current code never registers from unpackaged runs, so this
  // cannot recur.
  try {
    const { shouldRemoveStaleLogin } = require('./dataPaths');
    let open = false;
    try { open = !!app.getLoginItemSettings().openAtLogin; } catch {}
    if (shouldRemoveStaleLogin({ isPackaged: app.isPackaged, openAtLogin: open })) {
      try { app.setLoginItemSettings({ openAtLogin: false }); } catch {}
      console.log('[autostart] removed stale bare-Electron login item (was opening the Electron demo window at sign-in)');
    }
  } catch (e) { console.log(`[autostart] stale-login check failed: ${e && e.message}`); }
  // On-disk rebrand (Task 4): pre-rename folder carry-over + settings/notes
  // rename, idempotent and before any store loads. Engines constructed at
  // module load are re-synced after so a migrated profile takes effect.
  try {
    const { carryOverPrevAppDir, migrateUserData } = require('./dataPaths');
    const cur = app.getPath('userData');
    if (app.isPackaged) {
      const prev = path.join(path.dirname(cur), LEGACY_APP_DIR);
      carryOverPrevAppDir(cur, prev);
    }
    migrateUserData(cur);
  } catch {}
  try { engine.configure(getFocusSettings()); } catch {}
  try { pomo.configure(getPomoSettings()); } catch {}
  try { nudges.configure(getNudgeSettings()); } catch {}
  // Feature-removal prune (Task 5): drop idle/process-guard keys once so old
  // profiles never resurrect removed settings.
  try {
    const foc = settings.get('focus', null);
    if (foc && typeof foc === 'object') {
      let touched = false;
      for (const k of ['pauseWhileIdleMs', 'exclusions', 'pauseDnd', 'pauseFullscreen']) {
        if (Object.prototype.hasOwnProperty.call(foc, k)) { delete foc[k]; touched = true; }
      }
      if (touched) settings.set('focus', foc);
    }
    const feat = settings.get('features', null);
    if (feat && typeof feat === 'object' && Object.prototype.hasOwnProperty.call(feat, 'idleDetection')) {
      delete feat.idleDetection;
      settings.set('features', feat);
    }
  } catch {}
  // Starts fresh: no migration from legacy data dirs.
  wellness = new WellnessStore(path.join(app.getPath('userData'), 'wellness.json'));
  registerIpc();
  registerShortcuts();
  ensureDeck();
  setDeckStage('rest');
  startLoops();
  await createTray();
  // Login-item launches (--hidden) are tray-only: never open Home, including
  // a first run on a fresh profile (seenHome stays false so the next
  // interactive launch still onboards once).
  const hiddenLaunch = process.argv.includes('--hidden');
  if (hiddenLaunch) {
    console.log('[win] home reason=hidden-skip');
  } else if (!settings.get('seenHome', false)) {
    settings.set('seenHome', true);
    setTimeout(() => openHome(null, 'first-run'), 600);
  }
  updateTrayMenu();
  // Headless hover-drive (dev only): --deckdrive <json> replays wake →
  // hover-tab → preview → leave → fold and dumps every zones message, native
  // resize, and DOM snapshot with timestamps. Settles-or-storms, in numbers.
  if (DRIVE) {
    const out = process.argv[process.argv.indexOf('--deckdrive') + 1] ||
      path.join(os.tmpdir(), 'opencode', 'deckdrive.json');
    const snapJS = `(() => { const r = document.getElementById('deckRoot'); const p = document.getElementById('preview'); return { rest: r.classList.contains('rest'), pv: p.classList.contains('show'), tabs: document.querySelectorAll('#fan .tab').length }; })()`;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    setTimeout(async () => {
      const snaps = {};
      // Flash-hunt poller: samples every native window's visibility+bounds
      // at 120ms. A transient flash (show→hide or jump→return within a few
      // samples) is visible here even if no zones message explains it.
      const watch = [];
      const watchT = setInterval(() => {
        try {
          const row = { at: Date.now() - driveLog.t0 };
          for (const [k, win] of Object.entries({ ...wins, ...Object.fromEntries(editors) })) {
            if (!win || win.isDestroyed()) continue;
            const b = win.getBounds();
            row[k] = `${win.isVisible() ? 'V' : 'h'}${b.x},${b.y},${b.width},${b.height}`;
          }
          watch.push(row);
        } catch {}
      }, 120);
      try {
        const w = wins.deck;
        const snap = async (tag) => { try { snaps[tag] = await w.webContents.executeJavaScript(snapJS); } catch (e) { snaps[tag] = { err: String(e && e.message) }; } };
        setDeckStage('fan');
        await sleep(1200);
        await snap('fanned');
        await w.webContents.executeJavaScript(`(() => { const t = document.querySelector('#fan .tab[data-nid]'); if (t) t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return !!t; })()`);
        await sleep(600);
        await snap('hovered');
        // Structural change while OPEN: add + remove a note mid-fan. The fan
        // must stay centered (sig change → center policy), not drift.
        const dn = store.create({ body: 'drive structural probe' });
        broadcastNotes();
        await sleep(900);
        await snap('added');
        store.remove(dn.id);
        broadcastNotes();
        await sleep(900);
        await snap('removed');
        await w.webContents.executeJavaScript(`(() => { document.dispatchEvent(new MouseEvent('mouseleave')); return true; })()`);
        await sleep(2500);
        await snap('left');
        // Second wake/fold cycle: the fan must come back to the SAME place
        // (screen center is deterministic — re-centering every wake to a
        // remembered position drifted and read as creep).
        setDeckStage('fan');
        await sleep(1200);
        await snap('fanned2');
        await w.webContents.executeJavaScript(`(() => { document.dispatchEvent(new MouseEvent('mouseleave')); return true; })()`);
        await sleep(2500);
        await snap('left2');
        clearInterval(watchT);
        try { store.remove(dn.id); } catch {}
        broadcastNotes();
        fs.writeFileSync(out, JSON.stringify({ snaps, watch, log: driveLog }, null, 2));
        console.log('deckdrive saved', out);
      } catch (e) { try { clearInterval(watchT); } catch {} console.log('deckdrive failed', e && e.message); }
      app.quit();
    }, 2500);
  }
  // Visual-regression harness (dev only): --deckshot <png> opens the fan,
  // captures the deck window, then opens the floating clock window and
  // captures that too (<png> + '-clock.png'). Used to verify deck layout
  // headlessly after deck changes.
  if (process.argv.includes('--deckshot')) {
    const out = process.argv[process.argv.indexOf('--deckshot') + 1] ||
      path.join(os.tmpdir(), 'opencode', 'deckshot.png');
    setTimeout(async () => {
      try {
        setDeckStage('fan');
        await new Promise(r => setTimeout(r, 1600));
        const w = wins.deck;
        if (w && !w.isDestroyed()) {
          // White backdrop: dark discs on transparency photograph as black.
          await w.webContents.executeJavaScript(`(() => { try { window.__deckshot.whiteBg(true); } catch (e) { return 'hook-fail:' + e.message; } return 'hook-ok'; })()`);
          await new Promise(r => setTimeout(r, 800));
          const img = await w.webContents.capturePage();
          fs.writeFileSync(out, img.toPNG());
          console.log('deckshot saved', out, JSON.stringify(w.getBounds()));
        }
        const cw = toggleClockWindow();
        await new Promise(r => setTimeout(r, 1200));
        if (cw && !cw.isDestroyed()) {
          const diag = await cw.webContents.executeJavaScript(`(() => { try { const p = document.getElementById('ckPanel'); const cs = p ? getComputedStyle(p) : null; return { ready: document.readyState, kids: document.body ? document.body.children.length : -1, panelH: p ? p.offsetHeight : -1, panelBg: cs ? cs.backgroundColor : 'none', title: (document.getElementById('ckTitle')||{}).textContent || 'none', css: document.styleSheets.length }; } catch (e) { return { err: String(e && e.message) }; } })()`).catch(e => ({ jsErr: String(e && e.message) }));
          console.log('clock diag', JSON.stringify(diag), JSON.stringify(cw.getBounds()));
          await cw.webContents.executeJavaScript(`(() => { try { document.getElementById('clockRoot').style.background = '#fff'; } catch (e) {} return true; })()`);
          await new Promise(r => setTimeout(r, 300));
          const cimg = await cw.webContents.capturePage();
          const cout = out.replace(/\.png$/i, '-clock.png');
          fs.writeFileSync(cout, cimg.toPNG());
          console.log('deckshot saved', cout, JSON.stringify(cw.getBounds()));
        }
      } catch (e) { console.log('deckshot failed', e && e.message); }
      app.quit();
    }, 2500);
  }
  // Ghost-note probe (dev only): --ghostprobe <json> creates notes and
  // verifies delete / archive / X all hide their windows immediately.
  // Dumps visibility + DOM + store state at each step. Cleans up after.
  if (process.argv.includes('--ghostprobe')) {
    const out = process.argv[process.argv.indexOf('--ghostprobe') + 1] ||
      path.join(os.tmpdir(), 'opencode', 'ghostprobe.json');
    const gsleep = (ms) => new Promise(r => setTimeout(r, ms));
    setTimeout(async () => {
      const rep = {};
      try {
        const stateOf = async (w, tag) => {
          let dom = null;
          try {
            dom = await w.webContents.executeJavaScript(`(() => ({ card: document.getElementById('card').className, toast: ((document.getElementById('toast')||{}).className || 'gone') + '|' + (((document.getElementById('toastMsg')||{}).textContent) || ''), title: document.getElementById('title').value }))()`);
          } catch (e) { dom = { err: String(e && e.message) }; }
          rep[tag] = { visible: !w.isDestroyed() && w.isVisible(), dom };
        };
        // --- delete path ---
        const n1 = store.create({ body: 'ghost probe one' });
        broadcastNotes();
        const w1 = openEditor(n1.id);
        await gsleep(1500);
        await stateOf(w1, 'delete_opened');
        rep.delete_storeBefore = !!store.get(n1.id);
        await w1.webContents.executeJavaScript(`(() => { document.getElementById('del').click(); return true; })()`);
        await gsleep(300);
        await w1.webContents.executeJavaScript(`(() => { document.getElementById('del').click(); return true; })()`);
        await gsleep(800);
        await stateOf(w1, 'delete_deleted');
        rep.delete_storeAfter = !!store.get(n1.id);
        await gsleep(1500); // tuck is immediate; grace period then verify hidden
        await stateOf(w1, 'delete_afterExpiry');
        rep.delete_editorsKeys = [...editors.keys()];
        rep.delete_winNoteId = w1._noteId;
        // --- archive path ---
        const n2 = store.create({ body: 'ghost probe two' });
        broadcastNotes();
        const w2 = openEditor(n2.id);
        await gsleep(1500);
        await w2.webContents.executeJavaScript(`(() => { document.getElementById('arch').click(); return true; })()`);
        await gsleep(800);
        await stateOf(w2, 'archive_archived');
        await gsleep(1500); // tuck is immediate; grace period then verify hidden
        await stateOf(w2, 'archive_afterExpiry');
        // --- X-button path on a live note ---
        const n3 = store.create({ body: 'ghost probe three' });
        broadcastNotes();
        const w3 = openEditor(n3.id);
        await gsleep(1500);
        await w3.webContents.executeJavaScript(`(() => { document.getElementById('tuck').click(); return true; })()`);
        await gsleep(800);
        await stateOf(w3, 'x_closed');
        // cleanup test notes
        try { store.remove(n1.id); } catch {}
        try { store.remove(n2.id); } catch {}
        try { store.remove(n3.id); } catch {}
        broadcastNotes();
        fs.writeFileSync(out, JSON.stringify(rep, null, 2));
        console.log('ghostprobe saved', out);
      } catch (e) { console.log('ghostprobe failed', e && e.message); }
      app.quit();
    }, 2500);
  }
  // Hide-strip toggle probe (dev only): --toggleprobe <json> drives 5
  // hidePill ON/OFF cycles through the real applyDeckSave path and records
  // window visibility, bounds and zones per step. Proves the strip hides and
  // returns with no restart and no edge-poll/cursor dependency: ON and OFF
  // visibility are asserted synchronously after each call.
  if (process.argv.includes('--toggleprobe')) {
    const out = process.argv[process.argv.indexOf('--toggleprobe') + 1] ||
      path.join(os.tmpdir(), 'opencode', 'toggleprobe.json');
    setTimeout(async () => {
      const steps = [];
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const snap = async (tag) => {
        try {
          const w = wins.deck;
          const b = w && !w.isDestroyed() ? w.getBounds() : null;
          steps.push({
            tag, at: Date.now(),
            visible: !!(w && !w.isDestroyed() && w.isVisible()),
            bounds: b ? [b.x, b.y, b.width, b.height].join(',') : 'gone',
            zones: deckZonesLocal.length, stage: deckStage,
            hidePill: !!getDeckSettings().hidePill,
          });
        } catch (e) { steps.push({ tag, err: String(e && e.message) }); }
      };
      try {
        await sleep(1200);
        await snap('start');
        for (let i = 0; i < 5; i++) {
          applyDeckSave({ hidePill: true });
          await sleep(700);
          await snap(`cycle${i + 1}-on`);
          applyDeckSave({ hidePill: false });
          await sleep(1000);
          await snap(`cycle${i + 1}-off`);
        }
        fs.writeFileSync(out, JSON.stringify({ steps }, null, 2));
        console.log('toggleprobe saved', out);
      } catch (e) { console.log('toggleprobe failed', e && e.message); }
      app.quit();
    }, 2500);
  }
});

app.on('window-all-closed', (e) => { e.preventDefault(); });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} try { if (wellness) wellness.flushSession(); } catch {} });
