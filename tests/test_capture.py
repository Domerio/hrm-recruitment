import base64
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from unittest.mock import patch
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
from resume_format import PLATFORM_NOTICE

PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfkAAAAASUVORK5CYII='

class CaptureTests(unittest.TestCase):
    def test_rich_resume_removes_platform_controls_without_flattening_content(self):
        before, after = PLATFORM_NOTICE.split('未经', 1)
        markup = ('<h2>工作经历</h2><p><strong>负责收起式设备的调试</strong></p>'
                  '<div><span>收</span><span>起</span></div>'
                  f'<p><span>{before}</span><br><em>未经{after}</em></p><p>后续正文</p>')
        rendered = server.resume_document(markup).decode('utf-8')
        self.assertIn('<strong>负责收起式设备的调试</strong>', rendered)
        self.assertIn('<p>后续正文</p>', rendered)
        self.assertNotIn('<span>收</span>', rendered)
        self.assertNotIn('为妥善保护', rendered)
        self.assertNotIn('在任何第三方平台进行复制', rendered)

    def test_plain_resume_renders_horizontal_entries_and_bounded_tags(self):
        source = ('李**\n期望职位\n杭州\n视觉工程师\n行业不限\n15-20K\n'
                  '工作经历\n示例公司\n视觉工程师\n2022.06 - 至今\n'
                  '1. 负责工业检测项目部署。\n图像处理\nOpenCV\nC++\n'
                  '教育经历\n示例大学\n机械\n本科 · 非全日制\n2018 - 2021\n省部共建\n'
                  '示例学院\n大专\n2015 - 2018\n补充说明')
        rendered = server.resume_document('', source).decode('utf-8')
        self.assertIn('杭州 · 视觉工程师 · 行业不限 · 15-20K', rendered)
        self.assertIn('<strong>示例公司</strong> · 视觉工程师</span>', rendered)
        self.assertIn('<strong>示例大学</strong> · 机械 · 本科 · 非全日制</span>', rendered)
        self.assertIn('<span class="resume-entry-period">· <time>2018 - 2021</time></span>', rendered)
        self.assertIn('<strong>示例学院</strong> · 大专</span>', rendered)
        self.assertIn('<span class="resume-tag">图像处理</span> <span class="resume-tag">OpenCV</span>', rendered)
        self.assertIn('<span class="resume-tag resume-badge">省部共建</span>', rendered)
        self.assertIn('<p>补充说明</p>', rendered)

    def test_clipboard_format_is_sanitized_saved_and_exported(self):
        old=server.DB
        with tempfile.TemporaryDirectory() as d:
            server.DB=Path(d)/'clipboard.sqlite'
            server.init_db()
            http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
            thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{http.server_port}'
            def post(path,data):
                req=urllib.request.Request(base+path,data=json.dumps(data).encode(),headers={'X-App-Token':server.TOKEN,'Content-Type':'application/json'})
                with urllib.request.urlopen(req) as r:return r.read()
            try:
                with patch.object(server,'clipboard_sequence',return_value=123):
                    self.assertEqual(json.loads(post('/api/extension/clipboard-sequence',{})),{'sequence':123})
                post('/api/jobs',{'title':'视觉工程师','jd':'算法开发','criteria':'C++'})
                markup=('<h2 style="color:rgb(0, 100, 120);background:url(https://example.com)">工作经历</h2>'
                        '<ol start="2"><li><strong>视觉系统开发</strong>，包括机器视觉软件开发和生产现场调试。</li></ol>'
                        '<table><tr><td colspan="2" onclick="alert(1)">熟悉 OpenCV 与 C++ 开发。</td></tr></table>'
                        '<img src="https://example.com/a"><script>alert(1)</script>')
                preview=json.loads(post('/api/extension/clipboard-preview',{'resume_html':markup}))
                self.assertIn('<h2 style="color:rgb(0, 100, 120)">',preview['resume_html'])
                self.assertIn('<ol start="2">',preview['resume_html'])
                self.assertIn('<td colspan="2">',preview['resume_html'])
                for blocked in ('<script','<img','onclick','example.com','alert('):
                    self.assertNotIn(blocked,preview['resume_html'])
                plain=json.loads(post('/api/extension/clipboard-preview',{'resume':'纯文本\n保留换行'}))
                self.assertEqual(plain['resume'],'纯文本\n保留换行')
                self.assertEqual(plain['resume_html'],'')
                self.assertIn('<p>保留换行</p>',plain['preview_document'])
                # Import also sanitizes clients that bypass the preview.
                candidate={'name':'测试候选人','resume':preview['resume'],'resume_html':markup}
                cid=json.loads(post('/api/extension/import',{'job_id':1,'candidates':[candidate]}))['ids'][0]
                candidate.pop('resume_html')
                self.assertEqual(json.loads(post('/api/extension/import',{'job_id':1,'candidates':[candidate]}))['duplicates'],1)
                with urllib.request.urlopen(base+'/api/state') as r:
                    saved=json.load(r)['candidates'][0]
                self.assertTrue(saved['has_resume_format'])
                self.assertEqual(saved['resume'],preview['resume'])
                with urllib.request.urlopen(base+f'/api/candidates/{cid}/resume.html') as r:
                    self.assertIn("default-src 'none'",r.headers['Content-Security-Policy'])
                    document=r.read()
                self.assertIn(preview['resume_html'].encode(),document)
                with zipfile.ZipFile(io.BytesIO(post('/api/export',{'ids':[cid],'format':'bundle'}))) as z:
                    self.assertEqual(z.read(f'resumes/candidate-{cid}.html'),document)
            finally:
                http.shutdown();http.server_close();thread.join();server.DB=old

    def test_resume_image_and_bundle_stay_associated_and_dedup_preserves_image(self):
        old=server.DB
        with tempfile.TemporaryDirectory() as d:
            server.DB=Path(d)/'capture.sqlite'
            server.init_db()
            http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
            thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{http.server_port}'
            def post(path,data):
                req=urllib.request.Request(base+path,data=json.dumps(data).encode(),headers={'X-App-Token':server.TOKEN,'Content-Type':'application/json'})
                with urllib.request.urlopen(req) as r:return r.read()
            try:
                post('/api/jobs',{'title':'视觉工程师','jd':'算法开发','criteria':'C++'})
                overlap='1. 负责视觉算法开发和工业检测生产线部署。\n2. 编写相机标定和自动化集成工具。\n3. 验证项目交付和现场安全要求。'
                partial='负责产线视觉定位与标定系统的全流程'
                clean=(f'张**\n工作经历\n虚构视觉公司\n视觉工程师\n2022.06 - 至今\n{overlap}\n'
                       f'{partial}\n\n{overlap}\n{partial}交付。\n教育经历\n虚构大学 <本科>')
                plain=clean.replace('工作经历', '收起\n工作经历', 1) + '\n' + PLATFORM_NOTICE
                candidate={'name':'张**','resume':plain,'link':'',
                    'capture':{'status':'visible_complete','sections':['工作经历','教育经历','项目经历'],'warnings':[]}}
                saved=json.loads(post('/api/extension/import',{'job_id':1,'candidates':[candidate]}));cid=saved['ids'][0]
                post('/api/candidates/share',{'id':cid,'image':PNG})
                self.assertEqual(json.loads(post('/api/extension/import',{'job_id':1,'candidates':[candidate]}))['duplicates'],1)
                with urllib.request.urlopen(base+'/api/state') as r:state=json.load(r)
                self.assertEqual(state['capture_version'],1)
                source=state['candidates'][0]['source'];self.assertEqual(source['capture']['status'],'visible_complete')
                self.assertEqual(state['candidates'][0]['resume'],plain)
                self.assertFalse(state['candidates'][0]['has_resume_format'])
                with urllib.request.urlopen(base+f'/api/candidates/{cid}/resume.html') as r:
                    formatted=r.read().decode('utf-8')
                self.assertIn('<h3>工作经历</h3>',formatted)
                self.assertIn('<strong>虚构视觉公司</strong>',formatted)
                self.assertIn('<time>2022.06 - 至今</time>',formatted)
                self.assertIn('<li>1. 负责视觉算法开发和工业检测生产线部署。</li>',formatted)
                self.assertEqual(formatted.count('验证项目交付和现场安全要求。'),1)
                self.assertEqual(formatted.count(partial),1)
                self.assertIn(f'{partial}交付。',formatted)
                self.assertIn('虚构大学 &lt;本科&gt;',formatted)
                self.assertNotIn('收起',formatted)
                self.assertNotIn('为妥善保护',formatted)
                self.assertEqual(source['image_url'],f'/api/candidates/{cid}/share.png');self.assertNotIn('base64',json.dumps(state))
                with urllib.request.urlopen(base+source['image_url']) as r:self.assertEqual(r.read(),base64.b64decode(PNG.split(',')[1]))
                archive=post('/api/export',{'ids':[cid],'format':'bundle'})
                with zipfile.ZipFile(io.BytesIO(archive)) as z:
                    self.assertIn(f'share/candidate-{cid}.png',z.namelist())
                    self.assertEqual(z.read(f'resumes/candidate-{cid}.txt').decode(),clean)
                    self.assertEqual(z.read(f'resumes/candidate-{cid}.html').decode(),formatted)
                    self.assertIn(f'share/candidate-{cid}.png',z.read('candidates.csv').decode('utf-8-sig'))
                with self.assertRaises(urllib.error.HTTPError):post('/api/candidates/share',{'id':cid,'image':'data:image/svg+xml;base64,PHN2Zz4='})
                with self.assertRaises(urllib.error.HTTPError):post('/api/candidates/share',{'id':99999,'image':PNG})
                candidate['capture']['warnings']=['仍有折叠内容']
                with self.assertRaises(urllib.error.HTTPError):post('/api/extension/import',{'job_id':1,'candidates':[candidate]})

                evaluation={'score':80,'category':'推荐','summary':'满足条件','questions':[],
                    'checks':[{'condition':'C++','status':'满足','evidence':'具备十年经验'}]}
                with patch.object(server,'CompatibleModel') as model:
                    model.return_value.complete.return_value=evaluation
                    with self.assertRaises(urllib.error.HTTPError) as failed:
                        post('/api/ai/evaluate',{'id':cid})
                    self.assertEqual(failed.exception.code,422)
                    self.assertEqual(json.load(failed.exception)['code'],'evaluation_evidence_mismatch')
                    self.assertEqual(model.return_value.complete.call_count,2)
                    with urllib.request.urlopen(base+'/api/state') as r:
                        pending=json.load(r)['candidates'][0]
                    self.assertTrue(pending['ai_pending'])
                    self.assertEqual(pending['history'],[])
                    sent=model.return_value.complete.call_args.args[1]['resume']
                    self.assertNotIn('为妥善保护牛人',sent)
                    self.assertNotIn('收起',sent)
                    quote='2. 编写相机标定和自动化集成工具。'
                    evidence_line=next(int(line[1:line.index(']')]) for line in sent.splitlines() if line.endswith(quote))
                    evaluation['checks'][0]={'condition':'C++','status':'满足','evidence_line':evidence_line}
                    self.assertEqual(json.loads(post('/api/ai/evaluate',{'id':cid}))['score'],100)
                    with urllib.request.urlopen(base+'/api/state') as r:
                        evaluated=json.load(r)['candidates'][0]
                    self.assertFalse(evaluated['ai_pending'])
                    self.assertEqual(len(evaluated['history']),1)
                    self.assertEqual(evaluated['history'][0]['result']['checks'][0]['evidence'],quote)
            finally:
                http.shutdown();http.server_close();thread.join();server.DB=old

if __name__=='__main__':unittest.main()
