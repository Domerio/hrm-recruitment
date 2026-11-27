import {isBoss,resumeFoldLabels,discoverResumeHeaderIdentity} from './capture-utils.mjs';
import {visualExpandMarks} from './visual-expand.mjs';
import {createClipboardProof,proveWholeClipboard,hasTerminalClipboard,hasClipboardHeader,
  normalizeClipboardProofText} from './copy-proof.mjs';

// Mark only the page's own trusted copy event, without changing visible text.
// A per-attempt HTML comment lets LAN clients distinguish identical new copies
// from an unchanged clipboard. The comment is removed before returning content.
export function observeCopyClipboard(action,nonce='') {
  const key='__hrmClipboardCopyWitness';
  const prior=window[key];
  if (action==='cleanup' || action==='arm') {
    if (prior) {
      window.removeEventListener('copy',prior.listener);
      if (prior.timer) window.clearTimeout(prior.timer);
    }
    delete window[key];
  }
  if (action==='cleanup') return null;
  if (location.protocol!=='https:' || !['www.zhipin.com','zhipin.com'].includes(location.hostname) ||
      !/^\/web\/frame\/c-resume\/?$/.test(location.pathname)) return null;
  const canvas=window.__hrmCopyScroll?.canvas;
  if (!canvas || canvas.isConnected===false) return null;
  if (action==='read') return prior?.canvas===canvas ? prior.result : null;
  if (action!=='arm' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(nonce) ||
      !document.hasFocus() || document.activeElement!==canvas) return false;
  const witness={canvas,result:null,listener:null,timer:null};
  const marker='<!--hrm-copy:'+nonce+'-->';
  witness.listener=event=>{
    if (!event.isTrusted || !event.defaultPrevented || !document.hasFocus() ||
        document.activeElement!==canvas || canvas.isConnected===false ||
        window.__hrmCopyScroll?.canvas!==canvas) return;
    // Read synchronously after the page's handler. The event alone is not
    // proof: its marker must subsequently arrive in the real clipboard.
    try {
      const resume=event.clipboardData?.getData('text/plain') || '';
      const resume_html=event.clipboardData?.getData('text/html') || '';
      if (!resume.trim() && !resume_html.trim()) return;
      const escape=value=>value.replace(/[&<>]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[ch]);
      event.clipboardData.setData('text/html',(resume_html || '<pre>'+escape(resume)+'</pre>')+marker);
      witness.result={resume,resume_html,marker};
      window.removeEventListener('copy',witness.listener);
    } catch {
      // Some copy handlers do not expose writable event data. In that case
      // retain the ordinary changed-content check.
    }
  };
  window[key]=witness;
  window.addEventListener('copy',witness.listener);
  // The collector can close before its finally block runs.
  if (typeof window.setTimeout==='function') witness.timer=window.setTimeout(()=>{
    window.removeEventListener('copy',witness.listener);
    if (window[key]===witness) delete window[key];
    witness.result=null;
  },5000);
  return true;
}

