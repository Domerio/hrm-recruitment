import {isBoss,resumeFoldLabels,matchesCandidateNameLine} from './capture-utils.mjs';
import {createClipboardProof,normalizeClipboardProofText} from './copy-proof.mjs';

// Runs in the resume frame's MAIN world. It operates on the page's own DOM;
// it never activates a window, attaches a debugger or accesses the clipboard.
export function backgroundResumeFrame(action,args={}) {
  const sessionKey='__hrmBackgroundRead';
  const allowed=location.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(location.hostname)&&
    /^\/web\/frame\/c-resume\/?$/.test(location.pathname);
  if(!allowed)throw Error('页面已离开在线简历，后台读取已停止。');
  const fail=()=>{throw Error('简历画布、框架或滚动区域发生变化，后台读取已停止。');};
  const guard=()=>{
    if(/请完成安全验证|访问过于频繁|拖动滑块|账号异常|扫码登录|短信登录/.test(document.body?.innerText||''))
      throw Error('页面需要人工登录或验证，后台读取已停止。');
  };
  let session=window[sessionKey];
  // These events can reveal a platform note but cannot activate its adjacent
  // inquiry button. In particular no down/up/click event belongs in this path.
  const leaveHint=active=>{
    if(!active||active.canvas?.isConnected===false||active.canLeave?.()!==true)return false;
    // The WASM renderer listens for pointermove; an out/leave event alone
    // need not collapse its tooltip. Move only to the observer's proved blank
    // canvas point, never to a guessed button or another candidate control.
    for(const type of ['pointermove','mousemove','pointerout','pointerleave','mouseout','mouseleave']){
      if(active.canLeave()!==true)return false;
      const EventType=type.startsWith('pointer')?globalThis.PointerEvent:globalThis.MouseEvent;
      if(typeof EventType==='function')active.canvas.dispatchEvent(new EventType(type,{bubbles:!type.endsWith('leave'),
        cancelable:true,clientX:active.leaveX,clientY:active.leaveY,pointerType:'mouse',pointerId:1,buttons:0,view:window}));
    }
    return true;
  };
  if(action==='cleanup') {
    if(session?.token===args.token){
      try{leaveHint(session.hintActive);}catch{}
      try{window.__hrmCanvasText?.hint?.('cancel');}catch{}
      delete window[sessionKey];
    }
    return true;
  }
  guard();
  const findCanvases=()=>[...document.querySelectorAll('canvas')].filter(canvas=>{
    const r=canvas.getBoundingClientRect(),style=getComputedStyle(canvas);
    return r.width>=250&&r.height>=150&&style.visibility==='visible'&&Number(style.opacity)>0;
  });
  const canvases=findCanvases();
  if(canvases.length!==1)fail();
  const canvas=canvases[0];
  if(action==='prepare') {
    if(session&&session.token!==args.token)throw Error('当前简历已有后台读取任务。');
    session={token:args.token,canvas,frames:null,owners:null,expectedName:args.name,discoverIdentity:args.discoverIdentity===true};
    window[sessionKey]=session;
  }
  if(!session||session.token!==args.token||session.canvas!==canvas||canvas.isConnected===false)fail();
  const observer=window.__hrmCanvasText;
  if(observer?.version!==1||typeof observer.snapshot!=='function')
    return {issue:'当前简历没有可用的画布原文记录；请关闭详情后重新打开再试。',issueCode:'baseline',
      diagnostics:{baseline:false,entries:0,overflow:false,operations:{},reasonCounts:[]}};

  function assertTransform(style) {
    if(style.transform&&style.transform!=='none') {
      const matrix=new DOMMatrixReadOnly(style.transform);
      if(!matrix.is2D||matrix.b||matrix.c||matrix.a<=0||matrix.d<=0)
        throw Error('简历画布或祖先区域存在旋转、倾斜或翻转，未确认原文坐标。');
    }
    // CSS individual transforms do not necessarily appear in `transform`.
    if(style.rotate&&style.rotate!=='none'&&!/^(?:0(?:deg|rad|turn)?|(?:x|y|z) 0deg)$/.test(style.rotate))
      throw Error('简历区域存在独立旋转，未确认原文坐标。');
    if(style.scale&&style.scale!=='none') {
      const scales=style.scale.split(/\s+/).map(Number);
      if(scales.some(value=>!Number.isFinite(value)||value<=0))throw Error('简历区域存在翻转，未确认原文坐标。');
    }
  }
  function canvasBounds(){
    const r=canvas.getBoundingClientRect(),style=getComputedStyle(canvas);
    assertTransform(style);
    const pixels=key=>{
      const value=style[key];if(value===undefined||value==='')return 0;
      if(typeof value!=='string'||!/^\d+(?:\.\d+)?px$/.test(value))throw Error('简历画布边框或内边距无法确认。');
      return Number.parseFloat(value);
    };
    const left=pixels('borderLeftWidth')+pixels('paddingLeft'),right=pixels('borderRightWidth')+pixels('paddingRight');
    const top=pixels('borderTopWidth')+pixels('paddingTop'),bottom=pixels('borderBottomWidth')+pixels('paddingBottom');
    // Canvas pixels occupy the CSS content box. getBoundingClientRect alone
    // also includes borders/padding, which would shift every crop and hover.
    const axis=(size,inset,key)=>{
      if(!inset)return {scale:1,size};
      const css=pixels(key),borderBox=style.boxSizing==='border-box'?css:css+inset;
      if(!(size>0&&borderBox>inset))throw Error('简历画布内容区域无法确认。');
      return {scale:size/borderBox,size:(borderBox-inset)*size/borderBox};
    };
    const x=axis(r.width,left+right,'width'),y=axis(r.height,top+bottom,'height');
    const box={left:r.left+left*x.scale,top:r.top+top*y.scale,width:x.size,height:y.size};
    return {...box,right:box.left+box.width,bottom:box.top+box.height};
  }
  function measure() {
    const r=canvasBounds(),owners=[],frames=[];
    let left=r.left,right=r.right,top=r.top,bottom=r.bottom,offsetX=0,offsetY=0;
    const clip=(x1,y1,x2,y2)=>{left=Math.max(left,x1);top=Math.max(top,y1);right=Math.min(right,x2);bottom=Math.min(bottom,y2);};
    try {
      let child=window,anchor=canvas;
      for(let depth=0;depth<10;depth++) {
        const doc=child===window?document:child.document;
        const styleOf=child===window?getComputedStyle:element=>child.getComputedStyle(element);
        const width=child===window?innerWidth:child.innerWidth,height=child===window?innerHeight:child.innerHeight;
        // innerWidth includes a classic root scrollbar; clientWidth describes
        // the actual layout viewport available to the canvas.
        const clientWidth=doc.documentElement?.clientWidth,clientHeight=doc.documentElement?.clientHeight;
        clip(0,0,Number.isFinite(clientWidth)&&clientWidth>0?Math.min(width,clientWidth):width,
          Number.isFinite(clientHeight)&&clientHeight>0?Math.min(height,clientHeight):height);
        let fixed=false;
        for(let element=anchor;element;element=element.parentElement) {
          const style=styleOf(element);
          assertTransform(style);
          if(element!==canvas&&element!==doc.scrollingElement) {
            const clipX=/^(auto|scroll|hidden|clip)$/.test(style.overflowX);
            const clipY=/^(auto|scroll|hidden|clip)$/.test(style.overflowY);
            if(clipX||clipY) {
              const bounds=element.getBoundingClientRect();
              const sx=element.offsetWidth?bounds.width/element.offsetWidth:1;
              const sy=element.offsetHeight?bounds.height/element.offsetHeight:1;
              const x=bounds.left+(element.clientLeft||0)*sx,y=bounds.top+(element.clientTop||0)*sy;
              clip(clipX?x:-Infinity,clipY?y:-Infinity,
                clipX?x+element.clientWidth*sx:Infinity,clipY?y+element.clientHeight*sy:Infinity);
            }
          }
          if(!fixed&&element!==canvas&&element.clientHeight>=150&&/^(auto|scroll)$/.test(style.overflowY)&&!owners.includes(element))owners.push(element);
          if(style.position==='fixed')fixed=true;
        }
        const scrolling=doc.scrollingElement;
        if(!fixed&&scrolling&&scrolling.clientHeight>=150&&!/^(hidden|clip)$/.test(styleOf(scrolling).overflowY)&&!owners.includes(scrolling))owners.push(scrolling);
        if(child===child.top)break;
        if(depth===9)fail();
        const frame=child.frameElement;
        if(!frame||frame.isConnected===false)fail();
        const bounds=frame.getBoundingClientRect();
        if(Math.abs(bounds.width-frame.offsetWidth)>2||Math.abs(bounds.height-frame.offsetHeight)>2)fail();
        frames.push(frame);
        const x=bounds.left+(frame.clientLeft||0),y=bounds.top+(frame.clientTop||0);
        left+=x;right+=x;top+=y;bottom+=y;offsetX+=x;offsetY+=y;
        anchor=frame;child=child.parent;
      }
    }catch{fail();}
    if(session.frames&&(frames.length!==session.frames.length||frames.some((f,i)=>f!==session.frames[i])||
      owners.length!==session.owners.length||owners.some((e,i)=>e!==session.owners[i]||e.isConnected===false)))fail();
    session.frames=frames;session.owners=owners;
    if(right-left<250||bottom-top<150||!(canvas.width>0&&canvas.height>0))
      throw Error('简历可读取区域过小，后台读取已停止。');
    const scrollTop=owners.reduce((sum,e)=>sum+e.scrollTop,0);
    const range=owners.reduce((sum,e)=>sum+Math.max(0,e.scrollHeight-e.clientHeight),0);
    const viewport=bottom-top;
    if(![scrollTop,range,viewport].every(Number.isFinite))fail();
    return {rect:{x:(left-offsetX-r.left)*canvas.width/r.width,y:(top-offsetY-r.top)*canvas.height/r.height,
      width:(right-left)*canvas.width/r.width,height:viewport*canvas.height/r.height},
      visible:{left:left-offsetX,right:right-offsetX,top:top-offsetY,bottom:bottom-offsetY},
      scrollTop,clientHeight:viewport,scrollHeight:range+viewport,scrollMode:range>4?'native':'stationary',
      virtualScroll:session.virtualScroll===true,
      scrollPositions:owners.map(owner=>owner.scrollTop),
      horizontalClip:{canvasCssWidth:r.width,visibleCssWidth:right-left,
        clippedCssLeft:Math.max(0,left-r.left-offsetX),clippedCssRight:Math.max(0,r.right+offsetX-right)},
      contentTopVisible:top<=r.top+offsetY+2,contentBottomVisible:bottom>=r.bottom+offsetY-2,
      contentWidthVisible:left<=r.left+offsetX+2&&right>=r.right+offsetX-2};
  }
  function point(x,y) {
    let px=x,py=y;
    if(document.elementFromPoint(px,py)!==canvas)return false;
    try {
      for(let child=window;child!==child.top;child=child.parent) {
        const frame=child.frameElement;if(!frame)return false;
        const r=frame.getBoundingClientRect();px+=r.left+(frame.clientLeft||0);py+=r.top+(frame.clientTop||0);
        if(frame.ownerDocument.elementFromPoint(px,py)!==frame)return false;
      }
    }catch{return false;}
    return true;
  }
  const before=measure();
  const sample=(identityOnly=session.discoverIdentity)=>{
    // The reader is pinned to this canvas, frame chain and scroll owner before
    // delivering any overdue callbacks. Re-measure after the page redraws.
    measure();
    const scheduler=window.__hrmCanvasRender?.pump?.(args.token);
    guard();
    const after=findCanvases();
    if(window[sessionKey]!==session||after.length!==1||after[0]!==canvas||canvas.isConnected===false)fail();
    const geometry=measure();
    if(identityOnly&&typeof observer.identity!=='function')return {issueCode:'baseline',
      issue:'当前画布记录器不支持身份读取；请更新扩展并重新打开同一份简历后重试。',
      diagnostics:{baseline:false,entries:0,overflow:false,operations:{},reasonCounts:[]},geometry};
    const snap=identityOnly?observer.identity({rect:geometry.rect}):
      observer.snapshot({rect:geometry.rect,expectedName:session.expectedName,allowVerticalBoundary:true});
    if(!snap||snap.version!==1||typeof snap.canvasId!=='string'||!Number.isFinite(snap.revision)||typeof snap.text!=='string')
      return {issue:'画布原文记录格式无效，未确认简历完整性。',issueCode:'unsupported',geometry};
    if(session.canvasId&&session.canvasId!==snap.canvasId)fail();
    session.canvasId=snap.canvasId;
    const coverage=snap.horizontalCoverage;
    if(coverage!==undefined){
      const same=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Number.EPSILON*16*Math.max(1,Math.abs(a),Math.abs(b));
      const bound=coverage&&coverage.version===1&&coverage.canvasId===snap.canvasId&&coverage.revision===snap.revision&&
        coverage.canvasWidth===canvas.width&&same(coverage.visibleLeft,geometry.rect.x)&&
        same(coverage.visibleRight,geometry.rect.x+geometry.rect.width)&&same(coverage.readTop,geometry.rect.y)&&
        same(coverage.readBottom,geometry.rect.y+geometry.rect.height);
      geometry.contentWidthVerified=Boolean(bound&&coverage.complete===true&&
        ['full-width','empty-margins'].includes(coverage.reason)&&
        ['outsideTextRuns','outsideImages','outsideIssues'].every(key=>coverage[key]===0));
    }
    if(!scheduler&&!snap.diagnostics?.horizontal&&!session.motion)return {...snap,geometry};
    const diagnostics={...snap.diagnostics};
    if(diagnostics.horizontal)diagnostics.horizontal={...diagnostics.horizontal,...geometry.horizontalClip};
    if(scheduler)diagnostics.scheduler=scheduler;
    if(session.motion)diagnostics.motion={...session.motion,observedTop:geometry.scrollTop,
      scrollHeight:geometry.scrollHeight,clientHeight:geometry.clientHeight,virtualScroll:geometry.virtualScroll};
    return {...snap,geometry,...(Object.keys(diagnostics).length?{diagnostics}:{})};
  };
  if(action==='prepare'||action==='sample')return sample();
  if(action==='identity')return sample(true);
  if(action==='content'){
    // Rebind each visible-text observation to its immediately current header;
    // the caller must not reuse a header sampled before a canvas replacement.
    const current=sample(true),bound=args.identity;
    if(current.issue)return current;
    if(!bound||!current.identity||['version','name','canvasId','headerKey'].some(key=>current.identity[key]!==bound[key]))
      return {...current,issueCode:'identity',issue:'当前简历页首身份已变化，未确认原文见证。'};
    session.expectedName=current.identity.name;
    return sample(false);
  }
  const sameHintGeometry=(a,b)=>a&&b&&a.scrollMode===b.scrollMode&&Boolean(a.virtualScroll)===Boolean(b.virtualScroll)&&
    ['scrollTop','clientHeight','scrollHeight'].every(key=>Math.abs(a[key]-b[key])<.1)&&
    ['x','y','width','height'].every(key=>Math.abs(a.rect[key]-b.rect[key])<.1)&&
    ['left','right','top','bottom'].every(key=>Math.abs(a.visible[key]-b.visible[key])<.1)&&
    a.scrollPositions.length===b.scrollPositions.length&&a.scrollPositions.every((value,index)=>Math.abs(value-b.scrollPositions[index])<.1);
  const hintOptions=geometry=>({expectedName:session.expectedName,rect:geometry.rect});
  const requireHint=geometry=>{
    const active=session.hintActive;
    if(!active||active.canvas!==canvas||!sameHintGeometry(active.geometry,geometry)||!point(active.x,active.y))
      throw Error('工作经历提示或页面位置发生变化，未确认提示原文。');
    return active;
  };
  if(action==='hint-cancel'){
    // Cancellation never grants an image a readable role, even when the page
    // has changed while waiting for its hover rendering.
    try{if(session.hintActive&&sameHintGeometry(session.hintActive.geometry,before))leaveHint(session.hintActive);}
    finally{delete session.hintActive;observer.hint?.('cancel');}
    return true;
  }
  if(action==='hint-hover'){
    if(session.hintActive||typeof observer.hint!=='function')throw Error('工作经历提示读取状态不可用。');
    const current=sample(),marks=current.hintMarks;
    const mark=Array.isArray(marks)&&marks.length===1?marks[0]:null;
    if(current.issueCode!=='unsupported'||!current.issue||!mark||mark.kind!=='latest-work'||
      !Number.isSafeInteger(mark.id)||mark.id<1||mark.id!==args.mark?.id||mark.kind!==args.mark?.kind||
      !Number.isFinite(mark.x)||!Number.isFinite(mark.y)||mark.x<=0||mark.x>=1||mark.y<=0||mark.y>=1||
      mark.x!==args.mark?.x||mark.y!==args.mark?.y)
      throw Error('工作经历提示图标发生变化，未执行悬停。');
    const r=canvasBounds(),x=r.left+r.width*mark.x,y=r.top+r.height*mark.y,v=current.geometry.visible;
    if(x<v.left||x>v.right||y<v.top||y>v.bottom||!point(x,y))throw Error('工作经历提示图标被遮挡，未执行悬停。');
    const begun=observer.hint('begin',{...hintOptions(current.geometry),mark});
    if(begun?.ok!==true)throw Error('工作经历提示图标尚未通过核验，未执行悬停。');
    const lp=begun.leavePoint,leaveX=r.left+r.width*lp?.x,leaveY=r.top+r.height*lp?.y;
    if(!Number.isFinite(lp?.x)||!Number.isFinite(lp?.y)||lp.x<=0||lp.x>=1||lp.y<=0||lp.y>=1||
      leaveX<v.left||leaveX>v.right||leaveY<v.top||leaveY>v.bottom||
      Math.hypot(leaveX-x,leaveY-y)<1||!point(leaveX,leaveY)){
      observer.hint('cancel');throw Error('未确认可用于收起提示的空白位置，未执行悬停。');
    }
    const active={canvas,x,y,leaveX,leaveY,geometry:current.geometry,left:false};
    active.canLeave=()=>{
      try{
        guard();
        const found=findCanvases();
        return window[sessionKey]===session&&session.token===args.token&&session.canvas===canvas&&canvas.isConnected!==false&&
          found.length===1&&found[0]===canvas&&sameHintGeometry(active.geometry,measure())&&point(leaveX,leaveY);
      }catch{return false;}
    };
    session.hintActive=active;
    guard();requireHint(measure());
    for(const type of ['pointerover','pointermove','mouseover','mousemove']){
      const EventType=type.startsWith('pointer')?globalThis.PointerEvent:globalThis.MouseEvent;
      if(typeof EventType==='function')canvas.dispatchEvent(new EventType(type,{bubbles:true,cancelable:true,
        clientX:x,clientY:y,pointerType:'mouse',pointerId:1,buttons:0,view:window}));
    }
    return {ok:true};
  }
  if(action==='hint-probe'){
    const current=sample(),active=requireHint(current.geometry);
    if(active.left)throw Error('工作经历提示已收起，不能继续读取悬停内容。');
    active.ready=observer.hint?.('probe',hintOptions(current.geometry))?.ready===true;
    return {ready:active.ready};
  }
  if(action==='hint-leave'){
    const active=requireHint(before);
    if(!active.ready)throw Error('尚未读取完整工作经历提示，不能提交恢复核对。');
    guard();
    if(!leaveHint(active))throw Error('收起提示的空白位置已变化，未移动指针。');
    active.left=true;
    return {ok:true};
  }
  if(action==='hint-finish'){
    const current=sample(),active=requireHint(current.geometry);
    if(!active.left)throw Error('工作经历提示尚未恢复，未提交读取结果。');
    if(observer.hint?.('finish',hintOptions(current.geometry))?.ok!==true)return {ok:false};
    delete session.hintActive;
    const restored=sample();
    return {ok:true,sample:restored};
  }
  const setScroll=(owner,top)=>{
    // Hidden renderers can defer native scroll events even after scrollTop has
    // changed. Notify the bound owner of the position we actually set before
    // pumping its already-requested RAF; never fabricate a different offset.
    guard();measure();
    if(window[sessionKey]!==session||!session.owners.includes(owner)||owner.isConnected===false)fail();
    const original=owner.scrollTop;
    if(typeof owner.scrollTo==='function')owner.scrollTo({top,behavior:'instant'});
    else owner.scrollTop=top;
    if(Math.abs(owner.scrollTop-original)>.01){
      const doc=owner.ownerDocument||document,target=owner===doc.scrollingElement?doc:owner;
      const EventType=doc.defaultView?.Event||globalThis.Event;
      if(typeof target.dispatchEvent==='function'&&typeof EventType==='function'){
        target.dispatchEvent(new EventType('scroll',{bubbles:target===doc}));
        session.motion.notifications++;
      }
      guard();measure();
      const after=findCanvases();
      if(window[sessionKey]!==session||after.length!==1||after[0]!==canvas)fail();
    }
    return owner.scrollTop-original;
  };
  const wheel=delta=>{
    guard();const geometry=measure(),visible=geometry.visible;
    const x=(visible.left+visible.right)/2,y=(visible.top+visible.bottom)/2;
    const verifyTarget=()=>{
      guard();const current=measure(),found=findCanvases();
      if(window[sessionKey]!==session||found.length!==1||found[0]!==canvas||canvas.isConnected===false)fail();
      if(!sameHintGeometry(geometry,current))throw Error('简历滚动区域位置发生变化，后台读取已停止。');
      if(!point(x,y))throw Error('简历滚动区域被遮挡，后台读取已停止。');
    };
    // Some canvas renderers route wheel input through their last pointer
    // position instead of the WheelEvent coordinates. Establish that position
    // on the same verified canvas, without a click, focus or OS pointer move.
    for(const type of ['pointerover','pointermove','mouseover','mousemove']){
      verifyTarget();
      const EventType=type.startsWith('pointer')?globalThis.PointerEvent:globalThis.MouseEvent;
      if(typeof EventType==='function'){
        canvas.dispatchEvent(new EventType(type,{bubbles:true,cancelable:true,composed:true,
          clientX:x,clientY:y,pointerType:'mouse',pointerId:1,isPrimary:true,button:0,buttons:0,view:window}));
        session.motion.pointerNotifications++;
      }
    }
    verifyTarget();
    session.virtualScroll=true;
    session.motion.wheelPixels+=delta;
    canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,composed:true,deltaMode:0,
      deltaY:delta,clientX:x,clientY:y,button:0,buttons:0,view:window}));
    guard();measure();
    if(window[sessionKey]!==session||findCanvases().length!==1||findCanvases()[0]!==canvas)fail();
  };
  const startMotion=requestedPixels=>{
    session.motion={action,mode:before.scrollMode==='native'?'native':'wheel',requestedPixels,
      nativePixels:0,wheelPixels:0,notifications:0,pointerNotifications:0,ownerCount:session.owners.length,
      beforeTop:before.scrollTop,hidden:document.visibilityState==='hidden'};
  };
  const endMotion=()=>{
    const geometry=measure();
    session.motion.mode=session.motion.wheelPixels?(before.scrollMode==='native'?'mixed':'wheel'):'native';
    return {geometry};
  };
  if(action==='restore') {
    const positions=args.scrollPositions;
    if(before.scrollMode!=='native'||before.virtualScroll||!Array.isArray(positions)||positions.length!==session.owners.length||
      positions.some((value,index)=>!Number.isFinite(value)||value<0||value>Math.max(0,session.owners[index].scrollHeight-session.owners[index].clientHeight)))
      throw Error('无法返回上一处已确认的简历位置，后台读取已停止。');
    startMotion(positions.reduce((sum,value)=>sum+value,0)-before.scrollTop);
    session.owners.forEach((owner,index)=>{session.motion.nativePixels+=setScroll(owner,positions[index]);});
    return endMotion();
  }
  if(action==='top'||action==='next') {
    const ratio=args.stepRatio===undefined ? .55 : args.stepRatio;
    if(!Number.isFinite(ratio)||ratio<.1||ratio>.55)throw Error('后台读取步长无效，未执行滚动。');
    const step=Math.max(24,before.clientHeight*ratio);
    startMotion(action==='top'?-before.scrollTop:step);
    if(before.scrollMode==='native') {
      if(action==='top'){
        for(const owner of session.owners)session.motion.nativePixels+=setScroll(owner,0);
        if(session.virtualScroll||session.discoverIdentity&&args.resetCanvas===true)wheel(-100000);
      }else {
        let remaining=step;
        for(const owner of session.owners) {
          const original=owner.scrollTop,maximum=Math.max(0,owner.scrollHeight-owner.clientHeight);
          const moved=setScroll(owner,Math.min(maximum,original+remaining));
          session.motion.nativePixels+=moved;
          remaining-=Math.max(0,moved);
          if(remaining<=1)break;
        }
        // A small outer-page range does not prove that the canvas uses native
        // scrolling. At its verified boundary deliver only the unused step to
        // the canvas's own wheel handler, then re-prove exact text continuity.
        measure();
        if(remaining>1&&session.owners.every(owner=>
          Math.max(0,owner.scrollHeight-owner.clientHeight)-owner.scrollTop<=1))wheel(remaining);
      }
    }else wheel(action==='top'?-100000:step);
    return endMotion();
  }
  if(action==='expand') {
    const current=sample();
    if(current.issue)throw Error(current.issue);
    const mark=current.marks?.find(m=>m.id===args.mark?.id&&m.label===args.mark?.label&&
      Math.abs(m.x-args.mark.x)<.002&&Math.abs(m.y-args.mark.y)<.002);
    const fold=/^(?:查看全部|展开全部|查看更多)(?:(?:[1-9]\d{0,3}(?:个|项|条|段|份)?)?(?:个人优势|个人简介|期望职位|工作经历|工作经验|项目经历|项目经验|教育经历|教育背景|资格证书|专业技能|所获荣誉|荣誉奖项|获奖经历|荣誉|语言能力))?$/;
    if(!mark||!fold.test(mark.label)||!(mark.x>0&&mark.x<1&&mark.y>0&&mark.y<1))
      throw Error('展开控件发生变化，未执行点击。');
    const r=canvasBounds(),x=r.left+r.width*mark.x,y=r.top+r.height*mark.y,v=before.visible;
    if(x<v.left||x>v.right||y<v.top||y>v.bottom||!point(x,y))throw Error('展开控件不在当前简历可读取区域，未执行点击。');
    guard();
    for(const type of ['mousemove','mousedown','mouseup','click'])
      canvas.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,view:window}));
    return true;
  }
  throw Error('未知后台读取动作');
}

