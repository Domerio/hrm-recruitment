import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {resumeFavoriteAction} from '../extension/resume-favorite.mjs';

const bounds=node=>Object.defineProperty(node,'getBoundingClientRect',{configurable:true,
  value:()=>({left:20,top:20,right:220,bottom:120,width:200,height:100})});
function fixture({userId='9007199254740993',markup='<button class="favorite">收藏</button>'}={}){
  const {document}=parseHTML('<html><body><button class="outside">收藏</button>'+
    '<div class="dialog-lib-resume" role="dialog"><div class="resume-root"><div class="resume-detail-wrap">'+
    '<iframe src="https://www.zhipin.com/web/frame/c-resume/?source=recommend"></iframe></div>'+markup+
    '<button class="contact">联系Ta</button></div></div></body></html>');
  const child=parseHTML('<html><body><canvas width="600" height="180"></canvas></body></html>').document;
  for(const doc of [document,child])for(const element of doc.querySelectorAll('*'))bounds(element);
  const element=document.querySelector('.resume-root'),frame=document.querySelector('iframe'),canvas=child.querySelector('canvas');
  const location={href:'https://www.zhipin.com/web/frame/recommend'},bodyLocation={href:frame.getAttribute('src')};
  Object.defineProperty(document,'location',{configurable:true,value:location});
  Object.defineProperty(child,'location',{configurable:true,value:bodyLocation});
  const window={document,location,innerWidth:1000,innerHeight:700};window.parent=window;window.top=window;
  const bodyWindow={document:child,location:bodyLocation,parent:window,top:window,frameElement:frame,innerWidth:800,innerHeight:600};
  Object.defineProperty(frame,'contentDocument',{configurable:true,value:child});
  Object.defineProperty(frame,'contentWindow',{configurable:true,value:bodyWindow});
  const base={name:'测试候选人',userId,encryptGeekId:'candidate_a'};
  const root={$options:{name:'ResumeRoot'},$el:element,$refs:{iframe:frame},loading:false,
    currGeek:{encryptGeekId:base.encryptGeekId},dataSource:{encryptGeekId:base.encryptGeekId},resumeInfo:{geekBaseInfo:base}};
  element.__vue__={$options:{name:'Layout'},$el:element,$parent:root};
  let favoriteClicks=0,otherClicks=0,forbiddenCalls=0,clock=1000,random=0,sleeps=0;
  const button=element.querySelector('.favorite');
  let onClick=()=>{if(button.getAttribute('aria-label'))button.setAttribute('aria-label','已收藏');
    if(button.hasAttribute('aria-pressed'))button.setAttribute('aria-pressed','true');
    if(button.textContent)button.textContent='已收藏';},onSleep=()=>{};
  button?.addEventListener('click',()=>{favoriteClicks++;onClick();});
  for(const element of document.querySelectorAll('.contact,.outside'))element.addEventListener('click',()=>otherClicks++);
  document.elementFromPoint=()=>button?.querySelector('span')||button;
  const forbidden=()=>{forbiddenCalls++;throw Error('PRIVATE secret_api_key=never-return');};
  for(const target of [root,root.currGeek,root.dataSource,base]){
    for(const key of ['securityId','lid','token','cookie','greetingMsg'])Object.defineProperty(target,key,{get:forbidden});
  }
  root.favorite=root.openChat=root.getDetails=forbidden;canvas.toDataURL=canvas.getContext=forbidden;
  const context=vm.createContext({window,document,location,URL,
    getComputedStyle:element=>({display:element.style.display||'block',visibility:element.style.visibility||'visible',
      opacity:element.style.opacity||'1',pointerEvents:element.style.pointerEvents||'auto'}),
    Date:{now:()=>clock},crypto:{getRandomValues:array=>{for(let i=0;i<array.length;i++)array[i]=++random;return array;}},
    setTimeout:(resolve,ms)=>{clock+=ms;sleeps++;onSleep();resolve();},
    fetch:forbidden,XMLHttpRequest:forbidden,WebSocket:forbidden});
  const args={name:base.name,kind:'canvas',expected_platform_geek_id:base.encryptGeekId};
  const identity=JSON.stringify([base.name,'35岁','本科','8年']);
  const invoke=async values=>{
    context.args=JSON.parse(JSON.stringify(values));
    const result=await vm.runInContext(`(${resumeFavoriteAction.toString()})(args)`,context);
    assert.equal(forbiddenCalls,0);assert.equal(otherClicks,0);
    assert.doesNotMatch(JSON.stringify(result),/secret_api_key|PRIVATE/);
    return JSON.parse(JSON.stringify(result));
  };
  const call=(action,values={})=>invoke({...args,action,...values});
  const prepare=()=>call('prepare');
  const seal=async()=>{const prepared=await prepare();assert.equal(prepared.status,'prepared');
    assert.equal((await call('seal',{token:prepared.token,identity})).status,'sealed');return prepared.token;};
  return {document,child,window,bodyWindow,location,bodyLocation,element,root,base,frame,canvas,button,context,args,identity,
    call,invoke,prepare,seal,get clicks(){return favoriteClicks;},get sleeps(){return sleeps;},
    onClick:fn=>{onClick=fn;},onSleep:fn=>{onSleep=fn;}};
}
const ids=f=>({boss_chat_uid:String(f.base.userId),platform_geek_id:f.args.expected_platform_geek_id,candidate_name:f.args.name});

