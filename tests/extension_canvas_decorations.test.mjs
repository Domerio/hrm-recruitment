import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const geometry=fs.readFileSync(new URL('../extension/canvas-geometry.js',import.meta.url),'utf8');
const observer=fs.readFileSync(new URL('../extension/canvas-text.js',import.meta.url),'utf8');
const expectedName='王**';
const noticeText='近14天首次看到此牛人，赶紧联系TA吧';
const currentNoticeText='近14天你首次看到该牛人，赶紧联系TA吧';
const popularNoticeText='该牛人近期受同行BOSS欢迎';
const knownNoticeTexts=[noticeText,currentNoticeText,popularNoticeText];

// Independent synthetic page: run both actual scripts, with only native
// drawing/metrics stubbed. The fixture never uses a browser or real resume.
function fixture({inkMetrics,baseline=true}={}) {
  class Canvas {
    constructor(){this._width=2000;this._height=1000;this.isConnected=true;}
    get width(){return this._width;} set width(value){this._width=value;}
    get height(){return this._height;} set height(value){this._height=value;}
    getBoundingClientRect(){return {left:0,top:0,width:1000,height:500};}
    getContext(){return this.ctx||(this.ctx=new Context(this));}
  }
  class Context {
    constructor(canvas){
      this.canvas=canvas;canvas.ctx=this;this.globalAlpha=1;this.fillStyle='#000000';this.strokeStyle='#000000';
      this.globalCompositeOperation='source-over';this.direction='ltr';this.textAlign='start';this.textBaseline='alphabetic';
      this.filter='none';this.lineWidth=1;this.font='12px sans-serif';
      this.matrix={a:1,b:0,c:0,d:1,e:0,f:0};
    }
    fillText(){} strokeText(){} clearRect(){} fillRect(){} drawImage(){} putImageData(){}
    save(){} restore(){} clip(){} reset(){} beginPath(){} moveTo(){} lineTo(){} rect(){} closePath(){}
    arc(){} arcTo(){} ellipse(){} roundRect(){} fill(){} stroke(){} strokeRect(){}
    getTransform(){return this.matrix;}
    measureText(value){
      const metrics=inkMetrics?.(value,this)||{};
      const width=metrics.width??value.length*10,shift=['end','right'].includes(this.textAlign)?width:this.textAlign==='center'?width/2:0;
      return {width,actualBoundingBoxLeft:shift,actualBoundingBoxRight:width-shift,
        actualBoundingBoxAscent:metrics.ascent??10,actualBoundingBoxDescent:metrics.descent??2};
    }
  }
  const canvas=new Canvas(),ctx=new Context(canvas),window={__hrmCanvasTextEnabled:true};window.top=window;
  const document={querySelectorAll:()=>[canvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  const sandbox={window,CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,document,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'})};
  vm.createContext(sandbox);vm.runInContext(geometry,sandbox);vm.runInContext(observer,sandbox);
  if(baseline)ctx.clearRect(0,0,canvas.width,canvas.height);
  return {canvas,ctx,window,cache:()=>document.createElement('canvas'),snapshot:(options={})=>window.__hrmCanvasText.snapshot({textOnly:false,expectedName,...options}),
    stop:()=>window.__hrmCanvasText.stop()};
}
function header(ctx,{name=expectedName,meta='30岁 8年 本科',metaX=200,metaY=55}={}) {
  if(name)ctx.fillText(name,200,30);
  if(meta)ctx.fillText(meta,metaX,metaY);
}
function body(ctx) {
  ctx.fillText('工作经历',200,160);
  ctx.fillText('独立负责视觉算法研发，必须完整保留。',200,190);
}
function portrait(ctx,{x=120,y=10,size=48,crop=false,sourceRect}={}) {
  ctx.save();ctx.beginPath();ctx.arc(x+size/2,y+size/2,size/2,0,Math.PI*2);ctx.closePath();ctx.clip();
  const image={naturalWidth:100,naturalHeight:100};
  if(crop||sourceRect)ctx.drawImage(image,...(sourceRect||[10,10,80,80]),x,y,size,size);
  else ctx.drawImage(image,x,y,size,size);
  ctx.restore();
}
function bitmap(ctx,{x=162,y=8,width=9,height=9}={}) {
  ctx.drawImage({naturalWidth:width,naturalHeight:height},x,y,width,height);
}
function rounded(ctx,{x=200,y=70,width=500,height=32,radius=8}={}) {
  ctx.beginPath();ctx.moveTo(x+radius,y);
  ctx.arcTo(x+width,y,x+width,y+height,radius);
  ctx.arcTo(x+width,y+height,x,y+height,radius);
  ctx.arcTo(x,y+height,x,y,radius);
  ctx.arcTo(x,y,x+width,y,radius);ctx.closePath();
}
function notice(ctx,{panel=true,text=noticeText,icon=true,iconY=81,iconSize=10}={}) {
  if(panel){rounded(ctx);ctx.fill();}
  ctx.fillText(text,232,91);
  if(icon)bitmap(ctx,{x:215,y:iconY,width:iconSize,height:iconSize});
}
function observedLayout(ctx,{panelFill=true,panelClip=true,panelStyle='#eeeeee',nameFont='22px sans-serif'}={}) {
  // Destination rectangles/source dimensions come from the 0.5.36 diagnostic.
  // Name/metadata metrics and the exact crop are synthetic; no source pixels,
  // private page state or claim of real-browser validation is involved.
  ctx.font=nameFont;ctx.fillText(expectedName,132,50);
  ctx.font='14px sans-serif';ctx.fillText('30岁 8年 本科',132,80);
  ctx.save();ctx.beginPath();ctx.arc(78,58,28,0,Math.PI*2);ctx.closePath();ctx.clip();
  ctx.drawImage({naturalWidth:200,naturalHeight:200},1,1,198,198,50,30,56,56);ctx.restore();
  ctx.drawImage({naturalWidth:38,naturalHeight:38},88,30,18,18);
  ctx.save();rounded(ctx,{x:132,y:101,width:600,height:44});
  if(panelFill){ctx.fillStyle=panelStyle;ctx.fill();}
  if(panelClip)ctx.clip();
  ctx.fillStyle='#000000';ctx.fillText(noticeText+'。',174,130);
  ctx.drawImage({naturalWidth:44,naturalHeight:44},142,112,22,22);ctx.restore();
  ctx.fillText('工作经历',132,180);
  ctx.fillText('独立负责视觉算法研发，必须完整保留。',132,210);
}
function assertReadable(f,ignoredImages) {
  const result=f.snapshot();
  assert.equal(result.issue,'');assert.equal(result.diagnostics.ignoredImages,ignoredImages);
  assert.match(result.text,/王\*\*/);assert.match(result.text,/独立负责视觉算法研发，必须完整保留。/);
  return result;
}
function assertImageBlocked(f,options={}) {
  const result=f.snapshot(options);
  assert.equal(result.issueCode,'unsupported');assert.match(result.issue,/图片/);assert.equal(result.text,'');
  return result;
}

function cachedHeader(){
  const f=fixture(),source=f.cache(),paint=source.getContext();
  paint.clearRect(0,0,source.width,source.height);observedLayout(paint);
  f.window.__hrmBackgroundRead={token:'header-scroll',canvas:f.canvas,expectedName};
  const show=(x=0,y=0)=>{f.ctx.clearRect(0,0,f.canvas.width,f.canvas.height);f.ctx.drawImage(source,x,y);};
  return {f,source,paint,show};
}

test('verified header decorations survive vertical cache scrolling while clipped name text stays deferred',()=>{
  const {f,show}=cachedHeader();show();assertReadable(f,3);
  for(const offset of [42,52,90]){
    show(0,-offset);
    const result=f.snapshot({allowVerticalBoundary:true});
    assert.equal(result.issue,'');assert.equal(result.diagnostics.ignoredImages,offset===42?3:offset===52?2:1);
    const history=result.diagnostics.details.find(item=>item.kind==='header-history');
    assert.equal(history.historyVerified,true);assert.equal(history.imageCount,offset===42?3:offset===52?2:1);
    assert.doesNotMatch(result.text,/王\*\*/);assert.match(result.text,/独立负责视觉算法研发，必须完整保留。/);
    if(offset===42)assert.equal(result.boundaryRows.top,true);
  }
  show();assert.equal(f.snapshot().diagnostics.details.some(item=>item.kind==='header-history'),false);
  f.stop();
});

test('a partial first header cannot create a historical decoration proof',()=>{
  const {f,show}=cachedHeader();show(0,-42);assertImageBlocked(f,{allowVerticalBoundary:true});f.stop();
});

test('header continuation is bound to the exact active read and candidate',()=>{
  for(const change of ['missing','object','token','name','canvas']){
    const {f,show}=cachedHeader();show();assertReadable(f,3);
    if(change==='missing')delete f.window.__hrmBackgroundRead;
    if(change==='object')f.window.__hrmBackgroundRead={...f.window.__hrmBackgroundRead};
    if(change==='token')f.window.__hrmBackgroundRead.token='new-read';
    if(change==='name')f.window.__hrmBackgroundRead.expectedName='李**';
    if(change==='canvas')f.window.__hrmBackgroundRead.canvas=f.cache();
    show(0,-42);assertImageBlocked(f,{allowVerticalBoundary:true});f.stop();
  }
});

test('source changes and fresh image paints cannot reuse an earlier header role',()=>{
  for(const modify of [paint=>paint.clearRect(130,38,40,16),paint=>paint.fillText('新增正文',400,300),
    paint=>{paint.clearRect(0,0,2000,1000);observedLayout(paint);}]){
    const {f,paint,show}=cachedHeader();show();assertReadable(f,3);modify(paint);
    show(0,-42);assertImageBlocked(f,{allowVerticalBoundary:true});f.stop();
  }
});

test('erasing a visible header or its current metadata is not vertical scrolling',()=>{
  for(const partial of [false,true]){
    const {f,show}=cachedHeader();show();assertReadable(f,3);
    show(0,partial?-42:0);
    f.ctx.clearRect(130,partial?26:38,200,16);
    assertImageBlocked(f,{allowVerticalBoundary:true});f.stop();
  }
});

test('header history does not ignore horizontal crop or arbitrary cache gaps',()=>{
  for(const gap of [false,true]){
    const {f,source,show}=cachedHeader();show();assertReadable(f,3);
    f.ctx.clearRect(0,0,f.canvas.width,f.canvas.height);
    if(gap)f.ctx.drawImage(source,0,45,source.width,source.height-45,0,3,source.width,source.height-45);
    else f.ctx.drawImage(source,-60,-42);
    const result=f.snapshot({allowVerticalBoundary:true});
    assert.equal(result.issueCode,'unsupported');assert.equal(result.text,'');
    assert.equal(result.diagnostics.ignoredImages,0);f.stop();
  }
});

test('a failed or restricted initial view cannot authorize header history',()=>{
  for(const failed of [false,true]){
    const {f,show}=cachedHeader();show();
    if(failed){bitmap(f.ctx,{x:600,y:300,width:40,height:40});assertImageBlocked(f);}
    else assert.equal(f.snapshot({rect:{x:0,y:150,width:2000,height:850}}).issue,'');
    show(0,-42);assertImageBlocked(f,{allowVerticalBoundary:true});f.stop();
  }
});

test('new body images remain blocking after header history succeeds',()=>{
  const {f,show}=cachedHeader();show();assertReadable(f,3);show(0,-42);
  bitmap(f.ctx,{x:600,y:300,width:40,height:40});
  const result=assertImageBlocked(f,{allowVerticalBoundary:true});
  assert.equal(result.diagnostics.ignoredImages,3);f.stop();
});

test('a unique circular portrait next to the verified name and metadata preserves all body text',()=>{
  for(const imageFirst of [false,true]){
    const f=fixture();if(imageFirst)portrait(f.ctx);header(f.ctx);body(f.ctx);if(!imageFirst)portrait(f.ctx);
    assertReadable(f,1);f.stop();
  }
});

test('a recommendation full-name header ignores its portrait with either metadata order and no notice strip',()=>{
  for(const cached of [false,true])for(const meta of ['39岁 本科 10年以上 离职-随时到岗','39岁 10年以上 本科 离职-随时到岗']){
    const f=fixture(),source=cached?f.cache():f.canvas,ctx=source.getContext();
    header(ctx,{name:'唐明鑫 刚刚活跃',meta});body(ctx);portrait(ctx);bitmap(ctx);
    if(cached)f.ctx.drawImage(source,0,0);
    const result=f.snapshot({expectedName:'唐明鑫'});
    assert.equal(result.issue,'');assert.equal(result.diagnostics.ignoredImages,2);
    assert.equal(result.text,['唐明鑫 刚刚活跃',meta,'工作经历','独立负责视觉算法研发，必须完整保留。'].join('\n'));
    f.stop();
  }
});

test('current canvas identity is discovered only from a complete unique header and metadata in either order',()=>{
  for(const name of ['王**','唐明鑫'])for(const meta of ['39岁 本科 10年以上 离职-随时到岗','39岁 10年以上 本科 离职-随时到岗']){
    const f=fixture();f.ctx.font='22px sans-serif';f.ctx.fillText(name+' 刚刚活跃',200,30);
    f.ctx.font='14px sans-serif';f.ctx.fillText(meta,200,60);body(f.ctx);portrait(f.ctx);
    const result=f.window.__hrmCanvasText.identity();
    assert.equal(result.issue,'');assert.equal(result.text,'');assert.equal(result.identity.name,name);
    assert.equal(result.identity.headerKey,JSON.stringify([name,meta.replace(/\s/g,'')]));
    assert.doesNotMatch(JSON.stringify(result.diagnostics),new RegExp(name.replaceAll('*','\\*')));
    f.stop();
  }
});

test('a candidate-card name permits a unique plain Latin canvas header with complete metadata',()=>{
  for(const name of ['amy','johnsmith','abcdefghijklmnopqrstuvwxyzabcd']){
    const f=fixture();f.ctx.font='22px sans-serif';f.ctx.fillText(name+' 刚刚活跃',200,30);
    f.ctx.font='14px sans-serif';f.ctx.fillText('39岁 本科 10年以上 离职-随时到岗',200,60);
    body(f.ctx);
    const bound=f.snapshot({expectedName:name,textOnly:true});
    assert.equal(bound.issue,'');assert.match(bound.text,new RegExp('^'+name+' 刚刚活跃'));
    assert.match(bound.text,/39岁 本科 10年以上/);
    const unbound=f.window.__hrmCanvasText.identity();
    assert.equal(unbound.issueCode,'identity');assert.equal(unbound.identity,undefined);
    f.stop();
  }
});

test('a copied recommendation canvas retains its bound Latin header and metadata',()=>{
  const f=fixture(),source=f.cache(),ctx=source.getContext();
  ctx.clearRect(0,0,source.width,source.height);
  ctx.font='22px sans-serif';ctx.fillText('johnsmith 刚刚活跃',200,30);
  ctx.font='14px sans-serif';ctx.fillText('39岁 本科 10年以上 离职-随时到岗',200,60);
  body(ctx);f.ctx.drawImage(source,0,0);
  const result=f.snapshot({expectedName:'johnsmith',textOnly:true});
  assert.equal(result.issue,'');assert.match(result.text,/^johnsmith 刚刚活跃/);
  assert.match(result.text,/39岁 本科 10年以上/);f.stop();
});

test('bound Latin headers require exact spelling, one complete metadata row and a unique title',()=>{
  for(const change of ['case','suffix','fullwidth','word','short','long','duplicate','metadata','misplaced','smallTitle','clipped']){
    const f=fixture(),name='johnsmith';f.ctx.font=change==='smallTitle'?'14px sans-serif':'22px sans-serif';
    const line={case:'JohnSmith',suffix:'johnsmithers',fullwidth:'ｊｏｈｎｓｍｉｔｈ',word:'engineer'}[change]||name;
    f.ctx.fillText(line+' 刚刚活跃',200,change==='misplaced'?260:30);
    f.ctx.font='14px sans-serif';
    f.ctx.fillText(change==='metadata'?'39岁 本科':'39岁 本科 10年以上',200,change==='misplaced'?290:60);
    if(change==='duplicate')f.ctx.fillText(name,500,110);
    const expectedName=change==='short'?'jo':change==='long'?'j'.repeat(31):name;
    const result=f.snapshot({expectedName,textOnly:true,
      ...(change==='clipped'?{rect:{x:210,y:0,width:1790,height:1000}}:{})});
    assert.ok(result.issue,change);assert.equal(result.text,'');f.stop();
  }
});

test('current identity rejects late injection, body prose, duplicate names, cropped or incomplete metadata',()=>{
  for(const options of [
    {baseline:false},{name:'工作经历'},{name:'负责研发',sameFont:true},{name:'唐明鑫 庄宇宁'},
    {duplicate:true},{meta:'39岁 本科'}, {meta:'39岁 本科 10年 负责软件开发'},
    {meta:'39岁 本科 硕士 10年'}, {headerY:260}, {rect:{x:210,y:0,width:1790,height:1000}},
  ]){
    const f=fixture({baseline:options.baseline!==false});
    f.ctx.font=options.sameFont?'14px sans-serif':'22px sans-serif';f.ctx.fillText(options.name||'唐明鑫',200,options.headerY||30);
    f.ctx.font='14px sans-serif';f.ctx.fillText(options.meta||'39岁 本科 10年以上',200,(options.headerY||30)+30);
    if(options.duplicate)f.ctx.fillText('唐明鑫',500,110);
    const result=f.window.__hrmCanvasText.identity({rect:options.rect});
    assert.ok(result.issue,JSON.stringify(options));assert.equal(result.identity,undefined);
    if(options.baseline===false)assert.equal(result.issueCode,'baseline');f.stop();
  }
});

test('identity discovery does not approve unknown body images or depend on activity wording',()=>{
  const f=fixture();f.ctx.font='22px sans-serif';f.ctx.fillText('唐明鑫 刚刚活跃',200,30);
  f.ctx.font='14px sans-serif';f.ctx.fillText('39岁 本科 10年以上',200,60);body(f.ctx);
  bitmap(f.ctx,{x:400,y:300,width:200,height:100});
  const first=f.window.__hrmCanvasText.identity();assert.equal(first.issue,'');
  assertImageBlocked(f,{expectedName:'唐明鑫'});
  f.ctx.clearRect(180,10,400,30);f.ctx.font='22px sans-serif';f.ctx.fillText('唐明鑫 今日活跃',200,30);
  const second=f.window.__hrmCanvasText.identity();assert.equal(second.issue,'');
  assert.equal(first.identity.headerKey,second.identity.headerKey);f.stop();
});

test('full-name portrait recognition rejects a longer name, prose suffix, duplicate or missing metadata',()=>{
  for(const name of ['唐明鑫伟','唐明鑫负责研发','庄宇宁']){
    const f=fixture();header(f.ctx,{name,meta:'39岁 本科 10年以上'});body(f.ctx);portrait(f.ctx);
    assertImageBlocked(f,{expectedName:'唐明鑫'});f.stop();
  }
  for(const duplicate of [false,true]){
    const f=fixture();header(f.ctx,{name:'唐明鑫',meta:duplicate?'39岁 本科 10年以上':''});
    if(duplicate)f.ctx.fillText('唐明鑫',500,85);
    body(f.ctx);portrait(f.ctx);assertImageBlocked(f,{expectedName:'唐明鑫'});f.stop();
  }
});

test('one small gender badge at the portrait upper-right edge requires the portrait anchor',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx);bitmap(f.ctx);
  assertReadable(f,2);f.stop();
  const missing=fixture();header(missing.ctx);body(missing.ctx);bitmap(missing.ctx);
  assertImageBlocked(missing);missing.stop();
});

test('portrait approval requires the expected name and rejects absent or mismatched identity',()=>{
  for(const options of [{expectedName:undefined},{expectedName:''},{expectedName:'李**'}]){
    const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx);assertImageBlocked(f,options);f.stop();
  }
  for(const name of ['', '李**', '王***']){
    const f=fixture();header(f.ctx,{name});body(f.ctx);portrait(f.ctx);assertImageBlocked(f);f.stop();
  }
});

