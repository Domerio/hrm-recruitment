import {isBoss,matchesCandidateNameLine,discoverResumeHeaderIdentity,resumeSections,resumeFoldLabels} from './capture-utils.mjs';
import {copyOpenResume} from './resume-copy.mjs';
import {createCopyViewportController,saveForegroundReadDiagnostic} from './copy-viewport.mjs';

const maximumText=100000;
const compact=value=>String(value||'').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'');
const candidateName=value=>compact(value).replace(/[＊﹡∗]/g,'*');

function previewUncertainty(value,field){
  if(value&&typeof value[field]==='boolean'){
    if(value.uncertain===undefined&&value.reason===undefined)return false;
    if(value[field]===false&&value.uncertain===true&&['budget','scope'].includes(value.reason))return true;
  }
  throw Error('未确认图片预览检查结果，已停止读取。');
}

function textKey(text){
  const normalized=typeof text==='string'?compact(text):'';
  if(!normalized||text.length>maximumText||normalized.length>maximumText)
    throw Error('当前简历正文为空或超过 100000 字符，未读取截断内容。');
  return normalized;
}

function copiedText(copy){
  if(typeof copy?.resume==='string'&&copy.resume.trim())return copy.resume;
  if(typeof copy?.resume_html!=='string'||!copy.resume_html.trim()||typeof DOMParser==='undefined')
    throw Error('剪贴板没有可确认的简历正文。');
  const document=new DOMParser().parseFromString(copy.resume_html,'text/html');
  const parts=[],blocks=/^(?:P|DIV|BR|H[1-6]|LI|TR|SECTION|ARTICLE|PRE|BLOCKQUOTE)$/;
  const walk=node=>{
    if(node.nodeType===3){parts.push(node.textContent||'');return;}
    if(/^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.nodeName))return;
    const block=blocks.test(node.nodeName);
    if(block)parts.push('\n');
    for(const child of node.childNodes||[])walk(child);
    if(block)parts.push('\n');
  };
  walk(document.body);
  return parts.join('').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).join('\n');
}

function verifyName(text,name){
  const header=text.split(/\r?\n/).filter(line=>line.trim()).slice(0,8);
  if(header.filter(line=>matchesCandidateNameLine(line,name)).length!==1)
    throw Error('简历页首姓名与当前聊天候选人不一致或不唯一，已停止读取。');
  const discovered=discoverResumeHeaderIdentity(text);
  if(discovered&&candidateName(discovered.name)!==candidateName(name))
    throw Error('简历页首身份与当前聊天候选人不一致，已停止读取。');
}

function validBinding(binding){
  if(!binding||typeof binding.ownerUrl!=='string'||typeof binding.bodyUrl!=='string'||
    !isBoss(binding.ownerUrl)||!isBoss(binding.bodyUrl))return false;
  const owner=new URL(binding.ownerUrl),body=new URL(binding.bodyUrl);
  return owner.origin===body.origin&&/^\/web\/frame\/c-resume\/?$/.test(body.pathname);
}

const pageKey=url=>{const value=new URL(url);return value.origin+value.pathname;};

function frameIdentity(row){
  return {frameId:row.frameId,documentId:row.documentId,token:row.value.token,url:row.value.frameKey,
    binding:row.value.binding||null};
}

function sameFrameIdentity(left,right){
  const a=frameIdentity(left),b=frameIdentity(right);
  return a.frameId===b.frameId&&a.documentId===b.documentId&&a.token===b.token&&a.url===b.url&&
    (!a.binding&&!b.binding||Boolean(a.binding&&b.binding&&a.binding.ownerUrl===b.binding.ownerUrl&&
      a.binding.bodyUrl===b.binding.bodyUrl));
}

