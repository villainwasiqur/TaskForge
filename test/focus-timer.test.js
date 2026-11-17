const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const focusStore = require('../src/focus-store');

const execFileAsync = promisify(execFile);
const maximumMs = 180 * 60_000;

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-focus-timer-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, filePath: path.join(directory, 'focus.json') };
}

function makeTimer(overrides = {}) {
  return {
    id: randomUUID(),
    mode: 'focus',
    status: 'running',
    remainingMs: 25 * 60_000,
    deadline: Date.now() + 25 * 60_000,
    sessionMinutes: 25,
    ...overrides,
  };
}

async function safetyCopies(directory) {
  return (await fs.readdir(directory)).filter((name) => name.includes('.pre-v3.1-'));
}

async function completeInFreshProcess(filePath, timerId, options, environment = {}) {
  const { stdout } = await execFileAsync(process.execPath, ['-e', `
    const store = require(process.argv[1]);
    store.completeTimer(process.argv[2], process.argv[3], JSON.parse(process.argv[4]))
      .then(data => process.stdout.write(JSON.stringify(data)))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `, path.resolve(__dirname, '../src/focus-store.js'), filePath, timerId, JSON.stringify(options)], {
    env: { ...process.env, ...environment },
  });
  return JSON.parse(stdout);
}

test('focus timers default to null and running/paused snapshots round-trip with whitelisted fields', async (t) => {
  const { directory, filePath } = await temporaryStore(t);
  const defaults = await focusStore.loadFocusData(filePath);
  assert.equal(defaults.activeTimer, null);
  const running = makeTimer({
    remainingMs: maximumMs,
    sessionMinutes: 180,
    deadline: Number.MAX_SAFE_INTEGER,
  });
  const saved = await focusStore.saveTimer(filePath, {
    ...running,
    profileId: randomUUID(),
    extra: 'do not persist',
  });
  assert.deepEqual(saved, { ...defaults, activeTimer: running });
  assert.deepEqual(await focusStore.loadFocusData(filePath), saved);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), saved);

  const paused = { ...running, status: 'paused', deadline: null, remainingMs: 1, sessionMinutes: 1 };
  assert.deepEqual((await focusStore.saveTimer(filePath, paused)).activeTimer, paused);
  assert.deepEqual((await focusStore.loadFocusData(filePath)).activeTimer, paused);
  const resumed = { ...paused, status: 'running', deadline: Date.now() + 1 };
  assert.deepEqual((await focusStore.saveTimer(filePath, resumed)).activeTimer, resumed);
  assert.deepEqual(await fs.readdir(directory), ['focus.json']);
});

test('legacy migration preserves exact original bytes once before adding a null timer', async (t) => {
  const { directory, filePath } = await temporaryStore(t);
  const legacy = await focusStore.recordFocusSession(filePath, 37);
  delete legacy.activeTimer;
  const original = Buffer.from(`  ${JSON.stringify(legacy, null, '\t')}\r\n\r\n`);
  await fs.writeFile(filePath, original);

  const migrated = await focusStore.loadFocusData(filePath);
  assert.deepEqual(migrated, { ...legacy, activeTimer: null });
  const copies = await safetyCopies(directory);
  assert.equal(copies.length, 1);
  assert.deepEqual(await fs.readFile(path.join(directory, copies[0])), original);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), migrated);
  await focusStore.loadFocusData(filePath);
  assert.deepEqual(await safetyCopies(directory), copies);
});

test('older statistics still migrate and safety filenames are unique within one timestamp', async (t) => {
  const { directory, filePath } = await temporaryStore(t);
  const legacy = await focusStore.recordFocusSession(filePath, 25);
  delete legacy.activeTimer;
  delete legacy.stats.todayFocusMinutes;
  delete legacy.stats.dailyHistory;
  const timestamp = Date.now();
  t.mock.method(Date, 'now', () => timestamp);
  const originals = [];
  for (const prefix of [' ', '\t']) {
    const original = `${prefix}${JSON.stringify(legacy)}\r\n`;
    originals.push(original);
    await fs.writeFile(filePath, original);
    const migrated = await focusStore.loadFocusData(filePath);
    assert.equal(migrated.activeTimer, null);
    assert.equal(migrated.stats.totalFocusMinutes, 25);
    assert.equal(migrated.stats.todayFocusMinutes, 0);
    assert.deepEqual(migrated.stats.dailyHistory[migrated.stats.todayDate], { sessions: 1, minutes: 0 });
  }
  const copies = await safetyCopies(directory);
  assert.equal(copies.length, 2);
  const preserved = await Promise.all(copies.map((name) => fs.readFile(path.join(directory, name), 'utf8')));
  assert.deepEqual(preserved.sort(), originals.sort());
});

