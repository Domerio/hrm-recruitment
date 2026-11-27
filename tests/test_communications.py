"""Conversation identity, incremental imports, and received file invariants."""

from copy import deepcopy
import sqlite3
import unittest

from communications import (
    bind_candidate, candidate_attachments, ensure_communication_tables, get_attachment, get_conversation,
    import_attachment, import_snapshot, list_conversations,
)


class CommunicationsTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.execute('CREATE TABLE jobs(id INTEGER PRIMARY KEY,title TEXT)')
        self.db.executemany('INSERT INTO jobs VALUES(?,?)', [(1, '岗位一'), (2, '岗位二')])
        self.db.execute('''CREATE TABLE candidates(id INTEGER PRIMARY KEY,
            job_id INTEGER REFERENCES jobs(id),name TEXT,link TEXT,deleted INTEGER DEFAULT 0)''')
        ensure_communication_tables(self.db)
        self.db.commit()

    def snapshot(self):
        return {
            'job_id': 1, 'account_id': 'recruiter-a', 'account_name': '招聘账号一',
            'conversations': [{
                'friend_id': '101', 'candidate_name': '合成人员', 'platform_job_id': 'job-a',
                'last_message': '已发送简历', 'last_at': '2026-11-18T08:00:00Z', 'unread_count': 2,
            }],
            'messages': [{
                'friend_id': '101', 'message_id': '501', 'direction': 'incoming',
                'text': '请查看附件', 'sent_at': '2026-11-18T08:00:00Z', 'kind': 'attachment',
                'attachment_name': '简历.txt', 'attachment_status': 'received',
            }],
        }

    def imported_message(self, data=None):
        result = import_snapshot(self.db, data or self.snapshot())
        conversation_id = result['conversation_ids'][0]
        return conversation_id, get_conversation(self.db, conversation_id)['messages'][0]['id']

    def candidate(self, candidate_id=10, job_id=1, link='', name='合成人员', deleted=0):
        self.db.execute('INSERT INTO candidates(id,job_id,name,link,deleted) VALUES(?,?,?,?,?)',
                        (candidate_id, job_id, name, link, deleted))
        return candidate_id

    def test_accounts_jobs_and_same_name_candidates_remain_separate(self):
        data = self.snapshot()
        self.imported_message(data)
        other_account = deepcopy(data)
        other_account['account_id'] = 'recruiter-b'
        self.imported_message(other_account)
        other_job = deepcopy(data)
        other_job['job_id'] = 2
        self.imported_message(other_job)
        same_name = deepcopy(data)
        same_name['conversations'][0]['friend_id'] = '102'
        same_name['messages'][0]['friend_id'] = '102'
        self.imported_message(same_name)
        self.assertEqual(len(list_conversations(self.db)), 4)
        self.assertEqual(len(list_conversations(self.db, job_id=1)), 3)
        self.assertTrue(all(row['message_count'] == 1 for row in list_conversations(self.db)))

    def test_invalid_later_message_does_not_save_earlier_conversation(self):
        data = self.snapshot()
        data['messages'].append({
            'friend_id': '101', 'message_id': '502', 'direction': 'unrecognized', 'text': '错误消息',
        })
        with self.assertRaisesRegex(ValueError, '方向无效'):
            import_snapshot(self.db, data)
        self.assertEqual(list_conversations(self.db), [])

    def test_missing_stable_identity_or_unrelated_message_is_rejected(self):
        for field in ('account_id',):
            data = self.snapshot()
            data[field] = ''
            with self.assertRaises(ValueError):
                import_snapshot(self.db, data)
        for identifier in ('', '0', None):
            data = self.snapshot()
            data['conversations'][0]['friend_id'] = identifier
            with self.assertRaises(ValueError):
                import_snapshot(self.db, data)
        data = self.snapshot()
        data['messages'][0]['friend_id'] = 'different-friend'
        with self.assertRaisesRegex(ValueError, '本次导入的会话'):
            import_snapshot(self.db, data)
        self.assertEqual(list_conversations(self.db), [])

    def test_unknown_unread_is_preserved_and_explicit_zero_is_applied(self):
        data = self.snapshot()
        data['conversations'][0]['unread_count'] = None
        conversation_id, _ = self.imported_message(data)
        self.assertIsNone(get_conversation(self.db, conversation_id)['unread_count'])
        data['conversations'][0]['unread_count'] = 3
        import_snapshot(self.db, data)
        data['conversations'][0]['unread_count'] = None
        import_snapshot(self.db, data)
        self.assertEqual(get_conversation(self.db, conversation_id)['unread_count'], 3)
        data['conversations'][0]['unread_count'] = 0
        import_snapshot(self.db, data)
        self.assertEqual(get_conversation(self.db, conversation_id)['unread_count'], 0)

    def test_message_snapshots_are_incremental_and_idempotent(self):
        conversation_id, _ = self.imported_message()
        data = self.snapshot()
        data['messages'] = [{
            'friend_id': '101', 'message_id': '502', 'direction': 'outgoing', 'text': '收到，谢谢',
            'sent_at': '2026-11-18T08:01:00Z', 'kind': 'text',
        }]
        first = import_snapshot(self.db, data)
        second = import_snapshot(self.db, data)
        self.assertEqual(first['new_messages'], 1)
        self.assertEqual(second['new_messages'], 0)
        self.assertEqual(len(get_conversation(self.db, conversation_id)['messages']), 2)
        data['messages'] = []
        import_snapshot(self.db, data)
        self.assertEqual(get_conversation(self.db, conversation_id)['message_count'], 2)

    def test_older_or_undated_summary_cannot_replace_newer_pair(self):
        conversation_id, _ = self.imported_message()
        data = self.snapshot()
        summary = data['conversations'][0]
        summary.update(last_message='旧消息', last_at='2026-11-18T07:00:00Z')
        import_snapshot(self.db, data)
        conversation = get_conversation(self.db, conversation_id)
        self.assertEqual((conversation['last_message'], conversation['last_at']),
                         ('已发送简历', '2026-11-18T08:00:00Z'))
        summary.update(last_message='时间未知', last_at='')
        import_snapshot(self.db, data)
        self.assertEqual(get_conversation(self.db, conversation_id)['last_message'], '已发送简历')
        summary.update(last_message='', last_at='2026-11-18T09:00:00Z')
        import_snapshot(self.db, data)
        conversation = get_conversation(self.db, conversation_id)
        self.assertEqual((conversation['last_message'], conversation['last_at']),
                         ('', '2026-11-18T09:00:00Z'))

    def test_history_imported_later_is_ordered_by_platform_message_id(self):
        conversation_id, _ = self.imported_message()
        data = self.snapshot()
        data['messages'][0].update(message_id='499', sent_at='')
        import_snapshot(self.db, data)
        messages = get_conversation(self.db, conversation_id)['messages']
        self.assertEqual([message['message_id'] for message in messages], ['499', '501'])

    def test_out_of_range_local_ids_are_rejected_as_validation_errors(self):
        for value in (True, 0, -1, 2**63, str(2**80)):
            with self.assertRaises(ValueError):
                get_conversation(self.db, value)
            with self.assertRaises(ValueError):
                get_attachment(self.db, value)

    def test_existing_message_direction_conflict_rejects_whole_batch(self):
        self.imported_message()
        data = self.snapshot()
        data['conversations'].insert(0, {'friend_id': '102', 'candidate_name': '另一人'})
        data['messages'][0]['direction'] = 'outgoing'
        with self.assertRaisesRegex(ValueError, '发送方或类型不一致'):
            import_snapshot(self.db, data)
        self.assertEqual(len(list_conversations(self.db)), 1)

    def test_platform_job_conflict_rejects_batch_without_changing_saved_data(self):
        conversation_id, _ = self.imported_message()
        data = self.snapshot()
        data['conversations'].insert(0, {'friend_id': '102', 'candidate_name': '另一人'})
        data['conversations'][1]['platform_job_id'] = 'different-platform-job'
        with self.assertRaisesRegex(ValueError, '平台岗位不一致'):
            import_snapshot(self.db, data)
        self.assertEqual(len(list_conversations(self.db)), 1)
        self.assertEqual(get_conversation(self.db, conversation_id)['platform_job_id'], 'job-a')
        data['conversations'][1]['platform_job_id'] = ''
        import_snapshot(self.db, data)
        self.assertEqual(get_conversation(self.db, conversation_id)['platform_job_id'], 'job-a')

    def test_no_module_function_commits_the_callers_transaction(self):
        self.db.execute('INSERT INTO jobs VALUES(3,?)', ('未提交岗位',))
        ensure_communication_tables(self.db)
        self.imported_message()
        self.assertTrue(self.db.in_transaction)
        self.db.rollback()
        self.assertIsNone(self.db.execute('SELECT id FROM jobs WHERE id=3').fetchone())
        self.assertEqual(list_conversations(self.db), [])

    def test_received_file_is_idempotent_and_different_file_cannot_overwrite(self):
        conversation_id, message_id = self.imported_message()
        raw = '合成人员\n工作经历 原文'.encode()
        calls = []

        def extract(name, content):
            calls.append(name)
            return content.decode()

        result = import_attachment(self.db, conversation_id, message_id, '../简历.txt', raw, extract)
        duplicate = import_attachment(self.db, conversation_id, message_id, '简历.txt', raw, extract)
        self.assertEqual(result['name'], '简历.txt')
        self.assertEqual(calls, ['简历.txt'])
        self.assertTrue(duplicate['duplicate'])
        self.assertEqual(result['id'], duplicate['id'])
        self.assertEqual(get_attachment(self.db, result['id'])['content'], raw)
        with self.assertRaisesRegex(ValueError, '已导入不同文件'):
            import_attachment(self.db, conversation_id, message_id, '简历.txt', b'other content', extract)
        self.assertEqual(get_attachment(self.db, result['id'])['content'], raw)
        import_snapshot(self.db, self.snapshot())
        saved = get_conversation(self.db, conversation_id)['messages'][0]['attachment']
        self.assertEqual(saved['id'], result['id'])

    def test_pending_or_expired_or_outgoing_files_cannot_be_imported(self):
        for index, (direction, status) in enumerate((
            ('incoming', 'pending'), ('incoming', 'expired'), ('outgoing', 'received'),
        )):
            data = self.snapshot()
            data['messages'][0].update(message_id=str(600 + index), direction=direction, attachment_status=status)
            result = import_snapshot(self.db, data)
            conversation_id = result['conversation_ids'][0]
            message_id = self.db.execute('SELECT id FROM communication_messages WHERE platform_message_id=?',
                (str(600 + index),)).fetchone()['id']
            with self.assertRaises(ValueError):
                import_attachment(self.db, conversation_id, message_id, '简历.txt', b'text', lambda *_: 'text')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM communication_attachments').fetchone()[0], 0)

    def test_attachment_cannot_be_assigned_to_another_conversation(self):
        _, message_id = self.imported_message()
        other = self.snapshot()
        other['account_id'] = 'another-account'
        conversation_id, _ = self.imported_message(other)
        with self.assertRaisesRegex(ValueError, '该会话'):
            import_attachment(self.db, conversation_id, message_id, '简历.txt', b'text', lambda *_: 'text')

    def test_received_fact_and_saved_original_survive_platform_expiry(self):
        conversation_id, message_id = self.imported_message()
        result = import_attachment(self.db, conversation_id, message_id, '简历.txt', b'text', lambda *_: 'text')
        data = self.snapshot()
        data['messages'][0]['attachment_status'] = 'expired'
        import_snapshot(self.db, data)
        data['messages'][0]['attachment_status'] = 'pending'
        import_snapshot(self.db, data)
        message = get_conversation(self.db, conversation_id)['messages'][0]
        self.assertEqual(message['attachment_status'], 'expired')
        self.assertTrue(message['attachment_received'])
        self.assertEqual(get_attachment(self.db, result['id'])['content'], b'text')
        with self.assertRaisesRegex(ValueError, '过期'):
            import_attachment(self.db, conversation_id, message_id, '简历.txt', b'text', lambda *_: 'text')

    def test_invalid_format_or_failed_extraction_does_not_save_file(self):
        conversation_id, message_id = self.imported_message()
        for name, raw in [('简历.pdf', b'not a pdf'), ('简历.docx', b'not a zip'),
                          ('简历.exe', b'text'), ('简历.txt', b'\xff\xfe')]:
            with self.assertRaises(ValueError):
                import_attachment(self.db, conversation_id, message_id, name, raw, lambda *_: 'text')

        def fail(*_):
            raise ValueError('模拟文件损坏')

        with self.assertRaisesRegex(ValueError, '文件损坏'):
            import_attachment(self.db, conversation_id, message_id, '简历.txt', b'text', fail)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM communication_attachments').fetchone()[0], 0)

    def test_unique_explicit_platform_identity_automatically_binds_same_job_candidate(self):
        self.candidate(link='https://www.zhipin.com/web/geek/info?encryptGeekId=geek-a&securityId=private-token')
        self.candidate(candidate_id=11, job_id=2, link='https://www.zhipin.com/web/geek/info?encryptGeekId=geek-a')
        data = self.snapshot()
        data['conversations'][0]['platform_geek_id'] = 'geek-a'
        conversation_id, message_id = self.imported_message(data)
        conversation = get_conversation(self.db, conversation_id)
        self.assertEqual(conversation['candidate_id'], 10)
        self.assertEqual(conversation['candidate_binding_status'], 'linked')
        self.assertEqual(list_conversations(self.db)[0]['candidate_id'], 10)
        attachment = import_attachment(self.db, conversation_id, message_id, '简历.txt', b'text', lambda *_: 'text')
        records = candidate_attachments(self.db, 10)
        self.assertEqual(records['conversations'][0]['id'], conversation_id)
        self.assertEqual(records['attachments'][0]['id'], attachment['id'])
        self.assertEqual(records['attachments'][0]['message_id'], message_id)
        self.assertNotIn('private-token', str(records))
        self.assertEqual(candidate_attachments(self.db, 11), {'conversations': [], 'attachments': [], 'resumes': []})

    def test_same_name_plain_uid_and_external_links_do_not_automatically_match(self):
        for identifier, link in (
            (10, ''), (11, 'https://www.zhipin.com/web/geek/info?uid=geek-a'),
            (12, 'https://other.example/profile?encryptGeekId=geek-a'),
        ):
            self.candidate(candidate_id=identifier, link=link)
        data = self.snapshot()
        data['conversations'][0]['platform_geek_id'] = 'geek-a'
        conversation_id, _ = self.imported_message(data)
        self.assertIsNone(get_conversation(self.db, conversation_id)['candidate_id'])
        self.assertEqual(get_conversation(self.db, conversation_id)['candidate_binding_status'], 'unmatched')

    def test_duplicate_platform_candidates_need_explicit_confirmation(self):
        self.candidate(link='https://www.zhipin.com/web/geek/info?encryptGeekId=geek-a')
        self.candidate(candidate_id=11, link='https://www.zhipin.com/web/geek/info?encryptUid=geek-a')
        data = self.snapshot()
        data['conversations'][0]['platform_geek_id'] = 'geek-a'
        conversation_id, _ = self.imported_message(data)
        conversation = get_conversation(self.db, conversation_id)
        self.assertIsNone(conversation['candidate_id'])
        self.assertEqual(conversation['candidate_binding_status'], 'ambiguous')
        self.assertEqual(bind_candidate(self.db, conversation_id, 11)['candidate_id'], 11)

    def test_manual_binding_rejects_cross_job_deleted_and_conflicting_identity(self):
        self.candidate(link='https://www.zhipin.com/web/geek/info?encryptGeekId=other-geek')
        self.candidate(candidate_id=11, job_id=2)
        self.candidate(candidate_id=12, deleted=1)
        self.candidate(candidate_id=13, link='https://www.zhipin.com/web/geek/info?encryptGeekId=geek-a&encryptUid=other')
        self.candidate(candidate_id=14)
        data = self.snapshot()
        data['conversations'][0]['platform_geek_id'] = 'geek-a'
        conversation_id, _ = self.imported_message(data)
        for identifier in (10, 11, 12, 13):
            with self.assertRaises(ValueError):
                bind_candidate(self.db, conversation_id, identifier)
        self.assertIsNone(get_conversation(self.db, conversation_id)['candidate_id'])
        self.assertEqual(bind_candidate(self.db, conversation_id, 14)['candidate_id'], 14)

    def test_platform_identity_conflict_cannot_change_existing_binding_or_batch(self):
        self.candidate(link='https://www.zhipin.com/web/geek/info?encryptGeekId=geek-a')
        data = self.snapshot()
        data['conversations'][0]['platform_geek_id'] = 'geek-a'
        conversation_id, _ = self.imported_message(data)
        data['conversations'].insert(0, {'friend_id': '102', 'candidate_name': '新人员'})
        data['conversations'][1]['platform_geek_id'] = 'geek-b'
        with self.assertRaisesRegex(ValueError, '候选人平台标识不一致'):
            import_snapshot(self.db, data)
        self.assertEqual(len(list_conversations(self.db)), 1)
        self.assertEqual(get_conversation(self.db, conversation_id)['candidate_id'], 10)
        self.assertEqual(get_conversation(self.db, conversation_id)['platform_geek_id'], 'geek-a')

    def test_new_identity_evidence_hides_mismatched_manual_binding_and_attachments(self):
        self.candidate(link='https://www.zhipin.com/web/geek/info?encryptGeekId=geek-b')
        conversation_id, message_id = self.imported_message()
        bind_candidate(self.db, conversation_id, 10)
        import_attachment(self.db, conversation_id, message_id, '简历.txt', b'text', lambda *_: 'text')
        data = self.snapshot()
        data['conversations'][0]['platform_geek_id'] = 'geek-a'
        import_snapshot(self.db, data)
        conversation = get_conversation(self.db, conversation_id)
        self.assertIsNone(conversation['candidate_id'])
        self.assertEqual(conversation['candidate_binding_status'], 'conflict')
        self.assertEqual(candidate_attachments(self.db, 10), {'conversations': [], 'attachments': [], 'resumes': []})
        self.assertEqual(self.db.execute('SELECT candidate_id FROM communication_conversations').fetchone()[0], 10)

    def test_deleted_candidate_is_not_reported_as_linked(self):
        self.candidate()
        conversation_id, _ = self.imported_message()
        bind_candidate(self.db, conversation_id, 10)
        self.db.execute('UPDATE candidates SET deleted=1 WHERE id=10')
        self.assertIsNone(get_conversation(self.db, conversation_id)['candidate_id'])
        self.assertIsNone(list_conversations(self.db)[0]['candidate_id'])
        with self.assertRaisesRegex(ValueError, '已删除'):
            candidate_attachments(self.db, 10)

    def test_existing_conversation_schema_is_migrated_without_losing_history(self):
        self.db.execute('DROP TABLE communication_attachments')
        self.db.execute('DROP TABLE communication_messages')
        self.db.execute('DROP TABLE communication_conversations')
        self.db.execute('''CREATE TABLE communication_conversations(
            id INTEGER PRIMARY KEY,account_id TEXT NOT NULL,account_name TEXT NOT NULL,
            job_id INTEGER NOT NULL REFERENCES jobs(id),friend_id TEXT NOT NULL,candidate_name TEXT NOT NULL,
            platform_job_id TEXT NOT NULL DEFAULT '',last_message TEXT NOT NULL DEFAULT '',
            last_at TEXT NOT NULL DEFAULT '',unread_count INTEGER,updated TEXT NOT NULL,
            UNIQUE(account_id,job_id,friend_id))''')
        self.db.execute('''INSERT INTO communication_conversations(
            account_id,account_name,job_id,friend_id,candidate_name,updated)
            VALUES('account','招聘账号',1,'123','历史人员','2026-11-18')''')
        ensure_communication_tables(self.db)
        ensure_communication_tables(self.db)
        conversation = get_conversation(self.db, 1)
        self.assertEqual(conversation['candidate_name'], '历史人员')
        self.assertIsNone(conversation['candidate_id'])
        self.assertEqual(conversation['platform_geek_id'], '')
        self.assertEqual(conversation['candidate_binding_status'], 'unmatched')
        candidate_foreign_keys = [row for row in self.db.execute('PRAGMA foreign_key_list(communication_conversations)')
                                  if row['from'] == 'candidate_id']
        self.assertEqual(candidate_foreign_keys[0]['table'], 'candidates')


if __name__ == '__main__':
    unittest.main()
