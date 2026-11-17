const assert = require('node:assert/strict');
const test = require('node:test');

const exportService = require('../src/export-service');

function task(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Write report',
    description: '',
    priority: 'Medium',
    dueDate: '2026-11-20',
    reminderAt: null,
    completed: false,
    completedAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

function activity(overrides = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Deep work',
    description: '',
    category: 'Focus',
    date: '2026-11-13',
    startTime: '09:00',
    endTime: '10:30',
    reminderMinutesBefore: null,
    completed: false,
    completedAt: null,
    skipped: false,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

test('calendar export emits RFC 5545 structure with local activity times and all-day task dates', () => {
  const ics = exportService.buildCalendar(
    [task(), task({ title: 'Undated', dueDate: null })],
    [activity(), activity({ id: '22222222-2222-4222-8222-222222222223', title: 'Skipped', skipped: true })],
    { now: new Date('2026-11-12T13:45:06.000Z'), calendarName: 'TaskForge · Work' },
  );
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.match(ics, /PRODID:-\/\/TaskForge\/\/TaskForge Calendar Export\/\/EN/);
  assert.match(ics, /DTSTAMP:20261112T134506Z/);
  assert.match(ics, /DTSTART:20261113T090000\r\nDTEND:20261113T103000/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261121/);
  assert.match(ics, /CATEGORIES:Focus/);
  assert.match(ics, /PRIORITY:5/);
  assert.match(ics, /TRANSP:TRANSPARENT/);
  assert.match(ics, /UID:activity-22222222-2222-4222-8222-222222222222@taskforge.local/);
  assert.doesNotMatch(ics, /SUMMARY:Skipped/);
  assert.doesNotMatch(ics, /SUMMARY:Undated/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal((ics.match(/END:VEVENT/g) || []).length, 2);
});

test('calendar export escapes text, adds alarms, and marks completed items', () => {
  const ics = exportService.buildCalendar(
    [task({
      title: 'Plan, review; ship',
      description: 'Line one\nLine two\\done',
      priority: 'High',
      completed: true,
    })],
    [activity({ reminderMinutesBefore: 15, completed: true, description: 'Focus block' })],
    { now: new Date('2026-11-12T00:00:00.000Z') },
  );
  assert.match(ics, /SUMMARY:Plan\\, review\\; ship/);
  assert.match(ics, /DESCRIPTION:Line one\\nLine two\\\\done/);
  assert.match(ics, /STATUS:COMPLETED/);
  assert.match(ics, /PRIORITY:1/);
  assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Deep work\r\nTRIGGER:-PT15M\r\nEND:VALARM/);
  assert.match(ics, /X-TASKFORGE-TYPE:TASK/);
  assert.match(ics, /X-TASKFORGE-TYPE:ACTIVITY/);
});

test('the default calendar name is included and long names fold safely', () => {
  const ics = exportService.buildCalendar([], [], { now: new Date('2026-11-12T00:00:00.000Z') });
  assert.match(ics, /X-WR-CALDESC:Tasks and schedule exported from TaskForge/);
  const name = 'TaskForge · A very long profile name that should still fold safely over seventy five octets';
  const named = exportService.buildCalendar([], [], {
    now: new Date('2026-11-12T00:00:00.000Z'),
    calendarName: name,
  });
  assert.ok(named.replace(/\r\n /g, '').includes(`X-WR-CALDESC:${name}`));
});

test('ICS lines fold at 75 octets without splitting UTF-8 characters', () => {
  const long = `Summary ${'é'.repeat(80)}`;
  const folded = exportService.foldLine(`SUMMARY:${long}`);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line is ${Buffer.byteLength(line, 'utf8')} octets`);
  }
  assert.ok(lines.slice(1).every((line) => line.startsWith(' ')));
  assert.equal(folded.replace(/\r\n /g, ''), `SUMMARY:${long}`);
  assert.equal(exportService.foldLine('SHORT:value'), 'SHORT:value');
});

test('task CSV is a BOM-prefixed spreadsheet with quoting for commas, quotes, and newlines', () => {
  const csv = exportService.buildTasksCsv([
    task({
      title: 'Plan, review; ship',
      description: 'Line one\nLine two "quoted"',
      priority: 'High',
      completed: true,
      completedAt: '2026-11-21T09:30:00.000Z',
      recurrence: {
        frequency: 'weekly', interval: 2, weekdays: [1, 3], count: null, until: '2027-01-01', seriesId: 'series', startDate: '2026-11-20', occurrenceDate: '2026-11-20',
      },
    }),
  ]);
  assert.ok(csv.startsWith('\uFEFFTitle,Description,Priority,Due date'));
  assert.ok(csv.endsWith('\r\n'));
  assert.match(csv, /"Plan, review; ship","Line one\nLine two ""quoted""",High,2026-11-20,Yes,2026-11-21T09:30:00\.000Z/);
  assert.match(csv, /Yes,"Every 2 weeks on Mon, Wed, until 2027-01-01"/);
  assert.equal(csv.split('\r\n').filter(Boolean).length, 2);
});

test('activity CSV includes schedule fields, skip state, and reminder lead time', () => {
  const csv = exportService.buildActivitiesCsv([
    activity({ reminderMinutesBefore: 30, skipped: true }),
    activity({ id: '22222222-2222-4222-8222-222222222224', title: 'Lunch', category: '', startTime: '12:00', endTime: '13:00' }),
  ]);
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Title,Description,Category,Date,Start,End,Completed,Completed at,Skipped,Reminder minutes before,Recurring,Recurrence$/);
  assert.match(lines[1], /^Deep work,,Focus,2026-11-13,09:00,10:30,No,,Yes,30,No,$/);
  assert.match(lines[2], /^Lunch,,,2026-11-13,12:00,13:00,No,,No,,No,$/);
});

test('CSV cells neutralize spreadsheet formulas', () => {
  const csv = exportService.buildTasksCsv([
    task({ title: '=HYPERLINK("https://example.invalid","click")', description: '+SUM(1,2)' }),
    task({ id: '11111111-1111-4111-8111-111111111112', title: '-not a formula', description: '@mention' }),
  ]);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid"",""click""\)"/);
  assert.match(csv, /"'\+SUM\(1,2\)"/);
  assert.match(csv, /'-not a formula,/);
  assert.match(csv, /'@mention,Medium/);
  assert.doesNotMatch(csv, /^=HYPERLINK/m);
});

test('recurrence summaries describe frequency, weekdays, limits, and ended series', () => {
  assert.equal(exportService.recurrenceSummary(null), '');
  assert.equal(
    exportService.recurrenceSummary({ frequency: 'daily', interval: 1, count: 5, until: null }),
    'Daily, 5 occurrences',
  );
  assert.equal(
    exportService.recurrenceSummary({ frequency: 'monthly', interval: 3, count: null, until: '2027-06-01' }),
    'Every 3 months, until 2027-06-01',
  );
  assert.equal(
    exportService.recurrenceSummary({ frequency: 'weekly', interval: 1, weekdays: [0, 6], count: null, until: '2027-06-01', ended: true }),
    'Weekly on Sun, Sat, until 2027-06-01 (series ended)',
  );
});
