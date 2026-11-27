import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import * as helpers from '../extension/capture-utils.mjs';
import * as policyHelpers from '../extension/collection-policy.mjs';
import {readRecommendChatEntry} from '../extension/recommend-chat-entry.mjs';
import {recommendGreetingAction} from '../extension/recommend-greeting.mjs';
import {isLoopbackWorkbench,assertWorkbenchPaired} from '../extension/workbench-connection.mjs';
import {isRulePrecheck} from '../extension/evaluation-result.mjs';
import {createCopyViewportController,saveForegroundReadDiagnostic} from '../extension/copy-viewport.mjs';

const origin='https://www.zhipin.com';
const cards=[{id:'0',name:'张**',signature:'一号',platform_geek_id:'100',boss_chat_uid:'98764'},
  {id:'1',name:'李**',signature:'二号',platform_geek_id:'101',boss_chat_uid:'98765'}];
const memoryBackend=()=>({entries:[],lowMarks:[],nextId:1,favorites:new Set(),greetings:new Map()});

const ipcValue=value=>Array.isArray(value)?value.map(ipcValue):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,ipcValue(value[key])])):value;

function productionDetailAdapter({preview=false,name='',alternateOrder=false}={}){
  const ownerUrl=origin+'/web/geek/recommend',bodyUrl=origin+'/web/frame/c-resume/?fixture=ipc';
  const scripts=['dom-reader.js','automation.js'].map(file=>fs.readFileSync(new URL('../extension/'+file,import.meta.url),'utf8'));
  const counts={preview:0,other:0,reads:0,dismiss:0,probes:0};
  const page=(markup,url)=>{
    const {document,HTMLElement}=parseHTML('<html><body>'+markup+'</body></html>');
    Object.defineProperties(HTMLElement.prototype,{
      getClientRects:{configurable:true,value(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];}},
      getBoundingClientRect:{configurable:true,value(){
        const r=this.matches('button')?{left:970,top:10,width:20,height:20}:
          {left:0,top:this.tagName==='IFRAME'?100:0,width:1000,height:500};
        return {...r,x:r.left,y:r.top,right:r.left+r.width,bottom:r.top+r.height};
      }},clientLeft:{configurable:true,get:()=>0},clientTop:{configurable:true,get:()=>0},
    });
    const location=new URL(url);Object.defineProperty(document,'location',{configurable:true,value:location});
    const window={document,location,innerWidth:1100,innerHeight:750};window.top=window;window.parent=window;
    const context={window,document,location,URL,innerWidth:1100,innerHeight:750,
      getComputedStyle:element=>({visibility:'visible',display:element.hidden?'none':'block',opacity:'1',pointerEvents:'auto'}),
      setTimeout:fn=>queueMicrotask(fn),clearTimeout(){}};
    document.elementFromPoint=(x,y)=>[...document.querySelectorAll('button,iframe,canvas')].find(element=>{
      const r=element.getBoundingClientRect();return !element.closest('[hidden]')&&x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom;
    })||document.body;
    for(const script of scripts)vm.runInNewContext(script,context);
    return {document,window,api:window.__hrmAuto};
  };
  const owner=page('<div class="dialog-lib-resume" role="dialog"><div class="resume-detail-wrap"><iframe src="'+bodyUrl+'"></iframe></div></div>',ownerUrl);
  const body=page((name?'<h2>'+name+'</h2><p>30岁 硕士 5年 在职-考虑机会</p>':'')+'<canvas></canvas>',bodyUrl);
  const frame=owner.document.querySelector('iframe');Object.defineProperty(frame,'contentWindow',{configurable:true,value:body.window});
  body.window.parent=owner.window;body.window.top=owner.window;body.window.frameElement=frame;
  if(preview){
    const overlay=owner.document.createElement('div');overlay.className='avatar-preview';overlay.setAttribute('role','dialog');
    overlay.innerHTML='<img alt="头像大图"><button aria-label="关闭">×</button>';
    owner.document.querySelector('.dialog-lib-resume').append(overlay);
    overlay.querySelector('button').addEventListener('click',()=>{counts.preview++;overlay.hidden=true;});
  }
  for(const current of [owner,body])current.document.body.addEventListener('click',event=>{
    if(!event.target.closest('.avatar-preview'))counts.other++;
  });
  const slots=[{frameId:0,documentId:'outer',page:owner},{frameId:8,documentId:'canvas-detail',page:body}];
  const run=async(action,args,scope)=>{
    if(action==='current-detail')counts.reads++;
    else if(action==='dismiss-image-preview')counts.dismiss++;
    else counts.probes++;
    const rows=[];
    for(const slot of slots.filter(slot=>!scope.documentIds||scope.documentIds.includes(slot.documentId))){
      // Chrome serializes plain records across worlds; deliberately reorder
      // every key on ingress and vary egress order without changing values.
      const value=await slot.page.api.run(action,ipcValue(args));
      rows.push({frameId:slot.frameId,documentId:slot.documentId,result:{ok:true,value}});
    }
    return alternateOrder&&counts.reads%2===0?JSON.parse(JSON.stringify(rows)):ipcValue(rows);
  };
  return {run,counts,owner,body};
}

