import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runController } from '../controller.mjs';
import { defaults, saveJSON } from '../student/settings.mjs';
import { serviceFingerprint } from '../api-protocol.mjs';

const require = createRequire(import.meta.url);
const { chromium, firefox } = require('playwright');
const browserType = process.env.SZU_TEST_ENGINE === 'firefox' ? firefox : chromium;
const executablePath = browserType === firefox ? firefox.executablePath() : process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const waitFor = async (predicate, timeout=8000) => { for (let i=0;i<timeout/100;i++) { if (await predicate()) return; await new Promise(resolve=>setTimeout(resolve,100)); } throw new Error('Verification controller timed out'); };

const courseHTML = `<!doctype html><meta charset="utf-8"><title>验证回归课程</title><video id="player" src="/fixture.mp4" muted style="display:none"></video><iframe src="/exam/901" style="width:100%;height:700px;border:0"></iframe><script>
window.fixtureFinished=false;window.fixtureClicks=[];window.fixtureClickTimes=[];window.fixtureOpened=0;window.fixtureSubmits=0;window.fixtureFinishedVideos=[];window.fixtureAnswers=[];window.fixtureSubmissionStates=[];window.fixtureVideoStates=[];
new MutationObserver(()=>{
 const node=document.querySelector('#szu-uooc-course-state');if(!node)return;const state=JSON.parse(node.textContent);
 if(state.phase==='video'&&window.fixtureVideoStates.at(-1)!==state.sourceId)window.fixtureVideoStates.push(state.sourceId);
}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
const source={id:'900',task_id:'901',type:80,is_task:'1',finished:'0',name:'章节测验'};
const videos=Array.from({length:Number(window.fixtureWithVideo)||0},(_,i)=>({id:String(902+i),type:10,finished:'0',name:'视频 '+(i+1)}));
const sources=window.fixtureVideoFirst?[...videos,source]:[source,...videos];
const root={chapterList:[{id:'1',children:[{id:'2',unitSource:sources}]}]};
const service={getUnitLearn:async()=>sources.map(item=>({...item,finished:(item.id==='900'?window.fixtureFinished:window.fixtureFinishedVideos.includes(item.id))?'1':'0'}))};
const stateService={params:{courseId:'123',chapterId:'1',sectionId:'2',sourceId:'900'},go:async(_state,params)=>{
 Object.assign(stateService.params,params);history.replaceState(null,'','/home/learn/index#/123/1/2/'+params.sourceId+'/section');
 const video=document.querySelector('video');
 if(String(params.sourceId)!=='900'){document.querySelector('iframe')?.remove();video.src='/fixture.mp4?source='+params.sourceId;video.style.display='block';}
 else if(!document.querySelector('iframe')){video.style.display='none';const frame=document.createElement('iframe');frame.src='/exam/901';frame.style.cssText='width:100%;height:700px';document.body.appendChild(frame);}
}};
document.querySelector('video').addEventListener('ended',()=>{window.fixtureFinishedVideos.push(String(stateService.params.sourceId));});
const injector={get:name=>name==='$rootScope'?root:name==='courseService'?service:name==='$state'?stateService:null};
window.angular={element:node=>({injector:()=>injector,scope:()=>node.__scope})};
if(!window.fixtureNeedsAI)localStorage.setItem('szu-uooc:answers:123:'+JSON.stringify(['Native verification','10',['Correct','Wrong'],0]),JSON.stringify({answers:['Correct'],source:'fixture'}));
</script>`;
const examHTML = `<!doctype html><meta charset="utf-8"><style>body{margin:20px}#aliyunCaptcha-checkbox-icon{width:21px;height:21px;border:1px solid;display:block}</style>
<section class="queItems"><div class="queItems-type">单选题</div><div class="queContainer"><span class="index">1.</span><div class="ti-q-c">Native verification</div><label class="ti-a"><input type="radio" name="q" value="a"><span class="ti-a-c">Correct</span></label><label class="ti-a"><input type="radio" name="q" value="b"><span class="ti-a-c">Wrong</span></label></div></section><script>
const question={type:parent.fixtureQuestionType||'10',options:[{text:'Correct',key:'a'},{text:'Wrong',key:'b'}],student_answer:[],checked:false};
if(question.type==='11')for(const input of document.querySelectorAll('input'))input.type='checkbox';
const scope={vcode_params:{},vm:{task:{id:901,type:10},commitTask(){
 parent.fixtureOpened++;
 parent.fixtureAnswers.push(question.student_answer.slice());
 scope.vcode_params={};
 const dialog=document.querySelector('#commitConfirmDialog')||document.createElement('div');dialog.id='commitConfirmDialog';dialog.style.display='';dialog.innerHTML='<div id="sc"><span id="aliyunCaptcha-checkbox-icon"></span></div><button ng-click="vm.doCommitTask()">提交</button><button ng-click="vm.cancelCommitTask()">取消</button>';document.body.appendChild(dialog);
 dialog.querySelector('#aliyunCaptcha-checkbox-icon').onclick=event=>{
  parent.fixtureClicks.push(event.isTrusted);
  parent.fixtureClickTimes.push(Date.now());
  if(parent.fixtureRejectCount<0||parent.fixtureClicks.length<=parent.fixtureRejectCount)dialog.querySelector('#sc').textContent='验证失败，请刷新';
  else {scope.vcode_params.captchaVerifyParam='fixture-verification-result';dialog.querySelector('#sc').textContent='验证通过';}
 };
 dialog.querySelector('button').onclick=()=>{parent.fixtureSubmissionStates.push(JSON.parse(parent.document.querySelector('#szu-uooc-course-state').textContent));parent.fixtureSubmits++;parent.fixtureFinished=true;dialog.remove();};
 dialog.querySelector('[ng-click="vm.cancelCommitTask()"]').onclick=()=>{
  const close=()=>{dialog.style.display='none';parent.fixtureCloseFinished=true;};
  if(parent.fixtureCloseDelay)setTimeout(close,parent.fixtureCloseDelay);else close();
 };
 const manual=document.createElement('button');manual.textContent='模拟人工完成验证';dialog.appendChild(manual);
 manual.onclick=()=>{
  // This callback belongs only to the mocked website, never to the shipped app.
  const replacement={...scope,vcode_params:{captchaVerifyParam:'fixture-human-result'}};
  node.__scope.$parent=replacement;dialog.querySelector('#sc').textContent='验证通过';
 };
 const textOnly=document.createElement('button');textOnly.textContent='模拟只显示通过文字';dialog.appendChild(textOnly);
 textOnly.onclick=()=>{dialog.querySelector('#sc').textContent='验证通过';};
 const mismatch=document.createElement('button');mismatch.textContent='模拟其他任务验证';dialog.appendChild(mismatch);
 mismatch.onclick=()=>{node.__scope.$parent={...scope,vm:{...scope.vm,task:{id:7777,type:10}},vcode_params:{captchaVerifyParam:'fixture-other-task-result'}};};
},doCommitTask(){}}};
const node=document.querySelector('.queContainer');node.__scope={question,$parent:scope,$applyAsync(){}};
for(const input of document.querySelectorAll('input'))input.onchange=()=>{question.student_answer=[...document.querySelectorAll('input:checked')].map(node=>node.value);question.checked=question.student_answer.length>0;};
window.angular={element:node=>({scope:()=>node.__scope})};
</script>`;

