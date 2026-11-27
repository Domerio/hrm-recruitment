import test from 'node:test';
import assert from 'node:assert/strict';
import { browserExtensionState, rememberBrowserExtension, selectedBrowserExtension, BROWSER_EXTENSION_KEY } from '../frontend/browser-extension.mjs';

const first = 'a'.repeat(32), second = 'b'.repeat(32);
test('legacy single extension is usable on loopback before a browser has ever selected one', () => {
  const state = browserExtensionState({extension_id:first,extension_paired:true},null,'http://127.0.0.1:8765');
  assert.equal(state.extension_id,first);
  assert.equal(state.extension_paired,true);
  assert.deepEqual(state.extension_ids,[first]);
});

test('a new LAN browser never assumes the only authorized extension is installed locally', () => {
  const server = {extension_id:first,extension_paired:true,extension_ids:[first]};
  for(const origin of ['http://10.177.156.46:8765','http://192.168.1.8:8765',undefined]) {
    const state = browserExtensionState(server,null,origin);
    assert.equal(state.extension_id,'');
    assert.equal(state.extension_paired,false);
    assert.equal(state.extension_selection_required,true);
  }
  assert.equal(browserExtensionState(server,first,'http://10.177.156.46:8765').extension_paired,true);
});

test('multiple authorized extensions require an explicit browser selection', () => {
  const state = {extension_id:second,extension_paired:true,extension_ids:[first,second]};
  for(const selection of [null,'','c'.repeat(32)]) {
    const browser = browserExtensionState(state,selection);
    assert.equal(browser.extension_id,'');
    assert.equal(browser.extension_paired,false);
    assert.equal(browser.extension_selection_required,true);
  }
  assert.equal(browserExtensionState(state,first).extension_id,first);
  assert.equal(browserExtensionState(state,second).extension_id,second);
});

test('revoked and stale browser choices never fall back to another installed extension', () => {
  const remaining = {extension_id:second,extension_paired:true,extension_ids:[second]};
  for(const selection of [first,'']) {
    const state = browserExtensionState(remaining,selection);
    assert.equal(state.extension_id,'');
    assert.equal(state.extension_paired,false);
  }
  assert.equal(browserExtensionState({...remaining,extension_ids:[]},second).extension_paired,false);
});

test('pair choices persist and explicit revoke leaves an empty choice rather than legacy auto-selection', () => {
  const data = new Map();
  const storage = {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  rememberBrowserExtension(first,storage);
  assert.equal(data.get(BROWSER_EXTENSION_KEY),first);
  assert.equal(selectedBrowserExtension(storage),first);
  rememberBrowserExtension('',storage);
  assert.equal(selectedBrowserExtension(storage),'');
  assert.equal(browserExtensionState({extension_ids:[second]},selectedBrowserExtension(storage)).extension_paired,false);
});

test('browser storage failures keep the successful authorization choice usable for the current session', () => {
  const storage = {getItem(){throw Error('disabled');},setItem(){throw Error('disabled');}};
  rememberBrowserExtension(first,storage);
  assert.equal(selectedBrowserExtension(storage),first);
  assert.equal(browserExtensionState({extension_ids:[first,second]},selectedBrowserExtension(storage)).extension_id,first);
  rememberBrowserExtension('',storage);
});
