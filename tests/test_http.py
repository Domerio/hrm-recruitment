import json
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

class HttpTests(unittest.TestCase):
    def test_workflow_and_secret_boundary(self):
        original,original_snapshots,original_ocr = server.DB,server.DOM_SNAPSHOTS,server.OCR_RUNS
        with tempfile.TemporaryDirectory() as directory:
            server.DB = Path(directory) / 'http.sqlite'
            server.DOM_SNAPSHOTS = Path(directory) / 'dom-snapshots'
            server.OCR_RUNS = Path(directory) / 'ocr-runs'
            server.init_db()
            http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{http.server_port}'
            def post(path, payload, token=server.TOKEN):
                req = urllib.request.Request(base+path, data=json.dumps(payload).encode(), headers={'Content-Type':'application/json','X-App-Token':token})
                with urllib.request.urlopen(req) as r:
                    return r.read()
            try:
                post('/api/jobs', {'title':'测试岗位','jd':'Python 开发','criteria':'必备 Python'})
                post('/api/candidates', {'job_id':1,'name':'测试候选人','resume':'具备 Python 经验','phone':'13800000000'})
                post('/api/review', {'id':1,'review':'通过复核','note':'=恶意公式'})
                exported = post('/api/export', {'ids':[1]}).decode('utf-8-sig')
                self.assertIn("'=恶意公式", exported)
                self.assertIn('通过复核', exported)
                with urllib.request.urlopen(base+'/api/state') as r:
                    state = json.load(r)
                self.assertEqual(len(state['candidates']), 1)
                self.assertNotIn('api_key', str(state).lower())
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    post('/api/jobs', {}, token='invalid')
                self.assertEqual(denied.exception.code, 403)
                png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfkAAAAASUVORK5CYII='
                with patch.object(server,'recognize_png',return_value={'text':'查看全部','lines':[],'engine':'test'}) as ocr:
                    session='00000000-0000-4000-8000-000000000001'
                    output=json.loads(post('/api/extension/ocr',{'image':png,'trace':{'session':session,'index':1,'state':{'scrollMode':'canvas'}}}))
                    self.assertEqual(output['text'],'查看全部')
                    self.assertTrue(ocr.call_args.args[0].startswith(b'\x89PNG'))
                    self.assertTrue((server.OCR_RUNS/session/'screen-001.png').exists())
                    post('/api/extension/ocr-report',{'session':session,'summary':{'atBottom':False,'screens':1}})
                    self.assertFalse(json.loads((server.OCR_RUNS/'latest.json').read_text())['summary']['atBottom'])
                    with self.assertRaises(urllib.error.HTTPError):post('/api/extension/ocr-report',{'session':'../escape','summary':{}})
                    with self.assertRaises(urllib.error.HTTPError):urllib.request.urlopen(base+'/data/ocr-runs/latest.json')
                    ocr.reset_mock()
                    with self.assertRaises(urllib.error.HTTPError):post('/api/extension/ocr',{'image':png},token='invalid')
                    with self.assertRaises(urllib.error.HTTPError):post('/api/extension/ocr',{'image':'https://example.com/image.png'})
                    ocr.assert_not_called()
                with self.assertRaises(urllib.error.HTTPError) as missing:
                    urllib.request.urlopen(base+'/.env')
                self.assertEqual(missing.exception.code, 404)
                with self.assertRaises(urllib.error.HTTPError) as bad:
                    post('/api/extension/import', {'job_id':1,'candidates':[{'name':'测试','resume':'信息太少','link':''}]})
                self.assertEqual(bad.exception.code, 400)
                result=json.loads(post('/api/extension/import', {'job_id':1,'candidates':[{'name':'插件测试','resume':'机器视觉开发与图像处理项目经验。'*5,'link':''}]}))
                self.assertEqual(result['added'],1)
                snapshot={'frames':[{'frameId':3,'frameKey':'https://www.zhipin.com/web/chat/search?private=query','html':'<h4>工作经历</h4>','diagnostics':{'closedShadowRoots':1}}]}
                saved=json.loads(post('/api/extension/dom-snapshot',snapshot))
                self.assertTrue(saved['file'].startswith('data/dom-snapshots/'))
                stored=json.loads((server.DOM_SNAPSHOTS/'latest.json').read_text(encoding='utf-8'))
                self.assertEqual(stored['frames'][0]['html'],'<h4>工作经历</h4>')
                self.assertNotIn('private=query',stored['frames'][0]['frameKey'])
                snapshot['frames'][0]['frameKey']='https://example.com/'
                with self.assertRaises(urllib.error.HTTPError):post('/api/extension/dom-snapshot',snapshot)
                with self.assertRaises(urllib.error.HTTPError):urllib.request.urlopen(base+'/data/dom-snapshots/latest.json')
                unpaired=urllib.request.Request(base+'/api/state',headers={'Origin':'chrome-extension://'+'a'*32})
                with self.assertRaises(urllib.error.HTTPError) as denied_extension:
                    urllib.request.urlopen(unpaired)
                self.assertEqual(denied_extension.exception.code,403)
            finally:
                http.shutdown()
                http.server_close()
                thread.join()
                server.DB = original
                server.DOM_SNAPSHOTS = original_snapshots
                server.OCR_RUNS = original_ocr
