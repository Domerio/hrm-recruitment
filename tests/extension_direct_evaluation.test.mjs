import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { isRuleRejected } from '../extension/evaluation-result.mjs';
import { ruleRejectedResult } from './fixtures/rule-rejected.mjs';

const source=fs.readFileSync(new URL('../extension/direct-evaluation.mjs',import.meta.url),'utf8')
  .replace(/^import \{ isRuleRejected \} from .*;\r?\n/m,'').replace('export function ','function ');
const response=()=>({name:'合成人员',job:{id:1,title:'合成视觉岗位'},model:'synthetic-model',saved:false,
  result:{score:80,category:'待确认',summary:'项目经历支持开发能力，部署细节需要核实。',
    evaluation_context:{evaluation_date:'2026-11-14',job_revision:2},
    checks:[{condition:'1. 开发能力',status:'满足',basis:'explicit',support_score:100,evidence_quotes:['负责图像处理和程序验证。']},
      {condition:'部署能力',status:'信息不足',basis:'inferred',support_score:60,evidence_quotes:['完成模型转换和接口封装。'],
        reasoning:'有模型转换经历，但尚未确认现场上线环节。'}],
    required_checks:[{condition:'开发能力',status:'满足',basis:'explicit',evidence_quotes:['负责图像处理和程序验证。']}],
    inferred_capabilities:[{capability:'系统集成',reasoning:'设备接口与模型封装共同支持集成能力。',
      evidence_quotes:['参与设备接口联调。'],question:'请说明个人负责的集成部分。'}],
    questions:['请描述一次现场部署过程。'],
    scoring:{version:'equal-weight-v4',condition_scores:[
      {condition:'开发能力',status:'满足',credit:'full',ratio:1},
      {condition:'部署能力',status:'信息不足',credit:'partial',ratio:.6}]}}});

function fixture(){
  const {document}=parseHTML('<html><body><section id="result"></section></body></html>');
  const sideEffects=[];
  const denied=name=>(...args)=>{sideEffects.push({name,args});throw Error('Unexpected side effect: '+name);};
  const context={isRuleRejected,fetch:denied('fetch'),localStorage:{setItem:denied('localStorage')},
    chrome:{storage:{local:{set:denied('storage')}},tabs:{sendMessage:denied('tab action')}},
    XMLHttpRequest:denied('XMLHttpRequest')};
  vm.runInNewContext(source,context);
  return {container:document.querySelector('#result'),render:context.renderDirectEvaluation,sideEffects};
}

test('transient result includes score, mandatory conditions, verified quotes, counted support and follow-up questions',()=>{
  const {container,render,sideEffects}=fixture();
  render(container,response());
  assert.match(container.querySelector('h2').textContent,/合成人员 · 合成视觉岗位/);
  assert.equal(container.querySelector('.direct-score strong').textContent,'80 分');
  for(const text of ['必备条件','逐项依据','负责图像处理和程序验证。','项目推断 · 部分支持（待核实） · 60% 计分',
    '满足 · 100% 计分','项目补充能力（待核实）','参与设备接口联调。','建议核实：请说明个人负责的集成部分。',
    '待确认问题','请描述一次现场部署过程。','未保存履历或评估历史，未收藏，未添加采集标记。'])
    assert.ok(container.textContent.includes(text),text);
  assert.deepEqual(sideEffects,[]);
  assert.equal(container.querySelectorAll('button,a,input,form').length,0,'Result display must not offer an implicit save/favorite action');
});

