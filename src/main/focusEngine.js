// Hybrid break engine: mini+long state machine + custom text + 20-20-20 preset.
// States: focus -> prebreak -> break -> focus. Pure logic, no Electron deps (unit-testable).
const BREAK_IDEAS_MINI = [
  'Look 20 ft away for 20 seconds', 'Roll your shoulders slowly', 'Blink fully 10 times',
  'Stand up and stretch tall', 'Shake out your hands', 'Take 5 slow breaths',
  'Look left, right, up, down slowly', 'Unclench your jaw', 'Drop shoulders from ears',
  'Focus on something far, then near', 'Wiggle your toes', 'Drink water',
];
const BREAK_IDEAS_LONG = [
  'Walk away from the screen', 'Do 10 squats', 'Make tea mindfully',
  'Tidy one small area', 'Step outside if you can', 'Stretch neck side to side',
  'Call or text someone you like', 'Do a 2-minute tidy', 'Foam-roll your back',
  'Eat a piece of fruit slowly',
];

const DEFAULTS = {
  enabled: true,
  miniEnabled: true, miniIntervalMs: 10 * 60 * 1000, miniDurationMs: 20 * 1000,
  longEnabled: true, longEvery: 3, longDurationMs: 5 * 60 * 1000, // every 3 minis
  preMiniMs: 10 * 1000, preLongMs: 30 * 1000,
  postponeMiniMs: 2 * 60 * 1000, postponeLongMs: 5 * 60 * 1000,
  strictMini: false, strictLong: false, manualFinish: false,
  overlayTitle: 'Time to look away', overlayDesc: 'Rest your eyes — gaze at something far away.',
  preset: 'classic', // classic | 20-20-20 | custom
  lunchEnabled: false, lunchAt: '12:30', lunchDurationMs: 30 * 60 * 1000,
  breakIdeas: true, sound: true, volume: 0.7,
  showOnAllScreens: true, allowSkip: true, allowPostpone: true,
};

function applyPreset(name) {
  // Pre-rename saved values (any unknown preset) fall back to classic.
  const canon = (name === '20-20-20' || name === 'custom' || name === 'classic') ? name : 'classic';
  if (canon === '20-20-20') {
    return { ...DEFAULTS, preset: canon, miniEnabled: true, miniIntervalMs: 20 * 60 * 1000, miniDurationMs: 20 * 1000, longEnabled: false };
  }
  return { ...DEFAULTS, preset: canon };
}

