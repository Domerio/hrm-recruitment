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
  // Teal shape of the known 查看全部 link, including the horizontal stroke
  // on row 4. The stroke anchors the search and is excluded from the score.
  const template = [
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
  ];
  const anchor = 4;
  const templateWidth = template[0].length;
  const templateInk = template.reduce((sum,row,y)=>y===anchor?sum:sum+row.replace(/\./g,'').length,0);
  const matches = [];
  function matchRun(start,y,length) {
    const scale = length/55;
    const rows = template.map((_,row)=>Math.round((row-anchor)*scale));
    const columns = Array.from({length:templateWidth},(_,column)=>Math.round(column*scale));
    let best;
    for (const dx of [-1,0,1]) {
      for (const dy of [-1,0,1]) {
        const x = start+dx, line = y+dy;
        if (x<0 || x+columns.at(-1)>=width || line+rows[0]<0 || line+rows.at(-1)>=height) continue;
        let sampleInk=0, overlap=0;
        for (let row=0; row<template.length; row++) {
          if (row===anchor) continue;
          const offset = (line+rows[row])*width+x;
          for (let column=0; column<templateWidth; column++) {
            if (!ink[offset+columns[column]]) continue;
            sampleInk++;
            if (template[row][column]==='#') overlap++;
          }
        }
        const score = 2*overlap/(sampleInk+templateInk);
        if (score>=.84 && (!best || score>best.score)) {
          best = {x:x+length/2,y:line+(rows[0]+rows.at(-1))/2,score};
        }
      }
    }
    if (!best) return;
    const duplicate = matches.findIndex(match=>Math.hypot(match.x-best.x,match.y-best.y)<8);
    if (duplicate<0) matches.push(best);
    else if (matches[duplicate].score<best.score) matches[duplicate]=best;
  }
  for (let y=0; y<height; y++) {
    let start = -1;
    for (let x=0; x<=width; x++) {
      if (x<width && ink[y*width+x]) {
        if (start<0) start=x;
      } else if (start>=0) {
        const length=x-start;
        if (length>=38 && length<=85) matchRun(start,y,length);
        start=-1;
      }
    }
  }
  return matches.map(match=>({id:0,label:'查看全部',
    x:(left-bounds.left+match.x)/bounds.width,y:(top-bounds.top+match.y)/bounds.height}));
}
