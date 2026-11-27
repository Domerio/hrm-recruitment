import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../extension/canvas-text.js',import.meta.url),'utf8');
function fixture({hostname='www.zhipin.com',pathname='/web/frame/c-resume/',initialClear=true,armed=true}={}) {
  class Canvas {
    constructor(){this._width=1000;this._height=1000;this.isConnected=true;this.ctx=null;}
    get width(){return this._width;}
    set width(value){this._width=value;}
    get height(){return this._height;}
    set height(value){this._height=value;}
    getContext(){return this.ctx;}
    getBoundingClientRect(){return {left:0,top:0,width:500,height:500};}
  }
  class Context {
    constructor(canvas){this.canvas=canvas;canvas.ctx=this;this.globalAlpha=1;this.fillStyle='#ffffff';
      this.globalCompositeOperation='source-over';this.direction='ltr';this.textAlign='start';this.textBaseline='alphabetic';
      this.filter='none';this.lineWidth=1;this.strokeStyle='#000000';
      this.matrix={a:1,b:0,c:0,d:1,e:0,f:0};this.calls=[];}
    fillText(...args){this.calls.push(args);}
    strokeText(){}
    clearRect(){}
    fillRect(){}
    drawImage(){}
    putImageData(){}
    save(){}
    restore(){}
    clip(){}
    reset(){}
    beginPath(){}
    moveTo(){}
    lineTo(){}
    rect(){}
    closePath(){}
    arc(){}
    fill(){}
    stroke(){}
    strokeRect(){}
    getTransform(){return this.matrix;}
    measureText(value){const width=value.length*10,left=['right','end'].includes(this.textAlign)?width:this.textAlign==='center'?width/2:0;
      return {width,actualBoundingBoxLeft:left,actualBoundingBoxRight:width-left,
      actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};}
  }
  const canvas=new Canvas(),ctx=new Context(canvas),canvases=[canvas];
  const window={__hrmCanvasTextEnabled:armed};window.top=window;
  const original=Context.prototype.fillText;
  const document={querySelectorAll:()=>canvases,
    createElement:name=>name.toLowerCase()==='canvas'?new Canvas():{tagName:name},
    createElementNS:(namespace,name)=>namespace==='http://www.w3.org/1999/xhtml'&&name==='canvas'?new Canvas():{tagName:name,namespaceURI:namespace}};
  const originalCreation={createElement:document.createElement,createElementNS:document.createElementNS};
  const sandbox={window,CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,
    document,getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'}),
    location:{protocol:'https:',hostname,pathname}};
  vm.runInNewContext(fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8'),sandbox);
  vm.runInNewContext(source,sandbox);
  if(initialClear)ctx.clearRect(0,0,canvas.width,canvas.height);
  return {canvas,ctx,canvases,Context,Canvas,window,document,original,originalCreation,
    snapshot:options=>window.__hrmCanvasText?.snapshot({textOnly:false,...options}),
    stop:()=>window.__hrmCanvasText?.stop()};
}

test('records original text, preserves internal spaces, and sorts visually drawn lines',()=>{
  const f=fixture();
  f.ctx.fillText('熟悉 C++  和 OpenCV。',20,120);
  f.ctx.fillText('张**',20,40);
  f.ctx.fillText('工作经历',20,80);
  assert.equal(f.snapshot().text,'张**\n工作经历\n熟悉 C++  和 OpenCV。');
  assert.equal(f.snapshot().issue,'');
  assert.equal(f.ctx.calls.length,3);
  assert.equal(f.snapshot().version,1);
  f.stop();
});

test('nearby baseline groups cannot bridge successively into one transitive text row',()=>{
  for(const reverse of [false,true]){
    const f=fixture(),runs=[['甲',20,100],['乙',100,103],['丙',180,106],['丁',260,109]];
    // Neighboring bands are close enough to align, but the third band is too
    // far from the first. Matching any prior band alone would flatten all four.
    for(const run of reverse?[...runs].reverse():runs)f.ctx.fillText(...run);
    const result=f.snapshot();
    assert.equal(result.issue,'');assert.equal(result.text,'甲 乙\n丙 丁');
    assert.equal(result.diagnostics.entries,4);f.stop();
  }
});

test('invalid read bounds carry a fixed reason even when all drawing records are valid',()=>{
  const f=fixture();f.ctx.fillText('工作经历',20,80);
  for(const rect of [{x:-1,y:0,width:1000,height:1000},{x:0,y:0,width:1001,height:1000},{x:0,y:0,width:0,height:1000}]){
    const result=f.snapshot({rect});
    assert.equal(result.issue,'画布读取范围无效');assert.equal(result.failureReason,'canvas-range');
    assert.equal(result.text,'');assert.equal(result.diagnostics.baseline,true);
    assert.equal(result.diagnostics.entries,1);assert.equal(result.diagnostics.reasonCounts.length,0);
  }
  assert.equal(f.snapshot().issue,'');f.stop();
});

test('only an explicit scrolling read can defer a bottom row clipped into 39 individual glyphs',()=>{
  const f=fixture();f.ctx.fillText('张**',20,40);f.ctx.fillText('工作经历',20,80);f.ctx.fillText('完整正文',20,120);
  for(let index=0;index<39;index++)f.ctx.fillText('残',20+index*10,999);
  assert.match(f.snapshot().issue,/边界截断/);
  const result=f.snapshot({allowVerticalBoundary:true});
  assert.equal(result.issue,'');assert.equal(result.text,'张**\n工作经历\n完整正文');
  assert.deepEqual({...result.boundaryRows},{top:false,bottom:true});
  assert.equal(result.diagnostics.reasonCounts.find(item=>item.reason.includes('边界截断')).count,39);
  const detail=result.diagnostics.details.find(item=>item.kind==='text-boundary');
  assert.equal(detail.overflowBottom,1);assert.equal(detail.overflowTop,0);assert.equal(detail.deferred,true);
  assert.equal(detail.canvasHeight,1000);assert.equal(detail.baseline,999);
  assert.doesNotMatch(JSON.stringify(result.diagnostics),/张\*\*|完整正文|残/);f.stop();
});

test('vertical boundary deferral removes the whole mixed-metric row, including complete glyphs and controls',()=>{
  for(const edge of ['top','bottom']){
    const f=fixture(),measure=f.ctx.measureText.bind(f.ctx);
    f.ctx.measureText=value=>({...measure(value),...(value==='完整'?edge==='top'?
      {actualBoundingBoxAscent:0,actualBoundingBoxDescent:0.5}:{actualBoundingBoxAscent:1,actualBoundingBoxDescent:0}:{})});
    f.ctx.fillText('中间完整正文',20,500);
    const y=edge==='top'?1:999;
    f.ctx.fillText('残',20,y);f.ctx.fillText('完整',40,y);
    const result=f.snapshot({allowVerticalBoundary:true});
    assert.equal(result.issue,'');assert.equal(result.text,'中间完整正文');assert.equal(result.boundaryRows[edge],true);
    assert.equal(f.snapshot({allowVerticalBoundary:true,rect:{x:0,y:400,width:1000,height:200}}).boundaryRows[edge],false);f.stop();
  }
});

test('boundary evidence on a secondary baseline defers the entire visually merged row',()=>{
  for(const edge of ['top','bottom']){
    const f=fixture(),measure=f.ctx.measureText.bind(f.ctx);
    f.ctx.measureText=value=>({...measure(value),...({
      主行:edge==='top'?{actualBoundingBoxAscent:0,actualBoundingBoxDescent:10}:
        {actualBoundingBoxAscent:10,actualBoundingBoxDescent:0},
      次行:edge==='top'?{actualBoundingBoxAscent:-1,actualBoundingBoxDescent:10}:
        {actualBoundingBoxAscent:10,actualBoundingBoxDescent:-1},
      残:edge==='top'?{actualBoundingBoxAscent:2,actualBoundingBoxDescent:0}:
        {actualBoundingBoxAscent:0,actualBoundingBoxDescent:2},
    }[value]||{})});
    f.ctx.fillText('中间完整正文',20,500);
    const primary=edge==='top'?2:998,secondary=edge==='top'?1:999;
    f.ctx.fillText('主行',20,primary);f.ctx.fillText('次行',80,secondary);
    assert.equal(f.snapshot().text,edge==='top'?'主行 次行\n中间完整正文':'中间完整正文\n主行 次行');
    // The clipped mark belongs to the second original baseline, while the
    // merged row's representative baseline belongs to the first text run.
    // Its visible ink is outside the cropped read, unlike both complete runs.
    f.ctx.fillText('残',130,secondary);
    assert.match(f.snapshot().issue,/边界截断/);
    for(const rect of [undefined,{x:0,y:2,width:1000,height:996}]){
      const result=f.snapshot({allowVerticalBoundary:true,...(rect?{rect}:{})});
      assert.equal(result.issue,'');assert.equal(result.text,'中间完整正文');
      assert.equal(result.boundaryRows[edge],true);
      assert.doesNotMatch(result.text,/主行|次行|残/);
    }
    const unrelated=f.snapshot({allowVerticalBoundary:true,rect:{x:0,y:400,width:1000,height:200}});
    assert.equal(unrelated.issue,'');assert.equal(unrelated.text,'中间完整正文');
    assert.equal(unrelated.boundaryRows[edge],false);f.stop();
  }
});

test('horizontal, corner, both-edge and internal clip truncation remain unsupported in scrolling reads',()=>{
  for(const position of [{x:-1,y:80},{x:995,y:80},{x:995,y:999},{x:-1,y:1}]){
    const f=fixture();f.ctx.fillText('正文',20,40);f.ctx.fillText('字',position.x,position.y);
    const result=f.snapshot({allowVerticalBoundary:true});assert.match(result.issue,/边界截断/);assert.equal(result.text,'');
    assert.equal(result.diagnostics.details.find(item=>item.kind==='text-boundary').deferred,false);f.stop();
  }
  const both=fixture();both.ctx.fillText('完整正文',20,40);
  const measure=both.ctx.measureText.bind(both.ctx);
  both.ctx.measureText=value=>({...measure(value),actualBoundingBoxAscent:600,actualBoundingBoxDescent:600});
  both.ctx.fillText('巨字',300,500);assert.match(both.snapshot({allowVerticalBoundary:true}).issue,/边界截断/);both.stop();
  const clip=fixture();clip.ctx.fillText('完整正文',20,40);
  clip.ctx.beginPath();clip.ctx.rect(0,0,1000,100);clip.ctx.clip();clip.ctx.fillText('字',20,99);
  assert.match(clip.snapshot({allowVerticalBoundary:true}).issue,/裁剪区域截断/);clip.stop();
});

test('an off-area clipped glyph still marks its same-baseline visible remainder as an unresolved row',()=>{
  const f=fixture(),measure=f.ctx.measureText.bind(f.ctx);
  f.ctx.measureText=value=>({...measure(value),...(value==='同行字'?{actualBoundingBoxAscent:-10,actualBoundingBoxDescent:20}:{})});
  f.ctx.fillText('残',20,1);f.ctx.fillText('同行字',40,1);f.ctx.fillText('独立完整行',20,50);
  const result=f.snapshot({allowVerticalBoundary:true,rect:{x:0,y:10,width:1000,height:80}});
  assert.equal(result.issue,'');assert.equal(result.text,'独立完整行');assert.equal(result.boundaryRows.top,true);f.stop();
});

test('boundary evidence survives partial erasure and clears only after its visible ink is fully erased',()=>{
  for(const operation of ['clearRect','fillRect']){
    const f=fixture();f.ctx.fillText('正文',20,40);f.ctx.fillText('残',20,999);
    f.ctx[operation](20,999,10,1);
    assert.equal(f.snapshot({allowVerticalBoundary:true}).boundaryRows.bottom,true);
    f.ctx[operation](20,989,10,11);f.ctx.fillText('补齐完整文字',20,700);
    const result=f.snapshot({allowVerticalBoundary:true});
    assert.equal(result.issue,'');assert.equal(result.boundaryRows.bottom,false);
    assert.equal(result.text,'正文\n补齐完整文字');assert.ok(!result.diagnostics.details.some(item=>item.kind==='text-boundary'));f.stop();
  }
});

test('unusual same-baseline metrics trim a contiguous prefix or suffix rather than leave an interior hole',()=>{
  for(const edge of ['top','bottom']){
    const f=fixture(),measure=f.ctx.measureText.bind(f.ctx);
    f.ctx.measureText=value=>({...measure(value),...(value==='同行字'?edge==='top'?
      {actualBoundingBoxAscent:-390,actualBoundingBoxDescent:410}:{actualBoundingBoxAscent:610,actualBoundingBoxDescent:-590}:{})});
    const y=edge==='top'?1:999;
    f.ctx.fillText('残',20,y);f.ctx.fillText('同行字',40,y);
    f.ctx.fillText('上方完整行',20,350);f.ctx.fillText('下方完整行',20,450);
    const result=f.snapshot({allowVerticalBoundary:true,rect:{x:0,y:300,width:1000,height:200}});
    assert.equal(result.issue,'');assert.equal(result.text,edge==='top'?'下方完整行':'上方完整行');
    assert.equal(result.boundaryRows[edge],true);f.stop();
  }
});

test('character and token drawing creates one line without repeating fill/stroke text',()=>{
  const f=fixture();
  let x=20;
  for(const text of ['工','作','经','历']){f.ctx.fillText(text,x,40);x+=10;}
  f.ctx.fillText('C++',20,80);f.ctx.fillText('OpenCV',60,80);
  f.ctx.strokeText('C++',20,80);f.ctx.fillText('C++',20,80);
  assert.equal(f.snapshot().text,'工作经历\nC++ OpenCV');
  const revision=f.snapshot().revision;
  f.ctx.fillText('C++',20,80);
  assert.ok(f.snapshot().revision>revision);
  assert.equal(f.snapshot().text,'工作经历\nC++ OpenCV');
  f.stop();
});

test('many adjacent glyph overhangs retain every original character without accumulating overlap errors',()=>{
  const f=fixture();
  f.ctx.measureText=value=>({width:value.length*10,actualBoundingBoxLeft:1,actualBoundingBoxRight:value.length*10+1,
    actualBoundingBoxAscent:10,actualBoundingBoxDescent:2});
  const expected=[];
  for(let row=0;row<10;row++){
    let line='';
    for(let c=0;c<14;c++){const char=String.fromCharCode(65+c);f.ctx.fillText(char,20+c*10,40+row*20);line+=char;}
    expected.push(line);
  }
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,expected.join('\n'));
  f.stop();
});

