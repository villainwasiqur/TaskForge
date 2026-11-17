const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const appSettingsStore = require('../src/app-settings-store');
const backupStore = require('../src/backup-store');
const focusStore = require('../src/focus-store');
const goalStore = require('../src/goal-store');
const habitStore = require('../src/habit-store');
const scheduleStore = require('../src/schedule-store');
const taskStore = require('../src/task-store');

async function createTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-backup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function createFilePaths(directory) {
  return {
    tasks: path.join(directory, 'tasks.json'),
    schedules: path.join(directory, 'schedules.json'),
    focus: path.join(directory, 'focus.json'),
    habits: path.join(directory, 'habits.json'),
    goals: path.join(directory, 'goals.json'),
    settings: path.join(directory, 'settings.json'),
  };
}

function activeTimer() {
  return {
    id: randomUUID(),
    mode: 'focus',
    status: 'running',
    remainingMs: 30 * 60_000,
    deadline: Date.now() + 30 * 60_000,
    sessionMinutes: 30,
  };
}

async function populateData(filePaths, title = 'Original task') {
  await taskStore.addTask(filePaths.tasks, {
    title,
    description: 'Task details',
    priority: 'High',
    dueDate: null,
  });
  await scheduleStore.addActivity(filePaths.schedules, {
    title: 'Planning',
    description: '',
    date: '2026-11-02',
    category: 'Work',
    startTime: '09:00',
    endTime: '10:00',
  });
  await habitStore.addHabit(filePaths.habits, {
    name: 'Read',
    description: '',
    frequency: 'daily',
    weekdays: [],
  });
  await goalStore.addGoal(filePaths.goals, {
    title: 'Ship release',
    description: '',
    category: 'Work',
    term: 'short',
    priority: 'High',
    startDate: '2026-11-02',
    targetDate: '2026-12-01',
    progress: 10,
  });
  await focusStore.saveSettings(filePaths.focus, {
    focusMinutes: 30,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    soundEnabled: false,
  });
  await focusStore.recordFocusSession(filePaths.focus, 30);
  await appSettingsStore.saveSettings(filePaths.settings, {
    ...appSettingsStore.defaultSettings,
    theme: 'purple-haze',
    accentColor: '#00A8FF',
    density: 'compact',
  });
}

test('backup exports every TaskForge data section and round-trips through JSON', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePaths = createFilePaths(directory);
  await populateData(filePaths);
  const timer = activeTimer();
  const focus = await focusStore.saveTimer(filePaths.focus, timer);

  const backup = await backupStore.createBackup(filePaths);
  assert.equal(backup.backupVersion, 2);
  assert.deepEqual(backup.data.focus, { settings: focus.settings, stats: focus.stats });
  assert.deepEqual(Object.keys(backup.data.focus).sort(), ['settings', 'stats']);
  assert.equal(JSON.stringify(backup).includes(timer.id), false);
  assert.deepEqual((await focusStore.loadFocusData(filePaths.focus)).activeTimer, timer);
  assert.equal(backup.application, 'TaskForge');
  assert.equal(backup.backupVersion, backupStore.backupVersion);
  assert.equal(Number.isNaN(Date.parse(backup.createdAt)), false);
  assert.deepEqual(Object.keys(backup.data).sort(), [
    'focus',
    'goals',
    'habits',
    'schedules',
    'settings',
    'tasks',
  ]);
  assert.equal(backup.data.tasks[0].title, 'Original task');
  assert.equal(backup.data.schedules[0].title, 'Planning');
  assert.equal(backup.data.focus.stats.totalCompletedSessions, 1);
  assert.equal(backup.data.habits[0].completionHistory.length, 0);
  assert.equal(backup.data.goals[0].title, 'Ship release');
  assert.equal(backup.data.settings.theme, 'purple-haze');
  assert.deepEqual(backupStore.getBackupCounts(backup), {
    tasks: 1,
    schedules: 1,
    focusSessions: 1,
    habits: 1,
    goals: 1,
  });

  const exportedPath = path.join(directory, 'TaskForge-backup.json');
  await backupStore.writeBackupFile(exportedPath, backup);
  assert.deepEqual(await backupStore.readBackupFile(exportedPath), backup);

  const paused = { ...timer, status: 'paused', deadline: null };
  await focusStore.saveTimer(filePaths.focus, paused);
  const pausedBackup = await backupStore.createBackup(filePaths);
  assert.deepEqual(pausedBackup.data.focus, backup.data.focus);
  assert.equal(JSON.stringify(pausedBackup).includes(timer.id), false);
  assert.deepEqual((await focusStore.loadFocusData(filePaths.focus)).activeTimer, paused);
});

