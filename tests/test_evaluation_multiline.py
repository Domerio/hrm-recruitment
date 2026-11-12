from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock, patch

import server


LINES = [
    '工作经历',
    '示例视觉公司',
    '图像开发工程师',
    '2019.07 - 2022.08',
    '负责医学影像处理算法开发与检测方案交付。',
    '示例设备公司',
    '机器视觉工程师',
    '2022.09 - 2025.03',
    '负责多相机视觉项目开发与部署联调。',
    '项目经验',
    '检测项目：本人完成端侧模型部署。',
    '本人负责运行问题定位、版本验收与交付。',
    '教育经历',
    '示例大学 计算机 本科 2015 - 2019',
]
RESUME = '\n'.join(LINES)
JOB = {'jd':'图像处理与视觉项目开发', 'criteria':'4年以上图像处理相关开发经验'}
SENTINEL = 'SYNTHETIC_UNTRUSTED_MODEL_QUOTE'


def valid_result():
    return {
        'score':84, 'category':'推荐', 'summary':'相关任职日期与职责可供核实。',
        'checks':[
            {'condition':'4年以上图像处理相关开发经验', 'status':'满足',
             'basis':'inferred', 'evidence_lines':[4, 5, 8, 9],
             'reasoning':'两段相关开发任职的日期与实际职责共同支持年限判断，按不重叠区间核实。'},
            {'condition':'指定证书', 'status':'信息不足', 'basis':'unknown', 'evidence_lines':[]},
        ],
        'inferred_capabilities':[
            {'capability':'端侧部署与交付协作',
             'reasoning':'部署任务和交付职责共同支持该能力线索。',
             'question':'请说明本人负责的部署和交付环节。', 'evidence_lines':[11, 12]},
        ],
        'questions':['请核实各段工作实际从事相关开发的范围。'],
    }


def resolve(raw):
    return server.resolve_evaluation(raw, LINES, RESUME)


def first_row(raw, field):
    return raw[field][0]


