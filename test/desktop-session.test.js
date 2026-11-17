const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const profileStore = require('../src/profile-store');
const focusStore = require('../src/focus-store');

const accelerator = 'CommandOrControl+Alt+N';
const mainPath = require.resolve('../main');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function bounded(promise, description) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor(check, description, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function closeEvent() {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}

// Each boot reloads main.js while retaining the real profile and timer stores.
async function bootMain(userDataPath, {
  singleInstance = true,
  shortcutAvailable = true,
  shortcutError,
  notificationsSupported = false,
} = {}) {
  assert.ok(path.isAbsolute(userDataPath));
  const ready = deferred();
  const handlers = new Map();
  const windows = [];
  const trays = [];
  const messages = [];
  const notifications = [];
  const saveDialogs = [];
  const saveDialogRequests = [];
  const messageEvents = new EventEmitter();
  const shortcuts = new Map();
  const registrations = [];
  const app = new EventEmitter();
  let startup;
  let loadedMain;
  let stopping;
  let quitCalls = 0;
  let readyCalls = 0;
  let lockCalls = 0;
  let unregisterCalls = 0;

  Object.assign(app, {
    // Never consult AppData or honor a developer's TASKFORGE_USER_DATA_DIR.
    isPackaged: true,
    getPath(name) {
      if (name === 'userData') return userDataPath;
      if (name === 'documents' || name === 'sessionData') return path.join(userDataPath, name);
      throw new Error(`Unexpected Electron path: ${name}`);
    },
    getVersion: () => '3.1.0',
    setAppUserModelId() {},
    requestSingleInstanceLock() { lockCalls += 1; return singleInstance; },
    whenReady() {
      readyCalls += 1;
      // Retain initialization so even a failed boot is drained before removing files.
      return {
        then(callback) {
          startup = Promise.resolve().then(callback);
          return startup;
        },
      };
    },
    // Electron's subsequent lifecycle events are driven by stop(), not real OS exit.
    quit() { quitCalls += 1; app.emit('quit-requested'); },
  });

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = true;
      this.minimized = false;
      this.destroyed = false;
      this.focused = false;
      this.actions = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, payload) => {
        messages.push({ channel, payload });
        messageEvents.emit(channel, payload);
      };
      windows.push(this);
    }

    loadFile(filePath) {
      this.loadedFile = filePath;
      this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      ready.resolve(this);
      return Promise.resolve();
    }

    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    minimize() { this.minimized = true; this.focused = false; }
    restore() { this.actions.push('restore'); this.minimized = false; }
    show() { this.actions.push('show'); this.visible = true; }
    focus() { this.actions.push('focus'); this.focused = true; }
    hide() { this.actions.push('hide'); this.visible = false; this.focused = false; }
    close() {
      const event = closeEvent();
      this.emit('close', event);
      if (!event.defaultPrevented) this.destroy();
      return event;
    }

    destroy() { this.destroyed = true; this.emit('closed'); }
    static getAllWindows() { return windows.filter((window) => !window.destroyed); }
  }

  class Tray extends EventEmitter {
    constructor(icon) {
      super();
      this.icon = icon;
      this.destroyed = false;
      trays.push(this);
    }

    setToolTip(tooltip) { this.tooltip = tooltip; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }

  class FakeNotification extends EventEmitter {
    static isSupported() { return notificationsSupported; }

    constructor(options) {
      super();
      this.options = options;
      this.shown = false;
      notifications.push(this);
    }

    show() { this.shown = true; }
  }

  const electron = {
    app,
    BrowserWindow,
    Tray,
    Menu: { buildFromTemplate: (template) => template },
    globalShortcut: {
      register(key, callback) {
        registrations.push(key);
        if (shortcutError) throw shortcutError;
        if (shortcutAvailable) shortcuts.set(key, callback);
        return shortcutAvailable;
      },
      unregisterAll() { unregisterCalls += 1; shortcuts.clear(); },
    },
    dialog: {
      showErrorBox: (_title, message) => ready.reject(new Error(message)),
      async showSaveDialog(_window, options) {
        saveDialogRequests.push(options);
        return saveDialogs.shift() ?? { canceled: true, filePath: undefined };
      },
      async showOpenDialog() { return { canceled: true, filePaths: [] }; },
      async showMessageBox() { return { response: 1 }; },
    },
    ipcMain: {
      handle(channel, handler) {
        assert.equal(handlers.has(channel), false, `Duplicate IPC handler: ${channel}`);
        handlers.set(channel, handler);
      },
    },
    Notification: FakeNotification,
    powerMonitor: new EventEmitter(),
  };

  const session = {
    app, handlers, windows, trays, messages, notifications, registrations, saveDialogRequests,
    get quitCalls() { return quitCalls; },
    get readyCalls() { return readyCalls; },
    get lockCalls() { return lockCalls; },
    get unregisterCalls() { return unregisterCalls; },
    queueSaveDialog(filePath) { saveDialogs.push({ canceled: false, filePath }); },
    queueCanceledSaveDialog() { saveDialogs.push({ canceled: true, filePath: undefined }); },
    async invoke(channel, ...args) {
      assert.ok(handlers.has(channel), `Missing IPC handler: ${channel}`);
      return handlers.get(channel)(null, ...args);
    },
    capture() {
      assert.ok(shortcuts.has(accelerator), 'Quick-capture shortcut is not registered');
      shortcuts.get(accelerator)();
    },
    async duringMessage(channel, operation) {
      const received = deferred();
      const listener = (payload) => received.resolve(payload);
      messageEvents.once(channel, listener);
      try {
        return await bounded(Promise.all([operation(), received.promise]), channel);
      } finally {
        messageEvents.removeListener(channel, listener);
      }
    },
    stop() {
      if (!stopping) {
        stopping = (async () => {
          const drained = deferred();
          const acknowledgeQuit = () => drained.resolve();
          try {
            await startup?.catch(() => {});
            app.once('quit-requested', acknowledgeQuit);
            const event = closeEvent();
            app.emit('before-quit', event);
            if (event.defaultPrevented) await bounded(drained.promise, 'before-quit data drain');
          } finally {
            app.removeListener('quit-requested', acknowledgeQuit);
            app.emit('will-quit');
            messageEvents.removeAllListeners();
            if (require.cache[mainPath] === loadedMain) delete require.cache[mainPath];
          }
        })();
      }
      return stopping;
    },
  };

  const originalLoad = Module._load;
  try {
    delete require.cache[mainPath];
    Module._load = function loadWithElectronStub(request, parent, isMain) {
      return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain);
    };
    try {
      require(mainPath);
      loadedMain = require.cache[mainPath];
    } finally {
      Module._load = originalLoad;
    }
    if (singleInstance) await bounded(ready.promise, 'BrowserWindow.loadFile');
    return session;
  } catch (error) {
    await session.stop();
    throw error;
  }
}

