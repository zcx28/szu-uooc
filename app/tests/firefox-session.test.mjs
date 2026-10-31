import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importFirefoxSession } from '../student/checkin-browser.mjs';

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
