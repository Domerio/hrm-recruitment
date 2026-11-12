"""Synthetic checks for narrowly declared experience-duration contradictions."""

from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from experience_consistency import check_declared_experience


def check(reasoning, condition='2. 4年以上机器视觉相关开发经验', status='满足'):
    return {'condition': condition, 'status': status, 'reasoning': reasoning}


class DeclaredExperienceConsistencyTests(unittest.TestCase):
    def test_explicit_forty_four_months_cannot_satisfy_four_years(self):
        row = check('第一段34个月，第二段10个月，合计约44个月，超过4年，满足要求。')
        before = deepcopy(row)
        with self.assertRaisesRegex(ValueError, r'44个月.*48个月'):
            check_declared_experience(row)
        self.assertEqual(row, before)

    def test_all_explicit_total_markers_and_minimum_wordings_are_checked(self):
        for marker in ('合计', '总计', '累计', '共计'):
            for requirement in ('4年以上', '至少4年', '4年及以上'):
                with self.subTest(marker=marker, requirement=requirement):
                    with self.assertRaises(ValueError):
                        check_declared_experience(check(f'{marker}相关开发经验约44个月。', requirement))

    def test_year_and_month_total_is_compared_in_months(self):
        with self.assertRaisesRegex(ValueError, r'44个月.*48个月'):
            check_declared_experience(check('累计3年8个月相关开发经验。'))
        for total in ('48个月', '4年', '4年0个月', '4年1个月', '49个月'):
            with self.subTest(total=total):
                self.assertIsNone(check_declared_experience(check('总计' + total + '。')))

    def test_decimal_year_threshold_and_total_are_exact(self):
        for total in ('54个月', '4.5年', '4年6个月'):
            with self.subTest(total=total):
                self.assertIsNone(check_declared_experience(check('共计' + total + '。', '至少4.5年开发经验')))
        for total in ('53个月', '4.4年', '4年5个月'):
            with self.subTest(total=total):
                with self.assertRaises(ValueError):
                    check_declared_experience(check('累计' + total + '。', '4.5年及以上开发经验'))

    def test_individual_stages_and_project_durations_are_not_a_declared_total(self):
        cases = [
            '第一段34个月，第二段10个月，项目持续12个月，认定满足。',
            '2022.10至2025.08有34个月，2025.11至2026.09有10个月。',
            '合计2段工作，第一段34个月，第二段10个月。',
            '累计项目包括甲项目12个月和乙项目36个月。',
            '4年以上经验，具备相关开发能力。',
            '合计34个月+10个月，结合其他任职满足要求。',
            '合计34个月和10个月，结合其他任职满足要求。',
        ]
        for reasoning in cases:
            with self.subTest(reasoning=reasoning):
                self.assertIsNone(check_declared_experience(check(reasoning)))

    def test_multiple_declared_totals_use_the_largest(self):
        self.assertIsNone(check_declared_experience(check('前两段合计44个月；所有相关任职累计54个月。')))
        self.assertIsNone(check_declared_experience(check('所有相关任职累计4年；前两段合计44个月。')))
        with self.assertRaisesRegex(ValueError, r'47个月.*48个月'):
            check_declared_experience(check('前两段合计44个月；全部累计47个月。'))

    def test_unknown_partial_and_unmet_judgments_are_never_changed(self):
        for status in ('信息不足', '不满足'):
            for basis in ('unknown', 'inferred', 'explicit'):
                with self.subTest(status=status, basis=basis):
                    row = {**check('合计44个月。', status=status), 'basis': basis,
                           'evidence': '合成原文', 'reasoning': '合计44个月。'}
                    before = deepcopy(row)
                    self.assertIsNone(check_declared_experience(row))
                    self.assertEqual(row, before)

    def test_no_explicit_minimum_or_no_declared_total_does_not_trigger(self):
        for condition in ('3-5年开发经验', '3至5年开发经验', '相关开发经验', '4年开发经验'):
            with self.subTest(condition=condition):
                self.assertIsNone(check_declared_experience(check('累计12个月。', condition)))
        for reasoning in ('', '约44个月，结合项目经验符合要求。', '相关经验约3年8个月。'):
            with self.subTest(reasoning=reasoning):
                self.assertIsNone(check_declared_experience(check(reasoning)))

    def test_list_numbers_do_not_become_the_minimum_years(self):
        with self.assertRaisesRegex(ValueError, r'44个月.*48个月'):
            check_declared_experience(check('合计44个月。', '10. 4年以上开发经验'))
        self.assertIsNone(check_declared_experience(check('合计48个月。', '10. 4年以上开发经验')))

    def test_lower_bound_totals_are_not_misread_as_an_exact_insufficient_duration(self):
        for phrase in ('超过44个月', '至少44个月', '不少于44个月', '预计44个月'):
            with self.subTest(phrase=phrase):
                self.assertIsNone(check_declared_experience(check('累计' + phrase + '。')))

    def test_error_contains_only_static_text_and_duration_numbers(self):
        private_marker = 'SYNTHETIC_PRIVATE_PERSON_AND_PROJECT'
        with self.assertRaises(ValueError) as error:
            check_declared_experience(check(private_marker + '，合计44个月。', '4年以上' + private_marker))
        self.assertEqual(str(error.exception), '声明的累计时长44个月低于最低年限要求48个月')
        self.assertNotIn(private_marker, str(error.exception))


if __name__ == '__main__':
    unittest.main()
