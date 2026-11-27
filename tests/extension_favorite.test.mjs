import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

function fixture({kind='text',label='收藏',markup='',settle=true}={}){
  const resume='<section class="resume"><strong>合成张**</strong><span class="activity">刚刚活跃</span>'+
    '<small class="metadata">35岁 8年 本科 在职-考虑机会</small><h2>工作经历</h2><p>合成设备公司，自动化工程师。'+
    '负责视觉检测和图像处理系统开发，设计标定算法、质量检测、测试用例与生产线现场部署，协调设备接口和机械控制。'.repeat(3)+
    '</p><h2>教育经历</h2><p>合成大学，自动化专业，硕士。</p></section>';
  const {window}=parseHTML('<!doctype html><html><body><button class="outside">收藏</button>'+
    '<div role="dialog" class="dialog-lib-resume">'+(kind==='canvas'?'<div class="resume-detail-wrap"><iframe src="https://www.zhipin.com/web/frame/c-resume/"></iframe></div>':resume)+
    (markup||`<button class="favorite">${label}</button>`)+'<button class="contact">联系Ta</button></div></body></html>');
  const {document,HTMLElement}=window;
  for(const key of ['__hrmAuto','__hrmDom','top','parent','frameElement'])delete window[key];
  Object.defineProperties(HTMLElement.prototype,{
    getClientRects:{configurable:true,value(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];}},
    getBoundingClientRect:{configurable:true,value(){return {x:0,y:0,left:0,top:0,width:800,height:700,right:800,bottom:700};}},
  });
  const owner=document.querySelector('[role="dialog"]'),button=owner.querySelector('.favorite');
  const metrics={favorite:0,contact:0,outside:0};
  if(button)button.addEventListener('click',()=>{
    metrics.favorite++;
    if(settle){
      if(button.hasAttribute('aria-label'))button.setAttribute('aria-label','已收藏');
      if(button.hasAttribute('aria-pressed'))button.setAttribute('aria-pressed','true');
      if(button.textContent)button.textContent='已收藏';
    }
  });
  owner.querySelector('.contact').addEventListener('click',()=>metrics.contact++);
  document.querySelector('.outside').addEventListener('click',()=>metrics.outside++);
  let occluded=false;
  document.elementFromPoint=()=>occluded?document.querySelector('.outside'):(button?.querySelector('span')||button);
  let canvas=null,frame=null;
  if(kind==='canvas'){
    frame=owner.querySelector('iframe');
    const page=parseHTML('<html><body><canvas></canvas></body></html>').document;
    canvas=page.querySelector('canvas');canvas.width=773;canvas.height=956;
    canvas.toDataURL=()=> 'data:image/png;base64,'+'A'.repeat(80);
    Object.defineProperty(frame,'contentDocument',{configurable:true,value:page});
  }
  const context={window,document,URL,innerWidth:1200,innerHeight:900,
    location:{protocol:'https:',hostname:'www.zhipin.com',origin:'https://www.zhipin.com',pathname:'/web/chat/search'},
    getComputedStyle:element=>({visibility:'visible',display:element.hidden?'none':'block',overflowY:'visible',pointerEvents:element.style?.pointerEvents||'auto'}),
    setTimeout:fn=>queueMicrotask(fn),clearTimeout(){},
  };
  for(const file of ['dom-reader.js','automation.js'])vm.runInNewContext(fs.readFileSync(new URL('../extension/'+file,import.meta.url),'utf8'),context);
  const api=window.__hrmAuto,args={name:'合成张**',kind};
  return {document,owner,button,canvas,frame,api,metrics,args,occlude(){occluded=true;},
    prepare:()=>api.run('prepare-favorite',args),
    verify:token=>api.run('verify-favorite',{...args,token}),
    favorite:token=>api.run('favorite',{...args,token})};
}

test('favorites one bound text resume and verifies the resulting state without contacting anyone',async()=>{
  const f=fixture(),{token}=await f.prepare();
  assert.equal((await f.favorite(token)).favorited,true);
  assert.equal((await f.favorite(token)).already,true);
  assert.deepEqual(f.metrics,{favorite:1,contact:0,outside:0});
});

test('favorites canvas toolbar div labels and keeps rendered pixels private',async()=>{
  const f=fixture({kind:'canvas',markup:'<div class="favorite"><i></i><span>收藏</span></div>'}),prepared=await f.prepare();
  assert.deepEqual(Object.keys(prepared),['token']);
  assert.equal((await f.favorite(prepared.token)).favorited,true);
  assert.equal(f.metrics.favorite,1);
});

