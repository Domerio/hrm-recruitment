"""Local HRM record maintenance with optimistic versions and separate metadata."""
import json
import re
import unicodedata
from urllib.parse import urlsplit
from evaluation_scoring import normalize_condition
from candidate_profile import extract_candidate_profile_with_sources
from platform_search import normalize_search_conditions, search_conditions_record, save_search_conditions


PROFILE_LIMITS = {'company':200, 'title':200, 'city':100, 'education':200, 'skills':4000, 'wechat':100}
AI_PROFILE_FIELDS = ('company', 'title', 'city', 'education', 'skills')


class RevisionConflict(ValueError):
    pass


def ensure_edit_tables(db):
    db.executescript('''
        CREATE TABLE IF NOT EXISTS job_requirements(job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
            must_have TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS job_priorities(job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
            groups_json TEXT NOT NULL DEFAULT '[]');
        CREATE TABLE IF NOT EXISTS job_search_conditions(job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
            conditions_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS candidate_profiles(candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id),
            company TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
            education TEXT NOT NULL DEFAULT '', skills TEXT NOT NULL DEFAULT '', wechat TEXT NOT NULL DEFAULT '',
            revision INTEGER NOT NULL DEFAULT 1, resume_edited INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS evaluation_inputs(evaluation_id INTEGER PRIMARY KEY REFERENCES evaluations(id) ON DELETE CASCADE,
            fingerprint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS configuration_migrations(name TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS candidate_profile_sources(
            candidate_id INTEGER NOT NULL REFERENCES candidates(id), field TEXT NOT NULL,
            source TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(candidate_id,field));
    ''')
    if 'resume_edited' not in {row['name'] for row in db.execute('PRAGMA table_info(candidate_profiles)')}:
        db.execute('ALTER TABLE candidate_profiles ADD COLUMN resume_edited INTEGER NOT NULL DEFAULT 0')


def text_field(data, key, maximum, required=False):
    value = data.get(key, '')
    if not isinstance(value, str) or len(value) > maximum or required and not value.strip():
        raise ValueError(f'{key} 须为{maximum}字以内的文本' + ('且不能为空' if required else ''))
    return value.strip()


def rule_key(value):
    return normalize_condition(value)


def requirement_lines(value, maximum=50, max_line=500):
    if not isinstance(value, str) or len(value) > 12000:
        raise ValueError('条件须为12000字以内的文本')
    lines, seen = [], set()
    for line in value.splitlines():
        line = line.strip()
        if not line or line.rstrip('：:') in {'必备条件', '必须满足', '一般条件', '筛选条件', '加分条件'}:
            continue
        if len(line) > max_line:
            raise ValueError(f'每条条件不得超过{max_line}字')
        key = rule_key(line)
        if not key:
            raise ValueError('条件不能仅包含编号或列表符号')
        if key not in seen:
            lines.append(line); seen.add(key)
    if len(lines) > maximum:
        raise ValueError(f'最多配置{maximum}条条件')
    return lines


def job_record(db, jid):
    row = db.execute('''SELECT j.*,COALESCE(r.must_have,'') AS must_have,COALESCE(r.revision,0) AS revision
        FROM jobs j LEFT JOIN job_requirements r ON r.job_id=j.id WHERE j.id=?''', (jid,)).fetchone()
    if not row:
        return None
    job = dict(row)
    priorities = db.execute('SELECT groups_json FROM job_priorities WHERE job_id=?', (jid,)).fetchone()
    conditions = requirement_lines(job['criteria'], 100, max_line=12000)+requirement_lines(job['must_have'], 100, max_line=12000)
    job['priority_groups'] = normalize_priority_groups(json.loads(priorities[0]) if priorities else [], conditions)
    # Saving the generated numbered layout does not turn it into a custom layout.
    job['priority_configured'] = bool(priorities) and job['priority_groups'] != default_priority_groups(conditions)
    job['search_conditions'] = search_conditions_record(db, jid)
    return job


def default_priority_groups(conditions):
    unique = {}
    for text in conditions:
        unique.setdefault(normalize_condition(text), text)
    def order(item):
        index, text = item
        match = re.match(r'^\s*(?:([0-9]+)[.、)）](?![0-9])|[（(]([0-9]+)[）)])', unicodedata.normalize('NFKC', text))
        return (0, int(match[1] or match[2]), index) if match else (1, index, index)
    return [[text] for _, text in sorted(enumerate(unique.values()), key=order)]


