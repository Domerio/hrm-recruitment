"""Complete resume versions captured from an identified candidate conversation."""
import hashlib
import json
from communications import _positive_id, _text, _now, _association, _auto_bind_candidate


def ensure_chat_resume_tables(db):
    db.execute('SAVEPOINT chat_resume_schema')
    try:
        db.execute('''CREATE TABLE IF NOT EXISTS communication_resumes(
            id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL REFERENCES communication_conversations(id),
            source_kind TEXT NOT NULL CHECK(source_kind IN ('online','attachment')),source_key TEXT NOT NULL,
            attachment_id INTEGER REFERENCES communication_attachments(id),name TEXT NOT NULL,
            resume TEXT NOT NULL,resume_html TEXT NOT NULL DEFAULT '',capture_json TEXT NOT NULL,
            sha256 TEXT NOT NULL,evaluation_json TEXT NOT NULL DEFAULT '',
            evaluation_status TEXT NOT NULL DEFAULT 'not_requested'
                CHECK(evaluation_status IN ('not_requested','failed','complete')),
            error TEXT NOT NULL DEFAULT '',evaluation_saved_to_candidate INTEGER NOT NULL DEFAULT 0,
            candidate_evaluation_id INTEGER REFERENCES evaluations(id),created TEXT NOT NULL,updated TEXT NOT NULL,
            UNIQUE(conversation_id,source_kind,source_key,sha256))''')
        db.execute('''CREATE INDEX IF NOT EXISTS communication_resumes_conversation
            ON communication_resumes(conversation_id,id)''')
    except BaseException:
        db.execute('ROLLBACK TO SAVEPOINT chat_resume_schema')
        db.execute('RELEASE SAVEPOINT chat_resume_schema')
        raise
    else:
        db.execute('RELEASE SAVEPOINT chat_resume_schema')


def source_record(db, row):
    record = dict(row)
    record['capture'] = json.loads(record.pop('capture_json'))
    encoded = record.pop('evaluation_json')
    record['evaluation'] = json.loads(encoded) if encoded else None
    record['ai_pending'] = record['evaluation_status'] != 'complete'
    record['evaluation_saved_to_candidate'] = bool(record['evaluation_saved_to_candidate'])
    conversation = db.execute('SELECT * FROM communication_conversations WHERE id=?',
        (record['conversation_id'],)).fetchone()
    association = _association(db, conversation)
    record['candidate_id'] = association['candidate_id']
    record['binding_warning'] = association['candidate_binding_reason']
    if record['candidate_evaluation_id'] is not None:
        evaluated = db.execute('SELECT candidate_id FROM evaluations WHERE id=?',
            (record['candidate_evaluation_id'],)).fetchone()
        if not evaluated or evaluated['candidate_id'] != record['candidate_id']:
            record['evaluation_saved_to_candidate'] = False
            record['candidate_evaluation_id'] = None
    record['evaluation_note'] = ('本次评估保存在沟通简历来源中，候选人主简历及人工维护资料保持原样'
        if record['evaluation'] is not None and not record['evaluation_saved_to_candidate'] else '')
    return record


def list_resume_sources(db, conversation_id):
    return [source_record(db, row) for row in db.execute('''SELECT * FROM communication_resumes
        WHERE conversation_id=? ORDER BY id DESC''', (conversation_id,))]


def get_resume_source(db, conversation_id, resume_id):
    conversation_id = _positive_id(conversation_id, '会话')
    resume_id = _positive_id(resume_id, '简历来源')
    row = db.execute('SELECT * FROM communication_resumes WHERE id=? AND conversation_id=?',
        (resume_id, conversation_id)).fetchone()
    if not row:
        raise ValueError('该会话中没有这份简历来源')
    return source_record(db, row)


def _bind_source_candidate(db, conversation, source, create_candidate, normalize_name):
    _auto_bind_candidate(db, conversation['id'])
    conversation = db.execute('SELECT * FROM communication_conversations WHERE id=?',
        (conversation['id'],)).fetchone()
    association = _association(db, conversation)
    if association['candidate_id'] is not None:
        return association['candidate_id']
    if conversation['candidate_id'] is not None or association['candidate_binding_status'] in ('conflict','ambiguous'):
        return None
    if not conversation['platform_geek_id']:
        return None
    # A same-name archive is never merged on resume similarity. A human can
    # explicitly bind an older archive; stable IDs can still bind automatically.
    same_name = [row for row in db.execute('SELECT * FROM candidates WHERE job_id=?',
        (conversation['job_id'],)) if normalize_name(row['name']) == normalize_name(source['name'])]
    if same_name:
        return None
    cid = create_candidate(db, conversation['job_id'], source)
    db.execute('UPDATE communication_conversations SET candidate_id=? WHERE id=?', (cid, conversation['id']))
    return cid


