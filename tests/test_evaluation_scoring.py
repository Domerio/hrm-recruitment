from copy import deepcopy
from decimal import Decimal, ROUND_HALF_UP
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluation_scoring import calculate_score, normalize_condition


def check(condition, status='满足', **metadata):
    return {'condition': condition, 'status': status, **metadata}


def partial_check(condition, **metadata):
    return check(condition, '信息不足', **{
        'basis': 'inferred',
        'reasoning': '项目中有相关任务，但不足以完整确认该项要求',
        'evidence': '负责相关项目的功能实现与交付',
        **metadata,
    })


class EvaluationScoringTests(unittest.TestCase):
    def test_all_three_judgments_follow_the_fixed_rule(self):
        result = calculate_score([
            check('Python 开发'), check('部署经验', '信息不足'), check('指定证书', '不满足'),
        ])
        self.assertEqual(result['score'], 33)
        scoring = result['scoring']
        self.assertEqual({key: scoring[key] for key in (
            'version', 'total', 'met', 'unknown', 'partial', 'no_evidence', 'not_met',
        )}, {
            'version': 'equal-weight-v4', 'total': 3, 'met': 1,
            'unknown': 1, 'partial': 0, 'no_evidence': 1, 'not_met': 1,
        })
        self.assertIn('50%', scoring['rule'])
        self.assertIn('全部条件计入分母', scoring['rule'])

    def test_extreme_and_unknown_scores(self):
        for status, expected in [('满足', 100), ('信息不足', 0), ('不满足', 0)]:
            with self.subTest(status=status):
                result = calculate_score([check('条件甲', status), check('条件乙', status)])
                self.assertEqual(result['score'], expected)
                self.assertIs(type(result['score']), int)

    def test_rounding_is_half_up_not_bankers_rounding(self):
        rows = [check('条件甲')] + [check(f'条件{index}', '不满足') for index in range(7)]
        self.assertEqual(calculate_score(rows)['score'], 13)  # 12.5 -> 13
        rows[0]['status'] = '信息不足'
        self.assertEqual(calculate_score(rows)['score'], 0)
        self.assertEqual(calculate_score([check('甲'), check('乙'), check('丙', '不满足')])['score'], 67)

    def test_all_small_judgment_distributions_match_decimal_half_up(self):
        for total in range(1, 21):
            for met in range(total + 1):
                for unknown in range(total - met + 1):
                    statuses = ['满足'] * met + ['信息不足'] * unknown + ['不满足'] * (total - met - unknown)
                    rows = [check(f'条件{index}', status) for index, status in enumerate(statuses)]
                    expected = int((Decimal(100 * met) / Decimal(total)).quantize(
                        Decimal('1'), rounding=ROUND_HALF_UP))
                    self.assertEqual(calculate_score(rows)['score'], expected, (total, met, unknown))

    def test_only_inferred_unknowns_with_reasoning_and_resolved_evidence_earn_half_credit(self):
        supported = [partial_check('相关经验'), partial_check(
            '相关经验', evidence='', evidence_quotes=['参与实际项目的部署工作']),
        ]
        for row in supported:
            with self.subTest(row=row):
                result = calculate_score([row])
                self.assertEqual(result['score'], 50)
                self.assertEqual((result['scoring']['met'], result['scoring']['unknown'],
                                  result['scoring']['partial'], result['scoring']['no_evidence']), (0, 1, 1, 0))
                self.assertEqual(result['scoring']['condition_scores'], [{
                    'condition': '相关经验', 'status': '信息不足', 'credit': 'partial',
                    'support_score': 50, 'ratio': 0.5, 'weight': 1, 'points': 0.5,
                }])
        for status, expected in [('满足', 100), ('不满足', 0)]:
            result = calculate_score([{**partial_check('相关经验'), 'status': status}])
            self.assertEqual(result['score'], expected)
            self.assertEqual((result['scoring']['partial'], result['scoring']['no_evidence']), (0, 0))

    def test_each_missing_partial_credit_prerequisite_earns_zero(self):
        baseline = partial_check('项目推测与相关经验')
        unsupported = []
        for key in ('basis', 'reasoning', 'evidence'):
            missing = deepcopy(baseline)
            missing.pop(key)
            unsupported.append(missing)
        for basis in (None, '', 'unknown', 'explicit', 'inferred ', 1, ['inferred']):
            unsupported.append({**baseline, 'basis': basis})
        for reasoning in (None, '', ' \t\n', 1, [], {}):
            unsupported.append({**baseline, 'reasoning': reasoning})
        for evidence in (None, '', ' \t\n', 1, [], {}):
            unsupported.append({**baseline, 'evidence': evidence})
        for quotes in (None, [], [''], [' \t\n'], [1], [None], [{}], '真实项目原文', ['原文', 1]):
            unsupported.append({**baseline, 'evidence': '', 'evidence_quotes': quotes})
        unsupported.extend([
            check('项目推测', '信息不足', basis='inferred', evidence_lines=[1], reasoning='有相关经验'),
            check('相关经验', '信息不足', basis='inferred', evidence_line=1, reasoning='有相关经验'),
            check('相关经验', '信息不足', basis='inferred', score=100, weight=99, reasoning='有项目部署经验'),
        ])
        for row in unsupported:
            with self.subTest(row=row):
                result = calculate_score([row])
                self.assertEqual(result['score'], 0)
                self.assertEqual((result['scoring']['unknown'], result['scoring']['partial'],
                                  result['scoring']['no_evidence']), (1, 0, 1))
                self.assertEqual(result['scoring']['condition_scores'][0]['credit'], 'none')

    def test_partial_distributions_match_decimal_half_up_with_all_requirements_in_denominator(self):
        for total in range(1, 13):
            for met in range(total + 1):
                for partial in range(total - met + 1):
                    for no_evidence in range(total - met - partial + 1):
                        rows = [check(f'满足{i}') for i in range(met)]
                        rows += [partial_check(f'部分{i}') for i in range(partial)]
                        rows += [check(f'未知{i}', '信息不足') for i in range(no_evidence)]
                        rows += [check(f'不满足{i}', '不满足') for i in range(total - len(rows))]
                        expected = int((Decimal(100 * met + 50 * partial) / Decimal(total)).quantize(
                            Decimal('1'), rounding=ROUND_HALF_UP))
                        result = calculate_score(rows)
                        self.assertEqual(result['score'], expected, (total, met, partial, no_evidence))
                        self.assertEqual(result['scoring']['unknown'], partial + no_evidence)

    def test_required_and_ordinary_copies_count_only_once(self):
        rows = [check('1. 熟练 C++ 开发'), check('图像处理经验', '信息不足')]
        required = [check('  •  熟练   c++\t开发  ')]
        result = calculate_score(rows, required)
        self.assertEqual(result['score'], 50)
        self.assertEqual(result['scoring']['total'], 2)
        self.assertEqual(result['scoring']['met'], 1)

    def test_duplicates_within_one_array_and_nested_prefixes_are_merged(self):
        rows = [check('1、 .NET 开发'), check('- .net 开发'), check('(2) * .NET 开发')]
        result = calculate_score(rows)
        self.assertEqual(result['score'], 100)
        self.assertEqual(result['scoring']['total'], 1)

    def test_same_condition_conflicting_status_is_rejected_in_either_array(self):
        for first, second in [('满足', '信息不足'), ('满足', '不满足'), ('信息不足', '不满足')]:
            for cross_array in (False, True):
                with self.subTest(first=first, second=second, cross_array=cross_array):
                    rows = [check('1. Python 开发', first)]
                    other = check('• python 开发', second)
                    required = [other] if cross_array else []
                    if not cross_array:
                        rows.append(other)
                    with self.assertRaises(ValueError):
                        calculate_score(rows, required)

    def test_same_unknown_condition_with_conflicting_credit_is_rejected_regardless_of_order(self):
        supported = partial_check('1. Python 开发')
        unsupported = check('• python 开发', '信息不足', basis='unknown')
        for first, second in ((supported, unsupported), (unsupported, supported)):
            for cross_array in (False, True):
                with self.subTest(first=first, cross_array=cross_array):
                    with self.assertRaisesRegex(ValueError, '冲突'):
                        calculate_score([first], [second]) if cross_array else calculate_score([first, second])

    def test_repeated_partial_required_condition_contributes_only_once(self):
        result = calculate_score(
            [partial_check('1. Python 开发'), check('交付经验')],
            [partial_check('• python 开发')],
        )
        self.assertEqual(result['score'], 75)
        self.assertEqual((result['scoring']['total'], result['scoring']['unknown'],
                          result['scoring']['partial']), (2, 1, 1))
        self.assertEqual(len(result['scoring']['condition_scores']), 2)

    def test_different_claims_are_not_fuzzily_merged(self):
        result = calculate_score([
            check('C++ 开发'), check('C# 开发', '信息不足'), check('C++ 熟练开发', '不满足'),
        ])
        self.assertEqual(result['scoring']['total'], 3)
        self.assertEqual(result['score'], 33)

    def test_decimal_experience_and_language_punctuation_are_preserved(self):
        self.assertEqual(normalize_condition('1.5年以上开发经验'), '1.5年以上开发经验')
        self.assertEqual(normalize_condition('1、 1.5年以上开发经验'), '1.5年以上开发经验')
        self.assertEqual(normalize_condition('.NET / C++ 开发'), '.net / c++ 开发')
        self.assertEqual(normalize_condition('*nix 系统'), '*nix 系统')
        self.assertEqual(normalize_condition('--help 参数'), '--help 参数')

    def test_fullwidth_prefix_and_unicode_whitespace_are_normalized(self):
        self.assertEqual(normalize_condition(' １． SQL\u3000\u00a0Server   开发\n经验 '), 'sql server 开发 经验')
        self.assertEqual(normalize_condition('２） C＃ 开发'), 'c# 开发')

    def test_no_conditions_and_empty_claims_are_rejected(self):
        with self.assertRaises(ValueError):
            calculate_score([], [])
        for invalid in ['', ' \t\n', '1. ', '•', '(1) - ', None, 0, {}, []]:
            for field in ('checks', 'required_checks'):
                with self.subTest(invalid=invalid, field=field):
                    ordinary = [check(invalid)] if field == 'checks' else []
                    required = [check(invalid)] if field == 'required_checks' else []
                    with self.assertRaises(ValueError):
                        calculate_score(ordinary, required)

    def test_missing_fields_unknown_statuses_and_wrong_types_are_rejected(self):
        for invalid in [None, '满足', 1, {}, {'condition': '开发'}, {'status': '满足'},
                        check('开发', '部分满足'), check('开发', '满足 '),
                        check('开发', None), check('开发', []), check('开发', True)]:
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    calculate_score([invalid])
        for invalid in [None, {}, 'conditions', 0, iter([])]:
            with self.subTest(container=invalid):
                with self.assertRaises(ValueError):
                    calculate_score(invalid)
                with self.assertRaises(ValueError):
                    calculate_score([], invalid)

    def test_required_only_is_valid_and_metadata_cannot_change_score(self):
        result = calculate_score([], [check('必备条件', '信息不足', score=100, weight=99)])
        self.assertEqual(result['score'], 0)
        self.assertEqual(result['scoring']['total'], 1)

    def test_inputs_are_immutable_and_order_does_not_affect_results(self):
        rows = [check('甲', '满足', evidence_lines=[1]), check('乙', '信息不足')]
        required = [check('1. 甲', '满足'), check('丙', '不满足')]
        original = deepcopy((rows, required))
        expected = calculate_score(rows, required)
        self.assertEqual((rows, required), original)
        self.assertEqual(calculate_score(list(reversed(rows)), list(reversed(required))), expected)
        self.assertEqual(calculate_score(rows, required), expected)

    def test_priority_order_changes_weights_and_exposes_the_layout(self):
        rows = [check('Python 开发'), check('指定证书', '不满足')]
        high_met = calculate_score(rows, priority_groups=[['Python 开发'], ['指定证书']])
        high_failed = calculate_score(rows, priority_groups=[['指定证书'], ['Python 开发']])
        self.assertEqual((high_met['score'], high_failed['score']), (67, 33))
        scoring = high_met['scoring']
        self.assertEqual(scoring['version'], 'priority-weight-v4')
        self.assertEqual((scoring['total'], scoring['met'], scoring['unknown'], scoring['not_met']), (2, 1, 0, 1))
        self.assertEqual((scoring['weighted_total'], scoring['weighted_met'],
                          scoring['weighted_unknown'], scoring['weighted_not_met']), (3, 2, 0, 1))
        self.assertEqual(scoring['priority_groups'], [
            {'priority': 1, 'weight': 2, 'conditions': ['Python 开发']},
            {'priority': 2, 'weight': 1, 'conditions': ['指定证书']},
        ])

    def test_same_group_is_equal_and_unknown_keeps_its_weight_in_denominator(self):
        rows = [check('甲'), check('乙', '不满足'), check('丙', '信息不足')]
        result = calculate_score(rows, priority_groups=[['甲'], ['乙', '丙']])
        self.assertEqual(result['score'], 50)  # (2*1 + 1*0 + 1*0) / 4 = 50%
        self.assertEqual(result['scoring']['weighted_total'], 4)
        reversed_inside = calculate_score(rows, priority_groups=[['甲'], ['丙', '乙']])
        self.assertEqual(result['score'], reversed_inside['score'])

    def test_priority_weights_apply_to_partial_credit_and_keep_all_unknown_weight(self):
        rows = [partial_check('甲'), check('乙'), check('丙', '信息不足'), check('丁', '不满足')]
        result = calculate_score(rows, priority_groups=[['甲'], ['乙'], ['丙', '丁']])
        self.assertEqual(result['score'], 50)  # (3*0.5 + 2*1) / (3+2+1+1)
        scoring = result['scoring']
        self.assertEqual((scoring['total'], scoring['met'], scoring['unknown'], scoring['partial'],
                          scoring['no_evidence'], scoring['not_met']), (4, 1, 2, 1, 1, 1))
        self.assertEqual((scoring['weighted_total'], scoring['weighted_met'], scoring['weighted_unknown'],
                          scoring['weighted_partial'], scoring['weighted_no_evidence'],
                          scoring['weighted_not_met']), (7, 2, 4, 3, 1, 1))
        contributions = {row['condition']: row for row in scoring['condition_scores']}
        self.assertEqual((contributions['甲']['weight'], contributions['甲']['points']), (3, 1.5))
        self.assertEqual((contributions['乙']['weight'], contributions['乙']['points']), (2, 2))
        self.assertEqual((contributions['丙']['credit'], contributions['丙']['ratio']), ('none', 0))

    def test_partial_percent_ties_round_half_up_in_equal_and_priority_scores(self):
        rows = [partial_check('甲')] + [check(f'其他{i}', '信息不足') for i in range(3)]
        self.assertEqual(calculate_score(rows)['score'], 13)  # 0.5 / 4 = 12.5%
        rows = [partial_check('甲')] + [check(f'其他{i}', '信息不足') for i in range(4)]
        result = calculate_score(rows, priority_groups=[['甲', '其他0', '其他1'], ['其他2', '其他3']])
        self.assertEqual(result['scoring']['weighted_total'], 8)
        self.assertEqual(result['score'], 13)  # (2 * 0.5) / 8 = 12.5%

    def test_partial_credit_cannot_outscore_complete_support(self):
        none = [check('甲', '信息不足'), check('乙'), check('丙', '不满足')]
        partial = [partial_check('甲'), *deepcopy(none[1:])]
        met = [check('甲'), *deepcopy(none[1:])]
        for groups in (None, [['甲'], ['乙', '丙']]):
            scores = [calculate_score(rows, priority_groups=groups)['score'] for rows in (none, partial, met)]
            self.assertLess(scores[0], scores[1])
            self.assertLess(scores[1], scores[2])

    def test_partial_inputs_and_group_arrays_are_immutable(self):
        rows = [partial_check('甲', evidence_quotes=['真实项目原文']), check('乙', '信息不足')]
        required = [partial_check('1. 甲')]
        groups = [['甲'], ['乙']]
        original = deepcopy((rows, required, groups))
        expected = calculate_score(rows, required, priority_groups=groups)
        self.assertEqual((rows, required, groups), original)
        self.assertEqual(calculate_score(list(reversed(rows)), required, priority_groups=groups), expected)
        self.assertEqual(calculate_score(rows, required, priority_groups=groups), expected)

    def test_weighted_rounding_is_half_up(self):
        rows = [check('甲', '不满足'), check('乙', '信息不足'), check('丙', '信息不足'),
                check('丁'), check('戊', '信息不足')]
        result = calculate_score(rows, priority_groups=[['甲', '乙', '丙'], ['丁', '戊']])
        self.assertEqual(result['scoring']['weighted_total'], 8)
        self.assertEqual(result['scoring']['weighted_met'], 1)
        self.assertEqual(result['score'], 13)  # 1 / 8 = 12.5% -> 13

    def test_omitting_facts_cannot_outscore_disclosing_unmet_conditions(self):
        missing = [check('核心经验')] + [check(f'要求{index}', '信息不足') for index in range(1, 5)]
        disclosed = [check('核心经验')] + [check(f'要求{index}', '不满足') for index in range(1, 5)]
        more_met = deepcopy(disclosed)
        more_met[1]['status'] = '满足'
        for groups in (None, [[row['condition']] for row in missing]):
            with self.subTest(priority_groups=groups):
                incomplete_score = calculate_score(missing, priority_groups=groups)['score']
                disclosed_score = calculate_score(disclosed, priority_groups=groups)['score']
                more_met_score = calculate_score(more_met, priority_groups=groups)['score']
                self.assertEqual(incomplete_score, disclosed_score)
                self.assertGreater(more_met_score, incomplete_score)

    def test_adding_unknown_conditions_does_not_raise_score_or_remove_denominator_weight(self):
        rows = [check('甲'), check('乙', '不满足'), check('丙')]
        ordinary = calculate_score(rows)
        with_unknown = calculate_score(rows + [check('丁', '信息不足')])
        self.assertEqual((ordinary['score'], with_unknown['score']), (67, 50))
        self.assertEqual(with_unknown['scoring']['total'], 4)
        grouped = calculate_score(rows, priority_groups=[['甲', '乙'], ['丙']])
        group_with_unknown = calculate_score(rows + [check('丁', '信息不足')],
                                             priority_groups=[['甲', '乙', '丁'], ['丙']])
        self.assertEqual((grouped['score'], group_with_unknown['score']), (60, 43))
        self.assertEqual(group_with_unknown['scoring']['weighted_total'], 7)
        self.assertEqual(group_with_unknown['scoring']['weighted_unknown'], 2)

    def test_all_weighted_unknowns_without_complete_support_earn_zero_even_with_model_metadata(self):
        rows = [check('甲', '信息不足', evidence='有相关项目但不足以确认', basis='inferred', score=100),
                check('乙', '信息不足', basis='unknown'), check('丙', '信息不足', weight=99)]
        result = calculate_score(rows, priority_groups=[['甲', '乙'], ['丙']])
        self.assertEqual(result['score'], 0)
        self.assertEqual((result['scoring']['total'], result['scoring']['unknown']), (3, 3))
        self.assertEqual((result['scoring']['weighted_total'], result['scoring']['weighted_unknown']), (5, 5))
        self.assertEqual((result['scoring']['weighted_partial'], result['scoring']['weighted_no_evidence']), (0, 5))

    def test_none_or_empty_priorities_preserve_the_existing_contract(self):
        rows = [check('甲'), check('乙', '信息不足')]
        expected = calculate_score(rows)
        self.assertEqual(calculate_score(rows, priority_groups=None), expected)
        self.assertEqual(calculate_score(rows, priority_groups=[]), expected)
        grouped = calculate_score(rows, priority_groups=[['甲', '乙']])
        self.assertEqual(grouped['score'], expected['score'])
        self.assertEqual(grouped['scoring']['version'], 'priority-weight-v4')
        self.assertEqual(grouped['scoring']['weighted_total'], 2)

    def test_priority_groups_reject_missing_extra_duplicate_empty_and_invalid_values(self):
        rows = [check('Python 开发'), check('C++ 开发')]
        invalid_groups = [
            [['Python 开发']], [['Python 开发'], ['不存在的条件']],
            [['Python 开发'], ['1. python   开发', 'C++ 开发']],
            [[], ['Python 开发', 'C++ 开发']],
            [['Python 开发'], ['C++ 开发'], ['额外分组']],
            [['Python 开发', None], ['C++ 开发']],
            [['Python 开发', ' '], ['C++ 开发']],
            ['Python 开发', ['C++ 开发']], {}, False, 'Python 开发', (['Python 开发', 'C++ 开发'],),
        ]
        for groups in invalid_groups:
            with self.subTest(groups=groups):
                with self.assertRaises(ValueError):
                    calculate_score(rows, priority_groups=groups)

    def test_priorities_cover_unique_required_and_ordinary_conditions_without_mutation(self):
        rows = [check('1. Python 开发')]
        required = [check('python 开发'), check('交付经验', '信息不足')]
        groups = [['交付经验'], ['• PYTHON 开发']]
        original = deepcopy((rows, required, groups))
        result = calculate_score(rows, required, priority_groups=groups)
        self.assertEqual(result['score'], 33)
        self.assertEqual(result['scoring']['total'], 2)
        self.assertEqual(result['scoring']['priority_groups'][1]['conditions'], ['1. Python 开发'])
        self.assertEqual((rows, required, groups), original)

    def test_partial_support_scores_use_every_ten_percent_step_without_collapsing_to_half(self):
        for percent in range(10, 100, 10):
            with self.subTest(support_score=percent):
                row = partial_check('相关项目经验', support_score=percent, score=100, weight=99)
                before = deepcopy(row)
                result = calculate_score([row])
                self.assertEqual(result['score'], percent)
                self.assertEqual(result['scoring']['condition_scores'], [{
                    'condition': '相关项目经验', 'status': '信息不足', 'credit': 'partial',
                    'support_score': percent, 'ratio': percent / 100, 'weight': 1, 'points': percent / 100,
                }])
                self.assertEqual((result['scoring']['partial'], result['scoring']['no_evidence']), (1, 0))
                self.assertEqual(row, before)
                mixed = calculate_score([row, check('完整条件'), check('未知条件', '信息不足'),
                                         check('未达条件', '不满足')])
                expected = int((Decimal(100 + percent) / Decimal(4)).quantize(
                    Decimal('1'), rounding=ROUND_HALF_UP))
                self.assertEqual(mixed['score'], expected)
                self.assertEqual((mixed['scoring']['total'], mixed['scoring']['unknown'],
                                  mixed['scoring']['partial'], mixed['scoring']['no_evidence']), (4, 2, 1, 1))

    def test_granular_partial_scores_keep_priority_weights_and_exact_contributions(self):
        rows = [partial_check('最高优先', support_score=70), partial_check('次优先', support_score=30),
                check('完整低优先', support_score=100), check('未知低优先', '信息不足', support_score=0)]
        result = calculate_score(rows, priority_groups=[['最高优先'], ['次优先'], ['完整低优先', '未知低优先']])
        self.assertEqual(result['score'], 53)  # (3*.7 + 2*.3 + 1*1 + 1*0) / 7
        scoring = result['scoring']
        self.assertEqual((scoring['total'], scoring['met'], scoring['unknown'], scoring['partial'],
                          scoring['no_evidence'], scoring['not_met']), (4, 1, 3, 2, 1, 0))
        self.assertEqual((scoring['weighted_total'], scoring['weighted_met'], scoring['weighted_unknown'],
                          scoring['weighted_partial'], scoring['weighted_no_evidence']), (7, 1, 6, 5, 1))
        contributions = {row['condition']: row for row in scoring['condition_scores']}
        self.assertEqual((contributions['最高优先']['support_score'], contributions['最高优先']['points']), (70, 2.1))
        self.assertEqual((contributions['次优先']['ratio'], contributions['次优先']['points']), (0.3, 0.6))
        self.assertEqual((contributions['完整低优先']['credit'], contributions['完整低优先']['support_score']), ('full', 100))
        self.assertEqual((contributions['未知低优先']['credit'], contributions['未知低优先']['support_score']), ('none', 0))

    def test_granular_partial_ties_round_half_up_for_equal_and_priority_weights(self):
        for percent, expected in ((10, 3), (30, 8), (70, 18), (90, 23)):
            with self.subTest(support_score=percent):
                rows = [partial_check('部分', support_score=percent)]
                rows += [check(f'未知{i}', '信息不足') for i in range(3)]
                self.assertEqual(calculate_score(rows)['score'], expected)
                rows.append(check('未知3', '信息不足'))
                weighted = calculate_score(rows, priority_groups=[['部分', '未知0', '未知1'], ['未知2', '未知3']])
                self.assertEqual(weighted['scoring']['weighted_total'], 8)
                self.assertEqual(weighted['score'], expected)

    def test_granular_scores_match_decimal_rounding_across_priority_distributions(self):
        for first in range(10, 100, 10):
            for second in range(10, 100, 10):
                rows = [partial_check('甲', support_score=first), partial_check('乙', support_score=second),
                        check('丙', '不满足'), check('丁', '信息不足')]
                for groups, expected_total, earned in (
                        (None, 4, first + second),
                        ([['甲'], ['乙', '丙'], ['丁']], 8, 3 * first + 2 * second)):
                    result = calculate_score(rows, priority_groups=groups)
                    expected = int((Decimal(earned) / Decimal(expected_total)).quantize(
                        Decimal('1'), rounding=ROUND_HALF_UP))
                    self.assertEqual(result['score'], expected, (first, second, groups))

    def test_support_score_requires_an_actual_integer_step_and_never_clamps_invalid_values(self):
        for invalid in (None, True, False, '50', 50.0, -10, 110, 5, 99, float('nan'), float('inf'), [], {}):
            for baseline in (check('满足条件'), check('未达条件', '不满足'),
                             check('未知条件', '信息不足'), partial_check('有证据条件')):
                with self.subTest(invalid=invalid, status=baseline['status']):
                    with self.assertRaisesRegex(ValueError, r'checks\[0\]\.support_score'):
                        calculate_score([{**baseline, 'support_score': invalid}])

    def test_support_scores_contradicting_status_or_evidence_gate_are_rejected(self):
        cases = [check('完整条件', support_score=percent) for percent in (0, 10, 50, 90)]
        cases += [check('未达条件', '不满足', support_score=percent) for percent in (10, 50, 90, 100)]
        cases += [partial_check('部分条件', support_score=percent) for percent in (0, 100)]
        cases += [check('未知条件', '信息不足', support_score=percent) for percent in (10, 50, 90, 100)]
        for row in cases:
            with self.subTest(row=row):
                with self.assertRaisesRegex(ValueError, 'support_score'):
                    calculate_score([row])
        explicit = calculate_score([check('完整条件', support_score=100),
                                    check('未达条件', '不满足', support_score=0),
                                    check('未知条件', '信息不足', support_score=0)])
        self.assertEqual(explicit['score'], 33)
        self.assertEqual(explicit['scoring']['no_evidence'], 1)

    def test_claimed_high_support_without_each_resolved_evidence_prerequisite_is_rejected(self):
        baseline = partial_check('待确认经验', support_score=90)
        rows = [{key: value for key, value in baseline.items() if key != missing}
                for missing in ('basis', 'reasoning', 'evidence')]
        rows += [{**baseline, **override} for override in (
            {'basis': 'unknown'}, {'basis': 'explicit'}, {'reasoning': '   '},
            {'evidence': '', 'evidence_lines': [1]},
            {'evidence': '', 'evidence_line': 1},
            {'evidence': '', 'evidence_quotes': ['真实原文', '']},
            {'evidence': '', 'evidence_quotes': ['真实原文', 1]},
        )]
        for row in rows:
            with self.subTest(row=row):
                with self.assertRaisesRegex(ValueError, 'support_score'):
                    calculate_score([row])
        with self.assertRaisesRegex(ValueError, r'required_checks\[0\]\.support_score'):
            calculate_score([], [check('必需经验', '信息不足', support_score=90)])

    def test_granular_duplicate_credit_is_consistent_across_ordinary_and_required_conditions(self):
        for first, second in ((30, 70), (70, 30), (10, 90), (90, 10)):
            for cross_array in (False, True):
                with self.subTest(first=first, second=second, cross_array=cross_array):
                    a = partial_check('1. Python 开发', support_score=first)
                    b = partial_check('• python 开发', support_score=second)
                    with self.assertRaisesRegex(ValueError, '冲突'):
                        calculate_score([a], [b]) if cross_array else calculate_score([a, b])
        rows = [partial_check('1. Python 开发', support_score=70), check('交付经验')]
        required = [partial_check('• python 开发', support_score=70)]
        original = deepcopy((rows, required))
        result = calculate_score(rows, required)
        self.assertEqual((result['score'], result['scoring']['total'], result['scoring']['partial']), (85, 2, 1))
        self.assertEqual((rows, required), original)

    def test_legacy_half_credit_and_explicit_fifty_percent_deduplicate_identically(self):
        legacy = partial_check('1. 相关项目经验')
        explicit = partial_check('相关项目经验', support_score=50)
        for rows, required in (([legacy, explicit], []), ([legacy], [explicit]), ([explicit], [legacy])):
            result = calculate_score(rows, required)
            self.assertEqual((result['score'], result['scoring']['total'], result['scoring']['partial']), (50, 1, 1))


if __name__ == '__main__':
    unittest.main()
