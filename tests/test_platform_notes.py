import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


NOTE = {'kind': 'latest_work_may_be_outdated', 'text': '最近一份工作经历可能未更新',
        'section': '工作经历', 'anchor': '虚构视觉公司 | 视觉工程师 | 2020.05 - 2026.10'}
CAPTURE = {'status': 'visible_complete', 'sections': ['工作经历'], 'warnings': []}
RESUME = '张**\n工作经历\n虚构视觉公司 | 视觉工程师 | 2020.05 - 2026.10\n负责视觉软件开发和工业检测产线交付。'


class PlatformNotesTests(unittest.TestCase):
    def test_known_notes_are_deduplicated_and_unknown_fields_are_discarded(self):
        capture = server.normalize_capture({**CAPTURE, 'platform_notes': [
            {**NOTE, 'url': 'https://private.invalid', 'paintIdentity': {'private': True}}, dict(NOTE)]})
        self.assertEqual(capture['platform_notes'], [NOTE])
        self.assertEqual(capture['status'], 'visible_complete')
        self.assertEqual(capture['warnings'], [])
        self.assertNotIn('platform_notes', server.normalize_capture(CAPTURE))

    def test_unknown_or_unbounded_notes_are_rejected(self):
        invalid = [None, {}, 'note', [None], [{**NOTE, 'kind': 'verified_problem'}],
                   [{**NOTE, 'text': '工作经历确定异常'}], [{**NOTE, 'section': '教育经历'}],
                   [{**NOTE, 'anchor': 123}], [{**NOTE, 'anchor': ' '}],
                   [{**NOTE, 'anchor': 'x' * 1001}], [NOTE] * 9]
        for notes in invalid:
            with self.subTest(notes=notes), self.assertRaisesRegex(ValueError, '平台提示'):
                server.normalize_capture({**CAPTURE, 'platform_notes': notes})
        notes = [{**NOTE, 'anchor': str(index)} for index in range(8)]
        self.assertEqual(server.normalize_capture({**CAPTURE, 'platform_notes': notes})['platform_notes'], notes)

    def test_notes_do_not_allow_missing_content_to_be_marked_complete(self):
        with self.assertRaisesRegex(ValueError, '缺失提示'):
            server.normalize_capture({**CAPTURE, 'warnings': ['仍有折叠内容'], 'platform_notes': [NOTE]})

    def test_notes_persist_separately_without_changing_resume_or_format(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(server, 'DB', Path(directory) / 'notes.sqlite'):
            server.init_db()
            with server.connect() as db:
                db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)', (1, '虚构岗位', '', '虚构职责', '视觉软件开发', 'earlier'))
            capture = server.normalize_capture({**CAPTURE, 'platform_notes': [NOTE]})
            cid, created = server.save_boss_candidate(1, '张**', RESUME, '', capture=capture)
            self.assertTrue(created)
            with server.connect() as db:
                self.assertEqual(server.source_info(db, cid)['capture']['platform_notes'], [NOTE])
                self.assertEqual(db.execute('SELECT resume FROM candidates WHERE id=?', (cid,)).fetchone()['resume'], RESUME)
                self.assertEqual(db.execute('SELECT count(*) FROM evaluations').fetchone()[0], 0)
            self.assertNotIn(NOTE['text'], server.resume_document('', RESUME).decode('utf-8'))

    def test_platform_notes_do_not_expand_model_inputs_or_mutate_saved_capture(self):
        capture = server.normalize_capture({**CAPTURE, 'platform_notes': [NOTE]})
        model = Mock()
        with patch.object(server, 'resolve_evaluation', return_value={'synthetic': True}):
            result = server.complete_evaluation(model, {'jd': '视觉开发', 'criteria': '软件开发'}, RESUME, capture)
        self.assertEqual(result, {'synthetic': True})
        payload = model.complete.call_args.args[1]
        self.assertNotIn('platform_notes', payload['capture'])
        self.assertNotIn(NOTE['text'], payload['resume'])
        self.assertEqual(payload['capture'], {key: value for key, value in capture.items() if key != 'platform_notes'})
        self.assertEqual(capture['platform_notes'], [NOTE])


if __name__ == '__main__':
    unittest.main()
