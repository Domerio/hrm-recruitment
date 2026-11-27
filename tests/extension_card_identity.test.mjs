import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const sources=['dom-reader.js','automation.js'].map(file=>
  fs.readFileSync(new URL('../extension/'+file,import.meta.url),'utf8'));
const card=(name='王**',company='合成视觉公司')=>`<article class="geek-info-card">
  <span class="name-label">${name}</span><p>本科 · 8年 · 在职考虑机会</p>
  <p>期望：温州，机器视觉算法工程师。${company}，负责图像处理与软件开发，熟悉 C++ 和 OpenCV。</p>
  <button class="contact">联系Ta</button></article>`;

function fixture(markup){
  const {window}=parseHTML('<!doctype html><html><body><main>'+markup+'</main></body></html>');
  const {document,HTMLElement}=window;
  delete window.__hrmAuto;delete window.__hrmDom;
  delete window.top;delete window.parent;delete window.frameElement;
  let contacts=0;
  const names=[];
  Object.defineProperties(HTMLElement.prototype,{
    getClientRects:{configurable:true,value(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];}},
    getBoundingClientRect:{configurable:true,value(){return {x:0,y:0,left:0,top:0,right:1000,bottom:600,width:1000,height:600};}},
    scrollIntoView:{configurable:true,value(){}},
  });
  document.querySelectorAll('.contact').forEach(node=>node.addEventListener('click',()=>contacts++));
  document.querySelectorAll('.name-label').forEach(node=>node.addEventListener('click',()=>names.push(node)));
  const context={window,document,URL,location:{protocol:'https:',hostname:'www.zhipin.com',
    origin:'https://www.zhipin.com',pathname:'/web/chat/search'},innerWidth:1100,innerHeight:700,
    getComputedStyle:node=>({visibility:'visible',display:node.hidden?'none':'block',opacity:'1'}),
    setTimeout:fn=>{queueMicrotask(fn);return 1;},clearTimeout(){}};
  for(const source of sources)vm.runInNewContext(source,context);
  return {api:window.__hrmAuto,document,names,contacts:()=>contacts};
}

test('nested card wrappers sharing exactly one name node and summary produce one clickable entry',async()=>{
  const f=fixture('<section class="geek-info-card"><div class="geek-info-card">'+card()+'</div></section>');
  const scan=await f.api.run('scan');
  assert.equal(scan.cards.length,1);
  assert.equal(scan.cards[0].name,'王**');
  await f.api.run('open',scan.cards[0]);
  assert.deepEqual(f.names,[f.document.querySelector('.name-label')]);
  assert.equal(f.contacts(),0);
});

test('wrapper insertion does not alter the stable signature or discard distinct candidates',async()=>{
  const f=fixture(card('王**')+card('谢**','合成设备公司')+card('孙**','合成检测公司'));
  const before=(await f.api.run('scan')).cards;
  const first=f.document.querySelector('.geek-info-card');
  const wrapper=f.document.createElement('section');wrapper.className='geek-info-card';
  first.replaceWith(wrapper);wrapper.append(first);
  const after=(await f.api.run('scan')).cards;
  assert.deepEqual(after.map(item=>({...item})),before.map(item=>({...item})));
  await f.api.run('open',after[1]);
  assert.equal(f.names[0].textContent,'谢**');
});

test('separate DOM entries with identical masked names and summaries remain ambiguous',async()=>{
  const f=fixture(card()+card());
  const scan=await f.api.run('scan');
  assert.equal(scan.cards.length,2);
  assert.equal(scan.cards[0].signature,scan.cards[1].signature);
  assert.equal(f.names.length,0);
  assert.equal(f.contacts(),0);
});

test('matching masked names with different resume summaries are never merged',async()=>{
  const f=fixture(card('王**','合成甲公司')+card('王**','合成乙公司'));
  const scan=await f.api.run('scan');
  assert.equal(scan.cards.length,2);
  assert.notEqual(scan.cards[0].signature,scan.cards[1].signature);
});

test('shared labels do not merge wrappers whose substantive summaries differ',async()=>{
  const f=fixture('<section class="geek-info-card">'+card()+'<p>额外经历：合成项目研发。</p></section>');
  const scan=await f.api.run('scan');
  assert.equal(scan.cards.length,2);
  assert.notEqual(scan.cards[0].signature,scan.cards[1].signature);
});

test('a hidden duplicate remains excluded without suppressing its visible counterpart',async()=>{
  const f=fixture(card()+'<div hidden>'+card()+'</div>');
  const scan=await f.api.run('scan');
  assert.equal(scan.cards.length,1);
  await f.api.run('open',scan.cards[0]);
  assert.equal(f.names.length,1);
  assert.equal(f.names[0].closest('[hidden]'),null);
});

test('opening an old scan still refuses a changed card after nested deduplication',async()=>{
  const f=fixture('<section class="geek-info-card">'+card()+'</section>');
  const [entry]=(await f.api.run('scan')).cards;
  f.document.querySelector('article p').append('学习形式已变更');
  await assert.rejects(f.api.run('open',entry),/列表已更新/);
  assert.equal(f.names.length,0);
});
