const defaultMaximumEntries = 20;
const defaultMaximumBytes = 25 * 1024 * 1024;
const kinds = new Set(['tasks', 'schedules']);

function createHistory(options = {}) {
  const maximumEntries = options.maximumEntries ?? defaultMaximumEntries;
  const maximumBytes = options.maximumBytes ?? defaultMaximumBytes;
  if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
    throw new TypeError('Undo history entry limit must be a positive integer.');
  }
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError('Undo history byte limit must be a positive integer.');
  }

  let undoEntries = [];
  let redoEntries = [];

  function totalBytes() {
    return [...undoEntries, ...redoEntries].reduce((sum, item) => sum + item.size, 0);
  }

  function record(entry) {
    if (!entry || !kinds.has(entry.kind)
      || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 120
      || !Array.isArray(entry.before) || !Array.isArray(entry.after)) {
      throw new TypeError('Undo entries need a kind, label, and before/after row lists.');
    }
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    redoEntries = [];
    if (size > maximumBytes) {
      return;
    }
    undoEntries.push({ entry, size });
    while (undoEntries.length > maximumEntries || totalBytes() > maximumBytes) {
      undoEntries.shift();
    }
  }

  function state() {
    return {
      canUndo: undoEntries.length > 0,
      canRedo: redoEntries.length > 0,
      undoLabel: undoEntries.at(-1)?.entry.label ?? null,
      redoLabel: redoEntries.at(-1)?.entry.label ?? null,
    };
  }

  function peekUndo() {
    return undoEntries.at(-1)?.entry ?? null;
  }

  function peekRedo() {
    return redoEntries.at(-1)?.entry ?? null;
  }

  function commitUndo() {
    const item = undoEntries.pop();
    if (!item) return null;
    redoEntries.push(item);
    return item.entry;
  }

  function commitRedo() {
    const item = redoEntries.pop();
    if (!item) return null;
    undoEntries.push(item);
    return item.entry;
  }

  function clear() {
    undoEntries = [];
    redoEntries = [];
  }

  return { record, state, peekUndo, peekRedo, commitUndo, commitRedo, clear };
}

module.exports = { createHistory, defaultMaximumEntries, defaultMaximumBytes };