import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';
import {build} from 'esbuild';

const code=(await build({entryPoints:[fileURLToPath(new URL('../extension/communications.js',import.meta.url))],
  bundle:true,write:false,format:'iife',platform:'browser',plugins:[{name:'empty-result-runner',setup(builder){
    builder.onResolve({filter:/chat-collection\.mjs$/},()=>({path:'runner',namespace:'test-runner'}));
    builder.onLoad({filter:/.*/,namespace:'test-runner'},()=>({contents:`
      export async function collectChatResumes({onProgress,selection}){
        globalThis.__collectionSelections.push(selection);
        const row={friend_id:'101',name:'合成候选人',attachments:0,online:0,resumes:[],issues:['当前消息未提供可下载简历'],complete:true};
        onProgress(row);return [row];
      }` }));
  }}]})).outputFiles[0].text;

async function fixture({unresolved=0,received=false,title='合成岗位',jobs=[{id:1,title:'合成岗位'}],
  conversations,priorConversations=[],account='测试-账号',workbenchOrigin,workbenchAllowed=true,paired=true,payment=false}={}){
  const {window,document}=parseHTML(await fs.readFile(new URL('../extension/communications.html',import.meta.url),'utf8'));
  for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{value:'',writable:true});
  const snapshot={ok:true,selected_friend_id:'101',conversations:conversations||[
    {friend_id:'101',candidate_name:'合成候选人',platform_job_id:'JOB',platform_job_title:title}],
    messages:received?[{friend_id:'101',message_id:'real-mid',kind:'attachment',direction:'incoming',attachment_status:'received',attachment_name:'合成简历.pdf'}]:[],
    warnings:[],message_capture:{unresolved_attachments:unresolved}};
  let sourceInstalls=0,historyReads=0;
  const requests=[],apiUrls=[],storageWrites=[],collectionSelections=[];
  snapshot.message_capture.history_loaded=!unresolved;
  const context=vm.createContext({window,document,Node:window.Node,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,
    location:{search:'?tab=42'},addEventListener(){},__collectionSelections:collectionSelections,
    navigator:{clipboard:{},locks:{request:async(_key,_options,work)=>work({})}},
    chrome:{runtime:{id:'a'.repeat(32)},permissions:{contains:async()=>workbenchAllowed,request:async()=>true},storage:{local:{get:async()=>({workbenchOrigin,communicationsAccount:{id:account},['communicationsAccount:'+workbenchOrigin]:{id:account}}),set:async value=>{storageWrites.push(value);}}},
      tabs:{get:async()=>({id:42,url:'https://www.zhipin.com/web/chat/index',active:true})},
      scripting:{executeScript:async({func})=>{
        if(func.name==='detectPaymentSurface')return [{frameId:0,result:payment}];
        if(func.name==='installChatMessageSource'){sourceInstalls++;return [];}
        if(func.name==='loadChatMessageHistory'){
          historyReads++;snapshot.message_capture.history_loaded=true;
          return [{frameId:0,documentId:'chat',result:{ok:true,history_loaded:true,history_count:0}}];
        }
        return [{frameId:0,documentId:'chat',result:snapshot}];
      }}},
    fetch:async(url,options)=>{
      apiUrls.push(url);
      if(url.endsWith('/api/state'))return {ok:true,json:async()=>({extension_ids:paired?['a'.repeat(32)]:[],token:'LOCAL',communications_version:1,chat_resume_version:1,jobs})};
      requests.push({url,data:options?.body?JSON.parse(options.body):null});
      if(url.endsWith('/api/communications/list'))return {ok:true,json:async()=>({conversations:priorConversations})};
      if(url.endsWith('/api/communications/import'))return {ok:true,json:async()=>({conversation_count:1,message_count:0,new_messages:0})};
      throw Error('Unexpected local API '+url);
    },
  });
  const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
  vm.runInContext(code,context);await settle();
  document.querySelector('#collect-limit').value='10';
  document.querySelector('#collect-attachments').checked=true;
  document.querySelector('#collect-online').checked=false;
  document.querySelector('#read').click();await settle();
  return {document,window,settle,requests,collectionSelections,apiUrls,storageWrites,installs:()=>sourceInstalls,historyReads:()=>historyReads};
}

test('a visible payment page ends a communication collection before opening any chat',async()=>{
  const f=await fixture({payment:true});
  f.document.querySelector('#collect').click();await f.settle();
  assert.match(f.document.querySelector('#status').textContent,/支付页面.*自动停止/);
  assert.equal(f.collectionSelections.length,0);
  assert.equal(f.document.querySelector('#collect').disabled,false);
});

test('zero source results are visibly unsuccessful rather than a green collection success',async()=>{
  const f=await fixture();assert.equal(f.installs(),1);
  f.document.querySelector('#collect').click();await f.settle();
  const status=f.document.querySelector('#status');
  assert.equal(status.dataset.state,'warning');assert.match(status.textContent,/本次未获取到简历/);
  assert.match(f.document.querySelector('#collection-results').textContent,/未获取/);
  assert.doesNotMatch(f.document.querySelector('#collection-results').textContent,/已处理|已归档/);
});

test('visible unparsed cards and a zero-message list import cannot imply an attachment was captured',async()=>{
  const f=await fixture({unresolved:1});
  assert.equal(f.historyReads(),1);
  assert.equal(f.document.querySelector('#status').dataset.state,'warning');
  assert.match(f.document.querySelector('#status').textContent,/附件卡片.*未确认/);
  f.document.querySelector('#import').click();await f.settle();
  const status=f.document.querySelector('#status');
  assert.equal(status.dataset.state,'warning');assert.match(status.textContent,/未读取到聊天消息.*不表示附件已获取/);
});

