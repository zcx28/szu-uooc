import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { allowedHost } from '../browser-bridge.mjs';
import { runController } from '../controller.mjs';
import { connectOriginalChrome } from '../chrome-connection.mjs';
import { validateCourseURL } from './settings.mjs';
import { discoverChrome, openCheckinPages, checkinURL, activateChromeProcess, browserTypes, importFirefoxSession } from './checkin-browser.mjs';

export function courseFromURL(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请复制课程的完整网址。'); }
  if (url.protocol !== 'https:' || !allowedHost(url.hostname) || url.username || url.password || url.port && url.port !== '443') throw new Error('请使用 UOOC 课程网址。');
  const learning = /^\/home\/learn\//.test(url.pathname);
  const home = /^\/home\/course\//.test(url.pathname);
  const id = url.hash.match(/^#\/?(\d+)(?:\/|$)/)?.[1] || (home ? url.pathname.match(/\/(\d+)\/?$/)?.[1] : null);
  if ((!learning && !home) || !id) throw new Error('打开课程，点击「进入学习」，再复制地址栏完整网址。');
  url.searchParams.delete('szu_checkin');
  if (learning) validateCourseURL(url.href);
  if (/^\/home\/learn\/new\//.test(url.pathname)) url.pathname = '/home/learn/index';
  return { id, url: url.href, learning };
}

export async function resolveDebugEndpoint(browserInfo) {
  const override = process.env.SZU_UOOC_CDP_ENDPOINT;
  if (override) {
    const url = new URL(override);
    if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('浏览器连接只能使用本机地址。');
    return override;
  }
  // Modern Chrome remote-debugging consent uses the channel endpoint, not a
  // stale UUID route left in DevToolsActivePort by an older browser launch.
  return browserInfo?.kind || 'chrome';
}

export function createBrowserSession({ appDir, dataDir, connectBrowser, discoverBrowser = discoverChrome, openPages = openCheckinPages, observeCatalog = async () => {}, observeCourse, requestFetch, verify, getBrowserKind = () => 'chrome', activateBrowser = activateChromeProcess, log = () => {} } = {}) {
  let browser, connecting;
  const workers = new Set();
  const name = () => browserTypes[getBrowserKind()]?.name || '浏览器';
  const catalogPage = context => context.pages().find(page => {
    try { const url = new URL(page.url()); return url.protocol === 'https:' && allowedHost(url.hostname) && /^\/home\/index\/?$/.test(url.pathname); }
    catch { return false; }
  });
  const status = { status: 'idle', message: '', catalog: 'idle', error: '' };
  async function get() {
    if (browser?.isConnected()) return browser;
    if (connecting) return connecting;
    status.status = 'connecting'; status.message = getBrowserKind() === 'firefox' ? '正在打开 Firefox 自动化窗口' : `在 ${name()} 中允许连接`; status.error = '';
    connecting = (async () => {
      if (connectBrowser) browser = await connectBrowser();
      else if (getBrowserKind() === 'firefox') {
        // Firefox has no CDP attach (unlike Chrome/Edge). Launch Playwright's bundled
        // Firefox with a dedicated profile. Import course cookies only on its first
        // launch; never copy a personal database or overwrite saved course state.
        const require = createRequire(path.join(appDir, 'package.json'));
        const { firefox } = require('playwright');
        const dest = path.join(dataDir, 'firefox-profile');
        const info = await discoverBrowser({ kind: 'firefox' });
        const profileDirectory = info.lastUsedProfile || info.profiles[0]?.directory;
        const cookies = profileDirectory ? await importFirefoxSession(info.userDataDir, dest, profileDirectory) : [];
        const context = await firefox.launchPersistentContext(dest, {
          headless: false,
          viewport: null,
          firefoxUserPrefs: { 'dom.webdriver.enabled': false },
        });
        await context.addInitScript(() => {
          try { delete Object.getPrototypeOf(navigator).webdriver; } catch {}
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        if (cookies.length) await context.addCookies(cookies);
        const home = catalogPage(context) || context.pages().find(page => page.url() === 'about:blank') || await context.newPage();
        try {
          await home.goto('https://www.uooc.net.cn/home/index', { waitUntil: 'domcontentloaded', timeout: 45000 });
          await home.bringToFront();
        } catch (error) {
          log('Firefox 打开优课网失败：' + String(error.message).slice(0, 240));
        }
        let closed = false;
        context.once('close', () => { closed = true; });
        browser = {
          contexts: () => closed ? [] : [context],
          isConnected: () => !closed,
          close: async () => { if (!closed) { closed = true; await context.close().catch(() => {}); } },
          once: (event, listener) => { if (event === 'disconnected') context.once('close', listener); },
        };
      }
      else {
        const require = createRequire(path.join(appDir, 'package.json'));
        const { chromium } = require('playwright');
        const info = await discoverBrowser({ kind: getBrowserKind() });
        browser = await connectOriginalChrome(chromium, await resolveDebugEndpoint(info), info);
      }
      status.status = 'connected'; status.message = `${name()} 已连接`;
      const connected = browser;
      connected.once('disconnected', () => { if (browser !== connected) return; browser = null; status.status = 'idle'; status.message = `${name()} 已断开`; });
      return browser;
    })().catch(error => { log(`${name()} 连接错误：` + String(error.message).replace(/(?:ws|https?):\/\/[^\s<>]+/g, '[连接地址]').slice(0, 800)); status.status = 'error'; status.error = `${name()} 连接未完成。检查调试开关，允许连接后重试。`; throw new Error(status.error); }).finally(() => { connecting = null; });
    return connecting;
  }
  async function open(kind, courseURL) {
    if (!['site', 'course'].includes(kind)) throw new Error(`请复制 ${browserTypes[getBrowserKind()]?.debugURL}，在 ${name()} 地址栏粘贴并回车。`);
    if (kind === 'course') {
      const target = courseFromURL(courseURL).url;
      const session = await get(), context = session.contexts()[0];
      if (!context) throw new Error(`没有找到已登录的 ${name()} 窗口。`);
      const page = await context.newPage();
      try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
      catch (error) { await page.close().catch(() => {}); throw error; }
      return;
    }
    const target = 'https://www.uooc.net.cn/home/index';
    // Prefer the already-connected window (Edge/Chrome CDP or Firefox automation).
    // Spawning a second process with the same profile forces a new login.
    if (getBrowserKind() === 'firefox' || browser?.isConnected()) {
      const session = await get(), context = session.contexts()[0];
      if (!context) throw new Error(`没有找到已登录的 ${name()} 窗口。`);
      const page = catalogPage(context) || await context.newPage();
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.bringToFront();
      return;
    }
    const info = await discoverBrowser({ kind: getBrowserKind() });
    if (!info.available) throw new Error(info.error);
    const profileDirectory = info.lastUsedProfile || info.profiles[0]?.directory;
    const results = await openPages([target], { ...info, profileDirectory });
    if (!results[0]?.ok) throw new Error(results[0]?.error || `${name()} 没有打开。`);
  }
  async function resolveCourse(value, name = '') {
    const item = courseFromURL(value);
    if (item.learning) return { id: item.id, url: item.url, name };
    const session = await get(), context = session.contexts()[0];
    const page = await context.newPage();
    try {
      await page.goto(checkinURL(item.url, true), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => [...document.querySelectorAll('a[href]')].some(a => a.href.includes('/home/learn/')), null, { timeout: 10000 }).catch(() => {});
      let href = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href).find(href => href.includes('/home/learn/')));
      if (!href) {
        const entry = page.getByText(/^(进入学习|继续学习|开始学习)$/).filter({ visible: true });
        if (await entry.count() === 1) {
          await entry.click();
          await page.waitForURL('**/home/learn/**', { timeout: 10000 }).catch(() => {});
          if (page.url().includes('/home/learn/')) href = page.url();
        }
      }
      if (!href) throw new Error('这门课没有读取到学习入口。点击「进入学习」后复制网址。');
      const resolved = courseFromURL(href);
      if (!resolved.learning || resolved.id !== item.id) throw new Error('课程入口不匹配，请复制该课学习页网址。');
      return { id: item.id, url: resolved.url, name: name || await page.title() };
    } finally { await page.close(); }
  }
  async function courses() {
    status.catalog = 'loading'; status.error = '';
    try {
      const session = await get(), context = session.contexts()[0];
      let page = catalogPage(context);
      if (!page) {
        const existing = context.pages().find(p => { try { return allowedHost(new URL(p.url()).hostname); } catch { return false; } });
        page = await context.newPage();
        await page.goto(new URL('/home/index', existing?.url() || 'https://www.uooc.net.cn/').href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.bringToFront();
      }
      if (/\/user\/login|\/passport\/login/.test(page.url())) throw new Error(`请先在当前 ${name()} 窗口登录优课网，登录完成后不要关窗口，再点「读取课程」。`);
      await page.waitForFunction(() => document.querySelector('a[href*="/home/course/"],a[href*="/home/learn/"],[ng-repeat*="course"],[ng-repeat*="Course"]'), null, { timeout: 15000 }).catch(() => {});
      await observeCatalog(page);
      const found = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('a[href]')].filter(a => {
          const target = new URL(a.href);
          return /\/home\/(course|learn)\//.test(target.pathname) && !/^#\/(homework|test)(?:\/|$)/.test(target.hash);
        }).map(a => {
          const title = a.closest('.course-info')?.querySelector('.course-name') || a;
          const copy = title.cloneNode(true); copy.querySelectorAll('.course-cycle-name').forEach(node => node.remove());
          return { url: a.href, name: (copy.textContent || title.getAttribute('title') || '').trim() };
        });
        if (window.angular && !rows.length) for (const node of document.querySelectorAll('[ng-repeat]')) {
          const expression = node.getAttribute('ng-repeat') || '', variable = expression.match(/^\s*([\w$]+)\s+in\s+.*course/i)?.[1];
          if (!variable) continue;
          try {
            const item = window.angular.element(node).scope()?.[variable];
            const id = item?.courseId ?? item?.course_id ?? item?.id;
            const name = item?.courseName ?? item?.course_name ?? item?.name;
            if (!/^\d+$/.test(String(id)) || typeof name !== 'string') continue;
            rows.push({ url: item.learnUrl || item.learn_url || item.url || item.href || `${location.origin}/home/course/index#/${id}`, name });
          } catch {}
        }
        return rows;
      });
      const unique = new Map();
      for (const row of found) {
        try { const item = courseFromURL(row.url); if (!unique.has(item.id) || item.learning) unique.set(item.id, { ...item, name: row.name.slice(0, 120) }); } catch {}
      }
      if (!unique.size) throw new Error(`请在 ${name()} 登录并打开「我的课程」，再读取。`);
      const resolved = [];
      for (const item of unique.values()) resolved.push(await resolveCourse(item.url, item.name));
      status.catalog = 'ready'; return resolved;
    } catch (error) { status.catalog = 'error'; status.error = error.message; throw error; }
  }
  function spawnWorker(_node, args) {
    const child = new EventEmitter(), commands = new EventEmitter(); let pending = '', page, owned = false, stopTimer; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.send = message => {
      pending = message.action; commands.emit('message', message);
      // Only an app-owned tab may be closed to release a blocked renderer.
      if (message.action === 'stop' && !stopTimer) { stopTimer = setTimeout(() => { if (owned && page) page.close().catch(() => {}); }, 2000); stopTimer.unref(); }
    }; child.kill = () => child.send({ type: 'command', action: 'stop' });
    Promise.resolve().then(async () => {
      const course = courseFromURL(args[1]), session = await get(), context = session.contexts()[0];
      if (pending === 'stop') return;
      if (!context) throw new Error(`没有找到已登录的 ${name()} 窗口。`);
      const candidates = [];
      for (const candidate of context.pages()) {
        try {
          const current = courseFromURL(candidate.url());
          if (current.learning && current.id === course.id && new URL(candidate.url()).searchParams.get('szu_checkin') !== '1' && !await candidate.evaluate(() => sessionStorage.getItem('szu-uooc:checkin-tab') === '1')) candidates.push(candidate);
        } catch {}
      }
      if (candidates.length === 1) page = candidates[0];
      else { page = await context.newPage(); owned = true; workers.add(page); }
      try {
        const learning = courseFromURL(owned ? course.url : page.url()).url;
        const workerArgs = args.slice(1); workerArgs[0] = learning;
        if (owned || page.url() !== learning) await page.goto(learning, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await runController({ args: workerArgs, browser: session, page, commands, initialCommand: pending, observePage: observeCourse, fetchAPI: requestFetch, verify,
          focusBrowser: async () => {
            if (process.platform !== 'darwin' || getBrowserKind() === 'firefox') return;
            const control = await session.newBrowserCDPSession();
            try { const { processInfo } = await control.send('SystemInfo.getProcessInfo'); await activateBrowser(processInfo.find(item => item.type === 'browser')?.id); }
            finally { await control.detach(); }
          },
          onState: message => child.emit('message', message), log: message => child.stdout.write(String(message) + '\n'),
        });
      } finally {
        clearTimeout(stopTimer);
        if (owned && page) { workers.delete(page); await page.close().catch(() => {}); }
      }
    }).then(() => child.emit('exit', 0, null), error => { child.stderr.write(error.message + '\n'); child.emit('message', { type: 'error', error: error.message }); child.emit('exit', 1, null); });
    return child;
  }
  async function assertSwitchable(courseURLs = []) {
    if (!browser?.isConnected()) {
      if (status.status === 'connected') status.status = 'idle';
      throw Object.assign(new Error(`暂时无法连接 ${name()} 自动核对上次测验。请先在课程网站核对测验结果，并停止原浏览器的学习，再勾选下方确认后切换；也可以重新连接 ${name()} 后重试。`), { requiresSubmissionConfirmation: true });
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error('请先连接原浏览器，核对交卷结果后再切换。');
    let timer, cancelled = false;
    const inspect = async () => {
      const pages = context.pages().filter(page => { try { const url = new URL(page.url()); return url.protocol === 'https:' && allowedHost(url.hostname); } catch { return false; } });
      const origins = new Set([...courseURLs.map(value => {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !allowedHost(url.hostname) || url.username || url.password || url.port && url.port !== '443') throw new Error('交卷检查仅允许 UOOC 的 HTTPS 网站。');
        return url.origin;
      }), ...pages.map(page => new URL(page.url()).origin)]);
      if (!origins.size) origins.add('https://www.uooc.net.cn');
      for (const origin of origins) {
        if (cancelled) return;
        let page = pages.find(page => new URL(page.url()).origin === origin), owned;
        try {
          if (!page) {
            page = owned = await context.newPage();
            await page.goto(origin + '/home/index', { waitUntil: 'domcontentloaded', timeout: 15000 });
          }
          if (cancelled) return;
          const pending = await page.evaluate(expectedOrigin => {
            if (location.origin !== expectedOrigin) throw new Error('请在原浏览器登录并核对交卷结果。');
            const pending = [];
            for (const key of Object.keys(localStorage).filter(key => key.startsWith('szu-uooc:course-state:'))) {
              let saved;
              try { saved = JSON.parse(localStorage.getItem(key)); }
              catch { throw new Error('原浏览器的交卷记录不可读，请先核对后重试。'); }
              if (saved?.pendingSubmit) pending.push(key.slice('szu-uooc:course-state:'.length));
            }
            return pending;
          }, origin);
          if (pending.length) throw new Error(`交卷结果尚未确认（课程 ${pending.join('、')}），请回原浏览器继续核对后再切换。`);
        } finally { if (owned) await owned.close().catch(() => {}); }
      }
    };
    try { await Promise.race([inspect(), new Promise((_, reject) => { timer = setTimeout(() => { cancelled = true; reject(new Error('交卷状态检查超时，请回原浏览器核对后重试。')); }, 20000); })]); }
    finally { clearTimeout(timer); }
  }
  async function close() {
    await Promise.allSettled([...workers].map(page => page.close()));
    if (connecting) await connecting.catch(() => {});
    const previous = browser; browser = null;
    if (previous) await previous.close();
    Object.assign(status, { status: 'idle', catalog: 'idle', message: '', error: '' });
  }
  return { get, open, courses, resolveCourse, spawnWorker, assertSwitchable, state: () => ({ ...status, kind: getBrowserKind(), ...browserTypes[getBrowserKind()] }), close };
}
