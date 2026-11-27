import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {detectPaymentSurface} from '../extension/payment-surface.mjs';

const payment='<div class="vip2-layout"><section><h2>VIP账号</h2><div class="rights-table-vip">套餐权益</div></section>'+
  '<section class="payment-layout-v2"><label>商品需付</label><strong>￥199.00</strong><p>扫码支付</p>'+
  '<div class="pay-wrap-qrcode-v1"><img class="qrcode"></div><p>增值服务协议</p></section></div>';
function page(markup,url='https://www.zhipin.com/web/frame/recommend'){
  const {document,HTMLElement}=parseHTML('<html><body>'+markup+'</body></html>');
  Object.defineProperty(HTMLElement.prototype,'getBoundingClientRect',{configurable:true,value(){
    let left=0,top=0;
    for(let p=this;p;p=p.parentElement){left+=Number(p.getAttribute('data-x')||0);top+=Number(p.getAttribute('data-y')||0);}
    const width=Number(this.getAttribute('data-width')||600),height=Number(this.getAttribute('data-height')||400);
    return {left,top,right:left+width,bottom:top+height,width,height};
  }});
  const location=new URL(url),win={document,location,innerWidth:1200,innerHeight:800};
  let styleReads=0;
  win.getComputedStyle=element=>{
    styleReads++;
    let visibility='visible';
    for(let p=element;p;p=p.parentElement){if(p.style.visibility){visibility=p.style.visibility;break;}}
    return {display:element.hidden?'none':element.style.display||'block',visibility,
      opacity:element.style.opacity||'1',overflow:element.style.overflow||'visible',
      overflowX:element.style.overflowX||element.style.overflow||'visible',
      overflowY:element.style.overflowY||element.style.overflow||'visible'};
  };
  const run=()=>vm.runInNewContext('('+detectPaymentSurface.toString()+')()',{
    window:win,document,location,URL,innerWidth:win.innerWidth,innerHeight:win.innerHeight});
  return {document,win,run,styleReads:()=>styleReads};
}
function frame(parent,child,attrs=''){
  const wrap=parent.document.createElement('div');wrap.innerHTML='<iframe '+attrs+'></iframe>';
  const iframe=wrap.firstElementChild;parent.document.body.append(iframe);
  Object.defineProperties(iframe,{contentWindow:{value:child.win},contentDocument:{value:child.document}});
  return iframe;
}

test('visible split VIP product and payment components are detected without a dialog role',()=>{
  const f=page(payment);assert.equal(f.run(),true);
  assert.equal(f.document.querySelectorAll('button').length,0);
});
test('generic modal needs actual payment action or QR evidence as well as price and product',()=>{
  for(const markup of [
    '<div role="dialog"><p>VIP账号</p><p>商品需付 ￥99</p><p>扫码支付</p><img class="qrcode"></div>',
    '<div role="dialog"><p>会员套餐 ￥99</p><p>套餐权益</p><button>立即支付</button></div>',
  ])assert.equal(page(markup).run(),true);
  for(const text of ['VIP账号 ￥99 扫码支付','工作经历：设计商品需付、扫码支付和VIP账号界面，价格￥99。',
    '教育经历：商城会员套餐设计，套餐权益、增值服务协议。价格199元。'])
    assert.equal(page('<div role="dialog"><article class="resume"><p>'+text+'</p></article></div>').run(),false);
  assert.equal(page('<div role="dialog"><p>价格 ￥99</p><button>立即购买</button></div>').run(),false);
});
test('plain resume or chat mentions cannot become payment surfaces',()=>{
  assert.equal(page('<main><p>VIP账号 商品需付 ￥99 扫码支付 套餐权益</p><button>立即支付</button></main>').run(),false);
});
test('hidden and offscreen payment templates do not block and each call sees current visibility',()=>{
  for(const attr of ['hidden','style="display:none"','style="visibility:hidden"','style="opacity:0"','data-x="1500"','data-y="900"']){
    const f=page('<aside '+attr+'>'+payment+'</aside>');assert.equal(f.run(),false,attr);
  }
  const f=page('<aside hidden>'+payment+'</aside>'),root=f.document.querySelector('aside');
  assert.equal(f.run(),false);root.hidden=false;assert.equal(f.run(),true);root.hidden=true;assert.equal(f.run(),false);
});
test('a visible descendant can override inherited visibility hidden',()=>{
  assert.equal(page('<aside style="visibility:hidden"><div style="visibility:visible">'+payment+'</div></aside>').run(),true);
});
test('visible same-origin frames and inherited blank frames are inspected recursively',()=>{
  for(const url of ['https://www.zhipin.com/web/frame/vip','about:blank','about:srcdoc']){
    const top=page('<main>推荐列表</main>'),child=page(payment,url);frame(top,child);assert.equal(top.run(),true,url);
  }
  const top=page(''),middle=page('','about:blank'),child=page(payment,'https://www.zhipin.com/web/frame/vip');
  frame(top,middle);frame(middle,child);assert.equal(top.run(),true);
});
test('hidden, offscreen, clipped and cross-origin frames are never used as evidence',()=>{
  for(const attrs of ['hidden','style="opacity:0"','style="display:none"','data-y="900"']){
    const top=page(''),child=page(payment);frame(top,child,attrs);assert.equal(top.run(),false,attrs);
  }
  for(const url of ['https://example.invalid/payment','https://zhipin.com/web/frame/vip']){
    const top=page(''),child=page(payment,url);frame(top,child);assert.equal(top.run(),false,url);
  }
  const top=page('<aside style="overflow:hidden" data-width="100" data-height="100"></aside>'),child=page(payment);
  const iframe=frame(top,child,'data-x="200"');top.document.querySelector('aside').append(iframe);
  assert.equal(top.run(),false);
});
test('a modal may combine its own price with payment evidence inside a visible same-origin frame',()=>{
  const top=page('<div role="dialog"><h2>VIP账号</h2><p>商品需付 ￥99</p></div>');
  const child=page('<p>扫码支付</p><img class="qrcode">');
  top.document.querySelector('[role="dialog"]').append(frame(top,child));
  assert.equal(top.run(),true);
});
test('unsupported hosts are ignored and a huge ordinary list performs no style or text scan',()=>{
  assert.equal(page(payment,'https://example.invalid/').run(),false);
  const f=page('<article><span>候选人</span><p>履历中提到VIP</p></article>'.repeat(10000));
  assert.equal(f.run(),false);assert.equal(f.styleReads(),0);
});
test('exhausted candidate budget never reports a positive based on partial words',()=>{
  const f=page('<div role="dialog"><p>商品需付 ￥99</p>'+('<i>普通文字</i>'.repeat(2500))+payment+'</div>');
  // A later independently scoped payment widget can still establish its own
  // complete evidence; a partial generic modal cannot do so by itself.
  f.document.querySelector('.vip2-layout').remove();assert.equal(f.run(),false);
});
test('payment detection never clicks any control',()=>{
  const f=page('<div role="dialog"><p>会员套餐 ￥99</p><p>套餐权益</p><button>立即支付</button><button>关闭</button></div>');
  for(const button of f.document.querySelectorAll('button'))button.click=()=>{throw Error('unexpected click');};
  assert.equal(f.run(),true);
});

