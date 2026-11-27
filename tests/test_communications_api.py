import base64
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class CommunicationsApiTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        for name, value in [('DB', Path(folder.name) / 'test.sqlite'),
                            ('EXTENSION_FILE', Path(folder.name) / 'extension.json')]:
            changer = patch.object(server, name, value)
            changer.start()
            self.addCleanup(changer.stop)
        server.init_db()
        with server.connect() as db:
            for jid in (1, 2):
                db.execute('INSERT INTO jobs(id,title,city,jd,criteria,created) VALUES(?,?,?,?,?,?)',
                           (jid, f'Synthetic job {jid}', 'Synthetic city', 'JD', '', server.now()))
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.base = f'http://127.0.0.1:{self.http.server_port}'

    def stop(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def post(self, route, payload, status=200, token=None, origin=None):
        headers = {'Content-Type': 'application/json',
                   'X-App-Token': server.TOKEN if token is None else token}
        if origin:
            headers['Origin'] = origin
        request = urllib.request.Request(self.base + route,
            data=json.dumps(payload).encode(), headers=headers)
        try:
            with urllib.request.urlopen(request) as response:
                actual, result = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            actual, result = error.code, json.load(error)
        self.assertEqual(actual, status, result)
        return result

    def snapshot(self, jid=1):
        return {'job_id': jid, 'account_id': 'synthetic-account', 'account_name': 'Synthetic recruiter',
                'conversations': [{'friend_id': 'friend-7', 'candidate_name': 'Synthetic person',
                    'platform_job_id': 'job-7', 'last_message': '附件',
                    'last_at': '2026-11-18T06:00:00Z', 'unread_count': 1}],
                'messages': [{'friend_id': 'friend-7', 'message_id': 'message-9',
                    'direction': 'incoming', 'kind': 'attachment', 'text': 'Received resume',
                    'sent_at': '2026-11-18T06:00:00Z',
                    'attachment_name': 'resume.txt', 'attachment_status': 'received'}]}

    def test_pairing_token_and_origin_protect_import(self):
        snapshot = self.snapshot()
        self.post('/api/communications/import', snapshot, 403, token='wrong')
        self.post('/api/communications/import', snapshot, 403, origin='https://foreign.invalid')
        self.post('/api/communications/import', snapshot, 403, origin='chrome-extension://' + 'b' * 32)
        server.EXTENSION_FILE.write_text(json.dumps({'id': 'a' * 32}), encoding='utf-8')
        self.post('/api/communications/import', snapshot, origin='chrome-extension://' + 'a' * 32)
        rows = self.post('/api/communications/list', {})['conversations']
        self.assertEqual(len(rows), 1)

    def test_retry_deduplicates_and_download_is_bound_to_received_message(self):
        snapshot = self.snapshot()
        self.post('/api/communications/import', snapshot)
        self.post('/api/communications/import', snapshot)
        rows = self.post('/api/communications/list', {'job_id': 1})['conversations']
        self.assertEqual(len(rows), 1)
        self.assertEqual(self.post('/api/communications/list', {'job_id': 2})['conversations'], [])
        cid = rows[0]['id']
        detail = self.post('/api/communications/detail', {'id': cid})
        self.assertEqual(detail['conversation']['id'], cid)
        self.assertEqual(len(detail['messages']), 1)
        mid = detail['messages'][0]['id']
        raw = '合成简历\n工作经历\n2020-2026 合成公司，软件开发。'.encode('utf-8')
        payload = {'conversation_id': cid, 'message_id': mid, 'name': 'resume.txt',
                   'content': base64.b64encode(raw).decode('ascii')}
        imported = self.post('/api/communications/attachment', payload)['attachment']
        again = self.post('/api/communications/attachment', payload)['attachment']
        self.assertEqual(imported['id'], again['id'])
        self.post('/api/communications/import', snapshot)
        with urllib.request.urlopen(self.base + f"/api/communications/attachments/{imported['id']}") as response:
            self.assertEqual(response.read(), raw)
            self.assertIn('attachment;', response.headers['Content-Disposition'])
            self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
        changed = {**payload, 'content': base64.b64encode(b'Different file').decode('ascii')}
        self.post('/api/communications/attachment', changed, 400)
        self.post('/api/communications/attachment', {**payload, 'conversation_id': cid + 999}, 400)
        self.post('/api/communications/attachment', {**payload, 'content': '!invalid!'}, 400)
        with self.assertRaises(urllib.error.HTTPError) as missing:
            urllib.request.urlopen(self.base + '/api/communications/attachments/999999')
        self.assertEqual(missing.exception.code, 404)

    def test_history_does_not_accept_partial_invalid_batch(self):
        snapshot = self.snapshot()
        snapshot['messages'].append({**snapshot['messages'][0], 'message_id': 'message-10',
                                     'friend_id': 'not-in-batch'})
        self.post('/api/communications/import', snapshot, 400)
        self.assertEqual(self.post('/api/communications/list', {})['conversations'], [])

    def test_platform_identity_links_received_file_to_candidate_archive(self):
        with server.connect() as db:
            candidate_id = db.execute('''INSERT INTO candidates(
                job_id,name,resume,phone,email,link,created) VALUES(?,?,?,?,?,?,?)''',
                (1, 'Synthetic person', 'Synthetic resume', '', '',
                 'https://www.zhipin.com/web/geek/resume?encryptGeekId=geek-target', server.now())).lastrowid
            other_id = db.execute('''INSERT INTO candidates(
                job_id,name,resume,phone,email,link,created) VALUES(?,?,?,?,?,?,?)''',
                (2, 'Synthetic person', 'Another resume', '', '', '', server.now())).lastrowid
        snapshot = self.snapshot()
        snapshot['conversations'][0]['platform_geek_id'] = 'geek-target'
        self.post('/api/communications/import', snapshot)
        row = self.post('/api/communications/list', {})['conversations'][0]
        self.assertEqual(row['candidate_id'], candidate_id)
        detail = self.post('/api/communications/detail', {'id': row['id']})
        message = detail['messages'][0]
        self.post('/api/communications/bind', {'conversation_id': row['id'], 'candidate_id': other_id}, 400)
        self.post('/api/communications/attachment', {
            'conversation_id': row['id'], 'message_id': message['id'], 'name': 'resume.txt',
            'content': base64.b64encode(b'Synthetic candidate original resume.').decode('ascii')})
        archive = self.post('/api/communications/candidate', {'candidate_id': candidate_id})
        self.assertEqual(len(archive['conversations']), 1)
        self.assertEqual(len(archive['attachments']), 1)
        self.assertEqual(archive['attachments'][0]['conversation_id'], row['id'])
        other = self.post('/api/communications/candidate', {'candidate_id': other_id})
        self.assertEqual(other['attachments'], [])


if __name__ == '__main__':
    unittest.main()