async function controller({failShare=false,failImport=false,folded=false,missingScreen=false,preopened=false,
  rejectEvidence=false,invalidAiFormat=false,failAi=false,backend=memoryBackend(),batchCards=cards,includeKnown=true,knownRecords,
  incompleteProof=false,missingDomTail=false,stripFooter=false,oneSection=false,copyEvidence={},copyPreflightIssue='',
  limit='2',advancePages=[],lookupPages=[],stopOnIdle=true,stopAt='',unloadAt='',mode='foreground',lockForeground=false,active=true,
  discarded=false,backgroundIssue='',backgroundIssueCode='',backgroundFailures=[],backgroundDiagnostics,platformNotes=[],
  changingDocument=false,changeCardsOnClose=null,domIncomplete=false,failBackgroundShare=false,
  score=82,scoreBySignature={},failFavorite=false,uncertainFavorite='',failFavoriteAck=false,failScreen=false,screenReply,
  configured=true,screeningVersion=2,switchAfterScreen=false,loseScreenResponse=false,rulesBySignature={},previewResult,
  onListScan,stopOnListWait=false,promotionFrames=0,failDismiss=false,promotionAfterClose=false,openPromotion=false,
  previewFailure=false,switchAfterPreview=false,identityMismatch=false,directEntry=false,scopeMismatch=false,
  currentDetailOverride,closeCurrentError='',closeCurrentRemains=false,closeCurrentDelay=0,switchBeforeClose=false,
  canvasDomCounts={},canvasDomClickError='',canvasDomClickResult=true,canvasDomRowsOverride,
  imagePreview='',imagePreviewAt='initial',imagePreviewError='',imagePreviewReply,imagePreviewRowsOverride,
  replaceAfterPreviewDismiss=false,focusRecovery=false,reopenPreviewAtFocus=false,productionAdapter,
  imageProbeReply,imageProbeRowsOverride,hangReadAction='',detailPendingScans=0,
  paymentAt='',holdResponsePath='',hangChatRead=false,
  receiptUnavailable='',receiptChanged=false,receiptPrepareReplies=[],receiptSealReplies=[],receiptVerifyReply,receiptClickReply,stopAtReceipt='',
  fitViewportRequest=false,viewportState='normal',viewportChanged=false,copyThrownDiagnostic,
  invalidHeader=false,replaceAfterFirstCopy=false,replaceAfterPreview=false,stopAfterFirstCopy=false,
  stopDuringDiagnostic=false,changeContentAfterPreview=false,headerMismatch=false,headerActivity='',failRollback=false,
  clipboardIssueBySignature={},sharePortalTop=false,shareLayoutChangeAt=0,shareLayoutFailureAt=0,
  searchConditions,latestSearchConditions=searchConditions,searchScopeCount=1,searchFrameId=4,recommendationPage=false,
  recommendExisting=false,chatEntryVersion=1,chatUidBySignature={},chatEntryResponses=[],failChatEntry=false,chatEntryDocumentId='outer',throwChatRead=false,
  chatEntryFrameId,chatEntryRowCount=1,scanDurationMs=0,
  greetingVersion=1,greetingAccountUid='9001',greetingPreparedStatus='ready',greetingPreparedAccountUid,
  greetingPreparedIdentity={},greetingSendIdentity={},greetingSendStatus='confirmed',
  failGreetingBegin=false,loseGreetingBegin=false,failGreetingComplete=false,
  failSearch=false,inputMenuNeeded=false,inputMenuNoOpen=false,inputMenuOpensOnMove=false,
  colleagueForward=false,failColleagueToast=false,storedPolicies={},storedJob='1',collectionPolicyVersion=1,
  listPath='/web/frame/search/',tabPath,workbenchOrigin='http://127.0.0.1:8765',workbenchAllowed=true,paired=true}={}){
  const elements=new Map(),windowListeners=new Map(),events=[],posted=[],opened=[],lookupBatches=[],lines=[],requestedPermissions=[],storageWrites=[],registrations=[],scriptFiles=[],waits=[];
  const listCards=batchCards.map(card=>({...card})),listSnapshots=[],listWaits=[];
  let listScanIndex=0,closedCount=0,listDocumentId='list',closePollsRemaining=0,tabUrlOverride='',cleanupCalls=0,openedScanCount=0;
  const directResults=[],shareCrops=[],expansionCalls=[],copyOptions=[],previewCalls=[],previewProbes=[],focusRecoveries=[],detailCalls=[],recoveryDetailReads=[];
  let previewVisible=imagePreviewAt==='initial'?imagePreview:'';
  const pendingReads=[];
  const paymentMonitors=[],pendingResponses=[],actionRequests=[];let paymentDetected=false;
  const paymentMessage='检测到 BOSS VIP 购买或扫码支付页面，本轮采集已自动停止。';
  const emitPayment=()=>{paymentDetected=true;for(const monitor of paymentMonitors)if(monitor.active)monitor.onPayment();};
  const receiptActions=[],receiptStages=[];let receipt=null,receiptSequence=0;
  const windowUpdates=[],fitResults=[];let bossWindow={id:5,state:viewportState,left:60,top:40,width:900,height:740};
  const apiUrls=[],postedData=[],storageState={selectedJob:storedJob,collectionPoliciesV1:storedPolicies};
  let shareLayoutChecks=0,shareCaptures=0;
  let contentKey='fixture-original',preparedRecipient='',identityChanged=false,copyPreflightRejected=false;
  let stateReads=0, searchInputClicks=0, searchInputOpened=false;
  let chatReads=0;
  let activeAction='';
  let simulatedTime=0,scanCount=0;
  const chatExecutionScans=[];
  function element(id){
    if(!elements.has(id))elements.set(id,{value:'',textContent:'',hidden:true,disabled:false,checked:false,listeners:{},
      addEventListener(type,fn){this.listeners[type]=fn;},
      replaceChildren(){if(id==='#results')lines.length=0;},append(child){if(id==='#results')lines.push(child);}});
    return elements.get(id);
  }
  element('#job').value='1';element('#limit').value=limit;element('#share').checked=true;
  element('#start').disabled=true;element('#evaluate-current').disabled=true;
  element('#read-mode').value=mode;
  if(lockForeground)element('#read-mode').type='hidden';
  let current=preopened?listCards[0]:null,copyCount=0,registered=[],advanceCount=0,backgroundReads=0,canvasGeneration=0,favoriteToken=null;
  const canvasDocumentId=()=>changingDocument?'canvas-detail-'+canvasGeneration:'canvas-detail';
  const event=value=>{
    events.push(value);
    if(value===paymentAt)queueMicrotask(emitPayment);
    if(value===stopAt)queueMicrotask(()=>element('#stop').listeners.click());
    if(value===unloadAt)queueMicrotask(()=>windowListeners.get('beforeunload')?.());
  };
  const resumeFor=name=>`${name}\n${identityChanged?'31':'30'}岁\n硕士\n5年\n在职-考虑机会\n工作经历\n负责机器视觉软件开发和工业检测产线交付，使用 OpenCV。${oneSection?'':'\n教育经历\n虚构大学本科。'}${stripFooter?'\n平台页脚内容只用于验证原始复制覆盖范围。':''}${contentKey==='fixture-changed'?'\n新增项目内容。':''}`;
  const row=(frameId,documentId,value)=>({frameId,documentId,result:{ok:true,value}});
  const frameKey=origin+(tabPath||(recommendationPage?'/web/geek/recommend':'/web/chat/search')),bodyKey=origin+'/web/frame/c-resume/';
  const ownerFrameId=sharePortalTop?6:0,ownerFrameKey=sharePortalTop?origin+'/web/frame/recommend/':frameKey;
  const shareLayout=()=>({coordinateSpace:sharePortalTop?'top':'owner',frameKey,
    name:current.name,rect:{x:40,y:50,width:200,height:200},viewport:{width:1000,height:800}});
  function scan(){
    simulatedTime+=scanDurationMs;scanCount++;
    if(current)openedScanCount++;
    if(!current){
      const update=onListScan?.({index:listScanIndex,closed:closedCount});
      if(update?.cards)listCards.splice(0,listCards.length,...update.cards.map(card=>({...card})));
      if(update?.documentId)listDocumentId=update.documentId;
      if(update?.tabUrl)tabUrlOverride=update.tabUrl;
      listSnapshots.push({index:listScanIndex++,closed:closedCount,posted:posted.length,opened:opened.length,
        signatures:listCards.map(card=>card.signature)});
    }
    const canvas=current&&current.id!=='0';
    const outer=row(ownerFrameId,'outer',{frameKey:ownerFrameKey,detail:current&&!canvas?current.name:'',canvasDialog:canvas,cards:[]});
    const list=row(4,listDocumentId,{frameKey:origin+listPath,detail:'',cards:listCards});
    if(promotionFrames)return Array.from({length:promotionFrames},(_,index)=>row(4+index,index?'promotion-'+index:listDocumentId,
      {frameKey,detail:'',cards:[],promotionBlocked:true}));
    if(current&&detailPendingScans>0){detailPendingScans--;return [row(ownerFrameId,'outer',{frameKey:ownerFrameKey,detail:'',cards:[]}),list];}
    return canvas?[outer,list,row(8,canvasDocumentId(),{frameKey:bodyKey,detail:'',canvasBody:true,cards:[]})]:[outer,list];
  }
  const context={...helpers,...policyHelpers,readRecommendChatEntry,recommendGreetingAction,isRulePrecheck,URL,URLSearchParams,
    createCopyViewportController,saveForegroundReadDiagnostic,
    PAYMENT_STOP_MESSAGE:paymentMessage,
    createPaymentMonitor:({onPayment,onError})=>{
      const monitor={active:false,onPayment,onError};paymentMonitors.push(monitor);
      const checkNow=async()=>{if(paymentDetected){onPayment();throw Object.assign(Error(paymentMessage),{code:'payment-stop'});}};
      return {checkNow,start:async()=>{monitor.active=true;if(paymentAt==='start')paymentDetected=true;await checkNow();},
        stop:()=>{monitor.active=false;},get detected(){return paymentDetected;}};
    },
    resumeFavoriteAction(){},
    loadWorkbenchOrigin:async()=>workbenchOrigin,hasWorkbenchPermission:async()=>workbenchAllowed,isLoopbackWorkbench,assertWorkbenchPaired,
    ...(scanDurationMs?{Date:{now:()=>simulatedTime}}:{}),location:{search:'?tab=7'+(directEntry?'&mode=current':'')},
    setTimeout:(fn,ms)=>{
      if(fn.name==='browserReadTimedOut')return setTimeout(fn,hangReadAction?5:ms);
      waits.push(ms);
      if(ms===250&&element('#status').textContent.includes('重新核对重复卡片')){
        listWaits.push({posted:posted.length,opened:opened.length});
        if(stopOnListWait)queueMicrotask(()=>element('#stop').listeners.click());
      }
      return ms===3000?setTimeout(fn,10):queueMicrotask(fn);
    },clearTimeout,addEventListener(type,listener){windowListeners.set(type,listener);},
    document:{querySelector:element,createElement:tag=>tag==='canvas'?{getContext:()=>({drawImage(...args){shareCrops.push(args.slice(1,5));}}),toDataURL:()=> 'data:image/png;base64,fixture'}:{textContent:'',value:''}},
    createImageBitmap:async()=>({width:1000,height:800,close(){}}),
    navigator:{locks:{request:async(_name,_options,fn)=>fn({})},clipboard:{}},
    renderDirectEvaluation:(_element,response)=>directResults.push(response),
    readBackgroundResume:async({documentId,tab,check,identity})=>{
      check();assert.equal(documentId,canvasDocumentId());assert.equal(tab.active,active);
      event('background-read:'+current.name);
      const resume=resumeFor(current.name);
      const fault=backgroundFailures.length?backgroundFailures[Math.min(backgroundReads++,backgroundFailures.length-1)]:
        {issue:backgroundIssue,issueCode:backgroundIssueCode,diagnostics:backgroundDiagnostics};
      return {resume,resume_html:`<p>${resume}</p>`,screens:1,platformNotes,...fault,identityVerified:!!identity,
        completeness:{topVerified:true,bottomVerified:!incompleteProof,allScreensRead:!incompleteProof,stableBottomReads:incompleteProof?0:2}};
    },
    copyOpenResume:async({documentId,textSelection,name,headerOnly=false,singlePass=false,expandAlreadyDone=false,skipExpansion=false,recoverFocus,fitViewport})=>{
      copyOptions.push({documentId,headerOnly,singlePass,expandAlreadyDone,skipExpansion});
      if(headerOnly){
        assert.equal(documentId,canvasDocumentId());if(name)assert.equal(name,current.name);
        event('header-copy:'+current.name);
        const resume=invalidHeader?'工作经历\n无法确认页首身份':`${current.name}${headerActivity}\n${headerMismatch||identityMismatch&&name?'31':'30'}岁\n硕士\n5年\n在职-考虑机会`;
        return {resume,resume_html:`<p>${resume}</p>`,selection:'header',screens:1};
      }
      assert.equal(singlePass,true,'foreground collection must use the one-copy path');
      assert.equal(typeof fitViewport,'function');
      if(fitViewportRequest){fitResults.push(await fitViewport({reason:'width_clipped'}));
        if(viewportChanged)bossWindow.width=1700;}
      if(copyThrownDiagnostic)throw Object.assign(Error('简历视口不可用'),{diagnostics:copyThrownDiagnostic});
      assert.equal(typeof recoverFocus,'function');
      if(focusRecovery){
        if(imagePreviewAt==='focus'||reopenPreviewAtFocus)previewVisible=imagePreview;
        const before=detailCalls.length;
        const recovered=await recoverFocus();focusRecoveries.push(recovered);
        if(recovered?.skipExpansion===true){skipExpansion=true;copyOptions[copyOptions.length-1].skipExpansion=true;}
        recoveryDetailReads.push(detailCalls.length-before);
        if(previewVisible)throw Error('图片预览仍遮挡当前简历，已停止读取。');
      }
      if(copyPreflightIssue&&!copyPreflightRejected){
        copyPreflightRejected=true;event('copy-preflight-rejected:'+current.name);
        return {resume:'',resume_html:'',selection:'single-copy',copyCount:0,issue:copyPreflightIssue,diagnostics:copyEvidence.diagnostics};
      }
      event('copy:'+current.name);copyCount++;
      if(name)assert.equal(name,current.name);
      assert.equal(documentId,current.id==='0'?'outer':canvasDocumentId());
      if(textSelection){assert.equal(await textSelection.select(),true);await textSelection.clear();}
      const resume=invalidHeader?'工作经历\n无法确认页首身份':resumeFor(current.name).replace(current.name,current.name+headerActivity)+
        (folded&&copyCount===1?'… 查看全部 ':'');
      const discovered=!name?helpers.discoverResumeHeaderIdentity(resume):null;
      const readIssue=clipboardIssueBySignature[current.signature];
      const issue=readIssue?.issue||(missingScreen&&copyCount===1?'第 2 屏未读到剪贴板正文。':'');
      if(replaceAfterFirstCopy&&copyCount===1)canvasGeneration++;
      if(stopAfterFirstCopy&&copyCount===1)queueMicrotask(()=>element('#stop').listeners.click());
      return {resume,resume_html:`<p>${resume}</p>`,selection:'single-copy',copyCount:1,issue,
        ...(discovered?{discoveredIdentity:{...discovered,...(headerMismatch?{identity:'inconsistent-header'}:{})}}:{}),
        ...(readIssue?.issueCode?{issueCode:readIssue.issueCode}:{}),screens:1,
        completeness:{topVerified:true,bottomVerified:!incompleteProof,stableBottomReads:incompleteProof?0:1,allScreensRead:!incompleteProof},...copyEvidence};
    },
    chrome:{debugger:{attach:async()=>event('input-attach'),detach:async()=>event('input-detach'),
      sendCommand:async(_target,method,params)=>{
        assert.equal(method,'Input.dispatchMouseEvent');
        assert.equal(params.x,125);assert.equal(params.y,88);
        if(params.type==='mouseMoved'&&inputMenuOpensOnMove){searchInputOpened=true;event('input-move-open');}
        if(params.type==='mouseReleased'){searchInputClicks++;event('input-click');}
      }},runtime:{id:'a'.repeat(32)},permissions:{request:async options=>{requestedPermissions.push(options);return true;}},storage:{local:{get:async()=>storageState,set:async value=>{
      storageWrites.push(value);
      Object.assign(storageState,value);
      if(stopDuringDiagnostic&&value.lastBackgroundReadDiagnostic){element('#stop').listeners.click();await Promise.resolve();}
    }}},
      windows:{get:async()=>({...bossWindow}),update:async(id,args)=>{
        assert.equal(id,5);windowUpdates.push({...args});
        bossWindow=args.state==='maximized'?{id:5,state:'maximized',left:0,top:0,width:1920,height:1040}:{...bossWindow,...args};
        return {...bossWindow};}},
      tabs:{get:async()=>({id:7,url:tabUrlOverride||frameKey,active,discarded,windowId:5}),captureVisibleTab:async()=>{
        assert.equal(mode,'foreground','background collection must never capture the active tab');
        shareCaptures++;
        return 'data:image/png;base64,fixture';
      }},
      scripting:{getRegisteredContentScripts:async()=>registered,
        unregisterContentScripts:async()=>{registered=[];},
        registerContentScripts:async scripts=>{registered=scripts;registrations.push(...scripts.map(script=>({...script,js:Array.from(script.js)})));},
        executeScript:async request=>{
        if(request.files)scriptFiles.push(Array.from(request.files));
        if(request.world==='MAIN'&&String(request.func).includes('__hrmCanvasRender?.stop'))cleanupCalls++;
        if(request.world==='MAIN'&&request.func===context.resumeFavoriteAction){
          assert.deepEqual(Array.from(request.target.documentIds),['outer']);
          const args=request.args[0];receiptActions.push({...args});
          receiptStages.push({action:args.action,copies:copyCount,saves:backend.entries.length});
          if(args.action===stopAtReceipt)queueMicrotask(()=>element('#stop').listeners.click());
          const reply=value=>[row(ownerFrameId,'outer',value)].map(({result,...rest})=>({...rest,result:result.value}));
          if(args.action==='reset'){receipt=null;return reply({ok:true,status:'reset'});}
          if(args.action==='stop'){
            if(!args.token||receipt?.token===args.token)receipt=null;
            return reply({ok:true,status:'stopped'});
          }
          const uid=current.boss_chat_uid||chatUidBySignature[current.signature];
          const identity={platform_geek_id:current.platform_geek_id,boss_chat_uid:uid,candidate_name:current.name};
          const blocked=()=>reply({ok:false,status:'blocked',reason:'identity_conflict',error:'候选人身份已变化，未继续收藏',attempted:false});
          if(args.name!==current.name||args.expected_platform_geek_id!==current.platform_geek_id)return blocked();
          if(args.action==='prepare'){
            if(receiptPrepareReplies.length)return reply(receiptPrepareReplies.shift());
            if(receiptUnavailable||!uid)return reply({ok:true,status:'unavailable',reason:receiptUnavailable||'missing_uid',attempted:false});
            const token='snapshot-'+(++receiptSequence);favoriteToken=token;
            receipt={...identity,token,generation:canvasGeneration,identity:'',sealed:false};
            return reply({ok:true,status:'prepared',token,...identity,attempted:false});
          }
          if(!receipt||args.token!==receipt.token||receipt.generation!==canvasGeneration||
              identity.platform_geek_id!==receipt.platform_geek_id||identity.boss_chat_uid!==receipt.boss_chat_uid||
              identity.candidate_name!==receipt.candidate_name)return blocked();
          if(args.action==='seal'){
            if(receiptSealReplies.length)return reply(receiptSealReplies.shift());
            assert.equal(args.identity,helpers.resumeHeaderIdentity(resumeFor(current.name),current.name));
            receipt.identity=args.identity;receipt.sealed=true;
            return reply({ok:true,status:'sealed',sealed:true,token:receipt.token,...identity,attempted:false});
          }
          if(!receipt.sealed||args.identity!==receipt.identity||receiptChanged)return blocked();
          if(args.action==='verify')return reply(receiptVerifyReply??{ok:true,status:'verified',verified:true,token:receipt.token,...identity,attempted:false});
          assert.equal(args.action,'click');
          if(failFavorite)return reply({ok:false,status:'blocked',error:'收藏状态未确认',attempted:false});
          const already=backend.favorites.has(current.signature);
          if(!already)backend.favorites.add(current.signature);
          event((already?'favorite-existing:':'favorite:')+current.name);
          if(receiptClickReply!==undefined)return reply(receiptClickReply);
          if(uncertainFavorite==='transport')throw Error('收藏动作响应连接中断');
          if(uncertainFavorite)return reply({ok:false,status:'uncertain',error:'已点击但状态未确认',attempted:true});
          return reply({ok:true,status:'confirmed',favorited:true,already,...identity,attempted:!already});
        }
        if(request.world==='MAIN'&&request.func===recommendGreetingAction){
          const args=request.args[0],scope=Array.from(request.target.documentIds||[]);
          assert.equal(scope.length,1);
          const frameId=scope[0]===listDocumentId?4:ownerFrameId;
          const reply=result=>[{frameId,documentId:scope[0],result}];
          if(['reset','stop'].includes(args.action)){event('greeting-'+args.action+':'+scope[0]);return reply({ok:true,status:args.action});}
          if(args.action==='account'){
            assert.deepEqual(scope,[listDocumentId]);event('greeting-account');
            return reply(greetingAccountUid?{ok:true,status:'available',account_uid:greetingAccountUid}:{ok:false,status:'unavailable'});
          }
          assert.deepEqual(scope,['outer']);assert.ok(current);
          assert.equal(args.name,current.name);assert.equal(args.expected_platform_geek_id,current.platform_geek_id);
          assert.equal(args.expected_boss_chat_uid,chatUidBySignature[current.signature]);assert.equal(args.expected_account_uid,greetingAccountUid);
          assert.equal(args.expected_job_title,Number(element('#job').value)===1?'视觉工程师':'设备工程师');
          const identity={account_uid:greetingPreparedAccountUid??greetingAccountUid,boss_chat_uid:args.expected_boss_chat_uid,
            platform_geek_id:current.platform_geek_id,candidate_name:current.name};
          if(args.action==='prepare'){
            event('prepare-greeting:'+current.name);
            return reply({ok:['ready','already'].includes(greetingPreparedStatus),status:greetingPreparedStatus,
              ...identity,...greetingPreparedIdentity,...(greetingPreparedStatus==='ready'?{token:'greet-'+current.signature}:{})});
          }
          if(args.action==='send'){
            assert.equal(args.token,'greet-'+current.signature);event('send-greeting:'+current.name);
            const saved=backend.greetings.get(greetingAccountUid+'|'+args.expected_boss_chat_uid);
            assert.equal(saved?.state,'attempted');
            return reply({ok:greetingSendStatus==='confirmed',status:greetingSendStatus,...identity,...greetingSendIdentity,attempted:greetingSendStatus!=='blocked'});
          }
          throw Error('Unexpected greeting action '+args.action);
        }
        if(request.world==='MAIN'&&request.func===readRecommendChatEntry){
          assert.deepEqual(Array.from(request.target.documentIds),['outer']);
          assert.equal(request.args[0].name,current.name);
          assert.equal(request.args[0].expected_platform_geek_id,current.platform_geek_id||'');
          assert.equal(request.args[0].kind,current.id==='0'?'text':'canvas');
          event('read-chat:'+current.name);
          chatExecutionScans.push(scanCount);
          if(throwChatRead)throw Error('private-fixture-value');
          const result=chatEntryResponses[chatReads++]||
            (chatUidBySignature[current.signature]?{ok:true,status:'available',boss_chat_uid:chatUidBySignature[current.signature],
              platform_geek_id:current.platform_geek_id,candidate_name:current.name}:{ok:true,status:'unavailable'});
          const rows=Array.from({length:chatEntryRowCount},()=>({frameId:chatEntryFrameId??ownerFrameId,documentId:chatEntryDocumentId,result}));
          return hangChatRead?new Promise(resolve=>pendingReads.push(()=>resolve(rows))):rows;
        }
        if(request.files||request.world==='MAIN')return [];
        const [action,args]=request.args;
        actionRequests.push(action);
        if(action==='stop'&&String(request.func).includes('__hrmRecommendSearch')){event('recommend-stop');return [];}
        if(action==='search:reset'||action==='search:stop')return [];
        if(action==='search:inspect')return Array.from({length:recommendationPage?0:searchScopeCount},(_,index)=>row(searchFrameId+index,index?'other-search':listDocumentId,
          {supported:true,frameKey:origin+'/web/frame/search/'}));
        if(action==='inspect'&&recommendationPage)return [row(searchFrameId,listDocumentId,{supported:true,frameKey})];
        if(action==='apply'&&recommendationPage){
          assert.deepEqual(Array.from(request.target.documentIds),[listDocumentId]);
          assert.deepEqual(JSON.parse(JSON.stringify(args)),latestSearchConditions);
          event('recommend-apply');
          if(recommendExisting)return [row(searchFrameId,listDocumentId,
            {applied:true,skipped:true,summary:['已沿用页面现有的 1 项筛选']})];
          return [row(searchFrameId,listDocumentId,{applied:true,summary:['活跃度：3日内活跃']})];
        }
        if(action==='search:apply'){
          assert.deepEqual(Array.from(request.target.documentIds),[listDocumentId]);
          assert.deepEqual(JSON.parse(JSON.stringify(args)),latestSearchConditions);
          event('search-apply');
          if(inputMenuNeeded&&(!(searchInputClicks||searchInputOpened)||inputMenuNoOpen))return [{frameId:searchFrameId,documentId:listDocumentId,
            result:{ok:false,error:'未找到与字段绑定的筛选菜单：牛人活跃度',menuInputNeeded:'activity'}}];
          if(failSearch)return [{frameId:4,documentId:listDocumentId,result:{ok:false,error:'牛人活跃度选项未确认'}}];
          return [row(searchFrameId,listDocumentId,{applied:true,summary:['牛人活跃度：3日内活跃']})];
        }
        if(action==='search:entry-point'){
          assert.equal(args.key,'activity');
          return [row(searchFrameId,listDocumentId,{opened:searchInputOpened,point:{x:125,y:88},frameKey:origin+'/web/frame/search/'})];
        }
        if(current&&action===hangReadAction)return new Promise(resolve=>pendingReads.push(()=>resolve([])));
        if(action==='current-detail')detailCalls.push({opened:!!current});
        if(productionAdapter&&['current-detail','probe-image-preview','dismiss-image-preview'].includes(action))
          return productionAdapter.run(action,args,request.target);
        if(action==='scan')return scan();
        if(action==='current-detail'){
          if(promotionFrames)throw Error('热搜推荐弹层不是当前简历');
          if(closePollsRemaining>0&&!--closePollsRemaining){current=null;closedCount++;}
          const changed=rows=>currentDetailOverride?currentDetailOverride(rows):rows;
          if(!current)return changed([row(ownerFrameId,'outer',{kind:'none',name:'',token:'',binding:null,frameKey:ownerFrameKey})]);
          if(current.id==='0')return changed([row(ownerFrameId,'outer',{kind:'text',name:current.name,token:'text-'+canvasGeneration,binding:null,contentKey,frameKey:ownerFrameKey})]);
          const binding={ownerUrl:frameKey,bodyUrl:bodyKey};
          return changed([row(ownerFrameId,'outer',{kind:'canvas-owner',name:'',token:'owner-'+canvasGeneration,binding,frameKey:ownerFrameKey}),
            row(8,canvasDocumentId(),{kind:'canvas-body',token:'body-'+canvasGeneration,binding:scopeMismatch?{...binding,ownerUrl:'other'}:binding,frameKey:bodyKey})]);
        }
        if(action==='close-current'){
          assert.deepEqual(Array.from(request.target.documentIds),['outer']);
          if(switchBeforeClose)canvasGeneration++;
          if(closeCurrentError)throw Error(closeCurrentError);
          const canvas=current.id!=='0';
          if(args.token!==(canvas?'owner-':'text-')+canvasGeneration)throw Error('当前在线简历已切换，未关闭');
          assert.equal(args.kind,canvas?'canvas-owner':'text');
          assert.equal(args.name,canvas?'':current.name);
          event('close-current:'+current.name);
          if(closeCurrentDelay)closePollsRemaining=closeCurrentDelay;
          else if(!closeCurrentRemains){current=null;closedCount++;}
          return [row(ownerFrameId,'outer',{closed:true})];
        }
        if(action==='dismiss-image-preview'){
          const documentId=request.target.documentIds[0],canvas=current.id!=='0';
          const body=documentId===canvasDocumentId(),frameId=body?8:ownerFrameId;
          assert.ok(documentId==='outer'||canvas&&body);
          assert.equal(args.kind,canvas?(body?'canvas-body':'canvas-owner'):'text');
          assert.equal(args.token,(canvas?(body?'body-':'owner-'):'text-')+canvasGeneration);
          previewCalls.push({documentId,token:args.token});
          let result={dismissed:false};
          if(previewVisible===documentId){
            if(imagePreviewError)throw Error(imagePreviewError);
            result=imagePreviewReply??{dismissed:true};
            if(result.dismissed===true){
              previewVisible='';event('dismiss-image-preview:'+current.name);
              if(replaceAfterPreviewDismiss)canvasGeneration++;
            }
          }
          const rows=[row(frameId,documentId,result)];
          return imagePreviewRowsOverride?imagePreviewRowsOverride(rows):rows;
        }
        if(action==='probe-image-preview'){
          const documentId=request.target.documentIds[0],frameId=documentId===canvasDocumentId()?8:ownerFrameId;
          previewProbes.push(documentId);
          const reply=typeof imageProbeReply==='function'?imageProbeReply({documentId,visible:previewVisible,count:previewProbes.length}):imageProbeReply;
          const rows=[row(frameId,documentId,reply??{present:previewVisible===documentId})];
          return imageProbeRowsOverride?imageProbeRowsOverride(rows):rows;
        }
        if(action==='prepare-canvas-expand'){
          const documentId=request.target.documentIds[0],count=canvasDomCounts[documentId]??0;
          expansionCalls.push({action,documentId});
          const rows=[row(documentId==='outer'?ownerFrameId:8,documentId,
            {count,token:count===1?'expand-'+documentId:'',label:count===1?'展开全部3项荣誉':''})];
          return canvasDomRowsOverride?canvasDomRowsOverride(rows):rows;
        }
        if(action==='click-canvas-expand'){
          const documentId=request.target.documentIds[0];
          expansionCalls.push({action,documentId});
          assert.equal(args.token,'expand-'+documentId);
          if(canvasDomClickError)throw Error(canvasDomClickError);
          const result=typeof canvasDomClickResult==='object'?canvasDomClickResult:{clicked:canvasDomClickResult};
          if(result.clicked===true){event('dom-expand:'+current.name);
            if(imagePreviewAt==='expand')previewVisible=imagePreview;}
          return [row(documentId==='outer'?ownerFrameId:8,documentId,result)];
        }
        if(action==='dismiss-promotions'){
          assert.equal(current,null);assert.equal(promotionFrames,1);
          assert.deepEqual(Array.from(request.target.documentIds),[listDocumentId]);
          event('dismiss-promotions');
          if(!failDismiss)promotionFrames=0;
          return [row(4,listDocumentId,{dismissed:failDismiss?0:1})];
        }
        if(action==='advance-list'){
          assert.equal(current,null);
          event('advance-list');
          const next=advancePages[advanceCount++];
          if(next){listCards.splice(0,listCards.length,...next.map(card=>({...card})));return [row(4,'list',{kind:'scroll',moved:true})];}
          if(stopOnIdle)queueMicrotask(()=>element('#stop').listeners.click());
          return [row(4,'list',{kind:'waiting',moved:false})];
        }
        if(action==='layout')return sharePortalTop?[
          row(0,'top',{key:frameKey,width:1000,height:800,children:[{key:ownerFrameKey,x:120,y:80,width:800,height:650}]}),
          row(ownerFrameId,'outer',{key:ownerFrameKey,width:800,height:650,children:[]})]:
          [row(0,'outer',{key:frameKey,width:1000,height:800,children:[]})];
        if(action==='open'){
          assert.equal(current,null);
          if(activeAction==='#backfill-chat')assert.equal(registered.length,0);
          else {assert.equal(registered[0]?.runAt,'document_start');assert.equal(registered[0]?.world,'MAIN');}
          current=listCards.find(card=>card.id===args.id);canvasGeneration++;event('open:'+current.name);opened.push(current.signature);
          if(openPromotion)promotionFrames=1;
        }
        if(['prepare-copy','expand-canvas'].includes(action))events.push('expand:'+current.name);
        if(action==='read'){
          event('background-read:'+current.name);
          const resume=resumeFor(current.name);
          return [row(0,'outer',{name:current.name,resume,resume_html:`<p>${resume}</p>`,
            capture:{status:domIncomplete?'needs_review':'visible_complete',warnings:domIncomplete?['检测到动态替换内容']:[]}})];
        }
        if(action==='prepare-favorite'){
          assert.equal(args.name,current.name);
          favoriteToken='favorite-'+current.signature+'-'+canvasGeneration;
          return [row(0,'outer',{token:favoriteToken})];
        }
        if(action==='verify-favorite'){
          assert.equal(args.name,current.name);
          assert.equal(args.token,favoriteToken);
          assert.equal(args.token,'favorite-'+current.signature+'-'+canvasGeneration);
          return [row(0,'outer',{verified:true})];
        }
        if(action==='favorite'){
          assert.equal(args.name,current.name);
          assert.equal(args.token,favoriteToken);
          assert.equal(args.token,'favorite-'+current.signature+'-'+canvasGeneration);
          if(failFavorite)return [{frameId:0,documentId:'outer',result:{ok:false,error:'收藏状态未确认',favoriteAttempted:false}}];
          const already=backend.favorites.has(current.signature);
          if(!already)backend.favorites.add(current.signature);
          event((already?'favorite-existing:':'favorite:')+current.name);
          if(uncertainFavorite==='transport')throw Error('收藏动作响应连接中断');
          if(uncertainFavorite)return [{frameId:0,documentId:'outer',result:{ok:false,error:'已点击但状态未确认',favoriteAttempted:true}}];
          return [row(0,'outer',{favorited:true,already})];
        }
        if(action==='prepare-colleague'){preparedRecipient=args.recipient||'蔡女士';event('prepare-colleague:'+current.name);return [row(ownerFrameId,'outer',{token:'cai-'+current.signature,recipient:preparedRecipient})];}
        if(action==='send-colleague'){
          assert.equal(args.token,'cai-'+current.signature);event('send-colleague:'+current.name);
          if(failColleagueToast)throw Error('未见“转发成功”；请人工核对');
          return [row(ownerFrameId,'outer',{sent:true,recipient:preparedRecipient})];
        }
        if(action==='share'){event('share:'+current.name);return [row(ownerFrameId,'outer',shareLayout())];}
        if(action==='share-layout'){
          assert.deepEqual(Array.from(request.target.documentIds),['outer']);
          shareLayoutChecks++;
          if(shareLayoutChecks===shareLayoutFailureAt)throw Error('分享窗口所在页面已切换');
          const layout=shareLayout();
          if(shareLayoutChecks===shareLayoutChangeAt)layout.rect.x++;
          return [row(ownerFrameId,'outer',layout)];
        }
        if(action==='share-image'){
          if(failBackgroundShare)throw Error('当前分享卡不支持直接读取图片');
          event('background-share:'+current.name);
          return [row(0,'outer',{image:'data:image/png;base64,fixture'})];
        }
        if(action==='close'){
          event('close:'+current.name);current=null;closedCount++;
          if(promotionAfterClose)promotionFrames=1;
          if(changeCardsOnClose){listCards.splice(0,listCards.length,...changeCardsOnClose);changeCardsOnClose=null;}
        }
        if(action==='prepare-copy'){
          if(imagePreviewAt==='expand')previewVisible=imagePreview;
          const normalized=resumeFor(current.name).replace(/\s/g,'');
          return [row(0,'outer',{status:'visible_complete',sections:oneSection?['工作经历']:['工作经历','教育经历'],
            minimumLength:normalized.length,contentHead:normalized.slice(0,80),contentTail:missingDomTail?'未复制的正文末尾':normalized.slice(-80)})];
        }
        return [row(0,'outer',true)];
      }}},
    fetch:async(url,options)=>{
      if(url.startsWith('data:'))return {blob:async()=>({})};
      assert.ok(url.startsWith(workbenchOrigin+'/'),'every API request uses the configured server');
      apiUrls.push(url);
      const path=url.slice(workbenchOrigin.length);
      const data=options?.body?JSON.parse(options.body):null;
      if(data){posted.push(path);postedData.push({path,data});}
      const reply=(body,ok=true)=>({ok,json:()=>path===holdResponsePath?
        new Promise(resolve=>pendingResponses.push(()=>resolve(body))):Promise.resolve(body)});
      if(path==='/api/extension/clipboard-sequence')return reply({sequence:42});
      if(path==='/api/state')return reply({extension_ids:paired?['a'.repeat(32)]:[],token:'test',capture_version:1,clipboard_sequence_version:1,collection_status_version:1,screening_version:screeningVersion,colleague_share_version:2,direct_evaluation_version:1,collection_rollback_version:1,collection_policy_version:collectionPolicyVersion,platform_search_version:1,boss_chat_entry_version:chatEntryVersion,greeting_version:greetingVersion,configured,jobs:[{id:1,title:'视觉工程师',search_conditions:stateReads++?latestSearchConditions:searchConditions},{id:2,title:'设备工程师'}]});
      if(path==='/api/extension/collection-status'){
        const policy=policyHelpers.normalizeCollectionPolicy(data.collection_policy);
        lookupBatches.push(data.cards);
        const changed=lookupPages[lookupBatches.length-1];
        if(changed)listCards.splice(0,listCards.length,...changed.map(card=>({...card})));
        const known=data.cards.flatMap(card=>{
          const entries=backend.entries.filter(entry=>entry.job===data.job_id&&
            entry.signature===card.signature&&entry.name===card.name);
          if(entries.length!==1)return [];
          const entry=entries[0],greeting=backend.greetings.get((data.greeting_account_uid||'')+'|'+entry.boss_chat_uid);
          const currentScore=Object.hasOwn(entry,'current_score')?entry.current_score:entry.score;
          const eligible=Boolean(data.greeting_account_uid&&entry.boss_chat_uid&&entry.chat_entry_eligible!==false&&policy.greet_enabled&&!entry.ai_pending&&Number.isFinite(currentScore)&&
            currentScore>policy.save_above&&currentScore>policy.share_above);
          return [{signature:card.signature,id:entries[0].id,has_image:entries[0].share,has_chat_entry:!!entries[0].boss_chat_uid,
            chat_entry_eligible:entries[0].chat_entry_eligible!==false,
            score:Number.isFinite(currentScore)?currentScore:null,ai_pending:!!entry.ai_pending||!Number.isFinite(currentScore),
            colleague_share_score:Object.hasOwn(entry,'colleague_share_score')?entry.colleague_share_score:entry.score??null,
            greeting_eligible:eligible,greeting_state:greeting?.state||(eligible?'pending':''),
            collection_policy:entries[0].collection_policy||policyHelpers.DEFAULT_COLLECTION_POLICY,
            favorite_pending:entries[0].favorite_pending,colleague_share_state:entries[0].colleague_share_state||''}];
        });
        const completed=known.filter(entry=>!entry.favorite_pending&&(!data.share||entry.has_image)&&
          entry.colleague_share_state!=='attempted'&&
          (entry.colleague_share_state!=='pending'||!policyHelpers.policyUsesColleague(policy))).map(entry=>entry.signature);
        for(const card of data.cards)if(!known.some(entry=>entry.signature===card.signature)&&
            backend.lowMarks.some(mark=>mark.job===data.job_id&&mark.name===card.name&&mark.signature===card.signature&&
              JSON.stringify(mark.collection_policy||policyHelpers.DEFAULT_COLLECTION_POLICY)===JSON.stringify(policy))){
          completed.push(card.signature);
        }
        return reply({completed,...(includeKnown?{known:knownRecords===undefined?known:knownRecords}:{})});
      }
      if(path==='/api/extension/clipboard-preview')return reply({...data,
        resume:stripFooter?data.resume.replace('\n平台页脚内容只用于验证原始复制覆盖范围。',''):data.resume,
        preview_document:'<!doctype html><p>履历预览</p>'});
      if(path==='/api/extension/preview-resume'){
        assert.equal(data.candidate.name,current.name);
        assert.ok(!data.candidate.source_card);
        assert.equal(data.candidate.capture.status,'visible_complete');
        event('preview:'+current.name);
        const body={result:previewResult||{score,category:'待确认',summary:'合成结果',checks:[],required_checks:[],questions:[]},
          job:{id:data.job_id,title:'视觉工程师'},name:current.name,model:'fixture',saved:false};
        if(switchAfterPreview){current={...current,name:'另一位',signature:'另一个'};canvasGeneration++;}
        if(replaceAfterPreview)canvasGeneration++;
        if(changeContentAfterPreview)contentKey='fixture-changed';
        if(identityMismatch)identityChanged=true;
        return previewFailure?reply({error:'模型评估失败'},false):reply(body);
      }
      if(path==='/api/extension/screen'){
        const policy=policyHelpers.normalizeCollectionPolicy(data.collection_policy);
        if(failScreen)return reply({code:'screen_unavailable',error:'筛选服务暂不可用'},false);
        if(failImport)return reply({error:'保存履历失败'},false);
        const candidate=data.candidate;
        assert.equal(candidate.name,current.name);
        assert.equal(candidate.source_card.name,current.name);
        assert.equal(candidate.source_card.signature,current.signature);
        assert.match(candidate.resume_html,/<p>/);
        assert.ok(!Object.hasOwn(candidate,'preview_document'));
        assert.ok(favoriteToken||current.id!=='0','DOM favorite target must be bound before waiting for the model');
        const value=scoreBySignature[current.signature]??score;
        const code=failAi?'evaluation_model_failed':invalidAiFormat&&current.id==='0'?'evaluation_format_invalid':
          rejectEvidence&&current.id==='0'?'evaluation_evidence_mismatch':'';
        const message=failAi?'模型连接失败':invalidAiFormat?'AI 返回格式未通过校验':'模型依据未匹配简历原文';
        if(rulesBySignature[current.signature]){
          event('precheck:'+current.name);
          backend.lowMarks.push({job:data.job_id,name:current.name,signature:current.signature,collection_policy:policy});
          return reply({...rulesBySignature[current.signature],collection_policy:policy});
        }
        event('evaluate:'+current.name);
        if(screenReply!==undefined)return reply({...screenReply,collection_policy:screenReply.collection_policy??policy});
        if(!code&&value<=policy.save_above){
          backend.lowMarks.push({job:data.job_id,name:current.name,signature:current.signature,collection_policy:policy});
          if(loseScreenResponse)throw Error('工作台响应连接中断');
          return reply({saved:false,score:value,ai_pending:false,favorite_pending:false,collection_marked:true,collection_policy:policy});
        }
        let entry=backend.entries.find(entry=>entry.job===data.job_id&&entry.signature===current.signature);
        if(!entry){
          entry={id:backend.nextId++,job:data.job_id,name:current.name,signature:current.signature,share:false};
          backend.entries.push(entry);
        }
        entry.candidate=candidate;entry.favorite_pending=true;entry.ai_pending=Boolean(code);entry.collection_policy=policy;entry.score=code?null:value;
        if(colleagueForward&&!code&&policyHelpers.policyUsesColleague(policy)&&value>policy.share_above&&!entry.colleague_share_state)entry.colleague_share_state='pending';
        const diagnostic=code?{code,reason:message,message,validation_path:'checks[0].status'}:undefined;
        entry.diagnostic=diagnostic;
        event('save:'+current.name);
        if(loseScreenResponse)throw Error('工作台响应连接中断');
        if(switchAfterScreen){canvasGeneration++;current={...current,name:'赵**',signature:'已切换候选人'};}
        return reply({saved:true,id:entry.id,...(!code?{score:value}:{}),ai_pending:Boolean(code),diagnostic,favorite_pending:true,
          colleague_share_state:entry.colleague_share_state||'',colleague_share_score:entry.score,collection_policy:policy});
      }
      if(path==='/api/extension/chat-entry'){
        const entry=backend.entries.find(entry=>entry.id===data.id);
        assert.ok(entry);assert.equal(data.source_card.name,entry.name);assert.equal(data.source_card.signature,entry.signature);
        if(failChatEntry)return reply({error:'入口保存失败'},false);
        assert.match(data.boss_chat_uid,/^[1-9][0-9]{0,19}$/);
        entry.boss_chat_uid=data.boss_chat_uid;
        event('save-chat:'+entry.name);
        return reply({ok:true});
      }
      if(path==='/api/extension/greeting'){
        const entry=backend.entries.find(entry=>entry.id===data.id);
        assert.ok(entry);assert.equal(data.job_id,entry.job);assert.equal(data.source_card.name,entry.name);assert.equal(data.source_card.signature,entry.signature);
        assert.equal(data.account_uid,greetingAccountUid);assert.equal(data.boss_chat_uid,entry.boss_chat_uid);
        assert.equal(entry.favorite_pending,false);assert.equal(entry.ai_pending,false);
        const policy=policyHelpers.normalizeCollectionPolicy(data.collection_policy);
        assert.equal(policy.greet_enabled,true);assert.ok(entry.score>policy.save_above&&entry.score>policy.share_above);
        const key=data.account_uid+'|'+data.boss_chat_uid,previous=backend.greetings.get(key);
        const base={ok:true,id:entry.id,account_uid:data.account_uid,boss_chat_uid:data.boss_chat_uid,may_greet:false};
        event(data.stage+'-greeting:'+entry.name);
        if(data.stage==='begin'){
          if(failGreetingBegin)return reply({error:'打招呼许可不可用'},false);
          if(previous)return reply({...base,state:previous.state});
          backend.greetings.set(key,{state:'attempted',attempt_token:'permission-'+entry.id});
          if(loseGreetingBegin)throw Error('打招呼许可响应丢失');
          return reply({...base,state:'attempted',may_greet:true,attempt_token:'permission-'+entry.id});
        }
        if(data.stage==='already'){
          if(previous)return reply({...base,state:previous.state});
          backend.greetings.set(key,{state:'already'});return reply({...base,state:'already'});
        }
        assert.equal(data.stage,'complete');assert.equal(previous?.state,'attempted');assert.equal(data.attempt_token,previous.attempt_token);
        if(failGreetingComplete)return reply({error:'打招呼确认记录失败'},false);
        previous.state='confirmed';return reply({...base,state:'confirmed'});
      }
      if(path==='/api/extension/favorite-complete'){
        assert.equal(data.source_card.name,current.name);
        assert.equal(data.source_card.signature,current.signature);
        const entry=backend.entries.find(entry=>entry.id===data.id);
        assert.ok(entry);assert.ok(backend.favorites.has(current.signature));
        if(failFavoriteAck)return reply({error:'收藏记录确认失败'},false);
        entry.favorite_pending=false;event('ack-favorite:'+current.name);
        return reply({ok:true});
      }
      if(path==='/api/extension/colleague-share'){
        const entry=backend.entries.find(entry=>entry.id===data.id);
        assert.ok(entry);assert.equal(entry.name,current.name);
        assert.equal(data.source_card.signature,current.signature);
        assert.equal(entry.favorite_pending,false);
        assert.equal(data.recipient,entry.collection_policy.colleague_name);
        assert.equal(entry.colleague_share_state,data.stage==='begin'?'pending':'attempted');
        entry.colleague_share_state=data.stage==='begin'?'attempted':'confirmed';
        event((data.stage==='begin'?'begin-colleague:':'confirm-colleague:')+current.name);
        return reply({ok:true,state:entry.colleague_share_state});
      }
      if(path==='/api/extension/rollback-unreachable'){
        if(failRollback)return reply({error:'清理未完成'},false);
        const entry=backend.entries.find(entry=>entry.id===data.id);
        assert.ok(entry);assert.equal(data.source_card.name,entry.name);assert.equal(data.source_card.signature,entry.signature);
        if(entry.share||entry.boss_chat_uid||!entry.favorite_pending||backend.favorites.has(entry.signature))return reply({ok:true,deleted:false});
        backend.entries.splice(backend.entries.indexOf(entry),1);
        backend.lowMarks=backend.lowMarks.filter(mark=>!(mark.job===entry.job&&mark.name===entry.name&&mark.signature===entry.signature));
        event('rollback:'+entry.name);
        return reply({ok:true,deleted:true});
      }
      if(path==='/api/candidates/share'){
        if(failShare)return reply({error:'保存二维码失败'},false);
        assert.equal(data.id,backend.entries.find(entry=>entry.job===Number(element('#job').value)&&
          entry.name===current.name&&entry.signature===current.signature)?.id);
        backend.entries.find(entry=>entry.id===data.id).share=true;
        event('save-share:'+current.name);return reply({ok:true});
      }
      throw Error('Unexpected request '+path);
    }
  };
  const source=fs.readFileSync(new URL('../extension/collector.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
  vm.runInNewContext(source+'\nglobalThis.readSequenceForTest=readLocalClipboardSequence;',context);
  await new Promise(resolve=>setImmediate(resolve));
  return {element,events,posted,postedData,storageState,apiUrls,readSequence:context.readSequenceForTest,opened,backend,lookupBatches,lines,requestedPermissions,storageWrites,registrations,scriptFiles,listSnapshots,listWaits,directResults,shareCrops,waits,chatExecutionScans,expansionCalls,copyOptions,previewCalls,previewProbes,focusRecoveries,detailCalls,recoveryDetailReads,windowUpdates,fitResults,
    emitPayment,paymentMonitors,actionRequests,resolveResponses:()=>pendingResponses.splice(0).forEach(resolve=>resolve()),
    simulatedTime:()=>simulatedTime,scanCount:()=>scanCount,
    cleanupCalls:()=>cleanupCalls,openedScanCount:()=>openedScanCount,resolveReads:()=>pendingReads.splice(0).forEach(resolve=>resolve()),
    receiptActions,receiptStages,
    shareMetrics:()=>({checks:shareLayoutChecks,captures:shareCaptures}),
    setCards:next=>listCards.splice(0,listCards.length,...next.map(card=>({...card}))),
    replaceCurrent:card=>{current={...card};canvasGeneration++;},
    trackerActive:()=>registered.length>0,click:id=>{activeAction=id;return element(id).listeners.click();},change:id=>element(id).listeners.change()};
}

const customPolicy=(overrides={})=>({...policyHelpers.DEFAULT_COLLECTION_POLICY,...overrides});

function ruleRejection(){
  return {evaluation_method:'rules',score:null,precheck:{version:'hard-rules-v1',rejected:true,checks:[{
    requirement_id:1,condition:'至少 6 年工作经验',rule_id:'minimum-experience-years',status:'不满足',basis:'explicit',
    evidence_lines:[4],evidence_quotes:['5年'],reasoning:'原文明示 5 年，未达到至少 6 年要求。',
  }]}};
}
const ruleScreen=()=>({saved:false,ai_pending:false,favorite_pending:false,collection_marked:true,...ruleRejection()});
const ruleResult=()=>{
  const result=ruleRejection();
  return {...result,category:'低匹配',must_have_status:'not_met',summary:'必备经验条件未达到，未调用模型。',
    checks:[],required_checks:result.precheck.checks.map(check=>({...check})),questions:[],inferred_capabilities:[]};
};

const recommendationCards=cards.map((card,index)=>({...card,kind:'recommendation',platform_geek_id:'encrypted-geek-'+index}));
const availableChat=(card,uid='12345678901234567890')=>({ok:true,status:'available',boss_chat_uid:uid,
  platform_geek_id:card.platform_geek_id,candidate_name:card.name});

const greetingPolicy=overrides=>customPolicy({greet_enabled:true,share_mode:'none',...overrides});
const greetingController=overrides=>controller({batchCards:[recommendationCards[0]],recommendationPage:true,
  listPath:'/web/frame/recommend/',chatUidBySignature:{一号:'12345',二号:'67890'},
  storedPolicies:{1:greetingPolicy()},...overrides});
function savedGreetingCandidate(backend,overrides={}){
  const card=recommendationCards[0];
  const entry={id:7,job:1,name:card.name,signature:card.signature,boss_chat_uid:'12345',share:true,
    favorite_pending:false,ai_pending:false,score:82,colleague_share_state:'confirmed',
    collection_policy:customPolicy(),...overrides};
  backend.entries.push(entry);return entry;
}

test('automatic greeting defaults off and shares the colleague threshold while its toggle persists per job',async()=>{
  const legacy={...customPolicy({share_mode:'none'})};delete legacy.greet_enabled;
  const c=await controller({storedPolicies:{1:legacy,2:customPolicy()}});
  assert.equal(c.element('#greet-enabled').checked,false);assert.equal(c.element('#share-above').disabled,true);
  c.element('#greet-enabled').checked=true;c.change('#greet-enabled');
  assert.equal(c.element('#share-above').disabled,false);assert.equal(c.element('#colleague-name').disabled,true);
  c.element('#share-above').value='87';c.change('#share-above');
  c.element('#job').value='2';c.change('#job');assert.equal(c.element('#greet-enabled').checked,false);
  c.element('#job').value='1';c.change('#job');assert.equal(c.element('#greet-enabled').checked,true);
  assert.equal(c.element('#share-above').value,'87');
  c.element('#share-colleague').checked=true;c.change('#share-colleague');
  c.element('#greet-enabled').checked=false;c.change('#greet-enabled');
  assert.equal(c.element('#share-above').disabled,false);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.storageState.collectionPoliciesV1['1'].greet_enabled,false);
  assert.equal(c.storageState.collectionPoliciesV1['1'].share_above,87);
  const html=fs.readFileSync(new URL('../extension/collector.html',import.meta.url),'utf8');
  assert.match(html,/高分自动打招呼/);assert.match(html,/BOSS 默认招呼语/);
  assert.equal((html.match(/id="share-above"/g)||[]).length,1);assert.ok(!html.includes('id="greet-above"'));
});

test('automatic greeting follows confirmed favorite, colleague forwarding and QR for foreground and background recommendation reads',async()=>{
  for(const mode of ['foreground','background']){
    const card=recommendationCards[1],c=await greetingController({mode,batchCards:[card],colleagueForward:true,
      storedPolicies:{1:greetingPolicy({share_mode:'both'})}});
    await c.click('#start');
    const sequence=['open',mode==='background'?'background-read':'copy','read-chat','read-chat','evaluate','save','save-chat',
      'favorite','ack-favorite','begin-colleague','send-colleague','confirm-colleague','share','save-share',
      'prepare-greeting','begin-greeting','send-greeting','complete-greeting','close'];
    let previous=-1;
    for(const action of sequence){
      const next=c.events.indexOf(action+':'+card.name,previous+1);
      assert.ok(next>previous,action+' missing or out of order: '+JSON.stringify(c.events));previous=next;
    }
    assert.equal(c.backend.greetings.get('9001|67890')?.state,'confirmed');
    assert.match(c.lines[0].textContent,/已使用 BOSS 默认招呼语打招呼/);
    const requests=c.postedData.filter(({path})=>path==='/api/extension/greeting');
    assert.deepEqual(requests.map(({data})=>data.stage),['begin','complete']);
    assert.equal(requests[0].data.collection_policy.share_above,75);
    assert.equal(requests[0].data.collection_policy.greet_enabled,true);
    assert.equal(requests[0].data.account_uid,'9001');assert.equal(requests[0].data.boss_chat_uid,'67890');
    assert.equal(c.postedData.find(({path})=>path==='/api/extension/collection-status').data.greeting_account_uid,'9001');
  }
});

test('automatic greeting uses strict current save and shared thresholds and never treats AI failure as a qualifying score',async()=>{
  for(const fixture of [
    {score:75,expected:false},{score:75.01,expected:true},
    {score:82,storedPolicies:{1:greetingPolicy({save_above:90,share_above:75})},expected:false},
    {score:90,storedPolicies:{1:greetingPolicy({save_above:90,share_above:75})},expected:false},
    {score:90.01,storedPolicies:{1:greetingPolicy({save_above:90,share_above:75})},expected:true},
    {score:99,failAi:true,expected:false},
    {score:99,storedPolicies:{1:customPolicy({share_mode:'none'})},expected:false}
  ]){
    const c=await greetingController(fixture);await c.click('#start');
    assert.equal(c.events.includes('send-greeting:张**'),fixture.expected,JSON.stringify(fixture)+' '+c.element('#status').textContent);
    assert.equal(c.posted.includes('/api/extension/greeting'),fixture.expected);
  }
});

test('automatic greeting requires supported workbench, numeric account, verified candidate UID and matching prepare identities',async()=>{
  for(const fixture of [
    {greetingVersion:0},{greetingAccountUid:''},{greetingAccountUid:'01'},{greetingAccountUid:'900719925474099300001'},
    {chatUidBySignature:{}},{greetingPreparedStatus:'blocked'},{greetingPreparedAccountUid:'9002'},
    {greetingPreparedIdentity:{platform_geek_id:'other-person'}},
    {greetingPreparedIdentity:{boss_chat_uid:'99999'}},{greetingPreparedIdentity:{candidate_name:'赵**'}}
  ]){
    const c=await greetingController(fixture);await c.click('#start');
    assert.ok(!c.posted.includes('/api/extension/greeting'),JSON.stringify(fixture));
    assert.ok(!c.events.some(value=>value.startsWith('send-greeting:')));
    assert.ok(!c.events.includes('close:张**'));
    if(fixture.greetingVersion===0||Object.hasOwn(fixture,'greetingAccountUid'))assert.deepEqual(c.opened,[]);
  }
});

test('automatic greeting never runs for search, single evaluation or chat-entry-only backfill even when enabled',async()=>{
  const search=await greetingController({recommendationPage:false,listPath:'/web/frame/search/',batchCards:[cards[0]]});
  await search.click('#start');assert.equal(search.backend.entries.length,1);
  const direct=await greetingController({preopened:true});await direct.click('#evaluate-current');assert.equal(direct.directResults.length,1);
  const backend=memoryBackend();savedGreetingCandidate(backend,{boss_chat_uid:undefined,favorite_pending:true,share:false,colleague_share_state:'attempted'});
  const backfill=await greetingController({backend});await backfill.click('#backfill-chat');
  assert.equal(backend.entries[0].boss_chat_uid,'12345');assert.equal(backend.entries[0].favorite_pending,true);
  for(const c of [search,direct,backfill]){
    assert.ok(!c.events.some(value=>/greeting/.test(value)),JSON.stringify(c.events));
    assert.ok(!c.posted.includes('/api/extension/greeting'));
    assert.ok(c.postedData.filter(({path})=>path==='/api/extension/collection-status').every(({data})=>!Object.hasOwn(data,'greeting_account_uid')));
  }
});

test('a greeting blocked by a job mismatch shows the fixed reason without exposing page error text',async()=>{
  const c=await greetingController({greetingPreparedStatus:'blocked',
    greetingPreparedIdentity:{reason:'job_changed',error:'PRIVATE_PAGE_ERROR'}});
  await c.click('#start');
  assert.match(c.element('#status').textContent,/沟通岗位与工作台所选岗位不一致/);
  assert.doesNotMatch(c.element('#status').textContent,/PRIVATE_PAGE_ERROR/);
  assert.ok(!c.posted.includes('/api/extension/greeting'));assert.ok(!c.events.includes('send-greeting:张**'));
});

test('saved eligible candidates use the current greeting policy without another evaluation or repeated completed external actions',async()=>{
  for(const favorite_pending of [false,true]){
    const backend=memoryBackend();savedGreetingCandidate(backend,{favorite_pending});
    const c=await greetingController({backend,storedPolicies:{1:greetingPolicy({share_above:80,share_mode:'both'})}});
    await c.click('#start');
    assert.deepEqual(c.opened,['一号']);assert.ok(c.events.includes('copy:张**'));
    assert.equal(c.events.filter(value=>value==='read-chat:张**').length,2);
    assert.ok(!c.posted.includes('/api/extension/screen'));
    assert.equal(c.events.includes('favorite:张**'),favorite_pending);
    assert.ok(!c.events.some(value=>/^(send-colleague|share):/.test(value)));
    assert.equal(backend.greetings.get('9001|12345')?.state,'confirmed');
    const begin=c.postedData.find(({path,data})=>path==='/api/extension/greeting'&&data.stage==='begin');
    assert.equal(begin.data.collection_policy.share_above,80);assert.equal(begin.data.collection_policy.greet_enabled,true);
    if(favorite_pending)assert.ok(c.events.indexOf('ack-favorite:张**')<c.events.indexOf('begin-greeting:张**'));
    const again=await greetingController({backend});await again.click('#start');
    assert.deepEqual(again.opened,[]);assert.ok(!again.posted.includes('/api/extension/greeting'));
  }
});

test('saved candidates with failed or no longer qualifying current AI scores do not reopen for greetings',async()=>{
  for(const fields of [{score:75},{score:null,ai_pending:true},{score:99,ai_pending:true}]){
    const backend=memoryBackend();savedGreetingCandidate(backend,fields);
    const c=await greetingController({backend});await c.click('#start');
    assert.deepEqual(c.opened,[]);assert.ok(!c.posted.includes('/api/extension/greeting'));
  }
});

test('a saved high scorer missing its UID gets a verified chat entry and a greeting in the same run',async()=>{
  const backend=memoryBackend();savedGreetingCandidate(backend,{boss_chat_uid:undefined});
  const c=await greetingController({backend});await c.click('#start');
  assert.equal(backend.entries[0].boss_chat_uid,'12345');assert.equal(backend.greetings.get('9001|12345')?.state,'confirmed');
  assert.ok(c.events.indexOf('save-chat:张**')<c.events.indexOf('prepare-greeting:张**'));
  assert.equal(c.events.filter(value=>value==='send-greeting:张**').length,1);
  assert.ok(!c.events.some(value=>/^(evaluate|favorite|share|send-colleague):/.test(value)));
  assert.ok(!c.posted.includes('/api/extension/screen'));
});

test('ineligible historical cards with attempted greetings remain skipped and cannot block current collection',async()=>{
  const backend=memoryBackend();savedGreetingCandidate(backend,{chat_entry_eligible:false});
  backend.greetings.set('9001|12345',{state:'attempted'});
  const c=await greetingController({backend});await c.click('#start');
  assert.deepEqual(c.opened,[]);assert.ok(!c.posted.includes('/api/extension/greeting'));
  assert.match(c.element('#status').textContent,/均已采集/);
});

test('an explicitly observed existing friendship is recorded without beginning or sending a greeting',async()=>{
  const c=await greetingController({greetingPreparedStatus:'already'});await c.click('#start');
  assert.deepEqual(c.postedData.filter(({path})=>path==='/api/extension/greeting').map(({data})=>data.stage),['already']);
  assert.ok(!c.events.includes('send-greeting:张**'));assert.equal(c.backend.greetings.get('9001|12345')?.state,'already');
  assert.match(c.lines[0].textContent,/已沟通过，未重复打招呼/);
});

test('a prior attempted greeting stops before repeating any external action, even if the current score dropped',async()=>{
  for(const score of [82,60,null]){
    const backend=memoryBackend();savedGreetingCandidate(backend,{score,ai_pending:score===null,favorite_pending:true,
      colleague_share_state:'pending',share:false});backend.greetings.set('9001|12345',{state:'attempted'});
    const c=await greetingController({backend});await c.click('#start');
    assert.match(c.element('#status').textContent,/此前打招呼可能已提交.*不会重复发送/);
    assert.ok(!c.events.some(value=>/^(copy|favorite|send-colleague|share|prepare-greeting|send-greeting):/.test(value)));
    assert.ok(!c.posted.includes('/api/extension/greeting'));assert.equal(backend.entries[0].favorite_pending,true);
  }
});

test('lost permission replies and uncertain, blocked or unrecorded sends retain attempted state and never retry automatically',async()=>{
  for(const fixture of [
    {loseGreetingBegin:true},{greetingSendStatus:'uncertain'},{greetingSendStatus:'blocked'},
    {greetingSendIdentity:{account_uid:'9002'}},{failGreetingComplete:true}
  ]){
    const backend=memoryBackend(),c=await greetingController({...fixture,backend});await c.click('#start');
    assert.equal(backend.greetings.get('9001|12345')?.state,'attempted',JSON.stringify(fixture));
    assert.equal(c.events.filter(value=>value==='send-greeting:张**').length,fixture.loseGreetingBegin?0:1);
    assert.ok(!c.events.includes('close:张**'));assert.equal(backend.entries.length,1);assert.equal(backend.entries[0].favorite_pending,false);
    const retry=await greetingController({backend});await retry.click('#start');
    assert.ok(!retry.events.some(value=>/^(prepare-greeting|send-greeting):/.test(value)));
    assert.ok(!retry.posted.includes('/api/extension/greeting'));assert.match(retry.element('#status').textContent,/人工核对/);
  }
});

test('backend at-most-once decisions prevent sends when another run has already attempted or completed the same account and UID',async()=>{
  for(const state of ['attempted','confirmed','already']){
    const backend=memoryBackend();backend.greetings.set('9001|12345',{state});
    const c=await greetingController({backend});await c.click('#start');
    assert.ok(c.events.includes('begin-greeting:张**'));assert.ok(!c.events.includes('send-greeting:张**'));
    assert.equal(c.events.includes('close:张**'),state!=='attempted');
    assert.equal(backend.greetings.get('9001|12345').state,state);
  }
});

test('stop and window close revoke prepared greeting tokens and prevent a subsequent send',async()=>{
  for(const key of ['stopAt','unloadAt'])for(const phase of ['prepare-greeting','begin-greeting']){
    const c=await greetingController({[key]:phase+':张**'});await c.click('#start');
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(!c.events.includes('send-greeting:张**'));
    assert.ok(c.events.includes('greeting-stop:list'));assert.ok(c.events.includes('greeting-stop:outer'));
    assert.equal(c.backend.greetings.get('9001|12345')?.state,phase==='begin-greeting'?'attempted':undefined);
    assert.ok(!c.events.includes('close:张**'));assert.equal(c.backend.entries[0].favorite_pending,false);
  }
});

test('failures in favorite, forwarding, QR or backend permission prevent the final greeting action',async()=>{
  for(const fixture of [{failFavoriteAck:true},{failColleagueToast:true},{failShare:true},{failGreetingBegin:true}]){
    const c=await greetingController({...fixture,colleagueForward:true,storedPolicies:{1:greetingPolicy({share_mode:'both'})}});
    await c.click('#start');assert.ok(!c.events.includes('send-greeting:张**'));assert.ok(!c.events.includes('close:张**'));
    if(!fixture.failGreetingBegin)assert.ok(!c.posted.includes('/api/extension/greeting'));
    assert.equal(c.backend.greetings.size,0);
  }
});

test('recommendation chat entries bind twice after complete resume reading and save separately before ordered external actions',async()=>{
  for(const mode of ['foreground','background']){
    const card=recommendationCards[1],uid='12345678901234567890';
    const c=await controller({mode,batchCards:[card],chatUidBySignature:{[card.signature]:uid},colleagueForward:true});
    await c.click('#start');
    assert.equal(c.backend.entries[0]?.boss_chat_uid,uid);
    assert.equal(c.events.filter(value=>value==='read-chat:'+card.name).length,2);
    const sequence=['open',mode==='background'?'background-read':'copy','read-chat','read-chat','evaluate','save','save-chat','favorite','send-colleague','share','close'];
    let previous=-1;
    for(const action of sequence){
      const index=c.events.indexOf(action+':'+card.name,previous+1);
      assert.ok(index>previous,action+' missing or out of order: '+JSON.stringify(c.events));previous=index;
    }
    const entry=c.postedData.find(item=>item.path==='/api/extension/chat-entry');
    assert.deepEqual(entry.data,{id:c.backend.entries[0].id,source_card:{name:card.name,signature:card.signature},boss_chat_uid:uid});
    const screened=c.postedData.find(item=>item.path==='/api/extension/screen').data.candidate;
    assert.equal(screened.link,'');assert.ok(!Object.hasOwn(screened,'boss_chat_uid'));
    assert.match(c.lines[0].textContent,/候选人联系标识已保存（沟通关系未核实）/);
  }
});

test('saved recommendation records missing only chat entries are backfilled without reevaluation or repeated external actions',async()=>{
  const card=recommendationCards[0],backend=memoryBackend();
  backend.entries.push({id:7,job:1,name:card.name,signature:card.signature,share:true,favorite_pending:false,
    colleague_share_state:'confirmed',collection_policy:customPolicy()});
  const c=await controller({backend,batchCards:[card],chatUidBySignature:{[card.signature]:'98765'}});
  await c.click('#start');
  assert.deepEqual(c.opened,[card.signature]);assert.equal(backend.entries[0].boss_chat_uid,'98765');
  assert.deepEqual(c.posted.filter(path=>path!=='/api/extension/collection-status'&&path!=='/api/extension/clipboard-preview'),['/api/extension/chat-entry']);
  assert.ok(!c.events.some(value=>/^(evaluate|favorite|share|send-colleague|prepare-colleague):/.test(value)));
  const again=await controller({backend,batchCards:[card],chatUidBySignature:{[card.signature]:'98765'}});
  await again.click('#start');assert.deepEqual(again.opened,[]);assert.match(again.element('#status').textContent,/均已采集/);
});

test('missing recommendation numeric UID completes once and can be backfilled on a later run',async()=>{
  const card=recommendationCards[0],backend=memoryBackend();
  const first=await controller({backend,batchCards:[card]});await first.click('#start');
  assert.equal(backend.entries.length,1);assert.equal(backend.entries[0].boss_chat_uid,undefined);
  assert.deepEqual(first.opened,[card.signature]);assert.ok(!first.posted.includes('/api/extension/chat-entry'));
  assert.match(first.lines[0].textContent,/未获取聊天入口/);assert.match(first.element('#status').textContent,/已处理 1 位/);
  const retry=await controller({backend,batchCards:[card],chatUidBySignature:{[card.signature]:'98765'}});
  await retry.click('#start');assert.equal(backend.entries[0].boss_chat_uid,'98765');
  assert.ok(!retry.posted.includes('/api/extension/screen'));assert.ok(!retry.events.some(value=>/^(favorite|share|send-colleague):/.test(value)));
});

test('deleted, moved or ambiguously linked historical records cannot trigger chat-entry-only backfill',async()=>{
  const card=recommendationCards[0],backend=memoryBackend();
  backend.entries.push({id:7,job:1,name:card.name,signature:card.signature,share:true,favorite_pending:false,
    colleague_share_state:'confirmed',collection_policy:customPolicy(),chat_entry_eligible:false});
  const c=await controller({backend,batchCards:[card],chatUidBySignature:{[card.signature]:'98765'}});
  await c.click('#start');assert.deepEqual(c.opened,[]);assert.ok(!c.posted.includes('/api/extension/chat-entry'));
});

test('recommendation identity conflicts and same-name UID changes never attach a chat link',async()=>{
  const card=recommendationCards[0],valid=availableChat(card);
  for(const responses of [
    [valid,{...valid,boss_chat_uid:'98765'}],
    [valid,{ok:false,status:'identity-conflict',error:'身份变化'}],
    [{...valid,platform_geek_id:'another-geek'},valid],
    [{...valid,boss_chat_uid:123},valid],
    [valid,{ok:true,status:'unavailable'}],
  ]){
    const c=await controller({batchCards:[card],chatEntryResponses:responses});await c.click('#start');
    assert.equal(c.backend.entries.length,1);assert.ok(!c.posted.includes('/api/extension/chat-entry'));
    assert.ok(c.events.includes('favorite:'+card.name));assert.match(c.lines[0].textContent,/聊天入口/);
  }
});

test('a chat-entry save failure preserves existing collection actions and remains eligible for backfill',async()=>{
  const card=recommendationCards[0],backend=memoryBackend();
  const c=await controller({backend,batchCards:[card],chatUidBySignature:{[card.signature]:'98765'},failChatEntry:true,colleagueForward:true});
  await c.click('#start');
  assert.equal(backend.entries.length,1);assert.equal(backend.entries[0].boss_chat_uid,undefined);
  assert.ok(c.events.includes('favorite:'+card.name));assert.ok(c.events.includes('send-colleague:'+card.name));assert.ok(c.events.includes('share:'+card.name));
  assert.match(c.lines[0].textContent,/聊天入口未保存/);
  const retry=await controller({backend,batchCards:[card],chatUidBySignature:{[card.signature]:'98765'}});
  await retry.click('#start');assert.equal(backend.entries[0].boss_chat_uid,'98765');assert.ok(!retry.posted.includes('/api/extension/screen'));
});

test('chat-entry support is restricted to recommendation cards and capability-enabled workbenches',async()=>{
  for(const settings of [{batchCards:[cards[0]]},{batchCards:[recommendationCards[0]],chatEntryVersion:0}]){
    const backend=memoryBackend(),c=await controller({...settings,backend,chatUidBySignature:{[cards[0].signature]:'98765'}});
    await c.click('#start');assert.ok(!c.events.some(value=>value.startsWith('read-chat:')));
    assert.ok(!c.posted.includes('/api/extension/chat-entry'));
    const again=await controller({...settings,backend});await again.click('#start');assert.deepEqual(again.opened,[]);
  }
});

test('chat entries are never persisted for low-score or unconfirmed screen responses',async()=>{
  const card=recommendationCards[0];
  for(const settings of [{score:20},{failScreen:true},{loseScreenResponse:true}]){
    const c=await controller({...settings,batchCards:[card],chatUidBySignature:{[card.signature]:'98765'}});
    await c.click('#start');assert.ok(!c.posted.includes('/api/extension/chat-entry'));
  }
});

test('a same-summary recommendation card replaced before opening cannot inherit the previous identity',async()=>{
  const card=recommendationCards[0];
  const c=await controller({batchCards:[card],onListScan:({index})=>index===1?{cards:[{...card,platform_geek_id:'another-geek'}]}:undefined});
  await c.click('#start');assert.deepEqual(c.opened,[]);assert.equal(c.backend.entries.length,0);
  assert.match(c.element('#status').textContent,/身份已变化/);
});

test('a background reopen cannot bind a same-summary replacement recommendation card',async()=>{
  const card=recommendationCards[1];
  const c=await controller({mode:'background',batchCards:[card],backgroundFailures:[{issue:'初次绘制未覆盖',issueCode:'baseline'}],
    changeCardsOnClose:[{...card,platform_geek_id:'replacement-geek'}]});
  await c.click('#start');assert.deepEqual(c.opened,[card.signature]);assert.equal(c.backend.entries.length,0);
  assert.match(c.element('#status').textContent,/原推荐候选人的身份已变化/);
  assert.ok(!c.posted.includes('/api/extension/chat-entry'));
});

test('stopping during recommendation identity reads prevents screen and chat-entry writes',async()=>{
  const card=recommendationCards[0];
  const c=await controller({batchCards:[card],chatUidBySignature:{[card.signature]:'98765'},stopAt:'read-chat:'+card.name});
  await c.click('#start');assert.equal(c.backend.entries.length,0);
  assert.ok(!c.posted.includes('/api/extension/screen'));assert.ok(!c.posted.includes('/api/extension/chat-entry'));
  assert.ok(!c.events.some(value=>/^(favorite|share|send-colleague):/.test(value)));
});

test('a MAIN result from another document cannot provide a recommendation chat entry',async()=>{
  const card=recommendationCards[1];
  const c=await controller({batchCards:[card],chatUidBySignature:{[card.signature]:'98765'},chatEntryDocumentId:'replaced-outer'});
  await c.click('#start');assert.equal(c.backend.entries.length,1);assert.ok(!c.posted.includes('/api/extension/chat-entry'));
  assert.match(c.lines[0].textContent,/未获取聊天入口/);
});

test('chat-entry-only action skips new cards and ignores every pending external action and configured filter',async()=>{
  const fresh=recommendationCards[0],saved=recommendationCards[1],already={...saved,id:'2',signature:'已有入口'},backend=memoryBackend();
  backend.entries.push({id:7,job:1,name:saved.name,signature:saved.signature,share:false,favorite_pending:true,
    colleague_share_state:'attempted',collection_policy:customPolicy()});
  backend.entries.push({id:8,job:1,name:already.name,signature:already.signature,share:false,favorite_pending:true,
    colleague_share_state:'pending',collection_policy:customPolicy(),boss_chat_uid:'34567'});
  const c=await controller({backend,batchCards:[fresh,saved,already],recommendationPage:true,listPath:'/web/frame/recommend/',
    searchConditions:{enabled:true,activity:'3日内活跃'},failSearch:true,colleagueForward:true,chatUidBySignature:{[saved.signature]:'98765'}});
  c.element('#save-above').value='';c.element('#colleague-name').value='';
  assert.equal(c.element('#backfill-chat').disabled,false);
  await c.click('#backfill-chat');
  assert.deepEqual(c.opened,[saved.signature]);assert.equal(backend.entries.length,2);
  assert.equal(backend.entries[0].boss_chat_uid,'98765');assert.equal(backend.entries[0].favorite_pending,true);
  assert.equal(backend.entries[0].colleague_share_state,'attempted');assert.equal(backend.entries[0].share,false);
  assert.ok(!c.events.some(value=>/^(copy|header-copy|background-read|expand|evaluate|favorite|prepare-colleague|send-colleague|share|rollback|search-|recommend-apply)/.test(value)));
  assert.deepEqual(c.posted,['/api/extension/collection-status','/api/extension/chat-entry']);
  assert.ok(c.requestedPermissions.every(request=>!request.permissions.includes('clipboardRead')));
  assert.deepEqual(c.registrations,[]);
  assert.deepEqual(c.storageWrites,[]);
  assert.match(c.element('#status').textContent,/已检查 1 位.*补充 1 个入口.*跳过 2 位/);
});

test('blank chat-entry-only limit processes only the initial list and never advances or waits for later cards',async()=>{
  const first=recommendationCards[0],later={...recommendationCards[1],signature:'稍后加载'},backend=memoryBackend();
  for(const [index,card] of [first,later].entries())backend.entries.push({id:index+1,job:1,name:card.name,signature:card.signature,
    share:true,favorite_pending:false,colleague_share_state:'confirmed',collection_policy:customPolicy()});
  const c=await controller({backend,batchCards:[first],recommendationPage:true,listPath:'/web/frame/recommend/',limit:'',
    changeCardsOnClose:[first,later],advancePages:[[later]],chatUidBySignature:{[first.signature]:'12345',[later.signature]:'98765'}});
  await c.click('#backfill-chat');
  assert.deepEqual(c.opened,[first.signature]);assert.equal(backend.entries[0].boss_chat_uid,'12345');assert.equal(backend.entries[1].boss_chat_uid,undefined);
  assert.ok(!c.events.some(value=>value.startsWith('advance')));assert.equal(c.lookupBatches.length,1);
  assert.match(c.element('#status').textContent,/补采完成.*已检查 1 位/);assert.equal(c.element('#stop').disabled,true);
});

test('chat-entry-only limit counts missing UIDs and rejects search pages or changed candidate identities',async()=>{
  const backend=memoryBackend();
  for(const [index,card] of recommendationCards.entries())backend.entries.push({id:index+1,job:1,name:card.name,signature:card.signature,
    share:true,favorite_pending:false,colleague_share_state:'confirmed',collection_policy:customPolicy()});
  const c=await controller({backend,batchCards:recommendationCards,recommendationPage:true,listPath:'/web/frame/recommend/',limit:'1'});
  await c.click('#backfill-chat');assert.deepEqual(c.opened,[recommendationCards[0].signature]);
  assert.ok(!c.posted.includes('/api/extension/chat-entry'));assert.match(c.lines[0].textContent,/未获取聊天入口/);
  assert.match(c.element('#status').textContent,/已检查 1 位.*补充 0 个入口/);
  const search=await controller({backend,batchCards:recommendationCards});await search.click('#backfill-chat');
  assert.deepEqual(search.opened,[]);assert.equal(search.lookupBatches.length,0);assert.match(search.element('#status').textContent,/只支持当前「推荐牛人」/);
  const changed=await controller({backend,batchCards:recommendationCards,recommendationPage:true,listPath:'/web/frame/recommend/',
    onListScan:({index})=>index===1?{cards:[{...recommendationCards[0],platform_geek_id:'another-geek'},recommendationCards[1]]}:undefined});
  await changed.click('#backfill-chat');assert.deepEqual(changed.opened,[]);assert.match(changed.element('#status').textContent,/身份已变化/);
  assert.ok(!changed.posted.includes('/api/extension/chat-entry'));
  const drift=await controller({backend,batchCards:recommendationCards,recommendationPage:true,listPath:'/web/frame/recommend/',
    chatEntryResponses:[availableChat(recommendationCards[0],'12345'),availableChat(recommendationCards[0],'67890')]});
  await drift.click('#backfill-chat');assert.deepEqual(drift.opened,[recommendationCards[0].signature]);
  assert.match(drift.element('#status').textContent,/聊天身份发生变化/);assert.ok(!drift.posted.includes('/api/extension/chat-entry'));
});

test('identity-only backfill waits briefly for loading and never reads, expands or copies resume text in either mode',async()=>{
  const card=recommendationCards[1],available=availableChat(card,'98765');
  for(const mode of ['foreground','background']){
    const backend=memoryBackend();backend.entries.push({id:7,job:1,name:card.name,signature:card.signature,share:true,favorite_pending:false});
    const c=await controller({backend,mode,batchCards:[card],recommendationPage:true,listPath:'/web/frame/recommend/',
      chatEntryResponses:[{ok:true,status:'unavailable',reason:'detail_loading'},available,available]});
    await c.click('#backfill-chat');
    assert.equal(backend.entries[0].boss_chat_uid,'98765');assert.equal(c.events.filter(value=>value.startsWith('read-chat:')).length,3);
    assert.ok(!c.events.some(value=>/^(copy|header-copy|background-read|expand|evaluate|favorite|share|send-colleague):/.test(value)));
    assert.deepEqual(c.posted,['/api/extension/collection-status','/api/extension/chat-entry']);
    assert.equal(c.waits.filter(ms=>ms===400).length,1);assert.deepEqual(c.registrations,[]);
    assert.ok(c.requestedPermissions.every(request=>!request.permissions.includes('clipboardRead')));
  }
});

test('identity-only backfill bounds missing-field retries and never retries through an observed identity conflict',async()=>{
  const card=recommendationCards[1],available=availableChat(card,'98765');
  for(const [responses,reads,conflict] of [
    [[],6,false],
    [[{ok:false,status:'identity-conflict'},available,available],1,true],
    [[available,{ok:true,status:'unavailable'},availableChat(card,'12345')],3,true],
  ]){
    const backend=memoryBackend();backend.entries.push({id:7,job:1,name:card.name,signature:card.signature,share:true,favorite_pending:false});
    const c=await controller({backend,batchCards:[card],recommendationPage:true,listPath:'/web/frame/recommend/',chatEntryResponses:responses});
    await c.click('#backfill-chat');
    assert.equal(c.events.filter(value=>value.startsWith('read-chat:')).length,reads);
    assert.ok(c.waits.filter(ms=>ms===400).reduce((total,ms)=>total+ms,0)<=2000);
    assert.ok(!c.posted.includes('/api/extension/chat-entry'));assert.equal(backend.entries[0].boss_chat_uid,undefined);
    assert.match(c.element('#status').textContent,conflict?/聊天身份发生变化/:/补采完成/);
    assert.ok(!c.events.some(value=>/^(copy|header-copy|background-read|expand):/.test(value)));
  }
});

test('chat-entry diagnostics show only fixed Chinese reasons and preserve the last unavailable reason',async()=>{
  const card=recommendationCards[1];
  const cases=[['missing_card_identity','卡片未提供可核验标识'],['no_visible_detail','未找到当前详情'],
    ['missing_resume_identity','详情身份字段未就绪'],['unbound_resume_component','未找到可核验详情组件'],
    ['missing_numeric_uid','详情未提供数值 UID'],['private-fixture-value','未能读取详情身份'],
    [{raw:'private-fixture-value'},'未能读取详情身份']];
  for(const [reason,label] of cases){
    const backend=memoryBackend();backend.entries.push({id:7,job:1,name:card.name,signature:card.signature,share:true,favorite_pending:false});
    const responses=[{ok:true,status:'unavailable',reason:'detail_loading'},
      ...Array.from({length:5},()=>({ok:true,status:'unavailable',reason}))];
    const c=await controller({backend,batchCards:[card],recommendationPage:true,listPath:'/web/frame/recommend/',chatEntryResponses:responses});
    await c.click('#backfill-chat');assert.ok(c.lines[0].textContent.includes(label));
    assert.doesNotMatch(c.lines[0].textContent,/private-fixture-value|detail_loading|missing_numeric_uid/);
    assert.ok(!c.posted.includes('/api/extension/chat-entry'));
  }
  for(const responses of [
    [{ok:true,status:'unavailable',reason:'missing_resume_identity'},availableChat(card)],
    [availableChat(card),{ok:true,status:'unavailable',reason:'missing_resume_identity'}],
  ]){
    const c=await controller({batchCards:[card],chatEntryResponses:responses});await c.click('#start');
    assert.match(c.lines[0].textContent,/详情身份字段未就绪/);assert.ok(!c.posted.includes('/api/extension/chat-entry'));
  }
  const c=await controller({batchCards:[card],throwChatRead:true});await c.click('#start');
  assert.match(c.lines[0].textContent,/浏览器未能执行身份读取脚本/);assert.doesNotMatch(c.lines[0].textContent,/private-fixture-value/);
});

test('chat-entry diagnostics distinguish browser transport failures from helper stages without exposing page values',async()=>{
  const card=recommendationCards[1],unavailable=(stage)=>({ok:true,status:'unavailable',reason:'read_failed',stage});
  for(const [settings,message] of [
    [{throwChatRead:true},/浏览器未能执行身份读取脚本/],
    [{chatEntryDocumentId:'another-document'},/读取结果未匹配当前详情文档/],
    [{chatEntryFrameId:1234},/读取结果未匹配当前详情文档/],
    [{chatEntryRowCount:0},/读取结果未匹配当前详情文档/],
    [{chatEntryRowCount:2},/读取结果未匹配当前详情文档/],
    [{chatEntryResponses:Array(6).fill(unavailable('vue_lookup'))},/未能读取详情身份：组件定位阶段/],
    [{chatEntryResponses:Array(6).fill(unavailable('resume_fields'))},/未能读取详情身份：简历字段读取阶段/],
    [{chatEntryResponses:Array(6).fill(unavailable('private-fixture-value'))},/未能读取详情身份）/],
  ]){
    const backend=memoryBackend();backend.entries.push({id:7,job:1,name:card.name,signature:card.signature,share:true,favorite_pending:false});
    const c=await controller({...settings,backend,batchCards:[card],recommendationPage:true,listPath:'/web/frame/recommend/'});
    await c.click('#backfill-chat');assert.match(c.lines[0].textContent,message);
    assert.doesNotMatch(c.lines[0].textContent,/private-fixture-value|another-document|vue_lookup|resume_fields/);
    assert.ok(!c.posted.includes('/api/extension/chat-entry'));
  }
});

test('slow detail verification never consumes the missing-field wait budget or skips the second successful UID read',async()=>{
  const card=recommendationCards[1],available=availableChat(card,'98765');
  for(const loading of [false,true]){
    const backend=memoryBackend();backend.entries.push({id:7,job:1,name:card.name,signature:card.signature,share:true,favorite_pending:false});
    const c=await controller({backend,batchCards:[card],recommendationPage:true,listPath:'/web/frame/recommend/',scanDurationMs:1500,
      chatEntryResponses:[...(loading?[{ok:true,status:'unavailable',reason:'detail_loading'}]:[]),available,available]});
    await c.click('#backfill-chat');
    assert.equal(backend.entries[0].boss_chat_uid,'98765');assert.ok(c.simulatedTime()>2000);
    assert.equal(c.chatExecutionScans.length,loading?3:2);
    for(let i=1;i<c.chatExecutionScans.length;i++)assert.equal(c.chatExecutionScans[i]-c.chatExecutionScans[i-1],2,
      'each MAIN read must retain the preceding after-check and its own before-check');
    assert.ok(c.scanCount()>=c.chatExecutionScans.at(-1)+2,'final read retains after-check and closing identity check');
    assert.equal(c.waits.filter(ms=>ms===400).length,loading?1:0);
    assert.ok(!c.events.some(value=>/^(copy|header-copy|background-read|expand):/.test(value)));
  }
});

test('bounded identity retries distinguish a single unconfirmed valid sample from missing fields',async()=>{
  const card=recommendationCards[1],missing={ok:true,status:'unavailable',reason:'detail_loading'};
  for(const finalValid of [false,true]){
    const backend=memoryBackend();backend.entries.push({id:7,job:1,name:card.name,signature:card.signature,share:true,favorite_pending:false});
    const c=await controller({backend,batchCards:[card],recommendationPage:true,listPath:'/web/frame/recommend/',scanDurationMs:1500,
      chatEntryResponses:[...Array(5).fill(missing),finalValid?availableChat(card,'98765'):missing]});
    await c.click('#backfill-chat');assert.equal(c.chatExecutionScans.length,6);
    assert.equal(c.waits.filter(ms=>ms===400).reduce((total,ms)=>total+ms,0),2000);
    assert.match(c.lines[0].textContent,finalValid?/尚未完成两次身份核验/:/详情仍在加载/);
    assert.doesNotMatch(c.lines[0].textContent,/未能读取详情身份/);assert.ok(!c.posted.includes('/api/extension/chat-entry'));
  }
});

test('a custom save threshold rejects low scores without favorite, QR or colleague actions',async()=>{
  const policy=customPolicy({save_above:90,share_above:95,colleague_name:'王女士'});
  const c=await controller({batchCards:[cards[0]],storedPolicies:{1:policy},colleagueForward:true});
  await c.click('#start');
  assert.equal(c.backend.entries.length,0);assert.equal(c.backend.lowMarks.length,1);
  assert.ok(!c.events.some(value=>/^(favorite|share|prepare-colleague|send-colleague):/.test(value)));
  assert.match(c.lines[0].textContent,/未高于 90 分/);
  for(const request of c.postedData.filter(({path})=>['/api/extension/screen','/api/extension/collection-status'].includes(path)))
    assert.deepEqual(request.data.collection_policy,policy);
});

test('lowering a save threshold rechecks an earlier low-score card and retains failed evaluations',async()=>{
  const backend=memoryBackend();
  const high=await controller({backend,batchCards:[cards[0]],score:70,storedPolicies:{1:customPolicy({save_above:80,share_mode:'none'})}});
  await high.click('#start');assert.equal(backend.entries.length,0);assert.equal(backend.lowMarks.length,1);
  const low=await controller({backend,batchCards:[cards[0]],score:70,storedPolicies:{1:customPolicy({save_above:60,share_mode:'none'})}});
  await low.click('#start');assert.equal(backend.entries.length,1);assert.deepEqual(low.opened,['一号']);
  const failed=await controller({batchCards:[cards[0]],score:10,failAi:true,storedPolicies:{1:customPolicy({save_above:100,share_mode:'none'})}});
  await failed.click('#start');assert.equal(failed.backend.entries.length,1);assert.equal(failed.backend.entries[0].ai_pending,true);
});

test('QR and colleague switches independently select all four sharing combinations',async()=>{
  for(const share_mode of ['none','qr','colleague','both']){
    const policy=customPolicy({save_above:40,share_above:60,share_mode,colleague_name:'王女士'});
    const c=await controller({batchCards:[cards[0]],storedPolicies:{1:policy},colleagueForward:true});
    await c.click('#start');
    assert.equal(c.backend.entries.length,1);
    assert.equal(c.events.includes('share:张**'),policyHelpers.policyUsesQr(policy));
    assert.equal(c.events.includes('send-colleague:张**'),policyHelpers.policyUsesColleague(policy));
    for(const request of c.postedData.filter(({path})=>path==='/api/extension/colleague-share'))
      assert.equal(request.data.recipient,'王女士');
    assert.ok(c.events.includes('favorite:张**'));
    assert.match(c.element('#status').textContent,/已处理 1 位/);
  }
});

test('a custom colleague threshold is strictly above the boundary and uses the chosen recipient',async()=>{
  const c=await controller({colleagueForward:true,scoreBySignature:{一号:90,二号:90.01},
    storedPolicies:{1:customPolicy({save_above:20,share_above:90,share_mode:'colleague',colleague_name:'陈先生'})}});
  await c.click('#start');
  assert.ok(!c.events.includes('send-colleague:张**'));assert.ok(c.events.includes('send-colleague:李**'));
  const requests=c.postedData.filter(({path})=>path==='/api/extension/colleague-share');
  assert.equal(requests.length,2);assert.ok(requests.every(({data})=>data.recipient==='陈先生'));
  assert.ok(!c.events.some(value=>value.startsWith('share:')));
});

test('settings follow the selected job and valid changes persist locally',async()=>{
  const first=customPolicy({save_above:65,share_mode:'none'}),second=customPolicy({save_above:80,share_above:90,colleague_name:'张先生'});
  const c=await controller({storedPolicies:{1:first,2:second}});
  assert.equal(c.element('#save-above').value,'65');assert.equal(c.element('#share').checked,false);
  c.element('#save-above').value='66.5';c.change('#save-above');
  c.element('#job').value='2';c.change('#job');
  assert.equal(c.element('#save-above').value,'80');assert.equal(c.element('#colleague-name').value,'张先生');
  c.element('#job').value='1';c.change('#job');
  assert.equal(c.element('#save-above').value,'66.5');assert.equal(c.element('#share-colleague').checked,false);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.storageState.collectionPoliciesV1['1'].save_above,66.5);
  assert.equal(c.storageState.collectionPoliciesV1['2'].save_above,80);
});

