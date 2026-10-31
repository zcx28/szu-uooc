import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateCourseURL, validateConfig, controllerArgs, acquireStartLock } from '../student/start.mjs';
import { session } from './console-fixtures.mjs';

const config = { base_url: 'https://api.example.com/v1', model: 'gpt-6-luna', wire_api: 'responses', reasoning_effort: 'medium', api_key: 'test-only-not-a-real-key', budget: 1, pricing: { input_per_million: 0.05, cached_input_per_million: 0.005, output_per_million: 0.25 } };
const url = 'https://www.uooc.net.cn/home/learn/index#/123/1/2/3/4/subsection';
test('beginner input accepts only course learning URLs, not lookalike or credential URLs', () => {
  assert.equal(validateCourseURL('  ' + url + '  '), url);
  for (const value of ['not a url', 'https://www.uooc.net.cn/login', 'https://www.uooc.net.cn/home/learn/index', url.replace('uooc.net.cn', 'uooc.net.cn.evil.test'), url.replace('https://', 'https://user:secret@'), url.replace('https:', 'http:')]) assert.throws(() => validateCourseURL(value));
});
test('configuration validates key, budget, Responses model and three prices before saving', () => {
  assert.equal(validateConfig(config), config);
  assert.equal(validateConfig({ ...config, model: 'custom-model', budget: 0.5 }).model, 'custom-model');
  for (const override of [{ api_key: '' }, { api_key: 'test key' }, { base_url: 'http://api.example.com/v1' }, { base_url: 'https://api.example.com/v1?key=test' }, { model: '' }, { budget: 2 }, { budget: 0 }, { pricing: null }, { pricing: { input_per_million: -1, cached_input_per_million: 0, output_per_million: 0.25 } }]) assert.throws(() => validateConfig({ ...config, ...override }));
});
test('course URL and private paths are separate arguments, with no Key in child arguments', () => {
  const args = controllerArgs(url, '/tmp/path with spaces/api.json', '/tmp/private dir');
  assert.deepEqual(args.slice(1), [url, '--config', '/tmp/path with spaces/api.json', '--data-dir', '/tmp/private dir', '--console']);
  assert(!args.some((arg) => arg.includes(config.api_key)));
});
test('a second launcher is blocked and normal exit releases the lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-uooc-lock-'));
  try {
    const release = await acquireStartLock(dir);
    await assert.rejects(acquireStartLock(dir), /控制台已打开/);
    release();
    const again = await acquireStartLock(dir);
    again();
    await assert.rejects(fs.readFile(path.join(dir, 'running.pid')), { code: 'ENOENT' });
    await fs.writeFile(path.join(dir, 'running.pid'), 'not a pid');
    await assert.rejects(acquireStartLock(dir), /启动记录异常/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Windows permission denial recovers only when the old PID belongs to another program', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-uooc-windows-lock-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(async () => { Object.defineProperty(process, 'platform', platform); await fs.rm(dir, { recursive: true, force: true }); });
  const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  t.mock.method(process, 'kill', (pid, signal) => { assert.equal(pid, 4); assert.equal(signal, 0); throw denied; });
  const listing = t.mock.method(childProcess, 'execFileSync', () => '"System","4","Services","0","100 K"\r\n');
  await fs.writeFile(path.join(dir, 'running.pid'), '4');
  const release = await acquireStartLock(dir);
  try { assert.equal(await fs.readFile(path.join(dir, 'running.pid'), 'utf8'), String(process.pid)); }
  finally { release(); }
  assert.equal(listing.mock.callCount(), 1);
  for (const output of ['"node.exe","4","Console","1","100 K"\r\n', 'unrecognized output', '"System","8","Services","0","100 K"\r\n']) {
    listing.mock.mockImplementation(() => output);
    await fs.writeFile(path.join(dir, 'running.pid'), '4');
    await assert.rejects(acquireStartLock(dir), error => error === denied);
    assert.equal(await fs.readFile(path.join(dir, 'running.pid'), 'utf8'), '4');
  }
  listing.mock.mockImplementation(() => { throw new Error('tasklist unavailable'); });
  await assert.rejects(acquireStartLock(dir), error => error === denied);
});

test('the real launcher retains its local origin across a clean termination and restart',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'szu-launcher-restart-')),copy=path.join(temp,'app'),data=path.join(temp,'data');
 const source=fileURLToPath(new URL('..',import.meta.url));await fs.mkdir(path.join(copy,'student'),{recursive:true});
 for(const folder of ['', 'student'])for(const name of await fs.readdir(path.join(source,folder)))if(name.endsWith('.mjs'))await fs.copyFile(path.join(source,folder,name),path.join(copy,folder,name));
 await fs.symlink(path.dirname(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json'))),path.join(copy,'node_modules'),process.platform==='win32'?'junction':'dir');
 const children=[];
 t.after(async()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');await Promise.all(children.map(c=>c.finished));await fs.rm(temp,{recursive:true,force:true});});
 const launch=async n=>{
  const ready=path.join(temp,'ready-'+n+'.json');const child=fork(path.join(copy,'student/start.mjs'),['--data-dir',data,'--no-open','--ready-file',ready],{stdio:'ignore'});children.push(child);child.finished=new Promise(resolve=>child.once('exit',resolve));
  for(let i=0;i<100;i++){if(await fs.stat(ready).catch(()=>null))return child;if(child.exitCode!==null)throw new Error('launcher exited before ready');await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('launcher readiness timed out');
 };
 const first=await launch(1);const before=JSON.parse(await fs.readFile(path.join(data,'console-address.json'),'utf8'));
 const duplicate=await launch(3);assert.equal(await duplicate.finished,0,'the same installed build still reuses its console');
 for(const metadata of [{...before,appDir:copy+'-old'},{url:before.url,pid:before.pid},{...before,build:'older-build'}]){
  await fs.writeFile(path.join(data,'console-address.json'),JSON.stringify(metadata));
  const stale=fork(path.join(copy,'student/start.mjs'),['--data-dir',data,'--no-open'],{silent:true});children.push(stale);stale.finished=new Promise(resolve=>stale.once('exit',resolve));
  let output='';stale.stdout.on('data',chunk=>output+=chunk);stale.stderr.on('data',chunk=>output+=chunk);
  assert.equal(await stale.finished,1,'a different or older installation must not silently reopen the old console');
  assert.match(output,/旧版.*设置.*退出程序.*新版/);assert.equal(first.exitCode,null,'the existing console must remain alive');
 }
 await fs.writeFile(path.join(data,'console-address.json'),JSON.stringify(before));
 const stop=async(child,address)=>{const client=await session({url:address.url,origin:new URL(address.url).origin});await client.post('/api/shutdown');assert.equal(await child.finished,0);};
 await stop(first,before);
 assert.equal(JSON.parse(await fs.readFile(path.join(data,'console-address.json'),'utf8')).url,before.url);
 const second=await launch(2);const after=JSON.parse(await fs.readFile(path.join(data,'console-address.json'),'utf8'));assert.equal(new URL(after.url).origin,new URL(before.url).origin);await stop(second,after);
});
