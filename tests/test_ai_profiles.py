import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_configuration as configuration


ENV_KEY = 'synthetic-existing-secret'
ROW_KEY = 'synthetic-profile-secret'


class AIProfileTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'ai-config.json'
        environment = patch.dict(os.environ, {'AI_MODEL':'existing-model',
            'AI_BASE_URL':'https://existing.invalid/v1', 'DEEPSEEK_API_KEY':ENV_KEY})
        environment.start()
        self.addCleanup(environment.stop)
        network = patch.object(configuration, 'model_urlopen', side_effect=AssertionError('No model call expected'))
        network.start()
        self.addCleanup(network.stop)

    def catalog(self):
        return configuration.load_profiles(self.path)

    def row(self, identifier):
        return next(row for row in self.catalog()['profiles'] if row['id'] == identifier)

    def change(self, action, identifier=None, **profile):
        data = {'revision':self.catalog()['revision'], 'action':action}
        if identifier is not None:
            data['id'] = identifier
        if action == 'save':
            data['profile'] = {**(self.row(identifier) if identifier else {}), **profile}
        return configuration.update_profiles(self.path, data)

    def assert_private(self, value):
        encoded = json.dumps(value)
        for key in (ENV_KEY, ROW_KEY):
            self.assertNotIn(key, encoded)
        self.assertNotIn('"api_key"', encoded)

    def test_first_read_adds_four_services_without_replacing_or_persisting_existing_model(self):
        catalog = self.catalog()
        self.assertEqual(catalog['revision'], 0)
        self.assertEqual(catalog['active_profile_id'], 'current')
        self.assertEqual(self.row('current')['model'], 'existing-model')
        self.assertTrue(self.row('current')['has_key'])
        expected = {
            'qwen-text':('Qwen/Qwen3.8-27B', 'text', 'http://10.177.137.55:9030/v1', '/chat/completions'),
            'paddleocr-vl':('PaddlePaddle/PaddleOCR-VL-1.6', 'ocr', 'http://10.177.137.55:9031', '/layout-parsing'),
            'qwen-asr':('Qwen/Qwen3-ASR-1.7B', 'asr', 'http://10.177.137.55:9032/v1', '/chat/completions'),
            'vibevoice':('microsoft/VibeVoice', 'asr', 'http://10.177.137.55:9033/v1', '/chat/completions'),
        }
        for identifier, values in expected.items():
            row = self.row(identifier)
            self.assertEqual(tuple(row[key] for key in ('model', 'kind', 'base_url', 'request_path')), values)
            self.assertFalse(row['has_key'])
        self.assertEqual(self.row('paddleocr-vl')['docs_url'], 'http://10.177.137.55:9031/docs')
        self.assertEqual(self.row('qwen-asr')['docs_url'], 'http://10.177.137.55:9032/docs')
        self.assert_private(catalog)
        self.assertFalse(self.path.exists())

    def test_legacy_file_migrates_without_changing_effective_configuration_or_credentials(self):
        original = {'provider':'openai-compatible', 'base_url':'http://localhost:8888/v1',
                    'model':'legacy-custom', 'api_key':'', 'revision':7}
        self.path.write_text(json.dumps(original), encoding='utf8')
        before = self.path.read_bytes()
        self.assertEqual(self.row('current')['model'], 'legacy-custom')
        self.assertFalse(self.row('current')['has_key'])
        self.assertEqual(self.path.read_bytes(), before)
        saved, changed = self.change('save', 'paddleocr-vl', name='内部 OCR')
        self.assertFalse(changed)
        self.assertEqual(saved['revision'], 8)
        self.assertEqual(saved['model'], 'legacy-custom')
        self.assertEqual(saved['api_key'], '')
        self.assertEqual(self.row('paddleocr-vl')['name'], '内部 OCR')
        self.assertIn('profiles', json.loads(self.path.read_text('utf8')))

    def test_inactive_service_edit_is_persistent_and_does_not_change_evaluation_model(self):
        saved, changed = self.change('save', 'paddleocr-vl', model='custom-ocr',
            base_url='http://127.0.0.1:9331/layout-parsing', docs_url='http://127.0.0.1:9331/docs', api_key=ROW_KEY)
        self.assertFalse(changed)
        self.assertEqual(saved['model'], 'existing-model')
        self.assertEqual(saved['api_key'], ENV_KEY)
        row = self.row('paddleocr-vl')
        self.assertEqual(row['base_url'], 'http://127.0.0.1:9331')
        self.assertEqual(row['model'], 'custom-ocr')
        self.assertTrue(row['has_key'])
        self.assert_private(self.catalog())
        self.assert_private(configuration.public_config(saved))
        self.assert_private(configuration.safe_config(self.path))

    def test_switching_text_models_uses_each_profiles_own_key_and_keeps_edits(self):
        self.change('save', 'qwen-text', name='内部评分模型', model='Qwen/custom', api_key=ROW_KEY)
        saved, changed = self.change('activate', 'qwen-text')
        self.assertTrue(changed)
        self.assertEqual(saved['model'], 'Qwen/custom')
        self.assertEqual(saved['api_key'], ROW_KEY)
        self.assertEqual(self.catalog()['active_profile_id'], 'qwen-text')
        old, changed = self.change('activate', 'current')
        self.assertTrue(changed)
        self.assertEqual(old['api_key'], ENV_KEY)
        self.assertEqual(self.row('qwen-text')['name'], '内部评分模型')
        self.assertTrue(self.row('qwen-text')['has_key'])
        selected, _ = self.change('activate', 'qwen-text')
        self.assertEqual(selected['api_key'], ROW_KEY)

    def test_no_key_profile_does_not_inherit_environment_or_another_services_key(self):
        selected, _ = self.change('activate', 'qwen-text')
        self.assertEqual(selected['api_key'], '')
        self.assertTrue(configuration.public_config(selected)['configured'])
        self.assertNotIn('Authorization', configuration.authorization_headers(selected))
        self.assertTrue(self.row('current')['has_key'])

    def test_editing_active_profile_updates_flat_settings_and_signals_effective_change(self):
        self.change('activate', 'qwen-text')
        saved, changed = self.change('save', 'qwen-text', model='qwen-edited', api_key=ROW_KEY)
        self.assertTrue(changed)
        self.assertEqual(configuration.load_config(self.path)['model'], 'qwen-edited')
        self.assertEqual(saved['api_key'], ROW_KEY)
        _, changed = self.change('save', 'qwen-text', name='只改显示名称')
        self.assertFalse(changed)
        _, changed = self.change('save', 'qwen-text', docs_url='http://127.0.0.1:9030/docs')
        self.assertFalse(changed)

    def test_service_changes_and_explicit_clear_never_reuse_old_profile_secrets(self):
        self.change('save', 'qwen-text', api_key=ROW_KEY)
        self.change('save', 'qwen-text', name='重命名不清密钥')
        self.assertTrue(self.row('qwen-text')['has_key'])
        self.change('save', 'qwen-text', base_url='http://127.0.0.1:9100/v1')
        self.assertFalse(self.row('qwen-text')['has_key'])
        self.change('save', 'qwen-text', api_key=ROW_KEY)
        self.change('save', 'qwen-text', provider='deepseek')
        self.assertFalse(self.row('qwen-text')['has_key'])
        self.change('save', 'qwen-text', api_key=ROW_KEY)
        self.change('save', 'qwen-text', clear_key=True)
        self.assertFalse(self.row('qwen-text')['has_key'])

    def test_custom_profile_can_be_created_edited_selected_and_deleted(self):
        _, changed = self.change('save', name='自定义文字服务', kind='text', provider='openai-compatible',
            base_url='http://localhost:9444/v1', model='custom-model', docs_url='')
        self.assertFalse(changed)
        row = next(row for row in self.catalog()['profiles'] if row['model'] == 'custom-model')
        self.assertFalse(row['has_key'])
        identifier = row['id']
        self.change('save', identifier, model='edited-custom', api_key=ROW_KEY)
        selected, changed = self.change('activate', identifier)
        self.assertTrue(changed)
        self.assertEqual(selected['model'], 'edited-custom')
        self.assertEqual(selected['api_key'], ROW_KEY)
        self.change('activate', 'current')
        self.change('delete', identifier)
        self.assertNotIn(identifier, [row['id'] for row in self.catalog()['profiles']])

    def test_deleting_preset_does_not_restore_it_on_next_read_or_legacy_save(self):
        self.change('delete', 'vibevoice')
        config = configuration.load_config(self.path)
        configuration.save_config(self.path, {**config, 'model':'legacy-form-edit'})
        self.assertNotIn('vibevoice', [row['id'] for row in self.catalog()['profiles']])
        self.assertEqual(self.row('current')['model'], 'legacy-form-edit')
        self.assertEqual(configuration.load_config(self.path)['api_key'], ENV_KEY)

    def test_active_profile_cannot_be_deleted_or_converted_to_nontext(self):
        with self.assertRaisesRegex(ValueError, '不能删除'):
            self.change('delete', 'current')
        with self.assertRaisesRegex(ValueError, '当前评估模型必须'):
            self.change('save', 'current', kind='ocr', provider='paddleocr')
        for identifier in ('paddleocr-vl', 'qwen-asr', 'vibevoice'):
            with self.subTest(identifier=identifier), self.assertRaisesRegex(ValueError, '只有文字模型'):
                self.change('activate', identifier)
        self.assertFalse(self.path.exists())

    def test_selected_text_profile_can_be_tested_without_activating_it(self):
        self.change('save', 'qwen-text', api_key=ROW_KEY)
        before = self.path.read_bytes()
        selected = configuration.profile_config(self.path, 'qwen-text', self.catalog()['revision'])
        self.assertEqual(selected['api_key'], ROW_KEY)
        self.assertEqual(selected['model'], 'Qwen/Qwen3.8-27B')
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(configuration.load_config(self.path)['model'], 'existing-model')
        for identifier in ('paddleocr-vl', 'qwen-asr', 'vibevoice'):
            with self.subTest(identifier=identifier), self.assertRaisesRegex(ValueError, '当前仅保存配置'):
                configuration.profile_config(self.path, identifier, self.catalog()['revision'])
        with self.assertRaises(configuration.ConfigurationConflict):
            configuration.profile_config(self.path, 'qwen-text', 0)

    def test_revision_conflicts_and_invalid_edits_are_atomic(self):
        self.change('save', 'qwen-text', api_key=ROW_KEY)
        before = self.path.read_bytes()
        for action in ('save', 'activate', 'delete'):
            with self.subTest(action=action), self.assertRaises(configuration.ConfigurationConflict):
                configuration.update_profiles(self.path, {'action':action, 'revision':0, 'id':'qwen-text'})
        for changes in [{'name':''}, {'model':''}, {'base_url':'https://user:pass@example.invalid'},
                        {'docs_url':'javascript:alert(1)'}, {'docs_url':'http://example.invalid/docs?key=secret'},
                        {'api_key':'bad\r\nheader'}, {'clear_key':'yes'}, {'kind':'ocr'}, {'provider':'unknown'}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.change('save', 'qwen-text', **changes)
            self.assertEqual(self.path.read_bytes(), before)
        with self.assertRaises(ValueError):
            configuration.update_profiles(self.path, {'revision':self.catalog()['revision'], 'action':'delete', 'id':'../bad'})
        self.assertEqual(self.path.read_bytes(), before)

    def test_failed_atomic_replace_keeps_active_model_and_catalog_together(self):
        self.change('save', 'qwen-text', api_key=ROW_KEY)
        before = self.path.read_bytes()
        with patch.object(configuration.os, 'replace', side_effect=PermissionError('synthetic error')):
            with self.assertRaisesRegex(ValueError, '原配置已保留'):
                self.change('activate', 'qwen-text')
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.catalog()['active_profile_id'], 'current')
        self.assertEqual(list(self.path.parent.glob('.ai-config-*.json')), [])

    def test_legacy_edit_updates_active_row_only_without_replacing_other_profiles(self):
        self.change('save', 'qwen-text', name='内部服务', api_key=ROW_KEY)
        self.change('activate', 'qwen-text')
        previous = configuration.load_config(self.path)
        saved, changed = configuration.save_config(self.path, {**previous, 'api_key':'', 'model':'legacy-edited'})
        self.assertTrue(changed)
        self.assertEqual(saved['api_key'], ROW_KEY)
        self.assertEqual(self.row('qwen-text')['name'], '内部服务')
        self.assertEqual(self.row('qwen-text')['model'], 'legacy-edited')
        self.assertEqual(self.row('current')['model'], 'existing-model')
        self.assertEqual(len(self.catalog()['profiles']), 5)

    def test_same_saved_profile_and_reactivation_are_noops(self):
        self.change('activate', 'qwen-text')
        before = self.path.read_bytes()
        revision = self.catalog()['revision']
        for action in ('save', 'activate'):
            config, changed = self.change(action, 'qwen-text')
            self.assertFalse(changed)
            self.assertEqual(config['revision'], revision)
            self.assertEqual(self.path.read_bytes(), before)

    def test_corrupt_catalog_cannot_silently_select_another_model_or_reuse_environment_key(self):
        self.change('activate', 'qwen-text')
        original = json.loads(self.path.read_text('utf8'))
        variants = []
        duplicate = {**original, 'profiles':original['profiles'] + [original['profiles'][0]]}
        variants.append(duplicate)
        variants.append({**original, 'active_profile_id':'paddleocr-vl'})
        variants.append({**original, 'model':'mismatched-flat-model'})
        variants.append({**original, 'profiles':[]})
        for data in variants:
            with self.subTest(data=list(data)):
                self.path.write_text(json.dumps(data), encoding='utf8')
                with self.assertRaisesRegex(ValueError, '无法读取'):
                    self.catalog()
                with self.assertRaisesRegex(ValueError, '无法读取'):
                    configuration.load_config(self.path)
                self.assertFalse(configuration.safe_config(self.path)['configured'])


if __name__ == '__main__':
    unittest.main()