// Injected as an isolated-world function. Only inspect the resume surface and focus it.
export function inspectCopyFrame(action, marks=[]) {
  if (location.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(location.hostname)
      || !/^\/web\/frame\/c-resume\/?$/.test(location.pathname)) return null;
  if (action === 'cleanup') {
    const canvas = window.__hrmCopyFocusable;
    if (canvas?.getAttribute('tabindex') === '-1') canvas.removeAttribute('tabindex');
    const scroll = window.__hrmCopyScroll;
    const owners=scroll?.owners || (scroll?.element?[scroll]:[]);
    for (const owner of [...owners].reverse()) {
      if (owner.element.isConnected) owner.element.scrollTop=owner.top;
    }
    for (const owner of [...(scroll?.horizontalOwners||[])].reverse()) {
      if (owner.element.isConnected) owner.element.scrollLeft=owner.left;
    }
    delete window.__hrmCopyFocusable;
    delete window.__hrmCopyScroll;
    return null;
  }
  if (/请完成安全验证|访问过于频繁|拖动滑块|账号异常/.test(document.body?.innerText || '')) return null;
  const canvases = [...document.querySelectorAll('canvas')].filter(canvas => {
    const rect = canvas.getBoundingClientRect(), style = getComputedStyle(canvas);
    return rect.width >= 250 && rect.height >= 150 && style.visibility === 'visible' && Number(style.opacity) > 0;
  });
  if (canvases.length !== 1) return null;
  const canvas = canvases[0], rect = canvas.getBoundingClientRect();
  const session = window.__hrmCopyScroll;
  if (session && (session.canvas !== canvas || !session.owners ||
      session.owners.some(owner=>owner.element.isConnected===false))) return null;
  let left=rect.left, right=rect.right, top=rect.top, bottom=rect.bottom;
  let offsetX=0, offsetY=0;
  let blankTransformSafe=true,blankBoxSafe=true;
  const owners=[], horizontalOwners=[], frames=[];
  const addOwner=element=>{
    if (element && element.clientHeight>=150 && !owners.includes(element)) owners.push(element);
  };
  const addHorizontalOwner=(element,doc)=>{
    if(element&&element.clientWidth>0&&Number.isFinite(element.scrollLeft)&&
        !horizontalOwners.some(owner=>owner.element===element))horizontalOwners.push({element,doc});
  };
  const clip=(x1,y1,x2,y2)=>{
    left=Math.max(left,x1);top=Math.max(top,y1);
    right=Math.min(right,x2);bottom=Math.min(bottom,y2);
  };
  try {
    let child=window, anchor=canvas;
    for (let depth=0;depth<10;depth++) {
      const doc=child===window?document:child.document;
      const width=child===window?innerWidth:child.innerWidth;
      const height=child===window?innerHeight:child.innerHeight;
      const styleOf=child===window?getComputedStyle:element=>child.getComputedStyle(element);
      clip(0,0,width,height);
      let fixed=false;
      for (let ancestor=anchor;ancestor;ancestor=ancestor.parentElement) {
        const style=styleOf(ancestor);
        // A CSS-clipped vertical strip corresponds to a bitmap strip only
        // through positive, axis-aligned transforms all the way to the top.
        try{
          if(style.perspective&&style.perspective!=='none')blankTransformSafe=false;
          if(style.rotate&&style.rotate!=='none'&&!/^0(?:deg|rad|turn)?$/.test(style.rotate))blankTransformSafe=false;
          if(style.scale&&style.scale!=='none'){
            const scale=style.scale.trim().split(/\s+/).map(Number);
            if(scale.length>2||scale.some(value=>!Number.isFinite(value)||value<=0))blankTransformSafe=false;
          }
          if(style.transform&&style.transform!=='none'){
            const matrix=new DOMMatrixReadOnly(style.transform);
            if(!matrix.is2D||matrix.b||matrix.c||matrix.a<=0||matrix.d<=0)blankTransformSafe=false;
          }
        }catch{blankTransformSafe=false;}
        if(ancestor===canvas){
          const edges=['borderLeftWidth','borderRightWidth','borderTopWidth','borderBottomWidth',
            'paddingLeft','paddingRight','paddingTop','paddingBottom'];
          if(edges.some(key=>Number.parseFloat(style[key]||'0')!==0)||style.objectFit&&style.objectFit!=='fill')blankBoxSafe=false;
        }
        // A fixed descendant escapes ordinary overflow ancestors up to its
        // containing block. In particular, a fixed resume dialog is not clipped
        // by a shorter, scroll-locked body behind it. Transformed/contained
        // ancestors do establish a fixed containing block and must still clip.
        const establishesFixedBlock=['transform','perspective','filter','backdropFilter'].some(key=>
          style[key] && style[key]!=='none') || /\b(?:layout|paint|strict|content)\b/.test(style.contain||'') ||
          /(?:^|,)\s*(?:transform|perspective|filter|backdrop-filter|contain)\s*(?:,|$)/.test(style.willChange||'') ||
          style.contentVisibility==='auto' || (style.containerType && style.containerType!=='normal');
        if (fixed && establishesFixedBlock) fixed=false;
        if (!fixed && ancestor!==canvas && ancestor!==doc.scrollingElement) {
          const clipX=/^(auto|scroll|hidden|clip)$/.test(style.overflowX);
          const clipY=/^(auto|scroll|hidden|clip)$/.test(style.overflowY);
          if (clipX || clipY) {
            const bounds=ancestor.getBoundingClientRect();
            const scaleX=ancestor.offsetWidth?bounds.width/ancestor.offsetWidth:1;
            const scaleY=ancestor.offsetHeight?bounds.height/ancestor.offsetHeight:1;
            const clientLeft=bounds.left+ancestor.clientLeft*scaleX;
            const clientTop=bounds.top+ancestor.clientTop*scaleY;
            clip(clipX?clientLeft:-Infinity,clipY?clientTop:-Infinity,
              clipX?clientLeft+ancestor.clientWidth*scaleX:Infinity,
              clipY?clientTop+ancestor.clientHeight*scaleY:Infinity);
          }
        }
        if (!fixed && ancestor!==canvas && /^(auto|scroll)$/.test(style.overflowY)) addOwner(ancestor);
        if (!fixed && ancestor!==canvas && /^(auto|scroll)$/.test(style.overflowX)) addHorizontalOwner(ancestor,doc);
        if (style.position==='fixed') fixed=true;
      }
      if (!fixed && doc.scrollingElement &&
          !/^(hidden|clip)$/.test(styleOf(doc.scrollingElement).overflowY)) addOwner(doc.scrollingElement);
      if (!fixed && doc.scrollingElement &&
          !/^(hidden|clip)$/.test(styleOf(doc.scrollingElement).overflowX)) addHorizontalOwner(doc.scrollingElement,doc);
      if (child===child.top) break;
      if (depth===9) return null;
      const frame=child.frameElement;
      if (!frame || frame.isConnected===false) return null;
      const bounds=frame.getBoundingClientRect();
      if (Math.abs(bounds.width-frame.offsetWidth)>2 || Math.abs(bounds.height-frame.offsetHeight)>2) return null;
      frames.push(frame);
      const x=bounds.left+frame.clientLeft, y=bounds.top+frame.clientTop;
      left+=x;right+=x;top+=y;bottom+=y;offsetX+=x;offsetY+=y;
      anchor=frame;child=child.parent;
    }
  } catch {
    return null;
  }
  if (session && (session.owners.length!==owners.length ||
      session.owners.some((owner,index)=>owner.element!==owners[index]) ||
      session.frames.length!==frames.length || session.frames.some((frame,index)=>frame!==frames[index]) ||
      (session.horizontalOwners||[]).length!==horizontalOwners.length ||
      (session.horizontalOwners||[]).some((owner,index)=>owner.element!==horizontalOwners[index].element||owner.doc!==horizontalOwners[index].doc))) return null;
  if (right - left < 250 || bottom - top < 150) return null;

  if(action==='align-horizontal'){
    if(!session)return null;
    for(const owner of horizontalOwners){
      // Recompute after each inner scroll. A parent's coordinates may change
      // with that scroll, but only the already-bound frame chain is followed.
      const fresh=canvas.getBoundingClientRect();let x1=fresh.left,x2=fresh.right;
      try{
        for(let child=window,depth=0;(child===window?document:child.document)!==owner.doc;child=child.parent,depth++){
          if(depth>=frames.length||child.frameElement!==frames[depth])return null;
          const box=child.frameElement.getBoundingClientRect(),shift=box.left+child.frameElement.clientLeft;
          x1+=shift;x2+=shift;
        }
        const element=owner.element,box=element.getBoundingClientRect();
        const scale=element.offsetWidth?box.width/element.offsetWidth:1;
        const viewportLeft=element===owner.doc.scrollingElement?0:box.left+element.clientLeft*scale;
        const viewportRight=viewportLeft+element.clientWidth*scale;
        let delta=0;
        if(x1<viewportLeft-2)delta=x1-viewportLeft;
        else if(x2>viewportRight+2)delta=x2-x1>viewportRight-viewportLeft?x1-viewportLeft:x2-viewportRight;
        if(Number.isFinite(delta)&&Number.isFinite(scale)&&scale>0&&Math.abs(delta)>2)element.scrollLeft+=delta/scale;
      }catch{return null;}
    }
    return inspectCopyFrame('probe');
  }

  function mapPoint(x, y) {
    if (document.elementFromPoint(x, y) !== canvas) return null;
    try {
      for (let child = window; child !== child.top; child = child.parent) {
        const frame = child.frameElement;
        if (!frame) return null;
        const bounds = frame.getBoundingClientRect();
        if (Math.abs(bounds.width - frame.offsetWidth) > 2 || Math.abs(bounds.height - frame.offsetHeight) > 2) return null;
        x += bounds.left + frame.clientLeft;
        y += bounds.top + frame.clientTop;
        if (frame.ownerDocument.elementFromPoint(x, y) !== frame) return null;
      }
    } catch {
      return null;
    }
    return {x, y};
  }

  if (action === 'tail-point') {
    if (!session) return null;
    const x=right-18-offsetX, normalY=bottom-10-offsetY;
    const normal=mapPoint(x,normalY);
    if (!normal) return null;
    const limit=Math.min(rect.bottom-2,innerHeight-2,normalY+240);
    let lower=null;
    for (let y=normalY+8;y<=limit;y+=8) {
      const point=mapPoint(x,y);
      if (point) lower=point;
    }
    return lower && lower.y>=normal.y+16 ? lower : null;
  }

  if (action === 'expand-points' || action === 'selection-points') {
    const transform = getComputedStyle(canvas).transform;
    if (transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(transform);
      if (!matrix.is2D || matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0) return [];
    }
    if(action==='selection-points'){
      return marks.flatMap(mark=>{
        const values=['x','y','left','top','right','bottom'];
        if(!Number.isSafeInteger(mark.id) || !values.every(key=>Number.isFinite(mark[key])) ||
            mark.left<0 || mark.top<0 || mark.right>1 || mark.bottom>1 ||
            !(mark.left<mark.x && mark.x<mark.right && mark.top<mark.y && mark.y<mark.bottom))return [];
        const hasCaret=mark.startX!==undefined || mark.safeLeft!==undefined;
        if(hasCaret && (!Number.isFinite(mark.startX) || !Number.isFinite(mark.safeLeft) ||
            mark.safeLeft<0 || mark.safeLeft>mark.startX || mark.startX>mark.left))return [];
        // The observer proves the narrow corridor leading to the first glyph.
        // Starting inside a glyph can omit it in the platform's caret hit test.
        const x=rect.left+rect.width*(hasCaret?mark.startX:mark.x),y=rect.top+rect.height*mark.y;
        const bounds={left:rect.left+rect.width*(hasCaret?mark.safeLeft:mark.left)+offsetX,
          top:rect.top+rect.height*mark.top+offsetY,
          right:rect.left+rect.width*mark.right+offsetX,
          bottom:rect.top+rect.height*mark.bottom+offsetY};
        // The whole text glyph must be visible. A canvas hit alone cannot
        // distinguish the resume's text from its clickable avatar pixels.
        if(bounds.left<left || bounds.top<top || bounds.right>right || bounds.bottom>bottom)return [];
        const point=mapPoint(x,y);
        return point?[{mark,point}]:[];
      }).sort((a,b)=>a.mark.top-b.mark.top || a.mark.left-b.mark.left);
    }
    return marks.flatMap(mark => {
      const label=typeof mark.label==='string'?mark.label.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,''):'';
      const allowed=/^(?:查看全部|展开全部|查看更多)(?:(?:[1-9]\d{0,3}(?:个|项|条|段|份)?)?(?:个人优势|个人简介|期望职位|工作经历|工作经验|项目经历|项目经验|教育经历|教育背景|资格证书|专业技能|所获荣誉|荣誉奖项|获奖经历|荣誉|语言能力))?$/;
      if (!Number.isSafeInteger(mark.id) || !allowed.test(label) ||
          !(mark.x > 0 && mark.x < 1 && mark.y > 0 && mark.y < 1)) return [];
      const edges=['left','top','right','bottom'];
      if(edges.some(key=>Object.hasOwn(mark,key))){
        if(!edges.every(key=>Number.isFinite(mark[key]))||mark.left<0||mark.top<0||mark.right>1||mark.bottom>1||
            !(mark.left<mark.x&&mark.x<mark.right&&mark.top<mark.y&&mark.y<mark.bottom))return [];
        const bounds={left:rect.left+rect.width*mark.left+offsetX,top:rect.top+rect.height*mark.top+offsetY,
          right:rect.left+rect.width*mark.right+offsetX,bottom:rect.top+rect.height*mark.bottom+offsetY};
        if(bounds.left<left||bounds.top<top||bounds.right>right||bounds.bottom>bottom)return [];
      }
      const point = mapPoint(rect.left+rect.width*mark.x,rect.top+rect.height*mark.y);
      return point ? [{mark:{...mark,label},point}] : [];
    });
  }

  const center = mapPoint((left+right)/2-offsetX,(top+bottom)/2-offsetY);
  if (!center) return null;
  // This corner describes the measured viewport, not a permitted mouse-down.
  // Every actual drag still starts at a fresh verified text anchor.
  const start = {x:left+10,y:top+10}, startHit=Boolean(mapPoint(left+10-offsetX,top+10-offsetY));
  const end = mapPoint(right-18-offsetX,bottom-10-offsetY);
  if (action === 'focus') {
    if (!window.__hrmCopyScroll) {
      window.__hrmCopyScroll={canvas,frames,owners:owners.map(element=>({element,top:element.scrollTop})),
        horizontalOwners:horizontalOwners.map(owner=>({...owner,left:owner.element.scrollLeft}))};
    }
    if (!canvas.hasAttribute('tabindex')) {
      canvas.setAttribute('tabindex', '-1');
      window.__hrmCopyFocusable = canvas;
    }
    canvas.focus({preventScroll: true});
  }
  const measured=Boolean(window.__hrmCopyScroll);
  const scrollChain=owners.map((element,index)=>({index,scrollTop:element.scrollTop,
    clientHeight:element.clientHeight,scrollHeight:element.scrollHeight}));
  const range=scrollChain.reduce((sum,owner)=>sum+Math.max(0,owner.scrollHeight-owner.clientHeight),0);
  const viewport=bottom-top;
  const clipLeft=Math.max(0,left-rect.left-offsetX),clipRight=Math.max(0,rect.right+offsetX-right);
  const blankMargin=(side,clipped)=>{
    const rejected=(reason,pixels=0)=>({ok:false,reason,pixels});
    if(clipped<=2)return rejected('not_needed');
    if(!Number.isFinite(clipped)||clipped>32)return rejected('too_wide');
    if(!blankTransformSafe)return rejected('transform');
    if(!blankBoxSafe)return rejected('box_model');
    try{
      const width=canvas.width,height=canvas.height,scale=width/rect.width;
      if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||!Number.isFinite(scale)||scale<=0)
        return rejected('unavailable');
      const x=side==='left'?0:Math.max(0,Math.floor(width-(clipped+2)*scale));
      const endX=side==='left'?Math.min(width,Math.ceil((clipped+2)*scale)):width;
      const pixels=(endX-x)*height;
      if(pixels<1||pixels>1000000)return rejected('budget',pixels);
      const ctx=canvas.getContext('2d');
      if(!ctx)return rejected('unavailable',pixels);
      const image=ctx.getImageData(x,0,endX-x,height),data=image.data;
      if(data.length!==pixels*4)return rejected('unavailable',pixels);
      const alpha=data[3];if(alpha!==0&&alpha!==255)return rejected('nonuniform',pixels);
      for(let index=0;index<data.length;index+=4){
        if(data[index+3]!==alpha||alpha===255&&
            (data[index]!==data[0]||data[index+1]!==data[1]||data[index+2]!==data[2]))return rejected('nonuniform',pixels);
      }
      return {ok:true,reason:alpha===0?'transparent':'uniform_opaque',pixels};
    }catch{return rejected('unavailable');}
  };
  // Every probe samples the complete backing height anew, including portions
  // below this viewport. A prior blank strip never authorizes a later repaint.
  const marginLeft=blankMargin('left',clipLeft),marginRight=blankMargin('right',clipRight);
  const widthVisible=(clipLeft<=2||marginLeft.ok)&&(clipRight<=2||marginRight.ok);
  const surface={focused: document.hasFocus(), canvasFocused: document.activeElement === canvas, center, start, end,startHit,endHit:Boolean(end),
    scrollMeasured:measured, scrollMode:range>4?'native':'stationary', scrollChain,
    scrollTop:measured?scrollChain.reduce((sum,owner)=>sum+owner.scrollTop,0):null,
    clientHeight:measured?viewport:null, scrollHeight:measured?viewport+range:null,
    contentTopVisible: top <= rect.top+offsetY+2, contentBottomVisible: bottom >= rect.bottom+offsetY-2,
    contentWidthVisible:widthVisible};
  const numeric=value=>Number.isFinite(value)?value:null;
  const geometryValid=measured&&[surface.scrollTop,surface.clientHeight,surface.scrollHeight].every(Number.isFinite)&&
    surface.clientHeight>=150&&surface.scrollHeight>=surface.clientHeight-4&&surface.scrollTop>=-4&&
    surface.scrollTop<=surface.scrollHeight-surface.clientHeight+4;
  surface.diagnostics={reason:!surface.focused||!surface.canvasFocused?'focus_missing':!geometryValid?'scroll_metrics_invalid':
    !end?'end_hit_missing':!widthVisible?'width_clipped':'ok',clipLeft,clipRight,startHit,endHit:Boolean(end),
    canvasRect:{left:rect.left+offsetX,top:rect.top+offsetY,right:rect.right+offsetX,bottom:rect.bottom+offsetY,width:rect.width,height:rect.height},
    visibleRect:{left,top,right,bottom,width:right-left,height:bottom-top},
    scrollTop:numeric(surface.scrollTop),clientHeight:numeric(surface.clientHeight),scrollHeight:numeric(surface.scrollHeight),scrollMode:surface.scrollMode,
    marginProof:{left:marginLeft.ok,right:marginRight.ok},marginReason:{left:marginLeft.reason,right:marginRight.reason},
    marginPixels:{left:marginLeft.pixels,right:marginRight.pixels}};
  return surface;
}

