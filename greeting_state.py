"""Durable, account-scoped reservations for browser-owned default greetings.

The caller owns BEGIN IMMEDIATE and validates the active candidate before writes.
No operation in this module performs a network request or sends a message.
"""
import hashlib
import hmac
import re
import secrets
from datetime import datetime, timezone


UID_PATTERN = re.compile(r'[1-9][0-9]{0,19}')


def valid_uid(value):
    return isinstance(value, str) and UID_PATTERN.fullmatch(value) is not None


def ensure_greeting_tables(db):
    # Identity history deliberately has no candidate FK: archive replacement or
    # deletion must never remove the account/person duplicate barrier.
    db.execute('''CREATE TABLE IF NOT EXISTS boss_greetings(
        account_uid TEXT NOT NULL,boss_chat_uid TEXT NOT NULL,
        candidate_id INTEGER NOT NULL,job_id INTEGER NOT NULL,card_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('attempted','confirmed','already')),
        token_hash TEXT NOT NULL DEFAULT '',policy_json TEXT NOT NULL,evaluation_fingerprint TEXT NOT NULL,
        created TEXT NOT NULL,updated TEXT NOT NULL,
        PRIMARY KEY(account_uid,boss_chat_uid))''')
    db.execute('CREATE INDEX IF NOT EXISTS idx_boss_greetings_uid ON boss_greetings(boss_chat_uid)')


def relation_records(db, boss_chat_uid):
    if not valid_uid(boss_chat_uid):
        return []
    return [dict(row) for row in db.execute('''SELECT account_uid,boss_chat_uid,state,updated FROM boss_greetings
        WHERE boss_chat_uid=? ORDER BY updated DESC,account_uid''', (boss_chat_uid,))]


def find_greeting(db, account_uid, boss_chat_uid):
    if not valid_uid(account_uid) or not valid_uid(boss_chat_uid):
        return None
    return db.execute('SELECT * FROM boss_greetings WHERE account_uid=? AND boss_chat_uid=?',
                      (account_uid,boss_chat_uid)).fetchone()


def reserve_greeting(db, *, account_uid, boss_chat_uid, candidate_id, job_id, card_key,
                     policy_json, fingerprint, already=False):
    """Return a permit only on first insertion; no read path can recover it."""
    existing = find_greeting(db, account_uid, boss_chat_uid)
    if existing:
        return {'state':existing['state'],'may_greet':False}, False
    token = '' if already else secrets.token_urlsafe(32)
    stamp = datetime.now(timezone.utc).isoformat()
    state = 'already' if already else 'attempted'
    digest = hashlib.sha256(token.encode('ascii')).hexdigest() if token else ''
    db.execute('''INSERT INTO boss_greetings(account_uid,boss_chat_uid,candidate_id,job_id,card_key,
        state,token_hash,policy_json,evaluation_fingerprint,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
        (account_uid,boss_chat_uid,candidate_id,job_id,card_key,state,digest,policy_json,fingerprint,stamp,stamp))
    result = {'state':state,'may_greet':not already}
    if token:
        result['attempt_token'] = token
    return result, True


def complete_greeting(db, *, account_uid, boss_chat_uid, candidate_id, job_id, card_key, token):
    if not isinstance(token,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',token):
        raise ValueError('缺少有效的打招呼确认凭据，请人工核对 BOSS 沟通记录')
    row = find_greeting(db,account_uid,boss_chat_uid)
    if (not row or row['candidate_id'] != candidate_id or row['job_id'] != job_id or
            row['card_key'] != card_key or row['state'] not in ('attempted','confirmed') or
            not hmac.compare_digest(row['token_hash'],hashlib.sha256(token.encode('ascii')).hexdigest())):
        raise ValueError('打招呼确认凭据与原操作不一致，未修改记录')
    changed = row['state'] == 'attempted'
    if changed:
        db.execute("UPDATE boss_greetings SET state='confirmed',updated=? WHERE account_uid=? AND boss_chat_uid=?",
                   (datetime.now(timezone.utc).isoformat(),account_uid,boss_chat_uid))
    return {'state':'confirmed','may_greet':False}, changed
