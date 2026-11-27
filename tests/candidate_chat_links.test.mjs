import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const bundle = await build({
  entryPoints:[fileURLToPath(new URL('../frontend/CandidateCommunicationAttachments.jsx', import.meta.url))],
  bundle:true, write:false, format:'cjs', platform:'node', packages:'external', jsx:'automatic',
  plugins:[{name:'candidate-chat-controls',setup(builder){
    builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:args.path,external:true}));
    builder.onResolve({filter:/^antd$/},()=>({path:'antd',namespace:'test-controls'}));
    builder.onResolve({filter:/ChatResumeSources\.jsx$/},()=>({path:'sources',namespace:'test-controls'}));
    builder.onLoad({filter:/.*/,namespace:'test-controls'},({path})=>({loader:'jsx',contents:path==='sources'
      ? 'export default function Sources(){return null}' : `
      import React from 'react';
      export const Flex=({children})=><div>{children}</div>;
      export const Spin=Flex;
      export const Typography={Text:Flex,Paragraph:Flex,Title:Flex};
      export const Button=({href,target,rel,disabled,children,onClick,title})=>href
        ? <a href={href} target={target} rel={rel} title={title}>{children}</a>
        : <button disabled={disabled} onClick={onClick} title={title}>{children}</button>;
      export const Empty=({description})=><p>{description}</p>;
      export const Alert=({title})=><aside>{title}</aside>;
      export const Collapse=()=>null;
    `}));
  }}],
});
const module={exports:{}};
vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url)});
const Component=module.exports.default;
const response=conversations=>({json:async()=>({conversations,attachments:[],resumes:[]})});
const row=(id,friend,account)=>({id,friend_id:friend,account_name:account,candidate_name:'同名候选人'});
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}

async function mount(candidateId,api){
  const {window}=parseHTML('<html><body></body></html>');
  const previous=new Map();
  for(const [key,value] of Object.entries({window,document:window.document,navigator:window.navigator,
    HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const element=document.createElement('div');document.body.append(element);
  const root=createRoot(element),notify=()=>{};
  const render=id=>act(async()=>root.render(React.createElement(Component,{candidateId:id,api,notify})));
  await render(candidateId);
  return {element,render,async close(){
    await act(async()=>root.unmount());
    for(const [key,descriptor] of previous) {
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
    }
  }};
}

test('candidate chat entries keep each recruiting account separate and reject unusable identities',async()=>{
  const view=await mount(1,async()=>response([row(10,'123456789','招聘账号 A'),row(20,'987654321','招聘账号 B'),row(30,'encrypted-id','招聘账号 C')]));
  try{
    const links=[...view.element.querySelectorAll('a')];
    assert.deepEqual(links.map(a=>a.getAttribute('href')),[
      'https://www.zhipin.com/web/chat/index?uid=123456789&source=0',
      'https://www.zhipin.com/web/chat/index?uid=987654321&source=0']);
    for(const link of links){assert.equal(link.getAttribute('target'),'_blank');assert.equal(link.getAttribute('rel'),'noopener noreferrer');}
    assert.match(view.element.textContent,/招聘账号 A.*招聘账号 B.*招聘账号 C/);
    assert.ok([...view.element.querySelectorAll('button')].some(b=>b.textContent==='在 BOSS 中聊天'&&b.disabled));
  }finally{await view.close();}
});

test('switching candidate removes the old link while loading and late prior responses cannot restore it',async()=>{
  const refreshed=deferred(),next=deferred();let count=0;
  const view=await mount(1,async(_path,{candidate_id})=>candidate_id===2?next.promise
    :++count===1?response([row(1,'123456789','账号 A')]):refreshed.promise);
  try{
    assert.equal(view.element.querySelectorAll('a').length,1);
    await act(async()=>[...view.element.querySelectorAll('button')].find(b=>b.textContent==='刷新会话与附件').click());
    await view.render(2);
    assert.equal(view.element.querySelector('a'),null);
    await act(async()=>next.resolve(response([row(2,'987654321','账号 B')])));
    await act(async()=>refreshed.resolve(response([row(1,'123456789','账号 A')])));
    assert.equal(view.element.querySelector('a').getAttribute('href'),'https://www.zhipin.com/web/chat/index?uid=987654321&source=0');
    assert.doesNotMatch(view.element.textContent,/账号 A/);
  }finally{await view.close();}
});
