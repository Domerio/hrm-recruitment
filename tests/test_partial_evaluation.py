"""Partial credit requires a supported project inference, never a new status."""

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
from evaluation_scoring import calculate_score


LINES = [
    '工作经历', '合成研发公司', '软件工程师', '2019.01 - 至今',
    '本人使用 Python 编写图像预处理脚本，并完成工具维护。',
    '本人封装 C++ 推理接口，完成检测模型与产线系统集成。',
    '本人仅能提供远程技术支持，无法接受长期现场驻场。',
]
RESUME = '\n'.join(LINES)
CONDITIONS = ['Python 开发', '脚本与引擎集成', 'C# 开发', '长期现场驻场']
PARTIAL_REASON = '项目证明推理接口集成，但尚未说明脚本与引擎的完整调用链，仅部分支持该条件。'


def judgment(identifier, condition, status='满足', basis='explicit', line=5, required=False):
    row = {
        'requirement_id' if required else 'condition_id': identifier,
        'condition': condition, 'status': status, 'basis': basis,
        'evidence_lines': [] if basis == 'unknown' else [line],
    }
    if basis == 'inferred':
        row['reasoning'] = PARTIAL_REASON
    return row


def model_result(conditions=None, mandatory=None):
    conditions = CONDITIONS if conditions is None else conditions
    mandatory = [conditions[1]] if mandatory is None else mandatory
    rows = [judgment(index + 1, text) for index, text in enumerate(conditions)]
    if len(rows) > 1:
        rows[1].update(status='信息不足', basis='inferred', evidence_lines=[6], reasoning=PARTIAL_REASON)
    if len(rows) > 2:
        rows[2].update(status='信息不足', basis='unknown', evidence_lines=[])
    if len(rows) > 3:
        rows[3].update(status='不满足', evidence_lines=[7])
    by_condition = {row['condition']: row for row in rows}
    required = []
    for index, text in enumerate(mandatory):
        item = deepcopy(by_condition[text])
        item.pop('condition_id')
        item['requirement_id'] = index + 1
        required.append(item)
    return {
        'score': 100, 'category': '推荐', 'summary': '合成项目证据支持部分能力，尚需核实完整要求。',
        'checks': rows, 'required_checks': required, 'inferred_capabilities': [],
        'questions': ['请说明脚本与推理引擎的完整调用链。'], 'must_have_status': 'met',
        'scoring': {'version': 'model-supplied', 'partial': 999, 'total': 1},
    }


def resolve(raw, conditions=None, mandatory=None, priorities=None):
    conditions = CONDITIONS if conditions is None else conditions
    mandatory = [conditions[1]] if mandatory is None else mandatory
    return server.resolve_evaluation(raw, LINES, RESUME, condition_rules=conditions,
        required_rules=mandatory, structured_scoring=True, priority_groups=priorities)