class EvaluationMultilineTests(unittest.TestCase):
    def test_nonadjacent_dates_and_duties_become_exact_individual_quotes(self):
        raw = valid_result()
        original = deepcopy(raw)
        result = resolve(raw)
        expected = [LINES[index - 1] for index in [4, 5, 8, 9]]
        row = result['checks'][0]
        self.assertEqual(row['evidence_quotes'], expected)
        self.assertEqual(row['evidence'], '\n'.join(expected))
        self.assertNotIn(row['evidence'], RESUME)
        self.assertNotIn('evidence_line', row)
        self.assertNotIn('evidence_lines', row)
        self.assertEqual(raw, original)
        self.assertIs(server.validate_evaluation(result, RESUME), result)

    def test_project_capabilities_use_the_same_exact_multiline_sources(self):
        raw = valid_result()
        raw['inferred_capabilities'][0]['evidence_lines'] = [9, 11, 12]
        result = resolve(raw)
        row = result['inferred_capabilities'][0]
        self.assertEqual(row['evidence_quotes'], [LINES[8], LINES[10], LINES[11]])
        self.assertEqual(row['evidence'], '\n'.join(row['evidence_quotes']))
        self.assertNotIn(row['evidence'], RESUME)

    def test_duplicates_are_removed_in_first_occurrence_order(self):
        for field in ('checks', 'inferred_capabilities'):
            with self.subTest(field=field):
                raw = valid_result()
                first_row(raw, field)['evidence_lines'] = [9, 4, 9, 5, 4]
                result = resolve(raw)
                self.assertEqual(first_row(result, field)['evidence_quotes'],
                    [LINES[8], LINES[3], LINES[4]])

    def test_model_quotes_and_evidence_are_replaced_instead_of_trusted(self):
        raw = valid_result()
        for field in ('checks', 'inferred_capabilities'):
            first_row(raw, field).update(evidence=SENTINEL, evidence_quotes=[SENTINEL])
        result = resolve(raw)
        self.assertNotIn(SENTINEL, json.dumps(result, ensure_ascii=False))
        self.assertEqual(result['checks'][0]['evidence_quotes'],
            [LINES[3], LINES[4], LINES[7], LINES[8]])
        self.assertEqual(result['inferred_capabilities'][0]['evidence_quotes'], LINES[10:12])

    def test_invalid_reference_containers_reject(self):
        for field in ('checks', 'inferred_capabilities'):
            for invalid in (None, 4, '4,5', {}, (4, 5)):
                with self.subTest(field=field, value=repr(invalid)):
                    raw = valid_result()
                    first_row(raw, field)['evidence_lines'] = invalid
                    with self.assertRaises(server.EvaluationFormatError) as error:
                        resolve(raw)
                    self.assertEqual(error.exception.path, f'{field}[0].evidence_lines')
                    self.assertNotIn(SENTINEL, str(error.exception))

    def test_invalid_members_are_not_silently_filtered(self):
        for field in ('checks', 'inferred_capabilities'):
            for invalid in (True, False, '5', 5.0, None, 0, -1, len(LINES) + 1):
                with self.subTest(field=field, value=repr(invalid)):
                    raw = valid_result()
                    first_row(raw, field)['evidence_lines'] = [4, invalid, 5]
                    original = deepcopy(raw)
                    with self.assertRaises(server.EvaluationEvidenceMismatch):
                        resolve(raw)
                    self.assertEqual(raw, original)

    def test_empty_references_cannot_support_a_judgment_or_project_capability(self):
        for field in ('checks', 'inferred_capabilities'):
            with self.subTest(field=field):
                raw = valid_result()
                first_row(raw, field)['evidence_lines'] = []
                with self.assertRaises(server.EvaluationEvidenceMismatch):
                    resolve(raw)

    def test_unknown_empty_array_is_allowed_but_invalid_references_are_rejected(self):
        raw = valid_result()
        raw['checks'][1].update(evidence=SENTINEL, evidence_quotes=[SENTINEL], evidence_line=None)
        result = resolve(raw)
        self.assertEqual(result['checks'][1]['evidence'], '')
        self.assertEqual(result['checks'][1]['evidence_quotes'], [])
        for invalid in ([True], ['4'], [999], None):
            with self.subTest(value=repr(invalid)):
                raw = valid_result()
                raw['checks'][1]['evidence_lines'] = invalid
                expected = server.EvaluationFormatError if invalid is None else server.EvaluationEvidenceMismatch
                with self.assertRaises(expected):
                    resolve(raw)

    def test_legacy_singleton_and_new_singleton_can_agree(self):
        for field in ('checks', 'inferred_capabilities'):
            with self.subTest(field=field):
                raw = valid_result()
                first_row(raw, field).update(evidence_line=5, evidence_lines=[5])
                row = first_row(resolve(raw), field)
                self.assertEqual(row['evidence_quotes'], [LINES[4]])
                self.assertEqual(row['evidence'], LINES[4])

    def test_legacy_and_multiline_conflicts_are_rejected_even_with_valid_array(self):
        for field in ('checks', 'inferred_capabilities'):
            for single, multi in ((None, [4]), (4, [4, 5]), (5, [4]), (True, [1]), ('4', [4])):
                with self.subTest(field=field, single=single, multi=multi):
                    raw = valid_result()
                    first_row(raw, field).update(evidence_line=single, evidence_lines=multi)
                    with self.assertRaises(server.EvaluationEvidenceMismatch):
                        resolve(raw)

    def test_each_quote_and_the_join_are_validated_without_contiguous_substring_requirement(self):
        for field in ('checks', 'inferred_capabilities'):
            for defect in ('fabricated_quote', 'wrong_join', 'empty_quote', 'nonstring_quote'):
                with self.subTest(field=field, defect=defect):
                    result = resolve(valid_result())
                    row = first_row(result, field)
                    if defect == 'wrong_join':
                        row['evidence'] = '\n'.join(reversed(row['evidence_quotes']))
                    else:
                        row['evidence_quotes'][0] = {
                            'fabricated_quote':SENTINEL, 'empty_quote':'', 'nonstring_quote':None,
                        }[defect]
                        row['evidence'] = '\n'.join(str(value) for value in row['evidence_quotes'])
                    with self.assertRaises(server.EvaluationEvidenceMismatch):
                        server.validate_evaluation(result, RESUME)

    def test_legacy_single_line_and_original_quote_remain_supported(self):
        raw = valid_result()
        raw['checks'][0] = {'condition':'图像开发', 'status':'满足',
            'basis':'explicit', 'evidence_line':5}
        raw['checks'][1] = {'condition':'指定证书', 'status':'信息不足',
            'basis':'unknown', 'evidence_line':999, 'evidence':SENTINEL}
        raw['inferred_capabilities'][0].pop('evidence_lines')
        raw['inferred_capabilities'][0]['evidence_line'] = 11
        result = resolve(raw)
        self.assertEqual(result['checks'][0]['evidence'], LINES[4])
        self.assertEqual(result['checks'][1]['evidence'], '')
        self.assertNotIn('evidence_line', result['checks'][1])
        self.assertEqual(result['inferred_capabilities'][0]['evidence'], LINES[10])
        raw['checks'][0].pop('evidence_line')
        raw['checks'][0]['evidence'] = LINES[4]
        self.assertEqual(resolve(raw)['checks'][0]['evidence'], LINES[4])

    def test_multiline_failure_repairs_once_and_payload_includes_date_and_timeline(self):
        invalid = valid_result()
        invalid['checks'][0]['evidence_lines'] = [4, True, 5]
        model = Mock()
        model.complete.side_effect = [invalid, valid_result()]
        result = server.complete_evaluation(model, JOB, RESUME, None)
        self.assertEqual(model.complete.call_count, 2)
        self.assertEqual(result['checks'][0]['evidence_quotes'],
            [LINES[3], LINES[4], LINES[7], LINES[8]])
        first_payload = model.complete.call_args_list[0].args[1]
        second_payload = model.complete.call_args_list[1].args[1]
        self.assertEqual(first_payload, second_payload)
        self.assertRegex(first_payload['evaluation_date'], r'^\d{4}-\d{2}-\d{2}$')
        self.assertIn('work_timeline', first_payload)
        self.assertIn('[4] ' + LINES[3], first_payload['resume'])
        self.assertIn('evidence_lines', model.complete.call_args_list[1].args[0])

    def test_invalid_row_is_not_dropped_to_make_valid_multiline_result_pass(self):
        for field in ('checks', 'inferred_capabilities'):
            with self.subTest(field=field):
                raw = valid_result()
                raw[field].append(None)
                with self.assertRaises(server.EvaluationFormatError) as error:
                    resolve(raw)
                self.assertEqual(error.exception.path, f'{field}[{len(raw[field]) - 1}]')
                self.assertIsNone(raw[field][-1])


class EvaluationMultilineHttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = patch.object(server, 'DB', Path(self.directory.name) / 'evaluation.sqlite')
        self.database.start()
        server.init_db()
        with server.connect() as db:
            db.execute('INSERT INTO jobs VALUES(1,?,?,?,?,?)',
                ('合成测试岗位', '', JOB['jd'], '\n'.join(item['condition'] for item in valid_result()['checks']), 'now'))
        self.cid = server.save_boss_candidate(1, '合成候选人', RESUME, '')[0]
        # Store an authentic old schema, without introducing quotes through the new resolver.
        self.old_result = {
            'score':60, 'category':'待确认', 'summary':'旧单行评估。',
            'checks':[{'condition':'图像开发', 'status':'满足', 'evidence':LINES[4]}],
            'questions':[],
        }
        with server.connect() as db:
            db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                (self.cid, 'legacy-model', json.dumps(self.old_result), 'earlier'))
            server.audit(db, 'evaluate', str(self.cid))
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.database.stop()
        self.directory.cleanup()

    def evaluate(self):
        request = urllib.request.Request(self.base + '/api/ai/evaluate',
            data=json.dumps({'id':self.cid}).encode(),
            headers={'X-App-Token':server.TOKEN, 'Content-Type':'application/json'})
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def current(self):
        with urllib.request.urlopen(self.base + '/api/state') as response:
            return json.load(response)['candidates'][0]

    def test_multiline_result_persists_and_legacy_history_is_not_rewritten(self):
        invalid = valid_result()
        invalid['inferred_capabilities'][0]['evidence_lines'] = [11, '12']
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = [invalid, valid_result()]
            result = self.evaluate()
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(result['checks'][0]['evidence_quotes'],
            [LINES[3], LINES[4], LINES[7], LINES[8]])
        candidate = self.current()
        self.assertFalse(candidate['ai_pending'])
        self.assertEqual(candidate['history'][0]['result'], result)
        self.assertEqual(candidate['history'][1]['result'], self.old_result)
        self.assertNotIn('evidence_quotes', candidate['history'][1]['result']['checks'][0])

    def test_two_invalid_multiline_results_save_nothing_and_keep_history_pending(self):
        invalid = valid_result()
        invalid['checks'][0]['evidence_lines'] = [4, len(LINES) + 1]
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = [invalid, deepcopy(invalid)]
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.evaluate()
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(error.exception.code, 422)
        self.assertEqual(json.load(error.exception)['code'], 'evaluation_evidence_mismatch')
        candidate = self.current()
        self.assertTrue(candidate['ai_pending'])
        self.assertEqual(len(candidate['history']), 1)
        self.assertEqual(candidate['history'][0]['result'], self.old_result)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0], 1)
            detail = db.execute("SELECT detail FROM audit WHERE action='evaluate_pending' ORDER BY id DESC LIMIT 1").fetchone()[0]
            self.assertEqual(detail, str(self.cid))


if __name__ == '__main__':
    unittest.main()
