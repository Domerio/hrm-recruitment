import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {recommendGreetingAction} from '../extension/recommend-greeting.mjs';

const withBounds=node=>Object.defineProperty(node,'getBoundingClientRect',{
  configurable:true,value:()=>({left:10,top:10,right:210,bottom:110,width:200,height:100}),
});

function fixture({kind='canvas',userId='9007199254740993',accountId='123456',status=0}={}) {
  const {document}=parseHTML(`<html><body><div class="dialog-lib-resume"><div class="resume-root">
    <div class="resume-detail-wrap">${kind==='canvas'?'<iframe src="https://www.zhipin.com/web/frame/c-resume/?source=recommend"></iframe>':'<div class="resume-left">简历</div>'}</div>
    <div class="button-chat-wrap"><button type="button">打招呼</button></div>
    </div></div></body></html>`);
  const element=document.querySelector('.resume-root'),frame=document.querySelector('iframe');
  const control=document.querySelector('.button-chat-wrap'),button=control.querySelector('button');
  for (const node of document.querySelectorAll('*')) withBounds(node);
  const base={name:'测试候选人',userId,encryptGeekId:'encrypted_candidate_a',geekSource:0};
  const root={$options:{name:'ResumeRoot'},$el:element,$refs:{iframe:frame},loading:false,
    currGeek:{encryptGeekId:base.encryptGeekId,geekSource:0},dataSource:{encryptGeekId:base.encryptGeekId},
    resumeInfo:{geekBaseInfo:base,friend:false},utils:{_PAGE:{uid:accountId}}};
  const person={encryptGeekId:base.encryptGeekId,geekId:userId,encryptJobId:'encrypted_job_a',geekSource:0};
  const chat={$options:{name:'ButtonChat'},$el:control,$parent:root,personInfo:person,dataSource:person,
    currJob:{jobName:'工业工程师'},jobId:'fallback_job',status,statusModule:status,
    isPreview:false,isFriend:false,canClickGreet:true,isLoadding:false,jobSecurityList:[]};
  root.param={currJob:chat.currJob};root.dataSource.encryptJobId=person.encryptJobId;
  element.__vue__={$options:{name:'Layout'},$el:element,$parent:root};control.__vue__=chat;
  let forbiddenCalls=0,clicks=0,clock=1000,random=0,sleeps=0;
  const forbidden=()=>{forbiddenCalls++;throw Error('PRIVATE securityId=secret lid=private');};
  for (const value of [base,root.currGeek,root.dataSource,person,chat]) {
    for (const key of ['securityId','lid','greet','greetingMsg']) Object.defineProperty(value,key,{get:forbidden});
  }
  for (const key of ['chatStop','greeingHandle','greeingHandleV2','checkJob','checkJobV2','setFriend']) chat[key]=forbidden;
  let onClick=()=>{button.textContent='继续沟通';chat.isFriend=true;},onSleep=()=>{};
  button.click=()=>{clicks++;onClick();};
  document.elementFromPoint=()=>button;
  const location={href:'https://www.zhipin.com/web/frame/recommend'};
  const window={document,location,_PAGE:{uid:accountId}};window.top=window;window.parent=window;
  const context=vm.createContext({window,document,location,URL,
    getComputedStyle:node=>({display:node.style.display||'block',visibility:node.style.visibility||'visible',
      opacity:node.style.opacity||'1',pointerEvents:node.style.pointerEvents||'auto'}),
    crypto:{getRandomValues:array=>{for(let i=0;i<array.length;i++)array[i]=++random;return array;}},
    Date:{now:()=>clock},setTimeout:(resolve,ms)=>{clock+=ms;sleeps++;onSleep();resolve();},
    fetch:forbidden,XMLHttpRequest:forbidden,WebSocket:forbidden});
  const args={name:base.name,kind,expected_platform_geek_id:base.encryptGeekId,
    expected_boss_chat_uid:String(userId),expected_account_uid:String(accountId),expected_job_title:chat.currJob.jobName};
  const invoke=async values=>{
    context.args=values;
    // Imports/lexical closures are deliberately absent, as with executeScript.
    const result=await vm.runInContext(`(${recommendGreetingAction.toString()})(args)`,context);
    assert.equal(forbiddenCalls,0);
    return JSON.parse(JSON.stringify(result));
  };
  const call=(action,overrides={})=>invoke({...args,action,...overrides});
  return {document,root,base,frame,element,button,control,chat,person,window,context,args,call,invoke,
    get clicks(){return clicks;},get sleeps(){return sleeps;},
    onClick:callback=>{onClick=callback;},onSleep:callback=>{onSleep=callback;},advance:ms=>{clock+=ms;}};
}

