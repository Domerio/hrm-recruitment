import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {isBoss,uniqueDetail,screenshotRect,shareScreenshotRect,verifyShareLayout,canAutoEvaluate,detailFailure,withBusyState,resumeSections,resumeFoldLabels,isResumeFoldLabel} from '../extension/capture-utils.mjs';

test('inline expand links do not absorb a following section heading across line breaks',()=>{
  for(const separator of ['\n','\r\n','\u2028']){
    for(const heading of ['期望职位','工作经历','教育经历']){
      assert.deepEqual(resumeFoldLabels('视觉检测项目开发... 查看全部'+separator+heading),['查看全部']);
    }
  }
  assert.deepEqual(resumeFoldLabels('正文... 查 看 全 部\n工作经历'),['查看全部']);
  assert.deepEqual(resumeFoldLabels('展开全部 16 个所获荣誉\n教育经历'),['展开全部16个所获荣誉']);
});

test('resume section aliases preserve completeness evidence for alternative headings',()=>{
  assert.deepEqual(resumeSections('工作经验\n项目经验\n教育背景'),['工作经历','项目经历','教育经历']);
  assert.deepEqual(resumeSections('荣誉奖项\n获奖经历\n语言能力'),['所获荣誉','语言能力']);
});

test('fold labels retain the exact normalized count and section without matching arbitrary prose',()=>{
  assert.deepEqual(resumeFoldLabels('… 展开全部 16 个所获荣誉\n查看全部３项荣誉\n展 开 全 部 ２ 条 语 言 能 力'),
    ['展开全部16个所获荣誉','查看全部3项荣誉','展开全部2条语言能力']);
  for(const value of ['展开全部16个所获荣誉','查看全部9项荣誉奖项','查看更多2份资格证书'])assert.equal(isResumeFoldLabel(value),true);
  for(const value of ['展开测试方案','展开全部16项内部测试任务','查看全部未来发展规划','展开全部0个所获荣誉']){
    assert.deepEqual(resumeFoldLabels(value),[]);
    assert.equal(isResumeFoldLabel(value),false);
  }
});

function fixture({stuck=false,layout='',pageLocation=null,now=Date.now}={}){
  const {window}=parseHTML(`<!doctype html><html><body>
  <main><article class="card"><strong class="person">张**</strong><p>本科 · 8年 · 在职考虑机会</p><p>期望：温州，机器视觉算法工程师。负责图像处理与软件开发，熟悉 C++ 和 OpenCV，参与系统集成和生产线部署。</p><button class="contact">联系Ta</button></article></main>
  <div role="dialog" hidden><button aria-label="关闭">×</button><section class="resume"><strong>张**</strong><h2>个人优势</h2><p>熟悉视觉软件和工业自动化。</p><button class="expand">查看全部</button><h2>工作经历</h2><p>虚构科技公司，视觉算法工程师。负责机器视觉开发、图像定位和缺陷检测。使用 C++、OpenCV 设计图像处理算法并进行现场调试。协调电气工程师进行项目交付和系统测试。</p><h2>教育经历</h2><p>虚构大学，本科，计算机专业。</p></section><button class="contact">联系Ta</button></div>
  </body></html>`);
  const {document,HTMLElement}=window;let contact=0;
  delete window.__hrmAuto; // linkedom's window proxy shares expando globals between fixtures.
  delete window.__hrmDom;
  delete window.top;delete window.parent;delete window.frameElement;
  const closedRoots=new WeakMap(),resumeElement=document.querySelector('.resume');
  const scrollTops=new WeakMap();
  const properties={
    getClientRects:{value:function(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];}},
    getBoundingClientRect:{value:function(){const close=this.hasAttribute('aria-label');const r={x:close?1070:0,y:close?10:0,width:close?20:1100,height:close?20:800};return {...r,left:r.x,top:r.y,right:r.x+r.width,bottom:r.y+r.height};}},
    clientHeight:{get(){return 400;}},clientWidth:{get(){return 1100;}},scrollHeight:{get(){return 1400;}},
    scrollTop:{get(){return scrollTops.get(this)||0;},set(v){scrollTops.set(this,Math.max(0,Math.min(v,1000)));this.dispatchEvent(new window.Event('scroll'));}},
    scrollIntoView:{value(){}}
  };
  Object.defineProperties(HTMLElement.prototype,Object.fromEntries(Object.entries(properties).map(([k,v])=>[k,{...v,configurable:true}])));
  Object.defineProperty(document,'scrollingElement',{value:document.body});
  document.querySelectorAll('.contact').forEach(e=>e.addEventListener('click',()=>contact++));
  document.querySelector('.person').addEventListener('click',()=>{document.querySelector('[role=dialog]').hidden=false;});
  document.querySelector('[aria-label=关闭]').addEventListener('click',()=>{document.querySelector('[role=dialog]').hidden=true;});
  document.querySelector('.expand').addEventListener('click',e=>{
    if(!stuck){const p=document.createElement('p');p.textContent='展开后补充的项目细节：完成标定和坐标转换，检测精度达到项目要求。';resumeElement.append(p);e.target.remove();}
  });
  document.body.addEventListener('scroll',()=>{
    if(document.body.scrollTop>=1000&&!resumeElement.querySelector('.late')){const p=document.createElement('p');p.className='late';p.textContent='滚动加载的证书：软件设计师。';resumeElement.append(p);}
  });
  if(layout==='semantic'){
    for(const h of document.querySelectorAll('.resume h2')){const replacement=document.createElement('dt');replacement.textContent=h.textContent+'：';h.replaceWith(replacement);}
    const old=document.querySelector('.resume strong'),header=document.createElement('h4');header.innerHTML='张＊ ＊<small>刚刚活跃</small>';old.replaceWith(header);
  }
  if(layout==='body'){
    const resume=document.querySelector('.resume'),name=resume.querySelector('strong');
    document.body.append(name,resume);document.querySelector('main').remove();document.querySelector('[role=dialog]').remove();
  }
  if(layout==='repeated-header'){
    const repeated=document.createElement('h4');repeated.textContent='张**';document.querySelector('.resume').append(repeated);
  }
  if(layout==='two-details'){
    const dialog=document.querySelector('[role=dialog]');dialog.hidden=false;document.body.append(dialog.cloneNode(true));
  }
  if(['open-shadow','closed-shadow'].includes(layout)){
    const host=document.createElement('resume-view');resumeElement.replaceWith(host);
    const root=host.attachShadow({mode:layout==='open-shadow'?'open':'closed'});root.append(resumeElement);closedRoots.set(host,root);
  }
  if(layout==='split-heading'){
    for(const heading of resumeElement.querySelectorAll('h2'))heading.innerHTML=[...heading.textContent].map(c=>`<span>${c}</span>`).join('');
  }
  if(layout==='canvas-dialog'){
    const dialog=document.querySelector('[role=dialog]');
    dialog.className='dialog-lib-resume';
    dialog.querySelector('[aria-label=关闭]').className='close-btn';
    const wrapper=document.createElement('div');wrapper.className='resume-detail-wrap';
    wrapper.innerHTML='<iframe src="https://www.zhipin.com/web/frame/c-resume/"></iframe><button>查看全部</button>';
    resumeElement.replaceWith(wrapper);
    wrapper.querySelector('button').addEventListener('click',event=>event.target.remove());
  }
  const context={window,document,URL,Date:class extends Date{static now(){return now();}},
    location:pageLocation||{protocol:'https:',hostname:'www.zhipin.com',origin:'https://www.zhipin.com',pathname:'/test'},innerWidth:1200,innerHeight:800,
    chrome:{dom:{openOrClosedShadowRoot:el=>closedRoots.get(el)||el.shadowRoot}},
    getComputedStyle:e=>({visibility:'visible',display:e.hidden?'none':'block',
      overflowY:e.style?.overflowY||'visible',pointerEvents:e.style?.pointerEvents||'auto'}),setTimeout:fn=>{queueMicrotask(fn);return 1;},clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(new URL('../extension/dom-reader.js',import.meta.url),'utf8'),context);
  vm.runInNewContext(fs.readFileSync(new URL('../extension/automation.js',import.meta.url),'utf8'),context);
  return {api:window.__hrmAuto,document,window,contacts:()=>contact};
}

test('discovers a card, opens only its name, expands and reads late-loaded details, then closes',async()=>{
  const f=fixture();const list=await f.api.run('scan');assert.equal(list.cards.length,1);assert.equal(list.detail,'');
  await f.api.run('open',list.cards[0]);assert.equal((await f.api.run('scan')).detail,'张**');
  const result=await f.api.run('read',{name:'张**'});
  assert.match(result.resume,/展开后补充的项目细节/);assert.match(result.resume,/滚动加载的证书/);
  assert.equal(result.capture.status,'visible_complete');assert.equal(f.contacts(),0);
  await f.api.run('close',{name:'张**'});assert.equal((await f.api.run('scan')).detail,'');
});