test('duplicate matching name rows cannot establish a unique portrait identity',()=>{
  const f=fixture();header(f.ctx);f.ctx.fillText(expectedName,500,85);body(f.ctx);portrait(f.ctx);
  assertImageBlocked(f);f.stop();
});

test('age and education or experience must form nearby aligned header metadata',()=>{
  for(const options of [{meta:''},{meta:'30岁'},{meta:'本科'},{metaY:120},{metaX:700}]){
    const f=fixture();header(f.ctx,options);body(f.ctx);portrait(f.ctx);assertImageBlocked(f);f.stop();
  }
});

test('a circular image in the body or far from the name remains unsupported',()=>{
  for(const options of [{x:120,y:240},{x:20,y:10}]){
    const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx,options);assertImageBlocked(f);f.stop();
  }
});

test('ordinary images cannot acquire the portrait exception without a circular clip',()=>{
  const plain=fixture();header(plain.ctx);body(plain.ctx);
  bitmap(plain.ctx,{x:120,y:10,width:48,height:48});assertImageBlocked(plain);plain.stop();
});

test('a valid source crop is allowed for the verified circular portrait role',()=>{
  const crop=fixture();header(crop.ctx);body(crop.ctx);portrait(crop.ctx,{crop:true});
  assertReadable(crop,1);crop.stop();
});