test('advance spacing preserves separately drawn spaces and does not use glyph overhang as a gap',()=>{
  const f=fixture();
  f.ctx.measureText=value=>({width:value.length*10,actualBoundingBoxLeft:value.trim()?3:0,
    actualBoundingBoxRight:value.trim()?value.length*10+3:0,actualBoundingBoxAscent:value.trim()?10:0,actualBoundingBoxDescent:value.trim()?2:0});
  f.ctx.fillText('A',20,40);f.ctx.fillText('  ',30,40);f.ctx.fillText('V',50,40);
  f.ctx.fillText('C',20,80);f.ctx.fillText('D',40,80);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'A  V\nC D');f.stop();
});

test('start, left, center, right and end alignment position text using logical advances',()=>{
  for(const alignment of ['start','left','center','right','end']){
    const f=fixture();f.ctx.textAlign=alignment;f.ctx.direction='inherit';
    const offset=['right','end'].includes(alignment)?10:alignment==='center'?5:0;
    f.ctx.fillText('A',20+offset,40);f.ctx.fillText('B',30+offset,40);
    f.ctx.fillText('C',50+offset,40);
    assert.equal(f.snapshot().issue,'',alignment);assert.equal(f.snapshot().text,'AB C',alignment);f.stop();
  }
});

test('adjacent glyphs share a baseline despite different ascenders and descenders',()=>{
  const f=fixture();
  f.ctx.measureText=value=>({width:value.length*10,actualBoundingBoxLeft:0,actualBoundingBoxRight:value.length*10,
    actualBoundingBoxAscent:value==='g'?4:10,actualBoundingBoxDescent:value==='g'?5:0});
  f.ctx.fillText('A',20,40);f.ctx.fillText('g',30,40);f.ctx.fillText('A',40,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'AgA');f.stop();
});

