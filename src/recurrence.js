const { randomUUID } = require('node:crypto');

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const dayMilliseconds = 86_400_000;
const maximumOccurrences = 1000;
const maximumRows = 50_000;
const maximumBytes = 100 * 1024 * 1024;
const ruleKeys = ['frequency', 'interval', 'weekdays', 'count', 'until'];
const metadataKeys = [...ruleKeys, 'seriesId', 'startDate', 'occurrenceDate', 'ended'];

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function utcDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dayNumber(value) {
  return utcDate(value).getTime() / dayMilliseconds;
}

function dateFromDay(day) {
  const date = new Date(day * dayMilliseconds);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) {
    throw new TypeError('Recurrence date exceeds the supported calendar.');
  }
  return date.toISOString().slice(0, 10);
}

function normalizeRule(input, startDate) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Recurrence must be an object or null.');
  }
  if (!isValidDate(startDate)) throw new TypeError('Recurrence requires a valid anchor date.');
  if (!['daily', 'weekly', 'monthly'].includes(input.frequency)) {
    throw new TypeError('Recurrence frequency must be daily, weekly, or monthly.');
  }
  if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 365) {
    throw new TypeError('Recurrence interval must be an integer from 1 to 365.');
  }
  let weekdays = input.weekdays === undefined ? [] : input.weekdays;
  if (!Array.isArray(weekdays) || weekdays.length > 7
    || !weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
    throw new TypeError('Recurrence weekdays must be an array of weekday numbers from 0 to 6.');
  }
  if (input.frequency === 'weekly') {
    weekdays = weekdays.length ? [...new Set(weekdays)].sort((a, b) => a - b) : [utcDate(startDate).getUTCDay()];
  } else if (weekdays.length) {
    throw new TypeError('Recurrence weekdays are only supported for weekly rules.');
  }
  const count = input.count === undefined ? null : input.count;
  const until = input.until === undefined ? null : input.until;
  if ((count === null) === (until === null)) {
    throw new TypeError('Recurrence requires exactly one of count or until.');
  }
  if (count !== null && (!Number.isInteger(count) || count < 1 || count > maximumOccurrences)) {
    throw new TypeError('Recurrence count must be an integer from 1 to 1000.');
  }
  if (until !== null) {
    const start = utcDate(startDate);
    const limit = utcDate(startDate);
    limit.setUTCFullYear(start.getUTCFullYear() + 5);
    // The fifth anniversary of February 29 is February 28, not March 1.
    if (limit.getUTCMonth() !== start.getUTCMonth()) limit.setUTCDate(0);
    if (!isValidDate(until) || until < startDate || utcDate(until) > limit) {
      throw new TypeError('Recurrence until must be from the anchor date through its fifth calendar anniversary.');
    }
  }
  return { frequency: input.frequency, interval: input.interval, weekdays: [...weekdays], count, until };
}

function generateDates(startDate, input, excludedDates = new Set()) {
  const rule = normalizeRule(input, startDate);
  if (!rule) throw new TypeError('A recurring rule is required.');
  const start = utcDate(startDate);
  const anchorDay = dayNumber(startDate);
  const lastDay = rule.until === null ? Infinity : dayNumber(rule.until);
  const dates = [];
  const accept = (day) => {
    if (day < anchorDay || day > lastDay) return;
    const date = dateFromDay(day);
    if (!excludedDates.has(date)) dates.push(date);
    if (dates.length > maximumOccurrences) throw new TypeError('Recurrence exceeds 1000 occurrences.');
  };
  for (let step = 0; rule.count === null || dates.length < rule.count; step += 1) {
    if (rule.frequency === 'monthly') {
      const monthIndex = start.getUTCFullYear() * 12 + start.getUTCMonth() + step * rule.interval;
      const year = Math.floor(monthIndex / 12);
      const month = monthIndex % 12;
      const first = new Date(0);
      first.setUTCFullYear(year, month, 1);
      if (first.getTime() / dayMilliseconds > lastDay) break;
      if (year > 9999) throw new TypeError('Recurrence date exceeds the supported calendar.');
      first.setUTCDate(start.getUTCDate());
      if (first.getUTCMonth() === month) accept(first.getTime() / dayMilliseconds);
    } else if (rule.frequency === 'weekly') {
      const sunday = anchorDay - start.getUTCDay() + step * rule.interval * 7;
      if (sunday > lastDay) break;
      for (const weekday of rule.weekdays) {
        accept(sunday + weekday);
        if (rule.count !== null && dates.length === rule.count) break;
      }
    } else {
      const day = anchorDay + step * rule.interval;
      if (day > lastDay) break;
      accept(day);
    }
  }
  if (!dates.length && excludedDates.size === 0) {
    throw new TypeError('Recurrence must produce at least one occurrence.');
  }
  return dates;
}