async function fixture(t, { rejectCount=0, closeDelay=0, verify, followupVideo=false, videoFirst=false, observePage, focusBrowser, startupRedirect=false, fetchAPI, ledger, answerMode='ai', questionType='10', randomValue }={}) {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'szu-verification-controller-'));
  const browser=await browserType.launch({executablePath,headless:true});const context=await browser.newContext();
  const video=await fs.readFile(new URL('./fixtures/three-seconds.mp4',import.meta.url));
  await context.route('https://www.uooc.net.cn/**',route=>{const pathname=new URL(route.request().url()).pathname;return route.fulfill({contentType:pathname==='/fixture.mp4'?'video/mp4':'text/html',body:pathname==='/fixture.mp4'?video:pathname==='/exam/901'?examHTML:pathname==='/login'?'<script>setTimeout(()=>location.replace("/home/learn/index#/123/1/2/900/section"),400)</script>':courseHTML});});
  await context.addInitScript(value=>{window.fixtureRejectCount=value.rejectCount;window.fixtureCloseDelay=value.closeDelay;window.fixtureWithVideo=value.followupVideo;window.fixtureVideoFirst=value.videoFirst;window.fixtureNeedsAI=value.needsAI;window.fixtureQuestionType=value.questionType;if(value.randomValue!==undefined)Math.random=()=>value.randomValue;},{rejectCount,closeDelay,followupVideo,videoFirst,needsAI:Boolean(fetchAPI),questionType,randomValue});
  const page=await context.newPage();const url='https://www.uooc.net.cn/home/learn/index#/123/1/2/900/section';await page.goto(startupRedirect?'https://www.uooc.net.cn/login':url);
  const file=path.join(temp,'api.json');
  const config={...defaults,answer_mode:answerMode,api_key:answerMode==='free'?'':'verification-fixture-private-key'};
  if(answerMode==='ai'&&fetchAPI){config.profile={id:config.model,wire_api:'responses',reasoning_effort:'medium',pricing:config.pricing,verified_text:true};config.detection={fingerprint:serviceFingerprint(config.base_url,config.api_key)};config.service_status='ready';}
  await saveJSON(file,config);
  if(ledger)await saveJSON(path.join(temp,'ledger/course-123.json'),ledger);
  const commands=new EventEmitter(),states=[];
  const running=runController({args:[url,'--config',file,'--data-dir',temp,'--console','--resume-billing'],browser,page,commands,verify,observePage,focusBrowser,onState:message=>states.push(message.state),log:()=>{},fetchAPI:fetchAPI||(async()=>{throw new Error('fixture must not request a paid API');})});
  running.catch(()=>{});
  t.after(async()=>{commands.emit('message',{type:'command',action:'stop'});await browser.close();await running.catch(()=>{});await fs.rm(temp,{recursive:true,force:true});});
  return {page,commands,states,running,temp,file,url};
}

test('free mode fills missing choice answers without a Key, reuses them on verification retry and never caches random answers',async t=>{
  let calls=0;
  const {page,states,running,temp}=await fixture(t,{answerMode:'free',rejectCount:1,followupVideo:true,fetchAPI:async()=>{calls++;throw new Error('free mode must not use a provider');}});
  await waitFor(()=>states.some(state=>['complete','paused'].includes(state.phase)),20000);
  assert.equal(states.at(-1).phase,'complete',states.at(-1).error);await running;
  const answers=await page.evaluate(()=>window.fixtureAnswers);
  assert.equal(answers.length,2);assert.equal(answers[0].length,1);assert(['a','b'].includes(answers[0][0]));assert.deepEqual(answers[1],answers[0]);
  assert.equal(calls,0);assert.equal(states.at(-1).completed,2);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(key=>key.startsWith('szu-uooc:answers:123:'))),false,'guesses cannot become trusted cache entries');
  assert.equal(await fs.stat(path.join(temp,'ledger/course-123.json')).catch(()=>null),null,'free learning cannot create a provider ledger');
});

test('free mode keeps known answers and leaves missing fill answers for a human',async t=>{
  const known=await fixture(t,{answerMode:'free'});
  await waitFor(()=>known.states.some(state=>state.phase==='complete'));await known.running;
  assert.deepEqual(await known.page.evaluate(()=>window.fixtureAnswers),[['a']],'the known answer wins over random guessing');
  let calls=0;
  const missing=await fixture(t,{answerMode:'free',questionType:'30',fetchAPI:async()=>{calls++;throw new Error('missing fill answers must not use a provider');}});
  await waitFor(()=>missing.states.some(state=>state.phase==='paused'));
  assert.match(missing.states.at(-1).error,/免费.*填空|填空.*人工/);
  assert.equal(await missing.page.evaluate(()=>window.fixtureSubmits),0);assert.equal(calls,0);
});

for(const [questionType,randomValue,expected] of [['11',0.1,['a','b']],['11',0.99,['b']],['20',0.1,['a']]])test('free mode maps '+questionType+' random '+randomValue+' to native option ids without an empty answer',async t=>{
  let calls=0;
  const {page,states,running}=await fixture(t,{answerMode:'free',questionType,randomValue,fetchAPI:async()=>{calls++;throw new Error('no paid requests in free mode');}});
  await waitFor(()=>states.some(state=>['complete','paused'].includes(state.phase)));
  assert.equal(states.at(-1).phase,'complete',states.at(-1).error);await running;
  assert.deepEqual(await page.evaluate(()=>window.fixtureAnswers),[expected]);assert.equal(calls,0);
});

