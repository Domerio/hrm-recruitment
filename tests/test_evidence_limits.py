"""Long employment evidence remains complete, bounded, and tied to original lines."""
from copy import deepcopy
from datetime import date
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock, patch

import server


LINES = ['工作经历']
for index in range(18):
    LINES.extend([
        f'合成视觉设备公司{index + 1}',
        f'第{index + 1}段任职：视觉软件工程师',
        f'{2000 + index}.01 - {2000 + index}.12',
        f'本人完成第{index + 1}段任职的图像算法开发、联调及验收交付。',
    ])
RESUME = '\n'.join(LINES)
CONDITIONS = ['4年以上视觉开发经验', '指定专业证书']
PRIVATE_VALUE = 'SYNTHETIC_PRIVATE_MODEL_PAYLOAD_NOT_FOR_DIAGNOSTICS'
LEGACY_INSTRUCTION_DIGEST = '1cedb6186f338d613e121e68493314da01d68748f5a090f2fe93471ad1f94ee5'


def answer(indices):
    return {
        'score': 99, 'category': '推荐', 'summary': '合成任职证据可核验。', 'questions': [],
        'checks': [
            {'condition_id': 1, 'condition': CONDITIONS[0], 'status': '满足', 'basis': 'inferred',
             'reasoning': '多段任职日期和本人职责共同用于核实相关工作年限。',
             'evidence_lines': list(indices)},
            {'condition_id': 2, 'condition': CONDITIONS[1], 'status': '信息不足',
             'basis': 'unknown', 'evidence_lines': []},
        ],
        'required_checks': [
            {'requirement_id': 1, 'condition': CONDITIONS[0], 'status': '满足', 'basis': 'inferred',
             'reasoning': '与普通条件引用同一组任职日期及职责。', 'evidence_lines': list(indices)},
        ],
        'inferred_capabilities': [
            {'capability': '视觉开发与项目交付', 'reasoning': '根据本人完成开发及验收的任务推断。',
             'question': '请核实各段任职中本人承担的开发和交付范围。', 'evidence_lines': list(indices)},
        ],
    }


def resolve(raw):
    return server.resolve_evaluation(raw, LINES, RESUME, condition_rules=CONDITIONS,
                                    required_rules=CONDITIONS[:1], structured_scoring=True,
                                    priority_groups=[[CONDITIONS[0]], [CONDITIONS[1]]])


class EvidenceLimitTests(unittest.TestCase):
    def test_thirteen_eighteen_and_forty_eight_real_references_keep_every_quote(self):
        for count in (13, 18, 48):
            with self.subTest(count=count):
                raw = answer(range(1, count + 1))
                original = deepcopy(raw)
                result = resolve(raw)
                for field in ('checks', 'required_checks', 'inferred_capabilities'):
                    self.assertEqual(result[field][0]['evidence_quotes'], LINES[:count])
                    self.assertEqual(result[field][0]['evidence'], '\n'.join(LINES[:count]))
                    self.assertNotIn('evidence_lines', result[field][0])
                self.assertEqual(raw, original)
                self.assertEqual(result['score'], 67)
                self.assertEqual(result['scoring']['weighted_unknown'], 1)

    def test_duplicate_references_are_validated_then_deduplicated_in_original_order(self):
        indices = [18, 3, 18, 1] + list(range(1, 49)) * 3
        expected_indices = list(dict.fromkeys(indices))
        result = resolve(answer(indices))
        for field in ('checks', 'required_checks', 'inferred_capabilities'):
            self.assertEqual(result[field][0]['evidence_quotes'], [LINES[index - 1] for index in expected_indices])
            self.assertEqual(len(result[field][0]['evidence_quotes']), 48)

    def test_forty_nine_unique_references_are_rejected_without_truncation(self):
        for field in ('checks', 'required_checks', 'inferred_capabilities'):
            with self.subTest(field=field):
                raw = answer(range(1, 19))
                raw[field][0]['evidence_lines'] = list(range(1, 50))
                original = deepcopy(raw)
                with self.assertRaises(server.EvaluationFormatError) as raised:
                    resolve(raw)
                self.assertEqual(raised.exception.path, f'{field}[0].evidence_lines')
                self.assertIn('48', str(raised.exception))
                self.assertEqual(raw, original)

    def test_invalid_reference_members_are_not_coerced_or_filtered(self):
        for field in ('checks', 'required_checks', 'inferred_capabilities'):
            for invalid in (True, False, '18', 18.0, None, 0, -1, len(LINES) + 1):
                with self.subTest(field=field, invalid=repr(invalid)):
                    raw = answer(range(1, 49))
                    raw[field][0]['evidence_lines'] = [1, invalid] + list(range(2, 49))
                    with self.assertRaises(server.EvaluationEvidenceMismatch):
                        resolve(raw)

    def test_nonarray_references_still_require_repair(self):
        for value in (None, '1,2,3', {}, 18, (1, 2)):
            with self.subTest(value=repr(value)):
                raw = answer(range(1, 19))
                raw['checks'][0]['evidence_lines'] = value
                with self.assertRaises(server.EvaluationFormatError) as raised:
                    resolve(raw)
                self.assertEqual(raised.exception.path, 'checks[0].evidence_lines')

    def test_unknown_conditions_remain_zero_even_with_many_provided_references(self):
        raw = answer(range(1, 49))
        for field in ('checks', 'required_checks'):
            raw[field][0].update(status='信息不足', basis='unknown')
        result = resolve(raw)
        self.assertEqual(result['score'], 0)
        self.assertEqual(result['scoring']['weighted_total'], 3)
        self.assertEqual(result['scoring']['weighted_unknown'], 3)
        for field in ('checks', 'required_checks'):
            self.assertEqual(result[field][0]['evidence_quotes'], [])
            self.assertEqual(result[field][0]['evidence'], '')

    def test_extended_resolved_quotes_remain_subject_to_exact_original_evidence_validation(self):
        for field in ('checks', 'required_checks', 'inferred_capabilities'):
            with self.subTest(field=field):
                result = resolve(answer(range(1, 49)))
                result[field][0]['evidence_quotes'][-1] = PRIVATE_VALUE
                result[field][0]['evidence'] = '\n'.join(result[field][0]['evidence_quotes'])
                with self.assertRaises(server.EvaluationEvidenceMismatch):
                    server.validate_evaluation(result, RESUME)

    def test_reference_limit_preserves_cache_identity_but_legacy_prompt_is_distinct(self):
        self.assertEqual(hashlib.sha256(server.LEGACY_EVALUATION_INSTRUCTION.encode()).hexdigest(),
                         LEGACY_INSTRUCTION_DIGEST)
        self.assertNotEqual(server.EVALUATION_INSTRUCTION, server.LEGACY_EVALUATION_INSTRUCTION)
        config = {'model': 'synthetic-model', 'base_url': 'https://synthetic.invalid/v1',
                  'provider': 'openai-compatible', 'api_key': 'synthetic-test-key'}
        job = {'jd': '视觉开发', 'criteria': '\n'.join(CONDITIONS), 'must_have': CONDITIONS[0],
               'priority_groups': [[CONDITIONS[0]], [CONDITIONS[1]]]}
        candidate = {'job_id': 1, 'resume': RESUME}
        with patch.object(server, 'load_config', return_value=config):
            with patch.object(server, 'MAX_EVIDENCE_LINES', 12):
                before = server.evaluation_fingerprint(job, candidate, {}, date(2026, 11, 11))
            with patch.object(server, 'MAX_EVIDENCE_LINES', 48):
                after = server.evaluation_fingerprint(job, candidate, {}, date(2026, 11, 11))
        self.assertEqual(before, after)

    def test_forty_eight_citations_are_accepted_without_a_model_repair_call(self):
        model = Mock()
        model.complete.return_value = answer(range(1, 49))
        result = server.complete_evaluation(model, {'jd': '视觉开发', 'criteria': '\n'.join(CONDITIONS),
            'must_have': CONDITIONS[0], 'structured_scoring': True,
            'priority_groups': [[CONDITIONS[0]], [CONDITIONS[1]]]}, RESUME, None)
        self.assertEqual(model.complete.call_count, 1)
        self.assertEqual(len(result['checks'][0]['evidence_quotes']), 48)


class EvidenceDiagnosticHttpTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patcher = patch.object(server, 'DB', Path(directory.name) / 'evidence.sqlite')
        patcher.start()
        self.addCleanup(patcher.stop)
        server.init_db()
        with server.connect() as db:
            db.execute('INSERT INTO jobs VALUES(1,?,?,?,?,?)', ('合成岗位', '', '视觉开发', '\n'.join(CONDITIONS), 'fixture'))
            db.execute('INSERT INTO job_requirements VALUES(?,?,?)', (1, CONDITIONS[0], 1))
        self.cid = server.save_boss_candidate(1, '合成测试人', RESUME, '')[0]
        self.old = resolve(answer(range(1, 19)))
        with server.connect() as db:
            db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                       (self.cid, 'historical-synthetic-model', json.dumps(self.old), 'fixture'))
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_http)
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def test_failed_repair_exposes_only_static_location_and_reason_and_preserves_history(self):
        raw = answer(range(1, 19))
        raw['checks'][1]['evidence_lines'] = {'private_model_json': PRIVATE_VALUE}
        raw['summary'] = PRIVATE_VALUE
        req = urllib.request.Request(self.base + '/api/ai/evaluate', data=json.dumps({'id': self.cid}).encode(),
            headers={'Content-Type': 'application/json', 'X-App-Token': server.TOKEN})
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = [deepcopy(raw), deepcopy(raw)]
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(adapter.return_value.complete.call_count, 2)
            repair = adapter.return_value.complete.call_args_list[1].args[0]
        self.assertEqual(raised.exception.code, 422)
        body = json.load(raised.exception)
        self.assertEqual(body['code'], 'evaluation_format_invalid')
        self.assertEqual(body['validation_path'], 'checks[1].evidence_lines')
        self.assertIsInstance(body['validation_reason'], str)
        self.assertIn('整数数组', body['validation_reason'])
        self.assertRegex(body['error'], r'第\s*2\s*[项条]岗位条件')
        self.assertNotIn(PRIVATE_VALUE, json.dumps(body, ensure_ascii=False))
        self.assertNotIn('private_model_json', json.dumps(body, ensure_ascii=False))
        self.assertNotIn(PRIVATE_VALUE, repair)
        self.assertIn('48', repair)
        with server.connect() as db:
            rows = db.execute('SELECT result FROM evaluations WHERE candidate_id=?', (self.cid,)).fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(json.loads(rows[0]['result']), self.old)
            latest = db.execute("SELECT action FROM audit WHERE detail=? AND action IN ('evaluate','evaluate_pending') ORDER BY id DESC LIMIT 1", (str(self.cid),)).fetchone()
            self.assertEqual(latest['action'], 'evaluate_pending')


if __name__ == '__main__':
    unittest.main()
