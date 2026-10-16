'use strict';
// On-disk rebrand migration (Task 4). Pure + testable: no Electron imports.
// Layout:
//   OLD: <userData>/settings-v3.json + <userData>/<old-notes-dir>/{notes.json,data.key}
//   NEW: <userData>/settings.json     + <userData>/notes/{notes.json,data.key}
// Rules: rename-not-copy, never overwrite an existing new path, idempotent,
// a failed move leaves the old layout working (caller falls back to old read).
const path = require('path');

const OLD_SETTINGS = 'settings-v3.json';
const NEW_SETTINGS = 'settings.json';
const OLD_NOTES = 'lookaway-notes-v3';
const NEW_NOTES = 'notes';

function migrateUserData(cur, fso) {
  const fs = fso || require('fs');
  try {
    if (!cur || !fs.existsSync(cur)) return { migrated: [] };
    const migrated = [];
    const oldS = path.join(cur, OLD_SETTINGS);
    const newS = path.join(cur, NEW_SETTINGS);
    if (!fs.existsSync(newS) && fs.existsSync(oldS)) {
      try { fs.renameSync(oldS, newS); migrated.push('settings'); } catch {}
    }
    const oldN = path.join(cur, OLD_NOTES);
    const newN = path.join(cur, NEW_NOTES);
    if (!fs.existsSync(newN) && fs.existsSync(oldN)) {
      try { fs.renameSync(oldN, newN); migrated.push('notes'); } catch {}
    }
    return { migrated };
  } catch { return { migrated: [] }; }
}

// Pre-rename app-folder carry-over: copy missing top-level entries only,
// top-level entries only, never overwrite. Then run the inner rebrand above.
function carryOverPrevAppDir(cur, prev, fso) {
  const fs = fso || require('fs');
  try {
    if (!prev || prev === cur || !fs.existsSync(prev)) return { copied: [] };
    fs.mkdirSync(cur, { recursive: true });
    const copied = [];
    for (const f of fs.readdirSync(prev)) {
      const src = path.join(prev, f);
      const dst = path.join(cur, f);
      if (fs.existsSync(dst)) continue;
      try {
        if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
        else fs.copyFileSync(src, dst);
        copied.push(f);
      } catch {}
    }
    return { copied };
  } catch { return { copied: [] }; }
}

// A registered login item in an UNPACKAGED run can only be the stale
// bare-Electron entry (dev runs never register since v1.0.0): opening it at
// sign-in shows the Electron demo window instead of Flinkynotes. Packaged
// runs must never touch the entry — it may belong to a valid install.
function shouldRemoveStaleLogin({ isPackaged, openAtLogin }) {
  return !isPackaged && !!openAtLogin;
}

module.exports = { OLD_SETTINGS, NEW_SETTINGS, OLD_NOTES, NEW_NOTES, migrateUserData, carryOverPrevAppDir, shouldRemoveStaleLogin };