const rawText=sample=>sample?.text||'';
const sameGeometry=(a,b)=>a&&b&&a.scrollMode===b.scrollMode&&Boolean(a.virtualScroll)===Boolean(b.virtualScroll)&&['scrollTop','clientHeight','scrollHeight'].every(key=>Math.abs(a[key]-b[key])<=2)&&
  (!a.scrollPositions&&!b.scrollPositions||Array.isArray(a.scrollPositions)&&Array.isArray(b.scrollPositions)&&
    a.scrollPositions.length===b.scrollPositions.length&&a.scrollPositions.every((value,index)=>Math.abs(value-b.scrollPositions[index])<=2));
const sameBoundary=(a,b)=>['top','bottom'].every(edge=>Boolean(a?.boundaryRows?.[edge])===Boolean(b?.boundaryRows?.[edge]));
const atBottom=g=>g.scrollTop+g.clientHeight>=g.scrollHeight-4;
const validGeometry=g=>g&&['scrollTop','clientHeight','scrollHeight'].every(key=>Number.isFinite(g[key]))&&
  g.clientHeight>=150&&g.scrollTop>=-2&&g.scrollHeight>=g.clientHeight-2;
const html=text=>'<pre>'+text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</pre>';
const validIdentity=value=>value?.version===1&&typeof value.name==='string'&&matchesCandidateNameLine(value.name,value.name)&&
  typeof value.canvasId==='string'&&value.canvasId.length>0&&value.canvasId.length<=100&&
  typeof value.headerKey==='string'&&value.headerKey.length>0&&value.headerKey.length<=500;
