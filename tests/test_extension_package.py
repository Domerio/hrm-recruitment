import http.client
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import extension_package as packaging
from extension_package import (PACKAGE_ROOT, ExtensionPackageError,
                               build_extension_package, extension_package_metadata)


class _PackageFixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.extension = self.root / 'extension'
        self.extension.mkdir()
        self.manifest = {'manifest_version':3, 'name':'候选人助手测试版', 'version':'1.2.3',
                         'action':{'default_popup':'popup.html'},
                         'web_accessible_resources':[{'resources':['assets/*.svg'], 'matches':['http://localhost/*']}]}
        self.write_manifest()
        self.write('安装说明.md', '# 安装说明\n解压后，加载包含 manifest.json 的文件夹。\n')
        self.write('popup.html', '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="popup.css">'
                   '<h1>完整中文界面</h1><script type="module" src="popup.js"></script>')
        self.write('popup.css', 'body { color: #123456; }')
        self.write('popup.js', "import {text} from './lib/helper.mjs'; console.log(text);")
        self.write('lib/helper.mjs', "export const text='完整中文脚本';")
        self.write('assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

    def write(self, name, text):
        target = self.extension / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8')

    def write_manifest(self):
        self.write('manifest.json', json.dumps(self.manifest, ensure_ascii=False))

    def package(self):
        metadata, body = build_extension_package(self.extension)
        return metadata, zipfile.ZipFile(io.BytesIO(body))


class ExtensionPackageTests(_PackageFixture, unittest.TestCase):

    def test_zip_contains_complete_unicode_runtime_files_under_one_root(self):
        metadata, archive = self.package()
        self.addCleanup(archive.close)
        self.assertEqual(metadata, extension_package_metadata(self.extension))
        manifest = json.loads(archive.read(PACKAGE_ROOT + '/manifest.json'))
        self.assertEqual(metadata['version'], manifest['version'])
        self.assertEqual(metadata['name'], manifest['name'])
        self.assertEqual(metadata['filename'], PACKAGE_ROOT + '-' + manifest['version'] + '.zip')
        self.assertEqual(metadata['download_url'], '/api/extension/download')
        expected = sorted(PACKAGE_ROOT + '/' + path.relative_to(self.extension).as_posix()
                          for path in self.extension.rglob('*') if path.is_file())
        self.assertEqual(sorted(archive.namelist()), expected)
        self.assertIn('完整中文脚本', archive.read(PACKAGE_ROOT + '/lib/helper.mjs').decode('utf-8'))
        self.assertIn('加载包含', archive.read(PACKAGE_ROOT + '/安装说明.md').decode('utf-8'))
        self.assertIsNone(archive.testzip())

    def test_version_and_file_contents_are_read_fresh(self):
        original = extension_package_metadata(self.extension)
        self.manifest['version'] = '1.2.4'
        self.write_manifest()
        self.write('lib/helper.mjs', "export const text='更新后的脚本';")
        metadata, archive = self.package()
        self.addCleanup(archive.close)
        self.assertNotEqual(metadata['filename'], original['filename'])
        self.assertEqual(metadata['version'], self.manifest['version'])
        self.assertIn('更新后的脚本', archive.read(PACKAGE_ROOT + '/lib/helper.mjs').decode('utf-8'))

    def test_download_origin_is_embedded_without_mutating_source_or_copying_tokens(self):
        source_default = 'export const DEFAULT_WORKBENCH_ORIGIN = "http://127.0.0.1:8765";\n'
        self.write('workbench-default.mjs', source_default)
        origin = 'http://192.168.1.33:8765'
        metadata, body = build_extension_package(self.extension, origin)
        self.assertEqual(metadata['workbench_origin'], origin)
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            module = archive.read(PACKAGE_ROOT + '/workbench-default.mjs').decode('utf-8')
            self.assertEqual(module, 'export const DEFAULT_WORKBENCH_ORIGIN = "' + origin + '";\n')
            self.assertNotIn(server.TOKEN.encode(), b''.join(archive.read(name) for name in archive.namelist()))
        self.assertEqual((self.extension / 'workbench-default.mjs').read_text(encoding='utf-8'), source_default)
        _, original_body = build_extension_package(self.extension)
        with zipfile.ZipFile(io.BytesIO(original_body)) as archive:
            self.assertEqual(archive.read(PACKAGE_ROOT + '/workbench-default.mjs'),
                             (self.extension / 'workbench-default.mjs').read_bytes())
        for invalid in ('https://192.168.1.33', 'http://attacker.invalid', 'http://127.0.0.1:0',
                        'http://127.0.0.1/?token=private', 'http://user:password@127.0.0.1',
                        'http://127.0.0.1\r\nX-Evil: yes'):
            with self.subTest(invalid=invalid), self.assertRaises(ExtensionPackageError):
                build_extension_package(self.extension, invalid)

    def test_hidden_sensitive_database_logs_tests_and_unpublished_files_are_excluded(self):
        private = ['.env', '.env.example', '.git/config', '.hidden/private.js', 'secret.js',
                   'credentials.json', 'credentials.js', 'keys/key.svg', 'auth.pem', 'recruitment.sqlite3',
                   'debug.log', 'logs/debug.js', 'tests/example.js', 'lib/helper.test.mjs',
                   'node_modules/dependency/index.js', 'data/settings.js', 'private.json', 'archive.zip']
        for name in private:
            self.write(name, 'SYNTHETIC_PRIVATE_VALUE')
        _, archive = self.package()
        self.addCleanup(archive.close)
        for name in archive.namelist():
            self.assertTrue(name.startswith(PACKAGE_ROOT + '/'))
            self.assertNotIn('..', Path(name).parts)
            self.assertNotIn('\\', name)
            self.assertNotIn(b'SYNTHETIC_PRIVATE_VALUE', archive.read(name))

    def test_missing_manifest_instruction_and_referenced_resources_fail_clearly(self):
        for name in ['manifest.json', '安装说明.md', 'popup.html', 'lib/helper.mjs', 'assets/icon.svg']:
            path = self.extension / name
            original = path.read_bytes()
            path.unlink()
            try:
                with self.subTest(name=name), self.assertRaises(ExtensionPackageError):
                    build_extension_package(self.extension)
            finally:
                path.write_bytes(original)

    def test_runtime_window_and_injected_script_references_are_checked(self):
        for source in ["chrome.runtime.getURL('missing.html')",
                       "chrome.scripting.executeScript({files:['missing.js']})"]:
            self.write('popup.js', source)
            with self.subTest(source=source), self.assertRaises(ExtensionPackageError):
                extension_package_metadata(self.extension)

    def test_named_conditional_injection_lists_require_every_script(self):
        self.write('popup.js', "const scripts=withText?['popup.js','missing.mjs']:['lib/helper.mjs'];"
                   "chrome.scripting.registerContentScripts([{js:scripts}]);"
                   "chrome.scripting.executeScript({files:scripts});")
        with self.assertRaises(ExtensionPackageError):
            extension_package_metadata(self.extension)
        self.write('missing.mjs', 'export const ready=true;')
        self.assertEqual(extension_package_metadata(self.extension)['version'], self.manifest['version'])

    def test_unsafe_manifest_paths_and_invalid_versions_are_rejected(self):
        for path in ['../private.js', '/private.js', 'C:/private.js', '..\\private.js', '.env']:
            self.manifest['action']['default_popup'] = path
            self.write_manifest()
            with self.subTest(path=path), self.assertRaises(ExtensionPackageError):
                build_extension_package(self.extension)
        self.manifest['action']['default_popup'] = 'popup.html'
        for version in ['1.0\r\nX-Evil:yes', '../1', '70000', '1.2.3.4.5']:
            self.manifest['version'] = version
            self.write_manifest()
            with self.subTest(version=version), self.assertRaises(ExtensionPackageError):
                build_extension_package(self.extension)

    def test_links_cannot_copy_outside_content_into_package(self):
        outside = self.root / 'outside.js'
        outside.write_text('SYNTHETIC_OUTSIDE_VALUE', encoding='utf-8')
        try:
            os.symlink(outside, self.extension / 'linked.js')
            os.symlink(self.root, self.extension / 'linked-directory', target_is_directory=True)
        except OSError as error:
            self.skipTest('Symlinks are unavailable: ' + type(error).__name__)
        _, archive = self.package()
        self.addCleanup(archive.close)
        self.assertNotIn(PACKAGE_ROOT + '/linked.js', archive.namelist())
        self.assertFalse(any('linked-directory' in name for name in archive.namelist()))
        self.manifest['background'] = {'service_worker':'linked.js'}
        self.write_manifest()
        with self.assertRaises(ExtensionPackageError):
            build_extension_package(self.extension)

    def test_windows_reparse_flags_and_filtered_link_entries_are_rejected(self):
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=0, st_file_attributes=0x400)):
            self.assertTrue(packaging._linked(self.extension / 'junction'))
        self.write('linked-directory/secret.js', 'SYNTHETIC_OUTSIDE_VALUE')
        self.write('linked.js', 'SYNTHETIC_OUTSIDE_VALUE')
        original = packaging._linked
        with patch.object(packaging, '_linked', side_effect=lambda path:
                          path.name in {'linked-directory', 'linked.js'} or original(path)):
            _, archive = self.package()
            with archive:
                self.assertFalse(any('linked' in name for name in archive.namelist()))
            self.manifest['background'] = {'service_worker':'linked.js'}
            self.write_manifest()
            with self.assertRaises(ExtensionPackageError):
                build_extension_package(self.extension)

    def test_hard_links_are_not_packaged(self):
        outside = self.root / 'outside.js'
        outside.write_text('SYNTHETIC_OUTSIDE_VALUE', encoding='utf-8')
        os.link(outside, self.extension / 'hardlinked.js')
        _, archive = self.package()
        with archive:
            self.assertNotIn(PACKAGE_ROOT + '/hardlinked.js', archive.namelist())

    def test_actual_release_bytes_are_plaintext_and_all_runtime_files_are_present(self):
        source = Path(server.__file__).resolve().parent / 'extension'
        metadata, body = build_extension_package(source)
        manifest = json.loads((source / 'manifest.json').read_bytes())
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertEqual(metadata['version'], manifest['version'])
            expected = {PACKAGE_ROOT + '/' + path.relative_to(source).as_posix()
                        for path in source.rglob('*') if path.is_file()
                        and path.suffix in {'.js', '.mjs', '.html', '.css'}}
            self.assertTrue(expected.issubset(archive.namelist()))
            for name in archive.namelist():
                if name.endswith(('.js', '.mjs', '.html', '.css', '.md', '.json')):
                    contents = archive.read(name)
                    self.assertNotIn('\x00', contents.decode('utf-8'))
                    self.assertEqual(contents, (source / name.removeprefix(PACKAGE_ROOT + '/')).read_bytes())
            self.assertEqual(json.loads(archive.read(PACKAGE_ROOT + '/manifest.json')), manifest)

    def test_actual_canvas_injection_list_rejects_each_missing_runtime_script(self):
        source = Path(server.__file__).resolve().parent / 'extension'
        _, body = build_extension_package(source)
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            files = {name.removeprefix(PACKAGE_ROOT + '/'):archive.read(name) for name in archive.namelist()}
        manifest = json.loads(files['manifest.json'])
        for missing in ('canvas-render.js', 'canvas-expand.js', 'canvas-geometry.js',
                        'canvas-glyphs.js', 'canvas-platform-assets.js', 'canvas-text.js'):
            reduced = {name:content for name,content in files.items() if name != missing}
            with self.subTest(missing=missing), self.assertRaises(ExtensionPackageError):
                packaging._validate_resources(reduced, manifest)


