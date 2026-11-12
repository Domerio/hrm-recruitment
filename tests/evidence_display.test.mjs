import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceDisplay, evidencePreview } from '../frontend/evidence-display.mjs';

test('repeated source paragraphs are merged within one block, retaining the first exact quote', () => {
  const original = ' 前期打光测试验证，视觉方案PPT编写。\n完成现场交付。 ';
  const item = { evidence_quotes: [original, '前期打光测试验证，视觉方案PPT编写。 完成现场交付。', original] };
  const before = structuredClone(item);
  assert.deepEqual(evidenceDisplay(item), { quotes: [original], duplicateCount: 2 });
  assert.deepEqual(item, before);
});

test('similar claims, dates, technical names and substrings stay separate', () => {
  const quotes = ['2018.10 - 2023.03', '2023.04 - 至今', '图像检测', '图像检测和尺寸测量',
    'C++', 'c++', 'ＡＩ', 'AI', 'a b', 'ab'];
  assert.deepEqual(evidenceDisplay({ evidence_quotes: quotes }), { quotes, duplicateCount: 0 });
});

test('server and local duplicate counts combine, invalid metadata is ignored', () => {
  assert.deepEqual(evidenceDisplay({ evidence_quotes: ['来源甲', '来源甲'], evidence_duplicate_count: 3 }),
    { quotes: ['来源甲'], duplicateCount: 4 });
  for (const invalid of [-1, 1.5, '5', null, {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(evidenceDisplay({ evidence_quotes: ['来源甲'], evidence_duplicate_count: invalid }).duplicateCount, 0);
  }
  assert.equal(evidenceDisplay({ evidence_quotes: ['甲', '甲'], evidence_duplicate_count: Number.MAX_SAFE_INTEGER }).duplicateCount, 1);
});

test('old multiline evidence is deduplicated for display without swallowing new facts', () => {
  assert.deepEqual(evidenceDisplay({ evidence: '负责图像检测。\n负责图像检测。\n2020 - 2024\n负责端侧部署。' }),
    { quotes: ['负责图像检测。', '2020 - 2024', '负责端侧部署。'], duplicateCount: 1 });
  assert.deepEqual(evidenceDisplay({ evidence_quotes: [], evidence: '旧格式原文。' }).quotes, ['旧格式原文。']);
});

test('empty or invalid quote items do not produce fake evidence', () => {
  assert.deepEqual(evidenceDisplay({ evidence_quotes: [null, 5, ' ', {}], evidence: '' }), { quotes: [], duplicateCount: 0 });
  assert.deepEqual(evidenceDisplay(), { quotes: [], duplicateCount: 0 });
});

test('preview limits the initial number and character budget, keeping every full quote available', () => {
  const quotes = ['甲'.repeat(160), '乙'.repeat(160), '丙', '丁'];
  const before = [...quotes];
  assert.deepEqual(evidencePreview(quotes), { quotes: quotes.slice(0, 2), needsExpansion: true, clipFirst: false });
  assert.deepEqual(quotes, before);
  const long = ['完整原文'.repeat(100)];
  assert.deepEqual(evidencePreview(long), { quotes: long, needsExpansion: true, clipFirst: true });
  assert.deepEqual(evidencePreview(['短原文']), { quotes: ['短原文'], needsExpansion: false, clipFirst: false });
});

test('different condition blocks independently keep the same source quote', () => {
  const item = { evidence_quotes: ['共同原文'] };
  assert.deepEqual(evidenceDisplay(item).quotes, ['共同原文']);
  assert.deepEqual(evidenceDisplay(item).quotes, ['共同原文']);
});
