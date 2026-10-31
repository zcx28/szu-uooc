import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const powershell = process.env.PWSH || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
// Let the selected PowerShell build its own module path instead of inheriting another edition's modules.
const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
const available = !spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']).error;
const installer = fileURLToPath(new URL('../student/install-windows.ps1', import.meta.url));
const launcher = fileURLToPath(new URL('../student/launch-windows.ps1', import.meta.url));
const folder = 'node-v24.21.0-win-x64';
const nestedNpmFile = 'node_modules/npm/node_modules/@npmcli/arborist/lib/arborist/build-ideal-tree.js';
let base, archive, checksum;

test.before(async () => {
  if (!available) return;
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-windows-install-'));
  const fixture = path.join(base, folder);
  await fs.mkdir(path.join(fixture, 'node_modules/npm/bin'), { recursive: true });
  await fs.copyFile(process.execPath, path.join(fixture, 'node.exe'));
  await fs.writeFile(path.join(fixture, 'node_modules/npm/bin/npm-cli.js'), "require('node:fs').writeFileSync('.components-ready', ''); console.error('npm notice fixture advisory'); console.log('fixture npm complete');\n");
  await fs.mkdir(path.dirname(path.join(fixture, nestedNpmFile)), { recursive: true });
  await fs.writeFile(path.join(fixture, nestedNpmFile), 'fixture nested npm dependency');
  archive = path.join(base, folder + '.zip');
  await run(powershell, ['-NoProfile', '-Command', 'Compress-Archive -LiteralPath $env:SZU_FIXTURE -DestinationPath $env:SZU_ARCHIVE'], {
    env: { ...shellEnv, SZU_FIXTURE: fixture, SZU_ARCHIVE: archive }, timeout: 60000,
  });
  checksum = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
});
test.after(async () => { if (base) await fs.rm(base, { recursive: true, force: true }); });

async function prepare(name) {
  const root = path.join(base, name);
  await fs.mkdir(path.join(root, 'app/student'), { recursive: true });
  await fs.writeFile(path.join(root, 'app/student/install-windows.ps1'), '\uFEFF' + (await fs.readFile(installer, 'utf8')).replace(/^\uFEFF/, ''));
  await fs.writeFile(path.join(root, 'app/student/launch-windows.ps1'), '\uFEFF' + (await fs.readFile(launcher, 'utf8')).replace(/^\uFEFF/, ''));
  await fs.writeFile(path.join(root, 'app/student/start.mjs'), "import fs from 'node:fs'; process.exit(fs.existsSync('app/.components-ready') ? 0 : 1);\n");
  await fs.writeFile(path.join(root, '依赖校验.sha256'), checksum + '  ' + folder + '.zip\n');
  return root;
}

function install(root, { nodeOnly = true, downloadedArchive = archive } = {}) {
  return run(powershell, ['-NoProfile', '-Command', `
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $TimeoutSec, $Uri, $OutFile)
    Add-Content -LiteralPath (Join-Path $env:SZU_ROOT 'requests.log') -Value $Uri
    Copy-Item -LiteralPath $env:SZU_ARCHIVE -Destination $OutFile
}
& $env:SZU_INSTALLER -NodeOnly:($env:SZU_NODE_ONLY -eq '1')
`], { env: { ...shellEnv, SZU_ROOT: root, SZU_ARCHIVE: downloadedArchive,
    SZU_INSTALLER: path.join(root, 'app/student/install-windows.ps1'),
    SZU_NODE_ONLY: nodeOnly ? '1' : '0' }, timeout: 60000 });
}

async function assertClean(root) {
  assert.deepEqual((await fs.readdir(path.join(root, 'runtime'))).filter(name => name.startsWith('.')), []);
}

test('Windows installer supports Chinese, spaces and square brackets through download, components and restart', { skip: !available }, async () => {
  const root = await prepare('[同学 1]');
  assert.match((await install(root)).stdout, /运行环境准备完成/);
  await fs.chmod(path.join(root, 'runtime/windows-x64/node.exe'), 0o755);
  assert.match((await install(root, { nodeOnly: false })).stdout, /下载完成/);
  assert.match((await install(root)).stdout, /^$/);
  assert.equal((await fs.readFile(path.join(root, 'requests.log'), 'utf8')).trim().split(/\r?\n/).length, 1);
  assert.match(await fs.readFile(path.join(root, 'runtime/install-error.log'), 'utf8'), /fixture npm complete/);
  await assertClean(root);
});

