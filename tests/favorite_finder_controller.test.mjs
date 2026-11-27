import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {createFavoriteLookup,finderParameters,validFavoriteTarget,interactionUrl,FAVORITES_URL,WORKBENCH_ORIGIN} from '../extension/favorite-finder-controller.mjs';

const target={id:7,job_id:1,name:'测试候选人',anchors:[],evidence:[],matching_version:1};
const meta={ok:true,account_uid:'123',document_token:'doc-token'};
const value=(status,extra={})=>({...meta,status,...extra});
const match=()=>value('match',{is_favorites:true,count:1,signature:'signature',token:'token',
  match:{name:target.name,method:'platform_uid',boss_chat_uid:'456'}});
const identity={name:target.name,platform_geek_id:'encrypted-id',boss_chat_uid:'456',binding_verified:true};
const detail=()=>value('located',identity);
const revealed=()=>value('card_located',{...identity,card_visible:true});
const row=(result,extra={})=>({frameId:2,documentId:'doc-1',result,...extra});
function harness(responses,{tab=()=>({id:8,url:FAVORITES_URL}),pause=async()=>{},now=()=>0}={}){
  const calls=[],progress=[],notices=[];
  const api={tabs:{get:async()=>tab()},scripting:{executeScript:async options=>{
    if(options.args[0].action === 'notify'){notices.push(options);return [];}
    calls.push(options);
    if(options.args[0].action === 'reset')return [row(value('reset'))];
    const next=responses.shift();
    return typeof next==='function'?await next(options):next||[row(value('stopped'))];
  }}};
  const action=()=>{};
  const lookup=createFavoriteLookup({api,action,target,tabId:8,pause,now,onProgress:x=>progress.push(x)});
  return {lookup,calls,progress,notices};
}

test('finder requires the configured workbench origin and safe candidate numbers',()=>{
  assert.deepEqual(finderParameters('?candidate=7&workbench=http%3A%2F%2Flocalhost%3A8765','http://localhost:8765'),{candidateId:7,launch:null});
  assert.equal(finderParameters('').candidateId,null);
  for(const input of ['?candidate=0','?candidate=-2','?candidate=1e2','?candidate=9007199254740992',
    '?candidate=7&workbench=http://10.0.0.2:8765','?workbench=http://127.0.0.1:8765.evil.example',
    '?workbench=http://user@127.0.0.1:8765','?workbench=http://127.0.0.1:8765/path'])
    assert.throws(()=>finderParameters(input));
  assert.equal(validFavoriteTarget(target,7),true);
  assert.equal(validFavoriteTarget({...target,id:8},7),false);
});

test('unique target is verified then revealed in its pinned document before returning success',async()=>{
  const h=harness([[row(match())],[row(value('opening'))],[row(detail())],
    [row(value('revealing'))],[row(revealed())]]);
  const result=await h.lookup.run();
  assert.equal(result.status,'located');
  assert.deepEqual(result.verified,{name:target.name,account_uid:'123',platform_geek_id:'encrypted-id',boss_chat_uid:'456'});
  assert.equal(result.card_visible,true);
  assert.deepEqual(h.calls.map(c=>c.args[0].action),['reset','scan','open','status','reveal','reveal_status']);
  assert.deepEqual(h.calls[0].target,{tabId:8,allFrames:true});
  assert.deepEqual(h.calls[2].target,{tabId:8,documentIds:['doc-1']});
  assert.ok(h.calls.every(c=>c.world==='MAIN'&&c.args[0].target===target));
  assert.equal(h.notices.at(-1).args[0].state,'located');
  h.lookup.stop();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.notices.at(-1).args[0].state,'located');
  await assert.rejects(h.lookup.run(),/已启动/);
});

test('verified details never report success until the original card is visible and identity agrees',async()=>{
  for(const result of [value('card_located',{...identity,card_visible:false}),
    value('card_located',{...identity,card_visible:true,binding_verified:false}),
    value('card_located',{...identity,card_visible:true,platform_geek_id:'changed-id'}),
    {ok:false,status:'blocked',reason:'detail_close_unavailable'}]){
    const h=harness([[row(match())],[row(value('opening'))],[row(detail())],[row(result)]]);
    await assert.rejects(h.lookup.run());
    assert.equal(h.notices.at(-1).args[0].state,'failed');
    assert.ok(!h.notices.some(c=>c.args[0].state==='located'));
  }
});

