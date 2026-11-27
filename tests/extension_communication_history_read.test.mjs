import test from 'node:test';
import assert from 'node:assert/strict';
import {readCommunicationSnapshot} from '../extension/read-communication-snapshot.mjs';

function fixture({changedDocument=false,changedFriend=false,blocked=false}={}){
  const calls=[];
  let loaded=false;
  const snapshot=()=>({ok:true,selected_friend_id:loaded&&changedFriend?'202':'101',
    conversations:[{friend_id:'101',candidate_name:'合成候选人',platform_job_id:'JOB',platform_geek_id:'GEEK'},
      {friend_id:'202',candidate_name:'另一位',platform_job_id:'JOB',platform_geek_id:'OTHER'}],
    messages:loaded?[{friend_id:'101',message_id:'real-mid',kind:'attachment',direction:'incoming',attachment_status:'received'}]:[],
    message_capture:{unresolved_count:loaded?0:3,unresolved_attachments:loaded?0:1,history_loaded:loaded,history_count:loaded?3:0},warnings:[]});
  const browser={scripting:{executeScript:async request=>{
    calls.push(request);
    if(request.func.name==='installChatMessageSource')return [];
    const documentId=loaded&&changedDocument?'new-document':'chat';
    if(request.func.name==='loadChatMessageHistory'){
      assert.deepEqual(request.target,{tabId:7,documentIds:['chat']});
      assert.deepEqual(request.args,[{friend_id:'101',count:100}]);
      loaded=true;
      return [{documentId,frameId:4,result:blocked?{ok:false,error:'平台未允许读取会话记录'}:{ok:true,history_count:3}}];
    }
    return [{documentId,frameId:4,result:snapshot()}];
  }}};
  return {calls,read:opts=>readCommunicationSnapshot({browser,tabId:7,...opts})};
}

test('an explicit read supplements unresolved cards in the same document and exposes real history messages',async()=>{
  const f=fixture(),result=await f.read();
  assert.equal(result.snapshot.messages[0].message_id,'real-mid');
  assert.deepEqual(result.frame,{documentId:'chat',frameId:4});
  assert.equal(f.calls.filter(row=>row.func.name==='loadChatMessageHistory').length,1);
  await f.read({frame:result.frame});
  assert.equal(f.calls.filter(row=>row.func.name==='loadChatMessageHistory').length,1);
});

test('selection-settling reads do not request history and a changed document/friend cannot use history',async()=>{
  const initial=fixture();await initial.read({history:false});
  assert.equal(initial.calls.filter(row=>row.func.name==='loadChatMessageHistory').length,0);
  await assert.rejects(fixture({changedDocument:true}).read(),/框架已变化/);
  await assert.rejects(fixture({changedFriend:true}).read(),/候选人已切换/);
});

test('platform failure is visible and does not return a successful zero-message snapshot',async()=>{
  await assert.rejects(fixture({blocked:true}).read(),/平台未允许读取会话记录/);
});
