import { isLoopbackWorkbench } from '../extension/workbench-connection.mjs';

export const BROWSER_EXTENSION_KEY = 'hrm.browser-extension-id';
const validId = value => typeof value === 'string' && /^[a-p]{32}$/.test(value);
let sessionSelection;

function browserStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function selectedBrowserExtension(storage = browserStorage()) {
  try {
    const stored = storage?.getItem(BROWSER_EXTENSION_KEY);
    if (stored !== undefined && stored !== null) return validId(stored) ? stored : '';
  } catch { /* Keep the choice usable when browser storage is unavailable. */ }
  return sessionSelection ?? null;
}

export function rememberBrowserExtension(id, storage = browserStorage()) {
  if (id !== '' && !validId(id)) throw Error('扩展 ID 无效。');
  sessionSelection = id;
  // An explicit empty choice prevents a revoked browser from selecting another ID.
  try { storage?.setItem(BROWSER_EXTENSION_KEY, id); } catch { /* Session fallback above. */ }
}

export function browserExtensionState(state, selected = selectedBrowserExtension(), pageOrigin = globalThis.location?.origin) {
  const authorized = [...new Set((Array.isArray(state.extension_ids)
    ? state.extension_ids : [state.extension_id]).filter(validId))];
  let legacyLocal = false;
  try { legacyLocal = isLoopbackWorkbench(pageOrigin); } catch { /* An unknown origin cannot imply a local extension. */ }
  const extensionId = selected === null && legacyLocal && authorized.length === 1 ? authorized[0]
    : validId(selected) && authorized.includes(selected) ? selected : '';
  return {
    ...state,
    extension_ids: authorized,
    extension_id: extensionId,
    extension_paired: Boolean(extensionId),
    extension_selection_required: !extensionId && authorized.length > 0,
  };
}
