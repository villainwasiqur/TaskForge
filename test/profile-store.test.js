const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const profileStore = require('../src/profile-store');

async function createTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-profile-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function findProfile(state, id) {
  return state.profiles.find((profile) => profile.id === id);
}

test('initialization creates a default profile and exposes redacted metadata', async (t) => {
  const directory = await createTemporaryDirectory(t);

  const state = await profileStore.readState(directory);
  assert.equal(state.version, 1);
  assert.equal(state.profiles.length, 1);
  const [profile] = state.profiles;
  assert.equal(profile.name, 'Default');
  assert.equal(profile.color, profileStore.defaultProfileColor);
  assert.equal(profile.pinHash, null);
  assert.equal(profile.pinSalt, null);
  assert.equal(state.activeProfileId, profile.id);

  const publicState = await profileStore.getPublicState(directory);
  assert.deepEqual(Object.keys(publicState).sort(), ['activeProfileId', 'profiles']);
  assert.equal(publicState.profiles[0].hasPin, false);
  assert.equal(Object.hasOwn(publicState.profiles[0], 'pinHash'), false);
  assert.equal(Object.hasOwn(publicState.profiles[0], 'pinSalt'), false);

  const dataDirectory = path.join(directory, 'profiles', profile.id);
  const directoryInfo = await fs.stat(dataDirectory);
  assert.equal(directoryInfo.isDirectory(), true);
  assert.equal((await fs.stat(path.join(directory, 'profiles.json'))).isFile(), true);
});

test('initialization migrates legacy root data into the default profile', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const legacyFiles = {
    'taskforge-tasks.json': '[{"id":"legacy-task"}]\n',
    'schedules.json': '[{"id":"legacy-activity"}]\n',
    'focus.json': '{"settings":{"focusMinutes":25}}\n',
    'settings.json': '{"theme":"dark"}\n',
    'habits.json': '[{"id":"legacy-habit"}]\n',
    'goals.json': '[{"id":"legacy-goal"}]\n',
    'notification-state.json': '{"delivered":[]}\n',
    'backup-state.json': '{"createdAt":"2026-01-01T00:00:00.000Z"}\n',
  };
  await Promise.all(Object.entries(legacyFiles).map(([fileName, contents]) =>
    fs.writeFile(path.join(directory, fileName), contents, 'utf8')));
  await fs.mkdir(path.join(directory, 'backups'), { recursive: true });
  await fs.writeFile(path.join(directory, 'backups', 'safety.json'), '{"safe":true}\n', 'utf8');

  const state = await profileStore.readState(directory);
  assert.equal(state.profiles.length, 1);
  const profile = state.profiles[0];
  const profileDirectory = path.join(directory, 'profiles', profile.id);

  for (const [fileName, contents] of Object.entries(legacyFiles)) {
    assert.equal(await fs.readFile(path.join(profileDirectory, fileName), 'utf8'), contents);
    await assert.rejects(fs.stat(path.join(directory, fileName)), { code: 'ENOENT' });
  }
  assert.equal(
    await fs.readFile(path.join(profileDirectory, 'backups', 'safety.json'), 'utf8'),
    '{"safe":true}\n',
  );
  await assert.rejects(fs.stat(path.join(directory, 'backups')), { code: 'ENOENT' });
});

test('profiles can be created, updated, activated, and renamed uniquely', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const initial = await profileStore.readState(directory);
  const defaultProfile = initial.profiles[0];

  const created = await profileStore.createProfile(directory, {
    name: '  Study  ',
    color: '#10B981',
  });
  assert.equal(created.name, 'Study');
  assert.equal(created.color, '#10b981');
  assert.equal(created.hasPin, false);
  assert.equal(initial.activeProfileId, defaultProfile.id, 'creating a profile must not switch');

  await assert.rejects(
    profileStore.createProfile(directory, { name: 'study', color: '#10B981' }),
    /already exists/,
  );
  await assert.rejects(
    profileStore.createProfile(directory, { name: 'Bad color', color: 'green' }),
    /hex color/,
  );
  await assert.rejects(
    profileStore.createProfile(directory, { name: '', color: '#10B981' }),
    /name is required/,
  );

  const updated = await profileStore.updateProfile(directory, created.id, {
    name: 'Deep work',
    color: '#F59E0B',
  });
  assert.equal(updated.name, 'Deep work');
  assert.equal(updated.color, '#f59e0b');
  await assert.rejects(
    profileStore.updateProfile(directory, created.id, { name: 'default', color: '#F59E0B' }),
    /already exists/,
  );

  const activated = await profileStore.setActiveProfile(directory, created.id);
  assert.equal(activated.id, created.id);
  assert.equal((await profileStore.getActiveProfile(directory)).id, created.id);

  const publicState = await profileStore.getPublicState(directory);
  assert.equal(publicState.activeProfileId, created.id);
  assert.deepEqual(
    publicState.profiles.map((profile) => profile.name),
    ['Default', 'Deep work'],
  );
});