test('serialized Canvas prepare, seal and verify stay read-only; click confirms once without another copy',async()=>{
  const f=fixture(),prepared=await f.prepare();
  assert.deepEqual(prepared,{ok:true,status:'prepared',token:prepared.token,attempted:false,...ids(f)});
  assert.match(prepared.token,/^[a-f0-9]{32}$/);
  const args={token:prepared.token,identity:f.identity};
  assert.equal((await f.call('verify',args)).reason,'copy_unconfirmed');
  assert.equal((await f.call('click',args)).reason,'copy_unconfirmed');
  assert.equal((await f.call('seal',args)).sealed,true);assert.equal((await f.call('verify',args)).verified,true);
  assert.equal(f.clicks,0);
  assert.deepEqual(await f.call('click',args),{ok:true,status:'confirmed',favorited:true,already:false,attempted:true,...ids(f)});
  assert.equal((await f.call('click',args)).favorited,true);assert.equal(f.clicks,1);
});

test('missing, unsafe or encrypted UID and absent selected IDs never fall back to copied names',async()=>{
  for(const userId of ['',0,undefined,'00123','encrypted_candidate',9007199254740992,'123456789012345678901']){
    const f=fixture({userId});if(userId===undefined)delete f.base.userId;
    const result=await f.prepare();assert.equal(result.status,'unavailable');assert.equal(result.reason,'missing_uid');assert.equal(f.clicks,0);
  }
  for(const override of [{expected_platform_geek_id:''},{kind:'text'},{name:''}]){
    const f=fixture();assert.equal((await f.call('prepare',override)).status,'unavailable');assert.equal(f.clicks,0);
  }
  const f=fixture();delete f.root.currGeek;delete f.root.dataSource;
  assert.equal((await f.prepare()).status,'unavailable');assert.equal(f.clicks,0);
});

test('same-name in-place UID, encrypted identity, source or name changes block seal and late-model click',async()=>{
  for(const stage of ['seal','click'])for(const change of [
    f=>{f.base.userId='222';},f=>{f.base.encryptGeekId='candidate_b';},
    f=>{f.root.currGeek.encryptGeekId='candidate_b';},f=>{f.root.dataSource.encryptGeekId='candidate_b';},
    f=>{f.base.name='另一位';},f=>{f.root.loading=true;},
  ]){
    const f=fixture(),prepared=await f.prepare(),args={token:prepared.token,identity:f.identity};
    if(stage==='click')assert.equal((await f.call('seal',args)).status,'sealed');
    change(f);const result=await f.call(stage,args);
    assert.equal(result.status,'blocked');assert.equal(result.attempted,false);assert.equal(f.clicks,0);
  }
});

test('frame, document, root and URL replacements reject a late evaluation even when IDs are unchanged',async()=>{
  for(const change of [
    f=>{f.frame.src+='&changed=1';},f=>{f.bodyLocation.href+='&changed=1';},
    f=>{f.location.href+='?changed=1';},f=>{f.element.__vue__.$parent={...f.root};},
    f=>{f.root.$refs.iframe=f.frame.cloneNode(true);},
    f=>{f.canvas.replaceWith(f.canvas.cloneNode());},
    f=>{const replacement=parseHTML('<html><body><canvas></canvas></body></html>').document;
      Object.defineProperty(f.frame,'contentDocument',{value:replacement});},
    f=>{f.document.querySelector('.dialog-lib-resume').replaceWith(f.document.querySelector('.dialog-lib-resume').cloneNode(true));},
  ]){
    const f=fixture(),token=await f.seal();change(f);
    const result=await f.call('click',{token,identity:f.identity});
    assert.equal(result.ok,false);assert.equal(result.attempted,false);assert.equal(f.clicks,0);
  }
});

