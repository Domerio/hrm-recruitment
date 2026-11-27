"""Local conversation snapshots and files received in candidate conversations."""

import hashlib
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit


MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
MAX_CONVERSATIONS = 500
MAX_MESSAGES = 2_000
ATTACHMENT_SUFFIXES = {'.pdf', '.docx', '.txt'}


def _now():
    return datetime.now(timezone.utc).isoformat()


def ensure_communication_tables(db):
    """Create additive tables without committing the caller's transaction."""
    db.execute('''CREATE TABLE IF NOT EXISTS communication_conversations(
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        account_name TEXT NOT NULL,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        friend_id TEXT NOT NULL,
        candidate_name TEXT NOT NULL,
        candidate_id INTEGER REFERENCES candidates(id),
        platform_geek_id TEXT NOT NULL DEFAULT '',
        platform_job_id TEXT NOT NULL DEFAULT '',
        last_message TEXT NOT NULL DEFAULT '',
        last_at TEXT NOT NULL DEFAULT '',
        unread_count INTEGER DEFAULT NULL CHECK(unread_count >= 0),
        updated TEXT NOT NULL,
        UNIQUE(account_id, job_id, friend_id))''')
    db.execute('''CREATE TABLE IF NOT EXISTS communication_messages(
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES communication_conversations(id),
        platform_message_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing','system')),
        text TEXT NOT NULL DEFAULT '',
        sent_at TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL CHECK(kind IN ('text','attachment','system')),
        attachment_name TEXT NOT NULL DEFAULT '',
        attachment_status TEXT NOT NULL DEFAULT ''
            CHECK(attachment_status IN ('','received','pending','expired')),
        attachment_received INTEGER NOT NULL DEFAULT 0 CHECK(attachment_received IN (0,1)),
        created TEXT NOT NULL,
        UNIQUE(conversation_id, platform_message_id))''')
    db.execute('''CREATE TABLE IF NOT EXISTS communication_attachments(
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL UNIQUE REFERENCES communication_messages(id),
        name TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size > 0),
        sha256 TEXT NOT NULL,
        content BLOB NOT NULL,
        text TEXT NOT NULL,
        imported TEXT NOT NULL)''')
    columns = {row['name'] for row in db.execute('PRAGMA table_info(communication_conversations)')}
    if 'candidate_id' not in columns:
        db.execute('ALTER TABLE communication_conversations ADD COLUMN candidate_id INTEGER REFERENCES candidates(id)')
    if 'platform_geek_id' not in columns:
        db.execute("ALTER TABLE communication_conversations ADD COLUMN platform_geek_id TEXT NOT NULL DEFAULT ''")
    db.execute('''CREATE INDEX IF NOT EXISTS communication_messages_conversation
        ON communication_messages(conversation_id, sent_at, id)''')
    db.execute('''CREATE INDEX IF NOT EXISTS communication_conversations_candidate
        ON communication_conversations(candidate_id)''')
    from chat_resumes import ensure_chat_resume_tables
    ensure_chat_resume_tables(db)


def _text(value, label, limit, *, required=False):
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise ValueError(f'{label}必须为文字')
    value = value.strip()
    if required and not value:
        raise ValueError(f'缺少{label}')
    if len(value) > limit or '\x00' in value:
        raise ValueError(f'{label}过长或包含无效字符')
    return value


def _identity(value, label):
    # Platform numeric IDs also arrive as JSON numbers. They are never guessed
    # from a display name, message body, or a candidate's resume text.
    if type(value) is int:
        value = str(value)
    value = _text(value, label, 160, required=True)
    if any(character.isspace() or ord(character) < 32 for character in value):
        raise ValueError(f'{label}包含无效字符')
    if value.isascii() and value.isdigit() and int(value) <= 0:
        raise ValueError(f'{label}无效')
    if value.startswith(('http://', 'https://')):
        raise ValueError(f'{label}必须为平台标识，不能使用网址')
    return value


def _positive_id(value, label):
    if isinstance(value, str) and value.isascii() and value.isdigit():
        value = int(value)
    if type(value) is not int or value <= 0 or value > 2**63 - 1:
        raise ValueError(f'{label}无效')
    return value


def _time_value(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, OverflowError):
        return None


