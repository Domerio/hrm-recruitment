import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DOMParser} from 'linkedom';
import * as helpers from '../extension/capture-utils.mjs';
import {readCurrentChatResume as publicReader} from '../extension/chat-resume.mjs';
import {createCopyViewportController,saveForegroundReadDiagnostic} from '../extension/copy-viewport.mjs';

const ownerUrl='https://www.zhipin.com/web/chat/index?from=fixture';
const bodyUrl='https://www.zhipin.com/web/frame/c-resume/?candidate=fixture';
const ownerKey=new URL(ownerUrl).origin+new URL(ownerUrl).pathname;
const bodyKey=new URL(bodyUrl).origin+new URL(bodyUrl).pathname;
const name='沙一鸣';
const header=person=>`${person}\n30岁\n本科\n5年\n离职-随时到岗`;
const resume=person=>`${header(person)}\n工作经历\n合成科技公司，视觉工程师。负责工业视觉软件、相机标定、图像处理和现场项目交付。\n教育经历\n合成大学，计算机科学与技术，本科。`;
const normalize=text=>text.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'');
const source=fs.readFileSync(new URL('../extension/chat-resume.mjs',import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/gm,'').replace('export async function readCurrentChatResume','async function readCurrentChatResume')+
  '\nglobalThis.reader=readCurrentChatResume;';

function fixture({kind='text',expectedName=name,detailName=name,body=resume(name),
  rowsOverride,scanPromotion=false,domExpandOwner=0,domExpandBody=0,domExpandError='',domExpandClick,
  imagePreview='',imagePreviewAt='initial',imagePreviewError='',imagePreviewReply,imagePreviewRowsOverride,
  focusRecovery=false,reopenPreviewAtFocus=false,imageProbeReply,imageProbeRowsOverride,hangReadAction='',
  proof={topVerified:true,bottomVerified:true,allScreensRead:true,stableBottomReads:1},screens=1,
  preparedOverride={},copyIssue='',foldIssue='',copyOverride={},copyError='',format,hook=()=>{},htmlOnly=false,
  fitViewportRequest=false,viewportChanged=false}={}){
  const events=[],pendingReads=[],state={generation:0,conversation:1,stopped:false,body,guardCalls:0,fullCopies:0,headerCopies:0,formats:0,
    expansionProbes:[],expansionClicks:[],copyExpansionFlags:[],copySkipExpansion:[],previewCalls:[],previewProbes:[],focusRecoveries:[],waits:[],recoveryDetailReads:[],
    previewVisible:imagePreviewAt==='initial'?imagePreview:'',windowUpdates:[],storageWrites:[],fitResults:[]};
  let bossWindow={id:2,state:'normal',left:60,top:40,width:900,height:740};
  const row=(frameId,documentId,value)=>({frameId,documentId,result:{ok:true,value}});
  const detailRows=()=>{
    const binding={ownerUrl:state.ownerUrl||ownerUrl,bodyUrl:state.bodyUrl||bodyUrl};
    return kind==='none'?[row(0,'owner',{kind:'none',frameKey:ownerKey})]:kind==='text'?
      [row(8,'body',{kind:'text',name:detailName,token:'text-'+state.generation,frameKey:bodyKey,binding,contentKey:normalize(state.body)})]:
      [row(0,'owner',{kind:'canvas-owner',token:'owner-'+state.generation,frameKey:ownerKey,binding}),
        row(8,'body',{kind:'canvas-body',token:'body-'+state.generation,frameKey:bodyKey,binding})];
  };
  const event=value=>{events.push(value);hook(value,state);};
  const check=()=>{if(state.stopped)throw Error('已停止。');};
  const browser={tabs:{get:async id=>({id,url:state.tabUrl||ownerUrl,active:state.active!==false,discarded:!!state.discarded,windowId:2})},
    storage:{local:{set:async value=>{state.storageWrites.push(value);}}},
    windows:{get:async()=>({...bossWindow}),update:async(id,args)=>{
      assert.equal(id,2);state.windowUpdates.push({...args});
      bossWindow=args.state==='maximized'?{id:2,state:'maximized',left:0,top:0,width:1920,height:1040}:{...bossWindow,...args};
      return {...bossWindow};}},
    scripting:{executeScript:async request=>{
      if(request.files){assert.deepEqual(Array.from(request.files),['dom-reader.js','automation.js']);event('inject');return [];}
      const [action,args]=request.args;event(action);
      if(action===hangReadAction)return new Promise(resolve=>pendingReads.push(()=>resolve([])));
      if(action==='scan')return [row(0,'owner',{frameKey:ownerKey,promotionBlocked:scanPromotion,cards:[{name:'背景**'}]})];
      if(action==='current-detail')return rowsOverride?rowsOverride(detailRows()):detailRows();
      if(action==='reset')return [];
      if(action==='probe-image-preview'){
        const [documentId]=request.target.documentIds,original=detailRows().find(row=>row.documentId===documentId);
        assert.ok(original);state.previewProbes.push(documentId);
        const reply=typeof imageProbeReply==='function'?imageProbeReply({documentId,visible:state.previewVisible,count:state.previewProbes.length}):imageProbeReply;
        const rows=[row(original.frameId,documentId,reply??{present:state.previewVisible===documentId})];
        return imageProbeRowsOverride?imageProbeRowsOverride(rows):rows;
      }
      if(action==='dismiss-image-preview'){
        const [documentId]=request.target.documentIds;
        const original=detailRows().find(row=>row.documentId===documentId);
        assert.ok(original);assert.equal(args.token,original.result.value.token);
        assert.equal(args.kind,original.result.value.kind);
        state.previewCalls.push(documentId);
        if(state.previewVisible!==documentId)return [row(original.frameId,documentId,{dismissed:false})];
        if(imagePreviewError)throw Error(imagePreviewError);
        const result=imagePreviewReply??{dismissed:true};
        if(result.dismissed===true){state.previewVisible='';event('preview-dismissed:'+documentId);}
        const rows=[row(original.frameId,documentId,result)];
        return imagePreviewRowsOverride?imagePreviewRowsOverride(rows):rows;
      }
      if(['prepare-canvas-expand','click-canvas-expand'].includes(action)){
        assert.equal(kind,'canvas');
        const [documentId]=request.target.documentIds;
        assert.ok(['owner','body'].includes(documentId));
        const frameId=documentId==='owner'?0:8;
        if(action==='prepare-canvas-expand'){
          state.expansionProbes.push(documentId);event('expand-prepare:'+documentId);
          const value=documentId==='owner'?domExpandOwner:domExpandBody;
          return [row(frameId,documentId,typeof value==='object'?value:
            {count:value,token:value===1?'expand-'+documentId:'',label:value===1?'查看全部':''})];
        }
        assert.equal(args.token,'expand-'+documentId);
        state.expansionClicks.push(documentId);event('expand-click:'+documentId);
        if(imagePreviewAt==='expand')state.previewVisible=imagePreview;
        return domExpandError?[{frameId,documentId,result:{ok:false,error:domExpandError}}]:
          [row(frameId,documentId,domExpandClick||{clicked:true,label:'查看全部'})];
      }
      assert.ok(['prepare-copy','select-copy','copy-focused','clear-copy'].includes(action));
      assert.deepEqual(Array.from(request.target.documentIds),['body']);
      if(action==='prepare-copy'){
        if(imagePreviewAt==='expand')state.previewVisible=imagePreview;
        const content=normalize(state.body);
        return [row(8,'body',{status:'visible_complete',sections:helpers.resumeSections(state.body),
          minimumLength:content.length,contentHead:content.slice(0,40),contentTail:content.slice(-40),...preparedOverride})];
      }
      return [row(8,'body',true)];
    }}};
  const copyOpenResume=async options=>{
    options.check();assert.equal(options.documentId,'body');
    assert.equal(options.singlePass,true);
    assert.equal(typeof options.recoverFocus,'function');
    assert.equal(typeof options.fitViewport,'function');
    if(fitViewportRequest){state.fitResults.push(await options.fitViewport({reason:'width_clipped'}));
      if(viewportChanged)bossWindow.width=1700;}
    assert.equal(typeof options.expandAlreadyDone,'boolean');state.copyExpansionFlags.push(options.expandAlreadyDone);
    assert.equal(typeof options.skipExpansion,'boolean');state.copySkipExpansion.push(options.skipExpansion);
    assert.notEqual(options.headerOnly,true);
    await options.pause(0);
    if(options.clipboardSequence)await options.clipboardSequence();
    if(focusRecovery){
      if(imagePreviewAt==='focus'||reopenPreviewAtFocus)state.previewVisible=imagePreview;
      const before=events.filter(event=>event==='current-detail').length;
      const recovered=await options.recoverFocus();state.focusRecoveries.push(recovered);
      if(recovered?.skipExpansion===true){options.skipExpansion=true;state.copySkipExpansion[state.copySkipExpansion.length-1]=true;}
      state.recoveryDetailReads.push(events.filter(event=>event==='current-detail').length-before);
      if(state.previewVisible)throw Error('图片预览仍遮挡当前简历，已停止读取。');
    }
    assert.equal(options.name,kind==='canvas'?expectedName.trim():detailName);
    if(kind==='text'){
      assert.ok(options.textSelection);
      assert.equal(await options.textSelection.select(),true);
      assert.equal(await options.textSelection.focused(),true);
      await options.textSelection.clear();
    }else assert.equal(options.textSelection,undefined);
    state.fullCopies++;event('full-'+state.fullCopies);
    if(copyError)throw Object.assign(Error(copyError),copyOverride.diagnostics?{diagnostics:copyOverride.diagnostics}:{});
    const text=body;
    const markup='<html><body>'+text.split('\n').map(line=>'<p>'+line+'</p>').join('')+'</body></html>';
    return {resume:htmlOnly?'':text,resume_html:markup,issue:copyIssue,foldIssue,screens,
      selection:'single-copy',copyCount:1,...(kind==='canvas'?{completeness:proof}:{}),...copyOverride};
  };
  const context={...helpers,copyOpenResume,createCopyViewportController,saveForegroundReadDiagnostic,DOMParser,URL,
    setTimeout:(fn,ms)=>setTimeout(fn,fn.name==='browserReadTimedOut'&&hangReadAction?5:ms),clearTimeout,globalThis:null};
  context.globalThis=context;vm.runInNewContext(source,context);
  const read=()=>context.reader({browser,clipboard:{},clipboardSequence:async()=>{event('clipboard-sequence');return 1;},
    tab:{id:7,url:ownerUrl},expectedName,assertConversation:async()=>{
      state.guardCalls++;if(state.conversation!==1)throw Error('当前聊天会话已切换。');
    },check,report:message=>events.push('report:'+message),pause:async ms=>{state.waits.push(ms);event('pause:'+ms);},
    formatResume:async value=>{state.formats++;event('format-'+state.formats);return format?format(value):value;}});
  return {read,events,state,browser,resolveReads:()=>pendingReads.splice(0).forEach(resolve=>resolve())};
}

test('chat resume reader exports a callable function without browser globals at import time',()=>{
  assert.equal(typeof publicReader,'function');
});

test('reads the uniquely opened DOM resume with pinned selection and complete source evidence',async()=>{
  const f=fixture(),result=await f.read();
  assert.equal(result.candidate.name,name);assert.equal(result.candidate.resume,resume(name));
  assert.equal(result.candidate.link,'');assert.equal(result.candidate.capture.status,'visible_complete');
  assert.deepEqual(Array.from(result.candidate.capture.sections),['工作经历','教育经历']);
  assert.equal(result.binding.kind,'text');assert.equal(result.binding.body.documentId,'body');
  assert.equal(result.binding.body.url,bodyKey);
  assert.equal(result.binding.body.binding.bodyUrl,bodyUrl);
  assert.equal(result.binding.body.binding.ownerUrl,ownerUrl);
  assert.equal(f.state.fullCopies,1);assert.equal(f.state.headerCopies,0);
  assert.ok(f.events.includes('select-copy'));assert.ok(f.events.includes('clear-copy'));
  assert.ok(f.state.guardCalls>20);
  assert.ok(!f.events.some(value=>/^(?:open|close|favorite|share|send|read|advance-list)$/.test(value)));
});

test('Canvas copies one complete snapshot and falls back to Canvas expansion only when neither DOM scope has controls',async()=>{
  const f=fixture({kind:'canvas'}),result=await f.read();
  assert.equal(result.candidate.resume,resume(name));assert.equal(result.binding.kind,'canvas');
  assert.equal(f.state.headerCopies,0);assert.equal(f.state.fullCopies,1);assert.equal(f.state.formats,1);
  assert.deepEqual(f.events.filter(value=>/^(?:header|full)-/.test(value)),['full-1']);
  assert.equal(f.events.filter(value=>value==='expand-canvas').length,0);
  assert.deepEqual(f.state.expansionProbes,['owner','body']);
  assert.deepEqual(f.state.expansionClicks,[]);assert.deepEqual(f.state.copyExpansionFlags,[false]);
  assert.ok(f.events.some(value=>value.includes('本次在线简历快照已确认，只复制一次')));
  assert.ok(!f.events.some(value=>/draw|background|card|register/.test(value)));
});

test('chat viewport recovery restores after success or failure without another copy',async()=>{
  for(const copyIssue of ['', '完整范围仍被裁切']){
    const f=fixture({kind:'canvas',fitViewportRequest:true,copyIssue,
      copyOverride:{diagnostics:{reason:'width_clipped',clipLeft:5,name:'private',resume:'private'}}});
    if(copyIssue)await assert.rejects(f.read(),/裁切/);else await f.read();
    assert.deepEqual(f.state.fitResults,[true]);assert.equal(f.state.fullCopies,1);
    assert.deepEqual(f.state.windowUpdates,[{state:'maximized'},{state:'normal',left:60,top:40,width:900,height:740}]);
    if(copyIssue){
      assert.equal(f.state.storageWrites.length,1);
      const diagnostic=f.state.storageWrites[0].lastForegroundReadDiagnostic;
      assert.equal(diagnostic.reason,'width_clipped');assert.ok(!JSON.stringify(diagnostic).includes('private'));
      assert.equal(f.state.formats,0);
    }
  }
});

test('chat viewport cleanup respects a manual resize after recovery',async()=>{
  const f=fixture({kind:'canvas',fitViewportRequest:true,viewportChanged:true});await f.read();
  assert.deepEqual(f.state.windowUpdates,[{state:'maximized'}]);assert.equal(f.state.fullCopies,1);
});

test('chat saves a thrown geometry diagnostic locally and restores the original viewport',async()=>{
  const f=fixture({kind:'canvas',fitViewportRequest:true,copyError:'简历视口不可用',
    copyOverride:{diagnostics:{reason:'scroll_metrics_invalid',scrollHeight:900,resume:'private'}}});
  await assert.rejects(f.read(),/视口不可用/);
  assert.equal(f.state.storageWrites.length,1);
  assert.equal(f.state.storageWrites[0].lastForegroundReadDiagnostic.reason,'scroll_metrics_invalid');
  assert.ok(!JSON.stringify(f.state.storageWrites).includes('private'));
  assert.equal(f.state.formats,0);assert.equal(f.state.windowUpdates.length,2);
});

test('Canvas DOM expansion checks both frames and clicks only their single bound control before one copy',async()=>{
  for(const [options,probes,clicked] of [
    [{domExpandOwner:1},['owner','body'],'owner'],
    [{domExpandOwner:0,domExpandBody:1},['owner','body'],'body'],
  ]){
    const f=fixture({kind:'canvas',...options});await f.read();
    assert.deepEqual(f.state.expansionProbes,probes);assert.deepEqual(f.state.expansionClicks,[clicked]);
    assert.deepEqual(f.state.copyExpansionFlags,[true]);
    assert.equal(f.state.fullCopies,1);assert.equal(f.state.headerCopies,0);
    assert.ok(f.events.indexOf('expand-click:'+clicked)<f.events.indexOf('full-1'));
    assert.equal(f.events.includes('expand-canvas'),false);
  }
});

test('Canvas ambiguous DOM controls skip all expansion and allow one complete snapshot',async()=>{
  for(const options of [{domExpandOwner:2,domExpandBody:1},{domExpandBody:2},{domExpandOwner:1,domExpandBody:1}]){
    const f=fixture({kind:'canvas',...options});const result=await f.read();
    assert.equal(result.candidate.resume,resume(name));assert.equal(f.state.fullCopies,1);
    assert.deepEqual(f.state.expansionClicks,[]);assert.deepEqual(f.state.copyExpansionFlags,[false]);
    assert.deepEqual(f.state.copySkipExpansion,[true]);
  }
});

test('Canvas ambiguity never bypasses copied fold and completeness checks',async()=>{
  for(const options of [{body:resume(name)+'\n查看全部'},
    {proof:{topVerified:true,bottomVerified:false,allScreensRead:false,stableBottomReads:1}}]){
    const f=fixture({kind:'canvas',domExpandOwner:1,domExpandBody:1,...options});
    await assert.rejects(f.read(),/未展开|完整性/);
    assert.equal(f.state.fullCopies,1);assert.equal(f.state.formats,0);assert.deepEqual(f.state.expansionClicks,[]);
  }
});

test('Canvas invalid or expired DOM expansion never falls back to another click or copy',async()=>{
  for(const options of [
    {domExpandOwner:{count:1,token:'',label:'查看全部'}},
    {domExpandOwner:{count:0,token:'stale'}},
    {domExpandOwner:{count:'1',token:'invalid',label:'查看全部'}},
    {domExpandOwner:1,domExpandError:'展开凭据已失效'},
    {domExpandOwner:1,domExpandClick:{clicked:false,label:'查看全部'}},
    {domExpandOwner:1,domExpandClick:{clicked:true,label:'其它标签'}},
  ]){
    const f=fixture({kind:'canvas',...options});await assert.rejects(f.read(),/展开/);
    assert.equal(f.state.fullCopies,0);assert.equal(f.state.formats,0);
    assert.ok(f.state.expansionClicks.length<=1);
    assert.ok(f.state.expansionProbes.length<=2);
  }
});

test('chat copies once after an explicit same-scope zero-click control change',async()=>{
  for(const documentId of ['owner','body']){
    const f=fixture({kind:'canvas',...(documentId==='owner'?{domExpandOwner:1}:{domExpandBody:1}),
      domExpandClick:{clicked:false,reason:'controls_changed'}});
    const result=await f.read();assert.equal(result.candidate.resume,resume(name));
    assert.deepEqual(f.state.expansionClicks,[documentId]);
    assert.equal(f.state.fullCopies,1);assert.deepEqual(f.state.copyExpansionFlags,[false]);
    assert.deepEqual(f.state.copySkipExpansion,[true]);assert.equal(f.state.waits.includes(650),false);
  }
});

test('Canvas DOM expansion rechecks both conversation and resume binding around the click',async()=>{
  for(const phase of ['expand-prepare:owner','expand-click:owner']){
    for(const field of ['conversation','generation','stopped']){
      const f=fixture({kind:'canvas',domExpandOwner:1,hook:(event,state)=>{
        if(event===phase)state[field]=field==='stopped'?true:state[field]+1;
      }});
      await assert.rejects(f.read(),/切换|停止/);
      assert.equal(f.state.fullCopies,0);assert.equal(f.state.formats,0);
      assert.ok(f.state.expansionClicks.length<=1);
    }
  }
});

test('chat image-preview recovery closes one bound owner or body preview before one complete copy',async()=>{
  for(const [kind,imagePreview,imagePreviewAt] of [
    ['text','body','initial'],['text','body','expand'],
    ['canvas','owner','initial'],['canvas','body','initial'],
    ['canvas','owner','expand'],['canvas','body','focus'],
  ]){
    const f=fixture({kind,imagePreview,imagePreviewAt,domExpandOwner:kind==='canvas'?1:0,
      focusRecovery:imagePreviewAt==='focus'});
    assert.equal((await f.read()).candidate.name,name);
    assert.equal(f.events.filter(event=>event.startsWith('preview-dismissed:')).length,1);
    assert.equal(f.state.fullCopies,1);assert.equal(f.state.headerCopies,0);assert.equal(f.state.formats,1);
    assert.equal(f.state.waits.filter(ms=>ms===150).length,2);
    assert.equal(f.state.expansionClicks.length,kind==='canvas'?1:0);
    assert.ok(!f.events.some(event=>/^(?:open|close|favorite|share|send)$/.test(event)));
    if(imagePreviewAt==='focus')assert.deepEqual(f.state.focusRecoveries,[true]);
  }
});

test('chat preview recovery never closes twice or recopies when a second preview obscures the same resume',async()=>{
  const f=fixture({kind:'canvas',imagePreview:'owner',domExpandOwner:1,
    focusRecovery:true,reopenPreviewAtFocus:true});
  await assert.rejects(f.read(),/图片预览仍遮挡/);
  assert.equal(f.events.filter(event=>event==='preview-dismissed:owner').length,1);
  assert.deepEqual(f.state.focusRecoveries,[false]);
  assert.equal(f.state.expansionClicks.length,1);assert.equal(f.state.fullCopies,0);assert.equal(f.state.formats,0);
});

test('chat preview dismissal failure or an untrusted response cannot reach the clipboard',async()=>{
  for(const options of [
    {imagePreviewError:'图片预览不唯一，未关闭'},
    {imagePreviewReply:{dismissed:'true'}},
    {imagePreviewRowsOverride:rows=>[...rows,rows[0]]},
    {imagePreviewRowsOverride:rows=>rows.map(row=>({...row,documentId:'new-body'}))},
  ]){
    const f=fixture({kind:'canvas',imagePreview:'body',...options});
    await assert.rejects(f.read(),/预览|框架/);
    assert.ok(f.events.filter(event=>event.startsWith('preview-dismissed:')).length<=1);
    assert.equal(f.state.fullCopies,0);assert.equal(f.state.formats,0);assert.equal(f.state.expansionClicks.length,0);
  }
});

test('chat image-preview recovery rechecks candidate, conversation and page throughout the settling wait',async()=>{
  for(const phase of ['preview-dismissed:owner','pause:150'])for(const field of ['generation','conversation','stopped','tabUrl']){
    const f=fixture({kind:'canvas',imagePreview:'owner',hook:(event,state)=>{
      if(event===phase)state[field]=field==='stopped'?true:field==='tabUrl'?ownerUrl+'&new=1':state[field]+1;
    }});
    await assert.rejects(f.read(),/切换|停止/);
    assert.equal(f.events.filter(event=>event==='preview-dismissed:owner').length,1);
    assert.equal(f.state.fullCopies,0);assert.equal(f.state.formats,0);
  }
});

test('chat binding verification accepts IPC key reordering without weakening URL or token checks',async()=>{
  for(const kind of ['text','canvas']){
    let reads=0;
    const f=fixture({kind,imagePreview:kind==='canvas'?'owner':'body',rowsOverride:rows=>{
      reads++;
      return rows.map(row=>{
        const binding=row.result.value.binding;
        if(!binding||reads%2)return row;
        return {...row,result:{ok:true,value:{...row.result.value,
          binding:{bodyUrl:binding.bodyUrl,ownerUrl:binding.ownerUrl}}}};
      });
    }});
    assert.equal((await f.read()).candidate.name,name);
    assert.equal(f.state.fullCopies,1);assert.equal(f.state.formats,1);
    assert.equal(f.events.filter(event=>event.startsWith('preview-dismissed:')).length,1);
  }
  const changed=fixture({kind:'canvas',imagePreview:'owner',hook:(event,state)=>{
    if(event==='preview-dismissed:owner')state.bodyUrl=bodyUrl+'&changed=1';
  }});
  await assert.rejects(changed.read(),/简历已切换/);
  assert.equal(changed.state.fullCopies,0);
});

test('chat no-preview recovery adds no full identity reads and never calls dismissal',async()=>{
  for(const kind of ['text','canvas']){
    const f=fixture({kind,focusRecovery:true});await f.read();
    assert.equal(f.state.fullCopies,1);assert.equal(f.state.formats,1);
    assert.deepEqual(f.state.focusRecoveries,[false]);assert.deepEqual(f.state.recoveryDetailReads,[0]);
    assert.equal(f.state.previewCalls.length,0);assert.ok(f.state.previewProbes.length>0);
  }
});

test('chat Canvas skips duplicate preflight when preparation only reads the page',async()=>{
  for(const expanded of [false,true]){
    const f=fixture({kind:'canvas',domExpandOwner:expanded?1:0});await f.read();
    assert.equal(f.state.previewProbes.length,expanded?4:2);assert.equal(f.state.fullCopies,1);
  }
});

test('chat Canvas tolerates only explicit unknown probe outcomes and skips every expansion',async()=>{
  for(const reason of ['budget','scope']){
    const f=fixture({kind:'canvas',domExpandOwner:1,imageProbeReply:{present:false,uncertain:true,reason}});
    await f.read();assert.equal(f.state.fullCopies,1);assert.equal(f.state.formats,1);
    assert.deepEqual(f.state.copySkipExpansion,[true]);assert.equal(f.state.previewCalls.length,0);
    assert.equal(f.state.expansionProbes.length,0);assert.equal(f.state.expansionClicks.length,0);
    assert.equal(f.state.previewProbes.length,2);
  }
});

test('chat DOM uncertainty stops before preparation, expansion and programmatic selection',async()=>{
  for(const reason of ['budget','scope']){
    const f=fixture({imageProbeReply:{present:false,uncertain:true,reason}});
    await assert.rejects(f.read(),/检查未完成，尚未复制正文/);
    assert.equal(f.state.fullCopies,0);assert.equal(f.state.formats,0);
    assert.ok(!f.events.includes('prepare-copy'));assert.equal(f.state.previewCalls.length,0);
  }
});

test('chat Canvas scope uncertainty cannot hide a switched candidate binding',async()=>{
  const f=fixture({kind:'canvas',imageProbeReply:{present:false,uncertain:true,reason:'scope'},
    hook:(event,state)=>{if(event==='probe-image-preview')state.generation++;}});
  await assert.rejects(f.read(),/简历已切换/);assert.equal(f.state.fullCopies,0);assert.equal(f.state.previewCalls.length,0);
});

test('chat closes only a positively identified body preview when the owner probe is unknown',async()=>{
  const f=fixture({kind:'canvas',imagePreview:'body',
    imageProbeReply:({documentId,visible})=>documentId==='owner'?{present:false,uncertain:true,reason:'budget'}:{present:documentId===visible}});
  await f.read();assert.deepEqual(f.state.previewCalls,['body']);assert.equal(f.state.fullCopies,1);
  assert.deepEqual(f.state.copySkipExpansion,[true]);assert.equal(f.state.expansionClicks.length,0);
});

test('chat inconclusive dismissal leaves a blocked surface uncopied',async()=>{
  const f=fixture({kind:'canvas',imagePreview:'owner',focusRecovery:true,
    imagePreviewReply:{dismissed:false,uncertain:true,reason:'budget'}});
  await assert.rejects(f.read(),/图片预览仍遮挡/);assert.equal(f.state.fullCopies,0);assert.equal(f.state.formats,0);
  assert.equal(f.state.expansionClicks.length,0);assert.ok(!f.events.some(event=>event.startsWith('preview-dismissed:')));
});

test('chat propagates late Canvas probe uncertainty into the in-flight copy expansion budget',async()=>{
  const f=fixture({kind:'canvas',focusRecovery:true,
    imageProbeReply:({count})=>count>2?{present:false,uncertain:true,reason:'budget'}:{present:false}});
  await f.read();assert.equal(f.state.fullCopies,1);assert.deepEqual(f.state.copySkipExpansion,[true]);
  assert.equal(f.state.focusRecoveries[0].skipExpansion,true);assert.equal(f.state.previewCalls.length,0);
});

test('chat late DOM probe uncertainty stops selection even after clear preflight checks',async()=>{
  const f=fixture({focusRecovery:true,
    imageProbeReply:({count})=>count>2?{present:false,uncertain:true,reason:'budget'}:{present:false}});
  await assert.rejects(f.read(),/检查未完成，尚未复制正文/);
  assert.equal(f.state.fullCopies,0);assert.equal(f.state.formats,0);assert.ok(!f.events.includes('select-copy'));
});

test('chat invalid preview probes cannot authorize closing or copying',async()=>{
  for(const options of [{imageProbeReply:{present:1}},
    ...[{present:true,uncertain:true,reason:'budget'},{present:false,uncertain:true,reason:'other'},
      {present:false,uncertain:1,reason:'budget'},{present:false,reason:'budget'}].map(imageProbeReply=>({imageProbeReply})),
    {imageProbeRowsOverride:rows=>[...rows,rows[0]]},
    {imageProbeRowsOverride:rows=>rows.map(row=>({...row,documentId:'new-body'}))}]){
    const f=fixture({kind:'canvas',...options});await assert.rejects(f.read(),/预览检查结果|框架/);
    assert.equal(f.state.previewCalls.length,0);assert.equal(f.state.fullCopies,0);assert.equal(f.state.formats,0);
  }
});

test('chat read timeouts reject once and late browser replies cannot resume copying',async()=>{
  for(const hangReadAction of ['scan','current-detail','probe-image-preview']){
    const f=fixture({kind:'canvas',hangReadAction});await assert.rejects(f.read(),/等待超时/);
    assert.equal(f.state.fullCopies,0);assert.equal(f.state.formats,0);assert.equal(f.state.previewCalls.length,0);
    const before=[...f.events];f.resolveReads();await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(f.events,before);assert.equal(f.state.fullCopies,0);
  }
});

test('exact normalized names allow formatting differences and never infer a full or masked identity',async()=>{
  const good=fixture({detailName:'张**',body:resume('张**'),expectedName:' 张＊＊ '}),result=await good.read();
  assert.equal(result.candidate.name,'张**');
  for(const options of [{expectedName:'沙**'},{expectedName:'另一位'},
    {detailName:'沙**',body:resume('沙**'),expectedName:name}]){
    const f=fixture(options);await assert.rejects(f.read(),/姓名与当前聊天候选人不一致/);
    assert.equal(f.state.fullCopies,0);
  }
  const canvas=fixture({kind:'canvas',expectedName:'沙**'});
  await assert.rejects(canvas.read(),/姓名与当前聊天候选人不一致/);assert.equal(canvas.state.fullCopies,1);
  assert.equal(canvas.state.formats,0);
  const masked=fixture({kind:'canvas',body:resume('张**'),expectedName:' 张＊＊ '});
  assert.equal((await masked.read()).candidate.name,'张**');
});

test('background lists, multiple details, unpinned documents and unmatched frame URLs never reach copying',async()=>{
  const cases=[{kind:'none'},{scanPromotion:true},
    {rowsOverride:rows=>[...rows,...rows]},
    {rowsOverride:rows=>rows.map(row=>({...row,documentId:''}))},
    {rowsOverride:rows=>rows.map(row=>({...row,result:{ok:true,value:{...row.result.value,token:''}}}))},
    {kind:'canvas',rowsOverride:rows=>rows.slice(0,1)},
    {kind:'canvas',rowsOverride:rows=>rows.map((row,index)=>index?{...row,result:{ok:true,value:{...row.result.value,
      binding:{ownerUrl:ownerUrl+'?other=1',bodyUrl}}}}:row)},
    {kind:'canvas',rowsOverride:rows=>rows.map((row,index)=>index?{...row,result:{ok:true,value:{...row.result.value,frameKey:bodyUrl+'other'}}}:row)},
    {rowsOverride:rows=>rows.map(row=>({...row,result:{ok:true,value:{...row.result.value,frameKey:'https://example.com/'}}}))}];
  for(const options of cases){
    const f=fixture(options);await assert.rejects(f.read());assert.equal(f.state.fullCopies,0);assert.equal(f.state.headerCopies,0);
  }
});

test('each key transition rechecks conversation identity before allowing a result',async()=>{
  for(const phase of ['inject','scan','current-detail','prepare-copy','select-copy','copy-focused','clear-copy','full-1','format-1']){
    const f=fixture({hook:(event,state)=>{if(event===phase)state.conversation=2;}});
    await assert.rejects(f.read(),/当前聊天会话已切换/);
  }
  for(const phase of ['inject','scan','current-detail','full-1','format-1']){
    const f=fixture({kind:'canvas',hook:(event,state)=>{if(event===phase)state.conversation=2;}});
    await assert.rejects(f.read(),/当前聊天会话已切换/);
  }
});

test('replacing a same-name resume frame or changing DOM content cancels the bound read',async()=>{
  for(const kind of ['text','canvas'])for(const phase of ['full-1','format-1']){
    const f=fixture({kind,hook:(event,state)=>{if(event===phase)state.generation++;}});
    await assert.rejects(f.read(),/简历已切换/);
  }
  const content=fixture({hook:(event,state)=>{if(event==='format-1')state.body+=' 后来新增的项目内容。';}});
  await assert.rejects(content.read(),/正文已变化/);
});

test('Canvas confirms the unique demographic identity from the only full snapshot',async()=>{
  for(const body of [name+'\n本科\n工作经历',resume('另一位'),header(name)+'\n'+resume('李女士'),
    header(name)+'\n'+resume(name)]){
    const f=fixture({kind:'canvas',body});await assert.rejects(f.read());assert.equal(f.state.fullCopies,1);
    assert.equal(f.state.formats,0);
  }
});

test('Canvas returns the copied snapshot without claiming later invisible canvas content was reread',async()=>{
  const f=fixture({kind:'canvas',hook:(event,state)=>{
    if(event==='format-1')state.body+='\n新增项目经历\n复制之后才显示的内容。';
  }});
  const result=await f.read();
  assert.equal(result.candidate.resume,resume(name));assert.equal(f.state.fullCopies,1);
  assert.equal(f.state.formats,1);
});

test('full owner and body query bindings remain pinned when adapter frame keys omit the query',async()=>{
  for(const kind of ['text','canvas'])for(const field of ['ownerUrl','bodyUrl']){
    const f=fixture({kind,hook:(event,state)=>{
      if(event==='full-1')state[field]=(field==='ownerUrl'?ownerUrl:bodyUrl)+'&switched=1';
    }});
    await assert.rejects(f.read(),/简历已切换/);
    assert.equal(f.state.generation,0);
  }
});

test('incomplete Canvas proofs, unresolved folds and copy failures cannot return a candidate',async()=>{
  for(const [field,value] of [['topVerified',false],['bottomVerified',false],['allScreensRead',false],
    ['stableBottomReads',0],['stableBottomReads',2],['stableBottomReads',undefined],['topVerified','yes']]){
    const proof={topVerified:true,bottomVerified:true,allScreensRead:true,stableBottomReads:1,[field]:value};
    const f=fixture({kind:'canvas',proof});await assert.rejects(f.read(),/全文完整性/);
    assert.equal(f.state.fullCopies,1);
  }
  for(const options of [{screens:0},{screens:1.5},{copyIssue:'未复制到第二屏'},
    {foldIssue:'展开未确认'},{body:resume(name)+'\n查看全部'}]){
    const f=fixture({kind:'canvas',...options});await assert.rejects(f.read());assert.equal(f.state.fullCopies,1);
  }
});

test('both DOM and Canvas require the single-copy contract and never retry failures automatically',async()=>{
  for(const kind of ['text','canvas']){
    for(const copyOverride of [{selection:'held-scroll'},{selection:undefined},{copyCount:0},{copyCount:2},{copyCount:undefined}]){
      const f=fixture({kind,copyOverride});await assert.rejects(f.read(),/只复制一次/);
      assert.equal(f.state.fullCopies,1);assert.equal(f.state.formats,0);
    }
    for(const options of [{copyError:'剪贴板没有收到本次正文'},{copyIssue:'本次复制不完整'},{foldIssue:'展开未确认'},
      {format:()=>{throw Error('格式化失败');}}]){
      const f=fixture({kind,...options});await assert.rejects(f.read());
      assert.equal(f.state.fullCopies,1);assert.equal(f.state.headerCopies,0);
    }
  }
});

test('DOM copies must cover the prepared header, tail, length and resume sections',async()=>{
  for(const preparedOverride of [{status:'needs_review'},{minimumLength:9999},{minimumLength:0},
    {contentHead:'未复制到的页首'},{contentTail:'未复制到的最后一段'},{sections:[]},
    {sections:['工作经历','项目经历']}]){
    const f=fixture({preparedOverride});await assert.rejects(f.read(),/完整性|履历章节/);
  }
  const headerOnly=fixture({body:header(name)});
  await assert.rejects(headerOnly.read(),/完整性|履历章节/);
});

test('formatter may preserve wording while changing whitespace, but cannot truncate or invent content',async()=>{
  const good=fixture({format:value=>({...value,resume:value.resume.replaceAll('\n','\n\n')})});
  assert.ok((await good.read()).candidate.resume.includes('\n\n'));
  for(const format of [value=>({...value,resume:header(name)+'\n工作经历\n简短摘要。'}),
    value=>({...value,resume:value.resume+'\n新增的推测履历'}),()=>({resume:'',resume_html:''}),
    value=>({...value,resume_html:{}})]){
    const f=fixture({format});await assert.rejects(f.read());
  }
});

test('HTML-only clipboard content can be checked without treating a formatted summary as original',async()=>{
  const f=fixture({htmlOnly:true});
  const result=await f.read();assert.equal(result.candidate.resume,resume(name));
});

test('oversized source content and invalid tabs stop without truncating a resume',async()=>{
  const oversized=fixture({body:resume(name)+'字'.repeat(100001)});
  await assert.rejects(oversized.read(),/100000/);assert.equal(oversized.state.fullCopies,0);
  for(const change of [{active:false},{discarded:true},{tabUrl:'https://example.com/'},
    {tabUrl:ownerUrl+'?navigated=1'}]){
    const f=fixture();Object.assign(f.state,change);await assert.rejects(f.read(),/标签页已切换/);assert.equal(f.state.fullCopies,0);
  }
});

test('cancellation at any copy stage does not resume or return stale content',async()=>{
  for(const kind of ['text','canvas']){
    const f=fixture({kind,hook:(event,state)=>{if(event==='full-1')state.stopped=true;}});
    await assert.rejects(f.read(),/已停止/);assert.equal(f.state.formats,0);
  }
});
