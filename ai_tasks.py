"""Bounded in-process AI work queue. No model calls or private request logging here."""
from collections import deque
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import secrets
import sys
import threading
import time
import uuid

import evaluation_trace as trace


class GateBusyError(ValueError):
    pass


class QueueFullError(ValueError):
    pass


class QueueClosedError(ValueError):
    pass


class TaskNotFoundError(ValueError):
    pass


class InvalidSubscriptionError(ValueError):
    pass


class AIExecutionGate:
    """Exclusive legacy Lock interface plus shared reservations for admitted jobs."""
    def __init__(self):
        self._condition = threading.Condition()
        self._exclusive = False
        self._shared = 0

    def acquire(self, blocking=True, timeout=-1):
        if not blocking and timeout != -1:
            raise ValueError('cannot specify a timeout for a non-blocking call')
        if timeout != -1 and (not isinstance(timeout, (int, float)) or
                              not math.isfinite(timeout) or timeout < 0):
            raise ValueError('invalid timeout')
        with self._condition:
            ready = lambda: not self._exclusive and self._shared == 0
            if not blocking:
                if not ready():
                    return False
            elif not self._condition.wait_for(ready, None if timeout == -1 else timeout):
                return False
            self._exclusive = True
            return True

    def release(self):
        with self._condition:
            if not self._exclusive:
                raise RuntimeError('release unlocked exclusive gate')
            self._exclusive = False
            self._condition.notify_all()

    def locked(self):
        with self._condition:
            return self._exclusive or self._shared > 0

    def reserve_shared(self):
        with self._condition:
            if self._exclusive:
                return False
            self._shared += 1
            return True

    def release_shared(self):
        with self._condition:
            if self._shared <= 0:
                raise RuntimeError('release unreserved shared gate')
            self._shared -= 1
            self._condition.notify_all()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *args):
        self.release()


def _integer(value, minimum, maximum, label):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f'{label} must be between {minimum} and {maximum}')
    return value


def _timestamp():
    return datetime.now(timezone.utc).isoformat()


def _metadata(value):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError('task metadata must be an object')
    result = {}
    # Do not persist arbitrary metadata, URLs, credentials, task keys or resume text.
    for key in ('candidate_id', 'job_id'):
        if type(value.get(key)) is int and value[key] > 0:
            result[key] = value[key]
    for key, limit in (('kind', 60), ('candidate_name', 150), ('job_title', 160)):
        if isinstance(value.get(key), str):
            result[key] = ''.join(c for c in value[key] if c.isprintable()).strip()[:limit]
    return result


@contextmanager
def _task_trace(context):
    """Diagnostic context failures must never change the business result."""
    if context is None:
        yield
        return
    try:
        context.__enter__()
    except Exception:
        yield
        return
    try:
        yield
    finally:
        try:
            context.__exit__(*sys.exc_info())
        except Exception:
            pass


