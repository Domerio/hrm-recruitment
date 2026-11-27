import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {readRecommendChatEntry} from '../extension/recommend-chat-entry.mjs';

const withBounds = node => Object.defineProperty(node, 'getBoundingClientRect', {
  configurable:true, writable:true, value:()=>({width:500,height:300}),
});

function fixture({kind='canvas',uid='9007199254740993',cardId='encrypted_candidate_a'}={}) {
  const {document} = parseHTML(`<html><body><div class="dialog-lib-resume"><div class="resume-root">
    <div class="resume-detail-wrap">${kind==='canvas'?'<iframe src="https://www.zhipin.com/web/frame/c-resume/?source=recommend"></iframe>':'<div class="resume-left">简历正文</div>'}</div>
    </div></div></body></html>`);
  const element=document.querySelector('.resume-root'),frame=document.querySelector('iframe');
  for (const node of document.querySelectorAll('*')) withBounds(node);
  const base={name:'测试候选人',userId:uid,encryptGeekId:cardId};
  const root={$options:{name:'ResumeRoot'},$el:element,$refs:{iframe:frame},loading:false,
    currGeek:{encryptGeekId:cardId},dataSource:{encryptGeekId:cardId},resumeInfo:{geekBaseInfo:base}};
  element.__vue__={$options:{name:'Layout'},$el:element,$parent:root};
  let forbiddenCalls=0;
  const forbidden=()=>{forbiddenCalls++;throw Error('Forbidden action or private value access');};
  for (const record of [root.currGeek,root.dataSource,base]) {
    Object.defineProperty(record,'securityId',{get:forbidden});
    Object.defineProperty(record,'lid',{get:forbidden});
  }
  root.getDetails=forbidden;root.openChat=forbidden;
  const context=vm.createContext({document,location:{href:'https://www.zhipin.com/web/chat/recommend'},URL,
    getComputedStyle:node=>({display:node.style.display||'block',visibility:node.style.visibility||'visible'}),
    fetch:forbidden,XMLHttpRequest:forbidden,WebSocket:forbidden});
  const args={name:base.name,kind,expected_platform_geek_id:cardId};
  const readArgs=value=>{
    context.args=value;
    // Emulate chrome.scripting's serialized function: imports/closure are absent.
    const result=vm.runInContext(`(${readRecommendChatEntry.toString()})(args)`,context);
    assert.equal(forbiddenCalls,0);
    return JSON.parse(JSON.stringify(result));
  };
  const read=(overrides={})=>readArgs({...args,...overrides});
  return {document,root,base,frame,element,context,args,read,readArgs};
}

test('serialized MAIN reader obtains the exact long UID from the bound canvas resume only',()=>{
  const f=fixture();
  assert.deepEqual(f.read(),{ok:true,status:'available',boss_chat_uid:'9007199254740993',
    platform_geek_id:'encrypted_candidate_a',candidate_name:'测试候选人'});
});

test('text resume uses the same verified field when a scoped ResumeRoot exists',()=>{
  const f=fixture({kind:'text',uid:123456});
  assert.equal(f.read().boss_chat_uid,'123456');
  f.element.__vue__=null;
  assert.equal(f.read().status,'unavailable');
});

test('encrypted IDs, unsafe numbers and absent user IDs never become a chat UID',()=>{
  for (const uid of ['encrypted_candidate_a',9007199254740992,'00123','123&source=1',0,undefined,'123456789012345678901']) {
    const f=fixture({uid});
    if(uid===undefined)delete f.base.userId;
    const result=f.read();
    assert.equal(result.status,'unavailable');assert.equal(result.boss_chat_uid,undefined);
  }
});

test('a missing selected card identity never falls back to name or a global page UID',()=>{
  const f=fixture();f.context.uid='123456';
  const result=f.read({expected_platform_geek_id:''});
  assert.equal(result.status,'unavailable');assert.equal(result.boss_chat_uid,undefined);
});

