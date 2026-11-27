import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {TextDecoder} from 'node:util';
import {parseHTML} from 'linkedom';
import {installChatMessageSource,loadChatMessageHistory} from '../extension/chat-message-source.mjs';
import {readCommunicationPage} from '../extension/communications-reader.mjs';
import {chatPageAction} from '../extension/chat-actions.mjs';

const target = {friend_id:'101', platform_job_id:'JOB-1', platform_geek_id:'GEEK-101'};
const rawAttachment = () => ({mid:1001, from:{uid:101, source:0}, body:{hyperLink:{hyperLinkType:9,
  title:'同名候选人.pdf', url:'bosszp://bosszhipin.app/openwith?type=selectResumePreviewUrl&encryptId=RESUME-1001&authType=0'}}});
const attachmentCard = `<div class="resume-card"><div class="message-card-top">
  <i class="resume-icon"></i><div class="message-card-top-title">同名候选人.pdf</div></div>
  <div class="message-card-buttons"><span class="card-btn">预览</span><span class="card-btn">下载</span></div></div>`;
const plain = value => JSON.parse(JSON.stringify(value));
const jsonResponse = (url,payload) => {
  // An in-memory Response supplies the ordinary stream/headers interface used
  // for bounded history reads. Constructing it never sends a network request.
  const response=new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}});
  Object.defineProperty(response,'url',{value:url.href});
  return response;
};

// No browser profile, platform connection, download, or real fetch is used.
function fixture({raw=rawAttachment(), domMid=false, component=false, reactive=false,
  direction='item-friend', markup=attachmentCard, duplicateLists=false, historyMessages}={}) {
  const {document} = parseHTML(`<html><body>
    <aside class="chat-user"><div class="selected" data-friend-id="101" data-job-id="JOB-1"><span class="name">同名候选人</span></div>
      <div data-friend-id="202" data-job-id="JOB-1"><span class="name">同名候选人</span></div></aside>
    <main class="chat-conversation" data-friend-id="101"><div class="chat-message-list">
      <div class="message-item"${domMid ? ' data-mid="1001"' : ''}><div class="${direction}">${markup}</div></div>
    </div></main><div class="chat-editor" data-friend-id="101"></div></body></html>`);
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  const user = document.querySelector('.chat-user'), chat = document.querySelector('.chat-conversation');
  user.__vue__ = {list$:[
    {uid:101,name:'同名候选人',encryptJobId:'JOB-1',geekInfo:{encryptUid:'GEEK-101'}},
    {uid:202,name:'同名候选人',encryptJobId:'JOB-1',geekInfo:{encryptUid:'GEEK-202'}},
  ]};
  // Intentionally do not provide root-level message arrays. The source must
  // reconcile the rendered row with its real row/component Vue message.
  chat.__vue__ = {conversation$:{friendId:101,encryptJobId:'JOB-1'}};
  document.querySelector('.chat-editor').__vue__ = {conversation$:{friendId:101}};
  const row = document.querySelector('.message-item');
  const owner = component ? row.querySelector('.resume-card') : row;
  if (reactive && raw) {
    for (const key of ['mid','from','body']) {
      if (!Object.hasOwn(raw,key)) continue;
      const value = raw[key];
      Object.defineProperty(raw,key,{configurable:true,enumerable:true,get:() => value});
    }
  }
  let privateReads=0;
  const props={};
  Object.defineProperty(props,'message',{enumerable:true,get:() => raw});
  owner.__vue__ = component ? {$el:owner,$props:props} : {$el:owner,message:raw};
  Object.defineProperty(owner.__vue__,'privateToken',{get(){privateReads++; throw Error('Private state was accessed');}});
  if (duplicateLists) {
    const duplicate=document.createElement('div'); duplicate.className='chat-message-list';
    duplicate.innerHTML=`<div class="message-item"><div class="item-friend">${attachmentCard}</div></div>`;
    duplicate.querySelector('.message-item').__vue__={message:{...rawAttachment(),mid:1002}};
    chat.append(duplicate);
  }
  for (const node of document.querySelectorAll('*')) Object.defineProperty(node,'getClientRects',{
    configurable:true,value:() => node.closest('[hidden]') ? [] : [{left:0,top:0,width:800,height:500}],
  });
  let clicks=0; document.body.addEventListener('click',() => clicks++);
  const requests=[];
  const location=new URL('https://www.zhipin.com/web/chat/index');
  // A separate plain window avoids linkedom's process-wide expando globals.
  const window={document,location}; window.top=window; window.parent=window;
  const context=vm.createContext({window,document,location,URL,URLSearchParams,AbortController,TextDecoder,setTimeout,clearTimeout,
    getComputedStyle:node => ({visibility:node.closest('[hidden]') ? 'hidden' : 'visible',display:'block',cursor:'auto'}),
    fetch:async(url,options) => {
      const parsed=new URL(url);
      assert.equal(parsed.origin,'https://www.zhipin.com');
      requests.push({url:parsed,options});
      if(parsed.pathname==='/wapi/zpchat/boss/historyMsg'){
        assert.ok(Array.isArray(historyMessages),'unexpected history fallback request');
        return jsonResponse(parsed,{
          code:0,zpData:{messages:historyMessages},
        });
      }
      assert.equal(parsed.pathname,'/wapi/zpgeek/resume/boss/preview/check.json');
      return jsonResponse(parsed,{
        code:0,zpData:{isResumeVisible:true,expired:false,d:'SYNTHETIC-GRANT'},
      });
    },
  });
  vm.runInContext(`(${installChatMessageSource.toString()})()`,context);
  let snapshot;
  const read=() => (snapshot=plain(vm.runInContext(`(${readCommunicationPage.toString()})()`,context)));
  read();
  const action=async(name,extra={}) => {
    context.input={...target,snapshot,action:name,...extra};
    return plain(await vm.runInContext(`(${chatPageAction.toString()})(input)`,context));
  };
  const loadHistory=async(extra={}) => {
    context.historyInput={friend_id:target.friend_id,...extra};
    return plain(await vm.runInContext(`(${loadChatMessageHistory.toString()})(historyInput)`,context));
  };
  const select=friend => {
    chat.setAttribute('data-friend-id',friend); chat.__vue__.conversation$.friendId=friend;
    const editor=document.querySelector('.chat-editor');
    editor.setAttribute('data-friend-id',friend); editor.__vue__.conversation$.friendId=friend;
    for(const node of user.querySelectorAll('[data-friend-id]')) node.classList.toggle('selected',node.getAttribute('data-friend-id')===friend);
  };
  return {get snapshot(){return snapshot;},read,action,loadHistory,select,requests,metrics:() => ({clicks,privateReads})};
}