test('cropped body images remain unsupported with or without a circular clip',()=>{
  for(const circular of [false,true]){
    const f=fixture();header(f.ctx);body(f.ctx);
    if(circular)portrait(f.ctx,{crop:true,y:240});
    else f.ctx.drawImage({naturalWidth:100,naturalHeight:100},10,10,80,80,120,240,48,48);
    assertImageBlocked(f);f.stop();
  }
});

test('invalid or out-of-source crops cannot acquire the portrait exception',()=>{
  for(const sourceRect of [[-1,0,100,100],[0,-1,100,100],[1,0,100,100],[0,1,100,100],[0,0,0,100]]){
    const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx,{sourceRect});assertImageBlocked(f);f.stop();
  }
});

test('a portrait that overlaps recorded text cannot hide that text',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx);f.ctx.fillText('正文',130,48);
  assertImageBlocked(f);f.stop();
});

test('multiple possible portraits do not select or discard either image',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx);portrait(f.ctx,{x:65});
  assertImageBlocked(f);f.stop();
});

test('a small image inside the portrait center is not a gender badge',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx);
  bitmap(f.ctx,{x:140,y:30,width:8,height:8});assertImageBlocked(f);f.stop();
});

test('multiple small images in the avatar cluster cannot all be ignored as one gender badge',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx);bitmap(f.ctx);
  bitmap(f.ctx,{x:152,y:8,width:8,height:8});assertImageBlocked(f);f.stop();
});

