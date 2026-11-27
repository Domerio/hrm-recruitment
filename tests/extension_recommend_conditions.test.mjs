import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const reader=fs.readFileSync(new URL('../extension/dom-reader.js',import.meta.url),'utf8');
const adapter=fs.readFileSync(new URL('../extension/recommend-conditions.js',import.meta.url),'utf8');
const html=`<!doctype html><html><body><main>
  <nav><button>推荐</button><button>最新</button><button id="filter">筛选</button></nav>
  <div class="recommend-list-wrap"><ul class="card-list"><li class="card-item">原候选人</li></ul></div>
  <section id="filter-panel" role="dialog" hidden>
    <div class="row"><span>性别</span><button class="selected">不限</button><button>男</button><button>女</button></div>
    <div class="row"><span>活跃度[单选]</span><button class="selected">不限</button><button>3日内活跃</button></div>
    <div class="row"><span>院校</span><button class="selected">不限</button><button>211</button></div>
    <div class="row"><span>学历要求</span><button class="selected">不限</button><button>本科</button></div>
    <div class="row"><span>经验要求</span><button class="selected">不限</button><button>3-5年</button></div>
    <div class="row"><span>求职状态</span><button class="selected">不限</button><button>离职-随时到岗</button></div>
    <div class="row"><span>薪资待遇[单选]</span><button class="selected">不限</button><button>10-20K</button></div>
    <button id="confirm">确定</button>
  </section>
</main></body></html>`;

const componentHtml=`<!doctype html><html><body><main>
  <nav><button>推荐</button><button>最新</button><div class="fl recommend-filter op-filter"><div class="filter-wrap">
    <div id="filter" class="filter-label-wrap"><div class="filter-label">筛选</div><div class="filter-arrow-down"></div></div>
    <div id="filter-panel" class="filter-panel" hidden>
      <div class="row"><span>活跃度[单选]</span><button class="selected">不限</button><button>3日内活跃</button></div>
      <div class="btns"><div id="confirm" class="btn"><span>确定</span></div></div>
    </div>
  </div></div></nav>
  <div class="recommend-list-wrap"><ul class="card-list"><li class="card-item">原候选人</li></ul></div>
</main></body></html>`;

function fixture({markup=html,refresh=true,mutate,onTick}={}){
  const {window:domWindow}=parseHTML(markup),{document,HTMLElement,Event,MutationObserver}=domWindow;
  const window={document};
  Object.defineProperty(document,'defaultView',{configurable:true,value:window});
  Object.defineProperties(HTMLElement.prototype,{
    getClientRects:{configurable:true,value(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];}},
    getBoundingClientRect:{configurable:true,value(){return {left:0,top:0,right:1000,bottom:400,width:1000,height:400};}},
  });
  const filter=document.querySelector('#filter'),panel=document.querySelector('#filter-panel');
  const clicks=[],clickNodes=[];
  document.addEventListener('click',event=>{clicks.push(event.target.textContent.trim());clickNodes.push(event.target);});
  filter?.addEventListener('click',()=>{panel.hidden=!panel.hidden;});
  for(const row of document.querySelectorAll('#filter-panel .row')){
    for(const option of row.querySelectorAll('button'))option.addEventListener('click',()=>{
      for(const sibling of row.querySelectorAll('button'))sibling.classList.toggle('selected',sibling===option);
    });
  }
  document.querySelector('#confirm')?.addEventListener('click',()=>{
    panel.hidden=true;
    if(refresh){
      const item=document.createElement('li');item.className='card-item';item.textContent='筛选后候选人';
      document.querySelector('.card-list').replaceChildren(item);
    }
  });
  const location={href:'https://www.zhipin.com/web/geek/recommend',origin:'https://www.zhipin.com',
    pathname:'/web/geek/recommend',search:''};
  let ticks=0;
  const context={window,document,Event,MutationObserver,URL,location,
    getComputedStyle:node=>({display:node.closest?.('[hidden]')?'none':'block',visibility:'visible',opacity:'1'}),
    setTimeout:fn=>{queueMicrotask(()=>{onTick?.({tick:++ticks,document,window,location});fn();});return 1;},clearTimeout(){}};
  vm.runInNewContext(reader,context);
  mutate?.({document,window,location});
  vm.runInNewContext(adapter,context);
  return {document,location,clicks,clickNodes,run:(action,args)=>window.__hrmRecommendSearch.run(action,args)};
}

