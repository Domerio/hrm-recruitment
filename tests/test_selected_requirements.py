import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from record_editing import default_priority_groups, job_values


class SelectedRequirementTests(unittest.TestCase):
    def values(self, **updates):
        return job_values({'title':'测试岗位','jd':'测试职责','criteria':'1. 熟悉 Python\n2. 图像处理经验',
                           'must_have':'', 'requirements_mode':'selected', **updates})

    def test_selected_requirement_uses_canonical_existing_text(self):
        data = self.values(must_have='• 图像处理经验')
        self.assertEqual(data['must_have'], '2. 图像处理经验')
        self.assertEqual(data['priority_groups'], [['1. 熟悉 Python'], ['2. 图像处理经验']])

    def test_a_selected_condition_cannot_be_inserted_outside_the_requirement_list(self):
        with self.assertRaises(ValueError):
            self.values(must_have='额外语言条件')
        with self.assertRaises(ValueError):
            self.values(criteria='1. 熟悉 Python', must_have='2. 图像处理经验')

    def test_all_current_requirements_can_be_selected_without_old_free_text_limits(self):
        criteria = '\n'.join(f'{index}. 条件{index}' for index in range(1, 101))
        data = self.values(criteria=criteria, must_have=criteria)
        self.assertEqual(len(data['must_have'].splitlines()), 100)
        long_requirement = '具备相关技术项目经验' * 60
        self.assertEqual(self.values(criteria=long_requirement, must_have=long_requirement)['must_have'], long_requirement)

    def test_legacy_free_text_api_contract_remains_available(self):
        data = job_values({'title':'旧岗位','jd':'职责','criteria':'一般要求','must_have':'独立必备要求'})
        self.assertEqual(data['must_have'], '独立必备要求')
        self.assertEqual(len(data['priority_groups']), 2)

    def test_default_priorities_follow_numeric_labels_not_lexical_or_drag_history_order(self):
        requirements = ['8. 光学知识', '2、 工作经验', '10. 现场交付', '1. 学历', '未编号条目']
        self.assertEqual(default_priority_groups(requirements),
                         [['1. 学历'], ['2、 工作经验'], ['8. 光学知识'], ['10. 现场交付'], ['未编号条目']])
        self.assertEqual(default_priority_groups(['1.5年以上项目经验', '普通条目']),
                         [['1.5年以上项目经验'], ['普通条目']])

    def test_numeric_default_upgrade_marks_only_unconfigured_history_pending_once(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(server, 'DB', Path(directory)/'local.sqlite'):
            server.init_db()
            with server.connect() as db:
                for jid in (1, 2):
                    db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)', (jid,'岗位','城市','职责','1. 条件一\n2. 条件二','now'))
                    db.execute('INSERT INTO candidates(id,job_id,name,resume,phone,email,link,created) VALUES(?,?,?,?,?,?,?,?)',
                               (jid,jid,'测试候选人','测试履历','','','','now'))
                    db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)', (jid,'model','{}','now'))
                db.execute('INSERT INTO job_priorities VALUES(?,?)', (2,'[["1. 条件一", "2. 条件二"]]'))
                db.execute("DELETE FROM configuration_migrations WHERE name='numbered-priority-default-v1'")
            server.init_db(); server.init_db()
            with server.connect() as db:
                pending = db.execute("SELECT detail FROM audit WHERE action='evaluate_pending'").fetchall()
                self.assertEqual([row[0] for row in pending], ['1'])
                self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
