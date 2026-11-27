import {isBoss,uniqueDetail,shareScreenshotRect,verifyShareLayout,detailFailure,withBusyState,resumeSections,resumeFoldLabels,matchesCandidateNameLine,resumeHeaderIdentity,discoverResumeHeaderIdentity} from './capture-utils.mjs';
import {copyOpenResume} from './resume-copy.mjs';
import {loadWorkbenchOrigin,hasWorkbenchPermission,isLoopbackWorkbench,assertWorkbenchPaired} from './workbench-connection.mjs';
import {readBackgroundResume} from './background-read.mjs';
import {renderDirectEvaluation} from './direct-evaluation.mjs';
import {isRulePrecheck} from './evaluation-result.mjs';
import {DEFAULT_COLLECTION_POLICY,normalizeCollectionPolicy,policyUsesQr,policyUsesColleague} from './collection-policy.mjs';
import {readRecommendChatEntry} from './recommend-chat-entry.mjs';
import {recommendGreetingAction} from './recommend-greeting.mjs';
import {resumeFavoriteAction} from './resume-favorite.mjs';
import {createCopyViewportController,saveForegroundReadDiagnostic} from './copy-viewport.mjs';
import {createPaymentMonitor,PAYMENT_STOP_MESSAGE} from './payment-stop.mjs';

const $=selector=>document.querySelector(selector);
let base='';
const tabId=Number(new URLSearchParams(location.search).get('tab'));
const directEntry=new URLSearchParams(location.search).get('mode')==='current';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const say=(text,state='running')=>{
  const status=$('#status');
  status.textContent=text;
  if(status.dataset)status.dataset.state=state;
};
const canvasTrackerId='hrm-resume-expander';
let token='',ready=false,running=false,stopped=false,reviewAction=null,wakeWait=null;
let readMode='foreground',directRunning=false;
let copyViewport=null;
let activeWork=null;
let configuredJobs=[],applyingSearch=false;
let chatEntryAvailable=false;
let greetingAvailable=false;
const greetingFrames=new Map();
const greetingResetFrames=new Set();
const favoriteReceiptFrames=new Set(),favoriteReceipts=new Map();
let collectionPolicies={};
let policyWrite=Promise.resolve();
let policyStorageKey='collectionPoliciesV1',selectedJobKey='selectedJob';
const policyFields=['save-above','share-colleague','share-above','colleague-name','greet-enabled'];
const selectedReadMode=()=>{
  const control=$('#read-mode');
  return control?.type==='hidden'?'foreground':control?.value==='background'?'background':'foreground';
};

function setBusy(busy){
  const inputHelp=$('#input-help');
  if(inputHelp)inputHelp.hidden=!busy;
  $('#start').disabled=busy||!ready;
  $('#backfill-chat').disabled=busy||!ready||!chatEntryAvailable;
  $('#evaluate-current').disabled=busy||!ready;
  $('#stop').disabled=!busy;
  for(const id of ['job','limit','share','read-mode',...policyFields])$('#'+id).disabled=busy;
  $('#share-above').disabled=busy||!($('#share-colleague').checked||$('#greet-enabled').checked);
  $('#colleague-name').disabled=busy||!$('#share-colleague').checked;
}

function readCollectionPolicy(){
  const score=id=>{
    const value=String($('#'+id).value).trim();
    if(!value)throw Error('请填写保存分数线和转发 / 打招呼共用分数线。');
    return Number(value);
  };
  return normalizeCollectionPolicy({save_above:score('save-above'),share_above:score('share-above'),
    share_mode:$('#share').checked?($('#share-colleague').checked?'both':'qr'):($('#share-colleague').checked?'colleague':'none'),
    colleague_name:$('#colleague-name').value,greet_enabled:$('#greet-enabled').checked});
}

function showCollectionPolicy(){
  try{
    const policy=readCollectionPolicy();
    $('#collection-policy-help').textContent=`评分高于 ${policy.save_above} 分时保存并收藏；评估失败时保留原文和诊断。`+
      (policyUsesColleague(policy)?`已保存且收藏确认后，评分高于 ${policy.share_above} 分时转发给「${policy.colleague_name}」。`:'本次不进行站内转发。')+
      (policyUsesQr(policy)?'已保存的候选人同时保存回访二维码。':'')+
      (policy.greet_enabled?`仅推荐列表：AI 成功且评分同时高于 ${policy.save_above} 和 ${policy.share_above} 分，收藏及分享完成后使用 BOSS 默认招呼语。已沟通过不重复发送；结果不明时暂停。`:'本次不自动打招呼。')+
      '设置按岗位保存在本机；已保存记录沿用原转发规则，打招呼按本次启用状态与共用分数线判断。';
    return policy;
  }catch(error){$('#collection-policy-help').textContent=error.message;return null;}
}

function applyCollectionPolicy(){
  let policy;
  try{policy=normalizeCollectionPolicy(collectionPolicies[String($('#job').value)]);}
  catch{policy={...DEFAULT_COLLECTION_POLICY,share_mode:'none'};}
  $('#save-above').value=String(policy.save_above);$('#share-above').value=String(policy.share_above);
  $('#share').checked=policyUsesQr(policy);$('#share-colleague').checked=policyUsesColleague(policy);
  $('#greet-enabled').checked=policy.greet_enabled;
  $('#colleague-name').value=policy.colleague_name;
  showCollectionPolicy();setBusy(running);
}

function rememberCollectionPolicy(){
  const policy=showCollectionPolicy();setBusy(running);
  const job=Number($('#job').value);
  if(!policy||!Number.isSafeInteger(job)||job<=0)return;
  collectionPolicies[String(job)]=policy;
  policyWrite=policyWrite.catch(()=>{}).then(()=>chrome.storage.local.set({[policyStorageKey]:{...collectionPolicies}}));
  policyWrite.catch(()=>say('采集设置未能保存，请检查扩展存储后重试。','error'));
}

async function call(path,data){
  const session=activeWork;
  assertWork(session);
  if(session&&data&&!stopped&&!['/api/extension/clipboard-sequence','/api/extension/clipboard-preview'].includes(path))
    await checkPaymentNow();
  assertWork(session);
  const options=data?{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':token},body:JSON.stringify(data)}:{};
  // A submitted request may finish on the server. Interrupt only this wait;
  // never retry, roll it back, or let a late response resume this run.
  const {response,result}=await interruptible((async()=>{
    const response=await fetch(base+path,options);
    return {response,result:await response.json()};
  })(),session);
  if(!response.ok){
    const error=Error(result.error||'工作台请求失败');
    error.code=result.code;
    throw error;
  }
  return result;
}

async function readLocalClipboardSequence(){
  // A LAN server's clipboard belongs to another computer. The copy reader
  // already verifies fresh clipboard content when a local sequence is unavailable.
  return isLoopbackWorkbench(base) ? (await call('/api/extension/clipboard-sequence',{})).sequence : null;
}

function assertWork(session=activeWork){
  if(session?.error)throw session.error;
  if(session&&activeWork!==session)throw Error('本轮采集已结束。');
}
function check(){assertWork();if(stopped)throw Error('已停止。');}
async function interruptible(promise,session=activeWork){
  const result=await (session?Promise.race([promise,session.signal]):promise);
  assertWork(session);return result;
}
async function checkPaymentNow(){
  check();await activeWork?.monitor?.checkNow();check();
}
function createWorkSession(){
  let reject;
  const session={error:null,monitor:null,signal:new Promise((_,fail)=>{reject=fail;})};
  session.signal.catch(()=>{});
  session.interrupt=error=>{
    if(activeWork!==session||session.error)return;
    session.error=error;stopped=true;reject(error);
    reviewAction?.('stop');wakeWait?.();
    say(error.message,'error');
    // These commands only cancel local automation; they never close a dialog.
    exec('stop').catch(()=>{});stopApplyingConditions();stopGreetings();
  };
  return session;
}
const browserReadLimit=12000;
async function boundedRead(stage,work,deadline=Date.now()+browserReadLimit){
  const expires=Math.min(deadline,Date.now()+browserReadLimit),remaining=expires-Date.now();
  const failure=()=>Object.assign(Error(`${stage}等待超时，已停止；请确认 BOSS 页面恢复后重新开始。`),{code:'browser-read-timeout'});
  if(remaining<=0)throw failure();
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(function browserReadTimedOut(){reject(failure());},remaining);});
  try{
    const result=await interruptible(Promise.race([work(),timeout]));
    if(Date.now()>=expires)throw failure();
    check();return result;
  }finally{clearTimeout(timer);}
}
async function waitForCandidates(){
  check();
  await new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);if(wakeWait===finish)wakeWait=null;resolve();};
    const timer=setTimeout(finish,3000);
    wakeWait=finish;
  });
  check();
}
async function guardTab(deadline){
  check();
  const tab=await boundedRead('读取 BOSS 标签页',()=>chrome.tabs.get(tabId),deadline);
  if(!isBoss(tab.url))throw Error('BOSS 标签页已关闭或离开 BOSS。');
  if(tab.discarded)throw Error('BOSS 标签页已被浏览器休眠，请手动恢复页面后重试。');
  if(readMode==='foreground'&&!tab.active)throw Error('前台复制模式要求 BOSS 标签页保持选中。');
  return tab;
}

async function stopCanvasTracker(){
  const filter={ids:[canvasTrackerId]};
  if((await chrome.scripting.getRegisteredContentScripts(filter)).length){
    await chrome.scripting.unregisterContentScripts(filter);
  }
  await chrome.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',
    func:()=>{
      if(window===window.top)delete window.__hrmCanvasTextEnabled;
      if(location.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(location.hostname)&&
          /^\/web\/frame\/c-resume\/?$/.test(location.pathname)){
        window.__hrmCanvasRender?.stop();
        window.__hrmCanvasText?.stop();
      }
    }}).catch(()=>{});
}

async function trackCanvasDuring(work){
  await stopCanvasTracker();
  const withText=readMode==='background';
  const scripts=withText?['canvas-render.js','canvas-expand.js','canvas-geometry.js','canvas-glyphs.js','canvas-platform-assets.js','canvas-text.js']:['canvas-expand.js'];
  let readTimedOut=false;
  try{
    if(withText)await chrome.scripting.executeScript({target:{tabId},world:'MAIN',
      func:()=>{window.__hrmCanvasTextEnabled=true;}});
    await chrome.scripting.registerContentScripts([{id:canvasTrackerId,js:scripts,world:'MAIN',
      matches:['https://www.zhipin.com/web/frame/c-resume*','https://zhipin.com/web/frame/c-resume*'],
      allFrames:true,runAt:'document_start',persistAcrossSessions:false}]);
    await chrome.scripting.executeScript({target:{tabId,allFrames:true},world:'MAIN',files:scripts});
    return await work();
  }catch(error){
    readTimedOut=error.code==='browser-read-timeout'||Boolean(activeWork?.error);
    throw error;
  }finally{
    // A timed-out frame can still be executing its read. Do not queue cleanup
    // behind it: that late cleanup could remove a later run's tracker. The next
    // explicit start performs the ordinary cleanup before installing hooks.
    if(!readTimedOut)await stopCanvasTracker();
  }
}

async function exec(action,args={},frame,deadline){
  if(action!=='stop')assertWork();
  if(!['stop','closeShare'].includes(action))check();
  if(!stopped&&['open','close','close-current','closeShare','dismiss-promotions','dismiss-image-preview',
      'read','expand-canvas','click-canvas-expand','prepare-copy','select-copy','favorite',
      'prepare-colleague','send-colleague','share','advance-list'].includes(action))await checkPaymentNow();
  const scope=frame?(frame.documentId?{documentIds:[frame.documentId]}:{frameIds:[frame.frameId]}):{allFrames:true};
  const request=()=>chrome.scripting.executeScript({target:{tabId,...scope},func:async(action,args)=>{
    if(!window.__hrmAuto)return null;
    try{return {ok:true,value:await window.__hrmAuto.run(action,args)};}
    catch(error){return {ok:false,error:error.message,
      ...(typeof error.favoriteAttempted==='boolean'?{favoriteAttempted:error.favoriteAttempted}:{})};}
  },args:[action,args]});
  const readStages={'scan':'检查页面','current-detail':'核对简历绑定','probe-image-preview':'检查图片预览'};
  const results=readStages[action]?await boundedRead(readStages[action],request,deadline):await request();
  if(action!=='stop')assertWork();
  const rows=results.filter(row=>row.result).map(row=>({...row,...row.result}));
  const failure=rows.find(row=>!row.ok);
  if(failure)throw Object.assign(Error(failure.error),
    typeof failure.favoriteAttempted==='boolean'?{favoriteAttempted:failure.favoriteAttempted}:{});
  if(frame&&!rows.length)throw Error('当前简历的页面框架已关闭或切换。');
  return rows;
}

async function scan(expectedName='',deadline=Date.now()+browserReadLimit){
  await guardTab(deadline);
  await boundedRead('加载页面读取组件',()=>chrome.scripting.executeScript({target:{tabId,allFrames:true},files:['dom-reader.js','automation.js']}),deadline);
  return exec('scan',{expectedName},undefined,deadline);
}

function showSearchConditions(){
  const node=$('#platform-query-help');
  if(!node)return;
  const configured=configuredJobs.find(job=>String(job.id)===String($('#job').value))?.search_conditions;
  node.textContent=configured?.enabled
    ?'已启用岗位查询条件：开始采集时先应用到当前 BOSS 搜索或推荐页并核对。可在工作台「岗位与筛选条件」中编辑。'
    :'平台查询条件未启用，采集时保留页面设置。可在工作台「岗位与筛选条件」中配置。';
  node.hidden=directEntry;
}

async function searchCommand(action,args={},frame){
  if(action!=='stop')check();
  if(action==='apply')await checkPaymentNow();
  const scope=frame?(frame.documentId?{documentIds:[frame.documentId]}:{frameIds:[frame.frameId]}):{allFrames:true};
  const results=await chrome.scripting.executeScript({target:{tabId,...scope},
    func:async(action,args)=>{
      if(!window.__hrmSearch)return null;
      try{return {ok:true,value:await window.__hrmSearch.run(action.slice(7),args)};}
      catch(error){return {ok:false,error:error.message,
        ...(typeof error.menuInputNeeded==='string'?{menuInputNeeded:error.menuInputNeeded}:{})};}
    },args:['search:'+action,args]});
  if(action!=='stop')check();
  const rows=results.filter(row=>row.result).map(row=>({...row,...row.result}));
  const failure=rows.find(row=>!row.ok);
  if(failure)throw Object.assign(Error(failure.error),
    failure.menuInputNeeded?{menuInputNeeded:failure.menuInputNeeded}:{});
  if(frame&&rows.length!==1)throw Error('筛选条件所在的页面已变化，未开始采集。');
  return rows;
}

async function recommendationCommand(action,args={},frame){
  if(action!=='stop')check();
  if(action==='apply')await checkPaymentNow();
  const scope=frame?(frame.documentId?{documentIds:[frame.documentId]}:{frameIds:[frame.frameId]}):{allFrames:true};
  const results=await chrome.scripting.executeScript({target:{tabId,...scope},
    func:async(action,args)=>{
      if(!window.__hrmRecommendSearch)return null;
      try{return {ok:true,value:await window.__hrmRecommendSearch.run(action,args)};}
      catch(error){return {ok:false,error:error.message};}
    },args:[action,args]});
  if(action!=='stop')check();
  const rows=results.filter(row=>row.result).map(row=>({...row,...row.result}));
  const failure=rows.find(row=>!row.ok);
  if(failure)throw Error(failure.error);
  if(frame&&rows.length!==1)throw Error('推荐页筛选条件所在的页面已变化，未开始采集。');
  return rows;
}

async function clickSearchEntry(point,key,frame){
  await guardTab();
  if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw Error('下拉菜单入口位置无效');
  const target={tabId};
  try{await chrome.debugger.attach(target,'1.3');}
  catch{throw Error('无法使用浏览器输入打开筛选菜单，请关闭其他调试连接后重试。');}
  try{
    await guardTab();
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseMoved',...point,buttons:0});
    const afterMove=(await searchCommand('entry-point',{key},frame))[0]?.value;
    if(afterMove?.opened)return;
    if(!afterMove?.point||Math.abs(afterMove.point.x-point.x)>2||Math.abs(afterMove.point.y-point.y)>2)
      throw Error('筛选菜单入口位置已变化，未继续点击。');
    await checkPaymentNow();
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
    await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
  }finally{await chrome.debugger.detach(target).catch(()=>{});}
}

