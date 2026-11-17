const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const recurrence = require('../src/recurrence');
const tasks = require('../src/task-store');
const schedule = require('../src/schedule-store');

const daily = (count = 3, extra = {}) => ({
  frequency: 'daily', interval: 1, weekdays: [], count, until: null, ...extra,
});
const taskInput = (extra = {}) => ({ title: 'Recurring task', dueDate: '2026-01-01', ...extra });
const activityInput = (extra = {}) => ({
  title: 'Recurring activity', date: '2026-01-01', startTime: '09:00', endTime: '10:00', ...extra,
});

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-recurrence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const stores = [
  {
    name: 'tasks', date: 'dueDate', input: taskInput, load: tasks.loadTasks,
    add: tasks.addTask, update: tasks.updateTask, complete: tasks.setTaskCompleted,
    skip: tasks.skipTask, end: tasks.endTaskSeries, delete: tasks.deleteTask,
    validate: tasks.validateBackupTasks,
  },
  {
    name: 'activities', date: 'date', input: activityInput, load: schedule.loadActivities,
    add: async (...args) => (await schedule.addActivity(...args)).activities,
    update: async (file, id, input, scope) => {
      const result = await schedule.updateActivity(file, id, input, false, scope);
      assert.equal(result.saved, true);
      return result.activities;
    },
    complete: schedule.setActivityCompleted, skip: schedule.skipActivity,
    end: schedule.endActivitySeries, delete: schedule.deleteActivity,
    validate: schedule.validateBackupActivities,
  },
];

const byId = (rows, id) => rows.find((row) => row.id === id);
const dates = (rows) => rows.map((row) => row.recurrence.occurrenceDate);

