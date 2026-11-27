import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import React, {act} from 'react';
import {parseHTML} from 'linkedom';
import {ruleRejectedResult} from './fixtures/rule-rejected.mjs';

const {window}=parseHTML('<html><body></body></html>');
const saved=new Map();
function installDOM(){
  for(const [key,value] of Object.entries({window,document:window.document,IS_REACT_ACT_ENVIRONMENT:true})){
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
}
function restoreDOM(){for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}saved.clear();}
after(restoreDOM);
const {createRoot}=await import('react-dom/client');
const result=await build({entryPoints:[fileURLToPath(new URL('../frontend/Candidates.jsx',import.meta.url))],
  bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic',
  plugins:[{name:'native-candidate-controls',setup(builder){
    builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:args.path,external:true}));
    builder.onResolve({filter:/^\.\/(CandidateDetail|CandidateEditor|DirectResumeEvaluation|CandidateColumnFilter|ResizableHeaderCell)$/},args=>({path:args.path,namespace:'stub'}));
    builder.onLoad({filter:/.*/,namespace:'stub'},args=>({loader:'jsx',contents:`import React from 'react';
      export default ${args.path==='./CandidateDetail'?`({candidate,evaluation}) => <div data-detail-id={candidate.id} data-feedback-error={Boolean(evaluation?.error)} data-task-state={evaluation?.taskState}>{evaluation?.text}</div>`:'() => null'};
      export const EvaluationTag=()=>null, ProfileValue=()=>null, ReviewTag=()=>null;
      export const reviewOptions=[];`}));
    builder.onResolve({filter:/^(antd|@ant-design\/icons)$/},args=>({path:args.path,namespace:'controls'}));
    builder.onLoad({filter:/.*/,namespace:'controls'},args=>({loader:'jsx',contents:args.path==='@ant-design/icons'?`
      export const DownOutlined=()=>null, FilterFilled=()=>null, MoreOutlined=()=>null, ThunderboltOutlined=()=>null;`:`
      import React from 'react';
      const Block=({children,className,role})=><div className={className} role={role}>{children}</div>;
      export const Flex=Block, Row=Block, Col=Block;
      export const Typography={Text:Block,Paragraph:Block};
      export const App={useApp:()=>({modal:{confirm(){throw Error('Unexpected confirmation')}}})};
      export const Card=({children,title,extra})=><section><h3>{title}</h3>{extra}{children}</section>;
      export const Button=({children,onClick,disabled,'aria-label':label})=><button onClick={onClick} disabled={disabled} aria-label={label}>{children}</button>;
      export const Alert=({title})=><aside>{title}</aside>,Tag=Block;
      export const Checkbox=({children})=><label>{children}</label>;
      export const Collapse=({items})=><div>{items.map(item=><div key={item.key}>{item.label}{item.children}</div>)}</div>;
      export const Dropdown=({children,menu})=><div>{children}{menu.items.filter(item=>item.onClick).map((item,i)=><button key={i} disabled={item.disabled} onClick={item.onClick}>{item.label}</button>)}</div>;
      export const Empty=({children,description})=><div>{description}{children}</div>;Empty.PRESENTED_IMAGE_SIMPLE='';
      export const Modal=({children,title,open,onOk,onCancel,okText,okButtonProps})=>open?<div role="dialog"><h3>{title}</h3>{children}<button onClick={onOk} disabled={okButtonProps?.disabled}>{okText}</button><button onClick={onCancel}>取消</button></div>:null;
      export const Progress=({percent})=><progress max="100" value={percent}/>;
      export const Radio=Block;Radio.Group=Block;
      export const Select=({options=[]})=><select>{options.map(option=><option key={option.value}>{option.label}</option>)}</select>;
      export const Statistic=({title,value})=><div>{title}{value}</div>;
      export const Table=({dataSource,columns})=><div>{dataSource.map(row=><div key={row.id} data-row-id={row.id}>{columns.map(column=><div key={column.key}>{column.render?.(undefined,row)}</div>)}</div>)}</div>;
    `}));
  }}]});
