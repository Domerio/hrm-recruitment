import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../extension/canvas-glyphs.js',import.meta.url),'utf8');
const metrics=(width=10,right=10,ascent=10)=>({width,actualBoundingBoxLeft:0,actualBoundingBoxRight:right,
  actualBoundingBoxAscent:ascent,actualBoundingBoxDescent:0});
const attrs={alpha:true,colorSpace:'srgb',colorType:'unorm8',desynchronized:false,willReadFrequently:false};
const identity={a:1,b:0,c:0,d:1,e:0,f:0};
function descriptor(text,x=20,options={}){
  const m=options.metrics||metrics(10,text==='B'?6:10),transform=options.transform||identity,y=options.y??40;
  const textAlign=options.textAlign||'start',width=m.width*transform.a;
  const advanceLeft=x*transform.a+transform.e-(['right','end'].includes(textAlign)?width:textAlign==='center'?width/2:0);
  return {text,x,y,font:'14px Arial',textAlign,textBaseline:'alphabetic',direction:'ltr',lang:'en',
    metrics:m,transform:{...transform},baseline:y*transform.d+transform.f,advanceLeft,advanceRight:advanceLeft+width,
    contextAttributes:{...attrs},...options};
}
function fixture(options={}){
  const calls={construct:0,measure:0,fill:0,read:0,disposed:0},events=new Map();
  const controls={metrics:(text)=>metrics(10,text==='B'?6:10),
    glyphs:{A:[[0,-10,255],[9,-10,255],[0,-1,255]],B:[[0,-1,255],[5,-1,255],[5,-10,255]]},...options};
  class Context {
    constructor(canvas,settings){
      this.canvas=canvas;this.attrs={...settings};this.transform={...identity};
      Object.assign(this,{font:'10px sans-serif',textAlign:'start',textBaseline:'alphabetic',direction:'inherit',lang:'inherit',
        fontKerning:'auto',fontStretch:'normal',fontVariantCaps:'normal',letterSpacing:'0px',wordSpacing:'0px',textRendering:'auto'});
      this.data=new Uint8ClampedArray(canvas.width*canvas.height*4);
    }
    getContextAttributes(){return {...this.attrs,...controls.contextOverrides};}
    measureText(text){calls.measure++;return controls.metrics(text,this);}
    setTransform(a,b,c,d,e,f){this.transform={a,b,c,d,e,f};}
    fillText(text,x,y){
      calls.fill++;const t=this.transform,m=controls.metrics(text,this);
      const shift=['end','right'].includes(this.textAlign)?m.width:this.textAlign==='center'?m.width/2:0;
      for(const [dx,dy,alpha] of controls.glyphs[text]||[]){
        const px=Math.floor((x-shift+dx)*t.a+t.e),py=Math.floor((y+dy)*t.d+t.f);
        if(px>=0&&py>=0&&px<this.canvas.width&&py<this.canvas.height)this.data[(py*this.canvas.width+px)*4+3]=alpha;
      }
      if(controls.paintBorder)this.data[3]=255;
    }
    getImageData(){calls.read++;if(controls.throwRead)throw Error('private resume failure');return {data:this.data};}
  }
  class Canvas {
    constructor(width,height){calls.construct++;this._width=width;this._height=height;}
    get width(){return this._width;}set width(value){if(value===0)calls.disposed++;this._width=value;}
    get height(){return this._height;}set height(value){this._height=value;}
    getContext(type,settings){assert.equal(type,'2d');return new Context(this,settings);}
  }
  const window={},fonts={status:'loaded',addEventListener:(type,fn)=>events.set(type,fn),removeEventListener:(type)=>events.delete(type)};
  const sandbox={window,document:{fonts},OffscreenCanvas:Canvas,OffscreenCanvasRenderingContext2D:Context};
  if(controls.unavailable)delete sandbox.OffscreenCanvas;
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  return {api:window.__hrmCanvasGlyphs,window,fonts,events,calls,controls,Context,
    reinstall:()=>{vm.runInContext(source,sandbox);return window.__hrmCanvasGlyphs;}};
}

test('separate native alpha masks prove that overlapping ink boxes do not share painted pixels',()=>{
  const f=fixture(),result=f.api.compare(descriptor('A'),descriptor('B',28));
  assert.equal(result.ok,true);assert.equal(result.separate,true);assert.equal(result.edgeOnly,false);
  assert.equal(result.reason,'separate');assert.equal(result.sharedPixels,0);
  assert.equal(result.firstPixels,3);assert.equal(result.secondPixels,3);assert.equal(f.calls.read,2);
  assert.equal(f.calls.construct,f.calls.disposed);f.api.stop();
});