test('invalid settings and unsupported backends stop before reading a candidate',async()=>{
  for(const [id,value] of [['#save-above',''],['#save-above','101'],['#share-above','-1'],['#colleague-name','']]){
    const c=await controller();c.element(id).value=value;await c.click('#start');
    assert.deepEqual(c.opened,[]);assert.deepEqual(c.posted,[]);assert.equal(c.backend.entries.length,0);
    assert.equal(c.element('#start').disabled,false);
  }
  const old=await controller({collectionPolicyVersion:0});
  assert.equal(old.element('#start').disabled,true);assert.match(old.element('#status').textContent,/版本过旧/);
});

test('corrupted stored policies disable sharing and never silently select a recipient',async()=>{
  const c=await controller({colleagueForward:true,batchCards:[cards[0]],storedPolicies:{1:{save_above:'bad',share_mode:'none'}}});
  assert.equal(c.element('#share').checked,false);assert.equal(c.element('#share-colleague').checked,false);
  await c.click('#start');assert.equal(c.backend.entries.length,1);
  assert.ok(!c.events.some(value=>/^(share|send-colleague|prepare-colleague):/.test(value)));
});

test('pending colleague work keeps its original recipient and attempted sends stay blocked when disabled',async()=>{
  for(const state of ['pending','attempted']){
    const backend=memoryBackend();
    backend.entries.push({id:1,job:1,name:cards[0].name,signature:cards[0].signature,share:true,favorite_pending:false,
      colleague_share_state:state,collection_policy:customPolicy()});
    const changed=customPolicy({colleague_name:'王女士',share_mode:state==='attempted'?'none':'both'});
    const c=await controller({backend,batchCards:[cards[0]],storedPolicies:{1:changed}});
    await c.click('#start');
    assert.ok(!c.events.some(value=>/^(send-colleague|prepare-colleague):/.test(value)));
    assert.ok(!c.posted.includes('/api/extension/screen'));
    assert.match(c.element('#status').textContent,state==='pending'?/待转发记录.*收件人不同/:/人工核对/);
  }
});

test('resumed colleague sharing uses the saved screening score while stale or lower current scores cannot trigger greetings',async()=>{
  for(const currentScore of [null,70]){
    const backend=memoryBackend(),savedPolicy=greetingPolicy({share_mode:'colleague',share_above:80});
    savedGreetingCandidate(backend,{score:81,current_score:currentScore,colleague_share_score:81,
      colleague_share_state:'pending',collection_policy:savedPolicy});
    const currentPolicy={...savedPolicy,share_above:90};
    const c=await greetingController({backend,storedPolicies:{1:currentPolicy}});await c.click('#start');
    assert.deepEqual(c.opened,['一号']);
    assert.equal(backend.entries[0].colleague_share_state,'confirmed');
    assert.ok(c.events.includes('begin-colleague:张**'));assert.ok(c.events.includes('send-colleague:张**'));
    assert.ok(!c.events.some(event=>/^(copy|header-copy|evaluate|favorite|share|prepare-greeting|send-greeting):/.test(event)));
    assert.ok(!c.posted.includes('/api/extension/screen'));assert.ok(!c.posted.includes('/api/extension/greeting'));
    assert.equal(c.copyOptions.length,0);
    const again=await greetingController({backend,storedPolicies:{1:currentPolicy}});await again.click('#start');
    assert.deepEqual(again.opened,[]);assert.ok(!again.events.includes('send-colleague:张**'));
  }
});

test('explicit null, invalid or nonqualifying colleague sharing scores never fall back to a higher current score',async()=>{
  for(const shareScore of [null,80,79,'81',NaN,Infinity,101,undefined]){
    const backend=memoryBackend(),policy=customPolicy({share_mode:'colleague',share_above:80});
    savedGreetingCandidate(backend,{score:81,current_score:99,colleague_share_score:shareScore,
      colleague_share_state:'pending',collection_policy:policy});
    const c=await controller({backend,batchCards:[cards[0]],storedPolicies:{1:policy}});await c.click('#start');
    assert.match(c.element('#status').textContent,/站内转发分数不符合已保存/);
    assert.equal(backend.entries[0].colleague_share_state,'pending');
    assert.ok(!c.events.some(event=>/^(prepare-colleague|send-colleague|evaluate|favorite|copy):/.test(event)));
    assert.ok(!c.posted.includes('/api/extension/colleague-share'));
  }
});

test('legacy servers without a separate colleague score retain numeric compatibility but never permit explicit null',async()=>{
  for(const score of [81,null]){
    const backend=memoryBackend(),policy=customPolicy({share_mode:'colleague',share_above:80});
    savedGreetingCandidate(backend,{score:81,colleague_share_state:'pending',collection_policy:policy});
    const knownRecords=[{id:7,signature:cards[0].signature,has_image:true,favorite_pending:false,
      score,colleague_share_state:'pending',collection_policy:policy}];
    const c=await controller({backend,batchCards:[cards[0]],knownRecords,storedPolicies:{1:policy}});await c.click('#start');
    assert.equal(c.events.includes('send-colleague:张**'),score===81);
    assert.equal(backend.entries[0].colleague_share_state,score===81?'confirmed':'pending');
    assert.ok(!c.posted.includes('/api/extension/screen'));
    if(score===null)assert.match(c.element('#status').textContent,/站内转发分数不符合已保存/);
  }
});

test('a separate saved sharing score cannot override changed recipients or an already attempted send',async()=>{
  for(const state of ['pending','attempted']){
    const backend=memoryBackend(),policy=customPolicy({share_mode:'colleague',share_above:80});
    savedGreetingCandidate(backend,{score:81,current_score:null,colleague_share_score:81,
      colleague_share_state:state,collection_policy:policy});
    const currentPolicy={...policy,colleague_name:'王女士',share_mode:state==='attempted'?'none':'colleague'};
    const c=await controller({backend,batchCards:[cards[0]],storedPolicies:{1:currentPolicy}});await c.click('#start');
    assert.match(c.element('#status').textContent,state==='pending'?/收件人不同/:/可能已提交.*不会重复发送/);
    assert.equal(backend.entries[0].colleague_share_state,state);
    assert.ok(!c.events.some(event=>/^(prepare-colleague|send-colleague|evaluate|favorite|copy):/.test(event)));
  }
});

test('a chat sidebar cannot become a batch candidate list while current chat resume evaluation stays available',async()=>{
  const batch=await controller({tabPath:'/web/chat/index',listPath:'/web/chat/index'});
  await batch.click('#start');
  assert.deepEqual(batch.opened,[]);assert.equal(batch.lookupBatches.length,0);assert.equal(batch.backend.entries.length,0);
  assert.match(batch.element('#status').textContent,/聊天页.*单份简历/);
  const direct=await controller({preopened:true,batchCards:[cards[1]],tabPath:'/web/chat/index',listPath:'/web/chat/index'});
  await direct.click('#evaluate-current');
  assert.equal(direct.directResults[0]?.name,cards[1].name);assert.deepEqual(direct.opened,[]);
});

