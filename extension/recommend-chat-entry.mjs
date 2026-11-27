// Self-contained MAIN-world read. It does not call page methods, make requests,
// click controls, or inspect credential fields. The selected card's encrypted ID
// is a binding check only; it can never become the chat UID.
export function readRecommendChatEntry(args = {}) {
  const unavailable = reason => ({ok:true, status:'unavailable', reason});
  const conflict = () => ({ok:false, status:'identity-conflict',
    error:'当前简历与选中候选人的身份不一致，未保存聊天入口。'});
  const object = value => value && typeof value === 'object' ? value : null;
  const encryptedId = value => typeof value === 'string' && /^[A-Za-z0-9_~-]{1,160}$/.test(value) ? value : '';
  const nameKey = value => typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*') : '';
  const numericUid = value => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
    return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : '';
  };
  // Only this fixed vocabulary crosses the page boundary on failure. Never
  // return exception messages/stacks, which can contain page data or credentials.
  let stage = 'argument_validation';
  try {
    const expectedName = nameKey(args.name), expectedId = encryptedId(args.expected_platform_geek_id);
    if (!expectedName || expectedName.length > 120 || !expectedId) return unavailable('missing_card_identity');
    if (!['text','canvas'].includes(args.kind)) return unavailable('unsupported_detail');
    stage = 'page_validation';
    const page = new URL(location.href);
    if (page.protocol !== 'https:' || !['www.zhipin.com','zhipin.com'].includes(page.hostname)) return unavailable('unsupported_page');

    const visible = element => {
      if (!element?.isConnected || element.hidden || element.closest('[hidden],[aria-hidden="true"]')) return false;
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      for (let node = element, depth = 0; node && depth < 40; node = node.parentElement, depth++) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || ['hidden','collapse'].includes(style.visibility)) return false;
      }
      return true;
    };
    stage = 'detail_lookup';
    const dialogs = [...document.querySelectorAll('.dialog-lib-resume')].filter(visible);
    if (dialogs.length > 1) return conflict();
    const dialog = dialogs[0];
    if (!dialog) return unavailable('no_visible_detail');
    const wraps = [...dialog.querySelectorAll('.resume-detail-wrap,.resume-left')].filter(visible);
    if (!wraps.length) return unavailable('no_resume_body');
    stage = 'frame_binding';
    const frames = [...dialog.querySelectorAll('.resume-detail-wrap iframe')].filter(visible);
    if (frames.length > 1) return conflict();
    const frame = frames[0];
    if (args.kind === 'canvas' && !frame) return unavailable('missing_canvas_frame');
    if (args.kind === 'text' && frame) return unavailable('detail_kind_changed');
    if (frame) {
      const source = new URL(frame.getAttribute('src') || '', page.href);
      if (source.origin !== page.origin || source.username || source.password
          || !/^\/web\/frame\/c-resume\/?$/.test(source.pathname)) return unavailable('untrusted_canvas_frame');
    }

    // Vue 2 attaches __vue__ to component roots. Walk only this detail's DOM
    // ancestors and their bounded component-parent chains, never page-wide stores.
    stage = 'vue_lookup';
    const roots = new Set(), visited = new Set();
    for (const seed of [dialog,...wraps,...frames]) {
      for (let node = seed, depth = 0; node && dialog.contains(node) && depth < 24; node = node.parentElement, depth++) {
        for (let vm = object(node.__vue__), parents = 0; vm && parents < 16; vm = object(vm.$parent), parents++) {
          if (visited.has(vm)) break;
          visited.add(vm);
          const element = vm.$el;
          if (vm.$options?.name === 'ResumeRoot' && element?.nodeType === 1
              && dialog.contains(element) && visible(element)) roots.add(vm);
        }
      }
    }
    const bound = [...roots].filter(vm => frame ? vm.$refs?.iframe === frame && vm.$el.contains(frame)
      : wraps.some(wrap => vm.$el === wrap || vm.$el.contains(wrap)));
    if (bound.length > 1) return conflict();
    const root = bound[0];
    if (!root) return unavailable('unbound_resume_component');
    stage = 'resume_fields';
    if (root.loading === true) return unavailable('detail_loading');
    const resume = object(root.resumeInfo), base = object(resume?.geekBaseInfo);
    const current = object(root.currGeek), source = object(root.dataSource);
    stage = 'identity_binding';
    const selectedIds = [encryptedId(current?.encryptGeekId), encryptedId(source?.encryptGeekId)].filter(Boolean);
    const baseId = encryptedId(base?.encryptGeekId), candidateName = typeof base?.name === 'string' ? base.name : '';
    if (!base || !baseId || !selectedIds.length || !candidateName) return unavailable('missing_resume_identity');
    if (baseId !== expectedId || selectedIds.some(id => id !== expectedId) || nameKey(candidateName) !== expectedName) return conflict();
    const uid = numericUid(base.userId);
    if (!uid) return unavailable('missing_numeric_uid');

    // Refuse a reused/disconnected component or a synchronous identity change.
    stage = 'final_recheck';
    if (!visible(dialog) || !visible(root.$el) || root.resumeInfo !== resume || object(root.currGeek) !== current
        || object(root.dataSource) !== source || encryptedId(base.encryptGeekId) !== baseId
        || numericUid(base.userId) !== uid || nameKey(base.name) !== expectedName
        || encryptedId(current?.encryptGeekId) && encryptedId(current.encryptGeekId) !== expectedId
        || encryptedId(source?.encryptGeekId) && encryptedId(source.encryptGeekId) !== expectedId
        || frame && (!visible(frame) || root.$refs?.iframe !== frame || !root.$el.contains(frame))) return conflict();
    return {ok:true, status:'available', boss_chat_uid:uid, platform_geek_id:baseId,
      candidate_name:candidateName.slice(0,120)};
  } catch {
    return {...unavailable('read_failed'), stage};
  }
}
