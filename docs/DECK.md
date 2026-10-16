# Flinkynotes — Deck Notes

How the note deck works: a native window hugging web content, a pure layout
core, and the measurement rules that keep it stable.

## Layout core

- **Pure layout core** `src/main/deckLayout.js` (`unionZones`,
  `computeDeckBounds`, `fanPitch`, `restoreCenterY`, `rebaseContentY`,
  `decideDeckPlacement`, `restBootBounds`) — screen-space in, bounds out,
  unit tested in `tests/run.js`. It owns the min/max pitch truth via
  `geometry.shinglePitch` (one owner, no renderer fork).
- **`src/renderer/deck.html`** — theme palette, 3° fan, 264px preview, rest
  pill, deck clock disc; same IPC names throughout; transform-free
  measurement:
  - offset* only; zero `getBoundingClientRect` for placement/zones/hit-test.
  - zero `window.innerWidth/innerHeight` reads (width ref =
    `deckRoot.offsetWidth`, height budget = cached `waH` from `deck:get`).
  - preview slot anchored to LAYOUT (rail boxes), not the window edge.
  - rest pill is static (no `translateY(-50%)` centering math).
  - hover via delegation (survives `innerHTML` rebuilds); open preview
    re-links across autosave re-renders; resting pointer re-shows instantly.
  - zones coalesced to one send per frame + generation counter.
  - no `transitionend` resend (transform-free zones are stable mid-entrance).
- **`src/main/main.js` deck section** — translates window-local zones by its
  own bounds origin, drops stale generations, `DECK_PAD` 10 → 6.
  Renderer owns FOLD, main only WAKES (a single fold owner — two owners
  bounced wake→fold→wake). Right edge only.
- Fresh data: `settings`, `notes` (no legacy migration).

## Bug that tests caught

`computeDeckBounds` glue-tracking had a flipped sign (window would have
jumped the wrong way when content grew). `deck-glue-tracks-content` failed
`414 !== 314`, sign fixed, all green.

## Bug the drive harness caught (`--deckdrive`)

First drive: wake → hover → leave → fold cost **31 zones + 31 native
resizes**, oscillating `w=276 ↔ w=70` every ~95ms while the preview was out.
Root cause: the slot was reported only while the card was hidden; once the
card showed (covered → itself unreported), nothing reserved the 264px lane,
so the union collapsed to tabs-only and main shrank the window under the
card, uncovering it, growing again — a shrink/grow storm. Fix: report the
slot whenever the fan is up, card or not (`deck.html` `sendZones`).
Re-drive: **11 zones + 9 bounds**, and the whole hover → preview → leave
window (3.2 s) costs **zero** resizes. Echo repaints for an already-shown
stage are now skipped (`onDeckStage` guard).

## IPC contract

`deck:get → {…deckSettings, openIds, waH}`, `deck:save`,
`deck:stage` (both directions), `deck:pointer`, `deck:zones {gen, rects}`,
`notes:*`, `notes:changed`, `notes:open`, `editor:open`, `win:open`.

## Unchanged modules

`focusEngine`, `pomodoroEngine`, `wellness`, `nudges`, `scheduleGuard`,
`jsonStore`, `notesStore` (+notes dir), `geometry`, `noteSizes`, `break.html`,
`pill.html`, `capture.html`, `all.html`, `home.html`, tray/tick/nudge loops.

## Placement fixes

1. **Deck jumps on every wake (read as upward creep).** Every rest→fan
   crossing re-centered on screen center. Now wakes restore the last fan
   center on the same display (`lastFanCenterY` + `restoreCenterY` in
   `deckLayout.js`, tested); screen center only for the first wake or a
   display change. Drive two-cycle proof: 2nd wake lands exactly where the
   1st settled (y=0 both).