test('real ink and logical overlap or cross-baseline ink overlap still block background extraction',()=>{
  for(const draw of [
    ctx=>{ctx.fillText('A',20,40);ctx.fillText('B',25,40);},
    ctx=>{ctx.fillText('A',20,40);ctx.fillText('B',30,45);},
  ]){
    const f=fixture();
    f.ctx.measureText=value=>({width:value.length*10,actualBoundingBoxLeft:1,actualBoundingBoxRight:value.length*10+1,
      actualBoundingBoxAscent:10,actualBoundingBoxDescent:2});
    draw(f.ctx);assert.match(f.snapshot().issue,/重叠/);assert.equal(f.snapshot().text,'');f.stop();
  }
});

test('full clear and full opaque repaint remove old candidate text',()=>{
  const f=fixture();
  f.ctx.fillText('旧候选人',20,40);
  f.ctx.clearRect(0,0,1000,1000);
  assert.equal(f.snapshot().text,'');
  f.ctx.fillText('新候选人',20,40);
  assert.equal(f.snapshot().text,'新候选人');
  f.ctx.fillRect(0,0,1000,1000);
  f.ctx.fillText('第三位候选人',20,40);
  assert.equal(f.snapshot().text,'第三位候选人');
  f.stop();
});

test('local full glyph repaint replaces text; partial erasure refuses a truncated word',()=>{
  const f=fixture();
  f.ctx.fillText('旧职责',20,40);f.ctx.fillText('其他职责',20,80);
  f.ctx.clearRect(10,20,60,30);f.ctx.fillText('新职责',20,40);
  assert.equal(f.snapshot().text,'新职责\n其他职责');
  f.ctx.clearRect(30,30,10,10);
  assert.match(f.snapshot().issue,/局部覆盖/);
  f.ctx.clearRect(0,0,1000,60);f.ctx.fillText('恢复正文',20,40);
  assert.equal(f.snapshot().issue,'');
  assert.equal(f.snapshot().text,'恢复正文\n其他职责');
  f.stop();
});