test('a rendered received card shares its real Vue message ID through reader and attachment preflight',async() => {
  for (const options of [{domMid:false,component:false},{domMid:true,component:true,reactive:true}]) {
    const f=fixture(options), message=f.snapshot.messages?.[0];
    assert.equal(f.snapshot.ok,true,f.snapshot.error);
    assert.equal(f.snapshot.selected_friend_id,'101');
    assert.equal(f.snapshot.conversations.length,2,'same display names must remain separate friends');
    assert.equal(f.snapshot.messages.length,1);
    assert.equal(message.message_id,'1001'); assert.equal(message.friend_id,'101');
    assert.equal(message.direction,'incoming'); assert.equal(message.kind,'attachment');
    assert.equal(message.attachment_status,'received'); assert.equal(message.attachment_name,'同名候选人.pdf');
    assert.equal(JSON.stringify(f.snapshot).includes('RESUME-1001'),false,'page URLs stay out of imported chat data');
    const inspected=await f.action('inspect');
    assert.equal(inspected.ok,true,inspected.error);
    assert.deepEqual(inspected.attachments,[{message_id:'1001',name:'同名候选人.pdf',status:'received'}]);
    assert.equal(f.requests.length,0,'inspection must not request permissions or files');
    const planned=await f.action('attachment-fetch',{message_id:message.message_id});
    assert.equal(planned.status,'download-ready',planned.error);
    assert.equal(planned.download.message_id,message.message_id);
    assert.equal(planned.download.friend_id,message.friend_id);
    assert.equal(f.requests.length,1);
    assert.equal(f.requests[0].url.searchParams.get('geekId'),'GEEK-101');
    assert.equal(f.requests[0].url.searchParams.get('id'),'RESUME-1001');
    assert.equal(f.requests[0].options.method,'GET');
    assert.equal(f.requests[0].options.credentials,'include');
    assert.equal(f.requests[0].options.redirect,'error');
    assert.deepEqual(f.metrics(),{clicks:0,privateReads:0});
  }
});

