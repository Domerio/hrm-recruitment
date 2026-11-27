import test from 'node:test';
import assert from 'node:assert/strict';
import {combineScreens} from '../extension/resume-copy.mjs';
import {createClipboardProof} from '../extension/copy-proof.mjs';

const firstOverlap='独立负责工业相机镜头光源选型和视觉系统方案设计，完成机器视觉算法的软件开发与现场技术交付。';
const secondOverlap='协同机械电气团队进行多工位设备测试，建立标定流程和质量验证标准，持续改善检测精度和生产效率。';
const page=resume=>({resume,resume_html:`<p>${resume.replaceAll('\n','<br>')}</p>`});

test('stitches only proof-accepted screen overlaps into one raw resume',()=>{
  const screens=[
    page(`张**\n个人优势\n熟悉机器视觉开发。\n${firstOverlap}`),
    page(`${firstOverlap}\n工作经历\n视觉研发工程师。\n${secondOverlap}`),
    page(`${secondOverlap}\n教育经历\n测试大学计算机本科。`),
  ];
  const proof=createClipboardProof();
  assert.equal(proof.observe(screens[0].resume).accepted,true);
  assert.equal(proof.observe(screens[1].resume).overlap.reason,'accepted');
  assert.equal(proof.observe(screens[2].resume).overlap.reason,'accepted');
  const result=combineScreens(screens);
  assert.equal(result.stitchIssue,undefined);
  const expected=`张**\n个人优势\n熟悉机器视觉开发。\n${firstOverlap}\n工作经历\n视觉研发工程师。\n${secondOverlap}\n教育经历\n测试大学计算机本科。`;
  assert.equal(result.resume,expected);
  assert.equal(result.resume_html,`<pre>${expected}</pre>`);
  assert.equal(result.resume.split(firstOverlap).length-1,1);
  assert.equal(result.resume.split(secondOverlap).length-1,1);
  assert.match(result.resume,/视觉研发工程师。/);
  assert.match(result.resume,/测试大学计算机本科。/);
  assert.match(result.resume_html,/^<pre>/);
  assert.equal(result.resume_html.split(firstOverlap).length-1,1);
});

test('retains disjoint native-scroll text without declaring an unsupported overlap',()=>{
  const screens=[page('张**\n个人优势\n同上'),page('同上\n教育经历\n测试大学计算机本科。')];
  const result=combineScreens(screens);
  assert.equal(result.stitchIssue,undefined);
  assert.equal(result.resume.split('同上').length-1,2);
  assert.match(result.resume_html,/<hr>/);
});

test('an empty overlap cannot silently certify repeated adjacent screens',()=>{
  const screen=page(`张**\n个人优势\n${firstOverlap}`);
  const result=combineScreens([screen,screen]);
  assert.match(result.stitchIssue,/较长重复文字/);
  assert.equal(result.resume,`${screen.resume}\n\n${screen.resume}`);
});

test('a long repeated non-suffix chunk is kept for review and never certified',()=>{
  const first=page(`张**\n工作经历\n${firstOverlap}\n第一段独立结尾。`);
  const second=page(`第二段独立开头。\n${firstOverlap}\n教育经历\n测试大学计算机本科。`);
  const result=combineScreens([first,second]);
  assert.match(result.stitchIssue,/较长重复文字/);
  assert.equal(result.resume,`${first.resume}\n\n${second.resume}`);
});

test('keeps the original screens and marks incomplete if a normalized overlap has no raw boundary',()=>{
  const anchor=firstOverlap.slice(0,-1)+'f';
  const screens=[page(`张**\n个人优势\n${anchor}`),
    page(`${anchor.slice(0,-1)}ﬀ\n教育经历\n测试大学计算机本科。`)];
  const proof=createClipboardProof();
  proof.observe(screens[0].resume);
  assert.equal(proof.observe(screens[1].resume).overlap.reason,'accepted');
  const result=combineScreens(screens);
  assert.match(result.stitchIssue,/无法精确对应原文边界/);
  assert.equal(result.resume,`${screens[0].resume}\n\n${screens[1].resume}`);
});

test('raw overlap includes the exact trailing punctuation and whitespace already copied',()=>{
  const anchor=firstOverlap.slice(0,-1);
  for(const ending of ['。','；','！','。  ','。\n','。\r\n','。  \r\n\t']){
    const heading='张**\r\n个人优势\r\n',tail='教育经历\r\n测试大学计算机本科。';
    const screens=[page(heading+anchor+ending),page(anchor+ending+tail)];
    const result=combineScreens(screens);
    assert.equal(result.stitchIssue,undefined,JSON.stringify(ending));
    assert.equal(result.resume,heading+anchor+ending+tail,JSON.stringify(ending));
  }
});

test('a whole NFKC-expanding character is retained once at an exact raw boundary',()=>{
  const anchor=firstOverlap+' ﬀ Å 𝑥。\r\n',heading='张**\r\n个人优势\r\n';
  const tail='教育经历\r\n测试大学计算机本科。';
  const result=combineScreens([page(heading+anchor),page(anchor+tail)]);
  assert.equal(result.stitchIssue,undefined);
  assert.equal(result.resume,heading+anchor+tail);
});

test('normalized punctuation, whitespace or NFKC agreement cannot replace an exact raw join',()=>{
  const anchor=firstOverlap.slice(0,-1),heading='张**\n个人优势\n',tail='\n教育经历\n测试大学本科。';
  for(const [before,after] of [
    [anchor+'。',anchor+'！'],
    [anchor+'。\r\n',anchor+'。\n'],
    [anchor+'。 ',anchor+'。'],
    [anchor+'Ａ。',anchor+'A。'],
    [anchor+'ﬀ。',anchor+'ff。'],
    [anchor+'。',anchor.replace('工业相机','工业 相机')+'。'],
  ]){
    const screens=[page(heading+before),page(after+tail)];
    const proof=createClipboardProof();
    proof.observe(screens[0].resume);
    assert.equal(proof.observe(screens[1].resume).overlap.reason,'accepted');
    const result=combineScreens(screens);
    assert.match(result.stitchIssue,/无法精确对应原文边界/);
    assert.equal(result.resume,screens[0].resume+'\n\n'+screens[1].resume);
  }
});

test('raw stitching preserves a genuine repeated description in a different project',()=>{
  const heading='张**\n工作经历\n第一项目。\n';
  const next='\n第二项目。\n'+firstOverlap+'\n教育经历\n测试大学本科。';
  const result=combineScreens([
    page(heading+firstOverlap+'\n'+secondOverlap),
    page(secondOverlap+next),
  ]);
  assert.equal(result.stitchIssue,undefined);
  assert.equal(result.resume,heading+firstOverlap+'\n'+secondOverlap+next);
  assert.equal(result.resume.split(firstOverlap).length-1,2);
});

test('punctuation beyond the exact previous suffix remains new content',()=>{
  const heading='张**\n个人优势\n',tail='。\n教育经历\n测试大学本科。';
  const result=combineScreens([page(heading+firstOverlap),page(firstOverlap+tail)]);
  assert.equal(result.stitchIssue,undefined);
  assert.equal(result.resume,heading+firstOverlap+tail);
});
