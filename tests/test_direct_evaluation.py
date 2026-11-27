"""Transient workbench evaluation; HTTP tests use only temp DBs and mock models."""
import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

import server


class DirectEvaluationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for name, value in (('DB', Path(directory.name) / 'preview.sqlite'),
                            ('EXTENSION_FILE', Path(directory.name) / 'extension.json')):
            active = patch.object(server, name, value)
            active.start(); self.addCleanup(active.stop)
        active = patch.dict(os.environ, {'AI_MODEL':'synthetic-model', 'AI_BASE_URL':'https://example.invalid/v1',
                                        'AI_API_KEY':'synthetic-secret', 'DEEPSEEK_API_KEY':'synthetic-secret'})
        active.start(); self.addCleanup(active.stop)
        active = patch.object(server, 'model_urlopen', side_effect=AssertionError('No real model calls'))
        self.network = active.start(); self.addCleanup(active.stop)
        active = patch.object(server.Handler, 'log_message', return_value=None)
        active.start(); self.addCleanup(active.stop)
        server.init_db()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=lambda:self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start(); self.addCleanup(self.stop_http)
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        status, _ = self.post('/api/jobs', {'title':'合成岗位','city':'','jd':'开发合成设备程序','criteria':'熟悉 Python'})
        self.assertEqual(status, 201)
        self.resume = '合成人员\n工作经历 合成设备公司 软件工程师 2020.01 - 至今\n负责 Python 设备接口开发、数据处理和程序验证。'
        self.data = {'job_id':1, 'resume':self.resume}

    def stop_http(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join(timeout=5)
        self.network.assert_not_called()
        self.assertFalse(server.AI_LOCK.locked())

    def post(self, path, data, token=None, origin=None):
        request = urllib.request.Request(self.base+path, data=json.dumps(data).encode(),
            headers={'X-App-Token':server.TOKEN if token is None else token,'Content-Type':'application/json',
                     **({'Origin':origin} if origin else {})})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                self.last_headers = dict(response.headers)
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                self.last_headers = dict(error.headers)
                return error.code, json.load(error)

    def snapshot(self):
        with server.connect() as db:
            names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            return {name:[tuple(row) for row in db.execute('SELECT * FROM "'+name.replace('"','""')+'"')]
                    for name in names}

    def answer(self, met=True):
        return {'score':0, 'category':'低匹配','summary':'合成测试','questions':['请说明设备接口验证过程'],
                'checks':[{'condition_id':1, 'condition':'熟悉 Python', 'status':'满足' if met else '不满足',
                           'basis':'explicit','support_score':100 if met else 0,'evidence_lines':[3]}],
                'required_checks':[], 'inferred_capabilities':[]}

    def preview(self, **kwargs):
        return self.post('/api/ai/preview-resume', self.data, **kwargs)

    def test_high_and_low_scores_return_verified_evidence_without_any_database_writes(self):
        before = self.snapshot()
        for met, score in ((True,100), (False,0)):
            with self.subTest(met=met), patch.object(server, 'CompatibleModel') as adapter:
                adapter.return_value.complete.return_value = self.answer(met)
                status, body = self.preview()
                self.assertEqual(status, 200, body)
                self.assertEqual(body['result']['score'], score)
                self.assertFalse(body['saved'])
                self.assertEqual(body['result']['checks'][0]['evidence_quotes'], [self.resume.splitlines()[2]])
                self.assertEqual(body['result']['questions'], ['请说明设备接口验证过程'])
                self.assertEqual(body['job']['id'], 1)
                self.assertNotIn('candidate_revision', body['result']['evaluation_context'])
                adapter.return_value.complete.assert_called_once()
                self.assertEqual(self.snapshot(), before)

    def test_format_retry_uses_same_evidence_and_still_never_writes(self):
        before = self.snapshot()
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = [{},self.answer()]
            status, body = self.preview()
            self.assertEqual(status, 200, body)
            calls = adapter.return_value.complete.call_args_list
            self.assertEqual(len(calls), 2)
            self.assertIn('上一次返回未通过校验', calls[1].args[0])
            self.assertEqual(calls[0].args[1]['resume'], calls[1].args[1]['resume'])
        self.assertEqual(self.snapshot(), before)

    def test_two_invalid_outputs_report_failure_without_candidate_or_history(self):
        before = self.snapshot()
        for answer in ({}, {**self.answer(), 'checks':[{**self.answer()['checks'][0], 'evidence_lines':[999]}]}):
            with self.subTest(answer=answer), patch.object(server, 'CompatibleModel') as adapter:
                adapter.return_value.complete.return_value = answer
                status, body = self.preview()
                self.assertEqual(status, 422, body)
                self.assertIn(body['code'], ('evaluation_format_invalid','evaluation_evidence_mismatch'))
                self.assertEqual(adapter.return_value.complete.call_count, 2)
                self.assertEqual(self.snapshot(), before)
                self.assertFalse(server.AI_LOCK.locked())

    def test_busy_lock_and_invalid_session_do_not_call_model(self):
        before = self.snapshot()
        with patch.object(server, 'CompatibleModel') as adapter:
            server.AI_LOCK.acquire()
            try:
                status, body = self.preview()
                self.assertEqual((status,body['code']), (409,'ai_busy'))
            finally:
                server.AI_LOCK.release()
            status, _ = self.preview(token='invalid-session')
            self.assertEqual(status,403)
            adapter.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_invalid_input_and_unconfigured_model_are_rejected_without_model_calls(self):
        before = self.snapshot()
        with patch.object(server, 'CompatibleModel') as adapter:
            for data in ({}, {'job_id':True,'resume':self.resume}, {'job_id':1.2,'resume':self.resume},
                         {'job_id':999,'resume':self.resume}, {'job_id':1,'resume':'短文本'},
                         {'job_id':1,'resume':'文'*30001}, {'job_id':1,'resume':self.resume+'\n查看全部'}):
                status, _ = self.post('/api/ai/preview-resume', data)
                self.assertEqual(status,400,data)
            with patch.object(server, 'public_config', return_value={'configured':False}):
                status, _ = self.preview()
                self.assertEqual(status,400)
            adapter.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_job_changes_discard_finished_result_and_only_external_change_is_retained(self):
        before = self.snapshot()
        with patch.object(server, 'CompatibleModel') as adapter:
            def respond(*args):
                with server.connect() as db:
                    db.execute("UPDATE jobs SET jd='更新后的岗位说明' WHERE id=1")
                return self.answer()
            adapter.return_value.complete.side_effect = respond
            status, body = self.preview()
        self.assertEqual((status,body.get('code')), (409,'evaluation_input_changed'),body)
        after = self.snapshot()
        self.assertNotEqual(after.pop('jobs'), before.pop('jobs'))
        self.assertEqual(after,before)

    def test_config_changes_discard_result(self):
        before = self.snapshot()
        config = server.load_config(server.DB.parent / 'ai-config.json')
        with patch.object(server, 'load_config', side_effect=lambda _:copy.deepcopy(config)), \
                patch.object(server, 'CompatibleModel') as adapter:
            def respond(*args):
                config['revision'] += 1
                return self.answer()
            adapter.return_value.complete.side_effect = respond
            status, body = self.preview()
        self.assertEqual((status,body.get('code')), (409,'evaluation_input_changed'),body)
        self.assertEqual(self.snapshot(),before)

    def test_connection_failure_removes_credentials_and_releases_lock(self):
        before = self.snapshot()
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = OSError('synthetic-secret connection unavailable')
            status, body = self.preview()
            self.assertEqual((status,body['code']),(502,'evaluation_failed'))
            self.assertNotIn('synthetic-secret',json.dumps(body))
            adapter.return_value.complete.assert_called_once()
        self.assertEqual(self.snapshot(),before)
        self.assertFalse(server.AI_LOCK.locked())

    def test_model_payload_uses_existing_redaction_and_never_claims_verified_browser_capture(self):
        self.data['resume'] += '\n电话 13812345678 邮箱 synthetic@example.invalid'
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.return_value = self.answer()
            status, body = self.preview()
            self.assertEqual(status,200,body)
            payload = adapter.return_value.complete.call_args.args[1]
            self.assertNotIn('13812345678',payload['resume'])
            self.assertNotIn('synthetic@example.invalid',payload['resume'])
            self.assertIsNone(payload['capture'])


    def boss_data(self, name='合成人员'):
        return {'job_id':1, 'candidate':{'name':name, 'resume':self.resume.replace('合成人员',name,1),
            'capture':{'status':'visible_complete','sections':['工作经历'],'warnings':[]}}}

    def test_extension_preview_returns_complete_result_and_name_without_list_identity_or_writes(self):
        before = self.snapshot()
        for name in ('合成人员', '唐汇鑫', '王**'):
            for met in (True, False):
                with self.subTest(name=name,met=met), patch.object(server, 'CompatibleModel') as adapter:
                    data = self.boss_data(name)
                    data['candidate']['resume'] = data['candidate']['resume'].replace(name,name+' 热搜 刚刚活跃',1)
                    adapter.return_value.complete.return_value = self.answer(met)
                    status, body = self.post('/api/extension/preview-resume',data)
                    self.assertEqual(status,200,body)
                    self.assertEqual(body['name'],name)
                    self.assertEqual(body['result']['score'],100 if met else 0)
                    self.assertFalse(body['saved'])
                    self.assertNotIn('id',body)
                    self.assertNotIn('favorite_pending',body)
                    payload = adapter.return_value.complete.call_args.args[1]
                    self.assertEqual(payload['capture']['status'],'visible_complete')
                    self.assertEqual(payload['capture']['sections'],['工作经历'])
                    self.assertEqual(self.snapshot(),before)

    def test_extension_preview_rejects_incomplete_or_mismatched_capture_before_model(self):
        before = self.snapshot()
        values = []
        for capture in (None, {'status':'needs_review','sections':['工作经历'],'warnings':[]},
                        {'status':'visible_complete','sections':['工作经历'],'warnings':['缺少后文']},
                        {'status':'visible_complete','sections':[],'warnings':[]},
                        {'status':'visible_complete','sections':['教育经历'],'warnings':[]}):
            value = self.boss_data();value['candidate']['capture']=capture;values.append(value)
        for name in ('其他人员','合成'):
            value = self.boss_data();value['candidate']['name']=name;values.append(value)
        value = self.boss_data();value['candidate']['resume'] += '\n查看全部';values.append(value)
        value = self.boss_data();value['candidate']['resume'] = self.resume.replace('合成人员','其他人员',1)+'\n合成人员参与项目';values.append(value)
        for value in values:
            with self.subTest(value=value), patch.object(server, 'CompatibleModel') as adapter:
                status, body = self.post('/api/extension/preview-resume',value)
                self.assertEqual(status,400,body)
                adapter.assert_not_called()
                self.assertEqual(self.snapshot(),before)

    def test_extension_formatted_resume_cannot_override_identity_or_hide_folded_content(self):
        before = self.snapshot()
        for html in ('<p>其他人员</p><p>工作经历</p><p>负责 Python 开发，完成数据处理和程序验证。</p>',
                     '<p>合成人员</p><p>工作经历</p><p>负责 Python 开发，完成数据处理和程序验证。</p><p>查看全部</p>'):
            data=self.boss_data();data['candidate']['resume_html']=html
            with patch.object(server,'CompatibleModel') as adapter:
                status,body=self.post('/api/extension/preview-resume',data)
                self.assertEqual(status,400,body)
                adapter.assert_not_called()
        self.assertEqual(self.snapshot(),before)

    def test_extension_preview_retries_invalid_evidence_and_never_saves_failed_candidates(self):
        before = self.snapshot()
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.return_value = {}
            status,body = self.post('/api/extension/preview-resume',self.boss_data())
            self.assertEqual((status,body['code']),(422,'evaluation_format_invalid'))
            self.assertEqual(adapter.return_value.complete.call_count,2)
        self.assertEqual(self.snapshot(),before)
        self.assertFalse(server.AI_LOCK.locked())

    def test_extension_preview_uses_existing_lock_and_detects_configuration_changes(self):
        before = self.snapshot()
        with patch.object(server, 'CompatibleModel') as adapter:
            server.AI_LOCK.acquire()
            try:
                status,body=self.post('/api/extension/preview-resume',self.boss_data())
                self.assertEqual((status,body['code']),(409,'ai_busy'))
                adapter.assert_not_called()
            finally:
                server.AI_LOCK.release()
            config=server.load_config(server.DB.parent/'ai-config.json')
            with patch.object(server,'load_config',side_effect=lambda _:copy.deepcopy(config)):
                def respond(*args):
                    config['revision'] += 1
                    return self.answer()
                adapter.return_value.complete.side_effect=respond
                status,body=self.post('/api/extension/preview-resume',self.boss_data())
                self.assertEqual((status,body['code']),(409,'evaluation_input_changed'))
        self.assertEqual(self.snapshot(),before)

    def test_extension_preview_cors_requires_paired_origin_and_current_session_token(self):
        before=self.snapshot()
        paired='chrome-extension://'+'a'*32
        server.EXTENSION_FILE.write_text(json.dumps({'id':'a'*32}),encoding='utf-8')
        with patch.object(server,'CompatibleModel') as adapter:
            adapter.return_value.complete.return_value=self.answer()
            for origin,token in (('chrome-extension://'+'b'*32,None),('https://example.invalid',None),(paired,'expired')):
                status,_=self.post('/api/extension/preview-resume',self.boss_data(),origin=origin,token=token)
                self.assertEqual(status,403)
                adapter.assert_not_called()
            status,body=self.post('/api/extension/preview-resume',self.boss_data(),origin=paired)
            self.assertEqual(status,200,body)
            self.assertEqual(self.last_headers.get('Access-Control-Allow-Origin'),paired)
            adapter.return_value.complete.assert_called_once()
        request=urllib.request.Request(self.base+'/api/extension/preview-resume',method='OPTIONS',headers={
            'Origin':paired,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type,X-App-Token'})
        with urllib.request.urlopen(request,timeout=5) as response:
            self.assertEqual(response.status,200)
            self.assertEqual(response.headers['Access-Control-Allow-Origin'],paired)
            self.assertIn('X-App-Token',response.headers['Access-Control-Allow-Headers'])
        self.assertEqual(self.snapshot(),before)


if __name__ == '__main__':
    unittest.main()