const module={exports:{}};
vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url),window,document:window.document,setTimeout,clearTimeout,console});
const Component=module.exports.default;
const task=(id,state,extra={})=>({json:async()=>({task:{id:`task-${id}`,state,subscription_id:`sub-${id}`,position:id,...extra}})});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const candidatesFixture=()=>[1,2].map(id=>({id,name:`候选人${id}`,job_id:1,history:[],review:'未复核'}));
async function mount(api,{candidates=candidatesFixture(),configured=true,onRefresh}={}){
  installDOM();
  const element=document.createElement('div');document.body.append(element);const root=createRoot(element);
  const notifications=[];let refreshes=0;
  const props={state:{configured,jobs:[{id:1,title:'工程师'}],candidates},api,
    refresh:async()=>{refreshes++;const next=await onRefresh?.(refreshes);if(next){props.state={...props.state,candidates:next};root.render(React.createElement(Component,props));}},
    notify:(...args)=>notifications.push(args)};
  await act(async()=>root.render(React.createElement(Component,props)));
  return{element,notifications,refreshes:()=>refreshes,
    updateCandidates:async next=>{props.state={...props.state,candidates:next};await act(async()=>root.render(React.createElement(Component,props)));},
    unmount:async()=>{await act(async()=>root.unmount());element.remove();restoreDOM();}};
}
async function start(view){
  await act(async()=>view.element.querySelector('button[aria-label="批量评估"]').click());
  const button=[...view.element.querySelectorAll('[role="dialog"] button')].find(node=>node.textContent.startsWith('开始评估'));
  assert.ok(button);await act(async()=>button.click());
}

test('real Candidates submits all candidates, shows backend queue states, and preserves per-person failures',async()=>{
  const waits=new Map([[1,deferred()],[2,deferred()]]),submits=[];
  const view=await mount(async(path,data)=>{
    if(path==='/api/ai/tasks'){submits.push(data.data.id);return task(data.data.id,data.data.id===1?'queued':'running');}
    assert.equal(data,undefined);return waits.get(Number(path.split('-').at(-1))).promise;
  });
  try{
    await start(view);assert.deepEqual(submits.toSorted((a,b)=>a-b),[1,2]);
    assert.match(view.element.textContent,/排队中 1 人.*正在评估 1 人/);
    assert.match(view.element.textContent,/候选人1 · 排队中 · 第 1 位/);
    assert.match(view.element.textContent,/关闭或刷新页面不影响已提交任务/);
    await act(async()=>{waits.get(1).resolve(task(1,'succeeded',{status:200,result:{cached:true}}));waits.get(2).resolve(task(2,'failed',{status:502,result:{error:'模型暂不可用'}}));});
    assert.match(view.element.textContent,/成功 1 人（复用 1 人）.*失败 1 人/);
    assert.match(view.element.textContent,/候选人2.*模型暂不可用/);
    assert.equal(view.refreshes(),1);assert.equal(view.notifications.length,1);
  }finally{await view.unmount();}
});

test('unmounting real Candidates does not cancel or discard jobs already accepted by the backend',async()=>{
  const waits=[deferred(),deferred()],calls=[];
  const view=await mount(async(path,data)=>{
    calls.push({path,data});
    if(path==='/api/ai/tasks')return task(data.data.id,'queued');
    return waits[Number(path.split('-').at(-1))-1].promise;
  });
  await start(view);await view.unmount();
  await act(async()=>{waits[0].resolve(task(1,'succeeded',{status:200,result:{}}));waits[1].resolve(task(2,'succeeded',{status:200,result:{}}));});
  assert.ok(calls.every(call=>!call.path.endsWith('/cancel')));
  assert.equal(view.notifications.length,0);assert.equal(view.refreshes(),0);
});

test('single candidate evaluation also submits a task and waits for the stored result',async()=>{
  const pending=deferred(),calls=[];
  const view=await mount(async(path,data)=>{calls.push({path,data});return path==='/api/ai/tasks'?task(data.data.id,'queued'):pending.promise;});
  try{
    const row=view.element.querySelector('[data-row-id="1"]');
    await act(async()=>[...row.querySelectorAll('button')].find(node=>node.textContent==='AI 评估').click());
    assert.equal(calls[0].path,'/api/ai/tasks');assert.deepEqual(JSON.parse(JSON.stringify(calls[0].data)),{action:'evaluate',data:{id:1}});
    assert.match(row.textContent,/排队中/);
    await act(async()=>pending.resolve(task(1,'succeeded',{status:200,result:{cached:false}})));
    assert.equal(view.refreshes(),1);assert.match(view.notifications[0][0],/评估已保存/);
  }finally{await view.unmount();}
});

test('saved evaluation failures appear in the AI column with the complete reason available as a tooltip',async()=>{
  const reason='模型服务暂不可用\n'+('详细原因与建议。'.repeat(45));
  const candidates=candidatesFixture();
  candidates[0]={...candidates[0],ai_pending:true,evaluation_failure:{message:reason,code:'model_failed'},screening_failure:{message:'过时采集错误'}};
  candidates[1]={...candidates[1],ai_pending:true,evaluation_failure:null,screening_failure:{message:'已清除旧错误'}};
  const view=await mount(async()=>{throw Error('No evaluation was requested');},{candidates});
  try{
    const first=view.element.querySelector('[data-row-id="1"]'),second=view.element.querySelector('[data-row-id="2"]');
    assert.match(first.textContent,/评估失败/);assert.ok(first.textContent.includes(reason));
    assert.equal(first.querySelector('.candidate-ai-failure-reason').getAttribute('title'),reason);
    assert.doesNotMatch(first.textContent,/过时采集错误/);
    assert.match(second.textContent,/待重试/);assert.doesNotMatch(second.textContent,/已清除旧错误|评估失败/);
  }finally{await view.unmount();}
});

