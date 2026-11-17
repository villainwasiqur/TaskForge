const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const taskStore = require('../src/task-store');
const scheduleStore = require('../src/schedule-store');

const {
  getLocalDateKey,
  getTimestampDateKey,
  summarizeActivityAnalytics,
  summarizeTaskAnalytics,
} = require('../src/analytics-service');

function localTimestamp(dateKey, hour = 12) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day, hour).toISOString();
}

function weekDatesFor(now) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_unused, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return date;
  });
}

test('local date helpers use calendar days and ignore invalid timestamps', () => {
  const date = new Date(2026, 10, 10, 23, 30);
  assert.equal(getLocalDateKey(date), '2026-11-10');
  assert.equal(getTimestampDateKey(date.toISOString()), '2026-11-10');
  assert.equal(getTimestampDateKey(null), null);
  assert.equal(getTimestampDateKey(''), null);
  assert.equal(getTimestampDateKey('not a date'), null);
});

test('task analytics only count completed tasks and ignore stale completion timestamps', () => {
  const now = new Date(2026, 10, 10, 12);
  const weekDates = weekDatesFor(now);
  const tasks = [
    {
      id: 'completed-today',
      completed: true,
      createdAt: localTimestamp('2026-11-10', 8),
      completedAt: localTimestamp('2026-11-10', 11),
    },
    {
      id: 'reopened-today',
      completed: false,
      createdAt: localTimestamp('2026-11-10', 8),
      completedAt: localTimestamp('2026-11-10', 9),
    },
    {
      id: 'completed-earlier-week',
      completed: true,
      createdAt: localTimestamp('2026-11-09', 8),
      completedAt: localTimestamp('2026-11-09', 10),
    },
    {
      id: 'completed-last-week',
      completed: true,
      createdAt: localTimestamp('2026-11-02', 8),
      completedAt: localTimestamp('2026-11-02', 10),
    },
    {
      id: 'pending-created-this-week',
      completed: false,
      createdAt: localTimestamp('2026-11-10', 7),
      completedAt: null,
    },
  ];

  const summary = summarizeTaskAnalytics(tasks, {
    today: getLocalDateKey(now),
    weekDates,
  });

  assert.equal(summary.todayTaskCount, 3);
  assert.equal(summary.tasksCompletedToday, 1);
  assert.equal(summary.completedTodayTasksCreatedToday, 1);
  assert.equal(summary.pendingTasks, 2);
  assert.equal(summary.weeklyCompletedTaskCount, 2);
  assert.equal(summary.weeklyTaskPoolSize, 4);
  assert.deepEqual(summary.taskWeekCounts, {
    '2026-11-09': 1,
    '2026-11-10': 1,
    '2026-11-11': 0,
    '2026-11-12': 0,
    '2026-11-13': 0,
    '2026-11-14': 0,
    '2026-11-15': 0,
  });
});

test('activity analytics require a completed flag alongside the completion timestamp', () => {
  const now = new Date(2026, 10, 10, 12);
  const activities = [
    {
      id: 'completed-today',
      date: '2026-11-10',
      completed: true,
      completedAt: localTimestamp('2026-11-10', 9),
    },
    {
      id: 'reopened-today',
      date: '2026-11-10',
      completed: false,
      completedAt: localTimestamp('2026-11-10', 10),
    },
    {
      id: 'completed-other-day',
      date: '2026-11-09',
      completed: true,
      completedAt: localTimestamp('2026-11-09', 10),
    },
  ];

  const summary = summarizeActivityAnalytics(activities, {
    today: getLocalDateKey(now),
  });

  assert.deepEqual(summary, {
    todayActivityCount: 2,
    activitiesCompletedToday: 1,
    completedScheduledToday: 1,
  });
});

