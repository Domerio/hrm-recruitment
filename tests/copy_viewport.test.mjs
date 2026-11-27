import test from 'node:test';
import assert from 'node:assert/strict';
import {createCopyViewportController,sanitizeForegroundReadDiagnostic,saveForegroundReadDiagnostic} from '../extension/copy-viewport.mjs';

function fixture({state='normal',cancelAfterResize=false}={}){
  const tab={id:7,windowId:2,url:'https://www.zhipin.com/web/geek/recommend',active:true};
  const original={id:2,state,left:80,top:40,width:900,height:740},maximized={id:2,state:'maximized',left:0,top:0,width:1920,height:1040};
  let current={...original},stopped=false;
  const updates=[],browser={tabs:{get:async()=>({...tab})},windows:{get:async()=>({...current}),
    update:async(id,value)=>{assert.equal(id,2);updates.push({...value});
      current=value.state==='maximized'?{...maximized}:{...current,...value};
      if(cancelAfterResize&&value.state==='maximized')stopped=true;
      return {...current};}}};
  const controller=createCopyViewportController({browser,tab:{...tab},check:()=>{if(stopped)throw Error('stopped');}});
  return {controller,browser,tab,updates,original,get current(){return current;},change:value=>{current={...current,...value};}};
}

test('viewport recovery maximizes once and restores the exact original normal bounds once',async()=>{
  const f=fixture();assert.equal(await f.controller.fitViewport(),true);
  assert.equal(await f.controller.fitViewport(),false);assert.equal(f.updates.length,1);
  await Promise.all([f.controller.restore(),f.controller.restore()]);
  assert.deepEqual(f.updates,[{state:'maximized'},{state:'normal',left:80,top:40,width:900,height:740}]);
  assert.deepEqual(f.current,f.original);
});

test('viewport recovery never changes maximized, fullscreen or minimized windows',async()=>{
  for(const state of ['maximized','fullscreen','minimized']){
    const f=fixture({state});assert.equal(await f.controller.fitViewport(),false);
    await f.controller.restore();assert.equal(f.updates.length,0);
  }
});

test('viewport cleanup respects manual bounds changes, navigation and tab switches',async()=>{
  for(const change of [f=>f.change({width:1800}),f=>f.change({state:'normal'}),
    f=>{f.tab.url+='?navigated';},f=>{f.tab.active=false;},f=>{f.tab.windowId=3;}]){
    const f=fixture();await f.controller.fitViewport();change(f);
    await f.controller.restore();assert.equal(f.updates.length,1);
  }
});

test('a user move immediately after maximize is never adopted as our own window bounds',async()=>{
  const f=fixture();let reads=0;
  f.browser.windows.get=async()=>{if(++reads===2)f.change({width:1800});return {...f.current};};
  assert.equal(await f.controller.fitViewport(),false);
  await f.controller.restore();assert.deepEqual(f.updates,[{state:'maximized'}]);
  assert.equal(f.current.width,1800);
});

test('viewport changes are blocked if the bound tab changed before recovery',async()=>{
  const f=fixture();f.tab.url='https://www.zhipin.com/web/chat/index';
  await assert.rejects(f.controller.fitViewport(),/标签页已切换/);assert.equal(f.updates.length,0);
});

test('cancellation after resize still restores our own unchanged window without another maximize',async()=>{
  const f=fixture({cancelAfterResize:true});await assert.rejects(f.controller.fitViewport(),/stopped/);
  await f.controller.restore();assert.equal(f.updates.length,2);assert.equal(f.current.state,'normal');
});

test('unused viewport recovery performs no browser or window reads',async()=>{
  const c=createCopyViewportController({browser:{},tab:{}});await c.restore();
});

test('foreground diagnostics keep only finite geometric values and fixed enums',async()=>{
  const rect={left:-12,top:0,right:808,bottom:600,width:820,height:600};
  const value={reason:'width_clipped',clipLeft:12,clipRight:0,startHit:false,endHit:true,
    scrollTop:0,clientHeight:600,scrollHeight:1800,scrollMode:'native',canvasRect:rect,visibleRect:{...rect,left:0,width:808},
    marginProof:{left:true,right:false,resume:'private'},marginReason:{left:'uniform_opaque',right:'budget',secret:'private'},
    marginPixels:{left:24,right:1500000},resume:'private',name:'private',url:'https://private/',
    other:{nested:'private'}};
  const result=sanitizeForegroundReadDiagnostic(value);
  assert.equal(result.reason,'width_clipped');assert.equal(result.clipLeft,12);assert.equal(result.startHit,false);
  assert.deepEqual(result.marginProof,{left:true,right:false});assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(result.marginReason,{left:'uniform_opaque',right:'budget'});
  assert.deepEqual(sanitizeForegroundReadDiagnostic({reason:'width_clipped',marginReason:{left:'box_model',right:'private'}}).marginReason,{left:'box_model'});
  assert.deepEqual(result.marginPixels,{left:24,right:1500000});
  const invalid=sanitizeForegroundReadDiagnostic({...value,reason:'private',clipLeft:'12',clipRight:Infinity,
    scrollTop:1e20,scrollMode:'private',canvasRect:{...rect,width:'820'}});
  assert.equal(invalid.reason,'surface_missing');
  for(const key of ['clipLeft','clipRight','scrollTop','scrollMode','canvasRect'])assert.equal(Object.hasOwn(invalid,key),false);
  let stored;await saveForegroundReadDiagnostic({storage:{local:{set:async value=>{stored=value;}}}},value);
  assert.deepEqual(stored,{lastForegroundReadDiagnostic:result});
  await saveForegroundReadDiagnostic({storage:{local:{set:async()=>{throw Error('unavailable');}}}},value);
});