test('strong payment components are checked before a huge resume dialog or more than eighty templates',()=>{
  const background='<div class="dialog-lib-resume" role="dialog"><section class="resume">'+
    '<p>正常履历</p>'.repeat(6000)+'</section></div>'+'<div role="dialog" hidden>模板</div>'.repeat(100);
  const f=page(background+payment);assert.equal(f.run(),true);
  assert.ok(f.styleReads()<150);
  const ordinary=page(background);assert.equal(ordinary.run(),false);assert.ok(ordinary.styleReads()<150);
});

test('payment inside a visible frame is checked before the parent resume dialog',()=>{
  const f=page('<div role="dialog" class="dialog-lib-resume"><p>普通简历</p>'.repeat(1)+
    '<p>内容</p>'.repeat(6000)+'</div>'),child=page(payment);
  frame(f,child);assert.equal(f.run(),true);assert.ok(f.styleReads()<150);
});

test('a generic VIP checkout with an unlabeled square QR image and split currency is recognized',()=>{
  for(const price of ['<span>¥</span><span>448</span>','<span>¥</span>448','<div>¥</div><div>448</div>']){
    const f=page('<div role="dialog"><h2>VIP套餐</h2><label>商品需付</label><div>'+price+'</div>'+
      '<p>扫码支付</p><img data-width="160" data-height="160"></div>');
    assert.equal(f.run(),true,price);
  }
});

test('prose blocks are never combined into checkout labels even with price and an image',()=>{
  for(const prose of [
    '<p>商品</p><p>需付</p><p>扫码</p><p>支付</p><h2>VIP套餐</h2>',
    '<p>参与开发商品需付和扫码支付界面。</p><p>VIP套餐设计经验。</p>',
    '<p>商品需付及扫码支付功能的方案说明</p><p>VIP套餐</p>',
  ])assert.equal(page('<div role="dialog"><article>'+prose+
    '<div><span>¥</span><span>448</span></div><img data-width="160" data-height="160"></article></div>').run(),false);
});

test('BOSS popup wrappers without ARIA are only scopes and still need full payment evidence',()=>{
  for(const name of ['boss-popup__wrapper','boss-dialog__wrapper']){
    assert.equal(page('<div class="'+name+'"><h2>VIP套餐</h2><p>商品需付</p>'+
      '<div><span>¥</span><span>448</span></div><p>扫码支付</p><img data-width="160" data-height="160"></div>').run(),true);
    assert.equal(page('<div class="'+name+'"><p>开发VIP套餐，商品需付448元和扫码支付功能。</p>'+
      '<img data-width="160" data-height="160"></div>').run(),false);
  }
});
