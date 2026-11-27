// Applies saved, job-specific filters using rendered controls only. No page
// application state or private network endpoints are read by this adapter.
(() => {
  if (window.__hrmSearch?.version === 1) return;
  const D = window.__hrmDom;
  const fields = {
    salary: ['薪资区间', '薪资待遇'], activity: ['牛人活跃度'],
    job_hopping: ['跳槽频率'], job_status: ['求职状态'],
    position_requirements: ['牛人职位要求'], major: ['专业'],
  };
  const sorts = ['综合排序', '活跃优先', '匹配度优先'];
  const checks = {
    exclude_viewed_14d: '过滤近14天查看',
    exclude_contacted_30d: '近30天未和同事交换简历',
  };
  const menuSelector = '[role="listbox"],[role="menu"],.dropdown-menu,.filter-options,.select-dropdown';
  const optionSelector = '[role="option"],[role="menuitem"],[role="menuitemcheckbox"],.options li,.filter-option';
  const majorRemoveSpan = 'span[data-v-47b50b11],span[data-v-dbaea6c4],span[data-v-477f84ae]';
  const modalSelector = '[role="dialog"],dialog,[aria-modal="true"],.dialog-lib-resume,.resume-detail-wrap,.major-dialog';
  const triggerSelector = 'button,[role="combobox"],[aria-haspopup],[aria-controls],.dropdown-flip,.double-select-flip,.input-container,.major-input-ui,.filter-trigger';
  const norm = value => String(value ?? '').replace(/[\s\u200b-\u200d\ufeff]+/g, '').trim();
  const label = element => norm(D.text(element));
  const unique = values => [...new Set(values)];
  const one = (values, message) => {
    values = unique(values);
    if (values.length !== 1) throw Error(message + (values.length ? '（匹配到多个控件）' : '（未找到控件）'));
    return values[0];
  };
  const matches = (element, selector) => element?.matches?.(selector);
  const selected = element => element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-checked') === 'true' ||
    element.getAttribute('aria-pressed') === 'true' || element.classList.contains('selected') || element.classList.contains('active') || element.classList.contains('cur');
  let generation = 0, stopped = false, busy = false;

  // __hrmDom intentionally omits native form values from text extraction. Walk
  // its same composed tree to locate controls, including visually hidden inputs
  // whose associated labels are rendered. Never traverse into other frames.
  function all(root, selector, visibleOnly = true) {
    const result = [], seen = new Set(); let count = 0;
    function visit(node, depth) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (++count > 40000 || depth > 100) throw Error('筛选区域过大，无法确认控件');
      if (node.nodeType === 1) {
        if (matches(node, selector) && (!visibleOnly || D.visible(node))) result.push(node);
        if (matches(node, 'iframe,frame,script,style,template')) return;
      }
      const assigned = node.tagName === 'SLOT' && node.assignedNodes?.({flatten: true});
      const children = assigned?.length ? assigned : D.shadow(node)?.childNodes || node.childNodes || [];
      for (const child of children) visit(child, depth + 1);
    }
    visit(root, 0);
    return result;
  }
  function exact(root, text) {
    const view = D.view(root), wanted = norm(text);
    if (view.stats.truncated) throw Error('筛选区域文字过多，无法确认');
    const found = view.elements.filter(element => norm(view.texts.get(element)) === wanted);
    return found.filter(element => !found.some(child => child !== element && D.contains(element, child)));
  }
  function originOK() {
    try { const u = new URL(location.href || location.origin); return u.protocol === 'https:' && ['www.zhipin.com', 'zhipin.com'].includes(u.hostname); }
    catch { return false; }
  }
  const frameKey = () => (location.origin || '') + (location.pathname || '') + (location.search || '');
  function frameVisible() {
    try {
      for (let child = window; child.top && child !== child.top; child = child.parent) {
        const frame = child.frameElement;
        if (!frame || !frame.getClientRects().length) return false;
        if (frame.checkVisibility && !frame.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return false;
        const rect = frame.getBoundingClientRect();
        if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= child.parent.innerWidth || rect.top >= child.parent.innerHeight) return false;
      }
      return true;
    } catch { return false; }
  }
  function forbidden(allowed) {
    return all(document.documentElement, modalSelector).some(element => !allowed || !(element === allowed || D.contains(allowed, element)));
  }
  function discover() {
    if (!D?.version || !originOK()) throw Error('仅支持 BOSS HTTPS 搜索页面');
    if (!frameVisible()) throw Error('搜索页面所在框架当前不可见');
    if (forbidden()) throw Error('请关闭简历详情或弹窗后再应用平台查询条件');
    const roots = [];
    for (const heading of exact(document.documentElement, '其他筛选')) {
      let root = D.parent(heading);
      while (root && !sorts.every(text => exact(root, text).length)) root = D.parent(root);
      if (root) roots.push(root);
    }
    const root = one(roots, '未识别到唯一的 BOSS 搜索筛选区域');
    // Multiple toolbars, even inside the same page root, are ambiguous.
    for (const text of sorts) one(exact(root, text), '排序栏不唯一：' + text);
    const heading = one(exact(root, '其他筛选'), '其他筛选区域不唯一');
    const filters = D.closest(heading, '#params-container,[data-search-filters],.search-filters') || root;
    return {root, filters};
  }
  function configOf(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('平台查询条件格式无效');
    const config = {enabled: input.enabled === true};
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw Error('平台查询条件启用状态无效');
    for (const key of [...Object.keys(fields), 'sort']) {
      const value = input[key] ?? '';
      if (typeof value !== 'string' || value.length > 80 || /[\r\n\x00-\x1f]/.test(value)) throw Error('平台查询条件内容无效：' + key);
      config[key] = value.trim();
    }
    if (config.sort && !sorts.includes(config.sort)) throw Error('排序方式无效');
    for (const key of Object.keys(checks)) {
      if (input[key] != null && typeof input[key] !== 'boolean') throw Error('平台查询条件开关无效：' + key);
      config[key] = input[key] ?? null;
    }
    return config;
  }
  function fieldOf(region, key) {
    const titles = fields[key], candidates = [];
    const add = (wrapper, trigger, type = 'menu') => {
      if (wrapper && trigger && D.visible(wrapper) && D.visible(trigger)) candidates.push({key, title: titles[0], wrapper, trigger, type});
    };
    const keyed = all(region.filters, '[data-search-field],[data-filter],[data-field]').filter(element =>
      ['data-search-field', 'data-filter', 'data-field'].some(attr => element.getAttribute(attr) === key));
    for (const wrapper of keyed) {
      const triggers = all(wrapper, triggerSelector).filter(element => !D.closest(element, menuSelector));
      add(wrapper, one(triggers.filter(element => !triggers.some(parent => parent !== element && D.contains(parent, element))), '筛选入口不唯一：' + titles[0]));
    }
    if (!keyed.length) {
      // Selectors below are evidenced by the user-provided saved search HTML
      // and its local stylesheet. Scoped attributes are version-specific;
      // when absent we stop instead of assuming a field's ordinal position.
      if (key === 'salary') for (const wrapper of all(region.filters, '.salary-container'))
        add(wrapper, one(all(wrapper, '.double-select-flip'), '薪资入口不唯一'), 'salary');
      if (key === 'activity' || key === 'job_hopping') {
        for (const input of all(region.filters, 'input[placeholder]', false).filter(input => titles.includes(input.getAttribute('placeholder')))) {
          const wrapper = D.closest(input, '.dropdown-wrap');
          if (wrapper) add(wrapper, one(all(wrapper, '.dropdown-flip'), '筛选入口不唯一：' + titles[0]));
        }
      }
      if (key === 'job_status' || key === 'position_requirements') {
        const version = key === 'job_status' ? '.mutil-select[data-v-78445001]' : '.mutil-select[data-v-40b33510]';
        const wrappers = unique([...all(region.filters, version), ...titles.flatMap(title => exact(region.filters, title).map(element => D.closest(element, '.mutil-select')).filter(Boolean))]);
        for (const wrapper of wrappers) add(wrapper, one(all(wrapper, '.input-container'), '筛选入口不唯一：' + titles[0]), 'multi');
      }
      if (key === 'major') for (const trigger of all(region.filters, '.major-input-ui').filter(element => !element.hasAttribute('data-v-5157faa1')))
        add(D.parent(trigger), trigger, 'major');
      if (!candidates.length) {
        for (const title of titles) for (const element of exact(region.filters, title)) {
          let wrapper = D.closest(element, '[data-filter-field],.filter-field,.filter-2-item,label');
          if (!wrapper) continue;
          let controls = all(wrapper, triggerSelector).filter(control => !D.closest(control, menuSelector));
          controls = unique(controls).filter(control => !controls.some(parent => parent !== control && D.contains(parent, control)));
          if (controls.length) add(wrapper, one(controls, '筛选入口不唯一：' + title));
        }
      }
    }
    const found = unique(candidates.map(item => item.trigger));
    const trigger = one(found, '无法确认筛选字段：' + titles[0]);
    const result = candidates.find(item => item.trigger === trigger);
    if (matches(result.wrapper, '.mutil-select') || result.wrapper.getAttribute('data-multiple') === 'true') result.type = 'multi';
    return result;
  }
  function boundMenus(field, visibleOnly = true) {
    const ids = unique(['aria-controls', 'aria-owns'].flatMap(attr => (field.trigger.getAttribute(attr) || '').split(/\s+/)).filter(Boolean));
    if (ids.length) {
      return ids.map(id => one(all(field.trigger.getRootNode(), '[id]', false).filter(element => element.id === id), '筛选菜单绑定无效：' + field.title))
        .filter(element => (!visibleOnly || D.visible(element)) && matches(element, menuSelector));
    }
    return all(field.wrapper, menuSelector, visibleOnly).filter(element => !all(field.wrapper, menuSelector, visibleOnly).some(parent => parent !== element && D.contains(parent, element)));
  }
  function options(menu) {
    const found = all(menu, optionSelector);
    return found.filter(element => !found.some(parent => parent !== element && D.contains(parent, element)));
  }
  function displayed(field) {
    const values = [];
    const aria = field.trigger.getAttribute('aria-valuetext'); if (aria) values.push(norm(aria));
    for (const input of all(field.trigger, 'input', false)) if (input.type !== 'hidden' && input.value) values.push(norm(input.value));
    const tags = all(field.trigger, '.select-item,.selected-value,[data-selected-value]');
    if (tags.length) return tags.map(element => norm(element.getAttribute('data-selected-value') || D.text(element)));
    const text = label(field.trigger); if (text) values.push(text);
    return unique(values);
  }
  function salaryRange(value) {
    const match = norm(value).match(/^(\d+(?:\.\d+)?)[kK]?[-~～至](\d+(?:\.\d+)?)[kK]$/);
    return match && Number(match[1]) <= Number(match[2]) ? [Number(match[1]), Number(match[2])] : null;
  }
  function equivalent(field, actual, expected) {
    if (norm(actual) === norm(expected)) return true;
    if (field.type !== 'salary') return false;
    const a = salaryRange(actual), b = salaryRange(expected);
    return Boolean(a && b && a[0] === b[0] && a[1] === b[1]);
  }
  function isValue(field, expected) {
    if (!field.trigger.isConnected || !D.visible(field.trigger) || !D.contains(field.wrapper, field.trigger)) return false;
    const values = displayed(field);
    if (field.type === 'multi' && values.length !== 1) return false;
    if (values.some(value => equivalent(field, value, expected))) return true;
    const picked = boundMenus(field).flatMap(menu => options(menu).filter(selected));
    return picked.length === 1 && equivalent(field, label(picked[0]), expected);
  }
  function enabledControl(element) {
    return !element.disabled && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true' && !element.classList.contains('disabled');
  }
  function checkboxOf(region, key) {
    const text = checks[key];
    const nodes = exact(region.root, text);
    const candidates = [];
    for (const node of nodes) {
      const labelNode = D.closest(node, 'label,[role="checkbox"]');
      if (matches(labelNode, '[role="checkbox"]')) candidates.push({control: labelNode, click: labelNode});
      else if (labelNode) {
        const own = all(labelNode, 'input[type="checkbox"]', false);
        if (labelNode.getAttribute('for')) own.push(...all(labelNode.getRootNode(), 'input[type="checkbox"]', false).filter(input => input.id === labelNode.getAttribute('for')));
        candidates.push({control: one(own, '复选框不唯一：' + text), click: labelNode});
      } else {
        const controls = all(region.root, '[role="checkbox"][aria-label]').filter(control => norm(control.getAttribute('aria-label')) === norm(text));
        for (const control of controls) candidates.push({control, click: control});
      }
    }
    // aria-label is a valid accessible name even when no text child is drawn.
    for (const control of all(region.root, '[role="checkbox"][aria-label]').filter(control => norm(control.getAttribute('aria-label')) === norm(text)))
      candidates.push({control, click: control});
    const control = one(candidates.map(item => item.control), '无法确认复选框：' + text);
    return {...candidates.find(item => item.control === control), key, title: text};
  }
  function checked(item) {
    if (item.control.tagName === 'INPUT') return item.control.checked;
    const value = item.control.getAttribute('aria-checked');
    if (!['true', 'false'].includes(value)) throw Error('复选框状态无法确认：' + item.title);
    return value === 'true';
  }
  function sortOf(region, value) {
    const node = one(exact(region.root, value), '无法确认排序选项：' + value);
    const trigger = D.closest(node, 'button,[role="tab"],[role="radio"],.search-label,[data-sort]') || node;
    return {trigger, value};
  }

  async function apply(input) {
    const config = configOf(input);
    if (!config.enabled) return {applied: true, summary: []};
    if (busy) throw Error('正在应用平台查询条件');
    if (stopped) throw Error('平台查询条件操作已停止');
    const region = discover(), token = generation, initialURL = location.href || frameKey();
    let allowedModal = null, openingMajor = false, results = null;
    const guard = () => {
      if (stopped || token !== generation) throw Error('平台查询条件操作已停止');
      if (!originOK() || !frameVisible() || (location.href || frameKey()) !== initialURL || !region.root.isConnected || !region.filters.isConnected)
        throw Error('搜索页面已变化，未继续应用平台查询条件');
      if (openingMajor && !allowedModal) {
        const dialogs = all(document.documentElement, '.major-dialog');
        if (dialogs.length > 1) throw Error('专业选择窗口不唯一');
        allowedModal = dialogs[0] || null;
      }
      if (forbidden(allowedModal)) throw Error('搜索页面出现简历详情或其他弹窗，已停止操作');
    };
    const pause = async () => { await new Promise(resolve => setTimeout(resolve, 100)); guard(); };
    const waitFor = async (read, error, stable = false) => {
      let count = 0;
      for (let i = 0; i < 25; i++) {
        guard();
        const value = read();
        if (value && (!stable || ++count >= 2)) return value;
        if (!value) count = 0;
        await pause();
      }
      throw Error(error);
    };
    const click = element => {
      guard();
      if (!element?.isConnected || !D.visible(element) || !enabledControl(element)) throw Error('筛选控件不可点击');
      element.click();
    };
    const change = element => { results.mark(); click(element); };
    function watchResults() {
      if (typeof MutationObserver !== 'function') throw Error('无法观察搜索结果更新，未应用查询条件');
      const component = D.closest(region.root, '.params-and-list-container');
      if (!component || !D.contains(component, region.filters)) throw Error('未识别到搜索筛选与结果共同所在的组件');
      const scope = one(all(component, '.geek-list-wrap .left-container'), '未识别到唯一搜索结果区域');
      const list = (required = true) => {
        const lists = all(scope, '.geek-content', false).flatMap(content => [...content.children].filter(child => matches(child, '.card-list')));
        if (!required && !lists.length) return null;
        return one(lists, '搜索结果列表不唯一');
      };
      let currentList = list(), knownCards = new Set([...currentList.children].filter(node => matches(node, 'li.geek-info-card')));
      let revision = 0, baseline = 0, dirty = false, loadingSeen = false;
      const loading = () => {
        if (!scope.isConnected) throw Error('搜索结果区域已变化');
        const scoped = all(scope, '[aria-busy="true"],[role="progressbar"]').length > 0 || scope.getAttribute('aria-busy') === 'true';
        return {scoped, any: scoped || all(document.documentElement, '.toast-loading').length > 0};
      };
      const touchesList = record => {
        if (record.type !== 'childList') return false;
        // Online-status text, avatar loading and tooltips inside an old card
        // are not evidence that a new query has replaced the result set.
        return [...record.removedNodes].some(node => node === currentList || knownCards.has(node) || node.nodeType === 1 && D.contains(node, currentList)) ||
          [...record.addedNodes].some(node => node === currentList ||
            matches(node, 'li.geek-info-card') && node.parentElement === currentList ||
            node.nodeType === 1 && all(node, '.geek-content > .card-list', false).length);
      };
      const observe = records => {
        if (records.some(touchesList)) revision++;
        // Replaceable list roots are resolved from the same public component.
        // Merely retaining old cards without a loading cycle is never proof.
        try {
          currentList = list(false) || currentList;
          knownCards = new Set([...currentList.children].filter(node => matches(node, 'li.geek-info-card')));
          if (dirty && loading().scoped) loadingSeen = true;
        } catch { /* settle will fail with a useful message */ }
      };
      const observer = new MutationObserver(observe);
      observer.observe(scope, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-busy', 'hidden', 'class', 'style']});
      return {
        mark() {
          guard();
          // Drain changes from an earlier field before starting a new epoch.
          observer.takeRecords(); currentList = list(); baseline = revision;
          dirty = true; loadingSeen = false;
        },
        async settle() {
          let stable = 0, lastRevision = revision;
          for (let i = 0; i < 100; i++) {
            guard(); observe(observer.takeRecords());
            const presentList = list(false);
            if (presentList) currentList = presentList;
            const pending = loading();
            if (pending.scoped && dirty) loadingSeen = true;
            const proved = !dirty || revision > baseline || loadingSeen && !pending.scoped;
            if (presentList && proved && !pending.any && revision === lastRevision) stable++; else stable = 0;
            lastRevision = revision;
            if (stable >= 4) { dirty = false; return; }
            await pause();
          }
          throw Error(dirty ? '筛选已更改，但未确认搜索结果刷新完成，未开始采集' : '搜索结果仍在加载，未开始采集');
        },
        disconnect() { observer.disconnect(); },
      };
    }
    const open = async field => {
      let menus = boundMenus(field);
      if (menus.length > 1) throw Error('筛选菜单不唯一：' + field.title);
      if (!menus.length) click(field.trigger);
      const findMenu = () => {
        menus = boundMenus(field);
        if (menus.length > 1) throw Error('筛选菜单不唯一：' + field.title);
        return menus[0];
      };
      // BOSS's dropdown can be mounted only while the pointer is over its
      // entry. A programmatic click does not create the mouse-enter event.
      for (let i = 0; i < 5; i++) {
        guard();
        const menu = findMenu(); if (menu) return menu;
        await pause();
      }
      if (field.type === 'menu' && matches(field.wrapper, '.dropdown-wrap') && typeof MouseEvent === 'function') {
        for (const node of [field.wrapper, field.trigger]) {
          guard();
          node.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
          node.dispatchEvent(new MouseEvent('mouseenter', {bubbles: false}));
        }
      }
      try { return await waitFor(findMenu, '未找到与字段绑定的筛选菜单：' + field.title); }
      catch (error) {
        if (field.type === 'menu' && matches(field.wrapper, '.dropdown-wrap') &&
            error.message.startsWith('未找到与字段绑定的筛选菜单')) error.menuInputNeeded = field.key;
        throw error;
      }
    };
    const chooseOption = async (field, wanted) => {
      const menu = await open(field);
      const option = one(options(menu).filter(element => label(element) === norm(wanted)), '未找到唯一的精确选项：' + field.title + ' / ' + wanted);
      if (!enabledControl(option)) throw Error('筛选选项不可用：' + wanted);
      return {menu, option};
    };
    const closeMenu = async field => {
      if (boundMenus(field).length) {
        if (field.trigger.getAttribute('aria-expanded') === 'false') throw Error('筛选菜单状态无法确认：' + field.title);
        click(field.trigger);
        await waitFor(() => !boundMenus(field).length, '筛选菜单未关闭：' + field.title);
      }
    };
    const unlimitedPlaceholder = (field, wanted) => norm(wanted) === '不限' && field.type !== 'major' &&
      displayed(field).some(value => fields[field.key].map(norm).includes(value));
    const verifyField = async (field, wanted) => {
      if (isValue(field, wanted)) return true;
      // Some platform controls render their field title after selecting 不限.
      // The title alone proves nothing: reopen this bound menu and confirm its
      // selected option, then close it without changing the condition again.
      if (!unlimitedPlaceholder(field, wanted)) return false;
      const menu = await open(field);
      const picked = options(menu).filter(selected);
      const valid = picked.length === 1 && label(picked[0]) === '不限';
      await closeMenu(field);
      return valid;
    };
    const setField = async (field, wanted) => {
      if (isValue(field, wanted)) return;
      if (field.type === 'major') {
        openingMajor = true;
        click(field.trigger);
        // A major dialog is explicitly associated by the proved component class
        // and the transition caused by this field; arbitrary dialogs stay banned.
        await waitFor(() => allowedModal, '未找到与专业字段对应的选择窗口');
        openingMajor = false;
        guard();
        const dialog = allowedModal;
        // Clear old chips through their visible remove controls, never by
        // changing application state or assuming the input alone is selected.
        for (let i = 0; i < 30; i++) {
          const chips = all(dialog, '.major-footer .major-select-list .major-select-item');
          if (!chips.length) break;
          const remove = all(chips[0], 'button,[role="button"],.close,.remove,.icon-close,.remove-icon,' + majorRemoveSpan)
            .filter(element => !matches(element, majorRemoveSpan) || ['', '×', '✕'].includes(label(element)));
          click(one(remove, '无法清除原专业选项'));
          await waitFor(() => !chips[0].isConnected || !D.visible(chips[0]), '原专业选项未清除');
        }
        if (all(dialog, '.major-footer .major-select-list .major-select-item').length) throw Error('原专业选项过多，未继续操作');
        const input = one(all(dialog, '.major-search .major-input input'), '专业搜索框不唯一');
        if (!enabledControl(input)) throw Error('专业搜索框不可编辑');
        input.value = wanted;
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
        const result = await waitFor(() => {
          const items = all(dialog, '.major-search .major-lists li').filter(element => label(element) === norm(wanted));
          if (items.length > 1) throw Error('专业搜索结果不唯一：' + wanted);
          return items[0];
        }, '未找到精确的专业选项：' + wanted);
        click(result);
        await waitFor(() => {
          const chips = all(dialog, '.major-footer .major-select-list .major-select-item');
          return chips.length === 1 && label(chips[0]).replace(/[×✕]$/, '') === norm(wanted);
        }, '专业选项未确认：' + wanted, true);
        const confirm = one(all(dialog, '.major-footer-btns button,.major-footer-btns [role="button"],.major-footer-btns .btn')
          .filter(element => ['确定', '确认'].includes(label(element))), '专业确认按钮不唯一');
        change(confirm);
        await waitFor(() => !D.visible(dialog), '专业选择窗口未关闭');
        allowedModal = null;
      } else if (field.type === 'salary' && salaryRange(wanted)) {
        const wantedRange = salaryRange(wanted);
        let menu = await open(field);
        let columns = all(menu, '.options');
        if (columns.length !== 2) throw Error('薪资区间没有可确认的上下限两列');
        for (let index = 0; index < 2; index++) {
          columns = all(menu, '.options');
          if (columns.length !== 2) throw Error('薪资选项已变化');
          const option = one(all(columns[index], 'li,[role="option"]').filter(element => {
            const match = label(element).match(/^(\d+(?:\.\d+)?)([kK]|千|千元)?$/);
            return match && Number(match[1]) === wantedRange[index];
          }), '未找到唯一的薪资' + (index ? '上限' : '下限') + '：' + wantedRange[index] + 'K');
          if (!selected(option)) change(option);
          await pause();
          if (index === 0) menu = await open(field);
        }
      } else {
        if (field.type === 'multi') {
          // Preserve no other selections in this one field. The configured
          // string denotes exactly one visible option, not a fuzzy keyword.
          for (let i = 0; i < 30; i++) {
            const menu = await open(field);
            const previous = options(menu).filter(element => selected(element) && label(element) !== norm(wanted));
            if (!previous.length) break;
            change(previous[0]);
            await waitFor(() => !previous[0].isConnected || !selected(previous[0]), '原筛选选项未取消：' + field.title);
            await closeMenu(field);
            await results.settle();
          }
        }
        const {option} = await chooseOption(field, wanted);
        if (!selected(option)) change(option);
      }
      await waitFor(() => isValue(field, wanted) || unlimitedPlaceholder(field, wanted), '平台未确认筛选值：' + field.title + ' / ' + wanted, true);
      if (field.type !== 'major') await closeMenu(field);
      if (!await verifyField(field, wanted)) throw Error('筛选菜单关闭后无法确认值：' + field.title);
    };
    busy = true;
    try {
      // Validate every requested control before changing any one of them.
      const requested = Object.keys(fields).filter(key => config[key]).map(key => ({field: fieldOf(region, key), value: config[key]}));
      const requestedChecks = Object.keys(checks).filter(key => config[key] !== null).map(key => ({item: checkboxOf(region, key), value: config[key]}));
      const sort = config.sort ? sortOf(region, config.sort) : null;
      results = watchResults();
      await results.settle();
      // Do not create overlapping requests across logical fields. Each field's
      // rendered result update must finish before the next field is changed.
      for (const {field, value} of requested) { guard(); await setField(field, value); await results.settle(); }
      if (sort && !selected(sort.trigger)) {
        change(sort.trigger);
        await waitFor(() => selected(sort.trigger), '平台未确认排序方式：' + sort.value, true);
        await results.settle();
      }
      for (const {item, value} of requestedChecks) {
        guard();
        if (checked(item) !== value) {
          if (!enabledControl(item.control)) throw Error('复选框不可用：' + item.title);
          change(item.click);
          await waitFor(() => checked(item) === value, '平台未确认复选框状态：' + item.title, true);
          await results.settle();
        }
      }
      await results.settle(); guard();
      const finalRegion = discover();
      if (finalRegion.root !== region.root || finalRegion.filters !== region.filters) throw Error('搜索筛选区域已变化，最终复核失败');
      for (const {field, value} of requested) if (!field.wrapper.isConnected || !field.trigger.isConnected ||
        fieldOf(finalRegion, field.key).trigger !== field.trigger || !await verifyField(field, value)) throw Error('筛选最终复核失败：' + field.title);
      if (sort && (!sort.trigger.isConnected || !selected(sort.trigger) || sorts.filter(value => selected(sortOf(finalRegion, value).trigger)).length !== 1)) throw Error('排序最终复核失败');
      for (const {item, value} of requestedChecks) if (!item.control.isConnected ||
        checkboxOf(finalRegion, item.key).control !== item.control || checked(item) !== value) throw Error('复选框最终复核失败：' + item.title);
      guard();
      return {applied: true, summary: [
        ...requested.map(({field, value}) => field.title + '：' + value),
        ...(sort ? ['排序：' + sort.value] : []),
        ...requestedChecks.map(({item, value}) => item.title + '：' + (value ? '开启' : '关闭')),
      ]};
    } finally { results?.disconnect(); busy = false; }
  }
  window.__hrmSearch = {version: 1, async run(action, args) {
    if (action === 'stop') { stopped = true; generation++; return {stopped: true}; }
    if (action === 'reset') { stopped = false; generation++; return {reset: true}; }
    if (action === 'inspect') {
      try { discover(); return {supported: true, frameKey: frameKey()}; }
      catch (error) { return {supported: false, frameKey: frameKey(), reason: error.message}; }
    }
    if (action === 'entry-point') {
      if (!['activity', 'job_hopping'].includes(args?.key)) throw Error('下拉菜单入口无效');
      const region = discover(), field = fieldOf(region, args.key);
      if (boundMenus(field).length) return {opened: true};
      const rect = field.trigger.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) throw Error('下拉菜单入口未完整显示');
      let x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (!D.contains(field.trigger, document.elementFromPoint(x, y))) throw Error('下拉菜单入口被遮挡');
      for (let child = window; child !== child.top; child = child.parent) {
        const iframe = child.frameElement;
        if (!iframe || !iframe.isConnected || !iframe.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}))
          throw Error('搜索页面框架不可见');
        const box = iframe.getBoundingClientRect(), scaleX = box.width / iframe.offsetWidth, scaleY = box.height / iframe.offsetHeight;
        if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0)
          throw Error('搜索页面框架位置无法确认');
        x = box.left + (iframe.clientLeft + x) * scaleX;
        y = box.top + (iframe.clientTop + y) * scaleY;
        if (child.parent.document.elementFromPoint(x, y) !== iframe) throw Error('搜索页面框架被遮挡');
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 ||
          x >= window.top.innerWidth || y >= window.top.innerHeight) throw Error('下拉菜单入口不在可见范围内');
      return {opened: false, point: {x, y}, frameKey: frameKey()};
    }
    if (action === 'apply') return apply(args);
    throw Error('未知的平台查询条件操作');
  }};
})();
