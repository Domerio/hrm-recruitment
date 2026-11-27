import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const scripts=['dom-reader.js','automation.js'].map(file=>fs.readFileSync(new URL('../extension/'+file,import.meta.url),'utf8'));
const ownerUrl='https://www.zhipin.com/web/geek/recommend';
const bodyUrl='https://www.zhipin.com/web/frame/c-resume/?fixture=one';
const resume=name=>`<section class="resume"><h2>${name}</h2><p>39岁 本科 10年以上 离职-随时到岗</p><h3>工作经历</h3><p>合成设备有限公司，视觉算法工程师。${'负责工业视觉软件研发、测试验证和现场项目交付。'.repeat(6)}</p><h3>教育经历</h3><p>测试工学院 模具设计与制造 本科</p></section>`;
const list='<article class="geek-info-card"><span class="name-label">背景**</span><p>本科 8年 在职考虑机会</p><p>期望：温州，图像算法。负责工业视觉软件开发和交付，熟悉 C++ 与 OpenCV，设计与维护自动化检测系统。</p><button>联系Ta</button></article>';
const canvasOwner=`<div class="dialog-lib-resume" role="dialog"><div class="resume-detail-wrap"><iframe src="${bodyUrl}"></iframe></div><button>联系Ta</button><button>收藏</button><button aria-label="关闭">×</button></div>`;

function fixture(markup,url=ownerUrl){
  const {document,HTMLElement}=parseHTML('<!doctype html><html><body>'+markup+'</body></html>');
  const actions={clicks:0,scrolls:0};
  Object.defineProperties(HTMLElement.prototype,{
    getClientRects:{configurable:true,value(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];}},
    getBoundingClientRect:{configurable:true,value(){return {x:0,y:0,left:0,top:0,right:1000,bottom:600,width:1000,height:600};}},
    scrollIntoView:{configurable:true,value(){actions.scrolls++;}},
  });
  document.body.addEventListener('click',()=>actions.clicks++);
  const location=new URL(url);Object.defineProperty(document,'location',{configurable:true,value:location});
  const window={document,location,innerWidth:1100,innerHeight:700};window.parent=window;window.top=window;
  const context={window,document,location,URL,innerWidth:1100,innerHeight:700,
    getComputedStyle:element=>({visibility:'visible',display:element.hidden?'none':'block',opacity:'1'}),
    setTimeout:fn=>queueMicrotask(fn),clearTimeout(){}};
  for(const script of scripts)vm.runInNewContext(script,context);
  return {document,window,api:window.__hrmAuto,actions};
}
function pair(){
  const owner=fixture(list+canvasOwner),body=fixture('<canvas></canvas>',bodyUrl);
  const frame=owner.document.querySelector('iframe');
  Object.defineProperty(frame,'contentWindow',{configurable:true,value:body.window});
  body.window.frameElement=frame;body.window.parent=owner.window;body.window.top=owner.window;
  return {owner,body,frame};
}
function chatPair(markup='<canvas></canvas>'){
  const owner=fixture(`<aside class="inline-resume"><iframe src="${bodyUrl}"></iframe></aside>`,'https://www.zhipin.com/web/chat/index');
  const body=fixture(markup,bodyUrl),frame=owner.document.querySelector('iframe');
  Object.defineProperty(frame,'contentWindow',{configurable:true,value:body.window});
  body.window.frameElement=frame;body.window.parent=owner.window;body.window.top=owner.window;
  return {owner,body,frame};
}

test('current-detail returns no identity from the first background list card',async()=>{
  const f=fixture(list),detail=await f.api.run('current-detail');
  assert.equal(detail.kind,'none');assert.equal(detail.name,'');assert.equal(detail.token,'');
  assert.deepEqual(f.actions,{clicks:0,scrolls:0});
});

test('duplicate background names are deduplicated without pairwise containment checks',async()=>{
  const f=fixture(list.repeat(500));let checks=0;
  const contains=f.window.__hrmDom.contains;
  f.window.__hrmDom.contains=(...args)=>{checks++;return contains(...args);};
  assert.equal((await f.api.run('current-detail')).kind,'none');
  assert.ok(checks<5000,`unexpected quadratic containment work: ${checks}`);
  assert.deepEqual(f.actions,{clicks:0,scrolls:0});
});