def _summary_values(prior, conversation):
    """Keep a summary and its timestamp together; unranked snapshots cannot
    replace a dated summary or make an older message look newer.
    """
    incoming = conversation['last_message'], conversation['last_at']
    if not prior or not (prior['last_message'] or prior['last_at']):
        return incoming
    current = prior['last_message'], prior['last_at']
    incoming_time = _time_value(incoming[1])
    current_time = _time_value(current[1])
    if incoming_time is None or (current_time is not None and incoming_time < current_time):
        return current
    return incoming


def _rows(value, label, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f'{label}必须为列表，最多 {maximum} 条')
    if any(not isinstance(row, dict) for row in value):
        raise ValueError(f'{label}包含无效记录')
    return value


def _candidate_platform_ids(link):
    """Extract only explicit candidate IDs, never session or security tokens.

    A plain uid parameter has different meanings across BOSS pages and is not
    sufficient evidence for candidate matching.
    """
    if not isinstance(link, str):
        return set()
    try:
        url = urlsplit(link)
        if (url.scheme != 'https' or url.hostname not in ('www.zhipin.com', 'zhipin.com')
                or url.username or url.password or url.port not in (None, 443)):
            return set()
        values = parse_qs(url.query)
    except ValueError:
        return set()
    return {value for key in ('encryptGeekId', 'encryptUid') for value in values.get(key, [])
            if value and len(value) <= 160 and not any(character.isspace() for character in value)}


def _candidate_known_ids(db, candidate):
    ids = _candidate_platform_ids(candidate['link'])
    ids.update(row['platform_geek_id'] for row in db.execute('''SELECT v.platform_geek_id
        FROM communication_conversations v JOIN candidates c ON c.id=v.candidate_id AND c.job_id=v.job_id
        WHERE v.candidate_id=? AND v.platform_geek_id<>'' ''', (candidate['id'],)))
    return ids


def _matching_candidates(db, job_id, platform_geek_id):
    if not platform_geek_id:
        return []
    return [row for row in db.execute('SELECT id,link FROM candidates WHERE job_id=? AND deleted=0', (job_id,))
            if _candidate_known_ids(db, row) == {platform_geek_id}]


def _association(db, conversation):
    """Derive the currently valid binding without exposing a candidate's URL."""
    candidate_id = conversation['candidate_id']
    geek_id = conversation['platform_geek_id']
    if candidate_id is not None:
        candidate = db.execute('SELECT id,job_id,link,deleted FROM candidates WHERE id=?', (candidate_id,)).fetchone()
        if not candidate or candidate['deleted'] or candidate['job_id'] != conversation['job_id']:
            return {'candidate_id': None, 'candidate_binding_status': 'unmatched',
                    'candidate_binding_reason': '原关联档案已删除或岗位已改变，请重新确认关联'}
        ids = _candidate_known_ids(db, candidate)
        if geek_id and ids and ids != {geek_id}:
            return {'candidate_id': None, 'candidate_binding_status': 'conflict',
                    'candidate_binding_reason': '会话与候选人档案的平台标识不一致，请重新确认关联'}
        return {'candidate_id': candidate_id, 'candidate_binding_status': 'linked', 'candidate_binding_reason': ''}
    matches = _matching_candidates(db, conversation['job_id'], geek_id)
    if len(matches) > 1:
        return {'candidate_id': None, 'candidate_binding_status': 'ambiguous',
                'candidate_binding_reason': '同岗位有多份相同平台标识的候选人档案，请确认关联'}
    return {'candidate_id': None, 'candidate_binding_status': 'unmatched',
            'candidate_binding_reason': '尚未找到唯一的平台标识匹配，请确认候选人档案'}


def _conversation_record(db, row):
    result = dict(row)
    result.update(_association(db, row))
    return result


def _auto_bind_candidate(db, conversation_id):
    conversation = db.execute('SELECT * FROM communication_conversations WHERE id=?', (conversation_id,)).fetchone()
    if conversation['candidate_id'] is not None:
        return
    matches = _matching_candidates(db, conversation['job_id'], conversation['platform_geek_id'])
    if len(matches) == 1:
        db.execute('''UPDATE communication_conversations SET candidate_id=?
            WHERE id=? AND candidate_id IS NULL''', (matches[0]['id'], conversation_id))


