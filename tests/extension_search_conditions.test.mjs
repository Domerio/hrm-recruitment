import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const reader = fs.readFileSync(new URL('../extension/dom-reader.js', import.meta.url), 'utf8');
const adapter = fs.readFileSync(new URL('../extension/search-conditions.js', import.meta.url), 'utf8');

// These are offline synthetic controls. Class names and scoped field anchors
// come from the supplied saved search HTML/CSS; dynamic menu text is fixture
// data, not a claim that the live site's current options were inspected.
export function searchFixtureHTML() {
  return `<!doctype html><html><body><main id="search-page" class="params-and-list-container">
  <div id="filter-sort-shell"><section id="params-container"><div class="more-filter-container">
    <p class="more-filter-title">其他筛选</p><div class="more-filter-content">
    <div class="filter-2-item"><div class="dropdown-wrap gender-select" id="gender"><button class="dropdown-flip">性别</button></div></div>
    <div class="filter-2-item"><div class="salary-container"><div class="double-select-container">
      <div class="double-select-flip">薪资待遇</div><div class="dropdown-menu" hidden>
      <ul class="options"><li>不限</li><li>10K</li><li>15K</li><li>20K</li></ul>
      <ul class="options"><li>20K</li><li>25K</li><li>30K</li></ul></div>
    </div></div></div>
    <div class="filter-2-item"><div class="dropdown-wrap select gender-select" id="activity"><div class="dropdown-flip"><span class="dropdown-select">
      <input placeholder="牛人活跃度" readonly style="display:none"><span class="ipt">牛人活跃度</span><input type="hidden" value="0"></span></div>
      <div class="dropdown-menu" hidden><ul class="options"><li>不限</li><li>3日内活跃</li><li>本周活跃</li></ul></div>
    </div></div>
    <div class="filter-2-item"><div class="dropdown-wrap select work-year-select" id="hopping"><div class="dropdown-flip"><span class="dropdown-select">
      <input placeholder="跳槽频率" readonly style="display:none"><span class="ipt">跳槽频率</span><input type="hidden" value="0"></span></div>
      <div class="dropdown-menu" hidden><ul class="options"><li>不限</li><li>平均每份工作2年以上</li></ul></div>
    </div></div>
    <div class="filter-2-item"><div class="mutil-select" data-v-78445001 id="status">
      <div class="input-container"><div class="input-inner-container"><span class="defalut-select">求职状态</span></div></div>
      <div class="dropdown-menu" hidden><ul class="options"><li>离职-随时到岗</li><li>在职-月内到岗</li><li>在职-考虑机会</li></ul></div>
    </div></div>
    <div class="filter-2-item"><div class="mutil-select" data-v-40b33510 id="requirements">
      <div class="input-container"><div class="input-inner-container"><span class="defalut-select">牛人职位要求</span></div></div>
      <div class="dropdown-menu" hidden><ul class="options"><li>期望城市一致</li><li>期望职位一致</li></ul></div>
    </div></div>
    <div class="filter-2-item" id="major-wrapper"><div class="major-input-ui">专业</div></div>
    </div></div></section>
    <div class="my-list-sort sort-container"><span class="search-label active" ka="search_change_sort">综合排序</span><span class="search-label" ka="search_change_sort">活跃优先</span><span class="search-label" ka="search_change_sort">匹配度优先</span>
      <label ka="search_change_view_resume"><input class="checkbox-input" type="checkbox"><span class="checkbox-text">过滤近14天查看</span></label>
      <label ka="search_change_exchange_resume"><input class="checkbox-input" type="checkbox"><span class="checkbox-text">近30天未和同事交换简历</span></label>
    </div></div>
    <div class="geek-list-wrap"><div class="left-container"><section class="geek-content"><ul class="card-list"><li class="geek-info-card">原列表候选人</li></ul></section></div></div>
    <section class="candidate-list"><p>3日内活跃</p><button>计算机科学与技术</button></section>
  </main><div class="major-dialog" hidden><div class="major-selector">
    <div class="major-title"><div class="major-search"><div class="major-input"><input></div><ul class="major-lists" hidden><li>计算机科学与技术</li><li>机械工程</li></ul></div></div>
    <div class="major-footer"><div class="major-select-list"></div><div class="major-footer-btns"><button class="btn-cancel">取消</button><button class="btn">确定</button></div></div>
  </div></div></body></html>`;
}

