import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateEvaluationFailure} from '../frontend/evaluation-failure.mjs';

test('the explicit evaluation failure is authoritative and preserves its diagnostics',()=>{
  const failure={message:'模型暂不可用',code:'ai_unavailable',attempts:[{attempt:1}]};
  assert.equal(candidateEvaluationFailure({evaluation_failure:failure,screening_failure:{message:'旧失败'}}),failure);
});

test('explicit null or invalid new failure fields never revive old screening errors',()=>{
  for(const evaluation_failure of [null,undefined,{},[],{message:''},{message:'  '},{message:4},'error'])
    assert.equal(candidateEvaluationFailure({evaluation_failure,screening_failure:{message:'旧失败'}}),null);
});

test('legacy screening failures are supported only while the new field is absent',()=>{
  const legacy={message:'原采集失败',validation_path:'checks[0]'};
  assert.equal(candidateEvaluationFailure({screening_failure:legacy}),legacy);
  for(const candidate of [null,undefined,{},[],{screening_failure:{message:''}}])
    assert.equal(candidateEvaluationFailure(candidate),null);
});
