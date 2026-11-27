import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {favoriteLocatorAction} from '../extension/favorite-locator.mjs';

const target = {id:135,job_id:1,name:'项**',boss_chat_uid:'',platform_geek_id:'',anchors:[
  {kind:'company',text:'浙江测试智能科技有限公司'}, {kind:'school',text:'河南测试大学'},
],evidence:[{kind:'work',organization:'浙江测试智能科技有限公司',period:'2024.04-2026.11'}]};
const decision = (card,overrides={}) => favoriteLocatorAction({action:'match',target:{...target,...overrides},card});
const cardHTML = (id='encrypted_a',extra='') => `<div class="geek-info-card" data-geek="${id}">
  <span class="name-label">项**</span><div class="timeline-item"><span class="company">浙江测试智能科技有限公司</span>
  <span>2024.04-2026.11</span></div><span>河南测试大学</span>${extra}
  <button class="contact">联系Ta</button><button aria-label="取消收藏">取消收藏</button></div>`;

function fixture({html=cardHTML(),active='收藏牛人',href='https://www.zhipin.com/web/frame/recommend/interaction'}={}) {
  const {document} = parseHTML(`<html><body><nav><span class="tab ${active==='收藏牛人'?'active':''}">收藏牛人</span>
    <span class="tab ${active==='沟通过'?'active':''}">沟通过</span></nav><main>${html}</main></body></html>`);
  const bounds = node => {
    node.getBoundingClientRect=()=>({left:10,top:10,right:110,bottom:40,width:100,height:30});
    node.scrollIntoView=()=>{};
  };
  for (const node of document.querySelectorAll('*')) bounds(node);
  let clicks=0,forbidden=0;
  const no=()=>{forbidden++;throw Error('secret=private-api-value');};
  for (const label of document.querySelectorAll('.name-label')) label.click=()=>{clicks++;};
  for (const button of document.querySelectorAll('button')) button.click=no;
  document.elementFromPoint=()=>document.querySelector('.name-label');
  Object.defineProperty(document,'scrollingElement',{value:document.documentElement});
  Object.defineProperties(document.documentElement,{scrollHeight:{value:1600,configurable:true},clientHeight:{value:600,configurable:true}});
  document.documentElement.scrollTop=0;
  const win={document,location:{href,origin:new URL(href).origin},_PAGE:{uid:'12345'}};win.top=win;win.parent=win;
  const context=vm.createContext({document,window:win,location:win.location,URL,TextEncoder,crypto:webcrypto,
    MutationObserver:document.defaultView.MutationObserver,
    getComputedStyle:node=>({display:node.style.display||'block',visibility:node.style.visibility||'visible',opacity:node.style.opacity||'1',overflowY:'visible'}),
    fetch:no,XMLHttpRequest:no,WebSocket:no});
  async function run(action,extra={}) {
    context.args={action,target,...extra};
    const result=await vm.runInContext(`(${favoriteLocatorAction.toString()})(args)`,context);
    assert.equal(forbidden,0);
    return JSON.parse(JSON.stringify(result));
  }
  function detail({uid='45678',id='encrypted_a',name='项**'}={}) {
    const dialog=document.createElement('div');dialog.className='dialog-lib-resume';
    const el=document.createElement('div');el.className='resume-detail-wrap';dialog.append(el);document.body.append(dialog);
    bounds(dialog);bounds(el);
    const root={$options:{name:'ResumeRoot'},$el:el,loading:false,
      resumeInfo:{geekBaseInfo:{name,userId:uid,encryptGeekId:id}},currGeek:{encryptGeekId:id},dataSource:{encryptGeekId:id}};
    el.__vue__=root;
    for (const data of [root.resumeInfo.geekBaseInfo,root.currGeek,root.dataSource]) Object.defineProperty(data,'securityId',{get:no});
    root.getDetails=no;root.openChat=no;
    return {root,dialog};
  }
  return {document,win,run,detail,bounds,clicks:()=>clicks};
}

