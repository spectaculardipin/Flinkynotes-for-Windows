'use strict';
/* deckLayout.js — pure deck-window layout math (v3 clean-room, no Electron deps).
 *
 * Protocol (kills the v2 feedback loops):
 * - The renderer measures content with offset* ONLY (never getBoundingClientRect
 *   mid-transition, never window.innerWidth/innerHeight for budgeting) and
 *   reports zones in SCREEN space: screen = lastAppliedOrigin + offsetChain.
 *   Main tells the renderer the applied origin via deck:get / deck:stage echo.
 * - Each zones message carries a generation counter; main ignores stale gens.
 * - Main unions in screen space directly — no origin translation, so identical
 *   content yields identical rects and the equality guard suppresses resizes.
 * - Right edge only (v3 scope): x is always edge-snapped. Y centers on
 *   rest<->fan crossings, otherwise glue-tracks content (sy + contentY const).
 */
const { shinglePitch } = require('./geometry');

const DECK_PAD = 6; // breathing room so entrance slides never clip (symmetric)
const DECK_MIN_W = 8, DECK_MIN_H = 8;

function unionZones(zones) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of zones || []) {
    if (!r) continue;
    const w = r.w ?? r.width ?? 0, h = r.h ?? r.height ?? 0;
    const x = r.x ?? 0, y = r.y ?? 0;
    if (w < 2 || h < 2) continue;
    if (x0 > x) x0 = x;
    if (y0 > y) y0 = y;
    if (x1 < x + w) x1 = x + w;
    if (y1 < y + h) y1 = y + h;
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }

/* Compute native window bounds from screen-space content zones.
 *   zones: [{x,y,w,h}] in screen coords (workArea-anchored by construction)
 *   wa: {x,y,width,height} work area of the display
 *   opts: { center:boolean, prevBounds:{x,y,w,h}|null, prevContentY:number|null,
 *           pad:number }
 * Returns { visible:false } when nothing is on screen, else
 * { visible:true, x,y,w,h, contentY } (contentY = union top for glue tracking).
 */
function computeDeckBounds(zones, wa, opts = {}) {
  const pad = opts.pad ?? DECK_PAD;
  const u = unionZones(zones);
  if (!u) return { visible: false };
  let w = Math.round(u.w + pad * 2);
  let h = Math.round(u.h + pad * 2);
  w = clamp(w, DECK_MIN_W, wa.width);
  h = clamp(h, DECK_MIN_H, wa.height);
  const x = Math.round(wa.x + wa.width - w); // right edge only
  let y;
  if (opts.center || !opts.prevBounds) {
    y = wa.y + Math.max(0, Math.round((wa.height - h) / 2));
  } else {
    // Glue-exact tracking in SCREEN space: content screen pos must not move,
    // i.e. newBounds.y + (u.y - newBounds.y) == u.y always. Since zones are
    // already screen coords, the window follows content deltas 1:1:
    // content moved up 50 → window moves up 50.
    const refY = (opts.prevContentY === null || opts.prevContentY === undefined) ? u.y : opts.prevContentY;
    y = Math.round(opts.prevBounds.y + (u.y - refY));
    y = clamp(y, wa.y, wa.y + Math.max(0, wa.height - h));
  }
  return { visible: true, x, y, w, h, contentY: u.y };
}

/* Fan pitch from the longest visible title (chars) and available budget.
 * Single owner of the min/max truth (delegates to geometry.shinglePitch),
 * with a short-screen guard that shrinks the floor instead of overflowing.
 *   longestChars: measured longest title length
 *   count: number of stacked tabs, lap: shingle overlap px,
 *   budget: vertical px available for the stack
 */
const PITCH_FLOOR_SHORT = 36;
function fanPitch(longestChars, count, budget, lap = 40) {
  let pitch = shinglePitch(longestChars);
  if (Number.isFinite(budget) && budget > 0 && Number.isFinite(count) && count > 0) {
    const fit = (budget - lap) / count;
    if (fit < pitch) pitch = Math.max(PITCH_FLOOR_SHORT, Math.floor(fit));
  }
  return pitch;
}

/* Wake placement: put a window of height h back on its last visual center
 * so the deck stays put across wake/fold cycles instead of jumping to
 * screen center every time (which reads as upward creep). Clamped to wa.
 */
function restoreCenterY(lastCenterY, h, wa) {
  const y = Math.round(lastCenterY - h / 2);
  return clamp(y, wa.y, wa.y + Math.max(0, wa.height - h));
}

/* Rebase the glue reference onto newly applied bounds. The next pass must
 * measure content movement in WINDOW-LOCAL space (localY0 - prevLocalY0):
 * carrying a screen-space contentY measured under the PRE-move origin
 * re-applies the move delta as glue and parks the deck at the top (the
 * y136→y0 settle bug: center to 136, then glue saw u.y-prevContentY = -205
 * and clamped to 0). Rebasing onto the applied bounds keeps centers stable.
 */
function rebaseContentY(appliedBounds, localUnionY) {
  return appliedBounds.y + (Number.isFinite(localUnionY) ? localUnionY : 0);
}

/* Placement policy (pure): given the stage-machine state, decide HOW to
 * place — never the coordinates themselves.
 * - center: rest, wake crossings, and structural changes (sig) all center
 *   on the screen center — one deterministic place no matter how many
 *   notes. No remembered position means no drift state to go stale.
 * - glue: flyout-only change (preview show/hide, same sig) — track content
 *   1:1 so open cards never jump under the cursor.
 * Center ignores the union position and glue chases the live origin, so no
 * superseded zones message can teleport the window.
 */
function decideDeckPlacement({ stage, crossing, sigChanged }) {
  if (stage === 'rest' || crossing || sigChanged) return 'center';
  return 'glue';
}

/* Deterministic rest-strip geometry for main-driven re-show (hide-strip OFF
 * and other cases where no fresh zones are available yet): right-edge
 * snapped, vertically centered, clamped to the work area. The renderer's next
 * zones message refines this to exact hug bounds via applyDeckBounds.
 */
function restBootBounds(wa, w = 24, h = 132) {
  const ww = Math.min(Math.max(8, Math.round(w)), Math.max(8, wa.width));
  const hh = Math.min(Math.max(8, Math.round(h)), Math.max(8, wa.height));
  return {
    x: Math.round(wa.x + wa.width - ww),
    y: Math.round(wa.y + Math.max(0, (wa.height - hh) / 2)),
    w: ww, h: hh,
  };
}

module.exports = { DECK_PAD, unionZones, computeDeckBounds, fanPitch, PITCH_FLOOR_SHORT, restoreCenterY, rebaseContentY, decideDeckPlacement, restBootBounds };
