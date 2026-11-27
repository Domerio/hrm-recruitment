"""Bounded professional evidence for finding an archived candidate in BOSS favorites."""
from datetime import date
import hashlib
import json
import re
import unicodedata

import candidate_profile as profiles
from experience_timeline import build_experience_timeline
from resume_format import DATE_RANGE, resume_entry

MAX_EVIDENCE = 12
MAX_ANCHORS = 32
_SCHOOL = re.compile(r'^([^，,。；;:：!?！？\s·•|｜]{2,80}?(?:大学|学院|学校|中学|技校|职校|研究院|研究所))(?=$|[\s·•|｜])')
_CONTACT = re.compile(r'@|https?://|(?:\+?86[- ]?)?1[3-9][0-9]{9}|(?:电话|手机|微信|邮箱)\s*[:：]', re.I)


def _safe(value, maximum=200):
    if not isinstance(value, str):
        return ''
    text = unicodedata.normalize('NFKC', value).strip()
    return text if 2 <= len(text) <= maximum and not _CONTACT.search(text) else ''


def _period(value):
    matches = list(DATE_RANGE.finditer(value))
    return _safe(matches[0].group(), 60) if len(matches) == 1 else ''


def professional_evidence(resume):
    """Read named employers/schools and associated dates, never biography prose."""
    if not isinstance(resume, str):
        return []
    lines, _ = profiles._lines(resume[:30000])
    sections = profiles._section_blocks(lines)
    evidence, seen = [], set()

    def add(kind, organization, period=''):
        organization = _safe(organization)
        if not organization:
            return
        key = (kind, organization, period)
        if key not in seen and len(evidence) < MAX_EVIDENCE and sum(row['kind'] == kind for row in evidence) < 6:
            seen.add(key)
            evidence.append({'kind': kind, 'organization': organization, 'period': period})

    for entry in build_experience_timeline(lines, date(9999, 12, 31))['entries']:
        fields = profiles._header_fields([(number - 1, lines[number - 1]) for number in entry['title_lines']])
        add('work', fields.get('company', ('', None))[0], _period(lines[entry['date_line'] - 1]))

    for section, start, end in sections:
        if section in profiles._WORK:
            # Undated resumes: only the first explicit employer header is used.
            if not any(row['kind'] == 'work' for row in evidence):
                fields = profiles._header_fields(list(enumerate(lines[start:min(start + 3, end)], start)))
                company = fields.get('company', ('', None))[0]
                period = ''
                if not company and start < end:
                    # Some clear employer headings use a brand rather than a
                    # legal company suffix; require a following role and date.
                    first = re.split(r'[（(]', lines[start], maxsplit=1)[0].strip()
                    following = lines[start + 1:min(start + 5, end)]
                    role = bool(following and (profiles._ROLE.search(following[0]) or following[0] in {'厂务','实习'}))
                    dated = next((value for value in following if DATE_RANGE.fullmatch(value)), '')
                    if (role and dated and 4 <= len(first) <= 80 and not profiles._PROSE.match(first)
                            and not re.search(r'[，,。；;:：!?！？]|(?:岁|性别|婚育|身份证)', first)):
                        company, period = first, _period(dated)
                add('work', company, period)
        elif section in profiles._EDUCATION:
            for index in range(start, end):
                line = lines[index]
                if len(line) > 240 or profiles._PROSE.match(line):
                    continue
                header = DATE_RANGE.sub('', line).strip(' \t·•|｜')
                match = _SCHOOL.match(header)
                if not match:
                    continue
                period = _period(line)
                row = resume_entry(lines, index, section)
                if row:
                    period = _period(row[1])
                elif not period:
                    for next_line in lines[index + 1:min(index + 4, end)]:
                        if _SCHOOL.match(next_line) or profiles._PROSE.match(next_line) or re.search(r'[。；;!?！？]', next_line):
                            break
                        if DATE_RANGE.fullmatch(next_line):
                            period = _period(next_line)
                            break
                add('education', match[1], period)
    return evidence