function canvasExpandMarks() {
  return window.__hrmExpandMarks?.read() || [];
}

function canvasVerifiedExpandMarks() {
  return window.__hrmExpandMarks?.readVerified?.() || [];
}

function canvasSelectionAnchors() {
  return window.__hrmExpandMarks?.readSelectionAnchors?.() || [];
}

export async function readClipboardResume(clipboard) {
  const items = await clipboard.read();
  const item = items.find(entry => entry.types.includes('text/html'))
    || items.find(entry => entry.types.includes('text/plain'));
  const read = async type => item?.types.includes(type) ? (await item.getType(type)).text() : '';
  return {resume: await read('text/plain'), resume_html: await read('text/html')};
}

const sameClipboard = (a,b) => a.resume === b.resume && a.resume_html === b.resume_html;
const clipboardText = item => item.resume || item.resume_html.replace(/<[^>]*>/g, ' ');
const normalizedText = item => clipboardText(item).replace(/\s/g, '');

function scrollGeometry(surface) {
  if (!surface?.scrollMeasured) return null;
  const {scrollTop, clientHeight, scrollHeight} = surface;
  if (![scrollTop,clientHeight,scrollHeight].every(Number.isFinite) || clientHeight < 150 ||
      scrollHeight < clientHeight - 4 || scrollTop < -4 || scrollTop > scrollHeight - clientHeight + 4) return null;
  return {scrollTop,clientHeight,scrollHeight};
}
const atBottom = geometry => geometry.scrollTop + geometry.clientHeight >= geometry.scrollHeight - 4;
const sameGeometry = (a,b) => ['scrollTop','clientHeight','scrollHeight'].every(key=>Math.abs(a[key]-b[key]) <= 2);
const sameCopyRange = (a,b) => ['start','end'].every(point=>['x','y'].every(axis=>
  Number.isFinite(a?.[point]?.[axis]) && Number.isFinite(b?.[point]?.[axis]) &&
  Math.abs(a[point][axis]-b[point][axis])<=2));

export function nextScrollStep(surface) {
  const coverage = surface?.end?.y - surface?.start?.y;
  const fallback = Math.max(120, Number.isFinite(coverage) ? coverage * 0.65 : 0);
  if (surface?.scrollMode !== 'native' || !surface.scrollMeasured ||
      !Array.isArray(surface.scrollChain) || !surface.scrollChain.length || coverage <= 8) return fallback;
  for (const owner of surface.scrollChain) {
    if (!owner) return fallback;
    const {scrollTop,clientHeight,scrollHeight} = owner;
    if (![scrollTop,clientHeight,scrollHeight].every(Number.isFinite) || clientHeight <= 0 ||
        scrollHeight < clientHeight || scrollTop < -4 ||
        scrollTop > scrollHeight-clientHeight+4) return fallback;
  }
  const owner = surface.scrollChain.find(({scrollTop,clientHeight,scrollHeight}) =>
    scrollHeight-clientHeight-scrollTop > 4);
  if (!owner) return fallback;
  // The wheel request is only an upper bound; the next read checks real movement.
  const remaining = owner.scrollHeight-owner.clientHeight-owner.scrollTop;
  return Math.max(1, Math.floor(Math.min(coverage * 0.6, coverage - 8, remaining)));
}

function looksLikeResume(item) {
  const text = clipboardText(item).trim();
  return text.length >= 40 && /工作经历|工作经验|项目经历|教育经历|教育背景|个人优势|个人简介|期望职位|专业技能/.test(text.replace(/\s/g, ''));
}

function rawOverlapBoundary(previous, raw, overlap) {
  const normalized=normalizeClipboardProofText(raw);
  if (!overlap || !normalized.startsWith(overlap) || overlap.length>=normalized.length) return null;
  // The proof normalizer omits punctuation/whitespace and can expand NFKC
  // characters. Its length is never a raw cut point. Require the complete raw
  // prefix to equal the preceding screen's suffix, including its trailing
  // punctuation and whitespace; otherwise keep both originals for fallback.
  let boundary=null;
  for (let index=0;index<raw.length;) {
    index+=String.fromCodePoint(raw.codePointAt(index)).length;
    const prefix=raw.slice(0,index),normalizedPrefix=normalizeClipboardProofText(prefix);
    if (normalizedPrefix.length>overlap.length) break;
    if (normalizedPrefix===overlap && previous.endsWith(prefix) &&
        normalizeClipboardProofText(raw.slice(index))===normalized.slice(overlap.length)) boundary=index;
  }
  return boundary;
}

function hasSubstantialSharedText(previous,current) {
  const letters=text=>(normalizeClipboardProofText(text).match(/[\p{L}\p{N}]/gu)||[]).join('');
  const before=letters(previous),after=letters(current),size=32;
  if (before.length<size || after.length<size) return false;
  const windows=new Set();
  for (let index=0;index<=before.length-size;index++) windows.add(before.slice(index,index+size));
  for (let index=0;index<=after.length-size;index++) {
    if (windows.has(after.slice(index,index+size))) return true;
  }
  return false;
}

export function combineScreens(screens,{expectedName=''}={}) {
  const proof=createClipboardProof({expectedName});
  let resume='',trimmed=false,stitchIssue='';
  for (const [index,page] of screens.entries()) {
    const text=clipboardText(page),sequence=proof.observe(text);
    if (index===0) {resume=text;continue;}
    const overlap=sequence.accepted && sequence.overlap?.reason==='accepted'
      ? normalizeClipboardProofText(text).slice(0,sequence.overlap.overlapLength) : '';
    if (overlap) {
      const boundary=rawOverlapBoundary(clipboardText(screens[index-1]),text,overlap);
      if (boundary!==null) {
        resume+=text.slice(boundary);
        trimmed=true;
        continue;
      }
      stitchIssue='已确认分屏有重叠，但无法精确对应原文边界，尚未确认合并结果。';
    } else if (hasSubstantialSharedText(clipboardText(screens[index-1]),text))
      stitchIssue ||= '相邻分屏含较长重复文字，但无法确认唯一衔接位置，尚未确认正文连续。';
    resume+='\n\n'+text;
  }
  const escape = value => value.replace(/[&<>]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[ch]);
  // The HTML fragment has no proven mapping to a plain-text overlap offset.
  const resume_html = trimmed ? `<pre>${escape(resume)}</pre>` : screens.some(page=>page.resume_html)
    ? screens.map(page=>page.resume_html || `<pre>${escape(page.resume)}</pre>`).join('<hr>') : '';
  return {resume, resume_html, ...(stitchIssue?{stitchIssue}:{})};
}