def normalize_priority_groups(groups, conditions, reconcile=False):
    available = {normalize_condition(text):text for text in conditions}
    if groups is None or groups == []:
        return default_priority_groups(conditions)
    if not isinstance(groups, list) or not reconcile and len(groups) > len(available):
        raise ValueError('优先级组数不能超过本岗位要求数量')
    result, seen = [], set()
    for group in groups:
        if not isinstance(group, list) or not group:
            raise ValueError('每个优先级至少包含一条要求')
        values = []
        for text in group:
            key = normalize_condition(text)
            if reconcile and key not in available:
                continue
            if key not in available or key in seen:
                raise ValueError('优先级包含重复或不属于本岗位的要求')
            values.append(available[key]); seen.add(key)
        if values:
            result.append(values)
    missing = [text for key, text in available.items() if key not in seen]
    if missing and not reconcile:
        raise ValueError('请为本岗位每条要求安排优先级')
    if missing:
        result.extend(default_priority_groups(missing))
    return result


def profile_record(db, cid):
    row = db.execute('SELECT * FROM candidate_profiles WHERE candidate_id=?', (cid,)).fetchone()
    profile = dict(row) if row else {**{field:'' for field in PROFILE_LIMITS}, 'revision':0, 'resume_edited':0}
    profile['profile_sources'] = profile_source_record(db, cid, profile)
    return profile


def profile_source_record(db, cid, profile):
    sources = {row['field']:{'source':row['source'], 'evidence':row['evidence']}
               for row in db.execute('SELECT field,source,evidence FROM candidate_profile_sources WHERE candidate_id=?', (cid,))
               if row['field'] in AI_PROFILE_FIELDS}
    # Existing maintained values predate source tracking and must be preserved.
    for field in AI_PROFILE_FIELDS:
        if field not in sources and profile.get(field):
            sources[field] = {'source':'manual', 'evidence':''}
    return sources


def save_profile_sources(db, cid, sources):
    for field, source in sources.items():
        if field in AI_PROFILE_FIELDS:
            db.execute('''INSERT INTO candidate_profile_sources(candidate_id,field,source,evidence) VALUES(?,?,?,?)
                ON CONFLICT(candidate_id,field) DO UPDATE SET source=excluded.source,evidence=excluded.evidence''',
                (cid, field, source['source'], source.get('evidence', '')))


def profile_field_flags(data, key):
    fields = data.get(key, [])
    if not isinstance(fields, list) or len(fields) > len(AI_PROFILE_FIELDS) or any(field not in AI_PROFILE_FIELDS for field in fields):
        raise ValueError('自动补全或人工维护字段无效')
    return fields


def profile_autofill_values(resume, previous, values=None, auto_fields=(), initial=False, resume_html='', manual_fields=()):
    extracted = extract_candidate_profile_with_sources(resume, resume_html)
    parsed, evidence = extracted['profile'], extracted['profile_sources']
    result = {field:previous.get(field, '') for field in PROFILE_LIMITS}
    if values is not None:
        result['wechat'] = values.get('wechat', result['wechat'])
    sources = dict(previous.get('profile_sources', {}))
    for field in AI_PROFILE_FIELDS:
        before = previous.get(field, '')
        incoming = values.get(field, before) if values is not None else before
        source = sources.get(field, {'source':'manual', 'evidence':''} if before else None)
        # A preview can be stale after another paste. Recompute automatic fields
        # from the saved resume instead of trusting the client value or source.
        preview = field in auto_fields and (initial or not source or source['source'] != 'manual')
        edited = values is not None and (initial and bool(incoming) or not initial and incoming != before)
        if field in manual_fields or edited and not preview:
            result[field] = incoming
            sources[field] = {'source':'manual', 'evidence':''}
        elif source and source['source'] == 'manual':
            result[field] = before
        else:
            result[field] = parsed.get(field, '')[:PROFILE_LIMITS[field]]
            if result[field]:
                sources[field] = {'source':'resume', 'evidence':evidence.get(field, {}).get('evidence', '')[:1000]}
            elif source and source['source'] == 'resume':
                # A newly edited resume can remove previously extracted facts.
                sources[field] = {'source':'resume', 'evidence':''}
    return result, sources


def sync_candidate_profile(db, cid, resume, resume_html=''):
    previous = profile_record(db, cid)
    values, sources = profile_autofill_values(resume, previous, resume_html=resume_html)
    changed = any(values[field] != previous[field] for field in PROFILE_LIMITS)
    sources_changed = sources != previous['profile_sources']
    if changed or sources_changed:
        bump_profile(db, cid, values)
        save_profile_sources(db, cid, sources)
    return changed or sources_changed