test('batch evaluates before saving, favorites, then saves QR before opening next',async()=>{
  const c=await controller();
  await c.click('#start');
  assert.deepEqual(c.events,cards.flatMap(({name,id})=>['open',...(id==='0'?['expand']:[]),'copy','evaluate','save','favorite','ack-favorite','share','save-share','close'].map(step=>`${step}:${name}`)));
  assert.ok(!c.posted.some(path=>path.includes('/ocr')));
  assert.match(c.element('#status').textContent,/已处理 2 位/);
  assert.equal(c.trackerActive(),false);
});

test('only scores strictly above 75 forward to the colleague after favorite',async()=>{
  const c=await controller({colleagueForward:true,scoreBySignature:{一号:75,二号:76}});
  await c.click('#start');
  assert.equal(c.backend.entries[0].colleague_share_state,undefined);
  assert.equal(c.backend.entries[1].colleague_share_state,'confirmed');
  assert.ok(!c.events.includes('send-colleague:张**'));
  const steps=c.events.filter(value=>value.endsWith(':李**'));
  assert.ok(steps.indexOf('ack-favorite:李**')<steps.indexOf('prepare-colleague:李**'));
  assert.ok(steps.indexOf('prepare-colleague:李**')<steps.indexOf('begin-colleague:李**'));
  assert.ok(steps.indexOf('begin-colleague:李**')<steps.indexOf('send-colleague:李**'));
  assert.ok(steps.indexOf('send-colleague:李**')<steps.indexOf('confirm-colleague:李**'));
  assert.ok(steps.indexOf('confirm-colleague:李**')<steps.indexOf('share:李**'));
});

test('uncertain colleague send stops and a resumed run does not send twice',async()=>{
  const backend=memoryBackend();
  const first=await controller({backend,colleagueForward:true,failColleagueToast:true,
    batchCards:[cards[0]],limit:'1'});
  await first.click('#start');
  assert.equal(backend.entries[0].colleague_share_state,'attempted');
  assert.equal(first.events.filter(value=>value==='send-colleague:张**').length,1);
  const retry=await controller({backend,colleagueForward:true,batchCards:[cards[0]],limit:'1'});
  await retry.click('#start');
  assert.ok(!retry.events.includes('send-colleague:张**'));
  assert.match(retry.element('#status').textContent,/人工核对/);
});

test('a share portal on the top page is cropped without the candidate iframe offset',async()=>{
  const c=await controller({batchCards:[cards[0]],limit:'1',sharePortalTop:true});
  await c.click('#start');
  assert.equal(c.backend.entries.length,1);
  assert.equal(c.backend.entries[0].share,true);
  assert.deepEqual(c.shareMetrics(),{checks:2,captures:1});
  assert.deepEqual(c.shareCrops,[[40,50,200,200]]);
  assert.ok(c.events.includes('save-share:张**'));
});

test('changed or navigated share windows abort before saving the screenshot',async()=>{
  for(const phase of [1,2])for(const kind of ['change','navigation']){
    const c=await controller({batchCards:[cards[0]],limit:'1',sharePortalTop:true,
      ...(kind==='change'?{shareLayoutChangeAt:phase}:{shareLayoutFailureAt:phase})});
    await c.click('#start');
    assert.equal(c.backend.entries.length,1);
    assert.equal(c.backend.entries[0].share,false);
    assert.equal(c.posted.includes('/api/candidates/share'),false);
    assert.deepEqual(c.shareCrops,[]);
    assert.deepEqual(c.shareMetrics(),{checks:phase,captures:phase-1});
    assert.match(c.element('#status').textContent,/分享窗口.*(?:已变化|已切换)/);
    assert.deepEqual(c.opened,['一号']);
  }
});

test('direct entry evaluates the already open DOM resume without list lookup or mutation',async()=>{
  const c=await controller({preopened:true,mode:'background',lockForeground:true,directEntry:true});
  assert.equal(c.element('#start').hidden,true);
  assert.equal(c.element('#collector-title').textContent,'当前简历评估');
  assert.match(c.element('#collector-guidance').textContent,/每轮只复制一次，最多自动展开一处/);
  assert.match(c.element('#collector-guidance').textContent,/按本次复制的简历评估；修改原文后请重新评估/);
  await c.click('#evaluate-current');
  assert.deepEqual(c.opened,[]);assert.equal(c.lookupBatches.length,0);
  assert.deepEqual(c.posted,['/api/extension/clipboard-preview','/api/extension/preview-resume']);
  assert.ok(c.events.includes('copy:张**'));
  assert.ok(!c.events.some(event=>event.startsWith('background-read:')));
  assert.equal(c.registrations.length,0);
  assert.equal(c.backend.entries.length,0);assert.equal(c.backend.lowMarks.length,0);assert.equal(c.backend.favorites.size,0);
  assert.equal(c.directResults[0].name,cards[0].name);assert.equal(c.element('#direct-result').hidden,false);
  assert.ok(!c.events.some(event=>/^(close|favorite|share|save|advance-list)/.test(event)));
  assert.equal(c.trackerActive(),false);
});

test('current Canvas evaluation uses exactly one snapshot copy and one model request without header or post-model copies',async()=>{
  const c=await controller({preopened:true,mode:'foreground',batchCards:[cards[1]],score:12});
  await c.click('#evaluate-current');
  assert.equal(c.directResults.length,1);
  assert.deepEqual(c.posted,['/api/extension/clipboard-preview','/api/extension/preview-resume']);
  assert.deepEqual(c.opened,[]);assert.equal(c.lookupBatches.length,0);
  assert.equal(c.registrations.length,0);
  assert.equal(c.backend.entries.length,0);assert.equal(c.backend.lowMarks.length,0);assert.equal(c.backend.favorites.size,0);
  assert.equal(c.events.filter(value=>value==='copy:李**').length,1);
  assert.equal(c.events.filter(value=>value==='header-copy:李**').length,0);
  assert.equal(c.events.filter(value=>value==='expand:李**').length,0);
  assert.equal(c.posted.filter(path=>path==='/api/extension/preview-resume').length,1);
  assert.ok(!c.events.some(value=>/^(open|close|favorite|share|save|background-read|identify|verify-identity):/.test(value)));
  assert.equal(c.directResults[0].name,cards[1].name);assert.equal(c.element('#direct-result').hidden,false);
  assert.equal(c.trackerActive(),false);
});

test('Canvas evaluation remains bound to the submitted snapshot when invisible same-root content changes during the model request',async()=>{
  for(const options of [{changeContentAfterPreview:true},{identityMismatch:true}]){
    const c=await controller({preopened:true,batchCards:[cards[1]],mode:'foreground',...options});
    await c.click('#evaluate-current');
    assert.equal(c.events.filter(value=>value==='header-copy:李**').length,0);
    assert.equal(c.events.filter(value=>value==='copy:李**').length,1);
    assert.equal(c.posted.filter(path=>path==='/api/extension/preview-resume').length,1);
    const sent=c.postedData.find(item=>item.path==='/api/extension/preview-resume').data.candidate.resume;
    assert.ok(sent.includes('30岁'));assert.ok(!sent.includes('新增项目内容'));
    assert.match(c.element('#status').textContent,/按本次复制的简历评估；修改原文后请重新评估/);
    assert.equal(c.directResults.length,1);assert.equal(c.element('#direct-result').hidden,false);
    assert.deepEqual(c.opened,[]);assert.equal(c.backend.entries.length,0);
  }
});

test('Canvas snapshot evaluation retains root binding before and after the model without another copy',async()=>{
  for(const [options,modelCalls,fullCopies] of [
    [{replaceAfterFirstCopy:true},0,1],
    [{replaceAfterPreview:true},1,1],
  ]){
    const c=await controller({preopened:true,batchCards:[cards[1]],mode:'foreground',...options});
    await c.click('#evaluate-current');
    assert.equal(c.events.filter(value=>value==='header-copy:李**').length,0);
    assert.equal(c.events.filter(value=>value==='copy:李**').length,fullCopies);
    assert.equal(c.posted.filter(path=>path==='/api/extension/preview-resume').length,modelCalls);
    assert.match(c.element('#status').textContent,/已切换/);
    assert.equal(c.directResults.length,0);assert.equal(c.element('#direct-result').hidden,true);
    assert.deepEqual(c.opened,[]);assert.equal(c.backend.entries.length,0);
  }
});

test('stopping during the only Canvas copy prevents model submission and result display',async()=>{
  const c=await controller({preopened:true,batchCards:[cards[1]],mode:'foreground',stopAfterFirstCopy:true});
  await c.click('#evaluate-current');
  assert.equal(c.events.filter(value=>value==='header-copy:李**').length,0);
  assert.equal(c.events.filter(value=>value==='copy:李**').length,1);
  assert.equal(c.posted.filter(path=>path==='/api/extension/preview-resume').length,0);
  assert.equal(c.directResults.length,0);assert.equal(c.element('#direct-result').hidden,true);
  assert.equal(c.backend.entries.length,0);assert.equal(c.trackerActive(),false);
});

test('a full-name Canvas resume with an activity badge evaluates through the current clipboard path',async()=>{
  const c=await controller({preopened:true,mode:'background',batchCards:[{id:'1',name:'沙一鸣',signature:'合成姓名'}],headerActivity:'刚刚活跃'});
  await c.click('#evaluate-current');
  assert.equal(c.directResults[0]?.name,'沙一鸣');assert.equal(c.backend.entries.length,0);
  assert.deepEqual(Array.from(c.requestedPermissions[0].permissions),['clipboardRead']);
  assert.equal(c.registrations.length,0);assert.equal(c.trackerActive(),false);
});

test('direct evaluation rejects lists, promotions and unmatched canvas owners without reading',async()=>{
  for(const options of [{},{promotionFrames:1},{preopened:true,batchCards:[cards[1]],scopeMismatch:true}]){
    const c=await controller({mode:'background',...options});await c.click('#evaluate-current');
    assert.equal(c.directResults.length,0);assert.deepEqual(c.posted,[]);assert.deepEqual(c.opened,[]);
    assert.ok(!c.events.some(event=>/read|copy|preview|dismiss/.test(event)));
  }
});

test('Canvas direct reading rejects an unknown header, mismatched body or replaced document before the model',async()=>{
  for(const options of [{invalidHeader:true},{headerMismatch:true},{replaceAfterFirstCopy:true,changingDocument:true}]){
    const c=await controller({preopened:true,batchCards:[cards[1]],mode:'foreground',...options});
    await c.click('#evaluate-current');
    assert.equal(c.element('#review').hidden,true);assert.ok(!c.posted.includes('/api/extension/preview-resume'));
    assert.deepEqual(c.opened,[]);assert.equal(c.directResults.length,0);assert.equal(c.trackerActive(),false);
    assert.match(c.element('#status').textContent,/页首|身份不一致|已切换/);
  }
});

test('Canvas direct evaluation requires full-copy evidence and never sends an incomplete resume to the model',async()=>{
  const c=await controller({preopened:true,batchCards:[cards[1]],mode:'foreground',incompleteProof:true});
  const task=c.click('#evaluate-current');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.ok(!c.posted.includes('/api/extension/preview-resume'));
  await c.click('#stop');await task;
  assert.equal(c.directResults.length,0);assert.equal(c.trackerActive(),false);
});

test('single-copy Canvas evidence rejects legacy output and requires one copy with explicit complete flags',async()=>{
  const proof={topVerified:true,bottomVerified:true,allScreensRead:true,stableBottomReads:1};
  for(const copyEvidence of [
    {copyCount:0},{copyCount:2},{copyCount:'1'},
    {completeness:{...proof,stableBottomReads:2}},
    {completeness:{...proof,topVerified:1}},
    {completeness:{...proof,bottomVerified:false}},
    {completeness:{...proof,allScreensRead:false}},
    {selection:'scroll-drag'},
    {selection:'scroll-drag',completeness:{...proof,stableBottomReads:2}},
  ]){
    const c=await controller({preopened:true,batchCards:[cards[1]],mode:'foreground',copyEvidence});
    const task=c.click('#evaluate-current');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(c.element('#review').hidden,false);
    assert.equal(c.events.filter(value=>value==='copy:李**').length,1);
    assert.ok(!c.posted.includes('/api/extension/preview-resume'));
    await c.click('#stop');await task;
    assert.equal(c.directResults.length,0);
  }
});

test('DOM copy evidence also rejects legacy selection and missing or repeated copy counts',async()=>{
  for(const copyEvidence of [{selection:'text-range'},{copyCount:undefined},{copyCount:2}]){
    const c=await controller({preopened:true,mode:'foreground',copyEvidence});
    const task=c.click('#evaluate-current');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(c.element('#review').hidden,false);
    assert.equal(c.events.filter(value=>value==='copy:张**').length,1);
    assert.ok(!c.posted.includes('/api/extension/preview-resume'));
    await c.click('#stop');await task;
    assert.equal(c.directResults.length,0);
  }
});

test('an unsuccessful single copy waits for an explicit retry before copying the Canvas again',async()=>{
  const c=await controller({preopened:true,batchCards:[cards[1]],mode:'foreground',folded:true});
  const task=c.click('#evaluate-current');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.equal(c.events.filter(value=>value==='copy:李**').length,1);
  assert.ok(!c.posted.includes('/api/extension/preview-resume'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.events.filter(value=>value==='copy:李**').length,1);
  await c.click('#review-retry');await task;
  assert.equal(c.events.filter(value=>value==='copy:李**').length,2);
  assert.equal(c.events.filter(value=>value==='header-copy:李**').length,0);
  assert.equal(c.posted.filter(path=>path==='/api/extension/preview-resume').length,1);
  assert.equal(c.directResults.length,1);
});

test('a copyCount zero preflight failure preserves its reason and waits for retry without formatter or model requests',async()=>{
  const reason='检测到多个展开控件，未能确认唯一的展开位置';
  const c=await controller({preopened:true,batchCards:[cards[1]],mode:'foreground',copyPreflightIssue:reason});
  const task=c.click('#evaluate-current');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.ok(c.element('#status').textContent.includes(reason));
  assert.deepEqual(c.posted,[]);
  assert.equal(c.events.filter(value=>value==='copy:李**').length,0);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.events.filter(value=>value==='copy-preflight-rejected:李**').length,1);
  assert.equal(c.events.filter(value=>value==='copy:李**').length,0);
  await c.click('#review-retry');await task;
  assert.equal(c.events.filter(value=>value==='copy:李**').length,1);
  assert.deepEqual(c.posted,['/api/extension/clipboard-preview','/api/extension/preview-resume']);
  assert.equal(c.directResults.length,1);
});

test('a partial copy issue is shown before identity discovery and never sent to the formatter',async()=>{
  const reason='本次复制只取得部分正文，请展开后重试';
  const c=await controller({preopened:true,batchCards:[cards[1]],mode:'foreground',
    copyEvidence:{issue:reason,resume:'工作经历\n不完整片段',resume_html:'',discoveredIdentity:undefined}});
  const task=c.click('#evaluate-current');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.ok(c.element('#status').textContent.includes(reason));
  assert.deepEqual(c.posted,[]);
  assert.equal(c.events.filter(value=>value==='copy:李**').length,1);
  await c.click('#stop');await task;
  assert.equal(c.directResults.length,0);
});

test('a replaced same-name DOM root is rejected before a bound direct read retries',async()=>{
  const c=await controller({preopened:true,mode:'background',domIncomplete:true});
  const task=c.click('#evaluate-current');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  c.replaceCurrent(cards[0]);await c.click('#review-retry');await task;
  assert.equal(c.events.filter(event=>event==='background-read:张**').length,1);
  assert.ok(!c.posted.includes('/api/extension/preview-resume'));
  assert.equal(c.directResults.length,0);assert.equal(c.trackerActive(),false);
  assert.match(c.element('#status').textContent,/已切换/);
});

test('current resume identity changes, model errors and cancellation never display stale results',async()=>{
  for(const options of [{switchAfterPreview:true},{previewFailure:true},{stopAt:'preview:李**'}]){
    const c=await controller({preopened:true,batchCards:[cards[1]],mode:'background',...options});
    await c.click('#evaluate-current');
    assert.equal(c.directResults.length,0);assert.equal(c.element('#direct-result').hidden,true);
    assert.deepEqual(c.opened,[]);assert.equal(c.backend.entries.length,0);assert.equal(c.backend.lowMarks.length,0);
    assert.equal(c.trackerActive(),false);
  }
});

test('in-place same-name DOM content changes invalidate results without switching roots',async()=>{
  const c=await controller({preopened:true,mode:'background',changeContentAfterPreview:true});
  await c.click('#evaluate-current');
  assert.equal(c.directResults.length,0);assert.equal(c.backend.entries.length,0);
  assert.match(c.element('#status').textContent,/原文已变化/);
});

test('direct read completeness failures cannot reach the model',async()=>{
  const c=await controller({preopened:true,mode:'background',domIncomplete:true});
  const task=c.click('#evaluate-current');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.ok(!c.posted.includes('/api/extension/preview-resume'));
  c.click('#stop');await task;
  assert.equal(c.directResults.length,0);assert.equal(c.trackerActive(),false);
});

test('stopping during diagnostic storage never creates a new pending review',async()=>{
  const c=await controller({preopened:true,mode:'background',domIncomplete:true,stopDuringDiagnostic:true});
  await c.click('#evaluate-current');
  assert.equal(c.element('#review').hidden,true);assert.equal(c.trackerActive(),false);
  assert.equal(c.element('#evaluate-current').disabled,false);
  assert.ok(!c.posted.includes('/api/extension/preview-resume'));
});

test('a preexisting hot recommendation modal is dismissed before normal list collection',async()=>{
  const c=await controller({promotionFrames:1});await c.click('#start');
  assert.equal(c.events[0],'dismiss-promotions');
  assert.deepEqual(c.opened,['一号','二号']);
  assert.equal(c.backend.entries.length,2);
});

test('promotion dismissal never guesses among frames or continues after a failed close',async()=>{
  for(const options of [{promotionFrames:2},{promotionFrames:1,failDismiss:true}]){
    const c=await controller(options);await c.click('#start');
    assert.deepEqual(c.opened,[]);assert.deepEqual(c.posted,[]);
    assert.match(c.element('#status').textContent,/热搜推荐弹层|热搜推荐弹层未关闭/);
    assert.equal(c.events.filter(event=>event==='dismiss-promotions').length,options.failDismiss?1:0);
  }
});

test('promotion appearing after a candidate closes is dismissed before the next list lookup',async()=>{
  const c=await controller({promotionAfterClose:true});await c.click('#start');
  assert.deepEqual(c.opened,['一号','二号']);
  const closed=c.events.indexOf('close:张**'),dismissed=c.events.indexOf('dismiss-promotions');
  assert.ok(closed<dismissed&&dismissed<c.events.indexOf('open:李**'));
});

test('an open action that unexpectedly yields a promotion never reads or evaluates its cards',async()=>{
  const c=await controller({openPromotion:true});await c.click('#start');
  assert.deepEqual(c.opened,['一号']);assert.equal(c.backend.entries.length,0);
  assert.ok(!c.events.some(event=>/^(copy|background-read|evaluate|dismiss-promotions):?/.test(event)));
  assert.match(c.element('#status').textContent,/打开的是热搜推荐弹层/);
});

test('full names from either list layout remain bound through collection and saving',async()=>{
  const names=[{id:'0',name:'顾文远',signature:'推荐一号'},
    {id:'1',name:'沈明轩',signature:'推荐二号',platform_geek_id:'102',boss_chat_uid:'98766'}];
  for(const mode of ['foreground','background']){
    const c=await controller({batchCards:names,mode});await c.click('#start');
    assert.deepEqual(c.opened,names.map(card=>card.signature));
    assert.deepEqual(c.backend.entries.map(entry=>entry.name),names.map(card=>card.name));
  }
});

test('transient duplicate cards settle before any card lookup, opening or saving',async()=>{
  const duplicate={...cards[0],id:'clone'};
  const c=await controller({batchCards:[cards[0],duplicate,cards[1]],
    onListScan:({index})=>index===1?{cards}:undefined});
  await c.click('#start');
  assert.equal(c.listWaits.length,1);
  assert.deepEqual(c.listWaits[0],{posted:0,opened:0});
  assert.deepEqual(c.opened,['一号','二号']);
  assert.equal(c.backend.entries.length,2);
  assert.deepEqual(c.lookupBatches[0].map(card=>card.signature),['一号','二号']);
});

test('fresh duplicates immediately before opening are rescanned without using the old card node',async()=>{
  const clone={...cards[0],id:'clone'};
  const fresh=[{...cards[0],id:'replacement'},cards[1]];
  const c=await controller({mode:'background',onListScan:({index})=>
    index===1?{cards:[cards[0],clone,cards[1]]}:index===2?{cards:fresh}:undefined});
  await c.click('#start');
  assert.equal(c.listWaits.length,1);
  assert.equal(c.listWaits[0].opened,0);
  assert.equal(c.listWaits[0].posted,1); // The initial read-only status lookup already ran.
  assert.deepEqual(c.opened,['一号','二号']);
  assert.equal(c.backend.entries.length,2);
});

test('persistent identical cards are deferred after three bounded waits without opening or saving',async()=>{
  const c=await controller({batchCards:[cards[0],{...cards[0],id:'clone'}]});
  await c.click('#start');
  assert.equal(c.listWaits.length,3);
  assert.equal(c.listSnapshots.length,4);
  assert.ok(c.listWaits.every(wait=>wait.posted===0&&wait.opened===0));
  assert.deepEqual(c.opened,[]);assert.deepEqual(c.posted,[]);
  assert.equal(c.backend.entries.length,0);
  assert.match(c.element('#status').textContent,/已处理 0 位.*暂缓 1 组重复卡片/);
  assert.match(c.lines[0].textContent,/暂缓/);
});

test('stopping while duplicate cards settle prevents another scan, open or backend write',async()=>{
  const c=await controller({batchCards:[cards[0],{...cards[0],id:'clone'}],stopOnListWait:true});
  await c.click('#start');
  assert.equal(c.listWaits.length,1);assert.equal(c.listSnapshots.length,1);
  assert.deepEqual(c.opened,[]);assert.deepEqual(c.posted,[]);
  assert.equal(c.backend.entries.length,0);
  assert.match(c.element('#status').textContent,/停止/);
});

test('a changed list document during a duplicate rescan is not accepted as the original list',async()=>{
  const c=await controller({batchCards:[cards[0],{...cards[0],id:'clone'}],
    onListScan:({index})=>index===1?{cards,documentId:'replaced-list'}:undefined});
  await c.click('#start');
  assert.equal(c.listWaits.length,1);
  assert.deepEqual(c.opened,[]);assert.deepEqual(c.posted,[]);
  assert.equal(c.backend.entries.length,0);
  assert.match(c.element('#status').textContent,/页面框架已关闭或切换/);
});

test('a duplicate introduced after three completed candidates settles before the fourth',async()=>{
  const batch=[...cards,{id:'2',name:'王**',signature:'三号',platform_geek_id:'102',boss_chat_uid:'98766'},
    {id:'3',name:'谢**',signature:'四号',platform_geek_id:'103',boss_chat_uid:'98767'}];
  let introduced=false,cleared=false;
  const c=await controller({batchCards:batch,limit:'4',onListScan:({closed})=>{
    if(closed!==3)return;
    if(!introduced){introduced=true;return {cards:[...batch,{...batch[3],id:'clone'}]};}
    if(!cleared){cleared=true;return {cards:batch};}
  }});
  await c.click('#start');
  assert.equal(c.listWaits.length,1);assert.equal(c.listWaits[0].opened,3);
  assert.deepEqual(c.opened,['一号','二号','三号','四号']);
  assert.equal(c.backend.entries.length,4);
  assert.match(c.element('#status').textContent,/已处理 4 位/);
  const waiting=c.listSnapshots.findIndex(snapshot=>snapshot.closed===3&&snapshot.signatures.length===5);
  assert.equal(c.listSnapshots[waiting].posted,c.listSnapshots[waiting+1].posted);
});

test('persistent duplicate groups do not block unrelated candidates or acquire collection marks',async()=>{
  const duplicate={...cards[0],id:'clone'};
  const c=await controller({batchCards:[cards[0],duplicate,cards[1]],limit:'2'});
  await c.click('#start');
  assert.equal(c.listWaits.length,3);
  assert.deepEqual(c.opened,['二号']);
  assert.deepEqual(c.lookupBatches.flat().map(card=>card.signature),['二号']);
  assert.deepEqual(c.backend.entries.map(entry=>entry.signature),['二号']);
  assert.deepEqual([...c.backend.favorites],['二号']);
  assert.ok(!c.events.some(event=>event.endsWith(':张**')));
  assert.match(c.element('#status').textContent,/已处理 1 位.*暂缓 1 组重复卡片/);
  assert.equal(c.lines.filter(line=>line.textContent.includes('暂缓')).length,1);
});

test('deferring one duplicate signature does not defer a different candidate with the same masked name',async()=>{
  const distinct={id:'2',name:cards[0].name,signature:'另一个张氏候选人',platform_geek_id:'102',boss_chat_uid:'98766'};
  const c=await controller({batchCards:[cards[0],{...cards[0],id:'clone'},distinct],limit:'1'});
  await c.click('#start');
  assert.deepEqual(c.opened,[distinct.signature]);
  assert.deepEqual(c.lookupBatches.flat().map(card=>card.signature),[distinct.signature]);
  assert.deepEqual(c.backend.entries.map(entry=>entry.signature),[distinct.signature]);
  assert.equal(c.listWaits.length,3);
});

test('a deferred unsaved signature becomes eligible when the list later makes it unique',async()=>{
  const c=await controller({batchCards:[cards[0],{...cards[0],id:'clone'},cards[1]],limit:'2',
    onListScan:({closed})=>closed===1?{cards}:undefined});
  await c.click('#start');
  assert.deepEqual(c.opened,['二号','一号']);
  assert.deepEqual(c.lookupBatches.flat().map(card=>card.signature),['二号','一号']);
  assert.deepEqual(c.backend.entries.map(entry=>entry.signature),['二号','一号']);
  assert.equal(c.listWaits.length,3);
  assert.match(c.lines[0].textContent,/重复已消除/);
  assert.doesNotMatch(c.element('#status').textContent,/暂缓 [1-9]/);
});

test('a candidate that becomes persistently ambiguous just before open is deferred while others continue',async()=>{
  const duplicate={...cards[0],id:'clone'};
  const c=await controller({onListScan:({index})=>index===1?{cards:[cards[0],duplicate,cards[1]]}:undefined});
  await c.click('#start');
  assert.deepEqual(c.opened,['二号']);
  assert.equal(c.listWaits.length,3);
  assert.deepEqual(c.backend.entries.map(entry=>entry.signature),['二号']);
  assert.ok(!c.events.some(event=>/^(copy|evaluate|save|favorite|share):张/.test(event)));
  assert.match(c.element('#status').textContent,/已处理 1 位.*暂缓 1 组重复卡片/);
});

test('persistent duplicates introduced after three completions leave the fifth candidate available',async()=>{
  const batch=[...cards,{id:'2',name:'王**',signature:'三号',platform_geek_id:'102',boss_chat_uid:'98766'},
    {id:'3',name:'谢**',signature:'四号',platform_geek_id:'103',boss_chat_uid:'98767'},
    {id:'4',name:'孙**',signature:'五号',platform_geek_id:'104',boss_chat_uid:'98768'}];
  const c=await controller({batchCards:batch,limit:'4',onListScan:({closed})=>
    closed===3?{cards:[...batch,{...batch[3],id:'clone'}]}:undefined});
  await c.click('#start');
  assert.deepEqual(c.opened,['一号','二号','三号','五号']);
  assert.equal(c.listWaits.length,3);
  assert.deepEqual(c.backend.entries.map(entry=>entry.signature),c.opened);
  assert.ok(!c.events.some(event=>event.endsWith(':谢**')));
  assert.match(c.element('#status').textContent,/已处理 4 位.*暂缓 1 组重复卡片/);
});

test('continuous deferral advances and waits without repeatedly settling the same ambiguous group',async()=>{
  const duplicate=[cards[0],{...cards[0],id:'clone'}];
  const c=await controller({batchCards:duplicate,limit:'',advancePages:[duplicate,cards]});
  await c.click('#start');
  assert.equal(c.listWaits.length,3);
  assert.equal(c.events.filter(event=>event==='advance-list').length,3);
  assert.deepEqual(c.opened,['一号','二号']);
  assert.deepEqual(c.lookupBatches.flat().map(card=>card.signature),['一号','二号']);
  assert.equal(c.backend.entries.length,2);
});

test('a run containing only ambiguous cards leaves no persistent completion barrier',async()=>{
  const c=await controller({batchCards:[cards[0],{...cards[0],id:'clone'}],limit:'1'});
  await c.click('#start');
  assert.deepEqual(c.posted,[]);
  c.setCards([cards[0]]);
  await c.click('#start');
  assert.deepEqual(c.opened,['一号']);
  assert.equal(c.backend.entries.length,1);
  assert.deepEqual(c.lookupBatches.flat().map(card=>card.signature),['一号']);
});

test('a saved pending favorite that becomes ambiguous is not rebound to a remaining copy within the run',async()=>{
  const backend=memoryBackend();
  backend.entries.push({id:backend.nextId++,job:1,name:cards[0].name,signature:cards[0].signature,
    share:false,favorite_pending:true});
  const c=await controller({backend,limit:'2',onListScan:({index,closed})=>
    closed===1?{cards}:index===1?{cards:[cards[0],{...cards[0],id:'clone'},cards[1]]}:undefined});
  await c.click('#start');
  assert.deepEqual(c.opened,['二号']);
  assert.equal(c.listWaits.length,3);
  assert.ok(!c.events.some(event=>event.endsWith(':张**')));
  assert.equal(backend.entries[0].favorite_pending,true);
  assert.equal(backend.entries[0].share,false);
  assert.ok(!backend.favorites.has('一号'));
  assert.deepEqual(c.lookupBatches.flat().map(card=>card.signature),['一号','二号']);
  assert.match(c.element('#status').textContent,/暂缓 1 组重复卡片/);
  const retry=await controller({backend,batchCards:cards,limit:'1'});
  await retry.click('#start');
  assert.deepEqual(retry.opened,['一号']);
  assert.ok(!retry.posted.includes('/api/extension/screen'));
  assert.equal(backend.entries[0].favorite_pending,false);
});

test('a transient duplicate invalidates a known pending favorite even after one rescan leaves a single copy',async()=>{
  const backend=memoryBackend();
  backend.entries.push({id:backend.nextId++,job:1,name:cards[0].name,signature:cards[0].signature,
    share:false,favorite_pending:true});
  const replacement=[{...cards[0],id:'replacement'},cards[1]];
  const c=await controller({backend,limit:'2',onListScan:({index})=>
    index===1?{cards:[cards[0],{...cards[0],id:'clone'},cards[1]]}:
      index===2?{cards:replacement}:undefined});
  await c.click('#start');
  assert.equal(c.listWaits.length,1);
  assert.deepEqual(c.listSnapshots[2].signatures,['一号','二号']);
  assert.deepEqual(c.opened,['二号']);
  assert.ok(!c.events.some(event=>event.endsWith(':张**')));
  assert.deepEqual(c.lookupBatches.flat().map(card=>card.signature),['一号','二号']);
  assert.equal(backend.entries[0].favorite_pending,true);
  assert.equal(backend.entries[0].share,false);
  assert.deepEqual([...backend.favorites],['二号']);
  assert.equal(c.posted.filter(path=>path==='/api/extension/screen').length,1);
  assert.equal(c.posted.filter(path=>path==='/api/extension/favorite-complete').length,1);
  assert.equal(c.posted.filter(path=>path==='/api/candidates/share').length,1);
  assert.match(c.element('#status').textContent,/已处理 1 位.*暂缓 1 组重复卡片/);
});

test('a finite run defers a fresh duplicate group that disappears during rescan and continues the next candidate',async()=>{
  const c=await controller({limit:'2',onListScan:({index})=>
    index===1?{cards:[cards[0],{...cards[0],id:'clone'},cards[1]]}:
      index===2?{cards:[cards[1]]}:undefined});
  await c.click('#start');
  assert.equal(c.listWaits.length,1);
  assert.deepEqual(c.listSnapshots[2].signatures,['二号']);
  assert.deepEqual(c.opened,['二号']);
  assert.ok(!c.events.some(event=>event.endsWith(':张**')));
  assert.deepEqual(c.backend.entries.map(entry=>entry.signature),['二号']);
  assert.deepEqual([...c.backend.favorites],['二号']);
  assert.match(c.lines[0].textContent,/张\*\*.*暂缓/);
  assert.match(c.element('#status').textContent,/已处理 1 位.*暂缓 1 组重复卡片/);
  assert.doesNotMatch(c.element('#status').textContent,/无法确认要打开/);
});

test('batch leaves the candidate open and does not advance when any required save fails',async()=>{
  for(const [flag,error] of [['failImport','保存履历失败'],['failShare','保存二维码失败']]){
    const c=await controller({[flag]:true});
    await c.click('#start');
    assert.match(c.element('#status').textContent,new RegExp(error));
    assert.ok(!c.events.includes('open:李**'));
    assert.ok(!c.events.includes('close:张**'));
    assert.equal(c.events.includes('save:张**'),flag==='failShare');
  }
});

test('folded content pauses the same batch and retries the same candidate before saving',async()=>{
  const c=await controller({folded:true});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.ok(!c.events.some(event=>event.startsWith('save:')));
  c.click('#review-retry');
  await task;
  assert.equal(c.events.filter(event=>event==='copy:张**').length,2);
  assert.equal(c.events.filter(event=>event==='open:张**').length,1);
  assert.ok(c.events.indexOf('save-share:张**')<c.events.indexOf('open:李**'));
});

test('an unread scroll segment blocks saving and advancing until the same candidate is retried',async()=>{
  const c=await controller({missingScreen:true});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(c.element('#status').textContent,/第 2 屏/);
  assert.ok(!c.events.some(event=>event.startsWith('save:')||event==='open:李**'));
  c.click('#review-retry');
  await task;
  assert.ok(c.events.indexOf('save-share:张**')<c.events.indexOf('open:李**'));
});

test('screening always finishes before saving, favoriting and advancing',async()=>{
  const c=await controller();
  await c.click('#start');
  assert.ok(c.events.indexOf('evaluate:张**')<c.events.indexOf('open:李**'));
  assert.equal(c.element('#review').hidden,true);
  assert.ok(c.events.indexOf('evaluate:李**')<c.events.indexOf('close:李**'));
});

test('continues after saved data when AI evidence is rejected',async()=>{
  const c=await controller({rejectEvidence:true});
  await c.click('#start');
  assert.ok(c.events.indexOf('evaluate:张**')<c.events.indexOf('save:张**'));
  assert.ok(c.events.indexOf('save:张**')<c.events.indexOf('close:张**'));
  assert.ok(c.events.indexOf('close:张**')<c.events.indexOf('open:李**'));
  assert.ok(c.events.includes('evaluate:李**'));
  assert.match(c.element('#status').textContent,/已处理 2 位.*1 位 AI 待评估/);
});

