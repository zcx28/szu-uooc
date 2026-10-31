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
  const firefox = await browsers.discoverBrowser({ kind: 'firefox', platform: 'win32' });
  assert.equal(firefox.available, false); assert.match(firefox.error, /仅在 Linux/);
  const found = await browsers.discoverBrowser({ kind: 'edge', platform: 'win32', env: {} });
  assert.equal(found.installed, false); assert.equal(found.available, false); assert.equal(found.kind, 'edge');
  assert.match(found.error, /Microsoft Edge/); assert.deepEqual(found.profiles, []);
});
