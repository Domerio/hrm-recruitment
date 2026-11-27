import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const sources=['dom-reader.js','automation.js'].map(file=>fs.readFileSync(new URL('../extension/'+file,import.meta.url),'utf8'));
const recommend=(name='唐汇鑫',extras='')=>`<article class="recommend-item"><div class="candidate-header"><h3 class="geek-name"><span class="person">${name}</span><small>刚刚活跃</small></h3><p>39岁 | 本科 | 10年以上 | 离职-随时到岗</p></div><p>期望 东莞 · 自动化工程师</p><p>优势 具有视觉检测软件开发与现场交付经验，熟悉 C#、OpenCV 与工业相机。</p><aside><p>2018.03 - 至今 永利 · 工程师</p><p>2005 - 2009 测试工学院 · 模具设计 · 本科</p></aside>${extras}<button class="contact">打招呼</button></article>`;
const search=(name='郑**',badge='热搜')=>`<article class="geek-info-card"><span class="name-label person">${name}</span><small>${badge}</small><p>本科 · 10年 · 在职考虑机会</p><p>期望：温州，图像算法。熟悉工业视觉检测软件和图像处理项目交付，负责系统集成和生产线部署。</p><button class="contact">联系Ta</button></article>`;
const promoted=()=>`<section class="campaign"><header><h3>热搜牛人推荐</h3><a class="more" href="#">查看更多</a></header>${search('穆**','热搜 首页推荐')}<p>推荐理由 该牛人正在关注贵公司的职位</p></section>`;
const promotionModal=(attrs='role="dialog"')=>`<section ${attrs} class="recommend-modal"><header><h2>热搜牛人 相关推荐</h2><button class="close" aria-label="关闭">×</button></header>${search('穆**')}${search('郑**')}</section>`;
function fixture(markup){
  const {window}=parseHTML('<!doctype html><html><body><main>'+markup+'</main></body></html>'),{document,HTMLElement}=window;
  for(const key of ['__hrmAuto','__hrmDom','top','parent','frameElement'])delete window[key];
  const clicks=[];
  Object.defineProperties(HTMLElement.prototype,{
    getClientRects:{configurable:true,value(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];}},
    getBoundingClientRect:{configurable:true,value(){return this.matches('.close')?
      {x:960,y:10,left:960,top:10,right:980,bottom:30,width:20,height:20}:
      {x:0,y:0,left:0,top:0,right:1000,bottom:600,width:1000,height:600};}},
    scrollIntoView:{configurable:true,value(){}},
  });
  document.body.addEventListener('click',event=>clicks.push(event.target));
  document.querySelectorAll('.close').forEach(button=>button.addEventListener('click',()=>{button.closest('section').hidden=true;}));
  const context={window,document,URL,location:{protocol:'https:',hostname:'www.zhipin.com',origin:'https://www.zhipin.com',pathname:'/web/geek/recommend'},
    innerWidth:1100,innerHeight:700,getComputedStyle:node=>({visibility:'visible',display:node.hidden?'none':'block',
      opacity:'1',overflowY:node.style?.overflowY||'visible',position:'static',pointerEvents:'auto'}),
    setTimeout:fn=>{queueMicrotask(fn);return 1;},clearTimeout(){}};
  for(const source of sources)vm.runInNewContext(source,context);
  return {api:window.__hrmAuto,document,window,clicks};
}

const recommendationCard=(name,detail='工业视觉检测软件开发与设备调试交付，熟悉机器视觉算法和生产线应用。')=>
  `<li class="card-item"><div class="candidate-card-wrap"><div class="card-inner common-wrap">
    <div class="col-1"><span class="salary-wrap">20-28K</span></div><div class="col-2">
      <div class="row name-wrap"><span class="name">${name}</span><span class="active-text">刚刚活跃</span></div>
      <div class="row"><div class="join-text-wrap base-info"><span>39岁</span><span>10年以上</span><span>本科</span><span>离职-随时到岗</span></div></div>
      <div class="row row-flex expect-wrap"><span>期望</span><span>东莞 · 自动化工程师</span></div>
      <div class="row row-flex geek-desc"><span>优势</span><span>${detail}</span></div>
    </div><div class="col-3"><div class="timeline-wrap work-exps">2018.03 - 至今 示例公司 · 工程师</div>
      <div class="timeline-wrap edu-exps">2005 - 2009 示例学院 · 模具设计 · 本科</div></div></div>
    <div class="operate-side"><button class="btn-greet">打招呼</button></div></div></li>`;