test('a badge outside the portrait cluster remains an unknown image',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx);
  bitmap(f.ctx,{x:180,y:8});assertImageBlocked(f);f.stop();
});

test('the exact platform notice and rounded panel allow its separate left-hand icon',()=>{
  for(const text of knownNoticeTexts){
    const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx,{text});
    const result=assertReadable(f,1);assert.ok(result.text.includes(text));f.stop();
  }
});

test('reported 20-character notice in a 593x38 panel accepts its 22px icon with a 6px gap',()=>{
  const f=fixture(),ctx=f.ctx;
  // Reproduce the reported geometry with synthetic text metrics and images.
  ctx.font='22px sans-serif';ctx.fillText(expectedName,132,50);
  ctx.font='14px sans-serif';ctx.fillText('30岁 8年 本科',132,80);
  portrait(ctx,{x:50,y:30,size:56,crop:true});bitmap(ctx,{x:88,y:30,width:18,height:18});
  body(ctx);
  ctx.save();rounded(ctx,{x:132,y:104,width:593,height:38});ctx.fill();ctx.clip();
  for(const [index,char] of [...currentNoticeText].entries())ctx.fillText(char,170+index*10,127.5);
  ctx.drawImage({naturalWidth:44,naturalHeight:44},142,112,22,22);ctx.restore();
  const result=assertReadable(f,3),check=result.diagnostics.details.find(item=>item.kind==='notice-check');
  assert.ok(result.text.includes(currentNoticeText));assert.equal(result.diagnostics.operations.drawImage,3);
  assert.equal(check.reason,'accepted');assert.equal(check.panelEntryCount,20);assert.equal(check.panelTextLength,20);
  assert.equal(check.panelW,593);assert.equal(check.panelH,38);assert.equal(check.signedGapX,6);
  assert.equal(check.centerDeltaY,.5);assert.equal(check.imageW,22);assert.equal(check.imageH,22);
  assert.equal(check.panelFromFill,true);assert.equal(check.panelFromClip,true);
  assert.equal(check.globalRowExact,true);assert.equal(check.panelTextExact,true);
  assert.equal(check.touchCount,0);assert.equal(check.unsafeIssueCount,0);f.stop();
});