test('name and heading deduplication retains deepest leaves across light and shadow ancestors',async()=>{
  for(const shadow of [false,true]){
    const markup=resume('张**').replace('<h2>张**</h2>','<h2><span><b>张**</b></span></h2>')
      .replace('<h3>工作经历</h3>','<h3><span>工作经历</span></h3>')
      .replace('<h3>教育经历</h3>','<h3><span>教育经历</span></h3>');
    const f=fixture('<div role="dialog">'+markup+'</div>');
    if(shadow){const header=f.document.querySelector('h2'),child=header.firstElementChild;
      header.attachShadow({mode:'open'}).append(child);}
    const detail=await f.api.run('current-detail'),scan=await f.api.run('scan');
    assert.equal(detail.kind,'text');assert.equal(detail.name,'张**');
    assert.equal(scan.diagnostics.nameNodes,1);assert.equal(scan.diagnostics.detailRoots,1);
    assert.deepEqual([...scan.diagnostics.sections],['工作经历','教育经历']);
  }
});

test('current-detail binds the opened DOM resume and keeps a stable root token',async()=>{
  const f=fixture(list+'<div role="dialog">'+resume('唐汇鑫')+'<button>收藏</button></div>');
  const first=await f.api.run('current-detail'),again=await f.api.run('current-detail');
  assert.equal(first.kind,'text');assert.equal(first.name,'唐汇鑫');assert.ok(first.token);assert.equal(first.token,again.token);
  assert.ok(first.contentKey.includes('合成设备有限公司'));assert.equal(first.contentKey,again.contentKey);
  f.document.querySelector('.resume').replaceWith(f.document.querySelector('.resume').cloneNode(true));
  const replaced=await f.api.run('current-detail');assert.equal(replaced.name,first.name);assert.notEqual(replaced.token,first.token);
  assert.deepEqual(f.actions,{clicks:0,scrolls:0});
});

test('same-name DOM header changes renew the token while expanded body content only changes its content key',async()=>{
  const f=fixture('<div role="dialog">'+resume('张**')+'</div>'),first=await f.api.run('current-detail');
  const root=f.document.querySelector('.resume'),body=root.querySelectorAll('p')[1];
  body.textContent+=' 新展开的算法项目：工业图像定位和缺陷检测。';
  const expanded=await f.api.run('current-detail');
  assert.equal(expanded.token,first.token);assert.notEqual(expanded.contentKey,first.contentKey);
  root.querySelector('p').textContent='40岁 本科 10年以上 离职-随时到岗';
  const changed=await f.api.run('current-detail');assert.equal(changed.name,first.name);assert.notEqual(changed.token,first.token);
  assert.equal((await f.api.run('current-detail')).token,changed.token);
});

test('DOM details without a demographic row still expose an exact normalized content key',async()=>{
  const f=fixture('<div role="dialog">'+resume('张**').replace('<p>39岁 本科 10年以上 离职-随时到岗</p>','')+'</div>');
  const before=await f.api.run('current-detail');assert.equal(before.kind,'text');assert.equal(before.name,'张**');assert.ok(before.contentKey);
  f.document.querySelector('.resume p').append(' 同名同根改写后的工作经历。');
  const after=await f.api.run('current-detail');assert.equal(after.token,before.token);assert.notEqual(after.contentKey,before.contentKey);
  assert.ok(!Object.values((await f.api.run('scan')).diagnostics).includes(after.contentKey));
});

test('current DOM content keys are never truncated into matching fingerprints',async()=>{
  const f=fixture('<div role="dialog">'+resume('张**')+'</div>');
  f.document.querySelector('.resume p').append('正文'.repeat(50001));
  await assert.rejects(f.api.run('current-detail'),/超过校验范围/);
});

test('current-detail rejects multiple DOM details including copies with the same name',async()=>{
  for(const name of ['唐汇鑫','庄天宇']){
    const f=fixture('<div role="dialog">'+resume('唐汇鑫')+'</div><div role="dialog">'+resume(name)+'</div>');
    await assert.rejects(f.api.run('current-detail'),/多份在线简历/);assert.equal(f.actions.clicks,0);
  }
});

test('current-detail refuses hot-search promotion dialogs without dismissing or opening cards',async()=>{
  const f=fixture('<div role="dialog"><h2>热搜牛人 相关推荐</h2>'+list+'<button aria-label="关闭">×</button></div>');
  await assert.rejects(f.api.run('current-detail'),/热搜推荐/);assert.deepEqual(f.actions,{clicks:0,scrolls:0});
});

