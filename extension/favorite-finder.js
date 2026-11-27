import {favoriteLocatorAction} from './favorite-locator.mjs';
import {createFavoriteLookup,finderParameters,validFavoriteTarget,interactionUrl,FAVORITES_URL} from './favorite-finder-controller.mjs';
import {loadWorkbenchOrigin,hasWorkbenchPermission,ensureWorkbenchPermission} from './workbench-connection.mjs';

const $=selector=>document.querySelector(selector);
let workbenchOrigin='',ready=false;
let token='',target=null,lookup=null,tabId=null,sourceTabId=null,createdTabId=null,busy=false,closed=false,generation=0,requestController=null;
const status=(text,state='ready')=>{$('#status').textContent=text;$('#status').dataset.state=state;};
const controls=()=>{$('#load').disabled=!ready||busy;$('#candidate-id').disabled=!ready||busy;$('#start').disabled=!ready||busy||!target;$('#stop').disabled=!busy;};
const current=id=>!closed&&id===generation;
function invalidateTarget(){
  if(busy||closed)return;
  generation++;target=null;
  $('#target').textContent='候选人编号已修改，请先读取档案';
  status('请先点击「读取档案」，核对候选人后再开始定位。');
  controls();
}

async function call(path,data){
  const controller=new AbortController();requestController=controller;
  const timeout=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(workbenchOrigin+path,{cache:'no-store',signal:controller.signal,...(data?{method:'POST',
      headers:{'Content-Type':'application/json','X-App-Token':token},body:JSON.stringify(data)}:{})});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'工作台连接失败，请刷新工作台后重试。');
    return result;
  }finally{clearTimeout(timeout);if(requestController===controller)requestController=null;}
}

async function loadTarget({requestPermission=false}={}){
  if(!ready||busy||closed)return;
  const raw=$('#candidate-id').value.trim();
  if(!/^[1-9]\d{0,14}$/.test(raw)||!Number.isSafeInteger(Number(raw)))return status('请输入有效的工作台候选人编号。','error');
  const id=++generation;busy=true;target=null;controls();
  try{
    // Request immediately from the click handler, before any awaited work.
    const permission=requestPermission?ensureWorkbenchPermission(workbenchOrigin):hasWorkbenchPermission(workbenchOrigin);
    if(!await permission)throw Error('请点击“连接并读取档案”，允许访问工作台后继续。');
    if(!current(id))return;
    $('#load').textContent='读取档案';
    status('正在读取候选人档案…');
    // Chromium omits Origin on some extension GETs. A JSON POST carries the
    // browser-generated Origin required by the paired-extension bootstrap.
    const state=await call('/api/extension/favorite-session',{});if(!current(id))return;
    if(state.extension_id!==chrome.runtime.id||state.favorite_locator_version!==1)
      throw Error('请先在工作台「连接与集成」配对此扩展，并更新工作台后再定位。');
    token=state.token;
    const data=await call('/api/extension/favorite-target',{id:Number(raw)});if(!current(id))return;
    if(!data.ok||!validFavoriteTarget(data.target,Number(raw)))throw Error('候选人定位资料无效，请刷新工作台后重试。');
    target=data.target;
    $('#target').textContent=`${target.name} · ${target.job_title||'关联岗位'} · #${target.id}`;
    status(target.boss_chat_uid||target.platform_geek_id?'档案已读取，优先按平台标识查找。':'档案已读取，将核对姓名与职业经历；无法唯一对应时会暂停。');
  }catch(error){if(current(id)){status(error.message,'error');$('#target').textContent='未读取候选人档案';}}
  finally{if(current(id)){busy=false;controls();}}
}