export async function copyOpenResume({browser, clipboard, clipboardSequence, tab, documentId, textSelection, headerOnly=false, singlePass=false, expandAlreadyDone=false, skipExpansion=false, name='', recoverFocus, fitViewport, report, pause, check=()=>{}}) {
  const home = await browser.windows.getCurrent();
  const target = {tabId: tab.id};
  const debug = browser.debugger;
  const baseline = await readClipboardResume(clipboard);
  if(!textSelection&&!documentId){
    const found=(await browser.scripting.executeScript({target:{...target,allFrames:true},func:inspectCopyFrame,args:['probe']})).filter(frame=>frame.result);
    if(found.length!==1||!found[0].documentId)throw Error('未确认唯一的在线简历正文。');
    documentId=found[0].documentId;
  }
  const frameTarget = {...target, documentIds: [documentId]};
  let latestGeometry=null;
  const inspect = textSelection?async action=>{
    if(action==='cleanup')return textSelection.clear();
    const focused=action==='focus'?await textSelection.select():await textSelection.focused();
    return focused?{focused:true,canvasFocused:true}:null;
  }:async (action, marks=[]) => {
    const value=(await browser.scripting.executeScript({
      target: frameTarget, func: inspectCopyFrame, args: [action,marks]
    }))[0]?.result;
    if(value?.diagnostics)latestGeometry=value.diagnostics;
    return value;
  };
  const verifyTab = async () => {
    check();
    const current = await browser.tabs.get(tab.id);
    if (!current.active || current.url !== tab.url || !isBoss(current.url)) throw Error('BOSS 标签页已切换，自动复制已停止。');
  };
  const send = (method, params) => debug.sendCommand(target, `Input.${method}`, params);
  const shortcut = async (letter, command) => {
    const code = letter.toUpperCase().charCodeAt(0);
    const key = {key: letter, code: `Key${letter.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: 2};
    const control = {key:'Control', code:'ControlLeft', windowsVirtualKeyCode:17, nativeVirtualKeyCode:17};
    await send('dispatchKeyEvent', {type:'rawKeyDown', ...control, modifiers:2});
    try {
      await send('dispatchKeyEvent', {type:'rawKeyDown', ...key, ...(command?{commands:[command]}:{})});
    } finally {
      try {
        await send('dispatchKeyEvent', {type:'keyUp', ...key});
      } finally {
        await send('dispatchKeyEvent', {type:'keyUp', ...control, modifiers:0});
      }
    }
  };
  const focus = async () => {
    for(let attempt=0;attempt<5;attempt++){
      await verifyTab();
      await browser.windows.update(tab.windowId, {focused: true});
      const surface = await inspect('focus');
      if(surface?.focused && surface.canvasFocused)return surface;
      if(!attempt)report('正在等待简历页面就绪并恢复焦点…');
      // Only the bound caller can identify and dismiss a known image preview.
      // Never replay a selection or an already issued copy to recover focus.
      if(attempt===1 && copyCount===0 && !focusRecoveryAttempted && recoverFocus){
        focusRecoveryAttempted=true;
        const recovery=await recoverFocus();
        if(recovery?.skipExpansion===true)skipExpansion=true;
        await verifyTab();
      }
      if(attempt<4)await pause(180);
    }
    throw Error('简历正文未获得焦点。请切回 BOSS 标签页，若正文被浮层遮住，请先关闭浮层再重试。');
  };
  const copyWitness = async action => textSelection ? null : (await browser.scripting.executeScript({
    target:frameTarget,func:observeCopyClipboard,args:[action,action==='arm'?crypto.randomUUID():'']
  }))[0]?.result;
  const witnessed = (witness,copied) => {
    if (!witness?.marker || !copied.resume_html.includes(witness.marker)) return false;
    const plain = value => value.replace(/\r\n?/g,'\n');
    return !witness.resume || plain(witness.resume)===plain(copied.resume);
  };
  const withoutCopyMarker = html => html.replace(
    /<!--hrm-copy:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-->/g,'');
  let previous = baseline, copyCount = 0, focusRecoveryAttempted=false;
  const sequence = clipboardSequence || (async () => null);
  const copySelection = async () => {
    if(singlePass && copyCount)return null;
    const before = await sequence();
    const copyKeys = singlePass ? ['copy']
      : textSelection ? ['copy', undefined] : [undefined, 'copy'];
    for (const command of copyKeys) {
      await verifyTab();
      if (!(await inspect('probe'))?.focused) throw Error('简历正文已失去焦点，自动复制已停止。');
      const armed = before===null && await copyWitness('arm');
      copyCount++;
      await shortcut('c', command);
      // Give the page time to finish a clipboard write while it still has focus.
      for (let attempt = 0; attempt < 6; attempt++) {
        await pause(120);
        check();
        const current = await sequence();
        if (current !== null && current !== before) break;
      }
      await verifyTab();
      if (!await inspect('probe')) throw Error('简历已关闭或切换，自动复制已停止。');
      await browser.windows.update(home.id, {focused: true});
      for (let attempt = 0; attempt < 8 && globalThis.document && !document.hasFocus(); attempt++) {
        check();
        await pause(40);
      }
      let copied;
      for(let attempt=0;attempt<3;attempt++){
        await verifyTab();
        try {
          copied = await readClipboardResume(clipboard);
          break;
        } catch (error) {
          if(error.name!=='NotAllowedError')throw error;
          if(attempt===2)throw Error('采集窗口无法读取剪贴板，请保持窗口开启并确认 Edge 已授予剪贴板权限。');
          report('正文已复制，正在等待采集窗口获得剪贴板读取权限…');
          await browser.windows.update(home.id,{focused:true});
          await pause(120*(attempt+1));
        }
      }
      const after = await sequence();
      const localWitness = armed ? await copyWitness('read') : null;
      if (armed) await copyWitness('cleanup');
      const tagged = Boolean(localWitness?.marker && copied.resume_html.includes(localWitness.marker));
      const confirmed = witnessed(localWitness,copied);
      const fresh = before !== null && after !== null ? before !== after
        : !sameClipboard(previous,copied) && (!tagged || confirmed);
      previous = copied;
      if (fresh && clipboardText(copied).trim()) return {...copied,
        resume_html:confirmed && !localWitness.resume_html ? '' : withoutCopyMarker(copied.resume_html)};
      if (command === copyKeys[0]) await browser.windows.update(tab.windowId, {focused: true});
    }
    return null;
  };
  const scroll = async (surface, deltaY) => {
    await verifyTab();
    await send('dispatchMouseEvent', {type:'mouseWheel', ...surface.center, deltaX:0, deltaY});
    await pause(350);
  };
  const expandPointSet = async (visual, verified=false) => {
    const query = visual ? {func:visualExpandMarks}
      : {world:'MAIN',func:verified?canvasVerifiedExpandMarks:canvasExpandMarks};
    const [row] = await browser.scripting.executeScript({target:frameTarget,...query});
    const marks = row?.result;
    if (!Array.isArray(marks) || !marks.length) return {marks:[],points:[]};
    return {marks,points:await inspect('expand-points',marks) || []};
  };
  const expandPoints = async (visual,verified=false) => (await expandPointSet(visual,verified)).points;
  const click = async point => {
    await send('dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
    await send('dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
  };
  const selectionPoints = async () => {
    const [row]=await browser.scripting.executeScript({
      target:frameTarget,world:'MAIN',func:canvasSelectionAnchors
    });
    return Array.isArray(row?.result) ? await inspect('selection-points',row.result) || [] : [];
  };
  const safeSelectionStart = async () => {
    await verifyTab();
    const initial=await inspect('probe');
    const initialGeometry=scrollGeometry(initial);
    const stable=surface=>{
      const geometry=scrollGeometry(surface);
      return surface?.focused && surface.canvasFocused && sameCopyRange(initial,surface) &&
        (initialGeometry && geometry ? sameGeometry(initialGeometry,geometry) : initialGeometry===geometry);
    };
    let candidate;
    for(let attempt=0;attempt<8;attempt++){
      await verifyTab();
      if(!stable(await inspect('probe')))throw Error('等待正文文字时简历位置、焦点或可见范围发生变化，尚未拖选。');
      candidate=(await selectionPoints())[0];
      if(candidate)break;
      if(!attempt)report('正在等待简历文字绘制完成…');
      if(attempt<7)await pause(150);
    }
    if(!candidate)throw Error('未确认安全的正文文字起点，已停止拖选以避免打开头像。请关闭图片预览并刷新 BOSS 页面后重试。');
    await send('dispatchMouseEvent',{type:'mouseMoved',...candidate.point,buttons:0});
    let previousFresh=null;
    for(let attempt=0;attempt<6;attempt++){
      await verifyTab();
      if(!stable(await inspect('probe')))throw Error('正文文字位置或可见范围已变化，尚未拖选。');
      const fresh=(await selectionPoints()).find(item=>
        Math.hypot(item.point.x-candidate.point.x,item.point.y-candidate.point.y)<2 &&
        ['left','top','right','bottom','startX','safeLeft'].every(key=>item.mark[key]===candidate.mark[key]));
      // A hover repaint may replace the anchor ID. Accept only a fresh witness
      // that stays stable across two reads, without moving or pressing again.
      if(fresh && (fresh.mark.id===candidate.mark.id || previousFresh?.mark.id===fresh.mark.id))
        return fresh.point;
      previousFresh=fresh;
      if(attempt<5)await pause(150);
    }
    throw Error('正文文字位置已变化或被浮层遮挡，尚未拖选。请关闭浮层后重试。');
  };
  const drag = async ({end}) => {
    const start=await safeSelectionStart();
    let last = start;
    await send('dispatchMouseEvent', {type:'mousePressed', ...start, button:'left', buttons:1, clickCount:1});
    try {
      for (let step = 1; step <= 12; step++) {
        check();
        last = {x:start.x + (end.x-start.x)*step/12, y:start.y + (end.y-start.y)*step/12};
        await send('dispatchMouseEvent', {type:'mouseMoved', ...last, button:'left', buttons:1});
      }
    } finally {
      await send('dispatchMouseEvent', {type:'mouseReleased', ...last, button:'left', buttons:0, clickCount:1});
    }
  };
  const copyRange = async (start,end) => {
    await drag({start,end});
    return copySelection();
  };
  const clickedMarks = new Set();
  const nearby = (a,b,distance) => a.mark.label === b.mark.label &&
    Math.hypot(a.point.x-b.point.x,a.point.y-b.point.y) < distance;
  const expandVisible = async page => {
    let labels = resumeFoldLabels(clipboardText(page));
    const clickedHere = [];
    for (let attempt=0; labels.length && attempt<8; attempt++) {
      await focus();
      const eligible = item => labels.includes(item.mark.label) && !clickedMarks.has(item.mark.id) &&
        !clickedHere.some(clicked=>Math.hypot(clicked.point.x-item.point.x,clicked.point.y-item.point.y)<8);
      const findCandidate = points => {
        const candidates = points.filter(eligible);
        return candidates.find(({mark}) =>
          candidates.filter(item=>item.mark.label===mark.label).length === labels.filter(label=>label===mark.label).length);
      };
      let visual = false;
      let candidate = findCandidate(await expandPoints(visual));
      if (!candidate && labels.includes('查看全部')) {
        visual = true;
        candidate = findCandidate(await expandPoints(visual));
      }
      if (!candidate) return {page,foldIssue:'已读到折叠字样，但未确认当前屏的展开控件位置。'};
      await send('dispatchMouseEvent',{type:'mouseMoved',...candidate.point,buttons:0});
      const fresh = (await expandPoints(visual)).find(item=>eligible(item)&&nearby(candidate,item,4));
      if (!fresh) return {page,foldIssue:'展开控件的位置发生变化，未能确认当前可点击的位置。'};
      const label = fresh.mark.label;
      report(`正在展开「${label}」…`);
      await verifyTab();
      if (!visual) {
        clickedMarks.add(candidate.mark.id);
        clickedMarks.add(fresh.mark.id);
      }
      clickedHere.push(fresh);
      await click(fresh.point);
      report(`已点击「${label}」，正在核对展开结果…`);
      await pause(650);
      const surface = await focus();
      const recopy = surface.start && surface.end ? await copyRange(surface.start,surface.end) : null;
      const remaining = recopy ? resumeFoldLabels(clipboardText(recopy)) : labels;
      if (!recopy || remaining.filter(item=>item===label).length >= labels.filter(item=>item===label).length) {
        return {page,foldIssue:`已定位并点击「${label}」，但未确认展开。`};
      }
      page = recopy;
      labels = remaining;
    }
    return {page,expanded:clickedHere.length>0,foldIssue:labels.length?'仍有折叠项，未确认全部展开。':''};
  };
  const copyAll = async () => {
    await focus();
    await shortcut('a','selectAll');
    return copySelection();
  };
  const detach = () => debug.detach(target).catch(() => {});
  await verifyTab();
  await debug.attach(target, '1.3');
  try {
    globalThis.addEventListener?.('pagehide', detach, {once: true});
    // Observe real text paint before any pointer selection, including the
    // separate header check used before an authorized favorite action.
    if(!textSelection)await browser.scripting.executeScript({
      target:frameTarget,world:'MAIN',files:['canvas-expand.js']
    });
    if(singlePass){
      const failed=(issue,copied=null,manualRetry=true)=>({... (copied||{resume:'',resume_html:''}),
        selection:'single-copy',copyCount,screens:copyCount?1:0,issue:issue+(manualRetry?'请手动处理后重试。':''),
        ...(latestGeometry?{diagnostics:latestGeometry}:{}),
        ...(!textSelection?{completeness:{topVerified:false,bottomVerified:false,
          stableBottomReads:0,allScreensRead:false}}:{})});
      const finish=copied=>{
        if(!copied?.resume?.trim())return failed('本次复制未获得新的简历正文。',copied);
        const raw=copied.resume,discoveredIdentity=name?null:discoverResumeHeaderIdentity(raw);
        const expectedName=name||discoveredIdentity?.name;
        if(!expectedName || !hasClipboardHeader(raw,expectedName))
          return failed('本次正文未确认候选人姓名和页首身份。',copied);
        const folded=[...new Set(resumeFoldLabels(raw))];
        if(folded.length)return failed('本次正文仍含未展开内容，请在简历中手动点开'+
          folded.slice(0,3).map(label=>'「'+label+'」').join('、')+(folded.length>3?'等折叠项':'')+'后重试。',copied,false);
        const footerAt=raw.search(/为\s*妥\s*善\s*保\s*护\s*牛\s*人/);
        const body=footerAt<0?raw:raw.slice(0,footerAt);
        if(!looksLikeResume({resume:body,resume_html:''}))
          return failed('本次正文未包含可确认的简历章节。',copied);
        if(!textSelection && !proveWholeClipboard(raw,raw,{expectedName}).complete)
          return failed('本次正文未同时包含简历开头、章节和完整平台末尾。',copied);
        return {...copied,selection:'single-copy',copyCount,screens:1,issue:'',
          ...(discoveredIdentity?{discoveredIdentity}:{}),
          ...(!textSelection?{completeness:{topVerified:true,bottomVerified:true,
            stableBottomReads:1,allScreensRead:true}}:{})};
      };
      if(textSelection){
        report('正在复制已展开的简历正文一次…');
        await focus();
        return finish(await copySelection());
      }

      const geometryReason=surface=>!surface?'surface_missing':!surface.focused||!surface.canvasFocused?'focus_missing':
        !scrollGeometry(surface)?'scroll_metrics_invalid':!surface.end||!surface.center?'end_hit_missing':
        surface.contentWidthVisible===false?'width_clipped':'ok';
      const usable=surface=>geometryReason(surface)==='ok'&&surface.start;
      const geometryFailure=surface=>{
        const reason=geometryReason(surface);
        latestGeometry={...(surface?.diagnostics||latestGeometry||{}),reason};
        return ({surface_missing:'当前简历可见区域无法确认。',focus_missing:'当前简历未保持焦点。',
          scroll_metrics_invalid:'简历滚动范围尚未稳定，无法确认完整选择。',
          end_hit_missing:'简历选择末端被遮挡，无法确认完整选择。',
          width_clipped:'简历正文左右仍被裁切，且未证明裁切处完全空白；请扩大 BOSS 正文窗口或收起侧栏。'})[reason]||'未确认完整可见的简历选择范围。';
      };
      let viewportFitAttempted=false;
      const alignTop=async surface=>{
        if(surface.contentWidthVisible===false){
          await verifyTab();await inspect('align-horizontal');
          surface=await focus();
        }
        // Returning to the top is itself safe before a selection begins, even
        // when a transient scroll metric or corner hit prevents certification.
        await scroll(surface,-Math.max(100000,(surface.scrollTop||0)+(surface.clientHeight||0)));
        return focus();
      };
      const fitWidth=async surface=>{
        if(surface.contentWidthVisible!==false||viewportFitAttempted||typeof fitViewport!=='function')return surface;
        viewportFitAttempted=true;await verifyTab();
        if(await fitViewport(surface.diagnostics||{reason:'width_clipped'})){
          await verifyTab();surface=await alignTop(await focus());
        }
        return surface;
      };
      let surface=await focus();
      surface=await fitWidth(await alignTop(surface));
      if(!usable(surface))return failed(geometryFailure(surface));
      if(scrollGeometry(surface).scrollTop>4 || surface.contentTopVisible===false)
        return failed('未确认从简历页首开始选择。');

      // A DOM control and a painted control share one expansion budget. The
      // observer accepts full dynamic labels only while their current pixels
      // still match the real paint; the fixed visual template is a fallback
      // for a document opened before the observer was installed.
      if(!expandAlreadyDone&&!skipExpansion){
        const edges=['left','top','right','bottom'];
        const bounded=mark=>edges.every(key=>Number.isFinite(mark[key])) &&
          mark.left>=0&&mark.top>=0&&mark.right<=1&&mark.bottom<=1 &&
          mark.left<mark.right&&mark.top<mark.bottom;
        const visualCandidates=async rejected=>{
          const candidates=await expandPoints(true);
          // A clipped long label can leave a fully visible four-character
          // prefix. Reject that overlap, but keep unrelated visible controls
          // when the known rejected mark is elsewhere outside the viewport.
          return candidates.filter(({mark})=>!rejected.some(other=>
            !bounded(mark)||!bounded(other) ||
            mark.left<other.right&&mark.right>other.left&&mark.top<other.bottom&&mark.bottom>other.top));
        };
        let visual=false,{marks,points}=await expandPointSet(false,true);
        if(!points.length){visual=true;points=await visualCandidates(marks);}
        // Several marks can describe distinct controls or uncertain paint
        // evidence. They do not establish that the copied body is folded.
        // Leave them untouched and let the one complete copy prove its own
        // identity, sections, terminal and absence of fold labels below.
        if(points.length>1)report('展开控件不唯一，将复制一次并核验正文是否完整…');
        if(points.length===1){
          const candidate=points[0];
          await send('dispatchMouseEvent',{type:'mouseMoved',...candidate.point,buttons:0});
          let fresh;
          if(visual){
            const currentMain=await expandPointSet(false,true);
            const competing=currentMain.points.some(item=>!nearby(candidate,item,4) ||
              !edges.every(key=>candidate.mark[key]===item.mark[key]));
            fresh=competing?[]:await visualCandidates(currentMain.marks);
          }else fresh=await expandPoints(false,true);
          if(fresh.length!==1 || !nearby(candidate,fresh[0],4) ||
              !edges.every(key=>candidate.mark[key]===fresh[0].mark[key])){
            report('展开控件暂时无法确认，将复制一次并核验正文是否完整…');
            // Hover can move or obscure the resume even when no control is
            // clicked. Never select with the pre-hover endpoint in that case.
            await verifyTab();
            const current=await inspect('probe');
            if(!usable(current))return failed(geometryFailure(current));
            if(!sameGeometry(scrollGeometry(surface),scrollGeometry(current)) ||
                !sameCopyRange(surface,current) || surface.scrollMode!==current.scrollMode ||
                !['x','y'].every(axis=>Math.abs(surface.center[axis]-current.center[axis])<=2) ||
                scrollGeometry(current).scrollTop>4 || current.contentTopVisible===false)
              return failed('展开确认期间简历位置、页首或可见范围发生变化，尚未拖选。');
            surface=current;
          }else{
            await verifyTab();
            report('正在展开一个已确认的简历控件…');
            await click(fresh[0].point);
            await pause(650);
            surface=await fitWidth(await alignTop(await focus()));
            if(!usable(surface))return failed(geometryFailure(surface));
            if(scrollGeometry(surface).scrollTop>4 || surface.contentTopVisible===false)
              return failed('展开后未确认简历页首。');
          }
        }
      }

      let finalSurface=surface;
      if(surface.scrollMode==='native' && !atBottom(scrollGeometry(surface))){
        report('正在从页首连续选择全文，随后复制一次…');
        const selectionStart=await safeSelectionStart();
        let last=selectionStart,pressed=false,finished=false;
        try{
          await send('dispatchMouseEvent',{type:'mousePressed',...last,button:'left',buttons:1,clickCount:1});
          pressed=true;
          for(let step=1;step<=12;step++){
            check();
            last={x:selectionStart.x+(surface.end.x-selectionStart.x)*step/12,
              y:selectionStart.y+(surface.end.y-selectionStart.y)*step/12};
            await send('dispatchMouseEvent',{type:'mouseMoved',...last,button:'left',buttons:1});
          }
          for(let step=0;step<80;step++){
            await verifyTab();
            const current=await inspect('probe'),geometry=scrollGeometry(current);
            if(!usable(current) || !sameGeometry(scrollGeometry(finalSurface),geometry) ||
                !sameCopyRange(finalSurface,current))
              return failed('连续选择时简历位置或可见范围发生变化。');
            if(atBottom(geometry)){finalSurface=current;finished=true;break;}
            await send('dispatchMouseEvent',{type:'mouseWheel',...current.center,
              deltaX:0,deltaY:nextScrollStep(current),buttons:1});
            await pause(350);
            const advanced=await inspect('probe'),after=scrollGeometry(advanced);
            if(!usable(advanced) || after.scrollTop<=geometry.scrollTop+2 ||
                after.scrollTop-geometry.scrollTop>current.end.y-current.start.y-8 ||
                after.scrollHeight<geometry.scrollHeight-2)
              return failed('连续选择未确认真实且连续的滚动进度。');
            last={x:advanced.end.x,y:advanced.end.y-8};
            await send('dispatchMouseEvent',{type:'mouseMoved',...last,button:'left',buttons:1});
            last=advanced.end;
            await send('dispatchMouseEvent',{type:'mouseMoved',...last,button:'left',buttons:1});
            finalSurface=advanced;
          }
          if(!finished)return failed('本次连续选择未能到达简历末尾。');
        }finally{
          if(pressed)await send('dispatchMouseEvent',
            {type:'mouseReleased',...last,button:'left',buttons:0,clickCount:1});
        }
      }else if(surface.scrollMode==='stationary' || atBottom(scrollGeometry(surface))){
        report('正在选中简历正文并复制一次…');
        // Canvas renderers can ignore Ctrl+A until a real pointer selection
        // exists. Establish it without copying, then let supporting pages
        // extend to the whole document. An ignored Ctrl+A keeps the drag.
        await drag(surface);
        await verifyTab();
        await shortcut('a','selectAll');
      }else return failed('未确认可用的简历滚动模式。');

      await verifyTab();
      const selected=await inspect('probe'),geometry=scrollGeometry(selected);
      if(!usable(selected) || !sameGeometry(scrollGeometry(finalSurface),geometry) ||
          !sameCopyRange(finalSurface,selected) || !atBottom(geometry))
        return failed('复制前简历选择范围发生变化。');
      const copied=await copySelection();
      const observed=await inspect('probe'),after=scrollGeometry(observed);
      // Reading the clipboard focuses the collector. The document may now be
      // blurred, but the bound surface and selection geometry must be intact.
      if(!after || !sameGeometry(geometry,after) || !sameCopyRange(selected,observed) ||
          observed.contentWidthVisible===false || !atBottom(after))
        return failed('复制期间简历位置或可见范围发生变化。',copied);
      return finish(copied);
    }
    if(textSelection){
      report('正在复制已展开的简历正文…');
      await focus();
      const copied=await copySelection();
      if(!copied||!looksLikeResume(copied))throw Error('剪贴板没有收到可用的简历正文');
      return {...copied,selection:'text-range',screens:1};
    }
    const completeness = {topVerified:false,bottomVerified:false,stableBottomReads:0,allScreensRead:false};
    const resetTop = async () => {
      const surface = await focus();
      await scroll(surface,-Math.max(100000,(surface.scrollTop||0)+(surface.clientHeight||0)));
      const positioned = await inspect('probe'), geometry = scrollGeometry(positioned);
      completeness.topVerified = Boolean(geometry && geometry.scrollTop <= 4 && positioned.contentTopVisible !== false);
      completeness.bottomVerified = false;
      completeness.stableBottomReads = 0;
    };
    const heldScrollCopy = async ({screens,firstScreenText}={}) => {
      if(!firstScreenText || !screens?.length)return null;
      await resetTop();
      const initial=await focus(),initialGeometry=scrollGeometry(initial);
      if(!completeness.topVerified || !initialGeometry || initial.scrollMode!=='native' ||
          !initial.start || !initial.end || initial.contentTopVisible===false ||
          initial.contentWidthVisible===false)return null;
      const selectionStart=await safeSelectionStart();
      let last=selectionStart,pressed=false,bottomReads=0,finalGeometry=null;
      try {
        await send('dispatchMouseEvent',{type:'mousePressed',...last,button:'left',buttons:1,clickCount:1});
        pressed=true;
        for(let step=1;step<=12;step++){
          check();
          last={x:selectionStart.x+(initial.end.x-selectionStart.x)*step/12,
            y:selectionStart.y+(initial.end.y-selectionStart.y)*step/12};
          await send('dispatchMouseEvent',{type:'mouseMoved',...last,button:'left',buttons:1});
        }
        let previousGeometry=initialGeometry;
        for(let step=0;step<80;step++){
          await verifyTab();
          const surface=await inspect('probe'),geometry=scrollGeometry(surface);
          if(!surface?.focused || !surface.start || !surface.end || !surface.center ||
              !geometry || surface.contentWidthVisible===false ||
              geometry.scrollTop<previousGeometry.scrollTop-2 ||
              geometry.scrollHeight<previousGeometry.scrollHeight-2)return null;
          if(atBottom(geometry))bottomReads++;else bottomReads=0;
          if(bottomReads>=2){finalGeometry=geometry;break;}
          const deltaY=nextScrollStep(surface);
          await send('dispatchMouseEvent',{type:'mouseWheel',...surface.center,
            deltaX:0,deltaY,buttons:1});
          await pause(350);
          const advanced=await inspect('probe'),advancedGeometry=scrollGeometry(advanced);
          if(!advanced?.focused || !advanced.end || !advancedGeometry ||
              advanced.contentWidthVisible===false ||
              advancedGeometry.scrollTop<geometry.scrollTop-2 ||
              advancedGeometry.scrollTop-geometry.scrollTop>surface.end.y-surface.start.y-8 ||
              advancedGeometry.scrollTop<=geometry.scrollTop+2 && !atBottom(advancedGeometry))return null;
          last={x:advanced.end.x,y:advanced.end.y-8};
          await send('dispatchMouseEvent',{type:'mouseMoved',...last,button:'left',buttons:1});
          last=advanced.end;
          await send('dispatchMouseEvent',{type:'mouseMoved',...last,button:'left',buttons:1});
          previousGeometry=advancedGeometry;
        }
      } finally {
        if(pressed)await send('dispatchMouseEvent',
          {type:'mouseReleased',...last,button:'left',buttons:0,clickCount:1});
      }
      if(!finalGeometry)return null;
      const copied=await copySelection();
      const proof=copied?proveWholeClipboard(clipboardText(copied),firstScreenText,{expectedName:name}):null;
      const normalized=copied?normalizeClipboardProofText(clipboardText(copied)):'';
      if(!proof?.complete || !screens.every(screen=>normalized.includes(
          normalizeClipboardProofText(clipboardText(screen)))))return null;
      await browser.windows.update(tab.windowId,{focused:true});
      const repeated=await copySelection();
      const observed=await inspect('probe'),geometry=scrollGeometry(observed);
      if(!repeated || !sameClipboard(copied,repeated) || !geometry ||
          !sameGeometry(finalGeometry,geometry) || !atBottom(geometry) ||
          observed.contentWidthVisible===false)return null;
      return {...repeated,selection:'scroll-drag',screens:screens.length,issue:'',
        completeness:{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true}};
    };
    await resetTop();
    if (headerOnly) {
      const surface=await focus();
      if (!surface.start || !surface.end || !completeness.topVerified || surface.contentWidthVisible===false)
        throw Error('未确认简历页首可见，无法核对收藏身份。');
      const copied=await copyRange(surface.start,surface.end);
      const after=await inspect('probe'), geometry=scrollGeometry(after);
      if (!copied || !geometry || geometry.scrollTop>4 || after.contentTopVisible===false || after.contentWidthVisible===false)
        throw Error('未复制到稳定的简历页首，无法核对收藏身份。');
      return {...copied,selection:'header',screens:1};
    }
    // A complete scan already contains the body. Reuse it only when the text
    // proof establishes every unique overlap, then confirm a fresh second copy
    // of the still-selected terminal viewport without dragging through it again.
    const reuseScannedScreens=async({screens,firstScreenText,proof,finalSurface})=>{
      if(!proof?.complete || proof.issue || proof.screens!==screens.length ||
          finalSurface?.scrollMode!=='native')return null;
      const {stitchIssue,...copied}=combineScreens(screens,{expectedName:name});
      if(stitchIssue || !proveWholeClipboard(clipboardText(copied),firstScreenText,
          {expectedName:name}).complete)return null;
      const finalGeometry=scrollGeometry(finalSurface);
      const stableSurface=surface=>{
        const geometry=scrollGeometry(surface);
        return finalGeometry && geometry && surface.scrollMode==='native' &&
          surface.contentWidthVisible!==false && sameGeometry(finalGeometry,geometry) &&
          atBottom(geometry) && sameCopyRange(finalSurface,surface);
      };
      const focused=await focus();
      if(!stableSurface(focused))return null;
      report('已读完连续正文，正在核对末屏的新复制结果…');
      const repeated=await copySelection();
      const observed=await inspect('probe');
      if(!repeated || !sameClipboard(screens.at(-1),repeated) || !stableSurface(observed))return null;
      return {...copied,selection:'scroll-drag',screens:screens.length,issue:'',
        completeness:{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true}};
    };
    const scanExpandedScreens=async()=>{
      await resetTop();
      if(!completeness.topVerified)return null;
      const screens=[],textProof=createClipboardProof({expectedName:name});
      let firstScreenText='',previousGeometry=null,previousContent='',previousCoverage=0;
      for(let index=0;index<80;index++){
        const surface=await focus(),geometry=scrollGeometry(surface);
        if(surface.scrollMode!=='native' || !surface.scrollChain?.length ||
            !surface.start || !surface.end || !surface.center || !geometry ||
            surface.contentWidthVisible===false || surface.contentTopVisible===false && !index)return null;
        if(previousGeometry){
          const advance=geometry.scrollTop-previousGeometry.scrollTop;
          if(advance<=2 || advance>Math.min(previousCoverage,surface.end.y-surface.start.y)-8 ||
              geometry.scrollHeight<previousGeometry.scrollHeight-2)return null;
        }
        const page=await copyRange(surface.start,surface.end);
        const afterSurface=await inspect('probe'),after=scrollGeometry(afterSurface);
        if(!page || !after || !sameGeometry(geometry,after) || !sameCopyRange(surface,afterSurface) ||
            afterSurface.contentWidthVisible===false)return null;
        const content=normalizedText(page);
        if(previousGeometry && content===previousContent && !atBottom(after))return null;
        if(!index){
          firstScreenText=clipboardText(page);
          if(!looksLikeResume(page) || !hasClipboardHeader(firstScreenText,name))return null;
        }
        if(resumeFoldLabels(clipboardText(page)).length){
          const expanded=await expandVisible(page);
          if(expanded.foldIssue || !expanded.expanded)return null;
          return {expanded:true,screens};
        }
        screens.push(page);
        textProof.observe(clipboardText(page));
        if(atBottom(after))return {screens,firstScreenText,proof:textProof.snapshot(),finalSurface:afterSurface};
        previousGeometry=after;
        previousCoverage=surface.end.y-surface.start.y;
        previousContent=content;
        const scrollSurface=await focus(),scrollGeometryNow=scrollGeometry(scrollSurface);
        if(!scrollGeometryNow || !sameGeometry(after,scrollGeometryNow))return null;
        await scroll(scrollSurface,nextScrollStep(scrollSurface));
      }
      return null;
    };
    const firstSurface=await focus(),firstGeometry=scrollGeometry(firstSurface);
    if(firstSurface.scrollMode==='native' && firstGeometry &&
        firstSurface.scrollChain?.length && !atBottom(firstGeometry)){
      report('正在逐屏检查并展开简历内容…');
      const scanned=await scanExpandedScreens();
      if(scanned){
        if(scanned.expanded){
          report('已展开简历，正在从页首连续拖选全文…');
          await resetTop();
          const top=await focus(),topGeometry=scrollGeometry(top);
          if(completeness.topVerified && top.start && top.end && topGeometry &&
              top.contentWidthVisible!==false){
            const page=await copyRange(top.start,top.end);
            const text=page?clipboardText(page):'';
            if(page && looksLikeResume(page) && !resumeFoldLabels(text).length &&
                hasClipboardHeader(text,name)){
              const held=await heldScrollCopy({screens:[page,...scanned.screens],firstScreenText:text});
              if(held)return held;
            }
          }
        }else{
          const reused=await reuseScannedScreens(scanned);
          if(reused)return reused;
          report('已完成展开检查，正在从页首连续拖选全文…');
          const held=await heldScrollCopy(scanned);
          if(held)return held;
        }
      }
      report('连续拖选未确认完整正文，正在逐屏核对…');
      await resetTop();
    }
    let lastPass=null;
    const readPass = async (scrollScale=1) => {
    let selected = null;
    let foldedSelection = null;
    const screens = [];
    let previousRead = null;
    let textProof = createClipboardProof({expectedName:name}), firstScreenText = '';
    let clipboardMode = false;
    let firstScreenScrollRetry = false;
    let bottomWholeRetry = false;
    let issue = '已达到分屏复制上限，尚未确认读完正文。';
    for (let index = 0; index < 80; index++) {
      const screenNumber = screens.length+1;
      report(`正在复制第 ${screenNumber} 屏简历正文…`);
      const focused=await focus();
      if(!focused.start || !focused.end)throw Error('简历区域被遮挡，无法安全拖选。');
      if(previousRead)await scroll(focused,Math.max(1,Math.floor(nextScrollStep(focused)*scrollScale)));
      await verifyTab();
      let surface=await inspect('probe');
      if(!surface?.focused || !surface.start || !surface.end)throw Error('简历区域被遮挡，无法安全拖选。');
      let page=await copyRange(surface.start,surface.end);
      if (!page && !previousRead && !firstScreenScrollRetry) {
        firstScreenScrollRetry=true;
        const beforeScroll=scrollGeometry(surface);
        if (surface.scrollMode==='native' && beforeScroll && !atBottom(beforeScroll)) {
          report('首屏未取得新正文，正在下滑并返回顶部重新复制…');
          await scroll(surface,nextScrollStep(surface));
          const advanced=scrollGeometry(await inspect('probe'));
          if (advanced && advanced.scrollTop>beforeScroll.scrollTop+2) {
            const lower=await focus();
            const lowerGeometry=scrollGeometry(lower);
            if (lower.start && lower.end && lowerGeometry && sameGeometry(advanced,lowerGeometry))
              await copyRange(lower.start,lower.end);
            await resetTop();
            if (completeness.topVerified) continue;
          }
        }
      }
      const currentPosition=scrollGeometry(surface);
      if (previousRead && (!page || normalizedText(page)===previousRead.content) &&
          !(page && hasTerminalClipboard(clipboardText(page)) &&
            currentPosition && atBottom(currentPosition))) {
        for(let retry=0;retry<2;retry++){
          await pause(500);
          const priorGeometry=scrollGeometry(surface);
          surface=await focus();
          const currentGeometry=scrollGeometry(surface);
          if (!surface.start || !surface.end || !priorGeometry || !currentGeometry ||
              !sameGeometry(priorGeometry,currentGeometry))
            throw Error('重读时简历位置或可见范围发生变化，无法确认正文连续。');
          page=await copyRange(surface.start,surface.end);
          if (page && normalizedText(page)!==previousRead.content) break;
        }
      }
      if (page && resumeFoldLabels(clipboardText(page)).length) {
        const result = await expandVisible(page);
        if (result.foldIssue) return {...result.page,selection:'scroll-drag',screens:screenNumber,
          foldIssue:result.foldIssue,completeness};
        page = result.page;
        if (previousRead && result.expanded) {
          selected = null;
          foldedSelection = null;
          screens.length = 0;
          previousRead = null;
          textProof = createClipboardProof({expectedName:name});
          firstScreenText = '';
          clipboardMode = false;
          report('下方内容已展开，正在从顶部重新核对全文…');
          await resetTop();
          continue;
        }
      }
      if (!previousRead) {
        firstScreenText=page?clipboardText(page):'';
        const copied = await copyAll();
        if (copied && resumeFoldLabels(clipboardText(copied)).length) foldedSelection = copied;
        else if (copied && looksLikeResume(copied)) selected = copied;
      }
      const firstHeader=page && surface.scrollMode==='stationary' &&
        createClipboardProof({expectedName:name}).observe(clipboardText(page)).topVerified;
      if (!page || (!previousRead && !selected && !looksLikeResume(page) && !firstHeader)) {
        issue = `第 ${screenNumber} 屏未读到剪贴板正文，无法确认后续内容。`;
        break;
      }
      const copiedSurface = await inspect('probe');
      const before = scrollGeometry(surface), after = scrollGeometry(copiedSurface);
      if (!screens.some(screen=>sameClipboard(screen,page))) screens.push(page);
      if (!before || !after) {
        issue = '未测得唯一简历滚动区域的完整尺寸，无法确认全文已复制。';
        break;
      }
      const stationary=surface.scrollMode==='stationary' && copiedSurface.scrollMode==='stationary';
      const content = normalizedText(page);
      const frozenProgress=previousRead && Math.abs(before.scrollTop-previousRead.geometry.scrollTop)<=2 &&
        Math.abs(after.scrollHeight-previousRead.geometry.scrollHeight)<=2 && previousRead.content!==content;
      if (stationary || frozenProgress) clipboardMode=true;
      const sequenceProof=textProof.observe(clipboardText(page));
      const sequenceComplete=sequenceProof.complete && !sequenceProof.issue;
      const wholeProof=selected?proveWholeClipboard(clipboardText(selected),firstScreenText,{expectedName:name}):null;
      let wholeCoversPage=Boolean(wholeProof?.complete && normalizedText(selected).includes(normalizedText(page)));
      if (clipboardMode) completeness.topVerified=Boolean(sequenceProof.topVerified || wholeProof?.topVerified);
      if (!completeness.topVerified) {
        issue = '未确认从简历顶部开始复制，无法确认全文完整。';
        break;
      }
      if (surface.contentWidthVisible === false || copiedSurface.contentWidthVisible === false) {
        issue = '简历正文的横向区域未完整显示，无法确认已复制所有文字。';
        break;
      }
      let tailRetryRequired=false;
      if (!clipboardMode && atBottom(after) && copiedSurface.contentBottomVisible === false &&
          !sequenceComplete && !wholeCoversPage) {
        report('已到滚动底部，正在重新全选核对简历末尾…');
        const bottomSelection=await copyAll();
        const bottomProof=bottomSelection
          ? proveWholeClipboard(clipboardText(bottomSelection),firstScreenText,{expectedName:name}) : null;
        const bottomCoversScreens=Boolean(bottomProof?.complete && screens.every(screen=>
          normalizedText(bottomSelection).includes(normalizedText(screen))));
        const bottomSurface=await inspect('probe'), bottomGeometry=scrollGeometry(bottomSurface);
        if (!bottomGeometry || !sameGeometry(after,bottomGeometry) ||
            bottomSurface.contentWidthVisible === false) {
          issue = '滚动区域已到底部，但尚未复制到完整的简历末尾。重新全选后，滚动位置或可见范围发生了变化。';
          break;
        }
        if (bottomCoversScreens) selected=bottomSelection;
        else tailRetryRequired=true;
      }
      if (Math.abs(before.scrollTop-after.scrollTop) > 2 || Math.abs(before.clientHeight-after.clientHeight) > 2) {
        issue = '复制期间简历滚动位置或可见范围发生变化，无法确认正文连续。';
        break;
      }
      if (previousRead) {
        const advance = before.scrollTop-previousRead.geometry.scrollTop;
        if (advance < -2 || advance > previousRead.coverage - 8) {
          issue = '简历滚动跨度超出已复制区域，无法确认中间内容完整。';
          break;
        }
        if (advance > 2 && previousRead.content === content) {
          if(atBottom(after) && !hasTerminalClipboard(clipboardText(page)) && !wholeCoversPage && !bottomWholeRetry){
            bottomWholeRetry=true;
            report('滚动已到末尾，正在全选核对是否已复制完整简历…');
            const bottomSelection=await copyAll();
            const bottomProof=bottomSelection
              ? proveWholeClipboard(clipboardText(bottomSelection),firstScreenText,{expectedName:name}) : null;
            const bottomObserved=await inspect('probe'),bottomSurface=scrollGeometry(bottomObserved);
            if(bottomProof?.complete && bottomSurface && sameGeometry(after,bottomSurface) &&
                bottomObserved.contentWidthVisible!==false &&
                screens.every(screen=>normalizedText(bottomSelection).includes(normalizedText(screen)))){
              selected=bottomSelection;
              wholeCoversPage=true;
            }
          }
          if(!atBottom(after) || !hasTerminalClipboard(clipboardText(page)) && !wholeCoversPage){
            issue = `已滚动至第 ${screenNumber} 屏，但剪贴板仍是上一屏，无法确认后续内容。`;
            break;
          }
        }
        const grew = after.scrollHeight > previousRead.geometry.scrollHeight + 2;
        if (!clipboardMode && advance <= 2 && !grew && !atBottom(after)) {
          issue = '简历滚动位置未前进，且尚未到达底部，无法确认全文完整。';
          break;
        }
        if (clipboardMode && previousRead.content===content && !sequenceComplete && !hasTerminalClipboard(clipboardText(page))) {
          issue = '剪贴板正文没有前进，且尚未读到平台末尾，无法确认全文完整。';
          break;
        }
      }
      if (clipboardMode && !sequenceProof.accepted && !sequenceComplete && !wholeCoversPage) {
        issue=sequenceProof.issue || '尚未从复制正文中确认连续内容和平台末尾。';
        break;
      }
      if (tailRetryRequired) {
        const tailIssue='滚动区域已到底部，但尚未复制到完整的简历末尾。';
        if (!sameGeometry(before,after) || !sameClipboard(screens.at(-1),page)) {
          issue=tailIssue+'当前分屏与末尾核对记录不一致。';
          break;
        }
        const readExtendedTail=async()=>{
          const focused=await focus(), geometry=scrollGeometry(focused);
          if (!geometry || !sameGeometry(after,geometry) || focused.contentWidthVisible===false) return null;
          const point=await inspect('tail-point');
          if (!point || ![point.x,point.y].every(Number.isFinite) || point.y<focused.end.y+16 ||
              Math.abs(point.x-focused.end.x)>2) return null;
          const copied=await copyRange(focused.start,point);
          const observed=await inspect('probe'), measured=scrollGeometry(observed);
          if (!copied || !measured || !sameGeometry(after,measured) || observed.contentWidthVisible===false ||
              !normalizedText(copied).includes(content) || !hasTerminalClipboard(clipboardText(copied)) ||
              resumeFoldLabels(clipboardText(copied)).length) return null;
          return copied;
        };
        report('正在补选并核对未复制的简历末尾…');
        const firstTail=await readExtendedTail();
        const secondTail=firstTail ? await readExtendedTail() : null;
        if (firstTail && secondTail && sameClipboard(firstTail,secondTail)) {
          screens[screens.length-1]=secondTail;
          completeness.stableBottomReads=2;
          completeness.bottomVerified=true;
          completeness.allScreensRead=true;
          issue='';
          break;
        }
        if (firstTail && (!secondTail || !sameClipboard(firstTail,secondTail))) {
          issue=tailIssue+'向下补选的两次复制结果不一致。';
          break;
        }
        // Exhausting the DOM scroll range does not prove the canvas is at its
        // end. Probe for fresh text and, if continuity is proved, keep reading
        // until the platform footer is reached and repeated stably.
        const probeSurface=await focus(), probeGeometry=scrollGeometry(probeSurface);
        if (!probeSurface.center || !probeSurface.start || !probeSurface.end ||
            !probeGeometry || !sameGeometry(after,probeGeometry) ||
            !atBottom(probeGeometry) || probeSurface.contentWidthVisible===false) {
          issue=tailIssue+'补滚前，简历位置或可见范围发生了变化。';
          break;
        }
        report('正在尝试补滚并核对简历末尾…');
        await scroll(probeSurface,Math.min(240,Math.max(80,(probeSurface.end.y-probeSurface.start.y)*.25)));
        const wheelSurface=await inspect('probe'), wheelGeometry=scrollGeometry(wheelSurface);
        if (!wheelSurface?.focused || !wheelGeometry || !sameGeometry(after,wheelGeometry) ||
            !atBottom(wheelGeometry) || wheelSurface.contentWidthVisible===false) {
          issue=tailIssue+'补滚后，简历焦点、滚动位置或可见范围发生了变化。';
          break;
        }
        const readWheelTail=async()=>{
          const focused=await focus(), geometry=scrollGeometry(focused);
          if (!focused.start || !focused.end || !geometry || !sameGeometry(after,geometry) ||
              focused.contentWidthVisible===false) return null;
          const copied=await copyRange(focused.start,focused.end);
          const observed=await inspect('probe'), measured=scrollGeometry(observed);
          // copySelection deliberately focuses the collector to read the
          // clipboard. The bound canvas and geometry must still match, but
          // its document is expected to be blurred after a successful copy.
          return copied && measured && sameGeometry(after,measured) &&
            observed.contentWidthVisible!==false ? copied : null;
        };
        const firstWheel=await readWheelTail();
        const secondWheel=firstWheel ? await readWheelTail() : null;
        if (!firstWheel || !secondWheel || !sameClipboard(firstWheel,secondWheel) ||
            resumeFoldLabels(clipboardText(firstWheel)).length) {
          issue=tailIssue+(!firstWheel || !secondWheel ? '补滚后未获得两次有效的新复制结果。' :
            !sameClipboard(firstWheel,secondWheel) ? '补滚后的两次复制结果不一致。' : '补滚后的正文仍有未展开内容。');
          break;
        }
        const firstNormalized=normalizedText(firstWheel);
        const extended=firstNormalized.length>content.length && firstNormalized.startsWith(content);
        const terminal=hasTerminalClipboard(clipboardText(firstWheel));
        const wheelProof=extended && terminal ? null : textProof.observe(clipboardText(firstWheel));
        const overlapping=Boolean(wheelProof?.accepted && wheelProof.overlap?.reason==='accepted' &&
          !wheelProof.issue);
        if (!(extended && terminal) && !overlapping) {
          issue=tailIssue+(firstNormalized===content ? '补选和补滚后，剪贴板文字仍未增加。' :
            '补滚后的文字无法与已复制内容确认连续衔接。');
          break;
        }
        if (extended) screens[screens.length-1]=secondWheel;
        else screens.push(secondWheel);
        if (!terminal) {
          clipboardMode=true;
          completeness.bottomVerified=false;
          completeness.stableBottomReads=0;
          completeness.allScreensRead=false;
          previousRead={geometry:wheelGeometry,content:firstNormalized,
            coverage:wheelSurface.end.y-wheelSurface.start.y};
          report('外层滚动条已到末端，正文仍有后续，继续逐屏复制…');
          continue;
        }
        completeness.stableBottomReads=2;
        completeness.bottomVerified=true;
        completeness.allScreensRead=true;
        issue='';
        break;
      }
      const terminal=clipboardMode
        ? sequenceComplete || hasTerminalClipboard(clipboardText(page)) && wholeCoversPage
        : atBottom(before) && atBottom(after);
      const stable = terminal && sameGeometry(before,after);
      completeness.stableBottomReads = stable
        ? previousRead && previousRead.content === content && sameGeometry(previousRead.geometry,after)
          ? completeness.stableBottomReads+1 : 1
        : 0;
      if (completeness.stableBottomReads >= 2) {
        completeness.bottomVerified = true;
        completeness.allScreensRead = true;
        issue = '';
        break;
      }
      previousRead = {geometry:after,content,coverage:surface.end.y-surface.start.y};
    }
    // The first all-selection can contain an old folded view. Prefer the
    // freshly verified screens once they have reached a stable end.
    const foldIssue = foldedSelection && !completeness.allScreensRead
      ? '初次全选中出现折叠字样，分屏未能确认正文完整。' : '';
    if (foldIssue) await scroll(await focus(),-100000);
    if (selected || screens.length || foldedSelection) {
      const whole=selected?proveWholeClipboard(clipboardText(selected),firstScreenText,{expectedName:name}):null;
      const wholeCoversScreens=whole?.complete && screens.every(page=>
        normalizeClipboardProofText(clipboardText(selected)).includes(normalizeClipboardProofText(clipboardText(page))));
      let parts=[];
      if (wholeCoversScreens) parts=[selected];
      else if (completeness.allScreensRead) parts=[...screens];
      else {
        parts=selected?[selected]:[];
        for (const page of screens) {
          const text = normalizedText(page);
          if (parts.some(part => normalizedText(part).includes(text))) continue;
          if (parts.length === 1 && text.includes(normalizedText(parts[0]))) parts[0] = page;
          else parts.push(page);
        }
      }
      const result = parts.length > 1 ? combineScreens(parts,{expectedName:name}) : parts[0] || foldedSelection;
      const {stitchIssue,...copied}=result;
      if (stitchIssue) {
        completeness.bottomVerified=false;
        completeness.allScreensRead=false;
        completeness.stableBottomReads=0;
      }
      lastPass={screens:[...screens],firstScreenText};
      return {...copied, selection:'scroll-drag', screens:screens.length, issue:issue || stitchIssue || '',
        ...(!issue&&stitchIssue?.startsWith('相邻分屏含较长重复文字，但无法确认唯一衔接位置')
          ?{issueCode:'ambiguous-overlap'}:{}),
        completeness,...(foldIssue?{foldIssue}:{})};
    }
    throw Error('未确认剪贴板获得新简历正文。请展开简历并滚动到开头后重试。');
    };
    let result=await readPass();
    if(result.issueCode==='ambiguous-overlap'){
      report('分屏文字衔接未确认，正在缩小滚动步长重新核对全文…');
      await resetTop();
      if(completeness.topVerified)result=await readPass(0.5);
    }
    if(result.issueCode==='ambiguous-overlap' ||
        /^已滚动至第 \d+ 屏，但剪贴板仍是上一屏/.test(result.issue) ||
        /^第 \d+ 屏未读到剪贴板正文/.test(result.issue)){
      report('分屏复制未能确认全文，正在按住鼠标并滚动到末尾补读…');
      const held=await heldScrollCopy(lastPass);
      if(held)result=held;
    }
    return result;
  } catch(error) {
    if(!textSelection&&error&&typeof error==='object'){
      // This is the last measured geometry, not a guess at the cause of an
      // anchor, clipboard, focus or tab failure. Keep its original reason.
      try{if(error.diagnostics===undefined)error.diagnostics=latestGeometry||{reason:'surface_missing'};}catch{}
    }
    throw error;
  } finally {
    globalThis.removeEventListener?.('pagehide', detach);
    await detach();
    await copyWitness('cleanup').catch(() => {});
    await inspect('cleanup').catch(() => {});
    await browser.windows.update(home.id, {focused: true}).catch(() => {});
  }
}
