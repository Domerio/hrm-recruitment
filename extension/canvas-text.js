// Observe original Canvas 2D text during normal rendering. No OCR, input or clipboard.
(() => {
  if (location.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(location.hostname) ||
      !/^\/web\/frame\/c-resume\/?$/.test(location.pathname)) return;
  // Registered scripts also match other tabs. Only the collector's explicitly
  // armed top-level page may record resume text in its child frame.
  try { if (window.top.__hrmCanvasTextEnabled !== true) return; } catch { return; }
  if (window.__hrmCanvasText?.version === 1) return;
  window.__hrmCanvasText?.stop?.();
  const proto = globalThis.CanvasRenderingContext2D?.prototype;
  if (!proto) return;
  const geometry=window.__hrmCanvasGeometry;
  const glyphs=window.__hrmCanvasGlyphs;
  const drawings = new WeakMap(), contexts = new WeakMap(), canvasContexts = new WeakMap(), originals = [], sizeOriginals = [], creationOriginals = [];
  let nextId = 0, nextCopyMark=1, revision = 0, stopped = false;
  let educationSession=null,experienceSession=null,nextHintId=1;
  const limit = 12000;
  const intersects = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const contains = (a,b) => a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom;
  const fullRect = d => ({left:0,top:0,right:d.width,bottom:d.height});
  const finiteRect = r => r && Object.values(r).every(Number.isFinite) && r.right > r.left && r.bottom > r.top;
  const equalRect = (a,b) => ['left','top','right','bottom'].every(k => Math.abs(a[k]-b[k]) < 0.1);
  function state(canvas) {
    let d = drawings.get(canvas);
    if (!d) {
      d = {id:String(++nextId),width:canvas.width,height:canvas.height,entries:[],copyFragments:[],copyMarks:[],separators:[],issues:[],issueCounts:new Map(),details:[],backgrounds:[],images:[],operations:{},pixelSerial:0,pendingHighlight:null,activeHighlight:null,pixelOperation:null,overflow:false,overflowReason:'',baseline:false,revision:++revision};
      drawings.set(canvas,d);
    } else if (d.width !== canvas.width || d.height !== canvas.height) reset(canvas);
    return d;
  }
  function reset(canvas) {
    let d = drawings.get(canvas);
    if (!d) { d = state(canvas); }
    d.width=canvas.width;d.height=canvas.height;d.entries=[];d.copyFragments=[];d.copyMarks=[];d.separators=[];d.issues=[];d.issueCounts.clear();d.details=[];d.backgrounds=[];d.images=[];d.operations={};d.overflow=false;d.overflowReason='';d.baseline=true;d.revision=++revision;
    d.pendingHighlight=null;d.activeHighlight=null;d.pixelSerial++;
    glyphs?.clear();
    return d;
  }
  function context(ctx) {
    let info=contexts.get(ctx);
    if (!info) { info={clipped:false,clipRect:null,clipShapes:[],stack:[],path:null};contexts.set(ctx,info);canvasContexts.set(ctx.canvas,ctx); }
    return info;
  }
  function issue(d,message,rect=null,extra={}) {
    d.issueCounts.set(message,Math.min(1000000,(d.issueCounts.get(message)||0)+1));
    if (!d.issues.some(item=>item.message===message && item.repaintKey===extra.repaintKey&&
      JSON.stringify(item.boundary)===JSON.stringify(extra.boundary)&&
      ((!item.rect&&!rect)||(item.rect&&rect&&(message==='画布文字被局部覆盖'
        ?['left','top','right','bottom'].every(key=>item.rect[key]===rect[key]):equalRect(item.rect,rect)))))) {
      // Keep the actual cause. The old 64-region limit discarded every cause
      // and poisoned even unrelated viewport regions with a generic error.
      if (d.issues.length < 2048) d.issues.push({message,rect,...extra});
      else {d.overflow=true;d.overflowReason ||= message;}
    }
  }
  function diagnostics(d,images=[],ignoredImages=0,extraIssues=[]) {
    const counts=new Map(d.issueCounts);
    const partialCount=d.issues.filter(item=>item.message==='画布文字被局部覆盖').length;
    if(partialCount)counts.set('画布文字被局部覆盖',partialCount);else counts.delete('画布文字被局部覆盖');
    for(const item of extraIssues)counts.set(item.message,(counts.get(item.message)||0)+1);
    if(images.length)counts.set('画布含无法确认是否属于正文的图片，不能完整读取原文',images.length);
    return {reasonCounts:[...counts].map(([reason,count])=>({reason,count})),
      operations:{...d.operations},entries:d.entries.length,baseline:d.baseline,overflow:d.overflow,details:d.details,ignoredImages};
  }
  function issueDetail(d,sample) {
    if(d.details.some(item=>JSON.stringify(item)===JSON.stringify(sample)))return;
    if(d.details.filter(item=>item.kind===sample.kind).length<3)d.details.push(sample);
  }
  function horizontalCoverage(d,area,images,issues){
    const result={version:1,canvasId:d.id,revision:d.revision,complete:false,reason:'unconfirmed',
      canvasWidth:d.width,visibleLeft:area.left,visibleRight:area.right,readTop:area.top,readBottom:area.bottom,
      clippedLeft:Math.max(0,area.left),clippedRight:Math.max(0,d.width-area.right),
      outsideTextRuns:0,outsideImages:0,outsideIssues:0};
    if(!finiteRect(area)||!contains(fullRect(d),area))return result;
    const inBand=r=>r&&r.top<area.bottom&&r.bottom>area.top;
    const outside=r=>r.left<area.left||r.right>area.right;
    // Inspect original records across the FULL width of this vertical band.
    // `visible` rows below have already lost wholly hidden columns/lines and
    // cannot establish that a cropped strip contains only unused space.
    const entries=d.entries.filter(inBand);
    if(entries.length){result.textLeft=Math.min(...entries.map(e=>e.left));result.textRight=Math.max(...entries.map(e=>e.right));}
    result.outsideTextRuns=entries.filter(outside).length;
    result.outsideImages=images.filter(item=>inBand(item.rect)&&outside(item.rect)).length;
    // An unlocated drawing is a global reading problem, but cannot be in a
    // hidden side strip when the complete canvas width is visible.
    const hiddenSide=area.left>0||area.right<d.width;
    result.outsideIssues=issues.filter(item=>!item.rect?hiddenSide:
      inBand(item.boundary||item.rect)&&outside(item.boundary||item.rect)).length;
    if(!d.baseline||d.overflow||!d.entries.length)return result;
    if(result.outsideTextRuns)result.reason='text-outside';
    else if(result.outsideImages)result.reason='image-outside';
    else if(result.outsideIssues)result.reason='drawing-outside';
    else {result.complete=true;result.reason=result.clippedLeft||result.clippedRight?'empty-margins':'full-width';}
    return result;
  }
  function bounds(ctx,left,top,right,bottom) {
    const m=ctx.getTransform();
    if (![m.a,m.b,m.c,m.d,m.e,m.f].every(Number.isFinite) || m.b || m.c || m.a<=0 || m.d<=0) return null;
    return {left:m.a*left+m.e,top:m.d*top+m.f,right:m.a*right+m.e,bottom:m.d*bottom+m.f};
  }
  const intersectRect = (a,b) => ({left:Math.max(a.left,b.left),top:Math.max(a.top,b.top),
    right:Math.min(a.right,b.right),bottom:Math.min(a.bottom,b.bottom)});
  function clipBounds(ctx,r) {
    const clip=context(ctx).clipRect;
    if(!clip)return r;
    const intersection=intersectRect(r,clip);
    return finiteRect(intersection)?intersection:null;
  }
  function rectangularPath(ctx) {
    const path=context(ctx).path;
    if(!path||path.complex||path.commands[0]!=='rect'||!path.commands.slice(1).every(command=>command==='closePath'))return null;
    return {left:path.left,top:path.top,right:path.right,bottom:path.bottom};
  }
  function pathShape(ctx) {
    const trace=context(ctx).path?.trace||[];
    // fill() and clip() implicitly close each subpath. The geometry analyzer
    // still rejects extra subpaths, so close only the single observed path.
    const closed=trace.length&&trace.at(-1).name!=='closePath'?[...trace,{name:'closePath',args:[],matrix:trace.at(-1).matrix}]:trace;
    return geometry?.analyze(closed)||
      (rectangularPath(ctx)?{kind:'rect',bounds:rectangularPath(ctx)}:null);
  }
  const shapeContains=(shape,r)=>shape.kind==='rect'?contains(shape.bounds,r):Boolean(geometry?.rectInside(shape,r));
  const backgroundContains=(shape,r)=>shapeContains(shape,r)&&
    (!shape.paintClipRect||contains(shape.paintClipRect,r))&&(!shape.paintClips||shape.paintClips.every(clip=>shapeContains(clip,r)));
  function rememberBackground(ctx,d,shape){
    if(d.backgrounds.length<128)d.backgrounds.push({...shape,sourceLineage:[],paintClipRect:context(ctx).clipRect,paintClips:[...context(ctx).clipShapes]});
  }
  function clipContains(ctx,r) {return (!context(ctx).clipRect||contains(context(ctx).clipRect,r))&&context(ctx).clipShapes.every(shape=>shapeContains(shape,r));}
  const samePaintFrame=(a,b)=>['left','top','right','bottom'].every(key=>
    Math.abs(a[key]-b[key])<=Number.EPSILON*32*Math.max(1,Math.abs(a[key]),Math.abs(b[key])));
  function decorationClipContains(ctx,r) {
    const info=context(ctx);
    // A confirmed school icon can use a known frame that masks its corners.
    // Match the original draw rectangle, never the bounds after clipping.
    return (!info.clipRect||contains(info.clipRect,r))&&info.clipShapes.every(shape=>shapeContains(shape,r)||
      (['roundRect','ellipse'].includes(shape.kind)&&samePaintFrame(shape.bounds,r)));
  }
  function pathDetail(ctx,kind) {
    const trace=context(ctx).path?.trace||[];
    issueDetail(state(ctx.canvas),{kind,commands:trace.slice(0,24).map(command=>command.name),
      commandCount:trace.length,clipCount:context(ctx).clipShapes.length});
  }
  function clip(ctx,args) {
    const info=context(ctx);
    const shape=args.length===0||(args.length===1&&['nonzero','evenodd'].includes(args[0]))?pathShape(ctx):null;
    const rect=shape?.bounds;
    if(!rect||!Object.values(rect).every(Number.isFinite)){info.clipped=true;pathDetail(ctx,'clip-path');return;}
    info.clipRect=info.clipRect?intersectRect(info.clipRect,rect):rect;
    info.clipShapes=[...info.clipShapes,shape];
  }
  function usableContext(ctx,d) {
    if (context(ctx).clipped) {issue(d,'画布使用了不能确认的裁剪区域');return false;}
    if (ctx.globalCompositeOperation && ctx.globalCompositeOperation!=='source-over') {
      issue(d,'画布使用了不能确认的混合绘制');return false;
    }
    if (ctx.filter && ctx.filter!=='none') {issue(d,'画布使用了不能确认的绘制滤镜');return false;}
    return true;
  }
  const transparentStyle = style => typeof style==='string' && (/^transparent$/i.test(style)||
    /^#[\da-f]{3}0$/i.test(style)||/^#[\da-f]{6}00$/i.test(style)||
    /^rgba\([^,]+,[^,]+,[^,]+,\s*0(?:\.0*)?\s*\)$/i.test(style));
  function quantizedNeighbours(first,second){
    if(first.scaleX!==second.scaleX||first.scaleY!==second.scaleY||first.textBaseline!==second.textBaseline)return false;
    const epsilon=Number.EPSILON*8*Math.max(1,Math.abs(first.baseline),Math.abs(second.baseline),
      Math.abs(first.advanceLeft),Math.abs(second.advanceLeft),Math.abs(first.advanceRight),Math.abs(second.advanceRight));
    if(Math.abs(first.baseline-second.baseline)>epsilon)return false;
    const [before,after]=first.advanceLeft<second.advanceLeft?[first,second]:[second,first],scale=before.scaleX;
    if(!(scale>0))return false;
    const width=(before.advanceRight-before.advanceLeft)/scale,step=(after.advanceLeft-before.advanceLeft)/scale;
    const floor=Math.floor(width),fraction=width-floor;
    const overlap=Math.max(0,Math.min(before.advanceRight,after.advanceRight)-after.advanceLeft);
    return floor>0&&fraction>epsilon&&fraction<1-epsilon&&Math.abs(step-floor)<=epsilon&&
      overlap*2<Math.min(before.advanceRight-before.advanceLeft,after.advanceRight-after.advanceLeft)-epsilon;
  }
  const copyStyle=ctx=>JSON.stringify(['font','textBaseline','textAlign','direction','fillStyle','strokeStyle','lineWidth',
    'fontKerning','fontStretch','fontVariantCaps','letterSpacing','wordSpacing','textRendering','lang'].map(key=>ctx[key]));
  const highlightTextStyle=ctx=>JSON.stringify(['font','textBaseline','textAlign','direction','fillStyle',
    'fontKerning','fontStretch','fontVariantCaps','letterSpacing','wordSpacing','textRendering','lang'].map(key=>ctx[key]));
  const layoutEqual=(a,b)=>Math.abs(a-b)<=Number.EPSILON*8*Math.max(1,Math.abs(a),Math.abs(b));
  const transformKey=ctx=>{const m=ctx.getTransform();return JSON.stringify([m.a,m.b,m.c,m.d,m.e,m.f]);};
  function highlightCell(paint,entry){
    const draw=entry.glyphDraw;
    if(!paint||!draw||!entry.raster||!entry.repaintKey||!layoutEqual(paint.rect.left,entry.advanceLeft)||
      paint.rect.top>entry.top||paint.rect.bottom<entry.bottom)return false;
    const width=entry.advanceRight-entry.advanceLeft,paintWidth=paint.rect.right-paint.rect.left;
    if(layoutEqual(paintWidth,width))return true;
    const floor=Math.floor(draw.width),fraction=draw.width-floor;
    return floor>0&&fraction>Number.EPSILON*8&&fraction<1-Number.EPSILON*8&&
      layoutEqual(paintWidth,floor*draw.scaleX);
  }
  function highlightPredecessor(ctx,d,entry){
    const paint=d.activeHighlight,prior=paint?.partials?.length===1?paint.partials[0]:null,old=prior?.entry;
    if(!old||paint.touchedEntries!==1||!highlightCell(paint,entry)||paint.transform!==transformKey(ctx)||
      !d.issues.includes(prior.issue)||old.highlightTextStyle!==entry.highlightTextStyle||
      old.raster?.lang!==entry.raster?.lang||old.glyphDraw?.style!==entry.glyphDraw?.style||
      ['scaleX','scaleY','translateX','translateY'].some(key=>old.glyphDraw?.[key]!==entry.glyphDraw?.[key])||
      !layoutEqual(old.baseline,entry.baseline)||old.textBaseline!==entry.textBaseline)return null;
    const exact=layoutEqual(old.advanceRight,entry.advanceLeft),floor=quantizedNeighbours(old,entry);
    if(!(exact||floor)||old.advanceLeft>=entry.advanceLeft||old.left>=entry.left||old.right>=entry.right)return null;
    if(exact&&prior.verification.coveredLeft<old.advanceRight)return null;
    return prior;
  }
  function textCoordinateIssue(ctx,d,value,x,y,metrics,stroke,reason) {
    const matrix=ctx.getTransform(),originX=Number(x),originY=Number(y);
    const detail={kind:'text-coordinate',reason,textLength:[...value].length,stroke,
      xFinite:Number.isFinite(originX),yFinite:Number.isFinite(originY)};
    for(const [key,number] of [['x',originX],['y',originY],['measuredWidth',metrics?.width],
      ['metricLeft',metrics?.actualBoundingBoxLeft],['metricRight',metrics?.actualBoundingBoxRight],
      ['metricAscent',metrics?.actualBoundingBoxAscent],['metricDescent',metrics?.actualBoundingBoxDescent],
      ['matrixA',matrix.a],['matrixB',matrix.b],['matrixC',matrix.c],
      ['matrixD',matrix.d],['matrixE',matrix.e],['matrixF',matrix.f]]){
      if(Number.isFinite(number))detail[key]=number;
    }
    issueDetail(d,detail);
    issue(d,'画布文字的坐标或变换无法确认');
  }
  function nativeTextNoPaint(ctx,[value,x,y,maxWidth],stroke=false) {
    try {
      const originX=Number(x),originY=Number(y),requestedWidth=maxWidth===undefined?undefined:Number(maxWidth);
      if(!Number.isFinite(originX)||!Number.isFinite(originY)||
        requestedWidth!==undefined&&(!Number.isFinite(requestedWidth)||requestedWidth<=0))return true;
      // A non-whitespace format character can have no advance and no ink.
      // Keep spaces: separate space runs are part of the original text.
      if(stroke||typeof value!=='string'||!value.trim()||
        !/^[\p{Cf}\p{Variation_Selector}\u034F]+$/u.test(value)||ctx.globalAlpha!==1||
        ctx.globalCompositeOperation!=='source-over'||ctx.filter!=='none'||
        ctx.shadowColor&&!transparentStyle(ctx.shadowColor))return false;
      const metrics=ctx.measureText(value);
      return metrics.width===0&&[metrics.actualBoundingBoxLeft,metrics.actualBoundingBoxRight,
        metrics.actualBoundingBoxAscent,metrics.actualBoundingBoxDescent].every(number=>number===0);
    } catch {return false;}
  }
  function noteText(ctx,[value,x,y,maxWidth],stroke=false) {
    if(nativeTextNoPaint(ctx,[value,x,y,maxWidth],stroke))return;
    const d=state(ctx.canvas);d.revision=++revision;
    if (!ctx.globalAlpha || value==='') return;
    if (transparentStyle(stroke?ctx.strokeStyle:ctx.fillStyle)) {
      if(ctx.shadowColor&&!transparentStyle(ctx.shadowColor))issue(d,'画布文字仅通过阴影绘制，无法确认正文');
      return;
    }
    if (!usableContext(ctx,d)) return;
    if (typeof value!=='string' || /[\p{Co}\uFFFD\u202A-\u202E\u2066-\u2069]/u.test(value)) {
      issue(d,'画布文字使用了不能直接还原的字形编码');return;
    }
    const direction=ctx.direction==='inherit'?(getComputedStyle(ctx.canvas).direction||'ltr'):(ctx.direction||'ltr');
    if (direction!=='ltr') {issue(d,'画布文字方向无法确认');return;}
    if (value.length > 30000 || d.entries.length >= limit) {issue(d,'画布文字超出读取上限');return;}
    const m=ctx.measureText(value);
    if (maxWidth !== undefined && Number(maxWidth) < m.width) {issue(d,'画布文字经过压缩绘制，无法确认位置');return;}
    const alignment=ctx.textAlign||'start';
    if(!['start','left','end','right','center'].includes(alignment)||!Number.isFinite(m.width)||m.width<0){
      textCoordinateIssue(ctx,d,value,x,y,m,stroke,
        !['start','left','end','right','center'].includes(alignment)?'alignment':'width');return;
    }
    const advanceX=Number(x)-(['end','right'].includes(alignment)?m.width:alignment==='center'?m.width/2:0);
    const advance=bounds(ctx,advanceX,0,advanceX+m.width,0);
    const matrix=ctx.getTransform(),baseline=Number(y)*matrix.d+matrix.f,textBaseline=ctx.textBaseline||'alphabetic';
    // Spaces have an advance but no ink box. Keep their original characters
    // using the same font's metrics instead of reconstructing their count.
    const whitespace=!value.trim();
    const metrics=whitespace?ctx.measureText('M'):m;
    const r=whitespace?bounds(ctx,advanceX,Number(y)-metrics.actualBoundingBoxAscent,
      advanceX+m.width,Number(y)+metrics.actualBoundingBoxDescent):
      bounds(ctx,Number(x)-m.actualBoundingBoxLeft,Number(y)-m.actualBoundingBoxAscent,
        Number(x)+m.actualBoundingBoxRight,Number(y)+m.actualBoundingBoxDescent);
    if (!finiteRect(r)) {
      if (value.trim()){
        const validTransform=[matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f].every(Number.isFinite)&&
          matrix.b===0&&matrix.c===0&&matrix.a>0&&matrix.d>0;
        const validMetrics=[metrics.actualBoundingBoxLeft,metrics.actualBoundingBoxRight,
          metrics.actualBoundingBoxAscent,metrics.actualBoundingBoxDescent].every(Number.isFinite);
        textCoordinateIssue(ctx,d,value,x,y,metrics,stroke,
          !validTransform?'transform':!validMetrics?'ink-metrics':'ink-bounds');
      }
      return;
    }
    const clipped=clipBounds(ctx,r);
    if(!clipped)return;
    if(!contains(clipped,r)||!clipContains(ctx,r)){issue(d,'画布裁剪区域截断了文字',r);return;}
    if (!intersects(fullRect(d),r)) return;
    if(d.separators.some(separator=>intersects(separator,r))){issue(d,'画布文字与分隔线重叠，无法确认正文',r);return;}
    if(!advance||!Number.isFinite(baseline)){
      textCoordinateIssue(ctx,d,value,x,y,m,stroke,!advance?'advance':'baseline');return;
    }
    const fontMatch=typeof ctx.font==='string'?ctx.font.match(/(?:^|\s)(\d*\.?\d+)px(?:\/[^\s]+)?(?=\s|$)/i):null;
    const fontSize=fontMatch?Number(fontMatch[1])*matrix.d:null;
    const glyphDraw=!stroke&&ctx.globalAlpha===1&&!whitespace&&[...value].length===1&&
      !/[\p{M}\p{C}]/u.test(value)&&['start','left'].includes(alignment)&&typeof ctx.font==='string'&&ctx.font&&
      (!ctx.shadowColor||transparentStyle(ctx.shadowColor))?{
        x:Number(x),y:Number(y),width:m.width,scaleX:matrix.a,scaleY:matrix.d,translateX:matrix.e,translateY:matrix.f,
        style:JSON.stringify([ctx.font,textBaseline,alignment,ctx.fontKerning,ctx.fontStretch,ctx.fontVariantCaps,
          ctx.letterSpacing,ctx.wordSpacing,ctx.textRendering]),
      }:null;
    let raster=null;
    // A short draw can contain a visible glyph plus a combining mark,
    if(!stroke&&!whitespace&&[...value].length<=2&&!/[\p{M}\p{C}]/u.test(value)&&
        !/\s/u.test(value.replace(/ /g,''))&&
        typeof ctx.font==='string'&&(!ctx.shadowColor||transparentStyle(ctx.shadowColor))){
      let lang=ctx.lang;
      if(!lang||lang==='inherit')lang=ctx.canvas.closest?.('[lang]')?.getAttribute('lang')||document.documentElement?.lang||'';
      raster={text:value,x:Number(x),y:Number(y),font:ctx.font,textAlign:alignment,textBaseline,direction,lang,
        transform:{a:matrix.a,b:matrix.b,c:matrix.c,d:matrix.d,e:matrix.e,f:matrix.f},
        metrics:{width:m.width,actualBoundingBoxLeft:m.actualBoundingBoxLeft,actualBoundingBoxRight:m.actualBoundingBoxRight,
          actualBoundingBoxAscent:m.actualBoundingBoxAscent,actualBoundingBoxDescent:m.actualBoundingBoxDescent},
        baseline,advanceLeft:advance.left,advanceRight:advance.right,globalAlpha:ctx.globalAlpha,
        contextAttributes:ctx.getContextAttributes?.()};
      for(const key of ['fontKerning','fontStretch','fontVariantCaps','letterSpacing','wordSpacing','textRendering'])
        if(typeof ctx[key]==='string')raster[key]=ctx[key];
    }
    // Advances describe layout, not painted pixels. Independently positioned
    // glyphs can have overlapping advances after rounding or run-level kerning
    // while their ink remains completely separate. Accept this only on the same
    // baseline and when advance and ink order agree. Both overlapping normally
    // remain an error; the narrow single-glyph quantization case below additionally
    // requires the observed draw step to match the measured fractional advance.
    const layout={advanceLeft:advance.left,advanceRight:advance.right,baseline,textBaseline,scaleX:matrix.a,scaleY:matrix.d};
    // Cached and boundary fragments carry the same original layout/glyph
    // evidence as complete text. Their ink boxes alone do not prove overlap.
    const fragments=[...d.copyFragments,...d.issues.filter(item=>item.fragment).map(item=>item.fragment)];
    const candidates=[...d.entries.map(entry=>({entry})),...fragments];
    const style=copyStyle(ctx);
    const repaintKey=!stroke&&ctx.globalAlpha===1&&opaqueStyle(ctx.fillStyle)&&(!ctx.shadowColor||transparentStyle(ctx.shadowColor))?
      JSON.stringify([value,x,y,maxWidth??null,style,matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f,
        r.left,r.top,r.right,r.bottom,advance.left,advance.right,baseline]):null;
    const old=d.entries.find(entry=>entry.text===value&&equalRect(entry,r));
    if(old){
      // Identical text bounds do not prove identical painted pixels: a font,
      // shadow, stroke or fractional-position change can add new ink. Preserve
      // the existing text deduplication, but never reuse its old mask/repair
      // evidence unless the complete original opaque fill is exactly repeated.
      if(!repaintKey||old.repaintKey!==repaintKey){
        old.raster=null;old.glyphDraw=null;old.repaintKey=null;old.highlightTextStyle=null;
      }else {old.paintSerial=d.pixelSerial;old.textOpaque=true;}
      old.backgroundProof=null;
      return;
    }
    const fillTextStyle=highlightTextStyle(ctx);
    const highlightEntry={...r,...layout,glyphDraw,raster,repaintKey,highlightTextStyle:fillTextStyle};
    const predecessor=highlightPredecessor(ctx,d,highlightEntry);
    if(predecessor)candidates.push({entry:predecessor.entry});
    let rasterCheck=null;
    const conflictCandidate=candidates.find(({entry,coverage})=>{
      rasterCheck=null;
      if(coverage){
        if(!coverage.some(part=>intersects(r,part)))return false;
        if(entry.text===value&&entry.copyStyle===style&&equalRect(entry,r)&&entry.baseline===baseline)return false;
      }
      const logicalOverlap=intersects({left:entry.advanceLeft,right:entry.advanceRight,top:entry.top,bottom:entry.bottom},
        {left:advance.left,right:advance.right,top:r.top,bottom:r.bottom});
      if(!logicalOverlap&&!intersects(entry,r))return false;
      const sameLine=entry.textBaseline===textBaseline&&Math.abs(entry.baseline-baseline)<0.1;
      if(!sameLine)return true;
      // This only absorbs double-precision arithmetic error at an intended
      // shared endpoint (for example 0.1 + 0.2 versus 0.3), never raster pixels.
      const epsilon=Number.EPSILON*8*Math.max(1,Math.abs(entry.advanceLeft),Math.abs(entry.advanceRight),
        Math.abs(advance.left),Math.abs(advance.right));
      if(entry.advanceRight<=advance.left+epsilon||advance.right<=entry.advanceLeft+epsilon)return false;
      const orderedSeparateInk=(entry.advanceLeft<advance.left&&entry.right<=r.left)||
        (advance.left<entry.advanceLeft&&r.right<=entry.left);
      if(orderedSeparateInk)return false;
      // Separately drawn spaces have advance but paint no pixels. Their font
      // metrics are only a layout placeholder, never evidence of ink covering
      // another glyph. Keep the exact original spaces in an ordered floor run.
      if((whitespace||entry.inkless)&&quantizedNeighbours(entry,layout))return false;
      // Bounding boxes also include empty pixels. Repaint only these two source
      // glyphs on an independent tiny canvas to resolve otherwise ambiguous
      // physical layout; this does not read or recognize the resume bitmap.
      const shortRun=[...entry.text].length>1||[...value].length>1;
      const replay=shortRun?glyphs?.compareRuns:glyphs?.compare;
      if(typeof replay==='function'&&entry.raster&&raster){
        const verification=replay(entry.raster,raster);
        if(verification.ok&&verification.separate)return false;
        if(!shortRun&&verification.ok&&verification.edgeOnly&&quantizedNeighbours(entry,layout))return false;
        rasterCheck=verification;
        // Do not replace either confirmed coverage or an unavailable pixel
        // check with the older geometry-only guess.
        return true;
      }
      // Some renderers advance individual glyphs by floor(measureText.width).
      // Recognize that exact layout relation, not an arbitrary one-pixel overlap:
      // identical font/layout/transform, individual fill glyphs, integer step,
      // genuinely fractional preceding advance, and only a narrow ink edge.
      const previous=entry.glyphDraw;
      if(!previous||!glyphDraw||previous.style!==glyphDraw.style||
        ['scaleX','scaleY','translateX','translateY'].some(key=>previous[key]!==glyphDraw[key]))return true;
      const localEpsilon=Number.EPSILON*8*Math.max(1,Math.abs(previous.x),Math.abs(glyphDraw.x),
        Math.abs(previous.y),Math.abs(glyphDraw.y),previous.width,glyphDraw.width);
      if(Math.abs(previous.y-glyphDraw.y)>localEpsilon)return true;
      const before=previous.x<glyphDraw.x?{draw:previous,ink:entry}:{draw:glyphDraw,ink:r};
      const after=previous.x<glyphDraw.x?{draw:glyphDraw,ink:r}:{draw:previous,ink:entry};
      const step=after.draw.x-before.draw.x,integerAdvance=Math.floor(before.draw.width);
      const fraction=before.draw.width-integerAdvance;
      if(integerAdvance<=0||fraction<=localEpsilon||fraction>=1-localEpsilon||
        Math.abs(step-integerAdvance)>localEpsilon)return true;
      if(before.ink.left>=after.ink.left||before.ink.right>=after.ink.right)return true;
      const inkOverlap=(before.ink.right-after.ink.left)/matrix.a;
      const smallerInk=Math.min(before.ink.right-before.ink.left,after.ink.right-after.ink.left)/matrix.a;
      return !(inkOverlap>0&&inkOverlap<=1+localEpsilon&&inkOverlap*2<smallerInk-localEpsilon);
    });
    const conflict=conflictCandidate?.entry;
    if(conflict){
      if(rasterCheck)issueDetail(d,{kind:'glyph-check',reason:rasterCheck.reason,
        ok:rasterCheck.ok===true,separate:rasterCheck.separate===true,edgeOnly:rasterCheck.edgeOnly===true,
        sharedPixels:rasterCheck.sharedPixels,firstPixels:rasterCheck.firstPixels,secondPixels:rasterCheck.secondPixels,
        sharedCorePixels:rasterCheck.sharedCorePixels,firstCorePixels:rasterCheck.firstCorePixels,secondCorePixels:rasterCheck.secondCorePixels,
        maxSharedMinAlpha:rasterCheck.maxSharedMinAlpha});
      issueDetail(d,{kind:'text-overlap',
        advanceOverlap:Math.max(0,Math.min(conflict.advanceRight,advance.right)-Math.max(conflict.advanceLeft,advance.left)),
        inkOverlapX:Math.max(0,Math.min(conflict.right,r.right)-Math.max(conflict.left,r.left)),
        inkOverlapY:Math.max(0,Math.min(conflict.bottom,r.bottom)-Math.max(conflict.top,r.top)),
        baselineDelta:Math.abs(conflict.baseline-baseline),
        previousWidth:conflict.advanceRight-conflict.advanceLeft,currentWidth:advance.right-advance.left,
        previousInkWidth:conflict.right-conflict.left,currentInkWidth:r.right-r.left,
        previousLength:conflict.text.length,currentLength:value.length,scaleX:matrix.a,scaleY:matrix.d});
      issue(d,'画布文字重叠，无法确认正文顺序',r);return;
    }
    const space=ctx.measureText(' ').width*matrix.a;
    const entry={...r,text:value,...layout,inkless:whitespace,glyphDraw,raster,copyStyle:style,sourceLineage:[],
      paintSerial:d.pixelSerial,textOpaque:Boolean(repaintKey),
      repaintKey,highlightTextStyle:fillTextStyle,
      fontSize:Number.isFinite(fontSize)&&fontSize>0?fontSize:null,
      space:Number.isFinite(space)&&space>0?space:Math.max(1,(r.bottom-r.top)/3)};
    if(!contains(fullRect(d),r)){
      const verticalOnly=['top','hanging','middle','alphabetic','ideographic','bottom'].includes(textBaseline)&&
        r.left>=0&&r.right<=d.width&&((r.top<0&&r.bottom<=d.height)||(r.top>=0&&r.bottom>d.height));
      // Keep full provenance privately, but never emit a partially visible word.
      // Cache-seam recovery still requires complete, matching painted coverage.
      issue(d,'画布边界截断了文字',intersectRect(fullRect(d),r),
        {boundary:{...r,baseline,textBaseline,textLength:value.length,verticalOnly},
          fragment:{entry,coverage:[intersectRect(fullRect(d),r)]}});return;
    }
    // An exact opaque redraw restores this specific original text after a
    // partial background/clear. Other words, styles, positions and cached or
    // otherwise unknown drawings cannot discharge that old coverage issue.
    if(entry.repaintKey)d.issues=d.issues.filter(item=>item.repaintKey!==entry.repaintKey);
    if(predecessor&&d.issues.includes(predecessor.issue)){
      // The original fringe was clipped by the next cell's background. Keep
      // its known source character, but never reuse its former complete mask
      // or paint credentials for a second coverage/repaint decision.
      d.issues=d.issues.filter(item=>item!==predecessor.issue);
      d.entries.push({...predecessor.entry,raster:null,glyphDraw:null,repaintKey:null,backgroundProof:null,highlightTextStyle:null});
    }
    const paint=d.activeHighlight;
    if(highlightCell(paint,entry)&&paint.transform===transformKey(ctx))
      entry.backgroundProof={rect:paint.rect,fillStyle:paint.fillStyle,transform:paint.transform,serial:d.pixelSerial};
    d.entries.push(entry);
  }
  function coverEntries(ctx,d,r,covered,operation,paint=null){
    d.entries=d.entries.filter(entry=>{
      if(!intersects(r,entry))return true;
      if(paint)paint.touchedEntries++;
      if(covered(entry))return false;
      const verification=entry.inkless?{ok:true,separate:true,coveredPixels:0,coveredCorePixels:0}:
        entry.raster?glyphs?.coverage?.(entry.raster,r):null;
      if(verification?.ok===true&&verification.separate===true&&verification.coveredPixels===0&&verification.coveredCorePixels===0)return true;
      const clipContained=clipContains(ctx,entry);
      const proof=entry.backgroundProof;
      const sourceTransform=entry.raster?.transform;
      const sameSourceTransform=Boolean(sourceTransform&&paint?.transform===JSON.stringify([
        sourceTransform.a,sourceTransform.b,sourceTransform.c,sourceTransform.d,sourceTransform.e,sourceTransform.f]));
      const highlightCandidate=Boolean(paint&&sameSourceTransform&&
        entry.repaintKey&&entry.glyphDraw&&entry.raster&&entry.sourceLineage?.length===0&&clipContained&&
        verification?.ok===true&&verification.rightEdgeOnly===true&&verification.edgeCoreAdjacent===true&&
        verification.coveredPixels>0&&verification.coveredCorePixels===0&&verification.corePixels>0&&
        verification.maxCoveredAlpha>0&&verification.maxCoveredAlpha<128&&verification.coveredLeft>=r.left);
      // Only a tiny, non-core fringe may be preserved immediately when the
      // next logical text cell is painted after its source glyph. The final
      // touched-entry count is checked after scanning the whole canvas, so a
      // background that also erases an already-drawn next character cannot
      // pass through this exception.
      const directFringe=Boolean(highlightCandidate&&context(ctx).clipShapes.length===0&&
        layoutEqual(r.left,entry.advanceRight)&&
        layoutEqual(r.right-r.left,entry.advanceRight-entry.advanceLeft)&&
        r.top<=entry.top&&r.bottom>=entry.bottom&&
        verification.pixels>=50&&verification.corePixels>=30&&
        verification.coveredPixels<=2&&verification.coveredPixels*50<=verification.pixels&&
        verification.maxCoveredAlpha<=32);
      const detail={kind:'text-cover',operation,left:entry.left,top:entry.top,right:entry.right,bottom:entry.bottom,
        coverLeft:r.left,coverTop:r.top,coverRight:r.right,coverBottom:r.bottom,textLength:entry.text.length,
        clipCount:context(ctx).clipShapes.length,contained:contains(r,entry),clipContained,
        advanceLeft:entry.advanceLeft,advanceRight:entry.advanceRight,baseline:entry.baseline,highlightCandidate,
        priorHighlightCell:Boolean(proof),highlightContinuity:Boolean(proof&&proof.serial===d.pixelSerial-1),
        verification:verification?.ok===true?'ink-hit':'unavailable',
        ...(verification?.ok===true?Object.fromEntries(['coveredPixels','coveredCorePixels','pixels','corePixels','maxCoveredAlpha',
          'rightEdgeOnly','edgeCoreAdjacent','coveredLeft','coveredTop','coveredRight','coveredBottom']
          .filter(key=>verification[key]!==undefined).map(key=>[key,verification[key]])):{})};
      const existingCause=d.issues.some(item=>item.message==='画布文字被局部覆盖'&&
        item.repaintKey===entry.repaintKey&&item.rect&&
        ['left','top','right','bottom'].every(key=>item.rect[key]===entry[key]));
      issue(d,'画布文字被局部覆盖',entry,{cover:detail,
        ...(entry.repaintKey&&Array.isArray(entry.sourceLineage)&&entry.sourceLineage.length===0?{repaintKey:entry.repaintKey}:{})});
      if(highlightCandidate&&!existingCause){
        const cause=d.issues.find(item=>item.message==='画布文字被局部覆盖'&&item.repaintKey===entry.repaintKey&&
          item.rect&&['left','top','right','bottom'].every(key=>item.rect[key]===entry[key]));
        if(cause){
          paint.partials.push({entry,issue:cause,verification});
          if(directFringe)paint.directFringes.push({entry,issue:cause});
        }
      }
      return false;
    });
  }
  function erase(ctx,[x,y,width,height],opaque=true,operation='clearRect',paint=null) {
    const d=state(ctx.canvas);d.revision=++revision;
    if (!opaque) return;
    let r=bounds(ctx,Math.min(x,x+width),Math.min(y,y+height),Math.max(x,x+width),Math.max(y,y+height));
    if (!finiteRect(r)) {issue(d,'画布清除区域无法确认');return;}
    if (context(ctx).clipped) {issue(d,'画布使用了不能确认的裁剪区域');return;}
    if(paint&&(!contains(fullRect(d),r)||!clipContains(ctx,r)))paint=null;
    r=clipBounds(ctx,r);if(!r)return;
    if (contains(r,fullRect(d))&&clipContains(ctx,fullRect(d))) {reset(ctx.canvas);return;}
    if(paint)paint.rect=r;
    coverEntries(ctx,d,r,rect=>contains(r,rect)&&clipContains(ctx,rect),operation,paint);
    const direct=paint?.touchedEntries===1&&paint.directFringes.length===1&&
      !d.copyFragments.some(fragment=>fragment.coverage.some(part=>intersects(part,r)))?
      paint.directFringes[0]:null;
    eraseCopyFragments(d,r,rect=>contains(r,rect)&&clipContains(ctx,rect));
    // Keep partly erased separators conservatively; only a fully covered
    // stroke is known to be absent from the bitmap.
    d.separators=d.separators.filter(separator=>!contains(r,separator)||!clipContains(ctx,separator));
    d.issues=d.issues.filter(item=>!item.rect||!contains(r,item.rect)||!clipContains(ctx,item.rect))
      .map(item=>item.fragment&&intersects(r,item.rect)?{...item,fragment:null}:item);
    d.images=d.images.filter(item=>!contains(r,item.rect)||!clipContains(ctx,item.rect))
      .map(item=>intersects(r,item.rect)?{...item,fullPaint:false,decorationPaint:false,paintIntact:false}:item);
    d.backgrounds=d.backgrounds.filter(shape=>!contains(r,shape.bounds)||!clipContains(ctx,shape.bounds));
    if(direct&&d.issues.includes(direct.issue)){
      d.issues=d.issues.filter(item=>item!==direct.issue);
      d.entries.push({...direct.entry,raster:null,glyphDraw:null,repaintKey:null,
        backgroundProof:null,highlightTextStyle:null});
      paint.partials=paint.partials.filter(item=>item.issue!==direct.issue);
    }
    if(paint)d.pendingHighlight=paint;
  }
  const opaqueStyle = style => typeof style==='string' &&
    (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(style)||/^rgb\([^/]*\)$/i.test(style)||/^rgba\([^,]+,[^,]+,[^,]+,\s*1(?:\.0*)?\s*\)$/i.test(style));
  function fillRect(ctx,args) {
    const d=state(ctx.canvas);
    if (!ctx.globalAlpha) return;
    if (ctx.filter&&ctx.filter!=='none') {issue(d,'画布使用了不能确认的绘制滤镜');return;}
    if(ctx.shadowColor&&!transparentStyle(ctx.shadowColor)){
      issue(d,'画布文字被不能确认的背景覆盖');return;
    }
    if(typeof ctx.fillStyle!=='string'){
      const [x,y,w,h]=args,rect=bounds(ctx,Math.min(x,x+w),Math.min(y,y+h),Math.max(x,x+w),Math.max(y,y+h));
      issue(d,'画布使用了不能确认的图案填充',rect);return;
    }
    if (ctx.globalAlpha===1&&opaqueStyle(ctx.fillStyle)&&(!ctx.globalCompositeOperation||ctx.globalCompositeOperation==='source-over')) {
      const paint=d.pixelOperation==='fillRect'?{fillStyle:ctx.fillStyle,transform:transformKey(ctx),partials:[],
        directFringes:[],touchedEntries:0}:null;
      erase(ctx,args,true,'fillRect',paint);return;
    }
    if(context(ctx).clipped){issue(d,'画布使用了不能确认的裁剪区域');return;}
    const [x,y,w,h]=args,raw=bounds(ctx,Math.min(x,x+w),Math.min(y,y+h),Math.max(x,x+w),Math.max(y,y+h));
    const r=raw&&clipBounds(ctx,raw);if(raw&&!r)return;
    if (!r||d.entries.some(e=>intersects(e,r))||d.copyFragments.some(f=>f.coverage.some(p=>intersects(p,r)))||
      d.issues.some(item=>item.fragment&&intersects(item.rect,r))) issue(d,'画布文字被不能确认的背景覆盖',r);
    d.revision=++revision;
  }
  function image(ctx,args) {
    const d=state(ctx.canvas);d.revision=++revision;
    if (!ctx.globalAlpha) return;
    if (!usableContext(ctx,d)) return;
    if(ctx.shadowColor&&!transparentStyle(ctx.shadowColor)&&(ctx.shadowBlur||ctx.shadowOffsetX||ctx.shadowOffsetY)){
      issue(d,'画布图片阴影范围无法确认');return;
    }
    const source=args[0];
    const sourceCanvas=drawings.has(source)||
      (typeof globalThis.HTMLCanvasElement==='function'&&source instanceof globalThis.HTMLCanvasElement)||
      (typeof globalThis.OffscreenCanvas==='function'&&source instanceof globalThis.OffscreenCanvas);
    const [x,y,w,h]=(args.length===9?args.slice(5):args.length===5?args.slice(1):
      [args[1],args[2],source?.naturalWidth||source?.width,source?.naturalHeight||source?.height]).map(Number);
    let r=bounds(ctx,Math.min(x,x+w),Math.min(y,y+h),Math.max(x,x+w),Math.max(y,y+h));
    if (!finiteRect(r)) {issue(d,'画布图片区域无法确认');return;}
    const paintedRect=r;
    r=clipBounds(ctx,r);if(!r)return;
    if (!intersects(r,fullRect(d))) return;
    // Classify platform decorations only after their surrounding text has
    // been drawn. Source dimensions alone do not establish a decorative role.
    const sourceWidth=Number(source?.naturalWidth||source?.width),sourceHeight=Number(source?.naturalHeight||source?.height);
    const [sx,sy,sw,sh]=args.length===9?args.slice(1,5).map(Number):[0,0,sourceWidth,sourceHeight];
    const sourceRect={left:sx,top:sy,right:sx+sw,bottom:sy+sh};
    const validSource=finiteRect(sourceRect)&&contains({left:0,top:0,right:sourceWidth,bottom:sourceHeight},sourceRect);
    const fullSource=validSource&&sx===0&&sy===0&&sw===sourceWidth&&sh===sourceHeight;
    if(drawings.has(source)&&canvasContexts.has(source)&&validSource&&w>0&&h>0&&ctx.globalAlpha===1&&
      context(ctx).clipShapes.every(shape=>shape.kind==='rect')&&
      (!ctx.shadowColor||transparentStyle(ctx.shadowColor))){
      if(copyCanvas(ctx,d,source,sourceRect,{x,y,w,h}))return;
    }
    if(d.images.length>=2048){d.overflow=true;d.overflowReason='画布含无法确认是否属于正文的图片，不能完整读取原文';return;}
    const paintBoundsComplete=contains(r,paintedRect)&&contains(fullRect(d),paintedRect);
    const clipContained=clipContains(ctx,paintedRect),frameClipConfirmed=decorationClipContains(ctx,paintedRect);
    const paintOpaque=ctx.globalAlpha===1,paintForward=w>0&&h>0;
    d.images.push({rect:r,sourceWidth,sourceHeight,sourceRect,validSource,fullSource,sourceCanvas,
      paintSerial:d.pixelSerial,
      paintIdentity:{},sourceLineage:[],hintId:nextHintId++,
      hintAsset:sourceWidth===32&&sourceHeight===32?window.__hrmCanvasPlatformAssets?.match?.(source)||'':'',
      paintedRect,paintBoundsComplete,clipContained,frameClipConfirmed,paintOpaque,paintForward,paintIntact:true,cacheComplete:true,
      fullPaint:paintBoundsComplete&&clipContained&&paintForward&&paintOpaque,
      decorationPaint:paintBoundsComplete&&frameClipConfirmed&&paintForward&&paintOpaque,
      clipShapes:[...context(ctx).clipShapes]});
  }

  function eraseCopyFragments(d,r,covered){
    d.copyFragments=d.copyFragments.filter(fragment=>{
      if(!fragment.coverage.some(part=>intersects(r,part)))return true;
      if(!fragment.coverage.every(covered))issue(d,'画布文字被局部覆盖',fragment.entry);
      return false;
    });
  }
  const sameCopyEntry=(a,b)=>a.text===b.text&&a.copyStyle===b.copyStyle&&a.textBaseline===b.textBaseline&&
    ['left','top','right','bottom','baseline','advanceLeft','advanceRight','scaleX','scaleY'].every(key=>
      Math.abs(a[key]-b[key])<=Number.EPSILON*32*Math.max(1,Math.abs(a[key]),Math.abs(b[key])));
  function fullyCoveredBy(r,parts){
    const xs=[...new Set([r.left,r.right,...parts.flatMap(p=>[p.left,p.right])])].sort((a,b)=>a-b);
    for(let i=1;i<xs.length;i++){
      if(xs[i]<=r.left||xs[i-1]>=r.right)continue;
      const bands=parts.filter(p=>p.left<=xs[i-1]&&p.right>=xs[i]).sort((a,b)=>a.top-b.top);
      let bottom=r.top;
      for(const band of bands){if(band.top>bottom)break;bottom=Math.max(bottom,band.bottom);}
      if(bottom<r.bottom)return false;
    }
    return true;
  }
  function addCopyFragment(d,entry,coverage){
    if(!coverage.length)return;
    const existing=d.copyFragments.find(fragment=>sameCopyEntry(fragment.entry,entry));
    if(existing){
      // A recovered glyph can depend on multiple cache tiles. Retain every
      // tile's copy-time version; the last fragment alone is not its origin.
      let lineage=null;
      if(Array.isArray(existing.entry.sourceLineage)&&Array.isArray(entry.sourceLineage)){
        const versions=new Map();let valid=true;
        for(const item of [...existing.entry.sourceLineage,...entry.sourceLineage]){
          if(versions.has(item.state)&&versions.get(item.state)!==item.revision){valid=false;break;}
          versions.set(item.state,item.revision);
        }
        if(valid&&versions.size<=12)lineage=[...versions].map(([state,revision])=>({state,revision}));
      }
      entry={...entry,sourceLineage:lineage};
    }
    const parts=[...(existing?.coverage||[]),...coverage];
    if(parts.length>64||d.entries.length+d.copyFragments.length>=limit){issue(d,'画布文字超出读取上限');return;}
    if(fullyCoveredBy(entry,parts)){
      if(existing)d.copyFragments=d.copyFragments.filter(fragment=>fragment!==existing);
      d.entries.push(entry);
    }else if(existing){existing.coverage=parts;existing.entry=entry;}
    else d.copyFragments.push({entry,coverage:parts});
  }
  function copyFragmentIssues(d){
    return d.copyFragments.map(({entry:e,coverage})=>{
      const r={left:Math.min(...coverage.map(p=>p.left)),top:Math.min(...coverage.map(p=>p.top)),
        right:Math.max(...coverage.map(p=>p.right)),bottom:Math.max(...coverage.map(p=>p.bottom))};
      const visible=intersectRect(fullRect(d),e);
      const verticalOnly=e.left>=0&&e.right<=d.width&&((e.top<0&&e.bottom<=d.height)||(e.top>=0&&e.bottom>d.height))&&
        fullyCoveredBy(visible,coverage);
      return {message:verticalOnly?'画布边界截断了文字':'缓存画布裁剪截断了文字，不能完整读取原文',rect:r,
        boundary:{left:e.left,top:e.top,right:e.right,bottom:e.bottom,baseline:e.baseline,textBaseline:e.textBaseline,
          textLength:e.text.length,verticalOnly}};
    });
  }
  function imageTouchesRecordedText(d,item){
    const rect=item.rect;
    for(const entry of d.entries){
      if(entry.inkless||!intersects(rect,entry))continue;
      // A later, fully witnessed opaque text fill is visibly in front of the
      // image. For earlier text, only an independent zero-ink pixel check can
      // resolve a bounding-box overlap; unknown glyph coverage stays blocked.
      if(entry.textOpaque===true&&entry.paintSerial>item.paintSerial)continue;
      if(entry.raster&&!entry.sourceLineage?.length){
        const coverage=glyphs?.coverage?.(entry.raster,rect);
        if(coverage?.ok===true&&coverage.coveredPixels===0)continue;
      }
      return true;
    }
    if(d.copyFragments.some(fragment=>fragment.coverage.some(part=>intersects(rect,part))))return true;
    return d.issues.some(issue=>issue.fragment?.coverage?.some(part=>intersects(rect,part)));
  }
  function copyCanvas(ctx,d,source,sourceRect,{x,y,w,h}){
    const original=state(source);
    const matrix=ctx.getTransform(),sx=matrix.a*w/(sourceRect.right-sourceRect.left),sy=matrix.d*h/(sourceRect.bottom-sourceRect.top);
    const tx=matrix.a*x+matrix.e-sourceRect.left*sx,ty=matrix.d*y+matrix.f-sourceRect.top*sy;
    if(![sx,sy,tx,ty].every(Number.isFinite)||sx<=0||sy<=0)return false;
    const mapRect=r=>({left:r.left*sx+tx,top:r.top*sy+ty,right:r.right*sx+tx,bottom:r.bottom*sy+ty});
    const target=clipBounds(ctx,mapRect(sourceRect)),scope=target&&intersectRect(fullRect(d),target);
    if(!finiteRect(scope))return true;
    if(!original.baseline){issue(d,'来源画布未从完整重绘开始记录，无法确认缓存原文',scope);return true;}
    if(original.overflow){issue(d,original.overflowReason||'来源画布记录超出上限，无法确认缓存原文',scope);return true;}
    if(source===ctx.canvas&&sx===1&&sy===1&&tx===0&&ty===0)return true;
    // Freeze provenance before mutating the destination (also supports a
    // non-overlapping self-copy). Never infer opaque coverage from UI shapes.
    const src={entries:[...original.entries],issues:[...original.issues],images:[...original.images],
      backgrounds:[...original.backgrounds],separators:[...original.separators],
      fragments:original.copyFragments.map(f=>({entry:{...f.entry},coverage:f.coverage.map(p=>({...p}))})),
      marks:[...(window.__hrmExpandMarks?.read?.(source)||[]),...original.copyMarks]};
    if(d.entries.some(e=>intersects(scope,e))||d.images.some(item=>intersects(scope,item.rect))||
      d.separators.some(r=>intersects(scope,r))||d.copyFragments.some(f=>f.coverage.some(r=>intersects(scope,r)))){
      issue(d,'画布缓存绘制覆盖已有内容，无法确认原文',scope);return true;
    }
    const mapShape=shape=>{
      const mapped={...shape,bounds:mapRect(shape.bounds)};
      if(shape.radii)mapped.radii=shape.radii.map(r=>({x:r.x*sx,y:r.y*sy}));
      if(shape.kind==='ellipse')Object.assign(mapped,{cx:shape.cx*sx+tx,cy:shape.cy*sy+ty,rx:shape.rx*sx,ry:shape.ry*sy});
      if(shape.paintClipRect)mapped.paintClipRect=mapRect(shape.paintClipRect);
      if(shape.paintClips)mapped.paintClips=shape.paintClips.map(mapShape);
      return mapped;
    };
    // Keep copy-time versions, not live bitmap references. A later copy from a
    // changed source cannot inherit the earlier education context. Cap chains;
    // deeper copies remain readable but cannot reuse a historical image role.
    const lineage=item=>Array.isArray(item.sourceLineage)&&item.sourceLineage.length<12?
      [...item.sourceLineage,{state:original,revision:original.revision}]:null;
    const mapEntry=e=>({...e,...mapRect(e),sourceLineage:lineage(e),baseline:e.baseline*sy+ty,advanceLeft:e.advanceLeft*sx+tx,
      advanceRight:e.advanceRight*sx+tx,scaleX:e.scaleX*sx,scaleY:e.scaleY*sy,space:e.space*sx,
      fontSize:e.fontSize?e.fontSize*sy:null,glyphDraw:null,raster:null,repaintKey:null,backgroundProof:null,
      highlightTextStyle:null,paintSerial:d.pixelSerial,textOpaque:e.textOpaque===true});
    const copyFragment=(entry,parts)=>{
      const mapped=mapEntry(entry),coverage=parts.map(mapRect).map(p=>intersectRect(scope,p)).filter(finiteRect);
      addCopyFragment(d,mapped,coverage);
    };
    // Geometry from an older target background must not survive an unknown
    // transparent/opaque replacement as evidence for a decorative UI role.
    d.backgrounds=d.backgrounds.filter(shape=>!intersects(scope,shape.bounds));
    for(const entry of src.entries)copyFragment(entry,[entry]);
    for(const fragment of src.fragments)copyFragment(fragment.entry,fragment.coverage);
    for(const item of src.issues){
      if(item.fragment){copyFragment(item.fragment.entry,item.fragment.coverage);continue;}
      const r=item.rect?intersectRect(scope,mapRect(item.rect)):scope;
      if(finiteRect(r))issue(d,item.message,r);
    }
    for(const item of src.images){
      const mapped=mapRect(item.rect),r=intersectRect(scope,mapped);if(!finiteRect(r))continue;
      if(d.images.length>=2048){issue(d,'画布图片记录超出上限');break;}
      const complete=contains(scope,mapped);
      d.images.push({...item,rect:r,sourceLineage:lineage(item),paintedRect:mapRect(item.paintedRect),
        paintSerial:d.pixelSerial,fullSource:item.fullSource&&complete,
        fullPaint:item.fullPaint&&complete,decorationPaint:item.decorationPaint&&complete,cacheComplete:item.cacheComplete&&complete,
        clipShapes:[...item.clipShapes.map(mapShape),{kind:'rect',bounds:{...scope}}]});
    }
    for(const shape of src.backgrounds){
      const mapped={...mapShape(shape),sourceLineage:lineage(shape)};if(!intersects(scope,mapped.bounds))continue;
      if(d.backgrounds.length>=128)break;
      mapped.paintClipRect=mapped.paintClipRect?intersectRect(scope,mapped.paintClipRect):{...scope};
      d.backgrounds.push(mapped);
    }
    for(const r of src.separators){
      const mapped=intersectRect(scope,mapRect(r));if(!finiteRect(mapped))continue;
      if(d.separators.length>=512){issue(d,'画布分隔线超出读取上限');break;}
      d.separators.push(mapped);
    }
    for(const mark of src.marks){
      const px=mark.x*original.width*sx+tx,py=mark.y*original.height*sy+ty;
      if(px<scope.left||px>scope.right||py<scope.top||py>scope.bottom||d.copyMarks.length>=128)continue;
      d.copyMarks.push({id:'copy-'+nextCopyMark++,label:mark.label,x:px/d.width,y:py/d.height});
    }
    return true;
  }
  function educationScope(canvas,expectedName) {
    const session=window.__hrmBackgroundRead;
    if(!session||typeof session.token!=='string'||!session.token||session.canvas!==canvas||
      typeof expectedName!=='string'||!expectedName||session.expectedName!==expectedName){educationSession=null;return null;}
    if(!educationSession||educationSession.session!==session||educationSession.token!==session.token||
      educationSession.canvas!==canvas||educationSession.expectedName!==expectedName)
      educationSession={session,token:session.token,canvas,expectedName,proofs:new WeakMap(),count:0,headerProofs:new WeakMap(),headerCount:0};
    return educationSession;
  }
  function educationDecorations(d,lines,scope) {
    const ignored=new Set(),approvals=[],normalize=text=>String(text||'').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'');
    const entryBounds=entries=>({left:Math.min(...entries.map(e=>e.left)),top:Math.min(...entries.map(e=>e.top)),
      right:Math.max(...entries.map(e=>e.right)),bottom:Math.max(...entries.map(e=>e.bottom))});
    const relative=(rect,image)=>({left:(rect.left-image.left)/(image.right-image.left),
      right:(rect.right-image.left)/(image.right-image.left),top:(rect.top-image.top)/(image.bottom-image.top),
      bottom:(rect.bottom-image.top)/(image.bottom-image.top)});
    const sameLineage=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
      a.every((item,index)=>item.state===b[index].state&&item.revision===b[index].revision);
    const dependencies=items=>{
      const versions=new Map();
      for(const item of items){
        if(!Array.isArray(item.sourceLineage))return null;
        const lineage=item.sourceLineage.length?item.sourceLineage:[{state:d,revision:d.revision}];
        for(const entry of lineage){
          if(versions.has(entry.state)&&versions.get(entry.state)!==entry.revision)return null;
          versions.set(entry.state,entry.revision);
        }
      }
      return [...versions].map(([state,revision])=>({state,revision}));
    };
    d.details=d.details.filter(item=>item.kind!=='education-check');
    // Section labels occupy the left gutter, often on the very same baseline
    // as the first school. Never match the label as a substring of body prose.
    const sections=new Set(['个人优势','个人简介','期望职位','工作经历','工作经验','项目经历','项目经验',
      '教育经历','教育背景','资格证书','专业技能','所获荣誉','荣誉奖项','获奖经历','语言能力','培训经历','社团经历','自我评价']);
    // A study form is part of the title, after its degree. Accept only these
    // explicit suffixes; keep them in the original text and in the proof key.
    const school=/^[\p{L}\p{N}·()\-]{2,60}(?:大学|学院|学校|研究院|研究所|党校|中学|职校)[\p{L}\p{N}·()&+\/-]{1,40}(?:博士后|博士|硕士|MBA|EMBA|本科|大专|中专|高中|初中)(?:·(?:非全日制|全日制))?$/u;
    const dates=/^((?:19|20|21)\d{2})(?:[./](0?[1-9]|1[0-2]))?[-—–~～至]((?:19|20|21)\d{2})(?:[./](0?[1-9]|1[0-2]))?$|^((?:19|20|21)\d{2})(?:[./](0?[1-9]|1[0-2]))?[-—–~～]至今$/;
    const validDates=text=>{
      const match=dates.exec(text);if(!match)return false;
      return Boolean(match[5])||Number(match[1])*12+Number(match[2]||1)<=Number(match[3])*12+Number(match[4]||12);
    };
    const checks=d.images.map(item=>{
      const r=item.rect,painted=item.paintedRect,w=r.right-r.left,h=r.bottom-r.top;
      const paintW=painted.right-painted.left,paintH=painted.bottom-painted.top;
      const previous=scope&&item.paintIdentity?scope.proofs.get(item.paintIdentity):null;
      const historySourceStable=Boolean(previous&&sameLineage(previous.imageLineage,item.sourceLineage)&&
        previous.dependencies.every(entry=>entry.state.revision===entry.revision));
      // Education is supplied by the recorded text, not the adjacent logo.
      // Use its layout slot only to distinguish the small school icon from
      // body images; no bitmap, crop or painting-integrity proof is required.
      const layout=painted,layoutH=paintH;
      const touched=d.entries.filter(entry=>intersects(entry,r));
      const candidates=[];
      let titleVerified=false,dateVerified=false,nearbyTitle=null;
      for(const line of lines){
        const entries=line.entries.filter(entry=>entry.left>=layout.right).sort((a,b)=>a.advanceLeft-b.advanceLeft);
        if(!entries.length)continue;
        const font=Math.max(...entries.map(entry=>entry.fontSize||entry.bottom-entry.top));
        if(line.bottom<layout.top-font*.5||line.top>layout.bottom+font*.5)continue;
        // Rows with a school badge sit near the crest's top; rows without one
        // are centered beside it. Use the row's ink center, not its descender,
        // for the upper-to-middle band, keeping the complete row in the box.
        const aligned=line.top>=layout.top-font*.5&&line.bottom<=layout.bottom&&
          (line.top+line.bottom)/2<=layout.top+layoutH*.6;
        // Require a separate right-hand date field. This works for complete
        // runs and per-character painting without treating arbitrary prose
        // containing a university name as a school title.
        for(let i=1;i<entries.length;i++){
          if(entries[i].advanceLeft-entries[i-1].advanceRight<font*2)continue;
          const title=normalize(entries.slice(0,i).map(entry=>entry.text).join('')).replace(/[|｜]/g,'');
          const date=normalize(entries.slice(i).map(entry=>entry.text).join(''));
          const titleOK=school.test(title),dateOK=validDates(date);
          titleVerified ||= titleOK;dateVerified ||= dateOK;
          if(titleOK&&dateOK){
            const candidate={line,entries,font,key:title+'\n'+date,left:entries[0].left,right:Math.max(...entries.map(entry=>entry.right))};
            if(!nearbyTitle||Math.abs((line.top+line.bottom)/2-(r.top+r.bottom)/2)<
              Math.abs((nearbyTitle.line.top+nearbyTitle.line.bottom)/2-(r.top+r.bottom)/2))nearbyTitle=candidate;
            if(aligned)candidates.push(candidate);
          }
        }
      }
      const title=candidates.length===1?candidates[0]:null,font=title?.font||h/4;
      const headings=lines.flatMap(line=>{
        if(line.top>(title?.line.bottom??r.top+h*.6))return [];
        const entries=line.entries.filter(entry=>entry.right<=r.left-font*.4);
        const label=normalize(entries.map(entry=>entry.text).join(''));
        if(!entries.length||!sections.has(label))return [];
        const end=Math.max(...entries.map(entry=>entry.advanceRight));
        // A per-character sentence may start with the section label and then
        // cross the gutter edge. Only a distinct column gap ends the label.
        if(line.entries.some(entry=>!entries.includes(entry)&&entry.advanceLeft<end+font*2))return [];
        return [{line,entries,label}];
      });
      const heading=headings.at(-1),localSection=Boolean(heading&&['教育经历','教育背景'].includes(heading.label));
      const titleBox=title?entryBounds(title.entries):null,titleLayout=titleBox?relative(titleBox,painted):null;
      const historyTitleMatched=Boolean(previous&&title&&previous.key===title.key&&
        ['left','top','right','bottom'].every(key=>Math.abs(previous.titleLayout[key]-titleLayout[key])<1e-6));
      const historyHeadingAbove=Boolean(previous&&painted.top+previous.headingLayout.bottom*paintH<=0&&
        painted.top+previous.headingLayout.top*paintH<0);
      const sectionFromHistory=Boolean(!heading&&historySourceStable&&historyTitleMatched&&historyHeadingAbove);
      const sectionVerified=localSection||sectionFromHistory;
      const detail={kind:'education-check',imageW:w,imageH:h,sectionVerified,titleVerified,dateVerified,
        sectionFromHistory,historyRecorded:Boolean(previous),historySourceStable,historyTitleMatched,historyHeadingAbove,
        candidateCount:candidates.length,touchCount:touched.length,fullSource:item.fullSource,validSource:item.validSource,
        fullPaint:item.fullPaint,decorationPaint:item.decorationPaint,paintBoundsComplete:item.paintBoundsComplete,
        clipContained:item.clipContained,frameClipConfirmed:item.frameClipConfirmed,paintOpaque:item.paintOpaque,
        paintForward:item.paintForward,paintIntact:item.paintIntact,cacheComplete:item.cacheComplete,sourceCanvas:item.sourceCanvas,
        paintW,paintH,
        rectClips:item.clipShapes.filter(shape=>shape.kind==='rect').length,
        roundRectClips:item.clipShapes.filter(shape=>shape.kind==='roundRect').length,
        ellipseClips:item.clipShapes.filter(shape=>shape.kind==='ellipse').length};
      if(title)detail.signedGapX=title.left-layout.right;
      const titleRow=(title||nearbyTitle)?.line;
      if(titleRow)Object.assign(detail,{rowTopOffset:titleRow.top-r.top,rowBottomOffset:titleRow.bottom-r.top,
        rowCenterDeltaY:(titleRow.top+titleRow.bottom-r.top-r.bottom)/2});
      const textEvidence=[titleBox,heading?entryBounds(heading.entries):null].filter(Boolean);
      let reason='';
      if(!sectionVerified)reason='section-unverified';
      else if(!title)reason=candidates.length?'image-ambiguous':nearbyTitle?'title-alignment':'title-unverified';
      else if(paintW<font*2.5||paintW>font*5||paintH<font*2.5||paintH>font*5)reason='image-size';
      else if(detail.signedGapX<font*.35||detail.signedGapX>font*1.75)reason='image-alignment';
      else if(touched.length)reason='image-text-overlap';
      else if(d.issues.some(problem=>!problem.rect||textEvidence.some(box=>intersects(problem.rect,box)))||
        d.copyFragments.some(fragment=>fragment.coverage.some(part=>textEvidence.some(box=>intersects(part,box)))))reason='text-unsafe';
      return {item,title,heading,localSection,titleBox,titleLayout,detail,reason};
    });
    // Cache tiles and image layers may produce several pieces beside one school
    // row. Each piece needs its own unambiguous text association, not a unique
    // bitmap count. Only a fully offscreen section may use verified text history.
    for(const check of checks){
      if(!check.reason)ignored.add(check.item);
      if(!check.reason&&check.localSection&&scope&&check.item.paintIdentity){
        const deps=dependencies([check.item,...check.title.entries,...check.heading.entries]);
        if(deps&&deps.every(entry=>entry.state.revision===entry.revision))approvals.push({item:check.item,
          titleBox:check.titleBox,headingBox:entryBounds(check.heading.entries),proof:{dependencies:deps,
            imageLineage:check.item.sourceLineage,key:check.title.key,titleLayout:check.titleLayout,
            paintedRect:{...check.item.paintedRect},headingLayout:relative(entryBounds(check.heading.entries),check.item.paintedRect)}});
      }
      if(check.detail.sectionVerified||check.detail.titleVerified)issueDetail(d,{...check.detail,
        reason:check.reason||(check.detail.sectionFromHistory?'accepted-text-history':'accepted-text')});
    }
    return {ignored,approvals};
  }
  // Standalone MAIN-world observer: use the same masked-name and activity
  // boundary as capture-utils; bound Latin names additionally require the
  // source canvas spelling itself to match, without Unicode folding.
  function headerNameMatches(line,name,allowBoundLatin=false){
    const normalize=value=>String(value||'').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*');
    const expected=normalize(name),value=normalize(line);
    const activity=/^(?:(?:热搜|已收藏|在线|首页推荐)|(?:刚刚|今日|今天|本周|本月|近期|\d+(?:秒|分钟|小时|天|日|周|月)(?:内|前)?)活跃)*$/;
    // A plain Latin word is not evidence of a person's name on its own.
    // Only a candidate-card binding may authorize this exact header spelling.
    if(allowBoundLatin&&typeof name==='string'&&/^[A-Za-z]{3,30}$/.test(name)){
      const rawLine=String(line||'').replace(/[\s\u200B-\u200D\uFEFF]/g,'');
      return rawLine.startsWith(name)&&activity.test(rawLine.slice(name.length));
    }
    if(!/^(?:[\p{L}·]{1,20}\*{1,4}|[\p{L}·]{1,12}(?:先生|女士)|[\p{Script=Han}]{2,8}(?:·[\p{Script=Han}]{2,8})?)$/u.test(expected)||!value.startsWith(expected))return false;
    return activity.test(value.slice(expected.length));
  }
  function headerDecorations(d,lines,expectedName,educationImages=new Set()) {
    const ignored=new Set(),normalize=text=>String(text||'').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*');
    // These are current classification checks, not persistent drawing errors.
    // Refresh them on every snapshot so an earlier partial render cannot hide
    // the latest reason behind the three-sample diagnostic limit.
    d.details=d.details.filter(item=>item.kind!=='notice-check');
    const imageCheck=item=>({imageW:item.rect.right-item.rect.left,imageH:item.rect.bottom-item.rect.top,
      fullSource:item.fullSource,validSource:item.validSource});
    const unverified=(headerVerified=false)=>{
      for(const item of d.images.filter(item=>!educationImages.has(item)))issueDetail(d,{kind:'notice-check',reason:'header-unverified',
        headerVerified,metadataVerified:false,...imageCheck(item)});
      return ignored;
    };
    const headers=lines.filter(line=>headerNameMatches(line.text,expectedName,true));
    if(headers.length!==1||lines.indexOf(headers[0])>2)return unverified();
    const header=headers[0],height=Math.max(header.bottom-header.top,...header.entries.map(entry=>entry.fontSize||0)),left=Math.min(...header.entries.map(entry=>entry.left));
    if(!(height>0))return unverified();
    const metadata=lines.filter(line=>line.top>=header.bottom&&line.bottom<=header.bottom+height*4&&
      Math.abs(Math.min(...line.entries.map(entry=>entry.left))-left)<=height*.5)
      .map(line=>normalize(line.text)).join('');
    if(!/\d{1,2}岁/.test(metadata)||!/(?:\d{1,2}年|应届|本科|硕士|博士|大专)/.test(metadata))return unverified(true);
    const touchesText=item=>d.entries.some(entry=>intersects(entry,item.rect));
    const portraits=d.images.filter(item=>{
      // Avatar photos commonly crop the source before fitting the circular UI
      // box. A valid source crop is acceptable for this verified portrait role,
      // without granting any exception to cropped images elsewhere.
      if(!item.validSource||touchesText(item))return false;
      const circle=item.clipShapes.find(shape=>shape.kind==='ellipse'&&Math.abs(shape.rx-shape.ry)<=Math.max(shape.rx,shape.ry)*.05);
      if(!circle)return false;
      const r=item.rect,w=r.right-r.left,h=r.bottom-r.top;
      return equalRect(r,circle.bounds)&&w>=height*1.4&&w<=height*5&&h>=height*1.4&&h<=height*5&&
        r.left>=0&&r.right<left&&left-r.right<=height*3&&r.top>=header.top-height*2&&r.top<=header.bottom&&r.bottom<=header.bottom+height*3;
    });
    // A unique circular portrait is the anchor for the small gender badge.
    if(portraits.length===1){
      const portrait=portraits[0];ignored.add(portrait);
      const p=portrait.rect,diameter=Math.min(p.right-p.left,p.bottom-p.top),badgeSize=diameter*.4,margin=diameter*.15;
      const zone={left:p.right-badgeSize,top:p.top-margin,right:p.right+margin,bottom:p.top+badgeSize};
      const badges=d.images.filter(item=>{const r=item.rect;return item!==portrait&&item.fullSource&&!touchesText(item)&&contains(zone,r)&&
        r.right<left&&r.right-r.left<=badgeSize&&r.bottom-r.top<=badgeSize;});
      if(badges.length===1)ignored.add(badges[0]);
    }
    // Find the UI container first. Global rows may contain unrelated columns
    // on the same baseline; only original runs wholly inside this panel may
    // establish its exact notice text. Missing letters are never inferred.
    // Keep complete known phrasings explicit; optional words or broad keyword
    // matches would also accept incomplete text or unrelated resume content.
    const noticePatterns=[
      /^(?:(?:近)?14天首次看到此牛人|近14天你首次看到该牛人)[，,]?赶紧联系TA吧[!！。]?$/,
      /^该牛人近期受同行BOSS欢迎[!！。]?$/,
    ];
    const isNotice=text=>noticePatterns.some(pattern=>pattern.test(text));
    const globalRowExact=lines.some(line=>isNotice(normalize(line.text)));
    const panels=[];
    const sources=[...d.backgrounds.map(shape=>({shape,fromFill:true,fromClip:false})),
      ...d.images.flatMap(item=>item.clipShapes.map(shape=>({shape:{...shape,paintClips:item.clipShapes},fromFill:false,fromClip:true})))];
    for(const source of sources){
      const {shape}=source;
      if(shape.kind!=='roundRect'||shape.bounds.left<left-height||shape.bounds.top<header.bottom||
        shape.bounds.bottom>header.bottom+height*8)continue;
      const sameShape=other=>equalRect(other.bounds,shape.bounds)&&JSON.stringify(other.radii)===JSON.stringify(shape.radii);
      let panel=panels.find(candidate=>sameShape(candidate.shape));
      if(!panel){panel={shape,records:[]};panels.push(panel);}
      // Keep each source's effective paint clip. Two clipped fills cannot be
      // combined into evidence for a panel that neither actually painted.
      const entries=d.entries.filter(entry=>backgroundContains(shape,entry)),entrySet=new Set(entries);
      const panelLines=rows(entries),text=normalize(panelLines.map(line=>line.text).join('\n'));
      const relevantIssues=d.issues.filter(item=>!item.rect||intersects(item.rect,shape.bounds));
      const partialTextCount=d.entries.filter(entry=>intersects(entry,shape.bounds)&&!entrySet.has(entry)).length;
      const outside=new Set(lines.filter(line=>line.entries.some(entry=>entrySet.has(entry)))
        .flatMap(line=>line.entries.filter(entry=>!entrySet.has(entry))));
      const rect=entries.length?{left:Math.min(...entries.map(entry=>entry.left)),right:Math.max(...entries.map(entry=>entry.right)),
        top:Math.min(...entries.map(entry=>entry.top)),bottom:Math.max(...entries.map(entry=>entry.bottom))}:null;
      panel.records.push({...source,entries,rect,textLength:text.length,exact:isNotice(text),
        sameRowOutsideEntries:outside.size,partialTextCount,unsafeIssueCount:relevantIssues.length,
        overlapIssuesInPanel:relevantIssues.filter(item=>item.message==='画布文字重叠，无法确认正文顺序').length});
    }
    const exactPanels=panels.filter(panel=>panel.records.some(record=>record.exact));
    const candidates=d.images.filter(item=>!ignored.has(item)&&!educationImages.has(item));
    const checks=candidates.map(item=>{
      const r=item.rect,relevant=panels.filter(panel=>intersects(panel.shape.bounds,r));
      const panel=exactPanels.length===1?exactPanels[0]:relevant.length===1?relevant[0]:null;
      const records=panel?.records||[],exact=records.filter(record=>record.exact);
      const options=exact.length?exact:records;
      const record=options.find(value=>backgroundContains(value.shape,r)&&!value.unsafeIssueCount&&!value.partialTextCount)||
        options.find(value=>backgroundContains(value.shape,r))||options[0];
      const nr=record?.rect,panelHeight=panel?panel.shape.bounds.bottom-panel.shape.bounds.top:0;
      const touched=d.entries.filter(entry=>intersects(entry,r));
      const detail={kind:'notice-check',headerVerified:true,metadataVerified:true,...imageCheck(item),
        panelCount:panels.length,panelExactCount:exactPanels.length,globalRowExact,
        panelTextExact:Boolean(record?.exact),panelFromFill:Boolean(panel?.records.some(value=>value.fromFill)),
        panelFromClip:Boolean(panel?.records.some(value=>value.fromClip)),
        panelEntryCount:record?.entries.length||0,panelTextLength:record?.textLength||0,
        sameRowOutsideEntries:record?.sameRowOutsideEntries||0,partialTextCount:record?.partialTextCount||0,
        unsafeIssueCount:record?.unsafeIssueCount||0,overlapIssuesInPanel:record?.overlapIssuesInPanel||0,
        touchCount:touched.length,maxTextOverlapX:Math.max(0,...touched.map(entry=>Math.min(entry.right,r.right)-Math.max(entry.left,r.left))),
        maxTextOverlapY:Math.max(0,...touched.map(entry=>Math.min(entry.bottom,r.bottom)-Math.max(entry.top,r.top)))};
      if(panel)Object.assign(detail,{panelW:panel.shape.bounds.right-panel.shape.bounds.left,panelH:panelHeight});
      if(nr)Object.assign(detail,{signedGapX:nr.left-r.right,centerDeltaY:Math.abs((r.top+r.bottom)-(nr.top+nr.bottom))/2});
      let reason='';
      if(!panels.length)reason='panel-missing';
      else if(exactPanels.length>1||(!exactPanels.length&&relevant.length>1))reason='panel-ambiguous';
      else if(!panel)reason='image-outside';
      else if(record?.unsafeIssueCount||record?.partialTextCount)reason='text-unsafe';
      else if(!record?.exact)reason='text-mismatch';
      else if(!item.fullSource||!item.validSource)reason='image-source';
      else if(!backgroundContains(record.shape,r))reason='image-outside';
      else if(touched.length)reason='image-text-overlap';
      else if(detail.signedGapX<0||detail.signedGapX>panelHeight*.6)reason='image-side';
      else if(detail.imageW>panelHeight*.65||detail.imageH>panelHeight*.65)reason='image-size';
      else if(detail.centerDeltaY>panelHeight*.2)reason='image-alignment';
      return {item,detail,reason};
    });
    const accepted=checks.filter(check=>!check.reason);
    if(accepted.length===1)ignored.add(accepted[0].item);
    for(const check of checks)issueDetail(d,{...check.detail,
      reason:check.reason||(accepted.length===1?'accepted':'image-ambiguous')});
    return ignored;
  }
  function headerContinuation(d,lines,scope,recognized){
    const ignored=new Set(recognized),approvals=[];
    d.details=d.details.filter(item=>item.kind!=='header-history');
    if(!scope)return {ignored,approvals};
    const sameLineage=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
      a.every((item,index)=>item.state===b[index].state&&item.revision===b[index].revision);
    const intact=item=>item.validSource&&!item.sourceCanvas&&item.paintIntact&&item.paintOpaque&&
      item.paintForward&&item.paintBoundsComplete;
    for(const item of d.images){
      if(ignored.has(item))continue;
      const proof=scope.headerProofs.get(item.paintIdentity);
      if(!proof||!intact(item)||!sameLineage(proof.imageLineage,item.sourceLineage)||
        !proof.dependencies.every(entry=>entry.state.revision===entry.revision))continue;
      const from=proof.paintedRect,to=item.paintedRect;
      const sx=(to.right-to.left)/(from.right-from.left),sy=(to.bottom-to.top)/(from.bottom-from.top);
      if(!Number.isFinite(sx)||sx<=0||Math.abs(sx-sy)>1e-9)continue;
      const tx=to.left-from.left*sx,ty=to.top-from.top*sy;
      const map=r=>({left:r.left*sx+tx,right:r.right*sx+tx,top:r.top*sy+ty,bottom:r.bottom*sy+ty});
      const header=map(proof.headerBox),viewport=fullRect(d);
      // This is solely continuation after the proven header crosses the top.
      // An erased in-view name, a horizontal crop or a fresh partial first view
      // cannot acquire a decorative role from similarly positioned pixels.
      if(header.top>=0||header.left<0||header.right>d.width||header.bottom>d.height)continue;
      const textPresent=entry=>{
        const r=map(entry);
        if(r.left<0||r.right>d.width||r.bottom>d.height)return false;
        if(r.bottom<=0)return true;
        const matches=current=>current.text===entry.text&&equalRect(current,r)&&
          Math.abs(current.baseline-(entry.baseline*sy+ty))<.1&&current.copyStyle===entry.copyStyle&&
          sameLineage(current.sourceLineage,entry.sourceLineage);
        if(contains(viewport,r))return d.entries.some(matches);
        // Keep the original clipped glyph as private evidence only. Snapshot's
        // existing whole-row deferral still excludes it from returned text.
        return d.copyFragments.some(fragment=>matches(fragment.entry)&&
          fullyCoveredBy(intersectRect(viewport,r),fragment.coverage));
      };
      const imagesPresent=proof.images.every(previous=>{
        const r=map(previous.rect);
        if(r.left<0||r.right>d.width||r.bottom>d.height)return false;
        if(r.bottom<=0)return true;
        const matches=d.images.filter(current=>current.paintIdentity===previous.paintIdentity);
        return matches.length===1&&intact(matches[0])&&sameLineage(matches[0].sourceLineage,previous.sourceLineage)&&
          equalRect(matches[0].paintedRect,map(previous.paintedRect))&&equalRect(matches[0].rect,intersectRect(viewport,r))&&
          !d.entries.some(entry=>intersects(entry,matches[0].rect));
      });
      if(imagesPresent&&proof.entries.every(textPresent))ignored.add(item);
    }
    if(ignored.size>recognized.size)issueDetail(d,{kind:'header-history',historyVerified:true,imageCount:ignored.size-recognized.size});
    // Build history exclusively from a newly verified, complete header. All
    // visible header words, images and painted panels share the proof, so a
    // later cache splice cannot borrow just the name from a different source.
    if(recognized.size){
      const headers=lines.filter(line=>headerNameMatches(line.text,scope.expectedName,true));
      const header=headers.length===1?headers[0]:null;
      if(header){
        const height=Math.max(header.bottom-header.top,...header.entries.map(entry=>entry.fontSize||0));
        const images=[...recognized],bottom=Math.max(header.bottom+height*4,...images.map(image=>image.rect.bottom+height*2));
        const entries=d.entries.filter(entry=>entry.top<bottom);
        const region={left:0,top:0,right:d.width,bottom};
        const panels=d.backgrounds.filter(shape=>intersects(shape.bounds,region));
        const dependencies=hintDependencies(d,[...entries,...images,...panels]);
        if(dependencies&&images.every(item=>intact(item)&&item.cacheComplete)){
          const anchors=[...entries,...images.map(item=>item.rect),...panels.map(shape=>shape.bounds)];
          for(const item of images)approvals.push({item,anchors,proof:{paintedRect:{...item.paintedRect},
            headerBox:entriesBox(header.entries),imageLineage:item.sourceLineage,dependencies,entries,images}});
        }
      }
    }
    return {ignored,approvals};
  }
  // This asset is an information control, not decoration. Its exact pixels
  // only authorize a read-only hover. The actual complete tooltip must be
  // observed and the original page restored before its collapsed form is read.
  const hintNormalize=text=>String(text||'').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*');
  const workHintText='最近一份工作经历可能未更新';
  const entriesBox=entries=>({left:Math.min(...entries.map(e=>e.left)),right:Math.max(...entries.map(e=>e.right)),
    top:Math.min(...entries.map(e=>e.top)),bottom:Math.max(...entries.map(e=>e.bottom))});
  function experienceScope(canvas,expectedName){
    const session=window.__hrmBackgroundRead;
    if(!session||typeof session.token!=='string'||!session.token||session.canvas!==canvas||
      typeof expectedName!=='string'||!expectedName||session.expectedName!==expectedName){experienceSession=null;return null;}
    if(!experienceSession||experienceSession.session!==session||experienceSession.token!==session.token||
      experienceSession.canvas!==canvas||experienceSession.expectedName!==expectedName)
      experienceSession={session,token:session.token,canvas,expectedName,proofs:new WeakMap(),notes:new Map(),pending:null,latest:null};
    return experienceSession;
  }
  function hintBody(d,excluded=new Set()){
    return JSON.stringify({width:d.width,height:d.height,entries:d.entries.filter(e=>!excluded.has(e))
      .map(e=>[e.text,e.left,e.top,e.right,e.bottom,e.baseline,e.fontSize,e.copyStyle||''])
      .sort((a,b)=>a[2]-b[2]||a[1]-b[1]||String(a[0]).localeCompare(String(b[0]))),
      boundaries:[...d.issues,...copyFragmentIssues(d)].map(i=>[i.message,i.rect,i.boundary])});
  }
  function hintDependencies(d,records){
    const versions=new Map();
    for(const record of records){
      if(!Array.isArray(record.sourceLineage))return null;
      for(const item of record.sourceLineage.length?record.sourceLineage:[{state:d,revision:d.revision}]){
        if(versions.has(item.state)&&versions.get(item.state)!==item.revision)return null;
        versions.set(item.state,item.revision);
      }
    }
    return versions.size<=12?[...versions].map(([state,revision])=>({state,revision})):null;
  }
  function experienceHints(d,lines,scope,area){
    const approved=new Set(),excluded=new Set(),candidates=[],visiblePanels=[];
    if(!scope)return {approved,excluded,candidates,visiblePanels};
    const expected=hintNormalize(scope.expectedName);
    const header=lines.filter(line=>headerNameMatches(line.text,expected));
    const head=header.length===1&&lines.indexOf(header[0])<=2?header[0]:null;
    const height=head?Math.max(head.bottom-head.top,...head.entries.map(e=>e.fontSize||0)):0;
    const meta=head?lines.filter(line=>line.top>=head.bottom&&line.bottom<=head.bottom+height*4&&
      Math.abs(entriesBox(line.entries).left-entriesBox(head.entries).left)<=height*.5).map(line=>hintNormalize(line.text)).join(''):'';
    const identity=Boolean(head&&/\d{1,2}岁/.test(meta)&&/(?:\d{1,2}年|应届|本科|硕士|博士|大专)/.test(meta));
    // Only the first work entry, with a complete heading, title and separated
    // dates, can anchor this particular "latest work" warning.
    const workRows=lines.filter(line=>/^(?:工作经历|工作经验)/.test(hintNormalize(line.text)));
    if(workRows.length!==1)return {approved,excluded,candidates,visiblePanels};
    const row=workRows[0],anchor=row.text,normalized=hintNormalize(anchor);
    const date=normalized.match(/((?:19|20)\d{2})[./](0?[1-9]|1[0-2])[-—–~～]((?:19|20)\d{2})[./](0?[1-9]|1[0-2])$|((?:19|20)\d{2})[./](0?[1-9]|1[0-2])[-—–~～]至今$/);
    if(!date||normalized.slice(4,date.index).length<4||date[1]&&Number(date[1])*12+Number(date[2])>Number(date[3])*12+Number(date[4]))
      return {approved,excluded,candidates,visiblePanels};
    const rb=entriesBox(row.entries),font=Math.max(...row.entries.map(e=>e.fontSize||0));
    if(!(font>0)||!contains(fullRect(d),rb))return {approved,excluded,candidates,visiblePanels};
    // Dates must be in their own right-hand column, not merely a quoted date
    // inside prose. Work title and date strings may each be painted per glyph.
    const sorted=[...row.entries].sort((a,b)=>a.left-b.left);
    let dateStart=sorted.length,tail='';
    for(let i=sorted.length-1;i>=0;i--){tail=hintNormalize(sorted[i].text)+tail;if(tail===date[0]){dateStart=i;break;}if(tail.length>date[0].length)break;}
    if(dateStart<1||dateStart===sorted.length||sorted[dateStart].left-sorted[dateStart-1].right<font)return {approved,excluded,candidates,visiblePanels};
    const relative=r=>[rb.left-r.left,rb.top-r.top,rb.right-r.left,rb.bottom-r.top].map(value=>value/(r.bottom-r.top));
    for(const item of d.images){
      const r=item.rect,w=r.right-r.left,h=r.bottom-r.top;
      if(item.hintAsset!=='experience-inquiry'||!item.fullSource||!item.validSource||item.sourceCanvas||
        !item.fullPaint||!item.paintIntact||!item.cacheComplete||!item.paintOpaque||!item.paintForward||
        item.sourceWidth!==32||item.sourceHeight!==32||Math.abs(w-h)>.1||w<font*.8||w>font*1.5||
        !contains(fullRect(d),r)||d.entries.some(e=>intersects(e,r)))continue;
      const proof=scope.proofs.get(item.paintIdentity),rel=relative(r);
      if(proof&&proof.anchor===anchor&&proof.dependencies?.every(item=>item.state.revision===item.revision)&&
        rel.every((value,i)=>Math.abs(value-proof.relative[i])<.01)){
        approved.add(item);continue;
      }
      if(!identity)continue;
      const collapsed=Math.abs(r.right-rb.right)<=font*2&&r.bottom<=rb.top&&rb.top-r.bottom<=font*3;
      const panels=[];
      for(const shape of d.backgrounds){
        if(!['roundRect','rect'].includes(shape.kind)||!backgroundContains(shape,r))continue;
        const p=shape.bounds,ph=p.bottom-p.top;
        if(ph<font||ph>font*3||p.bottom>rb.top||rb.top-p.bottom>font*3||Math.abs(p.right-rb.right)>font*2)continue;
        const entries=d.entries.filter(e=>backgroundContains(shape,e)),set=new Set(entries);
        if(!entries.length||d.entries.some(e=>intersects(e,p)&&!set.has(e))||
          [...d.issues,...copyFragmentIssues(d)].some(i=>!i.rect||intersects(i.rect,p))||
          d.images.some(other=>other!==item&&intersects(other.rect,p)))continue;
        const text=rows(entries).map(line=>hintNormalize(line.text)).join('');
        if(text!==workHintText+'询问Ta')continue;
        const box=entriesBox(entries);
        if(box.left<r.right||box.left-r.right>font||Math.abs((box.top+box.bottom-r.top-r.bottom)/2)>font*.5)continue;
        if(!panels.some(panel=>equalRect(panel.rect,p)))panels.push({rect:p,entries,set,text:workHintText});
      }
      if(panels.length>1)continue;
      const candidate={item,anchor,rowBox:rb,relative:rel,panel:panels[0]||null,dependencies:hintDependencies(d,[item,...row.entries])};
      if(candidate.panel){
        visiblePanels.push(candidate);
        // A manually opened, complete tooltip is already original text. Keep
        // its note separate from the body; a pending automatic probe still
        // requires restoration before anything is approved.
        if(!scope.pending&&contains(area,candidate.panel.rect)&&contains(area,candidate.rowBox)){
          approved.add(item);for(const e of candidate.panel.entries)excluded.add(e);
        }
      }else if(collapsed)candidates.push(candidate);
    }
    if(candidates.length!==1)candidates.length=0;
    if(visiblePanels.length!==1){
      for(const candidate of visiblePanels)approved.delete(candidate.item);
      excluded.clear();visiblePanels.length=0;
    }
    return {approved,excluded,candidates,visiblePanels};
  }
  const matrixKey = ctx => {const m=ctx.getTransform();return [m.a,m.b,m.c,m.d,m.e,m.f].join(',');};
  function pathPoint(ctx,args,complex=false,command='other',traceArgs=args) {
    const info=context(ctx);
    if (!info.path) info.path={left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity,complex:false,
      matrix:matrixKey(ctx),commands:[],trace:[]};
    info.path.commands.push(command);
    if(!info.path.truncated&&info.path.trace.length<128){
      const m=ctx.getTransform();
      info.path.trace.push({name:command,args:traceArgs.map(value=>Array.isArray(value)?value.map(item=>typeof item==='object'&&item?{x:item.x,y:item.y}:item):
        typeof value==='object'&&value?{x:value.x,y:value.y}:value),matrix:[m.a,m.b,m.c,m.d,m.e,m.f]});
    }else {info.path.trace=[];info.path.truncated=true;}
    if(info.path.matrix!==matrixKey(ctx))info.path.complex=true;
    info.path.complex ||= complex;
    for (let i=0;i+1<args.length;i+=2) {
      const p=bounds(ctx,args[i],args[i+1],args[i],args[i+1]);
      if (!p) {info.path.complex=true;continue;}
      info.path.left=Math.min(info.path.left,p.left);info.path.right=Math.max(info.path.right,p.right);
      info.path.top=Math.min(info.path.top,p.top);info.path.bottom=Math.max(info.path.bottom,p.bottom);
    }
  }
  function fillShape(ctx,shape) {
    const d=state(ctx.canvas),r=clipBounds(ctx,shape.bounds);if(!r)return;
    if(typeof ctx.fillStyle!=='string'){issue(d,'画布使用了不能确认的图案填充',r);return;}
    if(ctx.globalAlpha!==1||!opaqueStyle(ctx.fillStyle)){
      if(d.entries.some(entry=>intersects(entry,r))||d.copyFragments.some(f=>f.coverage.some(p=>intersects(p,r)))||
        d.issues.some(item=>item.fragment&&intersects(item.rect,r)))issue(d,'画布文字被不能确认的背景覆盖',r);
      // Visible translucent UI backgrounds still establish their shape. They
      // do not erase any earlier text or unresolved drawing evidence.
      if(ctx.globalAlpha>0&&!transparentStyle(ctx.fillStyle))rememberBackground(ctx,d,shape);
      return;
    }
    const covered=rect=>contains(r,rect)&&shapeContains(shape,rect)&&clipContains(ctx,rect);
    if(covered(fullRect(d))){reset(ctx.canvas);return;}
    coverEntries(ctx,d,r,covered,'fill-path');
    eraseCopyFragments(d,r,covered);
    d.issues=d.issues.filter(item=>!item.rect||!covered(item.rect))
      .map(item=>item.fragment&&intersects(r,item.rect)?{...item,fragment:null}:item);
    d.separators=d.separators.filter(separator=>!covered(separator));
    d.images=d.images.filter(item=>!covered(item.rect))
      .map(item=>intersects(r,item.rect)?{...item,fullPaint:false,decorationPaint:false,paintIntact:false}:item);
    d.backgrounds=d.backgrounds.filter(other=>!covered(other.bounds));
    rememberBackground(ctx,d,shape);
  }
  function paintPath(ctx,args,stroke) {
    const d=state(ctx.canvas);d.revision=++revision;
    if (!usableContext(ctx,d)) return;
    if (!ctx.globalAlpha) return;
    const path=context(ctx).path;
    const hasShadow=ctx.shadowColor&&!transparentStyle(ctx.shadowColor);
    if(transparentStyle(stroke?ctx.strokeStyle:ctx.fillStyle)&&!hasShadow)return;
    // Unknown Path2D objects, transform changes and shadows have no reliable
    // region. A global issue prevents viewport clipping from hiding them.
    const standardFillRule=!stroke&&args.length===1&&['nonzero','evenodd'].includes(args[0]);
    const shape=!(args.length&&!standardFillRule)&&!hasShadow?pathShape(ctx):null;
    if(!stroke&&shape){fillShape(ctx,shape);return;}
    if((args.length&&!standardFillRule)||!path||path.complex||path.matrix!==matrixKey(ctx)||hasShadow){
      issue(d,'画布含无法直接读取的路径绘制');pathDetail(ctx,'path');return;
    }
    let r={left:path.left,top:path.top,right:path.right,bottom:path.bottom};
    // A single rect path paints exactly the same pixels as fillRect. It is a
    // common background/highlight primitive, not an unknown font outline.
    if(!stroke&&path.commands[0]==='rect'&&path.commands.slice(1).every(command=>command==='closePath')){
      const m=ctx.getTransform();
      fillRect(ctx,[(r.left-m.e)/m.a,(r.top-m.f)/m.d,(r.right-r.left)/m.a,(r.bottom-r.top)/m.d]);
      return;
    }
    if(stroke){
      const m=ctx.getTransform(),width=Number(ctx.lineWidth);
      if(!bounds(ctx,0,0,0,0)||!Number.isFinite(width)||width<=0){
        issue(d,'画布描边范围无法确认');return;
      }
      // Include thickness and possible round/square end caps in canvas pixels.
      const dx=width*m.a/2,dy=width*m.d/2;
      r={left:r.left-dx,top:r.top-dy,right:r.right+dx,bottom:r.bottom+dy};
      const singleLine=path.commands.length===2&&path.commands[0]==='moveTo'&&path.commands[1]==='lineTo';
      const straight=path.left===path.right||path.top===path.bottom;
      const thin=Math.max(dx,dy)*2<=2;
      if(!singleLine||!straight){issue(d,'画布含无法直接读取的路径绘制');return;}
      if(thin&&finiteRect(r)&&!d.entries.some(entry=>intersects(entry,r))&&
        !d.copyFragments.some(f=>f.coverage.some(p=>intersects(p,r)))&&!d.issues.some(item=>item.fragment&&intersects(item.rect,r))){
        if(!d.separators.some(separator=>equalRect(separator,r))){
          if(d.separators.length>=512)issue(d,'画布分隔线超出读取上限');
          else d.separators.push(r);
        }
        // A witnessed thin underline outside the glyph's pixel support does
        // not break its preceding background association. This never carries
        // a pending cover across a pixel write: the wrapper already cleared it.
        const support={left:Math.floor(r.left),top:Math.floor(r.top),right:Math.ceil(r.right),bottom:Math.ceil(r.bottom)};
        for(const entry of d.entries)if(entry.backgroundProof?.serial===d.pixelSerial-1&&
          !intersects(support,{...entry,right:entry.right+1}))entry.backgroundProof.serial=d.pixelSerial;
        return;
      }
    }
    if(finiteRect(r)){r=clipBounds(ctx,r);if(!r)return;}
    issue(d,'画布含无法直接读取的路径绘制',finiteRect(r)?r:null);
  }
  const pixelOperations=new Set(['fillText','strokeText','clearRect','fillRect','drawImage','putImageData','reset','fill','stroke','strokeRect']);
  function wrap(name,observe) {
    const original=proto[name];if(typeof original!=='function')return;
    const wrapped=function(...args) {
      const result=Reflect.apply(original,this,args);
      if (!stopped) try {
        canvasContexts.set(this.canvas,this);
        const d=state(this.canvas);d.operations[name]=Math.min(1000000,(d.operations[name]||0)+1);
        const noPaintText=(name==='fillText'||name==='strokeText')&&nativeTextNoPaint(this,args,name==='strokeText');
        // Invalidate source-dependent history even when a drawing branch is
        // unsupported and only records a clipped-away issue (e.g. a gradient
        // covering the old section heading). State-only operations do not paint.
        if(!noPaintText&&pixelOperations.has(name)){
          d.revision=++revision;d.pixelSerial++;
          d.activeHighlight=name==='fillText'?d.pendingHighlight:null;
          d.pendingHighlight=null;d.pixelOperation=name;
        }
        try{if(!noPaintText)observe(this,args);}finally{if(!noPaintText&&pixelOperations.has(name)){d.activeHighlight=null;d.pixelOperation=null;}}
      } catch {issue(state(this.canvas),'画布绘制记录异常');}
      return result;
    };
    originals.push({name,original,wrapped});proto[name]=wrapped;
  }
  wrap('fillText',noteText);wrap('strokeText',(ctx,args)=>noteText(ctx,args,true));wrap('clearRect',erase);wrap('fillRect',fillRect);
  wrap('drawImage',image);
  wrap('putImageData',ctx=>issue(state(ctx.canvas),'画布使用了像素图片正文，无法直接读取原文'));
  wrap('reset',ctx=>{reset(ctx.canvas);contexts.delete(ctx);});
  wrap('save',ctx=>{const s=context(ctx);s.stack.push({clipped:s.clipped,clipRect:s.clipRect,clipShapes:s.clipShapes});});
  wrap('restore',ctx=>{const s=context(ctx);if(s.stack.length)Object.assign(s,s.stack.pop());});
  wrap('clip',clip);
  wrap('beginPath',ctx=>{context(ctx).path=null;});
  wrap('moveTo',(ctx,args)=>pathPoint(ctx,args,false,'moveTo'));wrap('lineTo',(ctx,args)=>pathPoint(ctx,args,false,'lineTo'));
  wrap('rect',(ctx,[x,y,w,h])=>pathPoint(ctx,[x,y,x+w,y+h],false,'rect',[x,y,w,h]));
  wrap('closePath',ctx=>{if(context(ctx).path)pathPoint(ctx,[],false,'closePath');});
  for(const method of ['arc','arcTo','ellipse','bezierCurveTo','quadraticCurveTo','roundRect'])wrap(method,(ctx,args)=>pathPoint(ctx,args,true,method));
  wrap('fill',(ctx,args)=>paintPath(ctx,args,false));wrap('stroke',(ctx,args)=>paintPath(ctx,args,true));
  // This direct drawing method does not pass through beginPath/stroke.
  wrap('strokeRect',ctx=>issue(state(ctx.canvas),'画布含无法确认的矩形描边绘制'));
  // Setting width to its existing value also clears pixels and must clear the record.
  const canvasProto=globalThis.HTMLCanvasElement?.prototype;
  // Canvas elements created after installation have a new empty bitmap even
  // if the renderer never calls clearRect or sets width/height explicitly.
  // Existing canvases still require a witnessed reset; injection is not proof.
  for(const name of ['createElement','createElementNS']) {
    const original=document[name];if(typeof original!=='function')continue;
    const descriptor=Object.getOwnPropertyDescriptor(document,name);
    const wrapped=function(...args){
      const element=Reflect.apply(original,this,args);
      if(!stopped&&canvasProto?.isPrototypeOf(element)&&!drawings.has(element))reset(element);
      return element;
    };
    document[name]=wrapped;creationOriginals.push({name,descriptor,wrapped});
  }
  for(const name of ['width','height']) {
    const descriptor=canvasProto&&Object.getOwnPropertyDescriptor(canvasProto,name);
    if (!descriptor?.configurable || !descriptor.set) continue;
    const setter=function(value){descriptor.set.call(this,value);if(!stopped){reset(this);const ctx=canvasContexts.get(this);if(ctx)contexts.delete(ctx);}};
    Object.defineProperty(canvasProto,name,{...descriptor,set:setter});sizeOriginals.push({name,descriptor,setter});
  }
  function rows(entries) {
    const baselines=[],lines=[];
    for(const e of [...entries].sort((a,b)=>a.top-b.top||a.advanceLeft-b.advanceLeft)) {
      // Keep an original baseline intact before merging visually aligned
      // fonts. Otherwise digits can join a taller title first, leaving their
      // thin hyphen behind because that row retained the title's baseline.
      const group=baselines.find(l=>l.textBaseline===e.textBaseline&&Math.abs(l.baseline-e.baseline)<.1);
      if(group){group.entries.push(e);group.top=Math.min(group.top,e.top);group.bottom=Math.max(group.bottom,e.bottom);}
      else baselines.push({top:e.top,bottom:e.bottom,baseline:e.baseline,textBaseline:e.textBaseline,entries:[e]});
    }
    for(const group of baselines.sort((a,b)=>a.top-b.top)){
      // Keep original ink bands even when the date and a taller title share
      // one baseline. Thin punctuation on a nearby baseline must align with
      // actual glyphs, not with the enlarged union of differently sized fonts.
      const bands=group.entries.filter(entry=>entry.text.trim()).map(entry=>({top:entry.top,bottom:entry.bottom}));
      const band={top:group.top,bottom:group.bottom};
      const delta=(a,b)=>Math.abs((a.top+a.bottom)-(b.top+b.bottom))/2;
      const line=lines.find(l=>l.groups.every(previous=>previous.top<group.bottom&&previous.bottom>group.top&&
        delta(previous,group)<=Math.max(previous.bottom-previous.top,group.bottom-group.top)*.3)&&
        l.bands.some(previous=>bands.some(current=>delta(previous,current)<=
          Math.min(previous.bottom-previous.top,current.bottom-current.top)*.3)));
      // Fixed group bounds also prevent successive small offsets from linking
      // separate rows into one through a chain of intermediate glyphs.
      if(line){line.entries.push(...group.entries);line.bands.push(...bands);line.groups.push(band);
        line.top=Math.min(line.top,group.top);line.bottom=Math.max(line.bottom,group.bottom);}
      else lines.push({...group,entries:[...group.entries],bands,groups:[band]});
    }
    return lines.sort((a,b)=>a.top-b.top).map(line=>{
      let previous=null,text='';
      for(const e of line.entries.sort((a,b)=>a.advanceLeft-b.advanceLeft)) {
        const gap=previous?e.advanceLeft-previous.advanceRight:0;
        if(previous&&gap>Math.min(e.space,previous.space)*.75&&!/\s$/.test(text)&&!/^\s/.test(e.text))text+=' ';
        text+=e.text;previous=e;
      }
      return {...line,text};
    });
  }
  function identityMetadataRows(lines,header,height,left){
    const normalize=value=>String(value||'').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*');
    return lines.filter(line=>line!==header&&line.top>=header.bottom&&line.bottom<=header.bottom+height*4&&
      Math.abs(Math.min(...line.entries.map(entry=>entry.left))-left)<=height*.5).filter(line=>{
      let value=normalize(line.text).replace(/[|｜·]/g,'');
      for(const pattern of [/\d{1,2}岁/g,/(?:\d{1,2}年(?:以上)?|应届生?|在校生?|无经验)/g,
        /(?:博士|硕士|本科|大专|高中|中专|中技|初中及以下|EMBA|MBA)/g]){
        const matches=value.match(pattern);if(matches?.length!==1)return false;
        value=value.replace(pattern,'');
      }
      return /^(?:(?:在职[-－—]?(?:考虑机会|暂不考虑|暂时不考虑|月内到岗|看看机会))|(?:离职[-－—]?(?:随时到岗|正在找工作))|(?:在校[-－—]?(?:看看机会|寻找实习|寻找工作)))?$/.test(value);
    });
  }
  function boundLatinHeaderProblem(d,lines,expectedName,area){
    if(typeof expectedName!=='string'||!/^[A-Za-z]+$/.test(expectedName))return '';
    if(!/^[A-Za-z]{3,30}$/.test(expectedName))return '候选人卡片绑定的英文姓名长度无法确认。';
    const headers=lines.filter(line=>headerNameMatches(line.text,expectedName,true));
    // Later scroll screens do not contain the header; the reader independently
    // binds its first top screen and checks the full transcript against the card.
    if(!headers.length){
      const first=lines[0];
      if(!first||first.top<0||first.top>Math.min(120,d.height*.18))return '';
      const height=Math.max(first.bottom-first.top,...first.entries.map(entry=>entry.fontSize||0));
      const left=Math.min(...first.entries.map(entry=>entry.left));
      const metadata=identityMetadataRows(lines,first,height,left);
      if(metadata.length===1&&height>Math.max(...metadata[0].entries.map(entry=>entry.fontSize||0))*1.15)
        return '页首姓名与候选人卡片绑定的英文姓名不一致。';
      return '';
    }
    if(headers.length!==1||lines.indexOf(headers[0])>2)return '页首英文姓名不唯一或位置不正确，未确认身份。';
    const header=headers[0];
    if(header.top<0||header.top>Math.min(120,d.height*.18)||!header.entries.every(entry=>contains(area,entry)))
      return '页首英文姓名绘制不完整，未确认身份。';
    const height=Math.max(header.bottom-header.top,...header.entries.map(entry=>entry.fontSize||0));
    const left=Math.min(...header.entries.map(entry=>entry.left));
    const metadata=identityMetadataRows(lines,header,height,left);
    if(metadata.length!==1||!metadata[0].entries.every(entry=>contains(area,entry)))
      return '页首英文姓名对应的年龄、工作年限和学历资料行未完整确认。';
    const metaSize=Math.max(...metadata[0].entries.map(entry=>entry.fontSize||0));
    const portraits=d.images.filter(item=>item.rect.right<=left&&item.rect.top<=metadata[0].bottom&&item.rect.bottom>=header.top&&
      item.clipShapes.some(shape=>shape.kind==='ellipse'&&Math.abs(shape.rx-shape.ry)<=Math.max(shape.rx,shape.ry)*.05));
    if(!(height>metaSize*1.15)&&portraits.length!==1)
      return '页首英文姓名缺少可确认的标题排版或头像位置。';
    return '';
  }
  window.__hrmCanvasText={
    version:1,
    identity({rect}={}) {
      const base={version:1,canvasId:'',revision:0,text:'',marks:[],issue:''};
      const canvases=[...document.querySelectorAll('canvas')].filter(canvas=>{
        const r=canvas.getBoundingClientRect(),style=getComputedStyle(canvas);
        return canvas.isConnected!==false&&r.width>=250&&r.height>=150&&style.visibility==='visible'&&style.display!=='none'&&Number(style.opacity)>0;
      });
      if(canvases.length!==1)return {...base,issueCode:'identity',issue:'未找到唯一的当前简历画布，未确认身份。'};
      const canvas=canvases[0],d=state(canvas),lines=rows(d.entries);
      const result={...base,canvasId:d.id,revision:d.revision,diagnostics:diagnostics(d)};
      const reject=message=>({...result,issueCode:'identity',issue:message});
      if(!d.baseline)return {...result,issueCode:'baseline',issue:'当前简历未从完整重绘开始记录；请手动关闭并重新打开同一份简历后重试。'};
      if(d.overflow)return reject('当前画布绘制记录不完整，未确认身份。');
      const area=rect?{left:rect.x,top:rect.y,right:rect.x+rect.width,bottom:rect.y+rect.height}:fullRect(d);
      if(!finiteRect(area)||!contains(fullRect(d),area)||area.top>2)return reject('当前未显示完整页首，请返回简历顶部后重试。');
      const normalize=value=>String(value||'').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*');
      const header=lines[0];
      if(!header||header.top<0||header.top>Math.min(120,d.height*.18))return reject('未读到当前简历最顶部的姓名行。');
      const headerText=normalize(header.text),nameToken=normalize(header.text.trim().split(/\s+/)[0]),names=[];
      // Discover only within the first drawn row, then require a complete,
      // aligned demographic row and header typography/portrait below. Never
      // search the body or a background list for a plausible Chinese phrase.
      for(let length=2;length<=Math.min(30,nameToken.length);length++){
        const candidate=headerText.slice(0,length);
        if(headerNameMatches(headerText,candidate))names.push(candidate);
      }
      const name=names[0]; // Known trailing activity/badge words are not part of a name.
      if(!name||/^(?:个人优势|工作经历|工作经验|教育经历|教育背景|项目经历|项目经验|专业技能|期望职位|自我评价|基本信息|候选人|姓名)$/.test(name)||
        lines.filter(line=>headerNameMatches(line.text,name)).length!==1)return reject('页首姓名不唯一或不符合姓名格式，未确认身份。');
      const height=Math.max(header.bottom-header.top,...header.entries.map(entry=>entry.fontSize||0));
      const left=Math.min(...header.entries.map(entry=>entry.left));
      const metadataRows=identityMetadataRows(lines,header,height,left);
      if(metadataRows.length!==1)return reject('页首年龄、工作年限和学历未形成唯一完整资料行，未确认身份。');
      const metadata=metadataRows[0],metaSize=Math.max(...metadata.entries.map(entry=>entry.fontSize||0));
      const portraits=d.images.filter(item=>item.rect.right<=left&&item.rect.top<=metadata.bottom&&item.rect.bottom>=header.top&&
        item.clipShapes.some(shape=>shape.kind==='ellipse'&&Math.abs(shape.rx-shape.ry)<=Math.max(shape.rx,shape.ry)*.05));
      if(!(height>metaSize*1.15)&&portraits.length!==1)return reject('页首姓名缺少可确认的标题排版或头像位置，未确认身份。');
      if(!header.entries.every(entry=>contains(area,entry))||!metadata.entries.every(entry=>contains(area,entry)))
        return reject('页首姓名或资料行被裁切，未确认身份。');
      // Check only the header band here. Body images/folds remain subject to
      // the unchanged full-text reader after this identity is bound.
      const headerRect={x:area.left,y:0,width:area.right-area.left,height:Math.min(area.bottom,metadata.bottom+2)};
      const checked=this.snapshot({rect:headerRect,expectedName:name,allowVerticalBoundary:true});
      const {horizontalCoverage,...snapshot}=checked;
      if(checked.issue)return snapshot;
      if(checked.boundaryRows?.top||horizontalCoverage?.complete!==true)return reject('页首绘制或横向范围尚未完整确认，未确认身份。');
      return {...snapshot,text:'',marks:[],identity:{version:1,name,canvasId:d.id,
        headerKey:JSON.stringify([name,normalize(metadata.text)])}};
    },
    snapshot({rect,expectedName,allowVerticalBoundary=false,textOnly=true}={}) {
      const base={version:1,canvasId:'',revision:0,text:'',marks:[],canvas:null,issue:''};
      const canvases=[...document.querySelectorAll('canvas')].filter(canvas=>{
        const r=canvas.getBoundingClientRect(),style=getComputedStyle(canvas);
        return canvas.isConnected!==false&&r.width>=250&&r.height>=150&&style.visibility==='visible'&&style.display!=='none'&&Number(style.opacity)>0;
      });
      if(canvases.length!==1){educationSession=null;experienceSession=null;return {...base,issue:'未找到唯一的在线简历画布'};}
      const canvas=canvases[0],d=state(canvas);
      const area=rect?{left:rect.x,top:rect.y,right:rect.x+rect.width,bottom:rect.y+rect.height}:fullRect(d);
      const scope=educationScope(canvas,expectedName),hintScope=experienceScope(canvas,expectedName),allLines=rows(d.entries);
      const hints=experienceHints(d,allLines,hintScope,area),lines=rows(d.entries.filter(e=>!hints.excluded.has(e)));
      const education=educationDecorations(d,lines,scope),educationImages=education.ignored;
      const header=headerContinuation(d,lines,scope,headerDecorations(d,lines,expectedName,new Set([...educationImages,...hints.approved])));
      const ignoredImages=new Set([...educationImages,...hints.approved,...header.ignored]);
      // Only directly recorded canvas text is copied into the resume. An
      // external image with no possible text-pixel interaction is irrelevant
      // to that text, whatever its size, crop or position. Unmapped canvas
      // sources remain unknown because their recorded text lineage was lost.
      if(textOnly&&d.entries.length)for(const item of d.images){
        if(item.sourceCanvas||imageTouchesRecordedText(d,item))ignoredImages.delete(item);
        else ignoredImages.add(item);
      }
      const unknownImages=d.images.filter(item=>!ignoredImages.has(item));
      const fragmentIssues=copyFragmentIssues(d),currentIssues=[...d.issues,...fragmentIssues];
      const boundaryIssues=currentIssues.filter(item=>item.boundary);
      const deferred=allowVerticalBoundary===true?boundaryIssues.filter(item=>item.boundary.verticalOnly):[];
      const sameBoundaryLine=(line,b)=>line.entries.some(entry=>entry.textBaseline===b.textBaseline&&Math.abs(entry.baseline-b.baseline)<.1);
      const activeDeferred=deferred.filter(item=>intersects(area,item.rect)||lines.some(line=>
        sameBoundaryLine(line,item.boundary)&&line.entries.some(entry=>intersects(area,entry))));
      const boundaryRows={top:activeDeferred.some(item=>item.boundary.top<0),
        bottom:activeDeferred.some(item=>item.boundary.bottom>d.height)};
      d.details=d.details.filter(item=>!['text-boundary','image','text-cover'].includes(item.kind));
      for(const item of currentIssues)if(item.cover)issueDetail(d,item.cover);
      for(const item of boundaryIssues){
        const b=item.boundary;
        issueDetail(d,{kind:'text-boundary',left:b.left,top:b.top,right:b.right,bottom:b.bottom,
          canvasWidth:d.width,canvasHeight:d.height,baseline:b.baseline,textLength:b.textLength,
          overflowLeft:Math.max(0,-b.left),overflowTop:Math.max(0,-b.top),
          overflowRight:Math.max(0,b.right-d.width),overflowBottom:Math.max(0,b.bottom-d.height),deferred:deferred.includes(item)});
      }
      for(const item of unknownImages)issueDetail(d,{kind:'image',...item.rect,sourceWidth:item.sourceWidth,sourceHeight:item.sourceHeight,
        fullSource:item.fullSource,sourceCanvas:item.sourceCanvas,roundClip:item.clipShapes.some(shape=>shape.kind==='ellipse'),clipCount:item.clipShapes.length});
      const horizontal=horizontalCoverage(d,area,unknownImages,currentIssues);
      const horizontalDiagnostic=Object.fromEntries(['complete','reason','canvasWidth','visibleLeft','visibleRight',
        'clippedLeft','clippedRight','textLeft','textRight','outsideTextRuns','outsideImages','outsideIssues']
        .filter(key=>Object.hasOwn(horizontal,key)).map(key=>[key,horizontal[key]]));
      const result={...base,canvasId:d.id,revision:d.revision,canvas:{width:d.width,height:d.height},horizontalCoverage:horizontal,
        ...(allowVerticalBoundary===true?{boundaryRows}:{}),diagnostics:{...diagnostics(d,unknownImages,ignoredImages.size,fragmentIssues),horizontal:horizontalDiagnostic}};
      if(hintScope)hintScope.latest=null;
      if(!finiteRect(area)||!contains(fullRect(d),area))return {...result,issue:'画布读取范围无效',failureReason:'canvas-range'};
      if(!d.baseline)return {...result,issueCode:'baseline',issue:'未从完整重绘开始记录，需要重新打开当前简历'};
      const problem=currentIssues.find(item=>!deferred.includes(item)&&(!item.rect||intersects(area,item.rect)))||
        (d.overflow?{message:d.overflowReason}:null);
      if(problem)return {...result,issueCode:'unsupported',issue:problem.message+(d.overflow?'（绘制问题记录已达上限）':'')};
      const latinHeaderProblem=boundLatinHeaderProblem(d,lines,expectedName,area);
      if(latinHeaderProblem)return {...result,issueCode:'rendering',issue:latinHeaderProblem};
      if(hintScope)hintScope.latest={d,area,hints,unknownImages};
      if(unknownImages.some(item=>intersects(area,item.rect))){
        // Images can arrive before the first asynchronous text drawing. There
        // is not yet a header with which to classify them; use the reader's
        // bounded rendering wait, without delaying any actual drawing issue.
        if(!d.entries.length&&!d.issues.length)return {...result,issueCode:'rendering',issue:'尚未记录到可直接读取的画布原文'};
        const candidate=hints.candidates.length===1?hints.candidates[0]:null;
        const hintMarks=candidate&&unknownImages.length===1&&unknownImages[0]===candidate.item&&
          contains(area,candidate.item.rect)&&contains(area,candidate.rowBox)?[{id:candidate.item.hintId,kind:'latest-work',
            x:(candidate.item.rect.left+candidate.item.rect.right)/(2*d.width),y:(candidate.item.rect.top+candidate.item.rect.bottom)/(2*d.height)}]:[];
        return {...result,...(hintMarks.length?{hintMarks}:{}),issueCode:'unsupported',
          issue:hintMarks.length?'工作经历含尚未读取的平台提示':'画布含无法确认是否属于正文的图片，不能完整读取原文'};
      }
      const safeArea={...area};
      for(const {boundary:b} of activeDeferred){
        const affected=lines.filter(line=>sameBoundaryLine(line,b));
        if(b.top<0)safeArea.top=Math.max(safeArea.top,b.bottom,...affected.map(line=>line.bottom));
        if(b.bottom>d.height)safeArea.bottom=Math.min(safeArea.bottom,b.top,...affected.map(line=>line.top));
      }
      // Exclude the entire row, including smaller complete glyphs beside a
      // clipped one. A later screen must recover it through the reader's overlap proof.
      const visible=lines.filter(line=>line.entries.every(e=>contains(safeArea,e))&&!activeDeferred.some(({boundary:b})=>sameBoundaryLine(line,b)));
      const text=visible.map(line=>line.text).join('\n');
      if(!text.trim())return {...result,issueCode:'rendering',issue:'尚未记录到可直接读取的画布原文'};
      const matchesMark=(line,mark)=>{
        const x=mark.x*d.width,y=mark.y*d.height;
        if(y<line.top||y>line.bottom||typeof mark.label!=='string'||!mark.label)return false;
        // Bind the control to its own current drawing runs, not another copy
        // of the same words elsewhere on the line or a stale erased position.
        for(let start=0;start<line.entries.length;start++){
          let word='',left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
          for(let end=start;end<line.entries.length;end++){
            const entry=line.entries[end];word+=entry.text.normalize('NFKC').replace(/\s/g,'');
            if(!mark.label.startsWith(word))break;
            left=Math.min(left,entry.left);right=Math.max(right,entry.right);
            top=Math.min(top,entry.top);bottom=Math.max(bottom,entry.bottom);
            if(word===mark.label){
              if(Math.abs((left+right)/2-x)<.1&&Math.abs((top+bottom)/2-y)<.1)return true;
              break;
            }
          }
        }
        return false;
      };
      const marks=[...(window.__hrmExpandMarks?.read?.()||[]),...d.copyMarks].filter(mark=>
        Number.isFinite(mark.x)&&Number.isFinite(mark.y)&&mark.x*d.width>=area.left&&mark.x*d.width<=area.right&&
        mark.y*d.height>=area.top&&mark.y*d.height<=area.bottom&&visible.some(line=>matchesMark(line,mark)));
      // Commit only after the complete snapshot succeeded, and only anchors
      // actually contained in its readable area. A failed/partial first view
      // never grants an image a historical role for a later screen.
      if(scope&&!d.overflow)for(const approval of education.approvals){
        if(!contains(safeArea,approval.titleBox)||!contains(safeArea,approval.headingBox))continue;
        if(!scope.proofs.has(approval.item.paintIdentity)){if(scope.count>=256)continue;scope.count++;}
        scope.proofs.set(approval.item.paintIdentity,approval.proof);
      }
      if(scope&&!d.overflow)for(const approval of header.approvals){
        if(!approval.anchors.every(anchor=>contains(safeArea,anchor)))continue;
        if(!scope.headerProofs.has(approval.item.paintIdentity)){if(scope.headerCount>=32)continue;scope.headerCount++;}
        scope.headerProofs.set(approval.item.paintIdentity,approval.proof);
      }
      if(hintScope&&!hintScope.pending)for(const candidate of hints.visiblePanels){
        if(!contains(safeArea,candidate.panel.rect)||!contains(safeArea,candidate.rowBox))continue;
        const note={kind:'latest_work_may_be_outdated',text:workHintText,section:'工作经历',anchor:candidate.anchor};
        if(hintScope.notes.size<8||hintScope.notes.has(candidate.anchor))hintScope.notes.set(candidate.anchor,note);
      }
      return {...result,text,marks,...(hintScope?.notes.size?{platformNotes:[...hintScope.notes.values()]}:{})};
    },
    hint(action,{rect,expectedName,mark}={}){
      if(action==='cancel'){if(experienceSession)experienceSession.pending=null;return {ok:true};}
      // Explicit hint probing keeps the original role-verification policy.
      // It must not borrow a text-only image exemption as hover evidence.
      const snapshot=this.snapshot({rect,expectedName,allowVerticalBoundary:true,textOnly:false}),scope=experienceSession,latest=scope?.latest;
      if(!scope||!latest)return {ok:false,ready:false};
      const {d,area,hints,unknownImages}=latest;
      if(action==='begin'){
        if(scope.pending||hints.candidates.length!==1||snapshot.hintMarks?.length!==1)return {ok:false};
        const current=snapshot.hintMarks[0],candidate=hints.candidates[0];
        if(!mark||mark.id!==current.id||mark.kind!==current.kind||Math.abs(mark.x-current.x)>1e-9||Math.abs(mark.y-current.y)>1e-9)return {ok:false};
        // WASM pages may listen only to pointermove, not pointerleave. Choose
        // a recorded blank patch now, never a guessed adjacent button, so the
        // reader can move away and verify that the original body returns.
        const points=[[area.left+8,area.top+8],[area.right-8,area.top+8],
          [area.left+8,(area.top+area.bottom)/2],[area.left+8,area.bottom-8],[area.right-8,area.bottom-8]];
        const away=points.find(([x,y])=>{
          const box={left:x-3,top:y-3,right:x+3,bottom:y+3};
          return contains(area,box)&&!d.entries.some(e=>intersects(e,box))&&!d.images.some(i=>intersects(i.rect,box))&&
            !d.copyFragments.some(f=>f.coverage.some(r=>intersects(r,box)))&&!d.separators.some(r=>intersects(r,box));
        });
        if(!away)return {ok:false};
        scope.pending={anchor:candidate.anchor,imageRect:{...candidate.item.rect},rowBox:{...candidate.rowBox},
          area:{...area},body:hintBody(d),note:null};
        return {ok:true,leavePoint:{x:away[0]/d.width,y:away[1]/d.height}};
      }
      const pending=scope.pending;
      if(!pending||!equalRect(area,pending.area))return {ok:false,ready:false};
      if(action==='probe'){
        const candidate=hints.visiblePanels.length===1?hints.visiblePanels[0]:null;
        const ready=Boolean(candidate&&unknownImages.length===1&&unknownImages[0]===candidate.item&&
          candidate.anchor===pending.anchor&&equalRect(candidate.rowBox,pending.rowBox)&&
          Math.abs(candidate.item.rect.top-pending.imageRect.top)<.1&&Math.abs(candidate.item.rect.bottom-pending.imageRect.bottom)<.1&&
          contains(area,candidate.panel.rect)&&hintBody(d,candidate.panel.set)===pending.body);
        if(ready)pending.note={kind:'latest_work_may_be_outdated',text:workHintText,section:'工作经历',anchor:pending.anchor};
        return {ready};
      }
      if(action==='finish'){
        const candidate=hints.candidates.length===1?hints.candidates[0]:null;
        if(!pending.note||!candidate||unknownImages.length!==1||unknownImages[0]!==candidate.item||
          candidate.anchor!==pending.anchor||!equalRect(candidate.rowBox,pending.rowBox)||
          !equalRect(candidate.item.rect,pending.imageRect)||hintBody(d)!==pending.body)return {ok:false};
        if(!candidate.dependencies||scope.notes.size>=8&&!scope.notes.has(pending.anchor))return {ok:false};
        scope.proofs.set(candidate.item.paintIdentity,{anchor:candidate.anchor,relative:candidate.relative,dependencies:candidate.dependencies});
        scope.notes.set(pending.anchor,pending.note);scope.pending=null;
        return {ok:true};
      }
      return {ok:false,ready:false};
    },
    stop() {
      stopped=true;
      educationSession=null;experienceSession=null;
      glyphs?.stop();
      for(const {name,original,wrapped} of originals)if(proto[name]===wrapped)proto[name]=original;
      for(const {name,descriptor,setter} of sizeOriginals)if(Object.getOwnPropertyDescriptor(canvasProto,name)?.set===setter)Object.defineProperty(canvasProto,name,descriptor);
      for(const {name,descriptor,wrapped} of creationOriginals)if(document[name]===wrapped){
        if(descriptor)Object.defineProperty(document,name,descriptor);else delete document[name];
      }
      delete window.__hrmCanvasText;
    },
  };
})();
