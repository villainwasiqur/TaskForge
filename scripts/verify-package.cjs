#!/usr/bin/env node
const asar = require('@electron/asar');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const ignored = new Set(['package.json']);

function fail(message) {
  console.error(`verify-package: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--asar' || arg === '--dir') {
      options[arg.slice(2)] = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function findAsar(directory) {
  const found = [];
  const queue = [directory];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EBUSY' || error.code === 'EPERM') continue;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name === 'app.asar') found.push(full);
    }
  }
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function repoFiles() {
  const files = ['main.js', 'preload.js'];
  for (const directory of ['src', 'assets']) {
    const walk = (current) => {
      for (const entry of fs.readdirSync(path.join(projectRoot, current), { withFileTypes: true })) {
        const relative = path.posix.join(current, entry.name);
        if (entry.isDirectory()) walk(relative);
        else files.push(relative);
      }
    };
    walk(directory);
  }
  return files;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/verify-package.cjs [--asar path/to/app.asar] [--dir dist-directory]');
    return;
  }
  let archive = options.asar;
  if (!archive) {
    const searchRoot = options.dir ?? path.join(projectRoot, 'dist');
    const candidates = findAsar(searchRoot);
    if (candidates.length === 0) {
      fail(`no app.asar found under ${searchRoot}`);
      return;
    }
    [archive] = candidates;
  }
  if (!fs.existsSync(archive)) {
    fail(`archive does not exist: ${archive}`);
    return;
  }

  const rawEntries = asar.listPackage(archive)
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\//, ''))
    .filter((entry) => entry && !ignored.has(entry));
  const entries = rawEntries.filter((relative) => {
    const repoPath = path.join(projectRoot, relative);
    return !(fs.existsSync(repoPath) && fs.statSync(repoPath).isDirectory());
  });
  const packedPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  const expectedPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  if (packedPackage.version !== expectedPackage.version) {
    fail(`packaged version ${packedPackage.version} does not match package.json ${expectedPackage.version}`);
  }
  if (packedPackage.main !== expectedPackage.main) {
    fail(`packaged main entry ${packedPackage.main} does not match ${expectedPackage.main}`);
  }

  const expected = repoFiles();
  const packed = new Set(entries);
  const mismatches = [];
  for (const relative of expected) {
    const packedEntry = packed.has(relative);
    if (!packedEntry) {
      mismatches.push(`missing from archive: ${relative}`);
      continue;
    }
    const packedBytes = asar.extractFile(archive, relative);
    const repoBytes = fs.readFileSync(path.join(projectRoot, relative));
    if (!packedBytes.equals(repoBytes)) {
      mismatches.push(`content differs: ${relative} (${packedBytes.length} vs ${repoBytes.length} bytes)`);
    }
  }
  for (const relative of entries) {
    if (/^node_modules\//.test(relative)) mismatches.push(`unexpected dependency in archive: ${relative}`);
    else if (!expected.includes(relative) && !relative.endsWith('/')) mismatches.push(`unexpected file in archive: ${relative}`);
  }

  console.log(`archive: ${archive}`);
  console.log(`version: ${packedPackage.version}`);
  console.log(`files checked: ${expected.length}`);
  if (mismatches.length) {
    for (const mismatch of mismatches) fail(mismatch);
    return;
  }
  console.log('archive contents match the working tree');

  const outputDirectory = path.dirname(path.dirname(path.dirname(archive)));
  const installers = fs.readdirSync(outputDirectory)
    .filter((name) => /^TaskForge Setup .*\.exe$/.test(name));
  for (const installer of installers) {
    const installerPath = path.join(outputDirectory, installer);
    console.log(`installer: ${installer}`);
    console.log(`sha256: ${sha256(installerPath)}`);
    console.log(`bytes: ${fs.statSync(installerPath).size}`);
  }
}

main();