async function desktopFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-desktop-test-'));
  const userDataPath = path.join(directory, 'user-data');
  let current;
  // A single hook enforces the order, including when a test assertion throws.
  t.after(async () => {
    try {
      await current?.stop();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  return {
    directory,
    userDataPath,
    async boot(options) {
      await current?.stop();
      current = await bootMain(userDataPath, options);
      return current;
    },
    paths(profileId) { return profileStore.getProfileDataPaths(userDataPath, profileId); },
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function persistedTimer(timer) {
  const { profileId, ...saved } = timer;
  return saved;
}

async function assertRunningTimer(session, expected, profileId) {
  const before = Date.now();
  const actual = await session.invoke('focus:timer-state');
  const after = Date.now();
  assert.ok(actual);
  assert.deepEqual({ ...actual, remainingMs: expected.remainingMs }, { ...expected, profileId });
  assert.equal(actual.status, 'running');
  assert.ok(actual.remainingMs >= Math.max(0, expected.deadline - after));
  assert.ok(actual.remainingMs <= Math.max(0, expected.deadline - before));
  return actual;
}

function localDate(timestamp) {
  const date = new Date(timestamp);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}

function recurringInput(kind, count = 3, date = '2026-11-02') {
  return {
    title: 'Daily occurrence',
    ...(kind === 'tasks' ? { dueDate: date } : { date, startTime: '09:00', endTime: '10:00' }),
    recurrence: { frequency: 'daily', interval: 1, weekdays: [], count, until: null },
  };
}

async function addRecurringRows(session, kind, count = 3) {
  const result = await session.invoke(`${kind}:add`, recurringInput(kind, count));
  if (kind === 'tasks') return result;
  assert.equal(result.saved, true);
  return result.activities;
}

function recurringUpdateArgs(kind, id, input, scope = 'occurrence') {
  return kind === 'tasks' ? [id, input, scope] : [id, input, false, scope];
}

test('v3.1 registers global capture and restores, shows and focuses one existing window', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const window = session.windows[0];
  assert.equal(await session.invoke('app:get-version'), '3.1.0');
  assert.equal(session.lockCalls, 1);
  assert.deepEqual(session.registrations, [accelerator]);
  assert.deepEqual(await session.invoke('app:desktop-ready'), {
    shortcutRegistered: true, pendingCapture: false, trayAvailable: true,
  });

  window.minimize();
  session.capture();
  assert.deepEqual(window.actions, ['restore', 'show', 'focus']);
  assert.equal(window.minimized, false);
  window.hide();
  session.capture();
  assert.deepEqual(window.actions.slice(-2), ['show', 'focus']);
  assert.equal(window.visible, true);
  assert.equal(window.focused, true);

  session.app.emit('second-instance');
  session.app.emit('activate');
  assert.equal(session.windows.length, 1);
  assert.equal(session.trays.length, 1);
  assert.deepEqual(session.registrations, [accelerator]);
  assert.equal(session.messages.filter((message) => message.channel === 'app:quick-capture').length, 2);
});

test('capture before desktop-ready and during reload is retained and consumed exactly once', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const profile = await session.invoke('profiles:state');
  session.capture();
  session.capture();
  assert.deepEqual(session.messages, []);
  assert.equal((await session.invoke('app:desktop-ready')).pendingCapture, true);
  assert.deepEqual(await session.invoke('app:consume-capture'), {
    profileId: profile.activeProfileId, name: profile.activeProfile.name,
  });
  assert.equal(await session.invoke('app:consume-capture'), null);
  assert.equal((await session.invoke('app:desktop-ready')).pendingCapture, false);

  session.windows[0].webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  session.capture();
  assert.deepEqual(session.messages, []);
  assert.equal((await session.invoke('app:desktop-ready')).pendingCapture, true);
  assert.equal((await session.invoke('app:consume-capture')).profileId, profile.activeProfileId);
  assert.equal(await session.invoke('app:consume-capture'), null);
});

test('in-page navigation does not disable global capture delivery', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  await session.invoke('app:desktop-ready');
  session.windows[0].webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  session.capture();
  assert.equal(session.messages.at(-1).channel, 'app:quick-capture');
  assert.ok(await session.invoke('app:consume-capture'));
});

test('locked quick capture survives denied consumption and unlock without exposing profile data', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const { activeProfileId } = await session.invoke('profiles:state');
  await session.invoke('profiles:set-pin', activeProfileId, '2468');
  await session.invoke('profiles:lock');
  session.capture();
  assert.equal((await session.invoke('app:desktop-ready')).pendingCapture, true);
  assert.equal(await session.invoke('app:consume-capture'), null);
  assert.equal(await session.invoke('app:consume-capture'), null);
  await assert.rejects(session.invoke('app:quick-capture-add', activeProfileId, 'Locked task'), /locked/i);
  await assert.rejects(session.invoke('profiles:unlock', '0000'), /Incorrect PIN/);
  assert.equal((await session.invoke('app:desktop-ready')).pendingCapture, true);
  await session.invoke('profiles:unlock', '2468');
  assert.deepEqual(await session.invoke('app:consume-capture'), { profileId: activeProfileId, name: 'Default' });
  assert.equal(await session.invoke('app:consume-capture'), null);
  assert.deepEqual(await session.invoke('tasks:list'), []);
});

test('changing profiles discards pending capture rather than delivering it to the new profile', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const first = await session.invoke('profiles:state');
  const other = await session.invoke('profiles:create', { name: 'Other' });
  await session.invoke('profiles:activate', first.activeProfileId);
  session.capture();
  await session.invoke('profiles:activate', other.activeProfileId);
  assert.equal(await session.invoke('app:consume-capture'), null);
  await session.invoke('profiles:activate', first.activeProfileId);
  assert.equal(await session.invoke('app:consume-capture'), null);

  session.capture();
  await session.invoke('profiles:create', { name: 'New profile' });
  assert.equal(await session.invoke('app:consume-capture'), null);
  assert.equal((await session.invoke('app:desktop-ready')).pendingCapture, false);
});

test('switching away and back cannot resurrect an unconsumed capture request', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const first = await session.invoke('profiles:state');
  const other = await session.invoke('profiles:create', { name: 'Other' });
  await session.invoke('profiles:activate', first.activeProfileId);
  session.capture();
  await session.invoke('profiles:activate', other.activeProfileId);
  await session.invoke('profiles:activate', first.activeProfileId);
  assert.equal(await session.invoke('app:consume-capture'), null);
});

test('quick-capture-add validates titles and rejects locked, stale and queued profile changes', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const { activeProfileId } = await session.invoke('profiles:state');
  for (const title of ['', ' \t ', null, undefined, 42, {}, 'x'.repeat(121)]) {
    await assert.rejects(session.invoke('app:quick-capture-add', activeProfileId, title), /Task title/);
  }
  assert.deepEqual(await session.invoke('tasks:list'), []);
  const tasks = await session.invoke('app:quick-capture-add', activeProfileId, '  Captured task  ');
  assert.equal(tasks.length, 1);
  assert.deepEqual({ ...tasks[0], id: undefined, createdAt: undefined, updatedAt: undefined }, {
    id: undefined, title: 'Captured task', description: '', priority: 'Medium', dueDate: null,
    reminderAt: null, completed: false, completedAt: null, createdAt: undefined, updatedAt: undefined,
  });

  await session.invoke('profiles:set-pin', activeProfileId, '2468');
  const locking = session.invoke('profiles:lock');
  const lockedAdd = session.invoke('app:quick-capture-add', activeProfileId, 'Queued while locking');
  await Promise.all([locking, assert.rejects(lockedAdd, /locked/i)]);
  await assert.rejects(session.invoke('app:quick-capture-add', activeProfileId, 'Locked'), /locked/i);
  await session.invoke('profiles:unlock', '2468');

  const other = await session.invoke('profiles:create', { name: 'Other' });
  await assert.rejects(session.invoke('app:quick-capture-add', activeProfileId, 'Stale'), /changed/i);
  await session.invoke('profiles:activate', activeProfileId);
  const switching = session.invoke('profiles:activate', other.activeProfileId);
  const staleAdd = session.invoke('app:quick-capture-add', activeProfileId, 'Queued while switching');
  await Promise.all([switching, assert.rejects(staleAdd, /changed/i)]);
  assert.deepEqual(await session.invoke('tasks:list'), []);
  await session.invoke('profiles:activate', activeProfileId);
  assert.deepEqual(await session.invoke('tasks:list'), tasks);
});

