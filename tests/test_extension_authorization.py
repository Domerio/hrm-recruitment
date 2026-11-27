import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from extension_authorization import extension_ids, pair_extension, revoke_extension


class ExtensionAuthorizationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'extension.json'

    def test_legacy_id_additive_pairing_targeted_revoke_and_revoke_all(self):
        first, second = 'a' * 32, 'b' * 32
        self.path.write_text(json.dumps({'id':first}), encoding='utf-8')
        self.assertEqual(extension_ids(self.path), [first])
        self.assertEqual(pair_extension(self.path, second), [first, second])
        self.assertEqual(pair_extension(self.path, first), [first, second])
        self.assertEqual(json.loads(self.path.read_text())['id'], first)
        self.assertEqual(revoke_extension(self.path, first), [second])
        self.assertEqual(json.loads(self.path.read_text())['id'], second)
        self.assertEqual(revoke_extension(self.path), [])

    def test_invalid_or_corrupt_ids_fail_closed(self):
        self.path.write_text('{invalid json', encoding='utf-8')
        self.assertEqual(extension_ids(self.path), [])
        self.path.write_text(json.dumps({'id':'invalid','ids':['a'*32,'https://other','a'*32,{}]}), encoding='utf-8')
        self.assertEqual(extension_ids(self.path), ['a' * 32])
        for invalid in ('z' * 32, 'a' * 31, '', 'chrome-extension://' + 'a'*32):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                pair_extension(self.path, invalid)
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                revoke_extension(self.path, invalid)

    def test_concurrent_authorizations_keep_all_ids(self):
        identifiers = [chr(ord('a') + index) * 32 for index in range(8)]
        barrier = threading.Barrier(len(identifiers))
        errors = []
        def pair(identifier):
            try:
                barrier.wait(timeout=5)
                pair_extension(self.path, identifier)
            except BaseException as error:
                errors.append(error)
        threads = [threading.Thread(target=pair, args=(identifier,)) for identifier in identifiers]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(set(extension_ids(self.path)), set(identifiers))
        self.assertEqual(list(self.path.parent.glob('.extension-*')), [])


class ExtensionAuthorizationHttpTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for name, value in [('DB', root / 'test.sqlite'), ('EXTENSION_FILE', root / 'extension.json')]:
            active = patch.object(server, name, value)
            active.start()
            self.addCleanup(active.stop)
        server.init_db()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=lambda:self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.origin = 'http://127.0.0.1:' + str(self.http.server_port)

    def stop(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=5)

    def request(self, path, *, data=None, origin=None, token=None, method=None):
        headers = {}
        if origin is not None:
            headers['Origin'] = origin
        if token is not None:
            headers['X-App-Token'] = token
        if data is not None:
            headers['Content-Type'] = 'application/json'
        connection = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=5)
        try:
            connection.request(method or ('POST' if data is not None else 'GET'), path,
                               body=json.dumps(data) if data is not None else None, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            connection.close()

    def pair(self, identifier, origin=None):
        return self.request('/api/extension/pair', data={'id':identifier}, origin=origin, token=server.TOKEN)

    def test_each_authorized_extension_gets_its_own_cors_and_session(self):
        identifiers = ['a' * 32, 'b' * 32]
        self.assertEqual(self.pair(identifiers[0], self.origin)[0], 200)
        self.assertEqual(self.pair(identifiers[1])[0], 200)
        status, _, state = self.request('/api/state')
        self.assertEqual(status, 200)
        self.assertEqual(state['extension_ids'], identifiers)
        self.assertEqual(state['extension_id'], identifiers[0])
        for identifier in identifiers:
            origin = 'chrome-extension://' + identifier
            status, headers, state = self.request('/api/state', origin=origin)
            self.assertEqual(status, 200)
            self.assertEqual(headers['Access-Control-Allow-Origin'], origin)
            self.assertEqual(state['extension_id'], identifier)
            for data in (None, {}):
                status, headers, session = self.request('/api/extension/favorite-session', data=data, origin=origin)
                self.assertEqual(status, 200)
                self.assertEqual(session['extension_id'], identifier)
                self.assertEqual(session['token'], server.TOKEN)
                self.assertEqual(headers['Access-Control-Allow-Origin'], origin)
            self.assertEqual(self.request('/api/extension/favorite-session', origin=origin, method='OPTIONS')[0], 200)

    def test_origin_and_token_checks_prevent_self_authorization_or_cross_site_pairing(self):
        self.assertEqual(self.pair('a' * 32, self.origin)[0], 200)
        for origin in ('chrome-extension://' + 'a'*32, 'chrome-extension://' + 'b'*32, 'https://attacker.invalid'):
            for path in ('/api/extension/pair', '/api/extension/revoke'):
                self.assertEqual(self.request(path, data={'id':'b'*32}, origin=origin, token=server.TOKEN)[0], 403)
        for origin in (None, self.origin):
            self.assertEqual(self.request('/api/extension/pair', data={'id':'b'*32}, origin=origin, token='invalid')[0], 403)
        self.assertEqual(server.extension_ids(), ['a' * 32])
        for origin in ('chrome-extension://' + 'b'*32, self.origin, None):
            self.assertEqual(self.request('/api/extension/favorite-session', data={}, origin=origin)[0], 403)

    def test_targeted_revoke_keeps_other_computer_authorized_and_legacy_file_works(self):
        first, second = 'a' * 32, 'b' * 32
        server.EXTENSION_FILE.write_text(json.dumps({'id':first}), encoding='utf-8')
        self.assertEqual(self.request('/api/state', origin='chrome-extension://' + first)[0], 200)
        self.assertEqual(self.pair(second, self.origin)[0], 200)
        self.assertEqual(self.request('/api/extension/revoke', data={'id':first}, origin=self.origin, token=server.TOKEN)[0], 200)
        self.assertEqual(self.request('/api/state', origin='chrome-extension://' + first)[0], 403)
        self.assertEqual(self.request('/api/state', origin='chrome-extension://' + second)[0], 200)
        self.assertEqual(self.request('/api/extension/revoke', data={}, token=server.TOKEN)[0], 200)
        self.assertEqual(server.extension_ids(), [])


if __name__ == '__main__':
    unittest.main()
