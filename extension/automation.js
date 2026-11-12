// DOM-only adapter. No cookies, private API calls, page application state or messaging.
(() => {
  const bossOrigin=origin=>{try{const u=new URL(origin);return u.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(u.hostname);}catch{return false;}};
  const allowedPage=()=>bossOrigin(location.href||location.origin)||(
    ['about:blank','about:srcdoc'].includes(location.href)&&location.ancestorOrigins?.length>0&&[...location.ancestorOrigins].every(bossOrigin));
  if(!allowedPage())return;
  if(window.__hrmAuto?.version===14)return;
  window.__hrmAuto?.run('stop').catch(()=>{});
  const D=window.__hrmDom;
  if(!D)throw Error('HTML 读取组件未加载，请刷新插件');
  const headings=['个人优势','个人简介','期望职位','工作经历','项目经历','教育经历','资格证书','专业技能','所获荣誉','语言能力'];
  const foldLabel=/^(?:查看全部|展开全部|查看更多)(?:(?:[1-9]\d{0,3}(?:个|项|条|段|份)?)?(?:个人优势|个人简介|期望职位|工作经历|工作经验|项目经历|项目经验|教育经历|教育背景|资格证书|专业技能|所获荣誉|荣誉奖项|获奖经历|荣誉|语言能力))?$/;
  const isFold=value=>foldLabel.test(value.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,''));
  const blockedActions=/^(联系.?a|联系.?A|联系他|联系她|立即沟通|打招呼|发送|交换.*|索取.*|收藏|不合适|举报)$/;
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const text=D.text,visible=D.visible;
  const key=()=>location.protocol==='about:'?location.href+'@'+location.ancestorOrigins[0]:location.origin+location.pathname;
  const leaves=root=>{const v=D.view(root);return v.elements.filter(e=>e!==root&&v.texts.get(e)&&!v.elements.some(child=>child!==e&&D.parent(child)===e&&v.texts.get(child)===v.texts.get(e)));};
  const normalize=s=>s.replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/\s+/g,'').replace(/[＊﹡∗]/g,'*');
  function displayName(value){
    const s=normalize(value);if(s.length>70)return '';
    const match=s.match(/^([\p{L}·]{1,20}\*{1,4}|[\p{L}·]{1,12}(?:先生|女士))(.*)$/u);
    if(!match)return '';
    // An activity badge may be inline with the name. Do not use resume prose as a name.
    return !match[2]||/^(刚刚活跃|今日活跃|本周活跃|近期活跃|\d+(?:分钟|小时|天|周|月)内?前?活跃|已收藏)/.test(match[2])?match[1]:'';
  }
  function canonicalSection(value){
    const s=normalize(value).replace(/[：:]/g,'').replace(/[（(]\d+[)）]$/,'');
    return headings.find(h=>h===s)||({'教育背景':'教育经历','工作经验':'工作经历','项目经验':'项目经历','荣誉奖项':'所获荣誉','获奖经历':'所获荣誉'})[s]||'';
  }
  function index(root=document.body){
    const v=D.view(root),elements=v.elements;
    // Read each visible text leaf once. This covers h4/h5, dt/dd, custom elements
    // and names that share a node with an activity badge.
    let ns=[],labels=[];
    for(const el of elements){
      const direct=v.own.get(el)||'', rendered=v.texts.get(el)||'';
      const name=displayName(direct)||displayName(rendered);
      if(name)ns.push({el,name});
      const section=canonicalSection(direct)||canonicalSection(rendered);
      if(section)labels.push({el,section});
    }
    ns=ns.filter(n=>!ns.some(child=>child!==n&&child.name===n.name&&D.contains(n.el,child.el)));
    labels=labels.filter(n=>!labels.some(child=>child!==n&&child.section===n.section&&D.contains(n.el,child.el)));
    return {names:ns,labels,texts:v.texts,stats:v.stats,sections:[...new Set(labels.map(x=>x.section))],elementCount:elements.length};
  }
  const inside=(root,entries)=>entries.filter(x=>D.contains(root,x.el));
  const sectionsIn=(root,idx)=>[...new Set(inside(root,idx.labels).map(x=>x.section))];
  const sectionNames=root=>index(root).sections;
  let stopped=false, records=new Map(), current=null, copyRoot=null, pagerAdvance=null;
  function guard(){
    if(stopped)throw Error('任务已停止');
    if(!allowedPage())throw Error('页面已离开 BOSS');
    if(/请完成安全验证|访问过于频繁|拖动滑块|账号异常/.test(text(document.body)))throw Error('页面要求人工验证，采集已停止');
  }
  function signature(s){
    return s.replace(/(?:刚刚|今日|今天|本周|近期)活跃|\d+(?:分钟|小时|天|周|月)(?:内|前)?活跃/g,'')
      .replace(/近14天你首次看到该牛人(?:[，,]\s*赶紧联系TA吧)?/gi,'')
      .replace(/已收藏|已查看|联系(?:TA|Ta|他|她)/g,'')
      .replace(/热搜/g,'')
      .replace(/\s+/g,' ').trim();
  }
  function cards(idx=index()){
    const found=[];
    for(const root of D.query(document.body,'.geek-info-card')){
      const labels=D.query(root,'.name-label');
      if(labels.length!==1)continue;
      const name=displayName(text(labels[0]));
      if(name)found.push({root,label:labels[0],name,signature:signature(text(root))});
    }
    for(const item of idx.names){
      const label=item.el;
      if((found.length&&D.closest(label,'.geek-info-card'))||D.closest(label,'#hrm-picker-overlay'))continue;
      let root=D.parent(label);
      for(let n=0;root&&n<10&&root!==document.body;n++,root=D.parent(root)){
        const t=idx.texts.get(root)||'';
        if(t.length>6000)break;
        const signals=[/\d+\s*年|应届/.test(t),/本科|硕士|博士|大专|高中/.test(t),/期望|在职|离职|求职/.test(t)];
        if(t.length>=60&&signals.filter(Boolean).length>=2&&inside(root,idx.names).length===1&&!sectionsIn(root,idx).includes('工作经历')){
          if(!found.some(r=>r.root===root))found.push({root,label,name:item.name,signature:signature(t)});
          break;
        }
      }
    }
    const order=new Map(D.elements(document.body).map((element,index)=>[element,index]));
    found.sort((a,b)=>order.get(a.label)-order.get(b.label));
    records=new Map(found.map((r,i)=>[String(i),r]));
    return found.map((r,i)=>({id:String(i),name:r.name,signature:r.signature}));
  }
  function detailReport(expected='',idx=index()){
    const labels=idx.labels.filter(e=>['工作经历','教育经历','项目经历','所获荣誉'].includes(e.section));
    const roots=[];
    for(const label of labels){
      for(let root=D.parent(label.el);root&&root!==document.documentElement;root=D.parent(root)){
        const ns=inside(root,idx.names),identities=[...new Set(ns.map(n=>n.name))],sections=sectionsIn(root,idx);
        const bodySafe=root!==document.body||ns.length===1;
        if(bodySafe&&identities.length===1&&(!expected||identities[0]===normalize(expected))&&sections.length>=2&&(idx.texts.get(root)||'').length>=120){roots.push({root,name:identities[0],sections});break;}
      }
    }
    let unique=roots.filter((r,i)=>roots.findIndex(x=>x.root===r.root)===i);
    // A shared outer wrapper and a specific resume pane describe one resume.
    unique=unique.filter(r=>!unique.some(other=>other!==r&&D.contains(r.root,other.root)));
    const modal=unique.filter(r=>D.closest(r.root,'[role="dialog"],dialog,[aria-modal="true"]'));
    if(modal.length)unique=modal;
    return {detail:unique.length===1?unique[0]:null,diagnostics:{sections:idx.sections,nameNodes:idx.names.length,detailRoots:unique.length,elementCount:idx.elementCount,...idx.stats,bodyRoot:unique.length===1&&unique[0].root===document.body}};
  }
  const detail=(expected='')=>detailReport(expected).detail;
  function clean(root){
    // Preserve visible document order, but omit controls and fixed action labels.
    return text(root).split('\n').map(s=>s.trim()).filter(s=>s&&!blockedActions.test(s)&&!isFold(s)&&!['转发','收起'].includes(s)).join('\n');
  }
  function expanders(root){
    const controls=leaves(root).filter(e=>(isFold(text(e))||text(e)==='展开')&&
      D.closest(e,'[aria-expanded]')?.getAttribute('aria-expanded')!=='true');
    return controls.filter(element=>!controls.some(other=>other!==element&&D.contains(other,element)));
  }
  function scrollRoot(root){
    const eligible=e=>visible(e)&&e.clientHeight>150&&e.scrollHeight>e.clientHeight+4&&/(auto|scroll)/.test(getComputedStyle(e).overflowY);
    let p=root;
    while(p&&p!==document.body){if(eligible(p))return p;p=D.parent(p);}
    const children=D.elements(root).filter(eligible).sort((a,b)=>b.clientWidth-a.clientWidth);
    return children[0]||document.scrollingElement;
  }
  function listOwner(root){
    let child=window, anchor=root, fallback=null;
    try{
      for(let depth=0;depth<10;depth++){
        const doc=child===window?document:child.document;
        const styleOf=child===window?getComputedStyle:element=>child.getComputedStyle(element);
        let fixed=false;
        for(let element=anchor;element;element=element.parentElement){
          const style=styleOf(element);
          if(!fixed&&element.clientHeight>=150&&/^(auto|scroll)$/.test(style.overflowY)){
            const owner={element,win:child,anchor};
            fallback ||= owner;
            if(element.scrollHeight>element.clientHeight+4)return owner;
          }
          if(style.position==='fixed')fixed=true;
        }
        const element=doc.scrollingElement;
        if(!fixed&&element&&element.clientHeight>=150&&!/^(hidden|clip)$/.test(styleOf(element).overflowY)){
          const owner={element,win:child,anchor};
          fallback ||= owner;
          if(element.scrollHeight>element.clientHeight+4)return owner;
        }
        if(child===child.top||!child.top)return fallback;
        const frame=child.frameElement;
        if(!frame)return null;
        child=child.parent;anchor=frame;
        if(D.query(child.document.body,'dialog[open],[role="dialog"],[aria-modal="true"],.dialog-lib-resume').length)return null;
      }
    }catch{return null;}
    return null;
  }
  function usablePager(element){
    if(!visible(element))return false;
    for(let parent=element;parent;parent=D.parent(parent)){
      if(parent.disabled||parent.hasAttribute('disabled')||parent.getAttribute('aria-disabled')==='true'||
          /\bdisabled\b/i.test(String(parent.className||''))||getComputedStyle(parent).pointerEvents==='none')return false;
    }
    const href=element.getAttribute('href');
    if(href&&!['#','javascript:;','javascript:void(0)'].includes(href)){
      try{if(!bossOrigin(new URL(href,element.ownerDocument.baseURI||location.href||location.origin).origin))return false;}
      catch{return false;}
    }
    const r=element.getBoundingClientRect();
    let x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,child=element.ownerDocument.defaultView||window;
    try{
      const doc=child===window?document:child.document;
      if(doc.elementFromPoint&&!D.contains(element,doc.elementFromPoint(x,y)))return false;
      for(;child.top&&child!==child.top;child=child.parent){
        const frame=child.frameElement;if(!frame)return false;
        const bounds=frame.getBoundingClientRect();x+=bounds.left+frame.clientLeft;y+=bounds.top+frame.clientTop;
        if(frame.ownerDocument.elementFromPoint(x,y)!==frame)return false;
      }
    }catch{return false;}
    return true;
  }
  function advanceList(){
    const waiting={kind:'waiting',moved:false};
    const idx=index(),report=detailReport('',idx);
    if(!frameVisible()||report.diagnostics.detailRoots||canvasDialog()||
        D.query(document.body,'dialog[open],[role="dialog"],[aria-modal="true"]').length)return waiting;
    const found=cards(idx);
    if(!found.length)return waiting;
    const items=[...records.values()];
    let listRoot=D.parent(items[0].root);
    while(listRoot&&!items.every(item=>D.contains(listRoot,item.root)))listRoot=D.parent(listRoot);
    if(!listRoot||listRoot===document.body&&new Set(items.map(item=>D.parent(item.root))).size>1)return waiting;
    const owners=items.map(item=>listOwner(D.parent(item.root)));
    if(owners.some(owner=>!owner)||new Set(owners.map(owner=>owner.element)).size!==1)return waiting;
    const owner=owners[0],scroll=owner.element;
    const before=scroll.scrollTop,maximum=scroll.scrollHeight-scroll.clientHeight;
    if(!Number.isFinite(before)||!Number.isFinite(maximum)||maximum<0)return waiting;
    if(before<maximum-4){
      scroll.scrollTop=Math.min(maximum,before+Math.max(120,Math.min(600,scroll.clientHeight*.75)));
      return scroll.scrollTop>before+1?{kind:'scroll',moved:true}:waiting;
    }
    let scope=owner.win===window?listRoot:D.parent(owner.anchor);
    while(scope){
      // A page-level sidebar may have its own "next page". Do not broaden a
      // nested candidate list to the entire body merely to find navigation.
      if(scope===owner.win.document?.body&&scope!==listRoot)return waiting;
      const candidates=D.query(scope,'button,a,[role="button"]').filter(usablePager);
      for(const [label,kind] of [['加载更多','load-more'],['下一页','next-page']]){
        const buttons=candidates.filter(element=>text(element).trim()===label||
          element.getAttribute('aria-label')===label||element.getAttribute('title')===label);
        if(buttons.length>1)return waiting;
        if(buttons.length===1){
          const button=buttons[0],fingerprint=JSON.stringify({cards:found.map(card=>card.signature),
            url:location.href||key(),height:scroll.scrollHeight,top:scroll.scrollTop});
          if(pagerAdvance?.fingerprint===fingerprint)return waiting;
          guard();
          pagerAdvance={button,fingerprint};button.click();
          return {kind,moved:true};
        }
      }
      if(scope===scroll||scope===owner.win.document?.body||scope===document.body)break;
      scope=D.parent(scope);
    }
    return waiting;
  }
  function control(root,label){
    const found=leaves(root).filter(e=>text(e)===label&&!blockedActions.test(text(e)));
    if(found.length!==1)throw Error(`没有唯一的“${label}”入口，已停止该操作`);
    const el=found[0],a=D.closest(el,'a[href]');
    if(a&&a.getAttribute('href')&&!['#','javascript:;','javascript:void(0)'].includes(a.getAttribute('href')))throw Error('操作入口包含跳转链接，未自动点击');
    el.click();
  }
  function shell(root){
    return D.closest(root,'[role="dialog"],dialog,[aria-modal="true"]')||D.parent(root);
  }
  function frameVisible(){
    for(let child=window;child.top&&child!==child.top;child=child.parent){
      const frame=child.frameElement;
      if(!frame||!frame.getClientRects().length)return false;
      if(frame.checkVisibility&&!frame.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;
      const r=frame.getBoundingClientRect();
      if(r.right<=0||r.bottom<=0||r.left>=child.parent.innerWidth||r.top>=child.parent.innerHeight)return false;
    }
    return true;
  }
  function canPoint(element){
    const bounds=element.getBoundingClientRect();
    let x=(bounds.left+bounds.right)/2,y=(bounds.top+bounds.bottom)/2;
    if(document.elementFromPoint&&!D.contains(element,document.elementFromPoint(x,y)))return false;
    for(let child=window;child.top&&child!==child.top;child=child.parent){
      const frame=child.frameElement;
      if(!frame)return false;
      const r=frame.getBoundingClientRect();
      x+=r.left+frame.clientLeft;y+=r.top+frame.clientTop;
      if(frame.ownerDocument.elementFromPoint(x,y)!==frame)return false;
    }
    return true;
  }
  const canvasPath=url=>{try{const u=new URL(url,location.origin);return bossOrigin(u.origin)&&/^\/web\/frame\/c-resume\/?$/.test(u.pathname);}catch{return false;}};
  function canvasDialog(){
    const roots=D.query(document.body,'.dialog-lib-resume').filter(root=>D.query(root,'.resume-detail-wrap iframe').length);
    if(roots.length>1)throw Error('存在多份在线简历详情');
    return roots[0]||null;
  }
  function detailShell(expected,kind){
    if(kind==='canvas'){
      const root=canvasDialog();
      if(!root)throw Error('简历详情已关闭或切换');
      return root;
    }
    const d=detail(expected);
    if(!d)throw Error('候选人详情已变化');
    return shell(d.root);
  }
  function closeRegion(root){
    for(let area=root;area&&area!==document.body;area=D.parent(area)){
      const button=closingControl(area);if(button){button.click();return;}
    }
    throw Error('无法唯一识别关闭按钮，已暂停；请手动关闭当前弹窗后重新开始');
  }
  function closingControl(root){
    const r=root.getBoundingClientRect();
    const options=D.query(root,'button,a,span,i,div').filter(e=>{
      if(!visible(e))return false;
      const s=text(e),label=(e.getAttribute('aria-label')||e.getAttribute('title')||'').toLowerCase();
      const rect=e.getBoundingClientRect();
      return !blockedActions.test(s)&&rect.width<90&&rect.height<90&&rect.left>r.left+r.width*.65&&rect.top<r.top+110&&
        (['关闭','close'].includes(label)||/^[×✕✖]$/.test(s)||(!s&&/close/i.test(e.className||'')));
    });
    const outer=options.filter(e=>!options.some(x=>x!==e&&D.contains(x,e)));
    if(outer.length>1)throw Error('关闭按钮不唯一，已停止');
    return outer[0]||null;
  }
  async function read(expected){
    guard();const d=detail(expected);if(!d)throw Error('未识别到唯一的在线简历详情；不会把列表摘要当作完整简历');
    current=d;
    const scroll=scrollRoot(d.root), original=scroll.scrollTop, chunks=[], attempted=new WeakSet();
    let stable=0,last='',complete=false;
    scroll.scrollTop=0;
    try{
      for(let round=0;round<45;round++){
        guard();if(!d.root.isConnected)throw Error('简历页面发生变化，未保存');
        for(const e of expanders(d.root)){
          if(attempted.has(e))continue;
          guard();attempted.add(e);e.click();await delay(180);
        }
        await delay(400);guard();
        const t=clean(d.root);if(!chunks.includes(t))chunks.push(t);
        const bottom=scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-5;
        stable=bottom&&t===last?stable+1:0;last=t;
        if(stable>=2){complete=expanders(d.root).length===0&&!/加载中|加载更多/.test(t);break;}
        scroll.scrollTop=Math.min(scroll.scrollTop+Math.max(160,scroll.clientHeight*.8),scroll.scrollHeight);
      }
    }finally{if(scroll.isConnected)scroll.scrollTop=original;}
    // Normal pages retain all loaded text. For virtualized content preserve each
    // snapshot explicitly, rather than pretending a fragment is the whole resume.
    const longest=[...chunks].sort((a,b)=>b.length-a.length)[0]||'';
    const virtual=chunks.some(t=>!longest.includes(t)&&!t.split('\n').every(line=>longest.includes(line)));
    const resume=virtual?chunks.map((s,i)=>`【滚动片段 ${i+1}】\n${s}`).join('\n\n'):longest;
    if(resume.length<120||resume.length>30000)throw Error('详情内容过短或超出 30000 字上限，未截断入库');
    const warnings=[];
    if(!complete)warnings.push('未确认全部展开或到达稳定底部');
    if(virtual)warnings.push('检测到动态替换内容，已保留滚动片段，请人工核对');
    if(D.view(d.root).stats.truncated)warnings.push('页面内容超出 HTML 遍历范围，请人工核对');
    return {name:d.name,resume,link:'',capture:{status:complete&&!warnings.length?'visible_complete':'needs_review',sections:sectionNames(d.root),warnings,frame_key:key(),captured_at:new Date().toISOString(),share_status:'未获取'}};
  }
  function selectCopy(expected){
    const d=detail(expected);
    if(!d||current?.root!==d.root)throw Error('简历详情已变化，无法选中正文');
    clearCopy();
    const changed=!d.root.hasAttribute('tabindex');
    if(changed)d.root.setAttribute('tabindex','-1');
    copyRoot={root:d.root,changed};
    d.root.focus({preventScroll:true});
    const selection=window.getSelection(),range=document.createRange();
    range.selectNodeContents(d.root);
    selection.removeAllRanges();selection.addRange(range);
    return copyFocused();
  }
  function copyFocused(){
    const selection=window.getSelection();
    return !!(copyRoot?.root.isConnected&&document.hasFocus()&&selection?.rangeCount&&!selection.isCollapsed&&
      D.contains(copyRoot.root,selection.anchorNode)&&D.contains(copyRoot.root,selection.focusNode));
  }
  function clearCopy(){
    if(!copyRoot)return true;
    const selection=window.getSelection();
    if(D.contains(copyRoot.root,selection?.anchorNode))selection.removeAllRanges();
    if(copyRoot.changed&&copyRoot.root.getAttribute('tabindex')==='-1')copyRoot.root.removeAttribute('tabindex');
    copyRoot=null;return true;
  }
  async function share(expected,kind){
    guard();control(detailShell(expected,kind),'转发');await delay(500);guard();
    control(document.body,'转发至其他');
    for(let n=0;n<12;n++){
      await delay(300);guard();
      const hints=leaves(document.body).filter(e=>/可识别二维码查看详情|右键复制图片发送至微信好友/.test(text(e))&&text(e).length<90);
      for(const hint of hints){
        for(let root=D.parent(hint);root&&root!==document.body;root=D.parent(root)){
          const imgs=D.query(root,'img,canvas').filter(e=>visible(e)&&e.getBoundingClientRect().width>=90&&e.getBoundingClientRect().height>=90);
          if(!imgs.length)continue;
          const r=root.getBoundingClientRect();
          if(r.width>100&&r.height>100&&r.width<innerWidth*.95&&r.height<innerHeight*.95&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight){
            return {frameKey:key(),rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},name:expected};
          }
          break;
        }
      }
    }
    throw Error('未识别到完整可见的分享二维码卡片；简历可以保存，图片需补充');
  }
  function closeShare(){
    const hint=leaves(document.body).find(e=>text(e)==='转发至其他');
    if(!hint)return;
    let root=D.parent(hint);
    while(root&&root!==document.body){
      if(text(root).includes('邮件转发')){closeRegion(root);return;}
      root=D.parent(root);
    }
    throw Error('分享窗口仍打开，请手动关闭后重新开始');
  }
  window.__hrmAuto={version:14,run:async(action,args={})=>{
    if(action==='clear-copy')return clearCopy();
    if(action==='stop'){stopped=true;return true;}
    if(action==='reset'){stopped=false;pagerAdvance=null;window.__hrmCancelPicker?.();return true;}
    guard();
    if(action==='scan'){
      const idx=index(),report=detailReport('',idx),shown=frameVisible(),dialog=shown&&!!canvasDialog();
      return {frameKey:key(),detail:shown?report.detail?.name||'':'',canvasDialog:dialog,
        canvasBody:shown&&canvasPath(location.href)&&idx.stats.canvas===1&&!!window.frameElement?.closest('.dialog-lib-resume'),diagnostics:report.diagnostics,
        cards:shown&&!dialog&&!report.detail?cards(idx):[]};
    }
    if(action==='html'){const idx=index(),report=detailReport('',idx),root=report.detail?.root||document.body;return {frameKey:key(),diagnostics:report.diagnostics,scope:report.detail?'detail':'page',...D.snapshot(root)};}
    if(action==='advance-list')return advanceList();
    if(action==='open'){
      const r=records.get(args.id);if(!r||!visible(r.root)||signature(text(r.root))!==args.signature)throw Error('列表已更新，请重新开始采集');
      if(blockedActions.test(text(D.closest(r.label,'button')||r.label)))throw Error('候选人入口不明确');
      const link=D.closest(r.label,'a[href]');
      if(link&&!['#','javascript:;','javascript:void(0)'].includes(link.getAttribute('href'))){const u=new URL(link.href,location.href);if(u.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(u.hostname))throw Error('候选人入口不属于 BOSS，未打开');}
      r.label.scrollIntoView({block:'center'});
      if(!canPoint(r.label))throw Error('候选人小卡片被遮挡，请先关闭浮层。');
      r.label.click();return {name:r.name};
    }
    if(action==='read')return read(args.name);
    if(action==='prepare-copy'){
      const {capture,resume}=await read(args.name);
      const d=detail(args.name);
      if(!d||current?.root!==d.root||!d.root.isConnected)throw Error('简历详情已变化，无法确认正文范围');
      const normalized=resume.replace(/\s/g,'');
      const changed=capture.status==='visible_complete'&&clean(d.root).replace(/\s/g,'')!==normalized;
      return {...capture,...(changed?{status:'needs_review',warnings:[...capture.warnings,'复制前详情正文发生变化，请重试']}:{}),
        minimumLength:normalized.length,contentHead:normalized.slice(0,80),contentTail:normalized.slice(-80)};
    }
    if(action==='select-copy')return selectCopy(args.name);
    if(action==='copy-focused')return copyFocused();
    if(action==='expand-canvas'){
      const root=detailShell(args.name,'canvas');
      for(const el of expanders(root)){guard();el.click();await delay(180);}
      return true;
    }
    if(action==='share')return share(args.name,args.kind);
    if(action==='closeShare'){closeShare();return true;}
    if(action==='close'){
      closeShare();const root=detailShell(args.name,args.kind);
      const buttons=args.kind==='canvas'?D.query(root,'.close-btn'):[];
      if(buttons.length===1)buttons[0].click();else closeRegion(root);
      return true;
    }
    if(action==='layout')return {key:key(),width:innerWidth,height:innerHeight,children:D.query(document.body,'iframe').filter(visible).map(e=>{const r=e.getBoundingClientRect();let src='';try{const u=new URL(e.src);src=u.origin+u.pathname;}catch{}return {key:src,x:r.x+e.clientLeft,y:r.y+e.clientTop,width:e.clientWidth,height:e.clientHeight};})};
    throw Error('未知采集动作');
  }};
})();