test('platform identifiers match exactly and a conflicting identifier never falls back to profile text',async()=>{
  assert.equal((await decision({name:'项**',boss_chat_uid:'9007199254740993'},{boss_chat_uid:'9007199254740993'})).method,'platform_uid');
  const card={name:'项**',boss_chat_uid:'111',platform_geek_id:'a',text:'浙江测试智能科技有限公司 河南测试大学'};
  assert.equal((await decision(card,{boss_chat_uid:'222'})).matched,false);
  assert.equal((await decision(card,{platform_geek_id:'b'})).matched,false);
  assert.equal((await decision({...card,boss_chat_uid:9007199254740992},{boss_chat_uid:'9007199254740992',anchors:[],evidence:[]})).matched,false);
});

const probeTarget={...target,anchors:[{kind:'company',text:'麦田能源股份有限公司'},{kind:'company',text:'昌硕科技(上海)有限公司'},
  {kind:'school',text:'河南测试大学'}],evidence:[{kind:'work',organization:'麦田能源股份有限公司',period:'2023.02-2024.03'},
  {kind:'work',organization:'昌硕科技(上海)有限公司',period:'2019.07-2023.01'}]};
const probeHTML=()=>`<div class="candidate-card-wrap" data-geek="encrypted_a"><span class="name-label">项**</span>
  <div class="timeline-wrap work-exps">${[['2023.02','2024.03','麦田能源'],['2019.07','2023.01','昌硕科技（上海）']].map(([start,end,company])=>
  `<div class="timeline-item"><div class="time join-text-wrap"><span>${start}</span><i class="join-shape minus"></i><span>${end}</span></div>
  <div class="content join-text-wrap"><span>${company}</span><i class="join-shape dot"></i><span>工业工程师</span></div></div>`).join('')}</div>
  <span>河南测试大学</span><button>联系Ta</button></div>`;

test('legal suffix probes require two exact brands with their own periods and never remove industry words',async()=>{
  const card={name:'项**',text:'河南测试大学',work_rows:[{company:'麦田能源',period:'2023.2-2024.3'},
    {company:'昌硕科技（上海）',period:'2019.7-2023.1'}]};
  assert.equal((await decision(card,probeTarget)).method,'professional_probe');
  for(const mutate of [value=>value.work_rows.pop(),value=>{value.work_rows[0].company='麦田能源浙江';},
    value=>{value.work_rows[1].company='昌硕(上海)';},value=>{value.work_rows[0].period='2019.7-2023.1';},
    value=>{value.work_rows[0].period='2023-2024';}]) {
    const changed=structuredClone(card);mutate(changed);assert.equal((await decision(changed,probeTarget)).matched,false);
  }
});

test('probe cannot verify until complete legal company names, associated periods and school agree in its own detail',async()=>{
  for(const invalid of ['none','company','period','school','missing_end']) {
    const f=fixture({html:probeHTML()}),s=await f.run('scan',{target:probeTarget});
    assert.equal(s.match.method,'professional_probe');await f.run('open',{token:s.token,target:probeTarget});
    const {root}=f.detail();
    root.resumeInfo.geekWorkExpList=[{company:'麦田能源股份有限公司',startYearMonStr:'2023.02',endYearMonStr:'2024.03'},
      {company:'昌硕科技(上海)有限公司',startYearMonStr:'2019.07',endYearMonStr:'2023.01'}];
    root.resumeInfo.geekEduExpList=[{school:'河南测试大学'}];
    if(invalid==='company')root.resumeInfo.geekWorkExpList[0].company='麦田能源有限公司';
    if(invalid==='period')root.resumeInfo.geekWorkExpList[0].startYearMonStr='2022.02';
    if(invalid==='school')root.resumeInfo.geekEduExpList[0].school='其他测试大学';
    if(invalid==='missing_end')delete root.resumeInfo.geekWorkExpList[0].endYearMonStr;
    const result=await f.run('status',{token:s.token,target:probeTarget});
    assert.equal(result.status,invalid==='none'?'located':'opened_unverified');
    assert.equal(result.binding_verified,invalid==='none'?true:undefined);
  }
});

