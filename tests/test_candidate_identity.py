import unittest

from candidate_identity import canonical_card, canonical_resume, matches_card


class CandidateIdentityTests(unittest.TestCase):
    name = '杜**'
    summary = ('精通缺陷检测、尺寸测量、定位引导、OCR识别、位置度校验等视觉常规方案；'
               '熟练工业相机、镜头、环形光源选型，并完成多相机检测系统部署。')
    header = '杜**\n刚刚活跃\n29岁\n8年\n本科\n在职-考虑机会\n'

    def resume(self, header=None):
        return (self.header if header is None else header) + (
            '个人优势\n1. ' + self.summary +
            '\n工作经历\n示例精密装备有限公司\n机器视觉工程师\n负责生产线检测软件开发。'
            '\n教育经历\n示例工业大学\n机械\n本科\n2018 - 2021')

    def card(self):
        return {'name':self.name, 'signature':(
            '杜** 热搜 今日活跃 29岁 8年 本科 在职-考虑机会 15-20K\n'
            '1. ' + self.summary[:62].lower() + '…\n'
            '期望 温州 图像算法\n院校 示例工业大学 机械\n近14天你首次看到该牛人')}

    def test_cosmetic_header_activity_and_badges_do_not_create_new_identity(self):
        changed = self.header.replace('刚刚活跃', '热搜\n今日活跃')
        self.assertEqual(canonical_resume(self.resume()), canonical_resume(self.resume(changed)))
        self.assertEqual(canonical_resume(self.resume()), canonical_resume(self.resume().replace('OCR', 'ocr')))

    def test_career_and_profile_changes_are_retained(self):
        original = canonical_resume(self.resume())
        self.assertNotEqual(original, canonical_resume(self.resume().replace('8年', '9年', 1)))
        self.assertNotEqual(original, canonical_resume(self.resume().replace('负责生产线检测软件开发', '负责财务系统开发')))
        self.assertNotEqual(original, canonical_resume(self.resume().replace('在职-考虑机会', '离职-随时到岗')))
        self.assertNotEqual(original, canonical_resume(self.resume().replace('检测软件开发', '热搜检测软件开发')))

    def test_card_noise_changes_but_profile_facts_remain(self):
        card = self.card()['signature']
        changed = card.replace('热搜 今日活跃', '已收藏 2月内活跃') + ' 联系Ta 已查看'
        self.assertEqual(canonical_card(card), canonical_card(changed))
        self.assertNotEqual(canonical_card(card), canonical_card(card.replace('8年', '9年', 1)))

    def test_clipped_lowercase_card_summary_matches_with_profile_and_school(self):
        self.assertTrue(matches_card(self.card(), {'name':self.name, 'resume':self.resume()}))
        self.assertTrue(matches_card(self.card(), {'name':self.name, 'resume':self.resume().replace('刚刚活跃', '热搜\n今日活跃')}))

    def test_conflicting_profile_facts_block_even_substantial_overlap(self):
        for before, after in [('29岁','34岁'), ('8年','9年'), ('本科','硕士')]:
            with self.subTest(fact=before):
                changed = self.resume().replace(before, after, 1)
                self.assertFalse(matches_card(self.card(), {'name':self.name, 'resume':changed}))

    def test_masked_name_and_generic_short_profile_are_insufficient(self):
        candidate = {'name':self.name, 'resume':self.resume()}
        self.assertFalse(matches_card({'name':self.name, 'signature':'杜** 29岁 8年 本科'}, candidate))
        self.assertFalse(matches_card({'name':'李**', 'signature':self.card()['signature']}, candidate))
        self.assertFalse(matches_card(self.card(), {'name':self.name, 'resume':'杜**\n29岁\n8年\n本科\n工作经历\n从事其他领域工作。'}))

    def test_short_summary_needs_an_independent_entity_anchor(self):
        card = self.card()
        card['signature'] = card['signature'].replace('院校 示例工业大学 机械', '')
        self.assertFalse(matches_card(card, {'name':self.name, 'resume':self.resume()}))

    def test_one_long_exact_block_can_identify_a_unique_legacy_group(self):
        prose = '负责工业检测项目的需求分析、算法开发、运行验证与现场交付，完成多相机同步检测系统和标定工具。' * 3
        candidate = {'name':self.name, 'resume':self.name + '\n工作经历\n' + prose}
        card = {'name':self.name, 'signature':self.name + ' ' + prose}
        self.assertTrue(matches_card(card, candidate))


if __name__ == '__main__':
    unittest.main()