test('the current notice must be complete and cannot match extra or substituted body text',()=>{
  const invalid=[...currentNoticeText].map((_,index)=>currentNoticeText.slice(0,index)+currentNoticeText.slice(index+1))
    .filter(text=>text!==currentNoticeText.replace('，',''));
  invalid.push('补充'+currentNoticeText,currentNoticeText+'负责平台研发',currentNoticeText.replace('该','本'));
  for(const text of invalid){
    const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx,{text});
    const check=assertImageBlocked(f).diagnostics.details.find(item=>item.kind==='notice-check');
    assert.equal(check.reason,'text-mismatch',text);assert.equal(check.panelTextExact,false);f.stop();
  }
});

test('the popularity notice can be drawn character by character without losing a same-row outside column',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx);bitmap(f.ctx);
  f.ctx.save();rounded(f.ctx);f.ctx.fill();f.ctx.clip();
  for(const [index,char] of [...popularNoticeText].entries())f.ctx.fillText(char,232+index*10,91);
  bitmap(f.ctx,{x:215,y:81,width:10,height:10});f.ctx.restore();
  f.ctx.fillText('邻列原文也必须保留',1000,91);
  const result=assertReadable(f,3),check=result.diagnostics.details.find(item=>item.kind==='notice-check');
  assert.ok(result.text.includes(popularNoticeText));assert.ok(result.text.includes('邻列原文也必须保留'));
  assert.equal(check.reason,'accepted');assert.equal(check.panelTextExact,true);assert.equal(check.globalRowExact,false);
  assert.equal(check.panelEntryCount,popularNoticeText.length);assert.equal(check.sameRowOutsideEntries,1);f.stop();
});

