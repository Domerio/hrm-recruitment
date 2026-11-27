import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {contacts,filterAndSort} from '../frontend/candidate-table-data.mjs';

const controls=`
import React,{useState} from 'react';
const Block=({children,className,role})=><div className={className} role={role}>{children}</div>;
export const Flex=Block,Row=Block,Col=Block,Tag=Block;
const Text=({children,copyable})=><span>{children}{copyable&&<button aria-label="复制候选人姓名" onClick={()=>navigator.clipboard.writeText(copyable.text)}>复制</button>}</span>;
export const Typography={Text,Paragraph:Block,Title:Block};
export const App={useApp:()=>({modal:{confirm(){throw Error('Unexpected confirmation')}}})};
export const Card=({children,title,extra})=><section><h3>{title}</h3>{extra}{children}</section>;
export const Button=({href,target,rel,children,onClick,disabled,'aria-label':label})=>href
  ?<a href={href} target={target} rel={rel} onClick={onClick}>{children}</a>
  :<button disabled={disabled} onClick={onClick} aria-label={label}>{children}</button>;
export const Alert=({title,description})=><aside>{title}{description}</aside>;
export const Checkbox=({children})=><label>{children}</label>;
export const Collapse=({items})=><div>{items.map(item=><div key={item.key}>{item.label}{item.children}</div>)}</div>;
export const Dropdown=({children,menu})=>{const [open,setOpen]=useState(false);return <div data-dropdown="true">
  <span onClick={()=>setOpen(!open)}>{children}</span>{open&&<div>{menu.items.filter(item=>item.onClick).map((item,i)=><button key={i}
    disabled={item.disabled} onClick={()=>{item.onClick();setOpen(false);}}>{item.label}</button>)}</div>}</div>};
export const Empty=({children,description})=><div>{description}{children}</div>;Empty.PRESENTED_IMAGE_SIMPLE='';
export const Modal=({children,title,open,onCancel,footer})=>open?<section role="dialog"><h3>{title}</h3>{children}{footer||<button onClick={onCancel}>关闭</button>}</section>:null;
export const Progress=()=>null;
export const Radio=Block;Radio.Group=Block;
export const Select=({options=[]})=><select>{options.map(option=><option key={option.value}>{option.label}</option>)}</select>;
export const Statistic=({title,value})=><div>{title}{value}</div>;
export const Table=({dataSource,columns})=><div>{dataSource.map(row=><div key={row.id} data-row-id={row.id}>{columns.map(column=><div key={column.key}>{column.render?.(undefined,row)}</div>)}</div>)}</div>;
`;

async function bundle(file){
  const result=await build({entryPoints:[fileURLToPath(new URL('../frontend/'+file,import.meta.url))],
    bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic',
    plugins:[{name:'contact-option-controls',setup(builder){
      builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:args.path,external:true}));
      builder.onResolve({filter:/^\.\/(CandidateDetail|CandidateEditor|DirectResumeEvaluation|CandidateColumnFilter|ResizableHeaderCell)$/},args=>({path:args.path,namespace:'stub'}));
      builder.onLoad({filter:/.*/,namespace:'stub'},()=>({loader:'jsx',contents:'export default ()=>null;export const EvaluationTag=()=>null,ProfileValue=()=>null,ReviewTag=()=>null,reviewOptions=[];'}));
      builder.onResolve({filter:/^(antd|@ant-design\/icons)$/},args=>({path:args.path,namespace:'controls'}));
      builder.onLoad({filter:/.*/,namespace:'controls'},({path})=>({loader:'jsx',contents:path==='antd'?controls:
        'export const DownOutlined=()=>null,FilterFilled=()=>null,MoreOutlined=()=>null,ThunderboltOutlined=()=>null;'}));
    }}]});
  return result.outputFiles[0].text;
}
const [entrySource,listSource]=await Promise.all([bundle('CandidateChatEntry.jsx'),bundle('Candidates.jsx')]);
const candidate=(id,uid)=>({id,name:'候选人'+id,job_id:1,history:[],review:'未复核',source:{boss_chat_uid:uid}});

