import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readBackgroundResume,backgroundResumeFrame} from '../extension/background-read.mjs';

const footer='为妥善保护牛人在BOSS直聘平台提交的简历信息，未经授权不得在任何第三方平台进行复制、使用、传播、存储。';
const overlapA='独立负责工业相机镜头光源选型和视觉系统方案设计，完成机器视觉算法的软件开发与现场技术交付。';
const overlapB='协同机械电气团队进行多工位设备测试，建立标定流程和质量验证标准，持续改善检测精度和生产效率。';
const pages=[
  '张**\n个人优势\n熟悉 C++ 与图像处理，保留 A < B & C 的原始符号。\n'+overlapA,
  overlapA+'\n工作经历\n虚构测试设备公司，视觉研发工程师。\n'+overlapB,
  overlapB+'\n教育经历\n虚构测试大学计算机本科。\n'+footer,
];
function harness(options={}) {
  let index=0,samples=0,expansions=0,stopped=false;
  let texts=options.texts||pages;
  const actions=[],pauses=[];
  const tab={id:7,url:'https://www.zhipin.com/web/chat/search',active:false};
  const geometry=()=>({scrollMode:options.stationary?'stationary':'native',scrollTop:options.stationary?0:index*275,
    clientHeight:500,scrollHeight:options.stationary?500:(texts.length-1)*275+500,
    contentTopVisible:index===0,contentBottomVisible:index===texts.length-1,contentWidthVisible:true});
  const browser={
    tabs:{get:async()=>({...tab,url:options.urlChange&&index||options.urlChangeAtSample&&samples>=options.urlChangeAtSample?tab.url+'?changed':tab.url})},
    scripting:{executeScript:async({target,world,func,args})=>{
      assert.equal(target.tabId,7);assert.deepEqual(target.documentIds,['resume-7']);assert.equal(world,'MAIN');
      assert.equal(func,backgroundResumeFrame);
      const [action,arg]=args;actions.push(action);let result;
      if(action==='cleanup')return [];
      if(action==='top'){index=0;result={geometry:geometry()};}
      else if(action==='next'){index=Math.min(index+1,texts.length-1);if(options.stopAfterNext)stopped=true;result={geometry:geometry()};}
      else if(action==='expand'){assert.equal(arg.mark.label,'查看全部');expansions++;texts=options.expandedTexts||texts;index=0;result=true;}
      else {
        samples++;
        result={version:1,canvasId:options.canvasChange&&index?'canvas-new':'canvas-1',revision:samples,
          text:texts[index],geometry:geometry(),marks:options.marks||[],
          issue:options.issueAfterNext?(index?options.issue:''):options.issue||'',
          issueCode:options.issueCode,diagnostics:options.diagnostics};
        Object.assign(result,options.sampleResult?.({action,index,samples,expansions}));
        if(options.gap&&index)result.geometry.scrollTop+=1000;
      }
      return [{documentId:options.documentChange&&index||options.documentChangeAtSample&&samples>=options.documentChangeAtSample?'different-document':'resume-7',result}];
    }},
  };
  // These getters would fail immediately if background reading regressed to
  // the foreground-only clipboard/debugger/window activation code path.
  for(const key of ['debugger','windows','clipboard'])Object.defineProperty(browser,key,{get(){throw Error('Forbidden foreground dependency: '+key);}});
  return {actions,pauses,read:()=>readBackgroundResume({browser,tab,documentId:'resume-7',name:options.name||'张**',identity:options.identity,
    check:()=>{if(stopped)throw Error('任务已停止');},pause:async ms=>{
      pauses.push(ms);if(options.stopAtPause===pauses.length)stopped=true;
    },report:()=>{}})};
}

test('reads an inactive tab with exact raw text, escaped HTML and a stable verified end',async()=>{
  const h=harness();const result=await h.read();
  assert.equal(result.issue,undefined);
  assert.equal(result.screens,3);
  assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,allScreensRead:true,stableBottomReads:2});
  assert.equal(result.resume,pages[0]+pages[1].slice(overlapA.length)+pages[2].slice(overlapB.length));
  assert.match(result.resume_html,/A &lt; B &amp; C/);
  assert.equal(h.actions.at(-1),'cleanup');
});

test('accepts stationary virtual scrolling only with continuous text and the platform footer',async()=>{
  const result=await harness({stationary:true}).read();
  assert.equal(result.issue,undefined);assert.equal(result.completeness.allScreensRead,true);
});

test('recommendation full names read with either metadata order and preserve exact multiline raw text',async()=>{
  for(const meta of ['39岁 本科 10年以上 离职-随时到岗','39岁 10年以上 本科 离职-随时到岗']){
    const texts=pages.map((value,index)=>index===0?value.replace('张**','唐明鑫 刚刚活跃\n'+meta):value);
    const result=await harness({name:'唐明鑫',texts}).read();
    assert.equal(result.issue,undefined);
    assert.equal(result.completeness.allScreensRead,true);
    assert.equal(result.resume,texts[0]+texts[1].slice(overlapA.length)+texts[2].slice(overlapB.length));
  }
});

test('a longer or prose-prefixed full name cannot pass the bound first-screen identity',async()=>{
  for(const header of ['唐明鑫伟','唐明鑫负责系统研发','庄宇宁']){
    const texts=pages.map((value,index)=>index===0?value.replace('张**',header+'\n39岁 本科 10年以上'):value);
    const result=await harness({name:'唐明鑫',texts}).read();
    assert.match(result.issue,/姓名.*不一致/);assert.equal(result.resume,'');
  }
});

