"""Offline native regression for Canvas copy geometry and one-copy limits.

Run: python tests/native_resume_copy_geometry_check.py
Requires an already installed Playwright Chromium (no downloads).
Every HTTP request is fulfilled from this file or local extension sources.
The official-looking URL is a disposable synthetic page, never the real site.
Production copyOpenResume, inspectCopyFrame, pixel evidence, hit tests and
clipboard marker run unchanged; only Chrome's extension transport is adapted
to Playwright CDP. Headless focus does not assert OS window behavior.
"""

import asyncio
import base64
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
BOSS = "https://www.zhipin.com/web/frame/c-resume"
COLLECTOR = "https://collector.invalid/"
FOOTER = (
    "为妥善保护牛人在BOSS直聘平台提交、发布、展示的简历（包括但不限于在线简历、附件简历）"
    "中的个人信息（包括但不限于联系方式、期望职位、教育经历、工作经历等），任何用户原则上"
    "仅可出于自身招聘的目的，通过BOSS直聘平台在线浏览牛人简历。未经BOSS直聘及牛人本人书面授权，"
    "任何用户不得将牛人在BOSS直聘平台提交、发布、展示的简历中的个人信息，在任何第三方平台"
    "进行复制、使用、传播、存储。"
)
TEXT = (
    "杜先生\n35岁 本科 8年 离职-随时到岗\n工作经历\n合成设备公司 视觉研发工程师\n"
    "负责工业视觉算法、设备调试与软件开发，完成多个机器视觉项目。\n"
    "专业技能\nPython 图像处理 机械视觉\n教育经历\n合成大学 计算机科学 本科\n" + FOOTER
)
# A genuine cross-origin, non-CORS image taints Canvas in Chromium.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6"
    "jV8AAAAASUVORK5CYII="
)
FIXTURE = r"""<!doctype html><meta charset="utf-8"><title>Synthetic geometry only</title>
<style>
html,body{margin:0;padding:0;overflow:hidden}
#wrapper{position:relative;margin:20px;width:600px;height:400px;overflow:hidden}
#resume{display:block}
#corner{position:absolute;left:0;top:0;width:32px;height:32px;background:#ddd}
#spacer{position:absolute;left:0;top:0;height:1px;pointer-events:none}
</style><div id="wrapper"><canvas id="resume" tabindex="0"></canvas></div>
<script>
window.copyEvents=[];window.pointerEvents=[];window.selection={};window.configure=async options=>{
  const wrapper=document.querySelector('#wrapper'),canvas=document.querySelector('#resume');
  const width=options.width||600,height=options.height||400,scale=options.scale||1;
  window.options=options;window.copyEvents=[];window.pointerEvents=[];window.selection={};
  wrapper.style.width=options.responsive?'calc(100vw - 40px)':(options.wrapperWidth||600)+'px';
  wrapper.style.height=(options.wrapperHeight||400)+'px';
  wrapper.style.overflowX=options.horizontal?'auto':'hidden';
  wrapper.style.overflowY=options.gutter?'scroll':'hidden';
  wrapper.style.scrollbarGutter=options.gutter?'stable':'auto';
  wrapper.style.zoom=options.zoom||1;
  wrapper.style.transform=options.rotate?'rotate('+options.rotate+'deg)':'none';
  canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
  canvas.style.width=width+'px';canvas.style.height=height+'px';
  canvas.style.transform='translateX('+(options.translateX||0)+'px)';
  if(options.borderBox){canvas.style.boxSizing='border-box';canvas.style.borderRight='100px solid white';}
  if(options.paddingBox){canvas.style.boxSizing='border-box';canvas.style.paddingRight='100px';}
  if(options.objectFit)canvas.style.objectFit=options.objectFit;
  const ctx=canvas.getContext('2d');ctx.setTransform(canvas.width/width,0,0,canvas.height/height,0,0);
  if(!options.transparent){
    ctx.fillStyle=options.partialAlpha?'rgba(255,255,255,0.5)':'#fff';ctx.fillRect(0,0,width,height);
  }
  ctx.fillStyle='#111';ctx.font='bold 24px Microsoft YaHei';ctx.textAlign='left';
  let x=80;window.nameCarets=[x];
  for(const char of '杜先生'){ctx.fillText(char,x,38);x+=ctx.measureText(char).width;window.nameCarets.push(x);}
  ctx.font='14px Microsoft YaHei';let y=68;
  for(const line of window.rawText.split('\n').slice(1)){
    for(let i=0;i<line.length;i+=32){ctx.fillText(line.slice(i,i+32),80,y);y+=16;}
  }
  window.lastTextY=y;
  window.expansionEvents=[];window.foldControls=[];
  for(const spec of options.folds||[]){
    let rect;
    if(spec.visual){
      const rows=window.controlMaskRows,glyph=document.createElement('canvas');
      glyph.width=Math.max(...rows.map(row=>row.length));glyph.height=rows.length;
      const g=glyph.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,glyph.width,glyph.height);
      g.fillStyle='#00a6a7';rows.forEach((row,y)=>[...row].forEach((ink,x)=>{if(ink==='#')g.fillRect(x,y,1,1);}));
      ctx.drawImage(glyph,80,spec.y);rect={left:80,top:spec.y,right:80+glyph.width,bottom:spec.y+glyph.height};
    }else{
      ctx.font='18px Microsoft YaHei';ctx.fillStyle='#00a6a7';
      const m=ctx.measureText('查看全部');ctx.fillText('查看全部',80,spec.y);
      rect={left:80-m.actualBoundingBoxLeft,top:spec.y-m.actualBoundingBoxAscent,
        right:80+m.actualBoundingBoxRight,bottom:spec.y+m.actualBoundingBoxDescent};
    }
    window.foldControls.push({...rect,expanded:false});
  }
  if(options.pixel){ctx.fillStyle='#e01';ctx.fillRect(options.pixel[0],options.pixel[1],1/scale,1/scale);}
  if(options.cutText){ctx.font='bold 28px Microsoft YaHei';ctx.fillText('字',width-5,350);}
  if(options.column){ctx.fillStyle='#000';ctx.fillRect(width-1,0,1,height);}
  if(options.corner){
    const cover=document.createElement('div');cover.id='corner';wrapper.appendChild(cover);
  }
  if(options.endCover){
    const cover=document.createElement('div');cover.id='end-cover';
    cover.style.cssText='position:absolute;right:0;bottom:0;width:32px;height:32px;background:#ddd';
    wrapper.appendChild(cover);
  }
  if(options.horizontal){
    const spacer=document.createElement('div');spacer.id='spacer';spacer.style.width='760px';wrapper.appendChild(spacer);
    wrapper.scrollLeft=options.scrollLeft||60;
  }
  if(options.tainted){
    const img=new Image();img.src='https://taint.invalid/pixel.png';
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;});
    ctx.drawImage(img,width-1,350,1,1);
  }
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return {scrollLeft:wrapper.scrollLeft,clientWidth:wrapper.clientWidth,
    offsetWidth:wrapper.offsetWidth,width:canvas.getBoundingClientRect().width,
    dpr:devicePixelRatio,zoom:wrapper.style.zoom};
};
const canvas=document.querySelector('#resume');
const point=event=>{
  const box=canvas.getBoundingClientRect(),options=window.options;
  const style=getComputedStyle(canvas),zoom=Number(options.zoom)||1;
  const left=parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft),
    right=parseFloat(style.borderRightWidth)+parseFloat(style.paddingRight),
    top=parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop),
    bottom=parseFloat(style.borderBottomWidth)+parseFloat(style.paddingBottom);
  return {x:((event.clientX-box.left)/zoom-left)*(options.width||600)/(box.width/zoom-left-right),
    y:((event.clientY-box.top)/zoom-top)*(options.height||400)/(box.height/zoom-top-bottom)};
};
canvas.addEventListener('mousedown',event=>{
  if(!event.isTrusted||event.button!==0)return;
  const p=point(event);let index=0;
  for(let i=1;i<window.nameCarets.length;i++)
    if(Math.abs(p.x-window.nameCarets[i])<Math.abs(p.x-window.nameCarets[index]))index=i;
  window.selection={start:index,startPoint:p,moves:0,end:0,all:false,down:true};
  window.pointerEvents.push({type:event.type,trusted:event.isTrusted,...p});
});
canvas.addEventListener('mousemove',event=>{
  if(event.isTrusted&&event.buttons===1&&window.selection.down)window.selection.moves++;
});
canvas.addEventListener('mouseup',event=>{
  if(!event.isTrusted)return;
  const p=point(event);window.selection.down=false;
  window.selection.end=p.y>window.lastTextY?window.rawText.length:0;
  window.pointerEvents.push({type:event.type,trusted:event.isTrusted,...p});
});
canvas.addEventListener('keydown',event=>{
  if(event.isTrusted&&event.ctrlKey&&event.key.toLowerCase()==='a'){
    event.preventDefault();
    if(window.selection.moves>=2&&window.selection.start===0)window.selection.all=true;
  }
});
canvas.addEventListener('click',event=>{
  if(!event.isTrusted||window.selection.moves)return;
  const p=point(event),index=window.foldControls.findIndex(fold=>!fold.expanded&&
    p.x>=fold.left&&p.x<=fold.right&&p.y>=fold.top&&p.y<=fold.bottom);
  if(index<0)return;
  const fold=window.foldControls[index];fold.expanded=true;
  window.expansionEvents.push({trusted:event.isTrusted,index});
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';
  ctx.fillRect(fold.left-2,fold.top-2,fold.right-fold.left+4,fold.bottom-fold.top+4);
});
document.addEventListener('copy',event=>{
  const selected=window.selection;
  window.copyEvents.push({trusted:event.isTrusted,start:selected.start,all:selected.all});
  if(event.isTrusted&&selected.moves>=2&&selected.start===0){
    const remaining=window.options.clipboardComplete?'':window.foldControls.filter(fold=>!fold.expanded).map(()=>'\n查看全部').join('');
    const current=window.rawText+remaining,end=selected.all?current.length:selected.end;
    const raw=current.slice(selected.start,end);
    event.clipboardData.setData('text/plain',raw);
    event.clipboardData.setData('text/html','<pre>'+raw.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</pre>');
  }
  event.preventDefault();
});
</script>"""
RUN = r"""async options=>{
  const {copyOpenResume}=await import('/extension/resume-copy.mjs');
  const rpc=(op,args={})=>window.nativeBridge({op,...args});
  const browser={
    windows:{getCurrent:async()=>({id:2}),update:(id,opts)=>rpc('focus',{id})},
    tabs:{get:async()=>({id:1,windowId:1,active:true,url:options.url})},
    debugger:{attach:async()=>{},detach:async()=>{},sendCommand:(target,method,params)=>rpc('cdp',{method,params})},
    scripting:{executeScript:async request=>rpc('script',{
      world:request.world||'ISOLATED',files:request.files,
      source:request.func?.toString(),args:request.args||[]})}
  };
  window.reports=[];
  try{
    return {result:await copyOpenResume({
      browser,clipboard:navigator.clipboard,clipboardSequence:async()=>null,
      tab:{id:1,windowId:1,url:options.url},documentId:'synthetic-document',
      singlePass:true,expandAlreadyDone:!options.testExpansion,name:'杜先生',
      fitViewport:options.fit?diagnostics=>rpc('fit',{diagnostics}):undefined,
      report:message=>window.reports.push(message),
      pause:ms=>new Promise(resolve=>setTimeout(resolve,Math.min(ms,60)))
    }),reports:window.reports};
  }catch(error){return {error:String(error.message||error),reports:window.reports};}
}"""


