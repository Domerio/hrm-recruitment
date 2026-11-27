"""Favorites lookup exposes bounded identity evidence and preserves verified bindings."""
import json
from pathlib import Path
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import server
from favorites_locator import professional_evidence
import test_collection_rollback as fixture

RESUME = '''张**
31岁 男 已婚
电话:13800138000 邮箱:private@example.invalid
个人优势
曾参与客户客户秘密科技有限公司的项目。
工作经历
测试设备股份有限公司
工业工程师
2021.03 - 至今
负责产线设计与现场实施。
教育经历
合成工业大学
工业工程
本科
2017 - 2021
项目经历
客户研发有限公司
供应商项目
2019.03 - 2020.03
'''


class FavoritesLocatorTests(unittest.TestCase):
    stop_http = fixture.CollectionRollbackTests.stop_http

    def setUp(self):
        fixture.CollectionRollbackTests.setUp(self)
        extension = patch.object(server, 'EXTENSION_FILE', server.DB.parent / 'extension.json')
        extension.start(); self.addCleanup(extension.stop)
        server.EXTENSION_FILE.write_text(json.dumps({'id':'a'*32}), encoding='utf-8')
        for function in ('complete_evaluation','submit_ai_request'):
            mocked = patch.object(server,function,side_effect=AssertionError('Unexpected AI invocation'))
            mocked.start();self.addCleanup(mocked.stop)
        self.cid, _ = server.save_boss_candidate(1,'张**',RESUME,'')

    def post(self, path, data, headers=None):
        request=urllib.request.Request(self.base+path,data=json.dumps(data).encode(),headers={
            'X-App-Token':server.TOKEN,'Content-Type':'application/json',
            'Origin':'chrome-extension://'+'a'*32,**(headers or {})})
        try:
            with urllib.request.urlopen(request,timeout=5) as response:
                return response.status,json.load(response)
        except urllib.error.HTTPError as error:
            return error.code,json.load(error)

    def target(self,cid=None):
        return self.post('/api/extension/favorite-target',{'id':self.cid if cid is None else cid})

    def binding(self,**changes):
        target=self.target()[1]['target']
        data={'id':self.cid,'input_key':target['input_key'],'name':'张**',
            'account_uid':'90071992547409931234','platform_geek_id':'encrypted-geek-123',
            'boss_chat_uid':'90071992547409931235',**changes}
        return self.post('/api/extension/favorite-binding',data)

    def test_read_only_target_is_bounded_professional_evidence(self):
        with server.connect() as db:
            before=db.execute('SELECT COUNT(*) FROM audit').fetchone()[0]
        status,response=self.target()
        self.assertEqual(status,200)
        target=response['target']
        self.assertEqual(target['id'],self.cid)
        self.assertEqual(target['matching_version'],1)
        self.assertEqual(target['platform_geek_id'],'')
        self.assertEqual(target['bindings'],[])
        self.assertIn({'kind':'work','organization':'测试设备股份有限公司','period':'2021.03 - 至今'},target['evidence'])
        self.assertIn({'kind':'education','organization':'合成工业大学','period':'2017 - 2021'},target['evidence'])
        encoded=json.dumps(target,ensure_ascii=False)
        for secret in ('31岁','已婚','13800138000','private@example','客户研发','客户秘密','负责产线','resume'):
            self.assertNotIn(secret,encoded)
        self.assertLess(len(encoded),6000)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM audit').fetchone()[0],before)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM candidate_favorite_bindings').fetchone()[0],0)

    def test_compact_headers_and_dated_brand_employers(self):
        rows=professional_evidence('''测试
工作经历 测试科技有限公司 · 工业工程师 2023.02 - 2024.03
教育经历 合成工业大学 · 工业工程 · 本科 2015 - 2019
''')
        self.assertEqual(rows,[{'kind':'work','organization':'测试科技有限公司','period':'2023.02 - 2024.03'},
            {'kind':'education','organization':'合成工业大学','period':'2015 - 2019'}])
        rows=professional_evidence('''工作经历
厦门测试能源高压开关（原某品牌，外企）
厂务
实习
2023.12 - 2026.11
教育经历
合成工业大学 工业工程 本科 2015 - 2019
''')
        self.assertIn({'kind':'work','organization':'厦门测试能源高压开关','period':'2023.12 - 2026.11'},rows)

    def test_primary_key_is_strict_and_deleted_candidates_do_not_resolve(self):
        for invalid in (None,True,False,0,-1,str(self.cid),1.0,999999):
            self.assertEqual(self.post('/api/extension/favorite-target',{'id':invalid})[0],400)
        with server.connect() as db:
            db.execute('UPDATE candidates SET deleted=1 WHERE id=?',(self.cid,))
        self.assertEqual(self.target()[0],400)

    def test_pairing_and_token_are_both_required(self):
        for headers in ({'X-App-Token':'wrong'},{'Origin':'chrome-extension://'+'b'*32},
                        {'Origin':self.base},{'Origin':'https://untrusted.invalid'},{'Origin':''}):
            self.assertEqual(self.post('/api/extension/favorite-target',{'id':self.cid},headers)[0],403)
        server.EXTENSION_FILE.write_text('{}',encoding='utf-8')
        self.assertEqual(self.target()[0],403)

    def test_pair_identifier_is_public_but_malformed_values_never_break_state(self):
        for identifier,expected in [('a'*32,'a'*32),('INVALID',''),(123,''),(None,'')]:
            server.EXTENSION_FILE.write_text(json.dumps({'id':identifier}),encoding='utf-8')
            with urllib.request.urlopen(self.base+'/api/state',timeout=5) as response:
                state=json.load(response)
            self.assertEqual(state['extension_id'],expected)
            self.assertEqual(state['favorite_locator_version'],1)

    def test_minimal_session_only_accepts_the_paired_extension_and_omits_candidate_data(self):
        path=self.base+'/api/extension/favorite-session'
        for method in ('GET','POST'):
            data=b'{}' if method=='POST' else None
            headers={'Origin':'chrome-extension://'+'a'*32,'Content-Type':'application/json'}
            # Bootstrap has no X-App-Token. The next candidate request still requires it.
            request=urllib.request.Request(path,data=data,headers=headers,method=method)
            with urllib.request.urlopen(request,timeout=5) as response:
                result=json.load(response)
            self.assertEqual(result,{'token':server.TOKEN,'extension_id':'a'*32,
                'favorite_locator_version':1,'version':server.APP_VERSION})
            for origin in (None,self.base,'chrome-extension://'+'b'*32,'https://untrusted.invalid'):
                headers={'Content-Type':'application/json',**({'Origin':origin} if origin is not None else {})}
                request=urllib.request.Request(path,data=data,headers=headers,method=method)
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(request,timeout=5)
                self.assertEqual(error.exception.code,403)
        server.EXTENSION_FILE.write_text('{}',encoding='utf-8')
        self.assertEqual(self.post('/api/extension/favorite-session',{})[0],403)

    def test_binding_round_trip_retains_string_ids_and_never_asserts_chat_permission(self):
        self.assertEqual(self.binding()[0],200)
        self.assertEqual(self.binding()[0],200)
        target=self.target()[1]['target']
        self.assertEqual(len(target['bindings']),1)
        self.assertEqual(target['bindings'][0]['account_uid'],'90071992547409931234')
        self.assertEqual(target['bindings'][0]['boss_chat_uid'],'90071992547409931235')
        self.assertEqual(target['boss_chat_uid'],'')
        with server.connect() as db:
            self.assertEqual(server.source_info(db,self.cid)['boss_chat_uid'],'')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM boss_greetings').fetchone()[0],0)

    def test_binding_changes_require_current_input_and_matching_identity(self):
        original=self.target()[1]['target']
        for changes in ({'input_key':'0'*64},{'name':'李**'},{'account_uid':123},
                        {'platform_geek_id':'https://bad.invalid/'},{'boss_chat_uid':123}):
            self.assertEqual(self.binding(**changes)[0],400)
        self.assertEqual(self.binding()[0],200)
        self.assertEqual(self.binding(platform_geek_id='encrypted-other-456')[0],400)
        self.assertEqual(self.binding(boss_chat_uid='42')[0],400)
        with server.connect() as db:
            db.execute("UPDATE candidates SET resume=resume||'已更新' WHERE id=?",(self.cid,))
        self.assertEqual(self.binding(input_key=original['input_key'])[0],400)
        self.assertEqual(self.target()[1]['target']['bindings'],[])

    def test_existing_source_uid_must_match_the_verified_detail(self):
        with server.connect() as db:
            db.execute("INSERT INTO candidate_sources(candidate_id,boss_chat_uid) VALUES(?,?)",(self.cid,'42'))
        self.assertEqual(self.target()[1]['target']['boss_chat_uid'],'42')
        self.assertEqual(self.binding()[0],400)
        self.assertEqual(self.binding(boss_chat_uid='')[0],400)
        self.assertEqual(self.binding(boss_chat_uid='42')[0],200)


if __name__=='__main__':
    unittest.main()
