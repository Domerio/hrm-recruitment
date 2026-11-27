import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeChatJobTitle,resolveChatJob} from '../extension/chat-job-matching.mjs';

const jobs=[{id:1,title:'视觉工程师'},{id:2,title:'采购工程师'}];
const conversation=(overrides={})=>({friend_id:'101',platform_job_id:'BOSS-VISUAL',platform_job_title:'视觉算法工程师',...overrides});
const mapping=(overrides={})=>({account_id:'公司-招聘人',platform_job_id:'BOSS-VISUAL',job_id:1,...overrides});
const resolve=(overrides={})=>resolveChatJob({jobs,conversations:[conversation()],account_id:'公司-招聘人',mappings:[],...overrides});

test('shared title normalization preserves qualifications and ordering without fuzzy simplification',()=>{
  assert.equal(normalizeChatJobTitle('  ＡＩ\t高级 工程师 '),'ai 高级 工程师');
  assert.notEqual(normalizeChatJobTitle('视觉算法工程师'),normalizeChatJobTitle('视觉工程师'));
  assert.notEqual(normalizeChatJobTitle('工程师 视觉'),normalizeChatJobTitle('视觉 工程师'));
  assert.equal(normalizeChatJobTitle(undefined),'');
  assert.equal(normalizeChatJobTitle('视觉\u200b工程师'),null);
});

test('existing same-account platform job binding recognizes different local and BOSS job titles',()=>{
  const result=resolve({mappings:[mapping(),mapping({friend_id:'202'})]});
  assert.deepEqual(result,{ok:true,job_id:1,job_title:'视觉工程师',platform_job_id:'BOSS-VISUAL',
    platform_job_title:'视觉算法工程师',method:'history',error:''});
});

test('exact normalized communicated title resolves a new platform job without any manual selection',()=>{
  const result=resolve({jobs:[...jobs,{id:3,title:'ＡＩ   工程师'}],conversations:[conversation({platform_job_title:'  ai\t工程师  '})]});
  assert.equal(result.ok,true);assert.equal(result.job_id,3);assert.equal(result.method,'title');
  assert.equal(result.platform_job_title,'ai 工程师');
});

test('different account or different platform ID associations never become an automatic alias',()=>{
  for(const mappings of [[mapping({account_id:'另一个账号'})],[mapping({platform_job_id:'OTHER-JOB'})]]){
    const result=resolve({mappings});assert.equal(result.ok,false);assert.equal(result.code,'unmatched-title');
  }
});

test('similar names are not fuzzy matched even when there is only one local job',()=>{
  for(const platform_job_title of ['视觉算法工程师','高级视觉工程师','视觉工程师助理']){
    assert.equal(resolve({jobs:[jobs[0]],conversations:[conversation({platform_job_title})]}).ok,false);
  }
});

test('multiple archive job associations for one account/platform ID block even a unique exact title',()=>{
  const result=resolve({conversations:[conversation({platform_job_title:'视觉工程师'})],mappings:[mapping(),mapping({job_id:2})]});
  assert.equal(result.ok,false);assert.equal(result.code,'conflicting-history');
});

test('an exact title cannot silently override a different existing archive association',()=>{
  const result=resolve({conversations:[conversation({platform_job_title:'采购工程师'})],mappings:[mapping()]});
  assert.equal(result.ok,false);assert.equal(result.code,'title-history-conflict');
});

test('duplicate local titles require confirmation unless one is already bound by account/platform ID',()=>{
  const duplicate=[{id:1,title:'视觉工程师'},{id:2,title:'视觉工程师'}];
  const conversations=[conversation({platform_job_title:'视觉工程师'})];
  assert.equal(resolve({jobs:duplicate,conversations}).code,'ambiguous-title');
  const result=resolve({jobs:duplicate,conversations,mappings:[mapping({job_id:2})]});
  assert.equal(result.ok,true);assert.equal(result.job_id,2);assert.equal(result.method,'history');
});

test('deleted or malformed bound local jobs cannot be ignored in favor of a new title match',()=>{
  const conversations=[conversation({platform_job_title:'采购工程师'})];
  assert.equal(resolve({conversations,mappings:[mapping({job_id:99})]}).code,'missing-history-job');
  for(const job_id of [null,'1',0,-1,Number.MAX_SAFE_INTEGER+1])
    assert.equal(resolve({mappings:[mapping({job_id})]}).code,'invalid-history');
});

test('a group must have one stable platform job ID and one consistent communicated title',()=>{
  assert.equal(resolve({conversations:[conversation(),conversation({friend_id:'202',platform_job_id:'OTHER'})]}).code,'mixed-platform-jobs');
  assert.equal(resolve({conversations:[conversation(),conversation({friend_id:'202',platform_job_id:''})]}).code,'mixed-platform-jobs');
  assert.equal(resolve({conversations:[conversation(),conversation({friend_id:'202',platform_job_title:'采购工程师'})]}).code,'conflicting-platform-titles');
});

test('missing titles on other rows in the same identified group can use the current communicated title',()=>{
  const result=resolve({conversations:[conversation({platform_job_title:'视觉工程师'}),conversation({friend_id:'202',platform_job_title:''})]});
  assert.equal(result.ok,true);assert.equal(result.job_id,1);
});

test('missing platform ID is allowed only for a single conversation with an exact title',()=>{
  const conversations=[conversation({platform_job_id:'',platform_job_title:'视觉工程师'})];
  assert.equal(resolve({conversations}).ok,true);
  assert.equal(resolve({conversations:[...conversations,conversation({friend_id:'202',platform_job_id:'',platform_job_title:'视觉工程师'})]}).code,'missing-platform-job');
});

test('without a communicated title only an explicit same-account job-ID binding resolves',()=>{
  const conversations=[conversation({platform_job_title:''})];
  assert.equal(resolve({conversations}).ok,false);
  assert.equal(resolve({conversations,mappings:[mapping()]}).job_id,1);
});

test('empty account cannot borrow historical mappings but a unique exact title is still recognized',()=>{
  assert.equal(resolve({account_id:'',mappings:[mapping()]}).ok,false);
  assert.equal(resolve({account_id:'',conversations:[conversation({platform_job_title:'视觉工程师'})]}).job_id,1);
});

test('malformed title or ID, missing selection and invalid job state fail without returning an archive ID',()=>{
  for(const overrides of [
    {conversations:[]},{jobs:[]},{jobs:[...jobs,{id:1,title:'重复 ID'}]},
    {conversations:[conversation({platform_job_title:'视觉\u200b工程师'})]},
    {conversations:[conversation({platform_job_title:'x'.repeat(161)})]},
    {conversations:[conversation({platform_job_id:'invalid job'})]},
    {account_id:'invalid account'},
  ]){
    const result=resolve(overrides);assert.equal(result.ok,false);assert.equal(result.job_id,null);assert.ok(result.error);
  }
});

test('resolver never mutates job, conversation or previous archive records',()=>{
  const input={jobs,conversations:[conversation()],account_id:'公司-招聘人',mappings:[mapping()]};
  const previous=structuredClone(input);resolveChatJob(input);assert.deepEqual(input,previous);
});
