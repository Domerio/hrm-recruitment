// Render verified, transient evaluation data using text nodes only.
import { isRuleRejected } from './evaluation-result.mjs';
function conditionKey(value){
  let text=typeof value==='string'?value.normalize('NFKC').trim():'';
  const prefix=/^(?:(?:\d+\.(?!\d)|\d+[、)]|\(\d+\))\s*|-(?!-)\s*|\*\s+|[•●▪◦‣·–—]\s*)/u;
  while(prefix.test(text))text=text.replace(prefix,'').trim();
  return text.replace(/\s+/gu,' ').toLowerCase();
}
function checkLabel(check,scoring){
  const labels=[check.basis==='inferred'?'项目推断':'',check.status||'待核实'].filter(Boolean);
  if(!['equal-weight-v4','priority-weight-v4'].includes(scoring?.version))return labels.join(' · ');
  const detail=Array.isArray(scoring.condition_scores)&&scoring.condition_scores.find(item=>
    item&&item.status===check.status&&conditionKey(item.condition)===conditionKey(check.condition));
  if(!detail)return labels.join(' · ');
  const partial=check.status==='信息不足'&&detail.credit==='partial'&&Number.isFinite(detail.ratio)&&
    detail.ratio>=.1&&detail.ratio<=.9&&Number.isInteger(detail.ratio*10);
  const full=check.status==='满足'&&detail.credit==='full'&&detail.ratio===1;
  const none=['信息不足','不满足'].includes(check.status)&&detail.credit==='none'&&detail.ratio===0;
  if(partial)labels[labels.length-1]='部分支持（待核实）';
  if(none&&check.status==='信息不足')labels[labels.length-1]='信息不足（未计分）';
  if(partial||full||none)labels.push(`${Math.round(detail.ratio*100)}% 计分`);
  return labels.join(' · ');
}

export function renderDirectEvaluation(container,response){
  const result=response?.result;
  const ruleRejected=isRuleRejected(result);
  if(!result||(!ruleRejected&&(!Number.isFinite(result.score)||result.score<0||result.score>100||result.evaluation_method==='rules')))
    throw Error('未收到有效的评估结果，请重试。');
  const doc=container.ownerDocument;
  const node=(tag,text,className='')=>{
    const element=doc.createElement(tag);element.textContent=String(text??'');
    if(className)element.className=className;
    return element;
  };
  const fragment=doc.createDocumentFragment();
  const evidence=(item,value)=>{
    const quotes=Array.isArray(value.evidence_quotes)?value.evidence_quotes.filter(quote=>typeof quote==='string'&&quote.trim()):[];
    if(quotes.length)for(const quote of quotes)item.append(node('blockquote',quote));
    else item.append(node('p','资料中没有足够证据','field-help'));
  };
  fragment.append(node('h2',`${response.name} · ${response.job?.title||'简历评估'}`));
  if(ruleRejected)fragment.append(node('p','规则预筛不达标 · 未调用模型','direct-rule-result'));
  else{
    const score=node('div','', 'direct-score');
    score.append(node('strong',`${result.score} 分`),node('span',result.category));
    fragment.append(score);
  }
  fragment.append(node('p',result.summary,'direct-summary'));
  if(result.evaluation_context?.evaluation_date)
    fragment.append(node('p',`${result.evaluation_context.evaluation_date}${ruleRejected?'':` · ${response.model||''}`}`,'field-help'));
  for(const [title,checks] of [[ruleRejected?'未通过的硬条件与原文依据':'必备条件',result.required_checks],['逐项依据',result.checks]]){
    if(!Array.isArray(checks)||!checks.length)continue;
    const section=node('section',''),list=node('ol','','direct-evidence');
    section.append(node('h3',title));
    for(const check of checks){
      if(!check||typeof check!=='object')continue;
      const item=node('li','');
      item.append(node('strong',check.condition||check.requirement||'岗位条件'));
      item.append(node('p',ruleRejected?'不满足':checkLabel(check,result.scoring),'direct-check-status'));
      evidence(item,check);
      if(check.reasoning)item.append(node('p',check.reasoning));
      if(check.note)item.append(node('p',check.note));
      list.append(item);
    }
    section.append(list);fragment.append(section);
  }
  if(Array.isArray(result.inferred_capabilities)&&result.inferred_capabilities.length){
    fragment.append(node('h3','项目补充能力（待核实）'));
    const list=node('ol','','direct-evidence');
    for(const capability of result.inferred_capabilities){
      if(!capability||typeof capability!=='object')continue;
      const item=node('li','');
      item.append(node('strong',capability.capability));
      if(capability.reasoning)item.append(node('p',capability.reasoning));
      evidence(item,capability);
      if(capability.question)item.append(node('p',`建议核实：${capability.question}`));
      list.append(item);
    }
    fragment.append(list);
  }
  if(Array.isArray(result.questions)&&result.questions.length){
    fragment.append(node('h3','待确认问题'));
    const questions=node('ul','','direct-questions');
    for(const question of result.questions)questions.append(node('li',question));
    fragment.append(questions);
  }
  fragment.append(node('p','仅供本次核对；未保存履历或评估历史，未收藏，未添加采集标记。','field-help'));
  container.replaceChildren(fragment);
}
