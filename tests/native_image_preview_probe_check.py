"""Offline native DOM checks for the optional image-preview probe.

Uses the real DOM adapter and automation in intercepted synthetic BOSS documents.
The legacy probe below is the exact pre-fix implementation, retained solely to
measure its 20,000-element / 100 ms hard failure against the same real DOM.
No account, real resume, network service, installation or native user window.
"""
import json
import os
from pathlib import Path
from statistics import median
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OWNER = 'https://www.zhipin.com/web/geek/recommend'
BODY = 'https://www.zhipin.com/web/frame/c-resume/?native=preview'
LEGACY = r'''  function imagePreviewContainer(element){
    if(element.matches('button,a,img,picture,video,audio,[role="button"]'))return false;
    const value=['class','id','aria-label','title','data-role'].map(name=>element.getAttribute(name)||'').join(' ')
      .replace(/([a-z])([A-Z])/g,'$1-$2').toLowerCase();
    // Explicit preview semantics only: a generic popover, avatar or dialog is
    // not sufficient evidence that closing it leaves the resume open.
    if(/(?:^|[\s_-])(?:trigger|opener|thumbnail)(?:$|[\s_-])/.test(value))return false;
    return /(?:^|[\s_-])(?:avatar|portrait|photo|image|img)[\s_-]+(?:preview|viewer|popover)(?:$|[\s_-])/.test(value)||
      /(?:^|[\s_-])(?:preview|viewer|popover)[\s_-]+(?:avatar|portrait|photo|image|img)(?:$|[\s_-])/.test(value)||
      /(?:头像|照片|图片|相片)(?:预览|大图)|(?:预览|查看)(?:头像|照片|图片|相片)(?:大图)?/.test(value);
  }
  function probeImagePreview(){
    const pending=document.body?[document.body]:[],seen=new Set(),started=Date.now();
    let visited=0;
    while(pending.length){
      const element=pending.pop();
      if(seen.has(element))continue;seen.add(element);
      if(++visited>20000||(visited%128===0&&Date.now()-started>100))
        throw Error('图片预览检查范围过大或耗时过长，请手动关闭预览后重试');
      // The common no-preview path reads only attributes and tree links. It
      // does not build rendered text or compute styles for every list card.
      if(imagePreviewContainer(element)&&visible(element))return {present:true};
      const assigned=element.tagName==='SLOT'?element.assignedElements?.({flatten:true}):null;
      const children=assigned?.length?assigned:(D.shadow(element)||element).children;
      if(children)for(let i=children.length-1;i>=0;i--)pending.push(children[i]);
    }
    return {present:false};
  }
'''
OWNER_HTML = '''<!doctype html><meta charset="utf-8"><style>
html,body{margin:0}#background article{height:18px}
.dialog-lib-resume{position:fixed;inset:40px;background:white;z-index:10}
iframe{width:800px;height:500px;border:0}
.avatar-preview{position:fixed;left:300px;top:120px;width:400px;height:300px;background:#eee;z-index:50}
.avatar-preview img{position:absolute;left:20px;top:50px;width:280px;height:200px}
.avatar-preview button{position:absolute;right:12px;top:12px;width:28px;height:28px}
</style><main id="background"></main>
<div class="dialog-lib-resume" role="dialog"><div class="resume-detail-wrap">
<iframe src="BODY_URL"></iframe></div></div>'''.replace('BODY_URL', BODY)
BODY_HTML = '''<!doctype html><meta charset="utf-8"><style>
canvas{width:600px;height:400px}#long-content p{margin:0;height:14px}
.avatar-preview{position:fixed;left:100px;top:50px;width:400px;height:300px;background:#eee;z-index:50}
.avatar-preview img{position:absolute;left:20px;top:50px;width:280px;height:200px}
.avatar-preview button{position:absolute;right:12px;top:12px;width:28px;height:28px}
</style><canvas width="600" height="400"></canvas><div id="long-content"></div>'''
METRICS = r"""()=>{
 window.metrics={attributes:0,styles:0,rects:0,semanticChecks:0,queries:0,queryResults:0};
 const attr=Element.prototype.getAttribute,match=Element.prototype.matches,
   rect=Element.prototype.getBoundingClientRect,style=window.getComputedStyle;
 Element.prototype.getAttribute=function(...args){window.metrics.attributes++;return attr.apply(this,args);};
 Element.prototype.matches=function(selector){
   if(selector==='button,a,img,picture,video,audio,[role="button"]')window.metrics.semanticChecks++;
   return match.call(this,selector);
 };
 Element.prototype.getBoundingClientRect=function(...args){window.metrics.rects++;return rect.apply(this,args);};
 window.getComputedStyle=(...args)=>{window.metrics.styles++;return style(...args);};
 for(const proto of [Document.prototype,Element.prototype,ShadowRoot.prototype]){
   const query=proto.querySelectorAll;
   proto.querySelectorAll=function(...args){const result=query.apply(this,args);
     window.metrics.queries++;window.metrics.queryResults+=result.length;return result;};
 }
 window.zeroMetrics=()=>{for(const key of Object.keys(window.metrics))window.metrics[key]=0;};
 window.fixtureClicks=0;
 window.addPreview=({shadow=false,blocked=false,form=false,hidden=false,extra=false}={})=>{
   const preview=document.createElement('div');preview.className='avatar-preview';preview.setAttribute('role','dialog');
   preview.style.cssText='position:fixed;left:300px;top:120px;width:400px;height:300px;background:#eee;z-index:50';
   preview.innerHTML='<img style="position:absolute;left:20px;top:50px;width:280px;height:200px" alt="头像大图" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22280%22 height=%22200%22%3E%3Crect width=%22280%22 height=%22200%22 fill=%22blue%22/%3E%3C/svg%3E">'+
     '<button aria-label="关闭" style="position:absolute;right:12px;top:12px;width:28px;height:28px">×</button>';
   const scope=document.querySelector('.dialog-lib-resume')||document.body;
   if(shadow){const host=document.createElement('section');scope.append(host);
     const root=host.attachShadow({mode:'open'});root.append(preview);window.previewHost=host;
   }else scope.append(preview);
   if(hidden)preview.hidden=true;
   if(form){const input=document.createElement('input');preview.append(input);}
   if(extra){const action=document.createElement('button');action.textContent='其它操作';preview.append(action);}
   preview.querySelector('button').addEventListener('click',()=>{window.fixtureClicks++;preview.remove();});
   if(blocked){const cover=document.createElement('div');
     cover.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.1);z-index:100';document.body.append(cover);}
   window.fixturePreview=preview;
 };
}"""
MEASURE = r"""async ({legacy=false,args={},action='probe-image-preview'})=>{
 window.zeroMetrics();const start=performance.now();let result,error;
 try{result=legacy?window.legacyProbe():await window.__hrmAuto.run(action,args);}
 catch(value){error=String(value.message||value);}
 return {ms:performance.now()-start,result:result||null,error:error||'',metrics:{...window.metrics},
   clicks:window.fixtureClicks};
}"""


