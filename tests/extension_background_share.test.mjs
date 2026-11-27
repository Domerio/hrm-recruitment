import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const png='data:image/png;base64,'+'A'.repeat(80);

function fixture({source='img',extraImage=false,extraCard=false,nestedHints=false,loaded=true,tainted=false,
  openCardOnForward=false,omitOther=false,extraOther=false,externalLabel=false,externalCard=false,iconTab=false,
  recipientPane=false,otherShowsQr=true,delayedMenu=false,lastShareBadge=false,bodyNoise=0,
  splitTab=false,realisticGeometry=false,previousRuntime=false,classTabs=false,
  ancestorShare=false,siblingShare=false,colleague=false,duplicateCai=false,noToast=false,
  divSend=false,duplicateSend=false}={}){
  const otherLabel=splitTab?'<span>转发至<strong>其他</strong></span>':iconTab?'<i>↗</i><span>转发至其他</span>':'转发至其他';
  const otherTab=classTabs?`<div class="item other"><div class="item-content"><div class="item-label">${otherLabel}</div>${lastShareBadge?'<div class="icon-shared">上次分享</div>':''}</div></div>`:
    `<button class="other">${otherLabel}${lastShareBadge?'<small>上次分享</small>':''}</button>`;
  const emailTab=classTabs?'<div class="item"><div class="item-content"><div class="item-label">邮件转发</div></div></div>':
    `<button>${recipientPane?'<span>邮件转发</span>':'邮件转发'}</button>`;
  const extraTab=classTabs?'<div class="item extra-other"><div class="item-label">转发至其他</div></div>':'<button class="extra-other">转发至其他</button>';
  const navOpen=classTabs?'<div class="left-list"><div class="nav-list"><div class="item"><div class="item-label">站内同事</div></div>':'<aside><button><span>站内同事</span></button>';
  const navClose=classTabs?'</div></div>':'</aside>';
  const {window:domWindow}=parseHTML(`<!doctype html><html><body>
    <div class="dialog-lib-resume"><div class="resume-detail-wrap"><iframe src="https://www.zhipin.com/web/frame/c-resume/"></iframe></div><button class="forward">转发</button></div>
    ${'<i>x</i>'.repeat(bodyNoise)}
    ${externalLabel?'<button>转发至其他</button>':''}
    ${externalCard?'<section class="outside-card"><p>可识别二维码查看详情</p><img></section>':''}
    ${realisticGeometry?'<div class="boss-popup">':''}<div class="share-menu c-share-box dialog-default-v2" hidden>${recipientPane?'<h2>转发</h2>'+navOpen:''}${omitOther?'':otherTab}${extraOther?extraTab:''}${emailTab}${recipientPane?navClose:''}<button aria-label="关闭">×</button>
      ${recipientPane?'<section class="recipients right-content" hidden><input placeholder="姓名、职位、邮箱">'+(colleague?'<div class="recent">最近联系：<button class="recent-cai">蔡女士</button>'+(duplicateCai?'<button class="recent-cai">蔡女士</button>':'')+'</div>':'')+'<textarea placeholder="请输入留言"></textarea>'+(divSend?'<div class="send"><span>转发</span></div>':'<button class="send">转发</button>')+(duplicateSend?'<div class="send-copy">转发</div>':'')+'</section>':''}
      <section class="card" hidden>${nestedHints?'<div class="image-frame">':''}<p>可识别二维码查看详情</p><${source} class="source"></${source}>${nestedHints?'</div><p>右键复制图片发送至微信好友</p>':''}${extraImage?'<img class="extra">':''}</section>
      ${extraCard?'<section class="card" hidden><p>右键复制图片发送至微信好友</p><img></section>':''}
    </div>${realisticGeometry?'</div>':''}</body></html>`);
  const {document,HTMLElement}=domWindow;
  // Isolate browsing contexts: linkedom's window proxies share global slots,
  // whereas the recommendation iframe and top page have separate globals.
  const window={document};
  Object.defineProperty(document,'defaultView',{configurable:true,value:window});
  Object.defineProperties(HTMLElement.prototype,{
    getClientRects:{configurable:true,value(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];}},
    getBoundingClientRect:{configurable:true,value(){
      const close=this.hasAttribute('aria-label'),owner=this.classList.contains('dialog-lib-resume');
      const image=['IMG','CANVAS'].includes(this.tagName);
      let rect=close?{x:470,y:110,width:20,height:20}:owner?{x:0,y:0,width:900,height:700}:
        image?{x:120,y:150,width:300,height:200}:{x:100,y:100,width:400,height:300};
      if(realisticGeometry){
        rect=this.matches('html,body,.boss-popup')?{x:0,y:0,
          width:this.ownerDocument.defaultView.innerWidth||1200,height:this.ownerDocument.defaultView.innerHeight||800}:
          owner?{x:40,y:0,width:1128,height:800}:
          this.classList.contains('share-menu')?{x:112,y:145,width:686,height:386}:
          close?{x:754,y:160,width:30,height:30}:
          this.matches('aside,.left-list,.nav-list')?{x:146,y:213,width:148,height:280}:
          this.matches('.item')||this.matches('button')&&this.closest('aside')?{x:146,y:290,width:148,height:76}:
          this.matches('span,strong,small,.item-content,.item-label,.icon-shared')?{x:192,y:this.matches('small,.icon-shared')?295:320,width:70,height:20}:
          image?{x:340,y:280,width:120,height:120}:
          this.tagName==='P'?{x:340,y:410,width:250,height:20}:
          {x:318,y:213,width:456,height:280};
      }
      return {...rect,left:rect.x,top:rect.y,right:rect.x+rect.width,bottom:rect.y+rect.height};
    }},
  });
  const metrics={draws:0,encoded:0,otherClicks:0,extraOtherClicks:0,sendClicks:0,forwardClicks:0,colleagueClicks:0,previousStops:0};
  const toDataURL=()=>{
    metrics.encoded++;
    if(tainted){const error=Error('test tainted canvas');error.name='SecurityError';throw error;}
    return png;
  };
  const createElement=document.createElement.bind(document);
  document.createElement=tag=>{
    const element=createElement(tag);
    if(tag==='canvas'){
      element.getContext=()=>({drawImage(){metrics.draws++;}});
      element.toDataURL=toDataURL;
    }
    return element;
  };
  const image=document.querySelector('.source');
  if(source==='img')Object.defineProperties(image,{
    naturalWidth:{value:600,configurable:true},naturalHeight:{value:400,configurable:true},complete:{value:loaded,configurable:true},
  });
  else {image.width=600;image.height=400;image.toDataURL=toDataURL;}
  const menu=document.querySelector('.share-menu'),owner=document.querySelector('.dialog-lib-resume');
  const recipients=menu.querySelector('.recipients'),cards=[...menu.querySelectorAll('.card')];
  const showMenu=()=>{
    menu.hidden=false;
    if(recipientPane)recipients.hidden=false;
    if(openCardOnForward)for(const card of cards)card.hidden=false;
  };
  document.querySelector('.forward').addEventListener('click',()=>{
    metrics.forwardClicks++;
    if(delayedMenu)queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(showMenu)));
    else showMenu();
  });
  document.querySelector('.other')?.addEventListener('click',()=>{
    metrics.otherClicks++;
    if(recipientPane&&otherShowsQr)recipients.hidden=true;
    if(!recipientPane||otherShowsQr)for(const card of cards)card.hidden=false;
  });
  for(const chip of document.querySelectorAll('.recent-cai'))chip.addEventListener('click',()=>{metrics.colleagueClicks++;chip.setAttribute('data-selected','true');});
  document.querySelector('.send')?.addEventListener('click',()=>{
    metrics.sendClicks++;
    if(colleague&&metrics.colleagueClicks===1&&!noToast){
      const toast=menu.ownerDocument.createElement('div');toast.textContent='转发成功';
      menu.ownerDocument.body.appendChild(toast);menu.hidden=true;
    }
  });
  document.querySelector('.extra-other')?.addEventListener('click',()=>{metrics.extraOtherClicks++;});
  document.querySelector('[aria-label=关闭]').addEventListener('click',()=>{menu.hidden=true;});
  const context={window,document,URL,innerWidth:1200,innerHeight:800,
    location:{protocol:'https:',hostname:'www.zhipin.com',origin:'https://www.zhipin.com',pathname:'/web/chat/search'},
    getComputedStyle:element=>({visibility:'visible',display:element.hidden?'none':'block',overflowY:'visible'}),
    setTimeout:fn=>queueMicrotask(fn),clearTimeout(){},
  };
  Object.assign(window,{location:context.location,innerWidth:1200,innerHeight:800,
    getComputedStyle:context.getComputedStyle,top:window,parent:window,frameElement:null});
  let topDocument=document,topWindow=window,host=null,siblingDocument=null;
  if(ancestorShare||siblingShare){
    topDocument=parseHTML('<!doctype html><html><body><iframe name="recommendFrame" src="https://www.zhipin.com/web/frame/recommend/"></iframe></body></html>').document;
    topWindow={document:topDocument,innerWidth:1600,innerHeight:1000,
      location:new URL('https://www.zhipin.com/web/chat/recommend'),getComputedStyle:context.getComputedStyle};
    Object.assign(topWindow,{top:topWindow,parent:topWindow,frameElement:null});
    Object.defineProperty(topDocument,'defaultView',{configurable:true,value:topWindow});
    context.location=new URL('https://www.zhipin.com/web/frame/recommend/');
    host=topDocument.querySelector('iframe');
    Object.defineProperties(host,{
      contentDocument:{configurable:true,value:document},contentWindow:{configurable:true,value:window},
      getBoundingClientRect:{configurable:true,value:()=>({x:210,y:40,left:210,top:40,right:1410,bottom:840,width:1200,height:800})},
    });
    Object.assign(window,{location:context.location,parent:topWindow,top:topWindow,frameElement:host});
    let destination=topDocument;
    if(siblingShare){
      siblingDocument=parseHTML('<!doctype html><html><body></body></html>').document;
      const sibling=topDocument.createElement('iframe');sibling.name='unrelatedFrame';
      sibling.src='https://www.zhipin.com/web/frame/unrelated/';
      Object.defineProperty(sibling,'contentDocument',{configurable:true,value:siblingDocument});
      topDocument.body.appendChild(sibling);destination=siblingDocument;
    }
    const portal=realisticGeometry?menu.parentElement:menu;
    destination.body.appendChild(portal);
    // linkedom does not adopt ownerDocument when moving between documents.
    // Browsers do, so explicitly model adoption for this portal subtree.
    const adopt=node=>{node.ownerDocument=destination;for(const child of node.childNodes)adopt(child);};
    adopt(portal);
  }
  const resumeDocument=parseHTML('<!doctype html><html><body><canvas></canvas></body></html>').document;
  const resumeWindow={document:resumeDocument,location:new URL('https://www.zhipin.com/web/frame/c-resume/'),parent:window,top:topWindow};
  Object.defineProperty(resumeDocument,'defaultView',{configurable:true,value:resumeWindow});
  const resumeFrame=owner.querySelector('iframe');
  Object.defineProperties(resumeFrame,{contentDocument:{configurable:true,value:resumeDocument},contentWindow:{configurable:true,value:resumeWindow}});
  resumeWindow.frameElement=resumeFrame;
  vm.runInNewContext(fs.readFileSync(new URL('../extension/dom-reader.js',import.meta.url),'utf8'),context);
  if(previousRuntime)window.__hrmAuto={version:22,run:async action=>{
    if(action==='stop')metrics.previousStops++;
    else throw Error('old adapter still installed');
  }};
  const reinject=()=>{
    vm.runInNewContext(fs.readFileSync(new URL('../extension/automation.js',import.meta.url),'utf8'),context);
    return window.__hrmAuto;
  };
  reinject();
  return {document,owner,image,metrics,dom:window.__hrmDom,api:window.__hrmAuto,
    menu,topDocument,topWindow,host,siblingDocument,
    reinject,
    open:()=>window.__hrmAuto.run('share',{name:'张**',kind:'canvas'})};
}