test('generators use calendar dates, leap years, inclusive bounds, and Sunday-based interval weeks', () => {
  assert.deepEqual(recurrence.generateDates('2024-02-28', daily()), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.deepEqual(recurrence.generateDates('2026-12-31', daily(2)), ['2026-12-31', '2027-01-01']);
  assert.deepEqual(recurrence.generateDates('2026-01-01', daily(3, { interval: 2 })),
    ['2026-01-01', '2026-01-03', '2026-01-05']);
  assert.deepEqual(recurrence.generateDates('2026-01-01', daily(null, { until: '2026-01-03' })),
    ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(recurrence.generateDates('2026-01-31', daily(4, { frequency: 'monthly' })),
    ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  assert.deepEqual(recurrence.generateDates('2024-02-29', daily(2, { frequency: 'monthly', interval: 12 })),
    ['2024-02-29', '2028-02-29']);
  assert.deepEqual(recurrence.generateDates('2026-01-07', daily(5, {
    frequency: 'weekly', interval: 2, weekdays: [5, 1, 5],
  })), ['2026-01-09', '2026-01-19', '2026-01-23', '2026-02-02', '2026-02-06']);
  assert.deepEqual(recurrence.generateDates('2026-01-07', daily(2, { frequency: 'weekly' })),
    ['2026-01-07', '2026-01-14']);
  assert.deepEqual(recurrence.generateDates('0000-02-28', daily()), ['0000-02-28', '0000-02-29', '0000-03-01']);
  assert.deepEqual(recurrence.generateDates('0099-12-31', daily(2)), ['0099-12-31', '0100-01-01']);
  assert.deepEqual(recurrence.generateDates('2026-01-01', daily(2), new Set(['2026-01-02'])),
    ['2026-01-01', '2026-01-03']);
});

test('rule normalization and generation enforce finite counts, calendar horizon, and field types', () => {
  assert.equal(recurrence.normalizeRule(null, null), null);
  assert.equal(recurrence.normalizeRule(undefined, null), null);
  assert.deepEqual(recurrence.normalizeRule({ ...daily(), seriesId: 'untrusted', ended: true }, '2026-01-01'), daily());
  for (const rule of [
    [], true, 'daily', {}, daily(0), daily(1001), daily(1.5), daily('3'),
    daily(null), daily(3, { until: '2026-02-01' }), daily(3, { frequency: 'yearly' }),
    daily(3, { interval: 0 }), daily(3, { interval: 366 }), daily(3, { interval: '1' }),
    daily(3, { interval: 1.5 }), daily(3, { weekdays: [1] }),
    daily(3, { frequency: 'weekly', weekdays: [7] }),
    daily(3, { frequency: 'weekly', weekdays: [-1] }),
    daily(3, { frequency: 'weekly', weekdays: ['1'] }),
    daily(3, { frequency: 'weekly', weekdays: null }),
    daily(3, { frequency: 'weekly', weekdays: Array(8).fill(1) }),
    daily(null, { until: '2026-02-30' }), daily(null, { until: '2025-12-31' }),
    daily(null, { until: '2031-01-02' }),
  ]) {
    assert.throws(() => recurrence.normalizeRule(rule, '2026-01-01'), TypeError);
  }
  assert.throws(() => recurrence.normalizeRule(daily(), null), /anchor/);
  for (const invalid of ['2026-02-29', '2026-13-01', '2026-1-01', '', null, 20260101]) {
    assert.equal(recurrence.isValidDate(invalid), false);
  }
  assert.equal(recurrence.generateDates('2026-01-01', daily(1000)).length, 1000);
  assert.throws(() => recurrence.generateDates('2026-01-01', daily(null, { until: '2031-01-01' })), /1000/);
  assert.equal(recurrence.generateDates('2024-02-29', daily(null, {
    frequency: 'monthly', until: '2029-02-28',
  })).at(-1), '2029-01-29');
  assert.throws(() => recurrence.normalizeRule(daily(null, { until: '2029-03-01' }), '2024-02-29'), /anniversary/);
  for (const frequency of ['daily', 'weekly', 'monthly']) {
    assert.throws(() => recurrence.generateDates('9999-12-31', daily(2, { frequency })), /calendar/);
  }
  assert.throws(() => recurrence.generateDates('2026-01-01', daily(null, {
    frequency: 'weekly', weekdays: [1], until: '2026-01-02',
  })), /at least one/);
  assert.throws(() => recurrence.shiftReminder('invalid', '2026-01-01', '2026-01-02'), TypeError);
});

test('TZ subprocesses keep task reminder clocks from the original anchor across DST and conversions', async (t) => {
  const directory = await temporaryDirectory(t);
  const script = `
    const assert = require('node:assert/strict');
    const tasks = require(process.argv[1]);
    const recurrence = require(process.argv[2]);
    const path = require('node:path');
    const directory = process.argv[3];
    const zone = process.env.TZ;
    const rule = { frequency: 'daily', interval: 1, weekdays: [], count: 4, until: null };
    (async () => {
      const scenarios = [
        ['spring', '2026-03-07', '2026-03-06', 9, 15],
        ['gap', '2026-03-07', '2026-03-07', 2, 30],
        ['fall', '2026-10-31', '2026-10-31', 1, 30],
      ];
      for (const [name, anchor, reminderDate, hour, minute] of scenarios) {
        const original = new Date(reminderDate + 'T' + String(hour).padStart(2, '0') + ':' + minute + ':00');
        const file = path.join(directory, zone.replaceAll('/', '-') + '-' + name + '.json');
        let rows = await tasks.addTask(file, { title: name, dueDate: anchor, reminderAt: original.toISOString(), recurrence: rule });
        for (let index = 0; index < rows.length; index += 1) {
          const expected = new Date(original);
          expected.setDate(expected.getDate() + index);
          assert.equal(rows[index].reminderAt, expected.toISOString());
          assert.equal(new Date(rows[index].reminderAt).getMinutes(), minute);
        }
        if (zone === 'America/New_York' && name === 'gap') {
          assert.equal(new Date(rows[1].reminderAt).getHours(), 3);
          assert.equal(new Date(rows[2].reminderAt).getHours(), 2);
        }
        if (zone === 'America/New_York' && name === 'spring') {
          assert.equal(Date.parse(rows[2].reminderAt) - Date.parse(rows[1].reminderAt), 23 * 3600000);
        }
        if (zone === 'America/New_York' && name === 'fall') {
          assert.equal(Date.parse(rows[2].reminderAt) - Date.parse(rows[1].reminderAt), 25 * 3600000);
        }
        assert.deepEqual(await tasks.loadTasks(file), rows);
        const selected = rows[1];
        rows = await tasks.updateTask(file, selected.id, { ...selected, recurrence: rule }, 'series');
        const future = rows.filter(row => row.recurrence.startDate === selected.dueDate);
        for (let index = 0; index < future.length; index += 1) {
          const expected = new Date(selected.reminderAt);
          expected.setDate(expected.getDate() + index);
          assert.equal(future[index].reminderAt, expected.toISOString());
        }
      }
      const file = path.join(directory, zone.replaceAll('/', '-') + '-converted.json');
      const original = new Date('2026-03-06T09:15:00').toISOString();
      let rows = await tasks.addTask(file, { title: 'Convert', dueDate: '2026-03-07', reminderAt: original });
      rows = await tasks.updateTask(file, rows[0].id, { ...rows[0], recurrence: rule });
      assert.equal(rows[2].reminderAt, recurrence.shiftReminder(original, '2026-03-07', '2026-03-09'));
      // Weekly anchors need not themselves be occurrences; reminder offsets still use the submitted anchor.
      const weekly = await tasks.addTask(path.join(directory, zone.replaceAll('/', '-') + '-weekly.json'), {
        title: 'Weekly', dueDate: '2026-03-07', reminderAt: original,
        recurrence: { ...rule, frequency: 'weekly', weekdays: [1], count: 2 },
      });
      assert.equal(weekly[0].dueDate, '2026-03-09');
      assert.equal(weekly[0].reminderAt, recurrence.shiftReminder(original, '2026-03-07', '2026-03-09'));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  for (const TZ of ['America/New_York', 'Pacific/Honolulu', 'Pacific/Kiritimati']) {
    execFileSync(process.execPath, ['-e', script, require.resolve('../src/task-store'),
      require.resolve('../src/recurrence'), directory], { env: { ...process.env, TZ }, stdio: 'pipe' });
  }
});

for (const store of stores) {
  test(`${store.name}: legacy reads preserve exact bytes and oneoff CRUD semantics`, async (t) => {
    const directory = await temporaryDirectory(t);
    const file = path.join(directory, 'legacy.json');
    const now = '2026-01-01T00:00:00.000Z';
    const legacy = {
      ...store.input(), id: randomUUID(), description: '', priority: 'Medium', category: '',
      completed: false, createdAt: now, updatedAt: now,
    };
    const bytes = `  ${JSON.stringify([legacy])}\r\n`;
    await fs.writeFile(file, bytes);
    assert.deepEqual(await store.load(file), [legacy]);
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    assert.equal(Object.hasOwn((await store.load(file))[0], 'recurrence'), false);
    let rows = await store.update(file, legacy.id, store.input({ title: 'Edited' }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Edited');
    await assert.rejects(store.skip(file, legacy.id), /recurring/);
    await assert.rejects(store.end(file, legacy.id), /recurring/);
    rows = await store.complete(file, legacy.id, true);
    assert.ok(rows[0].completedAt);
    rows = await store.complete(file, legacy.id, false);
    assert.equal(rows[0].completedAt, null);
    assert.deepEqual(await store.delete(file, legacy.id), []);
  });

  test(`${store.name}: materialized CRUD ignores untrusted state, preserves metadata, and skips instead of deleting`, async (t) => {
    const file = path.join(await temporaryDirectory(t), 'records.json');
    let rows = await store.add(file, store.input({
      recurrence: { ...daily(), seriesId: randomUUID(), startDate: '1900-01-01', ended: true },
      id: 'forged', completed: true, completedAt: 'bad', skipped: true, createdAt: 'bad', arbitrary: true,
    }));
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => row.id)).size, 3);
    assert.equal(new Set(rows.map((row) => row.recurrence.seriesId)).size, 1);
    assert.deepEqual(dates(rows), ['2026-01-01', '2026-01-02', '2026-01-03']);
    assert.ok(rows.every((row) => !row.completed && row.completedAt === null && !row.skipped
      && !row.recurrence.ended && row.arbitrary === undefined));
    const first = rows[0];
    const last = rows[2];
    rows = await store.complete(file, first.id, true);
    assert.ok(byId(rows, first.id).completedAt);
    await assert.rejects(store.skip(file, first.id), /completed/);
    rows = await store.complete(file, first.id, false);
    assert.equal(byId(rows, first.id).completedAt, null);
    rows = await store.delete(file, last.id);
    assert.equal(rows.length, 3);
    assert.equal(byId(rows, last.id).skipped, true);
    for (const completed of [true, false]) await assert.rejects(store.complete(file, last.id, completed), /skipped/);
    const skipped = byId(rows, last.id);
    rows = await store.update(file, last.id, store.input({
      [store.date]: '2026-02-01', title: 'Moved skipped occurrence', recurrence: 'ignore invalid rule',
      skipped: false, completed: true, id: first.id,
    }));
    assert.deepEqual(byId(rows, last.id).recurrence, skipped.recurrence);
    assert.equal(byId(rows, last.id).skipped, true);
    assert.equal(byId(rows, last.id).completed, false);
    assert.deepEqual(byId(rows, first.id).recurrence, first.recurrence);
    rows = await store.skip(file, last.id, false);
    assert.equal(byId(rows, last.id).skipped, false);
    rows = await store.update(file, first.id, store.input({ recurrence: null }));
    assert.deepEqual(byId(rows, first.id).recurrence, first.recurrence);
    assert.deepEqual(await store.load(file), rows);
    assert.equal(store.validate(rows), rows);
  });

  test(`${store.name}: conversion retains identity, creation and completion history`, async (t) => {
    const file = path.join(await temporaryDirectory(t), 'records.json');
    let rows = await store.add(file, store.input());
    rows = await store.complete(file, rows[0].id, true);
    const original = rows[0];
    rows = await store.update(file, original.id, store.input({ recurrence: daily(3) }));
    assert.equal(rows.length, 3);
    assert.equal(rows[0].id, original.id);
    assert.equal(rows[0].createdAt, original.createdAt);
    assert.equal(rows[0].completedAt, original.completedAt);
    assert.equal(rows[0].completed, true);
    assert.ok(rows.slice(1).every((row) => !row.completed));
    assert.deepEqual(await store.load(file), rows);
  });

  test(`${store.name}: series edits preserve earlier/completed/skipped rows and matching IDs`, async (t) => {
    const file = path.join(await temporaryDirectory(t), 'records.json');
    let rows = await store.add(file, store.input({ recurrence: daily(6) }));
    const original = rows.slice();
    rows = await store.complete(file, original[2].id, true);
    rows = await store.skip(file, original[3].id);
    const history = [rows[0], rows[2], rows[3]];
    // Moving an occurrence does not change the cutoff used by future edits.
    rows = await store.update(file, original[1].id, store.input({ [store.date]: '2026-01-10' }));
    const selected = byId(rows, original[1].id);
    const before = await fs.readFile(file);
    await assert.rejects(store.update(file, selected.id,
      store.input({ [store.date]: '2026-01-01', recurrence: daily(2) }), 'series'), /before.*original/);
    assert.deepEqual(await fs.readFile(file), before);
    for (const record of history.slice(1)) {
      await assert.rejects(store.update(file, record.id,
        store.input({ [store.date]: record[store.date], recurrence: daily(2) }), 'series'), /pending/);
    }
    await assert.rejects(store.update(file, selected.id,
      store.input({ [store.date]: '2026-01-02', recurrence: null }), 'series'), /remain recurring/);
    rows = await store.update(file, selected.id, store.input({
      [store.date]: '2026-01-02', title: 'Future only', recurrence: daily(3),
    }), 'series');
    for (const record of history) assert.deepEqual(byId(rows, record.id), record);
    for (const record of [original[1], original[4], original[5]]) {
      const updated = byId(rows, record.id);
      assert.equal(updated.title, 'Future only');
      assert.equal(updated.createdAt, record.createdAt);
      assert.equal(updated.recurrence.seriesId, record.recurrence.seriesId);
    }
    assert.equal(byId(rows, selected.id)[store.date], '2026-01-02');
    assert.deepEqual(await store.load(file), rows);
  });

  test(`${store.name}: forward series edits replace only pending future and end never resurrects rows`, async (t) => {
    const file = path.join(await temporaryDirectory(t), 'records.json');
    let rows = await store.add(file, store.input({ recurrence: daily(7) }));
    const original = rows.slice();
    rows = await store.complete(file, original[5].id, true);
    rows = await store.skip(file, original[6].id);
    const history = [rows[0], rows[5], rows[6]];
    rows = await store.update(file, original[1].id, store.input({
      [store.date]: '2026-01-04', recurrence: daily(2),
    }), 'series');
    assert.equal(byId(rows, original[1].id), undefined);
    assert.equal(byId(rows, original[2].id), undefined);
    for (const record of history) assert.deepEqual(byId(rows, record.id), record);
    const selected = byId(rows, original[3].id);
    rows = await store.end(file, selected.id);
    assert.deepEqual(new Set(rows.map((row) => row.id)), new Set([...history.map((row) => row.id), selected.id]));
    assert.ok(rows.every((row) => row.recurrence.ended === true));
    assert.equal(byId(rows, original[5].id).completedAt, history[1].completedAt);
    assert.equal(byId(rows, original[6].id).skipped, true);
    const endedBytes = await fs.readFile(file);
    assert.deepEqual(await store.load(file), rows);
    assert.deepEqual(await fs.readFile(file), endedBytes);
    await assert.rejects(store.update(file, selected.id,
      store.input({ [store.date]: selected[store.date], recurrence: daily(10) }), 'series'), /ended/);
    assert.deepEqual(await fs.readFile(file), endedBytes);
    rows = await store.update(file, selected.id, store.input({ [store.date]: selected[store.date], title: 'Still editable' }));
    rows = await store.complete(file, selected.id, true);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.recurrence.ended));
    assert.deepEqual(await store.load(file), rows);
  });

  test(`${store.name}: invalid input and scopes are atomic and do not create missing files`, async (t) => {
    const file = path.join(await temporaryDirectory(t), 'records.json');
    await assert.rejects(store.add(file, store.input({ recurrence: daily(1001) })), TypeError);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    if (store.name === 'tasks') {
      await assert.rejects(store.add(file, store.input({ dueDate: null, recurrence: daily() })), /anchor/);
    }
    const rows = await store.add(file, store.input({ recurrence: daily() }));
    const before = await fs.readFile(file);
    for (const scope of ['future', '', null, {}, true]) {
      await assert.rejects(store.update(file, rows[0].id, store.input(), scope), /scope/);
    }
    await assert.rejects(store.skip(file, rows[0].id, 'true'), /Skipped status/);
    await assert.rejects(store.complete(file, rows[0].id, 'true'), /Completion status/);
    for (const method of [store.skip, store.end, store.delete]) {
      await assert.rejects(method(file, 'not-an-id'), /identifier/);
      await assert.rejects(method(file, randomUUID()), /not found/);
    }
    await assert.rejects(store.update(file, rows[0].id, store.input({ title: '' })), /title/);
    if (store.name === 'tasks') {
      await assert.rejects(store.update(file, rows[0].id, store.input({ dueDate: null })), TypeError);
    }
    assert.deepEqual(await fs.readFile(file), before);
  });

  test(`${store.name}: malformed metadata and duplicate identities preserve corrupt bytes`, async (t) => {
    const directory = await temporaryDirectory(t);
    const seedFile = path.join(directory, 'seed.json');
    const seed = await store.add(seedFile, store.input({ recurrence: daily() }));
    const mutations = [
      (rows) => { rows[0].recurrence.seriesId = 'bad'; },
      (rows) => { rows[0].recurrence.startDate = '2026-02-30'; },
      (rows) => { rows[0].recurrence.occurrenceDate = '2025-12-31'; },
      (rows) => { rows[0].recurrence.interval = 0; },
      (rows) => { rows[0].recurrence.count = 1001; },
      (rows) => { rows[0].recurrence.until = '2026-01-31'; },
      (rows) => { rows[0].recurrence.extra = 'untrusted'; },
      (rows) => { rows[0].recurrence.ended = 'true'; },
      (rows) => { rows[0].recurrence.ended = true; },
      (rows) => { rows[0].skipped = 'true'; },
      (rows) => { delete rows[0].skipped; },
      (rows) => { rows[0].skipped = true; rows[0].completed = true; },
      (rows) => { rows[0].recurrence = null; rows[0].skipped = true; },
      (rows) => { rows[0].recurrence = []; },
      (rows) => { rows[0].recurrence.frequency = 'weekly'; rows[0].recurrence.weekdays = [1]; },
      (rows) => { rows[1].id = rows[0].id.toUpperCase(); },
      (rows) => {
        rows[1].recurrence.occurrenceDate = rows[0].recurrence.occurrenceDate;
        rows[1].recurrence.seriesId = rows[0].recurrence.seriesId.toUpperCase();
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const invalid = structuredClone(seed);
      mutate(invalid);
      assert.throws(() => store.validate(invalid), TypeError);
      const file = path.join(directory, `invalid-${index}.json`);
      const bytes = ` ${JSON.stringify(invalid)}\n`;
      await fs.writeFile(file, bytes);
      assert.deepEqual(await store.load(file), []);
      const backups = (await fs.readdir(directory)).filter((name) => name.startsWith(`invalid-${index}.json.corrupt-`));
      assert.equal(backups.length, 1);
      assert.equal(await fs.readFile(path.join(directory, backups[0]), 'utf8'), bytes);
    }
    assert.throws(() => store.validate(Array(50001).fill(seed[0])), TypeError);
    const tooMany = recurrence.materialize(
      { ...seed[0], [store.date]: '2026-01-01' }, store.date, daily(1000),
    );
    tooMany.push({ ...tooMany[0], id: randomUUID(), recurrence: {
      ...tooMany[0].recurrence, occurrenceDate: '2030-01-01',
    } });
    assert.throws(() => store.validate(tooMany), TypeError);
  });

  test(`${store.name}: historical rows count toward series caps and oversized files are preserved`, async (t) => {
    const directory = await temporaryDirectory(t);
    const file = path.join(directory, 'records.json');
    const rows = await store.add(file, store.input({ recurrence: daily(2) }));
    const before = await fs.readFile(file);
    await assert.rejects(store.update(file, rows[1].id, store.input({
      [store.date]: '2026-01-02', recurrence: daily(1000),
    }), 'series'), /including history/);
    assert.deepEqual(await fs.readFile(file), before);
    const oversized = path.join(directory, 'oversized.json');
    const handle = await fs.open(oversized, 'w');
    await handle.write('original bytes');
    await handle.truncate(recurrence.maximumBytes + 1);
    await handle.close();
    assert.deepEqual(await store.load(oversized), []);
    const backup = (await fs.readdir(directory)).find((name) => name.startsWith('oversized.json.corrupt-'));
    assert.equal((await fs.stat(path.join(directory, backup))).size, recurrence.maximumBytes + 1);
    const preserved = await fs.open(path.join(directory, backup), 'r');
    const prefix = Buffer.alloc(14);
    await preserved.read(prefix, 0, prefix.length, 0);
    await preserved.close();
    assert.equal(prefix.toString(), 'original bytes');
  });
}

test('schedule recurrence detects conflicts on later dates and confirmation saves all rows atomically', async (t) => {
  const file = path.join(await temporaryDirectory(t), 'schedules.json');
  let existing = await schedule.addActivity(file, activityInput({ date: '2026-01-03', title: 'Later conflict' }));
  existing = await schedule.setActivityCompleted(file, existing.activities[0].id, true);
  const before = await fs.readFile(file);
  const input = activityInput({ recurrence: daily(), reminderMinutesBefore: '15' });
  const rejected = await schedule.addActivity(file, input);
  assert.equal(rejected.saved, false);
  assert.deepEqual(rejected.overlaps, existing);
  assert.deepEqual(rejected.activities, existing);
  assert.deepEqual(await fs.readFile(file), before);
  const confirmed = await schedule.addActivity(file, input, true);
  assert.equal(confirmed.saved, true);
  assert.equal(confirmed.activities.length, 4);
  assert.equal(confirmed.activities[1].reminderMinutesBefore, 15);
  assert.deepEqual(confirmed.overlaps, existing);
  assert.deepEqual(await schedule.loadActivities(file), confirmed.activities);
});

test('schedule series edit checks preserved moved history and unrelated rows, with unique conflicts', async (t) => {
  const file = path.join(await temporaryDirectory(t), 'schedules.json');
  let result = await schedule.addActivity(file, activityInput({ recurrence: daily(4) }));
  const original = result.activities;
  await schedule.updateActivity(file, original[0].id, activityInput({ date: '2026-01-05' }));
  await schedule.setActivityCompleted(file, original[0].id, true);
  await schedule.skipActivity(file, original[2].id);
  result = await schedule.addActivity(file, activityInput({ date: '2026-01-06', title: 'Other series', recurrence: daily(1) }));
  const before = await fs.readFile(file);
  const edit = activityInput({ date: '2026-01-02', recurrence: daily(4) });
  const rejected = await schedule.updateActivity(file, original[1].id, edit, false, 'series');
  assert.equal(rejected.saved, false);
  assert.deepEqual(new Set(rejected.overlaps.map((row) => row.date)), new Set(['2026-01-05', '2026-01-06']));
  assert.equal(new Set(rejected.overlaps.map((row) => row.id)).size, rejected.overlaps.length);
  assert.deepEqual(rejected.activities, result.activities);
  assert.deepEqual(await fs.readFile(file), before);
  const confirmed = await schedule.updateActivity(file, original[1].id, edit, true, 'series');
  assert.equal(confirmed.saved, true);
  assert.equal(confirmed.activities.length, 7);
  assert.equal(byId(confirmed.activities, original[2].id).skipped, true);
});

test('schedule conversion and occurrence edits reject overlaps without modifying the original', async (t) => {
  const file = path.join(await temporaryDirectory(t), 'schedules.json');
  let result = await schedule.addActivity(file, activityInput());
  const selected = result.activities[0];
  result = await schedule.addActivity(file, activityInput({ date: '2026-01-03' }));
  const before = await fs.readFile(file);
  const converted = await schedule.updateActivity(file, selected.id, activityInput({ recurrence: daily() }));
  assert.equal(converted.saved, false);
  assert.deepEqual(converted.activities, result.activities);
  const moved = await schedule.updateActivity(file, selected.id, activityInput({ date: '2026-01-03' }));
  assert.equal(moved.saved, false);
  assert.deepEqual(await fs.readFile(file), before);
  const confirmed = await schedule.updateActivity(file, selected.id, activityInput({ recurrence: daily() }), true);
  assert.equal(confirmed.saved, true);
  assert.equal(confirmed.activities[0].id, selected.id);
  assert.equal(confirmed.activities.length, 4);
});

test('skipped schedule rows do not occupy time; restoration conflicts require editing before restoring', async (t) => {
  const file = path.join(await temporaryDirectory(t), 'schedules.json');
  const first = (await schedule.addActivity(file, activityInput({ recurrence: daily(1) }))).activities[0];
  await schedule.skipActivity(file, first.id);
  const other = await schedule.addActivity(file, activityInput());
  assert.equal(other.saved, true);
  const before = await fs.readFile(file);
  await assert.rejects(schedule.skipActivity(file, first.id, false), /overlaps.*Edit/);
  assert.deepEqual(await fs.readFile(file), before);
  const edited = await schedule.updateActivity(file, first.id, activityInput({
    startTime: '10:00', endTime: '11:00', recurrence: null, skipped: false,
  }));
  assert.equal(edited.saved, true);
  assert.equal(byId(edited.activities, first.id).skipped, true);
  const restored = await schedule.skipActivity(file, first.id, false);
  assert.equal(byId(restored, first.id).skipped, false);
  assert.deepEqual(await schedule.loadActivities(file), restored);
});

test('schedule checks candidate collisions as well as existing rows before any write', async (t) => {
  const file = path.join(await temporaryDirectory(t), 'schedules.json');
  const materialize = recurrence.materialize;
  // Model individually moved candidates while retaining distinct original occurrence dates.
  t.mock.method(recurrence, 'materialize', (...args) => {
    const rows = materialize(...args);
    rows[1].date = rows[0].date;
    return rows;
  });
  const result = await schedule.addActivity(file, activityInput({ recurrence: daily(2) }));
  assert.equal(result.saved, false);
  assert.equal(result.overlaps.length, 2);
  assert.equal(new Set(result.overlaps.map((row) => row.id)).size, 2);
  assert.deepEqual(result.activities, []);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal((await schedule.addActivity(file, activityInput({ recurrence: daily(2) }), true)).saved, true);
});

test('stores validate generated records before writing and clean up failed atomic writes', async (t) => {
  const directory = await temporaryDirectory(t);
  for (const store of stores) {
    const file = path.join(directory, `${store.name}.json`);
    const original = await store.add(file, store.input());
    const before = await fs.readFile(file);
    const materialize = recurrence.materialize;
    const mock = t.mock.method(recurrence, 'materialize', (...args) => {
      const rows = materialize(...args);
      rows[0].id = 'invalid generated identifier';
      return rows;
    });
    await assert.rejects(store.add(file, store.input({ recurrence: daily() })), TypeError);
    assert.deepEqual(await fs.readFile(file), before);
    mock.mock.restore();
    const rename = fs.rename;
    const renameMock = t.mock.method(fs, 'rename', async (source, destination) => {
      if (destination === file && source.endsWith('.tmp')) throw new Error('Simulated rename failure');
      return rename(source, destination);
    });
    await assert.rejects(store.complete(file, original[0].id, true), /Simulated rename failure/);
    renameMock.mock.restore();
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false);
  }
});