test('decorative stars and icon-font glyphs do not hide a labelled favorite button',async()=>{
  for(const icon of ['☆','★','\uE601']){
    const f=fixture({markup:`<button class="favorite"><i>${icon}</i><span>收藏</span></button>`});
    const {token}=await f.prepare();assert.equal((await f.favorite(token)).favorited,true);assert.equal(f.metrics.favorite,1);
  }
});

test('already collected controls and pressed icons are never toggled off',async()=>{
  for(const options of [{label:'已收藏'},{label:'取消收藏'},
    {markup:'<button class="favorite" aria-label="收藏" aria-pressed="true"></button>'}]){
    const f=fixture(options),{token}=await f.prepare();
    assert.equal((await f.favorite(token)).already,true);assert.equal(f.metrics.favorite,0);
  }
});

test('icon-only favorite labels need an explicit successful state after clicking',async()=>{
  const f=fixture({markup:'<button class="favorite" aria-label="收藏" aria-pressed="false"></button>'});
  const {token}=await f.prepare();assert.equal((await f.favorite(token)).favorited,true);assert.equal(f.metrics.favorite,1);
});

test('token, candidate name, kind, reset and stop bind the favorite session',async()=>{
  for(const mutation of ['token','name','kind','reset','stop']){
    const f=fixture(),{token}=await f.prepare(),args={...f.args,token};
    if(mutation==='reset'||mutation==='stop')await f.api.run(mutation);
    else args[mutation]='other';
    await assert.rejects(f.api.run('favorite',args));assert.equal(f.metrics.favorite,0);
  }
});

test('text resume changes and activity updates do not invalidate the bound header identity',async()=>{
  const f=fixture(),{token}=await f.prepare();f.owner.querySelector('.resume p').textContent+='新候选人的职责';
  f.owner.querySelector('.activity').textContent='在线';
  assert.deepEqual({...await f.verify(token)},{verified:true});
  assert.equal((await f.favorite(token)).favorited,true);
  assert.equal(f.metrics.favorite,1);
});

test('name and demographic changes reject a bound favorite',async()=>{
  for(const mutation of ['name','age','experience','education','status']){
    const f=fixture(),{token}=await f.prepare();
    if(mutation==='name')f.owner.querySelector('.resume strong').textContent='合成李**';
    if(mutation==='age')f.owner.querySelector('.metadata').textContent='36岁 8年 本科 在职-考虑机会';
    if(mutation==='experience')f.owner.querySelector('.metadata').textContent='35岁 9年 本科 在职-考虑机会';
    if(mutation==='education')f.owner.querySelector('.metadata').textContent='35岁 8年 硕士 在职-考虑机会';
    if(mutation==='status')f.owner.querySelector('.metadata').textContent='35岁 8年 本科 离职-随时到岗';
    await assert.rejects(f.verify(token));
    await assert.rejects(f.favorite(token),error=>{
      assert.equal(error.favoriteAttempted,false);
      return true;
    });
    assert.equal(f.metrics.favorite,0);
  }
});

test('favorite verification is bound to the prepared token and cannot follow a click',async()=>{
  const f=fixture(),{token}=await f.prepare();
  await assert.rejects(f.verify('wrong'));
  assert.deepEqual({...await f.verify(token)},{verified:true});
  assert.equal((await f.favorite(token)).favorited,true);
  await assert.rejects(f.verify(token));
  assert.equal(f.metrics.favorite,1);
});

test('replacement dialog, frame element, frame URL and frame document reject stale favorites',async()=>{
  for(const mutation of ['dialog','frame','url','document']){
    const f=fixture({kind:'canvas'}),{token}=await f.prepare();
    if(mutation==='dialog')f.owner.replaceWith(f.owner.cloneNode(true));
    if(mutation==='frame')f.frame.replaceWith(f.frame.cloneNode(true));
    if(mutation==='url')f.frame.setAttribute('src','https://www.zhipin.com/web/frame/c-resume/?other=1');
    if(mutation==='document')Object.defineProperty(f.frame,'contentDocument',{value:parseHTML('<html><body></body></html>').document});
    await assert.rejects(f.favorite(token));assert.equal(f.metrics.favorite,0);
  }
});

