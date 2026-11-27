import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {chatPageAction, fetchChatAttachment} from '../extension/chat-actions.mjs';
import {installChatMessageSource} from '../extension/chat-message-source.mjs';
import {readCommunicationPage} from '../extension/communications-reader.mjs';

const target = {friend_id:'101', platform_job_id:'JOB-1', platform_geek_id:'GEEK-101'};
const second = {friend_id:'202', platform_job_id:'JOB-1', platform_geek_id:'GEEK-202'};
const card = (changes = {}) => ({mid:55, from:{uid:101, source:0}, to:{uid:999}, body:{hyperLink:{hyperLinkType:9,
  title:'张三.pdf', url:'bosszp://bosszhipin.app/openwith?type=selectResumePreviewUrl&encryptId=RESUME-55&authType=0'}}, ...changes});

function fixture({selected = '101', messages = [], html = '<button id="online">查看在线简历</button>', fetchImpl} = {}) {
  const {document, window} = parseHTML(`<html><body><div class="chat-user"><div data-friend-id="101" data-job-id="JOB-1"><span>张三</span></div><div data-friend-id="202" data-job-id="JOB-1"><span>张三</span></div></div><div class="chat-conversation" data-friend-id="${selected}">${html}</div><div class="chat-editor"></div></body></html>`);
  delete window.__hrmChatMessageSource;
  Object.defineProperty(document, 'visibilityState', {value:'visible', configurable:true});
  const decorate = root => {
    for (const node of [root, ...root.querySelectorAll('*')]) Object.defineProperty(node, 'getClientRects', {value:() => node.hasAttribute('hidden') ? [] : [{}], configurable:true});
  };
  decorate(document.documentElement);
  const user = document.querySelector('.chat-user'), chat = document.querySelector('.chat-conversation'), editor = document.querySelector('.chat-editor');
  user.__vue__ = {list$:[{uid:101, name:'张三', encryptJobId:'JOB-1', geekInfo:{encryptUid:'GEEK-101'}}, {uid:202, name:'张三', encryptJobId:'JOB-1', geekInfo:{encryptUid:'GEEK-202'}}]};
  chat.__vue__ = {conversation$:{friendId:selected}, messages};
  editor.__vue__ = {conversation$:{friendId:selected}};
  const select = value => { chat.setAttribute('data-friend-id', value); chat.__vue__.conversation$ = {friendId:value}; editor.__vue__.conversation$ = {friendId:value}; };
  for (const node of user.children) node.addEventListener('click', () => select(node.getAttribute('data-friend-id')));
  const snapshot = {ok:true, selected_friend_id:selected, conversations:[{...target, candidate_name:'张三'}, {...second, candidate_name:'张三'}]};
  const context = vm.createContext({window, document, location:new URL('https://www.zhipin.com/web/chat/index'), URL, URLSearchParams,
    getComputedStyle:node => ({visibility:node.hasAttribute('hidden') ? 'hidden' : 'visible', display:'block', cursor:'auto'}),
    setTimeout, clearTimeout, crypto:webcrypto, AbortController,
    fetch:fetchImpl || (async () => { throw Error('Unexpected request'); })});
  const call = (action, extra = {}) => vm.runInContext(`(${chatPageAction.toString()})(input)`, Object.assign(context, {input:{...target, snapshot, action, ...extra}}));
  const loadFrame = (frame, src = frame.getAttribute('src')) => {
    const {document:bodyDoc} = parseHTML('<html><body>候选人完整简历</body></html>');
    Object.defineProperty(bodyDoc, 'readyState', {value:'complete'});
    Object.defineProperty(frame, 'contentWindow', {value:{location:{href:new URL(src, 'https://www.zhipin.com').href}, document:bodyDoc}, configurable:true});
  };
  const openFrame = (src = '/web/frame/c-resume/?encryptGeekId=GEEK-101') => {
    const root = document.createElement('section'); root.setAttribute('role', 'dialog');
    root.innerHTML = `<button aria-label="关闭">×</button><iframe src="${src}"></iframe>`;
    document.body.append(root); decorate(root);
    loadFrame(root.querySelector('iframe'), src);
    root.querySelector('button').addEventListener('click', () => root.remove());
    return root;
  };
  return {document, window, chat, user, editor, snapshot, context, call, select, openFrame, loadFrame, decorate};
}

test('serialized page action inspects current stable conversation without clicking or requesting', async () => {
  const f = fixture({messages:[card()]});
  const result = await f.call('inspect');
  assert.equal(result.ok, true); assert.equal(result.selected_friend_id, '101'); assert.equal(result.online_count, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.attachments)), [{message_id:'55', name:'张三.pdf', status:'received'}]);
  assert.equal(JSON.stringify(result).includes('RESUME-55'), false);
});