test('invalid AI format leaves saved resume and QR intact and continues the next candidate without recopying',async()=>{
  const backend=memoryBackend();
  const c=await controller({backend,invalidAiFormat:true});
  await c.click('#start');
  assert.ok(c.events.indexOf('evaluate:张**')<c.events.indexOf('save:张**'));
  assert.ok(c.events.indexOf('save:张**')<c.events.indexOf('close:张**'));
  assert.ok(c.events.indexOf('close:张**')<c.events.indexOf('open:李**'));
  assert.ok(c.events.includes('evaluate:李**'));
  for(const step of ['copy','save','save-share']){
    assert.equal(c.events.filter(event=>event===step+':张**').length,1);
  }
  assert.match(c.lines[0].textContent,/AI|评估/);
  assert.match(c.element('#status').textContent,/已处理 2 位.*1 位 AI 待评估/);
  assert.equal(backend.entries.length,2);
  assert.ok(backend.entries.every(entry=>entry.share));
  const reopened=await controller({backend});
  await reopened.click('#start');
  assert.deepEqual(reopened.opened,[]);
  assert.ok(!reopened.posted.some(path=>['/api/extension/clipboard-preview','/api/extension/screen','/api/candidates/share','/api/ai/evaluate'].includes(path)));
});

test('a model connection failure saves diagnostics, favorites and continues after screening',async()=>{
  const c=await controller({failAi:true});
  await c.click('#start');
  assert.deepEqual(c.opened,['一号','二号']);
  assert.equal(c.backend.entries.length,2);
  assert.ok(c.backend.entries.every(entry=>entry.share&&entry.ai_pending&&entry.diagnostic.reason==='模型连接失败'));
  assert.ok(c.events.includes('favorite:张**'));
  assert.ok(c.events.includes('close:张**'));
});

test('the 55 point threshold is strict and low scores have no candidate, favorite or QR writes',async()=>{
  for(const score of [0,54.99,55,55.01,56,100]){
    const c=await controller({score,batchCards:[cards[0]]});
    await c.click('#start');
    const saved=score>55;
    assert.equal(c.backend.entries.length,saved?1:0,`score ${score}`);
    assert.equal(c.events.includes('favorite:张**'),saved);
    assert.equal(c.events.includes('save-share:张**'),saved);
    assert.equal(c.posted.includes('/api/extension/favorite-complete'),saved);
    assert.ok(c.events.includes('evaluate:张**'));
    assert.ok(c.events.includes('close:张**'));
    if(!saved){
      assert.match(c.lines[0].textContent,/未高于 55 分，未保存履历，已保留采集标记/);
      assert.equal(c.backend.lowMarks.length,1);
    }
    else assert.ok(c.events.indexOf('evaluate:张**')<c.events.indexOf('save:张**'));
    assert.ok(!c.posted.some(path=>['/api/extension/import','/api/ai/evaluate'].includes(path)));
  }
});

test('low scores count toward the requested number rather than seeking that many saved candidates',async()=>{
  const c=await controller({score:55,limit:'1'});
  await c.click('#start');
  assert.deepEqual(c.opened,['一号']);
  assert.equal(c.backend.entries.length,0);
  assert.match(c.element('#status').textContent,/已处理 1 位.*保存 0 位.*低分未保存 1 位/);
});

test('ambiguous clipboard overlap skips the current resume without a record or mark, then opens the next card',async()=>{
  const backend=memoryBackend();
  const overlap={issue:'相邻分屏含较长重复文字，但无法确认唯一衔接位置，尚未确认正文连续。',
    issueCode:'ambiguous-overlap'};
  const c=await controller({backend,batchCards:[cards[1],cards[0]],limit:'1',
    clipboardIssueBySignature:{'二号':overlap}});
  await c.click('#start');
  assert.deepEqual(c.opened,['二号','一号']);
  assert.ok(c.events.indexOf('close:李**')<c.events.indexOf('open:张**'));
  assert.equal(c.element('#review').hidden,true);
  assert.equal(backend.entries.length,1);
  assert.equal(backend.entries[0].signature,'一号');
  assert.equal(backend.lowMarks.length,0);
  assert.ok(!c.events.some(value=>/^(evaluate|save|favorite|share):李/.test(value)));
  assert.match(c.lines[0].textContent,/已跳过；本次未评估、未保存、未标记/);
  assert.match(c.element('#status').textContent,/已处理 1 位/);
  assert.match(c.element('#status').textContent,/文字衔接未确认跳过 1 位/);

  const retry=await controller({backend,batchCards:[cards[1]],limit:'1'});
  await retry.click('#start');
  assert.deepEqual(retry.opened,['二号']);
  assert.equal(backend.entries.length,2);
});

test('the same overlap issue still waits for review in direct evaluation',async()=>{
  const c=await controller({preopened:true,batchCards:[cards[0]],
    clipboardIssueBySignature:{'一号':{issue:'相邻分屏含较长重复文字，但无法确认唯一衔接位置，尚未确认正文连续。',
      issueCode:'ambiguous-overlap'}}});
  const task=c.click('#evaluate-current');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.equal(c.backend.entries.length,0);
  assert.ok(!c.posted.includes('/api/extension/preview-resume'));
  c.click('#stop');
  await task;
});

test('persistent low score marks skip cards within the run and in a fresh collector without candidate records',async()=>{
  const backend=memoryBackend();
  const c=await controller({backend,score:55,limit:'',advancePages:[[cards[1],cards[0]]]});
  await c.click('#start');
  assert.deepEqual(c.opened,['一号','二号']);
  assert.equal(c.events.filter(value=>value.startsWith('evaluate:')).length,2);
  assert.equal(backend.entries.length,0);
  assert.equal(backend.lowMarks.length,2);
  const retry=await controller({backend,score:56,limit:'1'});
  await retry.click('#start');
  assert.deepEqual(retry.opened,[]);
  assert.equal(backend.entries.length,0);
  assert.ok(!retry.posted.some(path=>['/api/extension/clipboard-preview','/api/extension/screen',
    '/api/extension/favorite-complete','/api/candidates/share'].includes(path)));
  assert.match(retry.element('#status').textContent,/2 位候选人均已采集/);
});

test('a low score marked card is skipped while a new card is still evaluated and saved',async()=>{
  const backend=memoryBackend();
  const first=await controller({backend,score:42,batchCards:[cards[0]]});
  await first.click('#start');
  const next=await controller({backend,score:82});
  await next.click('#start');
  assert.deepEqual(next.opened,['二号']);
  assert.equal(next.events.includes('evaluate:张**'),false);
  assert.equal(next.events.includes('favorite:张**'),false);
  assert.equal(next.events.includes('share:张**'),false);
  assert.equal(backend.entries.length,1);
  assert.equal(backend.entries[0].signature,'二号');
});

test('an explicit rules rejection shows its reason, marks the card and continues without contacting that candidate',async()=>{
  const backend=memoryBackend(),c=await greetingController({backend,batchCards:recommendationCards,
    rulesBySignature:{一号:ruleScreen()},limit:'2'});
  await c.click('#start');
  assert.deepEqual(c.opened,['一号','二号']);
  assert.ok(c.events.includes('precheck:张**'));
  assert.ok(!c.events.some(event=>/^(evaluate|save|favorite|share|send-colleague|prepare-greeting|send-greeting):张/.test(event)));
  assert.ok(c.events.indexOf('close:张**')<c.events.indexOf('open:李**'));
  assert.equal(backend.entries.length,1);assert.equal(backend.entries[0].signature,'二号');
  assert.equal(backend.lowMarks.length,1);
  assert.match(c.lines[0].textContent,/规则预筛未达标.*至少 6 年工作经验.*原文明示 5 年.*未调用模型/);
  assert.doesNotMatch(c.lines[0].textContent,/null|匹配度/);
  assert.match(c.element('#status').textContent,/低分未保存 0 位，规则预筛未达标 1 位/);
  const resumed=await controller({backend,batchCards:[cards[0]],storedPolicies:{1:greetingPolicy()}});
  await resumed.click('#start');assert.deepEqual(resumed.opened,[]);
  assert.ok(!resumed.posted.includes('/api/extension/screen'));
});

test('malformed rule refusal markers or evidence stop before skip, favorite, sharing or contacting',async()=>{
  const mutations=[value=>{delete value.evaluation_method;},value=>{value.score=0;},
    value=>{value.saved=true;},value=>{value.ai_pending=true;},value=>{value.favorite_pending=true;},
    value=>{value.collection_marked=false;},value=>{value.id=8;},
    value=>{value.collection_policy=customPolicy({save_above:20});},
    value=>{value.precheck.version='unknown';},value=>{value.precheck.rejected=false;},
    value=>{value.precheck.checks=[];},value=>{value.precheck.checks[0].requirement_id=0;},
    value=>{value.precheck.checks[0].rule_id='';},value=>{value.precheck.checks[0].condition=' ';},
    value=>{value.precheck.checks[0].reasoning='';},value=>{value.precheck.checks[0].basis='inferred';},
    value=>{value.precheck.checks[0].status='信息不足';},value=>{value.precheck.checks[0].evidence_lines=[];},
    value=>{value.precheck.checks[0].evidence_lines=[0];},value=>{value.precheck.checks[0].evidence_lines=['4'];},
    value=>{value.precheck.checks[0].evidence_lines=[4,5];},value=>{value.precheck.checks[0].evidence_quotes=[''];},
    value=>{value.precheck.checks[0].evidence_quotes=[{}];}];
  for(const mutate of mutations){
    const response=ruleScreen();mutate(response);
    const c=await controller({screenReply:response});await c.click('#start');
    assert.deepEqual(c.opened,['一号']);
    assert.match(c.element('#status').textContent,/筛选结果|规则预筛结果/);
    assert.ok(!c.events.some(event=>/^(favorite|share|send-colleague|send-greeting|close):/.test(event)));
    assert.equal(c.backend.entries.length,0);assert.equal(c.backend.lowMarks.length,0);
  }
});

test('direct rule refusals report no model invocation and never display a null score',async()=>{
  const c=await controller({preopened:true,previewResult:ruleResult()});await c.click('#evaluate-current');
  assert.equal(c.directResults.length,1);assert.equal(c.directResults[0].result.score,null);
  assert.match(c.element('#status').textContent,/规则预筛未达标，未调用模型/);
  assert.doesNotMatch(c.element('#status').textContent,/null|匹配度/);
  assert.equal(c.copyOptions.filter(value=>!value.headerOnly).length,1);
  assert.ok(!c.events.some(event=>/^(favorite|share|send-colleague|send-greeting|save|close):/.test(event)));
  assert.equal(c.backend.entries.length,0);
  const bad=ruleResult();bad.precheck.checks[0].evidence_quotes=[''];
  const rejected=await controller({preopened:true,previewResult:bad});await rejected.click('#evaluate-current');
  assert.equal(rejected.directResults.length,0);assert.match(rejected.element('#status').textContent,/原文依据/);
});

test('a committed low score mark survives a lost screening response and prevents a new paid evaluation',async()=>{
  const backend=memoryBackend();
  const first=await controller({backend,score:42,batchCards:[cards[0]],loseScreenResponse:true});
  await first.click('#start');
  assert.equal(backend.lowMarks.length,1);
  assert.equal(backend.entries.length,0);
  assert.ok(!first.events.some(value=>/^(favorite|share|close):/.test(value)));
  const next=await controller({backend,batchCards:[cards[0]]});
  await next.click('#start');
  assert.deepEqual(next.opened,[]);
  assert.ok(!next.posted.includes('/api/extension/screen'));
});

test('a failed screen request pauses before writing or favoriting and never advances',async()=>{
  const c=await controller({failScreen:true});
  await c.click('#start');
  assert.deepEqual(c.opened,['一号']);
  assert.equal(c.backend.entries.length,0);
  assert.ok(!c.events.some(value=>/^(favorite|share|close):/.test(value)));
  assert.match(c.element('#status').textContent,/筛选服务暂不可用/);
});

test('unconfirmed screen responses cannot trigger favorites, QR saving or advancing',async()=>{
  for(const screenReply of [
    {},{saved:false,score:56,ai_pending:false},{saved:false,score:55,ai_pending:true},
    {saved:false,score:'55',ai_pending:false},{saved:false,score:55,ai_pending:false,id:2},
    {saved:false,score:55,ai_pending:false,favorite_pending:false},
    {saved:false,score:55,ai_pending:false,favorite_pending:false,collection_marked:false},
    {saved:false,score:55,ai_pending:false,favorite_pending:false,collection_marked:'true'},
    {saved:false,score:55,ai_pending:false,favorite_pending:true,collection_marked:true},
    {saved:true,id:1,score:55,ai_pending:false,favorite_pending:true},
    {saved:true,id:1,score:101,ai_pending:false,favorite_pending:true},
    {saved:true,id:'1',score:56,ai_pending:false,favorite_pending:true},
    {saved:true,id:1,score:56,ai_pending:false},
  ]){
    const c=await controller({screenReply});
    await c.click('#start');
    assert.deepEqual(c.opened,['一号']);
    assert.ok(!c.events.some(value=>/^(favorite|share|close):/.test(value)));
    assert.match(c.element('#status').textContent,/筛选结果/);
  }
});

test('an idempotent saved response with favorite already acknowledged does not click or acknowledge it again',async()=>{
  const c=await controller({batchCards:[cards[0]],screenReply:{saved:true,id:12,score:82,
    ai_pending:false,favorite_pending:false,cached:true}});
  c.element('#share').checked=false;
  await c.click('#start');
  assert.ok(c.events.includes('evaluate:张**'));
  assert.ok(c.events.includes('close:张**'));
  assert.ok(!c.events.some(value=>value.startsWith('favorite:')||value.startsWith('favorite-existing:')));
  assert.ok(!c.posted.includes('/api/extension/favorite-complete'));
  assert.ok(!c.posted.includes('/api/candidates/share'));
  assert.match(c.lines[0].textContent,/收藏.*确认/);
  assert.match(c.element('#status').textContent,/已处理 1 位.*保存 1 位/);
});

test('an unconfirmed favorite removes unreachable resume and marker so the next run may collect again',async()=>{
  const backend=memoryBackend();
  const first=await controller({backend,failFavorite:true,limit:'1'});
  await first.click('#start');
  assert.deepEqual(first.opened,['一号']);
  assert.equal(backend.entries.length,0);assert.equal(backend.lowMarks.length,0);
  assert.ok(first.events.includes('rollback:张**'));
  assert.match(first.lines[0].textContent,/已删除履历及采集标记/);
  assert.doesNotMatch(first.lines[0].textContent,/履历已保存/);
  assert.ok(!first.events.includes('close:张**'));
  const retry=await controller({backend,limit:'1'});
  await retry.click('#start');
  assert.deepEqual(retry.opened,['一号']);
  assert.ok(retry.events.includes('evaluate:张**'));assert.ok(retry.events.includes('favorite:张**'));
  assert.equal(backend.entries.length,1);assert.equal(backend.entries[0].favorite_pending,false);
});

test('a confirmed favorite with a failed acknowledgement is retained and repaired without reevaluation',async()=>{
  const backend=memoryBackend();
  const first=await controller({backend,failFavoriteAck:true,limit:'1'});
  await first.click('#start');
  assert.equal(backend.entries.length,1);assert.equal(backend.entries[0].favorite_pending,true);
  assert.ok(!first.posted.includes('/api/extension/rollback-unreachable'));
  const retry=await controller({backend,limit:'1'});
  await retry.click('#start');
  assert.deepEqual(retry.opened,['一号']);
  assert.ok(!retry.posted.includes('/api/extension/screen'));
  assert.ok(retry.events.includes('copy:张**'));assert.ok(retry.events.includes('favorite-existing:张**'));
  assert.equal(backend.entries[0].favorite_pending,false);assert.equal(backend.entries[0].share,true);
});

test('an uncertain post-click result or lost favorite response retains the record for confirmation',async()=>{
  for(const uncertainFavorite of ['post-click','transport']){
    const backend=memoryBackend();
    const first=await controller({backend,uncertainFavorite,limit:'1'});
    await first.click('#start');
    assert.equal(backend.entries.length,1);assert.equal(backend.entries[0].favorite_pending,true);
    assert.ok(first.events.includes('favorite:张**'));
    assert.ok(!first.posted.includes('/api/extension/rollback-unreachable'));
    assert.ok(!first.events.includes('close:张**'));
    const retry=await controller({backend,limit:'1'});
    await retry.click('#start');
    assert.ok(!retry.posted.includes('/api/extension/screen'));
    assert.ok(retry.events.includes('favorite-existing:张**'));
    assert.ok(!retry.events.includes('favorite:张**'));
    assert.equal(backend.entries[0].favorite_pending,false);
  }
});

test('canvas favorite rejects a changed receipt identity without copying a second header',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',receiptChanged:true});
  await c.click('#start');
  assert.ok(!c.events.includes('header-copy:李**'));assert.equal(c.copyOptions.length,1);
  assert.ok(!c.events.some(value=>/^(favorite|ack-favorite|share|close):/.test(value)));
  assert.equal(c.backend.entries.length,0);assert.equal(c.backend.lowMarks.length,0);
  assert.ok(c.events.includes('rollback:李**'));
});

test('canvas favorite tolerates a changed online badge while identity attributes match',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',headerActivity:'在线'});
  await c.click('#start');
  assert.ok(!c.events.includes('header-copy:李**'));assert.equal(c.copyOptions.length,1);assert.ok(c.events.includes('favorite:李**'));
  assert.equal(c.backend.entries.length,1);assert.equal(c.backend.entries[0].favorite_pending,false);
  assert.ok(!c.posted.includes('/api/extension/rollback-unreachable'));
});

test('Canvas selection remains selected while one full-copy receipt authorizes collection without header recopy',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',headerMismatch:true});
  await c.click('#start');
  assert.equal(c.copyOptions.length,1);assert.equal(c.copyOptions[0].singlePass,true);
  assert.ok(!c.events.some(event=>event.startsWith('header-copy:')));
  assert.deepEqual(c.receiptStages.filter(item=>['prepare','seal','verify','click'].includes(item.action)),[
    {action:'prepare',copies:0,saves:0},{action:'seal',copies:1,saves:0},
    {action:'verify',copies:1,saves:1},{action:'click',copies:1,saves:1},
  ]);
  assert.equal(c.events.filter(event=>event==='favorite:李**').length,1);
  assert.ok(c.receiptActions.filter(args=>args.action==='stop').every(args=>typeof args.token==='string'));
});

test('collector viewport recovery stays maximized across candidates and restores once after the whole run',async()=>{
  const c=await controller({fitViewportRequest:true});await c.click('#start');
  assert.deepEqual(c.fitResults,[true,false]);
  assert.deepEqual(c.windowUpdates,[{state:'maximized'},{state:'normal',left:60,top:40,width:900,height:740}]);
  assert.equal(c.copyOptions.length,2);assert.equal(c.posted.filter(path=>path==='/api/extension/screen').length,2);
  assert.ok(c.copyOptions.every(options=>options.singlePass&&!options.headerOnly));
});

test('collector leaves manually changed and originally maximized windows alone after one-copy reads',async()=>{
  for(const options of [{viewportChanged:true},{viewportState:'maximized'}]){
    const c=await controller({limit:'1',fitViewportRequest:true,...options});await c.click('#start');
    assert.equal(c.windowUpdates.length,options.viewportChanged?1:0);assert.equal(c.copyOptions.length,1);
  }
});

test('foreground failure stores only local geometry and restores viewport when the review is stopped',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',fitViewportRequest:true,
    copyPreflightIssue:'未确认简历宽度',copyEvidence:{diagnostics:{reason:'width_clipped',clipLeft:12,clipRight:0,
      startHit:true,endHit:true,resume:'private-resume',name:'private-name',url:'https://private/'}}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.storageState.lastForegroundReadDiagnostic.reason,'width_clipped');
  assert.equal(c.storageState.lastForegroundReadDiagnostic.clipLeft,12);
  assert.ok(!JSON.stringify(c.storageState.lastForegroundReadDiagnostic).includes('private'));
  assert.ok(!c.element('#status').textContent.includes('clipLeft'));
  assert.ok(!c.posted.includes('/api/extension/screen'));
  await c.click('#stop');await task;
  assert.equal(c.windowUpdates.length,2);assert.equal(c.windowUpdates[1].state,'normal');
  assert.equal(c.copyOptions.length,1);assert.ok(!c.events.some(value=>value.startsWith('copy:')));
});

test('a thrown foreground geometry failure is saved locally without evaluating or recopying',async()=>{
  const c=await controller({limit:'1',fitViewportRequest:true,
    copyThrownDiagnostic:{reason:'end_hit_missing',endHit:false,resume:'private-resume'}});
  await c.click('#start');
  assert.equal(c.storageState.lastForegroundReadDiagnostic.reason,'end_hit_missing');
  assert.equal(c.storageState.lastForegroundReadDiagnostic.endHit,false);
  assert.ok(!JSON.stringify(c.storageState.lastForegroundReadDiagnostic).includes('private'));
  assert.ok(!c.posted.includes('/api/extension/screen'));assert.equal(c.copyOptions.length,1);
  assert.deepEqual(c.windowUpdates,[{state:'maximized'},{state:'normal',left:60,top:40,width:900,height:740}]);
});

test('pending saved Canvas receipt recovery reads once without another model evaluation or save',async()=>{
  const backend=memoryBackend(),card={...cards[1],name:'杜先生',signature:'pending-150'};
  backend.entries.push({id:150,job:1,name:card.name,signature:card.signature,score:76,
    favorite_pending:true,share:false,boss_chat_uid:card.boss_chat_uid});
  const c=await controller({backend,batchCards:[card],limit:'1'});c.element('#share').checked=false;
  await c.click('#start');
  assert.equal(c.copyOptions.length,1);assert.ok(!c.copyOptions[0].headerOnly);
  assert.ok(!c.posted.some(path=>['/api/extension/screen','/api/ai/evaluate','/api/candidates/share'].includes(path)));
  assert.ok(!c.events.some(event=>/^(?:evaluate|save|header-copy):/.test(event)));
  assert.equal(backend.entries.length,1);assert.equal(backend.entries[0].id,150);
  assert.equal(backend.entries[0].favorite_pending,false);
});

test('missing or unsupported Canvas UID never falls back to copying and preserves protected pending records',async()=>{
  for(const options of [{withoutPlatform:true},{receiptUnavailable:'unsupported_page'},{receiptUnavailable:'missing_uid'}]){
    const backend=memoryBackend(),card={...cards[1],...(options.withoutPlatform?{platform_geek_id:''}:{})};
    backend.entries.push({id:150,job:1,name:card.name,signature:card.signature,score:76,
      favorite_pending:true,share:false,boss_chat_uid:card.boss_chat_uid});
    const c=await controller({backend,batchCards:[card],limit:'1',...options});
    await c.click('#start');
    assert.equal(c.copyOptions.length,1);assert.ok(!c.events.some(event=>/^(?:header-copy|favorite|share):/.test(event)));
    assert.equal(backend.entries[0].favorite_pending,true);assert.ok(!c.posted.includes('/api/extension/screen'));
    const prepares=c.receiptActions.filter(args=>args.action==='prepare');
    assert.equal(prepares.length,options.withoutPlatform?0:options.receiptUnavailable==='missing_uid'?5:1);
    assert.match(c.element('#status').textContent,/不会再次复制/);
  }
  const c=await controller({batchCards:[{id:'1',name:'无凭据先生',signature:'no-uid'}],limit:'1'});
  await c.click('#start');
  assert.equal(c.events.filter(event=>event==='copy:无凭据先生').length,1);
  assert.equal(c.posted.filter(path=>path==='/api/extension/screen').length,1);
  assert.equal(c.receiptActions.length,0);assert.ok(!c.events.some(event=>/^(?:header-copy|favorite):/.test(event)));
});

test('receipt preparation and sealing wait only for transient pinned identity loading before proceeding',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',
    receiptPrepareReplies:[{ok:true,status:'unavailable',reason:'loading',attempted:false},
      {ok:true,status:'unavailable',reason:'missing_uid',attempted:false}],
    receiptSealReplies:[{ok:false,status:'blocked',reason:'loading',attempted:false}]});
  await c.click('#start');
  assert.equal(c.copyOptions.length,1);assert.equal(c.waits.filter(ms=>ms===200).length,3);
  assert.ok(c.receiptStages.filter(item=>item.action==='prepare').every(item=>item.copies===0));
  assert.ok(c.receiptStages.filter(item=>item.action==='seal').every(item=>item.copies===1));
  assert.equal(c.receiptActions.filter(args=>args.action==='click').length,1);
  assert.equal(c.detailCalls.filter(call=>call.opened).length,0);
});

test('receipt identity conflicts and cancellation never trigger another prepare or copy',async()=>{
  for(const options of [{receiptPrepareReplies:[{ok:false,status:'blocked',reason:'identity_changed',attempted:false}]},
    {stopAtReceipt:'prepare'},{stopAtReceipt:'seal'}]){
    const c=await controller({batchCards:[cards[1]],limit:'1',...options});await c.click('#start');
    assert.equal(c.receiptActions.filter(args=>args.action==='prepare').length,1);
    assert.ok(c.copyOptions.length<=1);assert.ok(!c.posted.includes('/api/extension/screen'));
    assert.ok(!c.receiptActions.some(args=>args.action==='click'));
  }
});

test('an uncertain or malformed snapshot favorite reply is retained without rollback or a second click',async()=>{
  for(const receiptClickReply of [{ok:true},{ok:true,status:'confirmed',favorited:true,already:false,attempted:false,
    platform_geek_id:'wrong',boss_chat_uid:'98765',candidate_name:'李**'},
    {ok:false,status:'uncertain',attempted:true}]){
    const c=await controller({batchCards:[cards[1]],limit:'1',receiptClickReply});await c.click('#start');
    assert.equal(c.copyOptions.length,1);assert.equal(c.receiptActions.filter(args=>args.action==='click').length,1);
    assert.equal(c.backend.entries.length,1);assert.equal(c.backend.entries[0].favorite_pending,true);
    assert.ok(!c.posted.includes('/api/extension/rollback-unreachable'));
  }
});

test('snapshot seal and verification reject missing or different receipt tokens before a favorite click',async()=>{
  const identity={platform_geek_id:'101',boss_chat_uid:'98765',candidate_name:'李**',attempted:false};
  for(const token of [undefined,'another-snapshot']){
    for(const phase of ['seal','verify']){
      const reply={ok:true,status:phase==='seal'?'sealed':'verified',[phase==='seal'?'sealed':'verified']:true,...identity,...(token?{token}:{})};
      const options=phase==='seal'?{receiptSealReplies:[reply]}:{receiptVerifyReply:reply};
      const c=await controller({batchCards:[cards[1]],limit:'1',...options});await c.click('#start');
      assert.equal(c.copyOptions.length,1);assert.ok(!c.receiptActions.some(args=>args.action==='click'));
      assert.ok(!c.events.some(event=>/^(?:header-copy|favorite):/.test(event)));
      if(phase==='seal')assert.ok(!c.posted.includes('/api/extension/screen'));
    }
  }
});

test('rollback failure keeps the pending record and never reports a successful deletion',async()=>{
  const c=await controller({limit:'1',failFavorite:true,failRollback:true});
  await c.click('#start');
  assert.equal(c.backend.entries.length,1);assert.equal(c.backend.entries[0].favorite_pending,true);
  assert.ok(c.posted.includes('/api/extension/rollback-unreachable'));
  assert.ok(!c.events.includes('rollback:张**'));
  assert.doesNotMatch(c.element('#status').textContent,/已删除履历|履历已删除/);
});

test('a saved return QR protects an existing pending resume when favorite fails',async()=>{
  const backend=memoryBackend();backend.entries.push({id:70,job:1,name:cards[0].name,signature:cards[0].signature,
    share:true,favorite_pending:true});
  const c=await controller({backend,limit:'1',failFavorite:true});
  await c.click('#start');
  assert.equal(backend.entries.length,1);assert.equal(backend.entries[0].share,true);
  assert.ok(!c.events.includes('rollback:张**'));
});

test('a pending favorite is repaired even when QR already exists or QR capture is disabled',async()=>{
  for(const hasImage of [false,true]){
    const backend=memoryBackend();
    backend.entries.push({id:backend.nextId++,job:1,name:cards[0].name,signature:cards[0].signature,
      share:hasImage,favorite_pending:true});
    const c=await controller({backend,limit:'1'});
    c.element('#share').checked=false;
    await c.click('#start');
    assert.deepEqual(c.opened,['一号']);
    assert.deepEqual(c.events,['open:张**','expand:张**','copy:张**','favorite:张**','ack-favorite:张**','close:张**']);
    assert.ok(!c.posted.includes('/api/extension/screen'));
    assert.equal(backend.entries[0].favorite_pending,false);
  }
});

test('an incomplete reopened canvas blocks pending favorites, acknowledgements and new evaluations',async()=>{
  const backend=memoryBackend();
  backend.entries.push({id:backend.nextId++,job:1,name:cards[1].name,signature:cards[1].signature,
    share:true,favorite_pending:true});
  const c=await controller({backend,mode:'background',batchCards:[cards[1]],incompleteProof:true});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.equal(backend.entries[0].favorite_pending,true);
  assert.equal(backend.favorites.size,0);
  assert.ok(!c.posted.some(path=>['/api/extension/screen','/api/extension/favorite-complete','/api/candidates/share'].includes(path)));
  assert.ok(!c.events.includes('close:李**'));
  c.click('#stop');await task;
  assert.equal(backend.entries[0].favorite_pending,true);
});

test('a pending canvas favorite can retry complete identity verification without another evaluation or save',async()=>{
  const backend=memoryBackend();
  backend.entries.push({id:backend.nextId++,job:1,name:cards[1].name,signature:cards[1].signature,
    share:false,favorite_pending:true});
  const c=await controller({backend,mode:'background',batchCards:[cards[1]],backgroundFailures:[
    {issue:'当前正文尚未完整确认',issueCode:'unsupported'}, {},
  ]});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.equal(backend.favorites.size,0);
  assert.ok(!c.posted.includes('/api/extension/favorite-complete'));
  c.click('#review-retry');await task;
  assert.equal(c.events.filter(value=>value==='background-read:李**').length,2);
  assert.ok(!c.events.some(value=>value.startsWith('evaluate:')||value.startsWith('save:')));
  assert.ok(!c.posted.includes('/api/extension/screen'));
  assert.ok(c.events.includes('favorite:李**'));
  assert.ok(c.events.includes('ack-favorite:李**'));
  assert.ok(c.events.includes('save-share:李**'));
  assert.ok(c.events.includes('close:李**'));
  assert.equal(backend.entries[0].favorite_pending,false);
});

test('an interrupted response after the server saves resumes the pending favorite without re-evaluating',async()=>{
  const backend=memoryBackend();
  const first=await controller({backend,loseScreenResponse:true,limit:'1'});
  await first.click('#start');
  assert.equal(backend.entries.length,1);
  assert.ok(!first.events.includes('favorite:张**'));
  const retry=await controller({backend,limit:'1'});
  await retry.click('#start');
  assert.deepEqual(retry.opened,['一号']);
  assert.ok(!retry.posted.includes('/api/extension/screen'));
  assert.equal(backend.entries[0].favorite_pending,false);
  assert.equal(backend.entries[0].share,true);
});

test('a candidate changed while screening cannot receive the saved candidate favorite or QR action',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],changingDocument:true,switchAfterScreen:true});
  await c.click('#start');
  assert.equal(c.backend.entries.length,0);
  assert.ok(c.events.includes('rollback:李**'));
  assert.ok(!c.events.some(value=>/^(favorite|share|close):/.test(value)));
  assert.match(c.element('#status').textContent,/关闭或切换/);
});

test('screening requires a configured model and the current workbench capability before opening cards',async()=>{
  for(const options of [{configured:false},{screeningVersion:null},{screeningVersion:0},{screeningVersion:1}]){
    const c=await controller(options);
    await c.click('#start');
    assert.deepEqual(c.opened,[]);
    assert.ok(!c.posted.includes('/api/extension/screen'));
    assert.match(c.element('#status').textContent,/配置 AI|版本过旧/);
  }
});