test('a current-resume identity remains bound at the first screen and after reading the complete tail',async()=>{
  const identity={version:1,documentId:'resume-7',canvasId:'canvas-1',name:'张**',headerKey:'["张**","30岁8年本科"]'};
  const h=harness({identity,sampleResult:({action})=>action==='identity'?{identity,diagnostics:{baseline:true}}:{}});
  const result=await h.read();
  assert.equal(result.issue,undefined);assert.equal(result.identityVerified,true);assert.equal(result.completeness.allScreensRead,true);
  assert.equal(h.actions.filter(action=>action==='identity').length,4);
  assert.ok(h.actions.lastIndexOf('top')>h.actions.lastIndexOf('next'));
  assert.equal(result.identity,undefined);assert.equal(result.headerKey,undefined);
});

test('a same-name header change after reading prevents direct evaluation and does not leak the binding into diagnostics',async()=>{
  const identity={version:1,documentId:'resume-7',canvasId:'canvas-1',name:'张**',headerKey:'["张**","30岁8年本科"]'};
  let identities=0;
  const h=harness({identity,sampleResult:({action})=>action==='identity'?{identity:{...identity,
    headerKey:++identities>2?'["张**","31岁9年硕士"]':identity.headerKey},diagnostics:{baseline:true}}:{}});
  const result=await h.read();
  assert.match(result.issue,/页首资料已变化/);assert.equal(result.identityVerified,false);
  assert.equal(result.completeness.allScreensRead,false);
  assert.doesNotMatch(JSON.stringify(result.diagnostics),/headerKey|张|30岁|31岁/);
});

test('invalid or differently named identity bindings fail before opening the reader session',async()=>{
  for(const identity of [{version:1},{version:1,documentId:'other',canvasId:'canvas-1',name:'张**',headerKey:'key'},
    {version:1,documentId:'resume-7',canvasId:'canvas-1',name:'李**',headerKey:'key'}]){
    const h=harness({identity});await assert.rejects(h.read(),/身份绑定无效/);assert.deepEqual(h.actions,[]);
  }
});

test('deferred vertical rows are recovered through continuous screens before a clean terminal is accepted',async()=>{
  for(const stationary of [true,false]){
    const result=await harness({stationary,sampleResult:({index})=>({boundaryRows:{top:index>0,bottom:index<2}})}).read();
    assert.equal(result.issue,undefined);assert.equal(result.completeness.allScreensRead,true);
    assert.equal(result.resume,pages[0]+pages[1].slice(overlapA.length)+pages[2].slice(overlapB.length));
  }
});

test('a complete header below a clipped first row is not proof of the original beginning',async()=>{
  const result=await harness({sampleResult:()=>({boundaryRows:{top:true,bottom:false}})}).read();
  assert.equal(result.failureReason,'boundary-top');assert.equal(result.completeness.topVerified,false);assert.equal(result.resume,'');
});

test('a complete footer cannot hide an unresolved clipped row below it in native or virtual scrolling',async()=>{
  for(const stationary of [true,false]){
    const h=harness({stationary,texts:['张**\n工作经历\n完整正文\n'+footer],sampleResult:()=>({boundaryRows:{top:false,bottom:true}})});
    const result=await h.read();assert.equal(result.failureReason,'boundary-bottom');
    assert.equal(result.completeness.allScreensRead,false);assert.equal(result.completeness.bottomVerified,false);
    assert.equal(h.actions.filter(action=>action==='next').length,1);
  }
});

test('boundary deferral never replaces the unique overlap requirement for missing middle text',async()=>{
  const result=await harness({texts:[pages[0],pages[2]],sampleResult:({index})=>({boundaryRows:{top:index>0,bottom:index===0}})}).read();
  assert.match(result.issue,/重叠文字/);assert.equal(result.completeness.allScreensRead,false);
});

test('changing boundary evidence requires a new stable pair even when the text stays identical',async()=>{
  const h=harness({texts:['张**\n工作经历\n完整正文\n'+footer],sampleResult:({samples})=>({boundaryRows:{top:false,bottom:samples===2}})});
  const result=await h.read();assert.equal(result.issue,undefined);assert.equal(result.completeness.stableBottomReads,2);
  assert.equal(h.pauses.filter(ms=>ms===180).length,3);
});

test('a single full screen still needs two stable bottom reads',async()=>{
  const result=await harness({texts:['张**\n工作经历\n虚构内容\n'+footer]}).read();
  assert.equal(result.issue,undefined);assert.equal(result.screens,1);
  assert.equal(result.completeness.stableBottomReads,2);
});

test('rejects missing overlap rather than accepting a later visible footer',async()=>{
  const result=await harness({texts:[pages[0],pages[2]]}).read();
  assert.match(result.issue,/重叠文字/);assert.equal(result.completeness.allScreensRead,false);
});

test('normalized overlap cannot silently duplicate differently spaced raw text',async()=>{
  const spaced=overlapA.match(/.{1,10}/gu).join(' ');
  const result=await harness({texts:[pages[0],pages[1].replace(overlapA,spaced),pages[2]]}).read();
  assert.match(result.issue,/精确重叠/);
  assert.equal(result.resume,pages[0]);
  assert.equal(result.completeness.allScreensRead,false);
});

