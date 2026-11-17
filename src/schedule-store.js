const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const recurrence = require('./recurrence');
const { isValidDate } = recurrence;

const idPattern = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const reminderLeadTimes = new Set([5, 10, 15, 30, 60, 1440]);
const maximumBulkIds = 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) {
    throw new TypeError('Invalid activity identifier.');
  }
}

function validateActivityFields(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('Activity data must be an object.');
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 120) {
    throw new TypeError('Activity title is required and must be 120 characters or fewer.');
  }

  const description = input.description === undefined ? '' : input.description;
  if (typeof description !== 'string' || description.length > 2000) {
    throw new TypeError('Activity description must be 2000 characters or fewer.');
  }

  const category = input.category === undefined ? '' : input.category;
  if (typeof category !== 'string' || category.trim().length > 60) {
    throw new TypeError('Activity category must be 60 characters or fewer.');
  }

  if (!isValidDate(input.date)) {
    throw new TypeError('Activity date must be a valid calendar date.');
  }
  if (typeof input.startTime !== 'string' || !timePattern.test(input.startTime)) {
    throw new TypeError('Activity start time must be a valid 24-hour time.');
  }
  if (typeof input.endTime !== 'string' || !timePattern.test(input.endTime)) {
    throw new TypeError('Activity end time must be a valid 24-hour time.');
  }
  if (input.endTime <= input.startTime) {
    throw new TypeError('Activity end time must be later than its start time.');
  }
  const reminderMinutesBefore = input.reminderMinutesBefore === undefined
    || input.reminderMinutesBefore === null
    || input.reminderMinutesBefore === ''
    ? null
    : Number(input.reminderMinutesBefore);
  if (reminderMinutesBefore !== null && !reminderLeadTimes.has(reminderMinutesBefore)) {
    throw new TypeError('Activity reminder lead time must be 5, 10, 15, 30, 60, or 1440 minutes.');
  }

  return {
    title,
    description,
    startTime: input.startTime,
    endTime: input.endTime,
    date: input.date,
    category: category.trim(),
    reminderMinutesBefore,
  };
}

function isValidStoredActivity(activity) {
  if (!isPlainObject(activity)
    || typeof activity.id !== 'string'
    || !idPattern.test(activity.id)
    || typeof activity.title !== 'string'
    || !activity.title.trim()
    || activity.title.length > 120
    || typeof activity.description !== 'string'
    || activity.description.length > 2000
    || typeof activity.category !== 'string'
    || activity.category.length > 60
    || !isValidDate(activity.date)
    || typeof activity.startTime !== 'string'
    || !timePattern.test(activity.startTime)
    || typeof activity.endTime !== 'string'
    || !timePattern.test(activity.endTime)
    || activity.endTime <= activity.startTime
    || (activity.reminderMinutesBefore !== undefined
      && activity.reminderMinutesBefore !== null
      && !reminderLeadTimes.has(activity.reminderMinutesBefore))
    || typeof activity.completed !== 'boolean'
    || (activity.completedAt !== undefined
      && activity.completedAt !== null
      && (typeof activity.completedAt !== 'string' || Number.isNaN(Date.parse(activity.completedAt))))
    || typeof activity.createdAt !== 'string'
    || Number.isNaN(Date.parse(activity.createdAt))
    || typeof activity.updatedAt !== 'string'
    || Number.isNaN(Date.parse(activity.updatedAt))) {
    return false;
  }
  return recurrence.isValidRecurrence(activity);
}

function validateBackupActivities(activities) {
  if (!recurrence.isValidRecordList(activities, isValidStoredActivity)) {
    throw new TypeError('Backup schedules must be a list of valid, uniquely identified activities.');
  }
  return activities;
}

