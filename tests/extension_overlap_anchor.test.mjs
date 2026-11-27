import test from 'node:test';
import assert from 'node:assert/strict';
import {createClipboardProof} from '../extension/copy-proof.mjs';
import {readBackgroundResume,backgroundResumeFrame} from '../extension/background-read.mjs';

const header='测试张**\n30岁 8年 本科\n项目经历\n';
const footer='为妥善保护牛人在BOSS直聘平台提交的简历信息，未经授权不得在任何第三方平台进行复制、使用、传播、存储。';
const repeated='产品表面缺陷检测（常用1.基于对比度方法；2.基于阈值方法等，3.基于拉普拉斯的方法检测长划痕等）；';
const distinct='开发多种尺寸测量模块，分别处理二维码定位识别与相机标定，独立完成设备接口封装和生产现场验证，并优化复杂光照下的检测效果。';
const overlap=repeated+'\n'+distinct+'\n'+repeated;
const finalText='\n教育经历\n示例技术大学计算机本科。\n'+footer;
const unique24='甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地';

function prove(anchor,{before=header+anchor,after=anchor+finalText}={}) {
  const proof=createClipboardProof();
  assert.equal(proof.observe(before).accepted,true);
  return proof.observe(after);
}

test('different projects can repeat a technical sentence inside an otherwise distinctive full overlap',()=>{
  const result=prove(overlap);
  assert.equal(result.issue,'');
  assert.equal(result.accepted,true);
  assert.equal(result.complete,true);
  assert.equal(result.screens,2);
});

test('a repeated passage requires a continuous informative nonrepeated span of at least 24 characters',()=>{
  assert.equal([...unique24].length,24);
  assert.equal(prove(repeated+unique24+repeated).complete,true);
  for(const bridge of [unique24.slice(0,-1),'重复分隔','甲'.repeat(24)]) {
    const result=prove(repeated+bridge+repeated);
    assert.equal(result.complete,false);
    assert.match(result.issue,/重叠文字/);
  }
});

test('fully periodic text and repeated boilerplate alone still cannot certify continuity',()=>{
  for(const anchor of [repeated.repeat(3),'负责视觉开发项目交付'.repeat(8),unique24.repeat(3)]) {
    const result=prove(anchor);
    assert.equal(result.complete,false);
    assert.equal(result.accepted,false);
    assert.match(result.issue,/重叠文字/);
  }
});

test('a distinctive overlap must still occur only once in each adjacent screen',()=>{
  for(const variants of [
    {before:header+overlap+'\n独立的中间内容\n'+overlap},
    {after:overlap+'\n独立的中间内容\n'+overlap+finalText},
  ]) {
    const result=prove(overlap,variants);
    assert.equal(result.complete,false);
    assert.match(result.issue,/重叠文字/);
  }
});

test('an overlap already repeated in accepted earlier content is ambiguous even when both current screens are unique',()=>{
  const transition='协调机械电气团队进行多工位设备测试，建立标定流程和质量验证标准，持续改善检测精度和生产效率。';
  const proof=createClipboardProof();
  assert.equal(proof.observe(header+overlap+'\n'+transition).accepted,true);
  assert.equal(proof.observe(transition+'\n其他项目已完成交付。\n'+overlap).accepted,true);
  const result=proof.observe(overlap+finalText);
  assert.equal(result.complete,false);
  assert.match(result.issue,/重叠文字/);
});

test('a useful interior anchor cannot bridge missing text at the actual screen boundary',()=>{
  const result=prove(overlap,{before:header+overlap+'\n仍需读取的重要尾部职责。'});
  assert.equal(result.complete,false);
  assert.match(result.issue,/重叠文字/);
});

test('a full unique overlap cannot rely on an independent passage repeated elsewhere in either screen',()=>{
  for(const variants of [
    {before:header+distinct+'\n另一处项目开始\n'+overlap},
    {after:overlap+'\n另一处项目开始\n'+distinct+finalText},
  ]) {
    const result=prove(overlap,variants);
    assert.equal(result.complete,false);
    assert.match(result.issue,/重叠文字/);
  }
});

