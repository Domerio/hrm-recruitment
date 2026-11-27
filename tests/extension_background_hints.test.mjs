import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {backgroundResumeFrame,readBackgroundResume} from '../extension/background-read.mjs';

const mark={id:1,kind:'latest-work',x:.8,y:.3};
const anchor='工作经历 虚构设备公司 视觉工程师 2019.05 - 2025.08';
const note={kind:'latest_work_may_be_outdated',text:'最近一份工作经历可能未更新',section:'工作经历',anchor};
const footer='为妥善保护牛人在BOSS直聘平台提交的简历信息，未经授权不得在任何第三方平台进行复制、使用、传播、存储。';
const body='张**\n30岁 8年 本科\n'+anchor+'\n独立负责机器视觉研发。\n'+footer;
const unknown='画布含无法确认是否属于正文的图片，不能完整读取原文';

function frameFixture(options={}){
  const root={isConnected:true,parentElement:null,clientHeight:600,clientWidth:800,scrollHeight:600,scrollTop:0};
  const owner={isConnected:true,parentElement:root,clientHeight:500,clientWidth:550,scrollHeight:1000,scrollTop:0,
    clientLeft:0,clientTop:0,offsetWidth:550,offsetHeight:500,getBoundingClientRect:()=>({left:0,top:0,width:550,height:500})};
  let canvas={isConnected:true,parentElement:owner,width:1100,height:2000,
    getBoundingClientRect:()=>({left:0,top:-owner.scrollTop,right:550,bottom:1000-owner.scrollTop,width:550,height:1000})};
  let approved=false,hovering=false;
  const events=[],calls=[];
  canvas.dispatchEvent=event=>{
    events.push(event);
    if(event.type==='pointermove')hovering=Math.abs(event.clientX-440)<1&&Math.abs(event.clientY-300)<1;
    if(!options.pointerMoveOnly&&event.type==='pointerleave')hovering=false;
    return true;
  };
  const document={body:{innerText:''},scrollingElement:root,querySelectorAll:()=>[canvas],elementFromPoint:()=>canvas};
  Object.defineProperty(document,'hasFocus',{get(){throw Error('No focus dependency');}});
  const window={__hrmCanvasText:{version:1,
    snapshot:()=>({version:1,canvasId:'canvas-1',revision:events.length+1,marks:[],
      text:approved?body:hovering?'PRIVATE INTERMEDIATE TOOLTIP':'',
      ...(approved?{platformNotes:[note]}:{issue:unknown,issueCode:'unsupported',hintMarks:[options.mark||mark]})}),
    hint:(action,args)=>{
      calls.push({action,args});
      if(action==='begin')return {ok:options.begin!==false,
        leavePoint:Object.hasOwn(options,'leavePoint')?options.leavePoint:{x:.05,y:.05}};
      if(action==='probe')return {ready:hovering&&options.ready!==false};
      if(action==='finish'){
        if(options.restore===false||hovering)return {ok:false};
        approved=true;return {ok:true};
      }
      return {};
    }}};window.top=window;
  class Event {constructor(type,values){this.type=type;Object.assign(this,values);}}
  const sandbox=vm.createContext({window,document,innerWidth:800,innerHeight:600,MouseEvent:Event,PointerEvent:Event,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:element=>element===canvas?{visibility:'visible',opacity:'1'}:
      element===owner?{overflowY:'auto',overflowX:'hidden'}:{overflowY:'hidden'}});
  const run=vm.runInContext('('+backgroundResumeFrame.toString()+')',sandbox);
  return {run:(action,args={})=>run(action,{token:'fixed',name:'张**',...args}),events,calls,document,owner,window,
    replaceCanvas:()=>{canvas={...canvas};}};
}

test('the frame reads a hint with pointer movement and restores it without activating an inquiry',()=>{
  const f=frameFixture();f.run('prepare');
  assert.equal(f.run('hint-hover',{mark}).ok,true);
  assert.equal(f.run('hint-probe').ready,true);
  assert.equal(f.run('hint-leave').ok,true);
  const finished=f.run('hint-finish');assert.equal(finished.ok,true);assert.equal(finished.sample.text,body);
  assert.deepEqual(f.events.map(event=>event.type),['pointerover','pointermove','mouseover','mousemove','pointermove','mousemove','pointerout','pointerleave','mouseout','mouseleave']);
  for(const [index,event] of f.events.entries()){
    assert.equal(event.clientX,index<4?440:27.5);assert.equal(event.clientY,index<4?300:50);assert.equal(event.buttons,0);
  }
  assert.deepEqual(f.calls.map(call=>call.action),['begin','probe','finish']);
  assert.equal(f.calls[0].args.expectedName,'张**');
  assert.deepEqual({...f.calls[0].args.rect},{x:0,y:0,width:1100,height:1000});
  f.run('cleanup');assert.equal(f.calls.at(-1).action,'cancel');
});

