import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../extension/canvas-text.js',import.meta.url),'utf8');
const geometry=fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8');

// Independent fixture so overlap regressions can vary actual ink and advance
// measurements without changing the general observer/geometry test fixtures.
function fixture({glyphResult,runResult}={}) {
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
      this.filter='none';this.lineWidth=1;this.font='12px sans-serif';
      this.matrix={a:1,b:0,c:0,d:1,e:0,f:0};
      this.metrics=value=>({width:value.length*10});
    }
    fillText(){} strokeText(){} clearRect(){} fillRect(){} drawImage(){} putImageData(){}
    save(){} restore(){} clip(){} reset(){} beginPath(){} moveTo(){} lineTo(){} rect(){} closePath(){}
    arc(){} arcTo(){} fill(){} stroke(){} strokeRect(){}
    getTransform(){return this.matrix;}
    measureText(value){
      const m=this.metrics(value),width=m.width;
      const shift=['end','right'].includes(this.textAlign)?width:this.textAlign==='center'?width/2:0;
      return {width,actualBoundingBoxLeft:shift-(m.inkLeft??0),actualBoundingBoxRight:(m.inkRight??width)-shift,
        actualBoundingBoxAscent:m.ascent??10,actualBoundingBoxDescent:m.descent??2};
    }
  }
  const canvas=new Canvas(),ctx=new Context(canvas),window={__hrmCanvasTextEnabled:true},glyphCalls=[];window.top=window;
  if(glyphResult||runResult){
    window.__hrmCanvasGlyphs={clear(){},stop(){},compare(first,second){
      glyphCalls.push({first,second});return typeof glyphResult==='function'?glyphResult(first,second):glyphResult;
    }};
    if(runResult)window.__hrmCanvasGlyphs.compareRuns=(first,second)=>{
      glyphCalls.push({first,second});return typeof runResult==='function'?runResult(first,second):runResult;
    };
  }
  const document={querySelectorAll:()=>[canvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  const sandbox={window,CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,document,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'})};
  vm.createContext(sandbox);vm.runInContext(geometry,sandbox);vm.runInContext(source,sandbox);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  return {canvas,ctx,glyphCalls,snapshot:()=>window.__hrmCanvasText.snapshot(),stop:()=>window.__hrmCanvasText.stop()};
}

const rasterResult=values=>({ok:false,separate:false,edgeOnly:false,reason:'unavailable',
  sharedPixels:0,sharedCorePixels:0,firstPixels:0,secondPixels:0,firstCorePixels:0,secondCorePixels:0,maxSharedMinAlpha:0,...values});

test('confirmed core-pixel overlap cannot be overruled by the old fractional floor geometry',()=>{
  const f=fixture({glyphResult:rasterResult({ok:true,reason:'pixel-overlap',sharedPixels:2,sharedCorePixels:2,
    firstPixels:80,secondPixels:75,firstCorePixels:60,secondCorePixels:55,maxSharedMinAlpha:255})});
  // This exact floor step and half-pixel ink collision qualified for the old
  // geometry fallback, even after a raster comparison had proved real overlap.
  f.ctx.metrics=()=>({width:9.375,inkLeft:0,inkRight:9.5});
  f.ctx.fillText('A',20,40);f.ctx.fillText('B',29,40);
  const result=f.snapshot(),check=result.diagnostics.details.find(item=>item.kind==='glyph-check');
  assert.match(result.issue,/文字重叠/);assert.equal(result.text,'');assert.equal(f.glyphCalls.length,1);
  assert.equal(check.reason,'pixel-overlap');assert.equal(check.sharedCorePixels,2);assert.equal(check.maxSharedMinAlpha,255);
  f.stop();
});

test('failed or unavailable raster verification cannot silently fall back to floor-position guessing',()=>{
  for(const reason of ['metrics-mismatch','unavailable']){
    const f=fixture({glyphResult:rasterResult({reason})});
    f.ctx.metrics=()=>({width:9.375,inkLeft:0,inkRight:9.5});
    f.ctx.fillText('A',20,40);f.ctx.fillText('B',29,40);
    const result=f.snapshot(),check=result.diagnostics.details.find(item=>item.kind==='glyph-check');
    assert.match(result.issue,/文字重叠/);assert.equal(result.text,'');assert.equal(f.glyphCalls.length,1);
    assert.equal(check.reason,reason);assert.equal(check.ok,false);f.stop();
  }
});

test('verified separate pixels may resolve an ordered non-floor advance overlap',()=>{
  const f=fixture({glyphResult:rasterResult({ok:true,separate:true,reason:'separate',firstPixels:80,secondPixels:75,
    firstCorePixels:60,secondCorePixels:55})});
  f.ctx.metrics=()=>({width:9.375,inkLeft:0,inkRight:9.5});
  f.ctx.fillText('A',20,40);f.ctx.fillText('B',29.25,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'AB');assert.equal(f.glyphCalls.length,1);f.stop();
});

test('verified edge-only contact is accepted only at the exact ordered floor step',()=>{
  for(const x of [29,29.1]){
    const f=fixture({glyphResult:rasterResult({ok:true,edgeOnly:true,reason:'edge-only',sharedPixels:2,
      firstPixels:80,secondPixels:75,firstCorePixels:60,secondCorePixels:55,maxSharedMinAlpha:100})});
    f.ctx.metrics=()=>({width:9.375,inkLeft:0,inkRight:9.5});
    f.ctx.fillText('A',20,40);f.ctx.fillText('B',x,40);
    const result=f.snapshot();assert.equal(f.glyphCalls.length,1);
    if(x===29){assert.equal(result.issue,'');assert.equal(result.text,'AB');}
    else {
      assert.match(result.issue,/文字重叠/);assert.equal(result.text,'');
      const check=result.diagnostics.details.find(item=>item.kind==='glyph-check');
      assert.equal(check.reason,'edge-only');assert.equal(check.ok,true);assert.equal(check.edgeOnly,true);
    }
    f.stop();
  }
});

test('multi-character draws cannot use a single-glyph raster result to excuse coverage',()=>{
  const f=fixture({glyphResult:rasterResult({ok:true,separate:true,reason:'separate'})});
  f.ctx.metrics=()=>({width:9.375,inkLeft:0,inkRight:9.5});
  f.ctx.fillText('AB',20,40);f.ctx.fillText('C',29,40);
  assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');assert.equal(f.glyphCalls.length,0);f.stop();
});

test('short text runs need verified disjoint pixels despite overlapping 0.338-pixel advances and ink boxes',()=>{
  const first={width:9.338,inkLeft:0,inkRight:10,ascent:10,descent:0};
  const second={width:14,inkLeft:0,inkRight:5,ascent:10,descent:0};
  for(const [proof,expected] of [
    [rasterResult({ok:true,separate:true,reason:'separate',firstPixels:24,secondPixels:15,
      firstCorePixels:20,secondCorePixels:12}),false],
    [rasterResult({ok:true,reason:'pixel-overlap',sharedPixels:1,sharedCorePixels:1,
      firstPixels:24,secondPixels:15,firstCorePixels:20,secondCorePixels:12}),true],
    [rasterResult({reason:'metrics-mismatch'}),true],
  ]){
    const f=fixture({runResult:proof});f.ctx.metrics=value=>value==='ab'?first:second;
    f.ctx.fillText('ab',20,40);f.ctx.fillText('c ',29,40);
    const result=f.snapshot();
    assert.equal(Boolean(result.issue),expected);
    if(expected)assert.match(result.issue,/文字重叠/);
    else assert.ok(result.text.includes('abc'));
    assert.equal(f.glyphCalls.length,1);
    assert.equal(f.glyphCalls[0].first.text,'ab');assert.equal(f.glyphCalls[0].second.text,'c ');
    f.stop();
  }
});

test('more than 65 separately rounded Chinese advances preserve every original glyph',()=>{
  for(const reverse of [false,true]){
    const f=fixture(),text='逐字绘制仍应完整保留准确原文，不能丢失任何字符。'.repeat(4);
    f.ctx.metrics=value=>({width:value===' '?3:value.length*9.375,inkLeft:1,inkRight:value.length*9.375-1.175});
    const order=Array.from(text,(_,index)=>index);if(reverse)order.reverse();
    for(const index of order)f.ctx.fillText(text[index],Math.round(20+index*9.375),40);
    assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,text);
    assert.equal(f.snapshot().diagnostics.entries,text.length);
    assert.equal(f.snapshot().diagnostics.reasonCounts.length,0);f.stop();
  }
});

test('whole-run kerning positions may overlap standalone advances when the painted glyphs remain separate',()=>{
  const f=fixture();
  f.ctx.metrics=value=>({width:value==='AV'?17:value===' '?3:10,inkLeft:1,inkRight:7});
  const next=20+f.ctx.measureText('AV').width-f.ctx.measureText('V').width;
  f.ctx.fillText('A',20,40);f.ctx.fillText('V',next,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'AV');f.stop();
});

test('actual ink separation proves order even when measured advances are much wider',()=>{
  const f=fixture();f.ctx.metrics=()=>({width:100,inkLeft:0,inkRight:10});
  f.ctx.fillText('A',20,40);f.ctx.fillText('B',70,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'AB');f.stop();
});

test('rounded positions retain separately painted original spaces without inventing extras',()=>{
  const f=fixture();
  f.ctx.metrics=value=>({width:/^\s+$/.test(value)?value.length*3:value.length*9.375,inkLeft:1,inkRight:8.2});
  f.ctx.fillText('A',20,40);f.ctx.fillText('  ',29,40);f.ctx.fillText('V',35,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'A  V');f.stop();
});

test('same-line spacing uses advances and alignment rather than narrow ink bounds',()=>{
  for(const alignment of ['start','left','center','right','end']){
    const f=fixture();f.ctx.textAlign=alignment;
    f.ctx.metrics=value=>({width:value===' '?3:9.375,inkLeft:1,inkRight:8.2});
    const offset=['end','right'].includes(alignment)?9.375:alignment==='center'?9.375/2:0;
    f.ctx.fillText('A',20+offset,40);f.ctx.fillText('V',29+offset,40);f.ctx.fillText('B',45+offset,40);
    assert.equal(f.snapshot().issue,'',alignment);assert.equal(f.snapshot().text,'AV B',alignment);f.stop();
  }
});

test('double-precision adjacent endpoint arithmetic does not turn overhang into a collision',()=>{
  const f=fixture();f.ctx.metrics=()=>({width:.2,inkLeft:-.02,inkRight:.22});
  f.ctx.fillText('A',.1,40);f.ctx.fillText('B',.3,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'AB');f.stop();
});

const observedQuantizedPairs=[
  {first:{width:9.338,inkLeft:-1,inkRight:10},second:{width:14,inkLeft:0,inkRight:15},step:9},
  {first:{width:10.11,inkLeft:0,inkRight:10},second:{width:7.786,inkLeft:-1,inkRight:8},step:10},
  {first:{width:13.214,inkLeft:0,inkRight:15},second:{width:3.11,inkLeft:1,inkRight:4},step:13},
];

test('observed single-character integer advances retain original text despite one-pixel edge overhang',()=>{
  for(const reverse of [false,true]){
    const f=fixture();f.canvas.height=2400;const expected=[];
    for(let row=0;row<66;row++){
      const pair=observedQuantizedPairs[row%observedQuantizedPairs.length];
      f.ctx.metrics=value=>({...((value==='甲')?pair.first:pair.second),ascent:10,descent:0});
      const draws=[['甲',20,40+row*30],['乙',20+pair.step,40+row*30]];
      for(const args of reverse?draws.reverse():draws)f.ctx.fillText(...args);
      expected.push('甲乙');
    }
    assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,expected.join('\n'));
    assert.equal(f.snapshot().diagnostics.entries,132);f.stop();
  }
});

