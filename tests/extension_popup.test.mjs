import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { isBoss } from '../extension/capture-utils.mjs';
import { assertWorkbenchPaired } from '../extension/workbench-connection.mjs';

const html=fs.readFileSync(new URL('../extension/popup.html',import.meta.url),'utf8');
const script=fs.readFileSync(new URL('../extension/popup.js',import.meta.url),'utf8').replace(/^import .+;\r?\n/gm,'');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

async function popup({tab={id:42,url:'https://www.zhipin.com/web/geek/recommend'},query,create,
  origin='http://10.1.2.3:8765',permissionError,loadError,state={extension_ids:['a'.repeat(32)]},fetchError}={}){
  const {document}=parseHTML(html);
  const events=new Map(),opened=[],queries=[],effects=[],permissions=[];
  let closed=0;
  for(const id of ['open-collector','open-current','connect-workbench','open-communications','open-favorite-finder']){
    const element=document.getElementById(id);
    element.addEventListener=(type,listener)=>events.set(id+':'+type,listener);
  }
  const context={document,isBoss,assertWorkbenchPaired,AbortSignal,window:{close(){closed++;}},
    loadWorkbenchOrigin:async()=>{if(loadError)throw loadError;return origin;},
    ensureWorkbenchPermission:async value=>{permissions.push(value);if(permissionError)throw permissionError;return value;},
    fetch:async(url,options)=>{effects.push({url,options});if(fetchError)throw fetchError;return {ok:true,json:async()=>state};},
    chrome:{runtime:{id:'a'.repeat(32),getURL:path=>'chrome-extension://'+'a'.repeat(32)+'/'+path},
      tabs:{query:async options=>{queries.push(options);return query?query():[tab];}},
      windows:{create:async options=>{opened.push(options);return create?create(options):{id:1};}}}};
  vm.runInNewContext(script,context);
  await new Promise(done=>setImmediate(done));
  return {document,opened,queries,effects,permissions,get closed(){return closed;},
    click:id=>document.getElementById(id).disabled?undefined:events.get(id+':click')()};
}

test('list and current-resume entries open distinct, correctly bound collector URLs',async()=>{
  for(const [id,mode] of [['open-collector',null],['open-current','current']]){
    const view=await popup();
    assert.equal(view.document.querySelector('#extension-id').value,'a'.repeat(32));
    await view.click(id);
    assert.equal(view.opened.length,1);
    const target=view.opened[0],url=new URL(target.url);
    assert.equal(url.protocol,'chrome-extension:');
    assert.equal(url.pathname,'/collector.html');
    assert.equal(url.searchParams.get('tab'),'42');
    assert.equal(url.searchParams.get('mode'),mode);
    assert.equal(target.type,'popup');
    assert.equal(view.queries[0].active,true);assert.equal(view.queries[0].currentWindow,true);
    assert.equal(view.closed,1);
    assert.deepEqual(view.effects,[]);
  }
});

test('both launch buttons stay disabled throughout a pending tab query and window open',async()=>{
  for(const id of ['open-collector','open-current']){
    const query=deferred(),creation=deferred();
    const view=await popup({query:()=>query.promise,create:()=>creation.promise});
    const started=view.click(id);
    assert.equal(view.document.querySelector('#open-collector').disabled,true);
    assert.equal(view.document.querySelector('#open-current').disabled,true);
    assert.equal(view.click(id==='open-current'?'open-collector':'open-current'),undefined);
    query.resolve([{id:77,url:'https://zhipin.com/web/chat/search'}]);
    await new Promise(done=>setImmediate(done));
    assert.equal(view.opened.length,1);
    assert.equal(view.document.querySelector('#open-current').disabled,true);
    assert.equal(view.closed,0);
    creation.resolve({id:1});await started;
    assert.equal(view.closed,1);
    assert.equal(view.opened.length,1);
  }
});

