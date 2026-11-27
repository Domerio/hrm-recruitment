import {isBoss} from './capture-utils.mjs';
import {loadWorkbenchOrigin,ensureWorkbenchPermission,assertWorkbenchPaired} from './workbench-connection.mjs';

const open = document.querySelector('#open-collector');
const current = document.querySelector('#open-current');
const networkInspector = document.querySelector('#open-network-inspector');
const communications = document.querySelector('#open-communications');
const favoriteFinder = document.querySelector('#open-favorite-finder');
document.querySelector('#extension-id').value = chrome.runtime.id;
const connect = document.querySelector('#connect-workbench');
const workbenchLink = document.querySelector('#open-workbench');
const workbenchAddress = document.querySelector('#workbench-origin');
const connectedActions = [open,current,favoriteFinder,communications,connect].filter(Boolean);
let workbenchOrigin = null;
connectedActions.forEach(button => { button.disabled = true; });
const version = chrome.runtime.getManifest?.().version;
if (version) document.querySelector('.extension-version').textContent = version;
function showStatus(message,state='error'){
  const status=document.querySelector('#status');
  status.textContent=message;
  status.dataset.state=state;
}
void loadWorkbenchOrigin().then(origin=>{
  workbenchOrigin=origin;
  workbenchAddress.value=origin;
  workbenchLink.href=origin+'/';
  workbenchLink.removeAttribute('aria-disabled');
  connectedActions.forEach(button => { button.disabled = false; });
}).catch(error=>{
  workbenchAddress.value='地址读取失败';
  showStatus(error.message);
});
connect.addEventListener('click',async()=>{
  connect.disabled=true;
  try{
    await ensureWorkbenchPermission(workbenchOrigin);
    showStatus('正在连接工作台…','working');
    let response;
    try{
      response=await fetch(workbenchOrigin+'/api/state',{
        cache:'no-store',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(8000),
      });
    }catch{
      throw Error('暂时无法连接此工作台。首次使用请将下方扩展 ID 复制到工作台“连接与集成”中授权，再重试；已授权时请确认工作台服务已启动且当前电脑能访问该地址。');
    }
    if(!response.ok)throw Error('工作台暂未允许此插件连接。请将下方扩展 ID 复制到工作台“连接与集成”中授权后重试。');
    const state=await response.json();
    assertWorkbenchPaired(state,chrome.runtime.id);
    showStatus('已连接工作台。可返回 BOSS 页面开始采集或查看沟通记录。','ready');
  }catch(error){
    showStatus(error.message);
  }finally{
    connect.disabled=!workbenchOrigin;
  }
});
async function launch(direct){
  open.disabled = current.disabled = true;
  try {
    await ensureWorkbenchPermission(workbenchOrigin);
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!isBoss(tab?.url)) throw Error(direct?'请在 BOSS 打开一份简历后使用此入口。':'请在 BOSS 候选人列表页打开插件。');
    const url = chrome.runtime.getURL('collector.html') + '?tab=' + tab.id + (direct?'&mode=current':'');
    await chrome.windows.create({url,type:'popup',width:640,height:820});
    window.close();
  } catch (error) {
    const status = document.querySelector('#status');
    status.textContent = error.message;
    status.dataset.state = 'error';
    open.disabled = current.disabled = false;
  }
}
open.addEventListener('click',()=>launch(false));
current.addEventListener('click',()=>launch(true));
favoriteFinder?.addEventListener('click',async()=>{
  favoriteFinder.disabled=true;
  try{
    await ensureWorkbenchPermission(workbenchOrigin);
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const currentUrl=new URL(tab?.url||'about:blank');
    if(currentUrl.origin!=='https://www.zhipin.com'||currentUrl.pathname.replace(/\/$/,'')!=='/web/chat/interaction')
      throw Error('请先打开 BOSS「互动 → 收藏牛人」页，再使用定位入口。');
    const launch=[...crypto.getRandomValues(new Uint8Array(16))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    await chrome.storage.session.set({['favoriteFinderLaunch:'+launch]:{tabId:tab.id,created:Date.now()}});
    await chrome.windows.create({url:chrome.runtime.getURL('favorite-finder.html')+'?launch='+launch,type:'popup',width:720,height:760});
    window.close();
  }catch(error){
    document.querySelector('#status').textContent=error.message;
    document.querySelector('#status').dataset.state='error';
    favoriteFinder.disabled=false;
  }
});
networkInspector.addEventListener('click',async()=>{
  networkInspector.disabled=true;
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!isBoss(tab?.url))throw Error('请先切换到 BOSS 页面，再打开网络检查。');
    await chrome.windows.create({url:chrome.runtime.getURL('network-inspector.html')+'?tab='+tab.id,type:'popup',width:760,height:760});
    window.close();
  }catch(error){
    const status=document.querySelector('#status');
    status.textContent=error.message;
    status.dataset.state='error';
    networkInspector.disabled=false;
  }
});
communications?.addEventListener('click',async()=>{
  communications.disabled=true;
  try{
    await ensureWorkbenchPermission(workbenchOrigin);
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!isBoss(tab?.url))throw Error('请先切换到 BOSS 沟通页面。');
    await chrome.windows.create({url:chrome.runtime.getURL('communications.html')+'?tab='+tab.id,type:'popup',width:720,height:820});
    window.close();
  }catch(error){
    const status=document.querySelector('#status');
    status.textContent=error.message;
    status.dataset.state='error';
    communications.disabled=false;
  }
});
