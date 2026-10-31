import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importFirefoxSession } from '../student/checkin-browser.mjs';
import { decodeFirefoxSession, firefoxProfiles, prepareFirefox } from '../student/firefox-session.mjs';

async function profiles(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-firefox-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const personal = path.join(root, 'personal'), source = path.join(personal, 'default'), dest = path.join(root, 'automation');
  await fs.mkdir(source, { recursive: true });
  const db = new DatabaseSync(path.join(source, 'cookies.sqlite'));
  db.exec('CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT)');
  const insert = db.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const host of ['.uooc.net.cn', 'learn.uooconline.com', '.szu.edu.cn', 'accounts.example.test', 'eviluooc.net.cn', 'uooc.net.cn.evil.test']) {
    insert.run(host, 'session', 'fixture-' + host, '/', 2000000000, 1, 1, 1, '');
  }
  db.close();
  const storage = path.join('storage', 'default', 'https+++www.uooc.net.cn', 'ls', 'data.sqlite');
  await fs.mkdir(path.dirname(path.join(source, storage)), { recursive: true });
  await fs.writeFile(path.join(source, storage), 'older-personal-course-state');
  return { personal, dest, storage };
}

test('first Firefox import returns only course and school cookies without copying a personal database or storage', async t => {
  const { personal, dest } = await profiles(t);
  const cookies = await importFirefoxSession(personal, dest, 'default');
  assert.ok(Array.isArray(cookies));
  assert.deepEqual(cookies.map(cookie => cookie.domain).sort(), ['.szu.edu.cn', '.uooc.net.cn', 'learn.uooconline.com']);
  await assert.rejects(fs.stat(dest), { code: 'ENOENT' });
});

function sessionFile(value) {
  const json = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(12), lengths = [];
  header.write('mozLz40\0', 0, 'binary'); header.writeUInt32LE(json.length, 8);
  if (json.length >= 15) { let remaining = json.length - 15; while (remaining >= 255) { lengths.push(255); remaining -= 255; } lengths.push(remaining); }
  return Buffer.concat([header, Buffer.from([Math.min(json.length, 15) << 4, ...lengths]), json]);
}

test('Firefox imports session-store cookies, preserves SameSite=None, and excludes unrelated/container/expired cookies', async t => {
  const { personal, dest } = await profiles(t), source = path.join(personal, 'default');
  const row = { host: '.uooc.net.cn', name: 'temporary-login', value: 'fixture', path: '/', secure: true, httponly: true, sameSite: 0, originAttributes: {} };
  await fs.mkdir(path.join(source, 'sessionstore-backups'));
  await fs.writeFile(path.join(source, 'sessionstore-backups/recovery.jsonlz4'), sessionFile({ cookies: [row, { ...row, name: 'container', originAttributes: { userContextId: 2 } }, { ...row, host: 'elsewhere.test' }] }));
  const cookies = await importFirefoxSession(personal, dest, 'default');
  assert.equal(cookies.length, 4);
  assert.deepEqual(cookies.find(cookie => cookie.name === row.name), { name: row.name, value: 'fixture', domain: row.host, path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: -1 });
  const db = new DatabaseSync(path.join(source, 'cookies.sqlite'));
  db.exec("UPDATE moz_cookies SET expiry = 1"); db.close();
  assert.equal((await importFirefoxSession(personal, dest, 'default')).length, 1);
  // An empty current session is authoritative: do not revive cookies from an older backup.
  await fs.writeFile(path.join(source, 'sessionstore.jsonlz4'), sessionFile({ cookies: [row] }));
  await fs.writeFile(path.join(source, 'sessionstore-backups/recovery.jsonlz4'), sessionFile({ cookies: [] }));
  assert.deepEqual(await importFirefoxSession(personal, dest, 'default'), []);
});

test('session-only Firefox profiles and absolute custom profile directories can be imported', async t => {
  const { personal, dest } = await profiles(t), custom = path.join(personal, '自定义 [资料]');
  await fs.mkdir(custom);
  await fs.writeFile(path.join(custom, 'sessionstore.jsonlz4'), sessionFile({ cookies: [{ host: '.szu.edu.cn', name: 'login', value: 'fixture', secure: true }] }));
  await fs.writeFile(path.join(personal, 'profiles.ini'), `[Profile0]\nIsRelative=0\nPath=${custom}\nName=学习\n`);
  await fs.writeFile(path.join(personal, 'installs.ini'), `[ABC]\nDefault=${custom}\n`);
  assert.equal((await firefoxProfiles(personal)).lastUsedProfile, custom);
  assert.equal((await importFirefoxSession(personal, dest, custom))[0].name, 'login');
  assert.deepEqual(await importFirefoxSession(personal, dest, '../escape'), []);
});

test('malformed or oversized Firefox session blocks fail without allocating unbounded memory', () => {
  for (const value of [Buffer.from('bad'), Buffer.concat([Buffer.from('mozLz40\0'), Buffer.from([255, 255, 255, 127])]), sessionFile({ cookies: [] }).subarray(0, 15)]) assert.throws(() => decodeFirefoxSession(value));
});

test('first Firefox use installs its engine and later connections reuse it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-firefox-engine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'node_modules/playwright'), { recursive: true });
  await fs.mkdir(path.join(root, 'student'));
  await fs.writeFile(path.join(root, 'student/network-mac.sh'), '#!/bin/bash\n');
  const executable = path.join(root, 'fixture-engine');
  await fs.writeFile(path.join(root, 'node_modules/playwright/cli.js'), "const fs = require('node:fs'); if (process.argv.slice(2).join(' ') !== 'install firefox') process.exit(1); fs.writeFileSync('fixture-engine', 'ready');");
  const firefox = { executablePath: () => executable }, logs = [];
  await prepareFirefox(root, firefox, text => logs.push(text));
  assert.equal(await fs.readFile(executable, 'utf8'), 'ready');
  await prepareFirefox(root, firefox, text => logs.push(text));
  assert.equal(logs.length, 1);
  await fs.unlink(executable);
  await fs.writeFile(path.join(root, 'node_modules/playwright/cli.js'), 'process.exit(7)');
  await assert.rejects(prepareFirefox(root, firefox), /下载未完成/);
});

test('reconnecting Firefox preserves its newer login and pending submission storage', async t => {
  const { personal, dest, storage } = await profiles(t);
  await fs.mkdir(path.dirname(path.join(dest, storage)), { recursive: true });
  const pending = JSON.stringify({ pendingSubmit: { courseId: '123', task_id: '456' } });
  await fs.writeFile(path.join(dest, storage), pending);
  await fs.writeFile(path.join(dest, 'cookies.sqlite'), 'current-automation-login');
  assert.deepEqual(await importFirefoxSession(personal, dest, 'default'), []);
  assert.equal(await fs.readFile(path.join(dest, storage), 'utf8'), pending);
  assert.equal(await fs.readFile(path.join(dest, 'cookies.sqlite'), 'utf8'), 'current-automation-login');
});
