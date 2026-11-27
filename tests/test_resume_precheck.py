import unittest
from datetime import date

from resume_format import display_lines
from resume_precheck import PRECHECK_VERSION, precheck_resume


EDUCATION = '本科及以上学历，计算机、机器视觉、自动化等相关专业'
MODE = (EDUCATION + '；本科要求全日制；硕士及以上可接受非全日制；'
        '本科学习形式未标明时默认全日制')
VISION = '4年以上机器视觉与图像处理行业的相关开发经验'


class ResumePrecheckTests(unittest.TestCase):
    def check(self, requirement, resume, **kwargs):
        return precheck_resume({'must_have': requirement}, resume, **kwargs)

    def test_highest_degree_is_an_explicit_bound_with_verbatim_evidence(self):
        resume = '合成测试\n最高学历：大专\n专业技能\n具有丰富工业视觉项目经验'
        result = self.check(EDUCATION, resume)
        self.assertTrue(result['rejected'])
        self.assertEqual(result['version'], PRECHECK_VERSION)
        row = result['checks'][0]
        self.assertEqual(row['rule_id'], 'highest_degree_below_minimum')
        self.assertEqual(row['condition'], EDUCATION)
        self.assertEqual(row['evidence_lines'], [2])
        self.assertEqual(row['evidence_quotes'], ['最高学历：大专'])
        self.assertEqual(row['basis'], 'explicit')
        self.assertNotIn('score', result)

    def test_degree_record_or_missing_resume_alone_cannot_establish_highest_degree(self):
        for resume in ['', '教育经历\n合成大学 大专 计算机', '学历：大专',
                       '个人优势\n没有写学历但有丰富开发经验', '本科', '最高学历：未知',
                       '最高学历：大专？', '最高学历：大专（待核实）']:
            with self.subTest(resume=resume):
                self.assertFalse(self.check(EDUCATION, resume)['rejected'])

    def test_explicit_lower_highest_degrees_cover_all_supported_minima(self):
        for requirement, highest in [('本科及以上学历', '高中'), ('硕士及以上学历', '本科'),
                                     ('博士及以上学历', '硕士'), ('大专及以上学历', '中专')]:
            self.assertTrue(self.check(requirement, '最高学历：' + highest)['rejected'])

    def test_equal_or_higher_degree_passes_and_major_is_never_keyword_filtered(self):
        for resume in ['最高学历：本科\n教育经历\n合成大学 机械工程',
                       '最高学历：硕士\n教育经历\n合成大学 物理学',
                       '最高学历：博士\n工作经历\n从其他行业转入研发']:
            self.assertFalse(self.check(EDUCATION, resume)['rejected'])

    def test_conflicting_or_any_higher_education_record_requires_model_review(self):
        for extra in ['最高学历：本科', '教育经历\n合成大学 本科 计算机',
                      '教育经历\n硕士在读', '教育经历\n本科（待核实）',
                      '教育经历：合成大学 本科 计算机']:
            self.assertFalse(self.check(EDUCATION, '最高学历：大专\n' + extra)['rejected'])

    def test_non_full_time_policy_requires_an_explicit_highest_bachelor(self):
        resume = '最高学历：本科\n教育经历\n合成大学 本科\n学习形式：非全日制'
        result = self.check(MODE, resume)
        self.assertTrue(result['rejected'])
        row = result['checks'][0]
        self.assertEqual(row['rule_id'], 'highest_bachelor_non_full_time')
        self.assertIn('最高学历：本科', row['evidence_quotes'])
        self.assertIn('学习形式：非全日制', row['evidence_quotes'])
        for missing_or_higher in [
            resume.replace('最高学历：本科\n', ''),
            resume.replace('非全日制', '未明确'),
            resume + '\n合成大学 硕士',
            resume + '\n硕士在读',
            resume + '\n合成大学 全日制本科',
        ]:
            self.assertFalse(self.check(MODE, missing_or_higher)['rejected'])

    def test_total_work_years_are_explicit_and_scope_is_not_related_experience(self):
        for label in ['总工作经验：2年', '累计工作年限：2年', '工作经验合计2年',
                      '本人累计工作2年', '总从业时间：二年', '总工作经验：24个月']:
            result = self.check(VISION, label)
            self.assertTrue(result['rejected'], label)
            self.assertEqual(result['checks'][0]['rule_id'], 'total_experience_below_minimum')
            self.assertEqual(result['checks'][0]['evidence_quotes'], [label])

    def test_chinese_minimum_and_exact_months_respect_the_threshold(self):
        requirement = '至少五年Java后端开发经验'
        self.assertTrue(self.check(requirement, '总工作经验：四年六个月')['rejected'])
        self.assertFalse(self.check(requirement, '总工作经验：五年')['rejected'])
        self.assertFalse(self.check('3年以上工作经验', '累计工作年限：3年')['rejected'])
        self.assertTrue(self.check('3年以上工作经验', '累计工作年限：2年11个月')['rejected'])

    def test_lower_bounds_approximations_related_durations_or_omissions_are_not_upper_bounds(self):
        for resume in ['总工作经验：2年以上', '总工作经验：至少2年',
                       '总工作经验：2年+', '总工作经验：约2年',
                       '总工作经验：2年左右', '总工作经验：2-3年',
                       '总工作经验：2年（不含实习）', '总工作经验：2年，其中包含实习',
                       '机器视觉相关开发经验：2年', '从事视觉项目2年',
                       '2年经验', '2年工作经验', '工作经历\n一段任职2024.01-2026.01',
                       '最高学历：本科\n个人优势\n没有列出年限']:
            self.assertFalse(self.check(VISION, resume)['rejected'], resume)

    def test_conflicting_declared_totals_or_longer_stated_experience_defer(self):
        for extra in ['总工作经验：5年', '个人优势\n有6年机械设计经验',
                      '个人优势\n已有5年Java开发经验', '工作经历\n5年Python学习经历']:
            self.assertFalse(self.check(VISION, '总工作经验：2年\n' + extra)['rejected'])

    def test_longer_credible_timeline_or_uncertain_dates_are_only_a_guard(self):
        for period in ['2018.01-2024.01', '2018年-2024年']:
            resume = '总工作经验：2年\n工作经历\n合成测试有限公司\n研发工程师\n' + period + '\n负责软件开发'
            self.assertFalse(self.check(VISION, resume)['rejected'])
        no_declared_total = '工作经历\n合成测试有限公司\n研发工程师\n2025.01-2026.01\n负责软件开发'
        self.assertFalse(self.check(VISION, no_declared_total)['rejected'])

    def test_quoted_requirements_other_people_and_mixed_sections_are_not_personal_facts(self):
        for resume in ['招聘要求\n最高学历：大专\n总工作经验：2年',
                       '职位要求 最高学历：大专',
                       '教育经历 最高学历：大专 工作经历 总工作经验：2年',
                       '团队最高学历：大专\n团队总工作经验：2年',
                       '示例：最高学历：大专\n模板：总工作经验：2年',
                       '> 最高学历：大专\n> 总工作经验：2年',
                       '个人优势\n最高学历：大专']:
            self.assertFalse(self.check(EDUCATION + '\n' + VISION, resume)['rejected'], resume)

    def test_only_selected_hard_rules_can_reject(self):
        resume = '最高学历：大专\n总工作经验：2年'
        result = precheck_resume({'criteria': EDUCATION + '\n' + VISION, 'jd': EDUCATION}, resume)
        self.assertFalse(result['rejected'])
        self.assertFalse(self.check('熟悉C#、Python、OpenCV、Halcon及光学知识', resume)['rejected'])

    def test_relaxed_alternative_and_demographic_conditions_are_never_automatic_rejections(self):
        resume = '最高学历：大专\n总工作经验：2年'
        for condition in ['本科及以上优先', '本科及以上学历，可放宽至大专',
                          '本科及以上学历或具有丰富项目经验', '3年以上工作经验优先',
                          '学历不限，有3年以上工作经验更佳', '年龄35岁以内且本科及以上学历',
                          '女性，本科及以上学历', '本科及以上学历，身高170cm以上']:
            self.assertFalse(self.check(condition, resume)['rejected'], condition)

    def test_display_line_numbers_and_requirement_ids_are_stable(self):
        resume = '合成测试\n\n最高学历：大专\n总工作经验：2年'
        lines = display_lines(resume)
        result = self.check('必备条件\n1. 熟悉C#\n2. 本科及以上学历\n3. 3年以上工作经验',
                            resume, lines=lines)
        self.assertEqual([row['requirement_id'] for row in result['checks']], [2, 3])
        for row in result['checks']:
            self.assertEqual(row['evidence_quotes'], [lines[index-1] for index in row['evidence_lines']])

    def test_foreign_line_content_or_folded_incomplete_input_cannot_produce_a_rejection(self):
        self.assertFalse(self.check(EDUCATION, '普通简历', lines=['最高学历：大专'])['rejected'])
        self.assertFalse(self.check(EDUCATION, '最高学历：大专\n查看全部')['rejected'])

    def test_uncertain_unrelated_requirements_preserve_qualified_transferable_skills(self):
        resume = ('最高学历：本科\n总工作经验：8年\n个人优势\n'
                  '此前从事控制系统与精密测量，负责相机选型、图像算法与现场调试。')
        result = self.check(EDUCATION + '\n' + VISION + '\n精通C#、python\n熟悉Opencv、Halcon', resume)
        self.assertFalse(result['rejected'])
        self.assertEqual(result['checks'], [])


    def test_boss_header_total_can_be_inline_or_split_and_never_uses_age_as_a_threshold(self):
        for metadata in ['26岁 本科 3年 离职-随时到岗', '26岁\n本科\n3年\n离职-随时到岗',
                         '本科 61岁 3年 在职-月内到岗', '26岁 大专 3年 在职-考虑机会']:
            resume = '张** 刚刚活跃\n' + metadata + '\n工作经历\n负责跨领域研发'
            result = self.check(VISION, resume)
            self.assertTrue(result['rejected'], metadata)
            row = result['checks'][0]
            self.assertEqual(row['rule_id'], 'total_experience_below_minimum')
            self.assertIn('平台页首明确展示的总工作年限', row['reasoning'])
            self.assertNotIn('岁', row['reasoning'])
            self.assertNotIn('education', row['rule_id'])
            self.assertEqual(row['evidence_quotes'],
                             [display_lines(resume)[number-1] for number in row['evidence_lines']])

    def test_incomplete_non_exact_or_body_metadata_is_not_a_platform_total(self):
        for metadata in ['26岁 本科 5年以上 离职-随时到岗', '26岁 本科 3年+ 离职-随时到岗',
                         '本科 3年 离职', '26岁 3年 离职', '26岁 本科 3年',
                         '26岁 本科 应届生 离职', '26岁 本科 2年 3年 离职',
                         '26岁 本科 3年Java开发 离职']:
            self.assertFalse(self.check('6年以上工作经验', '张**\n' + metadata)['rejected'], metadata)
        self.assertFalse(self.check(VISION, '个人优势\n张**\n26岁 本科 3年 离职')['rejected'])

    def test_platform_total_conflicts_or_longer_work_dates_return_to_model(self):
        header = '张**\n26岁 本科 3年 离职-随时到岗'
        for extra in ['总工作经验：5年', '个人优势\n有8年跨行业研发经验',
                      '工作经历\n合成公司\n软件工程师\n2018.01-2024.01\n负责研发']:
            self.assertFalse(self.check(VISION, header + '\n' + extra,
                                        evaluation_date=date(2026, 11, 23))['rejected'])
        self.assertFalse(self.check(VISION, '张**\n26岁 本科 5年以上 离职\n总工作经验：2年')['rejected'])

    def test_evaluation_date_controls_timeline_guard_without_reading_the_system_clock(self):
        resume = '张**\n26岁 本科 3年 离职\n工作经历\n合成公司\n软件工程师\n2020.01-至今\n负责研发'
        self.assertTrue(self.check(VISION, resume, evaluation_date=date(2022, 1, 1))['rejected'])
        self.assertFalse(self.check(VISION, resume, evaluation_date=date(2026, 1, 1))['rejected'])
        self.assertFalse(self.check(VISION, resume)['rejected'])

    def test_highest_degree_with_an_open_lower_bound_is_not_an_upper_bound(self):
        for value in ['大专及以上', '本科以上']:
            self.assertFalse(self.check('博士及以上学历', '最高学历：' + value)['rejected'])



    def test_longer_project_research_or_learning_experience_defers_to_the_model(self):
        for section in ['项目经历', '项目经验', '专业技能', '其他能力', '教育经历', '教育背景']:
            resume = '总工作经验：2年\n' + section + '\n在校及业余期间完成5年机器视觉研究经历'
            self.assertFalse(self.check(VISION, resume)['rejected'], section)

    def test_project_and_education_totals_never_establish_total_work_upper_bounds(self):
        for section in ['项目经历', '项目经验', '专业技能', '其他能力', '教育经历', '教育背景']:
            resume = section + '\n总工作经验：2年\n负责机器视觉开发与跨领域研究'
            self.assertFalse(self.check(VISION, resume)['rejected'], section)


if __name__ == '__main__':
    unittest.main()