// Read only the detail already opened by the caller's bound conversation.
// The caller owns opening, saving and retrying; this function never selects a card.
export async function readCurrentChatResume({browser=globalThis.chrome,clipboard=globalThis.navigator?.clipboard,
  clipboardSequence,tab,expectedName,assertConversation,check=()=>{},report=()=>{},
  pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),formatResume=async value=>value}={}){
  if(!Number.isSafeInteger(tab?.id)||tab.id<0||typeof assertConversation!=='function')
    throw Error('请先绑定当前聊天会话和 BOSS 标签页，再读取在线简历。');
  if(typeof expectedName!=='string'||!candidateName(expectedName))throw Error('当前聊天缺少可确认的候选人姓名。');
  if(typeof formatResume!=='function')throw Error('简历格式化入口无效。');
  const readLimit=12000;
  const boundedRead=async(stage,work,deadline=Date.now()+readLimit)=>{
    const expires=Math.min(deadline,Date.now()+readLimit),remaining=expires-Date.now();
    const failure=()=>Error(`${stage}等待超时，已停止读取；请确认 BOSS 页面恢复后重试。`);
    if(remaining<=0)throw failure();
    let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(function browserReadTimedOut(){reject(failure());},remaining);});
    try{
      const result=await Promise.race([work(),timeout]);
      if(Date.now()>=expires)throw failure();
      check();return result;
    }finally{clearTimeout(timer);}
  };
  let boundTabUrl=tab.url||'',target,contentKey='',copyViewport=null;
  const guard=async(deadline=Date.now()+readLimit)=>{
    check();await boundedRead('核对聊天会话',()=>assertConversation(),deadline);check();
    const current=await boundedRead('读取 BOSS 标签页',()=>browser.tabs.get(tab.id),deadline);
    if(!isBoss(current?.url)||!current.active||current.discarded||boundTabUrl&&current.url!==boundTabUrl)
      throw Error('BOSS 标签页已切换、休眠或离开当前页面，已停止读取。');
    boundTabUrl=current.url;
    check();return current;
  };
  const step=async(work,deadline)=>{await guard(deadline);const result=await work();await guard(deadline);return result;};
  const exec=async(action,args={},frame,deadline=Date.now()+readLimit)=>{
    const scope=frame?{documentIds:[frame.documentId]}:{allFrames:true};
    const request=()=>browser.scripting.executeScript({target:{tabId:tab.id,...scope},
      func:async(action,args)=>{
        if(!window.__hrmAuto)return null;
        try{return {ok:true,value:await window.__hrmAuto.run(action,args)};}
        catch(error){return {ok:false,error:error.message};}
      },args:[action,args]});
    const readStages={'scan':'检查聊天简历页面','current-detail':'核对聊天简历绑定','probe-image-preview':'检查图片预览'};
    const results=readStages[action]?await step(()=>boundedRead(readStages[action],request,deadline),deadline):await step(request);
    const rows=results.filter(row=>row.result!=null).map(row=>({...row,...row.result}));
    const failure=rows.find(row=>row.ok!==true);
    if(failure)throw Error(failure.error||'当前简历页面无法确认，已停止读取。');
    if(frame&&(rows.length!==1||rows[0].documentId!==frame.documentId||rows[0].frameId!==frame.frameId))
      throw Error('当前简历正文框架已关闭或切换。');
    return rows;
  };
  const currentDetail=async()=>{
    const deadline=Date.now()+readLimit;
    const scan=await exec('scan',{},undefined,deadline);
    if(scan.some(row=>row.value?.promotionBlocked))throw Error('当前简历被推荐弹层遮挡，已停止读取。');
    const rows=await exec('current-detail',{},undefined,deadline);
    const text=rows.filter(row=>row.value?.kind==='text'),owners=rows.filter(row=>row.value?.kind==='canvas-owner'),
      bodies=rows.filter(row=>row.value?.kind==='canvas-body');
    const pinned=row=>Number.isSafeInteger(row.frameId)&&row.frameId>=0&&typeof row.documentId==='string'&&!!row.documentId&&
      typeof row.value.token==='string'&&!!row.value.token&&isBoss(row.value.frameKey);
    if(text.length===1&&!owners.length&&!bodies.length&&pinned(text[0])&&text[0].value.name){
      if(text[0].value.binding&&(!validBinding(text[0].value.binding)||text[0].value.frameKey!==pageKey(text[0].value.binding.bodyUrl)))
        throw Error('在线简历的页面归属无法确认。');
      return {kind:'text',name:text[0].value.name,owner:text[0],body:text[0]};
    }
    if(!text.length&&owners.length===1&&bodies.length===1&&pinned(owners[0])&&pinned(bodies[0])){
      const owner=owners[0].value.binding,body=bodies[0].value.binding;
      if(validBinding(owner)&&validBinding(body)&&owner.ownerUrl===body.ownerUrl&&owner.bodyUrl===body.bodyUrl&&
        owners[0].value.frameKey===pageKey(owner.ownerUrl)&&bodies[0].value.frameKey===pageKey(body.bodyUrl))
        return {kind:'canvas',owner:owners[0],body:bodies[0]};
    }
    throw Error('请在当前聊天中打开且只保留一份在线简历，无法从背景列表确认候选人。');
  };
  const verifyTarget=async({bindContent=false}={})=>{
    const fresh=await currentDetail();
    if(fresh.kind!==target.kind||!sameFrameIdentity(fresh.owner,target.owner)||
      !sameFrameIdentity(fresh.body,target.body)||
      fresh.kind==='text'&&candidateName(fresh.name)!==candidateName(target.name))
      throw Error('当前聊天打开的简历已切换，已停止读取。');
    if(fresh.kind==='text'){
      const key=textKey(fresh.body.value.contentKey);
      if(contentKey&&key!==contentKey)throw Error('当前简历正文已变化，请重新读取。');
      if(bindContent)contentKey=key;
    }
  };
  const expandDomOnce=async()=>{
    const frames=target.owner.documentId===target.body.documentId?[target.owner]:[target.owner,target.body];
    let selected=null;
    for(const frame of frames){
      await verifyTarget();
      const prepared=(await exec('prepare-canvas-expand',{},frame))[0]?.value;
      if(!Number.isSafeInteger(prepared?.count)||prepared.count<0)
        throw Error('当前简历的展开控件信息无效，请手动检查后重试。');
      if(prepared.count!==1){
        if(prepared.token||prepared.label)throw Error('当前简历的展开凭据不一致，未继续读取。');
        if(prepared.count>1)return {clicked:false,ambiguous:true};
        continue;
      }
      if(typeof prepared.token!=='string'||!prepared.token||
          typeof prepared.label!=='string'||!prepared.label)
        throw Error('当前简历的展开控件不唯一或无法确认，请手动展开后重试。');
      if(selected)return {clicked:false,ambiguous:true};
      selected={frame,prepared};
    }
    if(!selected)return {clicked:false,ambiguous:false};
    const {frame,prepared}=selected;
    await verifyTarget();
    const result=(await exec('click-canvas-expand',{token:prepared.token},frame))[0]?.value;
    if(result?.clicked===false&&result.reason==='controls_changed'){
      await verifyTarget();
      return {clicked:false,ambiguous:true};
    }
    if(result?.clicked!==true||result.label!==prepared.label)
      throw Error('未确认本次展开操作，已停止读取，请手动检查后重试。');
    await step(()=>pause(650));
    await verifyTarget();
    return {clicked:true,ambiguous:false};
  };
  let previewDismissed=false,previewUncertain=false;
  const recoverFocus=async()=>{
    await guard();
    if(previewDismissed)return false;
    previewUncertain=false;
    const frames=target.owner.documentId===target.body.documentId?[target.owner]:[target.owner,target.body];
    for(const frame of frames){
      const probe=(await exec('probe-image-preview',{},frame))[0]?.value;
      if(previewUncertainty(probe,'present')){
        previewUncertain=true;
        if(probe.reason==='scope')await verifyTarget();
        continue;
      }
      if(!probe.present)continue;
      await verifyTarget();
      const result=(await exec('dismiss-image-preview',frame.value,frame))[0]?.value;
      if(typeof result?.dismissed!=='boolean')throw Error('未确认图片预览的关闭结果，已停止读取。');
      const uncertain=previewUncertainty(result,'dismissed');
      await verifyTarget();
      if(uncertain){previewUncertain=true;continue;}
      if(!result.dismissed)continue;
      previewDismissed=true;
      report(`${target.name}：已关闭图片预览，正在确认原简历恢复…`);
      for(let attempt=0;attempt<2;attempt++){await step(()=>pause(150));await verifyTarget();}
      return true;
    }
    return false;
  };
  const recoverCopyFocus=async()=>{
    const recovered=await recoverFocus();
    if(!previewUncertain)return recovered;
    if(target.kind==='text')throw Error('网页简历的预览检查未完成，尚未复制正文；请确认页面没有遮挡后重试。');
    return {skipExpansion:true};
  };
  const copyResume=async(expandAlreadyDone=false,skipExpansion=false)=>{
    const current=await guard();
    copyViewport??=createCopyViewportController({browser,tab:current,check});
    const result=await copyOpenResume({browser,clipboard,tab:current,documentId:target.body.documentId,
      name:target.name,singlePass:true,expandAlreadyDone,skipExpansion,recoverFocus:recoverCopyFocus,check,report,fitViewport:copyViewport.fitViewport,
      pause:async ms=>{await guard();await pause(ms);await guard();},
      clipboardSequence:clipboardSequence?()=>step(()=>clipboardSequence()):undefined,
      ...(target.kind==='text'?{textSelection:{
        select:()=>exec('select-copy',{name:target.name},target.body).then(rows=>rows[0].value),
        focused:()=>exec('copy-focused',{},target.body).then(rows=>rows[0].value),
        clear:()=>exec('clear-copy',{},target.body).then(rows=>rows[0].value),
      }}:{})});
    await guard();return result;
  };
  const collect=async()=>{
    report(`${target.name}：正在检查简历正文和图片预览…`);
    await recoverFocus();
    await verifyTarget();
    let prepared,expandAlreadyDone=false,skipExpansion=false;
    report(`${target.name}：正在检查正文展开状态…`);
    if(target.kind==='text'){
      if(previewUncertain)throw Error('网页简历的预览检查未完成，尚未复制正文；请确认页面没有遮挡后重试。');
      prepared=(await exec('prepare-copy',{name:target.name},target.body))[0].value;
      await verifyTarget({bindContent:true});
    }else if(previewUncertain)skipExpansion=true;
    else{
      const expansion=await expandDomOnce();
      expandAlreadyDone=expansion.clicked;skipExpansion=expansion.ambiguous;
    }
    if(target.kind==='text'||expandAlreadyDone)await recoverFocus();
    if(target.kind==='text'&&previewUncertain)throw Error('网页简历的预览检查未完成，尚未复制正文；请确认页面没有遮挡后重试。');
    if(previewUncertain)skipExpansion=true;
    report(`正在一次复制 ${target.name} 的在线简历快照…`);
    const copied=await copyResume(expandAlreadyDone,skipExpansion);
    await verifyTarget();
    if(copied?.issue||copied?.foldIssue){
      await saveForegroundReadDiagnostic(browser,copied.diagnostics);
      throw Error(copied.foldIssue||copied.issue);
    }
    if(copied?.selection!=='single-copy'||copied.copyCount!==1)
      throw Error('未确认本次在线简历只复制一次，请重新读取。');
    if(copied?.resume_html!==undefined&&(typeof copied.resume_html!=='string'||copied.resume_html.length>300000))
      throw Error('复制的简历富文本无效或过长，已停止读取。');
    const original=copiedText(copied),originalKey=textKey(original);
    verifyName(original,target.name);
    if(resumeFoldLabels(original).length)throw Error('简历正文仍有未展开内容，请展开后重新读取。');
    if(target.kind==='text'){
      if(prepared?.status!=='visible_complete'||!Array.isArray(prepared.sections)||!prepared.sections.length||
        !Number.isSafeInteger(prepared.minimumLength)||prepared.minimumLength<=0||
        typeof prepared.contentHead!=='string'||typeof prepared.contentTail!=='string'||
        !prepared.contentHead||!prepared.contentTail||!originalKey.includes(compact(prepared.contentHead))||
        !originalKey.includes(compact(prepared.contentTail))||originalKey.length<prepared.minimumLength)
        throw Error('未确认网页简历正文的首尾和全文完整性，请重新读取。');
    }else{
      const proof=copied.completeness;
      if(proof?.topVerified!==true||proof.bottomVerified!==true||proof.allScreensRead!==true||
        proof.stableBottomReads!==1||
        !Number.isInteger(copied.screens)||copied.screens<1)
        throw Error('未确认本次简历快照从顶部到底部的全文完整性，请重新读取。');
      const identity=discoverResumeHeaderIdentity(original);
      if(!identity||candidateName(identity.name)!==candidateName(expectedName))
        throw Error('未从本次完整简历确认与当前聊天一致的唯一姓名、年龄、学历和工作年限。');
      target.name=identity.name;
    }
    const formatted=await step(()=>formatResume({resume:copied.resume||original,resume_html:copied.resume_html||''}));
    await verifyTarget();
    const resume=formatted?.resume;
    if(textKey(resume)!==originalKey)throw Error('格式化结果与复制的完整正文不一致，已停止读取。');
    verifyName(resume,target.name);
    const sections=resumeSections(resume);
    if(!sections.length||target.kind==='text'&&!prepared.sections.every(section=>sections.includes(section)))
      throw Error('未读取到完整履历章节，请展开简历后重新读取。');
    if(resumeFoldLabels(resume).length)throw Error('格式化结果仍有折叠内容，已停止读取。');
    if(formatted.resume_html!==undefined&&(typeof formatted.resume_html!=='string'||formatted.resume_html.length>300000))
      throw Error('简历富文本无效或过长。');
    return {candidate:{name:target.name,resume,resume_html:formatted.resume_html||'',link:'',
      capture:{status:'visible_complete',sections,warnings:[]}}};
  };

  try{
    await guard();
    report('正在等待当前聊天的在线简历就绪…');
    await step(()=>boundedRead('加载聊天简历读取组件',()=>browser.scripting.executeScript({target:{tabId:tab.id,allFrames:true},files:['dom-reader.js','automation.js']})));
    await exec('reset');
    target=await currentDetail();
    if(target.kind==='canvas')target.name=expectedName.trim();
    if(candidateName(target.name)!==candidateName(expectedName))
      throw Error('在线简历姓名与当前聊天候选人不一致，不能推测遮罩姓名或关联其他候选人。');
    const result=await collect();
    await verifyTarget();await guard();
    report(`${target.name}：本次在线简历快照已确认，只复制一次；后续按这份快照评估。`);
    return {candidate:result.candidate,binding:{kind:target.kind,owner:frameIdentity(target.owner),body:frameIdentity(target.body)}};
  }catch(error){
    await saveForegroundReadDiagnostic(browser,error?.diagnostics);
    throw error;
  }finally{await copyViewport?.restore();}
}