test('two-character runs with a space use exact private replay for a 0.338-pixel advance overlap',()=>{
  const first={width:9.338,actualBoundingBoxLeft:0,actualBoundingBoxRight:10,
    actualBoundingBoxAscent:10,actualBoundingBoxDescent:0};
  const second={width:14,actualBoundingBoxLeft:0,actualBoundingBoxRight:5,
    actualBoundingBoxAscent:10,actualBoundingBoxDescent:0};
  const f=fixture({metrics:text=>text==='ab'?first:second,
    glyphs:{ab:[[0,-10,255],[9,-1,255]],'c ':[[0,-10,255],[4,-1,255]]}});
  const a=descriptor('ab',20,{metrics:first}),b=descriptor('c ',29,{metrics:second});
  assert.equal(f.api.compare(a,b).reason,'invalid-input','single-glyph replay remains narrow');
  const separate=f.api.compareRuns(a,b);
  assert.equal(separate.ok,true);assert.equal(separate.separate,true);assert.equal(separate.sharedPixels,0);
  assert.equal(f.calls.read,2);
  f.controls.glyphs['c '].push([0,-1,255]);f.api.clear();
  const collision=f.api.compareRuns(a,b);
  assert.equal(collision.ok,true);assert.equal(collision.separate,false);
  assert.equal(collision.reason,'pixel-overlap');assert.equal(collision.sharedCorePixels,1);
  assert.equal(f.api.compareRuns({...a,text:'abc'},b).reason,'invalid-input');
  assert.equal(f.api.compareRuns({...a,text:'a\u0301'},b).reason,'invalid-input');
  f.api.stop();
});

test('rectangle coverage distinguishes empty ink-box corners from every touched alpha pixel cell',()=>{
  const f=fixture(),a=descriptor('A');
  const clear=f.api.coverage(a,{left:28,top:31,right:30,bottom:32});
  assert.equal(clear.ok,true);assert.equal(clear.separate,true);assert.equal(clear.reason,'ink-clear');assert.equal(clear.coveredPixels,0);
  const hit=f.api.coverage(a,{left:29.999,top:30.999,right:30.001,bottom:31.001});
  assert.equal(hit.ok,true);assert.equal(hit.separate,false);assert.equal(hit.coveredPixels,1);assert.equal(hit.coveredCorePixels,1);
  f.controls.glyphs.A.push([4,-5,1]);f.api.clear();
  const edge=f.api.coverage(a,{left:24.999,top:35.999,right:25.001,bottom:36.001});
  assert.equal(edge.ok,true);assert.equal(edge.separate,false);assert.equal(edge.coveredPixels,1);assert.equal(edge.coveredCorePixels,0);
  assert.equal(f.calls.read,2,'each mask is shared with the bounded private raster cache');f.api.stop();
});

test('rectangle coverage fails closed for invalid geometry, multi-character runs and unverified rasterizers',()=>{
  for(const rect of [{left:1,top:1,right:1,bottom:2},{left:NaN,top:1,right:2,bottom:2},null]){
    const f=fixture();assert.equal(f.api.coverage(descriptor('A'),rect).ok,false);assert.equal(f.calls.read,0);f.api.stop();
  }
  const rect={left:20,top:30,right:21,bottom:31};
  for(const options of [{unavailable:true},{throwRead:true},{paintBorder:true}]){
    const f=fixture(options);assert.equal(f.api.coverage(descriptor('A'),rect).ok,false);f.api.stop();
  }
  const f=fixture();assert.equal(f.api.coverage(descriptor('AB'),rect).ok,false);assert.equal(f.calls.read,0);
  f.fonts.status='loading';assert.equal(f.api.coverage(descriptor('A'),rect).reason,'font-pending');
  f.api.stop();assert.equal(f.api.coverage(descriptor('A'),rect).reason,'stopped');
});