test('integer positioning that shortens an already integral advance remains real compression',()=>{
  const f=fixture();f.ctx.fillText('甲',20,40);f.ctx.fillText('乙',29,40);
  assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
});

test('quantized glyph positioning is checked in local coordinates at a shared high-DPI transform',()=>{
  const f=fixture(),pair=observedQuantizedPairs[0];
  f.ctx.matrix={a:2,b:0,c:0,d:2,e:.25,f:.5};
  f.ctx.metrics=value=>value==='甲'?pair.first:pair.second;
  f.ctx.fillText('甲',20.25,40);f.ctx.fillText('乙',29.25,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'甲乙');f.stop();
});

test('near-integer steps and nearly matching baselines are not evidence of glyph quantization',()=>{
  for(const [x,y] of [[29.01,40],[28.99,40],[29,40.05]]){
    const f=fixture(),pair=observedQuantizedPairs[0];f.ctx.metrics=value=>value==='甲'?pair.first:pair.second;
    f.ctx.fillText('甲',20,40);f.ctx.fillText('乙',x,y);
    assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
  }
});

test('quantized steps do not permit a wider ink collision or conceal the main body of a thin glyph',()=>{
  for(const pair of [
    {first:{width:9.338,inkLeft:-1,inkRight:11},second:{width:14,inkLeft:0,inkRight:15},step:9},
    {first:{width:13.214,inkLeft:0,inkRight:15},second:{width:3.11,inkLeft:1,inkRight:3},step:13},
  ]){
    const f=fixture();f.ctx.metrics=value=>value==='甲'?pair.first:pair.second;
    f.ctx.fillText('甲',20,40);f.ctx.fillText('乙',20+pair.step,40);
    assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
  }
});

