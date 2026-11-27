import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_WORKBENCH_ORIGIN} from '../extension/workbench-default.mjs';
import {normalizeWorkbenchOrigin,loadWorkbenchOrigin,workbenchPermission,
  hasWorkbenchPermission,ensureWorkbenchPermission,isLoopbackWorkbench,assertWorkbenchPaired}
  from '../extension/workbench-connection.mjs';

test('origins accept only canonical local and private-network HTTP(S) addresses',()=>{
  for(const value of ['http://127.0.0.1:8765','http://127.255.1.2:80','http://localhost:8765/',
    'https://LOCALHOST:443','http://[::1]:8765','http://10.177.137.55:8765',
    'http://172.16.0.1','https://172.31.255.254:8443','http://192.168.0.1:65535']){
    assert.equal(normalizeWorkbenchOrigin(value),new URL(value).origin,value);
  }
  for(const value of [null,{},'', 'https://example.com','http://8.8.8.8','http://172.15.0.1',
    'http://172.32.0.1','http://192.169.0.1','http://10.256.1.1','http://0.0.0.0',
    'file:///tmp/workbench','http://user:pass@127.0.0.1','http://127.0.0.1/path',
    'http://127.0.0.1?','http://127.0.0.1#','http://127.0.0.1:0','http://127.0.0.1:65536',
    'http://127.1','http://2130706433','http://0x7f000001','http://010.0.0.1',
    'http://localhost.evil.invalid','http://localhost.','http://[::2]',
    'http://127.0.0.1\\path','http://127.0.0.1\n','http://127.0.0.1/%2e']){
    assert.throws(()=>normalizeWorkbenchOrigin(value),/工作台地址/,String(value));
  }
});

test('automatic package default and optional saved origin are normalized without network calls',async()=>{
  const previous=globalThis.chrome;
  try{
    globalThis.chrome={storage:{local:{get:async key=>{assert.equal(key,'workbenchOrigin');return {};}}}};
    assert.equal(await loadWorkbenchOrigin(),DEFAULT_WORKBENCH_ORIGIN);
    globalThis.chrome.storage.local.get=async()=>({workbenchOrigin:'http://10.1.2.3:8765/'});
    assert.equal(await loadWorkbenchOrigin(),'http://10.1.2.3:8765');
    globalThis.chrome.storage.local.get=async()=>({workbenchOrigin:'https://external.invalid'});
    await assert.rejects(loadWorkbenchOrigin(),/工作台地址/);
  }finally{globalThis.chrome=previous;}
});

test('permissions request only the configured host and port directly in the user click stack',async()=>{
  const previous=globalThis.chrome,requests=[],checks=[];
  try{
    globalThis.chrome={permissions:{
      request:permission=>{requests.push(permission);return Promise.resolve(true);},
      contains:async permission=>{checks.push(permission);return true;},
    }};
    const pending=ensureWorkbenchPermission('http://10.1.2.3:8765');
    assert.equal(requests.length,1,'request happens before awaiting any other browser API');
    assert.equal(await pending,'http://10.1.2.3:8765');
    assert.deepEqual(requests,[{origins:['http://10.1.2.3:8765/*']}]);
    assert.equal(workbenchPermission('https://192.168.1.4:8443/'),'https://192.168.1.4:8443/*');
    assert.equal(await hasWorkbenchPermission('https://192.168.1.4:8443'),true);
    assert.deepEqual(checks,[{origins:['https://192.168.1.4:8443/*']}]);
    globalThis.chrome.permissions.request=async()=>false;
    await assert.rejects(ensureWorkbenchPermission('http://10.1.2.3:8765'),/尚未允许/);
    await assert.rejects(ensureWorkbenchPermission('https://public.invalid'),/工作台地址/);
    assert.equal(requests.length,1);
  }finally{globalThis.chrome=previous;}
});

test('clipboard locality and pairing are checked against this browser rather than any paired browser',()=>{
  for(const value of ['http://localhost:8765','http://127.0.0.2:8765','http://[::1]:8765'])
    assert.equal(isLoopbackWorkbench(value),true);
  assert.equal(isLoopbackWorkbench('http://10.1.2.3:8765'),false);
  const mine='a'.repeat(32),other='b'.repeat(32);
  assert.equal(assertWorkbenchPaired({extension_ids:[mine,other]},mine),true);
  assert.equal(assertWorkbenchPaired({extension_id:mine},mine),true);
  for(const state of [{extension_ids:[other]},{extension_ids:[],extension_id:mine},
    {extension_id:other},{extension_paired:true},null]){
    assert.throws(()=>assertWorkbenchPaired(state,mine),/此浏览器插件尚未授权/);
  }
  assert.throws(()=>assertWorkbenchPaired({extension_ids:['']},''),/此浏览器插件尚未授权/);
});
