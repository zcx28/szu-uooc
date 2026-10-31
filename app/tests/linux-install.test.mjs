import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const bash = process.env.SZU_TEST_BASH || (process.platform === 'win32'
  ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : '/bin/bash');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const launchFile = '启动‑Linux.command';
const fakeNode = '#!/usr/bin/env bash\n' + String.raw`
case "$1" in
  --version) echo v24.21.0 ;;
  -e) echo 'http://127.0.0.1:45567/?token=fixture' ;;
  *npm-cli.js)
    mkdir -p node_modules/playwright
    touch node_modules/playwright/cli.js .dependencies-ready
    ;;
  node_modules/playwright/cli.js) touch .firefox-ready ;;
  app/student/start.mjs)
    if [ "$2" = '--check' ]; then test -f app/.dependencies-ready; exit $?; fi
    ready=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '--ready-file' ]; then ready="$2"; shift; fi
      shift
    done
    [ -n "$ready" ] || exit 7
    sleep 0.2
    printf '{"ready":true}\n' > "$ready"
    echo 'http://127.0.0.1:45567/?token=fixture'
    ;;
  *) exit 8 ;;
esac
`;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-linux-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'app/student'), { recursive: true });
  await fs.mkdir(path.join(root, 'fixture-bin'));
  for (const file of ['app/student/install-linux.sh', 'app/student/network-mac.sh', launchFile]) {
    await fs.copyFile(path.join(source, file), path.join(root, file));
  }
  await fs.writeFile(path.join(root, 'app/student/start.mjs'), '// fixture');
  const nodeFolder = path.join(root, 'node-v24.21.0-linux-x64');
  await fs.mkdir(path.join(nodeFolder, 'bin'), { recursive: true });
  await fs.mkdir(path.join(nodeFolder, 'lib/node_modules/npm/bin'), { recursive: true });
  await fs.writeFile(path.join(nodeFolder, 'bin/node'), fakeNode, { mode: 0o700 });
  await fs.writeFile(path.join(nodeFolder, 'lib/node_modules/npm/bin/npm-cli.js'), '// fixture');
  await run(bash, ['-c', 'tar -czf fixture-node.tar.gz node-v24.21.0-linux-x64'], { cwd: root });
  const digest = createHash('sha256').update(await fs.readFile(path.join(root, 'fixture-node.tar.gz'))).digest('hex');
  await fs.writeFile(path.join(root, '依赖校验.sha256'), digest + '  node-v24.21.0-linux-x64.tar.gz\n');
  await fs.writeFile(path.join(root, 'fixture-bin/uname'), '#!/usr/bin/env bash\nif [ "$1" = "-m" ]; then echo x86_64; else echo Linux; fi\n', { mode: 0o700 });
  await fs.writeFile(path.join(root, 'fixture-bin/curl'), '#!/usr/bin/env bash\n' + String.raw`
echo called >> "$PWD/fixture-curl.log"
[ "$SZU_TEST_OFFLINE" != 1 ] || exit 22
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then cp fixture-node.tar.gz "$2"; exit $?; fi
  shift
done
exit 9
`, { mode: 0o700 });
  const invoke = (file, args = [], overrides = {}) => run(bash,
    ['-c', 'export PATH="$PWD/fixture-bin:$PATH"; exec bash "$@"', 'szu-test', file, ...args],
    { cwd: root, env: { ...process.env, ...overrides }, timeout: 15000 });
  return { root, invoke };
}

test('Linux bootstrap downloads and checks Node, then installs dependencies and the matching Firefox build', async t => {
  const { root, invoke } = await fixture(t);
  await invoke('app/student/install-linux.sh', ['--node-only']);
  assert.equal((await fs.readFile(path.join(root, 'runtime/linux-x64/bin/node'), 'utf8')), fakeNode);
  await assert.rejects(fs.stat(path.join(root, 'app/.dependencies-ready')), { code: 'ENOENT' });
  await invoke('app/student/install-linux.sh');
  await fs.stat(path.join(root, 'app/.dependencies-ready'));
  await fs.stat(path.join(root, 'app/.firefox-ready'));
  await assert.rejects(fs.stat(path.join(root, 'runtime/.install-lock')), { code: 'ENOENT' });
});

test('Linux bootstrap rejects a mismatched checksum and releases its download lock after failure', async t => {
  const { root, invoke } = await fixture(t);
  await fs.writeFile(path.join(root, '依赖校验.sha256'), '0'.repeat(64) + '  node-v24.21.0-linux-x64.tar.gz\n');
  await assert.rejects(invoke('app/student/install-linux.sh'), error => {
    assert.match(error.stdout + error.stderr, /校验|FAILED/); return true;
  });
  await assert.rejects(fs.stat(path.join(root, 'runtime/linux-x64/bin/node')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'runtime/.install-lock')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(path.join(root, 'runtime'))).filter(name => name.startsWith('.download.')), []);
});

test('Linux launcher waits for its own ready notification instead of accepting a stale address', async t => {
  const { root, invoke } = await fixture(t);
  await invoke('app/student/install-linux.sh');
  const result = await invoke(launchFile);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:45567/);
  assert.deepEqual((await fs.readdir(path.join(root, 'runtime'))).filter(name => name.startsWith('launch.')), []);
});
