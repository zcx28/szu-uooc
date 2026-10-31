import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { defaults, validateConfig, validateCourseURL, readJSON, saveJSON } from './settings.mjs';
import { createBrowserSession, courseFromURL } from './browser-session.mjs';
import { createCheckin } from './checkin.mjs';
import { checkinURL, discoverBrowser, browserTypes } from './checkin-browser.mjs';
import { normalizeServiceURL } from '../api-protocol.mjs';
import { detectService } from './service-detection.mjs';
import { diagnosticZip } from './diagnostics.mjs';
import { readCourseCosts } from '../api-ledger.mjs';

const phases = { opening: '打开学习资源', connecting: '等待浏览器授权', recovering: '正在恢复', loading_catalog: '读取课程目录', video: '播放视频', solving: '准备答案', awaiting_verification: '等待网站验证', submitting: '提交测验', paused: '已暂停', complete: '已完成' };
const statuses = { ready: '未开始', queued: '等待运行', starting: '正在连接', running: '运行中', pausing: '正在暂停', paused: '已暂停', stopping: '正在停止', stopped: '已停止', error: '需要处理', complete: '已完成' };

export async function createConsole({ appDir, dataDir, spawnController, browserOptions = {}, fetchImpl = fetch, checkDependencies, installDependencies, checkinOptions = {} } = {}) {
  const configFile = path.join(dataDir, 'api.json');
  const queueFile = path.join(dataDir, 'courses.json');
  const browserFile = path.join(dataDir, 'browser.json');
  const savedBrowser = await readJSON(browserFile, null);
  let browserSettings = savedBrowser || { kind: 'chrome', needsCourseRefresh: false };
  if (!Object.hasOwn(browserTypes, browserSettings.kind)) throw new Error('浏览器设置不可读，请检查 browser.json。');
  const hasPreviousCheckin = Boolean(await fs.stat(path.join(dataDir, 'checkin.json')).catch(() => null));
  let browserChoices = [];
  const browserDiscovery = browserOptions.discoverBrowser || discoverBrowser;
  async function listBrowsers() {
    browserChoices = await Promise.all(Object.entries(browserTypes).map(async ([kind, info]) => {
      const found = await browserDiscovery({ kind });
      return { kind, ...info, installed: found.installed ?? found.available, error: found.error || '' };
    }));
    return browserChoices;
  }
  await listBrowsers();
  const require = createRequire(path.join(appDir, 'package.json'));
  let config;
  let configError = '';
  try { config = await readJSON(configFile, null); }
  catch { configError = '原来的设置不可读，请在控制台重新保存 Key。'; config = null; }
  if (config) {
    try { validateConfig(config); config = { answer_mode: 'ai', ...config }; }
    catch (error) {
      configError = error.message;
      if (/服务设置已变化/.test(error.message)) {
        config = validateConfig({ ...config, profile: undefined, image_profile: undefined, detection: undefined, service_status: 'unchecked', pricing: null });
      } else config = null;
    }
  }
  const saved = await readJSON(queueFile, { courses: [] });
  const courses = Array.isArray(saved.courses) ? saved.courses : [];
  let selectionRequired = !savedBrowser && !config && !courses.length && !hasPreviousCheckin;
  for (const course of courses) {
    validateCourseURL(course.url);
    course.url = courseFromURL(course.url).url;
    course.id = new URL(course.url).hash.replace(/^#\/?/, '').split('/')[0];
    if (['running', 'starting', 'pausing', 'stopping', 'queued'].includes(course.status)) { course.status = 'stopped'; course.error = '上次控制台已关闭，点击开始可继续。'; }
  }
  const active = new Map();
  let queueRunning = false;
  let shuttingDown = false;
  let exportingDiagnostics = false;
  let dependencyChild;
  let installing;
  let savedQueue = Promise.resolve();
  let savedLog = Promise.resolve();
  let mutations = Promise.resolve();
  const logs = [];
  const environment = { status: 'checking', message: '正在检查运行环境', output: '' };
  const connection = { status: 'untested', message: '尚未测试连接' };
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  let origin;

  const scrub = value => String(value ?? '').replaceAll(config?.api_key || '\0', '[已隐藏]').replace(/(?:sk-|sess-)[a-z0-9_-]+|Bearer\s+\S+/gi, '[已隐藏]').slice(0, 1000);
  const logFile = path.join(dataDir, 'recovery-log.json');
  try {
    const previous = await readJSON(logFile, []);
    if (Array.isArray(previous)) for (const item of previous.slice(-100)) {
      if (item && typeof item.message === 'string') logs.push({ at: item.at, message: scrub(item.message), courseId: item.courseId });
    }
  } catch { logs.push({ at: new Date().toISOString(), message: '原运行记录不可读，已重新记录；课程与费用账本保留。' }); }
  const log = (message, courseId) => {
    logs.push({ at: new Date().toISOString(), message: scrub(message), courseId }); if (logs.length > 100) logs.shift();
    const snapshot = structuredClone(logs);
    savedLog = savedLog.then(() => saveJSON(logFile, snapshot)).catch(() => {
      logs.push({ at: new Date().toISOString(), message: '运行记录保存失败，请检查本机磁盘空间和目录权限。', courseId });
      if (logs.length > 100) logs.shift();
    });
  };
  const browserSession = createBrowserSession({ appDir, dataDir, log, ...browserOptions, getBrowserKind: () => browserSettings.kind });
  const launchController = spawnController || browserSession.spawnWorker;
  function persist() {
    const snapshot = structuredClone({ courses });
    const saving = savedQueue.then(() => saveJSON(queueFile, snapshot));
    savedQueue = saving.catch(() => {});
    return saving;
  }
  const checkin = await createCheckin({ ...checkinOptions, appDir, dataDir, getCourses: () => courses, log, getBrowserKind: () => browserSettings.kind, discoverBrowser: () => (checkinOptions.discoverBrowser || browserDiscovery)({ kind: browserSettings.kind }) });
  const requestCheckin = () => checkin.tick().catch(error => log(error.message));
  const dependenciesReady = checkDependencies || (async () => {
    try {
      const pw = await readJSON(path.join(appDir, 'node_modules/playwright/package.json'), null);
      const core = await readJSON(path.join(appDir, 'node_modules/playwright-core/package.json'), null);
      return pw?.version === '1.62.1' && core?.version === '1.62.1' && Boolean(require('playwright').chromium);
    } catch { return false; }
  });

  async function prepareEnvironment() {
    if (installing) return installing;
    if (await dependenciesReady()) { Object.assign(environment, { status: 'ready', message: '运行环境已就绪', output: '' }); return; }
    installing = (async () => {
      Object.assign(environment, { status: 'installing', message: '首次启动，正在下载浏览器连接组件', output: '', startedAt: Date.now() });
      try {
        if (installDependencies) await installDependencies();
        else {
          const runtime = path.dirname(process.execPath);
          const npm = process.platform === 'win32' ? path.join(runtime, 'node_modules/npm/bin/npm-cli.js') : path.resolve(runtime, '../lib/node_modules/npm/bin/npm-cli.js');
          await new Promise((resolve, reject) => {
            const npmArgs = [npm, 'ci', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--cache', path.resolve(appDir, '../runtime/npm-cache')];
            const mac = process.platform === 'darwin';
            dependencyChild = spawn(mac ? '/bin/bash' : process.execPath, mac ? ['-c', '. "$1" || exit; shift; exec "$@"', 'szu-download', path.join(appDir, 'student/network-mac.sh'), process.execPath, ...npmArgs] : npmArgs, {
              cwd: appDir, windowsHide: true,
              env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
            });
            const update = chunk => { environment.output = scrub(chunk.toString().trim()); };
            dependencyChild.stdout.on('data', update);
            dependencyChild.stderr.on('data', update);
            dependencyChild.once('error', reject);
            dependencyChild.once('exit', code => code === 0 ? resolve() : reject(new Error('下载没有完成，请检查网络后点击重试。')));
          });
        }
        if (!await dependenciesReady()) throw new Error('组件自检未通过，请点击重试。');
        Object.assign(environment, { status: 'ready', message: '运行环境已就绪', output: '' });
        log('运行环境已准备好，可以添加课程。');
      } catch (error) { Object.assign(environment, { status: 'error', message: scrub(error.message) }); }
      finally { dependencyChild = null; installing = null; }
    })();
    return installing;
  }

  async function costs(id) {
    try {
      return await readCourseCosts(path.join(dataDir, 'ledger'), id);
    } catch { return { spent: null, reserved: null, unknown: true, unreadable: true, recoveryRequired: false }; }
  }

  async function state() {
    const list = await Promise.all(courses.map(async course => ({ ...course, checkin: checkin.courseState(course), statusLabel: statuses[course.status] || '需要处理', phaseLabel: phases[course.phase] || '', costs: await costs(course.id) })));
    return { brand: 'szu-uooc', csrf, environment, connection, configError, config: { ...(config || defaults), api_key: undefined, hasKey: Boolean(config?.api_key) },
      courses: list, checkin: checkin.state(), browser: { ...browserSession.state(), needsCourseRefresh: browserSettings.needsCourseRefresh, selectionRequired, choices: browserChoices }, activeIds: [...active.keys()], activeId: [...active.keys()][0] || null, queueRunning, logs, shuttingDown };
  }

  function selected(id) { const course = courses.find(course => course.id === String(id)); if (!course) throw new Error('找不到这门课程。'); return course; }

  async function startCourse(course) {
    if (shuttingDown) throw new Error('控制台正在关闭。');
    if (browserSettings.needsCourseRefresh) throw new Error('切换浏览器后，请先连接并重新读取课程，确认是同一个账号。');
    if (active.has(course.id)) throw new Error('这门课程已经在运行。');
    if (active.size) throw new Error('先停止当前课程，再开始另一门。');
    if (environment.status !== 'ready') throw new Error('请等运行环境准备完成后再开始。');
    if (!config) throw new Error('请先选择免费答题，或在解题服务设置里保存 Key。');
    validateConfig(config);
    validateCourseURL(course.url);
    course.status = 'starting'; course.error = ''; course.phase = 'connecting';
    await persist();
    const child = launchController(process.execPath, [path.join(appDir, 'controller.mjs'), course.url, '--config', configFile, '--data-dir', dataDir, '--console', '--resume-billing'], { cwd: appDir, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const current = { id: course.id, child, stopped: false };
    active.set(course.id, current);
    let pendingLine = '';
    const output = chunk => {
      pendingLine += chunk.toString();
      const lines = pendingLine.split(/\r?\n/); pendingLine = lines.pop();
      for (const line of lines) if (line.trim()) log(line.trim(), course.id);
      pendingLine = pendingLine.slice(-4000);
    };
    child.stdout?.on('data', output); child.stderr?.on('data', output);
    child.on('message', message => {
      if (active.get(course.id) !== current) return;
      if (message?.type === 'error') { course.error = scrub(message.error); return; }
      if (message?.type !== 'state') return;
      const status = message.state;
      if (!status || String(status.courseId) !== course.id) return;
      const changed = course.phase !== status.phase || course.error !== scrub(status.error || '');
      for (const key of ['phase', 'completed', 'total', 'lockedUnits', 'currentTitle']) course[key] = status[key];
      if (message.title && !course.customName && course.nameSource !== 'catalog') course.name = scrub(message.title).slice(0, 120);
      course.error = scrub(status.error || '');
      if (changed) log(`任务 ${status.sourceId || ''}：${phases[course.phase] || course.phase}${course.error ? '；' + course.error : ''}`, course.id);
      if (!['stopping', 'pausing'].includes(course.status)) course.status = status.phase === 'complete' ? 'complete' : status.phase === 'paused' ? 'paused' : 'running';
      if (course.status === 'pausing' && !status.active) course.status = 'paused';
      persist().catch(error => log(error.message));
    });
    child.once('error', error => {
      course.error = scrub(error.message); course.status = 'error';
      if (active.get(course.id) === current) active.delete(course.id);
      queueRunning = active.size > 0;
      persist().catch(error => log(error.message));
    });
    child.once('exit', (code, signal) => {
      if (active.get(course.id) !== current) return;
      active.delete(course.id);
      queueRunning = active.size > 0;
      if (current.stopped) { course.status = 'stopped'; course.error = ''; }
      else if (course.phase === 'complete' && code === 0) course.status = 'complete';
      else { course.status = 'error'; course.error ||= `连接已中断，请检查 ${browserTypes[browserSettings.kind].name} 登录、调试开关和授权后重试。`; }
      if (signal) log('课程连接已结束，已完成进度保留。', course.id);
      persist().catch(error => log(error.message));
    });
    log('开始连接：' + course.name, course.id);
  }

  async function actionCourse(id, action) {
    const course = selected(id);
    const worker = active.get(course.id);
    if (action === 'focus') { if (!worker) throw new Error('这门课程当前没有连接。'); worker.child.send({ type: 'command', action: 'focus' }); return; }
    if (action === 'start') { queueRunning = false; return startCourse(course); }
    if (action === 'resume') {
      if (worker && course.status === 'paused') {
        course.status = 'running'; course.error = ''; worker.child.send({ type: 'command', action: 'resume' }); return persist();
      }
      queueRunning = false; return startCourse(course);
    }
    if (action === 'pause') {
      if (!worker || !['running', 'starting'].includes(course.status)) throw new Error('这门课程当前没有运行。');
      queueRunning = false; course.status = 'pausing'; worker.child.send({ type: 'command', action: 'pause' }); return persist();
    }
    if (action === 'stop') {
      queueRunning = false;
      if (worker) {
        worker.stopped = true; course.status = 'stopping';
        worker.child.send({ type: 'command', action: 'stop' });
      } else { course.status = 'stopped'; course.error = ''; }
      return persist();
    }
    if (action === 'remove') {
      if (worker) throw new Error('请先停止这门课程，再移除。');
      const submissionOrigins = [...new Set([...(browserSettings.submissionOrigins || []), new URL(course.url).origin])];
      const next = { ...browserSettings, submissionOrigins };
      await saveJSON(browserFile, next); browserSettings = next;
      courses.splice(courses.indexOf(course), 1); return persist();
    }
    throw new Error('不支持这个操作。');
  }

  async function requestBody(request) {
    let text = '';
    for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 16384) throw new Error('输入内容过长。'); }
    try { return JSON.parse(text || '{}'); } catch { throw new Error('输入格式不正确。'); }
  }

  function nextConfig(body) {
    const base = normalizeServiceURL(body.base_url ?? config?.base_url ?? defaults.base_url);
    if (config?.api_key && base !== normalizeServiceURL(config.base_url) && !body.api_key) throw new Error('更换 API 网址后，请粘贴新服务对应的完整 Key；程序不会把原 Key 发给其他服务。');
    const key = body.api_key || config?.api_key || '';
    const model = body.model || config?.model || defaults.model;
    const changed = base !== config?.base_url || key !== config?.api_key || model !== config?.model;
    return validateConfig({ ...defaults, ...config, answer_mode: body.answer_mode ?? config?.answer_mode ?? 'ai', base_url: base, api_key: key, model,
      budget: body.budget ?? config?.budget ?? defaults.budget,
      ...(changed ? { profile: undefined, image_profile: undefined, detection: undefined, service_status: 'unchecked', pricing: null } : {}) });
  }

  async function mutate(route, body) {
    if (route === '/api/browser-select') {
      if (!Object.hasOwn(browserTypes, body.kind)) throw new Error('请选择 Chrome、Edge 或 Firefox。');
      if (active.size || queueRunning) throw new Error('先停止课程并等待已发出的解题请求处理完，再切换浏览器。');
      if (checkin.state().running) throw new Error('签到正在执行，请稍后切换浏览器。');
      if (body.sameAccount !== true) throw new Error('请确认两个浏览器使用同一个课程账号。');
      if (body.kind === browserSettings.kind && !selectionRequired) return;
      const submissionURLs = [...courses.map(course => course.url), ...(browserSettings.submissionOrigins || [])];
      const manuallyConfirmed = body.submissionConfirmed === true && browserSession.state().status !== 'connected';
      // 未连接且尚未完成课程核对的新选择不能启动学习，允许直接改选。
      if (submissionURLs.length && !manuallyConfirmed && (!browserSettings.needsCourseRefresh || browserSession.state().status === 'connected')) await browserSession.assertSwitchable(submissionURLs);
      await checkin.changeBrowser();
      await browserSession.close();
      const next = { ...browserSettings, kind: body.kind, needsCourseRefresh: true };
      await saveJSON(browserFile, next); browserSettings = next; selectionRequired = false;
      if (manuallyConfirmed) log('已人工确认原浏览器停止学习及上次交卷结果；原浏览器交卷记录保留，未自动重放。');
      log(`已选择 ${browserTypes[body.kind].name}，请重新连接并核对账号及签到资料。`); return;
    }
    if (route === '/api/course-open') return browserSession.open('course', selected(body.id).url);
    if (route === '/api/browser-open') return browserSession.open(body.target);
    if (route === '/api/browser-connect') { await browserSession.get(); return; }
    if (route === '/api/browser-courses' || route === '/api/courses-import') {
      const items = route === '/api/browser-courses' ? await browserSession.courses() : await Promise.all(String(body.urls || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(value => browserSession.resolveCourse(value)));
      if (!items.length) throw new Error('请粘贴课程网址，每行一个。');
      let added = 0;
      for (const item of items) {
        const existing = courses.find(course => course.id === item.id);
        if (existing) { if (!existing.customName && item.name) { existing.name = item.name; existing.nameSource = 'catalog'; } continue; }
        courses.push({ ...item, name: item.name || `课程 ${item.id}`, customName: false, nameSource: item.name ? 'catalog' : 'url', status: 'ready', completed: 0, total: 0, error: '', phase: '', currentTitle: '', checkinEnabled: false }); added++;
      }
      await persist();
      if (route === '/api/browser-courses' && browserSettings.needsCourseRefresh) {
        const next = { ...browserSettings, needsCourseRefresh: false };
        await saveJSON(browserFile, next); browserSettings = next;
      }
      requestCheckin(); return { added };
    }
    if (route === '/api/checkin-config') { await checkin.configure(body); requestCheckin(); return; }
    if (route === '/api/checkin-test') return checkin.testBrowser(body.profileDirectory);
    if (route === '/api/checkin-open') return checkin.manual(body.ids);
    if (route === '/api/checkin-course') {
      const course = selected(body.id);
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('请选择是否加入每日签到。');
      const url = body.url === undefined ? course.checkinURL : checkinURL(body.url || course.url);
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 120);
        if (!name) throw new Error('课程名称不能为空。');
        course.name = name; course.customName = true;
      }
      if (body.enabled !== undefined) course.checkinEnabled = body.enabled;
      if (url !== undefined) course.checkinURL = url;
      await persist(); requestCheckin(); return;
    }
    if (route === '/api/config') {
      if (active.size) throw new Error('先停止正在运行的课程，再修改解题服务设置。');
      const next = nextConfig(body);
      await saveJSON(configFile, next); config = next; configError = '';
      Object.assign(connection, { status: 'untested', message: '设置已保存，可以测试连接' });
      log('解题服务设置已保存。'); return;
    }
    if (route === '/api/detect-save') {
      if (active.size) throw new Error('先停止正在运行的课程，再修改解题服务设置。');
      const settings = nextConfig({ ...body, answer_mode: 'ai' });
      Object.assign(connection, { status: 'testing', message: '正在筛选并检测少量候选模型，请稍等…' });
      try {
        const result = await detectService({ ...settings, model: body.model || '', dataDir, fetchImpl, force: body.force === true });
        const next = validateConfig({ ...settings, base_url: result.base_url, model: result.model, profile: result.profile, image_profile: result.image_profile,
          pricing: result.profile?.pricing || null, wire_api: result.profile?.wire_api || 'responses', reasoning_effort: result.profile?.reasoning_effort,
          service_status: result.status, detection: result });
        await saveJSON(configFile, next); config = next; configError = '';
        Object.assign(connection, { status: result.status === 'ready' ? 'ok' : 'error', message: result.message });
        log('解题服务检测完成。'); return { detection: result, connection };
      } catch (error) {
        Object.assign(connection, { status: 'error', message: scrub(error.message).replaceAll(settings.api_key, '[已隐藏]') });
        return { connection };
      }
    }
    if (route === '/api/test-connection') {
      const settings = nextConfig(body);
      if (settings.answer_mode === 'free') throw new Error('免费模式不使用解题服务，无需测试连接。');
      const tested = { status: 'testing', message: '正在测试连接' };
      const savedMatch = config && isDeepStrictEqual(settings, config);
      if (savedMatch) Object.assign(connection, tested);
      try {
        const base = new URL(settings.base_url.replace(/\/+$/, '') + '/');
        const response = await fetchImpl(new URL('models', base), { headers: { Authorization: `Bearer ${settings.api_key}` }, redirect: 'error', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Key 不可用，请检查后重新保存。' : response.status === 404 || response.status === 405 ? '服务商未提供连接检测接口；请核对接口地址。' : `服务商返回 HTTP ${response.status}，请稍后重试。`);
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) throw new Error('检测结果过长。');
        let models;
        try { models = JSON.parse(text).data; } catch { throw new Error('接口返回格式不正确，请核对地址。'); }
        if (!Array.isArray(models)) throw new Error('服务商未返回模型列表，请核对接口地址。');
        Object.assign(tested, { status: 'listed', message: '已读取模型列表，尚未验证调用能力。请点击「检测并保存」，程序会自动筛选和测试模型。' });
      } catch (error) { Object.assign(tested, { status: 'error', message: scrub(error.message).replaceAll(settings.api_key, '[已隐藏]') }); }
      if (savedMatch) Object.assign(connection, tested);
      return { connection: tested };
    }
    if (route === '/api/environment') { prepareEnvironment(); return; }
    if (route === '/api/courses') {
      const url = courseFromURL(validateCourseURL(body.url)).url; const id = new URL(url).hash.replace(/^#\/?/, '').split('/')[0];
      if (courses.some(course => course.id === id)) throw new Error('这门课程已经在列表里了。');
      const name = String(body.name || '').trim().slice(0, 120);
      courses.push({ id, url, name: name || `课程 ${courses.length + 1}`, customName: Boolean(name), status: 'ready', completed: 0, total: 0, error: '', phase: '', currentTitle: '', checkinEnabled: body.checkinEnabled === true });
      await persist(); log('已添加课程。', id); requestCheckin(); return;
    }
    if (route === '/api/course-action') return actionCourse(body.id, body.action);
    if (route === '/api/queue') {
      const targets = body.ids === undefined ? courses : (() => {
        if (!Array.isArray(body.ids)) throw new Error('请选择课程。');
        return [...new Set(body.ids.map(String))].map(selected);
      })();
      if (body.action === 'start') {
        if (targets.filter(course => course.status !== 'complete').length > 1) throw new Error('一次只运行一门课，请点课程旁的「开始」。');
        if (!config) throw new Error('先保存你的解题服务 Key。');
        if (environment.status !== 'ready') throw new Error('请等运行环境准备完成。');
        for (const course of targets) {
          if (course.status === 'complete') continue;
          if (active.has(course.id)) { if (course.status === 'paused') await actionCourse(course.id, 'resume'); continue; }
          await startCourse(course);
        }
        queueRunning = active.size > 0; return;
      }
      if (['pause', 'stop'].includes(body.action)) {
        for (const course of targets) if (active.has(course.id) && (body.action === 'stop' || ['running', 'starting'].includes(course.status))) await actionCourse(course.id, body.action);
        queueRunning = false; await persist(); return;
      }
    }
    if (route === '/api/shutdown') { setImmediate(() => close()); return; }
    throw new Error('找不到这个操作。');
  }

  const assets = { '/': ['console.html', 'text/html; charset=utf-8'], '/console.css': ['console.css', 'text/css; charset=utf-8'], '/console.js': ['console.js', 'text/javascript; charset=utf-8'], '/user-guidance.mjs': ['user-guidance.mjs', 'text/javascript; charset=utf-8'] };
  function json(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (request.headers.host !== origin.slice(7)) { json(response, 403, { error: '请从启动入口打开控制台。' }); return; }
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === token) {
        response.writeHead(303, { Location: '/', 'Set-Cookie': `szu_session=${token}; HttpOnly; SameSite=Strict; Path=/` }); response.end(); return;
      }
      const authenticated = (request.headers.cookie || '').split(';').some(cookie => cookie.trim() === `szu_session=${token}`);
      if (!authenticated) { json(response, 401, { error: '控制台会话已过期，请重新双击启动。' }); return; }
      if (request.method === 'GET' && url.pathname === '/api/state') { json(response, 200, await state()); return; }
      if (request.method === 'GET' && url.pathname === '/api/browsers') { json(response, 200, { browsers: await listBrowsers() }); return; }
      if (request.method === 'GET' && url.pathname === '/api/checkin-profiles') {
        const browser = await checkin.profiles(); json(response, 200, { available: browser.available, profiles: browser.profiles, error: browser.error }); return;
      }
      if (request.method === 'GET' && url.pathname === '/szu-uooc.user.js') {
        response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Disposition': 'inline; filename="szu-uooc.user.js"' });
        response.end(await fs.readFile(path.join(appDir, 'szu-uooc.user.js'))); return;
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (request.headers.origin !== origin || request.headers['x-szu-token'] !== csrf || !request.headers['content-type']?.startsWith('application/json')) { json(response, 403, { error: '操作来源无效，请刷新控制台重试。' }); return; }
        const body = await requestBody(request);
        if (url.pathname === '/api/diagnostics') {
          if (exportingDiagnostics) { json(response, 429, { error: '诊断包正在生成，请稍后重试。' }); return; }
          exportingDiagnostics = true;
          try {
            const zip = await diagnosticZip({ appDir, dataDir, courses: structuredClone(courses), logs: structuredClone(logs), browser: browserSession.state(), environment: { ...environment }, config: { ...config }, connection: { ...connection }, secrets: [token, csrf] });
            response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="ShenYiShua-diagnostics-${new Date().toISOString().replace(/[:.]/g,'-')}.zip"` }); response.end(zip);
          } finally { exportingDiagnostics = false; }
          return;
        }
        const call = mutations.then(() => mutate(url.pathname, body)); mutations = call.catch(() => {});
        const result = await call; json(response, 200, { ok: true, ...result }); return;
      }
      if (request.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname]; response.writeHead(200, { 'Content-Type': type }); response.end(await fs.readFile(path.join(appDir, 'student', file))); return;
      }
      json(response, 404, { error: '找不到这个页面。' });
    } catch (error) { json(response, 400, { error: scrub(error.message), ...(error.requiresSubmissionConfirmation === true ? { requiresSubmissionConfirmation: true } : {}) }); }
  });
  let port = 0;
  try {
    const previous = new URL((await readJSON(path.join(dataDir, 'console-address.json'), null))?.url);
    if (previous.protocol === 'http:' && previous.hostname === '127.0.0.1' && !previous.username && !previous.password
      && previous.pathname === '/' && !previous.hash && Number(previous.port) >= 1024 && Number(previous.port) <= 65535) port = Number(previous.port);
  } catch { /* Missing or damaged launch metadata must not prevent startup. */ }
  await new Promise((resolve, reject) => {
    const ready = () => { server.removeListener('error', failed); resolve(); };
    const failed = error => {
      if (port && error.code === 'EADDRINUSE') { port = 0; server.listen(port, '127.0.0.1'); }
      else { server.removeListener('listening', ready); server.removeListener('error', failed); reject(error); }
    };
    server.on('error', failed); server.once('listening', ready); server.listen(port, '127.0.0.1');
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  async function close() {
    if (shuttingDown) return;
    shuttingDown = true; queueRunning = false;
    await checkin.close();
    dependencyChild?.kill();
    await Promise.all([...active.values()].map(async ({ id, child }) => {
      const exited = new Promise(resolve => {
        const timeout = setTimeout(() => { child.kill(); resolve(); }, 135000); timeout.unref();
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
      await actionCourse(id, 'stop').catch(() => {}); await exited;
    }));
    await browserSession.close();
    await savedQueue;
    await savedLog;
    await new Promise(resolve => server.close(resolve));
  }
  await persist();
  checkin.start().catch(error => log(error.message));
  prepareEnvironment();
  return { url: `${origin}/?token=${token}`, origin, server, close, state, checkin };
}
