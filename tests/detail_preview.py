"""Local browser regression fixture. Only synthetic data and whitelisted assets."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from html import escape
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DETAIL='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
body{font:15px/1.8 sans-serif;padding:25px;margin:0}h4{font-size:22px;margin:0}small{font-size:13px;color:#888;margin-left:16px}dt{font-weight:bold;margin:25px 0 12px}button{padding:10px;color:#167a73}section{max-width:720px}
</style><header><h4>测试杜＊ ＊<small>刚刚活跃</small></h4><p>虚构资料，仅用于 iframe 回归测试</p></header>
<section><dl><dt>期望职位：</dt><dd>机器视觉算法开发</dd><dt>工作经历</dt><dd>虚构公司，算法工程师。负责图像处理、相机标定、图像定位和项目部署。</dd></dl>
<p>熟悉 C++ 与 OpenCV。</p><button id="expand">查看全部</button>
<div id="extra" hidden><p>展开后可见的项目细节：完成坐标转换与缺陷检测，参与软件集成和现场调试。</p></div>
''' + ''.join(f'<p>测试经历 {n}：完成视觉检测项目，负责软件设计、算法开发、系统联调及交付；本条为虚构测试内容。</p>' for n in range(1,13)) + '''
<dl><dt>教育经历</dt><dd>虚构大学，计算机专业，本科。</dd><dt>资格证书</dt><dd>底部内容：软件设计师（测试）。</dd></dl></section>
<script>
const fixtureHost=document.createElement('resume-fixture');fixtureHost.style.display='contents';
const fixtureShadow=fixtureHost.attachShadow({mode:'open'});
fixtureShadow.append(document.querySelector('style').cloneNode(true),document.querySelector('header'),document.querySelector('section'));
document.body.prepend(fixtureHost);
</script><script src="http://127.0.0.1:8877/dom-reader.js"></script><script src="http://127.0.0.1:8877/automation.js"></script><script>
fixtureShadow.querySelector('#expand').onclick=e=>{fixtureShadow.querySelector('#extra').hidden=false;e.target.remove();};
addEventListener('message',async e=>{if(e.source!==parent||!['scan','read','html'].includes(e.data?.testAction))return;
try{parent.postMessage({result:await window.__hrmAuto.run(e.data.testAction,{name:'测试杜**'})},'http://127.0.0.1:8877');}
catch(error){parent.postMessage({error:error.message},'http://127.0.0.1:8877');}});
</script></html>'''
HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>在线简历详情识别回归</title>
<style>body{font:16px/1.6 sans-serif;margin:20px}button{padding:10px;margin-right:12px}iframe{width:70%;height:610px;border:1px solid #ccd}pre{white-space:pre-wrap;max-height:280px;overflow:auto;background:#f0f7f5;padding:15px}</style>
<h2>HTML 读取验证 · 虚构资料</h2><p>about:srcdoc iframe + Shadow DOM + display:contents；页面文字需跨组件读取。</p>
<button id="scan">识别详情</button><button id="read">展开并读取详情</button><button id="html">读取渲染 HTML</button><pre id="result">等待测试</pre>
<iframe title="测试在线简历" srcdoc="''' + escape(DETAIL,quote=True) + '''"></iframe><script>
for(const action of ['scan','read','html'])document.querySelector('#'+action).onclick=()=>document.querySelector('iframe').contentWindow.postMessage({testAction:action},'http://127.0.0.1:8877');
addEventListener('message',e=>{if(e.source!==document.querySelector('iframe').contentWindow)return;document.querySelector('#result').textContent=JSON.stringify(e.data,null,2);});
</script></html>'''

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path=='/':
            body=HTML.encode();kind='text/html; charset=utf-8'
        elif self.path=='/dom-reader.js':
            body=(ROOT/'extension/dom-reader.js').read_bytes();kind='text/javascript; charset=utf-8'
        elif self.path=='/automation.js':
            code=(ROOT/'extension/automation.js').read_text(encoding='utf-8')
            gate='const bossOrigin=origin=>{try{const u=new URL(origin);return'
            assert gate in code
            code=code.replace(gate,"const bossOrigin=origin=>{try{const u=new URL(origin);if(u.origin==='http://127.0.0.1:8877')return true;return",1)
            body=code.encode();kind='text/javascript; charset=utf-8'
        else:
            self.send_error(404);return
        self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def log_message(self,*args):pass

if __name__=='__main__':
    print('Detail fixture: http://127.0.0.1:8877/',flush=True)
    HTTPServer(('127.0.0.1',8877),Handler).serve_forever()
