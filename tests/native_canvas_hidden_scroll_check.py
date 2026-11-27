"""Offline Chromium regression: suppressed rendering stalls native scroll events.

Uses one synthetic iframe and an isolated empty profile. No account, network,
focus change, visibility spoof, or real BOSS page is involved. The iframe keeps
layout via content-visibility:hidden; its document visibilityState stays visible.
This reproduces suppressed render-step delivery rather than claiming a live
background-tab end-to-end test. Run --check to fail on any regression.
"""
import argparse
import html
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


DEFAULT_BINARY = Path(os.environ.get('LOCALAPPDATA', '')) / (
    'ms-playwright/chromium_headless_shell-1228/'
    'chrome-headless-shell-win64/chrome-headless-shell.exe'
)

FRAME_JS = r"""
const allowedLocation={protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'};
new Function(GEOMETRY)();
new Function(GLYPHS)();
new Function('location',RENDER)(allowedLocation);
new Function('location',OBSERVER)(allowedLocation);
window.reader=new Function('location',READER+'; return backgroundResumeFrame;')(allowedLocation);
const scroller=document.getElementById('scroller')||document.scrollingElement,canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
window.observedOffset=0;window.paintedOffset=0;window.scrollEvents=[];window.renderCount=0;
window.virtualOffset=0;window.wheelEvents=[];window.windowScrolls=0;
window.addEventListener('scroll',()=>{window.windowScrolls++;});
const eventTarget=scroller===document.scrollingElement?document:scroller;
eventTarget.addEventListener('scroll',event=>{
  window.observedOffset=scroller.scrollTop+window.virtualOffset;
  window.scrollEvents.push({offset:scroller.scrollTop,trusted:event.isTrusted,target:event.target===eventTarget,bubbles:event.bubbles});
});
canvas.addEventListener('wheel',event=>{
  window.wheelEvents.push(event.deltaY);window.virtualOffset=Math.max(0,window.virtualOffset+event.deltaY);
  window.observedOffset=scroller.scrollTop+window.virtualOffset;
});
function draw(){
  window.paintedOffset=window.observedOffset;window.renderCount++;
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.font='18px Arial';ctx.fillStyle='#000';
  ctx.fillText('Synthetic resume observed offset '+window.observedOffset,30,80);
  requestAnimationFrame(draw);
}
draw();
window.state=()=>({visibility:document.visibilityState,top:scroller.scrollTop,
  observed:window.observedOffset,painted:window.paintedOffset,renders:window.renderCount,events:window.scrollEvents.slice(),
  wheels:window.wheelEvents.slice(),windowScrolls:window.windowScrolls});
"""

