// Serialized into the already logged-in BOSS tab. Keep this function self-contained.
export function readCommunicationPage() {
  const validHost = location.protocol === 'https:' && ['www.zhipin.com', 'zhipin.com'].includes(location.hostname);
  if (!validHost) return {ok:false, error:'目标页面已离开 BOSS 直聘。'};
  if (document.visibilityState === 'hidden') return {ok:false, error:'请先选中 BOSS 沟通标签页，再读取沟通记录。'};
  const pageText = (document.body?.innerText || '').slice(0, 6000);
  if (/请完成安全验证|访问过于频繁|拖动滑块|账号存在异常/.test(pageText)) {
    return {ok:false, error:'BOSS 页面需要人工处理，已停止读取。'};
  }
  const isVisible = element => element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const chatUsers = [...document.querySelectorAll('.chat-user')].filter(isVisible);
  const conversationRoots = [...document.querySelectorAll('.chat-conversation')].filter(isVisible);
  if (chatUsers.length > 1 || conversationRoots.length > 1) return {ok:false, error:'页面存在多个可见沟通区域，无法确认唯一的聊天来源。'};
  const chatUser = chatUsers[0];
  const conversationRoot = conversationRoots[0];
  if (!chatUser && !conversationRoot) return {ok:false, error:'未识别到 BOSS 沟通页面，请手动进入“沟通”后重新读取。'};

  const text = (value, limit = 3000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const id = value => {
    const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value, 161);
    return /^[A-Za-z0-9_-]{1,160}$/.test(result) && result !== '0' ? result : '';
  };
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const read = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
  const firstId = (...values) => values.map(id).find(Boolean) || '';
  const firstText = (...values) => values.map(value => text(value)).find(Boolean) || '';
  const visible = isVisible;
  const timestamp = value => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      const date = new Date(value < 1e11 ? value * 1000 : value);
      return Number.isNaN(date.valueOf()) ? '' : date.toISOString();
    }
    if (typeof value === 'string' && /^\d{10,13}$/.test(value)) return timestamp(Number(value));
    const source = text(value, 80);
    return source && !Number.isNaN(Date.parse(source)) ? new Date(source).toISOString() : '';
  };
  let jobError = '';
  const jobTitle = value => {
    if (typeof value !== 'string' || !value.trim()) return '';
    const title = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (title.length > 160 || /[\u0000-\u001f\u007f]/u.test(title)) {
      jobError = '沟通职位名称过长或格式异常，未自动匹配岗位。'; return '';
    }
    return title;
  };
  const jobReferences = new WeakMap();
  const communicationJob = raw => {
    raw = object(raw);
    const info = object(raw.jobInfo || raw.communicateJob || raw.communicationJob);
    const person = object(raw.geekInfo || raw.geek);
    // BOSS uses both a numeric jobId and an encrypted ID for the same job.
    // jobId itself can also hold the encrypted form. Preserve both claims so
    // a lower-priority field can prove an alias (or expose a real conflict).
    const generic = [raw.jobId, info.jobId, raw.platform_job_id].map(id).filter(Boolean);
    // BOSS JobContent receives conversation$: its encrypted job identifier is
    // toPositionId and its communicated title is toPosition. handleChangeJob
    // supplies these alongside numeric jobId while the list uses encryptJobId.
    const encrypted = [...new Set([raw.encryptJobId, raw.toPositionId, info.encryptJobId, info.toPositionId, info.encryptId, person.encryptJobId,
      ...generic.filter(value => !/^\d+$/.test(value))].map(id).filter(Boolean))];
    const numeric = [...new Set(generic.filter(value => /^\d+$/.test(value)))];
    const platform_job_id = encrypted[0] || numeric[0] || '';
    // Generic fields on geekInfo/expectJob describe the candidate's own work or
    // preference. Only the conversation's job container can label this job ID.
    const titles = [raw.platform_job_title, raw.toPosition, raw.communicateJobName, raw.communicateJobTitle,
      raw.communicationJobName, raw.communicationJobTitle, info.toPosition, info.jobName, info.jobTitle, info.name, info.title,
      ...(platform_job_id ? [raw.jobName, raw.jobTitle] : [])].map(jobTitle).filter(Boolean);
    if (new Set(titles).size > 1) jobError = '同一沟通职位存在不同名称，请等待 BOSS 页面稳定后重试。';
    const result = {platform_job_id, platform_job_title:titles[0] || ''};
    jobReferences.set(result, {encrypted, numeric});
    return result;
  };
  const mergeJobs = (jobs, preferred = '') => {
    const refs = jobs.map(job => jobReferences.get(job) || {encrypted:[], numeric:[]});
    const encrypted = new Set(refs.flatMap(ref => ref.encrypted));
    const numeric = new Set(refs.flatMap(ref => ref.numeric));
    if (encrypted.size > 1 || numeric.size > 1) return {conflict:true};
    // Different representations are aliases only when a record for this same
    // conversation explicitly provides both. A matching title is not proof.
    if (encrypted.size && numeric.size && !refs.some(ref => ref.encrypted.length && ref.numeric.length))
      return {unverified:true};
    return {platform_job_id:preferred || [...encrypted][0] || [...numeric][0] || '',
      references:{encrypted:[...encrypted], numeric:[...numeric]}};
  };
  const warnings = [];
  const roots = [];
  const addRoot = vm => { if (vm && typeof vm === 'object' && !roots.includes(vm)) roots.push(vm); };
  const editorInput=document.querySelector('.boss-chat-editor-input, #boss-chat-editor-input');
  for (const element of [chatUser, conversationRoot, document.querySelector('.chat-editor'),editorInput?.parentElement,
    conversationRoot?.querySelector('.chat-message-list')]) {
    const vm = read(element, '__vue__');
    addRoot(vm);
    addRoot(read(vm, '$parent'));
    const children = read(vm, '$children');
    for (const child of Array.isArray(children) ? children.slice(0, 12) : []) addRoot(child);
  }
  const values = (vm, keys) => {
    const result = [];
    for (const key of keys) {
      for (const owner of [vm, read(vm, '$data')]) {
        const item = read(owner, key);
        if (item !== undefined) result.push(item);
      }
      const observable = read(read(vm, '$observables'), key);
      const item = read(observable, '_value');
      if (item !== undefined) result.push(item);
    }
    return result;
  };
  const friendId = value => firstId(value?.friendId, value?.friend_id, value?.uid);
  const conversationFrom = raw => {
    raw = object(raw);
    const friend_id = friendId(raw);
    if (!friend_id || (raw.friendSource !== undefined && Number(raw.friendSource) !== 0)) return null;
    const person = object(raw.geekInfo || raw.geek);
    const candidate_name = firstText(raw.name, raw.geekName, person.name, person.geekName).slice(0, 120);
    if (!candidate_name) return null;
    const lastInfo = object(raw.lastMsgInfo || raw.lastMessageInfo);
    const count = [raw.unreadMsgCount, raw.newMsgCount, raw.unreadCount].find(value =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000000);
    const job = communicationJob(raw);
    const result = {
      friend_id,
      candidate_name,
      platform_geek_id:firstId(person.encryptUid, person.encryptGeekId, raw.encryptGeekId, raw.encryptUid),
      ...job,
      last_message:firstText(raw.lastMsg, raw.lastText, lastInfo.showText, lastInfo.text),
      last_at:timestamp(raw.lastTime || raw.lastTS || raw.lastMsgTime || lastInfo.msgTime),
      unread_count:count === undefined ? null : count,
    };
    jobReferences.set(result, jobReferences.get(job));
    return result;
  };
  const candidates = [];
  const listKeys = ['list$', 'allList$', 'friendList', 'list', 'dataSources'];
  for (const vm of roots) {
    for (const list of values(vm, listKeys)) {
      if (!Array.isArray(list) || !list.length) continue;
      const rows = list.slice(0, 501).map(conversationFrom).filter(Boolean);
      if (rows.length) candidates.push(rows);
    }
  }
  candidates.sort((a, b) => b.length - a.length);
  const conversations = new Map();
  for (const row of candidates[0] || []) {
    const previous = conversations.get(row.friend_id);
    if (previous && previous.candidate_name && row.candidate_name && previous.candidate_name !== row.candidate_name) {
      return {ok:false, error:'同一会话标识对应了不同姓名，请等待 BOSS 页面刷新完成后重试。'};
    }
    const merged = mergeJobs(previous ? [previous, row] : [row], previous?.platform_job_id || row.platform_job_id);
    if (merged.conflict || merged.unverified || previous &&
        previous.platform_job_title && row.platform_job_title && previous.platform_job_title !== row.platform_job_title) {
      return {ok:false, error:'同一会话对应了不同沟通职位，请等待 BOSS 页面稳定后重试。'};
    }
    const combined = {...row, platform_job_id:merged.platform_job_id,
      platform_job_title:row.platform_job_title || previous?.platform_job_title || ''};
    jobReferences.set(combined, merged.references);
    conversations.set(row.friend_id, combined);
  }
  // The DOM fallback accepts only explicit platform IDs. A display name is not an ID.
  for (const element of chatUser?.querySelectorAll('[data-friend-id], [data-uid]') || []) {
    if (!visible(element)) continue;
    const friend_id = firstId(element.getAttribute('data-friend-id'), element.getAttribute('data-uid'));
    if (!friend_id || conversations.has(friend_id)) continue;
    const candidate_name = text(element.querySelector('.name, .geek-name, .user-name')?.textContent, 120);
    if (!candidate_name) continue;
    conversations.set(friend_id, {
      friend_id,
      candidate_name,
      platform_geek_id:'', platform_job_id:'', platform_job_title:'', last_message:'', last_at:'', unread_count:null,
    });
  }
  if (conversations.size > 500) return {ok:false, error:'已加载会话超过 500 条，请在 BOSS 按岗位筛选后重试。'};

  const selections = new Set(), selectedValues = [];
  for (const vm of roots) {
    for (const value of values(vm, ['conversation$', 'conversation', 'currentConversation', 'selectedFriend'])) {
      const valueId = friendId(value);
      if (valueId) { selections.add(valueId); selectedValues.push(value); }
    }
  }
  for (const root of [conversationRoot, document.querySelector('.chat-editor'),editorInput?.parentElement]) {
    const valueId = firstId(root?.getAttribute('data-friend-id'), root?.getAttribute('data-uid'));
    if (valueId) selections.add(valueId);
  }
  for (const selected of chatUser?.querySelectorAll('.selected[data-friend-id], .active[data-friend-id], [aria-selected="true"][data-friend-id]') || []) {
    const valueId = id(selected.getAttribute('data-friend-id'));
    if (valueId) selections.add(valueId);
  }
  if (selections.size > 1) return {ok:false, error:'当前聊天与选中候选人的会话标识不一致，请等待会话切换完成后重试。'};
  const selected_friend_id = [...selections][0] || '';
  if (selected_friend_id && !conversations.has(selected_friend_id)) {
    return {ok:false, error:'当前聊天没有匹配的已加载候选人会话，请在 BOSS 沟通列表中核对后重试。'};
  }
  if (!conversations.size) return {ok:false, error:'页面未提供可核对的候选人会话标识，未导入任何聊天数据。'};

  if (selected_friend_id) {
    const current = conversations.get(selected_friend_id);
    const jobs = [current, ...selectedValues.filter(value => friendId(value) === selected_friend_id).map(communicationJob)];
    const merged = mergeJobs(jobs, current.platform_job_id);
    const titles = new Set(jobs.map(value => value.platform_job_title).filter(Boolean));
    if (merged.conflict) return {ok:false, error:'当前聊天与会话列表的沟通职位标识不一致，请等待页面稳定后重试。'};
    if (merged.unverified) return {ok:false, error:'当前沟通职位使用不同形式的标识，但页面未提供对应关系，请重新打开该会话后重试。'};
    // Read only an explicitly labelled communicated job in the current chat
    // pane. A desired-position row, message or resume is never a job binding.
    const excluded = '.chat-user, .chat-message-list, .message-item, .chat-editor, .boss-chat-editor-input, [contenteditable="true"], iframe, [role="dialog"]';
    const areaRoots = [];
    for (let area = conversationRoot, level = 0; area && level < 3 && !['BODY', 'HTML'].includes(area.tagName); area = area.parentElement, level++) areaRoots.push(area);
    const nodes = new Set(areaRoots.flatMap(area => [area, ...area.querySelectorAll('div,span,p,dt,label,strong')]).filter(visible));
    if (nodes.size > 6000) return {ok:false, error:'当前聊天岗位区域过大，无法确认唯一沟通职位。'};
    const labelText = node => {
      if (node.nodeType === 3) return node.textContent || '';
      if (node.nodeType !== 1 || !visible(node) || node.getAttribute('aria-hidden') === 'true' ||
          ['SVG', 'I'].includes(node.tagName.toUpperCase()) || /(?:^|[\s_-])(?:icon|refresh)(?:[\s_-]|$)/i.test(node.className || '') ||
          node.matches('button,[role="button"]') && /^(刷新|更换|切换|同步)(职位)?$/.test((node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim())) return '';
      return [...node.childNodes].map(labelText).join('');
    };
    for (const node of nodes) {
      if (node.closest(excluded)) continue;
      const content = (node.textContent || '').replace(/\s+/gu, ' ').trim();
      if (!/^沟通职位(?:\s*[：:]|\s*$)/u.test(content) || content.length > 400) continue;
      let row = node, title = '';
      for (let level = 0; row && level < 3 && !['BODY', 'HTML'].includes(row.tagName); row = row.parentElement, level++) {
        if (!areaRoots.some(area => area === row || area.contains(row)) || row.closest(excluded)) break;
        const value = labelText(row).replace(/\s+/gu, ' ').trim();
        const match = !/^沟通职位\s*[：:]?\s*$/u.test(value) && value.match(/^沟通职位\s*[：:]?\s*(.+)$/u);
        if (match && !/期望|沟通职位/u.test(match[1])) { title = jobTitle(match[1]); if (title) break; }
      }
      if (!title) continue;
      for (let parent = row; parent && !['BODY', 'HTML'].includes(parent.tagName); parent = parent.parentElement) {
        const claim = firstId(parent.getAttribute('data-friend-id'), parent.getAttribute('data-uid'));
        if (claim && claim !== selected_friend_id) return {ok:false, error:'沟通职位标题属于另一位候选人，未自动匹配岗位。'};
        const owner = read(parent, '__vue__');
        for (const value of values(owner, ['conversation$', 'conversation', 'currentConversation', 'selectedFriend'])) {
          const valueId = friendId(value);
          if (valueId && valueId !== selected_friend_id) return {ok:false, error:'沟通职位标题与当前会话不一致，未自动匹配岗位。'};
        }
        if (areaRoots.includes(parent)) break;
      }
      titles.add(title);
    }
    if (titles.size > 1) return {ok:false, error:'当前聊天显示了不同的沟通职位名称，请等待页面稳定后重试。'};
    conversations.set(selected_friend_id, {...current, platform_job_id:merged.platform_job_id, platform_job_title:[...titles][0] || ''});
  }
  if (jobError) return {ok:false, error:jobError};

  const messages = new Map();
  let skippedMessages = 0;
  let messageCapture={visible_count:0,unresolved_count:0,visible_attachment_count:0,unresolved_attachments:0};
  const messageFrom = (raw,context={}) => {
    raw = object(raw);
    const message_id = firstId(raw.mid, raw.messageId, raw.msgId);
    if (!message_id) { skippedMessages++; return; }
    const from = object(raw.from), to = object(raw.to);
    const fromId = firstId(from.uid, raw.fromId), toId = firstId(to.uid, raw.toId);
    const explicitFriend = firstId(raw.friendId, raw.friend_id);
    if (explicitFriend && explicitFriend !== selected_friend_id) throw Error('消息归属与当前候选人不一致，已停止读取。');
    let direction = '';
    if (fromId === selected_friend_id && toId && toId !== selected_friend_id) direction = 'incoming';
    if (toId === selected_friend_id && fromId && fromId !== selected_friend_id) direction = 'outgoing';
    if(!toId&&context.scope_bound===true&&context.friend_id===selected_friend_id&&context.direction==='incoming'&&
        fromId===selected_friend_id&&(from.source===undefined||Number(from.source)===0))direction='incoming';
    if(context.direction&&direction&&context.direction!==direction)throw Error('消息方向与当前聊天节点不一致，已停止读取。');
    if (!direction) { skippedMessages++; return; }
    const body = object(raw.body);
    const link = object(body.hyperLink);
    const card = object(raw.attachment);
    let receivedLink = false;
    if ([1, 9].includes(link.hyperLinkType) && typeof link.url === 'string') {
      try {
        const parsed = new URL(link.url, location.origin);
        const trusted = parsed.origin === location.origin ||
          parsed.protocol === 'bosszp:' && parsed.hostname === 'bosszhipin.app' && parsed.pathname === '/openwith';
        receivedLink = trusted &&
          ['selectResumePreviewUrl', 'openFile'].includes(parsed.searchParams.get('type')) &&
          Boolean(parsed.searchParams.get('id') || parsed.searchParams.get('encryptId'));
      } catch { /* An unknown card remains pending. Its URL is never returned or followed. */ }
    }
    const attachment = Boolean(raw.attachment_name || card.name || receivedLink || raw.kind === 'attachment');
    const attachment_name = attachment ? (firstText(raw.attachment_name, card.name, link.fileName, link.name, link.title).slice(0, 240)||
      (receivedLink&&context.scope_bound===true?'附件简历（文件名待下载）':'')) : '';
    if (attachment && !attachment_name) { skippedMessages++; return; }
    const expired = raw.attachment_status === 'expired' || card.expired === true || link.expired === true;
    const explicitlyReceived = raw.attachment_status === 'received' || card.status === 'received' || receivedLink;
    const content = [body.text, raw.text, raw.content, raw.pushText].find(value => typeof value === 'string' && value.trim()) || '';
    if (content.length > 30000) throw Error('消息正文超过 30000 字符，未保存截断的消息。');
    const row = {
      friend_id:selected_friend_id, message_id, direction,
      text:content.trim(),
      sent_at:timestamp(raw.time || raw.timestamp || raw.msgTime || raw.timeStamp),
      kind:attachment ? 'attachment' : 'text',
    };
    if (attachment) {
      row.attachment_name = attachment_name;
      row.attachment_status = expired ? 'expired' : direction === 'incoming' && explicitlyReceived ? 'received' : 'pending';
    }
    if (!row.text && !attachment) { skippedMessages++; return; }
    const previous = messages.get(message_id);
    if (previous && (previous.direction !== row.direction || previous.text !== row.text || previous.kind !== row.kind ||
      previous.attachment_name!==row.attachment_name||previous.attachment_status!==row.attachment_status)) {
      throw Error('同一消息标识存在冲突内容，请等待页面稳定后重试。');
    }
    messages.set(message_id, row);
  };
  try {
    if (selected_friend_id) {
      const sourceReader=globalThis.window?.__hrmChatMessageSource;
      if(sourceReader?.version===1){
        const source=sourceReader.read({friend_id:selected_friend_id});
        for(const key of Object.keys(messageCapture)){
          if(!Number.isSafeInteger(source[key])||source[key]<0)throw Error('消息读取组件返回了无效识别状态。');
          messageCapture[key]=source[key];
        }
        messageCapture.history_loaded=source.history_loaded===true;
        messageCapture.history_count=Number.isSafeInteger(source.history_count)&&source.history_count>=0?source.history_count:0;
        if(!Array.isArray(source.rows)||source.rows.length>500)throw Error('当前已加载消息过多或结构异常，请分次读取。');
        for(const entry of source.rows)messageFrom(entry.raw,entry);
        for(const warning of source.warnings||[])if(typeof warning==='string')warnings.push(warning);
      }else{
      const messageKeys = ['messages', 'messageList', 'messageList$', 'historyMsgList', 'historyList$', 'historyList'];
      for (const vm of roots) {
        for (const list of values(vm, messageKeys)) {
          if (!Array.isArray(list)) continue;
          if (list.length > 500) throw Error('当前已加载消息超过 500 条，请分次读取。');
          for (const row of list) messageFrom(row);
        }
      }
      for (const element of conversationRoot?.querySelectorAll('[data-mid], [data-message-id], [data-msg-id]') || []) {
        if (!visible(element)) continue;
        const message_id = firstId(element.getAttribute('data-mid'), element.getAttribute('data-message-id'), element.getAttribute('data-msg-id'));
        if (!message_id || messages.has(message_id)) continue;
        const bound = firstId(element.getAttribute('data-friend-id'), element.getAttribute('data-uid'));
        if (bound && bound !== selected_friend_id) throw Error('页面消息与当前候选人不一致。');
        const own = element.classList.contains('item-myself') || element.classList.contains('message-self');
        const incoming = element.classList.contains('item-friend') || element.classList.contains('message-other');
        if (own === incoming) { skippedMessages++; continue; }
        const content = element.querySelector('.text, .message-text, .text-content');
        const attachment = element.querySelector('[data-attachment-name]');
        messageFrom({
          mid:message_id,
          friendId:selected_friend_id,
          from:{uid:incoming ? selected_friend_id : '__self__'},
          to:{uid:own ? selected_friend_id : '__self__'},
          text:content?.textContent || '',
          time:element.getAttribute('data-timestamp'),
          attachment_name:attachment?.getAttribute('data-attachment-name') || '',
          attachment_status:attachment?.getAttribute('data-attachment-status') || 'pending',
        });
      }
      }
    }
  } catch (error) { return {ok:false, error:error.message}; }
  if (messages.size > 500) return {ok:false, error:'当前已加载消息超过 500 条，请分次读取。'};
  if (!selected_friend_id) warnings.push('未能确认当前聊天的会话标识，本次只读取已加载的会话列表。');
  else if (!messages.size) warnings.push('未读取到带稳定标识的消息；请在 BOSS 中手动打开目标聊天并等待加载。');
  if (skippedMessages) warnings.push('部分消息缺少可核对的标识、方向或可读正文，已跳过。');
  if(messageCapture.unresolved_attachments&&!messageCapture.history_loaded)warnings.push(`页面有 ${messageCapture.unresolved_attachments} 个附件卡片尚未确认消息标识或归属，未把它们当作“没有附件”。`);
  warnings.push(messageCapture.history_loaded?'已补读当前会话最近最多 100 条记录；更早历史可在 BOSS 中手动加载后再次导入。':
    '本次仅包含页面已经加载的内容；历史记录可在 BOSS 中手动加载后再次导入。');
  return {ok:true, conversations:[...conversations.values()], messages:[...messages.values()],
    selected_friend_id, account_id:'', account_name:'',message_capture:messageCapture, warnings};
}

export function mergeCommunicationFrames(frames) {
  const relevant = frames.filter(frame => frame.result?.ok);
  if (relevant.length !== 1) {
    const error = frames.map(frame => frame.result?.error).find(Boolean);
    throw Error(relevant.length ? '识别到多个沟通页面框架，无法确认唯一来源。' : error || '没有可读取的 BOSS 沟通页面。');
  }
  return relevant[0].result;
}

export function selectCommunicationRows(snapshot, friendIds) {
  const selected = new Set(friendIds);
  const conversations = snapshot.conversations.filter(row => selected.has(row.friend_id));
  if (!conversations.length || conversations.length !== selected.size) throw Error('所选会话不在当前读取结果中，请重新读取。');
  const jobs = new Set(conversations.map(row => row.platform_job_id || ''));
  if (jobs.size !== 1 || (jobs.has('') && conversations.length !== 1)) {
    throw Error('请在同一个平台岗位分组内选择会话；缺少平台岗位标识时只能单条确认。');
  }
  return {conversations, messages:snapshot.messages.filter(row => selected.has(row.friend_id))};
}
