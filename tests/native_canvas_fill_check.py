"""Offline native Canvas fill/highlight probes with a fresh, empty browser profile.

Only a local synthetic page is loaded. CSP disables connections, Chromium's DNS
resolver blocks all hosts, and no real browser profile, BOSS page, CDP session,
extension installation, model, or candidate database is used.
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
    'chrome-headless-shell-win64/chrome-headless-shell.exe')

PROBE_JS = r"""
document.documentElement.lang='en';
window.__hrmCanvasTextEnabled=true;
new Function(GEOMETRY_SOURCE)();
new Function(GLYPHS_SOURCE)();
new Function('location',EXPAND_SOURCE)({protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'});
new Function('location',OBSERVER_SOURCE)({protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'});
const canvas=document.querySelector('#resume'),ctx=canvas.getContext('2d'),cases=[];
const width=773,height=260;
function style(p,{font='28px Arial',scale=1}={}){
  p.reset();p.setTransform(scale,0,0,scale,0,0);p.font=font;
  p.textBaseline='alphabetic';p.textAlign='left';p.direction='ltr';p.lang='en';
  p.fillStyle='#111111';p.globalAlpha=1;p.globalCompositeOperation='source-over';
}
function bounds(p,text,x,y){
  const m=p.measureText(text),t=p.getTransform();
  return {left:(x-m.actualBoundingBoxLeft)*t.a+t.e,right:(x+m.actualBoundingBoxRight)*t.a+t.e,
    top:(y-m.actualBoundingBoxAscent)*t.d+t.f,bottom:(y+m.actualBoundingBoxDescent)*t.d+t.f};
}
function image(p){return p.getImageData(0,0,width,height).data;}
function checksum(pixels){let hash=2166136261;for(const byte of pixels)hash=Math.imul(hash^byte,16777619);return (hash>>>0).toString(16);}
function touched(data,r){
  let pixels=0,corePixels=0;
  for(let y=Math.max(0,Math.floor(r.top));y<Math.min(height,Math.ceil(r.bottom));y++)
    for(let x=Math.max(0,Math.floor(r.left));x<Math.min(width,Math.ceil(r.right));x++){
      const alpha=data[(y*width+x)*4+3];if(alpha)pixels++;if(alpha>=128)corePixels++;
    }
  return {pixels,corePixels};
}
function intersection(a,b){return Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));}
function partialInkRect(data,b){
  const start=Math.floor((b.left+b.right)/2);
  for(const x of [start,...Array.from({length:Math.max(0,Math.ceil(b.right)-Math.floor(b.left)-2)},(_,i)=>Math.floor(b.left)+1+i)]){
    const r={left:x,top:Math.floor(b.top),right:x+1,bottom:Math.ceil(b.bottom)};
    if(r.left>b.left&&r.right<b.right&&touched(data,r).corePixels>0)return r;
  }
  throw Error('Unable to find a real partially covered glyph core');
}
function paintRect(p,r,{scale=1,color='#dff4f4',method='fillRect'}={}){
  p.fillStyle=color;
  if(method==='path'){p.beginPath();p.rect(r.left/scale,r.top/scale,(r.right-r.left)/scale,(r.bottom-r.top)/scale);p.fill();}
  else p.fillRect(r.left/scale,r.top/scale,(r.right-r.left)/scale,(r.bottom-r.top)/scale);
  p.fillStyle='#111111';
}
function record(name,expectedText,reference,{reject=false,proof={}}={}){
  const snapshot=window.__hrmCanvasText.snapshot();
  const pixels=image(ctx),expected=image(reference);
  const pixelExactlyMatchesReference=pixels.length===expected.length&&pixels.every((byte,index)=>byte===expected[index]);
  const expectedBytes=new TextEncoder().encode(expectedText),actualBytes=new TextEncoder().encode(snapshot.text);
  const utf8Exact=expectedBytes.length===actualBytes.length&&expectedBytes.every((byte,index)=>byte===actualBytes[index]);
  cases.push({name,expectedText,reject,actualText:snapshot.text,issue:snapshot.issue,issueCode:snapshot.issueCode,
    utf8Exact,pixelExactlyMatchesReference,pixelChecksum:checksum(pixels),proof,diagnostics:snapshot.diagnostics,
    passed:pixelExactlyMatchesReference&&(reject?snapshot.issueCode==='unsupported'&&/局部覆盖|文字重叠/.test(snapshot.issue)&&snapshot.text==='':!snapshot.issue&&utf8Exact)});
}
function reference(options){const p=new OffscreenCanvas(width,height).getContext('2d');style(p,options);return p;}
await document.fonts.ready;
for(const [name,options] of [
  ['highlight-before-whole-run',{text:'C# / Python 中文检测'}],
  ['highlight-before-whole-run-yahei',{text:'机器视觉检测与软件开发',font:'24px "Microsoft YaHei"'}],
  ['highlight-before-whole-run-high-dpi',{text:'Python 检测',scale:2,font:'16px Arial'}],
]){
  const ref=reference(options);style(ctx,options);const x=30,y=75,b=bounds(ref,options.text,x,y);
  const r={left:b.left-2,top:b.top-2,right:b.right+2,bottom:b.bottom+2};
  for(const p of [ctx,ref]){paintRect(p,r,options);p.fillText(options.text,x,y);}
  record(name,options.text,ref,{proof:{rect:r,glyphBounds:b}});
}
for(const [name,options] of [
  ['same-single-glyph-redraw-after-highlight',{text:'C'}],
  ['same-whole-run-redraw-after-highlight',{text:'C# / Python 中文检测'}],
  ['same-whole-run-yahei-redraw-after-highlight',{text:'视觉检测项目',font:'24px "Microsoft YaHei"'}],
  ['same-glyph-high-dpi-redraw-after-highlight',{text:'中',scale:2,font:'16px Arial'}],
  ['same-glyph-redraw-after-rect-path',{text:'C',method:'path'}],
]){
  const ref=reference(options);style(ctx,options);const x=30,y=75,b=bounds(ref,options.text,x,y);
  ref.fillText(options.text,x,y);const prior=image(ref),r=partialInkRect(prior,b);
  ctx.fillText(options.text,x,y);
  for(const p of [ctx,ref]){paintRect(p,r,options);p.fillText(options.text,x,y);}
  record(name,options.text,ref,{proof:{rect:r,glyphBounds:b,touched:touched(prior,r)}});
}
// Find actual native blank support in the right corner of a neighboring glyph.
// The filled rectangle intersects its measured box and extends into the next
// keyword's area, but touches no nonzero glyph-alpha pixel at all.
let blankCase=null;
for(const value of ['C','A','V','T','中']){
  const options={font:'32px Arial'},ref=reference(options);ref.fillText(value,50,90);
  const b=bounds(ref,value,50,90),prior=image(ref);
  for(const size of [3,2,1])for(const top of [Math.floor(b.top),Math.ceil(b.bottom)-size]){
    const r={left:Math.ceil(b.right)-size,top,right:Math.ceil(b.right)+90,bottom:top+size};
    if(intersection(r,b)>0&&touched(prior,r).pixels===0){blankCase={value,options,b,r};break;}
  }
  if(blankCase)break;
}
if(!blankCase)throw Error('No native glyph-box blank corner was available; cannot claim this regression passed');
{
  const {value,options,b,r}=blankCase,ref=reference(options);style(ctx,options);
  for(const p of [ctx,ref]){p.fillText(value,50,90);paintRect(p,r);p.fillText('Python',b.right+12,90);}
  const probe=reference(options);probe.fillText(value,50,90);
  record('highlight-intersects-neighbor-box-but-no-ink',value+' Python',ref,
    {proof:{glyph:value,rect:r,glyphBounds:b,boxIntersectionArea:intersection(r,b),touched:touched(image(probe),r)}});
}
for(const [name,options] of [
  ['partial-ink-cover-without-redraw-rejected',{}],
  ['partial-ink-cover-different-glyph-redraw-rejected',{replacement:'X'}],
  ['partial-ink-cover-shifted-same-glyph-redraw-rejected',{replacement:'C',dx:1}],
  ['partial-ink-cover-translucent-same-glyph-redraw-rejected',{replacement:'C',alpha:.5}],
  ['partial-ink-cover-different-font-redraw-rejected',{replacement:'C',redrawFont:'bold 28px Arial'}],
  ['partial-ink-cover-path-without-redraw-rejected',{method:'path'}],
]){
  const ref=reference({}),x=40,y=80;style(ctx,{});ref.fillText('C',x,y);
  const b=bounds(ref,'C',x,y),prior=image(ref),r=partialInkRect(prior,b);
  ctx.fillText('C',x,y);
  for(const p of [ctx,ref]){
    paintRect(p,r,options);
    if(options.replacement){if(options.redrawFont)p.font=options.redrawFont;p.globalAlpha=options.alpha??1;p.fillText(options.replacement,x+(options.dx||0),y);}
  }
  record(name,'',ref,{reject:true,proof:{rect:r,glyphBounds:b,touched:touched(prior,r)}});
}
// Match the user's observed operation scale using original per-glyph text:
// 779 initial fillText calls, 25 partial highlights, then 25 exact glyph redraws.
// The extracted lines must remain byte-for-byte identical, not merely nonempty.
{
  const options={font:'14px Arial'},ref=reference(options);style(ctx,options);
  const phrase='C# Python C++ Halcon 机器视觉 自动化检测 OPC 串口 Winform WPF ';
  const lines=Array.from({length:12},(_,row)=>(phrase.repeat(3)).slice(0,row===11?64:65));
  const draws=[];
  for(const [row,line] of lines.entries()){
    let x=25;const y=22+row*18;
    for(const value of [...line]){
      for(const p of [ctx,ref])p.fillText(value,x,y);
      if(value==='C')draws.push({value,x,y,b:bounds(ref,value,x,y)});
      x+=Math.ceil(ref.measureText(value).width);
    }
  }
  const prior=image(ref),patches=[];
  for(const draw of draws.slice(0,25)){
    const r=partialInkRect(prior,draw.b);patches.push({rect:r,touched:touched(prior,r)});
    for(const p of [ctx,ref]){paintRect(p,r);p.fillText(draw.value,draw.x,draw.y);}
  }
  record('25-keyword-highlights-804-original-fillText-calls',lines.join('\n'),ref,{proof:{patchCount:patches.length,patches}});
  const item=cases.at(-1),ops=item.diagnostics?.operations||{};
  item.proof.operations={fillRect:ops.fillRect,fillText:ops.fillText};
  item.passed&&=patches.length===25&&ops.fillRect===25&&ops.fillText===804;
}
// Repainting a target glyph does not re-establish the provenance of a copied
// cache entry; the source cache and all lost ink must still be accounted for.
{
  const cached=document.createElement('canvas');cached.width=width;cached.height=height;
  const cachedCtx=cached.getContext('2d');style(cachedCtx,{});cachedCtx.fillText('C',40,80);
  const ref=reference({});style(ctx,{});ctx.drawImage(cached,0,0);ref.drawImage(cached,0,0);
  const b=bounds(ref,'C',40,80),prior=image(ref),r=partialInkRect(prior,b);
  for(const p of [ctx,ref]){paintRect(p,r);p.fillText('C',40,80);}
  record('copied-source-partial-cover-and-local-redraw-still-rejected','',ref,{reject:true,proof:{rect:r,touched:touched(prior,r)}});
}
// Equal-bounds causes must retain their independent proof. First/last letters
// are identical so native metrics collide exactly while the middle letter's
// pixels differ, rather than relying on mocked equal-width glyph geometry.
for(const [name,foreign,useCache] of [
  ['same-box-different-text-coverage-cause-survives-original-redraw','ACA',false],
  ['same-box-copied-coverage-cause-survives-original-redraw','ADA',true],
]){
  const options={font:'28px "Courier New"'},text='ABA',x=40,y=80;
  const ref=reference(options),original=reference(options),foreignOnly=reference(options);
  style(ctx,options);original.fillText(text,x,y);foreignOnly.fillText(foreign,x,y);
  const b=bounds(original,text,x,y),foreignBounds=bounds(foreignOnly,foreign,x,y);
  const sameBox=['left','top','right','bottom'].every(key=>b[key]===foreignBounds[key]);
  if(!sameBox)throw Error('Native same-box collision fixture has different bounds: '+JSON.stringify({b,foreignBounds}));
  const originalPixels=image(original),foreignPixels=image(foreignOnly);
  const r=partialInkRect(originalPixels,bounds(original,'A',x,y));
  for(const p of [ctx,ref]){p.fillText(text,x,y);paintRect(p,r);}
  const first=window.__hrmCanvasText.snapshot();
  if(useCache){
    const cached=document.createElement('canvas');cached.width=width;cached.height=height;
    const source=cached.getContext('2d');style(source,options);
    source.fillText(foreign,x,y);paintRect(source,r);
    for(const p of [ctx,ref])p.drawImage(cached,0,0);
  }else{
    for(const p of [ctx,ref]){p.fillText(foreign,x,y);paintRect(p,r);}
  }
  const second=window.__hrmCanvasText.snapshot();
  for(const p of [ctx,ref])p.fillText(text,x,y);
  const finalPixels=image(ctx),residualSamples=[];let residualForeignCorePixels=0;
  for(let row=0;row<height;row++)for(let col=0;col<width;col++){
    const offset=(row*width+col)*4;
    // A dark native pixel from the other word remains where the final word
    // has no ink; neither cyan backgrounds nor antialiasing alone count.
    if(originalPixels[offset+3]===0&&foreignPixels[offset+3]>=128&&
      finalPixels[offset+3]>=128&&finalPixels[offset]<=40&&finalPixels[offset+1]<=40&&finalPixels[offset+2]<=40){
      residualForeignCorePixels++;
      if(residualSamples.length<3)residualSamples.push({x:col,y:row,rgba:[...finalPixels.slice(offset,offset+4)]});
    }
  }
  record(name,'',ref,{reject:true,proof:{text,foreign,font:options.font,useCache,
    rect:r,glyphBounds:b,foreignBounds,sameBox,touched:touched(originalPixels,r),
    residualForeignCorePixels,residualSamples,
    firstCauses:first.diagnostics.reasonCounts,secondCauses:second.diagnostics.reasonCounts}});
  const item=cases.at(-1);
  item.passed&&=sameBox&&residualForeignCorePixels>0&&item.issue==='画布文字被局部覆盖';
}
// Two copied partial causes separated by less than the old 0.1px box
// tolerance are distinct: erasing the first full box cannot clear the second.
{
  const options={font:'28px "Courier New"'},text='ABA',x=40,y=80,dx=.05;
  const source=document.createElement('canvas');source.width=width;source.height=height;
  const sourceCtx=source.getContext('2d');style(sourceCtx,options);sourceCtx.fillText(text,x,y);
  const b=bounds(sourceCtx,text,x,y),prior=image(sourceCtx),r=partialInkRect(prior,bounds(sourceCtx,'A',x,y));
  paintRect(sourceCtx,r);
  const ref=reference(options);style(ctx,options);
  for(const p of [ctx,ref]){p.drawImage(source,0,0);p.drawImage(source,dx,0);}
  const before=window.__hrmCanvasText.snapshot();
  for(const p of [ctx,ref])paintRect(p,b);
  record('subpixel-shifted-copied-cause-survives-first-box-clear','',ref,{reject:true,
    proof:{dx,firstBounds:b,secondBounds:{...b,left:b.left+dx,right:b.right+dx},
      clearBounds:b,beforeCauses:before.diagnostics.reasonCounts}});
  const item=cases.at(-1),causes=item.diagnostics.reasonCounts;
  item.proof.afterCauses=causes;
  item.passed&&=before.diagnostics.reasonCounts.some(cause=>cause.reason==='画布文字被局部覆盖'&&cause.count===2)&&
    causes.some(cause=>cause.reason==='画布文字被局部覆盖'&&cause.count===1)&&item.issue==='画布文字被局部覆盖';
}
const result={userAgent:navigator.userAgent,fonts:{arial:document.fonts.check('28px Arial'),yahei:document.fonts.check('24px "Microsoft YaHei"')},cases};
document.querySelector('#result').textContent=JSON.stringify(result).replace(/[\u007f-\uffff]/g,
  value=>'\\u'+value.charCodeAt(0).toString(16).padStart(4,'0'));
"""


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser',type=Path,default=DEFAULT_BINARY)
    parser.add_argument('--timeout',type=int,default=45)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    if not args.browser.is_file():
        parser.error(f'Existing headless-shell binary not found: {args.browser}')
    root=Path(__file__).resolve().parents[1]
    directory=Path(tempfile.mkdtemp(prefix='hrm-native-canvas-fill-'))
    profile=directory/'empty-profile';profile.mkdir()
    encode=lambda value:json.dumps(value,ensure_ascii=True).replace('</','<\\/')
    names={'GEOMETRY_SOURCE':'canvas-geometry.js','GLYPHS_SOURCE':'canvas-glyphs.js',
           'EXPAND_SOURCE':'canvas-expand.js','OBSERVER_SOURCE':'canvas-text.js'}
    script='\n'.join('const '+key+'='+encode((root/'extension'/name).read_text(encoding='utf-8'))+';' for key,name in names.items())
    script+='\n(async()=>{\n'+PROBE_JS+'\n})().catch(error=>{document.querySelector("#result").textContent=JSON.stringify({error:String(error),stack:error.stack});});'
    page=directory/'probe.html'
    page.write_text('<!doctype html><meta charset="utf-8">'
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; '
        'style-src \'unsafe-inline\'; connect-src \'none\'">'
        '<title>Offline native Canvas fill regression</title>'
        '<canvas id="resume" width="773" height="260" style="width:773px;height:260px"></canvas>'
        '<pre id="result">pending</pre><script>'+script+'</script>',encoding='utf-8')
    command=[str(args.browser),'--headless','--dump-dom','--disable-gpu','--disable-extensions',
        '--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run',
        '--no-default-browser-check','--no-pings','--host-resolver-rules=MAP * ~NOTFOUND','--virtual-time-budget=1000',
        f'--user-data-dir={profile}',page.as_uri()]
    completed=subprocess.run(command,capture_output=True,text=True,encoding='utf-8',errors='replace',
        timeout=args.timeout,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    (directory/'stderr.log').write_text(completed.stderr,encoding='utf-8')
    (directory/'dump.html').write_text(completed.stdout,encoding='utf-8')
    match=re.search(r'<pre id="result">(.*?)</pre>',completed.stdout,re.S)
    if not match:raise RuntimeError(f'Native Canvas result absent; artifacts: {directory}')
    result=json.loads(html.unescape(match.group(1)))
    output=directory/'result.json';output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    if 'error' in result:raise RuntimeError(f'{result["error"]}; artifacts: {directory}')
    print(json.dumps({'result':str(output),'html':str(page),'userAgent':result['userAgent'],'fonts':result['fonts'],
        'cases':[{key:case.get(key) for key in ['name','passed','utf8Exact','reject','issue','pixelExactlyMatchesReference','proof']} for case in result['cases']]},ensure_ascii=True,indent=2))
    if args.check and not all(case['passed'] for case in result['cases']):raise SystemExit(1)


if __name__=='__main__':
    main()