PROBE_JS = r"""
window.__hrmCanvasTextEnabled=true;
const cases=window.nativeCases=[],frame=document.createElement('iframe');
frame.style='width:800px;height:600px;border:0;content-visibility:hidden';
const loaded=new Promise(resolve=>frame.onload=resolve);frame.srcdoc=CHILD;document.body.prepend(frame);
await loaded;const w=frame.contentWindow,box=w.document.getElementById('scroller');
const wait=()=>new Promise(resolve=>setTimeout(resolve,250));
await wait();
const token='native-hidden-scroll';
const call=(action,args={})=>w.reader(action,{token,name:'Synthetic',...args});
call('prepare');
// Pumping the actual overdue RAF is insufficient when the queued native scroll
// event has not run. Geometry advances while the renderer's public event state
// and the recorded text stay at the previous position.
box.scrollTop=220;await wait();
let sample=call('sample'),state=w.state();
cases.push({name:'reproduces-native-scroll-stall-despite-raf-pump',state,text:sample.text,scheduler:sample.diagnostics?.scheduler,
  passed:state.top===220&&state.observed===0&&state.painted===0&&state.events.length===0&&
    sample.text.includes('offset 0')&&sample.diagnostics?.scheduler?.pumpedFrames>0});
// Production top/next/restore must notify the real owner and prove the resulting
// draw, rather than trusting the changed scrollTop alone.
call('top');await wait();call('sample');
let before=w.state();
const advance=call('next',{stepRatio:.5});await wait();sample=call('sample');state=w.state();
cases.push({name:'production-next-notifies-and-redraws-hidden-native-owner',state,text:sample.text,
  passed:state.top>0&&state.observed===state.top&&state.painted===state.top&&
    state.events.length===before.events.length+1&&state.events.at(-1).trusted===false&&
    state.events.at(-1).target===true&&state.events.at(-1).bubbles===false&&
    sample.text.includes('offset '+state.top)});
const positions=advance.geometry.scrollPositions.map(()=>0);
before=w.state();call('restore',{scrollPositions:positions});await wait();sample=call('sample');state=w.state();
cases.push({name:'production-restore-notifies-and-redraws-hidden-owner',state,text:sample.text,
  passed:state.top===0&&state.observed===0&&state.painted===0&&state.events.length===before.events.length+1&&sample.text.includes('offset 0')});
before=w.state();call('top');call('restore',{scrollPositions:positions});await wait();sample=call('sample');state=w.state();
cases.push({name:'unchanged-top-and-restore-do-not-notify',state,
  passed:state.events.length===before.events.length&&state.painted===0});
call('next',{stepRatio:.5});await wait();call('sample');before=w.state();
call('top');await wait();sample=call('sample');state=w.state();
cases.push({name:'production-top-notifies-and-redraws-hidden-owner',state,text:sample.text,
  passed:state.top===0&&state.observed===0&&state.painted===0&&state.events.length===before.events.length+1&&sample.text.includes('offset 0')});
call('cleanup');w.__hrmCanvasRender.stop();frame.remove();
// The viewport uses Document as the native scroll-event target; its bubbling
// event must reach a window listener; a later native event at the same offset
// is allowed and cannot advance the absolute-position renderer twice.
for(const variant of ['document','mixed']){
  const child=document.createElement('iframe');child.style=frame.style.cssText;
  // A skipped iframe is not hit-testable. The mixed wheel regression uses an
  // ordinary visible synthetic frame so the production hit guard stays intact.
  if(variant==='mixed')child.style.contentVisibility='visible';
  const loaded=new Promise(resolve=>child.onload=resolve);
  child.srcdoc=variant==='document'?DOCUMENT_CHILD:MIXED_CHILD;document.body.prepend(child);await loaded;await wait();
  const target=child.contentWindow,invoke=(action,args={})=>target.reader(action,{token:'native-'+variant,name:'Synthetic',...args});
  invoke('prepare');const oldState=target.state();
  const moved=invoke('next',{stepRatio:.5});await wait();const snap=invoke('sample'),newState=target.state();
  if(variant==='document'){
    cases.push({name:'document-scroll-notification-target-and-window-bubbling',state:newState,text:snap.text,
      passed:newState.top>0&&newState.observed===newState.top&&newState.painted===newState.top&&
        newState.events.filter(event=>!event.trusted).length===1&&newState.events.every(event=>event.target&&event.bubbles&&event.offset===newState.top)&&
        newState.windowScrolls===newState.events.length&&
        newState.wheels.length===0&&snap.text.includes('offset '+newState.top)});
  }else{
    cases.push({name:'small-native-range-uses-only-unconsumed-wheel-step',state:newState,text:snap.text,geometry:moved.geometry,
      passed:newState.top===8&&newState.observed===250&&newState.painted===250&&newState.wheels.length===1&&
        newState.wheels[0]===242&&newState.events.filter(event=>!event.trusted).length===1&&newState.windowScrolls===0&&
        moved.geometry.virtualScroll===true&&snap.text.includes('offset 250')});
    invoke('top');await wait();const restored=invoke('sample'),restoredState=target.state();
    cases.push({name:'mixed-top-resets-native-and-virtual-offset',state:restoredState,text:restored.text,
      passed:restoredState.top===0&&restoredState.observed===0&&restoredState.painted===0&&
        restoredState.wheels.at(-1)===-100000&&restored.text.includes('offset 0')});
  }
  invoke('cleanup');target.__hrmCanvasRender.stop();child.remove();
}
// A canvas renderer may route wheel input through its last hover location.
// Native outer movement alone then changes geometry without advancing its
// original strings. Keep this separate from native absolute-position fixtures.
for(const disabled of [false,true]){
  const child=document.createElement('iframe');
  child.style='width:800px;height:1000px;border:0';
  const loaded=new Promise(resolve=>child.onload=resolve);child.srcdoc=POINTER_CHILD;
  document.body.prepend(child);await loaded;await wait();
  const target=child.contentWindow,canvas=target.document.querySelector('canvas');
  target.wheelDisabled=disabled;
  const invoke=(action,args={})=>target.reader(action,{token:'pointer-'+disabled,name:'Synthetic',...args});
  invoke('prepare');const original=invoke('sample'),oldState=target.state();
  // This old wheel-only input reaches the listener but has no hover target.
  const rect=canvas.getBoundingClientRect();
  canvas.dispatchEvent(new target.WheelEvent('wheel',{bubbles:true,cancelable:true,composed:true,
    deltaMode:0,deltaY:81.6,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));
  await wait();const unlocated=invoke('sample'),unlocatedState=target.state();
  cases.push({name:'wheel-without-pointer-cannot-advance-canvas-'+disabled,state:unlocatedState,text:unlocated.text,
    passed:unlocated.text===original.text&&unlocatedState.observed===0&&unlocatedState.painted===0&&
      unlocatedState.acceptedWheels===0&&unlocatedState.rejectedWheels===1});
  const moved=invoke('next',{stepRatio:.1});await wait();const snap=invoke('sample'),newState=target.state();
  const hover=newState.pointerEvents,near=(a,b)=>Math.abs(a-b)<.00001;
  const positioned=hover.length===4&&hover.every(event=>event.target&&event.composed&&event.buttons===0&&
    near(event.x,hover[0].x)&&near(event.y,hover[0].y))&&
    ['pointerover','pointermove','mouseover','mousemove'].every((type,index)=>hover[index].type===type);
  const geometryCorrect=moved.geometry.clientHeight===956&&moved.geometry.scrollTop===14&&
    moved.geometry.scrollHeight===970&&newState.wheels.length===2&&near(newState.wheels.at(-1),81.6)&&
    near(snap.diagnostics?.motion?.requestedPixels,95.6)&&near(snap.diagnostics?.motion?.nativePixels,14)&&
    near(snap.diagnostics?.motion?.wheelPixels,81.6);
  cases.push({name:disabled?'unresponsive-positioned-canvas-keeps-original-text':'positioned-wheel-advances-after-14px-native-overflow',
    state:newState,text:snap.text,originalText:original.text,geometry:moved.geometry,motion:snap.diagnostics?.motion,
    passed:geometryCorrect&&positioned&&newState.activationEvents.length===0&&
      (disabled?newState.acceptedWheels===0&&newState.rejectedWheels===2&&snap.text===original.text&&newState.observed===0:
        newState.acceptedWheels===1&&newState.rejectedWheels===1&&near(newState.observed,81.6)&&
        near(newState.painted,81.6)&&snap.text!==original.text&&snap.text.includes('offset '+newState.observed))});
  if(!disabled){
    invoke('top');await wait();const restored=invoke('sample'),restoredState=target.state();
    cases.push({name:'positioned-top-resets-native-and-canvas-offset-without-activation',state:restoredState,text:restored.text,
      passed:restoredState.top===0&&restoredState.observed===0&&restoredState.painted===0&&
        restoredState.acceptedWheels===2&&restoredState.wheels.at(-1)===-100000&&
        restoredState.activationEvents.length===0&&restored.text===original.text});
  }
  invoke('cleanup');target.__hrmCanvasRender.stop();child.remove();
}

document.getElementById('result').textContent=JSON.stringify({cases,passed:cases.every(item=>item.passed)});
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', type=Path, default=DEFAULT_BINARY)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if not args.browser.is_file():
        parser.error('Existing offline Chromium binary unavailable')
    root = Path(__file__).resolve().parents[1]
    directory = Path(tempfile.mkdtemp(prefix='hrm-native-hidden-scroll-'))
    js = lambda value: json.dumps(value, ensure_ascii=True).replace('</', '<\\/')
    reader = (root / 'extension/background-read.mjs').read_text(encoding='utf-8')
    reader = reader[reader.index('export function backgroundResumeFrame'):reader.index('\nconst rawText=')].replace('export function ', 'function ', 1)
    sources = {'GEOMETRY':'canvas-geometry.js','GLYPHS':'canvas-glyphs.js',
               'RENDER':'canvas-render.js','OBSERVER':'canvas-text.js'}
    frame_script = '\n'.join('const '+key+'='+js((root/'extension'/name).read_text(encoding='utf-8'))+';' for key,name in sources.items())
    frame_script += '\nconst READER='+js(reader)+';\n'+FRAME_JS
    child = ("<!doctype html><meta charset='utf-8'><style>html,body{margin:0;padding:0}"
             "#scroller{width:773px;height:500px;overflow:auto}#sheet{height:2200px}"
             "canvas{position:sticky;top:0;display:block;width:750px;height:500px}</style>"
             "<div id='scroller'><div id='sheet'><canvas width='750' height='500'></canvas></div></div>"
             '<script>'+frame_script+'</script>')
    document_child = ("<!doctype html><meta charset='utf-8'><style>html,body{margin:0;padding:0}"
                      "body{height:2200px}canvas{position:sticky;top:0;display:block;width:750px;height:500px}</style>"
                      "<canvas width='750' height='500'></canvas><script>"+frame_script+'</script>')
    mixed_child = child.replace('#sheet{height:2200px}', '#sheet{height:508px}')
    pointer_frame_script = frame_script.replace(
        'window.observedOffset=scroller.scrollTop+window.virtualOffset;',
        'window.observedOffset=window.virtualOffset;')
    old_wheel = """canvas.addEventListener('wheel',event=>{
  window.wheelEvents.push(event.deltaY);window.virtualOffset=Math.max(0,window.virtualOffset+event.deltaY);
  window.observedOffset=window.virtualOffset;
});"""
    pointer_wheel = """window.pointerEvents=[];window.activationEvents=[];
