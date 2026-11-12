// Screenshot fallback for the canvas-only resume frame observed in saved HTML.
// This never reads application state or calls BOSS APIs.
(() => {
  if(location.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(location.hostname)||!/^\/web\/frame\/c-resume\/?$/.test(location.pathname))return;
  if(window.__hrmCanvas?.version===2)return;
  window.__hrmCanvas?.run('finish').catch(()=>{});
  const D=window.__hrmDom;if(!D)return;
  let session=null;
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const canvases=()=>D.query(document.body,'canvas').filter(e=>D.visible(e)&&e.getBoundingClientRect().width>250&&e.getBoundingClientRect().height>150);
  function scrollRoot(canvas){
    for(let p=canvas;p&&p!==document.body;p=D.parent(p))if(p.clientHeight>150&&p.scrollHeight>p.clientHeight+4&&/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowY))return p;
    return document.scrollingElement;
  }
  function state(){
    const all=canvases();
    if(!session||all.length!==1||all[0]!==session.canvas||!session.scroll.isConnected)throw Error('在线简历画布发生变化，已停止截图');
    if(/请完成安全验证|访问过于频繁|拖动滑块|账号异常/.test(D.text(document.body)))throw Error('页面要求人工验证，已停止');
    const r=session.canvas.getBoundingClientRect(),x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
    if(right-x<250||bottom-y<150)throw Error('在线简历画布未完整显示，请调整 BOSS 窗口后重试');
    const s=session.scroll;
    return {rect:{x,y,width:right-x,height:bottom-y},top:s.scrollTop,height:s.scrollHeight,viewport:s.clientHeight,
      scrollMode:session.mode,attempt:session.attempt,atBottom:session.mode==='dom'&&s.scrollTop+s.clientHeight>=s.scrollHeight-5,
      canvas:{width:session.canvas.width,height:session.canvas.height,cssWidth:r.width,cssHeight:r.height}};
  }
  function wheel(delta){
    const r=state().rect;
    session.canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaMode:0,deltaY:delta,clientX:r.x+r.width/2,clientY:r.y+r.height/2,view:window}));
  }
  function capture(){
    const current=state(),r=current.rect,c=session.canvas,bounds=c.getBoundingClientRect();
    const scale=Math.min(Math.max(2,c.width/bounds.width),3,3000/Math.max(r.width,r.height));
    const out=document.createElement('canvas');out.width=Math.round(r.width*scale);out.height=Math.round(r.height*scale);
    const ctx=out.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,out.width,out.height);
    ctx.drawImage(c,(r.x-bounds.x)*c.width/bounds.width,(r.y-bounds.y)*c.height/bounds.height,r.width*c.width/bounds.width,r.height*c.height/bounds.height,0,0,out.width,out.height);
    try{
      const pixels=ctx.getImageData(0,0,out.width,out.height).data;let ink=0;
      for(let i=0;i<pixels.length&&ink<20;i+=28)if(Math.min(pixels[i],pixels[i+1],pixels[i+2])<230)ink++;
      if(ink<20)return {fallback:true,state:current};
      const image=out.toDataURL('image/png');if(image.length>2800000)throw Error('简历截图超出大小限制');
      return {image,scale:out.width/r.width,scaleY:out.height/r.height,source:'canvas',state:current};
    }catch(error){if(error.name==='SecurityError')return {fallback:true,state:current};throw error;}
  }
  window.__hrmCanvas={version:2,run:async(action,args={})=>{
    if(action==='probe')return {eligible:canvases().length===1};
    if(action==='finish'){
      if(session?.mode==='dom'&&session.canvas.isConnected&&session.scroll.isConnected)session.scroll.scrollTop=session.original;
      session=null;return true;
    }
    if(action==='prepare'){
      const all=canvases();if(all.length!==1)throw Error('未找到唯一的在线简历画布');
      const scroll=scrollRoot(all[0]);if(!scroll)throw Error('未找到在线简历滚动区域');
      session={canvas:all[0],scroll,original:scroll.scrollTop,mode:scroll.scrollHeight>scroll.clientHeight+5?'dom':'canvas',attempt:0};
      if(session.mode==='dom')scroll.scrollTop=0;else wheel(-100000);
      await delay(900);return state();
    }
    const before=state();
    if(action==='state')return before;
    if(action==='capture')return capture();
    if(action==='next'||action==='previous'){
      const step=Math.max(100,before.rect.height*.55)*(action==='previous'?-1:1);session.attempt++;
      if(session.mode==='dom')session.scroll.scrollTop=Math.max(0,Math.min(before.top+step,before.height));else wheel(step);
      await delay(900);const after=state();
      if(action==='next'&&session.mode==='dom'&&!before.atBottom&&Math.abs(after.top-before.top)<2)throw Error('网页滚动位置没有变化，不能确认全文');
      return after;
    }
    if(action==='expand'){
      if(!['查看全部','展开全部','查看更多'].includes(args.label)||!Number.isFinite(args.x)||!Number.isFinite(args.y)||Math.abs(args.top-before.top)>1)throw Error('展开位置已失效，未点击');
      const r=before.rect;
      if(args.x<r.x||args.x>r.x+r.width||args.y<r.y||args.y>r.y+r.height||document.elementFromPoint(args.x,args.y)!==session.canvas)throw Error('展开位置不在简历画布上，未点击');
      for(const type of ['mousemove','mousedown','mouseup','click'])session.canvas.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:args.x,clientY:args.y,button:0,view:window}));
      await delay(650);return state();
    }
    throw Error('未知画布读取动作');
  }};
})();
