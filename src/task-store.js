const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const recurrence = require('./recurrence');
const { isValidDate } = recurrence;

const priorities = new Set(['High', 'Medium', 'Low']);
const taskIdPattern = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const maximumBulkIds = 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateId(id) {
  if (typeof id !== 'string' || !taskIdPattern.test(id)) {
    throw new TypeError('Invalid task identifier.');
  }
}

function validateTaskFields(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('Task data must be an object.');
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 120) {
    throw new TypeError('Task title is required and must be 120 characters or fewer.');
  }

  const description = input.description === undefined ? '' : input.description;
  if (typeof description !== 'string' || description.length > 2000) {
    throw new TypeError('Task description must be 2000 characters or fewer.');
  }

  const priority = input.priority === undefined ? 'Medium' : input.priority;
  if (!priorities.has(priority)) {
    throw new TypeError('Task priority must be High, Medium, or Low.');
  }

  const dueDate = input.dueDate === undefined || input.dueDate === '' ? null : input.dueDate;
  if (dueDate !== null && !isValidDate(dueDate)) {
    throw new TypeError('Task due date must be a valid calendar date.');
  }

  const reminderAt = input.reminderAt === undefined || input.reminderAt === '' ? null : input.reminderAt;
  if (reminderAt !== null
    && (typeof reminderAt !== 'string'
      || Number.isNaN(Date.parse(reminderAt))
      || new Date(reminderAt).toISOString() !== reminderAt)) {
    throw new TypeError('Task reminder must be a valid ISO timestamp.');
  }

  return { title, description, priority, dueDate, reminderAt };
}

function isValidStoredTask(task) {
  return isPlainObject(task)
    && typeof task.id === 'string'
    && taskIdPattern.test(task.id)
    && typeof task.title === 'string'
    && task.title.trim().length > 0
    && task.title.length <= 120
    && typeof task.description === 'string'
    && task.description.length <= 2000
    && priorities.has(task.priority)
    && (task.dueDate === null || isValidDate(task.dueDate))
    && (task.reminderAt === undefined
      || task.reminderAt === null
      || (typeof task.reminderAt === 'string'
        && !Number.isNaN(Date.parse(task.reminderAt))
        && new Date(task.reminderAt).toISOString() === task.reminderAt))
    && typeof task.completed === 'boolean'
    && (task.completedAt === undefined
      || task.completedAt === null
      || (typeof task.completedAt === 'string' && !Number.isNaN(Date.parse(task.completedAt))))
    && typeof task.createdAt === 'string'
    && !Number.isNaN(Date.parse(task.createdAt))
    && typeof task.updatedAt === 'string'
    && !Number.isNaN(Date.parse(task.updatedAt))
    && (!task.recurrence || isValidDate(task.dueDate))
    && recurrence.isValidRecurrence(task);
}

function validateBackupTasks(tasks) {
  if (!recurrence.isValidRecordList(tasks, isValidStoredTask)) {
    throw new TypeError('Backup tasks must be a list of valid, uniquely identified tasks.');
  }
  return tasks;
}

async function preserveCorruptFile(filePath, reason) {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  await fs.rename(filePath, backupPath);
  console.error(`Task data was invalid (${reason}); moved the file to ${backupPath} and started with no tasks.`);
}

async function readTasks(filePath, initialize = true) {
  let contents;
  try {
    if ((await fs.stat(filePath)).size > recurrence.maximumBytes) {
      await preserveCorruptFile(filePath, 'task data exceeds the 100 MB limit');
      await writeTasks(filePath, []);
      return [];
    }
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (initialize) await writeTasks(filePath, []);
      return [];
    }
    throw error;
  }

  let tasks;
  try {
    tasks = JSON.parse(contents);
  } catch (error) {
    await preserveCorruptFile(filePath, error.message);
    await writeTasks(filePath, []);
    return [];
  }

  if (!recurrence.isValidRecordList(tasks, isValidStoredTask)) {
    await preserveCorruptFile(filePath, 'the file did not contain a valid task list');
    await writeTasks(filePath, []);
    return [];
  }

  return tasks;
}