test('high-score colleague forwarding selects only the recent Cai contact and confirms success',async()=>{
  const f=fixture({recipientPane:true,colleague:true,classTabs:true,ancestorShare:true});
  const prepared=await f.api.run('prepare-colleague',{name:'张**',kind:'canvas'});
  assert.equal(prepared.recipient,'蔡女士');
  assert.equal(f.metrics.colleagueClicks,1);
  assert.equal(f.metrics.sendClicks,0);
  const result=await f.api.run('send-colleague',{token:prepared.token});
  assert.equal(result.sent,true);
  assert.equal(f.metrics.sendClicks,1);
  assert.equal(f.topDocument.body.textContent.includes('转发成功'),true);
  await assert.rejects(f.api.run('send-colleague',{token:prepared.token}),/转发窗口|候选人|会话/);
  assert.equal(f.metrics.sendClicks,1);
});

test('colleague forwarding clicks the nested send label in a div control',async()=>{
  const f=fixture({recipientPane:true,colleague:true,classTabs:true,divSend:true});
  const prepared=await f.api.run('prepare-colleague',{name:'张**',kind:'canvas'});
  assert.equal(f.metrics.colleagueClicks,1);
  assert.equal(f.metrics.sendClicks,0);
  const sent=await f.api.run('send-colleague',{token:prepared.token});
  assert.equal(sent.sent,true);
  assert.equal(f.metrics.sendClicks,1);
});