test('rejects scroll jumps and stale text after movement',async()=>{
  assert.match((await harness({gap:true}).read()).issue,/滚动跨度/);
  assert.match((await harness({texts:[pages[0],pages[0]]}).read()).issue,/原文未更新/);
});

// A normal wheel skips the middle viewport. A smaller wheel can recover it,
// but only after returning to and verifying the exact accepted viewport.
function overlapRecoveryHarness(options={}) {
  const overlapC='完成系统联调和异常处理机制建设，编写设备操作手册，组织交付培训并持续跟踪运行质量和客户反馈。';
  const texts=[pages[0],pages[1],overlapB+'\n项目经历\n可靠性验证与现场培训。\n'+overlapC,overlapC+'\n教育经历\n虚构大学本科。\n'+footer];
  let offset=0,stopped=false,restores=0,moveReads=0,restoreReads=0,staleText='',moving=false,restoring=false,stepRatio=.55;
  const actions=[],reports=[],pauses=[],maxOffset=412.5;
  const tab={id:7,url:'https://www.zhipin.com/web/chat/search',active:false};
  const currentText=()=>texts[Math.min(3,Math.floor(offset/137.5))];
  const geometry=()=>({scrollMode:options.stationary?'stationary':'native',scrollTop:options.stationary?0:offset,
    scrollPositions:options.stationary?[]:[offset],clientHeight:500,scrollHeight:options.stationary?500:maxOffset+500,
    contentTopVisible:offset===0,contentBottomVisible:offset===maxOffset,contentWidthVisible:true});
  const browser={tabs:{get:async()=>tab},scripting:{executeScript:async({target,world,func,args})=>{
    assert.deepEqual(target,{tabId:7,documentIds:['resume-7']});assert.equal(world,'MAIN');assert.equal(func,backgroundResumeFrame);
    const [action,arg]=args;actions.push({action,...arg});let result;
    if(action==='cleanup')return [];
    if(action==='top'){offset=0;moving=false;restoring=false;result={geometry:geometry()};}
    else if(action==='restore'){
      assert.equal(options.stationary,undefined);assert.deepEqual(arg.scrollPositions,[0]);
      staleText=currentText();offset=arg.scrollPositions[0];restores++;restoreReads=0;moving=false;restoring=true;
      if(options.stopOnRestore)stopped=true;result={geometry:geometry()};
    }else if(action==='next'){
      staleText=currentText();moveReads=0;moving=true;restoring=false;stepRatio=arg.stepRatio;
      offset=Math.min(maxOffset,offset+500*arg.stepRatio*(options.overscroll&&arg.stepRatio>.3?2:1));
      result={geometry:geometry()};
    }else{
      let text=currentText();
      if(moving&&++moveReads<=(options.staleReads||0))text=staleText;
      if(moving&&options.staleLargeStep&&stepRatio>.3)text=staleText;
      if(restoring&&++restoreReads<=(options.restoreStaleReads||0))text=staleText;
      if(options.changedRestore&&restores&&offset===0)text=text.replace('熟悉','修改');
      if(options.unrecoverable&&offset>0)text='无关联的后续正文，不允许直接拼接。\n'+footer;
      result={version:1,canvasId:'canvas-1',revision:actions.length,text,marks:[],geometry:geometry(),
        diagnostics:{baseline:true,entries:text.length}};
    }
    return [{documentId:options.documentChangeOnRestore&&action==='restore'?'replacement':'resume-7',result}];
  }}};
  return {actions,reports,pauses,texts,expected:texts[0]+texts[1].slice(overlapA.length)+texts[2].slice(overlapB.length)+texts[3].slice(overlapC.length),
    read:()=>readBackgroundResume({browser,tab,documentId:'resume-7',name:'张**',
      check:()=>{if(stopped)throw Error('任务已停止');},report:message=>reports.push(message),pause:async ms=>{pauses.push(ms);}})};
}

test('missing overlap recovers by verifying the previous viewport and taking a smaller step without dropping text',async()=>{
  const h=overlapRecoveryHarness(),result=await h.read();
  assert.equal(result.issue,undefined);assert.equal(result.resume,h.expected);assert.equal(result.screens,4);
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(h.actions.filter(row=>row.action==='restore').length,1);
  assert.deepEqual(h.actions.filter(row=>row.action==='next').map(row=>row.stepRatio),[.55,.275,.275,.275]);
  assert.ok(h.reports.some(message=>message.includes('补读')));assert.equal(h.actions.at(-1).action,'cleanup');
});

test('overscroll uses the same verified anchor recovery and never accepts the jumped footer',async()=>{
  const h=overlapRecoveryHarness({overscroll:true}),result=await h.read();
  assert.equal(result.issue,undefined);assert.equal(result.resume,h.expected);
  assert.equal(h.actions.filter(row=>row.action==='restore').length,1);
});

test('delayed repaint after scrolling and restoring is awaited before continuity is judged',async()=>{
  const h=overlapRecoveryHarness({staleReads:3,restoreStaleReads:3}),result=await h.read();
  assert.equal(result.issue,undefined);assert.equal(result.resume,h.expected);
  assert.equal(h.actions.filter(row=>row.action==='restore').length,1);
  assert.ok(h.pauses.filter(ms=>ms===180).length>=16);
});

