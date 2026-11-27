"""Clear all AI evaluations atomically while preserving candidate/source records."""
import hashlib
import json
from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from collection_policy import collection_policy, policy_json, policy_key
import test_record_editing as fixture


class ClearEvaluationsTests(unittest.TestCase):
    post = fixture.RecordEditingTests.post
    stop_http = fixture.RecordEditingTests.stop_http
    seed_evaluation = fixture.RecordEditingTests.seed_evaluation
    snapshot = fixture.RecordEditingTests.snapshot

    PRESERVED_TABLES = ('jobs', 'job_requirements', 'job_priorities', 'candidates',
        'candidate_profiles', 'candidate_profile_sources', 'candidate_sources',
        'candidate_resume_formats', 'candidate_card_keys', 'candidate_colleague_shares',
        'communication_conversations', 'communication_messages', 'communication_attachments')
    EVALUATION_TABLES = ('evaluations', 'evaluation_inputs', 'candidate_evaluation_failures',
        'candidate_screening', 'collection_skip_marks', 'communication_resumes', 'audit')
    SOURCE_EVALUATION_FIELDS = {'evaluation_json', 'evaluation_status', 'error',
        'evaluation_saved_to_candidate', 'candidate_evaluation_id', 'updated'}

    def setUp(self):
        gate = patch.object(server, 'AI_LOCK', server.AIExecutionGate())
        gate.start()
        self.addCleanup(gate.stop)
        network = patch.object(server, 'model_urlopen', side_effect=AssertionError('No real model calls'))
        self.network = network.start()
        self.addCleanup(network.stop)
        fixture.RecordEditingTests.setUp(self)
        self.addCleanup(self.network.assert_not_called)
        self.seed_evaluation(self.cid)
        self.policy = collection_policy({'save_above': 40, 'share_above': 70,
                                         'share_mode': 'colleague', 'colleague_name': '合成同事'})
        with server.connect() as db:
            self.evaluation_id = db.execute('SELECT MAX(id) FROM evaluations').fetchone()[0]
            db.execute("UPDATE candidates SET note='人工维护备注',review='人工保留' WHERE id=?", (self.cid,))
            db.execute("UPDATE candidate_profiles SET skills='人工确认技能',wechat='人工联系方式',resume_edited=1 WHERE candidate_id=?", (self.cid,))
            db.execute("INSERT OR REPLACE INTO candidate_profile_sources VALUES(?,'skills','manual','人工核实依据')", (self.cid,))
            db.execute('''INSERT INTO candidate_screening(candidate_id,input_hash,score,failure_json,
                favorite_pending,policy_json) VALUES(?,?,?,?,?,?)''',
                (self.cid, 'synthetic-input-hash', 80, '{"message":"旧评估失败"}', 0, policy_json(self.policy)))
            db.execute('INSERT INTO candidate_colleague_shares VALUES(?,?,?,?)',
                (self.cid, '合成同事', 'confirmed', 'fixture'))
            db.execute('''INSERT INTO collection_skip_marks(job_id,card_key,input_hash,score,created,policy_key)
                VALUES(2,'synthetic-skipped-card','synthetic-low-score-input',20,'fixture',?)''',
                (policy_key(self.policy),))
            failed_audit = db.execute("INSERT INTO audit(action,detail,created) VALUES('evaluate_pending',?,'fixture')",
                                      (str(self.cid),)).lastrowid
            db.execute('INSERT INTO candidate_evaluation_failures VALUES(?,?,?,?)',
                (self.cid, 'synthetic-input-hash', '{"message":"旧失败诊断"}', failed_audit))
            conversation = db.execute('''INSERT INTO communication_conversations(account_id,account_name,
                job_id,friend_id,candidate_name,candidate_id,platform_geek_id,platform_job_id,last_message,updated)
                VALUES('synthetic-account','合成招聘员',1,'synthetic-friend',?,?,'synthetic-geek',
                       'synthetic-job','需要保留的沟通内容','fixture')''', (self.card['name'], self.cid))
            self.conversation_id = conversation.lastrowid
            message = db.execute('''INSERT INTO communication_messages(conversation_id,platform_message_id,
                direction,text,kind,attachment_name,attachment_status,attachment_received,created)
                VALUES(?,'synthetic-message','incoming','合成附件说明','attachment','resume.txt','received',1,'fixture')''',
                (self.conversation_id,))
            content = self.resume.encode('utf-8')
            attachment = db.execute('''INSERT INTO communication_attachments(message_id,name,size,sha256,
                content,text,imported) VALUES(?,'resume.txt',?,?,?,?, 'fixture')''',
                (message.lastrowid, len(content), hashlib.sha256(content).hexdigest(), content, self.resume))
            self.attachment_id = attachment.lastrowid
            self.source_ids = []
            for label, kind, status, evaluation_id, saved, result, error in (
                ('linked', 'attachment', 'complete', self.evaluation_id, 1, '{"score":80}', ''),
                ('source-only', 'online', 'complete', None, 0, '{"score":60,"summary":"仅沟通来源保存的评估"}', ''),
                ('failed', 'online', 'failed', None, 0, '', '合成失败来源原因'),
            ):
                source = db.execute('''INSERT INTO communication_resumes(conversation_id,source_kind,
                    source_key,attachment_id,name,resume,resume_html,capture_json,sha256,
                    evaluation_json,evaluation_status,error,evaluation_saved_to_candidate,
                    candidate_evaluation_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                    (self.conversation_id, kind, label, self.attachment_id if kind == 'attachment' else None,
                     self.card['name'], self.resume + '\n' + label, '<p>来源富文本</p>',
                     '{"status":"visible_complete","sections":["工作经历"],"warnings":[]}', label,
                     result, status, error, saved, evaluation_id, 'fixture-created', 'fixture-updated'))
                self.source_ids.append(source.lastrowid)

    def sources(self):
        with server.connect() as db:
            return [dict(row) for row in db.execute('SELECT * FROM communication_resumes ORDER BY id')]

    def source_content(self):
        return [{key: value for key, value in row.items() if key not in self.SOURCE_EVALUATION_FIELDS}
                for row in self.sources()]

    def clear_response(self):
        try:
            return 200, self.post('/api/evaluations/clear', {})
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def assert_evaluations_empty(self):
        with server.connect() as db:
            for table in ('evaluations', 'evaluation_inputs', 'candidate_evaluation_failures', 'collection_skip_marks'):
                self.assertEqual(db.execute('SELECT count(*) FROM ' + table).fetchone()[0], 0, table)
            self.assertEqual(list(db.execute('PRAGMA foreign_key_check')), [])
        for row in self.sources():
            self.assertEqual(row['evaluation_json'], '')
            self.assertEqual(row['evaluation_status'], 'not_requested')
            self.assertEqual(row['error'], '')
            self.assertEqual(row['evaluation_saved_to_candidate'], 0)
            self.assertIsNone(row['candidate_evaluation_id'])

    def test_clear_resets_all_source_evaluations_and_keeps_source_and_manual_records(self):
        records_before = self.snapshot(self.PRESERVED_TABLES)
        sources_before = self.source_content()
        status, body = self.clear_response()
        self.assertEqual(status, 200, body)
        self.assertEqual(body, {'ok': True, 'deleted': 2})
        self.assert_evaluations_empty()
        self.assertEqual(self.snapshot(self.PRESERVED_TABLES), records_before)
        self.assertEqual(self.source_content(), sources_before)
        with server.connect() as db:
            screening = dict(db.execute('SELECT * FROM candidate_screening WHERE candidate_id=?', (self.cid,)).fetchone())
            self.assertIsNone(screening['score'])
            self.assertEqual(screening['input_hash'], '')
            self.assertEqual(screening['failure_json'], '')
            self.assertEqual(screening['favorite_pending'], 0)
            self.assertEqual(screening['policy_json'], policy_json(self.policy))
        detail = self.post('/api/communications/detail', {'id': self.conversation_id})
        self.assertEqual(len(detail['conversation']['resumes']), 3)
        for source in detail['conversation']['resumes']:
            self.assertEqual(source['evaluation_status'], 'not_requested')
            self.assertIsNone(source['evaluation'])
            self.assertEqual(source['candidate_id'], self.cid)

    def test_repeated_clear_is_idempotent(self):
        self.assertEqual(self.clear_response(), (200, {'ok': True, 'deleted': 2}))
        before = self.snapshot(self.PRESERVED_TABLES)
        sources_before = self.source_content()
        self.assertEqual(self.clear_response(), (200, {'ok': True, 'deleted': 0}))
        self.assert_evaluations_empty()
        self.assertEqual(self.snapshot(self.PRESERVED_TABLES), before)
        self.assertEqual(self.source_content(), sources_before)

    def test_active_ai_shared_reservation_returns_409_without_any_mutation(self):
        tables = self.PRESERVED_TABLES + self.EVALUATION_TABLES
        before = self.snapshot(tables)
        self.assertTrue(server.AI_LOCK.reserve_shared())
        try:
            status, body = self.clear_response()
            self.assertEqual(status, 409, body)
            self.assertEqual(self.snapshot(tables), before)
        finally:
            server.AI_LOCK.release_shared()

    def test_database_failure_rolls_back_resets_and_deletes_together(self):
        with server.connect() as db:
            db.execute('''CREATE TRIGGER reject_clear_evaluations BEFORE DELETE ON evaluations
                BEGIN SELECT RAISE(ABORT, 'synthetic clear failure'); END''')
        tables = self.PRESERVED_TABLES + self.EVALUATION_TABLES
        before = self.snapshot(tables)
        status, body = self.clear_response()
        self.assertGreaterEqual(status, 400, body)
        self.assertEqual(self.snapshot(tables), before)
        self.assertTrue(server.AI_LOCK.acquire(blocking=False), 'failure must release the AI gate')
        server.AI_LOCK.release()
        with server.connect() as db:
            db.execute('DROP TRIGGER reject_clear_evaluations')
        self.assertEqual(self.clear_response(), (200, {'ok': True, 'deleted': 2}))
        self.assert_evaluations_empty()


if __name__ == '__main__':
    unittest.main()