test('ambiguous send controls inside recipient pane do not send',async()=>{
  const f=fixture({recipientPane:true,colleague:true,divSend:true,duplicateSend:true});
  await assert.rejects(f.api.run('prepare-colleague',{name:'张**',kind:'canvas'}),/唯一可用的站内转发按钮/);
  assert.equal(f.metrics.sendClicks,0);
});

test('missing or duplicate Cai contact never clicks send',async()=>{
  for(const options of [{colleague:false},{colleague:true,duplicateCai:true}]){
    const f=fixture({recipientPane:true,classTabs:true,...options});
    await assert.rejects(f.api.run('prepare-colleague',{name:'张**',kind:'canvas'}),/蔡女士/);
    assert.equal(f.metrics.sendClicks,0);
    await f.api.run('closeShare');
  }
});

test('an uncertain send result is never retried in the same session',async()=>{
  const f=fixture({recipientPane:true,colleague:true,noToast:true});
  const prepared=await f.api.run('prepare-colleague',{name:'张**',kind:'canvas'});
  await assert.rejects(f.api.run('send-colleague',{token:prepared.token}),/未见|人工核对/);
  await assert.rejects(f.api.run('send-colleague',{token:prepared.token}),/未重复发送/);
  assert.equal(f.metrics.sendClicks,1);
});

