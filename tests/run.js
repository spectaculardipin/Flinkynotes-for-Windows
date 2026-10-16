// v2 tests — pure engines only (no Electron). Run: node tests/run.js
'use strict';
const assert = require('assert');
const { FocusEngine } = require('../src/main/focusEngine');
const { PomodoroEngine } = require('../src/main/pomodoroEngine');
const { healthScore, blankDay } = require('../src/main/wellness');
const { NudgeEngine } = require('../src/main/nudges');
const { isActiveNow } = require('../src/main/scheduleGuard');
const { shinglePitch, clampClockPos } = require('../src/main/geometry');
const { NOTE_SIZES, noteDims, isReusableEmpty } = require('../src/main/noteSizes');
const { unionZones, computeDeckBounds, fanPitch, restoreCenterY, rebaseContentY, decideDeckPlacement } = require('../src/main/deckLayout');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('ok - ' + name); }
  catch (e) { console.error('FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}

// TIMER.md invariant: ceil, never round (300000ms -> 5:00)
t('ceil-invariant', () => {
  const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  assert.strictEqual(fmt(300000), '5:00');
  assert.strictEqual(fmt(299400), '5:00'); // 299.4s IPC delay still 5:00
});

t('focus-reset-focus', () => {
  const e = new FocusEngine();
  assert.strictEqual(e.phase, 'focus');
});

t('focus-defer-preserves-counters', () => {
  const e = new FocusEngine();
  e.minisSinceLong = 2;
  e.phase = 'break'; e.kind = 'mini';
  e.deferNextBreak(60000);
  assert.strictEqual(e.phase, 'focus');
  assert.strictEqual(e.minisSinceLong, 2);
});

t('focus-snooze-additive', () => {
  const e = new FocusEngine({ miniIntervalMs: 600000 });
  e.reset();
  const before = e.phaseEndsAt;
  e.snooze(60000);
  assert.strictEqual(e.phaseEndsAt, before + 60000);
});

t('pomo-work-to-break', () => {
  const p = new PomodoroEngine({ enabled: true, workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, pomodorosPerCycle: 4 });
  p.startWork();
  p.remainingSec = 1;
  const ev = p.tick();
  assert.strictEqual(ev[0].type, 'pomodoro-work-done');
  assert.strictEqual(p.state, 'shortBreak');
});

t('pomo-long-every-4th', () => {
  const p = new PomodoroEngine({ enabled: true, pomodorosPerCycle: 4 });
  p.currentPomodoro = 4;
  p.startBreak();
  assert.strictEqual(p.state, 'longBreak');
});

t('health-score-formula', () => {
  const d = blankDay('2026-10-10');
  d.breaksSkipped = 2; d.breaksPostponed = 3; d.sessionLengths = [50];
  assert.strictEqual(healthScore(d), 100 - 10 - 3 - 3);
});

t('nudge-due-rearms', () => {
  const n = new NudgeEngine({ postureEnabled: true, postureIntervalMin: 30, blinkEnabled: false, customEnabled: false });
  n.postureNextAt = Date.now() - 1000;
  const due = n.due(Date.now());
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].kind, 'posture');
  assert.ok(n.postureNextAt > Date.now());
});

t('schedule-off-always-active', () => {
  assert.strictEqual(isActiveNow({ enabled: false }, new Date(2026, 9, 11, 3, 0)), true);
});

t('schedule-weekday-hours', () => {
  const s = { enabled: true, activeDays: [1, 2, 3, 4, 5], startHour: 9, startMinute: 0, endHour: 17, endMinute: 0 };
  const mon10 = new Date(2026, 9, 5, 10, 0); // Monday Oct 5 2026
  const sun10 = new Date(2026, 9, 11, 10, 0);
  assert.strictEqual(isActiveNow(s, mon10), true);
  assert.strictEqual(isActiveNow(s, sun10), false);
});

t('shingle-pitch-bounds', () => {
  assert.ok(shinglePitch(200) <= 106 && shinglePitch(0) >= 56);
});

t('clock-clamped-top-band', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const c = clampClockPos(5000, 5000, 280, 300, wa);
  assert.ok(c.y <= 120 && c.x <= wa.width - 280);
});

