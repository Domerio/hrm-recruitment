from copy import deepcopy
import base64
from html import escape
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from evaluation_scoring import calculate_score, normalize_condition


ORDINARY = ['Python 开发', '系统交付']
MANDATORY = ['本科及以上学历']
ALL_CONDITIONS = ORDINARY + MANDATORY
CARD = {'name': '合成甲', 'signature': '合成甲 本科 8年 合成城市 在职 熟悉图像处理工具开发及系统交付 期望算法工程师'}
RESUME = ('合成甲\n工作经历\n合成研发公司\n算法工程师\n2019.01 - 至今\n'
          '本人使用 Python 开发图像处理工具，并承担现场交付和维护。\n教育经历\n合成大学 本科。')
RICH = ''.join(f'<p>{escape(line)}</p>' for line in RESUME.splitlines())
CAPTURE = {'status': 'visible_complete', 'sections': ['工作经历', '教育经历'], 'warnings': []}
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfkAAAAASUVORK5CYII=')
QR_URL = 'https://m.zhipin.com/profile/synthetic-fixture'


class PriorityRecordHttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        for name, value in [('DB', Path(self.directory.name) / 'priority-records.sqlite'),
                            ('EXTENSION_FILE', Path(self.directory.name) / 'extension.json')]:
            patcher = patch.object(server, name, value)
            patcher.start(); self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {'AI_MODEL': 'synthetic-model', 'AI_BASE_URL': 'https://synthetic.invalid'})
        environment.start(); self.addCleanup(environment.stop)
        server.init_db()
        with server.connect() as db:
            for jid in (1, 2):
                db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)',
                    (jid, f'合成旧岗位{jid}', '', '合成图像开发职责', '\n'.join(ORDINARY), 'earlier'))
            # Simulate an upgraded record with mandatory metadata but no priority row.
            db.execute('INSERT INTO job_requirements VALUES(?,?,?)', (2, '\n'.join(MANDATORY), 7))
        self.cid = server.save_boss_candidate(2, CARD['name'], RESUME, '',
            capture=server.normalize_capture(CAPTURE), resume_html=RICH, card=server.source_card(CARD))[0]
        with server.connect() as db:
            db.execute('UPDATE candidate_sources SET share_image=?,share_status=?,qr_url=?,qr_status=? WHERE candidate_id=?',
                       (PNG, '已保存合成回访图片', QR_URL, 'recognized', self.cid))
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def stop_server(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join()

    def post(self, path, values, status=200):
        request = urllib.request.Request(self.base + path,
            data=json.dumps(values).encode(),
            headers={'X-App-Token': server.TOKEN, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request) as response:
                actual, body = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            actual, body = error.code, json.load(error)
        self.assertEqual(actual, status, body)
        return body

    def state(self):
        with urllib.request.urlopen(self.base + '/api/state') as response:
            return json.load(response)

    def job(self, jid=2):
        return next(row for row in self.state()['jobs'] if row['id'] == jid)

    def candidate(self):
        return next(row for row in self.state()['candidates'] if row['id'] == self.cid)

    def update_job(self, jid=2, include_priority=True, **changes):
        values = {**self.job(jid), **changes}
        if not include_priority:
            values.pop('priority_groups', None)
        return self.post('/api/jobs/update', values)

    def update_candidate(self, **changes):
        return self.post('/api/candidates/update', {**self.candidate(), **changes})

    def snapshot(self):
        with server.connect() as db:
            return {table: [dict(row) for row in db.execute(f'SELECT * FROM {table} ORDER BY 1')]
                    for table in ['jobs', 'job_requirements', 'job_priorities', 'audit']}

    def seed_evaluation(self):
        result = {'score': 70, 'category': '待确认', 'summary': '历史合成评估', 'questions': [],
                  'checks': [{'condition': ORDINARY[0], 'status': '满足', 'evidence': 'Python'}]}
        with server.connect() as db:
            db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                       (self.cid, 'synthetic-legacy', json.dumps(result), 'earlier'))
            server.audit(db, 'evaluate', str(self.cid))
        return result

    def import_resume(self, resume=RESUME, markup=RICH, jid=2):
        return self.post('/api/extension/import', {'job_id': jid, 'candidates': [{
            'name': CARD['name'], 'resume': resume, 'resume_html': markup,
            'capture': CAPTURE, 'source_card': CARD,
        }]})

    def model_answer(self, instruction, payload):
        line = next(int(value[1:value.index(']')]) for value in payload['resume'].splitlines()
                    if value.endswith('本人使用 Python 开发图像处理工具，并承担现场交付和维护。'))
        return {'score': 2, 'category': '低匹配', 'summary': '合成模型评估', 'questions': [],
            'checks': [{'condition_id': row['condition_id'], 'status': '满足', 'evidence_lines': [line]}
                       for row in payload['criteria_items']],
            'required_checks': [{'requirement_id': row['requirement_id'], 'status': '满足', 'evidence_lines': [line]}
                               for row in payload['required_conditions']]}

    def test_legacy_get_defaults_are_individual_priorities_without_writing_metadata(self):
        first = self.job(1)
        self.assertEqual(first['revision'], 0)
        self.assertEqual(first['must_have'], '')
        self.assertEqual(first['priority_groups'], [[text] for text in ORDINARY])
        self.assertFalse(first['priority_configured'])
        self.assertEqual(self.job(2)['priority_groups'], [[text] for text in ALL_CONDITIONS])
        with server.connect() as db:
            db.execute('INSERT INTO jobs VALUES(3,?,?,?,?,?)',
                       ('合成重复条件岗位', '', '合成职责', '1. Python 开发\nPython 开发\n系统交付', 'earlier'))
            db.execute('INSERT INTO job_requirements VALUES(3,?,4)', ('• python 开发\n本科及以上学历',))
        groups = self.job(3)['priority_groups']
        self.assertEqual(len(groups), 3)
        self.assertEqual([normalize_condition(text) for group in groups for text in group],
                         [normalize_condition(text) for text in ALL_CONDITIONS])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM job_priorities').fetchone()[0], 0)
            self.assertIsNone(db.execute('SELECT 1 FROM job_requirements WHERE job_id=1').fetchone())

    def test_new_job_persists_default_and_explicit_groups(self):
        values = {'title': '合成新岗位', 'city': '', 'jd': '合成职责',
                  'criteria': '\n'.join(ORDINARY), 'must_have': '\n'.join(MANDATORY)}
        created = self.post('/api/jobs', values, status=201)
        self.assertEqual(self.job(created['id'])['priority_groups'], [[text] for text in ALL_CONDITIONS])
        groups = [[MANDATORY[0]], ORDINARY]
        created = self.post('/api/jobs', {**values, 'priority_groups': groups}, status=201)
        self.assertEqual(self.job(created['id'])['priority_groups'], groups)
        with server.connect() as db:
            stored = db.execute('SELECT groups_json FROM job_priorities WHERE job_id=?', (created['id'],)).fetchone()[0]
        self.assertEqual(json.loads(stored), groups)

    def test_partition_validation_rejects_atomically_without_partial_title_or_revision(self):
        self.seed_evaluation()
        before = self.snapshot()
        invalid = [
            [['Python 开发']], [['Python 开发', '系统交付', '外来条件']],
            [['Python 开发'], ['1. PYTHON   开发', '系统交付', MANDATORY[0]]],
            [[], ALL_CONDITIONS], [ALL_CONDITIONS, ['额外'], ['再额外'], ['组数超限']],
            [None, ALL_CONDITIONS], ['Python 开发', ['系统交付', MANDATORY[0]]],
            [['Python 开发', True, '系统交付', MANDATORY[0]]],
            [['Python 开发', '', '系统交付', MANDATORY[0]]], {}, False, 'not-groups',
        ]
        for groups in invalid:
            with self.subTest(groups=groups):
                self.post('/api/jobs/update', {**self.job(), 'title': '不应保存的标题', 'priority_groups': groups}, status=400)
                self.assertEqual(self.snapshot(), before)
                self.assertFalse(self.candidate()['ai_pending'])

    def test_normalized_group_labels_are_resolved_to_configured_conditions(self):
        self.update_job(priority_groups=[[' 1. python   开发 '], ['• 系统交付', '2、 本科及以上学历']])
        self.assertEqual(self.job()['priority_groups'], [[ORDINARY[0]], [ORDINARY[1], MANDATORY[0]]])

    def test_empty_priority_array_resets_to_individual_priorities(self):
        self.update_job(priority_groups=[[MANDATORY[0]], ORDINARY])
        self.update_job(priority_groups=[])
        self.assertEqual(self.job()['priority_groups'], [[text] for text in ALL_CONDITIONS])

    def test_new_text_conditions_and_their_explicit_groups_save_together(self):
        self.seed_evaluation()
        old_revision = self.job()['revision']
        criteria = ORDINARY + ['项目维护']
        must = MANDATORY + ['现场交付经历']
        groups = [[criteria[0], must[1]], [criteria[1], criteria[2], must[0]]]
        result = self.update_job(criteria='\n'.join(criteria), must_have='\n'.join(must), priority_groups=groups)
        self.assertEqual(result['revision'], old_revision + 1)
        self.assertEqual(result['pending_candidates'], 1)
        self.assertEqual(self.job()['priority_groups'], groups)
        self.assertEqual(self.job()['criteria'], '\n'.join(criteria))
        self.assertTrue(self.candidate()['ai_pending'])

    def test_legacy_edit_reconciles_added_and_removed_conditions(self):
        self.update_job(priority_groups=[[ORDINARY[0]], [ORDINARY[1], MANDATORY[0]]])
        self.update_job(include_priority=False, criteria='\n'.join([ORDINARY[0], '项目维护']))
        self.assertEqual(self.job()['priority_groups'], [[ORDINARY[0]], [MANDATORY[0]], ['项目维护']])

    def test_legacy_title_only_update_keeps_cache_and_does_not_mark_pending(self):
        self.assertEqual(self.job()['priority_groups'], [[text] for text in ALL_CONDITIONS])
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.model_answer
            first = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(first['score'], 100)
            result = self.update_job(include_priority=False, title='只改显示名称')
            self.assertEqual(result['pending_candidates'], 0)
            self.assertFalse(self.candidate()['ai_pending'])
            self.assertTrue(self.post('/api/ai/evaluate', {'id': self.cid})['cached'])
            self.assertEqual(adapter.return_value.complete.call_count, 1)
        self.assertEqual(len(self.candidate()['history']), 1)

    def test_group_reorder_and_same_group_reorder_both_increment_revision_and_pending(self):
        self.update_job(priority_groups=[[ORDINARY[0]], [ORDINARY[1], MANDATORY[0]]])
        self.seed_evaluation()
        revision = self.job()['revision']
        result = self.update_job(priority_groups=[[ORDINARY[1], MANDATORY[0]], [ORDINARY[0]]])
        self.assertEqual(result['revision'], revision + 1)
        self.assertEqual(result['pending_candidates'], 1)
        with server.connect() as db:
            server.audit(db, 'evaluate', str(self.cid))
        revision = self.job()['revision']
        before_groups = self.job()['priority_groups']
        after_groups = [list(reversed(before_groups[0])), before_groups[1]]
        rows = [{'condition': text, 'status': '满足' if index == 0 else '信息不足'}
                for index, text in enumerate(ALL_CONDITIONS)]
        before_score = calculate_score(rows, priority_groups=before_groups)['score']
        result = self.update_job(priority_groups=after_groups)
        self.assertEqual(result['revision'], revision + 1)
        self.assertEqual(result['pending_candidates'], 1)
        self.assertEqual(self.job()['priority_groups'], after_groups)
        self.assertEqual(calculate_score(rows, priority_groups=after_groups)['score'], before_score)

    def test_stale_revision_rejects_priority_change_without_partial_write(self):
        old = self.job()
        self.update_job(title='已保存的新标题')
        before = self.snapshot()
        response = self.post('/api/jobs/update', {**old, 'priority_groups': [[MANDATORY[0]], ORDINARY]}, status=409)
        self.assertEqual(response['code'], 'record_conflict')
        self.assertEqual(self.snapshot(), before)

    def test_manual_resume_is_not_overwritten_by_old_stable_card_import(self):
        old_result = self.seed_evaluation()
        source = deepcopy(self.candidate()['source'])
        manual = RESUME + '\n人工修订：补充系统交付与代码维护责任。'
        changed = self.update_candidate(resume=manual, phone='synthetic-manual-phone')
        self.assertTrue(changed['evaluation_invalidated'])
        candidate = self.candidate()
        revision = candidate['revision']
        self.assertEqual(candidate['source'], source)
        self.assertFalse(candidate['has_resume_format'])
        with server.connect() as db:
            self.assertEqual(server.profile_record(db, self.cid)['resume_edited'], 1)
        imported = self.import_resume()
        self.assertEqual(imported, {'ids': [self.cid], 'added': 0, 'duplicates': 1})
        candidate = self.candidate()
        self.assertEqual(candidate['resume'], manual)
        self.assertEqual(candidate['phone'], 'synthetic-manual-phone')
        self.assertEqual(candidate['revision'], revision)
        self.assertFalse(candidate['has_resume_format'])
        self.assertEqual(candidate['source'], source)
        self.assertEqual(candidate['history'][0]['result'], old_result)
        self.assertTrue(candidate['ai_pending'])
        with urllib.request.urlopen(self.base + source['image_url']) as response:
            self.assertEqual(response.read(), PNG)
        with urllib.request.urlopen(self.base + f'/api/candidates/{self.cid}/resume.html') as response:
            self.assertIn('人工修订'.encode(), response.read())
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidates').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_card_keys WHERE candidate_id=?', (self.cid,)).fetchone()[0], 1)

    def test_contact_only_edit_does_not_prevent_a_genuine_resume_recapture(self):
        self.update_candidate(phone='synthetic-manual-phone', note='只改联系资料')
        with server.connect() as db:
            self.assertEqual(server.profile_record(db, self.cid)['resume_edited'], 0)
        fresh = RESUME + '\n平台新增：本人负责新设备验收。'
        markup = ''.join(f'<p>{escape(line)}</p>' for line in fresh.splitlines())
        imported = self.import_resume(fresh, markup)
        self.assertEqual(imported['ids'], [self.cid])
        candidate = self.candidate()
        self.assertIn('平台新增：本人负责新设备验收。', candidate['resume'])
        self.assertTrue(candidate['has_resume_format'])
        self.assertEqual(candidate['source']['qr_url'], QR_URL)

    def test_stable_card_after_manual_rename_and_move_does_not_move_or_duplicate_record(self):
        manual = RESUME + '\n人工补充：负责维护任务。'
        self.update_candidate(name='人工修正后的合成姓名', job_id=1, resume=manual)
        imported = self.import_resume(jid=2)
        self.assertEqual(imported['ids'], [self.cid])
        candidate = self.candidate()
        self.assertEqual((candidate['job_id'], candidate['name'], candidate['resume']),
                         (1, '人工修正后的合成姓名', manual))
        for jid in (1, 2):
            result = self.post('/api/extension/collection-status', {'job_id': jid, 'cards': [CARD], 'share': True})
            self.assertEqual(result['completed'], [CARD['signature']])
            self.assertEqual(result['known'][0]['id'], self.cid)
        self.assertEqual(len(self.state()['candidates']), 1)


class PriorityMetadataMigrationTests(unittest.TestCase):
    def test_old_profile_table_gets_resume_edited_default_without_losing_revision(self):
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            db.executescript('''CREATE TABLE jobs(id INTEGER PRIMARY KEY);
                CREATE TABLE candidates(id INTEGER PRIMARY KEY);
                CREATE TABLE evaluations(id INTEGER PRIMARY KEY);
                CREATE TABLE candidate_profiles(candidate_id INTEGER PRIMARY KEY,
                    company TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',city TEXT NOT NULL DEFAULT '',
                    education TEXT NOT NULL DEFAULT '',skills TEXT NOT NULL DEFAULT '',wechat TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL DEFAULT 1);
                INSERT INTO candidate_profiles VALUES(1,'合成公司','','','','技能','',9);''')
            server.ensure_edit_tables(db)
            row = dict(db.execute('SELECT * FROM candidate_profiles WHERE candidate_id=1').fetchone())
            self.assertEqual((row['revision'], row['resume_edited'], row['skills']), (9, 0, '技能'))
            server.ensure_edit_tables(db)
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_profiles').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