test('configured colleague recipient is matched exactly and returned after confirmed sending',async()=>{
  const f=fixture({recipientPane:true,colleague:true,classTabs:true,ancestorShare:true});
  f.menu.querySelector('.recent-cai').textContent='王经理';
  const prepared=await f.api.run('prepare-colleague',{name:'张**',kind:'canvas',recipient:'王经理'});
  assert.equal(prepared.recipient,'王经理');assert.equal(f.metrics.colleagueClicks,1);
  const result=await f.api.run('send-colleague',{token:prepared.token});
  assert.equal(result.recipient,'王经理');assert.equal(result.sent,true);assert.equal(f.metrics.sendClicks,1);
});

test('empty, excessive and control-character colleague names fail before opening any share window',async()=>{
  for(const recipient of ['', '   ', null, '甲'.repeat(41), '李\u0000经理', '李\n经理', '李\t经理', '李\u007f经理']){
    const f=fixture({recipientPane:true,colleague:true});
    await assert.rejects(f.api.run('prepare-colleague',{name:'张**',kind:'canvas',recipient}),/显示名称/);
    assert.equal(f.metrics.forwardClicks,0);assert.equal(f.metrics.colleagueClicks,0);assert.equal(f.metrics.sendClicks,0);
  }
});

test('one-to-forty displayed recipient characters and deliberate internal spaces are preserved',async()=>{
  for(const recipient of ['李', '甲'.repeat(40), '张 三']){
    const f=fixture({recipientPane:true,colleague:true});f.menu.querySelector('.recent-cai').textContent=recipient;
    const prepared=await f.api.run('prepare-colleague',{name:'张**',kind:'canvas',recipient});
    assert.equal(prepared.recipient,recipient);assert.equal(f.metrics.colleagueClicks,1);assert.equal(f.metrics.sendClicks,0);
  }
});

test('partial-name and whitespace-normalized matches are never substituted for an exact recipient',async()=>{
  for(const displayed of ['王女士助理', '王女士（采购）', '王 女士']){
    const f=fixture({recipientPane:true,colleague:true});f.menu.querySelector('.recent-cai').textContent=displayed;
    await assert.rejects(f.api.run('prepare-colleague',{name:'张**',kind:'canvas',recipient:'王女士'}),/唯一的“王女士”/);
    assert.equal(f.metrics.colleagueClicks,0);assert.equal(f.metrics.sendClicks,0);
  }
});

test('an exact configured name in search results is not treated as a recent contact',async()=>{
  const f=fixture({recipientPane:true,colleague:true});
  f.menu.querySelector('.recent').firstChild.textContent='搜索结果：';
  f.menu.querySelector('.recent-cai').textContent='王经理';
  await assert.rejects(f.api.run('prepare-colleague',{name:'张**',kind:'canvas',recipient:'王经理'}),/最近联系/);
  assert.equal(f.metrics.colleagueClicks,0);assert.equal(f.metrics.sendClicks,0);
});

