// Serialized into the pinned owner document's MAIN world. Only a native,
// visible favorite control is clicked; no page methods or network APIs run.
export async function resumeFavoriteAction(args = {}) {
  const messages={
    unsupported_page:'当前页面不支持安全收藏。',invalid_identity:'缺少已确认的候选人身份，未收藏。',
    missing_uid:'当前简历未提供可确认的唯一身份，未收藏。',detail_missing:'未找到唯一的在线简历详情，未收藏。',
    detail_changed:'当前简历窗口或正文框架已变化，未收藏。',identity_changed:'当前候选人与本次复制的简历不一致，未收藏。',
    loading:'当前简历仍在加载，未收藏。',copy_unconfirmed:'未确认本次完整复制的身份，未收藏。',
    button_missing:'没有唯一可确认的收藏入口，未收藏。',button_disabled:'收藏入口不可用或被遮挡，未收藏。',
    stopped:'本次收藏任务已停止。',token_invalid:'本次收藏凭据已失效，请重新读取简历。',
    token_limit:'本页收藏记录已达上限，请人工确认。',read_failed:'无法安全核对当前简历，未收藏。',
  };
  const fail=reason=>{throw {reason};};
  const object=value=>value&&typeof value==='object'?value:null;
  const norm=value=>typeof value==='string'?value.normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/g,'').replace(/[＊﹡∗]/g,'*'):'';
  const encrypted=value=>typeof value==='string'&&/^[A-Za-z0-9_~-]{1,160}$/.test(value)?value:'';
  const uid=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)?value:
    typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):'';
  const unavailable=reason=>({ok:true,status:'unavailable',attempted:false,reason,error:messages[reason]||messages.read_failed});
  const uncertain=reason=>({ok:false,status:'uncertain',attempted:true,reason,
    error:'已尝试收藏，但未确认结果；不会再次点击，请在 BOSS 人工核对。'});
  const visible=element=>{
    if(!element?.isConnected||element.hidden||element.closest('[hidden],[aria-hidden="true"],[inert]'))return false;
    const rect=element.getBoundingClientRect();if(!(rect.width>0&&rect.height>0))return false;
    let node=element;
    for(let depth=0;node&&depth<40;node=node.parentElement,depth++){
      const style=getComputedStyle(node);
      if(style.display==='none'||['hidden','collapse'].includes(style.visibility)||String(style.opacity)==='0'||style.pointerEvents==='none')return false;
    }
    return !node;
  };
  const enabled=element=>{
    for(let node=element;node;node=node.parentElement)if(node.disabled||node.hasAttribute('disabled')||
      node.getAttribute('aria-disabled')==='true'||['disabled','btn-gray','is-disabled'].some(value=>node.classList.contains(value)))return false;
    return true;
  };
  let state,record,priorAttempted=false;
  try{
    const page=new URL(location.href);
    if(page.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(page.hostname))fail('unsupported_page');
    const stateKey='__hrmResumeFavoriteStateV1';state=window[stateKey];
    if(!state){
      state={document,generation:0,sequence:0,stopped:false,tokens:new Map(),attempted:new Map()};
      Object.defineProperty(window,stateKey,{value:state,configurable:false});
    }
    if(state.document!==document||!(state.tokens instanceof Map)||!(state.attempted instanceof Map))fail('read_failed');
    if(args.action==='stop'&&typeof args.token==='string'&&args.token){
      const target=state.tokens.get(args.token);
      if(target){target.revoked=true;target.snapshot=null;}
      return {ok:true,status:'stopped',attempted:Boolean(target?.attempted)};
    }
    if(args.action==='stop'||args.action==='reset'){
      state.generation++;state.stopped=args.action==='stop';
      // Keep lightweight attempted receipts, but do not retain old frame DOMs
      // and canvas bitmaps once the caller explicitly releases this task.
      for(const target of state.tokens.values()){target.revoked=true;target.snapshot=null;}
      return {ok:true,status:args.action==='stop'?'stopped':'reset',attempted:false};
    }
    if(!['prepare','seal','verify','click'].includes(args.action))fail('token_invalid');
    if(args.action!=='prepare'){
      record=typeof args.token==='string'?state.tokens.get(args.token):null;
      if(!record)fail('token_invalid');
    }
    const expected={name:norm(args.name),platform:encrypted(args.expected_platform_geek_id),kind:args.kind};
    if(expected.kind!=='canvas'||!expected.name||expected.name.length>120||!expected.platform){
      if(args.action==='prepare')return unavailable('invalid_identity');
      fail('invalid_identity');
    }
    if(record&&['name','platform','kind'].some(key=>record.expected[key]!==expected[key]))fail('identity_changed');
    const active=()=>{
      if(state.stopped||record&&(record.revoked||record.generation!==state.generation))fail('stopped');
    };
    const inspect=()=>{
      active();
      if(location.href!==page.href)fail('detail_changed');
      const dialogs=[...document.querySelectorAll('.dialog-lib-resume')].filter(visible);
      if(dialogs.length!==1)fail('detail_missing');
      const dialog=dialogs[0];
      if([...document.querySelectorAll('[role="dialog"],dialog[open],[aria-modal="true"],[role="alertdialog"]')]
        .some(other=>visible(other)&&other!==dialog&&!other.contains(dialog)))fail('detail_changed');
      const wraps=[...dialog.querySelectorAll('.resume-detail-wrap')].filter(visible);
      const frames=[...dialog.querySelectorAll('iframe')].filter(visible);
      if(wraps.length!==1||frames.length!==1||!wraps[0].contains(frames[0]))fail('detail_changed');
      const wrap=wraps[0],frame=frames[0],src=frame.getAttribute('src')||'';
      const address=new URL(src,page.href);
      if(address.origin!==page.origin||address.username||address.password||
        !/^\/web\/frame\/c-resume\/?$/.test(address.pathname))fail('detail_changed');
      const bodyWindow=frame.contentWindow,bodyDocument=frame.contentDocument,body=bodyDocument?.body;
      if(!bodyWindow||!bodyDocument||bodyWindow.document!==bodyDocument||!body)fail('detail_changed');
      const bodyUrl=new URL(bodyWindow.location.href).href;
      if(bodyUrl!==address.href||new URL(bodyDocument.location.href).href!==bodyUrl)fail('detail_changed');
      const canvases=[...body.querySelectorAll('canvas')].filter(visible);
      if(canvases.length!==1)fail('detail_changed');
      const visited=new Set(),roots=new Set();
      for(const seed of [dialog,wrap,frame]){
        for(let node=seed,depth=0;node&&dialog.contains(node)&&depth<24;node=node.parentElement,depth++){
          for(let vm=object(node.__vue__),parents=0;vm&&parents<16;vm=object(vm.$parent),parents++){
            if(visited.has(vm))break;visited.add(vm);
            if(vm.$options?.name==='ResumeRoot'&&vm.$el?.nodeType===1&&dialog.contains(vm.$el)&&visible(vm.$el))roots.add(vm);
          }
        }
      }
      const bound=[...roots].filter(vm=>vm.$refs?.iframe===frame&&vm.$el.contains(frame));
      if(bound.length!==1)fail('detail_missing');
      const root=bound[0],resume=object(root.resumeInfo),base=object(resume?.geekBaseInfo);
      const current=object(root.currGeek),source=object(root.dataSource);
      const currentId=encrypted(current?.encryptGeekId),sourceId=encrypted(source?.encryptGeekId);
      const selected=[currentId,sourceId].filter(Boolean);
      if(!base||!selected.length||!encrypted(base.encryptGeekId)||!norm(base.name))fail('invalid_identity');
      if(encrypted(base.encryptGeekId)!==expected.platform||selected.some(value=>value!==expected.platform)||norm(base.name)!==expected.name)
        fail('identity_changed');
      const candidateUid=uid(base.userId);
      if(!candidateUid)fail('missing_uid');
      if(record&&candidateUid!==record.uid||args.expected_boss_chat_uid!==undefined&&uid(args.expected_boss_chat_uid)!==candidateUid)
        fail('identity_changed');
      const loading=root.loading===true;
      if(loading&&!record?.attempted)fail('loading');
      if(root.resumeInfo!==resume||root.currGeek!==current||root.dataSource!==source||
        encrypted(base.encryptGeekId)!==expected.platform||uid(base.userId)!==candidateUid||norm(base.name)!==expected.name||
        encrypted(current?.encryptGeekId)!==currentId||encrypted(source?.encryptGeekId)!==sourceId||
        (root.loading===true)!==loading||
        root.$refs?.iframe!==frame||!visible(dialog)||!visible(root.$el)||!visible(frame)||
        frame.contentWindow!==bodyWindow||frame.contentDocument!==bodyDocument||bodyWindow.document!==bodyDocument)
        fail('detail_changed');
      return {root,element:root.$el,dialog,wrap,frame,src,bodyWindow,bodyDocument,body,bodyUrl,
        canvas:canvases[0],url:page.href,uid:candidateUid,loading};
    };
    const sameScope=snapshot=>{
      if(record&&['root','element','dialog','wrap','frame','src','bodyWindow','bodyDocument','body','bodyUrl','canvas','url','uid']
        .some(key=>record.snapshot[key]!==snapshot[key]))fail('detail_changed');
    };
    const identity=()=>{
      let value;try{value=JSON.parse(args.identity);}catch{fail('copy_unconfirmed');}
      if(!Array.isArray(value)||value.length!==4||value.some(part=>typeof part!=='string')||norm(value[0])!==expected.name||
        !/^\d{1,2}岁$/.test(value[1])||!/^(?:博士|硕士|本科|大专|高中|中专|初中)$/.test(value[2])||
        !/^(?:\d{1,2}年(?:以上|以下)?|应届(?:生)?)$/.test(value[3]))fail('copy_unconfirmed');
      return JSON.stringify([expected.name,...value.slice(1)]);
    };
    const ids=snapshot=>({boss_chat_uid:snapshot.uid,platform_geek_id:expected.platform,candidate_name:expected.name});
    const snapshot=inspect();sameScope(snapshot);
    if(args.action==='prepare'){
      const key=expected.platform+':'+snapshot.uid;
      priorAttempted=state.attempted.has(key);
      if(priorAttempted&&control(snapshot).status!=='saved')return uncertain('already_attempted');
      if(state.sequence>=4096||state.attempted.size>=4096)fail('token_limit');
      for(const [token,old] of state.tokens)if(!old.attempted)state.tokens.delete(token);
      const random=crypto.getRandomValues(new Uint32Array(3));
      const token=(++state.sequence).toString(16).padStart(8,'0')+[...random].map(value=>value.toString(16).padStart(8,'0')).join('');
      state.tokens.set(token,{expected,snapshot,uid:snapshot.uid,key,generation:state.generation,
        token,identity:'',phase:'prepared',attempted:false,reconcileOnly:priorAttempted,revoked:false,created:Date.now()});
      return {ok:true,status:'prepared',token,attempted:false,...ids(snapshot)};
    }
    const copiedIdentity=identity();
    if(args.action==='seal'){
      if(record.attempted||!['prepared','sealed'].includes(record.phase)||record.identity&&record.identity!==copiedIdentity)fail('copy_unconfirmed');
      sameScope(inspect());record.identity=copiedIdentity;record.phase='sealed';
      return {ok:true,status:'sealed',sealed:true,token:record.token,attempted:false,...ids(snapshot)};
    }
    if(record.identity!==copiedIdentity||!['sealed','pending','confirmed'].includes(record.phase))fail('copy_unconfirmed');
    function control(snapshot){
      const found=[];
      const readState=element=>{
        const labels=[element.textContent,element.getAttribute('aria-label'),element.getAttribute('title')]
          .map(value=>norm(value).replace(/[\uE000-\uF8FF☆★]/g,'')).filter(Boolean);
        if(!labels.length||labels.some(value=>!['收藏','已收藏','取消收藏'].includes(value)))return null;
        const saved=labels.some(value=>value!=='收藏');
        if(saved&&labels.includes('收藏'))return null;
        return saved||element.getAttribute('aria-pressed')==='true'?'saved':'available';
      };
      for(const element of snapshot.element.querySelectorAll('button,a,[role="button"],span,i,div')){
        if(!visible(element)||snapshot.wrap.contains(element)||!readState(element))continue;
        const button=element.closest('button,a,[role="button"]')||element;
        if(!snapshot.element.contains(button)||snapshot.wrap.contains(button))continue;
        const status=readState(button);if(!status)continue;
        if(!found.some(item=>item.element===button))found.push({element:button,status});
      }
      const matches=found.filter(item=>!found.some(other=>other!==item&&other.status===item.status&&item.element.contains(other.element)));
      if(matches.length!==1)fail('button_missing');
      const result=matches[0],anchor=result.element.closest('a[href]'),href=anchor?.getAttribute('href');
      if(href&&!['#','javascript:;','javascript:void(0)'].includes(href))fail('button_disabled');
      if(result.status==='available'&&!enabled(result.element))fail('button_disabled');
      return result;
    }
    const pointable=button=>{
      const rect=button.getBoundingClientRect();let x=(rect.left+rect.right)/2,y=(rect.top+rect.bottom)/2,anchor=button;
      for(let child=window,depth=0;depth<12;depth++){
        if(![x,y,child.innerWidth,child.innerHeight].every(Number.isFinite)||x<0||y<0||x>=child.innerWidth||y>=child.innerHeight)
          fail('button_disabled');
        const hit=child.document.elementFromPoint(x,y);
        if(!hit||!anchor.contains(hit))fail('button_disabled');
        if(child===child.top||child.parent===child)return;
        const frame=child.frameElement;if(!visible(frame)||frame.ownerDocument!==child.parent.document)fail('button_disabled');
        const box=frame.getBoundingClientRect();x+=box.left+frame.clientLeft;y+=box.top+frame.clientTop;anchor=frame;child=child.parent;
      }
      fail('button_disabled');
    };
    const confirmed=(already,observed)=>{
      record.phase='confirmed';record.confirmedAlready=already;
      return {ok:true,status:'confirmed',favorited:true,already,attempted:record.attempted,...ids(observed)};
    };
    if(record.attempted){
      if(!snapshot.loading&&control(snapshot).status==='saved')return confirmed(false,snapshot);
      return uncertain('already_attempted');
    }
    if(snapshot.loading)fail('loading');
    const selected=control(snapshot);pointable(selected.element);
    if(record.reconcileOnly&&selected.status!=='saved')return uncertain('already_attempted');
    const final=inspect();sameScope(final);const checked=control(final);
    if(checked.element!==selected.element||checked.status!==selected.status)fail('detail_changed');
    pointable(checked.element);sameScope(inspect());
    if(args.action==='verify')return {ok:true,status:'verified',verified:true,token:record.token,attempted:false,...ids(final)};
    if(selected.status==='saved')return confirmed(true,final);
    if(record.phase!=='sealed'||state.attempted.has(record.key))fail('token_invalid');
    // Receipt consumption and the final identity check share one synchronous
    // turn. A thrown handler or an uncertain response can never repeat a click.
    record.attempted=true;record.phase='pending';state.attempted.set(record.key,record.token);
    selected.element.click();
    for(let attempt=0;attempt<40;attempt++){
      const current=inspect();sameScope(current);
      if(!current.loading&&control(current).status==='saved')return confirmed(false,current);
      if(attempt<39)await new Promise(resolve=>setTimeout(resolve,125));
    }
    return uncertain('confirmation_timeout');
  }catch(error){
    const reason=Object.hasOwn(messages,error?.reason)?error.reason:'read_failed';
    if(record?.attempted||record?.reconcileOnly||priorAttempted)return uncertain(reason);
    if(args.action==='prepare'&&['invalid_identity','missing_uid','detail_missing','detail_changed','loading','unsupported_page'].includes(reason))
      return unavailable(reason);
    return {ok:false,status:'blocked',attempted:false,reason,error:messages[reason]};
  }
}
