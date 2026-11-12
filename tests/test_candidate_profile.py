import unittest

from candidate_profile import extract_candidate_profile, extract_candidate_profile_with_sources


class CandidateProfileTests(unittest.TestCase):
    def test_normal_copied_resume_populates_five_fields_with_original_evidence(self):
        resume = ('张**\n8年 · 本科\n期望职位\n杭州\n机器视觉工程师\n15-20K\n'
                  '工作经历\n示例视觉科技有限公司\n高级算法工程师\n2022.06 - 至今\n'
                  '1. 负责工业检测项目部署。\nOpenCV\nC++\n'
                  '教育经历\n示例大学\n计算机科学与技术\n本科\n2015 - 2019')
        result = extract_candidate_profile_with_sources(resume)
        self.assertEqual(result['profile'], {
            'company': '示例视觉科技有限公司', 'title': '高级算法工程师',
            'city': '杭州', 'education': '本科', 'skills': 'OpenCV\nC++',
        })
        for field, source in result['profile_sources'].items():
            self.assertEqual(source['source'], 'resume')
            self.assertIn(source['evidence'], resume)
            self.assertLessEqual(len(source['evidence']), 1000)
            self.assertIn(field, result['profile'])

    def test_latest_dated_employment_is_selected_when_work_order_is_reversed(self):
        resume = ('工作经历\n较早科技有限公司\n算法工程师\n2016.01 - 2019.06\n1. 负责检测算法开发。\n'
                  '最新科技有限公司\n高级开发工程师\n2021.03 - 2026.09\n1. 负责产品研发。\n'
                  '另一科技有限公司\n软件工程师\n2020.01 - 2021.02')
        profile = extract_candidate_profile(resume)
        self.assertEqual(profile['company'], '最新科技有限公司')
        self.assertEqual(profile['title'], '高级开发工程师')

    def test_present_employment_sorts_after_concluded_employment(self):
        resume = ('工作经历\n兼任科技有限公司\n技术负责人\n2020.01 - 至今\n1. 负责系统设计。\n'
                  '已结束科技有限公司\n高级工程师\n2024.03 - 2026.09')
        self.assertEqual(extract_candidate_profile(resume)['company'], '兼任科技有限公司')

    def test_compact_horizontal_employment_row_can_have_no_token_spacing(self):
        resume = '工作经历\n示例科技有限公司高级算法工程师2022.06 - 至今\n1. 负责工业检测。'
        self.assertEqual(extract_candidate_profile(resume), {
            'company': '示例科技有限公司', 'title': '高级算法工程师',
        })

    def test_date_first_employment_header(self):
        resume = '工作经历\n2022.06 - 至今\n示例科技有限公司\n机器视觉工程师\n1. 负责工业检测。'
        profile = extract_candidate_profile(resume)
        self.assertEqual(profile['company'], '示例科技有限公司')
        self.assertEqual(profile['title'], '机器视觉工程师')

    def test_research_institute_department_does_not_replace_company(self):
        resume = ('工作经历\n示例科技（长沙）有限公司\n视觉应用工程师 · 创新研究院\n2022.02 - 2026.07\n'
                  '1. 负责系统开发。')
        profile = extract_candidate_profile(resume)
        self.assertEqual(profile['company'], '示例科技（长沙）有限公司')
        self.assertEqual(profile['title'], '视觉应用工程师 · 创新研究院')

    def test_university_institute_full_employer_name_is_retained(self):
        resume = '工作经历\n示例大学浙江国际创新设计与智造研究院\n机器视觉应用工程师\n2024.10 - 至今'
        self.assertEqual(extract_candidate_profile(resume)['company'], '示例大学浙江国际创新设计与智造研究院')

    def test_project_client_is_never_used_as_employer(self):
        resume = ('期望职位\n温州\n图像算法\n面议\n项目经历\n'
                  '客户股份有限公司\n算法负责人\n2026.01 - 2026.10\n1. 交付视觉项目。')
        profile = extract_candidate_profile(resume)
        self.assertNotIn('company', profile)
        self.assertNotIn('title', profile)
        self.assertEqual(profile.get('city'), '温州')

    def test_company_in_work_prose_is_not_promoted_to_employer(self):
        resume = '工作经历\n1. 负责为客户科技有限公司开发检测系统。\n2022.06 - 至今'
        profile = extract_candidate_profile(resume)
        self.assertNotIn('company', profile)
        self.assertNotIn('title', profile)

    def test_undated_first_work_header_is_supported_conservatively(self):
        resume = '工作经历\n示例科技有限公司\n软件工程师\n负责检测开发。\n项目经历\n客户科技有限公司\n技术负责人'
        profile = extract_candidate_profile(resume)
        self.assertEqual(profile['company'], '示例科技有限公司')
        self.assertEqual(profile['title'], '软件工程师')

    def test_education_retains_explicit_non_full_time_mode(self):
        resume = ('张**\n29岁 · 8年 · 本科 · 在职-考虑机会\n教育经历\n示例大学\n机械\n'
                  '本科 · 非全日制\n2018 - 2021\n另一职业技术学院\n机电\n大专\n2015 - 2018')
        self.assertEqual(extract_candidate_profile(resume)['education'], '本科 · 非全日制')

    def test_highest_explicit_degree_is_used_without_learning_from_prose(self):
        resume = ('个人简介\n长期服务本科以上的技术人才团队。\n教育经历\n示例大学\n自动化\n'
                  '本科\n2012 - 2016\n另一大学\n计算机\n硕士研究生\n2016 - 2019')
        self.assertEqual(extract_candidate_profile(resume)['education'], '硕士研究生')

    def test_current_labeled_city_precedes_desired_city_and_not_company_place(self):
        resume = ('张**\n现居城市：苏州\n期望职位\n上海\n研发工程师\n25-30K\n工作经历\n'
                  '示例（温州）有限公司\n软件工程师\n2020.01 - 至今')
        self.assertEqual(extract_candidate_profile(resume)['city'], '苏州')
        self.assertNotIn('city', extract_candidate_profile('工作经历\n示例（温州）有限公司\n软件工程师\n2020.01 - 至今'))

    def test_horizontal_intent_and_education_metadata(self):
        resume = '张**\n刚刚活跃 · 29岁 · 8年 · 本科\n期望职位\n深圳 · 算法工程师 · 行业不限 · 21-24K'
        profile = extract_candidate_profile(resume)
        self.assertEqual(profile['city'], '深圳')
        self.assertEqual(profile['education'], '本科')

    def test_skills_deduplicate_tags_across_jobs_and_exclude_headers_and_dates(self):
        resume = ('工作经历\n示例科技有限公司\n图像算法\n研发部门\n2022.06 - 至今\n'
                  '负责工业检测和软件研发。\nOpenCV\nC++\n'
                  '上一家科技有限公司\n视觉工程师\n2020.01 - 2022.05\n'
                  '1. 开发工业软件。\nOpenCV\nPython\n教育经历\n示例大学\n本科\n2012 - 2016')
        self.assertEqual(extract_candidate_profile(resume)['skills'], 'OpenCV\nC++\nPython')

    def test_explicit_skill_section_supports_single_tag_without_prose(self):
        profile = extract_candidate_profile('专业技能\nOpenCV\n教育经历\n示例大学\n本科\n2012 - 2016')
        self.assertEqual(profile['skills'], 'OpenCV')
        profile = extract_candidate_profile('工作经历\n示例科技有限公司\n工程师\n2022.01 - 至今\n'
                                            '负责软件开发。\n这是一个比较长的工作说明，需要按项目计划完成开发测试。')
        self.assertNotIn('skills', profile)

    def test_full_plain_text_is_primary_when_rich_text_is_partial(self):
        resume = '工作经历\n示例科技有限公司\n算法工程师\n2022.06 - 至今'
        self.assertEqual(extract_candidate_profile(resume, '<p>只有姓名</p>')['company'], '示例科技有限公司')

    def test_rich_text_is_safe_fallback_for_empty_plain_text(self):
        rich = ('<script>工作经历 伪造科技有限公司 算法工程师</script>'
                '<h2>工作经历</h2><p>示例科技有限公司</p><p>算法工程师</p><p>2022.06 - 至今</p>')
        self.assertEqual(extract_candidate_profile('', rich), {'company': '示例科技有限公司', 'title': '算法工程师'})

    def test_empty_invalid_and_oversize_input_never_raise(self):
        for value in ['', '  ', None, {}, ['text'], 'a' * 30001]:
            with self.subTest(value_type=type(value).__name__):
                self.assertEqual(extract_candidate_profile_with_sources(value), {'profile': {}, 'profile_sources': {}})
        self.assertEqual(extract_candidate_profile('普通自述，没有结构化信息。'), {})

    def test_contact_fields_are_not_extracted_in_this_profile_feature(self):
        self.assertEqual(extract_candidate_profile('张**\n手机：13800000000\n微信：test\n邮箱：a@example.test'), {})


if __name__ == '__main__':
    unittest.main()
