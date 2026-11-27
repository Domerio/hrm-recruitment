import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {installChatMessageSource, loadChatMessageHistory} from '../extension/chat-message-source.mjs';

const attachment = (changes = {}) => ({mid:55, from:{uid:101, source:0}, body:{type:12, hyperLink:{hyperLinkType:9,
  title:'候选人.pdf', url:'bosszp://bosszhipin.app/openwith?type=selectResumePreviewUrl&encryptId=RESUME&authType=0'}}, ...changes});
const card = '<div class="item-friend"><div class="resume-card"><i class="resume-icon"></i><div class="message-card-top-title">候选人.pdf</div><div class="message-card-buttons"><span class="card-btn">预览/下载</span></div></div></div>';

function setup({markup = `<div class="message-item">${card}</div>`, packet = attachment(), rootBinding = true, state, fetchImpl, clock} = {}) {
  const {document, window} = parseHTML(`<html><body><div class="chat-conversation" ${rootBinding ? 'data-friend-id="101"' : ''}><div class="chat-message-list">${markup}</div><div class="composer"><div id="boss-chat-editor-input" contenteditable="true"></div></div></div></body></html>`);
  Object.defineProperty(document, 'visibilityState', {value:'visible', configurable:true});
  const decorate = root => { for (const node of [root, ...root.querySelectorAll('*')]) Object.defineProperty(node, 'getClientRects', {value:() => node.hasAttribute('hidden') ? [] : [{}], configurable:true}); };
  decorate(document.documentElement);
  const chat = document.querySelector('.chat-conversation'), list = document.querySelector('.chat-message-list'), item = document.querySelector('.message-item'), editor = document.querySelector('.composer');
  editor.__vue__ = {conversation$:{friendId:101}};
  if (packet && item) item.__vue__ = {message:packet};
  if (state) chat.__vue__ = {messages:state};
  const context = vm.createContext({window, document, Node:window.Node, URL, URLSearchParams, AbortController, TextDecoder, setTimeout, clearTimeout,
    location:new URL('https://www.zhipin.com/web/chat/index'), fetch:fetchImpl || (async () => { throw Error('Unexpected request'); }),
    ...(clock ? {Date:class extends Date { static now() { return clock.now; } }} : {}),
    getComputedStyle:node => ({display:'block', visibility:node.hasAttribute('hidden') ? 'hidden' : 'visible'})});
  vm.runInContext(`(${installChatMessageSource.toString()})()`, context);
  const source = window.__hrmChatMessageSource;
  const read = friend_id => source.read({friend_id:friend_id || '101'});
  const load = (args = {}) => source.loadHistory({friend_id:'101', ...args});
  return {document, window, chat, list, item, editor, context, source, read, load, decorate};
}
const plain = value => JSON.parse(JSON.stringify(value));

test('installs a serialized MAIN helper and reads nested attachment packet without DOM ID or to', () => {
  const f = setup(), result = f.read();
  assert.equal(f.window.__hrmChatMessageSource.version, 1);
  assert.equal(result.visible_count, 1); assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].raw.mid, '55'); assert.equal(result.rows[0].direction, 'incoming');
  assert.equal(result.rows[0].scope_bound, true); assert.equal('to' in result.rows[0].raw, false);
  assert.equal(result.visible_attachment_count, 1); assert.equal(result.unresolved_attachments, 0);
});

test('new editor ID parent conversation binding works without a chat data-friend-id', () => {
  const f = setup({rootBinding:false});
  assert.equal(f.read().rows[0].friend_id, '101');
  f.editor.__vue__.conversation$ = {friendId:202};
  assert.throws(() => f.read(), /会话标识不一致/);
});

test('Vue RX editor conversation observable is a fixed, read-only binding source', () => {
  const f = setup({rootBinding:false});
  f.editor.__vue__ = {$observables:{conversation$:{_value:{friendId:101}}}};
  assert.equal(f.read().rows[0].friend_id, '101');
  f.editor.__vue__.$observables.conversation$._value.friendId = 202;
  assert.throws(() => f.read(), error => error.code === 'CONVERSATION_MISMATCH');
});