async function applyJobSearchConditions(jobId){
  // Fetch again on every start: the settings may have been edited while this
  // collector window was open. Single-resume evaluation does not use them.
  const state=await call('/api/state');check();
  configuredJobs=state.jobs||[];showSearchConditions();
  const job=configuredJobs.find(row=>row.id===jobId);
  if(!job)throw Error('匹配岗位已不存在，请重新打开采集窗口。');
  if(!job.search_conditions?.enabled)return;
  if(state.platform_search_version!==1)throw Error('工作台尚不支持平台查询条件，请更新工作台后重试。');
  await guardTab();
  await chrome.scripting.executeScript({target:{tabId,allFrames:true},files:['search-conditions.js','recommend-conditions.js']});
  await searchCommand('reset');
  await recommendationCommand('reset');
  const searchMatches=(await searchCommand('inspect')).filter(row=>row.value?.supported);
  const recommendMatches=(await recommendationCommand('inspect')).filter(row=>row.value?.supported);
  if(searchMatches.length+recommendMatches.length!==1)
    throw Error('未找到唯一的 BOSS 搜索或推荐筛选区域。请关闭详情或弹窗后重试，尚未开始采集。');
  const recommendation=recommendMatches.length===1;
  const matches=recommendation?recommendMatches:searchMatches;
  applyingSearch=true;
  try{
    say('正在应用岗位的平台查询条件…');
    const inputTried=new Set();
    let result;
    while(true){
      try{result=(await (recommendation?recommendationCommand:searchCommand)('apply',job.search_conditions,matches[0]))[0]?.value;break;}
      catch(error){
        if(recommendation)throw error;
        const key=error.menuInputNeeded;
        if(!['activity','job_hopping'].includes(key)||inputTried.has(key))throw error;
        inputTried.add(key);
        await guardTab();
        const entry=(await searchCommand('entry-point',{key},matches[0]))[0]?.value;
        if(!entry?.opened){
          if(entry?.frameKey!==matches[0].value.frameKey)throw Error('筛选菜单所在页面已变化');
          await clickSearchEntry(entry.point,key,matches[0]);
        }
        check();
      }
    }
    check();await guardTab();
    if(result?.applied!==true)throw Error('平台查询条件尚未确认，未开始采集。');
    say(result.skipped?'检测到页面已有筛选，沿用当前筛选并读取候选人列表…':
      '平台查询条件已应用并核对，正在读取候选人列表…');
    await delay(300);check();
    return matches[0];
  }finally{applyingSearch=false;}
}

async function scanList(){
  let frames=await scan();
  if(frames.some(row=>row.value.detail||row.value.canvasDialog))return frames;
  const promotions=frames.filter(row=>row.value.promotionBlocked);
  if(promotions.length>1)throw Error('检测到多个热搜推荐弹层，无法确认要关闭的窗口。');
  if(promotions.length===1){
    say('正在跳过热搜牛人推荐，返回候选人列表…');
    const result=(await exec('dismiss-promotions',{},promotions[0]))[0]?.value;
    if(result?.dismissed!==1)throw Error('热搜推荐弹层未关闭，请关闭后重新开始。');
    await delay(250);check();
    frames=await scan();
    if(frames.some(row=>row.value.promotionBlocked))throw Error('热搜推荐弹层仍未关闭，请关闭后重新开始。');
  }
  return frames;
}

async function settleListSnapshot(frames,expected,deferred=new Map()){
  const observedDuplicates=new Map();
  for(let attempt=0;attempt<=3;attempt++){
    check();
    if(frames.some(row=>row.value.detail||row.value.canvasDialog))throw Error('列表中仍有未关闭的简历详情。');
    if(frames.filter(row=>row.value.cards.length).length>1)throw Error('未找到唯一的候选人小卡片列表。');
    const current=frames.find(row=>row.frameId===expected.frameId&&row.documentId===expected.documentId);
    if(!current)throw Error('候选人列表所在的页面框架已关闭或切换。');
    const signatures=new Set(),duplicates=new Set();
    for(const card of current.value.cards){
      if(signatures.has(card.signature))duplicates.add(card.signature);
      signatures.add(card.signature);
    }
    for(const signature of duplicates){
      const group=current.value.cards.filter(card=>card.signature===signature);
      observedDuplicates.set(signature,{name:group[0].name,count:group.length});
    }
    // Recheck transient copies briefly. Persistent ambiguity belongs to this
    // group, not every other candidate in the list; never pick a copy by index.
    if(!duplicates.size||attempt===3||[...duplicates].every(signature=>deferred.has(signature)))
      return {frames,list:current,duplicates,observedDuplicates};
    say('候选人列表正在更新，正在重新核对重复卡片…');
    await delay(250);check();frames=await scanList();
  }
}

function canvasDetail(frames){
  const owners=frames.filter(row=>row.value.canvasDialog),bodies=frames.filter(row=>row.value.canvasBody);
  if(owners.length>1||bodies.length>1)throw Error('检测到多个在线简历，无法安全复制。');
  if(owners.length===1&&bodies.length===1&&bodies[0].documentId)return {kind:'canvas',owner:owners[0],body:bodies[0]};
  return null;
}

async function waitDetail(name){
  let frames=[];
  const deadline=Date.now()+15000;
  say(`${name}：正在等待在线简历就绪…`);
  for(let attempt=0;attempt<20;attempt++){
    frames=await scan(name,deadline);
    if(frames.some(row=>row.value.promotionBlocked))throw Error('打开的是热搜推荐弹层，未读取或评估其中的卡片。请返回候选人列表后重试。');
    const text=uniqueDetail(frames),canvas=canvasDetail(frames);
    if(canvas&&text)throw Error('检测到多个在线简历，无法安全复制。');
    if(canvas)return canvas;
    if(text){
      if(text.value.detail!==name)throw Error('详情姓名与列表候选人不一致。');
      return {kind:'text',owner:text,body:text};
    }
    const remaining=deadline-Date.now();
    if(remaining<=0)throw Object.assign(Error('等待在线简历超时，已停止；未打开下一位候选人。'),{code:'browser-read-timeout'});
    await delay(Math.min(400,remaining));
  }
  throw Error(detailFailure(frames));
}

async function verifyDetail(target,name){
  if(directRunning){await verifyOpenTarget(target,name);return;}
  const frames=await scan(name);
  if(frames.some(row=>row.value.promotionBlocked))throw Error('当前简历被热搜推荐弹层遮挡，未继续处理。');
  const current=target.kind==='canvas'?canvasDetail(frames):uniqueDetail(frames,name);
  if(target.kind==='canvas'){
    if(!current||current.body.documentId!==target.body.documentId||current.owner.documentId!==target.owner.documentId)throw Error('当前简历已关闭或切换。');
  }else if(!current||current.documentId!==target.body.documentId){
    throw Error('当前简历已关闭或切换。');
  }
}

function clearReadDiagnostic(){
  const details=$('#read-diagnostic');
  details.hidden=true;details.open=false;
  $('#read-diagnostic-text').textContent='';
}

function describeReadDiagnostic(diagnostic){
  const types={baseline:'未确认初次完整绘制',rendering:'画布文字仍未绘制完成',unsupported:'当前绘制方式无法完整确认',incomplete:'完整性尚未确认'};
  const operations={fillText:'文字填充',strokeText:'文字描边',clearRect:'区域清除',fillRect:'矩形填充',drawImage:'图片绘制',
    putImageData:'像素写入',reset:'画布重置',save:'保存绘制状态',restore:'恢复绘制状态',clip:'裁剪',
    beginPath:'开始路径',closePath:'闭合路径',moveTo:'移动路径起点',lineTo:'绘制线段',rect:'矩形路径',
    arc:'圆弧路径',arcTo:'切线圆弧',ellipse:'椭圆路径',bezierCurveTo:'三次曲线',quadraticCurveTo:'二次曲线',
    roundRect:'圆角矩形',fill:'路径填充',stroke:'路径描边',strokeRect:'矩形描边',width:'画布宽度设置',height:'画布高度设置'};
  const lines=[`检查结果：${types[diagnostic.issueCode]||types.incomplete}`,
    `完整绘制起点：${diagnostic.baseline?'已确认':'未确认'}`,
    `已记录文字片段：${diagnostic.entries} 个`,
    `异常记录达到上限：${diagnostic.overflow?'是':'否'}`];
  if(diagnosticReadFailures.has(diagnostic.failureReason))lines.push(`失败原因：${diagnosticReadFailures.get(diagnostic.failureReason)}`);
  if(diagnostic.ignoredImages)lines.push(`已忽略独立图片 ${diagnostic.ignoredImages}`);
  if(diagnostic.scheduler) {
    const s=diagnostic.scheduler;
    lines.push(`页面可见性：${s.hidden?'后台隐藏':'可见或被其他窗口遮挡'}`,
      `待绘制回调：${s.pending}；原生执行：${s.nativeFrames}；后台补调：${s.pumpedFrames}`);
    if(s.untrackedFrames)lines.push(`超出补调记录上限：${s.untrackedFrames}`);
  }
  if(diagnostic.motion) {
    const m=diagnostic.motion,number=value=>Number.isFinite(value)?String(Number(value.toFixed(3))):'未记录';
    lines.push('',`滚动推进：${diagnosticMotionModes.get(m.mode)}；动作 ${diagnosticMotionActions.get(m.action)}`,
      `请求步长 ${number(m.requestedPixels)}；原生实际移动 ${number(m.nativePixels)}；画布滚轮 ${number(m.wheelPixels)}`,
      `滚动位置 ${number(m.beforeTop)} → ${number(m.observedTop)}；可读高度 ${number(m.clientHeight)}；总滚动高度 ${number(m.scrollHeight)}`,
      `滚动区域 ${number(m.ownerCount)} 个；位置通知 ${number(m.notifications)} 次；画布定位 ${number(m.pointerNotifications)} 次；画布滚轮 ${m.virtualScroll?'已发送':'未发送'}`);
  }
  if(diagnostic.horizontal) {
    const h=diagnostic.horizontal,number=value=>Number.isFinite(value)?String(Number(value.toFixed(3))):'未记录';
    const complete=typeof h.complete==='boolean'?(h.complete?'是':'否'):'未记录';
    lines.push('',`横向完整性检查：${diagnosticHorizontalReasons.get(h.reason)}`,
      `画布像素宽 ${number(h.canvasWidth)}；可见横向 ${number(h.visibleLeft)} ～ ${number(h.visibleRight)}；裁切 左 ${number(h.clippedLeft)}，右 ${number(h.clippedRight)}`,
      `页面显示宽 ${number(h.canvasCssWidth)} CSS 像素；可见宽 ${number(h.visibleCssWidth)}；裁切 左 ${number(h.clippedCssLeft)}，右 ${number(h.clippedCssRight)}`,
      `已记录正文边界：左 ${number(h.textLeft)}，右 ${number(h.textRight)}；横向完整 ${complete}`,
      `可见范围外：文字 ${number(h.outsideTextRuns)} 段；未知图片 ${number(h.outsideImages)} 张；绘制问题 ${number(h.outsideIssues)} 处`);
  }
  if(diagnostic.overlap) {
    const o=diagnostic.overlap;
    lines.push('',`分屏衔接检查：${diagnosticOverlapReasons.get(o.reason)||'未确认'}`,
      `前屏 ${o.previousLength} 字符；当前屏 ${o.currentLength} 字符；重叠 ${o.overlapLength} 字符；原文精确重叠 ${o.rawOverlapLength} 字符`,
      `重叠有效字符 ${o.letterCount}；不同字符 ${o.distinctLetters}；重复短句窗口 ${o.duplicateWindows}；最长独立区段 ${o.independentRunLength}`,
      `完整重叠匹配：前屏 ${o.previousMatches}，当前屏 ${o.currentMatches}，累计正文 ${o.assembledMatches}（2 表示多处）`,
      `已补读 ${o.retries} 次；当前滚动步长 ${o.stepPercent}%`);
  }
  if(diagnostic.reasonCounts.length){
    lines.push('','绘制限制：');
    for(const item of diagnostic.reasonCounts)lines.push(`${item.reason}：${item.count} 次`);
  }
  const counts=Object.entries(diagnostic.operations).filter(([,count])=>count>0);
  if(counts.length){
    lines.push('','绘制操作统计：');
    for(const [key,count] of counts)lines.push(`${operations[key]}（${key}）：${count} 次`);
  }
  if(diagnostic.details.length){
    const number=value=>Number.isFinite(value)?String(Number(value.toFixed(3))):'未记录';
    const boolean=value=>typeof value==='boolean'?(value?'是':'否'):'未记录';
    lines.push('','几何样本（坐标和宽度单位：像素）：');
    for(const detail of diagnostic.details){
      if(detail.kind==='text-overlap'){
        lines.push(`文字重叠：排版交叠 ${number(detail.advanceOverlap)}；字形交叠 ${number(detail.inkOverlapX)} × ${number(detail.inkOverlapY)}；基线差 ${number(detail.baselineDelta)}`,
          `前段排版/字形宽 ${number(detail.previousWidth)} / ${number(detail.previousInkWidth)}；后段排版/字形宽 ${number(detail.currentWidth)} / ${number(detail.currentInkWidth)}`,
          `前后字符数 ${number(detail.previousLength)} / ${number(detail.currentLength)}；横纵缩放 ${number(detail.scaleX)} / ${number(detail.scaleY)}`);
      }else if(detail.kind==='text-coordinate'){
        lines.push(`文字坐标检查：${diagnosticCoordinateReasons.get(detail.reason)||'未确认'}；字符数 ${number(detail.textLength)}；描边 ${boolean(detail.stroke)}`,
          `输入位置 ${number(detail.x)} / ${number(detail.y)}；坐标有限 ${boolean(detail.xFinite)} / ${boolean(detail.yFinite)}；测量宽度 ${number(detail.measuredWidth)}`,
          `字形度量 左 ${number(detail.metricLeft)}，右 ${number(detail.metricRight)}，上 ${number(detail.metricAscent)}，下 ${number(detail.metricDescent)}`,
          `变换 a ${number(detail.matrixA)}，b ${number(detail.matrixB)}，c ${number(detail.matrixC)}，d ${number(detail.matrixD)}，e ${number(detail.matrixE)}，f ${number(detail.matrixF)}`);
      }else if(detail.kind==='text-boundary'){
        const handling=detail.deferred===true?'延后整行':detail.deferred===false?'拒绝读取':'未记录';
        lines.push(`文字边界：左 ${number(detail.left)}，上 ${number(detail.top)}，右 ${number(detail.right)}，下 ${number(detail.bottom)}；基线 ${number(detail.baseline)}；字符数 ${number(detail.textLength)}`,
          `画布尺寸 ${number(detail.canvasWidth)} × ${number(detail.canvasHeight)}；越界 上 ${number(detail.overflowTop)}，下 ${number(detail.overflowBottom)}，左 ${number(detail.overflowLeft)}，右 ${number(detail.overflowRight)}；处理 ${handling}`);
      }else if(detail.kind==='text-cover'){
        lines.push(`文字覆盖：${diagnosticCoverOperations.get(detail.operation)||'未记录操作'}；${diagnosticCoverChecks.get(detail.verification)||'字形像素尚未确认'}`,
          `文字框：左 ${number(detail.left)}，上 ${number(detail.top)}，右 ${number(detail.right)}，下 ${number(detail.bottom)}；字符数 ${number(detail.textLength)}`,
          `绘制框：左 ${number(detail.coverLeft)}，上 ${number(detail.coverTop)}，右 ${number(detail.coverRight)}，下 ${number(detail.coverBottom)}`,
          `包含文字整框 ${boolean(detail.contained)}；裁剪包含整框 ${boolean(detail.clipContained)}；裁剪数 ${number(detail.clipCount)}`,
          `触及字形像素 ${number(detail.coveredPixels)}；其中核心像素 ${number(detail.coveredCorePixels)}`);
        if(['advanceLeft','advanceRight','baseline'].some(key=>Object.hasOwn(detail,key)))
          lines.push(`文字排版：左 ${number(detail.advanceLeft)}，右 ${number(detail.advanceRight)}；基线 ${number(detail.baseline)}`);
        if(['maxCoveredAlpha','rightEdgeOnly','edgeCoreAdjacent','highlightCandidate'].some(key=>Object.hasOwn(detail,key)))
          lines.push(`字形总像素 ${number(detail.pixels)}；总核心像素 ${number(detail.corePixels)}；触及像素最大不透明度（0～255）${number(detail.maxCoveredAlpha)}`,
            `仅最右像素列 ${boolean(detail.rightEdgeOnly)}；邻接未覆盖核心 ${boolean(detail.edgeCoreAdjacent)}；相邻高亮待确认 ${boolean(detail.highlightCandidate)}`);
        if(['coveredLeft','coveredTop','coveredRight','coveredBottom'].some(key=>Object.hasOwn(detail,key)))
          lines.push(`触及像素范围：左 ${number(detail.coveredLeft)}，上 ${number(detail.coveredTop)}，右 ${number(detail.coveredRight)}，下 ${number(detail.coveredBottom)}`);
        if(['priorHighlightCell','highlightContinuity'].some(key=>Object.hasOwn(detail,key)))
          lines.push(`前字高亮格已确认 ${boolean(detail.priorHighlightCell)}；高亮绘制连续 ${boolean(detail.highlightContinuity)}`);
      }else if(detail.kind==='image'){
        lines.push(`图片：左 ${number(detail.left)}，上 ${number(detail.top)}，右 ${number(detail.right)}，下 ${number(detail.bottom)}`,
          `源图尺寸 ${number(detail.sourceWidth)} × ${number(detail.sourceHeight)}；裁剪数 ${number(detail.clipCount)}；圆形裁剪 ${boolean(detail.roundClip)}；画布来源 ${boolean(detail.sourceCanvas)}；完整源图 ${boolean(detail.fullSource)}`);
      }else if(detail.kind==='notice-check'){
        lines.push(`提示条检查：${diagnosticNoticeReasons.get(detail.reason)||'未确认'}`,
          `页首身份 ${boolean(detail.headerVerified)}；资料行 ${boolean(detail.metadataVerified)}；容器数 ${number(detail.panelCount)}；精确文案容器数 ${number(detail.panelExactCount)}`,
          `容器内文字 ${number(detail.panelEntryCount)} 段 / ${number(detail.panelTextLength)} 字符；全行文案匹配 ${boolean(detail.globalRowExact)}；容器文案匹配 ${boolean(detail.panelTextExact)}`,
          `同一行容器外片段 ${number(detail.sameRowOutsideEntries)}；跨容器片段 ${number(detail.partialTextCount)}；容器内绘制问题 ${number(detail.unsafeIssueCount)}（文字重叠 ${number(detail.overlapIssuesInPanel)}）`,
          `图框 ${number(detail.imageW)} × ${number(detail.imageH)}；容器 ${number(detail.panelW)} × ${number(detail.panelH)}；文字水平间隔 ${number(detail.signedGapX)}；垂直中心差 ${number(detail.centerDeltaY)}`,
          `触字片段 ${number(detail.touchCount)}；最大交叠 ${number(detail.maxTextOverlapX)} × ${number(detail.maxTextOverlapY)}；填充容器 ${boolean(detail.panelFromFill)}；裁剪容器 ${boolean(detail.panelFromClip)}`);
      }else if(detail.kind==='header-history'){
        lines.push(`前屏页首装饰：${detail.historyVerified===true?'已确认':'未确认'}；沿用图片 ${number(detail.imageCount)} 张`);
      }else if(detail.kind==='education-check'){
        if(['accepted-text','accepted-text-history'].includes(detail.reason)){
          lines.push(`教育信息：${diagnosticEducationReasons.get(detail.reason)}`,
            `教育区段 ${boolean(detail.sectionVerified)}；院校条目 ${boolean(detail.titleVerified)}；起止日期 ${boolean(detail.dateVerified)}`);
        }else lines.push(`院校徽标检查：${diagnosticEducationReasons.get(detail.reason)||'未确认'}`,
          `教育区段 ${boolean(detail.sectionVerified)}；院校条目 ${boolean(detail.titleVerified)}；起止日期 ${boolean(detail.dateVerified)}；候选图标数 ${number(detail.candidateCount)}`,
          ...(detail.historyRecorded?[`前屏教育证明：缓存来源一致 ${boolean(detail.historySourceStable)}；院校条目一致 ${boolean(detail.historyTitleMatched)}；标题已滚出顶部 ${boolean(detail.historyHeadingAbove)}；本屏沿用 ${boolean(detail.sectionFromHistory)}；边界校徽沿用 ${boolean(detail.boundaryFromHistory)}`]:[]),
          `图框 ${number(detail.imageW)} × ${number(detail.imageH)}；文字水平间隔 ${number(detail.signedGapX)}；触字片段 ${number(detail.touchCount)}`,
          ...(Number.isFinite(detail.rowTopOffset)?[`标题相对图框顶部：上沿 ${number(detail.rowTopOffset)}，下沿 ${number(detail.rowBottomOffset)}；中心差 ${number(detail.rowCenterDeltaY)}`]:[]),
          `完整源图 ${boolean(detail.fullSource)}；有效源范围 ${boolean(detail.validSource)}；画布来源 ${boolean(detail.sourceCanvas)}`,
          `原绘制框 ${number(detail.paintW)} × ${number(detail.paintH)}；原框完整 ${boolean(detail.paintBoundsComplete)}；缓存复制完整 ${boolean(detail.cacheComplete)}`,
          `裁剪：矩形 ${number(detail.rectClips)}，圆角矩形 ${number(detail.roundRectClips)}，椭圆 ${number(detail.ellipseClips)}；完整包含 ${boolean(detail.clipContained)}；同框装饰裁剪 ${boolean(detail.frameClipConfirmed)}`,
          `矩形绘制完整 ${boolean(detail.fullPaint)}；装饰轮廓完整 ${boolean(detail.decorationPaint)}；未被覆盖 ${boolean(detail.paintIntact)}；不透明绘制 ${boolean(detail.paintOpaque)}；正向绘制 ${boolean(detail.paintForward)}`);
      }else if(detail.kind==='glyph-check'){
        lines.push(`字形复核：${diagnosticGlyphReasons.get(detail.reason)||'未确认'}；校验有效 ${boolean(detail.ok)}；像素分离 ${boolean(detail.separate)}`,
          `共享像素 ${number(detail.sharedPixels)}；前后字形像素 ${number(detail.firstPixels)} / ${number(detail.secondPixels)}`,
          `仅边缘相交 ${boolean(detail.edgeOnly)}；共享核心像素 ${number(detail.sharedCorePixels)}；前后核心像素 ${number(detail.firstCorePixels)} / ${number(detail.secondCorePixels)}；共享 alpha 上限 ${number(detail.maxSharedMinAlpha)}`);
      }else{
        lines.push(`${detail.kind==='clip-path'?'裁剪路径':'绘制路径'}：命令数 ${number(detail.commandCount)}；裁剪数 ${number(detail.clipCount)}`);
        if(detail.commands?.length)lines.push(`路径顺序：${detail.commands.map(command=>`${operations[command]}（${command}）`).join(' → ')}`);
      }
    }
  }
  return lines.join('\n');
}

