"""Real offline Canvas and DOM clipping regression for horizontal completeness.

Uses an existing Chromium headless-shell binary, a temporary empty profile and
embedded local sources. No network, candidate account or debugging connection.
All resume content is synthetic. --check returns nonzero on a failed case.
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

PROBE_JS = r"""
const owner=document.getElementById('owner'),canvas=document.getElementById('resume'),ctx=canvas.getContext('2d');
const expectedName='王**',body='完整正文包含相机选型、光源调试、视觉算法开发和软件交付。';
const footer=['为妥善保护牛人在BOSS直聘平台提交的简历信息，未经授权不得',
  '在任何第三方平台进行复制、使用、传播、存储。'];
const allowed={protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'};
const capture=new Function(CAPTURE_SOURCE+'; return {isBoss,resumeFoldLabels};')();
const proof=new Function('resumeFoldLabels',PROOF_SOURCE+'; return {createClipboardProof,normalized};')(capture.resumeFoldLabels);
const reader=new Function('isBoss','resumeFoldLabels','createClipboardProof','normalizeClipboardProofText','location',
  READER_SOURCE+'; return {backgroundResumeFrame,readBackgroundResume};')(
    capture.isBoss,capture.resumeFoldLabels,proof.createClipboardProof,proof.normalized,allowed);
const cases=[];let sequence=0;
function brief(sample){
  return {issue:sample?.issue||'',issueCode:sample?.issueCode||'',text:sample?.text||'',
    horizontalCoverage:sample?.horizontalCoverage||null,geometry:sample?.geometry||null,
    diagnostics:sample?.diagnostics||null};
}
function setup({left=0,width=756,height=956,scale=1,pixels=1,gutter=false,border=false,cache=false,canvasBox=null}={}){
  window.__hrmCanvasText?.stop();window.__hrmExpandMarks?.stop();delete window.__hrmBackgroundRead;
  owner.style.cssText='position:absolute;left:20px;top:20px;overflow-x:hidden;overflow-y:'+(gutter?'scroll':'hidden')+
    ';width:'+(gutter?773*scale:width*scale)+'px;height:'+height*scale+'px;'+(border?'border:2px solid #ddd;':'');
  canvas.style.cssText='display:block;width:'+773*scale+'px;height:'+956*scale+'px;margin-left:'+(-left*scale)+'px;';
  if(canvasBox)canvas.style.cssText='display:block;width:773px;height:956px;border:3px solid #ddd;padding:7px;'+
    'box-sizing:'+canvasBox+';transform-origin:0 0;transform:scale('+scale+');';
  canvas.width=773*pixels;canvas.height=956*pixels;owner.scrollTop=0;
  window.__hrmCanvasTextEnabled=true;
  new Function(GEOMETRY_SOURCE)();new Function('location',EXPAND_SOURCE)(allowed);new Function('location',OBSERVER_SOURCE)(allowed);
  const target=cache?document.createElement('canvas'):canvas;
  target.width=canvas.width;target.height=canvas.height;const paint=target.getContext('2d');
  function render({extra,extraY=180,partial=false,unknownImage=false,unsupported=false,fold=false,foldX=710}={}){
    paint.setTransform(1,0,0,1,0,0);paint.clearRect(0,0,target.width,target.height);
    paint.setTransform(pixels,0,0,pixels,0,0);paint.fillStyle='#222';paint.font='22px "Microsoft YaHei",sans-serif';
    paint.fillText(expectedName,132,50);paint.font='14px "Microsoft YaHei",sans-serif';
    paint.fillText('33岁 10年 本科',132,80);paint.fillText('工作经历',44,140);
    paint.fillText('示例科技有限公司 视觉工程师',132,140);
    const date='2018.04 - 2020.04';paint.fillText(date,723-paint.measureText(date).actualBoundingBoxRight,140);
    paint.fillText(body,132,220);paint.fillText('教育经历',44,300);paint.fillText('示例大学 计算机 本科',132,300);
    paint.font='12px "Microsoft YaHei",sans-serif';footer.forEach((line,index)=>paint.fillText(line,44,400+index*24));
    paint.font='14px "Microsoft YaHei",sans-serif';
    if(extra)paint.fillText(extra,partial?751:left?2:758,extraY);
    if(unknownImage){const image=new OffscreenCanvas(8,8),imageContext=image.getContext('2d');
      imageContext.fillStyle='#246';imageContext.fillRect(0,0,8,8);paint.drawImage(image,left?2:762,180,8,8);}
    if(unsupported){paint.fillStyle=paint.createLinearGradient(0,0,10,0);paint.fillStyle.addColorStop(0,'#000');
      paint.fillStyle.addColorStop(1,'#fff');paint.fillRect(left?2:760,180,8,8);}
    if(fold)paint.fillText('查看全部',foldX,460);
    if(cache){ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(target,0,0);}
  }
  const token='horizontal-'+(++sequence);
  const run=(action,args={})=>reader.backgroundResumeFrame(action,{token,name:expectedName,...args});
  return {render,run,token,pixels,cleanup:()=>run('cleanup')};
}
function checkFrame(name,settings,paint,complete,reason){
  const f=setup(settings);f.render(paint);let sample,error='';
  try{sample=f.run('prepare');}catch(caught){error=String(caught);}
  const coverage=sample?.horizontalCoverage;
  cases.push({name,error,passed:!error&&sample.geometry.contentWidthVisible===false&&
    coverage?.complete===complete&&(!reason||coverage.reason===reason),sample:brief(sample),
    owner:{clientWidth:owner.clientWidth,offsetWidth:owner.offsetWidth,scrollHeight:owner.scrollHeight},
    devicePixelRatio});
  try{f.cleanup();}catch{}
}
checkFrame('right-17px-blank-margin',{},{},true,'empty-margins');
checkFrame('left-17px-blank-margin',{left:17},{},true,'empty-margins');
checkFrame('native-vertical-scrollbar-blank-margin',{gutter:true},{},true,'empty-margins');
checkFrame('scaled-bordered-owner-blank-margin',{scale:1.25,border:true},{},true,'empty-margins');
checkFrame('double-source-pixel-density',{pixels:2},{},true,'empty-margins');
checkFrame('copied-canvas-blank-margin',{cache:true},{},true,'empty-margins');
checkFrame('whole-right-column-outside',{},{extra:'隐'},false,'text-outside');
checkFrame('partial-right-glyph-outside',{},{extra:'缺',partial:true},false,'text-outside');
checkFrame('whole-left-column-outside',{left:17},{extra:'隐'},false,'text-outside');
checkFrame('unknown-right-image-outside',{},{unknownImage:true},false,'image-outside');
checkFrame('unknown-left-image-outside',{left:17},{unknownImage:true},false,'image-outside');
checkFrame('unconfirmed-right-paint-outside',{},{unsupported:true},false);
checkFrame('outside-current-vertical-band-does-not-poison-band',{height:500},{extra:'隐',extraY:800},true,'empty-margins');

// Independently compute canvas content-box coordinates for the new border /
// padding mapper, under a real positive CSS transform. Source ink is unchanged.
for(const boxSizing of ['content-box','border-box']){
  for(const [suffix,paint,complete] of [['blank',{},true],['hidden-right-body',{extra:'隐'},false]]){
    const f=setup({scale:1.25,canvasBox:boxSizing});f.render(paint);let sample,error='';
    try{sample=f.run('prepare');}catch(caught){error=String(caught);}
    const contentWidth=(boxSizing==='border-box'?753:773)*1.25;
    const contentLeft=20+10*1.25,visibleRight=20+owner.clientWidth;
    const expectedWidth=(visibleRight-contentLeft)*773/contentWidth;
    const actual=sample?.geometry?.rect;
    cases.push({name:'canvas-'+boxSizing+'-border-padding-transformed-'+suffix,error,expectedWidth,
      passed:!error&&sample.geometry.contentWidthVisible===false&&sample.horizontalCoverage?.complete===complete&&
        Math.abs(actual.x)<.02&&Math.abs(actual.y)<.02&&Math.abs(actual.width-expectedWidth)<.02,
      sample:brief(sample)});
    try{f.cleanup();}catch{}
  }
}
{
  const f=setup({scale:1.25,canvasBox:'border-box'});f.render({fold:true,foldX:400});
  const events=[],record=event=>events.push({type:event.type,x:event.clientX,y:event.clientY});
  for(const type of ['mousemove','mousedown','mouseup','click'])canvas.addEventListener(type,record);
  let sample,error='',expected;
  try{
    sample=f.run('prepare');const mark=sample.marks.find(mark=>mark.label==='查看全部');
    if(!mark)throw Error('Visible expand marker absent');
    // MouseEventInit clientX/clientY are native long coordinates; Chromium
    // truncates the computed content-box point at event construction.
    expected={x:20+12.5+mark.x*753*1.25,y:20+12.5+mark.y*936*1.25};
    f.run('expand',{mark});
  }catch(caught){error=String(caught);}
  finally{for(const type of ['mousemove','mousedown','mouseup','click'])canvas.removeEventListener(type,record);f.cleanup();}
  cases.push({name:'transformed-canvas-insets-expand-content-coordinates',error,expected,events,
    passed:!error&&events.length===4&&events.map(event=>event.type).join(',')==='mousemove,mousedown,mouseup,click'&&
      events.every(event=>event.x===Math.trunc(expected.x)&&event.y===Math.trunc(expected.y)),sample:brief(sample)});
}

// Run the full current reader using its actual native-DOM frame function. The
// browser transport alone is stubbed; all observations and Canvas paints are
// real, and the reader must still prove the header and stable platform footer.
for(const [name,paint,complete] of [
  ['reader-accepts-blank-horizontal-margin',{},true],
  ['reader-refuses-hidden-whole-column',{extra:'隐'},false],
  ['reader-refuses-hidden-unknown-image',{unknownImage:true},false],
]){
  const f=setup();f.render(paint);const actions=[],tab={id:1,url:'https://www.zhipin.com/web/chat/search'};
  const browser={tabs:{get:async()=>tab},scripting:{executeScript:async({func,args})=>{
    actions.push(args[0]);return [{documentId:'native-resume',result:func(...args)}];
  }}};
  let result,error='';
  try{result=await reader.readBackgroundResume({browser,tab,documentId:'native-resume',name:expectedName,pause:async()=>{}});}
  catch(caught){error=String(caught);}
  cases.push({name,error,passed:!error&&(complete?!result.issue&&result.completeness.allScreensRead&&result.resume.includes(body):
    Boolean(result.issue)&&!result.completeness.allScreensRead&&!result.resume),result,actions});
}
// An actual expand marker exists in the source canvas, but its entire label
// is outside the ancestor's visible width. No click may target that marker.
{
  const f=setup({width:700});f.render({fold:true});const events=[];
  const record=event=>events.push(event.type);
  for(const type of ['pointerdown','pointerup','mousedown','mouseup','click'])canvas.addEventListener(type,record);
  let sample,error='',rejected=false;
  try{sample=f.run('prepare');const mark=window.__hrmExpandMarks.read(canvas).find(mark=>mark.label==='查看全部');
    if(!mark)throw Error('Native source marker was not recorded');
    try{f.run('expand',{mark});}catch{rejected=true;}
  }catch(caught){error=String(caught);}
  finally{for(const type of ['pointerdown','pointerup','mousedown','mouseup','click'])canvas.removeEventListener(type,record);f.cleanup();}
  cases.push({name:'hidden-expand-mark-never-clicked',error,passed:!error&&rejected&&!events.length&&
    sample?.geometry.contentWidthVisible===false,events,sample:brief(sample)});
}
window.__hrmCanvasText?.stop();window.__hrmExpandMarks?.stop();
const result={userAgent:navigator.userAgent,devicePixelRatio,fonts:{yahei:document.fonts.check('14px "Microsoft YaHei"')},cases};
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
    directory = Path(tempfile.mkdtemp(prefix="hrm-native-canvas-horizontal-"))
    profile = directory / "empty-profile"
    profile.mkdir()
    js_string = lambda value: json.dumps(value, ensure_ascii=True).replace("</", "<\\/")
    script = ""
    for name, file in {"GEOMETRY_SOURCE": "canvas-geometry.js", "OBSERVER_SOURCE": "canvas-text.js",
                       "EXPAND_SOURCE": "canvas-expand.js", "CAPTURE_SOURCE": "capture-utils.mjs",
                       "PROOF_SOURCE": "copy-proof.mjs", "READER_SOURCE": "background-read.mjs"}.items():
        source = (root / "extension" / file).read_text(encoding="utf-8")
        if file.endswith(".mjs"):
            source = re.sub(r"^import .*?;\s*", "", source, flags=re.MULTILINE)
            source = re.sub(r"^export \{.*?\};\s*", "", source, flags=re.MULTILINE)
            source = re.sub(r"\bexport (?=(?:async )?function|const )", "", source)
        script += "const " + name + "=" + js_string(source) + ";\n"
    script += ("\n(async()=>{\n" + PROBE_JS + "\n})().catch(error=>{"
               "document.getElementById('native-result').textContent=JSON.stringify({error:String(error),stack:error.stack});});")
    document = ("<!doctype html><meta charset='utf-8'>"
                "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; "
                "script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'\">"
                "<title>Offline native Canvas horizontal test</title>"
                "<style>html,body{margin:0;height:100%;overflow:hidden}#native-result{position:fixed;left:-10000px;top:0}</style>"
                "<div id='owner'><canvas id='resume'></canvas></div>"
                "<pre id='native-result'>pending</pre><script>" + script + "</script>")
    page = directory / "probe.html"
    page.write_text(document, encoding="utf-8")
    command = [str(args.browser), "--headless", "--dump-dom", "--disable-gpu", "--window-size=1400,1400",
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
                      "userAgent": result["userAgent"], "devicePixelRatio": result["devicePixelRatio"], "fonts": result["fonts"],
                      "passed": sum(case["passed"] for case in cases), "total": len(cases),
                      "cases": [{"name": case["name"], "passed": case["passed"]} for case in cases]},
                     ensure_ascii=True, indent=2))
    if args.check and not all(case["passed"] for case in cases):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
