import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';
import {build} from 'esbuild';
import {readCommunicationPage, mergeCommunicationFrames, selectCommunicationRows} from '../extension/communications-reader.mjs';
import {resolveChatJob} from '../extension/chat-job-matching.mjs';

function readPage({friends, messages = [], selected = '101', html = '', setup, hostname = 'www.zhipin.com'} = {}) {
  const {document} = parseHTML(`<html><body><div class="chat-user"></div><div class="chat-conversation" data-friend-id="${selected}">${html}</div><div class="chat-editor"></div></body></html>`);
  Object.defineProperty(document, 'visibilityState', {value:'visible', configurable:true});
  for (const node of document.querySelectorAll('*')) Object.defineProperty(node, 'getClientRects', {value:() => node.closest('[hidden]') ? [] : [{}]});
  const list = friends ?? [{uid:101, name:'张三', encryptJobId:'JOB-1', unreadMsgCount:2,
    lastMsgInfo:{showText:'你好', msgTime:1794980000000}, securityId:'SECRET', token:'PRIVATE'}];
  const owner = document.querySelector('.chat-user');
  owner.__vue__ = {list$:list};
  document.querySelector('.chat-conversation').__vue__ = {conversation$:{friendId:selected}, messages};
  document.querySelector('.chat-editor').__vue__ = {conversation$:{friendId:selected}};
  setup?.({document, owner});
  const result = vm.runInNewContext(`(${readCommunicationPage.toString()})()`, {
    document, location:{protocol:'https:', hostname, origin:`https://${hostname}`}, URL, Date,
    getComputedStyle:() => ({visibility:'visible'}),
  });
  return JSON.parse(JSON.stringify(result));
}

test('reads existing Vue RX list and message identities without returning session secrets', () => {
  const result = readPage({messages:[
    {mid:10, from:{uid:101}, to:{uid:999}, body:{text:'你好'}, time:1794980000000},
    {mid:11, from:{uid:999}, to:{uid:101}, body:{text:'已收到，谢谢'}, time:1794980100000},
  ]});
  assert.equal(result.ok, true);
  assert.equal(result.conversations[0].friend_id, '101');
  assert.equal(result.conversations[0].unread_count, 2);
  assert.equal(result.messages[0].direction, 'incoming');
  assert.equal(result.messages[1].direction, 'outgoing');
  assert.equal(result.messages[0].message_id, '10');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal('attachment_status' in result.messages[0], false);
});

test('same display name remains two conversations and missing unread count stays unknown', () => {
  const result = readPage({friends:[{uid:101, name:'王先生'}, {uid:202, name:'王先生'}]});
  assert.equal(result.ok, true);
  assert.equal(result.conversations.length, 2);
  assert.equal(result.conversations[0].unread_count, null);
  assert.notEqual(result.conversations[0].friend_id, result.conversations[1].friend_id);
});

test('communicated job titles use the job container and never the candidate expected or current title', () => {
  const result=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-1',jobName:'  视觉算法工程师  ',
    geekInfo:{jobName:'医疗器械销售',jobTitle:'软件工程师'},expectJob:{jobName:'产品经理'}},
    {uid:202,name:'李四',encryptJobId:'JOB-2',jobInfo:{jobName:'采购工程师'}},
    {uid:303,name:'王五',jobName:'无职位标识的个人职称',geekInfo:{expectPosition:'运营'}}]});
  assert.equal(result.ok,true);
  assert.deepEqual(result.conversations.map(row=>[row.platform_job_id,row.platform_job_title]),[
    ['JOB-1','视觉算法工程师'],['JOB-2','采购工程师'],['',''],
  ]);
});

test('the selected bound chat merges the communicated header title while ignoring its desired position', () => {
  const result=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-1'},{uid:202,name:'李四',encryptJobId:'JOB-1'}],
    html:`<header><div><span>沟通职位：</span><a> 视觉算法工程师 </a><i class="icon-refresh">↻</i></div>
      <div><span>期望：</span>杭州 · 医疗健康（药企） · 面议</div></header>`});
  assert.equal(result.ok,true);
  assert.equal(result.conversations[0].platform_job_title,'视觉算法工程师');
  assert.equal(result.conversations[1].platform_job_title,'');
});