const recommendationPromo=()=>`<li class="card-item"><div class="candidate-card-wrap anonymous-geek-guide-card">
  <div class="card-title"><span class="title">热搜牛人推荐</span></div>
  <div class="common-wrap"><div class="name-wrap"><span class="name">推广牛人</span></div>
  <div class="base-info">30岁 5年 硕士 离职-随时到岗</div><div class="geek-desc">首页推荐视觉算法工程师</div>
  <div class="rcd-reason">推荐理由</div></div></div></li>`;

test('recommendation IDs come only from each own card-inner and encrypted values never become card indexes',async()=>{
  const withId=(name,attrs)=>recommendationCard(name).replace('class="card-inner common-wrap"','class="card-inner common-wrap" '+attrs);
  const f=fixture('<div data-geek="unrelated-parent">'+withId('王明轩','data-geek="enc-first" data-geekid="enc-first"')+
    withId('李晓宁','data-geek="enc-second"')+withId('赵承远','data-geek="enc-third" data-geekid="different"')+
    recommendationCard('钱新宇')+search()+'</div>');
  const cards=(await f.api.run('scan')).cards;
  assert.deepEqual(Array.from(cards,card=>card.platform_geek_id),['enc-first','enc-second','','',undefined]);
  assert.deepEqual(Array.from(cards,card=>card.kind),['recommendation','recommendation','recommendation','recommendation',undefined]);
  assert.deepEqual(Array.from(cards,card=>card.id),['0','1','2','3','4']);
  for(const card of cards)await f.api.run('open',card);
  assert.equal(f.clicks.length,5);assert.ok(f.clicks.every(node=>!node.closest('.operate-side,.contact')));
});

test('same-text recommendation identity mutation is rejected before clicking its name',async()=>{
  const f=fixture(recommendationCard('王明轩').replace('class="card-inner common-wrap"','class="card-inner common-wrap" data-geek="enc-first"'));
  const card=(await f.api.run('scan')).cards[0];
  f.document.querySelector('.card-inner').setAttribute('data-geek','enc-replacement');
  await assert.rejects(f.api.run('open',card),/身份已变化/);assert.equal(f.clicks.length,0);
  await f.api.run('scan');
  await assert.rejects(f.api.run('open',card),/身份已变化/);assert.equal(f.clicks.length,0);
});