test('candidate opening never clicks a name inside avatar or media preview controls',async()=>{
  for(const attrs of [{class:'avatar-preview-trigger'},{'aria-label':'查看头像'},{class:'photo-viewer'},
    {class:'image-preview'},{class:'media-preview'},{title:'预览照片'}]){
    const f=fixture(),label=f.document.querySelector('.person'),card=(await f.api.run('scan')).cards[0];
    const wrapper=f.document.createElement('div');label.replaceWith(wrapper);wrapper.append(label);
    for(const [key,value] of Object.entries(attrs))wrapper.setAttribute(key,value);
    let previews=0;wrapper.addEventListener('click',()=>previews++);
    await assert.rejects(f.api.run('open',card),/头像|媒体预览/);
    assert.equal(previews,0);assert.equal(f.document.querySelector('[role="dialog"]').hidden,true);
  }
});

test('candidate opening rechecks preview semantics after scrolling and allows a separate avatar sibling',async()=>{
  const changed=fixture(),label=changed.document.querySelector('.person'),card=(await changed.api.run('scan')).cards[0];
  Object.defineProperty(label,'scrollIntoView',{value(){label.setAttribute('aria-label','查看头像');}});
  await assert.rejects(changed.api.run('open',card),/头像预览/);
  assert.equal(changed.document.querySelector('[role="dialog"]').hidden,true);
  const normal=fixture(),image=normal.document.createElement('img');image.className='avatar';
  normal.document.querySelector('.card').append(image);
  await normal.api.run('open',(await normal.api.run('scan')).cards[0]);
  assert.equal((await normal.api.run('scan')).detail,'张**');
});
test('card identity ignores activity, viewed, and hot-search badges while keeping resume-specific text',async()=>{
  const f=fixture(),root=f.document.querySelector('.card');
  const activity=f.document.createElement('small');
  const seen=f.document.createElement('p');
  const badge=f.document.createElement('span');
  activity.textContent='刚刚活跃';seen.textContent='近14天你首次看到该牛人';badge.textContent='热搜';
  root.append(activity,seen,badge);
  const first=(await f.api.run('scan')).cards[0];
  activity.textContent='2月内活跃';seen.textContent='已查看';badge.remove();
  const later=(await f.api.run('scan')).cards[0];
  assert.equal(first.signature,later.signature);
  assert.match(later.signature,/软件开发/);
  assert.doesNotMatch(later.signature,/活跃|已查看|联系Ta|热搜/);
});

test('direct background DOM reads do not certify embedded graphics or encoded glyphs as complete text',async()=>{
  for(const markup of ['<canvas></canvas>','<img src="fixture.png">','<p>未知字形\uE001</p>']){
    const f=fixture();
    await f.api.run('open',(await f.api.run('scan')).cards[0]);
    const extra=f.document.createElement('div');extra.innerHTML=markup;
    f.document.querySelector('.resume').append(extra);
    const result=await f.api.run('read',{name:'张**'});
    assert.equal(result.capture.status,'needs_review');
    assert.ok(result.capture.warnings.length>0);
    assert.equal(f.contacts(),0);
  }
});

test('background DOM completeness preserves repeated lines and their order across virtual snapshots',async()=>{
  for(const repeated of [false,true]){
    const f=fixture();await f.api.run('open',(await f.api.run('scan')).cards[0]);
    f.document.querySelector('.expand').remove();
    const first=f.document.createElement('p'),second=f.document.createElement('p');
    first.textContent='项目甲独立完成算法研发与交付';second.textContent='项目乙负责维护系统和验证需求';
    const root=f.document.querySelector('.resume');root.append(first,second);
    let changed=false;
    f.document.body.addEventListener('scroll',()=>{
      if(!changed&&f.document.body.scrollTop>0){
        changed=true;
        if(repeated)second.textContent=first.textContent;
        else root.insertBefore(second,first);
      }
    });
    const result=await f.api.run('read',{name:'张**'});
    assert.equal(result.capture.status,'needs_review');
    assert.match(result.capture.warnings.join('；'),/动态替换/);
  }
});

test('advance-list scrolls the nearest candidate list owner before considering next-page controls',async()=>{
  const f=fixture(),list=f.document.querySelector('main');
  list.style.overflowY='auto';
  const next=f.document.createElement('button');next.textContent='下一页';list.append(next);
  let clicks=0;next.addEventListener('click',()=>clicks++);
  assert.deepEqual({...await f.api.run('advance-list')},{kind:'scroll',moved:true});
  assert.equal(list.scrollTop,300);
  assert.equal(f.document.body.scrollTop,0);
  assert.equal(clicks,0);
  assert.equal(f.contacts(),0);
});

test('advance-list supports virtualized cards whose DOM id is reused after scrolling',async()=>{
  const f=fixture(),list=f.document.querySelector('main');
  list.style.overflowY='auto';
  const initial=(await f.api.run('scan')).cards[0];
  list.addEventListener('scroll',()=>{
    if(list.scrollTop>=300)f.document.querySelector('.card p:last-of-type').textContent='期望：上海，软件工程师。负责机器人视觉定位算法开发，任职于另一家测试装备技术公司。';
  });
  await f.api.run('advance-list');
  const fresh=(await f.api.run('scan')).cards[0];
  assert.equal(fresh.id,initial.id);
  assert.notEqual(fresh.signature,initial.signature);
});

test('advance-list clicks an explicit bottom control once and waits for changed cards before clicking again',async()=>{
  const f=fixture(),list=f.document.querySelector('main');list.style.overflowY='auto';list.scrollTop=1000;
  const next=f.document.createElement('button');next.textContent='下一页';list.append(next);
  let clicks=0;next.addEventListener('click',()=>clicks++);
  assert.deepEqual({...await f.api.run('advance-list')},{kind:'next-page',moved:true});
  assert.deepEqual({...await f.api.run('advance-list')},{kind:'waiting',moved:false});
  assert.equal(clicks,1);
  const replacement=next.cloneNode(true);next.replaceWith(replacement);
  replacement.addEventListener('click',()=>clicks++);
  assert.deepEqual({...await f.api.run('advance-list')},{kind:'waiting',moved:false});
  assert.equal(clicks,1);
  f.document.querySelector('.card p:last-of-type').append('新一页的独立项目经历。');
  assert.deepEqual({...await f.api.run('advance-list')},{kind:'next-page',moved:true});
  assert.equal(clicks,2);
  assert.equal(f.contacts(),0);
});

test('advance-list prefers load-more and rejects disabled or ambiguous navigation controls',async()=>{
  for(const mode of ['load','disabled','ambiguous']){
    const f=fixture(),list=f.document.querySelector('main');list.style.overflowY='auto';list.scrollTop=1000;
    const next=f.document.createElement('button');next.textContent='下一页';list.append(next);
    let clicked='';
    next.addEventListener('click',()=>{clicked='next';});
    if(mode==='load'){
      const more=f.document.createElement('button');more.textContent='加载更多';list.append(more);
      more.addEventListener('click',()=>{clicked='more';});
    }else if(mode==='disabled')next.setAttribute('aria-disabled','true');
    else list.append(next.cloneNode(true));
    const result=await f.api.run('advance-list');
    assert.equal(result.kind,mode==='load'?'load-more':'waiting');
    assert.equal(clicked,mode==='load'?'more':'');
    assert.equal(f.contacts(),0);
  }
});

test('advance-list never uses an unrelated sidebar pager outside the candidate list container',async()=>{
  const f=fixture();f.document.body.scrollTop=1000;
  const aside=f.document.createElement('aside'),next=f.document.createElement('button');
  next.textContent='下一页';aside.append(next);f.document.body.append(aside);
  let clicks=0;next.addEventListener('click',()=>clicks++);
  assert.deepEqual({...await f.api.run('advance-list')},{kind:'waiting',moved:false});
  assert.equal(clicks,0);
  assert.equal(f.contacts(),0);
});

test('advance-list does not move an open detail, ambiguous lists, verification page, or a stopped task',async()=>{
  const detail=fixture();
  const card=(await detail.api.run('scan')).cards[0];await detail.api.run('open',card);
  assert.deepEqual({...await detail.api.run('advance-list')},{kind:'waiting',moved:false});
  assert.equal(detail.document.body.scrollTop,0);
  const multiple=fixture(),list=multiple.document.querySelector('main');list.style.overflowY='auto';
  multiple.document.body.append(list.cloneNode(true));
  assert.deepEqual({...await multiple.api.run('advance-list')},{kind:'waiting',moved:false});
  assert.equal(multiple.document.body.scrollTop,0);
  const stopped=fixture();await stopped.api.run('stop');
  await assert.rejects(stopped.api.run('advance-list'),/已停止/);
  const verification=fixture();verification.document.body.append('请完成安全验证');
  await assert.rejects(verification.api.run('advance-list'),/人工验证/);
});

