import test from 'node:test';
import assert from 'node:assert/strict';
import {isBossUrl,requestLabel,requestIdentity,safeCandidateLink,summarizeResponse} from '../extension/network-inspect.mjs';

test('network inspection limits requests to BOSS and strips query values',()=>{
  assert.equal(isBossUrl('https://www.zhipin.com/web/chat/recommend'),true);
  assert.equal(isBossUrl('https://www.zhipin.com.evil.example/x'),false);
  assert.equal(requestLabel('https://www.zhipin.com/api/foo?geekId=abc&token=secret'),'/api/foo?geekId&token');
});

test('resume request reveals only non-credential identity parameters',()=>{
  const url='https://www.zhipin.com/wapi/zpjob/view/geek/info/v2?encryptJid=JOB1&expectId=EXP2&lid=LIST3&securityId=secret&challenge=private';
  const ids=requestIdentity(url);
  assert.deepEqual(ids,[{field:'encryptJid',value:'JOB1'},{field:'expectId',value:'EXP2'}]);
  assert.equal(JSON.stringify(ids).includes('secret'),false);
  assert.equal(JSON.stringify(ids).includes('LIST3'),false);
  assert.deepEqual(requestIdentity('https://www.zhipin.com/wapi/zpjob/job/search/job/list?jid=JOB1'),[]);
});

test('network inspection finds candidate identifiers and links without credentials or resume text',()=>{
  const summary=summarizeResponse({code:0,zpData:{geekId:'G123',name:'张三',resume:'个人简历正文',token:'secret',
    candidate:{encryptGeekId:'E456',shareUrl:'https://www.zhipin.com/web/geek/detail?geekId=G123&token=private'},
    avatarUrl:'https://www.zhipin.com/avatar.png'}});
  assert.deepEqual(summary.ids,[{field:'zpData.geekId',value:'G123'},{field:'zpData.candidate.encryptGeekId',value:'E456'}]);
  assert.deepEqual(summary.links,[{field:'zpData.candidate.shareUrl',value:'https://www.zhipin.com/web/geek/detail?geekId=G123&token=%5Bredacted%5D'}]);
  assert.equal(JSON.stringify(summary).includes('个人简历正文'),false);
  assert.equal(JSON.stringify(summary).includes('private'),false);
  assert.equal(summary.businessCode,'0');
  assert.equal(summary.detailShape.find(item=>item.field==='geekDetailInfo').type,'missing');
  assert.deepEqual(summary.dataShape,{type:'object',keys:['geekId','name','resume','candidate','avatarUrl']});
  assert.equal(safeCandidateLink('https://evil.example/geek'), '');
  assert.equal(safeCandidateLink('普通文字'), '');
});
