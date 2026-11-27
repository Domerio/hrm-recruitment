"""Native offline regressions for adjacent per-character keyword highlights.

Uses the same empty-profile, blocked-network Chromium driver as the broader
fill probes. All text and pixels are synthetic; no existing browser is opened.
"""
import native_canvas_fill_check as harness

preamble, separator, _ = harness.PROBE_JS.partition('await document.fonts.ready;')
assert separator, 'Native fill harness preamble marker is missing'
preamble = preamble.replace('const width=773,height=260;',
    'const width=773,height=956;canvas.height=height;canvas.style.height=height+"px";')
harness.PROBE_JS = preamble + r"""
await document.fonts.ready;
const font='14px "Microsoft YaHei"',x=426,y=393;
const priorCell={left:426,top:376,right:440,bottom:402};
const nextCell={left:440,top:376,right:454,bottom:402};
const mask=reference({font});mask.fillText('视',x,y);
const oldBounds=bounds(mask,'视',x,y),oldPixels=image(mask),edgePixels=[];
let pixels=0,corePixels=0;
for(let row=0;row<height;row++)for(let col=0;col<width;col++){
  const alpha=oldPixels[(row*width+col)*4+3];if(!alpha)continue;
  pixels++;if(alpha>=128)corePixels++;
  if(col>=nextCell.left&&col<nextCell.right&&row>=nextCell.top&&row<nextCell.bottom){
    const leftNeighbors=[-1,0,1].map(dy=>({x:col-1,y:row+dy,alpha:oldPixels[((row+dy)*width+col-1)*4+3]}));
    edgePixels.push({x:col,y:row,alpha,leftNeighbors});
  }
}
const exactUserGeometry=oldBounds.left===425&&oldBounds.top===382&&oldBounds.right===441&&oldBounds.bottom===394&&
  edgePixels.length===2&&edgePixels[0].alpha===25&&edgePixels[1].alpha===12&&corePixels===61&&
  edgePixels.every(pixel=>pixel.x===440&&pixel.alpha<128&&pixel.leftNeighbors.some(neighbor=>neighbor.alpha>=128));
if(!exactUserGeometry)throw Error('The native font no longer reproduces the reported highlight geometry: '+JSON.stringify({oldBounds,edgePixels,corePixels}));
const edgeProof={font,oldBounds,priorCell,nextCell,pixels,corePixels,edgePixels,exactUserGeometry};
for(const [name,options] of [
  ['exact-14px-yahei-adjacent-highlight-cells',{accept:true}],
  ['state-save-restore-between-highlight-and-glyph-allowed',{accept:true,stateOnly:true}],
  ['separate-thin-underline-preserves-old-highlight-proof',{accept:true,underlineY:397}],
  ['underline-stroke-style-change-does-not-change-fill-text-proof',{accept:true,underlineY:397,keepStrokeStyle:true}],
  ['underline-after-next-background-invalidates-pending-proof',{afterCoverUnderline:true,threeEdge:true}],
  ['thin-stroke-through-old-glyph-remains-rejected',{underlineY:390}],
  ['three-edge-cover-without-following-glyph-rejected',{omitNext:true,threeEdge:true}],
  ['three-edge-cover-followed-by-distant-glyph-rejected',{nextX:480,threeEdge:true}],
  ['edge-cover-followed-by-shifted-baseline-rejected',{nextY:394}],
  ['three-edge-cover-followed-by-subpixel-shifted-glyph-rejected',{nextX:440.25,threeEdge:true}],
  ['edge-cover-with-wrong-cell-width-rejected',{cell:{...nextCell,right:455}}],
  ['real-core-erasure-with-following-glyph-rejected',{cell:{...nextCell,left:439,right:453},nextX:439}],
  ['edge-clearRect-with-following-glyph-rejected',{clear:true}],
  ['intervening-pixel-operation-invalidates-neighbor-proof',{intervening:true,threeEdge:true}],
  ['three-edge-cover-with-translucent-following-glyph-rejected',{nextAlpha:.5,threeEdge:true}],
  ['three-edge-cover-with-different-font-following-glyph-rejected',{nextFont:'bold '+font,threeEdge:true}],
  ['edge-cover-with-no-prior-highlight-cell-confirmed-by-next-glyph',{accept:true,omitPriorCell:true}],
  ['three-edge-no-prior-needs-confirmed-next-glyph',{accept:true,omitPriorCell:true,threeEdge:true}],
  ['no-prior-cell-three-edge-without-following-glyph-rejected',{omitPriorCell:true,omitNext:true,threeEdge:true}],
  ['no-prior-cell-three-edge-changed-following-font-rejected',{omitPriorCell:true,nextFont:'bold '+font,threeEdge:true}],
  ['no-prior-cell-three-edge-shifted-following-glyph-rejected',{omitPriorCell:true,nextX:441,threeEdge:true}],
  ['no-prior-cell-with-core-erasure-rejected',{omitPriorCell:true,cell:{...nextCell,left:439,right:453},nextX:439}],
  ['no-prior-cell-three-edge-intervening-paint-rejected',{omitPriorCell:true,intervening:true,threeEdge:true}],
  ['different-color-prior-cell-does-not-change-tiny-original-fringe',{accept:true,priorColor:'#ffe0e0'}],
  ['disjoint-paint-before-original-does-not-damage-tiny-fringe',{accept:true,beforeOldGlyph:true}],
  ['disjoint-paint-after-original-does-not-damage-tiny-fringe',{accept:true,afterOldGlyph:true}],
]){
  const ref=reference({font});style(ctx,{font});const shift=0,oldX=x,
    oldGlyph=options.threeEdge?'机':'视',nextGlyph=options.threeEdge?'器':'觉',
    shiftedPrior=priorCell,shiftedNext=nextCell,cell=options.cell||shiftedNext,
    originalGlyph=reference({font});originalGlyph.fillText(oldGlyph,oldX,y);
  const touchedBefore=touched(image(originalGlyph),cell);
  for(const p of [ctx,ref]){
    if(!options.omitPriorCell)paintRect(p,shiftedPrior,{color:options.priorColor||'#dff4f4'});
    if(options.beforeOldGlyph)paintRect(p,{left:700,top:20,right:701,bottom:21});
    if(options.stateOnly){p.save();p.restore();}
    p.fillText(oldGlyph,oldX,y);
    if(options.underlineY!==undefined){
      if(!options.keepStrokeStyle)p.save();
      p.strokeStyle='#00a6a7';p.lineWidth=1;p.setLineDash([1,1]);
      p.beginPath();p.moveTo(oldX,options.underlineY);p.lineTo(440+shift,options.underlineY);p.stroke();
      if(!options.keepStrokeStyle)p.restore();
    }
    if(options.afterOldGlyph)paintRect(p,{left:700,top:20,right:701,bottom:21});
    if(options.clear)p.clearRect(cell.left,cell.top,cell.right-cell.left,cell.bottom-cell.top);
    else paintRect(p,cell);
    if(options.afterCoverUnderline){
      p.save();p.strokeStyle='#00a6a7';p.lineWidth=1;p.setLineDash([1,1]);
      p.beginPath();p.moveTo(oldX,397);p.lineTo(440+shift,397);p.stroke();p.restore();
    }
    if(options.intervening)paintRect(p,{left:700,top:20,right:701,bottom:21});
    if(options.stateOnly){p.save();p.restore();}
    if(!options.omitNext){
      p.globalAlpha=options.nextAlpha??1;p.font=options.nextFont||font;
      p.fillText(nextGlyph,options.nextX??440,options.nextY??393);
    }
  }
  record(name,options.accept?oldGlyph+nextGlyph:'',ref,{reject:!options.accept,
    proof:{...edgeProof,cell,shift,covered:touchedBefore,options}});
  if(options.threeEdge&&!options.cell)cases.at(-1).passed&&=touchedBefore.pixels===3&&touchedBefore.corePixels===0;
  if(name==='real-core-erasure-with-following-glyph-rejected')cases.at(-1).passed&&=touched(oldPixels,cell).corePixels>0;
  if(options.underlineY===390){
    const item=cases.at(-1);
    item.passed=item.pixelExactlyMatchesReference&&item.issueCode==='unsupported'&&item.actualText===''&&
      /局部覆盖|文字重叠|无法直接读取的路径绘制/.test(item.issue);
  }
}
// The alternate order must not make a partially erased next word look
// complete: a solid source-over cell placed after both glyphs destroys core
// pixels of the right-hand glyph. The left-hand AA fringe alone cannot certify
// this paint as harmless. A fallback must require the fill touches only the
// original single glyph, so no other previously recorded text is discarded.
{
  const ref=reference({font}),old=reference({font}),next=reference({font});
  style(ctx,{font});old.fillText('视',x,y);next.fillText('觉',440,y);
  const nextBefore=touched(image(next),nextCell);
  for(const p of [ctx,ref]){
    p.fillText('视',x,y);p.fillText('觉',440,y);paintRect(p,nextCell);
  }
  record('both-glyphs-before-later-highlight-must-not-claim-complete-source','',ref,
    {reject:true,proof:{...edgeProof,nextBefore}});
  cases.at(-1).passed&&=nextBefore.corePixels>0;
}
// A single originally drawn Han glyph retains all of its core while a
// precisely adjacent logical highlight cell trims only two antialiasing
// pixels. This separately exercises a late highlight without a later glyph.
{
  const ref=reference({font});style(ctx,{font});
  for(const p of [ctx,ref]){p.fillText('视',x,y);paintRect(p,nextCell);}
  record('single-han-right-cell-low-alpha-fringe-no-next-glyph','视',ref,
    {proof:{...edgeProof,covered:touched(oldPixels,nextCell)}});
}
// Two pixel-wide accents in a punctuation/Latin mark are not equivalent to
// the 61-core-pixel Han glyph above, even if the surviving pixels look close.
{
  const ref=reference({font:'14px Arial'});style(ctx,{font:'14px Arial'});
  const punct='i',px=426,py=393,b=bounds(ref,punct,px,py);
  const cell={left:Math.floor(b.right)-1,top:376,right:Math.floor(b.right)+2,bottom:402};
  const thinBefore=reference({font:'14px Arial'});thinBefore.fillText(punct,px,py);
  const thinTouched=touched(image(thinBefore),cell);
  for(const p of [ctx,ref]){p.fillText(punct,px,py);paintRect(p,cell);}
  record('thin-latin-glyph-has-no-han-fringe-exemption','',ref,
    {reject:true,proof:{bounds:b,cell,touched:thinTouched}});
  cases.at(-1).passed&&=thinTouched.pixels>0;
}
// Match the complete sentence while drawing individual highlighted cells before
// each glyph, as in the reported cyan keyword span. The position of 视 remains
// exactly (426,393), including its reported two clipped antialiasing pixels.
{
  const text='负责自动化设备的视觉应用',ref=reference({font});style(ctx,{font});
  const highlights=new Set([2,3,4,8,9,10,11]),draws=[];let cursor=314;
  for(const [index,glyph] of [...text].entries()){
    const advance=Math.floor(ref.measureText(glyph).width),cell={left:cursor,top:376,right:cursor+advance,bottom:402};
    for(const p of [ctx,ref]){if(highlights.has(index))paintRect(p,cell);p.fillText(glyph,cursor,393);}
    draws.push({glyph,x:cursor,advance,highlight:highlights.has(index)});cursor+=advance;
  }
  record('full-sentence-per-glyph-highlight-cells',text,ref,{proof:{...edgeProof,draws}});
}
const result={userAgent:navigator.userAgent,fonts:{yahei:document.fonts.check(font)},cases};
document.querySelector('#result').textContent=JSON.stringify(result).replace(/[\u007f-\uffff]/g,
  value=>'\\u'+value.charCodeAt(0).toString(16).padStart(4,'0'));
"""

if __name__ == '__main__':
    harness.main()
