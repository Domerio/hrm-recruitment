"""Offline native Canvas integration for the observed experience-information hint.

Uses the existing Chromium headless-shell CLI with a temporary empty profile,
no login, no network and no debugging connection. The fixed public PNG fixture
is embedded; every candidate name, job and paragraph is synthetic.
Run with --check for a failing exit code on a regression.
"""

import argparse
import html
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

DEFAULT_BINARY = Path(os.environ.get("LOCALAPPDATA", "")) / (
    "ms-playwright/chromium_headless_shell-1228/"
    "chrome-headless-shell-win64/chrome-headless-shell.exe"
)

# https://img.bosszhipin.com/static/zhipin/recommend-wasm/958791963567135086.png
# Decoded RGBA SHA-256: 8fb554f0120d7eca61bc9dbd2b0deb656873648e650c3d5b8910e7444c599766
ICON_PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADw0lEQVR4AdRXPVYbMRD+JkXahBuYEwROENPETgcnwD4BocMVTmV38Q1sTgBdbBo7J4CcAG4QUqbJ5JvRyvL+YvLg5UVvNZJGo5lPo5ld7Sv84/J/AdCzblvPOhMddG5Yf7CvXgcd9rtL9icm8xSnbuUBKu1R+R2gSyo/gWKP9S1iUbCvbQAnJmOytobjR59GAFTS4k5vqHRKTS3W8AgeILgFMGN7BWDF9gGpUFanGRD200SxVwuAxnsQvYHt1lYFoxNADmS02GHdl/Giz/aIrfNsDgaKJHtapkMHHw6zcampBBAW6JTG6Vpfs4LKPo2dyni+ck4FsTkhKEB26ZErWLHjUbn0Ddm4UEsAKNgCxFyOUHRIpQcynt+H8ePUZAn2iEc3XEuLfgm61xzvlABw0RKG2qfN+PVn7/4FkbGt1QDCdIpeFtXkABBhjwL0AKngKihAbaH80GqtACcyHSt2uTfsUd5s+NBIDgCg58b0qnLqbQ3RwUcGlsnreVFpeYn0GRNZltiaJLEGQCWWx2H3wMzOEU1FNQZok5TPuS7FhQ+AVmbLh2sAgB46x4lEYR89D5GQFa4s2doAIO98jvlOxOHMnPE8xHVSt2sTvPeWJAEQ3eOYjoC94fBCJaZyPGokAJYmZjWitP5zV5WwuWiL+hMADvxR+entixDdKapNAOLORUMsFCWbxvI7S7EmIZuTN0YRbXGQAACl80FDYVDNGDB8y+lQRtcbEd60SEtxlgAovvlSns9mnjqvhthbzmrNdI7tOqk7Y37P2o0ghGzsQjfeCVE031IhXyidO//mD9tv87OVo+PETbbWHqBLLffDMQiOzUBaUNETMXdaOrXw63W7QmLNCro0fgPuM1s+vwbgI0j48rmrdBp41VRGX+kx3S4G+ClOWjIbGSMHgMhmCFctm+YFtEsD1q2udv5Wq2cDl7sfQhGP1HY/w0bJAXC+yhFBZGnlX7pGEL6mhrjx+IX11JODomgJAL3AOJBPSZAgBh27Utl5J3ZDj4YZoN0l0/Q8iWk/6E4c65UAGFNG8wteJpMn3IXKiO/OqLw24GyOWTHhWrtJBznbuWiv7l1RCSCA4MuFF1H26RFSf5SppEuNPyLBM1OO/UcF6b8hpKXFE3XQ+IUvryC1AEzWXCbjxS4gfQAJSMiSdggu7bHN/6i4rNiVnVf35stsIwBkRcZz3pAcyAEDdEL2im0WqBy5m3FLHueEN+jFrq3BFmUrAFEPla5ktOC/wcJ/RGS8EK/xR8Xn5qsov037JADbKCzKPDb+AwAA//8LaZCGAAAABklEQVQDACEtjVB7P8F0AAAAAElFTkSuQmCC"

