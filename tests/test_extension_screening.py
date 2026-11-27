"""Pre-save screening, with a temporary database and synthetic model responses."""
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


class ExtensionScreeningTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for name, value in (('DB', Path(directory.name) / 'screening.sqlite'),
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
        self.card = {'name':'合成人员','signature':'合成人员 软件工程师 5年 本科 Python 合成设备公司'}
        self.data = {'job_id':1, 'candidate':{'name':'合成人员', 'resume':self.resume,
            'source_card':self.card, 'capture':{'status':'visible_complete','sections':['工作经历'],'warnings':[]}}}

    def stop_http(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join(timeout=5)
        self.network.assert_not_called()

    def post(self, path, data):
        request = urllib.request.Request(self.base+path, data=json.dumps(data).encode(),
            headers={'X-App-Token':server.TOKEN,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def state(self):
        with urllib.request.urlopen(self.base+'/api/state', timeout=5) as response:
            return json.load(response)

    def counts(self):
        with server.connect() as db:
            return {name:db.execute('SELECT count(*) FROM '+name).fetchone()[0] for name in
                    ('candidates','evaluations','evaluation_inputs','candidate_sources','candidate_resume_formats',
                     'candidate_profiles','candidate_card_keys','candidate_screening')}

    def skip_marks(self):
        with server.connect() as db:
            return [dict(row) for row in db.execute('SELECT * FROM collection_skip_marks')]

    def collection_status(self, cards=None, job_id=1, share=False):
        status, body = self.post('/api/extension/collection-status',
            {'job_id':job_id, 'cards':[self.card] if cards is None else cards, 'share':share})
        self.assertEqual(status, 200, body)
        return body

    def answer(self, payload, met=True):
        return {'score':0, 'category':'低匹配','summary':'合成测试','questions':[],
                'checks':[{'condition_id':1, 'condition':'熟悉 Python', 'status':'满足' if met else '不满足',
                           'basis':'explicit','support_score':100 if met else 0,'evidence_lines':[3]}],
                'required_checks':[], 'inferred_capabilities':[]}

    def screen(self, met=True):
        with patch.object(server, 'CompatibleModel') as adapter:
            def respond(instruction, payload):
                self.assertEqual(self.counts()['candidates'], 0, 'Model must run before candidate insertion')
                return self.answer(payload, met)
            adapter.return_value.complete.side_effect = respond
            status, body = self.post('/api/extension/screen', self.data)
            return status, body, adapter.return_value.complete.call_count

    def test_qualifying_result_is_evaluated_before_atomic_save_and_uses_server_score(self):
        status, body, calls = self.screen()
        self.assertEqual((status, body['saved'], body['score'], body['ai_pending'], calls), (200,True,100,False,1))
        self.assertTrue(body['favorite_pending'])
        self.assertEqual(self.counts()['evaluations'], 1)
        self.assertEqual(self.counts()['evaluation_inputs'], 1)
        candidate = self.state()['candidates'][0]
        self.assertEqual(candidate['resume'], self.resume)
        self.assertFalse(candidate['ai_pending'])
        self.assertIsNone(candidate['screening_failure'])
        self.assertEqual(candidate['history'][0]['result']['score'], 100)
        self.assertEqual(self.state()['screening_version'], 2)

    def test_low_score_retains_only_a_collection_mark_and_no_candidate_data(self):
        status, body, calls = self.screen(met=False)
        self.assertEqual((status,body['saved'],body['score'],body['ai_pending'],calls), (200,False,0,False,1))
        self.assertNotIn('id', body)
        self.assertTrue(body['collection_marked'])
        self.assertFalse(body['favorite_pending'])
        self.assertEqual(set(self.counts().values()), {0})
        marks = self.skip_marks()
        self.assertEqual(len(marks), 1)
        mark = marks[0]
        self.assertEqual(set(mark), {'job_id','card_key','input_hash','score','created','policy_key','precheck_json'})
        self.assertEqual(mark['precheck_json'], '')
        self.assertEqual((mark['job_id'], mark['score']), (1, 0))
        self.assertEqual(mark['card_key'], server.source_card(self.card)['key'])
        self.assertRegex(mark['input_hash'], r'^[0-9a-f]{64}$')
        self.assertTrue(mark['created'])
        self.assertNotIn(self.card['name'], json.dumps(mark, ensure_ascii=False))
        self.assertNotIn(self.resume, json.dumps(mark, ensure_ascii=False))

    def test_boundary_is_strictly_above_55(self):
        for score in (0, 54.9, 55, 55.01, 60, 60.01, 75, 75.01):
            with self.subTest(score=score), patch.object(server, 'complete_evaluation', return_value={'score':score}):
                # Fresh evidence tests the threshold, not replay of a committed result.
                self.data['candidate']['resume'] = self.resume + f'\n合成资料版本 {score}'
                status, body = self.post('/api/extension/screen', self.data)
                self.assertEqual(status, 200, body)
                self.assertEqual(body['saved'], score > 55)
                self.assertEqual(self.counts()['candidates'], int(score > 55))
                if score <= 55:
                    self.assertTrue(body['collection_marked'])
                    self.assertEqual([mark['score'] for mark in self.skip_marks()], [score])
                else:
                    self.assertEqual(self.skip_marks(), [])
                    self.assertEqual(body['colleague_share_state'], 'pending' if score > 75 else '')

    def test_custom_thresholds_use_strict_boundaries_and_persist_the_recipient(self):
        policy = {'save_above':70, 'share_above':85, 'share_mode':'colleague', 'colleague_name':'孙女士'}
        for score in (70, 70.01, 85, 85.01):
            with self.subTest(score=score), patch.object(server, 'complete_evaluation', return_value={'score':score}):
                self.data['candidate']['resume'] = self.resume + f'\n合成资料版本 {score}'
                status, body = self.post('/api/extension/screen', {**self.data,'collection_policy':policy})
                self.assertEqual(status, 200, body)
                self.assertEqual(body['saved'], score > 70)
                self.assertEqual(body['collection_policy'], server.collection_policy(policy))
                if score > 70:
                    self.assertEqual(body['colleague_share_state'], 'pending' if score > 85 else '')
                else:
                    self.assertEqual(self.skip_marks()[0]['score'], 70)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT colleague FROM candidate_colleague_shares').fetchone()[0], '孙女士')
            self.assertEqual(json.loads(db.execute('SELECT policy_json FROM candidate_screening').fetchone()[0]),server.collection_policy(policy))

    def test_disabled_colleague_modes_do_not_queue_delivery(self):
        for mode in ('none','qr'):
            with self.subTest(mode=mode), patch.object(server, 'complete_evaluation', return_value={'score':100}):
                policy = {'save_above':0,'share_above':0,'share_mode':mode,'colleague_name':''}
                self.data['candidate']['resume'] = self.resume + '\n模式 ' + mode
                status, body = self.post('/api/extension/screen', {**self.data,'collection_policy':policy})
                self.assertEqual(status,200,body)
                self.assertTrue(body['saved'])
                self.assertEqual(body['colleague_share_state'],'')
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_colleague_shares').fetchone()[0],0)

    def test_changed_policy_invalidates_low_score_marks_and_lower_threshold_can_save(self):
        policy = {'save_above':80,'share_above':90,'share_mode':'none','colleague_name':''}
        with patch.object(server,'complete_evaluation',return_value={'score':65}) as evaluate:
            status, body = self.post('/api/extension/screen',{**self.data,'collection_policy':policy})
            self.assertEqual((status,body['saved']),(200,False))
            status, progress = self.post('/api/extension/collection-status',
                {'job_id':1,'cards':[self.card],'share':False,'collection_policy':policy})
            self.assertEqual(progress['completed'],[self.card['signature']])
            changed = {**policy,'save_above':60}
            status, progress = self.post('/api/extension/collection-status',
                {'job_id':1,'cards':[self.card],'share':False,'collection_policy':changed})
            self.assertEqual(progress['completed'],[])
            status, saved = self.post('/api/extension/screen',{**self.data,'collection_policy':changed})
            self.assertEqual((status,saved['saved'],evaluate.call_count),(200,True,2))
            self.assertEqual(self.skip_marks(),[])

    def test_enabling_greeting_preserves_low_score_marks_and_cached_inference(self):
        policy = {'save_above':80,'share_above':90,'share_mode':'none','colleague_name':''}
        with patch.object(server,'complete_evaluation',return_value={'score':65}) as evaluate:
            status, body = self.post('/api/extension/screen',{**self.data,'collection_policy':policy})
            self.assertEqual((status,body['saved']),(200,False))
            enabled = {**policy,'greet_enabled':True}
            status, progress = self.post('/api/extension/collection-status',
                {'job_id':1,'cards':[self.card],'share':False,'collection_policy':enabled,'greeting_account_uid':'123'})
            self.assertEqual(progress['completed'],[self.card['signature']])
            status, repeated = self.post('/api/extension/screen',{**self.data,'collection_policy':enabled})
            self.assertEqual((status,repeated['saved'],repeated['cached']),(200,False,True))
            self.assertEqual(evaluate.call_count,1)

    def test_saved_policy_is_retained_and_disabled_sharing_only_hides_pending_delivery(self):
        policy = {'save_above':60,'share_above':80,'share_mode':'colleague','colleague_name':'孙女士'}
        with patch.object(server,'complete_evaluation',return_value={'score':85}):
            status, saved = self.post('/api/extension/screen',{**self.data,'collection_policy':policy})
        self.assertEqual(status,200,saved)
        changed = {**policy,'save_above':100,'colleague_name':'李女士'}
        with patch.object(server,'CompatibleModel') as adapter:
            status, cached = self.post('/api/extension/screen',{**self.data,'collection_policy':changed})
            adapter.assert_not_called()
        self.assertEqual((status,cached['saved'],cached['cached']),(200,True,True))
        self.assertEqual(cached['collection_policy'],server.collection_policy(policy))
        self.post('/api/extension/favorite-complete',{'id':saved['id'],'source_card':self.card})
        lookup = {'job_id':1,'cards':[self.card],'share':False,'collection_policy':changed}
        status, progress = self.post('/api/extension/collection-status',lookup)
        self.assertEqual(progress['known'][0]['collection_policy'],server.collection_policy(policy))
        self.assertEqual(progress['known'][0]['colleague_share_state'],'pending')
        disabled = {**changed,'share_mode':'none'}
        status, progress = self.post('/api/extension/collection-status',{**lookup,'collection_policy':disabled})
        self.assertEqual(progress['completed'],[self.card['signature']])
        self.assertEqual(progress['known'][0]['colleague_share_state'],'')
        request = {'id':saved['id'],'source_card':self.card,'stage':'begin','collection_policy':policy}
        self.assertEqual(self.post('/api/extension/colleague-share',{**request,'recipient':'李女士'})[0],400)
        self.assertEqual(self.post('/api/extension/colleague-share',request)[0],400)
        self.assertEqual(self.post('/api/extension/colleague-share',{**request,'recipient':'孙女士','collection_policy':changed})[0],400)
        self.assertEqual(self.post('/api/extension/colleague-share',{**request,'recipient':'孙女士'})[0],200)
        status, progress = self.post('/api/extension/collection-status',{**lookup,'collection_policy':disabled})
        self.assertEqual(progress['completed'],[])
        self.assertEqual(progress['known'][0]['colleague_share_state'],'attempted')
        self.assertEqual(self.post('/api/extension/colleague-share',{**request,'stage':'complete','recipient':'孙女士'})[0],200)
        status, progress = self.post('/api/extension/collection-status',lookup)
        self.assertEqual(progress['completed'],[self.card['signature']])
        self.assertEqual(progress['known'][0]['colleague_share_state'],'confirmed')

    def test_pending_delivery_uses_saved_score_when_current_greeting_evaluation_is_stale_or_lower(self):
        policy = {'save_above':75,'share_above':80,'share_mode':'colleague','colleague_name':'孙女士'}
        result = {'score':81,'scoring':{'version':server.SCORING_VERSION}}
        with patch.object(server,'complete_evaluation',return_value=result):
            status, saved = self.post('/api/extension/screen',{**self.data,'collection_policy':policy})
        self.assertEqual(status,200,saved)
        self.assertEqual(saved['colleague_share_score'],81)
        self.assertEqual(self.post('/api/extension/favorite-complete',
            {'id':saved['id'],'source_card':self.card})[0],200)
        with patch.object(server,'CompatibleModel') as model:
            _, cached = self.post('/api/extension/screen',{**self.data,'collection_policy':policy})
            self.assertEqual(cached['colleague_share_score'],81)
            self.assertTrue(cached['cached'])
            model.assert_not_called()
        lookup = {'job_id':1,'cards':[self.card],'share':False,'collection_policy':policy}
        _, initial = self.post('/api/extension/collection-status',lookup)
        self.assertEqual(initial['known'][0]['score'],81)
        with server.connect() as db:
            row = db.execute('SELECT id,result FROM evaluations WHERE candidate_id=?',(saved['id'],)).fetchone()
            old_result = json.loads(row['result'])
            lower = {**old_result,'score':60}
            db.execute('UPDATE evaluations SET result=? WHERE id=?',(json.dumps(lower),row['id']))
        _, lower = self.post('/api/extension/collection-status',lookup)
        record = lower['known'][0]
        self.assertEqual((record['score'],record['colleague_share_score']), (60,81))
        self.assertEqual(record['colleague_share_state'],'pending')
        self.assertFalse(record['greeting_eligible'])
        with server.connect() as db:
            db.execute("UPDATE evaluation_inputs SET fingerprint='prior-rules-fingerprint' WHERE evaluation_id=?",(row['id'],))
        _, stale = self.post('/api/extension/collection-status',lookup)
        record = stale['known'][0]
        self.assertIsNone(record['score'])
        self.assertTrue(record['ai_pending'])
        self.assertEqual(record['colleague_share_score'],81)
        self.assertEqual(record['colleague_share_state'],'pending')
        self.assertFalse(record['favorite_pending'])
        self.assertFalse(record['greeting_eligible'])
        self.assertEqual(stale['completed'],[])
        self.assertEqual(self.counts()['evaluations'],1)

    def test_current_greeting_score_cannot_authorize_an_ineligible_saved_delivery_score(self):
        policy = {'save_above':75,'share_above':80,'share_mode':'colleague','colleague_name':'孙女士'}
        result = {'score':81,'scoring':{'version':server.SCORING_VERSION}}
        with patch.object(server,'complete_evaluation',return_value=result):
            status, saved = self.post('/api/extension/screen',{**self.data,'collection_policy':policy})
        self.assertEqual(status,200,saved)
        self.post('/api/extension/favorite-complete',{'id':saved['id'],'source_card':self.card})
        for score in (None,80,60):
            with self.subTest(saved_score=score):
                with server.connect() as db:
                    db.execute('UPDATE candidate_screening SET score=? WHERE candidate_id=?',(score,saved['id']))
                _, progress = self.post('/api/extension/collection-status',
                    {'job_id':1,'cards':[self.card],'share':False,'collection_policy':policy})
                record = progress['known'][0]
                self.assertEqual(record['score'],81)
                self.assertEqual(record['colleague_share_score'],score)
                self.assertEqual(record['colleague_share_state'],'')
                status, _ = self.post('/api/extension/colleague-share',
                    {'id':saved['id'],'source_card':self.card,'stage':'begin','recipient':'孙女士'})
                self.assertEqual(status,400)
                with server.connect() as db:
                    self.assertEqual(db.execute('SELECT state FROM candidate_colleague_shares WHERE candidate_id=?',
                        (saved['id'],)).fetchone()[0],'pending')

    def test_invalid_collection_policies_fail_before_any_model_or_candidate_write(self):
        for policy in ([55],{'save_above':True},{'save_above':'60'},{'save_above':-1},
                       {'share_above':101},{'share_above':float('nan')},{'share_above':float('inf')},
                       {'share_mode':'email'},{'colleague_name':''},{'colleague_name':'李\n女士'},
                       {'colleague_name':'李'*41},{'unknown':1}):
            with self.subTest(policy=policy), patch.object(server,'CompatibleModel') as adapter:
                self.assertEqual(self.post('/api/extension/screen',{**self.data,'collection_policy':policy})[0],400)
                self.assertEqual(self.post('/api/extension/collection-status',
                    {'job_id':1,'cards':[self.card],'share':False,'collection_policy':policy})[0],400)
                adapter.assert_not_called()
        self.assertEqual(set(self.counts().values()),{0})
        self.assertEqual(self.state()['collection_policy_version'],1)

    def test_prior_pending_share_at_70_is_inactive_under_new_threshold(self):
        with patch.object(server, 'complete_evaluation', return_value={'score':70}):
            status, saved = self.post('/api/extension/screen', self.data)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved['colleague_share_state'], '')
        with server.connect() as db:
            db.execute('''INSERT INTO candidate_colleague_shares(candidate_id,colleague,state,updated)
                VALUES(?,?,?,?)''', (saved['id'],'\u8521\u5973\u58eb','pending',server.now()))
        status, favorite = self.post('/api/extension/favorite-complete',
            {'id':saved['id'], 'source_card':self.card})
        self.assertEqual(status, 200, favorite)
        result = self.collection_status()
        self.assertEqual(result['known'][0]['colleague_share_state'], '')
        self.assertEqual(result['completed'], [self.card['signature']])
        status, _ = self.post('/api/extension/colleague-share',
            {'id':saved['id'], 'source_card':self.card, 'stage':'begin'})
        self.assertEqual(status, 400)

    def test_low_score_mark_survives_reinitialization_and_skips_even_when_qr_is_requested(self):
        self.screen(met=False)
        server.init_db()
        for share in (False, True):
            result = self.collection_status(share=share)
            self.assertEqual(result, {'completed':[self.card['signature']], 'known':[]})
        self.assertEqual(self.state()['candidates'], [])
        self.assertEqual(set(self.counts().values()), {0})

    def test_repeated_low_score_request_reuses_persisted_result_without_model(self):
        self.screen(met=False)
        server.init_db()
        with patch.object(server, 'CompatibleModel') as adapter:
            status, body = self.post('/api/extension/screen', self.data)
            adapter.assert_not_called()
        self.assertEqual(status, 200, body)
        self.assertEqual((body['saved'], body['score'], body['collection_marked'], body['cached']),
                         (False, 0, True, True))
        self.assertNotIn('id', body)
        self.assertEqual(len(self.skip_marks()), 1)
        self.assertEqual(set(self.counts().values()), {0})

    def test_low_score_marks_are_job_and_card_specific_and_preserve_duplicate_guards(self):
        self.screen(met=False)
        status, _ = self.post('/api/jobs', {'title':'另一岗位','city':'','jd':'开发设备程序','criteria':'熟悉 Python'})
        self.assertEqual(status, 201)
        variant = {**self.card, 'signature':'热搜\n今日活跃\n' + self.card['signature'].replace(' ', '\n')}
        other = {**self.card, 'signature':'合成人员 硬件工程师 3年 硕士 嵌入式 另一设备公司'}
        self.assertEqual(self.collection_status([variant])['completed'], [variant['signature']])
        self.assertEqual(self.collection_status(job_id=2), {'completed':[], 'known':[]})
        self.assertEqual(self.collection_status([other]), {'completed':[], 'known':[]})
        self.assertEqual(self.collection_status([self.card, variant]), {'completed':[], 'known':[]})

    def test_changed_input_can_save_high_score_and_remove_prior_skip_mark(self):
        self.screen(met=False)
        self.data['candidate']['resume'] += '\n新增明确的项目和技术经历。'
        status, body, calls = self.screen(met=True)
        self.assertEqual((status, body['saved'], calls), (200, True, 1))
        self.assertEqual(self.skip_marks(), [])
        progress = self.collection_status(share=True)
        self.assertEqual(progress['completed'], [])
        self.assertTrue(progress['known'][0]['favorite_pending'])
        self.assertEqual(progress['known'][0]['id'], body['id'])

    def test_changed_input_evaluation_failure_is_saved_and_removes_prior_skip_mark(self):
        self.screen(met=False)
        self.data['candidate']['resume'] += '\n更新后的合成项目经历。'
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = ValueError('合成模型失败')
            status, body = self.post('/api/extension/screen', self.data)
        self.assertEqual((status, body['saved'], body['ai_pending']), (200, True, True))
        self.assertEqual(self.skip_marks(), [])
        self.assertEqual(self.counts()['candidates'], 1)
        self.assertEqual(self.counts()['evaluations'], 0)

    def test_failed_mark_write_does_not_report_a_committed_mark(self):
        with server.connect() as db:
            db.execute("""CREATE TRIGGER reject_skip_mark BEFORE INSERT ON collection_skip_marks
                BEGIN SELECT RAISE(ABORT, 'synthetic mark write failure'); END""")
        status, body, _ = self.screen(met=False)
        self.assertIn(status, (400, 500), body)
        self.assertNotEqual(body.get('collection_marked'), True)
        self.assertEqual(self.skip_marks(), [])
        self.assertEqual(set(self.counts().values()), {0})

    def test_failed_later_save_rolls_back_removal_of_existing_skip_mark(self):
        self.screen(met=False)
        previous = self.skip_marks()
        self.data['candidate']['resume'] += '\n新增加的合成经历。'
        with patch.object(server, 'complete_evaluation', return_value={'score':100}), \
                patch.object(server, 'save_source', side_effect=RuntimeError('synthetic disk failure')):
            status, _ = self.post('/api/extension/screen', self.data)
        self.assertEqual(status, 500)
        self.assertEqual(self.skip_marks(), previous)
        self.assertEqual(set(self.counts().values()), {0})

    def test_existing_saved_candidate_takes_priority_over_a_later_low_score_mark(self):
        _, saved, _ = self.screen()
        self.data['candidate']['resume'] += '\n另一版合成资料。'
        with patch.object(server, 'complete_evaluation', return_value={'score':20}):
            status, low = self.post('/api/extension/screen', self.data)
        self.assertEqual((status, low['collection_marked']), (200, True))
        for share in (False, True):
            result = self.collection_status(share=share)
            self.assertEqual(result['completed'], [])
            self.assertEqual(result['known'][0]['id'], saved['id'])
            self.assertTrue(result['known'][0]['favorite_pending'])

    def test_delete_with_clear_marks_also_removes_later_low_score_mark(self):
        _, saved, _ = self.screen()
        self.data['candidate']['resume'] += '\n另一版合成资料。'
        with patch.object(server, 'complete_evaluation', return_value={'score':20}):
            status, low = self.post('/api/extension/screen', self.data)
        self.assertEqual((status, low['collection_marked']), (200, True))
        status, _ = self.post('/api/candidates/delete', {'ids':[saved['id']], 'clear_collection_marks':True})
        self.assertEqual(status, 200)
        self.assertEqual(self.skip_marks(), [])
        self.assertEqual(self.collection_status(), {'completed':[], 'known':[]})

    def test_failed_validation_saves_raw_resume_and_both_attempts_without_fake_score(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.return_value = {'score':'invalid','summary':'synthetic bad response'}
            status, body = self.post('/api/extension/screen', self.data)
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(status,200,body)
        self.assertTrue(body['saved']); self.assertTrue(body['ai_pending']); self.assertIsNone(body['score'])
        diagnostic = body['diagnostic']
        self.assertEqual(diagnostic['code'], 'evaluation_format_invalid')
        self.assertEqual(len(diagnostic['attempts']), 2)
        self.assertEqual(diagnostic['attempts'][1]['result']['score'], 'invalid')
        self.assertTrue(diagnostic['attempts'][0]['validation_path'])
        self.assertEqual(self.counts()['evaluations'], 0)
        candidate = self.state()['candidates'][0]
        self.assertTrue(candidate['ai_pending']); self.assertEqual(candidate['screening_failure'], diagnostic)
        self.assertEqual(candidate['resume'], self.resume)

    def test_connection_failure_is_saved_with_diagnostic_and_credentials_redacted(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = ValueError('模拟连接失败 synthetic-secret')
            status, body = self.post('/api/extension/screen', self.data)
        self.assertEqual(status,200,body)
        self.assertEqual(body['diagnostic']['code'], 'evaluation_failed')
        self.assertNotIn('synthetic-secret', json.dumps(body))
        self.assertEqual(self.counts()['evaluations'], 0)
        self.assertTrue(self.state()['candidates'][0]['ai_pending'])

    def test_large_bad_model_output_is_bounded_in_retained_diagnostics(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.return_value = {'score':'invalid','text':'合成'*30000}
            status, body = self.post('/api/extension/screen', self.data)
        self.assertEqual(status,200,body)
        for attempt in body['diagnostic']['attempts']:
            self.assertTrue(attempt['truncated'])
            self.assertLessEqual(len(attempt['result_preview']), 24000)
            self.assertNotIn('result',attempt)

    def test_busy_and_missing_configuration_do_not_store_failed_candidates(self):
        server.AI_LOCK.acquire()
        try:
            status, body = self.post('/api/extension/screen', self.data)
            self.assertEqual((status, body['code']), (409,'ai_busy'))
        finally:
            server.AI_LOCK.release()
        config=server.load_config(server.DB.parent/'ai-config.json')
        with patch.object(server, 'load_config', return_value={**config,'api_key':'','provider':'deepseek'}), \
                patch.object(server,'CompatibleModel') as adapter:
            status, _ = self.post('/api/extension/screen', self.data)
            self.assertEqual(status,400); adapter.assert_not_called()
        self.assertEqual(set(self.counts().values()), {0})
        self.assertEqual(self.skip_marks(), [])

    def test_invalid_or_incomplete_capture_does_not_call_model_or_save(self):
        self.data['candidate']['capture']['status']='needs_review'
        with patch.object(server,'CompatibleModel') as adapter:
            status, _ = self.post('/api/extension/screen', self.data)
            self.assertEqual(status,400); adapter.assert_not_called()
        self.assertEqual(set(self.counts().values()),{0})
        self.assertEqual(self.skip_marks(), [])

    def test_changed_job_during_model_call_discards_result_without_candidate(self):
        def changed(*args,**kwargs):
            with server.connect() as db:
                db.execute("UPDATE jobs SET jd='新的合成岗位描述' WHERE id=1")
            return {'score':20}
        with patch.object(server,'complete_evaluation',side_effect=changed):
            status, body=self.post('/api/extension/screen',self.data)
        self.assertEqual(status,409,body)
        self.assertEqual(set(self.counts().values()),{0})
        self.assertEqual(self.skip_marks(), [])

    def test_changed_model_configuration_discards_low_score_without_mark(self):
        config = server.load_config(server.DB.parent/'ai-config.json')
        def changed(*args, **kwargs):
            config['revision'] += 1
            return {'score':20}
        with patch.object(server, 'load_config', side_effect=lambda *args, **kwargs:dict(config)), \
                patch.object(server, 'complete_evaluation', side_effect=changed):
            status, body = self.post('/api/extension/screen', self.data)
        self.assertEqual(status, 409, body)
        self.assertEqual(self.skip_marks(), [])
        self.assertEqual(set(self.counts().values()), {0})

    def test_save_error_rolls_back_candidate_and_related_data(self):
        with patch.object(server,'complete_evaluation',return_value={'score':100}), \
                patch.object(server,'save_source',side_effect=RuntimeError('synthetic disk failure')):
            status, _=self.post('/api/extension/screen',self.data)
        self.assertEqual(status,500)
        self.assertEqual(set(self.counts().values()),{0})

    def test_repeated_saved_request_reuses_result_and_keeps_one_evaluation(self):
        self.screen()
        with patch.object(server,'CompatibleModel') as adapter:
            status, body=self.post('/api/extension/screen',self.data)
            self.assertEqual(status,200,body); self.assertTrue(body['cached']); adapter.assert_not_called()
        self.assertEqual(self.counts()['candidates'],1)
        self.assertEqual(self.counts()['evaluations'],1)

    def test_favorite_pending_is_resumable_and_ack_requires_matching_active_card(self):
        _, saved, _ = self.screen()
        status, result=self.post('/api/extension/collection-status',{'job_id':1,'cards':[self.card],'share':False})
        self.assertEqual(status,200); self.assertEqual(result['completed'],[])
        self.assertTrue(result['known'][0]['favorite_pending'])
        status, _=self.post('/api/extension/favorite-complete',{'id':saved['id'],
            'source_card':{**self.card,'signature':'另一份候选人卡片'}})
        self.assertEqual(status,400)
        status, result=self.post('/api/extension/favorite-complete',{'id':saved['id'],'source_card':self.card})
        self.assertEqual((status,result['favorite_pending']),(200,False))
        status, result=self.post('/api/extension/collection-status',{'job_id':1,'cards':[self.card],'share':False})
        self.assertEqual(result['completed'],[])
        self.assertEqual(result['known'][0]['colleague_share_state'],'pending')
        self.assertFalse(self.state()['candidates'][0]['favorite_pending'])
        request={'id':saved['id'],'source_card':self.card}
        status, started=self.post('/api/extension/colleague-share',{**request,'stage':'begin'})
        self.assertEqual((status,started['state']),(200,'attempted'))
        self.assertEqual(self.post('/api/extension/colleague-share',{**request,'stage':'begin'})[0],400)
        status, pending=self.post('/api/extension/collection-status',
                                  {'job_id':1,'cards':[self.card],'share':False})
        self.assertEqual(pending['known'][0]['colleague_share_state'],'attempted')
        self.assertEqual(pending['completed'],[])
        status, confirmed=self.post('/api/extension/colleague-share',{**request,'stage':'complete'})
        self.assertEqual((status,confirmed['state']),(200,'confirmed'))
        self.assertEqual(self.post('/api/extension/colleague-share',{**request,'stage':'complete'})[0],400)
        status, done=self.post('/api/extension/collection-status',
                              {'job_id':1,'cards':[self.card],'share':False})
        self.assertEqual(done['completed'],[self.card['signature']])
        # Idempotent acknowledgement never toggles the browser favorite.
        self.assertEqual(self.post('/api/extension/favorite-complete',{'id':saved['id'],'source_card':self.card})[0],200)
        with server.connect() as db:
            db.execute('UPDATE candidates SET deleted=1 WHERE id=?',(saved['id'],))
        self.assertEqual(self.post('/api/extension/favorite-complete',{'id':saved['id'],'source_card':self.card})[0],400)

    def test_archived_record_keeps_skip_mark_without_resuming_favorite(self):
        _, saved, _ = self.screen()
        with server.connect() as db:
            db.execute('UPDATE candidates SET deleted=1 WHERE id=?', (saved['id'],))
        status, result = self.post('/api/extension/collection-status',
                                  {'job_id':1, 'cards':[self.card], 'share':False})
        self.assertEqual(status, 200)
        self.assertEqual(result['completed'], [self.card['signature']])
        self.assertFalse(result['known'][0]['favorite_pending'])

    def test_manual_profile_values_cannot_receive_an_evaluation_of_different_input(self):
        data=self.data['candidate']
        cid,_=server.save_boss_candidate(1,data['name'],data['resume'],'',card=server.source_card(self.card))
        with server.connect() as db:
            server.bump_profile(db,cid,{'education':'人工维护的硕士'})
            server.save_profile_sources(db,cid,{'education':{'source':'manual','evidence':''}})
        with patch.object(server,'complete_evaluation',return_value={'score':100}):
            status, body=self.post('/api/extension/screen',self.data)
        self.assertEqual(status,409,body)
        self.assertEqual(self.counts()['evaluations'],0)
        self.assertEqual(self.counts()['candidate_screening'],0)


if __name__ == '__main__':
    unittest.main()