test('a header alongside the unique chat is bound by its current chat pane and selected friend',()=>{
  const result=readPage({setup:({document})=>{
    const chat=document.querySelector('.chat-conversation'),pane=document.createElement('section');
    pane.innerHTML='<header data-friend-id="101"><p>沟通职位：视觉算法工程师</p><p>期望：医疗健康</p></header>';
    for(const node of [pane,...pane.querySelectorAll('*')])Object.defineProperty(node,'getClientRects',{value:()=>[{}]});
    chat.replaceWith(pane);pane.append(chat);
  }});
  assert.equal(result.ok,true);assert.equal(result.conversations[0].platform_job_title,'视觉算法工程师');
});

test('current conversation metadata can supply a missing list job without using candidate names',()=>{
  const result=readPage({friends:[{uid:101,name:'张三'}],setup:({document})=>{
    document.querySelector('.chat-conversation').__vue__.conversation$={friendId:101,
      encryptJobId:'JOB-CURRENT',jobInfo:{jobTitle:'视觉算法工程师'}};
  }});
  assert.equal(result.ok,true);
  assert.equal(result.conversations[0].platform_job_id,'JOB-CURRENT');
  assert.equal(result.conversations[0].platform_job_title,'视觉算法工程师');
});

test('numeric and encrypted job IDs reconcile only through an explicit same-conversation pair',()=>{
  for (const [listed, selected, expected] of [
    [{encryptJobId:'JOB-1',jobId:7001},{jobId:7001},'JOB-1'],
    [{jobId:7001},{encryptJobId:'JOB-1',jobId:'7001'},'7001'],
    [{jobId:7001,jobInfo:{encryptJobId:'JOB-1'}},{encryptJobId:'JOB-1'},'JOB-1'],
    [{encryptJobId:'JOB-1',jobId:7001},{jobId:'JOB-1'},'JOB-1'],
    [{encryptJobId:'JOB-1'},{jobInfo:{encryptJobId:'JOB-1',jobId:7001}},'JOB-1'],
    [{encryptJobId:'JOB-1'},{toPositionId:'JOB-1',jobId:7001},'JOB-1'],
    [{jobId:7001},{toPositionId:'JOB-1',jobId:7001},'7001'],
    [{encryptJobId:'JOB-1'},{communicationJob:{toPositionId:'JOB-1',jobId:7001}},'JOB-1'],
  ]) {
    const result=readPage({friends:[{uid:101,name:'张三',...listed}],setup:({document})=>{
      document.querySelector('.chat-conversation').__vue__.conversation$={friendId:101,...selected};
    }});
    assert.equal(result.ok,true,result.error);
    assert.equal(result.conversations[0].platform_job_id,expected);
    assert.equal('numeric' in result.conversations[0],false);
    assert.equal('encrypted' in result.conversations[0],false);
  }
});

test('actual BOSS conversation fields automatically resolve the unique communicated job title',()=>{
  const result=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-INDUSTRIAL'}],setup:({document})=>{
    document.querySelector('.chat-conversation').__vue__.conversation$={friendId:101,jobId:7001,
      toPositionId:'JOB-INDUSTRIAL',toPosition:'工业工程师',expectJob:{jobName:'视觉工程师'},
      geekInfo:{jobName:'软件工程师'}};
  }});
  assert.equal(result.ok,true,result.error);
  assert.equal(result.conversations[0].platform_job_id,'JOB-INDUSTRIAL');
  assert.equal(result.conversations[0].platform_job_title,'工业工程师');
  const resolved=resolveChatJob({jobs:[{id:1,title:'工业工程师'},{id:2,title:'视觉工程师'}],
    conversations:result.conversations,account_id:'招聘账号',mappings:[]});
  assert.equal(resolved.ok,true,resolved.error);assert.equal(resolved.job_id,1);assert.equal(resolved.method,'title');
});

test('nested communication job containers recognize toPosition without reading desired-position containers',()=>{
  for(const key of ['jobInfo','communicateJob','communicationJob']){
    const result=readPage({setup:({document})=>{
      document.querySelector('.chat-conversation').__vue__.conversation$={friendId:101,
        [key]:{jobId:7001,toPositionId:'JOB-1',toPosition:'工业工程师'},
        expectJob:{toPositionId:'OTHER-JOB',toPosition:'候选人期望'}};
    }});
    assert.equal(result.ok,true,result.error);assert.equal(result.conversations[0].platform_job_title,'工业工程师');
  }
});

