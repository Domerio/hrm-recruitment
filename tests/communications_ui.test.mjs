import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React, { act } from 'react';
import { parseHTML } from 'linkedom';
import { ruleRejectedResult } from './fixtures/rule-rejected.mjs';

const { window } = parseHTML('<html><body></body></html>');
const prior = new Map();
const readers = [];
let activeRoots = 0;

class ControlledFileReader {
  readAsDataURL(file) { this.file = file; readers.push(this); }
  finish(value = 'data:application/pdf;base64,JVBERi0xLjQ=') {
    this.result = value;
    this.onload();
  }
}

function installDOM() {
  if (activeRoots++ > 0) return;
  for (const [key, value] of Object.entries({ window, document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true, FileReader: ControlledFileReader })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  prior.set('__communicationTestFile', Object.getOwnPropertyDescriptor(globalThis, '__communicationTestFile'));
}

function restoreDOM() {
  for (const [key, descriptor] of prior) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  prior.clear();
}
after(restoreDOM);
const { createRoot } = await import('react-dom/client');

// Use the real component, effects and async handlers with native test controls in place of portals.
const output = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/Communications.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'native-communication-controls', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
    builder.onResolve({ filter: /\.css$/ }, () => ({ path: 'empty-css', namespace: 'empty' }));
    builder.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '' }));
    builder.onResolve({ filter: /^(antd|@ant-design\/icons)$/ }, args => ({ path: args.path, namespace: 'controls' }));
    builder.onLoad({ filter: /.*/, namespace: 'controls' }, args => ({ loader: 'jsx', contents:
      args.path === '@ant-design/icons' ? `
        export const DownloadOutlined = () => null;
        export const PaperClipOutlined = DownloadOutlined, ReloadOutlined = DownloadOutlined, UploadOutlined = DownloadOutlined, FileTextOutlined = DownloadOutlined;
      ` : `
        import React from 'react';
        const Block = ({children,className}) => <div className={className}>{children}</div>;
        export const Card = ({title,children,className}) => <section className={className}><h3>{title}</h3>{children}</section>;
        export const Typography = {Paragraph:Block, Text:Block, Title:Block};
        export const Space = Block, Tag = Block;
        export const Spin = ({children,spinning}) => <div data-loading={spinning}>{children}</div>;
        export const Alert = ({title,action}) => <aside>{title}{action}</aside>;
        export const Button = ({children,onClick,disabled,href,download,target,rel,title,'data-boss-chat-link':bossChat}) => href
          ? <a href={href} download={download} target={target} rel={rel} title={title} data-boss-chat-link={bossChat}>{children}</a>
          : <button onClick={onClick} disabled={disabled} title={title} data-boss-chat-link={bossChat}>{children}</button>;
        export const Empty = ({description}) => <p>{description}</p>;
        Empty.PRESENTED_IMAGE_SIMPLE = '';
        export const Input = ({id,value,onChange,placeholder}) => <input id={id} value={value}
          placeholder={placeholder} onInput={onChange} />;
        export const Select = ({id,value,options,onChange}) => <select id={id} value={value ?? ''}
          onInput={event => onChange(event.target.value ? Number(event.target.value) : undefined)}>
          <option value="">全部岗位</option>{options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>;
        export const Collapse = ({items}) => <div>{items.map(item => <div key={item.key}>{item.label}{item.children}</div>)}</div>;
        export const Upload = ({children,beforeUpload,disabled}) => <div>{children}<button data-file-control
          disabled={disabled} onClick={() => beforeUpload(globalThis.__communicationTestFile)}>上传测试附件</button></div>;
      ` }));
  } }],
});
const module = { exports: {} };
vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports,
  require: createRequire(import.meta.url), console, FileReader: ControlledFileReader, globalThis });
const Component = module.exports.default;
const jobs = [{ id: 1, title: '采购工程师' }, { id: 2, title: '视觉工程师' }];
const candidates = [{ id: 101, job_id: 1, name: '同名候选人' },
  { id: 102, job_id: 1, name: '同名候选人' },
  { id: 201, job_id: 2, name: '其他岗位候选人' },
  { id: 103, job_id: 1, name: '已删除档案', deleted: true }];
const first = { id: 1, job_id: 1, account_id: 'synthetic-account-a', account_name: '招聘账号 A',
  friend_id: 'friend-a', candidate_name: '同名候选人', unread_count: null, message_count: 2,
  last_message: '第一段会话', updated: '2026-11-18T01:00:00Z' };
