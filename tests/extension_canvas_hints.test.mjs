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
function fixture({inkMetrics}={}) {
  class Canvas {
    constructor(){this._width=2000;this._height=1000;this.isConnected=true;}
    get width(){return this._width;} set width(value){this._width=value;}
    get height(){return this._height;} set height(value){this._height=value;}
    getBoundingClientRect(){return {left:0,top:0,width:1000,height:500};}
    getContext(){return this.ctx;}
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
  window.__hrmCanvasPlatformAssets={match:source=>source.knownAsset?'experience-inquiry':''};
  window.__hrmBackgroundRead={token:'test-hint',canvas,expectedName};
  const document={querySelectorAll:()=>[canvas],createElement:()=>new Canvas(),createElementNS:()=>new Canvas()};
  const sandbox={window,CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,document,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1',direction:'ltr'})};
  vm.createContext(sandbox);vm.runInContext(geometry,sandbox);vm.runInContext(observer,sandbox);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  return {canvas,ctx,window,Context,snapshot:(options={})=>window.__hrmCanvasText.snapshot({textOnly:false,expectedName,...options}),
    stop:()=>window.__hrmCanvasText.stop()};
}
const warning='最近一份工作经历可能未更新',button='询问Ta',date='2019.05 - 2025.08';
const right=700+date.length*10;
function paint(f,{expanded=false,knownAsset=true,warningText=warning,extra='',body='算法系统正文必须完整保留。',
  x=right-16,y=216,duplicate=false,dates=date,name=expectedName,clip=false}={}){
  const {ctx,canvas}=f;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.font='14px sans-serif';
  ctx.fillText(name,200,30);ctx.fillText('33岁 10年 本科',200,55);
  ctx.fillText('期望职位',200,150);ctx.fillText('杭州 视觉工程师 20-30K',300,150);
  ctx.fillText('工作经历',100,260);ctx.fillText('示例科技有限公司 图像算法工程师',240,260);ctx.fillText(dates,700,260);
  ctx.fillText(body,240,300);
  if(expanded){
    const width=(warningText+button+extra).length*10+30,left=right+4-width;
    ctx.beginPath();ctx.roundRect(left,212,width,24,8);ctx.fill();
    ctx.fillText(warningText+button+extra,left+26,230);x=left+4;
  }
  const source={naturalWidth:32,naturalHeight:32,knownAsset};
  if(clip){ctx.save();ctx.beginPath();ctx.rect(x,y,10,16);ctx.clip();}
  ctx.drawImage(source,x,y,16,16);
  if(clip)ctx.restore();
  if(duplicate)ctx.drawImage(source,x-24,y,16,16);
}
function begin(f){
  const snap=f.snapshot();assert.equal(snap.issueCode,'unsupported');assert.equal(snap.hintMarks?.length,1);
  assert.equal(f.window.__hrmCanvasText.hint('begin',{expectedName,mark:snap.hintMarks[0]}).ok,true);
  return snap;
}
const hint=(f,action)=>f.window.__hrmCanvasText.hint(action,{expectedName});

test('known collapsed information icon stays blocked until exact hover text and restored body are verified',()=>{
  const f=fixture();paint(f);begin(f);
  assert.equal(hint(f,'finish').ok,false);
  paint(f,{expanded:true});assert.equal(hint(f,'probe').ready,true);
  assert.equal(f.snapshot().issueCode,'unsupported');
  paint(f);assert.equal(hint(f,'finish').ok,true);
  const result=f.snapshot();assert.equal(result.issue,'');assert.match(result.text,/算法系统正文必须完整保留/);
  assert.doesNotMatch(result.text,/最近一份工作经历|询问Ta/);
  assert.equal(result.platformNotes.length,1);assert.equal(result.platformNotes[0].text,warning);
  assert.match(result.platformNotes[0].anchor,/示例科技有限公司/);assert.match(result.platformNotes[0].anchor,/2019\.05/);
  assert.doesNotMatch(JSON.stringify(result),/paintIdentity|sourceLineage|hintAsset|knownAsset/);
});
test('an already open exact warning is preserved separately, not included in body overlap',()=>{
  const f=fixture();paint(f,{expanded:true});const result=f.snapshot();
  assert.equal(result.issue,'');assert.equal(result.platformNotes[0].text,warning);
  assert.doesNotMatch(result.text,/最近一份工作经历|询问Ta/);
});
test('same warning text in actual resume prose is never stripped',()=>{
  const f=fixture();paint(f,{expanded:true,body:warning});const result=f.snapshot();
  assert.equal(result.issue,'');assert.match(result.text,new RegExp(warning));
});
test('unknown pixels, duplicate icons, missing work dates, wrong identity, body placement and clipping cannot authorize hover',()=>{
  for(const options of [{knownAsset:false},{duplicate:true},{dates:'时间不明'},{name:'李**'},{name:'王***'},{x:400,y:350},{clip:true}]){
    const f=fixture();paint(f,options);const result=f.snapshot();
    assert.equal(result.issueCode,'unsupported',JSON.stringify(options));assert.equal(result.hintMarks?.length||0,0,JSON.stringify(options));
    assert.equal(hint(f,'probe').ready,false);f.stop();
  }
});
test('missing, extra or truncated warning text does not complete a probe',()=>{
  for(const options of [{warningText:warning.slice(1)},{extra:'额外提示'},{expanded:false}]){
    const f=fixture();paint(f);begin(f);paint(f,{expanded:true,...options});
    assert.equal(hint(f,'probe').ready,false);paint(f);assert.equal(hint(f,'finish').ok,false);f.stop();
  }
});
test('hover and restoration reject changed original text, work dates or position',()=>{
  for(const options of [{body:'内容已经变化'},{dates:'2018.05 - 2025.08'},{x:right-20}]){
    const f=fixture();paint(f);begin(f);paint(f,{expanded:true});assert.equal(hint(f,'probe').ready,true);
    paint(f,options);assert.equal(hint(f,'finish').ok,false);assert.equal(f.snapshot().issueCode,'unsupported');f.stop();
  }
  const f=fixture();paint(f);begin(f);paint(f,{expanded:true,body:'悬停期间正文变化'});
  assert.equal(hint(f,'probe').ready,false);
});
test('only the restoration paint is approved; new paint and new session need fresh proof',()=>{
  const f=fixture();paint(f);begin(f);paint(f,{expanded:true});hint(f,'probe');paint(f);hint(f,'finish');
  assert.equal(f.snapshot().issue,'');paint(f);assert.equal(f.snapshot().issueCode,'unsupported');
  begin(f);paint(f,{expanded:true});hint(f,'probe');paint(f);hint(f,'finish');
  f.window.__hrmBackgroundRead={token:'another',canvas:f.canvas,expectedName};
  assert.equal(f.snapshot().issueCode,'unsupported');assert.equal(f.snapshot().platformNotes,undefined);
});
test('stale mark, cancelled probe and clipped visible tooltip never create permission',()=>{
  const f=fixture();paint(f);const mark=f.snapshot().hintMarks[0];paint(f);
  assert.equal(f.window.__hrmCanvasText.hint('begin',{expectedName,mark}).ok,false);
  begin(f);paint(f,{expanded:true});hint(f,'probe');hint(f,'cancel');paint(f);assert.equal(hint(f,'finish').ok,false);
  paint(f,{expanded:true});const result=f.snapshot({rect:{x:0,y:0,width:right-20,height:1000}});
  assert.equal(result.issueCode,'unsupported');assert.equal(result.platformNotes,undefined);
});
test('a cache copy retains the verified hint only while all copied source dependencies stay unchanged',()=>{
  const f=fixture(),source=new f.canvas.constructor(),sourceCtx=new f.Context(source),page={...f,canvas:source,ctx:sourceCtx};
  const display=(y=0)=>{f.ctx.clearRect(0,0,f.canvas.width,f.canvas.height);f.ctx.drawImage(source,0,y);};
  paint(page);display();begin(f);paint(page,{expanded:true});display();assert.equal(hint(f,'probe').ready,true);
  paint(page);display();assert.equal(hint(f,'finish').ok,true);assert.equal(f.snapshot().issue,'');
  display(-100);assert.equal(f.snapshot().issue,'');
  sourceCtx.fillStyle={gradient:true};sourceCtx.fillRect(0,0,10,10);
  assert.equal(f.snapshot().issueCode,'unsupported');
});
