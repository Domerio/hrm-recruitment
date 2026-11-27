import http.client
import ipaddress
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import network_access
import psutil


class NetworkAccessTests(unittest.TestCase):
    def test_explicit_listener_configuration(self):
        with patch.dict(os.environ, {'HOST': '0.0.0.0', 'PORT': '9876'}):
            self.assertEqual(network_access.bind_host(), '0.0.0.0')
            self.assertEqual(network_access.bind_port(), 9876)
        for host in ['example.org', '0.0.0.0:8765', '::', '']:
            with self.subTest(host=host), patch.dict(os.environ, {'HOST': host}):
                with self.assertRaises(ValueError):
                    network_access.bind_host()
        for port in ['0', '65536', 'invalid']:
            with self.subTest(port=port), patch.dict(os.environ, {'PORT': port}):
                with self.assertRaises(ValueError):
                    network_access.bind_port()

    def test_host_must_match_actual_socket_destination(self):
        check = network_access.permitted_host
        self.assertTrue(check('192.168.1.10:8765', '192.168.1.10', 8765))
        self.assertTrue(check('localhost:8765', '127.0.0.1', 8765))
        self.assertTrue(check('127.0.0.1:8765', '127.0.0.1', 8765))
        self.assertTrue(check('192.168.1.10', '192.168.1.10', 80))
        for host in ['attacker.invalid:8765', 'localhost:8765', '127.0.0.1:8765',
                     '192.168.1.11:8765', '0.0.0.0:8765', '192.168.1.10:80',
                     '192.168.1.10:8765/', '192.168.1.10:8765#',
                     '192.168.1.10:8765?', '192.168.1.10:8765\\x',
                     'user@192.168.1.10:8765', '', '192.168.1.10:8765 ']:
            with self.subTest(host=host):
                self.assertFalse(check(host, '192.168.1.10', 8765))
        self.assertFalse(check('192.168.1.10:0', '192.168.1.10', 80))

    def test_lan_workbench_read_write_and_local_management_boundary(self):
        stats = psutil.net_if_stats()
        addresses = [entry.address for name, entries in psutil.net_if_addrs().items()
                     for entry in entries if stats[name].isup and entry.family == socket.AF_INET
                     and not ipaddress.ip_address(entry.address).is_loopback
                     and not ipaddress.ip_address(entry.address).is_unspecified]
        if not addresses:
            self.skipTest('No non-loopback IPv4 interface')
        address = addresses[0]
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(server, 'DB', Path(directory) / 'lan.sqlite'), \
                patch.object(server, 'EXTENSION_FILE', Path(directory) / 'extension.json'):
            server.init_db()
            with server.RecruitmentHTTPServer(('0.0.0.0', 0), server.Handler) as httpd:
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                def request(path, method='GET', body=None, **headers):
                    connection = http.client.HTTPConnection(address, httpd.server_port, timeout=3)
                    try:
                        connection.request(method, path, body=json.dumps(body) if body is not None else None,
                                           headers=headers)
                        response = connection.getresponse()
                        data = response.read()
                        return response.status, data
                    finally:
                        connection.close()
                try:
                    authority = f'{address}:{httpd.server_port}'
                    status, html = request('/')
                    self.assertEqual(status, 200)
                    self.assertIn(b'workbench.js', html)
                    status, data = request('/api/state')
                    self.assertEqual(status, 200)
                    token = json.loads(data)['token']
                    headers = {'Origin': 'http://' + authority, 'X-App-Token': token,
                               'Content-Type': 'application/json'}
                    status, data = request('/api/jobs', 'POST', {'title': 'LAN test', 'jd': 'test',
                                          'criteria': 'test'}, **headers)
                    self.assertEqual(status, 201, data)
                    status, data = request('/api/state')
                    self.assertEqual(json.loads(data)['jobs'][0]['title'], 'LAN test')
                    for origin in ['http://attacker.invalid', 'http://127.0.0.1:' + str(httpd.server_port)]:
                        self.assertEqual(request('/api/state', Origin=origin)[0], 403)
                    self.assertEqual(request('/api/state', Host='attacker.invalid:' + str(httpd.server_port))[0], 403)
                    for path in ['/api/extension/clipboard-sequence', '/api/extension/ocr',
                                 '/api/extension/ocr-report', '/api/extension/dom-snapshot']:
                        with self.subTest(path=path):
                            self.assertEqual(request(path, 'POST', {'id': 'a' * 32}, **headers)[0], 403)
                    for identifier in ('a' * 32, 'b' * 32):
                        status, data = request('/api/extension/pair', 'POST', {'id':identifier}, **headers)
                        self.assertEqual(status, 200, data)
                    self.assertEqual(server.extension_ids(), ['a' * 32, 'b' * 32])
                    self.assertEqual(request('/api/extension/revoke', 'POST', {'id':'a' * 32}, **headers)[0], 200)
                    self.assertEqual(server.extension_ids(), ['b' * 32])
                    self.assertEqual(request('/api/extension/revoke', 'POST', {'id':'b' * 32}, **headers)[0], 200)
                    self.assertEqual(server.extension_ids(), [])
                    headers['X-App-Token'] = 'expired'
                    self.assertEqual(request('/api/jobs', 'POST', {'title': 'no'}, **headers)[0], 403)
                finally:
                    httpd.shutdown()
                    thread.join()


if __name__ == '__main__':
    unittest.main()
