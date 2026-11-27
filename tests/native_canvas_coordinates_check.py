"""Offline Chromium proof for Canvas text calls that paint no pixels."""

import argparse
import html
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BROWSER = Path(os.environ.get("LOCALAPPDATA", "")) / (
    "ms-playwright/chromium_headless_shell-1228/"
    "chrome-headless-shell-win64/chrome-headless-shell.exe"
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", type=Path, default=DEFAULT_BROWSER)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not args.browser.is_file():
        raise SystemExit(f"Offline Chromium binary not found: {args.browser}")

    geometry = (ROOT / "extension/canvas-geometry.js").read_text(encoding="utf-8")
    observer = (ROOT / "extension/canvas-text.js").read_text(encoding="utf-8")
    js_value = lambda value: json.dumps(value, ensure_ascii=True).replace("</", "<\\/")
    script = f"const GEOMETRY={js_value(geometry)};const OBSERVER={js_value(observer)};" + r"""
window.__hrmCanvasTextEnabled=true;
new Function(GEOMETRY)();
new Function('location',OBSERVER)({protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'});
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
ctx.clearRect(0,0,canvas.width,canvas.height);
ctx.font='16px Arial';ctx.fillStyle='#000';
ctx.fillText('已记录正文',20,40);
const before=Uint8Array.from(ctx.getImageData(0,0,canvas.width,canvas.height).data);
const first=window.__hrmCanvasText.snapshot();
for(const args of [
  ['无绘制',NaN,80],['无绘制',Infinity,80],['无绘制',20,NaN],
  ['无绘制',20,80,NaN],['无绘制',20,80,Infinity],
  ['无绘制',20,80,0],['无绘制',20,80,-1],
])ctx.fillText(...args);
ctx.fillText('\u200B',20,80);
for(const mode of ['copy','destination-in']){
  ctx.globalCompositeOperation=mode;ctx.shadowColor='#000';ctx.shadowBlur=6;
  ctx.fillText('无绘制',NaN,80);
  ctx.fillText('无绘制',20,80,0);
}
ctx.globalCompositeOperation='source-over';ctx.shadowBlur=0;ctx.shadowColor='transparent';
const after=ctx.getImageData(0,0,canvas.width,canvas.height).data;
const unchanged=before.every((byte,index)=>byte===after[index]);
const second=window.__hrmCanvasText.snapshot();
ctx.rotate(.2);ctx.fillText('旋转正文',20,80);
const rotated=window.__hrmCanvasText.snapshot();
const result={unchanged,firstText:first.text,secondText:second.text,secondIssue:second.issue,
  coordinateCount:second.diagnostics.reasonCounts.find(item=>item.reason.includes('坐标或变换'))?.count||0,
  rotatedIssue:rotated.issue,rotatedReason:rotated.diagnostics.details.find(item=>item.kind==='text-coordinate')?.reason};
result.passed=unchanged&&first.text==='已记录正文'&&second.text===first.text&&
  !second.issue&&result.coordinateCount===0&&
  rotated.issue==='画布文字的坐标或变换无法确认'&&result.rotatedReason==='transform';
document.getElementById('native-result').textContent=JSON.stringify(result);
"""
    with tempfile.TemporaryDirectory(prefix="hrm-canvas-coordinate-") as temp:
        folder = Path(temp)
        page = folder / "probe.html"
        page.write_text(
            '<!doctype html><meta charset="utf-8"><canvas width="400" height="200" '
            'style="width:400px;height:200px"></canvas><pre id="native-result">pending</pre>'
            f"<script>{script}</script>", encoding="utf-8"
        )
        completed = subprocess.run(
            [str(args.browser), "--headless", "--dump-dom", "--disable-gpu",
             "--disable-extensions", "--disable-background-networking",
             "--host-resolver-rules=MAP * ~NOTFOUND", "--virtual-time-budget=500",
             f"--user-data-dir={folder / 'profile'}", page.as_uri()],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
        match = re.search(r'<pre id="native-result">(.*?)</pre>', completed.stdout, re.DOTALL)
        if not match:
            raise SystemExit(f"No native result (exit {completed.returncode}): {completed.stderr[-400:]}")
        result = json.loads(html.unescape(match.group(1)))
        print(json.dumps(result, ensure_ascii=False))
        if args.check and not result["passed"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