test('tray capture/open/double-click reuse the window; close hides until explicit quit', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const window = session.windows[0];
  const tray = session.trays[0];
  const { activeProfileId } = await session.invoke('profiles:state');
  await session.invoke('app:desktop-ready');
  assert.match(tray.tooltip, /Ctrl\+Alt\+N/);
  assert.deepEqual(tray.menu.map((item) => item.label ?? item.type), [
    'Quick capture (Ctrl+Alt+N)', 'Open TaskForge', 'separator', 'Quit TaskForge',
  ]);
  assert.equal(window.close().defaultPrevented, true);
  assert.equal(window.destroyed, false);
  assert.equal(window.visible, false);
  session.app.emit('window-all-closed');
  assert.equal(session.quitCalls, 0);

  tray.menu[0].click();
  assert.equal(window.visible, true);
  assert.equal((await session.invoke('app:consume-capture')).profileId, activeProfileId);
  window.hide();
  tray.menu[1].click();
  assert.equal(window.visible, true);
  assert.equal(await session.invoke('app:consume-capture'), null);
  window.minimize();
  tray.emit('double-click');
  assert.equal(window.minimized, false);
  assert.equal(window.focused, true);
  assert.equal(session.windows.length, 1);

  tray.menu[3].click();
  assert.equal(session.quitCalls, 1);
  let quittingClose;
  // Registered after main's listener: isQuitting is already true but the tray still exists.
  session.app.once('before-quit', () => { quittingClose = window.close(); });
  await session.stop();
  assert.equal(quittingClose.defaultPrevented, false);
  assert.equal(window.destroyed, true);
  assert.equal(tray.destroyed, true);
  assert.equal(session.unregisterCalls, 1);
  assert.equal(session.quitCalls, 2);
  await session.stop();
  assert.equal(session.unregisterCalls, 1);
});

test('an unavailable or throwing global shortcut is reported without preventing tray capture', async (t) => {
  for (const unavailable of ['unavailable', 'throws']) {
    await t.test(unavailable, async (st) => {
      const fixture = await desktopFixture(st);
      const errors = st.mock.method(console, 'error', () => {});
      const session = await fixture.boot({
        shortcutAvailable: false,
        shortcutError: unavailable === 'throws' ? new Error('Shortcut registration unavailable') : undefined,
      });
      assert.deepEqual(await session.invoke('app:desktop-ready'), {
        shortcutRegistered: false, pendingCapture: false, trayAvailable: true,
      });
      assert.equal(await session.invoke('app:get-version'), '3.1.0');
      assert.equal(session.quitCalls, 0);
      assert.deepEqual(session.registrations, [accelerator]);
      assert.equal(errors.mock.callCount(), unavailable === 'throws' ? 1 : 0);
      session.trays[0].menu[0].click();
      assert.ok(await session.invoke('app:consume-capture'));
      const tasks = await session.invoke('app:quick-capture-add',
        (await session.invoke('profiles:state')).activeProfileId, 'Tray still works');
      assert.equal(tasks[0].title, 'Tray still works');
    });
  }
});

test('a rejected single-instance lock quits without loading, migrating or creating profile data', async (t) => {
  const fixture = await desktopFixture(t);
  await fs.mkdir(fixture.userDataPath);
  const sentinelPath = path.join(fixture.userDataPath, 'profiles.json');
  const sentinel = 'Do not read or migrate this second-instance data.\n';
  await fs.writeFile(sentinelPath, sentinel);
  const profiles = t.mock.method(profileStore, 'readState');
  const focus = t.mock.method(focusStore, 'loadFocusData');
  const session = await fixture.boot({ singleInstance: false });
  assert.equal(session.lockCalls, 1);
  assert.equal(session.quitCalls, 1);
  assert.equal(session.readyCalls, 0);
  assert.equal(profiles.mock.callCount(), 0);
  assert.equal(focus.mock.callCount(), 0);
  assert.equal(session.handlers.size, 0);
  assert.deepEqual(session.windows, []);
  assert.deepEqual(session.trays, []);
  assert.deepEqual(session.registrations, []);
  await session.stop();
  assert.equal(await fs.readFile(sentinelPath, 'utf8'), sentinel);
  assert.deepEqual(await fs.readdir(fixture.userDataPath), ['profiles.json']);
});

test('running timer identity and deadline survive restart while protected profiles re-lock', async (t) => {
  const fixture = await desktopFixture(t);
  let session = await fixture.boot();
  const { activeProfileId } = await session.invoke('profiles:state');
  await session.invoke('profiles:set-pin', activeProfileId, '2468');
  const started = await session.invoke('focus:timer-start', 'focus', 120_000, 25);
  const focusPath = fixture.paths(activeProfileId).focus;
  const saved = (await readJson(focusPath)).activeTimer;
  assert.equal(saved.id, started.id);
  assert.equal(saved.deadline, started.deadline);
  assert.equal(saved.remainingMs, 120_000);
  assert.equal(Object.hasOwn(saved, 'profileId'), false);
  await session.stop();
  assert.deepEqual((await readJson(focusPath)).activeTimer, saved);

  session = await fixture.boot();
  const view = await session.invoke('profiles:state');
  assert.equal(view.activeProfileId, activeProfileId);
  assert.equal(view.locked, true);
  await assert.rejects(session.invoke('focus:timer-state'), /locked/i);
  await assert.rejects(session.invoke('focus:load'), /locked/i);
  await session.invoke('profiles:unlock', '2468');
  await assertRunningTimer(session, saved, activeProfileId);
  assert.equal((await session.invoke('focus:load')).stats.totalCompletedSessions, 0);
});

test('paused timer preserves its exact remainder, identity and null deadline across relaunches', async (t) => {
  const fixture = await desktopFixture(t);
  let session = await fixture.boot();
  const { activeProfileId } = await session.invoke('profiles:state');
  const started = await session.invoke('focus:timer-start', 'focus', 180_000, 37);
  const paused = await session.invoke('focus:timer-pause');
  assert.equal(paused.id, started.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.deadline, null);
  assert.ok(paused.remainingMs > 0 && paused.remainingMs <= 180_000);
  for (let relaunch = 0; relaunch < 2; relaunch += 1) {
    await session.stop();
    assert.deepEqual((await readJson(fixture.paths(activeProfileId).focus)).activeTimer, persistedTimer(paused));
    session = await fixture.boot();
    assert.deepEqual(await session.invoke('focus:timer-state'), paused);
    assert.equal((await session.invoke('focus:load')).stats.totalCompletedSessions, 0);
  }
});