test('advance-list can use the containing iframe list scroll owner when the inner document has no range',async()=>{
  const f=fixture();
  Object.defineProperty(f.document.body,'scrollHeight',{get:()=>400,configurable:true});
  const {document:outer}=parseHTML('<html><body><div class="owner" style="overflow-y:auto"><iframe></iframe></div></body></html>');
  const owner=outer.querySelector('.owner'),frame=outer.querySelector('iframe');
  outer.elementFromPoint=()=>frame;
  Object.defineProperty(outer,'scrollingElement',{value:outer.body});
  const parent={document:outer,innerWidth:1200,innerHeight:800,getComputedStyle:element=>({
    visibility:'visible',display:'block',overflowY:element.style?.overflowY||'visible',pointerEvents:'auto'})};
  parent.top=parent;
  f.window.parent=parent;f.window.top=parent;f.window.frameElement=frame;
  assert.deepEqual({...await f.api.run('advance-list')},{kind:'scroll',moved:true});
  assert.equal(owner.scrollTop,300);
  assert.equal(f.document.body.scrollTop,0);
});
test('prepare-copy proves both text boundaries and does not accept a long repeated prefix as the tail',async()=>{
  const f=fixture();
  const [card]=(await f.api.run('scan')).cards;
  await f.api.run('open',card);
  const complete=await f.api.run('read',{name:card.name});
  const proof=await f.api.run('prepare-copy',{name:card.name});
  const normalized=complete.resume.replace(/\s/g,'');
  assert.equal(proof.status,'visible_complete');
  assert.equal(proof.minimumLength,normalized.length);
  assert.equal(proof.contentHead,normalized.slice(0,80));
  assert.equal(proof.contentTail,normalized.slice(-80));
  assert.match(proof.contentTail,/滚动加载的证书/);
  const repeatedPrefix=normalized.slice(0,Math.floor(normalized.length/2)).repeat(3);
  assert.ok(repeatedPrefix.length>=proof.minimumLength);
  assert.ok(!repeatedPrefix.includes(proof.contentTail));
});

test('prepare-copy marks content changed during scroll restoration for retry',async()=>{
  const f=fixture();
  const [card]=(await f.api.run('scan')).cards;
  await f.api.run('open',card);
  let visitedBottom=false;
  f.document.body.addEventListener('scroll',()=>{
    if(f.document.body.scrollTop>=1000)visitedBottom=true;
    else if(visitedBottom&&!f.document.querySelector('.restored-extra')){
      const extra=f.document.createElement('p');
      extra.className='restored-extra';
      extra.textContent='恢复阅读位置时才加载的补充经历。';
      f.document.querySelector('.resume').append(extra);
    }
  });
  const proof=await f.api.run('prepare-copy',{name:card.name});
  assert.equal(proof.status,'needs_review');
  assert.ok(proof.warnings.some(warning=>warning.includes('复制前详情正文发生变化')));
});

test('a persistent DOM expander is attempted only once and an expanded control is skipped',async()=>{
  const f=fixture({stuck:true});
  const [card]=(await f.api.run('scan')).cards;
  await f.api.run('open',card);
  const button=f.document.querySelector('.expand');
  let clicks=0;
  button.addEventListener('click',()=>clicks++);
  assert.equal((await f.api.run('read',{name:card.name})).capture.status,'needs_review');
  assert.equal(clicks,1);
  button.setAttribute('aria-expanded','true');
  assert.equal((await f.api.run('read',{name:card.name})).capture.status,'visible_complete');
  assert.equal(clicks,1);
});

test('an unscoped generic DOM expand stays unclicked and cannot certify a complete resume',async()=>{
  const f=fixture(),button=f.document.querySelector('.expand');button.textContent='展开';
  let clicks=0;button.addEventListener('click',()=>clicks++);
  await f.api.run('open',(await f.api.run('scan')).cards[0]);
  const result=await f.api.run('prepare-copy',{name:'张**'});
  assert.equal(clicks,0);assert.equal(result.status,'needs_review');
  assert.match(result.warnings.join('；'),/未确认全部展开/);
});

test('foreground DOM preparation never chooses one of several expanders and still supplies a copy range',async()=>{
  const f=fixture(),first=f.document.querySelector('.expand'),second=first.cloneNode(true);
  second.textContent='展开全部工作经历';first.after(second);
  let clicks=0;first.addEventListener('click',()=>clicks++);second.addEventListener('click',()=>{clicks++;second.remove();});
  await f.api.run('open',(await f.api.run('scan')).cards[0]);
  const prepared=await f.api.run('prepare-copy',{name:'张**'});
  assert.equal(clicks,0);assert.equal(prepared.status,'needs_review');assert.ok(prepared.minimumLength>120);
  assert.ok(prepared.contentHead&&prepared.contentTail);assert.match(prepared.warnings.join('；'),/未确认全部展开/);
  // The old background reader keeps its explicitly separate unlimited budget.
  assert.equal((await f.api.run('read',{name:'张**'})).capture.status,'visible_complete');assert.equal(clicks,2);
});

test('foreground DOM preparation with uncertain preview evidence never expands a control',async()=>{
  const f=fixture(),button=f.document.querySelector('.expand');
  let clicks=0;button.addEventListener('click',()=>clicks++);
  await f.api.run('open',(await f.api.run('scan')).cards[0]);
  const prepared=await f.api.run('prepare-copy',{name:'张**',skipExpansion:true});
  assert.equal(clicks,0);assert.equal(prepared.status,'needs_review');
  assert.match(prepared.warnings.join('；'),/未确认全部展开/);
});

test('foreground DOM preparation does not later click a remaining control after an ambiguous first screen',async()=>{
  const f=fixture(),first=f.document.querySelector('.expand'),second=first.cloneNode(true);
  second.textContent='查看更多教育经历';first.after(second);
  let clicks=0;first.addEventListener('click',()=>clicks++);second.addEventListener('click',()=>clicks++);
  f.document.body.addEventListener('scroll',()=>{if(f.document.body.scrollTop>0)second.remove();});
  await f.api.run('open',(await f.api.run('scan')).cards[0]);
  const prepared=await f.api.run('prepare-copy',{name:'张**'});
  assert.equal(clicks,0);assert.equal(prepared.status,'needs_review');assert.equal(second.isConnected,false);
});

test('DOM expands a split dynamic honor control once and recognizes honor and language chapters',async()=>{
  const f=fixture(),button=f.document.querySelector('.expand');
  button.innerHTML='<span>展开全部</span><span> 16 个所获荣誉</span>';
  const honors=f.document.createElement('h2');honors.textContent='荣誉奖项';
  const language=f.document.createElement('h2');language.textContent='语言能力';
  f.document.querySelector('.resume').append(honors,language);
  let clicks=0;button.addEventListener('click',()=>clicks++);
  const [card]=(await f.api.run('scan')).cards;
  await f.api.run('open',card);
  const read=await f.api.run('read',{name:card.name});
  assert.equal(clicks,1);
  assert.equal(read.capture.status,'visible_complete');
  assert.ok(read.capture.sections.includes('所获荣誉'));
  assert.ok(read.capture.sections.includes('语言能力'));
  assert.doesNotMatch(read.resume,/展开全部/);
});
test('binds canvas outer dialog and expands or closes only the scoped detail controls',async()=>{
  const f=fixture({layout:'canvas-dialog'});
  const [card]=(await f.api.run('scan')).cards;
  await f.api.run('open',card);
  assert.equal((await f.api.run('scan')).canvasDialog,true);
  await f.api.run('expand-canvas',{name:card.name});
  assert.equal(f.document.querySelector('.resume-detail-wrap button'),null);
  await f.api.run('close',{name:card.name,kind:'canvas'});
  assert.equal((await f.api.run('scan')).canvasDialog,false);
  assert.equal(f.contacts(),0);
});

