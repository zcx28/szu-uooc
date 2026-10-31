import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { allowedHost } from '../browser-bridge.mjs';
import { firefoxProfiles, firefoxProfilePath } from './firefox-session.mjs';
export { importFirefoxSession, firefoxCookiesFromProfile } from './firefox-session.mjs';

export const checkinMarker = 'szu_checkin';
export const browserTypes = {
  chrome: { name: 'Chrome', debugURL: 'chrome://inspect/#remote-debugging' },
  edge: { name: 'Edge', debugURL: 'edge://inspect/#remote-debugging' },
  firefox: { name: 'Firefox', debugURL: 'about:debugging' },
};

export async function activateChromeProcess(pid, { platform = process.platform, execFileImpl = execFile } = {}) {
  if (platform !== 'darwin') return;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('课程浏览器进程无效。');
  const script = 'function run(args) { ObjC.import("AppKit"); var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0])); if (!app.activateWithOptions($.NSApplicationActivateAllWindows)) throw new Error("Course browser activation failed"); }';
  await new Promise((resolve, reject) => execFileImpl('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, String(pid)], { timeout: 5000 }, error => error ? reject(new Error('课程窗口未能激活，请从所选浏览器窗口中选择该课程。')) : resolve()));
}
export function checkinURL(value, marked = false) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请填写完整的签到课程网址。'); }
  if (url.protocol !== 'https:' || !allowedHost(url.hostname) || url.port && url.port !== '443' || url.username || url.password || !/^\/home\/(learn|course)\//.test(url.pathname)) {
    throw new Error('签到网址需要是 UOOC 的 HTTPS 课程主页或学习页。');
  }
  url.searchParams.delete(checkinMarker);
  if (marked) url.searchParams.set(checkinMarker, '1');
  return url.href;
}

export async function discoverBrowser({ kind = 'chrome', platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (!Object.hasOwn(browserTypes, kind)) throw new Error('请选择 Chrome、Edge 或 Firefox。');
  const info = { kind, ...browserTypes[kind], installed: false, available: false, profiles: [] };
  const app = kind === 'edge' ? 'Microsoft Edge' : kind === 'firefox' ? 'Firefox' : 'Google Chrome';
  const folder = kind === 'edge' ? 'Microsoft/Edge' : 'Google/Chrome';
  const binary = kind === 'edge' ? 'msedge.exe' : 'chrome.exe';
  let candidates, userDataDir;
  if (kind === 'firefox') {
    if (platform === 'win32') {
      candidates = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean).map(root => path.join(root, 'Mozilla Firefox/firefox.exe'));
      userDataDir = path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Mozilla/Firefox');
    } else if (platform === 'darwin') {
      candidates = ['/Applications/Firefox.app/Contents/MacOS/firefox', path.join(home, 'Applications/Firefox.app/Contents/MacOS/firefox')];
      userDataDir = path.join(home, 'Library/Application Support/Firefox');
    } else if (platform === 'linux') {
      candidates = ['/usr/bin/firefox', '/usr/local/bin/firefox', '/snap/bin/firefox'];
      const roots = [path.join(home, 'snap/firefox/common/.mozilla/firefox'), path.join(home, '.mozilla/firefox'), path.join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox')];
      userDataDir = (await Promise.all(roots.map(async dir => await fs.stat(path.join(dir, 'profiles.ini')).catch(() => null) ? dir : null))).find(Boolean) || roots[1];
    } else return { ...info, error: 'Firefox 支持 Windows、macOS 和 Linux。' };
  } else if (platform === 'darwin') {
    candidates = [`/Applications/${app}.app/Contents/MacOS/${app}`, path.join(home, `Applications/${app}.app/Contents/MacOS/${app}`)];
    userDataDir = path.join(home, 'Library/Application Support', kind === 'edge' ? 'Microsoft Edge' : 'Google/Chrome');
  } else if (platform === 'win32') {
    candidates = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map(root => path.join(root, folder, 'Application', binary));
    userDataDir = env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, folder, 'User Data');
  } else if (platform === 'linux') {
    const names = kind === 'edge' ? ['microsoft-edge', 'microsoft-edge-stable', '/opt/microsoft/msedge/microsoft-edge'] : ['google-chrome', 'google-chrome-stable', '/opt/google/chrome/chrome'];
    candidates = names.flatMap(name => path.isAbsolute(name) ? [name] : ['/usr/bin', '/usr/local/bin'].map(root => path.join(root, name)));
    userDataDir = path.join(home, '.config', kind === 'edge' ? 'microsoft-edge' : 'google-chrome');
  } else return { ...info, error: '目前支持 Windows、macOS 和 Linux 的 Chrome / Edge。' };
  const executable = (await Promise.all(candidates.map(async file => await fs.stat(file).catch(() => null) ? file : null))).find(Boolean);
  if (kind === 'firefox') {
    const profiles = await firefoxProfiles(userDataDir);
    return { ...info, installed: Boolean(executable), available: Boolean(executable), executable, userDataDir: await fs.realpath(userDataDir).catch(() => userDataDir), ...profiles,
      ...(!executable ? { error: '未找到 Firefox，请先安装并登录课程网站。' } : {}) };
  }
  if (!executable || !userDataDir) return { ...info, error: `未找到 ${app}，请先安装并登录课程网站。` };
  try {
    // Read profile names only. Never read cookies, passwords or browsing history.
    const state = JSON.parse(await fs.readFile(path.join(userDataDir, 'Local State'), 'utf8'));
    const profiles = Object.entries(state.profile?.info_cache || {}).filter(([directory]) => /^[a-zA-Z0-9 _-]{1,80}$/.test(directory)).map(([directory, info]) => ({ directory, name: String(info.name || directory).slice(0, 120) }));
    if (!profiles.length) throw new Error('没有可选资料');
    return { ...info, installed: true, available: true, executable, userDataDir: await fs.realpath(userDataDir), profiles, lastUsedProfile: profiles.some(profile => profile.directory === state.profile?.last_used) ? state.profile.last_used : profiles[0].directory };
  } catch { return { ...info, installed: true, error: `请先打开 ${info.name} 创建用户资料，并登录课程网站，再刷新控制台。` }; }
}
export const discoverChrome = discoverBrowser;

export function browserCommand(urls, browser) {
  if (browser?.kind === 'firefox') {
    const profile = firefoxProfilePath(browser.userDataDir, browser.profileDirectory);
    if (!browser.executable || !profile) throw new Error('请选择已登录的 Firefox 资料。');
    return { command: browser.executable, args: ['-profile', profile, '--new-window', ...urls] };
  }
  if (!browser?.executable || !browser.userDataDir || !/^[a-zA-Z0-9 _-]{1,80}$/.test(browser.profileDirectory || '')) throw new Error('请在签到设置中选择已登录的浏览器资料。');
  return { command: browser.executable, args: [`--user-data-dir=${browser.userDataDir}`, `--profile-directory=${browser.profileDirectory}`, ...urls] };
}

function submit(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: true });
    let timer;
    const finish = error => { clearTimeout(timer); child.unref(); error ? reject(error) : resolve(); };
    child.once('error', finish);
    child.once('exit', code => finish(code ? new Error('浏览器打开命令失败，请检查浏览器安装和用户资料。') : null));
    // A newly launched browser stays running; only command acceptance is observable here.
    child.once('spawn', () => { timer = setTimeout(() => finish(), 700); });
  });
}

