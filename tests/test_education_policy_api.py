"""Exercise education defaults and contradictions through isolated HTTP fixtures."""

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


POLICY = '本科及以上学历，自动化相关专业；本科要求全日制；硕士及以上可接受非全日制'
OTHER_CONDITION = 'Python 开发'
WORK_QUOTE = '本人使用 Python 开发合成设备的数据处理工具，并独立完成交付。'
ORIGINAL_QUESTION = '请核实合成项目的具体职责。'
DEFAULT_REASON = 'unspecified_bachelor_mode_default_full_time'
NON_FULL_REASON = 'non_full_time_bachelor'


class EducationPolicyApiTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for name, value in (('DB', Path(directory.name) / 'education.sqlite'),
                            ('EXTENSION_FILE', Path(directory.name) / 'extension.json')):
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {
            'AI_MODEL': 'synthetic-education-model', 'AI_BASE_URL': 'https://example.invalid/v1',
            'AI_API_KEY': 'synthetic-education-test-key', 'DEEPSEEK_API_KEY': 'synthetic-education-test-key',
        })
        environment.start()
        self.addCleanup(environment.stop)
        network = patch.object(server, 'model_urlopen', side_effect=AssertionError('Test must never contact a model'))
        self.network = network.start()
        self.addCleanup(network.stop)
        logging = patch.object(server.Handler, 'log_message', return_value=None)
        logging.start()
        self.addCleanup(logging.stop)
        server.init_db()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_http)
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        status, body = self.post('/api/jobs', {
            'title': '合成学历策略岗位', 'city': '', 'jd': '合成自动化工具开发岗位',
            'criteria': '\n'.join([POLICY, OTHER_CONDITION]), 'must_have': POLICY,
            'priority_groups': [[POLICY, OTHER_CONDITION]],
        })
        self.assertEqual(status, 201, body)
        self.cid = None
        self.returned_answers = []

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=5)

    def post(self, path, data):
        request = urllib.request.Request(self.base + path, data=json.dumps(data).encode(),
            headers={'X-App-Token': server.TOKEN, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def candidate(self):
        with urllib.request.urlopen(self.base + '/api/state', timeout=5) as response:
            candidates = json.load(response)['candidates']
        return next(row for row in candidates if row['id'] == self.cid)

    def create_candidate(self, degree='本科', major='自动化'):
        lines = ['合成学历候选人']
        self.edu_quote = f'合成大学 {major} {degree}' if degree else None
        if degree:
            lines.append(f'学历：{degree}')
        lines += ['工作经历', '合成研发公司', '软件工程师', '2020.01 - 至今', WORK_QUOTE]
        if degree:
            lines += ['教育经历', self.edu_quote, '2015 - 2019']
        self.resume = '\n'.join(lines)
        status, body = self.post('/api/candidates', {
            'job_id': 1, 'name': '合成学历候选人', 'resume': self.resume,
        })
        self.assertEqual(status, 201, body)
        self.cid = body['id']

    def model_answer(self, payload, status='满足', basis='explicit', support=100, reasoning=None):
        numbered = {}
        for line in payload['resume'].splitlines():
            prefix, separator, text = line.partition('] ')
            if separator:
                numbered[text] = int(prefix[1:])
        quote = self.edu_quote or WORK_QUOTE
        education = {
            'condition_id': 1, 'condition': POLICY, 'status': status, 'basis': basis,
            'support_score': support, 'evidence_lines': [] if basis == 'unknown' else [numbered[quote]],
        }
        if reasoning is not None or basis == 'inferred':
            education['reasoning'] = reasoning or '学历已有原文，但专业和岗位要求的完整对应仍需进一步核实。'
        mandatory = deepcopy(education)
        mandatory.pop('condition_id')
        mandatory['requirement_id'] = 1
        result = {
            'score': 100, 'category': '推荐', 'summary': '合成学历和项目条件核验。',
            'checks': [education, {
                'condition_id': 2, 'condition': OTHER_CONDITION, 'status': '满足', 'basis': 'explicit',
                'support_score': 100, 'evidence_lines': [numbered[WORK_QUOTE]],
            }],
            'required_checks': [mandatory], 'inferred_capabilities': [], 'questions': [ORIGINAL_QUESTION],
        }
        self.returned_answers.append((result, deepcopy(result)))
        return result

    def evaluate(self, **options):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = lambda _instruction, payload: self.model_answer(payload, **options)
            status, body = self.post('/api/ai/evaluate', {'id': self.cid})
            calls = adapter.return_value.complete.call_count
        self.network.assert_not_called()
        for answer, original in self.returned_answers:
            self.assertEqual(answer, original, 'Resolving an answer must preserve the original model object')
        return status, body, calls

    def counts(self):
        with server.connect() as db:
            return (db.execute('SELECT count(*) FROM evaluations').fetchone()[0],
                    db.execute('SELECT count(*) FROM evaluation_inputs').fetchone()[0])

    def assert_saved(self, result):
        self.assertEqual(self.counts(), (1, 1))
        with server.connect() as db:
            stored = json.loads(db.execute('SELECT result FROM evaluations WHERE candidate_id=?', (self.cid,)).fetchone()[0])
        self.assertEqual(stored, result)
        candidate = self.candidate()
        self.assertFalse(candidate['ai_pending'])
        self.assertEqual([entry['result'] for entry in candidate['history']], [result])
        self.assertEqual(result['checks'][1]['evidence_quotes'], [WORK_QUOTE])
        self.assertEqual((result['checks'][1]['status'], result['checks'][1]['support_score']), ('满足', 100))

    def assert_adjustment(self, result, reason, status, basis, support):
        copies = [result['checks'][0], result['required_checks'][0]]
        for row in copies:
            adjustment = row.get('education_policy_adjustment')
            self.assertIsInstance(adjustment, dict)
            self.assertEqual(adjustment['reason'], reason)
            self.assertEqual(adjustment['original_status'], status)
            self.assertEqual(adjustment['original_basis'], basis)
            self.assertEqual(adjustment['original_support_score'], support)
        self.assertEqual(copies[0]['education_policy_adjustment'], copies[1]['education_policy_adjustment'])

    def test_bachelor_without_study_mode_defaults_to_full_time_and_saves_once(self):
        self.create_candidate()
        status, result, calls = self.evaluate()
        self.assertEqual(status, 200, result)
        self.assertEqual(calls, 1)
        self.assertEqual((result['score'], result['must_have_status'], result['category']), (100, 'met', '推荐'))
        for row in (result['checks'][0], result['required_checks'][0]):
            self.assertEqual((row['status'], row['basis'], row['support_score']), ('满足', 'explicit', 100))
            self.assertEqual(row['evidence_quotes'], [self.edu_quote])
        self.assert_adjustment(result, DEFAULT_REASON, '满足', 'explicit', 100)
        self.assertIn(ORIGINAL_QUESTION, result['questions'])
        self.assert_saved(result)

    def test_explicit_non_full_time_bachelor_cannot_receive_complete_credit(self):
        self.create_candidate('本科 · 非全日制')
        status, result, calls = self.evaluate()
        self.assertEqual(status, 200, result)
        self.assertEqual(calls, 1)
        self.assertEqual((result['score'], result['must_have_status'], result['category']), (50, 'not_met', '低匹配'))
        for row in (result['checks'][0], result['required_checks'][0]):
            self.assertEqual((row['status'], row['basis'], row['support_score']), ('不满足', 'explicit', 0))
            self.assertIn(self.edu_quote, row['evidence_quotes'])
            self.assertTrue(all(quote in self.resume for quote in row['evidence_quotes']))
            self.assertEqual(row['evidence'], '\n'.join(row['evidence_quotes']))
        self.assert_adjustment(result, NON_FULL_REASON, '满足', 'explicit', 100)
        self.assert_saved(result)

    def test_explicit_non_full_time_bachelor_overrides_inferred_partial_credit(self):
        self.create_candidate('本科 · 非全日制')
        status, result, calls = self.evaluate(status='信息不足', basis='inferred', support=30)
        self.assertEqual(status, 200, result)
        self.assertEqual(calls, 1)
        self.assertEqual((result['score'], result['must_have_status']), (50, 'not_met'))
        for row in (result['checks'][0], result['required_checks'][0]):
            self.assertEqual((row['status'], row['basis'], row['support_score']), ('不满足', 'explicit', 0))
        self.assert_adjustment(result, NON_FULL_REASON, '信息不足', 'inferred', 30)
        self.assertEqual(result['scoring']['partial'], 0)
        self.assert_saved(result)

    def test_default_study_mode_does_not_upgrade_existing_partial_professional_evidence(self):
        self.create_candidate(major='机械工程')
        status, result, calls = self.evaluate(status='信息不足', basis='inferred', support=30)
        self.assertEqual(status, 200, result)
        self.assertEqual(calls, 1)
        self.assertEqual((result['score'], result['must_have_status']), (65, 'unknown'))
        for row in (result['checks'][0], result['required_checks'][0]):
            self.assertEqual((row['status'], row['basis'], row['support_score']), ('信息不足', 'inferred', 30))
            self.assertEqual(row['evidence_quotes'], [self.edu_quote])
        self.assertEqual(result['scoring']['partial'], 1)
        self.assert_saved(result)

    def test_non_full_time_master_does_not_override_an_unconfirmed_major(self):
        self.create_candidate('硕士 · 非全日制', major='机械工程')
        status, result, calls = self.evaluate(status='信息不足', basis='inferred', support=30)
        self.assertEqual(status, 200, result)
        self.assertEqual(calls, 1)
        self.assertEqual((result['score'], result['must_have_status']), (65, 'unknown'))
        for row in (result['checks'][0], result['required_checks'][0]):
            self.assertEqual((row['status'], row['basis'], row['support_score']), ('信息不足', 'inferred', 30))
        self.assert_saved(result)

    def test_explicit_full_time_bachelor_remains_fully_supported(self):
        self.create_candidate('本科 · 全日制')
        status, result, calls = self.evaluate()
        self.assertEqual(status, 200, result)
        self.assertEqual(calls, 1)
        self.assertEqual((result['score'], result['must_have_status']), (100, 'met'))
        self.assertNotIn('education_policy_adjustment', result['checks'][0])
        self.assert_saved(result)

    def test_no_degree_record_does_not_create_a_degree_or_partial_credit(self):
        self.create_candidate(degree=None)
        status, result, calls = self.evaluate(status='信息不足', basis='unknown', support=0)
        self.assertEqual(status, 200, result)
        self.assertEqual(calls, 1)
        self.assertEqual((result['score'], result['must_have_status']), (50, 'unknown'))
        for row in (result['checks'][0], result['required_checks'][0]):
            self.assertEqual((row['status'], row['basis'], row['support_score']), ('信息不足', 'unknown', 0))
            self.assertEqual(row['evidence'], '')
            self.assertEqual(row.get('evidence_quotes', []), [])
        self.assertEqual((result['scoring']['partial'], result['scoring']['no_evidence']), (0, 1))
        self.assert_saved(result)

    def test_bad_education_citation_still_requires_a_model_repair(self):
        self.create_candidate()
        calls = []

        def answer(instruction, payload):
            calls.append(instruction)
            result = self.model_answer(payload)
            if len(calls) == 1:
                result['checks'][0]['evidence_lines'] = [999]
            return result

        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = answer
            status, result = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(status, 200, result)
        self.assertEqual((result['score'], result['must_have_status']), (100, 'met'))
        self.assert_saved(result)

    def test_two_invalid_education_citations_are_not_hidden_by_the_default(self):
        self.create_candidate()

        def answer(_instruction, payload):
            result = self.model_answer(payload)
            result['checks'][0].update(evidence_lines=[999], evidence='模型自造学历证据')
            return result

        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = answer
            status, body = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(status, 422)
        self.assertEqual(body['code'], 'evaluation_evidence_mismatch')
        self.assertEqual(self.counts(), (0, 0))
        self.assertTrue(self.candidate()['ai_pending'])

    def test_invalid_schema_and_support_granularity_still_retry_then_fail_without_saving(self):
        self.create_candidate()
        mutations = {
            'invalid_support_step': lambda result: result['checks'][0].update(support_score=27),
            'invalid_basis': lambda result: result['checks'][0].update(basis='invented'),
            'invalid_status': lambda result: result['checks'][0].update(status='部分满足'),
            'missing_required_row': lambda result: result.update(required_checks=[]),
            'invalid_questions': lambda result: result.update(questions='需要核实'),
        }
        for name, mutate in mutations.items():
            with self.subTest(case=name):
                def answer(_instruction, payload):
                    result = self.model_answer(payload)
                    mutate(result)
                    return result

                with patch.object(server, 'CompatibleModel') as adapter:
                    adapter.return_value.complete.side_effect = answer
                    status, body = self.post('/api/ai/evaluate', {'id': self.cid})
                    self.assertEqual(adapter.return_value.complete.call_count, 2)
                self.assertEqual(status, 422, body)
                self.assertEqual(body['code'], 'evaluation_format_invalid')
                self.assertEqual(self.counts(), (0, 0))
                self.assertTrue(self.candidate()['ai_pending'])


if __name__ == '__main__':
    unittest.main()