test('manual console start and resume recover reserved 502s, while a new 502 still pauses before another paid attempt', async t=>{
  const old={id:'historical-502',status:'unknown',http_status:502,reserved_nanos:1363500};let calls=0;
  const {commands,states,running,temp}=await fixture(t,{ledger:{courseId:'123',unit:'provider_USD_credit',model:defaults.model,requests:[old]},fetchAPI:async(_url,options)=>{
    const prompt=JSON.parse(options.body).input;assert.match(prompt,/"type":"single"/);assert.match(prompt,/multiple为多选.*全部正确选项/);
    calls++;return calls===1?new Response('Bad Gateway',{status:502}):new Response(JSON.stringify({model:defaults.model,status:'completed',usage:{input_tokens:10,output_tokens:1},output:[{content:[{type:'output_text',text:JSON.stringify({answers:[{index:0,answers:['Correct']}]})}]}]}));
  }});
  await waitFor(()=>states.some(state=>state.phase==='paused'&&/HTTP 502/.test(state.error)));assert.equal(calls,1);
  commands.emit('message',{type:'command',action:'resume'});
  try { await waitFor(()=>states.some(state=>state.phase==='complete'),16000); }
  catch(error) { throw new Error(error.message+' '+JSON.stringify({calls,states})); }
  await running;assert.equal(calls,2);
  const ledger=JSON.parse(await fs.readFile(path.join(temp,'ledger/course-123.json'),'utf8'));
  assert.deepEqual(ledger.requests[0],old);assert(ledger.requests[1].reserved_nanos>0);assert.equal(ledger.requests[2].status,'known');
  assert.deepEqual(ledger.requests[2].resumed_unknown_requests,[old.id,ledger.requests[1].id]);
});

test('managed controller automatically recovers a streamed answer timeout and completes the quiz and next video without resume',async t=>{
  let calls=0;
  const {page,states,running,temp}=await fixture(t,{followupVideo:true,fetchAPI:async()=>{
    if(++calls===1){let sent=false;return new Response(new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(new TextEncoder().encode(': ok\n\n'));}else controller.error(new DOMException('fixture timeout','TimeoutError'));}}));}
    return new Response(JSON.stringify({model:defaults.model,status:'completed',usage:{input_tokens:10,output_tokens:1},output:[{content:[{type:'output_text',text:JSON.stringify({answers:[{index:0,answers:['Correct']}]})}]}]}));
  }});
  await waitFor(()=>states.some(state=>['complete','paused'].includes(state.phase)),30000);
  assert.equal(states.at(-1).phase,'complete',states.at(-1).error);await running;
  assert(!states.some(state=>state.phase==='paused'));assert.equal(calls,2);assert.equal(states.at(-1).completed,2);assert.equal(await page.evaluate(()=>window.fixtureSubmits),1);
  const ledger=JSON.parse(await fs.readFile(path.join(temp,'ledger/course-123.json'),'utf8'));
  assert.equal(ledger.requests[0].status,'unknown');assert(ledger.requests[0].reserved_nanos>0);assert.equal(ledger.requests[1].status,'known');assert.deepEqual(ledger.requests[1].resumed_unknown_requests,[ledger.requests[0].id]);
});

test('managed controller retries failed native verification without resume or another paid answer and continues the course', async t=>{
  let calls=0;
  const {page,states,running}=await fixture(t,{rejectCount:1,followupVideo:true,fetchAPI:async()=>{
    calls++;return new Response(JSON.stringify({model:defaults.model,status:'completed',usage:{input_tokens:10,output_tokens:1},output:[{content:[{type:'output_text',text:JSON.stringify({answers:[{index:0,answers:['Correct']}]})}]}]}));
  }});
  await waitFor(()=>page.evaluate(()=>window.fixtureClicks.length===1).catch(()=>false));
  const firstRun=states.find(state=>state.phase==='awaiting_verification').runId;
  await waitFor(()=>states.some(state=>state.phase==='complete'),20000);
  await running;
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[true,true],'each attempt uses one real browser input event');
  const times=await page.evaluate(()=>window.fixtureClickTimes);assert(times[1]-times[0]>=5000,'a failure waits at least five seconds before retrying');
  assert(states.filter(state=>state.phase==='awaiting_verification').every(state=>state.runId===firstRun),'retry keeps the same course run');
  assert(!states.some(state=>state.phase==='paused'),'verification failure must not pause the course');
  assert.equal(calls,1,'retry reuses the answer without another paid request');
  assert.equal(states.at(-1).completed,2,'the following video also completes');
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),1,'verification retries never duplicate the final submission');
});

test('verification retry waits for delayed native close before reusing the same dialog',async t=>{
  let calls=0;
  const {page,states,running}=await fixture(t,{answerMode:'free',rejectCount:1,closeDelay:200,followupVideo:true,fetchAPI:async()=>{calls++;throw new Error('free retry cannot request a paid answer');}});
  await waitFor(()=>states.some(state=>['complete','paused'].includes(state.phase)),20000);
  assert.equal(states.at(-1).phase,'complete',states.at(-1).error);await running;
  assert.equal(await page.evaluate(()=>window.fixtureCloseFinished),true);
  assert.equal(await page.evaluate(()=>window.fixtureOpened),2,'one failed attempt and one reopened native dialog');
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[true,true]);
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),1,'retry must not duplicate submission');
  const answers=await page.evaluate(()=>window.fixtureAnswers);assert.deepEqual(answers[1],answers[0]);
  assert.equal(calls,0,'the free answer is reused without any paid request');
  assert.equal(states.at(-1).completed,2,'the following video completes without resume');
  assert(!states.some(state=>state.phase==='paused'));
});

for(const action of ['pause','stop'])test(action+' during native dialog closing cancels its scheduled reopen',async t=>{
  const {page,commands,states,running}=await fixture(t,{rejectCount:1,closeDelay:1000});
  await waitFor(()=>page.evaluate(()=>/5秒后/.test(JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent||'{}').error)));
  await page.frame({url:'https://www.uooc.net.cn/exam/901'}).evaluate(()=>{
    const cancel=document.querySelector('[ng-click="vm.cancelCommitTask()"]'),close=cancel.onclick;
    cancel.onclick=()=>{parent.fixtureClosing=true;close();};
  });
  await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+60000;});
  await waitFor(()=>page.evaluate(()=>window.fixtureClosing===true));
  commands.emit('message',{type:'command',action});
  await waitFor(()=>page.evaluate(()=>!JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).active));
  await new Promise(resolve=>setTimeout(resolve,1300));
  assert.equal(await page.evaluate(()=>window.fixtureOpened),1,'a cancelled run cannot reopen after the close animation');
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),0);
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[true]);
  if(action==='stop')await running;else assert(states.some(state=>state.phase==='paused'));
});