test('all profiles restore independent running and paused timers, including a protected inactive profile', async (t) => {
  const fixture = await desktopFixture(t);
  let session = await fixture.boot();
  const first = (await session.invoke('profiles:state')).activeProfileId;
  const running = await session.invoke('focus:timer-start', 'focus', 240_000, 25);
  const second = (await session.invoke('profiles:create', { name: 'Protected', pin: '1357' })).activeProfileId;
  const otherRunning = await session.invoke('focus:timer-start', 'longBreak', 300_000, 15);
  const third = (await session.invoke('profiles:create', { name: 'Paused' })).activeProfileId;
  await session.invoke('focus:timer-start', 'shortBreak', 180_000, 5);
  const paused = await session.invoke('focus:timer-pause');
  await session.invoke('profiles:activate', first);

  session = await fixture.boot();
  await assertRunningTimer(session, running, first);
  await assert.rejects(session.invoke('profiles:activate', second), /PIN/);
  await session.invoke('profiles:activate', second, '1357');
  await assertRunningTimer(session, otherRunning, second);
  await session.invoke('profiles:activate', third);
  assert.deepEqual(await session.invoke('focus:timer-state'), paused);
  assert.equal((await session.invoke('profiles:state')).profiles.length, 3);
  for (const profileId of [first, second, third]) {
    const data = await readJson(fixture.paths(profileId).focus);
    assert.equal(data.stats.totalCompletedSessions, 0);
  }
});

test('cancel, reset and profile deletion cannot resurrect timers on repeated restart', async (t) => {
  for (const operation of ['cancel', 'reset', 'delete']) {
    await t.test(operation, async (st) => {
      const fixture = await desktopFixture(st);
      let session = await fixture.boot();
      const originalProfile = (await session.invoke('profiles:state')).activeProfileId;
      const started = await session.invoke('focus:timer-start', 'focus', 120_000, 25);
      if (operation === 'cancel') {
        assert.equal(await session.invoke('focus:timer-cancel'), null);
        assert.equal((await readJson(fixture.paths(originalProfile).focus)).activeTimer, null);
      } else if (operation === 'reset') {
        assert.deepEqual(await session.invoke('app:reset-data'), { version: '3.1.0' });
      } else {
        await session.invoke('profiles:create', { name: 'Survivor' });
        await session.invoke('profiles:delete', originalProfile);
        const deletedDirectory = path.join(fixture.userDataPath, 'deleted-profiles');
        const archives = await fs.readdir(deletedDirectory);
        assert.equal(archives.length, 1);
        const archived = await readJson(path.join(deletedDirectory, archives[0], 'focus.json'));
        assert.equal(archived.activeTimer.id, started.id);
      }
      assert.equal(await session.invoke('focus:timer-state'), null);
      for (let relaunch = 0; relaunch < 2; relaunch += 1) {
        session = await fixture.boot();
        assert.equal(await session.invoke('focus:timer-state'), null);
        const data = await session.invoke('focus:load');
        assert.equal(data.activeTimer, null);
        assert.equal(data.stats.totalCompletedSessions, 0);
        if (operation === 'delete') {
          const view = await session.invoke('profiles:state');
          assert.equal(view.profiles.some((profile) => profile.id === originalProfile), false);
          await assert.rejects(fs.stat(path.dirname(fixture.paths(originalProfile).focus)), { code: 'ENOENT' });
        }
      }
    });
  }
});

test('offline expiry records one completion and a paused successor across repeated relaunches', async (t) => {
  const fixture = await desktopFixture(t);
  let session = await fixture.boot();
  const { activeProfileId } = await session.invoke('profiles:state');
  await session.invoke('focus:save-settings', {
    focusMinutes: 37, shortBreakMinutes: 7, longBreakMinutes: 19, soundEnabled: false,
  });
  const started = await session.invoke('focus:timer-start', 'focus', 120_000, 37);
  await session.stop();
  const focusPath = fixture.paths(activeProfileId).focus;
  const offline = await readJson(focusPath);
  // Move only the persisted deadline while main is stopped: no clock mocks or sleeps.
  offline.activeTimer.deadline = Date.now() - 7 * 24 * 60 * 60_000;
  await fs.writeFile(focusPath, JSON.stringify(offline));
  let successor;
  for (let relaunch = 0; relaunch < 3; relaunch += 1) {
    session = await fixture.boot();
    const data = await session.invoke('focus:load');
    assert.equal(data.stats.totalCompletedSessions, 1);
    assert.equal(data.stats.totalFocusMinutes, 37);
    assert.equal(data.stats.todayCompletedSessions, 0);
    assert.equal(data.stats.todayFocusMinutes, 0);
    assert.equal(data.stats.cycleProgress, 1);
    assert.deepEqual(data.stats.dailyHistory, {
      [localDate(offline.activeTimer.deadline)]: { sessions: 1, minutes: 37 },
    });
    const timer = await session.invoke('focus:timer-state');
    assert.notEqual(timer.id, started.id);
    assert.deepEqual(timer, {
      id: timer.id, profileId: activeProfileId, mode: 'shortBreak', status: 'paused',
      remainingMs: 7 * 60_000, deadline: null, sessionMinutes: 7,
    });
    if (successor) assert.deepEqual(timer, successor);
    successor = timer;
    assert.deepEqual((await readJson(focusPath)).activeTimer, persistedTimer(successor));
    assert.deepEqual(session.messages, []);
  }
});

test('queued focus commands cannot cross a profile switch or lock boundary', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const first = (await session.invoke('profiles:state')).activeProfileId;
  const other = (await session.invoke('profiles:create', { name: 'Other' })).activeProfileId;
  const otherTimer = await session.invoke('focus:timer-start', 'shortBreak', 120_000, 5);
  for (const [channel, args] of [
    ['focus:timer-start', ['focus', 60_000, 25]],
    ['focus:timer-pause', []],
    ['focus:timer-cancel', []],
    ['focus:timer-state', []],
    ['focus:load', []],
  ]) {
    await session.invoke('profiles:activate', first);
    const switching = session.invoke('profiles:activate', other);
    await Promise.all([switching, assert.rejects(session.invoke(channel, ...args), /profile changed/i)]);
    assert.equal((await session.invoke('focus:timer-state')).id, otherTimer.id);
    assert.equal((await session.invoke('focus:timer-state')).status, 'running');
  }
  await session.invoke('profiles:set-pin', other, '2468');
  const locking = session.invoke('profiles:lock');
  await Promise.all([locking, assert.rejects(session.invoke('focus:timer-cancel'), /locked/i)]);
  await session.invoke('profiles:unlock', '2468');
  assert.equal((await session.invoke('focus:timer-state')).id, otherTimer.id);
});

test('failed expired completion through Pause rearms a retry without duplicate credit', { timeout: 15000 }, async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const started = await session.invoke('focus:timer-start', 'focus', 120_000, 25);
  t.mock.method(Date, 'now', () => started.deadline + 1);
  const complete = focusStore.completeTimer;
  let attempts = 0;
  t.mock.method(focusStore, 'completeTimer', async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error('Temporary write failure');
    return complete(...args);
  });
  const [, finished] = await session.duringMessage('focus:timer-finished', () =>
    assert.rejects(session.invoke('focus:timer-pause'), /Temporary write failure/));
  assert.equal(attempts, 2);
  assert.equal(finished.stats.totalCompletedSessions, 1);
  assert.equal((await session.invoke('focus:load')).stats.totalCompletedSessions, 1);
});