test('untrusted markup in every model field stays literal text without executable or resource elements',()=>{
  const {container,render,sideEffects}=fixture();
  const payload='<img src="https://example.invalid/leak" onerror="globalThis.pwned=true"><script>bad()</script>';
  const value=response();
  value.name=payload;value.job.title=payload;value.model=payload;
  value.result.summary=payload;value.result.category=payload;value.result.questions=[payload];
  value.result.checks=[{condition:payload,status:payload,reasoning:payload,note:payload,evidence_quotes:[payload]}];
  value.result.required_checks=[];
  value.result.inferred_capabilities=[{capability:payload,reasoning:payload,question:payload,evidence_quotes:[payload]}];
  render(container,value);
  assert.ok(container.textContent.includes(payload));
  assert.equal(container.querySelectorAll('script,img,iframe,svg,a,style,link').length,0);
  assert.doesNotMatch(container.innerHTML,/<script>|<img /);
  assert.match(container.innerHTML,/&lt;img/);
  assert.deepEqual(sideEffects,[]);
});

test('renders fresh results by replacing prior content and handles absent optional arrays',()=>{
  const {container,render,sideEffects}=fixture();
  render(container,response());
  render(container,{name:'第二份',job:{title:'合成岗位'},result:{score:0,category:'低匹配',summary:'本次结果'}});
  assert.match(container.textContent,/第二份/);
  assert.match(container.textContent,/0 分/);
  assert.doesNotMatch(container.textContent,/部署能力|系统集成|请描述一次/);
  assert.deepEqual(sideEffects,[]);
});

test('invalid scores reject before mutating the result surface or causing side effects',()=>{
  const {container,render,sideEffects}=fixture();
  for(const score of [undefined,null,'80',NaN,Infinity,-1,100.1]){
    container.textContent='existing';
    assert.throws(()=>render(container,{result:{score}}),/未收到有效的评估结果/);
    assert.equal(container.textContent,'existing');
  }
  assert.deepEqual(sideEffects,[]);
});

test('counted percentages use validated scoring metadata, not an unsupported model support number',()=>{
  const {container,render}=fixture();
  const value=response();
  value.result.checks[1].support_score=90;
  render(container,value);
  assert.match(container.textContent,/60% 计分/);
  assert.doesNotMatch(container.textContent,/90% 计分/);
  value.result.scoring.condition_scores[1].ratio=.65;
  render(container,value);
  assert.doesNotMatch(container.textContent,/65% 计分|部分支持（待核实）/);
  value.result.scoring.version='unverified-rule';
  render(container,value);
  assert.doesNotMatch(container.textContent,/% 计分/);
});

test('unknown conditions without evidence remain visibly unconfirmed and zero credit',()=>{
  const {container,render}=fixture();
  const value=response();
  value.result.checks=[{condition:'部署能力',status:'信息不足',basis:'unknown',evidence_quotes:[]}];
  value.result.required_checks=[];value.result.inferred_capabilities=[];
  value.result.scoring.condition_scores=[{condition:'部署能力',status:'信息不足',credit:'none',ratio:0}];
  render(container,value);
  assert.match(container.textContent,/信息不足（未计分） · 0% 计分/);
  assert.match(container.textContent,/资料中没有足够证据/);
});

test('rules-only results show hard conditions and original quotes without score or model claims',()=>{
  const {container,render,sideEffects}=fixture();
  render(container,{...response(),result:ruleRejectedResult()});
  for(const text of ['规则预筛不达标 · 未调用模型','未通过的硬条件与原文依据','本科及以上','最高学历：大专','低于岗位要求'])
    assert.ok(container.textContent.includes(text),text);
  assert.equal(container.querySelector('.direct-score'),null);
  assert.doesNotMatch(container.textContent,/null|undefined|0 分|计分|待确认问题|synthetic-model/);
  assert.deepEqual(sideEffects,[]);
});

test('invalid rule metadata is rejected rather than rendering null or forged zero scores',()=>{
  const {container,render}=fixture();
  for(const change of [value=>value.precheck.rejected=false,value=>value.score=0,value=>value.required_checks[0].evidence_quotes=[]]){
    const result=ruleRejectedResult();change(result);container.textContent='existing';
    assert.throws(()=>render(container,{...response(),result}),/未收到有效的评估结果/);
    assert.equal(container.textContent,'existing');
  }
});