t('note-dims-default-classic', () => {
  assert.deepStrictEqual(noteDims('classic'), NOTE_SIZES.classic);
  assert.deepStrictEqual(noteDims('nope'), NOTE_SIZES.classic);
  assert.ok(NOTE_SIZES.compact.w < NOTE_SIZES.classic.w);
});

t('reuse-only-pristine-blanks', () => {
  assert.strictEqual(isReusableEmpty({ title: 'New note', archived: false }, ''), true);
  assert.strictEqual(isReusableEmpty({ title: 'could be us', archived: false }, ''), false);
  assert.strictEqual(isReusableEmpty({ title: 'New note', archived: false }, 'hello'), false);
  assert.strictEqual(isReusableEmpty({ title: 'New note', archived: true }, ''), false);
});

t('pomo-skip-context-aware', () => {
  const p = new PomodoroEngine({ enabled: true, workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, pomodorosPerCycle: 4 });
  p.startWork();
  assert.strictEqual(p.skip(), true);
  assert.strictEqual(p.state, 'shortBreak');
  assert.strictEqual(p.completedToday, 0); // skipped work is not counted
  assert.strictEqual(p.skip(), true);
  assert.strictEqual(p.state, 'work');
});

t('pomo-skip-from-pause', () => {
  const p = new PomodoroEngine({ enabled: true, workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, pomodorosPerCycle: 4 });
  p.startWork();
  p.pause();
  assert.strictEqual(p.skip(), true);
  assert.strictEqual(p.state, 'shortBreak');
  assert.strictEqual(p.completedToday, 0);
  p.pause();
  assert.strictEqual(p.skip(), true);
  assert.strictEqual(p.state, 'work');
});

t('pomo-idle-shows-work-length', () => {
  const p = new PomodoroEngine({ workMinutes: 25 });
  assert.strictEqual(p.status().state, 'idle');
  assert.strictEqual(p.status().remaining, '25:00');
});
t('pomo-start-opts-in', () => {
  const p = new PomodoroEngine({ enabled: false, workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, pomodorosPerCycle: 4 });
  p.startWork();
  assert.strictEqual(p.s.enabled, true);
  assert.strictEqual(p.state, 'work');
  p.remainingSec = 1;
  const ev = p.tick();
  assert.strictEqual(ev[0].type, 'pomodoro-work-done');
  assert.strictEqual(p.completedToday, 1);
});

t('pomo-paused-from', () => {
  const p = new PomodoroEngine({ enabled: true });
  p.startWork();
  p.pause();
  assert.strictEqual(p.status().state, 'paused');
  assert.strictEqual(p.status().pausedFrom, 'work');
  p.resume();
  assert.strictEqual(p.status().state, 'work');
  assert.strictEqual(p.status().pausedFrom, null);
});

t('wellness-sessions', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { WellnessStore } = require('../src/main/wellness');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'well-')), 'w.json');
  const w = new WellnessStore(f);
  w.pomodoroDone('s1');
  w.pomodoroDone(null);
  const t = w.today();
  assert.strictEqual(t.pomodoros, 2);
  assert.strictEqual(t.sessions.length, 2);
  assert.strictEqual(t.sessions[0].subject, 's1');
});

t('deck-union-ignores-tiny', () => {
  assert.strictEqual(unionZones(null), null);
  assert.strictEqual(unionZones([{ x: 0, y: 0, w: 1, h: 1 }]), null);
  const u = unionZones([{ x: 10, y: 20, w: 30, h: 40 }, { x: 50, y: 60, w: 10, h: 10 }]);
  assert.deepStrictEqual(u, { x: 10, y: 20, w: 50, h: 50 });
});

t('deck-empty-hides', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepStrictEqual(computeDeckBounds([], wa, {}), { visible: false });
});

t('deck-rest-centers-right-edge', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = computeDeckBounds([{ x: 1800, y: 500, w: 12, h: 100 }], wa, { center: true });
  assert.strictEqual(b.visible, true);
  assert.strictEqual(b.x + b.w, wa.x + wa.width); // glued to right edge
  assert.strictEqual(b.y, Math.round((wa.height - b.h) / 2)); // vertically centered
});

