// Install in MAIN before the sanitized reader/action. Raw attachment URLs never
// leave this page helper: its consumers must return only their sanitized result.
export function installChatMessageSource() {
  const VERSION = 1;
  const REVISION = 'history-2';
  const existing = window.__hrmChatMessageSource;
  if (existing?.version === VERSION && existing.revision === REVISION && existing.ownerDocument === document && typeof existing.read === 'function' && typeof existing.loadHistory === 'function') return {version:VERSION, revision:REVISION};
  const fail = (code, message) => { const error = new Error(message); error.code = code; error.hrmMessageSafe = true; throw error; };
  let historyCache = null, loading = null, lastScope = null, nodeSequence = 0;
  const nodeKeys = new WeakMap();
  const nodeKey = node => { if (!node) return 0; if (!nodeKeys.has(node)) nodeKeys.set(node, ++nodeSequence); return nodeKeys.get(node); };
  const sameScope = (left, right) => left && right && left.friend === right.friend && left.chat === right.chat &&
    left.list === right.list && left.editor === right.editor && left.input === right.input && left.signature === right.signature;
  const secret = /token|cookie|securityid|password|passwd|secret|authorization|credential|signature|csrf|(?:^|_)sig(?:$|_)|(?:^|_)lid(?:$|_)/i;
  const known = new Set(['mid','messageId','msgId','from','to','uid','source','friendId','friend_id','body','text','content','pushText',
    'type','hyperLink','hyperLinkType','url','fileName','name','title','expired','status','dialog','operated','time','timestamp','msgTime','timeStamp',
    'attachment','attachment_name','attachment_status','kind','message','msg','item','data','dataSource','messageData','sourceMessage','packet','payload',
    'conversation$','conversation','currentConversation','selectedFriend','messages','messageList','messageList$','historyMsgList','historyList$','historyList','msgList','messages$',
    '_props','_data','$props','$data','$options','propsData','$vnode','componentOptions','$parent','$el','$observables','_value']);
  const descriptor = (owner, key) => {
    try { return owner && (typeof owner === 'object' || typeof owner === 'function') ? Object.getOwnPropertyDescriptor(owner, key) : undefined; }
    catch { fail('UNREADABLE_COMPONENT', '聊天消息组件无法安全读取，请刷新页面后重试。'); }
  };
  const value = (owner, key) => {
    if (!owner || secret.test(key)) return undefined;
    const property = descriptor(owner, key);
    if (property && 'value' in property) return property.value;
    // Vue 2 observes semantic packet slots and fields with reactive getters.
    // Only these fixed fields may execute a getter; arbitrary props never do.
    if (property?.get && known.has(key)) { try { return property.get.call(owner); } catch { return undefined; } }
    if (!property && ['$props', '$data'].includes(key)) { try { return owner[key]; } catch { return undefined; } }
    return undefined;
  };
  const record = candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
  const identifier = (candidate, zero = false) => {
    const result = typeof candidate === 'number' && Number.isSafeInteger(candidate) ? String(candidate) : typeof candidate === 'string' ? candidate : '';
    return /^[A-Za-z0-9_-]{1,160}$/.test(result) && (zero || result !== '0') ? result : '';
  };
  const firstId = (...items) => items.map(item => identifier(item)).find(Boolean) || '';
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    getComputedStyle(node).display !== 'none' && !['hidden', 'collapse'].includes(getComputedStyle(node).visibility));
  const boundedText = (candidate, limit, label) => {
    if (typeof candidate !== 'string') return undefined;
    if (candidate.length > limit) fail('MESSAGE_LIMIT', `${label}超过可安全读取的长度，已停止导入。`);
    return candidate;
  };
  const containers = vm => {
    if (!record(vm)) return [];
    const result = [vm];
    for (const key of ['_props', '_data', '$props', '$data']) { const item = value(vm, key); if (record(item) && !result.includes(item)) result.push(item); }
    const options = value(vm, '$options'), vnode = value(vm, '$vnode');
    for (const item of [value(options, 'propsData'), value(value(vnode, 'componentOptions'), 'propsData')]) if (record(item) && !result.includes(item)) result.push(item);
    return result;
  };
  const explicitFriend = raw => firstId(value(raw, 'friendId'), value(raw, 'friend_id'));
  const conversationFriend = raw => explicitFriend(raw) || identifier(value(raw, 'uid'));
  const packetId = raw => {
    const ids = ['mid', 'messageId', 'msgId'].map(key => identifier(value(raw, key))).filter(Boolean);
    if (new Set(ids).size > 1) fail('MESSAGE_ID_CONFLICT', '同一消息提供了不同的稳定标识，已停止读取。');
    return ids[0] || '';
  };
  const sender = raw => {
    if (!record(raw)) return undefined;
    const uid = identifier(value(raw, 'uid'), true);
    if (!uid) return undefined;
    const source = value(raw, 'source');
    const result = {uid};
    if (Number.isSafeInteger(source)) result.source = source;
    else if (typeof source === 'string' && /^\d{1,3}$/.test(source)) result.source = Number(source);
    else if (source !== undefined) return undefined;
    return result;
  };
  const sanitize = (raw, domId) => {
    const mid = packetId(raw);
    if (mid && domId && mid !== domId) fail('MESSAGE_ID_CONFLICT', '消息节点标识与原始消息标识不一致。');
    if (!(mid || domId)) return null;
    const result = {mid:mid || domId};
    const rawFrom = value(raw, 'from'), rawTo = value(raw, 'to');
    const from = sender(rawFrom), to = sender(rawTo);
    if (rawFrom !== undefined && !from || rawTo !== undefined && !to) fail('INVALID_MESSAGE_PARTICIPANT', '消息提供了无效的发送方、接收方或来源，无法确认当前候选人。');
    if (from) result.from = from; if (to) result.to = to;
    const friendId = explicitFriend(raw); if (friendId) result.friendId = friendId;
    let body = value(raw, 'body');
    if (typeof body === 'string' && body.trim().startsWith('{')) {
      boundedText(body, 40000, '消息结构');
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (record(body)) {
      const clean = {};
      const type = value(body, 'type'); if (typeof type === 'number' || typeof type === 'string') clean.type = type;
      const bodyText = boundedText(value(body, 'text'), 30000, '消息正文'); if (bodyText !== undefined) clean.text = bodyText;
      const link = value(body, 'hyperLink');
      if (record(link)) {
        const card = {};
        const linkType = value(link, 'hyperLinkType');
        if (Number.isInteger(linkType)) card.hyperLinkType = linkType;
        else if (typeof linkType === 'string' && /^\d{1,3}$/.test(linkType)) card.hyperLinkType = Number(linkType);
        for (const key of ['url', 'fileName', 'name', 'title']) {
          const item = boundedText(value(link, key), key === 'url' ? 8000 : 500, '附件卡片字段');
          if (item !== undefined) card[key] = item;
        }
        const expired = value(link, 'expired'); if (['boolean','number','string'].includes(typeof expired)) card.expired = expired;
        clean.hyperLink = card;
      }
      const dialog = value(body, 'dialog');
      if (record(dialog)) {
        const type = value(dialog, 'type'), operated = value(dialog, 'operated'); clean.dialog = {};
        if (typeof type === 'number' || typeof type === 'string') clean.dialog.type = type;
        if (typeof operated === 'boolean') clean.dialog.operated = operated;
      }
      if (Object.keys(clean).length) result.body = clean;
    }
    for (const key of ['text','content','pushText']) {
      const item = boundedText(value(raw, key), 30000, '消息正文');
      if (item !== undefined && !('text' in result)) result.text = item;
    }
    for (const key of ['time','timestamp','msgTime','timeStamp']) {
      const item = value(raw, key);
      if (typeof item === 'number' && Number.isFinite(item) || typeof item === 'string' && item.length <= 80) { result.time = item; break; }
    }
    for (const key of ['attachment_name', 'attachment_status', 'kind']) {
      const item = boundedText(value(raw, key), key === 'attachment_name' ? 240 : 40, '附件字段'); if (item !== undefined) result[key] = item;
    }
    const attachment = value(raw, 'attachment');
    if (record(attachment)) {
      result.attachment = {};
      for (const key of ['name','status']) { const item = boundedText(value(attachment, key), key === 'name' ? 240 : 40, '附件字段'); if (item !== undefined) result.attachment[key] = item; }
      const expired = value(attachment, 'expired'); if (['boolean','number','string'].includes(typeof expired)) result.attachment.expired = expired;
    }
    return result;
  };
  const mergeRaw = (left, right) => {
    const result = {...left};
    for (const key of Object.keys(right)) {
      if (!(key in result)) result[key] = right[key];
      else if (record(result[key]) && record(right[key])) result[key] = mergeRaw(result[key], right[key]);
      else if (JSON.stringify(result[key]) !== JSON.stringify(right[key])) fail('MESSAGE_CONFLICT', '相同消息标识出现冲突内容或附件链接，已停止读取。');
    }
    return result;
  };
  const hasAttachmentName = raw => [raw.attachment_name, raw.attachment?.name, raw.body?.hyperLink?.fileName,
    raw.body?.hyperLink?.name, raw.body?.hyperLink?.title].some(item => typeof item === 'string' && item.trim());
  const directionFor = (raw, target, context) => {
    if (raw.friendId && raw.friendId !== target) fail('CONVERSATION_MISMATCH', '消息原始会话标识属于另一位候选人。');
    const from = raw.from?.uid, to = raw.to?.uid, source = raw.from?.source;
    let direction = '';
    if (from === target && (source === 0 || source === undefined) && to && to !== target && to !== '0') direction = 'incoming';
    else if (to === target && from && from !== target && from !== '0' && (source === 0 || source === undefined ||
        source === 1 && (context.direction === 'outgoing' || context.scopeBound))) direction = 'outgoing';
    else if (!to && from === target && source === 0 && context.scopeBound && (context.direction === 'incoming' || raw.friendId === target)) direction = 'incoming';
    else if (context.direction === 'system' && (from === '0' || source !== undefined && source >= 2)) direction = 'system';
    else if (raw.kind === 'system' && (from === '0' || source !== undefined && source >= 2) && context.scopeBound) direction = 'system';
    // A centered system card is a presentation, also used for ordinary actors'
    // requests/notices. Explicit from/to wins; friend/myself CSS stays strict.
    if (context.direction && context.direction !== 'system' && direction && context.direction !== direction) fail('MESSAGE_DIRECTION_CONFLICT', '消息 DOM 方向与原始发送方、接收方不一致。');
    if (context.direction === 'incoming' && (from && (from !== target || source !== undefined && source !== 0) || to === target)) fail('MESSAGE_DIRECTION_CONFLICT', '候选人消息节点中的原始发送方不属于当前候选人。');
    if (context.direction === 'outgoing' && (from === target || to && to !== target || source !== undefined && ![0,1].includes(source))) fail('MESSAGE_DIRECTION_CONFLICT', '自己发送的消息节点与原始候选人方向不一致。');
    if (from && to && from !== target && to !== target && from !== '0' && (source === 0 || source === undefined)) fail('CONVERSATION_MISMATCH', '消息的发送方和接收方均不属于当前会话。');
    return direction;
  };
  const read = ({friend_id} = {}) => {
    const target = identifier(friend_id);
    if (!target) fail('INVALID_CONVERSATION', '缺少有效的目标会话标识。');
    if (document.visibilityState === 'hidden') fail('HIDDEN_PAGE', '请保持 BOSS 沟通标签页在前台。');
    const chats = [...document.querySelectorAll('.chat-conversation')].filter(visible);
    const lists = [...document.querySelectorAll('.chat-message-list')].filter(visible);
    if (chats.length !== 1 || lists.length !== 1) fail('AMBIGUOUS_MESSAGE_LIST', '没有唯一可见的聊天区域和消息列表，无法确认消息来源。');
    const chat = chats[0], list = lists[0];
    const inputs = [...document.querySelectorAll('.boss-chat-editor-input, #boss-chat-editor-input')].filter(visible);
    if (inputs.length > 1) fail('AMBIGUOUS_CONVERSATION', '存在多个可见聊天编辑器，无法确认候选人。');
    const legacyEditors = [...document.querySelectorAll('.chat-editor')].filter(visible);
    if (legacyEditors.length > 1) fail('AMBIGUOUS_CONVERSATION', '存在多个可见聊天编辑区域。');
    const editor = inputs[0]?.parentElement || legacyEditors[0];
    const roots = [], bindings = new Set(), listBindings = new Set();
    const addVm = vm => { if (record(vm) && !roots.includes(vm)) roots.push(vm); };
    const observeBinding = (node, ownList = false) => {
      if (!node) return;
      for (const attr of ['data-friend-id','data-uid']) {
        const claim = identifier(node.getAttribute(attr));
        if (claim) { bindings.add(claim); if (ownList) listBindings.add(claim); }
      }
      const vm = node.__vue__; addVm(vm);
      const parents = [vm, value(vm, '$parent')];
      for (const owner of parents) {
        addVm(owner);
        for (const container of containers(owner)) {
          const direct = explicitFriend(container); if (direct) { bindings.add(direct); if (ownList) listBindings.add(direct); }
          for (const key of ['conversation$', 'conversation', 'currentConversation', 'selectedFriend']) {
            for (const raw of [value(container, key), value(value(value(owner, '$observables'), key), '_value')]) {
              const claim = conversationFriend(raw);
              if (claim) { bindings.add(claim); if (ownList) listBindings.add(claim); }
            }
          }
        }
      }
    };
    observeBinding(chat); observeBinding(list, true); observeBinding(editor);
    if (!bindings.size || bindings.size !== 1 || !bindings.has(target)) fail('CONVERSATION_MISMATCH', '当前聊天、消息列表与目标候选人的会话标识不一致。');
    if (!chat.contains(list) && (!listBindings.size || !listBindings.has(target))) fail('UNBOUND_MESSAGE_LIST', '消息列表没有明确绑定当前候选人。');
    const nodes = [...list.querySelectorAll('*')];
    if (nodes.length > 4000) fail('MESSAGE_LIMIT', '当前消息列表超过 4000 个节点，请减少已加载历史后重试。');
    const items = [...list.querySelectorAll('.message-item')].filter(visible);
    if (items.length > 500) fail('MESSAGE_LIMIT', '当前已加载消息超过 500 条，请分次读取。');
    if (items.some(item => items.some(other => item !== other && other.contains(item)))) fail('AMBIGUOUS_MESSAGE', '聊天消息节点存在嵌套歧义。');
    let signatureSize = 0;
    const signature = JSON.stringify(items.map(item => {
      const text = item.textContent || ''; signatureSize += text.length;
      if (signatureSize > 2 * 1024 * 1024) fail('MESSAGE_LIMIT', '可见消息内容超过安全校验范围，请分次读取。');
      return [nodeKey(item), item.getAttribute('data-mid'), item.getAttribute('data-message-id'), item.getAttribute('data-msg-id'),
        item.querySelector('.item-friend') ? 'incoming' : item.querySelector('.item-myself') ? 'outgoing' : item.querySelector('.item-system') ? 'system' : '', text];
    }));
    const scope = {friend:target, chat, list, editor, input:inputs[0] || null, signature};
    if (historyCache && (!sameScope(historyCache.scope, scope) || Date.now() >= historyCache.expires)) historyCache = null;
    const activeHistory = historyCache;
    const rows = new Map(), unresolved = new Set(), visibleAttachments = new Set(), unresolvedAttachments = new Set(), warnings = [], domScopes = new Map();
    let walked = 0;
    const packetShape = raw => record(raw) && (packetId(raw) || record(value(raw,'from'))) &&
      (record(value(raw,'body')) || typeof value(raw,'body') === 'string' || typeof value(raw,'text') === 'string' || typeof value(raw,'content') === 'string' || typeof value(raw,'pushText') === 'string');
    const walk = (root, callback, domId = '') => {
      const seen = new WeakSet();
      const visit = (candidate, depth) => {
        if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) return;
        seen.add(candidate);
        if (++walked > 12000) fail('MESSAGE_LIMIT', '消息组件数据超过安全遍历上限，请分次读取。');
        if (packetShape(candidate)) { callback(candidate, domId); return; }
        if (depth > 6) fail('MESSAGE_LIMIT', '消息组件数据嵌套超过安全读取范围。');
        if (Array.isArray(candidate)) {
          if (candidate.length > 500) fail('MESSAGE_LIMIT', '组件中的消息数组超过 500 条。');
          for (const item of candidate) visit(item, depth + 1);
          return;
        }
        let keys;
        try { keys = Object.keys(candidate).filter(key => {
          if (secret.test(key) || key.startsWith('_') || key.startsWith('$')) return false;
          const property = descriptor(candidate, key);
          return property && ('value' in property ? typeof property.value !== 'function' : Boolean(property.get && known.has(key)));
        }); }
        catch { fail('UNREADABLE_COMPONENT', '消息组件字段无法安全读取。'); }
        if (keys.length > 32) fail('MESSAGE_LIMIT', '消息组件包含超过 32 个数据字段，无法安全读取。');
        for (const key of keys) {
          const item = value(candidate, key);
          if (item && typeof item === 'object' && !(typeof Node !== 'undefined' && item instanceof Node)) visit(item, depth + 1);
        }
      };
      visit(root, 0);
    };
    const normalizedDirection = (raw, context) => directionFor(raw, target, context);
    const add = (packet, context, domId = '') => {
      const raw = sanitize(packet, domId);
      if (!raw) return false;
      const previous = rows.get(raw.mid);
      const effective = previous && previous.scope_bound && !context.direction ? {direction:previous.direction, scopeBound:true} : context;
      const direction = normalizedDirection(raw, effective);
      if (!direction) return false;
      // A title supplies display metadata only after the original packet proves
      // its stable ID, incoming sender and received-card structure. It never
      // supplies identity, direction or download permission.
      if (direction === 'incoming' && context.item && packetId(packet) &&
          [1,9].includes(raw.body?.hyperLink?.hyperLinkType) && raw.body.hyperLink.url && !hasAttachmentName(raw)) {
        const titles = [...context.item.querySelectorAll('.message-card-top-title')].filter(visible);
        const title = titles.length === 1 ? (titles[0].textContent || '').trim() : '';
        if (title && title.length <= 240) raw.attachment_name = title;
      }
      if (previous) {
        if (previous.direction !== direction) fail('MESSAGE_DIRECTION_CONFLICT', '相同消息标识对应了不同消息方向。');
        previous.raw = mergeRaw(previous.raw, raw); previous.scope_bound ||= context.scopeBound;
      } else rows.set(raw.mid, {raw, friend_id:target, direction, scope_bound:Boolean(context.scopeBound)});
      if (rows.size > 500) fail('MESSAGE_LIMIT', '读取到的稳定消息超过 500 条，请分次导入。');
      return true;
    };
    for (const item of items) {
      const ids = ['data-mid','data-message-id','data-msg-id'].map(attr => identifier(item.getAttribute(attr))).filter(Boolean);
      if (new Set(ids).size > 1) fail('MESSAGE_ID_CONFLICT', '消息节点包含冲突的稳定标识。');
      const domId = ids[0] || '';
      const explicit = firstId(item.getAttribute('data-friend-id'), item.getAttribute('data-uid'));
      if (explicit && explicit !== target) fail('CONVERSATION_MISMATCH', '可见消息节点属于另一位候选人。');
      const directions = [];
      for (const [selector, direction] of [['.item-friend','incoming'],['.item-myself','outgoing'],['.item-system','system']]) {
        const found = [...item.querySelectorAll(selector)]; if (item.matches(selector)) found.unshift(item);
        if (found.length > 1) fail('MESSAGE_DIRECTION_CONFLICT', '同一消息包含多个方向节点。');
        if (found.length) directions.push(direction);
      }
      if (directions.length > 1) fail('MESSAGE_DIRECTION_CONFLICT', '同一消息混合了候选人、自己或系统方向。');
      const direction = directions[0] || '';
      const previewText = item.querySelector('.message-card-buttons .card-btn')?.textContent || item.textContent || '';
      const preview = direction === 'incoming' && Boolean(item.querySelector('.resume-icon') && item.querySelector('.message-card-top-title') || item.querySelector('[data-attachment-name]')) &&
        /预览|下载|查看/.test(previewText);
      if (preview) visibleAttachments.add(item);
      let foundPacket = false, accepted = false, attachmentResolved = false;
      const itemMids = new Set();
      const componentSeen = new Set();
      const context = {direction, scopeBound:true, item};
      const bindDom = mid => {
        if (!mid) return;
        const previous = domScopes.get(mid);
        if (previous && previous.item !== item) fail('AMBIGUOUS_MESSAGE', '多个可见消息节点重复绑定了同一消息标识。');
        domScopes.set(mid, {...context, item});
      };
      bindDom(domId);
      for (const node of [item, ...item.querySelectorAll('*')]) {
        const vm = node.__vue__;
        if (!record(vm) || componentSeen.has(vm)) continue;
        componentSeen.add(vm);
        for (const container of containers(vm)) walk(container, packet => {
          foundPacket = true;
          const mid = packetId(packet) || domId; if (mid) itemMids.add(mid);
          if (itemMids.size > 1) fail('AMBIGUOUS_MESSAGE', '单个消息节点绑定了多个不同消息。');
          bindDom(mid);
          const ok = add(packet, context, domId); accepted ||= ok;
          const raw = sanitize(packet, domId);
          if (ok && rows.get(raw.mid).direction === 'incoming' && [1,9].includes(raw?.body?.hyperLink?.hyperLinkType) && raw.body.hyperLink.url) {
            visibleAttachments.add(item); attachmentResolved = hasAttachmentName(rows.get(raw.mid).raw);
          }
        }, domId);
      }
      // DOM IDs are valid evidence, but a direction class alone cannot fabricate a sender UID.
      if (!foundPacket && domId && item.hasAttribute('data-from-id')) {
        accepted = add({mid:domId, friendId:explicit || undefined, from:{uid:item.getAttribute('data-from-id'),source:0},
          to:item.hasAttribute('data-to-id') ? {uid:item.getAttribute('data-to-id'),source:0} : undefined,
          text:item.querySelector('.text')?.textContent || ''}, context, domId);
      }
      if (!accepted) unresolved.add(item);
      if (visibleAttachments.has(item) && !attachmentResolved) unresolvedAttachments.add(item);
    }
    // Compatibility for already loaded arrays on this chat/list/editor, never global page stores.
    const stateKeys = ['messages','messageList','messageList$','historyMsgList','historyList$','historyList','msgList','messages$'];
    const seenArrays = new Set();
    for (const vm of roots) for (const container of containers(vm)) for (const key of stateKeys) {
      const sources = [value(container, key), value(value(value(vm, '$observables'), key), '_value')];
      for (const array of sources) {
        if (!Array.isArray(array) || seenArrays.has(array)) continue;
        seenArrays.add(array);
        if (array.length > 500) fail('MESSAGE_LIMIT', '已加载的聊天消息数组超过 500 条。');
        for (const packet of array) if (packetShape(packet)) add(packet, domScopes.get(packetId(packet)) || {direction:'', scopeBound:Boolean(explicitFriend(packet) === target)});
      }
    }
    if (activeHistory) for (const row of activeHistory.rows) {
      const domContext = domScopes.get(row.raw.mid);
      // The validated API request already establishes the actor for missing-to
      // packets. Centered presentation cannot erase that canonical direction.
      add(row.raw, domContext && domContext.direction !== 'system' ? domContext :
        {...domContext, direction:row.direction, scopeBound:true});
    }
    // State can complete a visible item only when its original, stable DOM ID agrees.
    for (const item of [...unresolved]) {
      const mid = firstId(item.getAttribute('data-mid'), item.getAttribute('data-message-id'), item.getAttribute('data-msg-id'));
      if (mid && rows.has(mid)) {
        unresolved.delete(item);
        const raw = rows.get(mid).raw;
        if ([1,9].includes(raw?.body?.hyperLink?.hyperLinkType) && raw.body.hyperLink.url && hasAttachmentName(raw)) unresolvedAttachments.delete(item);
      }
    }
    if (activeHistory) {
      const completeTitle = item => {
        const titles = [...item.querySelectorAll('.message-card-top-title')].filter(visible);
        const title = titles.length === 1 ? (titles[0].textContent || '').trim() : '';
        return title && title.length <= 240 && /\.[a-z0-9]{1,10}$/i.test(title) && !/[\u0000-\u001f\u007f…]/.test(title) && !title.includes('...') ? title : '';
      };
      const titleCounts = new Map();
      for (const item of visibleAttachments) { const title = completeTitle(item); if (title) titleCounts.set(title, (titleCounts.get(title) || 0) + 1); }
      for (const item of [...unresolvedAttachments]) {
        const title = completeTitle(item);
        if (!title || titleCounts.get(title) !== 1) continue;
        const matches = activeHistory.rows.filter(row => row.direction === 'incoming' && [1,9].includes(row.raw.body?.hyperLink?.hyperLinkType) &&
          row.raw.body.hyperLink.url && [row.raw.attachment_name, row.raw.attachment?.name, row.raw.body.hyperLink.fileName,
            row.raw.body.hyperLink.name, row.raw.body.hyperLink.title].some(name => typeof name === 'string' && name.trim() === title));
        if (matches.length === 1) { unresolved.delete(item); unresolvedAttachments.delete(item); }
      }
    }
    if (unresolved.size) warnings.push(activeHistory?
      `${unresolved.size} 条页面消息未能直接绑定原始消息标识；已另读取当前会话记录。`:
      `${unresolved.size} 条可见消息缺少可核验的原始消息标识或方向，未导入。`);
    if (unresolvedAttachments.size) warnings.push(activeHistory?
      `${unresolvedAttachments.size} 张页面附件卡尚未逐一对应；仅处理会话记录中已核验的附件消息。`:
      `${unresolvedAttachments.size} 张可见附件卡缺少可核验的原始消息，未作为已收到附件。`);
    lastScope = scope;
    return {rows:[...rows.values()], visible_count:items.length, unresolved_count:unresolved.size,
      visible_attachment_count:visibleAttachments.size, unresolved_attachments:unresolvedAttachments.size, warnings,
      history_loaded:Boolean(activeHistory), history_count:activeHistory?.rows.length || 0};
  };
  const publicFailure = error => ({ok:false, status:'blocked', code:error?.hrmMessageSafe ? error.code : 'HISTORY_READ_FAILED',
    error:error?.hrmMessageSafe ? error.message : '聊天历史读取被网络或浏览器阻断，请在官方页面核对后重试。'});
  const loadHistory = async ({friend_id, count = 100} = {}) => {
    let scope;
    try {
      const target = identifier(friend_id);
      if (!target || !Number.isSafeInteger(count) || count < 1 || count > 100) fail('INVALID_HISTORY_REQUEST', '聊天历史读取仅支持有效会话和 1 至 100 条消息。');
      if (location.protocol !== 'https:' || !['www.zhipin.com','zhipin.com'].includes(location.hostname)) fail('WRONG_ORIGIN', '聊天历史只能从当前已登录的 BOSS 官方页面读取。');
      const initial = read({friend_id:target}); scope = lastScope;
      if (initial.history_loaded && historyCache.requestCount >= count) return {ok:true, status:'history-loaded', history_loaded:true, history_count:initial.history_count};
      if (loading) {
        if (sameScope(loading.scope, scope) && loading.count >= count) return await loading.promise;
        fail('HISTORY_BUSY', '另一条聊天历史读取尚未完成，请等待后重新核对当前会话。');
      }
      const request = async () => {
        const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 15000);
        const assertScope = () => {
          read({friend_id:target});
          if (!sameScope(scope, lastScope)) fail('HISTORY_SCOPE_CHANGED', '读取期间聊天、消息列表或可见消息已变化，本次历史不会导入。');
        };
        try {
          assertScope();
          const url = new URL('/wapi/zpchat/boss/historyMsg', location.origin);
          url.searchParams.set('gid', target); url.searchParams.set('c', String(count)); url.searchParams.set('src', '0');
          const response = await fetch(url.href, {method:'GET', credentials:'include', redirect:'error', signal:abort.signal});
          assertScope();
          if (response.status === 401) fail('AUTH_REQUIRED', 'BOSS 登录状态已失效，请人工登录后重新读取聊天。');
          if (response.status === 403) fail('HISTORY_PERMISSION_DENIED', 'BOSS 未允许读取当前会话历史，请在官方页面核对。');
          if (response.status === 429) fail('ACCOUNT_BLOCKED', 'BOSS 限制了聊天历史读取频率，已停止采集。');
          if (!response.ok || response.status !== 200 || response.redirected || response.type === 'opaqueredirect' || response.url && response.url !== url.href) fail('HISTORY_RESPONSE_REJECTED', '聊天历史接口未返回有效响应，不会导入未知内容。');
          const limit = 2 * 1024 * 1024;
          if (Number(response.headers.get('content-length')) > limit) fail('HISTORY_TOO_LARGE', '聊天历史响应超过 2 MiB，未导入。');
          if (!response.body?.getReader) fail('HISTORY_RESPONSE_REJECTED', '浏览器没有提供可校验大小的聊天历史响应。');
          const reader = response.body.getReader(), chunks = []; let size = 0;
          try {
            for (;;) {
              const next = await reader.read(); assertScope();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > limit) fail('HISTORY_TOO_LARGE', '聊天历史响应超过 2 MiB，未导入。');
              chunks.push(next.value);
            }
          } catch (error) { abort.abort(); await reader.cancel().catch(() => {}); throw error; }
          finally { reader.releaseLock(); }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          let payload;
          try { payload = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes).replace(/^\uFEFF/, '')); }
          catch { fail('HISTORY_RESPONSE_REJECTED', '聊天历史返回了登录页或未知内容，未导入。'); }
          if ([9,32,35,36,'9','32','35','36'].includes(payload?.code) || /安全验证|访问过于频繁|账号.*异常|环境.*异常/.test(typeof payload?.message === 'string' ? payload.message : '')) fail('ACCOUNT_BLOCKED', 'BOSS 限制了当前账号或请求环境，已停止读取聊天。');
          if ([37,'37',401,'401'].includes(payload?.code)) fail('AUTH_REQUIRED', 'BOSS 登录凭据已失效，请人工重新登录。');
          if (![0,'0'].includes(payload?.code)) fail('HISTORY_RESPONSE_REJECTED', 'BOSS 没有确认本次聊天历史读取成功，未导入。');
          const data = payload.zpData;
          const packets = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : Array.isArray(data?.messageList) ? data.messageList : null;
          if (!packets || packets.length > count) fail('HISTORY_RESPONSE_REJECTED', '聊天历史消息容器不受支持或超过本次读取数量。');
          const canonical = new Map();
          for (const packet of packets) {
            const raw = record(packet) ? sanitize(packet, '') : null;
            const declared = value(packet,'friendId') ?? value(packet,'friend_id');
            if (!raw?.mid || !raw.from || declared !== undefined && !identifier(declared)) fail('HISTORY_PACKET_INVALID', '历史消息缺少真实消息标识或有效发送方，未导入。');
            const apiContext = {scopeBound:true, direction:raw.from.uid === '0' || raw.from.source !== undefined && raw.from.source >= 2 ? 'system' :
              !raw.to && raw.from.uid === target && raw.from.source === 0 ? 'incoming' : ''};
            const direction = directionFor(raw, target, apiContext);
            if (!direction) fail('HISTORY_PACKET_INVALID', '历史消息的归属或方向无法确认，未导入。');
            const previous = canonical.get(raw.mid);
            if (previous) {
              if (previous.direction !== direction) fail('MESSAGE_DIRECTION_CONFLICT', '历史中相同消息标识对应不同方向。');
              previous.raw = mergeRaw(previous.raw, raw);
            } else canonical.set(raw.mid, {raw, friend_id:target, direction, scope_bound:true});
          }
          assertScope();
          historyCache = {scope, rows:[...canonical.values()], requestCount:count, expires:Date.now() + 10000};
          const verified = read({friend_id:target});
          if (!verified.history_loaded) fail('HISTORY_SCOPE_CHANGED', '聊天历史归属校验未完成，本次数据未导入。');
          return {ok:true, status:'history-loaded', history_loaded:true, history_count:verified.history_count};
        } finally { clearTimeout(timeout); }
      };
      const pending = {scope, count, promise:null};
      loading = pending;
      pending.promise = request().catch(error => { historyCache = null; return publicFailure(error); }).finally(() => { if (loading === pending) loading = null; });
      return await pending.promise;
    } catch (error) { historyCache = null; return publicFailure(error); }
  };
  window.__hrmChatMessageSource = {version:VERSION, revision:REVISION, ownerDocument:document, read, loadHistory};
  return {version:VERSION, revision:REVISION};
}

// Explicit normal extension action. Only metadata crosses back from MAIN.
export async function loadChatMessageHistory(args = {}) {
  const source = window.__hrmChatMessageSource;
  if (source?.version !== 1 || source.revision !== 'history-2' || typeof source.loadHistory !== 'function') {
    return {ok:false, status:'blocked', code:'MESSAGE_SOURCE_NOT_READY', error:'聊天历史读取模块尚未就绪，请更新扩展并重新打开导入窗口。'};
  }
  return await source.loadHistory(args);
}