test('recommendation-page cards advance through ordinary resumes and skip the hot-search guide',async()=>{
  const f=fixture(`<div class="recommend-list-wrap"><div id="recommend-list"><div class="list-body" style="overflow-y:auto">
    <ul class="card-list">${recommendationCard('王明轩')}${recommendationPromo()}${recommendationCard('李晓宁')}${recommendationCard('SmithJones')}</ul>
    </div></div></div><section role="dialog" hidden><div class="resume-left">
    <header><h2 class="geek-name">王明轩</h2><p>39岁 本科 10年以上 离职-随时到岗</p></header>
    <h3>工作经历</h3><p>示例公司，工程师。负责视觉算法设计、设备开发和现场调试，完成生产线交付。参与视觉检测软件的长期维护、项目验收、算法优化，并协调机械和电气团队完成设备交付。</p>
    <h3>教育经历</h3><p>示例学院，模具设计与制造，本科。</p></div><button class="close" aria-label="关闭">×</button></section>`);
  const list=f.document.querySelector('.list-body'),modal=f.document.querySelector('[role="dialog"]');
  Object.defineProperties(list,{clientHeight:{value:400},scrollHeight:{value:1000},scrollTop:{value:0,writable:true}});
  const names=f.document.querySelectorAll('.card-list > .card-item:not(:has(.anonymous-geek-guide-card)) .name-wrap .name');
  names.forEach(label=>label.addEventListener('click',()=>{
    modal.querySelector('.geek-name').textContent=label.textContent;modal.hidden=false;
  }));
  let greetings=0;f.document.querySelectorAll('.btn-greet').forEach(button=>button.addEventListener('click',()=>greetings++));
  let scan=await f.api.run('scan');
  assert.deepEqual(Array.from(scan.cards,card=>card.name),['王明轩','李晓宁','SmithJones']);
  assert.equal(scan.ignoredPromotions,1);
  await f.api.run('open',scan.cards[0]);
  const openScan=await f.api.run('scan');
  assert.equal(openScan.detail,'王明轩',JSON.stringify(openScan.diagnostics));
  await f.api.run('close',{name:'王明轩',kind:'text'});
  scan=await f.api.run('scan');
  assert.deepEqual(Array.from(scan.cards,card=>card.name),['王明轩','李晓宁','SmithJones']);
  await f.api.run('open',scan.cards[1]);
  assert.equal((await f.api.run('scan')).detail,'李晓宁');
  await f.api.run('close',{name:'李晓宁',kind:'text'});
  scan=await f.api.run('scan');
  await f.api.run('open',scan.cards[2]);
  assert.equal((await f.api.run('scan')).detail,'SmithJones');
  await f.api.run('close',{name:'SmithJones',kind:'text'});
  assert.deepEqual({...await f.api.run('advance-list')},{kind:'scroll',moved:true});
  assert.equal(list.scrollTop,300);
  list.scrollTop=600;
  assert.deepEqual({...await f.api.run('advance-list')},{kind:'waiting',moved:false});
  list.querySelector('.card-list').insertAdjacentHTML('beforeend',recommendationCard('赵承远'));
  assert.deepEqual(Array.from((await f.api.run('scan')).cards,card=>card.name),['王明轩','李晓宁','SmithJones','赵承远']);
  assert.equal(greetings,0);
  assert.ok(f.clicks.every(node=>!node.closest('.operate-side,.anonymous-geek-guide-card')));
});

test('Latin names require a unique recommendation card and a bound matching detail header',async()=>{
  const f=fixture(`<h2 class="geek-name">SmithJones</h2><p>39岁 本科 10年以上 离职-随时到岗</p>
    <div class="recommend-list-wrap"><div class="list-body"><ul class="card-list">
      ${recommendationCard('SmithJones')}
      ${recommendationCard('DoubleAge').replace('<span>39岁</span>','<span>39岁 38岁</span>')}
      ${recommendationCard('DoubleRow').replace('</div></div>\n      <div class="row row-flex expect-wrap">',
        '</div><div class="base-info">38岁 9年 本科 在职</div></div>\n      <div class="row row-flex expect-wrap">')}
      ${recommendationPromo()}</ul></div></div></div>
    <section role="dialog" hidden><div class="resume-left"><header>
      <h2 class="geek-name">OtherName</h2><p>39岁 本科 10年以上 离职-随时到岗</p></header>
      <h3>工作经历</h3><p>示例公司任职工程师，负责视觉检测软件的研发和交付，参与生产线调试、项目验收及质量保障，持续优化设备算法。参与跨团队方案设计、代码维护和测试验证，记录并解决现场部署中发现的问题。</p>
      <h3>教育经历</h3><p>示例学院，模具设计与制造，本科。</p></div><button class="close" aria-label="关闭">×</button></section>`);
  const modal=f.document.querySelector('[role="dialog"]');
  assert.deepEqual(Array.from((await f.api.run('scan')).cards,card=>card.name),['SmithJones']);
  f.document.querySelector('.card-item .name-wrap .name').addEventListener('click',()=>{modal.hidden=false;});
  const [card]=(await f.api.run('scan')).cards;await f.api.run('open',card);
  assert.equal((await f.api.run('scan')).detail,'','a different Latin detail cannot inherit the list identity');
  modal.querySelector('.geek-name').textContent='SmithJones';
  const validDetail=await f.api.run('scan');
  assert.equal(validDetail.detail,'SmithJones',JSON.stringify(validDetail.diagnostics));
  modal.querySelector('header p').textContent='39岁 38岁 本科 10年以上 离职-随时到岗';
  assert.match(modal.querySelector('header p').textContent,/39岁 38岁/);
  const duplicateDetail=await f.api.run('scan');
  const detailView=f.window.__hrmDom.view(modal);
  assert.equal(duplicateDetail.detail,'',JSON.stringify({diagnostics:duplicateDetail.diagnostics,
    header:detailView.texts.get(modal.querySelector('header')),row:detailView.texts.get(modal.querySelector('header p'))}));
  assert.ok(f.clicks.every(node=>!node.closest('.operate-side,.anonymous-geek-guide-card')));
});