test('Vue reactive getters are read only for fixed semantic slots; private and unknown getters are never touched', () => {
  const f = setup({packet:null}); let reads = 0, privateReads = 0;
  const packet = {}, from = {}, body = {}, props = {};
  for (const [owner, key, result] of [[props,'message',packet],[packet,'mid',55],[packet,'from',from],[packet,'body',body],[from,'uid',101],[from,'source',0],[body,'type',12],[body,'hyperLink',attachment().body.hyperLink]]) {
    Object.defineProperty(owner, key, {enumerable:true, get() { reads++; return result; }});
  }
  for (const owner of [props, packet, from, body]) {
    Object.defineProperty(owner, 'privateToken', {enumerable:true, get() { privateReads++; throw Error('secret'); }});
    Object.defineProperty(owner, 'unexpectedGetter', {enumerable:true, get() { privateReads++; throw Error('unknown'); }});
  }
  f.item.querySelector('.resume-card').__vue__ = {_props:props};
  assert.equal(f.read().rows[0].raw.mid, '55'); assert.ok(reads > 0); assert.equal(privateReads, 0);
  assert.equal(JSON.stringify(plain(f.read())).includes('privateToken'), false);
});

test('structural extraction accepts unknown own data slots without guessing a message-list field', () => {
  const f = setup({packet:null});
  f.item.__vue__ = {$data:{renderCache:{customPayload:attachment()}}};
  assert.equal(f.read().rows[0].raw.mid, '55');
});

test('outer stable DOM ID and inner friend direction agree with the original packet', () => {
  const f = setup(); f.item.setAttribute('data-mid', '55');
  assert.equal(f.read().rows[0].direction, 'incoming');
  f.item.setAttribute('data-mid', '56');
  assert.throws(() => f.read(), error => error.code === 'MESSAGE_ID_CONFLICT');
});

test('one DOM item cannot provide two distinct raw packets even when each adds just one row', () => {
  const f = setup({packet:null});
  f.item.__vue__ = {$props:{first:attachment(), second:attachment({mid:56})}};
  assert.throws(() => f.read(), error => error.code === 'AMBIGUOUS_MESSAGE');
});

test('opposite sender direction and another candidate friend ID stop instead of silently skipping', () => {
  const f = setup({packet:attachment({from:{uid:999,source:1}, to:{uid:101}})});
  assert.throws(() => f.read(), error => error.code === 'MESSAGE_DIRECTION_CONFLICT');
  const g = setup({packet:attachment({friendId:202, from:{uid:202,source:0}})});
  assert.throws(() => g.read(), error => error.code === 'CONVERSATION_MISMATCH');
});

test('no to requires an explicit candidate source 0 and scope; source is never fabricated', () => {
  const f = setup({packet:attachment({from:{uid:101}})});
  assert.equal(f.read().rows.length, 0); assert.equal(f.read().unresolved_attachments, 1);
  const g = setup({packet:attachment({from:{uid:101}, to:{uid:999}})});
  const row = g.read().rows[0]; assert.equal(row.direction, 'incoming'); assert.equal('source' in row.raw.from, false);
  const h = setup({packet:null, state:[attachment()]});
  assert.equal(h.read().rows.length, 0, 'a global array sender match alone cannot bind a missing-to packet');
});

test('an explicitly invalid recipient cannot be erased and accepted as a missing-to attachment', () => {
  for (const to of [null, '999', {}, {uid:0.5}, {uid:'not a valid id'}]) {
    const f = setup({packet:attachment({to})});
    assert.throws(() => f.read(), error => error.code === 'INVALID_MESSAGE_PARTICIPANT');
  }
});