const identities=f=>({account_uid:f.args.expected_account_uid,boss_chat_uid:f.args.expected_boss_chat_uid,
  platform_geek_id:f.args.expected_platform_geek_id,candidate_name:f.base.name});

test('account is a read-only list action with a strict numeric logged-in account',async()=>{
  const f=fixture();f.document.body.innerHTML='';
  assert.deepEqual(await f.call('account'),{ok:true,status:'available',account_uid:'123456'});
  f.window._PAGE.uid=9007199254740992;
  assert.equal((await f.call('account')).reason,'account_missing');
  f.window._PAGE.uid='encrypted_id';assert.equal((await f.call('account')).reason,'account_missing');
  f.context.location.href='https://evil.example/web/frame/recommend';
  assert.equal((await f.call('account')).reason,'unsupported_page');assert.equal(f.clicks,0);
});

test('serialized prepare only binds identities, job, component and token; send clicks once',async()=>{
  const f=fixture(),ready=await f.call('prepare');
  assert.deepEqual(ready,{ok:true,status:'ready',token:ready.token,...identities(f)});
  assert.match(ready.token,/^[a-f0-9]{32}$/);assert.equal(f.clicks,0);
  assert.deepEqual(await f.call('send',{token:ready.token}),{ok:true,status:'confirmed',attempted:true,...identities(f)});
  assert.equal(f.clicks,1);
  assert.equal((await f.call('send',{token:ready.token})).status,'confirmed');assert.equal(f.clicks,1);
});

test('text detail and normal status 1 use the same explicit binding',async()=>{
  const f=fixture({kind:'text',userId:765432,status:1}),ready=await f.call('prepare');
  assert.equal(ready.status,'ready');
  assert.equal((await f.call('send',{token:ready.token})).status,'confirmed');assert.equal(f.clicks,1);
});

test('collector-supported geek, chat and owner-frame recommendation routes are permitted',async()=>{
  for(const path of ['/web/geek/recommend','/web/chat/recommend','/web/frame/recommend']) {
    const f=fixture();f.context.location.href='https://www.zhipin.com'+path;
    assert.equal((await f.call('account')).status,'available');assert.equal((await f.call('prepare')).status,'ready');
    assert.equal(f.clicks,0);
  }
});

test('already-friend and bound continue controls never click',async()=>{
  for(const mutate of [f=>{f.root.resumeInfo.friend=true;},f=>{f.button.textContent='继续沟通';},
    f=>{f.chat.isFriend=1;},f=>{f.person.isFriend=1;}]) {
    const f=fixture();mutate(f);
    assert.deepEqual(await f.call('prepare'),{ok:true,status:'already',attempted:false,...identities(f)});
    assert.equal(f.clicks,0);
  }
});

test('timeout consumes the token and identity permanently for the document, including reset',async()=>{
  const f=fixture();f.onClick(()=>{});
  const ready=await f.call('prepare');
  assert.equal((await f.call('send',{token:ready.token})).reason,'confirmation_timeout');
  assert.equal(f.sleeps,80);assert.equal(f.clicks,1);
  assert.equal((await f.call('send',{token:ready.token})).status,'uncertain');
  await f.call('reset');
  assert.equal((await f.call('prepare')).status,'uncertain');
  assert.equal((await f.call('status',{token:ready.token})).status,'uncertain');assert.equal(f.clicks,1);
});

test('status can observe a late bound continue state without clicking again',async()=>{
  const f=fixture();f.onClick(()=>{});const ready=await f.call('prepare');
  await f.call('send',{token:ready.token});f.button.textContent='继续沟通';
  assert.equal((await f.call('status',{token:ready.token})).status,'confirmed');assert.equal(f.clicks,1);
});

test('stop revokes unused tokens, and reset never revives them',async()=>{
  const f=fixture(),ready=await f.call('prepare');await f.call('stop');
  assert.deepEqual(await f.call('send',{token:ready.token}),{ok:false,status:'blocked',attempted:false,
    reason:'stopped',error:'自动打招呼已停止，未发送。'});
  await f.call('reset');assert.equal((await f.call('send',{token:ready.token})).status,'blocked');
  assert.equal(f.clicks,0);
});

test('stop during polling remains uncertain even if a new run resets immediately',async()=>{
  const f=fixture();f.onClick(()=>{});const ready=await f.call('prepare');
  f.onSleep(()=>{const state=f.window.__hrmRecommendGreetingStateV1;state.stopped=true;state.generation++;state.stopped=false;});
  const result=await f.call('send',{token:ready.token});
  assert.equal(result.status,'uncertain');assert.equal(result.reason,'stopped');assert.equal(f.clicks,1);
  assert.equal(f.sleeps,1);assert.equal((await f.call('prepare')).status,'uncertain');
});