export async function openCheckinPages(urls, browser, submitCommand = submit) {
  const base = browserCommand([], browser);
  const batches = [];
  let batch = [], length = base.command.length + base.args.join(' ').length + 10;
  for (const url of urls) {
    // Leave headroom under Windows' command-line limit. No shell expansion is used.
    if (batch.length && length + url.length + 4 > 24000) { batches.push(batch); batch = []; length = base.command.length + base.args.join(' ').length + 10; }
    if (url.length > 16000) throw new Error('签到网址过长，请重新复制课程地址。');
    batch.push(url); length += url.length + 4;
  }
  if (batch.length) batches.push(batch);
  const results = await Promise.all(batches.map(async list => {
    try { const { command, args } = browserCommand(list, browser); await submitCommand(command, args); return list.map(url => ({ url, ok: true })); }
    catch (error) { return list.map(url => ({ url, ok: false, error: error.message })); }
  }));
  return results.flat();
}

export function networkAvailable(host) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port: 443 });
    const timeout = setTimeout(() => finish(false), 8000);
    function finish(ok) { clearTimeout(timeout); socket.destroy(); resolve(ok); }
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}

export function notifyCheckin(message) {
  let command, args;
  if (process.platform === 'darwin') {
    command = '/usr/bin/osascript'; args = ['-e', 'on run argv\n display notification (item 1 of argv) with title "szu-uooc 签到"\nend run', message];
  } else if (process.platform === 'win32') {
    command = 'powershell.exe';
    const literal = "'" + message.replaceAll("'", "''") + "'";
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $icon = New-Object System.Windows.Forms.NotifyIcon; $icon.Icon = [System.Drawing.SystemIcons]::Information; $icon.Visible = $true; $icon.ShowBalloonTip(5000, 'szu-uooc 签到', ${literal}, [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 6; $icon.Dispose()`;
    args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  } else return;
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: true }); child.on('error', () => {}); child.unref();
}