test('an explicit nonnumeric sender source cannot be erased into a legacy missing source', () => {
  const f = setup({packet:attachment({from:{uid:101,source:'boss'},to:{uid:999}})});
  assert.throws(() => f.read(), error => error.code === 'INVALID_MESSAGE_PARTICIPANT');
});

test('boss source 1 outgoing text is accepted only with a destination and DOM/scoped evidence', () => {
  const packet = {mid:60, from:{uid:999, source:1}, to:{uid:101}, body:{text:'附件简历请求已发送'}};
  const f = setup({markup:'<div class="message-item"><div class="item-myself"><div class="text">附件简历请求已发送</div></div></div>', packet});
  const result = f.read(); assert.equal(result.rows[0].direction, 'outgoing'); assert.equal(result.visible_attachment_count, 0);
  assert.equal(result.rows[0].raw.body.hyperLink, undefined);
  const g = setup({markup:'<div class="message-item"><div class="item-myself"><div class="text">text</div></div></div>', packet:{...packet,from:{uid:999,source:2}}});
  assert.throws(() => g.read(), error => error.code === 'MESSAGE_DIRECTION_CONFLICT');
});

test('visible preview card without a stable ID stays unresolved without inventing a filename-based ID', () => {
  const f = setup({packet:attachment({mid:undefined})});
  const result = f.read(); assert.equal(result.rows.length, 0); assert.equal(result.visible_count, 1);
  assert.equal(result.unresolved_count, 1); assert.equal(result.visible_attachment_count, 1); assert.equal(result.unresolved_attachments, 1);
  assert.match(result.warnings.join(' '), /未作为已收到附件/);
});

test('a nameless received packet uses only its own unique DOM title as display metadata', () => {
  const packet = attachment({body:{type:12,hyperLink:{hyperLinkType:9,url:attachment().body.hyperLink.url}}});
  const f = setup({packet}), result = f.read();
  assert.equal(result.rows[0].raw.mid, '55'); assert.equal(result.rows[0].raw.attachment_name, '候选人.pdf');
  assert.equal(result.unresolved_attachments, 0); assert.equal(result.rows[0].raw.body.hyperLink.url, packet.body.hyperLink.url);
});

test('multiple DOM titles leave a nameless attachment unresolved instead of guessing a filename', () => {
  const packet = attachment({body:{type:12,hyperLink:{hyperLinkType:9,url:attachment().body.hyperLink.url}}});
  const f = setup({packet});
  const extra = f.document.createElement('div'); extra.className = 'message-card-top-title'; extra.textContent = '另一份.pdf';
  f.item.querySelector('.resume-card').append(extra); f.decorate(extra);
  const result = f.read(); assert.equal(result.rows[0].raw.mid, '55');
  assert.equal(result.rows[0].raw.attachment_name, undefined); assert.equal(result.unresolved_attachments, 1);
});

test('request and system notice cards do not become received attachments', () => {
  const f = setup({markup:'<div class="message-item"><div class="item-system"><div class="message-card-top-title">简历请求已发送</div></div></div>',
    packet:{mid:70, from:{uid:0,source:2}, body:{type:7, dialog:{type:2,operated:false}}, text:'简历请求已发送'}});
  const result = f.read(); assert.equal(result.rows[0].direction, 'system'); assert.equal(result.visible_attachment_count, 0); assert.equal(result.unresolved_attachments, 0);
  const g = setup({markup:'<div class="message-item"><div class="item-friend"><i class="resume-icon"></i><div class="message-card-top-title">请求发送附件简历</div><div class="message-card-buttons"><span class="card-btn">同意</span></div></div></div>', packet:{mid:71,from:{uid:101,source:0},to:{uid:999},body:{type:7,dialog:{type:2,operated:false}}}});
  assert.equal(g.read().visible_attachment_count, 0); assert.equal(g.read().rows[0].raw.body.hyperLink, undefined);
});