test('quantized overhang requires matching font, layout, transform and fill-only drawing',()=>{
  for(const change of [
    f=>{f.ctx.font='14px sans-serif';},
    f=>{f.ctx.fontKerning='none';},
    f=>{f.ctx.letterSpacing='1px';},
    f=>{f.ctx.textBaseline='top';},
    f=>{f.ctx.matrix={a:2,b:0,c:0,d:1,e:0,f:0};},
    f=>{f.ctx.shadowColor='#000000';},
    f=>{f.ctx.globalAlpha=.5;},
  ]){
    const f=fixture(),pair=observedQuantizedPairs[0];f.ctx.metrics=value=>value==='甲'?pair.first:pair.second;
    f.ctx.fillText('甲',20,40);change(f);
    f.ctx.fillText('乙',f.ctx.matrix.a===2?14.5:29,40);
    assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
  }
  const f=fixture(),pair=observedQuantizedPairs[0];f.ctx.metrics=value=>value==='甲'?pair.first:pair.second;
  f.ctx.strokeText('甲',20,40);f.ctx.fillText('乙',29,40);
  assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
});

test('quantized overhang is restricted to individual non-combining painted characters',()=>{
  for(const first of ['两个','\u0301']){
    const f=fixture(),pair=observedQuantizedPairs[0];f.ctx.metrics=value=>value===first?pair.first:pair.second;
    f.ctx.fillText(first,20,40);f.ctx.fillText('乙',29,40);
    assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
  }
});

