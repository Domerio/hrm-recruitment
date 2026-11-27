import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {identifyBackgroundResume,verifyBackgroundIdentity,backgroundResumeFrame} from '../extension/background-read.mjs';

const identity={version:1,name:'唐明鑫',canvasId:'current-canvas',headerKey:'["唐明鑫","39岁本科10年以上"]'};
const binding={...identity,documentId:'current-document'};
function harness(options={}){
  let atTop=false,samples=0,contents=0,stopped=false;
  const actions=[],pauses=[];
  const tab={id:8,url:'https://www.zhipin.com/web/chat/recommend',active:false};
  const browser={tabs:{get:async()=>({...tab,...(options.discarded?{discarded:true}:{})})},
    scripting:{executeScript:async({target,world,func,args})=>{
      assert.deepEqual(target,{tabId:8,documentIds:['current-document']});assert.equal(world,'MAIN');assert.equal(func,backgroundResumeFrame);
      const [action,arg]=args;actions.push({action,...arg});
      if(action==='cleanup')return [];
      if(action==='top'){assert.equal(arg.resetCanvas,true);atTop=true;return [{documentId:'current-document',result:{}}];}
      if(action==='prepare')assert.equal(arg.discoverIdentity,true);
      samples++;
      const baseline=!options.noBaseline&&samples>(options.baselineDelay||0);
      const result={version:1,canvasId:'current-canvas',revision:samples,text:'',marks:[],
        diagnostics:{baseline,entries:20,operations:{}},
        geometry:{scrollMode:'native',scrollTop:atTop?0:300,clientHeight:500,scrollHeight:1000,contentTopVisible:atTop},
        ...(!baseline?{issue:'缺少完整绘制',issueCode:'baseline'}:!atTop||options.noHeader?{issue:'当前页首未确认',issueCode:'identity'}:
          {identity:options.changed?{...identity,headerKey:'["唐明鑫","40岁本科11年以上"]'}:identity})};
      if(action==='content'){
        assert.deepEqual(arg.identity,identity);contents++;
        delete result.identity;
        result.text=(options.contentTexts||['唐明鑫\n39岁 本科 10年以上\n工作经历\n负责合成视觉软件和自动化测试。'])[Math.min(contents-1,(options.contentTexts?.length||1)-1)];
        result.boundaryRows={top:options.topBoundary===true,bottom:options.bottomBoundary===true};
        if(options.contentIssue)Object.assign(result,{issue:options.contentIssue,issueCode:'unsupported'});
        if(options.contentWidth===false)result.geometry.contentWidthVisible=false;
      }
      if(options.canvasChange&&samples>1)result.canvasId='another-canvas';
      return [{documentId:options.documentChange&&samples>1?'other-document':'current-document',result}];
    }}};
  for(const key of ['debugger','windows','clipboard'])Object.defineProperty(browser,key,{get(){throw Error('Forbidden '+key);}});
  const args={browser,tab,documentId:'current-document',pause:async ms=>{pauses.push(ms);if(options.stop)stopped=true;},check:()=>{if(stopped)throw Error('已停止');}};
  return {actions,pauses,identify:()=>identifyBackgroundResume(args),verify:extra=>verifyBackgroundIdentity({...args,identity:binding,...extra})};
}

test('discovers only the current canvas header after returning from a middle screen with two stable observations',async()=>{
  const h=harness(),result=await h.identify();
  assert.deepEqual(result,{name:identity.name,identity:binding});
  assert.deepEqual(h.actions.map(item=>item.action),['prepare','top','identity','identity','cleanup']);
  assert.ok(h.actions.every(item=>!['name','source_card','signature'].some(key=>Object.hasOwn(item,key))));
});

test('late injection without a recorded baseline pauses without scrolling, guessing or reopening',async()=>{
  const h=harness({noBaseline:true}),result=await h.identify();
  assert.equal(result.issueCode,'baseline');assert.match(result.issue,/手动关闭并重新打开同一份简历/);
  assert.equal(result.name,undefined);assert.equal(result.identity,undefined);
  assert.ok(!h.actions.some(item=>item.action==='top'));assert.equal(h.actions.at(-1).action,'cleanup');
  assert.equal(h.pauses.length,20);
});

test('an initial real redraw may establish a baseline but no header or changed document never creates a binding',async()=>{
  assert.deepEqual((await harness({baselineDelay:2}).identify()).identity,binding);
  const h=harness({noHeader:true}),result=await h.identify();
  assert.equal(result.issueCode,'identity');assert.equal(result.identity,undefined);
  for(const options of [{documentChange:true},{canvasChange:true},{stop:true},{discarded:true}]){
    const changing=harness(options);await assert.rejects(changing.identify());
    assert.equal(changing.actions.at(-1).action,'cleanup');
  }
});

test('post-model identity verification matches the complete original header binding, including metadata',async()=>{
  const success=await harness().verify();assert.equal(success.ok,true);assert.deepEqual(success.identity,binding);
  const changed=await harness({changed:true}).verify();assert.equal(changed.ok,false);
  assert.match(changed.issue,/页首资料已变化/);assert.equal(changed.identity,undefined);
  assert.doesNotMatch(JSON.stringify(changed.diagnostics),/headerKey|唐明鑫|39岁|40岁/);
});