test('a native dialog that never closes pauses after the bounded wait without reopening',async t=>{
  const {page,states}=await fixture(t,{rejectCount:1});
  await waitFor(()=>page.evaluate(()=>/5秒后/.test(JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent||'{}').error)));
  await page.frame({url:'https://www.uooc.net.cn/exam/901'}).locator('[ng-click="vm.cancelCommitTask()"]').evaluate(node=>node.onclick=()=>{});
  await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+60000;});
  await waitFor(()=>states.some(state=>state.phase==='paused'),12000);
  assert.match(states.at(-1).error,/旧验证弹窗尚未关闭/);
  assert.equal(await page.evaluate(()=>window.fixtureOpened),1);
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),0);
});

test('repeated verification failures wait the full backoff and pause after three reopen attempts', async t=>{
  const {page,states}=await fixture(t,{rejectCount:-1});
  const error=()=>page.evaluate(()=>JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent||'{}').error);
  await waitFor(async()=>/5秒后/.test(await error()));
  await page.evaluate(()=>{window.fixtureNow=Date.now();Date.now=()=>window.fixtureNow;window.fixtureNow+=1800001;});
  await waitFor(async()=>/10秒后/.test(await error()));
  for(const [delay,next] of [[10000,20],[20000,0]]){
    const opened=await page.evaluate(()=>window.fixtureOpened);
    await page.evaluate(ms=>window.fixtureNow+=ms,delay-1);
    await new Promise(resolve=>setTimeout(resolve,750));
    assert.equal(await page.evaluate(()=>window.fixtureOpened),opened,'retry must wait the whole backoff interval');
    await page.evaluate(()=>window.fixtureNow++);
    await waitFor(()=>page.evaluate(count=>window.fixtureOpened===count,opened+1));
    if(next)await waitFor(async()=>new RegExp(next+'秒后').test(await error()));
    else await waitFor(()=>states.some(state=>state.phase==='paused'&&/重试已达上限/.test(state.error)));
  }
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),0,'repeated failures cannot authorize a submission');
  assert.equal(await page.evaluate(()=>window.fixtureOpened),4,'one initial dialog plus three bounded reopens');
  await page.evaluate(()=>window.fixtureNow+=1800001);
  await new Promise(resolve=>setTimeout(resolve,750));
  assert.equal(await page.evaluate(()=>window.fixtureOpened),4,'exhausted retries cannot restart themselves');
  assert.equal(states.at(-1).active,false);
});

test('human verification during a pending retry submits once without reopening', async t=>{
  const {page,states,running}=await fixture(t,{rejectCount:-1});
  await waitFor(()=>page.evaluate(()=>/5秒后/.test(JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent||'{}').error)));
  await page.frame({url:'https://www.uooc.net.cn/exam/901'}).getByRole('button',{name:'模拟人工完成验证'}).click();
  await waitFor(()=>states.some(state=>state.phase==='complete'));await running;
  assert.equal(await page.evaluate(()=>window.fixtureOpened),1);
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),1);
  assert.equal(states.at(-1).error,'');
});

test('verification retry restores answers after the same quiz iframe and its answer model are replaced',async t=>{
  let calls=0;
  const {page,states,running}=await fixture(t,{rejectCount:1,fetchAPI:async()=>{
    calls++;return new Response(JSON.stringify({model:defaults.model,status:'completed',usage:{input_tokens:10,output_tokens:1},output:[{content:[{type:'output_text',text:JSON.stringify({answers:[{index:0,answers:['Correct']}]})}]}]}));
  }});
  await waitFor(()=>page.evaluate(()=>/5秒后/.test(JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent||'{}').error)));
  await page.locator('iframe').evaluate(node=>node.replaceWith(node.cloneNode(false)));
  const radio=page.frameLocator('iframe').getByRole('radio').first();await radio.waitFor();
  assert.equal(await radio.isChecked(),false,'the reloaded quiz starts with an empty answer model');
  await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+60000;});
  await waitFor(()=>states.some(state=>state.phase==='complete'),16000);await running;
  const answer=await page.frame({url:'https://www.uooc.net.cn/exam/901'}).evaluate(()=>document.querySelector('.queContainer').__scope.question);
  assert.deepEqual(answer.student_answer,['a']);assert.equal(answer.checked,true);
  assert.equal(calls,1,'the restored answer comes from the existing quiz, without another paid request');
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),1);
  assert(!states.some(state=>state.phase==='paused'));
});

test('human verification during retry answer synchronization keeps its new scope result',async t=>{
  const {page,states,running}=await fixture(t,{rejectCount:-1});
  await waitFor(()=>page.evaluate(()=>/5秒后/.test(JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent||'{}').error)));
  await page.frame({url:'https://www.uooc.net.cn/exam/901'}).evaluate(()=>{
    const scope=document.querySelector('.queContainer').__scope;
    scope.$applyAsync=()=>{scope.$applyAsync=()=>{};[...document.querySelectorAll('button')].find(node=>node.textContent==='模拟人工完成验证').click();};
  });
  await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+60000;});
  await waitFor(()=>states.some(state=>state.phase==='complete'),16000);await running;
  assert.equal(await page.evaluate(()=>window.fixtureOpened),1,'the human result is read from the replacement scope');
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),1);
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[true]);
});

for(const action of ['pause','stop'])test(action+' cancels a scheduled verification retry',async t=>{
  const {page,commands,states,running}=await fixture(t,{rejectCount:-1});
  await waitFor(()=>page.evaluate(()=>/5秒后/.test(JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent||'{}').error)));
  commands.emit('message',{type:'command',action});
  await waitFor(()=>page.evaluate(()=>!JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent||'{}').active));
  await page.evaluate(()=>{const now=Date.now();Date.now=()=>now+60000;});
  await new Promise(resolve=>setTimeout(resolve,1000));
  assert.equal(await page.evaluate(()=>window.fixtureOpened),1,'cancelled retries cannot reopen verification');
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),0);
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[true]);
  if(action==='stop')await running;
  else assert(states.some(state=>state.phase==='paused'));
});