// Browser-compatible fixture behavior also used by the parent's offline browser
// smoke check. State changes below simulate the site, never adapter behavior.
export function wireSearchFixture(document, Event) {
  const metrics = {clicks: [], changes: [], majorSearches: [], refreshes: 0, refreshEnabled: true};
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  document.addEventListener('click', event => metrics.clicks.push(event.target.textContent.trim()));
  metrics.refresh = () => {
    const card = document.createElement('li'); card.className = 'geek-info-card'; card.textContent = '刷新后候选人 ' + (++metrics.refreshes);
    searchPage.querySelector('.card-list').replaceChildren(card);
  };
  const queueRefresh = event => {
    if (metrics.refreshEnabled && event.target.closest('.dropdown-menu .options li,.search-label,label[ka],.major-footer-btns .btn'))
      queueMicrotask(metrics.refresh);
  };
  const searchPage = $('#search-page');
  searchPage.addEventListener('click', queueRefresh);
  document.addEventListener('click', event => { if (!searchPage.contains(event.target)) queueRefresh(event); });
  for (const wrapper of $$('.dropdown-wrap').filter(element => element.id !== 'gender')) {
    const menu = wrapper.querySelector('.dropdown-menu');
    wrapper.querySelector('.dropdown-flip').addEventListener('click', () => { menu.hidden = !menu.hidden; });
    for (const option of menu.querySelectorAll('li')) option.addEventListener('click', () => {
      for (const sibling of menu.querySelectorAll('li')) sibling.classList.toggle('selected', sibling === option);
      wrapper.querySelector('span.ipt').textContent = option.textContent;
      wrapper.querySelector('input[placeholder]').value = option.textContent;
      menu.hidden = true;
    });
  }
  const salary = $('.salary-container'), salaryMenu = salary.querySelector('.dropdown-menu');
  salary.querySelector('.double-select-flip').addEventListener('click', () => { salaryMenu.hidden = !salaryMenu.hidden; });
  const columns = [...salaryMenu.querySelectorAll('.options')];
  for (const [index, column] of columns.entries()) for (const option of column.querySelectorAll('li')) option.addEventListener('click', () => {
    for (const sibling of column.querySelectorAll('li')) sibling.classList.toggle('selected', sibling === option);
    if (option.textContent === '不限') { salary.querySelector('.double-select-flip').textContent = '不限'; salaryMenu.hidden = true; return; }
    if (index === 1) {
      const from = columns[0].querySelector('.selected')?.textContent;
      if (from) { salary.querySelector('.double-select-flip').textContent = from + '-' + option.textContent; salaryMenu.hidden = true; }
    }
  });
  for (const wrapper of $$('.mutil-select')) {
    const menu = wrapper.querySelector('.dropdown-menu');
    wrapper.querySelector('.input-container').addEventListener('click', () => { menu.hidden = !menu.hidden; });
    const redraw = () => {
      const picked = [...menu.querySelectorAll('li.cur')];
      wrapper.querySelector('.input-inner-container').innerHTML = picked.map(option => '<span class="select-item">' + option.textContent + '</span>').join('');
    };
    for (const option of menu.querySelectorAll('li')) option.addEventListener('click', () => { option.classList.toggle('cur'); redraw(); });
  }
  for (const option of $$('.search-label')) option.addEventListener('click', () => {
    for (const sibling of $$('.search-label')) sibling.classList.toggle('active', sibling === option);
  });
  for (const label of $$('label[ka]')) {
    const checkbox = label.querySelector('input');
    checkbox.checked = false;
    // The browser has native activation, linkedom has none. This handler only
    // runs in linkedom, allowing the adapter to be tested without checked writes.
    if (!('onbeforetoggle' in document.defaultView)) label.addEventListener('click', () => { checkbox.checked = !checkbox.checked; });
  }
  const major = $('.major-dialog'), trigger = $('.major-input-ui'), chosen = major.querySelector('.major-select-list');
  trigger.addEventListener('click', () => { major.hidden = false; });
  major.querySelector('input').addEventListener('input', event => {
    metrics.majorSearches.push(event.target.value);
    major.querySelector('.major-lists').hidden = false;
    for (const item of major.querySelectorAll('.major-lists li')) item.hidden = !item.textContent.includes(event.target.value);
  });
  for (const option of major.querySelectorAll('.major-lists li')) option.addEventListener('click', () => {
    const chip = document.createElement('span'); chip.className = 'major-select-item';
    const text = document.createElement('span'); text.textContent = option.textContent; chip.appendChild(text);
    const remove = document.createElement('span'); remove.setAttribute('data-v-47b50b11', ''); remove.addEventListener('click', () => chip.remove()); chip.appendChild(remove);
    chosen.appendChild(chip);
  });
  major.querySelector('.btn').addEventListener('click', () => {
    trigger.textContent = [...chosen.querySelectorAll('.major-select-item > span:not([data-v-47b50b11])')].map(span => span.textContent).join('、'); major.hidden = true;
  });
  major.querySelector('.btn-cancel').addEventListener('click', () => { major.hidden = true; });
  return metrics;
}

