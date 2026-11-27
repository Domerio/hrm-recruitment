import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const geometry=fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8');
const observer=fs.readFileSync(new URL('../extension/canvas-text.js',import.meta.url),'utf8');

// Independent fixture: both real extension scripts run together, while only
// native drawing/metrics are stubbed. No browser, pixels or live resume needed.
function fixture({initialClear=true}={}) {
  class Canvas {
    constructor(){this._width=1000;this._height=1000;this.isConnected=true;}
    get width(){return this._width;} set width(value){this._width=value;}
    get height(){return this._height;} set height(value){this._height=value;}
    getBoundingClientRect(){return {left:0,top:0,width:500,height:500};}
    getContext(){return this.ctx;}
  }
  class Context {
    constructor(canvas){
      this.canvas=canvas;canvas.ctx=this;this.globalAlpha=1;this.fillStyle='#000000';this.strokeStyle='#000000';
      this.globalCompositeOperation='source-over';this.direction='ltr';this.textAlign='start';this.textBaseline='alphabetic';
      this.filter='none';this.lineWidth=1;this.font='12px sans-serif';
      this.matrix={a:1,b:0,c:0,d:1,e:0,f:0};
    }
    fillText(){} strokeText(){} clearRect(){} fillRect(){} drawImage(){} putImageData(){}
    save(){} restore(){} clip(){} reset(){} beginPath(){} moveTo(){} lineTo(){} rect(){} closePath(){}
    arc(){} arcTo(){} ellipse(){} roundRect(){} fill(){} stroke(){} strokeRect(){}
    getTransform(){return this.matrix;}
    measureText(value){
      const width=value.length*10,shift=['end','right'].includes(this.textAlign)?width:this.textAlign==='center'?width/2:0;
      return {width,actualBoundingBoxLeft:shift,actualBoundingBoxRight:width-shift,
        actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};
    }
  }
  const canvas=new Canvas(),ctx=new Context(canvas),window={__hrmCanvasTextEnabled:true};window.top=window;
  const document={querySelectorAll:()=>[canvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  const sandbox={window,CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,document,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'})};
  vm.createContext(sandbox);vm.runInContext(geometry,sandbox);vm.runInContext(observer,sandbox);
  if(initialClear)ctx.clearRect(0,0,canvas.width,canvas.height);
  return {canvas,ctx,snapshot:options=>window.__hrmCanvasText.snapshot(options),stop:()=>window.__hrmCanvasText.stop()};
}
function circle(ctx,{x=100,y=100,radius=80}={}) {
  ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.closePath();
}
function rounded(ctx,{x=0,y=0,width=240,height=160,radius=30}={}) {
  ctx.beginPath();ctx.moveTo(x+radius,y);
  ctx.arcTo(x+width,y,x+width,y+height,radius);
  ctx.arcTo(x+width,y+height,x,y+height,radius);
  ctx.arcTo(x,y+height,x,y,radius);
  ctx.arcTo(x,y,x+width,y,radius);ctx.closePath();
}
function polygon(ctx) {
  ctx.beginPath();ctx.moveTo(20,20);ctx.lineTo(180,20);
  ctx.lineTo(180,140);ctx.lineTo(20,140);ctx.closePath();
}

test('a complete circular clip admits only wholly visible text and restore releases the clip',()=>{
  const f=fixture();f.ctx.save();circle(f.ctx);f.ctx.clip();
  f.ctx.fillText('圆形内部文字',60,100);
  f.ctx.fillText('完全在圆形框外',300,100);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'圆形内部文字');
  f.ctx.restore();f.ctx.fillText('恢复后外部文字',300,200);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'圆形内部文字\n恢复后外部文字');
  f.stop();
});

test('a circular clip rejects text straddling its curved boundary even inside its bounding box',()=>{
  const f=fixture();circle(f.ctx,{x:100,y:100,radius:100});f.ctx.clip();
  f.ctx.fillText('圆内正文',60,100);
  // [5,35] x [60,72] is inside the circle's bounding box but crosses its arc.
  f.ctx.fillText('跨圆弧',5,70);
  const read=f.snapshot();assert.match(read.issue,/裁剪区域截断/);assert.equal(read.issueCode,'unsupported');
  assert.equal(read.text,'');assert.equal(read.diagnostics.entries,1);f.stop();
});

test('a four-arcTo opaque background preserves original text drawn inside and outside its bounds',()=>{
  const f=fixture();rounded(f.ctx);f.ctx.fill();
  f.ctx.fillText('内部正文',40,60);f.ctx.fillText('区域外正文',300,220);
  const read=f.snapshot();assert.equal(read.issue,'');assert.equal(read.text,'内部正文\n区域外正文');
  assert.equal(read.diagnostics.operations.arcTo,4);assert.equal(read.diagnostics.operations.fill,1);f.stop();
});

test('a rounded background repaint removes fully covered old text while preserving text outside its bounds',()=>{
  const f=fixture();f.ctx.fillText('旧内容',40,60);f.ctx.fillText('外部保留',300,220);
  rounded(f.ctx);f.ctx.fill();f.ctx.fillText('新内容',40,60);
  const read=f.snapshot();assert.equal(read.issue,'');assert.equal(read.text,'新内容\n外部保留');f.stop();
});

test('rounded corner clips use their true curved region instead of confirming the bounding rectangle',()=>{
  const f=fixture();rounded(f.ctx,{width:200,height:150,radius:40});f.ctx.clip();
  f.ctx.fillText('完整正文',50,90);
  // A 20-pixel run occupies [5,25] x [15,27], crossing the top-left curve.
  f.ctx.fillText('缺角',5,25);
  const read=f.snapshot();assert.match(read.issue,/裁剪区域截断/);assert.equal(read.issueCode,'unsupported');
  assert.equal(read.diagnostics.entries,1);assert.equal(read.text,'');f.stop();
});

test('native roundRect and ellipse commands share strict clip containment with recorded paths',()=>{
  const f=fixture();f.ctx.save();f.ctx.beginPath();f.ctx.roundRect(0,0,200,160,[20,30,40,10]);f.ctx.clip();
  f.ctx.fillText('原生圆角正文',40,70);assert.equal(f.snapshot().issue,'');
  f.ctx.restore();f.ctx.save();f.ctx.beginPath();f.ctx.ellipse(100,250,80,40,0,0,Math.PI*2);f.ctx.clip();
  f.ctx.fillText('椭圆内正文',60,250);assert.equal(f.snapshot().issue,'');
  f.ctx.fillText('截断',25,225);assert.match(f.snapshot().issue,/裁剪区域截断/);f.stop();
});

test('nested save and restore keep each known clip only for its own drawing scope',()=>{
  const f=fixture();f.ctx.save();rounded(f.ctx);f.ctx.clip();f.ctx.fillText('外层',40,40);
  f.ctx.save();circle(f.ctx,{x:120,y:80,radius:40});f.ctx.clip();f.ctx.fillText('内层',100,80);
  f.ctx.restore();f.ctx.fillText('恢复外层',30,125);
  f.ctx.restore();f.ctx.fillText('恢复全部',300,200);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'外层\n内层\n恢复外层\n恢复全部');f.stop();
});