test('an original separately drawn space paints no ink and survives an ordered quantized run',()=>{
  const f=fixture(),pair=observedQuantizedPairs[0];f.ctx.metrics=value=>value===' '?pair.first:pair.second;
  f.ctx.fillText(' ',20,40);f.ctx.fillText('乙',29,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,' 乙');f.stop();
});

test('a real subpixel overlap in both ink and advance remains an error',()=>{
  const f=fixture();f.ctx.fillText('A',20,40);f.ctx.fillText('B',29.95,40);
  assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
});

test('scale changes cannot turn true overlap into an allowed pixel tolerance',()=>{
  const f=fixture();f.ctx.matrix={a:2,b:0,c:0,d:2,e:0,f:0};
  f.ctx.fillText('A',20,40);f.ctx.fillText('B',29.99,40);
  assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
});

test('disjoint ink with an order opposite the advances is still ambiguous',()=>{
  const f=fixture();f.ctx.metrics=value=>({width:100,inkLeft:value==='A'?80:0,inkRight:value==='A'?90:10});
  f.ctx.fillText('A',20,40);f.ctx.fillText('B',70,40);
  assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
});

test('overlap across separate baselines is not mistaken for a same-line rounding error',()=>{
  const f=fixture();f.ctx.metrics=()=>({width:10,inkLeft:-1,inkRight:11});
  f.ctx.fillText('A',20,40);f.ctx.fillText('B',30,45);
  assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
});