t('deck-same-zones-stable', () => {
  // Identical content must yield identical bounds (no resize storm).
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const z = [{ x: 1750, y: 300, w: 150, h: 400 }];
  const a = computeDeckBounds(z, wa, { center: true });
  const b = computeDeckBounds(z, wa, { center: false, prevBounds: a, prevContentY: a.contentY });
  assert.deepStrictEqual({ x: b.x, y: b.y, w: b.w, h: b.h }, { x: a.x, y: a.y, w: a.w, h: a.h });
});

t('deck-glue-tracks-content', () => {
  // Content grows upward by 50px: window must move up 50px so cards stay put.
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const a = computeDeckBounds([{ x: 1750, y: 400, w: 150, h: 300 }], wa, { center: true });
  const b = computeDeckBounds([{ x: 1750, y: 350, w: 150, h: 350 }], wa,
    { center: false, prevBounds: a, prevContentY: a.contentY });
  assert.strictEqual(b.y, a.y - 50);
});

t('deck-clamps-to-workarea', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 400 };
  const b = computeDeckBounds([{ x: 1750, y: 0, w: 150, h: 900 }], wa, { center: true });
  assert.ok(b.h <= wa.height && b.y >= wa.y && b.y + b.h <= wa.y + wa.height);
});

t('deck-fan-pitch-short-screen', () => {
  assert.ok(fanPitch(200, 5, 100000) <= 106 && fanPitch(0, 1, 100000) >= 56);
  assert.ok(fanPitch(200, 9, 300) < 56); // guard shrinks instead of overflowing
});

t('deck-restore-keeps-center', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  // Same center restored for a new height: no wake jump.
  assert.strictEqual(restoreCenterY(500, 300, wa), 350);
  assert.strictEqual(restoreCenterY(500, 300, wa) + 150, 500);
});

t('deck-restore-clamps', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 400 };
  const y = restoreCenterY(500, 300, wa); // center 500 impossible in 400px
  assert.ok(y >= wa.y && y + 300 <= wa.y + wa.height);
});

t('deck-rebase-keeps-center-stable', () => {  // The y136→y0 settle bug: center to 136 under the old origin, then glue
  // measured screen-space contentY from the PRE-move origin and re-applied
  // the move delta (-205), clamping to the top. Rebasing onto the applied
  // bounds keeps identical content glued to the centered position.
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const local = [{ x: 246, y: 0, w: 44, h: 135 }];
  const org = { x: 1512, y: 341, width: 24, height: 132 }; // pre-center origin
  const screen = local.map(r => ({ x: org.x + r.x, y: org.y + r.y, w: r.w, h: r.h }));
  const centered = computeDeckBounds(screen, wa, { center: true });
  const prevBounds = { x: centered.x, y: centered.y, w: centered.w, h: centered.h };
  const prevContentY = rebaseContentY(centered, unionZones(local).y);
  // Next pass, same content, window now AT the centered bounds:
  const org2 = { x: centered.x, y: centered.y, width: centered.w, height: centered.h };
  const screen2 = local.map(r => ({ x: org2.x + r.x, y: org2.y + r.y, w: r.w, h: r.h }));
  const tracked = computeDeckBounds(screen2, wa, { center: false, prevBounds, prevContentY });
  assert.strictEqual(tracked.y, centered.y); // stays — no parking at top
});

t('deck-policy-rest-centers', () => {
  assert.strictEqual(decideDeckPlacement({ stage: 'rest', crossing: true, sigChanged: true }), 'center');
});

t('deck-policy-wake-centers', () => {
  assert.strictEqual(decideDeckPlacement({ stage: 'fan', crossing: true, sigChanged: false }), 'center');
  assert.strictEqual(decideDeckPlacement({ stage: 'fan', crossing: true, sigChanged: true }), 'center');
});

t('deck-policy-structural-centers-flyout-glues', () => {
  // New note mid-fan recenters (symmetric growth, no downward push)…
  assert.strictEqual(decideDeckPlacement({ stage: 'fan', crossing: false, sigChanged: true }), 'center');
  // …while preview show/hide (same sig) glues so cards never jump.
  assert.strictEqual(decideDeckPlacement({ stage: 'preview', crossing: false, sigChanged: false }), 'glue');
  assert.strictEqual(decideDeckPlacement({ stage: 'fan', crossing: false, sigChanged: false }), 'glue');
});

