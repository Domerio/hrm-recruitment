import {createPassiveCapture, PASSIVE_PERMISSION} from './passive-network.mjs';

const rawTab = new URLSearchParams(location.search).get('tab');
const tabId = rawTab !== null && /^\d+$/.test(rawTab) ? Number(rawTab) : -1;
const $ = selector => document.querySelector(selector);
let capture = null, starting = false, closed = false, startGeneration = 0;
const stopMessages = {manual:'已停止记录。', timeout:'已记录 5 分钟并自动停止。',
  tab_closed:'BOSS 标签页已关闭，记录结束。', left_boss:'目标标签页已离开 BOSS，记录结束。',
  listener_error:'记录发生错误，已停止并移除监听。', start_error:'未能开始记录，已移除监听。'};

function status(message, kind='ready') {
  $('#status').textContent = message;
  $('#status').dataset.state = kind;
}
function controls() {
  $('#start').disabled = starting || Boolean(capture?.active);
  $('#stop').disabled = !starting && !capture?.active;
  $('#copy').disabled = !capture?.snapshot().length;
}
function addText(parent, label, value) {
  const p = document.createElement('p'), strong = document.createElement('strong'), code = document.createElement('code');
  strong.textContent = label; code.textContent = String(value); p.append(strong, ' ', code); parent.append(p);
}
function render(records=[]) {
  const box = $('#results'); box.replaceChildren();
  if (!records.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = '暂无记录。开始后在 BOSS 正常打开聊天；需要发送消息时请自行操作。'; box.append(empty);
  }
  for (const record of [...records].reverse()) {
    const article = document.createElement('article'), heading = document.createElement('h3');
    article.className = 'record';
    const kind = record.kind === 'address_bar' ? '地址栏观察（未验证可复用）' :
      record.type === 'websocket_handshake' ? 'WebSocket 握手' : record.method;
    heading.textContent = `${new Date(record.time).toLocaleTimeString('zh-CN')}  ${kind}  ${record.endpoint}`;
    article.append(heading);
    if (record.kind === 'request') addText(article, '结果：', `${record.status ?? '待完成'} / ${record.outcome}`);
    addText(article, '参数名称：', record.query_keys.join(', ') || '无');
    for (const item of record.ids) addText(article, `标识 ${item.field}：`, item.value);
    if (record.fragment_route) {
      addText(article, '页内路由：', record.fragment_route.path);
      addText(article, '路由参数名称：', record.fragment_route.query_keys.join(', ') || '无');
      for (const item of record.fragment_route.ids) addText(article, `路由标识 ${item.field}：`, item.value);
    }
    box.append(article);
  }
  controls();
  if (capture?.active) status(`正在记录，已保留最近 ${records.length} 条。请在目标 BOSS 标签页正常打开聊天。`);
}
function stop(reason='manual') {
  startGeneration++; starting = false;
  capture?.stop(reason); controls();
  if (!closed) status(stopMessages[reason] || '记录已结束。', reason.includes('error') ? 'error' : 'done');
}
async function start() {
  if (starting || capture?.active || closed) return;
  starting = true; const generation = ++startGeneration; controls();
  try {
    if (!Number.isInteger(tabId) || tabId < 0) throw Error('缺少目标 BOSS 标签页。');
    // Called directly in the button gesture, before any await.
    const permissionRequest = chrome.permissions.request(PASSIVE_PERMISSION);
    if (!await permissionRequest) throw Error('未获网络记录权限，未开始记录。');
    if (closed || generation !== startGeneration) return;
    const tab = await chrome.tabs.get(tabId);
    if (closed || generation !== startGeneration) return;
    if (!capture) capture = createPassiveCapture({api:chrome, tabId, onChange:render,
      onStop:reason => { controls(); if (!closed) status(stopMessages[reason] || '记录已结束。', reason.includes('error') ? 'error' : 'done'); }});
    capture.start(tab.url);
    status('正在被动记录。请在目标 BOSS 标签页打开聊天；只有实际发送动作才能产生发送接口记录。');
  } catch (error) {
    capture?.stop('start_error');
    if (!closed && generation === startGeneration) status(`无法开始记录：${error.message}`, 'error');
  } finally {
    if (generation === startGeneration) starting = false;
    controls();
  }
}

$('#start').addEventListener('click', () => { void start(); });
$('#stop').addEventListener('click', () => stop());
$('#clear').addEventListener('click', () => { capture?.clear(); if (!capture) render(); });
$('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify({captured_at:new Date().toISOString(),
      capture_method:'passive_webRequest', tab_scoped:true,
      limitations:'仅网络元数据与已观察地址栏；无请求/响应正文、请求头或 WebSocket 帧；地址栏记录不证明永久深链。',
      records:capture?.snapshot() || []}, null, 2));
    status('已复制筛选后的记录。地址栏观察仍需重新打开验证。', 'done');
  } catch (error) { status(`复制失败：${error.message}`, 'error'); }
});
window.addEventListener('pagehide', () => { closed = true; stop('pagehide'); });
window.addEventListener('error', () => stop('listener_error'));
window.addEventListener('unhandledrejection', () => stop('listener_error'));
render();
