"""Offline native Chromium probe for Canvas text runs with zero ink height."""

import html
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


BROWSER = Path(os.environ.get("LOCALAPPDATA", "")) / (
    "ms-playwright/chromium_headless_shell-1228/"
    "chrome-headless-shell-win64/chrome-headless-shell.exe"
)


def main():
    if not BROWSER.is_file():
        raise SystemExit(f"Headless Chromium not found: {BROWSER}")
    candidates = [
        "\r\n", "\n\r", " \u200b", "\u200b ", " \u200c", "\u200c ",
        " \u2060", "\u2060 ", "\u200b\t", "\t\u200b", "\u200b\u00a0",
        "\u00a0\u200b", "\u200b\u200c", "  ", "A", "中",
    ]
    script = """
const candidates=__CANDIDATES__;
const output=[];
function ink(text,stroke=false,shadow=false){
  const canvas=document.createElement('canvas');
  canvas.width=80;canvas.height=40;
  const ctx=canvas.getContext('2d');ctx.font='14px Arial';
  ctx.fillStyle='#000';ctx.strokeStyle='#000';ctx.lineWidth=2;
  if(shadow){ctx.shadowColor='#f00';ctx.shadowOffsetX=3;ctx.shadowOffsetY=3;ctx.shadowBlur=3;}
  (stroke?ctx.strokeText:ctx.fillText).call(ctx,text,20,20);
  const pixels=ctx.getImageData(0,0,80,40).data;
  let count=0;
  for(let i=3;i<pixels.length;i+=4)if(pixels[i])count++;
  return count;
}
const measure=document.createElement('canvas').getContext('2d');measure.font='14px Arial';
for(const text of candidates){
  const m=measure.measureText(text);
  output.push({codepoints:[...text].map(ch=>ch.codePointAt(0).toString(16)),
    trimmed:!!text.trim(),width:m.width,left:m.actualBoundingBoxLeft,
    right:m.actualBoundingBoxRight,ascent:m.actualBoundingBoxAscent,
    descent:m.actualBoundingBoxDescent,fillPixels:ink(text),
    shadowPixels:ink(text,false,true),strokePixels:ink(text,true)});
}
document.getElementById('result').textContent=JSON.stringify(output);
""".replace("__CANDIDATES__", json.dumps(candidates, ensure_ascii=True))
    with tempfile.TemporaryDirectory(prefix="hrm-canvas-ink-") as temp:
        folder = Path(temp)
        page = folder / "probe.html"
        page.write_text(
            "<!doctype html><meta charset='utf-8'><pre id='result'>pending</pre>"
            "<script>" + script + "</script>", encoding="utf-8"
        )
        command = [
            str(BROWSER), "--headless", "--dump-dom", "--disable-gpu",
            "--disable-extensions", "--disable-background-networking",
            "--disable-component-update", "--disable-sync", "--no-first-run",
            "--no-default-browser-check", "--no-pings",
            "--host-resolver-rules=MAP * ~NOTFOUND", "--virtual-time-budget=1000",
            f"--user-data-dir={folder / 'profile'}", page.as_uri(),
        ]
        completed = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        match = re.search(r'<pre id="result">(.*?)</pre>', completed.stdout, re.DOTALL)
        if not match:
            raise RuntimeError(f"Native probe failed: {completed.stderr[-1000:]}")
        rows = json.loads(html.unescape(match.group(1)))
    print(json.dumps(rows, indent=2, ensure_ascii=False))
    matching = [row for row in rows if len(row["codepoints"]) == 2
                and row["trimmed"] and abs(row["width"] - 3.89) < .01
                and row["ascent"] == 0 and row["descent"] == 0]
    if not matching or any(row["fillPixels"] for row in matching):
        raise SystemExit("Expected two-character zero-ink match was not verified")


if __name__ == "__main__":
    main()
