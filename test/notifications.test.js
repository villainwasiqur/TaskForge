const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const appSettingsStore = require('../src/app-settings-store');
const notificationService = require('../src/notification-service');
const notificationStore = require('../src/notification-store');
const taskStore = require('../src/task-store');
const scheduleStore = require('../src/schedule-store');

const today = '2026-11-02';
const habitId = '11111111-1111-4111-8111-111111111111';

function createReminderSettings(overrides = {}) {
  return {
    ...appSettingsStore.defaultSettings,
    ...overrides,
    notificationCategories: {
      ...appSettingsStore.defaultSettings.notificationCategories,
      ...overrides.notificationCategories,
    },
    reminderTiming: {
      ...appSettingsStore.defaultSettings.reminderTiming,
      ...overrides.reminderTiming,
    },
  };
}

function createReminderData(settings = createReminderSettings()) {
  return {
    settings,
    tasks: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Prepare release',
        description: '',
        dueDate: '2026-11-03',
        reminderAt: '2026-11-02T10:00:00.000Z',
        completed: false,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Finished task',
        description: '',
        dueDate: '2026-11-03',
        reminderAt: '2026-11-02T10:00:00.000Z',
        completed: true,
      },
    ],
    activities: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        title: 'Planning',
        date: today,
        startTime: '10:00',
        completed: false,
        reminderMinutesBefore: null,
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        title: 'Custom activity',
        date: today,
        startTime: '10:00',
        completed: false,
        reminderMinutesBefore: 30,
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        title: 'Completed activity',
        date: today,
        startTime: '10:00',
        completed: true,
        reminderMinutesBefore: 15,
      },
    ],
    habits: [
      {
        id: habitId,
        name: 'Read',
        active: true,
        archivedAt: null,
        completionHistory: [],
        activePeriods: [{ startDate: '2026-10-01', endDate: null }],
        schedulePeriods: [{
          startDate: '2026-10-01',
          endDate: null,
          frequency: 'weekly',
          weekdays: [1, 3, 5],
        }],
      },
      {
        id: '77777777-7777-4777-8777-777777777777',
        name: 'Already done',
        active: true,
        archivedAt: null,
        completionHistory: [today],
        activePeriods: [{ startDate: '2026-10-01', endDate: null }],
        schedulePeriods: [{
          startDate: '2026-10-01',
          endDate: null,
          frequency: 'daily',
          weekdays: [],
        }],
      },
    ],
    goals: [
      {
        id: '88888888-8888-4888-8888-888888888888',
        title: 'Ship the release',
        targetDate: '2026-11-09',
        status: 'active',
      },
      {
        id: '99999999-9999-4999-8999-999999999999',
        title: 'Completed goal',
        targetDate: '2026-11-09',
        status: 'completed',
      },
    ],
  };
}

async function createTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-notification-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('notification settings migrate old preferences and validate categories and timing', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const filePath = path.join(directory, 'settings.json');
  await fs.writeFile(filePath, JSON.stringify({
    theme: 'crimson',
    clockFormat: '24-hour',
    notificationsEnabled: false,
  }));
  const migrated = await appSettingsStore.loadSettings(filePath);
  assert.equal(migrated.theme, 'crimson');
  assert.equal(migrated.notificationsEnabled, false);
  assert.deepEqual(migrated.notificationCategories, appSettingsStore.defaultSettings.notificationCategories);
  assert.deepEqual(migrated.reminderTiming, appSettingsStore.defaultSettings.reminderTiming);

  const saved = await appSettingsStore.saveSettings(filePath, {
    ...migrated,
    notificationCategories: { ...migrated.notificationCategories, habits: false },
    reminderTiming: { ...migrated.reminderTiming, habitReminderTime: '07:30' },
  });
  assert.equal(saved.notificationCategories.habits, false);
  assert.equal((await appSettingsStore.loadSettings(filePath)).reminderTiming.habitReminderTime, '07:30');
  await assert.rejects(appSettingsStore.saveSettings(filePath, {
    ...saved,
    notificationCategories: { ...saved.notificationCategories, focus: 'yes' },
  }), TypeError);
  await assert.rejects(appSettingsStore.saveSettings(filePath, {
    ...saved,
    reminderTiming: { ...saved.reminderTiming, scheduleReminderMinutesBefore: 3 },
  }), TypeError);
});