async function reviewCurrent(message,copy,diagnostic=null){
  check();
  clearReadDiagnostic();
  if(diagnostic){
    $('#read-diagnostic-text').textContent=describeReadDiagnostic(diagnostic);
    $('#read-diagnostic').hidden=false;
  }
  say(message,'review');
  const preview=$('#review-preview');
  preview.srcdoc=copy.preview_document||'';
  preview.hidden=!copy.preview_document;
  $('#review').hidden=false;
  await new Promise(resolve=>{reviewAction=resolve;});
  reviewAction=null;
  $('#review').hidden=true;
  preview.srcdoc='';
  clearReadDiagnostic();
  check();
}

function nameCheck(resume,name){
  const normalize=text=>text.replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*');
  const expected=normalize(name);
  const header=resume.split('\n').slice(0,8).map(normalize);
  const masked=header.map(line=>line.match(/^([\p{L}·]{1,20}\*{1,4})/u)?.[1]).find(Boolean);
  if(masked&&masked!==expected)throw Error('复制到的姓名与列表候选人不一致，已停止。');
  return resume.split('\n').slice(0,8).some(line=>matchesCandidateNameLine(line,name));
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
  if(clipboard.selection!=='single-copy'||clipboard.copyCount!==1)return false;
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
  const complete=proof?.topVerified===true&&proof.bottomVerified===true&&proof.allScreensRead===true&&
    Number.isInteger(clipboard.screens)&&clipboard.screens>=1;
  return Boolean(complete&&proof.stableBottomReads===1);
}

async function expandCanvasDomOnce(target,name){
  const frames=target.owner.documentId===target.body.documentId?[target.owner]:[target.owner,target.body];
  let selected=null;
  for(const frame of frames){
    const rows=await exec('prepare-canvas-expand',{},frame);
    if(rows.length!==1||rows[0].frameId!==frame.frameId||rows[0].documentId!==frame.documentId)
      throw Error('展开控件所在的简历框架已变化，请重新读取。');
    const prepared=rows[0].value;
    if(!Number.isSafeInteger(prepared?.count)||prepared.count<0)
      throw Error('当前简历的展开控件信息无效，请重新读取。');
    if(prepared.count!==1){
      if(prepared.token||prepared.label)throw Error('当前简历的展开凭据不一致，未继续读取。');
      if(prepared.count>1)return {clicked:false,ambiguous:true};
      continue;
    }
    if(typeof prepared.token!=='string'||!prepared.token||typeof prepared.label!=='string'||!prepared.label)
      throw Error('未绑定唯一的简历展开控件，请手动展开后重试。');
    if(selected)return {clicked:false,ambiguous:true};
    selected={frame,prepared};
  }
  if(!selected)return {clicked:false,ambiguous:false};
  const {frame,prepared}=selected;
  await verifyDetail(target,name);
  const clicked=await exec('click-canvas-expand',{token:prepared.token},frame);
  if(clicked.length!==1||clicked[0].frameId!==frame.frameId||clicked[0].documentId!==frame.documentId)
    throw Error('未确认本次简历展开操作，请检查页面后重试。');
  const result=clicked[0].value;
  if(result?.clicked===false&&result.reason==='controls_changed'){
    await verifyDetail(target,name);
    return {clicked:false,ambiguous:true};
  }
  if(result?.clicked!==true)throw Error('未确认本次简历展开操作，请检查页面后重试。');
  await delay(650);check();await verifyDetail(target,name);
  return {clicked:true,ambiguous:false};
}

function previewUncertainty(value,field){
  if(value&&typeof value[field]==='boolean'){
    if(value.uncertain===undefined&&value.reason===undefined)return false;
    if(value[field]===false&&value.uncertain===true&&['budget','scope'].includes(value.reason))return true;
  }
  throw Error('未确认图片预览检查结果，已停止读取。');
}

async function copyPreviewRecovery(target,name){
  const tabUrl=(await guardTab()).url;
  const identity=row=>JSON.stringify({frameId:row.frameId,documentId:row.documentId,
    kind:row.value.kind,token:row.value.token,name:row.value.name||'',
    frameKey:row.value.frameKey,ownerUrl:row.value.binding?.ownerUrl||'',bodyUrl:row.value.binding?.bodyUrl||''});
  let bound=null,dismissed=false,uncertain=false;
  const sameFrame=(before,after)=>before.frameId===after.frameId&&before.documentId===after.documentId&&
    (!before.value.token||identity(before)===identity(after));
  const guard=async()=>{
    if((await guardTab()).url!==tabUrl)throw Error('BOSS 页面已切换，未继续读取。');
  };
  const bind=async()=>{
    bound=await currentOpenDetail(await exec('current-detail'));
    if(bound.kind!==target.kind||!sameFrame(target.owner,bound.owner)||!sameFrame(target.body,bound.body)||
        bound.kind==='text'&&bound.name!==name)
      throw Error('当前简历已切换，未尝试关闭图片预览。');
  };
  const verify=async()=>{
    await guard();
    const fresh=await currentOpenDetail(await exec('current-detail'));
    if(fresh.kind!==bound.kind||identity(fresh.owner)!==identity(bound.owner)||identity(fresh.body)!==identity(bound.body))
      throw Error('图片预览所在的简历已关闭或切换，未继续读取。');
    check();
  };
  const recoverFocus=async()=>{
    await guard();
    if(dismissed)return false;
    uncertain=false;
    const frames=target.owner.documentId===target.body.documentId?[target.owner]:[target.owner,target.body];
    for(const frame of frames){
      const probe=await exec('probe-image-preview',{},frame);
      if(probe.length!==1||probe[0].frameId!==frame.frameId||probe[0].documentId!==frame.documentId)
        throw Error('未确认图片预览检查结果，已停止读取。');
      const unknown=previewUncertainty(probe[0].value,'present');
      await guard();
      if(unknown){
        uncertain=true;
        if(probe[0].value.reason==='scope'){if(bound)await verify();else await bind();}
        continue;
      }
      if(!probe[0].value.present)continue;
      if(!bound)await bind();
      await verify();
      const current=bound.owner.documentId===frame.documentId?bound.owner:bound.body;
      const rows=await exec('dismiss-image-preview',current.value,current);
      if(rows.length!==1||rows[0].frameId!==frame.frameId||rows[0].documentId!==frame.documentId||
          typeof rows[0].value?.dismissed!=='boolean')
        throw Error('未确认图片预览的关闭结果，已停止读取。');
      const unconfirmed=previewUncertainty(rows[0].value,'dismissed');
      await verify();
      if(unconfirmed){uncertain=true;continue;}
      if(!rows[0].value.dismissed)continue;
      dismissed=true;
      say(`${name||'当前候选人'}：已关闭图片预览，正在确认原简历恢复…`);
      for(let attempt=0;attempt<2;attempt++){await delay(150);await verify();}
      return true;
    }
    return false;
  };
  return {recoverFocus,isUncertain:()=>uncertain};
}

async function collectCopiedResume(target,name,source){
  const frame=target.body;
  const action=(command,args={})=>exec(command,{name,...args},frame).then(rows=>rows[0].value);
  for(;;){
    await checkPaymentNow();
    const label=name||'当前候选人';
    say(`${label}：正在检查简历正文和图片预览…`);
    const recovery=await copyPreviewRecovery(target,name),recoverFocus=recovery.recoverFocus;
    const recoverCopyFocus=async()=>{
      const recovered=await recoverFocus();
      if(!recovery.isUncertain())return recovered;
      if(target.kind==='text')throw Error('网页简历的预览检查未完成，尚未复制正文；请确认页面没有遮挡后重试。');
      return {skipExpansion:true};
    };
    await recoverFocus();
    await verifyDetail(target,name);
    let prepared,textSelection,expandAlreadyDone=false,skipExpansion=false;
    say(`${label}：正在检查正文展开状态…`);
    if(target.kind==='text'){
      if(recovery.isUncertain())throw Error('网页简历的预览检查未完成，尚未复制正文；请确认页面没有遮挡后重试。');
      prepared=await action('prepare-copy');
      textSelection={select:()=>action('select-copy'),focused:()=>action('copy-focused'),clear:()=>action('clear-copy')};
    }else if(recovery.isUncertain())skipExpansion=true;
    else{
      const expansion=await expandCanvasDomOnce(target,name);
      expandAlreadyDone=expansion.clicked;skipExpansion=expansion.ambiguous;
    }
    // Read-only Canvas preparation cannot create a preview. Recheck only after
    // DOM preparation or an actual expansion; focus failure still probes live.
    if(target.kind==='text'||expandAlreadyDone)await recoverFocus();
    if(target.kind==='text'&&recovery.isUncertain())throw Error('网页简历的预览检查未完成，尚未复制正文；请确认页面没有遮挡后重试。');
    if(recovery.isUncertain())skipExpansion=true;
    await prepareSnapshotFavorite(target,name,source?.card);
    say(`正在复制 ${label} 的简历…`);

    let clipboard;
    try{
      await checkPaymentNow();
      clipboard=await copyOpenResume({browser:chrome,clipboard:navigator.clipboard,tab:await guardTab(),
        clipboardSequence:readLocalClipboardSequence,
        documentId:frame.documentId,name,textSelection,singlePass:true,expandAlreadyDone,skipExpansion,recoverFocus:recoverCopyFocus,
        fitViewport:copyViewport?.fitViewport,
        report:message=>say(`${label}：${message}`),pause:delay,check});
    }catch(error){
      await saveForegroundReadDiagnostic(chrome,error?.diagnostics);
      if(!/剪贴板没有收到|未确认剪贴板获得|无法读取剪贴板|展开.*重试/.test(error.message))throw error;
      const hint=/无法读取剪贴板|展开.*重试/.test(error.message)?error.message:
        '剪贴板没有收到可用正文。若 BOSS 仍显示「查看全部」，请先点击展开，再重试当前候选人。';
      await reviewCurrent(`${label}：${hint}`,{resume:'等待重新复制正文'});
      continue;
    }
    check();
    if(clipboard.issue){
      await saveForegroundReadDiagnostic(chrome,clipboard.diagnostics);
      if(!directRunning&&clipboard.issueCode==='ambiguous-overlap'){
        const error=Error(clipboard.issue);
        error.code='skip-ambiguous-overlap';
        throw error;
      }
      await reviewCurrent(`${label}：${clipboard.issue}`,
        {resume:clipboard.resume||'等待重新复制正文'});
      continue;
    }
    if(target.kind==='canvas'&&verifiedCopy(target,null,clipboard,{resume:clipboard.resume||''}))
      await sealSnapshotFavorite(target,name,clipboard.resume||'');
    const copy=await call('/api/extension/clipboard-preview',{resume:clipboard.resume,resume_html:clipboard.resume_html});
    await verifyDetail(target,name);
    let discovered;
    if(!name&&target.kind==='canvas'){
      discovered=discoverResumeHeaderIdentity(rawCopiedText(clipboard,copy));
      const reported=clipboard.discoveredIdentity;
      if(!discovered||reported&&(reported.name!==discovered.name||reported.identity!==discovered.identity))
        throw Error('未从本次复制的简历页首确认一致的姓名、年龄、学历和工作年限，请检查原文后重试。');
      if(resumeHeaderIdentity(copy.resume,discovered.name)!==discovered.identity)
        throw Error('本次复制的页首与完整简历身份不一致，请重新读取。');
    }
    const candidateName=name||discovered?.name;
    const matches=nameCheck(copy.resume,candidateName);
    const sections=resumeSections(copy.resume);
    const folded=resumeFoldLabels(copy.resume).length||resumeFoldLabels(clipboard.resume).length;
    if(clipboard.foldIssue||folded){
      const detail=clipboard.foldIssue||'正文仍有折叠字样，未确认展开。';
      await reviewCurrent(`${candidateName}：${detail} 请检查页面展开状态后重新读取。`,copy);
      continue;
    }
    const hasResumeSection=sections.length>0;
    if(!matches||!hasResumeSection||!verifiedCopy(target,prepared,clipboard,copy)){
      const reason=!matches?'复制结果未包含当前候选人姓名':
        !hasResumeSection?'未读到履历章节':'本次复制尚未确认完整正文';
      await reviewCurrent(`${candidateName}：自动校验未通过，${reason}。请检查页面后重新读取。`,copy);
      continue;
    }
    if(discovered){target.name=discovered.name;target.identity=discovered.identity;}
    say(`${candidateName}：本次复制校验通过，正在${directRunning?'准备评估':'保存履历'}…`);
    return {resume:copy.resume,resume_html:copy.resume_html,name:candidateName,link:'',capture:{status:'visible_complete',sections,warnings:[]}};
  }
}

