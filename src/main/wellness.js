// Wellness: daily stats + health score. Pure logic over a JSON file.
const fs = require('fs');
const path = require('path');

function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function blankDay(date) {
  return {
    date, breaksTaken: 0, breaksSkipped: 0, breaksPostponed: 0,
    pomodoros: 0, postureTaken: 0, customTaken: 0,
    totalScreenMinutes: 0, longestSessionMinutes: 0, sessionLengths: [],
    sessions: [], // completed pomodoros: [{ t: epochMs, subject: id|null }]
  };
}

// Health score: 100 minus penalties for skipped/postponed breaks and long sessions.
function healthScore(d) {
  let score = 100;
  score -= (d.breaksSkipped || 0) * 5;
  score -= (d.breaksPostponed || 0) * 1;
  for (const len of d.sessionLengths || []) {
    if (len > 40) score -= 3;
  }
  return Math.max(0, Math.min(100, score));
}

function medianSession(d) {
  const arr = [...(d.sessionLengths || [])].sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? Math.floor((arr[mid - 1] + arr[mid]) / 2) : arr[mid];
}

class WellnessStore {
  constructor(file) {
    this.file = file;
    this._data = null;
    this._sessionStart = Date.now();
  }
  _load() {
    if (this._data) return this._data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._data = raw && typeof raw === 'object' ? raw : { days: {} };
    } catch { this._data = { days: {} }; }
    if (!this._data.days) this._data.days = {};
    return this._data;
  }
  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {}
  }
  today() {
    const d = this._load();
    const k = dateKey();
    if (!d.days[k]) { d.days[k] = blankDay(k); this._save(); }
    const t = d.days[k];
    if (!Array.isArray(t.sessions)) t.sessions = []; // pre-session records
    return t;
  }
  _touch(kind) {
    const d = this._load();
    const k = dateKey();
    if (!d.days[k]) d.days[k] = blankDay(k);
    const t = d.days[k];
    t[kind] = (t[kind] || 0) + 1;
    this._save();
    return t;
  }
  _recordSession(t) {
    const mins = Math.floor((Date.now() - this._sessionStart) / 60000);
    if (mins > 0) {
      t.sessionLengths.push(mins);
      t.totalScreenMinutes += mins;
      if (mins > t.longestSessionMinutes) t.longestSessionMinutes = mins;
    }
    this._sessionStart = Date.now();
  }
  breakTaken() { const t = this._touch('breaksTaken'); this._recordSession(t); this._save(); return t; }
  breakSkipped() { return this._touch('breaksSkipped'); }
  breakPostponed() { return this._touch('breaksPostponed'); }
  pomodoroDone(subjectId) {
    const t = this._touch('pomodoros');
    if (!Array.isArray(t.sessions)) t.sessions = [];
    t.sessions.push({ t: Date.now(), subject: subjectId || null });
    this._save();
    return t;
  }
  postureTaken() { return this._touch('postureTaken'); }
  customTaken() { return this._touch('customTaken'); }
  week() {
    const d = this._load();
    const out = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(now);
      dt.setDate(now.getDate() - i);
      const k = dateKey(dt);
      out.push(d.days[k] || blankDay(k));
    }
    return out;
  }
  // Raw day map for range reports (pomoStats in main.js). Keys are yyyy-MM-dd.
  daysMap() { return this._load().days || {}; }
  streak() {
    // Streak = consecutive qualifying days (taken > 0, skipped == 0).
    // Today never zeroes a qualifying run: if today is not itself qualifying
    // (empty, or tainted by a skip), counting starts at yesterday.
    const d = this._load();
    let cursor = new Date();
    const tk = dateKey(cursor);
    const today = d.days[tk];
    if (!today || !(today.breaksTaken > 0 && today.breaksSkipped === 0)) {
      cursor.setDate(cursor.getDate() - 1);
    }
    let s = 0;
    for (let i = 0; i < 365; i++) {
      const st = d.days[dateKey(cursor)];
      if (st && st.breaksTaken > 0 && st.breaksSkipped === 0) {
        s++;
        cursor.setDate(cursor.getDate() - 1);
      } else break;
    }
    return s;
  }
  summary() {
    const t = this.today();
    return {
      today: t,
      score: healthScore(t),
      medianSession: medianSession(t),
      streak: this.streak(),
      screenLive: (t.totalScreenMinutes || 0) + Math.floor((Date.now() - this._sessionStart) / 60000),
      week: this.week().map(x => ({ date: x.date, taken: x.breaksTaken, skipped: x.breaksSkipped, score: healthScore(x) })),
    };
  }
  // Persist the current (partial) session — called on quit so the final
  // session is never lost. Repeated calls within the same minute are cheap.
  flushSession() {
    try {
      const t = this.today();
      this._recordSession(t);
      this._save();
    } catch {}
  }
}

module.exports = { WellnessStore, healthScore, dateKey, blankDay };
