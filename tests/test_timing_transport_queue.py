from contextlib import contextmanager
from contextvars import ContextVar
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_tasks
import evaluation_trace
import model_transport as transport


SECRET = 'synthetic-private-resume-and-key'


class RecordingTrace:
    def __init__(self):
        self.current = ContextVar('test_trace', default=None)
        self.created = []
        self.records = []

    def factory(self, task_id):
        self.created.append(task_id)

        @contextmanager
        def run():
            record = {'task_id': task_id, 'events': [], 'thread': threading.current_thread().name}
            self.records.append(record)
            token = self.current.set(record)
            try:
                yield record
            finally:
                record['closed'] = True
                self.current.reset(token)
        return run()

    def current_trace(self):
        # This fixture verifies timing only; payload logging has dedicated tests.
        return None

    def event(self, name, **fields):
        record = self.current.get()
        if record is not None:
            record['events'].append({'name': name, **fields})

    def annotate(self, **fields):
        record = self.current.get()
        if record is not None:
            record.update(fields)

    @contextmanager
    def span(self, name, **fields):
        try:
            yield fields
        except BaseException as error:
            fields['error_type'] = type(error).__name__
            raise
        finally:
            self.event(name, **fields)


class TransportTimingTests(unittest.TestCase):
    def setUp(self):
        self.trace = RecordingTrace()
        self.patch = patch.object(transport, 'trace', self.trace)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        transport._reset_cooldowns_for_tests()
        self.addCleanup(transport._reset_cooldowns_for_tests)
        self.request = urllib.request.Request('https://private.invalid/' + SECRET,
            data=SECRET.encode(), headers={'Authorization': 'Bearer ' + SECRET})

    def test_success_records_http_status_without_request_details(self):
        response = io.BytesIO(b'{}')
        response.status = 200
        opener = Mock(return_value=response)
        with self.trace.factory('synthetic-task'):
            with transport.model_request(opener, self.request, timeout=37) as received:
                self.assertEqual(json.load(received), {})
        events = self.trace.records[0]['events']
        self.assertEqual(events[0]['name'], 'rate_limit_wait')
        self.assertEqual(events[1], {'name': 'http_request', 'attempt': 1,
            'timeout_seconds': 37, 'http_status': 200})
        encoded = json.dumps(self.trace.records)
        self.assertNotIn(SECRET, encoded)
        self.assertNotIn('private.invalid', encoded)
        opener.assert_called_once()

    def test_429_retry_records_both_http_attempts(self):
        error = urllib.error.HTTPError(self.request.full_url, 429, SECRET, {}, io.BytesIO())
        response = io.BytesIO(b'{}')
        response.status = 200
        opener = Mock(side_effect=[error, response])
        with self.trace.factory('retry-task'), patch.object(transport, '_retry_delay', return_value=0):
            with transport.model_request(opener, self.request):
                pass
        events = self.trace.records[0]['events']
        attempts = [item for item in events if item['name'] == 'http_request']
        self.assertEqual([(item['attempt'], item['http_status']) for item in attempts], [(1, 429), (2, 200)])
        retries = [item for item in events if item['name'] == 'rate_limit_retry']
        self.assertEqual(len(retries), 1)
        self.assertEqual(retries[0]['wait_seconds'], 0)
        self.assertNotIn(SECRET, json.dumps(self.trace.records))
        self.assertEqual(opener.call_count, 2)

    def test_timeout_records_type_and_preserves_transport_classification(self):
        opener = Mock(side_effect=TimeoutError(SECRET))
        with self.trace.factory('timeout-task'), self.assertRaises(transport.ModelTransportError) as caught:
            with transport.model_request(opener, self.request):
                self.fail('timeout cannot return a response')
        self.assertEqual(caught.exception.code, 'model_timeout')
        attempts = [item for item in self.trace.records[0]['events'] if item['name'] == 'http_request']
        self.assertEqual(attempts[0]['error_type'], 'TimeoutError')
        self.assertNotIn(SECRET, json.dumps(self.trace.records))
        opener.assert_called_once()

    def test_missing_or_faulty_status_metadata_does_not_break_response(self):
        for response in (io.BytesIO(b'{}'), Mock(status=None, getcode=Mock(return_value=204)),
                         Mock(status=None, getcode=Mock(side_effect=ValueError(SECRET)))):
            with self.subTest(response_type=type(response).__name__):
                with self.trace.factory('status-task'):
                    received = transport._open_with_rate_limit_retry(Mock(return_value=response), self.request, 15)
                self.assertIs(received, response)
                self.assertNotIn(SECRET, json.dumps(self.trace.records))
        statuses = [record['events'][-1].get('http_status') for record in self.trace.records]
        self.assertEqual(statuses, [None, 204, None])