test('a Latin detail in another frame needs the exact name bound from its list card',async()=>{
  const list=fixture(`<ul class="card-list">${recommendationCard('SmithJones')}${recommendationPromo()}</ul>`);
  const [card]=(await list.api.run('scan')).cards;
  assert.equal(card.name,'SmithJones');
  await list.api.run('open',card);
  const detail=fixture(`<section role="dialog"><div class="resume-left"><header>
    <h2 class="geek-name">SmithJones</h2><p>39岁 本科 10年以上 离职-随时到岗</p></header>
    <h3>工作经历</h3><p>示例公司工程师，负责视觉检测软件的研发和交付，参与设备调试、项目验收和代码维护，持续改进系统稳定性及检测精度。</p>
    <h3>教育经历</h3><p>示例学院，模具设计与制造，本科，完成多项工业自动化课程及项目实践。</p>
    </div><button class="close" aria-label="关闭">×</button></section>`);
  assert.equal((await detail.api.run('scan')).detail,'');
  assert.equal((await detail.api.run('scan',{expectedName:'OtherName'})).detail,'');
  assert.equal((await detail.api.run('scan',{expectedName:card.name})).detail,card.name);
  const bound=await detail.api.run('current-detail');
  assert.equal(bound.kind,'text');assert.equal(bound.name,card.name);
  assert.equal((await detail.api.run('scan',{expectedName:''})).detail,'');
  assert.equal(detail.clicks.length,0);
  assert.ok(list.clicks.every(node=>!node.closest('.operate-side,.anonymous-geek-guide-card')));
});

test('recommendation full names and search masked names are detected together without a mode selection',async()=>{
  const f=fixture(recommend()+search()+recommend('庄天宇'));
  const scan=await f.api.run('scan');
  assert.deepEqual(Array.from(scan.cards,card=>card.name),['唐汇鑫','郑**','庄天宇']);
  assert.equal(scan.promotionBlocked,false);
  for(const card of scan.cards)await f.api.run('open',card);
  assert.deepEqual(f.clicks.map(node=>node.textContent),['唐汇鑫','郑**','庄天宇']);
  assert.ok(f.clicks.every(node=>!node.closest('.contact')));
});

test('unmasked names need their own demographic header rather than arbitrary short page text',async()=>{
  const f=fixture('<h2>推荐牛人</h2><span class="name-label">任意姓名</span><p>图像算法</p>'+recommend('唐汇鑫','<p>普通文本 苏州市</p>'));
  assert.deepEqual(Array.from((await f.api.run('scan')).cards,card=>card.name),['唐汇鑫']);
  const header=f.document.querySelector('.candidate-header p');header.textContent='本科 · 当前职位';
  assert.equal((await f.api.run('scan')).cards.length,0);
});

test('inline activity and online badges do not become part of a full name',async()=>{
  for(const badge of ['刚刚活跃','今日活跃','在线','热搜刚刚活跃']){
    const f=fixture(recommend().replace('<span class="person">唐汇鑫</span><small>刚刚活跃</small>',`<span class="person">唐汇鑫${badge}</span>`));
    assert.equal((await f.api.run('scan')).cards[0]?.name,'唐汇鑫');
  }
});

