# Flinkynotes — Feature ports (local-only)

All in `src/main/`, pure logic + thin Electron glue in `main.js`. Team dashboard, mobile sync and browser extension deliberately excluded.

| Ask | Source | File | Notes |
|---|---|---|---|
| Custom reminders | reminder service | `nudges.js` | name/message/interval, per-item on/off, 30s poll, quiet `Notification` |
| Stats dashboard | stats service | `wellness.js` | daily taken/skipped/postponed, screen minutes, session lengths, 7-day week |
| Health score | daily stats | `wellness.js:healthScore` | formula `100 − 5·skipped − 1·postponed − 3 per session>40m`, clamp 0–100 |
| Work schedule | schedule service | `scheduleGuard.js` | days 1–7 + start/end, overnight supported; outside hours breaks hold |
| Pomodoro | pomodoro service | `pomodoroEngine.js` | work/short/long/paused/idle, per-cycle long, day-rolled counter, shares the 1s loop |
| Posture check | settings | `nudges.js` | 30m default; blink 10m. Both quiet notifications, re-arm on fire |

Streak = consecutive days with taken>0 and skipped=0.
