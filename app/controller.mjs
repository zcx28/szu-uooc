#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createAPI } from './api-request.mjs';
import { allowedHost, installCourseScript, verificationSelector, clickVerificationControl, stopCourseScript } from './browser-bridge.mjs';
import { connectOriginalChrome } from './chrome-connection.mjs';
import { discoverChrome } from './student/checkin-browser.mjs';
import { acquireStartLock } from './student/start.mjs';

export async function runController(options = {}) {
const here = path.dirname(fileURLToPath(import.meta.url));
const args = options.args ? [...options.args] : process.argv.slice(2);
const report = options.log || console.log;
const commandSource = options.commands || process;
const consoleIndex = args.indexOf('--console');
const consoleMode = consoleIndex >= 0;
if (consoleMode) args.splice(consoleIndex, 1);
const resumeBillingIndex = args.indexOf('--resume-billing');
const resumeBilling = resumeBillingIndex >= 0;
if (resumeBilling) args.splice(resumeBillingIndex, 1);
let requestedCommand = options.initialCommand || '';
let userPaused = requestedCommand === 'pause';
let handleCommand = () => {};
if (consoleMode && !options.commands) process.once('disconnect', () => { requestedCommand = 'stop'; handleCommand('stop'); });
if (consoleMode) commandSource.on('message', message => {
  if (message?.type === 'command' && ['pause', 'resume', 'stop', 'focus'].includes(message.action)) {
    requestedCommand = message.action;
    if (message.action === 'pause') userPaused = true;
    if (message.action === 'resume') userPaused = false;
    handleCommand(message.action);
  }
});
const dataIndex = args.indexOf('--data-dir');
const privateDir = dataIndex < 0 ? path.join(os.homedir(), '.config/ai/szu-uooc') : path.resolve(args.splice(dataIndex, 2)[1]);
const confirmIndex = args.indexOf('--confirm-verification');
const confirmVerification = confirmIndex >= 0;
if (confirmVerification) args.splice(confirmIndex, 1);
const configIndex = args.indexOf('--config');
const configFile = configIndex < 0 ? path.join(privateDir, 'daitu.json') : args.splice(configIndex, 2)[1];
const courseURL = args[0];
if (!courseURL) {
  report('用法：node szu-uooc/controller.mjs <UOOC课程学习页URL> [--config 私有配置.json] [--confirm-verification]');
  throw new Error('请提供课程网址。');
}
const url = new URL(courseURL);
if (url.protocol !== 'https:' || !allowedHost(url.hostname) || !/^\/home\/learn\//.test(url.pathname)) throw new Error('请提供 UOOC 的 HTTPS 课程学习页');
const expectedCourse = url.hash.replace(/^#\/?/, '').split('/').find((part) => /^\d+$/.test(part));
if (!expectedCourse) throw new Error('学习页 URL 中没有课程 ID，请复制已打开课程的完整地址');

let release;
try { release = await acquireStartLock(path.join(privateDir, 'controllers', expectedCourse)); }
catch (error) {
  if (/控制台已打开/.test(error.message)) throw new Error('这门课程已有控制器运行，请先停止原任务后重试。');
  throw error;
}
try {
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  ({ chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')));
}
let config;
try { config = JSON.parse(await fs.readFile(configFile, 'utf8')); } catch { throw new Error('私有 API 配置无法读取或 JSON 格式有误'); }
const bank = await fs.readFile(path.join(here, 'data/answers.json'), 'utf8');
if (!Array.isArray(JSON.parse(bank).questions)) throw new Error('答案库结构无效');
const script = await fs.readFile(path.join(here, 'szu-uooc.user.js'), 'utf8');
const requestAPI = createAPI(config, path.join(privateDir, 'ledger'), options.fetchAPI || fetch, report);
if (config.answer_mode !== 'free' && resumeBilling && !['pause', 'stop'].includes(requestedCommand)) await requestAPI.prepareResume(expectedCourse);
report(options.browser ? '使用所选浏览器的已有课程会话。' : '连接已登录的 Chrome。请先在 chrome://inspect/#remote-debugging 开启调试，并在 Chrome 提示中批准本次连接。');
const cdpEndpoint = process.env.SZU_UOOC_CDP_ENDPOINT || 'chrome';
if (cdpEndpoint !== 'chrome' && !['127.0.0.1', 'localhost'].includes(new URL(cdpEndpoint).hostname)) throw new Error('调试连接仅允许本机浏览器。');
const browser = options.browser || await connectOriginalChrome(chromium, cdpEndpoint, cdpEndpoint === 'chrome' ? await discoverChrome() : {});
let uninstall;
let scriptSuspended = false;
const disconnect = async () => {
  const cleanup = uninstall; uninstall = undefined;
  try { await cleanup?.(); }
  finally { if (!options.browser) await browser.close(); }
};
if (requestedCommand === 'stop') { await disconnect(); return; }
const browserPages = browser.contexts().flatMap(context => context.pages());
if (options.page && !browserPages.includes(options.page)) { await disconnect(); throw new Error('指定的课程标签页不属于已连接的 浏览器。'); }
if (options.page) {
  try {
    await options.page.waitForURL(current => current.protocol === 'https:' && allowedHost(current.hostname)
      && /^\/home\/learn\//.test(current.pathname) && current.hash.replace(/^#\/?/, '').split('/')[0] === expectedCourse,
    { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {
    await disconnect();
    if (requestedCommand === 'stop') return;
    throw new Error('课程入口跳转未完成。请在已连接的 浏览器 登录 UOOC，并打开这门课的学习页后重试。');
  }
}
let candidates = (options.page ? [options.page] : browserPages).filter((candidate) => {
  const current = new URL(candidate.url());
  return current.protocol === 'https:' && allowedHost(current.hostname) && current.searchParams.get('szu_checkin') !== '1' && /^\/home\/learn\//.test(current.pathname) && current.hash.replace(/^#\/?/, '').split('/')[0] === expectedCourse;
});
// SPA navigation may remove the URL marker. Never turn a check-in tab into a learning tab.
candidates = (await Promise.all(candidates.map(async candidate => {
  try { return await candidate.evaluate(() => sessionStorage.getItem('szu-uooc:checkin-tab') === '1') ? null : candidate; }
  catch { return null; }
}))).filter(Boolean);
// A saved course can be opened using the existing signed-in 浏览器 profile.
if (!options.page && consoleMode && (options.freshPage || candidates.length === 0) && requestedCommand !== 'stop') {
  const context = browser.contexts()[0];
  if (context) { const target = await context.newPage(); await target.goto(courseURL, { waitUntil: 'domcontentloaded', timeout: 60000 }); candidates = [target]; }
}
if (requestedCommand === 'stop') { await disconnect(); return; }
if (candidates.length !== 1) {
  await disconnect();
  throw new Error('请在现有 浏览器 中保留一个目标课程学习标签页，再运行控制器；不会新开登录窗口。');
}
const page = candidates[0];
const connectedURL = new URL(page.url());
if (!allowedHost(connectedURL.hostname) || !/^\/home\/learn\//.test(connectedURL.pathname) || connectedURL.hash.replace(/^#\/?/, '').split('/')[0] !== expectedCourse) {
  await disconnect(); throw new Error('请先在 浏览器 登录并打开这门课程的学习页面，再点击开始。');
}
const legacyPanelId = ['fast', 'uooc-auto-player-controls'].join('');
if (await page.locator('#' + legacyPanelId).count()) {
  await disconnect(); throw new Error('请先暂停原来的学习脚本，并刷新课程页面后重试。');
}
if (await page.locator('#szu-uooc-auto-player-controls').count()) {
  const prior = await page.locator('#szu-uooc-course-state').textContent().catch(() => null);
  const managed = await page.evaluate(() => typeof window.GM_getValue === 'function' && window.GM_getValue('szu-uooc:ai-api-key') === '[managed-by-local-controller]');
  if (managed && prior && JSON.parse(prior).active) await stopCourseScript(page);
  if (managed || (prior && JSON.parse(prior).active === false)) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  if (await page.locator('#szu-uooc-auto-player-controls').count()) {
    await disconnect();
    throw new Error('请先暂停原来的学习脚本，并刷新课程页面后重试。');
  }
}
const boundedOperation = async (operation, timeout = 3000) => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('课程页面读取超时')), timeout); })]); }
  finally { clearTimeout(timer); }
};
const suspendDocument = async () => {
  const cleanup = uninstall; uninstall = undefined; scriptSuspended = true;
  await cleanup?.();
  if (!page.isClosed()) await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
};
const terminal = options.commands ? null : createInterface({ input: process.stdin, output: process.stdout });
const stopSignal = new AbortController();
terminal?.once('close', () => stopSignal.abort());
let stopping = false;
let stopPromise;
const stop = () => {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopSignal.abort();
  return stopPromise = (async () => {
    await boundedOperation(stopCourseScript(page)).catch(async error => { report('停止入口不可用，正在终止旧页面：' + String(error.message || error).replaceAll(config.api_key || '\0', '[已隐藏]')); await suspendDocument(); });
    if (consoleMode) report('后续任务已停止，正在确认本次请求的费用。');
    await requestAPI.idle();
    terminal?.close();
    await disconnect();
  })();
};
const waitOrStop = async operation => {
  let cancel;
  const cancelled = new Promise(resolve => { cancel = resolve; if (stopSignal.signal.aborted) resolve(); else stopSignal.signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([operation, cancelled]); }
  finally { stopSignal.signal.removeEventListener('abort', cancel); }
};
if (!options.commands) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
if (consoleMode && !options.commands) process.once('disconnect', stop);
terminal?.once('SIGINT', stop);
if (!options.browser) browser.once('disconnected', () => { stopping = true; stopSignal.abort(); terminal?.close(); });
page.once('close', stop);

uninstall = await installCourseScript(page, { config, bank, script, expectedCourse, requestAPI, consoleMode });
if (requestedCommand === 'stop') { await stop(); return; }

page.on('pageerror', (error) => report('页面脚本错误：' + error.message.replaceAll(config.api_key || '\0', '[redacted]').slice(0, 240)));
const verificationLoads = [];
page.on('requestfailed', (request) => {
  const failed = new URL(request.url());
  if (/captcha|aliyun|alicdn/i.test(failed.href)) verificationLoads.push({ host: failed.hostname, path: failed.pathname, error: request.failure()?.errorText });
});
page.on('response', (response) => {
  const result = new URL(response.url());
  if (/captcha|aliyun|alicdn/i.test(result.href) && response.status() >= 400) verificationLoads.push({ host: result.hostname, path: result.pathname, status: response.status() });
});
const evidenceDir = path.join(privateDir, 'evidence', 'course-' + expectedCourse);
await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const capturePreview = async name => {
  try { await page.screenshot({ path: path.join(evidenceDir, name), timeout: 3000 }); }
  catch { report('课程预览暂时无法生成，继续运行。'); }
};
terminal?.on('line', async (line) => {
  if (stopping || !['snapshot', 'status'].includes(line.trim())) return;
  try {
    if (line.trim() === 'status') {
      report(JSON.stringify(await page.evaluate(() => ({ route: location.hash, ready: document.readyState, state: document.querySelector('#szu-uooc-course-state')?.textContent, panel: !!document.querySelector('#szu-uooc-auto-player-controls'), videos: [...document.querySelectorAll('video')].map(v => ({ time: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null, paused: v.paused, error: v.error?.code })), binding: typeof window.szuUoocNetwork, script: typeof window.GM_getValue }))));
      return;
    }
    await page.screenshot({ path: path.join(evidenceDir, 'current.png') });
    const location = new URL(page.url());
    await fs.writeFile(path.join(evidenceDir, 'browser.txt'), `URL: ${location.origin}${location.pathname}\n` + await page.locator('body').innerText(), { mode: 0o600 });
    await fs.writeFile(path.join(evidenceDir, 'verification-loads.json'), JSON.stringify(verificationLoads, null, 2) + '\n', { mode: 0o600 });
    report('已保存当前页面与验证组件加载情况。');
  } catch (error) { if (!stopping) report('页面证据保存失败：' + error.message.slice(0, 160)); }
});
try { await waitOrStop(page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })); }
catch (error) { if (!/Timeout/i.test(error.name + ' ' + error.message)) throw error; report('课程页面加载超时，等待状态监控自动恢复。'); }
if (stopping) { await stop(); return; }
report('课程浏览器已就绪。API Key 只保留在本地进程。');
report(`私有账本：${path.join(privateDir, 'ledger')}；Ctrl+C 停止并保留 浏览器 窗口与已完成进度。`);
try {
  await capturePreview('initial.png');
  const initialLocation = new URL(page.url());
  await fs.writeFile(path.join(evidenceDir, 'browser.txt'), `URL: ${initialLocation.origin}${initialLocation.pathname}\n` + await page.locator('body').innerText({ timeout: 3000 }), { mode: 0o600 });
} catch { report('课程预览暂时无法生成，继续运行。'); }
let started = false;
let lastState = '';
let verificationAttempted = '';
let verificationRetryAt = 0;
let verificationClickRun = '', verificationClickFailures = 0;
let lastActivity = Date.now();
const title = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).split('\n').map(text => text.trim()).find(Boolean) || '课程 ' + expectedCourse;
let reportedState;
const emitState = state => { reportedState = { ...state }; if (options.onState) options.onState({ type: 'state', state, title }); else if (consoleMode && process.connected) process.send({ type: 'state', state, title }); };
const recovery = { pollMs: 2000, missingTimeoutMs: 45000, heartbeatTimeoutMs: 45000, idleGraceMs: 5000, baseDelayMs: 2000, maxDelayMs: 30000, maxAttempts: 3, stableMs: 60000, ...options.recovery };
let missingSince = 0, idleSince = 0, healthySince = 0, recoveryAttempts = 0, recoveryNextAt = 0, recoveryBlocked = false;
let lastReadableState;
let lastTaskRecovery = '';
let recoveryEntries = (await fs.readFile(path.join(evidenceDir, 'recovery.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).slice(-100);
const safeMessage = error => String(error?.message || error).replaceAll(config.api_key || '\0', '[已隐藏]').slice(0, 240);
const journalRecovery = async (event, reason, stage = '') => {
  const entry = { at: new Date().toISOString(), event, courseId: expectedCourse, phase: lastReadableState?.phase || '', sourceId: lastReadableState?.sourceId || '', attempt: recoveryAttempts, stage, reason: safeMessage(reason) };
  recoveryEntries.push(JSON.stringify(entry)); recoveryEntries = recoveryEntries.slice(-100);
  await fs.writeFile(path.join(evidenceDir, 'recovery.jsonl'), recoveryEntries.join('\n') + '\n', { mode: 0o600 }).catch(() => report('恢复日志暂时无法保存。'));
};
const boundedRead = operation => waitOrStop(boundedOperation(operation));
const pauseRecovery = async (reason, event = 'blocked') => {
  recoveryBlocked = true;
  let halted = false;
  try {
    await boundedRead(stopCourseScript(page));
    halted = await boundedRead(page.evaluate(id => {
      const node = document.querySelector('#szu-uooc-course-state');
      const inactive = node ? JSON.parse(node.textContent).active === false : !window.__szuUoocRunnerInstalled;
      if (!inactive) return false;
      const text = localStorage.getItem('szu-uooc:course-state:' + id);
      if (!text) return true;
      const saved = JSON.parse(text);
      return saved && typeof saved === 'object' && saved.active === false;
    }, expectedCourse));
  } catch (error) { await journalRecovery('stop_failed', error); }
  if (stopping) return;
  if (!halted) {
    // Removing our init script before reloading cancels this document without starting another runner.
    await waitOrStop(suspendDocument());
    if (stopping) return;
    halted = await boundedRead(page.evaluate(() => !window.__szuUoocRunnerInstalled));
    if (!halted) throw new Error('无法确认课程已停止，请在浏览器停止脚本后重试。');
    await journalRecovery('document_stopped', reason);
  }
  if (stopping) return;
  emitState({ courseId: expectedCourse, total: 0, completed: 0, ...reportedState, active: false, phase: 'paused', error: reason });
  report(reason); await journalRecovery(event, reason);
};
const recoverPage = async (reason, idle = false) => {
  if (stopping || userPaused || recoveryBlocked) return;
  const now = Date.now(); healthySince = 0;
  if (!missingSince) { missingSince = now; await journalRecovery('unavailable', reason); }
  if (now - missingSince < (idle ? recovery.idleGraceMs : recovery.missingTimeoutMs) || now < recoveryNextAt) return;
  const currentURL = new URL(page.url());
  if (currentURL.protocol !== 'https:' || !allowedHost(currentURL.hostname) || !/^\/home\/learn\//.test(currentURL.pathname) || currentURL.hash.replace(/^#\/?/, '').split('/')[0] !== expectedCourse) {
    await pauseRecovery('课程页面已离开当前课程或登录失效，请人工检查后点击继续。'); return;
  }
  let saved;
  try { saved = await boundedRead(page.evaluate(id => JSON.parse(localStorage.getItem('szu-uooc:course-state:' + id) || 'null'), expectedCourse)); }
  catch (error) { await pauseRecovery('执行断点无法核对，请人工检查后点击继续：' + safeMessage(error)); return; }
  if (stopping || userPaused) return;
  if (idle && saved?.active === false) { await pauseRecovery('课程已在页面停止，保留暂停状态；点击继续重新读取目录。'); return; }
  if (lastReadableState?.pendingSubmit || saved?.pendingSubmit || ['solving', 'submitting'].includes(lastReadableState?.phase)) {
    await pauseRecovery('解题请求或交卷结果尚未确认，请人工核对后点击继续；未自动重放。'); return;
  }
  if (recoveryAttempts >= recovery.maxAttempts) { await pauseRecovery('页面自动恢复次数已达上限，请检查网络和课程页面后点击继续。', 'exhausted'); return; }
  recoveryAttempts++;
  const stage = idle ? 'resume' : 'reload';
  recoveryNextAt = now + Math.min(recovery.maxDelayMs, recovery.baseDelayMs * 2 ** (recoveryAttempts - 1));
  await journalRecovery('attempt', reason, stage);
  report(`页面自动恢复 ${recoveryAttempts}/${recovery.maxAttempts}：${reason}；${idle ? '继续原任务' : '重新加载课程页面'}。`);
  if (stopping || userPaused) return;
  try {
    if (idle) await waitOrStop(page.locator('[data-action="course-start"]').evaluate(node => node.click(), undefined, { timeout: 3000 }));
    else await waitOrStop(page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }));
    await journalRecovery('action_complete', reason, stage);
  } catch (error) { await journalRecovery('action_failed', error, stage); report('页面自动恢复未完成：' + safeMessage(error)); }
};
let commandQueue = Promise.resolve();
handleCommand = action => {
  if (action === 'stop') { stop().catch(error => report('操作未完成：' + error.message.replaceAll(config.api_key || '\0', '[已隐藏]'))); return; }
  commandQueue = commandQueue.then(async () => {
    if (stopping) return;
    if (action === 'focus') {
      try {
        const session = await page.context().newCDPSession(page);
        try { if (stopping) return; const { windowId } = await session.send('Browser.getWindowForTarget'); if (!stopping) await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); } finally { await session.detach(); }
      } catch (error) {
        if (!/CDP session is only available in Chromium/i.test(error.message)) throw error;
      }
      if (stopping) return;
      await page.bringToFront(); if (!stopping) await options.focusBrowser?.(); return;
    }
    lastState = '';
    if (action === 'pause') {
      await pauseRecovery('用户暂停', 'manual_pause');
    } else if (action === 'resume') {
      recoveryBlocked = false; recoveryAttempts = 0; missingSince = 0; idleSince = 0; recoveryNextAt = 0;
      if (scriptSuspended) {
        uninstall = await installCourseScript(page, { config, bank, script, expectedCourse, requestAPI, consoleMode });
        await waitOrStop(page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }));
        scriptSuspended = false;
      }
      if (config.answer_mode !== 'free') await requestAPI.prepareResume(expectedCourse);
      if (stopping || userPaused) return;
      await page.locator('[data-action="course-start"]').evaluate(node => node.click());
      const state = JSON.parse(await page.locator('#szu-uooc-course-state').textContent());
      if (!stopping) emitState(state);
    }
  }).catch(error => report('操作未完成：' + error.message.replaceAll(config.api_key || '\0', '[已隐藏]')));
};
if (requestedCommand) handleCommand(requestedCommand);

