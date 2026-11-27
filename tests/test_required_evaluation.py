from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


LINES = [
    '工作经历', '合成研发公司', '算法工程师', '2019.01 - 至今',
    '本人使用 Python 开发视觉工具并完成系统交付及维护。',
    '教育经历', '合成大学 本科学历。',
]
RESUME = '\n'.join(LINES)
CONDITIONS = ['Python 开发', '系统交付']
MANDATORY = ['本科及以上学历']


def judgment(identifier, condition, status='满足', required=False):
    return {
        'requirement_id' if required else 'condition_id': identifier,
        'condition': condition, 'status': status,
        'basis': 'unknown' if status == '信息不足' else 'explicit',
        'evidence_lines': [] if status == '信息不足' else [7 if required else 5],
    }


def model_result(conditions=CONDITIONS, mandatory=MANDATORY):
    return {
        'score': 1, 'category': '低匹配', 'summary': '合成模型结果。', 'questions': [],
        'checks': [judgment(index + 1, text) for index, text in enumerate(conditions)],
        'required_checks': [judgment(index + 1, text, required=True) for index, text in enumerate(mandatory)],
        'inferred_capabilities': [],
    }


def resolve(raw, conditions=CONDITIONS, mandatory=MANDATORY):
    return server.resolve_evaluation(raw, LINES, RESUME,
        condition_rules=conditions, required_rules=mandatory, structured_scoring=True)