test('Windows checksum failure explains its stage and preserves a complete local error', { skip: !available }, async () => {
  const root = await prepare('corrupt');
  await fs.writeFile(path.join(root, '依赖校验.sha256'), '0'.repeat(64) + '  ' + folder + '.zip\n');
  const error = await install(root).then(() => assert.fail('must reject a corrupt download'), error => error);
  assert.equal(error.code, 1);
  assert.match(error.stdout, /失败步骤：校验运行环境/);
  assert.match(error.stdout, /原因：下载文件校验失败/);
  assert.match(await fs.readFile(path.join(root, 'runtime/install-error.log'), 'utf8'), /(?:InvocationInfo|ScriptStackTrace)/);
  await assert.rejects(fs.stat(path.join(root, 'runtime/windows-x64/node.exe')), { code: 'ENOENT' });
  await assertClean(root);
});

test('Windows bootstrap keeps a real npm failure visible and releases the download lock', { skip: !available }, async () => {
  const root = await prepare('npm-failure');
  await install(root);
  await fs.writeFile(path.join(root, 'runtime/windows-x64/node_modules/npm/bin/npm-cli.js'), "console.error('fixture npm failure'); process.exit(7);\n");
  const error = await install(root, { nodeOnly: false }).then(() => assert.fail('must reject npm exit 7'), error => error);
  assert.equal(error.code, 1);
  assert.match(error.stdout, /组件下载失败/);
  assert.match(await fs.readFile(path.join(root, 'runtime/install-error.log'), 'utf8'), /fixture npm failure/);
  await assertClean(root);
});

test('Windows bootstrap extracts nested npm dependencies beyond the legacy 260-character limit', { skip: !available }, async () => {
  const root = await prepare('深层目录-'.repeat(15));
  assert(path.join(root, 'runtime/.download-' + '0'.repeat(32), folder, nestedNpmFile).length > 260);
  await install(root);
  assert.equal(await fs.readFile(path.join(root, 'runtime/windows-x64', nestedNpmFile), 'utf8'), 'fixture nested npm dependency');
  await assertClean(root);
});

test('Windows extraction failure reports the actual cause and releases the installer lock', { skip: !available }, async () => {
  const root = await prepare('extract failure'), malformed = path.join(base, 'malformed.zip');
  await fs.writeFile(malformed, 'not a zip');
  const hash = createHash('sha256').update(await fs.readFile(malformed)).digest('hex');
  await fs.writeFile(path.join(root, '依赖校验.sha256'), hash + '  ' + folder + '.zip\n');
  const error = await install(root, { downloadedArchive: malformed }).then(() => assert.fail('must report extraction failure'), error => error);
  assert.equal(error.code, 1);
  assert.match(error.stdout, /失败步骤：解压运行环境/);
  const cause = error.stdout.match(/原因：(.+)/)?.[1];
  assert(cause, 'the actual exception message is shown');
  assert((await fs.readFile(path.join(root, 'runtime/install-error.log'), 'utf8')).includes(cause));
  await assertClean(root);
});

test('Windows launcher finds and removes its ready file in a bracketed installation path', { skip: !available }, async () => {
  const root = await prepare('[启动 2]');
  await fs.mkdir(path.join(root, 'runtime/windows-x64'), { recursive: true });
  await fs.copyFile(process.execPath, path.join(root, 'runtime/windows-x64/node.exe'));
  await fs.writeFile(path.join(root, 'app/student/start.mjs'), "import fs from 'node:fs'; const index=process.argv.indexOf('--ready-file'); fs.writeFileSync(process.argv[index+1], '{}');\n");
  const result = await run(powershell, ['-NoProfile', '-Command', `
function Start-Process {
    param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
    if ($FilePath -eq 'explorer.exe') { return }
    Microsoft.PowerShell.Management\\Start-Process @PSBoundParameters
}
& $env:SZU_LAUNCHER
`], { env: { ...shellEnv, SZU_LAUNCHER: path.join(root, 'app/student/launch-windows.ps1') }, timeout: 15000 }).catch(async error => {
    const logs = await Promise.all((await fs.readdir(path.join(root, 'runtime'))).filter(name => name.endsWith('.log')).map(name => fs.readFile(path.join(root, 'runtime', name), 'utf8')));
    throw new Error(error.stdout + '\n' + logs.join('\n'));
  });
  assert.match(result.stdout, /控制台已打开/);
  assert.deepEqual((await fs.readdir(path.join(root, 'runtime'))).filter(name => name.endsWith('.json')), []);
});
