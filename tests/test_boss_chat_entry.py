"""Persist confirmed BOSS chat identities without changing screening or contact data."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import server
import test_collection_rollback as rollback_fixture


class BossChatEntryTests(unittest.TestCase):
    stop_http = rollback_fixture.CollectionRollbackTests.stop_http
    candidate = rollback_fixture.CollectionRollbackTests.candidate

    def setUp(self):
        rollback_fixture.CollectionRollbackTests.setUp(self)
        inference = patch.object(server, 'complete_evaluation', side_effect=AssertionError('Unexpected inference'))
        inference.start(); self.addCleanup(inference.stop)
        queue = patch.object(server, 'submit_ai_request', side_effect=AssertionError('Unexpected AI task'))
        queue.start(); self.addCleanup(queue.stop)

    def post(self, path, data, headers=None):
        request = urllib.request.Request(self.base + path, data=json.dumps(data).encode(), headers={
            'X-App-Token':server.TOKEN, 'Content-Type':'application/json', **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def save(self, cid, card, uid='90071992547409931234'):
        return self.post('/api/extension/chat-entry', {'id':cid, 'source_card':card, 'boss_chat_uid':uid})

    def source(self, cid):
        with server.connect() as db:
            return server.source_info(db, cid)

    def status(self, card):
        return self.post('/api/extension/collection-status', {'job_id':1, 'cards':[card]})[1]

    def snapshot(self):
        with server.connect() as db:
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            result = {}
            for table in tables:
                rows = []
                for row in db.execute(f'SELECT * FROM "{table}" ORDER BY rowid'):
                    data = dict(row)
                    if table == 'candidate_sources':
                        data.pop('boss_chat_uid')
                    rows.append(data)
                result[table] = rows
            return result

    def test_exact_string_round_trip_idempotence_and_state_capability(self):
        cid, card = self.candidate()
        uid = '90071992547409931234'
        self.assertEqual(self.source(cid)['boss_chat_uid'], '')
        expected = {'ok':True, 'id':cid, 'boss_chat_uid':uid, 'has_chat_entry':True, 'changed':True}
        self.assertEqual(self.save(cid, card, uid), (200, expected))
        self.assertEqual(self.save(cid, card, uid), (200, {**expected, 'changed':False}))
        self.assertEqual(self.source(cid)['boss_chat_uid'], uid)
        with urllib.request.urlopen(self.base + '/api/state', timeout=5) as response:
            state = json.load(response)
        self.assertEqual(state['boss_chat_entry_version'], 1)
        self.assertEqual(state['candidates'][0]['source']['boss_chat_uid'], uid)

    def test_uid_must_be_canonical_positive_ascii_string(self):
        cid, card = self.candidate()
        invalid = [None, '', '0', '01', '+12', '-12', '12.0', '1e3', ' 12', '12 ', '12\n',
                   '１２', '١٢', 'abcEncrypted~', '1' * 21, True, False, 123, 1.5, [], {}]
        for uid in invalid:
            with self.subTest(uid=uid):
                self.assertEqual(self.save(cid, card, uid)[0], 400)
                self.assertEqual(self.source(cid)['boss_chat_uid'], '')
        self.assertEqual(self.save(cid, card, '1')[0], 200)

    def test_missing_deleted_and_invalid_candidate_ids_are_rejected(self):
        cid, card = self.candidate()
        for invalid in [None, True, 0, -1, str(cid), float(cid), 999999]:
            with self.subTest(candidate=invalid):
                self.assertEqual(self.save(invalid, card)[0], 400)
        with server.connect() as db:
            db.execute('UPDATE candidates SET deleted=1 WHERE id=?', (cid,))
        self.assertEqual(self.save(cid, card)[0], 400)
        self.assertEqual(self.source(cid)['boss_chat_uid'], '')

    def test_wrong_name_card_and_ambiguous_mapping_never_attach_uid(self):
        cid, card = self.candidate()
        other, other_card = self.candidate('other')
        for incorrect in [{**card, 'name':'李**'}, {**card, 'signature':'另一张来源卡片'}, other_card]:
            with self.subTest(card=incorrect):
                status, result = self.save(cid, incorrect)
                self.assertEqual(status, 409)
                self.assertEqual(result['code'], 'record_conflict')
        with server.connect() as db:
            db.execute('INSERT INTO candidate_card_keys VALUES(?,?,?)', (1, server.source_card(card)['key'], other))
        self.assertEqual(self.save(cid, card)[0], 409)
        self.assertEqual(self.source(cid)['boss_chat_uid'], '')
        self.assertEqual(self.source(other)['boss_chat_uid'], '')

    def test_conflicting_uid_does_not_replace_existing_entry(self):
        cid, card = self.candidate()
        self.assertEqual(self.save(cid, card, '111')[0], 200)
        before = self.snapshot()
        status, result = self.save(cid, card, '222')
        self.assertEqual(status, 409)
        self.assertEqual(result['code'], 'record_conflict')
        self.assertEqual(self.source(cid)['boss_chat_uid'], '111')
        self.assertEqual(self.snapshot(), before)

    def test_simultaneous_conflicting_submissions_commit_one_identity(self):
        cid, card = self.candidate()
        barrier = threading.Barrier(2)
        def submit(uid):
            barrier.wait(timeout=5)
            return uid, self.save(cid, card, uid)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(submit, ['111', '222']))
        self.assertEqual(sorted(result[0] for _, result in results), [200,409])
        winner = next(uid for uid, result in results if result[0] == 200)
        self.assertEqual(self.source(cid)['boss_chat_uid'], winner)

    def test_only_chat_uid_changes_in_entire_database(self):
        cid, card = self.candidate()
        with server.connect() as db:
            db.execute("UPDATE candidates SET link='https://example.invalid/manual',phone='synthetic',review='通过复核',note='保留备注' WHERE id=?", (cid,))
            db.execute("UPDATE candidate_sources SET share_image=x'89504E47',share_status='已获取',qr_url='https://www.zhipin.com/test',qr_status='manual',origin='original-source' WHERE candidate_id=?", (cid,))
            db.execute("UPDATE candidate_profiles SET revision=8,wechat='fixture-only' WHERE candidate_id=?", (cid,))
            db.execute("INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,'fixture','{}','now')", (cid,))
            db.execute("INSERT INTO candidate_colleague_shares VALUES(?,'fixture-colleague','confirmed','now')", (cid,))
            db.execute("INSERT INTO candidate_resume_formats VALUES(?,'<p>原始格式</p>')", (cid,))
        before = self.snapshot()
        self.assertEqual(self.save(cid, card)[0], 200)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.source(cid)['boss_chat_uid'], '90071992547409931234')

    def test_missing_source_row_is_created_with_safe_defaults(self):
        cid, card = self.candidate()
        with server.connect() as db:
            db.execute('DELETE FROM candidate_sources WHERE candidate_id=?', (cid,))
        self.assertEqual(self.source(cid)['boss_chat_uid'], '')
        self.assertEqual(self.save(cid, card, '123')[0], 200)
        self.assertEqual(self.source(cid), {'capture':None,'share_status':'未获取','image_url':'',
            'qr_url':'','qr_status':'not_checked','origin':'','boss_chat_uid':'123','boss_greeting':[]})

    def test_collection_reports_saved_entry_and_ignores_invalid_legacy_values(self):
        cid, card = self.candidate()
        before = self.status(card)
        self.assertFalse(before['known'][0]['has_chat_entry'])
        self.assertTrue(before['known'][0]['chat_entry_eligible'])
        self.assertEqual(self.save(cid, card)[0], 200)
        after = self.status(card)
        self.assertTrue(after['known'][0]['has_chat_entry'])
        before['known'][0]['has_chat_entry'] = True
        self.assertEqual(after, before)
        with server.connect() as db:
            db.execute("UPDATE candidate_sources SET boss_chat_uid='encrypted~' WHERE candidate_id=?", (cid,))
        self.assertFalse(self.status(card)['known'][0]['has_chat_entry'])
        self.assertEqual(self.source(cid)['boss_chat_uid'], '')
        with server.connect() as db:
            db.execute("UPDATE candidate_sources SET boss_chat_uid='123' WHERE candidate_id=?", (cid,))
            db.execute('UPDATE candidates SET deleted=1 WHERE id=?', (cid,))
        deleted_status = self.status(card)
        self.assertFalse(deleted_status['known'][0]['has_chat_entry'])
        self.assertFalse(deleted_status['known'][0]['chat_entry_eligible'])

    def test_chat_entry_eligible_excludes_moved_and_ambiguous_mappings(self):
        cid, card = self.candidate()
        with server.connect() as db:
            db.execute("INSERT INTO jobs VALUES(2,'另一合成岗位','','合成JD','','now')")
            db.execute('UPDATE candidates SET job_id=2 WHERE id=?', (cid,))
        moved = self.status(card)
        self.assertEqual(moved['completed'], [card['signature']])
        self.assertFalse(moved['known'][0]['chat_entry_eligible'])
        with server.connect() as db:
            db.execute('UPDATE candidates SET job_id=1 WHERE id=?', (cid,))
            db.execute('''INSERT INTO candidates(job_id,name,resume,phone,email,link,created)
                SELECT 2,name,resume,phone,email,link,created FROM candidates WHERE id=?''', (cid,))
            other = db.execute('SELECT last_insert_rowid()').fetchone()[0]
            db.execute('INSERT INTO candidate_card_keys VALUES(?,?,?)', (1, server.source_card(card)['key'],other))
        ambiguous = self.status(card)
        self.assertEqual(ambiguous['known'][0]['id'], cid)
        self.assertFalse(ambiguous['known'][0]['chat_entry_eligible'])

    def test_unique_legacy_match_can_fill_chat_entry_after_mapping_is_created(self):
        prose = '独立设计多相机工业检测设备，开发视觉定位算法和软件架构，负责现场部署、运行验证和客户技术交付。' * 3
        employer = '测试精密装备股份有限公司视觉系统研发技术中心'
        card = {'name':'张**', 'signature':f'张** 8年 本科 {prose} 期望温州 {employer}'}
        resume = f'张**\n个人优势\n{prose}\n工作经历\n{employer}\n负责实施。\n教育经历\n测试大学。'
        cid, _ = server.save_boss_candidate(1, '张**', resume, '')
        status = self.status(card)
        self.assertEqual(status['known'][0]['id'], cid)
        self.assertTrue(status['known'][0]['chat_entry_eligible'])
        self.assertEqual(self.save(cid, card)[0], 200)

    def test_chat_entry_protects_otherwise_unreachable_candidate(self):
        cid, card = self.candidate()
        self.assertEqual(self.save(cid, card)[0], 200)
        result = self.post('/api/extension/rollback-unreachable', {'id':cid, 'source_card':card})
        self.assertEqual(result, (200, {'ok':True, 'deleted':False, 'reason':'contact_available'}))
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT deleted FROM candidates WHERE id=?', (cid,)).fetchone()[0], 0)

    def test_session_and_origin_checks_still_protect_new_route(self):
        cid, card = self.candidate()
        data = {'id':cid, 'source_card':card, 'boss_chat_uid':'123'}
        for headers in [{'X-App-Token':'invalid'}, {'Origin':'https://example.invalid'}]:
            with self.subTest(headers=headers):
                self.assertEqual(self.post('/api/extension/chat-entry', data, headers)[0], 403)
        self.assertEqual(self.source(cid)['boss_chat_uid'], '')


class BossChatEntryMigrationTests(unittest.TestCase):
    def test_old_source_schema_migrates_without_losing_data_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'old.sqlite3'
            with closing(sqlite3.connect(database)) as db:
                db.executescript('''
                    CREATE TABLE jobs(id INTEGER PRIMARY KEY,title TEXT NOT NULL,city TEXT NOT NULL,
                        jd TEXT NOT NULL,criteria TEXT NOT NULL,created TEXT NOT NULL);
                    CREATE TABLE candidates(id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES jobs(id),
                        name TEXT NOT NULL,resume TEXT NOT NULL,phone TEXT NOT NULL,email TEXT NOT NULL,link TEXT NOT NULL,
                        review TEXT NOT NULL DEFAULT '未复核',note TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,
                        UNIQUE(job_id,name,resume));
                    CREATE TABLE candidate_sources(candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id),
                        capture TEXT,share_image BLOB,share_status TEXT NOT NULL DEFAULT '未获取',
                        qr_url TEXT NOT NULL DEFAULT '',qr_status TEXT NOT NULL DEFAULT 'not_checked',
                        origin TEXT NOT NULL DEFAULT '');
                    INSERT INTO jobs VALUES(1,'合成岗位','','合成JD','','now');
                    INSERT INTO candidates(id,job_id,name,resume,phone,email,link,created)
                        VALUES(1,1,'合成人员','工作经历：合成迁移测试','','','','now');
                    INSERT INTO candidate_sources VALUES(1,'{}',x'89504E47','已获取','https://www.zhipin.com/test','manual','fixture');
                ''')
                original = db.execute('SELECT * FROM candidate_sources').fetchone()
            with patch.object(server, 'DB', database):
                server.init_db()
                with server.connect() as db:
                    column = next(row for row in db.execute('PRAGMA table_info(candidate_sources)') if row['name'] == 'boss_chat_uid')
                    self.assertEqual((column['type'],column['notnull'],column['dflt_value']), ('TEXT',1,"''"))
                    row = tuple(db.execute('SELECT * FROM candidate_sources').fetchone())
                    self.assertEqual(row, (*original, ''))
                    db.execute("UPDATE candidate_sources SET boss_chat_uid='123' WHERE candidate_id=1")
                server.init_db()
                with server.connect() as db:
                    row = tuple(db.execute('SELECT * FROM candidate_sources').fetchone())
                    self.assertEqual(row, (*original, '123'))


if __name__ == '__main__':
    unittest.main()
