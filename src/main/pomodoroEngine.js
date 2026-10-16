// Pomodoro engine — pure logic, no Electron deps (unit-testable).
const STATES = { WORK: 'work', SHORT: 'shortBreak', LONG: 'longBreak', PAUSED: 'paused', IDLE: 'idle' };

const DEFAULTS = {
  enabled: false,
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  pomodorosPerCycle: 4,
  subjects: [], // [{ id, name, color }]
  currentSubjectId: null,
};

function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

class PomodoroEngine {
  constructor(settings = {}) {
    this.s = { ...DEFAULTS, ...settings };
    this.state = STATES.IDLE;
    this.stateBeforePause = null;
    this.remainingSec = 0;
    this.totalSec = 0;
    this.currentPomodoro = 1;
    this.completedToday = 0;
    this.completedDate = new Date().toDateString();
  }
  configure(patch) { this.s = { ...this.s, ...patch }; }
  _rollDay() {
    const today = new Date().toDateString();
    if (this.completedDate !== today) { this.completedDate = today; this.completedToday = 0; }
  }
  startWork() {
    this._rollDay();
    // Pressing start IS opting in: a disabled master must never leave the
    // timer frozen after an explicit start (the "pomodoro isn't running" bug).
    this.s.enabled = true;
    this.state = STATES.WORK;
    this.totalSec = Math.max(60, Math.round(this.s.workMinutes * 60));
    this.remainingSec = this.totalSec;
  }
  startBreak() {
    this.s.enabled = true;
    const isLong = this.currentPomodoro >= this.s.pomodorosPerCycle;
    this.state = isLong ? STATES.LONG : STATES.SHORT;
    const mins = isLong ? this.s.longBreakMinutes : this.s.shortBreakMinutes;
    this.totalSec = Math.max(60, Math.round(mins * 60));
    this.remainingSec = this.totalSec;
  }
  pause() {
    if (this.state === STATES.PAUSED || this.state === STATES.IDLE) return;
    this.stateBeforePause = this.state;
    this.state = STATES.PAUSED;
  }
  resume() {
    if (this.state !== STATES.PAUSED) return;
    this.state = this.stateBeforePause || STATES.WORK;
    this.stateBeforePause = null;
  }
  reset() {
    this.state = STATES.IDLE;
    this.stateBeforePause = null;
    this.remainingSec = 0;
    this.totalSec = 0;
    this.currentPomodoro = 1;
  }
  skipBreak() {
    if (this.state !== STATES.SHORT && this.state !== STATES.LONG) return false;
    this._completeBreak();
    return true;
  }
  // Context-aware skip for the Home buttons: mid-work it jumps to the break
  // (without counting a pomodoro), mid-break it jumps to the next work block,
  // and mid-pause it follows whatever was paused.
  skip() {
    if (this.state === STATES.WORK) {
      this.startBreak();
      return true;
    }
    if (this.state === STATES.PAUSED) {
      const was = this.stateBeforePause;
      this.stateBeforePause = null;
      if (was === STATES.WORK) {
        this.startBreak();
        return true;
      }
      if (was === STATES.SHORT || was === STATES.LONG) {
        this.state = was;
        return this.skipBreak();
      }
      return false;
    }
    return this.skipBreak();
  }
  // Advance one second. Returns events: [] | ['work-done'] | ['break-done']
  tick() {
    this._rollDay();
    if (!this.s.enabled) return [];
    if (this.state !== STATES.WORK && this.state !== STATES.SHORT && this.state !== STATES.LONG) return [];
    this.remainingSec = Math.max(0, this.remainingSec - 1);
    if (this.remainingSec > 0) return [];
    if (this.state === STATES.WORK) {
      this.completedToday++;
      this.startBreak();
      return [{ type: 'pomodoro-work-done' }];
    }
    this._completeBreak();
    return [{ type: 'pomodoro-break-done' }];
  }
  _completeBreak() {
    if (this.currentPomodoro >= this.s.pomodorosPerCycle) this.currentPomodoro = 1;
    else this.currentPomodoro++;
    this.startWork();
  }
  status() {
    // Idle shows the configured work length (25:00), not 00:00, so Reset
    // lands on something meaningful.
    const idle = this.state === STATES.IDLE;
    const dispTotal = idle ? Math.max(60, Math.round(this.s.workMinutes * 60)) : this.totalSec;
    const dispRem = idle ? dispTotal : this.remainingSec;
    return {
      state: this.state,
      pausedFrom: this.stateBeforePause,
      remainingSec: this.remainingSec,
      totalSec: this.totalSec,
      remaining: fmtClock(dispRem),
      progress: dispTotal > 0 ? 1 - dispRem / dispTotal : 0,
      currentPomodoro: this.currentPomodoro,
      totalPomodoros: this.s.pomodorosPerCycle,
      completedToday: this.completedToday,
      // What a paused session was doing — Home shows Skip break only when
      // the pause happened mid-break.
      pausedFrom: this.state === STATES.PAUSED ? this.stateBeforePause : null,
    };
  }
}

module.exports = { PomodoroEngine, POMO_DEFAULTS: DEFAULTS, POMO_STATES: STATES, pomoFmt: fmtClock };