test('opens unique chat by friend and job despite identical display names', async () => {
  const f = fixture({selected:'202'});
  const result = await f.call('open-chat');
  assert.equal(result.status, 'selected'); assert.equal(f.chat.getAttribute('data-friend-id'), '101');
});

test('supports explicit Vue item props rather than matching list array positions', async () => {
  const f = fixture({selected:'202'}), node = f.user.firstElementChild;
  node.removeAttribute('data-friend-id'); node.removeAttribute('data-job-id');
  node.__vue__ = {$el:node, $props:{item:{friendId:101, encryptJobId:'JOB-1'}}};
  node.addEventListener('click', () => f.select('101'));
  assert.equal((await f.call('open-chat')).status, 'selected');
});

test('refuses display-name-only or duplicate unrelated row bindings', async () => {
  const f = fixture({selected:'202'});
  f.user.firstElementChild.removeAttribute('data-friend-id');
  assert.equal((await f.call('open-chat')).code, 'AMBIGUOUS_ROW');
  const g = fixture({selected:'202'}), duplicate = g.user.firstElementChild.cloneNode(true);
  g.user.append(duplicate); g.decorate(duplicate);
  assert.equal((await g.call('open-chat')).code, 'AMBIGUOUS_ROW');
});

test('live platform job and candidate identity override stale supplied snapshots', async () => {
  const f = fixture(); f.user.__vue__.list$[0].encryptJobId = 'JOB-2';
  assert.equal((await f.call('inspect')).code, 'JOB_CHANGED');
  const g = fixture(); g.user.__vue__.list$[0].geekInfo.encryptUid = 'DIFFERENT';
  assert.equal((await g.call('inspect')).code, 'CANDIDATE_CHANGED');
});

test('reader and action agree on explicitly paired numeric/encrypted job identities', async () => {
  for(const nested of [false,true]){
    const f=fixture(), row=f.user.__vue__.list$[0];
    row.jobId=7001;
    if(nested){delete row.encryptJobId;row.jobInfo={encryptJobId:'JOB-1'};}
    f.user.firstElementChild.setAttribute('data-job-id','7001');
    f.chat.__vue__.conversation$={friendId:101,jobId:7001};
    const snapshot=vm.runInContext(`(${readCommunicationPage.toString()})()`,f.context);
    assert.equal(snapshot.ok,true,snapshot.error);
    assert.equal(snapshot.conversations[0].platform_job_id,'JOB-1');
    const result=await f.call('inspect',{snapshot});
    assert.equal(result.ok,true,result.error);
  }
});

test('paired selected metadata can prove an alias without changing the list canonical ID',async()=>{
  const f=fixture();
  delete f.user.__vue__.list$[0].encryptJobId;f.user.__vue__.list$[0].jobId=7001;
  f.user.firstElementChild.setAttribute('data-job-id','7001');
  f.chat.__vue__.conversation$={friendId:101,jobId:7001,encryptJobId:'JOB-1'};
  const snapshot=vm.runInContext(`(${readCommunicationPage.toString()})()`,f.context);
  assert.equal(snapshot.ok,true,snapshot.error);
  assert.equal(snapshot.conversations[0].platform_job_id,'7001');
  assert.equal((await f.call('inspect',{snapshot,platform_job_id:'7001'})).ok,true);
});

test('BOSS toPositionId supplies the real numeric/encrypted pair to reader and page actions',async()=>{
  for(const container of ['', 'jobInfo', 'communicationJob']){
    const f=fixture();
    const job={jobId:7001,toPositionId:'JOB-1',toPosition:'工业工程师'};
    f.chat.__vue__.conversation$={friendId:101,...(container?{[container]:job}:job)};
    const snapshot=vm.runInContext(`(${readCommunicationPage.toString()})()`,f.context);
    assert.equal(snapshot.ok,true,snapshot.error);
    assert.equal(snapshot.conversations[0].platform_job_id,'JOB-1');
    assert.equal(snapshot.conversations[0].platform_job_title,'工业工程师');
    const result=await f.call('inspect',{snapshot});
    assert.equal(result.ok,true,result.error);
    job.toPositionId='JOB-OTHER';
    if(!container)f.chat.__vue__.conversation$.toPositionId='JOB-OTHER';
    assert.equal((await f.call('inspect',{snapshot})).code,'JOB_CHANGED');
  }
});

test('selected toPositionId cannot hide numeric drift or a different selected friend',async()=>{
  const f=fixture();f.user.__vue__.list$[0].jobId=7001;
  f.chat.__vue__.conversation$={friendId:101,jobId:7002,toPositionId:'JOB-1'};
  assert.equal((await f.call('inspect')).code,'JOB_CHANGED');
  const g=fixture();g.chat.__vue__.conversation$={friendId:202,jobId:7001,toPositionId:'JOB-1'};
  assert.equal((await g.call('inspect')).code,'CHAT_CHANGED');
});

