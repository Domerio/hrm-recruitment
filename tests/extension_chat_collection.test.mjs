import test from 'node:test';
import assert from 'node:assert/strict';
import {collectChatResumes} from '../extension/chat-collection.mjs';

const people=[{friend_id:'101',candidate_name:'王先生',platform_job_id:'JOB',platform_geek_id:'GEEK-A'},
  {friend_id:'202',candidate_name:'王先生',platform_job_id:'JOB',platform_geek_id:'GEEK-B'}];

function fixture({selected='101',list=people,frameChange=false,switchDuringDownload=false,
  stoppedDuringDownload=false,existingAttachment=false,noOnline=false,unavailableFile=false,afterSource,transientSwitch=false,
  unresolvedAttachments=0,historyAvailable=false,transientError='消息归属与当前候选人不一致，已停止读取。',
  jobBinding,jobTitle='',changeJobDuringDownload=false,checkPayment}={}){
  const calls=[],actions=[],downloads=[],reads=[],progress=[],saved=[];
  let frameReads=0,stopped=false,attachmentId=1,resumeId=1,pendingSwitch=0,historyLoaded=false,historyReads=0;
  const conversations=new Map();
  const messages=person=>[{friend_id:person.friend_id,message_id:'message-'+person.friend_id,direction:'incoming',
    kind:'attachment',attachment_name:'履历.pdf',attachment_status:'received',text:'',sent_at:''}];
  let currentJobTitle=jobTitle;
  const snapshot=()=>({ok:true,conversations:list.map(row=>({...row,...(currentJobTitle?{platform_job_title:currentJobTitle}:{})})),selected_friend_id:selected,
    messages:messages(list.find(row=>row.friend_id===selected)||list[0]),warnings:[],
    message_capture:{unresolved_attachments:unresolvedAttachments,history_loaded:historyLoaded}});
  const browser={tabs:{get:async()=>({id:7,url:'https://www.zhipin.com/web/chat/index',active:true,windowId:1})},scripting:{
    executeScript:async request=>{
      if(request.func.name==='installChatMessageSource')return [];
      if(request.func.name==='loadChatMessageHistory'){
        historyReads++;
        assert.deepEqual(request.target.documentIds,['chat']);
        assert.equal(request.args[0].friend_id,selected);
        historyLoaded=historyAvailable;
        return [{frameId:4,documentId:'chat',result:historyAvailable?{ok:true,history_loaded:true,history_count:1}:
          {ok:false,error:'页面可见附件，但会话记录暂时不可读取，已暂停。'}}];
      }
      if(request.func.name==='readCommunicationPage'){
        if(pendingSwitch-->0)return [{frameId:4,documentId:'chat',result:{ok:false,error:transientError}}];
        frameReads++;return [{frameId:4,documentId:frameChange&&frameReads>2?'changed':'chat',result:snapshot()}];
      }
      assert.equal(request.func.name,'chatPageAction');
      assert.deepEqual(request.target.documentIds,['chat']);
      const args=request.args[0];actions.push(args);
      if(args.action==='open-chat'){selected=args.friend_id;pendingSwitch=transientSwitch?2:0;return [{frameId:4,documentId:'chat',result:{ok:true,status:'opened'}}];}
      assert.equal(args.friend_id,selected);
      let result;
      if(args.action==='attachment-fetch')result=unavailableFile?{ok:false,status:'expired',error:'附件已过期'}:
        {ok:true,status:'download-ready',download:{...list.find(row=>row.friend_id===selected),message_id:args.message_id,url:'PRIVATE'}};
      else if(args.action==='open-online')result=noOnline?{ok:false,status:'not-found',error:'没有在线简历入口'}:{ok:true,status:'opened',open_token:'opened-'+selected};
      else if(args.action==='close-online'){assert.equal(args.open_token,'opened-'+selected);result={ok:true,status:'closed'};}
      else throw Error('Unexpected action '+args.action);
      return [{frameId:4,documentId:'chat',result}];
    },
  }};
  const api=async(path,data)=>{
    calls.push({path,data});
    if(path==='/api/communications/import'){
      const person=data.conversations[0];assert.equal(person.friend_id,selected);
      conversations.set(person.friend_id,{...person,id:Number(person.friend_id),account_id:data.account_id,job_id:data.job_id});
      return {conversation_count:1};
    }
    if(path==='/api/communications/list')return {conversations:[...conversations.values()]};
    if(path==='/api/communications/detail')return {conversation:conversations.get(String(data.id)),messages:[{
      id:data.id*10,message_id:'message-'+data.id,attachment:existingAttachment?{id:999}:null,
    }]};
    if(path==='/api/communications/attachment'){
      assert.equal(data.conversation_id,Number(selected));assert.equal(data.message_id,Number(selected)*10);
      return {attachment:{id:attachmentId++}};
    }
    if(path==='/api/communications/resume'){
      assert.equal(data.conversation_id,Number(selected));saved.push(data);
      const result={resume:{id:resumeId++,conversation_id:data.conversation_id,name:'王先生',source_kind:data.source_kind,
        evaluation_status:data.evaluate?'complete':'not_requested',evaluation:data.evaluate?{score:88}:null}};
      afterSource?.(data);return result;
    }
    throw Error('Unexpected API '+path);
  };
  const downloadAttachment=async(plan,{expected,check})=>{
    assert.equal(plan.friend_id,expected.friend_id);assert.equal(plan.message_id,expected.message_id);
    downloads.push(expected.friend_id);
    if(switchDuringDownload)selected=selected==='101'?'202':'101';
    if(stoppedDuringDownload)stopped=true;
    if(changeJobDuringDownload)currentJobTitle='采购工程师';
    check();return {file:{name:'履历.pdf',content:'JVBERi0xLjQ=',size:8,mime:'application/pdf'}};
  };
  const readOnline=async({expectedName,assertConversation,check})=>{
    check();await assertConversation();assert.equal(expectedName,'王先生');reads.push(selected);
    return {candidate:{name:expectedName,resume:'完整的合成简历工作经历和教育经历',resume_html:'<p>合成简历</p>',capture:{status:'visible_complete'}}};
  };
  const run=(overrides={})=>collectChatResumes({browser,tabId:7,
    selection:{job_id:1,account_id:'公司-招聘人',account_name:'招聘人',job_binding:jobBinding,conversations:list},
    options:{attachments:true,online:true,evaluate:true,limit:10,...overrides},api,downloadAttachment,readOnline,checkPayment,
    check:()=>{if(stopped)throw Error('用户停止');},pause:async()=>{},onProgress:row=>progress.push({...row})});
  return {run,calls,actions,downloads,reads,progress,saved,historyReads:()=>historyReads};
}

