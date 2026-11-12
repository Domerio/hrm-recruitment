import test from 'node:test';
import assert from 'node:assert/strict';
import {createClipboardProof,proveWholeClipboard} from '../extension/copy-proof.mjs';

const header='测试杜**\n29岁 · 8年 · 本科\n';
const firstAnchor='负责多相机视觉系统的软件架构设计、算法实现和设备现场部署，完成工业检测系统的运行验证。';
const secondAnchor='协调机械、电气与软件团队实施生产线联调，编制交付文档，并完成客户现场培训和验收。';
const footer='为妥善保护牛人在BOSS直聘平台提交、发布、展示的简历，未经授权，不得在任何第三方平台进行复制、使用、传播、存储。';
const first=header+'工作经历\n测试项目一\n'+firstAnchor;
const middle=firstAnchor+'\n测试项目二\n'+secondAnchor;
const last=secondAnchor+'\n教育经历\n测试大学本科。\n'+footer;

test('virtual screens prove continuity only through unique substantial overlaps and explicit footer',()=>{
  const proof=createClipboardProof();
  assert.equal(proof.observe(first).complete,false);
  assert.equal(proof.observe(middle).complete,false);
  const result=proof.observe(last);
  assert.equal(result.complete,true);
  assert.equal(result.topVerified,true);
  assert.equal(result.bottomVerified,true);
  assert.equal(result.allScreensRead,true);
  assert.equal(result.screens,3);
  assert.equal(proof.observe(last).complete,true);
  assert.equal(proof.observe(last).accepted,false);
});

test('a genuine one-chapter short resume can complete with header and full terminal',()=>{
  const text=header+'工作经历\n'+firstAnchor+'\n'+footer;
  const result=createClipboardProof().observe(text);
  assert.equal(result.complete,true);
  assert.equal(result.screens,1);
});

test('first screen may have a long introduction before the first chapter',()=>{
  const beginning=header+'个人发展说明\n'+firstAnchor;
  const end=firstAnchor+'\n工作经历\n'+secondAnchor+'\n'+footer;
  const proof=createClipboardProof();
  const initial=proof.observe(beginning);
  assert.equal(initial.accepted,true);
  assert.equal(initial.complete,false);
  assert.equal(proof.observe(end).complete,true);
});

test('a skipped middle screen cannot be bridged by reaching the footer',()=>{
  const proof=createClipboardProof();
  proof.observe(first);
  const result=proof.observe(last);
  assert.equal(result.complete,false);
  assert.match(result.issue,/重叠文字/);
});

test('repetition and a missing footer never certify an internal scroll stall',()=>{
  const proof=createClipboardProof();
  proof.observe(first);
  proof.observe(middle);
  const stalled=proof.observe(middle);
  assert.equal(stalled.complete,false);
  assert.match(stalled.issue,/没有前进/);
  const missingEnd=createClipboardProof();
  missingEnd.observe(first);
  missingEnd.observe(middle);
  assert.equal(missingEnd.observe(secondAnchor+'\n教育经历\n测试大学本科。').complete,false);
});

test('header and a recognized chapter are both required by completion',()=>{
  const absent=createClipboardProof().observe('工作经历\n'+firstAnchor+'\n'+footer);
  assert.equal(absent.complete,false);
  assert.equal(absent.topVerified,false);
  assert.equal(createClipboardProof().observe(header+firstAnchor+'\n'+footer).complete,false);
});

test('repetitive boilerplate and nonunique overlap do not prove the next page',()=>{
  for(const overlap of [
    '负责视觉开发项目交付'.repeat(4),
    '负责设备视觉系统架构设计并协调客户完成现场调试和验收'.repeat(2),
    firstAnchor+'重复分隔'+firstAnchor,
  ]){
    const proof=createClipboardProof();
    proof.observe(header+'工作经历\n'+overlap);
    const result=proof.observe(overlap+'\n教育经历\n测试大学。\n'+footer);
    assert.equal(result.complete,false);
    assert.match(result.issue,/重叠文字/);
  }
});

test('whole-copy fallback needs a verified first-screen header and complete terminal',()=>{
  const whole=header+'工作经历\n'+firstAnchor+'\n教育经历\n测试大学。\n'+footer;
  assert.equal(proveWholeClipboard(whole,first).complete,true);
  assert.equal(proveWholeClipboard(whole,'项目经历\n'+firstAnchor).complete,false);
  assert.equal(proveWholeClipboard(whole.replace(footer,''),first).complete,false);
  assert.equal(proveWholeClipboard(whole+'\n额外未核对内容',first).complete,false);
  assert.equal(proveWholeClipboard(whole.replace('工作经历','工作经历 查看全部'),first).complete,false);
});

test('a counted honor fold prevents whole or sequential clipboard completeness',()=>{
  for(const label of ['展开全部16个所获荣誉','展开全部 16 个所获荣誉','查看全部３项荣誉']){
    const text=header+'所获荣誉\n测试技术创新奖。\n'+label+'\n'+footer;
    assert.equal(proveWholeClipboard(text,header+'所获荣誉').complete,false);
    const result=createClipboardProof().observe(text);
    assert.equal(result.complete,false);
    assert.match(result.issue,/仍有折叠内容/);
  }
  const expanded=header+'所获荣誉\n测试技术创新奖。\n语言能力\n英语熟练。\n'+footer;
  assert.equal(createClipboardProof().observe(expanded).complete,true);
});

test('a footer split between overlapping screens is still recognized',()=>{
  const beforeEnd=footer.slice(0,-12);
  const proof=createClipboardProof();
  const start=header+'工作经历\n'+firstAnchor+'\n'+beforeEnd;
  proof.observe(start);
  assert.equal(proof.observe(beforeEnd+'\n'+footer.slice(-12)).complete,true);
});

test('an unexpected page after a terminal invalidates the completion proof',()=>{
  const proof=createClipboardProof();
  assert.equal(proof.observe(header+'工作经历\n'+firstAnchor+'\n'+footer).complete,true);
  const result=proof.observe('另一份文档或无法关联的新页面');
  assert.equal(result.complete,false);
  assert.equal(result.bottomVerified,false);
  assert.ok(result.issue);
});
