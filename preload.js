const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskApi', {
  list: () => ipcRenderer.invoke('tasks:list'),
  add: (task) => ipcRenderer.invoke('tasks:add', task),
  update: (id, task, scope) => ipcRenderer.invoke('tasks:update', id, task, scope),
  skip: (id, skipped) => ipcRenderer.invoke('tasks:skip', id, skipped),
  endSeries: (id) => ipcRenderer.invoke('tasks:end-series', id),
  setCompleted: (id, completed) =>
    ipcRenderer.invoke('tasks:set-completed', id, completed),
  delete: (id) => ipcRenderer.invoke('tasks:delete', id),
  bulkComplete: (ids, completed) => ipcRenderer.invoke('tasks:bulk-complete', ids, completed),
  bulkDelete: (ids) => ipcRenderer.invoke('tasks:bulk-delete', ids),
  bulkReschedule: (ids, dueDate) => ipcRenderer.invoke('tasks:bulk-reschedule', ids, dueDate),
});

contextBridge.exposeInMainWorld('scheduleApi', {
  list: () => ipcRenderer.invoke('schedule:list'),
  add: (activity, allowOverlap) =>
    ipcRenderer.invoke('schedule:add', activity, allowOverlap),
  update: (id, activity, allowOverlap, scope) =>
    ipcRenderer.invoke('schedule:update', id, activity, allowOverlap, scope),
  skip: (id, skipped) => ipcRenderer.invoke('schedule:skip', id, skipped),
  endSeries: (id) => ipcRenderer.invoke('schedule:end-series', id),
  setCompleted: (id, completed) =>
    ipcRenderer.invoke('schedule:set-completed', id, completed),
  delete: (id) => ipcRenderer.invoke('schedule:delete', id),
  bulkComplete: (ids, completed) => ipcRenderer.invoke('schedule:bulk-complete', ids, completed),
  bulkDelete: (ids) => ipcRenderer.invoke('schedule:bulk-delete', ids),
});

contextBridge.exposeInMainWorld('undoApi', {
  state: () => ipcRenderer.invoke('undo:state'),
  undo: () => ipcRenderer.invoke('undo:undo'),
  redo: () => ipcRenderer.invoke('undo:redo'),
  onState: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Undo state callback must be a function.');
    }
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('undo:state', listener);
    return () => ipcRenderer.removeListener('undo:state', listener);
  },
});

contextBridge.exposeInMainWorld('habitApi', {
  list: () => ipcRenderer.invoke('habits:list'),
  add: (habit) => ipcRenderer.invoke('habits:add', habit),
  update: (id, habit) => ipcRenderer.invoke('habits:update', id, habit),
  setCompletion: (id, date, completed) =>
    ipcRenderer.invoke('habits:set-completion', id, date, completed),
  setActive: (id, active) => ipcRenderer.invoke('habits:set-active', id, active),
  delete: (id) => ipcRenderer.invoke('habits:delete', id),
  restore: (id) => ipcRenderer.invoke('habits:restore', id),
  analytics: (date) => ipcRenderer.invoke('habits:analytics', date),
});

contextBridge.exposeInMainWorld('goalApi', {
  list: () => ipcRenderer.invoke('goals:list'),
  add: (goal) => ipcRenderer.invoke('goals:add', goal),
  update: (id, goal) => ipcRenderer.invoke('goals:update', id, goal),
  addMilestone: (id, milestone) => ipcRenderer.invoke('goals:add-milestone', id, milestone),
  setMilestoneCompleted: (id, milestoneId, completed) =>
    ipcRenderer.invoke('goals:set-milestone-completed', id, milestoneId, completed),
  deleteMilestone: (id, milestoneId) =>
    ipcRenderer.invoke('goals:delete-milestone', id, milestoneId),
  setCompleted: (id, completed) => ipcRenderer.invoke('goals:set-completed', id, completed),
  delete: (id) => ipcRenderer.invoke('goals:delete', id),
  restore: (id) => ipcRenderer.invoke('goals:restore', id),
  analytics: (date) => ipcRenderer.invoke('goals:analytics', date),
});