test('a circularly clipped clear cannot create a complete canvas baseline from its bounding box',()=>{
  const f=fixture({initialClear:false});circle(f.ctx,{x:500,y:500,radius:500});f.ctx.clip();
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('中心正文',450,500);
  const read=f.snapshot();assert.equal(read.issueCode,'baseline');assert.equal(read.diagnostics.baseline,false);
  assert.match(read.issue,/完整重绘/);f.stop();
});

test('a clipped clear retains errors in unpainted rounded corners until an unclipped clear covers them',()=>{
  for(const drawClip of [ctx=>circle(ctx,{x:100,y:100,radius:100}),ctx=>rounded(ctx,{width:200,height:200,radius:60})]) {
    const f=fixture();f.ctx.fillText('原有',5,14);f.ctx.fillText('遮挡',5,14);
    assert.match(f.snapshot().issue,/文字重叠/);
    f.ctx.save();drawClip(f.ctx);f.ctx.clip();f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('中心',90,100);
    assert.match(f.snapshot().issue,/文字重叠|局部覆盖/);
    assert.equal(f.snapshot().issueCode,'unsupported');assert.equal(f.snapshot().text,'');
    f.ctx.restore();f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('清除后',40,50);
    assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'清除后');f.stop();
  }
});

test('nested clipped clears cannot discard an error that only the outer clip would cover',()=>{
  const f=fixture();f.ctx.fillText('原有',35,45);f.ctx.fillText('遮挡',35,45);
  f.ctx.save();rounded(f.ctx,{width:240,height:200,radius:20});f.ctx.clip();
  f.ctx.save();circle(f.ctx,{x:120,y:100,radius:50});f.ctx.clip();f.ctx.clearRect(0,0,1000,1000);
  assert.match(f.snapshot().issue,/文字重叠/);
  f.ctx.restore();f.ctx.clearRect(0,0,240,200);f.ctx.fillText('已覆盖正文',40,100);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'已覆盖正文');f.stop();
});

test('a closed moveTo/lineTo rectangle is a known clip and excludes text wholly beyond its edges',()=>{
  const f=fixture();polygon(f.ctx);f.ctx.clip('evenodd');
  f.ctx.fillText('矩形内部',40,70);f.ctx.fillText('矩形外部',250,70);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'矩形内部');
  f.ctx.fillText('跨边界',170,100);assert.match(f.snapshot().issue,/裁剪区域截断/);f.stop();
});

test('unknown Path2D clip and fill arguments cannot inherit a preceding known shape',()=>{
  const clipped=fixture();rounded(clipped.ctx);clipped.ctx.clip({});clipped.ctx.fillText('不能确认的正文',40,70);
  assert.match(clipped.snapshot().issue,/不能确认的裁剪/);assert.equal(clipped.snapshot().text,'');clipped.stop();
  const filled=fixture();circle(filled.ctx);filled.ctx.fill({});filled.ctx.fillText('不能确认的正文',40,70);
  assert.match(filled.snapshot().issue,/路径绘制/);assert.equal(filled.snapshot().text,'');filled.stop();
});

test('fill and clip implicitly close a single axis-aligned rectangle without closePath',()=>{
  for(const action of ['fill','clip']){
    const f=fixture();
    f.ctx.beginPath();f.ctx.moveTo(20,20);f.ctx.lineTo(220,20);f.ctx.lineTo(220,140);f.ctx.lineTo(20,140);
    f.ctx[action]();f.ctx.fillText('隐式闭合区域正文',40,70);
    assert.equal(f.snapshot().issue,'',action);assert.equal(f.snapshot().text,'隐式闭合区域正文');f.stop();
  }
});
