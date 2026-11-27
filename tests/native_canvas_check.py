"""Offline native Canvas probe using an existing headless-shell CLI binary.

No Playwright launch, CDP, browser account, network page, extension installation,
or dependency download is used. Each invocation gets its own empty profile.
Reports are diagnostic by default. Pass --check to fail when a positive or
negative regression case does not produce its expected result.
"""

import argparse
import html
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


DEFAULT_BINARY = Path(os.environ.get("LOCALAPPDATA", "")) / (
    "ms-playwright/chromium_headless_shell-1228/"
    "chrome-headless-shell-win64/chrome-headless-shell.exe"
)

PROBE_JS = r"""
const text='A中文C# Winform';
document.documentElement.lang='en';
const canvas=document.getElementById('resume');
const ctx=canvas.getContext('2d');
window.__hrmCanvasTextEnabled=true;
new Function(GEOMETRY_SOURCE)();
if(GLYPHS_SOURCE)new Function(GLYPHS_SOURCE)();
new Function('location',EXPAND_SOURCE)({protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'});
new Function('location',OBSERVER_SOURCE)({protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'});
// Keep legacy decoration regressions in strict mode; the badge probe exercises product text-only defaults.
const strictSnapshot=window.__hrmCanvasText.snapshot.bind(window.__hrmCanvasText);
window.__hrmCanvasText.snapshot=(options={})=>strictSnapshot({textOnly:false,...options});
const cases=[],pixelReferences=new Map();
const styles=['font','textAlign','textBaseline','direction','lang','fontKerning','fontStretch',
  'fontVariantCaps','letterSpacing','wordSpacing','textRendering'];
function remember(value,x,y){
  const m=ctx.measureText(value),matrix=ctx.getTransform();
  const state=Object.fromEntries(styles.map(key=>[key,ctx[key]]));
  const metrics={width:m.width,left:m.actualBoundingBoxLeft,right:m.actualBoundingBoxRight,
    ascent:m.actualBoundingBoxAscent,descent:m.actualBoundingBoxDescent};
  const transform=[matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f];
  const bounds={left:(x-metrics.left)*matrix.a+matrix.e,right:(x+metrics.right)*matrix.a+matrix.e,
    top:(y-metrics.ascent)*matrix.d+matrix.f,bottom:(y+metrics.descent)*matrix.d+matrix.f};
  return {value,x,y,state,metrics,transform,bounds,contextAttributes:ctx.getContextAttributes()};
}
function helperDescriptor(draw){
  const [a,b,c,d,e,f]=draw.transform,m=draw.metrics;
  return {...draw.state,text:draw.value,x:draw.x,y:draw.y,lang:draw.state.lang&&draw.state.lang!=='inherit'?draw.state.lang:'en',
    transform:{a,b,c,d,e,f},metrics:{width:m.width,actualBoundingBoxLeft:m.left,actualBoundingBoxRight:m.right,
      actualBoundingBoxAscent:m.ascent,actualBoundingBoxDescent:m.descent},
    baseline:draw.y*d+f,advanceLeft:draw.x*a+e,advanceRight:(draw.x+m.width)*a+e,
    contextAttributes:draw.contextAttributes,globalAlpha:1};
}
function pairMask(first,second){
  const left=Math.floor(Math.min(first.bounds.left,second.bounds.left))-3;
  const top=Math.floor(Math.min(first.bounds.top,second.bounds.top))-3;
  const width=Math.max(1,Math.ceil(Math.max(first.bounds.right,second.bounds.right))-left+3);
  const height=Math.max(1,Math.ceil(Math.max(first.bounds.bottom,second.bounds.bottom))-top+3);
  const paint=draw=>{
    const surface=new OffscreenCanvas(width,height),p=surface.getContext('2d');
    for(const key of styles)if(draw.state[key]!==undefined)p[key]=draw.state[key];
    p.fillStyle='#000000';
    const [a,b,c,d,e,f]=draw.transform;p.setTransform(a,b,c,d,e-left,f-top);
    p.fillText(draw.value,draw.x,draw.y);
    return p.getImageData(0,0,width,height).data;
  };
  const a=paint(first),b=paint(second);
  let firstPixels=0,secondPixels=0,firstCorePixels=0,secondCorePixels=0,intersectingPixels=0,strongIntersectionPixels=0,maxSharedAlpha=0;
  for(let i=3;i<a.length;i+=4){
    if(a[i])firstPixels++;if(b[i])secondPixels++;
    if(a[i]>=128)firstCorePixels++;if(b[i]>=128)secondCorePixels++;
    if(a[i]&&b[i]){intersectingPixels++;maxSharedAlpha=Math.max(maxSharedAlpha,Math.min(a[i],b[i]));}
    if(a[i]>=128&&b[i]>=128)strongIntersectionPixels++;
  }
  return {pair:first.value+second.value,firstPixels,secondPixels,firstCorePixels,secondCorePixels,
    intersectingPixels,strongIntersectionPixels,maxSharedAlpha,
    helper:window.__hrmCanvasGlyphs?.compare(helperDescriptor(first),helperDescriptor(second))||null,
    boxOverlapX:Math.max(0,Math.min(first.bounds.right,second.bounds.right)-Math.max(first.bounds.left,second.bounds.left)),
    boxOverlapY:Math.max(0,Math.min(first.bounds.bottom,second.bounds.bottom)-Math.max(first.bounds.top,second.bounds.top))};
}
function checksum(pixels){let hash=2166136261;for(const byte of pixels)hash=Math.imul(hash^byte,16777619);return (hash>>>0).toString(16);}
function runCase(name,{content=text,font='14px Arial',rounding=Math.floor,translated=false,alternateAlignment=false,mixedFont=false,
  whole=false,scaled=false,baselineStep=0,redraw=null,expectIssue=false}={}){
  ctx.reset();ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#000000';
  ctx.textBaseline='alphabetic';ctx.textAlign='left';ctx.direction='ltr';ctx.lang='en';ctx.font=font;
  const draws=[];let x=30;
  if(scaled)ctx.setTransform(2,0,0,2,.25,.5);
  if(whole){
    draws.push(remember(content,x,80));ctx.fillText(content,x,80);
    if(redraw){const rx=x+redraw.dx,ry=80+(redraw.dy||0);draws.push(remember(redraw.text,rx,ry));ctx.fillText(redraw.text,rx,ry);}
  }
  else for(const [index,value] of [...content].entries()){
    const y=80+baselineStep*index;
    ctx.font=mixedFont&&index%2?'14px sans-serif':font;
    ctx.textAlign=alternateAlignment&&index%2?'start':'left';
    const advance=ctx.measureText(value).width;
    ctx.save();
    if(translated){ctx.translate(x,y);draws.push(remember(value,0,0));ctx.fillText(value,0,0);}
    else {draws.push(remember(value,x,y));ctx.fillText(value,x,y);}
    ctx.restore();x+=rounding(advance);
  }
  const snapshot=window.__hrmCanvasText.snapshot();
  const masks=draws.slice(1).map((draw,index)=>pairMask(draws[index],draw));
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  if(['individual-round','pair-C#'].includes(name))pixelReferences.set(name,pixels);
  const referenceName=name.startsWith('individual-round-')?'individual-round':name.startsWith('pair-C#-')?'pair-C#':null;
  const reference=referenceName&&pixelReferences.get(referenceName);
  const expectedBytes=new TextEncoder().encode(content),actualBytes=new TextEncoder().encode(snapshot.text);
  const utf8Exact=expectedBytes.length===actualBytes.length&&expectedBytes.every((byte,index)=>byte===actualBytes[index]);
  cases.push({name,expectedText:content,actualText:snapshot.text,exactText:snapshot.text===content,utf8Exact,
    expectedUtf8Bytes:expectedBytes.length,actualUtf8Bytes:actualBytes.length,expectIssue,
    passed:expectIssue?Boolean(snapshot.issue):!snapshot.issue&&utf8Exact,
    pixelReference:referenceName,pixelExactlyEqual:reference?pixels.every((value,index)=>value===reference[index]):null,
    issue:snapshot.issue,issueCode:snapshot.issueCode||'',diagnostics:snapshot.diagnostics,
    pixelChecksum:checksum(pixels),draws,masks});
}
await document.fonts.ready;
runCase('whole-run',{whole:true});
runCase('individual-floor');
runCase('individual-round',{rounding:Math.round});
runCase('individual-round-translated',{rounding:Math.round,translated:true});
runCase('individual-round-left-start',{rounding:Math.round,alternateAlignment:true});
runCase('individual-round-mixed-equivalent-font',{rounding:Math.round,mixedFont:true});
runCase('individual-floor-translated',{translated:true});
runCase('individual-floor-left-start',{alternateAlignment:true});
runCase('individual-floor-mixed-equivalent-font',{mixedFont:true});
runCase('individual-floor-high-dpi',{scaled:true});
runCase('individual-floor-yahei',{font:'14px "Microsoft YaHei"'});
for(const content of ['A中','C中','C#','Wi','nf','rm'])runCase('pair-'+content,{content});
runCase('pair-C#-translated',{content:'C#',translated:true});
runCase('pair-C#-left-start',{content:'C#',alternateAlignment:true});
runCase('pair-C#-mixed-equivalent-font',{content:'C#',mixedFont:true});
runCase('repeated-synthetic-text',{content:(text+' | ').repeat(8),rounding:Math.round});
runCase('negative-core-overlap',{content:'WW',rounding:()=>3,expectIssue:true});
runCase('negative-baseline-overlap',{content:'CC',rounding:()=>5,baselineStep:2,expectIssue:true});
runCase('same-multi-character-redraw',{content:'Winform',whole:true,redraw:{text:'Winform',dx:0}});
runCase('negative-overlapping-multi-character-redraw',{content:'Winform',whole:true,redraw:{text:'Changed',dx:15},expectIssue:true});
// Short rendered runs are replayed only when their exact metrics and native
// pixel masks agree. The measured 0.338px advance overlap and a one-pixel
// ink-box intersection alone are never permission to copy the text.
const shortRunCases=[];
{
  const firstValues=['i ','l ','Pr','sm','1.','5.','A.','。 ','r ','n ','C#','IV'];
  const secondValues=['。 ','i ','l ','c ','1.','5.','· ','r ','m ','a ','C#'];
  let chosen=null;
  for(const font of ['14px Arial','14px "Microsoft YaHei"']){
    ctx.reset();ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#000000';ctx.textBaseline='alphabetic';ctx.textAlign='left';ctx.direction='ltr';ctx.lang='en';ctx.font=font;
    for(const firstValue of firstValues)for(const secondValue of secondValues){
      const first=remember(firstValue,30,80),second=remember(secondValue,30+first.metrics.width-.338,80);
      const boxOverlap=Math.min(first.bounds.right,second.bounds.right)-Math.max(first.bounds.left,second.bounds.left);
      if(!(boxOverlap>0&&boxOverlap<=2&&first.bounds.left<second.bounds.left&&first.bounds.right<second.bounds.right))continue;
      const mask=pairMask(first,second);
      if(mask.intersectingPixels||!mask.firstCorePixels||!mask.secondCorePixels)continue;
      const replay=window.__hrmCanvasGlyphs?.compareRuns(helperDescriptor(first),helperDescriptor(second));
      if(!replay?.ok||!replay.separate)continue;
      chosen={font,first,second,mask,replay};break;
    }
    if(chosen)break;
  }
  if(chosen){
    ctx.reset();ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#000000';ctx.textBaseline='alphabetic';ctx.textAlign='left';ctx.direction='ltr';ctx.lang='en';ctx.font=chosen.font;
    ctx.fillText(chosen.first.value,chosen.first.x,chosen.first.y);
    ctx.fillText(chosen.second.value,chosen.second.x,chosen.second.y);
    const snapshot=window.__hrmCanvasText.snapshot();
    shortRunCases.push({name:'short-run-separated-native-pixels',font:chosen.font,
      values:[chosen.first.value,chosen.second.value],advanceOverlap:.338,
      boxOverlapX:chosen.mask.boxOverlapX,sharedPixels:chosen.mask.intersectingPixels,
      replayReason:chosen.replay.reason,issue:snapshot.issue,
      passed:!snapshot.issue&&snapshot.diagnostics?.entries===2&&
        snapshot.text.replace(/\s/g,'')===(chosen.first.value+chosen.second.value).replace(/\s/g,'')});
  }else shortRunCases.push({name:'short-run-separated-native-pixels',passed:false,reason:'no-native-pair'});
  ctx.reset();ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#000000';ctx.textBaseline='alphabetic';ctx.textAlign='left';ctx.direction='ltr';ctx.lang='en';ctx.font='14px Arial';
  const collidingFirst=remember('WW',30,130);
  const collidingSecond=remember('WW',30+collidingFirst.metrics.width*.65,130);
  const collidingMask=pairMask(collidingFirst,collidingSecond);
  const collidingReplay=window.__hrmCanvasGlyphs?.compareRuns(helperDescriptor(collidingFirst),helperDescriptor(collidingSecond));
  ctx.fillText(collidingFirst.value,collidingFirst.x,collidingFirst.y);
  ctx.fillText(collidingSecond.value,collidingSecond.x,collidingSecond.y);
  const collidingSnapshot=window.__hrmCanvasText.snapshot();
  shortRunCases.push({name:'short-run-colliding-native-pixels',
    sharedPixels:collidingMask.intersectingPixels,sharedCorePixels:collidingMask.strongIntersectionPixels,
    replayReason:collidingReplay?.reason,issue:collidingSnapshot.issue,
    passed:collidingMask.intersectingPixels>0&&collidingReplay?.ok===true&&
      collidingReplay.separate===false&&/文字重叠/.test(collidingSnapshot.issue)});
}

// Real native metrics establish that one glyph crosses the bitmap edge while
// a differently shaped glyph on the same baseline is still wholly visible.
// Both must be omitted until an observed repaint recovers the entire row.
const boundaryCases=[];
const bodyText='完整原文 C++';
function boundarySetup(scale=1){
  ctx.reset();ctx.clearRect(0,0,canvas.width,canvas.height);ctx.scale(scale,scale);
  ctx.font='20px Arial';ctx.textBaseline='alphabetic';ctx.textAlign='left';ctx.direction='ltr';ctx.fillStyle='#000000';
  ctx.fillText(bodyText,40,60);
}
function runBoundaryCase(edge,scale=1){
  boundarySetup(scale);
  const prefix=edge==='top'?'x':'A',partial=edge==='top'?'A':'g';
  const fullMetrics=ctx.measureText(prefix),partialMetrics=ctx.measureText(partial);
  const baseline=edge==='top'?partialMetrics.actualBoundingBoxAscent-.5:
    canvas.height/scale-partialMetrics.actualBoundingBoxDescent/2;
  const glyphBounds=m=>({top:(baseline-m.actualBoundingBoxAscent)*scale,bottom:(baseline+m.actualBoundingBoxDescent)*scale});
  const full=glyphBounds(fullMetrics),cut=glyphBounds(partialMetrics);
  const precondition=full.top>=0&&full.bottom<=canvas.height&&
    (edge==='top'?cut.top<0&&cut.bottom>0:cut.top<canvas.height&&cut.bottom>canvas.height);
  ctx.fillText(prefix,40,baseline);ctx.fillText(partial,90,baseline);
  const strict=window.__hrmCanvasText.snapshot();
  const deferred=window.__hrmCanvasText.snapshot({allowVerticalBoundary:true});
  const correctDefer=!deferred.issue&&deferred.text===bodyText&&deferred.boundaryRows?.[edge]===true;
  // Erase the complete visible edge strip, not the off-canvas coordinates.
  // The boundary marker must disappear together with its actual painted ink.
  const strip=30,localHeight=canvas.height/scale;
  ctx.clearRect(0,edge==='top'?0:localHeight-strip,canvas.width/scale,strip);
  ctx.fillText(prefix,40,120);ctx.fillText(partial,90,120);
  const recovered=window.__hrmCanvasText.snapshot({allowVerticalBoundary:true});
  const expected=bodyText+'\n'+prefix+' '+partial;
  boundaryCases.push({name:edge+'-edge-scale-'+scale,precondition,full,cut,
    strictIssue:strict.issue,deferredIssue:deferred.issue,deferredText:deferred.text,
    deferredRows:deferred.boundaryRows,recoveredIssue:recovered.issue,recoveredText:recovered.text,
    recoveredRows:recovered.boundaryRows,
    passed:precondition&&/边界截断/.test(strict.issue)&&strict.text===''&&correctDefer&&
      !recovered.issue&&recovered.text===expected&&!recovered.boundaryRows?.top&&!recovered.boundaryRows?.bottom});
}
for(const scale of [1,2])for(const edge of ['top','bottom'])runBoundaryCase(edge,scale);
for(const side of ['left','right']){
  boundarySetup();
  const metrics=ctx.measureText('CUT');
  const x=side==='left'?metrics.actualBoundingBoxLeft-1:canvas.width-metrics.actualBoundingBoxRight+1;
  ctx.fillText('CUT',x,120);
  const result=window.__hrmCanvasText.snapshot({allowVerticalBoundary:true});
  boundaryCases.push({name:side+'-edge-rejected',issue:result.issue,text:result.text,
    passed:/边界截断/.test(result.issue)&&result.text===''});
}
boundarySetup();ctx.save();ctx.beginPath();ctx.rect(0,0,canvas.width,160);ctx.clip();
const clippedMetrics=ctx.measureText('g');ctx.fillText('g',40,160-clippedMetrics.actualBoundingBoxDescent/2);ctx.restore();
const innerClip=window.__hrmCanvasText.snapshot({allowVerticalBoundary:true});
boundaryCases.push({name:'inner-clip-rejected',issue:innerClip.issue,text:innerClip.text,
  passed:/裁剪区域截断/.test(innerClip.issue)&&innerClip.text===''});
// drawImage copies must inherit the source's observed strings at the instant
// of the native bitmap copy. These off-DOM caches are not the display canvas.
const copyCases=[];
function cacheCanvas(width=300,height=200,{opaque=false}={}){
  const source=document.createElement('canvas');source.width=width;source.height=height;
  const paint=source.getContext('2d');paint.font='20px Arial';paint.textBaseline='alphabetic';
  paint.textAlign='left';paint.direction='ltr';
  if(opaque){paint.fillStyle='#ffffff';paint.fillRect(0,0,width,height);}
  paint.fillStyle='#000000';
  return {source,paint};
}
function copySetup(width=1600,height=956){
  canvas.width=width;canvas.height=height;ctx.reset();ctx.clearRect(0,0,width,height);
  ctx.font='20px Arial';ctx.textBaseline='alphabetic';ctx.textAlign='left';ctx.direction='ltr';ctx.fillStyle='#000000';
}
function recordCopy(name,expectedText,{reject=false,extra={},condition=true}={}){
  const snapshot=window.__hrmCanvasText.snapshot({allowVerticalBoundary:true});
  const expectedBytes=new TextEncoder().encode(expectedText),actualBytes=new TextEncoder().encode(snapshot.text);
  const utf8Exact=expectedBytes.length===actualBytes.length&&expectedBytes.every((byte,index)=>byte===actualBytes[index]);
  copyCases.push({name,expectedText,actualText:snapshot.text,issue:snapshot.issue,issueCode:snapshot.issueCode||'',
    utf8Exact,entries:snapshot.diagnostics?.entries,operations:snapshot.diagnostics?.operations,
    ...extra,passed:condition&&(reject?Boolean(snapshot.issue)&&snapshot.text==='':!snapshot.issue&&utf8Exact)});
  return snapshot;
}
const cachedText='缓存原字 C++';
{
  const {source,paint}=cacheCanvas();paint.fillText(cachedText,30,60);
  copySetup();ctx.drawImage(source,40,30);
  recordCopy('cache-three-argument-copy',cachedText);
}
{
  const {source,paint}=cacheCanvas();paint.fillText(cachedText,30,60);
  copySetup();ctx.drawImage(source,40,30,600,400);
  const positioned=window.__hrmCanvasText.snapshot({rect:{x:80,y:110,width:300,height:70}});
  recordCopy('cache-five-argument-scale',cachedText,
    {condition:!positioned.issue&&positioned.text===cachedText,extra:{positionedText:positioned.text,positionedIssue:positioned.issue}});
}
{
  const {source,paint}=cacheCanvas();paint.fillText(cachedText,40,60);
  copySetup();ctx.drawImage(source,20,20,240,100,100,80,480,200);
  const positioned=window.__hrmCanvasText.snapshot({rect:{x:120,y:115,width:300,height:70}});
  recordCopy('cache-nine-argument-complete-crop',cachedText,
    {condition:!positioned.issue&&positioned.text===cachedText,extra:{positionedText:positioned.text,positionedIssue:positioned.issue}});
}
{
  const first=cacheCanvas(773,956,{opaque:true}),second=cacheCanvas(773,956,{opaque:true});
  first.paint.fillText('屏外旧行',30,40);
  first.paint.fillText('缓存第一块可见原文',30,560);first.paint.fillText('缓存第一块末行',30,920);
  second.paint.fillText('缓存第二块首行',30,60);second.paint.fillText('缓存第二块可见原文',30,450);
  copySetup(773,956);ctx.drawImage(first.source,0,-526);ctx.drawImage(second.source,0,430);
  const upper=window.__hrmCanvasText.snapshot({rect:{x:0,y:0,width:773,height:430}});
  const lower=window.__hrmCanvasText.snapshot({rect:{x:0,y:430,width:773,height:526}});
  recordCopy('reported-773x956-cache-tiles-at-minus526-and430',
    '缓存第一块可见原文\n缓存第一块末行\n缓存第二块首行\n缓存第二块可见原文',
    {condition:!upper.issue&&!lower.issue&&upper.text==='缓存第一块可见原文\n缓存第一块末行'&&lower.text==='缓存第二块首行\n缓存第二块可见原文',
      extra:{upperText:upper.text,upperIssue:upper.issue,lowerText:lower.text,lowerIssue:lower.issue}});
}
{
  const first=cacheCanvas(),second=cacheCanvas(700,500,{opaque:true});
  first.paint.fillText(cachedText,30,60);second.paint.drawImage(first.source,30,40,600,400);
  copySetup();ctx.drawImage(second.source,50,30);
  recordCopy('cache-multistage-copy',cachedText);
}
{
  const {source,paint}=cacheCanvas();paint.fillText(cachedText,30,60);
  copySetup();ctx.drawImage(source,40,30);
  const before=checksum(ctx.getImageData(0,0,canvas.width,canvas.height).data);
  paint.clearRect(0,0,source.width,source.height);paint.fillText('后来变更的源图',30,60);
  source.width=source.width;
  const unchanged=before===checksum(ctx.getImageData(0,0,canvas.width,canvas.height).data);
  recordCopy('cache-source-repaint-and-reset-do-not-change-destination',cachedText,
    {condition:unchanged,extra:{destinationPixelsUnchanged:unchanged}});
}
{
  copySetup();ctx.fillText(cachedText,30,60);
  ctx.drawImage(canvas,0,0,300,200,400,200,300,200);
  recordCopy('cache-self-copy-captures-source-before-destination-mutation',cachedText+'\n'+cachedText);
}
{
  const {source,paint}=cacheCanvas();paint.fillText('WWW',20,60);
  copySetup();ctx.drawImage(source,40,0,260,200,20,20,260,200);
  recordCopy('cache-source-crop-through-text-rejected','',{reject:true});
}
{
  const {source,paint}=cacheCanvas();paint.fillText('WWW',30,60);
  copySetup();ctx.fillText('ABC',35,60);ctx.drawImage(source,0,0);
  recordCopy('cache-transparent-source-overlaps-existing-text-rejected','',{reject:true});
}
{
  const {source,paint}=cacheCanvas();
  const pixels=new ImageData(10,10);pixels.data.fill(255);paint.putImageData(pixels,20,20);
  copySetup();ctx.drawImage(source,0,0);
  const rejected=recordCopy('cache-unreadable-pixel-content-stays-rejected','',{reject:true});
  copyCases.at(-1).passed&&=rejected.issueCode==='unsupported'&&/像素图片/.test(rejected.issue);
}
for(const complete of [true,false]){
  const first=cacheCanvas(),second=cacheCanvas();
  const metrics=first.paint.measureText('g'),baseline=first.source.height-metrics.actualBoundingBoxDescent+1;
  first.paint.fillText('g',30,baseline);
  second.paint.fillText('g',30,baseline-first.source.height);
  const sourceCutBottom=baseline+metrics.actualBoundingBoxDescent;
  const precondition=metrics.actualBoundingBoxDescent>1&&sourceCutBottom===first.source.height+1;
  copySetup(773,956);ctx.drawImage(first.source,20,100);
  if(complete){
    ctx.drawImage(second.source,20,100+first.source.height);
    const reference=cacheCanvas(canvas.width,canvas.height);reference.paint.fillText('g',50,baseline+100);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const expectedPixels=reference.paint.getImageData(0,0,canvas.width,canvas.height).data;
    const pixelsExact=pixels.every((value,index)=>value===expectedPixels[index]);
    recordCopy('cache-seam-combines-only-two-complete-complementary-glyph-parts','g',
      {condition:precondition&&pixelsExact,extra:{precondition,pixelsExact,sourceCutBottom}});
  }else{
    recordCopy('cache-seam-missing-descender-part-inside-destination-rejected','',
      {reject:true,condition:precondition,extra:{precondition,sourceCutBottom}});
  }
}
{
  const {source,paint}=cacheCanvas(600,200);paint.fillText('负责视觉研发...',30,60);
  let x=250;
  for(const char of '查看全部'){paint.fillText(char,x,60);x+=paint.measureText(char).width;}
  paint.fillText('工作经历',30,110);
  const sourceMark=window.__hrmExpandMarks.read(source).find(mark=>mark.label==='查看全部');
  copySetup();ctx.drawImage(source,40,30,900,300);
  const snapshot=window.__hrmCanvasText.snapshot(),marks=snapshot.marks;
  const expectedX=sourceMark?(40+sourceMark.x*source.width*1.5)/canvas.width:null;
  const expectedY=sourceMark?(30+sourceMark.y*source.height*1.5)/canvas.height:null;
  copyCases.push({name:'cache-expander-original-glyphs-and-position-survive-scaled-copy',
    actualText:snapshot.text,issue:snapshot.issue,marks,expectedX,expectedY,
    passed:!snapshot.issue&&snapshot.text==='负责视觉研发... 查看全部\n工作经历'&&Boolean(sourceMark)&&
      marks.length===1&&marks[0].label==='查看全部'&&Math.abs(marks[0].x-expectedX)<1e-9&&Math.abs(marks[0].y-expectedY)<1e-9});
}
// Adjacent glyph boxes at the bitmap edge must use the same advance and
// verified coverage rules as interior text. A box overhang alone is not a
// reason to poison a row which is being deferred in its entirety.
const boundaryOverlapCases=[];
const edgeRun='C# Winform 中文';
function drawFloor(paint,content,x,baseline,{step=null,baselineStep=0}={}){
  const boxes=[];
  for(const [index,char] of [...content].entries()){
    const metrics=paint.measureText(char),y=baseline+index*baselineStep;
    const box={char,x,y,width:metrics.width,left:x-metrics.actualBoundingBoxLeft,
      right:x+metrics.actualBoundingBoxRight,top:y-metrics.actualBoundingBoxAscent,bottom:y+metrics.actualBoundingBoxDescent};
    boxes.push(box);paint.fillText(char,x,y);x+=step===null?Math.floor(metrics.width):step;
  }
  return boxes;
}
function edgeFont(paint){paint.font='14px Arial';paint.textBaseline='alphabetic';paint.textAlign='left';paint.direction='ltr';paint.lang='en';paint.fillStyle='#000000';}
for(const content of [edgeRun,'C#']){
  copySetup(773,956);edgeFont(ctx);ctx.fillText(bodyText,40,60);
  const boxes=drawFloor(ctx,content,133,963);
  const boxOverlaps=boxes.slice(1).filter((box,index)=>boxes[index].right>box.left&&
    boxes[index].top<box.bottom&&boxes[index].bottom>box.top).length;
  const cutGlyphs=boxes.filter(box=>box.top<canvas.height&&box.bottom>canvas.height).length;
  const snapshot=window.__hrmCanvasText.snapshot({allowVerticalBoundary:true});
  const overlapIssues=(snapshot.diagnostics?.reasonCounts||[]).filter(item=>/文字重叠/.test(item.reason));
  boundaryOverlapCases.push({name:'boundary-floor-adjacent-'+(content==='C#'?'pair':'mixed-run'),
    boxes,boxOverlaps,cutGlyphs,issue:snapshot.issue,text:snapshot.text,boundaryRows:snapshot.boundaryRows,overlapIssues,
    passed:boxOverlaps>0&&cutGlyphs>0&&!snapshot.issue&&snapshot.text===bodyText&&snapshot.boundaryRows?.bottom===true&&!overlapIssues.length});
}
{
  const first=cacheCanvas(773,956),second=cacheCanvas(773,956);edgeFont(first.paint);edgeFont(second.paint);
  const upperBoxes=drawFloor(first.paint,edgeRun,133,963),lowerBoxes=drawFloor(second.paint,edgeRun,133,7);
  copySetup(773,956);ctx.drawImage(first.source,0,-526);ctx.drawImage(second.source,0,430);
  const snapshot=window.__hrmCanvasText.snapshot({allowVerticalBoundary:true});
  const reference=cacheCanvas(773,956);edgeFont(reference.paint);drawFloor(reference.paint,edgeRun,133,437);
  const pixels=ctx.getImageData(0,0,773,956).data,referencePixels=reference.paint.getImageData(0,0,773,956).data;
  const pixelsExact=pixels.every((value,index)=>value===referencePixels[index]);
  boundaryOverlapCases.push({name:'boundary-adjacent-floor-cache-seam-recovers-exact-original-run',
    issue:snapshot.issue,text:snapshot.text,boundaryRows:snapshot.boundaryRows,pixelsExact,upperBoxes,lowerBoxes,
    passed:pixelsExact&&!snapshot.issue&&snapshot.text===edgeRun&&!snapshot.boundaryRows?.top&&!snapshot.boundaryRows?.bottom});
}
for(const mode of ['core-overlap','baseline-overlap','partial-erase']){
  copySetup(773,956);edgeFont(ctx);ctx.fillText(bodyText,40,60);
  let boxes=[],coverage=null,erasedPixel=null;
  if(mode==='core-overlap')boxes=drawFloor(ctx,'WW',133,963,{step:3});
  else if(mode==='baseline-overlap')boxes=drawFloor(ctx,'CC',133,963,{step:5,baselineStep:-1});
  else{
    const first=cacheCanvas(773,956),second=cacheCanvas(773,956);edgeFont(first.paint);edgeFont(second.paint);
    boxes=drawFloor(first.paint,edgeRun,133,963);drawFloor(second.paint,edgeRun,133,7);
    // Erase only some of the actually visible top half, not the whole source
    // fragment. The complementary tile must not recover the erased pixels.
    const before=first.paint.getImageData(0,0,773,956).data;
    let pixel=0;while(pixel<773*956&&!before[pixel*4+3])pixel++;
    if(pixel<773*956){
      erasedPixel={x:pixel%773,y:Math.floor(pixel/773),alpha:before[pixel*4+3]};
      first.paint.clearRect(erasedPixel.x,erasedPixel.y,1,1);
    }
    copySetup(773,956);
    ctx.drawImage(first.source,0,-526);ctx.drawImage(second.source,0,430);
  }
  if(mode!=='partial-erase')coverage=pairMask(remember(boxes[0].char,boxes[0].x,boxes[0].y),remember(boxes[1].char,boxes[1].x,boxes[1].y));
  const snapshot=window.__hrmCanvasText.snapshot({allowVerticalBoundary:true});
  const precondition=mode==='partial-erase'?Boolean(erasedPixel):coverage.strongIntersectionPixels>0;
  boundaryOverlapCases.push({name:'boundary-'+mode+'-stays-rejected',boxes,coverage,erasedPixel,precondition,issue:snapshot.issue,text:snapshot.text,
    passed:precondition&&Boolean(snapshot.issue)&&snapshot.text===''});
}
// School crests are ordinary decoded images, not tracked canvas strings. Their
// UI role must be proven from the education layout without a visible name.
// A data-only SVG keeps this probe independent of accounts and the network.
const educationCases=[];
const schoolCrest=new Image();
schoolCrest.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="336" height="336" viewBox="0 0 336 336">'+
  '<circle cx="168" cy="168" r="160" fill="white" stroke="#a32626" stroke-width="8"/>'+
  '<path d="M70 220V130h196v90M54 226h228M82 120l86-45 86 45" fill="none" stroke="#a32626" stroke-width="10"/></svg>');
await schoolCrest.decode();
function educationFont(paint){
  paint.font='14px "Microsoft YaHei"';paint.textBaseline='alphabetic';paint.textAlign='left';paint.direction='ltr';paint.fillStyle='#000000';
}
function schoolEntries(paint,{heading=true,degree=true,cropped=false,segmented=false,extraImage=false,paintLogo=null}={}){
  educationFont(paint);
  paint.fillText('上一段项目描述完整结束。',134,680);
  if(heading)paint.fillText('教育经历',44,736);
  for(const [index,y] of [724,898].entries()){
    if(paintLogo)paintLogo(paint,y);
    else{
      paint.save();paint.beginPath();paint.rect(134,y,56,56);paint.clip();
      if(cropped)paint.drawImage(schoolCrest,10,10,316,316,134,y,56,56);
      else paint.drawImage(schoolCrest,134,y,56,56);
      paint.restore();
    }
    const title='合肥工业大学 | '+(index?'工业工程':'机械工程')+(degree?' | '+(index?'本科':'硕士'):'');
    if(segmented){let x=202;for(const char of title){paint.fillText(char,x,y+12);x+=paint.measureText(char).width;}}
    else paint.fillText(title,202,y+12);
    paint.fillText(index?'2011 - 2015':'2015 - 2018',648,y+12);
    paint.fillText('211院校',202,y+46);
    paint.fillText('在校经历：',134,y+88);
    paint.fillText(index?'完成本科毕业设计，保留完整原文。':'获得校级奖学金，保留完整原文。',134,y+114);
  }
  paint.fillText('专业技能',44,1060);
  paint.fillText('熟练掌握 C# 和视觉算法开发。',134,1088);
  if(extraImage)paint.drawImage(schoolCrest,134,1110,56,56);
}
function recordEducation(name,{reject=false,rejectPattern=/图片/,ignored=2,segmented=false,degree=true,heading=true,condition=true}={}){
  const snapshot=window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  const expected=['上一段项目描述完整结束。',
    (heading?'教育经历 ':'')+'合肥工业大学 | 机械工程'+(degree?' | 硕士':'')+' 2015 - 2018','211院校','在校经历：','获得校级奖学金，保留完整原文。',
    '合肥工业大学 | 工业工程'+(degree?' | 本科':'')+' 2011 - 2015','211院校','在校经历：','完成本科毕业设计，保留完整原文。',
    '专业技能','熟练掌握 C# 和视觉算法开发。'].join('\n');
  educationCases.push({name,issue:snapshot.issue,issueCode:snapshot.issueCode||'',actualText:snapshot.text,expectedText:expected,
    ignoredImages:snapshot.diagnostics?.ignoredImages,operations:snapshot.diagnostics?.operations,
    sourceWidth:schoolCrest.naturalWidth,sourceHeight:schoolCrest.naturalHeight,segmented,
    passed:condition&&(reject?snapshot.issueCode==='unsupported'&&rejectPattern.test(snapshot.issue)&&snapshot.text==='':
      !snapshot.issue&&snapshot.text===expected&&snapshot.diagnostics?.ignoredImages===ignored)});
  return snapshot;
}
for(const segmented of [false,true]){
  copySetup(773,1200);schoolEntries(ctx,{segmented});
  recordEducation('education-crests-without-visible-header-'+(segmented?'individual-glyphs':'text-runs'),{segmented});
}
{
  const {source,paint}=cacheCanvas(773,1200);schoolEntries(paint);
  copySetup(773,1200);ctx.drawImage(source,0,0);
  recordEducation('education-crests-in-observed-cache-retain-original-text');
}
for(const [name,options] of [
  ['education-heading-missing',{heading:false}],
  ['education-degree-missing',{degree:false}],
  ['education-crest-cropped-source',{cropped:true}],
  ['education-extra-body-image',{extraImage:true}],
]){
  copySetup(773,1200);schoolEntries(ctx,options);
  recordEducation(name,{...options,reject:!options.cropped});
}
// A nearby school row supplies the information; the crest's source pixels,
// clipping mask and paint completeness are no longer collection requirements.
function framedSchoolLogo(paint,y,{mask='roundRect',inset=0,offset=0,oversize=false,erase=false}={}){
  const x=134+inset+offset,top=y+inset,size=56-inset*2,radius=6;
  paint.save();paint.beginPath();
  if(mask==='roundRect')paint.roundRect(x,top,size,size,radius);
  else if(mask==='arcTo'){
    paint.moveTo(x+radius,top);paint.arcTo(x+size,top,x+size,top+size,radius);
    paint.arcTo(x+size,top+size,x,top+size,radius);paint.arcTo(x,top+size,x,top,radius);
    paint.arcTo(x,top,x+size,top,radius);paint.closePath();
  }else if(mask==='circle')paint.arc(x+size/2,top+size/2,size/2,0,Math.PI*2);
  else if(mask==='different-frame')paint.arc(162,y+28,30,0,Math.PI*2);
  else{
    paint.moveTo(x,top+size);paint.lineTo(x+size/2,top);paint.lineTo(x+size,top+size);paint.closePath();
  }
  paint.clip();
  if(oversize)paint.drawImage(schoolCrest,106,y-28,112,112);
  else paint.drawImage(schoolCrest,134,y,56,56);
  paint.restore();
  if(erase)paint.clearRect(160,y+26,4,4);
}
for(const [name,options,reject=false] of [
  ['exact-native-roundRect',{mask:'roundRect'}],
  ['exact-four-arcTo',{mask:'arcTo'}],
  ['exact-circle',{mask:'circle'}],
  ['inset-rounded-mask',{mask:'roundRect',inset:2}],
  ['offset-rounded-mask',{mask:'roundRect',offset:2}],
  ['different-frame-circle',{mask:'different-frame'}],
  ['112px-image-cropped-to56px-frame',{mask:'roundRect',oversize:true},true],
  ['partially-erased-frame',{mask:'roundRect',erase:true}],
  // The recorder cannot localize this unsupported clip at all; it is a
  // drawing-level error, so no school-image record exists to ignore.
  ['unknown-triangle-clip',{mask:'triangle'},true],
]){
  for(const cached of [false,true]){
    const source=cached?cacheCanvas(773,1200):null;
    copySetup(773,1200);
    schoolEntries(source?.paint||ctx,{paintLogo:(paint,y)=>framedSchoolLogo(paint,y,options)});
    if(cached)ctx.drawImage(source.source,0,0);
    const snapshot=recordEducation('education-mask-'+name+(cached?'-cached':'-direct'),{reject,rejectPattern:/图片|裁剪/});
    Object.assign(educationCases.at(-1),{mask:options.mask,cached,
      educationChecks:snapshot.diagnostics?.details.filter(item=>item.kind==='education-check'),
      imageChecks:snapshot.diagnostics?.details.filter(item=>item.kind==='image')});
    if(!reject){
      const checks=educationCases.at(-1).educationChecks;
      educationCases.at(-1).passed&&=Boolean(checks?.length)&&checks.every(check=>
        check.reason==='accepted-text'&&check.sectionVerified===true&&check.titleVerified===true&&check.dateVerified===true);
    }
  }
}
// The right-hand date uses smaller regular glyphs than the bold school row.
// Some painters position each glyph by its ink centre, so the hyphen baseline
// can differ from adjacent digits despite a visually aligned date field.
function educationDateLayout(paint,{mode='run',offset=0,date='2015 - 2018',duplicate=false,drawLogo=true}={}){
  educationFont(paint);paint.font='bold 14px "Microsoft YaHei"';
  paint.fillText('教育经历',44,736);
  const title='合肥工业大学 | 机械工程 | 硕士',titleMetrics=paint.measureText(title);
  const titleBox={left:202-titleMetrics.actualBoundingBoxLeft,top:736-titleMetrics.actualBoundingBoxAscent,
    right:202+titleMetrics.actualBoundingBoxRight,bottom:736+titleMetrics.actualBoundingBoxDescent,baseline:736};
  paint.fillText(title,202,736);
  if(drawLogo)paint.drawImage(schoolCrest,134,724,56,56);
  paint.font='12px "Microsoft YaHei"';
  const boxes=[];
  function glyph(value,x,y){
    const metrics=paint.measureText(value);
    boxes.push({value,left:x-metrics.actualBoundingBoxLeft,top:y-metrics.actualBoundingBoxAscent,
      right:x+metrics.actualBoundingBoxRight,bottom:y+metrics.actualBoundingBoxDescent,baseline:y,width:metrics.width});
    paint.fillText(value,x,y);
  }
  if(mode==='run')glyph(date,648,736+offset);
  else{
    let x=648;
    for(const char of date){
      const metrics=paint.measureText(char);
      // Whitespace has no ink centre. A per-glyph ink painter advances over
      // it; the observer retains the separation through the actual positions.
      if(!char.trim()){x+=Math.floor(metrics.width);continue;}
      const y=mode==='centered'?Math.round(731+offset+(metrics.actualBoundingBoxAscent-metrics.actualBoundingBoxDescent)/2):736+offset;
      glyph(char,x,y);x+=Math.floor(metrics.width);
    }
  }
  if(duplicate)glyph('2011 - 2015',545,736+offset);
  educationFont(paint);paint.fillText('211院校',202,770);paint.fillText('在校经历：',134,812);
  paint.fillText('完整保留在校经历和所有日期字符。',134,838);
  return {titleBox,dateGlyphs:boxes};
}
for(const [name,options,reject=false] of [
  ['education-date-12px-run-bold14px-title',{}],
  ['education-date-small-run-offset1',{offset:1}],
  ['education-date-small-run-offset2',{offset:2}],
  ['education-date-small-run-offset3',{offset:3}],
  ['education-date-individual-floor-x',{mode:'individual'}],
  ['education-date-individual-common-baseline-offset1',{mode:'individual',offset:1}],
  ['education-date-individual-common-baseline-offset2',{mode:'individual',offset:2}],
  ['education-date-individual-common-baseline-offset3',{mode:'individual',offset:3}],
  ['education-date-individual-centered-ink',{mode:'centered'}],
  ['education-date-centered-ink-offset1',{mode:'centered',offset:1}],
  ['education-date-missing-year',{date:'2015 -'},true],
  ['education-date-missing-hyphen',{date:'2015 2018'},true],
  ['education-date-duplicate-neighbor',{duplicate:true},true],
]){
  copySetup(773,956);const geometry=educationDateLayout(ctx,options);
  const snapshot=window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  copySetup(773,956);educationDateLayout(ctx,{...options,drawLogo:false});
  const plain=window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  const expectedText='教育经历 合肥工业大学 | 机械工程 | 硕士 2015 - 2018\n211院校\n在校经历：\n完整保留在校经历和所有日期字符。';
  educationCases.push({name,...geometry,issue:snapshot.issue,actualText:snapshot.text,textWithoutLogo:plain.text,
    expectedText,
    educationChecks:snapshot.diagnostics?.details.filter(item=>item.kind==='education-check'),
    ignoredImages:snapshot.diagnostics?.ignoredImages,
    passed:reject?snapshot.issueCode==='unsupported'&&/图片/.test(snapshot.issue)&&snapshot.text==='':
      !snapshot.issue&&!plain.issue&&snapshot.text===plain.text&&snapshot.text===expectedText&&snapshot.diagnostics?.ignoredImages===1});
}
// A school without an institution badge vertically centers its title/date
// beside the crest. Keep the badge layout and centered layout in one section.
function educationCenteredLayout(paint,{segmented=false,drawLogo=true,secondBaseline=34,dateOffset=0,rounded=false}={}){
  educationFont(paint);
  const boxes=[];
  for(const [index,y] of [100,768].entries()){
    const baseline=y+(index?secondBaseline:12);
    if(!index)paint.fillText('教育经历',44,baseline);
    const title=index?'蚌埠学院 | 机械设计制造及其自动化 | 本科':'南京林业大学 | 机电工程学院 | 硕士';
    paint.font='bold 14px "Microsoft YaHei"';
    const m=paint.measureText(title);
    boxes.push({iconTop:y,iconBottom:y+56,titleTop:baseline-m.actualBoundingBoxAscent,
      titleBottom:baseline+m.actualBoundingBoxDescent,titleCenter:baseline+(m.actualBoundingBoxDescent-m.actualBoundingBoxAscent)/2});
    if(segmented){let x=202;for(const char of title){paint.fillText(char,x,baseline);x+=paint.measureText(char).width;}}
    else paint.fillText(title,202,baseline);
    paint.font='12px "Microsoft YaHei"';
    paint.fillText(index?'2016 - 2020':'2020 - 2023',648,baseline+(index?dateOffset:0));
    if(drawLogo){
      if(rounded)framedSchoolLogo(paint,y);
      else paint.drawImage(schoolCrest,134,y,56,56);
    }
    educationFont(paint);
    if(!index)paint.fillText('双一流院校',202,y+46);
    paint.fillText('在校经历：',134,Math.max(y+84,baseline+32));
    paint.fillText(index?'完成本科毕业设计并保留全部正文。':'完成研究生论文并保留全部正文。',134,Math.max(y+110,baseline+58));
  }
  return boxes;
}
for(const [name,options,reject=false] of [
  ['education-centered-no-badge-with-top-badged-school',{}],
  ['education-centered-no-badge-individual-glyphs',{segmented:true}],
  ['education-centered-no-badge-observed-cache',{cached:true}],
  ['education-centered-no-badge-scaled-cache',{cached:true,scale:.75}],
  ['education-centered-no-badge-rounded-cached-crest',{cached:true,rounded:true}],
  ['education-title-low-in-crest-is-not-centered',{secondBaseline:52},true],
  ['education-title-below-crest-is-not-decoration',{secondBaseline:70},true],
  ['education-centered-title-date-on-other-row',{dateOffset:20},true],
]){
  function render(drawLogo){
    copySetup(773,956);
    const cached=options.cached?cacheCanvas(773,956):null;
    const boxes=educationCenteredLayout(cached?.paint||ctx,{...options,drawLogo});
    if(cached){const scale=options.scale||1;ctx.drawImage(cached.source,0,0,773*scale,956*scale);}
    return {boxes,snapshot:window.__hrmCanvasText.snapshot({allowVerticalBoundary:true})};
  }
  const {boxes,snapshot}=render(true),plain=render(false).snapshot;
  const expectedText=['教育经历 南京林业大学 | 机电工程学院 | 硕士 2020 - 2023','双一流院校',
    '在校经历：','完成研究生论文并保留全部正文。','蚌埠学院 | 机械设计制造及其自动化 | 本科 2016 - 2020',
    '在校经历：','完成本科毕业设计并保留全部正文。'].join('\n');
  educationCases.push({name,boxes,issue:snapshot.issue,issueCode:snapshot.issueCode||'',actualText:snapshot.text,
    expectedText,textWithoutLogo:plain.text,ignoredImages:snapshot.diagnostics?.ignoredImages,
    educationChecks:snapshot.diagnostics?.details.filter(item=>item.kind==='education-check'),
    passed:reject?snapshot.issueCode==='unsupported'&&/图片/.test(snapshot.issue)&&snapshot.text==='':
      !snapshot.issue&&!plain.issue&&snapshot.text===expectedText&&snapshot.text===plain.text&&snapshot.diagnostics?.ignoredImages===2});
}
// Study-form labels belong to the captured title. Recognizing the crest must
// preserve them verbatim, including the non-full-time qualifier used by review.
function educationStudyFormatLayout(paint,{segmented=false,drawLogo=true,degree='硕士',studyForm='非全日制'}={}){
  educationFont(paint);
  const titles=[
    '华东师范大学 | 电子信息 | '+(degree?degree+' · ':'')+studyForm,
    '盐城工学院 | 电气工程及其自动化 | 本科',
  ];
  const boxes=[];
  for(const [index,y] of [620,700].entries()){
    const baseline=y+14,title=titles[index];
    paint.font='bold 14px "Microsoft YaHei"';
    if(!index)paint.fillText('教育经历',49,baseline);
    const m=paint.measureText(title);
    boxes.push({iconTop:y,iconBottom:y+56,titleTop:baseline-m.actualBoundingBoxAscent,
      titleBottom:baseline+m.actualBoundingBoxDescent});
    if(segmented){let x=202;for(const char of title){paint.fillText(char,x,baseline);x+=paint.measureText(char).width;}}
    else paint.fillText(title,202,baseline);
    paint.font='12px "Microsoft YaHei"';
    paint.fillText(index?'2013 - 2015':'2022 - 2025',648,baseline);
    if(drawLogo)framedSchoolLogo(paint,y);
    educationFont(paint);
    paint.fillText(index?'卓越工程师计划':'QS世界大学排名TOP500',202,y+46);
  }
  paint.fillText('专业技能',49,820);
  paint.fillText('完整保留学习形式及后续正文。',134,848);
  return {boxes,titles};
}
for(const [name,options,reject=false] of [
  ['education-study-form-non-full-time-two-schools',{}],
  ['education-study-form-non-full-time-individual-glyphs',{segmented:true}],
  ['education-study-form-non-full-time-cached-rounded-crests',{segmented:true,cached:true}],
  ['education-study-form-full-time-preserved',{studyForm:'全日制'}],
  ['education-study-form-without-degree-is-not-title',{degree:''},true],
  ['education-study-form-prose-suffix-is-not-title',{studyForm:'非全日制培训'},true],
]){
  function render(drawLogo){
    copySetup(777,956);
    const cached=options.cached?cacheCanvas(777,956):null;
    const layout=educationStudyFormatLayout(cached?.paint||ctx,{...options,drawLogo});
    if(cached)ctx.drawImage(cached.source,0,0);
    return {...layout,snapshot:window.__hrmCanvasText.snapshot({allowVerticalBoundary:true})};
  }
  const {boxes,titles,snapshot}=render(true),plain=render(false).snapshot;
  const expectedText=['教育经历 '+titles[0]+' 2022 - 2025','QS世界大学排名TOP500',
    titles[1]+' 2013 - 2015','卓越工程师计划','专业技能','完整保留学习形式及后续正文。'].join('\n');
  const checks=snapshot.diagnostics?.details.filter(item=>item.kind==='education-check');
  educationCases.push({name,boxes,issue:snapshot.issue,issueCode:snapshot.issueCode||'',actualText:snapshot.text,
    expectedText,textWithoutLogo:plain.text,ignoredImages:snapshot.diagnostics?.ignoredImages,educationChecks:checks,
    passed:!plain.issue&&plain.text===expectedText&&(reject?
      snapshot.issueCode==='unsupported'&&/图片/.test(snapshot.issue)&&snapshot.text===''&&
        snapshot.diagnostics?.ignoredImages===1&&checks?.[0]?.reason==='title-unverified'&&checks[0].dateVerified:
      !snapshot.issue&&snapshot.text===expectedText&&snapshot.diagnostics?.ignoredImages===2)});
}
// A later viewport may retain a previously verified crest and its complete
// title/date while the education gutter heading has scrolled above the canvas.
// Only the same pinned read and original paint lineage may carry that proof.
for(const [name,options,reject=false] of [
  ['education-scroll-same-paint-heading-above-canvas',{}],
  ['education-scroll-rounded-same-paint-heading-above-canvas',{rounded:true}],
  ['education-scroll-scaled-same-paint-heading-above-canvas',{scale:.75}],
  ['education-scroll-without-first-viewport-proof',{initialProof:false},true],
  ['education-scroll-without-pinned-read',{session:false},true],
  ['education-scroll-new-session-cannot-inherit',{newSession:true},true],
  ['education-scroll-new-paint-of-same-bitmap-cannot-inherit',{newPaint:true},true],
  ['education-scroll-erased-source-heading-revokes-proof',{eraseHeading:true},true],
  ['education-scroll-gradient-covered-source-heading-revokes-proof',{gradientHeading:true},true],
  ['education-scroll-erased-source-title-revokes-proof',{eraseTitle:true},true],
  ['education-scroll-erased-source-crest-revokes-proof',{eraseCrest:true},true],
  ['education-scroll-new-section-before-crest-revokes-proof',{newSection:true},true],
]){
  delete window.__hrmBackgroundRead;
  let cached=cacheCanvas(773,1200);
  const paintOptions=options.rounded?{paintLogo:(paint,y)=>framedSchoolLogo(paint,y)}:{};
  schoolEntries(cached.paint,paintOptions);
  copySetup(773,956);
  const session={token:'native-education-'+name,canvas,expectedName:'王**'};
  if(options.session!==false)window.__hrmBackgroundRead=session;
  const scale=options.scale||1;
  function render(offset){
    ctx.clearRect(0,0,773,956);ctx.drawImage(cached.source,0,offset*scale,773*scale,1200*scale);
    return window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  }
  const before=options.initialProof===false?null:render(-400);
  if(options.newSession)window.__hrmBackgroundRead={...session,token:session.token+'-replacement'};
  if(options.newPaint){cached=cacheCanvas(773,1200);schoolEntries(cached.paint,paintOptions);}
  if(options.eraseHeading)cached.paint.clearRect(40,715,75,40);
  if(options.gradientHeading){
    const gradient=cached.paint.createLinearGradient(40,715,115,755);
    gradient.addColorStop(0,'#ffffff');gradient.addColorStop(1,'#eeeeee');
    cached.paint.fillStyle=gradient;cached.paint.fillRect(40,715,75,40);
  }
  if(options.eraseTitle)cached.paint.clearRect(200,885,410,40);
  if(options.eraseCrest)cached.paint.clearRect(145,920,6,6);
  let snapshot=render(-800);
  if(options.newSection){
    educationFont(ctx);ctx.fillText('资格证书',44,75);
    snapshot=window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  }
  delete window.__hrmBackgroundRead;
  const plainCache=cacheCanvas(773,1200);schoolEntries(plainCache.paint,{paintLogo:()=>{}});
  ctx.clearRect(0,0,773,956);ctx.drawImage(plainCache.source,0,-800*scale,773*scale,1200*scale);
  const plain=window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  const precondition=options.initialProof===false||!before.issue&&before.diagnostics?.ignoredImages===2;
  const educationChecks=snapshot.diagnostics?.details.filter(item=>item.kind==='education-check');
  const history=educationChecks?.find(item=>item.reason==='accepted-text-history');
  educationCases.push({name,issue:snapshot.issue,issueCode:snapshot.issueCode||'',actualText:snapshot.text,
    textWithoutLogo:plain.text,ignoredImages:snapshot.diagnostics?.ignoredImages,
    initialIssue:before?.issue,initialIgnoredImages:before?.diagnostics?.ignoredImages,
    educationChecks,
    passed:precondition&&(reject?snapshot.issueCode==='unsupported'&&/图片/.test(snapshot.issue)&&snapshot.text==='':
      !snapshot.issue&&!plain.issue&&snapshot.text===plain.text&&snapshot.diagnostics?.ignoredImages===1&&
      history?.sectionFromHistory===true&&history.historySourceStable===true&&
      history.historyTitleMatched===true&&history.historyHeadingAbove===true)});
}
delete window.__hrmBackgroundRead;
// School text establishes the nearby small image role even when the crest
// is incomplete on the first viewport or internally cropped by a cache.
// Text section history is still required only after its heading scrolls away.
function boundarySchoolLayout(paint,{drawLogo=true,centered=false}={}){
  educationFont(paint);
  paint.fillText('上一段项目描述必须完整保留。',134,460);
  paint.fillText('教育经历',49,500);
  const baseline=904+(centered?34:14);
  paint.font='bold 14px "Microsoft YaHei"';
  paint.fillText('海南大学 | 风景园林 | 本科',202,baseline);
  paint.font='12px "Microsoft YaHei"';paint.fillText('2014 - 2018',648,baseline);
  if(drawLogo)framedSchoolLogo(paint,904);
  educationFont(paint);
  paint.fillText('在校经历：',134,1000);
  paint.fillText('保留完整原文，不能以装饰证明补造文字。',134,1028);
  paint.fillText('专业技能',49,1080);
  paint.fillText('熟悉园林设计与数据分析。',134,1108);
}
for(const [name,options,reject=false] of [
  ['education-boundary-proven-bottom-four-pixels',{}],
  ['education-boundary-proven-top-four-pixels-centered-title',{centered:true,offset:-908}],
  ['education-boundary-complete-frame-still-readable',{offset:-100}],
  ['education-boundary-first-bottom-crop-uses-school-text',{initialProof:false}],
  ['education-boundary-cache-crop-inside-viewport',{innerCrop:true,offset:-200}],
  ['education-boundary-horizontal-crop-still-rejected',{x:-140},true],
  ['education-boundary-new-read-with-visible-school-text',{newToken:true}],
  ['education-boundary-changed-source-cannot-inherit',{changedSource:true},true],
  ['education-boundary-new-unknown-image-still-blocks',{unknownImage:true},true],
]){
  delete window.__hrmBackgroundRead;
  const cached=cacheCanvas(773,1200);boundarySchoolLayout(cached.paint,options);
  copySetup(773,956);
  const session={token:'native-'+name,canvas,expectedName:'王**'};
  window.__hrmBackgroundRead=session;
  function read(){return window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});}
  ctx.drawImage(cached.source,0,-200);
  const before=options.initialProof===false?null:read();
  if(options.newToken)window.__hrmBackgroundRead={...session,token:session.token+'-new'};
  if(options.changedSource)cached.paint.clearRect(45,485,80,25);
  const offset=options.offset??0,x=options.x||0;
  ctx.clearRect(0,0,773,956);
  if(options.innerCrop)ctx.drawImage(cached.source,0,0,773,956,0,offset,773,956);
  else ctx.drawImage(cached.source,x,offset);
  if(options.unknownImage)ctx.drawImage(schoolCrest,620,40,22,22);
  const snapshot=read();
  delete window.__hrmBackgroundRead;
  const plainCache=cacheCanvas(773,1200);boundarySchoolLayout(plainCache.paint,{...options,drawLogo:false});
  ctx.clearRect(0,0,773,956);
  if(options.innerCrop)ctx.drawImage(plainCache.source,0,0,773,956,0,offset,773,956);
  else ctx.drawImage(plainCache.source,x,offset);
  const plain=read(),educationChecks=snapshot.diagnostics?.details.filter(item=>item.kind==='education-check');
  const edge=educationChecks?.find(item=>['accepted-text','accepted-text-history'].includes(item.reason));
  const precondition=options.initialProof===false||!before.issue&&before.diagnostics?.ignoredImages===1;
  educationCases.push({name,initialIssue:before?.issue,initialIgnoredImages:before?.diagnostics?.ignoredImages,
    issue:snapshot.issue,issueCode:snapshot.issueCode||'',actualText:snapshot.text,textWithoutLogo:plain.text,
    ignoredImages:snapshot.diagnostics?.ignoredImages,educationChecks,
    passed:precondition&&(reject?snapshot.issueCode==='unsupported'&&Boolean(snapshot.issue)&&snapshot.text==='':
      !snapshot.issue&&!plain.issue&&snapshot.text===plain.text&&snapshot.diagnostics?.ignoredImages===1&&
      edge?.titleVerified===true&&edge.dateVerified===true&&edge.sectionVerified===true)});
}
delete window.__hrmBackgroundRead;
// The reported first-paint case: the 56px school icon ends below a 956px
// canvas, while the entire school row is visible and the badge text is deferred.
for(const mode of ['regular','cropped-source','translucent','tracked-canvas']){
  function paintFirstViewport(drawLogo){
    copySetup(773,956);delete window.__hrmBackgroundRead;educationFont(ctx);
    ctx.fillText('工作经历',49,300);ctx.fillText('开发视觉算法并完整保留工作说明。',134,330);
    ctx.fillText('教育经历',49,924);
    ctx.font='bold 14px "Microsoft YaHei"';ctx.fillText('北华大学 | 测控技术与仪器 | 本科',202,924);
    ctx.font='12px "Microsoft YaHei"';ctx.fillText('2015 - 2019',648,924);
    ctx.fillText('省部共建',202,958);
    if(drawLogo){
      let image=schoolCrest;
      if(mode==='tracked-canvas'){
        image=document.createElement('canvas');image.width=image.height=336;
        image.getContext('2d').fillRect(0,0,336,336);
      }
      ctx.save();ctx.beginPath();ctx.roundRect(134,910,56,56,6);ctx.clip();
      if(mode==='translucent')ctx.globalAlpha=.5;
      if(mode==='cropped-source')ctx.drawImage(image,10,10,316,316,134,910,56,56);
      else ctx.drawImage(image,134,910,56,56);
      ctx.restore();
    }
    return window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  }
  const snapshot=paintFirstViewport(true),plain=paintFirstViewport(false);
  const expectedText=['工作经历','开发视觉算法并完整保留工作说明。',
    '教育经历 北华大学 | 测控技术与仪器 | 本科 2015 - 2019'].join('\n');
  const checks=snapshot.diagnostics?.details.filter(item=>item.kind==='education-check');
  educationCases.push({name:'education-first-paint-bottom-crest-'+mode,issue:snapshot.issue,actualText:snapshot.text,
    textWithoutLogo:plain.text,expectedText,ignoredImages:snapshot.diagnostics?.ignoredImages,educationChecks:checks,
    passed:!snapshot.issue&&!plain.issue&&snapshot.text===plain.text&&snapshot.text===expectedText&&
      snapshot.diagnostics?.ignoredImages===1&&snapshot.boundaryRows?.bottom===true&&
      checks?.length===1&&checks[0].reason==='accepted-text'&&checks[0].titleVerified&&checks[0].dateVerified});
}
// The reported cache seam splits one 56px school decoration at y808 into
// 46px and 10px image records. School/date text is complete, so the number
// of image pieces (or repeated decoration paint records) is not evidence
// that the education text is ambiguous. Compare every readable case to the
// exact original strings and to the same native layout without school images.
function splitSchoolLayout(paint,{drawLogo=true,repeated=false,unknownImage=false}={}){
  educationFont(paint);
  paint.fillText('工作说明必须逐字保留，含 C++ / Python。',134,730);
  paint.fillText('教育经历',49,776);
  paint.font='bold 14px "Microsoft YaHei"';
  paint.fillText('北华大学 | 测控技术与仪器 | 本科',202,776);
  paint.font='12px "Microsoft YaHei"';paint.fillText('2015 - 2019',648,776);
  if(drawLogo){framedSchoolLogo(paint,762);if(repeated)framedSchoolLogo(paint,762);}
  educationFont(paint);paint.fillText('省部共建',202,844);
  paint.fillText('在校经历：完整保留学校文字与日期。',134,884);
  paint.fillText('专业技能',49,914);
  paint.fillText('熟练使用 C#、Python 与 OpenCV。',134,942);
  if(unknownImage)paint.drawImage(schoolCrest,620,848,22,22);
}
for(const [name,options] of [
  ['education-cache-seam-46-plus10',{cuts:[808]}],
  ['education-cache-seam-two-layers',{cuts:[808],nested:true}],
  ['education-cache-seam-four-pieces',{cuts:[790,800,808]}],
  ['education-cache-seam-repeated-decoration',{cuts:[808],repeated:true}],
  ['education-cache-seam-unknown-body-still-rejected',{cuts:[808],unknownImage:true}],
  ['education-cache-seam-two-layers-unknown-body-still-rejected',{cuts:[808],nested:true,unknownImage:true}],
]){
  function renderSchoolTiles(drawLogo){
    delete window.__hrmBackgroundRead;
    const cached=cacheCanvas(773,956);splitSchoolLayout(cached.paint,{...options,drawLogo});
    let source=cached.source;
    if(options.nested){
      const middle=cacheCanvas(773,956);middle.paint.drawImage(source,0,0);source=middle.source;
    }
    copySetup(773,956);
    let top=0;
    for(const bottom of [...options.cuts,956]){
      ctx.drawImage(source,0,top,773,bottom-top,0,top,773,bottom-top);top=bottom;
    }
    return window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  }
  const snapshot=renderSchoolTiles(true),plain=renderSchoolTiles(false);
  const expectedText=['工作说明必须逐字保留，含 C++ / Python。',
    '教育经历 北华大学 | 测控技术与仪器 | 本科 2015 - 2019','省部共建',
    '在校经历：完整保留学校文字与日期。','专业技能','熟练使用 C#、Python 与 OpenCV。'].join('\n');
  const checks=snapshot.diagnostics?.details.filter(item=>item.kind==='education-check')||[];
  const accepted=checks.filter(item=>item.reason==='accepted-text');
  const fragmentHeights=accepted.map(item=>item.imageH).sort((a,b)=>a-b);
  const tileEdges=[762,...options.cuts,818];
  const expectedHeights=tileEdges.slice(1).map((bottom,index)=>bottom-tileEdges[index]);
  // Diagnostics intentionally deduplicate equal records and retain at most
  // three examples. The aggregate ignored count must cover every image piece.
  const expectedDiagnosticHeights=expectedHeights.slice(0,3).sort((a,b)=>a-b);
  if(options.repeated)expectedHeights.push(...expectedHeights);
  expectedHeights.sort((a,b)=>a-b);
  const schoolPiecesConfirmed=accepted.length===expectedDiagnosticHeights.length&&
    JSON.stringify(fragmentHeights)===JSON.stringify(expectedDiagnosticHeights)&&
    accepted.every(item=>item.paintW===56&&item.paintH===56&&item.candidateCount===1&&
      item.sectionVerified&&item.titleVerified&&item.dateVerified&&item.touchCount===0)&&
    snapshot.diagnostics?.ignoredImages===expectedHeights.length;
  const unknownBlocked=Boolean(options.unknownImage)&&snapshot.issueCode==='unsupported'&&
    /图片/.test(snapshot.issue)&&snapshot.text===''&&plain.issueCode==='unsupported'&&plain.text==='';
  educationCases.push({name,issue:snapshot.issue,issueCode:snapshot.issueCode||'',actualText:snapshot.text,
    textWithoutLogo:plain.text,expectedText,ignoredImages:snapshot.diagnostics?.ignoredImages,
    fragmentHeights,expectedHeights,expectedDiagnosticHeights,educationChecks:checks,
    passed:schoolPiecesConfirmed&&(options.unknownImage?unknownBlocked:
      !snapshot.issue&&!plain.issue&&snapshot.text===expectedText&&snapshot.text===plain.text)});
}
// Two independent caches can supply the two halves of the same heading run.
// The recovered line must retain both dependencies when only the school tile
// is copied into a later viewport; changing either old half revokes proof.
for(const changedFirst of [false,true]){
  const first=cacheCanvas(773,1200),second=cacheCanvas(773,1200),school=cacheCanvas(773,1200);
  for(const fragment of [first,second]){educationFont(fragment.paint);fragment.paint.fillText('教育经历',44,700);}
  schoolEntries(school.paint,{heading:false});
  copySetup(773,956);
  window.__hrmBackgroundRead={token:'native-education-seam-'+changedFirst,canvas,expectedName:'王**'};
  ctx.drawImage(first.source,0,650,72,60,0,250,72,60);
  ctx.drawImage(second.source,72,650,701,60,72,250,701,60);
  ctx.drawImage(school.source,0,710,773,490,0,310,773,490);
  const before=window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  if(changedFirst)first.paint.clearRect(40,680,75,40);
  ctx.clearRect(0,0,773,956);ctx.drawImage(school.source,0,-800);
  const snapshot=window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  delete window.__hrmBackgroundRead;
  const plainCache=cacheCanvas(773,1200);schoolEntries(plainCache.paint,{heading:false,paintLogo:()=>{}});
  ctx.clearRect(0,0,773,956);ctx.drawImage(plainCache.source,0,-800);
  const plain=window.__hrmCanvasText.snapshot({expectedName:'王**',allowVerticalBoundary:true});
  const educationChecks=snapshot.diagnostics?.details.filter(item=>item.kind==='education-check');
  const history=educationChecks?.find(item=>item.reason==='accepted-text-history');
  educationCases.push({name:'education-scroll-seam-heading-'+(changedFirst?'changed-first-fragment-rejected':'both-fragments-retained'),
    initialIssue:before.issue,initialIgnoredImages:before.diagnostics?.ignoredImages,
    issue:snapshot.issue,issueCode:snapshot.issueCode||'',actualText:snapshot.text,textWithoutLogo:plain.text,
    ignoredImages:snapshot.diagnostics?.ignoredImages,educationChecks,
    passed:!before.issue&&before.diagnostics?.ignoredImages===2&&(changedFirst?
      snapshot.issueCode==='unsupported'&&/图片/.test(snapshot.issue)&&snapshot.text==='':
      !snapshot.issue&&!plain.issue&&snapshot.text===plain.text&&snapshot.diagnostics?.ignoredImages===1&&
      history?.sectionFromHistory===true&&history.historySourceStable===true&&
      history.historyTitleMatched===true&&history.historyHeadingAbove===true)});
}
delete window.__hrmBackgroundRead;
// A clipped viewport must not reclassify previously proven header decorations
// as body images. This uses immutable, observed caches and a pinned read only.
const headerCases=[];
async function headerAsset(size,fill){
  const image=new Image();
  image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="${fill}"/></svg>`);
  await image.decode();return image;
}
const portraitAsset=await headerAsset(200,'#75c7d5'),badgeAsset=await headerAsset(38,'#348fea'),noticeAsset=await headerAsset(44,'#23bac0');
function headerHistoryLayout(paint,{drawImages=true,extraImage=false}={}){
  paint.font='22px "Microsoft YaHei"';paint.fillStyle='#222222';paint.fillText('陈**',134,51);
  paint.font='14px "Microsoft YaHei"';paint.fillText('36岁 10年以上 硕士 在职-考虑机会',134,80);
  paint.fillStyle='#e5f7f7';paint.beginPath();paint.roundRect(134,104,593,38,8);paint.fill();
  paint.save();paint.beginPath();paint.roundRect(134,104,593,38,8);paint.clip();
  paint.fillStyle='#222222';paint.fillText('该牛人近期受同行BOSS欢迎',170,128);
  if(drawImages)paint.drawImage(noticeAsset,142,112,22,22);
  paint.restore();
  paint.fillText('个人优势',49,180);paint.fillText('熟悉三维视觉检测和算法开发。',134,210);
  paint.fillText('工作经历',49,260);paint.fillText('合成设备公司 图像算法工程师',134,260);
  paint.fillText('完整保留本屏正文，不推断顶部被裁文字。',134,300);
  if(drawImages){
    paint.save();paint.beginPath();paint.arc(78,58,28,0,Math.PI*2);paint.clip();
    paint.drawImage(portraitAsset,50,30,56,56);paint.restore();
    paint.drawImage(badgeAsset,88,30,18,18);
  }
  if(extraImage)paint.drawImage(noticeAsset,620,5,22,22);
}
for(const [name,options,reject=false] of [
  ['header-scroll-cached-partial-name-and-portrait',{}],
  ['header-scroll-cached-entire-name-above',{offset:-80}],
  ['header-scroll-no-initial-proof',{initialProof:false},true],
  ['header-scroll-no-pinned-read',{session:false},true],
  ['header-scroll-new-read-token',{newToken:true},true],
  ['header-scroll-new-expected-candidate',{newName:true},true],
  ['header-scroll-new-source-paint',{newPaint:true},true],
  ['header-scroll-erased-source-name',{eraseName:true},true],
  ['header-scroll-horizontal-crop',{x:-55},true],
  ['header-scroll-initial-unknown-image-never-grants-proof',{initialExtra:true},true],
]){
  delete window.__hrmBackgroundRead;
  let cached=cacheCanvas(777,956);headerHistoryLayout(cached.paint,{extraImage:options.initialExtra});
  copySetup(777,956);
  const session={token:'native-'+name,canvas,expectedName:'陈**'};
  if(options.session!==false)window.__hrmBackgroundRead=session;
  const read=()=>window.__hrmCanvasText.snapshot({expectedName:options.newName&&changed?'李**':'陈**',allowVerticalBoundary:true});
  let changed=false;
  ctx.drawImage(cached.source,0,0);
  const before=options.initialProof===false?null:read();
  if(options.newToken)window.__hrmBackgroundRead={...session,token:session.token+'-new'};
  if(options.newName)window.__hrmBackgroundRead={...session,expectedName:'李**'};
  if(options.newPaint){cached=cacheCanvas(777,956);headerHistoryLayout(cached.paint);}
  if(options.eraseName)cached.paint.clearRect(130,25,90,32);
  const offset=options.offset||-42,x=options.x||0;
  changed=true;ctx.clearRect(0,0,777,956);ctx.drawImage(cached.source,x,offset);
  const snapshot=read();
  delete window.__hrmBackgroundRead;
  const plainCache=cacheCanvas(777,956);headerHistoryLayout(plainCache.paint,{drawImages:false});
  ctx.clearRect(0,0,777,956);ctx.drawImage(plainCache.source,x,offset);
  const plain=window.__hrmCanvasText.snapshot({expectedName:'陈**',allowVerticalBoundary:true});
  const initialOK=options.initialProof===false||
    (options.initialExtra?before.issueCode==='unsupported':!before.issue&&before.diagnostics?.ignoredImages===3);
  const remaining=offset===-80?2:3;
  headerCases.push({name,initialIssue:before?.issue,initialIgnoredImages:before?.diagnostics?.ignoredImages,
    issue:snapshot.issue,issueCode:snapshot.issueCode||'',actualText:snapshot.text,textWithoutImages:plain.text,
    ignoredImages:snapshot.diagnostics?.ignoredImages,boundaryRows:snapshot.boundaryRows,details:snapshot.diagnostics?.details,
    passed:initialOK&&(reject?snapshot.issueCode==='unsupported'&&(options.x?Boolean(snapshot.issue):/图片/.test(snapshot.issue))&&snapshot.text==='':
      !snapshot.issue&&!plain.issue&&snapshot.text===plain.text&&!snapshot.text.includes('陈**')&&
      snapshot.diagnostics?.ignoredImages===remaining&&
      (offset!==-42||snapshot.boundaryRows?.top===true))});
}
delete window.__hrmBackgroundRead;
const replayProbe=new OffscreenCanvas(16,16).getContext('2d');
const nativeStyleReplay=Object.entries({font:'14px Arial',textAlign:'left',textBaseline:'alphabetic',direction:'ltr',lang:'en',
  fontKerning:'auto',fontStretch:'normal',fontVariantCaps:'normal',letterSpacing:'',wordSpacing:'',textRendering:'auto'}).map(([key,value])=>{
    const before=replayProbe[key],available=key in replayProbe;replayProbe[key]=value;
    return {key,requested:value,before,actual:replayProbe[key],available};
  });
const result={userAgent:navigator.userAgent,devicePixelRatio,nativeStyleReplay,fonts:{arial:document.fonts.check('14px Arial'),
  yahei:document.fonts.check('14px "Microsoft YaHei"')},cases,shortRunCases,boundaryCases,copyCases,boundaryOverlapCases,educationCases,headerCases};
// headless-shell stdout may use the Windows code page. Keep the result payload
// ASCII so its Chinese strings round-trip independently of that encoding.
document.getElementById('native-result').textContent=JSON.stringify(result).replace(/[\u007f-\uffff]/g,
  value=>'\\u'+value.charCodeAt(0).toString(16).padStart(4,'0'));
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", type=Path, default=DEFAULT_BINARY)
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--check", action="store_true", help="Return nonzero if a regression case fails")
    args = parser.parse_args()
    if not args.browser.is_file():
        parser.error(f"Existing headless-shell binary not found: {args.browser}")
    root = Path(__file__).resolve().parents[1]
    directory = Path(tempfile.mkdtemp(prefix="hrm-native-canvas-"))
    profile = directory / "empty-profile"
    profile.mkdir()
    geometry = (root / "extension/canvas-geometry.js").read_text(encoding="utf-8")
    observer = (root / "extension/canvas-text.js").read_text(encoding="utf-8")
    expand = (root / "extension/canvas-expand.js").read_text(encoding="utf-8")
    glyphs_path = root / "extension/canvas-glyphs.js"
    glyphs = glyphs_path.read_text(encoding="utf-8") if glyphs_path.is_file() else ""
    js_string = lambda value: json.dumps(value, ensure_ascii=True).replace("</", "<\\/")
    script = ("const GEOMETRY_SOURCE=" + js_string(geometry) + ";\n"
              "const GLYPHS_SOURCE=" + js_string(glyphs) + ";\n"
              "const EXPAND_SOURCE=" + js_string(expand) + ";\n"
              "const OBSERVER_SOURCE=" + js_string(observer) + ";\n"
              "(async()=>{\n" + PROBE_JS + "\n})().catch(error=>{"
              "document.getElementById('native-result').textContent=JSON.stringify({error:String(error),stack:error.stack});});")
    document = ("<!doctype html><meta charset='utf-8'>"
                "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; "
                "script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'\">"
                "<title>Offline native Canvas test</title>"
                "<canvas id='resume' width='1600' height='400' style='width:800px;height:200px'></canvas>"
                "<pre id='native-result'>pending</pre><script>" + script + "</script>")
    page = directory / "probe.html"
    page.write_text(document, encoding="utf-8")
    command = [str(args.browser), "--headless", "--dump-dom", "--disable-gpu",
               "--disable-extensions", "--disable-background-networking", "--disable-component-update",
               "--disable-sync", "--no-first-run", "--no-default-browser-check", "--no-pings",
               "--host-resolver-rules=MAP * ~NOTFOUND", "--virtual-time-budget=1000",
               f"--user-data-dir={profile}", page.as_uri()]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                               timeout=args.timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    (directory / "browser-stderr.log").write_text(completed.stderr, encoding="utf-8")
    (directory / "dump.html").write_text(completed.stdout, encoding="utf-8")
    match = re.search(r'<pre id="native-result">(.*?)</pre>', completed.stdout, re.DOTALL)
    if not match:
        raise RuntimeError(f"No native probe result (exit {completed.returncode}); artifacts: {directory}")
    result = json.loads(html.unescape(match.group(1)))
    output = directory / "result.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if "error" in result:
        raise RuntimeError(f"{result['error']}; artifacts: {directory}")
    print(json.dumps({"result": str(output), "html": str(page), "browser": str(args.browser),
                      "userAgent": result["userAgent"], "fonts": result["fonts"],
                      "cases": [{"name": case["name"], "passed": case["passed"], "utf8Exact": case["utf8Exact"],
                                 "actualUtf8Bytes": case["actualUtf8Bytes"], "expectedUtf8Bytes": case["expectedUtf8Bytes"],
                                 "issue": case["issue"], "pixelExactlyEqual": case["pixelExactlyEqual"],
                                 "pixelChecksum": case["pixelChecksum"],
                                 "inkBoxOverlaps": sum(pair["boxOverlapX"] > 0 and pair["boxOverlapY"] > 0 for pair in case["masks"]),
                                 "pixelOverlaps": sum(pair["intersectingPixels"] > 0 for pair in case["masks"]),
                                 "strongPixelOverlaps": sum(pair["strongIntersectionPixels"] > 0 for pair in case["masks"])}
                                for case in result["cases"]],
                      "shortRunCases": result["shortRunCases"], "boundaryCases": result["boundaryCases"], "copyCases": result["copyCases"],
                      "boundaryOverlapCases": result["boundaryOverlapCases"],
                      "educationCases": result["educationCases"], "headerCases": result["headerCases"]}, ensure_ascii=True, indent=2))
    if args.check and not all(case["passed"] for case in result["cases"] + result["shortRunCases"] + result["boundaryCases"] + result["copyCases"] + result["boundaryOverlapCases"] + result["educationCases"] + result["headerCases"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