test('current-detail gives matching canvas owner and body bindings without guessing the background name',async()=>{
  const {owner,body}=pair(),outer=await owner.api.run('current-detail'),inner=await body.api.run('current-detail');
  assert.equal(outer.kind,'canvas-owner');assert.equal(inner.kind,'canvas-body');
  assert.equal(outer.name,'');assert.equal(inner.name,'');assert.deepEqual({...outer.binding},{ownerUrl,bodyUrl});
  assert.deepEqual({...inner.binding},{...outer.binding});assert.equal((await owner.api.run('current-detail')).token,outer.token);
  assert.equal((await body.api.run('current-detail')).token,inner.token);
  body.document.querySelector('canvas').replaceWith(body.document.createElement('canvas'));
  assert.notEqual((await body.api.run('current-detail')).token,inner.token);
  assert.deepEqual(owner.actions,{clicks:0,scrolls:0});assert.deepEqual(body.actions,{clicks:0,scrolls:0});
});

test('same-url iframe replacement changes the canvas owner token',async()=>{
  const {owner,body,frame}=pair(),before=await owner.api.run('current-detail');
  const replacement=frame.cloneNode(true);Object.defineProperty(replacement,'contentWindow',{value:body.window});frame.replaceWith(replacement);
  body.window.frameElement=replacement;
  const after=await owner.api.run('current-detail');assert.notEqual(after.token,before.token);assert.deepEqual({...after.binding},{...before.binding});
});

test('canvas identity discovery rejects unexpected frame URLs, missing owners and duplicate canvases',async()=>{
  const missing=fixture('<canvas></canvas>',bodyUrl);
  await assert.rejects(missing.api.run('current-detail'),/详情窗口/);
  const redirected=pair();redirected.body.window.location=new URL(bodyUrl.replace('one','two'));
  await assert.rejects(redirected.owner.api.run('current-detail'),/已经跳转/);
  const doubled=pair();doubled.body.document.body.append(doubled.body.document.createElement('canvas'));
  await assert.rejects(doubled.body.api.run('current-detail'),/画布或正文框架不唯一/);
  const frames=pair();frames.frame.after(frames.frame.cloneNode(true));
  await assert.rejects(frames.owner.api.run('current-detail'),/正文框架不唯一/);
});

test('multiple canvas owners and mixed DOM/canvas details are rejected',async()=>{
  for(const extra of [canvasOwner,'<div role="dialog">'+resume('唐汇鑫')+'</div>']){
    const f=fixture(canvasOwner+extra);
    await assert.rejects(f.api.run('current-detail'),/多份在线简历/);assert.equal(f.actions.clicks,0);
  }
});

test('a hidden canvas owner is not reported as an opened current resume',async()=>{
  const {owner,body}=pair();owner.document.querySelector('.dialog-lib-resume').hidden=true;
  assert.equal((await owner.api.run('current-detail')).kind,'none');
  assert.equal((await body.api.run('current-detail')).kind,'none');
});

test('chat inline Canvas binds the single official resume iframe without requiring a dialog class',async()=>{
  const {owner,body,frame}=chatPair(),outer=await owner.api.run('current-detail'),inner=await body.api.run('current-detail');
  assert.equal(owner.api.version,46);assert.equal(outer.kind,'canvas-owner');assert.equal(inner.kind,'canvas-body');
  assert.deepEqual({...inner.binding},{...outer.binding});assert.equal(inner.name,'');assert.equal(outer.name,'');
  assert.equal((await owner.api.run('current-detail')).token,outer.token);
  assert.equal((await body.api.run('current-detail')).token,inner.token);
  assert.equal(await owner.api.run('expand-canvas'),true);
  assert.deepEqual(owner.actions,{clicks:0,scrolls:0});assert.deepEqual(body.actions,{clicks:0,scrolls:0});
  const replacement=frame.cloneNode(true);Object.defineProperty(replacement,'contentWindow',{value:body.window});frame.replaceWith(replacement);
  body.window.frameElement=replacement;
  assert.notEqual((await owner.api.run('current-detail')).token,outer.token);
  assert.notEqual((await body.api.run('current-detail')).token,inner.token);
});

test('chat DOM resume in a c-resume iframe is text and exposes only one current identity',async()=>{
  const {owner,body}=chatPair(resume('唐汇鑫'));
  const outer=await owner.api.run('current-detail'),inner=await body.api.run('current-detail');
  assert.equal(outer.kind,'none');assert.equal(inner.kind,'text');assert.equal(inner.name,'唐汇鑫');
  assert.ok(inner.contentKey.includes('合成设备有限公司'));assert.equal(inner.binding.ownerUrl,'https://www.zhipin.com/web/chat/index');
  const before=inner.token,frame=body.window.frameElement,replacement=frame.cloneNode(true);
  Object.defineProperty(replacement,'contentWindow',{value:body.window});frame.replaceWith(replacement);body.window.frameElement=replacement;
  assert.notEqual((await body.api.run('current-detail')).token,before);
  assert.deepEqual(owner.actions,{clicks:0,scrolls:0});assert.deepEqual(body.actions,{clicks:0,scrolls:0});
});