test('canvas redraw and resize do not invalidate its stable element and frame',async()=>{
  for(const mutation of ['pixels','size']){
    const f=fixture({kind:'canvas'}),{token}=await f.prepare();
    if(mutation==='pixels')f.canvas.toDataURL=()=> 'data:image/png;base64,'+'B'.repeat(80);
    if(mutation==='size')f.canvas.height++;
    assert.deepEqual({...await f.verify(token)},{verified:true});
    assert.equal((await f.favorite(token)).favorited,true);
    assert.equal(f.metrics.favorite,1);
  }
});

test('canvas replacement rejects a bound favorite',async()=>{
  const f=fixture({kind:'canvas'}),{token}=await f.prepare();
  f.canvas.replaceWith(f.canvas.cloneNode());
  await assert.rejects(f.verify(token));
  await assert.rejects(f.favorite(token));
  assert.equal(f.metrics.favorite,0);
});

test('canvas access failure and multiple canvases cannot establish a bound favorite',async()=>{
  for(const mutation of ['cross-origin','multiple']){
    const f=fixture({kind:'canvas'});
    if(mutation==='cross-origin')Object.defineProperty(f.frame,'contentDocument',{value:null});
    if(mutation==='multiple')f.canvas.parentNode.append(f.canvas.cloneNode());
    await assert.rejects(f.prepare(),/无法确认/);assert.equal(f.metrics.favorite,0);
  }
});

test('a tainted canvas never needs pixel export for favorite identity',async()=>{
  const f=fixture({kind:'canvas'});
  f.canvas.toDataURL=()=>{throw Error('tainted');};
  const {token}=await f.prepare();
  assert.deepEqual({...await f.verify(token)},{verified:true});
  assert.equal((await f.favorite(token)).favorited,true);
  assert.equal(f.metrics.favorite,1);
});

test('missing or ambiguous favorite controls do not block identity preparation but never click',async()=>{
  for(const markup of ['<span>没有收藏入口</span>',
    '<button class="favorite">收藏</button><button>收藏</button>']){
    const f=fixture({markup}),{token}=await f.prepare();
    await assert.rejects(f.favorite(token),/没有唯一/);assert.equal(f.metrics.favorite,0);
  }
});

test('resume prose and unrelated page controls are not collection actions',async()=>{
  const f=fixture({markup:'<span>没有操作入口</span>'});
  f.owner.querySelector('.resume').insertAdjacentHTML('beforeend','<p>收藏</p>');
  const {token}=await f.prepare();await assert.rejects(f.favorite(token),/没有唯一/);
  assert.equal(f.metrics.outside,0);assert.equal(f.metrics.contact,0);
});

test('disabled and occluded favorite controls never receive clicks',async()=>{
  for(const mutation of ['disabled','aria-disabled','pointer-events','overlay']){
    const f=fixture(),{token}=await f.prepare();
    if(mutation==='disabled')f.button.setAttribute('disabled','');
    if(mutation==='aria-disabled')f.button.setAttribute('aria-disabled','true');
    if(mutation==='pointer-events')f.button.style.pointerEvents='none';
    if(mutation==='overlay')f.occlude();
    await assert.rejects(f.favorite(token),/不可操作|遮挡/);assert.equal(f.metrics.favorite,0);
  }
});

test('links and contact controls disguised by a favorite attribute never navigate or contact',async()=>{
  for(const markup of ['<a class="favorite" href="https://www.zhipin.com/elsewhere">收藏</a>',
    '<button class="favorite" aria-label="收藏">联系Ta</button>',
    '<button class="favorite" title="取消收藏">收藏</button>']){
    const f=fixture({markup}),{token}=await f.prepare();await assert.rejects(f.favorite(token));
    assert.equal(f.metrics.favorite,0);assert.equal(f.metrics.contact,0);
  }
});

test('unconfirmed click is never repeated or mistaken for a successful favorite',async()=>{
  const f=fixture({settle:false}),{token}=await f.prepare();
  await assert.rejects(f.favorite(token),error=>{
    assert.match(error.message,/未确认成功/);
    assert.equal(error.favoriteAttempted,true);
    return true;
  });
  await assert.rejects(f.favorite(token),error=>{
    assert.match(error.message,/未重复点击/);
    assert.equal(error.favoriteAttempted,true);
    return true;
  });
  assert.equal(f.metrics.favorite,1);
});
