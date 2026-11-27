import test from 'node:test';
import assert from 'node:assert/strict';
import { favoriteFinderUrl } from '../frontend/favorite-finder-link.mjs';

const extension = 'abcdefghijklmnopabcdefghijklmnop';
test('finder links carry only the candidate key and workbench origin', () => {
  const url = new URL(favoriteFinderUrl({ id: 140, name: '私人姓名', resume: '私人原文' }, extension, 'http://127.0.0.1:8765'));
  assert.equal(url.protocol, 'chrome-extension:');
  assert.equal(url.hostname, extension);
  assert.equal(url.pathname, '/favorite-finder.html');
  assert.equal(url.searchParams.get('candidate'), '140');
  assert.equal(url.searchParams.get('workbench'), 'http://127.0.0.1:8765');
  assert.equal([...url.searchParams].length, 2);
  assert.doesNotMatch(url.href, /私人|token|resume/);
});
test('invalid identities, unpaired extensions and malformed origins never create links', () => {
  for (const c of [null, {}, {id:0}, {id:'140'}, {id:NaN}, {id:140,deleted:true}])
    assert.equal(favoriteFinderUrl(c, extension, 'http://127.0.0.1:8765'), '');
  for (const e of ['', 'unknown', extension+'a', '../attack'])
    assert.equal(favoriteFinderUrl({id:1}, e, 'http://127.0.0.1:8765'), '');
  for (const origin of ['file:///tmp','https://example.test','http://evil.test:8765','http://x@127.0.0.1:8765','http://10.0.0.2:8765/path','http://10.0.0.2:8765?x=1'])
    assert.equal(favoriteFinderUrl({id:1}, extension, origin), '');
});

test('LAN links preserve the exact server origin without carrying private candidate data', () => {
  for (const origin of ['http://10.177.156.46:8765','http://192.168.1.20:9000','https://172.16.1.2','http://127.0.0.1:9999']) {
    const url = new URL(favoriteFinderUrl({id:7,token:'secret',resume:'private'}, extension, origin));
    assert.equal(url.searchParams.get('workbench'), origin);
    assert.deepEqual([...url.searchParams.keys()], ['candidate','workbench']);
  }
});