test('reveal closes only its verified dialog then highlights its unchanged card; stop preserves success and reset clears it',async()=>{
  const f=fixture(),s=await f.run('scan');await f.run('open',{token:s.token});
  const {dialog}=f.detail(),close=f.document.createElement('i');close.className='icon-close';dialog.append(close);f.bounds(close);
  let closed=0;close.click=()=>{closed++;dialog.remove();};
  f.document.elementFromPoint=()=>dialog.isConnected?close:f.document.querySelector('.name-label');
  assert.equal((await f.run('reveal',{token:s.token})).reason,'invalid_token');assert.equal(closed,0);
  await f.run('status',{token:s.token});
  assert.equal((await f.run('reveal',{token:s.token})).status,'revealing');assert.equal(closed,1);
  const result=await f.run('reveal_status',{token:s.token});
  assert.equal(result.status,'card_located');assert.equal(result.card_visible,true);assert.equal(result.binding_verified,true);
  const card=f.document.querySelector('.geek-info-card');assert.equal(card.getAttribute('data-hrm-favorite-located'),'true');
  await f.run('stop');assert.equal(card.getAttribute('data-hrm-favorite-located'),'true');
  await f.run('reset');assert.equal(card.hasAttribute('data-hrm-favorite-located'),false);assert.equal(card.style.outline,'');
});

test('reveal rejects reused card rows and another visible detail without clicking contact controls',async()=>{
  for(const change of ['card','detail']) {
    const f=fixture(),s=await f.run('scan');await f.run('open',{token:s.token});
    const {dialog,root}=f.detail(),close=f.document.createElement('i');close.className='icon-close';dialog.append(close);f.bounds(close);
    close.click=()=>dialog.remove();f.document.elementFromPoint=()=>dialog.isConnected?close:f.document.querySelector('.name-label');
    await f.run('status',{token:s.token});
    if(change==='detail') {root.resumeInfo.geekBaseInfo.encryptGeekId='other';assert.equal((await f.run('reveal',{token:s.token})).reason,'detail_identity_conflict');}
    else {await f.run('reveal',{token:s.token});f.document.querySelector('.geek-info-card').setAttribute('data-geek','other');
      assert.equal((await f.run('reveal_status',{token:s.token})).reason,'card_changed');}
    assert.equal(f.document.querySelector('[data-hrm-favorite-located]'),null);
  }
});

test('a virtual row reused after success loses its highlight, and an unexposed parent frame cannot claim card_visible',async()=>{
  for(const blocked of [false,true]) {
    const f=fixture(),s=await f.run('scan');await f.run('open',{token:s.token});
    const {dialog}=f.detail(),close=f.document.createElement('i');close.className='icon-close';dialog.append(close);f.bounds(close);
    close.click=()=>dialog.remove();f.document.elementFromPoint=()=>dialog.isConnected?close:f.document.querySelector('.name-label');
    await f.run('status',{token:s.token});await f.run('reveal',{token:s.token});
    if(blocked) {
      const {document}=parseHTML('<html><body><iframe></iframe></body></html>');
      for(const el of document.querySelectorAll('*'))f.bounds(el);
      const parent={document,location:{origin:'https://www.zhipin.com'},_PAGE:{uid:'12345'}};parent.top=parent;parent.parent=parent;
      f.win.top=parent;f.win.parent=parent;f.win.frameElement=document.querySelector('iframe');document.elementFromPoint=()=>document.body;
      assert.equal((await f.run('reveal_status',{token:s.token})).reason,'card_obscured');
    }else {
      assert.equal((await f.run('reveal_status',{token:s.token})).status,'card_located');
      const card=f.document.querySelector('.geek-info-card');card.setAttribute('data-geek','reused_for_another');
      await new Promise(resolve=>setTimeout(resolve,0));
      assert.equal(card.hasAttribute('data-hrm-favorite-located'),false);
    }
  }
});

