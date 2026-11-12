export function expandControls(lines){
  const labels=['查看全部','展开全部','查看更多'],found=[];
  for(const line of lines||[]){
    const words=line.words||[];
    for(let start=0;start<words.length;start++){
      let text='',group=[];
      for(let end=start;end<words.length&&text.length<5;end++){
        const w=words[end];text+=String(w.text||'').replace(/\s/g,'');group.push(w);
        if(labels.includes(text)&&group.every(v=>(v.confidence===undefined||v.confidence>=.9)&&['x','y','width','height'].every(k=>Number.isFinite(v[k])))){
          const x=Math.min(...group.map(v=>v.x)),y=Math.min(...group.map(v=>v.y));
          const right=Math.max(...group.map(v=>v.x+v.width)),bottom=Math.max(...group.map(v=>v.y+v.height));
          found.push({label:text,x:(x+right)/2,y:(y+bottom)/2});break;
        }
      }
    }
  }
  return found;
}
export function mergeOcrScreens(screens){
  const normalize=s=>s.replace(/\s/g,'');let merged=[];
  for(const text of screens){
    const lines=text.split('\n').map(s=>s.trim()).filter(Boolean);let overlap=0;
    for(let n=Math.min(merged.length,lines.length);n>=2;n--)if(merged.slice(-n).every((s,i)=>normalize(s)===normalize(lines[i]))){overlap=n;break;}
    merged.push(...lines.slice(overlap));
  }
  return merged.join('\n');
}

export function ocrSections(text){
  const normalized=text.replace(/\s/g,'');
  return ['个人优势','个人简介','期望职位','工作经历','项目经历','教育经历','资格证书','专业技能'].filter(label=>normalized.includes(label));
}

// No DOM scrollbar does not prove a canvas renderer has reached its bottom.
// Require repeated identical captures after actual attempts to scroll further.
export function createReadTracker(){
  let last='',unchanged=0,changed=0,bottom=0;
  return {observe(signature,state){
    const same=!!last&&signature===last;
    if(last&&!same)changed++;
    unchanged=same?unchanged+1:0;
    bottom=state.scrollMode==='dom'&&state.atBottom?(same?bottom+1:0):0;
    last=signature;
    if(bottom>=2)return {done:true,confirmed:true,reason:'已到网页滚动底部，并两次复查画面稳定'};
    if(state.scrollMode==='canvas'&&unchanged>=3)return {done:true,confirmed:false,reason:changed?'画布滚动后连续三次未变化，仍需核对简历末尾':'画布未响应滚动，只读取了当前画面，请勿视为完整简历'};
    return {done:false,confirmed:false};
  },reset(){last='';unchanged=0;bottom=0;}};
}
