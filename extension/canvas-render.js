// Deliver already-requested page animation callbacks when background rendering
// stalls. The pinned reader drives bounded batches; no focus or visibility spoof.
(() => {
  if (location.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(location.hostname) ||
      !/^\/web\/frame\/c-resume\/?$/.test(location.pathname)) return;
  const armed = () => { try { return window.top.__hrmCanvasTextEnabled === true; } catch { return false; } };
  if (!armed()) return;
  if (window.__hrmCanvasRender?.version === 1) return;
  const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
  if (typeof request !== 'function' || typeof cancel !== 'function' || typeof window.performance?.now !== 'function') return;
  const pending = new Map();
  let stopped = false, pumping = false, nativeFrames = 0, pumpedFrames = 0, untrackedFrames = 0;
  const now = () => window.performance.now();
  const stats = () => ({pending:pending.size,nativeFrames,pumpedFrames,untrackedFrames,hidden:document.visibilityState === 'hidden'});
  function schedule(callback) {
    if (stopped || typeof callback !== 'function' || pending.size >= 4096) {
      if (!stopped && typeof callback === 'function') untrackedFrames++;
      return request.call(window,callback);
    }
    const entry = {id:null,callback,requested:now(),delivered:false};
    entry.id = request.call(window,timestamp => {
      if (entry.delivered) return;
      entry.delivered = true;
      pending.delete(entry.id);
      nativeFrames++;
      callback.call(window,timestamp);
    });
    pending.set(entry.id,entry);
    return entry.id;
  }
  function unschedule(id) {
    if (!arguments.length) return cancel.call(window);
    // cancelAnimationFrame uses Web IDL unsigned long conversion. Normalize
    // once so a string handle cancels the tracked callback as well as native RAF.
    const handle = +id >>> 0;
    const entry = pending.get(handle);
    if (entry) { entry.delivered = true; pending.delete(handle); }
    return cancel.call(window,handle);
  }
  window.requestAnimationFrame = schedule;
  window.cancelAnimationFrame = unschedule;
  const api = {
    version:1,
    pump(token) {
      const active = () => !stopped && armed() && typeof token === 'string' && token.length > 0 &&
        window.__hrmBackgroundRead?.token === token && window.__hrmBackgroundRead.canvas?.isConnected !== false;
      if (pumping || !active()) return stats();
      const timestamp = now();
      const batch = [...pending.values()].filter(entry => timestamp - entry.requested >= 180).slice(0,128);
      pumping = true;
      try {
        for (const entry of batch) {
          if (!active()) break;
          if (entry.delivered || pending.get(entry.id) !== entry) continue;
          entry.delivered = true;
          pending.delete(entry.id);
          cancel.call(window,entry.id);
          pumpedFrames++;
          try { entry.callback.call(window,timestamp); }
          catch (error) {
            // Match native RAF error delivery without preventing other callbacks.
            if (typeof window.reportError === 'function') window.reportError(error);
            else window.setTimeout(() => { throw error; },0);
          }
        }
      } finally { pumping = false; }
      return stats();
    },
    stop() {
      stopped = true;
      if (window.requestAnimationFrame === schedule) window.requestAnimationFrame = request;
      if (window.cancelAnimationFrame === unschedule) window.cancelAnimationFrame = cancel;
      // Native wrappers still own pending callbacks. Leave them scheduled so
      // stopping collection never drops page work or changes its native handles.
      pending.clear();
      if (window.__hrmCanvasRender === api) delete window.__hrmCanvasRender;
    }
  };
  window.__hrmCanvasRender = api;
})();
