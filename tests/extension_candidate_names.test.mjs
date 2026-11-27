import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesCandidateNameLine} from '../extension/capture-utils.mjs';
import {createClipboardProof,proveWholeClipboard} from '../extension/copy-proof.mjs';

const footer='为妥善保护牛人在BOSS直聘平台提交的简历，未经授权不得在任何第三方平台进行复制、使用、传播、存储。';
const body='工作经历\n独立负责工业检测设备的软件设计和项目交付，保留全部原始文字。\n教育经历\n示例大学 本科\n'+footer;
test('a bound full name accepts only a complete name and known activity badges',()=>{
  for(const line of ['唐明鑫','唐明鑫 刚刚活跃','唐明鑫 热搜 本月活跃','唐明鑫 3日内活跃','唐明鑫 在线'])
    assert.equal(matchesCandidateNameLine(line,'唐明鑫'),true,line);
  for(const line of ['唐明鑫伟','唐明鑫负责系统研发','唐明鑫的简历','介绍唐明鑫','唐明鑫 王明鑫','唐明鑫**'])
    assert.equal(matchesCandidateNameLine(line,'唐明鑫'),false,line);
  assert.equal(matchesCandidateNameLine('王＊＊ 热搜 刚刚活跃','王**'),true);
  assert.equal(matchesCandidateNameLine('王***','王**'),false);
});

test('a prebound plain Latin name must occupy the whole header line except known activity badges',()=>{
  const expected='smithjones';
  for(const line of [expected,expected+' 在线',expected+' 刚刚活跃'])
    assert.equal(matchesCandidateNameLine(line,expected),true,line);
  for(const line of ['smithjonesjr','smithjones developed OpenCV','介绍 smithjones',
    'OpenCV','smithjones 视觉算法工程师','smithjones**'])
    assert.equal(matchesCandidateNameLine(line,expected),false,line);
  for(const invalid of ['ab','smith123','smith-jones','smithjones'.repeat(4)])
    assert.equal(matchesCandidateNameLine(invalid,invalid),false,invalid);
  const resume=expected+' 刚刚活跃\n39岁 本科 10年以上 离职-随时到岗\n'+body;
  assert.equal(createClipboardProof({expectedName:expected}).observe(resume).complete,true);
  assert.equal(proveWholeClipboard(resume,resume,{expectedName:expected}).complete,true);
  assert.equal(createClipboardProof().observe(resume).complete,false,'Unbound Latin words are not discovered as names');
  const prose=expected+' developed OpenCV\n39岁 本科 10年以上 离职-随时到岗\n'+body;
  assert.equal(createClipboardProof({expectedName:expected}).observe(prose).complete,false);
});

test('full-name whole and sequence proofs require a bound identity and adjacent metadata in either order',()=>{
  for(const meta of ['39岁 本科 10年以上 离职-随时到岗','39岁 10年以上 本科 离职-随时到岗']){
    const first='唐明鑫 刚刚活跃\n'+meta+'\n'+body;
    assert.equal(createClipboardProof({expectedName:'唐明鑫'}).observe(first).complete,true);
    assert.equal(proveWholeClipboard(first,first,{expectedName:'唐明鑫'}).complete,true);
    assert.equal(createClipboardProof().observe(first).complete,false,'Unknown full names must not be guessed from prose');
  }
});

test('full-name proof rejects a prefix collision, mismatched or duplicate name and missing metadata',()=>{
  for(const top of ['唐明鑫伟\n39岁 本科 10年以上','庄宇宁\n39岁 本科 10年以上',
    '唐明鑫负责系统研发\n39岁 本科 10年以上','唐明鑫\n唐明鑫\n39岁 本科 10年以上','唐明鑫']){
    const value=top+'\n'+body;
    assert.equal(createClipboardProof({expectedName:'唐明鑫'}).observe(value).topVerified,false,top);
    assert.equal(proveWholeClipboard(value,value,{expectedName:'唐明鑫'}).complete,false,top);
  }
});