test('job alias reconciliation still stops unproven or conflicting secondary IDs',async()=>{
  for(const kind of ['unproven','conflicting-numeric','conflicting-encrypted']){
    const f=fixture();
    if(kind!=='unproven')f.user.__vue__.list$[0].jobId=7001;
    f.chat.__vue__.conversation$={friendId:101,jobId:kind==='conflicting-numeric'?7002:7001,
      ...(kind==='conflicting-encrypted'?{encryptJobId:'JOB-2'}:{})};
    const result=await f.call('inspect');
    assert.equal(result.code,'JOB_CHANGED',kind);
  }
});

test('chat/editor disagreement and account safety screens stop the action', async () => {
  const f = fixture(); f.editor.__vue__.conversation$ = {friendId:202};
  assert.equal((await f.call('inspect')).code, 'CHAT_CHANGED');
  const g = fixture(); g.document.body.append('请完成安全验证');
  assert.equal((await g.call('open-online')).code, 'ACCOUNT_BLOCKED');
});

test('opening and closing online resume is pinned to the newly opened frame', async () => {
  const f = fixture(); f.document.querySelector('#online').addEventListener('click', () => f.openFrame());
  const opened = await f.call('open-online');
  assert.equal(opened.status, 'opened'); assert.match(opened.open_token, /^[a-f0-9]{32}$/);
  assert.equal((await f.call('close-online', {open_token:'invalid'})).code, 'UNKNOWN_OPEN');
  assert.equal((await f.call('close-online', {open_token:opened.open_token})).status, 'closed');
  assert.equal(f.document.querySelector('iframe'), null);
});

test('online close refuses replaced frames and changed conversations', async () => {
  const f = fixture(); f.document.querySelector('#online').addEventListener('click', () => f.openFrame());
  const opened = await f.call('open-online');
  f.document.querySelector('iframe').setAttribute('src', '/web/frame/c-resume/?encryptGeekId=GEEK-202');
  assert.equal((await f.call('close-online', {open_token:opened.open_token})).code, 'DETAIL_CHANGED');
  f.select('202');
  assert.equal((await f.call('close-online', {open_token:opened.open_token})).code, 'CHAT_CHANGED');
});

test('only a platform-ID-bound already-open resume can be reused and never closed', async () => {
  const f = fixture(); f.openFrame();
  const result = await f.call('open-online');
  assert.equal(result.status, 'already-open'); assert.equal(result.open_token, null);
  assert.equal((await f.call('close-online', {open_token:null})).code, 'UNKNOWN_OPEN');
  const g = fixture(); g.openFrame('/web/frame/c-resume/?encryptGeekId=OTHER');
  assert.equal((await g.call('open-online')).code, 'DETAIL_ALREADY_OPEN');
});

test('missing, duplicate, message-text and external online links are not clicked', async () => {
  const f = fixture({html:'<button>索取简历</button><div data-mid="1"><span>在线简历</span></div>'});
  assert.equal((await f.call('open-online')).status, 'not-found');
  const g = fixture({html:'<button>在线简历</button><button>查看在线简历</button>'});
  assert.equal((await g.call('open-online')).code, 'AMBIGUOUS_DETAIL');
  const h = fixture({html:'<a href="https://evil.example/resume">在线简历</a>'});
  assert.equal((await h.call('open-online')).status, 'unavailable');
});

test('actual resume-btn-online anchor in sibling candidate header requires a shared explicit conversation owner', async () => {
  const f = fixture({html:''}), area = f.document.createElement('main');
  f.chat.replaceWith(area); area.append(f.chat);
  const header = f.document.createElement('header'); header.className = 'base-info-single-container';
  header.innerHTML = '<a class="resume-btn-online" href="javascript:;">在线简历</a>'; area.prepend(header); f.decorate(area);
  area.__vue__ = {conversation$:{friendId:'101', encryptJobId:'JOB-1'}};
  header.querySelector('a').addEventListener('click', () => f.openFrame());
  assert.equal((await f.call('inspect')).online_count, 1);
  assert.equal((await f.call('open-online')).status, 'opened');
});

test('sibling header numeric job is accepted only with the current explicit encrypted/numeric pair',async()=>{
  const f=fixture({html:''}),area=f.document.createElement('main');
  f.chat.replaceWith(area);area.append(f.chat);
  const header=f.document.createElement('header');header.className='base-info-single-container';
  header.innerHTML='<a class="resume-btn-online">在线简历</a>';area.prepend(header);f.decorate(area);
  area.__vue__={conversation$:{friendId:101,jobId:7001}};
  f.user.__vue__.list$[0].jobId=7001;
  assert.equal((await f.call('inspect')).online_count,1);
  area.__vue__.conversation$.jobId=7002;
  assert.equal((await f.call('inspect')).code,'JOB_CHANGED');
});