const sameIdentity=(a,b)=>validIdentity(a)&&validIdentity(b)&&
  ['name','canvasId','headerKey'].every(key=>a[key]===b[key]);
const identityAtTop=sample=>!sample?.issue&&validIdentity(sample?.identity)&&sample.canvasId===sample.identity.canvasId&&
  sample.diagnostics?.baseline===true&&validGeometry(sample.geometry)&&sample.geometry.scrollTop<=4&&
  sample.geometry.contentTopVisible!==false;

// No list/card is consulted. A current, uniquely drawn header is the sole
// source of this temporary binding; its headerKey remains in memory and must
// never be placed in the persisted drawing diagnostics.
export async function identifyBackgroundResume({browser,tab,documentId,expectedIdentity,
  bindContent=false,contentKey,pause=ms=>new Promise(r=>setTimeout(r,ms)),check=()=>{},report=()=>{}}) {
  if(!documentId||!Number.isInteger(tab?.id)||!isBoss(tab.url)||expectedIdentity&&
    (!validIdentity(expectedIdentity)||expectedIdentity.documentId!==documentId))throw Error('未确认唯一的当前简历页面。');
  const token=globalThis.crypto.randomUUID(),target={tabId:tab.id,documentIds:[documentId]};
  let canvasId=expectedIdentity?.canvasId||'';
  const run=async(action,extra={})=>{
    check();const current=await browser.tabs.get(tab.id);check();
    if(current.url!==tab.url||!isBoss(current.url)||current.discarded)throw Error('当前简历页面已关闭、休眠或跳转。');
    const rows=await browser.scripting.executeScript({target,world:'MAIN',func:backgroundResumeFrame,args:[action,{token,...extra}]});
    check();
    if(rows.length!==1||rows[0].documentId!==documentId)throw Error('当前简历页面框架已关闭或切换。');
    const sample=rows[0].result;
    if(sample?.canvasId){
      if(canvasId&&canvasId!==sample.canvasId)throw Error('当前简历画布已更换，未继续评估。');
      canvasId=sample.canvasId;
    }
    return sample;
  };
  const failure=(sample,message)=>({issue:message||sample?.issue||'未从当前页首确认唯一姓名和完整资料行，请检查简历后重试。',
    issueCode:sample?.issueCode||'identity',...(sample?.diagnostics?{diagnostics:sample.diagnostics}:{})});
  const contentWitness=async identity=>{
    let previous=null,last=null;
    for(let attempt=0;attempt<10;attempt++){
      const sample=await run('content',{identity});last=sample;
      if(sample?.issue)return failure(sample);
      if(sample?.diagnostics?.baseline!==true||!validGeometry(sample.geometry)||sample.geometry.scrollTop>4||
        sample.geometry.contentTopVisible===false||sample.boundaryRows?.top||
        sample.geometry.contentWidthVerified===false||sample.geometry.contentWidthVisible===false&&sample.geometry.contentWidthVerified!==true||
        !rawText(sample).trim()||resumeFoldLabels(rawText(sample)).length)
        return failure(sample,'当前顶部原文尚未完整展开或绘制，未确认原文见证。');
      if(previous&&rawText(previous)===rawText(sample)&&sameGeometry(previous.geometry,sample.geometry)&&sameBoundary(previous,sample)){
        // Keep only an opaque in-memory digest, not a second raw-text payload
        // or a persisted diagnostic field. Original text/spacing are exact.
        const encoded=new TextEncoder().encode(JSON.stringify([identity.canvasId,identity.headerKey,rawText(sample),
          Boolean(sample.boundaryRows?.bottom)]));
        const digest=await globalThis.crypto.subtle.digest('SHA-256',encoded);check();
        const key='sha256:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
        if(contentKey!==undefined&&key!==contentKey)return failure(sample,'当前简历顶部原文已变化，未继续显示此次评估。');
        return {contentKey:key};
      }
      previous=sample;
      if(attempt<9){await pause(180);check();}
    }
    return failure(last,'当前顶部原文或位置持续变化，未确认原文见证。');
  };
  try{
    let prepared=await run('prepare',{discoverIdentity:true});
    for(let attempt=0;prepared?.issue&&['baseline','rendering'].includes(prepared.issueCode)&&attempt<20;attempt++){
      await pause(200);check();prepared=await run('identity');
    }
    if(prepared?.issueCode==='baseline'||prepared?.diagnostics?.baseline!==true)return failure(prepared,
      '当前简历尚无完整绘制记录；请保持采集窗口打开，手动关闭并重新打开同一份简历，再点击重新读取。');
    report(expectedIdentity?'正在回到页首核对同一份简历…':'正在返回当前简历顶部，确认姓名与资料行…');
    // Existing canvas content may already have an internal scroll offset even
    // though this new session has not dispatched a wheel yet.
    await run('top',{resetCanvas:true});await pause(250);check();
    let previous=null,last=prepared;
    for(let attempt=0;attempt<10;attempt++){
      const sample=await run('identity');last=sample;
      if(identityAtTop(sample)){
        if(expectedIdentity&&!sameIdentity(sample.identity,expectedIdentity))return failure(sample,'当前简历姓名或页首资料已变化，未继续评估。');
        if(previous&&sameIdentity(previous.identity,sample.identity)&&sameGeometry(previous.geometry,sample.geometry)){
          const content=bindContent||contentKey!==undefined?await contentWitness(sample.identity):{};
          if(content.issue)return content;
          return {name:sample.identity.name,identity:{...sample.identity,documentId},...content};
        }
        previous=sample;
      }else previous=null;
      if(sample?.issueCode==='baseline')return failure(sample);
      if(attempt<9){await pause(180);check();}
    }
    return failure(last);
  }finally{
    await browser.scripting.executeScript({target,world:'MAIN',func:backgroundResumeFrame,args:['cleanup',{token}]}).catch(()=>{});
  }
}