test('same size width assignments and actual resizing reset the bitmap record',()=>{
  const f=fixture();f.ctx.fillText('旧内容',20,40);
  f.canvas.width=f.canvas.width;
  f.ctx.fillText('重新绘制',20,40);
  assert.equal(f.snapshot().text,'重新绘制');
  f.canvas.height=1200;f.ctx.fillText('尺寸改变',20,40);
  assert.equal(f.snapshot().text,'尺寸改变');
  assert.equal(f.snapshot().canvas.height,1200);
  f.stop();
});

test('replaced canvas has a new identity and cannot expose the previous candidate',()=>{
  const f=fixture();f.ctx.fillText('旧内容',20,40);const before=f.snapshot().canvasId;
  const other=new f.Canvas(),ctx=new f.Context(other);f.canvases.splice(0,1,other);
  assert.equal(f.snapshot().text,'');
  assert.match(f.snapshot().issue,/完整重绘/);
  ctx.clearRect(0,0,1000,1000);ctx.fillText('新内容',20,40);
  assert.notEqual(f.snapshot().canvasId,before);
  assert.equal(f.snapshot().text,'新内容');f.stop();
});

test('cropping emits only complete rows and keeps matching fold marks inside the viewport',()=>{
  const f=fixture();
  f.ctx.fillText('顶部姓名',20,40);f.ctx.fillText('查看全部',20,80);f.ctx.fillText('底部正文',20,120);
  f.window.__hrmExpandMarks={read:()=>[{id:1,label:'查看全部',x:.04,y:.076},{id:2,label:'其他',x:.04,y:.12}]};
  assert.equal(f.snapshot({rect:{x:0,y:50,width:1000,height:50}}).text,'查看全部');
  assert.equal(f.snapshot({rect:{x:0,y:50,width:1000,height:50}}).marks.length,1);
  assert.equal(f.snapshot({rect:{x:0,y:75,width:1000,height:50}}).text,'底部正文');
  assert.equal(f.snapshot({rect:{x:0,y:75,width:1000,height:50}}).marks.length,0);
  assert.match(f.snapshot({rect:{x:-1,y:0,width:1000,height:1000}}).issue,/范围无效/);
  f.stop();
});

