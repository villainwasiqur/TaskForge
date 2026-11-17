const fs = require('node:fs/promises');
const path = require('node:path');
const {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(scrypt);

const profileStateVersion = 1;
const defaultProfileColor = '#4C8DFF';
const profileIdPattern = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const colorPattern = /^#[\da-f]{6}$/i;
const pinPattern = /^\d{4,8}$/;
const pinHashPattern = /^[\da-f]{128}$/i;
const pinSaltPattern = /^[\da-f]{32}$/i;
const pinHashLength = 64;
const pinSaltLength = 16;
const profileNameLimit = 40;
const profilesDirectoryName = 'profiles';
const deletedProfilesDirectoryName = 'deleted-profiles';
const profilesFileName = 'profiles.json';
const dataFileNames = {
  tasks: 'taskforge-tasks.json',
  schedules: 'schedules.json',
  focus: 'focus.json',
  settings: 'settings.json',
  habits: 'habits.json',
  goals: 'goals.json',
  notificationState: 'notification-state.json',
  notificationSnoozes: 'notification-snoozes.json',
  backupState: 'backup-state.json',
};
const legacyDataNames = [
  dataFileNames.tasks,
  dataFileNames.schedules,
  dataFileNames.focus,
  dataFileNames.settings,
  dataFileNames.habits,
  dataFileNames.goals,
  dataFileNames.notificationState,
  dataFileNames.notificationSnoozes,
  dataFileNames.backupState,
];
const legacyBackupsDirectoryName = 'backups';

const initializationPromises = new Map();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidIsoTimestamp(value) {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateProfileId(id) {
  if (typeof id !== 'string' || !profileIdPattern.test(id)) {
    throw new TypeError('Invalid profile identifier.');
  }
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !pinPattern.test(pin)) {
    throw new TypeError('Profile PIN must be 4 to 8 digits.');
  }
  return pin;
}

function validateProfileName(input) {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!name || name.length > profileNameLimit) {
    throw new TypeError(`Profile name is required and must be ${profileNameLimit} characters or fewer.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new TypeError('Profile name contains unsupported characters.');
  }
  return name;
}

function validateProfileColor(input) {
  if (typeof input !== 'string' || !colorPattern.test(input)) {
    throw new TypeError('Profile color must be a six-digit hex color.');
  }
  return input.toLowerCase();
}

function validateProfileFields(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('Profile data must be an object.');
  }
  return {
    name: validateProfileName(input.name),
    color: validateProfileColor(input.color === undefined ? defaultProfileColor : input.color),
  };
}

function isValidProfileRecord(profile) {
  return isPlainObject(profile)
    && typeof profile.id === 'string'
    && profileIdPattern.test(profile.id)
    && typeof profile.name === 'string'
    && profile.name.length > 0
    && profile.name.length <= profileNameLimit
    && !/[\u0000-\u001f\u007f]/.test(profile.name)
    && typeof profile.color === 'string'
    && colorPattern.test(profile.color)
    && ((profile.pinHash === null && profile.pinSalt === null)
      || (typeof profile.pinHash === 'string'
        && pinHashPattern.test(profile.pinHash)
        && typeof profile.pinSalt === 'string'
        && pinSaltPattern.test(profile.pinSalt)))
    && isValidIsoTimestamp(profile.createdAt)
    && isValidIsoTimestamp(profile.updatedAt);
}

function validateState(input) {
  if (!isPlainObject(input)
    || Object.keys(input).sort().join(',') !== 'activeProfileId,profiles,version'
    || input.version !== profileStateVersion
    || !Array.isArray(input.profiles)
    || input.profiles.length === 0
    || !input.profiles.every(isValidProfileRecord)
    || new Set(input.profiles.map((profile) => profile.id)).size !== input.profiles.length
    || !input.profiles.some((profile) => profile.id === input.activeProfileId)) {
    throw new TypeError('Profile data is incomplete or invalid.');
  }
  return input;
}

function profilesFilePath(userDataPath) {
  return path.join(userDataPath, profilesFileName);
}

function getProfileDataDirectory(userDataPath, profileId) {
  validateProfileId(profileId);
  return path.join(userDataPath, profilesDirectoryName, profileId);
}

function getProfileDataPaths(userDataPath, profileId) {
  const directory = getProfileDataDirectory(userDataPath, profileId);
  return {
    tasks: path.join(directory, dataFileNames.tasks),
    schedules: path.join(directory, dataFileNames.schedules),
    focus: path.join(directory, dataFileNames.focus),
    settings: path.join(directory, dataFileNames.settings),
    habits: path.join(directory, dataFileNames.habits),
    goals: path.join(directory, dataFileNames.goals),
    notificationState: path.join(directory, dataFileNames.notificationState),
    notificationSnoozes: path.join(directory, dataFileNames.notificationSnoozes),
    backupState: path.join(directory, dataFileNames.backupState),
    backupsDirectory: path.join(directory, legacyBackupsDirectoryName),
  };
}

function toPublicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    hasPin: profile.pinHash !== null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function toPublicState(state) {
  return {
    activeProfileId: state.activeProfileId,
    profiles: state.profiles.map(toPublicProfile),
  };
}

async function hashPin(pin) {
  validatePin(pin);
  const salt = randomBytes(pinSaltLength);
  const hash = await scryptAsync(pin, salt, pinHashLength);
  return { pinHash: hash.toString('hex'), pinSalt: salt.toString('hex') };
}

async function verifyPin(profile, pin) {
  if (!isValidProfileRecord(profile) || profile.pinHash === null) {
    return false;
  }
  if (typeof pin !== 'string' || !pinPattern.test(pin)) {
    return false;
  }
  const expectedHash = Buffer.from(profile.pinHash, 'hex');
  const salt = Buffer.from(profile.pinSalt, 'hex');
  const actualHash = await scryptAsync(pin, salt, expectedHash.length);
  return actualHash.length === expectedHash.length
    && timingSafeEqual(actualHash, expectedHash);
}

async function movePath(source, destination) {
  try {
    await fs.rename(source, destination);
    return;
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }
  }
  await fs.cp(source, destination, { recursive: true, force: true, errorOnExist: false });
  await fs.rm(source, { recursive: true, force: true });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function migrateLegacyData(userDataPath, profileId) {
  const profileDirectory = getProfileDataDirectory(userDataPath, profileId);
  await fs.mkdir(profileDirectory, { recursive: true });
  const moved = [];
  const timestamp = Date.now();
  for (const fileName of legacyDataNames) {
    const source = path.join(userDataPath, fileName);
    let info;
    try {
      info = await fs.stat(source);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    if (!info.isFile()) {
      continue;
    }
    let destination = path.join(profileDirectory, fileName);
    if (await pathExists(destination)) {
      destination = path.join(profileDirectory, `${fileName}.legacy-${timestamp}`);
    }
    await movePath(source, destination);
    moved.push(fileName);
  }

  const legacyBackups = path.join(userDataPath, legacyBackupsDirectoryName);
  try {
    const info = await fs.stat(legacyBackups);
    if (info.isDirectory()) {
      let destination = path.join(profileDirectory, legacyBackupsDirectoryName);
      if (await pathExists(destination)) {
        destination = path.join(profileDirectory, `${legacyBackupsDirectoryName}.legacy-${timestamp}`);
      }
      await movePath(legacyBackups, destination);
      moved.push(legacyBackupsDirectoryName);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  return moved;
}

async function writeState(userDataPath, state) {
  const filePath = profilesFilePath(userDataPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        console.error('Could not remove the temporary profile data file.', cleanupError);
      }
    }
    throw error;
  }
}

async function preserveCorruptFile(filePath, reason) {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  await fs.rename(filePath, backupPath);
  console.error(`Profile data was invalid (${reason}); moved the file to ${backupPath} and created a default profile.`);
}

async function createInitialState(userDataPath) {
  const now = new Date().toISOString();
  const profile = {
    id: randomUUID(),
    name: 'Default',
    color: defaultProfileColor,
    pinHash: null,
    pinSalt: null,
    createdAt: now,
    updatedAt: now,
  };
  const state = {
    version: profileStateVersion,
    activeProfileId: profile.id,
    profiles: [profile],
  };
  await writeState(userDataPath, state);
  await fs.mkdir(getProfileDataDirectory(userDataPath, profile.id), { recursive: true });
  try {
    await migrateLegacyData(userDataPath, profile.id);
  } catch (error) {
    console.error('Could not move existing TaskForge data into the default profile.', error);
  }
  return state;
}

async function loadStateFile(userDataPath) {
  const filePath = profilesFilePath(userDataPath);
  let contents;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return createInitialState(userDataPath);
    }
    throw error;
  }

  try {
    return validateState(JSON.parse(contents));
  } catch (error) {
    await preserveCorruptFile(filePath, error.message);
    return createInitialState(userDataPath);
  }
}

async function initialize(userDataPath) {
  const existing = initializationPromises.get(userDataPath);
  if (existing) {
    return existing;
  }
  const promise = loadStateFile(userDataPath)
    .finally(() => initializationPromises.delete(userDataPath));
  initializationPromises.set(userDataPath, promise);
  return promise;
}

async function readState(userDataPath) {
  return initialize(userDataPath);
}

function findProfile(state, profileId) {
  validateProfileId(profileId);
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error('Profile not found.');
  }
  return profile;
}

function assertUniqueName(state, name, excludedId = null) {
  if (state.profiles.some((profile) => profile.id !== excludedId
    && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new TypeError('A profile with this name already exists.');
  }
}

async function getPublicState(userDataPath) {
  return toPublicState(await readState(userDataPath));
}

async function getActiveProfile(userDataPath) {
  const state = await readState(userDataPath);
  return findProfile(state, state.activeProfileId);
}

async function getProfile(userDataPath, profileId) {
  return findProfile(await readState(userDataPath), profileId);
}

async function createProfile(userDataPath, input) {
  const fields = validateProfileFields(input);
  const state = await readState(userDataPath);
  assertUniqueName(state, fields.name);
  const pin = input.pin === undefined || input.pin === null || input.pin === '' ? null : validatePin(input.pin);
  const pinFields = pin === null ? { pinHash: null, pinSalt: null } : await hashPin(pin);
  const now = new Date().toISOString();
  const profile = {
    id: randomUUID(),
    ...fields,
    ...pinFields,
    createdAt: now,
    updatedAt: now,
  };
  await fs.mkdir(getProfileDataDirectory(userDataPath, profile.id), { recursive: true });
  const nextState = { ...state, profiles: [...state.profiles, profile] };
  try {
    await writeState(userDataPath, nextState);
  } catch (error) {
    await fs.rm(getProfileDataDirectory(userDataPath, profile.id), { recursive: true, force: true })
      .catch(() => {});
    throw error;
  }
  return toPublicProfile(profile);
}

async function updateProfile(userDataPath, profileId, input) {
  const fields = validateProfileFields(input);
  const state = await readState(userDataPath);
  assertUniqueName(state, fields.name, profileId);
  const profile = findProfile(state, profileId);
  const updated = {
    ...profile,
    ...fields,
    updatedAt: new Date().toISOString(),
  };
  const nextState = {
    ...state,
    profiles: state.profiles.map((item) => (item.id === profileId ? updated : item)),
  };
  await writeState(userDataPath, nextState);
  return toPublicProfile(updated);
}

async function setProfilePin(userDataPath, profileId, pin) {
  const state = await readState(userDataPath);
  const profile = findProfile(state, profileId);
  const pinFields = pin === null || pin === undefined || pin === ''
    ? { pinHash: null, pinSalt: null }
    : await hashPin(validatePin(pin));
  const updated = {
    ...profile,
    ...pinFields,
    updatedAt: new Date().toISOString(),
  };
  const nextState = {
    ...state,
    profiles: state.profiles.map((item) => (item.id === profileId ? updated : item)),
  };
  await writeState(userDataPath, nextState);
  return toPublicProfile(updated);
}

async function setActiveProfile(userDataPath, profileId) {
  const state = await readState(userDataPath);
  const profile = findProfile(state, profileId);
  await writeState(userDataPath, { ...state, activeProfileId: profileId });
  return toPublicProfile(profile);
}

async function deleteProfile(userDataPath, profileId) {
  const state = await readState(userDataPath);
  const profile = findProfile(state, profileId);
  if (state.activeProfileId === profileId) {
    throw new Error('The active profile cannot be deleted. Switch to another profile first.');
  }
  if (state.profiles.length === 1) {
    throw new Error('The last profile cannot be deleted.');
  }
  const dataDirectory = getProfileDataDirectory(userDataPath, profileId);
  const deletedDirectory = path.join(userDataPath, deletedProfilesDirectoryName);
  const trashPath = path.join(
    deletedDirectory,
    `${profileId}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  await fs.mkdir(deletedDirectory, { recursive: true });
  let moved = false;
  try {
    await fs.rename(dataDirectory, trashPath);
    moved = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  const nextState = {
    ...state,
    profiles: state.profiles.filter((item) => item.id !== profileId),
  };
  try {
    await writeState(userDataPath, nextState);
  } catch (error) {
    if (moved) {
      await fs.rename(trashPath, dataDirectory).catch(() => {});
    }
    throw error;
  }
  return toPublicProfile(profile);
}

module.exports = {
  createProfile,
  defaultProfileColor,
  deleteProfile,
  getActiveProfile,
  getProfile,
  getProfileDataDirectory,
  getProfileDataPaths,
  getPublicState,
  initialize,
  migrateLegacyData,
  readState,
  setActiveProfile,
  setProfilePin,
  toPublicProfile,
  updateProfile,
  validatePin,
  verifyPin,
};