// Diagnostic storage contains drawing statistics only, never resume text,
// candidate identifiers, page URLs, cookies or arbitrary page-provided strings.
const diagnosticReasons=new Set([
  '画布含过多无法确认的绘制内容','画布使用了不能确认的裁剪区域','画布使用了不能确认的混合绘制',
  '画布使用了不能确认的绘制滤镜','画布文字仅通过阴影绘制，无法确认正文','画布文字使用了不能直接还原的字形编码',
  '画布文字方向无法确认','画布文字超出读取上限','画布文字经过压缩绘制，无法确认位置',
  '画布文字的坐标或变换无法确认','画布边界截断了文字','画布裁剪区域截断了文字','画布文字与分隔线重叠，无法确认正文',
  '画布文字重叠，无法确认正文顺序','画布清除区域无法确认','画布文字被局部覆盖',
  '画布文字被不能确认的背景覆盖','画布图片区域无法确认','画布图片阴影范围无法确认','画布含无法确认是否属于正文的图片，不能完整读取原文',
  '画布含无法直接读取的路径绘制','画布描边范围无法确认','画布分隔线超出读取上限',
  '画布绘制记录异常','画布使用了像素图片正文，无法直接读取原文','画布含无法确认的矩形描边绘制',
  '画布使用了不能确认的图案填充',
  '缓存画布裁剪截断了文字，不能完整读取原文','来源画布未从完整重绘开始记录，无法确认缓存原文',
  '来源画布记录超出上限，无法确认缓存原文','画布缓存绘制覆盖已有内容，无法确认原文','画布图片记录超出上限',
]);
const diagnosticOperations=new Set(['fillText','strokeText','clearRect','fillRect','drawImage','putImageData',
  'reset','save','restore','clip','beginPath','closePath','moveTo','lineTo','rect','arc','arcTo','ellipse','bezierCurveTo',
  'quadraticCurveTo','roundRect','fill','stroke','strokeRect','width','height']);
const diagnosticDetailFields=new Map([
  ['text-overlap',['advanceOverlap','inkOverlapX','inkOverlapY','baselineDelta','previousWidth','currentWidth',
    'previousInkWidth','currentInkWidth','previousLength','currentLength','scaleX','scaleY']],
  ['text-coordinate',['textLength','x','y','measuredWidth','metricLeft','metricRight','metricAscent','metricDescent',
    'matrixA','matrixB','matrixC','matrixD','matrixE','matrixF']],
  ['text-boundary',['left','top','right','bottom','canvasWidth','canvasHeight','overflowLeft','overflowTop',
    'overflowRight','overflowBottom','baseline','textLength']],
  ['text-cover',['left','top','right','bottom','coverLeft','coverTop','coverRight','coverBottom',
    'textLength','clipCount','coveredPixels','coveredCorePixels','advanceLeft','advanceRight','baseline',
    'pixels','corePixels','maxCoveredAlpha','coveredLeft','coveredTop','coveredRight','coveredBottom']],
  ['clip-path',['commandCount','clipCount']],['path',['commandCount','clipCount']],
  ['image',['left','top','right','bottom','sourceWidth','sourceHeight','clipCount']],
  ['header-history',['imageCount']],
  ['notice-check',['panelCount','panelExactCount','panelEntryCount','panelTextLength','sameRowOutsideEntries',
    'partialTextCount','unsafeIssueCount','overlapIssuesInPanel','imageW','imageH','panelW','panelH','signedGapX',
    'centerDeltaY','maxTextOverlapX','maxTextOverlapY','touchCount']],
  ['glyph-check',['sharedPixels','firstPixels','secondPixels','sharedCorePixels','firstCorePixels','secondCorePixels','maxSharedMinAlpha']],
  ['education-check',['imageW','imageH','signedGapX','touchCount','candidateCount','paintW','paintH',
    'rectClips','roundRectClips','ellipseClips','rowTopOffset','rowBottomOffset','rowCenterDeltaY']],
]);
const diagnosticCoverOperations=new Map([['clearRect','区域清除'],['fillRect','矩形填充'],['fill-path','路径填充']]);
const diagnosticCoordinateReasons=new Map([
  ['alignment','对齐方式未确认'],['width','文字测量宽度无效'],
  ['transform','变换矩阵未确认'],['ink-metrics','字形度量无效'],['ink-bounds','字形边界无效'],
  ['advance','文字排版边界无效'],['baseline','文字基线无效'],
]);
const diagnosticCoverChecks=new Map([['ink-hit','绘制范围触及字形像素'],['ink-clear','绘制范围未触及字形像素'],['unavailable','字形像素复核不可用']]);
const diagnosticNoticeReasons=new Map([
  ['header-unverified','页首身份或资料行未确认'],['panel-missing','未找到有效提示容器'],
  ['panel-ambiguous','提示容器不唯一'],['text-mismatch','容器内文案未完整匹配'],
  ['text-unsafe','容器内文字或绘制尚未确认'],['image-source','图片源范围未确认'],
  ['image-outside','图片不在已确认提示容器内'],['image-text-overlap','图片范围与文字相交'],
  ['image-side','图片未位于提示文字左侧邻近位置'],['image-size','图片尺寸不符合提示图标'],
  ['image-alignment','图片与提示文字未对齐'],['image-ambiguous','提示图标不唯一'],['accepted','已确认提示装饰'],
]);
const diagnosticGlyphReasons=new Map([
  ['separate','已确认字形像素分离'],['pixel-overlap','字形像素确实相交'],['edge-only','仅抗锯齿边缘相交'],['stopped','记录已停止'],
  ['unavailable','字形复核不可用'],['invalid-input','输入范围无法确认'],['unsupported-context','绘制上下文不支持复核'],
  ['unsupported-style','绘制样式不支持复核'],['unsupported-layout','文字布局不支持复核'],
  ['metrics-mismatch','字体重放测量不一致'],['tile-limit','字形范围超过复核上限'],['cache-limit','字形缓存已达上限'],
  ['readback-failed','字形像素读取失败'],['empty-mask','未取得字形像素'],['mask-clipped','字形像素被裁切'],
  ['font-pending','字体仍未就绪'],
]);
const diagnosticEducationReasons=new Map([
  ['accepted-text','院校文字已确认，已忽略校徽'],
  ['accepted-text-history','教育文字上下文已确认，已忽略校徽'],
  ['accepted-boundary-history','已确认同次读取中的边界校徽'],
  ['accepted-history','已确认同次读取中的院校装饰'],
  ['accepted','已确认院校装饰'],['section-unverified','教育区段未确认'],['title-unverified','院校条目或起止日期未确认'],
  ['title-alignment','院校标题与日期的纵向位置不符合徽标布局'],
  ['image-source','图片源范围未确认'],['image-size','图片尺寸不符合院校徽标'],['image-alignment','图片与院校条目未对齐'],
  ['image-text-overlap','图片范围与文字相交'],['image-ambiguous','院校徽标不唯一'],['text-unsafe','院校条目文字或绘制尚未确认'],
  ['image-canvas','图片来源为未确认画布'],['image-modified','图片已被局部擦除或覆盖'],
  ['image-opacity','图片不是不透明绘制'],['image-direction','图片绘制方向未确认'],
  ['image-bounds','图片绘制边界不完整'],['image-cache-crop','缓存复制裁切了图片'],['image-clip','图片裁剪轮廓未确认'],
]);
const diagnosticPathCommands=new Set(['beginPath','closePath','moveTo','lineTo','rect','arc','arcTo','ellipse',
  'bezierCurveTo','quadraticCurveTo','roundRect']);
function sanitizeDiagnosticDetails(raw){
  const details=[],counts=new Map(),integerFields=new Set(['previousLength','currentLength','textLength','commandCount','clipCount',
    'panelCount','panelExactCount','panelEntryCount','panelTextLength','sameRowOutsideEntries','partialTextCount',
    'unsafeIssueCount','overlapIssuesInPanel','touchCount','candidateCount','rectClips','roundRectClips','ellipseClips','sharedPixels','firstPixels','secondPixels',
    'sharedCorePixels','firstCorePixels','secondCorePixels','maxSharedMinAlpha','imageCount','coveredPixels','coveredCorePixels',
    'pixels','corePixels','maxCoveredAlpha']);
  const coordinates=new Set(['left','top','right','bottom','coverLeft','coverTop','coverRight','coverBottom',
    'signedGapX','baseline','rowTopOffset','rowBottomOffset','rowCenterDeltaY','advanceLeft','advanceRight',
    'coveredLeft','coveredTop','coveredRight','coveredBottom','x','y','metricLeft','metricRight','metricAscent',
    'metricDescent','matrixA','matrixB','matrixC','matrixD','matrixE','matrixF']);
  for(const item of (Array.isArray(raw)?raw:[]).slice(0,128)){
    if(!item||typeof item!=='object'||Array.isArray(item)||!diagnosticDetailFields.has(item.kind)||
      (counts.get(item.kind)||0)>=3)continue;
    const detail={kind:item.kind};
    for(const key of diagnosticDetailFields.get(item.kind)){
      const value=item[key];
      if(!Number.isFinite(value)||Math.abs(value)>1000000000||(!coordinates.has(key)&&value<0)||
        (integerFields.has(key)&&!Number.isSafeInteger(value))||(['maxSharedMinAlpha','maxCoveredAlpha'].includes(key)&&value>255))continue;
      detail[key]=value;
    }
    if(item.kind==='image')for(const key of ['roundClip','sourceCanvas','fullSource']){
      if(typeof item[key]==='boolean')detail[key]=item[key];
    }
    if(item.kind==='text-coordinate'){
      if(diagnosticCoordinateReasons.has(item.reason))detail.reason=item.reason;
      for(const key of ['stroke','xFinite','yFinite'])if(typeof item[key]==='boolean')detail[key]=item[key];
    }
    if(item.kind==='text-boundary'&&typeof item.deferred==='boolean')detail.deferred=item.deferred;
    if(item.kind==='text-cover'){
      if(diagnosticCoverOperations.has(item.operation))detail.operation=item.operation;
      if(diagnosticCoverChecks.has(item.verification))detail.verification=item.verification;
      for(const key of ['contained','clipContained','rightEdgeOnly','edgeCoreAdjacent','highlightCandidate',
        'priorHighlightCell','highlightContinuity'])
        if(typeof item[key]==='boolean')detail[key]=item[key];
    }
    if(item.kind==='header-history'&&typeof item.historyVerified==='boolean')detail.historyVerified=item.historyVerified;
    if(item.kind==='notice-check'){
      if(diagnosticNoticeReasons.has(item.reason))detail.reason=item.reason;
      for(const key of ['headerVerified','metadataVerified','fullSource','validSource','panelFromFill','panelFromClip','globalRowExact','panelTextExact'])
        if(typeof item[key]==='boolean')detail[key]=item[key];
    }
    if(item.kind==='glyph-check'){
      if(diagnosticGlyphReasons.has(item.reason))detail.reason=item.reason;
      for(const key of ['ok','separate','edgeOnly'])if(typeof item[key]==='boolean')detail[key]=item[key];
    }
    if(item.kind==='education-check'){
      if(diagnosticEducationReasons.has(item.reason))detail.reason=item.reason;
      for(const key of ['sectionVerified','titleVerified','dateVerified','fullSource','validSource',
        'historyRecorded','sectionFromHistory','historySourceStable','historyTitleMatched','historyHeadingAbove','boundaryFromHistory',
        'fullPaint','decorationPaint','paintBoundsComplete','clipContained','frameClipConfirmed',
        'paintOpaque','paintForward','paintIntact','cacheComplete','sourceCanvas'])
        if(typeof item[key]==='boolean')detail[key]=item[key];
    }
    if(['path','clip-path'].includes(item.kind)&&Array.isArray(item.commands))
      detail.commands=item.commands.slice(0,24).filter(command=>diagnosticPathCommands.has(command));
    if(Object.keys(detail).length===1)continue;
    details.push(detail);counts.set(item.kind,(counts.get(item.kind)||0)+1);
    if(details.length===24)break;
  }
  return details;
}
const diagnosticReadFailures=new Map([
  ['continuity-overlap','相邻分屏的原文衔接未确认'],
  ['canvas-range','画布读取范围无效'],
  ['width-clipped','简历画布横向未完整显示，请调整窗口或缩放后重试'],
  ['readable-region','未确认完整的简历可读取区域'],
  ['unstable','简历内容或滚动位置持续变化，尚未确认稳定原文'],
  ['scroll-stale','滚动后原文未更新，尚未确认后续内容'],
  ['restore-changed','回到上一屏后原文或位置已变化，无法继续确认分屏连续性'],
  ['fold-unlocated','仍有折叠内容，但未能唯一定位展开控件'],
  ['expand-limit','展开次数超过上限，尚未确认简历完整性'],
  ['expand-unchanged','已点击展开控件，但页面未确认展开，请手动展开后重试'],
  ['boundary-top','简历顶部仍有截断文字，未确认完整开头'],
  ['boundary-bottom','简历末尾仍有截断文字，滚动后未补齐'],
]);
const diagnosticOverlapReasons=new Map([
  ['short','相邻屏幕重叠的有效文字不足'],['repetitive','重叠文字为重复模板或可区分字符不足'],
  ['independent','重复说明之外没有足够长且唯一的正文区段'],['ambiguous','完整重叠文字在正文中出现多次'],
  ['footer','平台末尾缺少连续的起点证据'],['raw','对比后的文字一致，但原文没有足够的精确重叠'],
]);
const diagnosticOverlapCounts=['overlapLength','rawOverlapLength','letterCount','distinctLetters','duplicateWindows',
  'independentRunLength','previousMatches','currentMatches','assembledMatches','previousLength','currentLength','retries'];
const diagnosticHorizontalReasons=new Map([
  ['full-width','画布横向完整显示'],['empty-margins','仅空白边距被裁，正文已完整显示'],
  ['text-outside','正文超出横向可见范围'],['image-outside','未知图片超出横向可见范围'],
  ['drawing-outside','横向隐藏区域存在未确认的绘制'],['unconfirmed','横向完整性证据尚未确认'],
]);
const diagnosticMotionModes=new Map([['native','页面滚动'],['wheel','画布滚动'],['mixed','页面与画布滚动']]);
const diagnosticMotionActions=new Map([['top','返回顶部'],['next','读取下一屏'],['restore','恢复已确认位置']]);
const diagnosticMotionCoordinates=['requestedPixels','nativePixels','wheelPixels','beforeTop','observedTop','clientHeight','scrollHeight'];
const diagnosticHorizontalCoordinates=['canvasWidth','visibleLeft','visibleRight','clippedLeft','clippedRight',
  'textLeft','textRight','canvasCssWidth','visibleCssWidth','clippedCssLeft','clippedCssRight'];
