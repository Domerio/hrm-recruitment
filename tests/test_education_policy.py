"""Synthetic-only checks for the explicitly configured education policy."""

from copy import deepcopy
import unittest

from education_policy import (
    NON_FULL_TIME_BACHELOR_ERROR, UNVERIFIED_BACHELOR_ERROR,
    education_policy_decision, verify_education_policy,
)


POLICY = '本科及以上学历，本科须全日制，不接受本科非全日制；硕士及以上可非全日制。'


def check(condition=POLICY, status='满足'):
    return {'condition': condition, 'status': status, 'reasoning': '合成判断'}


class EducationPolicyTests(unittest.TestCase):
    def test_explicit_non_full_time_bachelor_returns_static_error_without_mutation(self):
        row = check()
        before = deepcopy(row)
        resume = '合成人员\n8年 · 本科\n教育经历\n合成大学\n机械工程\n本科 · 非全日制\n2016 - 2020'
        self.assertEqual(verify_education_policy(row, resume), NON_FULL_TIME_BACHELOR_ERROR)
        self.assertEqual(row, before)

    def test_full_time_is_not_matched_inside_non_full_time(self):
        for mode, error in [('全日制', None), ('非全日制', NON_FULL_TIME_BACHELOR_ERROR)]:
            for text in (f'学历：本科（{mode}）', f'教育背景\n合成大学 机械 本科 / {mode}',
                         f'教育经历\n合成大学\n本科\n学习形式：{mode}'):
                with self.subTest(text=text):
                    self.assertEqual(verify_education_policy(check(), text), error)

    def test_non_full_time_master_and_doctorate_are_allowed(self):
        for degree in ('硕士', '硕士研究生', '博士', '研究生'):
            with self.subTest(degree=degree):
                self.assertIsNone(verify_education_policy(check(), f'学历：{degree} · 非全日制'))

    def test_higher_qualification_overrides_non_full_time_bachelor_in_either_order(self):
        bachelor = '合成本科大学\n计算机科学与技术\n本科 · 非全日制\n2012 - 2016'
        master = '合成硕士大学\n机械工程\n硕士 · 非全日制\n2017 - 2020'
        for text in (bachelor + '\n' + master, master + '\n' + bachelor):
            with self.subTest(text=text):
                self.assertIsNone(verify_education_policy(check(), '教育经历\n' + text))
        self.assertIsNone(verify_education_policy(check(), '学历：本科\n教育经历\n硕士 非全日制'))

    def test_degree_modes_do_not_cross_between_degrees(self):
        self.assertIsNone(verify_education_policy(check(), '学历：本科全日制 / 硕士非全日制'))
        self.assertIsNone(verify_education_policy(check(), '教育经历\n本科非全日制；硕士全日制'))
        text = '学历：本科全日制\n教育经历\n合成学院\n大专 非全日制'
        self.assertIsNone(verify_education_policy(check(), text))
        self.assertIsNone(verify_education_policy(check(), '教育经历\n本科全日制；大专非全日制'))

    def test_real_bachelor_without_explicit_mode_uses_full_time_default(self):
        for text in ('学历：本科', '教育经历\n合成大学\n机械工程\n本科\n2012 - 2016',
                     '学历：本科 · 在职-考虑机会', '学历：本科\n学习形式尚未说明',
                     '学历：本科（全日制未注明）', '学历：本科（非全日制未明确）',
                     '学历：本科（非全日制未标注）'):
            with self.subTest(text=text):
                decision = education_policy_decision(POLICY, text)
                self.assertEqual(decision['kind'], 'bachelor_default_full_time')
                self.assertIsNone(verify_education_policy(check(), text))
                self.assertTrue(decision['evidence_quotes'])
                for quote in decision['evidence_quotes']:
                    self.assertIn(quote, text)
                self.assertNotIn('默认全日制', '\n'.join(decision['evidence_quotes']))

    def test_question_and_conflicting_modes_are_unverified_never_hard_rejected(self):
        for text in ('学历：本科（是否全日制：待核实）',
                     '学历：本科（全日制/非全日制待确认）',
                     '学历：本科（非全日制？）', '学历：本科（是否非全日制）',
                     '教育经历\n本科\n学习形式：全日制/非全日制',
                     '学历：本科全日制\n教育经历\n本科非全日制'):
            with self.subTest(text=text):
                self.assertEqual(education_policy_decision(POLICY, text)['kind'], 'unverified')
                self.assertEqual(verify_education_policy(check(), text), UNVERIFIED_BACHELOR_ERROR)
        for text in ('学历：本科（不属于全日制）', '学历：本科（全日制：否）'):
            with self.subTest(text=text):
                self.assertEqual(verify_education_policy(check(), text), NON_FULL_TIME_BACHELOR_ERROR)

    def test_missing_or_unearned_degree_cannot_receive_the_bachelor_default(self):
        for text in ('', '教育经历\n合成本科大学\n机械工程', '学历：大专',
                     '学历：本科在读', '学历：硕士？', '学历：本科待核实',
                     '学历：本科（学位未知）', '岗位要求\n' + POLICY):
            with self.subTest(text=text):
                decision = education_policy_decision(POLICY, text)
                self.assertEqual(decision, {'kind': 'unverified', 'evidence_quotes': []})

    def test_canonical_evidence_retains_separate_degree_and_mode_lines(self):
        for text, quotes in (
            ('合成人员\n教育经历\n合成大学\n机械工程\n本科\n学习形式：非全日制',
             ['本科', '学习形式：非全日制']),
            ('教育经历\n合成大学\n学习形式：非全日制\n本科',
             ['本科', '学习形式：非全日制']),
            ('学历：本科\n教育经历\n合成大学\n本科 · 非全日制',
             ['本科 · 非全日制']),
        ):
            with self.subTest(text=text):
                self.assertEqual(education_policy_decision(POLICY, text),
                                 {'kind': 'non_full_time_bachelor', 'evidence_quotes': quotes})
                self.assertTrue(all(quote in text for quote in quotes))

    def test_eligible_evidence_uses_actual_higher_degree_without_changing_other_judgments(self):
        resume = '学历：本科非全日制\n教育经历\n合成大学\n机械工程\n硕士\n非全日制'
        self.assertEqual(education_policy_decision(POLICY, resume),
                         {'kind': 'eligible', 'evidence_quotes': ['硕士', '非全日制']})
        row = {**check(status='不满足'), 'reasoning': '所学专业不符合岗位要求。', 'support_score': 0}
        before = deepcopy(row)
        self.assertIsNone(verify_education_policy(row, resume))
        self.assertEqual(row, before)

    def test_unconfigured_policy_returns_no_override_or_invented_evidence(self):
        self.assertEqual(education_policy_decision('本科及以上学历', '学历：本科非全日制'),
                         {'kind': 'eligible', 'evidence_quotes': []})

    def test_incomplete_or_future_master_does_not_establish_a_higher_degree(self):
        for text in ('硕士在读', '硕士未毕业', '硕士未取得学位', '未取得硕士学位',
                     '计划攻读硕士', '准备报考硕士'):
            resume = '学历：本科非全日制\n教育经历\n合成大学\n' + text
            with self.subTest(text=text):
                self.assertEqual(verify_education_policy(check(), resume), NON_FULL_TIME_BACHELOR_ERROR)
        for text in ('学历：本科非全日制（无硕士学位）', '学历：本科非全日制，并非硕士',
                     '教育经历\n合成大学研究生院\n本科 非全日制'):
            with self.subTest(text=text):
                self.assertEqual(verify_education_policy(check(), text), NON_FULL_TIME_BACHELOR_ERROR)

    def test_quoted_requirements_and_unrelated_work_prose_are_not_qualifications(self):
        for text in ('岗位要求\n' + POLICY, '教育经历\n招聘要求：' + POLICY,
                     '个人简介\n曾辅导硕士研究生\n工作经历\n负责非全日制本科课程平台',
                     '期望职位\n硕士非全日制\n工作经历\n本科全日制'):
            with self.subTest(text=text):
                self.assertEqual(verify_education_policy(check(), text), UNVERIFIED_BACHELOR_ERROR)
        resume = '学历：本科非全日制\n岗位要求\n' + POLICY
        self.assertEqual(verify_education_policy(check(), resume), NON_FULL_TIME_BACHELOR_ERROR)

    def test_only_the_explicit_combined_policy_activates(self):
        for condition in ('本科及以上学历', '本科全日制优先', '本科须全日制',
                          '硕士及以上可非全日制', '学历不限，可非全日制',
                          '熟悉全日制与非全日制本科课程开发'):
            with self.subTest(condition=condition):
                self.assertIsNone(verify_education_policy(check(condition), '学历：本科非全日制'))
        for condition in ('本科要求全日制；硕士及以上可接受非全日制',
                          '不接受非全日制本科；硕士及以上允许非全日制',
                          '不接受本科非全日制；硕士以上接受非全日制'):
            with self.subTest(condition=condition):
                self.assertEqual(verify_education_policy(check(condition), '学历：本科非全日制'),
                                 NON_FULL_TIME_BACHELOR_ERROR)

    def test_unmet_and_unverified_mode_unknown_judgments_remain_unchanged(self):
        for status in ('不满足', '信息不足', None):
            row = check(status=status)
            before = deepcopy(row)
            self.assertIsNone(verify_education_policy(row, '学历：本科'))
            self.assertEqual(row, before)

    def test_known_excluded_degree_cannot_be_unknown_or_receive_partial_credit(self):
        for status in ('满足', '信息不足'):
            row = {**check(status=status), 'points_awarded': 30, 'points_possible': 50}
            before = deepcopy(row)
            self.assertEqual(verify_education_policy(row, '学历：本科非全日制'),
                             NON_FULL_TIME_BACHELOR_ERROR)
            self.assertEqual(row, before)

    def test_known_excluded_degree_accepts_an_unmet_judgment(self):
        row = {**check(status='不满足'), 'points_awarded': 0, 'points_possible': 50}
        self.assertIsNone(verify_education_policy(row, '学历：本科非全日制'))

    def test_errors_do_not_echo_private_resume_or_condition(self):
        marker = 'SYNTHETIC_PRIVATE_PERSON_AND_SCHOOL'
        result = verify_education_policy(check(POLICY + marker), '学历：本科非全日制\n' + marker)
        self.assertEqual(result, NON_FULL_TIME_BACHELOR_ERROR)
        self.assertNotIn(marker, result)


if __name__ == '__main__':
    unittest.main()
