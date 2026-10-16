const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  // focus (break timer — TIMER.md)
  focusState: () => ipcRenderer.invoke('focus:state'),
  focusAction: (action, arg) => ipcRenderer.invoke('focus:action', action, arg),
  focusSettings: () => ipcRenderer.invoke('focus:getSettings'),
  focusSave: (s) => ipcRenderer.invoke('focus:saveSettings', s),
  onFocus: (cb) => ipcRenderer.on('focus:event', (_e, d) => cb(d)),
  onTick: (cb) => ipcRenderer.on('focus:tick', (_e, d) => cb(d)),

  // notes
  notesList: (o) => ipcRenderer.invoke('notes:list', o),
  notesGet: (id) => ipcRenderer.invoke('notes:get', id),
  notesCreate: (o) => ipcRenderer.invoke('notes:create', o),
  notesUpdate: (id, patch) => ipcRenderer.invoke('notes:update', id, patch),
  notesRemove: (id) => ipcRenderer.invoke('notes:remove', id),
  notesRestore: (snap) => ipcRenderer.invoke('notes:restore', snap),
  notesReorder: (ids) => ipcRenderer.invoke('notes:reorder', ids),
  notesExport: (kind) => ipcRenderer.invoke('notes:export', kind),
  notesImport: () => ipcRenderer.invoke('notes:import'),
  quickCapture: (text, destId) => ipcRenderer.invoke('notes:quickCapture', text, destId),
  onNotes: (cb) => ipcRenderer.on('notes:changed', () => cb()),
  onNotesOpen: (cb) => ipcRenderer.on('notes:open', (_e, ids) => cb(ids)),

  // deck
  deckGet: () => ipcRenderer.invoke('deck:get'),
  deckSave: (d) => ipcRenderer.invoke('deck:save', d),
  deckStage: (stage) => ipcRenderer.send('deck:stage', stage),
  deckPointer: (inside) => ipcRenderer.send('deck:pointer', !!inside),
  deckDebug: (info) => ipcRenderer.send('deck:debug', info),
  onDeckStage: (cb) => ipcRenderer.on('deck:stage', (_e, d) => cb(d)),
  onDeckSettings: (cb) => ipcRenderer.on('deck:settings', (_e, d) => cb(d)),
  deckZones: (z) => ipcRenderer.send('deck:zones', z),

  // system / windows
  sysGet: () => ipcRenderer.invoke('sys:get'),
  sysSave: (d) => ipcRenderer.invoke('sys:save', d),
  openWindow: (name, arg) => ipcRenderer.invoke('win:open', name, arg),
  closeSelf: () => ipcRenderer.invoke('win:closeSelf'),
  hideSelf: () => ipcRenderer.invoke('win:hideSelf'),
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:maxToggle'),

  tuckNote: () => ipcRenderer.send('note:tuck'),
  onEditorOpen: (cb) => ipcRenderer.on('editor:open', (_e, d) => cb(d)),

  // pre-break warning pill (fixed top-centre; × dismisses the warning)
  pillDismiss: () => ipcRenderer.invoke('pill:dismiss'),

  // floating clock window (hugs its panel; main resizes to fit)
  clockFit: (h) => ipcRenderer.send('clock:fit', h),

  // break / pill
  onBreakStart: (cb) => ipcRenderer.on('break:start', (_e, d) => cb(d)),  onBreakChime: (cb) => ipcRenderer.on('break:chime', (_e, d) => cb(d)),
  onPillStart: (cb) => ipcRenderer.on('pill:start', (_e, d) => cb(d)),
  onAllFilter: (cb) => ipcRenderer.on('all:filter', (_e, d) => cb(d)),
  onHomeView: (cb) => ipcRenderer.on('home:view', (_e, d) => cb(d)),

  // wellness
  wellnessGet: () => ipcRenderer.invoke('wellness:get'),
  wellnessSummary: () => ipcRenderer.invoke('wellness:summary'),
  onWellness: (cb) => ipcRenderer.on('wellness:changed', () => cb()),
  pomoStats: () => ipcRenderer.invoke('wellness:pomoStats'),
  featuresGet: () => ipcRenderer.invoke('features:get'),
  featuresSave: (f) => ipcRenderer.invoke('features:save', f),
  pomoGet: () => ipcRenderer.invoke('pomo:get'),
  pomoSave: (s) => ipcRenderer.invoke('pomo:save', s),
  pomoAction: (a) => ipcRenderer.invoke('pomo:action', a),
  onPomo: (cb) => ipcRenderer.on('pomo:event', (_e, d) => cb(d)),
  nudgesGet: () => ipcRenderer.invoke('nudges:get'),
  nudgesSave: (s) => ipcRenderer.invoke('nudges:save', s),
  nudgeAdd: (r) => ipcRenderer.invoke('nudges:add', r),
  nudgeUpdate: (id, p) => ipcRenderer.invoke('nudges:update', id, p),
  nudgeRemove: (id) => ipcRenderer.invoke('nudges:remove', id),
  scheduleGet: () => ipcRenderer.invoke('schedule:get'),
  scheduleSave: (s) => ipcRenderer.invoke('schedule:save', s),
  onNudge: (cb) => ipcRenderer.on('nudge:fire', (_e, d) => cb(d)),
});
