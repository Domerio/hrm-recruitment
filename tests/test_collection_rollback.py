"""Rollback only an unreachable, unmodified BOSS candidate in an isolated database."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch

import server


class CollectionRollbackTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        database = patch.object(server, 'DB', Path(directory.name) / 'rollback.sqlite3')
        database.start(); self.addCleanup(database.stop)
        logging = patch.object(server.Handler, 'log_message', return_value=None)
        logging.start(); self.addCleanup(logging.stop)
        server.init_db()
        with server.connect() as db:
            db.execute('INSERT INTO jobs(title,city,jd,criteria,created) VALUES(?,?,?,?,?)',
                       ('合成岗位', '', '合成工作内容', '', server.now()))
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_http)
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def stop_http(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join(timeout=5)

    def post(self, path, data):
        request = urllib.request.Request(self.base + path, data=json.dumps(data).encode(),
                                         headers={'X-App-Token': server.TOKEN, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.load(response)

    def candidate(self, suffix='one'):
        card = {'name': '张**', 'signature': f'张** 视觉工程师 合成卡片 {suffix}'}
        resume = f'张**\n工作经历\n负责视觉工程研发和产线调试，完成合成项目 {suffix} 的方案设计与交付。'
        capture = server.normalize_capture({'status': 'visible_complete', 'sections': ['工作经历'], 'warnings': []})
        cid, created = server.save_boss_candidate(1, card['name'], resume, '', capture=capture,
                                                  card=server.source_card(card))
        self.assertTrue(created)
        with server.connect() as db:
            db.execute('INSERT OR IGNORE INTO candidate_profiles(candidate_id) VALUES(?)', (cid,))
            db.execute('''INSERT INTO candidate_screening(candidate_id,input_hash,score,favorite_pending)
                          VALUES(?,?,?,1)''', (cid, f'fingerprint-{suffix}', 66))
        return cid, card

    def rollback(self, cid, card):
        return self.post('/api/extension/rollback-unreachable', {'id': cid, 'source_card': card})

    def test_pending_boss_candidate_without_contact_is_soft_deleted_and_unmarked(self):
        cid, card = self.candidate()
        with server.connect() as db:
            evaluation = db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                                    (cid, 'synthetic', '{}', server.now())).lastrowid
            db.execute('INSERT INTO evaluation_inputs(evaluation_id,fingerprint) VALUES(?,?)',
                       (evaluation, 'fingerprint-one'))
            db.execute('''INSERT INTO collection_skip_marks(job_id,card_key,input_hash,score,created)
                          VALUES(?,?,?,?,?)''', (1, server.source_card(card)['key'], 'old', 42, server.now()))
        self.assertEqual(self.rollback(cid, card), (200, {'ok': True, 'deleted': True}))
        with server.connect() as db:
            self.assertEqual(tuple(db.execute('SELECT deleted,collection_mark_cleared FROM candidates WHERE id=?',
                                              (cid,)).fetchone()), (1, 1))
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_card_keys WHERE candidate_id=?',
                                        (cid,)).fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM collection_skip_marks WHERE job_id=1').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations WHERE candidate_id=?', (cid,)).fetchone()[0], 1)
        self.assertEqual(self.rollback(cid, card),
                         (200, {'ok': True, 'deleted': False, 'reason': 'already_deleted'}))

    def test_wrong_card_and_multiple_card_bindings_cannot_delete(self):
        cid, card = self.candidate()
        wrong = {**card, 'signature': '另一张卡片'}
        self.assertEqual(self.rollback(cid, wrong)[1]['reason'], 'source_mismatch')
        with server.connect() as db:
            db.execute('INSERT INTO candidate_card_keys(job_id,card_key,candidate_id) VALUES(?,?,?)',
                       (1, server.source_card(wrong)['key'], cid))
        self.assertEqual(self.rollback(cid, card)[1]['reason'], 'source_mismatch')
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT deleted FROM candidates WHERE id=?', (cid,)).fetchone()[0], 0)

    def test_confirmed_favorite_and_available_contact_paths_are_protected(self):
        changes = [
            ('favorite', 'UPDATE candidate_screening SET favorite_pending=0 WHERE candidate_id=?', 'favorite_confirmed_or_missing'),
            ('phone', "UPDATE candidates SET phone='13800138000' WHERE id=?", 'contact_available'),
            ('email', "UPDATE candidates SET email='test@example.invalid' WHERE id=?", 'contact_available'),
            ('link', "UPDATE candidates SET link='https://www.zhipin.com/test' WHERE id=?", 'contact_available'),
            ('wechat', "UPDATE candidate_profiles SET wechat='wechat-id' WHERE candidate_id=?", 'contact_available'),
            ('qr', "UPDATE candidate_sources SET qr_url='https://www.zhipin.com/qr' WHERE candidate_id=?", 'contact_available'),
            ('share_image', "UPDATE candidate_sources SET share_image=x'89504E47' WHERE candidate_id=?", 'contact_available'),
        ]
        for suffix, sql, reason in changes:
            with self.subTest(suffix=suffix):
                cid, card = self.candidate(suffix)
                with server.connect() as db:
                    db.execute(sql, (cid,))
                self.assertEqual(self.rollback(cid, card)[1]['reason'], reason)
                with server.connect() as db:
                    self.assertEqual(db.execute('SELECT deleted FROM candidates WHERE id=?', (cid,)).fetchone()[0], 0)

    def test_direct_or_unproven_sources_and_manual_history_are_protected(self):
        cid, card = self.candidate('direct')
        with server.connect() as db:
            db.execute("UPDATE candidate_sources SET origin='direct_evaluation' WHERE candidate_id=?", (cid,))
        self.assertEqual(self.rollback(cid, card)[1]['reason'], 'not_boss_capture')
        changes = [
            ('review', "UPDATE candidates SET review='通过复核' WHERE id=?"),
            ('note', "UPDATE candidates SET note='人工备注' WHERE id=?"),
            ('edited', 'UPDATE candidate_profiles SET resume_edited=1 WHERE candidate_id=?'),
            ('audit', None),
        ]
        for suffix, sql in changes:
            with self.subTest(suffix=suffix):
                cid, card = self.candidate(suffix)
                with server.connect() as db:
                    if sql:
                        db.execute(sql, (cid,))
                    else:
                        server.audit(db, 'update_candidate', str(cid))
                self.assertEqual(self.rollback(cid, card)[1]['reason'], 'manual_history')

    def test_unmatched_evaluation_history_is_protected(self):
        cid, card = self.candidate()
        with server.connect() as db:
            db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                       (cid, 'synthetic', '{}', server.now()))
        self.assertEqual(self.rollback(cid, card)[1]['reason'], 'manual_history')
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT deleted FROM candidates WHERE id=?', (cid,)).fetchone()[0], 0)

    def test_state_advertises_rollback_capability(self):
        with urllib.request.urlopen(self.base + '/api/state', timeout=5) as response:
            state = json.load(response)
        self.assertEqual(state['collection_rollback_version'], 1)
        self.assertEqual(state['version'], server.APP_VERSION)


if __name__ == '__main__':
    unittest.main()
