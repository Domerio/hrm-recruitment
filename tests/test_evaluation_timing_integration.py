"""Exercise evaluation timing through the actual adapter with synthetic HTTP bodies."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import evaluation_trace
import server


SECRET = 'synthetic-private-key-for-timing'
NAME = '合成隐私姓名计时测试'
RESUME_MARKER = 'SYNTHETIC_PRIVATE_RESUME_MARKER'
ANSWER_MARKER = 'SYNTHETIC_PRIVATE_MODEL_ANSWER'
RESUME = ('工作经历\n合成研发公司 软件工程师 2020.01 - 至今\n'
          '本人负责 Python 设备接口开发、数据处理和程序验证。' + RESUME_MARKER)


def answer():
    return {'score': 0, 'category': '低匹配', 'summary': ANSWER_MARKER, 'questions': [],
            'checks': [{'condition_id': 1, 'condition': '熟悉 Python', 'status': '满足',
                        'basis': 'explicit', 'support_score': 100, 'evidence_lines': [3]}],
            'required_checks': [], 'inferred_capabilities': []}


def response(content=None):
    body = {'choices': [{'finish_reason': 'stop', 'message': {
        'content': json.dumps(answer(), ensure_ascii=False) if content is None else content,
        'reasoning_content': 'SYNTHETIC_PRIVATE_REASONING'}}],
        'usage': {'prompt_tokens': 1200, 'completion_tokens': 250, 'total_tokens': 1450,
                  'prompt_tokens_details': {'cached_tokens': 400},
                  'completion_tokens_details': {'reasoning_tokens': 60}, 'private': SECRET}}
    result = io.BytesIO(json.dumps(body, ensure_ascii=False).encode('utf-8'))
    result.status = 200
    return result


class EvaluationTimingIntegrationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.folder = Path(directory.name)
        for name, value in [('DB', self.folder / 'timing.sqlite3'),
                            ('AI_LOCK', server.AIExecutionGate()), ('_AI_QUEUE', None),
                            ('_AI_QUEUE_DB', None), ('_AI_INFERENCE_FLIGHTS', server.InferenceFlights())]:
            active = patch.object(server, name, value)
            active.start()
            self.addCleanup(active.stop)
        active = patch.dict(os.environ, {'AI_MODEL': 'synthetic-A',
            'AI_BASE_URL': 'https://synthetic-private.invalid/v1', 'DEEPSEEK_API_KEY': SECRET})
        active.start()
        self.addCleanup(active.stop)
        active = patch.object(server, 'model_urlopen', side_effect=AssertionError('Unexpected real model call'))
        self.network = active.start()
        self.addCleanup(active.stop)
        self.addCleanup(self.stop_queue)
        server.init_db()
        with server.connect() as db:
            db.execute("INSERT INTO jobs VALUES(1,'合成岗位','','设备程序开发','熟悉 Python','now')")
        self.cid = self.candidate()

    def stop_queue(self):
        if server._AI_QUEUE is not None:
            server._AI_QUEUE.shutdown(wait=True)

    def candidate(self, suffix='', resume=RESUME):
        with server.connect() as db:
            cursor = db.execute('INSERT INTO candidates(job_id,name,resume,phone,email,link,created) '
                                'VALUES(?,?,?,?,?,?,?)', (1, NAME + suffix, resume, '', '', '', 'now'))
            return cursor.lastrowid

    def timing_logs(self):
        return {path for path in self.folder.rglob('*.jsonl') if not path.name.endswith('.payloads.jsonl')}

    def evaluate(self, cid=None):
        before = self.timing_logs()
        task = server.submit_ai_request('/api/ai/evaluate', {'id': self.cid if cid is None else cid})
        status, body = server.ai_queue().wait(task['id'], 5)
        paths = self.timing_logs() - before
        self.assertEqual(len(paths), 1)
        path = paths.pop()
        content = path.read_text(encoding='utf-8')
        events = [json.loads(line) for line in content.splitlines()]
        summary = path.with_suffix('.summary.txt').read_text(encoding='utf-8')
        self.assertEqual(events[-1]['event'], 'trace_end')
        self.assertEqual(events[-1]['metadata']['task_id'], task['id'])
        for private in (SECRET, NAME, RESUME_MARKER, ANSWER_MARKER,
                        'SYNTHETIC_PRIVATE_REASONING', 'synthetic-private.invalid'):
            self.assertNotIn(private, content + summary)
        self.assertIsNone(evaluation_trace.current_trace())
        return status, body, events, summary

    def stages(self, events, name):
        return [item for item in events if item['event'] == 'stage_end' and item.get('step') == name]

    def history(self):
        with server.connect() as db:
            return [dict(row) for row in db.execute('SELECT * FROM evaluations ORDER BY id')]

    def test_success_records_stages_usage_and_database_result(self):
        self.network.side_effect = lambda *args, **kwargs: response()
        status, body, events, summary = self.evaluate()
        self.assertEqual(status, 200, body)
        self.assertEqual(body['score'], 100)
        self.network.assert_called_once()
        for stage in ('revalidate_queued_inputs', 'load_candidate_and_cache', 'prepare_evaluation',
                      'model_attempt', 'request_build', 'http_request', 'response_body_read',
                      'response_json_parse', 'model_json_parse', 'validate_attempt', 'calculate_score',
                      'persist_evaluation'):
            self.assertTrue(self.stages(events, stage), stage)
        self.assertTrue(any(item['event'] == 'queue_wait' for item in events))
        end = events[-1]
        self.assertEqual(end['metadata']['status'], 'succeeded')
        self.assertEqual(end['metadata']['model'], 'synthetic-A')
        self.assertEqual(end['usage_totals'], {'input_tokens': 1200, 'output_tokens': 250,
            'total_tokens': 1450, 'cached_tokens': 400, 'reasoning_tokens': 60})
        rows = self.history()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['model'], 'synthetic-A')
        self.assertEqual(json.loads(rows[0]['result'])['summary'], ANSWER_MARKER)
        self.assertIn('http_request', summary)
        self.assertIn('排队等待', summary)

    def test_cached_result_creates_trace_without_http_or_duplicate_history(self):
        self.network.side_effect = lambda *args, **kwargs: response()
        self.evaluate()
        self.network.reset_mock()
        self.network.side_effect = AssertionError('Cache must not call model')
        status, body, events, _ = self.evaluate()
        self.assertEqual(status, 200)
        self.assertTrue(body['cached'])
        self.network.assert_not_called()
        self.assertEqual(self.stages(events, 'http_request'), [])
        self.assertTrue(any(item['event'] == 'cache_hit' and item['cached'] for item in events))
        self.assertEqual(events[-1]['usage_totals'], {})
        self.assertEqual(len(self.history()), 1)

    def test_invalid_json_then_success_records_both_attempts_and_total_usage(self):
        self.network.side_effect = [response('{'), response()]
        status, body, events, _ = self.evaluate()
        self.assertEqual(status, 200, body)
        self.assertEqual(self.network.call_count, 2)
        self.assertEqual([item['attempt'] for item in self.stages(events, 'model_attempt')], [1, 2])
        self.assertEqual(len(self.stages(events, 'http_request')), 2)
        self.assertTrue(any(item['event'] == 'validation_retry' and item['attempt'] == 2 for item in events))
        self.assertEqual(events[-1]['usage_totals']['total_tokens'], 2900)
        self.assertEqual(len(self.history()), 1)

    def test_timeout_still_generates_failure_summary_and_no_success_history(self):
        self.network.side_effect = TimeoutError(SECRET)
        status, body, events, summary = self.evaluate()
        self.assertEqual(status, 400, body)
        self.network.assert_called_once()
        self.assertEqual(events[-1]['metadata']['status'], 'failed')
        self.assertTrue(self.stages(events, 'failure_persistence'))
        self.assertEqual(self.stages(events, 'http_request')[0]['error_type'], 'TimeoutError')
        self.assertIn('failed', summary)
        self.assertEqual(self.history(), [])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_evaluation_failures').fetchone()[0], 1)

    def test_a_to_b_to_a_calls_again_and_keeps_all_three_results(self):
        self.network.side_effect = lambda *args, **kwargs: response()
        _, _, first, _ = self.evaluate()
        epochs = [first[-1]['metadata']['evaluation_epoch']]
        for model in ('synthetic-B', 'synthetic-A'):
            current = server.load_config(server.DB.parent / 'ai-config.json')
            saved, changed = server.save_config(server.DB.parent / 'ai-config.json', {
                'revision': current['revision'], 'provider': current['provider'],
                'base_url': current['base_url'], 'model': model, 'api_key': SECRET})
            self.assertTrue(changed)
            status, body, events, _ = self.evaluate()
            self.assertEqual(status, 200, body)
            self.assertFalse(body.get('cached', False))
            self.assertEqual(len(self.stages(events, 'http_request')), 1)
            epochs.append(events[-1]['metadata']['evaluation_epoch'])
        self.assertEqual(epochs, [0, 1, 2])
        self.assertEqual(self.network.call_count, 3)
        self.assertEqual([row['model'] for row in self.history()], ['synthetic-A', 'synthetic-B', 'synthetic-A'])

    def test_parallel_candidates_keep_separate_trace_ids_and_usage(self):
        other = self.candidate('二', RESUME + '\n第二份合成简历补充内容')
        barrier = threading.Barrier(2)
        def serve(*args, **kwargs):
            barrier.wait(3)
            return response()
        self.network.side_effect = serve
        tasks = [server.submit_ai_request('/api/ai/evaluate', {'id': cid}) for cid in (self.cid, other)]
        for task in tasks:
            self.assertEqual(server.ai_queue().wait(task['id'], 5)[0], 200)
        logs = list(self.timing_logs())
        self.assertEqual(len(logs), 2)
        observed = set()
        for path in logs:
            events = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
            self.assertEqual(len({item['trace_id'] for item in events}), 1)
            end = events[-1]
            observed.add((end['metadata']['task_id'], end['metadata']['candidate_id']))
            self.assertEqual(end['usage_totals']['total_tokens'], 1450)
            self.assertEqual(len(self.stages(events, 'http_request')), 1)
        self.assertEqual(observed, {(tasks[0]['id'], self.cid), (tasks[1]['id'], other)})
        self.assertEqual(self.network.call_count, 2)
        self.assertEqual(len(self.history()), 2)
        self.assertIsNone(evaluation_trace.current_trace())

    def test_shared_inference_logs_usage_only_for_owner(self):
        other = self.candidate('同资料')
        entered, release = threading.Event(), threading.Event()
        def serve(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError('synthetic inference gate expired')
            return response()
        self.network.side_effect = serve
        tasks = []
        try:
            tasks.append(server.submit_ai_request('/api/ai/evaluate', {'id': self.cid}))
            self.assertTrue(entered.wait(2))
            tasks.append(server.submit_ai_request('/api/ai/evaluate', {'id': other}))
            flights = server._AI_INFERENCE_FLIGHTS
            with flights._condition:
                self.assertTrue(flights._condition.wait_for(
                    lambda: any(item['waiters'] for item in flights._flights.values()), 2))
        finally:
            release.set()
        for task in tasks:
            self.assertEqual(server.ai_queue().wait(task['id'], 5)[0], 200)
        self.network.assert_called_once()
        logs = list(self.timing_logs())
        self.assertEqual(len(logs), 2)
        owners, followers = [], []
        for path in logs:
            events = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
            (owners if self.stages(events, 'http_request') else followers).append(events)
        self.assertEqual((len(owners), len(followers)), (1, 1))
        self.assertEqual(owners[0][-1]['usage_totals']['total_tokens'], 1450)
        self.assertEqual(followers[0][-1]['usage_totals'], {})
        self.assertEqual(len(self.stages(followers[0], 'shared_inference_wait')), 1)
        self.assertEqual(len(self.history()), 2)


if __name__ == '__main__':
    unittest.main()