test('changed questions cannot reopen verification using an earlier answer',async t=>{
  const {page,states}=await fixture(t,{rejectCount:-1});
  await waitFor(()=>page.evaluate(()=>/5秒后/.test(JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent||'{}').error)));
  await page.frame({url:'https://www.uooc.net.cn/exam/901'}).getByText('Native verification',{exact:true}).evaluate(node=>node.textContent='Different question');
  await page.evaluate(()=>{const now=Date.now();Date.now=()=>now+60000;});
  await waitFor(()=>states.some(state=>state.phase==='paused'&&/题目.*变化/.test(state.error)));
  assert.equal(await page.evaluate(()=>window.fixtureOpened),1);
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),0);
});

test('a transient native click error keeps the controller connected and retries after five seconds',async t=>{
  const attempts=[];
  const {page,states,running}=await fixture(t,{verify:async click=>{
    attempts.push(Date.now());if(attempts.length===1)throw new Error('验证控件被裁剪或遮挡，未发送点击');return click();
  }});
  await waitFor(()=>states.some(state=>state.phase==='complete'),16000);await running;
  assert.equal(attempts.length,2);assert(attempts[1]-attempts[0]>=5000);
  assert(!states.some(state=>state.phase==='paused'));
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[true]);
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),1);
});

test('a delayed click from an older verification attempt cannot click a reopened widget',async t=>{
  let release,waiting=false,oldResult,calls=0;
  const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  const {page,states,running}=await fixture(t,{verify:async click=>{
    calls++;if(calls===1){waiting=true;await gate;oldResult=await click();return oldResult;}return click();
  }});
  await waitFor(()=>waiting);
  await page.frame({url:'https://www.uooc.net.cn/exam/901'}).locator('#sc').evaluate(node=>node.textContent='验证失败，请刷新');
  await waitFor(()=>page.evaluate(()=>/5秒后/.test(JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).error)));
  await page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+60000;});
  await waitFor(()=>page.evaluate(()=>window.fixtureOpened===2));release();
  await waitFor(()=>states.some(state=>state.phase==='complete'));await running;
  assert.equal(oldResult,false,'the old verification attempt must be cancelled before native input');
  assert.equal(calls,2,'the new attempt owns its own verification click');
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[true]);
});

test('the same quiz iframe can be replaced while waiting for AI and receives its answers without another request', async t=>{
  let release, requested;const gate=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>requested=resolve);let calls=0;t.after(()=>release());
  const {page,states,running}=await fixture(t,{fetchAPI:async()=>{
    calls++;requested();await gate;return new Response(JSON.stringify({model:defaults.model,status:'completed',usage:{input_tokens:10,output_tokens:1},output:[{content:[{type:'output_text',text:JSON.stringify({answers:[{index:0,answers:['Correct']}]})}]}]}));
  }});
  await seen;await page.locator('iframe').evaluate(node=>node.replaceWith(node.cloneNode(false)));
  await page.frameLocator('iframe').getByText('Native verification',{exact:true}).waitFor();release();
  try { await waitFor(()=>states.some(state=>state.phase==='complete'),16000); }
  catch(error) { throw new Error(error.message+' '+JSON.stringify({calls,states})); }
  await running;assert.equal(calls,1);assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[true]);
});

test('replacing a quiz with different question text while AI is pending cannot apply or submit the earlier answer', async t=>{
  let release,requested;const gate=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>requested=resolve);t.after(()=>release());
  const {page,states}=await fixture(t,{fetchAPI:async()=>{
    requested();await gate;return new Response(JSON.stringify({model:defaults.model,status:'completed',usage:{input_tokens:10,output_tokens:1},output:[{content:[{type:'output_text',text:JSON.stringify({answers:[{index:0,answers:['Correct']}]})}]}]}));
  }});
  await seen;await page.locator('iframe').evaluate(node=>node.replaceWith(node.cloneNode(false)));
  const label=page.frameLocator('iframe').getByText('Native verification',{exact:true});await label.waitFor();await label.evaluate(node=>node.textContent='Different question');release();
  await waitFor(()=>states.some(state=>state.phase==='paused'),16000);
  assert.match(states.at(-1).error,/题目.*变化|任务不匹配/);
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[]);
  assert.equal(await page.frameLocator('iframe').getByRole('radio').first().isChecked(),false);
});

test('stopping while a verification action is awaiting approval prevents its later click', async t=>{
  let release;const approved=new Promise(resolve=>release=resolve);let waiting=false;
  t.after(()=>release());
  const {page,commands,running}=await fixture(t,{verify:async click=>{waiting=true;await approved;return click();}});
  await waitFor(()=>waiting);
  commands.emit('message',{type:'command',action:'stop'});
  await waitFor(()=>page.evaluate(()=>JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).active===false));
  release();await running;
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[]);
});

test('a human verification callback that replaces the page model continues the same task without restart', async t=>{
  const {page,states,running}=await fixture(t,{verify:async()=>false,followupVideo:true});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  const runId=states.find(state=>state.phase==='awaiting_verification').runId;
  const exam=page.frame({url:'https://www.uooc.net.cn/exam/901'});
  await exam.getByRole('button',{name:'模拟只显示通过文字'}).click();
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(await page.evaluate(()=>window.fixtureFinished),false,'display text alone cannot authorize submission');
  await exam.getByRole('button',{name:'模拟人工完成验证'}).click();
  try { await waitFor(()=>states.some(state=>state.phase==='complete'),16000); }
  catch(error) { throw new Error(error.message+' '+JSON.stringify(states.slice(-6).map(({phase,sourceId,error})=>({phase,sourceId,error})))); }
  await running;
  assert.equal(states.at(-1).completed,2);
  // A short video can finish between controller polls, especially in Firefox.
  assert.deepEqual(await page.evaluate(()=>window.fixtureFinishedVideos),['902'],'human verification continues into the next course resource');
  assert.equal(states.filter(state=>state.phase==='awaiting_verification').length,1,'the human callback must not reopen the quiz');
  const submitted=await page.evaluate(()=>window.fixtureSubmissionStates);
  assert.equal(submitted.length,1,'the native submit event occurs once');
  assert.equal(submitted[0].phase,'submitting');assert.equal(submitted[0].runId,runId);assert.equal(submitted[0].pendingSubmit,true,'the same run saves its journal before native submission');
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[],'the test never completes a real CAPTCHA');
});