test('a sibling BOSS header uses toPositionId to prove its numeric job and rejects changed job metadata',async()=>{
  const f=fixture({html:''}),area=f.document.createElement('main');
  f.chat.replaceWith(area);area.append(f.chat);
  const header=f.document.createElement('header');header.className='base-info-single-container';
  header.innerHTML='<a class="resume-btn-online">在线简历</a>';area.prepend(header);f.decorate(area);
  area.__vue__={conversation$:{friendId:101,jobId:7001,toPositionId:'JOB-1',toPosition:'工业工程师'}};
  assert.equal((await f.call('inspect')).online_count,1);
  area.__vue__.conversation$.toPositionId='JOB-OTHER';
  assert.equal((await f.call('inspect')).code,'JOB_CHANGED');
});

test('sibling header without explicit identity, another friend, or inside the sidebar is not a usable entry', async () => {
  for (const variant of ['unbound', 'other', 'sidebar']) {
    const f = fixture({html:''}), area = f.document.createElement('main');
    f.chat.replaceWith(area); area.append(f.chat);
    const header = f.document.createElement('header'); header.className = 'base-info-single-container';
    header.innerHTML = '<a class="resume-btn-online">在线简历</a>'; area.prepend(header); f.decorate(area);
    if (variant === 'other') area.__vue__ = {conversation$:{friendId:'202'}};
    if (variant === 'sidebar') { area.__vue__ = {conversation$:{friendId:'101'}}; area.append(f.user); }
    const result = await f.call('open-online');
    assert.equal(result.ok, false); assert.equal(result.code, variant === 'other' ? 'CANDIDATE_CHANGED' : 'ONLINE_NOT_FOUND');
  }
});

test('hidden iframe reuse requires a changed loaded document or an exact target platform ID', async () => {
  for (const kind of ['changed-src', 'same-target', 'old-body', 'unknown-target']) {
    const f = fixture(), root = f.openFrame(kind === 'same-target' ? '/web/frame/c-resume/?encryptGeekId=GEEK-101' : '/web/frame/c-resume/?fixture=old');
    const frame = root.querySelector('iframe'); frame.setAttribute('hidden', '');
    f.document.querySelector('#online').addEventListener('click', () => {
      frame.removeAttribute('hidden');
      if (kind === 'changed-src' || kind === 'old-body') {
        frame.setAttribute('src', '/web/frame/c-resume/?fixture=new');
        if (kind === 'changed-src') f.loadFrame(frame);
        else frame.contentWindow.location.href = 'https://www.zhipin.com/web/frame/c-resume/?fixture=new';
      }
    });
    const result = await f.call('open-online');
    assert.equal(result.ok, ['changed-src', 'same-target'].includes(kind), kind);
    if (result.ok) assert.equal((await f.call('close-online', {open_token:result.open_token})).status, 'closed');
    else assert.equal(result.code, 'DETAIL_NOT_NEW');
  }
});

test('real official bosszp card uses same-origin permission check and fixed official download plan', async () => {
  const calls = [];
  const f = fixture({messages:[card()], fetchImpl:async (url, options) => { calls.push({url, options}); return new Response(JSON.stringify({code:0, zpData:{isResumeVisible:true, isCanPreview:false, expired:false, d:'TEMP_SECRET'}})); }});
  const result = await f.call('attachment-fetch', {message_id:'55'});
  assert.equal(result.status, 'download-ready'); assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://www.zhipin.com'); assert.equal(url.pathname, '/wapi/zpgeek/resume/boss/preview/check.json');
  assert.equal(url.searchParams.get('geekId'), 'GEEK-101'); assert.equal(url.searchParams.get('id'), 'RESUME-55');
  assert.equal(calls[0].options.credentials, 'include'); assert.equal(calls[0].options.redirect, 'error');
  const download = new URL(result.download.url);
  assert.equal(download.hostname, 'docdownload.zhipin.com'); assert.equal(download.pathname, '/wflow/zpgeek/download/download4boss/GEEK-101');
  assert.equal(download.searchParams.get('d'), 'TEMP_SECRET'); assert.equal(result.download.message_id, '55');
});