function canvasExpandFixture({ownerControl=true,bodyControl=false,withClose=false,bodyMarkup='<canvas></canvas>'}={}){
  const bodyUrl='https://www.zhipin.com/web/frame/c-resume/?fixture=expand';
  function page(markup,url){
    const {document,HTMLElement}=parseHTML('<html><body>'+markup+'</body></html>');
    Object.defineProperties(HTMLElement.prototype,{
      getClientRects:{configurable:true,value(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];}},
      getBoundingClientRect:{configurable:true,value(){
        const control=this.matches('button,span'),x=Number(this.getAttribute('data-x')||80),y=Number(this.getAttribute('data-y')||50);
        const r=this.getAttribute('aria-label')==='关闭'?{left:970,top:10,width:20,height:20}:
          control?{left:x,top:y,width:140,height:30}:{left:0,top:this.tagName==='IFRAME'?100:0,width:1000,height:500};
        return {...r,x:r.left,y:r.top,right:r.left+r.width,bottom:r.top+r.height};
      }},clientLeft:{configurable:true,get:()=>0},clientTop:{configurable:true,get:()=>0},
    });
    const location=new URL(url);Object.defineProperty(document,'location',{configurable:true,value:location});
    const window={document,location,innerWidth:1100,innerHeight:750};window.parent=window;window.top=window;
    const metrics={styleReads:0};
    const context={window,document,location,URL,innerWidth:1100,innerHeight:750,
      getComputedStyle:element=>{metrics.styleReads++;return {visibility:'visible',display:element.hidden?'none':'block',opacity:'1',
        pointerEvents:element.style?.pointerEvents||'auto'};},setTimeout:fn=>queueMicrotask(fn),clearTimeout(){}};
    document.elementFromPoint=(x,y)=>{
      const contains=element=>{const r=element.getBoundingClientRect();return x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom;};
      return [...document.querySelectorAll('button')].find(element=>!element.closest('[hidden]')&&contains(element))||
        [...document.querySelectorAll('iframe,canvas')].find(contains)||document.body;
    };
    for(const file of ['dom-reader.js','automation.js'])
      vm.runInNewContext(fs.readFileSync(new URL('../extension/'+file,import.meta.url),'utf8'),context);
    return {document,window,api:window.__hrmAuto,metrics};
  }
  const owner=page('<button id="outside" data-x="850">查看全部</button><div class="dialog-lib-resume" role="dialog">'+
    '<div class="resume-detail-wrap"><iframe src="'+bodyUrl+'"></iframe>'+
    (ownerControl?'<button id="expand"><span>查看全部</span></button>':'')+
    '</div><button id="sensitive" data-x="650">收藏</button>'+
    (withClose?'<button aria-label="关闭">×</button>':'')+'</div>','https://www.zhipin.com/web/geek/recommend');
  const body=page(bodyMarkup+(bodyControl?'<button id="expand">展开全部</button>':''),bodyUrl);
  const frame=owner.document.querySelector('iframe');
  Object.defineProperty(frame,'contentWindow',{configurable:true,value:body.window});
  body.window.parent=owner.window;body.window.top=owner.window;body.window.frameElement=frame;
  const clicks={owner:0,body:0,outside:0,sensitive:0};
  let closeClicks=0;
  owner.document.querySelector('[aria-label="关闭"]')?.addEventListener('click',()=>{
    closeClicks++;owner.document.querySelector('.dialog-lib-resume').hidden=true;
  });
  owner.document.querySelector('#expand')?.addEventListener('click',()=>clicks.owner++);
  body.document.querySelector('#expand')?.addEventListener('click',()=>clicks.body++);
  for(const id of ['outside','sensitive'])owner.document.querySelector('#'+id).addEventListener('click',()=>clicks[id]++);
  return {owner,body,frame,clicks,closeClicks:()=>closeClicks};
}

test('Canvas DOM expansion prepares without clicks and clicks one fresh scoped button at most once',async()=>{
  const f=canvasExpandFixture(),prepared=await f.owner.api.run('prepare-canvas-expand');
  assert.equal(prepared.count,1);assert.ok(prepared.token);assert.equal(prepared.label,'查看全部');
  assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
  assert.deepEqual({...await f.owner.api.run('click-canvas-expand',{token:prepared.token})},{clicked:true,label:'查看全部'});
  await assert.rejects(f.owner.api.run('click-canvas-expand',{token:prepared.token}),/凭据已失效/);
  assert.deepEqual(f.clicks,{owner:1,body:0,outside:0,sensitive:0});
});

test('Canvas expansion rejects avatar and media preview semantics on controls or ancestors',async()=>{
  for(const label of ['展开','查看全部','展开全部'])for(const ancestor of [false,true]){
    const f=canvasExpandFixture(),button=f.owner.document.querySelector('#expand');button.textContent=label;
    const media=ancestor?f.owner.document.createElement('div'):button;
    if(ancestor){button.replaceWith(media);media.append(button);}
    media.className='avatar-preview-trigger';media.setAttribute('aria-label','查看头像');
    let previews=0;media.addEventListener('click',()=>previews++);
    const prepared=await f.owner.api.run('prepare-canvas-expand');
    assert.equal(prepared.count,0);assert.equal(prepared.token,'');
    await assert.rejects(f.owner.api.run('click-canvas-expand',{token:prepared.token}),/凭据已失效/);
    assert.equal(previews,0);assert.equal(f.clicks.owner,0);
  }
  for(const value of ['photo-viewer','image-preview','media-preview','imagePreview','video-zoom']){
    const f=canvasExpandFixture();f.owner.document.querySelector('#expand').className=value;
    assert.equal((await f.owner.api.run('prepare-canvas-expand')).count,0,value);
    assert.equal(f.clicks.owner,0);
  }
});

test('generic expand needs a bound resume fold, while explicit full-expand labels remain usable',async()=>{
  const bare=canvasExpandFixture();bare.owner.document.querySelector('#expand').textContent='展开';
  assert.equal((await bare.owner.api.run('prepare-canvas-expand')).count,0);
  assert.equal(bare.clicks.owner,0);
  for(const kind of ['section','controls','label']){
    const f=canvasExpandFixture(),button=f.owner.document.querySelector('#expand');button.textContent='展开';
    if(kind==='section'){
      const section=f.owner.document.createElement('section');section.className='resume-section';
      button.replaceWith(section);section.innerHTML='<h3>个人优势</h3>';section.append(button);
    }else if(kind==='controls'){
      const target=f.owner.document.createElement('div');target.id='folded-profile';target.className='resume-text';
      f.owner.document.querySelector('.resume-detail-wrap').append(target);button.setAttribute('aria-controls',target.id);
    }else button.setAttribute('aria-label','展开个人优势');
    const prepared=await f.owner.api.run('prepare-canvas-expand');assert.equal(prepared.count,1,kind);
    await f.owner.api.run('click-canvas-expand',{token:prepared.token});assert.equal(f.clicks.owner,1,kind);
    await assert.rejects(f.owner.api.run('click-canvas-expand',{token:prepared.token}),/凭据已失效/);
  }
  for(const label of ['查看全部','展开全部']){
    const f=canvasExpandFixture();f.owner.document.querySelector('#expand').textContent=label;
    const prepared=await f.owner.api.run('prepare-canvas-expand');assert.equal(prepared.count,1);
    await f.owner.api.run('click-canvas-expand',{token:prepared.token});assert.equal(f.clicks.owner,1);
  }
});

test('a prepared expander cannot become an avatar preview before its click',async()=>{
  const f=canvasExpandFixture(),prepared=await f.owner.api.run('prepare-canvas-expand');
  f.owner.document.querySelector('#expand').setAttribute('aria-label','查看头像');
  assert.deepEqual({...await f.owner.api.run('click-canvas-expand',{token:prepared.token})},{clicked:false,reason:'controls_changed'});
  assert.equal(f.clicks.owner,0);
});

test('Canvas DOM expansion supports frame controls with document-bound tokens and ancestor hit tests',async()=>{
  const f=canvasExpandFixture({ownerControl:false,bodyControl:true});
  assert.equal((await f.owner.api.run('prepare-canvas-expand')).count,0);
  const prepared=await f.body.api.run('prepare-canvas-expand');
  assert.equal(prepared.count,1);assert.equal(prepared.label,'展开全部');
  await assert.rejects(f.owner.api.run('click-canvas-expand',{token:prepared.token}),/凭据已失效/);
  await f.body.api.run('click-canvas-expand',{token:prepared.token});
  assert.equal(f.clicks.body,1);
  f.owner.document.elementFromPoint=()=>f.owner.document.querySelector('#outside');
  assert.equal((await f.body.api.run('prepare-canvas-expand')).count,0);
});

test('Canvas DOM expansion never prepares hidden, disabled, covered, sensitive or navigation controls',async()=>{
  for(const mutate of [
    f=>{f.owner.document.querySelector('#expand').hidden=true;},
    f=>f.owner.document.querySelector('#expand').setAttribute('disabled',''),
    f=>f.owner.document.querySelector('#expand').setAttribute('aria-label','收藏'),
    f=>{f.owner.document.querySelector('#expand').style.pointerEvents='none';},
    f=>{f.owner.document.elementFromPoint=()=>f.owner.document.querySelector('#sensitive');},
    f=>{const link=f.owner.document.createElement('a');link.href='/web/chat/index';
      f.owner.document.querySelector('#expand').replaceWith(link);link.innerHTML='<span>查看更多</span>';},
  ]){
    const f=canvasExpandFixture();mutate(f);
    const prepared=await f.owner.api.run('prepare-canvas-expand');
    assert.equal(prepared.count,0);assert.equal(prepared.token,'');
    assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
  }
});

test('Canvas DOM expansion refuses ambiguous controls and controls that change after preparation',async()=>{
  const addSecond=f=>{const button=f.owner.document.createElement('button');button.textContent='查看更多';
    button.setAttribute('data-x','350');f.owner.document.querySelector('.resume-detail-wrap').append(button);};
  const multiple=canvasExpandFixture();addSecond(multiple);
  const ambiguous=await multiple.owner.api.run('prepare-canvas-expand');
  assert.equal(ambiguous.count,2);assert.equal(ambiguous.token,'');
  for(const mutate of [addSecond,
    f=>f.owner.document.querySelector('#expand').remove(),
    f=>{const button=f.owner.document.querySelector('#expand');button.replaceWith(button.cloneNode(true));},
    f=>{f.owner.document.querySelector('#expand').textContent='查看更多';},
    f=>{f.owner.document.elementFromPoint=()=>f.owner.document.querySelector('#sensitive');},
  ]){
    const f=canvasExpandFixture(),prepared=await f.owner.api.run('prepare-canvas-expand');mutate(f);
    assert.deepEqual({...await f.owner.api.run('click-canvas-expand',{token:prepared.token})},{clicked:false,reason:'controls_changed'});
    assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
    await assert.rejects(f.owner.api.run('click-canvas-expand',{token:prepared.token}),/凭据已失效/);
  }
});