t('brand-name-consistent', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const offenders = [];
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.agents' || e.name === '.claude') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (p === path.join(root, 'tasks')) continue; walk(p); }
      else if (/\.(js|html|css|json|md)$/.test(e.name)) {
        const rel = path.relative(root, p);
        if (rel === 'package-lock.json') continue;
        const txt = fs.readFileSync(p, 'utf8');
        const lines = txt.split('\n');
        lines.forEach((ln, i) => {
          if (/flicky/i.test(ln)) {
            const allowlisted = rel === path.join('src', 'main', 'main.js') && /LEGACY_APP_DIR/.test(ln);
            if (!allowlisted) offenders.push(`${rel}:${i + 1}:${ln.trim().slice(0, 120)}`);
          }
        });
      }
    }
  }
  ['src', 'docs'].forEach(d => walk(path.join(root, d)));
  for (const f of ['README.md', 'package.json']) {
    const p = path.join(root, f);
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    lines.forEach((ln, i) => {
      if (/flicky/i.test(ln)) offenders.push(`${f}:${i + 1}:${ln.trim().slice(0, 120)}`);
    });
  }
  assert.strictEqual(offenders.join('\n'), '', 'old brand references:\n' + offenders.join('\n'));
});

t('no-third-party-names', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  // Built from fragments so this guard's own source never contains the
  // banned words it scans for (self-hosting guard).
  const banned = new RegExp(['str' + 'etchly', 'look' + 'away', 'ch' + 'irp', 'no' + 'ty'].join('|'), 'i');
  const offenders = [];
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.agents' || e.name === '.claude') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (p === path.join(root, 'tasks')) continue; walk(p); }
      else if (/\.(js|html|css|json|md)$/.test(e.name)) {
        const rel = path.relative(root, p);
        if (rel === 'package-lock.json') continue;
        const txt = fs.readFileSync(p, 'utf8');
        txt.split('\n').forEach((ln, i) => {
          if (banned.test(ln)) {
            const allowlisted = rel === path.join('src', 'main', 'dataPaths.js') && /OLD_NOTES|OLD_SETTINGS/.test(ln);
            if (!allowlisted) offenders.push(`${rel}:${i + 1}:${ln.trim().slice(0, 120)}`);
          }
        });
      }
    }
  }
  ['src', 'docs'].forEach(d => walk(path.join(root, d)));
  // No version-history markers: the public tree must read as v1.0.0, never
  // as an earlier build or a rebuild diary. Fragment-built so this guard's
  // own source never contains the banned phrases (same idea as `banned`).
  const bannedHist = new RegExp([
    'V' + '3-DECK', 'v3-de' + 'ck', 'v3 sc' + 'ope', 'v3 prot' + 'ocol',
    'v3 starts fr' + 'esh', 'v2 well' + 'ness', 'v2-kil' + 'ler',
    'v2 feed' + 'back', 'Second bat' + 'ch', 'Third bat' + 'ch',
    'Fourth bat' + 'ch', 'Still v' + '2', 'unchanged from v' + '2',
    'rebuilds the note-de' + 'ck', 'clean-room rewrite on t' + 'op',
    'no v1/v' + '2', 'v1 les' + 'son', 'v2 fix' + 'es',
    'for v' + '1', 'kills the v' + '2',
  ].join('|'), 'i');
  function walkHist(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.agents' || e.name === '.claude') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (p === path.join(root, 'tasks')) continue; walkHist(p); }
      else if (/\.(js|html|css|json|md)$/.test(e.name)) {
        const rel = path.relative(root, p);
        if (rel === 'package-lock.json') continue;
        fs.readFileSync(p, 'utf8').split('\n').forEach((ln, i) => {
          if (bannedHist.test(ln)) offenders.push(`${rel}:${i + 1}:${ln.trim().slice(0, 120)}`);
        });
      }
    }
  }
  ['src', 'docs'].forEach(d => walkHist(path.join(root, d)));
  for (const f of ['README.md', 'package.json']) {
    const p = path.join(root, f);
    fs.readFileSync(p, 'utf8').split('\n').forEach((ln, i) => {
      if (bannedHist.test(ln)) offenders.push(`${f}:${i + 1}:${ln.trim().slice(0, 120)}`);
    });
  }
  for (const f of ['README.md', 'package.json']) {
    const p = path.join(root, f);
    fs.readFileSync(p, 'utf8').split('\n').forEach((ln, i) => {
      // Single documented exception: the README attribution stating this is an
      // open-source reimplementation (user-required wording). Matched with
      // fragment-built substrings so this guard source never contains the
      // allowed tokens (self-hosting, same idea as banned above).
      const lowLn = ln.toLowerCase();
      const attribution = f === 'README.md' && (lowLn.includes('open-source reimplementation') || lowLn.includes('look' + 'away.com') || lowLn.includes('hold' + 'mynotes'));
      if (banned.test(ln) && !attribution) offenders.push(`${f}:${i + 1}:${ln.trim().slice(0, 120)}`);
    });
  }
  // tests/ fixtures use OLD_* constants (no literals); the guard above is
  // fragment-built, so tests/run.js scans clean with no exemption needed.
  const selfTxt = fs.readFileSync(__filename, 'utf8');
  selfTxt.split('\n').forEach((ln, i) => {
    if (banned.test(ln) || bannedHist.test(ln)) offenders.push(`tests/run.js:${i + 1}:${ln.trim().slice(0, 120)}`);
  });
  assert.strictEqual(offenders.join('\n'), '', 'third-party references:\n' + offenders.join('\n'));
});

