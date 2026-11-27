// Apply only the job's recommendation-page conditions to its visible filter.
// Never infer hidden site state or choose a broader option when the value is absent.
(() => {
  if (window.__hrmRecommendSearch?.version === 3) return;
  const D = window.__hrmDom;
  const norm = value => String(value ?? '').normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]+/g, '');
  const labels = {activity:'活跃度',job_status:'求职状态',salary:'薪资待遇',
    gender:'性别',school:'院校',education:'学历要求',experience:'经验要求'};
  const single = (items, message) => {
    const values=[...new Set(items)];
    if(values.length!==1)throw Error(message+(values.length?'（匹配到多个控件）':'（未找到控件）'));
    return values[0];
  };
  const exact = (root,wanted) => {
    const view=D.view(root);
    if(view.stats.truncated)throw Error('推荐页筛选文字过多，无法确认控件');
    const found=view.elements.filter(node=>norm(view.texts.get(node))===norm(wanted));
    return found.filter(node=>!found.some(child=>child!==node&&D.contains(node,child)));
  };
  const chosen = node => ['selected','active','cur','checked','on','is-active'].some(name=>node.classList.contains(name)) ||
    ['aria-selected','aria-checked','aria-pressed'].some(name=>node.getAttribute(name)==='true');
  const enabled = node => !node.disabled && !node.hasAttribute('disabled') &&
    node.getAttribute('aria-disabled')!=='true' && !node.classList.contains('disabled');
  const frameKey = () => (location.origin||'')+(location.pathname||'')+(location.search||'');
  const excludedEntry = node => D.closest(node,'.recommend-list-wrap,.card-list,.candidate-card-wrap,[role="dialog"],.resume-detail-wrap');
  const filterText = value => /^筛选(?:[·•]?\d+)?$/.test(norm(value));
  const componentTriggers = wrap => D.query(wrap,'.filter-label-wrap').filter(node=>
    D.closest(node,'.filter-wrap')===wrap&&!D.closest(node,'.filter-panel'));
  function visibleFrame(){
    try {
      for(let child=window;child.top&&child!==child.top;child=child.parent){
        const frame=child.frameElement,rect=frame?.getBoundingClientRect();
        if(!frame || !D.visible(frame) || !rect || rect.right<=0 || rect.bottom<=0 ||
            rect.left>=child.parent.innerWidth || rect.top>=child.parent.innerHeight)return false;
      }
      return true;
    }catch{return false;}
  }
  function discover(){
    const address=new URL(location.href||location.origin);
    if(!D?.version || address.protocol!=='https:' || !['www.zhipin.com','zhipin.com'].includes(address.hostname) ||
        !visibleFrame())throw Error('推荐牛人页面不可见');
    const list=single(D.query(document.documentElement,'.recommend-list-wrap .card-list'), '推荐候选人列表不唯一');
    const listScope=D.closest(list,'.recommend-list-wrap');
    const view=D.view(document.documentElement);
    if(view.stats.truncated)throw Error('推荐页文字过多，无法确认筛选入口');
    const components=view.elements.filter(node=>node.matches('.recommend-filter')&&!excludedEntry(node));
    let trigger,component=null,filterWrap=null;
    if(components.length){
      component=single(components,'推荐页筛选组件不唯一');
      filterWrap=single(D.query(component,'.filter-wrap').filter(node=>D.parent(node)===component),'推荐页筛选组件不唯一');
      trigger=single(componentTriggers(filterWrap),'推荐页筛选入口不唯一');
      const label=single(D.query(trigger,'.filter-label'),'推荐页筛选标签不唯一');
      if(!filterText(D.text(label))||!filterText(D.text(trigger)))throw Error('未确认推荐页筛选标签与计数');
    }else{
      // Older layouts use a real button. Never click a text-only ancestor:
      // a listener on a nested control does not receive its parent's click.
      const controls=view.elements.filter(node=>node.matches('button,[role="button"],[aria-expanded]')&&
        filterText(view.texts.get(node))&&!excludedEntry(node));
      trigger=single(controls,'推荐页筛选入口不唯一');
    }
    if(!enabled(trigger))throw Error('推荐页筛选入口不可用');
    const activeCount=Number(norm(D.text(trigger)).match(/^筛选(?:[·•]?(\d+))?$/)?.[1]||0);
    const root=document.documentElement;
    if(exact(root,'推荐').length!==1 || exact(root,'最新').length!==1)
      throw Error('未确认推荐牛人列表的排序栏');
    const region={root,listScope,trigger,activeCount,component,filterWrap};
    const filterPanel=panel(region);
    if(D.query(root,'[role="dialog"],.resume-detail-wrap,.dialog-lib-resume').some(node=>
      D.visible(node) && !(filterPanel && (node===filterPanel || D.contains(node,filterPanel)))))
      throw Error('请关闭候选人详情后再应用推荐页筛选');
    return region;
  }
  function configured(input){
    if(!input || typeof input!=='object' || Array.isArray(input) || input.enabled!==true)
      throw Error('推荐页查询条件无效');
    const values={
      activity:input.recommend_activity||input.activity,
      job_status:input.recommend_job_status||input.job_status,
      salary:input.recommend_salary||input.salary,
      gender:input.recommend_gender,school:input.recommend_school,
      education:input.recommend_education,experience:input.recommend_experience,
    };
    const wanted=[];
    for(const [key,value] of Object.entries(values)){
      if(value==null || value==='')continue;
      if(typeof value!=='string'||value.length>80||/[\x00-\x1f\x7f]/.test(value))
        throw Error('推荐页筛选值无效：'+labels[key]);
      const trimmed=value.trim();
      if(trimmed && trimmed!=='保留页面设置')wanted.push([key,trimmed]);
    }
    return wanted;
  }
  function confirmOf(filter,region){
    let scope=filter;
    if(region.filterWrap){
      const groups=D.query(filter,'.btns').filter(node=>D.closest(node,'.filter-panel')===filter);
      if(!groups.length)return null;
      scope=single(groups,'推荐页筛选确认区域不唯一');
    }
    const controls=[...new Set(exact(scope,'确定').map(node=>D.closest(node,
      region.filterWrap?'.btn,button,[role="button"]':'button,[role="button"]')).filter(node=>node&&node!==scope&&D.contains(scope,node)))];
    return controls.length?single(controls,'推荐页确定按钮不唯一'):null;
  }
  function panel(region){
    let roots;
    if(region.filterWrap){
      roots=D.query(region.filterWrap,'.filter-panel').filter(node=>D.closest(node,'.filter-wrap')===region.filterWrap);
    }else{
      const controlled=region.trigger.getAttribute('aria-controls');
      roots=D.query(region.root,'[role="dialog"]').filter(node=>
        (!controlled||node.id===controlled)&&!D.closest(node,'.resume-detail-wrap,.dialog-lib-resume')&&
        Object.values(labels).some(title=>exact(node,title).length||exact(node,title+'[单选]').length));
    }
    if(!roots.length)return null;
    const filter=single(roots,'推荐页筛选面板不唯一');
    return confirmOf(filter,region)?filter:null;
  }
  function rowOf(root,key,wanted){
    const title=labels[key];
    const headings=D.view(root).elements.filter(node=>{
      const text=norm(D.text(node));
      return key==='activity'?/^(?:活跃度|活跃度\[单选\])$/.test(text):
        key==='salary'?/^(?:薪资待遇|薪资待遇\[单选\])$/.test(text):text===title;
    }).filter(node=>!D.view(node).elements.some(child=>child!==node&&
      norm(D.text(child))===norm(D.text(node))));
    const heading=single(headings,'推荐页筛选行不唯一：'+title);
    for(let row=D.parent(heading);row&&row!==root;row=D.parent(row)){
      if(!exact(row,'不限').length)continue;
      const competing=Object.values(labels).filter(other=>other!==title&&exact(row,other).length);
      if(competing.length)break;
      const options=[...new Set(exact(row,wanted).filter(node=>node!==heading).map(node=>{
        for(let parent=D.parent(node);parent&&parent!==row&&norm(D.text(parent))===norm(wanted);parent=D.parent(parent))
          node=parent;
        return node;
      }))].filter(enabled);
      if(options.length===1)return {row,option:options[0]};
      if(options.length>1)throw Error('推荐页筛选选项不唯一：'+title+' / '+wanted);
    }
    throw Error('推荐牛人页没有精确选项：'+title+' / '+wanted);
  }
  let stopped=false,generation=0,busy=false;
  async function apply(input){
    const wanted=configured(input);
    const region=discover(),key=frameKey(),token=generation;
    if(busy)throw Error('正在应用推荐页筛选');
    if(stopped)throw Error('推荐页筛选操作已停止');
    if(region.activeCount>0){
      if(panel(region))throw Error('请先关闭推荐页筛选面板后再开始采集');
      return {applied:true,skipped:true,summary:[`已沿用页面现有的 ${region.activeCount} 项筛选`]};
    }
    if(!wanted.length)return {applied:true,summary:[]};
    const guard=()=>{
      if(stopped||token!==generation)throw Error('推荐页筛选操作已停止');
      if(frameKey()!==key||!region.listScope?.isConnected||!region.trigger.isConnected||!visibleFrame())
        throw Error('推荐页面已变化，未继续应用筛选');
      if(region.filterWrap&&(!region.component.isConnected||D.parent(region.filterWrap)!==region.component||
          excludedEntry(region.trigger)||componentTriggers(region.filterWrap).length!==1||
          componentTriggers(region.filterWrap)[0]!==region.trigger))throw Error('推荐页筛选组件已变化，未继续应用筛选');
    };
    const pause=async()=>{await new Promise(resolve=>setTimeout(resolve,100));guard();};
    const waitFor=async(read,message)=>{
      for(let i=0;i<25;i++){guard();const value=read();if(value)return value;await pause();}
      throw Error(message);
    };
    const click=node=>{guard();if(!node?.isConnected||!D.visible(node)||!enabled(node))
      throw Error('推荐页筛选控件不可点击');node.click();};
    busy=true;
    try{
      guard();
      let filter=panel(region);
      if(!filter){click(region.trigger);filter=await waitFor(()=>panel(region),'推荐页筛选面板未展开');}
      const verifyFilter=()=>{guard();if(panel(region)!==filter)throw Error('推荐页筛选面板已变化，未继续应用筛选');};
      const requested=wanted.map(([field,value])=>({field,value,...rowOf(filter,field,value)}));
      let changed=false;
      for(const item of requested){
        verifyFilter();
        if(!item.option.isConnected||!D.contains(filter,item.option))throw Error('推荐页筛选选项已变化，未继续应用筛选');
        if(!chosen(item.option)){
          click(item.option);changed=true;
          await waitFor(()=>{verifyFilter();if(!item.option.isConnected||!D.contains(filter,item.option))
            throw Error('推荐页筛选选项已变化，未继续应用筛选');return chosen(item.option);},'推荐页未确认筛选值：'+labels[item.field]+' / '+item.value);
        }
      }
      const confirm=await waitFor(()=>{verifyFilter();const button=confirmOf(filter,region);return button&&enabled(button)?button:null;},
        '推荐页确定按钮尚不可用');
      let refreshed=false,revision=0,observer=null;
      const observe=records=>{
        if(records.some(record=>record.type==='childList' &&
            D.contains(region.listScope,record.target) &&
            [...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1&&
              (node.matches?.('.card-list,.card-item,.candidate-card-wrap') ||
                node.querySelector?.('.card-list,.card-item'))))){refreshed=true;revision++;}
      };
      try{
        observer=new MutationObserver(observe);
        observer.observe(region.listScope,{subtree:true,childList:true});
        click(confirm);
        await waitFor(()=>!D.visible(filter)&&!panel(region),'推荐页筛选面板未关闭');
        if(changed)await waitFor(()=>{observe(observer.takeRecords());return refreshed && D.query(region.listScope,'.card-list').length===1;},
          '推荐页筛选已更改，但未确认候选人列表刷新');
        let stable=0,lastRevision=revision;
        for(let i=0;i<40&&stable<4;i++){
          guard();observe(observer.takeRecords());
          const loading=region.listScope.getAttribute('aria-busy')==='true' ||
            D.query(region.listScope,'[aria-busy="true"],[role="progressbar"]').length>0;
          stable=!loading && D.query(region.listScope,'.card-list').length===1 && revision===lastRevision
            ?stable+1:0;
          lastRevision=revision;
          if(stable<4)await pause();
        }
        if(stable<4)throw Error('推荐页候选人列表尚未稳定，未开始采集');
      }finally{observer?.disconnect();}
      guard();
      return {applied:true,summary:requested.map(item=>labels[item.field]+'：'+item.value)};
    }finally{busy=false;}
  }
  window.__hrmRecommendSearch={version:3,async run(action,args){
    if(action==='stop'){stopped=true;generation++;return {stopped:true};}
    if(action==='reset'){stopped=false;generation++;return {reset:true};}
    if(action==='inspect'){
      try{discover();return {supported:true,frameKey:frameKey()};}
      catch(error){return {supported:false,frameKey:frameKey(),reason:error.message};}
    }
    if(action==='apply')return apply(args);
    throw Error('未知的推荐页筛选操作');
  }};
})();
