// Executed in MAIN. Keep every page helper inside this function: Chrome serializes it.
// Attachment protocol: boss-agent-cli 99fcb0ec, api/recruiter_client.py and recruiter.yaml.
export async function chatPageAction(args = {}) {
  const fail = (code, message) => { const error = new Error(message); error.code = code; error.hrmChatSafe = true; throw error; };
  const id = value => {
    const valueText = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '';
    return /^[A-Za-z0-9_-]{1,160}$/.test(valueText) && valueText !== '0' ? valueText : '';
  };
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const read = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
  const firstId = (...values) => values.map(id).find(Boolean) || '';
  const text = value => typeof value === 'string' ? value.trim() : '';
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !['hidden', 'collapse'].includes(getComputedStyle(node).visibility) && getComputedStyle(node).display !== 'none');
  const values = (vm, keys) => keys.flatMap(key => {
    const result = [read(vm, key), read(read(vm, '$data'), key), read(read(read(vm, '$observables'), key), '_value')];
    return result.filter(value => value !== undefined);
  });
  const friend = value => firstId(value?.friendId, value?.friend_id, value?.uid);
  const jobClaims = rows => {
    const refs = rows.map(value => {
      value = object(value);
      const info = object(value.jobInfo || value.communicateJob || value.communicationJob);
      const person = object(value.geekInfo || value.geek);
      const generic = [value.jobId, info.jobId, value.platform_job_id].map(id).filter(Boolean);
      return {
        encrypted:[...new Set([value.encryptJobId, value.toPositionId, info.encryptJobId, info.toPositionId, info.encryptId, person.encryptJobId,
          ...generic.filter(value => !/^\d+$/.test(value))].map(id).filter(Boolean))],
        numeric:[...new Set(generic.filter(value => /^\d+$/.test(value)))],
      };
    });
    const encrypted = new Set(refs.flatMap(ref => ref.encrypted)), numeric = new Set(refs.flatMap(ref => ref.numeric));
    // Accept both forms only through a pair in the same bound conversation.
    // Equal titles or candidate names never establish a job-ID alias.
    return {valid:encrypted.size <= 1 && numeric.size <= 1 &&
      !(encrypted.size && numeric.size && !refs.some(ref => ref.encrypted.length && ref.numeric.length)),
      ids:new Set([...encrypted, ...numeric])};
  };
  const geek = value => firstId(value?.geekInfo?.encryptUid, value?.geekInfo?.encryptGeekId, value?.encryptUid, value?.encryptGeekId);
  const targetFriend = id(args.friend_id), targetJob = args.platform_job_id === '' ? '' : id(args.platform_job_id);
  let current;
  try {
    if (!targetFriend || (args.platform_job_id !== '' && !targetJob)) fail('INVALID_TARGET', '缺少有效的会话或平台岗位标识。');
    if (!['inspect', 'open-chat', 'open-online', 'close-online', 'attachment-fetch'].includes(args.action)) fail('UNKNOWN_ACTION', '未知聊天采集动作。');
    const approved = args.snapshot?.conversations?.filter(row => row.friend_id === targetFriend && (row.platform_job_id || '') === targetJob);
    if (args.snapshot?.ok === false || approved?.length !== 1) fail('STALE_SNAPSHOT', '会话不在本次已确认的页面快照中，请重新读取。');
    const expectedGeek = id(approved[0].platform_geek_id);
    const guard = () => {
      if (location.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(location.hostname)) fail('WRONG_ORIGIN', '页面已离开 BOSS 直聘。');
      if (document.visibilityState === 'hidden') fail('HIDDEN_PAGE', '请保持 BOSS 沟通标签页在前台。');
      const body = (document.body?.innerText || document.body?.textContent || '').slice(0, 12000);
      if (/请完成安全验证|访问过于频繁|拖动滑块|账号存在异常/.test(body)) fail('ACCOUNT_BLOCKED', 'BOSS 页面要求人工处理，已停止采集。');
      for (const popup of [...document.querySelectorAll('.boss-popup__wrapper, .boss-dialog__wrapper')].filter(visible)) {
        if (popup.querySelector('.block-vip2, .vip2-layout, .payment-layout-v2, .rights-table-vip, .pay-wrap-qrcode-v1') ||
            /VIP账号|商品需付|扫码支付|增值服务协议|直豆抵扣|查看次数.*(?:不足|用完|上限)/.test(popup.textContent || '')) {
          fail('ENTITLEMENT_REQUIRED', 'BOSS 弹出权益或付费提示，请人工核对并关闭提示后再继续。');
        }
      }
    };
    const state = () => {
      guard();
      const users = [...document.querySelectorAll('.chat-user')].filter(visible);
      const chats = [...document.querySelectorAll('.chat-conversation')].filter(visible);
      if (users.length !== 1 || chats.length !== 1) fail('AMBIGUOUS_CHAT', '没有唯一可见的沟通列表和聊天区域。');
      const user = users[0], chat = chats[0], editor = document.querySelector('.chat-editor');
      const input = document.querySelector('.boss-chat-editor-input, #boss-chat-editor-input');
      const roots = [];
      const add = vm => { if (vm && typeof vm === 'object' && !roots.includes(vm)) roots.push(vm); };
      for (const element of [user, chat, editor, input?.parentElement]) {
        const vm = read(element, '__vue__'); add(vm); add(read(vm, '$parent'));
        for (const child of (read(vm, '$children') || []).slice?.(0, 12) || []) add(child);
      }
      const rows = [];
      for (const vm of roots) for (const list of values(vm, ['list$', 'allList$', 'friendList', 'list', 'dataSources'])) {
        if (Array.isArray(list)) rows.push(...list.slice(0, 501).filter(raw => friend(raw) === targetFriend));
      }
      const rowBindings = [];
      const listNodes = [...user.querySelectorAll('*')];
      if (listNodes.length > 2500) fail('AMBIGUOUS_ROW', '聊天列表结构过大，请按岗位筛选后重新读取。');
      for (const node of listNodes) {
        if (!visible(node)) continue;
        const bindings = [];
        const domId = firstId(node.getAttribute('data-friend-id'), node.getAttribute('data-uid'));
        if (domId) bindings.push({friendId:domId, jobId:node.getAttribute('data-platform-job-id') || node.getAttribute('data-job-id') || ''});
        const vm = read(node, '__vue__');
        if (vm && (!read(vm, '$el') || read(vm, '$el') === node)) {
          const props = object(read(vm, '$props'));
          for (const value of [vm, read(vm, '$data'), ...['friend', 'item', 'dataSource', 'user', 'conversation'].flatMap(key => [read(props, key), read(vm, key)])]) {
            if (friend(value)) bindings.push(value);
          }
        }
        const ids = new Set(bindings.map(friend));
        if (ids.has(targetFriend) && ids.size > 1) fail('AMBIGUOUS_ROW', '聊天列表项提供了冲突的候选人标识。');
        for (const binding of bindings.filter(value => friend(value) === targetFriend)) rowBindings.push({node, raw:binding});
      }
      const all = [...rows, ...rowBindings.map(binding => binding.raw)];
      const selectedValues = roots.flatMap(vm => values(vm, ['conversation$', 'conversation', 'currentConversation', 'selectedFriend']))
        .filter(value => friend(value) === targetFriend);
      const jobBindings = [...all, ...selectedValues];
      const jobs = jobClaims(jobBindings);
      if (!jobs.valid || (jobs.ids.size && !jobs.ids.has(targetJob))) fail('JOB_CHANGED', '会话的平台岗位已变化或标识对应关系无法确认，请重新选择会话。');
      if (!all.length || (targetJob && !jobs.ids.has(targetJob))) fail('UNBOUND_ROW', '没有可核验平台岗位与会话标识的聊天列表项。');
      const geekIds = new Set(all.map(geek).filter(Boolean));
      if (geekIds.size > 1 || (expectedGeek && geekIds.size && !geekIds.has(expectedGeek))) fail('CANDIDATE_CHANGED', '会话的候选人平台标识已变化。');
      const selections = new Set();
      for (const vm of roots) for (const value of values(vm, ['conversation$', 'conversation', 'currentConversation', 'selectedFriend'])) if (friend(value)) selections.add(friend(value));
      for (const node of [chat, editor, input?.parentElement]) {
        const value = firstId(node?.getAttribute('data-friend-id'), node?.getAttribute('data-uid')); if (value) selections.add(value);
      }
      for (const node of user.querySelectorAll('.selected[data-friend-id], .active[data-friend-id], [aria-selected="true"][data-friend-id], [aria-selected="true"][data-uid]')) {
        const value = firstId(node.getAttribute('data-friend-id'), node.getAttribute('data-uid')); if (visible(node) && value) selections.add(value);
      }
      const nodes = [...new Set(rowBindings.map(binding => binding.node))];
      const outer = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
      return {user, chat, roots, nodes:outer, selected:selections.size === 1 ? [...selections][0] : '',
        selectionConflict:selections.size > 1, platformGeek:[...geekIds][0] || '', jobBindings};
    };
    const assertSelected = () => {
      const fresh = state();
      if (fresh.selectionConflict || fresh.selected !== targetFriend) fail('CHAT_CHANGED', '当前选中聊天与目标候选人不一致，已停止操作。');
      if (current && fresh.chat !== current.chat) fail('CHAT_CHANGED', '聊天区域已替换，请重新读取当前会话。');
      return fresh;
    };
    const pause = () => new Promise(resolve => setTimeout(resolve, 100));
    current = state();
    if (args.action === 'open-chat') {
      if (current.selected === targetFriend && !current.selectionConflict) return {ok:true, status:'selected', selected_friend_id:targetFriend};
      if (current.nodes.length !== 1) fail('AMBIGUOUS_ROW', '无法凭稳定会话标识确认唯一聊天列表项，请手动打开该聊天。');
      current.nodes[0].click();
      for (let count = 0; count < 20; count++) {
        const fresh = state();
        if (!fresh.selectionConflict && fresh.selected === targetFriend) return {ok:true, status:'selected', selected_friend_id:targetFriend};
        await pause();
      }
      fail('SELECTION_UNCONFIRMED', '已点击聊天，但尚未确认目标会话选中；不会重复点击。');
    }
    current = assertSelected();
    const resumeFrames = () => [...document.querySelectorAll('iframe')].filter(node => {
      if (!visible(node)) return false;
      try { const url = new URL(node.getAttribute('src'), location.href); return url.origin === location.origin && /^\/web\/frame\/c-resume\/?$/.test(url.pathname); } catch { return false; }
    });
    const frameState = frame => {
      try {
        const src = new URL(frame.getAttribute('src'), location.href).href;
        const doc = frame.contentWindow?.document;
        const actual = frame.contentWindow?.location?.href;
        return {src, doc, body:doc?.body, ready:actual === src && doc?.body && ['interactive', 'complete'].includes(doc.readyState)};
      } catch { return {ready:false}; }
    };
    const frameClaimsTarget = frame => {
      const src = new URL(frame.getAttribute('src'), location.href);
      const claims = ['encryptGeekId', 'encryptUid', 'geekId'].flatMap(key => src.searchParams.getAll(key)).filter(Boolean);
      return Boolean(current.platformGeek && claims.length && claims.every(value => value === current.platformGeek));
    };
    const onlineControls = () => {
      const regions = [current.chat];
      // boss-cli 50eea0e2, toolset/action.ts: candidate header + a.resume-btn-online.
      // The header may be a sibling of the message pane; its shared Vue owner must
      // explicitly name this conversation. A display name is never sufficient.
      for (const header of [...document.querySelectorAll('.base-info-single-container')].filter(visible)) {
        let area = header.parentElement;
        while (area && area !== document.body && !area.contains(current.chat)) area = area.parentElement;
        if (!area || area === document.body || area.contains(current.user) ||
            [...area.querySelectorAll('.chat-conversation')].filter(visible).length !== 1 ||
            [...area.querySelectorAll('.base-info-single-container')].filter(visible).length !== 1) continue;
        const claims = [], headerJobs = [];
        for (let node = header; node; node = node === area ? null : node.parentElement) {
          const domId = firstId(node.getAttribute('data-friend-id'), node.getAttribute('data-uid'));
          if (domId) claims.push(domId);
          const domJob = firstId(node.getAttribute('data-platform-job-id'), node.getAttribute('data-job-id'));
          if (domJob) headerJobs.push({jobId:domJob});
          const vms = [read(node, '__vue__'), ...current.roots.filter(vm => read(vm, '$el') === node)];
          for (const vm of vms) for (const value of values(vm, ['conversation$', 'conversation', 'currentConversation', 'selectedFriend'])) {
            if (friend(value)) claims.push(friend(value)); headerJobs.push(value);
          }
        }
        if (claims.length && claims.some(value => value !== targetFriend)) fail('CANDIDATE_CHANGED', '候选人详情栏与当前聊天的会话标识不一致。');
        const jobs = jobClaims([...current.jobBindings, ...headerJobs]);
        if (!jobs.valid || jobs.ids.size && !jobs.ids.has(targetJob)) fail('JOB_CHANGED', '候选人详情栏与当前聊天的平台岗位不一致。');
        if (claims.length && claims.every(value => value === targetFriend)) regions.push(header);
      }
      const nodes = [...new Set(regions.flatMap(region => [...region.querySelectorAll('button,a,[role="button"],span,div')]))].filter(node => visible(node) &&
        ['查看在线简历', '在线简历'].includes((node.innerText || node.textContent || '').trim()) &&
        !node.matches('input,textarea,[contenteditable="true"],:disabled,[aria-disabled="true"]') &&
        !/disabled|forbid|ban/i.test(node.className || '') &&
        !node.closest('.chat-editor, [data-message-id], [data-mid], .message-item, .chat-message') &&
        (node.matches('button,a,[role="button"]') || getComputedStyle(node).cursor === 'pointer'));
      return nodes.filter(node => !nodes.some(other => other !== node && node.contains(other)));
    };
    let unresolvedAttachments = 0;
    const messageRows = () => {
      const all = [], source = read(window, '__hrmChatMessageSource');
      const shared = source !== undefined && source !== null;
      unresolvedAttachments = 0;
      if (shared) {
        if (read(source, 'version') !== 1 || typeof read(source, 'read') !== 'function')
          fail('MESSAGE_SOURCE_UNAVAILABLE', '当前聊天消息读取组件尚未就绪，请重新读取页面。');
        let result;
        try { result = source.read({friend_id:targetFriend}); }
        catch { fail('MESSAGE_SOURCE_UNAVAILABLE', '当前聊天消息来源无法确认，请重新读取页面。'); }
        if (!result || !Array.isArray(result.rows) || result.rows.length > 500)
          fail('MESSAGE_SOURCE_UNAVAILABLE', '当前聊天消息来源无效或已加载消息过多，请重新读取。');
        unresolvedAttachments = Number.isSafeInteger(result.unresolved_attachments) && result.unresolved_attachments > 0 ? result.unresolved_attachments : 0;
        all.push(...result.rows);
      } else {
        // Compatibility for older pages only. Installed sources own message
        // discovery, including deeply nested component packets and their scope.
        for (const vm of current.roots) for (const list of values(vm, ['messages', 'messageList', 'messageList$', 'historyMsgList', 'historyList$', 'historyList']))
          if (Array.isArray(list)) all.push(...list.slice(0, 501).map(raw => ({raw})));
      }
      const rows = new Map();
      for (const entry of all) {
        const raw = entry?.raw;
        const mid = firstId(raw?.mid, raw?.messageId, raw?.msgId);
        if (!mid) continue;
        const from = firstId(raw?.from?.uid, raw?.fromId), to = firstId(raw?.to?.uid, raw?.toId);
        const explicit = firstId(raw?.friendId, raw?.friend_id);
        if (explicit && explicit !== targetFriend) fail('MESSAGE_MISMATCH', '消息与当前候选人会话不一致。');
        if (shared) {
          if (id(entry.friend_id) !== targetFriend) fail('MESSAGE_MISMATCH', '消息来源与当前候选人会话不一致。');
          const direction = entry.direction;
          if (direction === 'outgoing') {
            if (from === targetFriend) fail('MESSAGE_MISMATCH', '附件消息方向与真实发送者不一致。');
            continue;
          }
          if (direction !== 'incoming') continue;
          if (from !== targetFriend || to === targetFriend) fail('MESSAGE_MISMATCH', '附件消息方向与当前候选人不一致。');
          const recipientClaimed = raw?.to !== undefined && raw?.to !== null || raw?.toId !== undefined && raw?.toId !== null;
          if (!to && (recipientClaimed || !(entry.scope_bound === true && id(raw?.from?.uid) === targetFriend &&
              [0, '0'].includes(raw?.from?.source)))) continue;
        } else if (!to) continue;
        if (from !== targetFriend || to === targetFriend || (raw?.from?.source !== undefined && Number(raw.from.source) !== 0)) continue;
        const link = object(raw?.body?.hyperLink), attachment = object(raw?.attachment);
        if (![1, 9].includes(link.hyperLinkType) || typeof link.url !== 'string') continue;
        let url;
        try { url = new URL(link.url, location.href); } catch { continue; }
        const officialCard = (url.origin === location.origin && url.protocol === 'https:') ||
          (url.protocol === 'bosszp:' && url.hostname === 'bosszhipin.app' && url.pathname === '/openwith' && !url.username && !url.password && !url.port);
        if (!officialCard || url.hash) continue;
        for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) fail('INVALID_ATTACHMENT', '附件卡片包含重复参数。');
        const type = url.searchParams.get('type');
        const resumeId = id(url.searchParams.get(type === 'selectResumePreviewUrl' ? 'encryptId' : 'id'));
        if (!['selectResumePreviewUrl', 'openFile'].includes(type) || !resumeId) continue;
        const authType = url.searchParams.get('authType') || '';
        if (authType && !/^\d{1,3}$/.test(authType)) fail('INVALID_ATTACHMENT', '附件卡片授权参数无法确认。');
        const expired = raw.attachment_status === 'expired' || [attachment.expired, link.expired].some(value => value === true || value === 1 || value === '1' || value === 'true');
        const pending = raw.attachment_status === 'pending' || attachment.status === 'pending';
        const name = [raw.attachment_name, attachment.name, link.fileName, link.name, link.title].map(text).find(Boolean) || '';
        const row = {message_id:mid, resumeId, authType, name, expired, pending,
          fingerprint:JSON.stringify([from, to, link.url, expired, pending, name,
            ...(shared ? [entry.friend_id, entry.direction, entry.scope_bound === true] : [])])};
        if (rows.has(mid) && rows.get(mid).fingerprint !== row.fingerprint) fail('MESSAGE_CONFLICT', '相同附件消息标识对应了不同内容。');
        rows.set(mid, row);
      }
      return rows;
    };
    if (args.action === 'inspect') {
      const attachments = [...messageRows().values()].map(row => ({message_id:row.message_id, name:row.name,
        status:row.expired ? 'expired' : row.pending ? 'pending' : 'received'}));
      return {ok:true, status:'ready', selected_friend_id:targetFriend, platform_geek_id:current.platformGeek,
        online_count:onlineControls().length, online_open:resumeFrames().length > 0, attachments,
        ...(unresolvedAttachments ? {unresolved_attachments:unresolvedAttachments,
          warnings:['页面有附件消息尚未确认稳定标识或归属，请重新读取后核对。']} : {})};
    }
    const storeKey = '__hrmChatResumeActions1';
    const sessions = window[storeKey] instanceof Map ? window[storeKey] : (window[storeKey] = new Map());
    if (args.action === 'open-online') {
      const existing = resumeFrames();
      if (existing.length) {
        if (existing.length === 1 && frameClaimsTarget(existing[0])) {
          const src = new URL(existing[0].getAttribute('src'), location.href);
          if (!frameState(existing[0]).ready) fail('DETAIL_CHANGED', '已有简历框架未完成加载或发生重定向，请人工核对。');
          return {ok:true, status:'already-open', selected_friend_id:targetFriend, open_token:null, iframe_src:src.href};
        }
        fail('DETAIL_ALREADY_OPEN', '已有在线简历无法可靠绑定当前候选人，请先手动关闭。');
      }
      const controls = onlineControls();
      if (!controls.length) fail('ONLINE_NOT_FOUND', '当前聊天没有可见的在线简历入口；不会索取或发送消息。');
      if (controls.length > 1) fail('AMBIGUOUS_DETAIL', '当前聊天有多个在线简历入口，无法确认唯一来源。');
      const href = controls[0].getAttribute('href');
      if (href && !/^javascript:\s*(?:;|void\s*\(?0\)?;?)?$/i.test(href)) {
        let destination; try { destination = new URL(href, location.href); } catch { fail('ONLINE_UNAVAILABLE', '在线简历入口地址无法确认。'); }
        if (destination.origin !== location.origin || !/^\/web\//.test(destination.pathname)) fail('ONLINE_UNAVAILABLE', '在线简历入口不属于当前官方页面。');
      }
      const before = new Map([...document.querySelectorAll('iframe')].map(frame => [frame, {visible:visible(frame), ...frameState(frame)}]));
      controls[0].click();
      for (let count = 0; count < 30; count++) {
        assertSelected();
        const frames = resumeFrames();
        if (frames.length > 1) fail('AMBIGUOUS_DETAIL', '打开后出现了多份在线简历，已停止采集。');
        if (frames.length === 1) {
          const frame = frames[0];
          const loaded = frameState(frame), previous = before.get(frame);
          if (!loaded.ready) { await pause(); continue; }
          if (previous && (previous.visible || !(loaded.src !== previous.src || frameClaimsTarget(frame)) ||
              (loaded.src !== previous.src && loaded.doc === previous.doc && loaded.body === previous.body))) {
            fail('DETAIL_NOT_NEW', '复用简历框架没有可靠的候选人切换证据，请手动关闭后重试。');
          }
          const src = new URL(frame.getAttribute('src'), location.href).href;
          const root = frame.closest('[role="dialog"], .dialog-lib-resume, .boss-popup__wrapper, .boss-dialog__wrapper') || frame.parentElement;
          if (!root || root === document.body || root === current.chat) fail('UNBOUND_DETAIL', '在线简历没有独立的可确认详情区域。');
          const open_token = [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join('');
          sessions.set(open_token, {frame, src, root, doc:loaded.doc, chat:current.chat, friend:targetFriend, job:targetJob});
          while (sessions.size > 10) sessions.delete(sessions.keys().next().value);
          return {ok:true, status:'opened', selected_friend_id:targetFriend, open_token, iframe_src:src};
        }
        await pause();
      }
      fail('OPEN_UNCONFIRMED', '已点击在线简历，但没有确认唯一详情；不会重复点击。');
    }
    if (args.action === 'close-online') {
      const session = sessions.get(args.open_token);
      if (!session || session.friend !== targetFriend || session.job !== targetJob || session.chat !== current.chat) fail('UNKNOWN_OPEN', '没有属于本次候选人的在线简历打开记录。');
      const {frame, root, src} = session;
      if (!visible(frame) || !visible(root) || frame.getAttribute('src') === null || new URL(frame.getAttribute('src'), location.href).href !== src ||
          !frameState(frame).ready || frameState(frame).doc !== session.doc || resumeFrames().length !== 1 || resumeFrames()[0] !== frame) fail('DETAIL_CHANGED', '在线简历框架已变化，不会关闭其他详情。');
      const controls = [...root.querySelectorAll('button,a,[role="button"],span,i,div')].filter(node => visible(node) &&
        (/^(关闭|close)$/i.test(node.getAttribute('aria-label') || node.getAttribute('title') || '') ||
         /^(关闭|×|✕|✖)$/.test((node.innerText || node.textContent || '').trim()) || node.matches('.close-btn, .boss-popup__close, .boss-dialog__close, .drawer-close, .icon-close')));
      const unique = controls.filter(node => !controls.some(other => other !== node && node.contains(other)));
      if (unique.length !== 1) fail('CLOSE_UNAVAILABLE', '本次在线简历没有唯一关闭按钮，请手动关闭。');
      sessions.delete(args.open_token);
      unique[0].click();
      for (let count = 0; count < 15; count++) { guard(); if (!visible(frame)) return {ok:true, status:'closed', selected_friend_id:targetFriend}; await pause(); }
      fail('CLOSE_UNCONFIRMED', '已点击关闭，但详情仍然可见；不会重复点击。');
    }
    const messageId = id(args.message_id), row = messageRows().get(messageId);
    if (messageId && !row && unresolvedAttachments)
      fail('MESSAGE_SOURCE_UNRESOLVED', '页面有附件消息尚未确认稳定标识或归属，不能为指定消息生成下载计划。');
    if (!messageId || !row) fail('ATTACHMENT_UNAVAILABLE', '没有找到该候选人发来的指定已收到附件消息。');
    if (row.expired) fail('ATTACHMENT_EXPIRED', '附件已经过期，不会下载或同意请求。');
    if (row.pending) fail('ATTACHMENT_PENDING', '附件正在索取，不会下载或同意请求。');
    if (!current.platformGeek) fail('MISSING_GEEK_ID', '会话缺少可核验的候选人平台标识，无法下载附件。');
    const params = new URLSearchParams({geekId:current.platformGeek, id:row.resumeId});
    if (row.authType) params.set('authType', row.authType);
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 15000);
    let response, detail;
    try {
      response = await fetch(`${location.origin}/wapi/zpgeek/resume/boss/preview/check.json?${params}`, {method:'GET', credentials:'include', redirect:'error', signal:abort.signal});
      if (response.status === 401) fail('AUTH_REQUIRED', 'BOSS 登录状态已失效，请人工登录后重新开始采集。');
      if (response.status === 403) fail('PERMISSION_DENIED', '附件访问权限不足，请在 BOSS 页面核对登录和附件权限。');
      if (response.status === 429) fail('ACCOUNT_BLOCKED', '附件请求频率受限，已停止采集。');
      if (!response.ok || response.redirected || response.type === 'opaqueredirect') fail('PREVIEW_FAILED', '附件权限检查未成功，不会继续下载。');
      const raw = await response.text();
      if (raw.length > 100000) fail('PREVIEW_FAILED', '附件权限检查响应异常。');
      try { detail = JSON.parse(raw); } catch { fail('PREVIEW_FAILED', '附件权限检查返回了登录页或未知内容。'); }
    } catch (error) { if (error.hrmChatSafe) throw error; fail('PREVIEW_FAILED', '附件权限检查被浏览器或网络阻断，请在官方页面核对。'); }
    finally { clearTimeout(timeout); }
    const fresh = assertSelected();
    if (fresh.platformGeek !== current.platformGeek || messageRows().get(messageId)?.fingerprint !== row.fingerprint) fail('CHAT_CHANGED', '权限检查期间候选人或附件消息已变化。');
    if ([9, 32, 35, 36, '9', '32', '35', '36'].includes(detail?.code) || /安全验证|访问过于频繁|账号.*异常|环境.*异常/.test(text(detail?.message))) fail('ACCOUNT_BLOCKED', 'BOSS 限制了当前账号或请求环境，已停止采集，请人工处理。');
    if ([37, '37'].includes(detail?.code)) fail('AUTH_REQUIRED', 'BOSS 登录凭据已失效，请人工重新登录后再开始。');
    if (![0, '0'].includes(detail?.code)) fail('PERMISSION_DENIED', '平台未允许访问该附件，已停止下载。');
    const data = object(detail.zpData);
    if (data.isResumeVisible !== true || ![undefined, null, false, 0].includes(data.expired)) fail('PERMISSION_DENIED', '附件不可访问或已过期，请在官方页面核对。');
    const download = new URL(`https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/${current.platformGeek}`);
    download.searchParams.set('id', row.resumeId);
    if (row.authType) download.searchParams.set('authType', row.authType);
    if (data.d !== undefined && data.d !== null && data.d !== '') {
      // The platform can encode this parameter as an integer. Only safe
      // integers have an exact decimal representation; never stringify objects
      // or guess at an imprecise numeric authorization value.
      const authorization = typeof data.d === 'number' && Number.isSafeInteger(data.d) ? String(data.d) : data.d;
      if (typeof authorization !== 'string' || authorization.length > 4000 || /[\u0000-\u001f\u007f]/.test(authorization)) fail('PREVIEW_FAILED', '附件临时授权参数异常。');
      download.searchParams.set('d', authorization);
    }
    return {ok:true, status:'download-ready', selected_friend_id:targetFriend, download:{url:download.href, name:row.name, resume_id:row.resumeId,
      friend_id:targetFriend, platform_job_id:targetJob, platform_geek_id:current.platformGeek, message_id:messageId}};
  } catch (error) {
    const statuses = {ONLINE_NOT_FOUND:'not-found', ONLINE_UNAVAILABLE:'unavailable', ATTACHMENT_UNAVAILABLE:'unavailable',
      ATTACHMENT_EXPIRED:'expired', ATTACHMENT_PENDING:'pending', MISSING_GEEK_ID:'unsupported', PERMISSION_DENIED:'download-blocked', PREVIEW_FAILED:'download-blocked'};
    return {ok:false, status:statuses[error.code] || 'blocked', code:error.hrmChatSafe ? error.code : 'PAGE_ACTION_FAILED', error:error.hrmChatSafe ? error.message : '聊天页面结构变化或动作被阻断，请手动核对后重试。'};
  }
}