t('data-path-migration', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { migrateUserData, carryOverPrevAppDir, OLD_NOTES, OLD_SETTINGS } = require('../src/main/dataPaths');
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flinky-mig-'));
  // fresh install: nothing to migrate, no crash
  {
    const cur = mk();
    const r = migrateUserData(cur, fs);
    assert.deepStrictEqual(r.migrated, []);
  }
  // old-only profile: settings + notes dir both rename
  {
    const cur = mk();
    fs.writeFileSync(path.join(cur, OLD_SETTINGS), '{"a":1}');
    const oldN = path.join(cur, OLD_NOTES);
    fs.mkdirSync(oldN, { recursive: true });
    fs.writeFileSync(path.join(oldN, 'notes.json'), '{"version":1,"notes":[]}');
    fs.writeFileSync(path.join(oldN, 'data.key'), Buffer.alloc(32));
    const r = migrateUserData(cur, fs);
    assert.ok(r.migrated.includes('settings') && r.migrated.includes('notes'));
    assert.ok(fs.existsSync(path.join(cur, 'settings.json')));
    assert.ok(fs.existsSync(path.join(cur, 'notes', 'notes.json')));
    assert.ok(!fs.existsSync(path.join(cur, OLD_SETTINGS)));
    assert.ok(!fs.existsSync(oldN));
    // idempotent second run
    const r2 = migrateUserData(cur, fs);
    assert.deepStrictEqual(r2.migrated, []);
  }
  // both-present: never overwrite the new paths
  {
    const cur = mk();
    fs.writeFileSync(path.join(cur, 'settings.json'), '{"new":true}');
    fs.writeFileSync(path.join(cur, OLD_SETTINGS), '{"old":true}');
    const newN = path.join(cur, 'notes');
    const oldN = path.join(cur, OLD_NOTES);
    fs.mkdirSync(newN, { recursive: true });
    fs.mkdirSync(oldN, { recursive: true });
    fs.writeFileSync(path.join(newN, 'notes.json'), 'NEW');
    fs.writeFileSync(path.join(oldN, 'notes.json'), 'OLD');
    migrateUserData(cur, fs);
    assert.strictEqual(fs.readFileSync(path.join(cur, 'settings.json'), 'utf8'), '{"new":true}');
    assert.strictEqual(fs.readFileSync(path.join(newN, 'notes.json'), 'utf8'), 'NEW');
  }
  // partially-migrated: only the missing half moves
  {
    const cur = mk();
    fs.writeFileSync(path.join(cur, 'settings.json'), '{"new":true}');
    const oldN = path.join(cur, OLD_NOTES);
    fs.mkdirSync(oldN, { recursive: true });
    fs.writeFileSync(path.join(oldN, 'notes.json'), 'X');
    const r = migrateUserData(cur, fs);
    assert.deepStrictEqual(r.migrated, ['notes']);
    assert.ok(fs.existsSync(path.join(cur, 'notes', 'notes.json')));
  }
  // legacy app-dir carry-over composes with the inner rename
  {
    const base = mk();
    const prev = path.join(base, 'prev');
    const cur = path.join(base, 'cur');
    fs.mkdirSync(prev, { recursive: true });
    fs.writeFileSync(path.join(prev, OLD_SETTINGS), '{"p":1}');
    carryOverPrevAppDir(cur, prev, fs);
    migrateUserData(cur, fs);
    assert.ok(fs.existsSync(path.join(cur, 'settings.json')));
  }
});