test('backup validation rejects malformed JSON, corrupted sections, and incompatible versions', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = path.join(directory, 'invalid.json');
  await fs.writeFile(filePath, '{invalid JSON', 'utf8');
  await assert.rejects(backupStore.readBackupFile(filePath), /not valid JSON/);

  const filePaths = createFilePaths(path.join(directory, 'data'));
  const backup = await backupStore.createBackup(filePaths);
  assert.throws(
    () => backupStore.validateBackup({ ...backup, backupVersion: backup.backupVersion + 1 }),
    /version is not supported/,
  );
  assert.throws(
    () => backupStore.validateBackup({ ...backup, data: { ...backup.data, goals: [{ title: 'broken' }] } }),
    /goals section is invalid/,
  );
  assert.throws(
    () => backupStore.validateBackup({ ...backup, data: { ...backup.data, settings: { theme: 'crimson' } } }),
    /settings section is invalid/,
  );
  assert.throws(
    () => backupStore.validateBackup({ ...backup, data: { ...backup.data, tasks: undefined } }),
    /incomplete|tasks section/,
  );
});

test('v1 focus backup validation remains strict and rejects portable active timers', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const backup = await backupStore.createBackup(createFilePaths(directory));
  assert.equal(focusStore.validateBackupData(backup.data.focus), backup.data.focus);
  for (const timer of [null, activeTimer(), { ...activeTimer(), status: 'paused', deadline: null }]) {
    const focus = { ...backup.data.focus, activeTimer: timer };
    assert.throws(() => focusStore.validateBackupData(focus), /missing or invalid/);
    assert.throws(
      () => backupStore.validateBackup({ ...backup, data: { ...backup.data, focus } }),
      /focus section is invalid/,
    );
  }
  for (const focus of [
    { ...backup.data.focus, unsupported: true },
    { ...backup.data.focus, settings: { ...backup.data.focus.settings, extra: true } },
    { ...backup.data.focus, stats: { ...backup.data.focus.stats, extra: true } },
  ]) {
    assert.throws(() => focusStore.validateBackupData(focus), /missing or invalid/);
  }
});

test('restore replaces current data, keeps a safety backup, and persists after reload', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const sourcePaths = createFilePaths(path.join(directory, 'source'));
  const destinationPaths = createFilePaths(path.join(directory, 'destination'));
  await populateData(sourcePaths, 'Backed-up task');
  const backup = await backupStore.createBackup(sourcePaths);
  const originalBackupPath = path.join(directory, 'original-backup.json');
  await backupStore.writeBackupFile(originalBackupPath, backup);
  await populateData(destinationPaths, 'Existing task to replace');
  const previousTimer = activeTimer();
  await focusStore.saveTimer(destinationPaths.focus, previousTimer);
  assert.deepEqual(Object.keys(backup.data.focus).sort(), ['settings', 'stats']);
  assert.equal(backup.backupVersion, 2);

  const safetyDirectory = path.join(directory, 'safety-backups');
  const restored = await backupStore.restoreBackup(destinationPaths, backup, safetyDirectory);
  assert.deepEqual(restored.counts, backupStore.getBackupCounts(backup));
  assert.deepEqual(restored.cleanupWarnings, []);
  const safetyFiles = await fs.readdir(safetyDirectory);
  assert.equal(safetyFiles.length, 1);
  assert.match(safetyFiles[0], /^TaskForge-safety-.*\.json$/);
  const safetyBackup = await backupStore.readBackupFile(path.join(safetyDirectory, safetyFiles[0]));
  assert.equal(safetyBackup.data.tasks[0].title, 'Existing task to replace');
  assert.deepEqual(Object.keys(safetyBackup.data.focus).sort(), ['settings', 'stats']);
  assert.equal(JSON.stringify(safetyBackup).includes(previousTimer.id), false);
  assert.deepEqual(await backupStore.readBackupFile(originalBackupPath), backup);

  assert.equal((await taskStore.loadTasks(destinationPaths.tasks))[0].title, 'Backed-up task');
  assert.equal((await scheduleStore.loadActivities(destinationPaths.schedules))[0].title, 'Planning');
  const restoredFocus = await focusStore.loadFocusData(destinationPaths.focus);
  assert.deepEqual(restoredFocus, { ...backup.data.focus, activeTimer: null });
  assert.equal((await focusStore.completeTimer(destinationPaths.focus, previousTimer.id)).activeTimer, null);
  assert.equal((await habitStore.loadHabits(destinationPaths.habits))[0].name, 'Read');
  assert.equal((await goalStore.loadGoals(destinationPaths.goals))[0].title, 'Ship release');
  assert.equal((await appSettingsStore.loadSettings(destinationPaths.settings)).theme, 'purple-haze');
});

