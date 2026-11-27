"""Full model payload logs use temporary databases and synthetic network responses."""
import http.client
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import evaluation_trace
import model_transport
import server


SECRET = 'synthetic-payload-log-auth-secret'
NESTED_SECRET = 'synthetic-nested-response-api-key'
RESUME = '工作经历\n合成软件公司 工程师 2020.01 - 至今\n本人负责 Python 设备接口开发、联调与交付。'


def answer(summary='合成评估正文'):
    return {'score': 0, 'category': '低匹配', 'summary': summary, 'questions': [],
            'checks': [{'condition_id': 1, 'condition': '熟悉 Python', 'status': '满足',
                        'basis': 'explicit', 'support_score': 100, 'evidence_lines': [3]}],
            'required_checks': [], 'inferred_capabilities': []}


def raw_response(content=None, reasoning='完整模型推理正文', **extra):
    return json.dumps({'choices': [{'finish_reason': 'stop', 'message': {
        'content': json.dumps(answer(), ensure_ascii=False) if content is None else content,
        'reasoning_content': reasoning}}], 'usage': {'prompt_tokens': 250, 'completion_tokens': 80},
        **extra}, ensure_ascii=False, indent=2).encode('utf-8')


def response(raw=None):
    stream = io.BytesIO(raw_response() if raw is None else raw)
    stream.status = 200
    return stream


class ModelPayloadLoggingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.folder = Path(directory.name)
        active = patch.object(server, 'DB', self.folder / 'payload-test.sqlite3')
        active.start()
        self.addCleanup(active.stop)
        active = patch.dict(os.environ, {'AI_MODEL': 'synthetic-payload-model',
            'AI_BASE_URL': 'https://payload-test.invalid/v1', 'DEEPSEEK_API_KEY': SECRET})
        active.start()
        self.addCleanup(active.stop)
        active = patch.object(server, 'model_urlopen', side_effect=AssertionError('No real model calls'))
        self.network = active.start()
        self.addCleanup(active.stop)
        model_transport._reset_cooldowns_for_tests()
        self.addCleanup(model_transport._reset_cooldowns_for_tests)
        server.init_db()
        with server.connect() as db:
            db.execute("INSERT INTO jobs VALUES(1,'合成岗位','','设备程序开发','熟悉 Python','now')")
            cursor = db.execute('INSERT INTO candidates(job_id,name,resume,phone,email,link,created) '
                                'VALUES(?,?,?,?,?,?,?)', (1, '合成候选人', RESUME, '', '', '', 'now'))
            self.cid = cursor.lastrowid

    def evaluate(self):
        return server.execute_ai_request('/api/ai/evaluate', {'id': self.cid})

    def payloads(self):
        paths = list(self.folder.rglob('*.payloads.jsonl'))
        self.assertEqual(len(paths), 1)
        content = paths[0].read_text(encoding='utf-8')
        self.assertNotIn(SECRET, content)
        return [json.loads(line) for line in content.splitlines()]

    def model_payloads(self):
        records = self.payloads()
        prechecks = [row for row in records if row['kind'] == 'rule_precheck']
        self.assertEqual(len(prechecks), 1)
        self.assertFalse(prechecks[0]['payload']['result']['rejected'])
        self.assertNotIn('call_id', prechecks[0])
        return [row for row in records if row['kind'].startswith('model_')]

    def timing(self):
        paths = [path for path in self.folder.rglob('*.jsonl') if not path.name.endswith('.payloads.jsonl')]
        self.assertEqual(len(paths), 1)
        events = [json.loads(line) for line in paths[0].read_text(encoding='utf-8').splitlines()]
        self.assertEqual(events[-1]['event'], 'trace_end')
        self.assertTrue(paths[0].with_suffix('.summary.txt').exists())
        return events

    def history_count(self):
        with server.connect() as db:
            return db.execute('SELECT count(*) FROM evaluations').fetchone()[0]

    def test_full_request_matches_sent_bytes_and_full_response_is_not_truncated(self):
        long_resume = RESUME + '\n' + '合成长履历段落。' * 2600 + '履历末尾标记'
        with server.connect() as db:
            db.execute('UPDATE candidates SET resume=? WHERE id=?', (long_resume, self.cid))
        raw = raw_response(reasoning='合成完整推理。' * 16000 + '推理末尾标记')
        requests = []
        def open_request(request, **kwargs):
            requests.append(request.data.decode('utf-8'))
            return response(raw)
        self.network.side_effect = open_request
        status, body = self.evaluate()
        self.assertEqual(status, 200, body)
        records = self.model_payloads()
        self.assertEqual([row['kind'] for row in records], ['model_request', 'model_response'])
        self.assertEqual(records[0]['payload'], requests[0])
        self.assertEqual(records[1]['payload'], raw.decode('utf-8'))
        self.assertEqual(records[0]['call_id'], records[1]['call_id'])
        self.assertEqual(records[1]['http_status'], 200)
        self.assertIn('履历末尾标记', json.dumps(json.loads(records[0]['payload']), ensure_ascii=False))
        self.assertIn('推理末尾标记', records[1]['payload'])
        self.assertGreater(len(records[1]['payload']), 100000)
        self.assertEqual(self.history_count(), 1)
        self.assertEqual(self.timing()[-1]['metadata']['status'], 'succeeded')

    def test_non_json_response_is_logged_before_parse_failure(self):
        raw = b'<html>synthetic upstream response is not JSON</html>'
        self.network.side_effect = lambda *args, **kwargs: response(raw)
        status, body = self.evaluate()
        self.assertEqual(status, 422, body)
        records = self.model_payloads()
        responses = [row for row in records if row['kind'] == 'model_response']
        self.assertEqual(len(responses), 2)
        self.assertTrue(all(row['payload'] == raw.decode('utf-8') for row in responses))
        self.assertEqual(self.network.call_count, 2)
        self.assertEqual(self.history_count(), 0)
        self.assertEqual(self.timing()[-1]['metadata']['status'], 'failed')

    def test_format_retry_logs_two_distinct_paired_calls(self):
        invalid, valid = raw_response(content='{'), raw_response()
        self.network.side_effect = [response(invalid), response(valid)]
        status, body = self.evaluate()
        self.assertEqual(status, 200, body)
        records = self.model_payloads()
        self.assertEqual([row['kind'] for row in records],
            ['model_request', 'model_response', 'model_request', 'model_response'])
        self.assertEqual(records[0]['call_id'], records[1]['call_id'])
        self.assertEqual(records[2]['call_id'], records[3]['call_id'])
        self.assertNotEqual(records[0]['call_id'], records[2]['call_id'])
        self.assertEqual(records[1]['payload'], invalid.decode('utf-8'))
        self.assertEqual(records[3]['payload'], valid.decode('utf-8'))
        self.assertIn('上一次返回未通过校验', json.loads(records[2]['payload'])['messages'][0]['content'])
        self.assertEqual(self.history_count(), 1)

    def test_rate_limit_body_and_success_share_the_same_request_call_id(self):
        raw = b'{"error":{"code":"rate_limit","message":"synthetic wait"}}'
        error = urllib.error.HTTPError('https://payload-test.invalid/v1/chat/completions',
            429, 'synthetic limit', {}, io.BytesIO(raw))
        self.network.side_effect = [error, response()]
        with patch.object(model_transport, '_retry_delay', return_value=0):
            status, body = self.evaluate()
        self.assertEqual(status, 200, body)
        records = self.model_payloads()
        errors = [row for row in records if row['kind'] == 'model_http_error']
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]['payload'], raw.decode('utf-8'))
        self.assertEqual(errors[0]['http_status'], 429)
        self.assertEqual(len({row['call_id'] for row in records}), 1)
        self.assertEqual([row['kind'] for row in records].count('model_request'), 1)
        self.assertEqual([row['kind'] for row in records].count('model_response'), 1)
        self.assertEqual(self.network.call_count, 2)

    def test_401_error_body_is_logged_and_authentication_echo_is_redacted(self):
        raw = json.dumps({'error': {'message': 'invalid credential ' + SECRET,
                                  'api_key': NESTED_SECRET}}).encode('utf-8')
        error = urllib.error.HTTPError('https://payload-test.invalid/v1/chat/completions',
            401, 'synthetic auth failure', {}, io.BytesIO(raw))
        self.network.side_effect = error
        status, body = self.evaluate()
        self.assertEqual(status, 400, body)
        self.assertIn('HTTP 401', body['error'])
        self.network.assert_called_once()
        records = self.model_payloads()
        errors = [row for row in records if row['kind'] == 'model_http_error']
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]['http_status'], 401)
        self.assertIn('invalid credential', errors[0]['payload'])
        self.assertNotIn(NESTED_SECRET, json.dumps(records))
        self.assertEqual(self.timing()[-1]['metadata']['status'], 'failed')

    def test_response_echo_redaction_does_not_modify_business_response(self):
        value = answer('普通原始回答 ' + SECRET)
        value['debug'] = {'api_key': NESTED_SECRET}
        raw = raw_response(content=json.dumps(value, ensure_ascii=False),
            reasoning='普通推理文字 Bearer SYNTHETIC_BEARER_VALUE',
            token_info={'access_token': 'SYNTHETIC_ACCESS_TOKEN'})
        self.network.side_effect = lambda *args, **kwargs: response(raw)
        status, body = self.evaluate()
        self.assertEqual(status, 200, body)
        self.assertEqual(body['summary'], value['summary'])
        records = self.model_payloads()
        encoded = json.dumps(records, ensure_ascii=False)
        for secret in (SECRET, NESTED_SECRET, 'SYNTHETIC_BEARER_VALUE', 'SYNTHETIC_ACCESS_TOKEN'):
            self.assertNotIn(secret, encoded)
        self.assertIn('普通原始回答', encoded)
        self.assertIn('普通推理文字', encoded)

    def test_error_body_read_failure_keeps_original_http_error_status(self):
        class UnreadableHTTPError(urllib.error.HTTPError):
            def read(self, *args):
                raise TimeoutError(SECRET)
        self.network.side_effect = UnreadableHTTPError(
            'https://payload-test.invalid/v1/chat/completions', 401, 'synthetic auth failure', {}, io.BytesIO())
        status, body = self.evaluate()
        self.assertEqual(status, 400, body)
        self.assertIn('HTTP 401', body['error'])
        self.network.assert_called_once()
        errors = [row for row in self.payloads() if row['kind'] == 'model_http_error']
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]['http_status'], 401)
        self.assertEqual(errors[0]['error_type'], 'TimeoutError')
        self.assertFalse(errors[0]['response_complete'])
        self.assertIsNone(errors[0]['payload'])
        self.assertEqual(self.timing()[-1]['metadata']['status'], 'failed')

    def test_incomplete_response_logs_received_partial_and_preserves_error(self):
        partial = b'{"partial":"received synthetic response segment"'
        class IncompleteResponse(io.BytesIO):
            status = 200
            def read(self, *args):
                raise http.client.IncompleteRead(partial, 100)
        self.network.side_effect = lambda *args, **kwargs: IncompleteResponse()
        status, body = self.evaluate()
        self.assertEqual(status, 400, body)
        self.assertEqual(self.network.call_count, 1)
        records = self.model_payloads()
        responses = [row for row in records if row['kind'] == 'model_response']
        self.assertEqual(len(responses), 1)
        self.assertEqual(responses[0]['payload'], partial.decode('utf-8'))
        self.assertFalse(responses[0]['response_complete'])
        self.assertEqual(self.timing()[-1]['metadata']['status'], 'failed')

    def test_sidecar_write_failure_does_not_change_evaluation_api_or_storage(self):
        class BrokenWriter:
            def write(self, value):
                raise OSError('synthetic disk full')
            def flush(self):
                pass
            def close(self):
                pass
        original_open = Path.open
        def open_path(path, *args, **kwargs):
            if path.name.endswith('.payloads.jsonl'):
                return BrokenWriter()
            return original_open(path, *args, **kwargs)
        self.network.side_effect = lambda *args, **kwargs: response()
        with patch.object(Path, 'open', open_path), patch.object(evaluation_trace, '_warn_once'):
            status, body = self.evaluate()
        self.assertEqual(status, 200, body)
        self.assertEqual(body['score'], 100)
        self.assertEqual(self.history_count(), 1)
        self.assertEqual(self.timing()[-1]['metadata']['status'], 'succeeded')
        self.network.assert_called_once()


if __name__ == '__main__':
    unittest.main()
