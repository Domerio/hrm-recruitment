import {DEFAULT_WORKBENCH_ORIGIN} from './workbench-default.mjs';
import {normalizeWorkbenchOrigin} from './workbench-connection.mjs';

export const FAVORITES_URL = 'https://www.zhipin.com/web/chat/interaction';
export const WORKBENCH_ORIGIN = DEFAULT_WORKBENCH_ORIGIN;

export function finderParameters(search, configuredOrigin = WORKBENCH_ORIGIN) {
  const params = new URLSearchParams(search);
  const rawId = params.get('candidate');
  if (rawId !== null && (!/^[1-9]\d{0,14}$/.test(rawId) || !Number.isSafeInteger(Number(rawId))))
    throw Error('候选人编号无效，请从工作台重新打开。');
  const configured = normalizeWorkbenchOrigin(configuredOrigin);
  const requested = params.has('workbench') ? normalizeWorkbenchOrigin(params.get('workbench')) : configured;
  if (requested !== configured)
    throw Error('此链接的工作台地址与插件配置不一致。请从当前工作台重新下载安装插件，再打开收藏定位。');
  const launch = params.get('launch');
  return {candidateId:rawId === null ? null : Number(rawId),
    launch:launch && /^[a-f0-9]{32}$/.test(launch) ? launch : null};
}

export function validFavoriteTarget(value, id) {
  return Boolean(value && value.matching_version === 1 && value.id === id &&
    Number.isSafeInteger(value.job_id) && value.job_id > 0 &&
    typeof value.name === 'string' && value.name.trim() && value.name.length <= 150 &&
    value.anchors && typeof value.anchors === 'object' && Array.isArray(value.evidence));
}

export function interactionUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.zhipin.com' && url.pathname.replace(/\/$/,'') === '/web/chat/interaction';
  } catch { return false; }
}

