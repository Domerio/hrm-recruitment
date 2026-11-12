import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server

class BossTests(unittest.TestCase):
    def test_url_boundary(self):
        self.assertTrue(server.allowed_boss_url('https://www.zhipin.com/web/boss/'))
        for url in ['http://www.zhipin.com', 'https://www.zhipin.com.evil.test','https://evil.test','file:///etc/passwd']:
            self.assertFalse(server.allowed_boss_url(url))

    def test_import_deduplication_and_contacts(self):
        original=server.DB
        with tempfile.TemporaryDirectory() as directory:
            server.DB=Path(directory)/'test.sqlite'
            try:
                server.init_db()
                with server.connect() as db:
                    db.execute("INSERT INTO jobs VALUES(1,'视觉工程师','','JD','条件','now')")
                args=(1,'测试人员','四年机器视觉经验 联系邮箱 test@example.com 手机13800000000','')
                first,created=server.save_boss_candidate(*args)
                second,repeated=server.save_boss_candidate(*args)
                self.assertEqual(first,second)
                self.assertTrue(created)
                self.assertFalse(repeated)
                with server.connect() as db:
                    row=db.execute('SELECT * FROM candidates').fetchone()
                    self.assertEqual(row['email'],'test@example.com')
                    self.assertEqual(row['phone'],'13800000000')
            finally:
                server.DB=original
