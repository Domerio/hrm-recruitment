// Passive, tab-scoped metadata only. Never request headers, bodies or websocket frames.
export const PASSIVE_ORIGINS = ['https://*.zhipin.com/*', 'wss://*.zhipin.com/*'];
export const PASSIVE_PERMISSION = {permissions:['webRequest'], origins:PASSIVE_ORIGINS};
export const CAPTURE_DURATION_MS = 5 * 60 * 1000;
export const CAPTURE_LIMIT = 300;
const ID_FIELDS = new Set(['gid', 'geekId', 'encryptGeekId', 'encryptId', 'uid', 'friendId', 'jid', 'jobId', 'encryptJobId', 'encryptJid', 'expectId']);
const SECRET_SEGMENT = /^(?:token|cookie|session|password|secret|authorization|credential|signature|sign|csrf|securityid|lid)$/i;
const PAGE_DATA_TYPES = new Set(['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket']);
const RESOURCE_TYPES = new Set([...PAGE_DATA_TYPES, 'stylesheet', 'script', 'image', 'font',
  'object', 'ping', 'csp_report', 'media', 'webtransport', 'webbundle', 'other']);

export function isBossNetworkUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'wss:'].includes(url.protocol) && !url.username && !url.password &&
      (url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com'));
  } catch { return false; }
}

export function isBossPageUrl(value) {
  return isBossNetworkUrl(value) && new URL(value).protocol === 'https:';
}

function safePath(path) {
  const parts = path.split('/');
  return parts.map((part, index) => {
    if (index && SECRET_SEGMENT.test(parts[index - 1])) return '[redacted]';
    return part.length <= 160 && /^[A-Za-z0-9._~!$&'()*+,;=:@%-]*$/.test(part) ? part : '[omitted]';
  }).slice(0, 20).join('/');
}

function querySummary(params) {
  const query_keys = [...new Set(params.keys())].slice(0, 50)
    .map(key => /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(key) ? key : '[omitted]');
  const ids = [];
  for (const field of ID_FIELDS) {
    const values = params.getAll(field);
    // Official encrypted IDs can carry one trailing '~'. Keep other fields strict,
    // and never admit token/securityId or arbitrary query values as identities.
    const pattern = field.startsWith('encrypt') ? /^[A-Za-z0-9_-]+~?$/ : /^[A-Za-z0-9_-]+$/;
    if (values.length === 1 && values[0].length <= 160 && pattern.test(values[0])) ids.push({field, value:values[0]});
  }
  return {query_keys, ids};
}

export function summarizePassiveUrl(value, {addressBar=false}={}) {
  if (!isBossNetworkUrl(value) || value.length > 8192) return null;
  const url = new URL(value);
  const result = {endpoint:url.origin + safePath(url.pathname), ...querySummary(url.searchParams)};
  if (addressBar && /^#\/[A-Za-z0-9_/.-]*(?:\?|$)/.test(url.hash)) {
    const fragment = url.hash.slice(1), separator = fragment.indexOf('?');
    const path = separator < 0 ? fragment : fragment.slice(0, separator);
    result.fragment_route = {path:safePath(path), ...querySummary(new URLSearchParams(separator < 0 ? '' : fragment.slice(separator + 1)))};
  }
  return result;
}

export function createPassiveCapture({api, tabId, onChange=()=>{}, onStop=()=>{},
  setTimer=setTimeout, clearTimer=clearTimeout, now=Date.now}) {
  if (!Number.isInteger(tabId) || tabId < 0) throw Error('缺少目标 BOSS 标签页。');
  let active = false, timer = null, lastAddress = '';
  const records = [], pending = new Map(), listeners = [];
  const snapshot = () => structuredClone(records);
  const emit = () => onChange(snapshot());
  function stop(reason='manual') {
    if (timer !== null) { clearTimer(timer); timer = null; }
    active = false;
    for (const [event, listener] of listeners.splice(0)) {
      try { event.removeListener(listener); } catch { /* Continue removing every listener. */ }
    }
    pending.clear();
    onStop(reason);
  }
  function listen(event, listener, filter) {
    if (!event?.addListener || !event?.removeListener) throw Error('浏览器未提供被动网络记录接口。');
    const guarded = (...args) => {
      if (!active) return;
      try { listener(...args); } catch { stop('listener_error'); }
    };
    // No extraInfoSpec: headers, requestBody, responseBody and blocking are not requested.
    if (filter) event.addListener(guarded, filter); else event.addListener(guarded);
    listeners.push([event, guarded]);
  }
  function append(record, requestId) {
    records.push(record);
    if (requestId !== undefined) pending.set(String(requestId), record);
    if (records.length > CAPTURE_LIMIT) {
      const removed = records.shift();
      for (const [key, value] of pending) if (value === removed) pending.delete(key);
    }
    emit();
  }
  function addressBar(value) {
    if (!isBossPageUrl(value)) { stop('left_boss'); return; }
    const info = summarizePassiveUrl(value, {addressBar:true});
    if (!info) return;
    const identity = JSON.stringify(info);
    if (identity === lastAddress) return;
    lastAddress = identity;
    append({kind:'address_bar', time:now(), ...info});
  }
  function before(details) {
    if (details.tabId !== tabId) return;
    const info = summarizePassiveUrl(details.url);
    if (!info) return;
    if (!PAGE_DATA_TYPES.has(details.type) && !new URL(details.url).pathname.startsWith('/wapi/')) return;
    const frame = value => Number.isSafeInteger(value) && value >= -1 ? value : null;
    append({kind:'request', time:Number.isFinite(details.timeStamp) ? details.timeStamp : now(),
      type:details.type === 'websocket' ? 'websocket_handshake' : 'http',
      resource_type:RESOURCE_TYPES.has(details.type) ? details.type : 'unknown',
      frameId:frame(details.frameId), parentFrameId:frame(details.parentFrameId),
      method:/^[A-Z]{1,12}$/.test(details.method || '') ? details.method : 'UNKNOWN',
      ...info, status:null, outcome:'pending'}, details.requestId);
  }
  function finish(details, outcome) {
    if (details.tabId !== tabId) return;
    const key = String(details.requestId), record = pending.get(key);
    if (!record) return;
    pending.delete(key);
    record.status = Number.isInteger(details.statusCode) ? details.statusCode : null;
    record.outcome = outcome;
    emit();
  }
  function start(initialUrl) {
    if (active) return;
    if (!isBossPageUrl(initialUrl)) throw Error('目标标签页已离开 BOSS，请从 BOSS 页面重新打开记录窗口。');
    active = true;
    const filter = {urls:PASSIVE_ORIGINS, tabId};
    try {
      listen(api.webRequest?.onBeforeRequest, before, filter);
      listen(api.webRequest?.onCompleted, details => finish(details, 'completed'), filter);
      listen(api.webRequest?.onErrorOccurred, details => finish(details, 'failed'), filter);
      listen(api.webRequest?.onBeforeRedirect, details => finish(details, 'redirected'), filter);
      listen(api.tabs?.onUpdated, (id, change) => { if (id === tabId && change.url) addressBar(change.url); });
      listen(api.tabs?.onRemoved, id => { if (id === tabId) stop('tab_closed'); });
      timer = setTimer(() => stop('timeout'), CAPTURE_DURATION_MS);
      lastAddress = '';
      addressBar(initialUrl);
    } catch (error) { stop('start_error'); throw error; }
  }
  return {start, stop, snapshot, get active() { return active; },
    clear() { records.length = 0; pending.clear(); lastAddress = ''; emit(); }};
}
