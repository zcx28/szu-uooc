import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConsole } from '../student/console-server.mjs';
import { saveJSON, defaults } from '../student/settings.mjs';
import { appDir, courseURL } from './console-fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();

test('Firefox setup offers its automation window without Chromium debugging instructions', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-firefox-guide-'));
  await saveJSON(path.join(dataDir, 'browser.json'), { kind: 'firefox', needsCourseRefresh: true });
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true,
    browserOptions: { discoverBrowser: async ({ kind }) => ({ kind, installed: true, available: true, profiles: [] }) }, checkinOptions: { autoTick: false } });
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.getByRole('button', { name: '打开 Firefox 并连接', exact: true }).waitFor();
  assert.equal(await page.locator('#debug-url').count(), 0);
  assert.match(await page.locator('#guide-content').innerText(), /独立的 Firefox 窗口/);
});

test('the real browser selector changes a previously used offline Edge to Chrome after manual verification', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-browser-selection-ui-'));
  await saveJSON(path.join(dataDir, 'browser.json'), { kind: 'edge', needsCourseRefresh: false });
  await saveJSON(path.join(dataDir, 'courses.json'), { courses: [{ id: '123', url: courseURL('123'), name: '测试课程', status: 'stopped', phase: 'paused' }] });
  await saveJSON(path.join(dataDir, 'api.json'), { ...defaults, answer_mode: 'free', api_key: '' });
  await saveJSON(path.join(dataDir, 'ledger/course-123.json'), { courseId: '123', model: 'fixture', requests: [{ id: 'unknown', status: 'unknown', reserved_nanos: 50000000 }] });
  let connections = 0;
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true,
    spawnController: () => assert.fail('changing the browser must not start a course'),
    browserOptions: { connectBrowser: async () => { connections++; throw new Error('Edge unavailable'); },
      discoverBrowser: async ({ kind }) => ({ kind, available: true, profiles: [] }) }, checkinOptions: { autoTick: false } });
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1108, height: 740 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.getByRole('button', { name: '更换浏览器', exact: true }).click();
  await page.locator('#browser-kind').selectOption('chrome');
  await page.locator('#browser-same-account').check();
  await page.getByRole('button', { name: '使用此浏览器', exact: true }).click();
  await page.locator('#browser-submission-field').waitFor({ state: 'visible' });
  assert.match(await page.locator('#browser-error').innerText(), /课程网站核对测验结果/);
  assert.equal((await app.state()).browser.kind, 'edge');
  assert.equal(await page.locator('#browser-submission-confirmed').isChecked(), false);
  assert.equal(await page.locator('#browser-submission-confirmed').evaluate(input => input.required), true);
  const evidence = path.join(appDir, 'dist/evidence/browser-selection'); await fs.mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, 'manual-verification.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(evidence, 'manual-verification-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1108, height: 740 });
  await page.locator('#browser-submission-confirmed').check();
  await page.getByRole('button', { name: '使用此浏览器', exact: true }).click();
  await page.locator('#browser-dialog').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#learning-browser-status').innerText(), /Chrome/);
  const state = await app.state();
  assert.equal(state.browser.kind, 'chrome'); assert.equal(state.browser.needsCourseRefresh, true);
  assert.equal(state.courses.length, 1); assert.equal(state.courses[0].costs.reserved, .05);
  assert.equal(state.activeIds.length, 0); assert.equal(connections, 0);
  await page.screenshot({ path: path.join(evidence, 'chrome-selected.png'), fullPage: true });
  await page.getByRole('button', { name: '更换浏览器', exact: true }).click();
  assert.equal(await page.locator('#browser-submission-field').isVisible(), false);
  assert.equal(await page.locator('#browser-submission-confirmed').isChecked(), false);
  await page.locator('#browser-kind').selectOption('edge');
  await page.locator('#browser-same-account').check();
  await page.getByRole('button', { name: '使用此浏览器', exact: true }).click();
  await page.locator('#browser-dialog').waitFor({ state: 'hidden' });
  assert.equal((await app.state()).browser.kind, 'edge'); assert.equal(connections, 0);
  await page.getByRole('button', { name: '更换浏览器', exact: true }).click();
  await page.locator('#browser-kind').selectOption('firefox');
  await page.locator('#browser-same-account').check();
  await page.getByRole('button', { name: '使用此浏览器', exact: true }).click();
  await page.locator('#browser-dialog').waitFor({ state: 'hidden' });
  assert.equal((await app.state()).browser.kind, 'firefox'); assert.equal(connections, 0);
  await page.getByRole('button', { name: '打开 Firefox 并连接', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
