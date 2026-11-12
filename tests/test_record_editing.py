import base64
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import server


_PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfkAAAAASUVORK5CYII='
)
_CAPTURE = {'status':'visible_complete', 'sections':['工作经历', '教育经历'], 'warnings':[]}
_JOB_FIELDS = ('title', 'city', 'jd', 'criteria', 'must_have', 'revision')
_CANDIDATE_FIELDS = (
    'job_id', 'name', 'resume', 'phone', 'email', 'link', 'note', 'revision',
    'company', 'title', 'city', 'education', 'skills', 'wechat',
)


class RecordEditingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for attribute, name in [('DB', 'records.sqlite'), ('EXTENSION_FILE', 'extension.json')]:
            patcher = patch.object(server, attribute, Path(directory.name) / name)
            patcher.start()
            self.addCleanup(patcher.stop)
        server.init_db()
        with server.connect() as db:
            for jid in (1, 2):
                db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)',
                           (jid, f'测试岗位{jid}', '上海', '岗位职责', '图像处理经验', 'fixture'))
        self.card = {'name':'张**', 'signature':'张** 本科 8年 上海 在职 熟悉医学图像算法开发和工业视觉软件交付'}
        self.resume = '张**\n工作经历\n测试科技有限公司\n图像工程师\n负责医学图像处理和生产线视觉算法开发。\n教育经历\n测试大学本科。'
        self.cid, _ = server.save_boss_candidate(
            1, self.card['name'], self.resume, '', _CAPTURE,
            '<h2>工作经历</h2><p><strong>测试富文本履历</strong></p>', server.source_card(self.card),
        )
        with server.connect() as db:
            db.execute('''UPDATE candidate_sources SET share_image=?,share_status=?,qr_url=?,qr_status=?
                WHERE candidate_id=?''', (_PNG, '已保存测试回访图片', 'https://www.zhipin.com/qr/fixture', 'recognized', self.cid))
        self.seed_evaluation(self.cid)
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_http)
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def post(self, path, data):
        request = urllib.request.Request(
            self.base + path, data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type':'application/json', 'X-App-Token':server.TOKEN},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def state(self):
        with urllib.request.urlopen(self.base + '/api/state', timeout=5) as response:
            return json.load(response)

    def job(self, jid=1):
        return next(job for job in self.state()['jobs'] if job['id'] == jid)

    def candidate(self, cid=None):
        return next(candidate for candidate in self.state()['candidates'] if candidate['id'] == (cid or self.cid))

    def update_job(self, jid=1, **changes):
        values = self.job(jid)
        return self.post('/api/jobs/update', {'id':jid, **{key:values[key] for key in _JOB_FIELDS}, **changes})

    def update_candidate(self, **changes):
        values = self.candidate()
        return self.post('/api/candidates/update', {'id':self.cid,
                         **{key:values[key] for key in _CANDIDATE_FIELDS}, **changes})

    def assert_error(self, status, path, data):
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.post(path, data)
        self.assertEqual(raised.exception.code, status)
        return json.load(raised.exception)

    def seed_evaluation(self, cid):
        result = {'score':80, 'category':'推荐', 'summary':'测试评估', 'questions':[],
                  'checks':[{'condition':'图像处理经验', 'status':'满足', 'basis':'explicit', 'evidence':'医学图像处理'}],
                  'inferred_capabilities':[]}
        with server.connect() as db:
            cursor = db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                                (cid, 'fixture-model', json.dumps(result), 'fixture'))
            db.execute('INSERT INTO evaluation_inputs VALUES(?,?)', (cursor.lastrowid, 'fixture-fingerprint'))
            server.audit(db, 'evaluate', str(cid))

    def mark_evaluated(self):
        with server.connect() as db:
            server.audit(db, 'evaluate', str(self.cid))

    def snapshot(self, tables):
        with server.connect() as db:
            return {table:[tuple(row) for row in db.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
                    for table in tables}

    def test_legacy_job_starts_at_zero_and_import_populates_profile(self):
        job, candidate = self.job(), self.candidate()
        self.assertEqual((job['revision'], job['must_have']), (0, ''))
        self.assertEqual(candidate['revision'], 1)
        self.assertEqual(candidate['company'], '测试科技有限公司')
        self.assertEqual(candidate['title'], '图像工程师')
        self.assertEqual(candidate['profile_sources']['company']['source'], 'resume')
        self.assertTrue(all(candidate[key] == '' for key in ('city', 'education', 'skills', 'wechat')))
        result = self.update_job(title='更新岗位名称', city='温州')
        self.assertEqual(result, {'ok':True, 'id':1, 'revision':1, 'changed':True, 'pending_candidates':0})
        self.assertEqual(self.job()['criteria'], '图像处理经验')
        self.assertEqual(self.job()['must_have'], '')
        self.assertFalse(self.candidate()['ai_pending'])
        no_change = self.update_job()
        self.assertFalse(no_change['changed'])
        self.assertEqual(no_change['revision'], 1)

    def test_each_job_requirement_change_marks_only_previously_evaluated_candidates_pending(self):
        with server.connect() as db:
            db.execute('''INSERT INTO candidates(job_id,name,resume,phone,email,link,created)
                VALUES(1,'另一测试候选人','尚未评估的资料','','','','fixture')''')
        for field, value in [('jd', '新的岗位职责'), ('criteria', '新的普通条件'), ('must_have', '必须具备图像开发经验\n必须具备C++经验')]:
            with self.subTest(field=field):
                self.mark_evaluated()
                result = self.update_job(**{field:value})
                self.assertEqual(result['pending_candidates'], 1)
                self.assertEqual(self.job()[field], value)
                self.assertTrue(self.candidate()['ai_pending'])
                self.assertEqual(len(self.candidate()['history']), 1)
                other = next(candidate for candidate in self.state()['candidates'] if candidate['id'] != self.cid)
                self.assertFalse(other['ai_pending'])

    def test_job_validation_failure_and_stale_revision_leave_no_partial_changes(self):
        self.update_job(title='已经保存的名称')
        tables = ['jobs', 'job_requirements', 'audit']
        before = self.snapshot(tables)
        payload = {'id':1, **{key:self.job()[key] for key in _JOB_FIELDS},
                   'revision':0, 'title':'不应写入的名称', 'jd':'不应写入的新JD'}
        self.assert_error(409, '/api/jobs/update', payload)
        self.assertEqual(self.snapshot(tables), before)
        payload['revision'] = self.job()['revision']
        payload['must_have'] = '过长' * 251
        self.assert_error(400, '/api/jobs/update', payload)
        self.assertEqual(self.snapshot(tables), before)
        payload['must_have'] = '\n'.join(f'条件{index}' for index in range(51))
        self.assert_error(400, '/api/jobs/update', payload)
        self.assertEqual(self.snapshot(tables), before)

    def test_candidate_professional_fields_resume_and_job_changes_mark_ai_pending(self):
        for field, value in [
            ('company', '测试新公司'), ('title', '高级算法工程师'), ('city', '温州'),
            ('education', '硕士'), ('skills', 'Python\nC++'), ('resume', self.resume + '\n新增已核实的项目经历。'),
            ('job_id', 2),
        ]:
            with self.subTest(field=field):
                self.mark_evaluated()
                result = self.update_candidate(**{field:value})
                self.assertTrue(result['evaluation_invalidated'])
                candidate = self.candidate()
                self.assertEqual(candidate[field], value)
                self.assertTrue(candidate['ai_pending'])
                self.assertEqual(len(candidate['history']), 1)

    def test_candidate_contact_note_and_name_changes_preserve_ai_and_rich_source_data(self):
        tables = ['candidate_sources', 'candidate_resume_formats', 'evaluations', 'evaluation_inputs']
        before = self.snapshot(tables)
        previous_revision = self.candidate()['revision']
        result = self.update_candidate(name='人工维护名称', phone='13800000000', email='fixture@example.invalid',
                                       link='https://www.zhipin.com/qr/contact', note='人工备注', wechat='fixture-wechat')
        self.assertFalse(result['evaluation_invalidated'])
        self.assertEqual(result['revision'], previous_revision + 1)
        candidate = self.candidate()
        self.assertFalse(candidate['ai_pending'])
        self.assertEqual(candidate['name'], '人工维护名称')
        self.assertEqual(candidate['wechat'], 'fixture-wechat')
        self.assertEqual(candidate['note'], '人工备注')
        self.assertTrue(candidate['has_resume_format'])
        self.assertEqual(self.snapshot(tables), before)

    def test_resume_edit_removes_stale_rich_copy_but_keeps_qr_source_history_and_manual_review(self):
        with server.connect() as db:
            db.execute("UPDATE candidates SET review='通过复核' WHERE id=?", (self.cid,))
        tables = ['candidate_sources', 'candidate_card_keys', 'evaluations', 'evaluation_inputs']
        before = self.snapshot(tables)
        result = self.update_candidate(resume=self.resume + '\n人工补充确认的工作内容。')
        self.assertTrue(result['evaluation_invalidated'])
        candidate = self.candidate()
        self.assertFalse(candidate['has_resume_format'])
        self.assertTrue(candidate['ai_pending'])
        self.assertEqual(candidate['review'], '通过复核')
        self.assertEqual(self.snapshot(tables), before)
        self.assertEqual(candidate['source']['qr_status'], 'recognized')
        self.assertEqual(candidate['source']['qr_url'], 'https://www.zhipin.com/qr/fixture')
        self.assertTrue(candidate['source']['image_url'])

    def test_candidate_conflicts_and_invalid_edits_roll_back_profile_resume_and_keys(self):
        self.update_candidate(phone='13800000000')
        tables = ['candidates', 'candidate_profiles', 'candidate_sources', 'candidate_resume_formats',
                  'candidate_card_keys', 'evaluations', 'evaluation_inputs', 'audit']
        before = self.snapshot(tables)
        payload = {'id':self.cid, **{key:self.candidate()[key] for key in _CANDIDATE_FIELDS},
                   'revision':0, 'name':'不应保存', 'job_id':2, 'company':'不应保存的公司',
                   'resume':self.resume + '\n不应写入的正文。'}
        self.assert_error(409, '/api/candidates/update', payload)
        self.assertEqual(self.snapshot(tables), before)
        payload['revision'] = self.candidate()['revision']
        payload['email'] = 'invalid-email'
        self.assert_error(400, '/api/candidates/update', payload)
        self.assertEqual(self.snapshot(tables), before)

    def test_renaming_or_moving_keeps_stable_collection_keys_and_prevents_duplicate_import(self):
        self.update_candidate(name='人工维护名称')
        status = self.post('/api/extension/collection-status', {'job_id':1, 'share':True, 'cards':[self.card]})
        self.assertEqual(status['completed'], [self.card['signature']])
        self.assertEqual(status['known'][0]['id'], self.cid)
        self.update_candidate(job_id=2)
        for jid in (1, 2):
            with self.subTest(job=jid):
                status = self.post('/api/extension/collection-status', {'job_id':jid, 'share':True, 'cards':[self.card]})
                self.assertEqual(status['completed'], [self.card['signature']])
                self.assertEqual(status['known'][0]['id'], self.cid)
                imported = self.post('/api/extension/import', {'job_id':jid, 'candidates':[{
                    'name':self.card['name'], 'resume':self.resume, 'capture':_CAPTURE, 'source_card':self.card,
                }]})
                self.assertEqual(imported['ids'], [self.cid])
                self.assertEqual(imported['added'], 0)
                candidate = self.candidate()
                self.assertEqual(candidate['name'], '人工维护名称')
                self.assertEqual(candidate['job_id'], 2)
        self.assertEqual(len(self.state()['candidates']), 1)

    def test_clear_evaluations_removes_history_cache_and_pending_but_preserves_all_record_data(self):
        created = self.post('/api/candidates', {'job_id':2, 'name':'测试候选人乙', 'resume':'待核对的工作经历资料。'})
        self.seed_evaluation(created['id'])
        with server.connect() as db:
            for action in ('evaluate_pending', 'evaluation_format_invalid'):
                server.audit(db, action, str(self.cid))
        tables = ['jobs', 'job_requirements', 'candidates', 'candidate_profiles',
                  'candidate_sources', 'candidate_resume_formats', 'candidate_card_keys']
        before = self.snapshot(tables)
        self.assertTrue(self.candidate()['ai_pending'])
        self.assertEqual(self.post('/api/evaluations/clear', {}), {'ok':True, 'deleted':2})
        self.assertEqual(self.snapshot(tables), before)
        for candidate in self.state()['candidates']:
            self.assertEqual(candidate['history'], [])
            self.assertFalse(candidate['ai_pending'])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM evaluation_inputs').fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM audit WHERE action IN ('evaluate','evaluate_pending','evaluation_format_invalid')").fetchone()[0], 0)
        self.assertEqual(self.post('/api/evaluations/clear', {}), {'ok':True, 'deleted':0})
        self.assertEqual(self.snapshot(tables), before)

    def test_clear_while_model_lock_is_held_returns_conflict_without_deleting_anything(self):
        before = self.snapshot(['evaluations', 'evaluation_inputs', 'audit'])
        self.assertTrue(server.AI_LOCK.acquire(blocking=False))
        try:
            self.assert_error(409, '/api/evaluations/clear', {})
            self.assertEqual(self.snapshot(['evaluations', 'evaluation_inputs', 'audit']), before)
        finally:
            server.AI_LOCK.release()


if __name__ == '__main__':
    unittest.main()