test('same-name card swaps and mismatched detail identities fail closed',()=>{
  for (const change of [f=>f.base.encryptGeekId='another_candidate',f=>f.root.currGeek.encryptGeekId='another_candidate',
    f=>f.root.dataSource.encryptGeekId='another_candidate',f=>f.base.name='另一位候选人']) {
    const f=fixture();change(f);const result=f.read();
    assert.equal(result.ok,false);assert.equal(result.status,'identity-conflict');assert.equal(result.boss_chat_uid,undefined);
  }
});

test('another iframe or hidden/off-site detail cannot supply an identity',()=>{
  for (const change of [f=>f.root.$refs.iframe=f.document.createElement('iframe'),
    f=>f.frame.setAttribute('src','https://other.example/web/frame/c-resume/'),
    f=>f.frame.setAttribute('src','https://www.zhipin.com/web/frame/other'),
    f=>f.document.querySelector('.dialog-lib-resume').style.display='none',
    f=>f.context.location.href='https://other.example/web/chat/recommend']) {
    const f=fixture();change(f);const result=f.read();
    assert.equal(result.status,'unavailable');assert.equal(result.boss_chat_uid,undefined);
  }
});

test('multiple visible details or multiple current frames are conflicts',()=>{
  for(const selector of ['.dialog-lib-resume','iframe']) {
    const f=fixture(),node=f.document.querySelector(selector),duplicate=node.cloneNode(true);
    for(const el of [duplicate,...duplicate.querySelectorAll('*')])withBounds(el);
    node.parentElement.append(duplicate);
    assert.equal(f.read().status,'identity-conflict');
  }
});

test('loading and component replacement do not expose stale candidate links',()=>{
  const f=fixture();f.root.loading=true;
  assert.equal(f.read().reason,'detail_loading');f.root.loading=false;
  const old=f.root.resumeInfo;let reads=0;
  Object.defineProperty(f.root,'resumeInfo',{get:()=>++reads===1?old:{geekBaseInfo:{...f.base,userId:'777'}}});
  assert.equal(f.read().status,'identity-conflict');
});

test('a second read after a same-name replacement cannot reuse the first candidate link',()=>{
  const f=fixture();assert.equal(f.read().status,'available');
  f.root.resumeInfo={geekBaseInfo:{name:f.base.name,userId:'222',encryptGeekId:'another_candidate'}};
  f.root.currGeek={encryptGeekId:'another_candidate'};f.root.dataSource={encryptGeekId:'another_candidate'};
  assert.equal(f.read().status,'identity-conflict');
});

test('a matching UID outside the current detail is ignored',()=>{
  const f=fixture();f.element.__vue__=null;
  f.document.body.__vue__=f.root;
  const unrelated=f.document.createElement('div');unrelated.className='other-resume';
  withBounds(unrelated);f.document.body.append(unrelated);
  f.root.$el=unrelated;
  assert.equal(f.read().status,'unavailable');
});

test('unexpected page getter failures expose only a fixed diagnostic stage, never exception contents',()=>{
  const fail=()=>{throw Error('PRIVATE securityId=secret lid=private candidate=hidden uid=333333333333');};
  const cases=[
    ['argument_validation',f=>({run:()=>f.readArgs(new Proxy(f.args,{get:fail}))})],
    ['page_validation',f=>Object.defineProperty(f.context.location,'href',{get:fail})],
    ['detail_lookup',f=>{f.context.getComputedStyle=fail;}],
    ['frame_binding',f=>{f.frame.getAttribute=fail;}],
    ['vue_lookup',f=>Object.defineProperty(f.element,'__vue__',{get:fail})],
    ['resume_fields',f=>Object.defineProperty(f.root,'resumeInfo',{get:fail})],
    ['identity_binding',f=>Object.defineProperty(f.base,'encryptGeekId',{get:fail})],
    ['final_recheck',f=>{const resume=f.root.resumeInfo;let reads=0;
      Object.defineProperty(f.root,'resumeInfo',{get:()=>++reads===1?resume:fail()});}],
  ];
  for (const [stage,mutate] of cases) {
    const f=fixture(),custom=mutate(f),result=custom?.run?custom.run():f.read();
    assert.deepEqual(result,{ok:true,status:'unavailable',reason:'read_failed',stage});
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|secret|candidate|333333333333|stack|message/);
  }
});
