"""Profile metadata is populated from copied resumes, without changing source records."""
import base64
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import server
from record_editing import evaluation_resume, profile_record


RESUME = '''张**
8年 · 本科
期望职位
杭州
机器视觉工程师
15-20K
工作经历
示例视觉科技有限公司
高级算法工程师
2022.06 - 至今
1. 负责工业检测项目部署。
OpenCV
C++
教育经历
示例大学
计算机科学与技术
本科
2015 - 2019'''
NEXT_RESUME = RESUME.replace('示例视觉科技有限公司', '下一站视觉科技有限公司').replace(
    '高级算法工程师', '机器视觉项目经理').replace('杭州', '宁波')
CAPTURE = {'status': 'visible_complete', 'sections': ['工作经历', '教育经历'], 'warnings': []}
PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfkAAAAASUVORK5CYII=')
FORM_FIELDS = ('job_id', 'name', 'resume', 'phone', 'email', 'link', 'note', 'revision',
               'company', 'title', 'city', 'education', 'skills', 'wechat')


class ProfileAutofillTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for attribute, filename in [('DB', 'profiles.sqlite'), ('EXTENSION_FILE', 'extension.json')]:
            patcher = patch.object(server, attribute, Path(directory.name) / filename)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.model = patch.object(server.CompatibleModel, 'complete', side_effect=AssertionError(
            'Profile extraction must not call the external model'))
        self.model_mock = self.model.start()
        self.addCleanup(self.model.stop)
        server.init_db()
        with server.connect() as db:
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)',
                       (1, '测试招聘岗位', '北京', '职位要求', '机器视觉经验', 'fixture'))
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_http)
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def post(self, path, data):
        request = urllib.request.Request(
            self.base + path, data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'X-App-Token': server.TOKEN})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def candidates(self):
        with urllib.request.urlopen(self.base + '/api/state', timeout=5) as response:
            return json.load(response)['candidates']

    def candidate(self, cid):
        return next(candidate for candidate in self.candidates() if candidate['id'] == cid)

    def create(self, **changes):
        return self.post('/api/candidates', {'job_id': 1, 'name': '张**', 'resume': RESUME, **changes})['id']

    def update(self, cid, **changes):
        previous = self.candidate(cid)
        return self.post('/api/candidates/update', {'id': cid, **{
            field: previous[field] for field in FORM_FIELDS}, **changes})

    def snapshot(self, tables):
        with server.connect() as db:
            return {table: [tuple(row) for row in db.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
                    for table in tables}

    def assert_profile(self, candidate, *, company='示例视觉科技有限公司', title='高级算法工程师', city='杭州'):
        self.assertEqual(candidate['company'], company)
        self.assertEqual(candidate['title'], title)
        self.assertEqual(candidate['city'], city)
        self.assertIn('本科', candidate['education'])
        self.assertIn('OpenCV', candidate['skills'])
        self.assertIn('C++', candidate['skills'])

    def seed_retained_source(self, cid):
        with server.connect() as db:
            server.save_source(db, cid, CAPTURE)
            db.execute('''UPDATE candidate_sources SET share_image=?,share_status=?,qr_url=?,qr_status=?
                WHERE candidate_id=?''', (PNG, '合成二维码图片', 'https://www.zhipin.com/qr/fixture', 'recognized', cid))
            server.save_resume_format(db, cid, '<h2>工作经历</h2><p>合成富文本原文</p>')
            db.execute("UPDATE candidates SET review='通过复核',note='人工备注' WHERE id=?", (cid,))
            cur = db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                             (cid, 'fixture', json.dumps({'score': 78}), 'fixture-evaluated'))
            db.execute('INSERT INTO evaluation_inputs VALUES(?,?)', (cur.lastrowid, 'fixture-cache'))
            server.audit(db, 'evaluate', str(cid))

    def test_manual_create_automatically_populates_empty_fields_with_resume_evidence(self):
        cid = self.create()
        candidate = self.candidate(cid)
        self.assert_profile(candidate)
        self.assertEqual(candidate['resume'], RESUME)
        for field in ('company', 'title', 'city', 'education', 'skills'):
            source = candidate['profile_sources'][field]
            self.assertEqual(source['source'], 'resume')
            self.assertTrue(source['evidence'])
        self.assertEqual(candidate['phone'], '')
        self.assertEqual(candidate['email'], '')
        self.assertEqual(candidate['wechat'], '')
        self.model_mock.assert_not_called()

    def test_plugin_import_populates_profile_without_changing_copied_resume(self):
        response = self.post('/api/extension/import', {'job_id': 1, 'candidates': [
            {'name': '张**', 'resume': RESUME, 'capture': CAPTURE}]})
        self.assertEqual(response['added'], 1)
        candidate = self.candidate(response['ids'][0])
        self.assert_profile(candidate)
        self.assertEqual(candidate['resume'], RESUME)
        self.assertEqual(candidate['source']['capture']['status'], 'visible_complete')
        self.assertFalse(candidate['has_resume_format'])

    def test_most_recent_employment_is_chosen_by_date_and_project_client_is_excluded(self):
        resume = RESUME.replace('工作经历\n', '''工作经历
历史自动化有限公司
软件工程师
2019.07 - 2022.05
1. 负责旧设备维护。
''', 1).replace('教育经历\n', '''项目经验
客户科技有限公司
项目负责人
2025.01 - 至今
1. 客户项目交付。
教育经历
''', 1)
        cid = self.create(resume=resume)
        candidate = self.candidate(cid)
        self.assert_profile(candidate)
        self.assertNotIn('客户科技', candidate['profile_sources']['company']['evidence'])

    def test_backfill_preserves_sources_dates_reviews_and_history_and_is_idempotent(self):
        with server.connect() as db:
            cur = db.execute('''INSERT INTO candidates(job_id,name,resume,phone,email,link,created)
                VALUES(1,'旧候选人',?,'','','','2026-10-01T01:02:03+00:00')''', (RESUME,))
            cid = cur.lastrowid
        self.seed_retained_source(cid)
        tables = ['candidates', 'candidate_sources', 'candidate_resume_formats', 'evaluations', 'evaluation_inputs']
        before = self.snapshot(tables)
        server.init_db()
        candidate = self.candidate(cid)
        self.assert_profile(candidate)
        self.assertEqual(self.snapshot(tables), before)
        self.assertFalse(candidate['ai_pending'])
        after = self.snapshot(tables + ['candidate_profiles', 'candidate_profile_sources', 'audit'])
        server.init_db()
        self.assertEqual(self.snapshot(list(after)), after)

    def test_backfill_preserves_existing_manual_values_but_fills_other_empty_fields(self):
        with server.connect() as db:
            cur = db.execute('''INSERT INTO candidates(job_id,name,resume,phone,email,link,created)
                VALUES(1,'旧候选人',?,'','','','fixture')''', (RESUME,))
            cid = cur.lastrowid
            server.bump_profile(db, cid, {'company': '人工确认的当前公司', 'city': '温州'})
        server.init_db()
        candidate = self.candidate(cid)
        self.assert_profile(candidate, company='人工确认的当前公司', city='温州')
        self.assertEqual(candidate['profile_sources']['company']['source'], 'manual')
        self.assertEqual(candidate['profile_sources']['city']['source'], 'manual')
        self.assertEqual(candidate['profile_sources']['title']['source'], 'resume')

    def test_manual_override_and_explicit_empty_are_not_overwritten_by_resume_edits(self):
        cid = self.create()
        self.update(cid, company='人工确认的公司', city='')
        candidate = self.candidate(cid)
        self.assertEqual(candidate['profile_sources']['company']['source'], 'manual')
        self.assertEqual(candidate['profile_sources']['city']['source'], 'manual')
        self.update(cid, resume=NEXT_RESUME)
        candidate = self.candidate(cid)
        self.assert_profile(candidate, company='人工确认的公司', title='机器视觉项目经理', city='')
        server.init_db()
        self.assertEqual(self.candidate(cid)['city'], '')

    def test_changed_resume_refreshes_auto_values_and_removes_unverifiable_old_metadata(self):
        cid = self.create()
        self.update(cid, resume=NEXT_RESUME)
        self.assert_profile(self.candidate(cid), company='下一站视觉科技有限公司', title='机器视觉项目经理', city='宁波')
        self.update(cid, resume='张**\n个人简介\n熟悉工业设备软件交付和跨部门协作。')
        candidate = self.candidate(cid)
        for field in ('company', 'title', 'city', 'education', 'skills'):
            self.assertEqual(candidate[field], '', field)
        self.assertIn('熟悉工业设备', candidate['resume'])

    def test_note_only_edit_preserves_auto_sources_and_does_not_mark_ai_pending(self):
        cid = self.create()
        self.seed_retained_source(cid)
        before = self.candidate(cid)
        result = self.update(cid, note='新的人工备注')
        after = self.candidate(cid)
        self.assertFalse(result['evaluation_invalidated'])
        self.assertEqual(after['profile_sources'], before['profile_sources'])
        self.assertFalse(after['ai_pending'])
        self.assertEqual(len(after['history']), 1)

    def test_reimport_keeps_manual_override_but_refreshes_auto_metadata(self):
        card = server.source_card({'name': '张**', 'signature': '张** 本科 8年 杭州 在职 工业视觉软件交付'})
        cid, added = server.save_boss_candidate(1, '张**', RESUME, '', CAPTURE, card=card)
        self.assertTrue(added)
        self.update(cid, company='人工确认的公司')
        duplicate_id, added = server.save_boss_candidate(1, '张**', NEXT_RESUME, '', CAPTURE, card=card)
        self.assertEqual((duplicate_id, added), (cid, False))
        self.assert_profile(self.candidate(cid), company='人工确认的公司', title='机器视觉项目经理', city='宁波')

    def test_preview_does_not_save_or_evaluate_and_does_not_fabricate_job_defaults(self):
        before = self.snapshot(['candidates', 'candidate_profiles', 'candidate_profile_sources', 'audit'])
        preview = self.post('/api/candidates/extract-profile', {'resume': RESUME})
        self.assert_profile(preview['profile'])
        self.assertEqual(preview['profile_sources']['company']['source'], 'resume')
        self.assertEqual(self.snapshot(list(before)), before)
        empty = self.post('/api/candidates/extract-profile', {'resume': '只有普通个人介绍，没有明确公司、职位、城市和学历。'})
        self.assertFalse(any(empty['profile'].values()))
        self.model_mock.assert_not_called()

    def test_stale_revision_cannot_overwrite_auto_or_manual_values(self):
        cid = self.create()
        old = self.candidate(cid)
        self.update(cid, note='先保存的编辑')
        before = self.snapshot(['candidates', 'candidate_profiles', 'candidate_profile_sources', 'audit'])
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.post('/api/candidates/update', {'id': cid,
                **{field: old[field] for field in FORM_FIELDS}, 'resume': NEXT_RESUME, 'company': '不应写入'})
        self.assertEqual(raised.exception.code, 409)
        self.assertEqual(self.snapshot(list(before)), before)

    def test_auto_metadata_does_not_become_duplicate_manual_evidence_for_ai(self):
        cid = self.create()
        with server.connect() as db:
            auto_profile = profile_record(db, cid)
        self.assertEqual(evaluation_resume(RESUME, auto_profile), RESUME)
        self.update(cid, company='人工核实的公司')
        with server.connect() as db:
            manual_profile = profile_record(db, cid)
        evaluated = evaluation_resume(RESUME, manual_profile)
        self.assertIn('人工核实的公司', evaluated)
        self.assertNotIn('人工维护·当前职位', evaluated)
        self.assertNotIn('人工维护·城市', evaluated)

    def test_preview_auto_fields_cannot_turn_client_inventions_into_resume_evidence(self):
        cid = self.create(company='伪造的简历公司', profile_auto_fields=['company'])
        candidate = self.candidate(cid)
        self.assertEqual(candidate['company'], '示例视觉科技有限公司')
        self.assertEqual(candidate['profile_sources']['company']['source'], 'resume')

    def test_stale_preview_is_recomputed_from_latest_resume_on_create_and_update(self):
        old_preview = self.post('/api/candidates/extract-profile', {'resume': RESUME})['profile']
        fields = ['company', 'title', 'city', 'education', 'skills']
        cid = self.create(**old_preview, resume=NEXT_RESUME, profile_auto_fields=fields)
        self.assert_profile(self.candidate(cid), company='下一站视觉科技有限公司', title='机器视觉项目经理', city='宁波')
        newest = NEXT_RESUME.replace('下一站视觉科技有限公司', '第三站视觉科技有限公司').replace('宁波', '温州')
        self.update(cid, **old_preview, resume=newest, profile_auto_fields=fields)
        self.assert_profile(self.candidate(cid), company='第三站视觉科技有限公司', title='机器视觉项目经理', city='温州')

    def test_manual_flags_take_precedence_over_auto_preview(self):
        cid = self.create(company='人工确认的公司', profile_auto_fields=['company'], profile_manual_fields=['company'])
        self.assertEqual(self.candidate(cid)['company'], '人工确认的公司')
        self.assertEqual(self.candidate(cid)['profile_sources']['company']['source'], 'manual')

    def test_explicit_manual_empty_prevents_later_autofill_even_if_original_was_empty(self):
        cid = self.create(resume='张**\n个人简介\n熟悉工业设备软件交付。')
        self.update(cid, company='', profile_manual_fields=['company'])
        self.update(cid, resume=RESUME)
        candidate = self.candidate(cid)
        self.assertEqual(candidate['company'], '')
        self.assertEqual(candidate['profile_sources']['company']['source'], 'manual')
        self.assertEqual(candidate['title'], '高级算法工程师')


    def test_canvas_inline_sections_populate_imported_fields_with_exact_original_evidence(self):
        resume = """张**
34岁 9年 硕士 在职-考虑机会
期望职位 无锡 图像算法 行业不限 22-40K
工作经历 示例视觉科技有限公司 图像算法 2017.07 - 2026.11
负责视觉检测项目研发和交付。
教育经历 示例大学 机械电子工程 硕士 2014 - 2017"""
        response = self.post('/api/extension/import', {'job_id': 1, 'candidates': [
            {'name': '张**', 'resume': resume, 'capture': CAPTURE}]})
        candidate = self.candidate(response['ids'][0])
        for field, value in {'company': '示例视觉科技有限公司', 'title': '图像算法',
                             'city': '无锡', 'education': '硕士'}.items():
            self.assertEqual(candidate[field], value, field)
            self.assertIn(candidate['profile_sources'][field]['evidence'], resume.splitlines())
        self.assertEqual(candidate['resume'], resume)
        self.model_mock.assert_not_called()

    def test_canvas_backfill_preserves_manual_fields_original_resume_and_saved_evaluation(self):
        resume = """张**
34岁 9年 硕士 在职-考虑机会
期望职位 无锡 图像算法 行业不限 22-40K
工作经历 示例视觉科技有限公司 图像算法 2017.07 - 2026.11
负责视觉检测项目研发和交付。
教育经历 示例大学 机械电子工程 硕士 2014 - 2017"""
        with server.connect() as db:
            cur = db.execute("""INSERT INTO candidates(job_id,name,resume,phone,email,link,created)
                VALUES(1,'旧候选人',?,'','','','fixture')""", (resume,))
            cid = cur.lastrowid
            server.bump_profile(db, cid, {'city': '人工确认城市'})
        self.seed_retained_source(cid)
        tables = ['candidates', 'candidate_sources', 'candidate_resume_formats', 'evaluations', 'evaluation_inputs']
        before = self.snapshot(tables)
        server.init_db()
        candidate = self.candidate(cid)
        self.assertEqual(candidate['company'], '示例视觉科技有限公司')
        self.assertEqual(candidate['title'], '图像算法')
        self.assertEqual(candidate['education'], '硕士')
        self.assertEqual(candidate['city'], '人工确认城市')
        self.assertEqual(candidate['profile_sources']['city']['source'], 'manual')
        self.assertEqual(self.snapshot(tables), before)
        after = self.snapshot(tables + ['candidate_profiles', 'candidate_profile_sources', 'audit'])
        server.init_db()
        self.assertEqual(self.snapshot(list(after)), after)
        self.model_mock.assert_not_called()


if __name__ == '__main__':
    unittest.main()