test('the popularity notice rejects missing characters and unrelated or additional prose',()=>{
  const invalid=[...popularNoticeText].map((_,index)=>popularNoticeText.slice(0,index)+popularNoticeText.slice(index+1));
  invalid.push('补充'+popularNoticeText,popularNoticeText+'，负责平台研发',popularNoticeText.replace('同行','同事'));
  for(const text of invalid){
    const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx,{text});
    const check=assertImageBlocked(f).diagnostics.details.find(item=>item.kind==='notice-check');
    assert.equal(check.reason,'text-mismatch',text);assert.equal(check.panelTextExact,false);f.stop();
  }
});

test('portrait, gender badge and platform notice can coexist without dropping body text',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);portrait(f.ctx);bitmap(f.ctx);notice(f.ctx);
  assertReadable(f,3);f.stop();
});

test('observed image dimensions allow the cropped portrait, 18px badge and 22px notice icon with small name ink',()=>{
  for(const panelStyle of ['#eeeeee','rgba(0, 0, 0, 0.05)']){
    const f=fixture({inkMetrics:value=>value===expectedName?{ascent:2,descent:1}:undefined});
    observedLayout(f.ctx,{panelStyle});
    const result=assertReadable(f,3);
    assert.equal(result.text,[expectedName,'30岁 8年 本科',noticeText+'。','工作经历','独立负责视觉算法研发，必须完整保留。'].join('\n'));
    assert.equal(result.diagnostics.operations.drawImage,3);
    assert.equal(result.diagnostics.reasonCounts.length,0);f.stop();
  }
});