async def run_checks():
    checks = []
    extension = ROOT / 'extension'
    expand = (extension / 'canvas-expand.js').read_text(encoding='utf-8')
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'), headless=True,
            args=['--disable-background-networking', '--disable-component-update', '--disable-sync',
                  '--no-first-run', '--no-pings', '--host-resolver-rules=MAP * ~NOTFOUND'])
        try:
            context = await browser.new_context(
                viewport={'width': 900, 'height': 700}, permissions=['clipboard-read', 'clipboard-write'])

            async def route_request(route):
                url = route.request.url
                path = urlparse(url).path
                if url == BOSS:
                    await route.fulfill(status=200, content_type='text/html', body=FIXTURE)
                elif url.startswith(COLLECTOR + 'extension/') and path.endswith('.mjs'):
                    file = extension / Path(path).name
                    await route.fulfill(status=200, content_type='text/javascript',
                                        body=file.read_text(encoding='utf-8'))
                elif url == COLLECTOR:
                    await route.fulfill(status=200, content_type='text/html',
                                        body='<!doctype html><title>Local synthetic collector</title>')
                elif url == 'https://taint.invalid/pixel.png':
                    await route.fulfill(status=200, content_type='image/png', body=PNG)
                else:
                    await route.abort()
            await context.route('**/*', route_request)
            await context.add_init_script(expand)
            collector = await context.new_page()
            await collector.goto(COLLECTOR)

            async def case(label, options=None, *, accepted=True, fit=None, expected_fit=0,
                           expect_start_hit=None, expected_clip=None, expected_margin=None,
                           expected_copies=None, expected_expansions=0):
                options = options or {}
                page = await context.new_page()
                await page.set_viewport_size({'width': 640 if options.get('responsive') else 900, 'height': 700})
                await page.goto(BOSS)
                await page.evaluate('text=>window.rawText=text', TEXT)
                await page.evaluate('rows=>window.controlMaskRows=rows', json.loads(
                    (ROOT / 'tests/fixtures/view-all-link-mask.json').read_text(encoding='utf-8'))['rows'])
                initial = await page.evaluate('options=>window.configure(options)', options)
                session = await context.new_cdp_session(page)
                frame_id = (await session.send('Page.getFrameTree'))['frameTree']['frame']['id']
                world = (await session.send('Page.createIsolatedWorld', {
                    'frameId': frame_id, 'worldName': 'hrm-geometry-regression'}))['executionContextId']
                calls, surfaces, fits = [], [], []

                async def bridge(_source, request):
                    op = request['op']
                    if op == 'focus':
                        await (page if request['id'] == 1 else collector).bring_to_front()
                        return {}
                    if op == 'cdp':
                        calls.append((request['method'], request['params']))
                        return await session.send(request['method'], request['params'])
                    if op == 'fit':
                        fits.append(request['diagnostics'])
                        if fit:
                            await page.set_viewport_size({'width': fit, 'height': 700})
                        return bool(fit)
                    if op == 'script':
                        if request.get('files'):
                            for filename in request['files']:
                                await page.evaluate((extension / filename).read_text(encoding='utf-8'))
                            return [{'frameId': 0, 'documentId': 'synthetic-document'}]
                        expression = '(' + request['source'] + ')(...' + json.dumps(request['args']) + ')'
                        if request['world'] == 'MAIN':
                            value = await page.evaluate(expression)
                        else:
                            result = await session.send('Runtime.evaluate', {
                                'expression': expression, 'contextId': world,
                                'returnByValue': True, 'awaitPromise': True})
                            assert 'exceptionDetails' not in result, result.get('exceptionDetails')
                            value = result['result'].get('value')
                        if request['source'].startswith('function inspectCopyFrame') and isinstance(value, dict):
                            surfaces.append((request['args'][0], value))
                            if options.get('repaintAfterProof') and len(surfaces) == 1:
                                await page.evaluate("""()=>{const c=document.querySelector('#resume'),ctx=c.getContext('2d');
                                  ctx.fillStyle='#f00';ctx.fillRect(602,390,1,1);}""")
                        return [{'frameId': 0, 'documentId': 'synthetic-document', 'result': value}]
                    raise AssertionError('Unexpected extension transport ' + op)

                await collector.expose_binding('nativeBridge', bridge)
                try:
                    await collector.bring_to_front()
                    await collector.evaluate("navigator.clipboard.writeText('old synthetic clipboard')")
                    outcome = await collector.evaluate(RUN, {'url': BOSS, 'fit': fit is not None, 'testExpansion': bool(options.get('folds'))})
                    result = outcome.get('result', {})
                    copies = await page.evaluate('window.copyEvents')
                    copy_commands = [params for method, params in calls
                                     if method == 'Input.dispatchKeyEvent' and params.get('type') == 'rawKeyDown'
                                     and params.get('commands') == ['copy']]
                    assert len(fits) == expected_fit, (label, 'fit budget', len(fits), outcome)
                    assert len(copies) == len(copy_commands) == (expected_copies if expected_copies is not None else int(accepted)), (label, copies, outcome)
                    expansions = await page.evaluate('window.expansionEvents')
                    assert len(expansions) == expected_expansions and all(item['trusted'] for item in expansions), (label, expansions, outcome)
                    if accepted:
                        assert not outcome.get('error') and not result.get('issue'), (label, outcome)
                        assert result['resume'] == TEXT and result['selection'] == 'single-copy', (label, result)
                        assert result['copyCount'] == 1 and result['completeness']['stableBottomReads'] == 1
                        assert copies[0]['trusted'] and copies[0]['start'] == 0, (label, copies)
                    else:
                        assert outcome.get('error') or result.get('issue'), (label, outcome)
                    assert surfaces, (label, 'no real inspector results')
                    first = next(value for action, value in surfaces if action == 'focus')
                    assert first['focused'] and first['canvasFocused'], (label, 'fixture focus failed', first)
                    if options.get('repaintAfterProof'):
                        assert first['contentWidthVisible'] is True, (label, 'first blank proof missing')
                        assert any(value.get('contentWidthVisible') is False for _, value in surfaces), (label, 'stale proof reused')
                    align_calls = [action for action, _ in surfaces if action == 'align-horizontal']
                    assert len(align_calls) <= 1 + int(bool(fits and fit)), (label, 'repeated X align', align_calls)
                    if options.get('horizontal'):
                        assert len(align_calls) == 1, (label, 'X align never performed')
                    if expect_start_hit is not None:
                        assert first['startHit'] is expect_start_hit, (label, first)
                    if expected_margin:
                        side, reason = expected_margin
                        assert first['diagnostics']['marginReason'][side] == reason, (label, first)
                        assert first['diagnostics']['reason'] == 'width_clipped', (label, first)
                    if expected_clip:
                        for side, amount in expected_clip.items():
                            assert abs(first['diagnostics'][side]-amount) <= 0.1, (label, first)
                    final = await page.evaluate("""()=>({scrollLeft:document.querySelector('#wrapper').scrollLeft,
                      zoom:document.querySelector('#wrapper').style.zoom,dpr:devicePixelRatio,
                      pressed:window.selection.down===true})""")
                    assert not final['pressed'], (label, 'mouse was not released')
                    assert final['scrollLeft'] == initial['scrollLeft'], (label, 'horizontal cleanup', initial, final)
                    assert final['zoom'] == initial['zoom'] and final['dpr'] == initial['dpr'], (label, 'unexpected zoom')
                    checks.append(label)
                    print(json.dumps({'case': label, 'copies': len(copies), 'fit_calls': len(fits)}), flush=True)
                finally:
                    # Each binding has one active target. Remove it by rebuilding
                    # the collector, leaving fixture pages fully disposable.
                    await page.close()
                    await collector.close()

            # A new collector per case keeps the native transport binding scoped.
            async def run_case(*args, **kwargs):
                nonlocal collector
                if collector.is_closed():
                    collector = await context.new_page()
                    await collector.goto(COLLECTOR)
                await case(*args, **kwargs)

            await run_case('baseline-one-trusted-copy')
            await run_case('covered-obsolete-corner-real-text-anchor-clear', {'corner': True}, expect_start_hit=False)
            await run_case('right-3px-white-blank-strip', {'width': 603}, expected_clip={'clipRight': 3})
            await run_case('left-3px-white-blank-strip', {'width': 603, 'translateX': -3},
                           expected_clip={'clipLeft': 3})
            await run_case('both-3px-blank-strips', {'width': 606, 'translateX': -3})
            await run_case('scrollbar-gutter-15px-is-blank', {'gutter': True}, expected_clip={'clipRight': 15})
            await run_case('css-zoom-80-percent-blank-edge', {'width': 603, 'zoom': 0.8})
            await run_case('css-zoom-125-percent-blank-edge', {'width': 603, 'zoom': 1.25})
            await run_case('double-backing-scale-blank-3px', {'width': 603, 'scale': 2})
            await run_case('fractional-width-and-double-backing-scale', {'width': 603.25, 'scale': 2})
            await run_case('maximum-32px-blank-strip', {'width': 632})
            await run_case('transparent-blank-strip', {'width': 603, 'transparent': True})
            await run_case('clipped-letter-rejects-before-copy', {'width': 603, 'cutText': True}, accepted=False)
            await run_case('one-nonuniform-pixel-rejects-before-copy', {'width': 603, 'pixel': [602, 390]}, accepted=False)
            await run_case('inside-2px-witness-detects-nearby-content', {'width': 603, 'pixel': [599, 390]}, accepted=False)
            await run_case('whole-height-proof-detects-offscreen-pixel',
                           {'width': 603, 'height': 800, 'pixel': [602, 750]}, accepted=False)
            await run_case('uniform-columns-are-not-one-uniform-strip', {'width': 603, 'column': True}, accepted=False)
            await run_case('blank-proof-is-rechecked-after-repaint', {'width': 603, 'repaintAfterProof': True}, accepted=False)
            await run_case('whole-height-budget-rejects-excessive-strip', {'width': 632, 'height': 30000}, accepted=False)
            await run_case('rotated-ancestor-cannot-prove-blank-strip', {'width': 603, 'rotate': 0.5},
                           accepted=False, expected_margin=('right', 'transform'))
            await run_case('border-box-cropped-ink-rejects-mismapped-strip',
                           {'width': 600, 'borderBox': True, 'translateX': -30, 'pixel': [35, 390]},
                           accepted=False, expected_margin=('left', 'box_model'))
            await run_case('padding-box-cropped-ink-rejects-mismapped-strip',
                           {'width': 600, 'paddingBox': True, 'translateX': -30, 'pixel': [35, 390]},
                           accepted=False, expected_margin=('left', 'box_model'))
            await run_case('object-fit-cannot-use-border-rect-as-bitmap', {'width': 603, 'objectFit': 'contain'},
                           accepted=False, expected_margin=('right', 'box_model'))
            await run_case('partial-alpha-is-not-blank-evidence', {'width': 603, 'partialAlpha': True}, accepted=False)
            await run_case('tainted-canvas-rejects-before-copy', {'width': 603, 'tainted': True}, accepted=False)
            await run_case('33px-clip-remains-blocked', {'width': 633}, accepted=False)
            await run_case('covered-real-end-remains-blocked', {'endCover': True}, accepted=False)
            await run_case('horizontal-align-once-and-restore', {'width': 580, 'horizontal': True, 'scrollLeft': 60})
            await run_case('wide-responsive-canvas-fits-once', {'width': 800, 'responsive': True}, fit=900, expected_fit=1)
            await run_case('wide-canvas-still-too-wide-after-fit', {'width': 960, 'responsive': True},
                           fit=900, expected_fit=1, accepted=False)
            await run_case('unavailable-fit-no-zoom-fallback', {'width': 800, 'responsive': True},
                           fit=0, expected_fit=1, accepted=False)
            await run_case('one-main-control-expands-once-and-copies-once', {'folds': [{'y': 350}]}, expected_expansions=1)
            await run_case('one-visual-control-expands-once-and-copies-once', {'folds': [{'y': 350, 'visual': True}]}, expected_expansions=1)
            await run_case('two-main-controls-keep-one-copy-and-report-fold', {'folds': [{'y': 350}, {'y': 375}]},
                           accepted=False, expected_copies=1)
            await run_case('two-visual-controls-keep-one-copy-and-report-fold',
                           {'folds': [{'y': 340, 'visual': True}, {'y': 370, 'visual': True}]},
                           accepted=False, expected_copies=1)
            await run_case('ambiguous-controls-but-complete-clipboard-succeeds-once',
                           {'folds': [{'y': 350}, {'y': 375}], 'clipboardComplete': True})
            await run_case('partial-main-control-never-clicked-one-copy-reports-fold',
                           {'height': 700, 'folds': [{'y': 405}]}, accepted=False, expected_copies=1)
            await run_case('partial-visual-control-never-clicked-one-copy-reports-fold',
                           {'height': 700, 'folds': [{'y': 388, 'visual': True}]}, accepted=False, expected_copies=1)
            await run_case('visible-plus-partial-main-expands-only-visible-once',
                           {'height': 700, 'folds': [{'y': 350}, {'y': 405}]},
                           accepted=False, expected_copies=1, expected_expansions=1)
            await run_case('offscreen-main-control-never-clicked-one-copy-reports-fold',
                           {'height': 700, 'folds': [{'y': 500}]}, accepted=False, expected_copies=1)
            await context.close()
        finally:
            await browser.close()
    return checks


def main():
    checks = asyncio.run(run_checks())
    print(json.dumps({'checks': len(checks), 'passed': len(checks), 'failed': [], 'cases': checks}))


if __name__ == '__main__':
    main()
