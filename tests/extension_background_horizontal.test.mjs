import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {backgroundResumeFrame,readBackgroundResume} from '../extension/background-read.mjs';

const footer='为妥善保护牛人在BOSS直聘平台提交的简历信息，未经授权不得在任何第三方平台进行复制、使用、传播、存储。';
const resume='张**\n个人优势\n独立负责工业相机镜头光源选型和视觉系统方案设计，完成机器视觉算法的软件开发与现场技术交付。\n'+
  '工作经历\n虚构测试设备公司，视觉研发工程师。协同机械电气团队进行多工位设备测试，建立标定流程和质量验证标准，持续改善检测精度和生产效率。\n'+
  '教育经历\n虚构测试大学计算机本科。\n'+footer;

// Uses the actual frame adapter and its CSS-to-canvas mapping. Only browser
// layout metrics and drawing-observer snapshots are supplied by this fixture.
function frameFixture(options={}){
  const root={parentElement:null,isConnected:true,clientWidth:800,clientHeight:600,scrollHeight:600,scrollTop:0};
  const owner={parentElement:root,isConnected:true,clientWidth:options.ownerWidth??485,clientHeight:500,
    scrollHeight:500,scrollTop:0,clientLeft:0,clientTop:0,offsetWidth:500,offsetHeight:500,
    getBoundingClientRect:()=>({left:0,top:0,width:500,height:500})};
  const canvasRect=options.canvasRect||{left:0,top:0,right:500,bottom:500,width:500,height:500};
  const canvas={parentElement:owner,isConnected:true,width:1000,height:1000,
    getBoundingClientRect:()=>canvasRect};
  const events=[],crops=[],actions=[];let snapshots=0,revision=7;
  canvas.dispatchEvent=event=>{events.push(event);return true;};
  const document={body:{innerText:''},scrollingElement:root,documentElement:{clientWidth:options.rootWidth??800,clientHeight:600},
    querySelectorAll:()=>[canvas],elementFromPoint:()=>canvas};
  Object.defineProperty(document,'hasFocus',{get(){throw Error('No native focus dependency');}});
  const window={__hrmCanvasText:{version:1,snapshot:({rect})=>{
    snapshots++;crops.push(rect);
    const proof={version:1,canvasId:'width-canvas',revision,complete:true,
      reason:rect.x===0&&rect.width===1000?'full-width':'empty-margins',
      canvasWidth:1000,visibleLeft:rect.x,visibleRight:rect.x+rect.width,readTop:rect.y,readBottom:rect.y+rect.height,
      clippedLeft:rect.x,clippedRight:1000-rect.x-rect.width,textLeft:60,textRight:900,
      outsideTextRuns:0,outsideImages:0,outsideIssues:0};
    const context={rect,snapshots,revision};
    const horizontalCoverage=options.proof?options.proof({...proof},context):proof;
    return {version:1,canvasId:'width-canvas',revision,text:resume,marks:[],
      ...(horizontalCoverage===undefined?{}:{horizontalCoverage}),...(options.snapshot?.(context)||{})};
  }}};window.top=window;
  class Event {constructor(type,values){this.type=type;Object.assign(this,values);}}
  const context=vm.createContext({window,document,innerWidth:800,innerHeight:600,
    MouseEvent:Event,PointerEvent:Event,WheelEvent:Event,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:e=>e===canvas?{visibility:'visible',display:'block',opacity:'1',...options.style}:
      e===owner?{overflowX:'hidden',overflowY:'auto'}:{overflowX:'hidden',overflowY:'hidden'}});
  const frame=vm.runInContext('('+backgroundResumeFrame.toString()+')',context);
  const run=(action,args={})=>{actions.push(action);return frame(action,{token:'fixed-width',name:'张**',...args});};
  const tab={id:7,url:'https://www.zhipin.com/web/chat/search',active:false};
  const browser={tabs:{get:async()=>({...tab})},scripting:{executeScript:async({func,args,target,world})=>{
    assert.equal(func,backgroundResumeFrame);assert.equal(world,'MAIN');assert.equal(target.tabId,7);
    assert.deepEqual(target.documentIds,['width-document']);
    return [{documentId:'width-document',result:run(args[0],args[1])}];
  }}};
  for(const key of ['debugger','windows','clipboard'])Object.defineProperty(browser,key,{get(){throw Error('Forbidden foreground fallback');}});
  return {run,events,crops,actions,canvas,owner,document,window,setRevision:value=>{revision=value;},
    read:()=>{
      if(window.__hrmBackgroundRead?.token==='fixed-width')run('cleanup');
      return readBackgroundResume({browser,tab,documentId:'width-document',name:'张**',pause:async()=>{},check:()=>{},report:()=>{}});
    }};
}

