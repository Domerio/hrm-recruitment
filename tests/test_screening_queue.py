"""Screening single-flight and atomic archival using synthetic sources/models only."""
import copy
import html
import json
import threading
import unittest
from unittest.mock import patch

import server
import test_extension_screening as screening_tests


class ScreeningQueueTests(unittest.TestCase):
    setUp = screening_tests.ExtensionScreeningTests.setUp
    stop_http = screening_tests.ExtensionScreeningTests.stop_http
    post = screening_tests.ExtensionScreeningTests.post
    answer = screening_tests.ExtensionScreeningTests.answer
    counts = screening_tests.ExtensionScreeningTests.counts

    def submit(self, data):
        status, body = self.post('/api/ai/tasks', {'action':'screen', 'data':data})
        self.assertEqual(status, 202, body)
        return body['task']

    def block_model(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def model(instruction, payload):
            started.set()
            if not release.wait(5):
                raise RuntimeError('Synthetic release missing')
            self.assertNotIn('captured_at', payload['capture'])
            return self.answer(payload)
        return started, release, model

    def test_capture_time_url_and_ignored_fields_share_task_without_dropping_archived_source(self):
        first = copy.deepcopy(self.data)
        first['candidate']['capture']['captured_at'] = '2026-11-20T01:00:00Z'
        first['candidate']['link'] = 'https://www.zhipin.com/web/geek/resume?encryptGeekId=synthetic'
        first['candidate']['resume_html'] = ''.join('<p>'+html.escape(line)+'</p>' for line in self.resume.splitlines())
        second = copy.deepcopy(first)
        second['candidate']['capture']['captured_at'] = '2026-11-20T01:05:00Z'
        second['candidate']['link'] += '&source=another-view'
        second['ignored_extra'] = 'not an inference input'
        second['collection_policy'] = {**server.collection_policy(), 'save_above':55.0, 'share_above':75.0}
        started, release, model = self.block_model()
        with patch.object(server.CompatibleModel, 'complete', side_effect=model) as inference:
            a = self.submit(first)
            try:
                self.assertTrue(started.wait(2))
                b = self.submit(second)
                self.assertEqual(a['id'], b['id'])
                self.assertTrue(b['reused'])
                self.assertNotEqual(a['subscription_id'], b['subscription_id'])
            finally:
                release.set()
            status, result = server.ai_queue().wait(a['id'], 3)
            self.assertEqual(status, 200, result)
            self.assertTrue(result['saved'])
            self.assertTrue(result['favorite_pending'])
            inference.assert_called_once()
        self.assertEqual(self.counts()['evaluations'], 1)
        with server.connect() as db:
            candidate = db.execute('SELECT link FROM candidates WHERE id=?',(result['id'],)).fetchone()
            source = db.execute('SELECT capture FROM candidate_sources WHERE candidate_id=?',(result['id'],)).fetchone()
            markup = db.execute('SELECT html FROM candidate_resume_formats WHERE candidate_id=?',(result['id'],)).fetchone()
            self.assertEqual(candidate['link'], first['candidate']['link'])
            self.assertTrue(json.loads(source['capture'])['captured_at'])
            self.assertIn('合成设备公司', markup['html'])

    def test_invalid_duplicate_source_is_validated_before_joining_existing_task(self):
        started, release, model = self.block_model()
        with patch.object(server.CompatibleModel, 'complete', side_effect=model) as inference:
            a = self.submit(self.data)
            try:
                self.assertTrue(started.wait(2))
                for change in ({'capture':{'status':'needs_review','sections':[],'warnings':[]}},
                               {'source_card':{'name':'another person','signature':'different'}},
                               {'link':'https://unrelated.invalid/resume'}):
                    with self.subTest(change=change):
                        bad = copy.deepcopy(self.data)
                        bad['candidate'].update(change)
                        status, _ = self.post('/api/ai/tasks', {'action':'screen','data':bad})
                        self.assertEqual(status, 400)
                self.assertEqual(len(server.ai_queue().list()), 1)
            finally:
                release.set()
            self.assertEqual(server.ai_queue().wait(a['id'], 3)[0], 200)
            inference.assert_called_once()

    def test_concurrent_policy_variants_share_inference_and_commit_one_history_and_delivery_state(self):
        first, second = copy.deepcopy(self.data), copy.deepcopy(self.data)
        second['collection_policy'] = {**server.collection_policy(), 'share_mode':'none'}
        started, release, model = self.block_model()
        with patch.object(server.CompatibleModel, 'complete', side_effect=model) as inference:
            a = self.submit(first)
            try:
                self.assertTrue(started.wait(2))
                b = self.submit(second)
                self.assertNotEqual(a['id'], b['id'])  # distinct delivery choices are never merged as tasks
                flights = server._AI_INFERENCE_FLIGHTS
                with flights._condition:
                    self.assertTrue(flights._condition.wait_for(
                        lambda:any(flight['waiters'] == 1 for flight in flights._flights.values()), 2))
            finally:
                release.set()
            results = [server.ai_queue().wait(task['id'], 3) for task in (a,b)]
            self.assertEqual([status for status,_ in results], [200,200])
            inference.assert_called_once()
        bodies = [body for _,body in results]
        self.assertTrue(all(body['saved'] and body['favorite_pending'] for body in bodies))
        self.assertEqual(bodies[0]['id'], bodies[1]['id'])
        self.assertEqual(bodies[0]['collection_policy'], bodies[1]['collection_policy'])
        self.assertEqual(sum(body.get('cached') is True for body in bodies), 1)
        counts = self.counts()
        self.assertEqual((counts['candidates'],counts['evaluations'],counts['evaluation_inputs']), (1,1,1))
        with server.connect() as db:
            self.assertLessEqual(db.execute('SELECT count(*) FROM candidate_colleague_shares').fetchone()[0], 1)

    def test_changed_resume_card_or_policy_keeps_distinct_queued_tasks(self):
        queue = server.ai_queue()
        queue.configure(1)
        started, release = threading.Event(), threading.Event()
        def hold():
            started.set()
            if not release.wait(5):
                raise RuntimeError('Synthetic release missing')
            return 200, {}
        blocker = queue.submit('synthetic-blocker', hold)
        self.assertTrue(started.wait(2))
        tasks = []
        try:
            variants = [copy.deepcopy(self.data) for _ in range(4)]
            variants[1]['candidate']['resume'] += '\n补充负责设备通信模块开发。'
            variants[2]['candidate']['source_card']['signature'] += ' C++'
            variants[3]['collection_policy'] = {**server.collection_policy(), 'save_above':60}
            tasks = [self.submit(data) for data in variants]
            self.assertEqual(len({task['id'] for task in tasks}), 4)
            self.assertTrue(all(task['state'] == 'queued' for task in tasks))
            for task in tasks:
                self.assertEqual(queue.cancel(task['id'], task['subscription_id'])['state'], 'cancelled')
        finally:
            # Never execute model code during this identity/cancellation regression.
            for task in tasks:
                if queue.get(task['id'])['state'] == 'queued':
                    queue.cancel(task['id'], task['subscription_id'])
            release.set()
            queue.wait(blocker['id'],3)
        self.assertEqual(self.counts()['candidates'], 0)


if __name__ == '__main__':
    unittest.main()
