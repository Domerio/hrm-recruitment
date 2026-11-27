import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ruleRejectedResult } from './fixtures/rule-rejected.mjs';

const output = await build({
  stdin: { contents: "export { default as CandidateDetail, EvaluationSummary } from './frontend/CandidateDetail.jsx';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'jsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
  loader: { '.css': 'empty' },
});
const module = {exports:{}};
vm.runInNewContext(output.outputFiles[0].text, {module,exports:module.exports,require:createRequire(import.meta.url)});
const result = {
  score:100,category:'推荐',summary:'依据项目职责核对',questions:['请说明接口调试过程'],
  checks:[{condition:'熟悉 Python',status:'满足',basis:'explicit',evidence:'负责 Python 设备接口开发',
    evidence_quotes:['负责 Python 设备接口开发']}],required_checks:[],inferred_capabilities:[],
  evaluation_context:{job_revision:3,evaluation_date:'2026-11-13'},
};

test('direct result shows original evidence and questions without pretending to have saved history', () => {
  const html = renderToStaticMarkup(React.createElement(module.exports.EvaluationSummary,{result}));
  assert.match(html,/逐项依据/);
  assert.match(html,/负责 Python 设备接口开发/);
  assert.match(html,/请说明接口调试过程/);
  assert.match(html,/评估时岗位版本 3/);
  assert.doesNotMatch(html,/历史评估|资料版本|undefined/);
});

test('saved candidate summaries retain their history and candidate revision', () => {
  const saved = {...result,evaluation_context:{...result.evaluation_context,candidate_revision:2}};
  const html = renderToStaticMarkup(React.createElement(module.exports.EvaluationSummary,
    {history:[{id:1,result:saved,model:'synthetic-model',created:'2026-11-13T00:00:00Z'}]}));
  assert.match(html,/历史评估（1 次）/);
  assert.match(html,/资料版本 2/);
});

test('rules-only direct and saved summaries show rejection evidence without scoring explanations',()=>{
  for(const props of [{result:ruleRejectedResult()},{history:[{id:1,created:'2026-11-23T00:00:00Z',model:'规则预筛',result:ruleRejectedResult()}]}]){
    const html=renderToStaticMarkup(React.createElement(module.exports.EvaluationSummary,props));
    for(const text of ['规则预筛不达标 · 未调用模型','未通过的硬条件与原文依据','本科及以上','最高学历：大专','低于岗位要求'])
      assert.ok(html.includes(text),text);
    assert.doesNotMatch(html,/评分规则|计分|待确认问题|null 分|0 分|undefined/);
  }
});

test('candidate detail overview and expanded mixed history distinguish rules from real zero AI scores',()=>{
  const require=createRequire(import.meta.url),nativeModule={exports:{}};
  const antd=require('antd');
  const nativeControls={...antd,
    Modal:({open,title,children})=>open?React.createElement('section',{},title,children):null,
    Tabs:({items,activeKey})=>React.createElement('section',{},items.find(item=>item.key===activeKey)?.children),
    Collapse:({items})=>React.createElement('div',{},items.map(item=>React.createElement('div',{key:item.key},item.label,item.children))),
  };
  vm.runInNewContext(output.outputFiles[0].text,{module:nativeModule,exports:nativeModule.exports,
    require:name=>name==='antd'?nativeControls:require(name)});
  const saved=ruleRejectedResult();
  const history=[{id:1,created:'2026-11-23T00:00:00Z',model:'must-not-be-attributed',result:saved},
    {id:2,created:'2026-11-22T00:00:00Z',model:'actual-ai-model',result:{...result,score:0}}];
  const html=renderToStaticMarkup(React.createElement(nativeModule.exports.CandidateDetail,
    {candidate:{id:9,name:'合成候选人',review:'未复核',history},jobTitle:'合成岗位'}));
  const overview=html.slice(html.indexOf('candidate-detail-overview'),html.indexOf('candidate-detail-workspace'));
  assert.match(overview,/规则预筛不达标 · 未调用模型/);
  assert.doesNotMatch(overview,/candidate-detail-score-value|AI 匹配|null|0 分/);
  assert.match(html,/actual-ai-model.*0 分/);
  assert.doesNotMatch(html,/must-not-be-attributed|null 分|评分规则版本未记录/);
  assert.match(html,/最高学历：大专/);
});
