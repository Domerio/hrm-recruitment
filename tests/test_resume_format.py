import re
import sys
import unittest
from html import unescape
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from resume_format import clipboard_resume, format_plain_resume, is_resume_tag, resume_document


def chips(markup):
    return [re.findall(r'<span class="resume-tag">(.*?)</span>', group)
            for group in re.findall(r'<p class="resume-tags">(.*?)</p>', markup)]


def work_resume(body, ending=''):
    return ('张**\n工作经历\n示例科技公司\n视觉工程师\n2023.01 - 至今\n'
            + body + ('\n' + ending if ending else ''))


class ResumeTagTests(unittest.TestCase):
    def test_screenshot_labels_following_unnumbered_duties_form_one_group(self):
        labels = ['C/C++', '前端开发', '图像算法', '图像处理', 'visionpr', '视觉图像算法']
        text = work_resume('主要负责机器视觉算法开发。\n' + '\n'.join(labels),
                           '示例设备公司\n算法工程师\n2020.01 - 2022.12\n负责设备部署。')
        rendered = format_plain_resume(text)
        self.assertEqual(chips(rendered), [labels])
        self.assertIn('<p>主要负责机器视觉算法开发。</p>', rendered)
        self.assertIn('<strong>示例设备公司</strong> · 算法工程师</span>', rendered)
        self.assertNotIn('visionpro', rendered)

    def test_long_groups_and_tech_labels_with_spaces_keep_source_spelling(self):
        labels = ['C/C++', 'C#', '.NET Core', 'SQL Server', 'Visual Studio', 'Machine Vision',
                  'OpenCV', 'HALCON', 'YOLOv8', '3D 视觉', '视觉定位', 'PLC (西门子)']
        rendered = format_plain_resume(work_resume('负责产线视觉调试。\n' + '\n'.join(labels),
                                                   '教育经历\n示例大学\n本科\n2018 - 2022'))
        self.assertEqual(chips(rendered), [labels])
        self.assertIn('<h3>教育经历</h3>', rendered)
        self.assertNotIn('<span class="resume-tag">示例大学</span>', rendered)

    def test_groups_stop_at_entry_section_and_document_end(self):
        for ending in ['', '教育经历\n示例大学\n本科\n2018 - 2022',
                       '另一设备公司\n开发工程师\n2020.01 - 2022.12\n负责现场交付。']:
            with self.subTest(ending=ending):
                self.assertEqual(chips(format_plain_resume(work_resume('负责设备开发。\nC++\n图像处理', ending))),
                                 [['C++', '图像处理']])

    def test_short_prose_followed_by_more_duties_stays_in_paragraphs(self):
        rendered = format_plain_resume(work_resume('负责设备开发\n前端开发\n图像处理\n参与现场联调并完成项目交付。'))
        self.assertEqual(chips(rendered), [])
        self.assertIn('<p>前端开发</p>', rendered)
        self.assertIn('<p>参与现场联调并完成项目交付。</p>', rendered)

    def test_entities_dates_and_profile_fragments_are_not_tags(self):
        for value in ['示例公司', '算法工程师', '示例大学', '研究院', '2022.01 - 至今',
                      '本科', '29岁', '8年', '至今', '15-20K', '13800000000', 'hr@example.com',
                      '负责设备开发', '通过视觉完成定位', '根据客户需求开发', '对内培训技术人员']:
            with self.subTest(value=value):
                self.assertFalse(is_resume_tag(value))

    def test_explicit_skill_sections_allow_one_tag_but_an_inferred_single_word_stays_prose(self):
        for section in ['技能标签', '专业技能']:
            self.assertEqual(chips(format_plain_resume(section + '\n.NET Core')), [['.NET Core']])
        self.assertEqual(chips(format_plain_resume(work_resume('负责设备开发。\n补充说明'))), [])

    def test_numbered_duties_and_project_entries_still_support_tags(self):
        text = ('项目经历\n示例视觉检测项目\n技术负责人\n2023.01 - 2024.06\n'
                '1. 完成项目交付。\n2. 负责相机标定。\nOpenCV\nC++')
        rendered = format_plain_resume(text)
        self.assertEqual(chips(rendered), [['OpenCV', 'C++']])
        self.assertIn('<li>2. 负责相机标定。</li>', rendered)

    def test_duplicate_chips_are_only_hidden_in_the_display(self):
        text = work_resume('负责设备开发。\nOpenCV\nC++\nopencv\nC++')
        self.assertEqual(chips(format_plain_resume(text)), [['OpenCV', 'C++']])
        self.assertEqual(clipboard_resume(text, ''), (text, ''))

    def test_rich_format_is_preserved_and_generated_tags_wrap(self):
        rich = '<h2>工作经历</h2><p><strong>示例科技公司</strong></p><p style="color:#123456">C/C++</p>'
        safe_text, safe_markup = clipboard_resume('', rich)
        rendered = resume_document(safe_markup, safe_text).decode('utf-8')
        self.assertIn(rich, rendered)
        self.assertNotIn('<p class="resume-tags">', rendered)
        plain = resume_document('', work_resume('负责设备开发。\nC/C++\n图像处理')).decode('utf-8')
        self.assertIn('display:flex;flex-wrap:wrap', plain)
        self.assertIn('overflow-wrap:anywhere', plain)
        self.assertEqual([[unescape(tag) for tag in group] for group in chips(plain)], [['C/C++', '图像处理']])

    def test_expanded_honors_preserve_all_items_and_hide_only_the_collapse_control(self):
        labels = ['校级一等奖学金*2'] + [f'示例竞赛奖项{number}' for number in range(1, 16)]
        text = '所获荣誉\n' + '\n'.join(labels) + '\n收起全部16个所获荣誉\n负责收起式设备的调试。'
        rendered = format_plain_resume(text)
        self.assertEqual(chips(rendered), [labels])
        self.assertIn('<h3>所获荣誉</h3>', rendered)
        self.assertNotIn('收起全部', rendered)
        self.assertIn('负责收起式设备的调试。', rendered)


if __name__ == '__main__':
    unittest.main()