test('a message from a different friend cannot borrow the selected same-name conversation',async() => {
  const raw={...rawAttachment(),friendId:202,from:{uid:202,source:0}};
  const f=fixture({raw});
  assert.equal(f.snapshot.ok,false,'another friend cannot be reconciled using a shared display name');
  const result=await f.action('attachment-fetch',{message_id:'1001'});
  assert.notEqual(result.status,'download-ready');
  assert.equal(f.requests.length,0); assert.deepEqual(f.metrics(),{clicks:0,privateReads:0});
});

test('an incoming-looking card with an explicit outgoing sender cannot become a received resume',async() => {
  const raw={...rawAttachment(),from:{uid:999,source:0},to:{uid:101,source:0}};
  const f=fixture({raw,direction:'item-friend'});
  assert.equal(f.snapshot.ok,false,'the raw outgoing packet must conflict with the rendered incoming direction');
  assert.notEqual((await f.action('attachment-fetch',{message_id:'1001'})).status,'download-ready');
  assert.equal(f.requests.length,0);
});

test('two visible message lists never select an arbitrary rendered attachment source',async() => {
  const f=fixture({duplicateLists:true});
  assert.equal(f.snapshot.ok,false,'ambiguous rendered message lists must stop the snapshot');
  assert.notEqual((await f.action('attachment-fetch',{message_id:'1001'})).status,'download-ready');
  assert.equal(f.requests.length,0);
});

test('a visible resume card without a real message ID is reported unresolved rather than invented',async() => {
  const raw=rawAttachment(); delete raw.mid;
  const f=fixture({raw,domMid:false});
  assert.equal(f.snapshot.ok,true,f.snapshot.error);
  assert.deepEqual(f.snapshot.messages,[]);
  assert.ok(f.snapshot.message_capture?.unresolved_attachments>0,'missing stable identity must remain visible to the runner');
  assert.ok(f.snapshot.warnings.length>0);
  assert.notEqual((await f.action('attachment-fetch',{message_id:'1001'})).status,'download-ready');
  assert.equal(f.requests.length,0);
});

test('a sent resume request notice cannot produce a received attachment or a preview request',async() => {
  const raw={mid:1001,from:{uid:999,source:1},to:{uid:101},body:{text:'简历请求已发送'}};
  const f=fixture({raw,direction:'item-myself',markup:'<div class="text-content">简历请求已发送</div>'});
  assert.equal(f.snapshot.ok,true,f.snapshot.error);
  assert.ok(!f.snapshot.messages.some(row => row.kind==='attachment' && row.attachment_status==='received'));
  const inspected=await f.action('inspect');
  assert.equal(inspected.ok,true,inspected.error); assert.deepEqual(inspected.attachments,[]);
  assert.notEqual((await f.action('attachment-fetch',{message_id:'1001'})).status,'download-ready');
  assert.equal(f.requests.length,0); assert.deepEqual(f.metrics(),{clicks:0,privateReads:0});
});

