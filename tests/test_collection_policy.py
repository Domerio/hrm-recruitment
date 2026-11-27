import sqlite3
import unittest

from collection_policy import collection_policy, ensure_policy_tables, policy_key


class FailingMigrationConnection(sqlite3.Connection):
    failure_prefix = None

    def execute(self, sql, parameters=()):
        if self.failure_prefix and sql.lstrip().startswith(self.failure_prefix):
            raise sqlite3.OperationalError('Injected migration failure')
        return super().execute(sql, parameters)


class CollectionPolicyTests(unittest.TestCase):
    def legacy_database(self):
        db = sqlite3.connect(':memory:', factory=FailingMigrationConnection)
        self.addCleanup(db.close)
        db.row_factory = sqlite3.Row
        db.executescript('''CREATE TABLE jobs(id INTEGER PRIMARY KEY);
            CREATE TABLE candidate_screening(candidate_id INTEGER PRIMARY KEY,input_hash TEXT,
                score REAL,failure_json TEXT,favorite_pending INTEGER);
            CREATE TABLE collection_skip_marks(job_id INTEGER NOT NULL REFERENCES jobs(id),
                card_key TEXT NOT NULL,input_hash TEXT NOT NULL,score REAL NOT NULL CHECK(score>=0 AND score<=55),
                created TEXT NOT NULL,PRIMARY KEY(job_id,card_key));
            INSERT INTO jobs VALUES(1);
            INSERT INTO candidate_screening VALUES(1,'input',82,'',1);
            INSERT INTO collection_skip_marks VALUES(1,'legacy','input',55,'original');''')
        return db

    def test_partial_defaults_are_normalized_and_numeric_keys_are_stable(self):
        self.assertEqual(collection_policy({'save_above':65}),
            {'save_above':65,'share_above':75,'share_mode':'both','colleague_name':'蔡女士','greet_enabled':False})
        self.assertEqual(policy_key(collection_policy()),policy_key(collection_policy({'save_above':55.0})))
        self.assertEqual(collection_policy({'colleague_name':'  孙女士  '})['colleague_name'],'孙女士')

    def test_greeting_defaults_and_disabled_policy_hash_preserve_legacy_marks(self):
        import hashlib
        import json
        from collection_policy import stored_policy
        legacy = {'save_above':55.0,'share_above':75.0,'share_mode':'both','colleague_name':'蔡女士'}
        old_key = hashlib.sha256(json.dumps(legacy,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        self.assertEqual(policy_key(collection_policy()),old_key)
        self.assertFalse(stored_policy(json.dumps(legacy))['greet_enabled'])
        self.assertEqual(policy_key(collection_policy({'greet_enabled':True})),old_key)
        for value in (None,0,1,'true',[],{}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                collection_policy({'greet_enabled':value})

    def test_recipient_control_character_validation_matches_the_browser_contract(self):
        # Formatting characters (Cf) are not control characters (Cc).
        name = '孙\u200c女士'
        self.assertEqual(collection_policy({'colleague_name':name})['colleague_name'],name)
        for control in ('\n','\x00','\x7f','\x85'):
            with self.subTest(control=repr(control)), self.assertRaises(ValueError):
                collection_policy({'colleague_name':'孙' + control + '女士'})

    def test_legacy_database_migration_preserves_markers_and_accepts_the_whole_score_range(self):
        db = self.legacy_database()
        ensure_policy_tables(db)
        ensure_policy_tables(db)
        mark = dict(db.execute('SELECT * FROM collection_skip_marks').fetchone())
        self.assertEqual(mark,{'job_id':1,'card_key':'legacy','input_hash':'input','score':55,'created':'original',
            'policy_key':policy_key(collection_policy())})
        self.assertEqual(db.execute('SELECT policy_json FROM candidate_screening').fetchone()[0],'')
        db.execute("INSERT INTO collection_skip_marks(job_id,card_key,input_hash,score,created) VALUES(1,'high','input',100,'new')")
        self.assertEqual(db.execute("SELECT policy_key FROM collection_skip_marks WHERE card_key='high'").fetchone()[0],policy_key(collection_policy()))
        for score in (-1,100.01):
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO collection_skip_marks(job_id,card_key,input_hash,score,created) VALUES(1,'invalid','input',?,'new')",(score,))

    def test_failed_migration_restores_old_schema_and_data_without_a_scratch_table(self):
        for failure in ('INSERT INTO collection_skip_marks_policy',
                        'ALTER TABLE collection_skip_marks_policy RENAME'):
            for outer_transaction in (False, True):
                with self.subTest(failure=failure, outer_transaction=outer_transaction):
                    db = self.legacy_database()
                    if outer_transaction:
                        db.execute('BEGIN')
                        db.execute('INSERT INTO jobs VALUES(2)')
                    db.failure_prefix = failure
                    with self.assertRaisesRegex(sqlite3.OperationalError, 'Injected migration failure'):
                        ensure_policy_tables(db)
                    self.assertEqual(db.in_transaction,outer_transaction)
                    self.assertEqual(dict(db.execute('SELECT * FROM collection_skip_marks').fetchone()),
                        {'job_id':1,'card_key':'legacy','input_hash':'input','score':55,'created':'original'})
                    self.assertNotIn('policy_json', {r['name'] for r in db.execute('PRAGMA table_info(candidate_screening)')})
                    self.assertEqual(tuple(db.execute('SELECT * FROM candidate_screening').fetchone()),
                        (1,'input',82,'',1))
                    self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='collection_skip_marks_policy'").fetchone())
                    self.assertEqual(bool(db.execute('SELECT 1 FROM jobs WHERE id=2').fetchone()),outer_transaction)
                    db.failure_prefix = None
                    ensure_policy_tables(db)
                    self.assertEqual(db.in_transaction,outer_transaction)
                    self.assertEqual(db.execute('SELECT score FROM collection_skip_marks').fetchone()[0],55)
                    db.execute("INSERT INTO collection_skip_marks(job_id,card_key,input_hash,score,created) VALUES(1,'high','input',100,'new')")
