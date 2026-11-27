import {isBoss} from './capture-utils.mjs';
import {loadWorkbenchOrigin,hasWorkbenchPermission,isLoopbackWorkbench,assertWorkbenchPaired} from './workbench-connection.mjs';
import {selectCommunicationRows} from './communications-reader.mjs';
import {collectChatResumes} from './chat-collection.mjs';
import {createPaymentMonitor,PAYMENT_STOP_MESSAGE} from './payment-stop.mjs';
import {readCommunicationSnapshot} from './read-communication-snapshot.mjs';
import {resolveChatJob} from './chat-job-matching.mjs';

let base = '', accountStorageKey = 'communicationsAccount';
const tabId = Number(new URLSearchParams(location.search).get('tab'));
const $ = selector => document.querySelector(selector);
let token = '', snapshot = null, ready = false, busy = false;
let selectedFriends = new Set();
let collecting=false,stopped=false,runAbort=null;
let localJobs=[],jobMappings=[],jobResolution=null,confirmedJob=null,jobContext='',snapshotRevision=0;
const progressRows=new Map();
const platformKey = conversation => conversation.platform_job_id ? 'job:' + conversation.platform_job_id : 'unknown';
const filteredConversations = () => (snapshot?.conversations || []).filter(row => platformKey(row) === $('#platform-scope').value);

function status(message, state = 'ready') {
  $('#status').textContent = message;
  $('#status').dataset.state = state;
}
function controls() {
  const inputHelp=$('#input-help');
  if(inputHelp)inputHelp.hidden=!collecting;
  $('#read').disabled = busy || !ready;
  $('#import').disabled = busy || !snapshot || !selectedFriends.size || !jobResolution?.ok || !$('#account-id').value.trim();
  $('#collect').disabled = busy || !ready || !snapshot || !selectedFriends.size || !jobResolution?.ok || !$('#account-id').value.trim();
  $('#stop-collection').disabled = !collecting;
  for (const key of ['job-confirm', 'account-id', 'account-name', 'platform-scope']) $('#' + key).disabled = busy;
  $('#confirm-job').disabled=busy||$('#job-confirmation').hidden||!$('#job-confirm').value;
  for(const key of ['collect-limit','collect-online','collect-attachments','evaluate-resumes'])$('#'+key).disabled=busy;
  for (const input of document.querySelectorAll('[data-friend-select]')) input.disabled = busy;
}
function jobRows(){
  const rows=filteredConversations();
  return $('#platform-scope').value==='unknown'?rows.filter(row=>selectedFriends.has(row.friend_id)):rows;
}
function synchronizeJob(){
  const rows=jobRows(),account_id=$('#account-id').value.trim();
  const context=JSON.stringify([snapshotRevision,account_id,$('#platform-scope').value,
    rows.map(row=>[row.friend_id,row.platform_job_id||'',row.platform_job_title||''])]);
  if(context!==jobContext){jobContext=context;confirmedJob=null;$('#job-confirm').value='';}
  jobResolution=null;$('#job').value='';$('#job-confirmation').hidden=true;
  if(!snapshot||!rows.length){
    $('#job-name').textContent=snapshot?'请选择一组沟通职位及会话':'读取聊天后自动匹配';
    $('#job-name').dataset.state='pending';
    $('#job-match-note').textContent='根据沟通职位和已确认的岗位对应关系自动归档。';return;
  }
  if(!account_id||/\s|^https?:/i.test(account_id)){
    $('#job-name').textContent='请先填写招聘账号标识';$('#job-name').dataset.state='pending';
    $('#job-match-note').textContent='填写固定账号标识后，自动核对该账号的岗位对应关系。';return;
  }
  jobResolution=confirmedJob?.context===context?confirmedJob.resolution:
    resolveChatJob({jobs:localJobs,conversations:rows,account_id,mappings:jobMappings});
  if(jobResolution.ok){
    $('#job').value=String(jobResolution.job_id);$('#job-name').textContent=jobResolution.job_title;
    $('#job-name').dataset.state='matched';
    const source=jobResolution.platform_job_title||'已识别的平台岗位';
    $('#job-match-note').textContent=`BOSS 沟通职位：${source} → 工作台：${jobResolution.job_title}。`+
      (jobResolution.method==='confirmed'?'本次对应关系已确认。':jobResolution.method==='history'?'已自动沿用该账号的岗位对应关系。':'已按岗位名称自动匹配。');
  }else{
    $('#job-name').textContent='岗位待确认';$('#job-name').dataset.state='unmatched';
    $('#job-match-note').textContent=jobResolution.error||'未能唯一匹配工作台岗位，请确认一次对应关系。';
    $('#job-confirmation').hidden=false;
  }
}
function currentJobBinding(){
  synchronizeJob();
  if(!jobResolution?.ok)throw Error(jobResolution?.error||'请先读取沟通职位并确认岗位对应关系。');
  return {job_id:jobResolution.job_id,account_id:$('#account-id').value.trim(),
    platform_job_id:jobResolution.platform_job_id||'',platform_job_title:jobResolution.platform_job_title||'',method:jobResolution.method};
}
async function call(path, data, signal) {
  const response = await fetch(base + path, data ? {
    method:'POST', headers:{'Content-Type':'application/json', 'X-App-Token':token}, body:JSON.stringify(data),signal,
  } : {cache:'no-store'});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '工作台请求失败，请刷新工作台后重试。');
  return result;
}
function renderProgress(summary){
  let row=progressRows.get(summary.friend_id);
  if(!row){row=document.createElement('li');progressRows.set(summary.friend_id,row);$('#collection-results').append(row);}
  row.replaceChildren();
  const title=document.createElement('strong');title.textContent=summary.name;row.append(title);
  const result=document.createElement('p');
  result.textContent=`附件 ${summary.attachments} 份 · 在线简历 ${summary.online} 份`+
    (summary.complete?(summary.attachments+summary.online?' · 已归档':' · 未获取'):' · 处理中');row.append(result);
  for(const source of summary.resumes){
    const line=document.createElement('p');
    line.textContent=(source.source_kind==='attachment'?'附件':'在线简历')+' · '+
      (Number.isFinite(source.evaluation?.score)?`匹配度 ${source.evaluation.score} 分`:
        source.evaluation_status==='not_requested'?'原文已归档，未评估':'原文已归档，AI 待评估');
    row.append(line);
  }
  if(summary.issues.length){const items=document.createElement('ul');for(const issue of new Set(summary.issues)){
    const item=document.createElement('li');item.textContent=issue;items.append(item);
  }row.append(items);}
}