test('a stale large-step redraw times out locally and recovers at the smaller verified step',async()=>{
  const h=overlapRecoveryHarness({staleLargeStep:true}),result=await h.read();
  assert.equal(result.issue,undefined);assert.equal(result.resume,h.expected);
  assert.equal(h.actions.filter(row=>row.action==='restore').length,1);
  assert.ok(h.pauses.filter(ms=>ms===180).length>=8);
});

test('virtual scrolling re-proves from the top with a smaller wheel without guessing reverse distance',async()=>{
  const h=overlapRecoveryHarness({stationary:true}),result=await h.read();
  assert.equal(result.issue,undefined);assert.equal(result.resume,h.expected);
  assert.equal(h.actions.filter(row=>row.action==='top').length,2);
  assert.equal(h.actions.filter(row=>row.action==='restore').length,0);
});

test('virtual scrolling waits through a stale redraw but still accepts two stable terminal reads',async()=>{
  const h=overlapRecoveryHarness({stationary:true,staleReads:3}),result=await h.read();
  assert.equal(result.issue,undefined);assert.equal(result.resume,h.expected);
  assert.equal(result.completeness.stableBottomReads,2);
  assert.equal(h.actions.filter(row=>row.action==='top').length,2);
});

test('unrecoverable overlap remains incomplete after bounded retries and excludes rejected text',async()=>{
  const h=overlapRecoveryHarness({unrecoverable:true}),result=await h.read();
  assert.match(result.issue,/重叠文字/);assert.equal(result.completeness.allScreensRead,false);
  assert.equal(result.resume,h.texts[0]);assert.equal(h.actions.filter(row=>row.action==='restore').length,2);
  assert.equal(h.actions.at(-1).action,'cleanup');assert.ok(h.actions.length<40);
});

test('changed text at the restored anchor stops recovery with the accepted prefix intact',async()=>{
  const h=overlapRecoveryHarness({changedRestore:true}),result=await h.read();
  assert.match(result.issue,/上一屏后原文或位置已变化/);assert.equal(result.failureReason,'restore-changed');
  assert.equal(result.resume,h.texts[0]);assert.equal(result.completeness.allScreensRead,false);
  assert.equal(h.actions.filter(row=>row.action==='next').length,1);assert.equal(h.actions.at(-1).action,'cleanup');
});

test('cancellation or document replacement during backtracking prevents another scroll and still cleans up',async()=>{
  for(const options of [{stopOnRestore:true},{documentChangeOnRestore:true}]){
    const h=overlapRecoveryHarness(options);await assert.rejects(h.read(),/任务已停止|框架已关闭或切换/);
    assert.equal(h.actions.filter(row=>row.action==='next').length,1);assert.equal(h.actions.at(-1).action,'cleanup');
  }
});

test('the native bottom alone is not proof of a complete resume',async()=>{
  const result=await harness({texts:[pages[0]]}).read();
  assert.match(result.issue,/没有前进/);assert.equal(result.completeness.bottomVerified,false);
});

test('unsupported drawing returns an issue and cannot save as complete',async()=>{
  const h=harness({issue:'正文使用图片绘制，未确认可读取原文。'});
  const result=await h.read();assert.match(result.issue,/图片/);
  assert.equal(result.resume,'');assert.equal(result.completeness.allScreensRead,false);
  assert.deepEqual(h.actions,['prepare','cleanup']);
});

test('initial baseline errors preserve the typed diagnostic for bounded collector recovery',async()=>{
  const diagnostics={baseline:false,entries:0,overflow:false,reasonCounts:[],operations:{fillText:5}};
  const h=harness({issue:'未从完整重绘开始记录',issueCode:'baseline',diagnostics});
  const result=await h.read();
  assert.equal(result.issueCode,'baseline');assert.deepEqual(result.diagnostics,diagnostics);
  assert.equal(result.completeness.allScreensRead,false);
  assert.deepEqual(h.pauses,Array(20).fill(200));
  assert.equal(h.actions.filter(action=>action==='sample').length,20);
  assert.ok(!h.actions.includes('top'));
});

const renderingFailure={issue:'当前可读取区域没有完整文字行',issueCode:'rendering',text:'',
  diagnostics:{baseline:true,entries:0,overflow:false,reasonCounts:[],operations:{clearRect:1}}};

test('an asynchronous first redraw finishes before the reader moves to the top and proves the complete text',async()=>{
  const h=harness({sampleResult:({samples})=>samples<3?
    {...renderingFailure,issue:'未从完整重绘开始记录',issueCode:'baseline'}:samples<5?renderingFailure:{}});
  const result=await h.read();
  assert.equal(result.issue,undefined);assert.equal(result.completeness.allScreensRead,true);
  assert.deepEqual(h.actions.slice(0,6),['prepare','sample','sample','sample','sample','top']);
  assert.deepEqual(h.pauses.slice(0,4),Array(4).fill(200));
  assert.equal(result.resume,pages[0]+pages[1].slice(overlapA.length)+pages[2].slice(overlapB.length));
});

test('an unfinished initial render times out after four seconds with the last precise diagnostic',async()=>{
  const h=harness({sampleResult:({samples})=>({...renderingFailure,
    diagnostics:{...renderingFailure.diagnostics,operations:{clearRect:samples}}})});
  const result=await h.read();
  assert.equal(result.issue,renderingFailure.issue);assert.equal(result.issueCode,'rendering');
  assert.equal(result.diagnostics.operations.clearRect,21);
  assert.deepEqual(h.pauses,Array(20).fill(200));assert.equal(result.resume,'');
  assert.equal(result.completeness.allScreensRead,false);assert.ok(!h.actions.includes('top'));
});