def _validate_snapshot(db, data):
    if not isinstance(data, dict):
        raise ValueError('沟通数据必须为对象')
    job_id = _positive_id(data.get('job_id'), '岗位')
    if not db.execute('SELECT 1 FROM jobs WHERE id=?', (job_id,)).fetchone():
        raise ValueError('岗位不存在')
    account_id = _identity(data.get('account_id'), '招聘账号标识')
    account_name = _text(data.get('account_name'), '招聘账号名称', 120)
    conversations = []
    friend_ids = set()
    for source in _rows(data.get('conversations'), '会话', MAX_CONVERSATIONS):
        friend_id = _identity(source.get('friend_id'), '候选人会话标识')
        if friend_id in friend_ids:
            raise ValueError('同一批数据包含重复的会话标识')
        unread = source.get('unread_count')
        if unread is not None and (type(unread) is not int or unread < 0 or unread > 1_000_000):
            raise ValueError('未读消息数量无效')
        platform_job_id = _text(source.get('platform_job_id'), '平台岗位标识', 160)
        platform_geek_id = _text(source.get('platform_geek_id'), '候选人平台标识', 160)
        if platform_geek_id:
            platform_geek_id = _identity(platform_geek_id, '候选人平台标识')
        prior = db.execute('''SELECT platform_job_id,platform_geek_id FROM communication_conversations
            WHERE account_id=? AND job_id=? AND friend_id=?''', (account_id, job_id, friend_id)).fetchone()
        if prior and prior['platform_job_id'] and platform_job_id and prior['platform_job_id'] != platform_job_id:
            raise ValueError('同一会话的平台岗位不一致，请按平台岗位分别绑定本地岗位')
        if prior and prior['platform_geek_id'] and platform_geek_id and prior['platform_geek_id'] != platform_geek_id:
            raise ValueError('同一会话的候选人平台标识不一致，请核对来源，原关联已保留')
        friend_ids.add(friend_id)
        conversations.append({
            'friend_id': friend_id,
            'candidate_name': _text(source.get('candidate_name'), '候选人名称', 120, required=True),
            'platform_job_id': platform_job_id,
            'platform_geek_id': platform_geek_id,
            'last_message': _text(source.get('last_message'), '最近消息', 4_000),
            'last_at': _text(source.get('last_at'), '最近消息时间', 100),
            'unread_count': unread,
        })
    messages = []
    message_keys = set()
    for source in _rows(data.get('messages', []), '消息', MAX_MESSAGES):
        friend_id = _identity(source.get('friend_id'), '消息所属会话标识')
        if friend_id not in friend_ids:
            raise ValueError('消息必须关联到本次导入的会话')
        message_id = _identity(source.get('message_id'), '平台消息标识')
        key = friend_id, message_id
        if key in message_keys:
            raise ValueError('同一批数据包含重复的平台消息标识')
        message_keys.add(key)
        direction = source.get('direction')
        kind = source.get('kind', 'text')
        if direction not in ('incoming', 'outgoing', 'system'):
            raise ValueError('消息方向无效')
        if kind not in ('text', 'attachment', 'system'):
            raise ValueError('消息类型无效')
        status = source.get('attachment_status', '')
        name = _text(source.get('attachment_name'), '附件名称', 240)
        if kind == 'attachment':
            if status not in ('received', 'pending', 'expired') or not name:
                raise ValueError('附件消息缺少名称或有效状态')
        elif status or name:
            raise ValueError('普通消息不能包含附件状态')
        prior = db.execute('''SELECT m.direction,m.kind FROM communication_messages m
            JOIN communication_conversations c ON c.id=m.conversation_id
            WHERE c.account_id=? AND c.job_id=? AND c.friend_id=? AND m.platform_message_id=?''',
            (account_id, job_id, friend_id, message_id)).fetchone()
        if prior and (prior['direction'] != direction or prior['kind'] != kind):
            raise ValueError('已有消息的发送方或类型不一致，请核对会话来源')
        messages.append({
            'friend_id': friend_id, 'message_id': message_id, 'direction': direction,
            'kind': kind, 'attachment_name': name, 'attachment_status': status,
            'text': _text(source.get('text'), '消息正文', 30_000),
            'sent_at': _text(source.get('sent_at'), '消息时间', 100),
        })
    return job_id, account_id, account_name, conversations, messages