test('checkout appearing after saving a chat resume prevents close and the next conversation',async()=>{
  let paidPage=false;
  const f=fixture({afterSource:()=>{paidPage=true;},checkPayment:async()=>{
    if(paidPage)throw Error('已到支付页面');
  }});
  await assert.rejects(f.run({attachments:false}),/支付页面/);
  assert.equal(f.saved.length,1);
  assert.equal(f.reads.length,1);
  assert.equal(f.actions.some(action=>action.action==='close-online'),false);
});

test('same-name chat candidates collect attachment then online by stable conversation and message IDs',async()=>{
  const f=fixture();const result=await f.run();
  assert.equal(result.length,2);assert.deepEqual(f.downloads,['101','202']);assert.deepEqual(f.reads,['101','202']);
  assert.deepEqual(f.saved.map(row=>[row.conversation_id,row.source_kind]),[[101,'attachment'],[101,'online'],[202,'attachment'],[202,'online']]);
  assert.equal(f.actions.filter(row=>row.action==='open-chat').length,1);
  assert.ok(f.actions.every(row=>!/(?:send|greet|accept|request)/.test(row.action)));
  assert.equal(f.progress.at(-1).complete,true);
});

test('already archived attachments are reused without downloading again and evaluation can be disabled',async()=>{
  const f=fixture({existingAttachment:true});const result=await f.run({online:false,evaluate:false});
  assert.deepEqual(f.downloads,[]);assert.deepEqual(f.reads,[]);
  assert.ok(f.saved.every(row=>row.attachment_id===999&&row.evaluate===false));
  assert.ok(result.every(row=>row.attachments===1&&row.online===0));
});

test('a self-initiated chat switch waits for stale history to settle before importing the next person',async()=>{
  for(const transientError of ['消息归属与当前候选人不一致，已停止读取。','消息原始会话标识属于另一位候选人。','可见消息节点属于另一位候选人。',
    '当前聊天与会话列表的沟通职位标识不一致，请等待页面稳定后重试。','当前聊天显示了不同的沟通职位名称，请等待页面稳定后重试。',
    '当前沟通职位使用不同形式的标识，但页面未提供对应关系，请重新打开该会话后重试。']){
    const f=fixture({transientSwitch:true,transientError});const result=await f.run();
    assert.equal(result.length,2);assert.deepEqual(f.downloads,['101','202']);
    assert.deepEqual(f.saved.map(row=>row.conversation_id),[101,101,202,202]);
  }
});