test('stopping during the first redraw wait prevents further sampling and cleans up',async()=>{
  const h=harness({sampleResult:()=>renderingFailure,stopAtPause:1});
  await assert.rejects(h.read(),/任务已停止/);
  assert.deepEqual(h.actions,['prepare','cleanup']);assert.deepEqual(h.pauses,[200]);
});

test('initial redraw waits keep the document, canvas and page identity pinned',async()=>{
  for(const [options,error] of [
    [{documentChangeAtSample:3},/框架已关闭或切换/],
    [{urlChangeAtSample:2},/跳转/],
    [{sampleResult:({samples})=>({...renderingFailure,canvasId:samples>=3?'other-canvas':'canvas-1'})},/画布已更换/],
  ]) {
    const h=harness({sampleResult:()=>renderingFailure,...options});
    await assert.rejects(h.read(),error);
    assert.equal(h.actions.at(-1),'cleanup');assert.ok(!h.actions.includes('top'));
  }
});

test('unsupported content appearing during the first redraw wait stops immediately',async()=>{
  const unsupported={issue:'画布文字被局部覆盖',issueCode:'unsupported',
    diagnostics:{...renderingFailure.diagnostics,reasonCounts:[{reason:'画布文字被局部覆盖',count:1}]}};
  const h=harness({sampleResult:({samples})=>samples===1?renderingFailure:unsupported});
  const result=await h.read();
  assert.equal(result.issue,unsupported.issue);assert.equal(result.issueCode,'unsupported');
  assert.deepEqual(result.diagnostics,unsupported.diagnostics);
  assert.deepEqual(h.actions,['prepare','sample','cleanup']);assert.deepEqual(h.pauses,[200]);
});

test('a later asynchronous screen may finish rendering before stable text is verified',async()=>{
  let laterSamples=0;
  const h=harness({sampleResult:({index})=>index===1&&++laterSamples<=3?renderingFailure:{}});
  const result=await h.read();
  assert.equal(result.issue,undefined);assert.equal(result.completeness.allScreensRead,true);
  assert.equal(laterSamples,5);assert.ok(!h.pauses.includes(200));
});

test('a later unfinished screen returns its rendering issue after eight bounded waits',async()=>{
  let laterSamples=0;
  const h=harness({sampleResult:({index})=>index===1?{...renderingFailure,
    diagnostics:{...renderingFailure.diagnostics,operations:{clearRect:++laterSamples}}}:{}});
  const result=await h.read();
  assert.equal(laterSamples,9);assert.equal(result.issueCode,'rendering');
  assert.equal(result.issue,renderingFailure.issue);assert.equal(result.diagnostics.operations.clearRect,9);
  assert.equal(h.pauses.filter(ms=>ms===180).length,9); // One first-screen stability wait plus eight render waits.
  assert.equal(result.resume,pages[0]);assert.equal(result.completeness.allScreensRead,false);
});

test('a later baseline error is not treated as a temporary render',async()=>{
  let laterSamples=0;
  const h=harness({sampleResult:({index})=>index===1?{...renderingFailure,issueCode:'baseline',
    issue:'未从完整重绘开始记录',diagnostics:{...renderingFailure.diagnostics,entries:++laterSamples}}:{}});
  const result=await h.read();
  assert.equal(laterSamples,1);assert.equal(result.issueCode,'baseline');
  assert.equal(result.diagnostics.entries,1);assert.equal(result.resume,pages[0]);
  assert.equal(h.pauses.filter(ms=>ms===180).length,1);
});

test('stopping or encountering unsupported content during a later render prevents further reads',async()=>{
  const stopped=harness({sampleResult:({index})=>index===1?renderingFailure:{},stopAtPause:4});
  await assert.rejects(stopped.read(),/任务已停止/);
  assert.deepEqual(stopped.actions.slice(-2),['sample','cleanup']);
  let laterSamples=0;
  const h=harness({sampleResult:({index})=>index===1?++laterSamples===1?renderingFailure:
    {issue:'画布文字被局部覆盖',issueCode:'unsupported'}:{}});
  const result=await h.read();assert.equal(result.issueCode,'unsupported');assert.equal(laterSamples,2);
  assert.equal(h.pauses.filter(ms=>ms===180).length,2);
});

test('a later unsupported drawing preserves diagnostics without claiming complete text',async()=>{
  const diagnostics={baseline:true,entries:80,overflow:true,reasonCounts:[{reason:'画布文字重叠，无法确认正文顺序',count:70}],operations:{fillText:150}};
  const result=await harness({issue:'画布文字重叠，无法确认正文顺序',issueAfterNext:true,issueCode:'unsupported',diagnostics}).read();
  assert.equal(result.issueCode,'unsupported');assert.deepEqual(result.diagnostics,diagnostics);
  assert.equal(result.resume,pages[0]);assert.equal(result.completeness.allScreensRead,false);
});

