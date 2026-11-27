// A rules-only result must carry explicit, line-backed rejection evidence.
function validCheck(check){
  return check&&Number.isSafeInteger(check.requirement_id)&&check.requirement_id>0&&
    typeof check.condition==='string'&&Boolean(check.condition.trim())&&check.status==='不满足'&&check.basis==='explicit'&&
    typeof check.reasoning==='string'&&Boolean(check.reasoning.trim())&&Array.isArray(check.evidence_quotes)&&
    check.evidence_quotes.length>0&&check.evidence_quotes.every(quote=>typeof quote==='string'&&Boolean(quote.trim()))&&
    Array.isArray(check.evidence_lines)&&check.evidence_lines.length===check.evidence_quotes.length&&
    check.evidence_lines.every(line=>Number.isSafeInteger(line)&&line>0);
}

export function isRulePrecheck(value){
  const checks=value?.precheck?.checks;
  return Boolean(value&&value.evaluation_method==='rules'&&value.score===null&&
    value.precheck?.version==='hard-rules-v1'&&value.precheck.rejected===true&&
    Array.isArray(checks)&&checks.length&&checks.every(check=>validCheck(check)&&typeof check.rule_id==='string'&&Boolean(check.rule_id.trim()))&&
    new Set(checks.map(check=>check.requirement_id)).size===checks.length);
}

export function isRuleRejected(result){
  if(!isRulePrecheck(result)||result.category!=='低匹配'||result.must_have_status!=='not_met'||
    typeof result.summary!=='string'||!result.summary.trim())return false;
  if(!['checks','questions','inferred_capabilities'].every(key=>Array.isArray(result[key])&&result[key].length===0))return false;
  const checks=result.required_checks,proof=result.precheck.checks;
  if(!Array.isArray(checks)||checks.length!==proof.length||!checks.every(validCheck))return false;
  return checks.every((check,index)=>['requirement_id','condition','status','basis','reasoning','evidence_lines','evidence_quotes']
    .every(key=>JSON.stringify(check[key])===JSON.stringify(proof[index][key])));
}