test('actual toPosition metadata still rejects conflicting job IDs and communicated titles',()=>{
  for(const selected of [
    {jobId:7001,toPositionId:'JOB-OTHER',toPosition:'工业工程师'},
    {jobId:7002,toPositionId:'JOB-1',toPosition:'工业工程师'},
    {jobId:7001,toPositionId:'JOB-1',encryptJobId:'JOB-OTHER',toPosition:'工业工程师'},
    {jobId:7001,toPositionId:'JOB-1',toPosition:'视觉工程师'},
    {jobId:7001,toPositionId:'JOB-1',toPosition:'工业工程师',jobName:'视觉工程师'},
  ]){
    const result=readPage({friends:[{uid:101,name:'张三',jobId:7001,encryptJobId:'JOB-1',jobName:'工业工程师'}],
      setup:({document})=>{
        document.querySelector('.chat-conversation').__vue__.conversation$={friendId:101,...selected};
      }});
    assert.equal(result.ok,false,JSON.stringify(selected));
    assert.match(result.error,/沟通职位.*(?:不一致|不同名称)|不同的沟通职位名称/);
  }
  const header=readPage({html:'<header><p>沟通职位：视觉工程师</p></header>',setup:({document})=>{
    document.querySelector('.chat-conversation').__vue__.conversation$={friendId:101,jobId:7001,toPositionId:'JOB-1',toPosition:'工业工程师'};
  }});
  assert.equal(header.ok,false);assert.match(header.error,/不同的沟通职位名称/);
});

test('a conflicting secondary job ID cannot hide behind the same encrypted ID',()=>{
  for(const selected of [
    {encryptJobId:'JOB-1',jobId:7002},
    {encryptJobId:'JOB-2',jobId:7001},
    {jobId:7002},
    {encryptJobId:'JOB-1',jobInfo:{encryptJobId:'OTHER-JOB'}},
  ]){
    const result=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-1',jobId:7001}],setup:({document})=>{
      document.querySelector('.chat-conversation').__vue__.conversation$={friendId:101,...selected};
    }});
    assert.equal(result.ok,false);assert.match(result.error,/沟通职位标识不一致/);
  }
});

test('same candidate and title cannot invent a numeric/encrypted job alias',()=>{
  const result=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-1',jobName:'工程师'}],setup:({document})=>{
    document.querySelector('.chat-conversation').__vue__.conversation$={friendId:101,jobId:7001,jobName:'工程师'};
  }});
  assert.equal(result.ok,false);assert.match(result.error,/未提供对应关系/);
});

test('a numeric/encrypted pair belonging to another candidate cannot establish an alias',()=>{
  const result=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-1'},
    {uid:202,name:'李四',encryptJobId:'JOB-1',jobId:7001}],setup:({document})=>{
    document.querySelector('.chat-conversation').__vue__.conversation$={friendId:101,jobId:7001};
  }});
  assert.equal(result.ok,false);assert.match(result.error,/未提供对应关系/);
});

test('duplicate list representations preserve the existing canonical ID and validate aliases',()=>{
  const result=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-1',jobId:7001},
    {uid:101,name:'张三',jobId:7001}]});
  assert.equal(result.ok,true,result.error);assert.equal(result.conversations[0].platform_job_id,'JOB-1');
  const conflict=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-1',jobId:7001},
    {uid:101,name:'张三',encryptJobId:'JOB-1',jobId:7002}]});
  assert.equal(conflict.ok,false);assert.match(conflict.error,/不同沟通职位/);
});

test('desired-position rows, incoming message text and hidden headers cannot assign a communicated title',()=>{
  const result=readPage({html:`<header><p>期望：杭州 · 视觉算法工程师</p></header>
    <div class="chat-message-list"><div class="message-item"><p>沟通职位：医疗器械工程师</p></div></div>
    <header hidden><p>沟通职位：产品经理</p></header>
    <div class="chat-editor"><p>沟通职位：销售经理</p></div>`});
  assert.equal(result.ok,true);assert.equal(result.conversations[0].platform_job_title,'');
  const unselected=readPage({selected:'',html:'<header><p>沟通职位：视觉算法工程师</p></header>'});
  assert.equal(unselected.ok,true);assert.equal(unselected.conversations[0].platform_job_title,'');
});

