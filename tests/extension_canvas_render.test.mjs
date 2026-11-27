import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {backgroundResumeFrame} from '../extension/background-read.mjs';

const renderSource=fs.readFileSync(new URL('../extension/canvas-render.js',import.meta.url),'utf8');
const geometrySource=fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8');
const observerSource=fs.readFileSync(new URL('../extension/canvas-text.js',import.meta.url),'utf8');

// Native scheduling is deliberately withheld. Callback execution and canvas
// observation are real script behavior; this is not evidence that every real
// browser/page will continue painting while minimized or visibility-gated.
function fixture({hidden=true,armed=true,protocol='https:',hostname='www.zhipin.com',
  pathname='/web/frame/c-resume/',missing,observer=false}={}) {
  let clock=0,nextId=1;
  const nativeQueue=new Map(),captured=new Map(),cancelled=[],errors=[],timers=[];
  class Canvas {
    constructor(){this._width=1000;this._height=700;this.isConnected=true;this.ctx=null;}
    get width(){return this._width;} set width(value){this._width=value;}
    get height(){return this._height;} set height(value){this._height=value;}
    getBoundingClientRect(){return {left:0,top:0,right:1000,bottom:700,width:1000,height:700};}
    getContext(){return this.ctx||(this.ctx=new Context(this));}
  }
  class Context {
    constructor(canvas){
      this.canvas=canvas;this.globalAlpha=1;this.fillStyle='#000000';this.strokeStyle='#000000';
      this.globalCompositeOperation='source-over';this.direction='ltr';this.textAlign='start';this.textBaseline='alphabetic';
      this.filter='none';this.lineWidth=1;this.font='14px sans-serif';
    }
    fillText(){} strokeText(){} clearRect(){} fillRect(){} drawImage(){} putImageData(){}
    save(){} restore(){} clip(){} reset(){} beginPath(){} moveTo(){} lineTo(){} rect(){} closePath(){}
    arc(){} arcTo(){} ellipse(){} roundRect(){} fill(){} stroke(){} strokeRect(){}
    getTransform(){return {a:1,b:0,c:0,d:1,e:0,f:0};}
    measureText(text){const width=text.length*10;return {width,actualBoundingBoxLeft:0,actualBoundingBoxRight:width,
      actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};}
  }
  const canvas=new Canvas();
  const document={querySelectorAll:()=>[canvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  Object.defineProperties(document,{
    hidden:{get:()=>hidden},visibilityState:{get:()=>hidden?'hidden':'visible'},
    hasFocus:{get(){throw Error('Background rendering must not depend on focus');}},
  });
  const nativeRequest=function(callback){
    if(typeof callback!=='function')throw new TypeError('Callback must be a function');
    const id=nextId++;nativeQueue.set(id,callback);captured.set(id,callback);return id;
  };
  const nativeCancel=function(id){
    if(!arguments.length)throw new TypeError('Cancel requires a handle');
    const handle=+id>>>0;cancelled.push(handle);nativeQueue.delete(handle);
  };
  const sandbox={document,location:{protocol,hostname,pathname},performance:{now:()=>clock},
    requestAnimationFrame:nativeRequest,cancelAnimationFrame:nativeCancel,reportError:error=>errors.push(error),
    setTimeout:callback=>{timers.push(callback);return timers.length;},
    __hrmCanvasTextEnabled:armed,CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'})};
  sandbox.window=sandbox;sandbox.top=sandbox;
  if(missing)delete sandbox[missing];
  const originalRequest=sandbox.requestAnimationFrame,originalCancel=sandbox.cancelAnimationFrame;
  const context=vm.createContext(sandbox);
  if(observer){vm.runInContext(geometrySource,context);vm.runInContext(observerSource,context);}
  vm.runInContext(renderSource,context);
  const api=sandbox.__hrmCanvasRender;
  return {window:sandbox,document,canvas,context,api,nativeQueue,cancelled,errors,timers,originalRequest,originalCancel,
    advance:ms=>{clock+=ms;},arm:token=>{sandbox.__hrmBackgroundRead={token};},
    fire:(id,timestamp=clock)=>{const callback=nativeQueue.get(id);nativeQueue.delete(id);if(callback)callback.call(sandbox,timestamp);},
    late:(id,timestamp=clock)=>captured.get(id)?.call(sandbox,timestamp),
    stop:()=>{api?.stop();sandbox.__hrmCanvasText?.stop();}};
}

test('render helper only installs in the armed exact BOSS resume frame',()=>{
  for(const options of [{armed:false},{protocol:'http:'},{hostname:'zhipin.com.evil.test'},
    {pathname:'/web/chat/search'},{pathname:'/web/frame/c-resume-other'}]){
    const f=fixture(options);assert.equal(f.api,undefined);
    assert.equal(f.window.requestAnimationFrame,f.originalRequest);assert.equal(f.window.cancelAnimationFrame,f.originalCancel);
  }
  for(const missing of ['requestAnimationFrame','cancelAnimationFrame','performance']){
    const f=fixture({missing});assert.equal(f.window.requestAnimationFrame,f.originalRequest);
    assert.equal(f.window.cancelAnimationFrame,f.originalCancel);f.stop();
  }
});

test('only the active read token can pump overdue callbacks, without changing visibility or focus',()=>{
  const f=fixture();let calls=0;
  f.window.requestAnimationFrame(()=>calls++);f.advance(200);
  f.api.pump('missing');assert.equal(calls,0);
  f.arm('active');f.api.pump('other');assert.equal(calls,0);
  const report=f.api.pump('active');assert.equal(calls,1);assert.equal(report.hidden,true);
  assert.equal(f.document.hidden,true);assert.equal(f.document.visibilityState,'hidden');
  f.window.requestAnimationFrame(()=>calls++);delete f.window.__hrmBackgroundRead;f.advance(200);
  f.api.pump('active');assert.equal(calls,1);f.stop();
});

test('reinstalling preserves the existing native queue and wraps each callback only once',()=>{
  const f=fixture({hostname:'zhipin.com',pathname:'/web/frame/c-resume'});f.arm('read');let calls=0;
  const wrappedRequest=f.window.requestAnimationFrame;
  f.window.requestAnimationFrame(()=>calls++);vm.runInContext(renderSource,f.context);
  assert.equal(f.window.__hrmCanvasRender,f.api);assert.equal(f.window.requestAnimationFrame,wrappedRequest);
  f.advance(200);const report=f.api.pump('read');assert.equal(calls,1);assert.equal(report.pumpedFrames,1);f.stop();
});

test('revoking the read, disarming capture, or disconnecting its canvas stops a pump before the next callback',()=>{
  for(const revoke of [f=>{delete f.window.__hrmBackgroundRead;},
    f=>{f.window.__hrmCanvasTextEnabled=false;},f=>{f.canvas.isConnected=false;}]){
    const f=fixture();f.arm('read');f.window.__hrmBackgroundRead.canvas=f.canvas;const calls=[];
    f.window.requestAnimationFrame(()=>{calls.push('first');revoke(f);});
    const second=f.window.requestAnimationFrame(()=>calls.push('second'));
    f.advance(200);f.api.pump('read');assert.deepEqual(calls,['first']);assert.ok(f.nativeQueue.has(second));
    f.fire(second);assert.deepEqual(calls,['first','second']);f.stop();
  }
});

test('callbacks younger than 180ms are left to native scheduling',()=>{
  const f=fixture();f.arm('read');let timestamp;
  const id=f.window.requestAnimationFrame(value=>{timestamp=value;});
  assert.equal(id,1);f.advance(179);f.api.pump('read');assert.equal(timestamp,undefined);
  f.fire(id,179);assert.equal(timestamp,179);
  f.advance(1000);const report=f.api.pump('read');assert.equal(report.nativeFrames,1);assert.equal(report.pumpedFrames,0);f.stop();
});

test('an overdue original callback gets one current timestamp even if its cancelled native callback arrives late',()=>{
  const f=fixture();f.arm('read');const calls=[];
  const id=f.window.requestAnimationFrame(function(timestamp){calls.push({timestamp,receiver:this});});
  f.advance(200);const report=f.api.pump('read');
  assert.equal(report.pumpedFrames,1);assert.equal(report.pending,0);
  assert.ok(f.cancelled.includes(id));assert.equal(calls.length,1);assert.equal(calls[0].timestamp,200);
  f.late(id,240);f.api.pump('read');assert.equal(calls.length,1);f.stop();
});

test('cancelled callbacks never run through native or pumped delivery',()=>{
  const f=fixture();f.arm('read');let calls=0;
  const id=f.window.requestAnimationFrame(()=>calls++);f.window.cancelAnimationFrame(id);
  f.advance(500);f.api.pump('read');f.late(id,500);assert.equal(calls,0);f.stop();
});

test('cancel accepts native Web IDL handle conversion without leaving a callback pumpable',()=>{
  for(const convert of [id=>String(id),id=>String(id+4294967296),id=>id+.9]){
    const f=fixture();f.arm('read');let calls=0;
    const id=f.window.requestAnimationFrame(()=>calls++);f.window.cancelAnimationFrame(convert(id));
    f.advance(500);f.api.pump('read');f.late(id);assert.equal(calls,0);assert.ok(!f.nativeQueue.has(id));f.stop();
  }
  const f=fixture();f.arm('read');let conversions=0,calls=0;
  const id=f.window.requestAnimationFrame(()=>calls++);
  f.window.cancelAnimationFrame({valueOf(){conversions++;return id;}});
  assert.equal(conversions,1);assert.throws(()=>f.window.cancelAnimationFrame(),/requires a handle/);
  f.advance(500);f.api.pump('read');f.late(id);assert.equal(calls,0);f.stop();
});

test('native-delivered callbacks cannot be pumped again',()=>{
  const f=fixture();f.arm('read');let calls=0;
  const id=f.window.requestAnimationFrame(()=>calls++);f.fire(id,16);f.advance(500);
  const report=f.api.pump('read');assert.equal(calls,1);assert.equal(report.nativeFrames,1);assert.equal(report.pumpedFrames,0);f.stop();
});

test('callbacks queued during a pump wait for a later pump and their own minimum age',()=>{
  const f=fixture();f.arm('read');const calls=[];
  f.window.requestAnimationFrame(()=>{calls.push('first');f.window.requestAnimationFrame(()=>calls.push('second'));});
  f.advance(200);f.api.pump('read');assert.deepEqual(calls,['first']);
  f.api.pump('read');assert.deepEqual(calls,['first']);
  f.advance(180);f.api.pump('read');assert.deepEqual(calls,['first','second']);f.stop();
});

test('a callback can cancel later work or attempt a nested pump without reentrant delivery',()=>{
  const f=fixture();f.arm('read');const calls=[];let cancelled;
  f.window.requestAnimationFrame(()=>{
    calls.push('first-start');f.window.cancelAnimationFrame(cancelled);f.api.pump('read');calls.push('first-end');
  });
  cancelled=f.window.requestAnimationFrame(()=>calls.push('cancelled'));
  f.window.requestAnimationFrame(()=>calls.push('last'));
  f.advance(200);f.api.pump('read');assert.deepEqual(calls,['first-start','first-end','last']);
  f.late(cancelled);assert.deepEqual(calls,['first-start','first-end','last']);f.stop();
});

test('a throwing callback reports its error and does not prevent other original callbacks from running',()=>{
  for(const missing of [undefined,'reportError']){
    const f=fixture({missing});f.arm('read');const error=new Error('page render failed');let calls=0;
    f.window.requestAnimationFrame(()=>{throw error;});f.window.requestAnimationFrame(()=>calls++);
    f.advance(200);assert.doesNotThrow(()=>f.api.pump('read'));assert.equal(calls,1);
    if(missing){assert.equal(f.timers.length,1);assert.throws(()=>f.timers[0](),value=>value===error);}
    else assert.deepEqual(f.errors,[error]);
    f.stop();
  }
});

test('one pump is bounded to 128 callbacks without losing the remaining native work',()=>{
  const f=fixture();f.arm('read');const calls=[];
  for(let i=0;i<130;i++)f.window.requestAnimationFrame(()=>calls.push(i));
  f.advance(200);const first=f.api.pump('read');
  assert.equal(calls.length,128);assert.equal(first.pending,2);assert.deepEqual(calls,Array.from({length:128},(_,i)=>i));
  const second=f.api.pump('read');assert.equal(calls.length,130);assert.equal(second.pending,0);f.stop();
});

test('tracking is capped at 4096 while excess work keeps native request handles and delivery',()=>{
  const f=fixture();f.arm('read');let calls=0;
  for(let i=0;i<4096;i++)f.window.requestAnimationFrame(()=>calls++);
  const extra=f.window.requestAnimationFrame(()=>calls++),cancelled=f.window.requestAnimationFrame(()=>calls++);
  f.window.cancelAnimationFrame(cancelled);f.advance(200);
  let report;
  for(let i=0;i<32;i++)report=f.api.pump('read');
  assert.equal(calls,4096);assert.equal(report.pending,0);assert.equal(report.untrackedFrames,2);
  assert.ok(f.nativeQueue.has(extra));assert.ok(!f.nativeQueue.has(cancelled));
  f.fire(extra);assert.equal(calls,4097);f.stop();
});

test('stop restores native APIs while already requested native callbacks remain deliverable once',()=>{
  const f=fixture();f.arm('read');let calls=0;
  const id=f.window.requestAnimationFrame(()=>calls++);f.api.stop();
  assert.equal(f.window.requestAnimationFrame,f.originalRequest);assert.equal(f.window.cancelAnimationFrame,f.originalCancel);
  f.advance(200);f.api.pump('read');assert.equal(calls,0);
  f.fire(id,200);assert.equal(calls,1);f.late(id,250);assert.equal(calls,1);
});

test('cleanup does not overwrite APIs replaced by another page observer',()=>{
  const f=fixture(),otherRequest=()=>999,otherCancel=()=>{};
  f.window.requestAnimationFrame=otherRequest;f.window.cancelAnimationFrame=otherCancel;f.stop();
  assert.equal(f.window.requestAnimationFrame,otherRequest);assert.equal(f.window.cancelAnimationFrame,otherCancel);
});

test('a real canvas text observer sees original fillText only after the queued render callback is delivered',()=>{
  const f=fixture({observer:true});f.arm('read');const ctx=f.canvas.getContext();
  ctx.clearRect(0,0,1000,700);
  for(let i=0;i<29;i++){ctx.save();ctx.restore();}
  const before=f.window.__hrmCanvasText.snapshot({expectedName:'和**'});
  assert.equal(before.issueCode,'rendering');assert.equal(before.diagnostics.entries,0);
  assert.equal(before.diagnostics.operations.save,29);assert.equal(before.diagnostics.operations.restore,29);
  f.window.requestAnimationFrame(()=>{
    ctx.fillText('和**',30,40);ctx.fillText('工作经历',30,90);
    ctx.fillText('保留实际绘制的 Python、OpenCV 与 C++ 原始文字。',30,120);
  });
  f.advance(200);f.api.pump('read');
  const after=f.window.__hrmCanvasText.snapshot({expectedName:'和**'});
  assert.equal(after.issue,'');assert.equal(after.diagnostics.operations.fillText,3);
  assert.equal(after.text,'和**\n工作经历\n保留实际绘制的 Python、OpenCV 与 C++ 原始文字。');f.stop();
});

test('pumping cannot manufacture text when the page callback itself skips drawing while hidden',()=>{
  const f=fixture({observer:true});f.arm('read');const ctx=f.canvas.getContext();ctx.clearRect(0,0,1000,700);
  f.window.requestAnimationFrame(()=>{if(f.document.hidden)return;ctx.fillText('不应出现的文字',30,40);});
  f.advance(200);f.api.pump('read');
  const snapshot=f.window.__hrmCanvasText.snapshot();assert.equal(snapshot.issueCode,'rendering');assert.equal(snapshot.text,'');
  assert.equal(snapshot.diagnostics.entries,0);assert.equal(snapshot.diagnostics.operations.fillText,undefined);f.stop();
});

function integratedFrameFixture(){
  const f=fixture({observer:true});
  const root={isConnected:true,parentElement:null,clientHeight:700,clientWidth:1000,scrollHeight:700,scrollTop:0};
  f.canvas.parentElement=root;f.document.scrollingElement=root;f.document.body={innerText:''};
  f.window.innerWidth=1000;f.window.innerHeight=700;
  const run=vm.runInContext('('+backgroundResumeFrame.toString()+')',f.context);
  return {...f,root,run:(action,args={})=>run(action,{token:'read',name:'和**',...args})};
}

test('actual frame prepare and sample pump the original page drawing, and cleanup disables further pumping',()=>{
  const f=integratedFrameFixture(),ctx=f.canvas.getContext();ctx.clearRect(0,0,1000,700);
  f.window.requestAnimationFrame(()=>{ctx.fillText('和**',30,40);ctx.fillText('工作经历',30,90);});
  f.advance(200);
  const prepared=f.run('prepare');assert.equal(prepared.issue,'');assert.equal(prepared.text,'和**\n工作经历');
  assert.equal(prepared.diagnostics.scheduler.pumpedFrames,1);assert.equal(prepared.diagnostics.scheduler.hidden,true);
  assert.equal(f.window.__hrmBackgroundRead.canvas,f.canvas);
  f.window.requestAnimationFrame(()=>{ctx.fillText('Python 与视觉算法开发',30,120);f.root.scrollTop=20;});
  f.advance(200);
  const sampled=f.run('sample');assert.equal(sampled.text,'和**\n工作经历\nPython 与视觉算法开发');
  assert.equal(sampled.diagnostics.scheduler.pumpedFrames,2);assert.equal(sampled.geometry.scrollTop,20);
  assert.ok(sampled.revision>prepared.revision);
  f.run('cleanup',{token:'other'});assert.equal(f.window.__hrmBackgroundRead.token,'read');
  let laterCalls=0;const pending=f.window.requestAnimationFrame(()=>laterCalls++);f.advance(200);
  f.run('cleanup');assert.equal(f.window.__hrmBackgroundRead,undefined);
  f.api.pump('read');assert.equal(laterCalls,0);assert.throws(()=>f.run('sample'),/发生变化/);
  f.fire(pending);assert.equal(laterCalls,1);f.stop();
});

test('actual frame checks identity and manual verification before it can pump queued page work',()=>{
  for(const invalidate of [f=>{f.document.body.innerText='请完成安全验证';},
    f=>{const replacement=new f.window.HTMLCanvasElement();f.document.querySelectorAll=()=>[replacement];}]){
    const f=integratedFrameFixture(),ctx=f.canvas.getContext();ctx.clearRect(0,0,1000,700);
    ctx.fillText('和**',30,40);f.run('prepare');let calls=0;
    f.window.requestAnimationFrame(()=>calls++);f.advance(200);invalidate(f);
    assert.throws(()=>f.run('sample'),/发生变化|人工登录或验证/);assert.equal(calls,0);
    f.run('cleanup');f.stop();
  }
});

test('actual frame rechecks the pinned canvas, verification and session after a pumped callback mutates the page',()=>{
  for(const invalidate of [f=>{f.document.body.innerText='请完成安全验证';},
    f=>{f.canvas.isConnected=false;},f=>{const replacement=new f.window.HTMLCanvasElement();f.document.querySelectorAll=()=>[replacement];},
    f=>{f.window.__hrmBackgroundRead={...f.window.__hrmBackgroundRead,token:'replacement'};}]){
    const f=integratedFrameFixture(),ctx=f.canvas.getContext();ctx.clearRect(0,0,1000,700);
    ctx.fillText('和**',30,40);f.run('prepare');let snapshots=0;
    const snapshot=f.window.__hrmCanvasText.snapshot;
    f.window.__hrmCanvasText.snapshot=(...args)=>{snapshots++;return snapshot(...args);};
    f.window.requestAnimationFrame(()=>invalidate(f));f.advance(200);
    assert.throws(()=>f.run('sample'),/发生变化|人工登录或验证/);assert.equal(snapshots,0);
    f.run('cleanup');f.stop();
  }
});