test('a failed safety copy leaves legacy and invalid timer originals untouched', async (t) => {
  const { filePath } = await temporaryStore(t);
  const data = await focusStore.recordFocusSession(filePath, 25);
  const legacy = { settings: data.settings, stats: data.stats };
  const copy = t.mock.method(fs, 'copyFile', async () => { throw new Error('safety copy failed'); });
  for (const input of [legacy, { ...data, activeTimer: { id: 'broken' } }]) {
    const original = Buffer.from(`${JSON.stringify(input)}\r\n`);
    await fs.writeFile(filePath, original);
    await assert.rejects(focusStore.loadFocusData(filePath), /safety copy failed/);
    assert.deepEqual(await fs.readFile(filePath), original);
  }
  copy.mock.restore();
  assert.equal((await focusStore.loadFocusData(filePath)).stats.totalCompletedSessions, 1);
});

const invalidTimers = [
  ['missing timer', () => undefined],
  ['array timer', () => []],
  ['string timer', () => 'running'],
  ['missing id', () => makeTimer({ id: undefined })],
  ['invalid UUID', () => makeTimer({ id: 'not-a-uuid' })],
  ['invalid UUID variant', () => makeTimer({ id: '11111111-1111-4111-1111-111111111111' })],
  ['invalid mode', () => makeTimer({ mode: 'rest' })],
  ['missing mode', () => makeTimer({ mode: undefined })],
  ['invalid status', () => makeTimer({ status: 'completed' })],
  ['missing status', () => makeTimer({ status: undefined })],
  ['zero remaining time', () => makeTimer({ remainingMs: 0 })],
  ['negative remaining time', () => makeTimer({ remainingMs: -1 })],
  ['fractional remaining time', () => makeTimer({ remainingMs: 1.5 })],
  ['excessive remaining time', () => makeTimer({ remainingMs: maximumMs + 1 })],
  ['string remaining time', () => makeTimer({ remainingMs: '60000' })],
  ['missing remaining time', () => makeTimer({ remainingMs: undefined })],
  ['running null deadline', () => makeTimer({ deadline: null })],
  ['zero deadline', () => makeTimer({ deadline: 0 })],
  ['negative deadline', () => makeTimer({ deadline: -1 })],
  ['fractional deadline', () => makeTimer({ deadline: 1.5 })],
  ['unsafe deadline', () => makeTimer({ deadline: Number.MAX_SAFE_INTEGER + 1 })],
  ['string deadline', () => makeTimer({ deadline: '12345' })],
  ['missing deadline', () => makeTimer({ deadline: undefined })],
  ['paused numeric deadline', () => makeTimer({ status: 'paused' })],
  ['paused missing deadline', () => makeTimer({ status: 'paused', deadline: undefined })],
  ['zero session duration', () => makeTimer({ sessionMinutes: 0 })],
  ['negative session duration', () => makeTimer({ sessionMinutes: -1 })],
  ['excessive session duration', () => makeTimer({ sessionMinutes: 181 })],
  ['fractional session duration', () => makeTimer({ sessionMinutes: 1.5 })],
  ['string session duration', () => makeTimer({ sessionMinutes: '25' })],
  ['missing session duration', () => makeTimer({ sessionMinutes: undefined })],
];

test('invalid timer fields reject saves and recover on read without losing settings or statistics', async (t) => {
  for (const [label, invalidTimer] of invalidTimers) {
    await t.test(label, async (st) => {
      const { directory, filePath } = await temporaryStore(st);
      const baseline = await focusStore.recordFocusSession(filePath, 37);
      baseline.settings = { ...baseline.settings, focusMinutes: 37, soundEnabled: false };
      // A valid, empty history must not be changed just because the timer migrates.
      baseline.stats.dailyHistory = {};
      await fs.writeFile(filePath, JSON.stringify(baseline));
      const original = await fs.readFile(filePath);
      const timer = invalidTimer();
      await assert.rejects(focusStore.saveTimer(filePath, timer), TypeError);
      assert.deepEqual(await fs.readFile(filePath), original);
      assert.deepEqual(await fs.readdir(directory), ['focus.json']);

      const damaged = Buffer.from(` ${JSON.stringify({ ...baseline, activeTimer: timer })}\r\n`);
      await fs.writeFile(filePath, damaged);
      assert.deepEqual(await focusStore.loadFocusData(filePath), baseline);
      assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), baseline);
      const copies = await safetyCopies(directory);
      assert.equal(copies.length, 1);
      assert.deepEqual(await fs.readFile(path.join(directory, copies[0])), damaged);
    });
  }
});