test('reminder planner covers task, activity, schedule-based habit, and goal events in local time', () => {
  const now = new Date(2026, 10, 2, 8, 0, 0);
  const events = notificationService.buildReminderEvents(createReminderData(), now);
  const byId = new Map(events.map((event) => [event.id, event]));

  assert.equal(byId.get('task:22222222-2222-4222-8222-222222222222:deadline:2026-11-02').at,
    new Date(2026, 10, 2, 9, 0, 0).getTime());
  assert.deepEqual(
    {
      targetType: byId.get('task:22222222-2222-4222-8222-222222222222:deadline:2026-11-02').targetType,
      targetId: byId.get('task:22222222-2222-4222-8222-222222222222:deadline:2026-11-02').targetId,
      targetDate: byId.get('task:22222222-2222-4222-8222-222222222222:deadline:2026-11-02').targetDate,
    },
    {
      targetType: 'task',
      targetId: '22222222-2222-4222-8222-222222222222',
      targetDate: '2026-11-03',
    },
  );
  assert.equal(byId.get('task:22222222-2222-4222-8222-222222222222:custom:2026-11-02T10:00:00.000Z').at,
    Date.parse('2026-11-02T10:00:00.000Z'));
  assert.equal(byId.has('task:33333333-3333-4333-8333-333333333333:deadline:2026-11-02'), false);
  assert.equal(byId.get('activity:44444444-4444-4444-8444-444444444444:start:2026-11-02:10:00:15').at,
    new Date(2026, 10, 2, 9, 45, 0).getTime());
  assert.equal(
    byId.get('activity:44444444-4444-4444-8444-444444444444:start:2026-11-02:10:00:15').targetType,
    'activity',
  );
  assert.equal(byId.get('activity:55555555-5555-4555-8555-555555555555:start:2026-11-02:10:00:30').at,
    new Date(2026, 10, 2, 9, 30, 0).getTime());
  assert.equal(byId.has('activity:66666666-6666-4666-8666-666666666666:start:2026-11-02:10:00:15'), false);
  assert.equal(byId.has(`habit:${habitId}:${today}`), true);
  assert.equal(byId.has('habit:77777777-7777-4777-8777-777777777777:2026-11-02'), false);
  assert.equal(byId.has('goal:88888888-8888-4888-8888-888888888888:deadline:2026-11-02'), true);
  assert.equal(byId.has('goal:99999999-9999-4999-8999-999999999999:deadline:2026-11-02'), false);

  const futureHabitReminder = byId.get(`habit:${habitId}:2026-11-04`);
  assert.equal(futureHabitReminder.body, 'This habit is next scheduled for 2026-11-04.');
  assert.equal(futureHabitReminder.at, new Date(2026, 10, 4, 9, 0, 0).getTime());
  assert.equal(futureHabitReminder.targetId, habitId);
  assert.equal(futureHabitReminder.targetDate, '2026-11-04');
});

test('global and category switches suppress only their configured reminders', () => {
  const allDisabled = createReminderSettings({ notificationsEnabled: false });
  assert.deepEqual(notificationService.buildReminderEvents(createReminderData(allDisabled)), []);
  assert.equal(notificationService.isCategoryEnabled(allDisabled, 'focus'), false);

  const categoriesDisabled = createReminderSettings({
    notificationCategories: {
      tasks: false,
      schedule: false,
      habits: false,
      goals: false,
      focus: false,
    },
  });
  assert.deepEqual(notificationService.buildReminderEvents(createReminderData(categoriesDisabled)), []);

  const focusOnly = createReminderSettings({
    notificationCategories: {
      tasks: false,
      schedule: false,
      habits: false,
      goals: false,
      focus: true,
    },
  });
  assert.equal(notificationService.buildReminderEvents(createReminderData(focusOnly)).length, 0);
  assert.equal(notificationService.isCategoryEnabled(focusOnly, 'focus'), true);
});