test('a centered system presentation preserves a real boss actor and never turns a request into an attachment', () => {
  const f = setup({markup:'<div class="message-item"><div class="item-system"><div class="message-card-top-title">简历请求已发送</div></div></div>',
    packet:{mid:72,from:{uid:999,source:0},to:{uid:101,source:0},body:{type:7,dialog:{type:2,operated:false}},text:'简历请求已发送'}});
  const result = f.read(); assert.equal(result.rows[0].direction,'outgoing');
  assert.equal(result.rows[0].raw.from.uid,'999'); assert.equal(result.rows[0].raw.body.hyperLink,undefined);
  assert.equal(result.visible_attachment_count,0); assert.equal(result.unresolved_attachments,0);
});

test('a centered incoming attachment uses its real actors rather than CSS to establish identity', () => {
  const f = setup({markup:`<div class="message-item">${card.replace('item-friend','item-system')}</div>`,
    packet:attachment({to:{uid:999,source:1}})});
  const result = f.read(); assert.equal(result.rows[0].direction,'incoming');
  assert.equal(result.rows[0].raw.mid,'55'); assert.equal(result.rows[0].raw.from.uid,'101');
  assert.equal(result.rows[0].raw.body.hyperLink.hyperLinkType,9); assert.equal(result.visible_attachment_count,1);
  const g = setup({markup:'<div class="message-item"><div class="item-system">未知通知</div></div>',
    packet:{mid:73,from:{uid:999,source:0},text:'未知通知'}});
  assert.equal(g.read().rows.length,0,'centered CSS alone cannot identify an actor or create system provenance');
});

test('minimal raw packets omit arbitrary props, tokens, HTML and private sender fields', () => {
  const f = setup({packet:attachment({token:'SECRET', securityId:'SECRET', html:'<p>private</p>', from:{uid:101,source:0,password:'SECRET'}, attachment:{name:'简历.pdf',status:'received',privateToken:'SECRET'}})});
  const raw = plain(f.read().rows[0].raw);
  assert.equal(JSON.stringify(raw).includes('SECRET'), false);
  assert.deepEqual(Object.keys(raw).sort(), ['attachment','body','from','mid']);
});

test('same packet in DOM and state is merged and conflicting payloads are rejected', () => {
  const f = setup({state:[attachment()]});
  assert.equal(f.read().rows.length, 1);
  f.chat.__vue__.messages = [attachment({body:{type:12, hyperLink:{...attachment().body.hyperLink,url:'bosszp://bosszhipin.app/openwith?type=openFile&id=OTHER'}}})];
  assert.throws(() => f.read(), error => error.code === 'MESSAGE_CONFLICT');
});

test('state fallback binds to the exact outer DOM ID and checks its nested direction', () => {
  const f = setup({markup:`<div class="message-item" data-mid="55">${card}</div>`, packet:null, state:[attachment()]});
  assert.equal(f.read().rows[0].scope_bound, true); assert.equal(f.read().unresolved_count, 0); assert.equal(f.read().unresolved_attachments, 0);
  f.chat.__vue__.messages = [{mid:55,from:{uid:999,source:1},to:{uid:101},text:'outgoing'}];
  assert.throws(() => f.read(), error => error.code === 'MESSAGE_DIRECTION_CONFLICT');
});

test('multiple visible message lists and conflicting editor conversations fail clearly', () => {
  const f = setup(), duplicate = f.list.cloneNode(true); f.chat.append(duplicate); f.decorate(duplicate);
  assert.throws(() => f.read(), error => error.code === 'AMBIGUOUS_MESSAGE_LIST');
  const g = setup(); g.editor.__vue__.conversation$ = {friendId:202};
  assert.throws(() => g.read(), error => error.code === 'CONVERSATION_MISMATCH');
});

test('DOM ID with no original sender remains unresolved; explicit from attributes can identify ordinary text', () => {
  const f = setup({markup:'<div class="message-item" data-mid="80"><div class="item-friend"><span class="text">你好</span></div></div>',packet:null});
  assert.equal(f.read().rows.length, 0);
  f.item.setAttribute('data-from-id', '101');
  assert.equal(f.read().rows[0].raw.mid, '80'); assert.equal(f.read().rows[0].direction, 'incoming');
});