test('reveal polling is bounded and never clicks the close control twice',async()=>{
  const h=harness([[row(match())],[row(value('opening'))],[row(detail())],
    ...Array.from({length:21},()=>[row(value('revealing'))])]);
  await assert.rejects(h.lookup.run(),/定位尚未完成/);
  assert.equal(h.calls.filter(c=>c.args[0].action==='reveal').length,1);
  assert.equal(h.calls.filter(c=>c.args[0].action==='reveal_status').length,20);
});

test('batch scans advance the same list then stop without opening when exhausted',async()=>{
  const h=harness([[row(value('scanned',{is_favorites:true,count:5,signature:'first'}))],
    [row(value('advanced'))],[row(value('scanned',{count:4,signature:'second'}))],[row(value('end'))]]);
  assert.equal((await h.lookup.run()).status,'not_found');
  assert.equal(h.notices.at(-1).args[0].state,'not_found');
  assert.deepEqual(h.calls.map(c=>c.args[0].action),['reset','scan','advance','scan','advance']);
  assert.equal(h.calls[2].args[0].signature,'first');
  assert.equal(h.calls[4].args[0].signature,'second');
});

test('a later batch professional probe is fully verified and highlighted before it is located',async()=>{
  const probe=match();probe.match.method='professional_probe';
  const h=harness([[row(value('scanned',{is_favorites:true,count:10,signature:'first'}))],
    [row(value('advanced'))],[row(probe)],[row(value('opening'))],
    [row(value('loading'))],[row(detail())],[row(revealed())]]);
  const result=await h.lookup.run();
  assert.equal(result.status,'located');
  assert.equal(result.match.method,'professional_probe');
  assert.deepEqual(h.calls.map(c=>c.args[0].action),['reset','scan','advance','scan','open','status','status','reveal']);
  assert.deepEqual(h.notices.filter(c=>c.args[0].state==='scanning').map(c=>c.args[0].batch),[1,2]);
  assert.ok(h.progress.filter(p=>p.phase==='opening').every(p=>!p.text.includes('已找到对应卡片')));
});

