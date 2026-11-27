import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {DEFAULT_COLLECTION_POLICY,normalizeCollectionPolicy,policyUsesQr,policyUsesColleague}
  from '../extension/collection-policy.mjs';

test('collection defaults remain frozen and normalization returns independent values',()=>{
  assert.equal(Object.isFrozen(DEFAULT_COLLECTION_POLICY),true);
  assert.deepEqual(normalizeCollectionPolicy(),{save_above:55,share_above:75,share_mode:'both',colleague_name:'蔡女士',greet_enabled:false});
  const policy=normalizeCollectionPolicy();
  policy.save_above=90;
  assert.equal(DEFAULT_COLLECTION_POLICY.save_above,55);
  assert.equal(normalizeCollectionPolicy().save_above,55);
});

test('greeting is opt-in for legacy policies and only accepts a boolean independent of sharing',()=>{
  assert.equal(normalizeCollectionPolicy({save_above:60,share_above:80,share_mode:'none',colleague_name:''}).greet_enabled,false);
  for(const share_mode of ['none','qr','colleague','both'])assert.equal(normalizeCollectionPolicy({share_mode,greet_enabled:true}).greet_enabled,true);
  for(const greet_enabled of [1,0,'true','false',null,undefined,{},[]])
    assert.throws(()=>normalizeCollectionPolicy({greet_enabled}),/自动打招呼开关/);
});

test('partial rules preserve supplied thresholds without requiring integer scores',()=>{
  assert.deepEqual(normalizeCollectionPolicy({save_above:55.5,share_above:0}),
    {...DEFAULT_COLLECTION_POLICY,save_above:55.5,share_above:0});
  assert.equal(normalizeCollectionPolicy({save_above:100,share_above:100}).save_above,100);
  assert.equal(normalizeCollectionPolicy({save_above:0,share_above:100}).save_above,0);
});

test('score values require finite numeric values within the inclusive range',()=>{
  for(const key of ['save_above','share_above'])for(const value of [-0.01,100.01,NaN,Infinity,-Infinity,'55','',null,undefined,true]){
    assert.throws(()=>normalizeCollectionPolicy({[key]:value}),/分数线必须是 0 到 100 之间的有限数字/);
  }
});

test('each sharing choice independently controls QR and colleague behavior',()=>{
  for(const [share_mode,qr,colleague] of [['none',false,false],['qr',true,false],['colleague',false,true],['both',true,true]]){
    const policy=normalizeCollectionPolicy({share_mode});
    assert.equal(policyUsesQr(policy),qr);
    assert.equal(policyUsesColleague(policy),colleague);
  }
  assert.equal(policyUsesQr(),true);
  assert.equal(policyUsesColleague(),true);
  for(const share_mode of ['',null,undefined,'QR','all',0])
    assert.throws(()=>normalizeCollectionPolicy({share_mode}),/分享方式/);
});

test('enabled colleague sharing requires an exact trimmed nonempty display name',()=>{
  for(const share_mode of ['colleague','both']){
    assert.equal(normalizeCollectionPolicy({share_mode,colleague_name:'  王女士  '}).colleague_name,'王女士');
    for(const colleague_name of ['', '   '])assert.throws(()=>normalizeCollectionPolicy({share_mode,colleague_name}),/1 到 40/);
  }
  for(const share_mode of ['none','qr'])
    assert.equal(normalizeCollectionPolicy({share_mode,colleague_name:'   '}).colleague_name,'');
});

test('recipient limits count Unicode characters and reject control characters in all modes',()=>{
  const longest='𠮷'.repeat(40);
  assert.equal(normalizeCollectionPolicy({colleague_name:longest}).colleague_name,longest);
  for(const share_mode of ['none','qr','colleague','both']){
    assert.throws(()=>normalizeCollectionPolicy({share_mode,colleague_name:'𠮷'.repeat(41)}),/40/);
    for(const colleague_name of ['张\n女士','张\r女士','张\t女士','张\u0000女士','张\u007f女士','张\u0085女士',null,1])
      assert.throws(()=>normalizeCollectionPolicy({share_mode,colleague_name}),/收件人/);
  }
});

test('nonobjects, unknown fields and exotic instances are rejected',()=>{
  for(const input of [null,[],true,0,'',new Date(),new Map(),new (class Policy{})()])
    assert.throws(()=>normalizeCollectionPolicy(input),/采集规则必须/);
  for(const input of [{saveAbove:90},{send:true},{[Symbol('share')]:true},JSON.parse('{"__proto__":{}}')])
    assert.throws(()=>normalizeCollectionPolicy(input),/未知字段/);
});

test('plain records from another context and null prototypes can be normalized',()=>{
  assert.equal(normalizeCollectionPolicy(vm.runInNewContext('({save_above:66})')).save_above,66);
  const record=Object.create(null);record.share_mode='none';record.colleague_name='';
  assert.equal(normalizeCollectionPolicy(record).share_mode,'none');
});

test('fallback replaces the entire invalid policy instead of retaining an unsafe subset',()=>{
  for(const input of [null,{save_above:99,share_mode:'wrong'},{share_mode:'none',colleague_name:'\n'},
    {save_above:99,share_above:NaN},{share_mode:'colleague',colleague_name:''},{unexpected:true}]){
    assert.deepEqual(normalizeCollectionPolicy(input,{fallback:true}),DEFAULT_COLLECTION_POLICY);
  }
  assert.deepEqual(normalizeCollectionPolicy({share_mode:'none',colleague_name:''},{fallback:true}),
    {...DEFAULT_COLLECTION_POLICY,share_mode:'none',colleague_name:''});
});