const diagnosticHorizontalCounts=['outsideTextRuns','outsideImages','outsideIssues'];
async function recordBackgroundFailure(raw){
  const hasDiagnostic=raw?.diagnostics&&typeof raw.diagnostics==='object'&&!Array.isArray(raw.diagnostics);
  const source=raw?.diagnostics||{},count=value=>Number.isSafeInteger(value)&&value>=0?Math.min(value,1000000000):0;
  const reasonCounts=(Array.isArray(source.reasonCounts)?source.reasonCounts:[]).slice(0,32).map(item=>({
    reason:diagnosticReasons.has(item?.reason)?item.reason:'其他绘制限制',count:count(item?.count)}));
  const operations={};
  for(const [key,value] of Object.entries(source.operations&&typeof source.operations==='object'?source.operations:{}))
    if(diagnosticOperations.has(key))operations[key]=count(value);
  const diagnostic={version:1,issueCode:['baseline','rendering','unsupported'].includes(raw?.issueCode)?raw.issueCode:'incomplete',
    ...(diagnosticReadFailures.has(raw?.failureReason)?{failureReason:raw.failureReason}:{}),
    reasonCounts,operations,entries:count(source.entries),baseline:source.baseline===true,overflow:source.overflow===true,
    ignoredImages:count(source.ignoredImages),details:sanitizeDiagnosticDetails(source.details)};
  if(source.scheduler&&typeof source.scheduler==='object'&&!Array.isArray(source.scheduler)) {
    const s=source.scheduler;
    diagnostic.scheduler={pending:count(s.pending),nativeFrames:count(s.nativeFrames),
      pumpedFrames:count(s.pumpedFrames),untrackedFrames:count(s.untrackedFrames),hidden:s.hidden===true};
  }
  if(source.motion&&typeof source.motion==='object'&&!Array.isArray(source.motion)&&
      diagnosticMotionModes.has(source.motion.mode)&&diagnosticMotionActions.has(source.motion.action)){
    const m=source.motion,motion={mode:m.mode,action:m.action,hidden:m.hidden===true,virtualScroll:m.virtualScroll===true};
    for(const key of diagnosticMotionCoordinates){
      const value=m[key],minimum=['requestedPixels','nativePixels','wheelPixels'].includes(key)?-10000000:0;
      if(typeof value==='number'&&Number.isFinite(value)&&value>=minimum&&value<=10000000)motion[key]=value;
    }
    for(const key of ['ownerCount','notifications','pointerNotifications']){
      if(Number.isSafeInteger(m[key])&&m[key]>=0&&m[key]<=1000)motion[key]=m[key];
    }
    diagnostic.motion=motion;
  }
  if(source.horizontal&&typeof source.horizontal==='object'&&!Array.isArray(source.horizontal)&&diagnosticHorizontalReasons.has(source.horizontal.reason)) {
    const h=source.horizontal,horizontal={reason:h.reason};
    if(typeof h.complete==='boolean')horizontal.complete=h.complete;
    for(const key of diagnosticHorizontalCoordinates){
      const value=h[key],minimum=['textLeft','textRight'].includes(key)?-10000000:0;
      if(typeof value==='number'&&Number.isFinite(value)&&value>=minimum&&value<=10000000)horizontal[key]=value;
    }
    for(const key of diagnosticHorizontalCounts){
      const value=h[key];
      if(Number.isSafeInteger(value)&&value>=0&&value<=10000000)horizontal[key]=value;
    }
    diagnostic.horizontal=horizontal;
  }
  if(source.overlap&&typeof source.overlap==='object'&&!Array.isArray(source.overlap)&&diagnosticOverlapReasons.has(source.overlap.reason)) {
    const o=source.overlap;
    diagnostic.overlap={reason:o.reason,...Object.fromEntries(diagnosticOverlapCounts.map(key=>[key,count(o[key])])),
      stepPercent:typeof o.stepPercent==='number'&&Number.isFinite(o.stepPercent)&&o.stepPercent>=0&&o.stepPercent<=100?o.stepPercent:0};
  }
  await chrome.storage.local.set({lastBackgroundReadDiagnostic:diagnostic}).catch(()=>{});
  return hasDiagnostic?diagnostic:null;
}

async function reopenCurrentCard(target,name,source){
  if(!source?.card?.signature||!source.list?.documentId)throw Error('没有原候选人的唯一卡片记录，无法重新打开。');
  await verifyDetail(target,name);
  await exec('close',{name,kind:target.kind},target.owner);
  await delay(350);check();
  const frames=await scanList();
  if(frames.some(row=>row.value.detail||row.value.canvasDialog))throw Error('当前详情尚未关闭，未重新打开候选人。');
  const list=frames.find(row=>row.documentId===source.list.documentId&&row.frameId===source.list.frameId);
  const matches=list?.value.cards.filter(card=>card.signature===source.card.signature&&card.name===source.card.name)||[];
  if(matches.length!==1)throw Error('原候选人卡片已变化或不唯一，未重新打开其他候选人。');
  if(source.card.kind==='recommendation'&&(matches[0].kind!==source.card.kind||matches[0].platform_geek_id!==source.card.platform_geek_id))
    throw Error('原推荐候选人的身份已变化，未重新打开其他候选人。');
  await exec('open',matches[0],list);
  const fresh=await waitDetail(name);
  // The outer run retains this object for QR capture and final close.
  Object.assign(target,fresh);
  await verifyDetail(target,name);
}

async function collectResume(target,name,source){
  if(readMode==='foreground')return collectCopiedResume(target,name,source);
  let mayReopen=true;
  for(;;){
    await verifyDetail(target,name);
    await prepareSnapshotFavorite(target,name,source?.card);
    say(`${name}：正在后台读取原文，可继续使用其他窗口…`);
    let raw;
    if(target.kind==='text'){
      raw=(await exec('read',{name},target.body))[0].value;
    }else{
      await exec('expand-canvas',{name},target.owner);
      raw=await readBackgroundResume({browser:chrome,tab:await guardTab(),documentId:target.body.documentId,
        name,identity:target.identity,pause:delay,check,report:message=>say(`${name}：${message}`)});
    }
    check();
    await verifyDetail(target,name);
    const warnings=raw.capture?.warnings||[];
    const proof=raw.completeness;
    const complete=target.kind==='text'?raw.capture?.status==='visible_complete'&&!warnings.length:
      Boolean(proof?.topVerified&&proof.bottomVerified&&proof.allScreensRead&&proof.stableBottomReads>=2&&
        Number.isInteger(raw.screens)&&raw.screens>=1&&(!target.identity||raw.identityVerified===true));
    const issue=raw.issue||warnings.join('；')||(!complete?'尚未确认简历从开头到末尾的完整性':'');
    if(issue){
      const diagnostic=await recordBackgroundFailure(raw);
      if(target.kind==='canvas'&&raw.issueCode==='baseline'&&mayReopen&&source?.card?.signature){
        mayReopen=false;
        say(`${name}：原文记录未覆盖初次绘制，正在重新打开同一候选人一次…`);
        await reopenCurrentCard(target,name,source);
        continue;
      }
      await reviewCurrent(`${name}：${issue} 请在 BOSS 检查当前简历后重试；不会自动切换为前台复制。`,{},diagnostic);
      mayReopen=true;
      continue;
    }
    if(!raw.resume||!nameCheck(raw.resume,name)||!resumeSections(raw.resume).length||resumeFoldLabels(raw.resume).length){
      const diagnostic=await recordBackgroundFailure(raw);
      await reviewCurrent(`${name}：原文身份、章节或展开状态校验未通过，请检查当前简历后重试。`,{},diagnostic);
      mayReopen=true;
      continue;
    }
    if(target.kind==='canvas')await sealSnapshotFavorite(target,name,raw.resume);
    // This endpoint only formats supplied text; background mode never reads the clipboard.
    const formatted=await call('/api/extension/clipboard-preview',{resume:raw.resume,resume_html:raw.resume_html||''});
    check();
    await verifyDetail(target,name);
    const sections=resumeSections(formatted.resume);
    if(!nameCheck(formatted.resume,name)||!sections.length||resumeFoldLabels(formatted.resume).length){
      const diagnostic=await recordBackgroundFailure(raw);
      await reviewCurrent(`${name}：正文排版后的身份或章节校验未通过，请重试。`,formatted,diagnostic);
      mayReopen=true;
      continue;
    }
    say(`${name}：后台原文校验通过，正在${directRunning?'准备评估':'保存履历'}…`);
    return {resume:formatted.resume,resume_html:formatted.resume_html,name,link:'',
      capture:{status:'visible_complete',sections,warnings:[],
        ...(raw.platformNotes?.length?{platform_notes:raw.platformNotes}:{})}};
  }
}