test('a fresh complete coverage proof permits an actually clipped blank margin while retaining literal geometry',async()=>{
  const f=frameFixture(),first=f.run('prepare');
  assert.equal(first.geometry.contentWidthVisible,false);assert.equal(first.geometry.contentWidthVerified,true);
  assert.deepEqual({...first.geometry.rect},{x:0,y:0,width:970,height:1000});
  const result=await f.read();
  assert.equal(result.issue,undefined);assert.equal(result.resume,resume);assert.equal(result.completeness.allScreensRead,true);
  assert.deepEqual(f.events.map(event=>event.type),['pointerover','pointermove','mouseover','mousemove','wheel']);
  assert.ok(f.events.every(event=>event.clientX===242.5&&event.clientY===250&&event.buttons===0));
});

test('a missing proof preserves full-DOM compatibility but never authorizes a clipped canvas',async()=>{
  for(const ownerWidth of [500,485]){
    const f=frameFixture({ownerWidth,proof:()=>undefined}),sample=f.run('prepare');
    assert.equal(sample.geometry.contentWidthVerified,undefined);
    const result=await f.read();
    if(ownerWidth===500){assert.equal(result.issue,undefined);assert.equal(result.resume,resume);}
    else {assert.equal(result.failureReason,'width-clipped');assert.equal(result.resume,'');}
  }
});

test('a proof must match the exact current canvas, revision and requested pixel area',async()=>{
  const changes=[{version:2},{canvasId:'other-canvas'},{revision:6},{canvasWidth:999},
    {visibleLeft:1},{visibleRight:969},{readTop:1},{readBottom:999},
    {visibleLeft:NaN},{visibleRight:Infinity},{readTop:'0'},{readBottom:null}];
  for(const change of changes){
    const f=frameFixture({proof:proof=>({...proof,...change})}),sample=f.run('prepare');
    assert.equal(sample.geometry.contentWidthVerified,false,JSON.stringify(change));
    const result=await f.read();assert.equal(result.failureReason,'width-clipped',JSON.stringify(change));
    assert.equal(result.resume,'');assert.equal(result.completeness.allScreensRead,false);
  }
});

test('coverage flags, reasons and every hidden-content count must be explicitly valid',async()=>{
  const changes=[{complete:false},{complete:'true'},{reason:'text-outside'},{reason:'some-untrusted-reason'},
    ...['outsideTextRuns','outsideImages','outsideIssues'].flatMap(key=>[{[key]:1},{[key]:'0'},{[key]:NaN},{[key]:undefined}])];
  for(const change of changes){
    const f=frameFixture({proof:proof=>({...proof,...change})});
    assert.equal(f.run('prepare').geometry.contentWidthVerified,false,JSON.stringify(change));
    const result=await f.read();assert.equal(result.failureReason,'width-clipped');assert.equal(result.resume,'');
  }
});