test('a verified short canvas resume saves automatically without a manual completeness button',async()=>{
  const c=await controller({batchCards:[cards[1]],oneSection:true});
  await c.click('#start');
  assert.ok(c.events.includes('copy:李**'));
  assert.ok(c.events.includes('save:李**'));
  assert.ok(c.events.includes('close:李**'));
  assert.equal(c.element('#review').hidden,true);
  const html=fs.readFileSync(new URL('../extension/collector.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="review-accept"/);
});

test('missing measured canvas completeness blocks save and automatic next candidate',async()=>{
  const c=await controller({batchCards:[cards[1],{id:'2',name:'王**',signature:'三号'}],incompleteProof:true});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.match(c.element('#status').textContent,/自动校验未通过/);
  assert.ok(!c.events.some(event=>event.startsWith('save:')||event==='open:王**'));
  c.click('#stop');
  await task;
});

test('DOM boundary proof blocks a missing tail but accepts display-only footer cleanup',async()=>{
  const c=await controller({batchCards:[cards[0]],missingDomTail:true});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.ok(!c.events.some(event=>event.startsWith('save:')));
  c.click('#stop');
  await task;
  const clean=await controller({batchCards:[cards[0]],stripFooter:true});
  await clean.click('#start');
  assert.ok(clean.events.includes('save:张**'));
  assert.equal(clean.element('#review').hidden,true);
});

test('batch closes one bound online detail before applying conditions and resumes the list',async()=>{
  for(const card of cards){
    const c=await controller({preopened:true,batchCards:[card],limit:'1',
      searchConditions:{enabled:true,activity:'3日内活跃'}});
    await c.click('#start');
    assert.equal(c.events[0],'close-current:'+card.name);
    assert.ok(c.events.indexOf('close-current:'+card.name)<c.events.indexOf('search-apply'));
    assert.ok(c.events.indexOf('search-apply')<c.events.indexOf('open:'+card.name));
    assert.deepEqual(c.opened,[card.signature]);
    assert.equal(c.events.filter(event=>event==='close-current:'+card.name).length,1);
    assert.equal(c.backend.entries.length,1);
  }
  for(const page of ['collector','popup']){
    const html=fs.readFileSync(new URL(`../extension/${page}.html`,import.meta.url),'utf8');
    assert.doesNotMatch(html,/OCR|auto-copy|read-clipboard|paste-resume|id="read"/);
  }
});

test('returning from an online detail preserves completed work and never greets an already contacted candidate again',async()=>{
  const backend=memoryBackend(),first=await controller({backend,limit:'1'});
  await first.click('#start');
  const resumed=await controller({backend,preopened:true,limit:'1'});
  await resumed.click('#start');
  assert.equal(resumed.events[0],'close-current:张**');
  assert.deepEqual(resumed.opened,['二号']);
  assert.equal(backend.entries.length,2);
  assert.ok(!resumed.events.includes('copy:张**'));
  const greetedBackend=memoryBackend();savedGreetingCandidate(greetedBackend);
  greetedBackend.greetings.set('9001|12345',{state:'confirmed'});
  const greeted=await greetingController({backend:greetedBackend,preopened:true});
  await greeted.click('#start');
  assert.deepEqual(greeted.events,['close-current:张**','greeting-reset:list','greeting-account']);
  assert.deepEqual(greeted.opened,[]);
  assert.ok(!greeted.posted.includes('/api/extension/greeting'));
  assert.equal(greetedBackend.greetings.get('9001|12345').state,'confirmed');
});

test('batch return never closes ambiguous, replaced, non-list or unconfirmed online details',async()=>{
  const ambiguous=rows=>[...rows,rows[0]];
  const unknown=rows=>rows.map(row=>({...row,result:{ok:true,value:{...row.result.value,kind:'attachment'}}}));
  const missingToken=rows=>rows.map(row=>({...row,result:{ok:true,value:{...row.result.value,token:''}}}));
  for(const options of [{currentDetailOverride:ambiguous},{currentDetailOverride:unknown},{currentDetailOverride:missingToken},
    {batchCards:[cards[1]],scopeMismatch:true},{switchBeforeClose:true},
    {closeCurrentError:'当前关闭按钮属于附件或未知弹窗，未关闭'},
    {tabPath:'/web/chat/index',listPath:'/web/chat/index'}]){
    const c=await controller({preopened:true,...options});await c.click('#start');
    assert.deepEqual(c.opened,[]);
    assert.ok(!c.events.some(event=>/^(close|close-current|copy|evaluate):/.test(event)));
    assert.ok(!c.posted.includes('/api/extension/collection-status'));
  }
  const notClosed=await controller({preopened:true,closeCurrentRemains:true});await notClosed.click('#start');
  assert.deepEqual(notClosed.events,['close-current:张**']);
  assert.match(notClosed.element('#status').textContent,/尚未关闭/);
  assert.deepEqual(notClosed.opened,[]);
});

test('stopping during return to the list does not reopen or process a candidate',async()=>{
  const c=await controller({preopened:true,stopAt:'close-current:张**'});await c.click('#start');
  assert.deepEqual(c.events,['close-current:张**']);
  assert.deepEqual(c.opened,[]);assert.equal(c.backend.entries.length,0);
});

test('batch return waits for the same detail to disappear and the same list to finish rendering without another close',async()=>{
  const c=await controller({preopened:true,closeCurrentDelay:3,limit:'1',onListScan:({index})=>
    ({cards:index<3?[]:cards})});
  await c.click('#start');
  assert.equal(c.events.filter(event=>event==='close-current:张**').length,1);
  assert.equal(c.waits.filter(ms=>ms===250).length,6);
  assert.deepEqual(c.opened,['一号']);assert.equal(c.backend.entries.length,1);
  assert.ok(c.listSnapshots.slice(0,3).every(snapshot=>snapshot.opened===0&&snapshot.posted===0));
});

test('batch list recovery is bounded and rejects navigation or a replaced list before processing anyone',async()=>{
  for(const onListScan of [()=>({cards:[]}),
    ()=>({cards:[],documentId:'replaced-list'}),
    ()=>({cards:[],tabUrl:origin+'/web/chat/search?changed=1'})]){
    const c=await controller({preopened:true,onListScan});await c.click('#start');
    assert.equal(c.events.filter(event=>event==='close-current:张**').length,1);
    assert.deepEqual(c.opened,[]);assert.equal(c.backend.entries.length,0);
    assert.ok(!c.posted.includes('/api/extension/collection-status'));
    assert.match(c.element('#status').textContent,/仍在加载|页面已更换|页面已切换/);
    assert.ok(c.waits.filter(ms=>ms===250).length<=16);
  }
});

test('Canvas DOM expansion searches the owner then body and shares the one-click budget with copying',async()=>{
  for(const canvasDomCounts of [{outer:1},{'canvas-detail':1},{}]){
    const c=await controller({preopened:true,batchCards:[cards[1]],canvasDomCounts});
    await c.click('#evaluate-current');
    assert.equal(c.directResults.length,1);
    const clicked=Object.values(canvasDomCounts).some(count=>count===1);
    assert.equal(c.copyOptions.length,1);assert.equal(c.copyOptions[0].expandAlreadyDone,clicked);
    assert.equal(c.events.filter(event=>event==='dom-expand:李**').length,clicked?1:0);
    assert.deepEqual(c.expansionCalls.map(call=>call.action+':'+call.documentId),
      ['prepare-canvas-expand:outer','prepare-canvas-expand:canvas-detail',
        ...(clicked?['click-canvas-expand:'+(canvasDomCounts.outer===1?'outer':'canvas-detail')]:[])]);
    assert.equal(c.copyOptions[0].skipExpansion,false);
    assert.ok(!c.events.some(event=>event.startsWith('close-current:')));
  }
});

test('ambiguous Canvas DOM expansion across either or both frames skips clicks and evaluates one complete copy',async()=>{
  for(const canvasDomCounts of [{outer:2,'canvas-detail':1},{'canvas-detail':2},{outer:1,'canvas-detail':1}]){
    const c=await controller({preopened:true,batchCards:[cards[1]],canvasDomCounts});await c.click('#evaluate-current');
    assert.equal(c.copyOptions.length,1);assert.equal(c.copyOptions[0].skipExpansion,true);
    assert.equal(c.copyOptions[0].expandAlreadyDone,false);assert.equal(c.directResults.length,1);
    assert.ok(!c.expansionCalls.some(call=>call.action==='click-canvas-expand'));
    assert.equal(c.posted.filter(path=>path==='/api/extension/preview-resume').length,1);
  }
});

test('an ambiguous expansion still rejects folded copied text without a second click or evaluation',async()=>{
  const c=await controller({preopened:true,batchCards:[cards[1]],canvasDomCounts:{outer:1,'canvas-detail':1},folded:true});
  const task=c.click('#evaluate-current');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.copyOptions.length,1);assert.equal(c.copyOptions[0].skipExpansion,true);
  assert.ok(!c.expansionCalls.some(call=>call.action==='click-canvas-expand'));
  assert.equal(c.directResults.length,0);assert.ok(!c.posted.includes('/api/extension/preview-resume'));
  await c.click('#stop');await task;
});

test('invalid or stale Canvas DOM expansion never falls through to copying or a second click',async()=>{
  for(const options of [{canvasDomCounts:{outer:1},canvasDomClickError:'展开控件已变化'},
    {canvasDomCounts:{outer:1},canvasDomClickResult:false},
    {canvasDomRowsOverride:rows=>[...rows,rows[0]]},
    {canvasDomRowsOverride:rows=>rows.map(row=>({...row,documentId:'different-document'}))}]){
    const c=await controller({preopened:true,batchCards:[cards[1]],...options});await c.click('#evaluate-current');
    assert.equal(c.copyOptions.length,0);assert.equal(c.directResults.length,0);
    assert.ok(c.expansionCalls.filter(call=>call.action==='click-canvas-expand').length<=1);
    assert.ok(!c.posted.includes('/api/extension/preview-resume'));
  }
});

test('a confirmed zero-click control race skips all expansion and copies once in collector entries',async()=>{
  for(const direct of [false,true]){
    const c=await controller({preopened:direct,batchCards:[cards[1]],limit:'1',canvasDomCounts:{outer:1},
      canvasDomClickResult:{clicked:false,reason:'controls_changed'}});
    await c.click(direct?'#evaluate-current':'#start');
    assert.equal(c.expansionCalls.filter(call=>call.action==='click-canvas-expand').length,1);
    assert.ok(!c.events.some(event=>event.startsWith('dom-expand:')));
    assert.equal(c.copyOptions.length,1);assert.equal(c.copyOptions[0].skipExpansion,true);
    assert.equal(c.copyOptions[0].expandAlreadyDone,false);
    assert.equal(c.posted.filter(path=>path===(direct?'/api/extension/preview-resume':'/api/extension/screen')).length,1);
  }
});

test('single evaluation closes only a bound image preview and retains one expansion and one copy',async()=>{
  for(const [card,imagePreview,imagePreviewAt] of [
    [cards[0],'outer','initial'],[cards[0],'outer','expand'],
    [cards[1],'outer','initial'],[cards[1],'canvas-detail','initial'],
    [cards[1],'outer','expand'],[cards[1],'canvas-detail','focus'],
  ]){
    const c=await controller({preopened:true,batchCards:[card],imagePreview,imagePreviewAt,
      canvasDomCounts:card.id==='0'?{}:{outer:1},focusRecovery:imagePreviewAt==='focus'});
    await c.click('#evaluate-current');
    assert.equal(c.directResults.length,1);
    assert.equal(c.events.filter(event=>event==='dismiss-image-preview:'+card.name).length,1);
    assert.equal(c.events.filter(event=>event==='copy:'+card.name).length,1);
    assert.equal(c.events.filter(event=>/^(?:dom-expand|expand):/.test(event)).length,1);
    assert.equal(c.posted.filter(path=>path==='/api/extension/preview-resume').length,1);
    assert.equal(c.waits.filter(ms=>ms===150).length,2);
    assert.ok(!c.events.some(event=>/^(?:close|close-current|favorite|share|save|send-greeting|send-colleague):/.test(event)));
    if(imagePreview==='canvas-detail')assert.deepEqual(c.previewCalls.map(call=>call.documentId),['canvas-detail']);
    if(imagePreviewAt==='focus')assert.deepEqual(c.focusRecoveries,[true]);
  }
});

test('image preview recovery never spends a second close when another overlay appears before copying',async()=>{
  const c=await controller({preopened:true,batchCards:[cards[1]],imagePreview:'outer',
    canvasDomCounts:{outer:1},focusRecovery:true,reopenPreviewAtFocus:true});
  await c.click('#evaluate-current');
  assert.deepEqual(c.focusRecoveries,[false]);
  assert.equal(c.events.filter(event=>event==='dismiss-image-preview:李**').length,1);
  assert.equal(c.events.filter(event=>event==='dom-expand:李**').length,1);
  assert.equal(c.events.filter(event=>event==='copy:李**').length,0);
  assert.equal(c.directResults.length,0);
  assert.match(c.element('#status').textContent,/图片预览仍遮挡/);
});

test('image preview ambiguity, malformed replies and changed binding stop before copying or evaluation',async()=>{
  for(const options of [
    {imagePreviewError:'图片预览不唯一，未关闭'},
    {imagePreviewReply:{dismissed:1}},
    {imagePreviewRowsOverride:rows=>[...rows,rows[0]]},
    {imagePreviewRowsOverride:rows=>rows.map(row=>({...row,documentId:'replacement'}))},
    {replaceAfterPreviewDismiss:true},
    {stopAt:'dismiss-image-preview:李**'},
  ]){
    const c=await controller({preopened:true,batchCards:[cards[1]],imagePreview:'outer',...options});
    await c.click('#evaluate-current');
    assert.ok(c.events.filter(event=>event==='dismiss-image-preview:李**').length<=1);
    assert.equal(c.copyOptions.length,0);assert.equal(c.directResults.length,0);
    assert.ok(!c.posted.includes('/api/extension/preview-resume'));
    assert.ok(!c.events.some(event=>/^(?:dom-expand|copy|favorite|save|share|close):/.test(event)));
  }
});

test('batch image-preview recovery continues the same candidate without duplicate saves or favorites',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',imagePreview:'canvas-detail'});
  await c.click('#start');
  assert.deepEqual(c.opened,[cards[1].signature]);
  for(const action of ['dismiss-image-preview','copy','evaluate','save','favorite','share','close'])
    assert.equal(c.events.filter(event=>event===action+':李**').length,1,action);
  assert.equal(c.backend.entries.length,1);
});

test('no-preview batch recovery performs zero extra full identity scans or dismissal calls',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',focusRecovery:true});
  await c.click('#start');
  assert.equal(c.events.filter(event=>event==='copy:李**').length,1);
  assert.equal(c.detailCalls.filter(call=>call.opened).length,0);
  assert.equal(c.previewCalls.length,0);
  assert.deepEqual(c.focusRecoveries,[false]);assert.deepEqual(c.recoveryDetailReads,[0]);
  assert.ok(c.previewProbes.length>0);
});

test('normal Canvas preparation checks each bound frame once unless expansion or focus recovery needs another check',async()=>{
  for(const expanded of [false,true]){
    const c=await controller({batchCards:[cards[1]],limit:'1',canvasDomCounts:expanded?{outer:1}:{}});
    await c.click('#start');assert.equal(c.previewProbes.length,expanded?4:2);
    assert.equal(c.copyOptions.length,1);assert.equal(c.previewCalls.length,0);
  }
});

test('a bounded preview scan may remain unknown while the same Canvas copies once without any expansion or close',async()=>{
  for(const reason of ['budget','scope'])for(const direct of [false,true]){
    const c=await controller({batchCards:[cards[1]],preopened:direct,limit:'1',canvasDomCounts:{outer:1},
      imageProbeReply:{present:false,uncertain:true,reason}});
    await c.click(direct?'#evaluate-current':'#start');
    assert.equal(c.copyOptions.length,1);assert.equal(c.copyOptions[0].skipExpansion,true);
    assert.equal(c.expansionCalls.length,0);assert.equal(c.previewCalls.length,0);assert.equal(c.previewProbes.length,2);
    if(reason==='budget'&&!direct)assert.equal(c.detailCalls.filter(call=>call.opened).length,0);
    assert.equal(c.posted.filter(path=>path===(direct?'/api/extension/preview-resume':'/api/extension/screen')).length,1);
  }
});

test('unknown DOM preview checks do not click an expander or rely on programmatic focus to copy',async()=>{
  for(const reason of ['budget','scope']){
    const c=await controller({batchCards:[cards[0]],preopened:true,imageProbeReply:{present:false,uncertain:true,reason}});
    await c.click('#evaluate-current');assert.equal(c.copyOptions.length,0);assert.equal(c.previewCalls.length,0);
    assert.ok(!c.events.includes('expand:张**'));assert.equal(c.directResults.length,0);
    assert.match(c.element('#status').textContent,/检查未完成，尚未复制正文/);
  }
});

test('scope uncertainty still requires the original unique Canvas binding before copying',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',imageProbeReply:{present:false,uncertain:true,reason:'scope'},
    currentDetailOverride:rows=>rows.map(row=>({...row,documentId:'changed-document'}))});
  await c.click('#start');assert.equal(c.copyOptions.length,0);assert.equal(c.previewCalls.length,0);
  assert.ok(!c.posted.includes('/api/extension/screen'));
});

test('an unknown owner probe does not prevent closing one positively identified bound body preview',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',imagePreview:'canvas-detail',
    imageProbeReply:({documentId,visible})=>documentId==='outer'?{present:false,uncertain:true,reason:'budget'}:{present:documentId===visible}});
  await c.click('#start');assert.deepEqual(c.previewCalls.map(call=>call.documentId),['canvas-detail']);
  assert.equal(c.events.filter(event=>event==='dismiss-image-preview:李**').length,1);
  assert.equal(c.copyOptions.length,1);assert.equal(c.copyOptions[0].skipExpansion,true);
});

test('an inconclusive preview dismissal never authorizes a blind close or bypasses failed Canvas focus',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',imagePreview:'outer',focusRecovery:true,
    imagePreviewReply:{dismissed:false,uncertain:true,reason:'budget'}});
  await c.click('#start');assert.ok(!c.events.some(event=>/^(?:dismiss-image-preview|copy|evaluate|save):/.test(event)));
  assert.equal(c.expansionCalls.length,0);assert.ok(!c.posted.includes('/api/extension/screen'));
});

test('a later uncertain Canvas focus recovery disables expansion inside the already-started copy',async()=>{
  const c=await controller({batchCards:[cards[1]],limit:'1',focusRecovery:true,
    imageProbeReply:({count})=>count>2?{present:false,uncertain:true,reason:'budget'}:{present:false}});
  await c.click('#start');assert.equal(c.copyOptions.length,1);assert.equal(c.copyOptions[0].skipExpansion,true);
  assert.equal(c.focusRecoveries[0].skipExpansion,true);assert.equal(c.previewCalls.length,0);
  assert.ok(!c.events.some(event=>event.startsWith('dom-expand:')));
  assert.equal(c.events.filter(event=>event==='copy:李**').length,1);
});

test('a later uncertain DOM focus recovery stops before programmatic selection and copy',async()=>{
  const c=await controller({batchCards:[cards[0]],limit:'1',focusRecovery:true,
    imageProbeReply:({count})=>count>2?{present:false,uncertain:true,reason:'budget'}:{present:false}});
  await c.click('#start');assert.match(c.element('#status').textContent,/检查未完成，尚未复制正文/);
  assert.ok(!c.events.some(event=>/^(?:copy|evaluate|save):/.test(event)));assert.equal(c.previewCalls.length,0);
});

test('invalid preview probes stop without authorizing a dismissal or full copy',async()=>{
  for(const options of [{imageProbeReply:{present:'true'}},
    ...[{present:true,uncertain:true,reason:'budget'},{present:false,uncertain:true,reason:'other'},
      {present:false,uncertain:1,reason:'budget'},{present:false,reason:'budget'}].map(imageProbeReply=>({imageProbeReply})),
    {imageProbeRowsOverride:rows=>[...rows,rows[0]]},
    {imageProbeRowsOverride:rows=>rows.map(row=>({...row,documentId:'changed-document'}))}]){
    const c=await controller({preopened:true,batchCards:[cards[1]],...options});
    await c.click('#evaluate-current');
    assert.equal(c.previewCalls.length,0);assert.equal(c.copyOptions.length,0);assert.equal(c.directResults.length,0);
    assert.match(c.element('#status').textContent,/预览检查结果/);
  }
});

test('a stalled read stops the batch and late replies never copy, reopen or clean up a later tracker',async()=>{
  for(const hangReadAction of ['scan','current-detail','probe-image-preview']){
    const c=await controller({hangReadAction,imagePreview:hangReadAction==='current-detail'?'outer':''});
    await c.click('#start');
    assert.match(c.element('#status').textContent,/等待超时/);
    assert.equal(c.element('#start').disabled,false);assert.equal(c.element('#stop').disabled,true);
    assert.deepEqual(c.opened,[cards[0].signature]);
    assert.equal(c.cleanupCalls(),1,'timed-out run must not enqueue trailing tracker cleanup');
    assert.ok(!c.events.some(event=>/^(?:copy|evaluate|save|favorite|share|close):/.test(event)));
    const before=[...c.events];c.resolveReads();await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(c.events,before);assert.equal(c.cleanupCalls(),1);
  }
});

test('payment already visible blocks batch, backfill and current evaluation before any candidate action',async()=>{
  for(const button of ['#start','#backfill-chat','#evaluate-current']){
    const c=await controller({paymentAt:'start',preopened:button==='#evaluate-current'});
    await c.click(button);assert.match(c.element('#status').textContent,/VIP.*自动停止/);
    assert.equal(c.opened.length,0);assert.equal(c.copyOptions.length,0);
    assert.ok(!c.events.some(event=>/^(?:close|close-current|copy|evaluate|save|favorite|share|send)/.test(event)));
    assert.equal(c.posted.length,0);assert.equal(c.paymentMonitors[0].active,false);
  }
});

test('payment appearing while opening a detail stops without closing it or advancing',async()=>{
  const c=await controller({paymentAt:'open:张**'});await c.click('#start');
  assert.deepEqual(c.opened,[cards[0].signature]);assert.equal(c.copyOptions.length,0);
  assert.ok(!c.events.some(event=>/^(?:close|copy|evaluate|save|favorite|share):/.test(event)));
  assert.match(c.element('#status').textContent,/VIP.*自动停止/);
});

test('payment interrupts review without retrying or marking the unread candidate',async()=>{
  const c=await controller({copyPreflightIssue:'需要人工检查',limit:'1'});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);c.emitPayment();await task;
  assert.equal(c.element('#review').hidden,true);assert.equal(c.copyOptions.length,1);
  assert.ok(!c.events.some(event=>/^(?:close|evaluate|save|favorite|share):/.test(event)));
  assert.equal(c.backend.lowMarks.length,0);assert.match(c.element('#status').textContent,/VIP.*自动停止/);
});

test('payment interrupts a pending read and its late reply never resumes the candidate',async()=>{
  const c=await controller({hangReadAction:'current-detail',imagePreview:'outer'});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  c.emitPayment();await task;assert.equal(c.copyOptions.length,0);
  const events=[...c.events];c.resolveReads();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(c.events,events);assert.match(c.element('#status').textContent,/VIP.*自动停止/);
});

test('payment stops a long model response wait while preserving the server-side committed resume',async()=>{
  const c=await controller({limit:'1',holdResponsePath:'/api/extension/screen'});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.backend.entries.length,1);assert.equal(c.backend.entries[0].favorite_pending,true);
  c.emitPayment();await task;assert.match(c.element('#status').textContent,/VIP.*自动停止/);
  assert.ok(!c.posted.includes('/api/extension/rollback-unreachable'));
  assert.ok(!c.events.some(event=>/^(?:favorite|share|close):/.test(event)));
  const events=[...c.events],posted=[...c.posted];c.resolveResponses();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(c.events,events);assert.deepEqual(c.posted,posted);assert.equal(c.backend.entries.length,1);
});

test('payment after a save or favorite preserves pending truth and prevents later acknowledgements and close',async()=>{
  for(const paymentAt of ['save:张**','favorite:张**']){
    const c=await controller({limit:'1',paymentAt});await c.click('#start');
    assert.equal(c.backend.entries.length,1);assert.equal(c.backend.entries[0].favorite_pending,true);
    assert.ok(!c.posted.includes('/api/extension/favorite-complete'));
    assert.ok(!c.posted.includes('/api/extension/rollback-unreachable'));
    assert.ok(!c.events.some(event=>/^(?:share|close):/.test(event)));
    assert.match(c.element('#status').textContent,/VIP.*自动停止/);
  }
});

test('payment stops current evaluation during a long response and never renders a late result',async()=>{
  const c=await controller({preopened:true,holdResponsePath:'/api/extension/preview-resume'});
  const task=c.click('#evaluate-current');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.copyOptions.length,1);c.emitPayment();await task;
  assert.equal(c.directResults.length,0);c.resolveResponses();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.directResults.length,0);assert.match(c.element('#status').textContent,/VIP.*自动停止/);
  assert.ok(!c.events.some(event=>/^(?:close|favorite|share|save):/.test(event)));
});

test('payment monitor callbacks from an ended run cannot overwrite its finished status',async()=>{
  const c=await controller({limit:'1'});await c.click('#start');
  const status=c.element('#status').textContent,events=[...c.events];
  c.paymentMonitors[0].onPayment();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#status').textContent,status);assert.deepEqual(c.events,events);
});

test('payment during chat-entry backfill preserves the saved resume without writing an entry or closing it',async()=>{
  const card=recommendationCards[0],backend=memoryBackend();
  backend.entries.push({id:7,job:1,name:card.name,signature:card.signature,share:true,favorite_pending:false});
  const before=structuredClone(backend.entries);
  const c=await controller({backend,batchCards:[card],recommendationPage:true,listPath:'/web/frame/recommend/',
    chatUidBySignature:{[card.signature]:'98765'},paymentAt:'read-chat:'+card.name});
  await c.click('#backfill-chat');
  assert.deepEqual(backend.entries,before);assert.ok(!c.posted.includes('/api/extension/chat-entry'));
  assert.equal(c.copyOptions.length,0);assert.deepEqual(c.opened,[card.signature]);
  assert.ok(!c.actionRequests.some(action=>['close','closeShare','advance-list'].includes(action)));
  assert.match(c.element('#status').textContent,/VIP.*自动停止/);
});

test('payment inside QR or colleague sharing blocks finally-close and all subsequent acknowledgements',async()=>{
  for(const paymentAt of ['share:张**','prepare-colleague:张**','send-colleague:张**']){
    const c=await controller({limit:'1',paymentAt,colleagueForward:paymentAt!=='share:张**'});
    await c.click('#start');
    assert.equal(c.backend.entries.length,1);assert.equal(c.backend.entries[0].favorite_pending,false);
    assert.equal(c.backend.entries[0].share,false);
    assert.ok(!c.actionRequests.some(action=>['close','closeShare','advance-list'].includes(action)));
    assert.ok(!c.events.some(event=>/^(?:save-share|confirm-colleague|close):/.test(event)));
    if(paymentAt==='prepare-colleague:张**')assert.ok(!c.events.includes('send-colleague:张**'));
    assert.match(c.element('#status').textContent,/VIP.*自动停止/);
  }
});

test('payment during filter application prevents any later candidate action or menu fallback',async()=>{
  for(const recommendationPage of [false,true]){
    const c=await controller({recommendationPage,searchConditions:{enabled:true,activity:'3日内活跃'},
      inputMenuNeeded:!recommendationPage,paymentAt:recommendationPage?'recommend-apply':'search-apply'});
    await c.click('#start');
    assert.deepEqual(c.opened,[]);assert.equal(c.copyOptions.length,0);
    assert.ok(!c.events.some(event=>/^(?:input-|favorite|share|close):/.test(event)));
    assert.match(c.element('#status').textContent,/VIP.*自动停止/);
  }
});

test('payment wakes continuous list waiting without another list advance',async()=>{
  const c=await controller({limit:'',stopOnIdle:false});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  assert.match(c.element('#status').textContent,/暂无新候选人.*等待/);
  const advances=c.actionRequests.filter(action=>action==='advance-list').length;
  c.emitPayment();await task;
  assert.equal(c.actionRequests.filter(action=>action==='advance-list').length,advances);
  assert.equal(c.backend.entries.length,2);assert.match(c.element('#status').textContent,/VIP.*自动停止/);
});

test('payment interrupts a pending chat identity read and ignores its late reply',async()=>{
  const card=recommendationCards[0],backend=memoryBackend();
  backend.entries.push({id:7,job:1,name:card.name,signature:card.signature,share:true,favorite_pending:false});
  const c=await controller({backend,batchCards:[card],recommendationPage:true,listPath:'/web/frame/recommend/',
    chatUidBySignature:{[card.signature]:'98765'},hangChatRead:true});
  const task=c.click('#backfill-chat');await new Promise(resolve=>setImmediate(resolve));
  assert.ok(c.events.includes('read-chat:'+card.name));c.emitPayment();await task;
  const actions=[...c.actionRequests],posted=[...c.posted];c.resolveReads();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(c.actionRequests,actions);assert.deepEqual(c.posted,posted);
  assert.equal(backend.entries[0].boss_chat_uid,undefined);assert.match(c.element('#status').textContent,/VIP.*自动停止/);
});

test('waiting for details enforces a wall-clock deadline across individually responsive scans',async()=>{
  const c=await controller({scanDurationMs:10000,detailPendingScans:100});
  await c.click('#start');
  assert.match(c.element('#status').textContent,/等待超时/);
  assert.deepEqual(c.opened,[cards[0].signature]);assert.equal(c.openedScanCount(),2);
  assert.equal(c.copyOptions.length,0);assert.equal(c.cleanupCalls(),1);
});

test('production adapters accept IPC-reordered bindings through collector recovery with and without an avatar preview',async()=>{
  for(const name of ['', '杜先生'])for(const preview of [false,true]){
    const adapter=productionDetailAdapter({name,preview,alternateOrder:true});
    const c=await controller({preopened:true,recommendationPage:true,
      batchCards:[{id:'1',name:'杜先生',signature:'ipc-one'}],productionAdapter:adapter});
    await c.click('#evaluate-current');
    assert.equal(c.directResults.length,1,c.element('#status').textContent);
    assert.equal(c.events.filter(event=>event==='copy:杜先生').length,1);
    assert.equal(c.posted.filter(path=>path==='/api/extension/preview-resume').length,1);
    assert.equal(adapter.counts.preview,preview?1:0);
    assert.equal(adapter.counts.other,0);
    assert.equal(adapter.counts.dismiss,preview?1:0);
    assert.ok(adapter.counts.probes>0);
  }
});

test('collector comparison ignores binding key order but rejects changed URL values before copying',async()=>{
  let calls=0;
  const c=await controller({preopened:true,batchCards:[cards[1]],imagePreview:'outer',currentDetailOverride:rows=>rows.map(row=>{
    const binding=row.result.value.binding;
    return !binding?row:{...row,result:{ok:true,value:{...row.result.value,
      binding:++calls>8?{bodyUrl:binding.bodyUrl+'?changed=1',ownerUrl:binding.ownerUrl}:
        {bodyUrl:binding.bodyUrl,ownerUrl:binding.ownerUrl}}}};
  })});
  await c.click('#evaluate-current');
  assert.equal(c.copyOptions.length,0);assert.equal(c.directResults.length,0);
  assert.match(c.element('#status').textContent,/切换/);
});

test('the limit counts new candidates and a second batch starts after completed cards',async()=>{
  const c=await controller();
  c.element('#limit').value='1';
  await c.click('#start');
  await c.click('#start');
  assert.deepEqual(c.opened,['一号','二号']);
  assert.match(c.element('#status').textContent,/已处理 1 位.*跳过 1 位/);
  await c.click('#start');
  assert.deepEqual(c.opened,['一号','二号']);
  assert.match(c.element('#status').textContent,/均已采集/);
});

test('reopening the collector uses durable workbench records instead of restarting at the first card',async()=>{
  const backend=memoryBackend();
  const first=await controller({backend});
  first.element('#limit').value='1';
  await first.click('#start');
  const reopened=await controller({backend});
  reopened.element('#limit').value='1';
  await reopened.click('#start');
  assert.deepEqual(reopened.opened,['二号']);
});

test('completion is scoped by job and does not skip a different candidate with the same masked name',async()=>{
  const backend=memoryBackend();
  const sameNames=[
    {id:'0',name:'张**',signature:'张** 本科 在职 视觉开发甲公司'},
    {id:'2',name:'张**',signature:'张** 本科 在职 视觉开发乙公司'},
  ];
  const first=await controller({backend,batchCards:sameNames});
  first.element('#limit').value='1';
  await first.click('#start');
  const second=await controller({backend,batchCards:sameNames});
  second.element('#limit').value='1';
  await second.click('#start');
  assert.deepEqual(second.opened,[sameNames[1].signature]);
  const otherJob=await controller({backend,batchCards:sameNames});
  otherJob.element('#job').value='2';
  otherJob.element('#limit').value='1';
  await otherJob.click('#start');
  assert.deepEqual(otherJob.opened,[sameNames[0].signature]);
});

test('a failed required save is retried while a saved resume can be reused when QR is no longer requested',async()=>{
  for(const flag of ['failImport','failShare']){
    const backend=memoryBackend();
    const failed=await controller({backend,[flag]:true});
    failed.element('#limit').value='1';
    await failed.click('#start');
    const retry=await controller({backend});
    retry.element('#limit').value='1';
    await retry.click('#start');
    assert.deepEqual(retry.opened,['一号']);
  }
  const backend=memoryBackend();
  const failedQr=await controller({backend,failShare:true});
  failedQr.element('#limit').value='1';
  await failedQr.click('#start');
  const resumeOnly=await controller({backend});
  resumeOnly.element('#share').checked=false;
  resumeOnly.element('#limit').value='1';
  await resumeOnly.click('#start');
  assert.deepEqual(resumeOnly.opened,['二号']);
});

test('a saved resume missing its required QR is resumed without copying, importing, or evaluating again',async()=>{
  const backend=memoryBackend();
  const failed=await controller({backend,failShare:true});
  failed.element('#limit').value='1';
  await failed.click('#start');
  const retry=await controller({backend});
  retry.element('#limit').value='1';
  await retry.click('#start');
  assert.deepEqual(retry.events,['open:张**','share:张**','save-share:张**','close:张**']);
  assert.ok(!retry.posted.some(path=>['/api/extension/clipboard-preview','/api/extension/screen','/api/ai/evaluate'].includes(path)));
  assert.equal(backend.entries.length,1);
  await retry.click('#start');
  assert.deepEqual(retry.opened,['一号','二号']);
  assert.match(retry.element('#status').textContent,/已处理 1 位.*跳过 1 位/);
});

test('a failed QR-only retry stays on that candidate and preserves the saved resume',async()=>{
  const backend=memoryBackend();
  const initial=await controller({backend,failShare:true});
  initial.element('#limit').value='1';
  await initial.click('#start');
  const retry=await controller({backend,failShare:true});
  await retry.click('#start');
  assert.deepEqual(retry.events,['open:张**','share:张**']);
  assert.match(retry.element('#status').textContent,/停在 张\*\*.*保存二维码失败/);
  assert.equal(backend.entries.length,1);
  assert.equal(backend.entries[0].share,false);
});

test('an older collection-status response without known records keeps the existing retry behavior',async()=>{
  const backend=memoryBackend();
  const initial=await controller({backend,failShare:true});
  initial.element('#limit').value='1';
  await initial.click('#start');
  const retry=await controller({backend,includeKnown:false});
  retry.element('#limit').value='1';
  await retry.click('#start');
  assert.deepEqual(retry.events,['open:张**','expand:张**','copy:张**','evaluate:张**','save:张**','favorite-existing:张**','ack-favorite:张**','share:张**','save-share:张**','close:张**']);
  assert.equal(backend.entries.length,1);
});

test('malformed or ambiguous known records stop the batch before opening a candidate',async()=>{
  const valid={signature:cards[0].signature,id:1,has_image:false};
  for(const knownRecords of [
    [{...valid,id:'1'}],
    [{...valid,has_image:'false'}],
    [{...valid,favorite_pending:'true'}],
    [{...valid,signature:'another card'}],
    [valid,valid],
    {},
    null,
  ]){
    const c=await controller({knownRecords});
    await c.click('#start');
    assert.match(c.element('#status').textContent,/已保存候选人记录/);
    assert.deepEqual(c.events,[]);
  }
});

test('AI failure after confirmed data saves does not copy the same resume again',async()=>{
  const backend=memoryBackend();
  const failed=await controller({backend,failAi:true});
  failed.element('#limit').value='1';
  await failed.click('#start');
  assert.equal(backend.entries[0].diagnostic.reason,'模型连接失败');
  const reopened=await controller({backend});
  reopened.element('#limit').value='1';
  await reopened.click('#start');
  assert.deepEqual(reopened.opened,['二号']);
});

test('a blank count keeps collecting beyond twenty candidates and discovers later lists without repeating saved cards',async()=>{
  const extra=Array.from({length:22},(_,index)=>({id:String(index+2),name:'王**',signature:`后续候选人-${index}`,
    platform_geek_id:String(index+102),boss_chat_uid:String(index+98766)}));
  const c=await controller({limit:'',advancePages:[[cards[1],...extra]]});
  await c.click('#start');
  assert.equal(c.opened.length,24);
  assert.equal(new Set(c.opened).size,24);
  assert.equal(c.backend.entries.length,24);
  assert.equal(c.lookupBatches.length,2);
  assert.equal(c.lookupBatches[1].length,22);
  assert.match(c.element('#status').textContent,/已停止/);
  assert.equal(c.element('#start').disabled,false);
  assert.equal(c.element('#stop').disabled,true);
  assert.equal(c.trackerActive(),false);
});

test('continuous collection waits at the list end and stopping wakes the wait immediately',async()=>{
  const c=await controller({limit:'',stopOnIdle:false});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(c.element('#status').textContent,/已处理 2 位.*暂无新候选人.*等待/);
  assert.equal(c.element('#start').disabled,true);
  assert.equal(c.element('#stop').disabled,false);
  c.click('#stop');
  await task;
  assert.equal(c.events.filter(event=>event==='advance-list').length,1);
  assert.equal(c.element('#start').disabled,false);
  assert.equal(c.trackerActive(),false);
});

