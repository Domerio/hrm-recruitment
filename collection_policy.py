"""Validated, snapshotted rules for a local BOSS collection run."""
import hashlib
import json
import math
import unicodedata


DEFAULT_COLLECTION_POLICY = {
    'save_above': 55, 'share_above': 75, 'share_mode': 'both', 'colleague_name': '蔡女士',
    'greet_enabled': False,
}


def collection_policy(value=None):
    if value is None:
        return dict(DEFAULT_COLLECTION_POLICY)
    if not isinstance(value, dict) or set(value) - set(DEFAULT_COLLECTION_POLICY):
        raise ValueError('采集分数和分享设置无效')
    result = {**DEFAULT_COLLECTION_POLICY, **value}
    for field in ('save_above', 'share_above'):
        number = result[field]
        if type(number) not in (int, float) or not 0 <= number <= 100 or not math.isfinite(number):
            raise ValueError('分数线必须是 0 到 100 之间的数字')
    if type(result['greet_enabled']) is not bool:
        raise ValueError('自动打招呼设置必须为布尔值')
    if result['share_mode'] not in ('none', 'qr', 'colleague', 'both'):
        raise ValueError('分享方式无效')
    name = result['colleague_name']
    if not isinstance(name, str) or len(name) > 40 or any(unicodedata.category(c) == 'Cc' for c in name):
        raise ValueError('站内同事名称无效')
    result['colleague_name'] = name.strip()
    if colleague_enabled(result) and not result['colleague_name']:
        raise ValueError('请填写站内同事的显示名')
    return result


def colleague_enabled(policy):
    return policy['share_mode'] in ('colleague', 'both')


def policy_json(policy):
    return json.dumps(policy, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def policy_key(policy):
    # Canonical numeric values keep an integer and its equivalent float equal.
    canonical = {**policy, 'save_above': float(policy['save_above']), 'share_above': float(policy['share_above'])}
    # Greeting is a post-save action. Toggling it must not invalidate existing
    # low-score marks or create another paid evaluation for the same policy.
    canonical.pop('greet_enabled', None)
    return hashlib.sha256(policy_json(canonical).encode('utf-8')).hexdigest()


def stored_policy(value):
    return collection_policy(json.loads(value)) if value else collection_policy()


def share_state(row, score, policy, requested=None):
    if not row:
        return ''
    state = row['state']
    # An attempted delivery must remain visible even if the run disables sharing.
    if state in ('attempted', 'confirmed'):
        return state
    if (state == 'pending' and colleague_enabled(policy) and score is not None and
            score > policy['share_above'] and (requested is None or colleague_enabled(requested))):
        return state
    return ''


def ensure_policy_tables(db):
    # DDL does not automatically start a Python sqlite3 transaction. Start one
    # explicitly before CREATE/ALTER, while preserving any caller transaction.
    db.execute('SAVEPOINT collection_policy_schema')
    try:
        columns = {row['name'] for row in db.execute('PRAGMA table_info(candidate_screening)')}
        if 'policy_json' not in columns:
            db.execute("ALTER TABLE candidate_screening ADD COLUMN policy_json TEXT NOT NULL DEFAULT ''")
        columns = {row['name'] for row in db.execute('PRAGMA table_info(collection_skip_marks)')}
        if 'policy_key' not in columns:
            # SQLite cannot widen the old score<=55 CHECK with ALTER COLUMN.
            # Roll back the complete replacement if copying or renaming fails.
            db.execute(f'''CREATE TABLE collection_skip_marks_policy(
                job_id INTEGER NOT NULL REFERENCES jobs(id),card_key TEXT NOT NULL,input_hash TEXT NOT NULL,
                score REAL NOT NULL CHECK(score>=0 AND score<=100),created TEXT NOT NULL,
                policy_key TEXT NOT NULL DEFAULT '{policy_key(collection_policy())}',
                PRIMARY KEY(job_id,card_key))''')
            db.execute('''INSERT INTO collection_skip_marks_policy
                SELECT job_id,card_key,input_hash,score,created,? FROM collection_skip_marks''',
                (policy_key(collection_policy()),))
            db.execute('DROP TABLE collection_skip_marks')
            db.execute('ALTER TABLE collection_skip_marks_policy RENAME TO collection_skip_marks')
    except BaseException:
        db.execute('ROLLBACK TO SAVEPOINT collection_policy_schema')
        db.execute('RELEASE SAVEPOINT collection_policy_schema')
        raise
    else:
        db.execute('RELEASE SAVEPOINT collection_policy_schema')


def ensure_precheck_marks(db):
    """Keep rule rejections without inventing a numeric AI score."""
    if 'precheck_json' in {row['name'] for row in db.execute('PRAGMA table_info(collection_skip_marks)')}:
        return
    db.execute('SAVEPOINT rule_precheck_schema')
    try:
        db.execute(f'''CREATE TABLE collection_skip_marks_precheck(
            job_id INTEGER NOT NULL REFERENCES jobs(id),card_key TEXT NOT NULL,input_hash TEXT NOT NULL,
            score REAL,created TEXT NOT NULL,
            policy_key TEXT NOT NULL DEFAULT '{policy_key(collection_policy())}',
            precheck_json TEXT NOT NULL DEFAULT '',
            CHECK((score IS NOT NULL AND score>=0 AND score<=100 AND precheck_json='') OR
                  (score IS NULL AND precheck_json<>'')),
            PRIMARY KEY(job_id,card_key))''')
        db.execute('''INSERT INTO collection_skip_marks_precheck
            (job_id,card_key,input_hash,score,created,policy_key)
            SELECT job_id,card_key,input_hash,score,created,policy_key FROM collection_skip_marks''')
        db.execute('DROP TABLE collection_skip_marks')
        db.execute('ALTER TABLE collection_skip_marks_precheck RENAME TO collection_skip_marks')
    except BaseException:
        db.execute('ROLLBACK TO SAVEPOINT rule_precheck_schema')
        db.execute('RELEASE SAVEPOINT rule_precheck_schema')
        raise
    else:
        db.execute('RELEASE SAVEPOINT rule_precheck_schema')
