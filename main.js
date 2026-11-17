const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  powerMonitor,
  globalShortcut,
  Menu,
  Tray,
} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const taskStore = require('./src/task-store');
const scheduleStore = require('./src/schedule-store');
const focusStore = require('./src/focus-store');
const habitStore = require('./src/habit-store');
const goalStore = require('./src/goal-store');
const appSettingsStore = require('./src/app-settings-store');
const backupStore = require('./src/backup-store');
const notificationStore = require('./src/notification-store');
const notificationService = require('./src/notification-service');
const profileStore = require('./src/profile-store');
const undoService = require('./src/undo-service');
const exportService = require('./src/export-service');

const userDataOverrideAllowed =
  !app.isPackaged || process.env.TASKFORGE_ALLOW_USER_DATA_OVERRIDE === '1';

if (userDataOverrideAllowed && process.env.TASKFORGE_USER_DATA_DIR) {
  const overrideDirectory = path.resolve(process.env.TASKFORGE_USER_DATA_DIR);
  app.setPath('userData', overrideDirectory);
  app.setPath('sessionData', path.join(overrideDirectory, 'session-data'));
}

function activeDataPaths() {
  if (!activeProfileId) {
    throw new Error('Profiles are still loading. Try again in a moment.');
  }
  return profileStore.getProfileDataPaths(app.getPath('userData'), activeProfileId);
}

const taskFilePath = () => activeDataPaths().tasks;
const scheduleFilePath = () => activeDataPaths().schedules;
const focusFilePath = () => activeDataPaths().focus;
const appSettingsFilePath = () => activeDataPaths().settings;
const habitFilePath = () => activeDataPaths().habits;
const goalFilePath = () => activeDataPaths().goals;
const backupStateFilePath = () => activeDataPaths().backupState;
const notificationStateFilePath = () => activeDataPaths().notificationState;
const notificationSnoozesFilePath = () => activeDataPaths().notificationSnoozes;
const backupFilePaths = () => ({
  tasks: taskFilePath(),
  schedules: scheduleFilePath(),
  focus: focusFilePath(),
  habits: habitFilePath(),
  goals: goalFilePath(),
  settings: appSettingsFilePath(),
});

let taskOperations = Promise.resolve();
let mainWindow;
let tray;
let desktopReady = false;
let pendingCaptureProfileId = null;
let shortcutRegistered = false;
let isQuitting = false;
let quitReady = false;
const captureAccelerator = 'CommandOrControl+Alt+N';
let profileState = null;
let activeProfileId = null;
const unlockedProfileIds = new Set();
const pinFailures = new Map();
const focusTimers = new Map();
let notificationTimer = null;
let notificationRefreshQueued = false;
let notificationRefreshRevision = 0;
const maximumNotificationTimeoutMs = 60 * 60 * 1000;
const notificationRetryIntervalMs = 60 * 1000;
const maximumPinAttempts = 5;
const pinLockoutMs = 30 * 1000;
const undoHistory = undoService.createHistory();

const timerModes = new Set(['focus', 'shortBreak', 'longBreak']);
const maximumTimerMs = focusStore.durationLimits.maximum * 60 * 1000;

function runTaskOperation(operation) {
  if (isQuitting) return Promise.reject(new Error('TaskForge is closing.'));
  const result = taskOperations.then(operation);
  taskOperations = result.catch(() => {});
  return result;
}

function getActiveProfileRecord() {
  if (!profileState) {
    return null;
  }
  return profileState.profiles.find((profile) => profile.id === activeProfileId) ?? null;
}

function isActiveProfileLocked() {
  const profile = getActiveProfileRecord();
  return Boolean(profile?.pinHash) && !unlockedProfileIds.has(activeProfileId);
}

async function loadProfiles() {
  profileState = await profileStore.readState(app.getPath('userData'));
  if (activeProfileId !== profileState.activeProfileId) {
    pendingCaptureProfileId = null;
  }
  activeProfileId = profileState.activeProfileId;
  const profileIds = new Set(profileState.profiles.map((profile) => profile.id));
  for (const profileId of unlockedProfileIds) {
    if (!profileIds.has(profileId)) {
      unlockedProfileIds.delete(profileId);
    }
  }
  for (const profile of profileState.profiles) {
    if (profile.pinHash === null) {
      unlockedProfileIds.add(profile.id);
    }
  }
  return profileState;
}

function getProfileView() {
  const activeProfile = getActiveProfileRecord();
  return {
    activeProfileId,
    locked: isActiveProfileLocked(),
    profiles: profileState.profiles.map(profileStore.toPublicProfile),
    activeProfile: activeProfile ? profileStore.toPublicProfile(activeProfile) : null,
  };
}

function queueNotificationRefresh() {
  if (isQuitting || notificationRefreshQueued) {
    return;
  }
  notificationRefreshQueued = true;
  setTimeout(() => {
    notificationRefreshQueued = false;
    refreshNotificationSchedule().catch((error) => {
      console.error('Could not refresh desktop reminders.', error);
    });
  }, 0);
}

function pauseNotificationSchedule() {
  notificationRefreshRevision += 1;
  if (notificationTimer) {
    clearTimeout(notificationTimer);
    notificationTimer = null;
  }
}

function runDataOperation(operation) {
  const profileId = activeProfileId;
  return runTaskOperation(() => {
    if (profileId !== activeProfileId || isActiveProfileLocked()) {
      throw new Error('The active profile changed or is locked. Try again in the current profile.');
    }
    return operation();
  }).then((result) => {
    queueNotificationRefresh();
    return result;
  });
}

function sendUndoState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('undo:state', undoHistory.state());
  }
}

function clearUndoHistory() {
  undoHistory.clear();
  sendUndoState();
}

function runTrackedDataOperation(kind, label, operation) {
  return runDataOperation(async () => {
    const filePath = kind === 'tasks' ? taskFilePath() : scheduleFilePath();
    const load = kind === 'tasks' ? taskStore.loadTasks : scheduleStore.loadActivities;
    const before = await load(filePath);
    const result = await operation();
    const after = kind === 'tasks' || Array.isArray(result)
      ? result
      : (result.saved ? result.activities : null);
    if (after && JSON.stringify(before) !== JSON.stringify(after)) {
      undoHistory.record({ kind, label, before, after });
      sendUndoState();
    }
    return result;
  });
}

