const assert = require('node:assert/strict');
const test = require('node:test');

const undoService = require('../src/undo-service');

function entry(label, kind = 'tasks') {
  return { kind, label, before: [], after: [{ id: label }] };
}

test('history records, peeks, and commits undo and redo in order', () => {
  const history = undoService.createHistory();
  assert.deepEqual(history.state(), { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  assert.equal(history.peekUndo(), null);
  assert.equal(history.commitUndo(), null);
  assert.equal(history.commitRedo(), null);

  history.record(entry('first'));
  history.record(entry('second', 'schedules'));
  assert.deepEqual(history.state(), { canUndo: true, canRedo: false, undoLabel: 'second', redoLabel: null });
  assert.equal(history.peekUndo().label, 'second');

  assert.equal(history.commitUndo().label, 'second');
  assert.deepEqual(history.state(), { canUndo: true, canRedo: true, undoLabel: 'first', redoLabel: 'second' });
  assert.equal(history.commitUndo().label, 'first');
  assert.equal(history.commitRedo().label, 'first');
  assert.equal(history.commitRedo().label, 'second');
  assert.deepEqual(history.state(), { canUndo: true, canRedo: false, undoLabel: 'second', redoLabel: null });
  assert.equal(history.commitUndo().label, 'second');
  history.clear();
  assert.deepEqual(history.state(), { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
});

test('a new record truncates the redo tail', () => {
  const history = undoService.createHistory();
  history.record(entry('first'));
  history.record(entry('second'));
  history.commitUndo();
  assert.equal(history.state().canRedo, true);
  history.record(entry('third'));
  assert.deepEqual(history.state(), { canUndo: true, canRedo: false, undoLabel: 'third', redoLabel: null });
  assert.equal(history.commitRedo(), null);
});

test('entry and byte limits drop the oldest undo entries', () => {
  const history = undoService.createHistory({ maximumEntries: 2 });
  history.record(entry('first'));
  history.record(entry('second'));
  history.record(entry('third'));
  assert.equal(history.commitUndo().label, 'third');
  assert.equal(history.commitUndo().label, 'second');
  assert.equal(history.commitUndo(), null);

  const tiny = undoService.createHistory({ maximumBytes: 1 });
  tiny.record(entry('too large'));
  assert.equal(tiny.state().canUndo, false);

  const measured = undoService.createHistory({ maximumBytes: 200 });
  measured.record(entry('a'.repeat(60)));
  measured.record(entry('b'.repeat(60)));
  assert.equal(measured.state().canUndo, true);
  assert.equal(measured.commitUndo().label, 'b'.repeat(60));
  assert.equal(measured.commitUndo(), null);
});

test('history validates configuration and entries', () => {
  assert.throws(() => undoService.createHistory({ maximumEntries: 0 }), TypeError);
  assert.throws(() => undoService.createHistory({ maximumBytes: -5 }), TypeError);
  const history = undoService.createHistory();
  for (const bad of [
    null,
    { kind: 'habits', label: 'x', before: [], after: [] },
    { kind: 'tasks', label: '', before: [], after: [] },
    { kind: 'tasks', label: 'x'.repeat(121), before: [], after: [] },
    { kind: 'tasks', label: 'x', before: null, after: [] },
    { kind: 'tasks', label: 'x', before: [], after: {} },
  ]) {
    assert.throws(() => history.record(bad), TypeError);
  }
  assert.equal(history.state().canUndo, false);
});