import {readCommunicationPage,mergeCommunicationFrames} from './communications-reader.mjs';
import {installChatMessageSource,loadChatMessageHistory} from './chat-message-source.mjs';
import {normalizeChatJobTitle} from './chat-job-matching.mjs';

// One explicit read may obtain the current conversation's recent records when
// rendered cards do not expose message IDs. All results stay in one document.
export async function readCommunicationSnapshot({browser,tabId,frame=null,history=true,check=()=>{}}){
  await browser.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',func:installChatMessageSource});
  check();
  let frames=await browser.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',func:readCommunicationPage});
  check();
  let snapshot=mergeCommunicationFrames(frames);
  const found=frames.find(row=>row.result?.ok);
  if(!found?.documentId)throw Error('无法绑定沟通页面框架，请刷新 BOSS 后重新读取。');
  if(frame&&(frame.documentId!==found.documentId||frame.frameId!==found.frameId))
    throw Error('沟通页面框架已变化，采集已停止。');
  const bound={documentId:found.documentId,frameId:found.frameId};
  const capture=snapshot.message_capture||{};
  if(history&&snapshot.selected_friend_id&&!capture.history_loaded&&
      (capture.unresolved_count>0||capture.unresolved_attachments>0||!snapshot.messages.length)){
    const friend=snapshot.selected_friend_id;
    const person=snapshot.conversations.find(row=>row.friend_id===friend);
    const target={tabId,documentIds:[bound.documentId]};
    const loaded=await browser.scripting.executeScript({target,world:'MAIN',func:loadChatMessageHistory,
      args:[{friend_id:friend,count:100}]});
    check();
    if(loaded.length!==1||loaded[0].documentId!==bound.documentId||loaded[0].frameId!==bound.frameId)
      throw Error('读取会话记录期间页面框架已变化，请重新读取。');
    const result=loaded[0].result;
    if(!result?.ok)throw Error(result?.error||'当前会话记录未能读取，请在 BOSS 核对登录与页面状态。');
    frames=await browser.scripting.executeScript({target,world:'MAIN',func:readCommunicationPage});
    check();
    snapshot=mergeCommunicationFrames(frames);
    const current=snapshot.conversations.find(row=>row.friend_id===friend);
    if(frames[0].documentId!==bound.documentId||frames[0].frameId!==bound.frameId)
      throw Error('读取会话记录期间页面框架已变化，请重新读取。');
    if(snapshot.selected_friend_id!==friend||!current||!person||
        ['friend_id','platform_job_id','platform_geek_id','candidate_name'].some(key=>(current[key]||'')!==(person[key]||'')))
      throw Error('读取会话记录期间候选人已切换，请重新读取。');
    if(person.platform_job_title&&current.platform_job_title&&
        normalizeChatJobTitle(person.platform_job_title)!==normalizeChatJobTitle(current.platform_job_title))
      throw Error('读取会话记录期间沟通职位已变化，请重新读取。');
    if(!snapshot.message_capture?.history_loaded)
      throw Error('会话记录读取后页面已变化，未使用过期结果，请重新读取。');
  }
  return {snapshot,frame:bound};
}
