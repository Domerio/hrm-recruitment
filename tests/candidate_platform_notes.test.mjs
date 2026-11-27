import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const result = await build({
  stdin: { contents: "export { CandidatePlatformNotes } from './frontend/CandidateDetail.jsx';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
  loader: { '.css': 'empty' },
});
const module = { exports: {} };
vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports,
  require: createRequire(import.meta.url) });
const { CandidatePlatformNotes } = module.exports;
const note = { kind: 'latest_work_may_be_outdated', text: '最近一份工作经历可能未更新',
  section: '工作经历', anchor: '虚构公司 <script>alert(1)</script> | 工程师 | 2020 - 2024' };
const render = notes => renderToStaticMarkup(React.createElement(CandidatePlatformNotes, { notes }));

test('platform note preview shows cautious wording and escaped associated experience without an action control', () => {
  const html = render([note]);
  assert.match(html, /BOSS 平台提示/);
  assert.match(html, /最近一份工作经历可能未更新/);
  assert.match(html, /关联经历：/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /进一步核对/);
  assert.doesNotMatch(html, /<script>|<button|<a\s|询问Ta|确定异常/);
});

test('older captures and unsupported notes do not create a platform notice', () => {
  for (const notes of [undefined, null, [], [null], [{ ...note, kind: 'unverified' }],
    [{ ...note, text: '工作经历确定异常' }], [{ ...note, anchor: '' }]]) assert.equal(render(notes), '');
});