class AITaskQueue:
    def __init__(self, max_concurrency=3, max_pending=100, max_completed=200, gate=None):
        self._max_concurrency = _integer(max_concurrency, 1, 8, 'max_concurrency')
        self._max_pending = _integer(max_pending, 1, 10000, 'max_pending')
        self._max_completed = _integer(max_completed, 1, 10000, 'max_completed')
        self.gate = gate if gate is not None else AIExecutionGate()
        self._condition = threading.Condition()
        self._tasks = {}
        self._active_keys = {}
        self._pending = deque()
        self._completed = deque()
        self._workers = []
        self._running = 0
        self._closing = False

    @property
    def max_concurrency(self):
        with self._condition:
            return self._max_concurrency

    def _record(self, task, include_result=False):
        record = {key: deepcopy(task[key]) for key in
                  ('id', 'state', 'created_at', 'started_at', 'finished_at', 'metadata')}
        record['position'] = self._pending.index(task['id']) + 1 if task['state'] == 'queued' else None
        if include_result:
            record['status'] = task['status']
            record['result'] = deepcopy(task['result'])
        return record

    def _lookup(self, task_id):
        if not isinstance(task_id, str) or task_id not in self._tasks:
            raise TaskNotFoundError('AI task not found or no longer retained')
        return self._tasks[task_id]

    def _spawn_workers(self):
        while len(self._workers) < self._max_concurrency:
            worker = threading.Thread(target=self._worker, name='hrm-ai-worker', daemon=True)
            self._workers.append(worker)
            try:
                worker.start()
            except BaseException:
                self._workers.pop()
                raise

    def submit(self, key, fn, metadata=None, *, trace_factory=None):
        if not isinstance(key, str) or not 1 <= len(key) <= 512:
            raise ValueError('task key must be a nonempty opaque string of at most 512 characters')
        if not callable(fn):
            raise ValueError('task function must be callable')
        public_metadata = _metadata(metadata)
        with self._condition:
            if self._closing:
                raise QueueClosedError('AI queue is shutting down')
            existing = self._active_keys.get(key)
            if existing is not None:
                task = self._tasks[existing]
                subscription = secrets.token_urlsafe(24)
                task['subscriptions'].add(subscription)
                return {**self._record(task), 'subscription_id': subscription, 'reused': True}
            if len(self._pending) >= self._max_pending:
                raise QueueFullError('AI waiting queue is full')
            if not self.gate.reserve_shared():
                raise GateBusyError('AI configuration or maintenance is in progress')
            try:
                self._spawn_workers()
                subscription = secrets.token_urlsafe(24)
                task = {'id': uuid.uuid4().hex, 'key': key, 'fn': fn, 'state': 'queued',
                        'created_at': _timestamp(), 'started_at': None, 'finished_at': None,
                        'metadata': public_metadata, 'status': None, 'result': None,
                        'subscriptions': {subscription}, 'queued_at': time.perf_counter(),
                        'trace_context': None}
                if trace_factory is not None:
                    try:
                        task['trace_context'] = trace_factory(task['id'])
                    except Exception:
                        pass
                self._tasks[task['id']] = task
                self._active_keys[key] = task['id']
                self._pending.append(task['id'])
                record = {**self._record(task), 'subscription_id': subscription, 'reused': False}
            except BaseException:
                self.gate.release_shared()
                raise
            self._condition.notify_all()
            return record

    def _finish(self, task, state, status, result):
        task.update(state=state, status=status, result=result, finished_at=_timestamp(), fn=None)
        self._active_keys.pop(task['key'], None)
        task['key'] = None
        self._completed.append(task['id'])
        self.gate.release_shared()
        while len(self._completed) > self._max_completed:
            self._tasks.pop(self._completed.popleft(), None)
        self._condition.notify_all()

    def _worker(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: (self._pending and self._running < self._max_concurrency)
                                         or (self._closing and not self._pending))
                if self._closing and not self._pending:
                    return
                task = self._tasks[self._pending.popleft()]
                task.update(state='running', started_at=_timestamp())
                queue_wait_ms = max(0.0, (time.perf_counter() - task['queued_at']) * 1000)
                trace_context = task.pop('trace_context', None)
                self._running += 1
                self._condition.notify_all()
            with _task_trace(trace_context):
                trace.event('queue_wait', duration_ms=queue_wait_ms)
                try:
                    status, result = task['fn']()
                    if type(status) is not int or not 100 <= status <= 599 or not isinstance(result, dict):
                        raise ValueError('invalid task response')
                    # Detach the result from the callable, retaining JSON data only.
                    result = json.loads(json.dumps(result, ensure_ascii=False, allow_nan=False))
                except BaseException as error:
                    trace.event('task_error', error_type=type(error).__name__)
                    status, result = 500, {'code': 'ai_task_failed', 'error': 'AI 任务处理失败，请稍后重试'}
                failed = status >= 400 or bool(result.get('ai_pending'))
                trace.annotate(status='failed' if failed else 'succeeded', http_status=status)
            with self._condition:
                self._running -= 1
                self._finish(task, 'succeeded' if status < 400 else 'failed', status, result)

    def get(self, task_id, include_result=False):
        with self._condition:
            return self._record(self._lookup(task_id), include_result)

    def list(self, limit=50, include_result=False):
        _integer(limit, 1, 10000, 'limit')
        with self._condition:
            return [self._record(task, include_result) for task in
                    list(self._tasks.values())[-limit:][::-1]]

    def wait(self, task_id, timeout=None):
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                                    or not math.isfinite(timeout) or timeout < 0):
            raise ValueError('timeout must be a nonnegative number or None')
        with self._condition:
            task = self._lookup(task_id)
            # Keep this reference while waiting even if retention later evicts the public record.
            if not self._condition.wait_for(lambda: task['state'] not in ('queued', 'running'), timeout):
                raise TimeoutError('AI task is not finished')
            return task['status'], deepcopy(task['result'])

    def cancel(self, task_id, subscription_id):
        cancelled = False
        with self._condition:
            task = self._lookup(task_id)
            if not isinstance(subscription_id, str) or subscription_id not in task['subscriptions']:
                raise InvalidSubscriptionError('invalid or already released AI task subscription')
            task['subscriptions'].remove(subscription_id)
            if task['state'] == 'queued' and not task['subscriptions']:
                self._pending.remove(task_id)
                trace_context = task.pop('trace_context', None)
                queue_wait_ms = max(0.0, (time.perf_counter() - task['queued_at']) * 1000)
                self._finish(task, 'cancelled', 409,
                             {'code': 'ai_task_cancelled', 'error': '已取消排队任务'})
                cancelled = True
            record = self._record(task)
        if cancelled:
            with _task_trace(trace_context):
                trace.event('queue_wait', duration_ms=queue_wait_ms)
                trace.annotate(status='cancelled', http_status=409)
        return record

    def configure(self, max_concurrency):
        _integer(max_concurrency, 1, 8, 'max_concurrency')
        with self._condition:
            if self._closing:
                raise QueueClosedError('AI queue is shutting down')
            if self._pending or self._running:
                raise GateBusyError('AI queue must be idle before changing concurrency')
            self._max_concurrency = max_concurrency
            return {'max_concurrency': self._max_concurrency, 'max_pending': self._max_pending,
                    'max_completed': self._max_completed}

    def shutdown(self, wait=True):
        # Joining from a worker could deadlock a one-worker queue with pending jobs.
        if wait and threading.current_thread() in self._workers:
            raise RuntimeError('cannot wait for AI queue shutdown from its worker')
        with self._condition:
            self._closing = True
            self._condition.notify_all()
            workers = list(self._workers)
        if wait:
            for worker in workers:
                worker.join()


