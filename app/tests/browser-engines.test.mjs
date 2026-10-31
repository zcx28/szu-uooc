import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBrowserSession } from '../student/browser-session.mjs';
import { installCourseScript } from '../browser-bridge.mjs';
import { appDir } from './console-fixtures.mjs';
import { defaults } from '../student/settings.mjs';
import { firefoxCookiesFromProfile } from '../student/firefox-session.mjs';

const require = createRequire(import.meta.url);
const { chromium, firefox } = require('playwright');
const origin = 'https://www.uooc.net.cn';
const cookie = (name, value, expires = -1) => ({ name, value, domain: '.uooc.net.cn', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires });
async function routeFixture(context) {
  await context.route('**/*', async route => {
    const loggedIn = (await route.request().allHeaders()).cookie?.includes('login=');
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: loggedIn
      ? '<title>Fixture</title><a href="/home/learn/index#/123">测试课程</a>' : '<title>请登录</title>' });
  });
}
async function verifyBridge(context) {
  const page = await context.newPage();
  const dispose = await installCourseScript(page, { config: { ...defaults, answer_mode: 'free', api_key: '' }, bank: '{"questions":[]}', expectedCourse: '123',
    script: 'window.engineFixture = true;', requestAPI: async () => assert.fail('No external API calls') });
  await page.goto(origin + '/home/learn/index#/123');
  assert.equal(await page.evaluate(() => window.engineFixture), true);
  await dispose(); await page.reload();
  assert.equal(await page.evaluate(() => typeof window.engineFixture), 'undefined');
  await page.close();
}

test('real Firefox copies both login cookie types and reconnects with its own updated session and course state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-firefox-live-'));
  let source, session;
  t.after(async () => { await source?.close(); await session?.close(); await fs.rm(root, { recursive: true, force: true }); });
  source = await firefox.launchPersistentContext(path.join(root, 'personal'), { headless: true, firefoxUserPrefs: { 'browser.startup.page': 3, 'browser.sessionstore.privacy_level': 0, 'browser.sessionstore.interval': 1000 } });
  await routeFixture(source);
  await source.addCookies([cookie('login', 'personal-session'), cookie('persistent', 'personal-persistent', Math.floor(Date.now() / 1000) + 3600),
    { ...cookie('unrelated', 'private'), domain: '.example.test' }]);
  await source.pages()[0].goto(origin + '/home/index');
  await source.pages()[0].evaluate(() => localStorage.setItem('unrelated-personal-state', 'do not copy'));
  let liveCookies = [];
  for (let i = 0; i < 40; i++) {
    liveCookies = await firefoxCookiesFromProfile(root, 'personal');
    if (liveCookies.some(item => item.name === 'login')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(liveCookies.find(item => item.name === 'login')?.value, 'personal-session', 'read the live recovery snapshot');
  assert.equal(liveCookies.find(item => item.name === 'persistent')?.value, 'personal-persistent', 'read uncheckpointed persistent cookies');
  await source.close(); source = null;
  const launch = firefox.launchPersistentContext.bind(firefox);
  t.mock.method(firefox, 'launchPersistentContext', async (dir, options) => {
    const context = await launch(dir, { ...options, headless: true });
    await routeFixture(context); return context;
  });
  const logs = [];
  session = createBrowserSession({ appDir, dataDir: root, getBrowserKind: () => 'firefox', log: text => logs.push(text),
    discoverBrowser: async () => ({ userDataDir: root, profiles: [{ directory: 'personal' }], lastUsedProfile: 'personal' }) });
  const connected = await session.get(), context = connected.contexts()[0];
  assert.equal((await context.cookies()).find(item => item.name === 'login')?.value, 'personal-session');
  assert.equal((await context.cookies()).find(item => item.name === 'persistent')?.value, 'personal-persistent');
  assert.equal((await context.cookies()).some(item => item.name === 'unrelated'), false);
  assert.deepEqual((await session.courses()).map(item => item.id), ['123']);
  assert.equal(await context.pages()[0].evaluate(() => localStorage.getItem('unrelated-personal-state')), null);
  await verifyBridge(context);
  await context.addCookies([cookie('login', 'automation-session')]);
  await context.pages()[0].evaluate(() => localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ pendingSubmit: { task_id: '456' } })));
  await session.close();
  const reopened = (await session.get()).contexts()[0];
  assert.equal((await reopened.cookies()).find(item => item.name === 'login')?.value, 'automation-session');
  assert.deepEqual((await session.courses()).map(item => item.id), ['123']);
  await assert.rejects(session.assertSwitchable([origin + '/home/learn/index#/123']), /交卷.*123/);
  assert(logs.some(text => /导入 2 项/.test(text)));
  await reopened.clearCookies({ name: 'login' });
  await session.close();
  assert.equal((await (await session.get()).contexts()[0].cookies()).some(item => item.name === 'login'), false, 'logout must not reimport the personal session');
});

for (const kind of ['chrome', 'edge']) test(`real ${kind} connection keeps its existing login and tabs through browser switching`, async t => {
  // On Windows exercise the installed branded browsers; elsewhere use an explicit path.
  const executablePath = kind === 'chrome' ? process.env.SZU_UOOC_CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : chromium.executablePath())
    : process.env.SZU_UOOC_EDGE || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : '');
  if (!executablePath || !await fs.stat(executablePath).catch(() => null)) { t.skip('Branded browser not installed'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `szu-${kind}-live-`));
  let owner, session;
  t.after(async () => { await session?.close(); await owner?.close(); await fs.rm(root, { recursive: true, force: true }); });
  owner = await chromium.launchPersistentContext(root, { executablePath, headless: true, args: ['--remote-debugging-port=0'] });
  await routeFixture(owner); await owner.addCookies([cookie('login', kind)]);
  const portal = await owner.newPage(); await portal.goto(origin + '/home/index');
  const unrelated = await owner.newPage(); await unrelated.goto('https://example.test/');
  session = createBrowserSession({ appDir, dataDir: root, getBrowserKind: () => kind, discoverBrowser: async () => ({ kind, userDataDir: root }) });
  const context = (await session.get()).contexts()[0];
  assert.deepEqual((await session.courses()).map(item => item.id), ['123']);
  await verifyBridge(context);
  await session.assertSwitchable([origin + '/home/learn/index#/123']);
  await session.close();
  assert.equal(portal.isClosed(), false); assert.equal(unrelated.isClosed(), false);
  assert.equal((await owner.cookies()).find(item => item.name === 'login')?.value, kind);
  await session.get();
  assert.deepEqual((await session.courses()).map(item => item.id), ['123']);
});
