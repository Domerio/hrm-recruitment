"""Concurrent HTTP scheduling against a temporary DB and synthetic model only."""
import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import server
import test_direct_evaluation as direct_tests


class AIQueueAPITests(unittest.TestCase):
    setUp = direct_tests.DirectEvaluationTests.setUp
    post = direct_tests.DirectEvaluationTests.post
    stop_http = direct_tests.DirectEvaluationTests.stop_http
    answer = direct_tests.DirectEvaluationTests.answer

    def candidate(self, number=1):
        text = self.resume.replace('合成人员', f'合成人员{number}')
        return server.save_boss_candidate(1, f'合成人员{number}', text, '')[0]

    def get(self, path, token=None):
        request = urllib.request.Request(self.base+path,
            headers={'X-App-Token':server.TOKEN if token is None else token})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def submit(self, cid, **extra):
        status, body = self.post('/api/ai/tasks', {'action':'evaluate','data':{'id':cid,**extra}})
        self.assertEqual(status,202,body)
        return body['task']

    def finish(self, task):
        deadline = time.monotonic()+5
        while time.monotonic()<deadline:
            status, body = self.get('/api/ai/tasks/'+task['id'])
            self.assertEqual(status,200,body)
            if body['task']['state'] not in ('queued','running'):
                return body['task']
            time.sleep(.01)
        self.fail('Synthetic task did not finish')

    def blocking_model(self):
        release, full = threading.Event(), threading.Event()
        lock, calls = threading.Lock(), []
        def complete(*args, **kwargs):
            with lock:
                calls.append(1)
                if len(calls)>=3:
                    full.set()
            if not release.wait(5):
                raise RuntimeError('Synthetic release missing')
            return self.answer()
        self.addCleanup(release.set)
        return release,full,calls,complete

    def test_three_model_calls_run_and_remaining_tasks_wait_without_409(self):
        ids=[self.candidate(i) for i in range(5)]
        release, full, calls, complete = self.blocking_model()
        with patch.object(server.CompatibleModel,'complete',side_effect=complete):
            tasks=[self.submit(cid) for cid in ids]
            try:
                self.assertTrue(full.wait(3))
                status, body=self.get('/api/ai/tasks')
                self.assertEqual(status,200)
                self.assertEqual((body['settings']['running'],body['settings']['queued']),(3,2))
                self.assertEqual(len(calls),3)
                self.assertEqual(self.post('/api/ai/runtime',{'max_concurrency':2})[0],409)
                self.assertEqual(self.post('/api/candidates/delete',{'ids':[ids[0]]})[0],409)
                self.assertNotIn('resume',json.dumps(body))
                self.assertNotIn('subscription_id',json.dumps(body))
            finally:
                release.set()
            self.assertTrue(all(self.finish(task)['status']==200 for task in tasks))
        self.assertEqual(len(calls),5)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0],5)

    def test_equivalent_evaluations_share_task_even_with_ignored_fields_or_review_changes(self):
        cid=self.candidate()
        release, _, calls, complete=self.blocking_model()
        with patch.object(server.CompatibleModel,'complete',side_effect=complete):
            first=self.submit(cid)
            try:
                deadline=time.monotonic()+3
                while not calls and time.monotonic()<deadline: time.sleep(.01)
                self.assertTrue(calls)
                status,_=self.post('/api/review',{'id':cid,'review':'待补充信息','note':'合成复核备注'})
                self.assertEqual(status,200)
                second=self.submit(cid,ignored_extra=True)
                self.assertEqual(first['id'],second['id'])
                self.assertTrue(second['reused'])
                self.assertNotEqual(first['subscription_id'],second['subscription_id'])
            finally:
                release.set()
            self.assertEqual(self.finish(first)['status'],200)
            self.assertEqual(self.finish(second)['status'],200)
        self.assertEqual(len(calls),1)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0],1)

    def test_queued_changed_resume_is_rejected_before_paid_inference(self):
        ids=[self.candidate(i) for i in range(4)]
        release,full,calls,complete=self.blocking_model()
        with patch.object(server.CompatibleModel,'complete',side_effect=complete):
            tasks=[self.submit(cid) for cid in ids]
            try:
                self.assertTrue(full.wait(3))
                with server.connect() as db:
                    db.execute('UPDATE candidates SET resume=resume||? WHERE id=?',('\n合成资料更新',ids[-1]))
            finally:
                release.set()
            last=self.finish(tasks[-1])
            self.assertEqual((last['state'],last['status']),('failed',409))
            self.assertEqual(last['result']['code'],'evaluation_input_changed')
            for task in tasks[:-1]: self.assertEqual(self.finish(task)['status'],200)
        self.assertEqual(len(calls),3)

    def test_shared_waiting_task_needs_all_subscriptions_cancelled(self):
        ids=[self.candidate(i) for i in range(4)]
        release,full,calls,complete=self.blocking_model()
        with patch.object(server.CompatibleModel,'complete',side_effect=complete):
            tasks=[self.submit(cid) for cid in ids]
            try:
                self.assertTrue(full.wait(3))
                shared=self.submit(ids[-1])
                path='/api/ai/tasks/'+shared['id']+'/cancel'
                self.assertEqual(self.post(path,{'subscription_id':'someone-elses-token'})[0],403)
                status,body=self.post(path,{'subscription_id':tasks[-1]['subscription_id']})
                self.assertEqual((status,body['task']['state']),(200,'queued'))
                status,body=self.post(path,{'subscription_id':shared['subscription_id']})
                self.assertEqual((status,body['task']['state']),(200,'cancelled'))
            finally:
                release.set()
            for task in tasks[:-1]: self.assertEqual(self.finish(task)['status'],200)
        self.assertEqual(len(calls),3)

    def test_runtime_settings_are_bounded_persisted_and_dont_touch_model_configuration(self):
        config=server.load_config(server.DB.parent/'ai-config.json')
        self.assertEqual(self.get('/api/ai/runtime')[1]['max_concurrency'],3)
        for value in (0,9,True,'3',2.5):
            self.assertEqual(self.post('/api/ai/runtime',{'max_concurrency':value})[0],400)
        status,body=self.post('/api/ai/runtime',{'max_concurrency':2})
        self.assertEqual((status,body['max_concurrency']),(200,2))
        self.assertEqual(json.loads((server.DB.parent/'ai-runtime.json').read_text())['max_concurrency'],2)
        self.assertEqual(server.ai_queue().max_concurrency,2)
        self.assertEqual(server.load_config(server.DB.parent/'ai-config.json'),config)

    def test_task_polling_requires_token_and_missing_tasks_do_not_reenqueue(self):
        self.assertEqual(self.get('/api/ai/tasks',token='wrong')[0],403)
        self.assertEqual(self.get('/api/ai/tasks/'+'a'*32)[0],404)
        self.assertEqual(self.post('/api/ai/tasks',{'action':'unsupported','data':{}})[0],400)
        self.assertEqual(self.get('/api/ai/tasks')[1]['tasks'],[])


if __name__=='__main__':
    unittest.main()