test('profile PINs are salted, hashed, verifiable, and removable', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const profile = await profileStore.createProfile(directory, {
    name: 'Private',
    color: '#8B5CF6',
    pin: '2468',
  });
  assert.equal(profile.hasPin, true);

  const state = await profileStore.readState(directory);
  const stored = findProfile(state, profile.id);
  assert.match(stored.pinHash, /^[\da-f]{128}$/);
  assert.match(stored.pinSalt, /^[\da-f]{32}$/);
  assert.notEqual(stored.pinHash, '2468');
  assert.equal(Object.hasOwn(stored, 'pin'), false);
  assert.equal(Object.values(stored).includes('2468'), false);

  assert.equal(await profileStore.verifyPin(stored, '2468'), true);
  assert.equal(await profileStore.verifyPin(stored, '8642'), false);
  assert.equal(await profileStore.verifyPin(stored, '246'), false);
  assert.equal(await profileStore.verifyPin(stored, 2468), false);

  const second = await profileStore.createProfile(directory, {
    name: 'Private two',
    color: '#8B5CF6',
    pin: '2468',
  });
  const secondStored = findProfile(await profileStore.readState(directory), second.id);
  assert.notEqual(secondStored.pinHash, stored.pinHash);
  assert.notEqual(secondStored.pinSalt, stored.pinSalt);

  await assert.rejects(
    profileStore.createProfile(directory, { name: 'Short PIN', color: '#8B5CF6', pin: '12' }),
    /4 to 8 digits/,
  );

  const removed = await profileStore.setProfilePin(directory, profile.id, null);
  assert.equal(removed.hasPin, false);
  const removedStored = findProfile(await profileStore.readState(directory), profile.id);
  assert.equal(removedStored.pinHash, null);
  assert.equal(removedStored.pinSalt, null);
  assert.equal(await profileStore.verifyPin(removedStored, '2468'), false);

  const reset = await profileStore.setProfilePin(directory, profile.id, '135790');
  assert.equal(reset.hasPin, true);
  const resetStored = findProfile(await profileStore.readState(directory), profile.id);
  assert.equal(await profileStore.verifyPin(resetStored, '135790'), true);
});

test('deleting a profile preserves its data directory and rejects unsafe deletions', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const state = await profileStore.readState(directory);
  const activeId = state.activeProfileId;
  const other = await profileStore.createProfile(directory, {
    name: 'Disposable',
    color: '#EF4444',
  });
  const otherDirectory = profileStore.getProfileDataDirectory(directory, other.id);
  await fs.writeFile(path.join(otherDirectory, 'taskforge-tasks.json'), '[]\n', 'utf8');

  await assert.rejects(
    profileStore.deleteProfile(directory, activeId),
    /active profile cannot be deleted/,
  );

  const deleted = await profileStore.deleteProfile(directory, other.id);
  assert.equal(deleted.id, other.id);
  await assert.rejects(fs.stat(otherDirectory), { code: 'ENOENT' });
  const restoredState = await profileStore.readState(directory);
  assert.equal(restoredState.profiles.some((profile) => profile.id === other.id), false);
  assert.equal(restoredState.activeProfileId, activeId);

  const trashEntries = await fs.readdir(path.join(directory, 'deleted-profiles'));
  assert.equal(trashEntries.length, 1);
  assert.match(trashEntries[0], new RegExp(`^${other.id}-`));
  assert.equal(
    await fs.readFile(
      path.join(directory, 'deleted-profiles', trashEntries[0], 'taskforge-tasks.json'),
      'utf8',
    ),
    '[]\n',
  );
});

test('corrupt profile metadata is preserved and replaced with a working default', async (t) => {
  const directory = await createTemporaryDirectory(t);
  await fs.writeFile(path.join(directory, 'profiles.json'), '{not valid', 'utf8');

  const state = await profileStore.readState(directory);
  assert.equal(state.profiles.length, 1);
  assert.equal(state.profiles[0].name, 'Default');
  assert.equal(state.activeProfileId, state.profiles[0].id);

  const entries = await fs.readdir(directory);
  assert.equal(entries.some((entry) => entry.startsWith('profiles.json.corrupt-')), true);
  const profiles = JSON.parse(await fs.readFile(path.join(directory, 'profiles.json'), 'utf8'));
  assert.equal(profiles.profiles[0].id, state.profiles[0].id);
});

test('profile data paths are scoped per profile and reject invalid identifiers', async (t) => {
  const directory = await createTemporaryDirectory(t);
  const first = await profileStore.createProfile(directory, { name: 'One', color: '#123456' });
  const second = await profileStore.createProfile(directory, { name: 'Two', color: '#654321' });

  const firstPaths = profileStore.getProfileDataPaths(directory, first.id);
  const secondPaths = profileStore.getProfileDataPaths(directory, second.id);
  assert.notEqual(firstPaths.tasks, secondPaths.tasks);
  assert.equal(path.dirname(firstPaths.tasks), path.join(directory, 'profiles', first.id));
  assert.equal(path.basename(firstPaths.backupsDirectory), 'backups');
  assert.equal(path.basename(firstPaths.notificationState), 'notification-state.json');
  assert.equal(path.basename(firstPaths.backupState), 'backup-state.json');
  assert.throws(() => profileStore.getProfileDataPaths(directory, '../escape'), /Invalid profile identifier/);
});
