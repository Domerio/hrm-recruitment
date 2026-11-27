"""Bound model requests and report transport failures without leaking service data."""

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timezone
from email.utils import parsedate_to_datetime
import errno
import hashlib
import http.client
import math
import random
import re
import threading
import time
import urllib.error

import evaluation_trace as trace


DEFAULT_MODEL_TIMEOUT = 180
MAX_RATE_LIMIT_RETRIES = 2
MAX_COOLDOWN_WAIT = 60.0
MAX_COOLDOWN_KEYS = 128

_condition = threading.Condition()
_cooldowns = {}
_monotonic = time.monotonic
_wall_time = time.time


@dataclass
class _Cooldown:
    not_before: float
    probing: bool = False
    generation: int = 0


class _WaitLimit(Exception):
    pass


def _request_key(request):
    """Keep only a digest; neither request bodies nor credentials enter the registry."""
    digest = hashlib.sha256()
    digest.update(str(getattr(request, 'full_url', request)).encode('utf-8'))
    headers = getattr(request, 'header_items', lambda: [])()
    for name, value in sorted((str(name).lower(), str(value)) for name, value in headers
                              if str(name).lower() in {'authorization', 'x-api-key', 'api-key'}):
        digest.update(b'\x00')
        digest.update(name.encode('utf-8'))
        digest.update(b'\x00')
        digest.update(value.encode('utf-8'))
    return digest.digest()


def _retry_after(error):
    value = (error.headers or {}).get('Retry-After')
    if value is None:
        return None
    value = str(value).strip()
    if re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', value):
        # An enormous positive value must not accidentally become an immediate retry.
        return float(value) if len(value) < 300 else math.inf
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        return max(0.0, date.timestamp() - _wall_time())
    except (ValueError, TypeError, OverflowError, IndexError):
        return None


def _retry_delay(error, retry_index):
    backoff = min(MAX_COOLDOWN_WAIT, 2 ** retry_index + random.uniform(0, .25))
    retry_after = _retry_after(error)
    return max(backoff, retry_after) if retry_after is not None else backoff


def _publish_cooldown(key, delay):
    with _condition:
        now = _monotonic()
        # Preserve active gates and expired gates with waiting/probing callers. Idle
        # expired entries can be dropped; new keys fail closed if the registry is full.
        for old_key, state in list(_cooldowns.items()):
            if not state.probing and state.not_before + MAX_COOLDOWN_WAIT < now:
                del _cooldowns[old_key]
        state = _cooldowns.get(key)
        if state is None:
            if len(_cooldowns) >= MAX_COOLDOWN_KEYS:
                return False
            state = _cooldowns[key] = _Cooldown(now + delay)
        else:
            state.not_before = max(state.not_before, now + delay)
        state.generation += 1
        _condition.notify_all()
        return True


def _acquire_slot(key, budget):
    """After a 429 only one request probes; unrelated keys keep full concurrency."""
    with _condition:
        while True:
            state = _cooldowns.get(key)
            if state is None:
                return None
            delay = max(0.0, state.not_before - _monotonic())
            if not state.probing and delay <= 0:
                state.probing = True
                return state, state.generation
            if budget[0] <= 0 or delay > budget[0]:
                raise _WaitLimit()
            wait = delay if delay > 0 else budget[0]
            before = _monotonic()
            _condition.wait(timeout=wait)
            budget[0] = max(0.0, budget[0] - max(0.0, _monotonic() - before))


def _release_slot(key, lease, *, clear):
    if lease is None:
        return
    state, generation = lease
    with _condition:
        if _cooldowns.get(key) is state:
            state.probing = False
            # A different already-in-flight request may have extended the gate.
            if clear and state.generation == generation:
                del _cooldowns[key]
        _condition.notify_all()


def _reset_cooldowns_for_tests():
    with _condition:
        _cooldowns.clear()
        _condition.notify_all()


def _response_status(response):
    """Read numeric metadata without depending on a particular HTTP mock."""
    try:
        status = getattr(response, 'status', None)
        if type(status) is not int:
            getcode = getattr(response, 'getcode', None)
            status = getcode() if callable(getcode) else None
        return status if type(status) is int and 100 <= status <= 599 else None
    except Exception:
        return None


