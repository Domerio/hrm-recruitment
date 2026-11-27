// Compare freshly rasterized glyph coverage on private canvases. This never
// reads the page bitmap, recognizes text, or exposes glyph/font data in results.
(() => {
  if(window.__hrmCanvasGlyphs?.version===2)return;
  window.__hrmCanvasGlyphs?.stop?.();
  const Canvas=globalThis.OffscreenCanvas,proto=globalThis.OffscreenCanvasRenderingContext2D?.prototype;
  const native={getContext:Canvas?.prototype?.getContext};
  for(const key of ['measureText','fillText','setTransform','getImageData','getContextAttributes'])native[key]=proto?.[key];
  const cache=new Map(),pixelLimit=2*1024*1024,tileLimit=256,entryLimit=4096;
  const metricKeys=['width','actualBoundingBoxLeft','actualBoundingBoxRight','actualBoundingBoxAscent','actualBoundingBoxDescent'];
  const optionalStyles={fontKerning:'auto',fontStretch:'normal',fontVariantCaps:'normal',letterSpacing:'0px',wordSpacing:'0px',textRendering:'auto'};
  const finite=value=>Number.isFinite(value)&&Math.abs(value)<=1e9;
  const epsilon=(...values)=>Number.EPSILON*32*Math.max(1,...values.map(Math.abs));
  const equal=(a,b)=>Math.abs(a-b)<=epsilon(a,b);
  let stopped=false,pixels=0;
  const result=(reason,values={})=>({ok:false,separate:false,edgeOnly:false,reason,
    sharedPixels:0,sharedCorePixels:0,firstPixels:0,secondPixels:0,firstCorePixels:0,secondCorePixels:0,maxSharedMinAlpha:0,...values});
  function clear(){cache.clear();pixels=0;}
  const fonts=globalThis.document?.fonts;
  fonts?.addEventListener?.('loadingdone',clear);fonts?.addEventListener?.('loadingerror',clear);
  const call=(key,ctx,args)=>Reflect.apply(native[key],ctx,args);
  function normalize(raw,shortRun=false){
    const letters=typeof raw?.text==='string'?[...raw.text]:[];
    const validText=shortRun?letters.length>=1&&letters.length<=2&&raw.text.trim()&&
      !/[\p{M}\p{C}]/u.test(raw.text)&&!/\s/u.test(raw.text.replace(/ /g,'')):
      letters.length===1&&!/[\s\p{M}\p{C}]/u.test(raw?.text||'');
    if(!raw||typeof raw!=='object'||!validText||typeof raw.font!=='string'||!raw.font||raw.font.length>1024||
      typeof raw.lang!=='string'||raw.lang.length>128||raw.lang==='inherit'||
      !['ltr','rtl'].includes(raw.direction)||!['left','right','center','start','end'].includes(raw.textAlign)||
      !['top','hanging','middle','alphabetic','ideographic','bottom'].includes(raw.textBaseline))return {reason:'invalid-input'};
    const m=raw.metrics,t=raw.transform;
    if(!m||!t||!metricKeys.every(key=>finite(m[key]))||!['a','b','c','d','e','f'].every(key=>finite(t[key]))||
      ![raw.x,raw.y,raw.baseline,raw.advanceLeft,raw.advanceRight].every(finite)||m.width<=0||
      t.b!==0||t.c!==0||t.a<=0||t.d<=0)return {reason:'invalid-input'};
    if(raw.direction!=='ltr')return {reason:'unsupported-layout'};
    const attrs=raw.contextAttributes;
    if(!attrs||attrs.alpha!==true||!['srgb','display-p3'].includes(attrs.colorSpace)||
      (attrs.colorType!==undefined&&attrs.colorType!=='unorm8'))return {reason:'unsupported-context'};
    if(raw.globalAlpha!==undefined&&(!Number.isFinite(raw.globalAlpha)||raw.globalAlpha<=0||raw.globalAlpha>1))return {reason:'unsupported-style'};
    const width=m.width*t.a;
    const left=raw.x*t.a+t.e-(['end','right'].includes(raw.textAlign)?width:raw.textAlign==='center'?width/2:0);
    const right=left+width,baseline=raw.y*t.d+t.f;
    if(!equal(left,raw.advanceLeft)||!equal(right,raw.advanceRight)||!equal(baseline,raw.baseline))return {reason:'invalid-input'};
    const bounds={left:(raw.x-m.actualBoundingBoxLeft)*t.a+t.e,right:(raw.x+m.actualBoundingBoxRight)*t.a+t.e,
      top:(raw.y-m.actualBoundingBoxAscent)*t.d+t.f,bottom:(raw.y+m.actualBoundingBoxDescent)*t.d+t.f};
    if(!Object.values(bounds).every(finite)||bounds.right<=bounds.left||bounds.bottom<=bounds.top)return {reason:'invalid-input'};
    const tile={left:Math.floor(bounds.left)-2,top:Math.floor(bounds.top)-2,right:Math.ceil(bounds.right)+2,bottom:Math.ceil(bounds.bottom)+2};
    tile.width=tile.right-tile.left;tile.height=tile.bottom-tile.top;
    if(tile.width>tileLimit||tile.height>tileLimit)return {reason:'tile-limit'};
    const styles={font:raw.font,textAlign:raw.textAlign,textBaseline:raw.textBaseline,direction:raw.direction,lang:raw.lang};
    for(const [key,fallback] of Object.entries(optionalStyles)){
      // Chromium can serialize the HTML canvas's untouched spacing as an
      // empty string while OffscreenCanvas serializes that same default as 0px.
      const value=raw[key]===''&&['letterSpacing','wordSpacing'].includes(key)?'0px':raw[key]??fallback;
      if(typeof value!=='string'||value.length>128)return {reason:'invalid-input'};
      styles[key]=value;
    }
    return {raw,m,t,left,right,width,baseline,bounds,tile,styles,settings:{alpha:true,colorSpace:attrs.colorSpace,colorType:'unorm8',
      desynchronized:attrs.desynchronized===true,willReadFrequently:attrs.willReadFrequently===true}};
  }
  function layout(first,second){
    if(first.raw.textBaseline!==second.raw.textBaseline||!equal(first.baseline,second.baseline))return false;
    const [left,right]=first.left<second.left?[first,second]:[second,first];
    const overlap=Math.max(0,left.right-right.left);
    return left.left<right.left&&left.right<right.right&&
      overlap*2<=Math.min(left.width,right.width)+epsilon(left.width,right.width)&&
      left.bounds.left<right.bounds.left&&left.bounds.right<right.bounds.right;
  }
  function rasterize(item){
    let canvas;
    try{
      canvas=new Canvas(item.tile.width,item.tile.height);
      const ctx=Reflect.apply(native.getContext,canvas,['2d',item.settings]);
      if(!ctx)return {reason:'unavailable'};
      const attrs=call('getContextAttributes',ctx,[]);
      if(attrs?.alpha!==true||attrs.colorSpace!==item.settings.colorSpace||
        (attrs.colorType!==undefined&&attrs.colorType!=='unorm8'))return {reason:'unsupported-context'};
      for(const [key,value] of Object.entries(item.styles)){
        if(!(key in ctx)){
          if(Object.hasOwn(optionalStyles,key)&&value===optionalStyles[key])continue;
          return {reason:'unsupported-style'};
        }
        ctx[key]=value;
        if(ctx[key]!==value)return {reason:'unsupported-style'};
      }
      const measured=call('measureText',ctx,[item.raw.text]);
      if(!metricKeys.every(key=>finite(measured[key])&&equal(measured[key],item.m[key])))return {reason:'metrics-mismatch'};
      const tx=item.t.e-item.tile.left,ty=item.t.f-item.tile.top;
      const key=JSON.stringify([item.raw.text,item.styles,item.settings,item.raw.x,item.raw.y,item.t.a,item.t.d,tx,ty,
        item.tile.width,item.tile.height,metricKeys.map(name=>item.m[name])]);
      if(cache.has(key))return {...cache.get(key),left:item.tile.left,top:item.tile.top};
      const size=item.tile.width*item.tile.height;
      if(pixels+size>pixelLimit||cache.size>=entryLimit)return {reason:'cache-limit'};
      // Opaque black bounds the support of any normal solid glyph fill, including
      // translucent text. Original alpha must not erase a glyph's core here.
      ctx.fillStyle='#000000';ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
      ctx.shadowColor='rgba(0, 0, 0, 0)';ctx.shadowBlur=0;ctx.shadowOffsetX=0;ctx.shadowOffsetY=0;ctx.filter='none';
      call('setTransform',ctx,[item.t.a,0,0,item.t.d,tx,ty]);
      call('fillText',ctx,[item.raw.text,item.raw.x,item.raw.y]);
      const data=call('getImageData',ctx,[0,0,item.tile.width,item.tile.height]).data;
      if(!ArrayBuffer.isView(data)||data.BYTES_PER_ELEMENT!==1||data.length!==size*4)return {reason:'readback-failed'};
      const alpha=new Uint8Array(size);let count=0,core=0;
      for(let index=0;index<size;index++){
        const value=data[index*4+3];alpha[index]=value;
        if(!value)continue;
        const x=index%item.tile.width,y=Math.floor(index/item.tile.width);
        if(x===0||y===0||x===item.tile.width-1||y===item.tile.height-1)return {reason:'mask-clipped'};
        count++;if(value>=128)core++;
      }
      if(!count)return {reason:'empty-mask'};
      const mask={alpha,width:item.tile.width,height:item.tile.height,count,core};
      cache.set(key,mask);pixels+=size;
      return {...mask,left:item.tile.left,top:item.tile.top};
    }catch{return {reason:'readback-failed'};}
    finally{if(canvas){try{canvas.width=0;canvas.height=0;}catch{}}}
  }
  function comparePair(firstRaw,secondRaw,shortRun=false){
    if(stopped)return result('stopped');
    if(typeof Canvas!=='function'||Object.values(native).some(value=>typeof value!=='function'))return result('unavailable');
    try{
      const first=normalize(firstRaw,shortRun);if(first.reason)return result(first.reason);
      const second=normalize(secondRaw,shortRun);if(second.reason)return result(second.reason);
      if(!layout(first,second))return result('unsupported-layout');
      if(fonts?.status==='loading')return result('font-pending');
      const a=rasterize(first);if(a.reason)return result(a.reason);
      const b=rasterize(second);if(b.reason)return result(b.reason);
      let sharedPixels=0,sharedCorePixels=0,maxSharedMinAlpha=0;
      const left=Math.max(a.left,b.left),top=Math.max(a.top,b.top),right=Math.min(a.left+a.width,b.left+b.width),bottom=Math.min(a.top+a.height,b.top+b.height);
      for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
        const av=a.alpha[(y-a.top)*a.width+x-a.left],bv=b.alpha[(y-b.top)*b.width+x-b.left];
        if(!av||!bv)continue;
        sharedPixels++;maxSharedMinAlpha=Math.max(maxSharedMinAlpha,Math.min(av,bv));
        if(av>=128&&bv>=128)sharedCorePixels++;
      }
      const separate=sharedPixels===0,edgeOnly=!separate&&sharedCorePixels===0&&a.core>0&&b.core>0;
      return result(separate?'separate':edgeOnly?'edge-only':'pixel-overlap',{ok:true,separate,edgeOnly,sharedPixels,sharedCorePixels,
        firstPixels:a.count,secondPixels:b.count,firstCorePixels:a.core,secondCorePixels:b.core,maxSharedMinAlpha});
    }catch{return result('invalid-input');}
  }
  function coverage(raw,rect){
    const failed=reason=>({ok:false,separate:false,reason,coveredPixels:0,coveredCorePixels:0,pixels:0,corePixels:0});
    if(stopped)return failed('stopped');
    if(typeof Canvas!=='function'||Object.values(native).some(value=>typeof value!=='function'))return failed('unavailable');
    try{
      if(!rect||!['left','top','right','bottom'].every(key=>finite(rect[key]))||rect.right<=rect.left||rect.bottom<=rect.top)
        return failed('invalid-input');
      const item=normalize(raw);if(item.reason)return failed(item.reason);
      if(fonts?.status==='loading')return failed('font-pending');
      const mask=rasterize(item);if(mask.reason)return failed(mask.reason);
      let coveredPixels=0,coveredCorePixels=0,maxCoveredAlpha=0,rightmost=-Infinity;
      let coveredLeft=Infinity,coveredTop=Infinity,coveredRight=-Infinity,coveredBottom=-Infinity,edgeCoreAdjacent=true;
      const touched=(left,top)=>left<rect.right&&left+1>rect.left&&top<rect.bottom&&top+1>rect.top;
      for(let y=0;y<mask.height;y++)for(let x=0;x<mask.width;x++){
        const alpha=mask.alpha[y*mask.width+x];if(!alpha)continue;
        // A fractional fill can affect every pixel cell it touches. Do not
        // sample only the center or forgive low-alpha antialiasing edges.
        const left=mask.left+x,top=mask.top+y;
        rightmost=Math.max(rightmost,left);
        if(touched(left,top)){
          coveredPixels++;if(alpha>=128)coveredCorePixels++;
          maxCoveredAlpha=Math.max(maxCoveredAlpha,alpha);
          coveredLeft=Math.min(coveredLeft,left);coveredTop=Math.min(coveredTop,top);
          coveredRight=Math.max(coveredRight,left+1);coveredBottom=Math.max(coveredBottom,top+1);
          // A weak isolated dot is still content. Only a fringe directly to
          // the right of an untouched core pixel can support a later, fully
          // witnessed adjacent highlight run; this is not itself permission.
          if(x===0||mask.alpha[y*mask.width+x-1]<128||touched(left-1,top))edgeCoreAdjacent=false;
        }
      }
      const rightEdgeOnly=coveredPixels>0&&coveredCorePixels===0&&mask.core>0&&
        coveredLeft===rightmost&&coveredRight===rightmost+1&&
        Math.min(item.bounds.right,rect.right)-Math.max(item.bounds.left,rect.left)<=1;
      return {ok:true,separate:coveredPixels===0,reason:coveredPixels?'ink-hit':'ink-clear',
        coveredPixels,coveredCorePixels,pixels:mask.count,corePixels:mask.core,maxCoveredAlpha,rightEdgeOnly,
        edgeCoreAdjacent:coveredPixels>0&&edgeCoreAdjacent,
        ...(coveredPixels?{coveredLeft,coveredTop,coveredRight,coveredBottom}:{})};
    }catch{return failed('invalid-input');}
  }
  const api=Object.freeze({version:2,compare:(first,second)=>comparePair(first,second),
    compareRuns:(first,second)=>comparePair(first,second,true),coverage,clear,stop(){
    stopped=true;clear();fonts?.removeEventListener?.('loadingdone',clear);fonts?.removeEventListener?.('loadingerror',clear);
    if(window.__hrmCanvasGlyphs===api)delete window.__hrmCanvasGlyphs;
  }});
  window.__hrmCanvasGlyphs=api;
})();