test('a native verification callback can retain the course source id instead of the exam id', async t=>{
  const {page,states,running}=await fixture(t,{verify:async()=>false});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  const exam=page.frame({url:'https://www.uooc.net.cn/exam/901'});
  await exam.evaluate(()=>document.querySelector('.queContainer').__scope.$parent.vm.task.id=900);
  await exam.getByRole('button',{name:'模拟人工完成验证'}).click();
  await waitFor(()=>states.some(state=>state.phase==='complete'));
  await running;
  assert.equal(states.at(-1).completed,1);
});

test('a fast human submit waits for delayed platform completion after verification state is cleared', async t=>{
  const {page,states,running}=await fixture(t,{verify:async()=>false,followupVideo:true});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  await page.frame({url:'https://www.uooc.net.cn/exam/901'}).evaluate(()=>{
    const submit=document.querySelector('[ng-click="vm.doCommitTask()"]'),nativeSubmit=submit.onclick;
    submit.onclick=()=>{
      nativeSubmit();parent.fixtureFinished=false;
      document.querySelector('.queContainer').__scope.$parent.vcode_params={};
      setTimeout(()=>parent.fixtureFinished=true,5000);
    };
    [...document.querySelectorAll('button')].find(node=>node.textContent==='模拟人工完成验证').click();
    submit.click();
  });
  await waitFor(()=>states.some(state=>['complete','paused'].includes(state.phase)),20000);
  assert.equal(states.at(-1).phase,'complete',states.at(-1).error);await running;
  assert(!states.some(state=>state.phase==='paused'),'a closed submitted dialog must wait for platform confirmation');
  assert.equal(states.at(-1).completed,2);
  assert((await page.evaluate(()=>window.fixtureVideoStates)).includes('902'),'the next course video starts without resume');
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),1,'a human submission cannot be submitted again');
  assert.equal(await page.evaluate(()=>window.fixtureOpened),1,'waiting for platform completion cannot reopen verification');
  assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[],'the test never completes a real CAPTCHA');
});

test('a fast human submit after quiz iframe replacement waits for platform completion without reopening',async t=>{
  let clicks=0;
  const {page,states,running}=await fixture(t,{rejectCount:1,verify:async click=>++clicks===1?click():false,followupVideo:true});
  await waitFor(()=>page.evaluate(()=>/5秒后/.test(JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent||'{}').error)));
  await page.locator('iframe').evaluate(node=>node.replaceWith(node.cloneNode(false)));
  await page.frameLocator('iframe').getByRole('radio').first().waitFor();
  await page.evaluate(()=>{const now=Date.now;window.fixtureDateNow=now;Date.now=()=>now()+60000;});
  await waitFor(()=>page.evaluate(()=>window.fixtureOpened===2));
  await page.evaluate(()=>{Date.now=window.fixtureDateNow;});
  await page.frame({url:'https://www.uooc.net.cn/exam/901'}).evaluate(()=>{
    const submit=document.querySelector('[ng-click="vm.doCommitTask()"]'),nativeSubmit=submit.onclick;
    submit.onclick=()=>{
      nativeSubmit();parent.fixtureFinished=false;
      document.querySelector('.queContainer').__scope.$parent.vcode_params={};
      setTimeout(()=>parent.fixtureFinished=true,8000);
    };
    [...document.querySelectorAll('button')].find(node=>node.textContent==='模拟人工完成验证').click();
    submit.click();
  });
  await waitFor(()=>states.some(state=>['complete','paused'].includes(state.phase)),24000);
  assert.equal(states.at(-1).phase,'complete',states.at(-1).error);await running;
  assert(!states.some(state=>state.phase==='paused'));
  assert.equal(states.at(-1).completed,2);
  assert((await page.evaluate(()=>window.fixtureVideoStates)).includes('902'));
  const submitted=await page.evaluate(()=>window.fixtureSubmissionStates);
  assert.equal(submitted.length,1);assert.equal(submitted[0].pendingSubmit,true,'the new document records submission before native handling clears verification');
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),1);
  assert.equal(await page.evaluate(()=>window.fixtureOpened),2,'submission cannot reopen verification a third time');
});

test('explicitly cancelling native verification still pauses without submitting', async t=>{
  const {page,states}=await fixture(t,{verify:async()=>false});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  await page.frame({url:'https://www.uooc.net.cn/exam/901'}).getByRole('button',{name:'取消',exact:true}).click();
  await waitFor(()=>states.some(state=>state.phase==='paused'),8000);
  assert.match(states.at(-1).error,/验证弹窗已关闭|取消/);
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),0);
  assert.equal(await page.evaluate(()=>window.fixtureOpened),1);
});

test('briefly hidden native verification can return after the dialog has been open for three seconds', async t=>{
  const {page,states,running}=await fixture(t,{verify:async()=>false,followupVideo:true});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  await new Promise(resolve=>setTimeout(resolve,3100));
  const exam=page.frame({url:'https://www.uooc.net.cn/exam/901'});
  await exam.locator('#commitConfirmDialog').evaluate(node=>node.style.display='none');
  await new Promise(resolve=>setTimeout(resolve,1000));
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),0,'a hidden dialog cannot authorize a submission');
  await exam.locator('#commitConfirmDialog').evaluate(node=>node.style.display='');
  await exam.getByRole('button',{name:'模拟人工完成验证'}).click();
  await waitFor(()=>states.some(state=>['complete','paused'].includes(state.phase)),16000);
  assert.equal(states.at(-1).phase,'complete',states.at(-1).error);await running;
  assert(!states.some(state=>state.phase==='paused'),'a brief disappearance after a long wait must not pause verification');
  assert.equal(states.at(-1).completed,2);
  assert((await page.evaluate(()=>window.fixtureVideoStates)).includes('902'));
  assert.equal(await page.evaluate(()=>window.fixtureSubmits),1);
  assert.equal(await page.evaluate(()=>window.fixtureOpened),1);
});

test('a verification callback from another task cannot submit the current quiz', async t=>{
  const {page,states}=await fixture(t,{verify:async()=>false});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  await page.frame({url:'https://www.uooc.net.cn/exam/901'}).getByRole('button',{name:'模拟其他任务验证'}).click();
  await waitFor(()=>states.some(state=>state.phase==='paused'&&/验证回调.*不匹配/.test(state.error)));
  assert.equal(await page.evaluate(()=>window.fixtureFinished),false);
});

