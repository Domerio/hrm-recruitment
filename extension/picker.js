// Runs in the extension's isolated world. Never reads cookies or page application state.
async function pickRegion(field, mode = 'list') {
  if(location.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(location.hostname))throw Error('请在 BOSS 页面校准');
  if(window.__hrmCancelPicker)window.__hrmCancelPicker();
  if(!['root','name','resume','link'].includes(field)||!['list','detail'].includes(mode))throw Error('未知点选模式');
  const stored=await chrome.storage.local.get(['selectors','profiles']);
  const selectors=stored.profiles?.[mode]||(mode==='list'?stored.selectors||{}:{});
  const frameKey=location.origin+location.pathname;
  if(field!=='root'&&selectors.frameKey&&selectors.frameKey!==frameKey)throw Error('当前内嵌页面与根区域配置不同，请先重新点选根区域');
  if(field!=='root'&&!selectors.root)throw Error('请先点选候选人卡片');
  const host=document.createElement('div');host.id='hrm-picker-overlay';
  const shadow=host.attachShadow({mode:'open'});
  const box=document.createElement('div'), tip=document.createElement('div'), shield=document.createElement('div');
  box.style.cssText='position:fixed;pointer-events:none;border:3px solid #00b89c;background:#00b89c18;z-index:2147483646;box-sizing:border-box';
  tip.style.cssText='position:fixed;left:20px;top:12px;right:20px;padding:16px;background:#064b45;color:white;font:15px/1.6 sans-serif;z-index:2147483647;pointer-events:none;white-space:pre-wrap';
  // Capture the physical hit on our shield, not on a candidate/link below it.
  // Document-level click prevention alone is too late for pointerdown handlers.
  host.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;z-index:2147483647;pointer-events:auto';
  shield.style.cssText='position:fixed;inset:0;background:transparent;cursor:crosshair;outline:none';
  shield.tabIndex=-1;
  shadow.append(shield,box,tip);document.documentElement.append(host);
  if(typeof host.showPopover==='function'){host.setAttribute('popover','manual');host.showPopover();}
  const previousFocus=document.activeElement;
  shield.focus({preventScroll:true});
  let target=null, hovered=null, done=false, saving=false, timer=null;
  const labels={root:mode==='detail'?'单个候选人的详情内容区域':'完整候选人卡片',name:'候选人姓名',resume:mode==='detail'?'详情中的履历内容区域':'履历摘要区域',link:'候选人资料链接（可跳过）'};
  function paint(){
    if(!target)return;
    const r=target.getBoundingClientRect();Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
    tip.textContent=`正在选择：${labels[field]}。移动鼠标定位，↑ 扩大到父区域，↓ 缩小，Enter 或单击确认，Esc 取消。\n当前：${target.tagName.toLowerCase()} · ${String(target.innerText||'').trim().slice(0,85)}`;
  }
  function hit(e){
    host.style.visibility='hidden';
    let element;
    try{element=document.elementFromPoint(e.clientX,e.clientY);}finally{host.style.visibility='visible';}
    return element&&element!==host&&!host.contains(element)?element:null;
  }
  function move(e){if(done||saving)return;const element=hit(e);if(element&&element!==hovered){hovered=element;target=element;paint();}}
  function cleanup(){if(timer)clearTimeout(timer);host.remove();if(previousFocus?.isConnected)previousFocus.focus?.({preventScroll:true});window.__hrmCancelPicker=null;}
  window.__hrmCancelPicker=cleanup;
  function part(el){const classes=[...el.classList].filter(c=>!c.startsWith('hrm-')).slice(0,4);return el.tagName.toLowerCase()+classes.map(c=>'.'+CSS.escape(c)).join('');}
  function relative(el,root){if(el===root)return ':scope';let path=[];while(el&&el!==root){let s=part(el);const parent=el.parentElement;if(parent&&parent.querySelectorAll(':scope > '+s).length>1)s+=':nth-child('+([...parent.children].indexOf(el)+1)+')';path.unshift(s);el=parent;}return ':scope > '+path.join(' > ');}
  async function confirm(){
    if(!target||done||saving)return;
    if(['IFRAME','FRAME'].includes(target.tagName)){tip.textContent='这里仍是一个内嵌页面。请按 Esc 退出，在插件“页面区域”中选择更内层的页面后再点选。';return;}
    if([document.body,document.documentElement].includes(target)){tip.textContent='不能选择整页，请选择单个候选人的卡片。';return;}
    let selector;
    if(field==='root'){
      if(['BUTTON','INPUT','SELECT','TEXTAREA'].includes(target.tagName)||target.getAttribute('role')==='button'||(target.innerText||'').trim().length<40){tip.textContent='请选择包含姓名及履历的整块区域，不要选择联系、转发等按钮。可按 ↑ 扩大。';return;}
      if(!target.classList.length){tip.textContent='该区域没有稳定样式标记，请按 ↑ 选择外层卡片。';return;}
      selector=part(target);
      if(document.querySelectorAll(selector).length>100){tip.textContent='匹配范围过大，请选择更具体的卡片区域。';return;}
    }else{
      const root=target.closest(selectors.root);
      if(!root){tip.textContent='请在已选定的候选人卡片内部点选。';return;}
      if(field==='link'){target=target.closest('a[href]');if(!target||!root.contains(target)){tip.textContent='该区域没有资料链接，可跳过此项。';return;}}
      selector=relative(target,root);
    }
    const updated=field==='root'?{root:selector,name:'',resume:'',link:'',frameKey}:{...selectors,[field]:selector,frameKey};
    saving=true;
    try{const {profiles={}}=await chrome.storage.local.get('profiles');await chrome.storage.local.set({profiles:{...profiles,[mode]:updated}});done=true;tip.textContent=`已保存${labels[field]}，未点击下层页面。请重新打开插件继续选择或预览。`;box.style.display='none';timer=setTimeout(cleanup,1200);}catch(e){tip.textContent='保存失败，请退出后重试。';}finally{saving=false;}
  }
  function block(e){e.preventDefault();e.stopImmediatePropagation();}
  function click(e){block(e);if(!target)move(e);if(!done)confirm();}
  function key(e){if(!['Escape','ArrowUp','ArrowDown','Enter'].includes(e.key))return;e.preventDefault();e.stopImmediatePropagation();if(e.key==='Escape')cleanup();else if(e.key==='Enter')confirm();else if(e.key==='ArrowUp'&&target?.parentElement&&target.parentElement!==document.body){target=target.parentElement;paint();}else if(e.key==='ArrowDown'&&target&&hovered&&target!==hovered){let child=hovered;while(child.parentElement&&child.parentElement!==target)child=child.parentElement;target=child;paint();}}
  tip.textContent=`请把鼠标移动到${labels[field]}，按 ↑ 扩大选择，单击确认；Esc 取消。`;
  shield.addEventListener('pointermove',move);
  for(const type of ['pointerdown','pointerup','mousedown','mouseup','dblclick','auxclick','contextmenu','touchstart','touchend','keyup'])shield.addEventListener(type,block,{capture:true,passive:false});
  shield.addEventListener('click',click,true);shield.addEventListener('keydown',key,true);
}