async function start(){
  if(busy||!target||closed)return;
  if(String(target.id)!==$('#candidate-id').value.trim()){invalidateTarget();return;}
  const id=++generation;busy=true;controls();
  $('#diagnostics-box').hidden=true;$('#diagnostics').textContent='';
  try{
    const permitted=await chrome.permissions.contains({origins:['https://www.zhipin.com/*']});if(!current(id))return;
    if(sourceTabId!==null){
      const source=await chrome.tabs.get(sourceTabId);if(!current(id))return;
      const url=new URL(source.url);
      if(url.origin!=='https://www.zhipin.com'||url.pathname.replace(/\/$/,'')!=='/web/chat/interaction')
        throw Error('请在 BOSS「互动 → 收藏牛人」页打开扩展定位入口。');
      tabId=sourceTabId;
      await chrome.tabs.update(tabId,{active:true});if(!current(id))return;
    }else{
      if(!permitted)throw Error('尚未授权读取 BOSS。请在 BOSS「互动 → 收藏牛人」页点击扩展的「定位收藏牛人」，输入此候选人编号后开始。');
      let previous=null;
      if(createdTabId!==null)try{previous=await chrome.tabs.get(createdTabId);}catch{/* The owned tab was closed. */}
      if(!current(id))return;
      if(previous&&interactionUrl(previous.url)){
        tabId=previous.id;
        await chrome.tabs.update(tabId,{active:true});if(!current(id))return;
      }else{
        const created=await chrome.tabs.create({url:FAVORITES_URL,active:true});
        createdTabId=tabId=created.id;
        if(!current(id))return;
      }
    }
    $('#show-tab').hidden=false;
    lookup=createFavoriteLookup({api:chrome,action:favoriteLocatorAction,target,tabId,
      onProgress:value=>{if(current(id)){
        status(value.text);
        const d=value.diagnostics;
        if(d){
          const safe=Object.fromEntries(Object.entries(d).filter(([key])=>[
            'root_count','card_count','name_label_count','target_work_row_counts','version','name_paths','target_name_paths','target_ancestors','classes','tabs','tab_count','account_available',
            'target_match_reasons','company_matches','school_matches','dated_company_matches','target_row_structures','target_work_rows','target_components',
          ].includes(key)));
          $('#diagnostics-box').hidden=false;$('#diagnostics').textContent=JSON.stringify(safe,null,2).slice(0,8000);
        }
      }}});
    const result=await lookup.run();if(!current(id))return;
    let bindingMessage='';
    const located=result.status==='located'&&result.card_visible===true&&Boolean(result.verified);
    if(located&&target.input_key){
      try{
        await call('/api/extension/favorite-binding',{id:target.id,input_key:target.input_key,...result.verified});
        if(!current(id))return;
        bindingMessage=' 对应标识已保存，下次可优先按标识定位。';
      }catch(error){if(!current(id))return;bindingMessage=` 定位已完成，但对应标识未保存：${error.message}`;}
    }
    const messages={located:'已核验对应候选人，并在 BOSS 收藏列表中滚动、高亮其卡片。可在该卡片点击「联系Ta」或「继续沟通」。',
      opened_unverified:'已打开可能对应的简历，但身份尚未完成核验，未确认收藏卡片定位成功。请在 BOSS 核对姓名、公司和学校。',
      not_found:'当前收藏列表未找到能够唯一对应的候选人。请检查招聘账号和筛选条件；未发送消息。',
      limit:'已达到本次查找范围，尚未找到唯一匹配。请缩小 BOSS 收藏筛选范围后重新定位。'};
    status((result.status==='located'&&!located?'尚未确认对应收藏卡片已显示，定位未完成。':messages[result.status]||'定位已结束。')+bindingMessage,located?'done':'ready');
  }catch(error){if(current(id))status(error.message,'error');}
  finally{if(current(id)){lookup?.stop();lookup=null;busy=false;controls();}}
}

function stop(){generation++;requestController?.abort();lookup?.stop();lookup=null;busy=false;if(!closed){status('已停止定位，未发送消息。');controls();}}
$('#load').addEventListener('click',()=>void loadTarget({requestPermission:true}));
$('#candidate-id').addEventListener('input',invalidateTarget);
$('#start').addEventListener('click',()=>void start());
$('#stop').addEventListener('click',stop);
$('#show-tab').addEventListener('click',async()=>{if(tabId!==null)try{await chrome.tabs.update(tabId,{active:true});}catch{status('查找标签页已关闭。','error');}});
window.addEventListener('pagehide',()=>{closed=true;stop();});
window.addEventListener('beforeunload',()=>{closed=true;stop();});

try{
  workbenchOrigin=await loadWorkbenchOrigin();
  const params=finderParameters(location.search,workbenchOrigin);
  $('#workbench').href=workbenchOrigin+'/';
  if(params.launch){
    const key='favoriteFinderLaunch:'+params.launch;
    const entry=(await chrome.storage.session.get(key))[key];
    await chrome.storage.session.remove(key);
    if(!entry||!Number.isInteger(entry.tabId)||Date.now()-entry.created>300000||Date.now()<entry.created)
      throw Error('BOSS 定位入口已过期，请从扩展重新打开。');
    sourceTabId=entry.tabId;
  }
  const permitted=await hasWorkbenchPermission(workbenchOrigin);
  ready=true;controls();
  if(!permitted)$('#load').textContent='连接并读取档案';
  if(params.candidateId){
    $('#candidate-id').value=String(params.candidateId);
    if(!permitted){
      $('#target').textContent='请先允许插件连接当前工作台';
      status('点击“连接并读取档案”，在浏览器提示中允许访问 '+workbenchOrigin+'。');
    }else await loadTarget();
    // A workbench candidate link is the user's locate action. Manual popup
    // entry still waits for Start, and a later archive reload never auto-runs.
    if(!params.launch&&target?.id===params.candidateId&&!closed)await start();
  }
  else{$('#target').textContent='请填写工作台候选人编号';status('可在候选人详情或收藏定位入口查看对应编号。');}
}catch(error){ready=false;status(error.message,'error');$('#target').textContent='定位入口不可用';controls();}
