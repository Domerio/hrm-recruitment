// Functions passed to executeScript must be self-contained: no closure dependencies.
export function inspectFrame() {
  if(location.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(location.hostname))return null;
  const element=window.frameElement;
  const visible=document.visibilityState!=='hidden'&&innerWidth>20&&innerHeight>20&&(!element||element.getClientRects().length>0);
  return {key:location.origin+location.pathname,title:document.title.slice(0,80),visible,
    textLength:(document.body?.innerText||'').slice(0,100000).trim().length,
    childCount:document.querySelectorAll('iframe,frame').length};
}

export function chooseFrame(frames, preferredKey='', preferredDocument='') {
  const visible=frames.filter(f=>f.result?.visible);
  if(preferredDocument){const exact=visible.find(f=>f.documentId===preferredDocument);if(exact)return exact;}
  if(preferredKey){
    const matches=visible.filter(f=>f.result.key===preferredKey);
    // Never silently switch to a different document when a calibrated frame vanishes.
    return matches.length===1?matches[0]:null;
  }
  const content=visible.filter(f=>f.result.textLength>=40);
  const embedded=content.filter(f=>f.frameId!==0);
  return [...(embedded.length?embedded:content)].sort((a,b)=>a.result.childCount-b.result.childCount||b.result.textLength-a.result.textLength)[0]||null;
}

export function readFrame(cfg,limit,mode) {
  if(location.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(location.hostname))throw Error('页面已改变');
  if(cfg.frameKey&&cfg.frameKey!==location.origin+location.pathname)throw Error('已校准的内嵌页面已改变，请重新识别或校准');
  const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
  const body=document.body?.innerText||'';
  if(['请完成安全验证','访问过于频繁','拖动滑块'].some(t=>body.includes(t)))throw Error('页面需要人工验证，已停止读取');
  const allRoots=[...document.querySelectorAll(cfg.root)].filter(visible);
  if(allRoots.some(e=>['IFRAME','FRAME','BODY','HTML'].includes(e.tagName)))throw Error('不能把 iframe 或整页当作候选人，请进入内嵌页面重新校准');
  if(mode==='detail'&&allRoots.length!==1)throw Error('详情模式必须仅匹配一个可见区域，请重新校准详情根区域');
  const one=(root,selector)=>selector===':scope'?root:root.querySelector(selector);
  return allRoots.slice(0,mode==='detail'?1:limit).map(root=>{
    const n=one(root,cfg.name),r=one(root,cfg.resume);
    if(!visible(n)||!visible(r))throw Error('姓名或履历区域不可见，请检查适配规则');
    let link='';
    if(cfg.link){const a=one(root,cfg.link);if(visible(a)&&a.href){const url=new URL(a.href);if(url.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(url.hostname))link=url.href;}}
    return {name:n.innerText.trim(),resume:r.innerText.trim(),link};
  });
}