t('preset-classic-migration', () => {
  const { applyPreset, DEFAULTS } = require('../src/main/focusEngine');
  assert.strictEqual(applyPreset('classic').preset, 'classic');
  assert.strictEqual(applyPreset('20-20-20').preset, '20-20-20');
  // pre-rename saved values (any unknown preset) fall back to classic
  assert.strictEqual(applyPreset('legacy-unknown-preset').preset, 'classic');
  assert.strictEqual(applyPreset(undefined).preset, 'classic');
  assert.strictEqual(DEFAULTS.preset, 'classic');
});

t('checklist-parse-serialize-roundtrip', () => {
  const C = require('../src/main/checklist');
  const bodies = [
    '',
    'plain line\nanother',
    '\u2610 buy milk\n\u2611 done task',
    '- [ ] dash open\n- [x] dash done',
    '  \u2610 indented\n\t- [X] tabbed',
    '\u2610\n\n\u2611 x\n   \nplain',
    '# Title\n\u2610 task under heading\nbody text',
  ];
  for (const b of bodies) {
    assert.strictEqual(C.serializeRows(C.parseRows(b)), b, JSON.stringify(b));
  }
});

t('checklist-count', () => {
  const C = require('../src/main/checklist');
  assert.deepStrictEqual(C.countTasks('a\nb'), { done: 0, total: 0 });
  assert.deepStrictEqual(C.countTasks('\u2610 a\n\u2611 b\n- [ ] c\n- [x] d\nplain'), { done: 2, total: 4 });
  assert.deepStrictEqual(C.countTasks('  \u2610 indented'), { done: 0, total: 1 });
});

t('checklist-toggle-line', () => {
  const C = require('../src/main/checklist');
  assert.strictEqual(C.toggleLine('\u2610 a\nplain', 0), '\u2611 a\nplain');
  assert.strictEqual(C.toggleLine('\u2611 a', 0), '\u2610 a');
  assert.strictEqual(C.toggleLine('- [ ] a', 0), '- [x] a');
  assert.strictEqual(C.toggleLine('- [x] a', 0), '- [ ] a');
  // non-task row becomes a task
  assert.strictEqual(C.toggleLine('plain', 0), '\u2610 plain');
  // out of range is a no-op
  assert.strictEqual(C.toggleLine('a', 5), 'a');
});

t('checklist-markdown-forms', () => {
  const C = require('../src/main/checklist');
  assert.strictEqual(C.isTaskLine('- [ ] x'), true);
  assert.strictEqual(C.isTaskLine('- [x] x'), true);
  assert.strictEqual(C.isTaskLine('- [X] x'), true);
  assert.strictEqual(C.isTaskLine('\u2610 x'), true);
  assert.strictEqual(C.isTaskLine('\u2611 x'), true);
  assert.strictEqual(C.isTaskLine('- x'), false);
  assert.strictEqual(C.stripDecorations('\u2610 buy milk'), 'buy milk');
  assert.strictEqual(C.stripDecorations('- [x] buy milk'), 'buy milk');
});

t('checklist-continuation-prefix', () => {
  const C = require('../src/main/checklist');
  assert.deepStrictEqual(C.continuationPrefix('plain'), { prefix: '', task: false, style: null });
  const p = C.continuationPrefix('\u2610 buy milk');
  assert.strictEqual(p.task, true);
  assert.ok(p.prefix.includes('\u2610'));
  const q = C.continuationPrefix('  - [x] done thing');
  assert.strictEqual(q.task, true);
  assert.ok(q.prefix.startsWith('  '));
  assert.ok(q.prefix.includes('- [ ]'));
});