test('bounds reject excessive messages, data fields and long bodies without truncation', () => {
  const f = setup({packet:null}); f.chat.__vue__ = {messages:Array.from({length:501},(_,i) => ({mid:i+1,from:{uid:101,source:0},to:{uid:999},text:'x'}))};
  assert.throws(() => f.read(), error => error.code === 'MESSAGE_LIMIT');
  const g = setup({packet:null}); g.item.__vue__ = {$props:Object.fromEntries(Array.from({length:33},(_,i) => [`field${i}`,{}]))};
  assert.throws(() => g.read(), error => error.code === 'MESSAGE_LIMIT');
  const h = setup({packet:attachment({text:'x'.repeat(30001)})});
  assert.throws(() => h.read(), error => error.code === 'MESSAGE_LIMIT');
});

const historyResponse = packets => new Response(JSON.stringify({code:0,zpData:{messages:packets}}), {headers:{'content-type':'application/json'}});

test('explicit history fallback reads only the selected friend through the fixed same-origin endpoint', async () => {
  const calls = [], f = setup({packet:null, fetchImpl:async (url, options) => { calls.push({url,options}); return historyResponse([attachment()]); }});
  assert.equal(f.read().rows.length, 0); assert.equal(f.read().unresolved_attachments, 1); assert.equal(calls.length, 0);
  const result = await f.load();
  assert.equal(result.ok, true); assert.equal(result.history_count, 1); assert.equal(calls.length, 1);
  const request = new URL(calls[0].url);
  assert.equal(request.origin, 'https://www.zhipin.com'); assert.equal(request.pathname, '/wapi/zpchat/boss/historyMsg');
  assert.equal(request.searchParams.get('gid'), '101'); assert.equal(request.searchParams.get('c'), '100'); assert.equal(request.searchParams.get('src'), '0');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.credentials, 'include'); assert.equal(calls[0].options.redirect, 'error');
  const loaded = f.read(); assert.equal(loaded.history_loaded, true); assert.equal(loaded.rows[0].raw.mid, '55');
  assert.equal(loaded.rows[0].scope_bound, true); assert.equal(loaded.unresolved_attachments, 0);
  assert.equal('rows' in result, false, 'the explicit action returns metadata rather than raw packets');
});

test('serialized history wrapper returns only metadata and requires the correct installed revision', async () => {
  const f = setup({packet:null, fetchImpl:async () => historyResponse([attachment()])});
  const result = await vm.runInContext(`(${loadChatMessageHistory.toString()})({friend_id:'101'})`, f.context);
  assert.equal(result.history_count, 1); assert.equal(JSON.stringify(result).includes('RESUME'), false);
  f.source.revision = 'older';
  assert.equal((await vm.runInContext(`(${loadChatMessageHistory.toString()})({friend_id:'101'})`, f.context)).code, 'MESSAGE_SOURCE_NOT_READY');
});

test('same revision installation preserves a short-lived cache and repeated reads never refetch', async () => {
  let calls = 0;
  const f = setup({packet:null, fetchImpl:async () => { calls++; return historyResponse([attachment()]); }});
  await f.load();
  vm.runInContext(`(${installChatMessageSource.toString()})()`, f.context);
  assert.equal(f.window.__hrmChatMessageSource, f.source); assert.equal(f.source.revision, 'history-2');
  assert.equal(f.read().history_count, 1); assert.equal((await f.load()).history_count, 1); assert.equal(calls, 1);
});

test('concurrent identical explicit history actions share one request', async () => {
  let finish, calls = 0;
  const f = setup({packet:null, fetchImpl:async () => { calls++; return await new Promise(resolve => { finish = resolve; }); }});
  const first = f.load(), second = f.load();
  assert.equal(calls, 1); finish(historyResponse([attachment()]));
  assert.equal((await first).ok, true); assert.equal((await second).ok, true); assert.equal(calls, 1);
});

