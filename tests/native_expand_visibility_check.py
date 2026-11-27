"""Native Canvas expansion visibility checks using only synthetic offline pages.

Run: python tests/native_expand_visibility_check.py
Uses production paint observer, visual matcher and inspectCopyFrame with real
Chromium pixels, overflow clipping and elementFromPoint. No account or network.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run_checks():
    source = (ROOT / 'extension/resume-copy.mjs').read_text(encoding='utf-8')
    start = source.index('export function inspectCopyFrame(')
    end = source.index('function canvasExpandMarks()', start)
    inspect = source[start:end].replace('export function', 'function', 1)
    expand = (ROOT / 'extension/canvas-expand.js').read_text(encoding='utf-8')
    visual = (ROOT / 'extension/visual-expand.mjs').read_text(encoding='utf-8').replace(
        'export function', 'function', 1)
    rows = json.loads((ROOT / 'tests/fixtures/view-all-link-mask.json').read_text(encoding='utf-8'))['rows']
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),
                                             headless=True, args=['--disable-background-networking'])
        try:
            page = browser.new_page(viewport={'width': 900, 'height': 700})
            page.route('**/*', lambda route: route.fulfill(
                status=200, content_type='text/html',
                body='''<!doctype html><meta charset="utf-8"><style>
                body{margin:0}#wrap{height:380px;width:600px;overflow:hidden;margin:20px}
                canvas{display:block;width:600px;height:700px}</style>
                <div id="wrap"><canvas width="600" height="700"></canvas></div>'''))
            page.goto('https://www.zhipin.com/web/frame/c-resume')
            page.evaluate(expand)
            page.evaluate('(()=>{' + inspect + ';window.inspect=inspectCopyFrame})()')
            page.evaluate('(()=>{' + visual + ';window.visual=visualExpandMarks})()')
            return page.evaluate(r"""rows=>{
              const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),checks=[];
              const glyph=document.createElement('canvas');
              glyph.width=Math.max(...rows.map(row=>row.length));glyph.height=rows.length;
              const g=glyph.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,glyph.width,glyph.height);
              g.fillStyle='#00a6a7';
              rows.forEach((row,y)=>[...row].forEach((ink,x)=>{if(ink==='#')g.fillRect(x,y,1,1);}));
              const reset=()=>{
                canvas.width=600;canvas.height=700;
                ctx.fillStyle='#fff';ctx.fillRect(0,0,600,700);
                ctx.font='18px Microsoft YaHei';ctx.fillStyle='#00a6a7';
              };
              const paint=y=>ctx.fillText('查看全部',80,y);
              const record=(name,visual,expectedMarks,expectedPoints)=>{
                const marks=visual?window.visual():window.__hrmExpandMarks.readVerified();
                const points=window.inspect('expand-points',marks);
                const legacy=window.inspect('expand-points',marks.map(({id,label,x,y})=>({id,label,x,y})));
                const partial=name.includes('partial')||name.includes('partly-clipped');
                checks.push({name,marks:marks.length,points:points.length,legacyCenterOnlyPoints:legacy.length,
                  expectedMarks,expectedPoints,
                  passed:marks.length===expectedMarks&&points.length===expectedPoints&&(!partial||legacy.length>points.length)});
              };
              reset();paint(250);record('one-painted-control',false,1,1);
              reset();for(let i=0;i<10;i++)paint(250);
              record('ten-identical-full-paints-still-one-control',false,1,1);
              reset();
              for(let iteration=0;iteration<5;iteration++){
                let x=80;for(const char of '查看全部'){
                  ctx.fillText(char,x,250);x+=ctx.measureText(char).width;
                }
              }
              record('five-per-glyph-repaints-still-one-control',false,1,1);
              reset();paint(250);ctx.strokeStyle='#00a6a7';ctx.strokeText('查看全部',80,250);
              record('fill-and-stroke-one-control',false,1,1);
              reset();paint(200);paint(250);record('two-real-controls-remain-distinct',false,2,2);
              reset();paint(385);record('partly-clipped-control-center-is-not-enough',false,1,0);
              reset();paint(500);record('offscreen-control-is-not-clickable',false,1,0);
              reset();paint(250);paint(385);record('visible-control-plus-partial-is-one-clickable-target',false,2,1);
              reset();ctx.drawImage(glyph,80,250);record('one-visual-mask',true,1,1);
              reset();for(let i=0;i<10;i++)ctx.drawImage(glyph,80,250);
              record('ten-identical-mask-paints-still-one-match',true,1,1);
              reset();ctx.drawImage(glyph,80,368);record('visual-partial-control-must-not-click',true,1,0);
              reset();ctx.drawImage(glyph,80,250);ctx.drawImage(glyph,80,368);
              record('visual-visible-plus-partial-is-one-clickable-target',true,2,1);
              reset();ctx.drawImage(glyph,80,250);ctx.drawImage(glyph,80,500);
              record('visual-offscreen-paint-filtered-by-real-hit-test',true,2,1);
              return checks;
            }""", rows)
        finally:
            browser.close()


def main():
    checks = run_checks()
    failed = [case for case in checks if not case['passed']]
    print(json.dumps({'checks': len(checks), 'passed': len(checks)-len(failed),
                      'failed': failed, 'cases': checks}, ensure_ascii=False))
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