async function shareImage(frame,share){
  if(readMode==='background'){
    const result=(await exec('share-image',{},frame))[0].value;
    if(typeof result?.image!=='string'||!result.image.startsWith('data:image/png;base64,')||result.image.length>2800000){
      throw Error('未取得可保存的分享卡图片，请停止后取消二维码选项或使用前台模式补充。');
    }
    return result.image;
  }
  await guardTab();
  const before=(await exec('share-layout',{},frame))[0]?.value;
  verifyShareLayout(share,before);
  const rect=shareScreenshotRect(await exec('layout'),frame.frameId,before);
  const tab=await guardTab();
  const url=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
  await guardTab();
  const after=(await exec('share-layout',{},frame))[0]?.value;
  verifyShareLayout(before,after);
  const confirmed=shareScreenshotRect(await exec('layout'),frame.frameId,after);
  if(['x','y','width','height','viewportWidth','viewportHeight'].some(key=>confirmed[key]!==rect[key]))
    throw Error('分享窗口的页面或位置已变化，未保存截图');
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

async function shareColleague(target,name,id,sourceCard,line,policy){
  const recipient=policy.colleague_name;
  await verifyDetail(target,name);
  say(`${name}：评分高于 ${policy.share_above} 分，正在确认站内同事「${recipient}」…`);
  let prepared;
  try{
    prepared=(await exec('prepare-colleague',{name,kind:target.kind,recipient},target.owner))[0]?.value;
    if(!prepared||prepared.recipient!==recipient||typeof prepared.token!=='string'||!prepared.token)
      throw Error('站内转发未确认唯一收件人，未发送履历');
    check();await verifyDetail(target,name);
    const started=await call('/api/extension/colleague-share',{id,source_card:sourceCard,stage:'begin',recipient});
    if(started?.state!=='attempted')throw Error('工作台未确认站内转发开始，未发送履历');
    const sent=(await exec('send-colleague',{token:prepared.token},target.owner))[0]?.value;
    if(sent?.sent!==true||sent?.recipient!==recipient)
      throw Error('站内转发结果未确认，请人工核对，系统不会重复发送');
    check();
    const completed=await call('/api/extension/colleague-share',{id,source_card:sourceCard,stage:'complete',recipient});
    if(completed?.state!=='confirmed')throw Error('站内转发已成功，但工作台未确认记录，请人工核对');
    line.textContent+=` · 已转发给${recipient}`;
  }finally{await exec('closeShare',{},target.owner);}
}

const colleagueWorkPending=(record,policy)=>record.colleague_share_state==='attempted'||
  record.colleague_share_state==='pending'&&policyUsesColleague(policy);

async function finishColleague(target,name,id,sourceCard,line,record,options){
  if(record.colleague_share_state==='attempted')
    throw Error('站内转发可能已提交，请人工核对收件人是否收到，系统不会重复发送');
  if(record.colleague_share_state!=='pending'||!policyUsesColleague(options.policy))return;
  const policy=normalizeCollectionPolicy(record.collection_policy);
  if(!policyUsesColleague(policy))throw Error('工作台返回的站内转发策略无效，未发送。');
  if(policy.colleague_name!==options.policy.colleague_name)
    throw Error(`此候选人已有发给「${policy.colleague_name}」的待转发记录，与本次收件人不同，请先在工作台核对。`);
  const hasShareScore=Object.hasOwn(record,'colleague_share_score');
  const shareScore=hasShareScore?record.colleague_share_score:record.score;
  if((hasShareScore||shareScore!==undefined)&&
      (!Number.isFinite(shareScore)||shareScore<=policy.share_above||shareScore>100))
    throw Error('工作台返回的站内转发分数不符合已保存的策略，未发送。');
  await shareColleague(target,name,id,sourceCard,line,policy);
}

const receiptName=value=>String(value||'').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*');
const receiptFailure=(result,message)=>Object.assign(Error(result?.error||message),
  typeof result?.attempted==='boolean'?{favoriteAttempted:result.attempted}:{});
async function receiptCommand(action,args,frame){
  await guardTab();
  if(action==='click')await checkPaymentNow();
  const request=()=>chrome.scripting.executeScript({target:{tabId,documentIds:[frame.documentId]},world:'MAIN',
    func:resumeFavoriteAction,args:[{action,...args}]});
  const rows=['prepare','seal','verify'].includes(action)?await boundedRead('核对本次简历收藏凭据',request):await request();
  check();
  if(rows.length!==1||rows[0].frameId!==frame.frameId||rows[0].documentId!==frame.documentId||typeof rows[0].result?.ok!=='boolean')
    throw Error('收藏凭据所在的页面框架已变化，未继续操作。');
  return rows[0].result;
}
async function revokeFavoriteReceipt(receipt){
  if(!receipt?.args.token)return;
  favoriteReceipts.delete(receipt.args.token);
  // A late cleanup revokes only its own token, never a newer run's receipt.
  await boundedRead('清理本次收藏凭据',()=>chrome.scripting.executeScript({
    target:{tabId,documentIds:[receipt.frame.documentId]},world:'MAIN',func:resumeFavoriteAction,
    args:[{action:'stop',token:receipt.args.token}]}),Date.now()+1000).catch(()=>{});
}
async function stopFavoriteReceipts(){
  await Promise.allSettled([...favoriteReceipts.values()].map(revokeFavoriteReceipt));
}
function receiptMatches(result,receipt){
  return result?.platform_geek_id===receipt.args.expected_platform_geek_id&&
    result.boss_chat_uid===receipt.ids.boss_chat_uid&&receiptName(result.candidate_name)===receiptName(receipt.args.name);
}
async function prepareSnapshotFavorite(target,name,card){
  if(target.kind!=='canvas')return;
  await revokeFavoriteReceipt(target.favoriteReceipt);
  target.favoriteReceipt=null;
  target.favoriteUnavailable='未确认当前候选人的唯一身份，已暂停自动收藏；不会再次复制简历。';
  const platformId=card?.platform_geek_id;
  if(typeof platformId!=='string'||!/^[A-Za-z0-9_~-]{1,160}$/.test(platformId)||!name)return;
  const args={name,kind:'canvas',expected_platform_geek_id:platformId},frame=target.owner;
  if(!favoriteReceiptFrames.has(frame.documentId)){
    const reset=await receiptCommand('reset',{},frame);
    if(reset.ok!==true)throw receiptFailure(reset,'未能初始化本次收藏凭据。');
    favoriteReceiptFrames.add(frame.documentId);
  }
  let result;
  const transient=new Set(['loading','detail_missing','missing_uid','invalid_identity']);
  for(let attempt=0;attempt<5;attempt++){
    result=await receiptCommand('prepare',args,frame);
    if(!(result.ok===true&&result.status==='unavailable'&&transient.has(result.reason))||attempt===4)break;
    say(`${name}：正在等待当前简历身份加载…`);await delay(200);check();
  }
  if(result.ok===true&&result.status==='unavailable'){
    target.favoriteUnavailable=(result.error||target.favoriteUnavailable)+' 不会再次复制简历。';return;
  }
  if(result.ok!==true||result.status!=='prepared'||typeof result.token!=='string'||!result.token||
      result.platform_geek_id!==platformId||typeof result.boss_chat_uid!=='string'||!/^[1-9][0-9]{0,19}$/.test(result.boss_chat_uid)||
      receiptName(result.candidate_name)!==receiptName(name)||result.attempted!==false)
    throw receiptFailure(result,'未确认本次复制对应的候选人身份，已停止。');
  const receipt={frame,args:{...args,token:result.token,expected_boss_chat_uid:result.boss_chat_uid},
    ids:{boss_chat_uid:result.boss_chat_uid},identity:'',sealed:false};
  target.favoriteReceipt=receipt;favoriteReceipts.set(result.token,receipt);
}
async function sealSnapshotFavorite(target,name,resume){
  const receipt=target.favoriteReceipt;
  if(!receipt)return;
  const identity=resumeHeaderIdentity(resume,name);
  if(!identity)throw Error('本次完整简历缺少可确认的页首身份，未封存收藏凭据。');
  let result;
  for(let attempt=0;attempt<5;attempt++){
    result=await receiptCommand('seal',{...receipt.args,identity},receipt.frame);
    if(!(result.ok===false&&result.status==='blocked'&&result.reason==='loading'&&result.attempted===false)||attempt===4)break;
    say(`${name}：正在等待本次简历身份稳定…`);await delay(200);check();
  }
  if(result.ok!==true||result.status!=='sealed'||result.sealed!==true||result.token!==receipt.args.token||
      result.attempted!==false||!receiptMatches(result,receipt))
    throw receiptFailure(result,'本次复制与当前候选人身份不一致，未封存收藏凭据。');
  receipt.identity=identity;receipt.sealed=true;
}

async function prepareFavorite(target,name,resume){
  await verifyDetail(target,name);
  const identity=target.kind==='canvas'?resumeHeaderIdentity(resume,name):'';
  if(target.kind==='canvas'&&!identity)throw Error('未确认姓名、年龄、学历和工作年限，无法绑定收藏身份。');
  if(target.kind==='canvas'){
    const receipt=target.favoriteReceipt;
    if(!receipt)return {identity,unavailable:target.favoriteUnavailable};
    if(!receipt.sealed||receipt.identity!==identity||receiptName(receipt.args.name)!==receiptName(name))
      throw Error('本次完整简历与收藏凭据不一致，已停止。');
    return {identity,receipt};
  }
  const prepared=(await exec('prepare-favorite',{name,kind:target.kind},target.owner))[0]?.value;
  if(typeof prepared?.token!=='string'||!prepared.token)throw Error('无法绑定当前候选人的收藏操作。');
  return {token:prepared.token,identity};
}

async function finishFavorite(target,name,id,sourceCard,favoriteToken,line){
  let confirmed=false,attempted=false;
  try{
    check();await verifyDetail(target,name);
    const args={name,kind:target.kind,token:favoriteToken.token};
    let result;
    if(target.kind==='canvas'){
      const receipt=favoriteToken.receipt;
      if(!receipt||receipt!==target.favoriteReceipt||!receipt.sealed)
        throw Error(favoriteToken.unavailable||'本次简历没有可复用的收藏凭据，已暂停；不会再次复制简历。');
      const command={...receipt.args,identity:receipt.identity};
      say(`${name}：正在核对本次简历的收藏凭据…`);
      const verified=await receiptCommand('verify',command,receipt.frame);
      if(verified.ok!==true||verified.status!=='verified'||verified.verified!==true||verified.token!==receipt.args.token||
          !receiptMatches(verified,receipt))
        throw receiptFailure(verified,'当前候选人已变化，未点击收藏。');
      say(`${name}：资料已保存，正在收藏…`);attempted=true;
      result=await receiptCommand('click',command,receipt.frame);
      if(result.ok!==true||result.status!=='confirmed'||result.favorited!==true||typeof result.already!=='boolean'||!receiptMatches(result,receipt)){
        const failure=receiptFailure(result,'未确认候选人已收藏，请在 BOSS 人工核对。');
        if(!(result.ok===false&&result.status==='blocked'&&result.attempted===false))delete failure.favoriteAttempted;
        throw failure;
      }
    }else{
      say(`${name}：资料已保存，正在收藏…`);attempted=true;
      result=(await exec('favorite',args,target.owner))[0]?.value;
    }
    if(result?.favorited!==true)throw Error('未确认候选人已收藏，请检查 BOSS 页面后重试。');
    confirmed=true;
    check();
    const saved=await call('/api/extension/favorite-complete',{id,source_card:sourceCard});
    if(saved?.ok!==true)throw Error('收藏已完成，但工作台未确认记录，请重试。');
    await revokeFavoriteReceipt(favoriteToken.receipt);
    line.textContent+=result.already?' · 已收藏（无需重复操作）':' · 已收藏';
  }catch(error){
    assertWork();
    if(!confirmed&&(!attempted||error.favoriteAttempted===false)){
      let cleanup;
      try{
        cleanup=await call('/api/extension/rollback-unreachable',{id,source_card:sourceCard});
        if(cleanup?.ok!==true)throw Error('工作台未确认清理结果');
      }catch(cleanupError){
        throw Error(`${error.message} 履历自动清理失败：${cleanupError.message}`);
      }
      if(cleanup.deleted){
        line.textContent=`${name} · 收藏未完成，已删除履历及采集标记`;
        throw Error(`${error.message} 已删除无回访入口的履历及采集标记，可重新采集。`);
      }
    }
    throw error;
  }
}

const supportsChatEntry=card=>chatEntryAvailable&&card?.kind==='recommendation';
const needsChatEntry=(card,record)=>supportsChatEntry(card)&&record?.chat_entry_eligible===true&&record.has_chat_entry!==true;
const chatEntryConflict=()=>({ok:false,status:'identity-conflict'});
const chatEntryReasons=new Map([
  ['missing_card_identity','卡片未提供可核验标识'],
  ['unsupported_detail','当前详情类型暂不支持'],
  ['unsupported_page','当前页面不支持读取入口'],
  ['no_visible_detail','未找到当前详情'],
  ['no_resume_body','未找到当前简历区域'],
  ['missing_canvas_frame','未找到当前画布简历'],
  ['detail_kind_changed','详情显示形式已变化'],
  ['untrusted_canvas_frame','当前简历框架未通过校验'],
  ['unbound_resume_component','未找到可核验详情组件'],
  ['detail_loading','详情仍在加载'],
  ['missing_resume_identity','详情身份字段未就绪'],
  ['missing_numeric_uid','详情未提供数值 UID'],
  ['script_execution_failed','浏览器未能执行身份读取脚本'],
  ['unexpected_execution_result','读取结果未匹配当前详情文档'],
  ['confirmation_incomplete','尚未完成两次身份核验'],
  ['read_failed','未能读取详情身份'],
]);
const chatEntryStages=new Map([
  ['argument_validation','卡片参数核验阶段'],['page_validation','页面核验阶段'],
  ['detail_lookup','详情定位阶段'],['frame_binding','详情框架绑定阶段'],
  ['vue_lookup','组件定位阶段'],['resume_fields','简历字段读取阶段'],
  ['identity_binding','身份绑定阶段'],['final_recheck','最终复核阶段'],
]);
const unavailableChatEntry=(reason,stage)=>({ok:true,status:'unavailable',reason:chatEntryReasons.has(reason)?reason:'read_failed',
  ...(reason==='read_failed'&&chatEntryStages.has(stage)?{stage}:{})});

async function readBoundChatEntry(target,card){
  if(!supportsChatEntry(card))return null;
  await verifyDetail(target,card.name);
  let result,transportReason='';
  try{
    const scope=target.owner.documentId?{documentIds:[target.owner.documentId]}:{frameIds:[target.owner.frameId]};
    const rows=await interruptible(chrome.scripting.executeScript({target:{tabId,...scope},world:'MAIN',func:readRecommendChatEntry,
      args:[{name:card.name,kind:target.kind,expected_platform_geek_id:card.platform_geek_id||''}]}));
    if(Array.isArray(rows)&&rows.length===1&&rows[0]?.frameId===target.owner.frameId&&
        (!target.owner.documentId||rows[0].documentId===target.owner.documentId)&&
        rows[0].result&&typeof rows[0].result==='object')result=rows[0].result;
    else transportReason='unexpected_execution_result';
  }catch{transportReason='script_execution_failed';}
  await verifyDetail(target,card.name);
  if(transportReason)return unavailableChatEntry(transportReason);
  if(result?.status==='identity-conflict')return chatEntryConflict();
  if(result?.ok===true&&result.status==='available'){
    if(typeof result.boss_chat_uid!=='string'||! /^[1-9][0-9]{0,19}$/.test(result.boss_chat_uid)||
        !card.platform_geek_id||result.platform_geek_id!==card.platform_geek_id||typeof result.candidate_name!=='string')return chatEntryConflict();
    return {ok:true,status:'available',boss_chat_uid:result.boss_chat_uid,
      platform_geek_id:result.platform_geek_id,candidate_name:result.candidate_name};
  }
  if(result?.ok!==true||result.status!=='unavailable')return unavailableChatEntry('unexpected_execution_result');
  return unavailableChatEntry(result.reason,result.stage);
}

async function readVerifiedChatEntry(target,card){
  // DOM verification can itself take seconds. Only the deliberate waits for
  // missing page fields consume this budget; every successful sample still
  // needs a second complete read with both surrounding detail checks.
  let waitRemaining=2000;
  let observed=null,previous=null,lastUnavailable=unavailableChatEntry('read_failed');
  for(let attempt=0;attempt<6;attempt++){
    check();
    const entry=await readBoundChatEntry(target,card);
    if(!entry||entry.status==='identity-conflict')return entry;
    if(entry.status==='available'){
      if(observed&&['boss_chat_uid','platform_geek_id','candidate_name'].some(key=>observed[key]!==entry[key]))
        return chatEntryConflict();
      if(previous)return entry;
      observed=entry;previous=entry;
    }else{
      lastUnavailable=entry;
      previous=null;
      if(attempt<5&&waitRemaining>0){
        const wait=Math.min(400,waitRemaining);
        await delay(wait);waitRemaining-=wait;
      }
    }
  }
  return observed?unavailableChatEntry('confirmation_incomplete'):lastUnavailable;
}

async function collectResumeWithChatEntry(target,card,list){
  const data=await collectResume(target,card.name,{card,list});
  // ResumeRoot can still be loading when its iframe first appears. Finish the
  // existing text/identity checks before taking two complete UID bindings.
  const before=await readBoundChatEntry(target,card);
  const after=await readBoundChatEntry(target,card);
  let chatEntry=after;
  if(before?.status==='identity-conflict'||after?.status==='identity-conflict')chatEntry=chatEntryConflict();
  else if(before?.status==='available'&&after?.status==='available'){
    if(['boss_chat_uid','platform_geek_id','candidate_name'].some(key=>before[key]!==after[key]))chatEntry=chatEntryConflict();
  }else if(before||after)chatEntry=after?.status==='unavailable'?after:
    before?.status==='unavailable'?before:unavailableChatEntry('read_failed');
  return {data,chatEntry};
}

async function saveChatEntry(id,sourceCard,entry,line){
  if(!entry)return false;
  check();
  if(entry.status!=='available'){
    line.textContent+=entry.status==='identity-conflict'?' · 聊天入口身份未确认，未保存链接':
      ` · 未获取聊天入口，可稍后补采（${chatEntryReasons.get(entry.reason)||chatEntryReasons.get('read_failed')}${entry.reason==='read_failed'&&chatEntryStages.has(entry.stage)?'：'+chatEntryStages.get(entry.stage):''}）`;
    return false;
  }
  try{
    const saved=await call('/api/extension/chat-entry',{id,source_card:sourceCard,boss_chat_uid:entry.boss_chat_uid});
    if(saved?.ok!==true)throw Error('工作台未确认聊天入口保存结果');
    check();
    line.textContent+=' · 候选人联系标识已保存（沟通关系未核实）';
    return true;
  }catch(error){
    check();
    line.textContent+=' · 聊天入口未保存，可稍后补采';
    return false;
  }
}

const numericGreetingUid=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value);
const recommendationList=frame=>isBoss(frame?.value?.frameKey)&&
  /^\/web\/(?:geek\/recommend|frame\/recommend)\/?$/.test(new URL(frame.value.frameKey).pathname);
const greetingEnabled=(card,options)=>options.policy.greet_enabled&&numericGreetingUid(options.greetingAccountUid)&&card?.kind==='recommendation';
const greetingScoreEligible=(record,policy)=>record.ai_pending===false&&Number.isFinite(record.score)&&record.score<=100&&
  record.score>policy.save_above&&record.score>policy.share_above;
const greetingWorkPending=(card,record,options)=>greetingEnabled(card,options)&&record&&
  record.chat_entry_eligible===true&&
  (record.greeting_state==='attempted'||record.greeting_eligible===true&&['','pending'].includes(record.greeting_state||''));
const greetingFrameKey=frame=>frame.documentId||'frame:'+frame.frameId;

async function greetingCommand(args,frame){
  if(args.action!=='stop')check();
  if(args.action==='send')await checkPaymentNow();
  if(!frame||!Number.isInteger(frame.frameId))throw Error('未确认打招呼页面框架，未发送。');
  greetingFrames.set(greetingFrameKey(frame),frame);
  const scope=frame.documentId?{documentIds:[frame.documentId]}:{frameIds:[frame.frameId]};
  const rows=await chrome.scripting.executeScript({target:{tabId,...scope},world:'MAIN',func:recommendGreetingAction,args:[args]});
  if(args.action!=='stop')check();
  if(!Array.isArray(rows)||rows.length!==1||rows[0]?.frameId!==frame.frameId||
      frame.documentId&&rows[0].documentId!==frame.documentId||!rows[0]?.result||typeof rows[0].result.status!=='string')
    throw Error('打招呼读取结果与当前页面不一致，未继续发送。');
  return rows[0].result;
}

async function resetGreetingFrame(frame){
  const key=greetingFrameKey(frame);
  if(greetingResetFrames.has(key))return;
  const result=await greetingCommand({action:'reset'},frame);
  if(result.ok!==true)throw Error('打招呼控件尚未准备就绪，未发送。');
  greetingResetFrames.add(key);
}

function stopGreetings(){
  for(const frame of greetingFrames.values())greetingCommand({action:'stop'},frame).catch(()=>{});
}

async function finishGreeting(target,card,id,job,record,options,line,chatEntry){
  if(!greetingEnabled(card,options))return;
  if(record.greeting_state==='attempted')throw Error('此前打招呼可能已提交，请在 BOSS 人工核对，系统不会重复发送。');
  if(['confirmed','already'].includes(record.greeting_state))return;
  if(!greetingScoreEligible(record,options.policy))return;
  if(chatEntry?.status!=='available'||!numericGreetingUid(chatEntry.boss_chat_uid)||
      chatEntry.platform_geek_id!==card.platform_geek_id)throw Error('未确认这位候选人的真实身份标识，未打招呼，请重新核对。');
  check();await guardTab();await verifyDetail(target,card.name);
  await resetGreetingFrame(target.owner);
  const identity={name:card.name,kind:target.kind,expected_platform_geek_id:card.platform_geek_id,
    expected_boss_chat_uid:chatEntry.boss_chat_uid,expected_account_uid:options.greetingAccountUid,
    expected_job_title:options.greetingJobTitle};
  if(typeof identity.expected_job_title!=='string'||!identity.expected_job_title.trim())
    throw Error('未确认本次沟通岗位名称，未打招呼。');
  say(`${card.name}：收藏及分享已完成，正在核对高分打招呼对象…`);
  const prepared=await greetingCommand({action:'prepare',...identity},target.owner);
  const normalized=value=>typeof value==='string'?value.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*'):'';
  const sameIdentity=value=>value?.account_uid===identity.expected_account_uid&&value.boss_chat_uid===identity.expected_boss_chat_uid&&
    value.platform_geek_id===identity.expected_platform_geek_id&&normalized(value.candidate_name)===normalized(card.name);
  if(prepared.ok===false&&prepared.status==='blocked'){
    const reasons={job_changed:'BOSS 当前沟通岗位与工作台所选岗位不一致，未打招呼。请核对两个岗位名称。',
      job_unconfirmed:'未确认唯一沟通岗位，或页面要求选择岗位，未打招呼。请先在 BOSS 选择对应岗位。',
      account_changed:'BOSS 招聘账号已切换，未打招呼。请回到本次采集使用的账号。',
      account_missing:'未能确认 BOSS 招聘账号，未打招呼。',
      source_unconfirmed:'未确认候选人的沟通来源，未打招呼。'};
    if(Object.hasOwn(reasons,prepared.reason))throw Error(reasons[prepared.reason]);
  }
  if(prepared.ok!==true||!['ready','already'].includes(prepared.status)||!sameIdentity(prepared))
    throw Error('未确认唯一的候选人、招聘账号和打招呼控件，未发送。');
  check();await verifyDetail(target,card.name);
  const payload={id,job_id:job,source_card:{name:card.name,signature:card.signature},boss_chat_uid:identity.expected_boss_chat_uid,
    account_uid:identity.expected_account_uid,collection_policy:options.policy};
  const validReply=response=>response?.ok===true&&response.id===id&&response.account_uid===payload.account_uid&&
    response.boss_chat_uid===payload.boss_chat_uid;
  if(prepared.status==='already'){
    const already=await call('/api/extension/greeting',{...payload,stage:'already'});check();
    if(!validReply(already)||already.may_greet!==false||!['confirmed','already'].includes(already.state))
      throw Error('已有沟通关系的记录未确认，或此前打招呼结果待核对；系统不会重复发送。');
    line.textContent+=' · 已沟通过，未重复打招呼';return;
  }
  if(typeof prepared.token!=='string'||!prepared.token)throw Error('未取得唯一打招呼凭据，未发送。');
  const begun=await call('/api/extension/greeting',{...payload,stage:'begin'});check();
  if(!validReply(begun))throw Error('工作台未确认打招呼许可，未发送。');
  if(begun.may_greet===false){
    if(['confirmed','already'].includes(begun.state)){line.textContent+=' · 已有打招呼记录，未重复发送';return;}
    throw Error('此前打招呼可能已提交，请在 BOSS 人工核对，系统不会重复发送。');
  }
  if(begun.may_greet!==true||begun.state!=='attempted'||typeof begun.attempt_token!=='string'||!begun.attempt_token)
    throw Error('工作台未确认一次性打招呼许可，未发送。');
  check();await verifyDetail(target,card.name);
  const sent=await greetingCommand({action:'send',...identity,token:prepared.token},target.owner);
  if(sent.ok!==true||sent.status!=='confirmed'||!sameIdentity(sent))
    throw Error('打招呼未完成或结果不明确，请在 BOSS 人工核对；系统不会自动再次发送。');
  check();
  const completed=await call('/api/extension/greeting',{...payload,stage:'complete',attempt_token:begun.attempt_token});check();
  if(!validReply(completed)||completed.state!=='confirmed'||completed.may_greet!==false)
    throw Error('BOSS 已确认打招呼，但工作台记录未确认，请人工核对，系统不会重复发送。');
  line.textContent+=' · 已使用 BOSS 默认招呼语打招呼';
}

