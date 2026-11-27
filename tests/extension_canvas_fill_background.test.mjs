import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const geometry=fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8');
const source=fs.readFileSync(new URL('../extension/canvas-text.js',import.meta.url),'utf8');
function fixture({coverage,observeIssues=false,measure,compare}={}){
  class Canvas{
    constructor(){this._width=1000;this._height=1000;this.isConnected=true;}
    get width(){return this._width;}set width(value){this._width=value;}
    get height(){return this._height;}set height(value){this._height=value;}
    getContext(){return this.ctx||(this.ctx=new Context(this));}
    getBoundingClientRect(){return {left:0,top:0,width:500,height:500};}
  }
  class Context{
    constructor(canvas){Object.assign(this,{canvas,font:'14px Arial',globalAlpha:1,fillStyle:'#111111',strokeStyle:'#111111',lineWidth:1,
      globalCompositeOperation:'source-over',direction:'ltr',textAlign:'start',textBaseline:'alphabetic',filter:'none',
      shadowColor:'rgba(0,0,0,0)',shadowBlur:0,shadowOffsetX:0,shadowOffsetY:0,matrix:{a:1,b:0,c:0,d:1,e:0,f:0}});canvas.ctx=this;}
    fillText(){}strokeText(){}clearRect(){}fillRect(){}drawImage(){}putImageData(){}save(){}restore(){}clip(){}reset(){}
    beginPath(){}moveTo(){}lineTo(){}rect(){}closePath(){}arc(){}arcTo(){}fill(){}stroke(){}strokeRect(){}
    getTransform(){return this.matrix;}
    measureText(value){return measure?measure(value):{width:value.length*10,actualBoundingBoxLeft:0,actualBoundingBoxRight:value.length*10,actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};}
  }
  const canvas=new Canvas(),ctx=canvas.getContext(),calls=[];
  const window={__hrmCanvasTextEnabled:true};window.top=window;
  if(coverage)window.__hrmCanvasGlyphs={clear(){},stop(){},compare:compare||(()=>({ok:false,separate:false})),coverage(raw,rect){calls.push({raw,rect});return typeof coverage==='function'?coverage(raw,rect):coverage;}};
  const document={querySelectorAll:()=>[canvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  const sandbox=vm.createContext({window,document,CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'})});
  const observedSource=observeIssues?source.replace('function issue(d,message,rect=null,extra={}) {',
    'function issue(d,message,rect=null,extra={}) { window.__repeatIssueForTest=()=>issue(d,message,rect,extra);'):source;
  vm.runInContext(geometry,sandbox);vm.runInContext(observedSource,sandbox);ctx.clearRect(0,0,1000,1000);
  return {canvas,ctx,calls,cache:()=>document.createElement('canvas'),snapshot:()=>window.__hrmCanvasText.snapshot(),
    repeatIssue:()=>window.__repeatIssueForTest(),stop:()=>window.__hrmCanvasText.stop()};
}
function highlight(ctx,operation='fillRect'){
  const original=ctx.fillStyle;ctx.fillStyle='#ccffff';
  if(operation==='fill-path'){ctx.beginPath();ctx.rect(25,31,10,5);ctx.fill();}
  else ctx[operation](25,31,10,5);
  ctx.fillStyle=original;
}

test('backgrounds painted before text and partial fill on inkless spaces preserve exact source text',()=>{
  const first=fixture();highlight(first.ctx);first.ctx.fillText('AB',20,40);
  assert.equal(first.snapshot().text,'AB');assert.equal(first.snapshot().issue,'');first.stop();
  for(const operation of ['fillRect','clearRect','fill-path']){
    const f=fixture();f.ctx.fillText('甲',10,40);f.ctx.fillText('  ',20,40);f.ctx.fillText('乙',40,40);
    const before=f.snapshot().text;highlight(f.ctx,operation);
    assert.equal(f.snapshot().text,before);assert.equal(f.snapshot().issue,'');f.stop();
  }
});

test('only a complete identical opaque original repaint resolves its own partial-cover error and diagnostics',()=>{
  for(const operation of ['fillRect','clearRect','fill-path'])for(const text of ['AB','甲']){
    const f=fixture();f.ctx.fillText(text,20,40);highlight(f.ctx,operation);
    const partial=f.snapshot();assert.match(partial.issue,/局部覆盖/);
    assert.equal(partial.diagnostics.reasonCounts.find(item=>item.reason==='画布文字被局部覆盖').count,1);
    const detail=partial.diagnostics.details.find(item=>item.kind==='text-cover');
    assert.equal(detail.operation,operation);assert.equal(detail.textLength,text.length);assert.equal(detail.verification,'unavailable');
    assert.doesNotMatch(JSON.stringify(detail),/AB|甲|Arial|ccffff|font|style|repaint/);
    f.ctx.fillText(text,20,40);const restored=f.snapshot();
    assert.equal(restored.issue,'');assert.equal(restored.text,text);
    assert.ok(!restored.diagnostics.reasonCounts.some(item=>item.reason==='画布文字被局部覆盖'));
    assert.ok(!restored.diagnostics.details.some(item=>item.kind==='text-cover'));
    highlight(f.ctx,operation);assert.match(f.snapshot().issue,/局部覆盖/);f.stop();
  }
});

test('restoring one word does not forgive another covered word or an independent drawing issue',()=>{
  const f=fixture();f.ctx.fillText('A',20,40);f.ctx.fillText('B',30,40);highlight(f.ctx);
  assert.equal(f.snapshot().diagnostics.reasonCounts.find(item=>item.reason==='画布文字被局部覆盖').count,2);
  f.ctx.fillText('A',20,40);assert.match(f.snapshot().issue,/局部覆盖/);
  assert.equal(f.snapshot().diagnostics.reasonCounts.find(item=>item.reason==='画布文字被局部覆盖').count,1);
  f.ctx.fillText('B',30,40);assert.equal(f.snapshot().text,'AB');f.stop();
  const unsafe=fixture();unsafe.ctx.fillText('AB',20,40);unsafe.ctx.strokeRect(200,200,30,30);highlight(unsafe.ctx);
  unsafe.ctx.fillText('AB',20,40);assert.ok(unsafe.snapshot().issue);unsafe.stop();
});

test('changed text, font, color, exact position, transform, alpha, stroke or compressed/clipped redraw cannot restore evidence',()=>{
  const edits=[ctx=>ctx.fillText('AC',20,40),ctx=>{ctx.font='15px Arial';ctx.fillText('AB',20,40);},
    ctx=>{ctx.fillStyle='#222222';ctx.fillText('AB',20,40);},ctx=>ctx.fillText('AB',20.00000001,40),
    ctx=>{ctx.matrix={a:2,b:0,c:0,d:2,e:0,f:0};ctx.fillText('AB',10,20);},
    ctx=>{ctx.globalAlpha=.5;ctx.fillText('AB',20,40);},ctx=>ctx.strokeText('AB',20,40),
    ctx=>ctx.fillText('AB',20,40,10),ctx=>{ctx.beginPath();ctx.rect(20,30,10,12);ctx.clip();ctx.fillText('AB',20,40);}];
  for(const edit of edits){const f=fixture();f.ctx.fillText('AB',20,40);highlight(f.ctx);edit(f.ctx);assert.ok(f.snapshot().issue);f.stop();}
  for(const style of ['rgba(0,0,0,.5)',{pattern:true}]){
    const f=fixture();f.ctx.fillStyle=style;f.ctx.fillText('AB',20,40);highlight(f.ctx);f.ctx.fillText('AB',20,40);
    assert.match(f.snapshot().issue,/局部覆盖/);f.stop();
  }
});

test('only strict zero-ink pixel verification preserves a non-space text box intersection',()=>{
  const clear={ok:true,separate:true,coveredPixels:0,coveredCorePixels:0};
  const f=fixture({coverage:clear});f.ctx.fillText('A',20,40);highlight(f.ctx);assert.equal(f.snapshot().text,'A');assert.equal(f.calls.length,1);f.stop();
  for(const coverage of [{ok:false,separate:true,coveredPixels:0,coveredCorePixels:0},
    {ok:true,separate:false,coveredPixels:1,coveredCorePixels:0},{ok:true,separate:true,coveredPixels:1,coveredCorePixels:0}]){
    const f=fixture({coverage});f.ctx.fillText('A',20,40);highlight(f.ctx);assert.match(f.snapshot().issue,/局部覆盖/);f.stop();
  }
  const run=fixture({coverage:clear});run.ctx.fillText('AB',20,40);highlight(run.ctx);
  assert.equal(run.snapshot().issue,'');assert.equal(run.snapshot().text,'AB');assert.equal(run.calls.length,1);run.stop();
  const touched=fixture({coverage:{ok:true,separate:false,coveredPixels:1,coveredCorePixels:0}});
  touched.ctx.fillText('AB',20,40);highlight(touched.ctx);
  assert.match(touched.snapshot().issue,/局部覆盖/);touched.stop();
});

test('shadow, filter, non-source-over and pattern backgrounds cannot use the simple rectangle exception',()=>{
  for(const change of [ctx=>{ctx.shadowColor='#000000';ctx.shadowBlur=3;},ctx=>{ctx.filter='blur(1px)';},
    ctx=>{ctx.globalCompositeOperation='destination-out';},ctx=>{ctx.fillStyle={pattern:true};}]){
    const f=fixture({coverage:{ok:true,separate:true,coveredPixels:0,coveredCorePixels:0}});f.ctx.fillText('A',20,40);
    change(f.ctx);f.ctx.fillRect(25,31,2,2);assert.ok(f.snapshot().issue);assert.equal(f.calls.length,0);f.stop();
  }
});

test('cache-copied entries and copied unresolved issues never acquire original repaint evidence',()=>{
  for(const partialSource of [false,true]){
    const f=fixture(),cache=f.cache(),ctx=cache.getContext();ctx.clearRect(0,0,1000,1000);ctx.fillText('AB',20,40);
    if(partialSource)highlight(ctx);f.ctx.drawImage(cache,0,0);if(!partialSource)highlight(f.ctx);
    f.ctx.fillText('AB',20,40);assert.match(f.snapshot().issue,/局部覆盖/);f.stop();
  }
});

test('same-box coverage issues retain distinct original repaint keys across multiple text changes',()=>{
  const f=fixture();f.ctx.fillText('AB',20,40);highlight(f.ctx);f.ctx.fillText('AC',20,40);highlight(f.ctx);
  assert.equal(f.snapshot().diagnostics.reasonCounts.find(item=>item.reason==='画布文字被局部覆盖').count,2);
  f.ctx.fillText('AB',20,40);const result=f.snapshot();
  assert.match(result.issue,/局部覆盖/);assert.equal(result.text,'');
  assert.equal(result.diagnostics.reasonCounts.find(item=>item.reason==='画布文字被局部覆盖').count,1);f.stop();
});

test('an unrepairable copied issue cannot merge into a same-box repairable original issue',()=>{
  const f=fixture();f.ctx.fillText('AB',20,40);highlight(f.ctx);
  const cache=f.cache(),ctx=cache.getContext();ctx.clearRect(0,0,1000,1000);ctx.fillText('CD',20,40);highlight(ctx);
  f.ctx.drawImage(cache,0,0);assert.equal(f.snapshot().diagnostics.reasonCounts.find(item=>item.reason==='画布文字被局部覆盖').count,2);
  f.ctx.fillText('AB',20,40);assert.match(f.snapshot().issue,/局部覆盖/);assert.equal(f.snapshot().text,'');f.stop();
});

test('nearby unrepairable cache issue bounds never merge before a partial local clear',()=>{
  const f=fixture(),cache=f.cache(),ctx=cache.getContext();ctx.clearRect(0,0,1000,1000);ctx.fillText('AB',20,40);highlight(ctx);
  f.ctx.drawImage(cache,0,0);f.ctx.drawImage(cache,.05,0);
  assert.equal(f.snapshot().diagnostics.reasonCounts.find(item=>item.reason==='画布文字被局部覆盖').count,2);
  f.ctx.fillRect(20,30,20,12);f.ctx.fillText('SAFE',100,100);
  assert.match(f.snapshot().issue,/局部覆盖/);assert.equal(f.snapshot().text,'');f.stop();
});

test('repeated identical private coverage evidence still deduplicates and restores only its own original paint',()=>{
  const f=fixture({observeIssues:true});f.ctx.fillText('AB',20,40);highlight(f.ctx);
  f.repeatIssue();f.repeatIssue();
  assert.equal(f.snapshot().diagnostics.reasonCounts.find(item=>item.reason==='画布文字被局部覆盖').count,1);
  f.ctx.fillText('AB',20,40);assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'AB');f.stop();
});

test('a different same-box paint before erasure invalidates the old mask and repair key',()=>{
  for(const change of [ctx=>{ctx.font='14px Georgia';ctx.fillText('AB',20,40);ctx.font='14px Arial';},
    ctx=>{ctx.fillStyle='#222222';ctx.fillText('AB',20,40);ctx.fillStyle='#111111';},
    ctx=>ctx.strokeText('AB',20,40),ctx=>{ctx.globalAlpha=.5;ctx.fillText('AB',20,40);ctx.globalAlpha=1;},
    ctx=>{ctx.shadowColor='#000000';ctx.fillText('AB',20,40);ctx.shadowColor='rgba(0,0,0,0)';}]){
    const f=fixture();f.ctx.fillText('AB',20,40);change(f.ctx);highlight(f.ctx);f.ctx.fillText('AB',20,40);
    assert.match(f.snapshot().issue,/局部覆盖/);f.stop();
  }
  const clear={ok:true,separate:true,coveredPixels:0,coveredCorePixels:0};
  const mixed=fixture({coverage:clear});mixed.ctx.fillText('A',20,40);mixed.ctx.strokeText('A',20,40);highlight(mixed.ctx);
  assert.match(mixed.snapshot().issue,/局部覆盖/);assert.equal(mixed.calls.length,0);mixed.stop();
  const identical=fixture({coverage:clear});identical.ctx.fillText('A',20,40);identical.ctx.fillText('A',20,40);highlight(identical.ctx);
  assert.equal(identical.snapshot().text,'A');assert.equal(identical.calls.length,1);identical.stop();
});

const fringe={ok:true,separate:false,coveredPixels:2,coveredCorePixels:0,pixels:124,corePixels:61,
  maxCoveredAlpha:25,rightEdgeOnly:true,edgeCoreAdjacent:true,coveredLeft:440,coveredTop:391,coveredRight:441,coveredBottom:393};
function highlightFixture(overrides={}){
  return fixture({coverage:fringe,measure:value=>({width:value==='甲'&&overrides.fractional?14.5:14,
    actualBoundingBoxLeft:1,actualBoundingBoxRight:value==='甲'?15:14,actualBoundingBoxAscent:11,actualBoundingBoxDescent:1}),
    compare:()=>({ok:true,separate:false,edgeOnly:true}),...overrides});
}
function pendingFixture(overrides={}){
  return highlightFixture({coverage:{...fringe,maxCoveredAlpha:40},...overrides});
}
function cell(ctx,x,{width=14,y=376,height=26,color='#ccffff',operation='fillRect'}={}){
  const original=ctx.fillStyle;ctx.fillStyle=color;
  if(operation==='fill-path'){ctx.beginPath();ctx.rect(x,y,width,height);ctx.fill();}
  else ctx[operation](x,y,width,height);
  ctx.fillStyle=original;
}
function firstHighlighted(f){cell(f.ctx,426);f.ctx.fillText('甲',426,393);}
function underline(ctx,y=397){ctx.beginPath();ctx.moveTo(426,y);ctx.lineTo(440,y);ctx.stroke();}

test('a fully witnessed adjacent highlight cell restores only the pending original right AA fringe',()=>{
  for(const fractional of [false,true]){
    const f=pendingFixture({fractional});firstHighlighted(f);cell(f.ctx,440);
    const pending=f.snapshot();assert.match(pending.issue,/局部覆盖/);
    const detail=pending.diagnostics.details.find(item=>item.kind==='text-cover');
    assert.equal(detail.highlightCandidate,true);assert.equal(detail.priorHighlightCell,true);assert.equal(detail.highlightContinuity,true);
    assert.equal(detail.maxCoveredAlpha,40);assert.equal(detail.edgeCoreAdjacent,true);assert.equal(detail.corePixels,61);
    assert.equal(detail.advanceLeft,426);assert.equal(detail.baseline,393);
    assert.doesNotMatch(JSON.stringify(detail),/甲|Arial|ccffff|font|style|proof/);
    f.ctx.fillText('乙',440,393);assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'甲乙');f.stop();
  }
});

test('the next fully painted glyph can certify a right fringe without a prior highlighted cell',()=>{
  for(const [index,before] of [
    f=>f.ctx.fillText('甲',426,393),
    f=>{cell(f.ctx,426,{color:'#aaffff'});f.ctx.fillText('甲',426,393);},
    f=>{cell(f.ctx,426,{height:27});f.ctx.fillText('甲',426,393);},
    f=>{cell(f.ctx,426,{width:13});f.ctx.fillText('甲',426,393);},
    f=>{firstHighlighted(f);f.ctx.fillText('甲',426,393);},
  ].entries()){
    const f=pendingFixture();before(f);cell(f.ctx,440);
    assert.match(f.snapshot().issue,/局部覆盖/);
    f.ctx.fillText('乙',440,393);assert.equal(f.snapshot().issue,'',`prior variant ${index}`);
    assert.equal(f.snapshot().text,'甲乙');f.stop();
  }
});

test('a tiny witnessed right fringe survives even when the platform paints no following glyph',()=>{
  const f=highlightFixture();f.ctx.fillText('甲',426,393);cell(f.ctx,440);
  const result=f.snapshot();assert.equal(result.issue,'');assert.equal(result.text,'甲');
  assert.ok(!result.diagnostics.details.some(item=>item.kind==='text-cover'));
  const checks=f.calls.length;
  f.ctx.fillRect(435,385,1,1);assert.match(f.snapshot().issue,/局部覆盖/);
  assert.equal(f.calls.length,checks,'the restored source may not reuse its old complete glyph mask');f.stop();
});

test('the direct fringe exception needs a tiny outer edge, a full next cell, and no other painted text',()=>{
  for(const change of [{coveredPixels:3},{pixels:99},{corePixels:29},{maxCoveredAlpha:33},
    {coveredCorePixels:1},{rightEdgeOnly:false},{edgeCoreAdjacent:false},{coveredLeft:439}]){
    const f=highlightFixture({coverage:{...fringe,...change}});f.ctx.fillText('甲',426,393);cell(f.ctx,440);
    assert.match(f.snapshot().issue,/局部覆盖/,JSON.stringify(change));f.stop();
  }
  for(const options of [{width:13},{width:15},{y:383,height:12},{operation:'clearRect'},
    {operation:'fill-path'}]){
    const f=highlightFixture();f.ctx.fillText('甲',426,393);cell(f.ctx,440,options);
    assert.match(f.snapshot().issue,/局部覆盖/,JSON.stringify(options));f.stop();
  }
  const shifted=highlightFixture();shifted.ctx.fillText('甲',426,393);cell(shifted.ctx,439);
  assert.match(shifted.snapshot().issue,/局部覆盖/);shifted.stop();
  const transformed=highlightFixture();transformed.ctx.fillText('甲',426,393);
  transformed.ctx.matrix={a:2,b:0,c:0,d:2,e:0,f:0};
  cell(transformed.ctx,220,{width:7,y:188,height:13});
  assert.match(transformed.snapshot().issue,/局部覆盖/);transformed.stop();
  const alreadyDrawn=highlightFixture();alreadyDrawn.ctx.fillText('甲',426,393);
  alreadyDrawn.ctx.fillText('乙',440,393);cell(alreadyDrawn.ctx,440);
  assert.match(alreadyDrawn.snapshot().issue,/局部覆盖/);alreadyDrawn.stop();
});

test('a direct fringe cannot borrow cached or unknown-context drawing evidence',()=>{
  const cacheCase=highlightFixture(),cache=cacheCase.cache(),cacheCtx=cache.getContext();
  cacheCtx.clearRect(0,0,1000,1000);cacheCtx.fillText('甲',426,393);
  cacheCase.ctx.drawImage(cache,0,0);cell(cacheCase.ctx,440);
  assert.match(cacheCase.snapshot().issue,/局部覆盖/);cacheCase.stop();
  const translucent=highlightFixture();translucent.ctx.globalAlpha=.5;
  translucent.ctx.fillText('甲',426,393);translucent.ctx.globalAlpha=1;cell(translucent.ctx,440);
  assert.match(translucent.snapshot().issue,/局部覆盖/);translucent.stop();
  for(const change of [ctx=>{ctx.shadowColor='#000000';ctx.shadowBlur=1;},
    ctx=>{ctx.filter='blur(1px)';},ctx=>{ctx.globalCompositeOperation='destination-out';},
    ctx=>{ctx.beginPath();ctx.rect(0,0,1000,1000);ctx.clip();}]){
    const f=highlightFixture();f.ctx.fillText('甲',426,393);change(f.ctx);cell(f.ctx,440);
    assert.ok(f.snapshot().issue);f.stop();
  }
});

test('a core-connected right fringe still rejects substantial or unverified ink loss',()=>{
  for(const change of [{rightEdgeOnly:false},{edgeCoreAdjacent:false},{maxCoveredAlpha:128},{coveredCorePixels:1},
    {corePixels:0},{ok:false},{coveredLeft:439}]){
    const f=highlightFixture({coverage:{...fringe,...change}});firstHighlighted(f);cell(f.ctx,440);f.ctx.fillText('乙',440,393);
    assert.match(f.snapshot().issue,/局部覆盖/);f.stop();
  }
});

test('a pending fringe remains blocked for wrong next glyph layout or non-rectangle paint',()=>{
  const changes=[ctx=>ctx.fillText('乙',441,393),ctx=>ctx.fillText('乙',440,394),
    ctx=>{ctx.font='15px Arial';ctx.fillText('乙',440,393);},ctx=>{ctx.fillStyle='#222222';ctx.fillText('乙',440,393);},
    ctx=>{ctx.globalAlpha=.5;ctx.fillText('乙',440,393);},ctx=>ctx.strokeText('乙',440,393),
    ctx=>ctx.fillText('乙丙',440,393),ctx=>ctx.fillText('乙',440,393,7),
    ctx=>{ctx.beginPath();ctx.rect(440,380,7,20);ctx.clip();ctx.fillText('乙',440,393);},
    ctx=>{ctx.shadowColor='#000000';ctx.fillText('乙',440,393);},
    ctx=>{ctx.matrix={a:1,b:0,c:0,d:1,e:1,f:0};ctx.fillText('乙',439,393);}];
  for(const after of changes){const f=pendingFixture();firstHighlighted(f);cell(f.ctx,440);after(f.ctx);
    assert.ok(f.snapshot().issue);f.stop();}
  for(const options of [{operation:'clearRect'},{operation:'fill-path'},{width:15}]){
    const f=pendingFixture();firstHighlighted(f);cell(f.ctx,440,options);f.ctx.fillText('乙',440,393);
    assert.match(f.snapshot().issue,/局部覆盖/);f.stop();
  }
});

test('a pixel write after the cover invalidates the pending neighbor proof while state-only operations may pass',()=>{
  for(const write of [ctx=>ctx.fillText('',600,600),ctx=>ctx.fillRect(600,600,1,1),
    ctx=>ctx.clearRect(600,600,1,1),ctx=>ctx.strokeRect(600,600,1,1)]){
    const f=pendingFixture();cell(f.ctx,426);f.ctx.fillText('甲',426,393);
    cell(f.ctx,440);write(f.ctx);f.ctx.fillText('乙',440,393);
    assert.ok(f.snapshot().issue);f.stop();
  }
  const f=pendingFixture();cell(f.ctx,426);f.ctx.save();f.ctx.restore();f.ctx.fillText('甲',426,393);
  f.ctx.save();f.ctx.restore();cell(f.ctx,440);f.ctx.save();f.ctx.restore();f.ctx.fillText('乙',440,393);
  assert.equal(f.snapshot().text,'甲乙');f.stop();
});

test('only an independently confirmed disjoint thin underline may preserve the old highlight proof',()=>{
  const f=pendingFixture();firstHighlighted(f);f.ctx.strokeStyle='#22aaaa';f.ctx.lineWidth=2;underline(f.ctx);
  cell(f.ctx,440);f.ctx.fillText('乙',440,393);assert.equal(f.snapshot().text,'甲乙');f.stop();
  for(const afterCover of [false,true]){
    const f=pendingFixture();firstHighlighted(f);if(!afterCover)underline(f.ctx,390);cell(f.ctx,440);
    if(afterCover)underline(f.ctx);f.ctx.fillText('乙',440,393);assert.ok(f.snapshot().issue);f.stop();
  }
});

test('restored fringe glyphs and cached copies never reuse a complete original mask or highlight proof',()=>{
  const f=highlightFixture();firstHighlighted(f);cell(f.ctx,440);f.ctx.fillText('乙',440,393);
  assert.equal(f.snapshot().text,'甲乙');const count=f.calls.length;
  f.ctx.fillRect(435,385,1,1);assert.match(f.snapshot().issue,/局部覆盖/);assert.equal(f.calls.length,count);
  f.ctx.fillText('甲',426,393);assert.match(f.snapshot().issue,/局部覆盖/);f.stop();
  const copied=highlightFixture(),cache=copied.cache(),ctx=cache.getContext();ctx.clearRect(0,0,1000,1000);
  cell(ctx,426);ctx.fillText('甲',426,393);copied.ctx.drawImage(cache,0,0);cell(copied.ctx,440);copied.ctx.fillText('乙',440,393);
  assert.match(copied.snapshot().issue,/局部覆盖/);copied.stop();
});