class RequiredEvaluationContractTests(unittest.TestCase):
    def test_fixed_score_and_server_labels_override_model_score_and_row_order(self):
        raw = model_result()
        raw['score'] = 98
        raw['scoring'] = {'version': 'untrusted', 'total': 99}
        raw['must_have_status'] = 'not_met'
        raw['checks'].reverse()
        raw['checks'][0]['condition'] = '模型改写的条件名称'
        before = deepcopy(raw)
        result = resolve(raw)
        self.assertEqual(result['score'], 100)
        self.assertEqual(result['category'], '推荐')
        self.assertEqual(result['scoring']['version'], 'equal-weight-v4')
        self.assertEqual(result['scoring']['total'], 3)
        self.assertEqual([row['condition'] for row in result['checks']], CONDITIONS)
        self.assertEqual([row['condition_id'] for row in result['checks']], [1, 2])
        self.assertEqual(result['must_have_status'], 'met')
        self.assertEqual(raw, before)

    def test_missing_duplicate_foreign_and_boolean_ids_are_rejected_without_dropping_rows(self):
        mutations = [
            lambda raw: raw['checks'].pop(),
            lambda raw: raw['checks'].append(deepcopy(raw['checks'][0])),
            lambda raw: raw['checks'][1].update(condition_id=1),
            lambda raw: raw['checks'][1].update(condition_id=999),
            lambda raw: raw['checks'][1].update(condition_id=True),
            lambda raw: raw.pop('required_checks'),
            lambda raw: raw.update(required_checks=[]),
            lambda raw: raw['required_checks'].append(deepcopy(raw['required_checks'][0])),
            lambda raw: raw['required_checks'][0].update(requirement_id='1'),
            lambda raw: raw['required_checks'][0].update(requirement_id=False),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                raw = model_result(); mutate(raw)
                before = deepcopy(raw)
                with self.assertRaises(server.EvaluationFormatError):
                    resolve(raw)
                self.assertEqual(raw, before)

    def test_legacy_condition_matching_is_exact_after_normalization(self):
        raw = model_result()
        for row in raw['checks']:
            row.pop('condition_id')
        raw['checks'][0]['condition'] = '  1. python   开发 '
        raw['required_checks'][0].pop('requirement_id')
        raw['required_checks'][0]['condition'] = '• 本科及以上学历'
        result = resolve(raw)
        self.assertEqual(result['must_have_status'], 'met')
        self.assertEqual(result['score'], 100)
        raw['checks'][0]['condition'] = '熟悉 Python'
        with self.assertRaises(server.EvaluationFormatError):
            resolve(raw)

    def test_unknown_mandatory_condition_cannot_be_overridden_by_model(self):
        raw = model_result()
        raw['required_checks'][0] = judgment(1, MANDATORY[0], '信息不足', required=True)
        raw.update(score=100, category='推荐', must_have_status='met')
        result = resolve(raw)
        self.assertEqual(result['score'], 67)
        self.assertEqual(result['must_have_status'], 'unknown')
        self.assertEqual(result['category'], '待确认')
        self.assertEqual(result['required_checks'][0]['evidence'], '')

    def test_failed_mandatory_condition_blocks_recommendation_even_at_threshold(self):
        conditions = CONDITIONS + ['项目维护']
        raw = model_result(conditions)
        raw['required_checks'][0] = judgment(1, MANDATORY[0], '不满足', required=True)
        raw.update(score=100, category='推荐', must_have_status='met')
        result = resolve(raw, conditions)
        self.assertEqual(result['score'], 75)
        self.assertEqual(result['must_have_status'], 'not_met')
        self.assertEqual(result['category'], '低匹配')

    def test_no_mandatory_configuration_is_not_reported_as_met(self):
        result = resolve(model_result(mandatory=[]), mandatory=[])
        self.assertEqual(result['required_checks'], [])
        self.assertEqual(result['must_have_status'], 'not_configured')
        self.assertEqual(result['score'], 100)
        self.assertEqual(result['category'], '推荐')

    def test_same_condition_in_both_lists_counts_once_but_conflicts_fail(self):
        mandatory = [CONDITIONS[0]]
        raw = model_result(mandatory=mandatory)
        result = resolve(raw, mandatory=mandatory)
        self.assertEqual(result['scoring']['total'], 2)
        raw['required_checks'][0]['status'] = '不满足'
        with self.assertRaises(server.EvaluationFormatError) as error:
            resolve(raw, mandatory=mandatory)
        self.assertEqual(error.exception.path, 'checks/required_checks')

    def test_required_check_citations_remain_strict(self):
        for invalid in [[], [True], ['7'], [999]]:
            with self.subTest(indices=invalid):
                raw = model_result()
                raw['required_checks'][0].update(evidence_lines=invalid, evidence=LINES[6])
                with self.assertRaises(server.EvaluationEvidenceMismatch):
                    resolve(raw)

    def test_score_thresholds_apply_after_fixed_scoring(self):
        cases = [(['满足', '满足', '信息不足', '信息不足'], 50, '待确认'),
                 (['满足', '不满足'], 50, '待确认'),
                 (['信息不足', '不满足', '不满足'], 0, '低匹配')]
        for statuses, score, category in cases:
            with self.subTest(statuses=statuses):
                rules = [f'条件{index}' for index in range(len(statuses))]
                raw = model_result(rules, [])
                raw['checks'] = [judgment(index + 1, rules[index], status) for index, status in enumerate(statuses)]
                result = resolve(raw, rules, [])
                self.assertEqual((result['score'], result['category']), (score, category))


class RequiredEvaluationCacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        for name, value in [('DB', Path(self.directory.name) / 'required-evaluation.sqlite'),
                            ('EXTENSION_FILE', Path(self.directory.name) / 'extension.json')]:
            patcher = patch.object(server, name, value)
            patcher.start(); self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {'AI_MODEL': 'synthetic-model', 'AI_BASE_URL': 'https://synthetic.invalid'})
        environment.start(); self.addCleanup(environment.stop)
        server.init_db()
        for title in ['合成岗位甲', '合成岗位乙']:
            status, result = self.post('/api/jobs', {'title': title, 'city': '', 'jd': '合成图像开发岗位',
                'criteria': '\n'.join(CONDITIONS), 'must_have': '\n'.join(MANDATORY)})
            self.assertEqual(status, 201)
        status, created = self.post('/api/candidates', {'job_id': 1, 'name': '合成候选人', 'resume': RESUME})
        self.assertEqual(status, 201)
        self.cid = created['id']

    def handler(self):
        responses = []
        handler = server.Handler.__new__(server.Handler)
        handler.headers = {}
        handler.send = lambda status, data, *args, **kwargs: responses.append((status, data))
        return handler, responses

    def post(self, path, data):
        handler, responses = self.handler()
        handler.handle_post(path, data)
        self.assertEqual(len(responses), 1)
        return responses[0]

    def state(self):
        handler, responses = self.handler()
        handler.permitted = lambda: True
        handler.path = '/api/state'
        handler.do_GET()
        self.assertEqual(responses[0][0], 200)
        return responses[0][1]

    def candidate(self):
        return next(row for row in self.state()['candidates'] if row['id'] == self.cid)

    def job(self, jid=1):
        return next(row for row in self.state()['jobs'] if row['id'] == jid)

    def edit_candidate(self, **updates):
        values = {**self.candidate(), **updates}
        status, result = self.post('/api/candidates/update', values)
        self.assertEqual(status, 200)
        return result

    def edit_job(self, jid=1, **updates):
        values = {**self.job(jid), **updates}
        # Legacy edit requests omit priorities so the backend can reconcile new
        # conditions with the existing layout. Explicit layouts remain strict.
        if 'priority_groups' not in updates:
            values.pop('priority_groups', None)
        status, result = self.post('/api/jobs/update', values)
        self.assertEqual(status, 200)
        return result

    def answer(self, instruction, payload):
        # Only inspect synthetic numbered source and server-generated condition IDs.
        quote_line = next(int(line[1:line.index(']')]) for line in payload['resume'].splitlines()
                          if line.endswith(LINES[4]))
        education_line = next(int(line[1:line.index(']')]) for line in payload['resume'].splitlines()
                              if line.endswith(LINES[6]))
        result = model_result([], [])
        result['checks'] = [{**judgment(row['condition_id'], row['condition']), 'evidence_lines': [quote_line]}
                            for row in payload['criteria_items']]
        result['required_checks'] = [{**judgment(row['requirement_id'], row['condition'], required=True),
                                      'evidence_lines': [education_line]}
                                     for row in payload['required_conditions']]
        return result

    def evaluate(self):
        return self.post('/api/ai/evaluate', {'id': self.cid})

    def counts(self):
        with server.connect() as db:
            return (db.execute('SELECT count(*) FROM evaluations').fetchone()[0],
                    db.execute('SELECT count(*) FROM evaluation_inputs').fetchone()[0])

    def test_job_metadata_and_same_input_cache_do_not_append_history(self):
        self.assertEqual(self.job()['must_have'], '\n'.join(MANDATORY))
        self.assertEqual(self.job()['revision'], 1)
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.answer
            status, first = self.evaluate()
            self.assertEqual(status, 200)
            self.assertEqual(first['score'], 100)
            self.assertEqual(first['must_have_status'], 'met')
            self.assertEqual(self.counts(), (1, 1))
            status, second = self.evaluate()
            self.assertEqual(status, 200)
            self.assertTrue(second['cached'])
            self.assertEqual(adapter.return_value.complete.call_count, 1)
            self.assertEqual({key: value for key, value in second.items() if key != 'cached'}, first)
        candidate = self.candidate()
        self.assertFalse(candidate['ai_pending'])
        self.assertEqual(len(candidate['history']), 1)
        self.assertNotIn('cached', candidate['history'][0]['result'])
        self.assertEqual(self.counts(), (1, 1))

    def test_contacts_notes_and_job_display_fields_do_not_invalidate_cache(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.answer
            self.assertEqual(self.evaluate()[0], 200)
            changed = self.edit_candidate(phone='synthetic-phone', email='qa@example.invalid',
                                          wechat='synthetic-wechat', note='合成联系备注')
            self.assertFalse(changed['evaluation_invalidated'])
            self.assertFalse(self.candidate()['ai_pending'])
            self.assertTrue(self.evaluate()[1]['cached'])
            self.edit_job(title='合成岗位显示名', city='合成城市')
            self.assertFalse(self.candidate()['ai_pending'])
            self.assertTrue(self.evaluate()[1]['cached'])
            self.assertEqual(adapter.return_value.complete.call_count, 1)
            self.assertEqual(self.counts(), (1, 1))

    def test_jd_criteria_and_mandatory_changes_each_require_a_new_evaluation(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.answer
            self.assertEqual(self.evaluate()[0], 200)
            changes = [('jd', '更新后的合成岗位职责'),
                       ('criteria', '\n'.join(CONDITIONS + ['项目维护'])),
                       ('must_have', '\n'.join(MANDATORY + ['项目交付经历']))]
            for index, (field, value) in enumerate(changes, 2):
                with self.subTest(field=field):
                    self.edit_job(**{field: value})
                    self.assertTrue(self.candidate()['ai_pending'])
                    status, result = self.evaluate()
                    self.assertEqual(status, 200)
                    self.assertFalse(result.get('cached', False))
                    self.assertFalse(self.candidate()['ai_pending'])
                    self.assertEqual(adapter.return_value.complete.call_count, index)
                    self.assertEqual(self.counts(), (index, index))

    def test_resume_skills_and_job_assignment_each_invalidate_cache(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.answer
            self.assertEqual(self.evaluate()[0], 200)
            changes = [('resume', RESUME + '\n本人完成合成项目验收。'), ('skills', 'Python 与图像开发'), ('job_id', 2)]
            for index, (field, value) in enumerate(changes, 2):
                with self.subTest(field=field):
                    self.assertTrue(self.edit_candidate(**{field: value})['evaluation_invalidated'])
                    self.assertTrue(self.candidate()['ai_pending'])
                    status, result = self.evaluate()
                    self.assertEqual(status, 200)
                    self.assertFalse(result.get('cached', False))
                    self.assertEqual(adapter.return_value.complete.call_count, index)
                    self.assertEqual(self.counts(), (index, index))
            sent = adapter.return_value.complete.call_args_list[-1].args[1]['resume']
            self.assertIn('人工维护·技能：Python 与图像开发', sent)
            self.assertNotIn('synthetic-wechat', sent)

    def test_model_and_base_url_change_cache_fingerprint(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.answer
            self.assertEqual(self.evaluate()[0], 200)
            with patch.dict(os.environ, {'AI_MODEL': 'synthetic-model-v2'}):
                self.assertFalse(self.evaluate()[1].get('cached', False))
                self.assertTrue(self.evaluate()[1]['cached'])
            with patch.dict(os.environ, {'AI_BASE_URL': 'https://other-synthetic.invalid'}):
                self.assertFalse(self.evaluate()[1].get('cached', False))
            self.assertEqual(adapter.return_value.complete.call_count, 3)
            self.assertEqual(self.counts(), (3, 3))

    def test_priority_edit_changes_fixed_score_and_invalidates_cached_result(self):
        def mixed_answer(instruction, payload):
            result = self.answer(instruction, payload)
            result['checks'][1]['status'] = '不满足'
            return result
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = mixed_answer
            status, first = self.evaluate()
            self.assertEqual((status, first['score']), (200, 67))
            self.assertTrue(self.evaluate()[1]['cached'])
            self.edit_job(priority_groups=[[CONDITIONS[0], MANDATORY[0]], [CONDITIONS[1]]])
            self.assertTrue(self.candidate()['ai_pending'])
            status, second = self.evaluate()
            self.assertEqual((status, second['score']), (200, 80))
            self.assertEqual(second['scoring']['version'], 'priority-weight-v4')
            self.assertEqual(second['scoring']['weighted_total'], 5)
            self.assertEqual(second['must_have_status'], 'met')
            self.assertFalse(second.get('cached', False))
            self.assertTrue(self.evaluate()[1]['cached'])
            self.assertEqual(adapter.return_value.complete.call_count, 2)
            self.assertEqual(self.counts(), (2, 2))

    def test_active_ai_input_changes_return_409_without_saving(self):
        actions = [lambda: self.edit_job(jd='运行中修改的合成职责'),
                   lambda: self.edit_candidate(skills='运行中修改的合成技能'),
                   lambda: self.edit_candidate(resume=RESUME + '\n运行中增加合成履历。'),
                   lambda: self.edit_candidate(job_id=2)]
        for index, action in enumerate(actions):
            with self.subTest(change=index):
                def answer_then_change(instruction, payload):
                    answer = self.answer(instruction, payload)
                    action()
                    return answer
                with patch.object(server, 'CompatibleModel') as adapter:
                    adapter.return_value.complete.side_effect = answer_then_change
                    status, result = self.evaluate()
                    self.assertEqual(adapter.return_value.complete.call_count, 1)
                self.assertEqual(status, 409)
                self.assertEqual(result['code'], 'evaluation_input_changed')
                self.assertEqual(self.counts(), (0, 0))
                self.assertTrue(self.candidate()['ai_pending'])
                self.assertFalse(server.AI_LOCK.locked())

    def test_contact_edit_during_model_call_does_not_discard_valid_result(self):
        def answer_then_contact(instruction, payload):
            result = self.answer(instruction, payload)
            self.edit_candidate(phone='synthetic-updated-phone', note='运行中维护联系备注')
            return result
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = answer_then_contact
            self.assertEqual(self.evaluate()[0], 200)
            self.assertTrue(self.evaluate()[1]['cached'])
            self.assertEqual(adapter.return_value.complete.call_count, 1)
        self.assertEqual(self.counts(), (1, 1))
        self.assertFalse(self.candidate()['ai_pending'])

    def test_missing_required_checks_repairs_twice_then_preserves_history(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.answer
            self.assertEqual(self.evaluate()[0], 200)
        old = self.candidate()['history'][0]['result']
        self.edit_job(must_have='项目交付能力')
        def incomplete(instruction, payload):
            result = self.answer(instruction, payload)
            result.pop('required_checks')
            return result
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = incomplete
            status, result = self.evaluate()
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(status, 422)
        self.assertEqual(result['code'], 'evaluation_format_invalid')
        self.assertEqual(result['validation_path'], 'required_checks')
        self.assertEqual(self.counts(), (1, 1))
        candidate = self.candidate()
        self.assertTrue(candidate['ai_pending'])
        self.assertEqual(candidate['history'][0]['result'], old)

    def test_invalid_required_evidence_is_not_cached_or_saved(self):
        def invalid(instruction, payload):
            result = self.answer(instruction, payload)
            result['required_checks'][0]['evidence_lines'] = [999]
            return result
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = invalid
            status, result = self.evaluate()
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(status, 422)
        self.assertEqual(result['code'], 'evaluation_evidence_mismatch')
        self.assertEqual(self.counts(), (0, 0))

    def test_clear_evaluations_removes_cache_and_next_call_is_fresh(self):
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = self.answer
            self.assertEqual(self.evaluate()[0], 200)
            self.assertTrue(self.evaluate()[1]['cached'])
            status, result = self.post('/api/evaluations/clear', {})
            self.assertEqual((status, result['deleted']), (200, 1))
            self.assertEqual(self.counts(), (0, 0))
            self.assertEqual(self.candidate()['resume'], RESUME)
            self.assertEqual(self.candidate()['history'], [])
            status, result = self.evaluate()
            self.assertEqual(status, 200)
            self.assertFalse(result.get('cached', False))
            self.assertEqual(adapter.return_value.complete.call_count, 2)


if __name__ == '__main__':
    unittest.main()