test('continuous waiting discovers a newly loaded card with a recycled id after a list update',async()=>{
  const c=await controller({limit:'',stopOnIdle:false});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  c.setCards([{id:'0',name:'赵**',signature:'新加载候选人'}]);
  for(let attempt=0;attempt<100&&!c.events.includes('close:赵**');attempt++){
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  c.click('#stop');await task;
  assert.deepEqual(c.opened,['一号','二号','新加载候选人']);
  assert.equal(c.lookupBatches.length,2);
  assert.equal(c.lookupBatches[1][0].signature,'新加载候选人');
});

test('large visible lists split status lookups into 200-card requests without imposing a run limit',async()=>{
  const batchCards=Array.from({length:201},(_,index)=>({id:String(index),name:'王**',signature:`候选-${index}`,
    platform_geek_id:String(index+200),boss_chat_uid:String(index+100000)}));
  const backend=memoryBackend();
  backend.entries=batchCards.slice(0,200).map((card,index)=>({id:index+1,job:1,name:card.name,signature:card.signature,share:true}));
  backend.nextId=201;
  const c=await controller({backend,batchCards,limit:''});
  await c.click('#start');
  assert.deepEqual(c.lookupBatches.map(batch=>batch.length),[200,1]);
  assert.deepEqual(c.opened,['候选-200']);
  const ambiguous=await controller({backend,limit:'',batchCards:[...batchCards,{...batchCards[0],id:'201'}]});
  await ambiguous.click('#start');
  assert.ok(ambiguous.lines.some(line=>/暂缓/.test(line.textContent)));
  assert.deepEqual(ambiguous.lookupBatches.map(batch=>batch.length),[200]);
  assert.ok(ambiguous.lookupBatches.flat().every(card=>card.signature!=='候选-0'));
  assert.equal(ambiguous.opened.length,0);
  assert.equal(backend.entries.length,201);
});

test('continuous collection reselects a fresh card when virtualized content changes during a progress lookup',async()=>{
  const c=await controller({limit:'',lookupPages:[[cards[1]]],advancePages:[[cards[0]]]});
  await c.click('#start');
  assert.deepEqual(c.opened,['二号','一号']);
  assert.equal(c.backend.entries.length,2);
  assert.match(c.element('#status').textContent,/已停止/);
});

test('stopping removes unreachable saves but retains confirmed favorites and never opens the next candidate',async()=>{
  for(const [step,expectedSaved,expectedShare] of [
    ['copy',false,false],['evaluate',false,false],['save',false,false],['favorite',true,false],['ack-favorite',true,false],['save-share',true,true],
  ]){
    const c=await controller({limit:'',stopAt:`${step}:张**`});
      await c.click('#start');
    assert.deepEqual(c.opened,['一号']);
    assert.equal(c.backend.entries.length,expectedSaved?1:0);
    assert.equal(Boolean(c.backend.entries[0]?.share),expectedShare);
    assert.ok(!c.events.includes('close:张**'));
    if(['copy','evaluate','save'].includes(step))assert.ok(!c.events.includes('favorite:张**'));
    if(['copy','evaluate','save','favorite','ack-favorite'].includes(step))assert.ok(!c.events.includes('share:张**'));
    assert.equal(c.trackerActive(),false);
  }
});

test('optional counts accept more than twenty and reject invalid values before opening anything',async()=>{
  const many=await controller({limit:'25'});
  await many.click('#start');
  assert.equal(many.opened.length,2);
  for(const limit of ['0','-1','1.5','NaN','9007199254740992']){
    const c=await controller({limit});await c.click('#start');
    assert.match(c.element('#status').textContent,/正整数/);
    assert.equal(c.opened.length,0);
  }
  const html=fs.readFileSync(new URL('../extension/collector.html',import.meta.url),'utf8');
  assert.match(html,/placeholder="留空使用对应操作的默认范围"/);
  assert.match(html,/留空时持续采集/);
  assert.match(html,/人数留空时处理本次列表全部，不自动加载后续列表/);
  assert.doesNotMatch(html,/max="20"|value="5"|本次最多人数/);
});

test('background collection reads DOM and canvas on an inactive tab without copy or active-tab screenshots',async()=>{
  const c=await controller({mode:'background',active:false});
  await c.click('#start');
  assert.deepEqual(c.opened,['一号','二号']);
  assert.equal(c.backend.entries.length,2);
  assert.ok(c.backend.entries.every(entry=>entry.share));
  assert.ok(c.events.includes('background-read:张**'));
  assert.ok(c.events.includes('background-read:李**'));
  assert.ok(c.events.includes('background-share:李**'));
  assert.ok(!c.events.some(event=>event.startsWith('copy:')));
  assert.deepEqual(Array.from(c.requestedPermissions[0].permissions),[]);
  assert.equal(c.trackerActive(),false);
  assert.match(c.element('#status').textContent,/已处理 2 位/);
  const scripts=['canvas-render.js','canvas-expand.js','canvas-geometry.js','canvas-glyphs.js','canvas-platform-assets.js','canvas-text.js'];
  assert.deepEqual(c.registrations[0].js,scripts);
  assert.ok(c.scriptFiles.some(files=>JSON.stringify(files)===JSON.stringify(scripts)));
});

test('foreground collection retains only its original canvas expansion tracker',async()=>{
  const c=await controller({mode:'foreground'});await c.click('#start');
  assert.deepEqual(c.registrations[0].js,['canvas-expand.js']);
  assert.ok(c.scriptFiles.some(files=>JSON.stringify(files)==='["canvas-expand.js"]'));
  assert.ok(c.scriptFiles.every(files=>!files.includes('canvas-render.js')&&!files.includes('canvas-geometry.js')&&!files.includes('canvas-glyphs.js')&&!files.includes('canvas-platform-assets.js')&&!files.includes('canvas-text.js')));
});

test('hidden foreground control overrides an old background preference without Canvas text hooks',async()=>{
  const c=await controller({mode:'background',lockForeground:true,batchCards:[cards[1]]});
  await c.click('#start');
  assert.ok(c.events.includes('copy:李**'));
  assert.ok(!c.events.some(event=>event.startsWith('background-read:')));
  assert.deepEqual(Array.from(c.requestedPermissions[0].permissions),['clipboardRead']);
  assert.deepEqual(c.registrations[0].js,['canvas-expand.js']);
  assert.ok(c.storageWrites.some(write=>write.selectedReadMode==='foreground'));
});

test('verified background platform notes stay in capture metadata and do not enter the resume',async()=>{
  const platformNotes=[{kind:'latest_work_may_be_outdated',text:'最近一份工作经历可能未更新',
    section:'工作经历',anchor:'虚构视觉公司 | 视觉工程师 | 2020.05 - 2026.10'}];
  const c=await controller({mode:'background',batchCards:[cards[1]],platformNotes});
  await c.click('#start');
  assert.equal(c.backend.entries.length,1);
  const candidate=c.backend.entries[0].candidate;
  assert.deepEqual(candidate.capture.platform_notes,platformNotes);
  assert.deepEqual(candidate.capture.warnings,[]);
  assert.equal(candidate.capture.status,'visible_complete');
  assert.doesNotMatch(candidate.resume+candidate.resume_html,/最近一份工作经历可能未更新|询问Ta/);
  assert.ok(!c.posted.includes('/api/ai/evaluate'));
});

test('platform notes cannot override a failed background completeness proof',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],incompleteProof:true,
    platformNotes:[{kind:'latest_work_may_be_outdated',text:'最近一份工作经历可能未更新',
      section:'工作经历',anchor:'虚构视觉公司 | 视觉工程师 | 2020.05 - 2026.10'}]});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.backend.entries.length,0);
  assert.equal(c.element('#review').hidden,false);
  c.click('#stop');await task;
});

test('background mode rejects unsupported drawings, missing continuity and incomplete DOM without advancing',async()=>{
  for(const options of [
    {batchCards:[cards[1],cards[0]],backgroundIssue:'当前画布没有可核对的原文'},
    {batchCards:[cards[1],cards[0]],incompleteProof:true},
    {domIncomplete:true},
  ]){
    const c=await controller({mode:'background',active:false,...options});
    const task=c.click('#start');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(c.element('#review').hidden,false);
    assert.equal(c.backend.entries.length,0);
    assert.equal(c.opened.length,1);
    assert.ok(!c.events.some(event=>event.startsWith('copy:')));
    c.click('#stop');await task;
    assert.equal(c.trackerActive(),false);
  }
});

const baselineFailure={issue:'未从完整重绘开始记录，请重新打开当前简历',issueCode:'baseline',
  diagnostics:{baseline:false,entries:0,overflow:false,operations:{fillText:10},reasonCounts:[]}};

test('a missing drawing baseline reopens only the exact same card and rebinds its new document',async()=>{
  const c=await controller({mode:'background',active:false,batchCards:[cards[1]],changingDocument:true,
    backgroundFailures:[baselineFailure,null]});
  await c.click('#start');
  assert.deepEqual(c.opened,['二号','二号']);
  assert.equal(c.backend.entries.length,1);
  assert.equal(c.backend.entries[0].signature,'二号');
  assert.ok(c.backend.entries[0].share);
  assert.equal(c.events.filter(value=>value==='background-read:李**').length,2);
  assert.equal(c.events.filter(value=>value==='save:李**').length,1);
  assert.equal(c.storageWrites.filter(value=>value.lastBackgroundReadDiagnostic).length,1);
});

test('baseline recovery is bounded per attempt and manual retry permits one more safe reopen',async()=>{
  const c=await controller({mode:'background',active:false,batchCards:[cards[1],cards[0]],changingDocument:true,
    backgroundFailures:[baselineFailure]});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.deepEqual(c.opened,['二号','二号']);
  assert.equal(c.backend.entries.length,0);
  c.click('#review-retry');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.deepEqual(c.opened,['二号','二号','二号']);
  assert.equal(c.backend.entries.length,0);
  c.click('#stop');await task;
});

test('recovery cannot reopen a missing, changed or ambiguous candidate card',async()=>{
  for(const changeCardsOnClose of [[cards[0]],[{...cards[1],name:'王**'}],[cards[1],{...cards[1],id:'9'}]]) {
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundFailures:[baselineFailure],changeCardsOnClose});
    await c.click('#start');
    assert.deepEqual(c.opened,['二号']);assert.equal(c.backend.entries.length,0);
    assert.match(c.element('#status').textContent,/原候选人卡片已变化或不唯一/);
  }
});

test('stopping after recovery closes the old detail prevents reopening any card',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundFailures:[baselineFailure],stopAt:'close:李**'});
  await c.click('#start');
  assert.deepEqual(c.opened,['二号']);assert.equal(c.backend.entries.length,0);
  assert.match(c.element('#status').textContent,/已停止/);
});

test('unsupported render failures keep exact reason on screen, store only safe statistics and do not reopen',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布文字重叠，无法确认正文顺序',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{baseline:true,entries:24,overflow:true,
      reasonCounts:[{reason:'画布文字重叠，无法确认正文顺序',count:72},{reason:'李** https://private.invalid/ 简历正文',count:1}],
      operations:{fillText:25,drawImage:2,privateCandidate:'李**',pageUrl:'https://private.invalid/'},
      text:'敏感简历正文',name:'李**',url:'https://private.invalid/'}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(c.opened,['二号']);assert.match(c.element('#status').textContent,/画布文字重叠/);
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.issueCode,'unsupported');assert.equal(stored.entries,24);assert.equal(stored.overflow,true);
  assert.equal(stored.reasonCounts[0].count,72);assert.equal(stored.reasonCounts[1].reason,'其他绘制限制');
  assert.deepEqual(Object.keys(stored.operations),['fillText','drawImage']);
  assert.doesNotMatch(JSON.stringify(stored),/李|private|简历正文|https/);
  assert.equal(c.element('#read-diagnostic').hidden,false);
  assert.equal(c.element('#read-diagnostic').open,false);
  assert.match(c.element('#read-diagnostic-text').textContent,/已记录文字片段：24 个/);
  assert.match(c.element('#read-diagnostic-text').textContent,/文字填充（fillText）：25 次/);
  assert.match(c.element('#read-diagnostic-text').textContent,/画布文字重叠，无法确认正文顺序：72 次/);
  assert.doesNotMatch(c.element('#read-diagnostic-text').textContent,/李|private|简历正文|https/);
  c.element('#read-diagnostic').open=true;
  c.click('#review-retry');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(c.opened,['二号']);
  assert.equal(c.element('#read-diagnostic').open,false);
  c.click('#stop');await task;
  assert.equal(c.element('#read-diagnostic').hidden,true);
  assert.equal(c.element('#read-diagnostic-text').textContent,'');
});

test('read completeness diagnostics identify fixed failures while keeping valid drawing evidence',async()=>{
  for(const [failureReason,message] of [
    ['continuity-overlap','相邻分屏的原文衔接未确认'],
    ['canvas-range','画布读取范围无效'],
    ['width-clipped','简历画布横向未完整显示'],
    ['readable-region','未确认完整的简历可读取区域'],
    ['unstable','简历内容或滚动位置持续变化'],
    ['scroll-stale','滚动后原文未更新'],
    ['restore-changed','回到上一屏后原文或位置已变化'],
    ['fold-unlocated','仍有折叠内容，但未能唯一定位展开控件'],
    ['expand-limit','展开次数超过上限，尚未确认简历完整性'],
    ['expand-unchanged','已点击展开控件，但页面未确认展开'],
    ['boundary-top','简历顶部仍有截断文字，未确认完整开头'],
    ['boundary-bottom','简历末尾仍有截断文字，滚动后未补齐'],
  ]) {
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundFailures:[{
      issue:'未确认完整性',failureReason,diagnostics:{baseline:true,entries:902,ignoredImages:3,
        operations:{fillText:937},reasonCounts:[]}}]});
    const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
    const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
    assert.equal(stored.issueCode,'incomplete');assert.equal(stored.failureReason,failureReason);
    assert.equal(stored.entries,902);assert.equal(stored.ignoredImages,3);assert.equal(stored.reasonCounts.length,0);
    assert.ok(c.element('#read-diagnostic-text').textContent.includes('失败原因：'+message));
    assert.equal(c.element('#review').hidden,false);assert.equal(c.backend.entries.length,0);
    assert.deepEqual(c.opened,['二号']);c.click('#stop');await task;
  }
});

test('unrecognized completeness reasons cannot store private strings or objects in diagnostics',async()=>{
  for(const failureReason of ['私密正文 https://private.invalid/',{text:'私密正文'},['width-clipped']]){
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundFailures:[{
      issue:'未确认完整性',failureReason,diagnostics:{baseline:true,entries:902,reasonCounts:[]}}]});
    const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
    const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
    assert.equal(Object.hasOwn(stored,'failureReason'),false);
    assert.doesNotMatch(JSON.stringify(stored),/私密|private|https/);
    assert.doesNotMatch(c.element('#read-diagnostic-text').textContent,/私密|private|https|失败原因/);
    assert.equal(c.backend.entries.length,0);c.click('#stop');await task;
  }
});

test('drawing geometry diagnostics keep fixed numeric fields and explain bounds without storing private strings',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布使用了不能确认的图案填充',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{baseline:true,entries:840,ignoredImages:2,
      reasonCounts:[{reason:'画布使用了不能确认的图案填充',count:1}],operations:{fillText:937},details:[
        {kind:'text-overlap',advanceOverlap:.375,inkOverlapX:0,inkOverlapY:12,baselineDelta:0,
          previousWidth:9.375,currentWidth:9.375,previousInkWidth:7.2,currentInkWidth:7.2,
          previousLength:1,currentLength:1,scaleX:1,scaleY:1,text:'私密简历正文',font:'私密字体'},
        {kind:'clip-path',commandCount:4,clipCount:1,
          commands:['moveTo','私密姓名','arcTo','https://private.invalid/','fillText','closePath'],url:'https://private.invalid/'},
        {kind:'path',commandCount:2,clipCount:0,commands:['rect','closePath'],args:['私密参数']},
        {kind:'image',left:20,top:40,right:100,bottom:120,sourceWidth:80,sourceHeight:80,clipCount:1,
          roundClip:true,sourceCanvas:false,fullSource:true,src:'https://private.invalid/',alt:'私密姓名'},
        {kind:'私密类型',left:20,text:'私密简历正文'},
      ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.ignoredImages,2);assert.equal(stored.details.length,4);
  assert.equal(stored.reasonCounts[0].reason,'画布使用了不能确认的图案填充');
  assert.equal(stored.details[0].advanceOverlap,.375);
  assert.deepEqual(Array.from(stored.details[1].commands),['moveTo','arcTo','closePath']);
  assert.equal(stored.details[3].sourceCanvas,false);assert.equal(stored.details[3].fullSource,true);
  assert.doesNotMatch(JSON.stringify(stored),/私密|private|https|"text"|"font"|"src"|"alt"|"args"/);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/已忽略独立图片 2/);
  assert.match(displayed,/排版交叠 0\.375；字形交叠 0 × 12；基线差 0/);
  assert.match(displayed,/前段排版\/字形宽 9\.375 \/ 7\.2/);
  assert.match(displayed,/裁剪路径：命令数 4；裁剪数 1/);
  assert.match(displayed,/移动路径起点（moveTo） → 切线圆弧（arcTo） → 闭合路径（closePath）/);
  assert.match(displayed,/图片：左 20，上 40，右 100，下 120/);
  assert.match(displayed,/源图尺寸 80 × 80；裁剪数 1；圆形裁剪 是；画布来源 否；完整源图 是/);
  assert.doesNotMatch(displayed,/私密|private|https/);
  c.click('#stop');await task;
});

test('coordinate diagnostics retain only bounded geometry and fixed failure reasons',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],
    backgroundIssue:'画布文字的坐标或变换无法确认',backgroundIssueCode:'unsupported',
    backgroundDiagnostics:{baseline:true,reasonCounts:[{reason:'画布文字的坐标或变换无法确认',count:2}],
      details:[{kind:'text-coordinate',reason:'transform',textLength:2,stroke:false,
        xFinite:true,yFinite:true,x:204.5,y:-3,measuredWidth:9.338,metricLeft:-1,metricRight:10,
        metricAscent:12,metricDescent:2,matrixA:1,matrixB:.1,matrixC:0,matrixD:1,matrixE:-5,matrixF:0,
        text:'私密简历正文',font:'私密字体',url:'https://private.invalid/'},
      {kind:'text-coordinate',reason:'私密姓名',textLength:1.5,stroke:'no',x:Infinity,
        measuredWidth:-1,matrixA:'1',matrixE:1e12,xFinite:'true'}]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details.length,1);
  assert.equal(stored.details[0].reason,'transform');assert.equal(stored.details[0].matrixB,.1);
  assert.equal(stored.details[0].metricLeft,-1);assert.equal(stored.details[0].xFinite,true);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/文字坐标检查：变换矩阵未确认；字符数 2；描边 否/);
  assert.match(displayed,/输入位置 204\.5 \/ -3；坐标有限 是 \/ 是；测量宽度 9\.338/);
  assert.match(displayed,/变换 a 1，b 0\.1，c 0，d 1，e -5，f 0/);
  assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|https|"text"|"font"|Infinity/);
  c.click('#stop');await task;
});

test('geometry samples are limited to three per fixed kind, twelve total, and twenty-four path commands',async()=>{
  const details=[];
  for(let i=0;i<6;i++)for(const kind of ['text-overlap','clip-path','path','image'])
    details.push({kind,advanceOverlap:i,left:i,commandCount:30,clipCount:1,commands:Array(30).fill('lineTo')});
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布绘制记录异常',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details.length,12);
  for(const kind of ['text-overlap','clip-path','path','image'])assert.equal(stored.details.filter(item=>item.kind===kind).length,3);
  for(const item of stored.details.filter(item=>['clip-path','path'].includes(item.kind)))assert.equal(item.commands.length,24);
  assert.ok(stored.details.every(item=>item.kind!=='text-overlap'||!Object.hasOwn(item,'left')));
  c.click('#stop');await task;
});

test('text-boundary diagnostics display clipped sides and deferred rows without retaining original text',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布边界截断了文字',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{baseline:true,entries:835,ignoredImages:3,
      reasonCounts:[{reason:'画布边界截断了文字',count:39}],details:[
        {kind:'text-boundary',left:20,top:-2.5,right:32,bottom:9.5,baseline:-.5,textLength:1,
          canvasWidth:1000,canvasHeight:1000,overflowLeft:0,overflowTop:2.5,overflowRight:0,overflowBottom:0,
          deferred:true,text:'私密简历正文',font:'私密字体',url:'https://private.invalid/'},
        {kind:'text-boundary',left:994,top:988,right:1006,bottom:1002,baseline:1000,textLength:1,
          canvasWidth:1000,canvasHeight:1000,overflowLeft:0,overflowTop:0,overflowRight:6,overflowBottom:2,deferred:false},
      ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details.length,2);assert.equal(stored.details[0].baseline,-.5);assert.equal(stored.details[0].deferred,true);
  assert.equal(stored.details[1].deferred,false);assert.equal(stored.details[1].overflowRight,6);
  assert.doesNotMatch(JSON.stringify(stored),/私密|private|https|"text"|"font"|"url"/);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/文字边界：左 20，上 -2\.5，右 32，下 9\.5；基线 -0\.5；字符数 1/);
  assert.match(displayed,/画布尺寸 1000 × 1000；越界 上 2\.5，下 0，左 0，右 0；处理 延后整行/);
  assert.match(displayed,/越界 上 0，下 2，左 0，右 6；处理 拒绝读取/);
  assert.doesNotMatch(displayed,/私密|private|https/);c.click('#stop');await task;
});

test('text-boundary diagnostics reject coerced, nonfinite and invalid unsigned values',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布边界截断了文字',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details:[
      {kind:'text-boundary',left:-1.25,top:'私密姓名',right:NaN,bottom:Infinity,baseline:-3.5,textLength:1.5,
        canvasWidth:'1000',canvasHeight:-1000,overflowLeft:-1,overflowTop:1e10,overflowRight:null,overflowBottom:0,
        deferred:'私密正文',text:'私密正文'},
      {kind:'text-boundary',textLength:-1,baseline:'0',deferred:{value:true}},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.deepEqual(JSON.parse(JSON.stringify(stored.details)),[
    {kind:'text-boundary',left:-1.25,overflowBottom:0,baseline:-3.5},
  ]);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/处理 未记录/);assert.doesNotMatch(displayed,/延后整行|拒绝读取|私密|Infinity|NaN/);
  assert.doesNotMatch(JSON.stringify(stored),/私密|"text"|"deferred"/);c.click('#stop');await task;
});

test('boundary and education samples retain three per kind without displacing other diagnostic kinds',async()=>{
  const kinds=['text-overlap','clip-path','path','image','notice-check','glyph-check','text-boundary','education-check'],details=[];
  for(const kind of kinds)for(let index=0;index<5;index++)details.push({kind,left:index,advanceOverlap:index,
    commandCount:index,panelCount:index,sharedPixels:index,textLength:index,candidateCount:index,deferred:true});
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布边界截断了文字',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details.length,24);
  for(const kind of kinds)assert.equal(stored.details.filter(item=>item.kind===kind).length,3);
  assert.ok(stored.details.every(item=>item.kind==='text-boundary'||!Object.hasOwn(item,'deferred')));
  c.click('#stop');await task;
});

test('invalid, unbounded, coercible and non-numeric geometry values cannot enter stored diagnostics',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布绘制记录异常',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{ignoredImages:'3',details:[
      null,[],{kind:'unknown',left:10},
      {kind:'text-overlap',advanceOverlap:Infinity,inkOverlapX:NaN,inkOverlapY:-1,baselineDelta:'私密正文',
        previousWidth:1e10,currentWidth:9.375,previousInkWidth:null,currentInkWidth:7,
        previousLength:1.5,currentLength:-2,scaleX:'1',scaleY:1},
      {kind:'image',left:-2.5,top:0,right:Number.MAX_SAFE_INTEGER,bottom:NaN,sourceWidth:-80,sourceHeight:80,
        clipCount:2.5,roundClip:'私密姓名',sourceCanvas:0,fullSource:false,commands:['rect']},
      {kind:'path',commandCount:NaN,clipCount:-1,commands:['https://private.invalid/',{},null,17,'closePath']},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.ignoredImages,0);assert.equal(stored.details.length,3);
  assert.deepEqual(JSON.parse(JSON.stringify(stored.details[0])),{kind:'text-overlap',currentWidth:9.375,currentInkWidth:7,scaleY:1});
  assert.deepEqual(JSON.parse(JSON.stringify(stored.details[1])),{kind:'image',left:-2.5,top:0,sourceHeight:80,fullSource:false});
  assert.deepEqual(JSON.parse(JSON.stringify(stored.details[2])),{kind:'path',commands:['closePath']});
  assert.doesNotMatch(JSON.stringify(stored),/私密|private|https|Infinity|NaN/);
  assert.doesNotMatch(c.element('#read-diagnostic-text').textContent,/私密|private|https|Infinity|NaN/);
  c.click('#stop');await task;
});

test('notice diagnostics preserve fixed reasons and signed gaps without retaining original text',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布含无法确认是否属于正文的图片，不能完整读取原文',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details:[
      {kind:'notice-check',reason:'image-text-overlap',headerVerified:true,metadataVerified:true,
        panelCount:1,panelExactCount:1,panelEntryCount:21,panelTextLength:21,globalRowExact:false,panelTextExact:true,
        sameRowOutsideEntries:1,partialTextCount:0,unsafeIssueCount:0,overlapIssuesInPanel:0,
        imageW:22,imageH:22,panelW:600,panelH:44,signedGapX:-4,centerDeltaY:2,
        touchCount:1,maxTextOverlapX:4,maxTextOverlapY:12,panelFromFill:true,panelFromClip:true,
        fullSource:true,validSource:true,text:'私密简历正文',url:'https://private.invalid/'},
      {kind:'notice-check',reason:'私密姓名 https://private.invalid/',panelCount:1.5,panelTextLength:'私密正文',
        signedGapX:-2.5,centerDeltaY:-1,touchCount:'1',globalRowExact:true,panelTextExact:'true',imageW:Infinity},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details[0].reason,'image-text-overlap');assert.equal(stored.details[0].signedGapX,-4);
  assert.equal(stored.details[0].panelTextExact,true);assert.equal(stored.details[0].sameRowOutsideEntries,1);
  assert.deepEqual(JSON.parse(JSON.stringify(stored.details[1])),{kind:'notice-check',signedGapX:-2.5,globalRowExact:true});
  assert.doesNotMatch(JSON.stringify(stored),/私密|private|https|"text"|"url"/);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/提示条检查：图片范围与文字相交/);assert.match(displayed,/文字水平间隔 -4/);
  assert.match(displayed,/全行文案匹配 否；容器文案匹配 是/);assert.match(displayed,/同一行容器外片段 1/);
  assert.match(displayed,/最大交叠 4 × 12/);assert.doesNotMatch(displayed,/私密|private|https|Infinity/);
  c.click('#stop');await task;
});

test('header history diagnostics display only fixed confirmation and bounded image counts',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'其他正文图片未确认',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details:[
      {kind:'header-history',imageCount:3,historyVerified:true,reason:'私密姓名',text:'私密正文',
        token:'private-token',sourceLineage:[{private:'缓存'}],url:'https://private.invalid/'},
      {kind:'header-history',imageCount:0,historyVerified:false,reason:'accepted'},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.deepEqual(JSON.parse(JSON.stringify(stored.details)),[
    {kind:'header-history',imageCount:3,historyVerified:true},
    {kind:'header-history',imageCount:0,historyVerified:false},
  ]);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/前屏页首装饰：已确认；沿用图片 3 张/);
  assert.match(displayed,/前屏页首装饰：未确认；沿用图片 0 张/);
  assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|sourceLineage|token|https|accepted|"text"|"url"/);
  c.click('#stop');await task;
});

test('header history diagnostics discard invalid counts, coerced flags and arbitrary private fields',async()=>{
  const details=[-1,0.5,'3',NaN,Infinity,1000000001,{}].map(imageCount=>
    ({kind:'header-history',imageCount,historyVerified:'true',reason:'私密姓名',text:'private-text'}));
  details.push({kind:'header-history',imageCount:3,historyVerified:'私密正文'},
    {kind:'header-history',imageCount:'私密数量',historyVerified:false},
    {kind:'header-history-private',imageCount:3,historyVerified:true});
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布绘制记录异常',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.deepEqual(JSON.parse(JSON.stringify(stored.details)),[
    {kind:'header-history',imageCount:3},
    {kind:'header-history',historyVerified:false},
  ]);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/前屏页首装饰：未确认；沿用图片 3 张/);
  assert.match(displayed,/前屏页首装饰：未确认；沿用图片 未记录 张/);
  assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|Infinity|NaN|已确认|"reason"|"text"/);
  c.click('#stop');await task;
});

test('education text approvals omit obsolete crest integrity diagnostics while preserving only fixed fields',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'其他正文图片未确认',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{baseline:true,entries:808,ignoredImages:2,details:[
      {kind:'education-check',reason:'accepted-text',sectionVerified:true,titleVerified:true,dateVerified:true,
        imageW:56,imageH:56,paintW:56,paintH:56,paintBoundsComplete:false,cacheComplete:false,
        fullSource:false,decorationPaint:false,roundRectClips:1,candidateCount:1,
        school:'私密院校',text:'私密原文',sourceLineage:[{private:'source'}]},
      {kind:'education-check',reason:'accepted-text-history',sectionVerified:true,titleVerified:true,dateVerified:true,
        historyRecorded:true,sectionFromHistory:true,boundaryFromHistory:true,paintIdentity:{private:'identity'},
        key:'私密院校专业和日期',url:'https://private.invalid/'},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.deepEqual(Array.from(stored.details,detail=>detail.reason),['accepted-text','accepted-text-history']);
  assert.ok(stored.details.every(detail=>detail.sectionVerified&&detail.titleVerified&&detail.dateVerified));
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/教育信息：院校文字已确认，已忽略校徽/);
  assert.match(displayed,/教育信息：教育文字上下文已确认，已忽略校徽/);
  assert.equal(displayed.match(/教育区段 是；院校条目 是；起止日期 是/g)?.length,2);
  assert.doesNotMatch(displayed,/院校徽标检查|原绘制框|完整源图|图框|裁剪：|前屏教育证明|候选图标数/);
  assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|https|"school"|"text"|sourceLineage|paintIdentity|"key"|"url"/);
  assert.equal(c.backend.entries.length,0);c.click('#stop');await task;
});

test('education-logo diagnostics explain verified school decoration without retaining school or resume content',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布含无法确认是否属于正文的图片，不能完整读取原文',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{baseline:true,entries:763,ignoredImages:2,details:[
      {kind:'education-check',reason:'accepted',imageW:56,imageH:56,signedGapX:12,touchCount:0,candidateCount:1,
        rowTopOffset:24,rowBottomOffset:36,rowCenterDeltaY:2,
        sectionVerified:true,titleVerified:true,dateVerified:true,fullSource:true,validSource:true,
        paintW:56,paintH:56,rectClips:1,roundRectClips:1,ellipseClips:0,fullPaint:false,decorationPaint:true,
        paintBoundsComplete:true,clipContained:false,frameClipConfirmed:true,paintOpaque:true,
        paintForward:true,paintIntact:true,cacheComplete:true,sourceCanvas:false,
        school:'私密院校',major:'私密专业',text:'私密简历正文',url:'https://private.invalid/'},
      {kind:'education-check',reason:'image-text-overlap',imageW:56,imageH:56,signedGapX:-2.5,touchCount:1,candidateCount:1,
        sectionVerified:true,titleVerified:true,dateVerified:false,fullSource:true,validSource:true},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details.length,2);assert.equal(stored.details[0].reason,'accepted');
  assert.equal(stored.details[0].candidateCount,1);assert.equal(stored.details[0].dateVerified,true);
  assert.equal(stored.details[0].fullPaint,false);assert.equal(stored.details[0].decorationPaint,true);
  assert.equal(stored.details[0].roundRectClips,1);assert.equal(stored.details[0].sourceCanvas,false);
  assert.equal(stored.details[0].rowTopOffset,24);assert.equal(stored.details[0].rowBottomOffset,36);
  assert.equal(stored.details[0].rowCenterDeltaY,2);
  assert.equal(stored.details[1].signedGapX,-2.5);assert.equal(stored.details[1].dateVerified,false);
  assert.doesNotMatch(JSON.stringify(stored),/私密|private|https|"school"|"major"|"text"|"url"/);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/已忽略独立图片 2/);assert.doesNotMatch(displayed,/页首装饰/);
  assert.match(displayed,/院校徽标检查：已确认院校装饰/);
  assert.match(displayed,/教育区段 是；院校条目 是；起止日期 是；候选图标数 1/);
  assert.match(displayed,/图框 56 × 56；文字水平间隔 12；触字片段 0/);
  assert.match(displayed,/标题相对图框顶部：上沿 24，下沿 36；中心差 2/);
  assert.match(displayed,/院校徽标检查：图片范围与文字相交/);
  assert.match(displayed,/文字水平间隔 -2\.5；触字片段 1/);
  assert.match(displayed,/完整源图 是；有效源范围 是/);assert.doesNotMatch(displayed,/私密|private|https/);
  assert.match(displayed,/原绘制框 56 × 56；原框完整 是；缓存复制完整 是/);
  assert.match(displayed,/裁剪：矩形 1，圆角矩形 1，椭圆 0；完整包含 否；同框装饰裁剪 是/);
  assert.match(displayed,/矩形绘制完整 否；装饰轮廓完整 是；未被覆盖 是；不透明绘制 是；正向绘制 是/);
  assert.equal(c.element('#review').hidden,false);assert.equal(c.backend.entries.length,0);
  c.click('#stop');await task;
});

test('education continuity diagnostics expose only fixed flags and never identities, title keys or source versions',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'其他正文图片未确认',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{baseline:true,entries:657,ignoredImages:1,details:[
      {kind:'education-check',reason:'accepted-history',sectionVerified:true,titleVerified:true,dateVerified:true,
        historyRecorded:true,sectionFromHistory:true,historySourceStable:true,historyTitleMatched:true,historyHeadingAbove:true,
        imageW:56,imageH:56,paintIdentity:{private:'身份'},sourceLineage:[{private:'缓存'}],
        key:'私密院校专业和日期',token:'private-token',dependencies:[{private:'原文'}]},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details[0].reason,'accepted-history');assert.equal(stored.details[0].sectionFromHistory,true);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/院校徽标检查：已确认同次读取中的院校装饰/);
  assert.match(displayed,/前屏教育证明：缓存来源一致 是；院校条目一致 是；标题已滚出顶部 是；本屏沿用 是/);
  assert.match(displayed,/边界校徽沿用 未记录/);
  assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|paintIdentity|sourceLineage|dependencies|token|"key"/);
  assert.equal(c.backend.entries.length,0);c.click('#stop');await task;
});

