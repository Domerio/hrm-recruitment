"""Repeated copied source lines do not become repeated supporting evidence."""
from copy import deepcopy
import unittest

import server


CONDITIONS = ['视觉开发与项目交付经验', '指定专业证书']
GROUPS = ('checks', 'required_checks', 'inferred_capabilities')


def answer(indices):
    return {
        'score':99, 'category':'推荐', 'summary':'合成原文中的开发与交付任务可供核实。', 'questions':[],
        'checks':[
            {'condition_id':1, 'condition':CONDITIONS[0], 'status':'满足', 'basis':'explicit',
             'evidence_lines':list(indices)},
            {'condition_id':2, 'condition':CONDITIONS[1], 'status':'信息不足', 'basis':'unknown',
             'evidence_lines':[]},
        ],
        'required_checks':[
            {'requirement_id':1, 'condition':CONDITIONS[0], 'status':'满足', 'basis':'explicit',
             'evidence_lines':list(indices)},
        ],
        'inferred_capabilities':[
            {'capability':'视觉开发与交付协作', 'reasoning':'根据本人开发与交付任务发现可核实线索。',
             'question':'请说明本人承担的开发和交付工作。', 'evidence_lines':list(indices)},
        ],
    }


def resolve(raw, lines):
    return server.resolve_evaluation(raw, lines, '\n'.join(lines), condition_rules=CONDITIONS,
                                    required_rules=CONDITIONS[:1], structured_scoring=True,
                                    priority_groups=[[CONDITIONS[0]], [CONDITIONS[1]]])