test('history fallback binds a real no-to packet through the sanitized reader and attachment preflight',async() => {
  const raw=rawAttachment();
  assert.equal(Object.hasOwn(raw,'to'),false,'the regression packet must reproduce the missing to field');
  const f=fixture({raw:null,historyMessages:[raw]});
  assert.equal(f.snapshot.ok,true,f.snapshot.error);
  assert.deepEqual(f.snapshot.messages,[]);
  assert.ok(f.snapshot.message_capture.unresolved_attachments>0);
  assert.equal(f.requests.length,0,'synchronous reading must not fetch history');
  const loaded=await f.loadHistory();
  assert.equal(loaded.ok,true,loaded.error);
  assert.equal(loaded.status,'history-loaded'); assert.equal(loaded.history_count,1);
  assert.equal(JSON.stringify(loaded).includes('RESUME-1001'),false,'loader metadata must omit raw attachment URLs');
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url.pathname,'/wapi/zpchat/boss/historyMsg');
  assert.equal(f.requests[0].url.searchParams.get('gid'),'101');
  assert.equal(f.requests[0].url.searchParams.get('c'),'100');
  assert.equal(f.requests[0].url.searchParams.get('src'),'0');
  assert.equal(f.requests[0].options.method,'GET');
  assert.equal(f.requests[0].options.credentials,'include');
  assert.equal(f.requests[0].options.redirect,'error');
  const snapshot=f.read(), message=snapshot.messages[0];
  assert.equal(snapshot.ok,true,snapshot.error); assert.equal(snapshot.messages.length,1);
  assert.equal(snapshot.message_capture.unresolved_attachments,0);
  assert.equal(message.message_id,'1001'); assert.equal(message.friend_id,'101');
  assert.equal(message.direction,'incoming'); assert.equal(message.attachment_status,'received');
  assert.equal(JSON.stringify(snapshot).includes('RESUME-1001'),false);
  assert.equal(f.requests.length,1,'reading the loaded cache must remain synchronous');
  const plan=await f.action('attachment-fetch',{message_id:message.message_id});
  assert.equal(plan.status,'download-ready',plan.error);
  assert.equal(plan.download.message_id,message.message_id);
  assert.equal(plan.download.friend_id,message.friend_id);
  assert.deepEqual(f.requests.map(row => row.url.pathname),[
    '/wapi/zpchat/boss/historyMsg','/wapi/zpgeek/resume/boss/preview/check.json',
  ]);
  assert.deepEqual(f.metrics(),{clicks:0,privateReads:0});
});

test('history requested for one friend cannot promote another sender into its received attachment',async() => {
  const foreign={...rawAttachment(),from:{uid:202,source:0}};
  const f=fixture({raw:null,historyMessages:[foreign]});
  const loaded=await f.loadHistory();
  const snapshot=f.read();
  assert.equal(loaded.ok,false,'a foreign no-to sender has no proof of this conversation');
  assert.notEqual(loaded.code,'HISTORY_READ_FAILED','the mock response must reach sender/ownership validation');
  assert.ok(!snapshot.ok || !snapshot.messages.some(row => row.message_id==='1001'));
  assert.notEqual((await f.action('attachment-fetch',{message_id:'1001'})).status,'download-ready');
  assert.deepEqual(f.requests.map(row => row.url.pathname),['/wapi/zpchat/boss/historyMsg']);
  assert.deepEqual(f.metrics(),{clicks:0,privateReads:0});
});

test('switching same-name friends invalidates previously loaded history before reader or attachment action reuse',async() => {
  const f=fixture({raw:null,historyMessages:[rawAttachment()]});
  assert.equal((await f.loadHistory()).ok,true);
  assert.equal(f.read().messages[0]?.message_id,'1001');
  f.select('202');
  const switched=f.read();
  assert.equal(switched.ok,true,switched.error); assert.equal(switched.selected_friend_id,'202');
  assert.deepEqual(switched.messages,[]);
  assert.ok(switched.message_capture.unresolved_attachments>0);
  assert.notEqual((await f.action('attachment-fetch',{friend_id:'202',message_id:'1001'})).status,'download-ready');
  f.select('101');
  const returned=f.read();
  assert.equal(returned.ok,true,returned.error); assert.deepEqual(returned.messages,[],'observing a switch must discard the old history cache');
  assert.notEqual((await f.action('attachment-fetch',{message_id:'1001'})).status,'download-ready');
  assert.deepEqual(f.requests.map(row => row.url.pathname),['/wapi/zpchat/boss/historyMsg']);
  assert.deepEqual(f.metrics(),{clicks:0,privateReads:0});
});
