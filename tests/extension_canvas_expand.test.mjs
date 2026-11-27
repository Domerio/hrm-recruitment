import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function drawingFixture({dpr=2,matrix={a:1,b:0,c:0,d:1,e:0,f:0}}={}){
  const canvas={width:500*dpr,height:500*dpr,getBoundingClientRect:()=>({width:500,height:500})};
  class Context {
    constructor(){this.canvas=canvas;this.globalAlpha=1;}
    fillText(){}
    strokeText(){}
    clearRect(){}
    fillRect(){}
    getTransform(){return matrix;}
    measureText(value){return {width:value.length*10,actualBoundingBoxLeft:0,
      actualBoundingBoxRight:value.length*10,actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};}
  }
  const window={};
  const context={window,CanvasRenderingContext2D:Context,document:{querySelectorAll:()=>[canvas]},
    getComputedStyle:()=>({visibility:'visible',opacity:'1'}),
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'}};
  vm.runInNewContext(fs.readFileSync(new URL('../extension/canvas-expand.js',import.meta.url),'utf8'),context);
  return {ctx:new Context(),marks:()=>window.__hrmExpandMarks.read(),stop:()=>window.__hrmExpandMarks.stop()};
}

test('canvas records a full dynamic honor fold label and its actual drawn width',()=>{
  for(const label of ['展开全部16个所获荣誉','展开全部 16 个所获荣誉','查看全部３项荣誉']){
    const f=drawingFixture();
    f.ctx.fillText(label,100,100);
    const marks=f.marks();
    assert.equal(marks.length,1);
    assert.equal(marks[0].label,label.normalize('NFKC').replace(/\s/g,''));
    assert.equal(marks[0].x,(100+label.length*5)/1000);
    f.stop();
  }
});

test('canvas joins adjacent character or token draws without retaining the shorter base mark',()=>{
  for(const parts of [['展','开','全','部','1','6','个','所','获','荣','誉'],['展开全部','16','个所获荣誉']]){
    const f=drawingFixture();
    let x=100;
    for(const part of parts){f.ctx.fillText(part,x,100);x+=part.length*10;}
    const marks=f.marks();
    assert.equal(marks.length,1);
    assert.equal(marks[0].label,'展开全部16个所获荣誉');
    f.ctx.clearRect(0,0,1000,1000);
    assert.equal(f.marks().length,0);
    f.stop();
  }
});

test('canvas does not turn arbitrary resume prose or incomplete counts into click marks',()=>{
  const f=drawingFixture();
  for(const label of ['展开测试方案','展开全部16项内部测试任务','查看全部未来发展规划','展开全部000个荣誉']){
    f.ctx.fillText(label,100,100);
  }
  assert.equal(f.marks().length,0);
  f.ctx.fillText('展开全部',100,200);
  f.ctx.fillText('16',140,200);
  assert.equal(f.marks().length,0);
  f.stop();
});

test('an inline view-all button after an ellipsis is recorded from individual character draws',()=>{
  const f=drawingFixture();
  f.ctx.fillText('负责视觉检测及测量项目开发...',100,100);
  for(const [index,char] of [...'查看全部'].entries())f.ctx.fillText(char,400+index*10,100);
  f.ctx.fillText('工作经历',100,160);
  const marks=f.marks();assert.equal(marks.length,1);assert.equal(marks[0].label,'查看全部');
  assert.equal(marks[0].x,.42);assert.equal(marks[0].y,.096);f.stop();
});

test('a partial opaque repaint invalidates a previously complete expand button',()=>{
  const f=drawingFixture();f.ctx.fillText('查看全部',100,100);f.ctx.fillStyle='#ffffff';
  f.ctx.fillRect(100,90,10,12);
  assert.equal(f.marks().length,0);f.stop();
});

test('new text over a button invalidates its mark while an exact redraw keeps its identity',()=>{
  const f=drawingFixture();f.ctx.fillText('查看全部',100,100);
  const initial=f.marks()[0];f.ctx.fillText('查看全部',100,100);
  assert.equal(f.marks().length,1);assert.equal(f.marks()[0].id,initial.id);
  f.ctx.fillText('新的正文',100,100);assert.equal(f.marks().length,0);f.stop();
});

test('a compressed text draw interrupts the fragment chain instead of being silently skipped',()=>{
  const f=drawingFixture();f.ctx.fillText('查看全',100,100);
  f.ctx.fillText('未知',130,100,1);f.ctx.fillText('部',130,100);
  assert.equal(f.marks().length,0);f.stop();
});


test('fragment baseline and glyph gap tolerances stay in CSS pixels across browser zoom and DPR',()=>{
  for(const dpr of [.5,.8,1,1.25,1.5,2,3]){
    const f=drawingFixture({dpr,matrix:{a:dpr,b:0,c:0,d:dpr,e:0,f:0}});
    [...'查看全部'].forEach((char,index)=>f.ctx.fillText(char,100+index*12,100+(index%2)*2));
    const marks=f.marks();
    assert.equal(marks.length,1,'dpr '+dpr);
    assert.equal(marks[0].label,'查看全部');
    assert.ok(Math.abs(marks[0].x-123/500)<1e-9,'normalized x at dpr '+dpr);
    assert.ok(Math.abs(marks[0].y-97/500)<1e-9,'normalized y at dpr '+dpr);
    f.stop();
  }
});

test('zooming out cannot join text separated by more than eight visual pixels',()=>{
  for(const dpr of [.5,.8,1,1.25,2,3]){
    const f=drawingFixture({dpr,matrix:{a:dpr,b:0,c:0,d:dpr,e:0,f:0}});
    f.ctx.fillText('查看全',100,100);
    f.ctx.fillText('部',139,100);
    assert.equal(f.marks().length,0,'dpr '+dpr);
    f.stop();
  }
});

function pixelFixture({dpr=1}={}){
  let width=500*dpr,height=500*dpr,bitmap=new Uint32Array(width*height);
  const canvas={getBoundingClientRect:()=>({width:500,height:500})};
  Object.defineProperties(canvas,{
    width:{get:()=>width,set:value=>{width=value;bitmap=new Uint32Array(width*height);}},
    height:{get:()=>height,set:value=>{height=value;bitmap=new Uint32Array(width*height);}},
  });
  const reads=[];
  const paint=(left,top,right,bottom,color)=>{
    for(let y=Math.max(0,Math.floor(top));y<Math.min(height,Math.ceil(bottom));y++)
      for(let x=Math.max(0,Math.floor(left));x<Math.min(width,Math.ceil(right));x++)bitmap[y*width+x]=color;
  };
  const draw=(ctx,left,top,right,bottom,color)=>{
    const m=ctx.transform;
    paint(m.a*left+m.e,m.d*top+m.f,m.a*right+m.e,m.d*bottom+m.f,color);
  };
  const textPaint=(ctx,value,x,y)=>{
    if(!ctx.globalAlpha||!ctx.paintAllowed)return;
    const origin=x-(ctx.textAlign==='center'?value.length*5:ctx.textAlign==='right'||ctx.textAlign==='end'?value.length*10:0)+(ctx.paintOffset||0);
    [...value].forEach((char,index)=>draw(ctx,origin+index*10,y-10,origin+index*10+8,y+2,ctx.color));
  };
  class Context{
    constructor(){this.canvas=canvas;this.globalAlpha=1;this.fillStyle='#00a6a7';
      this.transform={a:dpr,b:0,c:0,d:dpr,e:0,f:0};this.color=0x00a6a7ff;this.paintAllowed=true;}
    fillText(value,x,y){textPaint(this,value,x,y);}
    strokeText(value,x,y){textPaint(this,value,x,y);}
    clearRect(x,y,w,h){if(this.paintAllowed)draw(this,x,y,x+w,y+h,0);}
    fillRect(x,y,w,h){if(this.globalAlpha)draw(this,x,y,x+w,y+h,0xffffffff);}
    drawImage(image,x,y,w=image.width,h=image.height){draw(this,x,y,x+w,y+h,0xffffffff);}
    putImageData(image,x,y){paint(x,y,x+image.width,y+image.height,0x778899ff);}
    reset(){bitmap.fill(0);}
    getTransform(){return this.transform;}
    measureText(value){return {width:value.length*10,actualBoundingBoxLeft:0,
      actualBoundingBoxRight:value.length*10,actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};}
    getImageData(x,y,w,h){
      reads.push({x,y,width:w,height:h});
      if(this.unreadable)throw Error('SecurityError');
      const data=new Uint8ClampedArray(w*h*4);
      for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
        const color=bitmap[(y+yy)*width+x+xx],index=(yy*w+xx)*4;
        data[index]=(color>>>24)&255;data[index+1]=(color>>>16)&255;
        data[index+2]=(color>>>8)&255;data[index+3]=color&255;
      }
      return {data};
    }
  }
  const window={},context={window,CanvasRenderingContext2D:Context,
    document:{querySelectorAll:()=>[canvas]},getComputedStyle:()=>({visibility:'visible',opacity:'1'}),
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'}};
  const inject=()=>vm.runInNewContext(fs.readFileSync(new URL('../extension/canvas-expand.js',import.meta.url),'utf8'),context);
  inject();
  return {ctx:new Context(),canvas,reads,window,inject,
    overwrite:(x,y,color=0xff0000ff)=>paint(x,y,x+1,y+1,color),
    marks:()=>window.__hrmExpandMarks.read(),verified:()=>window.__hrmExpandMarks.readVerified(),
    anchors:()=>window.__hrmExpandMarks.readSelectionAnchors(),
    stop:()=>window.__hrmExpandMarks.stop()};
}

test('verified marks use post-paint pixels for complete dynamic labels and keep stable redraw IDs',()=>{
  const f=pixelFixture();
  assert.equal(f.window.__hrmExpandMarks.version,7);
  for(const label of ['查看全部','展开全部16个所获荣誉','查看全部３项荣誉']){
    f.ctx.clearRect(0,0,500,500);f.ctx.fillText(label,100,100);
    const mark=f.verified()[0];
    assert.ok(mark);
    assert.equal(mark.label,label.normalize('NFKC'));
    assert.deepEqual(f.verified(),f.marks());
    f.ctx.color=0x2266aaff;
    f.ctx.fillText(label,100,100);
    assert.equal(f.verified()[0].id,mark.id);
  }
  f.stop();
});

test('verified full labels assembled from character paints survive CSS zoom and DPR',()=>{
  for(const dpr of [.5,.8,1,1.25,1.5,2,3,4]){
    const f=pixelFixture({dpr});
    [...'展开全部16个所获荣誉'].forEach((char,index)=>f.ctx.fillText(char,100+index*12,100));
    const marks=f.verified();
    assert.equal(marks.length,1,'dpr '+dpr);
    assert.equal(marks[0].label,'展开全部16个所获荣誉');
    assert.ok(Math.abs(marks[0].x-165/500)<1e-9);
    assert.ok(Math.abs(marks[0].y-96/500)<1e-9);
    f.stop();
  }
});

test('bitmap rewrites invalidate verified marks even when legacy hooks cannot observe them',()=>{
  for(const [kind,repaint,legacyCount] of [
    ['drawImage',f=>f.ctx.drawImage({width:10,height:10},105,92),1],
    ['putImageData',f=>f.ctx.putImageData({width:2,height:2},105,92),1],
    ['unwrapped pixel write',f=>f.overwrite(102,92),1],
    ['unrecognized fill style',f=>{f.ctx.fillStyle='rgba(255,255,255,0.8)';f.ctx.fillRect(105,92,5,5);},1],
    ['clearRect',f=>f.ctx.clearRect(105,92,5,5),0],
    ['opaque fillRect',f=>{f.ctx.fillStyle='#ffffff';f.ctx.fillRect(105,92,5,5);},0],
    ['reset',f=>f.ctx.reset(),0],
  ]){
    const f=pixelFixture();f.ctx.fillText('查看全部',100,100);
    assert.equal(f.verified().length,1,kind);
    repaint(f);
    assert.equal(f.verified().length,0,kind);
    assert.equal(f.marks().length,legacyCount,kind);
    f.stop();
  }
});

test('only the complete control and its small padding are sampled, unrelated pixels do not invalidate it',()=>{
  const f=pixelFixture();f.ctx.fillText('展开全部16个所获荣誉',100,100);
  assert.equal(f.verified().length,1);
  assert.ok(f.reads.every(rect=>rect.x===99&&rect.y===89&&rect.width===112&&rect.height===14));
  f.ctx.drawImage({width:100,height:100},300,300);
  assert.equal(f.verified().length,1);
  const edge=f.reads.at(-1);
  f.overwrite(edge.x,edge.y);
  assert.equal(f.verified().length,0,'the padding is part of the exact painted evidence');
  assert.equal(f.marks().length,1,'legacy evidence remains available to its clipboard-label workflow');
  f.stop();
});

test('a canvas resize or same-size bitmap reset cannot reuse previous pixel evidence',()=>{
  for(const resize of [
    f=>{f.canvas.width=501;},
    f=>{f.canvas.height=501;},
    f=>{f.canvas.width=f.canvas.width;},
    f=>{f.canvas.width=501;f.canvas.width=500;},
  ]){
    const f=pixelFixture();f.ctx.fillText('查看全部',100,100);
    assert.equal(f.verified().length,1);
    resize(f);
    assert.equal(f.verified().length,0);
    f.stop();
  }
});

test('unreadable or tainted canvas pixels never acquire or revive a verified mark',()=>{
  const f=pixelFixture();
  f.ctx.unreadable=true;f.ctx.fillText('查看全部',100,100);
  assert.equal(f.marks().length,1);assert.equal(f.verified().length,0);
  f.ctx.unreadable=false;
  assert.equal(f.verified().length,0,'a later read cannot invent post-paint evidence');
  f.ctx.fillText('查看全部',100,100);
  assert.equal(f.verified().length,0,'an unchanged replay cannot invent visible-paint evidence');
  f.ctx.clearRect(90,80,80,40);f.ctx.fillText('查看全部',100,100);
  assert.equal(f.verified().length,1);
  f.ctx.unreadable=true;
  assert.equal(f.verified().length,0);
  f.ctx.unreadable=false;
  assert.equal(f.verified().length,0,'failed current verification expires the evidence');
  f.stop();
});

test('out-of-bounds, blank or oversized control paints cannot produce verified coordinates',()=>{
  for(const configure of [
    f=>({x:0,y:10}),
    f=>{f.ctx.paintAllowed=false;return {x:100,y:100};},
    f=>{f.ctx.measureText=()=>({width:400,actualBoundingBoxLeft:0,
      actualBoundingBoxRight:400,actualBoundingBoxAscent:400,actualBoundingBoxDescent:0});
      return {x:50,y:450};},
  ]){
    const f=pixelFixture(),point=configure(f);
    f.ctx.fillText('查看全部',point.x,point.y);
    assert.equal(f.marks().length,1);
    assert.equal(f.verified().length,0);
    assert.ok(f.reads.every(rect=>rect.width*rect.height<=131072));
    f.stop();
  }
});

test('late injection cannot infer labels from existing canvas pixels',()=>{
  const f=pixelFixture();f.stop();
  f.ctx.fillText('查看全部',100,100);
  f.inject();
  assert.equal(f.marks().length,0);
  assert.equal(f.verified().length,0);
  f.ctx.fillText('查看全部',100,100);
  assert.equal(f.window.__hrmExpandMarks.readVerified(f.canvas).length,0,'a no-op late replay remains unproven');
  f.ctx.clearRect(90,80,80,40);f.ctx.fillText('查看全部',100,100);
  assert.equal(f.window.__hrmExpandMarks.readVerified(f.canvas).length,1);
  f.stop();
});

test('a removed button stays unverified until the label itself is painted again',()=>{
  const f=pixelFixture();f.ctx.fillText('查看全部',100,100);
  assert.equal(f.verified().length,1);
  f.ctx.drawImage({width:50,height:20},98,88);
  assert.equal(f.verified().length,0);
  f.ctx.fillText('新的正文',100,100);
  assert.equal(f.verified().length,0);
  f.ctx.color=0x2266aaff;f.ctx.fillText('查看全部',100,100);
  assert.equal(f.verified().length,0,'known image regions are also excluded from expand clicks');
  f.ctx.reset();f.ctx.fillText('查看全部',100,100);
  assert.equal(f.verified().length,1);
  f.stop();
});

test('selection seeds stay inside the first glyph at every zoom and do not expose text or pixels',()=>{
  for(const dpr of [.5,.8,1,1.25,1.5,2,3,4]){
    const f=pixelFixture({dpr});
    f.ctx.drawImage({width:70,height:70},10,10);
    f.ctx.fillText('示例姓名',110,50);f.ctx.fillText('工作经历',20,140);
    const anchors=f.anchors();
    assert.equal(anchors.length,2,'dpr '+dpr);
    assert.ok(Math.abs(anchors[0].x-111/500)<1e-9);
    assert.ok(Math.abs(anchors[0].y-46/500)<1e-9);
    assert.ok(anchors[0].x>=anchors[0].left&&anchors[0].x<anchors[0].right);
    assert.deepEqual(Object.keys(anchors[0]).sort(),['bottom','id','left','right','safeLeft','startX','top','x','y']);
    assert.ok(f.reads.every(rect=>rect.width*rect.height<=16384));
    const id=anchors[0].id;f.ctx.fillText('示例姓名',110,50);
    assert.equal(f.anchors()[0].id,id,'stable current-pixel replay keeps identity');
    f.stop();
  }
});

test('individual glyph paints aggregate one line seed without retaining copied resume prose',()=>{
  const f=pixelFixture();
  for(const [i,char] of [...'示例姓名'].entries())f.ctx.fillText(char,110+i*10,50);
  for(const [i,char] of [...'工作经历'].entries())f.ctx.fillText(char,20+i*10,140);
  f.ctx.fillText('查看全部',20,200);
  const anchors=f.anchors();
  assert.equal(anchors.length,2);
  assert.equal(anchors[0].left,110/500);
  assert.equal(anchors[1].left,20/500);
  assert.equal(anchors[0].right,120/500,'the exported bbox remains the small first glyph');
  assert.ok(f.reads.every(rect=>rect.width<=42&&rect.height<=14));
  f.stop();
});

test('images covering a text seed invalidate it even if a bitmap redraw happens to keep its pixels',()=>{
  for(const draw of [
    f=>f.ctx.drawImage({width:15,height:15},100,88),
    f=>f.ctx.drawImage({width:15,height:15},0,0,15,15,100,88,15,15),
    f=>f.ctx.putImageData({width:15,height:15},100,88),
  ]){
    const f=pixelFixture();f.ctx.fillText('示例姓名',100,100);
    assert.equal(f.anchors().length,1);draw(f);
    assert.equal(f.anchors().length,0);
    f.ctx.color=0xff0000ff;f.ctx.fillText('示例姓名',100,100);
    assert.equal(f.anchors().length,0,'text overlapping the known image is not an avatar-safe start');
    f.ctx.clearRect(0,0,500,500);f.ctx.fillText('示例姓名',100,100);
    assert.equal(f.anchors().length,0,'clear geometry cannot prove an image was erased through a clip');
    f.ctx.reset();f.ctx.fillText('示例姓名',100,100);
    assert.equal(f.anchors().length,1);
    f.stop();
  }
});

test('text over an earlier avatar, clipped painting, and arbitrary image pixels do not supply anchors',()=>{
  const avatar=pixelFixture();
  avatar.ctx.drawImage({width:80,height:80},80,70);
  avatar.ctx.fillText('头像文字',100,100);
  assert.equal(avatar.anchors().length,0);
  avatar.ctx.fillText('实际姓名',200,100);
  assert.equal(avatar.anchors().length,1);avatar.stop();
  const clipped=pixelFixture();clipped.overwrite(100,90);
  clipped.ctx.paintAllowed=false;clipped.ctx.fillText('示例姓名',100,100);
  assert.equal(clipped.anchors().length,0);
  clipped.stop();
});

test('clipped fold paints on varied photo pixels cannot become verified expansion clicks',()=>{
  const f=pixelFixture();f.overwrite(105,92);f.ctx.paintAllowed=false;
  f.ctx.fillText('查看全部',100,100);
  assert.equal(f.marks().length,1,'legacy label observation stays available');
  assert.equal(f.verified().length,0,'unchanged background is not a visible text paint');
  f.ctx.paintAllowed=true;f.ctx.fillText('查看全部',100,100);
  assert.equal(f.verified().length,1);
  f.ctx.paintAllowed=false;f.ctx.fillText('查看全部',100,100);
  assert.equal(f.verified().length,1,'a previously proven identical label can remain current');
  f.stop();
});

test('every fragment of a verified fold label needs its own visible paint witness',()=>{
  const f=pixelFixture();f.overwrite(105,92);f.ctx.paintAllowed=false;
  f.ctx.fillText('查',100,100);f.ctx.paintAllowed=true;
  for(const [i,char] of [...'看全部'].entries())f.ctx.fillText(char,110+i*10,100);
  assert.equal(f.marks().length,1);assert.equal(f.verified().length,0);
  f.stop();
});

test('selection witnesses expire on unhooked pixel changes, resize, unreadable pixels and moved text',()=>{
  for(const mutate of [
    f=>f.overwrite(102,92),
    f=>{f.canvas.width=f.canvas.width;},
    f=>{f.ctx.unreadable=true;},
    f=>{f.ctx.clearRect(90,80,100,40);f.ctx.fillText('示例姓名',200,100);},
  ]){
    const f=pixelFixture();f.ctx.fillText('示例姓名',100,100);
    const first=f.anchors()[0];assert.ok(first);mutate(f);
    assert.ok(f.anchors().every(anchor=>anchor.id!==first.id));f.stop();
  }
});

test('selection ledger keeps current lower lines and the header with bounded small-glyph evidence',()=>{
  const f=pixelFixture();f.canvas.height=4000;
  for(let i=0;i<180;i++)f.ctx.fillText('示例正文行',20,20+i*20);
  const anchors=f.anchors();assert.equal(anchors.length,128);
  assert.equal(anchors[0].top,10/4000);
  assert.ok(anchors.some(anchor=>anchor.top===3590/4000));
  assert.ok(f.reads.every(rect=>rect.width<=12&&rect.height<=14));
  f.stop();
});

test('clipped clearing cannot free an avatar area for a later genuine text paint',()=>{
  const f=pixelFixture();
  f.ctx.drawImage({width:80,height:80},80,70);
  f.ctx.paintAllowed=false;f.ctx.clearRect(0,0,500,500);
  f.ctx.paintAllowed=true;f.ctx.fillText('头像徽标',100,100);
  assert.equal(f.anchors().length,0);
  f.ctx.fillText('正文姓名',200,100);
  assert.equal(f.anchors().length,1);
  f.stop();
});

test('unsupported image transforms conservatively exclude the whole bitmap from click seeds',()=>{
  const f=pixelFixture();
  f.ctx.transform={a:1,b:.2,c:0,d:1,e:0,f:0};
  f.ctx.drawImage({width:80,height:80},80,70);
  f.ctx.transform={a:1,b:0,c:0,d:1,e:0,f:0};
  f.ctx.fillText('示例姓名',200,100);f.ctx.fillText('查看全部',200,200);
  assert.equal(f.anchors().length,0);
  assert.equal(f.verified().length,0);
  assert.equal(f.marks().length,1);
  f.ctx.reset();f.ctx.fillText('示例姓名',200,100);f.ctx.fillText('查看全部',200,200);
  assert.equal(f.anchors().length,1);assert.equal(f.verified().length,1);
  f.stop();
});

test('a genuinely painted fold overlay on a known avatar remains unavailable for automatic clicks',()=>{
  const f=pixelFixture();
  f.ctx.drawImage({width:80,height:80},80,70);
  f.ctx.fillText('查看全部',100,100);
  assert.equal(f.marks().length,1);assert.equal(f.verified().length,0);
  f.ctx.fillText('展开全部',200,100);
  assert.equal(f.verified().length,1);
  f.stop();
});

test('overhanging successive glyphs keep the first character instead of drifting to the last',()=>{
  for(const dpr of [1,1.25,2,3]){
    const f=pixelFixture({dpr});
    f.ctx.measureText=value=>({width:value.length*10,actualBoundingBoxLeft:0,
      actualBoundingBoxRight:value.length*10+3,actualBoundingBoxAscent:10,actualBoundingBoxDescent:2});
    let originalId;
    for(const [i,char] of [...'杜先生'].entries()){
      f.ctx.fillText(char,100+i*10,100);
      const anchors=f.anchors();assert.equal(anchors.length,1);
      originalId??=anchors[0].id;
      assert.equal(anchors[0].id,originalId);
      assert.equal(anchors[0].left,100/500);
      assert.ok(Math.abs(anchors[0].startX-99/500)<1e-9);
    }
    f.stop();
  }
});

test('line-start uses text alignment and actual caret advance instead of the visible ink midpoint',()=>{
  for(const [align,bboxLeft,expected] of [['left',-4,99],['center',11,84],['right',26,69]]){
    const f=pixelFixture();f.ctx.textAlign=align;f.ctx.paintOffset=4;
    f.ctx.measureText=value=>({width:value.length*10,actualBoundingBoxLeft:value.length===3?bboxLeft:0,
      actualBoundingBoxRight:value.length===3?30-bboxLeft:10,actualBoundingBoxAscent:10,actualBoundingBoxDescent:2});
    // Place real fixture pixels in both caret and ink regions; metrics still
    // determine the production proof and selected caret independently.
    f.ctx.fillText('杜先生',100,100);
    const anchor=f.anchors()[0];assert.ok(anchor,align);
    assert.ok(Math.abs(anchor.startX-expected/500)<1e-9,align);
    assert.equal(anchor.startX,anchor.safeLeft);
    assert.ok(anchor.startX<=anchor.left);f.stop();
  }
});

test('a left-side gutter never crosses a recorded avatar boundary',()=>{
  const f=pixelFixture();
  f.ctx.drawImage({width:100,height:80},0,60);
  f.ctx.fillText('杜先生',100,100);
  const anchor=f.anchors()[0];assert.ok(anchor);
  assert.equal(anchor.startX,100/500,'caret at the image edge remains usable without an outside gutter');
  f.ctx.drawImage({width:101,height:80},0,60);
  assert.equal(f.anchors().length,0);f.stop();
});

test('repeated identical or contained avatar draws do not turn all unrelated text into an image region',()=>{
  const f=pixelFixture();
  for(let i=0;i<300;i++)f.ctx.drawImage({width:80,height:80},10,10);
  for(let i=0;i<300;i++)f.ctx.drawImage({width:20,height:20},20,20);
  f.ctx.fillText('杜先生',120,100);
  assert.equal(f.anchors().length,1);
  f.ctx.fillText('查看全部',120,200);
  assert.equal(f.verified().length,1);f.stop();
});