test('a selected recipient chip outside the recent section is not a second recent contact',async()=>{
  const f=fixture({recipientPane:true,colleague:true});
  f.menu.querySelector('.recent-cai').addEventListener('click',()=>{
    const chip=f.document.createElement('span');chip.textContent='蔡女士';
    f.menu.querySelector('.recipients').prepend(chip);
  });
  const prepared=await f.api.run('prepare-colleague',{name:'张**',kind:'canvas'});
  assert.equal((await f.api.run('send-colleague',{token:prepared.token})).recipient,'蔡女士');
  assert.equal(f.metrics.sendClicks,1);
});

test('renamed, duplicated, replaced or deselected recipient invalidates a prepared send',async()=>{
  const changes=[
    f=>{f.menu.querySelector('.recent-cai').textContent='另一位同事';},
    f=>{const chip=f.menu.querySelector('.recent-cai');chip.after(chip.cloneNode(true));},
    f=>{const chip=f.menu.querySelector('.recent-cai');chip.replaceWith(chip.cloneNode(true));},
    f=>{f.menu.querySelector('.recent-cai').setAttribute('data-selected','false');},
  ];
  for(const change of changes){
    const f=fixture({recipientPane:true,colleague:true});f.menu.querySelector('.recent-cai').textContent='李经理';
    const prepared=await f.api.run('prepare-colleague',{name:'张**',kind:'canvas',recipient:'李经理'});
    change(f);
    await assert.rejects(f.api.run('send-colleague',{token:prepared.token}),/李经理/);
    assert.equal(f.metrics.sendClicks,0);
  }
});

test('same-root candidate iframe or Canvas replacement invalidates the recipient session before sending',async()=>{
  for(const change of [
    f=>{f.owner.querySelector('iframe').src='https://www.zhipin.com/web/frame/c-resume/?other=1';},
    f=>{const doc=f.owner.querySelector('iframe').contentDocument;doc.querySelector('canvas').replaceWith(doc.createElement('canvas'));},
  ]){
    const f=fixture({recipientPane:true,colleague:true});
    const prepared=await f.api.run('prepare-colleague',{name:'张**',kind:'canvas'});change(f);
    await assert.rejects(f.api.run('send-colleague',{token:prepared.token}),/简历|框架|候选人/);
    assert.equal(f.metrics.sendClicks,0);
  }
});

test('candidate replacement after the send click stays unconfirmed and is not sent again',async()=>{
  const f=fixture({recipientPane:true,colleague:true});
  const prepared=await f.api.run('prepare-colleague',{name:'张**',kind:'canvas'});
  f.menu.querySelector('.send').addEventListener('click',()=>{
    const doc=f.owner.querySelector('iframe').contentDocument;doc.querySelector('canvas').replaceWith(doc.createElement('canvas'));
  });
  await assert.rejects(f.api.run('send-colleague',{token:prepared.token}),/候选人简历已变化/);
  await assert.rejects(f.api.run('send-colleague',{token:prepared.token}),/候选人|转发窗口|会话|未重复/);
  assert.equal(f.metrics.sendClicks,1);
});

test('background sharing reads the exact loaded image or canvas without screenshot or focus APIs',async()=>{
  for(const source of ['img','canvas']){
    const f=fixture({source});
    const rect=await f.open();
    assert.equal(rect.name,'张**');assert.equal(rect.rect.width,400);
    assert.equal(rect.coordinateSpace,'owner');
    const result=await f.api.run('share-image');
    assert.equal(result.image,png);
    assert.equal(f.metrics.draws,source==='img'?1:0);
    assert.equal(f.metrics.encoded,1);
  }
});

test('a recommendation iframe opens and reads the share portal in its same-origin top document',async()=>{
  const f=fixture({recipientPane:true,lastShareBadge:true,realisticGeometry:true,classTabs:true,ancestorShare:true});
  assert.equal(f.document.querySelector('.share-menu'),null);
  assert.equal(f.topDocument.querySelector('.dialog-lib-resume'),null);
  assert.equal(f.menu.ownerDocument,f.topDocument);
  const result=await f.open();
  assert.equal(result.name,'张**');
  assert.equal(result.coordinateSpace,'top');
  assert.equal(result.frameKey,'https://www.zhipin.com/web/chat/recommend');
  assert.equal(result.viewport.width,1600);
  assert.equal(result.viewport.height,1000);
  // The QR card's native top-document rectangle must not receive the
  // recommendation iframe's additional (210, 40) offset.
  assert.equal(result.rect.x,318);
  assert.equal(result.rect.y,213);
  assert.equal(result.rect.width,456);
  assert.equal(result.rect.height,280);
  assert.equal(f.metrics.forwardClicks,1);
  assert.equal(f.metrics.otherClicks,1);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal((await f.api.run('share-image')).image,png);
  await f.api.run('closeShare');
  assert.equal(f.menu.hidden,true);
});