test('full-name details bind to their demographic identity and never use the timeline sidebar as another person',async()=>{
  const f=fixture(`<section role="dialog"><div class="resume-left"><header><h2>唐汇鑫 <small>刚刚活跃</small></h2><p>39岁 本科 10年以上 离职-随时到岗</p></header><section><h3>个人优势</h3><p>具有工业机器视觉软件研发经验。</p><h3>工作经历</h3><p>合成设备有限公司，工程师。负责算法设计、程序开发、图像检测与现场调试交付，配合机械、电气团队完成整机验收，维护软件模块和生产工艺。</p><h3>教育经历</h3><p>测试工学院 模具设计与制造 本科</p></section></div><aside><p>经历概览</p><p>永利 · 工程师 2018 - 至今</p></aside><button class="contact">打招呼</button></section>`);
  const scan=await f.api.run('scan');
  assert.equal(scan.detail,'唐汇鑫');assert.equal(scan.cards.length,0);assert.equal(scan.diagnostics.detailRoots,1);
  const html=await f.api.run('html');
  assert.equal(html.scope,'detail');assert.match(html.html,/合成设备有限公司/);assert.doesNotMatch(html.html,/经历概览|永利/);
  const left=f.document.querySelector('.resume-left');
  Object.defineProperties(left,{clientHeight:{value:500},scrollHeight:{value:500},scrollTop:{value:0,writable:true}});
  Object.defineProperty(f.document,'scrollingElement',{value:left,configurable:true});
  const read=await f.api.run('read',{name:'唐汇鑫'});
  assert.equal(read.capture.status,'visible_complete');assert.match(read.resume,/合成设备有限公司/);assert.doesNotMatch(read.resume,/经历概览|永利/);
  // Without a separate left pane, the full dialog is not a safe body boundary.
  left.before(...left.childNodes);left.remove();
  assert.equal((await f.api.run('scan')).detail,'');
  assert.equal((await f.api.run('html')).scope,'page');
  await assert.rejects(f.api.run('read',{name:'唐汇鑫'}),/唯一的在线简历详情/);
  assert.equal(f.clicks.length,0);
});

test('inline hot-search campaign cards are ignored while ordinary hot badges remain eligible',async()=>{
  const f=fixture(recommend('钟名豪')+promoted()+recommend('张科')+search());
  const scan=await f.api.run('scan');
  assert.deepEqual(Array.from(scan.cards,card=>card.name),['钟名豪','张科','郑**']);
  assert.equal(scan.ignoredPromotions,1);assert.equal(scan.promotionBlocked,false);
  for(const card of scan.cards)await f.api.run('open',card);
  assert.ok(f.clicks.every(node=>!node.closest('.campaign')));
});

test('a stale regular card moved into a hot-search campaign cannot be opened',async()=>{
  const f=fixture(recommend()+promoted()),[card]=(await f.api.run('scan')).cards;
  f.document.querySelector('.campaign').append(f.document.querySelector('.recommend-item'));
  await assert.rejects(f.api.run('open',card),/列表已更新|热搜推荐区域/);assert.equal(f.clicks.length,0);
});

test('hot-search recommendation modal suppresses all cards and closes only its own unique close control',async()=>{
  const f=fixture(recommend()+promotionModal()),scan=await f.api.run('scan');
  assert.equal(scan.promotionBlocked,true);assert.equal(scan.cards.length,0);assert.equal(scan.detail,'');
  assert.deepEqual({...await f.api.run('dismiss-promotions')},{dismissed:1});
  assert.deepEqual(Array.from((await f.api.run('scan')).cards,card=>card.name),['唐汇鑫']);
  assert.equal(f.clicks.length,1);assert.ok(f.clicks[0].matches('.close'));
});