test('geometry and stability failures preserve the exact fixed reason with successful drawing diagnostics',async()=>{
  const diagnostics={baseline:true,entries:902,ignoredImages:3,overflow:false,reasonCounts:[],operations:{fillText:937}};
  for(const [failureReason,sampleResult] of [
    ['width-clipped',()=>({geometry:{scrollTop:0,clientHeight:500,scrollHeight:500,contentWidthVisible:false}})],
    ['readable-region',()=>({geometry:{scrollTop:0,clientHeight:NaN,scrollHeight:500,contentWidthVisible:true}})],
    ['unstable',({samples})=>({text:pages[0]+String(samples)})],
    ['canvas-range',()=>({issue:'画布读取范围无效',failureReason:'canvas-range'})],
  ]) {
    const h=harness({diagnostics,sampleResult}),result=await h.read();
    assert.equal(result.issueCode,'incomplete');assert.equal(result.failureReason,failureReason);
    assert.deepEqual(result.diagnostics,diagnostics);assert.equal(result.resume,'');
    assert.equal(result.completeness.allScreensRead,false);assert.equal(h.actions.at(-1),'cleanup');
    assert.ok(!h.actions.includes('next'));
    if(failureReason==='unstable')assert.equal(h.pauses.filter(ms=>ms===180).length,8);
  }
});

test('candidate name mismatch cannot become a successful capture',async()=>{
  const result=await harness({name:'李**'}).read();
  assert.match(result.issue,/姓名/);assert.equal(result.completeness.topVerified,false);
});

test('document, canvas or URL replacement stops the reader',async()=>{
  await assert.rejects(harness({documentChange:true}).read(),/框架已关闭或切换/);
  await assert.rejects(harness({canvasChange:true}).read(),/画布已更换/);
  await assert.rejects(harness({urlChange:true}).read(),/跳转/);
});

test('stop after scrolling prevents the next sample and still releases its page session',async()=>{
  const h=harness({stopAfterNext:true});
  await assert.rejects(h.read(),/任务已停止/);
  assert.deepEqual(h.actions.slice(-2),['next','cleanup']);
});

test('unresolved folded content pauses and never clicks arbitrary labels',async()=>{
  const result=await harness({texts:['张**\n工作经历\n查看全部\n'+footer]}).read();
  assert.match(result.issue,/折叠内容/);assert.equal(result.completeness.allScreensRead,false);
});

test('confirmed expansion resets the text proof and rereads from the top',async()=>{
  const h=harness({texts:['张**\n工作经历\n查看全部\n'+footer],expandedTexts:[pages[0]+pages[1].slice(overlapA.length)+pages[2].slice(overlapB.length)],
    marks:[{id:1,label:'查看全部',x:.5,y:.5}]});
  const result=await h.read();assert.equal(result.issue,undefined);
  assert.equal(h.actions.filter(action=>action==='top').length,2);
  assert.equal(h.actions.filter(action=>action==='expand').length,1);
});

const foldedIntro='张**\n个人优势\n熟悉视觉算法，负责检测项目开发... 查看全部\n工作经历\n'+footer;
const unfoldedResume=pages[0]+pages[1].slice(overlapA.length)+pages[2].slice(overlapB.length);
const introMark={id:1,label:'查看全部',x:.8,y:.3};

test('a verified visible inline expander runs before the full-width reading check',async()=>{
  const h=harness({texts:[foldedIntro],expandedTexts:[unfoldedResume],marks:[introMark],sampleResult:({expansions})=>({
    geometry:{scrollMode:'native',scrollTop:0,clientHeight:500,scrollHeight:500,contentWidthVisible:expansions>0},
  })});
  const result=await h.read();assert.equal(result.issue,undefined);assert.equal(result.resume,unfoldedResume);
  assert.equal(result.completeness.allScreensRead,true);assert.equal(h.actions.filter(action=>action==='expand').length,1);
  assert.equal(h.actions.filter(action=>action==='top').length,2);
});

test('expanding a clipped canvas never waives the subsequent full-width reading check',async()=>{
  const h=harness({texts:[foldedIntro],expandedTexts:[unfoldedResume],marks:[introMark],sampleResult:()=>({
    geometry:{scrollMode:'native',scrollTop:0,clientHeight:500,scrollHeight:500,contentWidthVisible:false},
  })});
  const result=await h.read();assert.equal(result.failureReason,'width-clipped');assert.equal(result.resume,'');
  assert.equal(result.completeness.allScreensRead,false);assert.equal(h.actions.filter(action=>action==='expand').length,1);
});

test('a clipped canvas without a verified control cannot trigger an expansion',async()=>{
  const h=harness({texts:[foldedIntro],marks:[{...introMark,label:'联系TA'}],sampleResult:()=>({
    geometry:{scrollMode:'native',scrollTop:0,clientHeight:500,scrollHeight:500,contentWidthVisible:false},
  })});
  const result=await h.read();assert.match(result.issue,/未能唯一定位/);assert.ok(!h.actions.includes('expand'));
  assert.equal(result.completeness.allScreensRead,false);
});

test('expansion waits for a delayed redraw instead of rejecting two stable old samples',async()=>{
  let afterClick=0;
  const h=harness({texts:[foldedIntro],expandedTexts:[unfoldedResume],marks:[introMark],sampleResult:({expansions})=>
    expansions&&++afterClick<=4?{text:foldedIntro}:{}});
  const result=await h.read();assert.equal(result.issue,undefined);assert.equal(result.resume,unfoldedResume);
  assert.equal(h.actions.filter(action=>action==='expand').length,1);assert.ok(afterClick>4);
});