test('legacy pending failures are visible while pending records without a reason retain the retry state',async()=>{
  const candidates=candidatesFixture();
  candidates[0]={...candidates[0],ai_pending:true,screening_failure:{message:'采集模型返回格式不正确'}};
  candidates[1]={...candidates[1],ai_pending:true};
  const view=await mount(async()=>{}, {candidates});
  try{
    assert.match(view.element.querySelector('[data-row-id="1"]').textContent,/评估失败.*采集模型返回格式不正确/);
    assert.match(view.element.querySelector('[data-row-id="2"]').textContent,/待重试/);
    assert.equal(view.element.querySelectorAll('.candidate-ai-failure-reason').length,1);
  }finally{await view.unmount();}
});

test('a completed failure is explained inside its row while other batch tasks are still running',async()=>{
  const waiting=deferred();
  const view=await mount(async(path,data)=>{
    if(path==='/api/ai/tasks')return data.data.id===1?task(1,'failed',{status:502,result:{error:'该候选人的模型请求超时'}}):task(2,'running');
    return waiting.promise;
  });
  try{
    await start(view);
    const failed=view.element.querySelector('[data-row-id="1"]'),running=view.element.querySelector('[data-row-id="2"]');
    assert.match(failed.textContent,/评估失败.*该候选人的模型请求超时/);
    assert.equal(failed.querySelector('.candidate-ai-failure-reason').title,'该候选人的模型请求超时');
    assert.match(running.textContent,/正在评估/);
    await act(async()=>[...failed.querySelectorAll('button')].find(node=>node.textContent==='查看详情').click());
    const detail=view.element.querySelector('[data-detail-id="1"]');
    assert.equal(detail.textContent,'该候选人的模型请求超时');assert.equal(detail.getAttribute('data-feedback-error'),'true');
    await act(async()=>waiting.resolve(task(2,'succeeded',{status:200,result:{}})));
    assert.match(failed.textContent,/该候选人的模型请求超时/);
  }finally{await view.unmount();}
});

test('single-run failure is shown without a saved diagnostic and disappears after a successful retry',async()=>{
  let submissions=0;
  const successful=candidatesFixture();successful[0]={...successful[0],ai_pending:false,evaluation_failure:null,
    history:[{id:10,result:{score:86,category:'推荐'}}]};
  const view=await mount(async(path,data)=>{
    assert.equal(path,'/api/ai/tasks');submissions++;
    return submissions===1?task(data.data.id,'failed',{status:502,result:{error:'本次评估连接中断'}})
      :task(data.data.id,'succeeded',{status:200,result:{cached:false}});
  },{onRefresh:count=>count===2?successful:null});
  try{
    const row=()=>view.element.querySelector('[data-row-id="1"]');
    await act(async()=>[...row().querySelectorAll('button')].find(node=>node.textContent==='AI 评估').click());
    assert.match(row().textContent,/评估失败.*本次评估连接中断/);
    await act(async()=>[...row().querySelectorAll('button')].find(node=>node.textContent==='AI 评估').click());
    assert.match(row().textContent,/86分/);assert.doesNotMatch(row().textContent,/本次评估连接中断|评估失败/);
  }finally{await view.unmount();}
});

test('a newer batch success clears an older single failure, including after closing batch results',async()=>{
  let submissions=0;
  const successful=candidatesFixture().map(candidate=>({...candidate,ai_pending:false,evaluation_failure:null,
    history:[{id:candidate.id+10,result:{score:80+candidate.id,category:'推荐'}}]}));
  const view=await mount(async(path,data)=>{
    assert.equal(path,'/api/ai/tasks');submissions++;
    return submissions===1?task(data.data.id,'failed',{status:502,result:{error:'较早单评失败'}})
      :task(data.data.id,'succeeded',{status:200,result:{}});
  },{onRefresh:count=>count===2?successful:null});
  try{
    const row=()=>view.element.querySelector('[data-row-id="1"]');
    await act(async()=>[...row().querySelectorAll('button')].find(node=>node.textContent==='AI 评估').click());
    assert.match(row().textContent,/较早单评失败/);
    await start(view);assert.match(row().textContent,/81分/);assert.doesNotMatch(row().textContent,/较早单评失败/);
    await act(async()=>[...view.element.querySelectorAll('button')].find(node=>node.textContent==='关闭结果').click());
    assert.match(row().textContent,/81分/);assert.doesNotMatch(row().textContent,/较早单评失败/);
  }finally{await view.unmount();}
});

