from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from platform_search import SEARCH_DEFAULTS


JOB = {'title': 'Synthetic role', 'city': 'Synthetic city',
       'jd': 'Python development and delivery.', 'criteria': 'Python development', 'must_have': ''}
CONDITIONS = {**SEARCH_DEFAULTS,
    'enabled': True, 'salary': '15-25K', 'activity': '今日活跃',
    'job_hopping': '近 5 年少于 3 份', 'job_status': '离职-随时到岗',
    'position_requirements': '算法工程师', 'major': '计算机科学与技术',
    'sort': '匹配度优先', 'exclude_viewed_14d': True, 'exclude_contacted_30d': False,
    'recommend_activity': '3日内活跃', 'recommend_gender': '女',
    'recommend_school': '211', 'recommend_education': '本科',
    'recommend_experience': '3-5年', 'recommend_job_status': '离职-随时到岗',
    'recommend_salary': '10-20K',
}
RESUME = ('Synthetic Person\n工作经历\nSynthetic Company\n开发工程师\n2020.01 - 至今\n'
          'Python development and delivery.\n教育经历\nSynthetic University 本科')


class PlatformSearchHttpTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for name, value in [('DB', Path(directory.name) / 'test.sqlite'),
                            ('EXTENSION_FILE', Path(directory.name) / 'extension.json')]:
            patcher = patch.object(server, name, value)
            patcher.start(); self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {'AI_MODEL': 'synthetic-model',
            'AI_BASE_URL': 'https://synthetic.invalid/v1', 'DEEPSEEK_API_KEY': 'synthetic-key'})
        environment.start(); self.addCleanup(environment.stop)
        server.init_db()
        quiet = patch.object(server.Handler, 'log_message', lambda *args: None)
        quiet.start(); self.addCleanup(quiet.stop)
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def stop_server(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join()

    def post(self, path, values, status=200):
        request = urllib.request.Request(self.base + path, data=json.dumps(values).encode(),
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

    def job(self, jid):
        return next(row for row in self.state()['jobs'] if row['id'] == jid)

    def create(self, **values):
        return self.post('/api/jobs', {**JOB, **values}, status=201)['id']

    def snapshot(self):
        with server.connect() as db:
            return {table: [dict(row) for row in db.execute(f'SELECT * FROM {table} ORDER BY 1')]
                for table in ('jobs', 'job_requirements', 'job_priorities', 'job_search_conditions', 'audit')}

    def test_legacy_job_reads_default_without_writing_or_changing_jobs_schema(self):
        with server.connect() as db:
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)',
                (1, JOB['title'], JOB['city'], JOB['jd'], JOB['criteria'], 'earlier'))
        before = self.snapshot()
        job = self.job(1)
        self.assertEqual(job['search_conditions'], SEARCH_DEFAULTS)
        self.assertEqual(job['revision'], 0)
        self.assertEqual(self.snapshot(), before)

    def test_create_save_and_read_all_search_fields(self):
        default_id = self.create()
        self.assertEqual(self.job(default_id)['search_conditions'], SEARCH_DEFAULTS)
        jid = self.create(search_conditions=CONDITIONS)
        job = self.job(jid)
        self.assertEqual(job['search_conditions'], CONDITIONS)
        changed = {**CONDITIONS, 'sort': '活跃优先', 'exclude_viewed_14d': None, 'enabled': False}
        result = self.post('/api/jobs/update', {**job, 'search_conditions': changed})
        self.assertTrue(result['changed'])
        self.assertEqual(result['revision'], 2)
        self.assertEqual(result['pending_candidates'], 0)
        self.assertEqual(self.job(jid)['search_conditions'], changed)
        with server.connect() as db:
            stored = db.execute('SELECT conditions_json FROM job_search_conditions WHERE job_id=?', (jid,)).fetchone()[0]
        self.assertEqual(json.loads(stored), changed)
        noop = self.post('/api/jobs/update', self.job(jid))
        self.assertFalse(noop['changed'])
        self.assertEqual(noop['revision'], 2)

    def test_old_client_omits_search_field_and_preserves_saved_preferences(self):
        jid = self.create(search_conditions=CONDITIONS)
        values = self.job(jid)
        values.pop('search_conditions')
        values['title'] = 'Updated by legacy client'
        self.post('/api/jobs/update', values)
        self.assertEqual(self.job(jid)['search_conditions'], CONDITIONS)
        self.assertEqual(self.job(jid)['title'], values['title'])

    def test_partial_object_defaults_and_explicit_empty_resets_preferences(self):
        jid = self.create(search_conditions={'enabled': True, 'salary': ' 15-25K '})
        self.assertEqual(self.job(jid)['search_conditions'],
            {**SEARCH_DEFAULTS, 'enabled': True, 'salary': '15-25K'})
        self.post('/api/jobs/update', {**self.job(jid), 'search_conditions': {}})
        self.assertEqual(self.job(jid)['search_conditions'], SEARCH_DEFAULTS)

    def test_invalid_fields_reject_create_and_update_atomically(self):
        jid = self.create(search_conditions=CONDITIONS)
        invalid = [None, [], '', {'enabled': 1}, {'enabled': None}, {'salary': 12},
            {'salary': None}, {'salary': 'x' * 81}, {'major': 'hidden\nvalue'},
            {'major': 'hidden\u200bvalue'}, {'major': 'hidden\u2028value'},
            {'activity': 'x\x00'}, {'sort': 'salary'}, {'exclude_viewed_14d': 1},
            {'exclude_contacted_30d': 'false'}, {'age': '25-30'}, {'gender': '男'}, {'unknown': ''}]
        for conditions in invalid:
            with self.subTest(conditions=conditions):
                before = self.snapshot()
                self.post('/api/jobs', {**JOB, 'search_conditions': conditions}, status=400)
                self.post('/api/jobs/update', {**self.job(jid), 'title': 'Must not persist',
                    'search_conditions': conditions}, status=400)
                self.assertEqual(self.snapshot(), before)

    def test_stale_query_update_conflicts_without_overwriting_current_fields(self):
        jid = self.create()
        stale = self.job(jid)
        self.post('/api/jobs/update', {**stale, 'search_conditions': CONDITIONS})
        before = self.snapshot()
        result = self.post('/api/jobs/update', {**stale, 'title': 'Must not persist',
            'search_conditions': {'salary': '10-15K'}}, status=409)
        self.assertEqual(result['code'], 'record_conflict')
        self.assertEqual(self.snapshot(), before)

    def test_search_only_update_preserves_cached_evaluation_and_model_input(self):
        jid = self.create(search_conditions=CONDITIONS)
        created = self.post('/api/candidates', {'job_id': jid, 'name': 'Synthetic Person',
            'resume': RESUME}, status=201)
        cid = created['id']
        payloads = []

        def answer(instruction, payload):
            payloads.append(deepcopy(payload))
            line = next(int(row[1:row.index(']')]) for row in payload['resume'].splitlines()
                if row.endswith('Python development and delivery.'))
            return {'score': 1, 'category': '待确认', 'summary': 'Synthetic response', 'questions': [],
                'checks': [{'condition_id': row['condition_id'], 'status': '满足', 'evidence_lines': [line]}
                    for row in payload['criteria_items']], 'required_checks': []}

        with patch.object(server, 'CompatibleModel') as model:
            model.return_value.complete.side_effect = answer
            first = self.post('/api/ai/evaluate', {'id': cid})
            self.assertEqual(first['score'], 100)
            with server.connect() as db:
                fingerprints = [row[0] for row in db.execute('SELECT fingerprint FROM evaluation_inputs')]
                pending = db.execute("SELECT count(*) FROM audit WHERE action='evaluate_pending'").fetchone()[0]
            result = self.post('/api/jobs/update', {**self.job(jid), 'search_conditions':
                {**CONDITIONS, 'salary': '20-30K', 'exclude_contacted_30d': True}})
            self.assertEqual(result['pending_candidates'], 0)
            candidate = next(row for row in self.state()['candidates'] if row['id'] == cid)
            self.assertFalse(candidate['ai_pending'])
            cached = self.post('/api/ai/evaluate', {'id': cid})
            self.assertTrue(cached['cached'])
            self.assertEqual(model.return_value.complete.call_count, 1)
            with server.connect() as db:
                self.assertEqual([row[0] for row in db.execute('SELECT fingerprint FROM evaluation_inputs')], fingerprints)
                self.assertEqual(db.execute("SELECT count(*) FROM audit WHERE action='evaluate_pending'").fetchone()[0], pending)
            # None of the platform-only fields can affect assessment or reach the model.
            self.assertNotIn('search_conditions', payloads[0])
            for key in SEARCH_DEFAULTS:
                self.assertNotIn(key, payloads[0])
            self.assertNotIn(CONDITIONS['salary'], json.dumps(payloads[0], ensure_ascii=False))
            changed = self.post('/api/jobs/update', {**self.job(jid), 'jd': 'Changed assessment responsibilities'})
            self.assertEqual(changed['pending_candidates'], 1)


if __name__ == '__main__':
    unittest.main()
