// Injected into the pinned resume frame. Only return positions of this fixed
// control. The résumé itself is read separately from the clipboard.
export function visualExpandMarks() {
  if (location.protocol !== 'https:' || !['www.zhipin.com','zhipin.com'].includes(location.hostname) ||
      !/^\/web\/frame\/c-resume\/?$/.test(location.pathname)) return [];
  const canvases = [...document.querySelectorAll('canvas')].filter(canvas => {
    const bounds = canvas.getBoundingClientRect(), style = getComputedStyle(canvas);
    return bounds.width >= 250 && bounds.height >= 150 &&
      style.visibility === 'visible' && Number(style.opacity) > 0;
  });
  if (canvases.length !== 1) return [];
  const canvas = canvases[0], bounds = canvas.getBoundingClientRect();
  const left = Math.max(0,bounds.left), top = Math.max(0,bounds.top);
  const width = Math.floor(Math.min(innerWidth,bounds.right)-left);
  const height = Math.floor(Math.min(innerHeight,bounds.bottom)-top);
  if (width < 250 || height < 150 || width*height > 2000000) return [];

  // One CSS pixel per sample, as in the reference mask. Keep the raster in
  // the frame and discard it after the match.
  const raster = document.createElement('canvas');
  raster.width = width;
  raster.height = height;
  const context = raster.getContext('2d',{willReadFrequently:true});
  if (!context) return [];
  const sx = canvas.width/bounds.width, sy = canvas.height/bounds.height;
  let pixels;
  try {
    context.fillStyle = '#fff';
    context.fillRect(0,0,width,height);
    context.drawImage(canvas,(left-bounds.left)*sx,(top-bounds.top)*sy,width*sx,height*sy,0,0,width,height);
    pixels = context.getImageData(0,0,width,height).data;
  } catch {
    return [];
  }
  const ink = new Uint8Array(width*height);
  for (let i=0; i<ink.length; i++) {
    const r = pixels[4*i], g = pixels[4*i+1], b = pixels[4*i+2];
    ink[i] = g-r>=40 && b-r>=30 && Math.abs(g-b)<=50;
  }
  // Keep exact glyph masks for the same fixed control at two native raster
  // sizes. Browser zoom changes font hinting as well as scale; the larger mask
  // is the visible 查看全部 control from the reported screen (no resume pixels).
  // Only these known glyphs are accepted; color alone never establishes a link.
  const references = [{anchor:4, template:[
    '......##.......############.......###........##...######',
    '##############......##...........#####....##########..##',
    '.....####......############....###..###....##..##.##.##.',
    '..###.##.###.......##........###......###...##.#..####..',
    '#######################################################.',
    '..##......##.....##......##.......##..............##.###',
    '..##########...############.......##..............##..##',
    '..##......##..##.##......##...###########..#########..##',
    '..##########.....##########.......##.......##...####..##',
    '..##......##.....##......##.......##.......##...#######.',
    '.................##########.......##.......#########....',
    '##############...##......##.##############.##...####....'
  ]}, {anchor:6, template:[
    '.......##..........##############.........###...........##.....######',
    '.###############..###############........####...........##....#######',
    '################........##..............###.##......############...##',
    '.....######.......###############......###...##............#..##...#.',
    '...###.##.###..........##.............###.....###.....##...##.##..##.',
    '.####..##...####..################..###........####...##..##..##..##.',
    '################.###################################.###########.##..',
    '..############.......##............#..###########.#.############..##.',
    '..##........##......############..........##..................##...##',
    '..############.....####.......##..........##..........#######.##...##',
    '..############....##############.....############....########.##....#',
    '..##........##...###.##.......##.....#############...##....##.##....#',
    '..############.......###########..........##.........##....##.#######',
    '..##.........#.......###########..........##.........##....##.#######',
    '################.....##........#....###############..########.##.....',
    '#################....###########...################..##....##.##.....',
    '.....................#.........#......................#.....#..#.....',
  ]}].map(reference=>{
    const {anchor,template}=reference;
    const templateWidth=Math.max(...template.map(row=>row.length));
    const anchorLeft=template[anchor].indexOf('#'),anchorRight=template[anchor].lastIndexOf('#');
    return {...reference,templateWidth,anchorLeft,anchorWidth:anchorRight-anchorLeft+1,
      templateInk:template.reduce((sum,row,y)=>y===anchor?sum:sum+row.replace(/\./g,'').length,0)};
  });
  const matches = [];
  function scaledMask(reference,scale) {
    const {template,templateWidth,anchor}=reference;
    const w=Math.round(templateWidth*scale),h=Math.round(template.length*scale);
    const data=new Uint8Array(w*h),excluded=new Uint8Array(h);
    let count=0;
    const sample=(x,y)=>template[y]?.[x]==='#'?1:0;
    for (let y=0;y<h;y++) {
      const sy=(y+.5)/scale-.5,y0=Math.floor(sy),fy=sy-y0;
      excluded[y]=Math.round(sy)===anchor;
      for (let x=0;x<w;x++) {
        const sx=(x+.5)/scale-.5,x0=Math.floor(sx),fx=sx-x0;
        const coverage=sample(x0,y0)*(1-fx)*(1-fy)+sample(x0+1,y0)*fx*(1-fy)+
          sample(x0,y0+1)*(1-fx)*fy+sample(x0+1,y0+1)*fx*fy;
        data[y*w+x]=coverage>=.25?1:0;
        if (!excluded[y]) count+=data[y*w+x];
      }
    }
    return {w,h,data,excluded,count};
  }
  function matchRun(start,y,length,reference) {
    const {anchor,anchorLeft,anchorWidth}=reference;
    const estimated=length/anchorWidth;
    if (estimated<.5 || estimated>2.5) return;
    let best;
    // Compare at the observed raster resolution. Sampling an enlarged source
    // mask once per original pixel overcounts merged strokes when zoomed out.
    for (const correction of [-.015,0,.015]) {
      const scale=estimated+correction,mask=scaledMask(reference,scale);
      for (const dx of [-1,0,1]) for (const dy of [-1,0,1]) {
        const x=Math.round(start-anchorLeft*scale+dx),top=Math.round(y-anchor*scale+dy);
        if (x<0 || x+mask.w>width || top<0 || top+mask.h>height) continue;
        let sampleInk=0,overlap=0;
        for (let row=0;row<mask.h;row++) {
          if (mask.excluded[row]) continue;
          const offset=(top+row)*width+x;
          for (let column=0;column<mask.w;column++) {
            if (!ink[offset+column]) continue;
            sampleInk++;
            if (mask.data[row*mask.w+column]) overlap++;
          }
        }
        const score=2*overlap/(sampleInk+mask.count);
        if (score>=.84 && (!best || score>best.score))
          best={x:x+mask.w/2,y:top+mask.h/2,left:x,top,right:x+mask.w,bottom:top+mask.h,score};
      }
    }
    if (!best) return;
    const duplicate=matches.findIndex(match=>Math.hypot(match.x-best.x,match.y-best.y)<8);
    if (duplicate<0) matches.push(best);
    else if (matches[duplicate].score<best.score) matches[duplicate]=best;
  }
  // At fractional zoom a formerly continuous crossbar can acquire one or two
  // white pixels between glyphs. Bridge only such short gaps to propose anchors;
  // the complete unmodified glyph mask above still has to pass the .84 score.
  for (let y=0; y<height; y++) {
    let start=-1,last=-1;
    const finish=()=>{
      const length=last-start+1;
      if (start>=0 && length>=28 && length<=140)
        for (const reference of references) matchRun(start,y,length,reference);
      start=last=-1;
    };
    for (let x=0; x<=width+2; x++) {
      if (x<width && ink[y*width+x]) {
        if (start<0) start=x;
        last=x;
      } else if (start>=0 && x-last>2) finish();
    }
  }
  return matches.map(match=>({id:0,label:'查看全部',
    x:(left-bounds.left+match.x)/bounds.width,y:(top-bounds.top+match.y)/bounds.height,
    left:(left-bounds.left+match.left)/bounds.width,top:(top-bounds.top+match.top)/bounds.height,
    right:(left-bounds.left+match.right)/bounds.width,bottom:(top-bounds.top+match.bottom)/bounds.height}));
}
