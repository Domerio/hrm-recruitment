import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scripts=['canvas-expand.js','canvas-geometry.js','canvas-text.js'].map(name=>
  fs.readFileSync(new URL('../extension/'+name,import.meta.url),'utf8'));

// A separate cache bitmap is not a visible resume. All extraction must be
// derived from the scripts' original drawing records, never native pixel APIs.
function fixture(){
  class Canvas {
    constructor(){this._width=773;this._height=956;this.isConnected=false;this.ctx=null;}
    get width(){return this._width;} set width(value){this._width=value;}
    get height(){return this._height;} set height(value){this._height=value;}
    getContext(){return this.ctx||(this.ctx=new Context(this));}
    getBoundingClientRect(){return {left:0,top:0,width:this.width,height:this.height,right:this.width,bottom:this.height};}
  }
  class Context {
    constructor(canvas){
      this.canvas=canvas;this.globalAlpha=1;this.fillStyle='#000000';this.strokeStyle='#000000';
      this.globalCompositeOperation='source-over';this.direction='ltr';this.textAlign='start';this.textBaseline='alphabetic';
      this.filter='none';this.lineWidth=1;this.font='14px sans-serif';this.shadowColor='transparent';
      this.matrix={a:1,b:0,c:0,d:1,e:0,f:0};this.stack=[];
    }
    fillText(){} strokeText(){} clearRect(){} fillRect(){} drawImage(){} putImageData(){}
    clip(){} reset(){} beginPath(){} moveTo(){} lineTo(){} rect(){} closePath(){}
    arc(){} arcTo(){} ellipse(){} roundRect(){} fill(){} stroke(){} strokeRect(){}
    save(){this.stack.push({matrix:{...this.matrix},fillStyle:this.fillStyle,font:this.font});}
    restore(){const saved=this.stack.pop();if(saved)Object.assign(this,saved);}
    getTransform(){return this.matrix;}
    getImageData(){throw Error('Do not OCR or inspect the source bitmap');}
    measureText(value){
      const width=value.length*10,shift=['end','right'].includes(this.textAlign)?width:this.textAlign==='center'?width/2:0;
      return {width,actualBoundingBoxLeft:shift,actualBoundingBoxRight:width-shift,actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};
    }
  }
  const canvas=new Canvas();canvas.isConnected=true;
  const ctx=canvas.getContext(),legacy=new Canvas(),window={__hrmCanvasTextEnabled:true};window.top=window;
  const document={querySelectorAll:()=>[canvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  const sandbox={window,document,HTMLCanvasElement:Canvas,CanvasRenderingContext2D:Context,
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'}),
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'}};
  vm.createContext(sandbox);for(const script of scripts)vm.runInContext(script,sandbox);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  return {canvas,ctx,legacy,document,cache:(width=773,height=956)=>{
    const source=document.createElement('canvas');source.width=width;source.height=height;return source;
  },snapshot:options=>window.__hrmCanvasText.snapshot({textOnly:false,...options}),stop:()=>{
    window.__hrmCanvasText.stop();window.__hrmExpandMarks.stop();
  }};
}

function readable(f,text,options){
  const result=f.snapshot(options);assert.equal(result.issue,'');assert.equal(result.text,text);return result;
}
function blocked(f,options){
  const result=f.snapshot(options);assert.ok(result.issue);assert.equal(result.text,'');return result;
}

test('a tracked detached canvas preserves its original strings through a three-argument drawImage',()=>{
  const f=fixture(),source=f.cache(400,200),ctx=source.getContext();
  ctx.fillText('张**',20,40);ctx.fillText('熟悉 C++  与 OpenCV。',20,80);
  f.ctx.drawImage(source,30,50);
  const result=readable(f,'张**\n熟悉 C++  与 OpenCV。');
  assert.equal(result.diagnostics.operations.drawImage,1);assert.equal(result.diagnostics.entries,2);f.stop();
});

test('zero-pixel text calls leave a tracked cache revision and copied text lineage intact',()=>{
  const f=fixture(),source=f.cache(400,200),ctx=source.getContext();
  ctx.fillText('来源完整正文',20,40);
  f.document.querySelectorAll=()=>[source];source.isConnected=true;f.canvas.isConnected=false;
  const before=f.snapshot();
  ctx.fillText('无绘制',NaN,80);
  ctx.fillText('无绘制',20,80,0);
  const measure=ctx.measureText.bind(ctx);
  ctx.measureText=value=>value==='\u200B'?{width:0,actualBoundingBoxLeft:0,actualBoundingBoxRight:0,
    actualBoundingBoxAscent:0,actualBoundingBoxDescent:0}:measure(value);
  ctx.fillText('\u200B',20,80);
  const after=f.snapshot();
  assert.equal(after.issue,'');assert.equal(after.revision,before.revision);
  assert.equal(after.text,'来源完整正文');
  source.isConnected=false;f.canvas.isConnected=true;f.document.querySelectorAll=()=>[f.canvas];
  f.ctx.drawImage(source,30,50);
  readable(f,'来源完整正文');f.stop();
});

test('the reported 773x956 cached tiles at -526 and 430 yield only the original current-screen text',()=>{
  const f=fixture(),first=f.cache(),second=f.cache();
  first.getContext().fillText('已滚过的上屏原文',20,40);
  first.getContext().fillText('本屏第一段原文',20,560);
  first.getContext().fillText('本屏第二段原文',20,900);
  second.getContext().fillText('本屏第三段原文',20,40);
  second.getContext().fillText('本屏第四段原文',20,400);
  second.getContext().fillText('尚未进入视口的原文',20,900);
  f.ctx.drawImage(first,0,-526);f.ctx.drawImage(second,0,430);f.ctx.drawImage(first,0,1386);
  const result=readable(f,'本屏第一段原文\n本屏第二段原文\n本屏第三段原文\n本屏第四段原文');
  assert.equal(result.diagnostics.operations.drawImage,3);assert.equal(result.diagnostics.entries,4);f.stop();
});

test('two adjacent cached tile fragments reconstruct a glyph only after their observed coverage is complete',()=>{
  const f=fixture(),first=f.cache(),second=f.cache(),a=first.getContext(),b=second.getContext();
  a.fillText('接缝前完整原文',20,600);a.fillText('接缝原字',20,955);
  b.fillText('接缝原字',20,-1);b.fillText('接缝后完整原文',20,50);
  // Both baseline positions map to 429. The first tile contains original ink
  // y=[419,430), the second y=[430,431): neither part is a whole glyph alone.
  f.ctx.drawImage(first,0,-526);f.ctx.drawImage(second,0,430);
  const result=readable(f,'接缝前完整原文\n接缝原字\n接缝后完整原文',{allowVerticalBoundary:true});
  assert.equal(result.text.split('接缝原字').length-1,1);f.stop();
});

test('one cached tile fragment alone cannot supply unseen ink at an interior seam',()=>{
  for(const only of ['upper','lower']){
    const f=fixture(),source=f.cache(),ctx=source.getContext();
    ctx.fillText('完整原文',20,only==='upper'?600:50);
    ctx.fillText('缺一半的原字',20,only==='upper'?955:-1);
    f.ctx.drawImage(source,0,only==='upper'?-526:430);
    blocked(f,{allowVerticalBoundary:true});f.stop();
  }
});

test('adjacent fragments with different original text or font cannot be combined as one complete glyph',()=>{
  for(const mismatch of ['text','font']){
    const f=fixture(),first=f.cache(),second=f.cache(),a=first.getContext(),b=second.getContext();
    a.fillText('完整原文',20,600);a.fillText('接缝原字',20,955);
    if(mismatch==='font')b.font='16px serif';
    b.fillText(mismatch==='text'?'不同原字':'接缝原字',20,-1);
    f.ctx.drawImage(first,0,-526);f.ctx.drawImage(second,0,430);
    blocked(f,{allowVerticalBoundary:true});f.stop();
  }
});

test('partly erased or overpainted source fragments cannot later reconstruct a clean seam',()=>{
  for(const change of [
    ctx=>ctx.clearRect(20,945,10,1),
    ctx=>{ctx.fillStyle='rgba(0,0,0,.5)';ctx.fillRect(20,945,10,1);},
    ctx=>ctx.fillText('覆盖',20,950),
    ctx=>{ctx.beginPath();ctx.moveTo(20,950);ctx.lineTo(60,950);ctx.stroke();},
  ]){
    const f=fixture(),first=f.cache(),second=f.cache(),a=first.getContext(),b=second.getContext();
    a.fillText('正文',20,600);a.fillText('接缝原字',20,955);change(a);
    b.fillText('接缝原字',20,-1);f.ctx.drawImage(first,0,-526);f.ctx.drawImage(second,0,430);
    blocked(f,{allowVerticalBoundary:true});f.stop();
  }
});

test('unobserved 2D provenance and a translucent or nonrectangular copy cannot certify original text',()=>{
  for(const mode of ['no-2d','alpha','clip','rotation']){
    const f=fixture(),source=f.cache(300,200);
    if(mode!=='no-2d')source.getContext().fillText('完整原文',20,40);
    if(mode==='alpha')f.ctx.globalAlpha=.5;
    if(mode==='clip'){f.ctx.beginPath();f.ctx.arc(80,80,70,0,Math.PI*2);f.ctx.closePath();f.ctx.clip();}
    if(mode==='rotation')f.ctx.matrix={a:1,b:.1,c:0,d:1,e:0,f:0};
    f.ctx.drawImage(source,0,0);blocked(f);f.stop();
  }
});

test('five-argument scaled copies and the destination transform map glyph positions consistently',()=>{
  const f=fixture(),source=f.cache(200,120);source.getContext().fillText('缩放原文',20,40);
  f.ctx.matrix={a:1.5,b:0,c:0,d:2,e:7,f:9};f.ctx.drawImage(source,100,60,400,240);
  // Source ink [20,30..60,42] -> local [140,120..220,144] -> canvas [217,249..337,297].
  readable(f,'缩放原文',{rect:{x:210,y:240,width:140,height:70}});
  assert.equal(f.snapshot({rect:{x:0,y:0,width:200,height:200}}).text,'');f.stop();
});

test('a nine-argument source crop transfers only whole selected text and ignores an excluded source image',()=>{
  const f=fixture(),source=f.cache(400,200),ctx=source.getContext();
  ctx.fillText('裁剪内原文',20,40);ctx.fillText('裁剪外原文',20,150);
  ctx.drawImage({naturalWidth:30,naturalHeight:30},300,140,30,30);
  f.ctx.drawImage(source,10,20,120,50,50,100,240,100);
  readable(f,'裁剪内原文',{rect:{x:50,y:100,width:240,height:100}});f.stop();
});

test('a source crop through any part of a word cannot turn it into whole original text',()=>{
  for(const crop of [[25,0,100,100],[0,35,150,65]]){
    const f=fixture(),source=f.cache(200,120);source.getContext().fillText('原字不得补造',20,40);
    f.ctx.drawImage(source,...crop,100,100,crop[2],crop[3]);
    blocked(f,{allowVerticalBoundary:true});f.stop();
  }
});

test('unknown images and source drawing errors remain blocking after copying a cache',()=>{
  for(const paint of [
    ctx=>ctx.drawImage({naturalWidth:40,naturalHeight:40},150,20,40,40),
    ctx=>ctx.putImageData({},0,0),
    ctx=>{ctx.fillText('原文',20,40);ctx.fillText('重叠',25,40);},
  ]){
    const f=fixture(),source=f.cache(300,200),ctx=source.getContext();
    ctx.fillText('工作经历',20,100);paint(ctx);f.ctx.drawImage(source,0,0);
    blocked(f);f.stop();
  }
});

test('unobserved or incompletely observed source canvases cannot claim original text',()=>{
  for(const paintLate of [false,true]){
    const f=fixture();
    if(paintLate)f.legacy.getContext().fillText('只看到了后续绘制',20,40);
    f.ctx.drawImage(f.legacy,0,0);blocked(f);f.stop();
  }
});

test('drawImage captures source evidence at copy time instead of looking through later changes',()=>{
  const f=fixture(),source=f.cache(300,200),ctx=source.getContext();
  ctx.fillText('复制当时的原文',20,40);f.ctx.drawImage(source,0,0);
  ctx.clearRect(0,0,300,200);ctx.fillText('来源后来被改写',20,40);
  readable(f,'复制当时的原文');
  source.width=source.width;readable(f,'复制当时的原文');f.stop();
});

test('copied source errors do not disappear when the source is subsequently cleared',()=>{
  const f=fixture(),source=f.cache(300,200),ctx=source.getContext();
  ctx.fillText('原文',20,40);ctx.fillText('遮挡',25,40);f.ctx.drawImage(source,0,0);
  ctx.clearRect(0,0,300,200);blocked(f);f.stop();
});

test('tracked text survives cache-to-cache-to-visible canvas copying',()=>{
  const f=fixture(),source=f.cache(200,120),middle=f.cache(400,240);
  source.getContext().fillText('多级缓存原文',20,40);
  middle.getContext().drawImage(source,0,0,400,240);f.ctx.drawImage(middle,30,50);
  readable(f,'多级缓存原文');f.stop();
});

test('self copying snapshots before mutation and duplicates non-overlapping original text once',()=>{
  const f=fixture();f.ctx.fillText('原文段落',20,40);
  f.ctx.drawImage(f.canvas,0,0,200,100,0,200,200,100);
  const result=readable(f,'原文段落\n原文段落');assert.equal(result.diagnostics.entries,2);f.stop();
});

test('a transparent cached text overlay cannot hide an existing different destination word',()=>{
  const f=fixture(),source=f.cache(200,120);
  source.getContext().fillText('缓存字',20,40);f.ctx.fillText('旧正文',20,40);
  f.ctx.drawImage(source,0,0);blocked(f);f.stop();
});

test('opaque cached backgrounds never leave stale destination text in a successful copy',()=>{
  const f=fixture(),source=f.cache(300,120),ctx=source.getContext();
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,300,120);ctx.fillStyle='#000000';ctx.fillText('替换后正文',20,40);
  f.ctx.fillText('已被背景覆盖的旧正文',20,40);f.ctx.drawImage(source,0,0);
  const result=f.snapshot();
  if(result.issue)assert.equal(result.text,'');else assert.equal(result.text,'替换后正文');
  f.stop();
});

test('destination clipping cannot promote a partly visible copied control to complete text',()=>{
  const f=fixture(),source=f.cache(300,120);source.getContext().fillText('查看全部',20,40);
  f.ctx.beginPath();f.ctx.rect(0,0,45,100);f.ctx.clip();f.ctx.drawImage(source,0,0);
  const result=blocked(f,{allowVerticalBoundary:true});assert.equal(result.marks.length,0);f.stop();
});

test('a cached expand control follows the copied position and remains tied to its current original glyphs',()=>{
  const f=fixture(),source=f.cache(300,120),ctx=source.getContext();
  ctx.fillText('工作经历',20,40);ctx.fillText('查看全部',20,80);
  f.ctx.drawImage(source,30,50,600,240);
  const result=readable(f,'工作经历\n查看全部');
  assert.equal(result.marks.length,1);assert.equal(result.marks[0].label,'查看全部');
  assert.ok(Math.abs(result.marks[0].x-110/773)<.00001);
  assert.ok(Math.abs(result.marks[0].y-202/956)<.00001);f.stop();
});

test('copied rounded notice geometry and image clips retain their verified decoration roles',()=>{
  const f=fixture(),source=f.cache(),ctx=source.getContext();
  ctx.font='22px sans-serif';ctx.fillText('王**',132,50);ctx.font='14px sans-serif';ctx.fillText('30岁 8年 本科',132,80);
  ctx.save();ctx.beginPath();ctx.arc(78,58,28,0,Math.PI*2);ctx.closePath();ctx.clip();
  ctx.drawImage({naturalWidth:200,naturalHeight:200},50,30,56,56);ctx.restore();
  ctx.drawImage({naturalWidth:38,naturalHeight:38},88,30,18,18);
  ctx.save();ctx.beginPath();ctx.roundRect(132,104,589,38,8);ctx.fill();ctx.clip();
  ctx.fillText('近14天你首次看到该牛人，赶紧联系TA吧',170,127.5);
  ctx.drawImage({naturalWidth:44,naturalHeight:44},142,112,22,22);ctx.restore();
  ctx.fillText('工作经历',132,180);ctx.fillText('完整正文必须保留',132,220);
  f.ctx.drawImage(source,0,0);
  const result=f.snapshot({expectedName:'王**'});
  assert.equal(result.issue,'');assert.equal(result.diagnostics.ignoredImages,3);assert.ok(result.text.includes('完整正文必须保留'));
  f.stop();
});
