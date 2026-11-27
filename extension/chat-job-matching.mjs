const positiveId=value=>Number.isSafeInteger(value)&&value>0;
const hidden=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const title=value=>{
  if(value===undefined||value===null||value==='')return '';
  if(typeof value!=='string'||value.length>640||hidden.test(value))return null;
  const text=value.normalize('NFKC').replace(/\s+/gu,' ').trim();
  return text.length<=160?text:null;
};
const identifier=value=>{
  if(value===undefined||value===null||value==='')return '';
  if(typeof value!=='string'||value.length>160||hidden.test(value))return null;
  const text=value.trim();
  return text&&!/\s/u.test(text)?text:null;
};
const titleKey=value=>value.toLowerCase();

// Empty is unknown; null is invalid. Qualifiers and word order are preserved.
export function normalizeChatJobTitle(value){
  const clean=title(value);
  return clean===null?null:titleKey(clean);
}

// Resolve a local archive job from a verified platform-job group. A previous
// account/job-ID association is explicit history, not a fuzzy title alias.
export function resolveChatJob({jobs=[],conversations=[],account_id='',mappings=[]}={}){
  let platform_job_id='',platform_job_title='';
  const blocked=(code,error)=>({ok:false,job_id:null,job_title:'',platform_job_id,platform_job_title,method:'',code,error});
  if(!Array.isArray(jobs)||!Array.isArray(conversations)||!Array.isArray(mappings))
    return blocked('invalid-input','岗位识别数据格式无效，请重新读取。');
  if(!conversations.length)return blocked('no-conversations','请先读取并选择需要归档的会话。');
  const localJobs=new Map();
  for(const job of jobs){
    const clean=title(job?.title);
    if(!positiveId(job?.id)||!clean||localJobs.has(job.id))
      return blocked('invalid-jobs','工作台岗位数据不完整或重复，请刷新工作台后重试。');
    localJobs.set(job.id,{id:job.id,title:clean,key:titleKey(clean)});
  }
  if(!localJobs.size)return blocked('no-jobs','工作台尚未配置归档岗位。');
  const ids=new Set(),titles=new Map();
  for(const conversation of conversations){
    const jobId=identifier(conversation?.platform_job_id),jobTitle=title(conversation?.platform_job_title);
    if(jobId===null||jobTitle===null)return blocked('invalid-platform-job','BOSS 沟通岗位标识或名称无效，请重新读取。');
    ids.add(jobId);
    if(jobTitle)titles.set(titleKey(jobTitle),jobTitle);
  }
  if(ids.size!==1)return blocked('mixed-platform-jobs','所选会话属于不同的 BOSS 岗位，请按岗位分组后采集。');
  platform_job_id=[...ids][0];
  if(!platform_job_id&&conversations.length!==1)
    return blocked('missing-platform-job','BOSS 岗位标识缺失时只能单独确认一个会话。');
  if(titles.size>1)return blocked('conflicting-platform-titles','同一 BOSS 岗位出现不同名称，请重新读取并核对沟通职位。');
  platform_job_title=[...titles.values()][0]||'';
  const account=identifier(account_id);
  if(account===null)return blocked('invalid-account','招聘账号标识无效，请先核对账号。');
  const matchedHistory=mappings.filter(row=>row?.account_id===account&&account&&platform_job_id&&
    row.platform_job_id===platform_job_id);
  const mappedJobs=new Set();
  for(const row of matchedHistory){
    if(!positiveId(row.job_id))return blocked('invalid-history','该 BOSS 岗位已有无效的归档关联，请在工作台核对。');
    mappedJobs.add(row.job_id);
  }
  if(mappedJobs.size>1)return blocked('conflicting-history','该账号下的 BOSS 岗位已关联多个本地岗位，请确认归档岗位。');
  const exact=platform_job_title?[...localJobs.values()].filter(job=>job.key===titleKey(platform_job_title)):[];
  let chosen=null,method='';
  if(mappedJobs.size){
    chosen=localJobs.get([...mappedJobs][0]);
    if(!chosen)return blocked('missing-history-job','该 BOSS 岗位原先关联的本地岗位已不存在，请确认归档岗位。');
    if(exact.length&&!exact.some(job=>job.id===chosen.id))
      return blocked('title-history-conflict','沟通职位名称与已有归档关联不一致，请确认归档岗位。');
    method='history';
  }else{
    if(exact.length>1)return blocked('ambiguous-title','工作台存在多个同名岗位，请确认一次归档岗位。');
    if(!exact.length)return blocked('unmatched-title',platform_job_title?
      `未找到与“${platform_job_title}”唯一对应的本地岗位，请确认一次归档岗位。`:
      '尚未识别到可对应的沟通职位，请确认一次归档岗位。');
    chosen=exact[0];method='title';
  }
  return {ok:true,job_id:chosen.id,job_title:chosen.title,platform_job_id,platform_job_title,method,error:''};
}