class QueueTimingTests(unittest.TestCase):
    def setUp(self):
        self.trace = RecordingTrace()
        self.patch = patch.object(ai_tasks, 'trace', self.trace)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.queue = ai_tasks.AITaskQueue(max_concurrency=1)
        self.addCleanup(self.queue.shutdown)

    def blocker(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def run():
            started.set()
            if not release.wait(5):
                raise TimeoutError('test blocker expired')
            return 200, {'ok': True}
        return run, started, release

    def test_factory_runs_once_for_shared_task_and_context_enters_worker(self):
        work, started, release = self.blocker()
        first = self.queue.submit('same-key', work, trace_factory=self.trace.factory)
        self.assertTrue(started.wait(2))
        duplicate_factory, duplicate_work = Mock(), Mock()
        duplicate = self.queue.submit('same-key', duplicate_work, trace_factory=duplicate_factory)
        self.assertEqual(first['id'], duplicate['id'])
        duplicate_factory.assert_not_called()
        release.set()
        self.assertEqual(self.queue.wait(first['id'], 2), (200, {'ok': True}))
        duplicate_work.assert_not_called()
        self.assertEqual(self.trace.created, [first['id']])
        record = self.trace.records[0]
        self.assertEqual(record['thread'], 'hrm-ai-worker')
        self.assertEqual(record['status'], 'succeeded')
        self.assertEqual(record['http_status'], 200)
        self.assertTrue(record['closed'])
        self.assertEqual(record['events'][0]['name'], 'queue_wait')
        self.assertGreaterEqual(record['events'][0]['duration_ms'], 0)
        public = self.queue.get(first['id'], include_result=True)
        self.assertNotIn('trace_context', public)
        self.assertNotIn('queued_at', public)
        self.assertIsNone(self.trace.current.get())

    def test_cancelled_pending_task_is_traced_once_without_running(self):
        work, started, release = self.blocker()
        running = self.queue.submit('blocker', work)
        self.assertTrue(started.wait(2))
        pending_work = Mock()
        pending = self.queue.submit('pending', pending_work, trace_factory=self.trace.factory)
        duplicate = self.queue.submit('pending', pending_work, trace_factory=self.trace.factory)
        self.queue.cancel(pending['id'], pending['subscription_id'])
        self.assertEqual(self.trace.records, [])
        cancelled = self.queue.cancel(duplicate['id'], duplicate['subscription_id'])
        self.assertEqual(cancelled['state'], 'cancelled')
        self.assertEqual(len(self.trace.records), 1)
        record = self.trace.records[0]
        self.assertEqual(record['status'], 'cancelled')
        self.assertEqual(record['http_status'], 409)
        self.assertTrue(record['closed'])
        self.assertEqual(record['events'][0]['name'], 'queue_wait')
        self.assertGreaterEqual(record['events'][0]['duration_ms'], 0)
        release.set()
        self.queue.wait(running['id'], 2)
        pending_work.assert_not_called()

    def test_exception_and_json_copy_failure_are_traced_without_payload(self):
        cases = [Mock(side_effect=ValueError(SECRET)),
                 lambda: (200, {'secret': SECRET, 'not_json': object()})]
        for index, work in enumerate(cases):
            task = self.queue.submit(str(index), work, trace_factory=self.trace.factory)
            status, result = self.queue.wait(task['id'], 2)
            self.assertEqual(status, 500)
            self.assertEqual(result['code'], 'ai_task_failed')
            record = self.trace.records[-1]
            self.assertEqual(record['status'], 'failed')
            self.assertEqual(record['http_status'], 500)
            errors = [item for item in record['events'] if item['name'] == 'task_error']
            self.assertEqual(errors[0]['error_type'], 'ValueError' if index == 0 else 'TypeError')
            self.assertNotIn(SECRET, json.dumps(record))

    def test_ai_pending_http_200_is_failed_in_trace_only(self):
        task = self.queue.submit('pending-result', lambda: (200, {'ai_pending': True}), trace_factory=self.trace.factory)
        self.assertEqual(self.queue.wait(task['id'], 2), (200, {'ai_pending': True}))
        self.assertEqual(self.queue.get(task['id'])['state'], 'succeeded')
        self.assertEqual(self.trace.records[0]['status'], 'failed')

    def test_factory_or_context_errors_do_not_change_task_result(self):
        class BrokenContext:
            def __init__(self, where):
                self.where = where
            def __enter__(self):
                if self.where == 'enter':
                    raise OSError('synthetic diagnostic failure')
            def __exit__(self, *args):
                raise OSError('synthetic diagnostic failure')
        factories = [Mock(side_effect=OSError('synthetic factory failure')),
                     lambda task_id: BrokenContext('enter'), lambda task_id: BrokenContext('exit')]
        for index, factory in enumerate(factories):
            work = Mock(return_value=(200, {'ok': True}))
            task = self.queue.submit('factory-' + str(index), work, trace_factory=factory)
            self.assertEqual(self.queue.wait(task['id'], 2), (200, {'ok': True}))
            work.assert_called_once()

    def test_real_worker_trace_writes_wait_http_and_end_to_end_summary(self):
        response = io.BytesIO(b'{}')
        response.status = 200
        opener = Mock(return_value=response)
        request = urllib.request.Request('https://private.invalid/' + SECRET)
        def work():
            with transport.model_request(opener, request) as received:
                return 200, json.load(received)
        with tempfile.TemporaryDirectory() as folder, patch.object(ai_tasks, 'trace', evaluation_trace):
            task = self.queue.submit('real-trace', work,
                trace_factory=lambda task_id: evaluation_trace.trace_run(folder, 'synthetic_evaluation', task_id=task_id))
            self.assertEqual(self.queue.wait(task['id'], 2), (200, {}))
            logs = list(Path(folder).rglob('*.jsonl'))
            self.assertEqual(len(logs), 1)
            content = logs[0].read_text(encoding='utf-8')
            events = [json.loads(line) for line in content.splitlines()]
            waits = [item for item in events if item['event'] == 'queue_wait']
            self.assertEqual(len(waits), 1)
            self.assertGreaterEqual(waits[0]['duration_ms'], 0)
            http = [item for item in events if item['event'] == 'stage_end' and item.get('step') == 'http_request']
            self.assertEqual(len(http), 1)
            self.assertEqual(http[0]['http_status'], 200)
            end = events[-1]
            self.assertEqual(end['event'], 'trace_end')
            self.assertEqual(end['metadata']['task_id'], task['id'])
            self.assertEqual(end['metadata']['status'], 'succeeded')
            self.assertAlmostEqual(end['end_to_end_ms'], end['total_duration_ms'] + end['queue_wait_ms'], places=2)
            self.assertEqual(len(list(Path(folder).rglob('*.summary.txt'))), 1)
            self.assertNotIn(SECRET, content)
            self.assertIsNone(evaluation_trace.current_trace())

    def test_shared_inference_records_owner_and_waiter_separately(self):
        flights = ai_tasks.InferenceFlights()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        values, errors = [], []
        def infer():
            entered.set()
            if not release.wait(5):
                raise TimeoutError('test inference expired')
            return {'ok': True}
        def run(identifier):
            try:
                with self.trace.factory(identifier):
                    values.append(flights.run('shared-input', infer))
            except BaseException as error:
                errors.append(error)
        owner = threading.Thread(target=run, args=('owner',))
        follower = threading.Thread(target=run, args=('follower',))
        try:
            owner.start()
            self.assertTrue(entered.wait(2))
            follower.start()
            with flights._condition:
                self.assertTrue(flights._condition.wait_for(
                    lambda: flights._flights['shared-input']['waiters'] == 1, 2))
        finally:
            release.set()
            owner.join(2)
            if follower.ident is not None:
                follower.join(2)
        self.assertEqual(errors, [])
        self.assertEqual(values, [{'ok': True}, {'ok': True}])
        records = {record['task_id']: record for record in self.trace.records}
        self.assertEqual(records['owner']['events'], [{'name': 'inference_shared', 'shared': False}])
        self.assertEqual(records['follower']['events'], [
            {'name': 'inference_shared', 'shared': True},
            {'name': 'shared_inference_wait', 'shared': True}])


if __name__ == '__main__':
    unittest.main()