test('an ineffective expansion is bounded, retains diagnostics and cannot save a folded resume',async()=>{
  const diagnostics={baseline:true,entries:902,ignoredImages:3,reasonCounts:[],operations:{fillText:937}};
  const h=harness({texts:[foldedIntro],marks:[introMark],diagnostics});
  const result=await h.read();assert.equal(result.failureReason,'expand-unchanged');assert.match(result.issue,/未确认展开/);
  assert.deepEqual(result.diagnostics,diagnostics);assert.equal(result.resume,'');
  assert.equal(result.completeness.allScreensRead,false);assert.equal(h.actions.filter(action=>action==='expand').length,1);
  assert.ok(h.actions.filter(action=>action==='sample').length<30);
});

test('invalid geometry or a mismatched first-screen identity prevents expansion',async()=>{
  for(const options of [{name:'李**'}, {sampleResult:()=>({geometry:{scrollTop:0,clientHeight:NaN,scrollHeight:500}})}]){
    const h=harness({texts:[foldedIntro],marks:[introMark],...options});
    const result=await h.read();assert.ok(result.issue);assert.ok(!h.actions.includes('expand'));
    assert.equal(result.completeness.allScreensRead,false);
  }
});

test('stopping during expansion redraw wait prevents further reads or clicks',async()=>{
  const h=harness({texts:[foldedIntro],marks:[introMark],stopAtPause:4});
  await assert.rejects(h.read(),/任务已停止/);
  assert.equal(h.actions.filter(action=>action==='expand').length,1);assert.equal(h.actions.at(-1),'cleanup');
});

function frameHarness(options={}) {
  const root={isConnected:true,parentElement:null,clientHeight:600,clientWidth:800,scrollHeight:600,scrollTop:0};
  const owner={isConnected:true,parentElement:root,clientHeight:500,clientWidth:550,scrollHeight:1000,scrollTop:120,
    clientLeft:0,clientTop:0,offsetWidth:550,offsetHeight:500,getBoundingClientRect:()=>({left:0,top:0,width:550,height:500})};
  let canvas={isConnected:true,parentElement:owner,width:1100,height:2000,
    getBoundingClientRect:()=>({left:0,top:-owner.scrollTop,right:550,bottom:1000-owner.scrollTop,width:550,height:1000})};
  const crops=[],events=[];
  canvas.dispatchEvent=event=>{events.push(event);return true;};
  const document={body:{innerText:''},scrollingElement:root,querySelectorAll:()=>[canvas],elementFromPoint:()=>canvas};
  Object.defineProperty(document,'hasFocus',{get(){throw Error('Must not inspect OS focus');}});
  const window={__hrmCanvasText:{version:1,snapshot:({rect,allowVerticalBoundary})=>{
    assert.equal(allowVerticalBoundary,true);
    crops.push(rect);return {version:1,canvasId:'canvas-1',revision:1,text:'张**\n工作经历\n'+footer,marks:[],...options.snapshot};
  }}};window.top=window;
  const context=vm.createContext({window,document,innerWidth:800,innerHeight:600,
    MouseEvent:class {constructor(type,options){this.type=type;Object.assign(this,options);}},
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    DOMMatrixReadOnly:class {constructor(value){Object.assign(this,{is2D:true,a:1,b:0,c:0,d:1},value==='rotate'?{b:1,c:-1}:value==='skew'?{c:.2}:{});}},
    getComputedStyle:e=>e===canvas?{visibility:'visible',opacity:'1',transform:options.canvasTransform}:
      e===owner?{overflowY:'auto',overflowX:'hidden',transform:options.ancestorTransform,rotate:options.rotate}:{overflowY:'hidden'}});
  const run=vm.runInContext('('+backgroundResumeFrame.toString()+')',context);
  return {run:(action,args={})=>run(action,{token:'session-1',...args}),owner,crops,document,events,
    replaceCanvas:()=>{canvas={...canvas};}};
}

test('page adapter clips to viewport pixels and scrolls DOM without reading focus',()=>{
  const f=frameHarness();const first=f.run('prepare');
  assert.equal(first.geometry.scrollTop,120);
  assert.deepEqual({...f.crops.at(-1)},{x:0,y:240,width:1100,height:1000});
  f.run('top');assert.equal(f.owner.scrollTop,0);
  f.run('next');assert.equal(f.owner.scrollTop,275);
  f.run('cleanup');assert.throws(()=>f.run('sample'),/发生变化/);
});

test('page adapter restores only validated native positions and bounds the reduced scroll step',()=>{
  const f=frameHarness(),first=f.run('prepare');
  assert.deepEqual([...first.geometry.scrollPositions],[120]);
  f.run('next',{stepRatio:.275});assert.equal(f.owner.scrollTop,257.5);
  f.run('restore',{scrollPositions:[120]});assert.equal(f.owner.scrollTop,120);
  for(const scrollPositions of [[],[NaN],[-1],[501],[0,0]]){
    assert.throws(()=>f.run('restore',{scrollPositions}),/无法返回/);assert.equal(f.owner.scrollTop,120);
  }
  for(const stepRatio of [.09,.56,NaN,Infinity]){
    assert.throws(()=>f.run('next',{stepRatio}),/步长无效/);assert.equal(f.owner.scrollTop,120);
  }
});