export async function verifyBackgroundIdentity(options) {
  const identity=options?.identity;
  if(!validIdentity(identity)||identity.documentId!==options.documentId)throw Error('未确认当前简历身份绑定。');
  if(options.contentKey!==undefined&&(typeof options.contentKey!=='string'||!/^sha256:[a-f0-9]{64}$/.test(options.contentKey)))
    throw Error('当前简历原文见证无效。');
  const result=await identifyBackgroundResume({...options,expectedIdentity:identity});
  return result.issue?{ok:false,...result}:{ok:true,...result};
}

// Only merge exact raw overlap. Proof uses normalization for comparison, but
// normalization must never rewrite the user's original resume text.
function joinRaw(pages,expectedOverlaps=null) {
  let result='',lastOverlap=0;
  for(const [index,text] of pages.entries()) {
    if(!result){result=text;continue;}
    const table=new Uint32Array(text.length);
    for(let i=1,j=0;i<text.length;i++) {
      while(j&&text[i]!==text[j])j=table[j-1];
      if(text[i]===text[j])j++;
      table[i]=j;
    }
    let overlap=0;
    for(let i=Math.max(0,result.length-text.length);i<result.length;i++) {
      while(overlap&&result[i]!==text[overlap])overlap=table[overlap-1];
      if(result[i]===text[overlap])overlap++;
      if(overlap===text.length&&i<result.length-1)overlap=table[overlap-1];
    }
    lastOverlap=overlap;
    const matched=normalizeClipboardProofText(text.slice(0,overlap)),expected=expectedOverlaps?.[index];
    // Never fall back from a proven A + unique context + A overlap to only A
    // when a space/punctuation change breaks the longer raw match. That would
    // duplicate context while incorrectly claiming a complete original.
    const bound=expectedOverlaps===null||Number.isSafeInteger(expected)&&expected>=24&&
      matched.length===expected&&matched===normalizeClipboardProofText(text).slice(0,expected)&&
      normalizeClipboardProofText(pages[index-1]).endsWith(matched);
    if(overlap<24||!bound)return {resume:result,overlapLength:overlap,issue:'分屏原文没有足够的精确重叠，无法无损合并；已停止以避免重复或漏字。'};
    result+=text.slice(overlap);
  }
  return {resume:result,overlapLength:lastOverlap};
}