2. **Deck primary-display-only / buried by other apps.** All placements
   (`applyDeckBounds`, wake poll, `deck:get` waH, `ensureDeck` boot,
   `positionEditorDefault`) use the cursor's display (`cursorDisplay()`).
   Always-on-top `screen-saver` level is re-asserted on every deck show.
3. **Rest-phase re-apply storm (DPI rounding).** On 125% displays the rest
   height (97 DIP → 121.25 physical) rounds in the OS, so `getBounds` came
   back 1px off forever and every rest zones message re-applied + repainted.
   The equality guard now tolerates 1px (constant offset, pad absorbs it).
4. **Ghost note windows.** `note:tuck` hides the sender even when its note
   id can't be resolved (tuck clicks never no-op). `.note.deleted` had
   `pointer-events:none` on the whole card, which also killed the header
   X — X/pin stay clickable on locked cards now. Probe (`--ghostprobe`):
   delete → store gone, tucked at once; archive → tucked at once; X tucks.
   All verified hidden.
5. **Notifications named `electron.app.Electron`.**
   `app.setAppUserModelId('com.flinkynotes.app')` is set before ready.
   Note: running from source (`npm start`) the host exe IS Electron,
   so dev toasts keep that name — packaged builds report Flinkynotes.

## Glue, lane and fold fixes

6. **Deck parked at top-right instead of vertical center.**
   Root cause in the glue bookkeeping: `deckPrevContentY` carried a
   screen-space union measured under the PRE-move origin, so the pass after
   a center placement re-applied the move delta as glue (y136→clamp 0).
   Fix: `rebaseContentY()` (deckLayout.js, tested) rebases the reference
   onto the applied bounds — glue now measures window-local movement only.
   Center-restore preserves that feel across wakes.
7. **Open deck ate other apps' top-right buttons.** The always-reserved
   264px preview lane was the dead area (click-through flags are a no-op
   for mousemove on Windows, so that option was rejected). Fix: the lane
   is reserved only while needed (hovered tab, open card/sheet, 350ms
   anti-strobe linger); the fan window hugs tabs (~70px) otherwise. Fold
   is swift (260ms on leave, 900ms off-content) so the deck gets out of
   the way fast.
8. **Lock disc.** Toggle between settings and clock discs, wired to the
   existing `keepOpen` deck setting (persisted, same switch as Home).
   Pressed state re-renders; fold/sleep/poll all honor it.
9. **Clock disc opens a floating clock window.** Toggled, lives left of the
   deck following it, ×/Esc closes, hug-fit via `clock:fit`. Same timer
   actions; disc keeps a live countdown tooltip.
10. **Delete/archive dismiss immediately.** Delete/arm + archive tuck at
    once (2-step arm stays as the delete guard; archived notes recoverable
    via All notes → Archived → Archive toggle).

## Placement policy

11. **Hover teleport flash.** Cause: a hover-gated lane widened/shrank the
    native window ~206px instantly on hover enter/leave (`setBounds` has
    no transition). Fix: lane-while-fan — grow rides the wake motion,
    shrink rides the fold. Hover-gating machinery (pre-widen, linger,
    wantSlot) deleted — the bug class is structurally gone, not patched.
12. **Downward push on new note.** Glue top-anchored all growth. Now the
    renderer sends a structural signature (tab ids + pitch; flyouts
    excluded) and main center-anchors on signature change, so the deck
    grows symmetrically around its center. Flyout show/hide
    keeps gluing (cards never jump); autosave re-renders keep the signature
    (hover survives typing). Policy is pure + tested
    (`decideDeckPlacement`: center/restore/glue). Every branch is immune to
    stale unions for position, so no superseded message can teleport.

## Policy simplification

13. **Placement guarantee.** Policy simplified to center-or-glue
    (rest/wake/structural always screen-center — deterministic no matter
    how many notes; remembered-position state deleted so nothing can
    drift).
14. **+N overflow opens Home → Notes** (search, filter, open, pin, colour,
    archive, delete, export — the note menu in the main app menu) instead
    of a floating window.