test('loading a timer strips profile identifiers and other unapproved fields with a safety copy', async (t) => {
  const { directory, filePath } = await temporaryStore(t);
  const timer = makeTimer();
  const data = await focusStore.saveTimer(filePath, timer);
  const original = JSON.stringify({ ...data, activeTimer: { ...timer, profileId: randomUUID() } });
  await fs.writeFile(filePath, original);
  assert.deepEqual(await focusStore.loadFocusData(filePath), data);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), data);
  const copies = await safetyCopies(directory);
  assert.equal(copies.length, 1);
  assert.equal(await fs.readFile(path.join(directory, copies[0]), 'utf8'), original);
});

test('cancellation persists null and stale completions never credit a cancelled timer', async (t) => {
  const { filePath } = await temporaryStore(t);
  const timer = makeTimer({ deadline: Date.now() - 1 });
  const original = await focusStore.saveTimer(filePath, timer);
  const cancelled = await focusStore.saveTimer(filePath, null);
  assert.deepEqual(cancelled, { ...original, activeTimer: null });
  assert.deepEqual(await focusStore.loadFocusData(filePath), cancelled);
  assert.deepEqual(await focusStore.completeTimer(filePath, timer.id), cancelled);
});

test('missing, mismatched, paused and unexpired timers are completion no-ops', async (t) => {
  const { filePath } = await temporaryStore(t);
  const now = Date.now();
  const empty = await focusStore.loadFocusData(filePath);
  assert.deepEqual(await focusStore.completeTimer(filePath, randomUUID(), { now }), empty);
  for (const [timer, mismatch] of [
    [makeTimer({ deadline: now - 1 }), true],
    [makeTimer({ deadline: now + 1 }), false],
    [makeTimer({ status: 'paused', deadline: null }), false],
  ]) {
    const saved = await focusStore.saveTimer(filePath, timer);
    const original = await fs.readFile(filePath);
    const result = await focusStore.completeTimer(filePath, mismatch ? randomUUID() : timer.id, { now });
    assert.deepEqual(result, saved);
    assert.deepEqual(await fs.readFile(filePath), original);
  }
});

test('focus completion credits the saved duration once and persists its successor across restart replay', async (t) => {
  const { directory, filePath } = await temporaryStore(t);
  const now = Date.now();
  const timer = makeTimer({ deadline: now, sessionMinutes: 37 });
  await focusStore.saveTimer(filePath, timer);
  const completed = await focusStore.completeTimer(filePath, timer.id, { now });
  assert.equal(completed.stats.totalCompletedSessions, 1);
  assert.equal(completed.stats.totalFocusMinutes, 37);
  assert.equal(completed.stats.todayCompletedSessions, 1);
  assert.equal(completed.stats.todayFocusMinutes, 37);
  assert.equal(completed.stats.cycleProgress, 1);
  assert.deepEqual(completed.stats.dailyHistory[completed.stats.todayDate], { sessions: 1, minutes: 37 });
  assert.notEqual(completed.activeTimer.id, timer.id);
  assert.deepEqual(completed.activeTimer, {
    id: completed.activeTimer.id,
    mode: 'shortBreak',
    status: 'running',
    remainingMs: 5 * 60_000,
    deadline: now + 5 * 60_000,
    sessionMinutes: 5,
  });
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), completed);
  assert.deepEqual(await focusStore.completeTimer(filePath, timer.id, { now }), completed);
  assert.deepEqual(await completeInFreshProcess(filePath, timer.id, { now }), completed);
  assert.deepEqual(await focusStore.loadFocusData(filePath), completed);
  assert.deepEqual(await fs.readdir(directory), ['focus.json']);
});

test('a failed atomic completion leaves both statistics and the original timer replayable', async (t) => {
  const { directory, filePath } = await temporaryStore(t);
  const now = Date.now();
  const timer = makeTimer({ deadline: now });
  const saved = await focusStore.saveTimer(filePath, timer);
  const original = await fs.readFile(filePath);
  const rename = t.mock.method(fs, 'rename', async () => { throw new Error('completion write failed'); });
  await assert.rejects(focusStore.completeTimer(filePath, timer.id, { now }), /completion write failed/);
  rename.mock.restore();
  assert.deepEqual(await fs.readFile(filePath), original);
  assert.deepEqual(await focusStore.loadFocusData(filePath), saved);
  assert.deepEqual(await fs.readdir(directory), ['focus.json']);
  assert.equal((await focusStore.completeTimer(filePath, timer.id, { now })).stats.totalCompletedSessions, 1);
  assert.equal((await focusStore.completeTimer(filePath, timer.id, { now })).stats.totalCompletedSessions, 1);
});