test('conflicting communicated title, job ID or explicit header friend stops automatic job assignment',()=>{
  const titles=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-1',jobName:'采购工程师'}],
    html:'<header><p>沟通职位：视觉算法工程师</p></header>'});
  assert.equal(titles.ok,false);assert.match(titles.error,/不同的沟通职位名称/);
  const jobs=readPage({setup:({document})=>{
    document.querySelector('.chat-conversation').__vue__.conversation$={friendId:101,encryptJobId:'OTHER-JOB',jobName:'视觉算法工程师'};
  }});
  assert.equal(jobs.ok,false);assert.match(jobs.error,/沟通职位标识不一致/);
  const other=readPage({html:'<header data-friend-id="202"><p>沟通职位：视觉算法工程师</p></header>'});
  assert.equal(other.ok,false);assert.match(other.error,/另一位候选人/);
});

test('duplicate current titles must agree and long titles are rejected without truncating a matching prefix',()=>{
  const duplicate=readPage({html:'<header><p>沟通职位：视觉算法工程师</p><p>沟通职位：采购工程师</p></header>'});
  assert.equal(duplicate.ok,false);assert.match(duplicate.error,/不同的沟通职位名称/);
  const long=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-1',jobName:'视'.repeat(161)}]});
  assert.equal(long.ok,false);assert.match(long.error,/过长或格式异常/);
  const normalized=readPage({friends:[{uid:101,name:'张三',encryptJobId:'JOB-1',jobName:'  Ｃ＋＋\n 工程师  '}]});
  assert.equal(normalized.ok,true);assert.equal(normalized.conversations[0].platform_job_title,'C++ 工程师');
});

test('observation uses current subscription values and never invokes Rx methods or getters beyond whitelist', () => {
  const result = readPage({setup:({owner}) => {
    owner.__vue__ = {$observables:{list$:{_value:[{friendId:'101', name:'赵女士'}]}}};
    Object.defineProperty(owner.__vue__, 'privateToken', {get:() => { throw Error('must not inspect'); }});
  }});
  assert.equal(result.ok, true);
  assert.equal(result.conversations[0].candidate_name, '赵女士');
});

test('a missing stable message ID or unproven direction is skipped without invented records', () => {
  const result = readPage({messages:[
    {from:{uid:101}, to:{uid:999}, body:{text:'没有消息ID'}},
    {mid:12, body:{text:'没有发送者'}},
  ]});
  assert.equal(result.ok, true);
  assert.deepEqual(result.messages, []);
  assert.ok(result.warnings.some(text => text.includes('跳过')));
});

test('current candidate, editor and selected row must agree', () => {
  const result = readPage({setup:({document}) => {
    document.querySelector('.chat-editor').__vue__.conversation$.friendId = 202;
  }});
  assert.equal(result.ok, false);
  assert.match(result.error, /会话标识不一致/);
});

test('a message explicitly belonging to another conversation stops the snapshot', () => {
  const result = readPage({messages:[{mid:10, friendId:202, from:{uid:202}, to:{uid:999}, body:{text:'另一位候选人'}}]});
  assert.equal(result.ok, false);
  assert.match(result.error, /归属/);
});

