import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {createPassiveCapture, summarizePassiveUrl, isBossNetworkUrl, isBossPageUrl,
  PASSIVE_PERMISSION, CAPTURE_DURATION_MS, CAPTURE_LIMIT} from '../extension/passive-network.mjs';

const PAGE = 'https://www.zhipin.com/web/chat/index';
function event() {
  const callbacks = new Set(), calls = [];
  return {callbacks, calls, addListener(...args) { calls.push(args); callbacks.add(args[0]); },
    removeListener(fn) { callbacks.delete(fn); }, fire(...args) { for (const fn of [...callbacks]) fn(...args); }};
}
function fixture(overrides={}) {
  const api = {webRequest:{onBeforeRequest:event(), onCompleted:event(), onErrorOccurred:event(), onBeforeRedirect:event()},
    tabs:{onUpdated:event(), onRemoved:event()}}, stops = [], timers = new Map();
  let nextTimer = 0;
  const setTimer = (fn, ms) => { timers.set(++nextTimer, {fn, ms}); return nextTimer; };
  const clearTimer = id => timers.delete(id);
  const capture = createPassiveCapture({api, tabId:42, now:()=>1000, onStop:reason=>stops.push(reason), setTimer, clearTimer, ...overrides});
  const events = [...Object.values(api.webRequest), api.tabs.onUpdated, api.tabs.onRemoved];
  return {api, capture, stops, timers, events, setTimer, clearTimer};
}
const request = (id='r1', patch={}) => ({tabId:42, requestId:id, method:'GET', type:'xmlhttprequest',
  url:'https://www.zhipin.com/wapi/zpchat/boss/historyMsg?gid=123&securityId=SECRET&greet=PRIVATE_MESSAGE', ...patch});

