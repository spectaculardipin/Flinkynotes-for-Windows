// Local-only notes store: JSON file + AES-256-GCM encrypted bodies.
// 8 Paper colors (Paper/Dash/Ink triples).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { isReusableEmpty } = require('./noteSizes');

// Note palette (Paper/Dash/Ink triples)
const PALETTE = [
  { name: 'Lemon', paper: '#fce795', dash: '#e0ad08', ink: '#3a3008' },
  { name: 'Peach', paper: '#fbcfa6', dash: '#e2762a', ink: '#422413' },
  { name: 'Rose',  paper: '#fac4d1', dash: '#dc4570', ink: '#40161f' },
  { name: 'Lilac', paper: '#d9c7fa', dash: '#7c4dee', ink: '#2a1b44' },
  { name: 'Sky',   paper: '#beddfa', dash: '#2280d6', ink: '#13293a' },
  { name: 'Mint',  paper: '#b4e8d0', dash: '#0e9b6e', ink: '#0f2e23' },
  { name: 'Sand',  paper: '#e3d3b4', dash: '#a37b3c', ink: '#372c18' },
  { name: 'Slate', paper: '#cbd6e2', dash: '#4e6579', ink: '#1a242e' },
];
const COLORS = PALETTE.map(c => c.paper);

function oldUserDir() {
  try {
    const { OLD_NOTES } = require('./dataPaths');
    return path.join(app.getPath('userData'), OLD_NOTES);
  } catch { return null; }
}
function userDir() {
  return path.join(app.getPath('userData'), 'notes');
}
function ensureDir() {
  const d = userDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function keyPath() { return path.join(ensureDir(), 'data.key'); }
function dbPath() { return path.join(ensureDir(), 'notes.json'); }

function loadOrCreateKey() {
  const kp = keyPath();
  if (fs.existsSync(kp)) {
    const k = fs.readFileSync(kp);
    if (k.length === 32) return k;
  }
  // Failed-move fallback: old layout still has the key — reuse it so notes
  // stay decryptable, then persist to the new path on next save.
  try {
    const od = oldUserDir();
    const okp = od ? path.join(od, 'data.key') : null;
    if (okp && fs.existsSync(okp)) {
      const k = fs.readFileSync(okp);
      if (k.length === 32) { try { fs.writeFileSync(kp, k, { mode: 0o600 }); } catch {} return k; }
    }
  } catch {}
  const k = crypto.randomBytes(32);
  fs.writeFileSync(kp, k, { mode: 0o600 });
  return k;
}

function enc(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `gcm1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}
function dec(key, payload) {
  const [v, ivb, tagb, ctb] = String(payload).split('.');
  if (v !== 'gcm1') throw new Error('bad envelope');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64'));
  d.setAuthTag(Buffer.from(tagb, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctb, 'base64')), d.final()]).toString('utf8');
}

function blankDb() { return { version: 1, notes: [] }; }
function loadRaw() {
  try {
    if (fs.existsSync(dbPath())) return JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
    // Failed-move fallback: read the old DB so notes never read as empty.
    try {
      const od = oldUserDir();
      const odb = od ? path.join(od, 'notes.json') : null;
      if (odb && fs.existsSync(odb)) return JSON.parse(fs.readFileSync(odb, 'utf8'));
    } catch {}
    return blankDb();
  } catch { return blankDb(); }
}
function saveRaw(db) {
  ensureDir();
  const tmp = dbPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, dbPath());
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}
function nowIso() { return new Date().toISOString(); }
function titleOf(body) {
  const line = String(body || '').split('\n').map(s => s.trim()).find(Boolean) || 'New note';
  return line.replace(/^#+\s*/, '').slice(0, 80);
}
function tagsOf(body) {
  const m = String(body || '').match(/#[\p{L}\p{N}_-]+/gu);
  return m ? [...new Set(m.map(t => t.slice(1).toLowerCase()))].slice(0, 12) : [];
}
function progressOf(body) {
  try {
    return require('./checklist').countTasks(body);
  } catch {
    return { done: 0, total: 0 };
  }
}

const store = {
  COLORS, PALETTE,
  list({ includeArchived = true, query = '', filter = 'all' } = {}) {
    const key = loadOrCreateKey();
    const db = loadRaw();
    let notes = db.notes.map(n => {
      let body = '';
      try { body = dec(key, n.bodyEnc); } catch { body = ''; }
      return { ...n, body, ...progressOf(body) };
    });
    notes.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt > a.updatedAt ? 1 : -1));
    if (filter === 'active') notes = notes.filter(n => !n.archived);
    if (filter === 'archived') notes = notes.filter(n => n.archived);
    if (!includeArchived && filter === 'all') notes = notes.filter(n => !n.archived);
    if (query) {
      const q = query.toLowerCase();
      notes = notes.filter(n =>
        n.title.toLowerCase().includes(q) ||
        n.tags.join(' ').includes(q) ||
        n.body.toLowerCase().includes(q));
    }
    return notes;
  },
  create({ body = '', color } = {}) {
    const key = loadOrCreateKey();
    const db = loadRaw();
    const b = body || '';
    // Reuse a pristine blank instead of stacking identical empties — but only
    // untitled ones. A note the user already titled is real, even with an
    // empty body (otherwise "+" keeps reopening the most recent note).
    if (!b.trim() && !color) {
      const empty = db.notes.find(n => {
        let bb = '';
        try { bb = dec(key, n.bodyEnc); } catch { bb = ''; }
        return isReusableEmpty(n, bb);
      });
      if (empty) {
        let ebody = '';
        try { ebody = dec(key, empty.bodyEnc); } catch { ebody = ''; }
        return { ...empty, body: ebody, ...progressOf(ebody) };
      }
    }
    const n = {
      id: uid(), title: titleOf(b), tags: tagsOf(b),
      color: color || COLORS[db.notes.length % COLORS.length],
      bodyEnc: enc(key, b), archived: false, pinned: false,
      createdAt: nowIso(), updatedAt: nowIso(), order: Date.now()
    };
    db.notes.push(n);
    saveRaw(db);
    return { ...n, body: b, done: 0, total: 0 };
  },
  update(id, patch) {
    const key = loadOrCreateKey();
    const db = loadRaw();
    const n = db.notes.find(x => x.id === id);
    if (!n) return null;
    if (patch.body !== undefined) {
      n.bodyEnc = enc(key, patch.body);
      n.tags = tagsOf(patch.body);
      if (patch.title === undefined && (!n.title || n.title === 'New note')) {
        n.title = titleOf(patch.body);
      }
    }
    for (const k of ['color', 'archived', 'pinned', 'order', 'title', 'todoMode', 'textMode']) {
      if (k === 'title' && patch[k] === undefined) continue;
      if (patch[k] !== undefined) n[k] = patch[k];
    }
    n.updatedAt = nowIso();
    saveRaw(db);
    let body = patch.body !== undefined ? patch.body : dec(key, n.bodyEnc);
    return { ...n, body, ...progressOf(body) };
  },
  remove(id) {
    const db = loadRaw();
    db.notes = db.notes.filter(x => x.id !== id);
    saveRaw(db);
  },
  get(id) {
    const key = loadOrCreateKey();
    const db = loadRaw();
    const n = db.notes.find(x => x.id === id);
    if (!n) return null;
    let body = '';
    try { body = dec(key, n.bodyEnc); } catch { body = ''; }
    return { ...n, body, ...progressOf(body) };
  },
  restore(snapshot) {
    if (!snapshot || !snapshot.id) return null;
    const db = loadRaw();
    if (db.notes.some(x => x.id === snapshot.id)) return this.get(snapshot.id);
    const keep = ['id', 'title', 'tags', 'color', 'archived', 'pinned', 'createdAt', 'updatedAt', 'order', 'todoMode', 'textMode'];
    const clean = {};
    for (const k of keep) if (snapshot[k] !== undefined) clean[k] = snapshot[k];
    clean.bodyEnc = enc(loadOrCreateKey(), snapshot.body ?? '');
    db.notes.push(clean);
    saveRaw(db);
    return this.get(snapshot.id);
  },
  reorder(ids) {
    const db = loadRaw();
    const pos = new Map(ids.map((id, i) => [id, i]));
    db.notes.forEach(n => { if (pos.has(n.id)) n.order = pos.get(n.id); });
    db.notes.sort((a, b) => a.order - b.order);
    saveRaw(db);
  },
  exportAll(kind = 'json') {
    const notes = this.list({ includeArchived: true });
    const dir = ensureDir();
    if (kind === 'single') {
      const md = notes.map(n => `# ${n.title}\n\n${n.body}\n\n---\n`).join('\n');
      const p = path.join(dir, 'flinkynotes-notes.md');
      fs.writeFileSync(p, md);
      return p;
    }
    if (kind === 'json') {
      const p = path.join(dir, 'flinkynotes.stickynotes.json');
      fs.writeFileSync(p, JSON.stringify({ app: 'flinkynotes', version: 1, exportedAt: nowIso(), notes }, null, 2));
      return p;
    }
    const out = path.join(dir, `export-${kind}-${Date.now()}`);
    fs.mkdirSync(out, { recursive: true });
    notes.forEach((n, i) => {
      const safe = (n.title || 'note').replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || `note-${i}`;
      let content = n.body;
      if (kind === 'md') {
        content = content.replace(/^☐/gm, '- [ ]').replace(/^☑/gm, '- [x]');
        content = `---\ntitle: ${JSON.stringify(n.title)}\ncolor: ${n.color}\narchived: ${n.archived}\ncreated: ${n.createdAt}\n---\n\n${content}\n`;
      }
      fs.writeFileSync(path.join(out, `${safe}.${kind}`), content);
    });
    return out;
  },
  importFiles(filePaths) {
    let count = 0;
    const db = loadRaw();
    for (const fp of filePaths || []) {
      try {
        const raw = fs.readFileSync(fp, 'utf8');
        if (fp.endsWith('.stickies.json') || fp.endsWith('.stickynotes.json')) {
          const j = JSON.parse(raw);
          for (const n of j.notes || []) {
            db.notes.push({
              id: uid(), title: n.title || titleOf(n.body || ''), tags: n.tags || tagsOf(n.body || ''),
              color: n.color || COLORS[0], bodyEnc: enc(loadOrCreateKey(), n.body || ''),
              archived: !!n.archived, pinned: !!n.pinned, createdAt: n.createdAt || nowIso(),
              updatedAt: nowIso(), order: Date.now(), textMode: !!n.textMode
            });
            count++;
          }
        } else {
          let body = raw.replace(/^- \[ \]/gm, '☐').replace(/^- \[[xX]\]/gm, '☑');
          body = body.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
          db.notes.push({
            id: uid(), title: titleOf(body), tags: tagsOf(body), color: COLORS[db.notes.length % COLORS.length],
            bodyEnc: enc(loadOrCreateKey(), body), archived: false, pinned: false,
            createdAt: nowIso(), updatedAt: nowIso(), order: Date.now()
          });
          count++;
        }
      } catch { /* skip bad file */ }
    }
    saveRaw(db);
    return count;
  }
};

module.exports = { store, COLORS, PALETTE };