test('page adapter clicks a freshly verified visible control at transformed canvas coordinates while width is clipped',()=>{
  const mark={id:1,label:'查看全部',x:.8,y:.3};
  const f=frameHarness({snapshot:{marks:[mark]}});f.owner.clientWidth=500;
  assert.equal(f.run('prepare').geometry.contentWidthVisible,false);
  f.run('expand',{mark});
  assert.deepEqual(f.events.map(event=>event.type),['mousemove','mousedown','mouseup','click']);
  for(const event of f.events){assert.equal(event.clientX,440);assert.equal(event.clientY,180);assert.equal(event.bubbles,true);}
});

test('page adapter refuses stale, unrelated, obscured or offscreen expand controls',()=>{
  const mark={id:1,label:'查看全部',x:.8,y:.3};
  for(const mode of ['moved','unrelated','obscured','offscreen']){
    const current=mode==='unrelated'?{...mark,label:'联系TA'}:mode==='offscreen'?{...mark,y:.8}:mark;
    const f=frameHarness({snapshot:{marks:[current]}});f.run('prepare');
    if(mode==='obscured')f.document.elementFromPoint=()=>({});
    const requested=mode==='moved'?{...mark,x:.7}:current;
    assert.throws(()=>f.run('expand',{mark:requested}),/未执行点击/);assert.equal(f.events.length,0);
  }
});

test('page adapter preserves invalid canvas read bounds without losing drawing diagnostics',()=>{
  const diagnostics={baseline:true,entries:902,ignoredImages:3,reasonCounts:[]};
  const f=frameHarness({snapshot:{issue:'画布读取范围无效',failureReason:'canvas-range',diagnostics}}),result=f.run('prepare');
  assert.equal(result.issue,'画布读取范围无效');assert.equal(result.failureReason,'canvas-range');
  assert.deepEqual(result.diagnostics,diagnostics);
});

test('page adapter pins canvas identity and stops for manual verification',()=>{
  const f=frameHarness();f.run('prepare');f.replaceCanvas();
  assert.throws(()=>f.run('sample'),/发生变化/);
  const g=frameHarness();g.run('prepare');g.document.body.innerText='请完成安全验证';
  assert.throws(()=>g.run('sample'),/人工登录或验证/);
});

test('page adapter rejects canvas and ancestor rotation/skew before reading text',()=>{
  for(const options of [{canvasTransform:'rotate'},{ancestorTransform:'rotate'},{ancestorTransform:'skew'},{rotate:'15deg'}]) {
    const f=frameHarness(options);
    assert.throws(()=>f.run('prepare'),/旋转|变化/);
    assert.equal(f.crops.length,0);
  }
});

test('page adapter reads and advances an iframe outer scroll owner without touching the background page',()=>{
  const root={parentElement:null,isConnected:true,scrollTop:0,clientHeight:1500,scrollHeight:1500};
  const background={parentElement:null,isConnected:true,scrollTop:400,clientHeight:800,scrollHeight:3000};
  const shell={parentElement:background};
  const outer={parentElement:shell,isConnected:true,scrollTop:0,clientHeight:500,scrollHeight:1500,
    clientWidth:550,clientTop:0,clientLeft:0,
    getBoundingClientRect:()=>({left:20,top:20,width:550,height:500})};
  const frame={parentElement:outer,isConnected:true,offsetWidth:550,offsetHeight:1500,clientLeft:0,clientTop:0,
    getBoundingClientRect:()=>({left:20,top:20-outer.scrollTop,width:550,height:1500})};
  const canvas={isConnected:true,parentElement:root,width:1100,height:3000,
    getBoundingClientRect:()=>({left:0,top:0,right:550,bottom:1500,width:550,height:1500})};
  const document={body:{innerText:''},scrollingElement:root,querySelectorAll:()=>[canvas],elementFromPoint:()=>canvas};
  const outerDocument={scrollingElement:background,elementFromPoint:()=>frame};frame.ownerDocument=outerDocument;
  const parent={document:outerDocument,innerWidth:800,innerHeight:800,
    getComputedStyle:e=>e===shell?{position:'fixed'}:e===frame?{overflowY:'visible'}:{overflowY:'auto'}};
  parent.top=parent;
  const crops=[];
  const window={parent,top:parent,frameElement:frame,__hrmCanvasText:{version:1,snapshot:({rect})=>{
    crops.push(rect);return {version:1,canvasId:'nested',revision:1,text:'张**\n工作经历',marks:[]};
  }}};
  const context=vm.createContext({window,document,innerWidth:550,innerHeight:1500,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:e=>e===canvas?{visibility:'visible',opacity:'1'}:{overflowY:'auto'}});
  const run=vm.runInContext('('+backgroundResumeFrame.toString()+')',context);
  const prepared=run('prepare',{token:'outer'});
  assert.equal(prepared.geometry.clientHeight,500);
  assert.equal(prepared.geometry.scrollHeight,1500);
  assert.equal(prepared.geometry.scrollTop,0);
  run('next',{token:'outer'});assert.equal(outer.scrollTop,275);assert.equal(background.scrollTop,400);
  run('sample',{token:'outer'});
  assert.deepEqual({...crops.at(-1)},{x:0,y:550,width:1100,height:1000});
  frame.isConnected=false;assert.throws(()=>run('sample',{token:'outer'}),/发生变化/);
});