t('checklist-insert-merge', () => {
  const C = require('../src/main/checklist');
  assert.strictEqual(C.insertLine('a\nc', 1, 'b'), 'a\nb\nc');
  let m = C.mergeLineUp('a\n\nc', 1);
  assert.strictEqual(m.text, 'a\nc');
  assert.strictEqual(m.row, 0);
  m = C.mergeLineUp('hello\nworld', 1);
  assert.strictEqual(m.text, 'hello world');
  m = C.mergeLineUp('\u2610 buy\nmilk', 1);
  assert.strictEqual(m.text, '\u2610 buy milk');
});

t('checklist-progress-parity', () => {
  const C = require('../src/main/checklist');
  const fixtures = [
    '',
    'plain',
    '\u2610 a\n\u2611 b\nplain\n- [ ] c',
    '# T\n  \u2610 indented\n- [X] upper',
  ];
  for (const b of fixtures) {
    const a = C.countTasks(b);
    // store uses the same module: parity is structural — serialize stability
    assert.strictEqual(C.serializeRows(C.parseRows(b)), b);
    assert.ok(a.total >= a.done && a.done >= 0);
  }
});

t('wellness-single-count', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { WellnessStore } = require('../src/main/wellness');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'well-count-')), 'w.json');
  const w = new WellnessStore(f);
  // One break end = exactly one taken; skip/postpone touch only their own.
  w.breakTaken();
  assert.strictEqual(w.today().breaksTaken, 1);
  w.breakSkipped();
  assert.strictEqual(w.today().breaksTaken, 1);
  assert.strictEqual(w.today().breaksSkipped, 1);
  w.breakPostponed();
  assert.strictEqual(w.today().breaksTaken, 1);
  assert.strictEqual(w.today().breaksPostponed, 1);
  // Finish path counts too (same method, one call per end).
  w.breakTaken();
  assert.strictEqual(w.today().breaksTaken, 2);
});

t('wellness-streak-rules', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { WellnessStore, dateKey, blankDay } = require('../src/main/wellness');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'well-streak-')), 'w.json');
  const w = new WellnessStore(f);
  const at = (daysAgo) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); return dateKey(d); };
  const qual = (k) => { const d = blankDay(k); d.breaksTaken = 2; return d; };
  // empty store: no streak
  assert.strictEqual(w.streak(), 0);
  // two qualifying days back-to-back: streak 2
  w._load().days[at(1)] = qual(at(1));
  w._load().days[at(2)] = qual(at(2));
  w._save();
  assert.strictEqual(w.streak(), 2);
  // today with a skip does not zero yesterday's run: still 2
  const t = blankDay(at(0)); t.breaksTaken = 1; t.breaksSkipped = 1;
  w._load().days[at(0)] = t;
  w._save();
  assert.strictEqual(w.streak(), 2);
  // today qualifying extends the run: 3
  const t2 = blankDay(at(0)); t2.breaksTaken = 1;
  w._load().days[at(0)] = t2;
  w._save();
  assert.strictEqual(w.streak(), 3);
});

t('wellness-live-screen-minutes', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { WellnessStore } = require('../src/main/wellness');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'well-live-')), 'w.json');
  const w = new WellnessStore(f);
  // live >= stored, even with zero history (no permanent 0m once time passes)
  w._sessionStart = Date.now() - 5 * 60000;
  const s = w.summary();
  assert.ok(s.screenLive >= (s.today.totalScreenMinutes || 0) + 5);
  // flush persists the session
  const before = w.today().totalScreenMinutes || 0;
  w.flushSession();
  assert.ok(w.today().totalScreenMinutes >= before);
});

