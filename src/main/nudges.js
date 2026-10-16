// Nudges: posture + blink + custom reminders. Pure scheduler —
// main.js polls due() every 30s and shows a Notification / pill.
const crypto = require('crypto');

const NUDGE_DEFAULTS = {
  postureEnabled: true,
  postureIntervalMin: 30,
  blinkEnabled: true,
  blinkIntervalMin: 10,
  customEnabled: true,
};

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex');
}

const PRESETS = [
  { name: 'Drink water', message: 'Have a glass of water.', intervalMinutes: 60 },
  { name: 'Stretch', message: 'Stand up and stretch for a minute.', intervalMinutes: 90 },
  { name: 'Unclench', message: 'Drop your shoulders, unclench your jaw.', intervalMinutes: 45 },
];

class NudgeEngine {
  constructor(settings = {}) {
    this.s = { ...NUDGE_DEFAULTS, ...settings };
    // custom: [{ id, name, message, intervalMinutes, enabled, nextAt }]
    this.custom = (settings.custom || []).map(r => ({ ...r, nextAt: r.nextAt || Date.now() + r.intervalMinutes * 60000 }));
    this.postureNextAt = Date.now() + this.s.postureIntervalMin * 60000;
    this.blinkNextAt = Date.now() + this.s.blinkIntervalMin * 60000;
  }
  configure(patch) {
    this.s = { ...this.s, ...patch };
    if (patch.custom) {
      this.custom = patch.custom.map(r => ({ ...r, nextAt: r.nextAt || Date.now() + r.intervalMinutes * 60000 }));
    }
  }
  addCustom({ name, message, intervalMinutes }) {
    const r = { id: uid(), name, message, intervalMinutes: Math.max(1, intervalMinutes | 0), enabled: true, nextAt: Date.now() + Math.max(1, intervalMinutes | 0) * 60000 };
    this.custom.push(r);
    return r;
  }
  updateCustom(id, patch) {
    const r = this.custom.find(x => x.id === id);
    if (!r) return null;
    Object.assign(r, patch);
    if (patch.intervalMinutes) r.nextAt = Date.now() + Math.max(1, patch.intervalMinutes | 0) * 60000;
    return r;
  }
  removeCustom(id) { this.custom = this.custom.filter(x => x.id !== id); }
  snooze(kind, ms) {
    const now = Date.now();
    if (kind === 'posture') this.postureNextAt = now + ms;
    else if (kind === 'blink') this.blinkNextAt = now + ms;
  }
  // Returns [{ kind: 'posture'|'blink'|'custom', title, body, id? }] and re-arms.
  due(now = Date.now()) {
    const out = [];
    if (this.s.postureEnabled && now >= this.postureNextAt) {
      out.push({ kind: 'posture', title: 'Posture check', body: 'Sit tall — shoulders back, chin level. Roll your neck once.' });
      this.postureNextAt = now + Math.max(1, this.s.postureIntervalMin) * 60000;
    }
    if (this.s.blinkEnabled && now >= this.blinkNextAt) {
      out.push({ kind: 'blink', title: 'Blink break', body: 'Blink fully 10 times — you blink 66% less at screens.' });
      this.blinkNextAt = now + Math.max(1, this.s.blinkIntervalMin) * 60000;
    }
    if (this.s.customEnabled) {
      for (const r of this.custom) {
        if (!r.enabled) continue;
        if (now >= (r.nextAt || 0)) {
          out.push({ kind: 'custom', id: r.id, title: r.name, body: r.message });
          r.nextAt = now + Math.max(1, r.intervalMinutes | 0) * 60000;
        }
      }
    }
    return out;
  }
  serialize() {
    return { ...this.s, custom: this.custom };
  }
}

module.exports = { NudgeEngine, NUDGE_DEFAULTS, PRESETS };
