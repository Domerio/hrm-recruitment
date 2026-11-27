"""Persistent latest-failure diagnostics use synthetic model responses only."""
from datetime import datetime, timezone, timedelta
import json
import os
import threading
import unittest
from unittest.mock import patch

import server
import test_extension_screening as fixture


class EvaluationFailureTests(unittest.TestCase):
    setUp = fixture.ExtensionScreeningTests.setUp
    stop_http = fixture.ExtensionScreeningTests.stop_http
    post = fixture.ExtensionScreeningTests.post
    state = fixture.ExtensionScreeningTests.state

    def candidate(self, suffix='one'):
        status, body = self.post('/api/candidates',{'job_id':1,'name':'合成人员 '+suffix,'resume':self.resume})
        self.assertEqual(status,201,body)
        return body['id']

    def record(self,cid):
        return next(row for row in self.state()['candidates'] if row['id']==cid)

    def result(self,score=80):
        return {'score':score,'category':'推荐','summary':'合成结果','checks':[],'questions':[],
                'scoring':{'version':server.SCORING_VERSION}}

    def fail(self,cid,error=None):
        with patch.object(server,'complete_evaluation',side_effect=error or ValueError('合成连接失败')):
            return self.post('/api/ai/evaluate',{'id':cid})

    def succeed(self,cid):
        with patch.object(server,'complete_evaluation',return_value=self.result()) as inference:
            response = self.post('/api/ai/evaluate',{'id':cid})
        self.assertEqual(response[0],200,response)
        return inference.call_count

    def fingerprint(self,db,cid):
        c = db.execute('SELECT * FROM candidates WHERE id=?',(cid,)).fetchone()
        return server.evaluation_fingerprint(server.job_record(db,c['job_id']),c,server.profile_record(db,cid),
            datetime.now(timezone(timedelta(hours=8))).date())

    def screening_failure(self,cid,message='合成采集失败'):
        diagnostic = server.screening_failure(ValueError(message),server.load_config(server.DB.parent/'ai-config.json'),
            {'revision':1},[])
        with server.connect() as db:
            db.execute('''INSERT INTO candidate_screening(candidate_id,input_hash,score,failure_json,favorite_pending)
                VALUES(?,?,NULL,?,1) ON CONFLICT(candidate_id) DO UPDATE SET failure_json=excluded.failure_json,
                input_hash=excluded.input_hash''',(cid,self.fingerprint(db,cid),json.dumps(diagnostic)))
            server.audit(db,'evaluate_pending',str(cid))
            server.audit(db,'screening_failed',str(cid))
        return diagnostic

    def test_single_and_batch_failures_survive_reload_and_database_reinitialization(self):
        cid = self.candidate()
        status,body = self.fail(cid)
        self.assertEqual(status,400)
        first = self.record(cid)
        self.assertTrue(first['ai_pending'])
        self.assertEqual(first['evaluation_failure']['message'],'合成连接失败')
        self.assertEqual(first['evaluation_failure']['code'],'evaluation_failed')
        self.assertEqual(first['history'],[])
        server.init_db()
        self.assertEqual(self.record(cid)['evaluation_failure'],first['evaluation_failure'])
        other = self.candidate('batch')
        with patch.object(server,'complete_evaluation',side_effect=ValueError('合成批量评估失败')):
            status,submitted = self.post('/api/ai/tasks',{'action':'evaluate','data':{'id':other}})
            self.assertEqual(status,202,submitted)
            task = submitted.get('task',submitted)
            self.assertEqual(server.ai_queue().wait(task['id'])[0],400)
        self.assertEqual(self.record(other)['evaluation_failure']['message'],'合成批量评估失败')
        self.assertEqual(self.record(cid)['evaluation_failure'],first['evaluation_failure'])

    def test_formats_evidence_connection_and_runtime_failures_have_persistent_reasons(self):
        cases = [(server.EvaluationFormatError('合成格式错误','checks[0].status'),422,'evaluation_format_invalid'),
                 (server.EvaluationEvidenceMismatch('合成依据不一致'),422,'evaluation_evidence_mismatch'),
                 (OSError('合成网络中断'),502,'evaluation_failed'),
                 (RuntimeError('合成模型服务异常'),502,'evaluation_failed')]
        for index,(error,status,code) in enumerate(cases):
            with self.subTest(code=code,error=str(error)):
                cid = self.candidate(str(index))
                self.assertEqual(self.fail(cid,error)[0],status)
                diagnostic = self.record(cid)['evaluation_failure']
                self.assertEqual(diagnostic['message'],str(error))
                self.assertEqual(diagnostic['code'],code)
                self.assertTrue(diagnostic['created'])
                self.assertEqual(diagnostic['model'],'synthetic-model')
                self.assertEqual(diagnostic['validation_path'],getattr(error,'path',''))

    def test_latest_failure_preserves_success_history_and_next_success_clears_it(self):
        cid = self.candidate()
        self.succeed(cid)
        history = self.record(cid)['history']
        with server.connect() as db:
            db.execute('DELETE FROM evaluation_inputs WHERE evaluation_id=?',(history[0]['id'],))
        self.fail(cid,ValueError('最新一次失败'))
        failed = self.record(cid)
        self.assertEqual(failed['history'],history)
        self.assertEqual(failed['evaluation_failure']['message'],'最新一次失败')
        self.assertTrue(failed['ai_pending'])
        self.succeed(cid)
        succeeded = self.record(cid)
        self.assertIsNone(succeeded['evaluation_failure'])
        self.assertIsNone(succeeded['screening_failure'])
        self.assertFalse(succeeded['ai_pending'])
        self.assertEqual(len(succeeded['history']),2)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_evaluation_failures').fetchone()[0],0)

    def test_cached_success_hides_old_screening_failure_without_changing_collection_state(self):
        cid = self.candidate()
        self.succeed(cid)
        history = self.record(cid)['history']
        expected = self.screening_failure(cid)
        self.assertEqual(self.record(cid)['evaluation_failure'],expected)
        self.assertEqual(self.record(cid)['screening_failure'],expected)
        with server.connect() as db:
            db.execute("INSERT INTO candidate_colleague_shares VALUES(?,'合成收件人','attempted','now')",(cid,))
            before = tuple(db.execute('SELECT * FROM candidate_screening WHERE candidate_id=?',(cid,)).fetchone())
            share_before = tuple(db.execute('SELECT * FROM candidate_colleague_shares').fetchone())
        self.assertEqual(self.succeed(cid),0)
        current = self.record(cid)
        self.assertIsNone(current['evaluation_failure'])
        self.assertIsNone(current['screening_failure'])
        self.assertEqual(current['history'],history)
        with server.connect() as db:
            self.assertEqual(tuple(db.execute('SELECT * FROM candidate_screening WHERE candidate_id=?',(cid,)).fetchone()),before)
            self.assertEqual(tuple(db.execute('SELECT * FROM candidate_colleague_shares').fetchone()),share_before)

    def test_latest_valid_screening_failure_or_standard_failure_wins(self):
        cid = self.candidate()
        first = self.screening_failure(cid,'先采集失败')
        self.assertEqual(self.record(cid)['evaluation_failure'],first)
        self.fail(cid,ValueError('后标准评估失败'))
        self.assertEqual(self.record(cid)['evaluation_failure']['message'],'后标准评估失败')
        self.assertIsNone(self.record(cid)['screening_failure'])
        last = self.screening_failure(cid,'最新采集失败')
        self.assertEqual(self.record(cid)['evaluation_failure'],last)
        self.assertEqual(self.record(cid)['screening_failure'],last)

    def test_input_job_or_model_changes_hide_previous_failure(self):
        for kind in ('candidate','job','model'):
            with self.subTest(kind=kind):
                cid = self.candidate(kind)
                self.fail(cid)
                self.assertIsNotNone(self.record(cid)['evaluation_failure'])
                if kind=='model':
                    with patch.dict(os.environ,{'AI_MODEL':'other-synthetic-model'}):
                        self.assertIsNone(self.record(cid)['evaluation_failure'])
                else:
                    with server.connect() as db:
                        if kind=='candidate': db.execute("UPDATE candidates SET resume=resume||'新增内容' WHERE id=?",(cid,))
                        else: db.execute("UPDATE jobs SET jd=jd||'新增条件' WHERE id=1")
                    self.assertIsNone(self.record(cid)['evaluation_failure'])

    def test_invalid_model_configuration_keeps_state_and_configuration_recovery_available(self):
        cid = self.candidate()
        self.fail(cid)
        diagnostic = self.record(cid)['evaluation_failure']
        path = server.DB.parent/'ai-config.json'
        path.write_text('{invalid-json',encoding='utf-8')
        try:
            state = self.state()
            self.assertFalse(state['configured'])
            self.assertEqual(state['ai_config']['source'],'invalid')
            self.assertTrue(state['ai_config']['error'])
            candidate = next(row for row in state['candidates'] if row['id']==cid)
            self.assertIsNone(candidate['evaluation_failure'])
            self.assertIsNone(candidate['screening_failure'])
        finally:
            path.unlink()
        self.assertEqual(self.record(cid)['evaluation_failure'],diagnostic)

    def test_diagnostic_configuration_fallback_does_not_swallow_unrelated_errors(self):
        cid = self.candidate()
        self.fail(cid)
        with server.connect() as db:
            candidate = db.execute('SELECT * FROM candidates WHERE id=?',(cid,)).fetchone()
            with patch.object(server,'evaluation_fingerprint',side_effect=ValueError('unrelated input error')):
                with self.assertRaisesRegex(ValueError,'unrelated input error'):
                    server.candidate_evaluation_diagnostics(db,candidate)

    def test_changed_input_while_model_fails_does_not_attach_to_new_input(self):
        cid = self.candidate()
        def fail(*args,**kwargs):
            with server.connect() as db:
                db.execute("UPDATE candidates SET resume=resume||'已修改内容' WHERE id=?",(cid,))
            raise ValueError('旧输入的模型失败')
        with patch.object(server,'complete_evaluation',side_effect=fail):
            self.assertEqual(self.post('/api/ai/evaluate',{'id':cid})[0],400)
        self.assertIsNone(self.record(cid)['evaluation_failure'])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_evaluation_failures').fetchone()[0],0)

    def test_slow_old_failure_cannot_replace_a_concurrent_new_success(self):
        cid = self.candidate()
        started,release = threading.Event(),threading.Event()
        results = []
        def evaluate(*args,**kwargs):
            if threading.current_thread().name=='synthetic-old-failure':
                started.set()
                if not release.wait(5): raise AssertionError('Test release timed out')
                raise ValueError('旧任务晚到的失败')
            return self.result()
        with patch.object(server,'complete_evaluation',side_effect=evaluate):
            thread = threading.Thread(target=lambda:results.append(server.execute_standard_ai('/api/ai/evaluate',{'id':cid})),
                name='synthetic-old-failure')
            thread.start()
            try:
                self.assertTrue(started.wait(5))
                self.assertEqual(server.execute_standard_ai('/api/ai/evaluate',{'id':cid})[0],200)
            finally:
                release.set();thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0][0],400)
        record = self.record(cid)
        self.assertFalse(record['ai_pending'])
        self.assertIsNone(record['evaluation_failure'])
        self.assertEqual(len(record['history']),1)

    def test_diagnostics_redact_credentials_before_truncating_messages_or_nested_outputs(self):
        cid = self.candidate()
        secret = 'synthetic-secret'
        self.fail(cid,ValueError('x'*990+secret+' tail'))
        diagnostic = self.record(cid)['evaluation_failure']
        self.assertNotIn(secret,json.dumps(diagnostic))
        self.assertNotIn('synthetic',diagnostic['message'])
        # Exercise complete_evaluation's captured raw model result, not only top-level errors.
        answer = {'score':'invalid','nested':{'credential':secret},'large':'z'*24000+secret}
        with patch.object(server,'CompatibleModel') as adapter:
            adapter.return_value.config = server.load_config(server.DB.parent/'ai-config.json')
            adapter.return_value.complete.return_value = answer
            self.assertEqual(self.post('/api/ai/evaluate',{'id':cid})[0],422)
        diagnostic = self.record(cid)['evaluation_failure']
        self.assertEqual(len(diagnostic['attempts']),2)
        self.assertNotIn(secret,json.dumps(diagnostic,ensure_ascii=False))
        self.assertTrue(all(attempt['truncated'] for attempt in diagnostic['attempts']))

    def test_delete_and_clear_remove_failures_without_changing_favorite_or_success_history_on_delete(self):
        cid = self.candidate()
        self.screening_failure(cid)
        self.fail(cid)
        other = self.candidate('retained')
        self.fail(other)
        self.assertEqual(self.post('/api/candidates/delete',{'ids':[cid]})[0],200)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_evaluation_failures WHERE candidate_id=?',(cid,)).fetchone()[0],0)
            self.assertEqual(tuple(db.execute('SELECT failure_json,favorite_pending,input_hash FROM candidate_screening WHERE candidate_id=?',(cid,)).fetchone()),('',1,''))
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_evaluation_failures WHERE candidate_id=?',(other,)).fetchone()[0],1)
        self.assertEqual(self.post('/api/evaluations/clear',{})[0],200)
        record = self.record(other)
        self.assertIsNone(record['evaluation_failure'])
        self.assertIsNone(record['screening_failure'])
        self.assertFalse(record['ai_pending'])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_evaluation_failures').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT favorite_pending FROM candidate_screening WHERE candidate_id=?',(cid,)).fetchone()[0],1)


if __name__ == '__main__':
    unittest.main()