test('verified history attachments remain actionable while unmatched page cards are explicitly disclosed',async()=>{
  const f=await fixture({unresolved:1,received:true});
  const status=f.document.querySelector('#status');
  assert.equal(status.dataset.state,'warning');
  assert.match(status.textContent,/确认 1 个已收到附件.*尚未逐一对应.*可采集已核验附件/);
});

test('the communicated job automatically selects a unique local job without a manual job control',async()=>{
  const f=await fixture({title:'视觉算法工程师',jobs:[{id:1,title:'采购工程师'},{id:2,title:'视觉算法工程师'}]});
  assert.equal(f.document.querySelector('#job').value,'2');
  assert.equal(f.document.querySelector('#job').type,'hidden');
  assert.match(f.document.querySelector('#job-name').textContent,/视觉算法工程师/);
  assert.equal(f.document.querySelector('#collect').disabled,false);
  f.document.querySelector('#job').value='999';
  f.document.querySelector('#collect').click();await f.settle();
  assert.equal(f.collectionSelections.length,1);
  assert.equal(f.collectionSelections[0].job_id,2);
  assert.equal(f.requests.filter(row=>row.url.endsWith('/api/communications/list')).length,1);
});

test('a known platform job maps to its existing local job and changing accounts clears that binding',async()=>{
  const f=await fixture({title:'视觉算法工程师',jobs:[{id:1,title:'采购工程师'},{id:2,title:'视觉工程师'}],
    priorConversations:[{account_id:'测试-账号',platform_job_id:'JOB',job_id:2,friend_id:'older'}]});
  assert.equal(f.document.querySelector('#job').value,'2');
  assert.match(f.document.querySelector('#job-name').textContent,/视觉工程师/);
  f.document.querySelector('#account-id').value='另一账号';
  f.document.querySelector('#account-id').dispatchEvent(new f.window.Event('input'));await f.settle();
  assert.equal(f.document.querySelector('#job').value,'');
  assert.equal(f.document.querySelector('#import').disabled,true);
  assert.equal(f.document.querySelector('#collect').disabled,true);
});

test('switching platform job groups cannot retain the previous automatically resolved local job',async()=>{
  const f=await fixture({jobs:[{id:1,title:'视觉工程师'},{id:2,title:'采购工程师'}],conversations:[
    {friend_id:'101',candidate_name:'合成候选人',platform_job_id:'JOB',platform_job_title:'视觉工程师'},
    {friend_id:'202',candidate_name:'另一位',platform_job_id:'OTHER',platform_job_title:'未设置的岗位'},
  ]});
  assert.equal(f.document.querySelector('#job').value,'1');
  f.document.querySelector('#platform-scope').value='job:OTHER';
  f.document.querySelector('#platform-scope').dispatchEvent(new f.window.Event('change'));await f.settle();
  assert.equal(f.document.querySelector('#job').value,'');
  const other=f.document.querySelector('[data-friend-select="202"]');
  other.checked=true;other.dispatchEvent(new f.window.Event('change'));await f.settle();
  assert.equal(f.document.querySelector('#collect').disabled,true);
  assert.equal(f.document.querySelector('#import').disabled,true);
});

test('unknown and duplicate local job titles block imports instead of choosing a job by list position',async()=>{
  for(const jobs of [[{id:1,title:'采购工程师'}],[{id:1,title:'视觉工程师'},{id:2,title:'视觉工程师'}]]){
    const f=await fixture({title:'视觉工程师',jobs});
    assert.equal(f.document.querySelector('#job').value,'');
    assert.equal(f.document.querySelector('#import').disabled,true);
    assert.equal(f.document.querySelector('#collect').disabled,true);
    assert.equal(f.collectionSelections.length,0);
  }
});

test('an exceptional first mapping needs confirmation and cannot survive an account change',async()=>{
  const f=await fixture({title:'视觉算法工程师',jobs:[{id:2,title:'视觉工程师'}]});
  assert.equal(f.document.querySelector('#job-confirmation').hidden,false);
  assert.equal(f.document.querySelector('#collect').disabled,true);
  f.document.querySelector('#job-confirm').value='2';
  f.document.querySelector('#job-confirm').dispatchEvent(new f.window.Event('change'));
  f.document.querySelector('#confirm-job').click();await f.settle();
  assert.equal(f.document.querySelector('#job').value,'2');
  assert.equal(f.document.querySelector('#job-confirmation').hidden,true);
  assert.equal(f.document.querySelector('#collect').disabled,false);
  f.document.querySelector('#account-id').value='另一账号';
  f.document.querySelector('#account-id').dispatchEvent(new f.window.Event('input'));await f.settle();
  assert.equal(f.document.querySelector('#job').value,'');
  assert.equal(f.document.querySelector('#collect').disabled,true);
});

test('LAN communications reads and imports to the downloaded server and scopes its account settings',async()=>{
  const base='http://10.0.0.8:8765';
  const f=await fixture({workbenchOrigin:base});
  assert.equal(f.document.querySelector('#workbench-link').href,base+'/');
  f.document.querySelector('#import').click();await f.settle();
  assert.ok(f.requests.some(row=>row.url.endsWith('/api/communications/import')));
  assert.ok(f.apiUrls.every(url=>url.startsWith(base+'/')));
  assert.ok(f.storageWrites.some(value=>value['communicationsAccount:'+base]));
});

test('communications cannot read candidate pages before host permission and pairing',async()=>{
  for(const options of [{workbenchAllowed:false},{paired:false}]){
    const f=await fixture({workbenchOrigin:'http://10.0.0.8:8765',...options});
    assert.equal(f.document.querySelector('#read').disabled,true);
    assert.equal(f.installs(),0);
    assert.equal(f.requests.length,0);
    assert.match(f.document.querySelector('#status').textContent,/授权|允许访问/);
  }
});