async function applyHistoryEntry(direction) {
  const entry = direction === 'undo' ? undoHistory.peekUndo() : undoHistory.peekRedo();
  if (!entry) {
    throw new Error(direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.');
  }
  const filePath = entry.kind === 'tasks' ? taskFilePath() : scheduleFilePath();
  const load = entry.kind === 'tasks' ? taskStore.loadTasks : scheduleStore.loadActivities;
  const replace = entry.kind === 'tasks' ? taskStore.replaceTasks : scheduleStore.replaceActivities;
  const expected = direction === 'undo' ? entry.after : entry.before;
  const target = direction === 'undo' ? entry.before : entry.after;
  const current = await load(filePath);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    undoHistory.clear();
    throw new Error('The data changed outside undo history, so the history was reset.');
  }
  await replace(filePath, target);
  if (direction === 'undo') {
    undoHistory.commitUndo();
  } else {
    undoHistory.commitRedo();
  }
  sendUndoState();
  return { ...undoHistory.state(), kind: entry.kind, label: entry.label, rows: target };
}

function registerUnlockedHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (isQuitting) throw new Error('TaskForge is closing. Try again after reopening it.');
    if (isActiveProfileLocked()) {
      throw new Error('This profile is locked. Unlock it to continue.');
    }
    return handler(event, ...args);
  });
}

async function verifyProfilePin(profile, pin) {
  const failure = pinFailures.get(profile.id);
  if (failure?.blockedUntil && Date.now() < failure.blockedUntil) {
    const remainingSeconds = Math.ceil((failure.blockedUntil - Date.now()) / 1000);
    throw new Error(`Too many incorrect PIN attempts. Try again in ${remainingSeconds} seconds.`);
  }
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
    throw new TypeError('PIN must be 4 to 8 digits.');
  }
  if (!await profileStore.verifyPin(profile, pin)) {
    const previousCount = failure?.blockedUntil ? 0 : (failure?.count ?? 0);
    const nextCount = previousCount + 1;
    if (nextCount >= maximumPinAttempts) {
      pinFailures.set(profile.id, { count: 0, blockedUntil: Date.now() + pinLockoutMs });
      throw new Error('Too many incorrect PIN attempts. Try again in 30 seconds.');
    }
    pinFailures.set(profile.id, { count: nextCount, blockedUntil: 0 });
    throw new Error('Incorrect PIN. Try again.');
  }
  pinFailures.delete(profile.id);
}

async function ensureProfileAccess(profile, pin) {
  if (profile.pinHash === null || unlockedProfileIds.has(profile.id)) {
    return;
  }
  await verifyProfilePin(profile, pin);
  unlockedProfileIds.add(profile.id);
}

async function activateProfile(profileId, pin) {
  const state = await profileStore.readState(app.getPath('userData'));
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error('Profile not found.');
  }
  await ensureProfileAccess(profile, pin);
  if (profileId !== activeProfileId) {
    await profileStore.setActiveProfile(app.getPath('userData'), profileId);
    await loadProfiles();
    clearUndoHistory();
    pauseNotificationSchedule();
    queueNotificationRefresh();
  }
  return getProfileView();
}

async function createProfileAndActivate(input) {
  const created = await profileStore.createProfile(app.getPath('userData'), input);
  await profileStore.setActiveProfile(app.getPath('userData'), created.id);
  await loadProfiles();
  unlockedProfileIds.add(created.id);
  clearUndoHistory();
  pauseNotificationSchedule();
  queueNotificationRefresh();
  return getProfileView();
}

async function updateProfileDetails(profileId, input) {
  if (isActiveProfileLocked()) {
    throw new Error('This profile is locked. Unlock it to continue.');
  }
  await profileStore.getProfile(app.getPath('userData'), profileId);
  await profileStore.updateProfile(app.getPath('userData'), profileId, input);
  await loadProfiles();
  return getProfileView();
}

async function updateActiveProfilePin(profileId, pin) {
  if (profileId !== activeProfileId) {
    throw new Error('PIN settings can only be changed for the active profile.');
  }
  if (isActiveProfileLocked()) {
    throw new Error('This profile is locked. Unlock it to continue.');
  }
  await profileStore.setProfilePin(app.getPath('userData'), profileId, pin);
  await loadProfiles();
  return getProfileView();
}

async function lockActiveProfile() {
  const profile = getActiveProfileRecord();
  if (!profile?.pinHash) {
    throw new Error('Add a PIN before locking this profile.');
  }
  unlockedProfileIds.delete(profile.id);
  pauseNotificationSchedule();
  return getProfileView();
}

async function unlockActiveProfile(pin) {
  const profile = getActiveProfileRecord();
  if (!profile) {
    throw new Error('No active profile is available.');
  }
  await ensureProfileAccess(profile, pin);
  queueNotificationRefresh();
  return getProfileView();
}

async function deleteProfileById(profileId) {
  if (isActiveProfileLocked()) {
    throw new Error('This profile is locked. Unlock it to continue.');
  }
  if (profileId === activeProfileId) {
    throw new Error('The active profile cannot be deleted. Switch to another profile first.');
  }
  await profileStore.deleteProfile(app.getPath('userData'), profileId);
  cancelFocusTimerForProfile(profileId);
  pinFailures.delete(profileId);
  unlockedProfileIds.delete(profileId);
  await loadProfiles();
  return getProfileView();
}

function showReminderNotification(event, navigate = true) {
  if (!Notification.isSupported()) {
    return false;
  }
  try {
    const notification = new Notification({
      title: event.title,
      body: event.body,
    });
    notification.on('click', () => {
      showMainWindow();
      if (navigate && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notifications:open-target', {
          targetType: event.targetType,
          targetId: event.targetId,
          targetDate: event.targetDate,
        });
      }
    });
    notification.show();
    return true;
  } catch (error) {
    console.error(`Could not display ${event.category} reminder "${event.id}".`, error);
    return false;
  }
}

function sendNotificationsChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  runTaskOperation(() => notificationStore.unreadCount(notificationStateFilePath()))
    .then((count) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notifications:changed', { unreadCount: count });
      }
    })
    .catch(() => {});
}

async function refreshNotificationSchedule() {
  const revision = ++notificationRefreshRevision;
  if (notificationTimer) {
    clearTimeout(notificationTimer);
    notificationTimer = null;
  }
  if (isQuitting || !profileState || isActiveProfileLocked()) {
    return;
  }
  const paths = activeDataPaths();
  try {
    const snapshot = await runTaskOperation(async () => {
      const [settings, tasks, activities, habits, goals] = await Promise.all([
        appSettingsStore.loadSettings(paths.settings),
        taskStore.loadTasks(paths.tasks),
        scheduleStore.loadActivities(paths.schedules),
        habitStore.loadHabits(paths.habits),
        goalStore.loadGoals(paths.goals),
      ]);
      return { settings, tasks, activities, habits, goals };
    });
    if (revision !== notificationRefreshRevision
      || isActiveProfileLocked()
      || !snapshot.settings.notificationsEnabled
      || !Notification.isSupported()) {
      return;
    }

    const now = Date.now();
    const events = notificationService.buildReminderEvents(snapshot, new Date(now));
    const snoozes = await runTaskOperation(() => notificationStore.loadSnoozes(paths.notificationSnoozes));
    const dueEvents = notificationService.getDueEvents(events, now)
      .filter((event) => !notificationService.isSnoozed(snoozes, event.id, now));
    const hasDeliveryWork = dueEvents.length > 0
      || notificationService.getExpiredSnoozes(events, snoozes, now).length > 0
      || notificationService.getStaleSnoozeIds(events, snoozes).length > 0;
    let deliveryFailed = false;
    let snoozesForWake = snoozes;
    if (hasDeliveryWork) {
      const outcome = await runTaskOperation(async () => {
        const [currentSettings, tasks, activities, habits, goals] = await Promise.all([
          appSettingsStore.loadSettings(paths.settings),
          taskStore.loadTasks(paths.tasks),
          scheduleStore.loadActivities(paths.schedules),
          habitStore.loadHabits(paths.habits),
          goalStore.loadGoals(paths.goals),
        ]);
        if (revision !== notificationRefreshRevision
          || isActiveProfileLocked()
          || !currentSettings.notificationsEnabled) {
          return { failed: false, delivered: 0, snoozes };
        }
        const currentEvents = notificationService.buildReminderEvents(
          { settings: currentSettings, tasks, activities, habits, goals },
        );
        const currentDueEvents = notificationService.getDueEvents(currentEvents);
        let currentSnoozes = await notificationStore.loadSnoozes(paths.notificationSnoozes);
        const staleIds = notificationService.getStaleSnoozeIds(currentEvents, currentSnoozes);
        if (staleIds.length > 0) {
          currentSnoozes = await notificationStore.removeSnoozes(paths.notificationSnoozes, staleIds);
        }
        const deliveredIds = new Set(
          (await notificationStore.loadDelivered(paths.notificationState))
            .map((entry) => entry.id),
        );
        const deliveredAt = new Date().toISOString();
        const newlyDelivered = [];
        const firedSnoozeIds = [];
        const snoozedEventIds = new Set();
        let failed = false;
        for (const { event, deliveryId } of notificationService.getExpiredSnoozes(currentEvents, currentSnoozes)) {
          if (revision !== notificationRefreshRevision) {
            return { failed: false, delivered: 0, snoozes: currentSnoozes };
          }
          if (deliveredIds.has(deliveryId)) {
            firedSnoozeIds.push(event.id);
            snoozedEventIds.add(event.id);
            continue;
          }
          snoozedEventIds.add(event.id);
          if (!showReminderNotification(event)) {
            failed = true;
            continue;
          }
          newlyDelivered.push({ id: deliveryId, deliveredAt, event });
          deliveredIds.add(deliveryId);
          firedSnoozeIds.push(event.id);
        }
        if (firedSnoozeIds.length > 0) {
          currentSnoozes = await notificationStore.removeSnoozes(paths.notificationSnoozes, firedSnoozeIds);
        }
        for (const event of currentDueEvents) {
          if (revision !== notificationRefreshRevision) {
            return { failed: false, delivered: 0, snoozes: currentSnoozes };
          }
          if (deliveredIds.has(event.id)
            || snoozedEventIds.has(event.id)
            || notificationService.isSnoozed(currentSnoozes, event.id)) {
            continue;
          }
          if (!showReminderNotification(event)) {
            failed = true;
            continue;
          }
          newlyDelivered.push({ id: event.id, deliveredAt, event });
          deliveredIds.add(event.id);
        }
        await notificationStore.markDeliveredMany(paths.notificationState, newlyDelivered);
        return { failed, delivered: newlyDelivered.length, snoozes: currentSnoozes };
      });
      deliveryFailed = outcome.failed;
      snoozesForWake = outcome.snoozes;
      if (outcome.delivered > 0) {
        sendNotificationsChanged();
      }
    }
    if (revision !== notificationRefreshRevision) {
      return;
    }
    const nextWake = notificationService.getNextWakeTime(events, snoozesForWake, Date.now());
    if (deliveryFailed || nextWake !== null) {
      const delay = deliveryFailed
        ? notificationRetryIntervalMs
        : Math.max(1000, Math.min(maximumNotificationTimeoutMs, nextWake - Date.now()));
      notificationTimer = setTimeout(() => {
        notificationTimer = null;
        refreshNotificationSchedule().catch((error) => {
          console.error('Could not process scheduled desktop reminders.', error);
        });
      }, delay);
    }
  } catch (error) {
    console.error('Could not schedule desktop reminders.', error);
    if (revision === notificationRefreshRevision) {
      notificationTimer = setTimeout(() => {
        notificationTimer = null;
        refreshNotificationSchedule().catch((refreshError) => {
          console.error('Could not retry desktop reminder scheduling.', refreshError);
        });
      }, notificationRetryIntervalMs);
    }
  }
}

