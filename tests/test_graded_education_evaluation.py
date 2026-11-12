from copy import deepcopy
import unittest
import server

POLICY = '本科及以上学历，自动化相关专业；本科要求全日制；硕士及以上可接受非全日制'


def resolve(resume, status='满足', support=100, basis='explicit'):
    check = {'condition_id':1,'condition':POLICY,'status':status,'basis':basis,
             'evidence_lines':[2],'support_score':support,
             'reasoning':'已支持学历和专业部分，但尚需核实学习形式。'}
    result = {'score':100,'category':'推荐','summary':'合成学历核验。','questions':[],
              'checks':[check], 'required_checks':[{**deepcopy(check),'requirement_id':1}],
              'inferred_capabilities':[]}
    return server.resolve_evaluation(result,resume.splitlines(),resume,condition_rules=[POLICY],
        required_rules=[POLICY],structured_scoring=True,priority_groups=[[POLICY]])


class GradedEducationEvaluationTests(unittest.TestCase):
    def test_known_non_full_time_bachelor_cannot_be_met_or_receive_partial_credit(self):
        resume='合成候选人\n本科 · 非全日制\n教育经历\n示例大学\n自动化\n本科 · 非全日制\n2018 - 2022'
        for status,score,basis in [('满足',100,'explicit'),('信息不足',30,'inferred')]:
            with self.subTest(status=status):
                result=resolve(resume,status,score,basis)
                self.assertEqual((result['score'],result['must_have_status'],result['category']),(0,'not_met','低匹配'))
                self.assertEqual(result['checks'][0]['education_policy_adjustment']['original_status'],status)
        result=resolve(resume,'不满足',0)
        self.assertEqual((result['score'],result['must_have_status'],result['category']),(0,'not_met','低匹配'))

    def test_non_full_time_master_is_accepted_even_with_lower_non_full_time_bachelor(self):
        resume='合成候选人\n硕士 · 非全日制\n教育经历\n示例大学\n自动化\n硕士 · 非全日制\n2021 - 2024\n示例学院\n自动化\n本科 · 非全日制\n2015 - 2019'
        result=resolve(resume)
        self.assertEqual((result['score'],result['must_have_status']),(100,'met'))

    def test_unspecified_bachelor_mode_defaults_full_time_without_overriding_other_gaps(self):
        resume='合成候选人\n本科\n教育经历\n示例大学\n自动化\n本科\n2018 - 2022'
        result=resolve(resume)
        self.assertEqual(result['score'],100)
        self.assertEqual(result['must_have_status'],'met')
        self.assertEqual(result['checks'][0]['education_policy_adjustment']['reason'],
            'unspecified_bachelor_mode_default_full_time')
        result=resolve(resume,'信息不足',30,'inferred')
        self.assertEqual(result['score'],30)
        self.assertEqual(result['must_have_status'],'unknown')
        self.assertEqual(result['scoring']['condition_scores'][0]['ratio'],0.3)

    def test_full_time_bachelor_passes_and_invalid_granularity_is_rejected(self):
        resume='合成候选人\n本科 · 全日制\n教育经历\n示例大学\n自动化\n本科 · 全日制\n2018 - 2022'
        self.assertEqual(resolve(resume)['score'],100)
        with self.assertRaises(server.EvaluationFormatError): resolve(resume,'信息不足',27,'inferred')


if __name__=='__main__': unittest.main()