def target_input_key(row):
    payload = {key: row[key] for key in ('id', 'job_id', 'name', 'resume')}
    payload['boss_chat_uid'] = row['boss_chat_uid'] or ''
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def favorite_target(db, candidate_id):
    if type(candidate_id) is not int or candidate_id <= 0:
        raise ValueError('请选择有效的候选人')
    row = db.execute('''SELECT c.id,c.job_id,c.name,c.resume,j.title AS job_title,s.boss_chat_uid
        FROM candidates c JOIN jobs j ON j.id=c.job_id
        LEFT JOIN candidate_sources s ON s.candidate_id=c.id WHERE c.id=? AND c.deleted=0''',
        (candidate_id,)).fetchone()
    if row is None:
        raise ValueError('候选人不存在或已删除，请刷新工作台')
    evidence = professional_evidence(row['resume'])
    anchors, seen = [], set()
    for number, item in enumerate(evidence):
        kind = 'company' if item['kind'] == 'work' else 'school'
        for anchor_kind, text in [(kind, item['organization']),
                ('work_period' if kind == 'company' else 'education_period', item['period'])]:
            if not text or (anchor_kind, text) in seen or len(anchors) >= MAX_ANCHORS:
                continue
            seen.add((anchor_kind, text))
            anchors.append({'kind': anchor_kind, 'text': text, 'group': str(number)})
    uid = row['boss_chat_uid']
    if not isinstance(uid, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', uid):
        uid = ''
    keys = [r[0] for r in db.execute('''SELECT DISTINCT card_key FROM candidate_card_keys
        WHERE candidate_id=? AND job_id=? ORDER BY card_key LIMIT 200''', (candidate_id, row['job_id']))
        if isinstance(r[0], str) and re.fullmatch(r'[a-f0-9]{64}', r[0])]
    return {'id': row['id'], 'job_id': row['job_id'], 'job_title': row['job_title'], 'name': row['name'],
        'boss_chat_uid': uid, 'platform_geek_id': '', 'card_keys': keys,
        'anchors': anchors, 'evidence': evidence, 'matching_version': 1,
        'input_key': target_input_key(row),
        'bindings': [dict(record) for record in db.execute('''SELECT account_uid,platform_geek_id,boss_chat_uid,updated
            FROM candidate_favorite_bindings WHERE candidate_id=? AND input_key=? ORDER BY updated DESC LIMIT 100''',
            (candidate_id, target_input_key(row)))]}



def ensure_favorite_tables(db):
    db.execute("""CREATE TABLE IF NOT EXISTS candidate_favorite_bindings(
        candidate_id INTEGER NOT NULL REFERENCES candidates(id),account_uid TEXT NOT NULL,
        platform_geek_id TEXT NOT NULL,boss_chat_uid TEXT NOT NULL DEFAULT '',input_key TEXT NOT NULL,
        updated TEXT NOT NULL,PRIMARY KEY(candidate_id,account_uid))""")


def _uid(value, optional=False):
    if optional and value in (None, ''):
        return ''
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', value):
        raise ValueError('平台账号或候选人标识无效')
    return value


def _name(value):
    return re.sub(r'[\s\u200B-\u200D\uFEFF]+', '', value).translate(str.maketrans('＊﹡∗', '***'))


def save_favorite_binding(db, data, updated):
    """Persist only a detail-verified mapping, never assert friendship or send."""
    target = favorite_target(db, data.get('id'))
    if not isinstance(data.get('input_key'), str) or data['input_key'] != target['input_key']:
        raise ValueError('候选人资料已变化，请从工作台重新开始查找')
    if not isinstance(data.get('name'), str) or _name(data['name']) != _name(target['name']):
        raise ValueError('收藏详情与工作台姓名不一致，未保存定位标识')
    account = _uid(data.get('account_uid'))
    platform = data.get('platform_geek_id')
    if not isinstance(platform, str) or not re.fullmatch(r'[A-Za-z0-9_~.=-]{6,200}', platform):
        raise ValueError('收藏候选人的平台标识无效')
    uid = _uid(data.get('boss_chat_uid'), optional=True)
    if target['boss_chat_uid'] and uid != target['boss_chat_uid']:
        raise ValueError('收藏详情与已保存候选人标识不一致，未保存定位标识')
    previous = db.execute('SELECT * FROM candidate_favorite_bindings WHERE candidate_id=? AND account_uid=?',
        (target['id'], account)).fetchone()
    if previous and (previous['platform_geek_id'] != platform or
            previous['boss_chat_uid'] and uid and previous['boss_chat_uid'] != uid):
        raise ValueError('该账号已有不同的候选人定位标识，请人工核对')
    retained_uid = uid or (previous['boss_chat_uid'] if previous else '')
    db.execute("""INSERT INTO candidate_favorite_bindings VALUES(?,?,?,?,?,?)
        ON CONFLICT(candidate_id,account_uid) DO UPDATE SET boss_chat_uid=excluded.boss_chat_uid,
        input_key=excluded.input_key,updated=excluded.updated""",
        (target['id'],account,platform,retained_uid,target['input_key'],updated))
    return {'ok':True,'id':target['id'],'account_uid':account,'platform_geek_id':platform,
        'boss_chat_uid':retained_uid}
