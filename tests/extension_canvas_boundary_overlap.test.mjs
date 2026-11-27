import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../extension/canvas-text.js',import.meta.url),'utf8');
const geometry=fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8');

// Synthetic metrics reproduce the reported 773x956 canvas and bottom row.
// Glyph ink may extend beyond its ordered advance without covering a neighbour.
function fixture({glyphResult}={}){
  class Canvas {
    constructor(){this._width=773;this._height=956;this.isConnected=false;this.ctx=null;}
    get width(){return this._width;} set width(value){this._width=value;}
    get height(){return this._height;} set height(value){this._height=value;}
    getBoundingClientRect(){return {left:0,top:0,width:this.width,height:this.height};}
    getContext(){return this.ctx||(this.ctx=new Context(this));}
  }
  class Context {
    constructor(canvas){
      this.canvas=canvas;this.globalAlpha=1;this.fillStyle='#000000';this.strokeStyle='#000000';
      this.globalCompositeOperation='source-over';this.direction='ltr';this.textAlign='start';this.textBaseline='alphabetic';
      this.filter='none';this.lineWidth=1;this.font='14px sans-serif';this.shadowColor='transparent';
      this.matrix={a:1,b:0,c:0,d:1,e:0,f:0};this.metrics=value=>({width:value===' '?3:value.length*14});
    }
    fillText(){} strokeText(){} clearRect(){} fillRect(){} drawImage(){} putImageData(){}
    save(){} restore(){} clip(){} reset(){} beginPath(){} moveTo(){} lineTo(){} rect(){} closePath(){}
    arc(){} arcTo(){} fill(){} stroke(){} strokeRect(){}
    getTransform(){return this.matrix;}
    measureText(value){
      const m=this.metrics(value),width=m.width;
      return {width,actualBoundingBoxLeft:-(m.inkLeft??0),actualBoundingBoxRight:m.inkRight??width,
        actualBoundingBoxAscent:m.ascent??11,actualBoundingBoxDescent:m.descent??1};
    }
  }
  const canvas=new Canvas();canvas.isConnected=true;
  const ctx=canvas.getContext(),window={__hrmCanvasTextEnabled:true},glyphCalls=[];window.top=window;
  if(glyphResult)window.__hrmCanvasGlyphs={clear(){},stop(){},compare(first,second){
    glyphCalls.push({first,second});return glyphResult;
  }};
  const document={querySelectorAll:()=>[canvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  const sandbox={window,document,HTMLCanvasElement:Canvas,CanvasRenderingContext2D:Context,
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'}),
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'}};
  vm.createContext(sandbox);vm.runInContext(geometry,sandbox);vm.runInContext(source,sandbox);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  return {canvas,ctx,glyphCalls,cache:()=>document.createElement('canvas'),
    snapshot:(options={})=>window.__hrmCanvasText.snapshot({allowVerticalBoundary:true,...options}),
    stop:()=>window.__hrmCanvasText.stop()};
}

const rowText=Array.from({length:39},(_,index)=>String.fromCharCode(0x4e00+index)).join('');
function reportedMetrics(value){
  const index=rowText.indexOf(value);
  return {width:value===' '?3:value.length*14,inkRight:value.length===1&&index>=0&&index<22?16:value.length*14,
    ascent:11,descent:1};
}
const count=(result,reason)=>result.diagnostics.reasonCounts.find(item=>item.reason===reason)?.count||0;

test('the reported bottom row keeps all 39 glyphs deferred instead of splitting into 28 boundary and 11 overlap issues',()=>{
  const f=fixture();f.ctx.fillText('完整正文',20,40);f.ctx.metrics=reportedMetrics;
  for(const [index,char] of [...rowText].entries())f.ctx.fillText(char,133+index*14,963);
  const result=f.snapshot();
  assert.equal(count(result,'画布边界截断了文字'),39);
  assert.equal(count(result,'画布文字重叠，无法确认正文顺序'),0);
  assert.equal(result.issue,'');assert.equal(result.text,'完整正文');assert.equal(result.boundaryRows.bottom,true);
  const edge=result.diagnostics.details.find(item=>item.kind==='text-boundary');
  assert.equal(edge.left,133);assert.equal(edge.top,952);assert.equal(edge.right,149);assert.equal(edge.bottom,964);
  assert.equal(edge.baseline,963);assert.equal(edge.overflowBottom,8);assert.equal(edge.deferred,true);
  assert.match(f.snapshot({allowVerticalBoundary:false}).issue,/边界截断/);f.stop();
});

test('mixed complete and boundary glyphs use the same ordered-advance rule in either drawing order',()=>{
  for(const reverse of [false,true]){
    const f=fixture();f.ctx.fillText('完整正文',20,40);
    f.ctx.metrics=value=>({width:14,inkRight:16,ascent:11,descent:value==='甲'?0:2});
    const draws=[['甲',133,955],['乙',147,955]];
    for(const args of reverse?draws.reverse():draws)f.ctx.fillText(...args);
    const result=f.snapshot();assert.equal(result.issue,'');assert.equal(result.text,'完整正文');
    assert.equal(count(result,'画布文字重叠，无法确认正文顺序'),0);assert.equal(result.boundaryRows.bottom,true);f.stop();
  }
});

test('boundary fragments retain glyph evidence for independently verified pixel separation',()=>{
  const f=fixture({glyphResult:{ok:true,separate:true,edgeOnly:false,reason:'separate'}});
  f.ctx.fillText('完整正文',20,40);f.ctx.metrics=()=>({width:14.4,inkRight:16,ascent:11,descent:1});
  f.ctx.fillText('甲',133,963);f.ctx.fillText('乙',147,963);
  const result=f.snapshot();assert.equal(result.issue,'');assert.equal(result.text,'完整正文');
  assert.equal(f.glyphCalls.length,1);assert.equal(f.glyphCalls[0].first.text,'甲');
  assert.equal(f.glyphCalls[0].first.baseline,963);assert.equal(f.glyphCalls[0].second.baseline,963);f.stop();
});

test('real boundary collisions and cross-baseline overlays still fail with geometric diagnostics',()=>{
  for(const second of [['乙',133,963],['甲',135,963],['乙',147,962]]){
    const f=fixture();f.ctx.fillText('完整正文',20,40);
    f.ctx.metrics=()=>({width:14,inkRight:16,ascent:11,descent:1});
    f.ctx.fillText('甲',133,963);f.ctx.fillText(...second);
    const result=f.snapshot();assert.match(result.issue,/文字重叠/);assert.equal(result.text,'');
    const detail=result.diagnostics.details.find(item=>item.kind==='text-overlap');
    assert.ok(detail);assert.ok(detail.inkOverlapX>0);assert.ok(detail.inkOverlapY>0);f.stop();
  }
});

test('boundary core-pixel collisions cannot be excused by fractional advance quantization',()=>{
  const f=fixture({glyphResult:{ok:true,separate:false,edgeOnly:false,reason:'pixel-overlap',
    sharedPixels:2,sharedCorePixels:2,maxSharedMinAlpha:255}});
  f.ctx.fillText('完整正文',20,40);f.ctx.metrics=()=>({width:14.4,inkRight:14.5,ascent:11,descent:1});
  f.ctx.fillText('甲',133,963);f.ctx.fillText('乙',147,963);
  const result=f.snapshot();assert.match(result.issue,/文字重叠/);assert.equal(result.text,'');
  assert.equal(result.diagnostics.details.find(item=>item.kind==='glyph-check').sharedCorePixels,2);f.stop();
});

test('an identical repeated boundary glyph is deferred once rather than treated as a new overlapping word',()=>{
  const f=fixture();f.ctx.fillText('完整正文',20,40);f.ctx.metrics=()=>({width:14,inkRight:16,ascent:11,descent:1});
  f.ctx.fillText('甲',133,963);f.ctx.fillText('甲',133,963);
  const result=f.snapshot();assert.equal(result.issue,'');assert.equal(result.text,'完整正文');
  assert.equal(count(result,'画布文字重叠，无法确认正文顺序'),0);assert.equal(result.boundaryRows.bottom,true);f.stop();
});

test('the full 39-glyph boundary row is recovered exactly once when both cache tiles cover it',()=>{
  const f=fixture(),first=f.cache(),second=f.cache(),a=first.getContext(),b=second.getContext();
  a.fillText('接缝前原文',20,560);b.fillText('接缝后原文',20,50);
  a.metrics=reportedMetrics;b.metrics=reportedMetrics;
  for(const [index,char] of [...rowText].entries()){
    a.fillText(char,133+index*14,963);b.fillText(char,133+index*14,7);
  }
  f.ctx.drawImage(first,0,-526);f.ctx.drawImage(second,0,430);
  const result=f.snapshot();assert.equal(result.issue,'');assert.equal(result.text,'接缝前原文\n'+rowText+'\n接缝后原文');
  assert.equal(result.diagnostics.entries,41);assert.equal(result.boundaryRows.bottom,false);f.stop();
});
