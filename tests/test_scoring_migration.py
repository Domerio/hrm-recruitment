"""Upgrade old validated scores locally without rewriting AI judgments."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch

import server
from record_editing import job_record, profile_record


MARKER = 'graded-evidence-scoring-v4'
OLD_VERSIONS = ('equal-weight-v1', 'priority-weight-v1')
RESUME = '测试候选人\n本科\n熟练Python开发\n工作经历\n示例科技有限公司\n算法工程师\n2020.01 - 至今\n负责工业检测项目交付。'
CONDITIONS = ['Python 开发', '交付经验']


def old_result(statuses=('满足', '信息不足'), groups=None):
    conditions = CONDITIONS[:len(statuses)]
    if len(statuses) > len(conditions):
        conditions += [f'旧条件{index}' for index in range(len(conditions), len(statuses))]
    checks = [{'condition_id': index + 1, 'condition': condition, 'status': status,
               'basis': 'unknown' if status == '信息不足' else 'explicit',
               'evidence': '' if status == '信息不足' else '熟练Python开发',
               'evidence_lines': [] if status == '信息不足' else [3]}
              for index, (condition, status) in enumerate(zip(conditions, statuses))]
    required = [{**checks[0], 'requirement_id': 1}]
    counts = {status: statuses.count(status) for status in ('满足', '信息不足', '不满足')}
    scoring = {'version': 'equal-weight-v1', 'total': len(statuses), 'met': counts['满足'],
               'unknown': counts['信息不足'], 'not_met': counts['不满足'],
               'rule': '满足得满分；信息不足得半分；不满足得0分，各条件等权'}
    total, met, unknown = len(statuses), counts['满足'], counts['信息不足']
    if groups is not None:
        weights = {condition: len(groups) - index for index, group in enumerate(groups) for condition in group}
        total = sum(weights.values())
        met = sum(weights[condition] for condition, status in zip(conditions, statuses) if status == '满足')
        unknown = sum(weights[condition] for condition, status in zip(conditions, statuses) if status == '信息不足')
        scoring.update(version='priority-weight-v1', weighted_total=total, weighted_met=met,
                       weighted_unknown=unknown, weighted_not_met=total - met - unknown,
                       rule='满足得满分；信息不足得半分；不满足得0分，优先级按组数至1递减加权，同组条件等权',
                       priority_groups=[{'priority': index + 1, 'weight': len(groups) - index,
                                         'conditions': group} for index, group in enumerate(groups)])
    score = (100 * (2 * met + unknown) + total) // (2 * total)
    category = '推荐' if score >= 75 else '待确认' if score >= 50 else '低匹配'
    mandatory = 'met' if statuses[0] == '满足' else 'unknown' if statuses[0] == '信息不足' else 'not_met'
    if mandatory == 'not_met':
        category = '低匹配'
    elif mandatory == 'unknown' and category == '推荐':
        category = '待确认'
    return {'score': score, 'category': category, 'summary': '保留模型原始摘要。',
            'questions': ['请核实交付经验。'], 'checks': checks, 'required_checks': required,
            'inferred_capabilities': [], 'must_have_status': mandatory, 'scoring': scoring}


class ScoringMigrationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for attribute, filename in [('DB', 'migration.sqlite'), ('EXTENSION_FILE', 'extension.json')]:
            patcher = patch.object(server, attribute, Path(directory.name) / filename)
            patcher.start()
            self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'fixture-no-network',
                                             'AI_BASE_URL': 'https://example.invalid/v1', 'AI_MODEL': 'fixture-model'})
        environment.start()
        self.addCleanup(environment.stop)
        network = patch.object(server, 'model_urlopen', side_effect=AssertionError('Migration must never call a model'))
        self.network = network.start()
        self.addCleanup(network.stop)
        server.init_db()
        with server.connect() as db:
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)', (1, '合成岗位', '杭州', '图像研发职责', '\n'.join(CONDITIONS), 'fixture-job'))
            db.execute('INSERT INTO job_requirements VALUES(?,?,?)', (1, CONDITIONS[0], 1))
            db.execute('INSERT INTO job_priorities VALUES(?,?)', (1, json.dumps([CONDITIONS])))
        self.cid, _ = server.save_boss_candidate(1, '测试候选人', RESUME, '')
        self.date = datetime.now(timezone(timedelta(hours=8))).date()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_http)
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def seed(self, result=None, fingerprint=True):
        result = deepcopy(result or old_result(groups=[CONDITIONS]))
        with server.connect() as db:
            candidate = dict(db.execute('SELECT * FROM candidates WHERE id=?', (self.cid,)).fetchone())
            profile = profile_record(db, self.cid)
            job = job_record(db, 1)
            result['evaluation_context'] = {'job_id': 1, 'job_revision': job['revision'],
                'candidate_revision': profile['revision'], 'evaluation_date': self.date.isoformat(), 'model_config_revision': 0}
            cur = db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                             (self.cid, 'fixture-model', json.dumps(result, ensure_ascii=False), 'fixture-evaluated'))
            eid = cur.lastrowid
            if fingerprint:
                value = fingerprint if isinstance(fingerprint, str) else server.evaluation_fingerprint(
                    job, candidate, profile, self.date, scoring_versions=OLD_VERSIONS,
                    instruction=server.LEGACY_EVALUATION_INSTRUCTION)
                db.execute('INSERT INTO evaluation_inputs VALUES(?,?)', (eid, value))
            server.audit(db, 'evaluate', str(self.cid))
        return eid, result

    def migrate(self):
        with server.connect() as db:
            db.execute('DELETE FROM configuration_migrations WHERE name=?', (MARKER,))
        server.init_db()

    def saved(self, eid):
        with server.connect() as db:
            return json.loads(db.execute('SELECT result FROM evaluations WHERE id=?', (eid,)).fetchone()[0])

    def state(self):
        with urllib.request.urlopen(self.base + '/api/state', timeout=5) as response:
            return json.load(response)

    def post(self, path, data):
        request = urllib.request.Request(self.base + path, data=json.dumps(data).encode(),
            headers={'Content-Type': 'application/json', 'X-App-Token': server.TOKEN})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.read(), response.headers['Content-Type']

    def snapshot(self, tables):
        with server.connect() as db:
            return {table: [tuple(row) for row in db.execute('SELECT * FROM ' + table + ' ORDER BY rowid')] for table in tables}

    def test_old_score_is_recomputed_locally_and_original_judgments_are_preserved(self):
        eid, before = self.seed()
        protected = self.snapshot(['jobs', 'job_requirements', 'job_priorities', 'candidates', 'candidate_profiles'])
        self.migrate()
        after = self.saved(eid)
        self.assertEqual((before['score'], after['score']), (75, 50))
        self.assertEqual(after['category'], '待确认')
        self.assertEqual(after['scoring']['version'], 'priority-weight-v4')
        adjustment = after['scoring_adjustment_v4']
        self.assertEqual(adjustment['reason'], 'graded_evidence_v4')
        self.assertEqual(adjustment['previous_score'], 75)
        self.assertEqual(adjustment['previous_category'], '推荐')
        self.assertEqual(adjustment['previous_scoring'], before['scoring'])
        self.assertTrue(adjustment['adjusted_at'])
        for field in ('summary', 'questions', 'checks', 'required_checks', 'inferred_capabilities', 'evaluation_context'):
            self.assertEqual(after[field], before[field], field)
        self.assertEqual(self.snapshot(list(protected)), protected)
        self.assertFalse(self.state()['candidates'][0]['ai_pending'])
        self.network.assert_not_called()

    def test_equal_weight_unknowns_keep_full_denominator(self):
        eid, _ = self.seed(old_result(('满足', '信息不足', '信息不足')))
        self.migrate()
        after = self.saved(eid)
        self.assertEqual(after['score'], 33)
        self.assertEqual(after['scoring']['version'], 'equal-weight-v4')
        self.assertEqual((after['scoring']['total'], after['scoring']['unknown']), (3, 2))

    def test_all_unknown_has_zero_score_and_preserves_mandatory_unknown(self):
        eid, _ = self.seed(old_result(('信息不足', '信息不足'), [CONDITIONS]))
        self.migrate()
        after = self.saved(eid)
        self.assertEqual(after['score'], 0)
        self.assertEqual(after['must_have_status'], 'unknown')
        self.assertEqual(after['category'], '低匹配')

    def test_priority_weights_come_from_assessed_snapshot_not_current_job(self):
        eid, _ = self.seed(old_result(groups=[[CONDITIONS[0]], [CONDITIONS[1]]]))
        with server.connect() as db:
            db.execute('UPDATE job_priorities SET groups_json=? WHERE job_id=1', (json.dumps([[CONDITIONS[1]], [CONDITIONS[0]]]),))
            db.execute('UPDATE job_requirements SET revision=2 WHERE job_id=1')
            server.audit(db, 'evaluate_pending', str(self.cid))
        self.migrate()
        after = self.saved(eid)
        self.assertEqual(after['score'], 67)
        self.assertEqual(after['scoring']['priority_groups'][0]['conditions'], [CONDITIONS[0]])
        self.assertTrue(self.state()['candidates'][0]['ai_pending'])
        self.assertEqual(self.snapshot(['evaluation_inputs'])['evaluation_inputs'], [])

    def test_new_prompt_invalidates_old_cache_then_reuses_the_new_analysis(self):
        eid, _ = self.seed()
        # Pure revision changes need not alter the input hash.
        with server.connect() as db:
            server.bump_profile(db, self.cid)
        self.migrate()
        with server.connect() as db:
            self.assertIsNone(db.execute('SELECT fingerprint FROM evaluation_inputs WHERE evaluation_id=?', (eid,)).fetchone())
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.return_value = {
                'score':99,'category':'推荐','summary':'重新核对完整与部分证据。','questions':[],
                'checks':[
                    {'condition_id':1,'condition':CONDITIONS[0],'status':'满足','basis':'explicit','evidence_lines':[3]},
                    {'condition_id':2,'condition':CONDITIONS[1],'status':'信息不足','basis':'unknown','evidence_lines':[]},
                ],
                'required_checks':[{'requirement_id':1,'condition':CONDITIONS[0],'status':'满足','basis':'explicit','evidence_lines':[3]}],
                'inferred_capabilities':[],
            }
            raw, _ = self.post('/api/ai/evaluate', {'id': self.cid})
            result = json.loads(raw)
            self.assertFalse(result.get('cached',False))
            self.assertEqual(result['score'], 50)
            self.assertEqual(adapter.return_value.complete.call_count,1)
            cached,_=self.post('/api/ai/evaluate',{'id':self.cid})
            self.assertTrue(json.loads(cached)['cached'])
            self.assertEqual(adapter.return_value.complete.call_count,1)
        self.assertEqual(len(self.state()['candidates'][0]['history']), 2)

    def test_stale_hash_is_removed_without_erasing_history_or_existing_pending(self):
        eid, _ = self.seed(fingerprint='old-unverifiable-input')
        with server.connect() as db:
            server.audit(db, 'evaluate_pending', str(self.cid))
        self.migrate()
        self.assertEqual(self.saved(eid)['score'], 50)
        self.assertEqual(self.snapshot(['evaluation_inputs'])['evaluation_inputs'], [])
        self.assertTrue(self.state()['candidates'][0]['ai_pending'])
        self.assertEqual(len(self.state()['candidates'][0]['history']), 1)

    def test_unsafe_old_results_are_preserved_flagged_and_not_cached(self):
        mutations = {
            'missing_required': lambda r: r.pop('required_checks'),
            'missing_weight_snapshot': lambda r: r['scoring'].pop('priority_groups'),
            'wrong_total': lambda r: r['scoring'].update(total=3),
            'wrong_weight_total': lambda r: r['scoring'].update(weighted_total=5),
            'missing_evidence': lambda r: r['checks'][0].update(evidence='', evidence_lines=[]),
            'conflicting_judgment': lambda r: r['required_checks'][0].update(status='不满足'),
        }
        for name, mutation in mutations.items():
            with self.subTest(case=name):
                result = old_result(groups=[CONDITIONS])
                mutation(result)
                eid, before = self.seed(result)
                self.migrate()
                after = self.saved(eid)
                self.assertTrue(after['scoring_obsolete'])
                self.assertEqual(after['score'], before['score'])
                self.assertEqual(after['checks'], before['checks'])
                self.assertTrue(self.state()['candidates'][0]['ai_pending'])
                with server.connect() as db:
                    self.assertIsNone(db.execute('SELECT 1 FROM evaluation_inputs WHERE evaluation_id=?', (eid,)).fetchone())

    def test_unsafe_older_history_does_not_make_latest_valid_result_pending(self):
        bad = old_result(groups=[CONDITIONS])
        bad['scoring']['total'] = 99
        older, _ = self.seed(bad)
        latest, _ = self.seed()
        self.migrate()
        self.assertTrue(self.saved(older)['scoring_obsolete'])
        self.assertEqual(self.saved(latest)['score'], 50)
        self.assertFalse(self.state()['candidates'][0]['ai_pending'])
        self.assertEqual(len(self.state()['candidates'][0]['history']), 2)

    def test_missing_ordinary_checks_cannot_hide_under_a_required_duplicate(self):
        old = old_result(('满足',), [[CONDITIONS[0]]])
        old['checks'] = []
        eid, _ = self.seed(old)
        self.migrate()
        self.assertTrue(self.saved(eid)['scoring_obsolete'])
        self.assertTrue(self.state()['candidates'][0]['ai_pending'])

    def test_migration_is_idempotent_and_does_not_append_evaluations(self):
        eid, _ = self.seed()
        self.migrate()
        before = self.snapshot(['evaluations', 'evaluation_inputs', 'audit', 'configuration_migrations'])
        server.init_db()
        self.assertEqual(self.snapshot(list(before)), before)
        self.assertEqual(len(self.state()['candidates'][0]['history']), 1)
        self.assertEqual(self.saved(eid)['scoring_adjustment_v4']['previous_score'], 75)

    def test_export_does_not_publish_obsolete_score_as_current(self):
        old = old_result(groups=[CONDITIONS])
        old['checks'][0]['evidence'] = ''
        self.seed(old)
        self.migrate()
        raw, kind = self.post('/api/export', {'ids': [self.cid]})
        import csv
        import io
        row = next(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
        self.assertIn('csv', kind)
        self.assertEqual(row['匹配分'], '')
        self.assertIn(row['AI建议'], ('', '待重评'))
        self.assertEqual(row['必备条件状态'], '')
        self.assertEqual(row['理由'], '旧评估未完整记录条件与权重，请重新评估。')

    def test_export_uses_latest_evaluation_audit_without_rewriting_history(self):
        import csv
        import io
        import zipfile

        def csv_row(content):
            return next(csv.DictReader(io.StringIO(content.decode('utf-8-sig'))))

        eid, _ = self.seed()
        self.migrate()
        latest = self.saved(eid)
        history = self.snapshot(['evaluations'])
        with server.connect() as db:
            db.execute('UPDATE job_requirements SET revision=revision+1 WHERE job_id=1')
            server.audit(db, 'evaluate_pending', str(self.cid))
            # Neither another candidate's evaluation nor an unrelated action clears this state.
            server.audit(db, 'evaluate', str(self.cid + 100))
            server.audit(db, 'export', str(self.cid))
        self.assertTrue(self.state()['candidates'][0]['ai_pending'])

        raw_csv, kind = self.post('/api/export', {'ids': [self.cid]})
        pending = csv_row(raw_csv)
        self.assertIn('csv', kind)
        self.assertEqual(pending['\u5339\u914d\u5206'], '')
        self.assertEqual(pending['\u5fc5\u5907\u6761\u4ef6\u72b6\u6001'], '')
        self.assertEqual(pending['AI\u5efa\u8bae'], '\u5f85\u91cd\u8bc4')
        self.assertIn('\u8bf7\u91cd\u65b0\u8bc4\u4f30', pending['\u7406\u7531'])

        raw_bundle, kind = self.post('/api/export', {'ids': [self.cid], 'format': 'bundle'})
        self.assertIn('zip', kind)
        with zipfile.ZipFile(io.BytesIO(raw_bundle)) as archive:
            self.assertEqual(csv_row(archive.read('candidates.csv')), pending)
        self.assertEqual(self.snapshot(['evaluations']), history)
        self.assertEqual(self.state()['candidates'][0]['history'][0]['result'], latest)

        with server.connect() as db:
            server.audit(db, 'evaluate', str(self.cid))
        self.assertFalse(self.state()['candidates'][0]['ai_pending'])
        raw_csv, _ = self.post('/api/export', {'ids': [self.cid]})
        current = csv_row(raw_csv)
        self.assertEqual(current['\u5339\u914d\u5206'], str(latest['score']))
        self.assertEqual(current['AI\u5efa\u8bae'], latest['category'])
        self.assertEqual(current['\u5fc5\u5907\u6761\u4ef6\u72b6\u6001'], '\u5168\u90e8\u6ee1\u8db3')
        self.assertEqual(self.snapshot(['evaluations']), history)
        self.network.assert_not_called()



if __name__ == '__main__':
    unittest.main()