def import_snapshot(db, data):
    """Upsert one validated snapshot while preserving previously saved history."""
    job_id, account_id, account_name, conversations, messages = _validate_snapshot(db, data)
    updated = _now()
    ids = {}
    for conversation in conversations:
        prior = db.execute('''SELECT last_message,last_at FROM communication_conversations
            WHERE account_id=? AND job_id=? AND friend_id=?''',
            (account_id, job_id, conversation['friend_id'])).fetchone()
        last_message, last_at = _summary_values(prior, conversation)
        cursor = db.execute('''INSERT INTO communication_conversations(
            account_id,account_name,job_id,friend_id,candidate_name,platform_job_id,platform_geek_id,
            last_message,last_at,unread_count,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(account_id,job_id,friend_id) DO UPDATE SET
            account_name=CASE WHEN excluded.account_name='' THEN account_name ELSE excluded.account_name END,
            candidate_name=excluded.candidate_name,
            platform_job_id=CASE WHEN excluded.platform_job_id='' THEN platform_job_id ELSE excluded.platform_job_id END,
            platform_geek_id=CASE WHEN excluded.platform_geek_id='' THEN platform_geek_id ELSE excluded.platform_geek_id END,
            last_message=excluded.last_message,last_at=excluded.last_at,
            unread_count=COALESCE(excluded.unread_count,unread_count),updated=excluded.updated
            WHERE (platform_job_id='' OR excluded.platform_job_id='' OR platform_job_id=excluded.platform_job_id)
            AND (platform_geek_id='' OR excluded.platform_geek_id='' OR platform_geek_id=excluded.platform_geek_id)''',
            (account_id, account_name, job_id, conversation['friend_id'], conversation['candidate_name'],
             conversation['platform_job_id'], conversation['platform_geek_id'], last_message, last_at,
             conversation['unread_count'], updated))
        if not cursor.rowcount:
            raise ValueError('同一会话的平台岗位或候选人标识不一致，请核对来源')
        ids[conversation['friend_id']] = db.execute('''SELECT id FROM communication_conversations
            WHERE account_id=? AND job_id=? AND friend_id=?''',
            (account_id, job_id, conversation['friend_id'])).fetchone()['id']
        _auto_bind_candidate(db, ids[conversation['friend_id']])
    added_messages = 0
    for message in messages:
        conversation_id = ids[message['friend_id']]
        added_messages += not bool(db.execute('''SELECT 1 FROM communication_messages
            WHERE conversation_id=? AND platform_message_id=?''',
            (conversation_id, message['message_id'])).fetchone())
        cursor = db.execute('''INSERT INTO communication_messages(
            conversation_id,platform_message_id,direction,text,sent_at,kind,
            attachment_name,attachment_status,attachment_received,created) VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(conversation_id,platform_message_id) DO UPDATE SET
            text=excluded.text,sent_at=CASE WHEN excluded.sent_at='' THEN sent_at ELSE excluded.sent_at END,
            attachment_name=excluded.attachment_name,
            attachment_status=CASE WHEN excluded.attachment_status='pending' AND attachment_received=1
                THEN attachment_status ELSE excluded.attachment_status END,
            attachment_received=MAX(attachment_received,excluded.attachment_received)
            WHERE direction=excluded.direction AND kind=excluded.kind''',
            (conversation_id, message['message_id'], message['direction'], message['text'], message['sent_at'],
             message['kind'], message['attachment_name'], message['attachment_status'],
             int(message['attachment_status'] == 'received'), updated))
        if not cursor.rowcount:
            raise ValueError('已有消息的发送方或类型不一致，请核对会话来源')
    return {'ok': True, 'conversation_count': len(conversations), 'message_count': len(messages),
            'new_messages': added_messages, 'conversation_ids': list(ids.values())}


def list_conversations(db, job_id=None):
    params = ()
    where = ''
    if job_id is not None:
        params = (_positive_id(job_id, '岗位'),)
        where = 'WHERE c.job_id=?'
    return [_conversation_record(db, row) for row in db.execute(f'''SELECT c.*,
        (SELECT COUNT(*) FROM communication_messages m WHERE m.conversation_id=c.id) AS message_count
        FROM communication_conversations c {where} ORDER BY c.updated DESC,c.id DESC''', params)]