class PartialEvaluationContractTests(unittest.TestCase):
    def test_supported_partial_inference_earns_half_without_changing_status(self):
        raw = model_result()
        before = deepcopy(raw)
        result = resolve(raw)
        self.assertEqual(result['score'], 38)  # (100 + 50 + 0 + 0) / 4, half up.
        self.assertEqual(result['scoring']['version'], 'equal-weight-v4')
        self.assertEqual({key: result['scoring'][key] for key in
            ('total', 'met', 'unknown', 'partial', 'no_evidence', 'not_met')},
            {'total': 4, 'met': 1, 'unknown': 2, 'partial': 1, 'no_evidence': 1, 'not_met': 1})
        partial = result['checks'][1]
        self.assertEqual((partial['status'], partial['basis']), ('信息不足', 'inferred'))
        self.assertEqual(partial['reasoning'], PARTIAL_REASON)
        self.assertEqual(partial['evidence_quotes'], [LINES[5]])
        self.assertEqual(partial['evidence'], LINES[5])
        self.assertEqual({row['status'] for row in result['checks']}, {'满足', '不满足', '信息不足'})
        self.assertEqual(result['must_have_status'], 'unknown')
        self.assertEqual(result['category'], '低匹配')
        self.assertEqual(raw, before)

    def test_priority_weights_keep_partial_and_absent_evidence_in_full_denominator(self):
        priorities = [[CONDITIONS[1], CONDITIONS[2]], [CONDITIONS[0], CONDITIONS[3]]]
        result = resolve(model_result(), priorities=priorities)
        self.assertEqual(result['score'], 33)  # (2 * .5 + 1) / (2 + 2 + 1 + 1).
        self.assertEqual(result['scoring']['version'], 'priority-weight-v4')
        self.assertEqual({key: result['scoring'][key] for key in
            ('weighted_total', 'weighted_met', 'weighted_unknown', 'weighted_partial',
             'weighted_no_evidence', 'weighted_not_met')},
            {'weighted_total': 6, 'weighted_met': 1, 'weighted_unknown': 4,
             'weighted_partial': 2, 'weighted_no_evidence': 2, 'weighted_not_met': 1})

    def test_unknown_or_explicit_uncertainty_cannot_get_credit_from_model_metadata(self):
        for basis in ('unknown', 'explicit'):
            with self.subTest(basis=basis):
                raw = model_result()
                for field in ('checks', 'required_checks'):
                    row = raw[field][1 if field == 'checks' else 0]
                    row.update(basis=basis, evidence_lines=[], score=100, weight=999,
                               evidence=LINES[5], evidence_quotes=[LINES[5]], partial=True)
                result = resolve(raw)
                self.assertEqual(result['score'], 25)
                self.assertEqual(result['scoring']['partial'], 0)
                self.assertEqual(result['scoring']['no_evidence'], 2)
                self.assertEqual(result['checks'][1]['evidence'], '')

    def test_three_status_api_contract_rejects_a_partial_status(self):
        for status in ('部分满足', 'partial', '50%'):
            with self.subTest(status=status):
                raw = model_result()
                raw['checks'][1]['status'] = status
                with self.assertRaises(server.EvaluationFormatError) as error:
                    resolve(raw)
                self.assertEqual(error.exception.path, 'checks[1].status')

    def test_partial_requires_real_line_references_in_ordinary_and_required_rows(self):
        invalid_references = [[], [999], [True], ['6'], None]
        for field, index in (('checks', 1), ('required_checks', 0)):
            for indices in invalid_references:
                with self.subTest(field=field, indices=indices):
                    raw = model_result()
                    raw[field][index].update(evidence_lines=indices, evidence=LINES[5],
                                             evidence_quotes=[LINES[5]])
                    with self.assertRaises((server.EvaluationEvidenceMismatch, server.EvaluationFormatError)):
                        resolve(raw)
            with self.subTest(field=field, indices='missing'):
                raw = model_result()
                row = raw[field][index]
                row.pop('evidence_lines')
                row.update(evidence=LINES[5], evidence_quotes=[LINES[5]])
                with self.assertRaises(server.EvaluationEvidenceMismatch):
                    resolve(raw)

    def test_partial_requires_a_nonempty_inference_explanation(self):
        for field, index in (('checks', 1), ('required_checks', 0)):
            for reason in ('', '   ', None, 50, '甲' * 1001):
                with self.subTest(field=field, reason_type=type(reason).__name__, length=len(str(reason))):
                    raw = model_result()
                    raw[field][index]['reasoning'] = reason
                    with self.assertRaises(server.EvaluationFormatError) as error:
                        resolve(raw)
                    self.assertEqual(error.exception.path, f'{field}[{index}].reasoning')
            with self.subTest(field=field, reason='missing'):
                raw = model_result()
                raw[field][index].pop('reasoning')
                with self.assertRaises(server.EvaluationFormatError):
                    resolve(raw)

    def test_fabricated_quote_cannot_replace_an_invalid_partial_reference(self):
        raw = model_result()
        raw['checks'][1].update(evidence_lines=[len(LINES) + 1],
                               evidence='模型自造的完整脚本引擎调用项目',
                               evidence_quotes=['模型自造的完整脚本引擎调用项目'])
        with self.assertRaises(server.EvaluationEvidenceMismatch):
            resolve(raw)

    def test_same_condition_in_both_lists_counts_once_and_credit_conflicts_fail(self):
        result = resolve(model_result())
        self.assertEqual(result['scoring']['total'], len(CONDITIONS))
        self.assertEqual(result['scoring']['partial'], 1)
        for field, index in (('checks', 1), ('required_checks', 0)):
            with self.subTest(conflicting_field=field):
                raw = model_result()
                raw[field][index].update(basis='unknown', evidence_lines=[])
                with self.assertRaises(server.EvaluationFormatError) as error:
                    resolve(raw)
                self.assertEqual(error.exception.path, 'checks/required_checks')

    def test_partial_rows_do_not_excuse_missing_or_duplicate_configured_conditions(self):
        mutations = [
            lambda raw: raw['checks'].pop(1),
            lambda raw: raw['checks'].append(deepcopy(raw['checks'][1])),
            lambda raw: raw['checks'][2].update(condition_id=2),
            lambda raw: raw['checks'][1].update(condition_id=999),
            lambda raw: raw.update(required_checks=[]),
            lambda raw: raw.pop('required_checks'),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                raw = model_result()
                mutate(raw)
                with self.assertRaises(server.EvaluationFormatError):
                    resolve(raw)

    def test_partial_mandatory_condition_blocks_recommendation_even_with_ninety_points(self):
        conditions = ['Python 开发', '模型部署', '系统交付', '问题排查', CONDITIONS[1]]
        raw = model_result(conditions, [])
        raw['checks'] = [judgment(index + 1, condition) for index, condition in enumerate(conditions)]
        partial = judgment(5, conditions[-1], '信息不足', 'inferred', 6)
        raw['checks'][-1] = partial
        mandatory = deepcopy(partial)
        mandatory.pop('condition_id')
        mandatory['requirement_id'] = 1
        raw['required_checks'] = [mandatory]
        result = resolve(raw, conditions, [conditions[-1]])
        self.assertEqual(result['score'], 90)
        self.assertEqual(result['must_have_status'], 'unknown')
        self.assertEqual(result['category'], '待确认')

    def test_partial_only_is_fifty_and_does_not_become_a_fully_met_condition(self):
        partial = judgment(1, CONDITIONS[1], '信息不足', 'inferred', 6)
        raw = model_result([CONDITIONS[1]], [])
        raw['checks'] = [partial]
        result = resolve(raw, [CONDITIONS[1]], [])
        self.assertEqual(result['score'], 50)
        self.assertEqual((result['scoring']['met'], result['scoring']['unknown'], result['scoring']['partial']),
                         (0, 1, 1))


class PartialScoringMetadataTests(unittest.TestCase):
    def test_raw_model_metadata_and_line_numbers_alone_do_not_create_partial_credit(self):
        metadata = [
            {'basis': 'unknown', 'reasoning': PARTIAL_REASON, 'evidence': LINES[5]},
            {'basis': 'inferred', 'evidence': LINES[5]},
            {'basis': 'inferred', 'reasoning': ' ', 'evidence': LINES[5]},
            {'basis': 'inferred', 'reasoning': PARTIAL_REASON, 'evidence_lines': [6]},
            {'basis': 'inferred', 'reasoning': PARTIAL_REASON, 'evidence_quotes': [' ']},
            {'basis': 'inferred', 'reasoning': PARTIAL_REASON, 'evidence': 1},
            {'basis': 'inferred', 'reasoning': 1, 'evidence': LINES[5]},
        ]
        for index, details in enumerate(metadata):
            with self.subTest(case=index):
                row = {'condition': CONDITIONS[1], 'status': '信息不足', 'score': 100, 'weight': 999, **details}
                result = calculate_score([row])
                self.assertEqual(result['score'], 0)
                self.assertEqual((result['scoring']['partial'], result['scoring']['no_evidence']), (0, 1))

    def test_an_added_absent_condition_keeps_its_denominator_weight(self):
        partial = {'condition': CONDITIONS[1], 'status': '信息不足', 'basis': 'inferred',
                   'reasoning': PARTIAL_REASON, 'evidence': LINES[5]}
        absent = {'condition': CONDITIONS[2], 'status': '信息不足', 'basis': 'unknown'}
        self.assertEqual(calculate_score([partial])['score'], 50)
        result = calculate_score([partial, absent], priority_groups=[[CONDITIONS[1], CONDITIONS[2]]])
        self.assertEqual(result['score'], 25)
        self.assertEqual(result['scoring']['weighted_total'], 2)
        self.assertEqual(result['scoring']['weighted_unknown'], 2)


class PartialEvaluationHttpTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for name, value in (('DB', Path(directory.name) / 'partial.sqlite'),
                            ('EXTENSION_FILE', Path(directory.name) / 'extension.json')):
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {
            'AI_MODEL': 'synthetic-partial-model', 'AI_BASE_URL': 'https://synthetic.invalid',
            'AI_API_KEY': 'synthetic-partial-test-key',
        })
        environment.start()
        self.addCleanup(environment.stop)
        server.init_db()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_http)
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        self.priorities = [[CONDITIONS[1], CONDITIONS[2]], [CONDITIONS[0], CONDITIONS[3]]]
        status, _ = self.post('/api/jobs', {
            'title': '合成岗位', 'city': '', 'jd': '合成视觉软件与推理集成岗位',
            'criteria': '\n'.join(CONDITIONS), 'must_have': CONDITIONS[1],
            'priority_groups': self.priorities,
        })
        self.assertEqual(status, 201)
        status, candidate = self.post('/api/candidates', {
            'job_id': 1, 'name': '合成候选人', 'resume': RESUME,
        })
        self.assertEqual(status, 201)
        self.cid = candidate['id']

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=5)

    def post(self, path, data):
        request = urllib.request.Request(self.base + path,
            data=json.dumps(data).encode(),
            headers={'X-App-Token': server.TOKEN, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def state(self):
        with urllib.request.urlopen(self.base + '/api/state', timeout=10) as response:
            return json.load(response)

    def answer(self, _instruction, payload):
        result = model_result()
        numbered = payload['resume'].splitlines()
        remapped = {index: next(int(line[1:line.index(']')]) for line in numbered if line.endswith(text))
                    for index, text in enumerate(LINES, 1) if index in (5, 6, 7)}
        for field, id_key, source in (('checks', 'condition_id', payload['criteria_items']),
                                      ('required_checks', 'requirement_id', payload['required_conditions'])):
            labels = {item[id_key]: item['condition'] for item in source}
            for row in result[field]:
                row['condition'] = labels[row[id_key]]
                row['evidence_lines'] = [remapped[index] for index in row['evidence_lines']]
        return result

    def counts(self):
        with server.connect() as db:
            return (db.execute('SELECT count(*) FROM evaluations').fetchone()[0],
                    db.execute('SELECT count(*) FROM evaluation_inputs').fetchone()[0])

    def configure_experience_fixture(self):
        conditions = [*CONDITIONS]
        conditions[0] = '4年以上视觉开发经验'
        self.priorities = [[conditions[1], conditions[2]], [conditions[0], conditions[3]]]
        self.experience_quote = '其中相关视觉开发任职合计44个月，其余时间为一般软件维护。'
        with server.connect() as db:
            db.execute('UPDATE jobs SET criteria=? WHERE id=1', ('\n'.join(conditions),))
            db.execute('UPDATE job_priorities SET groups_json=? WHERE job_id=1',
                       (json.dumps(self.priorities, ensure_ascii=False),))
            db.execute('UPDATE candidates SET resume=resume || ? WHERE id=?',
                       ('\n' + self.experience_quote, self.cid))

    def experience_answer(self, instruction, payload, status='不满足'):
        result = self.answer(instruction, payload)
        source_line = next(int(line[1:line.index(']')]) for line in payload['resume'].splitlines()
                           if line.endswith(self.experience_quote))
        result['checks'][0].update(status=status, basis='explicit', evidence_lines=[source_line],
            reasoning='两段相关任职分别34个月和10个月，合计44个月。' +
                      ('错误认定满足4年以上要求。' if status == '满足' else '少于4年即48个月，不满足最低年限。'))
        return result

    def test_http_persists_validated_half_credit_and_reuses_only_matching_input_cache(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.answer
            status, first = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(status, 200)
            self.assertEqual(first['score'], 33)
            self.assertEqual(first['scoring']['version'], 'priority-weight-v4')
            self.assertEqual(first['scoring']['partial'], 1)
            self.assertEqual(first['must_have_status'], 'unknown')
            self.assertEqual(first['category'], '低匹配')
            status, cached = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(status, 200)
            self.assertTrue(cached['cached'])
            self.assertEqual(adapter.return_value.complete.call_count, 1)
            self.assertEqual(self.counts(), (1, 1))
            self.assertEqual({key: value for key, value in cached.items() if key != 'cached'}, first)
            with server.connect() as db:
                db.execute('UPDATE candidates SET resume=resume || ? WHERE id=?', ('\n补充合成项目记录。', self.cid))
            status, fresh = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(status, 200)
            self.assertFalse(fresh.get('cached', False))
            self.assertEqual(adapter.return_value.complete.call_count, 2)
            self.assertEqual(self.counts(), (2, 2))
        candidate = self.state()['candidates'][0]
        self.assertFalse(candidate['ai_pending'])
        self.assertEqual(len(candidate['history']), 2)
        for item in candidate['history']:
            self.assertEqual(item['result']['score'], 33)
            self.assertNotIn('cached', item['result'])
            self.assertEqual(item['result']['checks'][1]['evidence_quotes'], [LINES[5]])

    def test_one_evidence_repair_saves_only_the_complete_valid_partial_result(self):
        calls = []

        def answer(instruction, payload):
            calls.append(instruction)
            result = self.answer(instruction, payload)
            if len(calls) == 1:
                result['checks'][1]['evidence_lines'] = [999]
            return result

        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = answer
            status, result = self.post('/api/ai/evaluate', {'id': self.cid})
        self.assertEqual(status, 200)
        self.assertEqual(len(calls), 2)
        self.assertEqual(result['score'], 33)
        self.assertEqual(self.counts(), (1, 1))

    def test_two_invalid_partial_citations_cannot_save_or_cache_a_result(self):
        def invalid(instruction, payload):
            result = self.answer(instruction, payload)
            result['checks'][1].update(evidence_lines=[999], evidence=LINES[5], evidence_quotes=[LINES[5]])
            return result

        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = invalid
            status, body = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(status, 422)
        self.assertEqual(body['code'], 'evaluation_evidence_mismatch')
        self.assertEqual(self.counts(), (0, 0))
        self.assertTrue(self.state()['candidates'][0]['ai_pending'])

    def test_failed_partial_explanation_preserves_history_and_marks_evaluation_pending(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.answer
            status, first = self.post('/api/ai/evaluate', {'id': self.cid})
        self.assertEqual(status, 200)
        with server.connect() as db:
            db.execute('UPDATE candidates SET resume=resume || ? WHERE id=?', ('\n新增待核实资料。', self.cid))

        def invalid(instruction, payload):
            result = self.answer(instruction, payload)
            result['checks'][1]['reasoning'] = ' '
            return result

        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = invalid
            status, body = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(status, 422)
        self.assertEqual(body['code'], 'evaluation_format_invalid')
        self.assertEqual(body['validation_path'], 'checks[1].reasoning')
        self.assertEqual(self.counts(), (1, 1))
        candidate = self.state()['candidates'][0]
        self.assertTrue(candidate['ai_pending'])
        self.assertEqual([item['result'] for item in candidate['history']], [first])

    def test_contradictory_experience_claim_requires_model_repair_before_awarding_zero(self):
        self.configure_experience_fixture()
        instructions = []

        def answer(instruction, payload):
            instructions.append(instruction)
            return self.experience_answer(instruction, payload,
                                          '满足' if len(instructions) == 1 else '不满足')

        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = answer
            status, result = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(status, 200)
        self.assertEqual(instructions[0], server.EVALUATION_INSTRUCTION)
        self.assertIn('checks[0].reasoning', instructions[1])
        self.assertIn('44个月', instructions[1])
        self.assertIn('48个月', instructions[1])
        self.assertEqual(result['checks'][0]['status'], '不满足')
        self.assertEqual(result['checks'][0]['evidence_quotes'], [self.experience_quote])
        experience_score = next(row for row in result['scoring']['condition_scores']
                                if row['condition'] == '4年以上视觉开发经验')
        self.assertEqual(experience_score['ratio'], 0)
        self.assertEqual(experience_score['points'], 0)
        self.assertEqual(result['score'], 17)  # Only the other supported partial condition earns points.
        self.assertEqual(self.counts(), (1, 1))
        self.assertEqual(len(self.state()['candidates'][0]['history']), 1)

    def test_contradictory_current_v3_cache_is_reanalyzed_without_erasing_old_history(self):
        self.configure_experience_fixture()
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.experience_answer
            status, correct = self.post('/api/ai/evaluate', {'id': self.cid})
        self.assertEqual(status, 200)
        broken_cache = deepcopy(correct)
        broken_cache['checks'][0].update(status='满足', reasoning='两段34个月和10个月，合计44个月，满足4年以上要求。')
        broken_cache.update(calculate_score(broken_cache['checks'], broken_cache['required_checks'],
                                           priority_groups=self.priorities))
        with server.connect() as db:
            old_id = db.execute('SELECT id FROM evaluations').fetchone()[0]
            db.execute('UPDATE evaluations SET result=? WHERE id=?',
                       (json.dumps(broken_cache, ensure_ascii=False), old_id))

        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.experience_answer
            status, fresh = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(status, 200)
            self.assertFalse(fresh.get('cached', False))
            self.assertEqual(adapter.return_value.complete.call_count, 1)
            self.assertEqual(fresh['checks'][0]['status'], '不满足')
            self.assertEqual(fresh['score'], 17)
            status, cached = self.post('/api/ai/evaluate', {'id': self.cid})
            self.assertEqual(status, 200)
            self.assertTrue(cached['cached'])
            self.assertEqual(adapter.return_value.complete.call_count, 1)
        self.assertEqual(self.counts(), (2, 1))
        with server.connect() as db:
            self.assertEqual(json.loads(db.execute('SELECT result FROM evaluations WHERE id=?',
                                                   (old_id,)).fetchone()[0]), broken_cache)
            self.assertIsNone(db.execute('SELECT 1 FROM evaluation_inputs WHERE evaluation_id=?',
                                         (old_id,)).fetchone())
            self.assertIsNotNone(db.execute("SELECT 1 FROM audit WHERE action='evaluation_format_invalid' AND detail=?",
                                           (f'{self.cid}:checks[0].reasoning',)).fetchone())
            self.assertIsNotNone(db.execute("SELECT 1 FROM audit WHERE action='evaluate_pending' AND detail=?",
                                           (str(self.cid),)).fetchone())
        candidate = self.state()['candidates'][0]
        self.assertFalse(candidate['ai_pending'])
        self.assertEqual([item['result'] for item in candidate['history']], [fresh, broken_cache])


class PartialEvidenceMigrationTests(unittest.TestCase):
    MARKER = 'graded-evidence-scoring-v4'

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for name, value in (('DB', Path(directory.name) / 'migration.sqlite'),
                            ('EXTENSION_FILE', Path(directory.name) / 'extension.json')):
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {
            'AI_MODEL': 'synthetic-migration-model', 'AI_BASE_URL': 'https://synthetic.invalid',
            'AI_API_KEY': 'synthetic-migration-test-key',
        })
        environment.start()
        self.addCleanup(environment.stop)
        for attribute in ('CompatibleModel', 'model_urlopen'):
            patcher = patch.object(server, attribute, side_effect=AssertionError('Migration must stay local'))
            mock = patcher.start()
            self.addCleanup(patcher.stop)
            setattr(self, attribute, mock)
        server.init_db()
        with server.connect() as db:
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)',
                (1, '合成迁移岗位', '', '合成岗位职责', '\n'.join(CONDITIONS), 'fixture-job-created'))
            db.execute('INSERT INTO job_requirements VALUES(?,?,?)', (1, CONDITIONS[1], 1))
        self.cid, _ = server.save_boss_candidate(1, '合成迁移候选人', RESUME, '')

    def v2_result(self, priorities=None):
        result = resolve(model_result(), priorities=priorities)
        scoring = result['scoring']
        total = scoring.get('weighted_total', scoring['total'])
        met = scoring.get('weighted_met', scoring['met'])
        result['score'] = (200 * met + total) // (2 * total)
        result['category'] = '低匹配'
        scoring['version'] = 'priority-weight-v2' if priorities else 'equal-weight-v2'
        scoring['rule'] = '满足得满分；信息不足得0分；不满足得0分，全部条件计入分母'
        for key in ('partial', 'no_evidence', 'weighted_partial', 'weighted_no_evidence', 'condition_scores'):
            scoring.pop(key, None)
        result['scoring_adjustment'] = {
            'reason': 'unknown_zero_v2', 'previous_score': 50, 'previous_category': '待确认',
            'previous_scoring': {'version': 'equal-weight-v1'}, 'adjusted_at': 'fixture-v2-adjusted',
        }
        return result

    def seed(self, result=None, fingerprint='fixture-v2-cache'):
        result = deepcopy(self.v2_result() if result is None else result)
        with server.connect() as db:
            row = db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                (self.cid, 'synthetic-old-model', json.dumps(result, ensure_ascii=False), 'fixture-evaluated'))
            eid = row.lastrowid
            db.execute('INSERT INTO evaluation_inputs VALUES(?,?)', (eid, fingerprint))
            server.audit(db, 'evaluate', str(self.cid))
        return eid, result

    def migrate(self):
        with server.connect() as db:
            db.execute('DELETE FROM configuration_migrations WHERE name=?', (self.MARKER,))
        server.init_db()

    def saved(self, eid):
        with server.connect() as db:
            row = dict(db.execute('SELECT * FROM evaluations WHERE id=?', (eid,)).fetchone())
        row['result'] = json.loads(row['result'])
        return row

    def snapshot(self):
        tables = ('evaluations', 'evaluation_inputs', 'configuration_migrations', 'audit', 'candidate_profiles')
        with server.connect() as db:
            return {table: [tuple(row) for row in db.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
                    for table in tables}

    def assert_no_model_calls(self):
        self.CompatibleModel.assert_not_called()
        self.model_urlopen.assert_not_called()

    def test_v2_saved_project_evidence_earns_half_without_rewriting_original_judgments(self):
        priorities = [[CONDITIONS[1], CONDITIONS[2]], [CONDITIONS[0], CONDITIONS[3]]]
        for groups, score, version in ((None, 38, 'equal-weight-v4'),
                                        (priorities, 33, 'priority-weight-v4')):
            with self.subTest(version=version):
                eid, before = self.seed(self.v2_result(groups))
                self.migrate()
                saved = self.saved(eid)
                after = saved['result']
                self.assertEqual(after['score'], score)
                self.assertEqual(after['scoring']['version'], version)
                self.assertEqual((after['scoring']['partial'], after['scoring']['no_evidence']), (1, 1))
                self.assertEqual(after['must_have_status'], 'unknown')
                self.assertEqual(after['checks'][2]['evidence'], '')
                self.assertEqual(after['checks'][2]['evidence_quotes'], [])
                for field in ('checks', 'required_checks', 'summary', 'questions',
                              'inferred_capabilities', 'scoring_adjustment'):
                    self.assertEqual(after[field], before[field], field)
                adjustment = after['scoring_adjustment_v4']
                self.assertEqual(adjustment['reason'], 'graded_evidence_v4')
                self.assertEqual(adjustment['previous_score'], before['score'])
                self.assertEqual(adjustment['previous_category'], before['category'])
                self.assertEqual(adjustment['previous_scoring'], before['scoring'])
                self.assertTrue(adjustment['adjusted_at'])
                self.assertEqual(saved['created'], 'fixture-evaluated')
                self.assertEqual(saved['model'], 'synthetic-old-model')
        self.assert_no_model_calls()

    def test_v2_migration_deletes_old_cached_inputs_without_requesting_new_model_answers(self):
        first, _ = self.seed(fingerprint='fixture-old-input-hash')
        second, _ = self.seed(fingerprint='fixture-unrelated-stale-hash')
        self.migrate()
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM evaluation_inputs').fetchone()[0], 0)
            self.assertEqual([row[0] for row in db.execute('SELECT id FROM evaluations ORDER BY id')], [first, second])
            self.assertEqual(db.execute('SELECT count(*) FROM configuration_migrations WHERE name=?',
                                       (self.MARKER,)).fetchone()[0], 1)
        self.assert_no_model_calls()

    def test_second_init_is_idempotent_and_keeps_existing_pending_and_previous_adjustment(self):
        eid, before = self.seed()
        with server.connect() as db:
            server.audit(db, 'evaluate_pending', str(self.cid))
        self.migrate()
        once = self.snapshot()
        adjustment = self.saved(eid)['result']['scoring_adjustment_v4']
        self.assertEqual(adjustment['previous_score'], before['score'])
        server.init_db()
        self.assertEqual(self.snapshot(), once)
        self.assertEqual(self.saved(eid)['result']['scoring_adjustment_v4'], adjustment)
        with server.connect() as db:
            latest = db.execute("SELECT action FROM audit WHERE detail=? AND action IN ('evaluate','evaluate_pending') "
                                'ORDER BY id DESC LIMIT 1', (str(self.cid),)).fetchone()[0]
        self.assertEqual(latest, 'evaluate_pending')
        self.assert_no_model_calls()

    def test_inconsistent_partial_credit_in_required_copy_is_obsolete_pending_and_uncached(self):
        conflicting = self.v2_result()
        conflicting['required_checks'][0].update(basis='unknown', evidence='', evidence_quotes=[])
        eid, before = self.seed(conflicting)
        self.migrate()
        after = self.saved(eid)['result']
        self.assertTrue(after['scoring_obsolete'])
        self.assertNotIn('scoring_adjustment_v4', after)
        for field in ('score', 'category', 'scoring', 'checks', 'required_checks', 'summary', 'scoring_adjustment'):
            self.assertEqual(after[field], before[field], field)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM evaluation_inputs').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0], 1)
            latest = db.execute("SELECT action FROM audit WHERE detail=? AND action IN ('evaluate','evaluate_pending') "
                                'ORDER BY id DESC LIMIT 1', (str(self.cid),)).fetchone()[0]
        self.assertEqual(latest, 'evaluate_pending')
        self.assert_no_model_calls()


if __name__ == '__main__':
    unittest.main()