test('completion uses the original LOCAL deadline date, including today counters and offline midnight rollover', async (t) => {
  for (const [label, now, todayDate, todaySessions] of [
    ['same local day, different UTC date', Date.parse('2026-11-03T07:31:00Z'), '2026-11-02', 1],
    ['restart days later', Date.parse('2026-11-05T20:00:00Z'), '2026-11-05', 0],
  ]) {
    await t.test(label, async (st) => {
      const { filePath } = await temporaryStore(st);
      const timer = makeTimer({ deadline: Date.parse('2026-11-03T07:30:00Z'), sessionMinutes: 40 });
      await focusStore.saveTimer(filePath, timer);
      const completed = await completeInFreshProcess(filePath, timer.id, { now, resume: true }, {
        TZ: 'America/Los_Angeles',
      });
      assert.equal(completed.stats.totalCompletedSessions, 1);
      assert.equal(completed.stats.totalFocusMinutes, 40);
      assert.equal(completed.stats.todayDate, todayDate);
      assert.equal(completed.stats.todayCompletedSessions, todaySessions);
      assert.equal(completed.stats.todayFocusMinutes, todaySessions * 40);
      assert.deepEqual(completed.stats.dailyHistory, { '2026-11-02': { sessions: 1, minutes: 40 } });
      assert.equal(completed.activeTimer.status, 'paused');
      assert.equal(completed.activeTimer.deadline, null);
    });
  }
});

test('offline expiry counts one session and persists a paused successor without fabricating cycles', async (t) => {
  const { filePath } = await temporaryStore(t);
  const now = Date.now();
  const timer = makeTimer({ deadline: now - 7 * 24 * 60 * 60_000 });
  await focusStore.saveTimer(filePath, timer);
  const completed = await completeInFreshProcess(filePath, timer.id, { now, resume: true });
  assert.equal(completed.stats.totalCompletedSessions, 1);
  assert.equal(completed.stats.totalFocusMinutes, 25);
  assert.equal(completed.stats.cycleProgress, 1);
  assert.equal(completed.stats.todayCompletedSessions, 0);
  assert.equal(completed.stats.todayFocusMinutes, 0);
  assert.equal(completed.activeTimer.mode, 'shortBreak');
  assert.equal(completed.activeTimer.status, 'paused');
  assert.equal(completed.activeTimer.deadline, null);
  assert.equal(completed.activeTimer.remainingMs, 5 * 60_000);
  assert.deepEqual(await focusStore.loadFocusData(filePath), completed);
  assert.deepEqual(await completeInFreshProcess(filePath, timer.id, { now, resume: true }), completed);
  const later = await completeInFreshProcess(filePath, completed.activeTimer.id, {
    now: now + 7 * 24 * 60 * 60_000,
    resume: true,
  });
  assert.equal(later.stats.totalCompletedSessions, 1);
  assert.equal(later.stats.cycleProgress, 1);
  assert.deepEqual(later.activeTimer, completed.activeTimer);
});

test('focus, short breaks and long breaks advance using settings and reset only after a long break', async (t) => {
  const { filePath } = await temporaryStore(t);
  const settings = { focusMinutes: 31, shortBreakMinutes: 7, longBreakMinutes: 19, soundEnabled: false };
  await focusStore.saveSettings(filePath, settings);
  let timer = makeTimer({ deadline: Date.now(), sessionMinutes: 31 });
  await focusStore.saveTimer(filePath, timer);
  for (const [nextMode, cycleProgress, completedSessions] of [
    ['shortBreak', 1, 1],
    ['focus', 1, 1],
    ['shortBreak', 2, 2],
    ['focus', 2, 2],
    ['longBreak', 3, 3],
    ['focus', 0, 3],
  ]) {
    const now = timer.deadline;
    const completed = await focusStore.completeTimer(filePath, timer.id, { now });
    const duration = settings[`${nextMode}Minutes`];
    assert.equal(completed.stats.cycleProgress, cycleProgress);
    assert.equal(completed.stats.totalCompletedSessions, completedSessions);
    assert.equal(completed.stats.totalFocusMinutes, completedSessions * 31);
    assert.notEqual(completed.activeTimer.id, timer.id);
    assert.equal(completed.activeTimer.mode, nextMode);
    assert.equal(completed.activeTimer.status, 'running');
    assert.equal(completed.activeTimer.sessionMinutes, duration);
    assert.equal(completed.activeTimer.remainingMs, duration * 60_000);
    assert.equal(completed.activeTimer.deadline, now + duration * 60_000);
    timer = completed.activeTimer;
  }
});