test('an identical stroke then fill is deduplicated but shifted repaint remains unresolved',()=>{
  const f=fixture();f.ctx.strokeText('原文',20,40);f.ctx.fillText('原文',20,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'原文');
  f.ctx.fillText('原文',20.2,40);
  assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
});

test('full glyph clearing followed by replacement does not retain the old glyph',()=>{
  const f=fixture();f.ctx.metrics=()=>({width:10,inkLeft:-1,inkRight:11});
  f.ctx.fillText('旧',20,40);f.ctx.clearRect(19,30,12,12);f.ctx.fillText('新',20,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'新');f.stop();
});

test('clearing only an overhang cannot silently erase evidence of a partially remaining glyph',()=>{
  const f=fixture();f.ctx.metrics=()=>({width:10,inkLeft:-1,inkRight:11});
  f.ctx.fillText('旧',20,40);f.ctx.clearRect(30,30,1,12);f.ctx.fillText('新',20,40);
  assert.match(f.snapshot().issue,/局部覆盖/);assert.equal(f.snapshot().text,'');f.stop();
});

test('a changed measurement on a redraw does not silently count the same text twice',()=>{
  const f=fixture();f.ctx.fillText('原文',20,40);
  f.ctx.metrics=value=>({width:value.length*11});f.ctx.fillText('原文',20,40);
  assert.match(f.snapshot().issue,/文字重叠/);assert.equal(f.snapshot().text,'');f.stop();
});

test('overlap diagnostics contain no resume strings or context font values',()=>{
  const f=fixture();f.ctx.font='12px secret-candidate-font';
  f.ctx.fillText('唯一候选人甲',20,40);f.ctx.fillText('唯一候选人乙',25,40);
  const result=f.snapshot();assert.match(result.issue,/文字重叠/);
  const serialized=JSON.stringify(result.diagnostics);
  assert.doesNotMatch(serialized,/唯一候选人|secret-candidate-font/);
  const detail=result.diagnostics.details.find(item=>item.kind==='text-overlap');
  assert.ok(detail);
  assert.equal(detail.advanceOverlap,55);assert.equal(detail.inkOverlapX,55);assert.equal(detail.inkOverlapY,12);
  assert.equal(detail.baselineDelta,0);assert.equal(detail.previousLength,6);assert.equal(detail.currentLength,6);
  assert.equal(detail.previousWidth,60);assert.equal(detail.currentWidth,60);
  assert.equal(detail.previousInkWidth,60);assert.equal(detail.currentInkWidth,60);
  assert.equal(detail.scaleX,1);assert.equal(detail.scaleY,1);
  for(const [key,value] of Object.entries(detail))if(key!=='kind')assert.ok(Number.isFinite(value),key);
  f.stop();
});

test('overlap diagnostics retain at most three numeric samples and reset with the bitmap',()=>{
  const f=fixture();f.ctx.fillText('原始正文',20,40);
  for(let i=0;i<12;i++)f.ctx.fillText(`重叠${i}`,25+i,40);
  assert.equal(f.snapshot().diagnostics.details.filter(item=>item.kind==='text-overlap').length,3);
  f.ctx.clearRect(0,0,f.canvas.width,f.canvas.height);f.ctx.fillText('新正文',20,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().diagnostics.details.length,0);
  assert.equal(f.snapshot().text,'新正文');f.stop();
});