test('stopping an original course tab cancels a pending observational hook without closing the tab', async t=>{
  let release,blocked=false;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  const {page,commands,running}=await fixture(t,{verify:async()=>false,observePage:async(_page,state)=>{if(state.phase==='awaiting_verification'){blocked=true;await gate;}}});
  await waitFor(()=>blocked);
  commands.emit('message',{type:'command',action:'stop'});
  const stopped=await Promise.race([running.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1000))]);
  assert.equal(stopped,true,'observation must not hold the original Chrome worker after stop');
  assert.equal(page.isClosed(),false);
});

test('stop takes priority over a pending focus command and preserves the original course tab', async t=>{
  let release,focused=false;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  const {page,commands,states,running}=await fixture(t,{verify:async()=>false,focusBrowser:async()=>{focused=true;await gate;}});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  commands.emit('message',{type:'command',action:'focus'});await waitFor(()=>focused);
  commands.emit('message',{type:'command',action:'stop'});
  const stopped=await Promise.race([running.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),3000))]);
  assert.equal(stopped,true,'focus must not hold the stop command in the queue');
  assert.equal(page.isClosed(),false);
  assert.equal(await page.evaluate(()=>JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).active),false);
});

test('refreshing a paused original course keeps its error and progress instead of reporting idle as running', async t=>{
  const {page,commands,states}=await fixture(t,{verify:async()=>false});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  commands.emit('message',{type:'command',action:'pause'});
  await waitFor(()=>states.some(state=>state.phase==='paused'&&state.error==='用户暂停'));
  const paused=states.at(-1), before=states.length;
  await page.reload({waitUntil:'domcontentloaded'});
  await new Promise(resolve=>setTimeout(resolve,2600));
  const reset=states.at(-1);
  assert.equal(reset.phase,'paused','a fresh idle script must not erase the paused state');
  assert.equal(reset.active,false);
  assert.equal(reset.error,paused.error);
  assert.equal(reset.total,paused.total);
  assert.equal(reset.currentTitle,paused.currentTitle);
  commands.emit('message',{type:'command',action:'resume'});
  await waitFor(()=>states.slice(before).some(state=>state.phase==='awaiting_verification'));
});

test('a second copy of the course script cannot overwrite a live runner with idle state', async t=>{
  const {page,states}=await fixture(t,{verify:async()=>false});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  const before=states.at(-1);
  let timeout;
  try {
    await Promise.race([
      page.addScriptTag({content:await fs.readFile(new URL('../szu-uooc.user.js',import.meta.url),'utf8')}),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('duplicate script locked the renderer')),1500);}),
    ]);
  } finally { clearTimeout(timeout); }
  await new Promise(resolve=>setTimeout(resolve,2500));
  const current=await page.locator('#szu-uooc-course-state').textContent().then(JSON.parse);
  assert.equal(current.phase,'awaiting_verification','the duplicate scan must not publish its own idle state');
  assert.equal(current.runId,before.runId);
  assert.equal(current.active,true);
});

test('refreshing an active course still resumes its saved task without a new paid request', async t=>{
  const {page,commands,states}=await fixture(t,{verify:async()=>false});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  const before=states.length, previous=states.at(-1);
  await page.reload({waitUntil:'domcontentloaded'});
  await waitFor(async()=>JSON.parse(await page.locator('#szu-uooc-course-state').textContent()).phase==='awaiting_verification');
  const reset=JSON.parse(await page.locator('#szu-uooc-course-state').textContent());
  assert.equal(reset.active,true);
  assert.equal(reset.total,previous.total);
  assert.equal(reset.currentTitle,previous.currentTitle);
  assert(!states.slice(before).some(state=>state.phase==='idle'));
  assert.equal(await page.evaluate(()=>window.fixtureFinished),false);
});

test('stopping and restarting on the same original tab leaves only one managed script and binding', async t=>{
  const {page,commands,states,running,temp,file,url}=await fixture(t,{verify:async()=>false});
  await waitFor(()=>states.some(state=>state.phase==='awaiting_verification'));
  commands.emit('message',{type:'command',action:'stop'});
  await running;
  const nextCommands=new EventEmitter(), nextStates=[];
  const restarted=runController({args:[url,'--config',file,'--data-dir',temp,'--console','--resume-billing'],
    browser:page.context().browser(),page,commands:nextCommands,verify:async()=>false,
    onState:message=>nextStates.push(message.state),log:()=>{},
    fetchAPI:async()=>{throw new Error('fixture must not request a paid API');}});
  let failure;
  restarted.catch(error=>failure=error);
  t.after(async()=>{nextCommands.emit('message',{type:'command',action:'stop'});await restarted.catch(()=>{});});
  await waitFor(()=>failure||nextStates.some(state=>state.phase==='awaiting_verification'));
  if(failure) throw failure;
  assert.equal(await page.locator('#szu-uooc-auto-player-controls').count(),1);
  nextCommands.emit('message',{type:'command',action:'stop'});
  await restarted;
  assert.equal(page.isClosed(),false);
});

test('an original course tab can finish its login redirect before the controller validates its URL', async t=>{
  const {states,running}=await fixture(t,{verify:async()=>false,startupRedirect:true});
  await Promise.race([running,waitFor(()=>states.some(state=>state.phase==='awaiting_verification'))]);
  assert(states.some(state=>state.phase==='awaiting_verification'));
});

test('three videos naturally end in sequence and the following chapter quiz completes without external clicks',async t=>{
 const {page,states,running}=await fixture(t,{followupVideo:3,videoFirst:true});
 await Promise.race([running,waitFor(()=>states.some(s=>s.phase==='complete'),30000)]);
 await running;
 assert.equal(states.at(-1).phase,'complete');assert.equal(states.at(-1).completed,4);assert.equal(states.at(-1).total,4);
 assert.deepEqual(await page.evaluate(()=>window.fixtureFinishedVideos),['902','903','904']);
 const sequence=await page.evaluate(()=>window.fixtureVideoStates);assert.deepEqual(sequence,['902','903','904'],'observe real DOM transitions, including videos shorter than the controller polling interval');
 assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[true]);
 assert.equal(await page.evaluate(()=>window.fixtureFinished),true,'the mocked platform must confirm the quiz was submitted');
});

