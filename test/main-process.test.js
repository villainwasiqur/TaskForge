const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const profileStore = require('../src/profile-store');

test('reset clears only the active profile data and refresh recreates defaults', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-main-test-'));
  const userDataPath = path.join(directory, 'user-data');
  const handlers = new Map();
  const appListeners = new Map();
  const mainPath = require.resolve('../main');
  let startup;
  let acknowledgeQuit;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const app = {
    // Ignore any developer userData override; every path stays in this test's temp directory.
    isPackaged: true,
    whenReady: () => ({
      then(callback) {
        startup = Promise.resolve().then(callback);
        return startup;
      },
    }),
    requestSingleInstanceLock: () => true,
    getPath: (name) => (name === 'userData' ? userDataPath : directory),
    getVersion: () => '3.1.0',
    setAppUserModelId: () => {},
    on: (name, listener) => appListeners.set(name, listener),
    quit: () => acknowledgeQuit?.(),
  };
  t.after(async () => {
    try {
      await startup?.catch(() => {});
      const drained = new Promise((resolve) => { acknowledgeQuit = resolve; });
      let prevented = false;
      appListeners.get('before-quit')?.({ preventDefault() { prevented = true; } });
      if (prevented) await drained;
    } finally {
      appListeners.get('will-quit')?.();
      delete require.cache[mainPath];
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  class BrowserWindow {
    constructor() {
      this.webContents = { send: () => {}, on: () => {} };
    }

    on() {}

    loadFile() { resolveReady(); }

    isDestroyed() {
      return false;
    }

    static getAllWindows() {
      return [];
    }
  }
  const electron = {
    app,
    BrowserWindow,
    Tray: class {
      setToolTip() {}
      setContextMenu() {}
      on() {}
      destroy() {}
    },
    Menu: { buildFromTemplate: (template) => template },
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    dialog: { showErrorBox: (_title, message) => rejectReady(new Error(message)) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    Notification: class {
      static isSupported() {
        return false;
      }
    },
    powerMonitor: { on: () => {} },
  };
  const originalLoad = Module._load;
  delete require.cache[mainPath];
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === 'electron') {
      return electron;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require('../main');
  } finally {
    Module._load = originalLoad;
  }
  const readyTimeout = setTimeout(() => rejectReady(new Error('Main window did not load.')), 10_000);
  try {
    await ready;
  } finally {
    clearTimeout(readyTimeout);
  }

  assert.equal(handlers.has('profiles:state'), true);
  const profileView = await handlers.get('profiles:state')();
  assert.equal(profileView.locked, false);
  assert.equal(profileView.profiles.length, 1);
  const { activeProfileId } = profileView;
  const profileDirectory = path.join(userDataPath, 'profiles', activeProfileId);
  const taskFilePath = path.join(profileDirectory, 'taskforge-tasks.json');
  assert.deepEqual(await handlers.get('tasks:list')(), []);
  assert.equal((await fs.stat(taskFilePath)).isFile(), true);
  await fs.writeFile(
    path.join(profileDirectory, 'backup-state.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), fileName: 'previous.json' }),
  );
  await fs.writeFile(path.join(profileDirectory, 'notification-state.json'), '[]');

  const otherProfile = await handlers.get('profiles:create')(null, {
    name: 'Other',
    color: '#10B981',
  });
  assert.equal(otherProfile.profiles.length, 2);
  assert.equal(otherProfile.activeProfileId !== activeProfileId, true);
  await handlers.get('profiles:activate')(null, activeProfileId);

  assert.equal(await handlers.get('app:get-version')(), '3.1.0');
  const resetResult = await handlers.get('app:reset-data')(null);
  assert.equal(resetResult.version, '3.1.0');
  assert.deepEqual(await handlers.get('tasks:list')(), []);
  assert.deepEqual(await handlers.get('schedule:list')(), []);
  assert.deepEqual(await handlers.get('habits:list')(), []);
  assert.equal((await fs.stat(taskFilePath)).isFile(), true);
  assert.equal((await fs.stat(path.join(profileDirectory, 'schedules.json'))).isFile(), true);
  assert.equal((await fs.stat(path.join(profileDirectory, 'habits.json'))).isFile(), true);

  const state = await profileStore.readState(userDataPath);
  assert.equal(state.profiles.length, 2);
  assert.equal(
    (await fs.stat(path.join(userDataPath, 'profiles', state.profiles[1].id))).isDirectory(),
    true,
  );

  const otherProfileId = state.profiles[1].id;
  const protectedView = await handlers.get('profiles:set-pin')(null, state.activeProfileId, '2468');
  assert.equal(protectedView.activeProfile.hasPin, true);
  const lockedView = await handlers.get('profiles:lock')();
  assert.equal(lockedView.locked, true);
  await assert.rejects(async () => handlers.get('tasks:list')(), /locked/i);
  await assert.rejects(
    handlers.get('profiles:update')(null, state.activeProfileId, { name: 'Renamed', color: '#4C8DFF' }),
    /locked/i,
  );
  await assert.rejects(handlers.get('profiles:delete')(null, otherProfileId), /locked/i);
  await assert.rejects(handlers.get('profiles:unlock')(null, '0000'), /Incorrect PIN/);
  const unlockedView = await handlers.get('profiles:unlock')(null, '2468');
  assert.equal(unlockedView.locked, false);
  assert.deepEqual(await handlers.get('tasks:list')(), []);

});
