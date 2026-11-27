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
let activeRoots = 0;
function installDOM() {
  if (activeRoots++ > 0) return;
  for (const [key, value] of Object.entries({ window, document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
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

// Exercise the real component and React async lifecycle without Ant Design's portal/layout machinery.
const output = await build({
  entryPoints: [fileURLToPath(new URL('../frontend/DirectResumeEvaluation.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'native-test-controls', setup(build) {
    build.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: args.path, external: true }));
    build.onResolve({ filter: /^(antd|\.\/CandidateDetail)$/ }, args => ({ path: args.path, namespace: 'controls' }));
    build.onLoad({ filter: /.*/, namespace: 'controls' }, args => ({ loader: 'jsx', contents: args.path === 'antd' ? `
      import React from 'react';
      export const Flex = ({children}) => <div>{children}</div>;
      export const Row = Flex, Col = Flex;
      export const Typography = {Paragraph: Flex, Text: Flex};
      export const Alert = ({title,description}) => <aside>{title}{description}</aside>;
      export const Button = ({children,onClick,disabled}) => <button onClick={onClick} disabled={disabled}>{children}</button>;
      export const Select = ({id,value,options,onChange,disabled}) => <select id={id} value={value ?? ''}
        disabled={disabled} onInput={event => onChange(Number(event.target.value))}>
        <option value="">选择岗位</option>{options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>;
      const InputBase = ({id,value,onChange,disabled}) =>
        <input id={id} value={value} disabled={disabled} onInput={onChange} />;
      InputBase.TextArea = ({id,value,onChange,disabled}) =>
        <textarea id={id} value={value} disabled={disabled} onInput={onChange} />;
      export const Input = InputBase;
      export const Upload = {LIST_IGNORE:'ignore', Dragger: ({children,beforeUpload,disabled}) => <div>
        {children}<button disabled={disabled} onClick={() => beforeUpload({name:'resume.pdf',size:128,
          arrayBuffer:async () => new Uint8Array([37,80,68,70]).buffer})}>上传测试文件</button>
      </div>};
      export const Modal = ({children,title,onCancel}) => <section><h1>{title}</h1><button onClick={onCancel}>关闭面板</button>{children}</section>;
      export const Statistic = ({value,suffix}) => <strong>{value}{suffix}</strong>;
    ` : `
      import React from 'react';
      export const EvaluationSummary = ({result}) => <article>{result.summary}</article>;
      export const EvaluationTag = ({category}) => <span>{category}</span>;
    ` }));
  } }],
});
const module = { exports: {} };
vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports,
  require: createRequire(import.meta.url), btoa:value => Buffer.from(value,'binary').toString('base64'), Buffer });
