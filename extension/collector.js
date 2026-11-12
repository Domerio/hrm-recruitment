import {isBoss,uniqueDetail,screenshotRect,detailFailure,withBusyState,resumeSections,resumeFoldLabels} from './capture-utils.mjs';
import {copyOpenResume} from './resume-copy.mjs';

const $=selector=>document.querySelector(selector);
const base='http://127.0.0.1:8765';
const tabId=Number(new URLSearchParams(location.search).get('tab'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const say=(text,state='running')=>{
  const status=$('#status');
  status.textContent=text;
  if(status.dataset)status.dataset.state=state;
};
const canvasTrackerId='hrm-resume-expander';
let token='',ready=false,running=false,stopped=false,reviewAction=null,wakeWait=null;

function setBusy(busy){
  $('#start').disabled=busy||!ready;
  $('#stop').disabled=!busy;
  for(const id of ['job','limit','share','ai'])$('#'+id).disabled=busy;
}

async function call(path,data){
  const options=data?{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':token},body:JSON.stringify(data)}:{};
  const response=await fetch(base+path,options);
  const result=await response.json();
  if(!response.ok){
    const error=Error(result.error||'本地工作台请求失败');
    error.code=result.code;
    throw error;
  }
  return result;
}

function check(){if(stopped)throw Error('已停止，已保存的资料保留。');}
async function waitForCandidates(){
  check();
  await new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);if(wakeWait===finish)wakeWait=null;resolve();};
    const timer=setTimeout(finish,3000);
    wakeWait=finish;
  });
  check();
}
async function guardTab(){
  check();
  const tab=await chrome.tabs.get(tabId);
  if(!tab.active||!isBoss(tab.url))throw Error('BOSS 标签页已切换或关闭。');
  return tab;
}

async function stopCanvasTracker(){
  const filter={ids:[canvasTrackerId]};
  if((await chrome.scripting.getRegisteredContentScripts(filter)).length){
    await chrome.scripting.unregisterContentScripts(filter);
  }
  await chrome.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',
    func:()=>{
      if(location.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(location.hostname)&&
          /^\/web\/frame\/c-resume\/?$/.test(location.pathname))window.__hrmExpandMarks?.stop();
    }}).catch(()=>{});
}

async function trackCanvasDuring(work){
  await stopCanvasTracker();
  await chrome.scripting.registerContentScripts([{id:canvasTrackerId,js:['canvas-expand.js'],world:'MAIN',
    matches:['https://www.zhipin.com/web/frame/c-resume*','https://zhipin.com/web/frame/c-resume*'],
    allFrames:true,runAt:'document_start',persistAcrossSessions:false}]);
  try{
    await chrome.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',files:['canvas-expand.js']});
    return await work();
  }finally{
    await stopCanvasTracker();
  }
}

async function exec(action,args={},frame){
  if(!['stop','closeShare'].includes(action))check();
  const scope=frame?(frame.documentId?{documentIds:[frame.documentId]}:{frameIds:[frame.frameId]}):{allFrames:true};
  const results=await chrome.scripting.executeScript({target:{tabId,...scope},func:async(action,args)=>{
    if(!window.__hrmAuto)return null;
    try{return {ok:true,value:await window.__hrmAuto.run(action,args)};}
    catch(error){return {ok:false,error:error.message};}
  },args:[action,args]});
  const rows=results.filter(row=>row.result).map(row=>({...row,...row.result}));
  const failure=rows.find(row=>!row.ok);
  if(failure)throw Error(failure.error);
  if(frame&&!rows.length)throw Error('当前简历的页面框架已关闭或切换。');
  return rows;
}

async function scan(){
  await guardTab();
  await chrome.scripting.executeScript({target:{tabId,allFrames:true},files:['dom-reader.js','automation.js']});
  return exec('scan');
}

function canvasDetail(frames){
  const owners=frames.filter(row=>row.value.canvasDialog),bodies=frames.filter(row=>row.value.canvasBody);
  if(owners.length>1||bodies.length>1)throw Error('检测到多个在线简历，无法安全复制。');
  if(owners.length===1&&bodies.length===1&&bodies[0].documentId)return {kind:'canvas',owner:owners[0],body:bodies[0]};
  return null;
}