test('education boundary continuation displays fixed approval and preserves only boolean history flags',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'其他正文图片未确认',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{baseline:true,entries:986,ignoredImages:2,details:[
      {kind:'education-check',reason:'accepted-boundary-history',imageW:56,imageH:52,historyRecorded:true,
        sectionFromHistory:false,boundaryFromHistory:true,historySourceStable:true,historyTitleMatched:true,historyHeadingAbove:false,
        text:'私密院校正文',paintIdentity:{private:'身份'},sourceLineage:[{private:'缓存'}],key:'私密姓名'},
      {kind:'education-check',reason:'image-cache-crop',historyRecorded:true,boundaryFromHistory:false},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details[0].reason,'accepted-boundary-history');
  assert.equal(stored.details[0].sectionFromHistory,false);assert.equal(stored.details[0].boundaryFromHistory,true);
  assert.equal(stored.details[1].boundaryFromHistory,false);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/院校徽标检查：已确认同次读取中的边界校徽/);
  assert.match(displayed,/前屏教育证明：缓存来源一致 是；院校条目一致 是；标题已滚出顶部 否；本屏沿用 否；边界校徽沿用 是/);
  assert.match(displayed,/边界校徽沿用 否/);
  assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|paintIdentity|sourceLineage|"text"|"key"/);
  assert.equal(c.backend.entries.length,0);c.click('#stop');await task;
});

test('education-logo diagnostics reject arbitrary reasons, malformed counts and coerced verification flags',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布绘制记录异常',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details:[
      {kind:'education-check',reason:'私密姓名 https://private.invalid/',imageW:Infinity,imageH:-56,signedGapX:-2.5,
        rowTopOffset:'-2',rowBottomOffset:Infinity,rowCenterDeltaY:{text:'私密正文'},
        historyRecorded:'true',sectionFromHistory:1,historySourceStable:{private:'正文'},historyTitleMatched:[],historyHeadingAbove:null,boundaryFromHistory:'true',
        touchCount:1.5,candidateCount:'1',sectionVerified:'true',titleVerified:1,dateVerified:{value:true},fullSource:false,
        paintW:Infinity,paintH:'56',rectClips:1.5,roundRectClips:-1,ellipseClips:'0',fullPaint:'false',
        decorationPaint:'true',paintBoundsComplete:1,clipContained:0,frameClipConfirmed:{value:true},paintOpaque:[],
        paintForward:null,paintIntact:'私密正文',cacheComplete:['私密数据'],sourceCanvas:{text:'私密正文'},
        validSource:['私密正文'],text:'私密正文',panelCount:1,commands:['rect']},
      {kind:'education-check',reason:['accepted'],imageW:NaN,imageH:1e10,signedGapX:'12',touchCount:-1,
        candidateCount:1.5,sectionVerified:null,titleVerified:[],dateVerified:'false',fullSource:'false',boundaryFromHistory:[true]},
      {kind:'education-check',reason:'accepted-boundary-history 私密正文',boundaryFromHistory:1},
      {kind:'education-check',reason:'accepted-text 私密院校',sectionVerified:'true',titleVerified:'true',dateVerified:1},
      {kind:'education-check',reason:['accepted-text-history'],text:'私密原文'},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.deepEqual(JSON.parse(JSON.stringify(stored.details)),[
    {kind:'education-check',signedGapX:-2.5,fullSource:false},
  ]);
  assert.doesNotMatch(JSON.stringify(stored),/私密|private|https|"text"|"commands"|"panelCount"/);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/院校徽标检查：未确认/);
  assert.match(displayed,/教育区段 未记录；院校条目 未记录；起止日期 未记录；候选图标数 未记录/);
  assert.doesNotMatch(displayed,/已确认院校装饰|已忽略校徽|私密|private|https|Infinity|NaN/);
  c.click('#stop');await task;
});

test('education image diagnostics distinguish source, mask, crop and changed-paint failures',async()=>{
  for(const [reason,message] of [
    ['title-alignment','院校标题与日期的纵向位置不符合徽标布局'],
    ['image-source','图片源范围未确认'],['image-canvas','图片来源为未确认画布'],
    ['image-modified','图片已被局部擦除或覆盖'],['image-opacity','图片不是不透明绘制'],
    ['image-direction','图片绘制方向未确认'],['image-bounds','图片绘制边界不完整'],
    ['image-cache-crop','缓存复制裁切了图片'],['image-clip','图片裁剪轮廓未确认'],
  ]){
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布含无法确认是否属于正文的图片，不能完整读取原文',
      backgroundIssueCode:'unsupported',backgroundDiagnostics:{details:[
        {kind:'education-check',reason,fullSource:true,validSource:true,decorationPaint:false,
          paintW:56,paintH:56,paintIntact:false,cacheComplete:false,frameClipConfirmed:false,
          text:'私密简历正文',src:'https://private.invalid/'},
      ]}});
    const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
    const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
    assert.equal(stored.details[0].reason,reason);assert.equal(stored.details[0].cacheComplete,false);
    const displayed=c.element('#read-diagnostic-text').textContent;
    assert.ok(displayed.includes('院校徽标检查：'+message));
    assert.match(displayed,/缓存复制完整 否/);assert.match(displayed,/装饰轮廓完整 否；未被覆盖 否/);
    assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|https|"text"|"src"/);
    assert.equal(c.element('#review').hidden,false);assert.equal(c.backend.entries.length,0);
    c.click('#stop');await task;
  }
});

test('glyph diagnostics explain verified pixel evidence with fixed reasons and safe integer counters',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布文字重叠，无法确认正文顺序',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details:[
      {kind:'glyph-check',reason:'metrics-mismatch',ok:false,separate:false,sharedPixels:0,firstPixels:0,secondPixels:0,
        text:'私密正文',font:'私密字体',url:'https://private.invalid/'},
      {kind:'glyph-check',reason:'私密原因',ok:'true',separate:1,sharedPixels:2,firstPixels:1.5,secondPixels:-1},
      {kind:'glyph-check',reason:'pixel-overlap',ok:true,separate:false,sharedPixels:4,firstPixels:80,secondPixels:75},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details[0].reason,'metrics-mismatch');assert.equal(stored.details[0].ok,false);
  assert.deepEqual(JSON.parse(JSON.stringify(stored.details[1])),{kind:'glyph-check',sharedPixels:2});
  assert.equal(stored.details[2].sharedPixels,4);assert.equal(stored.details[2].separate,false);
  assert.doesNotMatch(JSON.stringify(stored),/私密|private|https|"text"|"font"|"url"/);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/字形复核：字体重放测量不一致/);assert.match(displayed,/字形复核：字形像素确实相交/);
  assert.match(displayed,/共享像素 4；前后字形像素 80 \/ 75/);assert.doesNotMatch(displayed,/私密|private|https/);
  c.click('#stop');await task;
});

test('partial cover diagnostics identify the paint region without storing original text or styles',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布文字被局部覆盖',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details:[
      {kind:'text-cover',operation:'fillRect',left:130.5,top:240,right:146,bottom:254,
        coverLeft:144,coverTop:238,coverRight:192,coverBottom:256,textLength:1,clipCount:1,
        contained:false,clipContained:true,verification:'ink-hit',coveredPixels:3,coveredCorePixels:1,
        advanceLeft:130,advanceRight:144,baseline:253,pixels:124,corePixels:61,maxCoveredAlpha:208,
        coveredLeft:144,coveredTop:250,coveredRight:145,coveredBottom:252,
        rightEdgeOnly:true,edgeCoreAdjacent:false,highlightCandidate:false,priorHighlightCell:true,highlightContinuity:true,
        text:'私密原文',font:'private-font',style:'private-color',raster:{data:'private-bitmap'},url:'https://private.invalid/'},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details[0].operation,'fillRect');assert.equal(stored.details[0].coveredPixels,3);
  assert.equal(stored.details[0].contained,false);assert.equal(stored.details[0].coverLeft,144);
  assert.equal(stored.details[0].advanceRight,144);assert.equal(stored.details[0].corePixels,61);
  assert.equal(stored.details[0].maxCoveredAlpha,208);assert.equal(stored.details[0].coveredBottom,252);
  assert.equal(stored.details[0].rightEdgeOnly,true);assert.equal(stored.details[0].edgeCoreAdjacent,false);
  assert.equal(stored.details[0].highlightCandidate,false);
  assert.equal(stored.details[0].priorHighlightCell,true);assert.equal(stored.details[0].highlightContinuity,true);
  assert.match(c.element('#read-diagnostic-text').textContent,/文字排版：左 130，右 144；基线 253/);
  assert.match(c.element('#read-diagnostic-text').textContent,/总核心像素 61/);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/文字覆盖：矩形填充；绘制范围触及字形像素/);
  assert.match(displayed,/绘制框：左 144，上 238，右 192，下 256/);
  assert.match(displayed,/触及字形像素 3；其中核心像素 1/);
  assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|https|bitmap|"text"|"font"|"style"|"raster"/);
  c.click('#stop');await task;
});

test('partial cover diagnostics reject arbitrary labels, coerced flags and invalid pixels',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布文字被局部覆盖',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details:[
      {kind:'text-cover',operation:'私密操作',verification:'private-source',left:-1.5,coverLeft:-2.5,
        coverTop:Infinity,coverRight:'9',coverBottom:NaN,textLength:1.5,clipCount:-1,
        contained:'true',clipContained:1,coveredPixels:'4',coveredCorePixels:-1,text:'私密正文',
        advanceLeft:'2',advanceRight:NaN,baseline:Infinity,coveredLeft:'2',coveredTop:Infinity,
        pixels:-1,corePixels:1.5,maxCoveredAlpha:256,rightEdgeOnly:1,edgeCoreAdjacent:'true',highlightCandidate:[],
        priorHighlightCell:1,highlightContinuity:'true'},
      {kind:'text-cover',operation:'fill-path',verification:'unavailable',coveredPixels:1e12,clipCount:2.5},
      {kind:'text-cover',operation:'clearRect',verification:'ink-clear',coveredPixels:0,coveredCorePixels:0},
      {kind:'text-cover',operation:'fillRect',coveredPixels:99},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.deepEqual(JSON.parse(JSON.stringify(stored.details)),[
    {kind:'text-cover',left:-1.5,coverLeft:-2.5},
    {kind:'text-cover',operation:'fill-path',verification:'unavailable'},
    {kind:'text-cover',coveredPixels:0,coveredCorePixels:0,operation:'clearRect',verification:'ink-clear'},
  ]);
  assert.doesNotMatch(JSON.stringify(stored)+c.element('#read-diagnostic-text').textContent,/私密|private|Infinity|NaN|99/);
  c.click('#stop');await task;
});

test('new notice and glyph diagnostics retain three samples per kind without displacing image evidence',async()=>{
  const details=[];
  for(let i=0;i<6;i++)for(const kind of ['text-overlap','clip-path','path','image','notice-check','glyph-check'])
    details.push({kind,advanceOverlap:i,left:i,commandCount:1,clipCount:1,commands:['rect'],
      panelCount:1,reason:kind==='glyph-check'?'pixel-overlap':'text-mismatch',sharedPixels:i,ok:true});
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布绘制记录异常',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details.length,18);
  for(const kind of ['text-overlap','clip-path','path','image','notice-check','glyph-check'])
    assert.equal(stored.details.filter(item=>item.kind===kind).length,3);
  c.click('#stop');await task;
});

test('glyph edge evidence keeps bounded alpha and core-pixel statistics as diagnostics only',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'画布文字重叠，无法确认正文顺序',
    backgroundIssueCode:'unsupported',backgroundDiagnostics:{details:[
      {kind:'glyph-check',reason:'edge-only',ok:true,separate:false,edgeOnly:true,
        sharedPixels:4,firstPixels:80,secondPixels:75,sharedCorePixels:0,firstCorePixels:50,secondCorePixels:45,maxSharedMinAlpha:127},
      {kind:'glyph-check',edgeOnly:'true',sharedCorePixels:1.5,firstCorePixels:-1,secondCorePixels:Infinity,maxSharedMinAlpha:256},
    ]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(stored.details.length,1);assert.equal(stored.details[0].reason,'edge-only');
  assert.equal(stored.details[0].edgeOnly,true);assert.equal(stored.details[0].sharedCorePixels,0);
  assert.equal(stored.details[0].maxSharedMinAlpha,127);
  const displayed=c.element('#read-diagnostic-text').textContent;
  assert.match(displayed,/字形复核：仅抗锯齿边缘相交/);
  assert.match(displayed,/共享核心像素 0；前后核心像素 50 \/ 45；共享 alpha 上限 127/);
  assert.equal(c.element('#review').hidden,false);assert.ok(!c.events.some(event=>event.startsWith('save:')));
  c.click('#stop');await task;
});

test('unfinished rendering keeps its diagnostic type and waits for manual retry without reopening',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'当前可读取区域没有完整文字行',
    backgroundIssueCode:'rendering',backgroundDiagnostics:{baseline:true,entries:0,operations:{clearRect:1},reasonCounts:[]}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(c.opened,['二号']);assert.equal(c.backend.entries.length,0);
  assert.equal(c.element('#review').hidden,false);
  assert.match(c.element('#read-diagnostic-text').textContent,/检查结果：画布文字仍未绘制完成/);
  assert.equal(c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic.issueCode,'rendering');
  c.click('#stop');await task;
});

test('background callback diagnostics retain bounded counters and never callback or page content',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'绘制尚未完成',
    backgroundIssueCode:'rendering',backgroundDiagnostics:{baseline:true,entries:0,reasonCounts:[],
      scheduler:{pending:2,nativeFrames:4,pumpedFrames:3,untrackedFrames:Infinity,hidden:true,
        callback:'private resume',url:'https://private.example'}}});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
  assert.equal(JSON.stringify(stored.scheduler),JSON.stringify({pending:2,nativeFrames:4,pumpedFrames:3,untrackedFrames:0,hidden:true}));
  assert.match(c.element('#read-diagnostic-text').textContent,/待绘制回调：2；原生执行：4；后台补调：3/);
  assert.match(c.element('#read-diagnostic-text').textContent,/页面可见性：后台隐藏/);
  assert.doesNotMatch(JSON.stringify(stored),/private|https|Infinity/);
  c.click('#stop');await task;
});

test('scroll diagnostics retain bounded motion facts and display them without page text or identity',async()=>{
  for(const [mode,action,modeLabel,actionLabel] of [
    ['native','restore','页面滚动','恢复已确认位置'],
    ['wheel','top','画布滚动','返回顶部'],
    ['mixed','next','页面与画布滚动','读取下一屏'],
  ]){
    const expected={mode,action,hidden:true,virtualScroll:true,requestedPixels:-525.8,nativePixels:-2,
      wheelPixels:523.8,beforeTop:2,observedTop:0,clientHeight:956,scrollHeight:978,ownerCount:2,notifications:1,pointerNotifications:4};
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'原文尚未前进',
      backgroundDiagnostics:{baseline:true,entries:643,motion:{...expected,
        canvasId:'私密标识',token:'private-token',text:'私密正文',url:'https://private.example',owner:{name:'私密'},
        pointerTarget:'私密位置',pointerPosition:{x:100,y:200}}}});
    const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
    const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
    assert.deepEqual(JSON.parse(JSON.stringify(stored.motion)),expected);
    const displayed=c.element('#read-diagnostic-text').textContent;
    assert.match(displayed,new RegExp(`滚动推进：${modeLabel}；动作 ${actionLabel}`));
    assert.match(displayed,/请求步长 -525.8；原生实际移动 -2；画布滚轮 523.8/);
    assert.match(displayed,/滚动位置 2 → 0；可读高度 956；总滚动高度 978/);
    assert.match(displayed,/滚动区域 2 个；位置通知 1 次；画布定位 4 次；画布滚轮 已发送/);
    assert.doesNotMatch(displayed,/画布内部滚动|已启用/);
    assert.doesNotMatch(JSON.stringify(stored)+displayed,/private|私密|canvasId|token|https/);
    assert.equal(c.backend.entries.length,0);c.click('#stop');await task;
  }
});

test('scroll diagnostics discard unknown labels, coerced values, invalid bounds and private fields',async()=>{
  for(const motion of [
    {mode:'私密内容',action:'next',requestedPixels:5},
    {mode:'native',action:'https://private.example',requestedPixels:5},
    ['native','next'],
    {mode:'native',action:'next',hidden:'true',virtualScroll:1,requestedPixels:'525',nativePixels:NaN,
      wheelPixels:Infinity,beforeTop:-1,observedTop:10000001,clientHeight:null,scrollHeight:'956',
      ownerCount:1.5,notifications:-1,pointerNotifications:1.5,callback:'私密',url:'https://private.example'},
    {mode:'wheel',action:'top',requestedPixels:-10000001,nativePixels:10000001,wheelPixels:-Infinity,
      beforeTop:'0',observedTop:NaN,clientHeight:-2,scrollHeight:Infinity,ownerCount:1001,notifications:'2',pointerNotifications:1001},
  ]){
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'原文尚未前进',
      backgroundDiagnostics:{baseline:true,entries:643,motion}});
    const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
    const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
    const recognized=['native','wheel'].includes(motion.mode)&&['next','top'].includes(motion.action);
    if(recognized)assert.deepEqual(JSON.parse(JSON.stringify(stored.motion)),
      {mode:motion.mode,action:motion.action,hidden:false,virtualScroll:false});
    else assert.equal(stored.motion,undefined);
    const displayed=c.element('#read-diagnostic-text').textContent;
    assert.doesNotMatch(JSON.stringify(stored)+displayed,/private|私密|https|Infinity|NaN|callback/);
    if(!recognized)assert.doesNotMatch(displayed,/滚动推进/);
    c.click('#stop');await task;
  }
});

test('canvas pointer diagnostics accept only bounded integer counts and do not imply successful scrolling',async()=>{
  for(const pointerNotifications of [0,1000,-1,1001,1.5,'4',null,undefined,NaN,Infinity,{count:4}]){
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundIssue:'原文尚未前进',
      backgroundDiagnostics:{baseline:true,entries:643,motion:{mode:'mixed',action:'next',
        pointerNotifications,virtualScroll:false}}});
    const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
    const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
    const accepted=pointerNotifications===0||pointerNotifications===1000;
    const expected={mode:'mixed',action:'next',hidden:false,virtualScroll:false,
      ...(accepted?{pointerNotifications}:{})};
    assert.deepEqual(JSON.parse(JSON.stringify(stored.motion)),expected);
    const displayed=c.element('#read-diagnostic-text').textContent;
    assert.match(displayed,new RegExp(`画布定位 ${accepted?pointerNotifications:'未记录'} 次；画布滚轮 未发送`));
    assert.doesNotMatch(displayed,/已启用|画布内部滚动|Infinity|NaN/);
    assert.equal(c.backend.entries.length,0);c.click('#stop');await task;
  }
});

test('horizontal diagnostics distinguish blank margins and hidden content using bounded geometry only',async()=>{
  const reasons={
    'full-width':'画布横向完整显示','empty-margins':'仅空白边距被裁，正文已完整显示',
    'text-outside':'正文超出横向可见范围','image-outside':'未知图片超出横向可见范围',
    'drawing-outside':'横向隐藏区域存在未确认的绘制','unconfirmed':'横向完整性证据尚未确认',
  };
  for(const [reason,label] of Object.entries(reasons)) {
    const complete=['full-width','empty-margins'].includes(reason);
    const horizontal={reason,complete,canvasWidth:773,visibleLeft:0,visibleRight:758,clippedLeft:0,clippedRight:15,
      textLeft:133.25,textRight:723.5,outsideTextRuns:complete?0:2,outsideImages:complete?0:1,outsideIssues:0,
      canvasCssWidth:773,visibleCssWidth:758,clippedCssLeft:0,clippedCssRight:15,
      source:'私密正文 https://private.example',url:'https://private.example',proof:{text:'原文'}};
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundFailures:[{
      issue:'未确认完整性',failureReason:'width-clipped',diagnostics:{baseline:true,entries:513,horizontal}}]});
    const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
    const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
    const {source,url,proof,...expected}=horizontal;
    assert.deepEqual(JSON.parse(JSON.stringify(stored.horizontal)),expected);
    const displayed=c.element('#read-diagnostic-text').textContent;
    assert.match(displayed,new RegExp('横向完整性检查：'+label));
    assert.match(displayed,/画布像素宽 773；可见横向 0 ～ 758；裁切 左 0，右 15/);
    assert.match(displayed,/页面显示宽 773 CSS 像素；可见宽 758/);
    assert.match(displayed,new RegExp(`已记录正文边界：左 133.25，右 723.5；横向完整 ${complete?'是':'否'}`));
    assert.match(displayed,new RegExp(`可见范围外：文字 ${complete?0:2} 段；未知图片 ${complete?0:1} 张；绘制问题 0 处`));
    assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|https|source|proof/);
    assert.equal(c.backend.entries.length,0);c.click('#stop');await task;
  }
});

test('horizontal diagnostics reject unknown reasons and omit invalid or coercible values',async()=>{
  for(const horizontal of [
    {reason:'私密正文 https://private.example',canvasWidth:773},
    {reason:'text-outside',complete:'true',canvasWidth:Infinity,visibleLeft:-1,visibleRight:'758',clippedLeft:NaN,
      clippedRight:10000001,textLeft:-.25,textRight:10000001,outsideTextRuns:1.5,outsideImages:-1,outsideIssues:10000001,
      canvasCssWidth:[],visibleCssWidth:{private:'正文'},clippedCssLeft:'0',clippedCssRight:Infinity},
  ]) {
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundFailures:[{
      issue:'未确认完整性',diagnostics:{baseline:true,entries:513,horizontal}}]});
    const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
    const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
    const displayed=c.element('#read-diagnostic-text').textContent;
    if(horizontal.reason==='text-outside'){
      assert.equal(JSON.stringify(stored.horizontal),JSON.stringify({reason:'text-outside',textLeft:-.25}));
      assert.match(displayed,/已记录正文边界：左 -0.25，右 未记录；横向完整 未记录/);
      assert.match(displayed,/可见范围外：文字 未记录 段；未知图片 未记录 张；绘制问题 未记录 处/);
    }else{
      assert.equal(stored.horizontal,undefined);assert.doesNotMatch(displayed,/横向完整性检查：/);
    }
    assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|https|Infinity|10000001|758/);
    c.click('#stop');await task;
  }
});

test('overlap diagnostics explain exact failure without retaining resume fragments or untrusted fields',async()=>{
  for(const reason of ['short','repetitive','independent','ambiguous','footer','raw']) {
    const overlap={reason,overlapLength:347,rawOverlapLength:340,letterCount:310,distinctLetters:83,
      duplicateWindows:31,independentRunLength:12,previousMatches:1,currentMatches:1,assembledMatches:1,
      previousLength:747,currentLength:763,retries:2,stepPercent:13.75,
      previous:'私密原文 https://private.example',fragment:'候选人私密内容'};
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundFailures:[{
      issue:'未确认完整性',failureReason:'continuity-overlap',diagnostics:{baseline:true,entries:747,overlap}}]});
    const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
    const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
    assert.equal(stored.overlap.reason,reason);assert.equal(stored.overlap.rawOverlapLength,340);
    assert.equal(stored.overlap.retries,2);assert.equal(stored.overlap.stepPercent,13.75);
    const displayed=c.element('#read-diagnostic-text').textContent;
    assert.match(displayed,/分屏衔接检查：/);assert.match(displayed,/最长独立区段 12/);
    assert.match(displayed,/已补读 2 次；当前滚动步长 13.75%/);
    assert.doesNotMatch(JSON.stringify(stored)+displayed,/私密|private|https|fragment/);
    assert.equal(c.backend.entries.length,0);c.click('#stop');await task;
  }
});

test('overlap diagnostics reject arbitrary reasons and coercible or unbounded numeric fields',async()=>{
  for(const overlap of [
    {reason:'私密正文 https://private.example',previousLength:50},
    {reason:['raw'],previousLength:50},
    {reason:'short',overlapLength:'347',rawOverlapLength:Infinity,letterCount:-1,
      distinctLetters:2.5,duplicateWindows:{private:'正文'},stepPercent:'13.75'},
  ]) {
    const c=await controller({mode:'background',batchCards:[cards[1]],backgroundFailures:[{
      issue:'未确认完整性',diagnostics:{baseline:true,entries:747,overlap}}]});
    const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
    const stored=c.storageWrites.find(value=>value.lastBackgroundReadDiagnostic).lastBackgroundReadDiagnostic;
    if(overlap.reason==='short'){
      for(const field of ['overlapLength','rawOverlapLength','letterCount','distinctLetters','duplicateWindows','stepPercent'])
        assert.equal(stored.overlap[field],0);
    }else assert.equal(stored.overlap,undefined);
    assert.doesNotMatch(JSON.stringify(stored),/私密|private|https|Infinity|347|13.75/);
    c.click('#stop');await task;
  }
});

test('a later review without drawing statistics clears the preceding diagnostic',async()=>{
  const c=await controller({mode:'background',batchCards:[cards[1]],backgroundFailures:[
    {issue:'画布文字重叠，无法确认正文顺序',issueCode:'unsupported',diagnostics:{baseline:true,entries:91,
      reasonCounts:[{reason:'画布文字重叠，无法确认正文顺序',count:4}],operations:{fillText:95}}},
    {issue:'尚未确认连续原文',issueCode:'incomplete'},
  ]});
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  assert.match(c.element('#read-diagnostic-text').textContent,/91 个/);
  c.element('#read-diagnostic').open=true;
  c.click('#review-retry');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.equal(c.element('#read-diagnostic').hidden,true);
  assert.equal(c.element('#read-diagnostic').open,false);
  assert.equal(c.element('#read-diagnostic-text').textContent,'');
  c.click('#stop');await task;
});

test('legacy foreground reviews clear any stale background diagnostic and keep it hidden',async()=>{
  const c=await controller({folded:true});
  c.element('#read-diagnostic').hidden=false;c.element('#read-diagnostic').open=true;
  c.element('#read-diagnostic-text').textContent='旧的读取诊断';
  const task=c.click('#start');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.equal(c.element('#read-diagnostic').hidden,true);
  assert.equal(c.element('#read-diagnostic').open,false);
  assert.equal(c.element('#read-diagnostic-text').textContent,'');
  c.click('#stop');await task;
});

test('collector exposes an initially hidden expandable diagnostic within the review panel',()=>{
  const html=fs.readFileSync(new URL('../extension/collector.html',import.meta.url),'utf8');
  assert.match(html,/<section id="review"[^>]*>[\s\S]*<details id="read-diagnostic"[^>]*hidden>[\s\S]*<summary>查看读取诊断<\/summary>[\s\S]*<pre id="read-diagnostic-text"><\/pre>[\s\S]*<\/details>/);
});

test('successful background reads do not write a failure diagnostic',async()=>{
  const c=await controller({mode:'background'});await c.click('#start');
  assert.ok(!c.storageWrites.some(value=>value.lastBackgroundReadDiagnostic));
});

test('a background share-image failure preserves the resume and never falls back to focused screenshots',async()=>{
  const c=await controller({mode:'background',active:false,failBackgroundShare:true});
  await c.click('#start');
  assert.equal(c.backend.entries.length,1);
  assert.equal(c.backend.entries[0].share,false);
  assert.deepEqual(c.opened,['一号']);
  assert.match(c.element('#status').textContent,/不支持直接读取图片/);
  assert.ok(!c.events.some(event=>event.startsWith('copy:')));
});

test('background stop during a read saves nothing and never opens another candidate',async()=>{
  const c=await controller({mode:'background',active:false,stopAt:'background-read:张**'});
  await c.click('#start');
  assert.deepEqual(c.opened,['一号']);
  assert.equal(c.backend.entries.length,0);
  assert.equal(c.trackerActive(),false);
});

test('foreground mode still requires the original tab and requests copy permissions explicitly',async()=>{
  const c=await controller();await c.click('#start');
  assert.deepEqual(Array.from(c.requestedPermissions[0].permissions),['clipboardRead']);
  const inactive=await controller({active:false});
  assert.match(inactive.element('#status').textContent,/前台复制模式/);
  assert.equal(inactive.opened.length,0);
  const sleeping=await controller({mode:'background',discarded:true});
  assert.match(sleeping.element('#status').textContent,/休眠/);
  assert.equal(sleeping.opened.length,0);
});

test('drawing-hook mode has no visible entry and foreground copy retains required browser permissions',()=>{
  const html=fs.readFileSync(new URL('../extension/collector.html',import.meta.url),'utf8');
  assert.match(html,/<input id="read-mode" type="hidden" value="foreground">/);
  assert.doesNotMatch(html,/<option value="background"/);
  assert.match(html,/请保持 BOSS 标签页选中/);
  const manifest=JSON.parse(fs.readFileSync(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  assert.ok(!manifest.permissions.includes('clipboardRead'));
  // Chromium forbids debugger in optional_permissions. Foreground copy needs
  // this permission to dispatch the select/copy commands.
  assert.ok(manifest.permissions.includes('debugger'));
  assert.ok(!manifest.optional_permissions.includes('debugger'));
});


test('saved platform conditions are freshly loaded and applied before opening any resume',async()=>{
  const conditions={enabled:true,activity:'3日内活跃',exclude_viewed_14d:true};
  const c=await controller({searchConditions:{enabled:false},latestSearchConditions:conditions});
  await c.click('#start');
  assert.equal(c.events.filter(event=>event==='search-apply').length,1);
  assert.ok(c.events.indexOf('search-apply')<c.events.indexOf('open:张**'));
  assert.equal(c.opened.length,2);
});

test('saved platform conditions use the recommendation filter before opening any resume',async()=>{
  const conditions={enabled:true,activity:'3日内活跃'};
  const c=await controller({recommendationPage:true,searchConditions:conditions});
  await c.click('#start');
  assert.equal(c.events.filter(event=>event==='recommend-apply').length,1);
  assert.ok(c.events.indexOf('recommend-apply')<c.events.indexOf('open:张**'));
  assert.equal(c.opened.length,2);
});

test('an existing recommendation filter lets collection continue without resetting it',async()=>{
  const conditions={enabled:true,activity:'3日内活跃'};
  const c=await controller({recommendationPage:true,recommendExisting:true,searchConditions:conditions});
  await c.click('#start');
  assert.equal(c.events.filter(event=>event==='recommend-apply').length,1);
  assert.ok(c.events.indexOf('recommend-apply')<c.events.indexOf('open:张**'));
  assert.equal(c.opened.length,2);
});

test('unconfirmed or ambiguous search conditions prevent candidate reads and saves',async()=>{
  for(const options of [{failSearch:true},{searchScopeCount:0},{searchScopeCount:2}]){
    const c=await controller({searchConditions:{enabled:true,activity:'3日内活跃'},...options});
    await c.click('#start');
    assert.equal(c.opened.length,0);
    assert.ok(!c.posted.includes('/api/extension/screen'));
    assert.match(c.element('#status').textContent,/未确认|搜索或推荐筛选区域/);
  }
});

test('stopping search application prevents collection, while direct evaluation never applies search settings',async()=>{
  const settings={enabled:true,activity:'3日内活跃'};
  const stopped=await controller({searchConditions:settings,stopAt:'search-apply'});
  await stopped.click('#start');
  assert.equal(stopped.opened.length,0);
  const direct=await controller({searchConditions:settings,preopened:true,directEntry:true});
  await direct.click('#evaluate-current');
  assert.ok(!direct.events.includes('search-apply'));
  assert.equal(direct.directResults.length,1);
});

test('stop and window close cancel an in-flight recommendation filter before candidate collection',async()=>{
  for(const cancellation of [{stopAt:'recommend-apply'},{unloadAt:'recommend-apply'}]){
    const c=await controller({recommendationPage:true,searchConditions:{enabled:true,activity:'3日内活跃'},...cancellation});
    await c.click('#start');
    assert.equal(c.events.filter(event=>event==='recommend-stop').length,1);
    assert.equal(c.opened.length,0);
    assert.ok(!c.posted.includes('/api/extension/screen'));
  }
});

test('configured search cannot continue into a different frame or replaced list document',async()=>{
  for(const options of [{searchFrameId:9},{onListScan:({index})=>index===0?{documentId:'new-search-document'}:undefined}]){
    const c=await controller({searchConditions:{enabled:true,activity:'3日内活跃'},...options});
    await c.click('#start');
    assert.equal(c.opened.length,0);
    assert.ok(!c.posted.includes('/api/extension/screen'));
    assert.match(c.element('#status').textContent,/搜索页面不一致/);
  }
});

test('activity menu accepts one verified browser input click then resumes search verification',async()=>{
  const c=await controller({searchConditions:{enabled:true,activity:'3日内活跃'},inputMenuNeeded:true});
  await c.click('#start');
  assert.equal(c.events.filter(event=>event==='search-apply').length,2);
  assert.equal(c.events.filter(event=>event==='input-click').length,1);
  assert.ok(c.events.indexOf('input-click')<c.events.indexOf('open:张**'));
  assert.equal(c.opened.length,2);
});

test('browser input is attempted at most once when activity menu still does not open',async()=>{
  const c=await controller({searchConditions:{enabled:true,activity:'3日内活跃'},inputMenuNeeded:true,inputMenuNoOpen:true});
  await c.click('#start');
  assert.equal(c.events.filter(event=>event==='input-click').length,1);
  assert.equal(c.opened.length,0);
  assert.ok(!c.posted.includes('/api/extension/screen'));
  assert.match(c.element('#status').textContent,/筛选菜单/);
});

test('a menu opened by genuine pointer movement is not closed by an extra click',async()=>{
  const c=await controller({searchConditions:{enabled:true,activity:'3日内活跃'},inputMenuNeeded:true,inputMenuOpensOnMove:true});
  await c.click('#start');
  assert.equal(c.events.filter(event=>event==='input-move-open').length,1);
  assert.equal(c.events.filter(event=>event==='input-click').length,0);
  assert.equal(c.opened.length,2);
});

test('LAN collection uses its downloaded server, scopes settings, and never reads the server clipboard',async()=>{
  const base='http://192.168.10.20:8765';
  const c=await controller({workbenchOrigin:base});
  assert.match(c.element('#status').textContent,/已连接/);
  assert.equal(c.element('#workbench-link').href,base+'/');
  assert.equal(await c.readSequence(),null);
  c.element('#greet-enabled').checked=true;c.change('#greet-enabled');
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(c.storageState['collectionPoliciesV1:'+base]);
  assert.equal(c.storageState.collectionPoliciesV1[1],undefined);
  await c.click('#start');
  assert.equal(c.backend.entries.length,2);
  assert.ok(c.apiUrls.every(url=>url.startsWith(base+'/')));
  assert.ok(!c.apiUrls.some(url=>url.includes('/clipboard-sequence')));
});

test('local collection retains its local clipboard sequence proof',async()=>{
  const c=await controller();
  assert.equal(await c.readSequence(),42);
  assert.ok(c.apiUrls.some(url=>url.endsWith('/clipboard-sequence')));
});

test('missing host permission or extension authorization blocks collection before any writes',async()=>{
  const denied=await controller({workbenchOrigin:'http://10.0.0.8:8765',workbenchAllowed:false});
  assert.equal(denied.element('#start').disabled,true);
  assert.match(denied.element('#status').textContent,/允许访问工作台/);
  assert.equal(denied.apiUrls.length,0);
  const unpaired=await controller({workbenchOrigin:'http://10.0.0.8:8765',paired:false});
  assert.equal(unpaired.element('#start').disabled,true);
  assert.match(unpaired.element('#status').textContent,/授权/);
  assert.equal(unpaired.posted.length,0);
});