test('top-page navigation or replacement of the recommendation iframe invalidates the share session',async()=>{
  const navigated=fixture({recipientPane:true,ancestorShare:true});
  await navigated.open();
  navigated.topWindow.location=new URL('https://www.zhipin.com/web/chat/search');
  await assert.rejects(navigated.api.run('share-image'),/分享|框架|页面|切换|变化/);
  assert.equal(navigated.metrics.encoded,0);

  const replaced=fixture({recipientPane:true,ancestorShare:true});
  await replaced.open();
  replaced.host.replaceWith(replaced.host.cloneNode(true));
  await assert.rejects(replaced.api.run('share-image'),/分享|框架|页面|切换|变化/);
  assert.equal(replaced.metrics.encoded,0);

  const documentSwap=fixture({recipientPane:true,ancestorShare:true});
  await documentSwap.open();
  Object.defineProperty(documentSwap.host,'contentDocument',{configurable:true,value:{}});
  await assert.rejects(documentSwap.api.run('share-image'),/分享|框架|页面|切换|变化/);
  assert.equal(documentSwap.metrics.encoded,0);
});

test('a share-looking modal in an unrelated sibling frame is never selected',async()=>{
  const f=fixture({recipientPane:true,classTabs:true,siblingShare:true});
  assert.equal(f.document.querySelector('.share-menu'),null);
  assert.equal(f.topDocument.querySelector('.share-menu'),null);
  assert.equal(f.siblingDocument.querySelector('.share-menu'),f.menu);
  await assert.rejects(f.open(),/分享窗口/);
  assert.equal(f.metrics.otherClicks,0);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal(f.metrics.encoded,0);
});

test('ancestor share lookup does not enter a different-origin top document',async()=>{
  const f=fixture({recipientPane:true,ancestorShare:true});
  f.topWindow.location=new URL('https://other.example.invalid/');
  await assert.rejects(f.open(),/分享窗口|同源|父级/);
  assert.equal(f.metrics.otherClicks,0);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal(f.metrics.encoded,0);
});

test('a QR card already visible after opening share does not require a unique tab label',async()=>{
  for(const options of [{omitOther:true},{extraOther:true}]){
    const f=fixture({...options,openCardOnForward:true});
    assert.equal((await f.open()).name,'张**');
    assert.equal((await f.api.run('share-image')).image,png);
    assert.equal(f.metrics.otherClicks,0);
    await f.api.run('closeShare');
    assert.equal(f.document.querySelector('.share-menu').hidden,true);
  }
});

test('recipient search as the default share pane still reaches an explicit QR tab in the same modal',async()=>{
  const f=fixture({recipientPane:true,lastShareBadge:true,externalLabel:true,externalCard:true});
  assert.equal(f.document.querySelector('.recipients').hidden,true);
  const opened=await f.open();
  assert.equal(opened.name,'张**');
  assert.equal(f.metrics.forwardClicks,1);
  assert.equal(f.metrics.otherClicks,1);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal(f.document.querySelector('.recipients').hidden,true);
  assert.equal((await f.api.run('share-image')).image,png);
  await f.api.run('closeShare');
  assert.equal(f.document.querySelector('.share-menu').hidden,true);
});

test('split inline tab text with a separate last-share badge opens QR in a realistically sized modal',async()=>{
  const f=fixture({recipientPane:true,splitTab:true,lastShareBadge:true,realisticGeometry:true,classTabs:true});
  assert.equal(f.document.querySelector('.nav-list').getBoundingClientRect().width,148);
  assert.equal(f.document.querySelector('.other').tagName,'DIV');
  const opened=await f.open();
  assert.equal(opened.name,'张**');
  assert.equal(f.metrics.forwardClicks,1);
  assert.equal(f.metrics.otherClicks,1);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal(f.document.querySelector('.recipients').hidden,true);
  assert.equal((await f.api.run('share-image')).image,png);
  await f.api.run('closeShare');
  assert.equal(f.document.querySelector('.share-menu').hidden,true);
});