test('Canvas DOM expansion rejects changed roots, frames, documents, canvas nodes and reset sessions',async()=>{
  for(const mutate of [
    f=>{const root=f.owner.document.querySelector('.dialog-lib-resume');root.replaceWith(root.cloneNode(true));},
    f=>{f.frame.src='https://www.zhipin.com/web/frame/c-resume/?fixture=other';},
    f=>{const canvas=f.body.document.querySelector('canvas');canvas.replaceWith(canvas.cloneNode(true));},
    f=>{const replacement=parseHTML('<html><body><canvas></canvas></body></html>').document;f.body.window.document=replacement;},
    f=>f.owner.api.run('reset'),
  ]){
    const f=canvasExpandFixture(),prepared=await f.owner.api.run('prepare-canvas-expand');await mutate(f);
    await assert.rejects(f.owner.api.run('click-canvas-expand',{token:prepared.token}),/已变化|已失效|尚未就绪|框架|范围/);
    assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
  }
});

test('close-current atomically closes one bound online Canvas dialog and refuses replay or body-frame tokens',async()=>{
  const f=canvasExpandFixture({withClose:true}),observed=await f.owner.api.run('current-detail');
  const body=await f.body.api.run('current-detail');
  await assert.rejects(f.body.api.run('close-current',body),/凭据已失效/);
  assert.deepEqual({...await f.owner.api.run('close-current',observed)},{closed:true});
  assert.equal(f.closeClicks(),1);assert.equal(f.owner.document.querySelector('.dialog-lib-resume').hidden,true);
  await assert.rejects(f.owner.api.run('close-current',observed),/凭据已失效/);
  assert.equal(f.closeClicks(),1);assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
});

test('close-current refuses replaced details, blocked or ambiguous close buttons, attachments and unrelated modals',async()=>{
  for(const mutate of [
    f=>{const root=f.owner.document.querySelector('.dialog-lib-resume');root.replaceWith(root.cloneNode(true));},
    f=>{f.frame.src='https://www.zhipin.com/web/frame/c-resume/?fixture=changed';},
    f=>{f.owner.document.elementFromPoint=()=>f.owner.document.querySelector('#outside');},
    f=>{const close=f.owner.document.querySelector('[aria-label="关闭"]');close.after(close.cloneNode(true));},
    f=>{const modal=f.owner.document.createElement('section');modal.setAttribute('role','dialog');f.owner.document.body.append(modal);},
    f=>{const object=f.owner.document.createElement('object');f.owner.document.querySelector('.dialog-lib-resume').append(object);},
  ]){
    const f=canvasExpandFixture({withClose:true}),observed=await f.owner.api.run('current-detail');mutate(f);
    await assert.rejects(f.owner.api.run('close-current',observed),/切换|框架|弹层|附件|按钮|唯一/);
    assert.equal(f.closeClicks(),0);assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
  }
});

test('close-current supports a bound DOM dialog but never infers a close target from a list',async()=>{
  const f=fixture(),list=await f.api.run('scan');
  await assert.rejects(f.api.run('close-current',{kind:'text',token:'unbound',name:'张**'}),/切换/);
  await f.api.run('open',list.cards[0]);
  const observed=await f.api.run('current-detail'),close=f.document.querySelector('[aria-label="关闭"]');
  f.document.elementFromPoint=()=>close;
  assert.deepEqual({...await f.api.run('close-current',observed)},{closed:true});
  assert.equal(f.document.querySelector('[role="dialog"]').hidden,true);
  assert.equal(f.contacts(),0);
});

const framedTextResume='<section class="resume"><h2>张**</h2><p>39岁 本科 10年 离职-随时到岗</p>'+
  '<h3>工作经历</h3><p>合成科技公司，负责设备视觉软件研发、现场调试、相机标定与项目交付。'+
  '参与图像算法和自动化检测系统开发，维护产品功能并开展质量验证。'.repeat(3)+
  '</p><h3>教育经历</h3><p>合成大学 计算机科学 本科</p></section>';

test('a bound text resume iframe atomically closes its exact same-origin parent dialog',async()=>{
  const f=canvasExpandFixture({withClose:true,bodyMarkup:framedTextResume});
  const observed=await f.body.api.run('current-detail');
  assert.equal(observed.kind,'text');assert.equal((await f.owner.api.run('current-detail')).kind,'none');
  assert.deepEqual({...await f.body.api.run('close-current',observed)},{closed:true});
  assert.equal(f.closeClicks(),1);assert.equal(f.owner.document.querySelector('.dialog-lib-resume').hidden,true);
  await assert.rejects(f.body.api.run('close-current',observed),/凭据已失效/);
  assert.equal(f.closeClicks(),1);assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
});

test('text iframe parent close rejects changed embedding identities, attachments, extra modals and obscured controls',async()=>{
  for(const mutate of [
    f=>{const replacement=f.frame.cloneNode(true);Object.defineProperty(replacement,'contentWindow',{value:f.body.window});
      f.frame.replaceWith(replacement);f.body.window.frameElement=replacement;},
    f=>{f.owner.window.location.href+='?switched=1';},
    f=>{f.body.window.location.href+='&switched=1';},
    f=>{const selected=f.body.document.querySelector('.resume');selected.replaceWith(selected.cloneNode(true));},
    f=>{f.body.window.document=parseHTML('<html><body>'+framedTextResume+'</body></html>').document;},
    f=>{f.owner.document.elementFromPoint=()=>f.owner.document.querySelector('#sensitive');},
    f=>{const modal=f.owner.document.createElement('section');modal.setAttribute('role','dialog');f.owner.document.body.append(modal);},
    f=>{const attachment=f.body.document.createElement('iframe');attachment.src='/web/frame/attachment';f.body.document.body.append(attachment);},
  ]){
    const f=canvasExpandFixture({withClose:true,bodyMarkup:framedTextResume});
    const observed=await f.body.api.run('current-detail');mutate(f);
    await assert.rejects(f.body.api.run('close-current',observed),/切换|框架|按钮|弹层|附件/);
    assert.equal(f.closeClicks(),0);assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
  }
});

test('text iframe parent close rechecks binding after resolving the parent close button',async()=>{
  const f=canvasExpandFixture({withClose:true,bodyMarkup:framedTextResume});
  const observed=await f.body.api.run('current-detail'),control=f.owner.document.querySelector('[aria-label="关闭"]');
  f.owner.document.elementFromPoint=()=>{f.owner.window.location.href+='?changed=1';return control;};
  await assert.rejects(f.body.api.run('close-current',observed),/切换|变化/);
  assert.equal(f.closeClicks(),0);
});

test('close-current accepts IPC-reordered binding keys but rejects changed owner or body URLs',async()=>{
  for(const bodyMarkup of ['<canvas></canvas>',framedTextResume]){
    const f=canvasExpandFixture({withClose:true,bodyMarkup}),page=bodyMarkup===framedTextResume?f.body:f.owner;
    const observed=await page.api.run('current-detail');
    const args=JSON.parse(JSON.stringify({...observed,binding:{bodyUrl:observed.binding.bodyUrl,ownerUrl:observed.binding.ownerUrl}}));
    assert.deepEqual({...await page.api.run('close-current',args)},{closed:true});
    assert.equal(f.closeClicks(),1);
    for(const field of ['ownerUrl','bodyUrl']){
      const changed=canvasExpandFixture({withClose:true,bodyMarkup}),target=bodyMarkup===framedTextResume?changed.body:changed.owner;
      const before=await target.api.run('current-detail');
      await assert.rejects(target.api.run('close-current',{
        ...before,binding:{...before.binding,[field]:before.binding[field]+'changed'},
      }),/已切换/);
      assert.equal(changed.closeClicks(),0);
    }
  }
});

function imagePreviewFixture({where='owner',semantic='avatar-preview',hideOnClick=true,bodyMarkup}={}){
  const f=canvasExpandFixture({withClose:true,...(bodyMarkup?{bodyMarkup}:{} )}),page=f[where],document=page.document;
  const preview=document.createElement('div');preview.className=semantic;preview.setAttribute('role','dialog');
  preview.innerHTML='<img alt="头像大图"><button aria-label="关闭">×</button>';
  const root=where==='owner'?document.querySelector('.dialog-lib-resume'):document.body;root.append(preview);
  const control=preview.querySelector('button'),hit=document.elementFromPoint;let closes=0;
  document.elementFromPoint=(x,y)=>{
    const r=control.getBoundingClientRect();
    return !control.closest('[hidden]')&&control.isConnected&&x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom?control:hit(x,y);
  };
  control.addEventListener('click',()=>{closes++;if(hideOnClick)preview.hidden=true;});
  return {...f,page,preview,control,previewCloses:()=>closes};
}