def backfill_candidate_profiles(db):
    count = 0
    for row in db.execute('''SELECT c.id,c.resume,COALESCE(f.html,'') AS html FROM candidates c
            LEFT JOIN candidate_resume_formats f ON f.candidate_id=c.id WHERE c.deleted=0''').fetchall():
        count += int(sync_candidate_profile(db, row['id'], row['resume'], row['html']))
    return count


def bump_profile(db, cid, values=None):
    previous = profile_record(db, cid)
    fields = {key:(values or {}).get(key, previous[key]) for key in PROFILE_LIMITS}
    db.execute('''INSERT INTO candidate_profiles(candidate_id,company,title,city,education,skills,wechat,revision)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET company=excluded.company,
        title=excluded.title,city=excluded.city,education=excluded.education,skills=excluded.skills,
        wechat=excluded.wechat,revision=excluded.revision''',
        (cid, *[fields[key] for key in PROFILE_LIMITS], previous['revision']+1))
    return previous['revision']+1


def invalidate_evaluations(db, ids, audit):
    count = 0
    for cid in ids:
        if db.execute('SELECT 1 FROM evaluations WHERE candidate_id=? LIMIT 1', (cid,)).fetchone():
            audit(db, 'evaluate_pending', str(cid)); count += 1
    return count


def job_values(data):
    values = {'title':text_field(data, 'title', 150, True), 'city':text_field(data, 'city', 150),
              'jd':text_field(data, 'jd', 30000, True), 'criteria':text_field(data, 'criteria', 12000, True),
              'must_have':text_field(data, 'must_have', 12000)}
    ordinary = requirement_lines(values['criteria'], 100, max_line=12000)
    if not ordinary:
        raise ValueError('请填写至少一条一般筛选条件')
    if data.get('requirements_mode') == 'selected':
        selected = requirement_lines(values['must_have'], 100, max_line=12000)
        keys = {normalize_condition(text) for text in selected}
        if not keys.issubset({normalize_condition(text) for text in ordinary}):
            raise ValueError('必备条件必须从当前岗位要求中选择')
        mandatory = [text for text in ordinary if normalize_condition(text) in keys]
    elif 'requirements_mode' in data:
        raise ValueError('岗位要求配置模式无效')
    else:
        mandatory = requirement_lines(values['must_have'])
    values['must_have'] = '\n'.join(mandatory)
    values['priority_groups'] = normalize_priority_groups(data.get('priority_groups'), ordinary+mandatory)
    values['search_conditions'] = normalize_search_conditions(data.get('search_conditions', {}))
    return values


def update_job(db, data, audit):
    jid = data.get('id')
    if type(jid) is not int or jid < 1:
        raise ValueError('岗位编号无效')
    previous = job_record(db, jid)
    if not previous:
        raise ValueError('岗位不存在')
    if type(data.get('revision')) is not int or data['revision'] != previous['revision']:
        raise RevisionConflict('岗位已被修改，请刷新后重新编辑，当前输入已保留。')
    values = job_values(data)
    if 'search_conditions' not in data:
        values['search_conditions'] = previous['search_conditions']
    if 'priority_groups' not in data:
        values['priority_groups'] = normalize_priority_groups(previous['priority_groups'] if previous['priority_configured'] else None,
            requirement_lines(values['criteria'], 100, max_line=12000)+requirement_lines(values['must_have'], 100, max_line=12000), reconcile=True)
    changed = any(values[key] != previous[key] for key in values)
    invalidated = any(values[key] != previous[key] for key in ('jd', 'criteria', 'must_have', 'priority_groups'))
    revision = previous['revision']
    count = 0
    if changed:
        db.execute('UPDATE jobs SET title=?,city=?,jd=?,criteria=? WHERE id=?',
                   (values['title'], values['city'], values['jd'], values['criteria'], jid))
        revision += 1
        db.execute('''INSERT INTO job_requirements VALUES(?,?,?) ON CONFLICT(job_id)
            DO UPDATE SET must_have=excluded.must_have,revision=excluded.revision''', (jid, values['must_have'], revision))
        db.execute('''INSERT INTO job_priorities VALUES(?,?) ON CONFLICT(job_id)
            DO UPDATE SET groups_json=excluded.groups_json''', (jid, json.dumps(values['priority_groups'], ensure_ascii=False)))
        save_search_conditions(db, jid, values['search_conditions'])
        if invalidated:
            count = invalidate_evaluations(db, [r[0] for r in db.execute('SELECT id FROM candidates WHERE job_id=? AND deleted=0', (jid,))], audit)
        audit(db, 'update_job', str(jid))
    return {'ok':True, 'id':jid, 'revision':revision, 'changed':changed, 'pending_candidates':count}


