import {isBoss} from './capture-utils.mjs';

const boundsKeys=['left','top','width','height'];
const validBounds=value=>value&&boundsKeys.every(key=>Number.isFinite(value[key]))&&value.width>0&&value.height>0;
const sameBounds=(left,right)=>left?.state===right?.state&&boundsKeys.every(key=>left?.[key]===right?.[key]);
const snapshot=value=>({state:value.state,...Object.fromEntries(boundsKeys.map(key=>[key,value[key]]))});

// One controller belongs to one collector run or one chat read. It never changes
// page zoom, moves a candidate, or retries a copy.
export function createCopyViewportController({browser,tab,check=()=>{}}){
  let attempted=false,original=null,applied=null,restoring=null;
  const sameTab=async()=>{
    const current=await browser.tabs.get(tab.id);
    return current?.id===tab.id&&current.windowId===tab.windowId&&current.url===tab.url&&
      current.active&&!current.discarded&&isBoss(current.url);
  };
  return {
    async fitViewport(){
      check();
      if(attempted||!browser.windows?.get||!browser.windows?.update)return false;
      attempted=true;
      if(!await sameTab())throw Error('BOSS 标签页已切换，未调整简历窗口。');
      const before=await browser.windows.get(tab.windowId);
      check();
      if(before?.state!=='normal'||!validBounds(before))return false;
      if(!await sameTab())throw Error('BOSS 标签页已切换，未调整简历窗口。');
      check();original=snapshot(before);
      const updated=await browser.windows.update(tab.windowId,{state:'maximized'});
      // Record the actual result before checking cancellation so finally can
      // undo our own successful resize even if the read has just stopped.
      if(updated?.state==='maximized'&&validBounds(updated))applied=snapshot(updated);
      const after=await browser.windows.get(tab.windowId);
      check();
      if(!await sameTab())throw Error('BOSS 标签页已切换，已停止简历读取。');
      // Never adopt a subsequent user move as our own maximize result.
      return Boolean(applied&&sameBounds(after,applied));
    },
    restore(){
      if(restoring)return restoring;
      if(!original||!applied)return Promise.resolve();
      restoring=(async()=>{
        // A user resize, monitor move, navigation or tab switch wins over our
        // cleanup. Only restore the unchanged window state that we set.
        if(!await sameTab())return;
        const current=await browser.windows.get(tab.windowId);
        if(!sameBounds(current,applied))return;
        await browser.windows.update(tab.windowId,{...original});
      })().catch(()=>{});
      return restoring;
    },
  };
}

const geometryReasons=new Set(['ok','surface_missing','focus_missing','scroll_metrics_invalid','end_hit_missing','width_clipped']);
const marginReasons=new Set(['not_needed','too_wide','transform','box_model','unavailable','budget','nonuniform','transparent','uniform_opaque']);
const safeNumber=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=10000000;
export function sanitizeForegroundReadDiagnostic(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const result={version:1,reason:geometryReasons.has(value.reason)?value.reason:'surface_missing'};
  for(const key of ['clipLeft','clipRight','scrollTop','clientHeight','scrollHeight'])
    if(safeNumber(value[key]))result[key]=value[key];
  for(const key of ['startHit','endHit'])if(typeof value[key]==='boolean')result[key]=value[key];
  if(['native','stationary'].includes(value.scrollMode))result.scrollMode=value.scrollMode;
  for(const key of ['canvasRect','visibleRect']){
    const rect=value[key];
    if(rect&&['left','top','right','bottom','width','height'].every(field=>safeNumber(rect[field])))
      result[key]=Object.fromEntries(['left','top','right','bottom','width','height'].map(field=>[field,rect[field]]));
  }
  if(value.marginProof&&typeof value.marginProof.left==='boolean'&&typeof value.marginProof.right==='boolean')
    result.marginProof={left:value.marginProof.left,right:value.marginProof.right};
  for(const key of ['marginReason','marginPixels']){
    const source=value[key],filtered={};
    for(const side of ['left','right']){
      const item=source?.[side];
      if(key==='marginReason'?marginReasons.has(item):Number.isSafeInteger(item)&&item>=0&&item<=1000000000)
        filtered[side]=item;
    }
    if(Object.keys(filtered).length)result[key]=filtered;
  }
  return result;
}

export async function saveForegroundReadDiagnostic(browser,value){
  const diagnostic=sanitizeForegroundReadDiagnostic(value);
  if(!diagnostic)return;
  try{await browser.storage?.local?.set({lastForegroundReadDiagnostic:diagnostic});}catch{}
}