// Extension context only. The short-lived URL stays in memory and must never be logged or stored.
export async function fetchChatAttachment(plan, {fetchImpl = fetch, check = () => {}, expected, timeoutMs = 15000} = {}) {
  const fail = (code, message) => { const error = new Error(message); error.code = code; error.hrmChatSafe = true; throw error; };
  const verify = async () => { try { await check(); } catch (error) { fail(typeof error.code === 'string' ? error.code : 'COLLECTION_STOPPED', '聊天采集已停止，请核对当前候选人后重试。'); } };
  const download = plan?.download || plan;
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) && value !== '0';
  if (!download || !expected || !['friend_id', 'message_id', 'platform_geek_id', 'resume_id'].every(key => id(download[key])) ||
      !['friend_id', 'platform_job_id', 'message_id', 'platform_geek_id'].every(key => expected[key] === download[key])) fail('DOWNLOAD_TARGET_MISMATCH', '附件下载计划与当前候选人或消息不一致。');
  let url;
  try { url = new URL(download.url); } catch { fail('INVALID_DOWNLOAD', '附件下载地址无效。'); }
  const prefix = '/wflow/zpgeek/download/download4boss/';
  if (url.protocol !== 'https:' || url.hostname !== 'docdownload.zhipin.com' || url.port || url.username || url.password || url.hash ||
      url.pathname !== prefix + download.platform_geek_id || url.searchParams.get('id') !== download.resume_id) fail('INVALID_DOWNLOAD', '附件下载地址不属于已确认的官方原件接口。');
  for (const key of url.searchParams.keys()) if (!['id', 'authType', 'd'].includes(key) || url.searchParams.getAll(key).length !== 1) fail('INVALID_DOWNLOAD', '附件下载参数无法确认。');
  if ((url.searchParams.has('authType') && !/^\d{1,3}$/.test(url.searchParams.get('authType'))) ||
      (url.searchParams.has('d') && (!url.searchParams.get('d') || url.searchParams.get('d').length > 4000 || /[\u0000-\u001f\u007f]/.test(url.searchParams.get('d'))))) fail('INVALID_DOWNLOAD', '附件临时授权参数无效。');
  await verify();
  const controller = new AbortController(), limit = 5 * 1024 * 1024;
  const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(30000, timeoutMs)));
  let response, bytes;
  try {
    response = await fetchImpl(url.href, {method:'GET', credentials:'include', redirect:'error', signal:controller.signal});
    await verify();
    if ([401, 403].includes(response.status)) fail('PERMISSION_DENIED', '官方附件下载权限不足，请在 BOSS 页面核对。');
    if (response.status === 429) fail('RATE_LIMITED', '附件下载频率受限，已停止采集。');
    if (!response.ok || response.status !== 200 || response.redirected || response.type === 'opaqueredirect') fail('DOWNLOAD_FAILED', '官方附件接口没有返回可下载文件。');
    if (response.url && response.url !== url.href) fail('DOWNLOAD_FAILED', '附件下载地址发生变化，已停止读取。');
    if (Number(response.headers.get('content-length')) > limit) fail('FILE_TOO_LARGE', '附件超过 5 MiB，未导入。');
    if (!response.body?.getReader) fail('DOWNLOAD_FAILED', '浏览器未提供可校验大小的附件下载流。');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        await verify();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > limit) fail('FILE_TOO_LARGE', '附件超过 5 MiB，未导入。');
        chunks.push(result.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    if (!size) fail('INVALID_FILE', '附件为空，未导入。');
    bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } catch (error) {
    if (error.hrmChatSafe) throw error;
    fail('DOWNLOAD_FAILED', '附件下载被浏览器、权限或网络阻断，请在官方页面核对。');
  } finally { clearTimeout(timer); }
  await verify();
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (['text/html', 'application/xhtml+xml', 'application/json', 'text/json'].includes(mime)) fail('INVALID_FILE', '附件接口返回了页面或错误信息，未保存为简历。');
  let name = typeof download.name === 'string' ? download.name.trim().replace(/\\/g, '/').split('/').pop() : '';
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i), plain = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  try { if (encoded) name = decodeURIComponent(encoded[1]); else if (plain) name = (plain[1] || plain[2]).trim(); } catch { fail('INVALID_FILE', '附件文件名编码无效。'); }
  name = name.replace(/\\/g, '/').split('/').pop();
  let suffix = '', fileMime = '';
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') { suffix = 'pdf'; fileMime = 'application/pdf'; }
  else if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    // Check the ZIP central directory rather than mistaking every ZIP file for DOCX.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
    if (end >= 0) {
      const count = view.getUint16(end + 10, true), names = new Set(); let offset = view.getUint32(end + 16, true), total = 0;
      if (count > 2000) fail('INVALID_FILE', 'DOCX 附件内容结构过大。');
      for (let index = 0; index < count; index++) {
        if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) fail('INVALID_FILE', 'DOCX 附件目录无效。');
        const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
        if (offset + 46 + nameLength + extra + comment > bytes.length) fail('INVALID_FILE', 'DOCX 附件目录无效。');
        names.add(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
        total += view.getUint32(offset + 24, true);
        if (total > 30 * 1024 * 1024 || view.getUint16(offset + 8, true) & 1) fail('INVALID_FILE', 'DOCX 附件加密或解压后过大。');
        offset += 46 + nameLength + extra + comment;
      }
      if (names.has('[Content_Types].xml') && names.has('word/document.xml')) { suffix = 'docx'; fileMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; }
    }
    if (!suffix) fail('INVALID_FILE', '附件不是有效的 DOCX 简历文件。');
  } else {
    if (!/\.txt$/i.test(name) || !['', 'text/plain', 'application/octet-stream'].includes(mime)) fail('INVALID_FILE', '附件不是已确认格式的 PDF、DOCX 或 UTF-8 TXT。');
    let decoded;
    try { decoded = new TextDecoder('utf-8', {fatal:true}).decode(bytes); } catch { fail('INVALID_FILE', '附件不是 PDF、DOCX 或 UTF-8 TXT。'); }
    if (!decoded.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded) || /^\s*(?:<!doctype\b|<html\b|<head\b|<body\b|\{\s*"(?:code|message|error)"\s*:)/i.test(decoded)) fail('INVALID_FILE', '附件接口返回了错误内容或无效文本。');
    suffix = 'txt'; fileMime = 'text/plain';
  }
  if (!name || !/\.[a-z0-9]{1,8}$/i.test(name)) name = `简历-${download.message_id}.${suffix}`;
  if (name.length > 240 || /[\u0000-\u001f\u007f]/.test(name) || name.toLowerCase().split('.').pop() !== suffix) fail('INVALID_FILE', '附件原件格式与文件名不一致，未导入。');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return {file:{name, content:btoa(binary), size:bytes.length, mime:fileMime}};
}