test('real recommendation component clicks its inner listener and supports a panel containing only the configured row',async()=>{
  const f=fixture({markup:componentHtml});
  assert.equal((await f.run('inspect')).supported,true);
  const result=await f.run('apply',{enabled:true,recommend_activity:'3日内活跃'});
  assert.equal(result.applied,true);assert.equal(result.summary.length,1);
  assert.equal(f.clickNodes[0],f.document.querySelector('.filter-label-wrap'));
  assert.equal(f.clickNodes.at(-1),f.document.querySelector('.btns .btn'));
  assert.ok(!f.clickNodes.some(node=>node.matches('.recommend-filter,.filter-wrap,.filter-label')));
  assert.equal(f.document.querySelector('.card-item').textContent,'筛选后候选人');
});

test('component panel mounting is awaited and a disabled confirm does not masquerade as a closed panel',async()=>{
  let detached;
  const f=fixture({markup:componentHtml,mutate({document}){
    detached=document.querySelector('#filter-panel');detached.remove();
    document.querySelector('#filter').addEventListener('click',()=>{detached.hidden=false;});
    detached.querySelector('#confirm').setAttribute('disabled','');
    detached.querySelector('.row button:last-child').addEventListener('click',()=>detached.querySelector('#confirm').removeAttribute('disabled'));
  },onTick({tick,document}){if(tick===2)document.querySelector('.filter-wrap').appendChild(detached);}});
  assert.equal((await f.run('apply',{enabled:true,recommend_activity:'3日内活跃'})).applied,true);
  assert.equal(f.clickNodes.filter(node=>node.id==='filter').length,1);
  assert.equal(f.clickNodes.filter(node=>node.id==='confirm').length,1);
});

test('existing component badge preserves current settings and never uses a candidate card filter control',async()=>{
  for(const badgeParent of ['#filter','.filter-label']){
    const f=fixture({markup:componentHtml,refresh:false,mutate({document}){
      document.querySelector(badgeParent).insertAdjacentHTML('beforeend','<span class="filter-count">·1</span>');
      document.querySelector('.card-item').insertAdjacentHTML('beforeend',
        '<div class="recommend-filter"><div class="filter-wrap"><div class="filter-label-wrap"><div class="filter-label">筛选</div></div></div></div>');
    }});
    const result=await f.run('apply',{enabled:true,recommend_activity:'3日内活跃'});
    assert.equal(result.skipped,true);assert.match(result.summary[0],/现有的 1 项/);assert.equal(f.clicks.length,0);
  }
});

test('hidden duplicate panels are ignored but multiple visible panels or trigger components are rejected',async()=>{
  const hidden=fixture({markup:componentHtml,mutate({document}){
    const clone=document.querySelector('#filter-panel').cloneNode(true);clone.id='hidden-other';document.querySelector('.filter-wrap').appendChild(clone);
  }});
  assert.equal((await hidden.run('apply',{enabled:true,recommend_activity:'3日内活跃'})).applied,true);
  assert.equal(hidden.document.querySelector('#hidden-other').hidden,true);
  for(const duplicate of ['panel','trigger','component','confirm-area']){
    const f=fixture({markup:componentHtml,mutate({document}){
      const selector={panel:'#filter-panel',trigger:'#filter',component:'.recommend-filter','confirm-area':'.btns'}[duplicate];
      const original=document.querySelector(selector),clone=original.cloneNode(true);original.parentElement.appendChild(clone);
      if(duplicate==='panel'){original.hidden=false;clone.hidden=false;}
      if(duplicate==='confirm-area')document.querySelector('#filter-panel').hidden=false;
    }});
    assert.equal((await f.run('inspect')).supported,false,duplicate);
    await assert.rejects(f.run('apply',{enabled:true,recommend_activity:'3日内活跃'}),/不唯一/);
    assert.equal(f.clicks.length,0);
  }
});

