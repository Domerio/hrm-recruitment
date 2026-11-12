import {isBoss} from './capture-utils.mjs';

const open = document.querySelector('#open-collector');
document.querySelector('#extension-id').value = chrome.runtime.id;
open.addEventListener('click', async () => {
  open.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!isBoss(tab?.url)) throw Error('请在 BOSS 候选人列表页打开插件。');
    const url = chrome.runtime.getURL('collector.html') + '?tab=' + tab.id;
    await chrome.windows.create({url,type:'popup',width:640,height:820});
    window.close();
  } catch (error) {
    const status = document.querySelector('#status');
    status.textContent = error.message;
    status.dataset.state = 'error';
    open.disabled = false;
  }
});
