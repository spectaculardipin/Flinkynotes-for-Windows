'use strict';
// Pure note helpers — no Electron deps so tests/run.js can exercise them.
const NOTE_SIZES = {
  compact: { w: 360, h: 340, label: 'Compact' },
  classic: { w: 430, h: 400, label: 'Classic' },
  large: { w: 520, h: 480, label: 'Large' },
};
const NOTE_SIZE_DEFAULT = 'classic';

function noteDims(name) {
  return NOTE_SIZES[name] || NOTE_SIZES[NOTE_SIZE_DEFAULT];
}

// Only a pristine blank (empty body AND untitled) may be reused for "+ New".
// A note the user already titled — even with an empty body — is a real note
// and must never be handed back as if it were freshly created.
function isReusableEmpty(n, bodyText) {
  if (!n || n.archived) return false;
  if (String(bodyText || '').trim()) return false;
  const t = String(n.title || '').trim();
  return t === '' || t === 'New note';
}

module.exports = { NOTE_SIZES, NOTE_SIZE_DEFAULT, noteDims, isReusableEmpty };