test('a possible adjacent highlight fringe needs only the rightmost pixel column and untouched direct-left core',()=>{
  const measured={width:14,actualBoundingBoxLeft:1,actualBoundingBoxRight:15,actualBoundingBoxAscent:11,actualBoundingBoxDescent:1};
  const ink=[[0,-10,255],[13,-2,208],[14,-2,25],[13,-1,176],[14,-1,12]];
  const f=fixture({metrics:()=>measured,glyphs:{A:ink}}),raw=descriptor('A',426,{metrics:measured,y:393});
  const rect={left:440,top:376,right:454,bottom:402},edge=f.api.coverage(raw,rect);
  assert.equal(edge.separate,false,'a fringe is still ink coverage until the separate drawing-sequence proof succeeds');
  assert.equal(edge.coveredPixels,2);assert.equal(edge.coveredCorePixels,0);assert.equal(edge.maxCoveredAlpha,25);
  assert.equal(edge.rightEdgeOnly,true);assert.equal(edge.edgeCoreAdjacent,true);assert.equal(edge.corePixels,3);
  assert.deepEqual([edge.coveredLeft,edge.coveredTop,edge.coveredRight,edge.coveredBottom],[440,391,441,393]);
  const partialCell=f.api.coverage(raw,{...rect,left:439.999});
  assert.equal(partialCell.rightEdgeOnly,false);assert.ok(partialCell.coveredCorePixels>0);
  for(const glyph of [
    [[0,-10,255],[14,-2,25],[14,-1,12]],
    [[0,-10,255],[13,-3,255],[14,-2,25]],
    [[13,-2,100],[14,-2,25]],
  ]){
    f.controls.glyphs.A=glyph;f.api.clear();const result=f.api.coverage(raw,rect);
    assert.equal(result.edgeCoreAdjacent,false);
  }
  f.controls.glyphs.A=[[13,-2,208],[14,-2,128]];f.api.clear();
  assert.equal(f.api.coverage(raw,rect).rightEdgeOnly,false);
  f.controls.glyphs.A=[[12,-2,208],[13,-2,25],[14,-1,12]];f.api.clear();
  assert.equal(f.api.coverage(raw,{...rect,left:439}).rightEdgeOnly,false);f.api.stop();
});

test('mixed font, equivalent alignment and translated local coordinates retain physical layout',()=>{
  for(const second of [
    descriptor('B',0,{transform:{...identity,e:28}}),
    descriptor('B',28,{font:'14px sans-serif'}),
    descriptor('B',28,{textAlign:'left'}),
    descriptor('B',28,{letterSpacing:'',wordSpacing:''}),
    descriptor('B',28,{y:0,transform:{...identity,f:40}}),
  ]){
    const f=fixture();assert.equal(f.api.compare(descriptor('A'),second).separate,true);f.api.stop();
  }
});

test('a real shared core pixel is rejected while only alpha edges are identified separately',()=>{
  for(const alpha of [255,128,25,12]){
    const f=fixture();f.controls.glyphs.B.push([1,-10,alpha]);
    const result=f.api.compare(descriptor('A'),descriptor('B',28));
    assert.equal(result.ok,true);assert.equal(result.separate,false);assert.equal(result.sharedPixels,1);
    assert.equal(result.sharedCorePixels,alpha>=128?1:0);assert.equal(result.edgeOnly,alpha<128);
    assert.equal(result.reason,alpha>=128?'pixel-overlap':'edge-only');assert.equal(result.maxSharedMinAlpha,alpha);
    assert.equal(result.firstCorePixels,3);assert.equal(result.secondCorePixels,alpha>=128?4:3);f.api.stop();
  }
});

test('weak glyphs with no opaque core cannot qualify for the edge-only classification',()=>{
  const f=fixture();f.controls.glyphs.B=[[1,-10,25],[0,-1,25],[5,-1,25],[5,-10,25]];
  const result=f.api.compare(descriptor('A'),descriptor('B',28));
  assert.equal(result.ok,true);assert.equal(result.separate,false);assert.equal(result.edgeOnly,false);
  assert.equal(result.reason,'pixel-overlap');assert.equal(result.secondCorePixels,0);f.api.stop();
});

test('invalid baseline, overlapping main cells, reversed ink order and multi-character values fail before raster reads',()=>{
  const pairs=[
    [descriptor('A'),descriptor('B',28,{y:41})],
    [descriptor('A'),descriptor('B',24)],
    [descriptor('A'),descriptor('BB',28)],
    [descriptor('A'),descriptor(' ',28)],
    [descriptor('A'),descriptor('\u0301',28)],
    [descriptor('A',20,{metrics:{...metrics(100,90),actualBoundingBoxLeft:-80}}),descriptor('B',70,{metrics:metrics(100,10)})],
    [descriptor('A'),{...descriptor('B',28),advanceLeft:29}],
  ];
  for(const pair of pairs){const f=fixture(),result=f.api.compare(...pair);assert.equal(result.ok,false);assert.equal(f.calls.read,0);assert.equal(f.calls.fill,0);f.api.stop();}
});

test('cached masks are reused only after all five original text measurements are checked again',()=>{
  const f=fixture(),a=descriptor('A'),b=descriptor('B',28);
  assert.equal(f.api.compare(a,b).separate,true);assert.equal(f.calls.read,2);
  assert.equal(f.api.compare(a,b).separate,true);assert.equal(f.calls.read,2);assert.equal(f.calls.measure,4);
  f.controls.metrics=text=>({...metrics(10,text==='B'?6:10),actualBoundingBoxAscent:10.001});
  assert.equal(f.api.compare(a,b).reason,'metrics-mismatch');assert.equal(f.calls.read,2);f.api.stop();
});

