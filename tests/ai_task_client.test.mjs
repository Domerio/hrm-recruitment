import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiTaskBatch, aiTaskLabel, submitAiTask} from '../frontend/ai-task-client.mjs';

const reply = task => ({json:async () => ({task})});
const targets = count => Array.from({length:count},(_,i)=>({id:i+1,name:`候选人${i+1}`,job_id:1}));
const task = (id,state='queued',extra={}) => ({id:`task-${id}`,state,position:id,subscription_id:`subscription-${id}`,...extra});
const immediate = async () => {};

test('a small batch submits promptly without waiting for model completion; server states drive progress',async()=>{
  const submitted=[],polls=new Map(),updates=[];
  const controller=createAiTaskBatch({targets:targets(6),pause:immediate,onUpdate:p=>updates.push(p),api:async(path,data)=>{
    if(path==='/api/ai/tasks'){
      assert.equal(data.action,'evaluate');submitted.push(data.data.id);return reply(task(data.data.id));
    }
    assert.equal(data,undefined,'polling must use the API GET contract');
    assert.equal(submitted.length,6,'all submissions happen before completion polling');
    const id=Number(path.split('-').at(-1)),count=(polls.get(id)||0)+1;polls.set(id,count);
    return reply(task(id,count===1?(id<3?'running':'queued'):id===4?'failed':'succeeded',
      count===1?{}:{status:id===4?502:200,result:id===4?{error:'模型响应无效'}:{cached:id===1}}));
  }});
  const result=await controller.run();
  assert.deepEqual(submitted,[1,2,3,4,5,6]);
  assert.equal(result.running,false);assert.equal(result.completed,6);
  assert.equal(result.success,5);assert.equal(result.failed,1);assert.equal(result.reused,1);
  assert.equal(result.failures[0].id,4);assert.equal(result.failures[0].message,'模型响应无效');
  assert.ok(updates.some(p=>p.activeCount===2&&p.queued===4));
  assert.ok(!JSON.stringify(updates).includes('subscription-'),'private cancellation credentials stay inside the client');
});

function simulatedQueue({capacity,retention,finishPerTick=capacity}) {
  const records=new Map(),active=new Set(),completed=[],accepted=new Set(),observed=new Set();
  let requests=0,maxRequests=0,full=0,ticks=0,firstPollAt=null;
  const api=async(path,data)=>{
    requests++;maxRequests=Math.max(maxRequests,requests);
    await Promise.resolve();
    try{
      if(path==='/api/ai/tasks'){
        const id=data.data.id;
        if(active.size>=capacity){full++;const error=new Error('队列已满');error.status=503;error.code='ai_queue_full';throw error;}
        assert.equal(accepted.has(id),false,'an accepted job must never be submitted twice');
        accepted.add(id);active.add(id);records.set(id,task(id));return reply(records.get(id));
      }
      assert.equal(data,undefined);
      const id=Number(path.split('-').at(-1));
      firstPollAt??=accepted.size;
      const record=records.get(id);
      assert.ok(record,`task ${id} was lost from retention before observation`);
      if(record.state==='succeeded')observed.add(id);
      return reply(record);
    }finally{requests--;}
  };
  const pause=async()=>{
    ticks++;
    for(const id of [...active].slice(0,finishPerTick)){
      active.delete(id);records.set(id,task(id,'succeeded',{status:200,result:{}}));completed.push(id);
      if(completed.length>retention){
        const evicted=completed.shift();
        assert.ok(observed.has(evicted),`completed task ${evicted} was not observed before retention eviction`);
        records.delete(evicted);
      }
    }
  };
  return{api,pause,metrics:()=>({maxRequests,full,ticks,firstPollAt,accepted:accepted.size,observed:observed.size})};
}

