import test from 'node:test';
import assert from 'node:assert/strict';
import {resumeHeaderIdentity,discoverResumeHeaderIdentity} from '../extension/capture-utils.mjs';

test('current Canvas header discovers one name with adjacent demographic fields and live badges',()=>{
  for(const name of ['沙一鸣','张**','李先生']){
    const resume=`${name}刚刚活跃\n24岁 | 本科 | 1年 | 离职-随时到岗\n个人优势\n熟悉视觉算法`;
    assert.deepEqual(discoverResumeHeaderIdentity(resume),{name,identity:resumeHeaderIdentity(resume,name)});
  }
});

test('header discovery rejects ambiguous names, missing metadata and resume prose',()=>{
  for(const resume of ['张**\n本科\n工作经历\n30岁，拥有5年经验',
    '工作经历\n30岁 本科 5年', '项目经理\n本科\n熟悉算法开发',
    '张**\n30岁 本科 5年\n李**\n25岁 硕士 1年',
    '张**\n30岁 31岁 本科 5年'])assert.equal(discoverResumeHeaderIdentity(resume),null);
});

test('favorite identity ignores live badges and metadata order but binds demographic fields',()=>{
  const original=resumeHeaderIdentity('唐汇鑫\n刚刚活跃\n39岁\n本科\n10年以上\n离职-随时到岗\n工作经历','唐汇鑫');
  assert.ok(original);
  assert.equal(resumeHeaderIdentity('唐汇鑫 在线\n39岁 | 10年以上 | 本科 | 离职-随时到岗\n其他正文','唐汇鑫'),original);
  for(const replacement of ['38岁','硕士','9年']){
    const text='唐汇鑫\n39岁 本科 10年以上'.replace(replacement==='38岁'?'39岁':replacement==='硕士'?'本科':'10年以上',replacement);
    assert.notEqual(resumeHeaderIdentity(text,'唐汇鑫'),original);
  }
});

test('favorite identity rejects wrong names and never fills missing metadata from resume prose',()=>{
  assert.equal(resumeHeaderIdentity('另一位\n39岁 本科 10年以上','唐汇鑫'),'');
  assert.equal(resumeHeaderIdentity('唐汇鑫\n本科\n工作经历\n39岁，拥有10年以上经验','唐汇鑫'),'');
  assert.equal(resumeHeaderIdentity('唐汇鑫\n39岁 38岁 本科 10年以上','唐汇鑫'),'');
});