test('invalid backups never modify existing records or create a safety snapshot', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePaths = createFilePaths(path.join(directory, 'data'));
  await populateData(filePaths, 'Keep this task');
  const malformedBackup = {
    ...(await backupStore.createBackup(filePaths)),
    data: { tasks: [{ id: 'invalid' }] },
  };
  await assert.rejects(
    backupStore.restoreBackup(filePaths, malformedBackup, path.join(directory, 'safety')),
    /incomplete|tasks section/,
  );
  assert.equal((await taskStore.loadTasks(filePaths.tasks))[0].title, 'Keep this task');
  await assert.rejects(fs.access(path.join(directory, 'safety')));
});

test('a failed multi-file installation rolls all existing data back', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const sourcePaths = createFilePaths(path.join(directory, 'source'));
  const destinationPaths = createFilePaths(path.join(directory, 'destination'));
  await populateData(sourcePaths, 'Backup task');
  await populateData(destinationPaths, 'Keep after rollback');
  const previousFocus = await focusStore.saveTimer(destinationPaths.focus, activeTimer());
  const backup = await backupStore.createBackup(sourcePaths);
  let failedInstallation = false;
  const fileSystem = {
    mkdir: (...args) => fs.mkdir(...args),
    writeFile: (...args) => fs.writeFile(...args),
    unlink: (...args) => fs.unlink(...args),
    rename: async (from, to) => {
      if (!failedInstallation
        && to === destinationPaths.settings
        && from.includes('.restore-')
        && from.endsWith('.tmp')) {
        failedInstallation = true;
        throw new Error('simulated disk write failure');
      }
      return fs.rename(from, to);
    },
  };
  await assert.rejects(
    backupStore.restoreBackup(
      destinationPaths,
      backup,
      path.join(directory, 'safety'),
      undefined,
      fileSystem,
    ),
    /existing data was rolled back/,
  );
  assert.equal(failedInstallation, true);
  assert.deepEqual(await focusStore.loadFocusData(destinationPaths.focus), previousFocus);
  assert.equal((await taskStore.loadTasks(destinationPaths.tasks))[0].title, 'Keep after rollback');
  assert.equal((await goalStore.loadGoals(destinationPaths.goals))[0].title, 'Ship release');
  assert.equal((await appSettingsStore.loadSettings(destinationPaths.settings)).theme, 'purple-haze');
  const files = await fs.readdir(path.join(directory, 'safety'));
  assert.equal(files.length, 1);
});

test('last backup metadata is persistent and validated', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = path.join(directory, 'backup-state.json');
  assert.equal(await backupStore.readLastBackup(filePath), null);
  const metadata = { createdAt: new Date().toISOString(), fileName: 'TaskForge-backup.json' };
  await backupStore.writeLastBackup(filePath, metadata);
  assert.deepEqual(await backupStore.readLastBackup(filePath), metadata);
});

test('v2 recurring tasks and schedules round-trip IDs, completion history, skips and ended series', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const source = createFilePaths(path.join(directory, 'source'));
  const destination = createFilePaths(path.join(directory, 'destination'));
  const recurrence = { frequency: 'daily', interval: 1, weekdays: [], count: 4, until: null };
  const tasks = await taskStore.addTask(source.tasks, {
    title: 'Daily task', dueDate: '2026-11-02', recurrence,
  });
  const { activities } = await scheduleStore.addActivity(source.schedules, {
    title: 'Daily activity', date: '2026-11-02', startTime: '09:00', endTime: '10:00', recurrence,
  });
  assert.equal(tasks.length, 4);
  assert.equal(activities.length, 4);
  await taskStore.setTaskCompleted(source.tasks, tasks[0].id, true);
  await taskStore.skipTask(source.tasks, tasks[1].id);
  await scheduleStore.setActivityCompleted(source.schedules, activities[0].id, true);
  await scheduleStore.skipActivity(source.schedules, activities[1].id);
  const endedTasks = await taskStore.endTaskSeries(source.tasks, tasks[2].id);
  const endedActivities = await scheduleStore.endActivitySeries(source.schedules, activities[2].id);
  for (const [rows, originals] of [[endedTasks, tasks], [endedActivities, activities]]) {
    assert.deepEqual(rows.map((row) => row.id), originals.slice(0, 3).map((row) => row.id));
    assert.equal(rows[0].completed, true);
    assert.ok(rows[0].completedAt);
    assert.equal(rows[1].skipped, true);
    assert.equal(rows[2].completed, false);
    assert.ok(rows.every((row) => row.recurrence.ended === true));
  }
  const timer = activeTimer();
  await focusStore.saveTimer(source.focus, timer);
  const backup = await backupStore.createBackup(source);
  assert.equal(backup.backupVersion, 2);
  assert.deepEqual(backup.data.tasks, endedTasks);
  assert.deepEqual(backup.data.schedules, endedActivities);
  assert.equal(JSON.stringify(backup).includes(timer.id), false);
  const exportedPath = path.join(directory, 'recurring-backup.json');
  await backupStore.writeBackupFile(exportedPath, backup);
  await backupStore.restoreBackup(destination, await backupStore.readBackupFile(exportedPath),
    path.join(directory, 'safety'));
  for (let reload = 0; reload < 2; reload += 1) {
    assert.deepEqual((await backupStore.createBackup(destination)).data, backup.data);
    assert.equal((await focusStore.loadFocusData(destination.focus)).activeTimer, null);
  }
});