test('offline short and long breaks pause the next focus timer without adding focus credit', async (t) => {
  for (const mode of ['shortBreak', 'longBreak']) {
    await t.test(mode, async (st) => {
      const { filePath } = await temporaryStore(st);
      const baseline = await focusStore.recordFocusSession(filePath, 25);
      const now = Date.now();
      const timer = makeTimer({ mode, deadline: now - 1 });
      await focusStore.saveTimer(filePath, timer);
      const completed = await focusStore.completeTimer(filePath, timer.id, { now, resume: true });
      assert.deepEqual(completed.stats, { ...baseline.stats, cycleProgress: mode === 'longBreak' ? 0 : 1 });
      assert.equal(completed.activeTimer.mode, 'focus');
      assert.equal(completed.activeTimer.status, 'paused');
      assert.equal(completed.activeTimer.deadline, null);
      assert.equal(completed.activeTimer.remainingMs, 25 * 60_000);
      assert.notEqual(completed.activeTimer.id, timer.id);
    });
  }
});

test('settings and legacy recording APIs preserve timers; completion uses updated successor settings', async (t) => {
  const { filePath } = await temporaryStore(t);
  const timer = makeTimer({ deadline: Date.now() - 1 });
  await focusStore.saveTimer(filePath, timer);
  const settings = { focusMinutes: 50, shortBreakMinutes: 9, longBreakMinutes: 20, soundEnabled: false };
  const updated = await focusStore.saveSettings(filePath, settings);
  assert.deepEqual(updated.settings, settings);
  assert.deepEqual(updated.activeTimer, timer);
  assert.deepEqual((await focusStore.loadFocusData(filePath)).activeTimer, timer);
  assert.deepEqual((await focusStore.recordFocusSession(filePath, 11)).activeTimer, timer);
  assert.deepEqual((await focusStore.recordLongBreakCompletion(filePath)).activeTimer, timer);
  const completed = await focusStore.completeTimer(filePath, timer.id);
  assert.equal(completed.stats.totalCompletedSessions, 2);
  assert.equal(completed.stats.totalFocusMinutes, 36);
  assert.equal(completed.activeTimer.sessionMinutes, 9);
  assert.equal(completed.activeTimer.remainingMs, 9 * 60_000);
});

test('profile-local paths isolate timers and completion statistics', async (t) => {
  const { directory, filePath } = await temporaryStore(t);
  const otherPath = path.join(directory, 'other-profile', 'focus.json');
  const now = Date.now();
  const first = makeTimer({ deadline: now });
  const second = makeTimer({ deadline: now });
  await focusStore.saveTimer(filePath, first);
  const other = await focusStore.saveTimer(otherPath, second);
  assert.equal((await focusStore.completeTimer(filePath, second.id, { now })).stats.totalCompletedSessions, 0);
  assert.equal((await focusStore.completeTimer(filePath, first.id, { now })).stats.totalCompletedSessions, 1);
  assert.deepEqual(await focusStore.loadFocusData(otherPath), other);
});

test('invalid completion options reject without changing the persisted timer', async (t) => {
  const { filePath } = await temporaryStore(t);
  const timer = makeTimer({ deadline: Date.now() - 1 });
  await focusStore.saveTimer(filePath, timer);
  const original = await fs.readFile(filePath);
  for (const options of [{ now: NaN }, { now: 0 }, { now: 1.5 }, { now: Infinity }, { resume: 'true' }]) {
    await assert.rejects(focusStore.completeTimer(filePath, timer.id, options), TypeError);
    assert.deepEqual(await fs.readFile(filePath), original);
  }
});

test('malformed JSON and invalid settings retain the existing corrupt-file recovery behavior', async (t) => {
  for (const contents of ['{bad JSON', JSON.stringify({ settings: {}, stats: {}, activeTimer: makeTimer() })]) {
    await t.test(contents.startsWith('{bad') ? 'invalid JSON' : 'invalid settings', async (st) => {
      const { directory, filePath } = await temporaryStore(st);
      st.mock.method(console, 'error', () => {});
      await fs.writeFile(filePath, contents);
      const data = await focusStore.loadFocusData(filePath);
      assert.equal(data.activeTimer, null);
      assert.equal(data.stats.totalCompletedSessions, 0);
      assert.deepEqual(data.settings, focusStore.defaultSettings);
      const copies = (await fs.readdir(directory)).filter((name) => name.includes('.corrupt-'));
      assert.equal(copies.length, 1);
      assert.equal(await fs.readFile(path.join(directory, copies[0]), 'utf8'), contents);
      assert.deepEqual(await safetyCopies(directory), []);
    });
  }
});
