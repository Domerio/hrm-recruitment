"""Chat source import and evaluation, using an isolated DB and synthetic model."""
import base64
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import server
from chat_resumes import ensure_chat_resume_tables


class ChatResumeTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        for name,value in [('DB',Path(folder.name)/'chat.sqlite'),('EXTENSION_FILE',Path(folder.name)/'extension.json')]:
            changer = patch.object(server,name,value)
            changer.start(); self.addCleanup(changer.stop)
        changer = patch.dict(os.environ,{'AI_MODEL':'synthetic-model','AI_BASE_URL':'https://example.invalid/v1',
            'AI_API_KEY':'synthetic-secret','DEEPSEEK_API_KEY':'synthetic-secret'})
        changer.start(); self.addCleanup(changer.stop)
        changer = patch.object(server,'model_urlopen',side_effect=AssertionError('No real model request'))
        self.network = changer.start(); self.addCleanup(changer.stop)
        changer = patch.object(server.Handler,'log_message',return_value=None)
        changer.start(); self.addCleanup(changer.stop)
        server.init_db()
        self.http = server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        self.thread = threading.Thread(target=lambda:self.http.serve_forever(poll_interval=.01),daemon=True)
        self.thread.start(); self.addCleanup(self.stop)
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        for number in (1,2):
            self.post('/api/jobs',{'title':f'Synthetic {number}','city':'','jd':'视觉软件研发','criteria':'熟悉 Python'},201)
        self.name = '张**'
        self.text = '张**\n30岁 本科 5年 离职随时到岗\n工作经历\n合成设备公司 Python 软件研发，负责图像检测算法、软件开发与系统验证。\n教育经历\n合成大学 本科 计算机。'
        self.capture = {'status':'visible_complete','sections':['工作经历','教育经历'],'warnings':[]}
        self.conversation_id = self.snapshot()

    def stop(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join(timeout=5)
        self.network.assert_not_called()

    def post(self,path,data,status=200,token=None,origin=None):
        headers = {'Content-Type':'application/json','X-App-Token':server.TOKEN if token is None else token}
        if origin: headers['Origin'] = origin
        request = urllib.request.Request(self.base+path,data=json.dumps(data).encode(),headers=headers)
        try:
            with urllib.request.urlopen(request,timeout=10) as response:
                actual,body = response.status,json.load(response)
        except urllib.error.HTTPError as error:
            actual,body = error.code,json.load(error)
        self.assertEqual(actual,status,body)
        return body

    def snapshot(self,friend='friend-one',geek='geek-one',job_id=1,name='张**'):
        payload = {'job_id':job_id,'account_id':'recruiter-one','account_name':'合成招聘员',
            'conversations':[{'friend_id':friend,'candidate_name':name,'platform_geek_id':geek}],
            'messages':[{'friend_id':friend,'message_id':'attachment-one','direction':'incoming','kind':'attachment',
                'attachment_name':'resume.txt','attachment_status':'received'}]}
        self.post('/api/communications/import',payload)
        rows = self.post('/api/communications/list',{'job_id':job_id})['conversations']
        return next(row['id'] for row in rows if row['friend_id']==friend)

    def online(self,**extra):
        return {'conversation_id':self.conversation_id,'source_kind':'online',
            'candidate':{'name':self.name,'resume':self.text,'capture':self.capture},**extra}

    def upload(self,conversation_id=None,text=None):
        cid = conversation_id or self.conversation_id
        detail = self.post('/api/communications/detail',{'id':cid})
        mid = detail['messages'][0]['id']
        attachment = self.post('/api/communications/attachment',{'conversation_id':cid,'message_id':mid,
            'name':'resume.txt','content':base64.b64encode((text or self.text).encode()).decode()})['attachment']
        return attachment['id']

    def sources(self):
        return self.post('/api/communications/detail',{'id':self.conversation_id})['conversation']['resumes']

    def counts(self):
        with server.connect() as db:
            return {name:db.execute('SELECT COUNT(*) FROM '+name).fetchone()[0]
                for name in ('communication_resumes','candidates','evaluations','communication_attachments')}

    def test_online_save_deduplicates_and_creates_a_bound_candidate_without_model_or_external_actions(self):
        with patch.object(server,'CompatibleModel') as model:
            result = self.post('/api/communications/resume',self.online(evaluate=False))
            duplicate = self.post('/api/communications/resume',self.online(evaluate=False))
            model.assert_not_called()
        self.assertFalse(result['duplicate']); self.assertTrue(duplicate['duplicate'])
        self.assertEqual(result['candidate_id'],duplicate['candidate_id'])
        source = self.sources()[0]
        self.assertEqual(source['id'],result['resume']['id'])
        self.assertEqual(source['conversation_id'],self.conversation_id)
        self.assertEqual({key:source['capture'][key] for key in self.capture},self.capture)
        self.assertTrue(source['capture']['captured_at'])
        self.assertEqual(source['resume'],self.text)
        self.assertEqual(source['evaluation_status'],'not_requested')
        self.assertTrue(source['ai_pending'])
        self.assertEqual(self.counts(),{'communication_resumes':1,'candidates':1,'evaluations':0,'communication_attachments':0})
        with server.connect() as db:
            candidate = db.execute('SELECT * FROM candidates').fetchone()
            self.assertEqual(candidate['resume'],self.text); self.assertEqual(candidate['link'],'')
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_colleague_shares').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT count(*) FROM candidate_screening').fetchone()[0],0)
        archive = self.post('/api/communications/candidate',{'candidate_id':result['candidate_id']})
        self.assertEqual(archive['resumes'][0]['id'],source['id'])
        second = self.snapshot(friend='friend-two')
        self.assertEqual(self.post('/api/communications/detail',{'id':second})['conversation']['candidate_id'],result['candidate_id'])

    def test_explicit_evaluation_after_save_uses_pipeline_then_reuses_the_source_result(self):
        saved = self.post('/api/communications/resume',self.online())
        request = {'conversation_id':self.conversation_id,'resume_id':saved['resume']['id'],'evaluate':True}
        with patch.object(server,'complete_evaluation',return_value={'score':82}) as evaluate:
            result = self.post('/api/communications/resume',request)
            again = self.post('/api/communications/resume',request)
            self.assertEqual(evaluate.call_count,1)
            self.assertEqual(evaluate.call_args.args[2],self.text)
        self.assertEqual(result['resume']['evaluation']['score'],82)
        self.assertTrue(result['resume']['evaluation_saved_to_candidate'])
        self.assertFalse(again['resume']['ai_pending'])
        self.assertEqual(self.counts()['evaluations'],1)

    def test_new_version_preserves_primary_resume_and_stores_its_own_evaluation(self):
        first = self.post('/api/communications/resume',self.online())
        changed = self.online(candidate={'name':self.name,'resume':self.text+'\n项目经历\n新增视觉定位项目。','capture':self.capture},evaluate=True)
        with patch.object(server,'complete_evaluation',return_value={'score':75}):
            result = self.post('/api/communications/resume',changed)
        self.assertEqual(result['candidate_id'],first['candidate_id'])
        self.assertEqual(len(self.sources()),2)
        self.assertFalse(result['resume']['evaluation_saved_to_candidate'])
        self.assertTrue(result['resume']['evaluation_note'])
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT resume FROM candidates').fetchone()[0],self.text)
        self.assertEqual(self.counts()['evaluations'],0)

    def test_manual_profile_change_during_model_call_leaves_primary_history_untouched(self):
        saved = self.post('/api/communications/resume',self.online())
        def model(*args,**kwargs):
            with server.connect() as db:
                server.bump_profile(db,saved['candidate_id'],{'education':'人工维护硕士'})
            return {'score':90}
        with patch.object(server,'complete_evaluation',side_effect=model):
            result = self.post('/api/communications/resume',{'conversation_id':self.conversation_id,
                'resume_id':saved['resume']['id'],'evaluate':True})
        self.assertEqual(result['resume']['evaluation']['score'],90)
        self.assertFalse(result['resume']['evaluation_saved_to_candidate'])
        self.assertEqual(self.counts()['evaluations'],0)

    def test_model_failure_and_missing_configuration_keep_original_and_allow_retry(self):
        with patch.object(server,'complete_evaluation',side_effect=RuntimeError('Synthetic model unavailable')):
            failed = self.post('/api/communications/resume',self.online(evaluate=True))
        self.assertEqual(failed['resume']['resume'],self.text)
        self.assertTrue(failed['resume']['ai_pending']); self.assertTrue(failed['resume']['error'])
        with patch.object(server,'public_config',return_value={'configured':False}):
            missing = self.post('/api/communications/resume',self.online(evaluate=True))
        self.assertIn('配置',missing['resume']['error'])
        with patch.object(server,'complete_evaluation',return_value={'score':80}):
            retried = self.post('/api/communications/resume',{'conversation_id':self.conversation_id,
                'resume_id':failed['resume']['id'],'evaluate':True})
        self.assertEqual(retried['resume']['evaluation']['score'],80)
        self.assertEqual(self.counts()['communication_resumes'],1)

    def test_missing_platform_identity_and_same_name_conflicts_preserve_unbound_sources(self):
        no_id = self.snapshot(friend='legacy',geek='',name='李**')
        text = self.text.replace('张**','李**')
        request = self.online(conversation_id=no_id,candidate={'name':'李**','resume':text,'capture':self.capture})
        saved = self.post('/api/communications/resume',request)
        self.assertIsNone(saved['candidate_id']); self.assertTrue(saved['resume']['binding_warning'])
        first = self.post('/api/communications/resume',self.online())
        other = self.snapshot(friend='other-geek',geek='geek-different')
        conflict = self.post('/api/communications/resume',self.online(conversation_id=other))
        self.assertIsNone(conflict['candidate_id']); self.assertTrue(conflict['binding_warning'])
        self.assertEqual(self.counts()['candidates'],1)
        self.post('/api/communications/bind',{'conversation_id':other,'candidate_id':first['candidate_id']},400)

    def test_explicit_manual_binding_of_legacy_archive_can_keep_a_source_without_overwriting_resume(self):
        legacy = self.snapshot(friend='legacy',geek='')
        with server.connect() as db:
            cid = db.execute('''INSERT INTO candidates(job_id,name,resume,phone,email,link,created)
                VALUES(1,?,'人工档案原文','','','',?)''',(self.name,server.now())).lastrowid
        self.post('/api/communications/bind',{'conversation_id':legacy,'candidate_id':cid})
        saved = self.post('/api/communications/resume',self.online(conversation_id=legacy))
        self.assertEqual(saved['candidate_id'],cid)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT resume FROM candidates WHERE id=?',(cid,)).fetchone()[0],'人工档案原文')

    def test_attachment_source_keeps_existing_file_and_can_retry_after_platform_expiry(self):
        aid = self.upload()
        request = {'conversation_id':self.conversation_id,'source_kind':'attachment','attachment_id':aid,'evaluate':False}
        saved = self.post('/api/communications/resume',request)
        self.assertEqual(saved['resume']['attachment_id'],aid)
        self.assertEqual(saved['resume']['source_key'],str(aid))
        self.assertEqual(self.counts()['communication_attachments'],1)
        with server.connect() as db:
            db.execute("UPDATE communication_messages SET attachment_status='expired'")
        with patch.object(server,'complete_evaluation',return_value={'score':88}):
            retried = self.post('/api/communications/resume',{'conversation_id':self.conversation_id,
                'resume_id':saved['resume']['id'],'evaluate':True})
        self.assertEqual(retried['resume']['evaluation']['score'],88)
        self.post('/api/communications/resume',request,400)

    def test_attachment_and_resume_ids_cannot_cross_conversations_or_read_outgoing_files(self):
        aid = self.upload()
        saved = self.post('/api/communications/resume',self.online())
        other = self.snapshot(friend='other',geek='other-geek',job_id=2)
        self.post('/api/communications/resume',{'conversation_id':other,'source_kind':'attachment','attachment_id':aid},400)
        self.post('/api/communications/resume',{'conversation_id':other,'resume_id':saved['resume']['id'],'evaluate':True},400)
        with server.connect() as db:
            db.execute("UPDATE communication_messages SET direction='outgoing'")
        self.post('/api/communications/resume',{'conversation_id':self.conversation_id,'source_kind':'attachment','attachment_id':aid},400)

    def test_invalid_online_identity_completeness_and_options_never_write_a_source(self):
        for candidate in ({'name':'李**','resume':self.text,'capture':self.capture},
                          {'name':self.name,'resume':self.text.replace('张**','李**'),'capture':self.capture},
                          {'name':self.name,'resume':self.text+'\n查看全部','capture':self.capture},
                          {'name':self.name,'resume':self.text,'capture':{**self.capture,'warnings':['missing']}},
                          {'name':self.name,'resume':self.text,'capture':None}):
            self.post('/api/communications/resume',self.online(candidate=candidate),400)
        self.post('/api/communications/resume',self.online(evaluate='yes'),400)
        self.post('/api/communications/resume',self.online(),403,token='wrong')
        self.assertEqual(self.counts()['communication_resumes'],0)
        self.assertEqual(self.counts()['candidates'],0)

    def test_candidate_archive_hides_sources_after_unbinding_job_change_or_deletion(self):
        saved = self.post('/api/communications/resume',self.online())
        cid = saved['candidate_id']
        with server.connect() as db:
            db.execute('UPDATE communication_conversations SET candidate_id=NULL WHERE id=?',(self.conversation_id,))
        self.assertEqual(self.post('/api/communications/candidate',{'candidate_id':cid})['resumes'],[])
        with server.connect() as db:
            db.execute('UPDATE communication_conversations SET candidate_id=? WHERE id=?',(cid,self.conversation_id))
            db.execute('UPDATE candidates SET job_id=2 WHERE id=?',(cid,))
        self.assertEqual(self.post('/api/communications/candidate',{'candidate_id':cid})['resumes'],[])
        with server.connect() as db:
            db.execute('UPDATE candidates SET deleted=1 WHERE id=?',(cid,))
        self.post('/api/communications/candidate',{'candidate_id':cid},400)

    def test_concurrent_duplicate_request_calls_model_once_and_preserves_the_completed_result(self):
        entered,release = threading.Event(),threading.Event()
        def model(*args,**kwargs):
            entered.set()
            if not release.wait(timeout=5): raise RuntimeError('Synthetic wait timed out')
            return {'score':83}
        results=[]
        with patch.object(server,'complete_evaluation',side_effect=model) as evaluate:
            task = threading.Thread(target=lambda:results.append(self.post('/api/communications/resume',self.online(evaluate=True))))
            task.start()
            try:
                self.assertTrue(entered.wait(timeout=5))
                # A second client using the already saved source shares the
                # first task instead of receiving a transient busy failure.
                resume_id = self.sources()[0]['id']
                second = threading.Thread(target=lambda:results.append(self.post('/api/communications/resume',
                    {'conversation_id':self.conversation_id,'resume_id':resume_id,'evaluate':True})))
                second.start()
                deadline = time.monotonic()+3
                while time.monotonic()<deadline:
                    queue = server.ai_queue()
                    with queue._condition:
                        subscribers = [len(item['subscriptions']) for item in queue._tasks.values()]
                    if subscribers == [2]: break
                    time.sleep(.01)
                self.assertEqual(subscribers,[2])
                self.assertEqual(results,[])
            finally:
                release.set(); task.join(timeout=5)
                if 'second' in locals(): second.join(timeout=5)
            self.assertEqual(evaluate.call_count,1)
        self.assertEqual(len(results),2)
        self.assertEqual(sorted(result['duplicate'] for result in results),[False,True])
        self.assertTrue(all(result['resume']['evaluation']['score']==83 for result in results))
        self.assertEqual(self.sources()[0]['evaluation_status'],'complete')
        self.assertEqual(self.counts()['evaluations'],1)


class ChatResumeMigrationTests(unittest.TestCase):
    def test_failed_index_creation_rolls_back_table_and_can_retry_inside_outer_transaction(self):
        class FailingConnection(sqlite3.Connection):
            fail = True
            def execute(self,sql,params=()):
                if self.fail and sql.lstrip().startswith('CREATE INDEX'):
                    raise sqlite3.OperationalError('Synthetic index failure')
                return super().execute(sql,params)
        db = sqlite3.connect(':memory:',factory=FailingConnection)
        self.addCleanup(db.close)
        db.execute('CREATE TABLE preserved(id INTEGER)')
        db.execute('INSERT INTO preserved VALUES(1)')
        with self.assertRaisesRegex(sqlite3.OperationalError,'Synthetic index failure'):
            ensure_chat_resume_tables(db)
        self.assertTrue(db.in_transaction)
        self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='communication_resumes'").fetchone())
        self.assertEqual(db.execute('SELECT id FROM preserved').fetchone()[0],1)
        db.fail=False
        ensure_chat_resume_tables(db)
        ensure_chat_resume_tables(db)
        self.assertTrue(db.in_transaction)
