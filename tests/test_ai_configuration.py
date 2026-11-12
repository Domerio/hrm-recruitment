import io
import json
import os
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_configuration as configuration
import server


SECRET = 'synthetic-ENV-credential-DO-NOT-RETURN'
ROTATED = 'synthetic-NEW-credential-DO-NOT-RETURN'
BASE = 'https://synthetic.invalid/v1'


def response(content):
    return io.BytesIO(json.dumps({'choices': [{'message': {'content': json.dumps(content)}}]}).encode())


class AIConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'ai-config.json'
        for target, name, value in [
            (server, 'DB', self.path.parent / 'test.sqlite'),
            (server, 'EXTENSION_FILE', self.path.parent / 'extension.json'),
        ]:
            patcher = patch.object(target, name, value)
            patcher.start(); self.addCleanup(patcher.stop)
        environment = patch.dict(os.environ, {
            'AI_MODEL': 'synthetic-model', 'AI_BASE_URL': BASE, 'DEEPSEEK_API_KEY': SECRET,
        })
        environment.start(); self.addCleanup(environment.stop)
        for target in (server, configuration):
            guard = patch.object(target, 'model_urlopen', side_effect=AssertionError('Unexpected outbound model request'))
            guard.start(); self.addCleanup(guard.stop)
        server.init_db()

    def values(self, **changes):
        current = configuration.load_config(self.path)
        return {**{key: current[key] for key in ('provider', 'base_url', 'model', 'revision')},
                'api_key': '', **changes}

    def request(self, path, data=None, expected=200):
        replies = []
        handler = server.Handler.__new__(server.Handler)
        handler.permitted = lambda: True
        handler.path = path
        handler.send = lambda status, body, *args, **kwargs: replies.append((status, body))
        if data is None:
            handler.do_GET()
        else:
            encoded = json.dumps(data).encode()
            handler.headers = {'X-App-Token': server.TOKEN, 'Content-Length': str(len(encoded))}
            handler.rfile = io.BytesIO(encoded)
            handler.do_POST()
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0][0], expected)
        return replies[0][1]

    def assert_private(self, value):
        serialized = json.dumps(value)
        self.assertNotIn(SECRET, serialized)
        self.assertNotIn(ROTATED, serialized)

    def test_environment_save_preserves_key_without_mutating_environment_or_env_file(self):
        env_file = self.path.parent / '.env'
        env_file.write_text('synthetic-env-file-is-unchanged\n', encoding='utf8')
        before = {key: os.environ[key] for key in ('AI_MODEL', 'AI_BASE_URL', 'DEEPSEEK_API_KEY')}
        original = configuration.load_config(self.path)
        self.assertEqual((original['source'], original['revision'], original['api_key']), ('environment', 0, SECRET))
        saved, changed = configuration.save_config(self.path, self.values())
        self.assertFalse(changed)  # Persisting the same effective configuration is not a model change.
        self.assertEqual((saved['source'], saved['revision'], saved['api_key']), ('saved', 1, SECRET))
        self.assertEqual(configuration.load_config(self.path)['api_key'], SECRET)
        self.assertEqual({key: os.environ[key] for key in before}, before)
        self.assertEqual(env_file.read_text('utf8'), 'synthetic-env-file-is-unchanged\n')

    def test_explicit_clear_never_resurrects_environment_key(self):
        configuration.save_config(self.path, self.values())
        cleared, changed = configuration.save_config(self.path, self.values(clear_key=True))
        self.assertTrue(changed)
        self.assertEqual(cleared['api_key'], '')
        with patch.dict(os.environ, {'DEEPSEEK_API_KEY': ROTATED}):
            self.assertEqual(configuration.load_config(self.path)['api_key'], '')
            same, changed = configuration.save_config(self.path, self.values())
        self.assertFalse(changed)
        self.assertEqual(same['api_key'], '')
        self.assertFalse(configuration.safe_config(self.path)['has_key'])

    def test_endpoint_and_provider_changes_clear_old_key_unless_a_new_one_is_entered(self):
        configuration.save_config(self.path, self.values())
        moved, _ = configuration.save_config(self.path, self.values(base_url='http://127.0.0.1:8123/v1'))
        self.assertEqual(moved['api_key'], '')
        self.assertEqual(configuration.load_config(self.path)['api_key'], '')
        entered, _ = configuration.save_config(self.path, self.values(api_key=ROTATED))
        self.assertEqual(entered['api_key'], ROTATED)
        changed, _ = configuration.save_config(self.path, self.values(provider='openai-compatible'))
        self.assertEqual(changed['api_key'], '')
        entered, _ = configuration.save_config(self.path, self.values(base_url=BASE, api_key=ROTATED))
        self.assertEqual(entered['api_key'], ROTATED)

    def test_atomic_replace_failure_retains_file_revision_and_removes_temporary_file(self):
        configuration.save_config(self.path, self.values())
        original = self.path.read_bytes()
        with patch.object(configuration.os, 'replace', side_effect=PermissionError('synthetic failure')):
            with self.assertRaises(ValueError) as error:
                configuration.save_config(self.path, self.values(api_key=ROTATED))
        self.assert_private(str(error.exception))
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.path.parent.glob('.ai-config-*.json')), [])

    def test_stale_revision_and_invalid_key_do_not_partially_save(self):
        stale = self.values()
        configuration.save_config(self.path, stale)
        original = self.path.read_bytes()
        self.request('/api/ai/config', {**stale, 'model': 'stale-model'}, expected=409)
        for invalid in [True, '1']:
            with self.subTest(revision=invalid):
                with self.assertRaises(configuration.ConfigurationConflict):
                    configuration.save_config(self.path, self.values(revision=invalid))
        self.request('/api/ai/config', self.values(api_key='invalid\r\nheader'), expected=400)
        self.assertEqual(self.path.read_bytes(), original)

    def test_configuration_and_state_never_return_secret_or_serve_private_file(self):
        saved = self.request('/api/ai/config', self.values(api_key=ROTATED))
        self.assert_private(saved)
        public = self.request('/api/ai/config')
        self.assertNotIn('api_key', public)
        self.assertTrue(public['has_key'])
        self.assert_private(public)
        self.assert_private(self.request('/api/state'))
        self.request('/data/ai-config.json', expected=404)
        self.request('/ai-config.json', expected=404)

    def test_no_key_internal_model_is_configured_and_omits_bearer_header(self):
        saved = self.request('/api/ai/config', self.values(provider='openai-compatible',
            base_url='http://127.0.0.1:8123/v1/chat/completions', clear_key=True))
        self.assertTrue(saved['config']['configured'])
        self.assertFalse(saved['config']['has_key'])
        self.assertTrue(self.request('/api/state')['configured'])
        with patch.object(server, 'model_urlopen', return_value=response({'ok': True})) as network:
            result = self.request('/api/ai/test', {'base_url': 'https://unsaved.invalid', 'api_key': SECRET})
        self.assertEqual(result, {'ok': True})
        request = network.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:8123/v1/chat/completions')
        self.assertNotIn('Authorization', dict(request.header_items()))
        body = json.loads(request.data)
        self.assertEqual((body['model'], body['temperature'], body['max_tokens']), ('synthetic-model', 0, 6000))

    def test_models_only_return_ids_and_ignore_unsaved_address(self):
        payload = {'data': [{'id': 'synthetic-model', 'owner': SECRET}, {'id': 'synthetic-model'},
                            {'id': SECRET}, {'id': None}, {'id': 'second-model'}], 'debug': SECRET}
        with patch.object(configuration, 'model_urlopen', return_value=io.BytesIO(json.dumps(payload).encode())) as network:
            result = self.request('/api/ai/models', {'base_url': 'https://unsaved.invalid', 'api_key': ROTATED})
        self.assertEqual(result, {'models': [{'id': 'synthetic-model'}, {'id': 'second-model'}]})
        self.assertEqual(network.call_args.args[0].full_url, BASE + '/models')
        self.assert_private(result)

    def test_upstream_errors_and_malformed_test_output_do_not_echo_body(self):
        for target, endpoint in [(configuration, '/api/ai/models'), (server, '/api/ai/test')]:
            with self.subTest(endpoint=endpoint):
                error = urllib.error.HTTPError(BASE, 401, SECRET, {'Location': ROTATED}, io.BytesIO(SECRET.encode()))
                with patch.object(target, 'model_urlopen', side_effect=error):
                    result = self.request(endpoint, {}, expected=400)
                self.assert_private(result)
                self.assertIn('401', result['error'])
        with patch.object(server, 'model_urlopen', return_value=response({'ok': 'true', 'debug': SECRET})):
            self.assert_private(self.request('/api/ai/test', {}, expected=400))

    def test_config_save_respects_ai_lock_and_does_not_create_file(self):
        self.assertTrue(server.AI_LOCK.acquire(blocking=False))
        try:
            result = self.request('/api/ai/config', self.values(api_key=ROTATED), expected=409)
        finally:
            server.AI_LOCK.release()
        self.assert_private(result)
        self.assertFalse(self.path.exists())

    def test_effective_config_and_key_rotation_change_fingerprint_but_storage_alone_does_not(self):
        job = {'jd': 'QA', 'criteria': 'QA', 'must_have': '', 'priority_groups': [['QA']]}
        candidate = {'job_id': 1, 'resume': '合成测试履历'}
        fingerprint = lambda: server.evaluation_fingerprint(job, candidate, {}, date(2026, 11, 11))
        original = fingerprint()
        configuration.save_config(self.path, self.values())
        self.assertEqual(fingerprint(), original)
        configuration.save_config(self.path, self.values(api_key=ROTATED))
        rotated = fingerprint()
        self.assertNotEqual(rotated, original)
        configuration.save_config(self.path, self.values(model='synthetic-model-v2'))
        self.assertNotEqual(fingerprint(), rotated)
        self.assert_private([original, rotated])

    def test_url_suffix_normalization_and_unsafe_parts(self):
        for original, canonical in [(BASE + '/chat/completions/', BASE), (BASE + '/models', BASE),
                                    ('http://192.168.1.8:8000/v1/models', 'http://192.168.1.8:8000/v1'),
                                    ('http://[::1]:8123/v1', 'http://[::1]:8123/v1')]:
            self.assertEqual(configuration.canonical_base_url(original), canonical)
        for invalid in ['https://user:pass@synthetic.invalid', BASE + '?key=x', BASE + '#fragment',
                        BASE + '/a b', BASE + '\\path', BASE + '/%0d%0a', BASE + '/%00',
                        BASE + '\n', 'file:///tmp/model', 'https://synthetic.invalid:99999']:
            with self.subTest(value=invalid):
                with self.assertRaises(ValueError):
                    configuration.canonical_base_url(invalid)


class AIConfigurationRedirectTests(unittest.TestCase):
    def test_model_opener_never_follows_redirect_or_forwards_authorization(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                received.append((self.path, self.headers.get('Authorization')))
                self.send_response(302)
                self.send_header('Location', f'http://localhost:{self.server.server_port}/credential-sink')
                self.end_headers()
        http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{http.server_port}/redirect',
                headers={'Authorization': 'Bearer ' + SECRET})
            with patch.object(urllib.request, 'getproxies', return_value={}):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    configuration.model_urlopen(request, timeout=3)
            self.assertEqual(error.exception.code, 302)
            self.assertEqual(received, [('/redirect', 'Bearer ' + SECRET)])
        finally:
            http.shutdown(); http.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