test('pixel paints, dimensions and selection changes do not require clipboard or pixel reads',async()=>{
  const f=fixture(),token=await f.seal();f.canvas.width+=5;f.canvas.height+=9;
  f.canvas.setAttribute('data-selection','all');f.canvas.style.background='blue';
  assert.equal((await f.call('verify',{token,identity:f.identity})).verified,true);
  assert.equal((await f.call('click',{token,identity:f.identity})).favorited,true);assert.equal(f.clicks,1);
});

test('seal validates the copied header shape and cannot replace a previously sealed identity',async()=>{
  const f=fixture(),ready=await f.prepare();
  for(const identity of ['',JSON.stringify(['另一位','35岁','本科','8年']),JSON.stringify([f.args.name]),
    JSON.stringify([f.args.name,'35岁','本科',8]),'PRIVATE secret_api_key=never-return']){
    assert.equal((await f.call('seal',{token:ready.token,identity})).reason,'copy_unconfirmed');
  }
  assert.equal((await f.call('seal',{token:ready.token,identity:f.identity})).sealed,true);
  const changed=JSON.stringify([f.args.name,'36岁','本科','8年']);
  assert.equal((await f.call('seal',{token:ready.token,identity:changed})).reason,'copy_unconfirmed');
  assert.equal((await f.call('click',{token:ready.token,identity:changed})).reason,'copy_unconfirmed');assert.equal(f.clicks,0);
});

test('already saved controls are confirmed without toggling, including icon-only pressed state',async()=>{
  for(const markup of ['<button class="favorite">已收藏</button>','<button class="favorite">取消收藏</button>',
    '<button class="favorite" aria-label="收藏" aria-pressed="true"></button>']){
    const f=fixture({markup}),token=await f.seal();
    assert.deepEqual(await f.call('click',{token,identity:f.identity}),{ok:true,status:'confirmed',favorited:true,already:true,attempted:false,...ids(f)});
    assert.equal(f.clicks,0);
    if(f.button.textContent)f.button.textContent='收藏';else f.button.setAttribute('aria-pressed','false');
    assert.equal((await f.call('click',{token,identity:f.identity})).ok,false);assert.equal(f.clicks,0);
  }
});

test('only one scoped exact favorite control is eligible; unrelated contact and navigation controls never click',async()=>{
  for(const markup of ['<button class="favorite">联系Ta</button>','<button class="favorite">收藏</button><button>收藏</button>',
    '<button class="favorite" aria-label="收藏">联系Ta</button>',
    '<a class="favorite" href="https://www.zhipin.com/web/chat/index">收藏</a>']){
    const f=fixture({markup}),token=await f.seal();
    assert.equal((await f.call('click',{token,identity:f.identity})).ok,false);assert.equal(f.clicks,0);
  }
  const f=fixture();f.element.querySelector('.resume-detail-wrap').append(f.button);
  const token=await f.seal();assert.equal((await f.call('click',{token,identity:f.identity})).reason,'button_missing');assert.equal(f.clicks,0);
});

test('decorative favorite labels and div controls remain bound to the current component',async()=>{
  for(const markup of ['<button class="favorite"><i>★</i><span>收藏</span></button>',
    '<div class="favorite"><i></i><span>收藏</span></div>']){
    const f=fixture({markup}),token=await f.seal();
    assert.equal((await f.call('click',{token,identity:f.identity})).favorited,true);assert.equal(f.clicks,1);
  }
});

test('hidden, disabled, occluded and out-of-viewport controls are never clicked',async()=>{
  for(const change of [f=>{f.button.hidden=true;},f=>f.button.setAttribute('disabled',''),
    f=>f.button.setAttribute('aria-disabled','true'),f=>{f.button.style.pointerEvents='none';},
    f=>{f.document.elementFromPoint=()=>f.document.querySelector('.outside');},
    f=>Object.defineProperty(f.button,'getBoundingClientRect',{value:()=>({left:1100,right:1200,top:0,bottom:50,width:100,height:50})}),
    f=>{const modal=f.document.createElement('div');modal.setAttribute('role','dialog');bounds(modal);f.document.body.append(modal);},
  ]){
    const f=fixture(),token=await f.seal();change(f);
    const result=await f.call('click',{token,identity:f.identity});assert.equal(result.ok,false);assert.equal(result.attempted,false);assert.equal(f.clicks,0);
  }
});

test('atomic final check catches synchronous identity changes during hit testing before dispatch',async()=>{
  const f=fixture(),token=await f.seal();
  f.document.elementFromPoint=()=>{f.base.userId='222';return f.button;};
  const result=await f.call('click',{token,identity:f.identity});
  assert.equal(result.reason,'identity_changed');assert.equal(result.attempted,false);assert.equal(f.clicks,0);
});