function fixture({mutate, html = searchFixtureHTML(), timer} = {}) {
  const {window: domWindow} = parseHTML(html), {document, HTMLElement, Event, MutationObserver} = domWindow;
  const window = {document};
  Object.defineProperty(document, 'defaultView', {configurable: true, value: window});
  Object.defineProperties(HTMLElement.prototype, {
    getClientRects: {configurable: true, value() { return this.closest('[hidden]') ? [] : [this.getBoundingClientRect()]; }},
    getBoundingClientRect: {configurable: true, value() { return {x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100}; }},
  });
  const metrics = wireSearchFixture(document, Event);
  const location = {href: 'https://www.zhipin.com/web/frame/search', origin: 'https://www.zhipin.com', pathname: '/web/frame/search', search: ''};
  const context = {window, document, Event, MouseEvent: Event, MutationObserver, URL, location,
    getComputedStyle: node => ({display: node.hidden || node.style?.display === 'none' ? 'none' : 'block', visibility: 'visible', opacity: '1'}),
    setTimeout: fn => { (timer || queueMicrotask)(fn); return 1; }, clearTimeout() {},
  };
  vm.runInNewContext(reader, context);
  mutate?.({window, document, location, metrics, Event});
  vm.runInNewContext(adapter, context);
  return {window, document, location, metrics, Event, run: (action, args) => window.__hrmSearch.run(action, args)};
}

const every = {enabled: true, salary: '15-25K', activity: '3日内活跃', job_hopping: '平均每份工作2年以上', job_status: '离职-随时到岗', position_requirements: '期望职位一致', major: '计算机科学与技术', sort: '活跃优先', exclude_viewed_14d: true, exclude_contacted_30d: false};

test('recognizes saved-search semantic structure and applies all six fields, sort and real checkbox clicks', async () => {
  const f = fixture();
  assert.equal((await f.run('inspect')).supported, true);
  const result = await f.run('apply', every);
  assert.equal(result.applied, true);
  assert.equal(result.summary.length, 9);
  assert.equal(f.document.querySelector('[ka="search_change_view_resume"] input').checked, true);
  assert.equal(f.document.querySelector('#gender').textContent, '性别');
  assert.equal(f.metrics.majorSearches[0], '计算机科学与技术');
  const clicks = f.metrics.clicks.length;
  assert.equal((await f.run('apply', every)).applied, true);
  assert.equal(f.metrics.clicks.length, clicks, 'all configured values already selected: no further clicks');
});