test('two actual tabs remain ambiguous when one label is split across inline elements',async()=>{
  const f=fixture({recipientPane:true,splitTab:true,lastShareBadge:true,realisticGeometry:true,extraOther:true,classTabs:true});
  await assert.rejects(f.open(),/没有唯一的“转发至其他”入口/);
  assert.equal(f.metrics.otherClicks,0);
  assert.equal(f.metrics.extraOtherClicks,0);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal(f.metrics.encoded,0);
});

test('a missing share tab reports the loaded version and detected entries without clicking or sending',async()=>{
  const f=fixture({recipientPane:true,omitOther:true,realisticGeometry:true,classTabs:true});
  await assert.rejects(f.open(),error=>{
    assert.match(error.message,/未找到“转发至其他”文字/);
    assert.match(error.message,/0\.5\.98/);
    assert.match(error.message,/其他入口 0，邮件入口 1，窗口 0/);
    return true;
  });
  assert.equal(f.metrics.otherClicks,0);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal(f.metrics.encoded,0);
});

test('a share menu hosted in a shadow root is discovered, switched and closed in that same root',async()=>{
  const f=fixture(),menu=f.document.querySelector('.share-menu');
  const other=menu.querySelector('.other'),card=menu.querySelector('.card');
  const children=[...menu.childNodes],shadow=menu.attachShadow({mode:'open'});
  for(const child of children)shadow.appendChild(child);
  other.addEventListener('click',()=>{card.hidden=false;});
  await f.open();
  assert.equal(f.metrics.otherClicks,1);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal((await f.api.run('share-image')).image,png);
  await f.api.run('closeShare');
  assert.equal(menu.hidden,true);
});

test('reinjecting the current adapter replaces runtime 22 and preserves the new share session on another injection',async()=>{
  const f=fixture({recipientPane:true,previousRuntime:true});
  assert.ok(Number.isSafeInteger(f.api.version)&&f.api.version>22);
  assert.equal(f.metrics.previousStops,1);
  await f.open();
  assert.equal(f.reinject(),f.api);
  assert.equal((await f.api.run('share-image')).image,png);
  assert.equal(f.metrics.forwardClicks,1);
  assert.equal(f.metrics.otherClicks,1);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal(f.metrics.previousStops,1);
});

test('a share modal appended beyond the global DOM walk limit still clicks its unique QR tab',async()=>{
  const f=fixture({recipientPane:true,lastShareBadge:true,bodyNoise:20050});
  assert.equal(f.dom.view(f.document.body).stats.truncated,true);
  const result=await f.open();
  assert.equal(result.name,'张**');
  assert.equal(f.metrics.forwardClicks,1);
  assert.equal(f.metrics.otherClicks,1);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal((await f.api.run('share-image')).image,png);
  assert.equal(f.dom.view(f.document.body).elements.includes(f.document.querySelector('.share-menu')),false);
});

test('a share modal mounted after the initial check is found without clicking forward twice',async()=>{
  const f=fixture({recipientPane:true,delayedMenu:true});
  const opened=await f.open();
  assert.equal(opened.name,'张**');
  assert.equal(f.metrics.forwardClicks,1);
  assert.equal(f.metrics.otherClicks,1);
  assert.equal((await f.api.run('share-image')).image,png);
});

test('recipient search with no QR never submits a recipient or substitutes an unrelated image',async()=>{
  const f=fixture({recipientPane:true,otherShowsQr:false,iconTab:true,externalCard:true});
  await assert.rejects(f.open(),/二维码|分享卡/);
  assert.equal(f.metrics.otherClicks,1);
  assert.equal(f.metrics.sendClicks,0);
  assert.equal(f.metrics.encoded,0);
  assert.equal(f.metrics.draws,0);
  assert.equal(f.document.querySelector('.recipients').hidden,false);
  await f.api.run('closeShare');
  assert.equal(f.document.querySelector('.share-menu').hidden,true);
});

test('the share tab is bound to its menu even with another visible label or QR outside it',async()=>{
  const f=fixture({externalLabel:true,externalCard:true,iconTab:true});
  assert.equal((await f.open()).name,'张**');
  assert.equal(f.metrics.otherClicks,1);
  assert.equal((await f.api.run('share-image')).image,png);
  await f.api.run('closeShare');
  assert.equal(f.document.querySelector('.share-menu').hidden,true);
  const ambiguous=fixture({extraOther:true});
  await assert.rejects(ambiguous.open(),/没有唯一的“转发至其他”入口/);
  assert.equal(ambiguous.metrics.otherClicks,0);
});

