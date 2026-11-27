"""Synthetic coverage for durable account/person greeting permission receipts."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import threading
import unittest
from unittest.mock import patch
from datetime import datetime, timezone, timedelta

import server
import test_collection_rollback as fixture


class GreetingApiTests(unittest.TestCase):
    stop_http = fixture.CollectionRollbackTests.stop_http
    post = fixture.CollectionRollbackTests.post

    def setUp(self):
        fixture.CollectionRollbackTests.setUp(self)
        active = patch.object(server,'model_urlopen',side_effect=AssertionError('No model/network calls'))
        self.network = active.start(); self.addCleanup(active.stop)
        self.addCleanup(self.network.assert_not_called)
        self.policy = server.collection_policy({'greet_enabled':True,'share_mode':'none'})
        self.account = '90071992547409930001'
        self.uid = '90071992547409930002'

    def request(self, data):
        import urllib.error
        try:
            return self.post('/api/extension/greeting',data)
        except urllib.error.HTTPError as error:
            return error.code,json.load(error)

    def candidate(self,suffix='one',score=80,uid=None):
        cid,card = fixture.CollectionRollbackTests.candidate(self,suffix)
        server.save_boss_chat_entry({'id':cid,'source_card':card,'boss_chat_uid':uid or self.uid})
        with server.connect() as db:
            db.execute('UPDATE candidate_screening SET score=?,favorite_pending=0 WHERE candidate_id=?',(score,cid))
        self.evaluation(cid,score)
        return cid,card

    def evaluation(self,cid,score=80):
        with server.connect() as db:
            c = dict(db.execute('SELECT * FROM candidates WHERE id=?',(cid,)).fetchone())
            fingerprint = server.evaluation_fingerprint(server.job_record(db,c['job_id']),c,server.profile_record(db,cid),
                datetime.now(timezone(timedelta(hours=8))).date())
            result = {'score':score,'scoring':{'version':server.SCORING_VERSION}}
            eid = db.execute('INSERT INTO evaluations(candidate_id,model,result,created) VALUES(?,?,?,?)',
                (cid,'synthetic',json.dumps(result),server.now())).lastrowid
            db.execute('INSERT INTO evaluation_inputs VALUES(?,?)',(eid,fingerprint))
            server.audit(db,'evaluate',str(cid))

    def payload(self,cid,card,**changes):
        return {'id':cid,'job_id':1,'source_card':card,'account_uid':self.account,'boss_chat_uid':self.uid,
                'collection_policy':self.policy,'stage':'begin',**changes}

    def status(self,card,**changes):
        return self.post('/api/extension/collection-status',{'job_id':1,'cards':[card],
            'collection_policy':self.policy,'greeting_account_uid':self.account,**changes})[1]

    def state(self):
        import urllib.request
        with urllib.request.urlopen(self.base+'/api/state',timeout=5) as response:
            return json.load(response)

    def test_first_begin_is_only_permission_and_token_is_never_read_back(self):
        cid,card = self.candidate()
        status,first = self.request(self.payload(cid,card))
        self.assertEqual(status,200)
        self.assertTrue(first['may_greet'])
        token = first['attempt_token']
        with server.connect() as db:
            row = db.execute('SELECT * FROM boss_greetings').fetchone()
            self.assertEqual(row['token_hash'],hashlib.sha256(token.encode()).hexdigest())
            self.assertNotIn(token,tuple(row))
            self.assertEqual((row['account_uid'],row['boss_chat_uid']),(self.account,self.uid))
        status,again = self.request(self.payload(cid,card))
        self.assertEqual(status,200)
        self.assertEqual((again['state'],again['may_greet']),('attempted',False))
        self.assertNotIn('attempt_token',again)
        state = self.state()
        self.assertEqual(state['greeting_version'],1)
        relation = state['candidates'][0]['source']['boss_greeting'][0]
        self.assertEqual(set(relation),{'account_uid','boss_chat_uid','state','updated'})
        self.assertEqual(relation['state'],'attempted')
        self.assertNotIn(token,json.dumps(state))
        self.assertNotIn(token,json.dumps(self.status(card)))

    def test_concurrent_begin_grants_exactly_one_permission(self):
        cid,card = self.candidate()
        barrier = threading.Barrier(2)
        def begin(_):
            barrier.wait(timeout=5)
            return self.request(self.payload(cid,card))
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(begin,range(2)))
        self.assertEqual([status for status,_ in results],[200,200])
        self.assertEqual(sum(body['may_greet'] for _,body in results),1)
        self.assertEqual(sum('attempt_token' in body for _,body in results),1)

    def test_complete_requires_original_identity_and_token_and_is_idempotent(self):
        cid,card = self.candidate()
        token = self.request(self.payload(cid,card))[1]['attempt_token']
        for changes in [{'attempt_token':'x'*43},{'account_uid':'77'},{'boss_chat_uid':'78'},
                        {'job_id':2},{'source_card':{**card,'signature':'另一张卡片'}}]:
            data = self.payload(cid,card,stage='complete',attempt_token=token)
            data.update(changes)
            self.assertEqual(self.request(data)[0],409)
        # A later policy/AI change cannot invalidate acknowledgement of a real attempt.
        with server.connect() as db:
            server.audit(db,'evaluate_pending',str(cid))
        data = self.payload(cid,card,stage='complete',attempt_token=token,
            collection_policy=server.collection_policy({'greet_enabled':False,'share_above':100}))
        for _ in range(2):
            status,body = self.request(data)
            self.assertEqual(status,200)
            self.assertEqual((body['state'],body['may_greet']),('confirmed',False))
            self.assertNotIn('attempt_token',body)
        self.assertFalse(self.request(self.payload(cid,card))[1]['may_greet'])

    def test_already_never_grants_permission_or_clears_an_uncertain_attempt(self):
        cid,card = self.candidate()
        status,body = self.request(self.payload(cid,card,stage='already'))
        self.assertEqual((status,body['state'],body['may_greet']),(200,'already',False))
        self.assertNotIn('attempt_token',body)
        self.assertEqual(self.request(self.payload(cid,card))[1]['state'],'already')
        other,other_card = self.candidate('other',uid='333')
        data = self.payload(other,other_card,boss_chat_uid='333')
        self.assertTrue(self.request(data)[1]['may_greet'])
        status,body = self.request({**data,'stage':'already'})
        self.assertEqual((status,body['state'],body['may_greet']),(200,'attempted',False))

    def test_reservation_survives_duplicates_deletion_and_database_reinitialization(self):
        cid,card = self.candidate()
        self.assertTrue(self.request(self.payload(cid,card))[1]['may_greet'])
        other,other_card = self.candidate('duplicate')
        self.assertFalse(self.request(self.payload(other,other_card))[1]['may_greet'])
        with server.connect() as db:
            db.execute('UPDATE candidates SET deleted=1,collection_mark_cleared=1 WHERE id=?',(cid,))
            db.execute('DELETE FROM candidate_card_keys WHERE candidate_id=?',(cid,))
        server.init_db()
        self.assertFalse(self.request(self.payload(other,other_card))[1]['may_greet'])
        self.assertTrue(self.request(self.payload(other,other_card,account_uid='88'))[1]['may_greet'])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM boss_greetings').fetchone()[0],2)

    def test_source_relations_match_current_uid_and_are_separate_per_account(self):
        cid,card = self.candidate()
        self.request(self.payload(cid,card,stage='already'))
        self.request(self.payload(cid,card,account_uid='88'))
        relation = self.state()['candidates'][0]['source']['boss_greeting']
        self.assertEqual({(r['account_uid'],r['state']) for r in relation},{(self.account,'already'),('88','attempted')})
        with server.connect() as db:
            db.execute("UPDATE candidate_sources SET boss_chat_uid='777' WHERE candidate_id=?",(cid,))
        self.assertEqual(self.state()['candidates'][0]['source']['boss_greeting'],[])

    def test_both_ids_are_strict_canonical_strings(self):
        cid,card = self.candidate()
        for field in ('account_uid','boss_chat_uid'):
            for value in (None,True,123,1.5,'','0','01','+1','1.0',' 1','1 ','１２','encrypted~','1'*21):
                with self.subTest(field=field,value=value):
                    self.assertEqual(self.request(self.payload(cid,card,**{field:value}))[0],400)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM boss_greetings').fetchone()[0],0)

    def test_current_policy_is_used_and_both_strict_thresholds_and_favorite_are_required(self):
        cid,card = self.candidate(score=80)
        policies = [server.collection_policy(),{**self.policy,'share_above':80},{**self.policy,'save_above':80},
                    {**self.policy,'share_above':81},{**self.policy,'greet_enabled':False}]
        for policy in policies:
            with self.subTest(policy=policy):
                self.assertEqual(self.request(self.payload(cid,card,collection_policy=policy))[0],409)
        with server.connect() as db:
            db.execute('UPDATE candidate_screening SET favorite_pending=1 WHERE candidate_id=?',(cid,))
        self.assertEqual(self.request(self.payload(cid,card))[0],409)
        self.assertEqual(self.status(card)['known'][0]['greeting_state'],'pending')
        self.post('/api/extension/favorite-complete',{'id':cid,'source_card':card})
        self.assertTrue(self.request(self.payload(cid,card,collection_policy={**self.policy,'share_above':79.99}))[1]['may_greet'])

    def test_failed_stale_obsolete_and_invalid_latest_scores_never_grant_permission(self):
        for kind in ('pending','input','obsolete','missing','nan','bool','out_of_range','latest_low'):
            with self.subTest(kind=kind):
                cid,card = self.candidate(kind,uid=str(1000+len(kind)))
                with server.connect() as db:
                    if kind=='pending': server.audit(db,'evaluate_pending',str(cid))
                    elif kind=='input': db.execute("UPDATE candidates SET resume=resume||'新增经历' WHERE id=?",(cid,))
                    elif kind=='missing': db.execute('DELETE FROM evaluation_inputs WHERE evaluation_id IN (SELECT id FROM evaluations WHERE candidate_id=?)',(cid,))
                    elif kind in ('obsolete','nan','bool','out_of_range'):
                        value = {'score':float('nan') if kind=='nan' else True if kind=='bool' else 101 if kind=='out_of_range' else 80,
                            'scoring':{'version':server.SCORING_VERSION},'scoring_obsolete':kind=='obsolete'}
                        db.execute('UPDATE evaluations SET result=? WHERE candidate_id=?',(json.dumps(value),cid))
                if kind=='latest_low': self.evaluation(cid,60)
                data = self.payload(cid,card,boss_chat_uid=str(1000+len(kind)))
                self.assertEqual(self.request(data)[0],409)

    def test_wrong_deleted_or_ambiguous_card_cannot_receive_permission(self):
        cid,card = self.candidate()
        for changes in ({'job_id':2},{'source_card':{**card,'name':'李**'}},{'source_card':{**card,'signature':'其他卡片'}}):
            self.assertEqual(self.request(self.payload(cid,card,**changes))[0],409)
        other,other_card = self.candidate('other',uid='333')
        with server.connect() as db:
            db.execute('INSERT INTO candidate_card_keys VALUES(?,?,?)',(1,server.source_card(card)['key'],other))
        self.assertEqual(self.request(self.payload(cid,card))[0],409)
        with server.connect() as db:
            db.execute('UPDATE candidates SET deleted=1 WHERE id=?',(other,))
        self.assertEqual(self.request(self.payload(other,other_card,boss_chat_uid='333'))[0],409)

    def test_collection_status_blocks_pending_and_attempted_but_missing_account_never_authorizes(self):
        cid,card = self.candidate()
        pending = self.status(card)
        self.assertEqual(pending['completed'],[])
        self.assertEqual((pending['known'][0]['score'],pending['known'][0]['ai_pending']), (80,False))
        self.assertEqual((pending['known'][0]['greeting_state'],pending['known'][0]['greeting_eligible']),('pending',True))
        missing = self.status(card,greeting_account_uid=None)
        self.assertEqual(missing['completed'],[card['signature']])
        self.assertEqual((missing['known'][0]['greeting_state'],missing['known'][0]['greeting_eligible']),('',False))
        first = self.request(self.payload(cid,card))[1]
        self.assertEqual(self.status(card)['completed'],[])
        self.assertEqual(self.status(card)['known'][0]['greeting_state'],'attempted')
        self.request(self.payload(cid,card,stage='complete',attempt_token=first['attempt_token']))
        done = self.status(card)
        self.assertEqual(done['completed'],[card['signature']])
        self.assertEqual(done['known'][0]['greeting_state'],'confirmed')

    def test_operations_leave_resume_evaluation_favorite_and_share_records_unchanged(self):
        cid,card = self.candidate()
        def snapshot():
            with server.connect() as db:
                return {table:[tuple(row) for row in db.execute('SELECT * FROM '+table)] for table in
                    ('candidates','candidate_screening','candidate_sources','candidate_profiles','candidate_card_keys',
                     'evaluations','evaluation_inputs','candidate_colleague_shares')}
        before = snapshot()
        token = self.request(self.payload(cid,card))[1]['attempt_token']
        self.request(self.payload(cid,card,stage='complete',attempt_token=token))
        self.assertEqual(snapshot(),before)


if __name__ == '__main__':
    unittest.main()
