import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as helpers from '../extension/capture-utils.mjs';

const origin='https://www.zhipin.com';
const cards=[{id:'0',name:'张**',signature:'一号'},{id:'1',name:'李**',signature:'二号'}];
const memoryBackend=()=>({entries:[],nextId:1});

async function controller({failShare=false,failImport=false,folded=false,missingScreen=false,preopened=false,
  rejectEvidence=false,invalidAiFormat=false,failAi=false,backend=memoryBackend(),batchCards=cards,includeKnown=true,knownRecords,
  incompleteProof=false,missingDomTail=false,stripFooter=false,oneSection=false,
  limit='2',advancePages=[],lookupPages=[],stopOnIdle=true,stopAt=''}={}){
  const elements=new Map(),events=[],posted=[],opened=[],lookupBatches=[],lines=[];
  const listCards=batchCards.map(card=>({...card}));
  function element(id){
    if(!elements.has(id))elements.set(id,{value:'',textContent:'',hidden:true,disabled:false,checked:false,listeners:{},
      addEventListener(type,fn){this.listeners[type]=fn;},
      replaceChildren(){if(id==='#results')lines.length=0;},append(child){if(id==='#results')lines.push(child);}});
    return elements.get(id);
  }
  element('#job').value='1';element('#limit').value=limit;element('#share').checked=true;
  let current=preopened?listCards[0]:null,copyCount=0,registered=[],currentSavedId=null,advanceCount=0;
  const event=value=>{
    events.push(value);
    if(value===stopAt)queueMicrotask(()=>element('#stop').listeners.click());
  };
  const resumeFor=name=>`${name}\n工作经历\n负责机器视觉软件开发和工业检测产线交付，使用 OpenCV。${oneSection?'':'\n教育经历\n虚构大学本科。'}${stripFooter?'\n平台页脚内容只用于验证原始复制覆盖范围。':''}`;
  const row=(frameId,documentId,value)=>({frameId,documentId,result:{ok:true,value}});
  const frameKey=origin+'/web/chat/search',bodyKey=origin+'/web/frame/c-resume/';
  function scan(){
    const canvas=current&&current.id!=='0';
    const outer=row(0,'outer',{frameKey,detail:current&&!canvas?current.name:'',canvasDialog:canvas,cards:[]});
    const list=row(4,'list',{frameKey:origin+'/web/frame/search/',detail:'',cards:listCards});
    return canvas?[outer,list,row(8,'canvas-detail',{frameKey:bodyKey,detail:'',canvasBody:true,cards:[]})]:[outer,list];
  }
  const context={...helpers,URL,URLSearchParams,location:{search:'?tab=7'},
    setTimeout:(fn,ms)=>ms===3000?setTimeout(fn,10):queueMicrotask(fn),clearTimeout,addEventListener(){},
    document:{querySelector:element,createElement:tag=>tag==='canvas'?{getContext:()=>({drawImage(){}}),toDataURL:()=> 'data:image/png;base64,fixture'}:{textContent:'',value:''}},
    createImageBitmap:async()=>({width:1000,height:800,close(){}}),
    navigator:{locks:{request:async(_name,_options,fn)=>fn({})},clipboard:{}},
    copyOpenResume:async({documentId,textSelection})=>{
      event('copy:'+current.name);copyCount++;
      assert.equal(documentId,current.id==='0'?'outer':'canvas-detail');
      if(textSelection){assert.equal(await textSelection.select(),true);await textSelection.clear();}
      const resume=resumeFor(current.name)+(folded&&copyCount===1?'… 查看全部 ':'');
      const issue=missingScreen&&copyCount===1?'第 2 屏未读到剪贴板正文。':'';
      return {resume,resume_html:`<p>${resume}</p>`,selection:textSelection?'text-range':'scroll-drag',issue,screens:1,
        completeness:{topVerified:true,bottomVerified:!incompleteProof,stableBottomReads:incompleteProof?0:2,allScreensRead:!incompleteProof}};
    },
    chrome:{permissions:{request:async()=>true},storage:{local:{get:async()=>({}),set:async()=>{}}},
      tabs:{get:async()=>({url:frameKey,active:true,windowId:5}),captureVisibleTab:async()=> 'data:image/png;base64,fixture'},
      scripting:{getRegisteredContentScripts:async()=>registered,
        unregisterContentScripts:async()=>{registered=[];},
        registerContentScripts:async scripts=>{registered=scripts;},
        executeScript:async request=>{
        if(request.files||request.world==='MAIN')return [];
        const [action,args]=request.args;
        if(action==='scan')return scan();
        if(action==='advance-list'){
          assert.equal(current,null);
          event('advance-list');
          const next=advancePages[advanceCount++];
          if(next){listCards.splice(0,listCards.length,...next.map(card=>({...card})));return [row(4,'list',{kind:'scroll',moved:true})];}
          if(stopOnIdle)queueMicrotask(()=>element('#stop').listeners.click());
          return [row(4,'list',{kind:'waiting',moved:false})];
        }
        if(action==='layout')return [row(0,'outer',{key:frameKey,width:1000,height:800,children:[]})];
        if(action==='open'){
          assert.equal(current,null);
          assert.equal(registered[0]?.runAt,'document_start');
          assert.equal(registered[0]?.world,'MAIN');
          current=listCards.find(card=>card.id===args.id);event('open:'+current.name);opened.push(current.signature);
        }
        if(['prepare-copy','expand-canvas'].includes(action))events.push('expand:'+current.name);
        if(action==='share'){event('share:'+current.name);return [row(0,'outer',{rect:{x:40,y:50,width:200,height:200}})];}
        if(action==='close'){events.push('close:'+current.name);current=null;}
        if(action==='prepare-copy'){
          const normalized=resumeFor(current.name).replace(/\s/g,'');
          return [row(0,'outer',{status:'visible_complete',sections:oneSection?['工作经历']:['工作经历','教育经历'],
            minimumLength:normalized.length,contentHead:normalized.slice(0,80),contentTail:missingDomTail?'未复制的正文末尾':normalized.slice(-80)})];
        }
        return [row(0,'outer',true)];
      }}},
    fetch:async(url,options)=>{
      if(url.startsWith('data:'))return {blob:async()=>({})};
      const path=url.replace('http://127.0.0.1:8765','');
      const data=options?.body?JSON.parse(options.body):null;
      if(data)posted.push(path);
      const reply=(body,ok=true)=>({ok,json:async()=>body});
      if(path==='/api/state')return reply({token:'test',capture_version:1,clipboard_sequence_version:1,collection_status_version:1,jobs:[{id:1,title:'视觉工程师'},{id:2,title:'设备工程师'}]});
      if(path==='/api/extension/collection-status'){
        lookupBatches.push(data.cards);
        const changed=lookupPages[lookupBatches.length-1];
        if(changed)listCards.splice(0,listCards.length,...changed.map(card=>({...card})));
        const known=data.cards.flatMap(card=>{
          const entries=backend.entries.filter(entry=>entry.job===data.job_id&&
            entry.signature===card.signature&&entry.name===card.name);
          if(entries.length!==1)return [];
          return [{signature:card.signature,id:entries[0].id,has_image:entries[0].share}];
        });
        const completed=known.filter(entry=>!data.share||entry.has_image).map(entry=>entry.signature);
        return reply({completed,...(includeKnown?{known:knownRecords===undefined?known:knownRecords}:{})});
      }
      if(path==='/api/extension/clipboard-preview')return reply({...data,
        resume:stripFooter?data.resume.replace('\n平台页脚内容只用于验证原始复制覆盖范围。',''):data.resume,
        preview_document:'<!doctype html><p>履历预览</p>'});
      if(path==='/api/extension/import'){
        if(failImport)return reply({error:'保存履历失败'},false);
        const candidate=data.candidates[0];
        assert.equal(candidate.name,current.name);
        assert.equal(candidate.source_card.name,current.name);
        assert.equal(candidate.source_card.signature,current.signature);
        assert.match(candidate.resume_html,/<p>/);
        assert.ok(!Object.hasOwn(candidate,'preview_document'));
        event('save:'+current.name);
        let entry=backend.entries.find(entry=>entry.job===data.job_id&&entry.signature===current.signature);
        if(!entry){
          entry={id:backend.nextId++,job:data.job_id,name:current.name,signature:current.signature,share:false};
          backend.entries.push(entry);
        }
        currentSavedId=entry.id;
        return reply({ids:[entry.id],added:1});
      }
      if(path==='/api/candidates/share'){
        if(failShare)return reply({error:'保存二维码失败'},false);
        assert.equal(data.id,backend.entries.find(entry=>entry.job===Number(element('#job').value)&&
          entry.name===current.name&&entry.signature===current.signature)?.id);
        backend.entries.find(entry=>entry.id===data.id).share=true;
        event('save-share:'+current.name);return reply({ok:true});
      }
      if(path==='/api/ai/evaluate'){
        assert.equal(data.id,currentSavedId);
        if(failAi)return reply({error:'模型连接失败'},false);
        if(invalidAiFormat&&current.id==='0'){
          events.push('ai-format-pending:'+current.name);
          return reply({code:'evaluation_format_invalid',error:'AI 返回格式未通过校验'},false);
        }
        if(rejectEvidence&&current.id==='0'){
          events.push('ai-pending:'+current.name);
          return reply({code:'evaluation_evidence_mismatch',error:'模型依据未匹配简历原文'},false);
        }
        event('save-ai:'+current.name);return reply({score:82});
      }
      throw Error('Unexpected request '+path);
    }
  };
  const source=fs.readFileSync(new URL('../extension/collector.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
  vm.runInNewContext(source,context);
  await new Promise(resolve=>setImmediate(resolve));
  return {element,events,posted,opened,backend,lookupBatches,lines,
    setCards:next=>listCards.splice(0,listCards.length,...next.map(card=>({...card}))),
    trackerActive:()=>registered.length>0,click:id=>element(id).listeners.click()};
}

test('batch opens each small card and saves copied resume and required QR before opening next',async()=>{
  const c=await controller();
  await c.click('#start');
  assert.deepEqual(c.events,cards.flatMap(({name})=>['open','expand','copy','save','share','save-share','close'].map(step=>`${step}:${name}`)));
  assert.ok(!c.posted.some(path=>path.includes('/ocr')));
  assert.match(c.element('#status').textContent,/已处理 2 位/);
  assert.equal(c.trackerActive(),false);
});

test('batch leaves the candidate open and does not advance when any required save fails',async()=>{
  for(const [flag,error] of [['failImport','保存履历失败'],['failShare','保存二维码失败']]){
    const c=await controller({[flag]:true});
    await c.click('#start');
    assert.match(c.element('#status').textContent,new RegExp(error));
    assert.ok(!c.events.includes('open:李**'));
    assert.ok(!c.events.includes('close:张**'));
    assert.equal(c.events.includes('save:张**'),flag==='failShare');
  }
});

test('folded content pauses the same batch and retries the same candidate before saving',async()=>{
  const c=await controller({folded:true});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.ok(!c.events.some(event=>event.startsWith('save:')));
  c.click('#review-retry');
  await task;
  assert.equal(c.events.filter(event=>event==='copy:张**').length,2);
  assert.equal(c.events.filter(event=>event==='open:张**').length,1);
  assert.ok(c.events.indexOf('save-share:张**')<c.events.indexOf('open:李**'));
});

test('an unread scroll segment blocks saving and advancing until the same candidate is retried',async()=>{
  const c=await controller({missingScreen:true});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(c.element('#status').textContent,/第 2 屏/);
  assert.ok(!c.events.some(event=>event.startsWith('save:')||event==='open:李**'));
  c.click('#review-retry');
  await task;
  assert.ok(c.events.indexOf('save-share:张**')<c.events.indexOf('open:李**'));
});

test('when AI is selected it finishes before the batch closes and advances',async()=>{
  const c=await controller();c.element('#ai').checked=true;
  await c.click('#start');
  assert.ok(c.events.indexOf('save-ai:张**')<c.events.indexOf('open:李**'));
  assert.equal(c.element('#review').hidden,true);
  assert.ok(c.events.indexOf('save-ai:李**')<c.events.indexOf('close:李**'));
});

test('continues after saved data when AI evidence is rejected',async()=>{
  const c=await controller({rejectEvidence:true});c.element('#ai').checked=true;
  await c.click('#start');
  assert.ok(c.events.indexOf('save-share:张**')<c.events.indexOf('ai-pending:张**'));
  assert.ok(c.events.indexOf('ai-pending:张**')<c.events.indexOf('close:张**'));
  assert.ok(c.events.indexOf('close:张**')<c.events.indexOf('open:李**'));
  assert.ok(c.events.includes('save-ai:李**'));
  assert.match(c.element('#status').textContent,/已处理 2 位.*1 位 AI 待评估/);
});

test('invalid AI format leaves saved resume and QR intact and continues the next candidate without recopying',async()=>{
  const backend=memoryBackend();
  const c=await controller({backend,invalidAiFormat:true});
  c.element('#ai').checked=true;
  await c.click('#start');
  assert.ok(c.events.indexOf('save-share:张**')<c.events.indexOf('ai-format-pending:张**'));
  assert.ok(c.events.indexOf('ai-format-pending:张**')<c.events.indexOf('close:张**'));
  assert.ok(c.events.indexOf('close:张**')<c.events.indexOf('open:李**'));
  assert.ok(c.events.includes('save-ai:李**'));
  for(const step of ['copy','save','save-share']){
    assert.equal(c.events.filter(event=>event===step+':张**').length,1);
  }
  assert.match(c.lines[0].textContent,/AI 返回格式未通过校验，已记为待评估/);
  assert.match(c.element('#status').textContent,/已处理 2 位.*1 位 AI 待评估/);
  assert.equal(backend.entries.length,2);
  assert.ok(backend.entries.every(entry=>entry.share));
  const reopened=await controller({backend});
  reopened.element('#ai').checked=true;
  await reopened.click('#start');
  assert.deepEqual(reopened.opened,[]);
  assert.ok(!reopened.posted.some(path=>['/api/extension/clipboard-preview','/api/extension/import','/api/candidates/share','/api/ai/evaluate'].includes(path)));
});

test('a model connection error still stops before the next candidate after resume and QR saves',async()=>{
  const c=await controller({failAi:true});
  c.element('#ai').checked=true;
  await c.click('#start');
  assert.match(c.element('#status').textContent,/模型连接失败/);
  assert.deepEqual(c.opened,['一号']);
  assert.equal(c.backend.entries.length,1);
  assert.equal(c.backend.entries[0].share,true);
  assert.ok(!c.events.includes('close:张**'));
});

test('a verified short canvas resume saves automatically without a manual completeness button',async()=>{
  const c=await controller({batchCards:[cards[1]],oneSection:true});
  await c.click('#start');
  assert.ok(c.events.includes('copy:李**'));
  assert.ok(c.events.includes('save:李**'));
  assert.ok(c.events.includes('close:李**'));
  assert.equal(c.element('#review').hidden,true);
  const html=fs.readFileSync(new URL('../extension/collector.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="review-accept"/);
});

test('missing measured canvas completeness blocks save and automatic next candidate',async()=>{
  const c=await controller({batchCards:[cards[1],{id:'2',name:'王**',signature:'三号'}],incompleteProof:true});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.match(c.element('#status').textContent,/自动校验未通过/);
  assert.ok(!c.events.some(event=>event.startsWith('save:')||event==='open:王**'));
  c.click('#stop');
  await task;
});

test('DOM boundary proof blocks a missing tail but accepts display-only footer cleanup',async()=>{
  const c=await controller({batchCards:[cards[0]],missingDomTail:true});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.element('#review').hidden,false);
  assert.ok(!c.events.some(event=>event.startsWith('save:')));
  c.click('#stop');
  await task;
  const clean=await controller({batchCards:[cards[0]],stripFooter:true});
  await clean.click('#start');
  assert.ok(clean.events.includes('save:张**'));
  assert.equal(clean.element('#review').hidden,true);
});

test('batch requires starting at the list and exposes one collection entry',async()=>{
  const c=await controller({preopened:true});await c.click('#start');
  assert.match(c.element('#status').textContent,/回到候选人小卡片列表/);
  assert.deepEqual(c.events,[]);
  for(const page of ['collector','popup']){
    const html=fs.readFileSync(new URL(`../extension/${page}.html`,import.meta.url),'utf8');
    assert.doesNotMatch(html,/OCR|auto-copy|read-clipboard|paste-resume|id="read"/);
  }
});

test('the limit counts new candidates and a second batch starts after completed cards',async()=>{
  const c=await controller();
  c.element('#limit').value='1';
  await c.click('#start');
  await c.click('#start');
  assert.deepEqual(c.opened,['一号','二号']);
  assert.match(c.element('#status').textContent,/已处理 1 位.*跳过 1 位/);
  await c.click('#start');
  assert.deepEqual(c.opened,['一号','二号']);
  assert.match(c.element('#status').textContent,/均已采集/);
});

test('reopening the collector uses durable workbench records instead of restarting at the first card',async()=>{
  const backend=memoryBackend();
  const first=await controller({backend});
  first.element('#limit').value='1';
  await first.click('#start');
  const reopened=await controller({backend});
  reopened.element('#limit').value='1';
  await reopened.click('#start');
  assert.deepEqual(reopened.opened,['二号']);
});

test('completion is scoped by job and does not skip a different candidate with the same masked name',async()=>{
  const backend=memoryBackend();
  const sameNames=[
    {id:'0',name:'张**',signature:'张** 本科 在职 视觉开发甲公司'},
    {id:'2',name:'张**',signature:'张** 本科 在职 视觉开发乙公司'},
  ];
  const first=await controller({backend,batchCards:sameNames});
  first.element('#limit').value='1';
  await first.click('#start');
  const second=await controller({backend,batchCards:sameNames});
  second.element('#limit').value='1';
  await second.click('#start');
  assert.deepEqual(second.opened,[sameNames[1].signature]);
  const otherJob=await controller({backend,batchCards:sameNames});
  otherJob.element('#job').value='2';
  otherJob.element('#limit').value='1';
  await otherJob.click('#start');
  assert.deepEqual(otherJob.opened,[sameNames[0].signature]);
});

test('a failed required save is retried while a saved resume can be reused when QR is no longer requested',async()=>{
  for(const flag of ['failImport','failShare']){
    const backend=memoryBackend();
    const failed=await controller({backend,[flag]:true});
    failed.element('#limit').value='1';
    await failed.click('#start');
    const retry=await controller({backend});
    retry.element('#limit').value='1';
    await retry.click('#start');
    assert.deepEqual(retry.opened,['一号']);
  }
  const backend=memoryBackend();
  const failedQr=await controller({backend,failShare:true});
  failedQr.element('#limit').value='1';
  await failedQr.click('#start');
  const resumeOnly=await controller({backend});
  resumeOnly.element('#share').checked=false;
  resumeOnly.element('#limit').value='1';
  await resumeOnly.click('#start');
  assert.deepEqual(resumeOnly.opened,['二号']);
});

test('a saved resume missing its required QR is resumed without copying, importing, or evaluating again',async()=>{
  const backend=memoryBackend();
  const failed=await controller({backend,failShare:true});
  failed.element('#limit').value='1';
  await failed.click('#start');
  const retry=await controller({backend});
  retry.element('#ai').checked=true;
  retry.element('#limit').value='1';
  await retry.click('#start');
  assert.deepEqual(retry.events,['open:张**','share:张**','save-share:张**','close:张**']);
  assert.ok(!retry.posted.some(path=>['/api/extension/clipboard-preview','/api/extension/import','/api/ai/evaluate'].includes(path)));
  assert.equal(backend.entries.length,1);
  retry.element('#ai').checked=false;
  await retry.click('#start');
  assert.deepEqual(retry.opened,['一号','二号']);
  assert.match(retry.element('#status').textContent,/已处理 1 位.*跳过 1 位/);
});

test('a failed QR-only retry stays on that candidate and preserves the saved resume',async()=>{
  const backend=memoryBackend();
  const initial=await controller({backend,failShare:true});
  initial.element('#limit').value='1';
  await initial.click('#start');
  const retry=await controller({backend,failShare:true});
  await retry.click('#start');
  assert.deepEqual(retry.events,['open:张**','share:张**']);
  assert.match(retry.element('#status').textContent,/停在 张\*\*.*保存二维码失败/);
  assert.equal(backend.entries.length,1);
  assert.equal(backend.entries[0].share,false);
});

test('an older collection-status response without known records keeps the existing retry behavior',async()=>{
  const backend=memoryBackend();
  const initial=await controller({backend,failShare:true});
  initial.element('#limit').value='1';
  await initial.click('#start');
  const retry=await controller({backend,includeKnown:false});
  retry.element('#limit').value='1';
  await retry.click('#start');
  assert.deepEqual(retry.events,['open:张**','expand:张**','copy:张**','save:张**','share:张**','save-share:张**','close:张**']);
  assert.equal(backend.entries.length,1);
});

test('malformed or ambiguous known records stop the batch before opening a candidate',async()=>{
  const valid={signature:cards[0].signature,id:1,has_image:false};
  for(const knownRecords of [
    [{...valid,id:'1'}],
    [{...valid,has_image:'false'}],
    [{...valid,signature:'another card'}],
    [valid,valid],
    {},
    null,
  ]){
    const c=await controller({knownRecords});
    await c.click('#start');
    assert.match(c.element('#status').textContent,/已保存候选人记录/);
    assert.deepEqual(c.events,[]);
  }
});

test('AI failure after confirmed data saves does not copy the same resume again',async()=>{
  const backend=memoryBackend();
  const failed=await controller({backend,failAi:true});
  failed.element('#ai').checked=true;
  failed.element('#limit').value='1';
  await failed.click('#start');
  assert.match(failed.element('#status').textContent,/模型连接失败/);
  const reopened=await controller({backend});
  reopened.element('#limit').value='1';
  await reopened.click('#start');
  assert.deepEqual(reopened.opened,['二号']);
});

test('a blank count keeps collecting beyond twenty candidates and discovers later lists without repeating saved cards',async()=>{
  const extra=Array.from({length:22},(_,index)=>({id:String(index+2),name:'王**',signature:`后续候选人-${index}`}));
  const c=await controller({limit:'',advancePages:[[cards[1],...extra]]});
  await c.click('#start');
  assert.equal(c.opened.length,24);
  assert.equal(new Set(c.opened).size,24);
  assert.equal(c.backend.entries.length,24);
  assert.equal(c.lookupBatches.length,2);
  assert.equal(c.lookupBatches[1].length,22);
  assert.match(c.element('#status').textContent,/已停止/);
  assert.equal(c.element('#start').disabled,false);
  assert.equal(c.element('#stop').disabled,true);
  assert.equal(c.trackerActive(),false);
});

test('continuous collection waits at the list end and stopping wakes the wait immediately',async()=>{
  const c=await controller({limit:'',stopOnIdle:false});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(c.element('#status').textContent,/已处理 2 位.*暂无新候选人.*等待/);
  assert.equal(c.element('#start').disabled,true);
  assert.equal(c.element('#stop').disabled,false);
  c.click('#stop');
  await task;
  assert.equal(c.events.filter(event=>event==='advance-list').length,1);
  assert.equal(c.element('#start').disabled,false);
  assert.equal(c.trackerActive(),false);
});

test('continuous waiting discovers a newly loaded card with a recycled id after a list update',async()=>{
  const c=await controller({limit:'',stopOnIdle:false});
  const task=c.click('#start');
  await new Promise(resolve=>setImmediate(resolve));
  c.setCards([{id:'0',name:'赵**',signature:'新加载候选人'}]);
  for(let attempt=0;attempt<100&&!c.events.includes('close:赵**');attempt++){
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  c.click('#stop');await task;
  assert.deepEqual(c.opened,['一号','二号','新加载候选人']);
  assert.equal(c.lookupBatches.length,2);
  assert.equal(c.lookupBatches[1][0].signature,'新加载候选人');
});

test('large visible lists split status lookups into 200-card requests without imposing a run limit',async()=>{
  const batchCards=Array.from({length:201},(_,index)=>({id:String(index),name:'王**',signature:`候选-${index}`}));
  const backend=memoryBackend();
  backend.entries=batchCards.slice(0,200).map((card,index)=>({id:index+1,job:1,name:card.name,signature:card.signature,share:true}));
  backend.nextId=201;
  const c=await controller({backend,batchCards,limit:''});
  await c.click('#start');
  assert.deepEqual(c.lookupBatches.map(batch=>batch.length),[200,1]);
  assert.deepEqual(c.opened,['候选-200']);
  const ambiguous=await controller({limit:'',batchCards:[...batchCards,{...batchCards[0],id:'201'}]});
  await ambiguous.click('#start');
  assert.match(ambiguous.element('#status').textContent,/重复小卡片/);
  assert.equal(ambiguous.lookupBatches.length,0);
  assert.equal(ambiguous.opened.length,0);
});

test('continuous collection reselects a fresh card when virtualized content changes during a progress lookup',async()=>{
  const c=await controller({limit:'',lookupPages:[[cards[1]]],advancePages:[[cards[0]]]});
  await c.click('#start');
  assert.deepEqual(c.opened,['二号','一号']);
  assert.equal(c.backend.entries.length,2);
  assert.match(c.element('#status').textContent,/已停止/);
});

test('stopping during copy or a save preserves committed data and never opens the next candidate',async()=>{
  for(const [step,expectedSaved,expectedShare] of [
    ['copy',false,false],['save',true,false],['save-share',true,true],['save-ai',true,true],
  ]){
    const c=await controller({limit:'',stopAt:`${step}:张**`});
    c.element('#ai').checked=true;
    await c.click('#start');
    assert.deepEqual(c.opened,['一号']);
    assert.equal(c.backend.entries.length,expectedSaved?1:0);
    assert.equal(Boolean(c.backend.entries[0]?.share),expectedShare);
    assert.ok(!c.events.includes('close:张**'));
    if(step==='save-share')assert.ok(!c.events.includes('save-ai:张**'));
    assert.equal(c.trackerActive(),false);
  }
});

test('optional counts accept more than twenty and reject invalid values before opening anything',async()=>{
  const many=await controller({limit:'25'});
  await many.click('#start');
  assert.equal(many.opened.length,2);
  for(const limit of ['0','-1','1.5','NaN','9007199254740992']){
    const c=await controller({limit});await c.click('#start');
    assert.match(c.element('#status').textContent,/正整数/);
    assert.equal(c.opened.length,0);
  }
  const html=fs.readFileSync(new URL('../extension/collector.html',import.meta.url),'utf8');
  assert.match(html,/placeholder="留空不限人数"/);
  assert.doesNotMatch(html,/max="20"|value="5"|本次最多人数/);
});
