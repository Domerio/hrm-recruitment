// Read the rendered DOM, including extension-accessible shadow roots. No page
// application state, cookies, network requests or attachShadow monkey-patching.
(() => {
  if(window.__hrmDom?.version===2)return;
  const ignored=new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','INPUT','TEXTAREA','SELECT','OPTION']);
  const blocks=new Set(['BODY','DIV','SECTION','ARTICLE','MAIN','HEADER','FOOTER','P','BR','H1','H2','H3','H4','H5','H6','DL','DT','DD','UL','OL','LI','TR','TD']);
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function shadow(el){try{return el.shadowRoot||globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el)||null;}catch{return null;}}
  function parent(el){return el?.assignedSlot||el?.parentElement||el?.getRootNode?.().host||null;}
  function contains(root,el){for(let p=el;p;p=parent(p))if(p===root)return true;return false;}
  function closest(el,selector){for(let p=el;p;p=parent(p))if(p.matches?.(selector))return p;return null;}
  function hidden(el){
    for(let p=el;p;p=parent(p)){
      if(p.nodeType!==1)continue;
      const style=getComputedStyle(p);
      if(style.display==='none'||style.contentVisibility==='hidden'||style.opacity==='0')return true;
    }
    return false;
  }
  function visible(el){
    if(!el?.isConnected||hidden(el))return false;
    const style=getComputedStyle(el);
    return style.visibility!=='hidden'&&style.visibility!=='collapse'&&(el.getClientRects().length>0||style.display==='contents');
  }
  function pseudo(el,which){
    try{const s=getComputedStyle(el,which).content||'';if(s.length<260&&/^"(?:[^"\\]|\\.)*"$/.test(s))return JSON.parse(s);}catch{}
    return '';
  }
  function nodes(el){
    if(el.tagName==='SLOT'){
      const assigned=el.assignedNodes?.({flatten:true});if(assigned?.length)return [...assigned];
    }
    return [...(shadow(el)?.childNodes||el.childNodes||[])];
  }
  function view(root){
    const elements=[],texts=new WeakMap(),own=new WeakMap(),seen=new Set();
    // A rendered snapshot is synchronous. Reuse computed visibility within
    // this one traversal; later commands always get fresh styles and layout.
    // Deep candidate lists otherwise re-walk every ancestor several times
    // per element just to read the same display/opacity values.
    const styles=new WeakMap(),hiddenState=new WeakMap(),visibility=new WeakMap();
    const styleOf=el=>{
      if(!styles.has(el))styles.set(el,getComputedStyle(el));
      return styles.get(el);
    };
    function snapshotHidden(el){
      if(!el)return false;
      if(el.nodeType!==1)return snapshotHidden(parent(el));
      if(hiddenState.has(el))return hiddenState.get(el);
      const style=styleOf(el);
      const result=style.display==='none'||style.contentVisibility==='hidden'||style.opacity==='0'||
        snapshotHidden(parent(el));
      hiddenState.set(el,result);
      return result;
    }
    function snapshotVisible(el){
      if(!el?.isConnected)return false;
      if(visibility.has(el))return visibility.get(el);
      const style=styleOf(el);
      const result=!snapshotHidden(el)&&style.visibility!=='hidden'&&style.visibility!=='collapse'&&
        (el.getClientRects().length>0||style.display==='contents');
      visibility.set(el,result);
      return result;
    }
    const stats={openShadowRoots:0,closedShadowRoots:0,canvas:0,images:0,iframes:0,generatedText:0,privateUseChars:0,truncated:false};
    let count=0;
    function walk(el,depth=0){
      if(seen.has(el))return '';seen.add(el);
      if(++count>40000||depth>100){stats.truncated=true;return '';}
      if(el.nodeType===3)return el.textContent||'';
      if(el.nodeType!==1||ignored.has(el.tagName)||el.id==='hrm-picker-overlay'||snapshotHidden(el))return '';
      if(snapshotVisible(el))elements.push(el);
      if(el.tagName==='CANVAS')stats.canvas++;
      if(el.tagName==='IMG')stats.images++;
      if(['IFRAME','FRAME'].includes(el.tagName)){stats.iframes++;return '';}
      const sr=shadow(el);if(sr)stats[el.shadowRoot?'openShadowRoots':'closedShadowRoots']++;
      const before=snapshotVisible(el)?pseudo(el,'::before'):'',after=snapshotVisible(el)?pseudo(el,'::after'):'';
      if(before||after)stats.generatedText++;
      const childNodes=nodes(el);
      const direct=childNodes.filter(n=>n.nodeType===3).map(n=>n.textContent).join('');
      own.set(el,(before+direct+after).trim());
      let result=before;
      for(const child of childNodes){
        if(child.nodeType===3&&!snapshotVisible(el))continue;
        const value=walk(child,depth+1);
        if(value)result+=child.nodeType===1&&blocks.has(child.tagName)?'\n'+value+'\n':value;
      }
      result=(result+after).replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim();
      texts.set(el,result);return result;
    }
    const content=walk(root);stats.privateUseChars=(content.match(/[\uE000-\uF8FF]/g)||[]).length;
    return {elements,texts,own,stats,text:content};
  }
  function snapshot(root,maxChars=100000){
    let remaining=maxChars,truncated=false,count=0;const seen=new Set();
    function take(value){if(value.length>remaining){truncated=true;value=value.slice(0,remaining);}remaining-=value.length;return value;}
    function walk(el,depth=0){
      if(seen.has(el)||remaining<=0)return '';seen.add(el);
      if(++count>40000||depth>100){truncated=true;return '';}
      if(el.nodeType===3)return take(escape(el.textContent||''));
      if(el.nodeType!==1||ignored.has(el.tagName)||el.id==='hrm-picker-overlay'||hidden(el))return '';
      const tag=el.tagName.toLowerCase();let attrs='';
      for(const name of ['class','role','aria-label']){const v=el.getAttribute(name);if(v)attrs+=` ${name}="${escape(v.slice(0,250))}"`;}
      const sr=shadow(el);if(sr)attrs+=` data-hrm-shadow="${el.shadowRoot?'open':'closed'}"`;
      for(const side of ['before','after']){const value=visible(el)?pseudo(el,'::'+side):'';if(value)attrs+=` data-hrm-${side}="${escape(value)}"`;}
      let result=take(`<${tag}${attrs}>`);
      if(!['IFRAME','FRAME','IMG','CANVAS'].includes(el.tagName)){
        for(const child of nodes(el)){if(child.nodeType===3&&!visible(el))continue;result+=walk(child,depth+1);}
      }
      result+=take(`</${tag}>`);return result;
    }
    const html=walk(root);
    return {html,truncated};
  }
  const elements=root=>view(root).elements;
  window.__hrmDom={version:2,shadow,parent,contains,closest,visible,view,snapshot,
    text:root=>root?view(root).text:'',ownText:el=>view(el).own.get(el)||'',
    elements,query:(root,selector)=>elements(root).filter(el=>el!==root&&el.matches(selector))};
})();