def run_checks():
    sources = [(ROOT / 'extension' / name).read_text(encoding='utf-8')
               for name in ['dom-reader.js', 'automation.js']]
    checks = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'), headless=True,
            args=['--disable-background-networking', '--disable-component-update', '--disable-sync',
                  '--host-resolver-rules=MAP * ~NOTFOUND'])
        try:
            context = browser.new_context(viewport={'width': 1100, 'height': 750})
            context.route('**/*', lambda route: route.fulfill(
                status=200, content_type='text/html',
                body=OWNER_HTML if route.request.url == OWNER else BODY_HTML)
                if route.request.url in [OWNER, BODY] else route.abort())

            def fixture():
                page = context.new_page()
                page.goto(OWNER)
                frame = page.frames[1]
                frame.wait_for_selector('canvas')
                for surface in [page, frame]:
                    for source in sources:
                        surface.evaluate(source)
                    surface.evaluate(METRICS)
                    surface.evaluate('(()=>{const D=window.__hrmDom,visible=D.visible;' +
                                     LEGACY + ';window.legacyProbe=probeImagePreview;})()')
                return page, frame

            def record(name, result):
                checks.append({'case': name, **result})
                print(json.dumps(checks[-1], ensure_ascii=False), flush=True)

            page, frame = fixture()
            # 40,001 background elements, all genuine DOM nodes. A fixed
            # current detail is near the end of document order.
            page.evaluate("""()=>{document.querySelector('#background').innerHTML=
              '<article><span>合成候选样本</span><p>列表摘要</p><i>状态</i></article>'.repeat(10000);}""")
            page.evaluate('document.body.offsetHeight')
            legacy = page.evaluate(MEASURE, {'legacy': True})
            assert legacy['error'] and ('范围过大' in legacy['error'] or '耗时过长' in legacy['error']), legacy
            modern = [page.evaluate(MEASURE, {}) for _ in range(5)]
            assert all(not value['error'] and value['result'] == {'present': False} for value in modern), modern
            assert max(value['metrics']['attributes'] for value in modern) < 1000, modern
            assert all(value['clicks'] == 0 for value in modern)
            record('large-background-40000-elements', {
                'legacy': legacy, 'modern_ms_median': median(item['ms'] for item in modern),
                'modern_ms_max': max(item['ms'] for item in modern),
                'modern_max_attributes': max(item['metrics']['attributes'] for item in modern),
                'modern_max_styles': max(item['metrics']['styles'] for item in modern),
                'modern': modern[0]})
            cdp = context.new_cdp_session(page)
            cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
            try:
                slow_legacy = page.evaluate(MEASURE, {'legacy': True})
                slow_modern = [page.evaluate(MEASURE, {}) for _ in range(3)]
                assert slow_legacy['error'], slow_legacy
                assert all(not item['error'] and item['result'] == {'present': False} for item in slow_modern), slow_modern
                record('same-large-background-native-4x-cpu-throttle', {
                    'legacy': slow_legacy, 'modern_ms_median': median(item['ms'] for item in slow_modern),
                    'modern': slow_modern[0]})
            finally:
                cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1})
            page.close()

            page, frame = fixture()
            # A long pinned document may exhaust the optional probe budget.
            # It must say unknown, never assert absence or dispatch a close.
            frame.evaluate("""()=>{document.querySelector('#long-content').innerHTML=
              '<p>离线合成长简历正文，不含任何图片预览。</p>'.repeat(24000);}""")
            legacy = frame.evaluate(MEASURE, {'legacy': True})
            modern = frame.evaluate(MEASURE, {})
            assert legacy['error'], legacy
            assert not modern['error'] and modern['result'].get('uncertain') is True, modern
            assert modern['result']['present'] is False and modern['result']['reason'] == 'budget', modern
            assert modern['metrics']['semanticChecks'] <= 4097, modern
            assert modern['clicks'] == 0, modern
            record('long-resume-budget-is-unknown-without-click', {'legacy': legacy, 'modern': modern})
            dismissal = frame.evaluate(MEASURE, {'action': 'dismiss-image-preview'})
            assert not dismissal['error'] and dismissal['result'].get('uncertain') is True, dismissal
            assert dismissal['result']['dismissed'] is False and dismissal['clicks'] == 0, dismissal
            record('dismiss-budget-does-not-trigger-identity-or-click', dismissal)
            page.close()

            page, frame = fixture()
            frame.evaluate("""()=>{const root=document.querySelector('#long-content');
              let level=[root];for(let depth=0;depth<12;depth++){
                const next=[];for(const node of level)for(let side=0;side<2;side++){
                  const child=document.createElement('div');node.append(child);next.push(child);
                }level=next;
              }}""")
            measured = frame.evaluate(MEASURE, {})
            assert not measured['error'] and measured['result'].get('uncertain') is True, measured
            assert measured['result']['reason'] == 'budget' and measured['clicks'] == 0, measured
            assert measured['metrics']['semanticChecks'] <= 4096 and measured['metrics']['styles'] == 0, measured
            record('nested-scope-node-budget-upper-bound', measured)
            page.close()

            page, frame = fixture()
            page.evaluate("""()=>{const other=document.createElement('section');other.className='dialog-lib-resume';other.setAttribute('role','dialog');
              other.style.cssText='position:fixed;left:10px;top:10px;width:50px;height:50px';document.body.append(other);}""")
            measured = page.evaluate(MEASURE, {})
            assert not measured['error'] and measured['result'] == {'present': False, 'uncertain': True, 'reason': 'scope'}, measured
            assert measured['clicks'] == 0, measured
            record('ambiguous-foreground-scopes-remain-unknown', measured)
            page.close()

            for mode in ['normal', 'hidden', 'shadow', 'blocked', 'form', 'extra', 'stale-token', 'stale-binding', 'external-dialog', 'replaced-frame']:
                page, frame = fixture()
                observed = page.evaluate("window.__hrmAuto.run('current-detail')")
                assert observed['kind'] == 'canvas-owner' and observed['token'], observed
                options = {mode: True} if mode in ['hidden', 'shadow', 'blocked', 'form', 'extra'] else {}
                page.evaluate('options=>window.addPreview(options)', options)
                if mode == 'external-dialog':
                    page.evaluate("""()=>{const other=document.createElement('section');other.setAttribute('role','alertdialog');
                      other.style.cssText='position:fixed;left:20px;top:20px;width:100px;height:100px;background:white';document.body.append(other);}""")
                elif mode == 'replaced-frame':
                    page.evaluate("""()=>{const frame=document.querySelector('iframe');frame.replaceWith(frame.cloneNode(true));}""")
                    page.frames[-1].wait_for_selector('canvas')
                page.wait_for_timeout(10)
                probe = page.evaluate(MEASURE, {})
                if mode == 'replaced-frame':
                    assert not probe['error'] and probe['result'] == {'present': False, 'uncertain': True, 'reason': 'scope'}, probe
                else:
                    assert not probe['error'] and probe['result']['present'] is (mode != 'hidden'), (mode, probe)
                if mode == 'stale-token':
                    observed['token'] += '-stale'
                elif mode == 'stale-binding':
                    observed['binding']['ownerUrl'] += '?another-candidate'
                dismissal = page.evaluate(MEASURE, {'action': 'dismiss-image-preview', 'args': observed})
                if mode == 'normal':
                    assert not dismissal['error'] and dismissal['result'] == {'dismissed': True}, dismissal
                    assert dismissal['clicks'] == 1, dismissal
                    after = page.evaluate(MEASURE, {'action': 'dismiss-image-preview', 'args': observed})
                    assert not after['error'] and after['result'] == {'dismissed': False} and after['clicks'] == 1, after
                elif mode == 'replaced-frame':
                    assert dismissal['error'] and dismissal['clicks'] == 0, dismissal
                    assert '切换' in dismissal['error'], dismissal
                elif mode == 'shadow':
                    assert (dismissal['error'] and dismissal['clicks'] == 0) or (
                        not dismissal['error'] and dismissal['result'] == {'dismissed': True} and dismissal['clicks'] == 1), dismissal
                elif mode == 'hidden':
                    assert not dismissal['error'] and dismissal['result'] == {'dismissed': False}, dismissal
                    assert dismissal['clicks'] == 0, dismissal
                else:
                    assert dismissal['error'] and dismissal['clicks'] == 0, (mode, dismissal)
                record('preview-' + mode, {'probe': probe, 'dismissal': dismissal})
                page.close()
            page, frame = fixture()
            page.evaluate("""()=>{document.body.innerHTML='<section class="resume"><h2>张**</h2>'+
              '<p>39岁 本科 10年 离职-随时到岗</p><h3>工作经历</h3><p>合成设备公司算法工程师，负责工业视觉开发。</p>'+
              '<h3>项目经历</h3><p>产线检测算法、设备调试和系统开发项目。</p>'+
              '<h3>教育经历</h3><p>合成大学计算机专业本科。</p>'+
              '<p>合成岗位工作记录。</p>'.repeat(5000)+'</section>';}""")
            observed = page.evaluate("window.__hrmAuto.run('current-detail')")
            assert observed['kind'] == 'text' and observed['token'], {'kind': observed['kind']}
            measured = page.evaluate(MEASURE, {})
            assert not measured['error'] and measured['result'] == {'present': False}, measured
            assert 4096 < measured['metrics']['semanticChecks'] < 20000, measured
            assert measured['clicks'] == 0, measured
            record('recognized-roleless-text-resume-keeps-20000-budget', measured)
            page.close()
            context.close()
        finally:
            browser.close()
    return checks


def main():
    checks = run_checks()
    print(json.dumps({'checks': len(checks), 'passed': len(checks), 'failed': []}))


if __name__ == '__main__':
    main()