test('empty strings and nullable booleans preserve current platform settings; disabled config has no side effects', async () => {
  const f = fixture();
  assert.equal((await f.run('apply', {enabled: true})).applied, true);
  assert.equal((await f.run('apply', {enabled: false, activity: '3日内活跃'})).applied, true);
  assert.equal(f.metrics.clicks.length, 0);
});

test('an exact unlimited salary option is supported without guessing numeric limits', async () => {
  const f = fixture();
  assert.equal((await f.run('apply', {enabled: true, salary: '不限'})).applied, true);
  assert.equal(f.document.querySelector('.double-select-flip').textContent, '不限');
});

test('multi-select clears other selections in the same field, including when its default title disappeared', async () => {
  const f = fixture();
  const status = f.document.querySelector('#status');
  status.querySelectorAll('li')[1].click(); status.querySelectorAll('li')[2].click();
  await f.run('apply', {enabled: true, job_status: '离职-随时到岗'});
  assert.deepEqual([...status.querySelectorAll('li.cur')].map(element => element.textContent), ['离职-随时到岗']);
  assert.equal(f.document.querySelector('#requirements .defalut-select').textContent, '牛人职位要求');
});

test('changing major clears the previously selected chip and confirms an exact search result', async () => {
  const f = fixture();
  await f.run('apply', {enabled: true, major: '机械工程'});
  await f.run('apply', {enabled: true, major: '计算机科学与技术'});
  assert.equal(f.document.querySelector('.major-input-ui').textContent, '计算机科学与技术');
  assert.equal(f.document.querySelectorAll('.major-select-item').length, 1);
});

test('ARIA-bound portal dropdown ignores same text elsewhere on the page', async () => {
  const f = fixture({mutate({document}) {
    const field = document.querySelector('#activity'), menu = field.querySelector('.dropdown-menu');
    menu.id = 'activity-options'; menu.setAttribute('role', 'listbox'); document.body.appendChild(menu);
    field.querySelector('.dropdown-flip').setAttribute('aria-controls', menu.id);
  }});
  await f.run('apply', {enabled: true, activity: '3日内活跃'});
  assert.equal(f.document.querySelector('#activity span.ipt').textContent, '3日内活跃');
  assert.equal(f.metrics.clicks.filter(text => text === '3日内活跃').length, 1);
});

test('activity dropdown that mounts on mouse enter can still be opened and confirmed', async () => {
  const f = fixture({mutate({document}) {
    const field = document.querySelector('#activity'), original = field.querySelector('.dropdown-flip');
    const trigger = original.cloneNode(true); original.replaceWith(trigger);
    const menu = field.querySelector('.dropdown-menu');
    trigger.addEventListener('click', () => { if (!menu.hidden) menu.hidden = true; });
    field.addEventListener('mouseenter', () => { menu.hidden = false; });
  }});
  assert.equal((await f.run('apply', {enabled: true, activity: '3日内活跃'})).applied, true);
  assert.equal(f.document.querySelector('#activity span.ipt').textContent, '3日内活跃');
});

