import json
import re
import sys
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
import service_control as control

class ServiceTests(unittest.TestCase):
    def test_exclusive_binding_blocks_even_legacy_reuse_server(self):
        with server.RecruitmentHTTPServer(('127.0.0.1',0),server.Handler) as first:
            with self.assertRaises(OSError):
                server.ThreadingHTTPServer(first.server_address,server.Handler)

    def test_health_identifies_running_process_and_capture_contract(self):
        with server.RecruitmentHTTPServer(('127.0.0.1',0),server.Handler) as http:
            thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{http.server_port}/api/health') as r:health=json.load(r)
                self.assertEqual(health,{'version':server.APP_VERSION,'capture_version':1,'dom_snapshot_version':1,'pid':server.os.getpid()})
            finally:
                http.shutdown();thread.join()

    def test_workbench_style_nonce_is_unique_and_limited_to_styles(self):
        with server.RecruitmentHTTPServer(('127.0.0.1', 0), server.Handler) as http:
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                nonces = []
                for _ in range(2):
                    with urllib.request.urlopen(f'http://127.0.0.1:{http.server_port}/') as response:
                        html = response.read().decode()
                        nonce = re.search(r'name="style-nonce" content="([\w-]+)"', html).group(1)
                        csp = response.headers['Content-Security-Policy']
                        self.assertIn(f"style-src 'self' 'nonce-{nonce}'", csp)
                        self.assertIn("script-src 'self';", csp)
                        self.assertNotIn("'unsafe-inline'", csp)
                        nonces.append(nonce)
                self.assertNotEqual(*nonces)
            finally:
                http.shutdown()
                thread.join()

    def test_relative_script_requires_matching_working_directory(self):
        process=Mock()
        process.exe.return_value=sys.executable
        process.cwd.return_value=str(control.ROOT)
        process.cmdline.return_value=[sys.executable,'server.py']
        self.assertTrue(control.belongs_to_project(process))
        process.cmdline.return_value=[sys.executable,'-u',str(control.SCRIPT)]
        self.assertTrue(control.belongs_to_project(process))
        process.cwd.return_value=str(control.ROOT.parent)
        self.assertFalse(control.belongs_to_project(process))
        process.cwd.return_value=str(control.ROOT)
        process.cmdline.return_value=[sys.executable,'-c','server.py']
        self.assertFalse(control.belongs_to_project(process))

    def test_unrelated_listener_prevents_all_stops_and_launches(self):
        known,unknown=Mock(),Mock()
        with patch.object(control,'listeners',return_value=[123,456]),patch.object(control.psutil,'Process',side_effect=[known,unknown]),patch.object(control,'belongs_to_project',side_effect=[True,False]),patch.object(control,'launch') as launch:
            with self.assertRaisesRegex(RuntimeError,'unrelated'):
                control.manage('restart')
            known.terminate.assert_not_called()
            unknown.terminate.assert_not_called()
            launch.assert_not_called()

    def test_start_reuses_one_healthy_service(self):
        with patch.object(control,'listeners',return_value=[123]),patch.object(control,'verified_processes',return_value=[Mock()]),patch.object(control,'health',return_value={'version':server.APP_VERSION,'pid':123,'capture_version':1}),patch.object(control,'launch') as launch:
            self.assertTrue(control.manage('start')['already_running'])
            launch.assert_not_called()

if __name__=='__main__':unittest.main()