test('missed reminder grace avoids stale notifications and finds the next future event', () => {
  const event = { id: 'event', at: 1000 };
  assert.deepEqual(notificationService.getDueEvents([event], 1000 + 15 * 60 * 1000).length, 1);
  assert.deepEqual(notificationService.getDueEvents([event], 1000 + 15 * 60 * 1000 + 1), []);
  assert.equal(notificationService.getNextEvent([
    { id: 'past', at: 1000 },
    { id: 'future', at: 2000 },
  ], 1500).id, 'future');
});

test('notification center includes due and next-week reminders, excluding stale events', () => {
  const now = 100_000;
  const events = [
    { id: 'due', at: now - 1_000 },
    { id: 'future', at: now + notificationService.notificationCenterHorizonMs },
    { id: 'too-far', at: now + notificationService.notificationCenterHorizonMs + 1 },
    { id: 'stale', at: now - notificationService.reminderGraceMs - 1 },
  ];

  assert.deepEqual(
    notificationService.getUpcomingEvents(events, now).map((event) => event.id),
    ['due', 'future'],
  );
});

test('notification delivery ledger prevents duplicates after restart', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const statePath = path.join(directory, 'notification-state.json');
  assert.equal(await notificationStore.wasDelivered(statePath, 'task:one:deadline'), false);
  assert.equal(await notificationStore.markDelivered(statePath, 'task:one:deadline'), true);
  assert.equal(await notificationStore.wasDelivered(statePath, 'task:one:deadline'), true);
  assert.equal(await notificationStore.markDelivered(statePath, 'task:one:deadline'), false);
  assert.equal((await notificationStore.loadDelivered(statePath)).length, 1);
});

test('skipped generated occurrences have no reminders while pending IDs remain independently deliverable', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const taskPath = path.join(directory, 'tasks.json');
  const schedulePath = path.join(directory, 'schedules.json');
  const statePath = path.join(directory, 'notification-state.json');
  const recurrence = { frequency: 'daily', interval: 1, weekdays: [], count: 3, until: null };
  const tasks = await taskStore.addTask(taskPath, {
    title: 'Recurring task', dueDate: today, reminderAt: '2026-11-02T10:00:00.000Z', recurrence,
  });
  const scheduled = await scheduleStore.addActivity(schedulePath, {
    title: 'Recurring activity', date: today, startTime: '10:00', endTime: '11:00',
    reminderMinutesBefore: 30, recurrence,
  });
  assert.equal(tasks.length, 3);
  assert.equal(scheduled.saved, true);
  const activities = scheduled.activities;
  assert.equal(activities.length, 3);
  await taskStore.skipTask(taskPath, tasks[1].id);
  await scheduleStore.skipActivity(schedulePath, activities[1].id);
  const now = new Date(2026, 10, 2, 8);
  const loadEvents = async () => notificationService.buildReminderEvents({
    settings: createReminderSettings(), habits: [], goals: [],
    tasks: await taskStore.loadTasks(taskPath),
    activities: await scheduleStore.loadActivities(schedulePath),
  }, now);
  const events = await loadEvents();
  assert.equal(events.length, 8);
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  assert.ok(events.every((event) => ![tasks[1].id, activities[1].id].includes(event.targetId)));
  for (const index of [0, 2]) {
    const taskEvents = events.filter((event) => event.targetId === tasks[index].id);
    assert.deepEqual(taskEvents.map((event) => event.id.split(':')[2]).sort(), ['custom', 'deadline', 'overdue']);
    assert.ok(taskEvents.some((event) => event.id === `task:${tasks[index].id}:custom:${tasks[index].reminderAt}`));
    assert.ok(taskEvents.filter((event) => event.id.includes(':deadline:') || event.id.includes(':overdue:'))
      .every((event) => event.targetDate === tasks[index].dueDate));
    const activityEvents = events.filter((event) => event.targetId === activities[index].id);
    assert.equal(activityEvents.length, 1);
    assert.equal(activityEvents[0].id, `activity:${activities[index].id}:start:${activities[index].date}:10:00:30`);
  }
  const delivered = events.filter((event) => [tasks[0].id, activities[0].id].includes(event.targetId));
  assert.equal((await notificationStore.markDeliveredMany(statePath, delivered.map((event) => ({
    id: event.id, deliveredAt: new Date().toISOString(),
  })))).length, 4);
  const reloaded = await loadEvents();
  assert.deepEqual(reloaded, events);
  for (const event of reloaded) {
    const wasDelivered = delivered.some((previous) => previous.id === event.id);
    assert.equal(await notificationStore.wasDelivered(statePath, event.id), wasDelivered);
    assert.equal(await notificationStore.markDelivered(statePath, event.id), !wasDelivered);
  }
  assert.equal((await notificationStore.loadDelivered(statePath)).length, events.length);
});

