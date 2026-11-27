import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import server

PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfkAAAAASUVORK5CYII='
CAPTURE = {'status':'needs_review', 'sections':['工作经历','教育经历'], 'warnings':['等待人工核对']}


class CollectionStatusTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = patch.object(server, 'DB', Path(self.directory.name) / 'capture.sqlite')
        self.database.start()
        server.init_db()
        with server.connect() as db:
            for job in (1, 2):
                db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)', (job, f'岗位{job}', '', 'JD', '条件', 'now'))
        self.card = {'name':'张**', 'signature':'张** 本科 8年 温州 在职 熟悉视觉软件开发和生产线调试 期望机器视觉工程师'}
        self.resume = '张**\n工作经历\n负责机器视觉算法和工业检测软件开发，并完成生产线现场调试。\n教育经历\n虚构大学本科。'
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.database.stop()
        self.directory.cleanup()

    def post(self, path, data):
        request = urllib.request.Request(self.base + path, data=json.dumps(data).encode(),
            headers={'X-App-Token':server.TOKEN, 'Content-Type':'application/json'})
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def save(self, card=None, resume=None):
        return self.post('/api/extension/import', {'job_id':1, 'candidates':[{
            'name':'张**', 'resume':resume or self.resume, 'capture':CAPTURE,
            'source_card':card or self.card,
        }]})['ids'][0]

    def status(self, cards=None, job=1, share=False):
        return self.post('/api/extension/collection-status',
            {'job_id':job, 'cards':cards if cards is not None else [self.card], 'share':share})['completed']

    def test_saved_resume_is_skipped_but_missing_required_image_is_retried(self):
        cid = self.save()
        self.assertEqual(self.status(), [self.card['signature']])
        self.assertEqual(self.status(share=True), [])
        self.post('/api/candidates/share', {'id':cid, 'image':PNG})
        self.assertEqual(self.status(share=True), [self.card['signature']])
        self.assertEqual(self.save(), cid)
        with server.connect() as db:
            server.audit(db, 'evaluate_pending', str(cid))
        self.assertEqual(self.status(share=True), [self.card['signature']])
        self.assertEqual(self.status(job=2), [])

    def test_old_captures_with_unexpanded_honors_are_recopied_without_reviving_deleted_records(self):
        cid = self.save(resume=self.resume + '\n所获荣誉\n示例奖项\n展开全部 １６ 个所获荣誉')
        self.post('/api/candidates/share', {'id':cid, 'image':PNG})
        response = self.post('/api/extension/collection-status', {'job_id':1, 'cards':[self.card], 'share':True})
        self.assertEqual(response['completed'], [])
        self.assertEqual(response['known'], [])
        expanded = self.resume + '\n所获荣誉\n示例奖项\n另一项奖励'
        self.assertEqual(self.save(resume=expanded), cid)
        self.assertEqual(self.status(share=True), [self.card['signature']])
        with server.connect() as db:
            db.execute('UPDATE candidates SET resume=?,deleted=1 WHERE id=?', (self.resume + '\n展开全部16个所获荣誉', cid))
        self.assertEqual(self.status(share=True), [self.card['signature']])

    def test_name_and_ambiguous_fingerprints_do_not_skip_other_candidates(self):
        self.save()
        other = {**self.card, 'signature':'张** 硕士 5年 上海 离职 熟悉嵌入式软件开发和硬件驱动 期望研发工程师'}
        self.assertEqual(self.status([other]), [])
        self.assertEqual(self.status([self.card, self.card]), [])
        self.save(resume=self.resume + '\n另一段独立的任职经历。')
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidates').fetchone()[0], 1)
        other_id, _ = server.save_boss_candidate(1, '张**', self.resume + '\n完全不同的任职经历。', '')
        with server.connect() as db:
            db.execute('INSERT INTO candidate_card_keys VALUES(?,?,?)', (1, server.source_card(self.card)['key'], other_id))
        self.assertEqual(self.status(), [])

    def test_card_key_survives_new_connection_and_whitespace_changes(self):
        self.save()
        variant = {**self.card, 'signature':'  ' + self.card['signature'].replace(' ', '\n') + '  '}
        self.assertEqual(self.status([variant]), [variant['signature']])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_card_keys').fetchone()[0], 1)

    def test_old_records_require_unique_substantial_visible_text(self):
        prose = '独立设计多相机工业检测设备，开发视觉定位算法和软件架构，负责现场部署、运行验证和客户技术交付。' * 3
        employer = '测试精密装备股份有限公司视觉系统研发技术中心'
        card = {'name':'张**', 'signature':f'张** 8年 本科 {prose} 期望温州 {employer}'}
        resume = f'张**\n个人优势\n{prose}\n工作经历\n{employer}\n负责实施。\n教育经历\n测试大学。'
        cid, _ = server.save_boss_candidate(1, '张**', resume, '')
        self.assertEqual(self.status([card]), [card['signature']])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT candidate_id FROM candidate_card_keys').fetchone()[0], cid)
        weak = {'name':'张**', 'signature':'张** 8年 本科 温州 期望视觉工程师'}
        self.assertEqual(self.status([weak]), [])
        with server.connect() as db:
            db.execute('DELETE FROM candidate_card_keys')
        server.save_boss_candidate(1, '张**', resume + '\n不同履历版本。', '')
        self.assertEqual(self.status([card]), [])

    def test_invalid_source_card_is_rejected_before_resume_is_saved(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.save(card={**self.card, 'name':'李**'})
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidates').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_card_keys').fetchone()[0], 0)
        with self.assertRaises(urllib.error.HTTPError):
            self.status([self.card] * 201)
        with urllib.request.urlopen(self.base + '/api/state') as response:
            self.assertEqual(json.load(response)['collection_status_version'], 1)

    def test_activity_changes_reuse_original_resume_record(self):
        original = '张**\n刚刚活跃\n29岁 · 8年 · 本科\n' + self.resume
        updated = original.replace('刚刚活跃', '热搜\n今日活跃')
        first = self.save(resume=original)
        self.assertEqual(self.save(resume=updated), first)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidates').fetchone()[0], 1)
        variant = {**self.card, 'signature':self.card['signature'] + ' 热搜 今日活跃'}
        self.assertEqual(self.status([variant]), [variant['signature']])

    def test_cosmetic_duplicate_rows_form_one_collected_identity(self):
        prose = '独立设计多相机工业检测设备，开发视觉定位算法和软件架构，负责现场部署、运行验证和客户技术交付。' * 3
        employer = '测试精密装备股份有限公司视觉系统研发技术中心'
        card = {'name':'张**', 'signature':f'张** 29岁 8年 本科 {prose} 期望温州 {employer}'}
        resume = f'张**\n刚刚活跃\n29岁 8年 本科\n个人优势\n{prose}\n工作经历\n{employer}'
        first, _ = server.save_boss_candidate(1, '张**', resume, '')
        with server.connect() as db:
            db.execute('INSERT INTO candidates(job_id,name,resume,phone,email,link,created) VALUES(?,?,?,?,?,?,?)',
                (1,'张**',resume.replace('刚刚活跃','热搜\n今日活跃'),'','','','now'))
        self.assertEqual(self.status([card]), [card['signature']])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT candidate_id FROM candidate_card_keys').fetchone()[0], first)

    def test_delete_is_idempotent_hides_record_and_preserves_skip_marker(self):
        cid = self.save()
        self.assertEqual(self.post('/api/candidates/delete', {'ids':[cid]}), {'deleted':[cid]})
        self.assertEqual(self.post('/api/candidates/delete', {'ids':[cid,cid]}), {'deleted':[cid]})
        with urllib.request.urlopen(self.base + '/api/state') as response:
            self.assertEqual(json.load(response)['candidates'], [])
        self.assertEqual(self.status(share=True), [self.card['signature']])
        for path, data in [
            ('/api/export', {'ids':[cid]}),
            ('/api/review', {'id':cid, 'review':'通过复核'}),
            ('/api/candidates/share', {'id':cid,'image':PNG}),
            ('/api/extension/import', {'job_id':1,'candidates':[{
                'name':'张**','resume':self.resume,'source_card':self.card}]}),
        ]:
            with self.assertRaises(urllib.error.HTTPError):
                self.post(path, data)
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(self.base + f'/api/candidates/{cid}/resume.html')

    def test_delete_validates_whole_selection_and_respects_model_lock(self):
        cid = self.save()
        for ids in ([cid,9999], [True], [], ['1']):
            with self.assertRaises(urllib.error.HTTPError):
                self.post('/api/candidates/delete', {'ids':ids})
        server.AI_LOCK.acquire()
        try:
            with self.assertRaises(urllib.error.HTTPError) as busy:
                self.post('/api/candidates/delete', {'ids':[cid]})
            self.assertEqual(busy.exception.code, 409)
        finally:
            server.AI_LOCK.release()
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT deleted FROM candidates WHERE id=?',(cid,)).fetchone()[0], 0)

    def test_clear_mark_allows_same_resume_to_be_recaptured_and_preserves_review_history(self):
        cid = self.save()
        with server.connect() as db:
            db.execute("UPDATE candidates SET review='通过复核',note='人工复核备注' WHERE id=?", (cid,))
            db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)', (cid,'fixture','{}','now'))
        self.assertEqual(self.post('/api/candidates/delete', {'ids':[cid], 'clear_collection_marks':True}),
                         {'deleted':[cid], 'collection_marks_cleared':[cid]})
        self.assertEqual(self.status(), [])
        self.assertEqual(self.status(share=True), [])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_card_keys WHERE candidate_id=?', (cid,)).fetchone()[0], 0)
            self.assertEqual(tuple(db.execute('SELECT deleted,collection_mark_cleared FROM candidates WHERE id=?', (cid,)).fetchone()), (1,1))
        # A changing list label must attach its new card key to the restored
        # record, rather than depend on a cleared key or trip the UNIQUE index.
        new_card = {**self.card, 'signature':self.card['signature'] + ' 希望本月到岗'}
        self.assertEqual(self.save(card=new_card), cid)
        self.assertEqual(self.status([new_card]), [new_card['signature']])
        self.assertEqual(self.status([self.card]), [])
        with server.connect() as db:
            row = db.execute('SELECT deleted,collection_mark_cleared,review,note FROM candidates WHERE id=?', (cid,)).fetchone()
            self.assertEqual(tuple(row), (0,0,'通过复核','人工复核备注'))
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations WHERE candidate_id=?', (cid,)).fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM audit WHERE action='restore_candidate_collection' AND detail=?", (str(cid),)).fetchone()[0], 1)

    def test_clearing_a_mark_disables_legacy_resume_fingerprint_matching_too(self):
        prose = '独立设计多相机工业检测设备，开发视觉定位算法和软件架构，负责现场部署、运行验证和客户技术交付。' * 3
        employer = '测试精密装备股份有限公司视觉系统研发技术中心'
        card = {'name':'张**', 'signature':f'张** 29岁 8年 本科 {prose} 期望温州 {employer}'}
        resume = f'张**\n29岁 8年 本科\n个人优势\n{prose}\n工作经历\n{employer}'
        cid, _ = server.save_boss_candidate(1, '张**', resume, '')
        self.assertEqual(self.status([card]), [card['signature']])
        self.post('/api/candidates/delete', {'ids':[cid], 'clear_collection_marks':True})
        self.assertEqual(self.status([card]), [])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_card_keys WHERE candidate_id=?', (cid,)).fetchone()[0], 0)

    def test_clearing_selected_marks_leaves_other_people_and_jobs_unchanged(self):
        cid = self.save()
        other_card = {**self.card, 'signature':'张** 博士 3年 上海 另一人的嵌入式驱动与开发经历'}
        other = self.save(card=other_card, resume=self.resume + '\n另一人的独立嵌入式经历。')
        second_job, _ = server.save_boss_candidate(2, '张**', self.resume, '', card=server.source_card(self.card))
        with server.connect() as db:
            # Selected candidates may carry aliases from a prior job move.
            db.execute('INSERT INTO candidate_card_keys VALUES(?,?,?)', (2,'selected-old-alias',cid))
        self.post('/api/candidates/delete', {'ids':[cid], 'clear_collection_marks':True})
        self.assertEqual(self.status([self.card,other_card]), [other_card['signature']])
        self.assertEqual(self.status(job=2), [self.card['signature']])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_card_keys WHERE candidate_id=?', (cid,)).fetchone()[0], 0)
            for unaffected in [other,second_job]:
                self.assertEqual(tuple(db.execute('SELECT deleted,collection_mark_cleared FROM candidates WHERE id=?', (unaffected,)).fetchone()), (0,0))
        new_id = self.save(resume=self.resume + '\n新增的不同项目经历。')
        self.assertNotEqual(new_id,cid)
        self.assertEqual(self.status(), [self.card['signature']])

    def test_clear_option_is_strict_and_whole_selection_rolls_back(self):
        cid = self.save()
        for value in [None,0,1,'true','false',[],{}]:
            with self.subTest(value=value), self.assertRaises(urllib.error.HTTPError) as error:
                self.post('/api/candidates/delete', {'ids':[cid], 'clear_collection_marks':value})
            self.assertEqual(error.exception.code,400)
        with self.assertRaises(urllib.error.HTTPError):
            self.post('/api/candidates/delete', {'ids':[cid,99999], 'clear_collection_marks':True})
        server.AI_LOCK.acquire()
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.post('/api/candidates/delete', {'ids':[cid], 'clear_collection_marks':True})
            self.assertEqual(error.exception.code,409)
        finally:
            server.AI_LOCK.release()
        self.assertEqual(self.status(), [self.card['signature']])
        with server.connect() as db:
            self.assertEqual(tuple(db.execute('SELECT deleted,collection_mark_cleared FROM candidates WHERE id=?', (cid,)).fetchone()), (0,0))
            self.assertEqual(db.execute("SELECT count(*) FROM audit WHERE action='clear_collection_marks'").fetchone()[0],0)

    def test_default_and_false_keep_mark_while_repeated_deletion_does_not_recreate_cleared_mark(self):
        cid = self.save()
        self.post('/api/candidates/delete', {'ids':[cid], 'clear_collection_marks':False})
        self.assertEqual(self.status(), [self.card['signature']])
        with self.assertRaises(urllib.error.HTTPError):
            self.save()
        self.post('/api/candidates/delete', {'ids':[cid], 'clear_collection_marks':True})
        self.post('/api/candidates/delete', {'ids':[cid]})
        server.init_db()  # The migration must not replace a stored preference.
        self.assertEqual(self.status(), [])
        self.assertEqual(self.save(),cid)

    def test_batch_clear_affects_only_selected_rows(self):
        first = self.save()
        second_card = {**self.card,'signature':self.card['signature'] + ' 第二条独立履历'}
        second = self.save(card=second_card,resume=self.resume + '\n另一段不同经历。')
        retained_card = {**self.card,'signature':self.card['signature'] + ' 保留的第三条履历'}
        retained = self.save(card=retained_card,resume=self.resume + '\n第三段独立经历。')
        response = self.post('/api/candidates/delete', {'ids':[first,second,first], 'clear_collection_marks':True})
        self.assertEqual(response, {'deleted':[first,second],'collection_marks_cleared':[first,second]})
        self.assertEqual(self.status([self.card,second_card,retained_card]), [retained_card['signature']])
        with server.connect() as db:
            self.assertEqual([row[0] for row in db.execute('SELECT id FROM candidates WHERE deleted=0')], [retained])

    def test_evaluation_does_not_save_for_a_resume_updated_during_model_call(self):
        cid = self.save()
        result = {'score':70,'category':'待确认','summary':'测试结论','questions':[],
            'checks':[{'condition':'技能','status':'信息不足','evidence':''}]}
        def complete(*_):
            with server.connect() as db:
                db.execute('UPDATE candidates SET resume=resume || ? WHERE id=?', ('新经历',cid))
            return result
        with patch.object(server, 'complete_evaluation', side_effect=complete):
            with self.assertRaises(urllib.error.HTTPError):
                self.post('/api/ai/evaluate', {'id':cid})
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
