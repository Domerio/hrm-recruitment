import {detectPaymentSurface} from './payment-surface.mjs';

export const PAYMENT_STOP_MESSAGE='检测到 BOSS VIP 购买或扫码支付页面，本轮采集已自动停止。';

// Each monitor belongs to a single run and inspects only its original tab.
export function createPaymentMonitor({browser,tabId,onPayment,onError,intervalMs=600}){
  let timer,deadline,cancelRead,pending,ended=false,failure=null,started=false;
  const stoppedError=()=>Error('本轮采集已结束。');
  function stop(){
    ended=true;
    clearTimeout(timer);
    cancelRead?.(stoppedError());
  }
  async function probe(){
    try{
      const timeout=new Promise((_,reject)=>{
        cancelRead=reject;
        deadline=setTimeout(()=>reject(Error('检查 BOSS 购买页面超时，本轮采集已停止。')),12000);
      });
      const rows=await Promise.race([timeout,browser.scripting.executeScript({
        target:{tabId,frameIds:[0]},func:detectPaymentSurface
      })]);
      if(ended)throw stoppedError();
      if(rows?.length!==1||rows[0]?.frameId!==0||typeof rows[0].result!=='boolean')
        throw Error('无法核对当前 BOSS 页面的购买状态，本轮采集已停止。');
      if(rows[0].result)
        throw Object.assign(Error(PAYMENT_STOP_MESSAGE),{code:'payment-stop'});
    }catch(error){
      if(!ended){
        failure=error;
        clearTimeout(timer);
        if(error.code==='payment-stop')onPayment?.();
        else onError?.(error);
      }
      throw error;
    }finally{
      clearTimeout(deadline);
      cancelRead=null;
    }
  }
  function checkNow(){
    if(failure||ended)return Promise.reject(failure||stoppedError());
    if(!pending)pending=probe().finally(()=>{pending=null;});
    return pending;
  }
  function schedule(){
    if(ended||failure)return;
    timer=setTimeout(()=>checkNow().then(schedule,()=>{}),intervalMs);
  }
  return {checkNow,stop,get detected(){return failure?.code==='payment-stop';},
    async start(){
      if(started)throw Error('购买页面检查已启动。');
      started=true;
      await checkNow();
      schedule();
    }};
}