test('stale, offscreen, unrelated, obscured or unproved hint marks produce no hover',()=>{
  for(const mode of ['moved','id','kind','offscreen','obscured','unproved']){
    const current=mode==='kind'?{...mark,kind:'inquiry-click'}:mode==='offscreen'?{...mark,y:.8}:mark;
    const f=frameFixture({mark:current,begin:mode!=='unproved'});f.run('prepare');
    if(mode==='obscured')f.document.elementFromPoint=()=>({});
    const requested=mode==='moved'?{...current,x:.7}:mode==='id'?{...current,id:2}:current;
    assert.throws(()=>f.run('hint-hover',{mark:requested}),/未执行悬停/);
    assert.equal(f.events.length,0);
  }
});

test('missing, invalid, offscreen, identical or obscured leave points cancel before hover input',()=>{
  for(const leavePoint of [undefined,null,{}, {x:NaN,y:.05},{x:.05,y:Infinity},{x:0,y:.05},{x:1,y:.05},
    {x:.05,y:.8},{x:mark.x,y:mark.y}]){
    const f=frameFixture({leavePoint});f.run('prepare');
    assert.throws(()=>f.run('hint-hover',{mark}),/空白位置/);
    assert.equal(f.calls.at(-1).action,'cancel');assert.equal(f.events.length,0);
  }
  const f=frameFixture();f.run('prepare');const hit=f.document.elementFromPoint;
  f.document.elementFromPoint=(x,y)=>x<100?{}:hit(x,y);
  assert.throws(()=>f.run('hint-hover',{mark}),/空白位置/);assert.equal(f.events.length,0);
});

test('a pointermove-only renderer collapses through the verified blank point without a click',()=>{
  const f=frameFixture({pointerMoveOnly:true});f.run('prepare');f.run('hint-hover',{mark});
  assert.equal(f.run('hint-probe').ready,true);f.run('hint-leave');
  assert.equal(f.run('hint-finish').ok,true);
  assert.deepEqual(f.events.filter(event=>event.type==='pointermove').map(event=>[event.clientX,event.clientY]),[[440,300],[27.5,50]]);
  assert.ok(f.events.every(event=>!['click','mousedown','mouseup','pointerdown','pointerup'].includes(event.type)));
});

test('a newly obscured blank point cannot receive leave movement',()=>{
  const f=frameFixture();f.run('prepare');f.run('hint-hover',{mark});f.run('hint-probe');
  const hit=f.document.elementFromPoint,count=f.events.length;
  f.document.elementFromPoint=(x,y)=>x<100?{}:hit(x,y);
  assert.throws(()=>f.run('hint-leave'),/空白位置/);assert.equal(f.events.length,count);
});

test('probe, leave and finish cannot continue after geometry, hit point, canvas or session changes',()=>{
  for(const action of ['hint-probe','hint-leave','hint-finish'])for(const mode of ['position','obscured','canvas','session','verification']){
    const f=frameFixture();f.run('prepare');f.run('hint-hover',{mark});
    if(action!=='hint-probe')f.run('hint-probe');
    if(action==='hint-finish')f.run('hint-leave');
    const eventCount=f.events.length,callCount=f.calls.length;
    if(mode==='position')f.owner.scrollTop=10;
    if(mode==='obscured')f.document.elementFromPoint=()=>({});
    if(mode==='canvas')f.replaceCanvas();
    if(mode==='session')f.window.__hrmBackgroundRead.token='changed';
    if(mode==='verification')f.document.body.innerText='请完成安全验证';
    assert.throws(()=>f.run(action),/发生变化|位置|人工登录或验证/);
    assert.equal(f.calls.length,callCount);assert.equal(f.events.length,eventCount);
  }
});