class FocusEngine {
  constructor(settings = {}) {
    this.s = { ...DEFAULTS, ...settings };
    this.reset();
  }
  reset() {
    this.phase = 'focus'; // focus | prebreak | break
    this.kind = null; // mini | long | lunch | ondemand
    this.phaseEndsAt = Date.now() + this.s.miniIntervalMs;
    this.minisSinceLong = 0;
    this.postponesUsed = 0;
    this.pausedUntil = 0;
    this.skipVisibleAt = 0;
    this.message = this.pickMessage('mini');
    this.remainingMs = this.s.miniIntervalMs;
  }
  pickMessage(kind) {
    const ideas = kind === 'long' ? BREAK_IDEAS_LONG : BREAK_IDEAS_MINI;
    const idea = ideas[Math.floor(Math.random() * ideas.length)];
    return { title: this.s.overlayTitle, desc: this.s.breakIdeas ? `${this.s.overlayDesc}\n\nTry: ${idea}` : this.s.overlayDesc, idea };
  }
  configure(next) { this.s = { ...this.s, ...next }; }
  pauseFor(ms) {
    this.pausedUntil = Date.now() + ms;
    this.phase = 'focus';
    this.phaseEndsAt = this.pausedUntil + this.s.miniIntervalMs;
    // Keep remainingMs fresh so IPC readers never see a stale pre-pause value.
    this.remainingMs = this.pausedUntil - Date.now();
    this.skipVisibleAt = 0;
  }
  pauseUntilMorning() {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(7, 0, 0, 0);
    this.pauseFor(d.getTime() - Date.now());
  }
  startBreakNow(kind = 'ondemand', durationMs) {
    this.phase = 'break'; this.kind = kind;
    const dur = durationMs || (kind === 'long' ? this.s.longDurationMs : this.s.miniDurationMs);
    this.phaseEndsAt = Date.now() + dur;
    this.message = this.pickMessage(kind);
    this.skipVisibleAt = Date.now() + Math.min(60 * 1000, dur / 2);
  }
  // Break-screen +1m/+5m/+15m: END this break and bring the overlay back
  // after exactly `ms` — not a full cycle restart (pauseFor() used to park the
  // timer and then restart the whole mini interval, which read as "the buttons
  // reset the timer"). Counters (minisSinceLong, postpones) are untouched, so
  // the long-break cadence keeps its place.
  deferNextBreak(ms) {
    const now = Date.now();
    this.phase = 'focus';
    this.pausedUntil = 0;
    this.phaseEndsAt = now + Math.max(1000, Math.round(ms));
    this.remainingMs = Math.max(0, this.phaseEndsAt - now);
    this.skipVisibleAt = 0;
    return true;
  }
  postpone() {
    if (!this.s.allowPostpone) return false;
    const isLong = this.kind === 'long';
    if ((isLong && this.s.strictLong) || (!isLong && this.s.strictMini)) return false;
    const ms = this.kind === 'long' ? this.s.postponeLongMs : this.s.postponeMiniMs;
    this.phase = 'focus'; this.phaseEndsAt = Date.now() + ms; this.postponesUsed++;
    return true;
  }
  // Additive snooze (clock +1m/+5m): pushes the current deadline back by ms.
  // 3:33 remaining + snooze(60s) => 4:33. Extends an active pause; delays a
  // focus/prebreak deadline; ignored mid-break (the clock is hidden then).
  snooze(ms) {
    const now = Date.now();
    if (this.phase === 'break') return false;
    if (now < this.pausedUntil) {
      this.pausedUntil += ms;
      this.phaseEndsAt += ms;
      this.remainingMs = this.pausedUntil - now;
    } else {
      this.phaseEndsAt += ms;
      this.remainingMs = Math.max(0, this.phaseEndsAt - now);
    }
    return true;
  }
  skip() {
    const isLong = this.kind === 'long';
    if (!this.s.allowSkip) return false;
    if ((isLong && this.s.strictLong) || (!isLong && this.s.strictMini)) return false;
    // Explicit user Skip always works once a break is showing. The old
    // skipVisibleAt time-gate silently vetoed early clicks (overlay hides Skip
    // for the first half, but home/clock/Ctrl+X are always clickable), which
    // read as a dead button. Keep skipVisibleAt only as a display hint.
    if (this.phase !== 'break') return false;
    this.phase = 'focus';
    this.phaseEndsAt = Date.now() + (this.kind === 'long' ? this.s.longIntervalFallbackMs || this.s.miniIntervalMs : this.s.miniIntervalMs);
    this.remainingMs = Math.max(0, this.phaseEndsAt - Date.now());
    this.skipVisibleAt = 0;
    return true;
  }
  // Explicit Finish: always ends the break, even in strict/manual modes.
  // Unlike skip(), this never returns false — the user said so.
  finishBreak() {
    this.phase = 'focus';
    this.phaseEndsAt = Date.now() + this.s.miniIntervalMs;
    this.remainingMs = Math.max(0, this.phaseEndsAt - Date.now());
    this.skipVisibleAt = 0;
    return true;
  }
  // Advance clock; returns list of transition events. Caller supplies guards.
  tick(now = Date.now(), guards = {}) {
    const evts = [];
    if (!this.s.enabled) return evts;
    if (now < this.pausedUntil) { this.remainingMs = this.pausedUntil - now; return evts; }
    if (guards.meeting) {
      // defer: push deadline forward by tick amount (simple, drift-free enough for v1)
      if (this.phase === 'focus') this.phaseEndsAt += (guards.tickMs || 1000);
      this.deferredReason = 'meeting';
      this.remainingMs = Math.max(0, this.phaseEndsAt - now);
      return evts;
    }
    this.deferredReason = null;
    this.remainingMs = Math.max(0, this.phaseEndsAt - now);
    if (this.phase === 'focus' && now >= this.phaseEndsAt) {
      const wantLong = this.s.longEnabled && (this.minisSinceLong + 1 >= this.s.longEvery);
      if (!wantLong && !this.s.miniEnabled) {
        // Mini breaks switched off: don't enter prebreak, just roll the
        // deadline to the next slot (long breaks still arrive on cadence).
        this.phaseEndsAt = now + this.s.miniIntervalMs;
        this.remainingMs = Math.max(0, this.phaseEndsAt - now);
        return evts;
      }
      this.kind = wantLong ? 'long' : 'mini';
      if (wantLong) this.minisSinceLong = 0; else this.minisSinceLong++;
      this.phase = 'prebreak';
      const pre = this.kind === 'long' ? this.s.preLongMs : this.s.preMiniMs;
      this.phaseEndsAt = now + pre;
      this.message = this.pickMessage(this.kind);
      evts.push({ type: 'prebreak', kind: this.kind });
    } else if (this.phase === 'prebreak' && now >= this.phaseEndsAt) {
      this.phase = 'break';
      const dur = this.kind === 'long' ? this.s.longDurationMs : this.s.miniDurationMs;
      this.phaseEndsAt = now + dur;
      this.skipVisibleAt = now + Math.min(60 * 1000, dur / 2);
      evts.push({ type: 'break-start', kind: this.kind });
    } else if (this.phase === 'break' && now >= this.phaseEndsAt && !this.s.manualFinish) {
      this.phase = 'focus';
      this.phaseEndsAt = now + this.s.miniIntervalMs;
      evts.push({ type: 'break-end', kind: this.kind });
    }
    this.remainingMs = Math.max(0, this.phaseEndsAt - now);
    return evts;
  }
}

module.exports = { FocusEngine, DEFAULTS, applyPreset, BREAK_IDEAS_MINI, BREAK_IDEAS_LONG };