test('inline Canvas identity can use its unique DOM header and renews on header or canvas replacement',async()=>{
  const {owner,body}=chatPair('<h2>张**</h2><p>39岁 本科 10年以上 离职-随时到岗</p><canvas></canvas>');
  const first=await body.api.run('current-detail'),outer=await owner.api.run('current-detail');
  assert.equal(first.name,'张**');assert.equal(outer.name,'张**');
  body.document.querySelector('p').textContent='40岁 本科 10年以上 离职-随时到岗';
  assert.notEqual((await body.api.run('current-detail')).token,first.token);
  assert.notEqual((await owner.api.run('current-detail')).token,outer.token);
  const before=await owner.api.run('current-detail');
  body.document.querySelector('canvas').replaceWith(body.document.createElement('canvas'));
  assert.notEqual((await owner.api.run('current-detail')).token,before.token);
});

test('inline resume hides and duplicate or redirected iframes stop both owner and body discovery',async()=>{
  const hidden=chatPair();hidden.frame.hidden=true;
  assert.equal((await hidden.owner.api.run('current-detail')).kind,'none');
  assert.equal((await hidden.body.api.run('current-detail')).kind,'none');
  const duplicate=chatPair();duplicate.frame.after(duplicate.frame.cloneNode(true));
  await assert.rejects(duplicate.owner.api.run('current-detail'),/正文框架不唯一/);
  await assert.rejects(duplicate.body.api.run('current-detail'),/正文框架不唯一/);
  const redirected=chatPair();redirected.body.window.location=new URL(bodyUrl.replace('one','two'));
  await assert.rejects(redirected.owner.api.run('current-detail'),/已经跳转/);
  await assert.rejects(redirected.body.api.run('current-detail'),/已经跳转/);
});

test('inline and top-level resumes or mixed legacy owners never select an arbitrary candidate',async()=>{
  const mixed=chatPair();mixed.owner.document.body.append(mixed.owner.document.createElement('div'));
  mixed.owner.document.body.lastElementChild.innerHTML=resume('唐汇鑫');
  await assert.rejects(mixed.owner.api.run('current-detail'),/多份在线简历/);
  const legacy=chatPair();legacy.owner.document.body.append(legacy.owner.document.createElement('div'));
  legacy.owner.document.body.lastElementChild.innerHTML=canvasOwner;
  await assert.rejects(legacy.owner.api.run('current-detail'),/正文框架不唯一/);
  const foreign=chatPair();foreign.frame.setAttribute('src','https://zhipin.com/web/frame/c-resume/?fixture=one');
  await assert.rejects(foreign.owner.api.run('current-detail'),/同源/);
  assert.deepEqual(mixed.owner.actions,{clicks:0,scrolls:0});
});

test('same-name or different-name parent DOM resumes conflict with a text resume iframe',async()=>{
  for(const parentName of ['唐汇鑫','庄天宇']){
    const {owner,body}=chatPair(resume('唐汇鑫'));
    const parentResume=owner.document.createElement('div');parentResume.innerHTML=resume(parentName);owner.document.body.append(parentResume);
    await assert.rejects(owner.api.run('current-detail'),/多份在线简历/);
    await assert.rejects(body.api.run('current-detail'),/多份在线简历/);
    assert.deepEqual(owner.actions,{clicks:0,scrolls:0});assert.deepEqual(body.actions,{clicks:0,scrolls:0});
  }
});

test('text iframe identity includes its embedding page URL and refuses a stale contentWindow',async()=>{
  const {owner,body,frame}=chatPair(resume('唐汇鑫')),before=await body.api.run('current-detail');
  Object.defineProperty(owner.document,'location',{value:new URL('https://www.zhipin.com/web/chat/index?conversation=changed')});
  const changed=await body.api.run('current-detail');assert.notEqual(changed.token,before.token);
  assert.equal(changed.binding.ownerUrl,'https://www.zhipin.com/web/chat/index?conversation=changed');
  const replacement=fixture(resume('庄天宇'),bodyUrl);
  replacement.window.frameElement=frame;replacement.window.parent=owner.window;replacement.window.top=owner.window;
  Object.defineProperty(frame,'contentWindow',{value:replacement.window});
  await assert.rejects(body.api.run('current-detail'),/正文框架已经切换/);
});