test('stopping while revealing cannot report a late visible card as success',async()=>{
  let finish,entered;
  const pending=new Promise(resolve=>{finish=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
  const h=harness([[row(match())],[row(value('opening'))],[row(detail())],()=>{entered();return pending;}]);
  const run=h.lookup.run();await waiting;
  h.lookup.stop();finish([row(revealed())]);
  await assert.rejects(run,/已停止/);
  assert.ok(!h.notices.some(c=>c.args[0].state==='located'));
});

test('ambiguous cards and duplicate favorite frames never authorize opening',async()=>{
  const ambiguous=harness([[row(value('ambiguous',{is_favorites:true,count:2}))]]);
  await assert.rejects(ambiguous.lookup.run(),/多个可能/);
  assert.equal(ambiguous.calls.length,2);
  const duplicate=harness([[row(match()),row(match(),{frameId:3,documentId:'doc-2'})]]);
  await assert.rejects(duplicate.lookup.run(),/多个收藏列表/);
  assert.equal(duplicate.calls.length,2);
});

test('account or document changes prevent an advance followed by open',async()=>{
  for(const changed of [{account_uid:'999'},{document_token:'new-doc'}]){
    const h=harness([[row(value('scanned',{is_favorites:true,count:2,signature:'s'}))],
      [row(value('advanced',changed))]]);
    await assert.rejects(h.lookup.run(),/账号已变化|重新加载/);
    assert.ok(!h.calls.some(c=>c.args[0].action==='open'));
  }
});

test('navigation away from interaction is detected before the open action',async()=>{
  let navigated=false;
  const h=harness([()=>{navigated=true;return [row(match())];}],
    {tab:()=>({url:navigated?'https://www.zhipin.com/web/chat/index':FAVORITES_URL})});
  await assert.rejects(h.lookup.run(),/离开/);
  assert.deepEqual(h.calls.map(c=>c.args[0].action),['reset','scan']);
});

test('stop during a pending scan never opens its late match',async()=>{
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const h=harness([()=>pending]);
  const run=h.lookup.run();
  await new Promise(resolve=>setImmediate(resolve));
  h.lookup.stop();finish([row(match())]);
  await assert.rejects(run,/已停止/);
  assert.equal(h.notices.at(-1).args[0].state,'stopped');
  assert.deepEqual(h.calls.map(c=>c.args[0].action),['reset','scan']);
});

test('an unverified opened resume is never returned with a verified mapping',async()=>{
  for(const state of [value('opened_unverified'),value('located',{...identity,binding_verified:false})]){
    const h=harness([[row(match())],[row(value('opening'))],[row(state)]]);
    const result=await h.lookup.run();
    assert.equal(result.status,'opened_unverified');
    assert.equal(result.verified,undefined);
    assert.ok(!h.calls.some(c=>c.args[0].action==='reveal'));
    assert.equal(h.notices.at(-1).args[0].state,'opened_unverified');
  }
});

test('initial pending navigation and loading frames receive a bounded wait',async()=>{
  let gets=0;
  const h=harness([[row(value('loading',{is_favorites:true}))],[row(match())],[row(value('opening'))],
    [row(detail())],[row(revealed())]],
    {tab:()=>++gets===1?{url:'about:blank',pendingUrl:FAVORITES_URL}:{url:FAVORITES_URL}});
  assert.equal((await h.lookup.run()).status,'located');
  const empty=harness([]);
  await assert.rejects(empty.lookup.run(),/未找到/);
  assert.equal(empty.calls.length,21);
});

test('initial section selection may settle during load but a stable wrong section times out',async()=>{
  const h=harness([[row(value('wrong_section',{is_favorites:false}))],
    [row(value('loading',{is_favorites:true}))],[row(match())],[row(value('opening'))],
    [row(detail())],[row(revealed())]]);
  assert.equal((await h.lookup.run()).status,'located');
  const wrong=harness(Array.from({length:20},()=>[row(value('wrong_section',{is_favorites:false}))]));
  await assert.rejects(wrong.lookup.run(),/选择「收藏牛人」/);
  assert.equal(wrong.calls.length,21);
  assert.ok(!wrong.calls.some(c=>c.args[0].action==='open'));
});

test('a previously opened detail is surfaced immediately on retry without another click',async()=>{
  const h=harness([[row({ok:false,status:'blocked',reason:'detail_already_open'})]]);
  await assert.rejects(h.lookup.run(),/先关闭该简历/);
  assert.deepEqual(h.calls.map(c=>c.args[0].action),['reset','scan']);
});

test('public finder resource supports LAN navigation without granting all-host access',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.web_accessible_resources,[{resources:['favorite-finder.html'],matches:['http://*/*','https://*/*']}]);
  assert.ok(manifest.optional_host_permissions.includes('http://*/*'));
  assert.deepEqual(manifest.host_permissions,['http://127.0.0.1/*']);
  assert.equal(manifest.background,undefined);
});