test('a content witness binds exact stable visible text and rejects a same-header candidate with different body text',async()=>{
  const first=harness(),bound=await first.verify({bindContent:true});
  assert.equal(bound.ok,true);assert.match(bound.contentKey,/^sha256:[a-f0-9]{64}$/);
  assert.equal(first.actions.filter(item=>item.action==='content').length,2);
  assert.equal((await harness().verify({contentKey:bound.contentKey})).ok,true);
  const changed=await harness({contentTexts:['唐明鑫\n39岁 本科 10年以上\n工作经历\n另一份合成履历的正文。']}).verify({contentKey:bound.contentKey});
  assert.equal(changed.ok,false);assert.match(changed.issue,/顶部原文已变化/);
  assert.equal(changed.contentKey,undefined);assert.doesNotMatch(JSON.stringify(changed.diagnostics),/contentKey|唐明鑫|另一份/);
  assert.equal((await harness().verify()).contentKey,undefined,'ordinary header verification does not acquire body text');
  await assert.rejects(harness().verify({contentKey:'untrusted'}),/原文见证无效/);
});

test('content witnesses retain drawing/fold/width checks and allow only stable deferred bottom rows',async()=>{
  const deferred=await harness({bottomBoundary:true}).verify({bindContent:true});assert.equal(deferred.ok,true);
  assert.equal((await harness({bottomBoundary:true}).verify({contentKey:deferred.contentKey})).ok,true);
  assert.equal((await harness().verify({contentKey:deferred.contentKey})).ok,false);
  for(const options of [{contentIssue:'画布含无法确认的正文图片'},{contentIssue:'画布字形重叠'},
    {topBoundary:true},{contentWidth:false},{contentTexts:['唐明鑫\n39岁 本科 10年以上\n查看全部']}]){
    const result=await harness(options).verify({bindContent:true});assert.equal(result.ok,false);assert.equal(result.contentKey,undefined);
  }
  const unstable=await harness({contentTexts:Array.from({length:10},(_,i)=>'唐明鑫\n39岁 本科 10年以上\n不同的合成正文'+i)}).verify({bindContent:true});
  assert.equal(unstable.ok,false);assert.match(unstable.issue,/持续变化/);
});

test('the real frame identity adapter resets both native and preexisting internal scroll without clicking or using body text',()=>{
  const events=[];let nativeTop=14,internalMiddle=true;
  const root={clientWidth:773,clientHeight:956,scrollHeight:956,scrollTop:0,isConnected:true,parentElement:null};
  const owner={clientWidth:773,clientHeight:956,scrollHeight:970,isConnected:true,parentElement:root,
    offsetWidth:773,offsetHeight:956,clientLeft:0,clientTop:0,
    get scrollTop(){return nativeTop;},set scrollTop(value){nativeTop=Math.max(0,Math.min(14,value));},
    getBoundingClientRect:()=>({left:0,top:0,width:773,height:956}),dispatchEvent:event=>{events.push(event.type);}};
  const canvas={width:773,height:956,isConnected:true,parentElement:owner,
    getBoundingClientRect:()=>({left:0,top:0,right:773,bottom:956,width:773,height:956}),
    dispatchEvent:event=>{events.push(event.type);if(event.type==='wheel'&&event.deltaY<0)internalMiddle=false;}};
  const document={body:{innerText:'背景列表 庄宇宁 29岁 硕士 5年'},documentElement:root,scrollingElement:root,
    querySelectorAll:()=>[canvas],elementFromPoint:()=>canvas};
  let ordinaryReads=0;
  const window={__hrmCanvasText:{version:1,snapshot(options){ordinaryReads++;assert.equal(options.expectedName,identity.name);
    return {version:1,canvasId:'current-canvas',revision:1,text:'当前完整顶部原文',diagnostics:{baseline:true}};
  },identity(){
    return {version:1,canvasId:'current-canvas',revision:1,text:'',diagnostics:{baseline:true},
      ...(internalMiddle?{issue:'当前在中段',issueCode:'identity'}:{identity})};
  }}};window.top=window;
  class Event{constructor(type,options){this.type=type;Object.assign(this,options);}}
  const sandbox=vm.createContext({window,document,innerWidth:773,innerHeight:956,Event,PointerEvent:Event,MouseEvent:Event,WheelEvent:Event,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:element=>element===canvas?{visibility:'visible',opacity:'1'}:element===owner?{overflowY:'auto',overflowX:'hidden'}:{overflowY:'hidden'}});
  const frame=vm.runInContext('('+backgroundResumeFrame.toString()+')',sandbox);
  const prepared=frame('prepare',{token:'identity-session',discoverIdentity:true});assert.equal(prepared.issueCode,'identity');
  frame('top',{token:'identity-session',resetCanvas:true});
  const actual=frame('identity',{token:'identity-session'});
  assert.equal(nativeTop,0);assert.equal(internalMiddle,false);assert.equal(actual.identity.name,'唐明鑫');
  assert.equal(ordinaryReads,0,'identity discovery never samples arbitrary body text');
  assert.equal(frame('content',{token:'identity-session',identity}).text,'当前完整顶部原文');assert.equal(ordinaryReads,1);
  const wrong=frame('content',{token:'identity-session',identity:{...identity,headerKey:'changed'}});
  assert.match(wrong.issue,/身份已变化/);assert.equal(ordinaryReads,1);
  assert.ok(events.includes('wheel'));assert.ok(!events.some(type=>/click|mousedown|mouseup|pointerdown|pointerup/.test(type)));
  frame('cleanup',{token:'identity-session'});assert.equal(window.__hrmBackgroundRead,undefined);
});
