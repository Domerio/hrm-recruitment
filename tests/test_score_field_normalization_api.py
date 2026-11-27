"""Exercise score-field normalization through an isolated, synthetic HTTP API.

All state belongs to a temporary database; model/network adapters are mocked.
The production server, credentials, model service, and stored candidates are not
used by these tests.
"""

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
import ai_configuration
import server


CONDITIONS = ['Python 开发', '系统交付']
SOURCE = '本人使用 Python 开发视觉工具，并负责系统交付及维护。'
RESUME = '\n'.join(['合成人员', '工作经历', '合成研发公司', '算法工程师',
                    '2020.01 - 至今', SOURCE, '教育经历', '合成大学', '本科'])
FORGED = {'original_support_score': 'MODEL_FORGED', 'support_score': 999,
          'reason': 'MODEL_FORGED'}


class ScoreFieldNormalizationApiTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for name, value in (
            ('DB', Path(directory.name) / 'score-field-normalization.sqlite'),
            ('EXTENSION_FILE', Path(directory.name) / 'extension.json'),
            ('TOKEN', 'synthetic-score-field-test-token'),
        ):
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {
            'AI_MODEL': 'synthetic-score-field-model',
            'AI_BASE_URL': 'https://synthetic.invalid',
            'AI_API_KEY': 'synthetic-score-field-key',
        })
        environment.start()
        self.addCleanup(environment.stop)
        for target in (server, ai_configuration):
            guard = patch.object(target, 'model_urlopen',
                                 side_effect=AssertionError('Unexpected outbound model request'))
            guard.start()
            self.addCleanup(guard.stop)
        server.init_db()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: thread.join(timeout=5))
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.serial = 0
        status, _ = self.post('/api/jobs', {
            'title': '合成分数字段岗位', 'city': '', 'jd': '合成视觉软件岗位',
            'criteria': '\n'.join(CONDITIONS), 'must_have': CONDITIONS[0],
            'priority_groups': [CONDITIONS],
        })
        self.assertEqual(status, 201)

    def post(self, path, data):
        request = urllib.request.Request(self.base + path,
            data=json.dumps(data).encode(),
            headers={'X-App-Token': server.TOKEN, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def new_candidate(self):
        self.serial += 1
        status, result = self.post('/api/candidates', {
            'job_id': 1, 'name': f'合成分数候选人{self.serial}', 'resume': RESUME,
        })
        self.assertEqual(status, 201)
        return result['id']

    def answer(self, _instruction, payload):
        line = next(int(value[1:value.index(']')]) for value in payload['resume'].splitlines()
                    if value.endswith(SOURCE))
        result = {'score': 87, 'category': '推荐', 'summary': '保留合成模型摘要。',
                  'questions': ['保留已有核实问题。'], 'inferred_capabilities': []}
        for group, id_key, values in (
            ('checks', 'condition_id', payload['criteria_items']),
            ('required_checks', 'requirement_id', payload['required_conditions']),
        ):
            result[group] = [{id_key: value[id_key], 'condition': value['condition'],
                'status': '满足', 'basis': 'explicit', 'support_score': 100,
                'reasoning': '保留逐项合成解释。', 'evidence_lines': [line],
                'support_score_adjustment': deepcopy(FORGED)} for value in values]
        return result

    def response_with(self, changes, required_changes=None):
        def answer(instruction, payload):
            result = self.answer(instruction, payload)
            result['checks'][0].update(deepcopy(changes))
            result['required_checks'][0].update(deepcopy(
                changes if required_changes is None else required_changes))
            return result
        return answer

    def stored_results(self, cid):
        with server.connect() as db:
            return [json.loads(row['result']) for row in db.execute(
                'SELECT result FROM evaluations WHERE candidate_id=? ORDER BY id', (cid,))]

    def evaluate_once(self, cid, answer):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = answer
            status, result = self.post('/api/ai/evaluate', {'id': cid})
            self.assertEqual(status, 200, result)
            self.assertEqual(adapter.return_value.complete.call_count, 1)
        return result

    def assert_rejected_twice(self, changes, required_changes=None):
        cid = self.new_candidate()
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.response_with(changes, required_changes)
            status, result = self.post('/api/ai/evaluate', {'id': cid})
            self.assertEqual(status, 422, result)
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(self.stored_results(cid), [])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM evaluation_inputs').fetchone()[0], 0)
        self.assertFalse(server.AI_LOCK.locked())
        return result

    def test_fixed_status_scores_normalize_once_preserve_fields_and_persist_in_cache(self):
        for status, original, expected, reason in (
            ('满足', 0, 100, 'fixed_met'), ('满足', 30, 100, 'fixed_met'),
            ('满足', 90, 100, 'fixed_met'), ('不满足', 10, 0, 'fixed_not_met'),
            ('不满足', 50, 0, 'fixed_not_met'), ('不满足', 100, 0, 'fixed_not_met'),
        ):
            with self.subTest(status=status, original=original):
                cid = self.new_candidate()
                with patch.object(server, 'CompatibleModel') as adapter:
                    adapter.return_value.complete.side_effect = self.response_with(
                        {'status': status, 'support_score': original})
                    http_status, first = self.post('/api/ai/evaluate', {'id': cid})
                    self.assertEqual(http_status, 200, first)
                    self.assertEqual(adapter.return_value.complete.call_count, 1)
                    for group in ('checks', 'required_checks'):
                        row = first[group][0]
                        self.assertEqual(row['status'], status)
                        self.assertEqual(row['basis'], 'explicit')
                        self.assertEqual(row['evidence'], SOURCE)
                        self.assertEqual(row['evidence_quotes'], [SOURCE])
                        self.assertEqual(row['reasoning'], '保留逐项合成解释。')
                        self.assertEqual(row['support_score'], expected)
                        self.assertEqual(row['support_score_adjustment'], {
                            'original_support_score': original, 'support_score': expected,
                            'reason': reason, 'stage': 'before_education_policy',
                        })
                    self.assertEqual(first['summary'], '保留合成模型摘要。')
                    self.assertEqual(first['questions'], ['保留已有核实问题。'])
                    self.assertNotIn('support_score_adjustment', first['checks'][1])
                    self.assertEqual(first['score'], 100 if status == '满足' else 50)
                    cached_status, cached = self.post('/api/ai/evaluate', {'id': cid})
                    self.assertEqual(cached_status, 200)
                    self.assertTrue(cached['cached'])
                    self.assertEqual(adapter.return_value.complete.call_count, 1)
                    self.assertEqual({key: value for key, value in cached.items() if key != 'cached'}, first)
                self.assertEqual(self.stored_results(cid), [first])

    def test_unknown_without_partial_evidence_normalizes_legal_scores_to_zero(self):
        for basis in ('unknown', 'explicit'):
            for original in (10, 50, 100):
                with self.subTest(basis=basis, original=original):
                    cid = self.new_candidate()
                    result = self.evaluate_once(cid, self.response_with({
                        'status': '信息不足', 'basis': basis, 'evidence_lines': [],
                        'support_score': original,
                    }))
                    row = result['checks'][0]
                    self.assertEqual((row['status'], row['basis'], row['support_score']),
                                     ('信息不足', basis, 0))
                    self.assertEqual(row['evidence'], '')
                    self.assertEqual(row['evidence_quotes'], [])
                    self.assertEqual(row['support_score_adjustment'], {
                        'original_support_score': original, 'support_score': 0,
                        'reason': 'no_supporting_evidence', 'stage': 'before_education_policy',
                    })
                    self.assertEqual(result['score'], 50)

    def test_supported_inferred_unknown_keeps_ten_percent_partial_steps(self):
        for percent in (10, 30, 70, 90):
            with self.subTest(percent=percent):
                cid = self.new_candidate()
                result = self.evaluate_once(cid, self.response_with({
                    'status': '信息不足', 'basis': 'inferred', 'support_score': percent,
                    'reasoning': '已有合成项目证据支持部分任务，完整负责范围尚待核实。',
                }))
                for group in ('checks', 'required_checks'):
                    row = result[group][0]
                    self.assertEqual((row['status'], row['basis'], row['support_score']),
                                     ('信息不足', 'inferred', percent))
                    self.assertEqual(row['evidence_quotes'], [SOURCE])
                    self.assertNotIn('support_score_adjustment', row)
                self.assertEqual(result['score'], 50 + percent // 2)

    def test_supported_partial_zero_or_hundred_still_requires_model_repair(self):
        for percent in (0, 100):
            with self.subTest(percent=percent):
                result = self.assert_rejected_twice({
                    'status': '信息不足', 'basis': 'inferred', 'support_score': percent,
                    'reasoning': '合成项目只支持部分能力，完整要求仍需核实。',
                })
                self.assertEqual(result['code'], 'evaluation_format_invalid')

    def test_invalid_scores_are_not_coerced_or_rounded(self):
        for invalid in (27, True, '50', 110, -10, None):
            with self.subTest(invalid=invalid):
                result = self.assert_rejected_twice({'support_score': invalid})
                self.assertEqual(result['code'], 'evaluation_format_invalid')

    def test_score_fix_does_not_hide_invalid_schema(self):
        for changes in (
            {'support_score': 30, 'status': '通过'},
            {'support_score': 30, 'basis': 'invented'},
            {'support_score': 30, 'reasoning': 123},
        ):
            with self.subTest(changes=changes):
                result = self.assert_rejected_twice(changes)
                self.assertEqual(result['code'], 'evaluation_format_invalid')

    def test_score_fix_does_not_hide_invalid_or_missing_actual_evidence(self):
        for changes in (
            {'support_score': 30, 'evidence_lines': [99999]},
            {'support_score': 30, 'evidence_lines': [True]},
            {'support_score': 30, 'evidence_lines': []},
            {'support_score': 30, 'evidence_lines': '6'},
        ):
            with self.subTest(changes=changes):
                result = self.assert_rejected_twice(changes)
                self.assertIn(result['code'], ('evaluation_evidence_mismatch', 'evaluation_format_invalid'))

    def test_duplicate_conditions_with_same_status_normalize_different_score_fields(self):
        for status, left, right, expected in (
            ('满足', 30, 70, 100), ('不满足', 20, 80, 0),
        ):
            with self.subTest(status=status):
                cid = self.new_candidate()
                result = self.evaluate_once(cid, self.response_with(
                    {'status': status, 'support_score': left},
                    {'status': status, 'support_score': right}))
                self.assertEqual(result['checks'][0]['support_score'], expected)
                self.assertEqual(result['required_checks'][0]['support_score'], expected)
                self.assertEqual(result['checks'][0]['support_score_adjustment']['original_support_score'], left)
                self.assertEqual(result['required_checks'][0]['support_score_adjustment']['original_support_score'], right)
                self.assertEqual(result['scoring']['total'], 2)

    def test_duplicate_conditions_with_different_status_still_fail(self):
        result = self.assert_rejected_twice(
            {'status': '满足', 'support_score': 30},
            {'status': '不满足', 'support_score': 70})
        self.assertEqual(result['code'], 'evaluation_format_invalid')

    def test_duplicate_partial_conditions_with_different_supported_scores_still_fail(self):
        common = {'status': '信息不足', 'basis': 'inferred',
                  'reasoning': '真实合成项目证据只支持部分能力，完整要求仍需核实。'}
        result = self.assert_rejected_twice(
            {**common, 'support_score': 30}, {**common, 'support_score': 70})
        self.assertEqual(result['code'], 'evaluation_format_invalid')

    def test_model_cannot_forge_adjustment_metadata_on_unchanged_score(self):
        cid = self.new_candidate()
        result = self.evaluate_once(cid, self.answer)
        for group in ('checks', 'required_checks'):
            for row in result[group]:
                self.assertNotIn('support_score_adjustment', row)
        self.assertEqual(self.stored_results(cid), [result])

    def test_new_normalized_result_does_not_rewrite_previous_history(self):
        cid = self.new_candidate()
        old = self.evaluate_once(cid, self.answer)
        with server.connect() as db:
            db.execute('UPDATE candidates SET resume=resume || ? WHERE id=?',
                       ('\n新增合成资料以使缓存失效。', cid))
        new = self.evaluate_once(cid, self.response_with({'support_score': 30}))
        self.assertEqual(new['checks'][0]['support_score'], 100)
        self.assertEqual(self.stored_results(cid), [old, new])

    def test_education_exclusion_remains_final_after_score_field_adjustment(self):
        policy = '本科要求全日制，不接受本科非全日制；硕士及以上可接受非全日制'
        with server.connect() as db:
            job = server.job_record(db, 1)
        status, result = self.post('/api/jobs/update', {
            **job, 'criteria': policy, 'must_have': policy, 'priority_groups': [[policy]],
        })
        self.assertEqual(status, 200, result)
        cid = self.new_candidate()
        with server.connect() as db:
            db.execute('UPDATE candidates SET resume=resume || ? WHERE id=?',
                       ('\n本科 · 非全日制', cid))
        # The education policy may deterministically settle these originally
        # different judgments; ordinary non-education conflicts remain errors.
        answer = self.response_with({'support_score': 30}, {
            'status': '信息不足', 'basis': 'inferred', 'support_score': 70,
            'reasoning': '已知合成本科学历，但误将明确排除的学习形式当成部分支持。',
        })
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = answer
            status, result = self.post('/api/ai/evaluate', {'id': cid})
            self.assertEqual(status, 200, result)
            self.assertEqual(adapter.return_value.complete.call_count, 1)
            self.assertEqual((result['score'], result['must_have_status'], result['category']),
                             (0, 'not_met', '低匹配'))
            for group in ('checks', 'required_checks'):
                row = result[group][0]
                self.assertEqual((row['status'], row['support_score']), ('不满足', 0))
                self.assertEqual(row['education_policy_adjustment']['reason'], 'non_full_time_bachelor')
                self.assertEqual(row['evidence_quotes'], ['本科 · 非全日制'])
            self.assertEqual(result['checks'][0]['support_score_adjustment'], {
                'original_support_score': 30, 'support_score': 100,
                'reason': 'fixed_met', 'stage': 'before_education_policy',
            })
            self.assertEqual(result['checks'][0]['education_policy_adjustment']['original_support_score'], 100)
            self.assertEqual(result['required_checks'][0]['education_policy_adjustment']['original_support_score'], 70)
            status, cached = self.post('/api/ai/evaluate', {'id': cid})
            self.assertEqual(status, 200, cached)
            self.assertTrue(cached['cached'])
            self.assertEqual(cached['checks'], result['checks'])
            self.assertEqual(cached['score'], 0)
            self.assertEqual(adapter.return_value.complete.call_count, 1)
        self.assertEqual(self.stored_results(cid), [result])


if __name__ == '__main__':
    unittest.main()
