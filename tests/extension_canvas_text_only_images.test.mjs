import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const geometry=fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8');
const observer=fs.readFileSync(new URL('../extension/canvas-text.js',import.meta.url),'utf8');

// All paints here are synthetic canvas operations. Image contents are never
// decoded, and no live candidate page is used.
function fixture({metrics}={}){
  class Canvas {
    constructor(){this.width=773;this.height=956;this.isConnected=false;this.ctx=null;}
    getContext(){return this.ctx||(this.ctx=new Context(this));}
    getBoundingClientRect(){return {left:0,top:0,width:this.width,height:this.height};}
  }
  class Context {
    constructor(canvas){
      this.canvas=canvas;this.globalAlpha=1;this.globalCompositeOperation='source-over';
      this.fillStyle='#111111';this.strokeStyle='#111111';this.font='14px sans-serif';
      this.textAlign='start';this.textBaseline='alphabetic';this.direction='ltr';
      this.filter='none';this.lineWidth=1;this.matrix={a:1,b:0,c:0,d:1,e:0,f:0};
    }
    fillText(){} strokeText(){} clearRect(){} fillRect(){} drawImage(){} putImageData(){}
    save(){} restore(){} clip(){} reset(){} beginPath(){} moveTo(){} lineTo(){}
    rect(){} closePath(){} arc(){} arcTo(){} ellipse(){} roundRect(){}
    fill(){} stroke(){} strokeRect(){}
    getTransform(){return this.matrix;}
    measureText(value){
      const width=metrics?.(value)?.width??value.length*10;
      return {width,actualBoundingBoxLeft:0,
        actualBoundingBoxRight:metrics?.(value)?.right??width,
        actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};
    }
  }
  const canvas=new Canvas();canvas.isConnected=true;
  const ctx=canvas.getContext(),legacy=new Canvas();
  const window={__hrmCanvasTextEnabled:true};window.top=window;
  const document={querySelectorAll:()=>[canvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  const sandbox={window,document,HTMLCanvasElement:Canvas,CanvasRenderingContext2D:Context,
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'}),
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'}};
  vm.createContext(sandbox);vm.runInContext(geometry,sandbox);vm.runInContext(observer,sandbox);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  return {canvas,ctx,legacy,cache:()=>document.createElement('canvas'),
    snapshot:options=>window.__hrmCanvasText.snapshot(options),stop:()=>window.__hrmCanvasText.stop()};
}
function text(ctx){ctx.fillText('陈**',60,42);ctx.fillText('工作经历',60,160);ctx.fillText('视觉算法研发',60,200);}
function image(ctx,{x=204,y=34,w=46,h=20}={}){
  // Reported badge geometry: source 126x63 with a crop, destination 46x20.
  ctx.drawImage({naturalWidth:126,naturalHeight:63},2,1,122,61,x,y,w,h);
}
function readable(f,expected,ignored){
  const result=f.snapshot();assert.equal(result.issue,'');assert.equal(result.text,expected);
  assert.equal(result.diagnostics.ignoredImages,ignored);return result;
}

test('the reported cropped top badge is irrelevant to recorded resume text',()=>{
  const f=fixture();text(f.ctx);image(f.ctx);
  const result=readable(f,'陈**\n工作经历\n视觉算法研发',1);
  assert.equal(result.diagnostics.operations.drawImage,1);
  assert.equal(result.diagnostics.reasonCounts.some(item=>/图片/.test(item.reason)),false);f.stop();
});

test('a large separate body image and an image in logical glyph spacing do not hide ink',()=>{
  const f=fixture();text(f.ctx);
  f.ctx.drawImage({naturalWidth:600,naturalHeight:800},400,220,300,400);
  readable(f,'陈**\n工作经历\n视觉算法研发',1);f.stop();

  const gap=fixture({metrics:value=>value==='谷'?{width:20,right:14}:undefined});
  gap.ctx.fillText('谷',100,100);
  image(gap.ctx,{x:115,y:90,w:4,h:10});
  readable(gap,'谷',1);gap.stop();
});

test('a later image over recorded text remains blocking even when cropped',()=>{
  const f=fixture();text(f.ctx);image(f.ctx,{x:70,y:187,w:46,h:20});
  const result=f.snapshot();
  assert.equal(result.issueCode,'unsupported');assert.match(result.issue,/图片/);
  assert.equal(result.text,'');assert.equal(result.diagnostics.ignoredImages,0);f.stop();
});

test('opaque text drawn after an external background image remains readable',()=>{
  const f=fixture();image(f.ctx,{x:60,y:185,w:180,h:30});text(f.ctx);
  readable(f,'陈**\n工作经历\n视觉算法研发',1);f.stop();
});

test('known canvas copies retain their text lineage and still detect later overlays',()=>{
  const f=fixture(),source=f.cache();source.getContext().fillText('缓存中的完整原文',60,100);
  f.ctx.drawImage(source,0,0);
  readable(f,'缓存中的完整原文',0);
  image(f.ctx,{x:70,y:88,w:46,h:20});
  assert.equal(f.snapshot().issueCode,'unsupported');f.stop();
});

test('an unobserved canvas source is never treated as a harmless decoration',()=>{
  const f=fixture();f.ctx.fillText('已记录的文字',60,100);
  f.ctx.drawImage(f.legacy,400,300,40,40);
  assert.equal(f.snapshot().issueCode,'unsupported');f.stop();
});

test('an image-only canvas never claims complete original text',()=>{
  const f=fixture();image(f.ctx);
  const result=f.snapshot();
  assert.equal(result.issueCode,'rendering');assert.equal(result.text,'');f.stop();
});