t('deck-rest-boot-bounds', () => {
  const { restBootBounds } = require('../src/main/deckLayout');
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = restBootBounds(wa);
  // right-edge snapped, vertically centered, visible
  assert.strictEqual(b.x + b.w, wa.x + wa.width);
  assert.strictEqual(b.y, Math.round((wa.height - b.h) / 2));
  assert.ok(b.y >= wa.y && b.y + b.h <= wa.y + wa.height);
  // clamps to tiny work areas instead of overflowing
  const small = restBootBounds({ x: 0, y: 0, width: 200, height: 100 });
  assert.ok(small.h <= 100 && small.y >= 0 && small.y + small.h <= 100);
  assert.ok(small.w <= 200 && small.x + small.w <= 200);
});

t('removed-features-stay-removed', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const offenders = [];
  const srcFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html|css)$/.test(e.name)) srcFiles.push(p);
    }
  })(path.join(root, 'src'));
  const check = (rel, ln, i, re, allow) => {
    if (re.test(ln) && !(allow && allow.test(ln))) offenders.push(`${rel}:${i + 1}:${ln.trim().slice(0, 100)}`);
  };
  for (const p of srcFiles) {
    const rel = path.relative(root, p);
    fs.readFileSync(p, 'utf8').split('\n').forEach((ln, i) => {
      // Over full-screen: gone except the one startup prune in main.js
      check(rel, ln, i, /showOverFullscreen/, /for \(const k of \[/);
      // Dock side / left edge: gone everywhere
      check(rel, ln, i, /edge-left|Dock side|ds\.edge/);
      // Idle / exclusion machinery: gone everywhere (prune deleted the keys)
      check(rel, ln, i, /powerMonitor|pollExclusions|excludedRunning/);
    });
  }
  // Quick Capture: no trace left on Home (window + shortcut + IPC stay alive)
  const home = fs.readFileSync(path.join(root, 'src', 'renderer', 'home.html'), 'utf8');
  home.split('\n').forEach((ln, i) => {
    check('src/renderer/home.html', ln, i, /qCap|Quick [Cc]apture|openWindow\('capture'\)|Shift \+ Space/);
  });
  // Idle-guard keys: never in the engine or Home UI again
  for (const rel of ['src/main/focusEngine.js', 'src/renderer/home.html']) {
    fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((ln, i) => {
      check(rel, ln, i, /pauseWhileIdleMs|pauseDnd|pauseFullscreen/);
    });
  }
  assert.strictEqual(offenders.join('\n'), '', 'removed features resurfaced:\n' + offenders.join('\n'));
});

t('stale-login-removal-rule', () => {
  const { shouldRemoveStaleLogin } = require('../src/main/dataPaths');
  // unpackaged run with a registered item = stale bare-Electron entry: remove
  assert.strictEqual(shouldRemoveStaleLogin({ isPackaged: false, openAtLogin: true }), true);
  // packaged runs never touch the entry (may be a valid install entry)
  assert.strictEqual(shouldRemoveStaleLogin({ isPackaged: true, openAtLogin: true }), false);
  // nothing registered: no-op everywhere
  assert.strictEqual(shouldRemoveStaleLogin({ isPackaged: false, openAtLogin: false }), false);
  assert.strictEqual(shouldRemoveStaleLogin({ isPackaged: true, openAtLogin: false }), false);
});

t('checklist-preferred-view', () => {
  const C = require('../src/main/checklist');
  // explicit choice always wins
  assert.strictEqual(C.preferredView({ textMode: true, body: '\u2610 task' }), 'text');
  assert.strictEqual(C.preferredView({ textMode: false, body: 'plain' }), 'check');
  assert.strictEqual(C.preferredView({ textMode: true, body: '' }), 'text');
  // no choice yet: taskless non-empty body reads as plain text
  assert.strictEqual(C.preferredView({ body: 'just some words\nsecond line' }), 'text');
  // no choice yet: empty/whitespace bodies open the checklist (discoverable boxes)
  assert.strictEqual(C.preferredView({ body: '' }), 'check');
  assert.strictEqual(C.preferredView({ body: '   \n  ' }), 'check');
  assert.strictEqual(C.preferredView(null), 'check');
  // no choice yet: any task line means checklist
  assert.strictEqual(C.preferredView({ body: 'plain\n\u2610 buy milk' }), 'check');
  assert.strictEqual(C.preferredView({ body: '- [x] done' }), 'check');
});

console.log(`\n${pass} tests passed`);
