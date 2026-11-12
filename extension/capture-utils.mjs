// Pure helpers, shared by the controller and regression tests.
export function isBoss(url){try{const u=new URL(url);return u.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(u.hostname);}catch{return false;}}
export function uniqueDetail(frames,name=''){
  const matches=frames.filter(f=>f.value?.detail&&(!name||f.value.detail===name));
  if(matches.length>1)throw Error('识别到多份在线简历，无法确认当前候选人，已停止');
  return matches[0]||null;
}
export function detailFailure(frames){
  const reports=frames.map(f=>f.value?.diagnostics).filter(Boolean);
  const sections=[...new Set(reports.flatMap(r=>r.sections))];
  const roots=reports.reduce((n,r)=>n+r.detailRoots,0),names=reports.reduce((n,r)=>n+r.nameNodes,0);
  if(roots>1)return '已检测到简历章节，但存在多个详情区域，无法确认唯一候选人。请关闭其他详情弹窗后重试。';
  if(sections.length)return `已检测到${sections.join('、')}，但${names?'尚未找到同时包含对应姓名与履历的唯一详情区域':'未能从详情页识别候选人姓名'}。请保留当前详情，查看下方识别诊断；不需要跳转到其他页面。`;
  if(frames.some(f=>f.value?.canvasDialog||f.value?.canvasBody))return '简历弹窗与正文框架尚未同时就绪，请确认详情可见。';
  return `已检查 ${reports.length} 个页面框架，但没有找到可复制的在线简历正文。`;
}
export async function withBusyState(setBusy,task){
  setBusy(true);
  try{return await task();}finally{setBusy(false);}
}
export function screenshotRect(layouts,frameId,rect){
  const main=layouts.find(f=>f.frameId===0),target=layouts.find(f=>f.frameId===frameId);
  if(!main||!target)throw Error('无法确认分享图片所在框架');
  function walk(node,seen){
    if(node.frameId===frameId)return {...rect};
    if(seen.has(node.frameId))return null;
    const next=new Set([...seen,node.frameId]);let matches=[];
    for(const child of node.value.children){
      const children=layouts.filter(f=>f.frameId!==node.frameId&&f.value.key===child.key);
      if(children.length!==1)continue;
      const found=walk(children[0],next);
      if(found){
        if(Math.abs(child.width-children[0].value.width)>2||Math.abs(child.height-children[0].value.height)>2)throw Error('框架存在缩放，未截取可能错误的分享图片');
        matches.push({...found,x:found.x+child.x,y:found.y+child.y});
      }
    }
    if(matches.length>1)throw Error('分享图片框架位置不唯一');
    return matches[0]||null;
  }
  const r=walk(main,new Set());
  if(!r||r.width<90||r.height<90||r.x<0||r.y<0||r.x+r.width>main.value.width||r.y+r.height>main.value.height)throw Error('分享图片未完整显示，未保存截图');
  return {...r,viewportWidth:main.value.width,viewportHeight:main.value.height};
}
export function canAutoEvaluate(candidate){return candidate.capture?.status==='visible_complete'&&!candidate.capture.warnings?.length;}
export function resumeSections(text){
  const normalized=text.replace(/\s/g,'').replace(/工作经验/g,'工作经历').replace(/项目经验/g,'项目经历').replace(/教育背景/g,'教育经历')
    .replace(/荣誉奖项|获奖经历/g,'所获荣誉');
  return ['个人优势','个人简介','期望职位','工作经历','项目经历','教育经历','资格证书','专业技能','所获荣誉','语言能力'].filter(label=>normalized.includes(label));
}

const foldBases=['查看全部','展开全部','查看更多'];
const foldSubjects=['个人优势','个人简介','期望职位','工作经历','工作经验','项目经历','项目经验','教育经历','教育背景',
  '资格证书','专业技能','所获荣誉','荣誉奖项','获奖经历','荣誉','语言能力'];
const foldSuffix='(?:(?:[1-9]\\d{0,3}(?:个|项|条|段|份)?)?(?:'+foldSubjects.join('|')+'))?';
const exactFold=new RegExp('^(?:'+foldBases.join('|')+')'+foldSuffix+'$');
const spaced=value=>[...value].join('\\s*');
const spacedBases='(?:'+foldBases.map(spaced).join('|')+')';
const spacedSubjects='(?:'+foldSubjects.map(spaced).join('|')+')';
const dynamicFold=spacedBases+'\\s*(?:[1-9](?:\\s*\\d){0,3}\\s*(?:个|项|条|段|份)?\\s*)?'+spacedSubjects;
const foldPattern='(?:^|[\\s…。，.；：（(【\\[])('+dynamicFold+'|'+spacedBases+'(?!\\s*\\d))(?=[\\s…。，.；：）)】\\]]|$)';

export function isResumeFoldLabel(value){
  return exactFold.test(String(value).normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,''));
}
export function resumeFoldLabels(text){
  const pattern=new RegExp(foldPattern,'gu');
  const source=String(text).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g,'');
  return [...source.matchAll(pattern)].map(match=>match[1].replace(/\s/g,''));
}
