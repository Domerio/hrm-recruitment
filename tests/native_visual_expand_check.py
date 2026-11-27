"""Offline native canvas regression for zoom/DPR and clipped link coordinates."""
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    root = Path(__file__).resolve().parents[1]
    browser_path = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
    source = (root / 'extension/visual-expand.mjs').read_text('utf8').replace('export function', 'function')
    rows = json.loads((root / 'tests/fixtures/view-all-link-mask.json').read_text('utf8'))['rows']
    script = r"""({source,rows})=>{
      const run=new Function('location',source+';return visualExpandMarks();');
      const location={protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'};
      const glyph=document.createElement('canvas');glyph.width=Math.max(...rows.map(row=>row.length));glyph.height=rows.length;
      const g=glyph.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,glyph.width,glyph.height);g.fillStyle='#00a6a7';
      rows.forEach((row,y)=>[...row].forEach((ink,x)=>{if(ink==='#')g.fillRect(x,y,1,1);}));
      const checks=[];
      for(const dpr of [.8,1,1.25,1.5,2])for(const zoom of [.8,1,1.25,1.5]){
        document.body.innerHTML='';document.body.style.margin='0';
        const canvas=document.createElement('canvas');canvas.width=800*dpr;canvas.height=500*dpr;
        canvas.style.width='800px';canvas.style.height='500px';document.body.append(canvas);
        const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#fff';ctx.fillRect(0,0,800,500);
        ctx.drawImage(glyph,120,100,glyph.width*zoom,glyph.height*zoom);
        const marks=run(location),expected={x:(120+glyph.width*zoom/2)/800,y:(100+glyph.height*zoom/2)/500};
        checks.push({dpr,zoom,marks,passed:marks.length===1&&Math.abs(marks[0].x-expected.x)*800<3&&Math.abs(marks[0].y-expected.y)*500<3});
      }
      // The mark is relative to the complete canvas, not its cropped visible viewport.
      document.body.innerHTML='';const clipped=document.createElement('canvas');clipped.width=1600;clipped.height=1000;
      Object.assign(clipped.style,{width:'800px',height:'500px',position:'absolute',left:'-50px',top:'-20px'});document.body.append(clipped);
      const cc=clipped.getContext('2d');cc.scale(2,2);cc.fillStyle='#fff';cc.fillRect(0,0,800,500);cc.drawImage(glyph,120,100);
      const cropped=run(location);checks.push({kind:'cropped',marks:cropped,passed:cropped.length===1&&Math.abs(cropped[0].x-(120+glyph.width/2)/800)*800<3&&Math.abs(cropped[0].y-(100+glyph.height/2)/500)*500<3});
      // Similar-colored prose, solid bars, and partial glyphs must not become click targets.
      for(const text of ['查看全新','未来发展','查看全部未来发展']){
        cc.fillStyle='#fff';cc.fillRect(0,0,800,500);cc.fillStyle='#00a6a7';cc.font='18px Microsoft YaHei';cc.fillText(text,120,120);
        const marks=run(location);checks.push({kind:'prose',text,passed:marks.length===0,marks});
      }
      cc.fillStyle='#fff';cc.fillRect(0,0,800,500);cc.fillStyle='#00a6a7';cc.fillRect(120,100,70,17);
      checks.push({kind:'solid',passed:run(location).length===0});
      cc.fillStyle='#fff';cc.fillRect(0,0,800,500);cc.drawImage(glyph,0,0,40,glyph.height,120,100,40,glyph.height);
      checks.push({kind:'partial',passed:run(location).length===0});
      return checks;
    }"""
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=browser_path, headless=True)
        page = browser.new_page(viewport={'width':1000, 'height':700})
        page.route('**/*', lambda route: route.abort())
        checks = page.evaluate(script, {'source':source, 'rows':rows})
        browser.close()
    failed = [check for check in checks if not check['passed']]
    print(json.dumps({'checks':len(checks), 'passed':len(checks)-len(failed), 'failed':failed}, ensure_ascii=False))
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