test('an unrelated visible panel cannot replace the still-hidden panel of the bound component',async()=>{
  const f=fixture({markup:componentHtml,mutate({document}){
    const clone=document.querySelector('#filter-panel').cloneNode(true);clone.id='unrelated-panel';clone.hidden=false;document.body.appendChild(clone);
    document.querySelector('#filter').addEventListener('click',()=>{document.querySelector('#filter-panel').hidden=true;});
  }});
  await assert.rejects(f.run('apply',{enabled:true,recommend_activity:'3日内活跃'}),/面板未展开/);
  assert.equal(f.clicks.length,1);assert.equal(f.clickNodes[0].id,'filter');
});

test('stop or frame drift while waiting for the component panel prevents option or confirmation clicks',async()=>{
  for(const change of ['stop','frame','trigger']){
    const f=fixture({markup:componentHtml,mutate({document}){
      document.querySelector('#filter').addEventListener('click',()=>{document.querySelector('#filter-panel').hidden=true;});
    },onTick({tick,document,window,location}){
      if(tick!==1)return;
      if(change==='stop')window.__hrmRecommendSearch.run('stop');
      if(change==='frame')location.pathname='/web/chat/index';
      if(change==='trigger')document.querySelector('#filter').replaceWith(document.querySelector('#filter').cloneNode(true));
    }});
    await assert.rejects(f.run('apply',{enabled:true,recommend_activity:'3日内活跃'}),/已停止|已变化/);
    assert.equal(f.clicks.length,1,change);assert.equal(f.clickNodes[0].id,'filter');
  }
});

test('a replaced component panel is never confirmed after changing one option',async()=>{
  const f=fixture({markup:componentHtml,mutate({document}){
    document.querySelector('.row button:last-child').addEventListener('click',()=>{
      const panel=document.querySelector('#filter-panel');panel.replaceWith(panel.cloneNode(true));
    });
  }});
  await assert.rejects(f.run('apply',{enabled:true,recommend_activity:'3日内活跃'}),/面板已变化/);
  assert.equal(f.clickNodes.filter(node=>node.id==='confirm').length,0);
});

test('legacy semantic filter buttons still work when wrapped by a text-only parent',async()=>{
  const f=fixture({mutate({document}){
    const button=document.querySelector('#filter'),wrapper=document.createElement('div');button.replaceWith(wrapper);wrapper.appendChild(button);
  }});
  assert.equal((await f.run('apply',{enabled:true,activity:'3日内活跃'})).applied,true);
  assert.equal(f.clickNodes[0].id,'filter');
});

test('recommendation filters apply exact shared values and confirm the refreshed card list',async()=>{
  const f=fixture();
  assert.equal((await f.run('inspect')).supported,true);
  const result=await f.run('apply',{enabled:true,activity:'3日内活跃',job_status:'离职-随时到岗',salary:'10-20K'});
  assert.equal(result.applied,true);
  assert.equal(result.summary.length,3);
  assert.equal(f.document.querySelector('#filter-panel').hidden,true);
  assert.equal(f.document.querySelector('.card-item').textContent,'筛选后候选人');
  assert.equal(f.document.querySelectorAll('#filter-panel .row button.selected').length,7);
  assert.equal(f.clicks.filter(text=>text==='确定').length,1);
});

test('recommendation clicks the option control when its text is nested',async()=>{
  const f=fixture({mutate({document}){
    document.querySelectorAll('#filter-panel .row')[1].querySelector('button:nth-of-type(2)').innerHTML='<span>3日内活跃</span>';
  }});
  const result=await f.run('apply',{enabled:true,activity:'3日内活跃'});
  assert.equal(result.applied,true);
  assert.equal(f.document.querySelectorAll('#filter-panel .row')[1].querySelector('button:nth-of-type(2)').classList.contains('selected'),true);
});