def candidate_values(data):
    values = {key:text_field(data, key, maximum) for key, maximum in {
        **PROFILE_LIMITS, 'phone':100, 'email':200, 'link':2000, 'note':4000}.items()}
    values['name'] = text_field(data, 'name', 150, True)
    values['resume'] = text_field(data, 'resume', 30000, True)
    values['job_id'] = data.get('job_id')
    if type(values['job_id']) is not int or values['job_id'] < 1:
        raise ValueError('请选择有效岗位')
    if values['email'] and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', values['email']):
        raise ValueError('邮箱格式无效')
    if values['link']:
        try:
            url = urlsplit(values['link'])
            if url.scheme != 'https' or not url.hostname or url.username or url.password:
                raise ValueError()
        except ValueError:
            raise ValueError('平台入口须为有效的 HTTPS 链接') from None
    return values


def update_candidate(db, data, audit):
    cid = data.get('id')
    if type(cid) is not int or cid < 1:
        raise ValueError('候选人编号无效')
    row = db.execute('SELECT * FROM candidates WHERE id=? AND deleted=0', (cid,)).fetchone()
    if not row:
        raise ValueError('候选人不存在或已删除')
    previous, profile = dict(row), profile_record(db, cid)
    if type(data.get('revision')) is not int or data['revision'] != profile['revision']:
        raise RevisionConflict('候选人资料已被修改，请刷新后重新编辑，当前输入已保留。')
    values = candidate_values(data)
    auto_fields = profile_field_flags(data, 'profile_auto_fields')
    manual_fields = profile_field_flags(data, 'profile_manual_fields')
    profile_values, sources = profile_autofill_values(values['resume'], profile, values, auto_fields, manual_fields=manual_fields)
    values.update(profile_values)
    if not db.execute('SELECT 1 FROM jobs WHERE id=?', (values['job_id'],)).fetchone():
        raise ValueError('关联岗位不存在')
    base_fields = ('job_id', 'name', 'resume', 'phone', 'email', 'link', 'note')
    changed = (any(values[key] != previous[key] for key in base_fields) or
               any(values[key] != profile[key] for key in PROFILE_LIMITS) or sources != profile['profile_sources'])
    invalidated = (values['job_id'] != previous['job_id'] or
                   evaluation_resume(values['resume'], {**profile_values, 'profile_sources':sources}) != evaluation_resume(previous['resume'], profile))
    revision = profile['revision']
    if changed:
        db.execute('UPDATE candidates SET job_id=?,name=?,resume=?,phone=?,email=?,link=?,note=? WHERE id=?',
                   (*[values[key] for key in base_fields], cid))
        revision = bump_profile(db, cid, values)
        save_profile_sources(db, cid, sources)
        if values['resume'] != previous['resume']:
            db.execute('DELETE FROM candidate_resume_formats WHERE candidate_id=?', (cid,))
            db.execute('UPDATE candidate_profiles SET resume_edited=1 WHERE candidate_id=?', (cid,))
        if values['job_id'] != previous['job_id']:
            # Keep the old job's tombstone and add a key under the new job.
            db.execute('''INSERT OR IGNORE INTO candidate_card_keys(job_id,card_key,candidate_id)
                SELECT ?,card_key,candidate_id FROM candidate_card_keys WHERE candidate_id=?''', (values['job_id'], cid))
        if invalidated:
            invalidate_evaluations(db, [cid], audit)
        audit(db, 'update_candidate', str(cid))
    return {'ok':True, 'id':cid, 'revision':revision, 'changed':changed, 'evaluation_invalidated':invalidated and changed}


def evaluation_resume(resume, profile):
    labels = {'company':'当前公司', 'title':'当前职位', 'city':'城市', 'education':'学历', 'skills':'技能'}
    extra = []
    for key, label in labels.items():
        if profile.get('profile_sources', {}).get(key, {}).get('source') == 'resume':
            continue
        for line in profile.get(key, '').splitlines():
            if line.strip():
                extra.append(f'人工维护·{label}：{line.strip()}')
    return resume + ('\n\n【人工维护信息】\n' + '\n'.join(extra) if extra else '')
