// Injected read-only into the BOSS tab. A positive result is a visible payment
// surface, never a request to click, close, purchase, or inspect account state.
export function detectPaymentSurface() {
  const official=value=>{try{const u=new URL(value);return u.protocol==='https:'&&
    ['www.zhipin.com','zhipin.com'].includes(u.hostname);}catch{return false;}};
  if(!official(location.href))return false;
  const origin=new URL(location.href).origin;
  const known='.block-vip2,.vip2-layout,.payment-layout-v2,.rights-table-vip,.pay-wrap-qrcode-v1,'+
    '[class*="payment-layout"],[class*="vip-pay"],[class*="pay-dialog"],[class*="payment-dialog"],[class*="purchase-dialog"]';
  const dialogs='[role="dialog"],dialog[open],[aria-modal="true"],.boss-popup__wrapper,.boss-dialog__wrapper';
  const resume='.dialog-lib-resume,.resume-detail-wrap,.resume-root,.resume-detail,.resume-content,.resume';
  const styles=new WeakMap(),rects=new WeakMap(),parents=new WeakMap(),seenDocs=new Set(),checked=new Set();
  const started=Date.now();let nodes=0,frames=0;
  const available=()=>nodes<8000&&frames<20&&Date.now()-started<100;
  const parent=element=>element?.parentElement||element?.getRootNode?.().host||null;
  const style=(element,win)=>{if(!styles.has(element))styles.set(element,win.getComputedStyle(element));return styles.get(element);};
  const rect=element=>{if(!rects.has(element))rects.set(element,element.getBoundingClientRect());return rects.get(element);};
  const intersect=(a,b)=>({left:Math.max(a.left,b.left),top:Math.max(a.top,b.top),
    right:Math.min(a.right,b.right),bottom:Math.min(a.bottom,b.bottom)});
  const hasArea=r=>[r.left,r.top,r.right,r.bottom].every(Number.isFinite)&&r.right>r.left&&r.bottom>r.top;
  const painted=(element,win)=>{
    if(parents.has(element))return parents.get(element);
    const chain=[];let current=element,yes=true;
    for(let depth=0;current&&depth<96;depth++,current=parent(current)){
      if(parents.has(current)){yes=parents.get(current);current=null;break;}
      chain.push(current);const s=style(current,win);
      if(current.hidden||current.getAttribute('aria-hidden')==='true'||s.display==='none'||
          s.contentVisibility==='hidden'||Number(s.opacity)===0){yes=false;current=null;break;}
    }
    if(current)yes=false;
    for(const item of chain)parents.set(item,yes);
    return yes;
  };
  const visibleBox=(element,win,viewport,container=false)=>{
    if(!element?.isConnected||!painted(element,win))return null;
    const s=style(element,win);
    // visibility may be explicitly restored on a descendant. Scope containers
    // can still be searched, but every piece of evidence must itself be visible.
    if(!container&&['hidden','collapse'].includes(s.visibility))return null;
    let area=intersect(rect(element),viewport),p=parent(element),depth=0,fixed=s.position==='fixed';
    for(;p&&depth<96;p=parent(p),depth++){
      const ps=style(p,win),r=rect(p);
      const containing=['transform','perspective','filter','backdropFilter'].some(key=>ps[key]&&ps[key]!=='none')||
        /(?:paint|layout|strict|content)/.test(ps.contain||'')||/(?:transform|perspective|filter)/.test(ps.willChange||'');
      if(fixed&&containing)fixed=false;
      if(!fixed&&/hidden|clip|auto|scroll/.test(ps.overflowX||ps.overflow||'')){
        area.left=Math.max(area.left,r.left);area.right=Math.min(area.right,r.right);
      }
      if(!fixed&&/hidden|clip|auto|scroll/.test(ps.overflowY||ps.overflow||'')){
        area.top=Math.max(area.top,r.top);area.bottom=Math.min(area.bottom,r.bottom);
      }
      if(ps.position==='fixed')fixed=true;
    }
    return !p&&hasArea(area)?area:null;
  };
  const frameView=(frame,win,viewport)=>{
    const area=visibleBox(frame,win,viewport);if(!area)return null;
    if(++frames>20)return null;
    try{
      const child=frame.contentWindow,doc=frame.contentDocument;
      if(!child||!doc?.body||child.document!==doc)return null;
      const href=child.location.href;
      if(!['about:blank','about:srcdoc'].includes(href)&&
          (!official(href)||new URL(href).origin!==origin))return null;
      const r=rect(frame),width=child.innerWidth,height=child.innerHeight;
      if(!(width>0&&height>0&&r.width>0&&r.height>0))return null;
      const scaleX=r.width/(frame.offsetWidth||r.width),scaleY=r.height/(frame.offsetHeight||r.height);
      const left=r.left+(frame.clientLeft||0)*scaleX,top=r.top+(frame.clientTop||0)*scaleY;
      const clip=intersect({left:(area.left-left)/scaleX,top:(area.top-top)/scaleY,
        right:(area.right-left)/scaleX,bottom:(area.bottom-top)/scaleY},{left:0,top:0,right:width,bottom:height});
      return hasArea(clip)?{win:child,doc,viewport:clip}:null;
    }catch{return null;}
  };
  const evidence=(root,win,viewport)=>{
    const pending=[{element:root,win,viewport,depth:0,field:root}],snippets=[];
    let paymentWidget=false,payControl=false,qr=false,squareImage=false,count=0;
    while(pending.length&&available()){
      const item=pending.pop(),element=item.element;
      if(element.nodeType===3){
        if(item.shown){
          const label=element.textContent.normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/g,'');
          if(label&&label.length<=160)snippets.push({label,field:item.field});
        }
        continue;
      }
      if(element.nodeType!==1)continue;
      if(++count>2400||++nodes>8000||item.depth>64)return false;
      if(!visibleBox(element,item.win,item.viewport,true))continue;
      const shown=!!visibleBox(element,item.win,item.viewport);
      const semantic=['class','id','aria-label','title','data-role'].map(key=>element.getAttribute(key)||'').join(' ');
      if(shown&&element.matches(known))paymentWidget=true;
      if(shown&&element.matches('img,canvas,svg')&&/(?:qr[-_ ]?code|pay[-_ ]?code|支付码|付款码)/i.test(semantic))qr=true;
      if(shown&&element.matches('img,canvas,svg')){
        const r=rect(element);if(r.width>=64&&r.height>=64&&r.width<=500&&r.height<=500&&
          r.width/r.height>=.8&&r.width/r.height<=1.25)squareImage=true;
      }
      if(shown){
        if(element.matches('button,a,[role="button"],input[type="submit"]')){
          const control=(element.getAttribute('aria-label')||element.value||element.textContent||'')
            .normalize('NFKC').replace(/\s/g,'');
          if(control.length<=48&&/^(?:立即|确认|去|继续)?(?:支付|购买|付款|开通)(?:VIP|会员|账号|套餐|服务)?(?:[¥￥]\d+(?:\.\d{1,2})?元?)?$/i.test(control))payControl=true;
        }
      }
      if(element.matches('iframe,frame')){
        const child=frameView(element,item.win,item.viewport);
        if(child)pending.push({element:child.doc.body,...child,depth:item.depth+1,field:child.doc.body});
      }else{
        const children=[...(element.shadowRoot?.childNodes||element.childNodes)];
        const field=element.matches('div,p,section,article,li,td,th,dt,dd,label,button,h1,h2,h3,h4')?element:item.field;
        // LIFO requires reverse insertion, including text nodes. This keeps
        // split currency and digits in their rendered DOM order.
        for(let i=children.length-1;i>=0;i--)pending.push({element:children[i],win:item.win,viewport:item.viewport,
          depth:item.depth+1,shown,field});
      }
    }
    if(pending.length)return false;
    const fields=[];
    for(const part of snippets){
      const last=fields[fields.length-1];
      if(last?.field===part.field)last.label+=part.label;else fields.push({...part});
    }
    const prices=fields.map(part=>part.label);
    for(let i=0;i<fields.length-1;i++){
      const a=fields[i],b=fields[i+1];
      if(/^[¥￥]$/.test(a.label)&&/^\d[\d,]*(?:\.\d{1,2})?元?$/.test(b.label)&&
          parent(a.field)===parent(b.field))prices.push(a.label+b.label);
    }
    const pricePattern=/(?:[¥￥]\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?元)/g;
    const price=prices.some(value=>new RegExp(pricePattern.source).test(value));
    // Never concatenate unrelated prose blocks into payment labels. A resume
    // or chat paragraph mentioning these words is not a checkout field.
    const labels=fields.map(part=>part.label.replace(pricePattern,'').replace(/[:：]/g,''));
    const amount=labels.some(value=>/^(?:商品需付|应付金额|支付金额|订单金额|商品金额|商品价格|商品总价)$/.test(value));
    const product=labels.some(value=>/^(?:企业|招聘)?(?:VIP账号|VIP套餐|VIP会员|付费套餐|会员套餐|招聘套餐|购买套餐|账号套餐|直豆)(?:套餐|服务|权益|账号|\d+(?:个|年|月|天|次))?$/i.test(value));
    const payment=labels.some(value=>/^(?:(?:请|请使用(?:微信|支付宝|云闪付)?)?扫码(?:支付|付款)|微信支付|支付宝支付)$/.test(value));
    const rights=labels.some(value=>/^(?:套餐权益|会员权益|账号权益|增值服务协议|直豆抵扣|购买须知)$/.test(value));
    return price&&(amount||product)&&((payment&&(paymentWidget||payControl||qr||squareImage&&product&&amount))||
      (payControl&&(paymentWidget||rights))||(paymentWidget&&amount&&rights));
  };
  const generic=[];
  const resumeScope=root=>root.matches(resume)||!!root.querySelector(resume);
  const visit=(win,doc,viewport,depth=0)=>{
    if(depth>5||seenDocs.has(doc)||seenDocs.size>=12||!available())return false;
    seenDocs.add(doc);
    // Strong payment components always run before generic dialogs, including
    // dialogs in a parent document that happen to contain a very long resume.
    const candidates=doc.querySelectorAll(known);
    for(const seed of candidates){
      if(!available())return false;
      if(!visibleBox(seed,win,viewport,true))continue;
      const roots=[seed];
      if(seed.matches(known)){
        for(let p=parent(seed),n=0;p&&p!==doc.body&&n<4&&!resumeScope(p);p=parent(p),n++){
          roots.push(p);if(p.matches(dialogs))break;
        }
      }
      for(const root of roots){
        if(checked.has(root))continue;checked.add(root);
        if(evidence(root,win,viewport))return true;
      }
    }
    generic.push({win,doc,viewport});
    const children=doc.querySelectorAll('iframe,frame');
    if(children.length>40)return false;
    for(const frame of children){
      if(!available())return false;
      const child=frameView(frame,win,viewport);
      if(child&&visit(child.win,child.doc,child.viewport,depth+1))return true;
    }
    return false;
  };
  try{
    if(visit(window,document,{left:0,top:0,right:innerWidth,bottom:innerHeight}))return true;
    for(const {win,doc,viewport} of generic){
      for(const root of doc.querySelectorAll(dialogs)){
        if(!available())return false;
        if(checked.has(root)||resumeScope(root)||!visibleBox(root,win,viewport,true))continue;
        checked.add(root);if(evidence(root,win,viewport))return true;
      }
    }
    return false;
  }catch{return false;}
}
