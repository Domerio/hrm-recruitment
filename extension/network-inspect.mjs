const SECRET_KEY=/(?:token|cookie|session|password|passwd|secret|authorization|credential|signature|(?:^|_)sign(?:$|_)|csrf|securityid|(?:^|_)lid(?:$|_))/i;
const ID_KEY=/(?:^id$|(?:geek|candidate|resume|expect|item|job|jid|encrypt)[_a-z]*id$|^(?:jid|geekid|itemid|encryptgeekid)$)/i;
const LINK_KEY=/(?:url|uri|href|link|share|jump|redirect|address)/i;

export function isBossUrl(value){
  try{const url=new URL(value);return url.protocol==='https:'&&['www.zhipin.com','zhipin.com'].includes(url.hostname);}
  catch{return false;}
}

export function requestLabel(value){
  if(!isBossUrl(value))return '';
  const url=new URL(value);
  return url.pathname+(url.search?'?'+[...url.searchParams.keys()].join('&'):'');
}

export function requestIdentity(value){
  if(!isBossUrl(value))return [];
  const url=new URL(value);
  if(url.pathname!=='/wapi/zpjob/view/geek/info/v2')return [];
  return ['encryptJid','expectId'].flatMap(key=>
    url.searchParams.has(key)?[{field:key,value:url.searchParams.get(key).slice(0,160)}]:[]);
}

export function detailShape(value){
  const data=value?.zpData;
  if(!data||typeof data!=='object'||Array.isArray(data))return [];
  return ['geekDetailInfo','encryptGeekDetailInfo','pageV2','friend'].map(field=>{
    const item=data[field];
    if(item===null||item===undefined)return {field,type:'missing'};
    if(Array.isArray(item))return {field,type:'array',length:item.length};
    if(typeof item==='object')return {field,type:'object',keys:Object.keys(item).filter(key=>!SECRET_KEY.test(key)).slice(0,60)};
    return {field,type:typeof item,length:typeof item==='string'?item.length:undefined};
  });
}

export function responseShape(value){
  const data=value?.zpData;
  if(data===null||data===undefined)return {type:'missing',keys:[]};
  if(Array.isArray(data))return {type:'array',length:data.length,keys:data[0]&&typeof data[0]==='object'?Object.keys(data[0]).filter(key=>!SECRET_KEY.test(key)).slice(0,60):[]};
  if(typeof data==='object')return {type:'object',keys:Object.keys(data).filter(key=>!SECRET_KEY.test(key)).slice(0,80)};
  return {type:typeof data,length:typeof data==='string'?data.length:undefined,keys:[]};
}

export function safeCandidateLink(value){
  if(typeof value!=='string'||value.length>1200)return '';
  if(!/^(?:https:\/\/|\/)/i.test(value))return '';
  let url;
  try{url=new URL(value,'https://www.zhipin.com');}catch{return '';}
  if(!isBossUrl(url.href))return '';
  if(/\.(?:png|jpe?g|gif|webp|svg|css|js|woff2?)$/i.test(url.pathname))return '';
  for(const key of [...url.searchParams.keys()]){
    if(SECRET_KEY.test(key))url.searchParams.set(key,'[redacted]');
  }
  return url.href;
}

export function summarizeResponse(value){
  const result={topKeys:[],businessCode:null,dataShape:{type:'missing',keys:[]},detailShape:[],ids:[],links:[]};
  if(!value||typeof value!=='object')return result;
  result.topKeys=Object.keys(value).slice(0,35);
  if(typeof value.code==='number'||typeof value.code==='string')result.businessCode=String(value.code).slice(0,40);
  result.dataShape=responseShape(value);
  result.detailShape=detailShape(value);
  const seen=new WeakSet();
  let visited=0;
  function walk(node,path,depth){
    if(!node||typeof node!=='object'||depth>9||seen.has(node)||visited++>6000)return;
    seen.add(node);
    const entries=Array.isArray(node)?node.slice(0,20).map((item,index)=>[String(index),item]):Object.entries(node).slice(0,80);
    for(const [key,item] of entries){
      const field=path?`${path}.${key}`:key;
      if(SECRET_KEY.test(key))continue;
      if(item&&typeof item==='object'){walk(item,field,depth+1);continue;}
      if(typeof item!=='string'&&typeof item!=='number')continue;
      const text=String(item);
      if(ID_KEY.test(key)&&text.length<=160&&result.ids.length<60)result.ids.push({field,value:text});
      if(LINK_KEY.test(key)&&result.links.length<50){
        const link=safeCandidateLink(text);
        if(link)result.links.push({field,value:link});
      }
    }
  }
  walk(value,'',0);
  return result;
}
