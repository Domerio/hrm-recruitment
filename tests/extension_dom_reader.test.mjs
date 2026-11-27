import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const source=fs.readFileSync(new URL('../extension/dom-reader.js',import.meta.url),'utf8');
function fixture(html){
  const {window,document}=parseHTML('<html><body>'+html+'</body></html>');
  delete window.__hrmDom;
  let styles=0,rects=0;
  const getComputedStyle=(element,pseudo)=>{
    styles++;
    if(pseudo)return {content:element.getAttribute(pseudo==='::before'?'data-before':'data-after')||'none'};
    return {display:element.style.display||'block',opacity:element.style.opacity||'1',
      contentVisibility:element.style.contentVisibility||'visible',visibility:element.style.visibility||'visible'};
  };
  window.HTMLElement.prototype.getClientRects=function(){rects++;return this.getAttribute('data-no-rect')?[]:[{}];};
  vm.runInNewContext(source,{window,document,getComputedStyle});
  return {window,document,reader:window.__hrmDom,counts:()=>({styles,rects}),clear:()=>{styles=0;rects=0;}};
}

test('rendered snapshots exclude hidden ancestors and preserve explicitly visible descendants',()=>{
  const f=fixture('<div style="display:none"><span>hidden display</span></div>'+
    '<div style="opacity:0"><span>hidden opacity</span></div>'+
    '<div style="visibility:hidden"><span style="visibility:visible">visible child</span>'+
    '<span style="visibility:hidden">hidden child</span></div>'+
    '<div style="display:contents" data-no-rect="1">contents text</div>');
  const result=f.reader.view(f.document.body);
  assert.match(result.text,/visible child/);
  assert.match(result.text,/contents text/);
  assert.doesNotMatch(result.text,/hidden display|hidden opacity|hidden child/);
});

test('visibility and generated content are refreshed on every separate snapshot',()=>{
  const f=fixture('<section id="target"><p>正文</p></section>');
  const target=f.document.getElementById('target');
  target.setAttribute('data-before','"before"');
  assert.match(f.reader.text(target),/before.*正文/s);
  target.style.display='none';
  assert.equal(f.reader.text(target),'');
  target.style.display='block';
  target.setAttribute('data-before','"after"');
  assert.match(f.reader.text(target),/after.*正文/s);
  target.querySelector('p').textContent='更新正文';
  assert.match(f.reader.text(target),/更新正文/);
});

test('visible shadow contents keep their host visibility boundary',()=>{
  const f=fixture('<section id="host"></section>');
  const host=f.document.getElementById('host');
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML='<p>Shadow resume</p>';
  const shown=f.reader.view(f.document.body);
  assert.match(shown.text,/Shadow resume/);
  assert.equal(shown.stats.openShadowRoots,1);
  host.style.opacity='0';
  assert.equal(f.reader.text(host),'');
  host.style.opacity='1';
  assert.match(f.reader.text(host),/Shadow resume/);
});

test('deep rendered lists use bounded style and layout reads per snapshot',()=>{
  let html='<span>candidate name</span>';
  for(let index=0;index<70;index++)html='<section>'+html+'</section>';
  const f=fixture(html);
  const result=f.reader.view(f.document.body);
  assert.match(result.text,/candidate name/);
  assert.equal(result.stats.truncated,false);
  const elements=result.elements.length,{styles,rects}=f.counts();
  // This is a browser-call budget, not a timing assertion. Ancestor depth must
  // not multiply style or layout reads for every descendant.
  assert.ok(styles<=elements*4+8,'style reads '+styles+' for '+elements+' elements');
  assert.ok(rects<=elements+2,'layout reads '+rects+' for '+elements+' elements');
  f.clear();
  f.document.querySelector('span').style.display='none';
  assert.equal(f.reader.text(f.document.body),'');
});