window.acceptedWheels=0;window.rejectedWheels=0;window.wheelDisabled=false;
let lastPointer=null,lastMouse=null;
for(const type of ['pointerover','pointermove','mouseover','mousemove'])canvas.addEventListener(type,event=>{
  window.pointerEvents.push({type,target:event.target===canvas,composed:event.composed,
    buttons:event.buttons,x:event.clientX,y:event.clientY});
  if(type==='pointermove')lastPointer=event;
  if(type==='mousemove')lastMouse=event;
});
for(const type of ['pointerdown','pointerup','mousedown','mouseup','click','focus','focusin'])
  canvas.addEventListener(type,event=>window.activationEvents.push(event.type));
canvas.addEventListener('wheel',event=>{
  window.wheelEvents.push(event.deltaY);
  const positioned=[lastPointer,lastMouse].every(hover=>hover&&hover.target===canvas&&
    hover.clientX===event.clientX&&hover.clientY===event.clientY&&hover.buttons===0);
  if(!positioned||window.wheelDisabled){window.rejectedWheels++;return;}
  window.acceptedWheels++;event.preventDefault();
  window.virtualOffset=Math.max(0,window.virtualOffset+event.deltaY);
  window.observedOffset=window.virtualOffset;
});"""
    assert old_wheel in pointer_frame_script
    pointer_frame_script = pointer_frame_script.replace(old_wheel, pointer_wheel, 1)
    pointer_frame_script = pointer_frame_script.replace(
        'wheels:window.wheelEvents.slice(),windowScrolls:window.windowScrolls',
        'wheels:window.wheelEvents.slice(),windowScrolls:window.windowScrolls,'
        'pointerEvents:window.pointerEvents.slice(),activationEvents:window.activationEvents.slice(),'
        'acceptedWheels:window.acceptedWheels,rejectedWheels:window.rejectedWheels')
    pointer_child = ("<!doctype html><meta charset='utf-8'><style>html,body{margin:0;padding:0}"
                     "#scroller{width:773px;height:956px;overflow:auto}#sheet{height:970px}"
                     "canvas{position:sticky;top:0;display:block;width:750px;height:956px}</style>"
                     "<div id='scroller'><div id='sheet'><canvas width='750' height='956'></canvas></div></div>"
                     '<script>'+pointer_frame_script+'</script>')
    script = ('const CHILD='+js(child)+';\nconst DOCUMENT_CHILD='+js(document_child)+';\nconst MIXED_CHILD='+js(mixed_child)+';\nconst POINTER_CHILD='+js(pointer_child)
              +';\n(async()=>{'+PROBE_JS+'})().catch(error=>{document.getElementById("result").textContent=JSON.stringify({error:String(error),stack:error.stack,cases:window.nativeCases})});')
    page = directory/'probe.html'
    page.write_text('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}</style><body><pre id="result">pending</pre><script>'+script+'</script>',encoding='utf-8')
    command=[str(args.browser),'--headless','--dump-dom','--disable-gpu','--disable-extensions',
             '--disable-background-networking','--disable-component-update','--disable-sync',
             '--no-first-run','--no-default-browser-check','--no-pings','--host-resolver-rules=MAP * ~NOTFOUND',
             '--window-size=1200,1100','--virtual-time-budget=8000',f'--user-data-dir={directory/"empty-profile"}',page.as_uri()]
    completed=subprocess.run(command,capture_output=True,encoding='utf-8',errors='replace',timeout=30,
                             creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    (directory/'dump.html').write_text(completed.stdout,encoding='utf-8')
    (directory/'stderr.log').write_text(completed.stderr,encoding='utf-8')
    match=re.search(r'<pre id="result">(.*?)</pre>',completed.stdout,re.DOTALL)
    evidence=json.loads(html.unescape(match.group(1))) if match else {'error':'No result'}
    (directory/'result.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'artifacts':str(directory),**evidence},ensure_ascii=True))
    if 'error' in evidence or args.check and not evidence.get('passed'):
        raise SystemExit(1)


if __name__=='__main__':
    main()