test('history cache expires after ten seconds without a request during synchronous read', async () => {
  let calls = 0; const clock = {now:1000};
  const f = setup({packet:null, clock, fetchImpl:async () => { calls++; return historyResponse([attachment()]); }});
  await f.load(); clock.now += 10001;
  assert.equal(f.read().history_loaded, false); assert.equal(f.read().rows.length, 0); assert.equal(calls, 1);
  assert.equal((await f.load()).ok, true); assert.equal(calls, 2);
});

test('switching away and back clears history even for identical candidate display names', async () => {
  const f = setup({packet:null, fetchImpl:async () => historyResponse([attachment()])}); await f.load();
  f.chat.setAttribute('data-friend-id', '202'); f.editor.__vue__.conversation$ = {friendId:202};
  assert.equal(f.read('202').history_loaded, false); assert.equal(f.read('202').rows.length, 0);
  f.chat.setAttribute('data-friend-id', '101'); f.editor.__vue__.conversation$ = {friendId:101};
  assert.equal(f.read().history_loaded, false); assert.equal(f.read().rows.length, 0);
});

test('replacing the message list or changing its DOM signature invalidates the cached source', async () => {
  const f = setup({packet:null, fetchImpl:async () => historyResponse([attachment()])}); await f.load();
  f.item.querySelector('.message-card-top-title').textContent = '另一份.pdf';
  assert.equal(f.read().history_loaded, false);
  const g = setup({packet:null, fetchImpl:async () => historyResponse([attachment()])}); await g.load();
  const replacement = g.list.cloneNode(true); g.list.replaceWith(replacement); g.decorate(replacement);
  assert.equal(g.read().history_loaded, false); assert.equal(g.read().rows.length, 0);
});

test('scope changes during the fetch discard the response and never populate the cache', async () => {
  const f = setup({packet:null});
  f.context.fetch = async () => { f.item.querySelector('.message-card-top-title').textContent = 'changed.pdf'; return historyResponse([attachment()]); };
  const result = await f.load(); assert.equal(result.ok, false); assert.equal(result.code, 'HISTORY_SCOPE_CHANGED');
  assert.equal(f.read().history_loaded, false); assert.equal(f.read().rows.length, 0);
});

test('another friend, invalid recipient and a missing sender source cannot borrow API request scope', async () => {
  for (const packet of [attachment({from:{uid:202,source:0}}), attachment({friendId:202}), attachment({to:null}), attachment({from:{uid:101}})]) {
    const f = setup({packet:null, fetchImpl:async () => historyResponse([packet])});
    assert.equal((await f.load()).ok, false); assert.equal(f.read().rows.length, 0); assert.equal(f.read().history_loaded, false);
  }
});

test('history accepts only its documented message containers and validates original IDs', async () => {
  for (const zpData of [[attachment()], {messageList:[attachment()]}]) {
    const f = setup({packet:null, fetchImpl:async () => new Response(JSON.stringify({code:0,zpData}))}); assert.equal((await f.load()).history_count, 1);
  }
  for (const payload of [{code:0,zpData:{unknown:[attachment()]}}, {code:0,zpData:{messages:[attachment({mid:undefined})]}}]) {
    const f = setup({packet:null, fetchImpl:async () => new Response(JSON.stringify(payload))}); assert.equal((await f.load()).ok, false);
  }
});

test('duplicate API IDs merge once and conflicting packets stop the import', async () => {
  const f = setup({packet:null, fetchImpl:async () => historyResponse([attachment(),attachment()])}); assert.equal((await f.load()).history_count, 1);
  const g = setup({packet:null, fetchImpl:async () => historyResponse([attachment(),attachment({text:'conflicting original'}) , attachment({text:'different original'})])});
  assert.equal((await g.load()).code, 'MESSAGE_CONFLICT'); assert.equal(g.read().history_loaded, false);
});