class EvidenceDeduplicationTests(unittest.TestCase):
    def test_same_paragraph_at_different_source_positions_is_kept_once_per_block(self):
        lines = ['本人完成视觉软件开发与交付。', '日期：2020.01 - 2024.12',
                 '本人完成视觉软件开发与交付。', '本人完成视觉软件开发与交付。']
        result = resolve(answer([3, 2, 1, 4]), lines)
        for group in GROUPS:
            row = result[group][0]
            self.assertEqual(row['evidence_quotes'], [lines[2], lines[1]])
            self.assertEqual(row['evidence'], '\n'.join([lines[2], lines[1]]))
            self.assertEqual(row['evidence_duplicate_count'], 2)
        self.assertEqual(result['score'], 67)
        self.assertEqual(result['scoring']['total'], 2)

    def test_whitespace_only_differences_merge_but_first_exact_original_is_preserved(self):
        lines = ['  本人\t完成  视觉 开发。 ', '本人 完成 视觉 开发。',
                 '本人\u3000完成\u00a0视觉 开发。', '独立完成设备调试。']
        result = resolve(answer([1, 2, 3, 4]), lines)
        for group in GROUPS:
            row = result[group][0]
            self.assertEqual(row['evidence_quotes'], [lines[0], lines[3]])
            self.assertTrue(row['evidence'].startswith(lines[0]))
            self.assertEqual(row['evidence_duplicate_count'], 2)
            self.assertTrue(server.valid_evidence(row, '\n'.join(lines)))

    def test_word_boundaries_dates_punctuation_and_case_are_not_fuzzily_merged(self):
        lines = ['a b', 'ab', '时间：2020.01 - 2024.12', '时间：2021.01 - 2024.12',
                 '完成开发。', '完成开发！', 'OpenCV', 'opencv']
        result = resolve(answer(range(1, len(lines) + 1)), lines)
        for group in GROUPS:
            self.assertEqual(result[group][0]['evidence_quotes'], lines)
            self.assertNotIn('evidence_duplicate_count', result[group][0])

    def test_duplicate_indices_and_duplicate_content_share_one_accurate_count(self):
        lines = ['本人完成视觉开发。', '本人完成视觉开发。', '本人完成设备调试。']
        indices = [2, 2, 1, 3, 3, 1]
        result = resolve(answer(indices), lines)
        for group in GROUPS:
            row = result[group][0]
            self.assertEqual(row['evidence_quotes'], [lines[1], lines[2]])
            self.assertEqual(row['evidence_duplicate_count'], len(indices) - 2)

    def test_model_supplied_duplicate_counts_are_removed_or_recomputed(self):
        lines = ['本人完成视觉开发。', '本人完成视觉开发。', '本人完成设备调试。']
        for indices, expected in (([1, 3], None), ([1, 2, 3], 1)):
            raw = answer(indices)
            for group in GROUPS:
                raw[group][0]['evidence_duplicate_count'] = 999
            raw['checks'][1]['evidence_duplicate_count'] = 999
            result = resolve(raw, lines)
            for group in GROUPS:
                row = result[group][0]
                self.assertEqual(row.get('evidence_duplicate_count'), expected)
            self.assertNotIn('evidence_duplicate_count', result['checks'][1])

    def test_more_than_forty_eight_positions_can_merge_without_truncating_unique_facts(self):
        lines = ['本人完成视觉开发。'] * 60 + ['本人完成设备验收。']
        result = resolve(answer(range(1, 62)), lines)
        for group in GROUPS:
            row = result[group][0]
            self.assertEqual(row['evidence_quotes'], [lines[0], lines[-1]])
            self.assertEqual(row['evidence_duplicate_count'], 59)

    def test_forty_eight_unique_quotes_remain_complete_and_forty_nine_reject(self):
        lines = [f'第{index}项独特开发事实。' for index in range(1, 50)]
        result = resolve(answer(range(1, 49)), lines)
        for group in GROUPS:
            self.assertEqual(result[group][0]['evidence_quotes'], lines[:48])
        for group in GROUPS:
            raw = answer([1])
            raw[group][0]['evidence_lines'] = list(range(1, 50))
            original = deepcopy(raw)
            with self.subTest(group=group), self.assertRaises(server.EvaluationFormatError) as raised:
                resolve(raw, lines)
            self.assertEqual(raised.exception.path, f'{group}[0].evidence_lines')
            self.assertEqual(raw, original)

    def test_invalid_indices_are_never_filtered_even_inside_repeated_source_text(self):
        lines = ['本人完成视觉开发。'] * 60
        for group in GROUPS:
            for invalid in (True, False, '1', 1.0, None, 0, -1, len(lines) + 1):
                raw = answer([1])
                raw[group][0]['evidence_lines'] = list(range(1, 61)) + [invalid]
                original = deepcopy(raw)
                with self.subTest(group=group, value=repr(invalid)), self.assertRaises(server.EvaluationEvidenceMismatch):
                    resolve(raw, lines)
                self.assertEqual(raw, original)

    def test_block_deduplication_does_not_merge_evidence_across_conditions(self):
        lines = ['本人完成视觉开发。', '本人完成视觉开发。']
        raw = answer([1, 2])
        raw['checks'][1].update(status='满足', basis='explicit', evidence_lines=[2, 1])
        result = resolve(raw, lines)
        for row in result['checks']:
            self.assertEqual(row['evidence_quotes'], [lines[0]])
            self.assertEqual(row['evidence_duplicate_count'], 1)
        self.assertEqual(result['required_checks'][0]['evidence_quotes'], [lines[0]])
        self.assertEqual(result['inferred_capabilities'][0]['evidence_quotes'], [lines[0]])
        self.assertEqual(result['score'], 100)
        self.assertEqual(result['scoring']['total'], 2)

    def test_unknown_rows_remain_empty_and_zero_without_a_duplicate_badge(self):
        lines = ['本人完成视觉开发。', '本人完成视觉开发。']
        raw = answer([1, 2, 1])
        for group in ('checks', 'required_checks'):
            raw[group][0].update(status='信息不足', basis='unknown', evidence_duplicate_count=999)
        result = resolve(raw, lines)
        for group in ('checks', 'required_checks'):
            row = result[group][0]
            self.assertEqual(row['evidence_quotes'], [])
            self.assertEqual(row['evidence'], '')
            self.assertNotIn('evidence_duplicate_count', row)
        self.assertEqual(result['score'], 0)
        self.assertEqual(result['scoring']['unknown'], 2)

    def test_resolving_does_not_mutate_model_answer_or_original_source(self):
        lines = ['本人完成视觉开发。', '本人完成视觉开发。', '本人完成设备验收。']
        raw = answer([2, 1, 3, 2])
        original, original_lines = deepcopy(raw), list(lines)
        result = resolve(raw, lines)
        self.assertEqual(raw, original)
        self.assertEqual(lines, original_lines)
        result['checks'][0]['evidence'] = '篡改后的引用内容'
        with self.assertRaises(server.EvaluationEvidenceMismatch):
            server.validate_evaluation(result, '\n'.join(lines))

    def test_legacy_single_reference_or_quote_does_not_trust_model_duplicate_metadata(self):
        lines = ['本人完成视觉开发。']
        for legacy in ({'evidence_line':1}, {'evidence':lines[0]}):
            raw = answer([1])
            raw.pop('inferred_capabilities')
            for group in ('checks', 'required_checks'):
                raw[group][0].pop('evidence_lines')
                raw[group][0].update(legacy, evidence_duplicate_count=999)
            result = resolve(raw, lines)
            for group in ('checks', 'required_checks'):
                self.assertEqual(result[group][0]['evidence'], lines[0])
                self.assertNotIn('evidence_duplicate_count', result[group][0])


if __name__ == '__main__':
    unittest.main()
