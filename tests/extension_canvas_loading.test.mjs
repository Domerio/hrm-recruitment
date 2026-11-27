import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {readBackgroundResume} from '../extension/background-read.mjs';

const geometrySource=fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8');
const observerSource=fs.readFileSync(new URL('../extension/canvas-text.js',import.meta.url),'utf8');
const expectedName='王**';
const footer='为妥善保护牛人在BOSS直聘平台提交的简历信息，未经授权不得在任何第三方平台进行复制、使用、传播、存储。';

function fixture({initialClear=true}={}) {
  class Canvas {
    constructor(){this._width=2000;this._height=1000;this.isConnected=true;}
    get width(){return this._width;} set width(value){this._width=value;}
    get height(){return this._height;} set height(value){this._height=value;}
    getBoundingClientRect(){return {left:0,top:0,width:1000,height:500};}
    getContext(){return this.ctx;}
  }
  class Context {
    constructor(canvas){
      this.canvas=canvas;canvas.ctx=this;this.globalAlpha=1;this.fillStyle='#000000';this.strokeStyle='#000000';
      this.globalCompositeOperation='source-over';this.direction='ltr';this.textAlign='start';this.textBaseline='alphabetic';
      this.filter='none';this.lineWidth=1;this.font='12px sans-serif';this.matrix={a:1,b:0,c:0,d:1,e:0,f:0};
    }
    fillText(){} strokeText(){} clearRect(){} fillRect(){} drawImage(){} putImageData(){}
    save(){} restore(){} clip(){} reset(){} beginPath(){} moveTo(){} lineTo(){} rect(){} closePath(){}
    arc(){} arcTo(){} ellipse(){} roundRect(){} fill(){} stroke(){} strokeRect(){}
    getTransform(){return this.matrix;}
    measureText(value){const width=value.length*10;return {width,actualBoundingBoxLeft:0,actualBoundingBoxRight:width,
      actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};}
  }
  const canvas=new Canvas(),ctx=new Context(canvas),window={__hrmCanvasTextEnabled:true};window.top=window;
  const document={querySelectorAll:()=>[canvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  const sandbox={window,CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,document,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'})};
  vm.createContext(sandbox);vm.runInContext(geometrySource,sandbox);vm.runInContext(observerSource,sandbox);
  if(initialClear)ctx.clearRect(0,0,canvas.width,canvas.height);
  return {ctx,snapshot:()=>window.__hrmCanvasText.snapshot({textOnly:false,expectedName}),stop:()=>window.__hrmCanvasText.stop()};
}
function portrait(ctx) {
  ctx.save();ctx.beginPath();ctx.arc(144,34,24,0,Math.PI*2);ctx.closePath();ctx.clip();
  ctx.drawImage({naturalWidth:100,naturalHeight:100},120,10,48,48);ctx.restore();
}
function completeText(ctx) {
  ctx.fillText(expectedName,200,30);ctx.fillText('30岁 8年 本科',200,55);
  ctx.fillText('工作经历',200,160);ctx.fillText('完整保留视觉算法研发的原文。',200,190);
  ctx.fillText(footer,200,400);
}
function reader(f,onPause=()=>{}) {
  const tab={id:7,url:'https://www.zhipin.com/web/chat/search',active:false},actions=[],pauses=[];
  const geometry={scrollMode:'native',scrollTop:0,clientHeight:1000,scrollHeight:1000,
    contentTopVisible:true,contentBottomVisible:true,contentWidthVisible:true};
  const browser={tabs:{get:async()=>({...tab})},scripting:{executeScript:async({args})=>{
    const [action]=args;actions.push(action);
    if(action==='cleanup')return [];
    const result=action==='top'?{geometry}:{...f.snapshot(),geometry};
    return [{documentId:'resume-7',result}];
  }}};
  return {actions,pauses,read:()=>readBackgroundResume({browser,tab,documentId:'resume-7',name:expectedName,
    pause:async ms=>{pauses.push(ms);await onPause(ms,pauses.length);}})};
}

test('an image drawn before any text waits for its header and then becomes a verified decoration',()=>{
  const f=fixture();portrait(f.ctx);
  const pending=f.snapshot();assert.equal(pending.issueCode,'rendering');assert.equal(pending.diagnostics.entries,0);
  assert.equal(pending.diagnostics.ignoredImages,0);assert.equal(pending.text,'');
  completeText(f.ctx);
  const complete=f.snapshot();assert.equal(complete.issue,'');assert.equal(complete.diagnostics.ignoredImages,1);
  assert.match(complete.text,/完整保留视觉算法研发的原文/);f.stop();
});

test('the reader gives pending images its bounded first-drawing wait and subsequently verifies the full resume',async()=>{
  const f=fixture();portrait(f.ctx);
  const h=reader(f,(ms,count)=>{if(count===1){assert.equal(ms,200);completeText(f.ctx);}});
  const result=await h.read();assert.equal(result.issue,undefined);assert.equal(result.completeness.allScreensRead,true);
  assert.deepEqual(h.actions.slice(0,3),['prepare','sample','top']);assert.equal(h.pauses[0],200);
  assert.match(result.resume,/完整保留视觉算法研发的原文/);assert.ok(result.resume.endsWith(footer));f.stop();
});

test('an image-only resume times out after four seconds without claiming completeness or discarding its diagnostic',async()=>{
  const f=fixture();f.ctx.drawImage({naturalWidth:300,naturalHeight:500},200,120,300,500);
  const h=reader(f),result=await h.read();
  assert.equal(result.issueCode,'rendering');assert.match(result.issue,/尚未记录/);
  assert.equal(result.completeness.allScreensRead,false);assert.equal(result.resume,'');
  assert.deepEqual(h.pauses,Array(20).fill(200));assert.equal(h.actions.filter(action=>action==='sample').length,20);
  assert.ok(!h.actions.includes('top'));
  assert.ok(result.diagnostics.reasonCounts.some(item=>/图片/.test(item.reason)&&item.count===1));f.stop();
});

test('an unknown image is unsupported as soon as actual text exists, including a partial header',()=>{
  const body=fixture();completeText(body.ctx);body.ctx.drawImage({naturalWidth:20,naturalHeight:20},600,250,20,20);
  assert.equal(body.snapshot().issueCode,'unsupported');assert.match(body.snapshot().issue,/图片/);body.stop();
  const partial=fixture();portrait(partial.ctx);partial.ctx.fillText(expectedName,200,30);
  assert.equal(partial.snapshot().issueCode,'unsupported');assert.match(partial.snapshot().issue,/图片/);partial.stop();
});

test('real drawing issues take priority over the image-only rendering wait',()=>{
  const path=fixture();portrait(path.ctx);path.ctx.strokeRect(300,300,20,20);
  assert.equal(path.snapshot().diagnostics.entries,0);assert.equal(path.snapshot().issueCode,'unsupported');
  assert.match(path.snapshot().issue,/矩形描边/);path.stop();
  const overlap=fixture();portrait(overlap.ctx);completeText(overlap.ctx);overlap.ctx.fillText('遮挡',200,30);
  assert.equal(overlap.snapshot().issueCode,'unsupported');assert.match(overlap.snapshot().issue,/文字重叠/);overlap.stop();
});

test('an unwitnessed drawing baseline remains recoverable before pending-image classification',()=>{
  const f=fixture({initialClear:false});portrait(f.ctx);
  assert.equal(f.snapshot().issueCode,'baseline');assert.match(f.snapshot().issue,/完整重绘/);f.stop();
});