test('mid-render injection never claims it captured the entire existing bitmap',()=>{
  const f=fixture({initialClear:false});f.ctx.fillText('只有后续重绘',20,40);
  assert.match(f.snapshot().issue,/完整重绘/);
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('完整重绘',20,40);
  assert.equal(f.snapshot().issue,'');f.stop();
});

test('inline expansion marks bind to the exact current glyph location, not matching words elsewhere',()=>{
  const f=fixture();
  f.ctx.fillText('工作经历',20,40);f.ctx.fillText('负责视觉检测...',20,80);
  for(const [index,char] of [...'查看全部'].entries())f.ctx.fillText(char,180+index*10,80);
  f.window.__hrmExpandMarks={read:()=>[
    {id:1,label:'查看全部',x:.2,y:.076},{id:2,label:'查看全部',x:.04,y:.076},
  ]};
  assert.deepEqual(Array.from(f.snapshot().marks,mark=>mark.id),[1]);
  // The center remains visible, but a partial control/row must not be used.
  assert.equal(f.snapshot({rect:{x:0,y:0,width:210,height:1000}}).marks.length,0);
  f.ctx.clearRect(180,68,40,16);
  assert.equal(f.snapshot().marks.length,0);f.stop();
});

test('new document-created canvas bitmaps are recorded from creation while existing canvases still need a reset',()=>{
  const f=fixture({initialClear:false});f.ctx.fillText('已有页面后绘文字',20,40);
  assert.equal(f.snapshot().issueCode,'baseline');
  for(const create of [()=>f.document.createElement('canvas'),
    ()=>f.document.createElementNS('http://www.w3.org/1999/xhtml','canvas')]){
    const canvas=create(),ctx=new f.Context(canvas);f.canvases.splice(0,1,canvas);
    ctx.fillText('创建后首帧原文',20,40);
    assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().diagnostics.baseline,true);
    assert.equal(f.snapshot().text,'创建后首帧原文');
  }
  assert.equal(f.document.createElementNS('http://www.w3.org/2000/svg','canvas') instanceof f.Canvas,false);
  assert.notEqual(f.document.createElement,f.originalCreation.createElement);
  f.stop();
  assert.equal(f.document.createElement,f.originalCreation.createElement);
  assert.equal(f.document.createElementNS,f.originalCreation.createElementNS);
});

test('many local rendering problems preserve their real causes and do not poison unrelated viewport text',()=>{
  const f=fixture();
  f.ctx.fillText('合成样例姓名甲，工作经历和机密样例正文乙',20,40);
  for(let i=0;i<80;i++)f.ctx.drawImage({width:3,height:3},300+(i%20)*8,200+Math.floor(i/20)*8);
  const problem=f.snapshot();
  assert.match(problem.issue,/图片/);assert.doesNotMatch(problem.issue,/过多/);
  assert.equal(problem.diagnostics.overflow,false);
  assert.equal(problem.diagnostics.reasonCounts.find(item=>item.reason.includes('图片')).count,80);
  assert.equal(problem.diagnostics.operations.drawImage,80);
  const readable=f.snapshot({rect:{x:0,y:0,width:800,height:100}});
  assert.equal(readable.issue,'');assert.match(readable.text,/样例正文乙/);
  const serialized=JSON.stringify(readable.diagnostics);
  assert.doesNotMatch(serialized,/合成样例姓名甲|样例正文乙|"text"\s*:|"resume"\s*:|https?:/);
  assert.deepEqual(Object.keys(readable.diagnostics).sort(),['baseline','details','entries','horizontal','ignoredImages','operations','overflow','reasonCounts']);
  assert.doesNotMatch(JSON.stringify(readable.diagnostics.horizontal),/canvasId|revision|readTop|readBottom/);
  for(const [key,value] of Object.entries(readable.diagnostics.horizontal)){
    if(key==='reason')assert.equal(value,'empty-margins');
    else if(key==='complete')assert.equal(value,true);
    else assert.ok(typeof value==='number'&&Number.isFinite(value));
  }
  for(const item of readable.diagnostics.reasonCounts){assert.equal(typeof item.reason,'string');assert.equal(typeof item.count,'number');}
  f.stop();
});

