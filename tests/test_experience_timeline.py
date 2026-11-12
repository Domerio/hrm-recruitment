from datetime import date
import json
import unittest

from experience_timeline import build_experience_timeline


class ExperienceTimelineTests(unittest.TestCase):
    as_of = date(2026, 11, 11)

    def timeline(self, lines):
        return build_experience_timeline(lines, self.as_of)

    def test_medical_image_work_dates_resolve_present_and_trace_original_lines(self):
        lines = [
            '郑**', '工作经历', '示例医疗科技有限公司', '医学图像处理工程师',
            '2020.04 - 至今', '负责医学影像算法研发。',
            '另一科技有限公司', '图像处理工程师', '2018.06 - 2020.04',
            '负责图像相关系统开发。',
        ]
        result = self.timeline(lines)
        self.assertEqual(result['as_of'], '2026-11-11')
        self.assertEqual(result['union_months'], 101)
        self.assertEqual([entry['duration_months'] for entry in result['entries']], [79, 22])
        self.assertEqual(result['entries'][0], {
            'start':'2020-04', 'end':'2026-11', 'duration_months':79, 'date_line':5,
            'context_start_line':3, 'context_end_line':6, 'title_lines':[3, 4],
            'end_resolved_from_present':True, 'uncertain':False,
        })
        self.assertEqual(result['entries'][1]['date_line'], 9)
        self.assertEqual(result['diagnostics'], [])
        encoded = json.dumps(result, ensure_ascii=False)
        self.assertNotIn('郑', encoded)
        self.assertNotIn('示例医疗', encoded)
        self.assertNotIn('图像处理工程师', encoded)

    def test_three_jobs_include_machine_vision_without_classifying_relatedness(self):
        result = self.timeline([
            '工作经历', '甲科技有限公司 医学图像处理工程师 2020.04-至今',
            '乙科技有限公司 图像处理工程师 2018.06-2020.04',
            '丙装备有限公司 机器视觉工程师 2017.04-2018.06',
        ])
        self.assertEqual([entry['duration_months'] for entry in result['entries']], [79, 22, 14])
        self.assertEqual(result['union_months'], 115)
        self.assertNotIn('related', result)

    def test_project_education_and_dates_outside_work_sections_do_not_count(self):
        result = self.timeline([
            '个人简介', '2010.01-至今', '工作经验', '示例公司 算法工程师 2020.04-至今',
            '项目经历', '测试项目 2015.01-至今', '2016.01-2020.04',
            '教育背景', '测试大学', '2010.09-2014.06',
            '资格证书', '2012.01-2026.01',
        ])
        self.assertEqual(len(result['entries']), 1)
        self.assertEqual(result['union_months'], 79)
        self.assertEqual(result['entries'][0]['context_end_line'], 4)

    def test_project_dates_inside_work_prose_are_not_new_employment(self):
        result = self.timeline([
            '工作经历', '示例影像有限公司', '图像工程师', '2020.04-至今',
            '负责以下项目。', '肺癌筛查项目', '2021.01-2022.02',
            '项目时间：2022.03-2023.01', '参与2023.01-2024.01的客户技术专项。',
        ])
        self.assertEqual(len(result['entries']), 1)
        self.assertEqual(result['union_months'], 79)
        self.assertEqual([item['line'] for item in result['diagnostics']], [7, 8, 9])

    def test_training_and_other_non_work_headers_end_employment_parsing(self):
        for section in ['培训经历', '培训经验', '进修经历', '其他能力', '荣誉奖项']:
            with self.subTest(section=section):
                result = self.timeline([
                    '工作经历', '示例公司 图像工程师 2020.04-至今',
                    section, '示例培训研究院', '2010.01-2020.03',
                ])
                self.assertEqual(len(result['entries']), 1)
                self.assertEqual(result['union_months'], 79)
                self.assertEqual(result['entries'][0]['context_end_line'], 2)

    def test_overlapping_and_duplicate_ranges_are_unioned_in_months(self):
        result = self.timeline([
            '工作经历', '示例甲公司 工程师 2018.06-2020.04',
            '示例乙公司 工程师 2019.01-2021.06',
            '示例甲公司 工程师 2018.06-2020.04',
        ])
        self.assertEqual(len(result['entries']), 3)
        self.assertEqual(result['union_months'], 36)

    def test_year_only_invalid_reversed_and_future_dates_are_uncertain(self):
        for dates, reason in [
            ('2018-至今', 'start_missing_month'),
            ('2018.06-2020', 'end_missing_month'),
            ('2020.13-2021.02', 'start_invalid_month'),
            ('2021.06-2020.04', 'reversed_range'),
            ('2027.01-至今', 'future_date'),
            ('2020.04-2027.01', 'future_date'),
        ]:
            with self.subTest(dates=dates):
                result = self.timeline(['工作经历', '示例公司', '算法工程师', dates])
                self.assertEqual(len(result['entries']), 1)
                entry = result['entries'][0]
                self.assertTrue(entry['uncertain'])
                self.assertIsNone(entry['duration_months'])
                self.assertEqual(result['union_months'], 0)
                self.assertIn(reason, entry['uncertainty_reasons'])
                self.assertTrue(any(item['reason'] == reason for item in result['diagnostics']))
        self.assertIsNone(self.timeline(['工作经历', '示例公司', '2018-至今'])['entries'][0]['start'])

    def test_date_first_headers_and_chinese_fullwidth_dates_preserve_original_blank_lines(self):
        result = self.timeline([
            '工作经验', '', '２０２０年４月至今', '示例研究院', '医学图像处理工程师',
            '负责研发和部署。',
        ])
        self.assertEqual(result['union_months'], 79)
        entry = result['entries'][0]
        self.assertEqual(entry['date_line'], 3)
        self.assertEqual(entry['context_start_line'], 3)
        self.assertEqual(entry['title_lines'], [4, 5])
        self.assertEqual(entry['context_end_line'], 6)

    def test_standalone_dates_need_an_employer_and_multiple_ranges_are_not_guessed(self):
        bare = self.timeline(['工作经历', '2020.04-至今', '负责图像算法开发。'])
        self.assertEqual(bare['entries'], [])
        self.assertEqual(bare['diagnostics'], [{'line':2, 'reason':'unconfirmed_employment_header'}])
        ambiguous = self.timeline(['工作经历', '示例公司 2018.01-2020.01 / 另一公司 2021.01-至今'])
        self.assertEqual(ambiguous['entries'], [])
        self.assertEqual(ambiguous['diagnostics'][0]['reason'], 'ambiguous_multiple_ranges')

    def test_same_month_is_zero_and_full_day_dates_are_reported_without_partial_parsing(self):
        same = self.timeline(['工作经历', '示例公司 工程师 2026.11-至今'])
        self.assertEqual(same['entries'][0]['duration_months'], 0)
        unsupported = self.timeline(['工作经历', '示例公司', '2020.04.01-2021.03.01'])
        self.assertEqual(unsupported['entries'], [])
        self.assertEqual(unsupported['diagnostics'][0]['reason'], 'unsupported_date_format')

    def test_adjacent_headers_do_not_overlap_context_or_steal_the_next_company(self):
        result = self.timeline([
            '工作经历', '第一科技有限公司', '2020.04-至今',
            '第二科技有限公司', '2018.06-2020.04',
        ])
        first, second = result['entries']
        self.assertEqual(first['title_lines'], [2])
        self.assertEqual(first['context_end_line'], 3)
        self.assertEqual(second['context_start_line'], 4)
        for entry in result['entries']:
            self.assertTrue(all(entry['context_start_line'] <= number <= entry['context_end_line']
                                for number in entry['title_lines']))


if __name__ == '__main__':
    unittest.main()
