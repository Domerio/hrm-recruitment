import json
import unittest
from unittest.mock import patch

import test_ai_configuration as config_tests
from test_ai_configuration import BASE, SECRET, response
import ai_configuration as configuration
import server


class AIProfileAPITests(unittest.TestCase):
    setUp = config_tests.AIConfigurationTests.setUp
    request = config_tests.AIConfigurationTests.request
    assert_private = config_tests.AIConfigurationTests.assert_private

    def catalog(self):
        return self.request('/api/ai/profiles')

    def update(self, action, identifier, profile=None, expected=200, revision=None):
        data = {'action': action, 'id': identifier,
                'revision': self.catalog()['revision'] if revision is None else revision}
        if profile is not None:
            data['profile'] = profile
        return self.request('/api/ai/profiles', data, expected=expected)

    def test_catalog_has_four_services_and_preserves_current_model_without_network(self):
        catalog = self.catalog()
        self.assert_private(catalog)
        rows = {row['id']: row for row in catalog['profiles']}
        self.assertEqual(rows['qwen-text']['base_url'], 'http://10.177.137.55:9030/v1')
        self.assertEqual(rows['paddleocr-vl']['kind'], 'ocr')
        self.assertEqual(rows['qwen-asr']['kind'], 'asr')
        self.assertEqual(rows['vibevoice']['model'], 'microsoft/VibeVoice')
        self.assertEqual(rows[catalog['active_profile_id']]['model'], 'synthetic-model')
        self.assertFalse(self.path.exists())
        self.assertTrue(all('api_key' not in row for row in rows.values()))

    def test_saved_text_profile_can_be_tested_without_activation_or_credential_transfer(self):
        catalog = self.catalog()
        with patch.object(server, 'model_urlopen', return_value=response({'ok': True})) as network:
            result = self.request('/api/ai/test', {'profile_id': 'qwen-text', 'revision': catalog['revision']})
        self.assertEqual(result, {'ok': True})
        request = network.call_args.args[0]
        self.assertEqual(request.full_url, 'http://10.177.137.55:9030/v1/chat/completions')
        self.assertEqual(json.loads(request.data)['model'], 'Qwen/Qwen3.8-27B')
        self.assertNotIn('Authorization', dict(request.header_items()))
        active = configuration.load_config(self.path)
        self.assertEqual((active['base_url'], active['api_key']), (BASE, SECRET))

    def test_selected_text_model_discovery_uses_saved_profile_and_rejects_stale_revision(self):
        import io
        catalog = self.catalog()
        with patch.object(configuration, 'model_urlopen', return_value=io.BytesIO(b'{"data":[{"id":"local-model"}]}')) as network:
            result = self.request('/api/ai/models', {'profile_id': 'qwen-text', 'revision': catalog['revision']})
        self.assertEqual(result, {'models': [{'id': 'local-model'}]})
        self.assertEqual(network.call_args.args[0].full_url, 'http://10.177.137.55:9030/v1/models')
        self.update('activate', 'qwen-text')
        self.request('/api/ai/models', {'profile_id': 'qwen-text', 'revision': catalog['revision']}, expected=409)

    def test_ocr_and_audio_profiles_cannot_be_tested_or_activated_as_text_models(self):
        revision = self.catalog()['revision']
        for identifier in ('paddleocr-vl', 'qwen-asr', 'vibevoice'):
            for path in ('/api/ai/models', '/api/ai/test'):
                with self.subTest(profile=identifier, path=path):
                    self.request(path, {'profile_id': identifier, 'revision': revision}, expected=400)
            self.update('activate', identifier, expected=400)
        self.assertEqual(configuration.load_config(self.path)['model'], 'synthetic-model')

    def test_editing_ocr_does_not_mark_evaluations_pending_but_text_activation_does(self):
        with server.connect() as db:
            db.execute("INSERT INTO jobs(id,title,city,jd,criteria,created) VALUES(1,'测试岗位','','JD','条件','now')")
            db.execute("INSERT INTO candidates(id,job_id,name,resume,phone,email,link,created) VALUES(1,1,'测试候选人','测试履历','','','','now')")
            db.execute("INSERT INTO evaluations(candidate_id,model,result,created) VALUES(1,'synthetic-model','{}','now')")
        row = next(row for row in self.catalog()['profiles'] if row['id'] == 'paddleocr-vl')
        result = self.update('save', row['id'], {**row, 'name': '内部 OCR'})
        self.assertEqual(result['pending_candidates'], 0)
        self.assertEqual(result['config']['model'], 'synthetic-model')
        self.assert_private(result)
        with server.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM audit WHERE action='evaluate_pending'").fetchone()[0], 0)
        result = self.update('activate', 'qwen-text')
        self.assertEqual(result['pending_candidates'], 1)
        self.assertEqual(result['catalog']['active_profile_id'], 'qwen-text')
        self.assertEqual(result['config']['model'], 'Qwen/Qwen3.8-27B')

    def test_profile_mutation_respects_model_lock_and_stale_revision(self):
        revision = self.catalog()['revision']
        self.assertTrue(server.AI_LOCK.acquire(blocking=False))
        try:
            self.update('activate', 'qwen-text', expected=409)
        finally:
            server.AI_LOCK.release()
        self.assertFalse(self.path.exists())
        self.update('activate', 'qwen-text')
        self.update('delete', 'qwen-asr', revision=revision, expected=409)
        self.assertIn('qwen-asr', [row['id'] for row in self.catalog()['profiles']])


if __name__ == '__main__':
    unittest.main()
