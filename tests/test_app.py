import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

class Tests(unittest.TestCase):
    def test_formula_injection(self):
        for s in ['=1+1', ' @SUM(A1)', '+123', '-1']:
            self.assertTrue(server.safe_cell(s).startswith("'"))
        self.assertEqual(server.safe_cell('张三'), '张三')

    def test_redaction(self):
        text = server.redact('电话13812345678，邮箱test@example.com；熟悉Python')
        self.assertNotIn('13812345678', text)
        self.assertNotIn('test@example.com', text)
        self.assertIn('Python', text)

    def test_evidence_must_exist(self):
        r = {'score': 80, 'category':'推荐', 'summary':'符合', 'questions':[], 'checks':[{'condition':'Python','status':'满足','evidence':'有十年Python经验'}]}
        with self.assertRaises(ValueError):
            server.validate_evaluation(r, '有两年Python经验')
        r['checks'][0]['evidence'] = '两年Python经验'
        self.assertEqual(server.validate_evaluation(r, '有两年Python经验')['score'], 80)

    def test_evaluation_retries_invalid_line_and_recovers_exact_evidence(self):
        base = {'score': 80, 'category':'推荐', 'summary':'具备相关经验', 'questions':[]}
        def result(line):
            return {**base,'checks':[{'condition':'Python','status':'满足','evidence_line':line},
                {'condition':'量产经历','status':'信息不足','evidence_line':1,'evidence':'无依据的文字'}]}
        model = Mock()
        model.complete.side_effect = [result(9), result(2)]
        result = server.complete_evaluation(model, {'jd':'软件开发','criteria':'Python'}, '工作经历\n有两年 Python 开发经验。', None)
        self.assertEqual(model.complete.call_count,2)
        self.assertEqual(result['checks'][0]['evidence'],'有两年 Python 开发经验。')
        self.assertEqual(result['checks'][1]['evidence'],'')

    def test_database_constraints(self):
        original = server.DB
        with tempfile.TemporaryDirectory() as d:
            server.DB = Path(d) / 'test.sqlite'
            try:
                server.init_db()
                with server.connect() as db:
                    db.execute("INSERT INTO jobs VALUES(1,'测试','','JD','条件','now')")
                    db.execute("INSERT INTO candidates(job_id,name,resume,phone,email,link,created) VALUES(1,'张三','资料','','','','now')")
                    with self.assertRaises(server.sqlite3.IntegrityError):
                        db.execute("INSERT INTO candidates(job_id,name,resume,phone,email,link,created) VALUES(1,'张三','资料','','','','now')")
            finally:
                server.DB = original

if __name__ == '__main__':
    unittest.main()