test('notification delivery ledger batches writes and ignores duplicate IDs', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const statePath = path.join(directory, 'notification-state.json');
  const markedIds = await notificationStore.markDeliveredMany(statePath, [
    { id: 'task:one:deadline', deliveredAt: new Date().toISOString() },
    { id: 'task:two:deadline', deliveredAt: new Date().toISOString() },
    { id: 'task:one:deadline', deliveredAt: new Date().toISOString() },
  ]);
  assert.deepEqual(markedIds, ['task:one:deadline', 'task:two:deadline']);
  assert.deepEqual(
    (await notificationStore.loadDelivered(statePath)).map((entry) => entry.id),
    ['task:one:deadline', 'task:two:deadline'],
  );
  assert.deepEqual(await notificationStore.markDeliveredMany(statePath, []), []);
  await assert.rejects(
    notificationStore.markDeliveredMany(statePath, [{ id: '', deliveredAt: 'invalid' }]),
    /Notification delivery records are invalid/,
  );
});

function deliveredEvent(overrides = {}) {
  return {
    id: 'task:22222222-2222-4222-8222-222222222222:deadline:2026-11-02',
    category: 'tasks',
    title: 'Upcoming deadline: Prepare release',
    body: 'Due 2026-11-03.',
    at: new Date(2026, 10, 2, 9, 0, 0).getTime(),
    targetType: 'task',
    targetId: '22222222-2222-4222-8222-222222222222',
    targetDate: '2026-11-03',
    ...overrides,
  };
}

test('notification inbox keeps delivered metadata, read state, and legacy compatibility', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const statePath = path.join(directory, 'notification-state.json');
  const olderEvent = deliveredEvent();
  const newerEvent = deliveredEvent({
    id: 'goal:88888888-8888-4888-8888-888888888888:deadline:2026-11-02',
    category: 'goals',
    title: 'Upcoming goal deadline: Ship the release',
    body: 'Target date 2026-11-09.',
    targetType: 'goal',
    targetId: '88888888-8888-4888-8888-888888888888',
    targetDate: '2026-11-09',
  });
  const older = new Date('2026-11-02T09:05:00.000Z').toISOString();
  const newer = new Date('2026-11-02T09:10:00.000Z').toISOString();
  await notificationStore.markDeliveredMany(statePath, [
    { id: olderEvent.id, deliveredAt: older, event: olderEvent },
    { id: 'legacy:delivered', deliveredAt: newer },
    { id: newerEvent.id, deliveredAt: newer, event: newerEvent },
  ]);

  const inbox = await notificationStore.loadInbox(statePath);
  assert.deepEqual(inbox.map((entry) => entry.id), [newerEvent.id, olderEvent.id]);
  assert.equal(inbox[0].readAt, null);
  assert.deepEqual(inbox.find((entry) => entry.id === olderEvent.id).event, olderEvent);
  assert.equal(await notificationStore.unreadCount(statePath), 2);
  assert.equal(await notificationStore.wasDelivered(statePath, 'legacy:delivered'), true);

  const read = await notificationStore.markRead(statePath, [olderEvent.id]);
  const readOlder = read.find((entry) => entry.id === olderEvent.id);
  assert.ok(readOlder.readAt);
  assert.equal(await notificationStore.unreadCount(statePath), 1);
  const repeated = await notificationStore.markRead(statePath, [olderEvent.id]);
  assert.equal(repeated.find((entry) => entry.id === olderEvent.id).readAt, readOlder.readAt);
  await assert.rejects(notificationStore.markRead(statePath, []), /identifiers are invalid/);
  await assert.rejects(notificationStore.markRead(statePath, ['same', 'same']), /identifiers are invalid/);
  await assert.rejects(notificationStore.markRead(statePath, [42]), /identifiers are invalid/);

  const allRead = await notificationStore.markAllRead(statePath);
  assert.ok(allRead.every((entry) => entry.readAt));
  assert.equal(await notificationStore.unreadCount(statePath), 0);
  assert.equal((await notificationStore.loadInbox(statePath)).length, 2);
});