test('a translucent rounded background supplies notice geometry without a rounded clip',()=>{
  const f=fixture({inkMetrics:value=>value===expectedName?{ascent:2,descent:1}:undefined});
  observedLayout(f.ctx,{panelStyle:'rgba(0, 0, 0, 0.05)',panelClip:false});
  assertReadable(f,3);f.stop();
});

test('a same-baseline column outside the notice panel cannot contaminate its exact UI match',()=>{
  const f=fixture();observedLayout(f.ctx);f.ctx.fillText('邻列原文也必须保留',1000,130);
  const result=assertReadable(f,3),check=result.diagnostics.details.find(item=>item.kind==='notice-check');
  assert.ok(result.text.includes('邻列原文也必须保留'));
  assert.equal(check.reason,'accepted');assert.equal(check.globalRowExact,false);assert.equal(check.panelTextExact,true);
  assert.equal(check.sameRowOutsideEntries,1);assert.equal(check.panelCount,1);f.stop();
});

test('a notice missing one character reports text-mismatch without supplying the missing character',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx,{text:noticeText.replace('首','')});
  const result=assertImageBlocked(f),check=result.diagnostics.details.find(item=>item.kind==='notice-check');
  assert.equal(check.reason,'text-mismatch');assert.equal(check.panelTextExact,false);
  assert.equal(check.panelTextLength,noticeText.length-1);assert.equal(check.unsafeIssueCount,0);
  assert.equal(result.diagnostics.ignoredImages,0);f.stop();
});

test('a notice with rejected overlapping text reports text-unsafe and retains the original drawing issue',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx);f.ctx.fillText('冲突',233,91);
  const result=f.snapshot(),check=result.diagnostics.details.find(item=>item.kind==='notice-check');
  assert.equal(result.issueCode,'unsupported');assert.match(result.issue,/文字重叠/);assert.equal(result.text,'');
  assert.equal(check.reason,'text-unsafe');assert.equal(check.overlapIssuesInPanel,1);assert.equal(check.panelTextExact,true);
  assert.equal(result.diagnostics.reasonCounts.find(item=>item.reason.includes('文字重叠')).count,1);
  assert.equal(result.diagnostics.ignoredImages,0);f.stop();
});

test('additional text inside the notice panel cannot be discarded by substring matching',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx);f.ctx.fillText('额外正文',550,91);
  const result=assertImageBlocked(f),check=result.diagnostics.details.find(item=>item.kind==='notice-check');
  assert.equal(check.reason,'text-mismatch');assert.equal(check.panelTextExact,false);
  assert.equal(check.sameRowOutsideEntries,0);assert.equal(result.diagnostics.entries,6);f.stop();
});

test('an outside image is still rejected when another icon and a same-baseline column match the notice',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx);f.ctx.fillText('邻列正文',1000,91);
  bitmap(f.ctx,{x:800,y:81,width:10,height:10});
  const result=assertImageBlocked(f),checks=result.diagnostics.details.filter(item=>item.kind==='notice-check');
  assert.equal(result.diagnostics.ignoredImages,1);
  assert.ok(checks.some(check=>check.reason==='accepted'));
  assert.ok(checks.some(check=>check.reason==='image-outside'&&check.panelTextExact));f.stop();
});

test('notice diagnostics refresh after a corrected redraw instead of retaining an earlier mismatch',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx,{text:noticeText.replace('首','')});
  assert.equal(assertImageBlocked(f).diagnostics.details.find(item=>item.kind==='notice-check').reason,'text-mismatch');
  f.ctx.clearRect(200,70,500,32);notice(f.ctx);
  const result=assertReadable(f,1),checks=result.diagnostics.details.filter(item=>item.kind==='notice-check');
  assert.equal(checks.length,1);assert.equal(checks[0].reason,'accepted');f.stop();
});

test('the same rounded notice clip supplies geometry when no background was painted',()=>{
  const f=fixture({inkMetrics:value=>value===expectedName?{ascent:2,descent:1}:undefined});
  observedLayout(f.ctx,{panelFill:false});assertReadable(f,3);f.stop();
});

test('observed notice dimensions still require a panel or matching rounded clip',()=>{
  const f=fixture({inkMetrics:value=>value===expectedName?{ascent:2,descent:1}:undefined});
  observedLayout(f.ctx,{panelFill:false,panelClip:false});assertImageBlocked(f);f.stop();
});

