import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as browsers from '../student/checkin-browser.mjs';

test('Edge discovery reads the selected browser profiles on Mac and Windows', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-edge-discovery-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const [platform, executable, userDataDir] of [
    ['darwin', path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), path.join(home, 'Library/Application Support/Microsoft Edge')],
    ['win32', path.join(home, 'Program Files/Microsoft/Edge/Application/msedge.exe'), path.join(home, 'Local/Microsoft/Edge/User Data')],
  ]) {
    await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'fixture');
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(path.join(userDataDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 2', info_cache: { Default: { name: '个人' }, 'Profile 2': { name: '学习' }, '../bad': { name: 'invalid' } } } }));
    const found = await browsers.discoverBrowser({ kind: 'edge', platform, home, env: { ProgramFiles: path.join(home, 'Program Files'), LOCALAPPDATA: path.join(home, 'Local') } });
    assert.equal(found.kind, 'edge'); assert.equal(found.available, true); assert.equal(path.basename(found.executable), platform === 'darwin' ? 'Microsoft Edge' : 'msedge.exe');
    assert.equal(found.userDataDir, await fs.realpath(userDataDir)); assert.equal(found.lastUsedProfile, 'Profile 2');
    assert.deepEqual(found.profiles, [{ directory: 'Default', name: '个人' }, { directory: 'Profile 2', name: '学习' }]);
  }
});


test('discovery rejects unknown browser kinds and reports a missing Edge without using Chrome', async () => {
  for (const kind of ['__proto__', '']) await assert.rejects(browsers.discoverBrowser({ kind }), /Chrome、Edge 或 Firefox/);
  const found = await browsers.discoverBrowser({ kind: 'edge', platform: 'win32', env: {} });
  assert.equal(found.installed, false); assert.equal(found.available, false); assert.equal(found.kind, 'edge');
  assert.match(found.error, /Microsoft Edge/); assert.deepEqual(found.profiles, []);
});

test('Firefox discovery reads Windows and Mac profiles and prefers the install default with CRLF paths', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-firefox-discovery-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const [platform, executable, root] of [
    ['win32', path.join(home, 'Program Files/Mozilla Firefox/firefox.exe'), path.join(home, 'Roaming/Mozilla/Firefox')],
    ['darwin', path.join(home, 'Applications/Firefox.app/Contents/MacOS/firefox'), path.join(home, 'Library/Application Support/Firefox')],
  ]) {
    await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'fixture');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'profiles.ini'), '[Profile0]\r\nName=旧资料\r\nIsRelative=1\r\nPath=Profiles/old.default\r\nDefault=1\r\n[Profile1]\r\nName=学习资料\r\nIsRelative=1\r\nPath=Profiles/新资料 [1].default-release\r\n[InstallABC]\r\nDefault=Profiles/新资料 [1].default-release\r\n');
    const info = await browsers.discoverBrowser({ kind: 'firefox', platform, home, env: { ProgramFiles: path.join(home, 'Program Files'), APPDATA: path.join(home, 'Roaming') } });
    assert.equal(info.installed, true); assert.equal(info.available, true);
    assert.equal(info.lastUsedProfile, 'Profiles/新资料 [1].default-release');
    assert.equal(info.profiles.length, 2);
    assert.deepEqual(browsers.browserCommand(['https://www.uooc.net.cn/'], { ...info, profileDirectory: info.lastUsedProfile }).args,
      ['-profile', path.join(root, info.lastUsedProfile), '--new-window', 'https://www.uooc.net.cn/']);
  }
});

test('Linux Firefox reads conventional and Snap profile roots', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-firefox-linux-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const folder of ['.mozilla/firefox', 'snap/firefox/common/.mozilla/firefox']) {
    const root = path.join(home, folder);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'profiles.ini'), '[Profile0]\nName=default\nIsRelative=1\nPath=sample.default-release\nDefault=1\n');
    const info = await browsers.discoverBrowser({ kind: 'firefox', platform: 'linux', home });
    assert.equal(info.userDataDir, await fs.realpath(root));
    assert.equal(info.lastUsedProfile, 'sample.default-release');
  }
});
