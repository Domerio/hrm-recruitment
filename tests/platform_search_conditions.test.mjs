import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSearchConditions,prepareSearchConditions,validateSearchConditions,searchConditionsSummary} from '../frontend/platform-search-conditions.mjs';

test('old jobs default to disabled and preserve every existing platform setting',()=>{
  const values = prepareSearchConditions(undefined);
  assert.equal(values.enabled,false);
  assert.equal(values.exclude_viewed_14d,null);
  assert.equal(values.exclude_contacted_30d,null);
  for (const key of ['salary','activity','job_hopping','job_status','position_requirements','major','sort']) assert.equal(values[key],'');
  assert.deepEqual(validateSearchConditions(),values);
  values.enabled=true;
  assert.equal(defaultSearchConditions().enabled,false);
});

test('editing and saving preserves false checkbox choices distinctly from unchanged settings',()=>{
  const input = {enabled:true,activity:' 3日内活跃 ',salary:'平台薪资选项',major:'计算机科学与技术',
    sort:'匹配度优先',exclude_viewed_14d:false,exclude_contacted_30d:null};
  const values = validateSearchConditions(input);
  assert.equal(values.activity,'3日内活跃');
  assert.equal(values.exclude_viewed_14d,false);
  assert.equal(values.exclude_contacted_30d,null);
  assert.equal(values.salary,input.salary);
  assert.match(searchConditionsSummary(values),/过滤近 14 天查看：取消勾选/);
  assert.doesNotMatch(searchConditionsSummary(values),/近 30 天未和同事交换简历/);
  assert.match(searchConditionsSummary(values),/排序：匹配度优先/);
});

test('disabling retains the edited values but does not present them as applied filters',()=>{
  const values=validateSearchConditions({enabled:false,activity:'3日内活跃',exclude_viewed_14d:true});
  assert.equal(values.activity,'3日内活跃');
  assert.equal(values.exclude_viewed_14d,true);
  assert.equal(searchConditionsSummary(values),'未启用，采集时保留页面设置');
  assert.equal(searchConditionsSummary({enabled:true}),'已启用，所有项目均保留页面设置');
});

test('platform conditions exclude unrelated properties from the saved payload',()=>{
  const values=validateSearchConditions({enabled:true,activity:'3日内活跃',criteria:'AI条件',gender:'value',age:'value'});
  assert.equal('criteria' in values,false);
  assert.equal('gender' in values,false);
  assert.equal('age' in values,false);
  assert.equal(values.activity,'3日内活跃');
});

test('free-form platform labels have bounded length and toggle/sort values stay typed',()=>{
  assert.equal(validateSearchConditions({major:'字'.repeat(80)}).major.length,80);
  for (const invalid of [{major:'字'.repeat(81)},{salary:'A\nB'},{activity:42},{enabled:'true'},
    {exclude_viewed_14d:'false'},{exclude_contacted_30d:0},{sort:'未知排序'},'bad',[]])
    assert.throws(()=>validateSearchConditions(invalid));
  for (const sort of ['','综合排序','活跃优先','匹配度优先']) assert.equal(validateSearchConditions({sort}).sort,sort);
});

test('recommendation filter values persist independently from search-page values',()=>{
  const values=validateSearchConditions({enabled:true,activity:'3日内活跃',recommend_activity:'今日活跃',
    recommend_gender:'女',recommend_school:'211',recommend_education:'本科',recommend_experience:'3-5年',
    recommend_job_status:'离职-随时到岗',recommend_salary:'10-20K'});
  assert.equal(values.activity,'3日内活跃');
  assert.equal(values.recommend_activity,'今日活跃');
  assert.match(searchConditionsSummary(values),/推荐页院校：211/);
  assert.equal(prepareSearchConditions(values).recommend_experience,'3-5年');
  assert.throws(()=>validateSearchConditions({recommend_gender:'A\nB'}));
});
