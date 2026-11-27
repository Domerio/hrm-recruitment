import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = (await readFile(new URL('../frontend/Connections.jsx', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
  .replace('export default function Connections', 'function Connections');
const { code } = await transform(source, { loader:'jsx', jsxFactory:'h', jsxFragment:'Fragment' });
const first = 'a'.repeat(32), second = 'b'.repeat(32);

function view(state, { failure = false } = {}) {
  const calls = [], choices = [], notices = [], refreshes = [];
  const components = Object.fromEntries(['Alert','Button','Card','Col','Divider','Form','Input','Row','Space','Tag','AiConfiguration','ExtensionDownload'].map(name=>[name,name]));
  components.Form = Object.assign(function Form(){}, {Item:'Form.Item'});
  const context = {...components, Typography:{Paragraph:'Paragraph',Text:'Text'},
    h:(type,props,...children)=>({type,props:props??{},children}),
    useState:()=>['',()=>{}],useRef:()=>({current:false}),
    rememberBrowserExtension:id=>choices.push(id)};
  vm.runInNewContext(code+'\nglobalThis.Connections = Connections;',context);
  const tree = context.Connections({state,
    api:async(path,body)=>{calls.push({path,body});if(failure)throw Error('授权失败');},
    refresh:async()=>refreshes.push([...choices]),notify:(...args)=>notices.push(args)});
  function find(predicate, node = tree) {
    if(!node || typeof node !== 'object')return null;
    if(predicate(node))return node;
    for(const child of node.children??[]) {
      if(child === undefined)continue;
      const found = find(predicate,child);if(found)return found;
    }
    return null;
  }
  return {calls,choices,notices,refreshes,
    pair:id=>find(node=>node.type===components.Form).props.onFinish({extensionId:id}),
    revoke:()=>find(node=>node.props.id==='extension-revoke').props.onClick(),
    revokeDisabled:find(node=>node.props.id==='extension-revoke').props.disabled};
}

test('pairing remembers the exact browser ID before refreshing its derived connection state',async()=>{
  const form=view({extension_id:'',extension_paired:false,extension_ids:[first,second]});
  await form.pair(' '+second+' ');
  assert.equal(form.calls[0].path,'/api/extension/pair');
  assert.equal(form.calls[0].body.id,second);
  assert.deepEqual(form.choices,[second]);
  assert.deepEqual(form.refreshes,[[second]]);
});

test('revoke sends only the selected browser ID and clears its choice before refresh',async()=>{
  const form=view({extension_id:first,extension_paired:true,extension_ids:[first,second]});
  await form.revoke();
  assert.equal(form.calls[0].path,'/api/extension/revoke');
  assert.equal(form.calls[0].body.id,first);
  assert.deepEqual(form.choices,['']);
  assert.deepEqual(form.refreshes,[['']]);
});

test('no browser selection disables revoke and rejected authorization preserves the existing choice',async()=>{
  const form=view({extension_id:'',extension_paired:false,extension_ids:[first,second]}, {failure:true});
  assert.equal(form.revokeDisabled,true);
  await form.pair(first);
  assert.deepEqual(form.choices,[]);
  assert.deepEqual(form.refreshes,[]);
  assert.deepEqual(form.notices,[['授权失败',true]]);
});