async function writeActivities(filePath, activities) {
  validateBackupActivities(activities);
  const contents = `${JSON.stringify(activities, null, 2)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > recurrence.maximumBytes) {
    throw new TypeError('Schedule data exceeds the 100 MB limit.');
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(temporaryPath, contents, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        console.error('Could not remove the temporary schedule data file.', cleanupError);
      }
    }
    throw error;
  }
}

async function preserveCorruptFile(filePath, reason) {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  await fs.rename(filePath, backupPath);
  console.error(`Schedule data was invalid (${reason}); moved the file to ${backupPath} and started with no activities.`);
}

async function readActivities(filePath, initialize = true) {
  let contents;
  try {
    if ((await fs.stat(filePath)).size > recurrence.maximumBytes) {
      await preserveCorruptFile(filePath, 'schedule data exceeds the 100 MB limit');
      await writeActivities(filePath, []);
      return [];
    }
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (initialize) await writeActivities(filePath, []);
      return [];
    }
    throw error;
  }

  let activities;
  try {
    activities = JSON.parse(contents);
  } catch (error) {
    await preserveCorruptFile(filePath, error.message);
    await writeActivities(filePath, []);
    return [];
  }

  if (!recurrence.isValidRecordList(activities, isValidStoredActivity)) {
    await preserveCorruptFile(filePath, 'the file did not contain a valid activity list');
    await writeActivities(filePath, []);
    return [];
  }
  return activities;
}

function findOverlaps(activities, fields, excludedId = null) {
  if (fields.skipped) return [];
  return activities.filter((activity) => (
    activity.id !== excludedId
    && !activity.skipped
    && activity.date === fields.date
    && fields.startTime < activity.endTime
    && fields.endTime > activity.startTime
  ));
}

function findCandidateOverlaps(preserved, candidates) {
  const rows = [...preserved, ...candidates];
  const overlaps = new Map();
  for (const candidate of candidates) {
    for (const conflict of findOverlaps(rows, candidate, candidate.id)) {
      overlaps.set(conflict.id, conflict);
    }
  }
  return [...overlaps.values()];
}

async function loadActivities(filePath) {
  return readActivities(filePath);
}

async function addActivity(filePath, input, allowOverlap = false) {
  const fields = validateActivityFields(input);
  if (typeof allowOverlap !== 'boolean') {
    throw new TypeError('Overlap confirmation must be true or false.');
  }
  const rule = recurrence.normalizeRule(input.recurrence, fields.date);
  const now = new Date().toISOString();
  const candidates = rule ? recurrence.materialize(fields, 'date', rule) : [{
    id: randomUUID(),
    ...fields,
    completed: false,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }];
  const activities = await readActivities(filePath, false);
  const nextActivities = [...activities, ...candidates];
  validateBackupActivities(nextActivities);
  const overlaps = findCandidateOverlaps(activities, candidates);
  if (overlaps.length > 0 && !allowOverlap) {
    return { saved: false, overlaps, activities };
  }
  await writeActivities(filePath, nextActivities);
  return { saved: true, overlaps, activities: nextActivities };
}

async function updateActivity(filePath, id, input, allowOverlap = false, scope = 'occurrence') {
  validateId(id);
  recurrence.validateScope(scope);
  const fields = validateActivityFields(input);
  if (typeof allowOverlap !== 'boolean') {
    throw new TypeError('Overlap confirmation must be true or false.');
  }
  const activities = await readActivities(filePath, false);
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) {
    throw new Error('Activity not found.');
  }

  const selected = activities[index];
  let preserved = activities.filter((activity) => activity.id !== id);
  let candidates;
  let nextActivities = activities.slice();
  if (selected.recurrence && scope === 'series') {
    const rule = recurrence.normalizeRule(input.recurrence, fields.date);
    const plan = recurrence.planSeriesEdit(activities, selected, fields.date, rule);
    preserved = plan.preserved;
    candidates = recurrence.materialize(fields, 'date', rule, plan);
    nextActivities = [...preserved, ...candidates];
  } else {
    // A recurring occurrence ignores any submitted rule and retains its history.
    const rule = selected.recurrence ? null : recurrence.normalizeRule(input.recurrence, fields.date);
    candidates = rule
      ? recurrence.retainConvertedRecord(recurrence.materialize(fields, 'date', rule), selected)
      : [{ ...selected, ...fields, updatedAt: new Date().toISOString() }];
    nextActivities.splice(index, 1, ...candidates);
  }
  validateBackupActivities(nextActivities);
  const overlaps = findCandidateOverlaps(preserved, candidates);
  if (overlaps.length > 0 && !allowOverlap) {
    return { saved: false, overlaps, activities };
  }
  await writeActivities(filePath, nextActivities);
  return { saved: true, overlaps, activities: nextActivities };
}

async function setActivityCompleted(filePath, id, completed) {
  validateId(id);
  if (typeof completed !== 'boolean') {
    throw new TypeError('Completion status must be true or false.');
  }
  const activities = await readActivities(filePath, false);
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) {
    throw new Error('Activity not found.');
  }
  if (activities[index].skipped) {
    throw new TypeError('A skipped occurrence cannot change completion status. Restore it first.');
  }

  const now = new Date().toISOString();
  const nextActivities = activities.slice();
  nextActivities[index] = {
    ...activities[index],
    completed,
    updatedAt: now,
    completedAt: completed ? now : null,
  };
  await writeActivities(filePath, nextActivities);
  return nextActivities;
}

async function skipActivity(filePath, id, skipped = true) {
  validateId(id);
  const activities = await readActivities(filePath, false);
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) throw new Error('Activity not found.');
  const nextActivities = activities.slice();
  nextActivities[index] = recurrence.skipRecord(activities[index], skipped);
  if (!skipped && findOverlaps(activities, nextActivities[index], id).length) {
    throw new Error('Cannot restore this skipped occurrence because it overlaps another activity. Edit its date or time before restoring it.');
  }
  await writeActivities(filePath, nextActivities);
  return nextActivities;
}

async function endActivitySeries(filePath, id) {
  validateId(id);
  const activities = await readActivities(filePath, false);
  const selected = activities.find((activity) => activity.id === id);
  if (!selected) throw new Error('Activity not found.');
  const nextActivities = recurrence.endSeries(activities, selected);
  await writeActivities(filePath, nextActivities);
  return nextActivities;
}

async function deleteActivity(filePath, id) {
  validateId(id);
  const activities = await readActivities(filePath, false);
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) throw new Error('Activity not found.');
  const nextActivities = activities.slice();
  if (activities[index].recurrence) {
    nextActivities[index] = recurrence.skipRecord(activities[index], true);
  } else {
    nextActivities.splice(index, 1);
  }
  await writeActivities(filePath, nextActivities);
  return nextActivities;
}

function validateBulkIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > maximumBulkIds) {
    throw new TypeError('Select between 1 and 1000 activities.');
  }
  const unique = new Set();
  for (const id of ids) {
    validateId(id);
    if (unique.has(id)) {
      throw new TypeError('Bulk selections cannot contain duplicate activities.');
    }
    unique.add(id);
  }
  return unique;
}

function requireBulkActivities(activities, idSet) {
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  for (const id of idSet) {
    if (!byId.has(id)) {
      throw new Error('Activity not found.');
    }
  }
  return byId;
}

async function bulkSetActivitiesCompleted(filePath, ids, completed) {
  const idSet = validateBulkIds(ids);
  if (typeof completed !== 'boolean') {
    throw new TypeError('Completion status must be true or false.');
  }
  const activities = await readActivities(filePath, false);
  const byId = requireBulkActivities(activities, idSet);
  for (const id of idSet) {
    if (byId.get(id).skipped) {
      throw new TypeError('A skipped occurrence cannot change completion status. Restore it first.');
    }
  }
  const now = new Date().toISOString();
  const nextActivities = activities.map((activity) => (idSet.has(activity.id)
    ? { ...activity, completed, updatedAt: now, completedAt: completed ? now : null }
    : activity));
  await writeActivities(filePath, nextActivities);
  return nextActivities;
}

async function bulkDeleteActivities(filePath, ids) {
  const idSet = validateBulkIds(ids);
  const activities = await readActivities(filePath, false);
  requireBulkActivities(activities, idSet);
  const nextActivities = [];
  for (const activity of activities) {
    if (!idSet.has(activity.id)) {
      nextActivities.push(activity);
    } else if (activity.recurrence) {
      nextActivities.push(recurrence.skipRecord(activity, true));
    }
  }
  await writeActivities(filePath, nextActivities);
  return nextActivities;
}

async function replaceActivities(filePath, activities) {
  await writeActivities(filePath, activities);
  return activities;
}

module.exports = {
  addActivity,
  bulkDeleteActivities,
  bulkSetActivitiesCompleted,
  deleteActivity,
  endActivitySeries,
  loadActivities,
  replaceActivities,
  setActivityCompleted,
  skipActivity,
  updateActivity,
  validateBackupActivities,
};