test('ambiguous cards or multiple images never silently pick a screenshot source',async()=>{
  const cards=fixture({extraCard:true});
  await assert.rejects(cards.open(),/卡片不唯一/);
  const images=fixture({extraImage:true});await images.open();
  await assert.rejects(images.api.run('share-image'),/没有唯一/);
  assert.equal(images.metrics.encoded,0);
});

test('nested hints that identify the same actual image are one share card',async()=>{
  for(const source of ['img','canvas']){
    const f=fixture({source,nestedHints:true});
    const card=f.document.querySelector('.card'),frame=f.document.querySelector('.image-frame');
    Object.defineProperty(card,'getBoundingClientRect',{value:()=>({x:100,y:100,left:100,top:100,right:500,bottom:500,width:400,height:400})});
    Object.defineProperty(frame,'getBoundingClientRect',{value:()=>({x:110,y:110,left:110,top:110,right:490,bottom:400,width:380,height:290})});
    const result=await f.open();
    assert.equal(result.rect.width,400);assert.equal(result.rect.height,400);
    assert.equal((await f.api.run('share-image')).image,png);
    assert.equal(f.metrics.encoded,1);
  }
});

test('nested hint deduplication cannot discard another image or a separate share card',async()=>{
  for(const options of [{extraImage:true},{extraCard:true}]){
    const f=fixture({nestedHints:true,...options});
    // Identical URL/geometry does not make different DOM image nodes equivalent.
    for(const image of f.document.querySelectorAll('img'))image.src='https://example.invalid/same.png';
    await assert.rejects(f.open(),/卡片不唯一/);
    assert.equal(f.metrics.encoded,0);assert.equal(f.metrics.draws,0);
  }
});

test('loading and cross-origin canvas restrictions pause with a readable explanation',async()=>{
  const loading=fixture({loaded:false});await loading.open();
  await assert.rejects(loading.api.run('share-image'),/尚未完整加载/);
  assert.equal(loading.metrics.encoded,0);
  for(const source of ['img','canvas']){
    const tainted=fixture({tainted:true,source});await tainted.open();
    await assert.rejects(tainted.api.run('share-image'),/平台限制直接读取/);
  }
});

test('candidate replacement, iframe navigation, and detached cards invalidate the saved image scope',async()=>{
  const owner=fixture();await owner.open();owner.owner.replaceWith(owner.owner.cloneNode(true));
  await assert.rejects(owner.api.run('share-image'),/简历已切换/);
  const frame=fixture();await frame.open();frame.document.querySelector('iframe').src='https://www.zhipin.com/web/frame/c-resume/?candidate=other';
  await assert.rejects(frame.api.run('share-image'),/页面框架已切换/);
  const documentSwap=fixture(),iframe=documentSwap.document.querySelector('iframe');
  Object.defineProperty(iframe,'contentDocument',{value:{},configurable:true});await documentSwap.open();
  Object.defineProperty(iframe,'contentDocument',{value:{},configurable:true});
  await assert.rejects(documentSwap.api.run('share-image'),/页面框架已切换/);
  const detached=fixture();await detached.open();detached.document.querySelector('.card').remove();
  await assert.rejects(detached.api.run('share-image'),/卡片已关闭/);
});

test('closing, stopping, and resetting clear the image scope',async()=>{
  for(const action of ['closeShare','stop','reset']){
    const f=fixture();await f.open();await f.api.run(action);
    await assert.rejects(f.api.run('share-image'),action==='stop'?/任务已停止/:/卡片已关闭/);
    assert.equal(f.metrics.encoded,0);
  }
});

test('unusable dimensions and invalid or oversized PNG payloads fail before saving',async()=>{
  const oversized=fixture({source:'canvas'});await oversized.open();oversized.image.width=9000;
  await assert.rejects(oversized.api.run('share-image'),/尺寸超出限制/);
  assert.equal(oversized.metrics.encoded,0);
  for(const image of ['data:,','data:image/png;base64,','data:image/png;base64,'+'A'.repeat(2800000)]){
    const f=fixture({source:'canvas'});await f.open();f.image.toDataURL=()=>image;
    await assert.rejects(f.api.run('share-image'),/没有有效内容|大小限制/);
  }
});