test('page notification accepts only fixed states and never interpolates user-supplied content',async()=>{
  const f=fixture();await f.run('notify',{state:'scanning',count:30,text:'unsafe arbitrary message'});
  const banner=f.document.getElementById('hrm-favorite-locator-status');assert.match(banner.textContent,/当前读取 30 张/);
  assert.ok(!banner.textContent.includes('unsafe'));
  const result=await f.run('notify',{state:'unsafe arbitrary message'});assert.equal(result.ok,false);
});

test('masked names require independent professional evidence and generic dates are not sufficient',async()=>{
  assert.equal((await decision({name:'项**',text:'河南测试大学'})).matched,false);
  assert.equal((await decision({name:'项**',text:'浙江测试智能科技有限公司 2024.04'})).matched,false);
  assert.equal((await decision({name:'项**',text:'浙江测试智能科技有限公司 河南测试大学'})).matched,false);
  assert.equal((await decision({name:'项**',text:'浙江测试智能科技有限公司 河南测试大学 2024年4月—2026年11月',
    work_rows:[{text:'浙江测试智能科技有限公司',period:'2024年4月—2026年11月'}]})).method,'professional_fields');
  assert.equal((await decision({name:'项**',text:'浙江测试智能科技有限公司 2024.04-2026.11'})).matched,false);
  assert.equal((await decision({name:'另一位',text:'浙江测试智能科技有限公司 河南测试大学'})).matched,false);
});

test('serialized scan issues a token and opens only the bound name, never contact or collection controls',async()=>{
  const f=fixture(),s=await f.run('scan');
  assert.equal(s.status,'match');assert.equal(s.account_uid,'12345');assert.equal(s.match.method,'professional_fields');
  assert.equal(f.clicks(),0);
  assert.equal((await f.run('open',{token:s.token})).status,'opening');assert.equal(f.clicks(),1);
  assert.equal((await f.run('open',{token:s.token})).ok,false);assert.equal(f.clicks(),1);
  f.detail();const found=await f.run('status',{token:s.token});
  assert.equal(found.status,'located');assert.equal(found.boss_chat_uid,'45678');
});

test('a company tooltip supplies complete visible evidence when its label is visually shortened',async()=>{
  const f=fixture({html:cardHTML().replace('<span class="company">浙江测试智能科技有限公司</span>',
    '<span class="company" title="浙江测试智能科技有限公司">浙江测试智能…</span>')});
  assert.equal((await f.run('scan')).status,'match');
});

test('two matching cards are ambiguous even if names and full public text match',async()=>{
  const f=fixture({html:cardHTML('a')+cardHTML('b')}),s=await f.run('scan');
  assert.equal(s.status,'ambiguous');assert.equal(s.token,undefined);assert.equal(f.clicks(),0);
});

test('the exact favourites tab and official frame route are required',async()=>{
  assert.equal((await fixture({active:'沟通过'}).run('scan')).status,'wrong_section');
  assert.equal((await fixture({href:'https://www.zhipin.com/web/chat/search'}).run('scan')).status,'unsupported');
  assert.equal((await fixture({href:'https://evil.example/web/frame/recommend/interaction'}).run('scan')).status,'unsupported');
});

test('account changes, changed cards, hidden labels, and another target revoke opening',async()=>{
  for (const mutate of [f=>{f.win._PAGE.uid='999';},f=>{f.document.querySelector('.name-label').textContent='另一位';},
    f=>{f.document.querySelector('.name-label').style.display='none';},f=>{f.document.querySelector('.geek-info-card').setAttribute('data-geek','other');}]) {
    const f=fixture(),s=await f.run('scan');mutate(f);
    assert.equal((await f.run('open',{token:s.token})).ok,false);assert.equal(f.clicks(),0);
  }
  const f=fixture(),s=await f.run('scan');
  assert.equal((await f.run('open',{token:s.token,target:{...target,id:999}})).ok,false);
});

