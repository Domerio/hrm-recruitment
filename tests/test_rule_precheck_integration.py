"""Rule screening through temp-DB APIs, with no external model/network calls."""
import json
import sqlite3
import threading
import unittest
from unittest.mock import patch

import collection_policy
import server
from tests import test_direct_evaluation as direct_helpers
from tests import test_evaluation_timing_integration as timing_helpers

REQUIREMENT = '本科及以上学历'
NAME = timing_helpers.NAME
RESUME = (NAME + '\n最高学历：大专\n工作经历\n'
          '合成设备公司 软件工程师\n负责 Python 设备接口开发、数据处理和程序验证。')


class RulePrecheckIntegrationTests(unittest.TestCase):
    candidate = timing_helpers.EvaluationTimingIntegrationTests.candidate
    stop_queue = timing_helpers.EvaluationTimingIntegrationTests.stop_queue
    timing_logs = timing_helpers.EvaluationTimingIntegrationTests.timing_logs
    history = timing_helpers.EvaluationTimingIntegrationTests.history
    post = direct_helpers.DirectEvaluationTests.post

    def setUp(self):
        timing_helpers.EvaluationTimingIntegrationTests.setUp(self)
        with server.connect() as db:
            db.execute('UPDATE jobs SET criteria=? WHERE id=1', (REQUIREMENT + '\n熟悉 Python',))
            db.execute('INSERT INTO job_requirements(job_id,must_have,revision) VALUES(1,?,1)', (REQUIREMENT,))
            db.execute('UPDATE candidates SET resume=? WHERE id=?', (RESUME, self.cid))
        active = patch.object(server.Handler, 'log_message', return_value=None)
        active.start()
        self.addCleanup(active.stop)
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        self.addCleanup(self.stop_http)

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=5)
        self.network.assert_not_called()

    def answer(self, instruction, payload):
        evidence = next(int(line.split(']', 1)[0][1:]) for line in payload['resume'].splitlines()
                        if '负责 Python' in line)
        def row(item, field):
            known = item['condition'] == '熟悉 Python'
            return {field: item[field], 'condition': item['condition'],
                    'status': '满足' if known else '信息不足',
                    'basis': 'explicit' if known else 'unknown',
                    'support_score': 100 if known else 0,
                    'evidence_lines': [evidence] if known else []}
        return {'score': 99, 'category': '推荐', 'summary': '合成模型判断', 'questions': [],
                'checks': [row(item, 'condition_id') for item in payload['criteria_items']],
                'required_checks': [row(item, 'requirement_id') for item in payload['required_conditions']],
                'inferred_capabilities': []}

    def screen_data(self):
        card = {'name': NAME, 'signature': NAME + ' Python 大专 合成设备公司'}
        return {'job_id': 1, 'candidate': {'name': NAME, 'resume': RESUME, 'source_card': card,
                'capture': {'status': 'visible_complete', 'sections': ['工作经历'], 'warnings': []}}}

    def assert_rule(self, result):
        self.assertTrue(server.rule_rejected(result), result)
        self.assertIsNone(result['score'])
        self.assertEqual(result['evaluation_method'], 'rules')
        self.assertEqual(result['precheck']['version'], 'hard-rules-v1')
        self.assertEqual(result['precheck']['checks'][0]['evidence_quotes'], ['最高学历：大专'])

    def test_http_preview_rejects_with_evidence_and_no_model_or_persistence(self):
        with patch.object(server.CompatibleModel, 'complete', side_effect=AssertionError('model must be skipped')) as model:
            status, body = self.post('/api/ai/preview-resume', {'job_id': 1, 'resume': RESUME})
        self.assertEqual(status, 200, body)
        self.assert_rule(body['result'])
        self.assertEqual(body['model'], '规则预筛')
        self.assertFalse(body['saved'])
        self.assertEqual(self.history(), [])
        model.assert_not_called()

    def test_missing_highest_degree_is_unknown_and_calls_model_once(self):
        ambiguous = RESUME.replace('最高学历：大专', '教育经历\n合成大学 大专')
        with patch.object(server.CompatibleModel, 'complete', side_effect=self.answer) as model:
            status, body = self.post('/api/ai/preview-resume', {'job_id': 1, 'resume': ambiguous})
        self.assertEqual(status, 200, body)
        self.assertIsInstance(body['result']['score'], int)
        self.assertEqual(body['result']['required_checks'][0]['status'], '信息不足')
        self.assertFalse(server.rule_rejected(body['result']))
        model.assert_called_once()

    def test_direct_save_persists_rules_model_label_and_reuses_history(self):
        data = {'job_id': 1, 'name': NAME, 'resume': RESUME}
        with patch.object(server.CompatibleModel, 'complete', side_effect=AssertionError('model must be skipped')) as model:
            first_status, first = self.post('/api/ai/direct-resume', data)
            second_status, second = self.post('/api/ai/direct-resume', data)
        self.assertEqual((first_status, second_status), (200, 200), (first, second))
        self.assert_rule(first['result'])
        self.assert_rule(second['result'])
        self.assertTrue(second['cached'])
        self.assertEqual(len(self.history()), 1)
        self.assertEqual(self.history()[0]['model'], '规则预筛')
        model.assert_not_called()

    def test_standard_and_batch_queue_persist_rule_results_without_model_attempts(self):
        other = self.candidate('第二条', RESUME + '\n补充合成资料')
        with patch.object(server.CompatibleModel, 'complete', side_effect=AssertionError('model must be skipped')) as model:
            tasks = [server.submit_ai_request('/api/ai/evaluate', {'id': cid}) for cid in [self.cid, other]]
            for task in tasks:
                status, body = server.ai_queue().wait(task['id'], 5)
                self.assertEqual(status, 200, body)
                self.assert_rule(body)
        self.assertEqual([row['model'] for row in self.history()], ['规则预筛', '规则预筛'])
        model.assert_not_called()
        for path in self.timing_logs():
            events = [json.loads(line) for line in path.read_text('utf-8').splitlines()]
            self.assertTrue(any(event.get('step') == 'rule_precheck' for event in events))
            self.assertFalse(any(event.get('step') == 'model_attempt' for event in events))

    def test_local_trace_and_payload_explain_skip_without_fake_model_usage(self):
        with patch.object(server.CompatibleModel, 'complete', side_effect=AssertionError('model must be skipped')):
            status, body = self.post('/api/ai/preview-resume', {'job_id': 1, 'resume': RESUME})
        self.assertEqual(status, 200, body)
        paths = list(self.timing_logs())
        self.assertEqual(len(paths), 1)
        events = [json.loads(line) for line in paths[0].read_text('utf-8').splitlines()]
        decision = next(event for event in events if event['event'] == 'precheck_decision')
        self.assertTrue(decision['model_skipped'])
        self.assertTrue(decision['precheck_rejected'])
        self.assertEqual(events[-1]['metadata']['evaluation_method'], 'rules')
        self.assertEqual(events[-1]['usage_totals'], {})
        self.assertFalse(any(event.get('step') in {'model_attempt', 'http_request'} for event in events))
        payloads = [json.loads(line) for path in self.folder.rglob('*.payloads.jsonl')
                    for line in path.read_text('utf-8').splitlines()]
        rule = next(record for record in payloads if record['kind'] == 'rule_precheck')
        self.assertEqual(rule['payload']['required_conditions'][0]['condition'], REQUIREMENT)
        self.assertEqual(rule['payload']['result']['checks'][0]['evidence_quotes'], ['最高学历：大专'])
        self.assertNotIn(timing_helpers.SECRET, json.dumps(payloads, ensure_ascii=False))

    def test_screen_rule_mark_has_null_score_evidence_and_survives_cached_retry(self):
        data = self.screen_data()
        with patch.object(server.CompatibleModel, 'complete', side_effect=AssertionError('model must be skipped')) as model:
            status, body = self.post('/api/extension/screen', data)
            self.assertEqual(status, 200, body)
            self.assert_rule(body)
            self.assertTrue(body['collection_marked'])
            self.assertFalse(body['saved'])
            with server.connect() as db:
                row = dict(db.execute('SELECT * FROM collection_skip_marks').fetchone())
            self.assertIsNone(row['score'])
            stored = json.loads(row['precheck_json'])
            self.assertEqual(stored['checks'], body['precheck']['checks'])
            self.assertEqual(stored['job_revision'], 1)
            server.init_db()
            status, repeated = self.post('/api/extension/screen', data)
        self.assertEqual(status, 200, repeated)
        self.assert_rule(repeated)
        self.assertTrue(repeated['cached'])
        self.assertEqual(repeated['precheck']['checks'], stored['checks'])
        self.assertEqual(self.history(), [])
        model.assert_not_called()

    def test_rule_skip_status_expires_when_the_job_revision_changes(self):
        data = self.screen_data()
        with patch.object(server.CompatibleModel, 'complete', side_effect=AssertionError('model must be skipped')):
            status, body = self.post('/api/extension/screen', data)
        self.assertEqual(status, 200, body)
        request = {'job_id': 1, 'cards': [data['candidate']['source_card']], 'share': False}
        status, before = self.post('/api/extension/collection-status', request)
        self.assertEqual(status, 200, before)
        self.assertEqual(len(before['completed']), 1)
        with server.connect() as db:
            db.execute('UPDATE job_requirements SET revision=revision+1 WHERE job_id=1')
        status, after = self.post('/api/extension/collection-status', request)
        self.assertEqual(status, 200, after)
        self.assertEqual(after['completed'], [])


