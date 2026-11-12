import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSort, hasFilterValue } from '../frontend/candidate-table-data.mjs';
const result = (score, category='待确认', must_have_status='unknown') => [{ result:{score,category,must_have_status} }];
const rows = [
  {id:1,name:'甲',job_id:1,resume:'Python 图像算法',company:'示例科技',title:'算法工程师',city:'杭州',education:'本科·全日制',review:'未复核',phone:'1',created:'2026-11-11T15:59:59Z',history:result(0)},
  {id:2,name:'乙',job_id:2,resume:'C++ 开发',company:'示例设备',title:'软件工程师',city:'温州',education:'硕士·非全日制',review:'通过复核',email:'fixture@example.invalid',created:'2026-11-11T16:00:00Z',history:result(80,'推荐','met')},
  {id:3,name:'丙',job_id:1,resume:'Python 脚本',company:'其他科技',title:'开发',city:'上海',education:'本科',review:'未复核',created:'2026-11-12T16:00:00Z',history:[]},
  {id:4,name:'丁',job_id:1,resume:'OpenCV',company:'示例科技',title:'工程师',city:'杭州',education:'本科',review:'未复核',created:'2026-11-11T18:00:00Z',history:result(100,'推荐','met'),ai_pending:true},
];
const ids = filters => filterAndSort(rows,filters).map(row=>row.id);
test('column criteria combine with AND, searching keeps case-insensitive resume matching',()=>{
  assert.deepEqual(ids({search:'python',job:1,company:'示例',city:'杭州'}),[1]);
  assert.deepEqual(ids({title:'软件',education:'硕士',category:'推荐',mustHave:'met',review:'通过复核',contact:'email'}),[2]);
  assert.deepEqual(ids({company:'示例',city:'温州',job:1}),[]);
});
test('zero score bounds remain active and unscored or stale scores do not match',()=>{
  assert.equal(hasFilterValue(0),true);
  assert.deepEqual(ids({minScore:0,maxScore:0}),[1]);
  assert.deepEqual(ids({minScore:75}),[2]);
  assert.deepEqual(ids({ai:'pending'}),[4]);
  assert.deepEqual(ids({ai:'unevaluated'}),[3]);
});
test('date bounds use inclusive Beijing calendar days, excluding next day midnight',()=>{
  assert.deepEqual(ids({createdFrom:'2026-11-12',createdTo:'2026-11-12'}),[4,2]);
  assert.deepEqual(ids({createdTo:'2026-11-11'}),[1]);
  assert.deepEqual(ids({createdFrom:'bad'}),[]);
});
test('contact availability and multiple contact types preserve original semantics',()=>{
  assert.deepEqual(ids({contact:'available'}),[2,1]);
  assert.deepEqual(ids({contact:'missing'}),[3,4]);
  assert.deepEqual(ids({contact:'phone'}),[1]);
});
test('sorts scores with unscored rows last and leaves the source rows immutable',()=>{
  const before=structuredClone(rows);
  assert.deepEqual(filterAndSort(rows,{},'score-desc').map(row=>row.id),[2,1,4,3]);
  assert.deepEqual(rows,before);
});