PROBE_JS = r"""
const canvas=document.getElementById('resume'),ctx=canvas.getContext('2d');
const icon=new Image();icon.src='data:image/png;base64,'+ICON_PNG;await icon.decode();
const changedIcon=new OffscreenCanvas(32,32),changedContext=changedIcon.getContext('2d');
changedContext.drawImage(icon,0,0);changedContext.fillStyle='#00f';changedContext.fillRect(15,15,1,1);
const expectedName='王**',warning='最近一份工作经历可能未更新',button='询问Ta';
const defaultBody='算法系统正文必须完整保留。',date='2019.05 - 2025.08';
const cases=[];let sequence=0;
new Function(ASSETS_SOURCE)();
function brief(snapshot){
  return {issue:snapshot.issue,issueCode:snapshot.issueCode||'',text:snapshot.text,
    hintMarks:snapshot.hintMarks||[],platformNotes:snapshot.platformNotes||[],
    details:snapshot.diagnostics?.details||[],reasonCounts:snapshot.diagnostics?.reasonCounts||[]};
}
function setup({scale=1,cache=false}={}){
  window.__hrmCanvasText?.stop();
  canvas.width=Math.ceil(773*scale);canvas.height=Math.ceil(956*scale);
  window.__hrmCanvasTextEnabled=true;
  new Function(GEOMETRY_SOURCE)();
  new Function('location',OBSERVER_SOURCE)({protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'});
  const api=window.__hrmCanvasText;
  window.__hrmBackgroundRead={token:'native-hint-'+(++sequence),canvas,expectedName};
  const target=cache?document.createElement('canvas'):canvas;
  target.width=canvas.width;target.height=canvas.height;
  const paint=target.getContext('2d');
  function render({expanded=false,warningText=warning,buttonText=button,extra='',body=defaultBody,
    dates=date,name=expectedName,image=icon,iconX,iconY=246,duplicate=false,clip=false}={}){
    paint.setTransform(1,0,0,1,0,0);paint.clearRect(0,0,target.width,target.height);
    paint.fillStyle='#ffffff';paint.fillRect(0,0,target.width,target.height);
    paint.setTransform(scale,0,0,scale,0,0);paint.fillStyle='#222222';paint.textBaseline='alphabetic';
    paint.textAlign='left';paint.direction='ltr';paint.font='22px "Microsoft YaHei", sans-serif';
    paint.fillText(name,132,50);
    paint.font='14px "Microsoft YaHei", sans-serif';paint.fillText('33岁 10年 本科',132,80);
    paint.fillText('期望职位',44,212);paint.fillText('杭州 视觉工程师 20-30K',132,212);
    paint.fillText('工作经历',44,280);paint.fillText('示例科技有限公司 图像算法工程师',132,280);
    const dateX=723-paint.measureText(dates).actualBoundingBoxRight;
    paint.fillText(dates,dateX,280);paint.fillText(body,132,320);
    let x=iconX??707;
    if(expanded){
      paint.font='12px "Microsoft YaHei", sans-serif';
      const words=warningText+buttonText+extra;
      const width=paint.measureText(words).actualBoundingBoxRight+34,left=727-width;
      paint.fillStyle='#fff4ef';paint.beginPath();paint.roundRect(left,242,width,24,10);paint.fill();
      paint.fillStyle='#ff7847';paint.fillText(words,left+26,258);x=iconX??left+4;
    }
    if(clip){paint.save();paint.beginPath();paint.rect(x,iconY,10,16);paint.clip();}
    paint.drawImage(image,x,iconY,16,16);
    if(clip)paint.restore();
    if(duplicate)paint.drawImage(image,x-24,iconY,16,16);
    if(cache){ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(target,0,0);}
  }
  return {render,api,snapshot:()=>api.snapshot({expectedName}),
    hint:(action,mark)=>api.hint(action,{expectedName,...(mark?{mark}:{})})};
}
function readEpisode(options={}){
  const f=setup(options);f.render();const initial=f.snapshot();
  const begin=f.hint('begin',initial.hintMarks?.[0]);f.render({expanded:true});
  const probe=f.hint('probe'),during=f.snapshot();f.render();const finish=f.hint('finish'),final=f.snapshot();
  cases.push({name:'complete-hover-restore'+(options.cache?'-cached':'')+'-scale-'+(options.scale||1),
    passed:initial.issueCode==='unsupported'&&initial.hintMarks?.length===1&&begin.ok===true&&probe.ready===true&&
      during.issueCode==='unsupported'&&finish.ok===true&&!final.issue&&final.text.includes(defaultBody)&&
      !final.text.includes(warning)&&!final.text.includes(button)&&final.platformNotes?.length===1&&
      final.platformNotes[0].text===warning&&final.platformNotes[0].anchor.includes('示例科技有限公司')&&
      final.platformNotes[0].anchor.includes(date),
    initial:brief(initial),begin,probe,during:brief(during),finish,final:brief(final)});
}
readEpisode();readEpisode({scale:1.5});readEpisode({cache:true});
for(const body of [defaultBody,warning]){
  const f=setup();f.render({expanded:true,body});const snapshot=f.snapshot();
  cases.push({name:body===warning?'same-sentence-in-body-retained':'manually-open-tooltip',
    passed:!snapshot.issue&&snapshot.text.includes(body)&&!snapshot.text.includes(button)&&snapshot.platformNotes?.length===1&&
      snapshot.platformNotes[0].text===warning,snapshot:brief(snapshot)});
}
for(const [name,options] of [
  ['missing-warning-letter',{warningText:warning.slice(1)}],
  ['extra-warning-text',{extra:'额外提示'}],
  ['wrong-button-label',{buttonText:'已询问'}],
  ['clipped-icon',{clip:true}],
]){
  const f=setup();f.render();const initial=f.snapshot(),begin=f.hint('begin',initial.hintMarks?.[0]);
  f.render({expanded:true,...options});const probe=f.hint('probe'),during=f.snapshot();
  f.render();const finish=f.hint('finish'),after=f.snapshot();
  cases.push({name,passed:begin.ok===true&&probe.ready===false&&during.issueCode==='unsupported'&&
    finish.ok===false&&after.issueCode==='unsupported'&&!after.platformNotes?.length,
    begin,probe,finish,during:brief(during),after:brief(after)});
}
for(const [name,options] of [
  ['changed-asset-pixels',{image:changedIcon}],['asset-in-body',{iconX:400,iconY:350}],
  ['duplicate-icons',{duplicate:true}],['missing-work-dates',{dates:'时间不明'}],['wrong-candidate',{name:'李**'}],
]){
  const f=setup();f.render(options);const snapshot=f.snapshot();
  const begin=f.hint('begin',snapshot.hintMarks?.[0]);
  cases.push({name,passed:snapshot.issueCode==='unsupported'&&!snapshot.hintMarks?.length&&begin.ok===false,
    begin,snapshot:brief(snapshot)});
}
for(const [name,options] of [
  ['restored-body-changed',{body:'正文发生变化，不得复用旧提示证明。'}],
  ['restored-dates-changed',{dates:'2018.05 - 2025.08'}],['restored-icon-moved',{iconX:706}],
]){
  const f=setup();f.render();const initial=f.snapshot(),begin=f.hint('begin',initial.hintMarks?.[0]);
  f.render({expanded:true});const probe=f.hint('probe');f.render(options);
  const finish=f.hint('finish'),snapshot=f.snapshot();
  cases.push({name,passed:begin.ok===true&&probe.ready===true&&finish.ok===false&&
    snapshot.issueCode==='unsupported'&&!snapshot.platformNotes?.length,
    begin,probe,finish,snapshot:brief(snapshot)});
}
// Drive the actual frame adapter with real DOM PointerEvent dispatch. This
// synthetic page intentionally reacts only to pointermove, like the public
// WASM listener registration; mouseout/leave cannot hide its tooltip.
{
  const f=setup();f.render();
  const token=window.__hrmBackgroundRead.token,events=[];
  const eventNames=['pointerover','pointermove','pointerout','pointerleave','mouseover','mousemove','mouseout','mouseleave',
    'pointerdown','pointerup','mousedown','mouseup','click'];
  const record=event=>events.push({type:event.type,x:event.clientX,y:event.clientY,
    pointerType:event.pointerType||'',buttons:event.buttons,isTrusted:event.isTrusted});
  for(const name of eventNames)canvas.addEventListener(name,record);
  const pointerMove=event=>{
    const box=canvas.getBoundingClientRect(),x=(event.clientX-box.left)*canvas.width/box.width,
      y=(event.clientY-box.top)*canvas.height/box.height;
    f.render({expanded:x>=707&&x<=723&&y>=246&&y<=262});
  };
  canvas.addEventListener('pointermove',pointerMove);
  const frame=new Function('location',FRAME_SOURCE+'; return backgroundResumeFrame;')(
    {protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'});
  let prepared,hover,probe,leave,finish,error='';
  try{
    prepared=frame('prepare',{token,name:expectedName});
    hover=frame('hint-hover',{token,mark:prepared.hintMarks?.[0]});
    probe=frame('hint-probe',{token});
    leave=frame('hint-leave',{token});
    finish=frame('hint-finish',{token});
  }catch(caught){error=String(caught);}
  finally{
    canvas.removeEventListener('pointermove',pointerMove);
    for(const name of eventNames)canvas.removeEventListener(name,record);
    try{frame('cleanup',{token});}catch{}
  }
  const moves=events.filter(event=>event.type==='pointermove'),sample=finish?.sample;
  cases.push({name:'actual-frame-pointermove-only-hover-and-blank-restoration',error,events,
    passed:!error&&prepared?.hintMarks?.length===1&&hover?.ok===true&&probe?.ready===true&&
      leave?.ok===true&&finish?.ok===true&&!sample?.issue&&sample.text===cases[0].final.text&&
      sample.platformNotes?.length===1&&sample.platformNotes[0].text===warning&&
      moves.length===2&&moves.every(event=>event.pointerType==='mouse'&&event.buttons===0&&!event.isTrusted)&&
      Math.hypot(moves[0].x-moves[1].x,moves[0].y-moves[1].y)>1&&
      !events.some(event=>/down|up|click/.test(event.type)),
    prepared:prepared?brief(prepared):null,hover,probe,leave,finish:sample?brief(sample):finish});
}
window.__hrmCanvasText?.stop();delete window.__hrmBackgroundRead;
const result={userAgent:navigator.userAgent,fonts:{yahei:document.fonts.check('14px "Microsoft YaHei"')},cases};
document.getElementById('native-result').textContent=JSON.stringify(result).replace(/[\u007f-\uffff]/g,
  value=>'\\u'+value.charCodeAt(0).toString(16).padStart(4,'0'));
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", type=Path, default=DEFAULT_BINARY)
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not args.browser.is_file():
        parser.error(f"Existing headless-shell binary not found: {args.browser}")
    root = Path(__file__).resolve().parents[1]
    directory = Path(tempfile.mkdtemp(prefix="hrm-native-canvas-hints-"))
    profile = directory / "empty-profile"
    profile.mkdir()
    js_string = lambda value: json.dumps(value, ensure_ascii=True).replace("</", "<\\/")
    scripts = {
        "ASSETS_SOURCE": "canvas-platform-assets.js",
        "GEOMETRY_SOURCE": "canvas-geometry.js",
        "OBSERVER_SOURCE": "canvas-text.js",
    }
    script = "const ICON_PNG=" + js_string(ICON_PNG) + ";\n"
    script += "\n".join("const " + name + "=" + js_string((root / "extension" / file).read_text(encoding="utf-8")) + ";"
                        for name, file in scripts.items())
    reader = (root / "extension/background-read.mjs").read_text(encoding="utf-8")
    frame_start = reader.index("export function backgroundResumeFrame(")
    frame_end = reader.index("\nconst rawText=", frame_start)
    frame = reader[frame_start:frame_end].removeprefix("export ")
    script += "\nconst FRAME_SOURCE=" + js_string(frame) + ";"
    script += ("\n(async()=>{\n" + PROBE_JS + "\n})().catch(error=>{"
               "document.getElementById('native-result').textContent=JSON.stringify({error:String(error),stack:error.stack});});")
    document = ("<!doctype html><meta charset='utf-8'>"
                "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; "
                "script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'\">"
                "<title>Offline native Canvas hint test</title>"
                "<canvas id='resume' width='773' height='956' style='width:773px;height:956px'></canvas>"
                "<pre id='native-result'>pending</pre><script>" + script + "</script>")
    page = directory / "probe.html"
    page.write_text(document, encoding="utf-8")
    command = [str(args.browser), "--headless", "--dump-dom", "--disable-gpu",
               "--disable-extensions", "--disable-background-networking", "--disable-component-update",
               "--disable-sync", "--no-first-run", "--no-default-browser-check", "--no-pings",
               "--host-resolver-rules=MAP * ~NOTFOUND", "--virtual-time-budget=1000",
               f"--user-data-dir={profile}", page.as_uri()]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                               timeout=args.timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    (directory / "browser-stderr.log").write_text(completed.stderr, encoding="utf-8")
    (directory / "dump.html").write_text(completed.stdout, encoding="utf-8")
    match = re.search(r'<pre id="native-result">(.*?)</pre>', completed.stdout, re.DOTALL)
    if not match:
        raise RuntimeError(f"No native probe result (exit {completed.returncode}); artifacts: {directory}")
    result = json.loads(html.unescape(match.group(1)))
    output = directory / "result.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if "error" in result:
        raise RuntimeError(f"{result['error']}; artifacts: {directory}")
    cases = result["cases"]
    print(json.dumps({"result": str(output), "html": str(page), "browser": str(args.browser),
                      "userAgent": result["userAgent"], "fonts": result["fonts"],
                      "passed": sum(case["passed"] for case in cases), "total": len(cases),
                      "cases": [{"name": case["name"], "passed": case["passed"]} for case in cases]},
                     ensure_ascii=True, indent=2))
    if args.check and not all(case["passed"] for case in cases):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