test('recommendation accepts an already selected value without demanding a redraw',async()=>{
  const f=fixture({refresh:false,mutate({document}){
    const row=document.querySelectorAll('#filter-panel .row')[1];
    row.querySelector('button.selected').classList.remove('selected');
    row.querySelectorAll('button')[1].classList.add('selected');
  }});
  assert.equal((await f.run('apply',{enabled:true,activity:'3日内活跃'})).applied,true);
});

test('an existing recommendation filter badge skips reapplying configured conditions',async()=>{
  const f=fixture({refresh:false,mutate({document}){
    document.querySelector('#filter').innerHTML='<span>筛选</span><span>·1</span>';
  }});
  assert.equal((await f.run('inspect')).supported,true);
  const result=await f.run('apply',{enabled:true,activity:'3日内活跃',recommend_education:'本科'});
  assert.equal(result.applied,true);
  assert.equal(result.skipped,true);
  assert.equal(f.clicks.length,0);
  assert.equal(f.document.querySelector('.card-item').textContent,'原候选人');
});

test('zero recommendation filters still apply configured values',async()=>{
  const f=fixture({mutate({document}){document.querySelector('#filter').textContent='筛选·0';}});
  const result=await f.run('apply',{enabled:true,activity:'3日内活跃'});
  assert.equal(result.skipped,undefined);
  assert.equal(f.clicks.includes('确定'),true);
});

test('recommendation rejects an absent exact option before confirming',async()=>{
  const missing=fixture();
  await assert.rejects(missing.run('apply',{enabled:true,recommend_salary:'15-25K'}),/没有精确选项/);
  assert.equal(missing.clicks.filter(text=>text==='确定').length,0);
});

test('recommendation ignores search-only conditions and inherits shared values',async()=>{
  const f=fixture();
  const result=await f.run('apply',{enabled:true,activity:'3日内活跃',job_hopping:'5年换3次',
    major:'计算机科学与技术',exclude_viewed_14d:true,exclude_contacted_30d:true});
  assert.equal(result.applied,true);
  assert.equal(result.summary.length,1);
  assert.equal(f.document.querySelectorAll('#filter-panel .row')[1].querySelectorAll('button')[1].classList.contains('selected'),true);
});

test('recommendation-specific values override inherited search values and include its own rows',async()=>{
  const f=fixture();
  const result=await f.run('apply',{enabled:true,activity:'今日活跃',recommend_activity:'3日内活跃',
    recommend_gender:'女',recommend_school:'211',recommend_education:'本科',recommend_experience:'3-5年'});
  assert.equal(result.applied,true);
  assert.equal(result.summary.length,5);
  for(const label of ['女','211','本科','3-5年'])assert.ok(f.clicks.includes(label));
});

test('recommendation can explicitly keep a shared page setting',async()=>{
  const f=fixture();
  const result=await f.run('apply',{enabled:true,activity:'3日内活跃',recommend_activity:'保留页面设置',
    recommend_education:'本科'});
  assert.equal(result.summary.length,1);
  assert.equal(f.clicks.includes('3日内活跃'),false);
});

test('recommendation cannot report applied when results do not refresh',async()=>{
  const f=fixture({refresh:false});
  await assert.rejects(f.run('apply',{enabled:true,activity:'3日内活跃'}),/未确认候选人列表刷新/);
});

test('recommendation discovery rejects a detail modal or a duplicate filter trigger',async()=>{
  const detail=fixture({mutate({document}){
    const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.textContent='候选人详情';
    document.body.appendChild(dialog);
  }});
  assert.equal((await detail.run('inspect')).supported,false);
  const duplicate=fixture({mutate({document}){
    document.querySelector('nav').appendChild(document.querySelector('#filter').cloneNode(true));
  }});
  assert.equal((await duplicate.run('inspect')).supported,false);
});