const Component = module.exports.default;
const jobs = [{id:1,title:'设备开发',revision:1}, {id:2,title:'视觉算法',revision:1}];
const resume = '合成人员\n工作经历 合成设备公司 软件工程师 2020.01 - 至今\n负责 Python 设备接口开发、数据处理和程序验证。';
const result = (summary, jobId = 1) => ({ result:{score:80,category:'推荐',summary},
  job:jobs.find(job => job.id === jobId), model:'synthetic-model',saved:true,
  candidate:{id:9,name:'合成人员',added:true},source_marker:'direct_evaluation' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };

async function mount(api, overrides = {}) {
  installDOM();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  const busy = [];
  const props = {jobs,defaultJobId:1,configured:true,api,refresh:async()=>{},
    onBusyChange:value => busy.push(value),onClose:() => {},...overrides};
  const render = async extra => { Object.assign(props,extra); await act(async () => root.render(React.createElement(Component,props))); };
  await render({});
  return {element,busy,render,unmount:async () => {
    await act(async () => root.unmount()); element.remove();
    if (--activeRoots === 0) restoreDOM();
  }};
}
async function enter(element, selector, value) {
  await act(async () => {
    const target = element.querySelector(selector);
    if (target.tagName === 'SELECT') {
      for (const option of target.options) option.selected = option.value === String(value);
    } else target.value = value;
    target.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
}
async function click(element, label) {
  const button = [...element.querySelectorAll('button')].find(item => item.textContent === label);
  assert.ok(button,`Missing ${label}`);
  await act(async () => button.click());
}

test('failure preserves pasted source and retries the saved direct-evaluation endpoint', async () => {
  const calls = [];
  const view = await mount(async (path,data) => {
    calls.push({path,data});
    if (calls.length === 1) throw new Error('证据行号校验失败');
    return {json:async () => result('重试成功')};
  });
  try {
    assert.match(view.element.textContent,/发送给当前配置的 AI 模型/);
    assert.match(view.element.textContent,/写入候选人名单与评估历史/);
    await enter(view.element,'textarea',resume);
    await click(view.element,'开始评估');
    assert.match(view.element.textContent,/证据行号校验失败/);
    assert.equal(view.element.querySelector('textarea').value,resume);
    await click(view.element,'重试评估');
    assert.match(view.element.textContent,/重试成功/);
    assert.deepEqual(calls.map(item => item.path),['/api/ai/direct-resume','/api/ai/direct-resume']);
    assert.equal(calls[0].data.resume,resume);
    assert.equal(calls[0].data.name,'合成人员');
  } finally { await view.unmount(); }
});

test('uploaded document is extracted into editable text before evaluation', async () => {
  const calls = [];
  const view = await mount(async (path,data) => {
    calls.push({path,data});
    if (path === '/api/resume/extract') return {json:async () => ({text:resume})};
    return {json:async () => result('文件评估成功')};
  });
  try {
    assert.match(view.element.textContent,/上传图片或文档/);
    await click(view.element,'上传测试文件');
    await act(async () => await Promise.resolve());
    assert.equal(view.element.querySelector('textarea').value,resume);
    assert.match(view.element.textContent,/已读取 resume.pdf/);
    await click(view.element,'开始评估');
    assert.deepEqual(calls.map(item => item.path),['/api/resume/extract','/api/ai/direct-resume']);
    assert.equal(calls[1].data.resume,resume);
    assert.match(view.element.textContent,/已写入候选名单/);
    assert.match(view.element.textContent,/文件评估成功/);
  } finally { await view.unmount(); }
});

test('saved rules-only direct response omits score and configured model attribution',async()=>{
  const view=await mount(async()=>({json:async()=>({...result('placeholder'),result:ruleRejectedResult()})}));
  try{
    await enter(view.element,'textarea',resume);await click(view.element,'开始评估');
    assert.match(view.element.textContent,/已写入候选名单/);
    assert.match(view.element.textContent,/规则预筛未通过/);
    assert.doesNotMatch(view.element.textContent,/synthetic-model|null分|0分/);
    assert.equal(view.element.querySelector('strong'),null,'No numeric Statistic is rendered for rules-only completion');
  }finally{await view.unmount();}
});

test('switching job clears previous score and the next evaluation uses the selected job', async () => {
  const calls = [];
  const view = await mount(async (path,data) => {calls.push(data); return {json:async () => result('结果'+data.job_id,data.job_id)};});
  try {
    await enter(view.element,'textarea',resume);
    await click(view.element,'开始评估');
    assert.match(view.element.textContent,/结果1/);
    await enter(view.element,'select',2);
    assert.doesNotMatch(view.element.textContent,/结果1/);
    await click(view.element,'开始评估');
    assert.match(view.element.textContent,/结果2/);
    assert.equal(calls[1].job_id,2);
  } finally { await view.unmount(); }
});

test('closing and reopening cannot let an earlier response overwrite the new session', async () => {
  const old = deferred();
  const view = await mount(() => old.promise);
  await enter(view.element,'textarea',resume);
  await click(view.element,'开始评估');
  await view.unmount();
  const next = await mount(async () => ({json:async () => result('本次结果')}));
  try {
    await enter(next.element,'textarea',resume);
    await click(next.element,'开始评估');
    await act(async () => old.resolve({json:async () => result('过期结果')}));
    assert.match(next.element.textContent,/本次结果/);
    assert.doesNotMatch(next.element.textContent,/过期结果/);
  } finally { await next.unmount(); }
});

test('job refresh during evaluation invalidates its in-flight response and keeps source for retry', async () => {
  const old = deferred();
  const view = await mount(() => old.promise);
  try {
    await enter(view.element,'textarea',resume);
    await click(view.element,'开始评估');
    await view.render({jobs:[{...jobs[0],revision:2},jobs[1]]});
    await act(async () => old.resolve({json:async () => result('旧岗位结果')}));
    assert.doesNotMatch(view.element.textContent,/旧岗位结果/);
    assert.equal(view.element.querySelector('textarea').value,resume);
    assert.equal(view.busy.at(-1),false);
  } finally { await view.unmount(); }
});
