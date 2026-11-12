"""Isolated manual browser regression fixture. Never serves data or credentials.
Run: python tests/picker_preview.py; inspect http://127.0.0.1:8876/.
Only the URL gate is removed in the served fixture copy; production stays BOSS-only.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Picker regression fixture</title>
<style>body{font:16px sans-serif;margin:35px}button{padding:12px;margin:10px}.candidate-card,.candidate-detail{border:2px solid #ccc;margin:30px 0;padding:24px;width:500px}.name{font-weight:bold}.resume{margin-top:20px}pre{white-space:pre-wrap}</style>
<h1>点选拦截测试（虚构资料）</h1>
<button id="start-root">点选卡片</button><button id="start-name">点选姓名</button><button id="start-resume">点选履历</button><button id="start-detail">点选详情区域</button><button id="read">读取当前框架</button>
<p id="events">页面事件：0</p><p id="result">尚未保存</p>
<article class="candidate-card"><span class="name">测试候选人</span><div class="resume">虚构测试资料：具备四年机器视觉算法开发经验，使用 C++ 和 OpenCV，负责图像定位和坐标变换。本条只用于验证页面工具。</div><button class="forward">转发（测试计数）</button></article>
<article class="candidate-detail"><span class="name">详情测试候选人</span><div class="resume">虚构详情内容：负责机器视觉检测项目，开发定位算法，完成图像处理软件设计与现场部署；此处为测试区域，不含任何真实候选人。</div></article>
<pre id="stored"></pre><script>
const db={};let events=0;
window.chrome={storage:{local:{get:async()=>structuredClone(db),set:async v=>{Object.assign(db,v);document.querySelector('#stored').textContent=JSON.stringify(db,null,2);document.querySelector('#result').textContent='已保存';}}}};
for(const type of ['pointerdown','mousedown','mouseup','click'])window.addEventListener(type,e=>{if(e.target.closest('.candidate-card,.candidate-detail')){events++;document.querySelector('#events').textContent='页面事件：'+events;}},true);
</script><script src="/picker.js"></script><script>
document.querySelector('#start-root').onclick=()=>pickRegion('root','list');
document.querySelector('#start-name').onclick=()=>pickRegion('name','list');
document.querySelector('#start-resume').onclick=()=>pickRegion('resume','list');
document.querySelector('#start-detail').onclick=()=>pickRegion('root','detail');
</script><script type="module">
import {inspectFrame,readFrame} from '/frames.mjs';
document.querySelector('#read').onclick=()=>{
  try{document.querySelector('#result').textContent=JSON.stringify({frame:inspectFrame(),candidates:readFrame(db.profiles.list,5,'list')});}
  catch(e){document.querySelector('#result').textContent='读取错误：'+e.message;}
};
</script></html>'''

IFRAME_HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Iframe picker regression</title>
<style>body{margin:0;font:16px sans-serif}header{padding:12px;background:#064b45;color:white}iframe{border:0;width:100%;height:1100px}</style>
<header>外层导航：下面是跨源 iframe（127.0.0.1 → localhost），候选人和点选器均在框架内。</header>
<iframe src="http://localhost:8876/frame" title="候选人内嵌页面"></iframe></html>'''

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/','/frame'):
            body=HTML.encode('utf-8');kind='text/html; charset=utf-8'
        elif self.path=='/iframe':
            body=IFRAME_HTML.encode('utf-8');kind='text/html; charset=utf-8'
        elif self.path=='/picker.js':
            source=(ROOT/'extension/picker.js').read_text(encoding='utf-8')
            gate="if(location.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(location.hostname))throw Error('请在 BOSS 页面校准');"
            assert gate in source
            body=source.replace(gate,'/* URL gate omitted only for localhost regression fixture. */',1).encode('utf-8');kind='text/javascript; charset=utf-8'
        elif self.path=='/frames.mjs':
            source=(ROOT/'extension/frames.mjs').read_text(encoding='utf-8')
            gates=["if(location.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(location.hostname))return null;",
                   "if(location.protocol!=='https:'||!['www.zhipin.com','zhipin.com'].includes(location.hostname))throw Error('页面已改变');"]
            for gate in gates:
                assert gate in source
                source=source.replace(gate,'/* Localhost regression fixture only. */',1)
            body=source.encode('utf-8');kind='text/javascript; charset=utf-8'
        else:
            self.send_error(404);return
        self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def log_message(self,*args):
        pass

if __name__=='__main__':
    print('Picker test fixture: http://127.0.0.1:8876/',flush=True)
    HTTPServer(('127.0.0.1',8876),Handler).serve_forever()