async function waitDetail(name){
  let frames=[];
  for(let attempt=0;attempt<20;attempt++){
    frames=await scan();
    const text=uniqueDetail(frames),canvas=canvasDetail(frames);
    if(canvas&&text)throw Error('检测到多个在线简历，无法安全复制。');
    if(canvas)return canvas;
    if(text){
      if(text.value.detail!==name)throw Error('详情姓名与列表候选人不一致。');
      return {kind:'text',owner:text,body:text};
    }
    await delay(400);
  }
  throw Error(detailFailure(frames));
}

async function verifyDetail(target,name){
  const frames=await scan();
  const current=target.kind==='canvas'?canvasDetail(frames):uniqueDetail(frames,name);
  if(target.kind==='canvas'){
    if(!current||current.body.documentId!==target.body.documentId||current.owner.documentId!==target.owner.documentId)throw Error('当前简历已关闭或切换。');
  }else if(!current||current.documentId!==target.body.documentId){
    throw Error('当前简历已关闭或切换。');
  }
}

async function reviewCurrent(message,copy){
  say(message,'review');
  const preview=$('#review-preview');
  preview.srcdoc=copy.preview_document||'';
  preview.hidden=!copy.preview_document;
  $('#review').hidden=false;
  await new Promise(resolve=>{reviewAction=resolve;});
  reviewAction=null;
  $('#review').hidden=true;
  preview.srcdoc='';
  check();
}

function nameCheck(resume,name){
  const normalize=text=>text.replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*');
  const expected=normalize(name);
  const header=resume.split('\n').slice(0,8).map(normalize);
  const masked=header.map(line=>line.match(/^([\p{L}·]{1,20}\*{1,4})/u)?.[1]).find(Boolean);
  if(masked&&masked!==expected)throw Error('复制到的姓名与列表候选人不一致，已停止。');
  return header.some(line=>line.startsWith(expected));
}

function rawCopiedText(clipboard,preview){
  if(clipboard.resume)return clipboard.resume;
  if(clipboard.resume_html){
    const template=document.createElement('template');
    template.innerHTML=clipboard.resume_html;
    return template.content?.textContent||preview.resume;
  }
  return preview.resume;
}

function verifiedCopy(target,prepared,clipboard,preview){
  if(target.kind==='text'){
    const text=rawCopiedText(clipboard,preview).replace(/\s/g,'');
    return prepared.status==='visible_complete'&&
      prepared.sections.every(section=>resumeSections(preview.resume).includes(section))&&
      typeof prepared.contentHead==='string'&&prepared.contentHead.length>0&&
      typeof prepared.contentTail==='string'&&prepared.contentTail.length>0&&
      text.includes(prepared.contentHead)&&text.includes(prepared.contentTail)&&
      text.length>=(prepared.minimumLength||0);
  }
  const proof=clipboard.completeness;
  return Boolean(proof?.topVerified&&proof.bottomVerified&&proof.allScreensRead&&
    proof.stableBottomReads>=2&&Number.isInteger(clipboard.screens)&&clipboard.screens>=1);
}

