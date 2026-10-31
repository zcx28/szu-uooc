import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJSON, saveJSON } from './settings.mjs';
import { checkinURL, discoverChrome, networkAvailable, openCheckinPages, notifyCheckin } from './checkin-browser.mjs';
import { setAutostart } from './autostart.mjs';

const retryMs = 5 * 60 * 1000;
const defaults = { enabled: false, mode: 'startup', time: '22:00', autostart: false, scriptReady: false, browser: null, requiresConfirmation: false };
export function beijingClock(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export async function createCheckin({ dataDir, appDir, getCourses, getBrowserKind = () => 'chrome', now = () => new Date(), openPages = openCheckinPages, isOnline = networkAvailable, discoverBrowser = discoverChrome, autostart = setAutostart, notify = notifyCheckin, log = () => {}, autoTick = true } = {}) {
  const configFile = path.join(dataDir, 'checkin.json');
  const recordFile = path.join(dataDir, 'checkin-history.json');
  let settings = structuredClone(defaults), history = {}, error = '', tail = Promise.resolve(), running = false, closed = false, timer, lastBatch = null, testedProfile;
  const startup = enabled => autostart(enabled, { dataDir, script: path.join(appDir, 'student/start.mjs') });
  try {
    settings = { ...defaults, ...await readJSON(configFile, {}) };
    validateSettings(settings);
    const saved = await readJSON(recordFile, { history: {} });
    if (!saved.history || typeof saved.history !== 'object' || Array.isArray(saved.history)) throw new Error('签到记录格式异常');
    history = saved.history;
    for (const entries of Object.values(history)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('签到记录格式异常');
      for (const record of Object.values(entries)) {
        if (!record || !['opening', 'opened', 'failed', 'uncertain'].includes(record.status)) throw new Error('签到记录格式异常');
        // A crash after dispatch cannot be distinguished from a crash before dispatch.
        // Preserve daily deduplication and require explicit manual recovery instead.
        if (record.status === 'opening') { record.status = 'uncertain'; record.error = '上次打开过程被中断，请查看浏览器后手动补开。'; }
      }
    }
    if (saved.version !== 2 && settings.browser) for (const entries of Object.values(history)) for (const course of getCourses()) {
      const oldKey = createHash('sha256').update([course.id, checkinURL(course.checkinURL || course.url), settings.browser.userDataDir || '', settings.browser.profileDirectory || ''].join('\0')).digest('hex');
      const prior = entries[oldKey];
      if (prior && !entries[key(course)]) entries[key(course)] = prior;
    }
    if (Object.keys(history).length) await persist();
  } catch (cause) { error = '签到配置或记录不可读，自动签到已暂停：' + cause.message; log(error); }

  function validateSettings(value) {
    for (const key of ['enabled', 'autostart', 'scriptReady']) if (typeof value[key] !== 'boolean') throw new Error('签到开关格式无效。');
    if (!['startup', 'scheduled'].includes(value.mode) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('请选择运行模式，并填写有效的每日时间。');
    if (value.enabled && (!value.scriptReady || !value.browser?.profileDirectory)) throw new Error('请先选择浏览器资料，并确认已更新或暂停旧版自动学习脚本。');
  }
  function key(course) {
    return createHash('sha256').update([course.id, checkinURL(course.checkinURL || course.url)].join('\0')).digest('hex');
  }
  async function persist() { await saveJSON(recordFile, { version: 2, history }); }
  function serialize(fn) { const call = tail.then(fn); tail = call.catch(() => {}); return call; }
  function entry(course, date = beijingClock(now()).date) { return history[date]?.[key(course)]; }
  function courseState(course) {
    const record = entry(course);
    const labels = { opened: '今日已打开', failed: '待重试', opening: '正在打开', uncertain: '请手动确认' };
    return { enabled: Boolean(course.checkinEnabled), url: course.checkinURL || course.url, status: record?.status || 'pending', label: labels[record?.status] || (course.checkinEnabled ? '今日待打开' : '未加入签到'), error: record?.error || '' };
  }
  function state() {
    const clock = beijingClock(now());
    const courses = getCourses().filter(course => course.checkinEnabled);
    const counts = { total: courses.length, opened: 0, failed: 0, uncertain: 0 };
    for (const course of courses) { const status = entry(course, clock.date)?.status; if (status in counts) counts[status]++; }
    const waiting = settings.mode === 'scheduled' && clock.time < settings.time;
    return { settings: { ...settings, browser: settings.browser ? { kind: settings.browser.kind || 'chrome', profileDirectory: settings.browser.profileDirectory } : null }, date: clock.date, counts, running, error, lastBatch,
      message: error || (!settings.enabled ? '自动签到未开启' : !counts.total ? '请在课程列表勾选每日签到' : counts.opened === counts.total ? '今日所选课程已打开' : waiting ? `等待北京时间 ${settings.time}` : settings.mode === 'scheduled' ? '今日已到设定时间，补开尚未执行的课程' : '启动后立即打开，当天不重复') };
  }

  async function run(ids, force = false) {
    if (closed || error) { if (error && force) throw new Error(error); return; }
    if (!force && !settings.enabled) return;
    if (!settings.scriptReady || !settings.browser) { if (force) throw new Error('请先保存签到设置并确认浏览器资料和脚本。'); return; }
    if ((settings.browser.kind || 'chrome') !== getBrowserKind() || settings.requiresConfirmation) { if (force) throw new Error('请重新测试所选浏览器资料并确认账号。'); return; }
    const start = now(), clock = beijingClock(start);
    if (!force && settings.mode === 'scheduled' && clock.time < settings.time) return;
    const courses = getCourses().filter(course => ids ? ids.includes(String(course.id)) : course.checkinEnabled).filter(course => {
      const record = entry(course, clock.date);
      return force || !record || record.status === 'failed' && Number(record.nextAttemptAt || 0) <= start.getTime();
    });
    if (!courses.length) return;
    running = true;
    try {
      // Snapshot URL and record key together; edits during a network check affect the next batch.
      const targets = courses.map(course => ({ course, key: key(course), url: checkinURL(course.checkinURL || course.url, true) }));
      history[clock.date] ||= {};
      const today = history[clock.date];
      const hosts = [...new Set(targets.map(target => new URL(target.url).hostname))];
      const online = new Map(await Promise.all(hosts.map(async host => [host, await isOnline(host).catch(() => false)])));
      const ready = [];
      for (const target of targets) {
        if (!online.get(new URL(target.url).hostname)) {
          if (today[target.key]?.status !== 'opened') today[target.key] = { status: 'failed', nextAttemptAt: start.getTime() + retryMs, error: '当前无法连接课程网站，5 分钟后重试。' };
        } else {
          if (today[target.key]?.status !== 'opened') today[target.key] = { status: 'opening', attemptedAt: start.toISOString() };
          ready.push(target);
        }
      }
      await persist(); // Claims are durable before any external browser command.
      let results = [];
      if (ready.length) {
        try { results = await openPages(ready.map(target => target.url), settings.browser); }
        catch (cause) { results = ready.map(target => ({ url: target.url, ok: false, error: cause.message })); }
      }
      let opened = 0;
      for (let i = 0; i < ready.length; i++) {
        const target = ready[i], result = results[i];
        if (result?.ok && result.url === target.url) {
          today[target.key] = { status: 'opened', openedAt: now().toISOString() }; opened++;
        } else if (today[target.key]?.status !== 'opened') {
          today[target.key] = { status: 'failed', nextAttemptAt: now().getTime() + retryMs, error: String(result?.error || '浏览器未接受打开命令。').slice(0, 300) };
        }
      }
      // Keep the latest 30 dates, including earlier dates if the computer clock moves back.
      for (const date of Object.keys(history).sort().slice(0, -30)) delete history[date];
      await persist();
      lastBatch = { at: now().toISOString(), opened, failed: targets.length - opened };
      const message = `签到页面：已请求打开 ${opened} 门${lastBatch.failed ? `，${lastBatch.failed} 门未打开` : ''}。平台记录请自行核对。`;
      log(message); if (opened || force) { try { notify(message); } catch {} }
    } catch (cause) { error = '签到记录保存失败，自动签到已暂停：' + cause.message; log(error); throw cause; }
    finally { running = false; }
  }

  async function configure(body) {
    return serialize(async () => {
      if (closed || error) throw new Error(error || '控制台已关闭。');
      const next = { ...settings, enabled: body.enabled, mode: body.mode, time: body.time, autostart: body.autostart, scriptReady: body.scriptReady };
      const browser = await discoverBrowser({ kind: getBrowserKind() });
      const profile = browser.profiles?.find(profile => profile.directory === body.profileDirectory);
      next.browser = profile && browser.available ? { kind: getBrowserKind(), executable: browser.executable, userDataDir: browser.userDataDir, profileDirectory: profile.directory } : null;
      if (settings.requiresConfirmation && next.enabled) {
        if (testedProfile !== JSON.stringify(next.browser)) throw new Error('请先测试打开所选浏览器资料。');
        if (body.accountConfirmed !== true) throw new Error('请确认浏览器中是同一个课程账号。');
        next.requiresConfirmation = false;
      }
      validateSettings(next);
      if (next.enabled && !profile) throw new Error(browser.error || '请选择当前浏览器中的用户资料。');
      await startup(next.autostart);
      try { await saveJSON(configFile, next); }
      catch (cause) { await startup(settings.autostart).catch(() => {}); throw cause; }
      settings = next;
      log('签到设置已保存。' + (next.autostart ? '下次登录电脑会自动启动，请保留程序文件夹。' : '开机自启动已关闭。'));
    });
  }
  function tick() { return serialize(() => run()); }
  function start() {
    if (autoTick && !timer) { timer = setInterval(() => tick().catch(() => {}), 30000); timer.unref(); }
    return tick();
  }
  async function manual(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !getCourses().some(course => String(course.id) === String(id)))) throw new Error('请选择要补开的课程。');
    return serialize(() => run(ids.map(String), true));
  }
  async function testBrowser(profileDirectory) {
    const browser = await discoverBrowser({ kind: getBrowserKind() });
    if (!browser.available || !browser.profiles.some(profile => profile.directory === profileDirectory)) throw new Error(browser.error || '请选择浏览器资料。');
    const results = await openPages(['https://www.uooc.net.cn/'], { kind: getBrowserKind(), executable: browser.executable, userDataDir: browser.userDataDir, profileDirectory });
    if (!results?.[0]?.ok) throw new Error(results?.[0]?.error || '浏览器打开命令失败。');
    testedProfile = JSON.stringify({ kind: getBrowserKind(), executable: browser.executable, userDataDir: browser.userDataDir, profileDirectory });
    log('已请求用所选浏览器资料打开 UOOC，请自行确认账号。');
  }
  function changeBrowser() {
    if (running) throw new Error('签到正在执行，请稍后切换浏览器。');
    return serialize(async () => {
      if (closed || error) throw new Error(error || '控制台已关闭。');
      const next = { ...settings, enabled: false, browser: null, requiresConfirmation: true };
      await saveJSON(configFile, next); settings = next; testedProfile = undefined;
    });
  }
  async function close() { closed = true; clearInterval(timer); await tail; }
  return { state, courseState, configure, tick, start, manual, testBrowser, changeBrowser, profiles: discoverBrowser, close };
}