test('content-level rejection takes precedence over the DOM two-pixel width tolerance',async()=>{
  const f=frameFixture({ownerWidth:499,proof:proof=>({...proof,complete:false,reason:'text-outside',outsideTextRuns:1})});
  const sample=f.run('prepare');assert.equal(sample.geometry.contentWidthVisible,true);
  assert.equal(sample.geometry.contentWidthVerified,false);
  const result=await f.read();assert.equal(result.failureReason,'width-clipped');assert.equal(result.resume,'');
});

test('an earlier good coverage result cannot approve a later repaint with a stale or failed proof',async()=>{
  for(const mutation of [{revision:6},{complete:false,reason:'image-outside',outsideImages:1}]){
    const f=frameFixture({proof:(proof,{snapshots})=>snapshots===1?proof:{...proof,...mutation}});
    const result=await f.read();assert.equal(result.failureReason,'width-clipped');assert.equal(result.resume,'');
    assert.equal(result.completeness.allScreensRead,false);assert.equal(f.actions.at(-1),'cleanup');
  }
});

test('canvas borders and padding map the visible clip and control point through the content box',()=>{
  for(const scaled of [false,true]){
    const scale=scaled?.5:1,rect={left:0,top:0,width:560*scale,height:540*scale,right:560*scale,bottom:540*scale};
    const style={width:'500px',height:'500px',boxSizing:'content-box',
      borderLeftWidth:'10px',borderRightWidth:'10px',paddingLeft:'20px',paddingRight:'20px',
      borderTopWidth:'5px',borderBottomWidth:'5px',paddingTop:'15px',paddingBottom:'15px'};
    const mark={id:11,label:'查看全部',x:.8,y:.3};
    const f=frameFixture({ownerWidth:scaled?270:500,canvasRect:rect,style,snapshot:()=>({marks:[mark]})});
    const first=f.run('prepare'),expectedWidth=scaled?1000:940,expectedHeight=scaled?1000:960;
    assert.deepEqual({...first.geometry.rect},{x:0,y:0,width:expectedWidth,height:expectedHeight});
    assert.equal(first.geometry.contentWidthVisible,scaled);
    f.run('expand',{mark});
    assert.deepEqual(f.events.map(e=>e.type),['mousemove','mousedown','mouseup','click']);
    for(const event of f.events){assert.equal(event.clientX,430*scale);assert.equal(event.clientY,170*scale);}
  }
});

test('border-box CSS sizing removes insets exactly once before mapping bitmap pixels',()=>{
  const style={width:'560px',height:'540px',boxSizing:'border-box',
    borderLeftWidth:'10px',borderRightWidth:'10px',paddingLeft:'20px',paddingRight:'20px',
    borderTopWidth:'5px',borderBottomWidth:'5px',paddingTop:'15px',paddingBottom:'15px'};
  const f=frameFixture({ownerWidth:500,canvasRect:{left:0,top:0,right:560,bottom:540,width:560,height:540},style});
  assert.deepEqual({...f.run('prepare').geometry.rect},{x:0,y:0,width:940,height:960});
});

test('root layout viewport excludes the vertical scrollbar even when innerWidth is larger',()=>{
  const f=frameFixture({ownerWidth:500,rootWidth:485}),sample=f.run('prepare');
  assert.equal(sample.geometry.contentWidthVisible,false);assert.equal(sample.geometry.contentWidthVerified,true);
  assert.deepEqual({...f.crops.at(-1)},{x:0,y:0,width:970,height:1000});
  assert.equal(sample.geometry.horizontalClip.clippedCssRight,15);
});

test('unconfirmed border or padding metrics fail before any drawing snapshot or control event',()=>{
  for(const style of [{paddingLeft:'auto'},{borderLeftWidth:'-1px'},{paddingRight:'10%',width:'500px'},
    {paddingLeft:'20px',width:'0px',boxSizing:'border-box'}]){
    const f=frameFixture({style});assert.throws(()=>f.run('prepare'),/边框|内边距|内容区域/);
    assert.equal(f.crops.length,0);assert.equal(f.events.length,0);
  }
});
