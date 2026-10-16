'use strict';
/* Pure layout math — no Electron imports so tests/run.js can exercise it. */

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

// The clock widget may only travel along the TOP band of the screen (user
// request: "only for the upper edges, not freely anywhere"). X spans the full
// work area; Y never leaves a strip just below the top edge, and the window
// always stays fully on-screen even on short displays.
const CLOCK_BAND_H = 120; // px of vertical travel below the top edge

function clampClockPos(x, y, w, h, wa) {
  const maxX = wa.x + Math.max(0, wa.width - w);
  const band = Math.max(0, Math.min(CLOCK_BAND_H, wa.height - h));
  return {
    x: Math.round(clamp(Number(x), wa.x, maxX)),
    y: Math.round(clamp(Number(y), wa.y, wa.y + band)),
  };
}

// Shingled-tab strip: the uncovered strip of each tab is
// sized to the longest title so full titles read instead of truncating.
// longest = title length in characters.
const SHINGLE_PITCH_MIN = 56, SHINGLE_PITCH_MAX = 106;
function shinglePitch(longest) {
  const n = Number(longest);
  const v = Number.isFinite(n) ? n * 7 + 20 : 76;
  return Math.round(clamp(v, SHINGLE_PITCH_MIN, SHINGLE_PITCH_MAX));
}

module.exports = { clamp, clampClockPos, CLOCK_BAND_H, shinglePitch, SHINGLE_PITCH_MIN, SHINGLE_PITCH_MAX };
