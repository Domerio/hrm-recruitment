import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scripts=['canvas-expand.js','canvas-geometry.js','canvas-text.js'].map(name=>
  fs.readFileSync(new URL('../extension/'+name,import.meta.url),'utf8'));

// Only original text drawing records establish the school-icon role. The
// synthetic fixture has no school bitmap pixels, URLs, DOM labels or OCR.
function fixture({fontSensitiveMetrics=false}={}){
  class Canvas {
    constructor(){this._width=773;this._height=1100;this.isConnected=false;this.ctx=null;}
    get width(){return this._width;} set width(value){this._width=value;}
    get height(){return this._height;} set height(value){this._height=value;}
    getContext(){return this.ctx||(this.ctx=new Context(this));}
    getBoundingClientRect(){return {left:0,top:0,width:this.width,height:this.height,right:this.width,bottom:this.height};}
  }
  class Context {
    constructor(canvas){
      this.canvas=canvas;this.globalAlpha=1;this.fillStyle='#000000';this.strokeStyle='#000000';
      this.globalCompositeOperation='source-over';this.direction='ltr';this.textAlign='start';this.textBaseline='alphabetic';
      this.filter='none';this.lineWidth=1;this.font='14px sans-serif';this.shadowColor='transparent';
      this.matrix={a:1,b:0,c:0,d:1,e:0,f:0};this.stack=[];
    }
    fillText(){} strokeText(){} clearRect(){} fillRect(){} drawImage(){} putImageData(){}
    clip(){} reset(){} beginPath(){} moveTo(){} lineTo(){} rect(){} closePath(){}
    arc(){} arcTo(){} ellipse(){} roundRect(){} fill(){} stroke(){} strokeRect(){}
    save(){this.stack.push({matrix:{...this.matrix},fillStyle:this.fillStyle,font:this.font});}
    restore(){const saved=this.stack.pop();if(saved)Object.assign(this,saved);}
    getTransform(){return this.matrix;}
    getImageData(){throw Error('Education logo recognition must not inspect bitmap pixels');}
    measureText(value){
      const size=fontSensitiveMetrics?Number.parseFloat(this.font):14;
      const width=Array.from(value).reduce((sum,char)=>sum+(/[^\x00-\x7f]/.test(char)?size:size/2),0);
      const shift=['end','right'].includes(this.textAlign)?width:this.textAlign==='center'?width/2:0;
      // A 12px date's hyphen has only one row of ink, above its baseline.
      // Its ink center differs from digits even when all glyphs share a line.
      const smallDate=fontSensitiveMetrics&&size===12;
      const ascent=smallDate?(value==='-'?4:9):10;
      const descent=smallDate?(value==='-'?-3:0):2;
      return {width,actualBoundingBoxLeft:shift,actualBoundingBoxRight:width-shift,
        actualBoundingBoxAscent:ascent,actualBoundingBoxDescent:descent};
    }
  }
  const canvas=new Canvas();canvas.isConnected=true;let visibleCanvas=canvas;
  const ctx=canvas.getContext(),window={__hrmCanvasTextEnabled:true};window.top=window;
  const document={querySelectorAll:()=>[visibleCanvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  const sandbox={window,document,HTMLCanvasElement:Canvas,CanvasRenderingContext2D:Context,
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'}),
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'}};
  vm.createContext(sandbox);for(const script of scripts)vm.runInContext(script,sandbox);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  return {canvas,ctx,window,cache:()=>document.createElement('canvas'),
    showCanvas:value=>{visibleCanvas.isConnected=false;visibleCanvas=value;visibleCanvas.isConnected=true;},
    snapshot:options=>window.__hrmCanvasText.snapshot({textOnly:false,expectedName:'王**',...options}),
    stop:()=>{window.__hrmCanvasText.stop();window.__hrmExpandMarks.stop();}};
}

function text(ctx,value,x,y,perCharacter=false){
  if(!perCharacter){ctx.fillText(value,x,y);return;}
  for(const char of value){ctx.fillText(char,x,y);x+=ctx.measureText(char).width;}
}
function logo(ctx,{x=134,y=724,width=56,height=56,crop=false,sourceSize=336,clips=0,sourceImage}={}){
  ctx.save();
  for(let index=0;index<clips;index++){ctx.beginPath();ctx.rect(0,0,773,1100);ctx.clip();}
  const image=sourceImage||{naturalWidth:sourceSize,naturalHeight:sourceSize};
  if(crop)ctx.drawImage(image,1,1,sourceSize-2,sourceSize-2,x,y,width,height);
  else ctx.drawImage(image,x,y,width,height);
  ctx.restore();
}
function education(ctx,{heading=true,headingY=736,y=724,school='合肥工业大学',major='机械工程',degree='硕士',
  date='2015 - 2018',perCharacter=false,icon=true,iconOptions={},titleX=202,titleY=y+12,badge='211院校'}={}){
  if(heading)text(ctx,'教育经历',44,headingY,perCharacter);
  const title=[school,major,degree].filter(Boolean).join(' | ');
  if(title)text(ctx,title,titleX,titleY,perCharacter);
  if(date)text(ctx,date,648,titleY,perCharacter);
  if(badge)text(ctx,badge,202,y+46,perCharacter);
  text(ctx,'在校经历:',134,y+84,perCharacter);
  text(ctx,'获得奖学金并完成独立研究项目。',134,y+110,perCharacter);
  if(icon)logo(ctx,{y,...iconOptions});
}
function readable(f,count){
  const result=f.snapshot();assert.equal(result.issue,'');
  assert.equal(result.diagnostics.ignoredImages,count);
  assert.match(result.text,/获得奖学金并完成独立研究项目。/);
  return result;
}
function blocked(f){
  const result=f.snapshot();assert.equal(result.issueCode,'unsupported');
  assert.match(result.issue,/图片/);assert.equal(result.text,'');return result;
}

test('two 56-pixel education crests with 336-pixel sources are decorative without a visible resume header',()=>{
  const f=fixture();
  education(f.ctx,{iconOptions:{clips:2}});
  education(f.ctx,{heading:false,y:898,major:'工业工程',degree:'本科',date:'2011 - 2015',iconOptions:{clips:2}});
  const result=readable(f,2);
  assert.match(result.text,/教育经历/);assert.match(result.text,/机械工程/);assert.match(result.text,/工业工程/);
  assert.match(result.text,/2015 - 2018/);assert.match(result.text,/2011 - 2015/);f.stop();
});

test('school matching accepts distinct school names and individual character draws',()=>{
  const f=fixture();education(f.ctx,{headingY:700,school:'上海交通大学',perCharacter:true});
  education(f.ctx,{heading:false,y:898,school:'南京工程学院',degree:'本科',date:'2011 - 2015',perCharacter:true});
  const result=readable(f,2);assert.match(result.text,/上海交通大学/);assert.match(result.text,/南京工程学院/);f.stop();
});

test('a school title ending in an explicit study form preserves both education crests and the original text',()=>{
  for(const perCharacter of [false,true])for(const cached of [false,true]){
    const f=fixture(),source=cached?f.cache():f.canvas,ctx=source.getContext();
    education(ctx,{headingY:634,y:620,titleY:634,school:'华东师范大学',major:'电子信息',degree:'硕士 · 非全日制',
      date:'2022 - 2025',badge:'QS世界大学排名TOP500',icon:false,perCharacter});
    ctx.save();crestMask(ctx,'roundRect',{y:620});logo(ctx,{y:620});ctx.restore();
    education(ctx,{heading:false,y:818,school:'盐城工学院',major:'电气工程及其自动化',degree:'本科',
      date:'2013 - 2015',badge:'卓越工程师计划',perCharacter});
    if(cached)f.ctx.drawImage(source,0,-500);
    const result=readable(f,2),checks=result.diagnostics.details.filter(item=>item.kind==='education-check');
    assert.ok(checks.every(item=>item.reason==='accepted-text'&&item.titleVerified&&item.dateVerified));
    assert.equal(checks[0].roundRectClips,1);assert.equal(checks[0].decorationPaint,true);
    assert.match(result.text,/华东师范大学 \| 电子信息 \| 硕士 · 非全日制/);
    assert.match(result.text,/盐城工学院/);assert.match(result.text,/2022 - 2025/);f.stop();
  }
});

test('exact full-time and part-time suffixes work after a complete degree without changing the source',()=>{
  for(const degree of ['本科 · 全日制','硕士·非全日制','博士 · 全日制']){
    const f=fixture();education(f.ctx,{degree,perCharacter:true});
    assert.ok(readable(f,1).text.includes(degree));f.stop();
  }
});

test('study-form text alone or an arbitrary trailing description cannot establish an education title',()=>{
  for(const degree of ['非全日制','· 非全日制','硕士 · 非全日制课程','硕士 · 学习形式待确认','硕士 · 全日制 · 非全日制']){
    const f=fixture();education(f.ctx,{degree,perCharacter:true});
    const detail=blocked(f).diagnostics.details.find(item=>item.kind==='education-check');
    assert.equal(detail.titleVerified,false);assert.equal(detail.dateVerified,true);f.stop();
  }
});

test('a recognized study form cannot replace missing education text or the school-icon layout',()=>{
  for(const options of [{heading:false},{major:''},{date:''},
    {iconOptions:{width:100}},{titleY:790}]){
    const f=fixture();education(f.ctx,{degree:'硕士 · 非全日制',...options});blocked(f);f.stop();
  }
});

test('a second school without a badge can center its complete title and dates beside the crest',()=>{
  for(const perCharacter of [false,true]){
    const f=fixture();
    education(f.ctx,{school:'南京林业大学',major:'机电工程学院',degree:'硕士',date:'2020 - 2023',badge:'双一流院校',perCharacter});
    education(f.ctx,{heading:false,y:898,titleY:932,school:'蚌埠学院',major:'机械设计制造及其自动化',
      degree:'本科',date:'2016 - 2020',badge:'',perCharacter});
    const result=readable(f,2);
    const checks=result.diagnostics.details.filter(item=>item.kind==='education-check');
    assert.equal(checks.length,2);assert.ok(checks.every(item=>item.reason==='accepted-text'));
    assert.deepEqual(Array.from(checks,check=>[check.rowTopOffset,check.rowBottomOffset,check.rowCenterDeltaY]),
      [[2,14,-20],[24,36,2]]);
    assert.match(result.text,/蚌埠学院/);assert.match(result.text,/2016 - 2020/);f.stop();
  }
});

test('centered school rows retain their crest role through rounded masks and copied canvases',()=>{
  for(const perCharacter of [false,true])for(const cached of [false,true]){
    const f=fixture(),source=cached?f.cache():f.canvas,ctx=source.getContext();
    education(ctx,{school:'南京林业大学',major:'机电工程学院',date:'2020 - 2023',badge:'双一流院校',perCharacter});
    education(ctx,{heading:false,y:898,titleY:932,school:'蚌埠学院',major:'机械设计制造及其自动化',
      degree:'本科',date:'2016 - 2020',badge:'',icon:false,perCharacter});
    ctx.save();crestMask(ctx,'roundRect',{y:898});logo(ctx,{y:898});ctx.restore();
    if(cached)f.ctx.drawImage(source,0,-650);
    const result=readable(f,2),detail=result.diagnostics.details.filter(item=>item.kind==='education-check').at(-1);
    assert.equal(detail.titleVerified,true);assert.equal(detail.dateVerified,true);
    assert.equal(detail.roundRectClips,1);assert.equal(detail.decorationPaint,true);
    assert.equal(detail.cacheComplete,true);assert.equal(detail.rectClips,cached?1:0);
    assert.equal(detail.rowTopOffset,24);assert.equal(detail.rowBottomOffset,36);assert.equal(detail.rowCenterDeltaY,2);
    assert.match(result.text,/机械设计制造及其自动化/);f.stop();
  }
});

test('a centered school title can share its row with a smaller per-character date',()=>{
  for(const cached of [false,true]){
    const f=fixture({fontSensitiveMetrics:true}),source=cached?f.cache():f.canvas,ctx=source.getContext();
    education(ctx,{titleY:758,school:'蚌埠学院',major:'机械设计制造及其自动化',degree:'本科',date:'',badge:'',perCharacter:true});
    smallDate(ctx,'2016 - 2020',648,759,{reverse:true});
    if(cached)f.ctx.drawImage(source,0,-650);
    assert.match(readable(f,1).text,/2016 - 2020/);f.stop();
  }
});

test('school text near the crest bottom or outside its vertical span is not a centered title',()=>{
  for(const baselineOffset of [50,60,80,-12]){
    const f=fixture();education(f.ctx,{titleY:724+baselineOffset,badge:'',school:'蚌埠学院',
      major:'机械设计制造及其自动化',degree:'本科',date:'2016 - 2020'});
    const result=blocked(f);assert.equal(result.diagnostics.ignoredImages,0);
    const detail=result.diagnostics.details.find(item=>item.kind==='education-check');
    if([50,60].includes(baselineOffset)){
      assert.equal(detail.titleVerified,true);assert.equal(detail.dateVerified,true);
      assert.equal(detail.reason,'title-alignment');assert.equal(detail.candidateCount,0);
      assert.equal(detail.rowTopOffset,baselineOffset-10);assert.equal(detail.rowBottomOffset,baselineOffset+2);
      assert.equal(detail.rowCenterDeltaY,baselineOffset-32);
    }else{
      assert.equal(detail.reason,'title-unverified');assert.equal(detail.rowCenterDeltaY,undefined);
    }
    f.stop();
  }
});

test('a centered school title cannot borrow dates from a different row',()=>{
  for(const dateOffset of [-18,12,24,45]){
    const f=fixture({fontSensitiveMetrics:true});
    education(f.ctx,{titleY:758,school:'蚌埠学院',major:'机械设计制造及其自动化',degree:'本科',date:'',badge:''});
    smallDate(f.ctx,'2016 - 2020',648,758+dateOffset);
    const result=blocked(f);assert.equal(result.diagnostics.ignoredImages,0);f.stop();
  }
});

test('separate school and degree rows do not form a complete centered title',()=>{
  const f=fixture();education(f.ctx,{titleY:758,school:'蚌埠学院',major:'机械设计制造及其自动化',degree:'',date:'2016 - 2020',badge:''});
  f.ctx.fillText('本科',540,780);
  const result=blocked(f);assert.equal(result.diagnostics.ignoredImages,0);f.stop();
});

test('a tracked cached canvas preserves education anchors and the two original crest roles',()=>{
  const f=fixture(),source=f.cache(),ctx=source.getContext();
  education(ctx,{iconOptions:{clips:1}});
  education(ctx,{heading:false,y:898,degree:'本科',date:'2011 - 2015',iconOptions:{clips:1}});
  f.ctx.drawImage(source,0,-650);
  const result=readable(f,2);assert.equal(result.diagnostics.operations.drawImage,1);
  assert.match(result.text,/教育经历/);f.stop();
});

test('a school-looking row outside an identified education section cannot certify an image',()=>{
  for(const heading of ['', '工作经历', '项目经历', '资格证书']){
    const f=fixture();if(heading)f.ctx.fillText(heading,44,700);
    education(f.ctx,{heading:false});blocked(f);f.stop();
  }
});

test('education crests need the complete school, major, degree and date anchors',()=>{
  for(const options of [{school:''},{school:'研究项目'},{major:''},{degree:''},{date:''},{date:'2015'},
    {date:'2018 - 2015'},{degree:'资格认证'}]){
    const f=fixture();education(f.ctx,options);blocked(f);f.stop();
  }
});

test('an education heading quoted inside body prose does not create an education section',()=>{
  const f=fixture();f.ctx.fillText('项目资料包含教育经历和证书图片。',44,700);
  education(f.ctx,{heading:false});blocked(f);f.stop();
});

test('per-character prose crossing the gutter cannot be truncated into an education heading',()=>{
  const f=fixture();text(f.ctx,'教育经历中的证明材料',72,700,true);
  education(f.ctx,{heading:false});
  const result=blocked(f);assert.equal(result.diagnostics.ignoredImages,0);f.stop();
});

test('large or badly aligned images cannot be associated with an education title',()=>{
  for(const iconOptions of [{width:112,height:112},
    {x:20},{x:300},{y:785},{x:210}]){
    const f=fixture();education(f.ctx,{iconOptions});blocked(f);f.stop();
  }
});

test('a separate body or certificate image remains unsupported next to a recognized education crest',()=>{
  const f=fixture();education(f.ctx);
  logo(f.ctx,{x:410,y:805});blocked(f);f.stop();
});

test('a later resume section ends education logo classification',()=>{
  const f=fixture();education(f.ctx);
  f.ctx.fillText('资格证书',44,880);
  education(f.ctx,{heading:false,y:898,degree:'本科',date:'2011 - 2015'});
  blocked(f);f.stop();
});

test('an image outside the school icon slot remains unsupported beside another icon',()=>{
  const f=fixture();education(f.ctx,{icon:false});
  logo(f.ctx,{x:120,width:42,height:42});logo(f.ctx,{x:150,width:42,height:42});
  blocked(f);f.stop();
});

test('multiple small image layers beside the same complete school row are decorative',()=>{
  const f=fixture();education(f.ctx,{icon:false});
  logo(f.ctx);logo(f.ctx,{x:136});
  const result=readable(f,2);
  assert.ok(result.diagnostics.details.filter(item=>item.kind==='education-check').every(item=>item.reason==='accepted-text'));
  f.stop();
});

function tiledEducation({cuts=[808],nested=false,perCharacter=false,icon=true,missingText=false,unknown=false}={}){
  const f=fixture(),source=f.cache(),ctx=source.getContext();f.canvas.height=956;
  education(ctx,{headingY:776,y:762,titleY:776,school:'北华大学',major:'测控技术与仪器',degree:'本科',
    date:'2015 - 2019',badge:'省部共建',perCharacter,icon:false});
  if(icon){ctx.save();crestMask(ctx,'roundRect',{y:762});logo(ctx,{y:762});ctx.restore();}
  if(unknown)logo(ctx,{x:480,y:900,width:40,height:40});
  const target=nested?f.cache():f.canvas,targetCtx=target.getContext(),edges=[0,...cuts,956];
  for(let i=1;i<edges.length;i++){
    const start=edges[i-1]+(missingText&&i===2?2:0),height=edges[i]-start;
    targetCtx.drawImage(source,0,start,773,height,0,start,773,height);
  }
  if(nested)f.ctx.drawImage(target,0,0);
  return f;
}

test('46-pixel and 10-pixel cached pieces of one school icon do not make its complete education row ambiguous',()=>{
  for(const nested of [false,true])for(const perCharacter of [false,true]){
    const f=tiledEducation({nested,perCharacter}),plain=tiledEducation({nested,perCharacter,icon:false});
    const result=readable(f,2);
    assert.equal(result.text,plain.snapshot().text);
    const checks=result.diagnostics.details.filter(item=>item.kind==='education-check');
    assert.deepEqual(Array.from(checks,item=>item.imageH),[46,10]);
    assert.ok(checks.every(item=>item.reason==='accepted-text'&&item.sectionVerified&&item.titleVerified&&item.dateVerified));
    f.stop();plain.stop();
  }
});

test('school image fragments and text split across several cache tiles retain the exact original text',()=>{
  const f=tiledEducation({cuts:[770,808],perCharacter:true}),plain=tiledEducation({cuts:[770,808],perCharacter:true,icon:false});
  assert.equal(readable(f,3).text,plain.snapshot().text);f.stop();plain.stop();
});

test('ignoring fragmented school images does not ignore a separate body image or missing text at the seam',()=>{
  const unknown=tiledEducation({unknown:true});assert.equal(blocked(unknown).diagnostics.ignoredImages,2);unknown.stop();
  const gap=tiledEducation({cuts:[770,808],missingText:true});
  const result=gap.snapshot({allowVerticalBoundary:true});
  assert.equal(result.issueCode,'unsupported');assert.equal(result.text,'');
  assert.match(result.issue,/文字/);gap.stop();
});

test('a cached source copy excluding the education heading cannot borrow the missing anchor',()=>{
  const f=fixture(),source=f.cache();education(source.getContext(),{headingY:700});
  f.ctx.drawImage(source,100,714,673,180,100,40,673,180);
  blocked(f);f.stop();
});

test('uniformly scaled cached education evidence preserves the logo role',()=>{
  const f=fixture(),source=f.cache();education(source.getContext());
  f.ctx.drawImage(source,20,0,source.width*.75,source.height*.75);
  const result=readable(f,1);assert.match(result.text,/合肥工业大学/);f.stop();
});

test('erasing a heading or school title revokes a previously confirmed logo role',()=>{
  for(const cached of [false,true])for(const eraseHeading of [false,true]){
    const f=fixture();
    if(cached){const source=f.cache();education(source.getContext());f.ctx.drawImage(source,0,0);}
    else education(f.ctx);
    readable(f,1);
    if(eraseHeading)f.ctx.clearRect(40,720,70,24);
    else f.ctx.clearRect(200,720,300,24);
    const result=blocked(f);assert.equal(result.diagnostics.ignoredImages,0);f.stop();
  }
});

test('a large image cannot become a school icon merely by clipping it to a small box',()=>{
  const f=fixture();education(f.ctx,{icon:false});
  f.ctx.save();f.ctx.beginPath();f.ctx.rect(134,724,56,56);f.ctx.clip();
  f.ctx.drawImage({naturalWidth:336,naturalHeight:336},134,724,112,112);f.ctx.restore();
  const result=blocked(f);assert.equal(result.diagnostics.ignoredImages,0);f.stop();
});

test('an unobserved translucent whole-resume bitmap does not become readable education text',()=>{
  const f=fixture(),source=f.cache();education(source.getContext());
  f.ctx.globalAlpha=.5;f.ctx.drawImage(source,0,0);
  // This is the entire resume, not the small optional school icon.
  const result=f.snapshot();assert.ok(result.issue);assert.equal(result.text,'');
  assert.equal(result.diagnostics.ignoredImages,0);f.stop();
});

test('erasing or painting over only a school icon does not affect the education text',()=>{
  for(const cached of [false,true])for(const operation of ['clearRect','fillRect']){
    const f=fixture();
    if(cached){const source=f.cache();education(source.getContext());f.ctx.drawImage(source,0,0);}
    else education(f.ctx);
    const original=readable(f,1).text;f.ctx[operation](140,744,8,8);
    assert.equal(readable(f,1).text,original);f.stop();
  }
});

function smallDate(ctx,value='2015 - 2018',x=648,y=737,{hyphenY=y,reverse=false}={}){
  ctx.save();ctx.font='12px sans-serif';
  const glyphs=[];
  for(const char of value){glyphs.push({char,x,y:char==='-'?hyphenY:y});x+=ctx.measureText(char).width;}
  for(const glyph of reverse?glyphs.reverse():glyphs)ctx.fillText(glyph.char,glyph.x,glyph.y);
  ctx.restore();
}

test('a smaller per-character date with a thin hyphen remains part of its school title row',()=>{
  for(const offset of [1,2,3])for(const reverse of [false,true]){
    const f=fixture({fontSensitiveMetrics:true});education(f.ctx,{date:''});
    smallDate(f.ctx,'2015 - 2018',648,736+offset,{reverse});
    const result=readable(f,1);
    assert.equal(result.diagnostics.details.find(item=>item.kind==='education-check')?.dateVerified,true);
    assert.ok(result.text.includes('2015 - 2018'),'The original date and spacing must survive in reading order');
    f.stop();
  }
});

test('cached canvas copies retain a smaller date whose hyphen has different glyph bounds',()=>{
  const f=fixture({fontSensitiveMetrics:true}),source=f.cache(),ctx=source.getContext();
  education(ctx,{date:''});smallDate(ctx,'2015 - 2018',648,738);
  f.ctx.drawImage(source,0,-650);
  assert.ok(readable(f,1).text.includes('2015 - 2018'));f.stop();
});

test('an ink-centered hyphen on a separate baseline stays with its date after title alignment',()=>{
  for(const reverse of [false,true]){
    const f=fixture({fontSensitiveMetrics:true});education(f.ctx,{date:''});
    smallDate(f.ctx,'2015 - 2018',648,738,{hyphenY:737,reverse});
    assert.ok(readable(f,1).text.includes('2015 - 2018'));f.stop();
  }
});

test('plain mixed-font text preserves a complete date without relying on an image classification',()=>{
  const f=fixture({fontSensitiveMetrics:true});f.ctx.fillText('工作时间',202,736);
  smallDate(f.ctx,'2015 - 2018',648,738,{reverse:true});
  const result=f.snapshot();assert.equal(result.issue,'');assert.equal(result.text,'工作时间 2015 - 2018');f.stop();
});

test('an adjacent date on another text row cannot provide missing school dates',()=>{
  for(const offset of [5,14,24,-18]){
    const f=fixture({fontSensitiveMetrics:true});education(f.ctx,{date:''});
    smallDate(f.ctx,'2015 - 2018',648,736+offset);blocked(f);f.stop();
  }
});

test('a vertically distant hyphen cannot complete the date beside a school title',()=>{
  const f=fixture({fontSensitiveMetrics:true});education(f.ctx,{date:''});
  smallDate(f.ctx,'2015 - 2018',648,737,{hyphenY:744});blocked(f);f.stop();
});

test('date matching cannot infer missing hyphens or years from nearby digit glyphs',()=>{
  for(const date of ['2015 2018','2015 -','- 2018','2015 - 018','015 - 2018']){
    const f=fixture({fontSensitiveMetrics:true});education(f.ctx,{date:''});
    smallDate(f.ctx,date);blocked(f);f.stop();
  }
});

test('two separate date fields beside one school title are ambiguous',()=>{
  const f=fixture({fontSensitiveMetrics:true});education(f.ctx,{date:''});
  smallDate(f.ctx,'2015 - 2018',500);smallDate(f.ctx,'2011 - 2015',648);
  blocked(f);f.stop();
});

test('vertically stacked years and a hyphen cannot form a single education date range',()=>{
  const f=fixture({fontSensitiveMetrics:true});education(f.ctx,{date:''});
  smallDate(f.ctx,'2015',648,737);smallDate(f.ctx,'-',678,743);smallDate(f.ctx,'2018',690,751);
  blocked(f);f.stop();
});

function crestMask(ctx,kind,{x=134,y=724,width=56,height=56,radius=8}={}){
  ctx.beginPath();
  if(kind==='roundRect')ctx.roundRect(x,y,width,height,radius);
  else if(kind==='arcTo'){
    ctx.moveTo(x+radius,y);
    ctx.arcTo(x+width,y,x+width,y+height,radius);
    ctx.arcTo(x+width,y+height,x,y+height,radius);
    ctx.arcTo(x,y+height,x,y,radius);ctx.arcTo(x,y,x+width,y,radius);ctx.closePath();
  }else if(kind==='ellipse'){
    ctx.ellipse(x+width/2,y+height/2,width/2,height/2,0,0,Math.PI*2);ctx.closePath();
  }else if(kind==='unknown'){
    ctx.moveTo(x,y);ctx.lineTo(x+width,y);ctx.lineTo(x+width/2,y+height);ctx.closePath();
  }else ctx.rect(x,y,width,height);
  ctx.clip();
}
function maskedEducation(ctx,{kind='roundRect',mask={},icon={},secondMask}={}){
  education(ctx,{icon:false});ctx.save();crestMask(ctx,kind,mask);
  if(secondMask)crestMask(ctx,secondMask.kind||'rect',secondMask);
  logo(ctx,icon);ctx.restore();
}

test('an exact rounded school-image mask is decorative for both roundRect and arcTo paths',()=>{
  for(const kind of ['roundRect','arcTo']){
    const f=fixture();maskedEducation(f.ctx,{kind});readable(f,1);f.stop();
  }
});

test('a cached rounded school icon preserves the original education text',()=>{
  for(const kind of ['roundRect','arcTo']){
    const f=fixture(),source=f.cache();maskedEducation(source.getContext(),{kind});
    f.ctx.drawImage(source,0,-650);
    const result=readable(f,1);assert.equal(result.diagnostics.operations.drawImage,1);
    const detail=result.diagnostics.details.find(item=>item.kind==='education-check');
    assert.equal(detail.fullPaint,false);assert.equal(detail.decorationPaint,true);
    assert.equal(detail.frameClipConfirmed,true);assert.equal(detail.cacheComplete,true);
    assert.equal(detail.rectClips,1);assert.equal(detail.roundRectClips,1);
    assert.equal(detail.paintW,56);assert.equal(detail.paintH,56);f.stop();
  }
});

test('an exact circular school-image mask is accepted directly and through a cached copy',()=>{
  for(const cached of [false,true]){
    const f=fixture();
    if(cached){const source=f.cache();maskedEducation(source.getContext(),{kind:'ellipse'});f.ctx.drawImage(source,0,-650);}
    else maskedEducation(f.ctx,{kind:'ellipse'});
    readable(f,1);f.stop();
  }
});

test('inset or offset school-icon masks do not block complete education text',()=>{
  for(const mask of [{x:135,y:725,width:54,height:54},{x:135},{y:725},{x:134.01}]){
    const plain=fixture();education(plain.ctx,{icon:false});const expected=readable(plain,0).text;plain.stop();
    const f=fixture();maskedEducation(f.ctx,{mask});
    assert.equal(readable(f,1).text,expected);f.stop();
  }
});

test('a larger original image clipped into a matching rounded logo box is unsupported',()=>{
  for(const cached of [false,true]){
    const f=fixture();
    if(cached){const source=f.cache();maskedEducation(source.getContext(),{icon:{width:112,height:112}});f.ctx.drawImage(source,0,-650);}
    else maskedEducation(f.ctx,{icon:{width:112,height:112}});
    blocked(f);f.stop();
  }
});

test('school-icon source cropping does not change the complete education text',()=>{
  const plain=fixture();education(plain.ctx,{icon:false});const expected=readable(plain,0).text;plain.stop();
  for(const options of [{crop:true},{sourceSize:0}]){
    const f=fixture();maskedEducation(f.ctx,{icon:options});
    assert.equal(readable(f,1).text,expected);f.stop();
  }
});

test('extra school-icon masks do not require image-completeness validation',()=>{
  for(const secondMask of [{width:55},{x:135},{kind:'roundRect',x:136,y:726,width:52,height:52}]){
    const plain=fixture();education(plain.ctx,{icon:false});const expected=readable(plain,0).text;plain.stop();
    const f=fixture();maskedEducation(f.ctx,{secondMask});assert.equal(readable(f,1).text,expected);f.stop();
  }
});

test('the shape of a school-icon mask is irrelevant to complete education text',()=>{
  const plain=fixture();education(plain.ctx,{icon:false});const expected=readable(plain,0).text;plain.stop();
  const f=fixture();maskedEducation(f.ctx,{kind:'ellipse',mask:{height:48}});
  assert.equal(readable(f,1).text,expected);f.stop();
});

test('unknown clipping paths remain unsupported even beside complete education text',()=>{
  const f=fixture();maskedEducation(f.ctx,{kind:'unknown'});
  const result=f.snapshot();assert.ok(result.issue);assert.equal(result.text,'');
  assert.equal(result.diagnostics.ignoredImages,0);f.stop();
});

test('a partially erased rounded school icon leaves all original education words unchanged',()=>{
  for(const cached of [false,true])for(const operation of ['clearRect','fillRect']){
    const f=fixture();
    if(cached){const source=f.cache();maskedEducation(source.getContext());f.ctx.drawImage(source,0,0);}
    else maskedEducation(f.ctx);
    const original=readable(f,1).text;f.ctx[operation](140,744,8,8);
    assert.equal(readable(f,1).text,original);f.stop();
  }
});

test('education text stays intact through nested and uniformly scaled school-icon copies',()=>{
  for(const scaled of [false,true]){
    const f=fixture(),source=f.cache(),middle=f.cache();maskedEducation(source.getContext());
    middle.getContext().drawImage(source,0,0);
    if(scaled)f.ctx.drawImage(middle,20,0,middle.width*.75,middle.height*.75);
    else f.ctx.drawImage(middle,0,-650);
    const detail=readable(f,1).diagnostics.details.find(item=>item.kind==='education-check');
    assert.equal(detail.decorationPaint,true);assert.equal(detail.frameClipConfirmed,true);
    assert.equal(detail.fullPaint,false);assert.equal(detail.cacheComplete,true);
    assert.equal(detail.rectClips,2);assert.equal(detail.roundRectClips,1);
    assert.equal(detail.paintW,scaled?42:56);assert.equal(detail.paintH,scaled?42:56);f.stop();
  }
});

test('an altered school icon in a cached source does not invalidate its complete education row',()=>{
  for(const operation of ['clearRect','fillRect']){
    const f=fixture(),source=f.cache(),ctx=source.getContext();maskedEducation(ctx);
    ctx[operation](140,744,8,8);f.ctx.drawImage(source,0,-650);
    const result=readable(f,1);assert.match(result.text,/合肥工业大学 \| 机械工程 \| 硕士/);f.stop();
  }
});

test('a cache crop confined to a school icon does not block complete school and date text',()=>{
  for(const copiedAgain of [false,true]){
    const f=fixture(),source=f.cache();maskedEducation(source.getContext());
    // Copy ends at775 while the icon ends at780. All title/date text is present.
    if(copiedAgain){
      const cropped=f.cache();cropped.getContext().drawImage(source,0,650,773,125,0,0,773,125);
      f.ctx.drawImage(cropped,0,0);
    }else f.ctx.drawImage(source,0,650,773,125,0,0,773,125);
    const result=f.snapshot(),detail=result.diagnostics.details.find(item=>item.kind==='education-check');
    assert.equal(result.issue,'');assert.equal(result.diagnostics.ignoredImages,1);
    assert.equal(detail.titleVerified,true);assert.equal(detail.dateVerified,true);
    assert.equal(detail.reason,'accepted-text');
    assert.match(result.text,/合肥工业大学 \| 机械工程 \| 硕士/);assert.match(result.text,/2015 - 2018/);f.stop();
  }
});

test('a school icon rendered from an unobserved canvas is optional when its education text is complete',()=>{
  const f=fixture(),source=f.cache();source.width=336;source.height=336;
  education(f.ctx,{icon:false});const original=readable(f,0).text;
  f.ctx.save();crestMask(f.ctx,'roundRect');f.ctx.drawImage(source,134,724,56,56);f.ctx.restore();
  assert.equal(readable(f,1).text,original);f.stop();
});

// The same recorded cached drawing moves upward as the resume scrolls. Its
// first screen proves the education section; later screens still contain the
// complete school/title/date text while that heading is physically above y=0.
function continuationFixture({perCharacter=false,rounded=false,arm=true}={}){
  const f=fixture(),source=f.cache(),ctx=source.getContext(),sourceImage={naturalWidth:336,naturalHeight:336};
  education(ctx,{headingY:700,titleY:758,school:'蚌埠学院',major:'机械设计制造及其自动化',
    degree:'本科',date:'2016 - 2020',badge:'',perCharacter,icon:false});
  if(rounded){ctx.save();crestMask(ctx,'roundRect');}
  logo(ctx,{sourceImage});if(rounded)ctx.restore();
  ctx.fillText('专业技能',44,900);ctx.fillText('C++ / C# / Python 熟练',134,930);
  if(arm)f.window.__hrmBackgroundRead={token:'education-continuity',canvas:f.canvas,expectedName:'王**'};
  const paint=(offset=-650,from=source,target=f.canvas)=>{
    const context=target.getContext();context.clearRect(0,0,target.width,target.height);context.drawImage(from,0,offset);
  };
  return {...f,source,sourceImage,paint};
}

test('a school icon crossing either viewport edge does not require a complete image proof',()=>{
  for(const perCharacter of [false,true])for(const rounded of [false,true]){
    const f=continuationFixture({perCharacter,rounded});f.canvas.height=956;
    f.paint();readable(f,1);f.paint(180);
    const result=f.snapshot({allowVerticalBoundary:true}),detail=result.diagnostics.details.find(item=>item.kind==='education-check');
    assert.equal(result.issue,'');assert.equal(result.diagnostics.ignoredImages,1);
    assert.equal(detail.reason,'accepted-text');
    assert.match(result.text,/蚌埠学院/);assert.match(result.text,/2016 - 2020/);
    f.paint(-744);const top=f.snapshot({allowVerticalBoundary:true});
    assert.equal(top.issue,'');assert.equal(top.diagnostics.ignoredImages,1);
    assert.equal(top.diagnostics.details.find(item=>item.kind==='education-check').reason,'accepted-text-history');
    f.paint();readable(f,1);f.stop();
  }
});

test('a first-view bottom-cropped school icon is ignored without a historical image proof or armed session',()=>{
  for(const arm of [false,true]){
    const f=continuationFixture({rounded:true,arm});f.canvas.height=956;f.paint(180);
    const result=f.snapshot({allowVerticalBoundary:true});
    assert.equal(result.issue,'');assert.equal(result.diagnostics.ignoredImages,1);
    assert.match(result.text,/蚌埠学院/);assert.match(result.text,/2016 - 2020/);f.stop();
  }
});

test('school-icon exemptions cannot hide horizontal text loss or a separate unknown body image',()=>{
  for(const change of ['horizontal','unknown']){
    const f=continuationFixture({rounded:true});f.canvas.height=956;f.paint();readable(f,1);
    if(change==='horizontal'){
      f.ctx.clearRect(0,0,773,956);f.ctx.drawImage(f.source,-150,180);
    }else{f.paint(180);logo(f.ctx,{x:500,y:300,width:40,height:40});}
    const result=f.snapshot({allowVerticalBoundary:true});assert.ok(result.issue);assert.equal(result.text,'');
    if(change==='unknown')assert.equal(result.diagnostics.ignoredImages,1);f.stop();
  }
});

test('missing education words or a new section still block an image beside an incomplete row',()=>{
  for(const change of ['title','date','new-section','partial-title']){
    const f=continuationFixture({rounded:true});f.canvas.height=956;f.paint();readable(f,1);
    f.paint(change==='partial-title'?202:180);
    if(change==='title')f.ctx.clearRect(200,924,435,25);
    if(change==='date')f.ctx.clearRect(645,924,110,25);
    if(change==='new-section')f.ctx.fillText('资格证书',44,910);
    const result=f.snapshot({allowVerticalBoundary:true});
    assert.equal(result.issueCode,'unsupported',change);assert.equal(result.diagnostics.ignoredImages,0,change);f.stop();
  }
});

test('a pinned read retains the same cached crest when its verified education heading scrolls fully above the canvas',()=>{
  for(const perCharacter of [false,true])for(const rounded of [false,true]){
    const f=continuationFixture({perCharacter,rounded});f.paint();readable(f,1);
    f.paint(-710);const result=readable(f,1);
    assert.doesNotMatch(result.text,/教育经历/);assert.match(result.text,/蚌埠学院/);
    assert.match(result.text,/2016 - 2020/);assert.match(result.text,/专业技能/);
    const once=result.text;assert.equal(f.snapshot().text,once);f.stop();
  }
});

test('an unproved or unpinned cropped school row cannot acquire a section from an unseen cache',()=>{
  for(const arm of [false,true]){
    const f=continuationFixture({arm});
    if(!arm){f.paint();readable(f,1);}
    f.paint(-710);const result=blocked(f);
    assert.equal(result.diagnostics.ignoredImages,0);f.stop();
  }
});

test('education continuation is limited to the same read object, token, expected name and displayed canvas',()=>{
  for(const change of ['token','object','removed','expected-name','snapshot-name','canvas']){
    const f=continuationFixture();f.paint();readable(f,1);
    const session=f.window.__hrmBackgroundRead;
    if(change==='token')session.token='another-read';
    if(change==='object')f.window.__hrmBackgroundRead={...session};
    if(change==='removed')delete f.window.__hrmBackgroundRead;
    if(change==='expected-name')session.expectedName='李**';
    let target=f.canvas;
    if(change==='canvas'){target=f.cache();f.showCanvas(target);session.canvas=target;}
    f.paint(-710,f.source,target);
    const result=change==='snapshot-name'?f.snapshot({expectedName:'李**'}):f.snapshot();
    assert.equal(result.issueCode,'unsupported',change);assert.equal(result.diagnostics.ignoredImages,0,change);
    assert.match(result.issue,/图片/,change);f.stop();
  }
});

test('a newly painted source cannot borrow an offscreen education section from a previous capture',()=>{
  for(const sameSource of [false,true]){
    const f=continuationFixture();f.paint();readable(f,1);
    const source=sameSource?f.source:f.cache(),ctx=source.getContext();
    if(sameSource)ctx.clearRect(134,724,56,56);
    else education(ctx,{headingY:700,titleY:758,school:'蚌埠学院',major:'机械设计制造及其自动化',
      degree:'本科',date:'2016 - 2020',badge:'',icon:false});
    logo(ctx,{sourceImage:f.sourceImage});f.paint(-710,source);
    assert.equal(blocked(f).diagnostics.ignoredImages,0);f.stop();
  }
});

test('changing source evidence after section verification invalidates cached education continuation',()=>{
  for(const change of ['heading','title','date','image','source-reset']){
    const f=continuationFixture();f.paint();readable(f,1);const ctx=f.source.getContext();
    if(change==='heading')ctx.clearRect(40,685,70,22);
    if(change==='title'){
      ctx.clearRect(200,740,440,25);ctx.fillText('另一示例大学 | 计算机科学 | 本科',202,758);
    }
    if(change==='date'){
      ctx.clearRect(645,740,110,25);ctx.fillText('2012 - 2016',648,758);
    }
    if(change==='image')ctx.clearRect(140,744,8,8);
    if(change==='source-reset'){
      ctx.clearRect(0,0,f.source.width,f.source.height);
      education(ctx,{headingY:700,titleY:758,school:'蚌埠学院',major:'机械设计制造及其自动化',
        degree:'本科',date:'2016 - 2020',badge:''});
    }
    f.paint(-710);assert.equal(blocked(f).diagnostics.ignoredImages,0,change);f.stop();
  }
});

test('unsupported source paints that cover an offscreen heading cannot leave its old continuation proof valid',()=>{
  for(const fillStyle of [{gradient:true},{pattern:true}]){
    const f=continuationFixture();f.paint();readable(f,1);
    const ctx=f.source.getContext();ctx.fillStyle=fillStyle;ctx.fillRect(40,685,70,22);
    // This unsupported paint lies wholly above the next viewport. Its source
    // mutation still invalidates the heading used by the earlier proof.
    f.paint(-710);assert.equal(blocked(f).diagnostics.ignoredImages,0);
    f.stop();
  }
});

test('erasing an in-view heading is not equivalent to scrolling its original geometry offscreen',()=>{
  const f=continuationFixture();f.paint();readable(f,1);
  f.ctx.clearRect(40,35,70,22);
  assert.equal(blocked(f).diagnostics.ignoredImages,0);f.stop();
});

test('a partly clipped education heading is not treated as fully scrolled out of the canvas',()=>{
  const f=continuationFixture();f.paint();readable(f,1);
  // Its original ink box becomes [-5,7], so the title is not fully above y=0.
  f.paint(-695);const result=f.snapshot({allowVerticalBoundary:true});
  assert.equal(result.issueCode,'unsupported');assert.match(result.issue,/图片/);
  assert.equal(result.diagnostics.ignoredImages,0);f.stop();
});

test('education continuation keeps the independently copied heading source as a live evidence dependency',()=>{
  for(const changedHeading of [false,true]){
    const f=continuationFixture(),heading=f.cache(),headingContext=heading.getContext();
    f.source.getContext().clearRect(40,685,70,22);headingContext.fillText('教育经历',44,700);
    const paint=offset=>{
      f.ctx.clearRect(0,0,f.canvas.width,f.canvas.height);
      // Two disjoint source tiles meet at y=710. The school's tile does not
      // contain its section label, including during the successful first read.
      f.ctx.drawImage(heading,0,650,773,60,0,650+offset,773,60);
      f.ctx.drawImage(f.source,0,710,773,390,0,710+offset,773,390);
    };
    paint(-650);readable(f,1);
    if(changedHeading){
      headingContext.clearRect(40,685,70,22);headingContext.fillText('资格证书',44,700);
    }
    paint(-710);
    if(changedHeading)assert.equal(blocked(f).diagnostics.ignoredImages,0);
    else assert.equal(readable(f,1).diagnostics.ignoredImages,1);
    f.stop();
  }
});

test('a section heading recovered across a cache seam retains both original fragment dependencies',()=>{
  for(const changedFirstFragment of [false,true]){
    const f=continuationFixture(),first=f.cache(),second=f.cache();
    first.getContext().fillText('教育经历',44,700);second.getContext().fillText('教育经历',44,700);
    f.ctx.clearRect(0,0,f.canvas.width,f.canvas.height);
    // The single original text run spans x=44..100. Each source contributes
    // half, so addCopyFragment must unite its coverage and both dependencies.
    f.ctx.drawImage(first,0,650,72,60,0,0,72,60);
    f.ctx.drawImage(second,72,650,701,60,72,0,701,60);
    f.ctx.drawImage(f.source,0,710,773,390,0,60,773,390);
    readable(f,1);
    if(changedFirstFragment)first.getContext().clearRect(40,685,70,22);
    f.ctx.clearRect(0,0,f.canvas.width,f.canvas.height);
    f.ctx.drawImage(f.source,0,710,773,390,0,0,773,390);
    if(changedFirstFragment)assert.equal(blocked(f).diagnostics.ignoredImages,0);
    else assert.equal(readable(f,1).diagnostics.ignoredImages,1);
    f.stop();
  }
});

test('a failed first snapshot cannot authorize education continuation after its unrelated image scrolls away',()=>{
  const f=continuationFixture();
  f.source.getContext().drawImage({naturalWidth:40,naturalHeight:40},400,650,40,40);
  f.paint();const first=blocked(f);
  assert.equal(first.diagnostics.ignoredImages,1,'The school itself was otherwise correctly classified');
  f.paint(-710);assert.equal(blocked(f).diagnostics.ignoredImages,0);
  f.stop();
});

test('only complete education heading and school text may establish section continuation evidence',()=>{
  for(const rect of [
    {x:0,y:60,width:773,height:450}, // Education heading entirely outside viewport.
    {x:0,y:48,width:773,height:450}, // Education heading partly outside viewport.
    {x:0,y:0,width:700,height:450}, // Part of the date field outside viewport.
  ]){
    const f=continuationFixture();f.paint();const first=f.snapshot({rect});
    assert.equal(first.issue,'','The first snapshot can read its safe complete rows');
    f.paint(-710);assert.equal(blocked(f).diagnostics.ignoredImages,0,JSON.stringify(rect));
    f.stop();
  }
});

test('a new unknown body image still blocks a screen whose original education crest carries forward',()=>{
  const f=continuationFixture();f.paint();readable(f,1);f.paint(-710);
  f.ctx.drawImage({naturalWidth:40,naturalHeight:40},400,190,40,40);
  const result=blocked(f);assert.equal(result.diagnostics.ignoredImages,1);
  assert.equal(result.diagnostics.reasonCounts.find(item=>/无法确认是否属于正文的图片/.test(item.reason))?.count,1);
  f.stop();
});

test('new section labels and modified visible title text still revoke an offscreen heading approval',()=>{
  for(const change of ['section','title','date','title-position']){
    const f=continuationFixture();f.paint();readable(f,1);f.paint(-710);
    if(change==='section')f.ctx.fillText('资格证书',44,12);
    if(change==='title'||change==='title-position'){
      f.ctx.clearRect(200,30,440,25);
      f.ctx.fillText(change==='title'?'另一示例大学 | 计算机科学 | 本科':'蚌埠学院 | 机械设计制造及其自动化 | 本科',
        change==='title-position'?208:202,48);
    }
    if(change==='date'){
      f.ctx.clearRect(645,30,110,25);f.ctx.fillText('2012 - 2016',648,48);
    }
    const result=blocked(f);assert.equal(result.diagnostics.ignoredImages,0,change);f.stop();
  }
});


// School details come from the original text. The school icon never needs a
// complete source, mask, cache rectangle or previous image approval.
test('the first directly drawn crest may extend beyond the canvas while a lower badge row is deferred',()=>{
  for(const perCharacter of [false,true]){
    const draw=(f,withLogo)=>{
      f.canvas.height=956;f.ctx.clearRect(0,0,773,956);
      text(f.ctx,'教育经历',49,924,perCharacter);
      text(f.ctx,'北华大学 | 测控技术与仪器 | 本科',202,924,perCharacter);
      text(f.ctx,'2015 - 2019',648,924,perCharacter);
      f.ctx.save();f.ctx.font='12px sans-serif';text(f.ctx,'省部共建',202,958,true);f.ctx.restore();
      if(withLogo){f.ctx.save();crestMask(f.ctx,'roundRect',{y:910});logo(f.ctx,{y:910});f.ctx.restore();}
      return f.snapshot({allowVerticalBoundary:true});
    };
    const plain=fixture({fontSensitiveMetrics:true}),expected=draw(plain,false);plain.stop();
    const f=fixture({fontSensitiveMetrics:true}),result=draw(f,true);
    assert.equal(result.issue,'');assert.equal(result.diagnostics.ignoredImages,1);
    assert.equal(result.text,expected.text);assert.equal(result.boundaryRows.bottom,true);
    assert.match(result.text,/北华大学 \| 测控技术与仪器 \| 本科/);
    assert.match(result.text,/2015 - 2019/);assert.doesNotMatch(result.text,/省部共建/);
    assert.equal(result.diagnostics.details.find(item=>item.kind==='education-check').reason,'accepted-text');
    f.stop();
  }
});

test('school-icon transparency, direction and modest shape differences leave education words unchanged',()=>{
  for(const variant of ['transparent','reversed','non-square']){
    const f=fixture();education(f.ctx,{icon:false});const original=readable(f,0).text;
    if(variant==='transparent'){f.ctx.globalAlpha=.5;logo(f.ctx);f.ctx.globalAlpha=1;}
    else if(variant==='reversed')logo(f.ctx,{x:190,width:-56});
    else logo(f.ctx,{width:56,height:42});
    assert.equal(readable(f,1).text,original);f.stop();
  }
});

test('icon-only changes in a visible education section do not revoke complete school text',()=>{
  for(const change of ['source','image']){
    const f=continuationFixture({rounded:true});f.canvas.height=956;f.paint();readable(f,1);
    if(change==='source')f.source.getContext().fillText('独立完整原文',400,300);
    f.paint(180);
    if(change==='image')f.ctx.clearRect(145,920,8,8);
    const result=f.snapshot({allowVerticalBoundary:true});
    assert.equal(result.issue,'');assert.equal(result.diagnostics.ignoredImages,1);
    assert.match(result.text,/蚌埠学院/);assert.match(result.text,/2016 - 2020/);f.stop();
  }
});

test('a readable area may exclude the crest bottom and still prove complete education text for later scrolling',()=>{
  const f=continuationFixture();f.paint();
  const first=f.snapshot({rect:{x:0,y:0,width:773,height:125}});
  assert.equal(first.issue,'');assert.match(first.text,/蚌埠学院/);
  f.paint(-710);assert.equal(readable(f,1).diagnostics.ignoredImages,1);f.stop();
});