function reader(texts,{boundary=false,stepPixels=275,largeStepSkipsMiddle=false}={}) {
  let index=0,revision=0;
  const tab={id:13,url:'https://www.zhipin.com/web/chat/search',active:false};
  const actions=[],steps=[];
  const geometry=()=>({scrollMode:'native',scrollTop:index*stepPixels,scrollPositions:[index*stepPixels],
    clientHeight:500,scrollHeight:(texts.length-1)*stepPixels+500,contentTopVisible:index===0,
    contentBottomVisible:index===texts.length-1,contentWidthVisible:true});
  const browser={tabs:{get:async()=>({...tab})},scripting:{executeScript:async({target,world,func,args})=>{
    assert.deepEqual(target,{tabId:13,documentIds:['synthetic-resume']});
    assert.equal(world,'MAIN');assert.equal(func,backgroundResumeFrame);
    const [action,params]=args;actions.push(action);
    if(action==='cleanup')return [];
    let result;
    if(action==='top'){index=0;result={geometry:geometry()};}
    else if(action==='next'){
      steps.push(params.stepRatio);
      index=Math.min(index+(largeStepSkipsMiddle&&index===0&&params.stepRatio>.3?2:1),texts.length-1);
      result={geometry:geometry()};
    }
    else if(action==='restore'){
      assert.equal(params.scrollPositions.length,1);index=params.scrollPositions[0]/stepPixels;result={geometry:geometry()};
    }else result={version:1,canvasId:'same-canvas',revision:++revision,text:texts[index],issue:'',marks:[],
      geometry:geometry(),boundaryRows:{top:boundary&&index>0,bottom:boundary&&index<texts.length-1},
      diagnostics:{baseline:true,entries:747,operations:{drawImage:4,restore:1},reasonCounts:[]}};
    return [{documentId:'synthetic-resume',result}];
  }}};
  for(const key of ['debugger','windows','clipboard'])Object.defineProperty(browser,key,{get(){throw Error('Unexpected foreground dependency');}});
  return {actions,steps,read:()=>readBackgroundResume({browser,tab,documentId:'synthetic-resume',name:'测试张**',pause:async()=>{}})};
}

test('background reading preserves every repeated technical sentence and exact raw punctuation across deferred boundary rows',async()=>{
  const first=header+'表达式 A < B && C > D 保留原样。\n'+overlap;
  const h=reader([first,overlap+finalText],{boundary:true});
  const result=await h.read();
  assert.equal(result.issue,undefined);
  assert.equal(result.resume,first+finalText);
  assert.equal(result.resume.split(repeated).length-1,2);
  assert.match(result.resume_html,/A &lt; B &amp;&amp; C &gt; D/);
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(result.completeness.stableBottomReads,2);
  assert.equal(result.screens,2);
  assert.equal(h.actions.filter(action=>action==='restore').length,0);
  assert.equal(h.actions.at(-1),'cleanup');
});

test('normalized matching still cannot merge raw overlap with changed spaces or punctuation',async()=>{
  for(const changed of [overlap.replaceAll('基于','基 于'),overlap.replaceAll('；',';')]) {
    const first=header+overlap,h=reader([first,changed+finalText]);
    const result=await h.read();
    assert.equal(result.completeness.allScreensRead,false);
    assert.match(result.issue,/精确重叠/);
    assert.equal(result.resume,first);
    assert.equal(result.failureReason,'continuity-overlap');
    const diagnostic=result.diagnostics.overlap;
    assertSafeOverlapDiagnostic(diagnostic,true);
    assert.equal(diagnostic.reason,'raw');
    assert.ok(diagnostic.rawOverlapLength<24);
    assert.ok(diagnostic.letterCount>=24);
    assert.equal(diagnostic.previousLength,first.length);
    assert.equal(diagnostic.currentLength,(changed+finalText).length);
    assert.equal(diagnostic.retries,2);
    assert.equal(diagnostic.stepPercent,13.75);
    assert.equal(h.actions.at(-1),'cleanup');
  }
});

test('a long normalized overlap cannot silently fall back to its shorter repeated raw prefix',async()=>{
  for(const changedDistinct of [
    distinct.replace('二维码定位识别','二维码 定位识别'),
    distinct.replace('模块，','模块,'),
  ]) {
    // Both edge passages are exactly identical. Only the unique middle changes
    // layout, so a naive raw suffix/prefix match can regress to the short edge
    // and append the entire middle plus its repeated end a second time.
    const first=header+overlap,next=repeated+'\n'+changedDistinct+'\n'+repeated+finalText;
    const h=reader([first,next]),result=await h.read();
    assert.equal(result.completeness.allScreensRead,false);
    assert.match(result.issue,/精确重叠/);
    assert.equal(result.resume,first);
    assert.equal(result.resume.split(repeated).length-1,2);
    assert.equal(result.failureReason,'continuity-overlap');
    const diagnostic=result.diagnostics.overlap;
    assertSafeOverlapDiagnostic(diagnostic,true);
    assert.equal(diagnostic.reason,'raw');
    assert.equal(diagnostic.rawOverlapLength,repeated.length);
    assert.ok(diagnostic.rawOverlapLength>=24);
    assert.ok(diagnostic.overlapLength>diagnostic.rawOverlapLength);
    assert.equal(h.actions.at(-1),'cleanup');
  }
});