contextBridge.exposeInMainWorld('focusApi', {
  load: () => ipcRenderer.invoke('focus:load'),
  saveSettings: (settings) => ipcRenderer.invoke('focus:save-settings', settings),
  timerState: () => ipcRenderer.invoke('focus:timer-state'),
  startTimer: (mode, remainingMs, sessionMinutes) =>
    ipcRenderer.invoke('focus:timer-start', mode, remainingMs, sessionMinutes),
  pauseTimer: () => ipcRenderer.invoke('focus:timer-pause'),
  cancelTimer: () => ipcRenderer.invoke('focus:timer-cancel'),
  onTimerFinished: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Timer event callback must be a function.');
    }
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('focus:timer-finished', listener);
    return () => ipcRenderer.removeListener('focus:timer-finished', listener);
  },
  onNotificationError: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Notification event callback must be a function.');
    }
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('focus:notification-error', listener);
    return () => ipcRenderer.removeListener('focus:notification-error', listener);
  },
});

contextBridge.exposeInMainWorld('notificationApi', {
  list: () => ipcRenderer.invoke('notifications:list'),
  markRead: (ids) => ipcRenderer.invoke('notifications:mark-read', ids),
  clearHistory: () => ipcRenderer.invoke('notifications:clear-history'),
  snooze: (id, until) => ipcRenderer.invoke('notifications:snooze', id, until),
  unsnooze: (id) => ipcRenderer.invoke('notifications:unsnooze', id),
  test: () => ipcRenderer.invoke('notifications:test'),
  onChanged: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Notification event callback must be a function.');
    }
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('notifications:changed', listener);
    return () => ipcRenderer.removeListener('notifications:changed', listener);
  },
  onOpenTarget: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Notification event callback must be a function.');
    }
    const listener = (_event, target) => callback(target);
    ipcRenderer.on('notifications:open-target', listener);
    return () => ipcRenderer.removeListener('notifications:open-target', listener);
  },
});

contextBridge.exposeInMainWorld('profileApi', {
  state: () => ipcRenderer.invoke('profiles:state'),
  create: (profile) => ipcRenderer.invoke('profiles:create', profile),
  update: (id, profile) => ipcRenderer.invoke('profiles:update', id, profile),
  activate: (id, pin) => ipcRenderer.invoke('profiles:activate', id, pin),
  setPin: (id, pin) => ipcRenderer.invoke('profiles:set-pin', id, pin),
  lock: () => ipcRenderer.invoke('profiles:lock'),
  unlock: (pin) => ipcRenderer.invoke('profiles:unlock', pin),
  delete: (id) => ipcRenderer.invoke('profiles:delete', id),
});

contextBridge.exposeInMainWorld('exportApi', {
  calendar: () => ipcRenderer.invoke('export:calendar'),
  tasksCsv: () => ipcRenderer.invoke('export:tasks-csv'),
  activitiesCsv: () => ipcRenderer.invoke('export:activities-csv'),
});

contextBridge.exposeInMainWorld('appApi', {
  loadSettings: () => ipcRenderer.invoke('app:settings-load'),
  saveSettings: (settings) => ipcRenderer.invoke('app:settings-save', settings),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  resetData: () => ipcRenderer.invoke('app:reset-data'),
  exportBackup: () => ipcRenderer.invoke('app:backup-export'),
  restoreBackup: () => ipcRenderer.invoke('app:backup-restore'),
  getLastBackup: () => ipcRenderer.invoke('app:backup-last'),
  desktopReady: () => ipcRenderer.invoke('app:desktop-ready'),
  consumeCapture: () => ipcRenderer.invoke('app:consume-capture'),
  quickCapture: (profileId, title) => ipcRenderer.invoke('app:quick-capture-add', profileId, title),
  onQuickCapture: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Quick capture callback must be a function.');
    }
    const listener = () => callback();
    ipcRenderer.on('app:quick-capture', listener);
    return () => ipcRenderer.removeListener('app:quick-capture', listener);
  },
});