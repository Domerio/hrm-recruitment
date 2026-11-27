import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../extension/canvas-text.js',import.meta.url),'utf8');
function fixture({hostname='www.zhipin.com',pathname='/web/frame/c-resume/',initialClear=true,armed=true}={}) {
  class Canvas {
    constructor(){this._width=1000;this._height=1000;this.isConnected=true;this.ctx=null;}
    get width(){return this._width;}
    set width(value){this._width=value;}
    get height(){return this._height;}
    set height(value){this._height=value;}
    getContext(){return this.ctx;}
    getBoundingClientRect(){return {left:0,top:0,width:500,height:500};}
  }
  class Context {
    constructor(canvas){this.canvas=canvas;canvas.ctx=this;this.globalAlpha=1;this.fillStyle='#ffffff';
      this.globalCompositeOperation='source-over';this.direction='ltr';this.textAlign='start';this.textBaseline='alphabetic';
      this.filter='none';this.lineWidth=1;this.strokeStyle='#000000';
      this.matrix={a:1,b:0,c:0,d:1,e:0,f:0};this.calls=[];}
    fillText(...args){this.calls.push(args);}
    strokeText(){}
    clearRect(){}
    fillRect(){}
    drawImage(){}
    putImageData(){}
    save(){}
    restore(){}
    clip(){}
    reset(){}
    beginPath(){}
    moveTo(){}
    lineTo(){}
    rect(){}
    closePath(){}
    arc(){}
    fill(){}
    stroke(){}
    strokeRect(){}
    getTransform(){return this.matrix;}
    measureText(value){const width=value.length*10,left=['right','end'].includes(this.textAlign)?width:this.textAlign==='center'?width/2:0;
      return {width,actualBoundingBoxLeft:left,actualBoundingBoxRight:width-left,
      actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};}
  }
  const canvas=new Canvas(),ctx=new Context(canvas),canvases=[canvas];
  const window={__hrmCanvasTextEnabled:armed};window.top=window;
  const original=Context.prototype.fillText;
  const document={querySelectorAll:()=>canvases,
    createElement:name=>name.toLowerCase()==='canvas'?new Canvas():{tagName:name},
    createElementNS:(namespace,name)=>namespace==='http://www.w3.org/1999/xhtml'&&name==='canvas'?new Canvas():{tagName:name,namespaceURI:namespace}};
  const originalCreation={createElement:document.createElement,createElementNS:document.createElementNS};
  const sandbox={window,CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,
    document,getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'}),
    location:{protocol:'https:',hostname,pathname}};
  vm.runInNewContext(fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8'),sandbox);
  vm.runInNewContext(source,sandbox);
  if(initialClear)ctx.clearRect(0,0,canvas.width,canvas.height);
  return {canvas,ctx,canvases,Context,Canvas,window,document,original,originalCreation,
    snapshot:options=>window.__hrmCanvasText?.snapshot({textOnly:false,...options}),
    stop:()=>window.__hrmCanvasText?.stop()};
}

function body(f,{x=60,y=120}={}){
  f.ctx.fillText('张**',x,y-80);
  f.ctx.fillText('工作经历',x,y-40);
  f.ctx.fillText('必须保留的完整简历原文',x,y);
}
const crop=(f,rect={x:0,y:0,width:900,height:1000},options={})=>f.snapshot({rect,...options});
function coverage(result,complete,reason){
  assert.ok(result.horizontalCoverage,'a snapshot must expose its recorded horizontal coverage');
  assert.equal(result.horizontalCoverage.complete,complete);
  if(reason)assert.equal(result.horizontalCoverage.reason,reason);
  return result.horizontalCoverage;
}

test('a full-width snapshot reports complete horizontal bounds without changing original text',()=>{
  const f=fixture();body(f);
  const result=f.snapshot(),proof=coverage(result,true,'full-width');
  assert.equal(result.text,'张**\n工作经历\n必须保留的完整简历原文');
  assert.equal(proof.canvasWidth,1000);assert.equal(proof.visibleLeft,0);assert.equal(proof.visibleRight,1000);
  assert.equal(proof.clippedLeft,0);assert.equal(proof.clippedRight,0);
  assert.equal(proof.outsideTextRuns,0);assert.equal(proof.outsideImages,0);assert.equal(proof.outsideIssues,0);
});

test('only empty side margins may be clipped, independently of margin size or which side is clipped',()=>{
  for(const rect of [{x:0,y:0,width:970,height:1000},{x:30,y:0,width:970,height:1000},
    {x:30,y:0,width:940,height:1000},{x:0,y:0,width:700,height:1000}]){
    const f=fixture();body(f);const result=crop(f,rect),proof=coverage(result,true,'empty-margins');
    assert.equal(result.issue,'');assert.equal(result.text,f.snapshot().text);
    assert.equal(proof.visibleLeft,rect.x);assert.equal(proof.visibleRight,rect.x+rect.width);
    assert.equal(proof.clippedLeft,rect.x);assert.equal(proof.clippedRight,1000-rect.x-rect.width);
    assert.equal(proof.textLeft,60);assert.equal(proof.textRight,170);
    assert.equal(proof.outsideTextRuns,0);assert.equal(proof.outsideImages,0);assert.equal(proof.outsideIssues,0);
    assert.doesNotMatch(JSON.stringify(proof),/张\*\*|工作经历|必须保留/);f.stop();
  }
});

test('an entire hidden line or separate same-baseline column cannot disappear behind the width proof',()=>{
  for(const sameBaseline of [false,true]){
    const f=fixture();body(f);f.ctx.fillText('右栏',940,sameBaseline?120:180);
    const result=crop(f),proof=coverage(result,false,'text-outside');
    assert.equal(proof.outsideTextRuns,1);assert.equal(proof.textRight,960);
    // This run is wholly outside the area: checking only intersecting runs
    // or only the already-filtered return text would incorrectly approve it.
    assert.doesNotMatch(result.text,/右栏/);f.stop();
  }
});

test('a glyph clipped by even one pixel and a wholly hidden left column both reject horizontal completeness',()=>{
  for(const [x,rect] of [[891,{x:0,y:0,width:900,height:1000}],
    [20,{x:30,y:0,width:970,height:1000}],[990,{x:0,y:0,width:999,height:1000}]]){
    const f=fixture();body(f);f.ctx.fillText('字',x,180);
    const proof=coverage(crop(f,rect),false,'text-outside');
    assert.ok(proof.outsideTextRuns>=1);f.stop();
  }
});

test('unknown images entirely or partly in a clipped side strip still invalidate that strip',()=>{
  for(const x of [940,890]){
    const f=fixture();body(f);f.ctx.drawImage({naturalWidth:32,naturalHeight:32},x,160,32,32);
    const proof=coverage(crop(f),false,'image-outside');
    assert.equal(proof.outsideImages,1);f.stop();
  }
});

test('an unsupported drawing outside the visible x range does not become an empty margin',()=>{
  const f=fixture();body(f);f.ctx.fillStyle={unreadablePattern:true};f.ctx.fillRect(940,160,32,32);
  const proof=coverage(crop(f),false,'drawing-outside');assert.equal(proof.outsideIssues,1);
  // Unlike a partial text row this drawing need not touch the crop at all.
  assert.ok(f.snapshot().issue);f.stop();
});

test('only records in the requested vertical band affect the current horizontal coverage',()=>{
  const f=fixture();f.ctx.fillText('当前完整正文',60,400);
  f.ctx.fillText('上一屏右栏',940,100);f.ctx.drawImage({naturalWidth:32,naturalHeight:32},940,700,32,32);
  f.ctx.fillStyle={unreadablePattern:true};f.ctx.fillRect(940,820,32,32);
  const result=crop(f,{x:0,y:300,width:900,height:200}),proof=coverage(result,true,'empty-margins');
  assert.equal(result.issue,'');assert.equal(result.text,'当前完整正文');
  assert.equal(proof.outsideTextRuns,0);assert.equal(proof.outsideImages,0);assert.equal(proof.outsideIssues,0);
});

test('vertical whole-row deferral remains available when horizontal margins contain no content',()=>{
  const f=fixture();body(f);f.ctx.fillText('跨屏残字',60,999);
  const result=crop(f,undefined,{allowVerticalBoundary:true}),proof=coverage(result,true,'empty-margins');
  assert.equal(result.issue,'');assert.equal(result.boundaryRows.bottom,true);
  assert.doesNotMatch(result.text,/跨屏残字/);assert.equal(proof.outsideIssues,0);
});

test('a horizontally hidden boundary fragment cannot use vertical deferral as a width exemption',()=>{
  const f=fixture();body(f);f.ctx.fillText('残字',940,999);
  const result=crop(f,undefined,{allowVerticalBoundary:true}),proof=coverage(result,false);
  assert.ok(proof.outsideTextRuns+proof.outsideIssues>0);
  assert.ok(['text-outside','drawing-outside'].includes(proof.reason));
});

test('coverage cannot be complete before a full drawing baseline or after an unlocated drawing failure',()=>{
  const initial=fixture({initialClear:false});body(initial);
  coverage(crop(initial),false,'unconfirmed');assert.equal(crop(initial).issueCode,'baseline');initial.stop();
  const failed=fixture();body(failed);failed.ctx.putImageData({},940,160);
  const proof=coverage(crop(failed),false);assert.ok(['drawing-outside','unconfirmed'].includes(proof.reason));
  assert.ok(crop(failed).issue);failed.stop();
});

test('an unlocated drawing blocks reading without falsely reporting hidden content at full width',()=>{
  const f=fixture();body(f);f.ctx.putImageData({},940,160);
  const result=f.snapshot(),proof=coverage(result,true,'full-width');
  assert.equal(proof.clippedLeft,0);assert.equal(proof.clippedRight,0);
  assert.equal(proof.outsideIssues,0);
  assert.ok(result.issue,'the global unsupported drawing still blocks the text snapshot');f.stop();
});

test('erasing a clipped strip cannot certify it after drawing records overflowed',()=>{
  const f=fixture();body(f);
  // A lost drawing record may have affected more than the surviving samples.
  // Clearing only the margin cannot re-establish a full drawing baseline.
  for(let i=0;i<2100;i++)f.ctx.drawImage({naturalWidth:32,naturalHeight:32},940,160,32,32);
  f.ctx.clearRect(900,0,100,1000);
  const result=crop(f),proof=coverage(result,false,'unconfirmed');
  assert.equal(result.diagnostics.overflow,true);assert.equal(proof.outsideImages,0);assert.ok(result.issue);
});

test('horizontal proof is recomputed after body, image or clipped drawing changes',()=>{
  const f=fixture();body(f);coverage(crop(f),true,'empty-margins');
  f.ctx.fillText('新右栏',940,160);coverage(crop(f),false,'text-outside');
  f.ctx.clearRect(900,0,100,1000);coverage(crop(f),true,'empty-margins');
  f.ctx.drawImage({naturalWidth:32,naturalHeight:32},940,160,32,32);coverage(crop(f),false,'image-outside');
  f.ctx.clearRect(900,0,100,1000);coverage(crop(f),true,'empty-margins');
  f.ctx.fillStyle={unreadablePattern:true};f.ctx.fillRect(940,160,32,32);coverage(crop(f),false,'drawing-outside');
  f.ctx.clearRect(900,0,100,1000);coverage(crop(f),true,'empty-margins');
});

test('recorded cache copies preserve side-strip text and unknown images for coverage checking',()=>{
  const f=fixture(),source=new f.Canvas(),ctx=new f.Context(source);
  ctx.clearRect(0,0,1000,1000);ctx.fillText('缓存正文',60,120);
  const show=()=>{f.ctx.clearRect(0,0,1000,1000);f.ctx.drawImage(source,0,0);};
  show();coverage(crop(f),true,'empty-margins');assert.equal(crop(f).text,'缓存正文');
  ctx.fillText('右栏缓存',940,180);show();coverage(crop(f),false,'text-outside');
  ctx.clearRect(900,0,100,1000);ctx.drawImage({naturalWidth:32,naturalHeight:32},940,160,32,32);
  show();coverage(crop(f),false,'image-outside');
});
