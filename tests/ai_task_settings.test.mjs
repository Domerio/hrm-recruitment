import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React, {act} from 'react';
import {parseHTML} from 'linkedom';

const {window} = parseHTML('<html><body></body></html>');
const prior = new Map(), timers = new Map();
let nextTimer = 0;
function installDOM() {
  for (const [key,value] of Object.entries({window, document:window.document, IS_REACT_ACT_ENVIRONMENT:true})) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
}
function restoreDOM() {
  for (const [key,descriptor] of prior) {
    if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
  }
  prior.clear();
}
after(restoreDOM);
const {createRoot} = await import('react-dom/client');
const output = await build({
  entryPoints:[fileURLToPath(new URL('../frontend/AiTaskSettings.jsx',import.meta.url))],
  bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic',
  plugins:[{name:'native-task-settings-controls',setup(builder) {
    builder.onResolve({filter:/^react(?:\/.*)?$/},args => ({path:args.path,external:true}));
    builder.onResolve({filter:/^antd$/},() => ({path:'antd',namespace:'controls'}));
    builder.onLoad({filter:/.*/,namespace:'controls'},() => ({loader:'jsx',contents:`
      import React from 'react';
      const Block=({children,role})=><div role={role}>{children}</div>;
      export const Flex=Block,Tag=Block;
      export const Typography={Text:Block};
      export const Card=({children,title})=><section><h3>{title}</h3>{children}</section>;
      export const Alert=({title})=><aside>{title}</aside>;
      export const InputNumber=({id,min,max,value,disabled,onChange})=><input type="number" id={id} min={min} max={max}
        value={value??''} disabled={disabled} onInput={event=>onChange(event.target.value===''?null:Number(event.target.value))}/>;
      export const Button=({children,onClick,disabled})=><button onClick={onClick} disabled={disabled}>{children}</button>;
    `}));
  }}],
});
const module = {exports:{}};
vm.runInNewContext(output.outputFiles[0].text, {module,exports:module.exports,require:createRequire(import.meta.url),console,
  setInterval:(callback,ms) => {const id=++nextTimer;timers.set(id,{callback,ms});return id;},
  clearInterval:id => timers.delete(id),
});
const Component = module.exports.default;
const response = body => ({json:async() => body});
const settings = (extra={}) => ({max_concurrency:3,max_pending:100,queued:0,running:0,...extra});
const snapshot = (extra={},tasks=[]) => response({settings:settings(extra),tasks});
function deferred() {
  let resolve,reject;
  const promise = new Promise((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function mount(api) {
  installDOM();
  const element=document.createElement('div');document.body.append(element);
  const root=createRoot(element),notifications=[];
  const render = async nextApi => act(async() => root.render(React.createElement(Component,{api:nextApi,notify:(...args)=>notifications.push(args)})));
  await render(api);
  return {element,notifications,render,unmount:async() => {
    await act(async() => root.unmount());element.remove();restoreDOM();
    assert.equal(timers.size,0,'unmount must clear polling');
  }};
}
const saveButton = view => view.element.querySelector('button');
const input = view => view.element.querySelector('input');
async function edit(view,value) {
  await act(async() => {input(view).value=String(value);input(view).dispatchEvent(new window.Event('input',{bubbles:true}));});
}
async function tick() {
  await act(async() => {for (const timer of [...timers.values()]) {assert.equal(timer.ms,3000);timer.callback();}});
}

test('unknown initial state and failed reads never appear idle or allow a settings write',async() => {
  const pending=deferred(),calls=[];
  const view=await mount(async(path,data) => {calls.push({path,data});return pending.promise;});
  try {
    assert.equal(input(view).value,'3');assert.equal(saveButton(view).disabled,true);
    assert.match(view.element.textContent,/正在读取任务状态/);
    await act(async() => pending.reject(Error('secret upstream body')));
    assert.equal(saveButton(view).disabled,true);
    assert.match(view.element.textContent,/当前任务状态未知/);
    assert.doesNotMatch(view.element.textContent,/暂无任务记录|正在运行 0|secret upstream/);
    await act(async() => saveButton(view).click());assert.equal(calls.length,1);
  } finally {await view.unmount();}
});

test('busy public queue disables saving, caps recent history, and excludes private task fields',async() => {
  const tasks=Array.from({length:25},(_,index) => ({id:`task-${index}`,state:index===24?'queued':'succeeded',position:2,
    created_at:`2026-11-20T10:${String(index).padStart(2,'0')}:00Z`,
    metadata:{candidate_name:`候选人${index}`,job_title:'工程师',resume:'HIDDEN-RESUME',api_key:'HIDDEN-KEY'},
    result:{resume:'HIDDEN-RESULT'},error:'HIDDEN-ERROR'}));
  const view=await mount(async() => snapshot({queued:1,running:2},tasks));
  try {
    assert.equal(saveButton(view).disabled,true);
    assert.match(view.element.textContent,/正在运行 2 个 · 排队 1 个/);
    const rows=view.element.querySelectorAll('li');assert.equal(rows.length,20);
    assert.match(rows[0].textContent,/候选人24/);assert.match(rows[0].textContent,/第 2 位/);
    assert.match(rows[19].textContent,/候选人5/);assert.doesNotMatch(view.element.textContent,/HIDDEN/);
    assert.equal(view.element.querySelectorAll('button').length,1,'public history has no cancellation action');
  } finally {await view.unmount();}
});

test('idle concurrency edits validate bounds, survive polling and send only the setting',async() => {
  const calls=[];
  const view=await mount(async(path,data) => {calls.push({path,data});
    return data ? response({settings:settings({max_concurrency:data.max_concurrency})}) : snapshot();});
  try {
    for (const invalid of ['',0,9,1.5]) {await edit(view,invalid);assert.equal(saveButton(view).disabled,true);}
    await edit(view,5);await tick();assert.equal(input(view).value,'5');
    assert.equal(saveButton(view).disabled,false);
    await act(async() => saveButton(view).click());
    const writes=calls.filter(call=>call.data);
    assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/ai/runtime');
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0].data)),{max_concurrency:5});
    assert.equal(input(view).value,'5');assert.equal(view.notifications.length,1);
  } finally {await view.unmount();}
});