export async function readBackgroundResume({browser,tab,documentId,name,identity,pause=ms=>new Promise(r=>setTimeout(r,ms)),check=()=>{},report=()=>{}}) {
  if(!documentId||!Number.isInteger(tab?.id)||!isBoss(tab.url)||typeof name!=='string'||!name.trim())throw Error('未确认唯一的简历页面。');
  if(identity&&(!validIdentity(identity)||identity.documentId!==documentId||identity.name!==name))throw Error('当前简历身份绑定无效。');
  const token=globalThis.crypto.randomUUID();
  const target={tabId:tab.id,documentIds:[documentId]};
  const pages=[],acceptedOverlaps=[],platformNotes=new Map();
  let proof=createClipboardProof({expectedName:name}),canvasId=identity?.canvasId||'',identityVerified=false,previous=null,restarts=0,stepRatio=.55,overlapRetries=0,anchorRetries=0,hintAttempts=0;
  const completeness={topVerified:false,bottomVerified:false,allScreensRead:false,stableBottomReads:0};
  const result=(issue,source={})=>{const assembled=joinRaw(pages,acceptedOverlaps),resume=assembled.resume;issue ||= assembled.issue;
    if(!issue&&platformNotes.size){
      const lines=new Set(resume.split(/\r?\n/));
      if([...platformNotes.values()].some(note=>!lines.has(note.anchor)))issue='平台提示对应的工作经历已变化，未确认简历完整性。';
    }
    return {resume,resume_html:html(resume),screens:pages.length,completeness:{...completeness},
      ...(identity?{identityVerified:!issue&&identityVerified}:{}),
      ...(!issue&&platformNotes.size?{platformNotes:[...platformNotes.values()]}:{}),
      ...(issue?{issue,issueCode:source.issueCode||'incomplete',...(source.failureReason?{failureReason:source.failureReason}:{}),
        ...(source.diagnostics?{diagnostics:source.diagnostics}:{})}:{})};};
  const verify=async()=>{
    check();
    const current=await browser.tabs.get(tab.id);
    check();
    if(current.url!==tab.url||!isBoss(current.url)||current.discarded)throw Error('BOSS 页面已关闭、休眠或跳转，后台读取已停止。');
  };
  const run=async(action,extra={})=>{
    await verify();
    const rows=await browser.scripting.executeScript({target,world:'MAIN',func:backgroundResumeFrame,args:[action,{token,...extra}]});
    check();
    if(rows.length!==1||rows[0].documentId!==documentId)throw Error('简历页面框架已关闭或切换，后台读取已停止。');
    const sample=rows[0].result;
    if(sample?.canvasId) {
      if(canvasId&&canvasId!==sample.canvasId)throw Error('当前简历画布已更换，后台读取已停止。');
      canvasId=sample.canvasId;
    }
    return sample;
  };
  const confirmIdentity=async()=>{
    let previousIdentity=null,last=null;
    for(let attempt=0;attempt<10;attempt++){
      const sample=await run('identity');last=sample;
      if(identityAtTop(sample)){
        if(!sameIdentity(sample.identity,identity))return {...sample,issue:'当前简历姓名或页首资料已变化，未继续评估。',issueCode:'identity'};
        if(previousIdentity&&sameIdentity(previousIdentity.identity,sample.identity)&&sameGeometry(previousIdentity.geometry,sample.geometry))return null;
        previousIdentity=sample;
      }else previousIdentity=null;
      if(sample?.issueCode==='baseline')break;
      if(attempt<9){await pause(180);check();}
    }
    return {...last,issue:last?.issue||'未能再次确认同一份简历的页首身份。',issueCode:last?.issueCode||'identity'};
  };
  const hintAvailable=sample=>sample?.issueCode==='unsupported'&&sample.issue&&
    Array.isArray(sample.hintMarks)&&sample.hintMarks.length===1&&sample.hintMarks[0]?.kind==='latest-work';
  const readHint=async source=>{
    if(++hintAttempts>8)return {...source,issue:'工作经历提示反复变化，已达到读取上限，请检查当前简历后重试。'};
    report('正在读取工作经历平台提示…');
    let finished=false;
    try{
      await run('hint-hover',{mark:source.hintMarks[0]});
      let ready=false;
      for(let attempt=0;attempt<10;attempt++){
        await pause(180);check();
        if((await run('hint-probe'))?.ready===true){ready=true;break;}
      }
      if(!ready)return {...source,issue:'未读取到完整的工作经历提示，请将鼠标悬停在橙色感叹号上后重试。'};
      await run('hint-leave');
      for(let attempt=0;attempt<10;attempt++){
        await pause(180);check();
        const restored=await run('hint-finish');
        if(restored?.ok===true){finished=true;return restored.sample;}
      }
      return {...source,issue:'工作经历提示收起后原文或位置未恢复，未确认简历完整性。'};
    }finally{
      if(!finished)await run('hint-cancel').catch(()=>{});
    }
  };
  const rememberNotes=sample=>{
    if(sample.platformNotes===undefined)return true;
    if(!Array.isArray(sample.platformNotes)||sample.platformNotes.length>8)return false;
    const checked=[];
    for(const note of sample.platformNotes){
      if(!note||note.kind!=='latest_work_may_be_outdated'||note.text!=='最近一份工作经历可能未更新'||
        note.section!=='工作经历'||typeof note.anchor!=='string'||!note.anchor.trim()||note.anchor.length>1000)return false;
      checked.push({kind:note.kind,text:note.text,section:note.section,anchor:note.anchor});
    }
    const merged=new Map(platformNotes);
    for(const note of checked)merged.set(JSON.stringify([note.kind,note.anchor]),note);
    if(merged.size>8)return false;
    for(const [key,note] of merged)platformNotes.set(key,note);
    return true;
  };
  const stableSample=async(pendingFold=null,motionFrom=null,restoring=null)=>{
    let last=null;
    const attempts=pendingFold?20:8,interval=pendingFold?200:180;
    const staleAfterScroll=current=>motionFrom&&rawText(current)===motionFrom.text&&
      (current.geometry?.scrollMode==='native'&&current.geometry.scrollTop>motionFrom.geometry.scrollTop+2||
        (current.geometry?.scrollMode==='stationary'||current.geometry?.virtualScroll===true)&&motionFrom.expectsAdvance);
    for(let attempt=0;attempt<=attempts;attempt++) {
      let current=await run('sample');
      if(hintAvailable(current)){current=await readHint(current);last=null;}
      if(current?.issue&&current.issueCode!=='rendering')return current;
      if(!current?.issue) {
        if(!validGeometry(current?.geometry))return {...current,issue:'未确认完整的简历可读取区域。',failureReason:'readable-region'};
        const expanded=!pendingFold||resumeFoldLabels(rawText(current)).filter(label=>label===pendingFold.label).length<pendingFold.count;
        const stale=staleAfterScroll(current);
        const restored=!restoring||rawText(current)===restoring.text&&sameGeometry(current.geometry,restoring.geometry)&&sameBoundary(current,restoring);
        if(expanded&&!stale&&restored&&last&&!last.issue&&rawText(last)===rawText(current)&&sameGeometry(last.geometry,current.geometry)&&sameBoundary(last,current))return current;
      }
      last=current;
      if(attempt<attempts){await pause(interval);check();}
    }
    if(!last?.issue&&pendingFold)return {...last,issue:'已点击展开控件，但页面未确认展开，请手动展开后重试。',failureReason:'expand-unchanged'};
    if(!last?.issue&&restoring)return {...last,issue:'回到上一屏后原文或位置已变化，无法继续确认分屏连续性。',failureReason:'restore-changed'};
    if(!last?.issue&&staleAfterScroll(last))
      return {...last,issue:'滚动后原文未更新，尚未确认后续内容。',failureReason:'scroll-stale'};
    return last?.issue?last:{...last,issue:'简历内容或滚动位置持续变化，尚未确认稳定原文。',failureReason:'unstable'};
  };
  const overlapFailure=(sample,sequence,raw,reason)=>({...sample,failureReason:'continuity-overlap',
    diagnostics:{...sample.diagnostics,overlap:{...sequence.overlap,...(reason?{reason}:{}),
      rawOverlapLength:raw.overlapLength,previousLength:previous?.text.length||0,currentLength:rawText(sample).length,
      retries:overlapRetries,stepPercent:Math.round(stepRatio*10000)/100}}});
  const recoverOverlap=async(sample,issue)=>{
    if(!previous||overlapRetries>=6||anchorRetries>=2||stepRatio<=.1)return {failure:result(issue,sample)};
    overlapRetries++;anchorRetries++;stepRatio=Math.max(.1,stepRatio/2);
    completeness.stableBottomReads=0;
    report('正在缩小滚动步长，补读相邻屏幕的重叠原文…');
    if(previous.geometry.scrollMode==='native'&&!previous.geometry.virtualScroll&&!sample.geometry?.virtualScroll&&Array.isArray(previous.geometry.scrollPositions)){
      await run('restore',{scrollPositions:previous.geometry.scrollPositions});await pause(250);check();
      const restored=await stableSample(null,null,previous);
      if(restored?.issue)return {failure:result(restored.issue,restored)};
      if(rawText(restored)!==previous.text||!sameGeometry(restored.geometry,previous.geometry)||!sameBoundary(restored,previous))
        return {failure:result('回到上一屏后原文或位置已变化，无法继续确认分屏连续性。',restored)};
      // A failed observation is deliberately sticky. Rebuild exclusively from
      // accepted pages; rejected text must never enter the proof or output.
      proof=createClipboardProof({expectedName:name});
      for(const page of pages)if(proof.observe(page).issue)return {failure:result(issue,sample)};
      await run('next',{stepRatio});
    }else{
      // Virtual wheels have no trustworthy absolute offset. Re-prove from the
      // original beginning at the smaller step instead of guessing a reversal.
      pages.length=0;acceptedOverlaps.length=0;platformNotes.clear();proof=createClipboardProof({expectedName:name});previous=null;
      Object.assign(completeness,{topVerified:false,bottomVerified:false,allScreensRead:false,stableBottomReads:0});
      await run('top');
    }
    await pause(250);check();return {retry:true};
  };
  try {
    let prepared=await run('prepare',{name});
    // Observer installation can precede the first asynchronous canvas redraw.
    // Keep the same page session pinned while waiting, rather than reopening
    // a valid candidate before the first drawing has had a chance to finish.
    for(let attempt=0;prepared?.issue&&['baseline','rendering'].includes(prepared.issueCode)&&attempt<20;attempt++) {
      await pause(200);check();
      prepared=await run('sample');
    }
    if(hintAvailable(prepared))prepared=await readHint(prepared);
    if(prepared?.issue)return result(prepared.issue,prepared);
    await run('top');await pause(250);check();
    for(let index=0;index<100;index++) {
      report(`正在后台读取第 ${pages.length+1} 屏简历原文…`);
      let sample=await stableSample(null,previous);
      if(sample?.issue){
        if(sample.failureReason==='scroll-stale'){
          const recovery=await recoverOverlap(sample,sample.issue);if(recovery.retry)continue;return recovery.failure;
        }
        return result(sample.issue,sample);
      }
      if(!pages.length&&!rawText(sample).split(/\r?\n/).slice(0,8).some(line=>matchesCandidateNameLine(line,name)))
        return result('首屏姓名与当前候选人不一致，未保存。',sample);
      if(identity&&!pages.length){
        const changed=await confirmIdentity();if(changed)return result(changed.issue,changed);
      }
      const labels=resumeFoldLabels(rawText(sample));
      if(labels.length) {
        const marks=(sample.marks||[]).filter(mark=>labels.includes(mark.label));
        const mark=marks.find(mark=>marks.filter(other=>other.label===mark.label).length===labels.filter(label=>label===mark.label).length);
        if(!mark)return result('仍有折叠内容，但未能唯一定位展开控件。',{...sample,failureReason:'fold-unlocated'});
        if(++restarts>24)return result('展开次数超过上限，尚未确认简历完整性。',{...sample,failureReason:'expand-limit'});
        report(`正在展开“${mark.label}”，等待页面重新绘制…`);
        await run('expand',{mark});await pause(250);check();
        const expanded=await stableSample({label:mark.label,count:labels.filter(label=>label===mark.label).length});
        if(expanded?.issue)return result(expanded.issue,expanded);
        pages.length=0;acceptedOverlaps.length=0;platformNotes.clear();proof=createClipboardProof({expectedName:name});previous=null;anchorRetries=0;
        Object.assign(completeness,{topVerified:false,bottomVerified:false,allScreensRead:false,stableBottomReads:0});
        await run('top');await pause(250);check();continue;
      }
      // Visible, verified controls can be expanded on a horizontally clipped
      // canvas. Never accept its text until the complete width is confirmed.
      if(sample.geometry.contentWidthVerified===false||sample.geometry.contentWidthVisible===false&&sample.geometry.contentWidthVerified!==true)
        return result('简历画布横向未完整显示，请调整窗口或缩放后重试。',
        {...sample,failureReason:'width-clipped'});
      const text=rawText(sample),geometry=sample.geometry;
      if(!pages.length) {
        if(sample.boundaryRows?.top)return result('简历顶部仍有被画布上边界截断的文字，未确认完整开头。',
          {...sample,failureReason:'boundary-top'});
        if(geometry.scrollMode==='native'&&(geometry.scrollTop>4||geometry.contentTopVisible===false))
          return result('未确认从简历顶部开始读取，未保存。');
      }
      if(previous) {
        const advance=geometry.scrollTop-previous.geometry.scrollTop;
        if(advance<-2)return result('简历滚动跨度不连续，无法确认中间内容完整。',sample);
        if(advance>previous.geometry.clientHeight*.8){
          const recovery=await recoverOverlap(sample,'简历滚动跨度不连续，无法确认中间内容完整。');
          if(recovery.retry)continue;return recovery.failure;
        }
        if(geometry.scrollMode==='native'&&advance>2&&text===previous.text)
          return result('滚动后原文未更新，尚未确认后续内容。');
      }
      const sequence=proof.observe(text);
      completeness.topVerified=sequence.topVerified;
      if(sequence.issue){
        const source=sequence.overlap?overlapFailure(sample,sequence,joinRaw([...pages,text])):sample;
        const recovery=await recoverOverlap(source,sequence.issue.replaceAll('剪贴板','画布原文'));
        if(recovery.retry)continue;return recovery.failure;
      }
      if(sequence.accepted) {
        const overlapLength=sequence.overlap?.overlapLength||0;
        const combined=joinRaw([...pages,text],[...acceptedOverlaps,overlapLength]);
        if(combined.issue){
          const recovery=await recoverOverlap(overlapFailure(sample,sequence,combined,'raw'),combined.issue);
          if(recovery.retry)continue;return recovery.failure;
        }
        if(combined.resume.length>100000)return result('简历原文超过读取上限，未截断保存。');
        if(!rememberNotes(sample))return result('平台提示记录未通过校验，未确认简历完整性。',sample);
        pages.push(text);
        acceptedOverlaps.push(overlapLength);
        anchorRetries=0;
      }
      if(sequence.complete&&sample.boundaryRows?.bottom&&previous?.text===text&&sameGeometry(previous.geometry,geometry)&&sameBoundary(previous,sample))
        return result('简历末尾仍有被画布下边界截断的文字，滚动后未补齐，尚未确认完整。',
          {...sample,failureReason:'boundary-bottom'});
      const terminal=sequence.complete&&!sample.boundaryRows?.bottom&&
        (geometry.scrollMode==='stationary'||atBottom(geometry)&&geometry.contentBottomVisible!==false);
      completeness.stableBottomReads=terminal
        ?previous&&previous.text===text&&sameGeometry(previous.geometry,geometry)&&sameBoundary(previous,sample)?completeness.stableBottomReads+1:1:0;
      if(completeness.stableBottomReads>=2) {
        completeness.bottomVerified=true;
        if(identity){
          await run('top');await pause(250);check();
          const changed=await confirmIdentity();if(changed)return result(changed.issue,changed);
          identityVerified=true;
        }
        completeness.allScreensRead=true;
        await verify();return result();
      }
      previous={text,geometry,boundaryRows:sample.boundaryRows,expectsAdvance:!sequence.complete};
      if(!terminal)await run('next',{stepRatio});
      await pause(250);check();
    }
    return result('已达到后台分屏读取上限，尚未确认全文完整。');
  }finally {
    await browser.scripting.executeScript({target,world:'MAIN',func:backgroundResumeFrame,args:['cleanup',{token}]}).catch(()=>{});
  }
}