try {
  while (!stopping) {
    let text, state;
    try {
      text = await page.locator('#szu-uooc-course-state').textContent({ timeout: 2000 });
      state = text && JSON.parse(text);
      if (!state || typeof state !== 'object' || typeof state.phase !== 'string' || typeof state.active !== 'boolean') throw new Error('课程状态暂时缺失或格式无效');
    } catch (error) {
      await recoverPage(safeMessage(error));
      await waitOrStop(delay(recovery.pollMs)); continue;
    }
    if (options.observePage) {
      try { await waitOrStop(options.observePage(page, state)); }
      catch (error) { await journalRecovery('observation_failed', error); report('课程观察暂时失败：' + safeMessage(error)); }
    }
    if (stopping) break;
    if (String(state.courseId) !== expectedCourse) {
      await recoverPage('课程状态与当前课程不匹配');
      await waitOrStop(delay(recovery.pollMs)); continue;
    }
    if (state.active && state.heartbeatAt && Date.now() - state.heartbeatAt > recovery.heartbeatTimeoutMs && !(state.nextRetryAt > Date.now())) {
      await recoverPage('页面脚本长时间没有心跳');
      await waitOrStop(delay(recovery.pollMs)); continue;
    }
    if (started && !state.active && state.phase === 'idle') {
      if (userPaused || recoveryBlocked || reportedState?.phase === 'paused') {
        Object.assign(state, reportedState, { active: false, phase: 'paused' });
        state.error ||= '课程页面已重新加载，任务已暂停；点击继续重新读取目录。';
      } else {
        idleSince ||= Date.now();
        // The userscript first restores saved.active itself; only then reuse its ordinary start action.
        if (Date.now() - idleSince >= recovery.idleGraceMs) await recoverPage('页面刷新后任务尚未恢复', true);
        await waitOrStop(delay(recovery.pollMs)); continue;
      }
    } else idleSince = 0;
    if ((userPaused || recoveryBlocked) && state.active) { await boundedRead(stopCourseScript(page)).catch(() => {}); await waitOrStop(delay(recovery.pollMs)); continue; }
    if (userPaused && state.error === '用户停止') state.error = '用户暂停';
    if (recoveryBlocked && reportedState?.phase === 'paused') Object.assign(state, reportedState);
    if (!started && !userPaused && !recoveryBlocked && requestedCommand !== 'stop' && state.courseId && await page.locator('[data-action="course-start"]').count()) {
      started = true;
      if (!state.active) await page.locator('[data-action="course-start"]').evaluate(node => node.click());
      continue;
    }
    if (missingSince) { await journalRecovery('recovered', '课程状态已恢复'); missingSince = 0; lastState = ''; }
    healthySince ||= Date.now();
    if (Date.now() - healthySince >= recovery.stableMs) recoveryAttempts = 0;
    lastReadableState = { ...state };
    text = JSON.stringify(state);
    const signature = JSON.stringify({ ...state, heartbeatAt: undefined, progressAt: undefined });
    const changed = lastState !== signature;
    if (state.progressAt) lastActivity = Math.min(Date.now(), state.progressAt);
    if (changed) {
      const taskRecovery = JSON.stringify([state.recoveryOperation, state.recoveryAttempt, state.recoveryResult, state.recoveryReason, state.nextRetryAt]);
      if (taskRecovery !== lastTaskRecovery) {
        lastTaskRecovery = taskRecovery;
        if (state.recoveryOperation) report(`任务自动恢复 ${safeMessage(state.recoveryOperation)}；attempt=${state.recoveryAttempt || 0}；result=${safeMessage(state.recoveryResult || '')}；reason=${safeMessage(state.recoveryReason || '')}；waitMs=${Math.max(0, (state.nextRetryAt || 0) - Date.now())}`);
      }
      emitState(state);
      if (!state.progressAt) lastActivity = Date.now();
      lastState = signature;
      const phaseLabel = { loading_catalog: '读取课程目录', video: '播放视频', solving: '准备答案', awaiting_verification: '等待网站验证', submitting: '提交测验', paused: '已暂停', complete: '已完成' }[state.phase] || state.phase;
      report(`${new Date().toLocaleTimeString()} ${phaseLabel} 已读任务 ${state.completed}/${state.total}${state.lockedUnits ? `（${state.lockedUnits} 个目录单元待解锁）` : ''} ${state.currentTitle || ''}${state.error ? ' — ' + state.error : ''}`);
      await fs.writeFile(path.join(evidenceDir, 'state.json'), text + '\n', { mode: 0o600 }).catch(() => report('课程状态预览暂时无法保存，继续运行。'));
    }
    if (state.phase === 'complete' || (changed && started && state.phase === 'paused')) {
      await capturePreview('result.png');
      report(state.phase === 'complete' ? '平台目录已确认课程范围内的任务完成。' : consoleMode ? '已保留进度并暂停，请在控制台查看原因并继续。' : '已保留进度并暂停。修正显示的问题后，在网页点击“启动当前课程”恢复。');
      if (state.phase === 'complete') break;
    }
    if (changed && state.phase === 'loading_catalog') verificationAttempted = '';
    const verificationRun = `${state.courseId}:${state.sourceId}:${state.runId}:${state.verificationAttempt}`;
    if (verificationClickRun !== verificationRun) { verificationClickRun = verificationRun; verificationClickFailures = 0; verificationRetryAt = 0; }
    if (state.active && state.phase === 'awaiting_verification' && verificationAttempted !== verificationRun && Date.now() >= verificationRetryAt) {
      const frames = page.frames().filter((frame) => {
        const location = new URL(frame.url());
        return location.origin === new URL(page.url()).origin && location.protocol === 'https:' && allowedHost(location.hostname) && location.pathname === state.quizUrl;
      });
      const frame = frames.length === 1 ? frames[0] : null;
      if (frame) {
        const checkbox = frame.locator(verificationSelector);
        if (await checkbox.isVisible().catch(() => false)) {
          await capturePreview('verification.png');
          const answer = confirmVerification ? terminal ? await terminal.question('本次测验已填好，是否允许点击当前原生验证复选框？输入 yes 仅批准本次，其他输入保留等待：', { signal: stopSignal.signal }).catch(() => '') : '' : 'yes';
          verificationAttempted = verificationRun;
          if (!stopping && !userPaused && answer.trim().toLowerCase() === 'yes') {
            const click = async () => {
              await page.bringToFront();
              return clickVerificationControl(page, frame, async () => {
                const current = JSON.parse(await page.locator('#szu-uooc-course-state').textContent());
                return !stopping && !userPaused && current.active && current.phase === 'awaiting_verification' && current.sourceId === state.sourceId && current.courseId === state.courseId && current.runId === state.runId && current.quizUrl === state.quizUrl && current.verificationAttempt === state.verificationAttempt;
              });
            };
            try {
              const clicked = options.verify ? await options.verify(click, { page, state }) : await click();
              if (clicked) { verificationClickFailures = 0; report('验证已提交，继续等待网站确认。若仍停在验证页，请在浏览器窗口内手动完成智能验证。'); }
            } catch (error) {
              if (!stopping && !userPaused) {
                verificationClickFailures++;
                const waitMs = Math.min(60000, 5000 * 2 ** Math.min(verificationClickFailures - 1, 4));
                verificationAttempted = ''; verificationRetryAt = Date.now() + waitMs;
                report(`原生验证点击未完成 ${verificationClickFailures} 次，${waitMs / 1000}秒后重试：` + safeMessage(error));
                await journalRecovery('verification_click_retry', error, `native_input_${verificationClickFailures}`);
              }
            }
          }
        }
      }
    }
    if (!['video', 'paused', 'awaiting_verification'].includes(state.phase) && Date.now() - lastActivity > 20 * 60 * 1000) {
      report('长时间没有任务状态变化，请检查 浏览器 视频播放或网络。进度已保留。');
      if (consoleMode) {
        await stopCourseScript(page);
        const paused = JSON.parse(await page.locator('#szu-uooc-course-state').textContent());
        paused.error = '长时间没有任务状态变化，请检查 浏览器 和网络后点击继续。';
        emitState(paused);
      } else await terminal.question('按 Enter 继续观察，或 Ctrl+C 结束：', { signal: stopSignal.signal }).catch(() => '');
      lastActivity = Date.now();
    }
    await waitOrStop(delay(recovery.pollMs));
  }
} catch (error) {
  if (!stopping) await pauseRecovery('控制器异常，已安全暂停：' + safeMessage(error), 'controller_error');
  throw error;
} finally {
  terminal?.close();
  if (!stopping) {
    if (!lastState || JSON.parse(lastState).phase !== 'complete') await stopCourseScript(page).catch(() => {});
    await disconnect();
    report(options.freshPage ? '课程控制器已结束，平台进度已保留。' : '控制器已断开；原 浏览器 及课程窗口保持打开供验收。');
    stopping = true;
  }
  stopSignal.abort();
  await waitOrStop(commandQueue);
  await (stopPromise || requestAPI.idle());
  if (options.freshPage && !page.isClosed()) await page.close();
  if (consoleMode && !options.commands && process.connected) { process.removeAllListeners('disconnect'); process.disconnect(); }
}
} finally { release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runController();
}
