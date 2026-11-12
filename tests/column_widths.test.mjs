import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMN_LAYOUTS, COLUMN_WIDTH_STORAGE_KEY, clampColumnWidth, columnWidthBounds, elementInlineScale,
  readCandidateColumnWidths, resizeColumnWidth, sanitizeCandidateColumnWidths, writeCandidateColumnWidths,
} from '../frontend/column-widths.mjs';

const empty = () => Object.fromEntries(COLUMN_LAYOUTS.map(layout => [layout, {}]));

test('column limits stay within 96–800 pixels, including invalid and conflicting bounds', () => {
  assert.deepEqual(columnWidthBounds(40, 900), { min: 96, max: 800 });
  assert.deepEqual(columnWidthBounds(180, 120), { min: 180, max: 180 });
  assert.deepEqual(columnWidthBounds(NaN, Infinity), { min: 96, max: 800 });
  assert.deepEqual(columnWidthBounds(900, -1), { min: 800, max: 800 });
  assert.equal(clampColumnWidth(140.6), 141);
  for (const width of [0, -20, '160', undefined, NaN, Infinity]) assert.equal(clampColumnWidth(width), 96);
  assert.equal(clampColumnWidth(2000), 800);
  assert.equal(clampColumnWidth(110, 140, 300), 140);
});

test('pointer deltas are converted from rendered coordinates before clamping', () => {
  assert.equal(resizeColumnWidth(200, 85, 0.85), 300);
  assert.equal(resizeColumnWidth(200, -50, 0.5), 100);
  assert.equal(resizeColumnWidth(200, 100, 2), 250);
  assert.equal(resizeColumnWidth(200, 10000, 0.5), 800);
  assert.equal(resizeColumnWidth(200, -10000, 0.5, 120, 600), 120);
  assert.equal(resizeColumnWidth(200, 20, 0), 220);
  assert.equal(resizeColumnWidth(200, Infinity, NaN), 200);
  assert.equal(elementInlineScale({ offsetWidth: 200, getBoundingClientRect: () => ({ width: 170 }) }), 0.85);
  assert.equal(elementInlineScale({ offsetWidth: 0, getBoundingClientRect: () => ({ width: 0 }) }), 1);
  assert.equal(elementInlineScale(null), 1);
});

test('widths persist independently for all four layouts and survive a reload', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const widths = { wide: { name: 260, actions: 150 }, condensed: { name: 300 }, narrow: { name: 200 }, compact: { actions: 104 } };
  const before = structuredClone(widths);
  assert.equal(writeCandidateColumnWidths(widths, storage), true);
  assert.deepEqual(readCandidateColumnWidths(storage), widths);
  assert.deepEqual(widths, before);
  assert.equal(JSON.parse(values.get(COLUMN_WIDTH_STORAGE_KEY)).version, 1);
  const reloaded = readCandidateColumnWidths(storage);
  delete reloaded.wide.name;
  assert.equal(writeCandidateColumnWidths(reloaded, storage), true);
  assert.equal(Object.hasOwn(readCandidateColumnWidths(storage).wide, 'name'), false);
  assert.equal(readCandidateColumnWidths(storage).narrow.name, 200);
});

test('malformed storage, unsupported versions and storage access failures use fresh defaults', () => {
  for (const raw of [null, '', '{bad', 'null', '[]', '17', '{}', '{"version":2,"layouts":{"wide":{"name":200}}}', 'x'.repeat(65537)]) {
    assert.deepEqual(readCandidateColumnWidths({ getItem: () => raw }), empty());
  }
  const blocked = { getItem() { throw new Error('Storage denied'); }, setItem() { throw new Error('Quota exceeded'); } };
  assert.deepEqual(readCandidateColumnWidths(blocked), empty());
  assert.equal(writeCandidateColumnWidths({ wide: { name: 200 } }, blocked), false);
  assert.deepEqual(readCandidateColumnWidths(null), empty());
  assert.equal(writeCandidateColumnWidths({}, null), false);
  const first = readCandidateColumnWidths(null);
  first.wide.name = 200;
  assert.deepEqual(readCandidateColumnWidths(null), empty());
});

test('invalid fields cannot introduce bad widths, unknown layouts or prototype keys', () => {
  const supplied = JSON.parse('{"wide":{"name":260.4,"score":"200","bad":801,"negative":-10,"tiny":95,"constructor":190,"prototype":190,"__proto__":190,"two words":200},"condensed":[],"compact":{"actions":104},"unknown":{"name":260}}');
  const before = structuredClone(supplied);
  const expected = { wide: { name: 260 }, condensed: {}, narrow: {}, compact: { actions: 104 } };
  assert.deepEqual(sanitizeCandidateColumnWidths(supplied), expected);
  assert.deepEqual(supplied, before);
  assert.deepEqual(readCandidateColumnWidths({ getItem: () => JSON.stringify({ version: 1, layouts: supplied }) }), expected);
  assert.deepEqual(sanitizeCandidateColumnWidths({ wide: { name: NaN, score: Infinity, review: null } }), empty());
  assert.deepEqual(sanitizeCandidateColumnWidths(Object.create({ wide: { name: 200 } })), empty());
  assert.equal(Object.getPrototypeOf(expected.wide), Object.prototype);
});

test('an unavailable global localStorage getter fails gracefully', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    assert.deepEqual(readCandidateColumnWidths(), empty());
    assert.equal(writeCandidateColumnWidths({ wide: { name: 200 } }), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