test('changed accounts, candidate IDs, names, source, frames and roots fail before dispatch',async()=>{
  for(const mutate of [f=>{f.window._PAGE.uid='222';},f=>{f.root.utils._PAGE.uid='222';},
    f=>{f.base.userId='222';},f=>{f.base.encryptGeekId='another';},f=>{f.base.name='另一人';},
    f=>{f.root.currGeek.encryptGeekId='another';},f=>{f.person.encryptGeekId='another';},
    f=>{f.person.geekId='222';},f=>{f.person.geekSource=1;},f=>{f.base.geekSource=1;},
    f=>{f.frame.src='https://www.zhipin.com/web/frame/c-resume/?source=changed';},
    f=>{f.root.$refs.iframe=f.document.createElement('iframe');},f=>{f.root.loading=true;},
    f=>{f.element.__vue__.$parent={...f.root};},f=>{f.control.__vue__={...f.chat};},
    f=>{f.context.location.href='https://www.zhipin.com/web/chat/index';}]) {
    const f=fixture(),ready=await f.call('prepare');assert.equal(ready.status,'ready');mutate(f);
    const result=await f.call('send',{token:ready.token});
    assert.equal(result.status,'blocked');assert.equal(result.attempted,false);assert.equal(f.clicks,0);
  }
});

test('ButtonChat actual job and configured title must both remain bound',async()=>{
  for(const mutate of [f=>{f.chat.currJob.jobName='视觉算法工程师';},f=>{f.person.encryptJobId='other_job';},
    f=>{f.chat.currJob={};},f=>{f.chat.status=f.chat.statusModule=5;},
    f=>{f.chat.jobSecurityList=[{encryptJobId:'a'},{encryptJobId:'b'}];}]) {
    const f=fixture(),ready=await f.call('prepare');mutate(f);
    const result=await f.call('send',{token:ready.token});
    assert.equal(result.status,'blocked');assert.match(result.reason,/^job_/);assert.equal(f.clicks,0);
  }
  const f=fixture();f.chat.currJob.jobName=' 工业 工程师 ';
  assert.equal((await f.call('prepare')).status,'ready');
  assert.equal((await f.call('prepare',{expected_job_title:''})).reason,'job_unconfirmed');
});

test('dynamic job selection, preview, absent job evidence and unrelated button components are blocked',async()=>{
  for(const mutate of [f=>{f.chat.status=f.chat.statusModule=2;},f=>{f.chat.status=f.chat.statusModule=4;},
    f=>{f.chat.status=f.chat.statusModule=5;},f=>{f.chat.status=f.chat.statusModule=6;},
    f=>{f.chat.status=f.chat.statusModule=8;},f=>{f.chat.status=f.chat.statusModule=9;},
    f=>{delete f.chat.status;},f=>{f.chat.isPreview=true;},f=>{f.chat.statusModule=1;},
    f=>{f.person.encryptJobId='';f.chat.jobId='';},f=>{f.person.encryptJobId='invalid job';},
    f=>{delete f.control.__vue__;},f=>{f.chat.$el=f.document.body;},
    f=>{f.chat.$options.name='UnrelatedButton';}]) {
    const f=fixture();mutate(f);assert.equal((await f.call('prepare')).status,'blocked');assert.equal(f.clicks,0);
  }
});

test('native fallback jobId is used only when personInfo.encryptJobId is absent',async()=>{
  const f=fixture();delete f.person.encryptJobId;
  const ready=await f.call('prepare');assert.equal(ready.status,'ready');
  f.chat.jobId='changed_fallback';assert.equal((await f.call('send',{token:ready.token})).reason,'job_changed');
  assert.equal(f.clicks,0);
});

test('duplicate, invisible, disabled, occluded and replaced controls are never clicked',async()=>{
  for(const mutate of [f=>{const b=f.button.cloneNode(true);withBounds(b);f.control.append(b);},
    f=>{f.button.style.display='none';},f=>{f.button.disabled=true;},f=>{f.button.classList.add('btn-gray');},
    f=>{f.button.setAttribute('aria-disabled','true');},f=>{f.chat.canClickGreet=false;},
    f=>{f.control.style.opacity='0';},f=>{f.button.style.opacity='0';},
    f=>{f.control.setAttribute('inert','');},f=>{f.control.style.pointerEvents='none';},
    f=>{f.chat.isLoadding=true;},f=>{f.document.elementFromPoint=()=>f.document.body;},
    f=>{const b=f.button.cloneNode(true);withBounds(b);f.button.replaceWith(b);},
    f=>{const d=f.document.querySelector('.dialog-lib-resume').cloneNode(true);
      for(const n of [d,...d.querySelectorAll('*')])withBounds(n);f.document.body.append(d);}]) {
    const f=fixture(),ready=await f.call('prepare');mutate(f);
    assert.equal((await f.call('send',{token:ready.token})).status,'blocked');assert.equal(f.clicks,0);
  }
});