test('status confirms the actually opened identity and rejects a mismatched same-name detail',async()=>{
  for (const field of [{id:'another'},{name:'其他'},{uid:'999'}]) {
    const f=fixture(),expected={...target,boss_chat_uid:field.uid?'45678':''};
    const s=await f.run('scan',{target:expected});await f.run('open',{token:s.token,target:expected});f.detail(field);
    assert.equal((await f.run('status',{token:s.token,target:expected})).ok,false);
  }
});

test('unbound detail is explicitly unverified, not a confirmed identity',async()=>{
  const f=fixture(),s=await f.run('scan');await f.run('open',{token:s.token});
  const {root}=f.detail();root.$el.__vue__=null;
  assert.equal((await f.run('status',{token:s.token})).status,'opened_unverified');
});

test('stop revokes queued clicks and late scan/advance/open calls',async()=>{
  const f=fixture(),s=await f.run('scan');await f.run('stop');
  for (const action of ['scan','advance','open']) assert.equal((await f.run(action,{token:s.token,signature:s.signature})).reason,'stopped');
  assert.equal(f.clicks(),0);
  await f.run('reset');
  assert.equal((await f.run('open',{token:s.token})).ok,false);
  assert.equal((await f.run('scan')).status,'match');
});

test('advance binds the last scan and scrolls within a bounded container without clicking candidates',async()=>{
  const f=fixture(),s=await f.run('scan');
  assert.equal((await f.run('advance',{signature:'different'})).status,'changed');
  assert.equal((await f.run('advance',{signature:s.signature})).status,'advanced');
  assert.equal(f.document.documentElement.scrollTop,480);assert.equal(f.clicks(),0);
  const next=await f.run('scan');f.document.documentElement.scrollTop=1000;
  assert.equal((await f.run('advance',{signature:next.signature})).status,'advanced');
  const waiting=await f.run('scan');f.win.__hrmFavoriteLocatorStateV1.endWait.started-=3000;
  assert.equal((await f.run('advance',{signature:waiting.signature})).status,'end');
});

test('a new run starts at the list top and reaching bottom allows bounded incremental loading before ending',async()=>{
  const f=fixture();f.document.documentElement.scrollTop=800;await f.run('reset');
  assert.equal((await f.run('scan')).reason,'resetting_list_position');assert.equal(f.document.documentElement.scrollTop,0);
  let s=await f.run('scan');f.document.documentElement.scrollTop=1000;
  assert.equal((await f.run('advance',{signature:s.signature})).diagnostics.last_advance.loading,true);
  Object.defineProperty(f.document.documentElement,'scrollHeight',{value:2200});
  s=await f.run('scan');assert.equal((await f.run('advance',{signature:s.signature})).status,'advanced');
  assert.equal(f.document.documentElement.scrollTop,1480);assert.equal(f.win.__hrmFavoriteLocatorStateV1.endWait,null);
});

test('a scroll budget exhaustion is reported as a limit rather than falsely claiming no candidate exists',async()=>{
  const f=fixture(),s=await f.run('scan');f.win.__hrmFavoriteLocatorStateV1.scrolls=80;
  assert.equal((await f.run('advance',{signature:s.signature})).status,'limit');
  assert.equal(f.document.documentElement.scrollTop,0);
});