test('a translucent panel painted over existing text cannot erase the text records or become a successful read',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);f.ctx.fillText('旧正文必须保留',232,91);
  const before=f.snapshot().diagnostics.entries;
  f.ctx.fillStyle='rgba(0, 0, 0, 0.05)';rounded(f.ctx);f.ctx.fill();
  const result=f.snapshot();assert.equal(result.issueCode,'unsupported');assert.match(result.issue,/背景覆盖/);
  assert.equal(result.diagnostics.entries,before);assert.equal(result.text,'');f.stop();
});

test('a pattern-filled notice panel remains unsupported even when its icon has a known rounded clip',()=>{
  const f=fixture({inkMetrics:value=>value===expectedName?{ascent:2,descent:1}:undefined});
  observedLayout(f.ctx,{panelStyle:{}});
  const result=f.snapshot();assert.equal(result.issueCode,'unsupported');assert.match(result.issue,/图案填充/);
  assert.equal(result.text,'');f.stop();
});

test('the same platform sentence without its rounded panel does not excuse an image',()=>{
  for(const text of knownNoticeTexts){
    const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx,{text,panel:false});assertImageBlocked(f);f.stop();
  }
});

test('a rounded background clipped to a narrow strip cannot establish a whole notice panel',()=>{
  for(const fillStyle of ['rgba(100,150,200,.2)','#ffffff']){
    const f=fixture();header(f.ctx);body(f.ctx);
    f.ctx.save();f.ctx.beginPath();f.ctx.rect(200,70,5,32);f.ctx.clip();
    f.ctx.fillStyle=fillStyle;rounded(f.ctx);f.ctx.fill();f.ctx.restore();f.ctx.fillStyle='#000000';
    notice(f.ctx,{panel:false});assertImageBlocked(f);f.stop();
  }
});

test('a rounded image clip intersected with a narrow strip cannot establish a whole notice panel',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx,{panel:false,icon:false});
  f.ctx.save();f.ctx.beginPath();f.ctx.rect(200,70,30,32);f.ctx.clip();rounded(f.ctx);f.ctx.clip();
  bitmap(f.ctx,{x:215,y:81,width:10,height:10});f.ctx.restore();
  const result=assertImageBlocked(f),check=result.diagnostics.details.find(item=>item.kind==='notice-check');
  assert.equal(check.panelTextExact,false);assert.equal(result.diagnostics.ignoredImages,0);f.stop();
});

test('a similar sentence or an ordinary body image cannot use the notice exception',()=>{
  const similar=fixture();header(similar.ctx);body(similar.ctx);notice(similar.ctx,{text:'近14天首次看到此牛人，负责平台研发'});
  assertImageBlocked(similar);similar.stop();
  for(const text of knownNoticeTexts){
    const bodyImage=fixture();header(bodyImage.ctx);body(bodyImage.ctx);notice(bodyImage.ctx,{text,icon:false});
    bitmap(bodyImage.ctx,{x:180,y:175,width:8,height:8});assertImageBlocked(bodyImage);bodyImage.stop();
  }
});

test('the notice icon cannot overlap any original text',()=>{
  for(const text of knownNoticeTexts){
    const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx,{text,icon:false});
    bitmap(f.ctx,{x:233,y:82,width:8,height:8});assertImageBlocked(f);f.stop();
  }
});

test('a notice decoration must align vertically with the notice text',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx,{iconY:72,iconSize:6});
  assertImageBlocked(f);f.stop();
});

test('multiple small images before the notice cannot be silently classified as one icon',()=>{
  const f=fixture();header(f.ctx);body(f.ctx);notice(f.ctx,{icon:false});
  bitmap(f.ctx,{x:215,y:84,width:7,height:7});bitmap(f.ctx,{x:224,y:84,width:6,height:7});
  assertImageBlocked(f);f.stop();
});

test('a pattern fill before any text remains unsupported rather than disappearing from the transcript',()=>{
  for(const mode of ['fillRect','rect','roundRect']){
    const f=fixture();f.ctx.fillStyle={};
    if(mode==='fillRect')f.ctx.fillRect(200,230,300,80);
    else if(mode==='rect'){f.ctx.beginPath();f.ctx.rect(200,230,300,80);f.ctx.fill();}
    else {rounded(f.ctx,{x:200,y:230,width:300,height:80});f.ctx.fill();}
    f.ctx.fillStyle='#000000';header(f.ctx);body(f.ctx);
    const result=f.snapshot();assert.equal(result.issueCode,'unsupported');assert.match(result.issue,/图案填充/);
    assert.equal(result.text,'');f.stop();
  }
});
