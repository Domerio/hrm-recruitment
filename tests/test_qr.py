import base64
from contextlib import closing
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from PIL import Image
import zxingcpp

import server
from qr_decode import recognize_qr, safe_boss_qr_url


def qr_image(payload):
    barcode = zxingcpp.create_barcode(payload, zxingcpp.BarcodeFormat.QRCode)
    image = zxingcpp.write_barcode_to_image(barcode, scale=6)
    height, width = memoryview(image).shape
    return Image.frombytes('L', (width, height), bytes(image))


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return buffer.getvalue()


def data_url(raw):
    return 'data:image/png;base64,' + base64.b64encode(raw).decode()


class QrDecodeTests(unittest.TestCase):
    def test_only_valid_https_boss_origins_become_links(self):
        for url in ('https://zhipin.com/a?x=one', 'https://www.zhipin.com:443/web/a',
                    'https://m.zhipin.com/view?token=example', 'https://zpurl.cn/example'):
            with self.subTest(url=url):
                self.assertEqual(safe_boss_qr_url(url), url)
        for url in ('http://www.zhipin.com/a', 'https://zhipin.com.evil.test/a',
                    'https://evil.test/a', 'javascript:alert(1)', 'boss://candidate/example',
                    'https://sub.zpurl.cn/a', 'https://zpurl.cn.evil.test/a', 'http://zpurl.cn/a',
                    'https://user@zhipin.com/a', 'https://user:password@zhipin.com/a',
                    'https://zhipin.com:8765/a', 'https://zhipin.com:abc/a',
                    'https://zhipin.com./a', 'https://foo..zhipin.com/a',
                    'https://zhipin.com/a\n', 'https://zhipin.com/a%0D%0Aheader',
                    ' https://zhipin.com/a', 'https://zhipin.com\\@evil.test/a'):
            with self.subTest(url=url):
                self.assertEqual(safe_boss_qr_url(url), '')

    def test_local_qr_decoding_recognizes_a_boss_link_and_rejects_other_payloads(self):
        allowed = 'https://www.zhipin.com/web/geek/example?from=qr'
        image = qr_image(allowed).rotate(90, expand=True)
        result = recognize_qr(png_bytes(image))
        self.assertEqual(result, {'qr_url':allowed, 'qr_status':'recognized'})
        short = 'https://zpurl.cn/test-example'
        self.assertEqual(recognize_qr(png_bytes(qr_image(short))),
            {'qr_url':short, 'qr_status':'recognized'})
        for payload in ('https://outside.example/profile', 'javascript:alert(1)', 'boss://candidate/test'):
            with self.subTest(payload=payload):
                self.assertEqual(recognize_qr(png_bytes(qr_image(payload))),
                    {'qr_url':'', 'qr_status':'unsupported'})

    def test_multiple_distinct_codes_are_not_guessed(self):
        first = qr_image('https://www.zhipin.com/first')
        second = qr_image('https://www.zhipin.com/second')
        card = Image.new('L', (first.width + second.width + 80, max(first.height, second.height) + 40), 'white')
        card.paste(first, (20, 20))
        card.paste(second, (first.width + 60, 20))
        self.assertEqual(recognize_qr(png_bytes(card)), {'qr_url':'', 'qr_status':'multiple'})

    def test_unreadable_images_and_missing_codes_return_status_without_payload(self):
        self.assertEqual(recognize_qr(png_bytes(Image.new('RGB', (150, 150), 'white'))),
            {'qr_url':'', 'qr_status':'not_found'})
        self.assertEqual(recognize_qr(b'not an image'), {'qr_url':'', 'qr_status':'unreadable'})
        with patch.object(zxingcpp, 'read_barcodes', side_effect=RuntimeError('decoder failure')):
            self.assertEqual(recognize_qr(png_bytes(qr_image('https://zhipin.com/test'))),
                {'qr_url':'', 'qr_status':'unreadable'})


class QrHttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = patch.object(server, 'DB', Path(self.directory.name) / 'qr.sqlite')
        self.database.start()
        server.init_db()
        with server.connect() as db:
            db.execute('INSERT INTO jobs VALUES(1,?,?,?,?,?)', ('测试岗位', '', 'JD', '条件', 'now'))
        self.cid = server.save_boss_candidate(1, '测试人员', '负责测试软件开发和工业检测设备的交付，具备相关项目经验。', '')[0]
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.database.stop()
        self.directory.cleanup()

    def post(self, path, payload):
        request = urllib.request.Request(self.base + path, data=json.dumps(payload).encode(),
            headers={'X-App-Token':server.TOKEN, 'Content-Type':'application/json'})
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def source(self):
        with urllib.request.urlopen(self.base + '/api/state') as response:
            return json.load(response)['candidates'][0]['source']

    def test_save_decodes_and_replacement_removes_the_previous_link(self):
        url = 'https://m.zhipin.com/profile/example'
        original = png_bytes(qr_image(url))
        response = self.post('/api/candidates/share', {'id':self.cid, 'image':data_url(original)})
        self.assertEqual(response, {'ok':True, 'qr_url':url, 'qr_status':'recognized'})
        self.assertEqual(self.source()['qr_url'], url)
        blank = png_bytes(Image.new('RGB', (180, 180), 'white'))
        replaced = self.post('/api/candidates/share', {'id':self.cid, 'image':data_url(blank)})
        self.assertEqual(replaced, {'ok':True, 'qr_url':'', 'qr_status':'not_found'})
        self.assertEqual(self.source()['qr_url'], '')
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT share_image FROM candidate_sources WHERE candidate_id=?',
                (self.cid,)).fetchone()['share_image'], blank)

    def test_old_images_are_explicitly_decoded_and_get_only_reads_the_cache(self):
        url = 'https://zhipin.com/profile/example'
        raw = png_bytes(qr_image(url))
        with server.connect() as db:
            db.execute('INSERT INTO candidate_sources(candidate_id,share_image) VALUES(?,?)', (self.cid, raw))
        with patch.object(server, 'recognize_qr', wraps=recognize_qr) as decoder:
            self.assertEqual(self.source()['qr_status'], 'not_checked')
            decoder.assert_not_called()
            result = self.post('/api/candidates/recognize-qr', {'id':self.cid})
            self.assertEqual(result, {'ok':True, 'qr_url':url, 'qr_status':'recognized'})
            self.assertEqual(self.source()['qr_url'], url)
            self.assertEqual(decoder.call_count, 1)

    def test_a_decode_failure_preserves_the_image_and_collection_success(self):
        raw = png_bytes(qr_image('https://zhipin.com/profile/example'))
        with patch.object(zxingcpp, 'read_barcodes', side_effect=RuntimeError('decoder failure')):
            result = self.post('/api/candidates/share', {'id':self.cid, 'image':data_url(raw)})
        self.assertEqual(result, {'ok':True, 'qr_url':'', 'qr_status':'unreadable'})
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT share_image FROM candidate_sources WHERE candidate_id=?',
                (self.cid,)).fetchone()['share_image'], raw)

    def test_explicit_decode_cannot_attach_an_old_link_to_a_replaced_image(self):
        original = png_bytes(qr_image('https://zhipin.com/old'))
        replacement = png_bytes(Image.new('RGB', (100, 100), 'white'))
        with server.connect() as db:
            db.execute('INSERT INTO candidate_sources(candidate_id,share_image) VALUES(?,?)', (self.cid, original))
        def replace_during_decode(_raw):
            with server.connect() as db:
                db.execute("UPDATE candidate_sources SET share_image=?,qr_url='',qr_status='not_checked' WHERE candidate_id=?",
                    (replacement, self.cid))
            return {'qr_url':'https://zhipin.com/old', 'qr_status':'recognized'}
        with patch.object(server, 'recognize_qr', side_effect=replace_during_decode):
            with self.assertRaises(urllib.error.HTTPError) as stale:
                self.post('/api/candidates/recognize-qr', {'id':self.cid})
        self.assertEqual(stale.exception.code, 400)
        self.assertEqual(self.source()['qr_url'], '')
        self.assertEqual(self.source()['qr_status'], 'not_checked')

    def test_old_source_schema_migration_is_idempotent(self):
        other = Path(self.directory.name) / 'old.sqlite'
        with closing(sqlite3.connect(other)) as db:
            with db:
                db.execute("""CREATE TABLE candidate_sources(candidate_id INTEGER PRIMARY KEY,
                    capture TEXT,share_image BLOB,share_status TEXT NOT NULL DEFAULT '未获取')""")
                db.execute("INSERT INTO candidate_sources(candidate_id,share_image) VALUES(1,?)", (b'original image',))
        with patch.object(server, 'DB', other):
            server.init_db()
            server.init_db()
            with server.connect() as db:
                row = db.execute('SELECT share_image,qr_url,qr_status FROM candidate_sources').fetchone()
                self.assertEqual(row['share_image'], b'original image')
                self.assertEqual(row['qr_url'], '')
                self.assertEqual(row['qr_status'], 'not_checked')


if __name__ == '__main__':
    unittest.main()
