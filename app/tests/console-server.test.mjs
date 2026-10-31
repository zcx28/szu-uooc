import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createConsole } from '../student/console-server.mjs';
import { defaults, saveJSON } from '../student/settings.mjs';

import { appDir, courseURL, fixtureWorker, session } from './console-fixtures.mjs';
const waitFor = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for state'); };

test('upgrading a legacy AI configuration keeps its mode and connection test result',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-console-legacy-mode-'));
  await saveJSON(path.join(dataDir,'api.json'),{...defaults,api_key:'legacy-fixture-key'});
  const app=await createConsole({appDir,dataDir,checkDependencies:async()=>true,fetchImpl:async()=>new Response(JSON.stringify({data:[{id:defaults.model}]}))});
  try{
    const client=await session(app);assert.equal((await client.get()).config.answer_mode,'ai');
    await client.post('/api/test-connection',{answer_mode:'ai'});
    assert.equal((await client.get()).connection.status,'listed');
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir,'api.json'),'utf8')).api_key,'legacy-fixture-key');
  }finally{await app.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

test('free mode can be saved and start a course without a Key or any provider request',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-console-free-')),children=[];let calls=0;
  const app=await createConsole({appDir,dataDir,spawnController:fixtureWorker(children),checkDependencies:async()=>true,fetchImpl:async()=>{calls++;throw new Error('free mode must not contact a provider');}});
  try{
    const client=await session(app);
    await client.post('/api/config',{answer_mode:'free'});
    assert.equal((await client.get()).config.hasKey,false);assert.equal((await client.get()).config.answer_mode,'free');
    await client.post('/api/test-connection',{},400);assert.equal(calls,0);
    await client.post('/api/courses',{url:courseURL('123')});
    await client.post('/api/course-action',{id:'123',action:'start'});
    await waitFor(async()=>(await client.get()).courses[0].status==='running');
    await client.post('/api/course-action',{id:'123',action:'stop'});
    await waitFor(async()=>(await client.get()).activeId===null);
    await client.post('/api/config',{answer_mode:'ai'},400);
    await client.post('/api/config',{answer_mode:'unknown'},400);
    await client.post('/api/config',{answer_mode:'ai',api_key:'kept-fixture-key'});
    await client.post('/api/config',{answer_mode:'free'});
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir,'api.json'),'utf8')).api_key,'kept-fixture-key','switching modes preserves an existing Key');
    assert(!JSON.stringify(await client.get()).includes('kept-fixture-key'));assert.equal(calls,0);
  }finally{await app.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

test('console protects credentials, validates inputs, controls a course, runs one course at a time with confirmed completions and preserves costs', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-console-test-')); const children = [];
  let calls = 0;
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true, spawnController: fixtureWorker(children), fetchImpl: async (url, request) => {
    calls++; assert.equal(new URL(url).pathname, '/v1/models'); assert.equal(request.headers.Authorization, 'Bearer fixture-private-key');
    return new Response(JSON.stringify({ data: [{ id: 'gpt-6-luna' }] }), { status: 200 });
  } });
  try {
    const client = await session(app);
    assert.equal((await fetch(app.origin + '/api/state')).status, 401);
    assert.equal((await fetch(app.origin + '/api/config', { method: 'POST', headers: { Cookie: client.cookie, Origin: 'https://evil.test', 'Content-Type': 'application/json', 'X-Szu-Token': client.csrf }, body: '{}' })).status, 403);
    const hostStatus = await new Promise(resolve => { const req = http.get(app.origin + '/api/state', { headers: { Cookie: client.cookie, Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', error => { throw error; }); });
    assert.equal(hostStatus, 403);
    await client.post('/api/config', { api_key: 'bad key' }, 400);
    await client.post('/api/config', { api_key: 'fixture-private-key' });
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dataDir, 'api.json'))).mode & 0o777, 0o600);
    assert(!JSON.stringify(await client.get()).includes('fixture-private-key'));
    await client.post('/api/test-connection'); assert.equal(calls, 1); assert.equal((await client.get()).connection.status, 'listed');
    const edited = await client.post('/api/test-connection', { model: 'unsaved-model' });
    assert.equal(edited.connection.status, 'listed', 'legacy list-only test never requires a manually typed model');
    assert.equal((await client.get()).connection.status, 'listed', 'testing unsaved settings must not replace the saved service result');
    await client.post('/api/courses', { url: 'https://uooc.net.cn.evil.test/home/learn/#/123' }, 400);
    for (const id of ['123', '456', '789']) await client.post('/api/courses', { url: id === '789' ? courseURL(id).replace('/home/learn/index', '/home/learn/new/789') : courseURL(id), name: `学习 ${id}` });
    assert.equal((await client.get()).courses.find(c=>c.id==='789').url,courseURL('789'),'direct course additions use the same compatible entry');
    await client.post('/api/courses', { url: courseURL('123') }, 400);
    await saveJSON(path.join(dataDir, 'ledger/course-123.json'), { courseId: '123', model: defaults.model, requests: [{ id: 'known', status: 'known', cost_nanos: 123000000 }, { id: 'unknown', status: 'unknown', reserved_nanos: 10000000 }] });
    const costs = (await client.get()).courses[0].costs; assert.deepEqual(costs, { spent: 0.123, reserved: 0.01, unknown: true, unknownRequests: 1, pending: 0, requests: 2, unresolvedRequests: 1, recoveryRequired: true, meteringBoundExceeded: false });
    await client.post('/api/course-action', { id: '123', action: 'start' }); await waitFor(async () => (await client.get()).courses[0].status === 'running');
    await client.post('/api/config', { api_key: 'other-fixture-key' }, 400);
    await client.post('/api/course-action', { id: '123', action: 'start' }, 400); assert.equal(children.length, 1);
    await client.post('/api/course-action', { id: '123', action: 'pause' }); await waitFor(async () => (await client.get()).courses[0].status === 'paused');
    assert.equal((await client.get()).activeId, '123');
    await client.post('/api/course-action', { id: '123', action: 'resume' }); await waitFor(async () => (await client.get()).courses[0].status === 'running'); assert.equal(children.length, 1);
    await client.post('/api/course-action', { id: '123', action: 'stop' }); await waitFor(async () => (await client.get()).activeId === null);
    assert.equal((await client.get()).courses[0].status, 'stopped');
    await client.post('/api/queue', { action: 'start', ids: ['123'] }); assert.equal(children[1].id, '123'); assert.equal(children.length, 2); assert.deepEqual((await client.get()).activeIds, ['123']);
    await client.post('/api/course-action', { id: '456', action: 'start' }, 400);
    Object.assign(children[1].state, { phase: 'complete', active: false, completed: 20 }); children[1].report(); children[1].emit('exit', 0, null);
    await waitFor(async () => !(await client.get()).activeIds.includes('123'));
    await client.post('/api/course-action', { id: '456', action: 'start' }); assert.equal(children[2].id, '456');
    Object.assign(children[2].state, { phase: 'paused', active: false, error: '需要人工处理' }); children[2].report();
    await waitFor(async () => (await client.get()).courses[1].status === 'paused'); assert.equal(children.length, 3);
    await client.post('/api/course-action', { id: '789', action: 'start' }, 400);
    assert.equal((await client.get()).courses[2].status, 'ready', 'a blocked second course must remain untouched');
    await client.post('/api/queue', { action: 'stop' }); await waitFor(async () => (await client.get()).activeId === null);
    await client.post('/api/course-action', { id: '123', action: 'remove' }); assert(await fs.stat(path.join(dataDir, 'ledger/course-123.json')));
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'courses.json'), 'utf8')); assert.equal(persisted.courses.length, 2);
    assert.equal(calls, 2, 'course lifecycle must not invoke a provider during mocked runs');
    await client.post('/api/course-action', { id: '789', action: 'start' });
    const before = Date.now(); await app.close();
    assert(Date.now() - before < 1000, 'shutdown must observe an immediate child exit before sending stop');
  } finally { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('dependency download failure is visible and retry repairs it; restart keeps progress without auto-running', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-console-retry-'));
  await saveJSON(path.join(dataDir, 'courses.json'), { courses: [{ id: '123', url: courseURL('123').replace('/home/learn/index', '/home/learn/new/123'), name: '已保存课程', status: 'running', completed: 12, total: 20 }] });
  let ready = false, attempts = 0;
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => ready, installDependencies: async () => { if (++attempts === 1) throw new Error('模拟下载失败'); ready = true; } });
  try {
    const client = await session(app);
    await waitFor(async () => (await client.get()).environment.status === 'error');
    assert.equal((await client.get()).courses[0].completed, 12); assert.equal((await client.get()).courses[0].status, 'stopped');
    assert.equal((await client.get()).courses[0].url, courseURL('123'), 'saved new UI links reopen in the compatible view after upgrading');
    assert.equal((await client.get()).activeId, null);
    await client.post('/api/environment'); await waitFor(async () => (await client.get()).environment.status === 'ready'); assert.equal(attempts, 2);
  } finally { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('restart reuses the previous local console origin so existing tabs can reconnect',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-console-restart-origin-'));let first,second;
 try{
  first=await createConsole({appDir,dataDir,checkDependencies:async()=>true});const origin=first.origin;
  await saveJSON(path.join(dataDir,'console-address.json'),{url:first.url,pid:process.pid});await first.close();
  second=await createConsole({appDir,dataDir,checkDependencies:async()=>true});
  assert.equal(second.origin,origin,'do not strand the old console at a dead random port after restart');
  assert.equal((await session(second)).cookie.includes('szu_session='),true);
 }finally{await second?.close();await first?.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

test('an occupied saved console port falls back safely without taking over its listener',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-console-occupied-origin-'));const occupied=http.createServer((_req,res)=>res.end('unrelated listener'));let app;
 try{
  await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+occupied.address().port;
  await saveJSON(path.join(dataDir,'console-address.json'),{url:origin+'/?token=fixture',pid:999999});
  app=await createConsole({appDir,dataDir,checkDependencies:async()=>true});assert.notEqual(app.origin,origin);assert.equal(await (await fetch(origin)).text(),'unrelated listener');
 }finally{await app?.close();await new Promise(resolve=>occupied.close(resolve));await fs.rm(dataDir,{recursive:true,force:true});}
});
