import {isBoss} from './capture-utils.mjs';
import {readCommunicationSnapshot} from './read-communication-snapshot.mjs';
import {chatPageAction,fetchChatAttachment} from './chat-actions.mjs';
import {readCurrentChatResume} from './chat-resume.mjs';
import {normalizeChatJobTitle} from './chat-job-matching.mjs';

const skippable=new Set(['unavailable','expired','pending','not-found','unsupported','download-blocked']);
const identityKeys=['friend_id','platform_job_id','platform_geek_id','candidate_name'];
const samePerson=(left,right)=>identityKeys.every(key=>String(left?.[key]||'')===String(right?.[key]||''));

// This controller holds one immutable, explicitly selected queue. It never
// follows a message link, selects a person by name, or sends a chat message.
export async function collectChatResumes({browser,tabId,selection,options,api,clipboard,
  check=()=>{},checkPayment,report=()=>{},onProgress=()=>{},pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  readOnline=readCurrentChatResume,downloadAttachment=fetchChatAttachment}){
  if(!selection||!Number.isSafeInteger(selection.job_id)||selection.job_id<1||
      typeof selection.account_id!=='string'||!selection.account_id.trim()||/\s|^https?:/i.test(selection.account_id))
    throw Error('请确认本地岗位和招聘账号标识。');
  const queue=(selection.conversations||[]).map(row=>({...row}));
  if(!Number.isInteger(options?.limit)||options.limit<1||options.limit>100||!queue.length||queue.length>options.limit)
    throw Error('请将勾选会话数控制在本次采集人数内，最多 100 人。');
  if(!options.attachments&&!options.online)throw Error('请至少选择附件简历或在线简历。');
  const ids=new Set(queue.map(row=>row.friend_id)),jobs=new Set(queue.map(row=>row.platform_job_id||''));
  if(ids.size!==queue.length||jobs.size!==1||jobs.has('')&&queue.length>1)
    throw Error('请重新确认同一平台岗位中的会话；岗位标识缺失时只能处理一个会话。');
  const binding=selection.job_binding;
  if(binding&&(binding.job_id!==selection.job_id||binding.account_id!==selection.account_id||
      typeof binding.platform_job_id!=='string'||!jobs.has(binding.platform_job_id)||
      normalizeChatJobTitle(binding.platform_job_title)===null))
    throw Error('自动识别的岗位与本次会话或账号不一致，请重新读取。');
  let observedJobTitle=binding?normalizeChatJobTitle(binding.platform_job_title):'';
  const assertJob=person=>{
    if(!binding)return;
    const expected=observedJobTitle,actual=normalizeChatJobTitle(person?.platform_job_title);
    if(!person||(person.platform_job_id||'')!==binding.platform_job_id||actual===null||
        expected&&actual&&expected!==actual||binding.method==='title'&&expected&&!actual)
      throw Error('当前沟通职位已变化或无法确认，已停止，未归档到其他岗位。');
    if(!observedJobTitle&&actual)observedJobTitle=actual;
  };
  const tab=await browser.tabs.get(tabId);
  if(!isBoss(tab?.url))throw Error('目标 BOSS 页面已关闭。');
  const originPath=value=>{const url=new URL(value);return url.origin+url.pathname;};
  const tabPath=originPath(tab.url);
  let frame=null;
  const guard=async()=>{
    check();
    const fresh=await browser.tabs.get(tabId);
    if(!fresh.active||fresh.discarded||!isBoss(fresh.url)||originPath(fresh.url)!==tabPath)
      throw Error('BOSS 沟通标签页已切换、休眠或离开原页面，采集已停止。');
    check();return fresh;
  };
  const read=async(history=false)=>{
    await guard();
    const result=await readCommunicationSnapshot({browser,tabId,frame,history,check});
    frame=result.frame;
    await guard();
    return result.snapshot;
  };
  const action=async(args)=>{
    await guard();
    if(checkPayment)await checkPayment();
    const rows=await browser.scripting.executeScript({target:{tabId,documentIds:[frame.documentId]},
      world:'MAIN',func:chatPageAction,args:[args]});
    check();
    if(rows.length!==1||rows[0].documentId!==frame.documentId||!rows[0].result)
      throw Error('沟通页面已关闭或更换，未继续操作。');
    const result=rows[0].result;
    if(!result.ok&&!skippable.has(result.status))throw Error(result.error||'聊天身份或操作目标无法确认，采集已停止。');
    return result;
  };
  const summaries=[];
  for(const person of queue){
    check();report(`正在打开 ${person.candidate_name} 的聊天…`);
    let snapshot=await read();
    const listed=snapshot.conversations.filter(row=>row.friend_id===person.friend_id);
    if(listed.length!==1||!samePerson(listed[0],person))throw Error('会话列表身份或岗位已变化，请重新读取后选择。');
    const switching=snapshot.selected_friend_id!==person.friend_id;
    if(switching){
      const opened=await action({action:'open-chat',...person,snapshot});
      if(!opened.ok)throw Error(opened.error||'未能打开选中的聊天。');
    }
    let matched=false,settlingKey='';
    for(let attempt=0;attempt<25;attempt++){
      try{snapshot=await read();}
      catch(error){
        if(switching&&attempt<24&&/会话标识不一致|消息归属与当前候选人不一致|当前聊天没有匹配的已加载候选人会话|消息原始会话标识属于另一位候选人|可见消息节点属于另一位候选人|沟通职位标识不一致|页面未提供对应关系|当前聊天显示了不同的沟通职位名称|沟通职位标题属于另一位候选人|沟通职位标题与当前会话不一致|同一会话对应了不同沟通职位/.test(error.message)){
          await pause(200);continue;
        }
        throw error;
      }
      const current=snapshot.conversations.find(row=>row.friend_id===person.friend_id);
      if(current&&!samePerson(current,person))throw Error('会话身份已更新，未读取其他候选人的简历。');
      if(snapshot.selected_friend_id===person.friend_id&&current){
        const key=JSON.stringify(snapshot.messages.map(message=>[message.message_id,message.direction,message.kind,message.attachment_status,message.text?.length]));
        if(!switching||key===settlingKey){matched=true;break;}
        settlingKey=key;
      }
      await pause(200);
    }
    if(!matched)throw Error('聊天尚未切换到选中候选人，请等待加载后重试。');
    snapshot=await read(options.attachments);
    if(snapshot.selected_friend_id!==person.friend_id||!samePerson(snapshot.conversations.find(row=>row.friend_id===person.friend_id),person))
      throw Error('当前聊天或候选人已切换，采集已停止。');
    assertJob(snapshot.conversations.find(row=>row.friend_id===person.friend_id));
    const verifiedAttachment=snapshot.messages.some(message=>message.friend_id===person.friend_id&&
      message.kind==='attachment'&&message.direction==='incoming'&&message.attachment_status==='received');
    if(options.attachments&&snapshot.message_capture?.unresolved_attachments>0&&
        !(snapshot.message_capture.history_loaded&&verifiedAttachment))
      throw Error('页面可见附件，但尚未确认其消息标识或归属，已暂停，未下载或标记为“没有附件”。');
    const assertConversation=async()=>{
      const fresh=await read(options.attachments),current=fresh.conversations.find(row=>row.friend_id===person.friend_id);
      if(fresh.selected_friend_id!==person.friend_id||!samePerson(current,person))
        throw Error('当前聊天或候选人已切换，采集已停止。');
      assertJob(current);
      return fresh;
    };
    const summary={friend_id:person.friend_id,name:person.candidate_name,attachments:0,online:0,resumes:[],issues:[]};
    if(options.attachments&&snapshot.message_capture?.unresolved_attachments>0)
      summary.issues.push('部分可见附件卡片尚未关联，本次仅处理当前会话记录中已核验的简历消息。');
    onProgress(summary);
    const imported=await api('/api/communications/import',{job_id:selection.job_id,account_id:selection.account_id,
      account_name:selection.account_name||'',conversations:[person],
      messages:snapshot.messages.filter(message=>message.friend_id===person.friend_id)});
    check();await assertConversation();
    if(!imported||imported.conversation_count!==1)throw Error('工作台未确认当前会话导入。');
    const list=await api('/api/communications/list',{job_id:selection.job_id});
    const matches=(list.conversations||[]).filter(row=>row.account_id===selection.account_id&&
      row.friend_id===person.friend_id&&row.job_id===selection.job_id);
    if(matches.length!==1)throw Error('工作台会话归属不唯一，未保存简历。');
    const conversationId=matches[0].id;
    let detail=await api('/api/communications/detail',{id:conversationId});
    check();
    const recordSource=async(payload)=>{
      await assertConversation();
      const saved=await api('/api/communications/resume',{conversation_id:conversationId,evaluate:options.evaluate,...payload});
      check();
      if(!Number.isSafeInteger(saved.resume?.id)||saved.resume.id<1)throw Error('工作台未确认简历原文保存。');
      summary.resumes.push(saved.resume);
      if(saved.binding_warning)summary.issues.push(saved.binding_warning);
      if(saved.resume.binding_warning)summary.issues.push(saved.resume.binding_warning);
      if(saved.resume.error)summary.issues.push('原文已保存，评估待重试：'+saved.resume.error);
      return saved;
    };
    if(options.attachments){
      const incoming=snapshot.messages.filter(message=>message.friend_id===person.friend_id&&
        message.kind==='attachment'&&message.direction==='incoming');
      for(const message of incoming){
        check();
        if(message.attachment_status!=='received'){
          summary.issues.push(`${message.attachment_name}：${message.attachment_status==='expired'?'已过期':'尚未确认收到'}，未获取`);continue;
        }
        const local=(detail.messages||[]).filter(row=>row.message_id===message.message_id);
        if(local.length!==1)throw Error('附件消息与工作台记录不一致，未下载。');
        let attachment=local[0].attachment;
        if(!attachment){
          snapshot=await assertConversation();
          report(`正在获取 ${person.candidate_name} 已收到的附件…`);
          const planned=await action({action:'attachment-fetch',...person,message_id:message.message_id,snapshot});
          if(!planned.ok){summary.issues.push(planned.error||'附件当前不可下载');continue;}
          if(planned.status!=='download-ready'||!planned.download)throw Error('附件下载预检没有返回有效目标。');
          await assertConversation();
          const downloaded=await downloadAttachment(planned.download,{check,expected:{...person,message_id:message.message_id}});
          await assertConversation();
          if(!downloaded.file||downloaded.file.size>5*1024*1024)throw Error('附件下载结果无效或过大。');
          const result=await api('/api/communications/attachment',{conversation_id:conversationId,message_id:local[0].id,
            name:downloaded.file.name,content:downloaded.file.content});
          check();attachment=result.attachment;
          if(!Number.isSafeInteger(attachment?.id))throw Error('工作台未确认附件原件保存。');
        }
        await recordSource({source_kind:'attachment',attachment_id:attachment.id});
        summary.attachments++;
        onProgress(summary);
      }
      if(!incoming.length)summary.issues.push('当前已加载消息中没有候选人附件');
    }
    if(options.online){
      snapshot=await assertConversation();
      report(`正在打开 ${person.candidate_name} 的在线简历…`);
      const opened=await action({action:'open-online',...person,snapshot});
      if(!opened.ok)summary.issues.push(opened.error||'当前会话没有可打开的在线简历');
      else{
        try{
          const readResult=await readOnline({browser,clipboard,tab:await guard(),expectedName:person.candidate_name,
            assertConversation,check,report,pause,
            clipboardSequence:async()=>(await api('/api/extension/clipboard-sequence',{})).sequence,
            formatResume:raw=>api('/api/extension/clipboard-preview',raw)});
          await assertConversation();
          await recordSource({source_kind:'online',candidate:readResult.candidate});
          summary.online++;
          onProgress(summary);
        }finally{
          if(opened.open_token){
            await assertConversation();
            const closed=await action({action:'close-online',...person,snapshot:await read(),open_token:opened.open_token});
            if(!closed.ok)throw Error(closed.error||'本次在线简历未能关闭，请核对后重试。');
          }
        }
      }
    }
    summary.complete=true;summaries.push(summary);onProgress(summary);
    report(`${person.candidate_name}：已归档附件 ${summary.attachments} 份、在线简历 ${summary.online} 份`);
  }
  return summaries;
}