test('issue storage overflow stays conservative after all stored regions are erased until a full reset',()=>{
  const f=fixture();f.ctx.fillText('样例正文',20,40);
  for(let i=0;i<2048;i++)f.ctx.drawImage({width:1,height:1},300+(i%64)*2,100+Math.floor(i/64)*2);
  f.ctx.drawImage({width:1,height:1},700,700); // This region exceeds retained issue capacity.
  let result=f.snapshot({rect:{x:0,y:0,width:200,height:80}});
  assert.equal(result.diagnostics.overflow,true);assert.match(result.issue,/图片/);
  f.ctx.clearRect(280,90,160,100); // Remove all retained issues, but not the omitted 2049th issue.
  result=f.snapshot({rect:{x:0,y:0,width:200,height:80}});
  assert.equal(result.diagnostics.overflow,true);assert.notEqual(result.issue,'');assert.equal(result.text,'');
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('完整重绘后正文',20,40);
  assert.equal(f.snapshot().diagnostics.overflow,false);assert.equal(f.snapshot().issue,'');f.stop();
});

test('many known rectangle backgrounds are harmless and complete rectangle repaint clears old text',()=>{
  const f=fixture({initialClear:false});
  f.ctx.beginPath();f.ctx.rect(0,0,1000,1000);f.ctx.closePath();f.ctx.fill('nonzero');
  f.ctx.fillText('原始正文',20,40);
  for(let i=0;i<80;i++){
    f.ctx.beginPath();f.ctx.rect(300+(i%20)*8,200+Math.floor(i/20)*8,3,3);f.ctx.closePath();f.ctx.fill('evenodd');
  }
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'原始正文');
  assert.equal(f.snapshot().diagnostics.reasonCounts.length,0);
  f.ctx.beginPath();f.ctx.rect(0,20,200,40);f.ctx.fill();f.ctx.fillText('重新绘制正文',20,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'重新绘制正文');f.stop();
});

test('known rectangle clips support nesting and restore without including wholly clipped text',()=>{
  const f=fixture();
  f.ctx.beginPath();f.ctx.rect(0,0,300,200);f.ctx.closePath();f.ctx.clip('nonzero');
  f.ctx.fillText('外层正文',20,40);
  f.ctx.save();
  f.ctx.beginPath();f.ctx.rect(0,0,100,100);f.ctx.clip('evenodd');
  f.ctx.fillText('内层正文',20,80);f.ctx.fillText('完全在内层外',150,80);
  f.ctx.restore();f.ctx.fillText('恢复外层',150,120);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'外层正文\n内层正文\n恢复外层');f.stop();
});

test('partial glyph clipping and unknown Path2D clipping cannot pass as whole original text',()=>{
  const f=fixture();
  f.ctx.beginPath();f.ctx.rect(0,0,35,100);f.ctx.clip();f.ctx.fillText('被截断的文字',20,40);
  assert.match(f.snapshot().issue,/裁剪区域截断/);assert.equal(f.snapshot().text,'');f.stop();
  const unknown=fixture();unknown.ctx.clip({});unknown.ctx.fillText('未知区域文字',20,40);
  assert.match(unknown.snapshot().issue,/裁剪区域/);assert.equal(unknown.snapshot().text,'');unknown.stop();
});

test('a clear limited by a known clip neither grants a full baseline nor removes outside records',()=>{
  const f=fixture({initialClear:false});
  f.ctx.save();f.ctx.beginPath();f.ctx.rect(0,0,100,100);f.ctx.clip();
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('局部清屏',20,40);
  assert.equal(f.snapshot().issueCode,'baseline');f.ctx.restore();
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('外部保留',500,500);f.ctx.fillText('内部旧字',20,40);
  f.ctx.save();f.ctx.beginPath();f.ctx.rect(0,0,100,100);f.ctx.clip();
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('内部新字',20,40);f.ctx.restore();
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'内部新字\n外部保留');f.stop();
});

test('rejects opaque glyph encodings, unsupported transforms, compression and overlap',()=>{
  for(const action of [
    f=>f.ctx.fillText('\ue000\ue001',20,40),
    f=>{f.ctx.matrix.b=.5;f.ctx.fillText('旋转正文',20,40);},
    f=>f.ctx.fillText('压缩正文',20,40,5),
    f=>{f.ctx.fillText('原始正文',20,40);f.ctx.fillText('重叠正文',20,40);},
    f=>{f.ctx.globalCompositeOperation='destination-out';f.ctx.fillText('擦除正文',20,40);},
  ]) {
    const f=fixture();action(f);assert.notEqual(f.snapshot().issue,'');assert.equal(f.snapshot().text,'');f.stop();
  }
});

test('clip state survives save/restore and reset clears unsupported rendering',()=>{
  const f=fixture();
  f.ctx.save();f.ctx.clip();f.ctx.fillText('裁剪正文',20,40);f.ctx.restore();
  assert.match(f.snapshot().issue,/裁剪/);
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('清晰正文',20,40);
  assert.equal(f.snapshot().issue,'');
  f.ctx.clip();f.ctx.reset();f.ctx.fillText('重置正文',20,40);
  assert.equal(f.snapshot().text,'重置正文');f.stop();
});

