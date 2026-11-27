import {resumeFoldLabels,matchesCandidateNameLine} from './capture-utils.mjs';
// Proof from fresh clipboard text. Freshness and document identity are checked by the caller.
const footerStart='为妥善保护牛人在boss直聘平台';
const footerEnd='在任何第三方平台进行复制使用传播存储';
const chapter=/个人优势|个人简介|期望职位|工作经历|工作经验|项目经历|项目经验|教育经历|教育背景|专业技能|资格证书|所获荣誉|荣誉奖项|获奖经历|语言能力/;

function normalized(text){
  return String(text||'').normalize('NFKC').toLowerCase()
    .replace(/[\s\u200B-\u200D\uFEFF，,。.;；:：、!！?？]/g,'')
    .replace(/[＊﹡∗]/g,'*');
}
// Raw assembly must use precisely the same comparison rules when binding its
// exact overlap to the full boundary that this proof accepted.
export {normalized as normalizeClipboardProofText};

function hasHeader(text,expectedName=''){
  const lines=String(text||'').split(/\r?\n/).slice(0,8);
  if(expectedName){
    const matches=lines.map((line,index)=>matchesCandidateNameLine(line,expectedName)?index:-1).filter(index=>index>=0);
    if(matches.length!==1)return false;
    if(/[*＊﹡∗]|先生$|女士$/.test(expectedName))return true;
    // A bound full name needs the adjacent identity row too. Its education and
    // experience columns can appear in either order in recommendation layouts.
    const metadata=normalized(lines.slice(matches[0]+1,matches[0]+4).join(''));
    return /\d{1,2}岁/.test(metadata)&&/(?:\d{1,2}年(?:以上)?|应届|本科|硕士|博士|大专)/.test(metadata);
  }
  return lines.some(line=>/^([\p{L}·]{1,20}\*{1,4}|[\p{L}·]{1,12}(?:先生|女士))/u.test(normalized(line).slice(0,160)));
}
export {hasHeader as hasClipboardHeader};

function hasFold(text){
  return resumeFoldLabels(text).length>0;
}

export function hasTerminalClipboard(text){
  const value=normalized(text);
  const start=value.lastIndexOf(footerStart);
  return start>=0&&value.endsWith(footerEnd)&&value.length-footerEnd.length>=start+footerStart.length;
}

function prefixTable(value){
  const table=new Uint32Array(value.length);
  for(let i=1,j=0;i<value.length;i++){
    while(j&&value[i]!==value[j])j=table[j-1];
    if(value[i]===value[j])j++;
    table[i]=j;
  }
  return table;
}

function suffixPrefix(previous,next){
  const table=prefixTable(next);
  let length=0;
  for(let i=0;i<previous.length;i++){
    while(length&&previous[i]!==next[length])length=table[length-1];
    if(previous[i]===next[length])length++;
    if(length===next.length&&i<previous.length-1)length=table[length-1];
  }
  return next.slice(0,length);
}

function uniqueIn(text,anchor){
  const first=text.indexOf(anchor);
  return first>=0&&text.indexOf(anchor,first+1)===-1;
}

const contentLetters=text=>text.match(/[\p{L}\p{N}]/gu)||[];
function substantial(letters){
  if(letters.length<24||new Set(letters).size<8)return false;
  const period=letters.length-prefixTable(letters).at(-1);
  return letters.length<period*2;
}