test('129 candidates survive a tiny full backend queue with rolling submission, retry and completion retention',async()=>{
  const server=simulatedQueue({capacity:3,retention:4,finishPerTick:2});
  let maxWindow=0,sawWaiting=false;
  const controller=createAiTaskBatch({targets:targets(129),api:server.api,pause:server.pause,maxInFlight:5,onUpdate:p=>{
    maxWindow=Math.max(maxWindow,p.queued+p.activeCount+p.submitting);
    sawWaiting ||= p.waiting>0&&p.tasks.some(entry=>entry.message?.includes('队列已满'));
    assert.equal(p.failed,0,'known backpressure must remain waiting, not failed');
  }});
  const result=await controller.run(),metrics=server.metrics();
  assert.equal(result.success,129);assert.equal(result.failed,0);assert.equal(result.waiting,0);
  assert.equal(metrics.accepted,129);assert.equal(metrics.observed,129);
  assert.ok(metrics.full>0);assert.ok(metrics.ticks>0);assert.ok(sawWaiting);
  assert.ok(maxWindow<=5,`window ${maxWindow}`);assert.ok(metrics.maxRequests<=8);
  assert.ok(metrics.firstPollAt<129,'polling must begin before the full batch has been submitted');
});

test('250 candidates keep the default rolling window within 50 and observe results before 200-task retention evicts them',async()=>{
  const server=simulatedQueue({capacity:100,retention:200});let maxWindow=0;
  const controller=createAiTaskBatch({targets:targets(250),api:server.api,pause:server.pause,onUpdate:p=>{
    maxWindow=Math.max(maxWindow,p.queued+p.activeCount+p.submitting);
  }});
  const result=await controller.run(),metrics=server.metrics();
  assert.equal(result.success,250);assert.equal(result.failed,0);
  assert.equal(metrics.accepted,250);assert.equal(metrics.observed,250);
  assert.equal(metrics.full,0);assert.ok(maxWindow<=50);assert.ok(metrics.maxRequests<=8);
  assert.ok(metrics.firstPollAt<50);
});

test('stop during full-queue backoff never submits the waiting remainder',async()=>{
  let controller,submits=0,pauses=0;
  controller=createAiTaskBatch({targets:targets(129),pause:async()=>{pauses++;controller.stop();},api:async()=>{
    submits++;const error=new Error('容量暂满');error.status=503;error.code='ai_queue_full';throw error;
  }});
  const result=await controller.run();
  assert.equal(submits,4);assert.equal(pauses,1);assert.equal(result.cancelled,129);assert.equal(result.failed,0);
  assert.equal(result.waiting,0);assert.equal(result.stopped,true);
});

test('only explicit rejected queue-full errors retry; ambiguous 503 submissions are not duplicated',async()=>{
  let submissions=0;
  const controller=createAiTaskBatch({targets:targets(1),pause:async()=>{throw Error('must not retry');},api:async()=>{
    submissions++;const error=new Error('服务响应超时');error.status=503;error.code='upstream_unavailable';throw error;
  }});
  const result=await controller.run();
  assert.equal(submissions,1);assert.equal(result.failed,1);assert.match(result.failures[0].message,/提交未确认/);
});

test('stop releases only this batch subscriptions, including shared tasks, and waits for running work',async()=>{
  const cancelled=[],polled=[];let controller;
  controller=createAiTaskBatch({targets:targets(3),pause:immediate,onUpdate:p=>{
    if(p.tasks.every(row=>row.taskId)&&!p.stopping)controller.stop();
  },api:async(path,data)=>{
    if(path==='/api/ai/tasks')return reply(task(data.data.id,data.data.id===1?'running':'queued',{reused:true}));
    const id=Number(path.match(/task-(\d+)/)[1]);
    if(path.endsWith('/cancel')){
      cancelled.push({id,data});
      return reply(task(id,id===1?'running':id===2?'queued':'cancelled'));
    }
    polled.push(id);return reply(task(id,'succeeded',{status:200,result:{cached:false}}));
  }});
  const result=await controller.run();
  assert.deepEqual(cancelled,[1,2,3].map(id=>({id,data:{subscription_id:`subscription-${id}`}})));
  assert.deepEqual(polled,[1]);assert.equal(result.success,1);assert.equal(result.cancelled,2);
  assert.match(result.tasks[1].message,/共享任务/);assert.equal(result.stopped,true);
});

test('stop racing a queued task that has started continues polling the running task without another cancel',async()=>{
  let controller,cancelCount=0,pollCount=0;
  controller=createAiTaskBatch({targets:targets(1),pause:immediate,onUpdate:p=>{
    if(p.queued&&!p.stopping)controller.stop();
  },api:async(path,data)=>{
    if(path==='/api/ai/tasks')return reply(task(1));
    if(path.endsWith('/cancel')){cancelCount++;return reply(task(1,'running'));}
    pollCount++;return reply(task(1,pollCount===1?'running':'succeeded',{status:200,result:{}}));
  }});
  const result=await controller.run();
  assert.equal(cancelCount,1);assert.equal(pollCount,2);assert.equal(result.success,1);
});

