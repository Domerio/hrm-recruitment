from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock, patch

import server


RESUME = '工作经历\n负责 Python 检测程序开发。\n本人完成端侧模型部署、联调与交付。'
JOB = {'jd':'检测软件与部署开发', 'criteria':'Python 开发与项目部署经验'}
PRIVATE_VALUE = 'SYNTHETIC_PRIVATE_MODEL_VALUE'


def valid_result():
    return {
        'score':80, 'category':'推荐', 'summary':'具备可核实的软件开发经验。',
        'checks':[
            {'condition':'Python 开发', 'status':'满足', 'basis':'explicit', 'evidence_line':2},
            {'condition':'证书要求', 'status':'信息不足', 'basis':'unknown', 'evidence_line':None},
        ],
        'inferred_capabilities':[
            {'capability':'端侧部署与联调', 'reasoning':'本人完成的端侧部署任务支持该能力线索。',
             'question':'请说明本人负责的部署环节和问题处理过程。', 'evidence_line':3},
        ],
        'questions':['是否独立完成了部署验收？'],
    }


class EvaluationFormatTests(unittest.TestCase):
    def complete(self, first, second):
        model = Mock()
        model.complete.side_effect = [first, second]
        result = server.complete_evaluation(model, JOB, RESUME, None)
        return model, result

    def test_invalid_status_and_missing_condition_are_repaired_with_their_paths(self):
        for field, path in [('status','checks[0].status'), ('condition','checks[0].condition')]:
            with self.subTest(field=field):
                invalid = valid_result()
                if field == 'status':
                    invalid['checks'][0][field] = '部分满足'
                else:
                    invalid['checks'][0].pop(field)
                model, result = self.complete(invalid, valid_result())
                self.assertEqual(model.complete.call_count, 2)
                self.assertEqual(result['checks'][0]['status'], '满足')
                self.assertEqual(len(result['checks']), 2)
                self.assertIn(path, model.complete.call_args_list[1].args[0])

    def test_missing_null_and_empty_supplemental_fields_are_repaired_without_invention(self):
        for field in ('capability', 'reasoning', 'question'):
            for form in ('missing', 'null', 'blank'):
                with self.subTest(field=field, form=form):
                    invalid = valid_result()
                    if form == 'missing':
                        invalid['inferred_capabilities'][0].pop(field)
                    else:
                        invalid['inferred_capabilities'][0][field] = None if form == 'null' else '   '
                    model, result = self.complete(invalid, valid_result())
                    self.assertEqual(model.complete.call_count, 2)
                    self.assertEqual(len(result['inferred_capabilities']), 1)
                    self.assertEqual(result['inferred_capabilities'][0][field],
                        valid_result()['inferred_capabilities'][0][field])
                    self.assertIn('inferred_capabilities[0].' + field,
                        model.complete.call_args_list[1].args[0])

    def test_trimmed_strings_are_accepted_but_unknown_status_is_never_relabelled(self):
        raw = valid_result()
        raw['category'] = ' 推荐 '
        raw['checks'][0].update(condition=' Python 开发 ', status=' 满足 ', basis=' explicit ')
        raw['inferred_capabilities'][0]['capability'] = ' 端侧部署与联调 '
        model = Mock()
        model.complete.return_value = raw
        result = server.complete_evaluation(model, JOB, RESUME, None)
        self.assertEqual(model.complete.call_count, 1)
        self.assertEqual(result['category'], '推荐')
        self.assertEqual(result['checks'][0]['condition'], 'Python 开发')
        self.assertEqual(result['inferred_capabilities'][0]['capability'], '端侧部署与联调')
        unknown = valid_result()
        unknown['checks'][0]['status'] = PRIVATE_VALUE
        with self.assertRaises(server.EvaluationFormatError) as invalid:
            server.resolve_evaluation(unknown, RESUME.splitlines(), RESUME)
        self.assertEqual(invalid.exception.path, 'checks[0].status')
        self.assertNotIn(PRIVATE_VALUE, str(invalid.exception))

    def test_missing_or_null_explicit_evidence_is_an_evidence_failure_then_repairs(self):
        for nullable in (False, True):
            with self.subTest(nullable=nullable):
                invalid = valid_result()
                invalid['checks'][0].pop('evidence_line')
                if nullable:
                    invalid['checks'][0]['evidence'] = None
                with self.assertRaises(server.EvaluationEvidenceMismatch):
                    server.resolve_evaluation(deepcopy(invalid), RESUME.splitlines(), RESUME)
                model, result = self.complete(invalid, valid_result())
                self.assertEqual(model.complete.call_count, 2)
                self.assertEqual(result['checks'][0]['evidence'], RESUME.splitlines()[1])

    def test_unknown_evidence_is_empty_and_legacy_explicit_evidence_still_works(self):
        raw = valid_result()
        raw.pop('inferred_capabilities')
        raw['checks'][0].pop('basis')
        raw['checks'][0].pop('evidence_line')
        raw['checks'][0]['evidence'] = RESUME.splitlines()[1]
        raw['checks'][1]['evidence'] = PRIVATE_VALUE
        raw['checks'][1]['evidence_line'] = 2
        result = server.resolve_evaluation(raw, RESUME.splitlines(), RESUME)
        self.assertEqual(result['checks'][0]['evidence'], RESUME.splitlines()[1])
        self.assertEqual(result['checks'][0]['basis'], 'explicit')
        self.assertEqual(result['checks'][1]['evidence'], '')
        self.assertNotIn('evidence_line', result['checks'][1])

    def test_invalid_rows_are_rejected_in_place_instead_of_deleted(self):
        for field in ('checks', 'inferred_capabilities'):
            with self.subTest(field=field):
                invalid = valid_result()
                invalid[field].append(None)
                with self.assertRaises(server.EvaluationFormatError) as error:
                    server.resolve_evaluation(invalid, RESUME.splitlines(), RESUME)
                self.assertEqual(error.exception.path, f'{field}[{len(invalid[field])-1}]')
                self.assertEqual(invalid[field][-1], None)

    def test_mixed_format_and_evidence_errors_share_the_same_two_call_budget(self):
        evidence = valid_result()
        evidence['checks'][0]['evidence_line'] = 999
        malformed = valid_result()
        malformed['inferred_capabilities'][0]['question'] = None
        for sequence, expected in (
            ([evidence, malformed], server.EvaluationFormatError),
            ([malformed, evidence], server.EvaluationEvidenceMismatch),
        ):
            with self.subTest(last_error=expected.__name__):
                model = Mock()
                model.complete.side_effect = sequence
                with self.assertRaises(expected):
                    server.complete_evaluation(model, JOB, RESUME, None)
                self.assertEqual(model.complete.call_count, 2)

    def test_model_connection_and_credentials_errors_are_not_retried(self):
        for message in ('模型连接失败或超时', '服务端尚未配置 API Key', '模型服务返回 HTTP 401'):
            with self.subTest(message=message):
                model = Mock()
                model.complete.side_effect = ValueError(message)
                with self.assertRaisesRegex(ValueError, message):
                    server.complete_evaluation(model, JOB, RESUME, None)
                self.assertEqual(model.complete.call_count, 1)

    def test_adapter_invalid_json_and_truncated_output_use_the_same_repair_path(self):
        def response(content, reason='stop'):
            return io.BytesIO(json.dumps({'choices':[{'message':{'content':content},
                'finish_reason':reason}]}).encode())
        for content, reason in (('not JSON', 'stop'), (json.dumps(valid_result()), 'length')):
            with self.subTest(reason=reason):
                with patch.dict(server.os.environ, {'DEEPSEEK_API_KEY':'synthetic-key'}):
                    with patch.object(server, 'model_urlopen', side_effect=[
                        response(content, reason), response(json.dumps(valid_result())),
                    ]) as network:
                        result = server.complete_evaluation(server.CompatibleModel(), JOB, RESUME, None)
                self.assertEqual(network.call_count, 2)
                self.assertEqual(result['checks'][0]['evidence'], RESUME.splitlines()[1])

    def test_diagnostics_and_repair_instruction_contain_static_paths_not_model_text(self):
        invalid = valid_result()
        invalid['inferred_capabilities'][0].update(capability=PRIVATE_VALUE, question=None)
        model, _ = self.complete(invalid, valid_result())
        repair = model.complete.call_args_list[1].args[0]
        self.assertIn('inferred_capabilities[0].question', repair)
        self.assertNotIn(PRIVATE_VALUE, repair)
        with self.assertRaises(server.EvaluationFormatError) as error:
            server.resolve_evaluation(deepcopy(invalid), RESUME.splitlines(), RESUME)
        self.assertNotIn(PRIVATE_VALUE, str(error.exception))
        self.assertEqual(error.exception.path, 'inferred_capabilities[0].question')


class EvaluationFormatHttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = patch.object(server, 'DB', Path(self.directory.name) / 'evaluation.sqlite')
        self.database.start()
        server.init_db()
        with server.connect() as db:
            db.execute('INSERT INTO jobs VALUES(1,?,?,?,?,?)',
                ('测试岗位', '', JOB['jd'], '\n'.join(item['condition'] for item in valid_result()['checks']), 'now'))
        self.cid = server.save_boss_candidate(1, '测试候选人', RESUME, '')[0]
        self.old_result = server.resolve_evaluation(valid_result(), RESUME.splitlines(), RESUME)
        self.old_result['score'] = 61
        with server.connect() as db:
            db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                (self.cid, 'previous-model', json.dumps(self.old_result), 'earlier'))
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

    def test_first_invalid_supplemental_field_repairs_and_saves_only_the_valid_result(self):
        invalid = valid_result()
        invalid['inferred_capabilities'][0]['reasoning'] = None
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = [invalid, valid_result()]
            result = self.evaluate()
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(result['score'], 67)
        candidate = self.current()
        self.assertFalse(candidate['ai_pending'])
        self.assertEqual([item['result']['score'] for item in candidate['history']], [67, 61])

    def test_two_format_failures_return_422_and_keep_prior_history_pending(self):
        invalid = valid_result()
        invalid['checks'][0]['status'] = PRIVATE_VALUE
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = [invalid, deepcopy(invalid)]
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.evaluate()
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(error.exception.code, 422)
        body = json.load(error.exception)
        self.assertEqual(body['code'], 'evaluation_format_invalid')
        self.assertEqual(body['validation_path'], 'checks[0].status')
        self.assertNotIn(PRIVATE_VALUE, json.dumps(body))
        candidate = self.current()
        self.assertTrue(candidate['ai_pending'])
        self.assertEqual(len(candidate['history']), 1)
        self.assertEqual(candidate['history'][0]['result'], self.old_result)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0], 1)
            pending = db.execute("SELECT detail FROM audit WHERE action='evaluate_pending' ORDER BY id DESC LIMIT 1").fetchone()
            self.assertEqual(pending[0], str(self.cid))
            diagnostic = db.execute("SELECT detail FROM audit WHERE action='evaluation_format_invalid' ORDER BY id DESC LIMIT 1").fetchone()
            self.assertEqual(diagnostic[0], f'{self.cid}:checks[0].status')
            self.assertNotIn(PRIVATE_VALUE, diagnostic[0])

    def test_mixed_failure_returns_the_final_error_without_a_third_call_or_partial_save(self):
        evidence = valid_result()
        evidence['checks'][0]['evidence_line'] = 999
        malformed = valid_result()
        malformed['checks'].append(None)
        with patch.object(server, 'CompatibleModel') as adapter:
            adapter.return_value.complete.side_effect = [evidence, malformed]
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.evaluate()
            self.assertEqual(adapter.return_value.complete.call_count, 2)
        self.assertEqual(error.exception.code, 422)
        self.assertEqual(json.load(error.exception)['code'], 'evaluation_format_invalid')
        candidate = self.current()
        self.assertTrue(candidate['ai_pending'])
        self.assertEqual(len(candidate['history']), 1)
        self.assertEqual(candidate['history'][0]['result'], self.old_result)


if __name__ == '__main__':
    unittest.main()