test('a complete hover result and a restored body are both required before hint approval',()=>{
  const f=frameFixture({ready:false});f.run('prepare');f.run('hint-hover',{mark});
  assert.throws(()=>f.run('hint-leave'),/尚未读取/);assert.throws(()=>f.run('hint-finish'),/尚未恢复/);
  assert.equal(f.run('hint-probe').ready,false);assert.throws(()=>f.run('hint-leave'),/尚未读取/);
  f.run('hint-cancel');assert.equal(f.calls.at(-1).action,'cancel');
  assert.equal(f.events.filter(event=>event.type==='pointerleave').length,1);
  const g=frameFixture({restore:false});g.run('prepare');g.run('hint-hover',{mark});g.run('hint-probe');g.run('hint-leave');
  assert.equal(g.run('hint-finish').ok,false);assert.equal(g.run('sample').text,'');
});

test('cleanup cancels an interrupted hover and sends no activating mouse events',()=>{
  const f=frameFixture();f.run('prepare');f.run('hint-hover',{mark});f.run('cleanup');
  assert.equal(f.calls.at(-1).action,'cancel');assert.equal(f.window.__hrmBackgroundRead,undefined);
  assert.equal(f.events.filter(event=>event.type==='pointerleave').length,1);
  assert.ok(f.events.every(event=>!['click','mousedown','mouseup','pointerdown','pointerup'].includes(event.type)));
});

test('cleanup only clears observer state when canvas, geometry or leave point has changed',()=>{
  for(const mode of ['canvas','geometry','obscured','verification']){
    const f=frameFixture();f.run('prepare');f.run('hint-hover',{mark});const count=f.events.length;
    if(mode==='canvas')f.replaceCanvas();
    if(mode==='geometry')f.owner.scrollTop=10;
    if(mode==='obscured')f.document.elementFromPoint=()=>({});
    if(mode==='verification')f.document.body.innerText='请完成安全验证';
    f.run('cleanup');
    assert.equal(f.events.length,count);assert.equal(f.calls.at(-1).action,'cancel');
    assert.equal(f.window.__hrmBackgroundRead,undefined);
  }
});

function readerFixture(options={}){
  const actions=[],reports=[],pauses=[];
  const tab={id:7,url:'https://www.zhipin.com/web/chat/search',active:false};
  let approved=Boolean(options.manual),hovering=false,probes=0,finishes=0,tops=0,stopped=false;
  let offset=0;
  const texts=options.texts||[body],hints=options.notes||[note];
  const geometry=()=>({scrollMode:'native',scrollTop:offset*275,scrollPositions:[offset*275],clientHeight:500,
    scrollHeight:(texts.length-1)*275+500,contentTopVisible:offset===0,contentBottomVisible:offset===texts.length-1,contentWidthVisible:true});
  const sample=()=>({version:1,canvasId:'canvas-1',revision:actions.length,geometry:geometry(),marks:[],
    ...(approved?{text:texts[offset],platformNotes:hints}:{text:'',issue:unknown,issueCode:'unsupported',hintMarks:[mark],
      diagnostics:{baseline:true,entries:525}})});
  const browser={tabs:{get:async()=>tab},scripting:{executeScript:async({target,world,func,args})=>{
    assert.deepEqual(target,{tabId:7,documentIds:['resume-7']});assert.equal(world,'MAIN');assert.equal(func,backgroundResumeFrame);
    const [action,arg]=args;actions.push(action);let result;
    if(action==='cleanup')return [];
    if(action==='hint-hover'){assert.deepEqual(arg.mark,mark);hovering=true;result={ok:true};}
    else if(action==='hint-probe'){probes++;result={ready:options.noTooltip!==true&&probes>(options.delayProbe||0)};}
    else if(action==='hint-leave'){hovering=false;result={ok:true};}
    else if(action==='hint-finish'){
      finishes++;approved=options.noRestore!==true&&finishes>(options.delayRestore||0);
      result=approved?{ok:true,sample:sample()}:{ok:false};
    }else if(action==='hint-cancel'){hovering=false;result=true;}
    else if(action==='top'){tops++;offset=0;if(options.redrawAtTop||options.foreverNewPaint)approved=false;result={geometry:geometry()};}
    else if(action==='next'){
      offset=Math.min(offset+1,texts.length-1);
      if(options.foreverNewPaint)approved=false;
      result={geometry:geometry()};
    }else result=sample();
    if(hovering&&action==='sample')result.text='PRIVATE INTERMEDIATE TOOLTIP';
    return [{documentId:'resume-7',result}];
  }}};
  for(const key of ['windows','debugger','clipboard'])Object.defineProperty(browser,key,{get(){throw Error('Forbidden '+key);}});
  return {actions,reports,pauses,read:()=>readBackgroundResume({browser,tab,documentId:'resume-7',name:'张**',report:value=>reports.push(value),
    check:()=>{if(stopped)throw Error('任务已停止');},pause:async ms=>{pauses.push(ms);if(options.stopAtPause===pauses.length)stopped=true;}})};
}