test('malformed recurrence and v1 recurrence claims never modify destination files', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePaths = createFilePaths(path.join(directory, 'destination'));
  await populateData(filePaths, 'Keep all destination data');
  const backup = await backupStore.createBackup(filePaths);
  const before = await Promise.all(Object.values(filePaths).map((filePath) => fs.readFile(filePath, 'utf8')));
  const safety = path.join(directory, 'safety');
  const recurrence = {
    frequency: 'daily', interval: 1, weekdays: [], count: 3, until: null,
    seriesId: randomUUID(), startDate: '2026-11-02', occurrenceDate: '2026-11-02',
  };
  for (const section of ['tasks', 'schedules']) {
    const recurring = {
      ...backup.data[section][0], recurrence, skipped: false,
      ...(section === 'tasks' ? { dueDate: '2026-11-02' } : {}),
    };
    // Check that the seed is valid before corrupting a single recurrence field.
    backupStore.validateBackup({ ...backup, data: { ...backup.data, [section]: [recurring] } });
    for (const patch of [
      { interval: 0 }, { frequency: 'hourly' }, { seriesId: 'invalid' },
      { occurrenceDate: '2026-02-30' }, { ended: 'yes' },
    ]) {
      const invalid = {
        ...backup,
        data: { ...backup.data, [section]: [{ ...recurring, recurrence: { ...recurrence, ...patch } }] },
      };
      await assert.rejects(backupStore.restoreBackup(filePaths, invalid, safety), /section is invalid/i);
    }
    for (const row of [recurring, { ...backup.data[section][0], skipped: true }]) {
      await assert.rejects(backupStore.restoreBackup(filePaths, {
        ...backup, backupVersion: 1, data: { ...backup.data, [section]: [row] },
      }, safety), /version 2/i);
    }
  }
  assert.deepEqual(await Promise.all(Object.values(filePaths).map((filePath) => fs.readFile(filePath, 'utf8'))), before);
  await assert.rejects(fs.access(safety), { code: 'ENOENT' });
});

test('legacy v1 backups restore non-recurring data and export again as v2', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const source = createFilePaths(path.join(directory, 'source'));
  const destination = createFilePaths(path.join(directory, 'destination'));
  await populateData(source, 'Legacy task');
  await populateData(destination, 'Replace this task');
  const legacy = { ...await backupStore.createBackup(source), backupVersion: 1 };
  assert.ok([...legacy.data.tasks, ...legacy.data.schedules].every((row) => !row.recurrence && !row.skipped));
  const exportedPath = path.join(directory, 'legacy-v1.json');
  await backupStore.writeBackupFile(exportedPath, legacy);
  const restored = await backupStore.restoreBackup(destination, await backupStore.readBackupFile(exportedPath),
    path.join(directory, 'safety'));
  assert.deepEqual(restored.counts, backupStore.getBackupCounts(legacy));
  const reexported = await backupStore.createBackup(destination);
  assert.equal(reexported.backupVersion, 2);
  assert.deepEqual(reexported.data, legacy.data);
});

test('atomic persistence in exclusive mode rejects destination collisions and preserves target data', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const targetPath = path.join(directory, 'exclusive-safety.json');
  const initialContent = JSON.stringify({ safety: 'initial' });
  await backupStore.writeAtomically(targetPath, initialContent, true);
  assert.equal(await fs.readFile(targetPath, 'utf8'), initialContent);

  await assert.rejects(
    backupStore.writeAtomically(targetPath, JSON.stringify({ safety: 'overwrite' }), true),
    (error) => error.code === 'EEXIST',
  );

  assert.equal(await fs.readFile(targetPath, 'utf8'), initialContent);
  const files = await fs.readdir(directory);
  assert.deepEqual(files, ['exclusive-safety.json']);
});

test('atomic write cleans up temporary staging files on write failure', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const blockingFile = path.join(directory, 'blocker');
  await fs.writeFile(blockingFile, 'blocking');
  const invalidTarget = path.join(blockingFile, 'sub', 'target.json');

  await assert.rejects(
    backupStore.writeAtomically(invalidTarget, '{"test":1}', true),
  );

  const files = await fs.readdir(directory);
  assert.deepEqual(files, ['blocker']);
  assert.equal(files.some((name) => name.endsWith('.tmp')), false);
});
