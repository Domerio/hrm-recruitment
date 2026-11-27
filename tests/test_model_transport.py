import errno
from contextlib import ExitStack, contextmanager
from email.utils import formatdate
import http.client
import io
import json
from pathlib import Path
import socket
import sys
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model_transport import DEFAULT_MODEL_TIMEOUT, ModelTransportError, model_request
import model_transport as transport


SECRET = 'synthetic-private-request-value'


@contextmanager
def fake_waits(jitter=0):
    clock = [0.0]
    waits = []
    def wait(timeout):
        waits.append(timeout)
        clock[0] += timeout
    with ExitStack() as stack:
        stack.enter_context(patch.object(transport, '_monotonic', side_effect=lambda:clock[0]))
        stack.enter_context(patch.object(transport, '_wall_time', return_value=1_800_000_000))
        stack.enter_context(patch.object(transport._condition, 'wait', side_effect=wait))
        stack.enter_context(patch.object(transport.random, 'uniform', return_value=jitter))
        yield waits


class ModelTransportTests(unittest.TestCase):
    def setUp(self):
        transport._reset_cooldowns_for_tests()
        self.addCleanup(transport._reset_cooldowns_for_tests)
        self.request = urllib.request.Request('https://service.invalid/v1/chat/completions',
            data=b'{}', headers={'Authorization':'Bearer ' + SECRET})

    def test_success_preserves_response_and_uses_default_timeout_once(self):
        response = io.BytesIO(b'{"ok":true}')
        opener = Mock(return_value=response)
        with model_request(opener, self.request) as received:
            self.assertIs(received, response)
            self.assertEqual(json.load(received), {'ok':True})
        opener.assert_called_once_with(self.request, timeout=DEFAULT_MODEL_TIMEOUT)
        self.assertTrue(response.closed)

    def test_connection_timeout_reports_the_actual_limit_without_original_exception(self):
        for original in [TimeoutError(SECRET), urllib.error.URLError(TimeoutError(SECRET)),
                         urllib.error.URLError('timed out'), OSError(errno.ETIMEDOUT, SECRET)]:
            with self.subTest(kind=type(original).__name__):
                opener = Mock(side_effect=original)
                with self.assertRaises(ModelTransportError) as caught:
                    with model_request(opener, self.request, timeout=180):
                        self.fail('no response is expected')
                self.assertEqual(caught.exception.code, 'model_timeout')
                self.assertIn('180 秒', str(caught.exception))
                self.assertNotIn(SECRET, str(caught.exception))
                self.assertNotIn('service.invalid', str(caught.exception))
                self.assertEqual(opener.call_count, 1)

    def test_body_read_timeout_is_also_classified_and_closes_response(self):
        class SlowResponse(io.BytesIO):
            def read(self, *args):
                raise TimeoutError(SECRET)
        response = SlowResponse()
        opener = Mock(return_value=response)
        with self.assertRaises(ModelTransportError) as caught:
            with model_request(opener, self.request, timeout=240) as received:
                json.load(received)
        self.assertEqual(caught.exception.code, 'model_timeout')
        self.assertIn('240 秒', str(caught.exception))
        self.assertTrue(response.closed)
        self.assertEqual(opener.call_count, 1)

    def test_refused_connection_and_interrupted_response_are_distinct(self):
        cases = [
            (ConnectionRefusedError(errno.ECONNREFUSED, SECRET), 'model_connection_refused'),
            (urllib.error.URLError(ConnectionRefusedError(10061, SECRET)), 'model_connection_refused'),
            (ConnectionResetError(errno.ECONNRESET, SECRET), 'model_connection_interrupted'),
            (urllib.error.URLError(ConnectionAbortedError(10053, SECRET)), 'model_connection_interrupted'),
            (http.client.RemoteDisconnected(SECRET), 'model_connection_interrupted'),
            (http.client.IncompleteRead(SECRET.encode(), 120), 'model_connection_interrupted'),
        ]
        for original, code in cases:
            with self.subTest(code=code, kind=type(original).__name__):
                opener = Mock(side_effect=original)
                with self.assertRaises(ModelTransportError) as caught:
                    with model_request(opener, self.request):
                        pass
                self.assertEqual(caught.exception.code, code)
                self.assertNotIn(SECRET, str(caught.exception))
                self.assertEqual(opener.call_count, 1)

    def test_other_connection_failure_does_not_echo_dns_or_service_details(self):
        for original in [urllib.error.URLError(socket.gaierror(-2, SECRET)),
                         urllib.error.URLError(SECRET), OSError(errno.ENETUNREACH, SECRET)]:
            opener = Mock(side_effect=original)
            with self.assertRaises(ModelTransportError) as caught:
                with model_request(opener, self.request):
                    pass
            self.assertEqual(caught.exception.code, 'model_connection_failed')
            self.assertNotIn(SECRET, str(caught.exception))

    def test_http_errors_are_passed_through_without_retry(self):
        for status in [401, 500, 503]:
            error = urllib.error.HTTPError(self.request.full_url, status, SECRET, {}, io.BytesIO(SECRET.encode()))
            opener = Mock(side_effect=error)
            with self.subTest(status=status), self.assertRaises(urllib.error.HTTPError) as caught:
                with model_request(opener, self.request):
                    pass
            self.assertIs(caught.exception, error)
            opener.assert_called_once()

    def rate_limited(self, retry_after=None):
        headers = {} if retry_after is None else {'Retry-After':retry_after}
        return urllib.error.HTTPError(self.request.full_url, 429, SECRET, headers, io.BytesIO(SECRET.encode()))

    def test_only_two_429_retries_use_exponential_backoff_with_jitter(self):
        first, second = self.rate_limited(), self.rate_limited()
        response = io.BytesIO(b'{}')
        opener = Mock(side_effect=[first, second, response])
        with fake_waits(jitter=.125) as waits:
            with model_request(opener, self.request, timeout=15) as result:
                self.assertIs(result, response)
        self.assertEqual(waits, [1.125, 2.125])
        self.assertEqual(opener.call_count, 3)
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)
        self.assertTrue(response.closed)
        self.assertEqual(transport._cooldowns, {})

    def test_exhausted_retries_pass_the_final_original_429_through(self):
        errors = [self.rate_limited() for _ in range(3)]
        opener = Mock(side_effect=errors)
        with fake_waits() as waits, self.assertRaises(urllib.error.HTTPError) as caught:
            with model_request(opener, self.request):
                self.fail('all attempts were rejected')
        self.assertIs(caught.exception, errors[-1])
        self.assertEqual(opener.call_count, 3)
        self.assertEqual(waits, [1, 2])
        self.assertFalse(errors[-1].closed)
        self.assertEqual(errors[-1].read(), SECRET.encode())
        errors[-1].close()

    def test_retry_after_seconds_and_http_date_are_minimum_delays(self):
        for header, expected in [('4',4), ('0',1), ('invalid',1), ('-9',1),
            (formatdate(1_800_000_007, usegmt=True),7),
            (formatdate(1_799_999_997, usegmt=True),1)]:
            transport._reset_cooldowns_for_tests()
            opener = Mock(side_effect=[self.rate_limited(header), io.BytesIO(b'{}')])
            with self.subTest(header=header), fake_waits() as waits:
                with model_request(opener, self.request):
                    pass
                self.assertEqual(waits, [expected])
                self.assertEqual(opener.call_count, 2)

    def test_long_retry_after_never_retries_early_and_other_calls_respect_shared_gate(self):
        for header in ['61', formatdate(1_800_000_070, usegmt=True), '9' * 400]:
            transport._reset_cooldowns_for_tests()
            error = self.rate_limited(header)
            opener = Mock(side_effect=error)
            with self.subTest(header=header[:30]), fake_waits() as waits:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    with model_request(opener, self.request):
                        pass
                self.assertIs(caught.exception, error)
                opener.assert_called_once()
                self.assertEqual(waits, [])
                later = Mock()
                with self.assertRaises(ModelTransportError) as local:
                    with model_request(later, self.request):
                        pass
                self.assertEqual(local.exception.code, 'model_rate_limited')
                self.assertNotIn(SECRET, str(local.exception))
                later.assert_not_called()
                self.assertEqual(waits, [])
                self.assertFalse(error.closed)
                error.close()

    def test_wait_budget_is_sixty_seconds_total_not_per_attempt(self):
        first, second = self.rate_limited('40'), self.rate_limited('40')
        opener = Mock(side_effect=[first, second])
        with fake_waits() as waits, self.assertRaises(urllib.error.HTTPError) as caught:
            with model_request(opener, self.request):
                pass
        self.assertIs(caught.exception, second)
        self.assertEqual(waits, [40])
        self.assertEqual(opener.call_count, 2)
        second.close()

    def test_http_429_after_yield_is_not_replayed(self):
        error = self.rate_limited()
        response = io.BytesIO(b'{}')
        opener = Mock(return_value=response)
        with fake_waits() as waits, self.assertRaises(urllib.error.HTTPError) as caught:
            with model_request(opener, self.request):
                raise error
        self.assertIs(caught.exception, error)
        self.assertEqual(waits, [])
        opener.assert_called_once()
        self.assertTrue(response.closed)
        self.assertEqual(transport._cooldowns, {})
        error.close()

    def test_retry_followed_by_timeout_does_not_retry_ambiguous_result(self):
        opener = Mock(side_effect=[self.rate_limited(), TimeoutError(SECRET)])
        with fake_waits() as waits, self.assertRaises(ModelTransportError) as caught:
            with model_request(opener, self.request):
                pass
        self.assertEqual(caught.exception.code, 'model_timeout')
        self.assertEqual(opener.call_count, 2)
        self.assertEqual(waits, [1])
        self.assertEqual(transport._cooldowns, {})

    def test_registry_is_bounded_and_does_not_store_raw_url_or_authentication(self):
        with fake_waits(), patch.object(transport, 'MAX_COOLDOWN_KEYS', 2):
            for suffix in ['one', 'two', 'three']:
                request = urllib.request.Request(f'https://service.invalid/{suffix}',
                    headers={'Authorization':'Bearer ' + SECRET})
                error = self.rate_limited('70')
                opener = Mock(side_effect=error)
                with self.assertRaises(urllib.error.HTTPError):
                    with model_request(opener, request):
                        pass
                opener.assert_called_once()
                error.close()
            self.assertEqual(len(transport._cooldowns), 2)
            self.assertTrue(all(isinstance(key, bytes) and len(key) == 32 for key in transport._cooldowns))
            self.assertNotIn(SECRET, repr(transport._cooldowns))
            self.assertNotIn('service.invalid', repr(transport._cooldowns))

    def test_same_key_allows_one_probe_while_different_credentials_are_not_blocked(self):
        probe_entered = threading.Event()
        release_probe = threading.Event()
        both_waiting = threading.Event()
        observed_waiters = set()
        lock = threading.Lock()
        calls, errors, completed = [], [], []
        original_wait = transport._condition.wait
        def observed_wait(timeout):
            name = threading.current_thread().name
            if name.startswith('cooldown-waiter'):
                observed_waiters.add(name)
                if len(observed_waiters) == 2:
                    both_waiting.set()
            return original_wait(timeout)
        def opener(request, timeout):
            with lock:
                calls.append(request)
                count = sum(item is self.request for item in calls)
            if request is self.request and count == 1:
                raise self.rate_limited()
            if request is self.request and count == 2:
                probe_entered.set()
                if not release_probe.wait(2):
                    raise AssertionError('probe not released')
            return io.BytesIO(b'{}')
        def run(name, request):
            try:
                with model_request(opener, request):
                    completed.append(name)
            except BaseException as error:
                errors.append(error)
        threads = [threading.Thread(target=run, args=('seed', self.request), name='cooldown-seed')]
        with patch.object(transport, '_retry_delay', return_value=.01), \
             patch.object(transport._condition, 'wait', side_effect=observed_wait):
            try:
                threads[0].start()
                self.assertTrue(probe_entered.wait(1))
                for index in range(2):
                    thread = threading.Thread(target=run, args=(f'waiter{index}', self.request), name=f'cooldown-waiter{index}')
                    threads.append(thread)
                    thread.start()
                self.assertTrue(both_waiting.wait(1))
                self.assertEqual(len(calls), 2)
                other = urllib.request.Request(self.request.full_url, headers={'Authorization':'Bearer different-key'})
                run('other', other)
                self.assertEqual(completed, ['other'])
                self.assertEqual(len(calls), 3)
            finally:
                release_probe.set()
                for thread in threads:
                    thread.join(2)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertCountEqual(completed, ['seed','waiter0','waiter1','other'])
        self.assertEqual(len(calls), 5)
        self.assertEqual(transport._cooldowns, {})

    def test_json_and_application_validation_errors_are_not_reclassified(self):
        with self.assertRaises(json.JSONDecodeError):
            with model_request(Mock(return_value=io.BytesIO(b'not JSON')), self.request) as response:
                json.load(response)
        error = ValueError('synthetic validation failure')
        with self.assertRaises(ValueError) as caught:
            with model_request(Mock(return_value=io.BytesIO(b'{}')), self.request):
                raise error
        self.assertIs(caught.exception, error)

    def test_invalid_timeout_never_opens_connection(self):
        for value in [True, 0, -1, '180', float('nan'), float('inf')]:
            opener = Mock()
            with self.subTest(value=value), self.assertRaises(ValueError):
                with model_request(opener, self.request, timeout=value):
                    pass
            opener.assert_not_called()


if __name__ == '__main__':
    unittest.main()