test('shutdown drains accepted timer writes and refuses work added after the drain begins', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const profileId = (await session.invoke('profiles:state')).activeProfileId;
  const entered = deferred();
  const release = deferred();
  const quitting = deferred();
  const save = focusStore.saveTimer;
  t.mock.method(focusStore, 'saveTimer', async (...args) => {
    entered.resolve();
    await release.promise;
    return save(...args);
  });
  const starting = session.invoke('focus:timer-start', 'focus', 60_000, 25);
  await entered.promise;
  session.app.once('before-quit', () => quitting.resolve());
  const stopping = session.stop();
  await quitting.promise;
  try {
    await assert.rejects(session.invoke('focus:timer-cancel'), /closing/i);
    await assert.rejects(session.invoke('profiles:create', { name: 'Too late' }), /closing/i);
  } finally {
    release.resolve();
  }
  const [started] = await Promise.all([starting, stopping]);
  assert.equal((await readJson(fixture.paths(profileId).focus)).activeTimer.id, started.id);
  assert.equal(session.messages.some((message) => message.channel === 'focus:timer-finished'), false);
});

test('a live 1ms focus completion persists statistics and its running successor before emitting', async (t) => {
  const fixture = await desktopFixture(t);
  let session = await fixture.boot();
  const { activeProfileId } = await session.invoke('profiles:state');
  const [started, finished] = await session.duringMessage('focus:timer-finished',
    () => session.invoke('focus:timer-start', 'focus', 1, 37));
  assert.equal(finished.profileId, activeProfileId);
  assert.equal(finished.mode, 'focus');
  assert.equal(finished.error, null);
  assert.equal(finished.stats.totalCompletedSessions, 1);
  assert.equal(finished.stats.totalFocusMinutes, 37);
  assert.equal(finished.stats.cycleProgress, 1);
  assert.deepEqual(finished.stats.dailyHistory, { [localDate(started.deadline)]: { sessions: 1, minutes: 37 } });
  const creditedToday = finished.stats.todayDate === localDate(started.deadline);
  assert.equal(finished.stats.todayCompletedSessions, creditedToday ? 1 : 0);
  assert.equal(finished.stats.todayFocusMinutes, creditedToday ? 37 : 0);
  const focusPath = fixture.paths(activeProfileId).focus;
  const saved = await readJson(focusPath);
  assert.deepEqual(saved.stats, finished.stats);
  assert.notEqual(saved.activeTimer.id, started.id);
  assert.equal(saved.activeTimer.id, finished.nextTimer.id);
  assert.equal(saved.activeTimer.deadline, finished.nextTimer.deadline);
  assert.equal(saved.activeTimer.mode, 'shortBreak');
  assert.equal(saved.activeTimer.status, 'running');
  assert.equal(saved.activeTimer.remainingMs, 5 * 60_000);
  assert.equal(saved.activeTimer.sessionMinutes, 5);
  assert.ok(saved.activeTimer.deadline > started.deadline);
  await assertRunningTimer(session, saved.activeTimer, activeProfileId);
  assert.equal(session.messages.filter((message) => message.channel === 'focus:timer-finished').length, 1);

  session = await fixture.boot();
  await assertRunningTimer(session, saved.activeTimer, activeProfileId);
  const reloaded = await session.invoke('focus:load');
  assert.equal(reloaded.stats.totalCompletedSessions, 1);
  assert.equal(reloaded.stats.totalFocusMinutes, 37);
  assert.deepEqual(reloaded.activeTimer, saved.activeTimer);
  assert.deepEqual(session.messages, []);
});

test('v3.2 recurring IPC rows retain independent states and profile isolation across repeated restarts', async (t) => {
  for (const kind of ['tasks', 'schedule']) {
    await t.test(kind, async (st) => {
      const fixture = await desktopFixture(st);
      let session = await fixture.boot();
      const first = (await session.invoke('profiles:state')).activeProfileId;
      const rows = await addRecurringRows(session, kind);
      assert.equal(rows.length, 3);
      assert.equal(new Set(rows.map((row) => row.id)).size, 3);
      for (const [index, row] of rows.entries()) {
        const date = `2026-11-0${index + 2}`;
        assert.equal(row[kind === 'tasks' ? 'dueDate' : 'date'], date);
        assert.equal(row.skipped, false);
        assert.equal(row.completed, false);
        assert.deepEqual(row.recurrence, {
          ...recurringInput(kind).recurrence, seriesId: rows[0].recurrence.seriesId,
          startDate: '2026-11-02', occurrenceDate: date,
        });
      }
      const fields = recurringInput(kind, 3, '2026-11-03');
      delete fields.recurrence;
      // Omitting scope and rule exercises the default single-occurrence IPC edit.
      await session.invoke(`${kind}:update`, rows[1].id, { ...fields, title: 'Only this occurrence' },
        ...(kind === 'schedule' ? [false] : []));
      const edited = await session.invoke(`${kind}:list`);
      assert.deepEqual(edited[1].recurrence, rows[1].recurrence);
      assert.equal(edited[1].title, 'Only this occurrence');
      assert.deepEqual([edited[0], edited[2]], [rows[0], rows[2]]);
      await session.invoke(`${kind}:set-completed`, rows[0].id, true);
      await session.invoke(`${kind}:skip`, rows[1].id);
      assert.equal((await session.invoke(`${kind}:list`))[1].skipped, true);
      await session.invoke(`${kind}:skip`, rows[1].id, false);
      assert.equal((await session.invoke(`${kind}:list`))[1].skipped, false);
      await session.invoke(`${kind}:skip`, rows[1].id);
      await session.invoke(`${kind}:end-series`, rows[0].id);
      const ended = await session.invoke(`${kind}:list`);
      assert.deepEqual(ended.map((row) => row.id), rows.slice(0, 2).map((row) => row.id));
      assert.equal(ended[0].completed, true);
      assert.ok(ended[0].completedAt);
      assert.equal(ended[1].skipped, true);
      assert.ok(ended.every((row) => row.recurrence.ended === true));
      const other = (await session.invoke('profiles:create', { name: 'Independent series' })).activeProfileId;
      assert.deepEqual(await session.invoke(`${kind}:list`), []);
      const otherRows = await addRecurringRows(session, kind);
      assert.equal(otherRows.length, 3);
      assert.notEqual(otherRows[0].recurrence.seriesId, rows[0].recurrence.seriesId);
      assert.ok(otherRows.every((row) => !rows.some((original) => original.id === row.id)));
      for (let restart = 0; restart < 2; restart += 1) {
        session = await fixture.boot();
        assert.equal((await session.invoke('profiles:state')).activeProfileId, other);
        assert.deepEqual(await session.invoke(`${kind}:list`), otherRows);
        await session.invoke('profiles:activate', first);
        assert.deepEqual(await session.invoke(`${kind}:list`), ended);
        await session.invoke('profiles:activate', other);
      }
    });
  }
});

