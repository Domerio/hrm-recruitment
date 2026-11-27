"""A model switch starts a new evaluation generation without touching history."""
from datetime import date
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_configuration as configuration


class ModelSwitchEpochTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'ai-config.json'
        environment = patch.dict(os.environ, {
            'AI_MODEL':'model-a', 'AI_BASE_URL':'https://synthetic.invalid/v1',
            'DEEPSEEK_API_KEY':'synthetic-secret',
        })
        environment.start()
        self.addCleanup(environment.stop)
        network = patch.object(configuration, 'model_urlopen',
                               side_effect=AssertionError('No live model calls'))
        network.start()
        self.addCleanup(network.stop)

    def config(self):
        return configuration.load_config(self.path)

    def save(self, **changes):
        return configuration.save_config(self.path, {**self.config(), **changes})

    def change_profile(self, action, identifier, **changes):
        catalog = configuration.load_profiles(self.path)
        data = {'action':action, 'id':identifier, 'revision':catalog['revision']}
        if action == 'save':
            row = next(row for row in catalog['profiles'] if row['id'] == identifier)
            data['profile'] = {**row, 'api_key':'', **changes}
        return configuration.update_profiles(self.path, data)

    def test_flat_config_switch_back_starts_new_generation(self):
        self.assertEqual(self.config()['evaluation_epoch'], 0)
        a, changed = self.save()
        self.assertFalse(changed)
        self.assertEqual(a['evaluation_epoch'], 0)
        b, changed = self.save(model='model-b')
        self.assertTrue(changed)
        self.assertEqual(b['evaluation_epoch'], 1)
        a_again, changed = self.save(model='model-a')
        self.assertTrue(changed)
        self.assertEqual(a_again['evaluation_epoch'], 2)
        self.assertEqual(self.config()['evaluation_epoch'], 2)
        self.assertEqual(json.loads(self.path.read_text('utf8'))['evaluation_epoch'], 2)

    def test_catalog_switch_back_starts_new_generation_and_noop_keeps_it(self):
        self.change_profile('activate', 'qwen-text')
        self.assertEqual(self.config()['evaluation_epoch'], 1)
        self.change_profile('activate', 'current')
        self.assertEqual(self.config()['model'], 'model-a')
        self.assertEqual(self.config()['evaluation_epoch'], 2)
        before = self.path.read_bytes()
        same, changed = self.change_profile('activate', 'current')
        self.assertFalse(changed)
        self.assertEqual(same['evaluation_epoch'], 2)
        self.assertEqual(self.path.read_bytes(), before)

    def test_inactive_profiles_and_cosmetic_changes_preserve_generation(self):
        self.change_profile('activate', 'qwen-text')
        epoch = self.config()['evaluation_epoch']
        revision = self.config()['revision']
        for identifier, changes in (
            ('paddleocr-vl', {'model':'synthetic-ocr-new'}),
            ('qwen-asr', {'api_key':'synthetic-asr-key'}),
            ('current', {'model':'inactive-text-new'}),
            ('qwen-text', {'name':'Renamed active profile'}),
        ):
            with self.subTest(identifier=identifier):
                saved, changed = self.change_profile('save', identifier, **changes)
                self.assertFalse(changed)
                self.assertEqual(saved['evaluation_epoch'], epoch)
                self.assertGreater(saved['revision'], revision)
        self.change_profile('delete', 'vibevoice')
        self.assertEqual(self.config()['evaluation_epoch'], epoch)

    def test_active_model_service_and_key_changes_each_expire_previous_generation(self):
        changes = [
            {'model':'model-b'},
            {'base_url':'https://second.invalid/v1', 'api_key':'synthetic-secret'},
            {'provider':'openai-compatible', 'api_key':'synthetic-secret'},
            {'api_key':'synthetic-rotated'},
        ]
        for expected, change in enumerate(changes, 1):
            saved, changed = self.save(**change)
            self.assertTrue(changed)
            self.assertEqual(saved['evaluation_epoch'], expected)
        same, changed = self.save(evaluation_epoch=0)
        self.assertFalse(changed)
        self.assertEqual(same['evaluation_epoch'], len(changes))

    def test_profile_config_preserves_epoch_without_changing_active_model(self):
        self.change_profile('activate', 'qwen-text')
        self.change_profile('activate', 'current')
        before = self.path.read_bytes()
        selected = configuration.profile_config(self.path, 'qwen-text', self.config()['revision'])
        self.assertEqual(selected['evaluation_epoch'], self.config()['evaluation_epoch'])
        self.assertEqual(self.path.read_bytes(), before)

    def test_legacy_config_without_epoch_loads_as_zero(self):
        original = {key:value for key,value in self.config().items()
                    if key not in ('source', 'evaluation_epoch')}
        original['revision'] = 7
        self.path.write_text(json.dumps(original), encoding='utf8')
        self.assertEqual(self.config()['evaluation_epoch'], 0)
        saved, changed = self.save(model='model-b')
        self.assertTrue(changed)
        self.assertEqual(saved['evaluation_epoch'], 1)
        self.assertEqual(saved['revision'], 8)

    def test_invalid_epoch_is_rejected_without_network_or_silent_reset(self):
        self.save()
        original = json.loads(self.path.read_text('utf8'))
        for value in (True, -1, '2', None, 1.5):
            with self.subTest(value=value):
                self.path.write_text(json.dumps({**original, 'evaluation_epoch':value}), encoding='utf8')
                with self.assertRaisesRegex(ValueError, '无法读取'):
                    self.config()
                with self.assertRaisesRegex(ValueError, '无法读取'):
                    configuration.profile_config(self.path, 'current', original['revision'])

    def fingerprint(self, config=None):
        import server
        return server.evaluation_fingerprint(
            {'jd':'Synthetic developer role', 'criteria':'Python', 'must_have':'', 'priority_groups':[]},
            {'job_id':1, 'resume':'Synthetic Python experience'},
            {}, date(2026, 11, 21), config=self.config() if config is None else config)

    def test_fingerprint_switch_back_is_new_but_same_generation_is_reusable(self):
        initial = self.fingerprint()
        self.save()
        self.assertEqual(self.fingerprint(), initial)
        self.save(model='model-b')
        second = self.fingerprint()
        self.assertNotEqual(second, initial)
        self.save(model='model-a')
        switched_back = self.fingerprint()
        self.assertNotEqual(switched_back, initial)
        self.assertNotEqual(switched_back, second)
        self.assertEqual(self.fingerprint(), switched_back)
        self.save()
        self.assertEqual(self.fingerprint(), switched_back)

    def test_fingerprint_legacy_missing_epoch_matches_explicit_zero(self):
        explicit_zero = self.config()
        without_epoch = {key:value for key,value in explicit_zero.items() if key != 'evaluation_epoch'}
        self.assertEqual(self.fingerprint(without_epoch), self.fingerprint(explicit_zero))

    def test_fingerprint_inactive_catalog_edits_keep_active_cache(self):
        self.change_profile('activate', 'qwen-text')
        initial = self.fingerprint()
        self.change_profile('save', 'paddleocr-vl', model='synthetic-ocr-new')
        self.change_profile('save', 'current', model='inactive-text-new')
        self.change_profile('save', 'qwen-text', name='Active display name')
        self.assertEqual(self.fingerprint(), initial)

    def test_failed_switch_keeps_generation_and_active_model(self):
        self.save()
        before = self.path.read_bytes()
        with patch.object(configuration.os, 'replace', side_effect=PermissionError('synthetic')):
            with self.assertRaisesRegex(ValueError, '原配置已保留'):
                self.change_profile('activate', 'qwen-text')
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.config()['evaluation_epoch'], 0)
        self.assertEqual(self.config()['model'], 'model-a')


if __name__ == '__main__':
    unittest.main()
