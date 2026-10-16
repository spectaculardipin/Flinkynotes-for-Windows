// Work-schedule guard. Pure logic.
// activeDays: 1=Mon..7=Sun. enabled=false means "always active".
const SCHEDULE_DEFAULTS = {
  enabled: false,
  activeDays: [1, 2, 3, 4, 5],
  startHour: 9, startMinute: 0,
  endHour: 17, endMinute: 0,
};

function isActiveNow(s = SCHEDULE_DEFAULTS, now = new Date()) {
  if (!s.enabled) return true;
  const dow = now.getDay() === 0 ? 7 : now.getDay(); // JS 0=Sun -> 7
  if (!(s.activeDays || []).includes(dow)) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = s.startHour * 60 + s.startMinute;
  const end = s.endHour * 60 + s.endMinute;
  if (end <= start) return cur >= start || cur < end; // overnight shift
  return cur >= start && cur < end;
}

module.exports = { SCHEDULE_DEFAULTS, isActiveNow };
