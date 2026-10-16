// Tiny atomic JSON key/value store.
// Replaces electron-store: v10 ships ESM only, which `require()` cannot load from
// this CommonJS main process (Electron 33 = Node 20.18, no require(esm)). The old
// code swallowed that error and silently fell back to a no-op, which meant every
// preference — break intervals, deck side, autostart — reset on every launch.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class JsonStore {
  constructor({ name = 'settings' } = {}) {
    this.file = path.join(app.getPath('userData'), `${name}.json`);
    this._data = null;
  }

  _load() {
    if (this._data) return this._data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      this._data = {};
    }
    return this._data;
  }

  get(key, fallback) {
    const d = this._load();
    return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : fallback;
  }

  set(key, value) {
    const d = this._load();
    d[key] = value;
    this._save();
  }

  delete(key) {
    const d = this._load();
    delete d[key];
    this._save();
  }

  get store() {
    return { ...this._load() };
  }

  // Write to a temp file then rename, so a crash mid-save can't corrupt prefs.
  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // Losing one settings write must never take down the tray app.
    }
  }
}

module.exports = { JsonStore };