test('unavailable attachment and online entries report their state instead of a successful capture',async()=>{
  const f=fixture({noOnline:true,unavailableFile:true});const result=await f.run();
  assert.deepEqual(f.downloads,[]);assert.deepEqual(f.saved,[]);
  assert.ok(result.every(row=>row.issues.length===2&&row.attachments===0&&row.online===0));
});

test('a visible unresolved attachment stops before importing zero-message success or requesting a download',async()=>{
  const f=fixture({unresolvedAttachments:1});
  await assert.rejects(f.run(),/页面可见附件.*暂停/);
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.downloads,[]);assert.deepEqual(f.reads,[]);
  const onlineOnly=fixture({unresolvedAttachments:1});
  const result=await onlineOnly.run({attachments:false});
  assert.ok(result.every(row=>row.online===1));assert.deepEqual(onlineOnly.downloads,[]);
  assert.equal(onlineOnly.historyReads(),0);
});

test('verified recent history can supply received attachments while unmatched rendered cards remain explicit',async()=>{
  const f=fixture({unresolvedAttachments:1,historyAvailable:true});
  const result=await f.run({online:false});
  assert.equal(f.historyReads(),1);
  assert.deepEqual(f.downloads,['101','202']);
  assert.ok(result.every(row=>row.attachments===1&&row.issues.some(issue=>/尚未关联.*已核验/.test(issue))));
});

test('switching a candidate or stopping during download cannot archive bytes or continue to the next conversation',async()=>{
  for(const options of [{switchDuringDownload:true},{stoppedDuringDownload:true}]){
    const f=fixture(options);await assert.rejects(f.run(),/候选人已切换|用户停止/);
    assert.deepEqual(f.saved,[]);assert.equal(f.calls.filter(row=>row.path==='/api/communications/attachment').length,0);
    assert.ok(!f.actions.some(row=>row.action==='open-chat'));
  }
});

test('a replaced chat document and cross-job selections stop before downloading or storing a resume',async()=>{
  const changed=fixture({frameChange:true});await assert.rejects(changed.run(),/框架已变化/);assert.deepEqual(changed.saved,[]);
  const mixed=fixture({list:[people[0],{...people[1],platform_job_id:'OTHER'}]});
  await assert.rejects(mixed.run(),/同一平台岗位/);assert.deepEqual(mixed.calls,[]);
  const unknown=fixture({list:people.map(row=>({...row,platform_job_id:''}))});
  await assert.rejects(unknown.run(),/岗位标识缺失/);
});

test('attachment-only, online-only and explicit queue limits do not start unselected work',async()=>{
  const online=fixture();await online.run({attachments:false});
  assert.deepEqual(online.downloads,[]);assert.ok(online.saved.every(row=>row.source_kind==='online'));
  const limit=fixture();await assert.rejects(limit.run({limit:1}),/人数/);assert.deepEqual(limit.actions,[]);
  const none=fixture();await assert.rejects(none.run({attachments:false,online:false}),/至少选择/);
});

test('automatically matched jobs stay bound to the account and live communicated position',async()=>{
  const jobBinding={job_id:1,account_id:'公司-招聘人',platform_job_id:'JOB',platform_job_title:'视觉算法工程师',method:'history'};
  const good=fixture({jobBinding,jobTitle:'视觉算法工程师'});
  await good.run({online:false});assert.deepEqual(good.downloads,['101','202']);
  for(const platform_job_title of ['视觉算法工程师','']){
    const changed=fixture({jobBinding:{...jobBinding,platform_job_title},jobTitle:'视觉算法工程师',changeJobDuringDownload:true});
    await assert.rejects(changed.run({online:false}),/沟通职位已变化/);
    assert.deepEqual(changed.saved,[]);
    assert.equal(changed.calls.filter(row=>row.path==='/api/communications/attachment').length,0);
  }
  for(const binding of [{...jobBinding,job_id:2},{...jobBinding,account_id:'其他账号'},{...jobBinding,platform_job_id:'OTHER'}]){
    const bad=fixture({jobBinding:binding,jobTitle:'视觉算法工程师'});
    await assert.rejects(bad.run(),/自动识别的岗位.*不一致/);assert.deepEqual(bad.calls,[]);
  }
});

test('a title-only job match needs the current communicated title before archiving',async()=>{
  const f=fixture({jobBinding:{job_id:1,account_id:'公司-招聘人',platform_job_id:'JOB',platform_job_title:'视觉算法工程师',method:'title'}});
  await assert.rejects(f.run(),/沟通职位已变化或无法确认/);assert.deepEqual(f.calls,[]);
});
