import test from 'node:test';
import assert from 'node:assert/strict';
import { bossChatUrl, candidateGreetingRecords, confirmedGreetingAccounts } from '../frontend/boss-chat-link.mjs';

test('BOSS chat links use only the fixed official route and preserve numeric friend IDs exactly', () => {
  for (const uid of ['1', '10123456789', '9007199254740993', '18446744073709551615']) {
    const url = new URL(bossChatUrl(uid));
    assert.equal(url.origin, 'https://www.zhipin.com');
    assert.equal(url.pathname, '/web/chat/index');
    assert.deepEqual([...url.searchParams], [['uid', uid], ['source', '0']]);
    assert.equal(url.hash, '');
  }
  assert.equal(bossChatUrl(101), bossChatUrl('101'));
});

test('missing, encrypted, unsafe, noncanonical or URL-injection identities never become links', () => {
  for (const value of [undefined, null, '', 0, -1, NaN, Infinity, 1.5, true, false, 1n,
    Number.MAX_SAFE_INTEGER + 1, {}, ['101'], {friend_id:'101'}, {toString:() => '101'},
    '0', '-1', '+1', '01', '1.0', '1e3', ' 101', '101 ', '101\n', '１２３',
    '101&source=1', '101#redirect', 'https://evil.example', 'javascript:alert(1)',
    'encrypted-geek-id', '候选人姓名', '1'.repeat(21)]) {
    assert.equal(bossChatUrl(value), '', String(value));
  }
});

test('only unique account observations for the exact candidate UID prove an established conversation', () => {
  const row = (account_uid, state, boss_chat_uid='9007199254740993') => ({account_uid,state,boss_chat_uid});
  const candidate = {source:{boss_chat_uid:'9007199254740993',boss_greeting:[
    row('101','confirmed'),row('102','already'),row('103','attempted'),row('104','pending'),
    row('105','confirmed','777'),row('106','confirmed'),row('106','attempted'),row('01','confirmed'),
    row(107,'confirmed'),null,
  ]}};
  assert.deepEqual(candidateGreetingRecords(candidate).map(r=>r.account_uid),['101','102','103']);
  assert.deepEqual(confirmedGreetingAccounts(candidate).map(r=>r.account_uid),['101','102']);
  assert.deepEqual(confirmedGreetingAccounts({...candidate,deleted:true}),[]);
  assert.deepEqual(confirmedGreetingAccounts({source:{...candidate.source,boss_chat_uid:'777'}}).map(r=>r.account_uid),['105']);
  assert.deepEqual(confirmedGreetingAccounts({source:{boss_chat_uid:'encrypted'}}),[]);
  assert.deepEqual(confirmedGreetingAccounts({source:{boss_chat_uid:'123',boss_greeting:{state:'confirmed'}}}),[]);
});
