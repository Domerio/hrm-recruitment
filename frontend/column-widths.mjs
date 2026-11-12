export const MIN_COLUMN_WIDTH = 96;
export const MAX_COLUMN_WIDTH = 800;
export const COLUMN_WIDTH_STORAGE_KEY = 'hrm:candidates:column-widths:v1';
export const COLUMN_LAYOUTS = Object.freeze(['wide', 'condensed', 'narrow', 'compact']);

export function columnWidthBounds(minWidth = MIN_COLUMN_WIDTH, maxWidth = MAX_COLUMN_WIDTH) {
  const minimum = Number.isFinite(minWidth) ? Math.round(minWidth) : MIN_COLUMN_WIDTH;
  const min = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, minimum));
  const maximum = Number.isFinite(maxWidth) ? Math.round(maxWidth) : MAX_COLUMN_WIDTH;
  return { min, max: Math.max(min, Math.min(MAX_COLUMN_WIDTH, maximum)) };
}

export function clampColumnWidth(width, minWidth, maxWidth) {
  const { min, max } = columnWidthBounds(minWidth, maxWidth);
  return Math.max(min, Math.min(max, Number.isFinite(width) ? Math.round(width) : min));
}

// Pointer coordinates use rendered pixels; table widths use pixels before CSS zoom/scale.
export function resizeColumnWidth(startWidth, clientDelta, scale = 1, minWidth, maxWidth) {
  const ratio = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const delta = Number.isFinite(clientDelta) ? clientDelta : 0;
  return clampColumnWidth(startWidth + delta / ratio, minWidth, maxWidth);
}

export function elementInlineScale(element) {
  const width = element?.offsetWidth;
  const renderedWidth = element?.getBoundingClientRect?.().width;
  const ratio = renderedWidth / width;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

function emptyLayouts() {
  return Object.fromEntries(COLUMN_LAYOUTS.map(layout => [layout, {}]));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validColumnKey(key) {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key) && key !== 'constructor' && key !== 'prototype';
}

// Keep only bounded numeric widths in the four known layouts. Never mutate caller data.
export function sanitizeCandidateColumnWidths(value) {
  const result = emptyLayouts();
  if (!isRecord(value)) return result;
  for (const layout of COLUMN_LAYOUTS) {
    if (!Object.hasOwn(value, layout) || !isRecord(value[layout])) continue;
    for (const [key, width] of Object.entries(value[layout])) {
      if (validColumnKey(key) && Number.isFinite(width) && width >= MIN_COLUMN_WIDTH && width <= MAX_COLUMN_WIDTH) {
        result[layout][key] = Math.round(width);
      }
    }
  }
  return result;
}

function browserStorage(storage) {
  // Access itself can throw in privacy modes, sandboxed frames, or disabled storage.
  return storage === undefined ? globalThis.localStorage : storage;
}

export function readCandidateColumnWidths(storage) {
  try {
    const raw = browserStorage(storage)?.getItem(COLUMN_WIDTH_STORAGE_KEY);
    if (typeof raw !== 'string' || raw.length > 65536) return emptyLayouts();
    const parsed = JSON.parse(raw);
    return isRecord(parsed) && parsed.version === 1
      ? sanitizeCandidateColumnWidths(parsed.layouts) : emptyLayouts();
  } catch {
    return emptyLayouts();
  }
}

export function writeCandidateColumnWidths(layouts, storage) {
  try {
    const target = browserStorage(storage);
    if (typeof target?.setItem !== 'function') return false;
    target.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify({
      version: 1, layouts: sanitizeCandidateColumnWidths(layouts),
    }));
    return true;
  } catch {
    return false;
  }
}