test('API and DOM packets with the same mid must still agree', async () => {
  const f = setup({fetchImpl:async () => historyResponse([attachment({body:{...attachment().body,hyperLink:{...attachment().body.hyperLink,url:'bosszp://bosszhipin.app/openwith?type=openFile&id=OTHER'}}})])});
  assert.equal((await f.load()).code, 'MESSAGE_CONFLICT'); assert.equal(f.read().history_loaded, false);
});

test('a centered DOM item cannot erase incoming provenance already established by the history request', async () => {
  const f = setup({packet:null,markup:`<div class="message-item" data-mid="55">${card.replace('item-friend','item-system')}</div>`,
    fetchImpl:async () => historyResponse([attachment()])});
  assert.equal((await f.load()).ok,true); assert.equal(f.read().rows[0].direction,'incoming');
  assert.equal(f.read().rows[0].raw.from.uid,'101'); assert.equal('to' in f.read().rows[0].raw,false);
});

test('API rows remain usable while multiple same filenames leave DOM attachment matching unresolved', async () => {
  const f = setup({packet:null, fetchImpl:async () => historyResponse([attachment(),attachment({mid:56})])});
  await f.load(); const result = f.read(); assert.equal(result.rows.length, 2); assert.equal(result.unresolved_attachments, 1);
  const g = setup({packet:null,markup:`<div class="message-item">${card}</div><div class="message-item">${card}</div>`,fetchImpl:async () => historyResponse([attachment()])});
  await g.load(); assert.equal(g.read().rows.length, 1); assert.equal(g.read().unresolved_attachments, 2);
});

test('a nameless verified API attachment is returned without guessing a DOM-only filename', async () => {
  const packet = attachment({body:{type:12,hyperLink:{hyperLinkType:9,url:attachment().body.hyperLink.url}}});
  const f = setup({packet:null, fetchImpl:async () => historyResponse([packet])}); await f.load();
  assert.equal(f.read().rows[0].raw.attachment_name, undefined); assert.equal(f.read().unresolved_attachments, 1);
  const g = setup({packet:null,markup:`<div class="message-item" data-mid="55">${card}</div>`,fetchImpl:async () => historyResponse([packet])}); await g.load();
  assert.equal(g.read().rows[0].raw.attachment_name, '候选人.pdf'); assert.equal(g.read().unresolved_attachments, 0);
});

test('history rejects account risk, expired credentials, HTTP errors and HTML without exposing payloads', async () => {
  for (const response of [new Response('',{status:401}),new Response('',{status:403}),new Response('',{status:429}),new Response('<html>SECRET</html>'),
    ...[9,32,35,36,37,999].map(code => new Response(JSON.stringify({code,message:'SECRET token https://example.test/'})))]) {
    const f = setup({packet:null,fetchImpl:async () => response}); const result = await f.load();
    assert.equal(result.ok,false); assert.equal(result.status,'blocked'); assert.equal(JSON.stringify(result).includes('SECRET'),false);
  }
});

test('history response is bounded to 2 MiB by both stream size and Content-Length', async () => {
  for (const response of [new Response(new Uint8Array(2*1024*1024+1)), new Response('{}',{headers:{'content-length':String(2*1024*1024+1)}})]) {
    const f = setup({packet:null,fetchImpl:async () => response}); assert.equal((await f.load()).code,'HISTORY_TOO_LARGE');
  }
});

test('history uses a 15 second abort timeout and reports only a safe error', async () => {
  const f = setup({packet:null}); let timeoutMs;
  f.context.setTimeout = (fn, delay) => { timeoutMs = delay; return setTimeout(fn, 1); };
  f.context.fetch = async (_url,options) => await new Promise((_resolve,reject) => options.signal.addEventListener('abort',() => reject(Error('SECRET network URL'))));
  const result = await f.load(); assert.equal(timeoutMs,15000); assert.equal(result.code,'HISTORY_READ_FAILED'); assert.equal(JSON.stringify(result).includes('SECRET'),false);
});
