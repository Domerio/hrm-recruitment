"""Offline native Canvas checks for a raster badge beside resume header text.

Uses the fill probe's isolated headless Chromium, blocked network and empty
profile. The source bitmap is synthetic; no actual hiring page is opened.
"""
import native_canvas_fill_check as harness

preamble, separator, _ = harness.PROBE_JS.partition('await document.fonts.ready;')
assert separator, 'Native fill harness preamble marker is missing'
preamble = preamble.replace('const width=773,height=260;',
    'const width=773,height=956;canvas.height=height;canvas.style.height=height+"px";')
harness.PROBE_JS = preamble + r"""
await document.fonts.ready;
const badgeCanvas=new OffscreenCanvas(126,63),badgePaint=badgeCanvas.getContext('2d');
badgePaint.fillStyle='#08a994';badgePaint.fillRect(0,0,126,63);
badgePaint.fillStyle='#ffffff';badgePaint.font='24px "Microsoft YaHei"';
badgePaint.textBaseline='alphabetic';badgePaint.fillText('在线',31,43);
const badge=await createImageBitmap(badgeCanvas);
const sourceRect={x:8,y:4,width:110,height:52};
const destination={x:204,y:34,width:46,height:20};
const imageRect={left:destination.x,top:destination.y,right:destination.x+destination.width,
  bottom:destination.y+destination.height};
function drawBadge(p,x=destination.x,y=destination.y){
  p.drawImage(badge,sourceRect.x,sourceRect.y,sourceRect.width,sourceRect.height,
    x,y,destination.width,destination.height);
}
function addCase(name,ref,expectedText,{reject=false,proof={}}={}){
  const snapshot=window.__hrmCanvasText.snapshot();
  const actual=image(ctx),expected=image(ref);
  const samePixels=actual.length===expected.length&&actual.every((byte,index)=>byte===expected[index]);
  const actualBytes=new TextEncoder().encode(snapshot.text),expectedBytes=new TextEncoder().encode(expectedText);
  const sameText=actualBytes.length===expectedBytes.length&&actualBytes.every((byte,index)=>byte===expectedBytes[index]);
  cases.push({name,passed:samePixels&&(reject?Boolean(snapshot.issue)&&snapshot.text==='':!snapshot.issue&&sameText),
    reject,issue:snapshot.issue,issueCode:snapshot.issueCode||'',actualText:snapshot.text,
    expectedText,pixelExactlyMatchesReference:samePixels,proof,
    diagnostics:snapshot.diagnostics});
}
const name='唐汇鑫',meta='39岁 | 本科 | 10年以上 | 离职-随时到岗',body='负责视觉应用开发';
function drawHeader(p){
  p.font='20px "Microsoft YaHei"';p.fillText(name,124,49);
  p.font='14px "Microsoft YaHei"';p.fillText(meta,130,80);p.fillText(body,130,130);
}
{
  const ref=reference({font:'20px "Microsoft YaHei"'});style(ctx,{font:'20px "Microsoft YaHei"'});
  for(const p of [ctx,ref]){drawHeader(p);drawBadge(p);}
  const expectedText=[name,meta,body].join('\n');
  addCase('cropped-126x63-status-badge-beside-header-is-decoration',ref,expectedText,
    {proof:{sourceWidth:badge.width,sourceHeight:badge.height,sourceRect,destination,imageRect,
      crop:sourceRect.x!==0||sourceRect.y!==0||sourceRect.width!==badge.width||sourceRect.height!==badge.height,
      textBounds:bounds(ref,name,124,49)}});
  cases.at(-1).passed&&=cases.at(-1).proof.crop===true&&
    intersection(imageRect,cases.at(-1).proof.textBounds)===0&&
    cases.at(-1).diagnostics.ignoredImages===1;
}
{
  const ref=reference({font:'20px "Microsoft YaHei"'});style(ctx,{font:'20px "Microsoft YaHei"'});
  for(const p of [ctx,ref]){drawHeader(p);drawBadge(p,260,115);}
  addCase('cropped-badge-outside-body-text-is-also-decoration',ref,[name,meta,body].join('\n'),
    {proof:{imageRect:{left:260,top:115,right:306,bottom:135},bodyBox:bounds(ref,body,130,130)}});
  cases.at(-1).passed&&=cases.at(-1).diagnostics.ignoredImages===1&&
    intersection(cases.at(-1).proof.imageRect,cases.at(-1).proof.bodyBox)===0;
}
{
  const ref=reference({font:'20px "Microsoft YaHei"'});style(ctx,{font:'20px "Microsoft YaHei"'});
  for(const p of [ctx,ref]){drawHeader(p);drawBadge(p,151,34);}
  const nameBox=bounds(ref,name,124,49),overlap={left:151,top:34,right:197,bottom:54};
  addCase('badge-overlapping-header-name-still-blocks',ref,'',
    {reject:true,proof:{imageRect:overlap,nameBox,intersection:intersection(overlap,nameBox)}});
  cases.at(-1).passed&&=cases.at(-1).proof.intersection>0;
}
{
  const ref=reference({font:'20px "Microsoft YaHei"'});style(ctx,{font:'20px "Microsoft YaHei"'});
  for(const p of [ctx,ref]){drawHeader(p);drawBadge(p,130,115);}
  const bodyBox=bounds(ref,body,130,130),overlap={left:130,top:115,right:176,bottom:135};
  addCase('same-badge-overlapping-body-text-still-blocks',ref,'',
    {reject:true,proof:{imageRect:overlap,bodyBox,intersection:intersection(overlap,bodyBox)}});
  cases.at(-1).passed&&=cases.at(-1).proof.intersection>0;
}
{
  const cache=document.createElement('canvas');cache.width=width;cache.height=height;
  const cacheCtx=cache.getContext('2d');style(cacheCtx,{font:'20px "Microsoft YaHei"'});
  cacheCtx.fillText('完整简历原文',130,130);
  const ref=reference({font:'20px "Microsoft YaHei"'});style(ctx,{font:'20px "Microsoft YaHei"'});
  for(const p of [ctx,ref])p.drawImage(cache,0,0);
  addCase('canvas-source-with-text-still-reconstructs-source',ref,'完整简历原文',
    {proof:{sourceWidth:cache.width,sourceHeight:cache.height,sourceIsCanvas:true}});
}
badge.close();
const result={userAgent:navigator.userAgent,fonts:{yahei:document.fonts.check('20px "Microsoft YaHei"')},cases};
document.querySelector('#result').textContent=JSON.stringify(result).replace(/[\u007f-\uffff]/g,
  value=>'\\u'+value.charCodeAt(0).toString(16).padStart(4,'0'));
"""

if __name__ == '__main__':
    harness.main()
