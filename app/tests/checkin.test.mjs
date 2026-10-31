import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCheckin, beijingClock } from '../student/checkin.mjs';
import { checkinURL, browserCommand, openCheckinPages, activateChromeProcess } from '../student/checkin-browser.mjs';
import { autostartDefinition, setAutostart } from '../student/autostart.mjs';
import { createConsole } from '../student/console-server.mjs';
import { appDir, courseURL, session } from './console-fixtures.mjs';

const browser = { available: true, executable: '/test/Chrome', userDataDir: '/test/Chrome User Data', profiles: [{ directory: 'Profile 2', name: '我的学习账号' }] };
const settings = { enabled: true, mode: 'startup', time: '22:00', autostart: false, scriptReady: true, profileDirectory: 'Profile 2' };

test('Mac course focus uses the owned Chrome PID, rejects unsafe identifiers and reports activation failure', async () => {
  const calls = [], execFileImpl = (file, args, options, callback) => { calls.push({ file, args, options }); callback(null); };
  await activateChromeProcess(12345, { platform: 'darwin', execFileImpl });
  assert.equal(calls[0].file, '/usr/bin/osascript'); assert.equal(calls[0].args.at(-1), '12345');
  assert.match(calls[0].args[3], /runningApplicationWithProcessIdentifier/); assert.match(calls[0].args[3], /NSApplicationActivateAllWindows/);
  assert.equal(calls[0].options.timeout, 5000);
  await assert.rejects(activateChromeProcess('123;exit', { platform: 'darwin', execFileImpl }), /进程无效/);
  await assert.rejects(activateChromeProcess(0, { platform: 'darwin', execFileImpl }), /进程无效/);
  assert.equal(calls.length, 1);
  await assert.rejects(activateChromeProcess(12345, { platform: 'darwin', execFileImpl: (_file, _args, _options, callback) => callback(new Error('activation rejected')) }), /窗口未能激活/);
  await activateChromeProcess(12345, { platform: 'win32', execFileImpl }); assert.equal(calls.length, 1);
});

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-checkin-'));
  let time = new Date('2026-10-13T00:00:00Z'), online = true;
  const courses = ['123', '456', '789'].map(id => ({ id, name: `课程 ${id}`, url: courseURL(id), checkinEnabled: true }));
  const opened = [], notices = [], startup = [];
  const options = { appDir, dataDir, getCourses: () => courses, now: () => time, autoTick: false,
    discoverBrowser: async () => browser, autostart: async enabled => startup.push(enabled), isOnline: async () => online,
    openPages: async urls => { opened.push(urls); return urls.map(url => ({ url, ok: true })); }, notify: message => notices.push(message), ...overrides };
  let service = await createCheckin(options);
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, options, courses, opened, notices, startup, get service() { return service; }, time: value => time = new Date(value), online: value => online = value,
    restart: async () => { await service.close(); service = await createCheckin(options); return service; } };
}

test('startup opens the entire selected list once, survives restarts and only supplements new targets', async t => {
  const f = await fixture(t);
  await f.service.configure(settings); await Promise.all([f.service.start(), f.service.tick(), f.service.tick()]);
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0].length, 3);
  assert(f.opened[0].every(url => new URL(url).searchParams.get('szu_checkin') === '1'));
  assert.equal(f.service.state().counts.opened, 3); assert.equal(f.notices.length, 1);
  await (await f.restart()).start(); assert.equal(f.opened.length, 1);
  f.courses[0].name = '课程改名'; await f.service.tick(); assert.equal(f.opened.length, 1);
  f.courses.push({ id: '999', name: '新课程', url: courseURL('999'), checkinEnabled: true });
  await f.service.tick(); assert.equal(f.opened.length, 2); assert.equal(f.opened[1].length, 1); assert.match(f.opened[1][0], /999/);
  f.courses[0].checkinURL = 'https://www.uooc.net.cn/home/course/123';
  await f.service.tick(); assert.equal(f.opened.length, 3); assert.match(f.opened[2][0], /home\/course\/123/);
  f.courses[1].checkinEnabled = false;
  f.time('2026-10-13T16:00:01Z'); await f.service.tick();
  assert.equal(f.opened.length, 4); assert.equal(f.opened[3].length, 3); assert.equal(f.service.state().date, '2026-10-14');
  await f.service.tick(); assert.equal(f.opened.length, 4);
});