test('native verification scroll timeouts keep retrying past three attempts and finish the next video', async t => {
  const attempts = []; let calls = 0;
  const { page, states, running } = await fixture(t, { followupVideo: true, verify: async click => {
    attempts.push(Date.now());
    if (attempts.length <= 3) { const error = new Error('locator.scrollIntoViewIfNeeded: Timeout 5000ms exceeded.'); error.name = 'TimeoutError'; throw error; }
    return click();
  }, fetchAPI: async () => {
    calls++; return new Response(JSON.stringify({model:defaults.model,status:'completed',usage:{input_tokens:10,output_tokens:1},output:[{content:[{type:'output_text',text:JSON.stringify({answers:[{index:0,answers:['Correct']}]})}]}]}));
  } });
  await waitFor(() => states.some(state => ['complete', 'paused'].includes(state.phase)), 55000);
  assert.equal(states.at(-1).phase, 'complete', states.at(-1).error); await running;
  assert.equal(attempts.length, 4);
  assert(attempts[1] - attempts[0] >= 5000);
  assert(attempts[2] - attempts[1] >= 10000);
  assert(attempts[3] - attempts[2] >= 20000);
  assert(!states.some(state => state.phase === 'paused'));
  assert.equal(calls, 1, 'native control retries must reuse the paid answer');
  assert.deepEqual(await page.evaluate(() => window.fixtureClicks), [true]);
  assert.equal(await page.evaluate(() => window.fixtureSubmits), 1);
  assert.equal(await page.evaluate(() => window.fixtureOpened), 1, 'the same verification dialog remains active');
  assert.equal(states.at(-1).completed, 2);
  assert.deepEqual(await page.evaluate(() => window.fixtureFinishedVideos), ['902']);
});

for (const action of ['pause', 'stop']) test(action + ' cancels native verification input retries during backoff', async t => {
  const attempts = [];
  const { page, commands, states, running } = await fixture(t, { verify: async () => {
    attempts.push(Date.now()); const error = new Error('locator.scrollIntoViewIfNeeded: Timeout 5000ms exceeded.'); error.name = 'TimeoutError'; throw error;
  } });
  await waitFor(() => attempts.length === 1);
  commands.emit('message', { type: 'command', action });
  await waitFor(() => page.evaluate(() => !JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).active));
  await new Promise(resolve => setTimeout(resolve, 6200));
  assert.equal(attempts.length, 1, 'a cancelled verification retry cannot send another click');
  assert.equal(await page.evaluate(() => window.fixtureSubmits), 0);
  assert.deepEqual(await page.evaluate(() => window.fixtureClicks), []);
  assert.equal(await page.evaluate(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).active), false);
  if (action === 'stop') await running;
  else assert(states.some(state => state.phase === 'paused' && state.error === '用户暂停'));
});

test('manual console start preserves historical streamed and pre-header reservations while completing the course', async t => {
  const previous = [
    { id: 'historical-stream-timeout', status: 'unknown', http_status: 200, failure_stage: 'receiving', failure_type: 'TimeoutError', reserved_nanos: 1363500 },
    { id: 'historical-pre-header-disconnect', status: 'unknown', failure_stage: 'connecting', failure_type: 'TypeError', reserved_nanos: 1363500 },
  ];
  let calls = 0;
  const { page, states, running, temp } = await fixture(t, { followupVideo: true,
    ledger: { courseId: '123', unit: 'provider_USD_credit', model: defaults.model, requests: previous },
    fetchAPI: async () => {
      calls++;
      return new Response(JSON.stringify({ model: defaults.model, status: 'completed', usage: { input_tokens: 10, output_tokens: 1 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ answers: [{ index: 0, answers: ['Correct'] }] }) }] }] }));
    },
  });
  await waitFor(() => states.some(state => ['complete', 'paused'].includes(state.phase)), 16000);
  assert.equal(states.at(-1).phase, 'complete', states.at(-1).error); await running;
  assert.equal(calls, 1); assert.equal(states.at(-1).completed, 2);
  assert.equal(await page.evaluate(() => window.fixtureSubmits), 1);
  const ledger = JSON.parse(await fs.readFile(path.join(temp, 'ledger/course-123.json'), 'utf8'));
  assert.deepEqual(ledger.requests.slice(0, 2), previous, 'manual start must preserve every unknown request and its full reservation');
  assert.equal(ledger.requests.length, 3); assert.equal(ledger.requests[2].status, 'known');
  assert.deepEqual(ledger.requests[2].resumed_unknown_requests, previous.map(entry => entry.id));
});

test('a new pre-header disconnect stays paused until manual console resume and then completes the course', async t => {
  let calls = 0;
  const { page, commands, states, running, temp } = await fixture(t, { followupVideo: true, fetchAPI: async () => {
    if (++calls === 1) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ model: defaults.model, status: 'completed', usage: { input_tokens: 10, output_tokens: 1 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ answers: [{ index: 0, answers: ['Correct'] }] }) }] }] }));
  } });
  await waitFor(() => states.some(state => state.phase === 'paused'));
  assert.match(states.at(-1).error, /结果或费用未知/);
  const file = path.join(temp, 'ledger/course-123.json');
  const paused = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(paused.requests.length, 1);
  assert.equal(paused.requests[0].status, 'unknown'); assert.equal(paused.requests[0].http_status, undefined);
  assert.equal(paused.requests[0].failure_stage, 'connecting'); assert.equal(paused.requests[0].failure_type, 'TypeError');
  assert(paused.requests[0].reserved_nanos > 0);
  await new Promise(resolve => setTimeout(resolve, 11000));
  assert.equal(calls, 1, 'a failure before headers must not retry automatically after the stream recovery interval');
  assert.equal(states.at(-1).phase, 'paused'); assert.equal(await page.evaluate(() => window.fixtureSubmits), 0);
  commands.emit('message', { type: 'command', action: 'resume' });
  await waitFor(() => states.some(state => state.phase === 'complete'), 16000); await running;
  assert.equal(calls, 2); assert.equal(states.at(-1).completed, 2);
  assert.equal(await page.evaluate(() => window.fixtureSubmits), 1);
  const resumed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(resumed.requests[0], paused.requests[0], 'manual resume must retain the failed request reservation');
  assert.equal(resumed.requests.length, 2); assert.equal(resumed.requests[1].status, 'known');
  assert.deepEqual(resumed.requests[1].resumed_unknown_requests, [paused.requests[0].id]);
});