async function collectResume(target,name){
  const frame=target.body;
  const action=(command)=>exec(command,{name},frame).then(rows=>rows[0].value);
  for(;;){
    await verifyDetail(target,name);
    let prepared,textSelection;
    say(`正在读取 ${name} 的简历…`);
    if(target.kind==='text'){
      prepared=await action('prepare-copy');
      textSelection={select:()=>action('select-copy'),focused:()=>action('copy-focused'),clear:()=>action('clear-copy')};
    }else await exec('expand-canvas',{name},target.owner);

    let clipboard;
    try{
      clipboard=await copyOpenResume({browser:chrome,clipboard:navigator.clipboard,tab:await guardTab(),
        clipboardSequence:async()=>(await call('/api/extension/clipboard-sequence',{})).sequence,
        documentId:frame.documentId,textSelection,report:message=>say(`${name}：${message}`),pause:delay,check});
    }catch(error){
      if(!/剪贴板没有收到|未确认剪贴板获得|无法读取剪贴板|展开.*重试/.test(error.message))throw error;
      const hint=/无法读取剪贴板|展开.*重试/.test(error.message)?error.message:
        '剪贴板没有收到可用正文。若 BOSS 仍显示「查看全部」，请先点击展开，再重试当前候选人。';
      await reviewCurrent(`${name}：${hint}`,{resume:'等待重新复制正文'});
      continue;
    }
    check();
    const copy=await call('/api/extension/clipboard-preview',{resume:clipboard.resume,resume_html:clipboard.resume_html});
    await verifyDetail(target,name);
    const matches=nameCheck(copy.resume,name);
    const sections=resumeSections(copy.resume);
    const folded=resumeFoldLabels(copy.resume).length||resumeFoldLabels(clipboard.resume).length;
    if(clipboard.foldIssue||folded){
      const detail=clipboard.foldIssue||'正文仍有折叠字样，未确认展开。';
      await reviewCurrent(`${name}：${detail} 请检查页面展开状态后重新读取。`,copy);
      continue;
    }
    if(clipboard.issue){
      await reviewCurrent(`${name}：${clipboard.issue} 请检查详情并重新读取。`,copy);
      continue;
    }
    const hasResumeSection=sections.length>0;
    if(!matches||!hasResumeSection||!verifiedCopy(target,prepared,clipboard,copy)){
      const reason=!matches?'复制结果未包含当前候选人姓名':
        !hasResumeSection?'未读到履历章节':'尚未确认从顶部到稳定底部的正文完整性';
      await reviewCurrent(`${name}：自动校验未通过，${reason}。请检查页面后重新读取。`,copy);
      continue;
    }
    say(`${name}：完整性校验通过，正在保存履历…`);
    return {resume:copy.resume,resume_html:copy.resume_html,name,link:'',capture:{status:'visible_complete',sections,warnings:[]}};
  }
}

async function shareImage(frame,share){
  await guardTab();
  const rect=screenshotRect(await exec('layout'),frame.frameId,share.rect);
  const tab=await guardTab();
  const url=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
  await guardTab();
  const bitmap=await createImageBitmap(await (await fetch(url)).blob());
  try{
    const scale=bitmap.width/rect.viewportWidth;
    if(Math.abs(bitmap.height/rect.viewportHeight-scale)>.05)throw Error('页面尺寸变化，无法保存二维码。');
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(rect.width*scale);canvas.height=Math.round(rect.height*scale);
    canvas.getContext('2d').drawImage(bitmap,Math.round(rect.x*scale),Math.round(rect.y*scale),canvas.width,canvas.height,0,0,canvas.width,canvas.height);
    const png=canvas.toDataURL('image/png');
    if(png.length>2800000)throw Error('二维码图片过大。');
    return png;
  }finally{bitmap.close();}
}

async function saveShareImage(target,name,id,line){
  await verifyDetail(target,name);
  say(`${name}：履历已保存，正在补充回访二维码…`);
  try{
    const share=(await exec('share',{name,kind:target.kind},target.owner))[0].value;
    const image=await shareImage(target.owner,share);
    check();const result=await call('/api/candidates/share',{id,image,status:'已保存二维码卡片'});
    if(!result.ok)throw Error('工作台没有确认保存二维码。');
    line.textContent+=' · 二维码已保存';
  }finally{await exec('closeShare',{},target.owner);}
}

async function saveCandidate(target,data,job,options,line){
  check();
  const saved=await call('/api/extension/import',{job_id:job,candidates:[data]});
  const id=saved.ids?.[0];
  if(!Number.isInteger(id)||id<1)throw Error('工作台没有确认保存候选人。');
  line.textContent=`${data.name} · #${id} · 履历已保存${data.capture.status==='needs_review'?'，待核对':''}`;
  if(options.share)await saveShareImage(target,data.name,id,line);
  if(options.ai){
    check();say(`${data.name}：正在保存岗位匹配结果…`);
    try{
      const score=await call('/api/ai/evaluate',{id});
      if(!Number.isFinite(score.score))throw Error('工作台没有确认保存匹配结果。');
      line.textContent+=` · 匹配度 ${score.score}`;
    }catch(error){
      if(!['evaluation_evidence_mismatch','evaluation_format_invalid'].includes(error.code))throw error;
      line.textContent+=error.code==='evaluation_format_invalid'
        ?' · AI 返回格式未通过校验，已记为待评估':' · AI 待评估（依据未匹配原文）';
      return {aiPending:true};
    }
  }
  return {aiPending:false};
}