test('numeric preview authorization accepts only safe integers and preserves their decimal value', async () => {
  for(const d of [0,1,123456,-37,Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER]){
    const f=fixture({messages:[card()],fetchImpl:async()=>new Response(JSON.stringify({code:0,zpData:{isResumeVisible:true,d}}))});
    const result=await f.call('attachment-fetch',{message_id:'55'});
    assert.equal(result.status,'download-ready');
    const url=new URL(result.download.url);
    assert.equal(url.searchParams.get('d'),String(d));
    assert.equal(url.origin,'https://docdownload.zhipin.com');
    assert.equal(url.pathname,'/wflow/zpgeek/download/download4boss/GEEK-101');
    assert.equal(result.download.friend_id,'101');assert.equal(result.download.message_id,'55');
  }
});

test('preview authorization objects, arrays, booleans, decimals and unsafe integers never create download plans', async () => {
  for(const d of [{value:'PRIVATE'},[],['PRIVATE'],true,false,1.5,Number.MAX_SAFE_INTEGER+1,Number.MIN_SAFE_INTEGER-1]){
    const f=fixture({messages:[card()],fetchImpl:async()=>new Response(JSON.stringify({code:0,zpData:{isResumeVisible:true,d}}))});
    const result=await f.call('attachment-fetch',{message_id:'55'});
    assert.equal(result.ok,false);assert.equal(result.code,'PREVIEW_FAILED');assert.equal(result.download,undefined);
    assert.equal(result.error.includes('PRIVATE'),false);
  }
});

test('nonfinite or invalid numeric JSON authorization values remain blocked', async () => {
  for(const numeric of ['1e309','-1e309','NaN','Infinity','-Infinity']){
    const f=fixture({messages:[card()],fetchImpl:async()=>new Response(`{"code":0,"zpData":{"isResumeVisible":true,"d":${numeric}}}`)});
    const result=await f.call('attachment-fetch',{message_id:'55'});
    assert.equal(result.ok,false);assert.equal(result.code,'PREVIEW_FAILED');assert.equal(result.download,undefined);
  }
});

test('openFile cards map id and untrusted or duplicate URL parameters never trigger requests', async () => {
  for (const link of ['https://evil.example/?type=openFile&id=55', 'bosszp://bosszhipin.app.evil/openwith?type=openFile&id=55', 'bosszp://bosszhipin.app/openwith?type=openFile&id=55&id=66']) {
    const raw = card(); raw.body.hyperLink.url = link;
    const f = fixture({messages:[raw]}); assert.equal((await f.call('attachment-fetch', {message_id:'55'})).ok, false);
  }
  const raw = card(); raw.body.hyperLink.url = 'bosszp://bosszhipin.app/openwith?type=openFile&id=PLAIN';
  let request;
  const f = fixture({messages:[raw], fetchImpl:async url => { request = url; return new Response(JSON.stringify({code:0, zpData:{isResumeVisible:true}})); }});
  assert.equal((await f.call('attachment-fetch', {message_id:'55'})).ok, true);
  assert.equal(new URL(request).searchParams.get('id'), 'PLAIN');
});

test('pending, expired, outgoing and other-friend attachment messages are not downloaded', async () => {
  for (const [raw, code] of [[card({attachment_status:'pending'}), 'ATTACHMENT_PENDING'], [card({attachment_status:'expired'}), 'ATTACHMENT_EXPIRED'],
    [card({from:{uid:999}, to:{uid:101}}), 'ATTACHMENT_UNAVAILABLE'], [card({friendId:202}), 'MESSAGE_MISMATCH']]) {
    const f = fixture({messages:[raw]}); assert.equal((await f.call('attachment-fetch', {message_id:'55'})).code, code);
  }
});

test('attachment permission denial and HTML response are explicit blocked outcomes', async () => {
  for (const response of [new Response('', {status:403}), new Response('<html>login</html>'), new Response(JSON.stringify({code:0, zpData:{isResumeVisible:false}})), new Response(JSON.stringify({code:0, zpData:{isResumeVisible:true, expired:true}}))]) {
    const f = fixture({messages:[card()], fetchImpl:async () => response});
    const result = await f.call('attachment-fetch', {message_id:'55'});
    assert.equal(result.ok, false); assert.equal(result.status, 'download-blocked');
  }
});

test('conversation change or message replacement during preview check invalidates download plan', async () => {
  const f = fixture({messages:[card()]});
  f.context.fetch = async () => { f.select('202'); return new Response(JSON.stringify({code:0, zpData:{isResumeVisible:true}})); };
  assert.equal((await f.call('attachment-fetch', {message_id:'55'})).code, 'CHAT_CHANGED');
  const g = fixture({messages:[card()]});
  g.context.fetch = async () => { g.chat.__vue__.messages = [card({attachment_status:'expired'})]; return new Response(JSON.stringify({code:0, zpData:{isResumeVisible:true}})); };
  assert.equal((await g.call('attachment-fetch', {message_id:'55'})).code, 'CHAT_CHANGED');
});

