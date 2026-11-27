export const DEFAULT_COLLECTION_POLICY=Object.freeze({
  save_above:55,
  share_above:75,
  share_mode:'both',
  colleague_name:'蔡女士',
  greet_enabled:false,
});

const fields=new Set(Object.keys(DEFAULT_COLLECTION_POLICY));
const modes=new Set(['none','qr','colleague','both']);
const hasOwn=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);

function validatePolicy(input){
  if(input===undefined)return {...DEFAULT_COLLECTION_POLICY};
  if(!input||typeof input!=='object'||Array.isArray(input))
    throw Error('采集规则必须是对象。');
  const prototype=Object.getPrototypeOf(input);
  if(prototype!==null&&Object.getPrototypeOf(prototype)!==null)
    throw Error('采集规则必须是普通对象。');
  for(const key of Reflect.ownKeys(input)){
    if(typeof key!=='string'||!fields.has(key))throw Error('采集规则包含未知字段。');
  }
  const policy=Object.fromEntries(Object.keys(DEFAULT_COLLECTION_POLICY)
    .map(key=>[key,hasOwn(input,key)?input[key]:DEFAULT_COLLECTION_POLICY[key]]));
  for(const [key,label] of [['save_above','保存分数线'],['share_above','转发和打招呼共用分数线']]){
    if(typeof policy[key]!=='number'||!Number.isFinite(policy[key])||policy[key]<0||policy[key]>100)
      throw Error(`${label}必须是 0 到 100 之间的有限数字。`);
  }
  if(!modes.has(policy.share_mode))throw Error('分享方式必须为不分享、二维码、站内转发或两者。');
  if(typeof policy.greet_enabled!=='boolean')throw Error('自动打招呼开关必须为布尔值。');
  if(typeof policy.colleague_name!=='string'||/\p{Cc}/u.test(policy.colleague_name))
    throw Error('站内收件人必须是无控制字符的显示名。');
  policy.colleague_name=policy.colleague_name.trim();
  const length=Array.from(policy.colleague_name).length;
  const minimum=policy.share_mode==='colleague'||policy.share_mode==='both'?1:0;
  if(length<minimum||length>40)throw Error(minimum
    ?'启用站内转发时，收件人显示名须为 1 到 40 个字。'
    :'收件人显示名最多 40 个字。');
  return policy;
}

export function normalizeCollectionPolicy(input,{fallback=false}={}){
  try{return validatePolicy(input);}
  catch(error){
    if(fallback)return {...DEFAULT_COLLECTION_POLICY};
    throw error;
  }
}

export function policyUsesQr(policy){
  return ['qr','both'].includes(normalizeCollectionPolicy(policy).share_mode);
}

export function policyUsesColleague(policy){
  return ['colleague','both'].includes(normalizeCollectionPolicy(policy).share_mode);
}