test('does not silently omit images, including tiny per-character glyphs',()=>{
  const f=fixture();
  f.ctx.drawImage({width:80,height:80},850,20);
  f.ctx.fillText('工作经历',20,40);
  assert.match(f.snapshot().issue,/图片/);
  assert.equal(f.snapshot({rect:{x:0,y:0,width:800,height:80}}).text,'工作经历');
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('工作经历',20,40);
  f.ctx.drawImage({width:900,height:500},20,100);
  assert.match(f.snapshot().issue,/图片/);
  assert.equal(f.snapshot({rect:{x:0,y:0,width:1000,height:80}}).text,'工作经历');
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('工作经历',20,40);
  f.ctx.drawImage({width:50,height:50},20,20);
  assert.match(f.snapshot().issue,/图片/);
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('张**',20,40);f.ctx.fillText('工作经历',20,80);
  for(let x=20;x<200;x+=10)f.ctx.drawImage({width:10,height:12},x,120);
  f.ctx.fillText('平台末尾',20,200);
  assert.match(f.snapshot().issue,/图片/);assert.equal(f.snapshot().text,'');f.stop();
});

test('invisible text is omitted and resizing never creates a rendering context',()=>{
  const f=fixture();
  f.ctx.fillStyle='rgba(0, 0, 0, 0)';f.ctx.fillText('透明文字',20,40);
  f.ctx.fillStyle='#000000';f.ctx.fillText('可见正文',20,80);
  assert.equal(f.snapshot().text,'可见正文');
  f.canvas.getContext=()=>{throw Error('observer must not obtain a context');};
  f.canvas.width=1000;f.ctx.fillText('尺寸重置后',20,40);
  assert.equal(f.snapshot().text,'尺寸重置后');f.stop();
});

test('accepts thin separators and an opaque rectangle that does not hide text',()=>{
  const f=fixture();
  f.ctx.beginPath();f.ctx.moveTo(20,50);f.ctx.lineTo(900,50);f.ctx.stroke();
  f.ctx.fillText('工作经历',20,40);assert.equal(f.snapshot().issue,'');
  f.ctx.beginPath();f.ctx.rect(100,100,40,40);f.ctx.fill();
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'工作经历');
  f.ctx.beginPath();f.ctx.rect(0,20,100,30);f.ctx.fill();
  assert.equal(f.snapshot().text,'');f.ctx.fillText('替换正文',20,40);
  assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'替换正文');f.stop();
});

test('thick strokes covering text fail closed, including their padded region in a cropped snapshot',()=>{
  const f=fixture();
  f.ctx.fillText('应当被粗线覆盖的简历文字',20,40);
  f.ctx.lineWidth=100;f.ctx.beginPath();f.ctx.moveTo(0,40);f.ctx.lineTo(900,40);f.ctx.stroke();
  assert.match(f.snapshot().issue,/路径绘制/);assert.equal(f.snapshot().text,'');
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('也被相邻粗线覆盖',20,40);
  f.ctx.beginPath();f.ctx.moveTo(0,80);f.ctx.lineTo(900,80);f.ctx.stroke();
  assert.match(f.snapshot({rect:{x:0,y:25,width:900,height:25}}).issue,/路径绘制/);
  f.stop();
});

test('thin separators may not intersect text in either drawing order and are cleared with their bitmap',()=>{
  for(const lineFirst of [true,false]){
    const f=fixture();
    const line=()=>{f.ctx.beginPath();f.ctx.moveTo(0,40);f.ctx.lineTo(900,40);f.ctx.stroke();};
    if(lineFirst)line();
    f.ctx.fillText('正文',20,40);
    if(!lineFirst)line();
    assert.notEqual(f.snapshot().issue,'');assert.equal(f.snapshot().text,'');
    f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('重绘后正文',20,40);
    assert.equal(f.snapshot().issue,'');assert.equal(f.snapshot().text,'重绘后正文');f.stop();
  }
});

test('stroke thickness includes transforms and unsafe compositing, filters and shadows are rejected',()=>{
  for(const setting of [
    ctx=>{ctx.lineWidth=1;ctx.matrix.a=4;ctx.matrix.d=4;},
    ctx=>{ctx.globalCompositeOperation='destination-out';},
    ctx=>{ctx.filter='blur(20px)';},
    ctx=>{ctx.shadowColor='#000000';ctx.shadowBlur=50;},
  ]){
    const f=fixture();f.ctx.fillText('正文',20,40);setting(f.ctx);
    f.ctx.beginPath();f.ctx.moveTo(0,100);f.ctx.lineTo(100,100);f.ctx.stroke();
    assert.notEqual(f.snapshot().issue,'');f.stop();
  }
  const f=fixture();
  f.ctx.matrix.a=2;f.ctx.matrix.d=2;
  f.ctx.beginPath();f.ctx.moveTo(0,100);f.ctx.lineTo(100,100);f.ctx.stroke();
  f.ctx.fillText('安全细线之外',20,40);
  assert.equal(f.snapshot().issue,'');f.stop();
});