test('preview probe and no-op dismiss ignore a huge background tree without computing full-page text',async()=>{
  const f=canvasExpandFixture(),list=f.owner.document.createElement('main');
  list.innerHTML='<article><span>背景**</span><p>合成列表正文</p></article>'.repeat(10000);
  f.owner.document.body.prepend(list);f.owner.metrics.styleReads=0;
  const D=f.owner.window.__hrmDom,shadow=D.shadow;let visits=0;
  D.shadow=element=>{assert.ok(!list.contains(element));visits++;return shadow(element);};
  D.view=()=>{throw Error('unexpected rendered text traversal');};
  D.elements=()=>{throw Error('unexpected global element traversal');};
  assert.deepEqual({...await f.owner.api.run('probe-image-preview')},{present:false});
  assert.deepEqual({...await f.owner.api.run('dismiss-image-preview',{})},{dismissed:false});
  assert.ok(f.owner.metrics.styleReads<=32);assert.ok(visits<40);
  assert.equal(f.closeClicks(),0);assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
});

test('preview probe only reports visible explicit previews, including accessible shadow roots',async()=>{
  for(const mode of ['light','open','closed']){
    const f=imagePreviewFixture(),host=f.owner.document.createElement('section');
    if(mode!=='light'){
      f.preview.replaceWith(host);const shadow=host.attachShadow({mode});shadow.append(f.preview);
      if(mode==='closed'){
        const original=f.owner.window.__hrmDom.shadow;
        f.owner.window.__hrmDom.shadow=element=>element===host?shadow:original(element);
      }
    }
    assert.deepEqual({...await f.owner.api.run('probe-image-preview')},{present:true});
    assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
    f.preview.hidden=true;
    assert.deepEqual({...await f.owner.api.run('probe-image-preview')},{present:false});
  }
  for(const semantic of ['avatar','popover','avatar-preview-trigger']){
    const f=imagePreviewFixture({semantic});
    assert.deepEqual({...await f.owner.api.run('probe-image-preview')},{present:false});
    assert.equal(f.previewCloses(),0);
  }
});

test('preview probe is bounded, stops on cancellation and refuses non-BOSS pages without clicking',async()=>{
  const huge=canvasExpandFixture();huge.owner.document.body.innerHTML='<i></i>'.repeat(20001);
  assert.deepEqual({...await huge.owner.api.run('probe-image-preview')},{present:false,uncertain:true,reason:'scope'});
  const f=imagePreviewFixture();await f.owner.api.run('stop');
  await assert.rejects(f.owner.api.run('probe-image-preview'),/已停止/);
  await f.owner.api.run('reset');f.owner.window.location.href='https://example.invalid/';
  await assert.rejects(f.owner.api.run('probe-image-preview'),/离开 BOSS/);
  assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
});

test('preview budget never turns a partial scan into a known preview or permits closing',async()=>{
  const f=imagePreviewFixture(),root=f.owner.document.querySelector('.dialog-lib-resume');
  root.insertAdjacentHTML('beforeend','<i></i>'.repeat(5000));
  const D=f.owner.window.__hrmDom;D.view=()=>{throw Error('unexpected identity read');};
  assert.deepEqual({...await f.owner.api.run('probe-image-preview')},{present:false,uncertain:true,reason:'budget'});
  assert.deepEqual({...await f.owner.api.run('dismiss-image-preview',{})},{dismissed:false,uncertain:true,reason:'budget'});
  assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
});

test('preview probes reuse recognized plain and shadow text roots without another global identity read',async()=>{
  for(const layout of ['', 'open-shadow','closed-shadow']){
    const f=fixture({layout}),dialog=f.document.querySelector('[role="dialog"]');
    dialog.hidden=false;dialog.removeAttribute('role');
    assert.equal((await f.api.run('scan')).detail,'张**');
    const D=f.window.__hrmDom;D.view=()=>{throw Error('unexpected global identity read');};
    assert.deepEqual({...await f.api.run('probe-image-preview')},{present:false},layout);
    assert.deepEqual({...await f.api.run('dismiss-image-preview',{})},{dismissed:false},layout);
    dialog.remove();
    assert.deepEqual({...await f.api.run('probe-image-preview')},{present:false,uncertain:true,reason:'scope'});
  }
});

test('recognized long text roots retain the previous twenty-thousand-node preview budget',async()=>{
  // Node-count coverage must not depend on CPU scheduling in a parallel suite.
  const f=fixture({now:()=>0});f.document.querySelector('[role="dialog"]').hidden=false;
  assert.equal((await f.api.run('current-detail')).kind,'text');
  f.document.querySelector('.resume').insertAdjacentHTML('beforeend','<i></i>'.repeat(4500));
  const D=f.window.__hrmDom;D.view=()=>{throw Error('unexpected global identity read');};
  assert.deepEqual({...await f.api.run('probe-image-preview')},{present:false});
});

test('recognized text preview scopes still stop at the time budget below the node limit',async()=>{
  let elapsed=0;
  const f=fixture({now:()=>elapsed}),dialog=f.document.querySelector('[role="dialog"]');
  dialog.hidden=false;
  assert.equal((await f.api.run('current-detail')).kind,'text');
  f.document.querySelector('.resume').insertAdjacentHTML('beforeend','<i></i>'.repeat(200));
  const D=f.window.__hrmDom,shadow=D.shadow;
  D.view=()=>{throw Error('unexpected global identity read');};
  D.shadow=element=>{elapsed+=2;return shadow(element);};
  let closes=0;dialog.querySelector('[aria-label="关闭"]').addEventListener('click',()=>closes++);
  assert.deepEqual({...await f.api.run('probe-image-preview')},{present:false,uncertain:true,reason:'budget'});
  assert.deepEqual({...await f.api.run('dismiss-image-preview',{})},{dismissed:false,uncertain:true,reason:'budget'});
  assert.equal(closes,0);assert.equal(dialog.hidden,false);assert.equal(f.contacts(),0);
});

test('multiple resume scopes and an unbound preview portal remain uncertain without closing',async()=>{
  for(const markup of ['<div class="dialog-lib-resume"></div>','']){
    const f=imagePreviewFixture();
    if(markup)f.owner.document.body.insertAdjacentHTML('beforeend',markup);
    else{f.owner.document.body.append(f.preview);f.owner.document.querySelector('.dialog-lib-resume').remove();}
    assert.deepEqual({...await f.owner.api.run('probe-image-preview')},{present:false,uncertain:true,reason:'scope'});
    assert.deepEqual({...await f.owner.api.run('dismiss-image-preview',{})},{dismissed:false,uncertain:true,reason:'scope'});
    assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
  }
});

test('image preview recovery closes one explicit scoped preview without closing or changing the resume',async()=>{
  for(const semantic of ['avatar-preview','photo-viewer','image-preview','avatar popover','imagePreview']){
    const f=imagePreviewFixture({semantic}),observed=await f.page.api.run('current-detail');
    assert.equal(observed.kind,'canvas-owner');
    assert.deepEqual({...await f.page.api.run('dismiss-image-preview',observed)},{dismissed:true});
    assert.equal(f.previewCloses(),1);assert.equal(f.closeClicks(),0);
    assert.equal((await f.page.api.run('current-detail')).token,observed.token);
    assert.deepEqual({...await f.page.api.run('dismiss-image-preview',observed)},{dismissed:false});
    assert.equal(f.previewCloses(),1);assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
  }
});

test('image preview recovery can target the exact Canvas or text iframe document',async()=>{
  for(const bodyMarkup of ['<canvas></canvas>',framedTextResume]){
    const f=imagePreviewFixture({where:'body',bodyMarkup}),observed=await f.page.api.run('current-detail');
    assert.equal(observed.kind,bodyMarkup===framedTextResume?'text':'canvas-body');
    if(observed.kind==='canvas-body'){
      const owner=await f.owner.api.run('current-detail');
      assert.deepEqual({...await f.owner.api.run('dismiss-image-preview',owner)},{dismissed:false});
      assert.deepEqual({...await f.owner.api.run('dismiss-image-preview',observed)},{dismissed:false});
    }
    assert.deepEqual({...await f.page.api.run('dismiss-image-preview',observed)},{dismissed:true});
    assert.equal(f.previewCloses(),1);assert.equal(f.closeClicks(),0);
    assert.equal((await f.page.api.run('current-detail')).token,observed.token);
  }
});

test('image preview recovery ignores IPC object-key ordering but keeps exact binding values',async()=>{
  const f=imagePreviewFixture(),observed=await f.page.api.run('current-detail');
  const args=JSON.parse(JSON.stringify({...observed,binding:{bodyUrl:observed.binding.bodyUrl,ownerUrl:observed.binding.ownerUrl}}));
  assert.deepEqual({...await f.page.api.run('dismiss-image-preview',args)},{dismissed:true});
  assert.equal(f.previewCloses(),1);assert.equal(f.closeClicks(),0);
  for(const field of ['ownerUrl','bodyUrl']){
    const changed=imagePreviewFixture(),before=await changed.page.api.run('current-detail');
    await assert.rejects(changed.page.api.run('dismiss-image-preview',{
      ...before,binding:{...before.binding,[field]:before.binding[field]+'changed'},
    }),/已切换/);
    assert.equal(changed.previewCloses(),0);
  }
});

