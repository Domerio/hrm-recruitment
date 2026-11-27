import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const result = await build({
  stdin: { contents: "export { ScreeningFailure, EvaluationSummary } from './frontend/CandidateDetail.jsx';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
  loader: { '.css': 'empty' },
});
const module = { exports: {} };
vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports,
  require: createRequire(import.meta.url) });
const render = failure => renderToStaticMarkup(React.createElement(module.exports.ScreeningFailure, { failure }));

test('saved screening failure remains inspectable with escaped model attempts and validation details', () => {
  const html = render({ code: 'evaluation_format_invalid', message: '学历条目未通过校验',
    validation_path: 'checks[0].status', model: 'synthetic-model', created: '2026-11-12T08:00:00Z',
    job_revision: 3, api_key: 'must-never-render',
    attempts: [{ attempt: 1, result: { summary: '<script>bad()</script>' }, error: 'invalid status' }] });
  assert.match(html, /评估失败/);
  assert.match(html, /失败原因：学历条目未通过校验/);
  assert.match(html, /<summary[^>]*>查看评估诊断/);
  assert.match(html, /checks\[0\]\.status/);
  assert.match(html, /synthetic-model/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|must-never-render/);
});

test('ordinary candidates and absent diagnostics do not show a screening failure', () => {
  for (const failure of [undefined, null, {}, { message: '' }, { message: '   ' }]) assert.equal(render(failure), '');
});

test('failed evaluation shows the persisted reason instead of an unevaluated empty state', () => {
  const html = renderToStaticMarkup(React.createElement(module.exports.EvaluationSummary, {
    failure: { message: '模型服务连接超时', created: '2026-11-20T07:00:00Z' }, pending: true,
  }));
  assert.match(html, /失败原因：模型服务连接超时/);
  assert.doesNotMatch(html, /尚未进行 AI 评估|请重新评估并核对履历原文依据/);
});

test('a retry preserves the prior reason and a successful historical summary stays labeled as previous', () => {
  const html = renderToStaticMarkup(React.createElement(module.exports.EvaluationSummary, {
    failure: { message: '模型服务连接超时' }, pending: true,
    evaluation: { text: '正在评估', running: true },
    history: [{ id: 1, model: 'test', created: '2026-11-19T00:00:00Z', result: {
      score: 80, summary: '此前已保存的摘要', checks: [], questions: [],
    } }],
  }));
  assert.match(html, /正在评估/);
  assert.match(html, /上次评估失败/);
  assert.match(html, /上次评估摘要/);
  assert.match(html, /此前已保存的摘要/);
});

test('matching live and persisted failures appear once, and a live error never claims unevaluated', () => {
  const error = '模型服务连接超时';
  const html = renderToStaticMarkup(React.createElement(module.exports.EvaluationSummary, {
    failure: { message: error }, evaluation: { text: error, error: true },
  }));
  // The collapsed diagnostic also includes the message once.
  assert.equal(html.split(error).length - 1, 2);
  const transient = renderToStaticMarkup(React.createElement(module.exports.EvaluationSummary, {
    evaluation: { text: '页面会话已失效，请刷新', error: true },
  }));
  assert.match(transient, /页面会话已失效/);
  assert.doesNotMatch(transient, /尚未进行 AI 评估/);
});

test('a successful retry with a failed list refresh does not resurrect the saved AI error', () => {
  const html = renderToStaticMarkup(React.createElement(module.exports.EvaluationSummary, {
    pending: true, failure: { message: '上次模型超时' },
    evaluation: { taskState: 'succeeded', error: true, text: '工作台网络连接中断' },
  }));
  assert.match(html, /评估已完成，列表刷新失败/);
  assert.match(html, /刷新失败原因：工作台网络连接中断/);
  assert.doesNotMatch(html, /上次模型超时|评估待重试|尚未进行 AI 评估/);
});

test('a completed batch item awaiting list refresh does not claim it has never been evaluated', () => {
  const html = renderToStaticMarkup(React.createElement(module.exports.EvaluationSummary, {
    evaluation: { taskState: 'succeeded', text: '已完成' },
  }));
  assert.match(html, /已完成/);
  assert.doesNotMatch(html, /尚未进行 AI 评估/);
});
