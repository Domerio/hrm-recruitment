(() => {
  if (location.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(location.hostname)
      || !/^\/web\/frame\/c-resume\/?$/.test(location.pathname)) return;
  if (window.__hrmExpandMarks?.version === 7) return;
  window.__hrmExpandMarks?.stop?.();
  const proto = globalThis.CanvasRenderingContext2D?.prototype;
  if (!proto) return;
  const labels = ['查看全部', '展开全部', '查看更多'];
  const subjects = ['个人优势','个人简介','期望职位','工作经历','工作经验','项目经历','项目经验','教育经历','教育背景',
    '资格证书','专业技能','所获荣誉','荣誉奖项','获奖经历','荣誉','语言能力'];
  const drawings = new WeakMap();
  const originals = new Map();
  const getImageData = proto.getImageData;
  const maxEvidencePixels = 131072;
  let nextMarkId = 1;
  const maxSelectionAnchors = 128;
  const maxAnchorPixels = 16384;
  const intersects = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  function labelState(word) {
    for (const label of labels) {
      if (label.startsWith(word)) return {complete:label===word};
      if (!word.startsWith(label)) continue;
      let suffix = word.slice(label.length);
      const count = suffix.match(/^[1-9]\d{0,3}/)?.[0];
      if (count) {
        suffix = suffix.slice(count.length);
        if (/^\d/.test(suffix)) continue;
        if (/^[个项条段份]/.test(suffix)) suffix = suffix.slice(1);
        if (!suffix) return {complete:false};
      } else if (/^\d/.test(suffix)) continue;
      if (subjects.some(subject=>subject.startsWith(suffix))) return {complete:subjects.includes(suffix)};
    }
    return null;
  }

  function state(canvas) {
    let drawing = drawings.get(canvas);
    if (!drawing || drawing.width !== canvas.width || drawing.height !== canvas.height) {
      drawing = {width:canvas.width, height:canvas.height, marks:[], fragment:null, anchors:[], images:[]};
      drawings.set(canvas,drawing);
    }
    return drawing;
  }

  function bounds(ctx, left, top, right, bottom) {
    const matrix = ctx.getTransform();
    if (matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0) return null;
    return {left:matrix.a*left+matrix.e, top:matrix.d*top+matrix.f,
      right:matrix.a*right+matrix.e, bottom:matrix.d*bottom+matrix.f};
  }

  function cssTolerance(canvas, x, y=x) {
    const rect=canvas.getBoundingClientRect();
    const sx=canvas.width/rect.width,sy=canvas.height/rect.height;
    if (![sx,sy].every(value=>Number.isFinite(value)&&value>0)) return null;
    return {x:x*sx,y:y*sy};
  }

  // Only retain the small painted control region, never a resume screenshot.
  // A current pixel comparison also covers drawing APIs we do not intercept
  // (drawImage, putImageData, paths, and calls that bypass our wrappers).
  function readPixels(ctx, rect) {
    if (typeof getImageData!=='function') return null;
    try {
      const image=Reflect.apply(getImageData,ctx,[rect.x,rect.y,rect.width,rect.height]);
      return image?.data?.length===rect.width*rect.height*4 ? image.data : null;
    } catch { return null; }
  }

  function captureEvidence(ctx, mark, painted=false) {
    if (!painted) return null;
    const padding=cssTolerance(ctx.canvas,1);
    if (!padding) return null;
    const x=Math.floor(mark.left-padding.x),y=Math.floor(mark.top-padding.y);
    const right=Math.ceil(mark.right+padding.x),bottom=Math.ceil(mark.bottom+padding.y);
    const rect={x,y,width:right-x,height:bottom-y};
    if (![x,y,right,bottom].every(Number.isFinite) || x<0 || y<0 ||
        right>ctx.canvas.width || bottom>ctx.canvas.height ||
        rect.width<=0 || rect.height<=0 || rect.width*rect.height>maxEvidencePixels) return null;
    const data=readPixels(ctx,rect);
    if (!data) return null;
    // A clipped, transparent, or otherwise invisible paint must not create
    // evidence merely because text metrics described a possible button.
    let varied=false,visible=false;
    for (let index=0;index<data.length;index+=4) {
      if (data[index+3]) visible=true;
      if (data[index]!==data[0] || data[index+1]!==data[1] ||
          data[index+2]!==data[2] || data[index+3]!==data[3]) varied=true;
    }
    if (!visible || !varied) return null;
    return {ctx,rect,width:ctx.canvas.width,height:ctx.canvas.height,
      pixels:new Uint8ClampedArray(data)};
  }

  function currentEvidence(mark, canvas) {
    const evidence=mark.evidence;
    if (!evidence || evidence.ctx.canvas!==canvas ||
        evidence.width!==canvas.width || evidence.height!==canvas.height) return false;
    const current=readPixels(evidence.ctx,evidence.rect);
    if (!current || current.some((value,index)=>value!==evidence.pixels[index])) {
      mark.evidence=null;
      return false;
    }
    return true;
  }


  function pixelRect(ctx, rect, padding, limit=maxAnchorPixels) {
    if (!padding) return null;
    const x=Math.floor(rect.left-padding.x),y=Math.floor(rect.top-padding.y);
    const right=Math.ceil(rect.right+padding.x),bottom=Math.ceil(rect.bottom+padding.y);
    if (![x,y,right,bottom].every(Number.isFinite) || x<0 || y<0 ||
        right>ctx.canvas.width || bottom>ctx.canvas.height || right<=x || bottom<=y ||
        (right-x)*(bottom-y)>limit) return null;
    return {x,y,width:right-x,height:bottom-y};
  }

  function snapshot(ctx, rect) {
    if (!rect) return null;
    const pixels=readPixels(ctx,rect);
    return pixels ? {ctx,rect,width:ctx.canvas.width,height:ctx.canvas.height,
      pixels:new Uint8ClampedArray(pixels)} : null;
  }

  function changedSince(before) {
    if (!before) return false;
    const current=readPixels(before.ctx,before.rect);
    return Boolean(current && current.some((value,index)=>value!==before.pixels[index]));
  }

  // Only the leading glyph of a line is retained privately. Text values are
  // used transiently for metrics; no resume text is stored in this ledger.
  function prepareText(ctx, [value,x,y,maxWidth]) {
    if (typeof value!=='string' || !value.trim() || !ctx.globalAlpha) return null;
    const m=ctx.measureText(value);
    if (maxWidth<m.width) return null;
    const rect=bounds(ctx,x-m.actualBoundingBoxLeft,y-m.actualBoundingBoxAscent,
      x+m.actualBoundingBoxRight,y+m.actualBoundingBoxDescent);
    if (!rect || !Object.values(rect).every(Number.isFinite) ||
        rect.right<=rect.left || rect.bottom<=rect.top) return null;
    const drawing=state(ctx.canvas),padding=cssTolerance(ctx.canvas,1);
    const word=value.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'');
    const fold=Boolean(labelState(word) || drawing.fragment && labelState(drawing.fragment.word+word));
    const matching=drawing.marks.find(mark=>mark.word===word &&
      ['left','top','right','bottom'].every(key=>mark[key]===rect[key]));
    const prepared={rect,fold,foldBefore:fold?snapshot(ctx,pixelRect(ctx,rect,padding,maxEvidencePixels)):null,
      foldReused:Boolean(matching && currentEvidence(matching,ctx.canvas))};
    // Control text, RTL, and unknown composites cannot seed body selection.
    if (fold || ctx.direction==='rtl' || /[\u0590-\u08FF]/.test(value) ||
        ctx.globalCompositeOperation && ctx.globalCompositeOperation!=='source-over') return prepared;
    const first=[...value.trimStart()][0],glyph=ctx.measureText(first);
    const matrix=ctx.getTransform();
    const glyphWidth=Math.min(rect.right-rect.left,
      Math.max(glyph.width,glyph.actualBoundingBoxLeft+glyph.actualBoundingBoxRight)*matrix.a);
    const seed={left:rect.left,top:rect.top,right:rect.left+glyphWidth,bottom:rect.bottom};
    const align=ctx.textAlign;
    const advanceLeft=matrix.a*(x-(align==='center'?m.width/2:align==='right'||align==='end'?m.width:0))+matrix.e;
    const caretLeft=Math.min(seed.left,advanceLeft);
    const inside=cssTolerance(ctx.canvas,1);
    if(!inside || !Number.isFinite(caretLeft) || caretLeft<0) return prepared;
    const gutter=Math.min(inside.x,glyph.width*matrix.a/8);
    let startX=Math.max(0,caretLeft-gutter);
    const corridor=left=>({...seed,left});
    if(drawing.images.some(image=>intersects(image,corridor(startX))))startX=caretLeft;
    if(drawing.images.some(image=>intersects(image,corridor(startX))))return prepared;
    // Neighboring italic/bold glyphs may overhang the preceding advance cell.
    // Keep a real-paint witness in the leading half, not the overlapping tail,
    // so a legitimate next glyph does not erase the first character's anchor.
    const proof={...seed,left:startX,right:seed.left+(seed.right-seed.left)/2};
    const evidenceRect=pixelRect(ctx,proof,cssTolerance(ctx.canvas,0));
    if (!evidenceRect) return prepared;
    const existing=drawing.anchors.find(anchor=>
      ['left','top','right','bottom'].every(key=>anchor.seed[key]===seed[key]));
    prepared.seed=seed;prepared.startX=startX;
    prepared.anchorBefore=snapshot(ctx,evidenceRect);
    prepared.anchorReused=Boolean(existing && currentEvidence(existing,ctx.canvas));
    prepared.anchorId=existing?.id;
    return prepared;
  }

  function noteSelectionText(ctx, prepared) {
    if (!prepared?.rect) return;
    const drawing=state(ctx.canvas),rect=prepared.rect;
    const seed=prepared.seed;
    const sameSeed=anchor=>seed && ['left','top','right','bottom'].every(key=>anchor.seed[key]===seed[key]);
    // A text repaint over a previous leading glyph invalidates it unless the
    // new paint has independently retained that exact leading-glyph witness.
    drawing.anchors=drawing.anchors.filter(anchor=>{
      const patch=anchor.evidence?.rect;
      const proof=patch?{left:patch.x,top:patch.y,right:patch.x+patch.width,bottom:patch.y+patch.height}:anchor.seed;
      return !intersects(proof,rect)||sameSeed(anchor);
    });
    if (!seed || !(prepared.anchorReused || changedSince(prepared.anchorBefore))) return;
    const evidence=snapshot(ctx,prepared.anchorBefore?.rect);
    if (!evidence || drawing.images.some(image=>intersects(image,{...seed,left:prepared.startX}))) return;
    const gap=cssTolerance(ctx.canvas,8,4),inside=cssTolerance(ctx.canvas,1);
    if (!gap || !inside) return;
    const candidate={...rect,seed,evidence,id:prepared.anchorId || nextMarkId++,
      x:seed.left+Math.min(inside.x,(seed.right-seed.left)/4),y:(seed.top+seed.bottom)/2,
      startX:prepared.startX,safeLeft:prepared.startX};
    const sameLine=drawing.anchors.filter(anchor=>
      Math.max(anchor.top,rect.top)<Math.min(anchor.bottom,rect.bottom) &&
      Math.abs(anchor.top-rect.top)<=gap.y && Math.abs(anchor.bottom-rect.bottom)<=gap.y &&
      rect.left<=anchor.right+gap.x && rect.right>=anchor.left-gap.x);
    if (sameLine.length) {
      const leading=[candidate,...sameLine].sort((a,b)=>a.seed.left-b.seed.left)[0];
      candidate.left=Math.min(rect.left,...sameLine.map(anchor=>anchor.left));
      candidate.right=Math.max(rect.right,...sameLine.map(anchor=>anchor.right));
      candidate.top=Math.min(rect.top,...sameLine.map(anchor=>anchor.top));
      candidate.bottom=Math.max(rect.bottom,...sameLine.map(anchor=>anchor.bottom));
      candidate.seed=leading.seed;candidate.evidence=leading.evidence;candidate.id=leading.id;
      candidate.x=leading.x;candidate.y=leading.y;
      candidate.startX=leading.startX;candidate.safeLeft=leading.safeLeft;
      drawing.anchors=drawing.anchors.filter(anchor=>!sameLine.includes(anchor));
    }
    drawing.anchors.push(candidate);
    // Bound memory. Retain the first line for returning to the header and the
    // most recently painted lines for scrolling / virtualized resume views.
    if (drawing.anchors.length>maxSelectionAnchors) {
      const first=drawing.anchors.reduce((a,b)=>a.top<b.top || a.top===b.top&&a.left<b.left?a:b);
      drawing.anchors.splice(drawing.anchors[0]===first?1:0,1);
    }
  }

  function rememberImage(drawing,rect) {
    const contains=(a,b)=>a.left<=b.left&&a.top<=b.top&&a.right>=b.right&&a.bottom>=b.bottom;
    if(drawing.images.some(image=>contains(image,rect)))return;
    drawing.images=drawing.images.filter(image=>!contains(rect,image));
    drawing.images.push(rect);
    if(drawing.images.length>128)drawing.images=[{
      left:0,top:0,right:drawing.width,bottom:drawing.height}];
  }

  function imagePaint(ctx,args) {
    const drawing=state(ctx.canvas);
    const image=args[0];
    let x,y,width,height;
    if (args.length===3) {
      [,x,y]=args;width=image?.videoWidth||image?.naturalWidth||image?.width;
      height=image?.videoHeight||image?.naturalHeight||image?.height;
    } else if (args.length===5) [,x,y,width,height]=args;
    else if (args.length===9) [,,,,,x,y,width,height]=args;
    else return;
    const rect=bounds(ctx,Math.min(x,x+width),Math.min(y,y+height),
      Math.max(x,x+width),Math.max(y,y+height));
    if (!rect || !Object.values(rect).every(Number.isFinite)) {
      drawing.anchors=[];
      drawing.images=[{left:0,top:0,right:ctx.canvas.width,bottom:ctx.canvas.height}];
      return;
    }
    drawing.anchors=drawing.anchors.filter(anchor=>!intersects(anchor,rect));
    rememberImage(drawing,rect);
  }

  function eraseSelection(ctx,args) {
    const drawing=drawings.get(ctx.canvas);
    if (!drawing) return;
    const [x,y,width,height]=args;
    const rect=bounds(ctx,Math.min(x,x+width),Math.min(y,y+height),
      Math.max(x,x+width),Math.max(y,y+height));
    if (!rect) {drawing.anchors=[];return;}
    drawing.anchors=drawing.anchors.filter(anchor=>!intersects(anchor,rect));
    // clearRect/fillRect can be clipped or composited. Geometry alone cannot
    // prove a prior avatar was erased; retain image exclusions until a real
    // canvas reset or backing-size change starts a new drawing ledger.
  }

  function noteText(ctx, [value,x,y,maxWidth], prepared) {
    const drawing = state(ctx.canvas);
    const word = typeof value === 'string' ? value.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'') : '';
    if (!word || !ctx.globalAlpha) {
      drawing.fragment = null;
      return;
    }
    const m = ctx.measureText(value);
    if (maxWidth < m.width) {drawing.fragment=null;return;}
    const rect = bounds(ctx,x-m.actualBoundingBoxLeft,y-m.actualBoundingBoxAscent,
      x+m.actualBoundingBoxRight,y+m.actualBoundingBoxDescent);
    if (!rect || !Object.values(rect).every(Number.isFinite) || rect.right <= rect.left || rect.bottom <= rect.top) {
      drawing.fragment=null;return;
    }
    // A new text paint can cover an old button without a clearRect. Preserve
    // only an identical redraw, so polling a stable button keeps its mark ID.
    drawing.marks=drawing.marks.filter(old=>!intersects(old,rect)||
      old.word===word&&['left','top','right','bottom'].every(key=>old[key]===rect[key]));
    // Text metrics are in backing pixels after getTransform(), whereas the
    // permitted baseline/glyph gaps are visual CSS pixels. Zoom/DPR must not
    // shrink those tolerances or join previously separate words.
    const gap=cssTolerance(ctx.canvas,8,4),same=cssTolerance(ctx.canvas,3);
    if (!gap || !same) {drawing.fragment=null;return;}
    const fragment = drawing.fragment;
    let mark = {word,...rect,painted:Boolean(prepared?.foldReused || changedSince(prepared?.foldBefore))};
    if (fragment && Math.abs(fragment.top-rect.top) <= gap.y &&
        Math.abs(fragment.right-rect.left) <= gap.x && labelState(fragment.word+word)) {
      mark = {word:fragment.word+word,left:fragment.left,right:rect.right,
        top:Math.min(fragment.top,rect.top),bottom:Math.max(fragment.bottom,rect.bottom),
        painted:fragment.painted&&mark.painted};
      drawing.marks = drawing.marks.filter(old=>!(mark.word.startsWith(old.word) &&
        Math.abs(old.left-mark.left)<same.x && Math.abs(old.top-mark.top)<same.y));
    }
    const status = labelState(mark.word);
    drawing.fragment = status ? mark : null;
    if (!status?.complete) return;
    const evidence=captureEvidence(ctx,mark,mark.painted);
    const existing=drawing.marks.find(old => old.word === mark.word &&
      Math.abs(old.left-mark.left) < same.x && Math.abs(old.top-mark.top) < same.y);
    if (existing) existing.evidence=evidence;
    else {
      drawing.marks.push({...mark,id:nextMarkId++,evidence});
      if (drawing.marks.length > 32) drawing.marks.shift();
    }
  }

  function erase(ctx, [x,y,width,height]) {
    const drawing = drawings.get(ctx.canvas);
    if (!drawing) return;
    const rect = bounds(ctx,Math.min(x,x+width),Math.min(y,y+height),Math.max(x,x+width),Math.max(y,y+height));
    if (!rect) return;
    // A partly covered label is no longer a complete clickable label either.
    drawing.marks = drawing.marks.filter(mark => !intersects(mark,rect));
    drawing.fragment = null;
  }

  function wrap(name, observe, before=null) {
    const original = proto[name];
    if (typeof original !== 'function') return;
    const wrapped = function(...args) {
      let prepared;
      try { prepared=before?.(this,args); } catch {}
      const result = Reflect.apply(original,this,args);
      try { observe(this,args,prepared); } catch {}
      return result;
    };
    originals.set(name,{original,wrapped});
    proto[name] = wrapped;
  }

  const observedText=(ctx,args,prepared)=>{noteText(ctx,args,prepared);noteSelectionText(ctx,prepared);};
  wrap('fillText',observedText,prepareText);
  wrap('strokeText',observedText,prepareText);
  wrap('clearRect',(ctx,args)=>{erase(ctx,args);eraseSelection(ctx,args);});
  wrap('drawImage',imagePaint);
  wrap('putImageData',(ctx,[image,x,y,dirtyX=0,dirtyY=0,dirtyWidth=image?.width,dirtyHeight=image?.height])=>{
    const drawing=state(ctx.canvas);
    const left=Math.max(0,Math.min(dirtyX,dirtyX+dirtyWidth));
    const top=Math.max(0,Math.min(dirtyY,dirtyY+dirtyHeight));
    const right=Math.min(image?.width,Math.max(dirtyX,dirtyX+dirtyWidth));
    const bottom=Math.min(image?.height,Math.max(dirtyY,dirtyY+dirtyHeight));
    if(![x,y,left,top,right,bottom].every(Number.isFinite)) {drawing.anchors=[];return;}
    if(right<=left||bottom<=top)return;
    const rect={left:x+left,top:y+top,right:x+right,bottom:y+bottom};
    drawing.anchors=drawing.anchors.filter(anchor=>!intersects(anchor,rect));
    rememberImage(drawing,rect);
  });
  wrap('fillRect',(ctx,args) => {
    // A background repaint may erase a label without calling clearRect.
    if (ctx.globalAlpha === 1 && typeof ctx.fillStyle === 'string' && /^#[0-9a-f]{6}$/i.test(ctx.fillStyle)) {
      erase(ctx,args);eraseSelection(ctx,args);
    }
  });
  wrap('reset',ctx => drawings.delete(ctx.canvas));

  function readMarks(sourceCanvas=null,verified=false) {
    const canvases = sourceCanvas?[sourceCanvas]:[...document.querySelectorAll('canvas')].filter(canvas => {
      const rect = canvas.getBoundingClientRect(), style = getComputedStyle(canvas);
      return rect.width >= 250 && rect.height >= 150 && style.visibility === 'visible' && Number(style.opacity) > 0;
    });
    if (canvases.length !== 1) return [];
    const drawing = sourceCanvas?drawings.get(sourceCanvas):state(canvases[0]);
    if(!drawing||drawing.width!==canvases[0].width||drawing.height!==canvases[0].height)return [];
    return drawing.marks.filter(mark=>!verified || currentEvidence(mark,canvases[0]) &&
      !drawing.images.some(image=>intersects(image,mark))).map(mark => ({
      id:mark.id, label:mark.word, x:(mark.left+mark.right)/(2*drawing.width), y:(mark.top+mark.bottom)/(2*drawing.height),
      left:mark.left/drawing.width, top:mark.top/drawing.height,
      right:mark.right/drawing.width, bottom:mark.bottom/drawing.height
    }));
  }

  window.__hrmExpandMarks = {
    version:7,
    read(sourceCanvas=null) { return readMarks(sourceCanvas); },
    readVerified(sourceCanvas=null) { return readMarks(sourceCanvas,true); },
    readSelectionAnchors(sourceCanvas=null) {
      const canvases=sourceCanvas?[sourceCanvas]:[...document.querySelectorAll('canvas')].filter(canvas=>{
        const rect=canvas.getBoundingClientRect(),style=getComputedStyle(canvas);
        return rect.width>=250&&rect.height>=150&&style.visibility==='visible'&&Number(style.opacity)>0;
      });
      if(canvases.length!==1)return [];
      const canvas=canvases[0],drawing=drawings.get(canvas);
      if(!drawing||drawing.width!==canvas.width||drawing.height!==canvas.height)return [];
      return drawing.anchors.filter(anchor=>currentEvidence(anchor,canvas)&&
        !drawing.images.some(image=>intersects(image,{...anchor.seed,left:anchor.safeLeft})))
        .sort((a,b)=>a.top-b.top||a.left-b.left).map(anchor=>({
          id:anchor.id,x:anchor.x/drawing.width,y:anchor.y/drawing.height,
          startX:anchor.startX/drawing.width,safeLeft:anchor.safeLeft/drawing.width,
          left:anchor.seed.left/drawing.width,top:anchor.seed.top/drawing.height,
          right:anchor.seed.right/drawing.width,bottom:anchor.seed.bottom/drawing.height
        }));
    },
    stop() {
      for (const [name,{original,wrapped}] of originals) {
        if (proto[name] === wrapped) proto[name] = original;
      }
      delete window.__hrmExpandMarks;
    }
  };
})();
