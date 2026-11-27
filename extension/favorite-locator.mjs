// MAIN-world adapter for the visible BOSS favourites list. No private requests,
// page methods, greetings, telephone actions, or collection mutations.
export async function favoriteLocatorAction(args = {}) {
  const normalize = value => typeof value === 'string' ? value.normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[＊﹡∗]/g, '*').replace(/\s+/g, '').trim() : '';
  const uid = value => typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 ? String(value) : ''
    : typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : '';
  const encrypted = value => typeof value === 'string' && /^[A-Za-z0-9_~-]{1,160}$/.test(value) ? value : '';
  const cleanName = value => normalize(value).replace(/(?:热搜|已收藏|在线|刚刚活跃|今日活跃|本周活跃|本月活跃|近期活跃|\d+(?:分钟|小时|天|周|月)(?:内|前)?活跃)+$/g, '');
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const target = object(args.target) || {};
  const expectedName = normalize(target.name);
  let expectedUid = uid(target.boss_chat_uid), expectedPlatform = encrypted(target.platform_geek_id);
  const periodText = value => normalize(value)
    .replace(/(\d{4})[年/.\-](0?[1-9]|1[0-2])(?=月|[^0-9]|$)/g, (_,year,month) => year + '.' + Number(month))
    .replace(/月/g,'').replace(/[—–－~～]/g,'-').replace(/至今|现在/g,'PRESENT')
    .replace(/(?:-|至|到)?PRESENT/g,'-PRESENT').replace(/(\d)(?:至|到)(?=\d{4})/g,'$1-');
  const anchors = Array.isArray(target.anchors) ? target.anchors : [
    ...((target.anchors?.companies || []).map(text => ({kind:'company',text}))),
    ...((target.anchors?.schools || []).map(text => ({kind:'school',text}))),
  ];
  const evidence = Array.isArray(target.evidence) ? target.evidence : [];
  // Only the legal company suffix is removed. Industry terms (e.g. 科技),
  // locations and parenthesised names remain significant.
  const brand = value => normalize(value).replace(/(?:股份有限公司|有限责任公司|有限公司)$/,'');
  function match(card) {
    if (!expectedName || normalize(card?.name) !== expectedName) return {matched:false,reason:'name_mismatch'};
    const actualUid = uid(card.boss_chat_uid), actualPlatform = encrypted(card.platform_geek_id);
    if (expectedUid && actualUid && expectedUid !== actualUid || expectedPlatform && actualPlatform && expectedPlatform !== actualPlatform)
      return {matched:false,reason:'identity_conflict'};
    if (expectedUid && actualUid === expectedUid) return {matched:true,method:'platform_uid'};
    if (expectedPlatform && actualPlatform === expectedPlatform) return {matched:true,method:'platform_id'};
    const value = normalize(card.text);
    const company = anchors.filter(row => row?.kind === 'company' && normalize(row.text).length >= 4)
      .map(row => normalize(row.text)).filter(text => value.includes(text));
    const school = anchors.filter(row => row?.kind === 'school' && normalize(row.text).length >= 4)
      .map(row => normalize(row.text)).filter(text => value.includes(text));
    // A generic date cannot stand in for a second independent professional
    // fact. A period is useful only when attached to the matching employer.
    // Dates must belong to the same rendered employment row as the employer.
    // Finding an employer and another employer's dates elsewhere in the card
    // is not evidence of a match, even when school and masked name coincide.
    const workRows = Array.isArray(card.work_rows) ? card.work_rows : [];
    const datedCompanies = new Set(evidence.filter(row => row?.kind === 'work' && company.includes(normalize(row.organization))
      && typeof row.period === 'string' && /^\d{4}(?:\.\d{1,2})?-(?:\d{4}(?:\.\d{1,2})?|PRESENT)$/.test(periodText(row.period))
      && workRows.some(work => normalize(work.text).includes(normalize(row.organization))
        && periodText(work.period) === periodText(row.period))).map(row => normalize(row.organization)));
    const counts = {company_matches:company.length,school_matches:school.length,dated_company_matches:datedCompanies.size};
    if (company.length && school.length && datedCompanies.size) return {matched:true,method:'professional_fields',...counts};
    if (datedCompanies.size >= 2) return {matched:true,method:'employers_periods',...counts};
    const probes = new Set(evidence.filter(row => row?.kind === 'work' && brand(row.organization).length >= 4
      && /^\d{4}(?:\.\d{1,2})?-(?:\d{4}(?:\.\d{1,2})?|PRESENT)$/.test(periodText(row.period))
      && workRows.some(work => brand(work.company) === brand(row.organization)
        && periodText(work.period) === periodText(row.period))).map(row => brand(row.organization)));
    if (school.length && probes.size >= 2) return {matched:true,method:'professional_probe',probe_only:true,...counts,probe_company_matches:probes.size};
    return {matched:false,reason:'insufficient_evidence',...counts};
  }
  // Pure matching entry used by the local test suite; it performs no page read.
  if (args.action === 'match') return match(args.card);
  let state, record;
  const fail = reason => ({ok:false,status:'blocked',reason});
  try {
    const page = new URL(location.href);
    if (page.protocol !== 'https:' || !['www.zhipin.com','zhipin.com'].includes(page.hostname)
        || !/^\/web\/(?:frame|geek)\/recommend\/interaction\/?$/.test(page.pathname))
      return {ok:true,status:'unsupported',is_favorites:false};
    if (window.top.location.origin !== page.origin) return fail('origin_changed');
    const account = () => uid(window.top._PAGE?.uid);
    if (!window.__hrmFavoriteLocatorStateV1) window.__hrmFavoriteLocatorStateV1 = {
      documentToken:crypto.randomUUID(),records:new Map(),snapshot:null,stopped:false,scrolls:0,pages:0,
    };
    state = window.__hrmFavoriteLocatorStateV1;
    const metadata = () => ({account_uid:account(),document_token:state.documentToken});
    const notify = (stage,count) => {
      const messages={loading:'正在打开收藏列表…',scanning:'正在查找收藏中的候选人',verifying:'正在核验候选人简历…',
        revealing:'正在返回对应收藏卡片…',located:'已找到工作台候选人，卡片已标记',not_found:'本次扫描未找到对应收藏卡片',
        limit:'已达到本次扫描上限',opened_unverified:'简历身份尚未核验，未标记卡片',failed:'定位未完成，请查看工作台提示',stopped:'已停止定位'};
      if(!Object.hasOwn(messages,stage))return false;
      let banner=document.getElementById('hrm-favorite-locator-status');
      if(!banner){banner=document.createElement('div');banner.id='hrm-favorite-locator-status';banner.setAttribute('role','status');document.body?.append(banner);}
      banner.textContent=messages[stage]+(stage==='scanning'&&Number.isSafeInteger(count)&&count>=0?' · 当前读取 '+Math.min(count,5000)+' 张卡片':'');
      banner.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483646;max-width:460px;padding:10px 18px;border-radius:8px;background:#075b54;color:white;font:14px/1.5 sans-serif;box-shadow:0 2px 9px #0003;pointer-events:none;';
      return true;
    };
    if(args.action==='notify')return {ok:notify(args.state,args.count),status:'notified',...metadata()};
    if (args.action === 'stop') {
      state.stopped = true;state.records.clear();state.snapshot = null;
      return {ok:true,status:'stopped',...metadata()};
    }
    if (args.action === 'reset') {
      state.clearHighlight?.();
      state.stopped = false;state.records.clear();state.snapshot = null;state.scrolls = 0;state.pages = 0;state.needsTop=true;state.endWait=null;
      return {ok:true,status:'reset',...metadata()};
    }
    if (state.stopped) return fail('stopped');
    if (!Number.isSafeInteger(target.id) || target.id <= 0 || !Number.isSafeInteger(target.job_id) || target.job_id <= 0
        || !expectedName || expectedName.length > 120 || anchors.length > 120 || evidence.length > 120) return fail('invalid_target');
    const observedAccount = account();
    const accountBindings = Array.isArray(target.bindings) && observedAccount ? target.bindings.filter(binding => uid(binding?.account_uid) === observedAccount) : [];
    if (accountBindings.length > 1) return fail('ambiguous_binding');
    if (accountBindings.length) {
      const binding = accountBindings[0], boundUid = uid(binding.boss_chat_uid), boundPlatform = encrypted(binding.platform_geek_id);
      if (!boundUid || !boundPlatform || expectedUid && boundUid !== expectedUid || expectedPlatform && boundPlatform !== expectedPlatform) return fail('binding_conflict');
      expectedUid = boundUid;expectedPlatform = boundPlatform;
    }
    const identity = JSON.stringify([target.id,target.job_id,target.input_key || '',expectedName,expectedUid,expectedPlatform,anchors,evidence]);
    const visible = element => {
      if (!element?.isConnected || element.hidden || element.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      for (let node = element, depth = 0; node && depth < 40; node = node.parentElement, depth++) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || ['hidden','collapse'].includes(style.visibility) || style.opacity === '0') return false;
      }
      return true;
    };
    const text = node => String(node?.innerText ?? node?.textContent ?? '').slice(0,12000);
    const exposed = node => {
      if(!visible(node))return false;
      const rect=node.getBoundingClientRect();let x=(rect.left+rect.right)/2,y=(rect.top+rect.bottom)/2;
      let hit=document.elementFromPoint(x,y);
      if(!hit||!(node===hit||node.contains(hit)))return false;
      let child=window;
      for(let depth=0;child!==child.top&&depth<12;child=child.parent,depth++) {
        const owner=child.frameElement,parent=child.parent;
        if(!owner||!visible(owner)||parent.location.origin!==page.origin||owner.ownerDocument!==parent.document)return false;
        const box=owner.getBoundingClientRect();x+=box.left+(owner.clientLeft||0);y+=box.top+(owner.clientTop||0);
        hit=parent.document.elementFromPoint(x,y);
        if(!hit||!(hit===owner||owner.contains(hit)))return false;
      }
      return child===child.top;
    };
    const names = new Set(['收藏牛人','沟通过','看过我','对我感兴趣','我看过','同事推荐']);
    const tabs = [];
    for (const doc of [...new Set([document,window.parent.document])]) {
      for (const el of doc.querySelectorAll('a,span,div,li,button')) {
        if (!visible(el) || !names.has(normalize(text(el))) || [...el.children].some(child => normalize(text(child)) === normalize(text(el)))) continue;
        let selected = false;
        const ancestors = [];
        for (let parent = el, depth = 0; parent && depth < 3; parent = parent.parentElement, depth++) {
          ancestors.push({tag:parent.tagName,classes:String(parent.className).slice(0,160)});
          // An active class on the shared tab strip cannot select every tab.
          const parentText = normalize(text(parent));
          const containsOtherTab = [...names].some(name => name !== normalize(text(el)) && parentText.includes(name));
          if (!containsOtherTab && (parent.getAttribute('aria-selected') === 'true' || /(?:^|[\s_-])(?:active|current|selected|curr|cur|on)(?:$|[\s_-])/.test(String(parent.className)))) selected = true;
        }
        if (tabs.length < 12) tabs.push({text:normalize(text(el)),selected,classes:String(el.className).slice(0,160),ancestors});
      }
    }
    const tabDiagnostics = {tab_count:tabs.length,tabs,account_available:Boolean(account())};
    if (!account()) {
      state.records.clear();state.snapshot = null;
      return args.action === 'scan' ? {ok:true,status:'loading',reason:'account_loading',is_favorites:false,
        diagnostics:tabDiagnostics,...metadata()} : fail('account_unavailable');
    }
    const favoriteTab = tabs.some(tab => tab.text === '收藏牛人' && tab.selected);
    const otherTab = tabs.some(tab => tab.text !== '收藏牛人' && tab.selected);
    const isFavorites = favoriteTab && !otherTab;
    if (!isFavorites) return {ok:true,status:otherTab && !favoriteTab ? 'wrong_section' : favoriteTab && otherTab ? 'unsupported' : 'loading',
      reason:!tabs.length ? 'tabs_loading' : favoriteTab && otherTab ? 'ambiguous_tabs' : 'tab_selection_unconfirmed',
      is_favorites:false,tabs,diagnostics:tabDiagnostics,...metadata()};
    const dialogs = () => [...document.querySelectorAll('.dialog-lib-resume')].filter(visible);
    const forbidden = node => !!node?.closest('button,[role="button"],.operate-side,.operate-wrap,.operation,.btn-chat,.button-chat-wrap,[aria-label="取消收藏"]');
    const cardUid = (root,name) => {
      const platforms = new Set(),uids = new Set();
      for (const el of [root,...root.querySelectorAll('.card-inner')]) {
        for (const key of ['data-geek','data-geekid']) {
          const value = encrypted(el.getAttribute(key));
          if (value) platforms.add(value);
        }
      }
      // Read only identity fields of a component bound to this individual card.
      // No store traversal, network, securityId or page method invocation.
      const seen = new Set();
      for (const el of [root,...root.querySelectorAll('.card-inner,.name-label,.name-wrap')]) {
        for (let vm = object(el.__vue__), depth = 0; vm && depth < 5; vm = object(vm.$parent), depth++) {
          if (seen.has(vm)) break;seen.add(vm);
          if (vm.$el?.nodeType !== 1 || !(root === vm.$el || root.contains(vm.$el))) continue;
          for (const person of [vm.dataSource,vm.geekInfo,vm.cardInfo]) {
            if (!object(person) || cleanName(person.name || person.geekName) !== name) continue;
            const platform = encrypted(person.encryptGeekId);
            const user = uid(person.geekId ?? person.userId);
            if (platform) platforms.add(platform);
            if (user) uids.add(user);
          }
        }
      }
      return {platform_geek_id:platforms.size === 1 ? [...platforms][0] : '',boss_chat_uid:uids.size === 1 ? [...uids][0] : '',
        conflict:platforms.size > 1 || uids.size > 1};
    };
    function readCards() {
      const cards = [], roots = [...document.querySelectorAll('.geek-info-card,.candidate-card-wrap')].filter(visible);
      for (const root of roots) {
        if (root.closest('.dialog-lib-resume') || root.matches('.anonymous-geek-guide-card')) continue;
        const labels = [...root.querySelectorAll('.name-label,.card-inner .name-wrap .name')].filter(el => visible(el) && !forbidden(el));
        if (labels.length !== 1) continue;
        const label = labels[0], name = cleanName(text(label));
        if (!name || name.length > 120 || cards.some(card => card.label === label)) continue;
        const ids = cardUid(root,name);
        // BOSS often truncates employer labels visually while keeping their
        // public tooltip in title. Use that displayed information, not stores.
        const titles = [...root.querySelectorAll('[title]')].filter(visible)
          .map(el => el.getAttribute('title')).filter(value => typeof value === 'string' && value.length >= 4 && value.length <= 200 && !/https?:\/\//.test(value));
        const value = text(root) + '\n' + titles.join('\n');
        // The saved official Timeline render uses one .timeline-item per
        // time/content pair; job-item is another observed experience layout.
        // Unknown layouts are not flattened into an artificial date binding.
        const workRows = [...root.querySelectorAll('.timeline-item,.experience-item.job-item,.work-item,.job-item')]
          .filter(row => visible(row) && !row.querySelector('.timeline-item,.experience-item.job-item,.work-item,.job-item'))
          .slice(0,30).flatMap(row => {
            const rowTitles = [...row.querySelectorAll('[title]')].filter(visible)
              .map(el => el.getAttribute('title')).filter(value => typeof value === 'string' && value.length <= 200 && !/https?:\/\//.test(value));
            const rowText = text(row) + '\n' + rowTitles.join('\n');
            if (rowText.length > 600) return [];
            let periodSource = rowText;
            const times = [...row.querySelectorAll('.time')].filter(visible);
            if (times.length === 1 && times[0].querySelector('.join-shape.minus')) {
              // Official JoinText renders the dash as an empty styled <i>.
              // Bind its two displayed span endpoints within this one row.
              const ends = [...times[0].children].filter(el => el.tagName === 'SPAN' && visible(el)).map(el => normalize(text(el)));
              if (ends.length === 2 && /^\d{4}(?:[.年/-]\d{1,2}月?)?$/.test(ends[0])
                  && /^(?:\d{4}(?:[.年/-]\d{1,2}月?)?|至今|现在)$/.test(ends[1])) periodSource = ends.join('-');
            }
            const periods = [...new Set(periodText(periodSource).match(/(?:19|20)\d{2}(?:\.\d{1,2})?-(?:(?:19|20)\d{2}(?:\.\d{1,2})?|PRESENT)(?![\d.])/g) || [])];
            const content = [...row.querySelectorAll('.content')].filter(visible);
            const companyNodes = content.length === 1 ? [...content[0].children].filter(el => el.tagName === 'SPAN' && visible(el)) : [];
            const company = companyNodes.length ? text(companyNodes[0]).trim() : '';
            return periods.length === 1 ? [{text:rowText,period:periods[0],company:company.length <= 200 ? company : ''}] : [];
          });
        cards.push({root,label,name,text:value,work_rows:workRows,...ids,
          fingerprint:JSON.stringify([name,ids.platform_geek_id,ids.boss_chat_uid,normalize(value),workRows])});
      }
      return {cards,roots};
    }
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2,'0')).join('');
    const scrollContext = cards => {
      const rows=[],seen=new Set();
      const add=(node,level)=>{if(!node||seen.has(node)||rows.length>=30)return;seen.add(node);
        rows.push({tag:node.tagName,classes:String(node.className||'').slice(0,120),level,overflow:getComputedStyle(node).overflowY,
          height:Number(node.scrollHeight)||0,client:Number(node.clientHeight)||0,top:Number(node.scrollTop)||0});};
      for(let node=cards[0]?.root,depth=0;node&&depth<15;node=node.parentElement,depth++)add(node,0);
      add(document.scrollingElement,0);
      for(let child=window,level=1;child!==child.top&&level<=8;child=child.parent,level++) {
        if(child.parent.location.origin!==page.origin)break;
        for(let node=child.frameElement,depth=0;node&&depth<15;node=node.parentElement,depth++)add(node,level);
        add(child.parent.document.scrollingElement,level);
      }
      return rows;
    };
    const scrollSurfaces = cards => {
      const containers=new Set(),frameChain=[];
      const hasRange=node=>node&&Number.isFinite(node.scrollHeight)&&Number.isFinite(node.clientHeight)&&node.scrollHeight>node.clientHeight+5;
      for(const card of cards)for(let node=card.root.parentElement;node;node=node.parentElement) {
        if(/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)&&hasRange(node)){containers.add(node);break;}
      }
      if(!containers.size&&hasRange(document.scrollingElement))containers.add(document.scrollingElement);
      for(let child=window,depth=0;!containers.size&&child!==child.top&&depth<12;child=child.parent,depth++) {
        const parent=child.parent,owner=child.frameElement;
        if(parent.location.origin!==page.origin||!owner||!visible(owner)||owner.ownerDocument!==parent.document)return {error:'frame_changed'};
        frameChain.push({child,parent,owner});
        for(let node=owner.parentElement;node;node=node.parentElement) {
          const style=parent.getComputedStyle?parent.getComputedStyle(node):getComputedStyle(node);
          if(/(auto|scroll|overlay)/.test(style.overflowY)&&hasRange(node)){containers.add(node);break;}
        }
        if(!containers.size&&hasRange(parent.document.scrollingElement))containers.add(parent.document.scrollingElement);
      }
      return {containers,frameChain};
    };
    if (args.action === 'status') {
      record = state.records.get(args.token);
      if (!record || record.identity !== identity || record.account !== account() || !record.opened) return fail('invalid_token');
      const currentDialogs = dialogs();
      if (!currentDialogs.length) return {ok:true,status:'loading',...metadata()};
      if (currentDialogs.length !== 1) return fail('ambiguous_detail');
      const dialog = currentDialogs[0], roots = new Set(), seen = new Set();
      for (const node of [dialog,...dialog.querySelectorAll('.resume-detail-wrap,.resume-left,iframe')]) {
        for (let el = node, depth = 0; el && dialog.contains(el) && depth < 24; el = el.parentElement, depth++) {
          for (let vm = object(el.__vue__), parents = 0; vm && parents < 16; vm = object(vm.$parent), parents++) {
            if (seen.has(vm)) break;seen.add(vm);
            if (vm.$options?.name === 'ResumeRoot' && vm.$el?.nodeType === 1 && dialog.contains(vm.$el) && visible(vm.$el)) roots.add(vm);
          }
        }
      }
      if (roots.size !== 1) return {ok:true,status:'opened_unverified',...metadata()};
      const root = [...roots][0];
      if (root.loading === true) return {ok:true,status:'loading',...metadata()};
      const resume = root.resumeInfo;
      const base = object(resume?.geekBaseInfo), platform = encrypted(base?.encryptGeekId), user = uid(base?.userId);
      if (cleanName(base?.name) !== expectedName || expectedUid && user !== expectedUid || expectedPlatform && platform !== expectedPlatform
          || record.card.platform_geek_id && platform !== record.card.platform_geek_id
          || record.card.boss_chat_uid && user !== record.card.boss_chat_uid) return fail('detail_identity_conflict');
      if (!platform || !user || !record.card.platform_geek_id && !record.card.boss_chat_uid && !expectedUid && !expectedPlatform)
        return {ok:true,status:'opened_unverified',...metadata()};
      const selected = [root.currGeek?.encryptGeekId,root.dataSource?.encryptGeekId].filter(Boolean);
      if (!selected.length || selected.some(value => encrypted(value) !== platform)) return fail('detail_identity_conflict');
      if(record.method==='professional_probe') {
        // Official ResumeSummary/WorkItem bind all three fields to the same
        // employment item. Full legal names are required at this final step.
        const works=Array.isArray(resume.geekWorkExpList)?resume.geekWorkExpList.slice(0,80):[];
        const schools=Array.isArray(resume.geekEduExpList)?resume.geekEduExpList.slice(0,30):[];
        const confirmed=new Set(evidence.filter(item=>item?.kind==='work'&&works.some(work=>
          normalize(work?.company)===normalize(item.organization)&&typeof work.startYearMonStr==='string'
          &&typeof work.endYearMonStr==='string'&&work.startYearMonStr&&work.endYearMonStr
          &&periodText(work.startYearMonStr+'-'+work.endYearMonStr)===periodText(item.period))).map(item=>normalize(item.organization)));
        const school=anchors.some(item=>item?.kind==='school'&&normalize(item.text).length>=4
          &&schools.some(edu=>normalize(edu?.school)===normalize(item.text)));
        if(confirmed.size<2||!school)return {ok:true,status:'opened_unverified',reason:'detail_professional_unconfirmed',...metadata()};
      }
      if (state.stopped || account() !== record.account || root.resumeInfo !== resume || root.resumeInfo?.geekBaseInfo !== base
          || cleanName(base.name) !== expectedName || encrypted(base.encryptGeekId) !== platform || uid(base.userId) !== user
          || !visible(dialog) || !visible(root.$el)) return fail('detail_identity_conflict');
      const result={ok:true,status:'located',binding_verified:true,name:base.name,boss_chat_uid:user,platform_geek_id:platform,method:record.method,...metadata()};
      record.verified={dialog,root,resume,base,platform,user,result};
      return result;
    }
    if(args.action==='reveal'||args.action==='reveal_status') {
      record=state.records.get(args.token);
      if(!record||!record.verified||record.identity!==identity||record.account!==account()||!record.opened)return fail('invalid_token');
      const verified=record.verified,current=dialogs();
      const detailSame=()=>verified.root.resumeInfo===verified.resume&&verified.resume.geekBaseInfo===verified.base
        &&cleanName(verified.base.name)===expectedName&&encrypted(verified.base.encryptGeekId)===verified.platform
        &&uid(verified.base.userId)===verified.user&&[verified.root.currGeek?.encryptGeekId,verified.root.dataSource?.encryptGeekId].some(Boolean)
        &&[verified.root.currGeek?.encryptGeekId,verified.root.dataSource?.encryptGeekId]
          .filter(Boolean).every(value=>encrypted(value)===verified.platform);
      if(!record.closeStarted) {
        if(args.action!=='reveal'||current.length!==1||current[0]!==verified.dialog||!visible(verified.root.$el)||!detailSame())return fail('detail_identity_conflict');
        const controls=[...verified.dialog.querySelectorAll('button,a,[role="button"],span,i,div')].filter(node=>visible(node)
          &&!node.closest('.operate-side,.operate-wrap,.operation,.btn-chat,.button-chat-wrap,[aria-label="取消收藏"]')
          &&(/^(关闭|close)$/i.test(node.getAttribute('aria-label')||node.getAttribute('title')||'')
            ||/^(关闭|×|✕|✖)$/.test(text(node).trim())||node.matches('.close-btn,.boss-popup__close,.boss-dialog__close,.drawer-close,.icon-close')));
        const unique=controls.filter(node=>!controls.some(other=>other!==node&&node.contains(other)));
        if(unique.length!==1)return {...fail('close_unavailable'),...metadata()};
        const close=unique[0];
        if(close.tagName==='A'&&close.getAttribute('href')&&!['#','javascript:;','javascript:void(0)','javascript:void(0);'].includes(close.getAttribute('href')))return fail('unsafe_link');
        if(!exposed(close)||state.stopped||account()!==record.account||!detailSame())return fail('close_obscured');
        record.closeStarted=true;close.click();
        return {ok:true,status:'revealing',...metadata()};
      }
      if(current.length) {
        if(current.length!==1||current[0]!==verified.dialog||!detailSame())return fail('detail_identity_conflict');
        return {ok:true,status:'revealing',...metadata()};
      }
      const selected=readCards().cards.filter(card=>card.root===record.card.root&&card.label===record.card.label&&card.fingerprint===record.card.fingerprint&&!card.conflict);
      if(selected.length!==1)return fail('card_changed');
      const card=selected[0];card.root.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      if(state.stopped||account()!==record.account||!exposed(card.label))return fail('card_obscured');
      const again=readCards().cards.filter(item=>item.root===card.root&&item.label===card.label&&item.fingerprint===record.card.fingerprint);
      if(again.length!==1)return fail('card_changed');
      state.clearHighlight?.();
      const oldStyle={outline:card.root.style.outline||'',outlineOffset:card.root.style.outlineOffset||'',boxShadow:card.root.style.boxShadow||''};
      card.root.style.outline='4px solid #078c7c';card.root.style.outlineOffset='3px';card.root.style.boxShadow='0 0 0 8px #078c7c22';
      card.root.setAttribute('data-hrm-favorite-located','true');
      let observer;
      state.clearHighlight=()=>{observer?.disconnect();for(const [key,value]of Object.entries(oldStyle))card.root.style[key]=value;
        card.root.removeAttribute('data-hrm-favorite-located');state.clearHighlight=null;};
      if(typeof MutationObserver==='function') {
        observer=new MutationObserver(()=>{
          try {
            if(account()!==record.account||!card.root.isConnected||!readCards().cards.some(item=>item.root===card.root&&item.label===card.label&&item.fingerprint===record.card.fingerprint)) {
              state.clearHighlight?.();notify('failed');
            }
          }catch{state.clearHighlight?.();}
        });
        observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-geek','data-geekid']});
      }
      notify('located');record.cardLocated=true;
      return {...verified.result,status:'card_located',card_visible:true,...metadata()};
    }
    if (dialogs().length) return fail('detail_already_open');
    const {cards,roots} = readCards();
    if(args.action==='scan'&&state.needsTop) {
      state.needsTop=false;
      const surfaces=scrollSurfaces(cards);
      if(surfaces.error)return fail(surfaces.error);
      if(surfaces.containers.size===1) {
        const container=[...surfaces.containers][0];
        if(container.scrollTop>0) {
          if(state.stopped||account()!==observedAccount)return fail('account_changed');
          container.scrollTop=0;
          return {ok:true,status:'loading',reason:'resetting_list_position',is_favorites:true,diagnostics:{scroll_context:scrollContext(cards)},...metadata()};
        }
      }
    }
    const signature = await hash(JSON.stringify(cards.map(card => card.fingerprint)));
    if (state.stopped) return fail('stopped');
    if (account() !== observedAccount) {state.records.clear();state.snapshot=null;return fail('account_changed');}
    if (args.action === 'scan') {
      state.records.clear();
      state.snapshot = {signature,identity,account:account(),cards};
      const matched = cards.map(card => ({card,decision:card.conflict ? {matched:false} : match(card)})).filter(row => row.decision.matched);
      const targetCards = cards.filter(card => normalize(card.name) === expectedName).slice(0,3);
      const targetMatches = targetCards.map(card => card.conflict ? {reason:'conflicting_card_ids'} : match(card));
      const result = {ok:true,status:matched.length > 1 ? 'ambiguous' : matched.length ? 'match' : 'scanned',is_favorites:true,
        count:cards.length,signature,diagnostics:{root_count:roots.length,card_count:cards.length,
          scroll_context:scrollContext(cards),last_advance:state.lastAdvance||null,
          target_work_row_counts:cards.filter(card=>normalize(card.name)===expectedName).slice(0,5).map(card=>card.work_rows.length),
          target_match_reasons:targetMatches.map(item => item.method || item.reason),
          company_matches:targetMatches.map(item => item.company_matches ?? 0),
          school_matches:targetMatches.map(item => item.school_matches ?? 0),
          dated_company_matches:targetMatches.map(item => item.dated_company_matches ?? 0),
          target_row_structures:targetCards.map(card => ({card:{tag:card.root.tagName,classes:String(card.root.className).slice(0,160)},
            rows:[...card.root.querySelectorAll('[class]')].filter(node => /timeline|experience|work|job-item|edu/.test(String(node.className)))
              .slice(0,12).map(node => ({tag:node.tagName,classes:String(node.className).slice(0,160)}))})),
          target_work_rows:targetCards.map(card => [...card.root.querySelectorAll('.work-exps .timeline-item,.experience-item.job-item,.work-item,.job-item')]
            .filter(visible).slice(0,3).map(row => ({text:text(row).slice(0,200),
              children:[...row.children].slice(0,8).map(el => ({tag:el.tagName,classes:String(el.className).slice(0,100)}))}))),
          target_components:targetCards.map(card => {
            const seen=new Set(),components=[];
            for(const el of [card.root,...card.root.querySelectorAll('.card-inner,.name-wrap')])
              for(let component=object(el.__vue__),depth=0;component&&depth<5;component=object(component.$parent),depth++) {
                if(seen.has(component))break;seen.add(component);
                if(component.$el?.nodeType!==1||!(card.root===component.$el||card.root.contains(component.$el)))continue;
                components.push({name:String(component.$options?.name||'').slice(0,80),
                  props:Object.keys(object(component.$props)||{}).filter(key=>!/(security|token|cookie|password|credential)/i.test(key)).slice(0,30)});
                if(components.length>=3)break;
              }
            return components.slice(0,3);
          }),
          name_label_count:document.querySelectorAll('.name-label,.name-wrap .name').length},...metadata()};
      if (!cards.length) {
        const namePaths = [...document.querySelectorAll('span,div,a,h3,h4')]
          .filter(el => visible(el) && normalize(text(el)) === expectedName && ![...el.children].some(child => normalize(text(child)) === expectedName))
          .slice(0,3).map(el => {const chain=[];for(let node=el,depth=0;node&&depth<6;node=node.parentElement,depth++)
            chain.push({tag:node.tagName,classes:String(node.className).slice(0,180)});return chain;});
        result.diagnostics.name_paths = namePaths;
        const empty = [...document.querySelectorAll('.empty,.empty-state,.data-tips,.no-data')].filter(visible)
          .some(el => /暂无收藏|还没有收藏|没有收藏的牛人/.test(text(el)));
        result.status = empty ? 'empty' : roots.length || namePaths.length ? 'unsupported' : 'loading';
      }
      if (matched.length === 1) {
        const token = crypto.randomUUID(), {card,decision} = matched[0];
        state.records.set(token,{card,method:decision.method,identity,account:account(),created:Date.now(),opened:false});
        result.token = token;
        result.match = {name:card.name,method:decision.method,platform_geek_id:card.platform_geek_id,boss_chat_uid:card.boss_chat_uid};
      }
      return result;
    }
    if (args.action === 'open') {
      record = state.records.get(args.token);
      if (!record || record.opened || record.identity !== identity || record.account !== account() || Date.now() - record.created > 120000) return fail('invalid_token');
      const selected = cards.filter(card => card.root === record.card.root && card.label === record.card.label && card.fingerprint === record.card.fingerprint);
      const allMatches = cards.filter(card => !card.conflict && match(card).matched);
      if (selected.length !== 1 || allMatches.length !== 1 || allMatches[0].root !== selected[0].root || forbidden(selected[0].label)) return fail('card_changed');
      const label = selected[0].label;
      if (label.tagName === 'A' && label.getAttribute('href') && !['#','javascript:;','javascript:void(0)','javascript:void(0);'].includes(label.getAttribute('href'))) return fail('unsafe_link');
      label.scrollIntoView({block:'center',inline:'nearest'});
      if (state.stopped || account() !== record.account || !visible(label) || forbidden(label)) return fail('card_changed');
      const rect = label.getBoundingClientRect();let x = (rect.left + rect.right) / 2,y = (rect.top + rect.bottom) / 2;
      let hit = document.elementFromPoint(x,y);
      if (!hit || !(label === hit || label.contains(hit))) return fail('card_obscured');
      for (let child=window,depth=0;child!==child.top&&depth<12;child=child.parent,depth++) {
        const owner=child.frameElement;
        if (!owner || !visible(owner)) return fail('card_obscured');
        const box=owner.getBoundingClientRect();x+=box.left+(owner.clientLeft||0);y+=box.top+(owner.clientTop||0);
        hit=child.parent.document.elementFromPoint(x,y);
        if (!hit || !(hit===owner||owner.contains(hit))) return fail('card_obscured');
      }
      const again = readCards().cards.filter(card => card.root === record.card.root && card.label === label && card.fingerprint === record.card.fingerprint);
      if (state.stopped || account() !== record.account || again.length !== 1) return fail('card_changed');
      record.opened = true;
      label.click();
      return {ok:true,status:'opening',token:args.token,...metadata()};
    }
    if (args.action === 'advance') {
      const previous = state.snapshot;
      if (!previous || previous.identity !== identity || previous.account !== account() || previous.signature !== args.signature || signature !== args.signature) return {ok:true,status:'changed',...metadata()};
      state.records.clear();state.snapshot = null;
      const next = [...document.querySelectorAll('.page-next,.pagination .next,.pagination-next,.pagination [aria-label="下一页"]')]
        .filter(el => visible(el) && !el.matches('[disabled],[aria-disabled="true"],.disabled') && !el.closest('.disabled,[aria-disabled="true"]')
          && /^(?:下一页|下页|›|>|»)?$/.test(normalize(text(el))));
      if (next.length === 1 && state.pages < 20) {
        const el = next[0];
        if (el.tagName === 'A' && el.href && new URL(el.href,page.href).origin !== page.origin) return fail('unsafe_link');
        state.pages++;el.click();return {ok:true,status:'advanced',...metadata()};
      }
      // The interaction frame can expand to the list's full height while its
      // containing main pane performs the scrolling. Only inspect ancestors
      // of this exact same-origin iframe, never unrelated page sidebars.
      const surfaces=scrollSurfaces(cards);
      if(surfaces.error)return fail(surfaces.error);
      const {containers,frameChain}=surfaces;
      const finishEnd=(container,reason)=>{
        const key=signature+'|'+(container?.scrollHeight||0)+'|'+(container?.scrollTop||0);
        if(!state.endWait||state.endWait.key!==key)state.endWait={key,started:Date.now(),tries:0};
        state.endWait.tries++;
        const pending=Date.now()-state.endWait.started<2500&&state.endWait.tries<=5;
        state.lastAdvance={reason:pending?'waiting_for_incremental_load':reason,loading:pending,
          chosen:container?{tag:container.tagName,classes:String(container.className||'').slice(0,120),top:container.scrollTop,
            client:container.clientHeight,height:container.scrollHeight}:null};
        return {ok:true,status:pending?'advanced':'end',diagnostics:{last_advance:state.lastAdvance},...metadata()};
      };
      if(containers.size>1)return {...fail('ambiguous_scroll_containers'),diagnostics:{scroll_context:scrollContext(cards)},...metadata()};
      if(state.scrolls>=80)return {ok:true,status:'limit',...metadata()};
      if(!containers.size)return finishEnd(null,'no_scroll_container');
      const container = [...containers][0], before = container.scrollTop;
      if (container.scrollHeight - container.clientHeight - before <= 3) return finishEnd(container,'stable_bottom');
      if (state.stopped || previous.account!==account() || frameChain.some(({child,parent,owner}) => child.parent!==parent
          || child.frameElement!==owner || !owner.isConnected || owner.ownerDocument!==parent.document
          || parent.location.origin!==page.origin)) return fail('frame_changed');
      state.scrolls++;
      container.scrollTop = Math.min(container.scrollHeight - container.clientHeight,before + Math.max(200,Math.floor(container.clientHeight * 0.8)));
      if(container.scrollTop<=before)return finishEnd(container,'scroll_did_not_move');
      state.endWait=null;state.lastAdvance={reason:'scrolled',loading:false,chosen:{tag:container.tagName,classes:String(container.className||'').slice(0,120),
        top:container.scrollTop,client:container.clientHeight,height:container.scrollHeight}};
      return {ok:true,status:'advanced',diagnostics:{last_advance:state.lastAdvance},...metadata()};
    }
    return fail('unsupported_action');
  } catch {
    return {ok:false,status:'blocked',reason:'read_failed'};
  }
}
