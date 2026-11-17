const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateStamp(date = new Date()) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function calendarDate(value) {
  return String(value).replaceAll('-', '');
}

function nextCalendarDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`;
}

function escapedText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === start) break;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return parts.join('\r\n ');
}

function foldLines(lines) {
  return lines.map(foldLine).join('\r\n');
}

function recurrenceSummary(rule) {
  if (!rule) return '';
  let summary;
  if (rule.frequency === 'daily') {
    summary = rule.interval === 1 ? 'Daily' : `Every ${rule.interval} days`;
  } else if (rule.frequency === 'weekly') {
    const days = (rule.weekdays || []).map((day) => weekdays[day]).join(', ');
    summary = rule.interval === 1 ? 'Weekly' : `Every ${rule.interval} weeks`;
    if (days) summary += ` on ${days}`;
  } else {
    summary = rule.interval === 1 ? 'Monthly' : `Every ${rule.interval} months`;
  }
  if (Number.isInteger(rule.count)) summary += `, ${rule.count} occurrences`;
  else if (rule.until) summary += `, until ${rule.until}`;
  if (rule.ended) summary += ' (series ended)';
  return summary;
}

function eventBlock(lines) {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
}

function activityEvent(activity, stamp) {
  const start = `${calendarDate(activity.date)}T${activity.startTime.replace(':', '')}00`;
  const end = `${calendarDate(activity.date)}T${activity.endTime.replace(':', '')}00`;
  const lines = [
    `UID:activity-${activity.id}@taskforge.local`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapedText(activity.title)}`,
  ];
  if (activity.description) lines.push(`DESCRIPTION:${escapedText(activity.description)}`);
  if (activity.category) lines.push(`CATEGORIES:${escapedText(activity.category)}`);
  lines.push(`STATUS:${activity.completed ? 'COMPLETED' : 'CONFIRMED'}`);
  if (activity.completed) lines.push('X-TASKFORGE-COMPLETED:TRUE');
  if (activity.skipped) lines.push('X-TASKFORGE-SKIPPED:TRUE');
  if (activity.reminderMinutesBefore) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapedText(activity.title)}`,
      `TRIGGER:-PT${activity.reminderMinutesBefore}M`,
      'END:VALARM',
    );
  }
  lines.push('X-TASKFORGE-TYPE:ACTIVITY');
  return eventBlock(lines);
}

function taskEvent(task, stamp) {
  const lines = [
    `UID:task-${task.id}@taskforge.local`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${calendarDate(task.dueDate)}`,
    `DTEND;VALUE=DATE:${nextCalendarDate(task.dueDate)}`,
    `SUMMARY:${escapedText(task.title)}`,
  ];
  if (task.description) lines.push(`DESCRIPTION:${escapedText(task.description)}`);
  lines.push(`STATUS:${task.completed ? 'COMPLETED' : 'CONFIRMED'}`);
  lines.push(`PRIORITY:${task.priority === 'High' ? 1 : task.priority === 'Low' ? 9 : 5}`);
  lines.push('TRANSP:TRANSPARENT');
  if (task.completed) lines.push('X-TASKFORGE-COMPLETED:TRUE');
  lines.push('X-TASKFORGE-TYPE:TASK');
  return eventBlock(lines);
}

function buildCalendar(tasks, activities, options = {}) {
  const now = options.now ?? new Date();
  const stamp = dateStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TaskForge//TaskForge Calendar Export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:TaskForge',
    `X-WR-CALDESC:${escapedText(options.calendarName || 'Tasks and schedule exported from TaskForge')}`,
  ];
  const activitiesSorted = [...activities]
    .filter((activity) => activity && !activity.skipped)
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
  for (const activity of activitiesSorted) {
    lines.push(...activityEvent(activity, stamp));
  }
  const datedTasks = tasks
    .filter((task) => task && task.dueDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  for (const task of datedTasks) {
    lines.push(...taskEvent(task, stamp));
  }
  lines.push('END:VCALENDAR');
  return `${foldLines(lines)}\r\n`;
}

function csvCell(value) {
  let text = String(value ?? '');
  // Spreadsheet programs execute cells that begin with these characters.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvDocument(header, rows) {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function isoOrEmpty(value) {
  return typeof value === 'string' && value ? value : '';
}

function buildTasksCsv(tasks) {
  const header = [
    'Title',
    'Description',
    'Priority',
    'Due date',
    'Completed',
    'Completed at',
    'Created at',
    'Updated at',
    'Recurring',
    'Recurrence',
  ];
  const rows = tasks.map((task) => [
    task.title,
    task.description,
    task.priority,
    task.dueDate ?? '',
    task.completed ? 'Yes' : 'No',
    isoOrEmpty(task.completedAt),
    isoOrEmpty(task.createdAt),
    isoOrEmpty(task.updatedAt),
    task.recurrence ? 'Yes' : 'No',
    recurrenceSummary(task.recurrence),
  ]);
  return csvDocument(header, rows);
}

function buildActivitiesCsv(activities) {
  const header = [
    'Title',
    'Description',
    'Category',
    'Date',
    'Start',
    'End',
    'Completed',
    'Completed at',
    'Skipped',
    'Reminder minutes before',
    'Recurring',
    'Recurrence',
  ];
  const rows = activities.map((activity) => [
    activity.title,
    activity.description,
    activity.category ?? '',
    activity.date,
    activity.startTime,
    activity.endTime,
    activity.completed ? 'Yes' : 'No',
    isoOrEmpty(activity.completedAt),
    activity.skipped ? 'Yes' : 'No',
    activity.reminderMinutesBefore ?? '',
    activity.recurrence ? 'Yes' : 'No',
    recurrenceSummary(activity.recurrence),
  ]);
  return csvDocument(header, rows);
}

module.exports = {
  escapedText,
  foldLine,
  recurrenceSummary,
  buildCalendar,
  buildTasksCsv,
  buildActivitiesCsv,
};
