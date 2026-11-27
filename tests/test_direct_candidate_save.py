"""Persistence tests for direct resume evaluation."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import server


class DirectCandidateSaveTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        active = patch.object(server, 'DB', Path(directory.name) / 'direct.sqlite')
        active.start(); self.addCleanup(active.stop)
        active = patch.dict(os.environ, {
            'AI_MODEL':'synthetic-model', 'AI_BASE_URL':'https://example.invalid/v1',
            'AI_API_KEY':'synthetic-secret', 'DEEPSEEK_API_KEY':'synthetic-secret',
        })
        active.start(); self.addCleanup(active.stop)
        server.init_db()
        with server.connect() as db:
            cursor = db.execute('INSERT INTO jobs(title,city,jd,criteria,created) VALUES(?,?,?,?,?)',
                ('合成岗位','','设备视觉软件开发','熟悉 Python',server.now()))
            db.execute('INSERT INTO job_requirements VALUES(?,?,1)', (cursor.lastrowid,''))
            db.execute('INSERT INTO job_priorities VALUES(?,?)', (cursor.lastrowid,'[["熟悉 Python"]]'))
        self.resume = ('合成人员\n工作经历 合成设备公司 软件工程师 2020.01 - 至今\n'
                       '负责 Python 设备接口开发、数据处理和程序验证。')
        self.data = {'job_id':1,'name':'合成人员','resume':self.resume}

    def answer(self):
        return {'score':0,'category':'低匹配','summary':'合成测试','questions':[],
                'checks':[{'condition_id':1,'condition':'熟悉 Python','status':'满足','basis':'explicit',
                           'support_score':100,'evidence_lines':[3]}],
                'required_checks':[],'inferred_capabilities':[]}

    def test_success_creates_candidate_evaluation_and_direct_origin_marker(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.return_value = self.answer()
            status, body = server.save_direct_resume_evaluation(self.data)
        self.assertEqual(status, 200, body)
        self.assertTrue(body['saved'])
        self.assertTrue(body['candidate']['added'])
        self.assertEqual(body['source_marker'], 'direct_evaluation')
        self.assertIn('candidate_revision', body['result']['evaluation_context'])
        with server.connect() as db:
            candidate = db.execute('SELECT id,name,resume FROM candidates').fetchone()
            self.assertEqual((candidate['name'],candidate['resume']), ('合成人员',self.resume))
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0], 1)
            self.assertEqual(server.source_info(db,candidate['id'])['origin'], 'direct_evaluation')

    def test_identical_repeat_reuses_candidate_and_cached_evaluation(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.return_value = self.answer()
            first = server.save_direct_resume_evaluation(self.data)
            second = server.save_direct_resume_evaluation(self.data)
            self.assertEqual(adapter.return_value.complete.call_count, 1)
        self.assertEqual(first[0], 200)
        self.assertEqual(second[0], 200)
        self.assertTrue(second[1]['cached'])
        self.assertFalse(second[1]['candidate']['added'])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidates').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0], 1)

    def test_invalid_model_result_does_not_create_candidate_or_history(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.return_value = {}
            status, body = server.save_direct_resume_evaluation(self.data)
        self.assertEqual(status, 422, body)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidates').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0], 0)

    def test_existing_boss_capture_keeps_its_original_source(self):
        capture = {'status':'visible_complete','sections':['工作经历'],'warnings':[],'captured_at':server.now()}
        cid, _ = server.save_boss_candidate(1,'合成人员',self.resume,'',capture=capture)
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.return_value = self.answer()
            status, body = server.save_direct_resume_evaluation(self.data)
        self.assertEqual(status, 200, body)
        self.assertEqual(body['candidate']['id'], cid)
        with server.connect() as db:
            source = server.source_info(db,cid)
            self.assertEqual(source['origin'], '')
            self.assertEqual(source['capture']['status'], 'visible_complete')


if __name__ == '__main__':
    unittest.main()
