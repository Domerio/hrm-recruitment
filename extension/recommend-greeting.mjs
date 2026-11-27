// Inject this function into the recommendation owner document's MAIN world.
// Only the native visible greeting button is activated. No BOSS methods, API
// requests, cookies, credentials, message bodies, or hidden controls are used.
export async function recommendGreetingAction(args = {}) {
  const errors = {
    unsupported_page:'当前页面不是 BOSS 推荐牛人页面，未发送。',
    account_missing:'未能确认当前招聘账号，未发送。',
    account_changed:'当前招聘账号与本次任务不一致，未发送。',
    invalid_identity:'缺少已核验的候选人身份，未发送。',
    detail_missing:'未找到唯一可见的候选人详情，未发送。',
    detail_changed:'候选人详情已变化，未发送。',
    identity_changed:'当前候选人与本次任务不一致，未发送。',
    source_unconfirmed:'未确认候选人的沟通来源，未发送。',
    job_unconfirmed:'未能确认本次打招呼的唯一岗位，请先在 BOSS 选择对应岗位，未发送。',
    job_changed:'当前 BOSS 沟通岗位与本次任务不一致或已经变化，未发送。',
    loading:'当前候选人详情仍在加载，未发送。',
    button_missing:'未找到唯一可见的打招呼按钮，未发送。',
    button_disabled:'当前打招呼按钮不可用或被遮挡，未发送。',
    stopped:'自动打招呼已停止，未发送。',
    token_invalid:'打招呼任务已失效，未发送。',
    token_limit:'本页打招呼记录已达上限，未发送。',
    read_failed:'未能核验当前详情和打招呼控件，未发送。',
  };
  const fail = reason => { throw {reason}; };
  const blocked = reason => ({ok:false,status:'blocked',attempted:false,
    reason:Object.hasOwn(errors,reason)?reason:'read_failed',error:errors[reason]||errors.read_failed});
  const uncertain = reason => ({ok:false,status:'uncertain',attempted:true,reason,
    error:'已触发打招呼，但未能确认结果；该任务不会再次发送。'});
  const object = value => value && typeof value === 'object' ? value : null;
  const uid = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  const encrypted = value => typeof value === 'string' && /^[A-Za-z0-9_~-]{1,160}$/.test(value) ? value : '';
  const norm = value => typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/g,'').replace(/[＊﹡∗]/g,'*') : '';
  const visible = element => {
    if (!element?.isConnected || element.hidden || element.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
    const box = element.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return false;
    for (let node=element,depth=0;node&&depth<40;node=node.parentElement,depth++) {
      const style=getComputedStyle(node);
      if (style.display==='none' || ['hidden','collapse'].includes(style.visibility)
          || String(style.opacity)==='0' || style.pointerEvents==='none') return false;
    }
    return true;
  };
  const enabled = button => !button.disabled && !button.hasAttribute('disabled')
    && button.getAttribute('aria-disabled')!=='true'
    && !['disabled','btn-gray','is-disabled'].some(value=>button.classList.contains(value));
  let state, record;
  try {
    const page = new URL(location.href);
    if (page.protocol!=='https:' || !['www.zhipin.com','zhipin.com'].includes(page.hostname)
        || !/^\/web\/(?:chat|frame|geek)\/recommend(?:\/|$)/.test(page.pathname)) fail('unsupported_page');
    const account = () => {
      const topPage=new URL(window.top.location.href);
      if (topPage.origin!==page.origin) fail('account_missing');
      const value=uid(window.top._PAGE?.uid);
      if (!value) fail('account_missing');
      return value;
    };
    if (args.action==='account') return {ok:true,status:'available',account_uid:account()};
    const stateKey='__hrmRecommendGreetingStateV1';
    state=window[stateKey];
    if (!state) {
      state={document,stopped:false,generation:0,tokens:new Map(),attempted:new Map()};
      Object.defineProperty(window,stateKey,{value:state,configurable:false});
    }
    if (state.document!==document || !(state.tokens instanceof Map) || !(state.attempted instanceof Map)) fail('read_failed');
    if (args.action==='stop') {
      state.stopped=true;state.generation++;
      for (const item of state.tokens.values()) if (!item.attempted) item.phase='revoked';
      return {ok:true,status:'stopped'};
    }
    if (args.action==='reset') {state.stopped=false;return {ok:true,status:'reset'};}
    if (!['prepare','send','status'].includes(args.action)) fail('token_invalid');
    const expected={name:norm(args.name),platform:encrypted(args.expected_platform_geek_id),
      uid:uid(args.expected_boss_chat_uid),account:uid(args.expected_account_uid),kind:args.kind,
      jobTitle:norm(args.expected_job_title)};
    if (!expected.name || expected.name.length>120 || !expected.platform || !expected.uid || !expected.account
        || !['canvas','text'].includes(expected.kind)) fail('invalid_identity');
    if (!expected.jobTitle || expected.jobTitle.length>200) fail('job_unconfirmed');
    if (args.action!=='prepare') {
      record=typeof args.token==='string'?state.tokens.get(args.token):null;
      if (!record) fail('token_invalid');
      if (['name','platform','uid','account','kind','jobTitle'].some(key=>record.expected[key]!==expected[key])) fail('identity_changed');
    }
    const inspect = () => {
      if (state.stopped || record&&record.generation!==state.generation) fail('stopped');
      if (location.href!==page.href) fail('detail_changed');
      const accountId=account();
      if (accountId!==expected.account) fail('account_changed');
      const dialogs=[...document.querySelectorAll('.dialog-lib-resume')].filter(visible);
      if (dialogs.length!==1) fail('detail_missing');
      const dialog=dialogs[0],wraps=[...dialog.querySelectorAll('.resume-detail-wrap,.resume-left')].filter(visible);
      if (!wraps.length) fail('detail_missing');
      const frames=[...dialog.querySelectorAll('.resume-detail-wrap iframe')].filter(visible);
      if (frames.length>1 || expected.kind==='canvas'&&frames.length!==1 || expected.kind==='text'&&frames.length) fail('detail_changed');
      const frame=frames[0]||null;
      if (frame) {
        const address=new URL(frame.getAttribute('src')||'',page.href);
        if (address.origin!==page.origin || address.username || address.password
            || !/^\/web\/frame\/c-resume\/?$/.test(address.pathname)) fail('detail_changed');
      }
      const visited=new Set(),roots=new Set();
      for (const seed of [dialog,...wraps,...frames]) {
        for (let node=seed,depth=0;node&&dialog.contains(node)&&depth<24;node=node.parentElement,depth++) {
          for (let current=object(node.__vue__),depth=0;current&&depth<16;current=object(current.$parent),depth++) {
            if (visited.has(current)) break;
            visited.add(current);
            const element=current.$el;
            if (current.$options?.name==='ResumeRoot' && element?.nodeType===1
                && dialog.contains(element) && visible(element)) roots.add(current);
          }
        }
      }
      const bound=[...roots].filter(root=>frame?root.$refs?.iframe===frame&&root.$el.contains(frame)
        :wraps.some(wrap=>root.$el===wrap||root.$el.contains(wrap)));
      if (bound.length!==1) fail('detail_missing');
      const root=bound[0];
      const refreshing=root.loading===true;
      if (refreshing && (!record?.attempted || expected.kind!=='canvas')) fail('loading');
      const resume=object(root.resumeInfo),base=object(resume?.geekBaseInfo);
      const current=object(root.currGeek),source=object(root.dataSource);
      const currentIds=[encrypted(current?.encryptGeekId),encrypted(source?.encryptGeekId)].filter(Boolean);
      if (!base || !currentIds.length || encrypted(base.encryptGeekId)!==expected.platform
          || currentIds.some(value=>value!==expected.platform) || uid(base.userId)!==expected.uid
          || norm(base.name)!==expected.name) fail('identity_changed');
      const sources=[base.geekSource,current?.geekSource,source?.geekSource].filter(value=>value!==undefined&&value!==null);
      if (!sources.length || sources.some(value=>value!==0&&value!=='0')) fail('source_unconfirmed');
      const ownAccount=root.utils?._PAGE?.uid;
      if (ownAccount!==undefined&&ownAccount!==null&&uid(ownAccount)!==accountId) fail('account_changed');
      if (refreshing) {
        // Canvas resumeRefresh keeps the iframe, but its !loading right-side
        // slot destroys ButtonChat. While waiting, use the original provider
        // of ButtonChat.currJob and the same root dataSource jid; never inspect
        // an unmounted button or accept a success based on stale friend flags.
        const jobOwner=object(root.param?.currJob),jobTitle=norm(jobOwner?.jobName);
        const rawJob=source?.encryptJobId||source?.jobId,job=encrypted(rawJob)||uid(rawJob);
        if (!jobOwner || jobOwner!==record.snapshot.jobOwner || !job) fail('job_unconfirmed');
        if (jobTitle!==expected.jobTitle) fail('job_changed');
        if (root.resumeInfo!==resume || root.currGeek!==current || root.dataSource!==source
            || uid(base.userId)!==expected.uid || encrypted(base.encryptGeekId)!==expected.platform
            || norm(base.name)!==expected.name || root.$refs?.iframe!==frame) fail('detail_changed');
        return {root,dialog,frame,frameSrc:frame.getAttribute('src')||'',job,jobTitle,jobOwner,
          refreshing:true,buttonChat:null,continuing:null};
      }
      const controls=[...root.$el.querySelectorAll('button')].filter(visible);
      const greet=controls.filter(button=>norm(button.textContent)==='打招呼');
      const continuing=controls.filter(button=>norm(button.textContent)==='继续沟通');
      if (greet.length+continuing.length!==1) fail('button_missing');
      // Saved official ButtonChat renders .button-chat-wrap and owns this
      // control. Never infer its job from an unrelated selector or page store.
      const button=greet[0]||continuing[0],components=new Set(),seen=new Set();
      for (let node=button,depth=0;node&&root.$el.contains(node)&&depth<24;node=node.parentElement,depth++) {
        for (let component=object(node.__vue__),parents=0;component&&parents<16;
          component=object(component.$parent),parents++) {
          if (seen.has(component)) break;
          seen.add(component);
          const element=component.$el;
          if (component.$options?.name==='ButtonChat' && element?.nodeType===1
              && element.classList.contains('button-chat-wrap') && root.$el.contains(element)
              && element.contains(button) && visible(element)) components.add(component);
        }
      }
      if (components.size!==1) fail('button_missing');
      const buttonChat=[...components][0],person=object(buttonChat.personInfo),buttonSource=object(buttonChat.dataSource);
      if (!person || !buttonSource || [person,buttonSource].some(item=>encrypted(item.encryptGeekId)!==expected.platform
          || item.geekId!=null&&uid(item.geekId)!==expected.uid
          || item.geekSource!=null&&item.geekSource!==0&&item.geekSource!=='0')) fail('identity_changed');
      const jobTitle=norm(buttonChat.currJob?.jobName);
      if (!jobTitle) fail('job_unconfirmed');
      if (jobTitle!==expected.jobTitle) fail('job_changed');
      // Ordinary status 0/1 uses chatStop's personInfo.encryptJobId || jobId.
      // Other statuses can ask for/select another job before sending. Refuse
      // those branches rather than invoking their methods or guessing a jid.
      if (![0,1].includes(buttonChat.status) || buttonChat.isPreview===true
          || buttonChat.statusModule!=null&&buttonChat.statusModule!==buttonChat.status
          || Array.isArray(buttonChat.jobSecurityList)&&buttonChat.jobSecurityList.length>1) fail('job_unconfirmed');
      const rawJob=person.encryptJobId||buttonChat.jobId;
      const job=encrypted(rawJob)||uid(rawJob);
      if (!job) fail('job_unconfirmed');
      const friend=[resume.friend,current?.isFriend,source?.isFriend,buttonChat.isFriend,
        buttonSource.isFriend].some(value=>value===true||value===1);
      if (root.resumeInfo!==resume || root.currGeek!==current || root.dataSource!==source
          || uid(base.userId)!==expected.uid || encrypted(base.encryptGeekId)!==expected.platform
          || norm(base.name)!==expected.name || frame&&root.$refs?.iframe!==frame
          || !visible(button) || buttonChat.personInfo!==person || buttonChat.dataSource!==buttonSource
          || norm(buttonChat.currJob?.jobName)!==jobTitle) fail('detail_changed');
      return {root,dialog,frame,frameSrc:frame?.getAttribute('src')||'',job,jobTitle,buttonChat,
        jobOwner:root.param?.currJob===buttonChat.currJob?object(root.param.currJob):null,
        canGreet:buttonChat.canClickGreet!==false&&buttonChat.isLoadding!==true,
        greet:greet[0]||null,continuing:continuing[0]||null,friend,
        identity:{account_uid:accountId,boss_chat_uid:expected.uid,platform_geek_id:expected.platform,
          candidate_name:base.name.slice(0,120)}};
    };
    const sameDetail = snapshot => {
      const previous=record.snapshot;
      if (snapshot.root!==previous.root || snapshot.dialog!==previous.dialog || snapshot.frame!==previous.frame
          || snapshot.frameSrc!==previous.frameSrc) fail('detail_changed');
      if (snapshot.job!==previous.job || snapshot.jobTitle!==previous.jobTitle) fail('job_changed');
      if (snapshot.refreshing) {record.awaitingRefresh=true;return;}
      if (record.awaitingRefresh) {
        if (!record.attempted || !previous.jobOwner || snapshot.jobOwner!==previous.jobOwner) fail('job_changed');
        // A single replacement is permitted only after an observed, fully
        // bound loading interval. No replacement ever authorizes another click.
        record.observedButtonChat=snapshot.buttonChat;record.awaitingRefresh=false;
      } else if (snapshot.buttonChat!==(record.observedButtonChat||previous.buttonChat)) fail('detail_changed');
    };
    const snapshot=inspect();
    const identityKey=expected.account+':'+expected.uid;
    if (args.action==='prepare') {
      if (snapshot.friend || snapshot.continuing) return {ok:true,status:'already',attempted:false,...snapshot.identity};
      if (state.attempted.has(identityKey)) return uncertain('already_attempted');
      if (!snapshot.greet) fail('button_missing');
      if (!enabled(snapshot.greet) || !snapshot.canGreet) fail('button_disabled');
      for (const [token,item] of state.tokens) {
        if (!item.attempted) state.tokens.delete(token);
      }
      if (state.tokens.size>=2048) fail('token_limit');
      const token=[...crypto.getRandomValues(new Uint32Array(4))].map(value=>value.toString(16).padStart(8,'0')).join('');
      state.tokens.set(token,{expected,snapshot,phase:'ready',attempted:false,generation:state.generation,created:Date.now()});
      return {ok:true,status:'ready',token,...snapshot.identity};
    }
    sameDetail(snapshot);
    if (record.attempted) {
      if (snapshot.continuing) {
        record.phase='confirmed';
        return {ok:true,status:'confirmed',attempted:true,...snapshot.identity};
      }
      return uncertain('already_attempted');
    }
    if (record.phase!=='ready' || record.generation!==state.generation || Date.now()-record.created>120000) fail('token_invalid');
    if (snapshot.friend || snapshot.continuing) {
      record.phase='revoked';
      return {ok:true,status:'already',attempted:false,...snapshot.identity};
    }
    if (args.action==='status') return {ok:true,status:'ready',token:args.token,...snapshot.identity};
    if (!snapshot.greet || snapshot.greet!==record.snapshot.greet) fail('detail_changed');
    if (!enabled(snapshot.greet) || !snapshot.canGreet) fail('button_disabled');
    const button=snapshot.greet,box=button.getBoundingClientRect();
    let x=(box.left+box.right)/2,y=(box.top+box.bottom)/2;
    let hit=document.elementFromPoint(x,y);
    if (!hit || !(hit===button||button.contains(hit))) fail('button_disabled');
    for (let child=window,depth=0;child!==child.top&&depth<12;child=child.parent,depth++) {
      const owner=child.frameElement;
      if (!owner || !visible(owner)) fail('button_disabled');
      const position=owner.getBoundingClientRect();x+=position.left+owner.clientLeft;y+=position.top+owner.clientTop;
      hit=child.parent.document.elementFromPoint(x,y);
      if (!hit || !(hit===owner||owner.contains(hit))) fail('button_disabled');
    }
    const finalSnapshot=inspect();sameDetail(finalSnapshot);
    if (finalSnapshot.greet!==button || !enabled(button) || !finalSnapshot.canGreet) fail('detail_changed');
    // Consume before dispatch. Any thrown click, timeout, interruption, or loss
    // of identity remains attempted; reset never removes this receipt.
    record.attempted=true;record.phase='pending';state.attempted.set(identityKey,args.token);
    button.click();
    for (let attempt=0;attempt<80;attempt++) {
      const current=inspect();sameDetail(current);
      if (current.continuing) {
        record.phase='confirmed';
        return {ok:true,status:'confirmed',attempted:true,...current.identity};
      }
      await new Promise(resolve=>setTimeout(resolve,125));
    }
    record.phase='uncertain';
    return uncertain('confirmation_timeout');
  } catch (error) {
    if (record?.attempted) {record.phase='uncertain';return uncertain(Object.hasOwn(errors,error?.reason)?error.reason:'read_failed');}
    return blocked(error?.reason);
  }
}