test('generated task dates, not precreation timestamps or skips, determine analytics pools', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-analytics-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'tasks.json');
  const now = new Date();
  const today = getLocalDateKey(now);
  const weekDates = weekDatesFor(now);
  const recurrence = { frequency: 'daily', interval: 7, weekdays: [], count: 3, until: null };
  const generated = await taskStore.addTask(filePath, { title: 'Weekly task', dueDate: today, recurrence });
  assert.equal(generated.length, 3);
  assert.ok(generated.every((row) => getTimestampDateKey(row.createdAt) === today));
  assert.ok(generated.slice(1).every((row) => row.dueDate > getLocalDateKey(weekDates.at(-1))));
  await taskStore.setTaskCompleted(filePath, generated[0].id, true);
  const withSkipped = await taskStore.addTask(filePath, {
    title: 'Skip today', dueDate: today, recurrence: { ...recurrence, count: 1 },
  });
  await taskStore.skipTask(filePath, withSkipped.at(-1).id);
  await taskStore.addTask(filePath, { title: 'Ordinary pending task' });
  const tasks = await taskStore.loadTasks(filePath);
  const summary = summarizeTaskAnalytics(tasks, { today, weekDates });
  assert.equal(summary.todayTaskCount, 2);
  assert.equal(summary.tasksCompletedToday, 1);
  assert.equal(summary.completedTodayTasksCreatedToday, 1);
  assert.equal(summary.weeklyTaskPoolSize, 2);
  assert.equal(summary.weeklyCompletedTaskCount, 1);
  assert.equal(summary.pendingTasks, 3);
  assert.deepEqual(summary.taskWeekCounts, Object.fromEntries(weekDates.map((date) => {
    const key = getLocalDateKey(date);
    return [key, key === today ? 1 : 0];
  })));
  assert.deepEqual(summary, summarizeTaskAnalytics(tasks.filter((row) => !row.skipped), { today, weekDates }));
});

test('generated activity skips and future dates do not enter today completion denominators', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-analytics-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'schedules.json');
  const today = getLocalDateKey(new Date());
  const recurrence = { frequency: 'daily', interval: 1, weekdays: [], count: 3, until: null };
  const input = { title: 'Daily activity', date: today, startTime: '09:00', endTime: '10:00', recurrence };
  const generated = await scheduleStore.addActivity(filePath, input);
  assert.equal(generated.saved, true);
  assert.equal(generated.activities.length, 3);
  await scheduleStore.setActivityCompleted(filePath, generated.activities[0].id, true);
  const skipped = await scheduleStore.addActivity(filePath, {
    ...input, startTime: '11:00', endTime: '12:00', recurrence: { ...recurrence, count: 1 },
  });
  assert.equal(skipped.saved, true);
  await scheduleStore.skipActivity(filePath, skipped.activities.at(-1).id);
  const pending = await scheduleStore.addActivity(filePath, {
    title: 'Ordinary pending activity', date: today, startTime: '13:00', endTime: '14:00',
  });
  assert.equal(pending.saved, true);
  const activities = await scheduleStore.loadActivities(filePath);
  const summary = summarizeActivityAnalytics(activities, { today });
  assert.deepEqual(summary, { todayActivityCount: 2, activitiesCompletedToday: 1, completedScheduledToday: 1 });
  assert.deepEqual(summary, summarizeActivityAnalytics(activities.filter((row) => !row.skipped), { today }));
});

test('analytics input validation rejects malformed collections and dates', () => {
  assert.throws(() => summarizeTaskAnalytics(null, { today: '2026-11-10', weekDates: [new Date()] }), /list/);
  assert.throws(() => summarizeTaskAnalytics([], { weekDates: [new Date()] }), /today date key/);
  assert.throws(() => summarizeTaskAnalytics([], { today: '2026-11-10', weekDates: [] }), /Week dates/);
  assert.throws(() => summarizeActivityAnalytics(null, { today: '2026-11-10' }), /list/);
  assert.throws(() => summarizeActivityAnalytics([], {}), /today date key/);
});
