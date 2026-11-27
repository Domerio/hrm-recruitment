"""Canvas row layouts, using synthetic people, institutions and job text only."""

from copy import deepcopy
import unittest

from education_policy import (
    NON_FULL_TIME_BACHELOR_ERROR,
    UNVERIFIED_BACHELOR_ERROR,
    education_policy_decision,
    verify_education_policy,
)


POLICY = '本科及以上学历，自动化相关专业；本科要求全日制；硕士及以上可接受非全日制'
PREAMBLE = '合成人员\n工作经历\n合成设备有限公司 图像工程师 2022.01 - 2026.01\n负责视觉检测系统开发。'


def decision(text):
    return education_policy_decision(POLICY, text)


class CanvasEducationPolicyTests(unittest.TestCase):
    def assert_higher_degree(self, row, rest=''):
        resume = PREAMBLE + '\n' + row + ('\n' + rest if rest else '')
        before = resume
        result = decision(resume)
        self.assertEqual(result, {'kind': 'eligible', 'evidence_quotes': [row]})
        self.assertEqual(resume, before)
        self.assertIn(row, resume.splitlines())
        self.assertIsNone(verify_education_policy({'condition': POLICY, 'status': '满足'}, resume))

    def test_first_inline_doctoral_and_master_rows_are_not_lost_in_previous_work_section(self):
        for row in (
            '教育经历 合成理工大学 计算机科学与技术 博士 2017 - 2025',
            '教育经历 合成林业大学 机械电子工程学院 硕士 2020 - 2023',
        ):
            with self.subTest(row=row):
                self.assert_higher_degree(row, '另一合成学院 自动化 本科 2013 - 2017')

    def test_inline_education_aliases_and_layout_separators_preserve_verbatim_quotes(self):
        for heading in ('教育经历', '教育背景', '教育信息', '学历信息'):
            for separator in (' ', '  ', '\t', '：', ': ', '\u3000'):
                row = heading + separator + '合成大学 自动化 硕士 2020 - 2023'
                with self.subTest(row=row):
                    self.assert_higher_degree(row)

    def test_spaced_canvas_glyphs_are_parsed_but_evidence_is_not_rewritten(self):
        row = '教 育 经 历\t合成大学 机械工程 硕 士 2020 - 2023'
        self.assert_higher_degree(row)

    def test_inline_first_bachelor_does_not_hide_a_later_completed_higher_degree(self):
        first = '教育经历 合成学院 自动化 本科 · 非全日制 2013 - 2017'
        higher = '合成大学 计算机科学与技术 博士 2017 - 2025'
        resume = PREAMBLE + '\n' + first + '\n' + higher
        self.assertEqual(decision(resume), {'kind': 'eligible', 'evidence_quotes': [higher]})

    def test_later_bachelor_study_mode_does_not_override_the_higher_inline_record(self):
        row = '教育经历 合成大学 自动化 硕士 2020 - 2023'
        self.assert_higher_degree(row, '合成学院 自动化 本科 · 非全日制 2014 - 2018')

    def test_inline_bachelor_still_uses_the_existing_explicit_and_default_mode_rules(self):
        for mode, kind in (('', 'bachelor_default_full_time'), (' · 全日制', 'eligible'),
                           (' · 非全日制', 'non_full_time_bachelor')):
            row = '教育经历 合成学院 自动化 本科' + mode + ' 2014 - 2018'
            with self.subTest(mode=mode):
                self.assertEqual(decision(PREAMBLE + '\n' + row), {'kind': kind, 'evidence_quotes': [row]})

    def test_standalone_study_mode_stays_with_its_actual_education_record(self):
        row = '教育经历 合成学院 自动化 本科 2014 - 2018'
        mode = '学习形式：非全日制'
        self.assertEqual(decision(PREAMBLE + '\n' + row + '\n' + mode),
                         {'kind': 'non_full_time_bachelor', 'evidence_quotes': [row, mode]})

    def test_neighbouring_mode_does_not_cross_an_inline_section_boundary(self):
        row = '教育经历 合成学院 自动化 本科 2014 - 2018'
        for resume in (
            PREAMBLE + '\n学习形式：非全日制\n' + row,
            PREAMBLE + '\n工作经历 学习形式：非全日制\n' + row,
            PREAMBLE + '\n' + row + '\n工作经历 学习形式：非全日制',
            PREAMBLE + '\n' + row + '\n岗位要求 学习形式：非全日制',
        ):
            with self.subTest(resume=resume):
                self.assertEqual(decision(resume),
                                 {'kind': 'bachelor_default_full_time', 'evidence_quotes': [row]})

    def test_an_inline_new_section_ends_education_before_degree_like_work_or_job_text(self):
        bachelor = '教育经历 合成学院 自动化 本科 · 非全日制 2014 - 2018'
        for heading in ('工作经历', '项目经历', '个人简介', '专业技能', '岗位要求', '职位要求', 'JD'):
            # Deliberately terse text without a blocker keyword: the section
            # boundary, rather than incidental wording, must exclude it.
            outsider = heading + ' 合成大学 自动化 硕士 2020 - 2023'
            resume = PREAMBLE + '\n' + bachelor + '\n' + outsider
            with self.subTest(heading=heading):
                self.assertEqual(decision(resume),
                                 {'kind': 'non_full_time_bachelor', 'evidence_quotes': [bachelor]})

    def test_mixed_education_and_work_sections_are_not_one_degree_record(self):
        bachelor = '学历：本科 · 非全日制'
        for separator in ('；', '; ', ' | ', '\t', ' '):
            for heading in ('工作经历', '项目经历', '岗位要求', 'JD'):
                mixed = ('教育经历 合成大学 本科 2013 - 2017' + separator
                         + heading + ' 博士研发人员 2018 - 2025')
                resume = ('合成人员\n' + bachelor + '\n' + mixed
                          + '\n合成大学 自动化 硕士 2020 - 2023')
                with self.subTest(separator=separator, heading=heading):
                    self.assertEqual(decision(resume),
                                     {'kind': 'non_full_time_bachelor', 'evidence_quotes': [bachelor]})

    def test_mixed_job_and_education_context_requires_a_new_clear_heading(self):
        bachelor = '学历：本科 · 非全日制'
        for heading in ('岗位要求', '个人简介', '工作经历'):
            resume = ('合成人员\n' + bachelor + '\n' + heading
                      + ' 教育经历 合成大学 本科 2013 - 2017\n'
                      + '合成大学 自动化 硕士 2020 - 2023')
            with self.subTest(heading=heading):
                self.assertEqual(decision(resume),
                                 {'kind': 'non_full_time_bachelor', 'evidence_quotes': [bachelor]})
                row = '教育经历 合成大学 自动化 博士 2023 - 2026'
                self.assertEqual(decision(resume + '\n' + row),
                                 {'kind': 'eligible', 'evidence_quotes': [row]})

    def test_prose_containing_education_words_does_not_open_an_education_section(self):
        for prose in (
            '介绍教育经历 合成大学 自动化 硕士 2020 - 2023',
            '教育经历让我了解硕士研究方向',
            '岗位要求 教育经历 合成大学 自动化 硕士 2020 - 2023',
            '个人简介 教育经历 合成大学 自动化 硕士 2020 - 2023',
        ):
            with self.subTest(prose=prose):
                resume = PREAMBLE + '\n' + prose
                self.assertEqual(decision(resume), {'kind': 'unverified', 'evidence_quotes': []})
                self.assertEqual(verify_education_policy({'condition': POLICY, 'status': '满足'}, resume),
                                 UNVERIFIED_BACHELOR_ERROR)

    def test_inline_unfinished_planned_and_negated_degrees_do_not_establish_a_completed_degree(self):
        for degree in ('硕士在读', '硕士未毕业', '硕士未取得学位', '未取得硕士学位',
                       '计划攻读硕士', '准备报考硕士', '无硕士学位', '并非硕士', '硕士？'):
            resume = ('合成人员\n学历：本科 · 非全日制\n工作经历\n合成设备有限公司\n'
                      '教育经历 合成大学 自动化 ' + degree + ' 2020 - 2023')
            with self.subTest(degree=degree):
                self.assertEqual(decision(resume)['kind'], 'non_full_time_bachelor')
                self.assertEqual(verify_education_policy({'condition': POLICY, 'status': '满足'}, resume),
                                 NON_FULL_TIME_BACHELOR_ERROR)

    def test_inline_higher_degree_only_removes_the_study_mode_block_and_never_overrides_other_judgments(self):
        row = {'condition': POLICY, 'status': '不满足', 'support_score': 0,
               'reasoning': '合成岗位的专业方向尚不匹配。', 'evidence_quotes': ['原有合成依据']}
        before = deepcopy(row)
        resume = PREAMBLE + '\n教育经历 合成大学 机械工程 硕士 2020 - 2023'
        self.assertEqual(decision(resume)['kind'], 'eligible')
        self.assertIsNone(verify_education_policy(row, resume))
        self.assertEqual(row, before)


if __name__ == '__main__':
    unittest.main()