test('a promotion modal appearing after a list scan blocks the old name click',async()=>{
  const f=fixture(recommend()),[card]=(await f.api.run('scan')).cards;
  f.document.querySelector('main').insertAdjacentHTML('beforeend',promotionModal());
  await assert.rejects(f.api.run('open',card),/热搜推荐/);assert.equal(f.clicks.length,0);
});

test('promotion dismissal rejects missing, duplicate, navigational or obscured close controls',async()=>{
  for(const change of [f=>f.document.querySelector('.close').remove(),
    f=>f.document.querySelector('.close').after(f.document.querySelector('.close').cloneNode(true)),
    f=>f.document.querySelector('.close').outerHTML='<a class="close" aria-label="关闭" href="https://www.zhipin.com/web/chat">×</a>',
    f=>{f.document.elementFromPoint=()=>f.document.body;}]){
    const f=fixture(promotionModal());change(f);
    await assert.rejects(f.api.run('dismiss-promotions'),/关闭|跳转|入口/);assert.equal(f.clicks.length,0);
  }
});

test('multiple hot-search modals and ordinary dialogs never trigger an arbitrary close',async()=>{
  const f=fixture(promotionModal()+promotionModal());
  await assert.rejects(f.api.run('dismiss-promotions'),/范围不唯一/);assert.equal(f.clicks.length,0);
  const ordinary=fixture('<section role="dialog"><h2>普通候选人</h2><button class="close" aria-label="关闭">×</button>'+search()+'</section>');
  assert.deepEqual({...await ordinary.api.run('dismiss-promotions')},{dismissed:0});assert.equal(ordinary.clicks.length,0);
});

test('a class-only modal binds the panel rather than its dialog-header and dismisses safely',async()=>{
  const f=fixture(recommend()+promotionModal('').replace('<header><h2>','<header class="dialog-header"><h2>'));
  assert.equal((await f.api.run('scan')).promotionBlocked,true);
  assert.deepEqual({...await f.api.run('dismiss-promotions')},{dismissed:1});
  assert.equal(f.clicks.length,1);assert.ok(f.clicks[0].matches('.close'));
  assert.deepEqual(Array.from((await f.api.run('scan')).cards,card=>card.name),['唐汇鑫']);
});

test('a layout wrapper cannot absorb campaign text into the surviving normal candidate summary',async()=>{
  const f=fixture('<section class="geek-info-card">'+search()+promoted()+'</section>');
  const [card]=(await f.api.run('scan')).cards;
  assert.equal((await f.api.run('scan')).cards.length,1);
  assert.doesNotMatch(card.signature,/穆|热搜牛人推荐|推荐理由/);
});

test('a flat inline campaign heading excludes only its following card instead of the shared list',async()=>{
  for(const wrapper of ['main','section','div']){
    const f=fixture(`<${wrapper}>${recommend('钟名豪')}<header><h3>热搜牛人推荐</h3><a href="#">查看更多</a></header>${search('穆**','热搜 首页推荐')}${recommend('张科')}</${wrapper}>`);
    const scan=await f.api.run('scan');
    assert.deepEqual(Array.from(scan.cards,card=>card.name),['钟名豪','张科']);assert.equal(scan.ignoredPromotions,1);
    for(const card of scan.cards)await f.api.run('open',card);
    assert.deepEqual(f.clicks.map(node=>node.textContent),['钟名豪','张科']);
  }
});

test('a heading before mixed flat cards does not absorb later ordinary candidates',async()=>{
  const f=fixture('<div><h3>热搜牛人推荐</h3>'+search('穆**','首页推荐')+recommend('张科')+'</div>');
  assert.deepEqual(Array.from((await f.api.run('scan')).cards,card=>card.name),['张科']);
});

test('promotion-looking words in ordinary prose do not create a promotion scope',async()=>{
  const f=fixture(recommend('唐汇鑫','<p>参与热搜牛人推荐相关产品的视觉研发。</p>')+search());
  const scan=await f.api.run('scan');assert.equal(scan.ignoredPromotions,0);
  assert.deepEqual(Array.from(scan.cards,card=>card.name),['唐汇鑫','郑**']);
});
