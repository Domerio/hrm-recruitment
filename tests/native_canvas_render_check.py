"""Offline native RAF probe in a hidden iframe, using an existing Chromium binary.

Uses an isolated empty profile and a local synthetic page. This checks an actual
stalled native RAF queue, not the live BOSS account or OS window occlusion.
"""
import html
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def main():
    root = Path(__file__).resolve().parents[1]
    browser = Path(os.environ['LOCALAPPDATA']) / 'ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'
    if not browser.is_file():
        raise RuntimeError('Existing offline Chromium binary unavailable')
    directory = Path(tempfile.mkdtemp(prefix='hrm-native-render-'))
    source = (root / 'extension/canvas-render.js').read_text(encoding='utf-8')
    frame_script = """
    new Function('location',SOURCE)({protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'});
    const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
    window.__hrmBackgroundRead={token:'offline-test',canvas};
    window.drawn=0;
    // Chromium can deliver one initial frame before iframe visibility is
    // committed. Keep the next original request queued to observe the stall.
    function draw(){
      window.drawn++;ctx.clearRect(0,0,300,80);ctx.fillText('original queued render '+window.drawn,10,30);
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    window.inspect=()=>({drawn:window.drawn,ink:ctx.getImageData(0,0,300,80).data.some((n,i)=>i%4===3&&n>0)});
    """.replace('SOURCE', json.dumps(source, ensure_ascii=True).replace('</', '<\\/'))
    child = '<!doctype html><canvas width="300" height="80"></canvas><script>' + frame_script + '</script>'
    script = """
    window.__hrmCanvasTextEnabled=true;
    const frame=document.createElement('iframe');frame.style.display='none';
    frame.onload=()=>setTimeout(()=>{
      try {
        const w=frame.contentWindow,before=w.inspect(),stats=w.__hrmCanvasRender.pump('offline-test'),after=w.inspect();
        w.__hrmCanvasRender.pump('offline-test');
        const twice=w.inspect();delete w.__hrmBackgroundRead;w.__hrmCanvasRender.stop();
        document.getElementById('result').textContent=JSON.stringify({before,stats,after,twice,
          passed:stats.pumpedFrames===1&&stats.pending===1&&after.drawn===before.drawn+1&&after.ink&&twice.drawn===after.drawn});
      } catch(error) {document.getElementById('result').textContent=JSON.stringify({error:String(error)});}
    },400);
    frame.srcdoc=CHILD;document.body.append(frame);
    """.replace('CHILD', json.dumps(child, ensure_ascii=True).replace('</', '<\\/'))
    page = directory / 'probe.html'
    page.write_text('<!doctype html><meta charset="utf-8"><body><pre id="result">pending</pre><script>' + script + '</script>', encoding='utf-8')
    command = [str(browser), '--headless', '--dump-dom', '--disable-gpu', '--disable-extensions',
               '--disable-background-networking', '--disable-component-update', '--disable-sync',
               '--no-first-run', '--no-default-browser-check', '--no-pings',
               '--host-resolver-rules=MAP * ~NOTFOUND', '--virtual-time-budget=2000',
               f'--user-data-dir={directory / "empty-profile"}', page.as_uri()]
    result = subprocess.run(command, capture_output=True, encoding='utf-8', errors='replace', timeout=30,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    (directory / 'dump.html').write_text(result.stdout, encoding='utf-8')
    (directory / 'stderr.log').write_text(result.stderr, encoding='utf-8')
    match = re.search(r'<pre id="result">(.*?)</pre>', result.stdout, re.DOTALL)
    evidence = json.loads(html.unescape(match.group(1))) if match else {'error':'No result'}
    print(json.dumps({'artifacts':str(directory), **evidence}))
    if not evidence.get('passed'):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