def _attachment_record(row, *, with_content=False):
    record = {key: row[key] for key in ('id', 'name', 'size', 'sha256', 'text', 'imported')}
    if with_content:
        record['content'] = row['content']
    return record


def get_conversation(db, conversation_id):
    conversation_id = _positive_id(conversation_id, '会话')
    row = db.execute('''SELECT c.*,
        (SELECT COUNT(*) FROM communication_messages m WHERE m.conversation_id=c.id) AS message_count
        FROM communication_conversations c WHERE c.id=?''', (conversation_id,)).fetchone()
    if not row:
        raise ValueError('会话不存在')
    result = _conversation_record(db, row)
    result['messages'] = []
    for row in db.execute('''SELECT id,platform_message_id AS message_id,direction,text,sent_at,
        kind,attachment_name,attachment_status,attachment_received,created FROM communication_messages
        WHERE conversation_id=? ORDER BY sent_at,id''', (conversation_id,)):
        message = dict(row)
        message['attachment_received'] = bool(message['attachment_received'])
        attachment = db.execute('''SELECT id,name,size,sha256,text,imported
            FROM communication_attachments WHERE message_id=?''', (row['id'],)).fetchone()
        message['attachment'] = _attachment_record(attachment) if attachment else None
        result['messages'].append(message)
    # Numeric platform message IDs give a stable chronological order even when
    # an older page of history is imported after a newer page. Non-numeric IDs
    # retain the recorded timestamp/insertion order instead of guessing a date.
    if result['messages'] and all(message['message_id'].isascii() and message['message_id'].isdigit()
                                  for message in result['messages']):
        result['messages'].sort(key=lambda message: int(message['message_id']))
    from chat_resumes import list_resume_sources
    result['resumes'] = list_resume_sources(db, conversation_id)
    return result


def bind_candidate(db, conversation_id, candidate_id):
    """Persist an explicit same-job binding after checking available stable IDs."""
    conversation_id = _positive_id(conversation_id, '会话')
    candidate_id = _positive_id(candidate_id, '候选人')
    conversation = db.execute('SELECT * FROM communication_conversations WHERE id=?', (conversation_id,)).fetchone()
    candidate = db.execute('SELECT id,job_id,link,deleted FROM candidates WHERE id=?', (candidate_id,)).fetchone()
    if not conversation:
        raise ValueError('会话不存在')
    if not candidate or candidate['deleted']:
        raise ValueError('候选人不存在或已删除')
    if candidate['job_id'] != conversation['job_id']:
        raise ValueError('只能关联同一岗位的候选人档案')
    ids = _candidate_known_ids(db, candidate)
    if len(ids) > 1 or (ids and conversation['platform_geek_id'] and ids != {conversation['platform_geek_id']}):
        raise ValueError('会话与候选人档案的平台标识不一致，请核对后再关联')
    db.execute('UPDATE communication_conversations SET candidate_id=? WHERE id=?', (candidate_id, conversation_id))
    return get_conversation(db, conversation_id)


def candidate_attachments(db, candidate_id):
    """Return originals from currently valid bindings to one active candidate."""
    candidate_id = _positive_id(candidate_id, '候选人')
    candidate = db.execute('SELECT job_id,deleted FROM candidates WHERE id=?', (candidate_id,)).fetchone()
    if not candidate or candidate['deleted']:
        raise ValueError('候选人不存在或已删除')
    conversations = []
    attachments = []
    resumes = []
    for row in db.execute('''SELECT c.*,
        (SELECT COUNT(*) FROM communication_messages m WHERE m.conversation_id=c.id) AS message_count
        FROM communication_conversations c WHERE c.candidate_id=? AND c.job_id=?
        ORDER BY c.updated DESC,c.id DESC''', (candidate_id, candidate['job_id'])):
        conversation = _conversation_record(db, row)
        if conversation['candidate_id'] != candidate_id:
            continue
        conversations.append(conversation)
        from chat_resumes import list_resume_sources
        resumes.extend(list_resume_sources(db, row['id']))
        for attachment in db.execute('''SELECT a.id,a.name,a.size,a.text,a.sha256,a.imported,
            m.conversation_id,m.id AS message_id FROM communication_attachments a
            JOIN communication_messages m ON m.id=a.message_id
            WHERE m.conversation_id=? AND m.direction='incoming' AND m.kind='attachment'
            AND m.attachment_received=1 ORDER BY a.imported DESC,a.id DESC''', (row['id'],)):
            attachments.append({**dict(attachment), 'account_name': row['account_name'], 'friend_id': row['friend_id']})
    return {'conversations': conversations, 'attachments': attachments, 'resumes':resumes}