test('a height-expanded frame advances only its same-origin containing scroll pane',async()=>{
  const f=fixture();
  Object.defineProperties(f.document.documentElement,{scrollHeight:{value:600},clientHeight:{value:600}});
  const {document}=parseHTML('<html><body><aside></aside><main><iframe></iframe></main></body></html>');
  for(const el of document.querySelectorAll('*'))f.bounds(el);
  const pane=document.querySelector('main'),sidebar=document.querySelector('aside'),owner=document.querySelector('iframe');
  for(const el of [pane,sidebar]) {
    Object.defineProperties(el,{scrollHeight:{value:1800},clientHeight:{value:600}});el.scrollTop=0;
  }
  const parent={document,location:{origin:'https://www.zhipin.com'},_PAGE:{uid:'12345'},
    getComputedStyle:el=>({overflowY:el===pane||el===sidebar?'auto':'visible'})};
  parent.top=parent;parent.parent=parent;f.win.parent=parent;f.win.top=parent;f.win.frameElement=owner;
  const s=await f.run('scan');
  assert.equal((await f.run('advance',{signature:s.signature})).status,'advanced');
  assert.equal(pane.scrollTop,480);assert.equal(sidebar.scrollTop,0);assert.equal(f.document.documentElement.scrollTop,0);
  const next=await f.run('scan');owner.remove();
  assert.equal((await f.run('advance',{signature:next.signature})).reason,'frame_changed');
  assert.equal(pane.scrollTop,480);
});

test('page getter failures return fixed errors without credential or exception content',async()=>{
  const f=fixture();Object.defineProperty(f.document.querySelector('.geek-info-card'),'__vue__',{get(){throw Error('securityId=SECRET');}});
  assert.deepEqual(await f.run('scan'),{ok:false,status:'blocked',reason:'read_failed'});
});

test('saved identities are reused only for the same current recruitment account',async()=>{
  const f=fixture({html:cardHTML().replace('浙江测试智能科技有限公司','新公司').replace('河南测试大学','新学校')});
  const bindings=[{account_uid:'12345',platform_geek_id:'encrypted_a',boss_chat_uid:'45678'}];
  assert.equal((await f.run('scan',{target:{...target,bindings}})).match.method,'platform_id');
  f.win._PAGE.uid='54321';
  assert.equal((await f.run('scan',{target:{...target,bindings}})).status,'scanned');
});

test('zero recognised cards distinguish unsupported structure, loading, and explicit empty state',async()=>{
  assert.equal((await fixture({html:'<div class="geek-info-card">unknown layout</div>'}).run('scan')).status,'unsupported');
  assert.equal((await fixture({html:''}).run('scan')).status,'loading');
  assert.equal((await fixture({html:'<div class="empty">暂无收藏牛人</div>'}).run('scan')).status,'empty');
  const found=await fixture({html:'<article class="new-card"><span>项**</span></article>'}).run('scan');
  assert.equal(found.status,'unsupported');assert.equal(found.diagnostics.name_paths[0][1].classes,'new-card');
});

test('current employment periods match normal punctuation without relying on demographics',async()=>{
  const data={name:'项**',text:'浙江测试智能科技有限公司 河南测试大学 2024.04-至今',
    work_rows:[{text:'浙江测试智能科技有限公司',period:'2024.04-至今'}]};
  const result=await decision(data,{evidence:[{kind:'work',organization:'浙江测试智能科技有限公司',period:'2024年4月 至今'}]});
  assert.equal(result.method,'professional_fields');
});

test('an employer never borrows another employment row dates, even for the same masked name and school',async()=>{
  const html=cardHTML().replace('2024.04-2026.11','2020.04-2022.11')
    .replace('<span>河南测试大学</span>','<div class="timeline-item"><span>另一家有限公司</span><span>2024.04-2026.11</span></div><span>河南测试大学</span>');
  const f=fixture({html});
  const scan=await f.run('scan');
  assert.equal(scan.status,'scanned');
  assert.deepEqual(scan.diagnostics.target_match_reasons,['insufficient_evidence']);
  assert.deepEqual(scan.diagnostics.company_matches,[1]);assert.deepEqual(scan.diagnostics.school_matches,[1]);
  assert.deepEqual(scan.diagnostics.dated_company_matches,[0]);
  assert.deepEqual(scan.diagnostics.target_row_structures[0].rows,[{tag:'DIV',classes:'timeline-item'},{tag:'DIV',classes:'timeline-item'}]);
  assert.doesNotMatch(JSON.stringify(scan.diagnostics.target_row_structures),/测试|2024|另一家/);
  assert.equal(f.clicks(),0);
  const flattened={name:'项**',text:'浙江测试智能科技有限公司 河南测试大学 2024.04-2026.11'};
  assert.equal((await decision(flattened)).matched,false);
});