function assertSafeOverlapDiagnostic(diagnostic,fromReader=false) {
  const keys=['reason','overlapLength','letterCount','distinctLetters','duplicateWindows','independentRunLength',
    'previousMatches','currentMatches','assembledMatches'];
  if(fromReader)keys.push('rawOverlapLength','previousLength','currentLength','retries','stepPercent');
  assert.deepEqual(Object.keys(diagnostic).sort(),keys.sort());
  assert.ok(['accepted','short','repetitive','independent','ambiguous','footer','raw'].includes(diagnostic.reason));
  for(const [key,value] of Object.entries(diagnostic)) {
    if(key==='reason')continue;
    assert.equal(typeof value,'number');
    assert.ok(Number.isFinite(value)&&value>=0,key);
    if(key!=='stepPercent')assert.ok(Number.isSafeInteger(value),key);
    if(key.endsWith('Matches'))assert.ok(value<=2,key);
  }
  assert.doesNotMatch(JSON.stringify(diagnostic),/产品|开发|张|原文|https|private/);
}

test('overlap diagnostics distinguish real duplicate prose from insufficient or ambiguous evidence without storing text',()=>{
  for(const [anchor,options,reason] of [
    [overlap,{},'accepted'],
    [repeated+'重复分隔'+repeated,{},'independent'],
    ['很短的重叠',{},'short'],
    [repeated.repeat(3),{},'repetitive'],
    [overlap,{before:header+overlap+'\n另一项目\n'+overlap},'ambiguous'],
  ]) {
    const result=prove(anchor,options),diagnostic=result.overlap;
    assertSafeOverlapDiagnostic(diagnostic);
    assert.equal(diagnostic.reason,reason);
    if(reason==='accepted'||reason==='independent')assert.ok(diagnostic.duplicateWindows>0);
    if(reason==='accepted'){
      assert.ok(diagnostic.independentRunLength>=24);
      assert.equal(diagnostic.previousMatches,1);
      assert.equal(diagnostic.currentMatches,1);
      assert.equal(diagnostic.assembledMatches,1);
    }
    if(reason==='independent')assert.equal(diagnostic.independentRunLength,4);
    if(reason==='ambiguous')assert.equal(diagnostic.previousMatches,2);
  }
});

test('bounded failed recovery reports independent evidence and exact matching lengths, without candidate text',async()=>{
  const anchor=repeated+'重复分隔'+repeated,first=header+anchor,next=anchor+finalText;
  const h=reader([first,next],{boundary:true}),result=await h.read();
  assert.equal(result.failureReason,'continuity-overlap');
  assert.equal(result.completeness.allScreensRead,false);
  assert.equal(result.resume,first);
  const diagnostic=result.diagnostics.overlap;
  assertSafeOverlapDiagnostic(diagnostic,true);
  assert.equal(diagnostic.reason,'independent');
  assert.equal(diagnostic.independentRunLength,4);
  assert.ok(diagnostic.duplicateWindows>0);
  assert.equal(diagnostic.rawOverlapLength,anchor.length);
  assert.equal(diagnostic.previousLength,first.length);
  assert.equal(diagnostic.currentLength,next.length);
  assert.equal(diagnostic.retries,2);
  assert.equal(diagnostic.stepPercent,13.75);
  assert.equal(h.actions.filter(action=>action==='restore').length,2);
});

test('a smaller retry proves the larger distinctive overlap despite locally repeated project descriptions',async()=>{
  const tailAnchor='协同机械电气团队完成设备运行验证，并形成可靠的生产交付报告，对采集参数和质量标准进行独立核验。';
  const first=header+overlap,middle=overlap+'\n'+tailAnchor,last=tailAnchor+finalText;
  const h=reader([first,middle,last],{boundary:true,stepPixels:137.5,largeStepSkipsMiddle:true});
  const result=await h.read();
  assert.equal(result.issue,undefined);
  assert.equal(result.resume,first+'\n'+tailAnchor+finalText);
  assert.equal(result.resume.split(repeated).length-1,2);
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(result.completeness.stableBottomReads,2);
  assert.equal(result.screens,3);
  assert.deepEqual(h.steps,[.55,.275,.275]);
  assert.equal(h.actions.filter(action=>action==='restore').length,1);
  assert.equal(h.actions.at(-1),'cleanup');
});