test('popup binds an existing favorites tab to a one-time local launch instead of a URL tab number',async()=>{
  const html=await readFile(new URL('../extension/popup.html',import.meta.url),'utf8');
  const source=(await readFile(new URL('../extension/popup.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'');
  for(const url of [FAVORITES_URL,'https://www.zhipin.com/web/chat/search','https://www.zhipin.com.evil.example/web/chat/interaction']){
    const {document}=parseHTML(html),saved=[],opened=[];
    let click;
    document.querySelector('#open-favorite-finder').addEventListener=(_,fn)=>{click=fn;};
    const chrome={runtime:{id:'a'.repeat(32),getURL:path=>'chrome-extension://'+'a'.repeat(32)+'/'+path},
      tabs:{query:async()=>[{id:42,url}]},storage:{session:{set:async value=>saved.push(value)}},
      windows:{create:async value=>opened.push(value)}};
    vm.runInNewContext(source,{document,chrome,URL,crypto:webcrypto,window:{close(){}},isBoss:()=>true,
      loadWorkbenchOrigin:async()=>WORKBENCH_ORIGIN,ensureWorkbenchPermission:async origin=>origin,assertWorkbenchPaired:()=>true});
    await new Promise(resolve=>setImmediate(resolve));
    await click();
    if(url===FAVORITES_URL){
      assert.equal(saved.length,1);assert.equal(opened.length,1);
      const launched=new URL(opened[0].url),nonce=launched.searchParams.get('launch');
      assert.match(nonce,/^[a-f0-9]{32}$/);
      assert.equal(saved[0]['favoriteFinderLaunch:'+nonce].tabId,42);
      assert.equal(launched.searchParams.has('tab'),false);
    }else{assert.equal(saved.length,0);assert.equal(opened.length,0);}
  }
});

async function finderPage({paired=true,auto=false,manual=false,lookupResult={status:'not_found'},
    origin=WORKBENCH_ORIGIN,requestedOrigin=origin,permission=true,grant=true}={}){
  const html=await readFile(new URL('../extension/favorite-finder.html',import.meta.url),'utf8');
  const source=(await readFile(new URL('../extension/favorite-finder.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'');
  const {document}=parseHTML(html),requests=[],permissionRequests=[],handlers=new Map(),createdTabs=[],activatedTabs=[],tabs=new Map(),runTargets=[];
  for(const id of ['load','start','stop','show-tab','candidate-id'])document.getElementById(id).addEventListener=(type,fn)=>handlers.set(id+':'+type,fn);
  const context={document,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,
    location:{search:auto?'?'+new URLSearchParams({candidate:'7',workbench:requestedOrigin}):''},
    loadWorkbenchOrigin:async()=>origin,hasWorkbenchPermission:async()=>permission,
    ensureWorkbenchPermission:async value=>{permissionRequests.push(value);if(!grant)throw Error('未允许访问工作台');permission=true;return value;},

    window:{addEventListener(){}},finderParameters,validFavoriteTarget,interactionUrl,FAVORITES_URL,WORKBENCH_ORIGIN,
    favoriteLocatorAction:()=>{},createFavoriteLookup:({onProgress,target})=>({stop(){},async run(){
      runTargets.push(target.id);
      onProgress({text:'正在检查',diagnostics:{root_count:4,card_count:4,target_work_row_counts:[2,1],
        name_paths:[[{tag:'SPAN',classes:'name'}]],target_match_reasons:['insufficient_evidence'],
        company_matches:[1],school_matches:[1],dated_company_matches:[0],
        target_row_structures:[{card:{tag:'LI',classes:'candidate'},rows:[{tag:'DIV',classes:'timeline-item'}]}],
        target_work_rows:[[{text:'2024.04 至今 示例公司',children:[{tag:'SPAN',classes:'company'}]}]],
        target_components:[[{name:'CandidateCard',props:['geekId','workList']}]],
        raw_resume:'must-not-display'}});
      return lookupResult;
    }}),chrome:{runtime:{id:'a'.repeat(32)},permissions:{contains:async()=>true},tabs:{
      create:async options=>{const id=42+createdTabs.length,tab={id,url:options.url};createdTabs.push(tab);tabs.set(id,tab);return tab;},
      get:async id=>{if(!tabs.has(id))throw Error('closed');return tabs.get(id);},
      update:async(id,options)=>{activatedTabs.push({id,options});return tabs.get(id);},
    }},
    fetch:async(url,options)=>{
      requests.push({url,options});
      if(url.endsWith('/favorite-session'))return {ok:options.method==='POST',json:async()=>options.method==='POST'
        ?{extension_id:(paired?'a':'b').repeat(32),token:'session-secret',favorite_locator_version:1}
        :{error:'仅允许配对扩展访问'}};
      if(url.endsWith('/favorite-target'))return {ok:true,json:async()=>({ok:true,target:{...target,input_key:'fingerprint',id:JSON.parse(options.body).id}})};
      if(url.endsWith('/favorite-binding'))return {ok:true,json:async()=>({ok:true})};
      throw Error('Unexpected request');
    }};
  await vm.runInNewContext('(async()=>{'+source+'})()',context);
  if(!auto&&!manual){document.getElementById('candidate-id').value='7';handlers.get('load:click')();await new Promise(resolve=>setImmediate(resolve));}
  return {document,requests,permissionRequests,createdTabs,activatedTabs,tabs,runTargets,
    input(value){document.getElementById('candidate-id').value=value;handlers.get('candidate-id:input')();},
    async load(){handlers.get('load:click')();await new Promise(resolve=>setImmediate(resolve));},
    async start(){handlers.get('start:click')();await new Promise(resolve=>setImmediate(resolve));}};
}

test('finder bootstrap uses JSON POST without a token in URL or a forged Origin',async()=>{
  const view=await finderPage();
  assert.equal(view.requests.length,2);
  assert.equal(view.requests[0].url,WORKBENCH_ORIGIN+'/api/extension/favorite-session');
  assert.equal(view.requests[0].options.method,'POST');
  assert.equal(view.requests[0].options.body,'{}');
  assert.equal(view.requests[0].options.headers['Content-Type'],'application/json');
  assert.equal(view.requests[0].options.headers.Origin,undefined);
  assert.equal(view.requests[1].options.headers['X-App-Token'],'session-secret');
  assert.equal(view.requests[1].options.body,'{"id":7}');
  assert.ok(view.requests.every(item=>!item.url.includes('session-secret')));
  assert.equal(view.document.querySelector('#start').disabled,false);
  const rejected=await finderPage({paired:false});
  assert.equal(rejected.requests.length,1);
  assert.equal(rejected.document.querySelector('#start').disabled,true);
});

test('a workbench candidate link starts once after loading but manual archive reads wait for Start',async()=>{
  const automatic=await finderPage({auto:true});
  assert.deepEqual(automatic.runTargets,[7]);
  await automatic.load();
  assert.deepEqual(automatic.runTargets,[7]);
  assert.equal(automatic.createdTabs.length,1);
  const manual=await finderPage({manual:true});
  assert.deepEqual(manual.runTargets,[]);
  manual.input('140');await manual.load();
  assert.deepEqual(manual.runTargets,[]);
  await manual.start();
  assert.deepEqual(manual.runTargets,[140]);
  const rejected=await finderPage({auto:true,paired:false});
  assert.deepEqual(rejected.runTargets,[]);
});

test('finder saves a mapping and displays success only for a visibly revealed verified card',async()=>{
  const verified={name:target.name,account_uid:'123',platform_geek_id:'encrypted-id',boss_chat_uid:'456'};
  for(const lookupResult of [{status:'located',verified},{status:'located',verified,card_visible:false},
    {status:'located',card_visible:true},{status:'located',verified,card_visible:true}]){
    const view=await finderPage({auto:true,lookupResult});
    const success=Boolean(lookupResult.card_visible&&lookupResult.verified);
    assert.equal(view.requests.some(item=>item.url.endsWith('/favorite-binding')),success);
    assert.equal(view.document.querySelector('#status').dataset.state==='done',success);
    if(success)assert.match(view.document.querySelector('#status').textContent,/高亮其卡片/);
  }
});

test('finder diagnostics preserve professional row counts without arbitrary page contents',async()=>{
  const view=await finderPage();await view.start();
  const diagnostic=JSON.parse(view.document.querySelector('#diagnostics').textContent);
  assert.deepEqual(diagnostic.target_work_row_counts,[2,1]);
  assert.deepEqual(diagnostic.name_paths,[[{tag:'SPAN',classes:'name'}]]);
  assert.deepEqual(diagnostic.target_match_reasons,['insufficient_evidence']);
  assert.deepEqual(diagnostic.company_matches,[1]);
  assert.deepEqual(diagnostic.school_matches,[1]);
  assert.deepEqual(diagnostic.dated_company_matches,[0]);
  assert.deepEqual(diagnostic.target_row_structures,[{card:{tag:'LI',classes:'candidate'},rows:[{tag:'DIV',classes:'timeline-item'}]}]);
  assert.deepEqual(diagnostic.target_work_rows,[[{text:'2024.04 至今 示例公司',children:[{tag:'SPAN',classes:'company'}]}]]);
  assert.deepEqual(diagnostic.target_components,[[{name:'CandidateCard',props:['geekId','workList']}]]);
  assert.equal(diagnostic.raw_resume,undefined);
  assert.equal(view.document.querySelector('#diagnostics-box').hidden,false);
});

test('retry reuses only its own interaction tab and leaves an owned tab that navigated away untouched',async()=>{
  const view=await finderPage();await view.start();await view.start();
  assert.equal(view.createdTabs.length,1);
  assert.equal(view.activatedTabs.length,1);
  assert.equal(view.activatedTabs[0].id,42);
  view.tabs.set(42,{id:42,url:'https://www.zhipin.com/web/chat/index'});
  await view.start();
  assert.equal(view.createdTabs.length,2);
  assert.equal(view.activatedTabs.length,1);
  assert.equal(view.tabs.get(42).url,'https://www.zhipin.com/web/chat/index');
});

test('editing a candidate number immediately revokes the previously loaded target until it is reloaded',async()=>{
  const view=await finderPage();
  assert.equal(view.document.querySelector('#start').disabled,false);
  view.input('140');
  assert.equal(view.document.querySelector('#start').disabled,true);
  assert.match(view.document.querySelector('#target').textContent,/请先读取档案/);
  await view.start();
  assert.equal(view.createdTabs.length,0);
  await view.load();
  assert.equal(view.document.querySelector('#start').disabled,false);
  assert.match(view.document.querySelector('#target').textContent,/#140/);
  assert.equal(view.requests.at(-1).options.body,'{"id":140}');
});

test('a changed input value cannot open the old target even when no input event was dispatched',async()=>{
  const view=await finderPage();view.document.querySelector('#candidate-id').value='140';
  await view.start();
  assert.equal(view.createdTabs.length,0);
  assert.equal(view.document.querySelector('#start').disabled,true);
});

test('LAN finder rejects other configured hosts, schemes and ports before any request or permission prompt',async()=>{
  const origin='http://192.168.1.9:8765';
  assert.deepEqual(finderParameters('?candidate=7&workbench='+encodeURIComponent(origin),origin),{candidateId:7,launch:null});
  for(const requestedOrigin of ['http://192.168.1.8:8765','http://127.0.0.1:8765','http://192.168.1.9:9999','https://192.168.1.9:8765']){
    const view=await finderPage({auto:true,origin,requestedOrigin});
    assert.equal(view.requests.length,0);
    assert.equal(view.permissionRequests.length,0);
    assert.equal(view.document.querySelector('#load').disabled,true);
    assert.match(view.document.querySelector('#status').textContent,/配置不一致/);
    await view.load();
    assert.equal(view.requests.length,0);
  }
});

test('LAN archive reads wait for a user permission click and send all data only to the configured server',async()=>{
  const origin='http://10.177.156.46:8765';
  const view=await finderPage({auto:true,origin,permission:false});
  assert.equal(view.requests.length,0);
  assert.equal(view.permissionRequests.length,0);
  assert.equal(view.document.querySelector('#workbench').getAttribute('href'),origin+'/');
  assert.equal(view.document.querySelector('#load').textContent,'连接并读取档案');
  await view.load();
  assert.deepEqual(view.permissionRequests,[origin]);
  assert.equal(view.requests.length,2);
  assert.ok(view.requests.every(request=>new URL(request.url).origin===origin));
  assert.equal(view.requests[1].options.headers['X-App-Token'],'session-secret');
  assert.equal(view.document.querySelector('#start').disabled,false);
});

test('denied LAN host permission never reads the session or candidate',async()=>{
  const view=await finderPage({auto:true,origin:'http://10.0.0.8:8765',permission:false,grant:false});
  await view.load();
  assert.equal(view.permissionRequests.length,1);
  assert.equal(view.requests.length,0);
  assert.equal(view.document.querySelector('#start').disabled,true);
  assert.match(view.document.querySelector('#status').textContent,/未允许/);
});