def _filename(name):
    name = _text(name, '附件文件名', 500, required=True).replace('\\', '/').rsplit('/', 1)[-1]
    if not name or name in ('.', '..') or len(name) > 240 or any(ord(c) < 32 for c in name):
        raise ValueError('附件文件名无效')
    suffix = '.' + name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    if suffix not in ATTACHMENT_SUFFIXES:
        raise ValueError('附件仅支持 PDF、DOCX 或 UTF-8 TXT')
    return name, suffix


def _file_content(raw, suffix):
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_ATTACHMENT_BYTES:
        raise ValueError('附件须在 1 字节至 5 MB 之间')
    if suffix == '.pdf' and not raw.startswith(b'%PDF-'):
        raise ValueError('PDF 文件格式无效')
    if suffix == '.docx' and not raw.startswith(b'PK\x03\x04'):
        raise ValueError('DOCX 文件格式无效')
    if suffix == '.txt':
        try:
            decoded = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise ValueError('TXT 文件必须使用 UTF-8 编码') from None
        if '\x00' in decoded:
            raise ValueError('TXT 文件包含无效字符')


def import_attachment(db, conversation_id, message_id, name, raw, extract_text):
    """Attach an uploaded local original to an already received incoming card.

    message_id is the local messages[].id, not the platform message identifier.
    Existing downloads remain available if the platform later expires its card.
    """
    conversation_id = _positive_id(conversation_id, '会话')
    message_id = _positive_id(message_id, '消息')
    message = db.execute('''SELECT direction,kind,attachment_status FROM communication_messages
        WHERE id=? AND conversation_id=?''', (message_id, conversation_id)).fetchone()
    if not message or message['direction'] != 'incoming' or message['kind'] != 'attachment':
        raise ValueError('附件必须关联到该会话中候选人发送的附件消息')
    if message['attachment_status'] != 'received':
        raise ValueError('仅可导入已收到且未过期的附件，索取中或过期附件无法导入')
    name, suffix = _filename(name)
    _file_content(raw, suffix)
    fingerprint = hashlib.sha256(raw).hexdigest()
    prior = db.execute('SELECT * FROM communication_attachments WHERE message_id=?', (message_id,)).fetchone()
    if prior:
        if prior['sha256'] != fingerprint:
            raise ValueError('该消息已导入不同文件，请核对附件；现有文件已保留')
        return {**_attachment_record(prior), 'duplicate': True}
    text = extract_text(name, raw)
    if not isinstance(text, str) or not text.strip():
        raise ValueError('附件中未读取到文字')
    if len(text) > 300_000 or '\x00' in text:
        raise ValueError('附件解析正文过长或包含无效字符')
    cursor = db.execute('''INSERT INTO communication_attachments(
        message_id,name,size,sha256,content,text,imported) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(message_id) DO NOTHING''',
        (message_id, name, len(raw), fingerprint, raw, text, _now()))
    stored = db.execute('SELECT * FROM communication_attachments WHERE message_id=?', (message_id,)).fetchone()
    if stored['sha256'] != fingerprint:
        raise ValueError('该消息已导入不同文件，请核对附件；现有文件已保留')
    return {**_attachment_record(stored), 'duplicate': not bool(cursor.rowcount)}


def get_attachment(db, attachment_id):
    attachment_id = _positive_id(attachment_id, '附件')
    # Every stored file was admitted while the incoming card was received.
    # A later platform expiry must not revoke an original already saved locally.
    row = db.execute('''SELECT a.* FROM communication_attachments a
        JOIN communication_messages m ON m.id=a.message_id
        JOIN communication_conversations c ON c.id=m.conversation_id
        WHERE a.id=? AND m.direction='incoming' AND m.kind='attachment'
        AND m.attachment_received=1''', (attachment_id,)).fetchone()
    if not row:
        raise ValueError('附件不存在')
    return _attachment_record(row, with_content=True)