export function createFavoriteLookup({api, action, target, tabId, onProgress=()=>{},
  pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)), now=()=>Date.now()}) {
  let stopped=false, owner=null, account=null, documentToken=null, started=false,finished=false;
  const deadline=()=>now()+180000;
  const check=()=>{if(stopped)throw Error('已停止定位。');};
  async function invoke(args, allFrames=false) {
    check();
    const tab=await api.tabs.get(tabId);check();
    if(!interactionUrl(tab.url))throw Error('查找标签页已离开 BOSS 收藏入口，定位已停止。');
    const destination=allFrames?{tabId,allFrames:true}:owner?.documentId
      ?{tabId,documentIds:[owner.documentId]}:{tabId,frameIds:[owner.frameId]};
    const rows=await api.scripting.executeScript({target:destination,world:'MAIN',func:action,args:[{...args,target}]});
    check();
    return rows;
  }
  function bind(row) {
    const value=row?.result;
    if(!value || !/^[1-9]\d{0,19}$/.test(value.account_uid||'') ||
        typeof value.document_token!=='string'||!value.document_token)
      throw Error('未能确认当前招聘账号和收藏页面，请重新登录 BOSS 后再试。');
    if(account && value.account_uid!==account)throw Error('招聘账号已变化，定位已停止。');
    if(documentToken && value.document_token!==documentToken)throw Error('收藏页面已重新加载，请重新定位。');
    if(owner && (row.frameId!==owner.frameId || (owner.documentId && row.documentId!==owner.documentId)))
      throw Error('收藏页面已变化，请重新定位。');
    account=value.account_uid;documentToken=value.document_token;
    owner={frameId:row.frameId,...(row.documentId?{documentId:row.documentId}:{})};
    return value;
  }
  async function one(args) {
    const rows=await invoke(args);
    if(rows.length!==1)throw Error('未能确认唯一收藏页面，定位已停止。');
    if(!rows[0].result?.ok)throw error(rows[0].result,'候选人或页面已变化，定位已停止。');
    return bind(rows[0]);
  }
  async function notify(state,extra={},afterStop=false){
    if(stopped&&!afterStop)return;
    try{
      const tab=await api.tabs.get(tabId);
      if(!interactionUrl(tab.url)||(stopped&&!afterStop))return;
      const destination=owner?.documentId?{tabId,documentIds:[owner.documentId]}:
        owner?{tabId,frameIds:[owner.frameId]}:{tabId,allFrames:true};
      await api.scripting.executeScript({target:destination,world:'MAIN',func:action,
        args:[{action:'notify',state,...extra}]});
    }catch{/* A status notice must not authorize or prevent a candidate action. */}
  }
  function error(value, fallback) {
    // Page-derived text never becomes a control instruction or an error body.
    const fixed={wrong_section:'请在查找标签页选择「收藏牛人」，然后重新定位。',
      ambiguous:'发现多个可能对应的收藏牛人，未自动打开。请结合履历手动核对。',
      unsupported:'当前收藏列表结构暂不能识别，未自动打开。',
      changed:'收藏列表或候选人已变化，请重新定位。',
      stopped:'已停止定位。',
      invalid_token:'当前匹配凭据已失效，请重新定位。',
      account_changed:'招聘账号已变化，定位已停止。',
      detail_identity_conflict:'打开的简历与目标候选人的身份不一致，未确认定位成功。',
      detail_already_open:'收藏页已有简历打开，请先关闭该简历再定位。',
      detail_close_unavailable:'简历已核验，但无法确认唯一关闭入口。请手动关闭简历后重新定位。',
      detail_close_ambiguous:'简历已核验，但关闭入口不唯一，未自动关闭。',
      close_unavailable:'简历已核验，但无法确认唯一关闭入口。请手动关闭简历后重新定位。',
      close_obscured:'简历关闭入口被遮挡，未自动关闭。请关闭遮挡内容后重新定位。',
      detail_not_verified:'简历身份尚未核验，未确认对应收藏卡片。',
      reveal_timeout:'简历已核验，但对应收藏卡片尚未显示，请手动关闭简历后重试。',
      card_changed:'候选人卡片已变化，请重新定位。',
      card_obscured:'候选人姓名被其他内容遮挡，请关闭遮挡内容后重试。',
      unsafe_link:'候选人入口暂不能安全确认，未自动打开。',
      read_failed:'当前页面身份信息无法读取，定位已停止。'};
    return Error(fixed[value?.reason]||fixed[value?.status]||fallback);
  }
  return {
    get stopped(){return stopped;},
    stop(){
      if(stopped)return;
      stopped=true;
      if(!finished)void notify('stopped',{},true);
      if(owner)void api.scripting.executeScript({target:owner.documentId
        ?{tabId,documentIds:[owner.documentId]}:{tabId,frameIds:[owner.frameId]},world:'MAIN',
        func:action,args:[{action:'stop',target}]}).catch(()=>{});
    },
    async run(){
      if(started)throw Error('此定位任务已启动，请重新创建任务。');
      started=true;
      try{
        const result=await run();
        await notify(result.status==='located'?'located':result.status);check();
        finished=true;return result;
      }catch(cause){
        if(!stopped)await notify('failed');
        finished=true;throw cause;
      }
    },
  };
  async function run(){
      const until=deadline();
      for(let attempt=0;attempt<20;attempt++){
        const tab=await api.tabs.get(tabId);check();
        if(interactionUrl(tab.url))break;
        if(!interactionUrl(tab.pendingUrl)||attempt===19)throw Error('查找标签页尚未显示 BOSS 收藏入口，请确认已登录后重试。');
        await pause(250);check();
      }
      await invoke({action:'reset'},true);
      await notify('loading');check();
      let scan=null,wrongSection=false;
      for(let retry=0;retry<20;retry++){
        const rows=await invoke({action:'scan'},true);
        for(const row of rows)if(row.result?.diagnostics)onProgress({phase:'diagnostics',
          text:'正在检查收藏页面…',diagnostics:row.result.diagnostics});
        const found=rows.filter(row=>row.result?.is_favorites===true);
        if(found.length>1)throw Error('检测到多个收藏列表，未自动定位。');
        wrongSection=rows.some(row=>row.result?.status==='wrong_section');
        const openDetail=rows.find(row=>row.result?.reason==='detail_already_open');
        if(openDetail)throw error(openDetail.result);
        if(found.length===1){scan=bind(found[0]);if(!['loading','wrong_section'].includes(scan.status))break;}
        onProgress({phase:'loading',text:'正在等待 BOSS 收藏列表加载…'});
        await pause(500);check();
      }
      if(wrongSection&&(!scan||['loading','wrong_section'].includes(scan.status)))throw error({status:'wrong_section'});
      if(!scan||scan.status==='loading')throw Error('未找到可读取的收藏卡片。请确认 BOSS 已登录，且查找标签页已显示「收藏牛人」。');
      for(let batch=1;batch<=100&&now()<until;batch++){
        check();
        onProgress({phase:'scanning',batch,diagnostics:scan.diagnostics,
          text:`正在核对第 ${batch} 批收藏卡片（当前读取 ${Number.isInteger(scan.count)?scan.count:0} 张）…`});
        await notify('scanning',{batch,count:Number.isInteger(scan.count)?scan.count:0});check();
        if(!scan.ok || ['ambiguous','wrong_section','unsupported','changed','stopped'].includes(scan.status))
          throw error(scan,'未能核验收藏列表，定位已停止。');
        if(scan.status==='match'){
          if(typeof scan.token!=='string'||!scan.token)throw Error('匹配凭据无效，未打开候选人。');
          const opened=await one({action:'open',token:scan.token});
          if(!opened.ok||opened.status!=='opening')throw error(opened,'候选人已变化，未自动打开。');
          onProgress({phase:'opening',text:`已找到待核验线索（${['platform_uid','uid'].includes(scan.match?.method)?'平台 UID':
            ['platform_id','platform'].includes(scan.match?.method)?'平台标识':'职业经历'}），正在核验完整简历…`});
          await notify('verifying');check();
          for(let attempt=0;attempt<20&&now()<until;attempt++){
            await pause(500);check();
            const detail=await one({action:'status',token:scan.token});
            if(detail.status==='opened_unverified'||(detail.status==='located'&&detail.binding_verified!==true))
              return {status:'opened_unverified',tabId,match:scan.match};
            if(detail.status==='located'&&detail.binding_verified===true){
              onProgress({phase:'revealing',text:'简历身份已核验，正在返回收藏卡片并滚动高亮…'});
              await notify('revealing');check();
              let revealed=await one({action:'reveal',token:scan.token});
              for(let retry=0;revealed.status==='revealing'&&retry<20&&now()<until;retry++){
                await pause(500);check();
                revealed=await one({action:'reveal_status',token:scan.token});
              }
              if(revealed.status!=='card_located'||revealed.card_visible!==true||revealed.binding_verified!==true)
                throw error(revealed,'简历已核验，但未确认对应收藏卡片已滚动显示，定位尚未完成。');
              if(revealed.name!==detail.name||revealed.platform_geek_id!==detail.platform_geek_id||
                  (revealed.boss_chat_uid||'')!==(detail.boss_chat_uid||''))
                throw Error('返回收藏卡片时身份信息发生变化，未确认定位成功。');
              return {status:'located',card_visible:true,tabId,match:scan.match,verified:{
                name:revealed.name,account_uid:revealed.account_uid,platform_geek_id:revealed.platform_geek_id,boss_chat_uid:revealed.boss_chat_uid,
              }};
            }
            if(detail.status!=='loading')throw error(detail,'简历身份核验未通过，未确认定位成功。');
          }
          return {status:'opened_unverified',tabId,match:scan.match};
        }
        if(scan.status==='empty')return {status:'not_found',tabId};
        if(scan.status!=='scanned')throw error(scan,'收藏列表尚未准备好，请稍后重试。');
        const advanced=await one({action:'advance',signature:scan.signature});
        if(advanced.ok&&advanced.status==='end')return {status:'not_found',tabId};
        if(!advanced.ok||advanced.status!=='advanced')throw error(advanced,'收藏列表已变化，请重新定位。');
        await pause(650);check();
        scan=await one({action:'scan'});
        for(let retry=0;scan.status==='loading'&&retry<20&&now()<until;retry++){
          onProgress({phase:'loading',text:'正在等待下一批收藏卡片加载…',diagnostics:scan.diagnostics});
          await pause(500);check();scan=await one({action:'scan'});
        }
      }
      return {status:'limit',tabId};
  }
}