test('changed identity, frame, or job after dispatch yields uncertainty and never retries',async()=>{
  for(const mutate of [f=>{f.base.userId='222';},f=>{f.person.encryptJobId='changed';},
    f=>{f.chat.currJob.jobName='别的职位';},f=>{f.frame.remove();},f=>{f.window._PAGE.uid='222';}]) {
    const f=fixture(),ready=await f.call('prepare');f.onClick(()=>mutate(f));
    assert.equal((await f.call('send',{token:ready.token})).status,'uncertain');
    assert.equal((await f.call('send',{token:ready.token})).status,'uncertain');assert.equal(f.clicks,1);
  }
});

test('friend flag alone after dispatch is not a confirmed greeting',async()=>{
  const f=fixture();f.onClick(()=>{f.root.resumeInfo.friend=true;});
  const ready=await f.call('prepare');
  assert.equal((await f.call('send',{token:ready.token})).status,'uncertain');assert.equal(f.clicks,1);
});

test('bound canvas refresh waits for the recreated ButtonChat continue control before confirming',async()=>{
  const f=fixture();let sleeps=0;
  f.onClick(()=>{f.root.loading=true;f.root.resumeInfo.friend=true;f.control.remove();});
  f.onSleep(()=>{
    if(++sleeps!==3)return;
    const replacement=f.control.cloneNode(true),button=replacement.querySelector('button');
    for(const node of [replacement,...replacement.querySelectorAll('*')])withBounds(node);
    button.textContent='继续沟通';replacement.__vue__={...f.chat,$el:replacement,isFriend:true};
    f.element.append(replacement);f.root.loading=false;
  });
  const ready=await f.call('prepare'),result=await f.call('send',{token:ready.token});
  assert.deepEqual(result,{ok:true,status:'confirmed',attempted:true,...identities(f)});
  assert.equal(sleeps,3);assert.equal(f.clicks,1);
  assert.equal((await f.call('status',{token:ready.token})).status,'confirmed');
  assert.equal((await f.call('send',{token:ready.token})).status,'confirmed');assert.equal(f.clicks,1);
});

test('loading never enables a greeting before dispatch',async()=>{
  const f=fixture();f.root.loading=true;
  assert.equal((await f.call('prepare')).reason,'loading');assert.equal(f.clicks,0);
  f.root.loading=false;const ready=await f.call('prepare');f.root.loading=true;
  assert.equal((await f.call('send',{token:ready.token})).reason,'loading');assert.equal(f.clicks,0);
});

test('loading still rejects account, root, candidate, iframe and actual job changes immediately',async()=>{
  for(const mutate of [f=>{f.window._PAGE.uid='222';},f=>{f.root.utils._PAGE.uid='222';},
    f=>{f.base.userId='222';},f=>{f.base.encryptGeekId='other';},f=>{f.root.currGeek.encryptGeekId='other';},
    f=>{f.root.param.currJob.jobName='另一岗位';},f=>{f.root.dataSource.encryptJobId='other_job';},
    f=>{f.root.param.currJob={jobName:f.chat.currJob.jobName};},
    f=>{f.root.$refs.iframe=f.document.createElement('iframe');},
    f=>{f.frame.src='https://www.zhipin.com/web/frame/c-resume/?source=other';},
    f=>{f.element.__vue__.$parent={...f.root};}]) {
    const f=fixture(),ready=await f.call('prepare');
    f.onClick(()=>{f.root.loading=true;f.control.remove();});f.onSleep(()=>mutate(f));
    const result=await f.call('send',{token:ready.token});
    assert.equal(result.status,'uncertain');assert.notEqual(result.reason,'confirmation_timeout');
    assert.equal(f.clicks,1);assert.equal(f.sleeps,1);
    assert.equal((await f.call('send',{token:ready.token})).status,'uncertain');assert.equal(f.clicks,1);
  }
});