test('no-preview recovery probes are no-ops even when optional recovery credentials are stale',async()=>{
  const f=canvasExpandFixture({withClose:true}),observed=await f.owner.api.run('current-detail');
  for(const args of [{},{...observed,token:'stale'},{...observed,name:'另一位'},
    {...observed,binding:{ownerUrl:'stale',bodyUrl:'stale'}}]){
    assert.deepEqual({...await f.owner.api.run('dismiss-image-preview',args)},{dismissed:false});
  }
  assert.equal(f.closeClicks(),0);assert.deepEqual(f.clicks,{owner:0,body:0,outside:0,sensitive:0});
  const hidden=imagePreviewFixture();hidden.preview.hidden=true;
  assert.deepEqual({...await hidden.page.api.run('dismiss-image-preview',{})},{dismissed:false});
  assert.equal(hidden.previewCloses(),0);assert.equal(hidden.closeClicks(),0);
});

test('image preview recovery never infers a target from an avatar, trigger, generic dialog or external portal',async()=>{
  for(const semantic of ['avatar','popover','dialog','avatar-preview-trigger']){
    const f=imagePreviewFixture({semantic}),observed=await f.page.api.run('current-detail');
    assert.deepEqual({...await f.page.api.run('dismiss-image-preview',observed)},{dismissed:false},semantic);
    assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
  }
  const f=imagePreviewFixture();f.owner.document.body.append(f.preview);
  assert.deepEqual({...await f.page.api.run('dismiss-image-preview',await f.page.api.run('current-detail'))},{dismissed:false});
  assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
});

test('image preview recovery refuses ambiguous images, close controls and multiple previews',async()=>{
  for(const mutate of [
    f=>f.preview.append(f.preview.querySelector('img').cloneNode(true)),
    f=>f.preview.append(f.control.cloneNode(true)),
    f=>f.preview.after(f.preview.cloneNode(true)),
    f=>f.preview.querySelector('img').remove(),
    f=>f.control.remove(),
  ]){
    const f=imagePreviewFixture(),observed=await f.page.api.run('current-detail');mutate(f);
    await assert.rejects(f.page.api.run('dismiss-image-preview',observed),/不唯一|多个/);
    assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
  }
});

test('image preview recovery refuses attachment, messaging, verification and other actionable dialogs',async()=>{
  for(const html of ['<iframe src="/attachment"></iframe>','<object></object>','<input>',
    '<textarea></textarea>','<form></form>','<span contenteditable="true"></span>',
    '<p>发送确认</p>','<p>图片验证码</p>','<span class="attachment"></span>',
    '<div role="alertdialog"></div>','<button>下载</button>','<button>下一张</button>']){
    const f=imagePreviewFixture(),observed=await f.page.api.run('current-detail');
    f.preview.insertAdjacentHTML('beforeend',html);
    await assert.rejects(f.page.api.run('dismiss-image-preview',observed),/附件|对话|确认|其它操作/);
    assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
  }
  const f=imagePreviewFixture(),observed=await f.page.api.run('current-detail');
  f.owner.document.body.insertAdjacentHTML('beforeend','<div role="dialog"><p>未知弹窗</p></div>');
  await assert.rejects(f.page.api.run('dismiss-image-preview',observed),/其它弹层/);
  assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
});

test('image preview recovery refuses blocked, disabled and navigation close controls',async()=>{
  for(const mutate of [
    f=>{f.owner.document.elementFromPoint=()=>f.owner.document.querySelector('#sensitive');},
    f=>f.control.setAttribute('disabled',''),
    f=>{f.control.style.pointerEvents='none';},
    f=>{const link=f.owner.document.createElement('a');link.href='/web/chat/index';f.control.replaceWith(link);link.append(f.control);},
  ]){
    const f=imagePreviewFixture(),observed=await f.page.api.run('current-detail');mutate(f);
    await assert.rejects(f.page.api.run('dismiss-image-preview',observed),/遮挡|不可点击|跳转/);
    assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
  }
  const f=imagePreviewFixture({where:'body'}),observed=await f.page.api.run('current-detail');
  f.owner.document.elementFromPoint=()=>f.owner.document.querySelector('#sensitive');
  await assert.rejects(f.page.api.run('dismiss-image-preview',observed),/遮挡|不可点击/);
  assert.equal(f.previewCloses(),0);
});

test('image preview recovery refuses stale candidate, frame, document and URL bindings',async()=>{
  for(const mutate of [
    f=>{const root=f.owner.document.querySelector('.dialog-lib-resume');root.replaceWith(root.cloneNode(true));},
    f=>{const canvas=f.body.document.querySelector('canvas');canvas.replaceWith(canvas.cloneNode(true));},
    f=>{f.frame.src+='&changed=1';},
    f=>{f.owner.window.location.href+='?changed=1';},
    f=>{f.body.window.document=parseHTML('<html><body><canvas></canvas></body></html>').document;},
  ]){
    const f=imagePreviewFixture(),observed=await f.page.api.run('current-detail');mutate(f);
    await assert.rejects(f.page.api.run('dismiss-image-preview',observed),/切换|框架|就绪/);
    assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
  }
});

test('image preview recovery rechecks the bound resume after close hit testing',async()=>{
  const f=imagePreviewFixture(),observed=await f.page.api.run('current-detail');
  f.owner.document.elementFromPoint=()=>{f.owner.window.location.href+='?changed=1';return f.control;};
  await assert.rejects(f.page.api.run('dismiss-image-preview',observed),/切换|变化/);
  assert.equal(f.previewCloses(),0);assert.equal(f.closeClicks(),0);
});

test('image preview recovery only observes after one close and refuses ineffective close replay',async()=>{
  const delayed=imagePreviewFixture({hideOnClick:false}),observed=await delayed.page.api.run('current-detail');
  delayed.control.addEventListener('click',()=>queueMicrotask(()=>queueMicrotask(()=>{delayed.preview.hidden=true;})));
  assert.deepEqual({...await delayed.page.api.run('dismiss-image-preview',observed)},{dismissed:true});
  assert.equal(delayed.previewCloses(),1);assert.equal(delayed.closeClicks(),0);
  const f=imagePreviewFixture({hideOnClick:false}),before=await f.page.api.run('current-detail');
  await assert.rejects(f.page.api.run('dismiss-image-preview',before),/尚未关闭/);
  await assert.rejects(f.page.api.run('dismiss-image-preview',before),/已尝试关闭/);
  assert.equal(f.previewCloses(),1);assert.equal(f.closeClicks(),0);
});

test('image preview recovery does not report success when the resume or preview changed during closing',async()=>{
  for(const mutate of [
    f=>{f.owner.document.querySelector('.dialog-lib-resume').hidden=true;},
    f=>{const next=f.preview.cloneNode(true);next.hidden=false;f.preview.after(next);},
    f=>{f.owner.window.location.href+='?changed=1';},
  ]){
    const f=imagePreviewFixture(),observed=await f.page.api.run('current-detail');
    f.control.addEventListener('click',()=>mutate(f));
    await assert.rejects(f.page.api.run('dismiss-image-preview',observed),/切换|变化|关闭|框架/);
    assert.equal(f.previewCloses(),1);assert.equal(f.closeClicks(),0);
  }
});