test('incoming received, pending, expired and outgoing attachment states remain distinct', () => {
  const received = {mid:10, from:{uid:101}, to:{uid:999}, body:{hyperLink:{
    hyperLinkType:1, title:'张三.pdf', url:'https://www.zhipin.com/resume?type=openFile&id=RESUME&securityId=SECRET',
  }}};
  const pending = {mid:11, from:{uid:101}, to:{uid:999}, attachment_name:'待确认.pdf', body:{text:'请求附件'}};
  const expired = {mid:12, from:{uid:101}, to:{uid:999}, attachment_name:'已过期.pdf', attachment_status:'expired'};
  const outgoing = {mid:13, from:{uid:999}, to:{uid:101}, attachment_name:'我方.pdf', attachment_status:'received'};
  const result = readPage({messages:[received, pending, expired, outgoing]});
  assert.equal(result.ok, true);
  assert.deepEqual(result.messages.map(message => message.attachment_status), ['received','pending','expired','pending']);
  assert.equal(JSON.stringify(result).includes('RESUME'), false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('external links and ordinary job cards cannot establish received attachment permission', () => {
  const result = readPage({messages:[
    {mid:10, from:{uid:101}, to:{uid:999}, body:{text:'职位卡片', hyperLink:{hyperLinkType:2, title:'工程师', url:'https://www.zhipin.com/job?id=JOB'}}},
    {mid:11, from:{uid:101}, to:{uid:999}, attachment_name:'附件.pdf', body:{hyperLink:{hyperLinkType:1, url:'https://www.zhipin.com.evil.example/resume?type=openFile&id=RESUME'}}},
  ]});
  assert.equal(result.messages[0].kind, 'text');
  assert.equal(result.messages[1].attachment_status, 'pending');
});

test('official BOSS app attachment links establish received status without exposing link credentials',()=>{
  for(const host of ['bosszhipin.app','bosszhipin.app.evil.test']){
    const result=readPage({messages:[{mid:10,from:{uid:101},to:{uid:999},attachment_name:'附件.pdf',body:{hyperLink:{
      hyperLinkType:9,url:`bosszp://${host}/openwith?type=selectResumePreviewUrl&encryptId=PRIVATE-ID&d=PRIVATE-D`,
    }}}]});
    assert.equal(result.messages[0].attachment_status,host==='bosszhipin.app'?'received':'pending');
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('message bodies are preserved beyond 3000 characters and excessive bodies fail explicitly', () => {
  const content = '完整消息'.repeat(2000);
  const message = {mid:10, from:{uid:101}, to:{uid:999}, body:{text:content}};
  assert.equal(readPage({messages:[message]}).messages[0].text, content);
  assert.equal(readPage({messages:[{...message, body:{text:'长'.repeat(30001)}}]}).ok, false);
});

test('DOM fallback requires stable platform IDs and direction plus selected conversation', () => {
  const result = readPage({html:'<div class="message-other" data-mid="20" data-friend-id="101"><span class="message-text">手动加载的旧消息</span></div>'});
  assert.equal(result.ok, true);
  assert.equal(result.messages[0].message_id, '20');
  assert.equal(result.messages[0].direction, 'incoming');
});

test('unknown page structures and more than one readable frame do not report success', () => {
  const result = readPage({friends:[{name:'没有平台会话ID'}]});
  assert.equal(result.ok, false);
  assert.throws(() => mergeCommunicationFrames([{result:{ok:true}}, {result:{ok:true}}]), /多个/);
  assert.throws(() => mergeCommunicationFrames([{result:{ok:false, error:'请打开沟通页面'}}]), /请打开/);
});

test('multiple visible chat regions and missing candidate names are not silently imported', () => {
  assert.equal(readPage({friends:[{uid:101}]}).ok, false);
  const result = readPage({setup:({document}) => {
    const duplicate = document.createElement('div'); duplicate.className = 'chat-conversation';
    Object.defineProperty(duplicate, 'getClientRects', {value:() => [{}]}); document.body.append(duplicate);
  }});
  assert.equal(result.ok, false);
  assert.match(result.error, /多个可见/);
});

test('the serialized reader rejects another origin before inspecting page data', () => {
  assert.equal(readPage({hostname:'www.zhipin.com.evil.example'}).ok, false);
});

test('imports only explicitly selected conversations from the same platform job', () => {
  const snapshot = {conversations:[
    {friend_id:'101', platform_job_id:'JOB-1'}, {friend_id:'202', platform_job_id:'JOB-1'},
    {friend_id:'303', platform_job_id:'JOB-2'}, {friend_id:'404', platform_job_id:''}, {friend_id:'505', platform_job_id:''},
  ], messages:[{friend_id:'101', message_id:'1'}, {friend_id:'303', message_id:'2'}]};
  const selected = selectCommunicationRows(snapshot, ['101', '202']);
  assert.equal(selected.conversations.length, 2);
  assert.deepEqual(selected.messages, [{friend_id:'101', message_id:'1'}]);
  assert.throws(() => selectCommunicationRows(snapshot, ['101', '303']), /同一个平台岗位/);
  assert.throws(() => selectCommunicationRows(snapshot, ['404', '505']), /只能单条/);
  assert.throws(() => selectCommunicationRows(snapshot, ['999']), /不在当前/);
  assert.equal(selectCommunicationRows(snapshot, ['404']).conversations.length, 1);
});

test('extension entry loads current history, previews and posts only the confirmed platform-job selection', async () => {
  const {window, document} = parseHTML(await fs.readFile(new URL('../extension/communications.html', import.meta.url), 'utf8'));
  // Linkedom does not implement the browser's writable HTMLSelectElement.value.
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', {value:'', writable:true});
  const code = (await build({entryPoints:[fileURLToPath(new URL('../extension/communications.js', import.meta.url))],
    bundle:true, write:false, format:'iife', platform:'browser'})).outputFiles[0].text;
  const snapshot = {ok:true, selected_friend_id:'101', warnings:[], conversations:[
    {friend_id:'101', candidate_name:'张三', platform_job_id:'JOB-1', platform_job_title:'工程师', unread_count:1},
    {friend_id:'202', candidate_name:'张三', platform_job_id:'JOB-1', platform_job_title:'工程师', unread_count:null},
    {friend_id:'303', candidate_name:'李四', platform_job_id:'JOB-2', platform_job_title:'采购工程师', unread_count:0},
  ], messages:[{friend_id:'101', message_id:'1', direction:'incoming', text:'你好', sent_at:'', kind:'text'}]};
  const requests = [], pageCalls = [], mappingRequests = [];
  let historyLoaded = false;
  const frame = result => [{frameId:0, documentId:'selected-chat-document', result}];
  const context = vm.createContext({document, Node:window.Node, location:{search:'?tab=42'}, URLSearchParams, URL,AbortController,addEventListener(){},
    chrome:{runtime:{id:'a'.repeat(32)},permissions:{contains:async()=>true,request:async () => true}, tabs:{get:async () => ({url:'https://www.zhipin.com/web/chat/index'})},
      scripting:{executeScript:async request => {
        pageCalls.push(request.func.name);
        if(request.func.name==='installChatMessageSource')
          return frame({version:1,revision:'history-1'});
        if(request.func.name==='loadChatMessageHistory'){
          assert.deepEqual(Array.from(request.target.documentIds),['selected-chat-document']);
          assert.equal(request.args[0].friend_id,'101');
          assert.equal(request.args[0].count,100);
          historyLoaded=true;
          return frame({ok:true,status:'history-loaded',history_loaded:true,history_count:1});
        }
        assert.equal(request.func.name,'readCommunicationPage');
        if(historyLoaded)assert.deepEqual(Array.from(request.target.documentIds),['selected-chat-document']);
        return frame({...snapshot,messages:historyLoaded?snapshot.messages:[],message_capture:{
          visible_count:1,unresolved_count:historyLoaded?0:1,visible_attachment_count:0,unresolved_attachments:0,
          history_loaded:historyLoaded,history_count:historyLoaded?1:0,
        }});
      }},
      storage:{local:{get:async () => ({}), set:async () => {}}}},
    fetch:async (url, options) => {
      if (url.endsWith('/api/state')) return {ok:true, json:async () => ({extension_ids:['a'.repeat(32)],token:'LOCAL', communications_version:1,chat_resume_version:1, jobs:[{id:1, title:'工程师'}]})};
      if (url.endsWith('/api/communications/list')) {
        mappingRequests.push(JSON.parse(options.body));
        return {ok:true,json:async()=>({conversations:[]})};
      }
      requests.push({url, data:JSON.parse(options.body)});
      return {ok:true, json:async () => ({conversation_count:requests.at(-1).data.conversations.length, message_count:1, new_messages:1})};
    },
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  vm.runInContext(code, context);
  await settle();
  document.querySelector('#read').click();
  await settle();
  assert.equal(document.querySelector('#preview').hidden, false);
  assert.deepEqual(pageCalls,['installChatMessageSource','readCommunicationPage','loadChatMessageHistory','readCommunicationPage']);
  assert.equal(document.querySelector('#platform-scope').value, 'job:JOB-1', document.querySelector('#platform-scope').outerHTML);
  assert.equal(document.querySelector('#conversations').children.length, 2, document.querySelector('#status').textContent);
  assert.equal([...document.querySelectorAll('[data-friend-select]')].filter(input => input.checked).length, 1);
  assert.equal(mappingRequests.length,1);
  document.querySelector('#account-id').value = '公司-董女士';
  document.querySelector('#account-id').dispatchEvent(new window.Event('input'));
  await settle();
  assert.equal(document.querySelector('#job').value,'1');
  assert.equal(document.querySelector('#job').type,'hidden');
  assert.match(document.querySelector('#job-name').textContent,/工程师/);
  const extra = document.querySelector('[data-friend-select="202"]');
  extra.checked = true; extra.dispatchEvent(new window.Event('change'));
  assert.equal(document.querySelector('#import').disabled, false);
  document.querySelector('#import').click();
  await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].data.conversations.map(row => row.friend_id), ['101', '202']);
  assert.equal(requests[0].data.messages.length, 1);
  assert.equal(requests[0].data.account_id, '公司-董女士');
  assert.match(document.querySelector('#status').textContent, /新增 1 条消息/);
});