def _log_http_error_body(error, request, retry_index):
    # HTTP rejection bodies are needed to diagnose provider errors and 429 retries.
    # Reading/logging an error must never replace the original HTTP exception.
    if trace.current_trace() is None:
        return
    body, complete, read_error = None, True, None
    try:
        with trace.span('http_error_body_read', http_status=error.code):
            body = error.read()
    except BaseException as failure:
        complete, read_error = False, type(failure).__name__
        if isinstance(failure, http.client.IncompleteRead):
            body = failure.partial
    trace.record_payload(
        'model_http_error', body,
        secrets=getattr(request, '_evaluation_log_secrets', ()),
        call_id=getattr(request, '_evaluation_call_id', ''),
        retry_index=retry_index, http_status=error.code,
        response_complete=complete, error_type=read_error)


def _open_with_rate_limit_retry(urlopen, request, timeout):
    key = _request_key(request)
    budget = [MAX_COOLDOWN_WAIT]
    pending_error = None
    for retry_index in range(MAX_RATE_LIMIT_RETRIES + 1):
        try:
            with trace.span('rate_limit_wait', retry_index=retry_index):
                lease = _acquire_slot(key, budget)
        except _WaitLimit:
            if pending_error is not None:
                raise pending_error
            raise ModelTransportError('model_rate_limited', '模型正在限流，等待超过上限，请稍后重试。') from None
        try:
            if pending_error is not None:
                pending_error.close()
                pending_error = None
            with trace.span('http_request', attempt=retry_index + 1, timeout_seconds=timeout) as timing:
                try:
                    response = urlopen(request, timeout=timeout)
                except urllib.error.HTTPError as error:
                    timing['http_status'] = error.code
                    raise
                except BaseException as error:
                    timing['error_type'] = type(error).__name__
                    raise
                status = _response_status(response)
                if status is not None:
                    timing['http_status'] = status
        except urllib.error.HTTPError as error:
            _log_http_error_body(error, request, retry_index)
            if error.code != 429:
                _release_slot(key, lease, clear=True)
                raise
            delay = _retry_delay(error, retry_index)
            registered = _publish_cooldown(key, delay)
            _release_slot(key, lease, clear=False)
            if retry_index == MAX_RATE_LIMIT_RETRIES or delay > budget[0] or not registered:
                raise
            trace.event('rate_limit_retry', retry_index=retry_index, wait_seconds=delay, http_status=429)
            pending_error = error
        except BaseException:
            _release_slot(key, lease, clear=True)
            raise
        else:
            _release_slot(key, lease, clear=True)
            return response


class ModelTransportError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _failure(error, timeout):
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    number = getattr(reason, 'winerror', None) or getattr(reason, 'errno', None)
    # URLError can hold either the original OS exception or a terse reason string.
    timed_out = isinstance(reason, TimeoutError) or number in {errno.ETIMEDOUT, 10060}
    if isinstance(reason, str):
        timed_out = reason.strip().lower() in {'timed out', 'timeout', 'connection timed out'}
    if timed_out:
        return ModelTransportError('model_timeout', f'模型请求等待超时（等待上限 {timeout:g} 秒），请稍后重试。')
    if isinstance(reason, ConnectionRefusedError) or number in {errno.ECONNREFUSED, 10061}:
        return ModelTransportError('model_connection_refused', '模型服务拒绝连接，请检查服务是否已启动及端口是否可用。')
    interrupted = {errno.ECONNRESET, errno.ECONNABORTED, errno.EPIPE, errno.ENOTCONN, 10053, 10054, 10058}
    if isinstance(reason, (ConnectionError, http.client.IncompleteRead)) or number in interrupted:
        return ModelTransportError('model_connection_interrupted', '模型连接中断，未获得完整响应，请稍后重试。')
    return ModelTransportError('model_connection_failed', '无法连接模型服务，请检查网络和模型服务状态后重试。')


@contextmanager
def model_request(urlopen, request, timeout=DEFAULT_MODEL_TIMEOUT):
    """Wrap connection and body reads; callers still handle HTTP and JSON errors.

    urllib's timeout bounds blocking socket operations, not total response time.
    Only a rejected connection attempt with HTTP 429 is retried (at most twice).
    Cooldown waits total at most 60 seconds per call, separately from socket timeout.
    Body reads and ambiguous transport failures are never retried: an inference may
    already be running upstream. Callers still receive the final original HTTPError.
    """
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('模型请求超时须为正数秒')
    try:
        with _open_with_rate_limit_retry(urlopen, request, timeout) as response:
            yield response
    except urllib.error.HTTPError:
        raise
    except (urllib.error.URLError, OSError, http.client.IncompleteRead) as error:
        raise _failure(error, timeout) from None
