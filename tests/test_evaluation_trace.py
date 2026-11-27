import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import evaluation_trace as tracing


class EvaluationTraceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'evaluation-logs'

    def events(self, trace):
        return [json.loads(line) for line in trace.path.read_text(encoding='utf-8').splitlines()]

    def test_nested_stages_use_monotonic_time_and_do_not_double_count(self):
        clock = [0.0]
        with patch.object(tracing, '_clock', side_effect=lambda: clock[0]):
            with tracing.trace_run(self.directory, 'evaluate', candidate_id=42) as trace:
                tracing.event('queue_wait', duration_ms=5.0)
                with tracing.span('pipeline'):
                    clock[0] = 0.010
                    with tracing.span('model_request', attempt=1) as fields:
                        clock[0] = 0.035
                        fields['response_bytes'] = 123
                    clock[0] = 0.050
                clock[0] = 0.060
        events = self.events(trace)
        stages = [row for row in events if row['event'] == 'stage_end']
        self.assertEqual([row['duration_ms'] for row in stages], [25.0, 50.0])
        self.assertEqual([row['self_duration_ms'] for row in stages], [25.0, 25.0])
        self.assertEqual(stages[0]['parent_span_id'], stages[1]['span_id'])
        self.assertEqual(stages[0]['response_bytes'], 123)
        self.assertEqual(events[-1]['total_duration_ms'], 60.0)
        self.assertEqual(events[-1]['end_to_end_ms'], 65.0)
        self.assertTrue(events[0]['timestamp'].endswith('+08:00'))
        summary = trace.summary_path.read_text(encoding='utf-8')
        self.assertIn('自身耗时合计: 50.000 ms', summary)
        self.assertIn('不能分离服务端排队', summary)

    def test_events_are_flushed_before_evaluation_finishes(self):
        with tracing.trace_run(self.directory, 'evaluate') as trace:
            tracing.event('checkpoint', cached=True)
            self.assertEqual(self.events(trace)[-1]['event'], 'checkpoint')
            self.assertFalse(trace.summary_path.exists())
        self.assertTrue(trace.summary_path.exists())

    def test_submission_time_is_added_once_outside_execution_and_queue(self):
        clock = [1.0]
        with patch.object(tracing, '_clock', side_effect=lambda: clock[0]):
            with tracing.trace_run(self.directory, 'evaluate', evaluation_epoch=7) as trace:
                tracing.event('submission_prepare', duration_ms=20)
                tracing.event('queue_wait', duration_ms=30)
                clock[0] = 1.1
        final = self.events(trace)[-1]
        self.assertEqual(final['total_duration_ms'], 100)
        self.assertEqual(final['submission_duration_ms'], 20)
        self.assertEqual(final['queue_wait_ms'], 30)
        self.assertEqual(final['end_to_end_ms'], 150)
        self.assertEqual(final['metadata']['evaluation_epoch'], 7)
        summary = trace.summary_path.read_text(encoding='utf-8')
        self.assertIn('不含浏览器读取简历、OCR', summary)
        self.assertIn('服务器端到端耗时（提交准备 + 排队 + 执行）: 150.000 ms', summary)

    def test_nested_trace_run_reuses_one_file_and_current_context_is_restored(self):
        self.assertIsNone(tracing.current_trace())
        with tracing.trace_run(self.directory, 'queue_execute', candidate_id=12) as outer:
            with tracing.trace_run(self.directory, 'evaluate', model='synthetic-model') as inner:
                self.assertIs(outer, inner)
                self.assertIs(tracing.current_trace(), inner)
            self.assertIs(tracing.current_trace(), outer)
        self.assertIsNone(tracing.current_trace())
        self.assertEqual(len(list(self.directory.rglob('*.jsonl'))), 1)
        events = self.events(outer)
        self.assertEqual(events[-1]['metadata']['model'], 'synthetic-model')
        self.assertEqual(sum(row['event'] == 'trace_start' for row in events), 1)

    def test_parallel_evaluations_have_independent_spans_and_metadata(self):
        barrier = threading.Barrier(2)
        traces, errors = {}, []
        def run(candidate_id):
            try:
                with tracing.trace_run(self.directory, 'evaluate', candidate_id=candidate_id) as trace:
                    traces[candidate_id] = trace
                    with tracing.span('request', attempt=candidate_id):
                        barrier.wait(timeout=5)
                        tracing.annotate(model='model-' + str(candidate_id))
                        tracing.event('cache_lookup', cached=False)
            except BaseException as error:
                errors.append(error)
        workers = [threading.Thread(target=run, args=(value,)) for value in (1, 2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=10)
            self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertNotEqual(traces[1].trace_id, traces[2].trace_id)
        for candidate_id, trace in traces.items():
            events = self.events(trace)
            self.assertTrue(all(row['trace_id'] == trace.trace_id for row in events))
            self.assertEqual(events[-1]['metadata']['candidate_id'], candidate_id)
            self.assertEqual(events[-1]['metadata']['model'], 'model-' + str(candidate_id))
            self.assertEqual(next(row for row in events if row['event'] == 'stage_end')['attempt'], candidate_id)

    def test_exception_keeps_final_trace_and_never_logs_sensitive_content(self):
        secret = 'synthetic-private-secret-value'
        original = ValueError(secret)
        with self.assertRaises(ValueError) as caught:
            with tracing.trace_run(self.directory, 'evaluate', candidate_name=secret,
                                   api_key=secret, model='synthetic-model') as trace:
                with tracing.span('model_request', prompt=secret, url='https://private.invalid') as fields:
                    fields.update(response=secret, request_headers={'Authorization':secret})
                    raise original
        self.assertIs(caught.exception, original)
        events = self.events(trace)
        self.assertEqual(events[-1]['metadata']['status'], 'failed')
        self.assertEqual(next(row for row in events if row['event'] == 'stage_end')['error_type'], 'ValueError')
        for file in (trace.path, trace.summary_path):
            text = file.read_text(encoding='utf-8')
            self.assertNotIn(secret, text)
            self.assertNotIn('private.invalid', text)
            self.assertNotIn('Authorization', text)
        self.assertIsNone(tracing.current_trace())

    def test_usage_is_numeric_only_and_accumulates_retries(self):
        with tracing.trace_run(self.directory, 'evaluate') as trace:
            tracing.record_usage({'prompt_tokens':100, 'completion_tokens':20, 'total_tokens':120,
                                  'completion_tokens_details':{'reasoning_tokens':3, 'text':'private'},
                                  'prompt_tokens_details':{'cached_tokens':50}, 'response':'private'})
            tracing.record_usage({'input_tokens':10, 'output_tokens':5, 'total_tokens':15,
                                  'input_tokens_details':{'cached_tokens':2},
                                  'output_tokens_details':{'reasoning_tokens':1}, 'api_key':'private'})
            tracing.record_usage({'input_tokens':True, 'output_tokens':-1, 'total_tokens':'private'})
            tracing.record_usage({'input_tokens':10 ** 400})
            tracing.event('ignored_data', wait_seconds=float('inf'), duration_ms=float('nan'),
                          error_type='https://private.invalid', request='private', request_bytes=10 ** 400)
        events = self.events(trace)
        self.assertEqual(events[-1]['usage_totals'], {'input_tokens':110, 'output_tokens':25,
                         'total_tokens':135, 'cached_tokens':52, 'reasoning_tokens':4})
        self.assertEqual(sum(row['event'] == 'model_usage' for row in events), 2)
        self.assertNotIn('private', trace.path.read_text(encoding='utf-8'))

    def test_deepseek_cache_usage_is_supported(self):
        with tracing.trace_run(self.directory, 'evaluate') as trace:
            tracing.record_usage({'prompt_tokens':100, 'prompt_cache_hit_tokens':75,
                                  'prompt_cache_miss_tokens':25})
        self.assertEqual(self.events(trace)[-1]['usage_totals'], {'input_tokens':100, 'cached_tokens':75})

    def test_directory_failure_is_nonfatal_and_context_is_reset(self):
        with patch.object(Path, 'mkdir', side_effect=PermissionError('private-path')), \
                patch.object(tracing, '_warned', False), patch('sys.stderr', new_callable=io.StringIO) as stderr:
            with tracing.trace_run(self.directory, 'evaluate'):
                with tracing.span('model_request'):
                    tracing.event('cache_lookup', cached=False)
                tracing.annotate(http_status=200)
            self.assertIn('evaluation continues', stderr.getvalue())
            self.assertNotIn('private-path', stderr.getvalue())
        self.assertIsNone(tracing.current_trace())

    def test_midstream_write_and_summary_write_failures_do_not_replace_result(self):
        with patch.object(tracing, '_warned', True):
            with tracing.trace_run(self.directory, 'evaluate') as trace:
                trace._file.close()
                with tracing.span('model_request'):
                    tracing.event('cache_lookup', cached=False)
            self.assertIsNone(tracing.current_trace())
            with patch.object(Path, 'write_text', side_effect=OSError('disk full')):
                with tracing.trace_run(self.directory, 'evaluate') as other:
                    tracing.annotate(http_status=200)
            self.assertEqual(self.events(other)[-1]['event'], 'trace_end')
            self.assertIsNone(tracing.current_trace())

    def test_http_failure_ends_as_failed_and_noop_functions_are_safe(self):
        with tracing.span('untraced') as fields:
            fields['arbitrary'] = object()
        tracing.event('untraced', response='not recorded')
        tracing.annotate(status='failed')
        tracing.record_usage({'input_tokens':10})
        self.assertFalse(self.directory.exists())
        with tracing.trace_run(self.directory, 'evaluate') as trace:
            tracing.annotate(http_status=409)
        self.assertEqual(self.events(trace)[-1]['metadata']['status'], 'failed')

    def payloads(self, trace):
        return [json.loads(line) for line in trace.payload_path.read_text(encoding='utf-8').splitlines()]

    def test_full_payloads_are_untruncated_and_not_kept_in_timing_events(self):
        resume = '张某\n工作经历：完整正文。\n' * 20000
        body = json.dumps({'messages':[{'role':'user', 'content':resume}],
                           'url':'https://example.invalid/resume'}, ensure_ascii=False).encode('utf-8')
        with tracing.trace_run(self.directory, 'evaluate') as trace:
            with tracing.span('model_roundtrip'):
                tracing.record_payload('model_request', body, call_id='call-1', attempt=1,
                                       headers={'Authorization':'must-not-enter-metadata'},
                                       url='https://private-service.invalid')
                records = self.payloads(trace)
                self.assertEqual(records[0]['payload'], body.decode('utf-8'))
                self.assertEqual(records[0]['span_id'], 's1')
                self.assertEqual(records[0]['payload_encoding'], 'utf-8')
                self.assertEqual(records[0]['decode_errors'], 'replace')
                self.assertNotIn('headers', records[0])
                self.assertNotIn('url', records[0])
                tracing.record_payload('model_response', '模型返回全文\n' + resume,
                                       call_id='call-1', http_status=200, response_complete=True)
            self.assertNotIn(resume, repr(trace._events))
        self.assertEqual(self.payloads(trace)[1]['payload'], '模型返回全文\n' + resume)
        self.assertNotIn('张某', trace.path.read_text(encoding='utf-8'))
        summary = trace.summary_path.read_text(encoding='utf-8')
        self.assertIn('内容日志包含实际发送的履历、提示词和模型回复全文', summary)
        self.assertIn(trace.payload_path.name, summary)
        self.assertIn('内容记录数: 2', summary)
        self.assertIsNone(trace._payload_file)

    def test_payload_redacts_sensitive_keys_and_nested_json_strings(self):
        secret = 'known-key-中文-\\"quoted'
        payload = {
            'name':'张某', 'resume':'保留简历全文及网址 https://example.invalid/profile',
            'api_key':'unknown-key', 'nested':[{'Access_Token':'private-access', 'password':['private-password']}],
            'headers':{'Authorization':'Bearer private-header', 'Content-Type':'application/json'},
            'request_json':json.dumps({'refresh_token':'private-refresh',
                'messages':[{'content':json.dumps({'client_secret':'private-nested', '正文':'保留正文'})}]}, ensure_ascii=False),
            'note':'known key: ' + secret,
        }
        encoded = json.dumps(payload, ensure_ascii=True).encode('utf-8')
        with tracing.trace_run(self.directory, 'evaluate') as trace:
            tracing.record_payload('model_request', encoded, secrets=(secret, ''), call_id=12)
            tracing.record_payload('model_response', payload, secrets=(secret,), call_id=12)
        rows = self.payloads(trace)
        self.assertEqual(rows[0]['call_id'], '12')
        body = json.loads(rows[0]['payload'])
        self.assertEqual(body['name'], '张某')
        self.assertIn('https://example.invalid/profile', body['resume'])
        self.assertEqual(body['api_key'], '[REDACTED]')
        self.assertEqual(body['headers']['Authorization'], '[REDACTED]')
        self.assertEqual(body['headers']['Content-Type'], 'application/json')
        self.assertEqual(body['nested'][0]['password'], '[REDACTED]')
        nested = json.loads(body['request_json'])
        self.assertEqual(nested['refresh_token'], '[REDACTED]')
        self.assertEqual(json.loads(nested['messages'][0]['content']), {'client_secret':'[REDACTED]', '正文':'保留正文'})
        self.assertEqual(rows[1]['payload']['note'], 'known key: [REDACTED]')
        text = trace.payload_path.read_text(encoding='utf-8')
        for value in ('unknown-key','private-access','private-password','private-header','private-refresh','private-nested','known-key-'):
            self.assertNotIn(value, text)
        self.assertEqual(payload['api_key'], 'unknown-key')

    def test_plaintext_credentials_are_redacted_and_bad_utf8_is_marked(self):
        content = ('保留错误全文\napi_key=private-api\npassword="private password" '
                   'Bearer private-bearer Basic cHJpdmF0ZQ== access_token:private-access').encode('utf-8') + b'\n\xff'
        with tracing.trace_run(self.directory, 'evaluate') as trace:
            tracing.record_payload('model_response', content, http_status=502,
                                   error_type='IncompleteRead', response_complete=False)
        row = self.payloads(trace)[0]
        self.assertIn('保留错误全文', row['payload'])
        self.assertIn('Bearer [REDACTED]', row['payload'])
        self.assertIn('Basic [REDACTED]', row['payload'])
        self.assertTrue(row['payload'].endswith('\ufffd'))
        self.assertNotIn('private', row['payload'])
        self.assertNotIn('cHJpdmF0ZQ', row['payload'])
        self.assertEqual(row['error_type'], 'IncompleteRead')
        self.assertFalse(row['response_complete'])
        self.assertEqual(row['decode_errors'], 'replace')

    def test_malformed_json_sensitive_assignments_are_still_redacted(self):
        with tracing.trace_run(self.directory, 'evaluate') as trace:
            tracing.record_payload('model_response', '{"api_key": "private-key", "broken":')
        body = self.payloads(trace)[0]['payload']
        self.assertNotIn('private-key', body)
        self.assertIn('"broken":', body)

    def test_basic_skill_names_are_preserved_while_auth_credentials_are_redacted(self):
        skills = 'Visual Basic .NET\nBasic Python\nVisual Basic for Applications\nBasic SQL'
        with tracing.trace_run(self.directory, 'evaluate') as trace:
            tracing.record_payload('model_request', {'resume':skills})
            tracing.record_payload('model_response', 'Authorization: Basic private-auth\nBasic dTpw')
        rows = self.payloads(trace)
        self.assertEqual(rows[0]['payload']['resume'], skills)
        self.assertEqual(rows[1]['payload'], 'Authorization: Basic [REDACTED]\nBasic [REDACTED]')

    def test_payload_logging_without_trace_does_not_touch_files(self):
        tracing.record_payload('model_request', {'messages':['full text']}, secrets=('secret',))
        self.assertFalse(self.directory.exists())

    def test_payload_write_failure_does_not_disable_timing_or_change_business_error(self):
        original_open = Path.open
        def open_unless_payload(path, *args, **kwargs):
            if path.name.endswith('.payloads.jsonl'):
                raise OSError('private filesystem details')
            return original_open(path, *args, **kwargs)
        original_error = ValueError('business failure')
        with patch.object(Path, 'open', new=open_unless_payload), patch.object(tracing, '_warned', True):
            with self.assertRaises(ValueError) as caught:
                with tracing.trace_run(self.directory, 'evaluate') as trace:
                    tracing.record_payload('model_request', {'messages':['full text']})
                    self.assertTrue(trace._payload_disabled)
                    tracing.event('still_running', http_status=200)
                    raise original_error
        self.assertIs(caught.exception, original_error)
        events = self.events(trace)
        self.assertEqual(events[-1]['event'], 'trace_end')
        self.assertTrue(events[-1]['payload_log_failed'])
        self.assertTrue(any(row['event'] == 'still_running' for row in events))
        self.assertIn('内容日志', trace.summary_path.read_text(encoding='utf-8'))
        self.assertNotIn('private filesystem details', trace.path.read_text(encoding='utf-8'))

    def test_payload_handle_closes_after_exception_and_midstream_failure(self):
        with self.assertRaises(ValueError):
            with tracing.trace_run(self.directory, 'evaluate') as trace:
                tracing.record_payload('model_request', {'messages':['full text']})
                handle = trace._payload_file
                raise ValueError('test')
        self.assertTrue(handle.closed)
        with patch.object(tracing, '_warned', True):
            with tracing.trace_run(self.directory, 'evaluate') as other:
                tracing.record_payload('model_request', 'first')
                other._payload_file.close()
                tracing.record_payload('model_response', 'second')
                tracing.event('business_continues', http_status=200)
        self.assertEqual(self.events(other)[-1]['metadata']['status'], 'succeeded')
        self.assertTrue(other._payload_disabled)
        self.assertIsNone(other._payload_file)

    def test_parallel_payloads_are_isolated_and_not_retained_after_finish(self):
        barrier = threading.Barrier(2)
        traces, errors = {}, []
        def run(candidate_id):
            try:
                with tracing.trace_run(self.directory, 'evaluate', candidate_id=candidate_id) as trace:
                    traces[candidate_id] = trace
                    barrier.wait(timeout=5)
                    tracing.record_payload('model_request', {'resume':'resume-' + str(candidate_id)},
                                           call_id='call-' + str(candidate_id))
            except BaseException as error:
                errors.append(error)
        workers = [threading.Thread(target=run, args=(value,)) for value in (1,2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=10)
            self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        for candidate_id, trace in traces.items():
            row = self.payloads(trace)[0]
            self.assertEqual(row['trace_id'], trace.trace_id)
            self.assertEqual(row['call_id'], 'call-' + str(candidate_id))
            self.assertEqual(row['payload'], {'resume':'resume-' + str(candidate_id)})
            self.assertEqual(trace._events, [])
            self.assertIsNone(trace._payload_file)


if __name__ == '__main__':
    unittest.main()
