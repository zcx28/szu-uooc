import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { allowedHost } from '../browser-bridge.mjs';

export function firefoxProfilePath(root, directory) {
  if (!root || typeof directory !== 'string' || !directory || directory.includes('\0')) return null;
  if (path.isAbsolute(directory)) return directory;
  if (directory.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) return null;
  return path.join(root, directory);
}

function iniSections(text) {
  const sections = [];
  let section;
  for (const line of text.split(/\r?\n/).map(line => line.trim())) {
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) { section = { section: header[1] }; sections.push(section); }
    else if (section && !/^[;#]/.test(line)) {
      const index = line.indexOf('=');
      if (index > 0) section[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  return sections;
}

export async function firefoxProfiles(root) {
  const read = file => fs.readFile(path.join(root, file), 'utf8').catch(() => '');
  const sections = iniSections(await read('profiles.ini'));
  const profiles = sections.filter(item => /^Profile\d+$/.test(item.section)).flatMap(item => {
    const directory = item.Path;
    if (!firefoxProfilePath(root, directory) || (item.IsRelative === '0') !== path.isAbsolute(directory)) return [];
    return [{ directory, name: (item.Name || directory).slice(0, 120), isDefault: item.Default === '1' }];
  });
  // Per-install defaults take precedence over the legacy Profile.Default flag.
  const installs = [...sections.filter(item => item.section.startsWith('Install')), ...iniSections(await read('installs.ini'))];
  const preferred = installs.map(item => profiles.find(profile => profile.directory === item.Default)).find(Boolean);
  return { profiles, lastUsedProfile: (preferred || profiles.find(profile => profile.isDefault) || profiles[0])?.directory || '' };
}

// Mozilla JSONLZ4 is an LZ4 block prefixed with mozLz40\0 and a uint32 size.
export function decodeFirefoxSession(buffer) {
  if (buffer.length < 12 || buffer.subarray(0, 8).toString('binary') !== 'mozLz40\0') throw new Error('Invalid Firefox session header');
  const size = buffer.readUInt32LE(8);
  if (!size || size > 64 * 1024 * 1024) throw new Error('Invalid Firefox session size');
  const output = Buffer.alloc(size);
  let input = 12, written = 0;
  const length = initial => {
    let value = initial;
    if (initial === 15) {
      let extra;
      do {
        if (input >= buffer.length) throw new Error('Truncated Firefox session');
        extra = buffer[input++]; value += extra;
      } while (extra === 255);
    }
    return value;
  };
  while (input < buffer.length) {
    const token = buffer[input++], literals = length(token >> 4);
    if (input + literals > buffer.length || written + literals > size) throw new Error('Invalid Firefox literals');
    buffer.copy(output, written, input, input + literals); input += literals; written += literals;
    if (input === buffer.length) break;
    if (input + 2 > buffer.length) throw new Error('Truncated Firefox match');
    const offset = buffer.readUInt16LE(input); input += 2;
    const count = length(token & 15) + 4;
    if (!offset || offset > written || written + count > size) throw new Error('Invalid Firefox match');
    for (let i = 0; i < count; i++) { output[written] = output[written - offset]; written++; }
  }
  if (written !== size) throw new Error('Incomplete Firefox session');
  return JSON.parse(output.toString('utf8'));
}

function cookieFromRow(row, session = false) {
  if (!row || typeof row.host !== 'string' || typeof row.value !== 'string') return null;
  const host = row.host.replace(/^\./, '');
  if (!allowedHost(host) && !/(^|\.)(uoocuniversity\.com|szu\.edu\.cn)$/.test(host)) return null;
  const attributes = row.originAttributes;
  // Container, private and partitioned cookies must not become default-profile cookies.
  if (row.isPartitioned || (typeof attributes === 'string' ? attributes !== '' : attributes && Object.values(attributes).some(Boolean))) return null;
  let expires = -1;
  if (!session) {
    const expiry = Number(row.expiry);
    if (!Number.isFinite(expiry) || expiry <= 0) return null;
    expires = expiry > 1e15 ? Math.floor(expiry / 1e6) : expiry > 1e12 ? Math.floor(expiry / 1000) : expiry;
    if (expires <= Date.now() / 1000) return null;
  }
  return { name: String(row.name || ''), value: row.value, domain: row.host, path: row.path || '/', expires,
    httpOnly: Boolean(session ? row.httponly : row.isHttpOnly), secure: Boolean(session ? row.secure : row.isSecure),
    sameSite: row.sameSite === 2 ? 'Strict' : row.sameSite === 1 ? 'Lax' : 'None' };
}

async function sessionCookies(src) {
  // Use one current snapshot. Merging historical backups can restore logged-out sessions.
  for (const name of ['sessionstore-backups/recovery.jsonlz4', 'sessionstore.jsonlz4', 'sessionstore-backups/recovery.baklz4']) {
    try {
      const file = path.join(src, name);
      if ((await fs.stat(file)).size > 64 * 1024 * 1024) continue;
      const state = decodeFirefoxSession(await fs.readFile(file));
      return (Array.isArray(state.cookies) ? state.cookies : []).map(row => cookieFromRow(row, true)).filter(Boolean);
    } catch {}
  }
  return [];
}

export async function firefoxCookiesFromProfile(userDataDir, profileDirectory) {
  const src = firefoxProfilePath(userDataDir, profileDirectory);
  if (!src) return [];
  const cookies = new Map();
  const add = cookie => { if (cookie) cookies.set(JSON.stringify([cookie.domain, cookie.path, cookie.name]), cookie); };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-uooc-ff-cookies-'));
  try {
    for (const name of ['cookies.sqlite', 'cookies.sqlite-wal']) await fs.copyFile(path.join(src, name), path.join(temp, name)).catch(() => {});
    const db = new DatabaseSync(path.join(temp, 'cookies.sqlite'), { readOnly: true });
    try {
      for (const row of db.prepare("SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies WHERE originAttributes = ''").all()) add(cookieFromRow(row));
    } finally { db.close(); }
  } catch {} // A session-only profile can have no persistent cookie database.
  finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
  for (const cookie of await sessionCookies(src)) add(cookie);
  return [...cookies.values()];
}

export async function importFirefoxSession(userDataDir, destDir, profileDirectory) {
  // An existing automation profile owns its login and pending submissions.
  if (!destDir || await fs.stat(destDir).catch(() => null)) return [];
  return firefoxCookiesFromProfile(userDataDir, profileDirectory);
}

export async function prepareFirefox(appDir, firefox, log = () => {}) {
  if (await fs.stat(firefox.executablePath()).catch(() => null)) return;
  log('首次连接 Firefox，正在下载浏览器组件，请保持联网。');
  const args = [path.join(appDir, 'node_modules/playwright/cli.js'), 'install', 'firefox'];
  const mac = process.platform === 'darwin';
  try {
    await promisify(execFile)(mac ? '/bin/bash' : process.execPath, mac ? ['-c', '. "$1" || exit; shift; exec "$@"', 'szu-firefox', path.join(appDir, 'student/network-mac.sh'), process.execPath, ...args] : args,
      { cwd: appDir, windowsHide: true, timeout: 900000, maxBuffer: 4 * 1024 * 1024 });
    await fs.access(firefox.executablePath());
  } catch { throw new Error('Firefox 组件下载未完成，请检查网络后重新连接。'); }
}