test('stop interrupts a loading wait and does not revive an attempted token',async()=>{
  const f=fixture(),ready=await f.call('prepare');
  f.onClick(()=>{f.root.loading=true;f.control.remove();});
  f.onSleep(()=>{const state=f.window.__hrmRecommendGreetingStateV1;state.stopped=true;state.generation++;});
  assert.equal((await f.call('send',{token:ready.token})).reason,'stopped');
  assert.equal(f.sleeps,1);await f.call('reset');
  assert.equal((await f.call('send',{token:ready.token})).status,'uncertain');assert.equal(f.clicks,1);
});

test('loading consumes only the existing confirmation timeout and never confirms stale friend state',async()=>{
  const f=fixture(),ready=await f.call('prepare');
  f.onClick(()=>{f.root.loading=true;f.root.resumeInfo.friend=true;f.control.remove();});
  assert.equal((await f.call('send',{token:ready.token})).reason,'confirmation_timeout');
  assert.equal(f.sleeps,80);assert.equal(f.clicks,1);
  await f.call('reset');assert.equal((await f.call('send',{token:ready.token})).status,'uncertain');
  assert.equal(f.clicks,1);
});

test('an unobserved button replacement and a wrong identity after loading remain uncertain',async()=>{
  for(const observeLoading of [false,true]) {
    const f=fixture(),ready=await f.call('prepare');
    const replace=()=>{
      const replacement=f.control.cloneNode(true),button=replacement.querySelector('button');
      for(const node of [replacement,...replacement.querySelectorAll('*')])withBounds(node);
      button.textContent='继续沟通';replacement.__vue__={...f.chat,$el:replacement,
        personInfo:observeLoading?{...f.person,geekId:'222'}:f.person};
      f.control.replaceWith(replacement);f.root.loading=false;
    };
    f.onClick(()=>{if(observeLoading)f.root.loading=true;else replace();});
    f.onSleep(replace);
    assert.equal((await f.call('send',{token:ready.token})).status,'uncertain');assert.equal(f.clicks,1);
  }
});

test('click exceptions and page getter failures expose fixed text, not secrets',async()=>{
  const f=fixture(),ready=await f.call('prepare');
  f.onClick(()=>{throw Error('PRIVATE securityId=secret');});
  const uncertain=await f.call('send',{token:ready.token});assert.equal(uncertain.status,'uncertain');
  assert.doesNotMatch(JSON.stringify(uncertain),/PRIVATE|secret|stack/);
  assert.equal((await f.call('send',{token:ready.token})).status,'uncertain');assert.equal(f.clicks,1);
  const g=fixture();Object.defineProperty(g.root,'resumeInfo',{get:()=>{throw Error('PRIVATE');}});
  const blocked=await g.call('prepare');assert.equal(blocked.reason,'read_failed');
  assert.doesNotMatch(JSON.stringify(blocked),/PRIVATE|stack/);assert.equal(g.clicks,0);
});

test('tokens expire, cannot be transferred across documents, and cannot change expected identity',async()=>{
  const f=fixture(),ready=await f.call('prepare');f.advance(120001);
  assert.equal((await f.call('send',{token:ready.token})).reason,'token_invalid');
  const g=fixture();assert.equal((await g.call('send',{token:ready.token})).reason,'token_invalid');
  const h=fixture(),other=await h.call('prepare');
  assert.equal((await h.call('send',{token:other.token,expected_boss_chat_uid:'777'})).reason,'identity_changed');
  assert.equal((await h.call('send',{token:other.token,expected_job_title:'其他岗位'})).reason,'identity_changed');
  assert.equal(f.clicks+g.clicks+h.clicks,0);
});

test('unsafe numbers, absent expected fields, and missing source never become a send permission',async()=>{
  for(const overrides of [{expected_boss_chat_uid:9007199254740992},{expected_boss_chat_uid:'encrypted'},
    {expected_account_uid:''},{expected_platform_geek_id:''},{name:''},{kind:'unknown'}]) {
    const f=fixture();assert.equal((await f.call('prepare',overrides)).status,'blocked');assert.equal(f.clicks,0);
  }
  const f=fixture();delete f.base.geekSource;delete f.root.currGeek.geekSource;
  assert.equal((await f.call('prepare')).reason,'source_unconfirmed');assert.equal(f.clicks,0);
});

test('a synchronous identity replacement during reads is rejected',async()=>{
  const f=fixture(),initial=f.root.resumeInfo;let reads=0;
  Object.defineProperty(f.root,'resumeInfo',{get:()=>++reads===1?initial:{...initial}});
  assert.equal((await f.call('prepare')).reason,'detail_changed');assert.equal(f.clicks,0);
});

test('read-only status on an unused ready token never sends',async()=>{
  const f=fixture(),ready=await f.call('prepare');
  assert.equal((await f.call('status',{token:ready.token})).status,'ready');assert.equal(f.clicks,0);
});
