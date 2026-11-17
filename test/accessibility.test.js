const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

function elements(tag) {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))].map((match) => match[0]);
}

function attributes(source) {
  return Object.fromEntries(
    [...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
}

test('document declares language, a skip link, and a focusable main landmark', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<a class="skip-link" href="#main-content">Skip to main content<\/a>/);
  assert.match(html, /<main class="main-content" id="main-content" tabindex="-1">/);
  assert.match(html, /<nav class="navigation" aria-label="Workspace navigation">/);
  assert.match(html, /<nav class="navigation" aria-label="Preferences">/);
});

test('the document has no duplicate element identifiers', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, []);
});

test('every dialog is labelled and every image has alternative text', () => {
  const dialogs = elements('dialog');
  assert.ok(dialogs.length >= 10);
  for (const dialog of dialogs) {
    const attrs = attributes(dialog);
    assert.ok(attrs['aria-labelledby'], `dialog is missing aria-labelledby: ${dialog}`);
    assert.ok(
      new RegExp(`id="${attrs['aria-labelledby']}"`).test(html),
      `aria-labelledby target is missing: ${attrs['aria-labelledby']}`,
    );
  }
  for (const image of elements('img')) {
    assert.match(image, /\balt="/, `image is missing alt text: ${image}`);
  }
});

test('icon-only buttons expose an accessible name', () => {
  const iconButtons = [...html.matchAll(/<button[^>]*class="[^"]*icon-button[^"]*"[^>]*>/g)]
    .map((match) => match[0]);
  assert.ok(iconButtons.length >= 15);
  for (const button of iconButtons) {
    assert.match(button, /\baria-label="[^"]+"/, `icon button is missing a label: ${button}`);
  }
});

test('inputs are associated with labels or accessible names', () => {
  const labelTargets = new Set(
    [...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((match) => match[1]),
  );
  const labels = elements('label');
  for (const label of labels) {
    const forAttribute = attributes(label).for;
    if (forAttribute) labelTargets.add(forAttribute);
  }
  const inputs = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/gi)].map((match) => match[0]);
  const unlabeled = [];
  for (const input of inputs) {
    const attrs = attributes(input);
    if (attrs.type === 'hidden') continue;
    if (attrs['aria-hidden'] === 'true') continue;
    const wrapped = new RegExp(`<label[^>]*>(?:(?!</label>)[\\s\\S])*${input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(html);
    if (!(attrs.id && labelTargets.has(attrs.id)) && !attrs['aria-label'] && !attrs['aria-labelledby'] && !wrapped) {
      unlabeled.push(input);
    }
  }
  assert.deepEqual(unlabeled, []);
});

test('reduced motion, forced colors, and live status regions are supported', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /\.skip-link:focus-visible/);
  assert.match(html, /<div class="toast" id="task-toast" role="status" aria-live="polite"><\/div>/);
  assert.match(renderer, /taskToast\.setAttribute\('role', isError \? 'alert' : 'status'\)/);
  assert.match(renderer, /document\.title = `TaskForge \| \$\{pageTitles\[pageName\]\}`/);
});

test('interactive list controls carry item-specific accessible names', () => {
  assert.match(renderer, /`Mark “\$\{task\.title\}” as completed`/);
  assert.match(renderer, /aria-label', `View task: \$\{task\.title\}`/);
  assert.match(renderer, /`Delete profile \$\{profile\.name\}`/);
  assert.match(renderer, /`Remove milestone: \$\{milestone\.title\}`/);
  assert.match(renderer, /Notifications \(\$\{count\} unread\)/);
});
