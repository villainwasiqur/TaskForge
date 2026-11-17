const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const maximumDeliveredNotifications = 2000;
const maximumSnoozes = 500;
const retentionMs = 180 * 24 * 60 * 60 * 1000;
const categories = new Set(['tasks', 'schedule', 'habits', 'goals']);
const targetTypes = new Set(['task', 'activity', 'habit', 'goal']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidIsoTimestamp(value) {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isValidEvent(event) {
  return isPlainObject(event)
    && categories.has(event.category)
    && typeof event.title === 'string'
    && event.title.length > 0
    && event.title.length <= 300
    && typeof event.body === 'string'
    && event.body.length <= 1000
    && Number.isFinite(event.at)
    && targetTypes.has(event.targetType)
    && typeof event.targetId === 'string'
    && event.targetId.length > 0
    && event.targetId.length <= 128
    && (event.targetDate === null
      || (typeof event.targetDate === 'string' && event.targetDate.length <= 10));
}

function isValidEntry(entry) {
  return isPlainObject(entry)
    && typeof entry.id === 'string'
    && entry.id.length > 0
    && entry.id.length <= 512
    && isValidIsoTimestamp(entry.deliveredAt)
    && (entry.readAt === undefined || entry.readAt === null || isValidIsoTimestamp(entry.readAt))
    && (entry.event === undefined || isValidEvent(entry.event));
}

function isValidState(state) {
  return Array.isArray(state)
    && state.length <= maximumDeliveredNotifications
    && state.every(isValidEntry)
    && new Set(state.map((entry) => entry.id)).size === state.length;
}

function isValidSnoozes(snoozes) {
  return isPlainObject(snoozes)
    && Object.keys(snoozes).length <= maximumSnoozes
    && Object.entries(snoozes).every(([id, until]) => (
      id.length > 0 && id.length <= 512 && isValidIsoTimestamp(until)
    ));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        console.error('Could not remove the temporary notification state file.', cleanupError);
      }
    }
    throw error;
  }
}

async function readJson(filePath, fallback) {
  let contents;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    await preserveCorruptState(filePath, error.message);
    return fallback;
  }
}

async function preserveCorruptState(filePath, reason) {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  await fs.rename(filePath, backupPath);
  console.error(`Notification history was invalid (${reason}); moved it to ${backupPath} and started a new history.`);
}

async function loadDelivered(filePath) {
  const state = await readJson(filePath, []);
  if (!isValidState(state)) {
    await preserveCorruptState(filePath, 'the file did not contain valid delivered notification records');
    return [];
  }
  const cutoff = Date.now() - retentionMs;
  return state.filter((entry) => Date.parse(entry.deliveredAt) >= cutoff);
}

async function wasDelivered(filePath, id) {
  const delivered = await loadDelivered(filePath);
  return delivered.some((entry) => entry.id === id);
}

async function markDelivered(filePath, id, deliveredAt = new Date().toISOString()) {
  return (await markDeliveredMany(filePath, [{ id, deliveredAt }])).includes(id);
}

async function markDeliveredMany(filePath, entries) {
  if (!Array.isArray(entries) || entries.some((entry) => !isValidEntry(entry))) {
    throw new TypeError('Notification delivery records are invalid.');
  }
  if (entries.length === 0) {
    return [];
  }
  const delivered = await loadDelivered(filePath);
  const existingIds = new Set(delivered.map((entry) => entry.id));
  const added = [];
  for (const entry of entries) {
    if (!existingIds.has(entry.id)) {
      existingIds.add(entry.id);
      added.push({ readAt: null, ...entry });
    }
  }
  if (added.length > 0) {
    await writeJson(filePath, [...delivered, ...added].slice(-maximumDeliveredNotifications));
  }
  return added.map((entry) => entry.id);
}

async function loadInbox(filePath) {
  return (await loadDelivered(filePath))
    .filter((entry) => entry.event)
    .sort((left, right) => (
      Date.parse(right.deliveredAt) - Date.parse(left.deliveredAt)
      || right.id.localeCompare(left.id)
    ));
}

async function unreadCount(filePath) {
  return (await loadDelivered(filePath))
    .filter((entry) => entry.event && !entry.readAt).length;
}

function validateReadIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > maximumDeliveredNotifications
    || ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 512)
    || new Set(ids).size !== ids.length) {
    throw new TypeError('Notification identifiers are invalid.');
  }
}

async function markRead(filePath, ids) {
  validateReadIds(ids);
  const idSet = new Set(ids);
  const delivered = await loadDelivered(filePath);
  const readAt = new Date().toISOString();
  let changed = false;
  const next = delivered.map((entry) => {
    if (!idSet.has(entry.id) || entry.readAt) {
      return entry;
    }
    changed = true;
    return { ...entry, readAt };
  });
  if (changed) {
    await writeJson(filePath, next);
  }
  return loadInbox(filePath);
}

async function markAllRead(filePath) {
  const delivered = await loadDelivered(filePath);
  const readAt = new Date().toISOString();
  let changed = false;
  const next = delivered.map((entry) => {
    if (entry.readAt) {
      return entry;
    }
    changed = true;
    return { ...entry, readAt };
  });
  if (changed) {
    await writeJson(filePath, next);
  }
  return loadInbox(filePath);
}

async function clearDelivered(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function loadSnoozes(filePath) {
  const snoozes = await readJson(filePath, {});
  if (!isValidSnoozes(snoozes)) {
    await preserveCorruptState(filePath, 'the file did not contain valid snooze records');
    return {};
  }
  return snoozes;
}

async function saveSnooze(filePath, id, until) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 512 || !isValidIsoTimestamp(until)) {
    throw new TypeError('Snooze records are invalid.');
  }
  const snoozes = await loadSnoozes(filePath);
  if (!Object.hasOwn(snoozes, id) && Object.keys(snoozes).length >= maximumSnoozes) {
    throw new Error('Too many snoozed reminders. Unsnooze one first.');
  }
  const next = { ...snoozes, [id]: until };
  await writeJson(filePath, next);
  return next;
}

async function removeSnoozes(filePath, ids) {
  if (!Array.isArray(ids)
    || ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 512)) {
    throw new TypeError('Snooze identifiers are invalid.');
  }
  const snoozes = await loadSnoozes(filePath);
  const next = { ...snoozes };
  let changed = false;
  for (const id of ids) {
    if (Object.hasOwn(next, id)) {
      delete next[id];
      changed = true;
    }
  }
  if (changed) {
    await writeJson(filePath, next);
  }
  return next;
}

async function clearSnoozes(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

module.exports = {
  clearDelivered,
  clearSnoozes,
  loadDelivered,
  loadInbox,
  loadSnoozes,
  markAllRead,
  markDelivered,
  markDeliveredMany,
  markRead,
  removeSnoozes,
  saveSnooze,
  unreadCount,
  wasDelivered,
};