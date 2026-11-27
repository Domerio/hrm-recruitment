import { normalizeWorkbenchOrigin } from '../extension/workbench-connection.mjs';

export function favoriteFinderUrl(candidate, extensionId, origin) {
  if (!candidate || candidate.deleted || !Number.isSafeInteger(candidate.id) || candidate.id <= 0 ||
      !/^[a-p]{32}$/.test(extensionId || '')) return '';
  let workbench;
  try { workbench = normalizeWorkbenchOrigin(origin); } catch { return ''; }
  const query = new URLSearchParams({ candidate: String(candidate.id), workbench });
  return `chrome-extension://${extensionId}/favorite-finder.html?${query}`;
}
