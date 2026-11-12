"""Synthetic canvas + local OCR browser regression; never stores candidates."""
import base64
import json
import secrets
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from local_ocr import recognize_png
TOKEN=secrets.token_hex(20)
ORIGIN='http://127.0.0.1:8878'
HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Canvas 简历读取测试</title>
<style>body{font:16px/1.6 sans-serif;margin:24px;min-width:780px}button{padding:12px}pre{background:#edf7f5;padding:16px;white-space:pre-wrap}iframe{width:760px;height:500px;border:1px solid #ccc}</style>
<h2>Canvas 内部滚动测试 · 虚构资料</h2><button id="run">验证展开、技能标签与底部文字</button><pre id="result">等待测试</pre><iframe title="虚构在线简历" src="/web/frame/c-resume/?virtual=1"></iframe>
<script>document.querySelector('#run').onclick=()=>{document.querySelector('#result').textContent='正在测试…';document.querySelector('iframe').contentWindow.postMessage('run',location.origin);};addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow)document.querySelector('#result').textContent=JSON.stringify(e.data,null,2);});</script></html>'''
FRAME='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0}canvas{display:block}</style><canvas width="730" height="1250"></canvas>
<script src="/dom-reader.js"></script><script src="/canvas-reader.js"></script><script type="module">
import {expandControls,mergeOcrScreens,createReadTracker} from '/ocr-utils.mjs';
const virtual=new URLSearchParams(location.search).has('virtual');
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');let expanded=false,offset=370;
if(virtual){canvas.height=500;document.body.style.height='500px';document.body.style.overflow='hidden';}
function draw(){
ctx.fillStyle='white';ctx.fillRect(0,0,730,1250);ctx.save();if(virtual)ctx.translate(0,-offset);ctx.fillStyle='#222';ctx.font='20px Microsoft YaHei';
ctx.fillText('测试杜**   虚构在线简历',30,45);ctx.fillText('个人优势：计算机视觉、图像处理与算法开发。',30,90);
if(!expanded){ctx.fillStyle='#009e9e';ctx.fillText('查看全部',580,130);}else{ctx.fillStyle='#222';ctx.fillText('展开后的隐藏内容：相机标定和缺陷检测。',30,130);}
ctx.fillStyle='#222';ctx.fillText('工作经历',30,205);
for(let i=0;i<12;i++)ctx.fillText('测试项目 '+(i+1)+'：负责软件设计、现场调试与项目交付。',30,250+i*65);
ctx.fillText('教育经历：虚构大学，计算机专业。',30,1100);ctx.fillText('底部证书：软件设计师。',30,1200);
ctx.font='12px Microsoft YaHei';for(const [i,label] of ['图像处理','yolo','visionmaster','visionpro'].entries()){ctx.fillStyle='#f3f3f3';ctx.fillRect(30+i*115,1030,105,26);ctx.fillStyle='#666';ctx.fillText(label,35+i*115,1048);}ctx.restore();
}
draw();canvas.addEventListener('click',e=>{const y=e.clientY+(virtual?offset:scrollY);if(e.clientX>=570&&e.clientX<=700&&y>=105&&y<=140){expanded=true;draw();}});
canvas.addEventListener('wheel',e=>{if(virtual){e.preventDefault();offset=Math.max(0,Math.min(750,offset+e.deltaY));draw();}},{passive:false});
addEventListener('message',async e=>{if(e.source!==parent||e.origin!==location.origin||e.data!=='run')return;
const screens=[],tracker=createReadTracker();let bottom=false,expandClicks=0,reportedComplete=false,previous='',cached=null;
try{let state=await window.__hrmCanvas.run('prepare');
for(let i=0;i<25;i++){
const shot=await window.__hrmCanvas.run('capture');if(shot.fallback)throw Error('fixture canvas pixels unavailable');state=shot.state;
const same=shot.image===previous,progress=tracker.observe(shot.image,state);let result=cached;
if(!same){const response=await fetch('/ocr',{method:'POST',headers:{'Content-Type':'application/json','X-Test-Token':'TOKEN'},body:JSON.stringify({image:shot.image})});result=await response.json();if(!response.ok)throw Error(result.error);}
previous=shot.image;cached=result;
const control=expandControls(result.lines)[0];if(control&&expandClicks<2){state=await window.__hrmCanvas.run('expand',{...control,x:state.rect.x+control.x/shot.scale,y:state.rect.y+control.y/shot.scaleY,top:state.top});expandClicks++;tracker.reset();continue;}
if(!same)screens.push(result.text);if(progress.done){bottom=virtual?offset>=750:state.atBottom;reportedComplete=progress.confirmed;break;}state=await window.__hrmCanvas.run('next');}
const text=mergeOcrScreens(screens),tags=['图像处理','yolo','visionmaster','visionpro'].every(s=>text.toLowerCase().includes(s));
parent.postMessage({status:bottom&&tags&&text.includes('相机标定')&&text.includes('软件设计师')&&(!virtual||!reportedComplete)?'通过':'需检查',scrollMode:state.scrollMode,screens:screens.length,expandClicks,expandedText:text.includes('相机标定'),allFourTags:tags,bottomText:text.includes('软件设计师'),reachedFixtureBottom:bottom,reportedComplete},location.origin);
}catch(error){parent.postMessage({error:error.message},location.origin);}finally{await window.__hrmCanvas.run('finish');}
});</script></html>'''.replace('TOKEN',TOKEN)

class Handler(BaseHTTPRequestHandler):
    def send(self,status,body,kind='application/json; charset=utf-8'):
        self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_GET(self):
        path=urlsplit(self.path).path
        if path in ['/','/dom','/web/frame/c-resume/']:
            body=FRAME if path=='/web/frame/c-resume/' else HTML
            if path=='/dom':body=body.replace('?virtual=1','').replace('Canvas 内部滚动测试','Canvas 网页滚动测试')
            return self.send(200,body.encode(),'text/html; charset=utf-8')
        if self.path not in ['/dom-reader.js','/canvas-reader.js','/ocr-utils.mjs']:return self.send(404,b'{}')
        code=(ROOT/'extension'/self.path[1:]).read_text(encoding='utf-8')
        if self.path=='/canvas-reader.js':
            gate="if(location.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(location.hostname)||!/^\\/web\\/frame\\/c-resume\\/?$/.test(location.pathname))return;"
            assert gate in code
            code=code.replace(gate,"if(location.origin!=='http://127.0.0.1:8878')return;")
        self.send(200,code.encode(),'text/javascript; charset=utf-8')
    def do_POST(self):
        if self.path!='/ocr' or self.headers.get('Origin')!=ORIGIN or self.headers.get('X-Test-Token')!=TOKEN:return self.send(403,b'{}')
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<3_000_000:raise ValueError('size')
            value=json.loads(self.rfile.read(size))['image']
            if not value.startswith('data:image/png;base64,'):raise ValueError('PNG only')
            result=recognize_png(base64.b64decode(value.split(',')[1],validate=True))
            self.send(200,json.dumps(result,ensure_ascii=False).encode())
        except Exception as error:self.send(400,json.dumps({'error':str(error)},ensure_ascii=False).encode())
    def log_message(self,*args):pass

if __name__=='__main__':
    print(ORIGIN,flush=True);HTTPServer(('127.0.0.1',8878),Handler).serve_forever()