class InferenceFlights:
    """Share only an in-flight inference; callers retain their own persistence flow.

    Keys must describe the complete effective model request and configuration.
    Completed values and failures are removed immediately, never used as a cache.
    """
    def __init__(self):
        self._condition = threading.Condition()
        self._flights = {}

    def run(self, key, fn):
        if not isinstance(key, str) or not 1 <= len(key) <= 512:
            raise ValueError('inference key must be a nonempty opaque string of at most 512 characters')
        if not callable(fn):
            raise ValueError('inference function must be callable')
        with self._condition:
            flight = self._flights.get(key)
            owner = flight is None
            if owner:
                flight = {'event': threading.Event(), 'owner': threading.get_ident(),
                          'waiters': 0, 'result': None, 'error': None}
                self._flights[key] = flight
            else:
                if flight['owner'] == threading.get_ident():
                    raise RuntimeError('recursive inference with the same key would deadlock')
                flight['waiters'] += 1
                self._condition.notify_all()
        trace.event('inference_shared', shared=not owner)
        if not owner:
            with trace.span('shared_inference_wait', shared=True):
                flight['event'].wait()
            if flight['error'] is not None:
                # Preserve custom exception type and attributes; many application
                # exceptions cannot be reconstructed from Exception.args alone.
                raise flight['error']
            return deepcopy(flight['result'])
        try:
            result = deepcopy(fn())
        except BaseException as error:
            with self._condition:
                flight['error'] = error
                self._flights.pop(key, None)
                flight['event'].set()
                self._condition.notify_all()
            raise
        else:
            with self._condition:
                flight['result'] = result
                self._flights.pop(key, None)
                flight['event'].set()
                self._condition.notify_all()
            return deepcopy(result)
