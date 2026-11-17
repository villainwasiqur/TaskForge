const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const taskStore = require('../src/task-store');
const scheduleStore = require('../src/schedule-store');

async function temporaryFile(t, name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-bulk-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

const recurrence = { frequency: 'daily', interval: 1, weekdays: [], count: 3, until: null };

test('bulk task completion is atomic, preserves other rows, and rejects skipped selections', async (t) => {
  const filePath = await temporaryFile(t, 'tasks.json');
  const rows = await taskStore.addTask(filePath, { title: 'Daily', dueDate: '2026-11-02', recurrence });
  const oneOff = (await taskStore.addTask(filePath, { title: 'One-off' })).at(-1);
  const ids = [rows[0].id, oneOff.id];
  const completed = await taskStore.bulkSetTasksCompleted(filePath, ids, true);
  assert.equal(completed.find((row) => row.id === rows[0].id).completed, true);
  assert.equal(completed.find((row) => row.id === oneOff.id).completed, true);
  assert.ok(completed.find((row) => row.id === rows[0].id).completedAt);
  assert.deepEqual(completed.find((row) => row.id === rows[1].id), rows[1]);
  const reopened = await taskStore.bulkSetTasksCompleted(filePath, ids, false);
  assert.ok(ids.every((id) => reopened.find((row) => row.id === id).completed === false));
  assert.ok(ids.every((id) => reopened.find((row) => row.id === id).completedAt === null));

  await taskStore.skipTask(filePath, rows[1].id);
  const before = await fs.readFile(filePath, 'utf8');
  await assert.rejects(taskStore.bulkSetTasksCompleted(filePath, [rows[1].id], true), /skipped/i);
  await assert.rejects(taskStore.bulkSetTasksCompleted(filePath, [rows[0].id, rows[1].id], false), /skipped/i);
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
});

test('bulk task delete skips recurring occurrences and removes one-offs atomically', async (t) => {
  const filePath = await temporaryFile(t, 'tasks.json');
  const rows = await taskStore.addTask(filePath, { title: 'Daily', dueDate: '2026-11-02', recurrence });
  const oneOff = (await taskStore.addTask(filePath, { title: 'One-off' })).at(-1);
  const keeper = (await taskStore.addTask(filePath, { title: 'Keeper' })).at(-1);
  const result = await taskStore.bulkDeleteTasks(filePath, [rows[0].id, oneOff.id]);
  assert.deepEqual(result.map((row) => row.id), [rows[0].id, rows[1].id, rows[2].id, keeper.id]);
  assert.equal(result[0].skipped, true);
  assert.equal(result[1].skipped, false);

  await assert.rejects(taskStore.bulkDeleteTasks(filePath, [rows[1].id, oneOff.id]), /not found/i);
  await taskStore.setTaskCompleted(filePath, rows[1].id, true);
  const before = await fs.readFile(filePath, 'utf8');
  await assert.rejects(taskStore.bulkDeleteTasks(filePath, [rows[1].id]), /completed occurrence cannot be skipped/i);
  await assert.rejects(taskStore.bulkDeleteTasks(filePath, [rows[2].id, rows[2].id]), /duplicate/i);
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
});

test('bulk reschedule shifts dates and reminders, clears dates, and rejects recurring rows', async (t) => {
  const filePath = await temporaryFile(t, 'tasks.json');
  const rows = await taskStore.addTask(filePath, {
    title: 'Reminder task', dueDate: '2026-11-02', reminderAt: new Date(2026, 10, 2, 9, 30).toISOString(),
  });
  const plain = (await taskStore.addTask(filePath, { title: 'Plain', dueDate: '2026-11-05' })).at(-1);
  const recurring = (await taskStore.addTask(filePath, {
    title: 'Daily', dueDate: '2026-11-02', recurrence,
  })).slice(-3);
  const ids = [rows[0].id, plain.id];
  const moved = await taskStore.bulkRescheduleTasks(filePath, ids, '2026-11-20');
  const movedReminder = moved.find((row) => row.id === rows[0].id);
  assert.equal(movedReminder.dueDate, '2026-11-20');
  const reminderDate = new Date(movedReminder.reminderAt);
  assert.equal(reminderDate.getDate(), 20);
  assert.equal(reminderDate.getHours(), 9);
  assert.equal(reminderDate.getMinutes(), 30);
  assert.equal(moved.find((row) => row.id === plain.id).reminderAt, null);
  assert.deepEqual(moved.find((row) => row.id === recurring[0].id), recurring[0]);

  const cleared = await taskStore.bulkRescheduleTasks(filePath, ids, null);
  assert.ok(ids.every((id) => cleared.find((row) => row.id === id).dueDate === null));
  assert.equal(cleared.find((row) => row.id === rows[0].id).reminderAt, movedReminder.reminderAt);

  const before = await fs.readFile(filePath, 'utf8');
  await assert.rejects(taskStore.bulkRescheduleTasks(filePath, [recurring[0].id], '2026-11-21'), /recurring/i);
  await assert.rejects(taskStore.bulkRescheduleTasks(filePath, ids, '2026-02-30'), /valid calendar date/i);
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
});

test('bulk activity completion and deletion mirror single-item semantics atomically', async (t) => {
  const filePath = await temporaryFile(t, 'schedules.json');
  const { activities } = await scheduleStore.addActivity(filePath, {
    title: 'Daily', date: '2026-11-02', startTime: '09:00', endTime: '10:00', recurrence,
  });
  const oneOff = (await scheduleStore.addActivity(filePath, {
    title: 'One-off', date: '2026-11-02', startTime: '11:00', endTime: '12:00',
  })).activities.at(-1);
  const ids = [activities[0].id, oneOff.id];
  const completed = await scheduleStore.bulkSetActivitiesCompleted(filePath, ids, true);
  assert.ok(ids.every((id) => completed.find((row) => row.id === id).completed));
  await scheduleStore.setActivityCompleted(filePath, activities[0].id, false);
  const deleted = await scheduleStore.bulkDeleteActivities(filePath, ids);
  assert.deepEqual(deleted.map((row) => row.id), [activities[0].id, activities[1].id, activities[2].id]);
  assert.equal(deleted[0].skipped, true);

  await scheduleStore.skipActivity(filePath, activities[1].id);
  const before = await fs.readFile(filePath, 'utf8');
  await assert.rejects(scheduleStore.bulkSetActivitiesCompleted(filePath, [activities[1].id], true), /skipped/i);
  await assert.rejects(scheduleStore.bulkDeleteActivities(filePath, [oneOff.id]), /not found/i);
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
});

test('bulk validation rejects empty, oversized, malformed, and duplicate selections', async (t) => {
  const filePath = await temporaryFile(t, 'tasks.json');
  const rows = await taskStore.addTask(filePath, { title: 'Task' });
  const id = rows[0].id;
  for (const bad of [[], 'not-a-list', [id, id], ['invalid'], Array.from({ length: 1001 }, () => id)]) {
    await assert.rejects(taskStore.bulkSetTasksCompleted(filePath, bad, true), TypeError);
    await assert.rejects(taskStore.bulkDeleteTasks(filePath, bad), TypeError);
    await assert.rejects(taskStore.bulkRescheduleTasks(filePath, bad, null), TypeError);
    await assert.rejects(scheduleStore.bulkSetActivitiesCompleted(filePath, bad, true), TypeError);
    await assert.rejects(scheduleStore.bulkDeleteActivities(filePath, bad), TypeError);
  }
  await assert.rejects(taskStore.bulkSetTasksCompleted(filePath, [id], 'yes'), /true or false/i);
  await assert.rejects(scheduleStore.bulkSetActivitiesCompleted(filePath, [id], 'yes'), /true or false/i);
});

test('replace helpers validate snapshots before writing', async (t) => {
  const taskPath = await temporaryFile(t, 'tasks.json');
  const schedulePath = await temporaryFile(t, 'schedules.json');
  const rows = await taskStore.addTask(taskPath, { title: 'Task' });
  await taskStore.replaceTasks(taskPath, []);
  assert.deepEqual(await taskStore.loadTasks(taskPath), []);
  await taskStore.replaceTasks(taskPath, rows);
  assert.deepEqual(await taskStore.loadTasks(taskPath), rows);
  await assert.rejects(taskStore.replaceTasks(taskPath, [{ id: 'bad' }]), TypeError);
  assert.deepEqual(await taskStore.loadTasks(taskPath), rows);
  await assert.rejects(scheduleStore.replaceActivities(schedulePath, null), TypeError);
  assert.deepEqual(await scheduleStore.loadActivities(schedulePath), []);
});