const sourceRow = (raw, changes = {}) => ({raw, friend_id:'101', direction:'incoming', scope_bound:true, ...changes});
const installSource = (fixture, rows, extra = {}) => {
  const state = {rows, visible_count:rows.length, unresolved_count:0, visible_attachment_count:rows.length,
    unresolved_attachments:0, warnings:[], ...extra};
  fixture.window.__hrmChatMessageSource = {version:1, read:({friend_id}) => {
    assert.equal(friend_id,'101');return state;
  }};
  return state;
};
const permissionResponse = () => new Response(JSON.stringify({code:0, zpData:{isResumeVisible:true}}));

test('shared message source owns packet discovery and permits only explicitly scoped incoming packets without to', async () => {
  let calls=0;
  const f=fixture({fetchImpl:async()=>{calls++;return permissionResponse();}}), packet=card();
  delete packet.to;
  installSource(f,[sourceRow(packet)]);
  const inspect=await f.call('inspect');
  assert.equal(inspect.attachments[0].message_id,'55');
  const result=await f.call('attachment-fetch',{message_id:'55'});
  assert.equal(result.status,'download-ready');assert.equal(result.download.message_id,'55');assert.equal(calls,1);
  assert.equal(JSON.stringify(inspect).includes('RESUME-55'),false);
});

test('helper rows prevent fallback to independently guessed legacy message arrays', async () => {
  let calls=0;
  const f=fixture({messages:[card()],fetchImpl:async()=>{calls++;return permissionResponse();}});
  installSource(f,[]);
  assert.deepEqual(JSON.parse(JSON.stringify((await f.call('inspect')).attachments)),[]);
  assert.equal((await f.call('attachment-fetch',{message_id:'55'})).code,'ATTACHMENT_UNAVAILABLE');
  assert.equal(calls,0);
  f.window.__hrmChatMessageSource.version=2;
  assert.equal((await f.call('attachment-fetch',{message_id:'55'})).code,'MESSAGE_SOURCE_UNAVAILABLE');
  assert.equal(calls,0);
});

test('scoped packets with another friend, conflicting direction or no explicit scope never create plans', async () => {
  for(const change of [
    row=>{row.friend_id='202';},
    row=>{row.direction='outgoing';},
    row=>{row.raw.from.uid=202;},
    row=>{row.scope_bound=false;},
    row=>{delete row.scope_bound;},
    row=>{row.scope_bound='true';},
    row=>{delete row.raw.from.source;},
    row=>{row.raw.from.source=1;},
    row=>{row.raw.from.source='';},
    row=>{delete row.raw.from.uid;row.raw.fromId=101;},
    row=>{row.raw.to={uid:101};},
    row=>{row.raw.to={uid:0};},
    row=>{row.raw.to={};},
    row=>{row.raw.toId='invalid receiver';},
  ]){
    let calls=0;
    const f=fixture({fetchImpl:async()=>{calls++;return permissionResponse();}}), packet=card();delete packet.to;
    const row=sourceRow(packet);change(row);installSource(f,[row]);
    const result=await f.call('attachment-fetch',{message_id:'55'});
    assert.equal(result.ok,false);assert.equal(result.download,undefined);assert.equal(calls,0);
  }
});

test('complete from/to packets retain strict legacy direction checks even through the shared source', async () => {
  let calls=0;
  const f=fixture({fetchImpl:async()=>{calls++;return permissionResponse();}});
  installSource(f,[sourceRow(card(),{scope_bound:false})]);
  assert.equal((await f.call('attachment-fetch',{message_id:'55'})).status,'download-ready');
  assert.equal(calls,1);
  for(const row of [sourceRow(card({from:{uid:999},to:{uid:101}})),
    sourceRow(card({from:{uid:101,source:1}})),sourceRow(card(),{direction:'outgoing'})]){
    installSource(f,[row]);
    assert.equal((await f.call('attachment-fetch',{message_id:'55'})).ok,false);
  }
  assert.equal(calls,1);
});

test('unresolved visible attachments remain explicit and cannot generate a guessed download plan', async () => {
  let calls=0;
  const f=fixture({messages:[card()],fetchImpl:async()=>{calls++;return permissionResponse();}});
  installSource(f,[],{visible_count:1,visible_attachment_count:1,unresolved_count:1,unresolved_attachments:1});
  const inspected=await f.call('inspect');
  assert.equal(inspected.unresolved_attachments,1);assert.ok(inspected.warnings[0].includes('尚未确认'));
  assert.equal(inspected.attachments.length,0);
  assert.equal((await f.call('attachment-fetch',{message_id:'55'})).code,'MESSAGE_SOURCE_UNRESOLVED');
  assert.equal(calls,0);
  const packet=card();delete packet.to;
  installSource(f,[sourceRow(packet)],{unresolved_attachments:1});
  assert.equal((await f.call('attachment-fetch',{message_id:'55'})).status,'download-ready');
  assert.equal((await f.call('attachment-fetch',{message_id:'other-mid'})).code,'MESSAGE_SOURCE_UNRESOLVED');
  assert.equal(calls,1);
});

