export function ruleRejectedResult(){
  const check={requirement_id:1,rule_id:'highest_degree_below_minimum',condition:'本科及以上',status:'不满足',basis:'explicit',
    evidence_lines:[2],evidence_quotes:['最高学历：大专'],reasoning:'原文最高学历为大专，低于岗位要求的本科。'};
  return {evaluation_method:'rules',precheck:{version:'hard-rules-v1',rejected:true,checks:[{...check}]},
    score:null,category:'低匹配',summary:'规则预筛未通过：学历低于岗位要求。',must_have_status:'not_met',
    required_checks:[{...check}],checks:[],questions:[],inferred_capabilities:[],
    evaluation_context:{job_revision:3,evaluation_date:'2026-11-23'}};
}