const second = { ...first, id: 2, account_id: 'synthetic-account-b', account_name: '招聘账号 B',
  friend_id: 'friend-b', last_message: '第二段会话', unread_count: 2 };
const incoming = { id: 11, message_id: 'platform-original-id', direction: 'incoming', kind: 'attachment',
  text: '请查收附件', sent_at: '2026-11-18T01:00:00Z', attachment_name: '原件.pdf', attachment_status: 'received' };
const resumeSource={id:81,conversation_id:1,source_kind:'online',name:'同名候选人',resume:'完整原文 <script>bad()</script>',
  evaluation_status:'not_requested',created:'2026-11-19T01:00:00Z',candidate_id:null,binding_warning:'等待确认档案关联'};
const response = body => ({ json: async () => body });
const detail = (conversation, messages = []) => response({ conversation, messages });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mount(api) {
  installDOM();
  readers.length = 0;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const notifications = [];
  await act(async () => root.render(React.createElement(Component, {
    state: { jobs, candidates }, api, notify: (...args) => notifications.push(args),
  })));
  return { element, notifications, unmount: async () => {
    await act(async () => root.unmount());
    element.remove();
    if (--activeRoots === 0) restoreDOM();
  } };
}

async function choose(view, index) {
  const button = view.element.querySelectorAll('.communication-choice')[index];
  assert.ok(button);
  await act(async () => button.click());
}
async function selectJob(view, id) {
  await selectValue(view, '#communication-job', id);
}
async function selectValue(view, selector, id) {
  await act(async () => {
    const select = view.element.querySelector(selector);
    for (const option of select.options) option.selected = false;
    [...select.options].find(option => option.value === String(id)).selected = true;
    select.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function upload(view, file) {
  globalThis.__communicationTestFile = file;
  const button = view.element.querySelector('[data-file-control]');
  assert.ok(button);
  await act(async () => button.click());
}

test('selected numeric friend opens the official BOSS chat in a new tab with its source account guidance', async () => {
  const conversation = {...first,friend_id:'9007199254740993',platform_geek_id:'encrypted-ignored'};
  const calls=[];
  const view=await mount(async(path,data)=>{
    calls.push({path,data});
    return path.endsWith('/list')?response({conversations:[conversation]}):detail(conversation);
  });
  try{
    const link=view.element.querySelector('[data-boss-chat-link]');
    assert.equal(link.tagName,'A');
    assert.equal(link.textContent,'在 BOSS 中聊天');
    assert.equal(link.getAttribute('href'),'https://www.zhipin.com/web/chat/index?uid=9007199254740993&source=0');
    assert.equal(link.getAttribute('target'),'_blank');
    assert.equal(link.getAttribute('rel'),'noopener noreferrer');
    assert.match(link.getAttribute('title'),/招聘账号 A/);
    assert.match(link.getAttribute('title'),/仅打开会话/);
    const before=calls.length;await act(async()=>link.click());
    assert.equal(calls.length,before,'opening the external link must not call any message API');
  }finally{await view.unmount();}
});

test('invalid or missing friend IDs disable chat without using a name or encrypted geek ID as fallback',async()=>{
  for(const friend_id of ['',undefined,'encrypted-id','101&source=1']){
    const conversation={...first,friend_id,candidate_name:'12345',platform_geek_id:'67890'};
    const view=await mount(async path=>path.endsWith('/list')?response({conversations:[conversation]}):detail(conversation));
    try{
      const control=view.element.querySelector('[data-boss-chat-link]');
      assert.equal(control.tagName,'BUTTON');assert.equal(control.disabled,true);
      assert.equal(control.getAttribute('href'),null);
      assert.match(view.element.textContent,/缺少有效的 BOSS 会话 ID/);
    }finally{await view.unmount();}
  }
});

test('switching same-name accounts removes the previous chat link while the new detail is pending',async()=>{
  const a={...first,friend_id:'101'},b={...second,friend_id:'202'},pending=deferred();
  const view=await mount(async(path,data)=>path.endsWith('/list')?response({conversations:[a,b]}):data.id===1?detail(a):pending.promise);
  try{
    assert.match(view.element.querySelector('[data-boss-chat-link]').getAttribute('href'),/uid=101&/);
    await choose(view,1);
    assert.equal(view.element.querySelector('[data-boss-chat-link]'),null);
    await act(async()=>pending.resolve(detail(b)));
    const link=view.element.querySelector('[data-boss-chat-link]');
    assert.match(link.getAttribute('href'),/uid=202&/);
    assert.match(link.getAttribute('title'),/招聘账号 B/);
  }finally{await view.unmount();}
});

test('late stale detail cannot replace the selected friend chat URL',async()=>{
  const a={...first,friend_id:'101'},b={...second,friend_id:'202'},older=deferred();
  const view=await mount(async(path,data)=>path.endsWith('/list')?response({conversations:[a,b]}):data.id===1?older.promise:detail(b));
  try{
    await choose(view,1);
    await act(async()=>older.resolve(detail(a)));
    const link=view.element.querySelector('[data-boss-chat-link]');
    assert.match(link.getAttribute('href'),/uid=202&/);
    assert.match(link.getAttribute('title'),/招聘账号 B/);
  }finally{await view.unmount();}
});

test('list/detail identity disagreement disables a link despite a matching local conversation id',async()=>{
  for(const changed of [{friend_id:'999'},{account_id:'different-account'}]){
    const conversation={...first,friend_id:'101'};
    const view=await mount(async path=>path.endsWith('/list')?response({conversations:[conversation]}):detail({...conversation,...changed}));
    try{
      const control=view.element.querySelector('[data-boss-chat-link]');
      assert.equal(control.tagName,'BUTTON');assert.equal(control.disabled,true);
      assert.equal(control.getAttribute('href'),null);
      assert.match(view.element.textContent,/会话信息已变化/);
    }finally{await view.unmount();}
  }
});

test('chat resume versions display original text, zero scores and unlinked status without rendering markup',async()=>{
  const conversation={...first,resumes:[resumeSource,{...resumeSource,id:82,source_kind:'attachment',attachment_id:55,
    evaluation_status:'complete',evaluation:{score:0,summary:'原文中的结论 <img onerror=bad()>',checks:[]}}]};
  const view=await mount(async path=>path.endsWith('/list')?response({conversations:[conversation]}):detail(conversation));
  try{
    assert.match(view.element.textContent,/已归档聊天简历.*2/);
    assert.match(view.element.textContent,/完整原文 <script>bad\(\)<\/script>/);
    assert.equal(view.element.querySelector('script'),null);assert.equal(view.element.querySelector('img'),null);
    assert.match(view.element.textContent,/等待确认档案关联/);assert.match(view.element.textContent,/0 分/);
    assert.equal(view.element.querySelector('a[href="/api/communications/attachments/55"]').getAttribute('download'),'');
    assert.equal([...view.element.querySelectorAll('button')].filter(button=>button.textContent==='评估这份原文').length,1);
  }finally{await view.unmount();}
});

test('archived rules-only chat results show original hard-rule evidence without AI score or pending state',async()=>{
  const conversation={...first,resumes:[{...resumeSource,evaluation_status:'complete',evaluation:ruleRejectedResult()}]};
  const view=await mount(async path=>path.endsWith('/list')?response({conversations:[conversation]}):detail(conversation));
  try{
    const result=view.element.querySelector('.chat-resume-sources');
    for(const text of ['规则预筛不达标 · 未调用模型','未通过的硬条件与原文依据','本科及以上','最高学历：大专'])
      assert.ok(result.textContent.includes(text),text);
    assert.equal(result.querySelector('.chat-resume-score'),null);
    assert.doesNotMatch(result.textContent,/AI 匹配|AI 待评估|null 分|0 分/);
    assert.equal([...result.querySelectorAll('button')].filter(button=>button.textContent==='评估这份原文').length,0);
  }finally{await view.unmount();}
});

test('retrying a saved chat source stays bound to its conversation and ignores late responses after selection changes',async()=>{
  const pending=deferred(),requests=[];
  const view=await mount(async(path,data)=>{
    if(path.endsWith('/list'))return response({conversations:[first,second]});
    if(path.endsWith('/resume')){requests.push(data);return pending.promise;}
    return data.id===1?detail({...first,resumes:[resumeSource]}):detail(second,[{id:31,direction:'incoming',text:'第二个会话内容'}]);
  });
  try{
    const retry=[...view.element.querySelectorAll('button')].find(button=>button.textContent==='评估这份原文');
    assert.ok(retry);await act(async()=>retry.click());
    assert.deepEqual(JSON.parse(JSON.stringify(requests)),[{conversation_id:1,resume_id:81,evaluate:true}]);
    await choose(view,1);
    await act(async()=>pending.resolve(response({resume:{...resumeSource,evaluation_status:'complete',evaluation:{score:99}}})));
    assert.match(view.element.textContent,/第二个会话内容/);assert.doesNotMatch(view.element.textContent,/99 分/);
    assert.deepEqual(view.notifications,[]);
  }finally{await view.unmount();}
});

test('switching same-name conversations rejects an older detail response', async () => {
  const older = deferred();
  const view = await mount(async (path, data) => path.endsWith('/list')
    ? response({ conversations: [first, second] }) : data.id === 1 ? older.promise
      : detail(second, [{ id: 20, direction: 'incoming', text: '第二位当前消息' }]));
  try {
    await choose(view, 1);
    await act(async () => older.resolve(detail(first, [{ id: 10, direction: 'incoming', text: '第一位过期响应' }])));
    assert.match(view.element.textContent, /第二位当前消息/);
    assert.match(view.element.querySelector('.communication-detail-heading').textContent, /friend-b/);
    assert.doesNotMatch(view.element.textContent, /第一位过期响应/);
  } finally { await view.unmount(); }
});

test('a slower previous job list cannot replace the selected job results', async () => {
  const older = deferred();
  const current = { ...second, job_id: 2 };
  const view = await mount(async (path, data) => {
    if (path.endsWith('/list')) return data.job_id === 2 ? response({ conversations: [current] }) : older.promise;
    return detail(current);
  });
  try {
    await selectJob(view, 2);
    await act(async () => older.resolve(response({ conversations: [first] })));
    const choices = view.element.querySelectorAll('.communication-choice');
    assert.equal(choices.length, 1);
    assert.match(choices[0].textContent, /视觉工程师/);
    assert.match(choices[0].textContent, /招聘账号 B/);
    assert.doesNotMatch(choices[0].textContent, /招聘账号 A/);
  } finally { await view.unmount(); }
});

test('attachment reading cannot submit into a newly selected conversation', async () => {
  const imports = [];
  const view = await mount(async (path, data) => {
    if (path.endsWith('/list')) return response({ conversations: [first, second] });
    if (path.endsWith('/detail')) return detail(data.id === 1 ? first : second, data.id === 1 ? [incoming] : []);
    imports.push(data);
    return response({ attachment: { id: 30 } });
  });
  try {
    await upload(view, { name: '原件.pdf', size: 32 });
    assert.equal(readers.length, 1);
    await choose(view, 1);
    await act(async () => readers[0].finish());
    assert.equal(imports.length, 0);
    assert.ok(view.notifications.some(([text, error]) => error && text.includes('会话已切换')));
  } finally { await view.unmount(); }
});

test('received attachment import uses the local message id and reloads the original conversation', async () => {
  const calls = [];
  let saved = false;
  const view = await mount(async (path, data) => {
    calls.push({ path, data });
    if (path.endsWith('/list')) return response({ conversations: [first] });
    if (path.endsWith('/detail')) return detail(first, [{ ...incoming,
      attachment: saved ? { id: 30, name: '原件.pdf', size: 32, text: '安全的附件原文' } : null }]);
    saved = true;
    return response({ attachment: { id: 30 } });
  });
  try {
    await upload(view, { name: '原件.pdf', size: 32 });
    await act(async () => readers[0].finish());
    const sent = calls.find(item => item.path.endsWith('/attachment'));
    assert.deepEqual(JSON.parse(JSON.stringify(sent.data)), {
      conversation_id: 1, message_id: 11, name: '原件.pdf', content: 'JVBERi0xLjQ=',
    });
    assert.equal(calls.filter(item => item.path.endsWith('/detail')).length, 2);
    assert.equal(view.element.querySelector('a[download]').getAttribute('href'), '/api/communications/attachments/30');
    assert.match(view.element.textContent, /安全的附件原文/);
  } finally { await view.unmount(); }
});

test('pending and outgoing attachments never offer import and text remains escaped', async () => {
  const view = await mount(async path => path.endsWith('/list') ? response({ conversations: [first] })
    : detail(first, [incoming, { ...incoming, id: 12, attachment_status: 'pending' },
      { ...incoming, id: 13, direction: 'outgoing' },
      { id: 14, direction: 'incoming', text: '<img src=x onerror="alert(1)">' }]));
  try {
    assert.equal(view.element.querySelectorAll('[data-file-control]').length, 1);
    assert.match(view.element.textContent, /同步时未读 未知/);
    assert.match(view.element.textContent, /接收状态待确认/);
    assert.equal(view.element.querySelectorAll('.communication-message img').length, 0);
    assert.match(view.element.textContent, /<img src=x onerror="alert\(1\)">/);
  } finally { await view.unmount(); }
});

test('invalid or oversized files are rejected before reading or posting', async () => {
  const calls = [];
  const view = await mount(async (path, data) => {
    calls.push(path);
    return path.endsWith('/list') ? response({ conversations: [first] }) : detail(first, [incoming]);
  });
  try {
    for (const file of [{ name: 'resume.exe', size: 32 }, { name: 'empty.pdf', size: 0 },
      { name: 'large.pdf', size: 5 * 1024 * 1024 + 1 }]) await upload(view, file);
    assert.equal(readers.length, 0);
    assert.equal(calls.some(path => path.endsWith('/attachment')), false);
    assert.equal(view.notifications.filter(([, error]) => error).length, 3);
  } finally { await view.unmount(); }
});

test('unmounting during file reading prevents a later attachment upload', async () => {
  const posted = [];
  const view = await mount(async (path, data) => {
    if (path.endsWith('/list')) return response({ conversations: [first] });
    if (path.endsWith('/detail')) return detail(first, [incoming]);
    posted.push(data);
    return response({ attachment: { id: 30 } });
  });
  await upload(view, { name: '原件.pdf', size: 32 });
  await view.unmount();
  await act(async () => readers[0].finish());
  assert.equal(posted.length, 0);
  assert.equal(view.notifications.length, 0);
});

test('manual candidate binding is scoped to active job and requires explicit archive selection', async () => {
  const calls = [];
  let candidateId = null;
  const view = await mount(async (path, data) => {
    calls.push({ path, data });
    if (path.endsWith('/list')) return response({ conversations: [first] });
    if (path.endsWith('/detail')) return detail({ ...first, candidate_id: candidateId });
    if (path.endsWith('/bind')) {
      candidateId = data.candidate_id;
      return response({ conversation: { ...first, candidate_id: candidateId }, messages: [] });
    }
    throw new Error('unexpected endpoint');
  });
  try {
    const select = view.element.querySelector('#communication-candidate');
    assert.ok(select);
    assert.deepEqual([...select.options].map(option => option.value), ['', '101', '102']);
    const button = [...view.element.querySelectorAll('button')].find(item => item.textContent === '确认关联');
    assert.equal(button.disabled, true);
    assert.equal(calls.some(item => item.path.endsWith('/bind')), false);
    await selectValue(view, '#communication-candidate', 102);
    await act(async () => button.click());
    const bound = calls.find(item => item.path.endsWith('/bind'));
    assert.deepEqual(JSON.parse(JSON.stringify(bound.data)), { conversation_id: 1, candidate_id: 102 });
    assert.match(view.element.querySelector('.communication-candidate-binding').textContent, /已关联候选人档案同名候选人 · 档案 #102/);
    assert.equal(view.element.querySelector('#communication-candidate'), null);
  } finally { await view.unmount(); }
});

test('late candidate binding confirmation cannot overwrite another selected conversation', async () => {
  const pending = deferred();
  const calls = [];
  const view = await mount(async (path, data) => {
    calls.push({ path, data });
    if (path.endsWith('/list')) return response({ conversations: [first, second] });
    if (path.endsWith('/detail')) return detail(data.id === 1 ? first : second);
    if (path.endsWith('/bind')) return pending.promise;
    throw new Error('unexpected endpoint');
  });
  try {
    await selectValue(view, '#communication-candidate', 101);
    const button = [...view.element.querySelectorAll('button')].find(item => item.textContent === '确认关联');
    await act(async () => { button.click(); button.click(); });
    assert.equal(calls.filter(item => item.path.endsWith('/bind')).length, 1);
    await choose(view, 1);
    await act(async () => pending.resolve(response({ conversation: { ...first, candidate_id: 101 }, messages: [] })));
    assert.match(view.element.querySelector('.communication-detail-heading').textContent, /friend-b/);
    assert.doesNotMatch(view.element.querySelector('.communication-candidate-binding').textContent, /已关联候选人档案/);
    assert.equal(calls.filter(item => item.path.endsWith('/detail') && item.data.id === 1).length, 1);
  } finally { await view.unmount(); }
});