test('a row with two periods is ambiguous and unsupported employment markup cannot fabricate a binding',async()=>{
  const ambiguous=fixture({html:cardHTML().replace('2024.04-2026.11','2024.04-2026.11 2020.04-2022.11')});
  assert.equal((await ambiguous.run('scan')).status,'scanned');
  const unknown=fixture({html:cardHTML().replace('class="timeline-item"','class="unrecognised-row"')});
  const result=await unknown.run('scan');
  assert.equal(result.status,'scanned');assert.deepEqual(result.diagnostics.target_work_row_counts,[0]);
});

test('initial tabs and account loading wait instead of claiming the user selected the wrong section',async()=>{
  const f=fixture();f.document.querySelector('nav').remove();
  const absent=await f.run('scan');
  assert.equal(absent.status,'loading');assert.equal(absent.reason,'tabs_loading');
  assert.equal(absent.is_favorites,false);assert.equal(absent.diagnostics.tab_count,0);
  const pending=fixture();pending.win._PAGE={};
  const result=await pending.run('scan');
  assert.equal(result.status,'loading');assert.equal(result.reason,'account_loading');
  assert.equal(result.is_favorites,false);assert.equal(result.diagnostics.account_available,false);
  pending.win._PAGE.uid='12345';
  assert.equal((await pending.run('scan')).status,'match');
});

test('unknown tab selection exposes only bounded tab classes for diagnosis',async()=>{
  const f=fixture();f.document.querySelector('.active').className='tab new-highlight-style';
  const result=await f.run('scan');
  assert.equal(result.status,'loading');assert.equal(result.reason,'tab_selection_unconfirmed');
  assert.equal(result.diagnostics.tabs[0].classes,'tab new-highlight-style');
  assert.equal(result.diagnostics.tabs[0].ancestors[0].tag,'SPAN');
  assert.ok(result.diagnostics.tabs.every(tab=>tab.ancestors.length<=3));
});

test('a shared active tab container does not mark every tab selected and missing account revokes tokens',async()=>{
  const f=fixture();f.document.querySelector('nav').className='active';
  const result=await f.run('scan');assert.equal(result.status,'match');
  assert.equal(result.token.length>0,true);
  f.win._PAGE={};
  assert.equal((await f.run('open',{token:result.token})).reason,'account_unavailable');
  f.win._PAGE.uid='12345';
  assert.equal((await f.run('open',{token:result.token})).reason,'invalid_token');
  assert.equal(f.clicks(),0);
});

test('the observed favourites LI tab-item curr class selects only that tab',async()=>{
  const f=fixture();f.document.querySelector('nav').innerHTML='<div class="tab-wrap"><ul class="tab-list"><li class="tab-item curr">收藏牛人</li><li class="tab-item">沟通过</li><li class="tab-item">看过我</li></ul></div>';
  for (const node of f.document.querySelectorAll('nav *')) f.bounds(node);
  assert.equal((await f.run('scan')).status,'match');
  f.document.querySelector('.curr').className='tab-item';
  f.document.querySelectorAll('.tab-item')[1].className='tab-item curr';
  assert.equal((await f.run('scan')).status,'wrong_section');
});

test('official JoinText time endpoints remain paired despite a CSS-only separator',async()=>{
  const f=fixture({html:cardHTML().replace('<span>2024.04-2026.11</span>',
    '<div class="time join-text-wrap"><span>2024.04</span><i class="join-shape minus"></i><span>2026.11</span><i class="join-shape minus"></i></div>')});
  const result=await f.run('scan');assert.equal(result.status,'match');
  assert.deepEqual(result.diagnostics.dated_company_matches,[1]);
});