test('notification history rejects invalid entries and excludes legacy records from the inbox', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const statePath = path.join(directory, 'notification-state.json');
  await assert.rejects(notificationStore.markDeliveredMany(statePath, [{
    id: 'event',
    deliveredAt: new Date().toISOString(),
    event: { ...deliveredEvent(), category: 'unknown' },
  }]), /records are invalid/);
  await assert.rejects(notificationStore.markDeliveredMany(statePath, [{
    id: 'event',
    deliveredAt: 'yesterday',
  }]), /records are invalid/);

  await fs.writeFile(statePath, JSON.stringify([
    { id: 'legacy:one', deliveredAt: new Date().toISOString() },
  ]));
  assert.deepEqual(await notificationStore.loadInbox(statePath), []);
  assert.equal(await notificationStore.unreadCount(statePath), 0);
  assert.equal(await notificationStore.wasDelivered(statePath, 'legacy:one'), true);
});

test('notification snoozes validate targets, are bounded, and can be removed in batches', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const snoozePath = path.join(directory, 'notification-snoozes.json');
  const until = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(await notificationStore.loadSnoozes(snoozePath), {});
  assert.deepEqual(
    await notificationStore.saveSnooze(snoozePath, 'event:one', until),
    { 'event:one': until },
  );
  await assert.rejects(notificationStore.saveSnooze(snoozePath, 'event:two', 'tomorrow'), /invalid/i);
  await assert.rejects(notificationStore.saveSnooze(snoozePath, '', until), /invalid/i);
  assert.deepEqual(await notificationStore.removeSnoozes(snoozePath, ['event:one', 'event:missing']), {});

  const capped = Object.fromEntries(
    Array.from({ length: 500 }, (_value, index) => [`event:${index}`, until]),
  );
  await fs.writeFile(snoozePath, JSON.stringify(capped));
  await assert.rejects(
    notificationStore.saveSnooze(snoozePath, 'event:extra', until),
    /Too many snoozed reminders/,
  );
  assert.equal(Object.keys(await notificationStore.saveSnooze(snoozePath, 'event:0', until)).length, 500);
  await notificationStore.clearSnoozes(snoozePath);
  assert.deepEqual(await notificationStore.loadSnoozes(snoozePath), {});
});

test('snooze helpers track active, expired, stale, and next wake times', () => {
  const events = [
    { id: 'event:past', at: 1_000 },
    { id: 'event:future', at: 4_000 },
  ];
  const expiredUntil = new Date(2_000).toISOString();
  const futureUntil = new Date(5_000).toISOString();
  const now = 3_000;

  assert.equal(notificationService.isSnoozed({ 'event:past': futureUntil }, 'event:past', now), true);
  assert.equal(notificationService.isSnoozed({ 'event:past': expiredUntil }, 'event:past', now), false);
  assert.equal(notificationService.isSnoozed({}, 'event:past', now), false);

  const snoozes = {
    'event:past': expiredUntil,
    'event:future': futureUntil,
    'event:missing': expiredUntil,
  };
  assert.deepEqual(
    notificationService.getExpiredSnoozes(events, snoozes, now).map((entry) => entry.deliveryId),
    [notificationService.snoozeDeliveryId('event:past', expiredUntil)],
  );
  assert.deepEqual(notificationService.getStaleSnoozeIds(events, snoozes), ['event:missing']);
  assert.equal(notificationService.getNextWakeTime(events, snoozes, now), 4_000);
  assert.equal(
    notificationService.getNextWakeTime([events[0]], { 'event:past': futureUntil }, now),
    5_000,
  );
  assert.equal(
    notificationService.getNextWakeTime([events[0]], { 'event:missing': futureUntil }, now),
    null,
  );
});