test('v3.2 series IPC edits and endings preserve earlier, completed and skipped history', async (t) => {
  for (const kind of ['tasks', 'schedule']) {
    await t.test(kind, async (st) => {
      const fixture = await desktopFixture(st);
      const session = await fixture.boot();
      const rows = await addRecurringRows(session, kind, 6);
      assert.equal(rows.length, 6);
      await session.invoke(`${kind}:set-completed`, rows[2].id, true);
      await session.invoke(`${kind}:skip`, rows[3].id);
      const before = await session.invoke(`${kind}:list`);
      const input = { ...recurringInput(kind, 3, '2026-11-03'), title: 'Future occurrences' };
      await session.invoke(`${kind}:update`, ...recurringUpdateArgs(kind, rows[1].id, input, 'series'));
      const updated = await session.invoke(`${kind}:list`);
      assert.equal(updated.length, 6);
      for (const index of [0, 2, 3]) {
        assert.deepEqual(updated.find((row) => row.id === rows[index].id), before[index]);
      }
      const future = updated.filter((row) => row.recurrence.occurrenceDate >= '2026-11-03'
        && !row.completed && !row.skipped);
      assert.deepEqual(future.map((row) => row.recurrence.occurrenceDate).sort(),
        ['2026-11-03', '2026-11-06', '2026-11-07']);
      assert.ok(future.every((row) => row.title === input.title
        && row.recurrence.seriesId === rows[0].recurrence.seriesId
        && row.recurrence.startDate === '2026-11-03'));
      const selected = future.find((row) => row.recurrence.occurrenceDate === '2026-11-03');
      await session.invoke(`${kind}:end-series`, selected.id);
      const ended = await session.invoke(`${kind}:list`);
      assert.deepEqual(ended.map((row) => row.id).sort(),
        [rows[0].id, selected.id, rows[2].id, rows[3].id].sort());
      for (const row of ended) {
        const previous = updated.find((candidate) => candidate.id === row.id);
        assert.deepEqual(row, { ...previous, recurrence: { ...previous.recurrence, ended: true } });
      }
    });
  }
});

test('v3.2 queued recurrence creation, edits, skips and endings cannot cross switch or lock boundaries', async (t) => {
  for (const kind of ['tasks', 'schedule']) {
    await t.test(kind, async (st) => {
      const fixture = await desktopFixture(st);
      const session = await fixture.boot();
      const first = (await session.invoke('profiles:state')).activeProfileId;
      const firstRows = await addRecurringRows(session, kind);
      const other = (await session.invoke('profiles:create', { name: 'Untouched target' })).activeProfileId;
      const targetRows = await addRecurringRows(session, kind);
      await session.invoke('profiles:set-pin', other, '2468');
      const input = { ...recurringInput(kind), title: 'Must never be written' };
      // Valid target IDs ensure a missing-record error cannot mask a cross-profile write.
      const commands = [
        [`${kind}:add`, [input]],
        [`${kind}:update`, recurringUpdateArgs(kind, targetRows[0].id, input)],
        [`${kind}:update`, recurringUpdateArgs(kind, targetRows[0].id, input, 'series')],
        [`${kind}:skip`, [targetRows[0].id]],
        [`${kind}:end-series`, [targetRows[0].id]],
      ];
      for (const [channel, args] of commands) {
        await session.invoke('profiles:activate', first);
        const switching = session.invoke('profiles:activate', other, '2468');
        await Promise.all([switching, assert.rejects(session.invoke(channel, ...args), /profile changed/i)]);
        assert.deepEqual(await session.invoke(`${kind}:list`), targetRows);
        const locking = session.invoke('profiles:lock');
        await Promise.all([locking, assert.rejects(session.invoke(channel, ...args), /locked/i)]);
        await assert.rejects(session.invoke(channel, ...args), /locked/i);
        await session.invoke('profiles:unlock', '2468');
        assert.deepEqual(await session.invoke(`${kind}:list`), targetRows);
      }
      await session.invoke('profiles:activate', first);
      assert.deepEqual(await session.invoke(`${kind}:list`), firstRows);
    });
  }
});

test('shutdown drains a queued capture write before will-quit and preserves it for the next boot', async (t) => {
  const fixture = await desktopFixture(t);
  let session = await fixture.boot();
  const { activeProfileId } = await session.invoke('profiles:state');
  const adding = session.invoke('app:quick-capture-add', activeProfileId, 'Saved while closing');
  const stopping = session.stop();
  await Promise.all([adding, stopping]);
  assert.equal(session.unregisterCalls, 1);
  assert.equal((await readJson(fixture.paths(activeProfileId).tasks))[0].title, 'Saved while closing');
  session = await fixture.boot();
  const tasks = await session.invoke('tasks:list');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Saved while closing');
});