async function collectResumes(){
  if(busy||!snapshot||!selectedFriends.size)return;
  const account_id=$('#account-id').value.trim(),account_name=$('#account-name').value.trim();
  const options={attachments:$('#collect-attachments').checked,online:$('#collect-online').checked,
    evaluate:$('#evaluate-resumes').checked,limit:Number($('#collect-limit').value)};
  let selection;
  try{
    const rows=selectCommunicationRows(snapshot,selectedFriends);
    const binding=currentJobBinding(),job_id=binding.job_id;
    if(!Number.isSafeInteger(job_id)||job_id<=0||!account_id||/\s|^https?:/i.test(account_id))throw Error('请确认归档岗位及招聘账号标识。');
    if(!options.attachments&&!options.online)throw Error('请至少选择附件简历或在线简历。');
    if(!Number.isInteger(options.limit)||options.limit<1||options.limit>100||rows.conversations.length>options.limit)
      throw Error('勾选会话数不能超过本次人数上限，上限可设为 1 到 100 人。');
    selection={job_id,account_id,account_name,job_binding:binding,conversations:rows.conversations};
  }catch(error){status(error.message,'error');return;}
  collecting=busy=true;stopped=false;runAbort=new AbortController();controls();
  let stopReason='',paymentMonitor;
  const check=()=>{if(stopped)throw Error(stopReason||'已停止聊天简历采集。');};
  const stopCollection=reason=>{
    if(stopped)return;
    stopReason=reason;stopped=true;runAbort.abort();
    status(reason,'warning');
  };
  progressRows.clear();$('#collection-results').replaceChildren();$('#collection-progress').hidden=false;
  try{
    const origins=['https://www.zhipin.com/*','https://zhipin.com/*'];
    if(options.attachments)origins.push('https://docdownload.zhipin.com/*');
    const allowed=await chrome.permissions.request({origins,permissions:options.online?['clipboardRead']:[]});
    check();if(!allowed)throw Error('需要允许 BOSS 页面访问及所选简历读取权限。');
    await chrome.storage.local.set({[accountStorageKey]:{id:account_id,name:account_name}});
    await navigator.locks.request('hrm-collector',{ifAvailable:true},async lock=>{
      if(!lock)throw Error('另一个采集窗口正在运行，请结束后重试。');
      check();
      paymentMonitor=createPaymentMonitor({browser:chrome,tabId,
        onPayment:()=>stopCollection(PAYMENT_STOP_MESSAGE),onError:error=>stopCollection(error.message)});
      await paymentMonitor.start();
      const checkPayment=async()=>{check();await paymentMonitor.checkNow();check();};
      const result=await collectChatResumes({browser:chrome,tabId,selection,options,check,
        clipboard:navigator.clipboard,checkPayment,
        api:async(path,data)=>{
          await checkPayment();
          const result=await call(path,data,runAbort.signal);
          check();return result;
        },
        report:message=>{check();status(message,'running');},
        onProgress:summary=>{check();renderProgress(summary);}});
      check();
      const total=result.reduce((counts,row)=>({attachments:counts.attachments+row.attachments,online:counts.online+row.online}),{attachments:0,online:0});
      if(!total.attachments&&!total.online)
        status('本次未获取到简历，请查看下方各会话的原因；没有新增简历归档。','warning');
      else status(`采集完成，处理 ${result.length} 个会话，归档附件 ${total.attachments} 份、在线简历 ${total.online} 份。原文及评估结果可在工作台“沟通记录”查看。`,'done');
    });
  }catch(error){status(stopReason||(stopped?'已停止。已经提交的原文和评估请求会保留，未继续打开下一会话。':error.message),stopReason?'warning':stopped?'ready':'error');}
  finally{paymentMonitor?.stop();collecting=busy=false;runAbort=null;controls();}
}
function appendRow(parent, values) {
  const row = document.createElement('tr');
  for (const value of values) {
    const cell = document.createElement('td');
    if (value instanceof Node) cell.append(value);
    else cell.textContent = value;
    row.append(cell);
  }
  parent.append(row);
}
function render() {
  synchronizeJob();
  $('#preview').hidden = !snapshot;
  for (const key of ['conversations', 'messages', 'warnings']) $('#' + key).replaceChildren();
  if (!snapshot) return;
  updateSummary();
  for (const warning of snapshot.warnings || []) {
    const item = document.createElement('li'); item.textContent = warning; $('#warnings').append(item);
  }
  for (const row of filteredConversations()) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.dataset.friendSelect = row.friend_id;
    checkbox.setAttribute('aria-label', '导入 ' + row.candidate_name + ' 的会话');
    checkbox.checked = selectedFriends.has(row.friend_id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!row.platform_job_id) {
          selectedFriends.clear();
          for (const other of document.querySelectorAll('[data-friend-select]')) other.checked = other === checkbox;
        }
        selectedFriends.add(row.friend_id);
      } else selectedFriends.delete(row.friend_id);
      render(); controls();
    });
    appendRow($('#conversations'), [checkbox, row.candidate_name || '未提供姓名', row.friend_id,
      row.unread_count === null ? '未知' : String(row.unread_count), row.last_message || '未提供摘要']);
  }
  const labels = {incoming:'候选人', outgoing:'我方', system:'系统'};
  for (const row of snapshot.messages.filter(row => selectedFriends.has(row.friend_id))) {
    const attachment = row.kind === 'attachment' ? `附件 ${row.attachment_name || '未提供文件名'}（${{received:'已收到', pending:'待确认', expired:'已过期'}[row.attachment_status] || '待确认'}）` : '';
    appendRow($('#messages'), [labels[row.direction] || '未知', row.sent_at ? new Date(row.sent_at).toLocaleString('zh-CN') : '未提供时间', [row.text, attachment].filter(Boolean).join('\n')]);
  }
}
function updateSummary() {
  const messageCount = (snapshot?.messages || []).filter(row => selectedFriends.has(row.friend_id)).length;
  $('#summary').textContent = `已读取 ${snapshot?.conversations.length || 0} 个会话 · 已选择 ${selectedFriends.size} 个 · 待导入 ${messageCount} 条消息`;
}
function configurePlatformScopes() {
  $('#platform-scope').replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = '请选择平台岗位分组'; $('#platform-scope').append(placeholder);
  const keys = new Set(snapshot.conversations.map(platformKey));
  for (const key of keys) {
    const option = document.createElement('option'); option.value = key;
    const group=snapshot.conversations.filter(row=>platformKey(row)===key);
    const titles=[...new Set(group.map(row=>row.platform_job_title).filter(Boolean))];
    const known=resolveChatJob({jobs:localJobs,conversations:group,account_id:$('#account-id').value.trim(),mappings:jobMappings});
    option.textContent=titles.length===1?titles[0]:known.ok?known.job_title:
      key==='unknown'?'沟通职位未识别（单会话确认）':`未命名岗位 ${[...keys].indexOf(key)+1}`;
    if(titles.length>1)option.textContent+='（职位名称待核对）';
    $('#platform-scope').append(option);
  }
  const current = snapshot.conversations.find(row => row.friend_id === snapshot.selected_friend_id);
  $('#platform-scope').value = current ? platformKey(current) : '';
  selectedFriends = new Set(current ? [current.friend_id] : []);
}
async function readPage() {
  if (busy || !ready) return;
  busy = true; snapshot = null; confirmedJob=null;snapshotRevision++;selectedFriends.clear();controls();render();
  try {
    const allowed = await chrome.permissions.request({origins:['https://www.zhipin.com/*', 'https://zhipin.com/*']});
    if (!allowed) throw Error('需要允许读取 BOSS 页面，才能导入沟通记录。');
    const tab = await chrome.tabs.get(tabId);
    if (!isBoss(tab.url) || tab.discarded) throw Error('BOSS 标签页已关闭、休眠或离开平台，请从目标页面重新打开导入窗口。');
    status('正在读取会话列表及当前聊天记录…', 'running');
    ({snapshot}=await readCommunicationSnapshot({browser:chrome,tabId}));
    const mapped=await call('/api/communications/list',{});
    if(!Array.isArray(mapped.conversations))throw Error('工作台岗位对应记录无效，请刷新后重试。');
    jobMappings=mapped.conversations.map(row=>({account_id:row.account_id,platform_job_id:row.platform_job_id,job_id:row.job_id}));
    configurePlatformScopes();
    render();
    const received=snapshot.messages.filter(row=>row.kind==='attachment'&&row.direction==='incoming'&&row.attachment_status==='received').length;
    if(snapshot.message_capture?.unresolved_attachments&&snapshot.message_capture.history_loaded&&received)
      status(`已读取 ${snapshot.messages.length} 条聊天消息，确认 ${received} 个已收到附件；部分页面卡片尚未逐一对应，可采集已核验附件。`,'warning');
    else if(snapshot.message_capture?.unresolved_attachments)
      status('已读取会话列表，但页面有附件卡片尚未确认消息标识或归属，请查看下方提示。','warning');
    else if(!jobResolution?.ok)status('已读取沟通记录，请按上方提示确认岗位对应关系。','warning');
    else status(`已读取，自动归档到“${jobResolution.job_title}”。核对会话后即可导入或采集。`);
  } catch (error) { status(error.message, 'error'); }
  finally { busy = false; controls(); }
}
async function importSnapshot() {
  if (busy || !snapshot || !selectedFriends.size) return;
  const account_id = $('#account-id').value.trim();
  const account_name = $('#account-name').value.trim();
  let job_id;
  try{job_id=currentJobBinding().job_id;}catch(error){status(error.message,'error');return;}
  if (!account_id || !Number.isInteger(job_id) || job_id <= 0) return;
  if (/\s/.test(account_id) || /^https?:/i.test(account_id)) {
    status('招聘账号标识不能包含空格或使用网址，例如填写“公司-招聘人”。', 'error');
    return;
  }
  busy = true; controls();
  try {
    const rows = selectCommunicationRows(snapshot, selectedFriends);
    const result = await call('/api/communications/import', {job_id, account_id, account_name,
      ...rows});
    await chrome.storage.local.set({[accountStorageKey]:{id:account_id, name:account_name}});
    if(!result.message_count)
      status(`已导入 ${result.conversation_count} 个会话列表记录，但未读取到聊天消息；这不表示附件已获取。`,'warning');
    else status(`导入完成，${result.conversation_count} 个会话、${result.message_count} 条消息，其中新增 ${result.new_messages} 条消息。请在工作台“沟通记录”中查看。`, 'done');
    snapshot = null;
    selectedFriends.clear();
    render();
    return result;
  } catch (error) { status(error.message, 'error'); }
  finally { busy = false; controls(); }
}
async function initialize() {
  controls();
  try {
    if (!Number.isInteger(tabId) || tabId < 0) throw Error('缺少目标 BOSS 标签页，请从扩展入口打开。');
    base = await loadWorkbenchOrigin();
    $('#workbench-link').href = base + '/';
    if(!await hasWorkbenchPermission(base))throw Error('请从插件入口点击“连接工作台”，允许访问工作台后重新打开此窗口。');
    if(!isLoopbackWorkbench(base))accountStorageKey += ':' + base;
    const state = await call('/api/state');
    assertWorkbenchPaired(state, chrome.runtime.id);
    token = state.token;
    if (!state.communications_version) throw Error('当前工作台尚未支持沟通导入，请重启更新后的工作台服务。');
    if(state.chat_resume_version!==1)throw Error('工作台尚未支持聊天简历采集，请重启更新后的工作台服务。');
    localJobs=state.jobs||[];
    for (const job of localJobs) {
      const option = document.createElement('option'); option.value = job.id; option.textContent = job.title; $('#job-confirm').append(option);
    }
    if (!(state.jobs || []).length) throw Error('请先在工作台创建归档岗位，再重新打开导入窗口。');
    const saved = (await chrome.storage.local.get(accountStorageKey))[accountStorageKey];
    if (saved) { $('#account-id').value = saved.id || ''; $('#account-name').value = saved.name || ''; }
    ready = true;
    status('已连接工作台。请确认 BOSS 沟通页已选中，再读取当前页面。');
  } catch (error) { status(error.message, 'error'); }
  controls();
}
$('#read').addEventListener('click', () => void readPage());
$('#import').addEventListener('click', () => void importSnapshot());
$('#collect').addEventListener('click',()=>void collectResumes());
$('#stop-collection').addEventListener('click',()=>{stopped=true;runAbort?.abort();status('正在停止，已提交的原文和评估请求会保留…','running');});
addEventListener('beforeunload',()=>{stopped=true;runAbort?.abort();});
$('#platform-scope').addEventListener('change', () => { selectedFriends.clear(); render(); controls(); });
$('#confirm-job').addEventListener('click',()=>{
  const job=localJobs.find(row=>row.id===Number($('#job-confirm').value)),rows=jobRows();
  if(busy||!job||!rows.length||$('#job-confirmation').hidden)return;
  const ids=new Set(rows.map(row=>row.platform_job_id||'')),titles=[...new Set(rows.map(row=>row.platform_job_title||'').filter(Boolean))];
  if(ids.size!==1||ids.has('')&&rows.length!==1||titles.length>1){status('当前分组的沟通职位存在冲突，请重新读取。','error');return;}
  confirmedJob={context:jobContext,resolution:{ok:true,job_id:job.id,job_title:job.title,
    platform_job_id:[...ids][0],platform_job_title:titles[0]||'',method:'confirmed'}};
  synchronizeJob();controls();
});
$('#job-confirm').addEventListener('change',controls);
$('#account-id').addEventListener('input',()=>{confirmedJob=null;synchronizeJob();controls();});
$('#account-name').addEventListener('input',controls);
void initialize();
