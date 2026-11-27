import test from 'node:test';
import assert from 'node:assert/strict';
import {safeCatalog,profileFormValues,isProfileDirty,profilePayload,validProfileUrl,
  profileEndpoint,kindLabel} from '../frontend/ai-profile-helpers.mjs';

const text = {id:'current',name:'现有评估模型',kind:'text',provider:'openai-compatible',
  base_url:'http://127.0.0.1:8000/v1',model:'private-text-model',docs_url:'',has_key:true};
const ocr = {id:'ocr',name:'图片识别',kind:'ocr',provider:'paddleocr',base_url:'http://127.0.0.1:8001',
  model:'ocr-model',docs_url:'http://127.0.0.1:8001/docs',has_key:false};
const catalog = () => ({revision:7,active_profile_id:'current',profiles:[{...text},{...ocr}]});

test('catalog keeps edit choices and active text model but drops secrets and arbitrary response fields',()=>{
  const input = catalog();
  input.profiles[0].api_key = 'fixture-secret';
  input.profiles[0].debug = 'fixture-private-debug';
  input.api_key = 'other-fixture-secret';
  const result = safeCatalog(input);
  assert.deepEqual(result,catalog());
  assert.doesNotMatch(JSON.stringify(result),/fixture-secret|fixture-private|other-fixture/);
  assert.equal(kindLabel(result.profiles[1].kind),'图片文字识别（OCR）');
});

test('catalog rejects duplicate selections, absent active model and OCR used as text evaluation',()=>{
  for (const alter of [value => value.profiles.push({...text}),value => value.active_profile_id='missing',
    value => value.active_profile_id='ocr',value => value.revision=-1,value => value.profiles[0].kind='unknown']) {
    const value = catalog(); alter(value);
    assert.throws(()=>safeCatalog(value));
  }
});

test('selecting another profile creates an empty credential draft even if response includes an API key',()=>{
  const first = profileFormValues({...text,api_key:'first-secret'});
  first.api_key = 'user-entered-secret'; first.clear_key = true;
  const second = profileFormValues({...ocr,api_key:'response-secret'});
  assert.equal(second.api_key,'');
  assert.equal(second.clear_key,false);
  assert.equal(second.base_url,ocr.base_url);
  assert.doesNotMatch(JSON.stringify(second),/secret/);
  assert.equal(isProfileDirty(second,ocr),false);
});

test('edit tracking includes names, documents, kind and explicit credential deletion',()=>{
  const base = profileFormValues(text);
  assert.equal(isProfileDirty(base,text),false);
  for (const patch of [{name:'changed name'},{docs_url:'http://127.0.0.1/docs'},{kind:'asr'},
    {provider:'deepseek'},{model:'new-model'},{base_url:'http://127.0.0.1:9000/v1'},
    {api_key:'new-key'},{clear_key:true}]) assert.equal(isProfileDirty({...base,...patch},text),true);
  assert.equal(isProfileDirty({...base,base_url:text.base_url+'/'},text),false);
});

test('payload trims fields without sending empty secrets and cannot leak stored profile-only state',()=>{
  const values = {...profileFormValues(text),name:'  文字模型  ',base_url:text.base_url+'/',
    model:'  custom-model  ',has_key:true,id:'current',revision:8};
  const result = profilePayload(values);
  assert.equal(result.name,'文字模型');
  assert.equal(result.model,'custom-model');
  assert.equal(result.base_url,text.base_url);
  assert.equal('api_key' in result,false);
  assert.equal('has_key' in result,false);
  assert.equal('revision' in result,false);
  assert.equal(profilePayload({...values,clear_key:true}).clear_key,true);
  assert.equal(profilePayload({...values,api_key:' new-key '}).api_key,'new-key');
});

test('endpoint identity differentiates service type and provider as well as address',()=>{
  assert.equal(profileEndpoint(text),profileEndpoint({...text,base_url:text.base_url+'/'}));
  for (const patch of [{kind:'asr'},{provider:'deepseek'},{base_url:'http://127.0.0.1:9000/v1'}])
    assert.notEqual(profileEndpoint(text),profileEndpoint({...text,...patch}));
});

test('document links require HTTP without embedded credentials or executable URL schemes',()=>{
  for (const bad of ['javascript:alert(1)','file:///tmp/file','https://user:secret@example.invalid/docs',
    'https://example.invalid/docs?api_key=secret','https://example.invalid/#token',
    'http://example.invalid/space here','https://example.invalid/\\path']) {
    assert.equal(validProfileUrl(bad,true),false,bad);
    const value = catalog(); value.profiles[1].docs_url=bad;
    assert.throws(()=>safeCatalog(value),bad);
  }
  assert.equal(validProfileUrl('',true),true);
  assert.equal(validProfileUrl(''),false);
  assert.equal(validProfileUrl('http://10.177.137.55:9031/docs'),true);
});