test('recognizes dt sections and a name inline with an activity badge',async()=>{
  const f=fixture({layout:'semantic'}),card=(await f.api.run('scan')).cards[0];await f.api.run('open',card);
  const scan=await f.api.run('scan');assert.equal(scan.detail,'张**');assert.ok(scan.diagnostics.sections.includes('工作经历'));
  const result=await f.api.run('read',{name:'张**'});assert.match(result.resume,/展开后补充的项目细节/);assert.equal(f.contacts(),0);
});
for(const layout of ['open-shadow','closed-shadow'])test(`reads and expands a resume across ${layout} boundaries`,async()=>{
  const f=fixture({layout}),card=(await f.api.run('scan')).cards[0];await f.api.run('open',card);
  const scan=await f.api.run('scan');assert.equal(scan.detail,'张**');
  assert.ok(scan.diagnostics[layout==='open-shadow'?'openShadowRoots':'closedShadowRoots']>0);
  const data=await f.api.run('read',{name:'张**'});assert.match(data.resume,/展开后补充的项目细节/);assert.match(data.resume,/滚动加载的证书/);
  const html=await f.api.run('html');assert.match(html.html,/工作经历/);assert.equal(f.contacts(),0);
});
test('joins headings split into character spans without changing their order',async()=>{
  const f=fixture({layout:'split-heading'}),card=(await f.api.run('scan')).cards[0];await f.api.run('open',card);
  assert.equal((await f.api.run('scan')).detail,'张**');
  assert.match((await f.api.run('read',{name:'张**'})).resume,/工作经历/);
});
test('HTML snapshot removes scripts, URLs, form values and hidden content',async()=>{
  const f=fixture({layout:'body'});
  const secret=f.document.createElement('div');secret.innerHTML='<script>localTestSecret</script><input type="hidden" value="localTestSecret"><a href="https://example.com/?token=localTestSecret" onclick="localTestSecret()">可见文本</a><div hidden>localTestSecret</div>';
  f.document.body.append(secret);
  const report=await f.api.run('html');assert.match(report.html,/可见文本/);assert.doesNotMatch(report.html,/localTestSecret|<script|<input|onclick|href=/);
});
test('reads a standalone iframe body with header and resume in separate siblings',async()=>{
  const f=fixture({layout:'body'}),scan=await f.api.run('scan');
  assert.equal(scan.detail,'张**');assert.equal(scan.diagnostics.bodyRoot,true);
  const result=await f.api.run('read',{name:'张**'});assert.match(result.resume,/教育经历/);assert.match(result.resume,/滚动加载的证书/);
});
test('collapses repeated headers inside one resume but rejects separate detail panes',async()=>{
  const f=fixture({layout:'repeated-header'}),card=(await f.api.run('scan')).cards[0];await f.api.run('open',card);
  assert.equal((await f.api.run('scan')).detail,'张**');
  const ambiguous=fixture({layout:'two-details'}),scan=await ambiguous.api.run('scan');
  assert.equal(scan.detail,'');assert.equal(scan.diagnostics.detailRoots,2);
});
test('supports inherited BOSS blank frames and refuses blank frames owned by another site',async()=>{
  const blank={protocol:'about:',hostname:'',origin:'null',pathname:'blank',href:'about:blank',ancestorOrigins:['https://www.zhipin.com']};
  const f=fixture({layout:'body',pageLocation:blank});assert.equal((await f.api.run('scan')).detail,'张**');
  assert.equal(fixture({pageLocation:{...blank,ancestorOrigins:['https://example.com']}}).api,undefined);
});
test('failure diagnostics explain missing identity instead of assuming new-tab navigation',()=>{
  const message=detailFailure([{value:{diagnostics:{sections:['工作经历','期望职位'],nameNodes:0,detailRoots:0}}}]);
  assert.match(message,/已检测到工作经历/);assert.match(message,/未能.*姓名/);assert.doesNotMatch(message,/另开了标签页/);
});
test('the controls recover after a failed permission or detail scan',async()=>{
  const busy=[];await assert.rejects(withBusyState(v=>busy.push(v),async()=>{throw Error('识别失败');}),/识别失败/);
  assert.deepEqual(busy,[true,false]);
});
test('never scores a list as a full resume, wrong person, or an unexpanded detail',async()=>{
  const f=fixture({stuck:true});await assert.rejects(f.api.run('read',{name:'张**'}),/不会把列表摘要/);
  const card=(await f.api.run('scan')).cards[0];await f.api.run('open',card);
  await assert.rejects(f.api.run('read',{name:'李**'}),/未识别/);
  const result=await f.api.run('read',{name:'张**'});assert.equal(result.capture.status,'needs_review');assert.equal(canAutoEvaluate(result),false);
});
test('stops on changed list, cancellation and verification pages without contacting anyone',async()=>{
  const f=fixture(),card=(await f.api.run('scan')).cards[0];
  f.document.querySelector('.card p').textContent='页面已切换';
  await assert.rejects(f.api.run('open',card),/列表已更新/);
  await f.api.run('stop');await assert.rejects(f.api.run('scan'),/已停止/);
  await f.api.run('reset');f.document.body.append('请完成安全验证');await assert.rejects(f.api.run('scan'),/人工验证/);
  assert.equal(f.contacts(),0);
});
test('ambiguous details and non-BOSS domains fail closed',()=>{
  assert.equal(isBoss('https://www.zhipin.com/web/chat/search'),true);
  assert.equal(isBoss('https://www.zhipin.com.evil.example/'),false);
  assert.throws(()=>uniqueDetail([{value:{detail:'张**'}},{value:{detail:'张**'}}]),/多份/);
});
test('crops only the fully visible image in its unique frame chain',()=>{
  const frames=[{frameId:0,value:{key:'outer',width:1200,height:800,children:[{key:'inner',x:100,y:50,width:1000,height:700}]}},
    {frameId:7,value:{key:'inner',width:1000,height:700,children:[]}}];
  assert.deepEqual(screenshotRect(frames,7,{x:50,y:80,width:400,height:350}),{x:150,y:130,width:400,height:350,viewportWidth:1200,viewportHeight:800});
  assert.throws(()=>screenshotRect(frames,7,{x:900,y:80,width:400,height:350}),/未完整/);
  assert.throws(()=>screenshotRect([...frames,{...frames[1],frameId:8}],7,{x:50,y:80,width:400,height:350}),/未完整/);
});

test('a top-page share portal keeps top coordinates while an owner-frame share adds its frame offset',()=>{
  const frames=[{frameId:0,value:{key:'outer',width:1200,height:800,children:[{key:'inner',x:100,y:50,width:1000,height:700}]}},
    {frameId:7,value:{key:'inner',width:1000,height:700,children:[]}}];
  const share={coordinateSpace:'top',frameKey:'outer',name:'张**',rect:{x:50,y:80,width:400,height:350},viewport:{width:1200,height:800}};
  assert.deepEqual(shareScreenshotRect(frames,7,share),{x:50,y:80,width:400,height:350,viewportWidth:1200,viewportHeight:800});
  assert.deepEqual(shareScreenshotRect(frames,7,{...share,coordinateSpace:'owner',frameKey:'inner',viewport:{width:1000,height:700}}),
    {x:150,y:130,width:400,height:350,viewportWidth:1200,viewportHeight:800});
  assert.throws(()=>shareScreenshotRect(frames,7,{...share,frameKey:'another'}),/所在页面已变化/);
  assert.throws(()=>shareScreenshotRect(frames,7,{...share,viewport:{width:1199,height:800}}),/所在页面已变化/);
  assert.throws(()=>shareScreenshotRect(frames,7,{...share,coordinateSpace:'unknown'}),/缺少有效/);
});

test('a share screenshot cannot proceed after identity, coordinate space, rectangle or viewport changes',()=>{
  const share={coordinateSpace:'top',frameKey:'outer',name:'张**',rect:{x:50,y:80,width:400,height:350},viewport:{width:1200,height:800}};
  verifyShareLayout(share,JSON.parse(JSON.stringify(share)));
  for(const changed of [null,{...share,name:'李**'},{...share,coordinateSpace:'owner'},{...share,frameKey:'changed'},
    {...share,rect:{...share.rect,x:51}},{...share,rect:{...share.rect,x:NaN}},
    {...share,viewport:{...share.viewport,width:1199}}]){
    assert.throws(()=>verifyShareLayout(share,changed),/页面或位置已变化/);
  }
});

test('foreground preparation leaves multiple initial expanders untouched across all scroll rounds',async()=>{
  const f=fixture(),first=f.document.querySelector('.expand');
  const clicks=[];
  first.addEventListener('click',()=>clicks.push('first'));
  const second=f.document.createElement('button');
  second.textContent='展开全部';
  second.addEventListener('click',()=>{clicks.push('second');second.remove();});
  f.document.querySelector('.resume').append(second);
  await f.api.run('open',(await f.api.run('scan')).cards[0]);
  const proof=await f.api.run('prepare-copy',{name:'张**'});
  assert.deepEqual(clicks,[]);
  assert.equal(proof.status,'needs_review');
  assert.equal(first.isConnected,true);
  assert.equal(second.isConnected,true);
  assert.equal(f.contacts(),0);
});

test('foreground preparation never spends another expansion click on a late control',async()=>{
  const f=fixture(),first=f.document.querySelector('.expand');
  let clicks=0;
  first.addEventListener('click',()=>{
    clicks++;
    const next=f.document.createElement('button');next.textContent='查看更多';
    next.addEventListener('click',()=>{clicks++;next.remove();});
    f.document.querySelector('.resume').append(next);
  });
  await f.api.run('open',(await f.api.run('scan')).cards[0]);
  const proof=await f.api.run('prepare-copy',{name:'张**'});
  assert.equal(clicks,1);
  assert.equal(proof.status,'needs_review');
});

test('the legacy background DOM reader retains its own expansion policy',async()=>{
  const f=fixture(),first=f.document.querySelector('.expand');
  let clicks=0;
  first.addEventListener('click',()=>clicks++);
  const second=f.document.createElement('button');second.textContent='查看更多';
  second.addEventListener('click',()=>{clicks++;second.remove();});
  f.document.querySelector('.resume').append(second);
  await f.api.run('open',(await f.api.run('scan')).cards[0]);
  const result=await f.api.run('read',{name:'张**'});
  assert.equal(clicks,2);
  assert.equal(result.capture.status,'visible_complete');
});