test('clearing or a font-set completion event releases cached masks before the next comparison',()=>{
  const f=fixture(),a=descriptor('A'),b=descriptor('B',28);
  f.api.compare(a,b);f.api.clear();f.api.compare(a,b);assert.equal(f.calls.read,4);
  f.events.get('loadingdone')();f.api.compare(a,b);assert.equal(f.calls.read,6);f.api.stop();
});

test('pending fonts and unsupported original context attributes cannot be treated as matching rasterizers',()=>{
  for(const attributes of [{...attrs,alpha:false},{...attrs,colorSpace:'unknown'},{...attrs,colorType:'float16'},null]){
    const f=fixture();
    const result=f.api.compare(descriptor('A',20,{contextAttributes:attributes}),descriptor('B',28));
    assert.equal(result.reason,'unsupported-context');assert.equal(f.calls.read,0);f.api.stop();
  }
  const f=fixture();f.fonts.status='loading';assert.equal(f.api.compare(descriptor('A'),descriptor('B',28)).reason,'font-pending');
  assert.equal(f.calls.read,0);f.api.stop();
});

test('native context attribute mismatch, empty masks, clipped masks and read errors fail closed with fixed reasons',()=>{
  for(const [controls,reason] of [
    [{contextOverrides:{alpha:false}},'unsupported-context'],[{glyphs:{}},'empty-mask'],
    [{paintBorder:true},'mask-clipped'],[{throwRead:true},'readback-failed'],[{unavailable:true},'unavailable'],
  ]){
    const f=fixture(controls),result=f.api.compare(descriptor('A'),descriptor('B',28));
    assert.equal(result.ok,false);assert.equal(result.reason,reason);assert.doesNotMatch(JSON.stringify(result),/private/);f.api.stop();
  }
});

test('a tile larger than 256 by 256 is rejected before allocating a scratch bitmap',()=>{
  const f=fixture();const a=descriptor('A',20,{metrics:metrics(253,253,10)}),b=descriptor('B',273);
  assert.equal(f.api.compare(a,b).reason,'tile-limit');assert.equal(f.calls.construct,0);f.api.stop();
});

test('the two-million-pixel mask budget is bounded and reset by clear',()=>{
  const big=metrics(252,252,252),f=fixture({metrics:()=>big,glyphs:{A:[[0,-252,255],[251,-1,255]],B:[[0,-252,255],[251,-1,255]]}});
  const pair=index=>[descriptor('A',20,{font:`14px Font${index}`,y:300,metrics:big}),descriptor('B',146,{font:`14px Font${index}`,y:300,metrics:big})];
  for(let index=0;index<16;index++)assert.equal(f.api.compare(...pair(index)).ok,true,index);
  assert.equal(f.calls.read,32);assert.equal(f.api.compare(...pair(16)).reason,'cache-limit');assert.equal(f.calls.read,32);
  f.api.clear();assert.equal(f.api.compare(...pair(16)).ok,true);f.api.stop();
});

test('native methods are captured before later prototype changes and stop permits a clean reinstallation',()=>{
  const f=fixture(),originalFill=f.Context.prototype.fillText;
  f.Context.prototype.fillText=()=>{throw Error('later page hook');};
  assert.equal(f.api.compare(descriptor('A'),descriptor('B',28)).separate,true);
  assert.equal(f.reinstall(),f.api);const old=f.api;old.stop();
  assert.equal(old.compare(descriptor('A'),descriptor('B',28)).reason,'stopped');assert.equal(f.window.__hrmCanvasGlyphs,undefined);
  assert.equal(f.events.size,0);f.Context.prototype.fillText=originalFill;
  const next=f.reinstall();assert.notEqual(next,old);assert.equal(next.compare(descriptor('A'),descriptor('B',28)).separate,true);next.stop();
});

test('results contain only fixed status fields and numeric coverage, never the original glyph or font',()=>{
  const f=fixture();f.controls.metrics=()=>metrics();f.controls.glyphs['隐']=f.controls.glyphs.A;f.controls.glyphs['私']=f.controls.glyphs.B;
  const result=f.api.compare(descriptor('隐',20,{font:'14px secret-private-font'}),descriptor('私',28,{font:'14px secret-private-font'}));
  assert.equal(result.ok,true);assert.doesNotMatch(JSON.stringify(result),/隐|私|secret|private|font|text/);
  for(const [key,value] of Object.entries(result))if(!['ok','separate','edgeOnly','reason'].includes(key))assert.ok(Number.isSafeInteger(value)&&value>=0);
  f.api.stop();
});