test('polling has no overlapping reads and a failed refresh disables saving until recovery',async() => {
  const pending=deferred();let calls=0;
  const view=await mount(async() => {calls++;return calls===2?pending.promise:snapshot();});
  try {
    await tick();await tick();assert.equal(calls,2,'pending read must not be duplicated');
    await act(async() => pending.reject(Error('offline')));
    assert.equal(saveButton(view).disabled,true);assert.match(view.element.textContent,/当前任务状态未知/);
    await tick();assert.equal(calls,3);assert.equal(saveButton(view).disabled,false);
  } finally {await view.unmount();}
});

test('a stale poll cannot overwrite a completed setting save',async() => {
  const pending=deferred();let reads=0;
  const view=await mount(async(path,data) => data ? response(settings({max_concurrency:data.max_concurrency}))
    : ++reads===2 ? pending.promise : snapshot());
  try {
    await edit(view,7);await tick();
    await act(async() => saveButton(view).click());
    await act(async() => pending.resolve(snapshot({max_concurrency:2,queued:8})));
    assert.equal(input(view).value,'7');assert.equal(saveButton(view).disabled,false);
    assert.match(view.element.textContent,/排队 0 个/);
  } finally {await view.unmount();}
});

test('save failures require a fresh queue read, and invalid snapshots are never treated as idle',async() => {
  let reads=0;
  const view=await mount(async(path,data) => {
    if(data)throw Error('write failed with private upstream body');
    if(++reads===2)return response({settings:{max_concurrency:4},tasks:[]});
    return snapshot();
  });
  try {
    await edit(view,4);await act(async() => saveButton(view).click());
    assert.equal(saveButton(view).disabled,true);assert.match(view.element.textContent,/未能确认并发设置已保存/);
    assert.doesNotMatch(view.element.textContent,/private upstream/);
    await tick();assert.equal(saveButton(view).disabled,true);
    await tick();assert.equal(saveButton(view).disabled,false);assert.equal(input(view).value,'4');
  } finally {await view.unmount();}
});

test('changing api discards the old read and unmount discards late writes and notifications',async() => {
  const oldRead=deferred(),write=deferred();
  const view=await mount(async() => oldRead.promise);
  await view.render(async(path,data) => data ? write.promise : snapshot({max_concurrency:6}));
  await act(async() => oldRead.resolve(snapshot({max_concurrency:1,queued:20})));
  assert.equal(input(view).value,'6');assert.equal(saveButton(view).disabled,false);
  await edit(view,8);await act(async() => saveButton(view).click());
  assert.equal(saveButton(view).disabled,true);
  await view.unmount();
  await act(async() => write.resolve(snapshot({max_concurrency:8})));
  assert.equal(view.notifications.length,0);
});
