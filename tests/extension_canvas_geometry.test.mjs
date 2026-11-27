import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8');
const window={};vm.runInNewContext(source,{window});
const geometry=window.__hrmCanvasGeometry;
const identity=[1,0,0,1,0,0];
const command=(name,args=[],matrix=identity)=>({name,args,matrix:[...matrix]});
const plain=value=>JSON.parse(JSON.stringify(value));
const box=(left,top,right,bottom)=>({left,top,right,bottom});
const analyze=(commands,matrix)=>geometry.analyze(matrix?commands.map(c=>({...c,matrix:[...matrix]})):commands);
const polygon=(points,closed=true)=>points.map((p,i)=>command(i?'lineTo':'moveTo',p)).concat(closed?[command('closePath')]:[]);
const rounded=({radii=[10,10,10,10],width=100,height=80,clockwise=true,lines=false,closed=true}={})=>{
  const [tl,tr,br,bl]=radii;
  const parts=clockwise?[
    [[width-tr,0],[width,0,width,height,tr]],
    [[width,height-br],[width,height,0,height,br]],
    [[bl,height],[0,height,0,0,bl]],
    [[0,tl],[0,0,width,0,tl]],
  ]:[
    [[tl,0],[0,0,0,height,tl]],
    [[0,height-bl],[0,height,width,height,bl]],
    [[width-br,height],[width,height,width,0,br]],
    [[width,tr],[width,0,0,0,tr]],
  ];
  return [command('moveTo',[tl,0]),...parts.flatMap(([line,arc])=>[
    ...(lines?[command('lineTo',line)]:[]),command('arcTo',arc)]),...(closed?[command('closePath')]:[])];
};

test('installs a pure idempotent geometry API without touching Canvas prototypes',()=>{
  assert.equal(geometry.version,1);assert.equal(Object.isFrozen(geometry),true);
  vm.runInNewContext(source,{window});assert.equal(window.__hrmCanvasGeometry,geometry);
});

test('rect paths normalize negative dimensions and apply a positive diagonal transform',()=>{
  const result=analyze([command('rect',[40,50,-30,-20]),command('closePath')],[2,0,0,3,7,11]);
  assert.deepEqual(plain(result),{kind:'rect',bounds:box(27,101,87,161)});
  assert.equal(geometry.rectInside(result,box(27,101,87,161)),true);
  assert.equal(geometry.rectInside(result,box(26,101,87,161)),false);
  assert.equal(analyze([command('rect',[0,0,0,20])]),null);
});

test('one closed axis-aligned rectangle is recognized in either direction and at any starting corner',()=>{
  const points=[[10,20],[80,20],[80,90],[10,90]];
  for(const ordered of [points,[...points].reverse()])for(let start=0;start<4;start++) {
    const rotated=ordered.slice(start).concat(ordered.slice(0,start));
    const result=analyze(polygon(rotated));
    assert.deepEqual(plain(result),{kind:'rect',bounds:box(10,20,80,90)});
    assert.deepEqual(plain(analyze(polygon([...rotated,rotated[0]],false))),plain(result));
  }
  assert.equal(analyze(polygon(points,false)),null);
});

test('full circles and ellipses require a full sweep in the actual drawing direction',()=>{
  const circle=analyze([command('arc',[50,60,20,0,Math.PI*2]),command('closePath')],[2,0,0,3,5,7]);
  assert.deepEqual(plain(circle),{kind:'ellipse',bounds:box(65,127,145,247),cx:105,cy:187,rx:40,ry:60});
  assert.equal(analyze([command('arc',[0,0,10,0,Math.PI*2,true])]),null);
  assert.equal(analyze([command('arc',[0,0,10,0,Math.PI*2-0.000001])]),null);
  assert.equal(analyze([command('arc',[0,0,10,0,-Math.PI*2,true])]).kind,'ellipse');
  assert.equal(analyze([command('arc',[0,0,10,0,Math.PI*4])]).kind,'ellipse');
  const ellipse=analyze([command('ellipse',[0,0,30,20,0,1,1+Math.PI*2])]);
  assert.deepEqual(plain(ellipse),{kind:'ellipse',bounds:box(-30,-20,30,20),cx:0,cy:0,rx:30,ry:20});
  assert.equal(analyze([command('ellipse',[0,0,30,20,Math.PI/4,0,Math.PI*2])]),null);
  assert.equal(analyze([command('arc',[0,0,0,0,Math.PI*2])]),null);
});