function shiftReminder(reminderAt, startDate, occurrenceDate) {
  if (reminderAt === null) return null;
  if (!isValidDate(startDate) || !isValidDate(occurrenceDate)) {
    throw new TypeError('Recurring reminders require valid calendar dates.');
  }
  const reminder = new Date(reminderAt);
  if (typeof reminderAt !== 'string' || Number.isNaN(reminder.getTime())
    || reminder.toISOString() !== reminderAt
    || reminder.getFullYear() < 0 || reminder.getFullYear() > 9999) {
    throw new TypeError('Recurring reminder exceeds the supported calendar.');
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(reminder.getFullYear(), reminder.getMonth(), reminder.getDate());
  calendar.setUTCDate(calendar.getUTCDate() + dayNumber(occurrenceDate) - dayNumber(startDate));
  if (calendar.getUTCFullYear() < 0 || calendar.getUTCFullYear() > 9999) {
    throw new TypeError('Recurring reminder exceeds the supported calendar.');
  }
  // Calendar setters keep the original local clock, including JS normalization of DST gaps.
  reminder.setFullYear(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate());
  if (Number.isNaN(reminder.getTime()) || reminder.getFullYear() < 0 || reminder.getFullYear() > 9999
    || reminder.getUTCFullYear() < 0 || reminder.getUTCFullYear() > 9999) {
    throw new TypeError('Recurring reminder exceeds the supported calendar.');
  }
  return reminder.toISOString();
}

function matchesCalendar(metadata) {
  const start = utcDate(metadata.startDate);
  const occurrence = utcDate(metadata.occurrenceDate);
  const days = dayNumber(metadata.occurrenceDate) - dayNumber(metadata.startDate);
  if (days < 0 || (metadata.until !== null && metadata.occurrenceDate > metadata.until)) return false;
  if (metadata.frequency === 'daily') return days % metadata.interval === 0;
  if (metadata.frequency === 'weekly') {
    return metadata.weekdays.includes(occurrence.getUTCDay())
      && Math.floor((days + start.getUTCDay()) / 7) % metadata.interval === 0;
  }
  const months = (occurrence.getUTCFullYear() - start.getUTCFullYear()) * 12
    + occurrence.getUTCMonth() - start.getUTCMonth();
  return occurrence.getUTCDate() === start.getUTCDate() && months % metadata.interval === 0;
}

function isValidRecurrence(record) {
  if (record.recurrence === undefined || record.recurrence === null) {
    return record.skipped === undefined || record.skipped === false;
  }
  const metadata = record.recurrence;
  if (typeof metadata !== 'object' || Array.isArray(metadata)
    || Object.keys(metadata).some((key) => !metadataKeys.includes(key))
    || typeof metadata.seriesId !== 'string' || !uuidPattern.test(metadata.seriesId)
    || !isValidDate(metadata.startDate) || !isValidDate(metadata.occurrenceDate)
    || (metadata.ended !== undefined && typeof metadata.ended !== 'boolean')
    || typeof record.skipped !== 'boolean' || (record.completed && record.skipped)) return false;
  try {
    const normalized = normalizeRule(metadata, metadata.startDate);
    if (!ruleKeys.every((key) => JSON.stringify(metadata[key]) === JSON.stringify(normalized[key]))) return false;
    // Segment counts exclude calendar slots already occupied by preserved history.
    return matchesCalendar(metadata);
  } catch {
    return false;
  }
}

function isValidRecordList(records, validateRecord) {
  if (!Array.isArray(records) || records.length > maximumRows) return false;
  const ids = new Set();
  const occurrenceKeys = new Set();
  const series = new Map();
  for (const record of records) {
    if (!validateRecord(record)) return false;
    const id = record.id.toLowerCase();
    if (ids.has(id)) return false;
    ids.add(id);
    if (!record.recurrence) continue;
    const seriesId = record.recurrence.seriesId.toLowerCase();
    const key = `${seriesId}/${record.recurrence.occurrenceDate}`;
    if (occurrenceKeys.has(key)) return false;
    occurrenceKeys.add(key);
    const state = series.get(seriesId) || { count: 0, ended: record.recurrence.ended === true };
    state.count += 1;
    if (state.count > maximumOccurrences || state.ended !== (record.recurrence.ended === true)) return false;
    series.set(seriesId, state);
  }
  try {
    return Buffer.byteLength(JSON.stringify(records), 'utf8') <= maximumBytes;
  } catch {
    return false;
  }
}

function validateScope(scope) {
  if (scope !== 'occurrence' && scope !== 'series') {
    throw new TypeError('Edit scope must be occurrence or series.');
  }
}

function sameSeries(record, selected) {
  return Boolean(record.recurrence && selected.recurrence
    && record.recurrence.seriesId.toLowerCase() === selected.recurrence.seriesId.toLowerCase());
}

function planSeriesEdit(records, selected, startDate, rule) {
  if (!selected.recurrence) throw new TypeError('Only recurring occurrences have a series to edit.');
  if (selected.completed || selected.skipped) {
    throw new TypeError('A series edit must start from a pending occurrence.');
  }
  if (!isValidDate(startDate) || startDate < selected.recurrence.occurrenceDate) {
    throw new TypeError('A series edit cannot start before the selected original occurrence date.');
  }
  if (!rule) throw new TypeError('A series edit must remain recurring.');
  if (records.some((record) => sameSeries(record, selected) && record.recurrence.ended)) {
    throw new TypeError('An ended series cannot be regenerated.');
  }
  const replaced = records.filter((record) => sameSeries(record, selected)
    && record.recurrence.occurrenceDate >= selected.recurrence.occurrenceDate
    && !record.completed && !record.skipped);
  const replacedIds = new Set(replaced.map((record) => record.id));
  const preserved = records.filter((record) => !replacedIds.has(record.id));
  const history = preserved.filter((record) => sameSeries(record, selected));
  const dates = generateDates(startDate, rule, new Set(history.map((record) => record.recurrence.occurrenceDate)));
  if (history.length + dates.length > maximumOccurrences) throw new TypeError('A series cannot exceed 1000 occurrences including history.');
  return { preserved, dates, reuse: replaced, seriesId: selected.recurrence.seriesId };
}

function materialize(fields, dateField, rule, options = {}) {
  const startDate = fields[dateField];
  const { dates = generateDates(startDate, rule), seriesId = randomUUID(), reuse = [] } = options;
  const originals = new Map(reuse.map((record) => [record.recurrence.occurrenceDate, record]));
  const now = new Date().toISOString();
  return dates.map((date) => {
    const original = originals.get(date);
    return {
      ...fields,
      id: original ? original.id : randomUUID(),
      [dateField]: date,
      completed: false,
      completedAt: null,
      skipped: false,
      createdAt: original ? original.createdAt : now,
      updatedAt: now,
      recurrence: { ...rule, weekdays: [...rule.weekdays], seriesId, startDate, occurrenceDate: date },
    };
  });
}

function retainConvertedRecord(candidates, original) {
  candidates[0] = {
    ...original,
    ...candidates[0],
    id: original.id,
    completed: original.completed,
    completedAt: original.completedAt === undefined ? null : original.completedAt,
    createdAt: original.createdAt,
  };
  return candidates;
}

function skipRecord(record, skipped) {
  if (!record.recurrence) throw new TypeError('Only recurring occurrences can be skipped.');
  if (typeof skipped !== 'boolean') throw new TypeError('Skipped status must be true or false.');
  if (skipped && record.completed) throw new TypeError('A completed occurrence cannot be skipped.');
  return { ...record, skipped, updatedAt: new Date().toISOString() };
}

function endSeries(records, selected) {
  if (!selected.recurrence) throw new TypeError('Only recurring occurrences have a series to end.');
  return records.filter((record) => !sameSeries(record, selected)
    || record.recurrence.occurrenceDate <= selected.recurrence.occurrenceDate
    || record.completed || record.skipped)
    .map((record) => sameSeries(record, selected)
      ? { ...record, recurrence: { ...record.recurrence, ended: true } }
      : record);
}

module.exports = {
  maximumBytes,
  isValidDate,
  normalizeRule,
  generateDates,
  shiftReminder,
  isValidRecurrence,
  isValidRecordList,
  validateScope,
  planSeriesEdit,
  materialize,
  retainConvertedRecord,
  skipRecord,
  endSeries,
};