async function writeTasks(filePath, tasks) {
  validateBackupTasks(tasks);
  const contents = `${JSON.stringify(tasks, null, 2)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > recurrence.maximumBytes) {
    throw new TypeError('Task data exceeds the 100 MB limit.');
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
        console.error('Could not remove the temporary task data file.', cleanupError);
      }
    }
    throw error;
  }
}

async function loadTasks(filePath) {
  return readTasks(filePath);
}

function materializeTasks(fields, rule, options) {
  return recurrence.materialize(fields, 'dueDate', rule, options).map((task) => ({
    ...task,
    reminderAt: recurrence.shiftReminder(fields.reminderAt, fields.dueDate, task.dueDate),
  }));
}

async function addTask(filePath, input) {
  const fields = validateTaskFields(input);
  const rule = recurrence.normalizeRule(input.recurrence, fields.dueDate);
  const now = new Date().toISOString();
  const candidates = rule ? materializeTasks(fields, rule) : [{
    id: randomUUID(),
    ...fields,
    completed: false,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }];
  const tasks = await readTasks(filePath, false);
  const nextTasks = [...tasks, ...candidates];
  await writeTasks(filePath, nextTasks);
  return nextTasks;
}

async function updateTask(filePath, id, input, scope = 'occurrence') {
  validateId(id);
  recurrence.validateScope(scope);
  const fields = validateTaskFields(input);
  const tasks = await readTasks(filePath, false);
  const index = tasks.findIndex((task) => task.id === id);
  if (index === -1) {
    throw new Error('Task not found.');
  }

  const selected = tasks[index];
  let nextTasks = tasks.slice();
  if (selected.recurrence && scope === 'series') {
    const rule = recurrence.normalizeRule(input.recurrence, fields.dueDate);
    const plan = recurrence.planSeriesEdit(tasks, selected, fields.dueDate, rule);
    nextTasks = [...plan.preserved, ...materializeTasks(fields, rule, plan)];
  } else if (selected.recurrence) {
    // Occurrence edits never accept replacement metadata or skipped/completed state.
    nextTasks[index] = { ...selected, ...fields, updatedAt: new Date().toISOString() };
  } else {
    const rule = recurrence.normalizeRule(input.recurrence, fields.dueDate);
    if (rule) {
      const candidates = recurrence.retainConvertedRecord(materializeTasks(fields, rule), selected);
      nextTasks.splice(index, 1, ...candidates);
    } else {
      nextTasks[index] = { ...selected, ...fields, updatedAt: new Date().toISOString() };
    }
  }
  await writeTasks(filePath, nextTasks);
  return nextTasks;
}

async function setTaskCompleted(filePath, id, completed) {
  validateId(id);
  if (typeof completed !== 'boolean') {
    throw new TypeError('Completion status must be true or false.');
  }

  const tasks = await readTasks(filePath, false);
  const index = tasks.findIndex((task) => task.id === id);
  if (index === -1) {
    throw new Error('Task not found.');
  }
  if (tasks[index].skipped) {
    throw new TypeError('A skipped occurrence cannot change completion status. Restore it first.');
  }

  const nextTasks = tasks.slice();
  nextTasks[index] = { ...tasks[index], completed, updatedAt: new Date().toISOString() };
  nextTasks[index].completedAt = completed ? nextTasks[index].updatedAt : null;
  await writeTasks(filePath, nextTasks);
  return nextTasks;
}

async function skipTask(filePath, id, skipped = true) {
  validateId(id);
  const tasks = await readTasks(filePath, false);
  const index = tasks.findIndex((task) => task.id === id);
  if (index === -1) throw new Error('Task not found.');
  const nextTasks = tasks.slice();
  nextTasks[index] = recurrence.skipRecord(tasks[index], skipped);
  await writeTasks(filePath, nextTasks);
  return nextTasks;
}

async function endTaskSeries(filePath, id) {
  validateId(id);
  const tasks = await readTasks(filePath, false);
  const selected = tasks.find((task) => task.id === id);
  if (!selected) throw new Error('Task not found.');
  const nextTasks = recurrence.endSeries(tasks, selected);
  await writeTasks(filePath, nextTasks);
  return nextTasks;
}

async function deleteTask(filePath, id) {
  validateId(id);
  const tasks = await readTasks(filePath, false);
  const index = tasks.findIndex((task) => task.id === id);
  if (index === -1) throw new Error('Task not found.');
  const nextTasks = tasks.slice();
  if (tasks[index].recurrence) {
    nextTasks[index] = recurrence.skipRecord(tasks[index], true);
  } else {
    nextTasks.splice(index, 1);
  }
  await writeTasks(filePath, nextTasks);
  return nextTasks;
}

function validateBulkIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > maximumBulkIds) {
    throw new TypeError('Select between 1 and 1000 tasks.');
  }
  const unique = new Set();
  for (const id of ids) {
    validateId(id);
    if (unique.has(id)) {
      throw new TypeError('Bulk selections cannot contain duplicate tasks.');
    }
    unique.add(id);
  }
  return unique;
}

function requireBulkTasks(tasks, idSet) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const id of idSet) {
    if (!byId.has(id)) {
      throw new Error('Task not found.');
    }
  }
  return byId;
}

async function bulkSetTasksCompleted(filePath, ids, completed) {
  const idSet = validateBulkIds(ids);
  if (typeof completed !== 'boolean') {
    throw new TypeError('Completion status must be true or false.');
  }
  const tasks = await readTasks(filePath, false);
  const byId = requireBulkTasks(tasks, idSet);
  for (const id of idSet) {
    if (byId.get(id).skipped) {
      throw new TypeError('A skipped occurrence cannot change completion status. Restore it first.');
    }
  }
  const now = new Date().toISOString();
  const nextTasks = tasks.map((task) => (idSet.has(task.id)
    ? { ...task, completed, updatedAt: now, completedAt: completed ? now : null }
    : task));
  await writeTasks(filePath, nextTasks);
  return nextTasks;
}

async function bulkDeleteTasks(filePath, ids) {
  const idSet = validateBulkIds(ids);
  const tasks = await readTasks(filePath, false);
  requireBulkTasks(tasks, idSet);
  const nextTasks = [];
  for (const task of tasks) {
    if (!idSet.has(task.id)) {
      nextTasks.push(task);
    } else if (task.recurrence) {
      nextTasks.push(recurrence.skipRecord(task, true));
    }
  }
  await writeTasks(filePath, nextTasks);
  return nextTasks;
}

async function bulkRescheduleTasks(filePath, ids, dueDate) {
  const idSet = validateBulkIds(ids);
  const date = dueDate === null || dueDate === '' ? null : dueDate;
  if (date !== null && !isValidDate(date)) {
    throw new TypeError('Task due date must be a valid calendar date.');
  }
  const tasks = await readTasks(filePath, false);
  const byId = requireBulkTasks(tasks, idSet);
  for (const id of idSet) {
    if (byId.get(id).recurrence) {
      throw new TypeError('Recurring occurrences must be rescheduled from their editor.');
    }
  }
  const now = new Date().toISOString();
  const nextTasks = tasks.map((task) => {
    if (!idSet.has(task.id)) return task;
    const reminderAt = task.reminderAt && task.dueDate && date
      ? recurrence.shiftReminder(task.reminderAt, task.dueDate, date)
      : task.reminderAt ?? null;
    return { ...task, dueDate: date, reminderAt, updatedAt: now };
  });
  await writeTasks(filePath, nextTasks);
  return nextTasks;
}

async function replaceTasks(filePath, tasks) {
  await writeTasks(filePath, tasks);
  return tasks;
}

module.exports = {
  addTask,
  bulkDeleteTasks,
  bulkRescheduleTasks,
  bulkSetTasksCompleted,
  deleteTask,
  endTaskSeries,
  loadTasks,
  replaceTasks,
  setTaskCompleted,
  skipTask,
  updateTask,
  validateBackupTasks,
};
