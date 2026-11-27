import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaymentMonitor} from '../extension/payment-stop.mjs';

const reply=value=>[{frameId:0,result:value}];
function fixture(execute,onPayment,onError){
  const browser={scripting:{executeScript(request){
    assert.deepEqual(request.target,{tabId:42,frameIds:[0]});
    return execute();
  }}};
  return createPaymentMonitor({browser,tabId:42,onPayment,onError,intervalMs:5});
}

test('a purchase page present at startup stops the run and remains latched until a new run',async()=>{
  let detections=0,calls=0;
  const run=fixture(()=>{calls++;return reply(true);},()=>detections++);
  try{
    await assert.rejects(run.start(),{code:'payment-stop'});
    await assert.rejects(run.checkNow(),{code:'payment-stop'});
    assert.equal(run.detected,true);
    assert.equal(calls,1);assert.equal(detections,1);
  }finally{run.stop();}
});

test('a purchase page appearing during idle work is reported without a new action',{timeout:1000},async()=>{
  let visible=false,notify;
  const detected=new Promise(resolve=>{notify=resolve;});
  const run=fixture(()=>reply(visible),notify);
  try{
    await run.start();
    visible=true;
    await detected;
    assert.equal(run.detected,true);
  }finally{run.stop();}
});

test('a late result from a stopped monitor cannot stop another run',async()=>{
  let complete,notifications=0;
  const run=fixture(()=>new Promise(resolve=>{complete=resolve;}),()=>notifications++,()=>notifications++);
  const first=run.start(),second=run.checkNow();
  run.stop();
  await Promise.all([assert.rejects(first,/已结束/),assert.rejects(second,/已结束/)]);
  complete(reply(true));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(notifications,0);assert.equal(run.detected,false);
});

test('missing top-frame results stop with an inspection error',async()=>{
  let error;
  const run=fixture(()=>[],()=>assert.fail('should not report payment'),value=>{error=value;});
  try{
    await assert.rejects(run.start(),/无法核对/);
    assert.match(error.message,/无法核对/);assert.equal(run.detected,false);
  }finally{run.stop();}
});
