// Pure helpers, shared by the controller and regression tests.
export function isBoss(url){try{const u=new URL(url);return u.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(u.hostname);}catch{return false;}}
// The caller must already bind the candidate to a unique card or open detail.
// Full names are never discovered by treating arbitrary short prose as a name.
export function matchesCandidateNameLine(line,name){
  const normalize=value=>String(value||'').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*');
  const expected=normalize(name),value=normalize(line);
  // A plain Latin name is accepted only against an identity already bound by
  // the caller. This matcher never discovers a name from arbitrary prose.
  if(!/^(?:[\p{L}·]{1,20}\*{1,4}|[\p{L}·]{1,12}(?:先生|女士)|[\p{Script=Han}]{2,8}(?:·[\p{Script=Han}]{2,8})?|[A-Za-z]{3,30})$/u.test(expected)||!value.startsWith(expected))return false;
  return /^(?:(?:热搜|已收藏|在线|首页推荐)|(?:刚刚|今日|今天|本周|本月|近期|\d+(?:秒|分钟|小时|天|日|周|月)(?:内|前)?)活跃)*$/.test(value.slice(expected.length));
}
export function resumeHeaderIdentity(resume,name){
  const compact=value=>String(value||'').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*');
  const lines=String(resume||'').split(/\r?\n/).map(compact).filter(Boolean);
  const names=lines.slice(0,8).map((line,index)=>matchesCandidateNameLine(line,name)?index:-1).filter(index=>index>=0);
  if(names.length!==1)return '';
  let metadata='';
  for(const line of lines.slice(names[0]+1,names[0]+10)){
    if(/^(?:(?:热搜|已收藏|在线|首页推荐)|(?:刚刚|今日|今天|本周|本月|近期|\d+(?:秒|分钟|小时|天|日|周|月)(?:内|前)?)活跃)+$/.test(line))continue;
    const residue=line.replace(/\d{1,2}岁|\d{1,2}年(?:以上|以下)?|应届(?:生)?|博士|硕士|本科|大专|高中|中专|初中|在职|离职|暂不考虑|考虑机会|月内到岗|随时到岗|求职中?|[|·•,，/—–-]/g,'');
    if(residue)break;
    metadata+=line;
    const age=metadata.match(/\d{1,2}岁/g),education=metadata.match(/博士|硕士|本科|大专|高中|中专|初中/g),
      experience=metadata.match(/\d{1,2}年(?:以上|以下)?|应届(?:生)?/g);
    if(age?.length===1&&education?.length===1&&experience?.length===1)
      return JSON.stringify([compact(name),age[0],education[0],experience[0]]);
  }
  return '';
}
export function discoverResumeHeaderIdentity(resume){
  const lines=String(resume||'').split(/\r?\n/).map(line=>line.normalize('NFKC')
    .replace(/[\s\u200B-\u200D\uFEFF]/g,'').replace(/[＊﹡∗]/g,'*')).filter(Boolean).slice(0,8);
  const found=new Map();
  for(const line of lines){
    const headline=line.replace(/(?:(?:热搜|已收藏|在线|首页推荐)|(?:刚刚|今日|今天|本周|本月|近期|\d+(?:秒|分钟|小时|天|日|周|月)(?:内|前)?)活跃)+$/,'');
    const masked=headline.match(/^([\p{L}·]{1,20}\*{1,4}|[\p{L}·]{1,12}(?:先生|女士))$/u)?.[1];
    const candidates=[masked||headline];
    for(const name of candidates){
      if(!masked&&!/^[\p{Script=Han}]{2,8}(?:·[\p{Script=Han}]{2,8})?$/u.test(name))continue;
      if(/简历|经历|学历|姓名|个人|优势|职位|工程师|公司|大学|学院/.test(name)||!matchesCandidateNameLine(line,name))continue;
      const identity=resumeHeaderIdentity(resume,name);
      if(identity)found.set(name,identity);
    }
  }
  return found.size===1?{name:[...found.keys()][0],identity:[...found.values()][0]}:null;
}
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
function validShareLayout(share){
  return share&&['owner','top'].includes(share.coordinateSpace)&&typeof share.frameKey==='string'&&!!share.frameKey&&
    typeof share.name==='string'&&!!share.name&&['x','y','width','height'].every(key=>Number.isFinite(share.rect?.[key]))&&
    ['width','height'].every(key=>Number.isFinite(share.viewport?.[key])&&share.viewport[key]>0);
}
export function verifyShareLayout(expected,current){
  if(!validShareLayout(expected)||!validShareLayout(current)||
      ['coordinateSpace','frameKey','name'].some(key=>current[key]!==expected[key])||
      ['x','y','width','height'].some(key=>current.rect[key]!==expected.rect[key])||
      ['width','height'].some(key=>current.viewport[key]!==expected.viewport[key]))
    throw Error('分享窗口的页面或位置已变化，未保存截图');
}
export function shareScreenshotRect(layouts,ownerFrameId,share){
  if(!validShareLayout(share))throw Error('分享图片缺少有效的页面坐标信息，未保存截图');
  const frameId=share.coordinateSpace==='top'?0:ownerFrameId;
  const matches=layouts.filter(frame=>frame.frameId===frameId);
  if(matches.length!==1||matches[0].value.key!==share.frameKey||
      ['width','height'].some(key=>matches[0].value[key]!==share.viewport[key]))
    throw Error('分享窗口所在页面已变化，未保存截图');
  return screenshotRect(layouts,frameId,share.rect);
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
// Glyphs within one control may be spaced, but a following line is a new
// section, not a suffix of the preceding 查看全部 button.
const horizontalSpace='[^\\S\\r\\n\\u2028\\u2029]';
const spaced=value=>[...value].join(horizontalSpace+'*');
const spacedBases='(?:'+foldBases.map(spaced).join('|')+')';
const spacedSubjects='(?:'+foldSubjects.map(spaced).join('|')+')';
const dynamicFold=spacedBases+horizontalSpace+'*(?:[1-9](?:'+horizontalSpace+'*\\d){0,3}'+horizontalSpace+'*(?:个|项|条|段|份)?'+horizontalSpace+'*)?'+spacedSubjects;
const foldPattern='(?:^|[\\s…。，.；：（(【\\[])('+dynamicFold+'|'+spacedBases+'(?!'+horizontalSpace+'*\\d))(?=[\\s…。，.；：）)】\\]]|$)';

export function isResumeFoldLabel(value){
  return exactFold.test(String(value).normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,''));
}
export function resumeFoldLabels(text){
  const pattern=new RegExp(foldPattern,'gu');
  const source=String(text).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g,'');
  return [...source.matchAll(pattern)].map(match=>match[1].replace(/\s/g,''));
}
