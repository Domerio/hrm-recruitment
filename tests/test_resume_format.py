import re
import sys
import unittest
from html import escape, unescape
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from resume_format import clipboard_resume, display_lines, format_plain_resume, is_resume_tag, resume_document


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


class ResumePresentationTests(unittest.TestCase):
    def body(self, markup, text=''):
        document = resume_document(markup, text).decode('utf-8')
        return document.split('<body>', 1)[1].rsplit('</body>', 1)[0]

    def test_background_pre_uses_structured_display_without_changing_the_saved_text(self):
        source = ('王** 热搜 刚刚活跃\n35岁 8年 硕士 在职-考虑机会\n'
                  '工作经历 示例设备股份有限公司 视觉工程师 2020.05 - 2026.10\n'
                  '工作描述：\n1. 使用 C#、WPF 完成生产线软件开发。\n'
                  '教育经历 示例工业大学 机械工程 硕士 2015 - 2018\n211院校')
        raw = '<pre>' + escape(source, quote=False) + '</pre>'
        stored_text, stored_html = clipboard_resume(source, raw)
        body = self.body(stored_html, stored_text)
        self.assertEqual(stored_text, source)
        self.assertEqual(stored_html, raw)
        self.assertNotIn('<pre>', body)
        self.assertIn('<h2>王**</h2>', body)
        self.assertIn('<p class="resume-status">热搜 刚刚活跃</p>', body)
        self.assertIn('<p class="resume-meta">35岁 8年 硕士 在职-考虑机会</p>', body)
        self.assertIn('<h3>工作经历</h3>', body)
        self.assertIn('<strong>示例设备股份有限公司 视觉工程师</strong>', body)
        self.assertIn('<time>2020.05 - 2026.10</time>', body)
        self.assertIn('<h3>教育经历</h3>', body)
        self.assertIn('<strong>示例工业大学 机械工程 硕士</strong>', body)
        self.assertIn('<time>2015 - 2018</time>', body)
        self.assertIn('<span class="resume-tag resume-badge">211院校</span>', body)
        self.assertEqual(clipboard_resume(stored_text, stored_html), (stored_text, stored_html))

    def test_pre_entities_are_decoded_once_and_escaped_again_for_display(self):
        source = ('个人优势\n使用 A<B && C>D 的逻辑。\n'
                  '原样示例：<script>alert("x")</script>\n'
                  '字面量实体：&lt;b&gt;保留文本&lt;/b&gt; &amp;')
        raw = '<pre>' + escape(source, quote=False) + '</pre>'
        stored_text, stored_html = clipboard_resume(source, raw)
        body = self.body(stored_html, stored_text)
        self.assertEqual(stored_text, source)
        self.assertNotIn('<script>', body)
        self.assertNotIn('<b>保留文本</b>', body)
        self.assertIn(escape('使用 A<B && C>D 的逻辑。'), body)
        self.assertIn(escape('原样示例：<script>alert("x")</script>'), body)
        self.assertIn('&amp;lt;b&amp;gt;保留文本&amp;lt;/b&amp;gt; &amp;amp;', body)
        class VisibleText(HTMLParser):
            def __init__(self):
                super().__init__(convert_charrefs=True)
                self.parts = []
            def handle_data(self, data):
                self.parts.append(data)
        visible = VisibleText()
        visible.feed(body)
        self.assertEqual(visible.parts, source.splitlines())

    def test_bare_pre_can_format_legacy_records_without_separate_text(self):
        source = '工作经历 示例科技有限公司 软件工程师 2021.01 - 至今\n负责设备调试。'
        body = self.body('<pre>' + escape(source) + '</pre>')
        self.assertIn('<h3>工作经历</h3>', body)
        self.assertIn('<time>2021.01 - 至今</time>', body)
        self.assertIn('<p>负责设备调试。</p>', body)

    def test_inline_sections_keep_complete_entry_labels_and_salary_words(self):
        source = ('期望职位：杭州 图像算法 行业不限 20-30K\n'
                  '项目经历 Example Vision Project 技术负责人 2022.01 - 2024.03\n'
                  '工作描述：\n• 完成设备交付。')
        body = self.body('', source)
        self.assertIn('<h3>期望职位</h3>', body)
        self.assertIn('杭州 图像算法 行业不限 20-30K', body)
        self.assertIn('<h3>项目经历</h3>', body)
        self.assertIn('<strong>Example Vision Project 技术负责人</strong>', body)
        self.assertIn('<time>2022.01 - 2024.03</time>', body)
        self.assertIn('<li>• 完成设备交付。</li>', body)

    def test_body_mentions_do_not_create_sections_or_invent_dated_entries(self):
        prose = ['负责工作经历数据整理。', '教育经历丰富并不替代项目能力。',
                 '介绍项目经历：独立负责设备交付。',
                 '负责生产线升级 2020 - 2022', '1. 参与开发 2020 - 2022',
                 '示例项目2020 - 2022', '示例项目：交付 2020 - 2022',
                 '示例项目 2020 - 2022 后继续维护', '示例项目 2020 -']
        body = self.body('', '工作经历\n' + '\n'.join(prose))
        self.assertEqual(re.findall(r'<h3>(.*?)</h3>', body), ['工作经历'])
        self.assertNotIn('<time>', body)
        self.assertNotIn('class="resume-entry"', body)
        for line in prose:
            with self.subTest(line=line):
                self.assertIn(escape(line), body)

    def test_single_line_dates_outside_work_or_education_do_not_become_entries(self):
        body = self.body('', '个人优势\n示例科技有限公司 软件工程师 2020 - 2022')
        self.assertNotIn('<time>', body)
        self.assertIn('<p>示例科技有限公司 软件工程师 2020 - 2022</p>', body)

    def test_rich_and_styled_pre_content_keep_their_formatting(self):
        sources = [
            '<h2>工作经历</h2><p><strong>示例科技公司</strong></p>'
            '<ol start="2"><li>原有列表内容</li></ol>'
            '<table><tr><td colspan="2">原有表格内容</td></tr></table>',
            '<pre style="color:#123456;white-space:pre">工作经历\n示例科技公司</pre>',
            '<pre><strong>工作经历</strong>\n示例科技公司</pre>',
            '<pre>前半段</pre><pre>后半段</pre>',
        ]
        for raw in sources:
            with self.subTest(raw=raw):
                text, safe = clipboard_resume('', raw)
                body = self.body(safe, text)
                self.assertEqual(body, safe)
                self.assertNotIn('resume-structured', body)

    def test_mismatched_pre_and_text_never_substitute_a_different_candidate_body(self):
        markup = '<pre>工作经历\n原图片里的任职说明与日期 2020 - 2022</pre>'
        text = '教育经历\n另一份记录的院校信息 2015 - 2018'
        body = self.body(markup, text)
        self.assertEqual(body, markup)
        self.assertNotIn('另一份记录', body)
        self.assertNotIn('resume-structured', body)

    def test_only_line_endings_and_outer_whitespace_may_differ_in_matching_pre(self):
        raw = '<pre>\r\n工作经历\r\n示例公司 软件工程师 2020 - 2022\r\n</pre>'
        text = '工作经历\n示例公司 软件工程师 2020 - 2022'
        self.assertIn('resume-structured', self.body(raw, text))
        changed_words = self.body(raw, text.replace('示例公司', '另一公司'))
        self.assertEqual(changed_words, raw)

    def test_clipboard_line_margin_trimming_still_formats_existing_pre_records(self):
        text = '工作经历\n示例公司 软件工程师 2020 - 2022\n负责 C# 与 WPF 开发。'
        raw = '<pre>工作经历\n  示例公司 软件工程师 2020 - 2022 \n\t负责 C# 与 WPF 开发。</pre>'
        rendered = self.body(raw, text)
        self.assertIn('<h3>工作经历</h3>', rendered)
        self.assertIn('<time>2020 - 2022</time>', rendered)
        self.assertIn('负责 C# 与 WPF 开发。', rendered)
        # Spaces within wording remain significant; no cross-word matching.
        self.assertEqual(self.body(raw, text.replace('C# 与 WPF', 'C#与WPF')), raw)

    def test_clipboard_blank_rows_do_not_disable_existing_resume_styles(self):
        source = ('梁**\r\n热搜\r\n27岁\r\n5年\r\n本科\r\n离职-随时到岗\r\n\r\n'
                  '期望职位\r\n苏州\r\n海外市场\r\n行业不限\r\n23-25K\r\n \t\r\n'
                  '工作经历\r\n示例科技有限公司\r\n海外渠道销售经理\r\n2025.11 - 2026.05\r\n\r\n'
                  '负责海外渠道建设。\r\n\r\n教育经历\r\n示例大学\r\n商务英语\r\n本科\r\n2016 - 2020')
        raw = '<pre>' + escape(source, quote=False) + '</pre>'
        text, markup = clipboard_resume(source, raw)
        self.assertNotIn('\n\n', text)
        self.assertEqual(markup, raw)
        body = self.body(markup, text)
        self.assertNotIn('<pre>', body)
        self.assertIn('<h2>梁**</h2>', body)
        self.assertIn('<h3>期望职位</h3>', body)
        self.assertIn('<p class="resume-intent">苏州 · 海外市场 · 行业不限 · 23-25K</p>', body)
        self.assertIn('<strong>示例科技有限公司</strong>', body)
        self.assertIn('<time>2025.11 - 2026.05</time>', body)
        self.assertIn('<h3>教育经历</h3>', body)
        self.assertEqual(clipboard_resume(text, markup), (text, markup))

    def test_normalized_pre_keeps_paragraph_boundaries_and_requires_identical_wording(self):
        first = '负责海外市场拓展与渠道建设，协调客户需求、合作伙伴沟通及产品交付进度并推动区域市场项'
        second = '目的持续运营，跟进售后服务及客户反馈。'
        source = '工作经历\n\n' + first + '\n\n' + second
        raw = '<pre>' + escape(source) + '</pre>'
        text, markup = clipboard_resume(source, raw)
        body = self.body(markup, text)
        self.assertIn('<p>' + first + '</p>', body)
        self.assertIn('<p>' + second + '</p>', body)
        for changed in (text.replace('海外市场', '国内市场'),
                        text.replace(first + '\n' + second, second + '\n' + first),
                        text.replace(first + '\n' + second, first + second)):
            with self.subTest(text=changed):
                self.assertEqual(self.body(markup, changed), markup)

    def test_canvas_wrapped_list_items_reflow_without_changing_capture_or_evidence(self):
        source = ('王** 热搜 刚刚活跃\n35岁 8年 硕士 在职-考虑机会\n'
                  '1.熟悉C#编程，多线程开发等，具有三年以上的Winform，五年的WPF编程经验；\n'
                  '2.熟悉上位机程序开发，和界面软件编程，掌握多种通讯方式，如TCP/IP、Http、串口、OPC等\n'
                  '工业协议，具有WebAPI、WEBSERVICES开发经验；\n'
                  '3.对视觉系统的相机，镜头，光源等硬件较为熟悉，具备视觉方案设计能力，能够熟练使用 vision\n'
                  'Pro、VisionMaster图像处理工具及Cognex Vidi深度学习框架，视觉检测及测量项目开发经验丰\n'
                  '富；\n4.有较强的需求分析、软件设计能力；')
        raw = '<pre>' + escape(source, quote=False) + '</pre>'
        stored = clipboard_resume(source, raw)
        evidence = display_lines(source)
        body = self.body(stored[1], stored[0])
        items = re.findall(r'<li>(.*?)</li>', body)
        self.assertEqual(len(items), 4)
        self.assertIn('OPC等工业协议', unescape(items[1]))
        self.assertIn('vision Pro、VisionMaster', unescape(items[2]))
        self.assertIn('开发经验丰富；', unescape(items[2]))
        self.assertNotIn('<p>富；</p>', body)
        self.assertEqual(stored, (source, raw))
        self.assertEqual(display_lines(source), evidence)

    def test_long_prose_continuation_reflows_but_new_duties_stay_separate(self):
        first = '负责机器视觉检测软件的开发，包含相机标定与图像采集，以及检测算法部署和生产线设备的联'
        second = '调工作，保证现场交付质量。'
        other = '参与跨部门评审和现场技术支持，完成项目交付。'
        body = self.body('', '工作经历\n' + first + '\n' + second + '\n' + other)
        self.assertIn('<p>' + first + second + '</p>', body)
        self.assertIn('<p>' + other + '</p>', body)
        long_duty = first + '调工作'
        body = self.body('', '工作经历\n' + long_duty + '\n' + other)
        self.assertIn('<p>' + long_duty + '</p>', body)
        self.assertIn('<p>' + other + '</p>', body)

    def test_reflow_preserves_sections_labels_entries_tags_and_numbered_items(self):
        first = '1.负责机器视觉检测软件的开发，包含相机标定与图像采集，以及检测算法部署和生产线设备的联调'
        boundaries = ['2.独立完成设备调试。', '2 管理算法小组，制定开发计划。',
                      '② 提升检测精度，完成设备验证。', '工作描述：', '项目背景', '教育经历',
                      '示例设备公司 软件工程师 2020 - 2022',
                      '示例设备公司\n软件工程师\n2020 - 2022', 'OpenCV\nC++']
        for following in boundaries:
            with self.subTest(following=following):
                body = self.body('', '工作经历\n' + first + '\n' + following)
                self.assertIn('<li>' + first + '</li>', body)

    def test_reflow_respects_explicit_paragraph_breaks_and_sentence_endings(self):
        first = '负责机器视觉检测软件的开发，包含相机标定与图像采集，以及检测算法部署和生产线设备的联调'
        second = '覆盖产线实际工况，完成设备验证。'
        for ending, newline in [('', '\n\n'), ('。', '\n'), ('；', '\n'), (':', '\n'), ('.', '\n')]:
            with self.subTest(ending=ending, newline=newline):
                body = self.body('', first + ending + newline + second)
                self.assertIn('<p>' + first + ending + '</p>', body)
                self.assertIn('<p>' + second + '</p>', body)

    def test_short_ambiguous_lines_are_not_joined_as_wrapped_prose(self):
        lines = ['负责设备开发', '前端开发', '图像处理', '补充说明', '独立完成交付。']
        body = self.body('', '\n'.join(lines))
        for line in lines:
            self.assertIn('<p>' + line + '</p>', body)

    def test_reflow_escapes_all_source_fragments(self):
        first = '1.负责机器视觉检测软件的开发，包含相机标定与图像采集，以及检测算法部署和表达式 A<B && C>D 的验'
        last = '证，原样记录 <script>alert(1)</script>。'
        body = self.body('', first + '\n' + last)
        self.assertIn('<li>' + escape(first + last) + '</li>', body)
        self.assertNotIn('<script>', body)

    def test_header_groups_identity_without_taking_short_body_lines_as_metadata(self):
        body = self.body('', '王** 刚刚活跃\n35岁\n8年\n硕士\n在职-考虑机会\n软件开发\n熟悉C#。')
        header, rest = body.split('</header>', 1)
        self.assertIn('<div class="resume-heading"><h2>王**</h2><p class="resume-status">刚刚活跃</p></div>', header)
        self.assertIn('<p class="resume-meta">35岁 · 8年 · 硕士 · 在职-考虑机会</p>', header)
        self.assertNotIn('软件开发', header)
        self.assertIn('<p>软件开发</p>', rest)


if __name__ == '__main__':
    unittest.main()