test('unevidenced native select is rejected rather than assigning and reading back its own value', async () => {
  const f = fixture({mutate({document, metrics}) {
    const activity = document.querySelector('#activity');
    activity.innerHTML = '<label>牛人活跃度<select><option value="0" selected>不限</option><option value="3">3日内活跃</option></select></label>';
    activity.setAttribute('data-search-field', 'activity');
    const select = activity.querySelector('select');
    select.addEventListener('change', () => metrics.changes.push(select.value));
  }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃'}), /筛选入口不唯一/);
  assert.deepEqual(f.metrics.changes, []);
});

test('missing field is rejected before any other configured field is changed', async () => {
  const f = fixture({mutate({document}) { document.querySelector('#hopping').remove(); }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃', job_hopping: '不限'}), /无法确认筛选字段/);
  assert.equal(f.metrics.clicks.length, 0);
});

test('unbound portal menu is rejected instead of globally clicking a matching option', async () => {
  const f = fixture({mutate({document}) { document.body.appendChild(document.querySelector('#activity .dropdown-menu')); }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃'}), /未找到与字段绑定/);
  assert.equal(f.metrics.clicks.filter(text => text === '3日内活跃').length, 0);
});

test('duplicate menu options and unsupported exact labels fail without reporting applied', async () => {
  const f = fixture({mutate({document}) {
    const menu = document.querySelector('#activity .options'); menu.appendChild(menu.children[1].cloneNode(true));
  }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃'}), /多个控件/);
  const missing = fixture();
  await assert.rejects(missing.run('apply', {enabled: true, activity: '三日活跃'}), /未找到唯一的精确选项/);
});

test('click that does not produce a confirmed state is a failure', async () => {
  const f = fixture({mutate({document}) {
    const option = document.querySelector('#activity li:nth-child(2)'); option.replaceWith(option.cloneNode(true));
  }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃'}), /平台未确认筛选值/);
});

test('a detached old trigger with the requested value cannot prove a replacement control state', async () => {
  const f = fixture({mutate({document}) {
    document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => {
      const trigger = document.querySelector('#activity .dropdown-flip'), replacement = trigger.cloneNode(true);
      replacement.querySelector('input[placeholder]').value = '不限';
      replacement.querySelector('span.ipt').textContent = '不限';
      trigger.replaceWith(replacement);
    });
  }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃'}), /平台未确认筛选值/);
});

test('foreign origins, open resume dialogs and duplicate filter toolbars are unsupported', async () => {
  const foreign = fixture(); foreign.location.href = 'http://www.zhipin.com/web/frame/search';
  assert.equal((await foreign.run('inspect')).supported, false);
  const detail = fixture(); const dialog = detail.document.createElement('div'); dialog.className = 'dialog-lib-resume'; detail.document.body.appendChild(dialog);
  assert.equal((await detail.run('inspect')).supported, false);
  const duplicate = fixture(); duplicate.document.body.appendChild(duplicate.document.querySelector('#search-page').cloneNode(true));
  assert.equal((await duplicate.run('inspect')).supported, false);
});

test('page navigation or a new resume dialog during apply cancels remaining actions', async () => {
  const f = fixture({mutate({document, location}) {
    document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => { location.href += '?changed=1'; });
  }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃', sort: '活跃优先'}), /搜索页面已变化/);
  assert.equal(f.document.querySelector('.search-label.active').textContent, '综合排序');
  const detail = fixture({mutate({document}) {
    document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => { const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.appendChild(dialog); });
  }});
  await assert.rejects(detail.run('apply', {enabled: true, activity: '3日内活跃'}), /出现简历详情或其他弹窗/);
});

test('stop cancels an in-flight wait; reset permits a subsequent clean attempt', async () => {
  let interrupt = true;
  const f = fixture({timer: fn => queueMicrotask(() => { if (interrupt) f.run('stop'); fn(); })});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃'}), /已停止/);
  interrupt = false;
  await f.run('reset');
  assert.equal((await f.run('apply', {enabled: true, activity: '3日内活跃'})).applied, true);
});

test('an asynchronously displayed bound major dialog is recognized before the modal guard', async () => {
  const f = fixture({mutate({document}) {
    const trigger = document.querySelector('.major-input-ui'), replacement = trigger.cloneNode(true);
    trigger.replaceWith(replacement);
    replacement.addEventListener('click', () => queueMicrotask(() => { document.querySelector('.major-dialog').hidden = false; }));
    document.querySelector('.major-footer-btns .btn').addEventListener('click', () => { replacement.textContent = '计算机科学与技术'; });
  }});
  assert.equal((await f.run('apply', {enabled: true, major: '计算机科学与技术'})).applied, true);
});

test('composed shadow search controls use the same DOM adapter', async () => {
  const f = fixture({mutate({document}) {
    const host = document.createElement('div'); document.body.appendChild(host);
    const shadow = host.attachShadow({mode: 'open'});
    shadow.appendChild(document.querySelector('#search-page'));
  }});
  assert.equal((await f.run('inspect')).supported, true);
  assert.equal((await f.run('apply', {enabled: true, activity: '3日内活跃'})).applied, true);
});

test('changed controls cannot return applied while the old result cards persist beyond several polling intervals', async () => {
  let remaining = -1, resolved = false, oldListPolls = 0;
  const f = fixture({timer: fn => queueMicrotask(() => {
    if (remaining > 0) {
      oldListPolls++;
      assert.equal(resolved, false);
      if (--remaining === 0) f.metrics.refresh();
    }
    fn();
  }), mutate({document, metrics}) {
    metrics.refreshEnabled = false;
    document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => { remaining = 7; });
  }});
  const request = f.run('apply', {enabled: true, activity: '3日内活跃'}).then(result => { resolved = true; return result; });
  assert.equal((await request).applied, true);
  assert.equal(oldListPolls, 7);
  assert.equal(f.metrics.refreshes, 1);
});

test('a previous field result update cannot prove a later sort change; no second redraw means failure', async () => {
  const f = fixture({mutate({document, metrics}) {
    metrics.refreshEnabled = false;
    document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => queueMicrotask(metrics.refresh));
    document.querySelectorAll('.search-label')[1].addEventListener('click', () => assert.equal(metrics.refreshes, 1, 'the earlier field must finish first'));
  }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃', sort: '活跃优先'}), /未确认搜索结果刷新完成/);
  assert.equal(f.metrics.refreshes, 1);
});

test('new card nodes with identical text prove a redraw; retaining the same old nodes does not', async () => {
  const f = fixture({mutate({document, metrics}) {
    metrics.refreshEnabled = false;
    document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => queueMicrotask(() => {
      const card = document.querySelector('li.geek-info-card'); card.replaceWith(card.cloneNode(true));
    }));
  }});
  assert.equal((await f.run('apply', {enabled: true, activity: '3日内活跃'})).applied, true);
  const stale = fixture({mutate({metrics}) { metrics.refreshEnabled = false; }});
  await assert.rejects(stale.run('apply', {enabled: true, activity: '3日内活跃'}), /未确认搜索结果刷新完成/);
});

test('an already matching configuration waits for a current loading state to finish without demanding a new result', async () => {
  let polls = 0;
  const f = fixture({timer: fn => queueMicrotask(() => {
    if (++polls === 6) f.document.querySelector('.left-container').setAttribute('aria-busy', 'false');
    fn();
  }), mutate({document, metrics}) {
    metrics.refreshEnabled = false;
    document.querySelector('.left-container').setAttribute('aria-busy', 'true');
  }});
  assert.equal((await f.run('apply', {enabled: true, sort: '综合排序'})).applied, true);
  assert.ok(polls >= 6);
  assert.equal(f.metrics.clicks.length, 0);
  assert.equal(f.metrics.refreshes, 0);
});

test('a visible loading cycle can confirm unchanged results after a condition change', async () => {
  let loadingPolls = 0;
  const f = fixture({timer: fn => queueMicrotask(() => {
    const scope = f.document.querySelector('.left-container');
    if (scope.getAttribute('aria-busy') === 'true' && ++loadingPolls === 5) scope.setAttribute('aria-busy', 'false');
    fn();
  }), mutate({document, metrics}) {
    metrics.refreshEnabled = false;
    document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => document.querySelector('.left-container').setAttribute('aria-busy', 'true'));
  }});
  assert.equal((await f.run('apply', {enabled: true, activity: '3日内活跃'})).applied, true);
  assert.equal(f.metrics.refreshes, 0);
});

test('a hidden search iframe is unsupported and hiding it during a pending refresh stops the operation', async () => {
  const attachFrame = ({window, document}) => {
    const frame = document.createElement('iframe'); frame.id = 'containing-frame'; document.body.appendChild(frame);
    const parent = {innerWidth: 1400, innerHeight: 900}; parent.top = parent;
    window.top = parent; window.parent = parent; window.frameElement = frame;
  };
  const hidden = fixture({mutate(args) { attachFrame(args); args.window.frameElement.hidden = true; }});
  assert.equal((await hidden.run('inspect')).supported, false);
  let changed = false, polls = 0;
  const f = fixture({timer: fn => queueMicrotask(() => {
    if (changed && ++polls === 5) f.window.frameElement.hidden = true;
    fn();
  }), mutate(args) {
    attachFrame(args); args.metrics.refreshEnabled = false;
    args.document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => { changed = true; });
  }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃'}), /搜索页面已变化/);
});

test('unlimited restored to a field placeholder is confirmed by reopening its bound selected menu', async () => {
  const f = fixture({mutate({document}) {
    const field = document.querySelector('#activity');
    field.querySelector('li').addEventListener('click', () => {
      field.querySelector('span.ipt').textContent = '牛人活跃度'; field.querySelector('input[placeholder]').value = '';
    });
  }});
  assert.equal((await f.run('apply', {enabled: true, activity: '不限'})).applied, true);
  assert.equal(f.document.querySelector('#activity span.ipt').textContent, '牛人活跃度');
  assert.equal(f.document.querySelector('#activity li.selected').textContent, '不限');
});

test('a list removed during loading must reappear before the updated results can be accepted', async () => {
  let original = null, pending = 0;
  const f = fixture({timer: fn => queueMicrotask(() => {
    if (original && ++pending === 5) {
      f.document.querySelector('.geek-content').appendChild(original.cloneNode(true));
      f.document.querySelector('.left-container').setAttribute('aria-busy', 'false');
    }
    fn();
  }), mutate({document, metrics}) {
    metrics.refreshEnabled = false;
    document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => {
      original = document.querySelector('.card-list'); original.remove();
      document.querySelector('.left-container').setAttribute('aria-busy', 'true');
    });
  }});
  assert.equal((await f.run('apply', {enabled: true, activity: '3日内活跃'})).applied, true);
  assert.ok(pending >= 5);
});

test('card-internal text and avatar updates do not prove a filtered result refresh', async () => {
  let changed = false, updates = 0;
  const f = fixture({timer: fn => queueMicrotask(() => {
    if (changed && updates++ < 12) {
      const card = f.document.querySelector('li.geek-info-card');
      card.textContent = '原列表候选人 活跃状态 ' + updates;
      card.appendChild(f.document.createElement('img'));
    }
    fn();
  }), mutate({document, metrics}) {
    metrics.refreshEnabled = false;
    document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => { changed = true; });
  }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃'}), /未确认搜索结果刷新完成/);
});

test('an unrelated global toast loading cycle does not prove the result set was refreshed', async () => {
  let ticks = 0;
  const f = fixture({timer: fn => queueMicrotask(() => {
    const toast = f.document.querySelector('.toast-loading');
    if (toast && ++ticks === 5) toast.hidden = true;
    fn();
  }), mutate({document, metrics}) {
    metrics.refreshEnabled = false;
    document.querySelector('#activity li:nth-child(2)').addEventListener('click', () => {
      const toast = document.createElement('div'); toast.className = 'toast-loading'; document.body.appendChild(toast);
    });
  }});
  await assert.rejects(f.run('apply', {enabled: true, activity: '3日内活跃'}), /未确认搜索结果刷新完成/);
});

test('an unchanged configuration waits until ongoing result replacements become stable', async () => {
  let ticks = 0;
  const f = fixture({timer: fn => queueMicrotask(() => {
    if (++ticks <= 8) f.metrics.refresh();
    fn();
  })});
  assert.equal((await f.run('apply', {enabled: true, sort: '综合排序'})).applied, true);
  assert.ok(ticks >= 11);
});