async function run(){
  const job=Number($('#job').value),requested=$('#limit').value.trim();
  const limit=requested?Number(requested):Infinity;
  if(!job||requested&&(!Number.isSafeInteger(limit)||limit<1))throw Error('请选择岗位，人数请留空或填写正整数。');
  const continuous=limit===Infinity;
  const options={share:$('#share').checked,ai:$('#ai').checked};
  await chrome.storage.local.set({selectedJob:String(job)});
  $('#results').replaceChildren();
  await guardTab();
  await chrome.scripting.executeScript({target:{tabId,allFrames:true},files:['dom-reader.js','automation.js']});
  await exec('reset');
  let frames=await scan();
  if(frames.some(row=>row.value.detail||row.value.canvasDialog))throw Error('请先关闭当前简历详情，回到候选人小卡片列表。');
  const lists=frames.filter(row=>row.value.cards.length);
  if(lists.length!==1)throw Error('未找到唯一的候选人小卡片列表。');
  let list=lists[0],handled=0,aiPending=0;
  const checked=new Set(),completed=new Set(),known=new Map(),skipped=new Set();
  const summary=()=>`本次已处理 ${handled} 位候选人，跳过 ${skipped.size} 位已采集。${aiPending?` ${aiPending} 位 AI 待评估，可在工作台重试。`:''}`;
  async function loadProgress(cards){
    const signatures=new Set();
    for(const card of cards){
      if(signatures.has(card.signature))throw Error('当前列表存在无法区分的重复小卡片，请调整列表后重新开始。');
      signatures.add(card.signature);
    }
    const unchecked=cards.filter(card=>!checked.has(card.signature));
    // The workbench accepts at most 200 cards per lookup; this does not limit a run.
    for(let offset=0;offset<unchecked.length;offset+=200){
      check();
      const batch=unchecked.slice(offset,offset+200);
      const requestedSignatures=new Set(batch.map(card=>card.signature));
      const progress=await call('/api/extension/collection-status',{
        job_id:job,share:options.share,cards:batch.map(({name,signature})=>({name,signature}))
      });
      check();
      if(!Array.isArray(progress.completed)||progress.completed.some(value=>typeof value!=='string'||!requestedSignatures.has(value))){
        throw Error('工作台没有返回有效的采集记录，请重启服务后重试。');
      }
      const knownRecords=progress.known===undefined?[]:progress.known;
      if(!Array.isArray(knownRecords)||knownRecords.some(record=>!record||typeof record.signature!=='string'||
          !Number.isInteger(record.id)||record.id<1||typeof record.has_image!=='boolean')){
        throw Error('工作台没有返回有效的已保存候选人记录，请重启服务后重试。');
      }
      for(const record of knownRecords){
        if(!requestedSignatures.has(record.signature)||known.has(record.signature)){
          throw Error('工作台返回的已保存候选人记录不唯一，请重启服务后重试。');
        }
        known.set(record.signature,record);
      }
      for(const signature of progress.completed){completed.add(signature);skipped.add(signature);}
      for(const record of knownRecords){
        if(!options.share||record.has_image){completed.add(record.signature);skipped.add(record.signature);}
      }
      for(const card of batch)checked.add(card.signature);
    }
  }
  while(handled<limit){
    check();
    if(frames.some(row=>row.value.detail||row.value.canvasDialog))throw Error('列表中仍有未关闭的简历详情。');
    const currentLists=frames.filter(row=>row.value.cards.length);
    if(currentLists.length>1)throw Error('未找到唯一的候选人小卡片列表。');
    if(currentLists.length)list=currentLists[0];
    else {
      const currentFrame=frames.find(row=>row.frameId===list.frameId);
      if(!currentFrame)throw Error('候选人列表所在的页面框架已关闭。');
      list=currentFrame;
    }
    await loadProgress(list.value.cards);
    const card=list.value.cards.find(card=>!completed.has(card.signature));
    if(!card){
      if(!continuous){
        say(handled?summary():`当前已加载的 ${list.value.cards.length} 位候选人均已采集。请在 BOSS 加载其他候选人后重新开始。`,'done');
        return;
      }
      await guardTab();
      const advanced=(await exec('advance-list',{},list))[0].value;
      check();
      const action=advanced?.kind==='waiting'?'暂无新候选人，持续等待列表更新，可点击停止。':'正在加载后续候选人…';
      say(`${summary()} ${action}`);
      await waitForCandidates();
      frames=await scan();
      continue;
    }
    const saved=known.get(card.signature);
    say(`已跳过 ${skipped.size} 位已采集候选人。${saved?'正在补充二维码':'正在打开'}第 ${handled+1}${continuous?'':`/${limit}`} 位：${card.name}`);
    const freshFrames=await scan();
    const fresh=freshFrames.find(row=>row.documentId===list.documentId&&row.frameId===list.frameId);
    const matches=fresh?.value.cards.filter(item=>item.signature===card.signature)||[];
    if(!matches.length&&continuous){
      say(`${summary()} 列表已更新，正在重新定位尚未采集的候选人…`);
      frames=freshFrames;
      continue;
    }
    if(matches.length!==1)throw Error('候选人列表已更新，无法确认要打开的小卡片。');
    await exec('open',matches[0],fresh);
    const line=document.createElement('li');line.textContent=`${card.name} · 正在处理`;$('#results').append(line);
    try{
      const target=await waitDetail(card.name);
      if(saved){
        line.textContent=`${card.name} · #${saved.id} · 履历已保存`;
        await saveShareImage(target,card.name,saved.id,line);
      }else{
        const data=await collectResume(target,card.name);
        data.source_card={name:card.name,signature:card.signature};
        if((await saveCandidate(target,data,job,options,line)).aiPending)aiPending++;
      }
      completed.add(card.signature);
      handled++;
      check();
      await verifyDetail(target,card.name);
      await exec('close',{name:card.name,kind:target.kind},target.owner);
      await delay(650);
      frames=await scan();
      if(frames.some(row=>row.value.detail||row.value.canvasDialog))throw Error('详情窗口未关闭。');
    }catch(error){
      line.textContent+=` · 已暂停：${error.message}`;
      throw Error(`停在 ${card.name}，未打开下一位。${error.message}`);
    }
  }
  say(summary(),'done');
}