test('loss of shared message scope during permission check invalidates an otherwise identical packet', async () => {
  const packet=card();delete packet.to;
  const f=fixture(),state=installSource(f,[sourceRow(packet)]);
  f.context.fetch=async()=>{state.rows[0].scope_bound=false;return permissionResponse();};
  assert.equal((await f.call('attachment-fetch',{message_id:'55'})).code,'CHAT_CHANGED');
});

test('composer input parent Vue state binds the current conversation without legacy editor state', async () => {
  const f=fixture({html:''});
  f.chat.removeAttribute('data-friend-id');delete f.chat.__vue__.conversation$;delete f.editor.__vue__;
  const parent=f.document.createElement('section');parent.innerHTML='<div id="boss-chat-editor-input"></div>';
  parent.__vue__={conversation$:{friendId:101}};f.editor.append(parent);f.decorate(parent);
  assert.equal((await f.call('inspect')).status,'ready');
  parent.__vue__.conversation$={friendId:202};
  assert.equal((await f.call('inspect')).code,'CHAT_CHANGED');
});

test('real nested message component exports the same original mid to reader and attachment action without to', async () => {
  let requests=0;
  const f=fixture({html:'<div class="chat-message-list"><section class="message-item"><div class="item-friend"><div class="message-content"><div class="resume-card"><strong>张三.pdf</strong><div class="message-card-buttons"><span class="card-btn">预览</span></div></div></div></div></section></div>',
    fetchImpl:async()=>{requests++;return permissionResponse();}});
  f.chat.removeAttribute('data-friend-id');delete f.chat.__vue__.conversation$;delete f.editor.__vue__;
  const composer=f.document.createElement('section');
  composer.innerHTML='<div id="boss-chat-editor-input" class="boss-chat-editor-input"></div>';
  composer.__vue__={conversation$:{friendId:101}};f.editor.append(composer);f.decorate(composer);
  const packet=card({mid:'real-packet-55'});delete packet.to;
  const component=f.chat.querySelector('.resume-card');
  component.__vue__={$el:component,$props:{message:{packet}}};
  vm.runInContext(`(${installChatMessageSource.toString()})()`,f.context);
  const snapshot=vm.runInContext(`(${readCommunicationPage.toString()})()`,f.context);
  assert.equal(snapshot.ok,true);assert.equal(snapshot.messages.length,1);
  assert.equal(snapshot.messages[0].message_id,'real-packet-55');assert.equal(snapshot.messages[0].direction,'incoming');
  assert.equal(snapshot.messages[0].attachment_status,'received');
  const result=await f.call('attachment-fetch',{snapshot,message_id:snapshot.messages[0].message_id});
  assert.equal(result.status,'download-ready');assert.equal(result.download.message_id,snapshot.messages[0].message_id);
  assert.equal(requests,1);assert.equal(JSON.stringify(snapshot).includes('RESUME-55'),false);
});

test('account risk, login expiry and VIP barriers stop the whole workflow instead of skipping candidates', async () => {
  for (const code of [9, 32, 35, 36, 37]) {
    const f = fixture({messages:[card()], fetchImpl:async () => new Response(JSON.stringify({code}))});
    const result = await f.call('attachment-fetch', {message_id:'55'});
    assert.equal(result.status, 'blocked'); assert.equal(result.code, code === 37 ? 'AUTH_REQUIRED' : 'ACCOUNT_BLOCKED');
  }
  const f = fixture();
  const popup = f.document.createElement('div'); popup.className = 'boss-popup__wrapper'; popup.textContent = 'VIP账号 扫码支付';
  f.document.body.append(popup); f.decorate(popup);
  assert.equal((await f.call('open-online')).code, 'ENTITLEMENT_REQUIRED');
});

const expected = {...target, message_id:'55'};
const plan = (name = '张三.pdf') => ({...expected, name, resume_id:'RESUME-55', url:'https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/GEEK-101?id=RESUME-55&d=SECRET'});
const getFile = (bytes, {name = '张三.pdf', headers = {}, check, ...options} = {}) => fetchChatAttachment(plan(name), {
  expected, check, fetchImpl:async () => new Response(bytes, {headers}), ...options,
});