async function saveCandidate(target,data,job,options,line,chatEntry=null,card=null){
  check();
  const favoriteToken=await prepareFavorite(target,data.name,data.resume);
  say(`${data.name}：正在评估，评分高于 ${options.policy.save_above} 分或评估失败时保存…`);
  line.textContent=`${data.name} · 正在评估`;
  const screened=await call('/api/extension/screen',{job_id:job,candidate:data,collection_policy:options.policy});
  if(typeof screened?.saved!=='boolean'||typeof screened.ai_pending!=='boolean')throw Error('工作台没有返回有效的筛选结果。');
  if(!screened.collection_policy)throw Error('工作台没有确认本次采集策略，请重启服务后重试。');
  const policy=normalizeCollectionPolicy(screened.collection_policy);
  if(screened.evaluation_method==='rules'){
    if(!isRulePrecheck(screened)||screened.saved!==false||screened.ai_pending!==false||screened.id!=null||
        screened.favorite_pending!==false||screened.collection_marked!==true||
        JSON.stringify(policy)!==JSON.stringify(options.policy))
      throw Error('工作台没有确认带原文依据的规则预筛结果，已暂停。');
    const reasons=screened.precheck.checks.map(item=>`${item.condition}：${item.reasoning}`).join('；');
    line.textContent=`${data.name} · 规则预筛未达标 · ${reasons} · 未调用模型，未保存履历，已保留采集标记`;
    return {aiPending:false,saved:false,rulesRejected:true};
  }
  if(!screened.saved){
    if(JSON.stringify(policy)!==JSON.stringify(options.policy)||screened.ai_pending||!Number.isFinite(screened.score)||screened.score<0||screened.score>policy.save_above||screened.id!=null||
        screened.collection_marked!==true||screened.favorite_pending!==false){
      throw Error('工作台没有确认低分筛选结果，已暂停。');
    }
    line.textContent=`${data.name} · 匹配度 ${screened.score} · 未高于 ${policy.save_above} 分，未保存履历，已保留采集标记`;
    return {aiPending:false,saved:false};
  }
  const id=screened.id;
  if(!Number.isInteger(id)||id<1||typeof screened.favorite_pending!=='boolean'||
      (!screened.ai_pending&&(!Number.isFinite(screened.score)||screened.score<=policy.save_above||screened.score>100))){
    throw Error('工作台没有确认保存筛选结果。');
  }
  line.textContent=`${data.name} · #${id} · 履历已保存`+(screened.ai_pending
    ?' · 评估失败，诊断已保存，AI 待评估':` · 匹配度 ${screened.score}`);
  await saveChatEntry(id,data.source_card,chatEntry,line);
  if(screened.favorite_pending)await finishFavorite(target,data.name,id,data.source_card,favoriteToken,line);
  else line.textContent+=' · 收藏已确认';
  await finishColleague(target,data.name,id,data.source_card,line,screened,options);
  if(options.share)await saveShareImage(target,data.name,id,line);
  await finishGreeting(target,card,id,job,{...screened,favorite_pending:false},options,line,chatEntry);
  return {aiPending:screened.ai_pending,saved:true};
}

async function run({chatEntryOnly=false}={}){
  const job=Number($('#job').value),requested=$('#limit').value.trim();
  const limit=requested?Number(requested):Infinity;
  if(!job||requested&&(!Number.isSafeInteger(limit)||limit<1))throw Error('请选择岗位，人数请留空或填写正整数。');
  if(chatEntryOnly&&!chatEntryAvailable)throw Error('工作台尚不支持聊天入口补采，请重启工作台。');
  const continuous=!chatEntryOnly&&limit===Infinity;
  const policy=chatEntryOnly?DEFAULT_COLLECTION_POLICY:readCollectionPolicy();
  const options={share:!chatEntryOnly&&policyUsesQr(policy),policy};
  if(!chatEntryOnly&&policy.greet_enabled&&!greetingAvailable)throw Error('工作台尚不支持安全打招呼记录，请更新并重启工作台。');
  if(!chatEntryOnly){
    collectionPolicies[String(job)]=policy;
    await policyWrite.catch(()=>{});
    await chrome.storage.local.set({[selectedJobKey]:String(job),[policyStorageKey]:{...collectionPolicies}});
  }
  $('#results').replaceChildren();
  await guardTab();
  await chrome.scripting.executeScript({target:{tabId,allFrames:true},files:['dom-reader.js','automation.js']});
  await exec('reset');
  await returnToCandidateList();
  const searchScope=chatEntryOnly?null:await applyJobSearchConditions(job);
  let backfillScope=null;
  const assertSearchScope=frame=>{
    const url=frame.value?.frameKey;
    if(chatEntryOnly&&(!isBoss(url)||!/^\/web\/(?:geek\/recommend|frame\/recommend)\/?$/.test(new URL(url).pathname)))
      throw Error('仅补采聊天入口只支持当前「推荐牛人」列表，请先打开推荐列表。');
    if(!isBoss(url)||!/^\/web\/(?:chat\/search|geek\/recommend|frame\/(?:search|recommend))\/?$/.test(new URL(url).pathname))
      throw Error('批量采集目前支持「推荐牛人」和「搜索」列表。聊天页请打开单份简历后使用「评估当前简历」。');
    if(searchScope&&(frame.frameId!==searchScope.frameId||
        searchScope.documentId&&frame.documentId!==searchScope.documentId))
      throw Error('候选人列表与应用查询条件的搜索页面不一致，已停止采集。');
    if(backfillScope&&(frame.frameId!==backfillScope.frameId||frame.documentId!==backfillScope.documentId))
      throw Error('推荐列表页面已切换，聊天入口补采已停止。');
    if(options.greetingListScope&&(!recommendationList(frame)||frame.frameId!==options.greetingListScope.frameId||
        frame.documentId!==options.greetingListScope.documentId))throw Error('打招呼所绑定的推荐列表已变化，已停止采集。');
  };
  let frames=await scanList();
  if(frames.some(row=>row.value.detail||row.value.canvasDialog))throw Error('请先关闭当前简历详情，回到候选人小卡片列表。');
  const lists=frames.filter(row=>row.value.cards.length);
  if(lists.length!==1)throw Error('未找到唯一的候选人小卡片列表。');
  assertSearchScope(lists[0]);
  if(!chatEntryOnly&&policy.greet_enabled&&recommendationList(lists[0])){
    await resetGreetingFrame(lists[0]);
    const account=await greetingCommand({action:'account'},lists[0]);
    if(account.ok!==true||account.status!=='available'||!numericGreetingUid(account.account_uid))
      throw Error('未确认当前招聘账号，未开始自动打招呼采集。');
    options.greetingAccountUid=account.account_uid;options.greetingListScope=lists[0];
    options.greetingJobTitle=configuredJobs.find(row=>Number(row.id)===job)?.title;
    if(typeof options.greetingJobTitle!=='string'||!options.greetingJobTitle.trim())
      throw Error('未确认本次沟通岗位名称，未开始自动打招呼采集。');
  }
  if(chatEntryOnly)backfillScope={frameId:lists[0].frameId,documentId:lists[0].documentId,
    cards:lists[0].value.cards.map(card=>({...card}))};
  let list=lists[0],handled=0,aiPending=0,savedCount=0,lowScore=0,rulesRejected=0,unreadable=0;
  const checked=new Set(),completed=new Set(),known=new Map(),skipped=new Set();
  const deferred=new Map(),boundAmbiguities=new Set();
  const summary=()=>chatEntryOnly
    ?`聊天入口补采完成：已检查 ${handled} 位已归档候选人，补充 ${savedCount} 个入口；跳过 ${skipped.size} 位无需补采或未归档候选人。${deferred.size?` 暂缓 ${deferred.size} 组重复卡片。`:''}${unreadable?` ${unreadable} 位原文未确认。`:''}`
    :`本次已处理 ${handled} 位候选人，保存 ${savedCount} 位，低分未保存 ${lowScore} 位，${rulesRejected?`规则预筛未达标 ${rulesRejected} 位，`:''}文字衔接未确认跳过 ${unreadable} 位，跳过 ${skipped.size} 位已采集。${deferred.size?` 暂缓 ${deferred.size} 组重复卡片，未新增采集。`:''}${aiPending?` ${aiPending} 位 AI 待评估，诊断已保留，可在工作台重试。`:''}`;
  function unambiguousCards(snapshot){
    const cards=snapshot.list.value.cards;
    const ambiguous=new Set(snapshot.duplicates);
    // A short-lived duplicate can also invalidate an already bound identity.
    // Preserve that observation even when the final scan has only one copy.
    for(const signature of snapshot.observedDuplicates.keys()){
      if(known.has(signature)||completed.has(signature)||!cards.some(card=>card.signature===signature))ambiguous.add(signature);
    }
    for(const signature of ambiguous){
      const group=cards.filter(card=>card.signature===signature),observed=snapshot.observedDuplicates.get(signature);
      let line=deferred.get(signature);
      if(!line){line=document.createElement('li');deferred.set(signature,line);$('#results').append(line);}
      const reason=group.length>1?`${group.length} 张卡片无法区分`:'卡片曾出现重复，身份待确认';
      line.textContent=`${group[0]?.name||observed.name} · ${reason}，暂缓此组，继续其他候选人`;
      // A prior lookup must not be used to finish another identical-looking
      // candidate's external actions after the list becomes ambiguous.
      if(completed.has(signature)||known.has(signature))boundAmbiguities.add(signature);
      checked.delete(signature);known.delete(signature);
    }
    const unique=cards.filter(card=>{
      if(snapshot.duplicates.has(card.signature)||boundAmbiguities.has(card.signature))return false;
      if(!backfillScope)return true;
      const original=backfillScope.cards.filter(item=>item.signature===card.signature);
      if(original.length!==1)return false;
      if(original[0].name!==card.name||original[0].kind!==card.kind||original[0].platform_geek_id!==card.platform_geek_id)
        throw Error('本次推荐候选人的身份已变化，聊天入口补采已停止。');
      return true;
    });
    for(const card of unique){
      const line=deferred.get(card.signature);
      if(line){line.textContent=`${card.name} · 列表重复已消除`;deferred.delete(card.signature);}
    }
    return unique;
  }
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
        job_id:job,share:options.share,collection_policy:options.policy,cards:batch.map(({name,signature})=>({name,signature})),
        ...(options.greetingAccountUid?{greeting_account_uid:options.greetingAccountUid}:{})
      });
      check();
      if(!Array.isArray(progress.completed)||progress.completed.some(value=>typeof value!=='string'||!requestedSignatures.has(value))){
        throw Error('工作台没有返回有效的采集记录，请重启服务后重试。');
      }
      const knownRecords=progress.known===undefined?[]:progress.known;
      if(!Array.isArray(knownRecords)||knownRecords.some(record=>!record||typeof record.signature!=='string'||
          !Number.isInteger(record.id)||record.id<1||typeof record.has_image!=='boolean'||
          (record.has_chat_entry!==undefined&&typeof record.has_chat_entry!=='boolean')||
          (record.chat_entry_eligible!==undefined&&typeof record.chat_entry_eligible!=='boolean')||
          (record.favorite_pending!==undefined&&typeof record.favorite_pending!=='boolean')||
          (record.greeting_state!==undefined&&!['','pending','attempted','confirmed','already'].includes(record.greeting_state))||
          (options.greetingAccountUid&&(typeof record.greeting_eligible!=='boolean'||typeof record.ai_pending!=='boolean'||
            record.score!==null&&(!Number.isFinite(record.score)||record.score<0||record.score>100)))||
          !['','pending','attempted','confirmed'].includes(record.colleague_share_state||''))){
        throw Error('工作台没有返回有效的已保存候选人记录，请重启服务后重试。');
      }
      for(const record of knownRecords){
        if(!requestedSignatures.has(record.signature)||known.has(record.signature)){
          throw Error('工作台返回的已保存候选人记录不唯一，请重启服务后重试。');
        }
        known.set(record.signature,record);
      }
      if(chatEntryOnly){
        for(const card of batch){
          if(!needsChatEntry(card,known.get(card.signature))){completed.add(card.signature);skipped.add(card.signature);}
          checked.add(card.signature);
        }
        continue;
      }
      for(const signature of progress.completed){
        if(known.get(signature)?.favorite_pending)throw Error('工作台返回了未完成收藏的采集记录，请重试。');
        if(needsChatEntry(batch.find(card=>card.signature===signature),known.get(signature)))continue;
        if(greetingWorkPending(batch.find(card=>card.signature===signature),known.get(signature),options))continue;
        completed.add(signature);skipped.add(signature);
      }
      for(const record of knownRecords){
        if(!record.favorite_pending&&(!options.share||record.has_image)&&
            !colleagueWorkPending(record,options.policy)&&
            !needsChatEntry(batch.find(card=>card.signature===record.signature),record)&&
            !greetingWorkPending(batch.find(card=>card.signature===record.signature),record,options)){
          completed.add(record.signature);skipped.add(record.signature);
        }
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
    const snapshot=await settleListSnapshot(frames,list,deferred);
    ({frames,list}=snapshot);
    assertSearchScope(list);
    const uniqueCards=unambiguousCards(snapshot);
    await loadProgress(uniqueCards);
    const card=uniqueCards.find(card=>!completed.has(card.signature));
    if(!card){
      if(!continuous){
        say(chatEntryOnly||handled||deferred.size?summary():`当前已加载的 ${list.value.cards.length} 位候选人均已采集。请在 BOSS 加载其他候选人后重新开始。`,'done');
        return;
      }
      await guardTab();
      const advanced=(await exec('advance-list',{},list))[0].value;
      check();
      const action=advanced?.kind==='waiting'?'暂无新候选人，持续等待列表更新，可点击停止。':'正在加载后续候选人…';
      say(`${summary()} ${action}`);
      await waitForCandidates();
      frames=await scanList();
      continue;
    }
    const saved=known.get(card.signature);
    say(chatEntryOnly?`仅补采聊天入口：正在核对第 ${handled+1} 位已归档候选人：${card.name}`:
      `已跳过 ${skipped.size} 位已采集候选人。${saved?'正在补充采集步骤':'正在打开'}第 ${handled+1}${continuous?'':`/${limit}`} 位：${card.name}`);
    const settled=await settleListSnapshot(await scanList(),list,deferred),freshFrames=settled.frames,fresh=settled.list;
    assertSearchScope(fresh);
    const freshUnique=unambiguousCards(settled);
    if(settled.duplicates.has(card.signature)||boundAmbiguities.has(card.signature)){
      frames=freshFrames;list=fresh;continue;
    }
    const matches=freshUnique.filter(item=>item.signature===card.signature);
    if(!matches.length&&(continuous||settled.observedDuplicates.has(card.signature))){
      say(`${summary()} 列表已更新，正在重新定位尚未采集的候选人…`);
      frames=freshFrames;
      continue;
    }
    if(matches.length!==1)throw Error('候选人列表已更新，无法确认要打开的小卡片。');
    if(card.kind==='recommendation'&&(matches[0].kind!==card.kind||matches[0].platform_geek_id!==card.platform_geek_id))
      throw Error('推荐候选人的身份已变化，请重新开始采集。');
    await exec('open',matches[0],fresh);
    const line=document.createElement('li');line.textContent=`${card.name} · 正在处理`;$('#results').append(line);
    let target;
    try{
      target=await waitDetail(card.name);
      if(chatEntryOnly){
        if(!saved||!needsChatEntry(card,saved))throw Error('该候选人没有可补充入口的已归档记录。');
        line.textContent=`${card.name} · #${saved.id} · 仅补采聊天入口`;
        const chatEntry=await readVerifiedChatEntry(target,card);
        if(chatEntry?.status==='identity-conflict')throw Error('当前简历的聊天身份发生变化，未保存入口，请重新核对候选人。');
        if(await saveChatEntry(saved.id,{name:card.name,signature:card.signature},chatEntry,line))savedCount++;
      }else if(saved){
        line.textContent=`${card.name} · #${saved.id} · 履历已保存`;
        if(greetingWorkPending(card,saved,options)&&saved.greeting_state==='attempted')
          throw Error('此前打招呼可能已提交，请在 BOSS 人工核对，系统不会重复发送。');
        let greetingEntry=null,greetingPending=greetingWorkPending(card,saved,options);
        if(saved.favorite_pending||needsChatEntry(card,saved)||greetingPending){
          // A freshly reopened canvas may still be blank or show a previous
          // person. Reuse the complete identity/read check before binding the
          // favorite action, without another model request or candidate write.
          say(`${card.name}：正在核对已保存候选人的简历…`);
          const {data,chatEntry}=await collectResumeWithChatEntry(target,card,fresh);
          greetingEntry=chatEntry;
          if(needsChatEntry(card,saved)&&await saveChatEntry(saved.id,{name:card.name,signature:card.signature},chatEntry,line)){
            // The status lookup predates the newly bound UID. The greeting
            // begin endpoint rechecks the current score and complete identity.
            if(greetingEnabled(card,options)&&saved.chat_entry_eligible===true&&
                ['','pending'].includes(saved.greeting_state||'')&&greetingScoreEligible(saved,options.policy))greetingPending=true;
          }
          if(saved.favorite_pending){
            const favoriteToken=await prepareFavorite(target,card.name,data.resume);
            await finishFavorite(target,card.name,saved.id,{name:card.name,signature:card.signature},favoriteToken,line);
          }
        }
        await finishColleague(target,card.name,saved.id,{name:card.name,signature:card.signature},line,saved,options);
        if(options.share&&!saved.has_image)await saveShareImage(target,card.name,saved.id,line);
        if(greetingPending)await finishGreeting(target,card,saved.id,job,
          {...saved,favorite_pending:false},options,line,greetingEntry);
      }else{
        const {data,chatEntry}=await collectResumeWithChatEntry(target,card,fresh);
        data.source_card={name:card.name,signature:card.signature};
        const result=await saveCandidate(target,data,job,options,line,chatEntry,card);
        if(result.aiPending)aiPending++;
        if(result.saved)savedCount++;else if(result.rulesRejected)rulesRejected++;else lowScore++;
      }
      completed.add(card.signature);
      handled++;
      check();
      await verifyDetail(target,card.name);
      await exec('close',{name:card.name,kind:target.kind},target.owner);
      await delay(650);
      frames=await scanList();
      if(frames.some(row=>row.value.detail||row.value.canvasDialog))throw Error('详情窗口未关闭。');
    }catch(error){
      if(error.code==='skip-ambiguous-overlap'&&target){
        try{
          await verifyDetail(target,card.name);
          await exec('close',{name:card.name,kind:target.kind},target.owner);
          await delay(650);
          frames=await scanList();
          if(frames.some(row=>row.value.detail||row.value.canvasDialog))throw Error('详情窗口未关闭。');
        }catch(closeError){
          line.textContent=`${card.name} · 文字衔接未确认，关闭详情失败：${closeError.message}`;
          throw Error(`停在 ${card.name}，未打开下一位。${closeError.message}`);
        }
        completed.add(card.signature);
        unreadable++;
        if(chatEntryOnly)handled++;
        line.textContent=`${card.name} · 分屏文字衔接未确认，已跳过；本次未评估、未保存、未标记`;
        say(`${card.name}：分屏文字衔接未确认，已跳过并继续下一位。本次未评估、未保存、未标记。`);
        continue;
      }
      line.textContent+=` · 已暂停：${error.message}`;
      throw Object.assign(Error(`停在 ${card.name}，未打开下一位。${error.message}`),{code:error.code});
    }
  }
  say(summary(),'done');
}