test('same-account browser changes keep daily checkin results and require a newly tested profile', async t => {
  let kind = 'chrome';
  const f = await fixture(t, { getBrowserKind: () => kind, discoverBrowser: async () => ({ ...browser, kind, userDataDir: `/test/${kind}` }) });
  await f.service.configure(settings); await f.service.tick();
  assert.equal(f.opened.length, 1);
  await f.service.changeBrowser(); kind = 'edge';
  assert.equal(f.service.state().settings.enabled, false);
  await assert.rejects(f.service.configure({ ...settings, accountConfirmed: true }), /测试打开/);
  await f.service.testBrowser('Profile 2');
  await assert.rejects(f.service.configure(settings), /确认.*账号/);
  await f.service.configure({ ...settings, accountConfirmed: true });
  await f.service.tick();
  assert.equal(f.opened.length, 2, 'only the account-test homepage is opened after switching');
  assert.deepEqual(f.opened[1], ['https://www.uooc.net.cn/']);
  assert.equal(f.service.state().counts.opened, 3);
  await (await f.restart()).tick(); assert.equal(f.opened.length, 2);
});

test('legacy profile-based history preserves opened, uncertain and failed results when switching browsers', async t => {
  let kind = 'chrome';
  const f = await fixture(t, { getBrowserKind: () => kind, discoverBrowser: async () => ({ ...browser, kind, userDataDir: `/test/${kind}` }) });
  await f.service.close();
  await fs.writeFile(path.join(f.dataDir, 'checkin.json'), JSON.stringify({ ...settings, browser: { executable: '/legacy/Chrome', userDataDir: '/legacy/Chrome', profileDirectory: 'Default' } }));
  await fs.writeFile(path.join(f.dataDir, 'checkin-history.json'), JSON.stringify({ history: { '2026-10-13': {
    a4b303d143eb0ddabee2a08d00cb6630b8d990d5e51e8eb8ffd9e3f33c93612f: { status: 'opened' },
    fb736ac03c3e1f0ff2e02426f0a75756621f5453430c91af39459611e3629e36: { status: 'opening' },
    f30dc906dccd048872566b91571ef6237fe0e82d6e9e51639716ce0ed2e5b067: { status: 'failed', nextAttemptAt: Date.parse('2026-10-13T00:05:00Z') },
  } } }));
  await f.restart(); await f.service.tick();
  assert.deepEqual(f.courses.map(course => f.service.courseState(course).status), ['opened', 'uncertain', 'failed']);
  assert.equal(f.opened.length, 0);
  await f.service.changeBrowser(); kind = 'edge'; await f.service.testBrowser('Profile 2');
  await f.service.configure({ ...settings, accountConfirmed: true }); await f.service.tick();
  assert.deepEqual(f.courses.map(course => f.service.courseState(course).status), ['opened', 'uncertain', 'failed']);
  f.time('2026-10-13T00:06:00Z'); await f.service.tick();
  assert.equal(f.opened.length, 2); assert.equal(f.opened[1].length, 1); assert.match(f.opened[1][0], /789/);
  await f.restart(); assert.equal(f.service.state().counts.uncertain, 1);
});

test('Firefox checkin profile verification uses Firefox flags and the selected profile', async t => {
  const directory = 'Profiles/学习 [2].default-release', commands = [];
  const f = await fixture(t, { getBrowserKind: () => 'firefox',
    discoverBrowser: async () => ({ kind: 'firefox', available: true, executable: '/fixture/firefox', userDataDir: '/fixture/profiles', profiles: [{ directory }] }),
    openPages: async (urls, selected) => { commands.push(browserCommand(urls, selected)); return urls.map(url => ({ url, ok: true })); } });
  await f.service.changeBrowser();
  await f.service.testBrowser(directory);
  await f.service.configure({ ...settings, profileDirectory: directory, accountConfirmed: true });
  await f.service.tick();
  assert.equal(commands.length, 2);
  for (const command of commands) assert.deepEqual(command.args.slice(0, 3), ['-profile', path.join('/fixture/profiles', directory), '--new-window']);
});

