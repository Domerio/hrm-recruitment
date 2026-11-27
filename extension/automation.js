// DOM-only adapter. No cookies, private API calls, page application state or messaging.
(() => {
  const bossOrigin=origin=>{try{const u=new URL(origin);return u.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(u.hostname);}catch{return false;}};
  const allowedPage=()=>bossOrigin(location.href||location.origin)||(
    ['about:blank','about:srcdoc'].includes(location.href)&&location.ancestorOrigins?.length>0&&[...location.ancestorOrigins].every(bossOrigin));
  if(!allowedPage())return;
  if(window.__hrmAuto?.version===46)return;
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
  const activity=/^(?:热搜|首页推荐|刚刚活跃|今日活跃|本周活跃|本月活跃|近期活跃|在线|\d+(?:分钟|小时|天|周|月)内?前?活跃|已收藏)+$/;
  function displayName(value,full=false){
    const s=normalize(value);if(s.length>70)return '';
    const match=s.match(/^([\p{L}·]{1,20}\*{1,4}|[\p{L}·]{1,12}(?:先生|女士))(.*)$/u);
    if(!match){
      if(!full)return '';
      const plain=s.match(/^([\p{Script=Han}]{2,8})(.*)$/u);
      if(!plain)return '';
      // Activity labels may share the name node. Try each prefix, but require
      // all remaining characters to be an exact badge, never arbitrary prose.
      for(let size=2;size<=8&&size<=s.length;size++){
        const name=s.slice(0,size),tail=s.slice(size);
        if(/^[\p{Script=Han}]{2,8}$/u.test(name)&&(!tail||activity.test(tail))&&
            !/牛人|推荐|经历|姓名|职位|工程|算法|公司|学院|大学|技术|学历|项目|本科|硕士|博士|优势|活跃|离职|在职/.test(name))return name;
      }
      return '';
    }
    // An activity badge may be inline with the name. Do not use resume prose as a name.
    return !match[2]||activity.test(match[2])?match[1]:'';
  }
  const profileMetadata=value=>/\d{1,2}\s*岁/.test(value)&&/\d{1,2}\s*年|应届/.test(value)&&
    /本科|硕士|博士|大专|高中|中专/.test(value)&&/在职|离职|应届|求职/.test(value);
  const latinName=value=>/^[A-Za-z]{3,30}$/.test(String(value||'').trim())?String(value).trim():'';
  const boundLatinName=()=>expectedDetailName!==null?latinName(expectedDetailName):
    openedCandidate?.latin?openedCandidate.name:'';
  const uniqueProfileMetadata=value=>profileMetadata(value)&&
    (value.match(/\d{1,2}\s*岁/g)||[]).length===1&&
    (value.match(/\d{1,2}\s*年(?:以上|以下)?|应届/g)||[]).length===1&&
    (value.match(/本科|硕士|博士|大专|高中|中专/g)||[]).length===1&&
    (value.match(/在职|离职|应届|求职/g)||[]).length===1;
  function fullNameContext(el,name,view){
    if(!name)return false;
    const labelled=/(?:^|[-_\s])(name|geek-name|candidate-name|name-label)(?:$|[-_\s])/.test(String(el.className||''))||
      !!D.closest(el,'.name-label,.geek-name,.candidate-name');
    for(let root=D.parent(el),depth=0;root&&depth<5;root=D.parent(root),depth++){
      const value=view.texts.get(root)||'';
      if(value.length>6000)return false;
      const age=value.search(/\d{1,2}\s*岁/),nameAt=value.indexOf(name);
      if(age>=0&&profileMetadata(value.slice(age,age+150))){
        // Bind an unmasked name to the header immediately before its own
        // demographic row; names elsewhere in the summary remain ordinary text.
        if(nameAt<0||nameAt>age||age-nameAt>90)return false;
        const prefix=normalize(value.slice(0,nameAt)).replace(/^(?:\d+(?:-\d+)?[Kk]|面议)/,'');
        return labelled||prefix==='';
      }
      if(root===document.body)break;
    }
    return false;
  }
  function boundLatinDetailName(el,own,view){
    const name=latinName(own);
    if(!name||boundLatinName()!==name||
        !el.matches('h1,h2,h3,h4,.geek-name,.candidate-name,.name-label')||
        D.closest(el,'.candidate-card-wrap,.geek-info-card,.operate-side,button,a'))return '';
    const pane=D.closest(el,'[role="dialog"],dialog,[aria-modal="true"],.resume-left,.resume-detail-wrap,.dialog-lib-resume');
    if(!pane&&D.query(document.body,'.candidate-card-wrap').length)return '';
    for(let root=D.parent(el),depth=0;root&&depth<5;root=D.parent(root),depth++){
      const value=view.texts.get(root)||'',nameAt=value.indexOf(name),ageAt=value.search(/\d{1,2}\s*岁/);
      if(value.length<=6000&&nameAt>=0&&ageAt>nameAt&&ageAt-nameAt<=90){
        const row=value.slice(ageAt).split('\n')[0].slice(0,150);
        if(uniqueProfileMetadata(row))return name;
      }
      if(root===pane)break;
    }
    return '';
  }
  function promotions(view=D.view(document.body)){
    const titles=view.elements.filter(el=>/^(?:热搜牛人推荐|热搜牛人相关推荐)$/.test(normalize(view.texts.get(el)||'')))
      .filter(el=>!view.elements.some(child=>child!==el&&D.contains(el,child)&&
        normalize(view.texts.get(child)||'')===normalize(view.texts.get(el)||'')));
    const found=[];
    for(const title of titles){
      let modal=D.closest(title,'[role="dialog"],dialog,[aria-modal="true"]');
      if(!modal)for(let parent=D.parent(title);parent&&parent!==document.body;parent=D.parent(parent)){
        // Class-only page dialogs often wrap their title in a dialog-header.
        // That header is not the modal's scope; bind to the containing panel.
        const classes=String(parent.className||'');
        if(/(?:^|[-_\s])(?:dialog|modal)(?:$|[-_\s])/.test(classes)&&!/header|title/.test(classes)){
          modal=parent;break;
        }
      }
      let root=modal;
      for(let parent=D.parent(title);!root&&parent&&parent!==document.body;parent=D.parent(parent)){
        const value=view.texts.get(parent)||'';
        const hasProfile=value=>/\d{1,2}\s*岁|\d{1,2}\s*年|应届/.test(value)&&/本科|硕士|博士|大专|高中/.test(value);
        if(!hasProfile(value))continue;
        const branches=view.elements.filter(element=>D.parent(element)===parent),heading=branches.findIndex(element=>D.contains(element,title));
        const profiles=branches.filter(element=>hasProfile(view.texts.get(element)||''));
        const mixedCards=profiles.some(element=>/首页推荐|推荐理由/.test(view.texts.get(element)||''))&&
          profiles.some(element=>!/首页推荐|推荐理由/.test(view.texts.get(element)||''));
        const listBoundary=['MAIN','UL','OL'].includes(parent.tagName)||parent.getAttribute('role')==='list'||mixedCards||
          branches.slice(0,heading).some(element=>hasProfile(view.texts.get(element)||''));
        // A flat list can put the campaign heading beside its promoted card.
        // Bind that first following card, never the shared list and its peers.
        root=listBoundary?(branches.slice(heading+1).find(element=>hasProfile(view.texts.get(element)||''))||branches[heading]):parent;
        break;
      }
      if(root&&!found.some(item=>item.root===root))found.push({root,title,modal:!!modal});
    }
    return found;
  }
  const excluded=(el,scopes)=>scopes.some(item=>D.contains(item.root,el));
  function canonicalSection(value){
    const s=normalize(value).replace(/[：:]/g,'').replace(/[（(]\d+[)）]$/,'');
    return headings.find(h=>h===s)||({'教育背景':'教育经历','工作经验':'工作经历','项目经验':'项目经历','荣誉奖项':'所获荣誉','获奖经历':'所获荣誉'})[s]||'';
  }
  function deepestSameValue(entries,field){
    const groups=new Map(),ancestors=new Set();
    for(const entry of entries){
      if(!groups.has(entry[field]))groups.set(entry[field],new Set());
      groups.get(entry[field]).add(entry.el);
    }
    for(const entry of entries){
      const group=groups.get(entry[field]);
      for(let parent=D.parent(entry.el);parent;parent=D.parent(parent))if(group.has(parent))ancestors.add(parent);
    }
    return entries.filter(entry=>!ancestors.has(entry.el));
  }
  function index(root=document.body){
    const v=D.view(root),elements=v.elements,ignored=promotions(v);
    // Read each visible text leaf once. This covers h4/h5, dt/dd, custom elements
    // and names that share a node with an activity badge.
    let ns=[],labels=[],overviews=[];
    for(const el of elements){
      if(excluded(el,ignored))continue;
      const direct=v.own.get(el)||'', rendered=v.texts.get(el)||'';
      let name=displayName(direct)||displayName(rendered);
      if(!name){
        const full=displayName(direct,true)||displayName(rendered,true);
        if(fullNameContext(el,full,v))name=full;
      }
      if(!name)name=boundLatinDetailName(el,direct,v);
      if(name)ns.push({el,name});
      if(normalize(direct)==='经历概览'||normalize(rendered)==='经历概览')overviews.push(el);
      const section=canonicalSection(direct)||canonicalSection(rendered);
      if(section)labels.push({el,section});
    }
    ns=deepestSameValue(ns,'name');
    labels=deepestSameValue(labels,'section');
    return {names:ns,labels,overviews,texts:v.texts,stats:v.stats,promotions:ignored,sections:[...new Set(labels.map(x=>x.section))],elementCount:elements.length};
  }
  const inside=(root,entries)=>entries.filter(x=>D.contains(root,x.el));
  const sectionsIn=(root,idx)=>[...new Set(inside(root,idx.labels).map(x=>x.section))];
  const sectionNames=root=>index(root).sections;
  let stopped=false, records=new Map(), current=null, copyRoot=null, pagerAdvance=null, shareSession=null, colleagueSession=null, colleagueSequence=0, favoriteSession=null, favoriteSequence=0, openedCandidate=null, expectedDetailName=null;
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
  function recommendationIdentity(root){
    const inners=D.query(root,'.card-inner');
    if(inners.length!==1)return '';
    const values=['data-geek','data-geekid'].map(key=>inners[0].getAttribute(key)).filter(value=>value!==null&&value!=='');
    return values.length&&values.every(value=>/^[A-Za-z0-9_~-]{1,160}$/.test(value)&&value===values[0])?values[0]:'';
  }
  function cards(idx=index()){
    const found=[];
    if(idx.promotions.some(item=>item.modal)){records=new Map();return [];}
    // The recommendation page uses card-item/candidate-card-wrap rather than
    // geek-info-card. Bind the name to its own demographic row and full card;
    // the neighboring "打招呼" control and hot-search guide are never targets.
    for(const root of D.query(document.body,'.card-item > .candidate-card-wrap')){
      if(root.matches('.anonymous-geek-guide-card')||excluded(root,idx.promotions)||
          idx.promotions.some(item=>D.contains(root,item.root)))continue;
      const labels=D.query(root,'.card-inner .name-wrap .name');
      if(labels.length!==1||!D.query(root,'.card-inner .expect-wrap').length||
          !D.query(root,'.card-inner .geek-desc').length)continue;
      const metadata=D.query(root,'.card-inner .base-info');
      if(metadata.length!==1||!profileMetadata(text(metadata[0])))continue;
      const known=idx.names.find(item=>item.el===labels[0]||D.contains(labels[0],item.el))?.name;
      const latin=latinName(text(labels[0]));
      const name=known||uniqueProfileMetadata(text(metadata[0]))&&latin;
      if(name)found.push({root,label:labels[0],name,signature:signature(text(root)),kind:'recommendation',
        platform_geek_id:recommendationIdentity(root)});
    }
    for(const root of D.query(document.body,'.geek-info-card')){
      if(excluded(root,idx.promotions)||idx.promotions.some(item=>D.contains(root,item.root)))continue;
      const labels=D.query(root,'.name-label');
      if(labels.length!==1)continue;
      const name=idx.names.find(item=>item.el===labels[0]||D.contains(labels[0],item.el))?.name;
      if(name)found.push({root,label:labels[0],name,signature:signature(text(root))});
    }
    for(const item of idx.names){
      const label=item.el;
      if(excluded(label,idx.promotions)||D.closest(label,'.candidate-card-wrap')||
          (found.length&&D.closest(label,'.geek-info-card'))||D.closest(label,'#hrm-picker-overlay'))continue;
      let root=D.parent(label);
      for(let n=0;root&&n<10&&root!==document.body;n++,root=D.parent(root)){
        const t=idx.texts.get(root)||'';
        if(t.length>6000||excluded(root,idx.promotions)||idx.promotions.some(item=>D.contains(root,item.root)))break;
        const signals=[/\d+\s*年|应届/.test(t),/本科|硕士|博士|大专|高中/.test(t),/期望|在职|离职|求职/.test(t)];
        if(t.length>=60&&signals.filter(Boolean).length>=2&&inside(root,idx.names).length===1&&!sectionsIn(root,idx).includes('工作经历')){
          if(!found.some(r=>r.root===root))found.push({root,label,name:item.name,signature:signature(t)});
          break;
        }
      }
    }
    // Responsive wrappers can both carry the card class around one name node.
    // Collapse only that same DOM entry with identical content, never separate
    // labels that happen to share a masked name or even the entire summary.
    const unique=found.filter(card=>!found.some(other=>other!==card&&other.root!==card.root&&
      other.label===card.label&&other.name===card.name&&other.signature===card.signature&&
      D.contains(card.root,other.root)));
    const order=new Map(D.elements(document.body).map((element,index)=>[element,index]));
    unique.sort((a,b)=>order.get(a.label)-order.get(b.label));
    records=new Map(unique.map((r,i)=>[String(i),{...r,parent:D.parent(r.root)}]));
    return unique.map((r,i)=>({id:String(i),name:r.name,signature:r.signature,
      ...(r.kind==='recommendation'?{kind:r.kind,platform_geek_id:r.platform_geek_id}:{})}));
  }
  function detailReport(expected='',idx=index()){
    if(idx.promotions.some(item=>item.modal))return {detail:null,diagnostics:{sections:[],nameNodes:0,detailRoots:0,elementCount:idx.elementCount,...idx.stats,bodyRoot:false}};
    const labels=idx.labels.filter(e=>['工作经历','教育经历','项目经历','所获荣誉'].includes(e.section));
    const roots=[];
    for(const label of labels){
      for(let root=D.parent(label.el);root&&root!==document.documentElement;root=D.parent(root)){
        const ns=inside(root,idx.names),identities=[...new Set(ns.map(n=>n.name))],sections=sectionsIn(root,idx);
        const bodySafe=root!==document.body||ns.length===1;
        // A recommendation detail's right-hand timeline repeats employers and
        // dates. Never widen the resume body to a wrapper containing that pane.
        const includesOverview=idx.overviews.some(element=>D.contains(root,element));
        const latinBound=!!boundLatinName()&&identities[0]===boundLatinName();
        if(bodySafe&&!includesOverview&&(!latinBound||
            (ns.length===1&&!D.query(root,'.candidate-card-wrap').length))&&
            identities.length===1&&(!expected||identities[0]===normalize(expected))&&
            sections.length>=2&&(idx.texts.get(root)||'').length>=120){roots.push({root,name:identities[0],sections});break;}
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
  function mediaPreviewAncestor(element){
    for(let parent=element;parent;parent=D.parent(parent)){
      if(['IMG','PICTURE','VIDEO','AUDIO'].includes(parent.tagName))return true;
      for(const attribute of ['class','id','aria-label','title','data-action','data-role']){
        const value=(parent.getAttribute?.(attribute)||'').replace(/([a-z])([A-Z])/g,'$1-$2').toLowerCase();
        if(/(?:^|[\s_-])(?:avatar|portrait|photo|photograph|head-img|head-image)(?:$|[\s_-])/.test(value)||
            /(?:^|[\s_-])(?:image|img|media|video)[_-]?(?:preview|viewer|zoom)(?:$|[\s_-])/.test(value)||
            /(?:^|[\s_-])(?:preview|viewer|zoom)[_-]?(?:image|img|media|video)(?:$|[\s_-])/.test(value)||
            /头像|照片|相片|证件照|(?:图片|图像|视频|媒体).*(?:预览|放大|查看)|(?:查看|预览|放大).*(?:图片|图像|大图|视频|媒体)/.test(value))return true;
      }
    }
    return false;
  }
  function explicitResumeFold(element,root){
    const control=D.closest(element,'button,[role="button"],a')||element;
    const subjects=[...headings,'工作经验','项目经验','教育背景','荣誉奖项','获奖经历','简历正文'];
    if(['aria-label','title'].some(attribute=>{
      const label=normalize(control.getAttribute(attribute)||'');
      return subjects.some(subject=>['展开','查看全部','展开全部','查看更多'].some(prefix=>label===prefix+subject));
    }))return true;
    const controlled=(control.getAttribute('aria-controls')||'').trim();
    if(controlled&&!/\s/.test(controlled)){
      const target=control.ownerDocument.getElementById(controlled);
      if(target&&target!==root&&D.contains(root,target)&&!mediaPreviewAncestor(target)&&
          target.matches('.resume-section,.resume-item,.resume-text,.resume-content,.resume-fold,.resume-collapse,[data-resume-section],[data-resume-fold]'))return true;
    }
    for(let parent=element;parent&&D.contains(root,parent);parent=D.parent(parent)){
      if(parent.hasAttribute('data-resume-fold')||/(?:^|[\s_-])(?:resume[-_](?:fold|collapse)|(?:fold|collapse)[-_]resume)(?:$|[\s_-])/.test(String(parent.className||'')))return true;
      if(parent!==root&&parent.matches('.resume-section,.resume-item,[data-resume-section]')&&sectionNames(parent).length===1)return true;
    }
    return false;
  }
  function clean(root){
    // Preserve visible document order, but omit controls and fixed action labels.
    return text(root).split('\n').map(s=>s.trim()).filter(s=>s&&!blockedActions.test(s)&&!isFold(s)&&!['转发','收起'].includes(s)).join('\n');
  }
  function resumeFoldControls(root){
    const controls=leaves(root).filter(e=>!mediaPreviewAncestor(e)&&
      (isFold(text(e))||text(e)==='展开')&&
      D.closest(e,'[aria-expanded]')?.getAttribute('aria-expanded')!=='true');
    return controls.filter(element=>!controls.some(other=>other!==element&&D.contains(other,element)));
  }
  function expanders(root){
    return resumeFoldControls(root).filter(element=>text(element)!=='展开'||explicitResumeFold(element,root));
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
    if(promotions().some(item=>item.modal))return null;
    const roots=D.query(document.body,'.dialog-lib-resume').filter(root=>D.query(root,'.resume-detail-wrap iframe').length);
    if(roots.length>1)throw Error('存在多份在线简历详情');
    return roots[0]||null;
  }
  const detailTokens=new WeakMap(),detailTokenPrefix=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  let detailTokenSequence=0,previewScope=null;
  function rememberPreviewScope(root,content=null,bound=null){
    const frame=window.frameElement||null;
    previewScope={root,content,body:document.body,url:location.href,frame,frameSrc:frame?.getAttribute('src'),
      childFrame:bound?.frame,childSrc:bound?.frame?.getAttribute('src'),childWindow:bound?.bodyWindow,childBody:bound?.body,childUrl:bound?.binding?.bodyUrl};
    return root;
  }
  function detailToken(root,companions=[]){
    const previous=detailTokens.get(root);
    if(previous&&previous.companions.length===companions.length&&previous.companions.every((node,i)=>node===companions[i]))return previous.token;
    const token=detailTokenPrefix+'-'+(++detailTokenSequence);
    detailTokens.set(root,{token,companions});return token;
  }
  function domHeaderIdentity(detail,idx){
    for(const entry of inside(detail.root,idx.names).filter(item=>item.name===detail.name)){
      for(let root=D.parent(entry.el);root&&D.contains(detail.root,root);root=D.parent(root)){
        const value=normalize(idx.texts.get(root)||''),nameAt=value.indexOf(normalize(detail.name)),ageAt=value.search(/\d{1,2}岁/);
        if(nameAt<0||ageAt<nameAt||ageAt-nameAt>90)continue;
        const meta=value.slice(ageAt,ageAt+90).split(new RegExp(headings.join('|')))[0];
        if(!profileMetadata(meta))continue;
        const age=meta.match(/\d{1,2}岁/)?.[0],experience=meta.match(/\d{1,2}年(?:以上|以下)?|应届/)?.[0];
        const education=meta.match(/本科|硕士|博士|大专|高中|中专/)?.[0];
        const status=meta.match(/在职[-·—]?(?:暂不考虑|考虑机会|月内到岗)|离职[-·—]?随时到岗|在职|离职|应届(?:生)?|求职中?/)?.[0];
        if(age&&experience&&education&&status)return JSON.stringify([detail.name,age,experience,education,status]);
      }
    }
    return '';
  }
  function documentUrl(doc){
    const value=doc===document?(location.href||key()):doc.location?.href||doc.defaultView?.location?.href;
    if(!value||!bossOrigin(value))throw Error('当前简历所属页面无法确认');
    return new URL(value).href;
  }
  // Extension IPC may reorder object keys; identity depends on the exact URL
  // values, not their property insertion order.
  const sameResumeBinding=(left,right)=>left==null?right==null:Boolean(right&&
    left.ownerUrl===right.ownerUrl&&left.bodyUrl===right.bodyUrl);
  function currentResumeBinding(frame){
    if(!frame?.isConnected||!visible(frame))throw Error('当前在线简历已关闭或隐藏');
    const doc=frame.ownerDocument,ownerUrl=documentUrl(doc);
    const frames=D.query(doc.body,'iframe,frame').filter(item=>canvasPath(item.getAttribute('src')));
    if(frames.length!==1||frames[0]!==frame)throw Error('当前简历的正文框架不唯一');
    if(detailReport('',index(doc.body)).diagnostics.detailRoots)throw Error('存在多份在线简历详情，无法确认当前候选人');
    const src=new URL(frame.getAttribute('src'),ownerUrl);
    if(src.origin!==new URL(ownerUrl).origin)throw Error('当前简历的正文框架不是同源页面');
    let bodyWindow,bodyUrl;
    try{bodyWindow=frame.contentWindow;bodyUrl=new URL(bodyWindow.location.href,ownerUrl).href;}
    catch{throw Error('当前简历的正文框架尚未就绪');}
    if(!canvasPath(bodyUrl)||src.href!==bodyUrl)throw Error('当前简历的正文框架已经跳转，请重新读取');
    const body=bodyWindow.document?.body;
    if(!body)throw Error('当前简历的正文框架尚未就绪');
    const idx=index(body),report=detailReport('',idx);
    if(idx.stats.truncated)throw Error('当前简历正文超过校验范围，未生成截断的身份凭据');
    if(report.diagnostics.detailRoots>1)throw Error('存在多份在线简历详情，无法确认当前候选人');
    const canvases=D.query(body,'canvas').filter(canvas=>{
      const rect=canvas.getBoundingClientRect();return rect.width>=250&&rect.height>=150;
    });
    const root=D.closest(frame,'.dialog-lib-resume')||frame;
    const names=[...new Set(idx.names.map(item=>item.name))];
    const name=names.length===1&&domHeaderIdentity({root:body,name:names[0]},idx)?names[0]:'';
    return {root,frame,bodyWindow,body,report,canvases,name,
      headerIdentity:name?domHeaderIdentity({root:body,name},idx):'',binding:{ownerUrl,bodyUrl}};
  }
  function currentResumeFrame(){
    const frames=D.query(document.body,'iframe,frame').filter(frame=>canvasPath(frame.getAttribute('src')));
    if(frames.length>1)throw Error('当前简历的正文框架不唯一');
    if(!frames.length)return null;
    return currentResumeBinding(frames[0]);
  }
  function currentTextDetail(empty,report,idx,bound=null){
    const contentKey=clean(report.detail.root).replace(/[\s\u200B-\u200D\uFEFF]/g,'');
    if(contentKey.length>100000)throw Error('当前简历正文超过校验范围，未生成截断的身份凭据');
    const identity=domHeaderIdentity(report.detail,idx);
    rememberPreviewScope(bound?document.body:D.closest(report.detail.root,'.dialog-lib-resume,[role="dialog"],dialog,[aria-modal="true"]')||report.detail.root,report.detail.root,bound);
    const companions=bound?[identity,bound.frame,bound.binding.ownerUrl,bound.binding.bodyUrl]:[identity];
    return {...empty,kind:'text',name:report.detail.name,
      token:detailToken(report.detail.root,companions),contentKey,
      ...(bound?{binding:bound.binding}:{})};
  }
  function currentDetail(){
    previewScope=null;
    const empty={frameKey:key(),kind:'none',name:'',token:'',binding:null};
    if(!frameVisible())return empty;
    const idx=index(),report=detailReport('',idx);
    if(idx.promotions.some(item=>item.modal))throw Error('当前打开的是热搜推荐弹层，不能作为简历评估');
    if(report.diagnostics.detailRoots>1)throw Error('存在多份在线简历详情，无法确认当前候选人');
    const owner=canvasDialog(),bodyPath=canvasPath(location.href);
    if(owner&&report.detail)throw Error('存在多份在线简历详情，无法确认当前候选人');
    if(bodyPath){
      const frame=window.frameElement;
      if(!frame)throw Error('当前简历正文没有可确认的详情窗口');
      if(promotions(D.view(frame.ownerDocument.body)).some(item=>item.modal))throw Error('当前简历被热搜推荐弹层遮挡，未读取');
      const bound=currentResumeBinding(frame);
      if(bound.bodyWindow!==window||bound.binding.bodyUrl!==documentUrl(document))throw Error('当前简历的正文框架已经切换');
      if(report.detail)return currentTextDetail(empty,report,idx,bound);
      if(bound.canvases.length!==1)
        throw Error('当前简历的画布或正文框架不唯一');
      rememberPreviewScope(document.body,null,bound);
      return {...empty,kind:'canvas-body',name:bound.name,
        token:detailToken(bound.canvases[0],[bound.root,frame,bound.binding.ownerUrl,bound.binding.bodyUrl,bound.headerIdentity]),binding:bound.binding};
    }
    const bound=currentResumeFrame();
    if(owner&&!bound)throw Error('当前简历的正文框架不唯一');
    if(bound){
      if(report.detail)throw Error('存在多份在线简历详情，无法确认当前候选人');
      // A text resume is identified by its own pinned document. The embedding
      // page must not create an additional, conflicting Canvas identity.
      if(bound.report.detail)return empty;
      if(bound.canvases.length!==1)throw Error('当前简历的画布或正文框架不唯一');
      rememberPreviewScope(bound.root,null,bound);
      return {...empty,kind:'canvas-owner',name:bound.name,
        token:detailToken(bound.root,[bound.frame,bound.canvases[0],bound.binding.ownerUrl,bound.binding.bodyUrl,bound.headerIdentity]),binding:bound.binding};
    }
    if(report.detail)return currentTextDetail(empty,report,idx);
    return empty;
  }
  let canvasExpandSession=null,canvasExpandSequence=0;
  function canvasExpandScope(){
    const candidate=currentDetail();
    if(!['canvas-owner','canvas-body'].includes(candidate.kind)||!candidate.token)
      throw Error('当前画布简历的展开范围无法确认');
    const bound=candidate.kind==='canvas-body'?currentResumeBinding(window.frameElement):currentResumeFrame();
    if(!bound||bound.report.detail||bound.canvases.length!==1)
      throw Error('当前画布简历的正文框架已变化，未展开');
    return {candidate,root:candidate.kind==='canvas-body'?bound.body:bound.root,
      frame:bound.frame,body:bound.body,bodyWindow:bound.bodyWindow,canvas:bound.canvases[0]};
  }
  function canvasExpandControls(scope){
    const found=[];
    for(const leaf of expanders(scope.root)){
      const element=D.closest(leaf,'button,[role="button"],a')||leaf;
      if(element.ownerDocument!==document||!D.contains(scope.root,element)||!visible(element))continue;
      const label=normalize(text(element));
      if(!isFold(label)&&label!=='展开')continue;
      if(found.some(item=>item.element===element))continue;
      let safe=true;
      for(let parent=element;parent&&D.contains(scope.root,parent);parent=D.parent(parent)){
        if(parent.disabled||parent.hasAttribute('disabled')||parent.getAttribute('aria-disabled')==='true'||
            /\bdisabled\b/i.test(String(parent.className||''))||getComputedStyle(parent).pointerEvents==='none'||
            ['aria-label','title'].some(name=>blockedActions.test(normalize(parent.getAttribute(name)||''))))safe=false;
      }
      const link=D.closest(element,'a[href]');
      if(link&&!['#','javascript:;','javascript:void(0)'].includes(link.getAttribute('href')))safe=false;
      const rect=element.getBoundingClientRect(),x=(rect.left+rect.right)/2,y=(rect.top+rect.bottom)/2;
      if(!safe||![rect.width,rect.height,x,y].every(Number.isFinite)||rect.width<=0||rect.height<=0||
          x<0||y<0||x>=innerWidth||y>=innerHeight||typeof document.elementFromPoint!=='function')continue;
      try{if(!canPoint(element))continue;}catch{continue;}
      found.push({element,label});
    }
    return found;
  }
  function prepareCanvasExpand(){
    canvasExpandSession=null;
    const scope=canvasExpandScope(),controls=canvasExpandControls(scope);
    if(controls.length!==1)return {count:controls.length,token:'',label:''};
    const token=detailTokenPrefix+'-expand-'+(++canvasExpandSequence);
    canvasExpandSession={...scope,...controls[0],token};
    return {count:1,token,label:controls[0].label};
  }
  function clickCanvasExpand(token){
    const saved=canvasExpandSession;
    if(!saved||!token||saved.token!==token)throw Error('展开凭据已失效，请重新检查当前简历');
    canvasExpandSession=null;
    const scope=canvasExpandScope();
    if(scope.root!==saved.root||scope.frame!==saved.frame||scope.body!==saved.body||
        scope.bodyWindow!==saved.bodyWindow||scope.canvas!==saved.canvas||
        scope.candidate.token!==saved.candidate.token||scope.candidate.kind!==saved.candidate.kind||
        JSON.stringify(scope.candidate.binding)!==JSON.stringify(saved.candidate.binding))
      throw Error('当前简历或正文框架已变化，未点击展开');
    const controls=canvasExpandControls(scope);
    if(controls.length!==1||controls[0].element!==saved.element||controls[0].label!==saved.label)
      return {clicked:false,reason:'controls_changed'};
    guard();saved.element.click();
    return {clicked:true,label:saved.label};
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
    for(let area=root;area&&area!==root.ownerDocument.body;area=D.parent(area)){
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
  const closedCurrentTokens=new Set();
  function closeControlPointable(element,ownerWindow){
    if(!visible(element))return false;
    for(let parent=element;parent;parent=D.parent(parent)){
      if(parent.disabled||parent.hasAttribute('disabled')||parent.getAttribute('aria-disabled')==='true'||
          /\bdisabled\b/i.test(String(parent.className||''))||getComputedStyle(parent).pointerEvents==='none')return false;
    }
    const r=element.getBoundingClientRect();let x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,anchor=element;
    try{
      for(let child=ownerWindow,depth=0;depth<10;depth++){
        const doc=child===window?document:child.document,width=child===window?innerWidth:child.innerWidth,
          height=child===window?innerHeight:child.innerHeight;
        if(![x,y,width,height].every(Number.isFinite)||x<0||y<0||x>=width||y>=height||
            typeof doc.elementFromPoint!=='function'||!D.contains(anchor,doc.elementFromPoint(x,y)))return false;
        if(!child.parent||child.parent===child||child===child.top)return true;
        const frame=child.frameElement;
        if(!frame?.isConnected||!visible(frame)||frame.ownerDocument!==child.parent.document)return false;
        const bounds=frame.getBoundingClientRect();
        x+=bounds.left+frame.clientLeft;y+=bounds.top+frame.clientTop;anchor=frame;child=child.parent;
      }
    }catch{return false;}
    return false;
  }
  function closeCurrent(args){
    if(!['canvas-owner','text'].includes(args.kind)||typeof args.token!=='string'||!args.token||
        closedCurrentTokens.has(args.token))throw Error('当前详情关闭凭据已失效，请重新检查页面');
    const matches=value=>value.kind===args.kind&&value.token===args.token&&value.name===(args.name||'')&&
      sameResumeBinding(value.binding,args.binding);
    const readScope=()=>{
      if(!matches(currentDetail()))throw Error('当前在线简历已切换，未关闭详情');
      if(args.kind==='canvas-owner')return {...canvasExpandScope(),doc:document,win:window,content:document.body};
      const selected=detail(args.name);
      if(!selected)throw Error('当前在线简历正文已切换，未关闭详情');
      if(args.binding){
        const frame=window.frameElement,bound=currentResumeBinding(frame),parent=window.parent;
        if(!canvasPath(location.href)||!parent||parent===window||frame!==bound.frame||
            bound.bodyWindow!==window||bound.bodyWindow.document!==document||bound.body!==document.body||
            parent.document!==frame.ownerDocument||bound.report.detail?.root!==selected.root||
            !sameResumeBinding(bound.binding,args.binding))
          throw Error('当前在线简历的父级框架已切换，未关闭详情');
        return {root:bound.root,doc:frame.ownerDocument,win:parent,frame,body:bound.body,content:selected.root};
      }
      return {root:D.closest(selected.root,'.dialog-lib-resume,[role="dialog"],dialog,[aria-modal="true"]'),
        doc:document,win:window,frame:null,body:document.body,content:selected.root};
    };
    const scope=readScope(),{root,doc,win}=scope;
    if(!root||root.ownerDocument!==doc||!root.matches('.dialog-lib-resume,[role="dialog"],dialog,[aria-modal="true"]'))
      throw Error('当前简历没有可安全关闭的详情窗口，请手动关闭后继续');
    if(D.query(doc.body,'.dialog-lib-resume,[role="dialog"],dialog[open],[aria-modal="true"]').some(
        other=>other!==root&&!D.contains(root,other)&&!D.contains(other,root))||
        D.query(root,'iframe,frame').some(frame=>!canvasPath(frame.getAttribute('src')))||D.query(root,'embed,object').length||
        doc!==document&&(D.query(document.body,'iframe,frame,embed,object').length||
          D.query(document.body,'[role="dialog"],dialog[open],[aria-modal="true"]').some(other=>!D.contains(other,scope.content))))
      throw Error('当前存在其它弹层或附件窗口，未自动关闭');
    const control=closingControl(root);
    if(!control||!closeControlPointable(control,win))
      throw Error('当前详情关闭按钮不可见、被遮挡或不唯一，请手动关闭');
    const link=D.closest(control,'a[href]');
    if(link&&!['#','javascript:;','javascript:void(0)'].includes(link.getAttribute('href')))
      throw Error('关闭入口包含跳转链接，未点击');
    guard();
    const fresh=readScope();
    if(['root','doc','win','frame','body','content'].some(field=>scope[field]!==fresh[field])||
        !root.isConnected||!visible(root)||closingControl(root)!==control||!closeControlPointable(control,win))
      throw Error('当前在线简历或关闭按钮已变化，未关闭');
    closedCurrentTokens.add(args.token);
    canvasExpandSession=null;favoriteSession=null;colleagueSession=null;shareSession=null;
    control.click();
    return {closed:true};
  }
  let dismissedImagePreviews=new WeakSet();
  function imagePreviewContainer(element){
    if(element.matches('button,a,img,picture,video,audio,[role="button"]'))return false;
    const value=['class','id','aria-label','title','data-role'].map(name=>element.getAttribute(name)||'').join(' ')
      .replace(/([a-z])([A-Z])/g,'$1-$2').toLowerCase();
    // Explicit preview semantics only: a generic popover, avatar or dialog is
    // not sufficient evidence that closing it leaves the resume open.
    if(/(?:^|[\s_-])(?:trigger|opener|thumbnail)(?:$|[\s_-])/.test(value))return false;
    return /(?:^|[\s_-])(?:avatar|portrait|photo|image|img)[\s_-]+(?:preview|viewer|popover)(?:$|[\s_-])/.test(value)||
      /(?:^|[\s_-])(?:preview|viewer|popover)[\s_-]+(?:avatar|portrait|photo|image|img)(?:$|[\s_-])/.test(value)||
      /(?:头像|照片|图片|相片)(?:预览|大图)|(?:预览|查看)(?:头像|照片|图片|相片)(?:大图)?/.test(value);
  }
  function previewProbeRoot(){
    if(previewScope){
      const saved=previewScope;
      if(saved.body!==document.body||saved.url!==location.href||saved.frame!==(window.frameElement||null)||
          !saved.root.isConnected||saved.root.ownerDocument!==document||
          saved.frame&&(!saved.frame.isConnected||saved.frame.getAttribute('src')!==saved.frameSrc)||
          saved.content&&(!saved.content.isConnected||!D.contains(saved.root,saved.content)))return null;
      try{if(saved.childFrame&&(!saved.childFrame.isConnected||saved.childFrame.contentWindow!==saved.childWindow||
          saved.childFrame.getAttribute('src')!==saved.childSrc||
          saved.childWindow.document.body!==saved.childBody||saved.childWindow.location.href!==saved.childUrl))return null;}catch{return null;}
      return visible(saved.root)?saved.root:null;
    }
    if(canvasPath(location.href)){
      const frame=window.frameElement;
      try{if(frame?.isConnected&&frame.contentWindow===window&&canvasPath(frame.getAttribute('src')))
        return document.body;}catch{}
      return null;
    }
    // Native selector lookup finds the small foreground scope without reading
    // or visiting each background recommendation card in JavaScript.
    const matches=document.querySelectorAll('.dialog-lib-resume');
    if(matches.length>32)return null;
    const roots=[...matches].filter(element=>visible(element));
    const outer=roots.filter(element=>!roots.some(parent=>parent!==element&&D.contains(parent,element)));
    if(outer.length!==1)return null;
    const root=outer[0],frames=root.querySelectorAll('iframe,frame');
    if(frames.length!==1||!canvasPath(frames[0].getAttribute('src'))||!visible(frames[0]))return null;
    try{if(!frames[0].contentWindow||!canvasPath(frames[0].contentWindow.location.href))return null;}catch{return null;}
    return root;
  }
  function scanImagePreviews(root){
    const pending=root?[root]:[],seen=new Set(),found=[],started=Date.now();
    const textScope=previewScope?.root===root&&!!previewScope.content,limit=textScope?20000:4096,timeout=textScope?100:80;
    let visited=0;
    while(pending.length){
      const element=pending.pop();
      if(seen.has(element))continue;seen.add(element);
      if(++visited>limit||(visited%64===0&&Date.now()-started>timeout))
        return {previews:[],uncertain:true};
      if(element.hidden||element.getAttribute('aria-hidden')==='true')continue;
      if(element!==root&&imagePreviewContainer(element)&&visible(element))found.push(element);
      const assigned=element.tagName==='SLOT'?element.assignedElements?.({flatten:true}):null;
      const children=assigned?.length?assigned:(D.shadow(element)||element).children;
      if(children){
        if(visited+pending.length+children.length>limit)return {previews:[],uncertain:true};
        for(let i=children.length-1;i>=0;i--)pending.push(children[i]);
      }
    }
    const candidates=new Set(found);
    return {previews:found.filter(element=>{
      for(let parent=D.parent(element);parent&&parent!==root;parent=D.parent(parent))
        if(candidates.has(parent))return false;
      return true;
    }),uncertain:false};
  }
  function probeImagePreview(){
    const root=previewProbeRoot();
    if(!root)return {present:false,uncertain:true,reason:'scope'};
    const result=scanImagePreviews(root);
    return result.uncertain?{present:false,uncertain:true,reason:'budget'}:{present:!!result.previews.length};
  }
  function imagePreviews(scope){
    const result=scanImagePreviews(scope.root);
    if(result.uncertain)throw Error('当前预览范围尚未完成安全校验，未自动关闭');
    return result.previews;
  }
  function imagePreviewParts(scope,preview){
    if([scope.frame,scope.canvas,scope.content].some(node=>node&&D.contains(preview,node)))
      throw Error('图片预览范围包含简历正文，未自动关闭');
    const elements=D.elements(preview),views=[preview,...elements.map(element=>D.shadow(element)).filter(Boolean)];
    const forbidden='iframe,frame,embed,object,video,audio,form,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="alertdialog"]';
    const risk=/附件|发送|转发|确认|验证码|验证|安全检查|沟通|打招呼|下载|attachment|captcha|confirm|send|message|chat/i;
    if(preview.matches(forbidden)||views.some(root=>[...root.querySelectorAll(forbidden)].some(visible))||
        elements.some(element=>risk.test(['class','id','aria-label','title','data-role'].map(name=>element.getAttribute(name)||'').join(' ')))||
        risk.test(text(preview)))throw Error('当前图片弹层含附件、对话或确认操作，未自动关闭');
    const images=D.query(preview,'img'),control=closingControl(preview);
    if(images.length!==1||!control)throw Error('图片预览的图片或关闭按钮不唯一，未自动关闭');
    const image=images[0],rect=image.getBoundingClientRect();
    if(![rect.width,rect.height].every(Number.isFinite)||rect.width<64||rect.height<64)
      throw Error('无法确认图片预览内容，未自动关闭');
    // A second actionable control makes this an unknown dialog, even if it
    // also contains an image and an apparently harmless close icon.
    if(D.query(preview,'button,a,[role="button"]').some(element=>element!==control&&
        !D.contains(control,element)&&!D.contains(element,control)))
      throw Error('图片预览包含其它操作，未自动关闭');
    const link=D.closest(control,'a[href]');
    if(link&&!['#','javascript:;','javascript:void(0)'].includes(link.getAttribute('href')))
      throw Error('图片预览关闭入口包含跳转链接，未点击');
    if(!closeControlPointable(control,window))throw Error('图片预览关闭按钮被遮挡或不可点击，请手动关闭');
    return {image,control};
  }
  function assertPreviewOverlays(scope,preview=null){
    const overlays=D.query(document.body,'[role="dialog"],dialog[open],[aria-modal="true"],[role="alertdialog"]');
    if(overlays.some(other=>other!==scope.root&&!D.contains(other,scope.root)&&
        (!preview||(other!==preview&&!D.contains(preview,other)&&!D.contains(other,preview)))))
      throw Error('当前存在其它弹层，未自动关闭图片预览');
  }
  async function dismissImagePreview(args){
    // Most calls are preventive probes. Without a recognizable preview there
    // is no action to authorize, so a stale optional recovery token must not
    // interrupt the separate resume-reading guards.
    const probe=probeImagePreview();
    if(probe.uncertain){
      if(probe.reason==='scope'&&previewScope&&args.token)throw Error('当前在线简历的绑定范围已切换，未关闭图片预览');
      return {dismissed:false,uncertain:true,reason:probe.reason};
    }
    if(!probe.present)return {dismissed:false};
    guard();
    if(!['canvas-owner','canvas-body','text'].includes(args.kind)||typeof args.token!=='string'||!args.token)
      throw Error('图片预览关闭凭据无效，请重新读取当前简历');
    const readScope=()=>{
      const candidate=currentDetail();
      if(candidate.kind!==args.kind||candidate.token!==args.token||candidate.name!==(args.name||'')||
          !sameResumeBinding(candidate.binding,args.binding))
        throw Error('当前在线简历已切换，未关闭图片预览');
      if(args.kind!=='text')return {...canvasExpandScope(),doc:document,win:window,content:null};
      const selected=detail(args.name);
      if(!selected)throw Error('当前简历正文已切换，未关闭图片预览');
      const bound=args.binding?currentResumeBinding(window.frameElement):null;
      if(bound&&(bound.bodyWindow!==window||bound.body!==document.body||bound.report.detail?.root!==selected.root))
        throw Error('当前简历正文框架已切换，未关闭图片预览');
      return {candidate,root:bound?document.body:D.closest(selected.root,'.dialog-lib-resume,[role="dialog"],dialog,[aria-modal="true"]')||selected.root,
        doc:document,win:window,frame:bound?.frame||null,body:document.body,bodyWindow:bound?.bodyWindow||window,content:selected.root};
    };
    const scope=readScope(),previews=imagePreviews(scope);
    if(!previews.length)return {dismissed:false};
    if(previews.length!==1)throw Error('存在多个图片预览，未自动关闭');
    const preview=previews[0];assertPreviewOverlays(scope,preview);
    if(dismissedImagePreviews.has(preview))throw Error('此图片预览已尝试关闭，请手动处理后重试');
    const parts=imagePreviewParts(scope,preview);
    const sameScope=fresh=>['root','doc','win','frame','body','bodyWindow','canvas','content'].every(field=>scope[field]===fresh[field]);
    guard();const fresh=readScope(),freshPreviews=imagePreviews(fresh);
    if(!sameScope(fresh)||freshPreviews.length!==1||freshPreviews[0]!==preview)
      throw Error('当前简历或图片预览已变化，未关闭');
    assertPreviewOverlays(fresh,preview);
    const checked=imagePreviewParts(fresh,preview);
    if(checked.image!==parts.image||checked.control!==parts.control||!sameScope(readScope()))
      throw Error('当前简历或图片关闭按钮已变化，未关闭');
    dismissedImagePreviews.add(preview);parts.control.click();
    // Only observe after the single click. Never retry the close, press ESC,
    // or choose a replacement control while waiting for an animation.
    for(let attempt=0;attempt<10;attempt++){
      guard();const after=readScope();
      if(!sameScope(after))throw Error('关闭图片预览时简历已变化，请重新读取');
      const remaining=imagePreviews(after);
      if(!remaining.length){assertPreviewOverlays(after);return {dismissed:true};}
      if(remaining.length!==1||remaining[0]!==preview)throw Error('图片预览已变化，请手动关闭后重试');
      if(attempt<9)await delay(100);
    }
    throw Error('图片预览尚未关闭，请手动关闭后重试');
  }
  async function read(expected,strict=false,maxExpandClicks=Infinity){
    guard();const d=detail(expected);if(!d)throw Error('未识别到唯一的在线简历详情；不会把列表摘要当作完整简历');
    current=d;
    const scroll=scrollRoot(d.root), original=scroll.scrollTop, chunks=[], attempted=new WeakSet();
    let stable=0,last='',complete=false,expandClicks=0,ambiguousExpansion=false;
    scroll.scrollTop=0;
    try{
      for(let round=0;round<45;round++){
        guard();if(!d.root.isConnected)throw Error('简历页面发生变化，未保存');
        const controls=expanders(d.root).filter(element=>!attempted.has(element));
        // Foreground reads have one expansion budget. Multiple candidates do
        // not authorize picking the first: copy once and retain the existing
        // fold/completeness checks for the resulting snapshot instead.
        if(maxExpandClicks===1&&controls.length>1)ambiguousExpansion=true;
        for(const e of ambiguousExpansion?[]:controls){
          if(attempted.has(e))continue;
          if(expandClicks>=maxExpandClicks)break;
          guard();attempted.add(e);expandClicks++;e.click();await delay(180);
        }
        await delay(400);guard();
        const t=clean(d.root);if(!chunks.includes(t))chunks.push(t);
        const bottom=scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-5;
        stable=bottom&&t===last?stable+1:0;last=t;
        if(stable>=2){complete=resumeFoldControls(d.root).length===0&&!/加载中|加载更多/.test(t);break;}
        scroll.scrollTop=Math.min(scroll.scrollTop+Math.max(160,scroll.clientHeight*.8),scroll.scrollHeight);
      }
    }finally{if(scroll.isConnected)scroll.scrollTop=original;}
    // Normal pages retain all loaded text. For virtualized content preserve each
    // snapshot explicitly, rather than pretending a fragment is the whole resume.
    const longest=[...chunks].sort((a,b)=>b.length-a.length)[0]||'';
    const virtual=chunks.some(t=>!longest.includes(t)&&(strict||!t.split('\n').every(line=>longest.includes(line))));
    const resume=virtual?chunks.map((s,i)=>`【滚动片段 ${i+1}】\n${s}`).join('\n\n'):longest;
    if(resume.length<120||resume.length>30000)throw Error('详情内容过短或超出 30000 字上限，未截断入库');
    const warnings=[];
    if(!complete)warnings.push('未确认全部展开或到达稳定底部');
    if(virtual)warnings.push('检测到动态替换内容，已保留滚动片段，请人工核对');
    if(D.view(d.root).stats.truncated)warnings.push('页面内容超出 HTML 遍历范围，请人工核对');
    if(strict){
      const stats=D.view(d.root).stats;
      if(stats.canvas||stats.iframes)warnings.push('正文含画布或内嵌内容，不能仅凭网页文字确认完整');
      if(/[\p{Co}\uFFFD]/u.test(resume))warnings.push('正文含无法确认的字形编码，请人工核对');
      if(D.query(d.root,'img').some(image=>{
        const rect=image.getBoundingClientRect();return visible(image)&&rect.width>=250&&rect.height>=150;
      }))warnings.push('正文含大幅图片，不能确认图片中的文字已读取');
    }
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
  const shareUrl=win=>win===window?(location.href||key()):win.location.href;
  function shareDocuments(){
    const scopes=[{doc:document,win:window,url:shareUrl(window),chain:[],coordinateSpace:'owner'}];
    let child=window;const chain=[],seen=new Set([window]);
    // Recommendation details live in an iframe, while BOSS mounts sharing
    // in the top page. Only follow this owner's same-origin ancestor chain.
    for(let depth=0;depth<8;depth++){
      try{
        const parent=child.parent;
        if(!parent||parent===child||seen.has(parent))break;
        const doc=parent.document,frame=child.frameElement,url=shareUrl(parent);
        if(!bossOrigin(url)||new URL(url).origin!==new URL(shareUrl(window)).origin||
            !frame||!frame.isConnected||!visible(frame)||frame.ownerDocument!==doc||frame.contentDocument!==child.document)break;
        chain.push({child,parent,frame,doc:child.document,parentDoc:doc,
          src:frame.getAttribute('src'),url:shareUrl(child),parentUrl:url});
        seen.add(parent);child=parent;
        if(parent===parent.top||parent===parent.parent){
          scopes.push({doc,win:parent,url,chain:[...chain],coordinateSpace:'top'});break;
        }
      }catch{break;}
    }
    return scopes;
  }
  function verifyShareDocument(scope){
    try{
      if(scope.doc!==scope.win.document||scope.url!==shareUrl(scope.win))throw Error('document');
      for(const link of scope.chain){
        if(!link.frame.isConnected||!visible(link.frame)||link.frame.ownerDocument!==link.parentDoc||
            link.child.parent!==link.parent||link.child.frameElement!==link.frame||
            link.child.document!==link.doc||link.parent.document!==link.parentDoc||
            link.frame.contentDocument!==link.doc||link.frame.getAttribute('src')!==link.src||
            shareUrl(link.child)!==link.url||shareUrl(link.parent)!==link.parentUrl)throw Error('frame');
      }
    }catch{throw Error('分享窗口所属页面框架已切换，未继续操作');}
  }
  const shareViewport=doc=>doc===document?{width:innerWidth,height:innerHeight}:
    {width:doc.defaultView.innerWidth,height:doc.defaultView.innerHeight};
  function shareElements(root=document){
    const elements=[...root.querySelectorAll('*')];
    const rootShadow=root.nodeType===1&&D.shadow(root);
    if(rootShadow)elements.push(...rootShadow.querySelectorAll('*'));
    const seen=new Set(elements);
    for(let index=0;index<elements.length;index++){
      const shadow=D.shadow(elements[index]);
      if(shadow)for(const child of shadow.querySelectorAll('*')){
        if(!seen.has(child)){seen.add(child);elements.push(child);}
      }
    }
    return elements;
  }
  function shareLabels(root,value,elements=shareElements(root)){
    const labelText=value=>normalize(value).replace(/[\uE000-\uF8FF]/g,'');
    const matches=valueText=>valueText===value||(value==='转发至其他'&&
      [value+'上次分享','上次分享'+value].includes(valueText));
    const found=elements.filter(element=>{
      if(element.matches('script,style,noscript,template,input,textarea,select'))return false;
      const attributes=[element.getAttribute('aria-label')||'',element.getAttribute('title')||''];
      const labelled=attributes.some(label=>labelText(label)===value);
      // Inspect only small label subtrees. Text may be split across inline
      // children; the separate "last shared" badge is not part of the action.
      const raw=labelText(element.textContent||'');
      if(!labelled&&(raw.length>160||!raw.includes(value)))return false;
      if(!visible(element))return false;
      if(labelled)return true;
      const view=D.view(element);
      return !view.stats.truncated&&matches(labelText(view.text));
    });
    return found.filter(element=>!found.some(child=>child!==element&&D.contains(element,child)));
  }
  function shareMenu(owner=null,diagnostics=null,doc=document){
    // The resume page can exceed the DOM reader's traversal limit before a
    // share portal appended near the end of <body> is reached. Discover only
    // exact share labels through the DOM, then inspect their bounded common
    // panel; do not treat a page-wide text snapshot as the popup.
    const elements=shareElements(doc),labels=value=>shareLabels(doc,value,elements),viewport=shareViewport(doc);
    const others=labels('转发至其他'),emails=labels('邮件转发'),menus=[];
    const hints=[...labels('可识别二维码查看详情'),...labels('右键复制图片发送至微信好友')];
    // A directly opened QR card may have no "转发至其他" tab. Its exact hint
    // can anchor the same bounded dialog, but only when paired with the
    // share-specific email tab; the image itself is verified separately.
    for(const anchor of [...others,...hints])for(const email of emails){
      let common=D.parent(anchor);
      while(common&&common!==doc.body&&!D.contains(common,email))common=D.parent(common);
      if(!common||common===doc.body)continue;
      // A tab strip can be narrower than the share dialog. Keep climbing to
      // the outermost bounded panel so the QR card and close button stay in
      // scope, but never expand into the resume or the page background.
      let panel=null;
      for(let root=common;root&&root!==doc.body;root=D.parent(root)){
        if(owner&&D.contains(root,owner))break;
        const rect=root.getBoundingClientRect();
        if(!visible(root)||rect.width<220||rect.height<150||
            rect.width>=viewport.width*.95||rect.height>=viewport.height*.95||
            rect.left<0||rect.top<0||rect.right>viewport.width||rect.bottom>viewport.height)continue;
        panel=root;
      }
      if(panel&&!menus.includes(panel))menus.push(panel);
    }
    if(diagnostics)Object.assign(diagnostics,{otherLabels:others.length,emailLabels:emails.length,
      qrHints:hints.length,menus:menus.length});
    return menus.length===1?menus[0]:null;
  }
  function findShareMenu(owner=null,diagnostics={}){
    const scopes=shareDocuments(),found=[];
    Object.assign(diagnostics,{otherLabels:0,emailLabels:0,qrHints:0,menus:0,documents:scopes.length});
    for(const scope of scopes){
      const report={},menu=shareMenu(owner,report,scope.doc);
      for(const field of ['otherLabels','emailLabels','qrHints','menus'])diagnostics[field]+=report[field];
      if(menu)found.push({menu,scope});
    }
    return diagnostics.menus===1&&found.length===1?found[0]:null;
  }
  function shareCards(menu){
    if(!menu)return [];
    const candidates=[],viewport=shareViewport(menu.ownerDocument);
    const hintNodes=leaves(menu).filter(e=>/可识别二维码查看详情|右键复制图片发送至微信好友/.test(text(e))&&text(e).length<90);
    // A wrapper containing both hints is not a third hint for its parent.
    const hints=hintNodes.filter(node=>!hintNodes.some(child=>child!==node&&D.contains(node,child)));
    for(const hint of hints){
      for(let root=D.parent(hint);root&&root!==menu;root=D.parent(root)){
        const imgs=D.query(root,'img,canvas').filter(e=>visible(e)&&e.getBoundingClientRect().width>=90&&e.getBoundingClientRect().height>=90);
        if(!imgs.length)continue;
        const r=root.getBoundingClientRect();
        if(r.width>100&&r.height>100&&r.width<viewport.width*.95&&r.height<viewport.height*.95&&r.x>=0&&r.y>=0&&r.right<=viewport.width&&r.bottom<=viewport.height){
          if(!candidates.some(candidate=>candidate.root===root))candidates.push({root,rect:r,images:imgs});
        }
        break;
      }
    }
    // The two platform hints may sit in different wrappers of the same
    // share card. Only collapse nested wrappers when both identify the
    // exact same unique DOM image; matching URLs or dimensions is not proof.
    const cards=candidates.filter(candidate=>!candidates.some(other=>other!==candidate&&
      candidate.images.length===1&&other.images.length===1&&candidate.images[0]===other.images[0]&&
      D.contains(other.root,candidate.root)));
    if(cards.length>1)throw Error('分享二维码卡片不唯一，未读取图片');
    return cards;
  }
  function shareOther(menu){
    // The tab can contain an icon or nested text wrappers, so a visible text
    // leaf is not always the clickable element. Bind it to the share menu and
    // require one actual control before clicking.
    const labels=shareLabels(menu,'转发至其他');
    const choices=[];
    for(const label of labels){
      // The saved BOSS stylesheet defines the share tabs as clickable .item
      // divs, with .item-label and .icon-shared siblings inside .item-content.
      const button=D.closest(label,'.c-share-box .left-list .nav-list .item')||
        D.closest(label,'button,[role="button"],[role="tab"],a[href],li')||label;
      if(D.contains(menu,button)&&!choices.some(choice=>choice.button===button))choices.push({button});
    }
    if(choices.length!==1)throw Error('没有唯一的“转发至其他”入口，已停止该操作');
    const button=choices[0].button,link=D.closest(button,'a[href]');
    if(link&&link.getAttribute('href')&&!['#','javascript:;','javascript:void(0)'].includes(link.getAttribute('href')))
      throw Error('操作入口包含跳转链接，未自动点击');
    button.click();
  }
  async function share(expected,kind){
    shareSession=null;
    guard();const owner=detailShell(expected,kind);
    control(owner,'转发');
    // Some BOSS layouts open directly on the QR card. In that case there is
    // nothing to select and a missing or duplicated tab label is irrelevant.
    let found=null;const diagnostics={};
    for(let n=0;n<12;n++){
      await delay(250);guard();
      if(!owner.isConnected||detailShell(expected,kind)!==owner)throw Error('简历详情已变化，未读取分享图片');
      found=findShareMenu(owner,diagnostics);
      if(found)break;
    }
    if(!found){
      const reason=!diagnostics.otherLabels&&!diagnostics.qrHints?'未找到“转发至其他”文字':
        !diagnostics.emailLabels?'未找到“邮件转发”文字':
        diagnostics.menus>1?'检测到多个分享窗口':'菜单文字已找到，但弹窗边界未确认';
      throw Error(`未识别到唯一的分享窗口，未读取图片（0.5.98；${reason}；其他入口 ${diagnostics.otherLabels||0}，邮件入口 ${diagnostics.emailLabels||0}，窗口 ${diagnostics.menus||0}；已检查 ${diagnostics.documents} 个页面）`);
    }
    const {menu,scope}=found;
    const frames=D.query(owner,'iframe').map(element=>({element,src:element.getAttribute('src'),document:element.contentDocument}));
    shareSession={root:null,menu,scope,owner,expected,kind,frames,url:location.href||key()};
    verifyShareSession(false);
    if(!shareCards(menu).length)shareOther(menu);
    for(let n=0;n<12;n++){
      await delay(300);guard();
      verifyShareSession(false);
      const cards=shareCards(menu);
      if(cards.length===1){
        shareSession.root=cards[0].root;
        return shareLayout();
      }
    }
    throw Error('未识别到完整可见的分享二维码卡片；简历可以保存，图片需补充');
  }
  function verifyShareSession(requireCard=true){
    const session=shareSession;
    if(!session||!session.menu.isConnected||!visible(session.menu)||session.menu.ownerDocument!==session.scope.doc||
        (requireCard&&(!session.root?.isConnected||!visible(session.root)||!D.contains(session.menu,session.root)))||!session.owner.isConnected||
        session.url!==(location.href||key())||detailShell(session.expected,session.kind)!==session.owner){
      shareSession=null;throw Error('分享卡片已关闭或简历已切换，未读取图片');
    }
    verifyShareDocument(session.scope);
    const frames=D.query(session.owner,'iframe');
    if(frames.length!==session.frames.length||session.frames.some((frame,index)=>frame.element!==frames[index]||
        frame.src!==frame.element.getAttribute('src')||frame.document!==frame.element.contentDocument)){
      shareSession=null;throw Error('简历页面框架已切换，未读取分享图片');
    }
    return session;
  }
  function shareLayout(){
    guard();const session=verifyShareSession(),cards=shareCards(session.menu);
    if(cards.length!==1||cards[0].root!==session.root)throw Error('分享二维码卡片已变化，未读取图片');
    const r=session.root.getBoundingClientRect(),url=new URL(session.scope.url);
    return {coordinateSpace:session.scope.coordinateSpace,frameKey:url.origin+url.pathname,
      rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:shareViewport(session.scope.doc),name:session.expected};
  }
  function shareImage(){
    guard();const session=verifyShareSession();
    const images=D.query(session.root,'img,canvas').filter(element=>visible(element)&&
      element.getBoundingClientRect().width>=90&&element.getBoundingClientRect().height>=90);
    if(images.length!==1)throw Error('分享卡片没有唯一可读取的图片，请取消回访二维码或使用前台复制模式');
    const source=images[0],isImage=source.tagName==='IMG';
    const width=isImage?source.naturalWidth:source.width,height=isImage?source.naturalHeight:source.height;
    if((isImage&&!source.complete)||!Number.isInteger(width)||!Number.isInteger(height)||width<90||height<90){
      throw Error('分享图片尚未完整加载，请稍后重试');
    }
    if(width>8192||height>8192||width*height>12000000)throw Error('分享图片尺寸超出限制，未读取');
    try{
      let canvas=source;
      if(isImage){
        canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        const ctx=canvas.getContext('2d');if(!ctx)throw Error('浏览器无法读取分享图片');
        ctx.drawImage(source,0,0);
      }
      const image=canvas.toDataURL('image/png');
      if(!image.startsWith('data:image/png;base64,')||image.length<=22)throw Error('分享图片没有有效内容');
      if(image.length>2800000)throw Error('分享图片超出大小限制');
      return {image};
    }catch(error){
      if(error.name==='SecurityError')throw Error('平台限制直接读取分享图片，请取消回访二维码或使用前台复制模式');
      throw error;
    }
  }
  function favoriteControl(owner,body){
    const stateOf=element=>{
      const labels=[text(element).trim(),element.getAttribute('aria-label'),element.getAttribute('title')]
        .filter(Boolean).map(value=>value.normalize('NFKC').replace(/[\s\uE000-\uF8FF☆★]/g,''));
      const favorite=labels.some(value=>value==='收藏');
      const saved=labels.some(value=>['已收藏','取消收藏'].includes(value));
      if(!favorite&&!saved)return null;
      // Labels alone never authorize a contact or mixed action button.
      if(labels.some(value=>value&&!['收藏','已收藏','取消收藏'].includes(value)))return null;
      if(favorite&&saved)return null;
      const pressed=element.getAttribute('aria-pressed');
      return saved||pressed==='true'?'saved':'available';
    };
    const found=[];
    for(const element of D.elements(owner)){
      if(element===owner||D.contains(body,element)||!visible(element))continue;
      const state=stateOf(element);if(!state)continue;
      const button=D.closest(element,'button,a,[role="button"]')||element;
      if(!D.contains(owner,button)||D.contains(body,button))continue;
      const buttonState=stateOf(button);if(!buttonState)continue;
      if(!found.some(item=>item.element===button))found.push({element:button,state:buttonState});
    }
    // Prefer the exact leaf of a div control so the click bubbles through its
    // actual handler. Native/ARIA buttons were already collapsed above.
    const outer=found.filter(item=>!found.some(other=>other!==item&&
      other.state===item.state&&D.contains(item.element,other.element)));
    if(outer.length!==1)throw Error('没有唯一的收藏入口，请在 BOSS 检查当前简历后重试');
    const result=outer[0],button=result.element;
    if(result.state==='available'&&!usablePager(button))throw Error('收藏入口不可操作或被遮挡，未点击收藏');
    const anchor=D.closest(button,'a[href]'),href=anchor?.getAttribute('href');
    if(href&&!['#','javascript:;','javascript:void(0)'].includes(href))throw Error('收藏入口包含跳转链接，未点击收藏');
    return result;
  }
  function favoriteCanvas(frame){
    try{
      const doc=frame.contentDocument;
      if(!doc)throw Error('frame');
      const canvases=D.query(doc.body,'canvas').filter(visible);
      if(canvases.length!==1)throw Error('count');
      return {canvas:canvases[0]};
    }catch{throw Error('无法确认唯一的简历正文框架，请检查 BOSS 当前简历后重试');}
  }
  function favoriteScope(name,kind){
    if(!['text','canvas'].includes(kind)||typeof name!=='string'||
        !(displayName(name,true)===normalize(name)||latinName(name)===normalize(name)))throw Error('收藏缺少已确认的候选人身份');
    const owner=detailShell(name,kind);
    if(!owner||owner===document.body||!owner.isConnected||!visible(owner)||!frameVisible())throw Error('收藏的简历范围不明确');
    const d=kind==='text'?detail(name):null;
    const headerIdentity=d?domHeaderIdentity(d,index()):'';
    if(d&&!headerIdentity)throw Error('收藏前未确认候选人页首身份');
    const frames=D.query(owner,'iframe');
    const body=kind==='canvas'?D.query(owner,'.resume-detail-wrap'):[];
    if(kind==='canvas'&&(frames.length!==1||body.length!==1||!D.contains(body[0],frames[0])||
        !canvasPath(frames[0].getAttribute('src'))))throw Error('收藏的简历页面框架不唯一');
    const paint=kind==='canvas'?favoriteCanvas(frames[0]):null;
    return {owner,body:d?.root||frames[0],headerIdentity,paint,
      frames:frames.map(element=>({element,src:element.getAttribute('src'),document:element.contentDocument})),
      url:location.href||key(),name:normalize(name),kind};
  }
  function sameFavoriteScope(session){
    const scope=favoriteScope(session.name,session.kind);
    if(scope.headerIdentity!==session.headerIdentity)
      throw Error('候选人姓名或基本资料已变化，未继续收藏');
    if(scope.owner!==session.owner||scope.body!==session.body||scope.url!==session.url||
        scope.paint?.canvas!==session.paint?.canvas||
        scope.frames.length!==session.frames.length||scope.frames.some((frame,index)=>
          frame.element!==session.frames[index].element||frame.src!==session.frames[index].src||
          frame.document!==session.frames[index].document))throw Error('候选人详情窗口或页面框架已变化，未继续收藏');
    return scope;
  }
  function prepareFavorite(args){
    guard();favoriteSession=null;
    const scope=favoriteScope(args.name,args.kind);
    const token=String(++favoriteSequence);
    favoriteSession={...scope,token,clicked:false};
    return {token};
  }
  function verifyFavorite(args){
    const session=favoriteSession;
    if(!session||session.token!==args.token||session.name!==normalize(args.name||'')||session.kind!==args.kind)
      throw Error('收藏会话已失效，请重新读取当前简历');
    if(session.clicked)throw Error('收藏操作已执行，不能重新核对后再次点击');
    guard();sameFavoriteScope(session);
    return {verified:true};
  }
  async function favorite(args){
    const session=favoriteSession;
    if(!session||session.token!==args.token||session.name!==normalize(args.name||'')||session.kind!==args.kind)
      throw Error('收藏会话已失效，请重新读取当前简历');
    guard();sameFavoriteScope(session);
    let control=favoriteControl(session.owner,session.body);
    if(control.state==='saved')return {favorited:true,already:true};
    if(session.clicked)throw Error('收藏结果尚未确认，未重复点击；请检查 BOSS 收藏状态');
    // Consume the single click before invoking the page handler. A retry never
    // toggles an uncertain previous click back to the unfavorited state.
    guard();sameFavoriteScope(session);session.clicked=true;control.element.click();
    for(let attempt=0;attempt<12;attempt++){
      await delay(200);guard();
      if(favoriteSession!==session)throw Error('收藏会话已结束，未继续操作');
      sameFavoriteScope(session);control=favoriteControl(session.owner,session.body);
      if(control.state==='saved')return {favorited:true,already:false};
    }
    throw Error('已点击收藏但页面未确认成功，请检查 BOSS 收藏状态后重试');
  }
  function verifyColleagueSession(token){
    const session=colleagueSession;
    if(!session||session.token!==token||!session.menu.isConnected||!visible(session.menu)||
        !session.owner.isConnected||detailShell(session.expected,session.kind)!==session.owner)
      throw Error('站内转发窗口或候选人已变化，未继续操作');
    verifyShareDocument(session.scope);
    verifyColleagueCandidate(session);
    const recipient=recentColleague(session.menu,session.recipient);
    if(recipient.label!==session.recipientLabel||recipient.root!==session.recipientRoot||
        colleagueSelectionState(recipient)!==session.recipientState)
      throw Error(`站内转发收件人“${session.recipient}”已变化，未发送履历`);
    return session;
  }
  function colleagueRecipient(value){
    if(typeof value!=='string'||/[\u0000-\u001f\u007f-\u009f]/.test(value))throw Error('站内同事显示名称不能包含控制字符');
    const recipient=value.trim();
    if(!recipient||[...recipient].length>40)throw Error('站内同事显示名称须为 1 至 40 个字符');
    return recipient;
  }
  function recentColleague(menu,recipient){
    // Recipient names preserve their displayed spaces and characters. The
    // action-label matcher intentionally normalizes those and cannot be reused.
    const names=shareElements(menu).filter(element=>{
      if(element.matches('script,style,noscript,template,input,textarea,select')||!visible(element)||
          (element.textContent||'').trim().length>160)return false;
      const view=D.view(element);
      return !view.stats.truncated&&view.text.trim()===recipient;
    });
    const labels=names.filter(element=>!names.some(child=>child!==element&&D.contains(element,child)));
    const recent=[];
    for(const label of labels){
      for(let root=D.parent(label);root&&root!==menu;root=D.parent(root)){
        if(shareElements(root).some(element=>element.matches('textarea,select,input:not([type="checkbox"]):not([type="radio"])')))break;
        const heading=D.elements(root).some(element=>D.ownText(element).trim().replace(/[:：]$/,'')==='最近联系');
        if(heading){recent.push({label,root});break;}
      }
    }
    if(recent.length===1)return recent[0];
    throw Error(`最近联系中没有唯一的“${recipient}”，未发送履历`);
  }
  function colleagueSelectionState({label,root}){
    const state=[];
    for(let element=label;element;element=D.parent(element)){
      state.push(['data-selected','aria-selected','aria-checked','aria-pressed'].map(name=>element.getAttribute(name)));
      state.push(['selected','checked','active'].map(name=>element.classList.contains(name)));
      if(element===root)break;
    }
    return JSON.stringify(state);
  }
  function verifyColleagueCandidate(session,checkContent=true){
    const fresh=currentDetail(),before=session.candidate;
    if(fresh.kind!==before.kind||fresh.token!==before.token||fresh.name!==before.name||
        JSON.stringify(fresh.binding)!==JSON.stringify(before.binding)||
        checkContent&&fresh.kind==='text'&&fresh.contentKey!==before.contentKey)
      throw Error('站内转发的候选人简历已变化，未继续操作；请人工核对');
  }
  function colleagueSendControl(menu,message){
    // The BOSS action can be a clickable div containing a span. Keep the
    // search inside the recipient pane so the dialog title and page toolbar
    // cannot be mistaken for the send action.
    for(let pane=D.parent(message);pane&&pane!==menu;pane=D.parent(pane)){
      const labels=shareLabels(pane,'转发');
      if(!labels.length)continue;
      if(labels.length!==1)return null;
      const label=labels[0];
      let control=D.closest(label,'button,[role="button"],.btn,.button')||label;
      if(!D.contains(pane,control))control=label;
      for(let node=control;node&&node!==pane;node=D.parent(node)){
        if(node.disabled||node.getAttribute?.('aria-disabled')==='true'||
            node.classList?.contains('disabled'))return null;
      }
      return visible(control)?control:null;
    }
    return null;
  }
  async function prepareColleague(expected,kind,requestedRecipient='蔡女士'){
    colleagueSession=null;guard();
    const recipient=colleagueRecipient(requestedRecipient);
    const owner=detailShell(expected,kind);
    control(owner,'转发');
    let found=null;
    for(let n=0;n<12;n++){
      await delay(250);guard();
      if(!owner.isConnected||detailShell(expected,kind)!==owner)
        throw Error('简历详情已变化，未选择站内同事');
      found=findShareMenu(owner);
      if(found)break;
    }
    if(!found)throw Error('没有唯一的站内转发窗口，未选择同事');
    let {menu,scope}=found;
    verifyShareDocument(scope);
    const tabs=shareLabels(menu,'站内同事');
    if(tabs.length!==1)throw Error('没有唯一的“站内同事”标签，未继续转发');
    const tab=D.closest(tabs[0],'.c-share-box .left-list .nav-list .item')||
      D.closest(tabs[0],'button,[role="tab"],[role="button"],li')||tabs[0];
    tab.click();
    await delay(250);guard();
    found=findShareMenu(owner);
    if(!found||found.scope.doc!==scope.doc||found.menu!==menu)
      throw Error('站内转发窗口已变化，未选择同事');
    const inputs=shareElements(menu).filter(element=>element.matches('input[placeholder*="姓名"]'));
    const messages=shareElements(menu).filter(element=>element.matches('textarea'));
    if(inputs.length!==1||messages.length!==1||inputs[0].value||messages[0].value)
      throw Error('站内转发收件人或留言区域不明确，请先清空后重试');
    const recent=recentColleague(menu,recipient);
    recent.label.click();
    await delay(250);guard();
    if(!menu.isConnected||!visible(menu)||detailShell(expected,kind)!==owner)
      throw Error('选择同事后窗口或候选人已变化，未发送履历');
    verifyShareDocument(scope);
    const sendControl=colleagueSendControl(menu,messages[0]);
    if(!sendControl)throw Error('没有唯一可用的站内转发按钮，未发送履历');
    if(inputs[0].value&&inputs[0].value.trim()!==recipient)
      throw Error(`选择同事后搜索内容不是“${recipient}”，未发送履历`);
    const selected=recentColleague(menu,recipient);
    if(selected.label!==recent.label||selected.root!==recent.root)throw Error(`选择同事“${recipient}”后联系人已变化，未发送履历`);
    for(let n=0;n<12&&shareLabels(scope.doc,'转发成功').length;n++){
      await delay(200);guard();
    }
    if(shareLabels(scope.doc,'转发成功').length)
      throw Error('页面仍有上次转发成功提示，请待提示消失后重试');
    const candidate=currentDetail();
    if(!candidate.token||candidate.kind!==(kind==='canvas'?'canvas-owner':'text')||
        candidate.name&&normalize(candidate.name)!==normalize(expected))throw Error('无法确认站内转发的原候选人简历');
    const token=String(++colleagueSequence);
    colleagueSession={token,menu,scope,owner,expected,kind,button:sendControl,
      input:inputs[0],inputValue:inputs[0].value||'',message:messages[0],clicked:false,candidate,recipient,
      recipientLabel:selected.label,recipientRoot:selected.root,recipientState:colleagueSelectionState(selected)};
    return {token,recipient};
  }
  async function sendColleague(token){
    guard();
    const session=verifyColleagueSession(token);
    if(session.clicked)throw Error('站内转发已尝试，未重复发送');
    if(!session.button.isConnected||!visible(session.button)||session.button.disabled||
        session.button.getAttribute('aria-disabled')==='true'||
        session.button.classList?.contains('disabled')||
        !session.input.isConnected||session.input.value!==session.inputValue||
        !session.message.isConnected||session.message.value||
        shareLabels(session.scope.doc,'转发成功').length)
      throw Error('站内转发的收件人、留言或页面状态已变化，未发送履历');
    session.clicked=true;
    session.button.click();
    for(let n=0;n<16;n++){
      await delay(200);guard();
      verifyShareDocument(session.scope);
      if(detailShell(session.expected,session.kind)!==session.owner)
        throw Error('转发后候选人详情已变化，请人工核对结果');
      verifyColleagueCandidate(session,false);
      if(shareLabels(session.scope.doc,'转发成功').length===1){
        colleagueSession=null;
        return {sent:true,recipient:session.recipient};
      }
    }
    throw Error('已点击站内转发，但未见“转发成功”；请人工核对，系统不会重复发送');
  }
  function closeShare(){
    colleagueSession=null;
    const session=shareSession;
    if(session)verifyShareSession(false);
    const found=session?null:findShareMenu();
    if(found)verifyShareDocument(found.scope);
    const hint=session?.menu||found?.menu;
    shareSession=null;
    if(!hint)return;
    let root=hint;
    while(root&&root!==hint.ownerDocument.body){
      if(shareLabels(root,'邮件转发').length){closeRegion(root);return;}
      root=D.parent(root);
    }
    throw Error('分享窗口仍打开，请手动关闭后重新开始');
  }
  window.__hrmAuto={version:46,run:async(action,args={})=>{
    if(action==='clear-copy')return clearCopy();
    if(action==='stop'){stopped=true;previewScope=null;shareSession=null;colleagueSession=null;favoriteSession=null;canvasExpandSession=null;openedCandidate=null;expectedDetailName=null;return true;}
    if(action==='reset'){stopped=false;previewScope=null;pagerAdvance=null;shareSession=null;colleagueSession=null;favoriteSession=null;canvasExpandSession=null;closedCurrentTokens.clear();dismissedImagePreviews=new WeakSet();openedCandidate=null;expectedDetailName=null;window.__hrmCancelPicker?.();return true;}
    if(action==='probe-image-preview'||action==='dismiss-image-preview'){
      if(stopped)throw Error('任务已停止');
      if(!allowedPage())throw Error('页面已离开 BOSS');
      return action==='probe-image-preview'?probeImagePreview():dismissImagePreview(args);
    }
    if(action==='favorite'){
      const session=favoriteSession;
      try{guard();return await favorite(args);}
      catch(error){
        if(error&&typeof error==='object')error.favoriteAttempted=Boolean(session?.clicked);
        throw error;
      }
    }
    guard();
    if(action==='current-detail')return currentDetail();
    if(action==='close-current')return closeCurrent(args);
    if(action==='prepare-canvas-expand')return prepareCanvasExpand();
    if(action==='click-canvas-expand')return clickCanvasExpand(args.token);
    if(action==='scan'){
      previewScope=null;
      expectedDetailName=args.expectedName===undefined?null:String(args.expectedName||'');
      const idx=index(),report=detailReport('',idx),shown=frameVisible(),dialog=shown&&!!canvasDialog();
      if(shown&&report.detail&&!dialog&&!idx.promotions.some(item=>item.modal))
        rememberPreviewScope(D.closest(report.detail.root,'.dialog-lib-resume,[role="dialog"],dialog,[aria-modal="true"]')||report.detail.root,report.detail.root);
      return {frameKey:key(),detail:shown?report.detail?.name||'':'',canvasDialog:dialog,
        promotionBlocked:shown&&idx.promotions.some(item=>item.modal),ignoredPromotions:shown?idx.promotions.length:0,
        canvasBody:shown&&canvasPath(location.href)&&idx.stats.canvas===1&&!!window.frameElement?.closest('.dialog-lib-resume'),diagnostics:report.diagnostics,
        cards:shown&&!dialog&&!report.detail?cards(idx):[]};
    }
    if(action==='dismiss-promotions'){
      const found=promotions().filter(item=>item.modal);
      if(!found.length)return {dismissed:0};
      if(found.length!==1||!frameVisible())throw Error('热搜推荐弹层范围不唯一，请关闭该弹层后重试');
      const {root,title}=found[0],button=closingControl(root);
      if(!button||!usablePager(button))throw Error('未找到唯一可操作的热搜推荐关闭入口，请手动关闭该弹层');
      const link=D.closest(button,'a[href]');
      if(link&&!['#','javascript:;','javascript:void(0)'].includes(link.getAttribute('href')))throw Error('热搜推荐关闭入口包含跳转链接，未点击');
      guard();
      const verified=promotions().filter(item=>item.modal);
      if(verified.length!==1||verified[0].root!==root||verified[0].title!==title||!root.isConnected)throw Error('热搜推荐弹层已变化，未点击');
      button.click();await delay(200);guard();
      if(promotions().some(item=>item.modal))throw Error('热搜推荐弹层尚未关闭，请手动关闭后重试');
      return {dismissed:1};
    }
    if(action==='html'){const idx=index(),report=detailReport('',idx),root=report.detail?.root||document.body;return {frameKey:key(),diagnostics:report.diagnostics,scope:report.detail?'detail':'page',...D.snapshot(root)};}
    if(action==='advance-list')return advanceList();
    if(action==='open'){
      previewScope=null;
      favoriteSession=null;
      const r=records.get(args.id);if(!r||!visible(r.root)||D.parent(r.root)!==r.parent||signature(text(r.root))!==args.signature)throw Error('列表已更新，请重新开始采集');
      if(r.kind==='recommendation'&&(recommendationIdentity(r.root)!==r.platform_geek_id||
          (args.platform_geek_id||'')!==r.platform_geek_id))throw Error('推荐候选人的身份已变化，请重新开始采集');
      const ignored=promotions();
      if(ignored.some(item=>item.modal)||excluded(r.root,ignored))throw Error('候选人入口位于热搜推荐区域，已忽略');
      if(mediaPreviewAncestor(r.label))throw Error('候选人姓名位于头像或媒体预览控件中，未点击');
      if(blockedActions.test(text(D.closest(r.label,'button')||r.label)))throw Error('候选人入口不明确');
      const link=D.closest(r.label,'a[href]');
      if(link&&!['#','javascript:;','javascript:void(0)'].includes(link.getAttribute('href'))){const u=new URL(link.href,location.href);if(u.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(u.hostname))throw Error('候选人入口不属于 BOSS，未打开');}
      r.label.scrollIntoView({block:'center'});
      if(!canPoint(r.label))throw Error('候选人小卡片被遮挡，请先关闭浮层。');
      if(mediaPreviewAncestor(r.label)||!D.contains(r.root,r.label))throw Error('候选人入口已变化或属于头像预览，未点击');
      r.label.click();openedCandidate={name:r.name,latin:r.kind==='recommendation'&&latinName(r.name)===r.name,
        platform_geek_id:r.platform_geek_id||''};return {name:r.name};
    }
    if(action==='read')return read(args.name,true);
    if(action==='prepare-copy'){
      const {capture,resume}=await read(args.name,false,args.skipExpansion===true?0:1);
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
      let root=canvasDialog();
      if(!root){
        const bound=currentResumeFrame();
        if(!bound||bound.report.detail||bound.canvases.length!==1)throw Error('当前画布简历已关闭或切换');
        root=bound.root;
      }
      for(const el of expanders(root)){guard();el.click();await delay(180);}
      return true;
    }
    if(action==='prepare-favorite')return prepareFavorite(args);
    if(action==='verify-favorite')return verifyFavorite(args);
    if(action==='prepare-colleague')return prepareColleague(args.name,args.kind,args.recipient);
    if(action==='send-colleague')return sendColleague(args.token);
    if(action==='share')return share(args.name,args.kind);
    if(action==='share-image')return shareImage();
    if(action==='share-layout')return shareLayout();
    if(action==='closeShare'){closeShare();return true;}
    if(action==='close'){
      favoriteSession=null;closeShare();const root=detailShell(args.name,args.kind);
      const buttons=args.kind==='canvas'?D.query(root,'.close-btn'):[];
      if(buttons.length===1)buttons[0].click();else closeRegion(root);
      openedCandidate=null;
      expectedDetailName=null;
      return true;
    }
    if(action==='layout')return {key:key(),width:innerWidth,height:innerHeight,children:D.query(document.body,'iframe').filter(visible).map(e=>{const r=e.getBoundingClientRect();let src='';try{const u=new URL(e.src);src=u.origin+u.pathname;}catch{}return {key:src,x:r.x+e.clientLeft,y:r.y+e.clientTop,width:e.clientWidth,height:e.clientHeight};})};
    throw Error('未知采集动作');
  }};
})();
