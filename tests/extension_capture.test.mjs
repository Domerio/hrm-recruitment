import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {isBoss,uniqueDetail,screenshotRect,canAutoEvaluate,detailFailure,withBusyState,resumeSections,resumeFoldLabels,isResumeFoldLabel} from '../extension/capture-utils.mjs';

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

function fixture({stuck=false,layout='',pageLocation=null}={}){
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
  const context={window,document,URL,location:pageLocation||{protocol:'https:',hostname:'www.zhipin.com',origin:'https://www.zhipin.com',pathname:'/test'},innerWidth:1200,innerHeight:800,
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