async function mount(kind,input){
  const {window}=parseHTML('<html><body></body></html>');
  const previous=new Map(),copies=[],calls=[];
  const navigator={clipboard:{writeText:async text=>{copies.push(text);}}};
  for(const [key,value] of Object.entries({window,document:window.document,navigator,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  const module={exports:{}};
  vm.runInNewContext(kind==='list'?listSource:entrySource,{module,exports:module.exports,require:createRequire(import.meta.url),window,document:window.document,navigator,setTimeout,clearTimeout});
  const Component=module.exports.default,element=document.createElement('div');document.body.appendChild(element);
  const root=createRoot(element);
  const props=value=>kind==='list'?{state:{configured:true,jobs:[{id:1,title:'工程师'}],candidates:value},
    refresh:async()=>{},notify:()=>{},api:async(...args)=>{calls.push(args);throw Error('Contact options must not call an API');}}:
    {candidate:value,detailed:true};
  const render=value=>act(async()=>root.render(React.createElement(Component,props(value))));
  await render(input);
  return {element,copies,calls,render,async close(){
    await act(async()=>root.unmount());
    for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  }};
}
const button=(root,text)=>[...root.querySelectorAll('button')].find(node=>node.textContent===text);
const click=element=>act(async()=>element.click());
async function openListContact(view,id){
  await click(view.element.querySelector(`[data-row-id="${id}"] button[aria-label$="更多操作"]`));
  await click(button(view.element.querySelector(`[data-row-id="${id}"]`),'联系候选人'));
}

test('a recommendation UID opens contact choices rather than claiming an existing friendship',async()=>{
  const row={...candidate(1,'100000001'),link:'https://www.zhipin.com/share/resume'};
  const view=await mount('entry',row);
  try{
    assert.equal(view.element.querySelector('a'),null);
    await click(button(view.element,'联系候选人'));
    const dialog=view.element.querySelector('[role="dialog"]');assert.ok(dialog);
    assert.match(dialog.textContent,/沟通关系尚未核实/);assert.match(dialog.textContent,/不会自动定位此人/);
    assert.match(dialog.textContent,/由你本人决定是否打招呼/);assert.doesNotMatch(dialog.textContent,/在 BOSS 中聊天|复制聊天链接/);
    const links=[...dialog.querySelectorAll('a')];
    assert.deepEqual(links.map(node=>node.getAttribute('href')),[
      'https://www.zhipin.com/web/chat/recommend','https://www.zhipin.com/web/chat/index?uid=100000001&source=0']);
    assert.match(links[1].textContent,/尝试打开已有会话/);
    for(const link of links){assert.equal(link.getAttribute('target'),'_blank');assert.equal(link.getAttribute('rel'),'noopener noreferrer');await click(link);}
    await click(dialog.querySelector('button[aria-label="复制候选人姓名"]'));
    assert.deepEqual(view.copies,['候选人1']);assert.deepEqual(view.calls,[]);
    assert.equal(row.link,'https://www.zhipin.com/share/resume');
  }finally{await view.close();}
});

test('contact choices remove old links when the candidate, UID or job changes or disappears',async()=>{
  const a=candidate(1,'12345'),b=candidate(2,'67890'),view=await mount('entry',a);
  try{
    await click(button(view.element,'联系候选人'));await view.render(b);assert.equal(view.element.querySelector('a'),null);
    await click(button(view.element,'联系候选人'));
    assert.match(view.element.querySelector('[role="dialog"]').textContent,/候选人2/);
    assert.ok([...view.element.querySelectorAll('a')].every(a=>!a.getAttribute('href').includes('12345')));
    await view.render({...b,source:{boss_chat_uid:'55555'}});assert.equal(view.element.querySelector('a'),null);
    await click(button(view.element,'联系候选人'));await view.render({...b,job_id:2});assert.equal(view.element.querySelector('a'),null);
    await view.render(null);assert.equal(view.element.textContent,'');
    for(const value of ['', 'encrypted-ID','0','01']){
      await view.render(candidate(3,value));assert.equal(view.element.textContent,'');
    }
  }finally{await view.close();}
});

test('list contact modal stays outside the closed dropdown and derives current identity by candidate ID',async()=>{
  const a=candidate(1,'12345'),b=candidate(2,'67890'),view=await mount('list',[a,b]);
  try{
    assert.equal(view.element.querySelector('a'),null);await openListContact(view,1);
    const dialog=view.element.querySelector('[role="dialog"]');assert.ok(dialog);assert.equal(dialog.closest('[data-dropdown]'),null);
    assert.ok([...dialog.querySelectorAll('a')].some(a=>a.getAttribute('href').includes('uid=12345')));
    await view.render([b]);assert.equal(view.element.querySelector('[role="dialog"]'),null);assert.equal(view.element.querySelector('a'),null);
    await openListContact(view,2);
    assert.ok([...view.element.querySelectorAll('a')].every(a=>!a.getAttribute('href').includes('12345')));
    for(const link of view.element.querySelectorAll('a'))await click(link);
    assert.deepEqual(view.calls,[]);
    await view.render([{...b,source:{boss_chat_uid:'55555'}}]);assert.equal(view.element.querySelector('a'),null);
    await openListContact(view,2);await click(button(view.element.querySelector('[data-row-id="2"]'),'查看详情'));
    assert.equal(view.element.querySelector('a'),null);
  }finally{await view.close();}
});

test('recommendation UID alone is not a contact or platform-entry match and original resume links still work',()=>{
  const rows=[candidate(1,'100000001'),candidate(2,'encrypted-ID'),
    {...candidate(3,''),link:'https://www.zhipin.com/share/resume'},{...candidate(4,'98765'),phone:'123'}];
  assert.deepEqual(contacts(rows[0]),[]);assert.deepEqual(contacts(rows[1]),[]);
  assert.deepEqual(contacts(rows[2]),['平台入口']);assert.deepEqual(contacts(rows[3]),['手机']);
  assert.deepEqual(filterAndSort(rows,{contact:'link'}).map(row=>row.id),[3]);
  assert.deepEqual(filterAndSort(rows,{contact:'available'}).map(row=>row.id),[4,3]);
  assert.deepEqual(filterAndSort(rows,{contact:'missing'}).map(row=>row.id),[2,1]);
});

test('confirmed greetings show their recruiting accounts while uncertain attempts never become proven links',async()=>{
  const record=(account_uid,state,boss_chat_uid='12345')=>({account_uid,state,boss_chat_uid});
  const confirmed={...candidate(7,'12345'),source:{boss_chat_uid:'12345',boss_greeting:[
    record('101','confirmed'),record('202','already'),record('303','attempted'),record('404','confirmed','other'),
  ]}};
  const view=await mount('entry',confirmed);
  try{
    await click(button(view.element,'联系候选人'));
    const dialog=view.element.querySelector('[role="dialog"]');
    assert.match(dialog.textContent,/已记录确认过的 BOSS 沟通关系/);
    assert.match(dialog.textContent,/招聘账号 101.*已确认打招呼成功/);
    assert.match(dialog.textContent,/招聘账号 202.*已有沟通关系/);
    assert.match(dialog.textContent,/打招呼结果待核对，系统不会自动重发/);
    assert.doesNotMatch(dialog.textContent,/404/);
    assert.equal([...dialog.querySelectorAll('a')].filter(a=>a.textContent==='打开已建立的会话 ↗').length,2);
    assert.deepEqual(contacts(confirmed),['平台入口']);
    assert.deepEqual(filterAndSort([confirmed],{contact:'link'}).map(r=>r.id),[7]);
    const uncertain={...confirmed,source:{boss_chat_uid:'12345',boss_greeting:[record('303','attempted')]}};
    await view.render(uncertain);
    assert.equal([...view.element.querySelectorAll('a')].filter(a=>a.textContent==='打开已建立的会话 ↗').length,0);
    assert.deepEqual(contacts(uncertain),[]);
    assert.deepEqual(filterAndSort([uncertain],{contact:'missing'}).map(r=>r.id),[7]);
  }finally{await view.close();}
});