async function returnToCandidateList(){
  let frames;
  try{frames=await exec('current-detail');}
  catch(error){
    // The existing list preflight handles promotional overlays separately.
    if(/热搜推荐弹层/.test(error.message))return;
    throw error;
  }
  if(!frames.some(row=>row.value.kind!=='none'))return;
  if(frames.some(row=>!['none','text','canvas-owner','canvas-body'].includes(row.value.kind)))
    throw Error('当前打开的窗口不是可确认的在线简历，请手动返回候选人列表。');
  const target=await currentOpenDetail(frames),owner=target.owner;
  const url=owner.value.binding?.ownerUrl||owner.value.frameKey;
  if(!isBoss(url)||!/^\/web\/(?:chat\/search|geek\/recommend|frame\/(?:search|recommend))\/?$/.test(new URL(url).pathname))
    throw Error('当前在线简历不属于候选人搜索或推荐列表，请手动返回列表后开始。');
  const originalTab=await guardTab();
  const checkPage=async()=>{
    if((await guardTab()).url!==originalTab.url)throw Error('返回列表期间 BOSS 页面已切换，未继续采集。');
  };
  const before=await scan();
  const listScopes=before.filter(row=>row.documentId&&isBoss(row.value.frameKey)&&
    /^\/web\/(?:chat\/search|geek\/recommend|frame\/(?:search|recommend))\/?$/.test(new URL(row.value.frameKey).pathname));
  if(!listScopes.length)throw Error('未绑定原候选人列表页面，请手动返回列表后开始。');
  await checkPage();
  say('正在退出当前在线简历，返回候选人列表继续采集…');
  const closed=await exec('close-current',{kind:owner.value.kind,token:owner.value.token,
    name:owner.value.name||'',binding:owner.value.binding||null},owner);
  if(closed.length!==1||closed[0].frameId!==owner.frameId||closed[0].documentId!==owner.documentId||
      closed[0].value?.closed!==true)
    throw Error('未确认当前在线简历已关闭，请手动返回列表后重试。');
  let detailVisible=true;
  for(let attempt=0;attempt<16;attempt++){
    await delay(250);await checkPage();
    const remaining=await exec('current-detail');
    const active=remaining.filter(row=>row.value.kind!=='none');
    if(active.some(row=>!frames.some(before=>before.frameId===row.frameId&&before.documentId===row.documentId&&
        before.value.kind===row.value.kind&&before.value.token===row.value.token&&before.value.name===row.value.name&&
        sameResumeBinding(before.value.binding,row.value.binding))))
      throw Error('返回列表期间在线简历已切换，未继续采集。');
    detailVisible=active.length>0;
    if(detailVisible)continue;
    const snapshot=await scan();await checkPage();
    if(listScopes.some(bound=>!snapshot.some(row=>row.frameId===bound.frameId&&row.documentId===bound.documentId&&
        row.value.frameKey===bound.value.frameKey)))
      throw Error('返回列表期间候选人列表页面已更换，未继续采集。');
    if(snapshot.some(row=>row.value.detail||row.value.canvasDialog||row.value.canvasBody))
      throw Error('返回列表期间出现了另一份简历，未继续采集。');
    const lists=snapshot.filter(row=>row.value.cards.length);
    if(lists.length>1)throw Error('返回列表后未找到唯一的候选人小卡片列表。');
    if(lists.length===1){
      if(!listScopes.some(bound=>bound.frameId===lists[0].frameId&&bound.documentId===lists[0].documentId))
        throw Error('返回的候选人列表不属于原页面，未继续采集。');
      return;
    }
    say('在线简历已关闭，正在等待原候选人列表恢复…');
  }
  throw Error(detailVisible?'在线简历尚未关闭，未继续采集。':'原候选人列表仍在加载，请等待后重新开始。');
}

function sameResumeBinding(left,right){
  return !left&&!right||Boolean(left&&right&&left.ownerUrl===right.ownerUrl&&left.bodyUrl===right.bodyUrl);
}

async function currentOpenDetail(observedFrames){
  if(!observedFrames)await scan();
  const frames=observedFrames||await exec('current-detail');
  const text=frames.filter(row=>row.value.kind==='text'),owners=frames.filter(row=>row.value.kind==='canvas-owner'),
    bodies=frames.filter(row=>row.value.kind==='canvas-body');
  const pinned=row=>row.documentId&&typeof row.value.token==='string'&&row.value.token.length>0;
  if(text.length===1&&!owners.length&&!bodies.length&&pinned(text[0])&&text[0].value.name)
    return {kind:'text',owner:text[0],body:text[0],name:text[0].value.name};
  if(!text.length&&owners.length===1&&bodies.length===1&&pinned(owners[0])&&pinned(bodies[0])){
    const left=owners[0].value.binding,right=bodies[0].value.binding;
    if(left?.ownerUrl&&left?.bodyUrl&&left.ownerUrl===right?.ownerUrl&&left.bodyUrl===right?.bodyUrl)
      return {kind:'canvas',owner:owners[0],body:bodies[0]};
  }
  throw Error('请在 BOSS 打开且只保留一份简历，再点击「评估当前简历」。不会从背景列表选择其他候选人。');
}

async function verifyOpenTarget(target,name,{bindContent=false}={}){
  const fresh=await currentOpenDetail();
  const same=(before,after)=>before.documentId===after.documentId&&before.frameId===after.frameId&&
    before.value.token===after.value.token;
  if(fresh.kind!==target.kind||!same(target.owner,fresh.owner)||!same(target.body,fresh.body)||
    (target.kind==='text'&&fresh.name!==name)||
    (target.kind==='canvas'&&!sameResumeBinding(target.body.value.binding,fresh.body.value.binding)))
    throw Error('当前打开的简历已切换，本次结果不再显示，请重新点击评估。');
  if(target.kind==='text'){
    const content=fresh.body.value.contentKey;
    if(typeof content!=='string'||!content||content.length>100000||target.contentKey&&target.contentKey!==content)
      throw Error('当前简历原文已变化，本次结果不再显示，请重新评估。');
    if(bindContent)target.contentKey=content;
  }
}

async function evaluateCurrent(){
  const job=Number($('#job').value);
  if(!Number.isSafeInteger(job)||job<=0)throw Error('请选择匹配岗位。');
  await chrome.storage.local.set({[selectedJobKey]:String(job)});
  $('#direct-result').hidden=true;$('#direct-result').replaceChildren();
  await guardTab();
  await chrome.scripting.executeScript({target:{tabId,allFrames:true},files:['dom-reader.js','automation.js']});
  await exec('reset');
  const target=await currentOpenDetail();
  if(target.kind==='canvas')readMode='foreground';
  const candidate=await collectResume(target,target.name||'');
  const name=candidate.name;
  check();await verifyOpenTarget(target,name,{bindContent:true});
  say(`${name}：正在按本次复制的简历评估；修改原文后请重新评估。`);
  const response=await call('/api/extension/preview-resume',{job_id:job,candidate});
  check();await verifyOpenTarget(target,name);check();
  if(response.saved!==false||response.name!==name||response.job?.id!==job)
    throw Error('评估结果与本次简历或岗位不一致，未展示。');
  const ruleRejected=response.result?.evaluation_method==='rules';
  if(ruleRejected&&!isRulePrecheck(response.result))
    throw Error('未收到带原文依据的规则预筛结果，请重试。');
  renderDirectEvaluation($('#direct-result'),response);
  $('#direct-result').hidden=false;
  const conclusion=ruleRejected?'规则预筛未达标，未调用模型。':`评估完成，匹配度 ${response.result.score} 分。`;
  say(`${name}：${conclusion}按本次复制的简历评估；修改原文后请重新评估。结果仅在本窗口展示，未保存、未收藏。`,'done');
}

async function startWork(direct=false,chatEntryOnly=false){
  if(!ready||running)return;
  readMode=selectedReadMode();
  running=true;stopped=false;directRunning=direct;
  const session=createWorkSession();activeWork=session;
  greetingFrames.clear();greetingResetFrames.clear();
  favoriteReceiptFrames.clear();
  $('#direct-result').hidden=true;$('#direct-result').replaceChildren();
  try{
    await withBusyState(setBusy,async()=>{
      const permissions=chatEntryOnly?[]:readMode==='foreground'||direct?['clipboardRead']:[];
      const allowed=await chrome.permissions.request({permissions,origins:['https://www.zhipin.com/*','https://zhipin.com/*']});
      if(!allowed)throw Error(readMode==='foreground'?'请授权 BOSS 页面和剪贴板访问。':'请授权 BOSS 页面访问。');
      if(!chatEntryOnly)await chrome.storage.local.set({selectedReadMode:readMode});
      await navigator.locks.request('hrm-collector',{ifAvailable:true},async lock=>{
        if(!lock)throw Error('另一个采集窗口正在运行。');
        const currentTab=await guardTab();
        session.monitor=createPaymentMonitor({browser:chrome,tabId,
          onPayment:()=>session.interrupt(Object.assign(Error(PAYMENT_STOP_MESSAGE),{code:'payment-stop'})),
          onError:error=>session.interrupt(error)});
        await session.monitor.start();check();
        copyViewport=createCopyViewportController({browser:chrome,tab:currentTab,check});
        if(chatEntryOnly){
          await stopCanvasTracker();
          await run({chatEntryOnly:true});
        }else if(direct){
          await stopCanvasTracker();
          await evaluateCurrent();
        }else await trackCanvasDuring(()=>run({chatEntryOnly}));
      });
    });
  }catch(error){say((session.error||error).message,session.error?'error':stopped?'ready':'error');}
  finally{
    session.monitor?.stop();await stopFavoriteReceipts();await copyViewport?.restore();copyViewport=null;
    running=false;directRunning=false;if(activeWork===session)activeWork=null;
  }
}
$('#start').addEventListener('click',()=>startWork(false));
$('#backfill-chat').addEventListener('click',()=>startWork(false,true));
$('#evaluate-current').addEventListener('click',()=>startWork(true));
$('#job').addEventListener('change',()=>{$('#direct-result').hidden=true;$('#direct-result').replaceChildren();showSearchConditions();applyCollectionPolicy();});
for(const id of ['share',...policyFields])$('#'+id).addEventListener('change',rememberCollectionPolicy);

$('#review-retry').addEventListener('click',()=>reviewAction?.('retry'));
function stopApplyingConditions(){
  if(!applyingSearch)return;
  searchCommand('stop').catch(()=>{});
  recommendationCommand('stop').catch(()=>{});
}
$('#stop').addEventListener('click',()=>{stopped=true;reviewAction?.('stop');wakeWait?.();exec('stop').catch(()=>{});stopApplyingConditions();stopGreetings();stopFavoriteReceipts();say('正在停止…');});
addEventListener('beforeunload',()=>{stopped=true;activeWork?.monitor?.stop();reviewAction?.('stop');wakeWait?.();if(running){exec('stop').catch(()=>{});stopApplyingConditions();stopGreetings();stopFavoriteReceipts();copyViewport?.restore();stopCanvasTracker().catch(()=>{});}});

(async()=>{
  base=await loadWorkbenchOrigin();
  $('#workbench-link').href=base+'/';
  if(!await hasWorkbenchPermission(base))throw Error('请从插件入口点击“连接工作台”，允许访问工作台后重新打开此窗口。');
  if(!isLoopbackWorkbench(base)){
    policyStorageKey+=':'+base;selectedJobKey+=':'+base;
  }
  const state=await call('/api/state');
  assertWorkbenchPaired(state,chrome.runtime.id);token=state.token;
  chatEntryAvailable=state.boss_chat_entry_version===1;
  greetingAvailable=state.greeting_version===1;
  if(state.capture_version!==1||state.collection_status_version!==1||state.screening_version!==2||state.colleague_share_version!==2||state.direct_evaluation_version!==1||state.collection_rollback_version!==1||state.collection_policy_version!==1)throw Error('工作台版本过旧，请重启工作台后重新打开采集窗口。');
  const stored=await chrome.storage.local.get([selectedJobKey,policyStorageKey]);
  const selectedJob=stored[selectedJobKey];
  const storedPolicies=stored[policyStorageKey];
  if(storedPolicies&&typeof storedPolicies==='object'&&!Array.isArray(storedPolicies))collectionPolicies={...storedPolicies};
  // The visible Canvas reader has been retired. Old stored preferences are
  // ignored; the only bundled read-mode control is the foreground value.
  readMode=selectedReadMode();
  $('#job').replaceChildren(...state.jobs.map(job=>{
    const option=document.createElement('option');option.value=job.id;option.textContent=job.title;return option;
  }));
  if(state.jobs.some(job=>String(job.id)===String(selectedJob)))$('#job').value=selectedJob;
  configuredJobs=state.jobs;showSearchConditions();applyCollectionPolicy();
  if(directEntry){
    document.title='当前简历评估 · HRM';
    $('#collector-title').textContent='当前简历评估';$('#collector-subtitle').textContent='HRM · 读取已打开的简历，直接评估';
    $('#settings-heading').textContent='评估设置';$('#mode-badge').textContent='当前单份简历';
    for(const id of ['batch-limit','batch-options','collection-mode-help','batch-results','start','backfill-chat','backfill-help'])$('#'+id).hidden=true;
    $('#evaluate-current').className='primary-button';
    $('#collector-guidance').textContent='请保持 BOSS 标签页选中，并保留当前简历和本窗口。每轮只复制一次，最多自动展开一处；未复制完整时请手动检查后重试。按本次复制的简历评估；修改原文后请重新评估。关闭本窗口后不保留评估结果。';
  }
  if(!state.configured)throw Error('请先在工作台配置 AI 模型，采集将先评估再决定是否保存。');
  await guardTab();ready=true;setBusy(false);say(directEntry?'已连接。请在 BOSS 打开一份简历，选择岗位后点击「评估当前简历」。':'已连接。可从候选人列表开始采集，或直接评估当前已打开的简历。','ready');
})().catch(error=>say('连接失败：'+error.message,'error'));