test('stroke end caps and previously drawn separators cannot hide overlap just beyond the endpoint',()=>{
  const f=fixture();
  f.ctx.lineWidth=2;
  f.ctx.beginPath();f.ctx.moveTo(0,40);f.ctx.lineTo(20,40);f.ctx.stroke();
  f.ctx.fillText('端点附近正文',20.5,40);
  assert.match(f.snapshot().issue,/分隔线重叠/);f.stop();
});

test('unobserved Path2D and joined paths cannot hide their bounds outside a cropped view',()=>{
  for(const draw of [
    ctx=>{ctx.beginPath();ctx.moveTo(600,600);ctx.lineTo(700,600);ctx.lineTo(650,601);ctx.stroke();},
    ctx=>ctx.stroke({}),
    ctx=>ctx.strokeRect(0,0,100,100),
  ]){
    const f=fixture();f.ctx.fillText('正文',20,40);draw(f.ctx);
    assert.notEqual(f.snapshot({rect:{x:0,y:0,width:200,height:100}}).issue,'');f.stop();
  }
});

test('does not hook unrelated hosts or pages and restores wrappers on stop',()=>{
  for(const options of [{hostname:'zhipin.com.evil.test'},{pathname:'/web/chat/search'},{armed:false}]){
    const f=fixture(options);assert.equal(f.window.__hrmCanvasText,undefined);assert.equal(f.Context.prototype.fillText,f.original);
  }
  const f=fixture();assert.notEqual(f.Context.prototype.fillText,f.original);f.stop();
  assert.equal(f.Context.prototype.fillText,f.original);assert.equal(f.window.__hrmCanvasText,undefined);
});

test('the expansion observer and text observer restore their shared wrappers in reverse order',()=>{
  const f=fixture();f.stop();
  const sandbox={window:f.window,CanvasRenderingContext2D:f.Context,HTMLCanvasElement:f.Canvas,
    document:{querySelectorAll:()=>f.canvases},getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'}),
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'}};
  vm.runInNewContext(fs.readFileSync(new URL('../extension/canvas-expand.js',import.meta.url),'utf8'),sandbox);
  vm.runInNewContext(source,sandbox);
  f.ctx.clearRect(0,0,1000,1000);f.ctx.fillText('查看全部',20,40);
  assert.equal(f.snapshot().text,'查看全部');assert.equal(f.snapshot().marks.length,1);
  f.window.__hrmCanvasText.stop();f.window.__hrmExpandMarks.stop();
  assert.equal(f.Context.prototype.fillText,f.original);
  assert.equal(f.window.__hrmCanvasText,undefined);assert.equal(f.window.__hrmExpandMarks,undefined);
});

test('native no-paint text coordinates and widths do not poison an otherwise readable canvas',()=>{
  const f=fixture();f.ctx.fillText('已有正文',20,40);
  const before=f.snapshot();
  for(const args of [
    ['无绘制',NaN,80],['无绘制',Infinity,80],['无绘制',20,NaN],
    ['无绘制',20,80,NaN],['无绘制',20,80,Infinity],
    ['无绘制',20,80,0],['无绘制',20,80,-1],
  ])f.ctx.fillText(...args);
  const measure=f.ctx.measureText.bind(f.ctx);
  f.ctx.measureText=value=>value==='\u200B'?{width:0,actualBoundingBoxLeft:0,actualBoundingBoxRight:0,
    actualBoundingBoxAscent:0,actualBoundingBoxDescent:0}:measure(value);
  f.ctx.fillText('\u200B',20,80);
  const result=f.snapshot();
  assert.equal(result.issue,'');assert.equal(result.text,'已有正文');
  assert.equal(result.diagnostics.entries,1);
  assert.equal(result.revision,before.revision,'zero-pixel calls cannot invalidate source revisions');
  assert.equal(result.diagnostics.reasonCounts.some(item=>item.reason.includes('坐标或变换')),false);
  f.stop();
});

test('visible unsupported text geometry remains blocked with content-free coordinate diagnostics',()=>{
  for(const [reason,alter] of [
    ['transform',ctx=>{ctx.matrix.b=.2;}],
    ['ink-metrics',ctx=>{const measure=ctx.measureText.bind(ctx);ctx.measureText=value=>({...measure(value),actualBoundingBoxLeft:NaN});}],
    ['ink-bounds',ctx=>{const measure=ctx.measureText.bind(ctx);ctx.measureText=value=>({...measure(value),
      actualBoundingBoxLeft:0,actualBoundingBoxRight:0,actualBoundingBoxAscent:0,actualBoundingBoxDescent:0});}],
  ]){
    const f=fixture();f.ctx.fillText('已有正文',20,40);alter(f.ctx);f.ctx.fillText('敏感履历原文',20,80);
    const result=f.snapshot(),detail=result.diagnostics.details.find(item=>item.kind==='text-coordinate');
    assert.match(result.issue,/坐标或变换无法确认/);
    assert.equal(detail.reason,reason);assert.equal(detail.textLength,6);
    assert.equal(detail.x,20);assert.equal(detail.y,80);
    assert.doesNotMatch(JSON.stringify(result.diagnostics),/敏感履历原文|已有正文/);
    f.stop();
  }
});