test('non-BOSS and missing active tabs show the appropriate error and release both buttons',async()=>{
  for(const tab of [undefined,{id:3,url:'http://www.zhipin.com/'},{id:3,url:'https://www.zhipin.com.example.invalid/'},
    {id:3,url:'chrome://extensions'}]){
    for(const id of ['open-collector','open-current']){
      const view=await popup({query:async()=>tab?[tab]:[]});
      await view.click(id);
      assert.equal(view.opened.length,0);assert.equal(view.closed,0);
      const status=view.document.querySelector('#status');
      assert.equal(status.dataset.state,'error');
      assert.match(status.textContent,id==='open-current'?/打开一份简历/:/候选人列表页/);
      assert.equal(view.document.querySelector('#open-collector').disabled,false);
      assert.equal(view.document.querySelector('#open-current').disabled,false);
    }
  }
});

test('browser API failures are plain text and permit retry without issuing unrelated operations',async()=>{
  let attempts=0;
  const view=await popup({create:async()=>{if(!attempts++)throw Error('<img onerror="bad()"> window unavailable');return {id:1};}});
  await view.click('open-current');
  assert.match(view.document.querySelector('#status').textContent,/<img onerror="bad\(\)">/);
  assert.equal(view.document.querySelector('#status img'),null);
  assert.equal(view.document.querySelector('#open-current').disabled,false);
  await view.click('open-current');
  assert.equal(view.closed,1);assert.equal(view.opened.length,2);
  assert.deepEqual(view.effects,[]);
});


test('package origin is visible and workbench link needs no manually entered address',async()=>{
  const view=await popup();
  assert.equal(view.document.querySelector('#workbench-origin').value,'http://10.1.2.3:8765');
  assert.equal(view.document.querySelector('#workbench-origin').hasAttribute('readonly'),true);
  assert.equal(view.document.querySelector('#open-workbench').getAttribute('href'),'http://10.1.2.3:8765/');
  assert.equal(view.effects.length,0);
  assert.equal(view.permissions.length,0);
});

test('permission refusal prevents launching collection and permits retry',async()=>{
  const view=await popup({permissionError:Error('permission denied')});
  await view.click('open-collector');
  assert.deepEqual(view.permissions,['http://10.1.2.3:8765']);
  assert.equal(view.queries.length,0);
  assert.equal(view.opened.length,0);
  assert.equal(view.document.querySelector('#open-collector').disabled,false);
  assert.match(view.document.querySelector('#status').textContent,/permission denied/);
});

test('connection verifies this extension ID at the automatic server without altering mode',async()=>{
  const view=await popup();
  await view.click('connect-workbench');
  assert.deepEqual(view.permissions,['http://10.1.2.3:8765']);
  assert.equal(view.effects.length,1);
  assert.equal(view.effects[0].url,'http://10.1.2.3:8765/api/state');
  assert.equal(view.effects[0].options.redirect,'error');
  assert.equal(view.document.querySelector('#status').dataset.state,'ready');
  assert.equal(view.opened.length,0);
  assert.equal(view.closed,0);
  const other=await popup({state:{extension_ids:['b'.repeat(32)]}});
  await other.click('connect-workbench');
  assert.match(other.document.querySelector('#status').textContent,/此浏览器插件尚未授权/);
  assert.equal(other.document.querySelector('#status').dataset.state,'error');
});

test('invalid configured address prevents collection; unavailable server explains first-use pairing',async()=>{
  const broken=await popup({loadError:Error('invalid configured origin')});
  assert.equal(broken.document.querySelector('#open-collector').disabled,true);
  assert.equal(broken.document.querySelector('#open-workbench').hasAttribute('href'),false);
  assert.match(broken.document.querySelector('#status').textContent,/invalid configured origin/);
  const unavailable=await popup({fetchError:Error('failed to fetch')});
  await unavailable.click('connect-workbench');
  assert.match(unavailable.document.querySelector('#status').textContent,/首次使用.*扩展 ID/);
  assert.equal(unavailable.document.querySelector('#connect-workbench').disabled,false);
});