function registerTaskIpc() {
  registerUnlockedHandler('notifications:list', () => runTaskOperation(async () => {
    const [settings, tasks, activities, habits, goals] = await Promise.all([
      appSettingsStore.loadSettings(appSettingsFilePath()),
      taskStore.loadTasks(taskFilePath()),
      scheduleStore.loadActivities(scheduleFilePath()),
      habitStore.loadHabits(habitFilePath()),
      goalStore.loadGoals(goalFilePath()),
    ]);
    const snapshot = { settings, tasks, activities, habits, goals };
    const now = Date.now();
    const allEvents = notificationService.buildReminderEvents(snapshot, new Date(now));
    const events = notificationService.getUpcomingEvents(allEvents, now);
    const allEventIds = new Set(allEvents.map((event) => event.id));
    const delivered = new Set(
      (await notificationStore.loadDelivered(notificationStateFilePath())).map((entry) => entry.id),
    );
    const [inbox, unread, snoozes] = await Promise.all([
      notificationStore.loadInbox(notificationStateFilePath()),
      notificationStore.unreadCount(notificationStateFilePath()),
      notificationStore.loadSnoozes(notificationSnoozesFilePath()),
    ]);
    return {
      enabled: snapshot.settings.notificationsEnabled,
      events: events.filter((event) => !delivered.has(event.id)),
      inbox: inbox.map((entry) => ({
        ...entry,
        snoozable: Boolean(entry.event) && allEventIds.has(entry.event.id),
      })),
      unreadCount: unread,
      snoozes,
    };
  }));

  registerUnlockedHandler('notifications:mark-read', (_event, ids) => runTaskOperation(async () => {
    const inbox = ids === 'all'
      ? await notificationStore.markAllRead(notificationStateFilePath())
      : await notificationStore.markRead(notificationStateFilePath(), ids);
    const unread = await notificationStore.unreadCount(notificationStateFilePath());
    sendNotificationsChanged();
    return { inbox, unreadCount: unread };
  }));

  registerUnlockedHandler('notifications:clear-history', () => runTaskOperation(async () => {
    await notificationStore.clearDelivered(notificationStateFilePath());
    sendNotificationsChanged();
    return { inbox: [], unreadCount: 0 };
  }));

  registerUnlockedHandler('notifications:snooze', (_event, id, until) => runTaskOperation(async () => {
    const [settings, tasks, activities, habits, goals] = await Promise.all([
      appSettingsStore.loadSettings(appSettingsFilePath()),
      taskStore.loadTasks(taskFilePath()),
      scheduleStore.loadActivities(scheduleFilePath()),
      habitStore.loadHabits(habitFilePath()),
      goalStore.loadGoals(goalFilePath()),
    ]);
    const events = notificationService.buildReminderEvents(
      { settings, tasks, activities, habits, goals },
    );
    if (!events.some((event) => event.id === id)) {
      throw new Error('This reminder is no longer available.');
    }
    const snoozes = await notificationStore.saveSnooze(notificationSnoozesFilePath(), id, until);
    queueNotificationRefresh();
    return { snoozes };
  }));

  registerUnlockedHandler('notifications:unsnooze', (_event, id) => runTaskOperation(async () => {
    const snoozes = await notificationStore.removeSnoozes(notificationSnoozesFilePath(), [id]);
    queueNotificationRefresh();
    return { snoozes };
  }));

  registerUnlockedHandler('notifications:test', () => {
    const supported = Notification.isSupported();
    const shown = supported && showReminderNotification({
      id: 'test',
      category: 'tasks',
      title: 'TaskForge test notification',
      body: 'Desktop notifications are working for this profile.',
      targetType: 'task',
      targetId: 'test',
      targetDate: null,
    }, false);
    return { supported, shown };
  });

  registerUnlockedHandler('tasks:list', () =>
    runTaskOperation(() => taskStore.loadTasks(taskFilePath())));
  registerUnlockedHandler('tasks:add', (_event, task) =>
    runTrackedDataOperation('tasks', 'Add task', () => taskStore.addTask(taskFilePath(), task)));
  registerUnlockedHandler('tasks:update', (_event, id, task, scope) =>
    runTrackedDataOperation('tasks', 'Edit task', () => taskStore.updateTask(taskFilePath(), id, task, scope)));
  registerUnlockedHandler('tasks:skip', (_event, id, skipped) =>
    runTrackedDataOperation('tasks', skipped === false ? 'Restore occurrence' : 'Skip occurrence',
      () => taskStore.skipTask(taskFilePath(), id, skipped)));
  registerUnlockedHandler('tasks:end-series', (_event, id) =>
    runTrackedDataOperation('tasks', 'End series', () => taskStore.endTaskSeries(taskFilePath(), id)));
  registerUnlockedHandler('tasks:set-completed', (_event, id, completed) =>
    runTrackedDataOperation('tasks', completed ? 'Complete task' : 'Reopen task',
      () => taskStore.setTaskCompleted(taskFilePath(), id, completed)));
  registerUnlockedHandler('tasks:delete', (_event, id) =>
    runTrackedDataOperation('tasks', 'Delete task', () => taskStore.deleteTask(taskFilePath(), id)));
  registerUnlockedHandler('tasks:bulk-complete', (_event, ids, completed) =>
    runTrackedDataOperation('tasks', completed ? 'Bulk complete tasks' : 'Bulk reopen tasks',
      () => taskStore.bulkSetTasksCompleted(taskFilePath(), ids, completed)));
  registerUnlockedHandler('tasks:bulk-delete', (_event, ids) =>
    runTrackedDataOperation('tasks', 'Bulk delete tasks',
      () => taskStore.bulkDeleteTasks(taskFilePath(), ids)));
  registerUnlockedHandler('tasks:bulk-reschedule', (_event, ids, dueDate) =>
    runTrackedDataOperation('tasks', 'Bulk reschedule tasks',
      () => taskStore.bulkRescheduleTasks(taskFilePath(), ids, dueDate)));

  registerUnlockedHandler('schedule:list', () =>
    runTaskOperation(() => scheduleStore.loadActivities(scheduleFilePath())));
  registerUnlockedHandler('schedule:add', (_event, activity, allowOverlap) =>
    runTrackedDataOperation('schedules', 'Add activity',
      () => scheduleStore.addActivity(scheduleFilePath(), activity, allowOverlap)));
  registerUnlockedHandler('schedule:update', (_event, id, activity, allowOverlap, scope) =>
    runTrackedDataOperation('schedules', 'Edit activity',
      () => scheduleStore.updateActivity(scheduleFilePath(), id, activity, allowOverlap, scope)));
  registerUnlockedHandler('schedule:skip', (_event, id, skipped) =>
    runTrackedDataOperation('schedules', skipped === false ? 'Restore occurrence' : 'Skip occurrence',
      () => scheduleStore.skipActivity(scheduleFilePath(), id, skipped)));
  registerUnlockedHandler('schedule:end-series', (_event, id) =>
    runTrackedDataOperation('schedules', 'End series',
      () => scheduleStore.endActivitySeries(scheduleFilePath(), id)));
  registerUnlockedHandler('schedule:set-completed', (_event, id, completed) =>
    runTrackedDataOperation('schedules', completed ? 'Complete activity' : 'Reopen activity',
      () => scheduleStore.setActivityCompleted(scheduleFilePath(), id, completed)));
  registerUnlockedHandler('schedule:delete', (_event, id) =>
    runTrackedDataOperation('schedules', 'Delete activity',
      () => scheduleStore.deleteActivity(scheduleFilePath(), id)));
  registerUnlockedHandler('schedule:bulk-complete', (_event, ids, completed) =>
    runTrackedDataOperation('schedules', completed ? 'Bulk complete activities' : 'Bulk reopen activities',
      () => scheduleStore.bulkSetActivitiesCompleted(scheduleFilePath(), ids, completed)));
  registerUnlockedHandler('schedule:bulk-delete', (_event, ids) =>
    runTrackedDataOperation('schedules', 'Bulk delete activities',
      () => scheduleStore.bulkDeleteActivities(scheduleFilePath(), ids)));

  registerUnlockedHandler('undo:state', () => undoHistory.state());
  registerUnlockedHandler('undo:undo', () => runDataOperation(() => applyHistoryEntry('undo')));
  registerUnlockedHandler('undo:redo', () => runDataOperation(() => applyHistoryEntry('redo')));

  registerUnlockedHandler('habits:list', () =>
    runTaskOperation(() => habitStore.loadHabits(habitFilePath())));
  registerUnlockedHandler('habits:add', (_event, habit) =>
    runDataOperation(() => habitStore.addHabit(habitFilePath(), habit)));
  registerUnlockedHandler('habits:update', (_event, id, habit) =>
    runDataOperation(() => habitStore.updateHabit(habitFilePath(), id, habit)));
  registerUnlockedHandler('habits:set-completion', (_event, id, date, completed) =>
    runDataOperation(() => habitStore.setHabitCompletion(habitFilePath(), id, date, completed)));
  registerUnlockedHandler('habits:set-active', (_event, id, active) =>
    runDataOperation(() => habitStore.setHabitActive(habitFilePath(), id, active)));
  registerUnlockedHandler('habits:delete', (_event, id) =>
    runDataOperation(() => habitStore.deleteHabit(habitFilePath(), id)));
  registerUnlockedHandler('habits:restore', (_event, id) =>
    runDataOperation(() => habitStore.restoreHabit(habitFilePath(), id)));
  registerUnlockedHandler('habits:analytics', (_event, date) =>
    runTaskOperation(() => habitStore.getHabitAnalytics(habitFilePath(), date)));

  registerUnlockedHandler('goals:list', () =>
    runTaskOperation(() => goalStore.loadGoals(goalFilePath())));
  registerUnlockedHandler('goals:add', (_event, goal) =>
    runDataOperation(() => goalStore.addGoal(goalFilePath(), goal)));
  registerUnlockedHandler('goals:update', (_event, id, goal) =>
    runDataOperation(() => goalStore.updateGoal(goalFilePath(), id, goal)));
  registerUnlockedHandler('goals:add-milestone', (_event, id, milestone) =>
    runDataOperation(() => goalStore.addMilestone(goalFilePath(), id, milestone)));
  registerUnlockedHandler('goals:set-milestone-completed', (_event, id, milestoneId, completed) =>
    runDataOperation(() => goalStore.setMilestoneCompleted(goalFilePath(), id, milestoneId, completed)));
  registerUnlockedHandler('goals:delete-milestone', (_event, id, milestoneId) =>
    runDataOperation(() => goalStore.deleteMilestone(goalFilePath(), id, milestoneId)));
  registerUnlockedHandler('goals:set-completed', (_event, id, completed) =>
    runDataOperation(() => goalStore.setGoalCompleted(goalFilePath(), id, completed)));
  registerUnlockedHandler('goals:delete', (_event, id) =>
    runDataOperation(() => goalStore.deleteGoal(goalFilePath(), id)));
  registerUnlockedHandler('goals:restore', (_event, id) =>
    runDataOperation(() => goalStore.restoreGoal(goalFilePath(), id)));
  registerUnlockedHandler('goals:analytics', (_event, date) =>
    runTaskOperation(() => goalStore.getGoalAnalytics(goalFilePath(), date)));

  registerUnlockedHandler('focus:load', () =>
    runFocusOperation(async () => ({
      ...(await focusStore.loadFocusData(focusFilePath())),
      notificationsSupported: Notification.isSupported(),
    })));
  registerUnlockedHandler('focus:save-settings', (_event, settings) =>
    runFocusOperation(() => focusStore.saveSettings(focusFilePath(), settings)));
  registerUnlockedHandler('focus:timer-state', () => runFocusOperation(() => getFocusTimerState()));
  registerUnlockedHandler('focus:timer-start', (_event, mode, remainingMs, sessionMinutes) =>
    runFocusOperation(() => startFocusTimer(mode, remainingMs, sessionMinutes)));
  registerUnlockedHandler('focus:timer-pause', () => runFocusOperation(() => pauseFocusTimer()));
  registerUnlockedHandler('focus:timer-cancel', () => runFocusOperation(() => cancelFocusTimer()));

  registerUnlockedHandler('app:settings-load', () =>
    runTaskOperation(() => appSettingsStore.loadSettings(appSettingsFilePath())));
  registerUnlockedHandler('app:settings-save', (_event, settings) =>
    runDataOperation(() => appSettingsStore.saveSettings(appSettingsFilePath(), settings)));
  registerUnlockedHandler('app:get-version', () => app.getVersion());
  registerUnlockedHandler('app:backup-last', () =>
    runTaskOperation(() => backupStore.readLastBackup(backupStateFilePath())));
  registerUnlockedHandler('app:backup-export', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export TaskForge backup',
      defaultPath: path.join(app.getPath('documents'), `TaskForge-backup-${new Date().toISOString().slice(0, 10)}.json`),
      buttonLabel: 'Save backup',
      filters: [{ name: 'TaskForge backup', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    return runTaskOperation(async () => {
      const backup = await backupStore.createBackup(backupFilePaths());
      await backupStore.writeBackupFile(result.filePath, backup);
      try {
        await backupStore.writeLastBackup(backupStateFilePath(), {
          createdAt: backup.createdAt,
          fileName: path.basename(result.filePath),
        });
      } catch (error) {
        throw new Error(
          `Backup saved to ${result.filePath}, but its last-backup information could not be saved: ${error.message}`,
          { cause: error },
        );
      }
      return {
        canceled: false,
        createdAt: backup.createdAt,
        fileName: path.basename(result.filePath),
        counts: backupStore.getBackupCounts(backup),
      };
    });
  });
  registerUnlockedHandler('app:backup-restore', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a TaskForge backup',
      buttonLabel: 'Validate backup',
      properties: ['openFile'],
      filters: [{ name: 'TaskForge backup', extensions: ['json'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const backupPath = result.filePaths[0];
    const backup = await backupStore.readBackupFile(backupPath);
    const counts = backupStore.getBackupCounts(backup);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Restore TaskForge backup?',
      message: 'Restoring this backup will replace all data in the current profile.',
      detail: `Backup created ${new Date(backup.createdAt).toLocaleString()}.\n\n`
        + `${counts.tasks} tasks · ${counts.schedules} activities · ${counts.focusSessions} focus sessions · `
        + `${counts.habits} habits · ${counts.goals} goals.\n\n`
        + 'A safety backup of your current data will be created before restoration. Continue?',
      buttons: ['Restore backup', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) {
      return { canceled: true };
    }
    pauseNotificationSchedule();
    try {
      const restored = await runTaskOperation(async () => {
        const result = await backupStore.restoreBackup(
          backupFilePaths(),
          backup,
          activeDataPaths().backupsDirectory,
        );
        cancelFocusTimerForProfile(activeProfileId);
        await notificationStore.clearDelivered(notificationStateFilePath());
        await notificationStore.clearSnoozes(notificationSnoozesFilePath());
        clearUndoHistory();
        return result;
      });
      return {
        canceled: false,
        ...restored,
        createdAt: backup.createdAt,
        sourceFileName: path.basename(backupPath),
      };
    } finally {
      queueNotificationRefresh();
    }
  });
  registerUnlockedHandler('app:reset-data', () => runTaskOperation(async () => {
    await cancelFocusTimer();
    pauseNotificationSchedule();
    const paths = activeDataPaths();
    const dataFiles = [
      paths.tasks,
      paths.schedules,
      paths.focus,
      paths.settings,
      paths.habits,
      paths.goals,
      paths.backupState,
      paths.notificationState,
      paths.notificationSnoozes,
    ];
    try {
      for (const filePath of dataFiles) {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
      }
      return { version: app.getVersion() };
    } finally {
      clearUndoHistory();
      queueNotificationRefresh();
    }
  }));
}

function exportFileName(label, extension) {
  return path.join(
    app.getPath('documents'),
    `TaskForge-${label}-${new Date().toISOString().slice(0, 10)}.${extension}`,
  );
}

async function exportWithDialog(options, build) {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title,
    defaultPath: exportFileName(options.label, options.extension),
    buttonLabel: options.buttonLabel,
    filters: [{ name: options.filterName, extensions: [options.extension] }],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  return runDataOperation(async () => {
    const content = await build();
    await fs.writeFile(result.filePath, content, 'utf8');
    return {
      canceled: false,
      fileName: path.basename(result.filePath),
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  });
}

function registerExportIpc() {
  registerUnlockedHandler('export:calendar', async () => {
    let counts;
    const result = await exportWithDialog(
      { title: 'Export TaskForge calendar', label: 'calendar', extension: 'ics', buttonLabel: 'Export calendar', filterName: 'iCalendar' },
      async () => {
        const [tasks, activities] = await Promise.all([
          taskStore.loadTasks(taskFilePath()),
          scheduleStore.loadActivities(scheduleFilePath()),
        ]);
        const profile = getActiveProfileRecord();
        counts = {
          activities: activities.filter((activity) => !activity.skipped).length,
          tasks: tasks.filter((task) => task.dueDate).length,
        };
        return exportService.buildCalendar(tasks, activities, {
          now: new Date(),
          calendarName: profile ? `TaskForge · ${profile.name}` : 'TaskForge',
        });
      },
    );
    return result.canceled ? result : { ...result, counts };
  });

  registerUnlockedHandler('export:tasks-csv', async () => {
    let count;
    const result = await exportWithDialog(
      { title: 'Export tasks as CSV', label: 'tasks', extension: 'csv', buttonLabel: 'Export CSV', filterName: 'CSV spreadsheet' },
      async () => {
        const tasks = await taskStore.loadTasks(taskFilePath());
        count = tasks.length;
        return exportService.buildTasksCsv(tasks);
      },
    );
    return result.canceled ? result : { ...result, count };
  });

  registerUnlockedHandler('export:activities-csv', async () => {
    let count;
    const result = await exportWithDialog(
      { title: 'Export schedule as CSV', label: 'schedule', extension: 'csv', buttonLabel: 'Export CSV', filterName: 'CSV spreadsheet' },
      async () => {
        const activities = await scheduleStore.loadActivities(scheduleFilePath());
        count = activities.length;
        return exportService.buildActivitiesCsv(activities);
      },
    );
    return result.canceled ? result : { ...result, count };
  });
}

function registerProfileIpc() {
  ipcMain.handle('profiles:state', () => getProfileView());
  ipcMain.handle('profiles:create', (_event, input) =>
    runTaskOperation(() => createProfileAndActivate(input)));
  ipcMain.handle('profiles:update', (_event, id, input) =>
    runTaskOperation(() => updateProfileDetails(id, input)));
  ipcMain.handle('profiles:activate', (_event, id, pin) =>
    runTaskOperation(() => activateProfile(id, pin)));
  ipcMain.handle('profiles:set-pin', (_event, id, pin) =>
    runTaskOperation(() => updateActiveProfilePin(id, pin)));
  ipcMain.handle('profiles:lock', () => runTaskOperation(() => lockActiveProfile()));
  ipcMain.handle('profiles:unlock', (_event, pin) =>
    runTaskOperation(() => unlockActiveProfile(pin)));
  ipcMain.handle('profiles:delete', (_event, id) =>
    runTaskOperation(() => deleteProfileById(id)));
}

function runFocusOperation(operation) {
  const profileId = activeProfileId;
  return runTaskOperation(() => {
    if (profileId !== activeProfileId || isActiveProfileLocked()) {
      throw new Error('The active profile changed or is locked. Try again in the current profile.');
    }
    return operation();
  });
}

function toFocusTimerState(session) {
  if (!session) {
    return null;
  }
  const { timer } = session;
  const remainingMs = timer.status === 'running'
    ? Math.max(0, timer.deadline - Date.now())
    : timer.remainingMs;
  return { ...timer, remainingMs };
}

function getFocusTimerState() {
  return toFocusTimerState(focusTimers.get(activeProfileId));
}

function validateTimerInput(mode, remainingMs, sessionMinutes) {
  if (!timerModes.has(mode)) {
    throw new TypeError('Invalid focus timer mode.');
  }
  if (!Number.isInteger(remainingMs) || remainingMs <= 0 || remainingMs > maximumTimerMs) {
    throw new TypeError('Timer duration must be positive and no longer than 180 minutes.');
  }
  if (!Number.isInteger(sessionMinutes)
    || sessionMinutes < focusStore.durationLimits.minimum
    || sessionMinutes > focusStore.durationLimits.maximum) {
    throw new TypeError('Timer session duration must be from 1 to 180 whole minutes.');
  }
}

function cancelFocusTimerForProfile(profileId) {
  const session = focusTimers.get(profileId);
  if (!session) {
    return;
  }
  if (session.timeout) {
    clearTimeout(session.timeout);
  }
  focusTimers.delete(profileId);
}

function installFocusTimer(profileId, savedTimer) {
  cancelFocusTimerForProfile(profileId);
  if (!savedTimer) {
    return null;
  }
  const timer = { ...savedTimer, profileId };
  const session = { timer, timeout: null };
  focusTimers.set(profileId, session);
  if (timer.status === 'running' && !isQuitting) {
    scheduleFocusCompletion(session);
  }
  return session;
}

function scheduleFocusCompletion(session, retryDelay) {
  if (isQuitting) return;
  session.timeout = setTimeout(() => {
    if (isQuitting) return;
    runTaskOperation(() => completeFocusTimer(session.timer)).catch((error) => {
      console.error('Could not save focus timer completion; retrying.', error);
    });
  }, retryDelay ?? Math.max(0, Math.min(maximumTimerMs, session.timer.deadline - Date.now())));
}

async function restoreFocusTimers() {
  for (const profile of profileState.profiles) {
    const paths = profileStore.getProfileDataPaths(app.getPath('userData'), profile.id);
    let data = await focusStore.loadFocusData(paths.focus);
    if (data.activeTimer?.status === 'running' && data.activeTimer.deadline <= Date.now()) {
      data = await focusStore.completeTimer(paths.focus, data.activeTimer.id, { resume: true });
    }
    installFocusTimer(profile.id, data.activeTimer);
  }
}

async function startFocusTimer(mode, remainingMs, sessionMinutes) {
  validateTimerInput(mode, remainingMs, sessionMinutes);
  const timer = {
    id: randomUUID(),
    mode,
    status: 'running',
    remainingMs,
    deadline: Date.now() + remainingMs,
    sessionMinutes,
  };
  const data = await focusStore.saveTimer(focusFilePath(), timer);
  return toFocusTimerState(installFocusTimer(activeProfileId, data.activeTimer));
}

async function pauseFocusTimer() {
  const session = focusTimers.get(activeProfileId);
  if (!session || session.timer.status !== 'running') {
    return toFocusTimerState(session);
  }
  const remainingMs = session.timer.deadline - Date.now();
  if (remainingMs <= 0) {
    await completeFocusTimer(session.timer);
    return getFocusTimerState();
  }
  const timer = { ...session.timer, status: 'paused', remainingMs, deadline: null };
  const data = await focusStore.saveTimer(focusFilePath(), timer);
  return toFocusTimerState(installFocusTimer(activeProfileId, data.activeTimer));
}

async function cancelFocusTimer() {
  await focusStore.saveTimer(focusFilePath(), null);
  cancelFocusTimerForProfile(activeProfileId);
  return null;
}

function showFocusNotification(mode, soundEnabled, notificationsEnabled) {
  if (!notificationsEnabled || !Notification.isSupported()) {
    return;
  }
  const messages = {
    focus: ['Focus session complete', 'Time for a well-earned break.'],
    shortBreak: ['Short break complete', 'Ready to focus again?'],
    longBreak: ['Long break complete', 'Your next focus cycle is ready.'],
  };
  try {
    const [title, body] = messages[mode];
    const notification = new Notification({ title, body, silent: !soundEnabled });
    notification.show();
  } catch (error) {
    console.error('Could not show the focus session notification.', error);
    mainWindow?.webContents.send('focus:notification-error', error.message);
  }
}

async function completeFocusTimer(timer) {
  const session = focusTimers.get(timer.profileId);
  if (!session || session.timer !== timer || timer.status !== 'running') {
    return;
  }
  if (session.timeout) {
    clearTimeout(session.timeout);
    session.timeout = null;
  }
  if (Date.now() < timer.deadline) {
    scheduleFocusCompletion(session);
    return;
  }
  if (!profileState.profiles.some((profile) => profile.id === timer.profileId)) {
    cancelFocusTimerForProfile(timer.profileId);
    return;
  }
  const paths = profileStore.getProfileDataPaths(app.getPath('userData'), timer.profileId);
  let data;
  try {
    data = await focusStore.completeTimer(paths.focus, timer.id);
  } catch (error) {
    if (!isQuitting && focusTimers.get(timer.profileId) === session) {
      scheduleFocusCompletion(session, 5000);
    }
    throw error;
  }
  const nextTimer = toFocusTimerState(installFocusTimer(timer.profileId, data.activeTimer));
  const settings = data.settings;
  const isActiveAndVisible = timer.profileId === activeProfileId && !isActiveProfileLocked();
  if (isActiveAndVisible) {
    try {
      const appSettings = await appSettingsStore.loadSettings(paths.settings);
      showFocusNotification(
        timer.mode,
        settings.soundEnabled,
        notificationService.isCategoryEnabled(appSettings, 'focus'),
      );
    } catch (caughtError) {
      console.error('Could not load notification preferences.', caughtError);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('focus:notification-error', caughtError.message);
      }
    }
  }
  if (isActiveAndVisible && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('focus:timer-finished', {
      profileId: timer.profileId,
      mode: timer.mode,
      stats: data?.stats ?? null,
      error: null,
      nextTimer,
    });
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function requestQuickCapture() {
  pendingCaptureProfileId = activeProfileId;
  showMainWindow();
  if (desktopReady) {
    mainWindow.webContents.send('app:quick-capture');
  }
}

function registerDesktopIpc() {
  ipcMain.handle('app:desktop-ready', () => {
    desktopReady = true;
    return { shortcutRegistered, pendingCapture: pendingCaptureProfileId !== null, trayAvailable: Boolean(tray) };
  });
  ipcMain.handle('app:consume-capture', () => runTaskOperation(() => {
    if (pendingCaptureProfileId !== activeProfileId) {
      pendingCaptureProfileId = null;
    }
    if (!pendingCaptureProfileId || isActiveProfileLocked()) {
      return null;
    }
    pendingCaptureProfileId = null;
    return { profileId: activeProfileId, name: getActiveProfileRecord().name };
  }));
  registerUnlockedHandler('app:quick-capture-add', (_event, profileId, title) => runTrackedDataOperation('tasks', 'Add task', () => {
    if (profileId !== activeProfileId || isActiveProfileLocked()) {
      throw new Error('The active profile changed or is locked. Open quick capture again.');
    }
    return taskStore.addTask(taskFilePath(), { title, description: '', priority: 'Medium', dueDate: null });
  }));
}

function createDesktopControls() {
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'taskforge.ico'));
    tray.setToolTip('TaskForge — Quick capture: Ctrl+Alt+N');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Quick capture (Ctrl+Alt+N)', click: requestQuickCapture },
      { label: 'Open TaskForge', click: showMainWindow },
      { type: 'separator' },
      { label: 'Quit TaskForge', click: () => app.quit() },
    ]));
    tray.on('double-click', showMainWindow);
  } catch (error) {
    tray?.destroy();
    tray = null;
    console.error('Could not create the TaskForge tray menu.', error);
  }
  try {
    shortcutRegistered = globalShortcut.register(captureAccelerator, requestQuickCapture);
  } catch (error) {
    console.error('Could not register the quick capture shortcut.', error);
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 720,
    minHeight: 480,
    icon: path.join(__dirname, 'assets', 'taskforge.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;
  desktopReady = false;
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) desktopReady = false;
  });
  window.webContents.on('render-process-gone', () => { desktopReady = false; });
  window.on('close', (event) => {
    if (tray && !isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  window.loadFile(path.join(__dirname, 'src', 'index.html'));
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (mainWindow) showMainWindow();
  });
  app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.taskforge.desktop');
    }
    await loadProfiles();
    await runTaskOperation(restoreFocusTimers);
    registerTaskIpc();
    registerProfileIpc();
    registerExportIpc();
    registerDesktopIpc();
    createDesktopControls();
    createWindow();
    queueNotificationRefresh();

    powerMonitor.on('resume', () => {
      queueNotificationRefresh();
      for (const session of focusTimers.values()) {
        if (session.timer.status === 'running') {
          clearTimeout(session.timeout);
          scheduleFocusCompletion(session);
        }
      }
    });
    app.on('activate', showMainWindow);
  }).catch((error) => {
    console.error('Could not start TaskForge.', error);
    dialog.showErrorBox('TaskForge could not start', error.message);
    app.quit();
  });
} else {
  app.quit();
}

app.on('window-all-closed', () => {
  if (!tray && process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  isQuitting = true;
  pauseNotificationSchedule();
  for (const session of focusTimers.values()) {
    if (session.timeout) clearTimeout(session.timeout);
  }
  if (!quitReady) {
    event.preventDefault();
    taskOperations.finally(() => {
      quitReady = true;
      app.quit();
    });
  }
});

app.on('will-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
  pauseNotificationSchedule();
  for (const session of focusTimers.values()) {
    if (session.timeout) clearTimeout(session.timeout);
  }
  focusTimers.clear();
});