test('a newer single success supersedes the previous batch failure and stale persisted diagnostic',async()=>{
  let submissions=0;
  const candidates=candidatesFixture().slice(0,1);
  const view=await mount(async(path,data)=>{
    assert.equal(path,'/api/ai/tasks');submissions++;
    return submissions===1?task(data.data.id,'failed',{status:502,result:{error:'旧批量失败'}})
      :task(data.data.id,'succeeded',{status:200,result:{}});
  },{candidates});
  try{
    await start(view);
    await view.updateCandidates([{...candidates[0],ai_pending:true,evaluation_failure:{message:'已保存的旧错误'}}]);
    const row=()=>view.element.querySelector('[data-row-id="1"]');assert.match(row().textContent,/已保存的旧错误/);
    await act(async()=>[...row().querySelectorAll('button')].find(node=>node.textContent==='重试评估').click());
    assert.match(row().textContent,/已完成，待刷新/);assert.doesNotMatch(row().textContent,/旧批量失败|已保存的旧错误/);
    await act(async()=>[...row().querySelectorAll('button')].find(node=>node.textContent==='查看详情').click());
    const detail=view.element.querySelector('[data-detail-id="1"]');
    assert.doesNotMatch(detail.textContent,/旧批量失败|已保存的旧错误/);assert.equal(detail.getAttribute('data-feedback-error'),'false');
    assert.equal(detail.getAttribute('data-task-state'),'succeeded');
  }finally{await view.unmount();}
});

test('a refreshed successful result supersedes an earlier local failure without another client request',async()=>{
  for(const mode of ['single','batch']){
    const candidates=candidatesFixture().slice(0,1);
    const view=await mount(async(_path,data)=>task(data.data.id,'failed',{status:502,result:{error:'本机此前失败'}}),{candidates});
    try{
      if(mode==='batch')await start(view);
      else await act(async()=>[...view.element.querySelectorAll('[data-row-id="1"] button')].find(node=>node.textContent==='AI 评估').click());
      const row=()=>view.element.querySelector('[data-row-id="1"]');
      assert.match(row().textContent,/本机此前失败/);
      await act(async()=>[...row().querySelectorAll('button')].find(node=>node.textContent==='查看详情').click());
      assert.match(view.element.querySelector('[data-detail-id="1"]').textContent,/本机此前失败/);
      await view.updateCandidates([{...candidates[0],evaluation_failure:null,ai_pending:false,
        history:[{id:20,result:{score:91,category:'推荐'}}]}]);
      assert.match(row().textContent,/91分/);assert.doesNotMatch(row().textContent,/本机此前失败|评估失败/);
      const detail=view.element.querySelector('[data-detail-id="1"]');
      assert.equal(detail.textContent,'');assert.equal(detail.getAttribute('data-feedback-error'),'false');
    }finally{await view.unmount();}
  }
});

test('a newly persisted failure replaces an older local failure even when successful history is unchanged',async()=>{
  const candidates=candidatesFixture().slice(0,1);
  const view=await mount(async(_path,data)=>task(data.data.id,'failed',{status:502,result:{error:'较早连接超时'}}),{candidates});
  try{
    await start(view);
    const row=()=>view.element.querySelector('[data-row-id="1"]');assert.match(row().textContent,/较早连接超时/);
    await view.updateCandidates([{...candidates[0],ai_pending:true,evaluation_failure:{message:'后来格式校验失败',created:'2026-11-20T10:00:00Z'}}]);
    assert.match(row().textContent,/后来格式校验失败/);assert.doesNotMatch(row().textContent,/较早连接超时/);
    await act(async()=>[...row().querySelectorAll('button')].find(node=>node.textContent==='查看详情').click());
    assert.doesNotMatch(view.element.querySelector('[data-detail-id="1"]').textContent,/较早连接超时/);
  }finally{await view.unmount();}
});

test('candidate list displays rules-only completion without an AI score',async()=>{
  const candidates=[{...candidatesFixture()[0],history:[{id:1,result:ruleRejectedResult()}]}];
  const view=await mount(async()=>{throw Error('Rendering must not request another evaluation');},{candidates});
  try{
    const row=view.element.querySelector('[data-row-id="1"]');
    assert.match(row.textContent,/规则预筛不达标 · 未调用模型/);
    assert.equal(row.querySelector('.candidate-ai-score'),null);
    assert.doesNotMatch(row.textContent,/null|undefined|0分|尚未评估|待重试/);
  }finally{await view.unmount();}
});