class RuleSkipMigrationTests(unittest.TestCase):
    def legacy(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        self.addCleanup(db.close)
        db.execute('CREATE TABLE jobs(id INTEGER PRIMARY KEY)')
        db.execute('INSERT INTO jobs VALUES(1)')
        db.execute('''CREATE TABLE collection_skip_marks(
            job_id INTEGER NOT NULL REFERENCES jobs(id),card_key TEXT NOT NULL,input_hash TEXT NOT NULL,
            score REAL NOT NULL CHECK(score>=0 AND score<=100),created TEXT NOT NULL,
            policy_key TEXT NOT NULL,PRIMARY KEY(job_id,card_key))''')
        db.execute("INSERT INTO collection_skip_marks VALUES(1,'synthetic-card','hash',35,'now','policy')")
        db.commit()
        return db

    def test_migration_preserves_low_score_marks_and_supports_rule_only_rows(self):
        db = self.legacy()
        before = tuple(db.execute('SELECT * FROM collection_skip_marks').fetchone())
        collection_policy.ensure_precheck_marks(db)
        row = db.execute('SELECT * FROM collection_skip_marks').fetchone()
        self.assertEqual(tuple(row)[:-1], before)
        self.assertEqual(row['precheck_json'], '')
        db.execute("INSERT INTO collection_skip_marks VALUES(1,'rule-card','hash2',NULL,'now','policy','{}')")
        collection_policy.ensure_precheck_marks(db)
        self.assertEqual(db.execute('SELECT count(*) FROM collection_skip_marks').fetchone()[0], 2)
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO collection_skip_marks VALUES(1,'invalid','hash3',NULL,'now','policy','')")

    def test_failed_migration_rolls_back_schema_and_marks_without_losing_the_outer_transaction(self):
        db = self.legacy()
        before_sql = db.execute("SELECT sql FROM sqlite_master WHERE name='collection_skip_marks'").fetchone()[0]
        before_rows = [tuple(row) for row in db.execute('SELECT * FROM collection_skip_marks')]
        db.execute('INSERT INTO jobs VALUES(2)')
        class BrokenRename:
            def execute(self, sql, *args):
                if sql.startswith('ALTER TABLE collection_skip_marks_precheck'):
                    raise sqlite3.OperationalError('synthetic rename failure')
                return db.execute(sql, *args)
        with self.assertRaisesRegex(sqlite3.OperationalError, 'synthetic rename failure'):
            collection_policy.ensure_precheck_marks(BrokenRename())
        self.assertTrue(db.in_transaction)
        self.assertEqual(db.execute('SELECT count(*) FROM jobs').fetchone()[0], 2)
        self.assertEqual([tuple(row) for row in db.execute('SELECT * FROM collection_skip_marks')], before_rows)
        self.assertEqual(db.execute("SELECT sql FROM sqlite_master WHERE name='collection_skip_marks'").fetchone()[0], before_sql)
        self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='collection_skip_marks_precheck'").fetchone())


if __name__ == '__main__':
    unittest.main()