test('closing the page during submission leaves accepted backend jobs running and sends no cancel',async()=>{
  let resolve;const pending=new Promise(done=>{resolve=done;});const calls=[];
  const controller=createAiTaskBatch({targets:targets(1),pause:immediate,api:async(path,data)=>{
    calls.push({path,data});await pending;return reply(task(1));
  }});
  const running=controller.run();controller.detach();resolve();
  const result=await running;
  assert.equal(result.detached,true);assert.equal(result.tasks[0].state,'queued');assert.equal(calls.length,1);
});

test('stop prevents not-yet-submitted candidates while cancelling accepted requests with their own receipts',async()=>{
  let resolve;const pending=new Promise(done=>{resolve=done;});const submits=[],cancelled=[];
  const controller=createAiTaskBatch({targets:targets(8),pause:immediate,api:async(path,data)=>{
    if(path==='/api/ai/tasks'){submits.push(data.data.id);await pending;return reply(task(data.data.id));}
    assert.ok(path.endsWith('/cancel'));const id=Number(path.match(/task-(\d+)/)[1]);cancelled.push(id);
    return reply(task(id,'cancelled'));
  }});
  const running=controller.run();controller.stop();resolve();
  const result=await running;
  assert.deepEqual(submits,[1,2,3,4]);assert.deepEqual(cancelled,[1,2,3,4]);assert.equal(result.cancelled,8);
});

test('temporary polling errors retry existing tasks without resubmitting or pretending model failure',async()=>{
  const updates=[];let polls=0,submits=0;
  const controller=createAiTaskBatch({targets:targets(1),pause:immediate,onUpdate:p=>updates.push(p),api:async path=>{
    if(path==='/api/ai/tasks'){submits++;return reply(task(1));}
    if(++polls===1)throw new Error('临时网络错误');
    return reply(task(1,'succeeded',{status:200,result:{}}));
  }});
  const result=await controller.run();
  assert.equal(submits,1);assert.equal(polls,2);assert.equal(result.success,1);
  assert.ok(updates.some(p=>p.tasks[0].pollError&&p.failed===0));
});

test('one submission failure does not stop submitting other selected candidates',async()=>{
  const submitted=[];
  const controller=createAiTaskBatch({targets:targets(3),pause:immediate,api:async(path,data)=>{
    if(path==='/api/ai/tasks'){
      submitted.push(data.data.id);if(data.data.id===2)throw new Error('排队人数已满');
      return reply(task(data.data.id,'succeeded',{status:200,result:{}}));
    }
    throw Error('Unexpected poll');
  }});
  const result=await controller.run();
  assert.deepEqual(submitted,[1,2,3]);assert.equal(result.success,2);assert.equal(result.failed,1);
  assert.match(result.failures[0].message,/提交未确认.*排队人数已满/);
});

test('a mismatched task response stops observation and never attributes another result to the candidate',async()=>{
  const controller=createAiTaskBatch({targets:targets(1),pause:immediate,api:async path=>
    reply(path==='/api/ai/tasks'?task(1):task(999,'succeeded',{status:200,result:{cached:true}}))});
  const result=await controller.run();
  assert.equal(result.tasks[0].state,'unavailable');assert.equal(result.success,0);
  assert.equal(result.tasks[0].result,undefined);assert.match(result.failures[0].message,/后台任务可能仍在执行/);
});

test('invalid IDs and missing cancellation subscriptions cannot be silently accepted',async()=>{
  for(const id of [0,-1,'1',null,Infinity])await assert.rejects(submitAiTask(()=>{throw Error('must not call');},id),/编号无效/);
  await assert.rejects(submitAiTask(async()=>reply({id:'task-1',state:'queued'}),1),/订阅凭据/);
  assert.throws(()=>createAiTaskBatch({api(){},targets:[{id:1},{id:1}]}),/重复/);
  assert.equal(aiTaskLabel({state:'queued',position:3}),'排队中 · 第 3 位');
});
