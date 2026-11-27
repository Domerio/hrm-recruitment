import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ai_tasks import (AITaskQueue, AIExecutionGate, GateBusyError, QueueFullError,
                      QueueClosedError, TaskNotFoundError, InvalidSubscriptionError, InferenceFlights)


class AITaskQueueTests(unittest.TestCase):
    def queue(self, **options):
        queue = AITaskQueue(**options)
        self.addCleanup(queue.shutdown)
        return queue

    def blocker(self, result=None):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def run():
            started.set()
            if not release.wait(5):
                raise TimeoutError('test blocker expired')
            return 200, result if result is not None else {'ok': True}
        return run, started, release

    def test_global_three_worker_limit_fifo_positions_and_exclusive_gate(self):
        queue = self.queue()
        release, three_started = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        lock, active, peak, starts = threading.Lock(), 0, 0, []
        def run(number):
            def work():
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                    starts.append(number)
                    if len(starts) == 3:
                        three_started.set()
                if not release.wait(5):
                    raise TimeoutError('test blocker expired')
                with lock:
                    active -= 1
                return 200, {'number': number}
            return work
        tasks = [queue.submit(str(i), run(i)) for i in range(5)]
        self.assertTrue(three_started.wait(2))
        states = [queue.get(task['id']) for task in tasks]
        self.assertEqual([task['state'] for task in states], ['running'] * 3 + ['queued'] * 2)
        self.assertEqual([task['position'] for task in states], [None, None, None, 1, 2])
        self.assertTrue(queue.gate.locked())
        self.assertFalse(queue.gate.acquire(blocking=False))
        release.set()
        for i, task in enumerate(tasks):
            self.assertEqual(queue.wait(task['id'], 2), (200, {'number': i}))
        self.assertEqual(peak, 3)
        self.assertTrue(queue.gate.acquire(blocking=False))
        queue.gate.release()

    def test_active_dedup_creates_independent_subscriptions_and_runs_once(self):
        queue = self.queue(max_concurrency=1)
        run, started, release = self.blocker({'saved': True})
        first = queue.submit('opaque-private-key', run, {'candidate_id': 17})
        self.assertTrue(started.wait(2))
        other_run = Mock()
        duplicate = queue.submit('opaque-private-key', other_run, {'candidate_id': 99})
        self.assertEqual(first['id'], duplicate['id'])
        self.assertNotEqual(first['subscription_id'], duplicate['subscription_id'])
        self.assertFalse(first['reused'])
        self.assertTrue(duplicate['reused'])
        self.assertEqual(duplicate['metadata'], {'candidate_id': 17})
        queue.cancel(first['id'], first['subscription_id'])
        self.assertEqual(queue.get(first['id'])['state'], 'running')
        release.set()
        self.assertEqual(queue.wait(first['id'], 2), (200, {'saved': True}))
        other_run.assert_not_called()
        fresh = queue.submit('opaque-private-key', lambda: (200, {'fresh': True}))
        self.assertNotEqual(fresh['id'], first['id'])
        self.assertFalse(fresh['reused'])
        self.assertEqual(queue.wait(fresh['id'], 2), (200, {'fresh': True}))

    def test_subscription_cancel_does_not_cancel_another_client_and_final_queued_cancel_releases(self):
        queue = self.queue(max_concurrency=1)
        run, started, release = self.blocker()
        running = queue.submit('running', run)
        self.assertTrue(started.wait(2))
        work = Mock(return_value=(200, {'ok': True}))
        first = queue.submit('queued', work)
        second = queue.submit('queued', work)
        with self.assertRaises(InvalidSubscriptionError):
            queue.cancel(first['id'], 'not-a-subscription')
        self.assertEqual(queue.cancel(first['id'], first['subscription_id'])['state'], 'queued')
        with self.assertRaises(InvalidSubscriptionError):
            queue.cancel(first['id'], first['subscription_id'])
        self.assertEqual(queue.cancel(second['id'], second['subscription_id'])['state'], 'cancelled')
        self.assertEqual(queue.wait(first['id']),
                         (409, {'code': 'ai_task_cancelled', 'error': '已取消排队任务'}))
        self.assertFalse(queue.gate.acquire(blocking=False))  # first task still owns one reservation
        release.set()
        queue.wait(running['id'], 2)
        work.assert_not_called()
        self.assertFalse(queue.gate.locked())

    def test_running_job_completes_even_when_every_subscription_is_released(self):
        queue = self.queue(max_concurrency=1)
        run, started, release = self.blocker({'saved': True})
        task = queue.submit('running', run)
        self.assertTrue(started.wait(2))
        self.assertEqual(queue.cancel(task['id'], task['subscription_id'])['state'], 'running')
        self.assertFalse(queue.gate.acquire(blocking=False))
        release.set()
        self.assertEqual(queue.wait(task['id'], 2), (200, {'saved': True}))
        self.assertEqual(queue.get(task['id'])['state'], 'succeeded')

    def test_pending_limit_rejects_new_work_but_allows_existing_subscription(self):
        queue = self.queue(max_concurrency=1, max_pending=2)
        run, started, release = self.blocker()
        running = queue.submit('running', run)
        self.assertTrue(started.wait(2))
        first = queue.submit('first', lambda: (200, {}))
        second = queue.submit('second', lambda: (200, {}))
        with self.assertRaises(QueueFullError):
            queue.submit('third', lambda: (200, {}))
        duplicate = queue.submit('second', lambda: (200, {}))
        self.assertTrue(duplicate['reused'])
        queue.cancel(first['id'], first['subscription_id'])
        replacement = queue.submit('replacement', lambda: (200, {}))
        self.assertEqual(queue.get(second['id'])['position'], 1)
        self.assertEqual(queue.get(replacement['id'])['position'], 2)
        release.set()
        for task in (running, second, replacement):
            queue.wait(task['id'], 2)
        self.assertFalse(queue.gate.locked())

    def test_idle_configuration_is_atomic_and_validates_bounds(self):
        queue = self.queue(max_concurrency=1)
        self.assertEqual(queue.configure(8)['max_concurrency'], 8)
        self.assertEqual(queue.configure(2)['max_concurrency'], 2)
        self.assertEqual(queue.max_concurrency, 2)
        for value in (0, 9, True, 1.5, '3'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                queue.configure(value)
        run, started, release = self.blocker()
        task = queue.submit('busy', run)
        self.assertTrue(started.wait(2))
        with self.assertRaises(GateBusyError):
            queue.configure(3)
        release.set()
        queue.wait(task['id'], 2)
        # Server may already hold the exclusive gate during configuration persistence.
        self.assertTrue(queue.gate.acquire(blocking=False))
        self.assertEqual(queue.configure(3)['max_concurrency'], 3)
        with self.assertRaises(GateBusyError):
            queue.submit('during-config', lambda: (200, {}))
        queue.gate.release()
        self.assertFalse(queue.gate.locked())

    def test_public_records_hide_private_inputs_keys_results_and_subscription_credentials(self):
        queue = self.queue()
        metadata = {'kind': 'evaluate', 'candidate_id': 2, 'job_id': 3, 'candidate_name': 'Synthetic',
                    'resume': 'RESUME_SECRET', 'token': 'TOKEN_SECRET', 'url': 'URL_SECRET'}
        result = {'resume': 'RESULT_SECRET', 'nested': {'x': [1]}}
        task = queue.submit('KEY_SECRET', lambda: (200, result), metadata)
        queue.wait(task['id'], 2)
        metadata['candidate_name'] = 'changed'
        public = queue.get(task['id'])
        self.assertEqual(public['metadata']['candidate_name'], 'Synthetic')
        self.assertNotIn('status', public)
        self.assertNotIn('result', public)
        self.assertNotIn('subscription_id', public)
        serialized = json.dumps(queue.list())
        for secret in ('RESUME_SECRET', 'TOKEN_SECRET', 'URL_SECRET', 'RESULT_SECRET',
                       'KEY_SECRET', task['subscription_id']):
            self.assertNotIn(secret, serialized)
        detail = queue.get(task['id'], include_result=True)
        self.assertEqual(detail['status'], 200)
        detail['result']['nested']['x'].append(2)
        result['nested']['x'].append(3)
        self.assertEqual(queue.wait(task['id'])[1]['nested']['x'], [1])

    def test_failed_calls_and_malformed_responses_release_capacity_and_hide_exception(self):
        queue = self.queue(max_concurrency=1)
        def fail():
            raise RuntimeError('TOKEN_SECRET and RESUME_SECRET')
        for key, fn in [('throws', fail), ('bad-status', lambda: (True, {})),
                        ('bad-json', lambda: (200, {'x': object()})),
                        ('bad-body', lambda: (200, []))]:
            task = queue.submit(key, fn)
            status, result = queue.wait(task['id'], 2)
            self.assertEqual(status, 500)
            self.assertEqual(queue.get(task['id'])['state'], 'failed')
            self.assertNotIn('SECRET', json.dumps(result))
            self.assertFalse(queue.gate.locked())
        limited = queue.submit('rate-limit', lambda: (429, {'error': 'quota'}))
        self.assertEqual(queue.wait(limited['id'], 2), (429, {'error': 'quota'}))
        self.assertEqual(queue.get(limited['id'])['state'], 'failed')

    def test_wait_timeout_never_cancels_running_work(self):
        queue = self.queue()
        run, started, release = self.blocker()
        task = queue.submit('wait', run)
        self.assertTrue(started.wait(2))
        with self.assertRaises(TimeoutError):
            queue.wait(task['id'], timeout=0)
        self.assertEqual(queue.get(task['id'])['state'], 'running')
        release.set()
        self.assertEqual(queue.wait(task['id'], 2), (200, {'ok': True}))

    def test_retention_is_bounded_and_releases_completed_callables(self):
        queue = self.queue(max_completed=2)
        tasks = []
        for i in range(5):
            task = queue.submit(str(i), lambda: (200, {'ok': True}))
            queue.wait(task['id'], 2)
            tasks.append(task)
        self.assertEqual(len(queue.list()), 2)
        with self.assertRaises(TaskNotFoundError):
            queue.get(tasks[0]['id'])
        self.assertEqual([task['id'] for task in queue.list()], [tasks[4]['id'], tasks[3]['id']])
        self.assertTrue(all(task['fn'] is None for task in queue._tasks.values()))

    def test_shutdown_stops_admission_and_drains_queued_and_running_work(self):
        queue = self.queue(max_concurrency=1)
        run, started, release = self.blocker()
        first = queue.submit('first', run)
        self.assertTrue(started.wait(2))
        second_fn = Mock(return_value=(200, {'second': True}))
        second = queue.submit('second', second_fn)
        queue.shutdown(wait=False)
        with self.assertRaises(QueueClosedError):
            queue.submit('late', lambda: (200, {}))
        self.assertEqual(queue.get(second['id'])['state'], 'queued')
        release.set()
        queue.shutdown()
        self.assertEqual(queue.wait(first['id']), (200, {'ok': True}))
        self.assertEqual(queue.wait(second['id']), (200, {'second': True}))
        second_fn.assert_called_once()
        self.assertFalse(queue.gate.locked())
        self.assertTrue(all(not worker.is_alive() for worker in queue._workers))

    def test_worker_start_failure_does_not_leak_gate_or_admit_a_task(self):
        queue = self.queue(max_concurrency=1)
        with patch.object(threading.Thread, 'start', side_effect=RuntimeError('start failed')):
            with self.assertRaisesRegex(RuntimeError, 'start failed'):
                queue.submit('failed-start', lambda: (200, {}))
        self.assertEqual(queue.list(), [])
        self.assertFalse(queue.gate.locked())
        task = queue.submit('after-failure', lambda: (200, {'ok': True}))
        self.assertEqual(queue.wait(task['id'], 2), (200, {'ok': True}))

    def test_new_subscriber_can_rejoin_running_job_after_previous_client_stopped_waiting(self):
        queue = self.queue(max_concurrency=1)
        run, started, release = self.blocker({'saved': True})
        first = queue.submit('running', run)
        self.assertTrue(started.wait(2))
        queue.cancel(first['id'], first['subscription_id'])
        never = Mock()
        joined = queue.submit('running', never)
        self.assertTrue(joined['reused'])
        self.assertEqual(joined['id'], first['id'])
        release.set()
        self.assertEqual(queue.wait(joined['id'], 2), (200, {'saved': True}))
        never.assert_not_called()

    def test_concurrent_duplicate_submitters_create_one_job(self):
        queue = self.queue(max_concurrency=3)
        run, started, release = self.blocker()
        called = Mock(side_effect=run)
        barrier = threading.Barrier(9)
        tasks, errors = [], []
        lock = threading.Lock()
        def submit():
            try:
                barrier.wait(2)
                task = queue.submit('same', called)
                with lock:
                    tasks.append(task)
            except BaseException as error:
                with lock:
                    errors.append(error)
        threads = [threading.Thread(target=submit) for _ in range(8)]
        for thread in threads:
            thread.start()
        barrier.wait(2)
        for thread in threads:
            thread.join(2)
        self.assertEqual(errors, [])
        self.assertEqual(len(tasks), 8)
        self.assertEqual(len({task['id'] for task in tasks}), 1)
        self.assertEqual(len({task['subscription_id'] for task in tasks}), 8)
        self.assertEqual(sum(not task['reused'] for task in tasks), 1)
        release.set()
        queue.wait(tasks[0]['id'], 2)
        called.assert_called_once()


class AIExecutionGateTests(unittest.TestCase):
    def test_shared_and_exclusive_reservations_are_mutually_exclusive(self):
        gate = AIExecutionGate()
        self.assertFalse(gate.locked())
        self.assertTrue(gate.reserve_shared())
        self.assertTrue(gate.reserve_shared())
        self.assertFalse(gate.acquire(blocking=False))
        self.assertFalse(gate.acquire(timeout=0))
        gate.release_shared()
        self.assertTrue(gate.locked())
        gate.release_shared()
        self.assertTrue(gate.acquire(blocking=False))
        self.assertFalse(gate.reserve_shared())
        self.assertFalse(gate.acquire(blocking=False))
        gate.release()
        with self.assertRaises(RuntimeError):
            gate.release()
        with self.assertRaises(RuntimeError):
            gate.release_shared()
        with gate:
            self.assertTrue(gate.locked())
        self.assertFalse(gate.locked())

    def test_blocking_exclusive_waiter_wakes_after_last_shared_reservation(self):
        gate = AIExecutionGate()
        self.assertTrue(gate.reserve_shared())
        waiting, acquired, release = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def exclusive():
            waiting.set()
            if gate.acquire(timeout=2):
                acquired.set()
                release.wait(2)
                gate.release()
        thread = threading.Thread(target=exclusive)
        thread.start()
        self.assertTrue(waiting.wait(2))
        self.assertFalse(acquired.is_set())
        gate.release_shared()
        self.assertTrue(acquired.wait(2))
        self.assertFalse(gate.reserve_shared())
        release.set()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertFalse(gate.locked())


class InferenceFlightsTests(unittest.TestCase):
    def run_shared(self, fn):
        flights = InferenceFlights()
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        outputs, errors = [], []
        lock = threading.Lock()
        def model():
            started.set()
            if not release.wait(5):
                raise TimeoutError('test blocker expired')
            return fn()
        model = Mock(side_effect=model)
        def invoke():
            try:
                value = flights.run('same-effective-request', model)
                with lock:
                    outputs.append(value)
            except BaseException as error:
                with lock:
                    errors.append(error)
        owner = threading.Thread(target=invoke)
        owner.start()
        self.assertTrue(started.wait(2))
        waiters = [threading.Thread(target=invoke) for _ in range(5)]
        for thread in waiters:
            thread.start()
        with flights._condition:
            self.assertTrue(flights._condition.wait_for(
                lambda: flights._flights['same-effective-request']['waiters'] == 5, 2))
        release.set()
        for thread in [owner, *waiters]:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(model.call_count, 1)
        self.assertEqual(flights._flights, {})
        return flights, outputs, errors

    def test_six_callers_share_one_inference_but_receive_independent_results(self):
        original = {'checks': [{'score': 75}], 'nested': [1]}
        flights, values, errors = self.run_shared(lambda: original)
        self.assertEqual(errors, [])
        self.assertEqual(len(values), 6)
        values[0]['checks'][0]['score'] = 100
        original['nested'].append(2)
        self.assertTrue(all(value['checks'][0]['score'] == 75 for value in values[1:]))
        self.assertTrue(all(value['nested'] == [1] for value in values))
        fresh = Mock(return_value={'fresh': True})
        self.assertEqual(flights.run('same-effective-request', fresh), {'fresh': True})
        fresh.assert_called_once()  # completion did not create a cache

    def test_shared_exception_preserves_custom_type_and_attributes_and_allows_retry(self):
        class SyntheticFailure(ValueError):
            def __init__(self, code, message):
                super().__init__(message)
                self.code = code
        def fail():
            raise SyntheticFailure('synthetic_timeout', 'synthetic failure')
        flights, values, errors = self.run_shared(fail)
        self.assertEqual(values, [])
        self.assertEqual(len(errors), 6)
        self.assertTrue(all(type(error) is SyntheticFailure for error in errors))
        self.assertTrue(all(error.code == 'synthetic_timeout' for error in errors))
        self.assertEqual(flights.run('same-effective-request', lambda: {'recovered': True}), {'recovered': True})

    def test_different_request_keys_can_run_concurrently(self):
        flights = InferenceFlights()
        barrier = threading.Barrier(2)
        outputs, errors = [], []
        def work(key):
            try:
                outputs.append(flights.run(key, lambda: (barrier.wait(2), key)[1]))
            except BaseException as error:
                errors.append(error)
        threads = [threading.Thread(target=work, args=(key,)) for key in ('request-a', 'request-b')]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(3)
        self.assertEqual(errors, [])
        self.assertCountEqual(outputs, ['request-a', 'request-b'])
        self.assertEqual(flights._flights, {})

    def test_same_thread_recursion_fails_without_stranding_a_flight(self):
        flights = InferenceFlights()
        with self.assertRaisesRegex(RuntimeError, 'recursive inference'):
            flights.run('recursive', lambda: flights.run('recursive', lambda: {}))
        self.assertEqual(flights._flights, {})
        self.assertEqual(flights.run('recursive', lambda: {'ok': True}), {'ok': True})


if __name__ == '__main__':
    unittest.main()