test('a synchronous click failure or candidate switch is uncertain and never dispatches twice',async()=>{
  for(const callback of [()=>{throw Error('PRIVATE secret_api_key=never-return');},f=>{f.base.userId='222';}]){
    const f=fixture(),token=await f.seal();f.onClick(()=>callback(f));
    const result=await f.call('click',{token,identity:f.identity});assert.equal(result.status,'uncertain');assert.equal(result.attempted,true);
    assert.equal((await f.call('click',{token,identity:f.identity})).status,'uncertain');assert.equal(f.clicks,1);
  }
});

test('uncertain clicks survive stop and reset without another click, and late saved state can be reconciled',async()=>{
  const f=fixture(),token=await f.seal();f.onClick(()=>{});
  assert.equal((await f.call('click',{token,identity:f.identity})).reason,'confirmation_timeout');
  assert.equal(f.clicks,1);assert.equal(f.sleeps,39);
  await f.call('stop');await f.call('reset');assert.equal((await f.prepare()).status,'uncertain');assert.equal(f.clicks,1);
  f.button.textContent='已收藏';const recovered=await f.seal();
  assert.deepEqual(await f.call('click',{token:recovered,identity:f.identity}),{ok:true,status:'confirmed',favorited:true,already:true,attempted:false,...ids(f)});
  assert.equal(f.clicks,1);
});

test('confirmed but unacknowledged favorite can obtain a read-only reconciliation receipt after reset',async()=>{
  const f=fixture(),token=await f.seal();assert.equal((await f.call('click',{token,identity:f.identity})).favorited,true);
  await f.call('reset');const recovered=await f.seal();
  assert.equal((await f.call('verify',{token:recovered,identity:f.identity})).verified,true);
  f.button.textContent='收藏';assert.equal((await f.call('click',{token:recovered,identity:f.identity})).status,'uncertain');assert.equal(f.clicks,1);
  f.button.textContent='已收藏';assert.equal((await f.call('click',{token:recovered,identity:f.identity})).already,true);assert.equal(f.clicks,1);
});

test('loading after a click only waits and confirms the same UID; loading before dispatch blocks',async()=>{
  const f=fixture(),token=await f.seal();f.onClick(()=>{f.root.loading=true;});
  f.onSleep(()=>{f.root.loading=false;f.button.textContent='已收藏';});
  assert.equal((await f.call('click',{token,identity:f.identity})).favorited,true);assert.equal(f.clicks,1);assert.equal(f.sleeps,1);
  const switched=fixture(),before=await switched.seal();
  switched.onClick(()=>{switched.root.loading=true;switched.base.userId='222';});
  assert.equal((await switched.call('click',{token:before,identity:switched.identity})).status,'uncertain');assert.equal(switched.clicks,1);
});

test('stop and reset revoke unused receipts, while token-scoped cleanup cannot stop a later task',async()=>{
  for(const action of ['stop','reset']){
    const f=fixture(),token=await f.seal();await f.call(action);if(action==='stop')await f.call('reset');
    assert.equal((await f.call('click',{token,identity:f.identity})).ok,false);assert.equal(f.clicks,0);
  }
  const f=fixture(),old=await f.seal(),fresh=await f.seal();
  await f.call('stop',{token:old});
  assert.equal((await f.call('click',{token:fresh,identity:f.identity})).favorited,true);assert.equal(f.clicks,1);
});

test('same document tokens do not authorize another document and optional returned UID is exact',async()=>{
  const f=fixture(),token=await f.seal(),other=fixture();
  assert.equal((await other.call('click',{token,identity:f.identity})).reason,'token_invalid');assert.equal(other.clicks,0);
  assert.equal((await f.call('verify',{token,identity:f.identity,expected_boss_chat_uid:'222'})).reason,'identity_changed');assert.equal(f.clicks,0);
});

test('explicit token cleanup releases the detached DOM without forgetting an attempted click',async()=>{
  const f=fixture(),token=await f.seal();
  assert.equal((await f.call('click',{token,identity:f.identity})).favorited,true);
  const state=f.window.__hrmResumeFavoriteStateV1;
  assert.equal(state.tokens.get(token).snapshot.canvas,f.canvas);
  await f.call('stop',{token});
  assert.equal(state.tokens.get(token).snapshot,null);assert.equal(state.attempted.size,1);
  assert.equal((await f.call('click',{token,identity:f.identity})).status,'uncertain');
  const recovered=await f.seal();
  assert.equal((await f.call('click',{token:recovered,identity:f.identity})).already,true);assert.equal(f.clicks,1);
});
