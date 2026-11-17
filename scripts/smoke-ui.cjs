#!/usr/bin/env node
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(projectRoot, 'package.json'));
const electronPath = require('electron');
const packagedExecutable = process.env.TASKFORGE_E2E_PACKAGED
  ? path.resolve(process.env.TASKFORGE_E2E_PACKAGED)
  : null;
const realUserDataDirectory = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'TaskForge')
  : null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  close() {
    this.ws?.close();
  }
}

async function findPageTarget(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron is still starting.
    }
    await delay(150);
  }
  throw new Error('Timed out waiting for the TaskForge window.');
}

async function waitFor(client, expression, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { result } = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result?.value) return result.value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function evaluate(client, expression) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  }
  return result?.value;
}

async function key(client, { key, code, windowsVirtualKeyCode, modifiers = 0 }) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key, code, windowsVirtualKeyCode, modifiers,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers,
  });
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskforge-e2e-'));
  const userData = path.join(temporaryRoot, 'user-data');
  const runtimeRoot = path.join(temporaryRoot, 'runtime');
  await fs.mkdir(path.join(runtimeRoot, 'Temp'), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, 'Roaming'), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, 'Local'), { recursive: true });
  const screenshotPath = path.join(temporaryRoot, 'taskforge-e2e.png');
  const port = await freePort();
  const launchEnvironment = { ...process.env };
  launchEnvironment.TASKFORGE_USER_DATA_DIR = userData;
  if (packagedExecutable) {
    launchEnvironment.TASKFORGE_ALLOW_USER_DATA_OVERRIDE = '1';
    launchEnvironment.APPDATA = path.join(runtimeRoot, 'Roaming');
    launchEnvironment.LOCALAPPDATA = path.join(runtimeRoot, 'Local');
    launchEnvironment.TEMP = path.join(runtimeRoot, 'Temp');
    launchEnvironment.TMP = path.join(runtimeRoot, 'Temp');
  }
  const realDataBefore = packagedExecutable && realUserDataDirectory
    ? await fs.stat(realUserDataDirectory).catch(() => null)
    : null;
  const child = spawn(
    packagedExecutable ?? electronPath,
    packagedExecutable ? [`--remote-debugging-port=${port}`] : ['.', `--remote-debugging-port=${port}`],
    {
      cwd: packagedExecutable ? path.dirname(packagedExecutable) : projectRoot,
      env: launchEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let client;
  let passed = 0;
  const consoleErrors = [];
  const screenshotDirectory = process.env.TASKFORGE_E2E_SCREENSHOTS;
  if (screenshotDirectory) await fs.mkdir(screenshotDirectory, { recursive: true });
  console.log(`mode: ${packagedExecutable ? 'packaged executable' : 'development runtime'}`);

  const capture = async (name) => {
    if (!screenshotDirectory) return;
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(screenshotDirectory, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };

  const check = (name, condition) => {
    assert.ok(condition, name);
    passed += 1;
    console.log(`PASS ${name}`);
  };

  try {
    const target = await findPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    client.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception');
    });
    client.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
    });
    await client.send('Runtime.enable');
    await client.send('Page.enable');

    await waitFor(
      client,
      "document.readyState === 'complete' && !document.body.classList.contains('is-booting')",
      'the workspace to finish booting',
      20_000,
    );
    check('workspace boots in the real Electron window', true);
    check(
      'window reports the package version',
      await evaluate(client, 'window.appApi.getVersion()') === packageJson.version,
    );
    if (packagedExecutable) {
      const isolatedProfile = await fs
        .stat(path.join(userData, 'profiles.json'))
        .catch(() => null);
      check('packaged app uses isolated application data', Boolean(isolatedProfile?.size));
    }
    check(
      'skip link and main landmark are present',
      await evaluate(client, "Boolean(document.querySelector('.skip-link[href=\"#main-content\"]') && document.querySelector('main#main-content'))"),
    );
    check(
      'sidebar content and profile switcher fit the window',
      await evaluate(client, `(() => {
        const sidebar = document.querySelector('.sidebar');
        const profile = document.querySelector('#profile-button').getBoundingClientRect();
        return sidebar.scrollHeight <= sidebar.clientHeight + 1
          && profile.top >= 0 && profile.bottom <= window.innerHeight + 1;
      })()`),
    );

    await evaluate(client, `(() => {
      const input = document.querySelector('#quick-task');
      input.value = 'E2E smoke task';
      document.querySelector('#quick-task-form').requestSubmit();
      return true;
    })()`);
    const taskCount = await waitFor(
      client,
      "Number(document.querySelector('#total-task-count').textContent) >= 1 ? document.querySelector('#total-task-count').textContent : 0",
      'the quick-added task to appear',
    );
    check('quick capture adds a task', Number(taskCount) === 1);
    await capture('dashboard');

    for (const page of ['tasks', 'schedule', 'habits', 'goals', 'focus', 'analytics', 'settings']) {
      await evaluate(client, `document.querySelector('.navigation__item[data-page="${page}"]').click()`);
      await waitFor(
        client,
        `window.location.hash === '#${page}' && !document.querySelector('[data-view="${page}"]').hidden`,
        `${page} page`,
      );
      await capture(page);
    }
    check('every workspace page navigates without errors', true);

    check(
      'settings exposes calendar and CSV export actions',
      await evaluate(client, `Boolean(document.querySelector('#export-calendar') && document.querySelector('#export-tasks-csv') && document.querySelector('#export-activities-csv'))`),
    );
    await evaluate(client, "document.querySelector('#export-calendar').scrollIntoView({ block: 'center' })");
    await delay(150);
    check(
      'export actions render visibly in the settings panel',
      await evaluate(client, `(() => {
        const button = document.querySelector('#export-calendar');
        const bounds = button.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && getComputedStyle(button).visibility !== 'hidden';
      })()`),
    );
    await capture('settings-export');
    check(
      'document title tracks the active page',
      (await evaluate(client, 'document.title')) === 'TaskForge | Settings',
    );

    await key(client, { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await waitFor(
      client,
      "window.location.hash === '#search' && document.activeElement?.id === 'global-search-input'",
      'global search to open from the keyboard',
    );
    check('Ctrl+K opens global search with focus in the field', true);
    await key(client, { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(client, "window.location.hash !== '#search'", 'global search to close');

    await evaluate(client, "document.querySelector('#notification-center-button').click()");
    await waitFor(client, "document.querySelector('#notification-center-dialog').open", 'the notification center');
    check('the notification center opens', true);
    await key(client, { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(client, "!document.querySelector('#notification-center-dialog').open", 'the notification center to close');

    await delay(300);
    check('no renderer exceptions were raised', consoleErrors.length === 0);
    if (consoleErrors.length) throw new Error(`Renderer errors:\n${consoleErrors.join('\n')}`);
    if (realDataBefore) {
      const realDataAfter = await fs.stat(realUserDataDirectory).catch(() => null);
      check(
        'packaged app did not modify the real user data directory',
        Boolean(realDataAfter) && realDataAfter.mtimeMs === realDataBefore.mtimeMs,
      );
    }

    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    console.log(`screenshot: ${screenshotPath}`);
    console.log(`E2E PASS: ${passed} checks`);
  } catch (error) {
    console.error(`E2E FAIL: ${error.message}`);
    if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-20).join('\n'));
    process.exitCode = 1;
  } finally {
    client?.close();
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(5000),
    ]);
    if (!process.env.TASKFORGE_E2E_KEEP) {
      await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    } else {
      console.log(`kept: ${temporaryRoot}`);
    }
  }
}

main();