test('ellipse containment checks the curved boundary rather than only its bounds',()=>{
  const shape=analyze([command('ellipse',[50,50,40,20,0,0,Math.PI*2])]);
  assert.equal(geometry.rectInside(shape,box(35,40,65,60)),true);
  assert.equal(geometry.rectInside(shape,box(10,30,12,32)),false);
  assert.equal(geometry.rectInside(shape,shape.bounds),false);
  assert.equal(geometry.rectInside(shape,box(49,29,51,31)),false);
});

test('native roundRect expands all standard corner radius lists and scales oversized radii',()=>{
  for(const [input,expected] of [[10,[10,10,10,10]],[[5,10],[5,10,5,10]],[[5,10,15],[5,10,15,10]],
    [[5,10,15,20],[5,10,15,20]]]) {
    const shape=analyze([command('roundRect',[0,0,100,80,input])]);
    assert.equal(shape.kind,'roundRect');assert.deepEqual(plain(shape.radii.map(r=>r.x)),expected);
  }
  const scaled=analyze([command('roundRect',[0,0,100,40,100])]);
  assert.deepEqual(plain(scaled.radii),Array.from({length:4},()=>({x:20,y:20})));
  const zero=analyze([command('roundRect',[0,0,100,80])]);
  assert.equal(geometry.rectInside(zero,zero.bounds),true);
});

test('native elliptical corner radii retain corner order after non-uniform scaling',()=>{
  const input=[{x:10,y:5},{x:15,y:20},5,{x:0,y:10}];
  const shape=analyze([command('roundRect',[0,0,100,80,input])],[2,0,0,3,20,30]);
  assert.deepEqual(plain(shape.radii),[{x:20,y:15},{x:30,y:60},{x:10,y:15},{x:0,y:30}]);
  assert.deepEqual(plain(shape.bounds),box(20,30,220,270));
  input[0].x=999;assert.equal(shape.radii[0].x,20);
  assert.equal(Object.isFrozen(shape.radii[0]),true);assert.equal(Object.isFrozen(shape.bounds),true);
  for(const radii of [[],[1,2,3,4,5],-1,{x:-1,y:2},{x:Infinity,y:2},'10'])
    assert.equal(analyze([command('roundRect',[0,0,100,80,radii])]),null);
  assert.equal(analyze([command('roundRect',[100,0,-100,80,10])]),null);
});

test('four tangent arcTo corners recognize rounded rectangles with or without explicit side lines',()=>{
  for(const clockwise of [true,false])for(const lines of [true,false]) {
    const result=analyze(rounded({radii:[5,10,15,20],clockwise,lines}));
    assert.deepEqual(plain(result),{kind:'roundRect',bounds:box(0,0,100,80),radii:[5,10,15,20].map(r=>({x:r,y:r}))});
  }
  const result=analyze(rounded({radii:[5,10,15,20]}),[2,0,0,3,7,11]);
  assert.deepEqual(plain(result.bounds),box(7,11,207,251));
  assert.deepEqual(plain(result.radii),[5,10,15,20].map(r=>({x:r*2,y:r*3})));
});

test('a rounded path can start along a straight edge but every segment must advance along the perimeter',()=>{
  const path=rounded();path[0]=command('moveTo',[40,0]);
  assert.equal(analyze(path).kind,'roundRect');
  path.splice(1,0,command('lineTo',[30,0]));assert.equal(analyze(path),null);
  const diagonal=rounded();diagonal[0]=command('moveTo',[40,5]);assert.equal(analyze(diagonal),null);
  const closed=rounded({closed:false});assert.equal(analyze(closed).kind,'roundRect');
  closed[0]=command('moveTo',[40,0]);assert.equal(analyze(closed),null);
});

test('rounded rectangle containment rejects clipped corners while accepting safe central text',()=>{
  const shape=analyze(rounded({radii:[10,20,30,15]}));
  assert.equal(geometry.rectInside(shape,box(15,20,70,60)),true);
  assert.equal(geometry.rectInside(shape,box(0,0,5,5)),false);
  assert.equal(geometry.rectInside(shape,box(95,0,100,5)),false);
  assert.equal(geometry.rectInside(shape,box(95,75,100,80)),false);
  assert.equal(geometry.rectInside(shape,box(0,75,5,80)),false);
  assert.equal(geometry.rectInside(shape,box(9,9,11,11)),true);
  assert.equal(geometry.rectInside(shape,box(-1,20,10,30)),false);
});

