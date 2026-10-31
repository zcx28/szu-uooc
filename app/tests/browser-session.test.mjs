import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { defaults, saveJSON } from '../student/settings.mjs';
import { appDir, courseURL } from './console-fixtures.mjs';
const { createBrowserSession } = await import(process.env.SZU_TEST_BROWSER_SESSION_MODULE || '../student/browser-session.mjs');

test('switching checks stored submissions from a closed course origin and preserves existing tabs', async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  const owner = await chromium.launch({ executablePath, headless: true });
  const context = await owner.newContext(); await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<p>Fixture</p>' }));
  const portal = await context.newPage(); await portal.goto('https://www.uooc.net.cn/home/index');
  const source = await context.newPage(); await source.goto('https://learn.uooconline.com/home/learn/index#/123');
  await source.evaluate(() => localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ pendingSubmit: { sourceId: '456' } })));
  await source.close();
  const session = createBrowserSession({ connectBrowser: async () => owner });
  try {
    await session.get();
    await assert.rejects(session.assertSwitchable(['https://learn.uooconline.com/home/learn/index#/123']), /交卷.*123/);
    assert.equal(portal.isClosed(), false); assert.equal(context.pages().length, 1, 'temporary inspection pages are closed');
  } finally { await session.close(); }
});

test('browser switching refuses unresolved submissions and disconnect resets catalog and connection', async () => {
  let pending = ['123'], connected = true;
  const browser = new EventEmitter(); browser.isConnected = () => connected;
  browser.close = async () => { connected = false; browser.emit('disconnected'); };
  browser.contexts = () => [{ pages: () => [{ url: () => 'https://www.uooc.net.cn/home/index', evaluate: async () => pending }] }];
  const session = createBrowserSession({ getBrowserKind: () => 'edge', connectBrowser: async () => browser });
  await session.get();
  await assert.rejects(session.assertSwitchable(), /交卷.*123/);
  assert.equal(connected, true);
  pending = []; await session.assertSwitchable(); await session.close();
  assert.equal(session.state().kind, 'edge'); assert.equal(session.state().status, 'idle');
  assert.equal(session.state().catalog, 'idle');
});

test('a delayed disconnect from the previous Chrome connection cannot discard its replacement', async () => {
  const previous=new EventEmitter(), current=new EventEmitter();let previousConnected=true, connections=0;
  previous.isConnected=()=>previousConnected;current.isConnected=()=>true;
  previous.close=current.close=async()=>{};
  const session=createBrowserSession({connectBrowser:async()=>++connections===1?previous:current});
  try {
    assert.equal(await session.get(),previous);
    previousConnected=false;
    assert.equal(await session.get(),current);
    previous.emit('disconnected');
    assert.equal(session.state().status,'connected');
    assert.equal(await session.get(),current);
    assert.equal(connections,2,'a late event must not create a third consent request');
  } finally { await session.close(); }
});

test('debug setup refuses an unsupported Chrome internal URL launch instead of reporting success', async () => {
  const calls=[];
  const info={available:true,executable:'/fixture/Chrome',userDataDir:'/fixture/profile',profiles:[{directory:'Default'}],lastUsedProfile:'Default'};
  const session=createBrowserSession({discoverBrowser:async()=>info,openPages:async(urls,browser)=>{calls.push({urls,browser});return urls.map(url=>({url,ok:true}));}});
  await assert.rejects(session.open('debug'),/复制 chrome:\/\/inspect\/#remote-debugging/);
  assert.equal(calls.length,0,'do not dispatch a command known to open a blank tab');
  await session.open('site');
  assert.deepEqual(calls[0].urls,['https://www.uooc.net.cn/home/index']);
  assert.equal(calls[0].browser.profileDirectory,'Default');
  await session.close();
});

test('opening the site and reading courses preserve existing course and unrelated tabs', async t => {
  for (const kind of ['chrome', 'firefox']) await t.test(kind, async () => {
    const navigated = [], closed = [], created = [];
    const course = { url: () => courseURL('123'), goto: async () => assert.fail('must preserve the course tab') };
    const unrelated = { url: () => 'https://example.test/', goto: async () => assert.fail('must preserve unrelated tabs') };
    const pages = [course, unrelated];
    const context = { pages: () => pages, newPage: async () => {
      let url = 'about:blank';
      const page = { url: () => url, goto: async value => { url = value; navigated.push(value); }, bringToFront: async () => {},
        waitForFunction: async () => {}, evaluate: async () => [], close: async () => closed.push(page) };
      pages.push(page); created.push(page); return page;
    } };
    const browser = new EventEmitter(); browser.isConnected = () => true; browser.contexts = () => [context]; browser.close = async () => {};
    const session = createBrowserSession({ connectBrowser: async () => browser, getBrowserKind: () => kind });
    try {
      await session.get();
      await assert.rejects(session.courses(), /我的课程/);
      await session.open('site');
      assert.equal(created.length, 1, 'reuse the portal tab created for the catalog');
      assert.deepEqual(navigated, ['https://www.uooc.net.cn/home/index', 'https://www.uooc.net.cn/home/index']);
      assert.equal(closed.length, 0, 'keep the login/catalog tab open for manual login');
    } finally { await session.close(); }
  });
});

test('course startup reuses the original browser and stops without closing its user tabs', async t => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-original-browser-'));
  const configFile=path.join(dataDir,'api.json');await saveJSON(configFile,{...defaults,api_key:'original-browser-fixture-key'});
  let worker, newPages=0, newBrowsers=0, sourceClosed=false, ownedClosed=false;
  const portal={url:()=> 'https://www.uooc.net.cn/home/index',evaluate:async()=>({})};
  const ownedPage={url:()=>courseURL('123'),goto:async()=>worker.send({type:'command',action:'stop'}),close:async()=>{ownedClosed=true;}};
  const context={pages:()=>[portal],cookies:async()=>[],newPage:async()=>{newPages++;return ownedPage;}};
  const browser=new EventEmitter();browser.isConnected=()=>true;browser.contexts=()=>[context];browser.close=async()=>{sourceClosed=true;};
  const session=createBrowserSession({appDir,dataDir,connectBrowser:async()=>browser,launchCourseContext:async()=>{newBrowsers++;throw new Error('Unexpected new Chrome browser');}});
  t.after(async()=>{await session.close();await fs.rm(dataDir,{recursive:true,force:true});});
  worker=session.spawnWorker(process.execPath,[path.join(appDir,'controller.mjs'),courseURL('123'),'--config',configFile,'--data-dir',dataDir,'--console']);
  const code=await new Promise(resolve=>worker.once('exit',resolve));
  assert.equal(newBrowsers,0,'course startup must never launch a different Chrome process');
  assert.equal(code,0);assert.equal(newPages,1);assert.equal(ownedClosed,true);
  assert.equal(sourceClosed,false,'stopping a course must retain the source browser');
  let earlyWorker;
  const cancelled=createBrowserSession({appDir,dataDir,connectBrowser:async()=>{earlyWorker.send({type:'command',action:'stop'});return browser;}});
  earlyWorker=cancelled.spawnWorker(process.execPath,[path.join(appDir,'controller.mjs'),courseURL('123'),'--config',configFile,'--data-dir',dataDir,'--console']);
  assert.equal(await new Promise(resolve=>earlyWorker.once('exit',resolve)),0);
  assert.equal(newPages,1,'stopping during connection must not open another tab');
  await cancelled.close();
});