test('offline and partial command failures retry after five minutes without reopening accepted pages', async t => {
  let attempt = 0;
  const batches = [];
  const f = await fixture(t, { openPages: async urls => { attempt++; batches.push(urls); return urls.map((url, i) => ({ url, ok: attempt > 1 || i !== 1, error: '模拟打开失败' })); } });
  await f.service.configure(settings); f.online(false); await f.service.start();
  assert.equal(attempt, 0); assert.equal(f.service.state().counts.failed, 3);
  f.online(true); f.time('2026-10-13T00:04:59Z'); await f.service.tick(); assert.equal(attempt, 0);
  f.time('2026-10-13T00:05:00Z'); await f.service.tick(); assert.equal(attempt, 1); assert.equal(f.service.state().counts.opened, 2);
  f.time('2026-10-13T00:10:00Z'); await f.service.tick(); assert.equal(attempt, 2); assert.equal(f.service.state().counts.opened, 3);
  assert.equal(batches[1].length, 1); assert.match(batches[1][0], /456/);
  await f.service.tick(); assert.equal(attempt, 2);
});

test('scheduled mode waits for Beijing time, catches up after sleep, and does not reset a completed day', async t => {
  const f = await fixture(t);
  await f.service.configure({ ...settings, mode: 'scheduled', time: '22:00' }); await f.service.start(); assert.equal(f.opened.length, 0);
  f.time('2026-10-13T13:59:59Z'); await f.service.tick(); assert.equal(f.opened.length, 0);
  f.time('2026-10-13T14:00:00Z'); await f.service.tick(); assert.equal(f.opened.length, 1);
  await f.service.configure({ ...settings, mode: 'scheduled', time: '21:00' }); await f.service.tick(); assert.equal(f.opened.length, 1);
  await f.service.configure(settings); await f.service.tick(); assert.equal(f.opened.length, 1);
  await f.service.configure({ ...settings, mode: 'scheduled' });
  f.time('2026-10-16T15:00:00Z'); await f.service.tick(); assert.equal(f.opened.length, 2); assert.equal(f.service.state().date, '2026-10-16');
  assert.deepEqual(beijingClock(new Date('2026-10-13T16:00:00Z')), { date: '2026-10-14', time: '00:00' });
});

test('manual reopen is explicit; interrupted or corrupt records never silently repeat a day', async t => {
  const f = await fixture(t);
  await f.service.configure(settings); await f.service.start(); await f.service.manual(['456']);
  assert.equal(f.opened.length, 2); assert.equal(f.opened[1].length, 1); await f.service.tick(); assert.equal(f.opened.length, 2);
  const file = path.join(f.dataDir, 'checkin-history.json'); const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const entries = Object.values(saved.history['2026-10-13']); entries[0].status = 'opening'; await fs.writeFile(file, JSON.stringify(saved));
  await (await f.restart()).start(); assert.equal(f.opened.length, 2); assert.equal(f.service.state().counts.uncertain, 1);
  await fs.writeFile(file, '{invalid'); await (await f.restart()).start(); assert.equal(f.opened.length, 2); assert.match(f.service.state().error, /不可读/);
});

test('setup requires script acknowledgement and a known Chrome profile, with no provider credentials', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.configure({ ...settings, scriptReady: false }), /脚本/);
  await assert.rejects(f.service.configure({ ...settings, profileDirectory: '../Default' }), /资料/);
  await assert.rejects(f.service.configure({ ...settings, time: '25:00' }), /时间/);
  await f.service.configure(settings); await f.service.start();
  assert(!await fs.stat(path.join(f.dataDir, 'api.json')).catch(() => null));
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.dataDir, 'checkin.json'))).mode & 0o777, 0o600);
});

