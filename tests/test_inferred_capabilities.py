import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


LINES = ['工作经历', '本人完成检测模型端侧部署，并与现场产线系统集成。', '编写英文技术文档，并参加每周英文项目会议。']
RESUME = '\n'.join(LINES)


def result():
    return {'score': 76, 'category': '待确认', 'summary': '项目支持模型部署经验，需进一步核实能力范围。',
            'checks': [{'condition': '模型部署经验', 'status': '满足', 'basis': 'inferred',
                        'evidence_line': 2, 'reasoning': '本人完成端侧部署和产线集成，支持部署应用经验。'}],
            'inferred_capabilities': [{'capability': '模型部署与系统集成', 'evidence_line': 2,
                                       'reasoning': '根据本人完成的部署和集成任务推断相关工程经验。',
                                       'question': '请说明本人负责的部署环节及遇到的问题。'}],
            'questions': ['项目中负责了哪些部署环节？']}


class InferredCapabilityTests(unittest.TestCase):
    def test_project_inference_has_a_separate_explanation_and_exact_server_selected_quote(self):
        data = result()
        data['checks'][0]['evidence'] = '模型自造的证据'
        data['inferred_capabilities'][0]['evidence'] = '另一段自造证据'
        resolved = server.resolve_evaluation(data, LINES, RESUME)
        self.assertEqual(resolved['checks'][0]['evidence'], LINES[1])
        self.assertEqual(resolved['checks'][0]['basis'], 'inferred')
        self.assertEqual(resolved['checks'][0]['status'], '满足')
        self.assertEqual(resolved['inferred_capabilities'][0]['evidence'], LINES[1])
        self.assertNotIn('evidence_line', resolved['inferred_capabilities'][0])

    def test_inferred_but_uncertain_language_retains_project_evidence_without_asserting_a_level(self):
        data = result()
        data['checks'] = [{'condition': '英语口语流利', 'status': '信息不足', 'basis': 'inferred',
                           'evidence_line': 3, 'reasoning': '有英文工作使用场景，但未说明口语水平或语言等级。'}]
        resolved = server.resolve_evaluation(data, LINES, RESUME)
        self.assertEqual(resolved['checks'][0]['status'], '信息不足')
        self.assertEqual(resolved['checks'][0]['evidence'], LINES[2])

    def test_inference_cannot_supply_a_quote_without_a_real_integer_line(self):
        for field in ['checks', 'inferred_capabilities']:
            for line in [None, True, '2', 0, 99]:
                with self.subTest(field=field, line=line):
                    data = result()
                    data[field][0]['evidence_line'] = line
                    data[field][0]['evidence'] = LINES[1]
                    with self.assertRaises(server.EvaluationEvidenceMismatch):
                        server.resolve_evaluation(data, LINES, RESUME)
            data = result()
            data[field][0].pop('evidence_line')
            data[field][0]['evidence'] = LINES[1]
            with self.assertRaises(server.EvaluationEvidenceMismatch):
                server.resolve_evaluation(data, LINES, RESUME)

    def test_missing_explanation_or_verification_question_is_rejected(self):
        for field, key in [('checks', 'reasoning'), ('inferred_capabilities', 'reasoning'),
                           ('inferred_capabilities', 'question'), ('inferred_capabilities', 'capability')]:
            with self.subTest(field=field, key=key):
                data = result(); data[field][0][key] = ''
                with self.assertRaises(ValueError):
                    server.resolve_evaluation(data, LINES, RESUME)

    def test_old_model_outputs_still_work_and_unknown_checks_do_not_keep_invented_quotes(self):
        data = result(); data.pop('inferred_capabilities')
        data['checks'] = [{'condition': '部署经验', 'status': '满足', 'evidence_line': 2},
                          {'condition': '其他技能', 'status': '信息不足', 'evidence_line': 3, 'evidence': '模型自造'}]
        resolved = server.resolve_evaluation(data, LINES, RESUME)
        self.assertEqual(resolved['checks'][0]['basis'], 'explicit')
        self.assertEqual(resolved['checks'][1]['basis'], 'unknown')
        self.assertEqual(resolved['checks'][1]['evidence'], '')

    def test_invalid_inference_evidence_gets_one_repair_attempt(self):
        class Model:
            def __init__(self): self.requests = []
            def complete(self, instruction, payload):
                self.requests.append((instruction, payload))
                data = result()
                if len(self.requests) == 1: data['inferred_capabilities'][0]['evidence_line'] = 99
                return data
        model = Model()
        resolved = server.complete_evaluation(model, {'jd': '模型部署', 'criteria': '部署经验'}, RESUME, None)
        self.assertEqual(len(model.requests), 2)
        self.assertEqual(resolved['inferred_capabilities'][0]['evidence'], LINES[1])

    def test_two_failed_inference_citations_do_not_produce_a_saved_result(self):
        class Model:
            def __init__(self): self.count = 0
            def complete(self, _instruction, _payload):
                self.count += 1
                data = result(); data['checks'][0]['evidence_line'] = False
                return data
        model = Model()
        with self.assertRaises(server.EvaluationEvidenceMismatch):
            server.complete_evaluation(model, {'jd': '模型部署', 'criteria': '部署经验'}, RESUME, None)
        self.assertEqual(model.count, 2)

    def test_unknown_basis_cannot_claim_a_requirement_is_met(self):
        data = result(); data['checks'][0]['basis'] = 'unknown'
        with self.assertRaises(ValueError):
            server.resolve_evaluation(data, LINES, RESUME)


if __name__ == '__main__':
    unittest.main()
