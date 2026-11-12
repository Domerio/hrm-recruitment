import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseFrame} from '../extension/frames.mjs';

const frame=(frameId,key,options={})=>({frameId,documentId:`doc-${frameId}`,
  result:{key,visible:true,textLength:500,childCount:0,...options}});
const outer=frame(0,'https://www.zhipin.com/web/chat/search',{childCount:1,textLength:900});
const inner=frame(7,'https://www.zhipin.com/web/frame/candidates');

test('picks candidate iframe instead of the longer outer navigation page',()=>{
  assert.equal(chooseFrame([outer,inner]),inner);
});
test('prefers deepest content, excluding empty and hidden frames',()=>{
  const hidden=frame(8,'hidden',{visible:false,textLength:5000});
  const empty=frame(9,'empty',{textLength:0});
  const container=frame(10,'container',{childCount:1,textLength:2000});
  assert.equal(chooseFrame([outer,hidden,container,empty,inner]),inner);
});
test('keeps the explicitly selected document among frames with the same URL',()=>{
  const duplicate={...inner,frameId:11,documentId:'doc-11'};
  assert.equal(chooseFrame([outer,inner,duplicate],inner.result.key,'doc-11'),duplicate);
  assert.equal(chooseFrame([outer,inner,duplicate],inner.result.key),null);
});
test('finds a reloaded frame by saved path; does not silently switch if missing',()=>{
  assert.equal(chooseFrame([outer,inner],inner.result.key,'old-document'),inner);
  assert.equal(chooseFrame([outer],inner.result.key,'old-document'),null);
});
test('supports ordinary non-iframe pages and rejects inaccessible frame results',()=>{
  assert.equal(chooseFrame([outer,{frameId:4,result:null}]),outer);
  assert.equal(chooseFrame([]),null);
});