test('Chrome opens one batch with the chosen profile and literal URL arguments; errors affect only that batch', async () => {
  const urls = ['123', '456', '789'].map(id => checkinURL(courseURL(id), true));
  const calls = [];
  assert.deepEqual(browserCommand(urls, { ...browser, profileDirectory: 'Profile 2' }).args.slice(0, 2), ['--user-data-dir=/test/Chrome User Data', '--profile-directory=Profile 2']);
  const results = await openCheckinPages(urls, { ...browser, profileDirectory: 'Profile 2' }, async (command, args) => calls.push({ command, args }));
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].args.slice(2), urls); assert(results.every(result => result.ok));
  const failed = await openCheckinPages(urls, { ...browser, profileDirectory: 'Profile 2' }, async () => { throw new Error('模拟 Chrome 命令失败'); });
  assert(failed.every(result => !result.ok));
  for (const value of ['http://www.uooc.net.cn/home/learn/#/123', 'https://uooc.net.cn.evil.test/home/course/123', 'https://user:password@www.uooc.net.cn/home/course/123', 'https://www.uooc.net.cn:9443/home/course/123', 'https://www.uooc.net.cn/login']) assert.throws(() => checkinURL(value));
});

test('per-user startup files preserve spaces and quote characters, can be disabled, and do not keep restarting after exit', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-startup-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const options = { platform: 'darwin', home, dataDir: path.join(home, '私有 & 配置'), script: path.join(home, '中文 程序/start.mjs'), node: '/test/node' };
  const definition = autostartDefinition(options);
  await setAutostart(true, options); const content = await fs.readFile(definition.file, 'utf8');
  assert(content.includes('&amp;')); assert(content.includes('--no-open')); assert(!content.includes('KeepAlive'));
  await setAutostart(false, options); assert(!await fs.stat(definition.file).catch(() => null));
  const win = autostartDefinition({ ...options, platform: 'win32', env: { APPDATA: "C:\\Users\\张 三'\\AppData\\Roaming", SystemRoot: 'C:\\Windows' } });
  assert(win.file.endsWith('szu-uooc.lnk')); assert.match(win.command, /张 三''/); assert.match(win.command, /EncodedCommand/); assert(!win.command.includes('HKEY_LOCAL_MACHINE'));
});

test('console saves course selection and serves protected signup settings without an API Key or controller', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-checkin-console-')); let opened = [], startup = [];
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true,
    spawnController: () => { throw new Error('签到不能启动学习控制器'); }, fetchImpl: () => { throw new Error('签到不能调用模型'); },
    checkinOptions: { autoTick: false, discoverBrowser: async () => browser, isOnline: async () => true, autostart: async enabled => startup.push(enabled), notify: () => {}, openPages: async urls => { opened.push(urls); return urls.map(url => ({ url, ok: true })); } } });
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const client = await session(app);
  assert.equal((await fetch(app.origin + '/api/checkin-profiles')).status, 401);
  assert.equal((await fetch(app.origin + '/szu-uooc.user.js')).status, 401);
  for (const id of ['123', '456']) await client.post('/api/courses', { url: courseURL(id), name: `签到 ${id}`, checkinEnabled: true });
  await client.post('/api/checkin-config', { ...settings, autostart: true }); await app.checkin.tick();
  assert.equal(opened.length, 1); assert.equal(opened[0].length, 2); assert.deepEqual(startup, [true]);
  const state = await client.get(); assert.equal(state.config.hasKey, false); assert.equal(state.activeId, null); assert.equal(state.checkin.counts.opened, 2);
  await client.post('/api/checkin-course', { id: '123', name: '改名的课', enabled: true }); await app.checkin.tick(); assert.equal(opened.length, 1);
  await client.post('/api/checkin-course', { id: '123', url: 'https://www.uooc.net.cn/home/course/123', enabled: true }); await app.checkin.tick(); assert.equal(opened.length, 2);
  await client.post('/api/checkin-open', { ids: ['456'] }); assert.equal(opened.length, 3);
  await client.post('/api/checkin-config', { ...settings, enabled: false }); assert.deepEqual(startup, [true, false]);
  const courses = JSON.parse(await fs.readFile(path.join(dataDir, 'courses.json'), 'utf8')).courses; assert.equal(courses[0].name, '改名的课'); assert.equal(courses[0].checkinEnabled, true);
});