test('extension downloads bounded PDF bytes with credentials and returns no temporary URL', async () => {
  let options, calls = 0;
  const result = await getFile('%PDF-1.7\noriginal', {check:() => { calls++; }, fetchImpl:async (_url, request) => { options = request; return new Response('%PDF-1.7\noriginal', {headers:{'content-type':'application/pdf'}}); }});
  assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error'); assert.ok(calls >= 3);
  assert.equal(Buffer.from(result.file.content, 'base64').toString(), '%PDF-1.7\noriginal'); assert.equal(result.file.mime, 'application/pdf');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('download helper rejects altered friend, message, host, path and duplicate parameters before network', async () => {
  const invalid = [{...plan(), friend_id:'202'}, {...plan(), message_id:'66'}, {...plan(), url:plan().url.replace('docdownload.zhipin.com', 'evil.example')},
    {...plan(), url:plan().url.replace('GEEK-101?', 'OTHER?')}, {...plan(), url:plan().url.replace('RESUME-55', 'OTHER')}, {...plan(), url:plan().url + '&id=other'}, {...plan(), url:plan().url + '&redirect=other'}];
  for (const item of invalid) await assert.rejects(fetchChatAttachment(item, {expected, fetchImpl:async () => { throw Error('must not fetch'); }}), /不一致|官方|参数/);
});

test('download errors hide URLs, reject auth pages, redirects and unsupported file signatures', async () => {
  for (const [body, headers, status] of [['<html>login</html>', {'content-type':'text/html'}, 200], ['{"code":403}', {'content-type':'application/json'}, 200], ['', {}, 403], ['not PDF', {}, 200], [Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), {}, 200]]) {
    await assert.rejects(getFile(body, {fetchImpl:async () => new Response(body, {headers, status})}));
  }
  await assert.rejects(getFile('', {fetchImpl:async () => { throw Error('https://docdownload.zhipin.com/?d=SECRET'); }}), error => !error.message.includes('SECRET') && error.code === 'DOWNLOAD_FAILED');
  await assert.rejects(getFile('', {fetchImpl:async () => { const error = Error('https://docdownload.zhipin.com/?d=SECRET'); error.code = 'ENOTFOUND'; throw error; }}), error => !error.message.includes('SECRET') && error.code === 'DOWNLOAD_FAILED');
  await assert.rejects(getFile('%PDF-1.7', {fetchImpl:async () => { const response = new Response('%PDF-1.7'); Object.defineProperty(response, 'redirected', {value:true}); return response; }}), /没有返回/);
});

test('download aborts streams exceeding 5 MiB even without Content-Length', async () => {
  await assert.rejects(getFile(new Uint8Array(5 * 1024 * 1024 + 1)), error => error.code === 'FILE_TOO_LARGE');
  await assert.rejects(getFile('%PDF-', {headers:{'content-length':String(5 * 1024 * 1024 + 1)}}), error => error.code === 'FILE_TOO_LARGE');
});

test('download check can stop a switched conversation and timeout cancels network without retry', async () => {
  let calls = 0;
  await assert.rejects(getFile('%PDF-1.7', {check:() => { if (++calls === 2) { const error = Error('changed'); error.code = 'CHAT_CHANGED'; throw error; } }}), error => error.code === 'CHAT_CHANGED');
  await assert.rejects(getFile('', {timeoutMs:100, fetchImpl:async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted'))))}), error => error.code === 'DOWNLOAD_FAILED');
});

test('UTF-8 TXT and encoded original filenames are preserved while invalid text is rejected', async () => {
  const result = await getFile('采购工程师简历\n工作经历', {name:'原简历.txt', headers:{'content-type':'text/plain', 'content-disposition':"attachment; filename*=UTF-8''%E7%AE%80%E5%8E%86.txt"}});
  assert.equal(result.file.name, '简历.txt'); assert.equal(result.file.mime, 'text/plain');
  await assert.rejects(getFile(new Uint8Array([0xff, 0xfe]), {name:'简历.txt'}), /UTF-8/);
  await assert.rejects(getFile('hello\x00world', {name:'简历.txt'}), /无效文本/);
});

function docxFixture() {
  const parts = [], entries = []; let offset = 0;
  for (const [name, content] of [['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<document/>']]) {
    const filename = Buffer.from(name), body = Buffer.from(content), local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, filename, body); entries.push(central, filename); offset += local.length + filename.length + body.length;
  }
  const directory = Buffer.concat(entries), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

test('DOCX needs the Office central-directory entries instead of only a ZIP magic prefix', async () => {
  assert.equal((await getFile(docxFixture(), {name:'简历.docx'})).file.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await assert.rejects(getFile(Buffer.from('PK\x03\x04not docx'), {name:'简历.docx'}), /有效的 DOCX/);
  await assert.rejects(getFile(docxFixture(), {name:'简历.pdf'}), /格式与文件名/);
});
