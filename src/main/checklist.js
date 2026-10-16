'use strict';
// Checklist pure module (Task 9a). Shared by notesStore (counts) and the
// editor renderer (rows) so done/total can never disagree.
// Storage stays plain text: task lines lead with U+2610/U+2611 or
// "- [ ]"/"- [x]" (import form). Every line is a row, task or not.
// UMD-guarded: requireable in main/tests and <script>-includable in editor.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Checklist = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // Task-line matchers (indent-preserving).
  const BOX_RE = /^(\s*)([\u2610\u2611])([ \t]?(.*))$/;
  const DASH_RE = /^(\s*)-\s\[([ xX])\]([ \t]?(.*))$/;

  function parseLine(line) {
    const s = String(line == null ? '' : line);
    let m = s.match(BOX_RE);
    if (m) {
      return {
        task: true, done: m[2] === '\u2611', style: 'box',
        indent: m[1] || '', content: (m[3] || '').replace(/^[ \t]/, ''),
        raw: s,
      };
    }
    m = s.match(DASH_RE);
    if (m) {
      return {
        task: true, done: m[2] === 'x' || m[2] === 'X', style: 'dash',
        bigX: m[2] === 'X',
        indent: m[1] || '', content: (m[3] || '').replace(/^[ \t]/, ''),
        raw: s,
      };
    }
    return { task: false, done: false, style: null, indent: '', content: s, raw: s };
  }

  function serializeRow(r) {
    if (!r || !r.task) return r ? String(r.raw != null ? r.raw : (r.content || '')) : '';
    const marker = r.style === 'dash' ? (r.done ? (r.bigX ? '- [X]' : '- [x]') : '- [ ]') : (r.done ? '\u2611' : '\u2610');
    return `${r.indent || ''}${marker}${r.content ? ' ' + String(r.content).replace(/^\s+/, '') : ''}`;
  }

  function parseRows(text) {
    return String(text == null ? '' : text).split('\n').map(parseLine);
  }

  function serializeRows(rows) {
    return (rows || []).map(serializeRow).join('\n');
  }

  function isTaskLine(line) {
    return parseLine(line).task;
  }

  function countTasks(text) {
    let done = 0, total = 0;
    for (const r of parseRows(text)) {
      if (r.task) { total++; if (r.done) done++; }
    }
    return { done, total };
  }

  function toggleLine(text, i) {
    const rows = parseRows(text);
    if (i < 0 || i >= rows.length) return String(text == null ? '' : text);
    const r = rows[i];
    if (!r.task) {
      rows[i] = { task: true, done: false, style: 'box', indent: '', content: r.raw, raw: r.raw };
    } else {
      r.done = !r.done;
    }
    return serializeRows(rows);
  }

  function setTaskAt(text, i, task, done) {
    const rows = parseRows(text);
    if (i < 0 || i >= rows.length) return String(text == null ? '' : text);
    const r = rows[i];
    if (!task) {
      rows[i] = { task: false, done: false, style: null, indent: '', content: r.raw, raw: serializeRow(r) };
      rows[i].raw = serializeRow(r);
    } else {
      rows[i] = {
        task: true, done: !!done, style: r.style || 'box',
        indent: r.indent || '', content: r.task ? r.content : r.raw, raw: r.raw,
      };
    }
    return serializeRows(rows);
  }

  // Enter continuation: a new row below inherits task-ness + style, fresh
  // (unchecked) so checking stays explicit. Returns the prefix to insert.
  function continuationPrefix(line) {
    const r = parseLine(line);
    if (!r.task) return { prefix: '', task: false, style: null };
    const marker = r.style === 'dash' ? '- [ ]' : '\u2610';
    return { prefix: `${r.indent || ''}${marker} `, task: true, style: r.style };
  }

  function insertLine(text, idx, newText) {
    const lines = String(text == null ? '' : text).split('\n');
    const at = Math.max(0, Math.min(idx, lines.length));
    lines.splice(at, 0, String(newText == null ? '' : newText));
    return lines.join('\n');
  }

  // Backspace at row start: empty rows delete; otherwise the row's content
  // joins the previous line (single space when both sides non-empty).
  // Returns { text, row } with the new caret row.
  function mergeLineUp(text, idx) {
    const lines = String(text == null ? '' : text).split('\n');
    if (idx <= 0 || idx >= lines.length) return { text: lines.join('\n'), row: idx };
    const cur = parseLine(lines[idx]);
    const curContent = cur.task ? cur.content : cur.raw;
    if (!String(curContent).trim()) {
      lines.splice(idx, 1);
      return { text: lines.join('\n'), row: idx - 1 };
    }
    const prev = lines[idx - 1];
    const join = prev && String(curContent) ? `${prev} ${String(curContent).trimStart()}` : (prev + String(curContent));
    lines.splice(idx - 1, 2, join);
    return { text: lines.join('\n'), row: idx - 1 };
  }

  function stripDecorations(line) {
    return parseLine(line).content;
  }

  // Which editor view a note should open in. An explicit toggle choice
  // (textMode) always wins; otherwise a taskless non-empty body reads as
  // plain text, while empty bodies and bodies with tasks open the checklist.
  function preferredView(note) {
    if (note && note.textMode === true) return 'text';
    if (note && note.textMode === false) return 'check';
    const body = String((note && note.body) || '');
    if (body.trim() !== '' && countTasks(body).total === 0) return 'text';
    return 'check';
  }

  return {
    parseRows, serializeRows, isTaskLine, countTasks,
    toggleLine, setTaskAt, continuationPrefix,
    insertLine, mergeLineUp, stripDecorations, parseLine,
    preferredView,
  };
}));
