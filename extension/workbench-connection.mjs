import {DEFAULT_WORKBENCH_ORIGIN} from './workbench-default.mjs';

const INVALID_ORIGIN = '工作台地址须为 HTTP/HTTPS 的本机或局域网 IP 地址，且不能包含账号、路径或参数。';

export function normalizeWorkbenchOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\s\\%?#]/.test(value))
    throw Error(INVALID_ORIGIN);
  const match = /^(https?):\/\/(\[[^\]]+\]|[^/:]+)(?::([0-9]+))?\/?$/i.exec(value);
  if (!match) throw Error(INVALID_ORIGIN);
  const host = match[2].toLowerCase();
  let allowed = host === 'localhost' || host === '[::1]';
  if (!allowed && /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    allowed = parts.every(part => part <= 255) && (parts[0] === 127 || parts[0] === 10 ||
      parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168);
  }
  if (!allowed || match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))
    throw Error(INVALID_ORIGIN);
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error();
    return url.origin;
  } catch {
    throw Error(INVALID_ORIGIN);
  }
}

export async function loadWorkbenchOrigin() {
  const storage = globalThis.chrome?.storage?.local;
  const saved = storage?.get ? await storage.get('workbenchOrigin') : {};
  return normalizeWorkbenchOrigin(saved?.workbenchOrigin ?? DEFAULT_WORKBENCH_ORIGIN);
}

export function workbenchPermission(origin) {
  return normalizeWorkbenchOrigin(origin) + '/*';
}

export async function hasWorkbenchPermission(origin) {
  const permission = {origins:[workbenchPermission(origin)]};
  return Boolean(await globalThis.chrome?.permissions?.contains?.(permission));
}

export async function ensureWorkbenchPermission(origin) {
  const normalized = normalizeWorkbenchOrigin(origin);
  const permissions = globalThis.chrome?.permissions;
  if (!permissions?.request) throw Error('浏览器不支持工作台访问授权，请更新浏览器后重试。');
  // Call request before any await: it must remain attached to the user's click.
  const granted = await permissions.request({origins:[workbenchPermission(normalized)]});
  if (!granted) throw Error('尚未允许访问该工作台。请点击“连接工作台”并允许访问后重试。');
  return normalized;
}

export function isLoopbackWorkbench(origin) {
  const host = new URL(normalizeWorkbenchOrigin(origin)).hostname;
  return host === 'localhost' || host === '[::1]' || host.startsWith('127.');
}

export function assertWorkbenchPaired(state, extensionId) {
  const validId = typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId);
  const paired = validId && (Array.isArray(state?.extension_ids)
    ? state.extension_ids.includes(extensionId) : state?.extension_id === extensionId);
  if (!paired) throw Error('此浏览器插件尚未授权。请复制扩展 ID，到工作台“连接与集成”中点击“授权连接”。');
  return true;
}