test('passive URL summaries retain endpoint and strict IDs, never ordinary query values or credentials', () => {
  const result = summarizePassiveUrl('https://www.zhipin.com/wapi/zpjob/chat/start?gid=G_1&jid=J-2&greet=HELLO_SECRET&securityId=TOKEN_SECRET&lid=LIST_SECRET&name=NAME_SECRET&token=AUTH_SECRET#SESSION_SECRET');
  assert.equal(result.endpoint, 'https://www.zhipin.com/wapi/zpjob/chat/start');
  assert.deepEqual(result.ids, [{field:'gid', value:'G_1'}, {field:'jid', value:'J-2'}]);
  assert.deepEqual(result.query_keys, ['gid','jid','greet','securityId','lid','name','token']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.deepEqual(summarizePassiveUrl(`${PAGE}?gid=first&gid=second&jid=bad%20value&encryptGeekId=${'a'.repeat(161)}`).ids, []);
  assert.equal(summarizePassiveUrl('https://name:password@www.zhipin.com/wapi/x'), null);
  for (const url of ['http://www.zhipin.com/x','https://zhipin.com.evil.test/x','https://evilzhipin.com/x','https://evil.test/x']) assert.equal(isBossNetworkUrl(url), false);
  assert.equal(isBossNetworkUrl('wss://chat.zhipin.com/ws'), true);
  assert.equal(isBossPageUrl('wss://chat.zhipin.com/ws'), false);
  assert.equal(summarizePassiveUrl('https://www.zhipin.com/token/PRIVATE').endpoint, 'https://www.zhipin.com/token/[redacted]');
});

test('encrypted identity summaries accept one trailing tilde without relaxing secrets or other IDs', () => {
  const result = summarizePassiveUrl(`${PAGE}?encryptId=Resume_123%7E&encryptGeekId=Geek-4~&uid=12~&securityId=SECRET~&token=SECRET~`);
  assert.deepEqual(result.ids, [{field:'encryptGeekId', value:'Geek-4~'}, {field:'encryptId', value:'Resume_123~'}]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  for (const value of ['~', 'A~~', 'A~B', 'A%20B', 'A%2FB', 'a'.repeat(160) + '~']) {
    assert.deepEqual(summarizePassiveUrl(`${PAGE}?encryptId=${value}`).ids, []);
  }
  assert.deepEqual(summarizePassiveUrl(`${PAGE}?encryptId=A~&encryptId=B~`).ids, []);
});

test('non-wapi subframes and XHR preserve safe frame metadata only in the chosen tab', () => {
  const f = fixture(); f.capture.start(PAGE);
  for (const [index, type] of ['main_frame', 'sub_frame', 'xmlhttprequest'].entries()) {
    const details = request(`canvas-${index}`, {type, frameId:index, parentFrameId:index ? 0 : -1,
      url:`https://www.zhipin.com/web/geek/resume?encryptId=R_${index}~&securityId=SECRET&body=PRIVATE_MESSAGE`});
    for (const key of ['requestHeaders', 'responseHeaders', 'requestBody', 'responseBody'])
      Object.defineProperty(details, key, {get() { throw Error('Forbidden data accessed'); }});
    f.api.webRequest.onBeforeRequest.fire({...details, tabId:43});
    f.api.webRequest.onBeforeRequest.fire(details);
    f.api.webRequest.onCompleted.fire({tabId:42, requestId:`canvas-${index}`, statusCode:200});
  }
  for (const type of ['script', 'image', 'other'])
    f.api.webRequest.onBeforeRequest.fire(request(type, {type, url:'https://www.zhipin.com/assets/resource'}));
  f.api.webRequest.onBeforeRequest.fire(request('foreign', {type:'sub_frame', url:'https://outside.invalid/resume'}));
  const records = f.capture.snapshot().slice(1);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(row => row.resource_type), ['main_frame', 'sub_frame', 'xmlhttprequest']);
  assert.deepEqual(records.map(row => [row.frameId, row.parentFrameId]), [[0,-1],[1,0],[2,0]]);
  assert.ok(records.every(row => row.status === 200 && row.type === 'http'));
  assert.doesNotMatch(JSON.stringify(records), /SECRET|PRIVATE_MESSAGE|requestHeaders|responseHeaders|requestBody|responseBody/);
  f.capture.stop();
});

test('invalid or absent resource frame metadata is not copied from callbacks', () => {
  const f = fixture(); f.capture.start(PAGE);
  f.api.webRequest.onBeforeRequest.fire(request('missing'));
  f.api.webRequest.onBeforeRequest.fire(request('invalid', {frameId:'SECRET', parentFrameId:-2, type:'SECRET'}));
  assert.deepEqual(f.capture.snapshot().slice(1).map(row => [row.frameId, row.parentFrameId]), [[null,null],[null,null]]);
  assert.equal(f.capture.snapshot()[2].resource_type, 'unknown');
  assert.doesNotMatch(JSON.stringify(f.capture.snapshot()), /SECRET/);
  f.capture.stop();
});

test('address-bar SPA route only retains safe parameter names and allowlisted identities', () => {
  const result = summarizePassiveUrl(`${PAGE}?token=TOP_SECRET#/chat?friendId=F12&securityId=HASH_SECRET&message=MESSAGE_SECRET`, {addressBar:true});
  assert.equal(result.fragment_route.path, '/chat');
  assert.deepEqual(result.fragment_route.ids, [{field:'friendId', value:'F12'}]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(summarizePassiveUrl(`${PAGE}#token=SECRET`, {addressBar:true}).fragment_route, undefined);
});

test('listeners are tab-scoped with no header/body extraInfoSpec; snapshots omit forbidden fields', () => {
  const f = fixture(); f.capture.start(PAGE);
  for (const e of Object.values(f.api.webRequest)) {
    assert.equal(e.calls[0].length, 2);
    assert.equal(e.calls[0][1].tabId, 42);
    assert.deepEqual(e.calls[0][1].urls, PASSIVE_PERMISSION.origins);
  }
  f.api.webRequest.onBeforeRequest.fire(request('other', {tabId:43}));
  f.api.webRequest.onBeforeRequest.fire(request('outside', {url:'https://evil.test/wapi/x'}));
  f.api.webRequest.onBeforeRequest.fire(request('asset', {url:'https://www.zhipin.com/x.js', type:'script'}));
  const details = request();
  for (const key of ['requestHeaders','requestBody','responseBody']) Object.defineProperty(details, key, {get() { throw Error('Forbidden data accessed'); }});
  f.api.webRequest.onBeforeRequest.fire(details);
  f.api.webRequest.onCompleted.fire({tabId:43, requestId:'r1', statusCode:200});
  assert.equal(f.capture.snapshot()[1].status, null);
  f.api.webRequest.onCompleted.fire({tabId:42, requestId:'r1', statusCode:200});
  assert.equal(f.capture.snapshot().length, 2);
  assert.equal(f.capture.snapshot()[1].status, 200);
  assert.equal(f.capture.snapshot()[1].outcome, 'completed');
  assert.doesNotMatch(JSON.stringify(f.capture.snapshot()), /SECRET|PRIVATE_MESSAGE|requestHeaders|requestBody|responseBody/);
  f.capture.stop();
});

test('websocket records are handshake metadata only, error strings are not copied', () => {
  const f = fixture(); f.capture.start(PAGE);
  f.api.webRequest.onBeforeRequest.fire(request('ws', {type:'websocket', url:'wss://chat.zhipin.com/chat?uid=12&token=AUTH_SECRET'}));
  f.api.webRequest.onCompleted.fire({tabId:42, requestId:'ws', statusCode:101});
  assert.equal(f.capture.snapshot()[1].type, 'websocket_handshake');
  assert.equal(f.capture.snapshot()[1].status, 101);
  f.api.webRequest.onBeforeRequest.fire(request('failed'));
  f.api.webRequest.onErrorOccurred.fire({tabId:42, requestId:'failed', error:'url with SECRET'});
  assert.equal(f.capture.snapshot()[2].outcome, 'failed');
  assert.doesNotMatch(JSON.stringify(f.capture.snapshot()), /SECRET/);
  f.capture.stop();
});

test('cap evicts pending requests and clear removes pending response associations', () => {
  const f = fixture(); f.capture.start(PAGE);
  for (let i=0; i<350; i++) f.api.webRequest.onBeforeRequest.fire(request(String(i)));
  assert.equal(f.capture.snapshot().length, CAPTURE_LIMIT);
  const before = f.capture.snapshot();
  f.api.webRequest.onCompleted.fire({tabId:42, requestId:'0', statusCode:200});
  assert.deepEqual(f.capture.snapshot(), before);
  f.capture.clear();
  f.api.webRequest.onCompleted.fire({tabId:42, requestId:'349', statusCode:200});
  assert.deepEqual(f.capture.snapshot(), []);
  f.capture.stop();
});

test('manual stop, timeout, target tab closure and leaving BOSS remove every listener and timer', () => {
  for (const reason of ['manual', 'timeout', 'tab_closed', 'left_boss']) {
    const f = fixture(); f.capture.start(PAGE);
    assert.equal([...f.timers.values()][0].ms, CAPTURE_DURATION_MS);
    if (reason === 'manual') f.capture.stop();
    if (reason === 'timeout') [...f.timers.values()][0].fn();
    if (reason === 'tab_closed') f.api.tabs.onRemoved.fire(42);
    if (reason === 'left_boss') f.api.tabs.onUpdated.fire(42, {url:'https://example.com/'});
    assert.equal(f.capture.active, false);
    assert.equal(f.timers.size, 0);
    assert.ok(f.events.every(e=>e.callbacks.size === 0));
    assert.equal(f.stops.at(-1), reason);
    const count = f.capture.snapshot().length;
    f.api.webRequest.onBeforeRequest.fire(request('late'));
    assert.equal(f.capture.snapshot().length, count);
  }
});

test('address-bar observations exclude unrelated tabs and are not treated as proven deep links', () => {
  const f = fixture(); f.capture.start(PAGE);
  f.api.tabs.onUpdated.fire(43, {url:`${PAGE}?friendId=OTHER`});
  f.api.tabs.onUpdated.fire(42, {url:`${PAGE}?friendId=F1&securityId=SECRET`});
  assert.equal(f.capture.snapshot().length, 2);
  assert.equal(f.capture.snapshot()[1].kind, 'address_bar');
  assert.deepEqual(f.capture.snapshot()[1].ids, [{field:'friendId',value:'F1'}]);
  assert.equal(f.capture.snapshot()[1].url, undefined);
  f.capture.stop();
});

test('partial listener startup and runtime callback exceptions clean up previously installed listeners', () => {
  const f = fixture();
  f.api.webRequest.onErrorOccurred.addListener = () => { throw Error('denied'); };
  assert.throws(()=>f.capture.start(PAGE), /denied/);
  assert.ok(f.events.every(e=>e.callbacks.size === 0));
  assert.equal(f.capture.active, false);
  let throwNow = false;
  const g = fixture({onChange:()=>{ if (throwNow) throw Error('render failed'); }});
  g.capture.start(PAGE); throwNow = true;
  g.api.webRequest.onBeforeRequest.fire(request());
  assert.equal(g.capture.active, false);
  assert.equal(g.stops.at(-1), 'listener_error');
  assert.ok(g.events.every(e=>e.callbacks.size === 0));
  assert.equal(g.timers.size, 0);
});

function uiFixture() {
  const f = fixture(), windowEvents = new Map(), order = [];
  const {document} = parseHTML(fs.readFileSync(new URL('../extension/network-inspector.html', import.meta.url), 'utf8'));
  const window = {addEventListener(name, fn) { windowEvents.set(name, fn); }};
  const api = {...f.api, permissions:{request() { order.push('permission'); return Promise.resolve(true); }},
    tabs:{...f.api.tabs, get:async()=>{ order.push('tab'); return {url:PAGE}; }}};
  let controller;
  const source = fs.readFileSync(new URL('../extension/network-inspector.js', import.meta.url),'utf8').replace(/^import .*;\r?\n/, '');
  vm.runInNewContext(source, {document, window, chrome:api, location:{search:'?tab=42'}, URLSearchParams,
    PASSIVE_PERMISSION, createPassiveCapture:options=>(controller=createPassiveCapture({...options,setTimer:f.setTimer,clearTimer:f.clearTimer})),
    navigator:{clipboard:{writeText:async()=>{}}}});
  return {...f, api, document, windowEvents, order, controller:()=>controller};
}
const tick = () => new Promise(resolve=>setImmediate(resolve));

test('inspector requests optional permission from click before tab await and stops on pagehide/error', async () => {
  for (const name of ['pagehide','error','unhandledrejection']) {
    const f = uiFixture(); f.document.querySelector('#start').click();
    assert.deepEqual(f.order, ['permission']);
    await tick(); assert.deepEqual(f.order, ['permission','tab']);
    assert.equal(f.controller().active, true);
    f.windowEvents.get(name)();
    assert.equal(f.controller().active, false);
    assert.ok(f.events.every(e=>e.callbacks.size === 0));
    assert.equal(f.timers.size, 0);
  }
});

test('closing during pending permission never starts a capture later', async () => {
  const f = uiFixture(); let grant;
  f.api.permissions.request = () => new Promise(resolve=>{grant=resolve;});
  f.document.querySelector('#start').click(); f.windowEvents.get('pagehide')();
  grant(true); await tick();
  assert.equal(f.controller(), undefined);
  assert.ok(f.events.every(e=>e.callbacks.size === 0));
});

test('passive inspector has no debugger calls and manifest requests metadata permission only optionally', () => {
  const source = fs.readFileSync(new URL('../extension/network-inspector.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /chrome\.debugger|Network\.getResponseBody|Network\.enable|scripting\.executeScript/);
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.optional_permissions.includes('webRequest'));
  assert.ok(!manifest.permissions.includes('webRequest'));
  for (const origin of PASSIVE_PERMISSION.origins) assert.ok(manifest.optional_host_permissions.includes(origin));
});