test('non-convex, oversized, incomplete and direction-changing arcTo paths stay unsupported',()=>{
  const malformed=[];
  const missing=rounded();missing.splice(2,1);malformed.push(missing);
  const extra=rounded();extra.splice(2,0,command('arcTo',[100,30,50,30,10]));malformed.push(extra);
  const inward=rounded();inward[2]=command('arcTo',[80,80,0,80,10]);malformed.push(inward);
  const wrongExit=rounded();wrongExit[1]=command('arcTo',[100,0,100,-80,10]);malformed.push(wrongExit);
  const crossed=rounded();[crossed[2],crossed[3]]=[crossed[3],crossed[2]];malformed.push(crossed);
  const collinear=rounded();collinear[1]=command('arcTo',[100,0,200,0,10]);malformed.push(collinear);
  const zero=rounded();zero[1]=command('arcTo',[100,0,100,80,0]);malformed.push(zero);
  const negative=rounded();negative[1]=command('arcTo',[100,0,100,80,-5]);malformed.push(negative);
  const shortControl=rounded();shortControl[1]=command('arcTo',[100,0,100,1,10]);malformed.push(shortControl);
  malformed.push(rounded({width:50,height:80,radii:[30,30,30,30]}));
  for(const path of malformed) assert.equal(analyze(path),null);
});

test('stars, bowties, extra subpaths and unknown Path2D commands never become bounding rectangles',()=>{
  const star=polygon([[0,0],[100,100],[50,0],[0,100],[100,0]]);
  const bowtie=polygon([[0,0],[100,100],[100,0],[0,100]]);
  for(const path of [star,bowtie,
    [command('rect',[0,0,100,80]),command('rect',[10,10,20,20])],
    [command('rect',[0,0,100,80]),command('moveTo',[10,10])],
    [command('arc',[0,0,10,0,Math.PI*2]),command('lineTo',[100,100])],
    [...rounded().slice(0,3),command('moveTo',[0,0]),...rounded().slice(3)],
    [command('addPath',[{}])],[command('Path2D',[{}])],[command('bezierCurveTo',[0,0,10,10,20,20])],
    [command('beginPath'),command('rect',[0,0,100,80]),command('beginPath')],
  ]) assert.equal(analyze(path),null);
  assert.equal(analyze({}),null);assert.equal(analyze([]),null);
  assert.equal(analyze(Array.from({length:65},()=>command('closePath'))),null);
});

test('only exactly equal finite positive diagonal transforms are accepted',()=>{
  for(const matrix of [[1,.01,0,1,0,0],[1,0,.01,1,0,0],[-1,0,0,1,0,0],[1,0,0,0,0,0],
    [1,0,0,1,Infinity,0],[1,0,0,1,0],[1,0,0,NaN,0,0]])
    assert.equal(analyze([command('rect',[0,0,100,80])],matrix),null);
  const mixed=rounded();mixed[2].matrix[4]=0.000000001;assert.equal(analyze(mixed),null);
  const missing=rounded();delete missing[2].matrix;assert.equal(analyze(missing),null);
  const sparse=rounded();sparse[2].matrix=Array(6);assert.equal(analyze(sparse),null);
  const invalid=rounded();invalid[2].args[0]=NaN;assert.equal(analyze(invalid),null);
  assert.equal(analyze([command('rect',[0,0,1e308,80])],[100,0,0,1,0,0]),null);
});

test('bounds queries handle disjoint and touching regions and refuse to prove unknown geometry safe',()=>{
  assert.equal(geometry.intersectsBounds(box(0,0,10,10),box(9,9,20,20)),true);
  assert.equal(geometry.intersectsBounds(box(0,0,10,10),box(10,0,20,10)),false);
  assert.equal(geometry.intersectsBounds(box(0,0,10,10),box(20,20,30,30)),false);
  assert.equal(geometry.intersectsBounds(null,box(0,0,10,10)),true);
  assert.equal(geometry.intersectsBounds(box(0,0,Infinity,10),box(0,0,10,10)),true);
  assert.equal(geometry.rectInside(null,box(0,0,10,10)),false);
  assert.equal(geometry.rectInside({kind:'unknown',bounds:box(0,0,100,100)},box(1,1,2,2)),false);
  assert.equal(geometry.rectInside(analyze(rounded()),box(0,0,0,10)),false);
});
