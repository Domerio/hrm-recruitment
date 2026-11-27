import test from 'node:test';
import assert from 'node:assert/strict';
import { isRulePrecheck, isRuleRejected } from '../extension/evaluation-result.mjs';
import { ruleRejectedResult } from './fixtures/rule-rejected.mjs';

test('rule rejection requires explicit line-backed checks and complete no-score result',()=>{
  const result=ruleRejectedResult();
  assert.equal(isRuleRejected(result),true);
  assert.equal(isRulePrecheck({evaluation_method:result.evaluation_method,score:null,precheck:result.precheck}),true);
  assert.equal(isRuleRejected({evaluation_method:result.evaluation_method,score:null,precheck:result.precheck}),false);
  assert.equal(isRuleRejected({score:0,category:'低匹配'}),false);
});

test('partial, ambiguous or inconsistent rule markers cannot suppress model scoring',()=>{
  const changes=[
    result=>delete result.evaluation_method,result=>result.evaluation_method='model',result=>result.score=0,
    result=>result.score=undefined,result=>result.precheck.version='hard-rules-v2',result=>result.precheck.rejected='true',
    result=>result.precheck.checks=[],result=>result.required_checks=[],result=>result.checks=[{}],
    result=>result.precheck.checks[0].status='信息不足',result=>result.precheck.checks[0].basis='inferred',
    result=>result.precheck.checks[0].rule_id='',result=>result.precheck.checks[0].requirement_id=Number.MAX_SAFE_INTEGER+1,
    result=>result.precheck.checks[0].evidence_lines=[0],result=>result.precheck.checks[0].evidence_lines=[2,3],
    result=>result.precheck.checks[0].evidence_quotes=[' '],result=>result.precheck.checks[0].reasoning='',
    result=>result.required_checks[0].condition='不同的硬条件',
  ];
  for(const change of changes){const result=ruleRejectedResult();change(result);assert.equal(isRuleRejected(result),false,String(change));}
});