class ExtensionPackageHttpTests(_PackageFixture, unittest.TestCase):
    def start_http(self):
        root_patch = patch.object(server, 'ROOT', self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        pairing = patch.object(server, 'extension_origin', return_value='')
        pairing.start()
        self.addCleanup(pairing.stop)
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=lambda:self.http.serve_forever(poll_interval=.01), daemon=True)
        thread.start()
        def stop():
            self.http.shutdown()
            self.http.server_close()
            thread.join(timeout=5)
        self.addCleanup(stop)

    def request(self, path, **headers):
        connection = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=5)
        try:
            connection.request('GET', path, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_download_is_unpaired_and_same_origin_with_correct_headers(self):
        self.start_http()
        origin = 'http://127.0.0.1:' + str(self.http.server_port)
        status, _, data = self.request('/api/extension/package', Origin=origin)
        self.assertEqual(status, 200)
        metadata = json.loads(data)
        self.assertEqual(metadata['workbench_origin'], origin)
        status, headers, data = self.request(metadata['download_url'], **{'X-Forwarded-Host':'attacker.invalid',
            'X-Forwarded-Proto':'https', 'Forwarded':'host=attacker.invalid;proto=https'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/zip')
        self.assertEqual(headers['Content-Disposition'], 'attachment; filename="' + metadata['filename'] + '"')
        self.assertEqual(int(headers['Content-Length']), len(data))
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertEqual(json.loads(archive.read(PACKAGE_ROOT + '/manifest.json'))['version'], metadata['version'])
            module = archive.read(PACKAGE_ROOT + '/workbench-default.mjs').decode('utf-8')
            self.assertIn(json.dumps(origin), module)
            self.assertNotIn('attacker.invalid', module)
            self.assertNotIn(server.TOKEN, module)
        for endpoint in ['/api/extension/package', '/api/extension/download']:
            self.assertEqual(self.request(endpoint, Origin='https://attacker.invalid')[0], 403)
            self.assertEqual(self.request(endpoint, Host='attacker.invalid:' + str(self.http.server_port))[0], 403)

    def test_unavailable_package_returns_readable_503_without_local_details(self):
        self.start_http()
        (self.extension / 'popup.js').unlink()
        for endpoint in ['/api/extension/package', '/api/extension/download']:
            status, headers, data = self.request(endpoint)
            self.assertEqual(status, 503)
            self.assertTrue(headers['Content-Type'].startswith('application/json'))
            message = json.loads(data)['error']
            self.assertIn('插件', message)
            self.assertNotIn(str(self.root), message)


if __name__ == '__main__':
    unittest.main()