test('hint intermediate frames never enter the resume and the note is returned separately once',async()=>{
  const f=readerFixture({delayProbe:2,delayRestore:2}),result=await f.read();
  assert.equal(result.issue,undefined);assert.equal(result.resume,body);assert.equal(result.screens,1);
  assert.deepEqual(result.platformNotes,[note]);assert.equal(result.completeness.allScreensRead,true);
  assert.ok(!result.resume.includes(note.text));assert.ok(!result.resume.includes('PRIVATE'));
  assert.equal(f.actions.filter(action=>action==='hint-probe').length,3);
  assert.equal(f.actions.filter(action=>action==='hint-finish').length,3);
  assert.ok(f.reports.some(value=>value.includes('平台提示')));assert.equal(f.actions.at(-1),'cleanup');
});

test('a redraw at top is reverified while already expanded manual notes need no generated hover',async()=>{
  const f=readerFixture({redrawAtTop:true}),result=await f.read();
  assert.equal(result.issue,undefined);assert.equal(f.actions.filter(action=>action==='hint-hover').length,2);
  assert.deepEqual(result.platformNotes,[note]);
  const g=readerFixture({manual:true}),manual=await g.read();assert.equal(manual.issue,undefined);
  assert.deepEqual(manual.platformNotes,[note]);assert.ok(!g.actions.includes('hint-hover'));
});

test('an ineffective synthetic hover pauses after ten probes with explicit manual guidance',async()=>{
  const f=readerFixture({noTooltip:true}),result=await f.read();
  assert.match(result.issue,/鼠标悬停/);assert.equal(result.resume,'');assert.equal(result.platformNotes,undefined);
  assert.equal(result.completeness.allScreensRead,false);assert.equal(f.actions.filter(action=>action==='hint-probe').length,10);
  assert.ok(f.actions.includes('hint-cancel'));assert.ok(!f.actions.includes('hint-finish'));
});

test('failure to restore the original page never admits hover text or notes',async()=>{
  const f=readerFixture({noRestore:true}),result=await f.read();
  assert.match(result.issue,/未恢复/);assert.equal(result.resume,'');assert.equal(result.platformNotes,undefined);
  assert.equal(f.actions.filter(action=>action==='hint-finish').length,10);assert.ok(f.actions.includes('hint-cancel'));
});

test('stopping while the tooltip is pending cancels without issuing inquiry actions',async()=>{
  const f=readerFixture({delayProbe:5,stopAtPause:2});await assert.rejects(f.read(),/任务已停止/);
  assert.equal(f.actions.at(-1),'cleanup');assert.ok(!f.actions.includes('hint-finish'));
  assert.ok(!f.actions.includes('expand'));
});

test('notes must have fixed semantics and point to an exact raw work row in the final resume',async()=>{
  for(const altered of [{...note,kind:'unknown'},{...note,text:'确定存在履历问题'},{...note,section:'教育经历'},
    {...note,anchor:''},{...note,anchor:'x'.repeat(1001)},{...note,anchor:'已变化的公司 2018 - 2020'}]){
    const result=await readerFixture({notes:[altered]}).read();
    assert.match(result.issue,/平台提示/);assert.equal(result.platformNotes,undefined);
  }
});

test('only whitelisted note fields survive success and duplicate notes remain one record',async()=>{
  const result=await readerFixture({notes:[{...note,sourceUrl:'private-source',paintIdentity:'private-id'},note]}).read();
  assert.equal(result.issue,undefined);assert.deepEqual(result.platformNotes,[note]);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('successive repaints cannot cause unbounded platform hint interactions',async()=>{
  // Independent synthetic anchors: each seam has enough varied, unique raw
  // letters, so only the hint interaction limit (not overlap ambiguity) stops.
  let seed=29;
  const seams=Array.from({length:11},()=>Array.from({length:70},()=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;return String.fromCharCode(65+(seed>>>16)%26);
  }).join(''));
  const texts=Array.from({length:12},(_,i)=>(i===0?'张**\n'+anchor+'\n':seams[i-1]+'\n')+
    '项目 '+i+'\n'+(i===11?footer:seams[i]));
  const f=readerFixture({texts,foreverNewPaint:true});const result=await f.read();
  assert.match(result.issue,/读取上限/);assert.equal(result.platformNotes,undefined);
  assert.equal(f.actions.filter(action=>action==='hint-hover').length,8);
});