test('v3.3 undo and redo restore exact task and schedule rows across mutation kinds', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  assert.deepEqual(await session.invoke('undo:state'),
    { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  await assert.rejects(session.invoke('undo:undo'), /nothing to undo/i);
  await assert.rejects(session.invoke('undo:redo'), /nothing to redo/i);

  const added = await session.invoke('tasks:add', { title: 'Undoable task', dueDate: '2026-11-02' });
  assert.equal((await session.invoke('undo:state')).undoLabel, 'Add task');
  const completed = await session.invoke('tasks:set-completed', added[0].id, true);
  const undoneCompletion = await session.invoke('undo:undo');
  assert.equal(undoneCompletion.label, 'Complete task');
  assert.equal(undoneCompletion.kind, 'tasks');
  assert.deepEqual(undoneCompletion.rows, added);
  assert.deepEqual(await session.invoke('tasks:list'), added);
  const redoneCompletion = await session.invoke('undo:redo');
  assert.deepEqual(redoneCompletion.rows, completed);
  assert.deepEqual(await session.invoke('tasks:list'), completed);

  await session.invoke('tasks:delete', added[0].id);
  assert.deepEqual(await session.invoke('tasks:list'), []);
  const undoneDelete = await session.invoke('undo:undo');
  assert.equal(undoneDelete.label, 'Delete task');
  assert.deepEqual(undoneDelete.rows, completed);
  assert.deepEqual(await session.invoke('tasks:list'), completed);

  const activity = await session.invoke('schedule:add',
    { title: 'Undoable activity', date: '2026-11-02', startTime: '09:00', endTime: '10:00' }, false);
  assert.equal(activity.saved, true);
  assert.equal((await session.invoke('undo:state')).undoLabel, 'Add activity');
  const undoneActivity = await session.invoke('undo:undo');
  assert.equal(undoneActivity.kind, 'schedules');
  assert.deepEqual(undoneActivity.rows, []);
  assert.deepEqual(await session.invoke('schedule:list'), []);
  assert.deepEqual((await session.invoke('undo:redo')).rows, activity.activities);
  assert.deepEqual(await session.invoke('schedule:list'), activity.activities);
  assert.ok(session.messages.some((message) => message.channel === 'undo:state' && message.payload.canUndo));
});

test('v3.3 new mutations truncate redo, rejected overlaps record nothing, and restarts clear history', async (t) => {
  const fixture = await desktopFixture(t);
  let session = await fixture.boot();
  const first = await session.invoke('tasks:add', { title: 'First' });
  await session.invoke('tasks:add', { title: 'Second' });
  await session.invoke('undo:undo');
  assert.equal((await session.invoke('undo:state')).canRedo, true);
  await session.invoke('tasks:add', { title: 'Third' });
  assert.deepEqual(await session.invoke('undo:state'),
    { canUndo: true, canRedo: false, undoLabel: 'Add task', redoLabel: null });
  await assert.rejects(session.invoke('undo:redo'), /nothing to redo/i);

  await session.invoke('schedule:add',
    { title: 'Existing', date: '2026-11-02', startTime: '09:00', endTime: '10:00' }, false);
  const stateBefore = await session.invoke('undo:state');
  const rejected = await session.invoke('schedule:add',
    { title: 'Conflicting', date: '2026-11-02', startTime: '09:30', endTime: '10:30' }, false);
  assert.equal(rejected.saved, false);
  assert.deepEqual(await session.invoke('undo:state'), stateBefore);

  session = await fixture.boot();
  assert.deepEqual(await session.invoke('undo:state'),
    { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  assert.equal((await session.invoke('tasks:list')).length, 2);
  assert.equal((await session.invoke('tasks:list'))[0].id, first[0].id);
});

test('v3.3 bulk operations are single undoable steps and preserve untouched rows', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const rows = await addRecurringRows(session, 'tasks');
  const oneOff = (await session.invoke('tasks:add', { title: 'One-off' })).at(-1);
  const ids = [rows[0].id, oneOff.id];
  const before = await session.invoke('tasks:list');
  const completed = await session.invoke('tasks:bulk-complete', ids, true);
  assert.equal((await session.invoke('undo:state')).undoLabel, 'Bulk complete tasks');
  const undone = await session.invoke('undo:undo');
  assert.deepEqual(undone.rows, before);
  assert.deepEqual(await session.invoke('tasks:list'), before);
  assert.deepEqual((await session.invoke('undo:redo')).rows, completed);

  const rescheduled = await session.invoke('tasks:bulk-reschedule', [oneOff.id], '2026-11-20');
  assert.equal(rescheduled.find((row) => row.id === oneOff.id).dueDate, '2026-11-20');
  await session.invoke('undo:undo');
  assert.deepEqual(await session.invoke('tasks:list'), completed);

  await session.invoke('tasks:set-completed', rows[0].id, false);
  const reopened = await session.invoke('tasks:list');
  const deleted = await session.invoke('tasks:bulk-delete', ids);
  assert.equal(deleted.some((row) => row.id === oneOff.id), false);
  assert.equal(deleted.find((row) => row.id === rows[0].id).skipped, true);
  await session.invoke('undo:undo');
  assert.deepEqual(await session.invoke('tasks:list'), reopened);

  const activities = await addRecurringRows(session, 'schedule');
  const activityBefore = await session.invoke('schedule:list');
  await session.invoke('schedule:bulk-complete', [activities[0].id, activities[1].id], true);
  assert.equal((await session.invoke('undo:state')).undoLabel, 'Bulk complete activities');
  await session.invoke('undo:undo');
  assert.deepEqual(await session.invoke('schedule:list'), activityBefore);
  await session.invoke('schedule:bulk-delete', [activities[0].id]);
  assert.equal((await session.invoke('schedule:list')).find((row) => row.id === activities[0].id).skipped, true);
  await session.invoke('undo:undo');
  assert.deepEqual(await session.invoke('schedule:list'), activityBefore);
});

test('v3.3 undo history is profile-local, cleared on switch, and blocked while locked', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const first = (await session.invoke('profiles:state')).activeProfileId;
  const rows = await session.invoke('tasks:add', { title: 'First profile task' });
  assert.equal((await session.invoke('undo:state')).canUndo, true);
  const other = (await session.invoke('profiles:create', { name: 'Second profile' })).activeProfileId;
  assert.deepEqual(await session.invoke('undo:state'),
    { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  await session.invoke('profiles:activate', first);
  assert.deepEqual(await session.invoke('undo:state'),
    { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  assert.deepEqual(await session.invoke('tasks:list'), rows);

  await session.invoke('tasks:add', { title: 'Before lock' });
  await session.invoke('profiles:set-pin', first, '2468');
  await session.invoke('profiles:lock');
  await assert.rejects(session.invoke('undo:undo'), /locked/i);
  await assert.rejects(session.invoke('undo:redo'), /locked/i);
  await assert.rejects(session.invoke('undo:state'), /locked/i);
  await session.invoke('profiles:unlock', '2468');
  assert.equal((await session.invoke('undo:state')).canUndo, true);
  await session.invoke('undo:undo');
  assert.deepEqual(await session.invoke('tasks:list'), rows);
  await session.invoke('profiles:activate', other);
  assert.deepEqual(await session.invoke('tasks:list'), []);
});

test('v3.4 delivered reminders fill the inbox, open on click, and support read and clear', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot({ notificationsSupported: true });
  const reminderAt = new Date(Date.now() - 60_000).toISOString();
  const task = (await session.invoke('tasks:add', { title: 'Inbox reminder', reminderAt })).at(-1);
  const eventId = `task:${task.id}:custom:${reminderAt}`;

  await waitFor(() => session.notifications.length === 1, 'reminder delivery');
  assert.equal(session.notifications[0].shown, true);
  assert.equal(session.notifications[0].options.title, 'Task reminder: Inbox reminder');

  const initial = await session.invoke('notifications:list');
  assert.equal(initial.enabled, true);
  assert.equal(initial.unreadCount, 1);
  assert.deepEqual(initial.inbox.map((entry) => entry.id), [eventId]);
  assert.equal(initial.inbox[0].readAt, null);
  assert.equal(initial.inbox[0].snoozable, true);
  assert.equal(initial.inbox[0].event.targetId, task.id);
  assert.deepEqual(initial.events.filter((event) => event.id === eventId), []);

  session.notifications[0].emit('click');
  assert.deepEqual(session.windows[0].actions.slice(-2), ['show', 'focus']);
  assert.deepEqual(
    session.messages.find((message) => message.channel === 'notifications:open-target').payload,
    { targetType: 'task', targetId: task.id, targetDate: null },
  );

  const read = await session.invoke('notifications:mark-read', [eventId]);
  assert.equal(read.unreadCount, 0);
  assert.ok(read.inbox[0].readAt);
  await waitFor(() => (
    session.messages.filter((message) => message.channel === 'notifications:changed')
      .at(-1)?.payload.unreadCount === 0
  ), 'unread badge message');
  assert.equal((await session.invoke('notifications:mark-read', 'all')).unreadCount, 0);
  await assert.rejects(session.invoke('notifications:mark-read', []), /identifiers are invalid/);

  assert.deepEqual(await session.invoke('notifications:clear-history'), { inbox: [], unreadCount: 0 });
  const cleared = await session.invoke('notifications:list');
  assert.deepEqual(cleared.inbox, []);
  assert.equal(cleared.unreadCount, 0);
});

test('v3.4 snooze defers delivery, suppresses the original, and re-fires exactly once', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot({ notificationsSupported: true });
  const reminderAt = new Date(Date.now() + 4000).toISOString();
  const task = (await session.invoke('tasks:add', { title: 'Deferred reminder', reminderAt })).at(-1);
  const eventId = `task:${task.id}:custom:${reminderAt}`;

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(session.notifications.length, 0);
  const queued = await session.invoke('notifications:snooze', eventId, new Date(Date.now() + 3600_000).toISOString());
  assert.deepEqual(Object.keys(queued.snoozes), [eventId]);
  assert.deepEqual(await session.invoke('notifications:unsnooze', eventId), { snoozes: {} });

  assert.deepEqual(await session.invoke('notifications:snooze', eventId, reminderAt), {
    snoozes: { [eventId]: reminderAt },
  });
  assert.deepEqual((await session.invoke('notifications:list')).snoozes, { [eventId]: reminderAt });

  await waitFor(() => session.notifications.length >= 1, 'snoozed reminder delivery', 10_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(session.notifications.length, 1);

  const delivered = await session.invoke('notifications:list');
  assert.deepEqual(delivered.snoozes, {});
  assert.deepEqual(delivered.inbox.map((entry) => entry.id), [`${eventId}:snoozed:${reminderAt}`]);
  assert.equal(delivered.unreadCount, 1);
  await assert.rejects(
    session.invoke('notifications:snooze', 'task:missing:custom:2026-01-01T00:00:00.000Z', reminderAt),
    /no longer available/,
  );
  await assert.rejects(session.invoke('notifications:snooze', eventId, 'not-a-date'), /invalid/i);
});

test('v3.4 test notifications respect platform support and never navigate', async (t) => {
  const fixture = await desktopFixture(t);
  const unsupported = await fixture.boot();
  assert.deepEqual(await unsupported.invoke('notifications:test'), { supported: false, shown: false });
  assert.equal(unsupported.notifications.length, 0);

  const session = await fixture.boot({ notificationsSupported: true });
  assert.deepEqual(await session.invoke('notifications:test'), { supported: true, shown: true });
  assert.equal(session.notifications.length, 1);
  assert.equal(session.notifications[0].options.title, 'TaskForge test notification');
  session.notifications[0].emit('click');
  assert.equal(
    session.messages.filter((message) => message.channel === 'notifications:open-target').length,
    0,
  );
  assert.deepEqual((await session.invoke('notifications:list')).inbox, []);
});

test('v3.5 calendar and CSV exports write files and respect cancellation and profile locks', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot();
  const { activeProfileId } = await session.invoke('profiles:state');
  const tasks = await session.invoke('tasks:add', {
    title: 'Plan, review; ship',
    description: 'Line one\nLine two',
    priority: 'High',
    dueDate: '2026-11-20',
  });
  await session.invoke('tasks:add', { title: 'Someday idea' });
  await session.invoke('tasks:set-completed', tasks[0].id, true);
  await session.invoke('schedule:add', {
    title: 'Deep work',
    date: '2026-11-13',
    startTime: '09:00',
    endTime: '10:30',
    category: 'Focus',
    reminderMinutesBefore: 15,
  }, false);

  const calendarPath = path.join(fixture.directory, 'workspace.ics');
  session.queueSaveDialog(calendarPath);
  const calendar = await session.invoke('export:calendar');
  assert.equal(calendar.canceled, false);
  assert.equal(calendar.fileName, 'workspace.ics');
  assert.deepEqual(calendar.counts, { activities: 1, tasks: 1 });
  assert.match(session.saveDialogRequests[0].defaultPath, /TaskForge-calendar-\d{4}-\d{2}-\d{2}\.ics$/);
  const ics = await fs.readFile(calendarPath, 'utf8');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261113T090000\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261120\r\n/);
  assert.match(ics, /SUMMARY:Plan\\, review\\; ship/);
  assert.match(ics, /STATUS:COMPLETED/);
  assert.doesNotMatch(ics, /SUMMARY:Someday idea/);
  assert.match(ics, /TRIGGER:-PT15M/);

  const tasksPath = path.join(fixture.directory, 'tasks.csv');
  session.queueSaveDialog(tasksPath);
  const tasksExport = await session.invoke('export:tasks-csv');
  assert.equal(tasksExport.count, 2);
  const tasksCsv = await fs.readFile(tasksPath, 'utf8');
  assert.ok(tasksCsv.startsWith('\uFEFF'));
  assert.match(tasksCsv, /"Plan, review; ship"/);
  assert.match(tasksCsv, /"Line one\nLine two"/);

  const schedulePath = path.join(fixture.directory, 'schedule.csv');
  session.queueSaveDialog(schedulePath);
  const scheduleExport = await session.invoke('export:activities-csv');
  assert.equal(scheduleExport.count, 1);
  const scheduleCsv = await fs.readFile(schedulePath, 'utf8');
  assert.match(scheduleCsv, /Deep work,.*Focus,2026-11-13,09:00,10:30,No,,No,15,No,/);

  session.queueCanceledSaveDialog();
  assert.deepEqual(await session.invoke('export:tasks-csv'), { canceled: true });

  await session.invoke('profiles:set-pin', activeProfileId, '1357');
  await session.invoke('profiles:lock');
  await assert.rejects(session.invoke('export:calendar'), /locked/i);
  await assert.rejects(session.invoke('export:tasks-csv'), /locked/i);
  await assert.rejects(session.invoke('export:activities-csv'), /locked/i);
});

test('v3.4 inbox and snoozes are profile-local, lock-gated, and cleared by reset', async (t) => {
  const fixture = await desktopFixture(t);
  const session = await fixture.boot({ notificationsSupported: true });
  const first = (await session.invoke('profiles:state')).activeProfileId;
  const reminderAt = new Date(Date.now() - 60_000).toISOString();
  const task = (await session.invoke('tasks:add', { title: 'Private reminder', reminderAt })).at(-1);
  const eventId = `task:${task.id}:custom:${reminderAt}`;
  await waitFor(() => session.notifications.length === 1, 'reminder delivery');
  await session.invoke('notifications:snooze', eventId, new Date(Date.now() + 3600_000).toISOString());

  const other = (await session.invoke('profiles:create', { name: 'Other profile' })).activeProfileId;
  assert.notEqual(other, first);
  assert.deepEqual(await session.invoke('notifications:list'), {
    enabled: true, events: [], inbox: [], unreadCount: 0, snoozes: {},
  });

  await session.invoke('profiles:activate', first);
  const restored = await session.invoke('notifications:list');
  assert.deepEqual(restored.inbox.map((entry) => entry.id), [eventId]);
  assert.deepEqual(Object.keys(restored.snoozes), [eventId]);

  await session.invoke('profiles:set-pin', first, '2468');
  await session.invoke('profiles:lock');
  await assert.rejects(session.invoke('notifications:list'), /locked/i);
  await assert.rejects(session.invoke('notifications:mark-read', 'all'), /locked/i);
  await assert.rejects(session.invoke('notifications:clear-history'), /locked/i);
  await assert.rejects(session.invoke('notifications:snooze', eventId, reminderAt), /locked/i);
  await assert.rejects(session.invoke('notifications:unsnooze', eventId), /locked/i);

  await session.invoke('profiles:unlock', '2468');
  await session.invoke('app:reset-data');
  const reset = await session.invoke('notifications:list');
  assert.deepEqual(reset.inbox, []);
  assert.deepEqual(reset.snoozes, {});
  assert.equal(reset.unreadCount, 0);
});