function inspectOverlap(anchor,previous,next,assembly){
  const letters=contentLetters(anchor);
  const matches=text=>!anchor?0:!text.includes(anchor)?0:uniqueIn(text,anchor)?1:2;
  const diagnostic={reason:'accepted',overlapLength:anchor.length,letterCount:letters.length,distinctLetters:new Set(letters).size,
    duplicateWindows:0,independentRunLength:0,previousMatches:matches(previous),
    currentMatches:matches(next),assembledMatches:matches(assembly)};
  if(letters.length<24)return {...diagnostic,reason:'short'};
  if(!substantial(letters))return {...diagnostic,reason:'repetitive'};
  // Repeated technical descriptions are common across distinct projects. Mark
  // every character covered by a repeated 24-letter window, then require a
  // substantial independent run outside those repeated regions. In particular,
  // a short separator between two identical paragraphs is still insufficient.
  const fragments=new Map(),covered=new Int32Array(letters.length+1);
  const cover=start=>{covered[start]++;covered[start+24]--;};
  for(let i=0;i<=letters.length-24;i++){
    const fragment=letters.slice(i,i+24).join(''),seen=fragments.get(fragment);
    if(seen){
      if(!seen.repeated){cover(seen.start);seen.repeated=true;}
      cover(i);diagnostic.duplicateWindows++;
    }else fragments.set(fragment,{start:i,repeated:false});
  }
  const contexts=[previous,next,assembly].map(text=>contentLetters(text).join(''));
  let depth=0,start=0,witness=false;
  for(let i=0;i<=letters.length;i++){
    depth+=covered[i];
    if(i<letters.length&&depth===0)continue;
    const run=letters.slice(start,i);
    diagnostic.independentRunLength=Math.max(diagnostic.independentRunLength,run.length);
    if(!witness&&substantial(run)&&contexts.every(text=>uniqueIn(text,run.join(''))))witness=true;
    start=i+1;
  }
  if([diagnostic.previousMatches,diagnostic.currentMatches,diagnostic.assembledMatches].some(count=>count!==1))
    return {...diagnostic,reason:'ambiguous'};
  if(!witness)return {...diagnostic,reason:'independent'};
  if((anchor.includes('boss直聘平台')||anchor.includes('第三方平台'))&&!assembly.includes(footerStart))
    return {...diagnostic,reason:'footer'};
  return diagnostic;
}

function state(complete,topVerified,screens,issue='',accepted=false){
  const verified=complete&&!issue;
  return {complete:verified,accepted,issue,topVerified,bottomVerified:verified,allScreensRead:verified,screens};
}

export function proveWholeClipboard(wholeText,firstScreenText,{expectedName=''}={}){
  const topVerified=hasHeader(firstScreenText,expectedName)&&hasHeader(wholeText,expectedName);
  const complete=topVerified&&chapter.test(normalized(wholeText))&&!hasFold(wholeText)&&hasTerminalClipboard(wholeText);
  return state(complete,topVerified,complete?1:0,complete?'':'未确认全选正文同时包含简历开头、章节和平台末尾。',complete);
}

export function createClipboardProof({expectedName=''}={}){
  let assembly='',previous='',screens=0,topVerified=false,complete=false,issue='',overlapDiagnostic=null;
  const snapshot=()=>({...state(complete,topVerified,screens,issue),...(overlapDiagnostic?{overlap:overlapDiagnostic}:{})});
  return {
    snapshot,
    observe(text){
      const value=normalized(text);
      if(issue)return snapshot();
      overlapDiagnostic=null;
      if(!value||hasFold(text)){
        issue=!value?'本屏没有可核对的剪贴板文字。':'本屏仍有折叠内容，尚未确认展开。';
        return snapshot();
      }
      if(!screens){
        topVerified=hasHeader(text,expectedName);
        if(!topVerified){
          issue='未在首屏确认候选人姓名和简历开头。';
          return snapshot();
        }
        assembly=value;
      }else{
        if(value===previous){
          if(complete)return state(true,true,screens,'',false);
          issue='剪贴板正文没有前进，尚未读到平台末尾。';
          return snapshot();
        }
        const overlap=suffixPrefix(previous,value);
        overlapDiagnostic=inspectOverlap(overlap,previous,value,assembly);
        if(overlapDiagnostic.reason!=='accepted'){
          issue='相邻分屏之间没有唯一且充分的重叠文字，无法确认中间内容连续。';
          return snapshot();
        }
        const added=value.slice(overlap.length);
        if(!added){
          issue='本屏没有新增正文，尚未确认读取完整。';
          return snapshot();
        }
        assembly+=added;
      }
      previous=value;
      screens++;
      complete=chapter.test(assembly)&&hasTerminalClipboard(assembly);
      return {...state(complete,topVerified,screens,'',true),...(overlapDiagnostic?{overlap:overlapDiagnostic}:{})};
    },
  };
}