def import_resume_source(db, data, validate_online, create_candidate, normalize_name):
    conversation_id = _positive_id(data.get('conversation_id'), '会话')
    conversation = db.execute('SELECT * FROM communication_conversations WHERE id=?', (conversation_id,)).fetchone()
    if not conversation:
        raise ValueError('会话不存在')
    if 'resume_id' in data:
        if any(key in data for key in ('source_kind','attachment_id','candidate')):
            raise ValueError('补评估请求不能同时上传新的简历来源')
        source = get_resume_source(db, conversation_id, data['resume_id'])
        _bind_source_candidate(db, conversation, source, create_candidate, normalize_name)
        return get_resume_source(db, conversation_id, source['id']), True
    kind = data.get('source_kind')
    if kind not in ('online','attachment'):
        raise ValueError('简历来源类型无效')
    if kind == 'online':
        source = validate_online(data.get('candidate'))
        if normalize_name(source['name']) != normalize_name(conversation['candidate_name']):
            raise ValueError('在线简历姓名与当前会话不一致，请重新核对候选人')
        source_key, attachment_id = 'online', None
    else:
        attachment_id = _positive_id(data.get('attachment_id'), '附件')
        attachment = db.execute('''SELECT a.text,m.direction,m.kind,m.attachment_status,m.attachment_received
            FROM communication_attachments a JOIN communication_messages m ON m.id=a.message_id
            WHERE a.id=? AND m.conversation_id=?''', (attachment_id, conversation_id)).fetchone()
        if (not attachment or attachment['direction'] != 'incoming' or attachment['kind'] != 'attachment'
                or not attachment['attachment_received'] or attachment['attachment_status'] != 'received'):
            raise ValueError('只能从本会话已收到且未过期的附件导入简历')
        text = _text(attachment['text'], '附件简历正文', 300_000, required=True)
        if len(text) < 40:
            raise ValueError('附件正文过短，请检查是否为完整简历')
        sections = [section for section in ('个人优势','个人简介','工作经历','项目经历','教育经历','专业技能')
                    if section in text]
        source = {'name':conversation['candidate_name'],'resume':text,'resume_html':'',
            'capture':{'status':'visible_complete','sections':sections,'warnings':[]}}
        source_key = str(attachment_id)
    fingerprint = hashlib.sha256(source['resume'].encode('utf-8')).hexdigest()
    stamp = _now()
    cursor = db.execute('''INSERT INTO communication_resumes(conversation_id,source_kind,source_key,
        attachment_id,name,resume,resume_html,capture_json,sha256,created,updated)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id,source_kind,source_key,sha256) DO NOTHING''',
        (conversation_id,kind,source_key,attachment_id,source['name'],source['resume'],source['resume_html'],
         json.dumps(source['capture'],ensure_ascii=False),fingerprint,stamp,stamp))
    duplicate = not bool(cursor.rowcount)
    row = db.execute('''SELECT * FROM communication_resumes
        WHERE conversation_id=? AND source_kind=? AND source_key=? AND sha256=?''',
        (conversation_id,kind,source_key,fingerprint)).fetchone()
    _bind_source_candidate(db, conversation, source, create_candidate, normalize_name)
    return source_record(db, row), duplicate


def complete_source_evaluation(db, source_id, evaluation=None, error='', evaluation_id=None):
    db.execute('''UPDATE communication_resumes SET evaluation_json=?,evaluation_status=?,error=?,
        evaluation_saved_to_candidate=?,candidate_evaluation_id=?,updated=? WHERE id=?''',
        (json.dumps(evaluation,ensure_ascii=False) if evaluation is not None else '',
         'complete' if evaluation is not None else 'failed',error[:2000],int(evaluation_id is not None),
         evaluation_id,_now(),source_id))