$('#start').addEventListener('click',async()=>{
  if(!ready||running)return;
  running=true;stopped=false;
  try{
    await withBusyState(setBusy,async()=>{
      const allowed=await chrome.permissions.request({permissions:['clipboardRead'],origins:['https://www.zhipin.com/*','https://zhipin.com/*']});
      if(!allowed)throw Error('请授权 BOSS 页面和剪贴板访问。');
      await navigator.locks.request('hrm-collector',{ifAvailable:true},async lock=>{
        if(!lock)throw Error('另一个采集窗口正在运行。');
        await guardTab();
        await trackCanvasDuring(run);
      });
    });
  }catch(error){say(error.message,stopped?'ready':'error');}
  finally{running=false;}
});

$('#review-retry').addEventListener('click',()=>reviewAction?.('retry'));
$('#stop').addEventListener('click',()=>{stopped=true;reviewAction?.('stop');wakeWait?.();say('正在停止…');});
addEventListener('beforeunload',()=>{stopped=true;reviewAction?.('stop');wakeWait?.();if(running){exec('stop').catch(()=>{});stopCanvasTracker().catch(()=>{});}});

(async()=>{
  const state=await call('/api/state');token=state.token;
  if(state.capture_version!==1||state.clipboard_sequence_version!==1||state.collection_status_version!==1)throw Error('本地工作台版本过旧，请重启工作台后重新打开采集窗口。');
  const {selectedJob}=await chrome.storage.local.get('selectedJob');
  $('#job').replaceChildren(...state.jobs.map(job=>{
    const option=document.createElement('option');option.value=job.id;option.textContent=job.title;return option;
  }));
  if(state.jobs.some(job=>String(job.id)===String(selectedJob)))$('#job').value=selectedJob;
  await guardTab();ready=true;setBusy(false);say('已连接。打开候选人列表后，点击开始采集。','ready');
})().catch(error=>say('连接失败：'+error.message,'error'));
