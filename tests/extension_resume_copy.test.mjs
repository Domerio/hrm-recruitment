import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {copyOpenResume,inspectCopyFrame,nextScrollStep,observeCopyClipboard} from '../extension/resume-copy.mjs';

test('next scroll step follows the nearest measured owner and leaves overlap',()=>{
  const surface={scrollMode:'native',scrollMeasured:true,start:{x:100,y:180},end:{x:560,y:690},
    scrollChain:[{index:0,scrollTop:0,clientHeight:510,scrollHeight:1510}]};
  assert.equal(nextScrollStep(surface),306);
  assert.ok(nextScrollStep(surface)<surface.end.y-surface.start.y-8);

  surface.scrollChain[0].scrollTop=960;
  assert.equal(nextScrollStep(surface),40);

  surface.scrollChain=[
    {index:0,scrollTop:47,clientHeight:510,scrollHeight:560},
    {index:1,scrollTop:0,clientHeight:510,scrollHeight:730},
  ];
  assert.equal(nextScrollStep(surface),220);
  surface.scrollChain[0].scrollTop=0;
  assert.equal(nextScrollStep(surface),50);
});

test('next scroll step caps a short viewport and falls back without trustworthy chain geometry',()=>{
  const surface={scrollMode:'native',scrollMeasured:true,start:{x:100,y:180},end:{x:560,y:190},
    scrollChain:[{index:0,scrollTop:0,clientHeight:510,scrollHeight:1510}]};
  assert.equal(nextScrollStep(surface),2);

  surface.end.y=690;
  surface.scrollMode='stationary';
  assert.equal(nextScrollStep(surface),331.5);
  surface.scrollMode='native';
  surface.scrollChain=[];
  assert.equal(nextScrollStep(surface),331.5);
  surface.scrollChain=[{index:0,scrollTop:0,clientHeight:510,scrollHeight:NaN}];
  assert.equal(nextScrollStep(surface),331.5);
  surface.scrollChain=[{index:0,scrollTop:-10,clientHeight:510,scrollHeight:1510}];
  assert.equal(nextScrollStep(surface),331.5);
});

const text = '工作经历\n负责机器视觉软件开发、视觉定位算法和工业检测产线部署，具备 OpenCV 与 C++ 项目经验。';
const markup = `<h2>工作经历</h2><p><strong>${text.split('\n')[1]}</strong></p>`;
const first={resume:text,resume_html:markup};
const tail={resume:'教育经历\n虚构大学本科。',resume_html:'<h2>教育经历</h2><p><em>虚构大学本科。</em></p>'};
const privacyFooter='为妥善保护牛人在BOSS直聘平台提交、发布、展示的简历（包括但不限于在线简历、附件简历）中的个人信息（包括但不限于联系方式、期望职位、教育经历、工作经历等），任何用户原则上仅可出于自身招聘的目的，通过BOSS直聘平台在线浏览牛人简历。未经BOSS直聘及牛人本人书面授权，任何用户不得将牛人在BOSS直聘平台提交、发布、展示的简历中的个人信息，在任何第三方平台进行复制、使用、传播、存储。';
const overlapA='独立负责工业相机镜头光源选型和视觉系统方案设计，完成机器视觉算法的软件开发与现场技术交付。';
const overlapB='协同机械电气团队进行多工位设备测试，建立标定流程和质量验证标准，持续改善检测精度和生产效率。';
const copiedPage=resume=>({resume,resume_html:'<p>'+resume.replaceAll('\n','<br>')+'</p>'});
const virtualPages=()=>[
  copiedPage('张**\n个人优势\n熟悉机器视觉和自动化项目开发。\n'+overlapA),
  copiedPage(overlapA+'\n工作经历\n测试装备公司，视觉研发工程师。\n'+overlapB),
  copiedPage(overlapB+'\n教育经历\n测试大学计算机本科。\n'+privacyFooter),
];
const virtualWhole=()=>copiedPage('张**\n个人优势\n熟悉机器视觉和自动化项目开发。\n'+overlapA+
  '\n工作经历\n测试装备公司，视觉研发工程师。\n'+overlapB+'\n教育经历\n测试大学计算机本科。\n'+privacyFooter);

function fixedCanvasFrame(){
  const root={parentElement:null,isConnected:true,scrollTop:0,clientHeight:510,scrollHeight:510};
  const attributes=new Map();
  const canvas={parentElement:root,getBoundingClientRect:()=>({left:100,top:180,right:560,bottom:690,width:460,height:510}),
    getAttribute:name=>attributes.get(name),hasAttribute:name=>attributes.has(name),
    setAttribute:(name,value)=>attributes.set(name,value),removeAttribute:name=>attributes.delete(name)};
  const document={body:root,scrollingElement:root,hasFocus:()=>true,querySelectorAll:()=>[canvas],elementFromPoint:()=>canvas};
  canvas.focus=()=>{document.activeElement=canvas;};
  const window={};window.top=window;
  const context=vm.createContext({window,document,innerWidth:800,innerHeight:800,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:element=>element===canvas?{position:'fixed',visibility:'visible',opacity:'1',transform:'none'}:{overflowY:'hidden'}});
  return vm.runInContext('(' + inspectCopyFrame.toString() + ')',context);
}

test('a fixed canvas with no native scroll owner still measures its visible stationary viewport',()=>{
  const inspect=fixedCanvasFrame();
  assert.equal(inspect('probe').scrollMeasured,false);
  const measured=inspect('focus');
  assert.equal(measured.scrollMeasured,true);
  assert.equal(measured.scrollChain.length,0);
  assert.equal(measured.scrollMode,'stationary');
  assert.equal(measured.scrollTop,0);
  assert.equal(measured.clientHeight,510);
  assert.equal(measured.scrollHeight,510);
  inspect('cleanup');
});

const geometryStyle={position:'static',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible',
  transform:'none',perspective:'none',filter:'none',backdropFilter:'none',contain:'none',willChange:'auto',
  contentVisibility:'visible',containerType:'normal'};
const geometryBox=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});
function geometryElement(bounds,parentElement=null){
  return {parentElement,isConnected:true,scrollTop:0,scrollHeight:bounds.height,
    clientLeft:0,clientTop:0,clientWidth:bounds.width,clientHeight:bounds.height,
    offsetWidth:bounds.width,offsetHeight:bounds.height,getBoundingClientRect:()=>bounds};
}
function overflowFixedCanvasFrame({fixedAt='canvas',ancestorStyle={},ancestorClips=false,viewportHeight=1000}={}){
  const root=geometryElement(geometryBox(0,0,800,viewportHeight));
  const body=geometryElement(geometryBox(0,0,800,viewportHeight),root);
  const container=geometryElement(geometryBox(0,0,800,400),body);
  const dialog=geometryElement(geometryBox(0,0,800,960),container);
  const canvas=geometryElement(geometryBox(20,30,600,900),dialog);
  const clipped=fixedAt==='none'||ancestorClips;
  container.scrollHeight=clipped?960:400;
  const document={body,scrollingElement:root,hasFocus:()=>true,querySelectorAll:()=>[canvas],
    elementFromPoint:(x,y)=>x>=20&&x<620&&y>=30&&y<Math.min(viewportHeight,clipped?400:930)?canvas:null};
  canvas.hasAttribute=()=>true;
  canvas.focus=()=>{document.activeElement=canvas;};
  const window={};window.top=window;
  const context=vm.createContext({window,document,innerWidth:800,innerHeight:viewportHeight,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:element=>({...geometryStyle,...(element===canvas?{position:fixedAt==='canvas'?'fixed':'static'}:
      element===dialog?{position:fixedAt==='dialog'?'fixed':'static'}:
      element===container?{overflowX:'hidden',overflowY:'auto',...ancestorStyle}:{})})});
  return {inspect:vm.runInContext('('+inspectCopyFrame.toString()+')',context),document,canvas};
}

test('fixed canvas and fixed dialog escape ordinary overflow ancestors without truncating copy points',()=>{
  for(const fixedAt of ['canvas','dialog']){
    for(const ancestorStyle of [{},{position:'relative'},{willChange:'opacity'}]){
      const {inspect,document,canvas}=overflowFixedCanvasFrame({fixedAt,ancestorStyle});
      // The browser paints the fixed surface beyond its non-containing overflow ancestor.
      assert.equal(document.elementFromPoint(600,898),canvas);
      const result=inspect('focus');
      assert.equal(result.end.y,920,fixedAt);
      assert.equal(result.start.y,40,fixedAt);
      assert.equal(result.clientHeight,900,fixedAt);
      assert.equal(result.contentBottomVisible,true,fixedAt);
      assert.equal(result.scrollChain.length,0,fixedAt);
      inspect('cleanup');
    }
  }
});

test('a fixed containing block still clips a fixed canvas and measures its scroll owner',()=>{
  for(const fixedAt of ['canvas','dialog']){
    for(const ancestorStyle of [{transform:'matrix(1, 0, 0, 1, 0, 0)'},{perspective:'1000px'},
      {filter:'blur(0px)'},{contain:'paint'},{willChange:'transform'},{containerType:'inline-size'}]){
      const label=`${fixedAt}: ${JSON.stringify(ancestorStyle)}`;
      const {inspect,document,canvas}=overflowFixedCanvasFrame({fixedAt,ancestorStyle,ancestorClips:true});
      assert.notEqual(document.elementFromPoint(600,898),canvas);
      const result=inspect('focus');
      assert.equal(result.end.y,390,label);
      assert.equal(result.contentBottomVisible,false,label);
      assert.equal(result.scrollMode,'native',label);
      assert.equal(result.scrollChain[0].clientHeight,400,label);
      assert.equal(result.scrollChain[0].scrollHeight,960,label);
      assert.equal(inspect('tail-point'),null,label);
      inspect('cleanup');
    }
  }
});

test('fixed surfaces remain clipped to the actual document viewport',()=>{
  const {inspect,document,canvas}=overflowFixedCanvasFrame({viewportHeight:700});
  assert.equal(document.elementFromPoint(600,698),canvas);
  assert.notEqual(document.elementFromPoint(600,898),canvas);
  const result=inspect('focus');
  assert.equal(result.end.y,690);
  assert.equal(result.clientHeight,670);
  assert.equal(result.contentBottomVisible,false);
  assert.equal(result.scrollChain.length,0);
  assert.equal(inspect('tail-point'),null);
  inspect('cleanup');
});

test('ordinary nonfixed canvas remains clipped by its overflow ancestor',()=>{
  const {inspect,document,canvas}=overflowFixedCanvasFrame({fixedAt:'none'});
  assert.notEqual(document.elementFromPoint(600,898),canvas);
  const result=inspect('focus');
  assert.equal(result.end.y,390);
  assert.equal(result.clientHeight,370);
  assert.equal(result.contentBottomVisible,false);
  assert.equal(result.scrollMode,'native');
  assert.equal(result.scrollChain[0].clientHeight,400);
  assert.equal(inspect('tail-point'),null);
  inspect('cleanup');
});

test('fixed dialogs preserve the full visible canvas through two iframe coordinate mappings',()=>{
  const root=geometryElement(geometryBox(0,0,800,900));
  const canvas=geometryElement(geometryBox(20,30,600,800),root);
  const document={body:root,scrollingElement:root,hasFocus:()=>true,querySelectorAll:()=>[canvas],
    elementFromPoint:(x,y)=>x>=20&&x<620&&y>=30&&y<830?canvas:null};
  canvas.hasAttribute=()=>true;
  canvas.focus=()=>{document.activeElement=canvas;};
  const makeParent=(viewport,frameBounds,overflowHeight)=>{
    const root=geometryElement(geometryBox(0,0,...viewport));
    const body=geometryElement(geometryBox(0,0,viewport[0],overflowHeight),root);
    const dialog=geometryElement(geometryBox(0,0,...viewport),body);
    const frame=geometryElement(frameBounds,dialog);
    const document={scrollingElement:root,elementFromPoint:(x,y)=>
      x>=frameBounds.left&&x<frameBounds.right&&y>=frameBounds.top&&y<frameBounds.bottom?frame:null};
    frame.ownerDocument=document;
    const window={document,innerWidth:viewport[0],innerHeight:viewport[1],
      getComputedStyle:element=>({...geometryStyle,...(element===dialog?{position:'fixed'}:
        element===body?{overflowX:'hidden',overflowY:'auto'}:{})})};
    return {window,frame};
  };
  const outer=makeParent([1300,1300],geometryBox(100,80,1000,1100),400);
  outer.window.top=outer.window;
  const middle=makeParent([1000,1100],geometryBox(50,60,800,900),350);
  middle.window.top=outer.window;
  middle.window.parent=outer.window;
  middle.window.frameElement=outer.frame;
  const window={top:outer.window,parent:middle.window,frameElement:middle.frame};
  const context=vm.createContext({window,document,innerWidth:800,innerHeight:900,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:element=>({...geometryStyle,position:element===canvas?'fixed':'static'})});
  const inspect=vm.runInContext('('+inspectCopyFrame.toString()+')',context);
  const result=inspect('focus');
  assert.deepEqual({...result.start},{x:180,y:180});
  assert.deepEqual({...result.end},{x:752,y:960});
  const selected=inspect('selection-points',[{id:1,x:.3,y:.1,left:.29,top:.09,right:.35,bottom:.12}]);
  assert.equal(selected.length,1);
  assert.deepEqual({...selected[0].point},{x:350,y:250});
  assert.equal(result.clientHeight,800);
  assert.equal(result.contentBottomVisible,true);
  assert.equal(result.contentWidthVisible,true);
  assert.equal(result.scrollChain.length,0);
  inspect('cleanup');
});

test('inspect validates full dynamic fold marks and normalizes their count spacing',()=>{
  const inspect=fixedCanvasFrame();inspect('focus');
  const points=inspect('expand-points',[{id:1,label:'展开全部 16 个所获荣誉',x:.5,y:.5}]);
  assert.equal(points.length,1);
  assert.equal(points[0].mark.label,'展开全部16个所获荣誉');
  assert.equal(inspect('expand-points',[{id:2,label:'展开全部16项内部测试任务',x:.5,y:.5}]).length,0);
  inspect('cleanup');
});

test('measures and pins the visible canvas scroll container, then restores its original position',()=>{
  const attributes=new Map();
  const container={isConnected:true,scrollTop:120,clientHeight:400,clientWidth:600,clientTop:0,clientLeft:0,
    scrollHeight:900,parentElement:null,getBoundingClientRect:()=>({left:0,top:0,width:600,height:400})};
  const canvas={parentElement:container,getBoundingClientRect:()=>({left:0,top:0,right:600,bottom:400,width:600,height:400}),
    getAttribute:name=>attributes.get(name),hasAttribute:name=>attributes.has(name),
    setAttribute:(name,value)=>attributes.set(name,value),removeAttribute:name=>attributes.delete(name)};
  const document={body:{innerText:''},hasFocus:()=>true,querySelectorAll:()=>[canvas],
    elementFromPoint:()=>canvas,scrollingElement:{scrollTop:0,clientHeight:600,scrollHeight:600}};
  canvas.focus=()=>{document.activeElement=canvas;};
  const window={};window.top=window;
  const context=vm.createContext({window,document,innerWidth:600,innerHeight:400,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:element=>element===canvas?{visibility:'visible',opacity:'1'}:{overflowY:'auto'}});
  const inspect=vm.runInContext(`(${inspectCopyFrame.toString()})`,context);
  assert.equal(inspect('probe').scrollMeasured,false);
  const focused=inspect('focus');
  assert.equal(focused.scrollMeasured,true);
  assert.equal(focused.scrollTop,120);
  assert.equal(focused.clientHeight,400);
  assert.equal(focused.scrollHeight,900);
  container.scrollTop=400;
  assert.equal(inspect('probe').scrollTop,400);
  container.isConnected=false;
  assert.equal(inspect('probe'),null);
  container.isConnected=true;
  inspect('cleanup');
  assert.equal(container.scrollTop,120);
  assert.equal(attributes.has('tabindex'),false);
});

test('clips copy points to overflow ancestors inside their borders and scrollbars',()=>{
  const container={isConnected:true,scrollTop:0,clientHeight:496,clientWidth:540,clientTop:2,clientLeft:2,
    offsetWidth:560,offsetHeight:500,scrollHeight:1500,parentElement:null,
    getBoundingClientRect:()=>({left:10,top:20,width:560,height:500})};
  const canvas={parentElement:container,getBoundingClientRect:()=>({left:12,top:22,right:562,bottom:1522,width:550,height:1500}),
    hasAttribute:()=>true,focus:()=>{document.activeElement=canvas;}};
  const document={body:{innerText:''},hasFocus:()=>true,querySelectorAll:()=>[canvas],
    elementFromPoint:(x,y)=>x>=12&&x<=552&&y>=22&&y<=518?canvas:null};
  const window={};window.top=window;
  const context=vm.createContext({window,document,innerWidth:800,innerHeight:800,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:element=>element===canvas?{visibility:'visible',opacity:'1'}:
      element===container?{overflowX:'auto',overflowY:'auto'}:{overflowX:'hidden',overflowY:'hidden'}});
  const inspect=vm.runInContext(`(${inspectCopyFrame.toString()})`,context);
  const result=inspect('focus');
  assert.equal(result.start.x,22);
  assert.equal(result.start.y,32);
  assert.equal(result.end.x,534);
  assert.equal(result.end.y,508);
  assert.equal(result.scrollMeasured,true);
  assert.equal(result.clientHeight,496);
  assert.equal(result.contentTopVisible,true);
  assert.equal(result.contentBottomVisible,false);
  assert.equal(result.contentWidthVisible,false);
  container.parentElement={parentElement:null,clientLeft:0,clientTop:0,clientWidth:800,clientHeight:350,
    getBoundingClientRect:()=>({left:0,top:0,width:800,height:350})};
  assert.equal(inspect('probe').end.y,340);
});

function marginCanvasFrame({canvasWidth=600,visibleWidth=585,backingWidth=canvasWidth,backingHeight=1000,
  overflowX='auto',initialLeft=0,block='',pixels='opaque',canvasStyle={},ancestorStyle={}}={}){
  const root=geometryElement(geometryBox(0,0,800,600)),container=geometryElement(geometryBox(0,0,600,500),root);
  root.scrollLeft=0;container.scrollLeft=initialLeft;container.clientWidth=visibleWidth;container.scrollWidth=800;container.scrollHeight=1000;
  const canvas=geometryElement(geometryBox(0,0,canvasWidth,1000),container),calls=[];
  canvas.getBoundingClientRect=()=>geometryBox(-container.scrollLeft,0,canvasWidth,1000);
  canvas.width=backingWidth;canvas.height=backingHeight;
  let mode=pixels;
  canvas.getContext=()=>({getImageData:(x,y,width,height)=>{
    calls.push({x,y,width,height});
    if(mode==='tainted')throw Error('tainted');
    const data=new Uint8ClampedArray(width*height*4);data.fill(mode==='transparent'?0:255);
    if(mode==='ink')data[(height-1)*width*4]=0;
    if(mode==='stripes')for(let row=0;row<height;row++)data[(row*width)*4]=0;
    if(mode==='alpha')data[3]=127;
    return {data};
  }});
  const document={body:root,scrollingElement:root,hasFocus:()=>true,querySelectorAll:()=>[canvas],
    elementFromPoint:(x,y)=>{
      if(x<0||x>=visibleWidth||y<0||y>=500)return null;
      if(block==='start'&&x<25&&y<25||block==='end'&&x>visibleWidth-30&&y>475)return {overlay:true};
      return canvas;
    }};
  canvas.hasAttribute=()=>true;canvas.focus=()=>{document.activeElement=canvas;};
  const window={};window.top=window;
  const context=vm.createContext({window,document,innerWidth:800,innerHeight:600,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:element=>({...geometryStyle,...(element===container?{overflowX,overflowY:'auto',...ancestorStyle}:
      element===root?{overflowX:'hidden',overflowY:'hidden'}:canvasStyle)})});
  const inspect=vm.runInContext('('+inspectCopyFrame.toString()+')',context);
  return {inspect,canvas,container,document,calls,setPixels:value=>{mode=value;}};
}

test('logical viewport start survives a blocked legacy corner while text anchors remain hit-tested',()=>{
  const f=marginCanvasFrame({visibleWidth:600,block:'start'}),surface=f.inspect('focus');
  assert.deepEqual({...surface.start},{x:10,y:10});assert.equal(surface.startHit,false);assert.equal(surface.endHit,true);
  assert.equal(surface.diagnostics.reason,'ok');
  assert.equal(f.inspect('selection-points',[{id:1,x:.2,y:.05,left:.19,top:.04,right:.25,bottom:.07}]).length,1);
  const blocked=marginCanvasFrame({visibleWidth:600,block:'end'}).inspect('focus');
  assert.equal(blocked.end,null);assert.equal(blocked.diagnostics.reason,'end_hit_missing');
});

test('blank clipped margins require a uniform full-height strip including two inner CSS pixels',()=>{
  for(const pixels of ['opaque','transparent']){
    const f=marginCanvasFrame({pixels}),surface=f.inspect('focus');
    assert.equal(surface.contentWidthVisible,true);assert.equal(surface.diagnostics.clipRight,15);
    assert.equal(surface.diagnostics.marginProof.right,true);
    assert.equal(surface.diagnostics.marginReason.right,pixels==='opaque'?'uniform_opaque':'transparent');
    assert.deepEqual(f.calls,[{x:583,y:0,width:17,height:1000}]);
    f.setPixels('ink');const changed=f.inspect('probe');
    assert.equal(changed.contentWidthVisible,false);assert.equal(changed.diagnostics.marginReason.right,'nonuniform');
    assert.equal(f.calls.length,2,'a later repaint must be read again');
  }
});

test('blank margin proof rejects offscreen ink, column-wise uniform stripes, alpha and tainted readback',()=>{
  for(const pixels of ['ink','stripes','alpha','tainted']){
    const f=marginCanvasFrame({pixels}),surface=f.inspect('focus');
    assert.equal(surface.contentWidthVisible,false,pixels);assert.equal(surface.diagnostics.reason,'width_clipped');
    assert.equal(surface.diagnostics.marginProof.right,false);
    assert.equal(f.calls[0].height,1000,'proof includes the unshown lower half');
  }
});

test('blank margins conservatively map fractional CSS clipping at DPR 2 and enforce width/pixel budgets',()=>{
  const fractional=marginCanvasFrame({visibleWidth:584.75,backingWidth:1200,backingHeight:2000});
  assert.equal(fractional.inspect('focus').contentWidthVisible,true);
  assert.deepEqual(fractional.calls,[{x:1165,y:0,width:35,height:2000}]);
  const wide=marginCanvasFrame({visibleWidth:567});
  assert.equal(wide.inspect('focus').diagnostics.marginReason.right,'too_wide');assert.equal(wide.calls.length,0);
  const large=marginCanvasFrame({backingHeight:60001});
  assert.equal(large.inspect('focus').diagnostics.marginReason.right,'budget');assert.equal(large.calls.length,0);
  const normal=marginCanvasFrame({visibleWidth:598,pixels:'ink'});
  assert.equal(normal.inspect('focus').contentWidthVisible,true);assert.equal(normal.calls.length,0,'existing 2 CSS rounding tolerance is unchanged');
});

test('blank margin exceptions reject transformed ancestors and nontrivial canvas box mapping',()=>{
  for(const ancestorStyle of [{rotate:'2deg'},{perspective:'500px'},{scale:'-1 1'},{transform:'skewX(2deg)'}]){
    const f=marginCanvasFrame({ancestorStyle}),surface=f.inspect('focus');
    assert.equal(surface.contentWidthVisible,false);assert.equal(surface.diagnostics.marginReason.right,'transform');assert.equal(f.calls.length,0);
  }
  for(const canvasStyle of [{borderRightWidth:'1px'},{borderLeftWidth:'100px'},
    {paddingTop:'1px'},{paddingLeft:'2px'},{objectFit:'contain'}]){
    const f=marginCanvasFrame({canvasStyle}),surface=f.inspect('focus');
    assert.equal(surface.contentWidthVisible,false);assert.equal(surface.diagnostics.marginReason.right,'box_model');assert.equal(f.calls.length,0);
  }
});

test('horizontal alignment scrolls only bound auto owners and cleanup restores their original scrollLeft',()=>{
  const f=marginCanvasFrame({canvasWidth:500,visibleWidth:600,initialLeft:50,pixels:'ink'});
  assert.equal(f.inspect('align-horizontal'),null,'alignment requires an existing pinned session');
  assert.equal(f.inspect('focus').contentWidthVisible,false);
  assert.equal(f.inspect('align-horizontal').contentWidthVisible,true);assert.equal(f.container.scrollLeft,0);
  f.inspect('cleanup');assert.equal(f.container.scrollLeft,50);
  const hidden=marginCanvasFrame({canvasWidth:500,visibleWidth:600,initialLeft:50,overflowX:'hidden',pixels:'ink'});
  hidden.inspect('focus');hidden.inspect('align-horizontal');assert.equal(hidden.container.scrollLeft,50);
});

test('tail probe extends only to lower points that still hit the same canvas',()=>{
  const inspectFor=visibleBottom=>{
    const container={isConnected:true,scrollTop:0,clientHeight:700,clientWidth:600,
      clientTop:0,clientLeft:0,offsetWidth:600,offsetHeight:700,scrollHeight:700,
      parentElement:null,getBoundingClientRect:()=>({left:0,top:0,width:600,height:700})};
    const canvas={parentElement:container,getBoundingClientRect:()=>({left:0,top:0,right:600,bottom:800,width:600,height:800}),
      hasAttribute:()=>true,focus:()=>{document.activeElement=canvas;}};
    const document={body:{innerText:''},hasFocus:()=>true,querySelectorAll:()=>[canvas],
      elementFromPoint:(x,y)=>x>=0&&x<600&&y>=0&&y<=visibleBottom?canvas:null,
      scrollingElement:{scrollTop:0,clientHeight:900,scrollHeight:900}};
    const window={};window.top=window;
    const context=vm.createContext({window,document,innerWidth:600,innerHeight:900,
      location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
      getComputedStyle:element=>element===canvas?{visibility:'visible',opacity:'1'}:
        {overflowY:'hidden'}});
    return vm.runInContext(`(${inspectCopyFrame.toString()})`,context);
  };
  const visible=inspectFor(780);
  assert.equal(visible('focus').end.y,690);
  assert.ok(visible('tail-point').y>=760);
  const blocked=inspectFor(700);
  blocked('focus');
  assert.equal(blocked('tail-point'),null);
});

test('uses the viewport clip for the document scroll root after it has moved',()=>{
  const root={parentElement:null,isConnected:true,scrollTop:700,scrollHeight:1500,clientHeight:800,clientWidth:600,
    offsetWidth:600,offsetHeight:1500,clientTop:0,clientLeft:0,
    getBoundingClientRect:()=>({left:0,top:-700,width:600,height:1500})};
  const canvas={parentElement:root,getBoundingClientRect:()=>({left:0,top:-700,right:600,bottom:800,width:600,height:1500}),
    hasAttribute:()=>true,focus:()=>{document.activeElement=canvas;}};
  const document={body:{innerText:''},scrollingElement:root,hasFocus:()=>true,querySelectorAll:()=>[canvas],elementFromPoint:()=>canvas};
  const window={};window.top=window;
  const context=vm.createContext({window,document,innerWidth:600,innerHeight:800,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:element=>element===canvas?{visibility:'visible',opacity:'1'}:{overflowX:'auto',overflowY:'auto'}});
  const inspect=vm.runInContext(`(${inspectCopyFrame.toString()})`,context);
  const result=inspect('focus');
  assert.equal(result.start.y,10);
  assert.equal(result.end.y,790);
  assert.equal(result.contentBottomVisible,true);
  assert.equal(result.scrollTop,700);
});

test('measures a parent iframe scroll owner rather than a nearer auto wrapper with no scroll range',()=>{
  const root={parentElement:null,isConnected:true,scrollTop:0,clientHeight:1500,scrollHeight:1500};
  const near={parentElement:root,isConnected:true,scrollTop:0,clientHeight:1500,scrollHeight:1500,
    clientWidth:550,clientTop:0,clientLeft:0,
    getBoundingClientRect:()=>({left:0,top:0,width:550,height:1500})};
  const background={parentElement:null,isConnected:true,scrollTop:400,clientHeight:800,scrollHeight:3000};
  const shell={parentElement:background};
  const outer={parentElement:shell,isConnected:true,scrollTop:0,clientHeight:500,scrollHeight:1500,
    clientWidth:550,clientTop:0,clientLeft:0,
    getBoundingClientRect:()=>({left:20,top:20,width:550,height:500})};
  const frame={parentElement:outer,isConnected:true,offsetWidth:550,offsetHeight:1500,clientLeft:0,clientTop:0,
    getBoundingClientRect:()=>({left:20,top:20-outer.scrollTop,width:550,height:1500})};
  const attributes=new Map();
  const canvas={parentElement:near,getBoundingClientRect:()=>({left:0,top:0,right:550,bottom:1500,width:550,height:1500}),
    getAttribute:name=>attributes.get(name),hasAttribute:name=>attributes.has(name),
    setAttribute:(name,value)=>attributes.set(name,value),removeAttribute:name=>attributes.delete(name)};
  const document={body:{innerText:''},scrollingElement:root,hasFocus:()=>true,querySelectorAll:()=>[canvas],
    elementFromPoint:()=>canvas};
  canvas.focus=()=>{document.activeElement=canvas;};
  const outerDocument={scrollingElement:background,elementFromPoint:(_x,y)=>y>=20&&y<=520?frame:null};
  frame.ownerDocument=outerDocument;
  const parent={document:outerDocument,innerWidth:800,innerHeight:800,
    getComputedStyle:element=>element===shell?{position:'fixed'}:
      element===frame?{overflowY:'visible'}:{overflowY:'auto'}};
  parent.top=parent;
  const window={parent,top:parent,frameElement:frame};
  const context=vm.createContext({window,document,innerWidth:550,innerHeight:1500,
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
    getComputedStyle:element=>element===canvas?{visibility:'visible',opacity:'1'}:{overflowY:'auto'}});
  const inspect=vm.runInContext('(' + inspectCopyFrame.toString() + ')',context);
  const first=inspect('focus');
  assert.equal(first.scrollMode,'native');
  assert.equal(first.scrollTop,0);
  assert.equal(first.clientHeight,500);
  assert.equal(first.scrollHeight,1500);
  assert.equal(first.scrollChain.length,3);
  assert.equal(first.end.y,510);
  outer.scrollTop=300;
  const advanced=inspect('probe');
  assert.equal(advanced.scrollTop,300);
  assert.equal(advanced.scrollChain[0].scrollTop,0);
  assert.equal(advanced.scrollChain[2].scrollTop,300);
  assert.equal(advanced.end.y,510);
  assert.equal(advanced.contentBottomVisible,false);
  outer.scrollTop=1000;
  const bottom=inspect('probe');
  assert.equal(bottom.scrollTop+bottom.clientHeight,bottom.scrollHeight);
  assert.equal(bottom.contentBottomVisible,true);
  inspect('cleanup');
  assert.equal(outer.scrollTop,0);
  assert.equal(background.scrollTop,400);
});

function fixture({ambiguous=false,leaveAfterSelect=false,leaveAfterScroll=false,textSelection,headerOnly=false,singlePass=false,expandAlreadyDone=false,skipExpansion=false,initial=first,
  pages=[first],selectAll=first,commandsOnly=false,selectAllNeedsDrag=false,folds=[],neverExpands=false,
  clipboardFold=false,staleMarks=[],verifiedMarks=false,visualMatches=0,blockedScroll=false,resetBlocked=false,
  initialIndex=0,missingGeometry=false,advancePages=1,adaptiveStep=false,lazyGrowth=false,unmeasuredScroll=false,
  scrollUnit=null,nativeBottomIndex=null,realisticFocus=false,
  stationary=false,rangeWithoutProgress=false,delayedPageOnce=false,ownerless=false,clippedBottom=false,
  blankUntilDownScroll=false,heldSelectionText=null,withoutSequence=false,copyEventPayload=false,copyWaits=2,discardCopyAfter=Infinity,
  tailEndpoint=null,tailPage=null,wheelTailPage=null,copyTransform=null,surfaceTransform=null,
  foldLabel='查看全部',markLabel=foldLabel,name='',check=()=>{},expandPointTransform=null,expandMarkTransform=null,
  selectionAnchors=true,selectionPointTransform=null,recoverFocus,fitViewport,clipboardReadFailures=0}={}) {
  let left=false, selection='', index=initialIndex, item=initial, sequence=8, pending, dragStart, dragEnd, allSelectionCount=0;
  let wheelTailArmed=false,focusedWindow=30,downScrolled=false,mouseDown=false,heldWheels=0;
  let available=lazyGrowth?1:pages.length;
  const inputs=[], events=[], pauses=[], reports=[];
  let copyWitnessArmed=false,copyWitnessPayload=null,copyWitnessMarker='',copyCount=0,expandChecks=0,selectionChecks=0;
  const lagged=new Set();
  const inspectOwnerless=ownerless?fixedCanvasFrame():null;
  const collapsed=new Set(folds);
  if(clipboardFold)collapsed.add(0);
  const point={x:475,y:225};
  const folded={resume:`${text} … ${foldLabel}`,resume_html:`${markup}<span>${foldLabel}</span>`};
  const tab={id:17, windowId:23, active:true, url:'https://www.zhipin.com/web/chat/search'};
  const surface={focused:true, canvasFocused:true, center:{x:330,y:435}, start:{x:100,y:180}, end:{x:560,y:690}};
  function selectedRange(){
    const page=pages[index];
    return collapsed.has(index) ? {resume:`${page.resume} … ${foldLabel}`,resume_html:`${page.resume_html}<span>${foldLabel}</span>`}
      : tailPage && dragEnd?.y>surface.end.y+16 ? tailPage : wheelTailArmed && wheelTailPage ? wheelTailPage : page;
  }
  const browser={
    windows:{getCurrent:async()=>({id:30}),update:async id=>{focusedWindow=id;events.push(`focus:${id}`);}},
    tabs:{get:async()=>left?{...tab,active:false}:tab},
    scripting:{executeScript:async({target,args,world,func,files})=>{
      if(target.allFrames)return Array.from({length:ambiguous?2:1},(_,i)=>({documentId:`doc${i}`,result:surface}));
      assert.deepEqual(target.documentIds,['doc0']);
      if(func?.name==='observeCopyClipboard'){
        if(args[0]==='arm'){copyWitnessArmed=true;copyWitnessPayload=null;copyWitnessMarker='<!--hrm-copy:'+args[1]+'-->';return [{result:true}];}
        if(args[0]==='cleanup'){copyWitnessArmed=false;copyWitnessPayload=null;return [{result:null}];}
        return [{result:copyWitnessPayload}];
      }
      if(files){
        assert.deepEqual(files,['canvas-expand.js']);assert.equal(world,'MAIN');
        events.push('install-expand');return [];
      }
      if(func?.name==='canvasSelectionAnchors'){
        events.push('selection-anchors');
        return [{result:selectionAnchors?[{id:index+100,x:.22,y:.025,left:.21,top:.01,right:.25,bottom:.04}]:[]}];
      }
      if(func?.name==='canvasVerifiedExpandMarks'){
        events.push('verified-expand');
        const present=verifiedMarks&&folds.includes(index)&&collapsed.has(index);
        const marks=present?[{id:index+1,label:markLabel,x:.75,y:.2}]:[];
        return [{result:expandMarkTransform?expandMarkTransform(marks,'main'):marks}];
      }
      if(world==='MAIN'){
        const present=(folds.includes(index)&&collapsed.has(index))||staleMarks.includes(index);
        return [{result:present?[{id:index+1,label:markLabel,x:.75,y:.2}]:[]}];
      }
      if(func?.name==='visualExpandMarks'){
        events.push('visual');
        const marks=collapsed.has(index)?Array.from({length:visualMatches},(_,i)=>(
          {id:0,label:'查看全部',x:.75-i*.1,y:.2})):[];
        return [{result:expandMarkTransform?expandMarkTransform(marks,'visual'):marks}];
      }
      if(args[0]==='selection-points'){
        const points=args[1].map(mark=>({mark,point:{x:200,y:190}}));
        selectionChecks++;
        return [{result:selectionPointTransform?selectionPointTransform(points,selectionChecks):points}];
      }
      if(args[0]==='expand-points'){
        const points=args[1].map(mark=>({mark,point}));
        expandChecks++;
        return [{result:expandPointTransform?expandPointTransform(points,expandChecks):points}];
      }
      if(args[0]==='tail-point')return [{result:tailEndpoint}];
      events.push(args[0]);
      if(realisticFocus&&args[0]==='probe')events.push(`probe-window:${focusedWindow}`);
      if(inspectOwnerless)return [{result:inspectOwnerless(args[0])}];
       const unit=scrollUnit??300, ownerTop=Math.min(index,nativeBottomIndex??index)*unit,
         ownerHeight=510+(nativeBottomIndex??available-1)*unit;
       const observed={...surface,focused:!realisticFocus||focusedWindow===tab.windowId,
         scrollMeasured:!missingGeometry,scrollMode:stationary?'stationary':'native',
        contentBottomVisible:!clippedBottom,
         scrollTop:unmeasuredScroll||stationary||rangeWithoutProgress?0:ownerTop,clientHeight:510,
         scrollHeight:unmeasuredScroll||stationary?510:rangeWithoutProgress?1510:ownerHeight,
         ...(scrollUnit===null?{}:{scrollChain:[{index:0,scrollTop:ownerTop,clientHeight:510,scrollHeight:ownerHeight}]})};
       return [{result:surfaceTransform?surfaceTransform({surface:observed,count:copyCount,index,action:args[0]}):observed}];
    }},
    debugger:{attach:async target=>{assert.equal(target.tabId,tab.id);events.push('attach');},
      detach:async()=>events.push('detach'),sendCommand:async(_,method,params)=>{
        inputs.push({method,...params});
        if(params.commands?.includes('selectAll')){
          if(!selectAllNeedsDrag||selection==='drag'||selection==='held')selection='all';
          allSelectionCount++;
          if(leaveAfterSelect)left=true;
        }
        if(params.type==='mouseWheel'){
          if(mouseDown&&params.buttons===1&&params.deltaY>0)heldWheels++;
          if(params.deltaY<0){wheelTailArmed=false;if(!resetBlocked)index=0;}
          else if(!blockedScroll){
            downScrolled=true;
            if(leaveAfterScroll)left=true;
            if(wheelTailPage&&index===available-1)wheelTailArmed=true;
            if(lazyGrowth&&index===available-1)available=pages.length;
            index=Math.min(index+(adaptiveStep&&params.deltaY>250?2:advancePages),available-1);
          }
        }
        if(params.type==='mousePressed'){
          dragStart={x:params.x,y:params.y};mouseDown=true;heldWheels=0;
        }
        if(params.type==='mouseReleased'){
          const click=params.x===dragStart.x&&params.y===dragStart.y;
          if(click&&params.x>=446&&params.x<=508&&params.y>=225&&params.y<=241){
            events.push(`expand:${index}`);
            if(!neverExpands)collapsed.delete(index);
          }else {selection=heldWheels?'held':'drag';dragEnd={x:params.x,y:params.y};}
          mouseDown=false;
        }
        if(params.type==='rawKeyDown'&&params.key==='c'&&(!commandsOnly||params.commands?.includes('copy'))){
          events.push(`copy:${index}`);
          const whole=typeof selectAll==='function'?selectAll(collapsed,allSelectionCount):selectAll;
          const heldText=typeof heldSelectionText==='function'?heldSelectionText(collapsed):heldSelectionText;
          let next=selectAllNeedsDrag&&!selection?null:selection==='held'&&heldText?heldText:
            selection==='drag'?selectedRange():clipboardFold&&collapsed.size?folded:whole;
          if(selection==='drag' && delayedPageOnce && index && !lagged.has(index)){
            next=pages[index-1];lagged.add(index);
          }
          if(blankUntilDownScroll&&!downScrolled)next=null;
          if(next){
            copyCount++;
            if(copyTransform)next=copyTransform({page:next,count:copyCount,index,selection});
            if(copyWitnessArmed && copyEventPayload){
              const payload=copyEventPayload===true?next:copyEventPayload;
              copyWitnessPayload={...payload,marker:copyWitnessMarker};
              if(copyEventPayload===true)next={...next,
                resume_html:(next.resume_html || '<pre>'+next.resume+'</pre>')+copyWitnessMarker};
            }
            if(copyCount<=discardCopyAfter)pending={next,waits:copyWaits};
          }
        }
      }}
  };
  const clipboard={read:async()=>{
    if(copyCount && clipboardReadFailures>0){
      clipboardReadFailures--;events.push('clipboard-denied');
      const error=Error('Document is not focused');error.name='NotAllowedError';throw error;
    }
    return [{types:['text/plain','text/html'],getType:async type=>({text:async()=>
      type==='text/html'?item.resume_html:item.resume})}];
  }};
  const pause=async milliseconds=>{
    pauses.push(milliseconds);
    if(pending&&--pending.waits===0){
      assert.equal(events.findLast(event=>event.startsWith('focus:')),'focus:23');
      item=pending.next;
      sequence++;
      pending=null;
    }
  };
  return {inputs,events,pauses,reports,run:()=>copyOpenResume({browser,clipboard,clipboardSequence:async()=>withoutSequence?null:sequence,tab,textSelection,headerOnly,singlePass,expandAlreadyDone,skipExpansion,name,recoverFocus,fitViewport,report:message=>reports.push(message),pause,check})};
}

test('favorite identity reads only the first viewport without expanding or reading the tail',async()=>{
  const f=fixture({headerOnly:true,pages:[first,tail],initialIndex:1});
  const result=await f.run();
  assert.equal(result.selection,'header');assert.equal(result.resume,first.resume);
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,0);
  assert.ok(!f.inputs.some(input=>input.commands?.includes('selectAll')));
  assert.ok(f.events.includes('cleanup'));
});

test('favorite header copy rejects a top reset that did not reach the header',async()=>{
  const f=fixture({headerOnly:true,pages:[first,tail],initialIndex:1,resetBlocked:true});
  await assert.rejects(f.run(),/页首/);
});

test('copy loop caps a short measured scroll by the scrollbar remainder',async()=>{
  const f=fixture({pages:[first,tail],scrollUnit:40});
  const result=await f.run();
  const forward=f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0);
  assert.equal(forward[0]?.deltaY,40);
  assert.equal(result.issue,'');
  assert.equal(result.screens,2);
  assert.match(result.resume,/虚构大学本科/);
  assert.equal(result.completeness.allScreensRead,true);
});

test('copy loop verifies actual progress when a wheel moves less than requested',async()=>{
  const middle=copiedPage('独立的中间工作经历。');
  const f=fixture({pages:[first,middle,tail],scrollUnit:300});
  const result=await f.run();
  const forward=f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0);
  assert.equal(forward[0]?.deltaY,306);
  assert.equal(result.issue,'');
  assert.equal(result.screens,3);
  assert.match(result.resume,/中间工作经历/);
  assert.match(result.resume,/虚构大学本科/);
  assert.equal(result.completeness.allScreensRead,true);
});

test('native scrolling recopies a delayed viewport before treating the previous text as final',async()=>{
  const f=fixture({pages:[first,tail],selectAll:first,delayedPageOnce:true});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.match(result.resume,/教育经历/);
  assert.ok(f.events.filter(event=>event==='copy:1').length>=2);
});

test('a repeated final viewport is valid only when it already contains the terminal footer',async()=>{
  const headed=copiedPage('张**\n工作经历\n'+overlapA);
  const ending=copiedPage('教育经历\n测试大学本科。\n'+privacyFooter);
  const f=fixture({pages:[headed,ending,ending],selectAll:headed});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.match(result.resume,/教育经历/);
});

test('a stale final viewport needs a verified complete select-all before it can finish',async()=>{
  const headed=copiedPage('张**\n工作经历\n'+overlapA);
  const complete=copiedPage(headed.resume+'\n教育经历\n测试大学本科。\n'+privacyFooter);
  const f=fixture({pages:[headed,headed],selectAll:(_,count)=>count>1?complete:headed});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(result.resume,complete.resume);
});

test('a stale final viewport without the footer remains incomplete after bottom retry',async()=>{
  const headed=copiedPage('张**\n工作经历\n'+overlapA);
  const f=fixture({pages:[headed,headed],selectAll:headed});
  const result=await f.run();
  assert.match(result.issue,/剪贴板仍是上一屏/);
  assert.equal(result.completeness.allScreensRead,false);
});

test('an unread first viewport scrolls down once and retries from the verified top',async()=>{
  const f=fixture({pages:[first,tail],blankUntilDownScroll:true});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(result.screens,2);
  assert.match(result.resume,/工作经历/);
  assert.match(result.resume,/教育经历/);
  assert.ok(f.inputs.some(input=>input.type==='mouseWheel'&&input.deltaY>0));
  assert.ok(f.events.indexOf('copy:1')>=0 && f.events.indexOf('copy:1')<f.events.lastIndexOf('copy:0'));
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY<0).length,2);
});

test('a blocked first-screen scroll cannot turn an unread viewport into a resume',async()=>{
  const f=fixture({pages:[first,tail],blankUntilDownScroll:true,blockedScroll:true});
  await assert.rejects(f.run(),/未确认剪贴板/);
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,1);
});

test('accepts a fresh write with identical text and HTML, after waiting in the intended tab',async()=>{
  const f=fixture();
  assert.deepEqual(await f.run(),{...first,selection:'scroll-drag',screens:1,issue:'',
    completeness:{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true}});
  assert.deepEqual(f.inputs.flatMap(input=>input.commands||[]),['selectAll']);
  assert.ok(f.inputs.some(input=>input.type==='rawKeyDown'&&input.code==='ControlLeft'));
  assert.ok(f.inputs.some(input=>input.type==='keyUp'&&input.code==='ControlLeft'));
  assert.ok(f.inputs.some(input=>input.type==='mouseWheel'&&input.deltaY<0));
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,1);
  assert.deepEqual(f.events.slice(-3),['detach','cleanup','focus:30']);
});

test('copies the selected DOM resume range without selecting the surrounding page',async()=>{
  const selection=[];
  const f=fixture({textSelection:{select:async()=>{selection.push('select');return true;},
    focused:async()=>true,clear:async()=>selection.push('clear')}});
  const result=await f.run();
  assert.equal(result.selection,'text-range');
  assert.deepEqual(f.inputs.flatMap(input=>input.commands||[]),['copy']);
  assert.deepEqual(selection,['select','clear']);
  assert.ok(f.events.includes('detach'));
});

test('copies the tail with its formatting even when Ctrl+A already returned valid-looking text',async()=>{
  for(const selectAll of [first,null]){
    const f=fixture({selectAll,pages:[first,tail]});
    const result=await f.run();
    assert.equal(result.selection,'scroll-drag');
    assert.equal(result.screens,2);
    assert.equal(result.issue,'');
    assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
    assert.equal(result.resume,`${text}\n\n${tail.resume}`);
    assert.match(result.resume_html,/<strong>.+<\/strong>.*<hr>.*<em>虚构大学本科/);
    assert.ok(f.inputs.some(input=>input.type==='mouseWheel'&&input.deltaY>0));
    assert.ok(f.inputs.some(input=>input.type==='mousePressed'&&input.x===200&&input.y===190));
    assert.ok(f.inputs.some(input=>input.type==='mouseReleased'&&input.x===560&&input.y===690));
    assert.ok(f.events.includes('detach'));
  }
});

test('retries with the native copy command when the shortcut alone does not write',async()=>{
  const f=fixture({commandsOnly:true});
  assert.equal((await f.run()).issue,'');
  assert.ok(f.inputs.some(input=>input.commands?.includes('copy')));
});

test('expands a visible fold once, even if the canvas keeps returning its old mark',async()=>{
  const f=fixture({folds:[0],staleMarks:[0]});
  const result=await f.run();
  assert.deepEqual(f.events.filter(event=>event==='expand:0'),['expand:0']);
  assert.deepEqual(f.events.filter(event=>event==='expand:0'||event==='copy:0').slice(0,3),['copy:0','expand:0','copy:0']);
  assert.equal(result.issue,'');
  assert.doesNotMatch(result.resume,/查看全部/);
});

test('copies dynamic honor content only after one exact full-label expansion and a fresh verification',async()=>{
  const page=copiedPage('张**\n所获荣誉\n自动化项目技术创新奖，负责算法方案设计并完成工业设备现场交付。\n语言能力\n英语熟练。\n'+privacyFooter);
  const f=fixture({stationary:true,pages:[page],selectAll:page,folds:[0],
    foldLabel:'展开全部 16 个所获荣誉',markLabel:'展开全部16个所获荣誉'});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(f.events.filter(event=>event==='expand:0').length,1);
  assert.doesNotMatch(result.resume,/展开全部/);
  assert.match(result.resume,/技术创新奖/);
});

test('a different dynamic count is not substituted for the copied fold control',async()=>{
  const f=fixture({folds:[0],foldLabel:'展开全部16个所获荣誉',markLabel:'展开全部8个所获荣誉'});
  const result=await f.run();
  assert.match(result.foldIssue,/未确认当前屏的展开控件位置/);
  assert.equal(f.events.filter(event=>event==='expand:0').length,0);
  assert.equal(result.completeness.allScreensRead,false);
});

test('a dynamic honor control that stays folded is clicked only once and cannot pass completeness',async()=>{
  const f=fixture({folds:[0],foldLabel:'查看全部3项荣誉',neverExpands:true});
  const result=await f.run();
  assert.match(result.foldIssue,/未确认展开/);
  assert.equal(f.events.filter(event=>event==='expand:0').length,1);
  assert.equal(result.completeness.allScreensRead,false);
});

test('discards the early all-selection when a lower screen has an expandable section',async()=>{
  const folded={resume:`${text} 查看全部`,resume_html:`${markup}<span>查看全部</span>`};
  const f=fixture({folds:[1],pages:[first,tail],selectAll:collapsed=>collapsed.size?folded:first});
  const result=await f.run();
  assert.deepEqual(f.events.filter(event=>event==='expand:1'||event==='copy:1').slice(0,3),['copy:1','expand:1','copy:1']);
  assert.doesNotMatch(result.resume,/查看全部/);
  assert.match(result.resume,/教育经历/);
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY<0).length,2);
  assert.equal(result.completeness.allScreensRead,true);
});

test('tries a confirmed control once and pauses when the fold did not open',async()=>{
  const f=fixture({folds:[0],neverExpands:true});
  const result=await f.run();
  assert.match(result.foldIssue,/已定位并点击.*未确认展开/);
  assert.equal(result.completeness.allScreensRead,false);
  assert.equal(result.completeness.bottomVerified,false);
  assert.equal(f.events.filter(event=>event==='expand:0').length,1);
  assert.equal(f.events.filter(event=>event==='copy:0').length,2);
  assert.ok(f.events.includes('detach'));
});

test('copies an already-expanded resume without touching old canvas marks',async()=>{
  const folded={resume:`${first.resume} … 查看全部`,resume_html:`${first.resume_html}<span>查看全部</span>`};
  const f=fixture({staleMarks:[0,1],pages:[first,tail],selectAll:folded});
  const result=await f.run();
  assert.ok(!f.events.some(event=>event.startsWith('expand:')));
  assert.equal(result.foldIssue,undefined);
  assert.equal(result.issue,'');
  assert.equal(result.resume,`${first.resume}\n\n${tail.resume}`);
  assert.match(result.resume_html,/<em>虚构大学本科/);
});

test('pauses after a single copy when no visible control matches the folded text',async()=>{
  const missing=fixture({clipboardFold:true});
  assert.match((await missing.run()).foldIssue,/未确认当前屏的展开控件位置/);
  assert.ok(!missing.events.includes('expand:0'));
  assert.equal(missing.events.filter(event=>event==='copy:0').length,1);
});

test('uses a unique visual match once when the canvas paint hook misses the control',async()=>{
  const f=fixture({clipboardFold:true,visualMatches:1});
  const result=await f.run();
  assert.equal(f.events.filter(event=>event==='expand:0').length,1);
  assert.equal(f.events.filter(event=>event==='visual').length,2);
  assert.equal(result.foldIssue,undefined);
  assert.equal(result.resume,first.resume);
});

test('pauses when two visual matches compete for one copied control',async()=>{
  const f=fixture({clipboardFold:true,visualMatches:2});
  assert.match((await f.run()).foldIssue,/未确认当前屏的展开控件位置/);
  assert.ok(!f.events.includes('expand:0'));
});

test('flags missing or repeated content after a measured scroll',async()=>{
  for(const next of [null,first]){
    const result=await fixture({pages:[first,next]}).run();
    assert.equal(result.screens,1);
    assert.match(result.issue,/第 2 屏/);
    assert.equal(result.completeness.allScreensRead,false);
    assert.equal(result.completeness.bottomVerified,false);
  }
});

test('verifies every measured screen in a long resume and requires two stable bottom reads',async()=>{
  const pages=Array.from({length:5},(_,index)=>({
    resume:`${index===0?text+'\n':''}第 ${index+1} 段独立项目，负责完整的技术方案、开发和现场交付。`,
    resume_html:`<section>${index===0?markup:''}<p>第 ${index+1} 段独立项目</p></section>`,
  }));
  const f=fixture({pages,selectAll:pages[0]});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.screens,5);
  for(let index=1;index<=5;index++)assert.match(result.resume,new RegExp(`第 ${index} 段独立项目`));
  assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,5);
});

test('a blocked scroll at a measured non-bottom cannot certify an unchanged clipboard as a complete resume',async()=>{
  const result=await fixture({pages:[first,tail],blockedScroll:true}).run();
  assert.match(result.issue,/未前进.*尚未到达底部/);
  assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:false,stableBottomReads:0,allScreensRead:false});
});

test('missing geometry, a failed top reset, and skipped scroll coverage all fail completeness verification',async()=>{
  const unknown=await fixture({missingGeometry:true}).run();
  assert.match(unknown.issue,/完整尺寸/);
  assert.equal(unknown.completeness.allScreensRead,false);
  const notTop=await fixture({pages:[first,tail],initialIndex:1,resetBlocked:true}).run();
  assert.match(notTop.issue,/简历顶部/);
  assert.equal(notTop.completeness.topVerified,false);
  const middle={resume:`${text}\n独立的中间工作经历。`,resume_html:`${markup}<p>中间工作经历</p>`};
  const gap=await fixture({pages:[first,middle,tail],advancePages:2}).run();
  assert.match(gap.issue,/滚动跨度超出/);
  assert.equal(gap.completeness.allScreensRead,false);
});

test('lazy growth at an apparent bottom resets the proof and copies newly loaded tail content',async()=>{
  const middle={resume:'独立的中间工作经历。',resume_html:'<p>独立的中间工作经历。</p>'};
  const f=fixture({pages:[first,middle,tail],lazyGrowth:true});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.screens,3);
  assert.match(result.resume,/中间工作经历/);
  assert.match(result.resume,/虚构大学本科/);
  assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,3);
});

test('text changes without measurable scroll progress cannot certify an internally scrolling canvas',async()=>{
  const result=await fixture({pages:[first,tail],unmeasuredScroll:true}).run();
  assert.match(result.issue,/简历顶部|连续|重叠/);
  assert.equal(result.completeness.allScreensRead,false);
  assert.equal(result.completeness.bottomVerified,false);
});

test('virtual redraws prove continuous clipboard text and require two visible terminal copies',async()=>{
  for(const mode of [{stationary:true},{rangeWithoutProgress:true}]){
    const pages=virtualPages();
    const f=fixture({...mode,pages,selectAll:pages[0]});
    const result=await f.run();
    assert.equal(result.issue,'');
    assert.equal(result.screens,3);
    assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
    assert.match(result.resume,/测试大学计算机本科/);
    assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,3);
  }
});

test('a smaller verified scroll bridges repeated text without deleting a real second occurrence',async()=>{
  const bridgeA='第一项目结束前独立完成了相机标定和现场误检排查，并记录了完整的交付数据。';
  const bridgeB='第二项目开始后重新设计视觉检测流程，建立了设备参数复核与质量验收记录。';
  const pages=[
    copiedPage('张**\n个人优势\n'+overlapA+'\n'+bridgeA),
    copiedPage(bridgeA+'\n工作经历\n负责设备调试与算法部署。\n'+bridgeB),
    copiedPage(bridgeB+'\n项目经历\n'+overlapA+'\n教育经历\n测试大学本科。\n'+privacyFooter),
  ];
  const f=fixture({pages,selectAll:pages[0],scrollUnit:150,adaptiveStep:true});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(result.screens,3);
  assert.equal(result.resume.split(overlapA).length-1,2);
  assert.ok(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY<0).length>=2);
});

test('an unresolved long repeated screen is marked for batch skip only when it is the actual read issue',async()=>{
  const repeated=copiedPage('张**\n个人优势\n'+overlapA+'\n第一屏独有结尾。');
  const final=copiedPage('工作经历\n第二屏独有开头。\n'+overlapA+'\n教育经历\n测试大学本科。\n'+privacyFooter);
  const result=await fixture({pages:[repeated,final],selectAll:repeated}).run();
  assert.match(result.issue,/相邻分屏含较长重复文字/);
  assert.equal(result.issueCode,'ambiguous-overlap');
  assert.equal(result.completeness.allScreensRead,false);

  const skippedMiddle=copiedPage('中间屏的独立内容。');
  const otherIssue=await fixture({pages:[repeated,skippedMiddle,final],selectAll:repeated,advancePages:2}).run();
  assert.match(otherIssue.issue,/滚动跨度超出/);
  assert.equal(otherIssue.issueCode,undefined);
});

test('stationary one-screen resumes require the explicit platform terminal',async()=>{
  const short=copiedPage('张**\n'+text);
  const incomplete=await fixture({stationary:true,pages:[short],selectAll:short}).run();
  assert.match(incomplete.issue,/尚未读到平台末尾/);
  assert.equal(incomplete.completeness.allScreensRead,false);
  const complete=copiedPage(short.resume+'\n'+privacyFooter);
  const f=fixture({stationary:true,pages:[complete],selectAll:complete});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.stableBottomReads,2);
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,1);
});

test('a clipped canvas bottom is accepted when the copied screen proves the platform terminal',async()=>{
  const short=copiedPage('李坤坤\n26岁 硕士 1年 在职-月内到岗\n'+text);
  const complete=copiedPage(short.resume+'\n'+privacyFooter);
  const result=await fixture({clippedBottom:true,pages:[complete],selectAll:short,name:'李坤坤'}).run();
  assert.equal(result.issue,'');
  assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
  assert.equal(result.resume,complete.resume);
});

test('a clipped canvas bottom is accepted when complete select-all text covers the screen',async()=>{
  const short=copiedPage('李坤坤\n26岁 硕士 1年 在职-月内到岗\n'+text);
  const complete=copiedPage(short.resume+'\n'+privacyFooter);
  const result=await fixture({clippedBottom:true,pages:[short],selectAll:complete,name:'李坤坤'}).run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(result.resume,complete.resume);
});

test('a clipped canvas bottom still rejects copy without a terminal proof',async()=>{
  const short=copiedPage('李坤坤\n26岁 硕士 1年 在职-月内到岗\n'+text);
  const result=await fixture({clippedBottom:true,pages:[short],selectAll:short,name:'李坤坤'}).run();
  assert.match(result.issue,/尚未复制到完整的简历末尾/);
  assert.equal(result.completeness.allScreensRead,false);
});

test('a clipped bottom retries Ctrl+A after reaching the tail and accepts only a covered full resume',async()=>{
  const short=copiedPage('高燕\n27岁 大专 7年 在职-月内到岗\n工作经历\n视觉设备维护。\n专业技能\n硬件操作 精');
  const complete=copiedPage(short.resume+'通，熟练运用 VisionPro 与 VisionMaster。\n'+privacyFooter);
  const f=fixture({clippedBottom:true,pages:[short],selectAll:(_collapsed,round)=>round===1?short:complete,name:'高燕'});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.resume,complete.resume);
  assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
  assert.equal(f.inputs.flatMap(input=>input.commands||[]).filter(command=>command==='selectAll').length,2);
});

test('a bottom Ctrl+A retry still stops when the copied text omits the tail or mismatches the candidate',async()=>{
  const short=copiedPage('高燕\n27岁 大专 7年 在职-月内到岗\n工作经历\n视觉设备维护。\n专业技能\n硬件操作 精');
  const other=copiedPage('王燕\n27岁 大专 7年 在职-月内到岗\n工作经历\n视觉设备维护。\n专业技能\n硬件操作 精通。\n'+privacyFooter);
  for(const retry of [short,other]){
    const f=fixture({clippedBottom:true,pages:[short],selectAll:(_collapsed,round)=>round===1?short:retry,name:'高燕'});
    const result=await f.run();
    assert.equal(f.inputs.flatMap(input=>input.commands||[]).filter(command=>command==='selectAll').length,2);
    assert.match(result.issue,/尚未复制到完整的简历末尾/);
    assert.equal(result.completeness.allScreensRead,false);
  }
});

test('a lower hit-tested endpoint copies the missing tail twice before accepting',async()=>{
  const short=copiedPage('高燕\n27岁 大专 7年 在职-月内到岗\n工作经历\n视觉设备维护。\n专业技能\n硬件操作 精');
  const complete=copiedPage(short.resume+'通，熟练运用 VisionPro 与 VisionMaster。\n'+privacyFooter);
  const f=fixture({clippedBottom:true,pages:[short],selectAll:short,name:'高燕',
    tailEndpoint:{x:560,y:750},tailPage:complete});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.resume,complete.resume);
  assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
  assert.equal(f.inputs.filter(input=>input.type==='mouseReleased'&&input.y===750).length,2);
});

test('bottom tail retry refuses a blocked endpoint or a recopy without the footer',async()=>{
  const short=copiedPage('高燕\n27岁 大专 7年 在职-月内到岗\n工作经历\n视觉设备维护。\n专业技能\n硬件操作 精');
  for (const options of [{tailEndpoint:null,tailPage:null},
    {tailEndpoint:{x:560,y:750},tailPage:copiedPage(short.resume+'通，熟练运用 VisionPro。')}]) {
    const f=fixture({clippedBottom:true,pages:[short],selectAll:short,name:'高燕',...options});
    const result=await f.run();
    assert.match(result.issue,/尚未复制到完整的简历末尾/);
    assert.equal(result.completeness.allScreensRead,false);
  }
});

test('one bottom wheel probe accepts a stable new clipboard tail with the exact footer',async()=>{
  const short=copiedPage('高燕\n27岁 大专 7年 在职-月内到岗\n工作经历\n视觉设备维护。\n专业技能\n硬件操作 精');
  const complete=copiedPage(short.resume+'通，熟练运用 VisionPro 与 VisionMaster。\n'+privacyFooter);
  const f=fixture({clippedBottom:true,pages:[short],selectAll:short,name:'高燕',wheelTailPage:complete});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.resume,complete.resume);
  assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,1);
});

test('bottom wheel verification accepts fresh copied text after focus returns to the collector window',async()=>{
  const short=copiedPage('张**\n个人优势\n'+text+'\n专业技能\n工业视觉设备调试');
  const complete=copiedPage(short.resume+'与多工位标定。\n'+privacyFooter);
  const f=fixture({clippedBottom:true,pages:[short],selectAll:short,wheelTailPage:complete,realisticFocus:true});
  const result=await f.run();
  assert.ok(f.events.includes('probe-window:30'));
  assert.equal(result.issue,'');
  assert.equal(result.resume,complete.resume);
  assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
});

test('native scrollbar exhaustion continues through multiple verified canvas screens before the footer',async()=>{
  const overlapC='通过独立测试集分析反光部件的漏检分布，调整边缘推理模型和输入参数，建立量产数据回归验证机制。';
  const pages=[...virtualPages().slice(0,2),
    copiedPage(overlapB+'\n项目经历\n负责边缘设备部署、模型压缩及现场验收。\n'+overlapC),
    copiedPage(overlapC+'\n教育经历\n测试大学计算机本科。\n'+privacyFooter)];
  for(const realisticFocus of [false,true]){
    const f=fixture({pages,selectAll:pages[0],scrollUnit:14,nativeBottomIndex:1,clippedBottom:true,realisticFocus});
    const result=await f.run();
    assert.equal(result.issue,'');
    assert.equal(result.screens,4);
    assert.deepEqual(result.completeness,{topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
    assert.match(result.resume,/负责边缘设备部署、模型压缩及现场验收/);
    assert.match(result.resume,/测试大学计算机本科/);
    for(const phrase of [overlapA,overlapB,overlapC,privacyFooter])assert.equal(result.resume.split(phrase).length-1,1);
    assert.ok(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length>=3);
  }
});

test('exhausted native scrollbar still rejects stalled or discontinuous canvas continuation',async()=>{
  const start=virtualPages().slice(0,2);
  const unrelated=copiedPage('工作经历\n不同项目中没有与前屏衔接的内容，不能作为当前候选人的后续文字。\n'+privacyFooter);
  for(const pages of [start,[...start,unrelated]]){
    const f=fixture({pages,selectAll:pages[0],scrollUnit:14,nativeBottomIndex:1,clippedBottom:true,realisticFocus:true});
    const result=await f.run();
    assert.ok(result.issue);
    assert.equal(result.completeness.allScreensRead,false);
    assert.equal(result.completeness.bottomVerified,false);
  }
});

test('one bottom wheel probe stops when the copied tail does not advance',async()=>{
  const short=copiedPage('高燕\n27岁 大专 7年 在职-月内到岗\n工作经历\n视觉设备维护。\n专业技能\n硬件操作 精');
  const f=fixture({clippedBottom:true,pages:[short],selectAll:short,name:'高燕',wheelTailPage:short});
  const result=await f.run();
  assert.match(result.issue,/尚未复制到完整的简历末尾/);
  assert.equal(result.completeness.allScreensRead,false);
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,1);
});

test('one bottom wheel probe rejects an unrelated clipboard tail despite a footer',async()=>{
  const short=copiedPage('高燕\n27岁 大专 7年 在职-月内到岗\n工作经历\n视觉设备维护。\n专业技能\n硬件操作 精');
  const wrong=copiedPage('王燕\n28岁 本科 5年 离职\n工作经历\n其他公司的不同履历。\n'+privacyFooter);
  const f=fixture({clippedBottom:true,pages:[short],selectAll:short,name:'高燕',wheelTailPage:wrong});
  const result=await f.run();
  assert.match(result.issue,/尚未复制到完整的简历末尾/);
  assert.equal(result.completeness.allScreensRead,false);
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,1);
});

test('foreground full-name copy binds both screen and select-all proofs to the expected identity',async()=>{
  const full=copiedPage('唐明鑫 刚刚活跃\n39岁 本科 10年以上 离职-随时到岗\n'+text+'\n'+privacyFooter);
  const result=await fixture({stationary:true,pages:[full],selectAll:full,name:'唐明鑫'}).run();
  assert.equal(result.issue,'');assert.equal(result.completeness.allScreensRead,true);
  assert.equal(result.resume,full.resume);
  for(const actualName of ['唐明鑫伟','庄宇宁']){
    const wrong=copiedPage(full.resume.replace('唐明鑫',actualName));
    const rejected=await fixture({stationary:true,pages:[wrong],selectAll:wrong,name:'唐明鑫'}).run();
    assert.ok(rejected.issue);assert.equal(rejected.completeness.allScreensRead,false);
  }
});

test('ownerless fixed canvas uses the explicit text proof and never treats its viewport alone as a complete resume',async()=>{
  const pages=virtualPages();
  const complete=await fixture({ownerless:true,pages,selectAll:pages[0]}).run();
  assert.equal(complete.issue,'');
  assert.equal(complete.completeness.allScreensRead,true);
  assert.equal(complete.completeness.stableBottomReads,2);
  const noFooter=copiedPage('张**\n'+text);
  const incomplete=await fixture({ownerless:true,pages:[noFooter],selectAll:noFooter}).run();
  assert.match(incomplete.issue,/尚未读到平台末尾/);
  assert.equal(incomplete.completeness.allScreensRead,false);
});

test('a full first Ctrl+A supports ambiguous overlaps but cannot finish before the visible terminal',async()=>{
  const original=virtualPages();
  const pages=[original[0],copiedPage('工作经历\n这段独立经历没有上一屏的连续重叠内容，但已包含在完整全选正文中。'),original[2]];
  const whole=copiedPage(pages.map(page=>page.resume).join('\n'));
  const f=fixture({stationary:true,pages,selectAll:whole});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,3);
  const gap=await fixture({stationary:true,pages:[original[0],original[2]],selectAll:original[0]}).run();
  assert.match(gap.issue,/重叠文字/);
  assert.equal(gap.completeness.allScreensRead,false);
});

test('an explicit platform footer split between overlapping screens still reaches a stable terminal',async()=>{
  const split=privacyFooter.indexOf('未经BOSS');
  const pages=[
    copiedPage('张**\n个人优势\n'+overlapA),
    copiedPage(overlapA+'\n工作经历\n测试公司视觉算法开发。\n'+privacyFooter.slice(0,split)),
    copiedPage(privacyFooter.slice(split-60)),
  ];
  const f=fixture({stationary:true,pages,selectAll:pages[0]});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(result.completeness.stableBottomReads,2);
  assert.equal(pages[2].resume.includes('为妥善保护'),false);
});

test('a delayed virtual redraw is recopied once at the same position before another scroll',async()=>{
  const pages=virtualPages();
  const f=fixture({stationary:true,pages,selectAll:pages[0],delayedPageOnce:true});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(f.events.filter(event=>event==='copy:1').length,2);
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,3);
});

test('a stale bottom screen retries by holding the mouse through scrolling and copies the full text',async()=>{
  const head=copiedPage('张**\n个人优势\n'+overlapA);
  const full=copiedPage(head.resume+'\n工作经历\n测试公司视觉算法开发。\n教育经历\n测试大学本科。\n'+privacyFooter);
  const f=fixture({pages:[head,head],selectAll:head,heldSelectionText:full,name:'张**'});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.resume,full.resume);
  assert.equal(result.completeness.allScreensRead,true);
  let held=false,heldWheels=0;
  for(const input of f.inputs){
    if(input.type==='mousePressed')held=true;
    if(input.type==='mouseWheel'&&input.deltaY>0&&input.buttons===1){
      assert.equal(held,true);
      heldWheels++;
    }
    if(input.type==='mouseReleased')held=false;
  }
  assert.ok(heldWheels>0);
  assert.equal(held,false);
});

test('measured scrolling scans every screen before one held full selection',async()=>{
  const head=copiedPage('张**\n个人优势\n'+overlapA);
  const tail=copiedPage('教育经历\n测试大学本科。\n'+privacyFooter);
  const full=copiedPage(head.resume+'\n工作经历\n测试公司视觉算法开发。\n'+tail.resume);
  const f=fixture({pages:[head,tail],selectAll:head,heldSelectionText:full,name:'张**',scrollUnit:300});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.resume,full.resume);
  assert.equal(result.screens,2);
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(f.inputs.filter(input=>input.type==='mouseReleased').length,3);
  assert.equal(f.inputs.flatMap(input=>input.commands||[]).includes('selectAll'),false);
});

test('scans and expands a lower fold before the held full copy',async()=>{
  const head=copiedPage('张**\n个人优势\n'+overlapA);
  const tail=copiedPage('教育经历\n测试大学本科。\n'+privacyFooter);
  const full=copiedPage(head.resume+'\n工作经历\n测试公司视觉算法开发。\n'+tail.resume);
  const f=fixture({pages:[head,tail],selectAll:head,scrollUnit:300,name:'张**',folds:[1],
    heldSelectionText:collapsed=>collapsed.size?null:full});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.resume,full.resume);
  assert.equal(f.events.filter(event=>event==='expand:1').length,1);
  assert.equal(result.screens,2);
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(f.events.filter(event=>event==='copy:0').length,2);
  const heldWheel=f.inputs.findIndex(input=>input.type==='mouseWheel'&&input.buttons===1);
  const foldClick=f.inputs.findIndex(input=>input.type==='mouseReleased'&&input.x===475&&input.y===225);
  assert.ok(foldClick>=0&&heldWheel>foldClick);
});

test('an expanded first-screen fold goes straight to the held full copy',async()=>{
  const head=copiedPage('张**\n个人优势\n'+overlapA);
  const tail=copiedPage('教育经历\n测试大学本科。\n'+privacyFooter);
  const full=copiedPage(head.resume+'\n工作经历\n测试公司视觉算法开发。\n'+tail.resume);
  const f=fixture({pages:[head,tail],selectAll:head,scrollUnit:300,name:'张**',folds:[0],
    heldSelectionText:collapsed=>collapsed.size?null:full});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.resume,full.resume);
  assert.equal(f.events.filter(event=>event==='expand:0').length,1);
  assert.equal(f.events.filter(event=>event==='copy:1').length,2);
  assert.equal(result.completeness.allScreensRead,true);
});

test('verified native screens reuse the exact body with only one fresh terminal recopy',async()=>{
  for(const withoutSequence of [false,true])for(const lineEnding of ['\n','\r\n']){
    const pages=virtualPages().map(page=>copiedPage(page.resume.replaceAll('\n',lineEnding)));
    const expected=virtualWhole().resume.replaceAll('\n',lineEnding);
    const f=fixture({pages,selectAll:pages[0],scrollUnit:300,name:'张**',
      withoutSequence,copyEventPayload:true,realisticFocus:true});
    const result=await f.run();
    assert.equal(result.issue,'');
    assert.equal(result.screens,3);
    assert.deepEqual(result.completeness,
      {topVerified:true,bottomVerified:true,stableBottomReads:2,allScreensRead:true});
    assert.equal(result.resume,expected);
    assert.equal(result.resume_html,'<pre>'+expected+'</pre>');
    for(const phrase of [overlapA,overlapB,privacyFooter])
      assert.equal(result.resume.split(phrase).length-1,1);
    assert.deepEqual(f.events.filter(event=>event.startsWith('copy:')),
      ['copy:0','copy:1','copy:2','copy:2']);
    assert.equal(f.inputs.filter(input=>input.type==='mouseReleased').length,3);
    assert.equal(f.inputs.filter(input=>input.type==='mousePressed').length,3);
    assert.equal(f.inputs.some(input=>input.type==='mouseWheel'&&input.buttons===1),false);
    assert.equal(f.inputs.some(input=>input.commands?.includes('selectAll')),false);
    assert.doesNotMatch(JSON.stringify(result),/hrm-copy/);
  }
});


test('an inexact raw overlap falls back and produces the same full body as a native reuse',async()=>{
  const original=virtualPages(),whole=virtualWhole();
  const reused=await fixture({pages:original,selectAll:original[0],scrollUnit:300,name:'张**'}).run();
  const contentKey=text=>text.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'');
  for(const changedOverlap of [overlapA.replace('。','！'),overlapA.replace('工业相机','工业 相机')]){
    const pages=[original[0],copiedPage(original[1].resume.replace(overlapA,changedOverlap)),original[2]];
    const f=fixture({pages,scrollUnit:300,name:'张**',heldSelectionText:whole,selectAll:pages[0]});
    const result=await f.run();
    assert.equal(result.issue,'');
    assert.equal(result.completeness.allScreensRead,true);
    assert.equal(result.resume,whole.resume);
    assert.equal(reused.resume,whole.resume);
    assert.equal(contentKey(result.resume),contentKey(reused.resume));
    assert.ok(f.inputs.some(input=>input.type==='mouseWheel'&&input.buttons===1));
    assert.equal(f.events.filter(event=>event.startsWith('copy:')).length,5);
  }
});

test('missing or ambiguous native screen joins require the held full copy',async()=>{
  const original=virtualPages();
  const ambiguous=copiedPage(overlapA+'\n同段描述在两个项目重复出现。\n'+overlapA+'\n'+overlapB);
  for(const pages of [[original[0],original[2]],[original[0],ambiguous,original[2]]]){
    const whole=copiedPage((pages.length===2?original:pages).map(page=>page.resume).join('\n'));
    const f=fixture({pages,scrollUnit:300,name:'张**',heldSelectionText:whole,selectAll:pages[0]});
    const result=await f.run();
    assert.equal(result.resume,whole.resume);
    assert.equal(result.issue,'');
    assert.equal(result.completeness.allScreensRead,true);
    assert.ok(f.inputs.some(input=>input.type==='mouseWheel'&&input.buttons===1));
    assert.equal(f.events.filter(event=>event.startsWith('copy:')).length,pages.length+2);
  }
});

test('reaching native scroll bottom without a complete footer still needs full-copy proof',async()=>{
  const original=virtualPages(),pages=[...original.slice(0,2),
    copiedPage(original[2].resume.replace(privacyFooter,''))];
  const whole=copiedPage(original.map(page=>page.resume).join('\n'));
  const f=fixture({pages,scrollUnit:300,name:'张**',heldSelectionText:whole,selectAll:pages[0]});
  const result=await f.run();
  assert.equal(result.resume,whole.resume);
  assert.equal(result.issue,'');
  assert.ok(f.inputs.some(input=>input.type==='mouseWheel'&&input.buttons===1));
  assert.equal(f.events.filter(event=>event.startsWith('copy:')).length,5);
});

test('changed terminal text prevents scan reuse and requires the verified full fallback',async()=>{
  const pages=virtualPages(),whole=copiedPage(pages.map(page=>page.resume).join('\n'));
  const f=fixture({pages,scrollUnit:300,name:'张**',heldSelectionText:whole,selectAll:pages[0],
    copyTransform:({page,count})=>count===4?copiedPage(page.resume+'\n内容正在重新绘制'):page});
  const result=await f.run();
  assert.equal(result.resume,whole.resume);
  assert.equal(result.issue,'');
  assert.ok(f.inputs.some(input=>input.type==='mouseWheel'&&input.buttons===1));
  assert.equal(f.events.filter(event=>event.startsWith('copy:')).length,6);
});

test('a terminal copy that never reaches the clipboard cannot certify scan reuse',async()=>{
  for(const withoutSequence of [false,true]){
    const pages=virtualPages();
    const f=fixture({pages,scrollUnit:300,name:'张**',selectAll:pages[0],
      withoutSequence,copyEventPayload:true,discardCopyAfter:3});
    await assert.rejects(f.run(),/未确认剪贴板/);
    assert.ok(f.events.includes('detach'));
  }
});

test('native scan reuse rejects a clipped or moved selection range',async()=>{
  for(const changed of [
    surface=>({...surface,contentWidthVisible:false}),
    surface=>({...surface,end:{...surface.end,x:surface.end.x-30}}),
    surface=>({...surface,scrollTop:surface.scrollTop+10,scrollHeight:surface.scrollHeight+10}),
  ]){
    const pages=virtualPages();
    const f=fixture({pages,scrollUnit:300,name:'张**',selectAll:pages[0],
      surfaceTransform:({surface,count})=>count===3?changed(surface):surface});
    const result=await f.run();
    // A full selection or held retry is required; the four-copy fast result
    // must never bypass visibility, range stability, or scroll geometry.
    assert.ok(f.inputs.some(input=>input.commands?.includes('selectAll') ||
      input.type==='mouseWheel'&&input.buttons===1));
    assert.ok(f.events.filter(event=>event.startsWith('copy:')).length>4);
  }
});

test('held-scroll fallback releases the mouse and rejects text without a platform footer',async()=>{
  const head=copiedPage('张**\n个人优势\n'+overlapA);
  const incomplete=copiedPage(head.resume+'\n教育经历\n测试大学本科。');
  const f=fixture({pages:[head,head],selectAll:head,heldSelectionText:incomplete,name:'张**'});
  const result=await f.run();
  assert.match(result.issue,/剪贴板仍是上一屏/);
  assert.equal(result.completeness.allScreensRead,false);
  const pressed=f.inputs.filter(input=>input.type==='mousePressed').length;
  const released=f.inputs.filter(input=>input.type==='mouseReleased').length;
  assert.equal(pressed,released);
});

test('a lower virtual fold invalidates initial whole-copy proof and restarts the text pass from the header',async()=>{
  const pages=virtualPages();
  const whole=copiedPage(pages.map(page=>page.resume).join('\n'));
  const folded=copiedPage(whole.resume+' 查看全部');
  const f=fixture({stationary:true,pages,folds:[1],selectAll:collapsed=>collapsed.size?folded:whole});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.doesNotMatch(result.resume,/查看全部/);
  assert.equal(f.events.filter(event=>event==='expand:1').length,1);
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY<0).length,2);
});

test('rejects a stale clipboard and stops if the active tab changes',async()=>{
  const stale=fixture({selectAll:null,pages:[null]});
  await assert.rejects(stale.run(),/未确认剪贴板/);
  assert.ok(stale.events.includes('detach'));
  const moved=fixture({leaveAfterSelect:true});
  await assert.rejects(moved.run(),/标签页已切换/);
  assert.ok(!moved.inputs.some(input=>input.commands?.includes('copy')));
  assert.ok(moved.events.includes('detach'));
  const ambiguous=fixture({ambiguous:true});
  await assert.rejects(ambiguous.run(),/未确认唯一/);
  assert.ok(!ambiguous.events.includes('attach'));
});

test('LAN copying confirms identical final text from a new matching copy event',async()=>{
  const pages=virtualPages();
  const f=fixture({stationary:true,pages,initial:copiedPage('旧剪贴板'),
    selectAll:pages[0],withoutSequence:true,copyEventPayload:true,copyWaits:1});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.screens,3);
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(result.completeness.stableBottomReads,2);
  assert.match(result.resume,/测试大学计算机本科/);
  assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,3);
});

test('LAN held full selection is verified twice even when both writes contain identical text',async()=>{
  const original=virtualPages(),pages=[original[0],copiedPage('工作经历\n这是缺少相邻重叠的独立项目描述，需要全文复制确认。'),original[2]];
  const whole=copiedPage(pages.map(page=>page.resume).join('\n'));
  const f=fixture({pages,scrollUnit:300,heldSelectionText:whole,
    selectAll:pages[0],withoutSequence:true,copyEventPayload:true,copyWaits:1});
  const result=await f.run();
  assert.equal(result.resume,whole.resume);
  assert.equal(result.issue,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.equal(f.inputs.filter(input=>input.type==='mouseReleased').length,4);
});

test('LAN repeated text without a matching event payload remains unverified',async()=>{
  for(const copyEventPayload of [false,copiedPage('另一次复制的正文')]){
    const f=fixture({pages:[first],selectAll:first,withoutSequence:true,copyEventPayload,copyWaits:1});
    await assert.rejects(f.run(),/未确认剪贴板/);
    assert.ok(f.events.includes('cleanup'));
  }
});

test('LAN waits for an asynchronous changed clipboard when no copy event carries text',async()=>{
  const f=fixture({headerOnly:true,initial:copiedPage('旧剪贴板'),withoutSequence:true,copyWaits:4});
  const result=await f.run();
  assert.equal(result.selection,'header');
  assert.equal(result.resume,first.resume);
});

test('LAN copy evidence does not bypass blocked scrolling or missing platform footer',async()=>{
  const pages=virtualPages();
  for(const options of [
    {pages,stationary:true,blockedScroll:true},
    {pages:[copiedPage('张**\n工作经历\n'+overlapA)],stationary:true},
  ]){
    const f=fixture({...options,selectAll:options.pages[0],withoutSequence:true,
      copyEventPayload:true,copyWaits:1});
    const result=await f.run();
    assert.equal(result.completeness.allScreensRead,false);
    assert.match(result.issue,/没有前进|尚未读到平台末尾/);
  }
});

test('copy witness is scoped to the focused bound canvas and the current attempt',()=>{
  const listeners=new Map(),canvas={isConnected:true};
  const document={activeElement:canvas,hasFocus:()=>true};
  const window={__hrmCopyScroll:{canvas},
    addEventListener:(name,fn)=>listeners.set(name,fn),
    removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const observe=vm.runInNewContext('('+observeCopyClipboard.toString()+')',{
    window,document,location:new URL('https://www.zhipin.com/web/frame/c-resume/')});
  const nonce='12345678-1234-1234-1234-123456789abc';
  const values=new Map([['text/plain','当前正文'],['text/html','<p>当前正文</p>']]);
  const emit=(overrides={})=>listeners.get('copy')?.({isTrusted:true,defaultPrevented:true,
    clipboardData:{getData:type=>values.get(type)||'',setData:(type,value)=>values.set(type,value)},...overrides});
  assert.equal(observe('arm',nonce),true);
  emit({isTrusted:false});
  assert.equal(observe('read'),null);
  emit({defaultPrevented:false});
  assert.equal(observe('read'),null);
  document.activeElement={};
  emit();
  assert.equal(observe('read'),null);
  document.activeElement=canvas;
  emit();
  assert.equal(observe('read').resume,'当前正文');
  assert.equal(values.get('text/plain'),'当前正文');
  assert.equal(values.get('text/html'),'<p>当前正文</p><!--hrm-copy:'+nonce+'-->');
  assert.equal(listeners.size,0);
  assert.equal(observe('arm',nonce),true);
  assert.equal(observe('read'),null);
  emit({clipboardData:{getData:()=>''}});
  assert.equal(observe('read'),null);
  window.__hrmCopyScroll={canvas:{}};
  emit();
  assert.equal(observe('read'),null);
  observe('cleanup');
  assert.equal(listeners.size,0);
  assert.equal(window.__hrmClipboardCopyWitness,undefined);
});

test('LAN payload evidence waits for the delayed write before reading the clipboard',async()=>{
  for(const copyWaits of [2,4]){
    const result=await fixture({headerOnly:true,initial:copiedPage('旧剪贴板'),withoutSequence:true,
      copyEventPayload:true,copyWaits}).run();
    assert.equal(result.resume,first.resume);
    assert.equal(result.selection,'header');
  }
});

test('LAN plain-only native copy verifies repeats without adding HTML to business content',async()=>{
  const plain={resume:first.resume,resume_html:''};
  const result=await fixture({pages:[plain],selectAll:plain,initial:plain,
    withoutSequence:true,copyEventPayload:true}).run();
  assert.equal(result.issue,'');
  assert.equal(result.resume,plain.resume);
  assert.equal(result.resume_html,'');
  assert.equal(result.completeness.allScreensRead,true);
  assert.doesNotMatch(JSON.stringify(result),/hrm-copy/);
});

test('a prior successful LAN marker cannot certify a later copy that leaves the clipboard unchanged',async()=>{
  const result=await fixture({withoutSequence:true,copyEventPayload:true,discardCopyAfter:1}).run();
  assert.notEqual(result.issue,'');
  assert.equal(result.completeness.allScreensRead,false);
  assert.doesNotMatch(JSON.stringify(result),/hrm-copy/);
});

const copyCommands=f=>f.inputs.filter(input=>input.type==='rawKeyDown'&&input.key==='c');

test('single pass selects a native full resume once and performs exactly one fresh copy',async()=>{
  for(const withoutSequence of [false,true]){
    const whole=virtualWhole();
    const f=fixture({singlePass:true,pages:virtualPages(),heldSelectionText:whole,
      selectAll:whole,scrollUnit:300,name:'张**',initial:whole,
      withoutSequence,copyEventPayload:true,realisticFocus:true});
    const result=await f.run();
    assert.equal(result.issue,'');
    assert.equal(result.resume,whole.resume);
    assert.equal(result.resume_html,whole.resume_html);
    assert.equal(result.selection,'single-copy');
    assert.equal(result.copyCount,1);
    assert.equal(result.screens,1);
    assert.deepEqual(result.completeness,
      {topVerified:true,bottomVerified:true,stableBottomReads:1,allScreensRead:true});
    assert.equal(copyCommands(f).length,1);
    assert.equal(f.inputs.filter(input=>input.type==='mousePressed').length,1);
    assert.equal(f.inputs.filter(input=>input.type==='mouseReleased').length,1);
    assert.equal(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).length,2);
    assert.ok(f.inputs.filter(input=>input.type==='mouseWheel'&&input.deltaY>0).every(input=>input.buttons===1));
    assert.equal(f.inputs.some(input=>input.commands?.includes('selectAll')),false);
    assert.doesNotMatch(JSON.stringify(result),/hrm-copy/);
  }
});

test('single pass stationary canvas establishes a selection before select-all and one copy',async()=>{
  const whole=virtualWhole();
  const f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**'});
  const result=await f.run();
  assert.equal(result.resume,whole.resume);
  assert.equal(result.issue,'');
  assert.equal(result.copyCount,1);
  assert.equal(result.completeness.stableBottomReads,1);
  assert.equal(copyCommands(f).length,1);
  assert.equal(f.inputs.filter(input=>input.commands?.includes('selectAll')).length,1);
  assert.equal(f.inputs.filter(input=>input.type==='mousePressed').length,1);
  assert.equal(f.inputs.filter(input=>input.type==='mouseReleased').length,1);
});

test('single pass discovers the identity from the one copied body',async()=>{
  const whole=copiedPage(virtualWhole().resume.replace('张**\n',
    '唐明鑫 刚刚活跃\n39岁 本科 10年以上 离职-随时到岗\n'));
  const f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.deepEqual(result.discoveredIdentity,{name:'唐明鑫',identity:JSON.stringify(['唐明鑫','39岁','本科','10年以上'])});
  assert.equal(copyCommands(f).length,1);
});

test('single pass DOM uses one range copy and leaves full-range proof to its prepared document',async()=>{
  const calls=[],whole=copiedPage('张**\n'+text);
  const f=fixture({singlePass:true,selectAll:whole,name:'张**',
    textSelection:{select:async()=>{calls.push('select');return true;},
      focused:async()=>true,clear:async()=>calls.push('clear')}});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.selection,'single-copy');
  assert.equal(result.copyCount,1);
  assert.equal(result.resume,whole.resume);
  assert.equal(result.completeness,undefined);
  assert.deepEqual(calls,['select','clear']);
  assert.deepEqual(f.inputs.flatMap(input=>input.commands||[]),['copy']);
  assert.equal(copyCommands(f).length,1);
});

test('single pass expands one visually confirmed control with or without a MAIN mark',async()=>{
  for(const marked of [false,true]){
    const whole=virtualWhole();
    const f=fixture({singlePass:true,stationary:true,pages:[whole],name:'张**',
      // The MAIN mark alone is not evidence of the current button pixels.
      visualMatches:1,...(marked?{folds:[0]}:{clipboardFold:true}),
      selectAll:collapsed=>collapsed.size?copiedPage(whole.resume+' 查看全部'):whole});
    const result=await f.run();
    assert.equal(result.issue,'');
    assert.equal(result.resume,whole.resume);
    assert.equal(f.events.filter(event=>event.startsWith('expand:')).length,1);
    assert.ok(f.events.indexOf('expand:0')<f.events.indexOf('copy:0'));
    assert.equal(copyCommands(f).length,1);
  }
});

test('single pass never expands a second control or retries an unsuccessful expansion',async()=>{
  const whole=virtualWhole();
  for(const neverExpands of [false,true]){
    const f=fixture({singlePass:true,pages:virtualPages(),scrollUnit:300,name:'张**',
      folds:neverExpands?[0]:[0,1],neverExpands,visualMatches:1,
      heldSelectionText:collapsed=>collapsed.size?copiedPage(whole.resume+' 查看全部'):whole});
    const result=await f.run();
    assert.match(result.issue,/未展开内容.*手动/);
    assert.ok(result.issue.includes('「查看全部」'));
    assert.equal((result.issue.match(/重试/g)||[]).length,1);
    assert.equal(result.completeness.allScreensRead,false);
    assert.equal(result.copyCount,1);
    assert.equal(f.events.filter(event=>event.startsWith('expand:')).length,1);
    assert.equal(copyCommands(f).length,1);
  }
});

test('single pass leaves ambiguous or moved expand targets untouched and validates one complete copy',async()=>{
  const whole=virtualWhole();
  for(const options of [
    {folds:[0],visualMatches:2},
    {folds:[0],visualMatches:1,expandPointTransform:(points,count)=>count===1?points:
      points.map(item=>({...item,point:{x:item.point.x+20,y:item.point.y}}))},
  ]){
    const f=fixture({...options,singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**'});
    const result=await f.run();
    assert.equal(result.issue,'');
    assert.equal(result.copyCount,1);
    assert.equal(copyCommands(f).length,1);
    assert.equal(f.events.filter(event=>event.startsWith('expand:')).length,0);
    assert.equal(result.completeness.allScreensRead,true);
  }
});

test('multiple MAIN or visual expand marks never bypass copied folds, identity or terminal checks',async()=>{
  const whole=virtualWhole();
  for(const marked of [false,true])for(const [page,issue] of [
    [copiedPage(whole.resume+' 查看全部'),/未展开内容/],
    [copiedPage(whole.resume.replace('张**','李**')),/候选人姓名/],
    [copiedPage(whole.resume.replace(privacyFooter,'')),/完整平台末尾/],
  ]){
    const f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:page,name:'张**',
      folds:[0],verifiedMarks:marked,visualMatches:2,
      ...(marked?{expandPointTransform:points=>points.flatMap(item=>[item,
        {...item,mark:{...item.mark,id:item.mark.id+1},point:{x:item.point.x-80,y:item.point.y}}])}:{})});
    const result=await f.run();assert.match(result.issue,issue);assert.equal(result.copyCount,1);
    assert.equal(result.completeness.allScreensRead,false);assert.equal(copyCommands(f).length,1);
    assert.equal(f.events.some(event=>event.startsWith('expand:')),false);
    if(marked)assert.equal(f.events.includes('visual'),false);
  }
});

test('multiple distinct or duplicated MAIN marks allow one full held copy without guessing a control',async()=>{
  for(const duplicate of [false,true]){
    const f=fixture({singlePass:true,pages:virtualPages(),heldSelectionText:virtualWhole(),scrollUnit:300,
      name:'张**',folds:[0],verifiedMarks:true,visualMatches:1,
      expandPointTransform:points=>points.flatMap(item=>[item,duplicate?item:
        {...item,mark:{...item.mark,id:item.mark.id+1},point:{x:item.point.x-100,y:item.point.y}}])});
    const result=await f.run();assert.equal(result.issue,'');assert.equal(result.copyCount,1);
    assert.equal(copyCommands(f).length,1);assert.equal(f.events.includes('visual'),false);
    assert.equal(f.events.some(event=>event.startsWith('expand:')),false);
  }
});

test('single pass rejects wrong identity, absent metadata, missing footer and folds after only one copy',async()=>{
  const whole=virtualWhole();
  for(const options of [
    {name:'李**',page:whole},
    {name:'',page:whole},
    {name:'张**',page:copiedPage(whole.resume.replace(privacyFooter,''))},
    {name:'张**',page:copiedPage(whole.resume+' 查看全部')},
    {name:'张**',page:copiedPage('张**\n没有章节。\n'+privacyFooter.replaceAll('工作经历','履历').replaceAll('教育经历','学习记录'))},
  ]){
    const f=fixture({singlePass:true,stationary:true,pages:[options.page],selectAll:options.page,name:options.name});
    const result=await f.run();
    assert.ok(result.issue);
    assert.equal(result.completeness.allScreensRead,false);
    assert.equal(result.completeness.stableBottomReads,0);
    assert.equal(result.copyCount,1);
    assert.equal(copyCommands(f).length,1);
  }
});

test('single pass does not issue a second shortcut when its copy command makes no fresh write',async()=>{
  const whole=virtualWhole();
  for(const options of [
    {withoutSequence:true,copyEventPayload:true,discardCopyAfter:0},
    {withoutSequence:true,copyEventPayload:false,initial:whole},
    {withoutSequence:true,copyEventPayload:copiedPage('不匹配的复制事件'),initial:whole},
  ]){
    const f=fixture({...options,singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**'});
    const result=await f.run();
    assert.match(result.issue,/未获得新的简历正文/);
    assert.equal(result.copyCount,1);
    assert.equal(result.completeness.allScreensRead,false);
    assert.equal(copyCommands(f).length,1);
    assert.equal(f.inputs.filter(input=>input.commands?.includes('copy')).length,1);
  }
});

test('single pass refuses blocked or discontinuous native selection and releases the mouse',async()=>{
  for(const options of [{blockedScroll:true},{advancePages:2}]){
    const f=fixture({...options,singlePass:true,pages:virtualPages(),scrollUnit:300,
      heldSelectionText:virtualWhole(),name:'张**'});
    const result=await f.run();
    assert.match(result.issue,/滚动进度/);
    assert.equal(result.copyCount,0);
    assert.equal(copyCommands(f).length,0);
    assert.equal(f.inputs.filter(input=>input.type==='mousePressed').length,1);
    assert.equal(f.inputs.filter(input=>input.type==='mouseReleased').length,1);
  }
});

test('single pass aborts a cancelled or switched tab without a copy and releases held input',async()=>{
  for(const switched of [false,true]){
    let f;
    f=fixture({singlePass:true,pages:virtualPages(),scrollUnit:300,heldSelectionText:virtualWhole(),
      name:'张**',leaveAfterScroll:switched,check:()=>{
        if(!switched&&f.inputs.some(input=>input.type==='mouseWheel'&&input.buttons===1))throw Error('已取消');
      }});
    await assert.rejects(f.run(),switched?/标签页已切换/:/已取消/);
    assert.equal(copyCommands(f).length,0);
    assert.equal(f.inputs.filter(input=>input.type==='mousePressed').length,
      f.inputs.filter(input=>input.type==='mouseReleased').length);
    assert.ok(f.events.includes('detach'));
    assert.ok(f.events.includes('cleanup'));
  }
});

test('single pass rejects clipping or geometry changes without a second clipboard attempt',async()=>{
  const whole=virtualWhole();
  for(const changed of [
    surface=>({...surface,contentWidthVisible:false}),
    surface=>({...surface,end:{...surface.end,x:surface.end.x-30}}),
    surface=>({...surface,scrollHeight:surface.scrollHeight+20}),
  ]){
    const f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
      surfaceTransform:({surface,count})=>count?changed(surface):surface});
    const result=await f.run();
    assert.match(result.issue,/复制期间/);
    assert.equal(result.completeness.allScreensRead,false);
    assert.equal(result.copyCount,1);
    assert.equal(copyCommands(f).length,1);
  }
});

test('single pass uses a safe text anchor even when the old start corner is blocked',async()=>{
  const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
    surfaceTransform:({surface})=>({...surface,startHit:false})});
  assert.equal((await f.run()).issue,'');assert.equal(copyCommands(f).length,1);
  const down=f.inputs.find(input=>input.type==='mousePressed');assert.deepEqual({x:down.x,y:down.y},{x:200,y:190});
});

test('single pass aligns and returns to the top before diagnosing a recoverable initial range',async()=>{
  let aligned=false;
  const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
    surfaceTransform:({surface,action})=>{if(action==='align-horizontal')aligned=true;
      return {...surface,contentWidthVisible:aligned};}});
  assert.equal((await f.run()).issue,'');assert.equal(copyCommands(f).length,1);
  assert.ok(f.events.includes('align-horizontal'));
  assert.ok(f.inputs.some(input=>input.type==='mouseWheel'&&input.deltaY<0));
});

test('one optional viewport fit must actually restore width before a single copy is allowed',async()=>{
  for(const restores of [false,true]){
    let fits=0;
    const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
      fitViewport:async geometry=>{assert.equal(geometry.reason,'width_clipped');fits++;return true;},
      surfaceTransform:({surface})=>({...surface,contentWidthVisible:restores&&fits>0})});
    const result=await f.run();assert.equal(fits,1);
    assert.equal(copyCommands(f).length,restores?1:0);
    if(restores)assert.equal(result.issue,'');
    else{assert.match(result.issue,/左右仍被裁切/);assert.equal(result.diagnostics.reason,'width_clipped');
      assert.equal(f.inputs.filter(input=>input.type==='mousePressed').length,0);}
  }
});

test('specific missing-end and scroll-metric failures never request a viewport fit or copy',async()=>{
  for(const [change,reason] of [[surface=>({...surface,end:null}),'end_hit_missing'],
    [surface=>({...surface,scrollTop:NaN}),'scroll_metrics_invalid']]){
    let fits=0;const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
      fitViewport:async()=>{fits++;return true;},surfaceTransform:({surface})=>change(surface)});
    const result=await f.run();assert.equal(result.diagnostics.reason,reason);assert.equal(fits,0);
    assert.equal(copyCommands(f).length,0);assert.equal(f.inputs.filter(input=>input.type==='mousePressed').length,0);
  }
});

test('thrown selection errors carry only the last geometry without inventing a new failure reason',async()=>{
  const whole=virtualWhole(),diagnostics={reason:'ok',clipLeft:0,clipRight:0,startHit:true,endHit:true};
  const f=fixture({singlePass:true,stationary:true,pages:[whole],name:'张**',selectionAnchors:false,
    surfaceTransform:({surface})=>({...surface,diagnostics})});
  await assert.rejects(f.run(),error=>{assert.match(error.message,/文字起点/);assert.deepEqual(error.diagnostics,diagnostics);return true;});
  assert.equal(copyCommands(f).length,0);
});

test('single pass stops before copying if the page leaves during select-all or the top is hidden',async()=>{
  const whole=virtualWhole();
  const moved=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',leaveAfterSelect:true});
  await assert.rejects(moved.run(),/标签页已切换/);
  assert.equal(copyCommands(moved).length,0);
  const clipped=fixture({singlePass:true,pages:virtualPages(),scrollUnit:300,name:'张**',
    surfaceTransform:({surface})=>({...surface,contentTopVisible:false})});
  const result=await clipped.run();
  assert.match(result.issue,/页首/);
  assert.equal(copyCommands(clipped).length,0);
});

test('single pass never clicks a stale MAIN mark when current pixels show no control',async()=>{
  const whole=virtualWhole();
  const f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
    staleMarks:[0],visualMatches:0});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(result.resume,whole.resume);
  assert.ok(f.events.includes('visual'));
  assert.equal(f.events.filter(event=>event.startsWith('expand:')).length,0);
  assert.equal(copyCommands(f).length,1);
});

test('single pass leaves an uncorroborated current MAIN fold for manual expansion',async()=>{
  const whole=virtualWhole();
  for(const foldLabel of ['查看全部','展开全部16个所获荣誉']){
    const f=fixture({singlePass:true,stationary:true,pages:[whole],name:'张**',
      folds:[0],foldLabel,visualMatches:0,
      selectAll:collapsed=>collapsed.size?copiedPage(whole.resume+' '+foldLabel):whole});
    const result=await f.run();
    assert.match(result.issue,/未展开内容.*手动/);
    assert.equal(result.completeness.allScreensRead,false);
    assert.equal(f.events.filter(event=>event.startsWith('expand:')).length,0);
    assert.equal(copyCommands(f).length,1);
  }
});

test('single pass restores a currently verified dynamic canvas label with one expand and copy',async()=>{
  const whole=virtualWhole();
  const f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
    folds:[0],verifiedMarks:true,visualMatches:0,foldLabel:'查看全部3项项目经历'});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(copyCommands(f).length,1);
  assert.deepEqual(f.events.filter(event=>event.startsWith('expand:')),['expand:0']);
  assert.equal(f.events.filter(event=>event==='verified-expand').length,2);
  assert.equal(f.events.includes('visual'),false);
  assert.equal(f.events.filter(event=>event==='install-expand').length,1);
});

test('a DOM expansion consumes the canvas expansion budget without probing or clicking it again',async()=>{
  const whole=virtualWhole();
  const f=fixture({singlePass:true,expandAlreadyDone:true,stationary:true,pages:[whole],
    selectAll:whole,name:'张**',folds:[0],verifiedMarks:true,visualMatches:1});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(copyCommands(f).length,1);
  assert.equal(f.events.some(event=>event.startsWith('expand:')),false);
  assert.equal(f.events.includes('verified-expand'),false);
  assert.equal(f.events.includes('visual'),false);
});

test('uncertain DOM expansion disables all Canvas expansion probes but still verifies one copied body',async()=>{
  for(const folded of [false,true]){
    const whole=virtualWhole(),f=fixture({singlePass:true,skipExpansion:true,stationary:true,pages:[whole],
      selectAll:folded?copiedPage(whole.resume+' 查看全部'):whole,name:'张**',folds:[0],verifiedMarks:true,visualMatches:1});
    const result=await f.run();assert.equal(copyCommands(f).length,1);assert.equal(result.copyCount,1);
    assert.equal(f.events.some(event=>event.startsWith('expand:')),false);
    assert.equal(f.events.includes('verified-expand'),false);assert.equal(f.events.includes('visual'),false);
    if(folded){assert.match(result.issue,/未展开内容/);assert.equal(result.completeness.allScreensRead,false);}
    else assert.equal(result.issue,'');
  }
});

test('a changed verified label permits one validated copy without using a second expansion source',async()=>{
  const whole=virtualWhole();
  const f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
    folds:[0],verifiedMarks:true,visualMatches:1,
    expandPointTransform:(points,count)=>count===1?points:[]});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(copyCommands(f).length,1);
  assert.equal(f.events.some(event=>event.startsWith('expand:')),false);
  assert.equal(f.events.includes('visual'),false);
});

test('a known MAIN label rejected by visibility mapping never clicks its shorter visual prefix',async()=>{
  for(const folded of [false,true]){
    const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],name:'张**',
      selectAll:folded?copiedPage(whole.resume+' 查看全部3项项目经历'):whole,
      folds:[0],verifiedMarks:true,visualMatches:1,foldLabel:'查看全部3项项目经历',
      expandMarkTransform:(marks,source)=>marks.map(mark=>({...mark,left:.7,top:.18,
        right:source==='main'?.95:.8,bottom:.22})),
      expandPointTransform:points=>points.filter(item=>item.mark.id===0)});
    const result=await f.run();
    assert.equal(copyCommands(f).length,1);assert.equal(result.copyCount,1);
    assert.equal(f.events.some(event=>event.startsWith('expand:')),false);
    assert.equal(f.events.includes('visual'),true);
    if(folded)assert.match(result.issue,/未展开内容/);else assert.equal(result.issue,'');
  }
});

test('an unrelated rejected offscreen MAIN mark leaves one visible visual control eligible',async()=>{
  const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],name:'张**',
    selectAll:whole,folds:[0],verifiedMarks:true,visualMatches:1,
    expandMarkTransform:(marks,source)=>marks.map(mark=>({...mark,left:.7,right:.8,
      top:source==='main'?.8:.18,bottom:source==='main'?.84:.22})),
    expandPointTransform:points=>points.filter(item=>item.mark.id===0)});
  const result=await f.run();assert.equal(result.issue,'');assert.equal(copyCommands(f).length,1);
  assert.deepEqual(f.events.filter(event=>event.startsWith('expand:')),['expand:0']);
});

test('a fresh overlapping MAIN mark or changed visual bbox cancels expansion without cancelling one copy',async()=>{
  for(const changesMain of [true,false]){
    let mainReads=0,visualReads=0;
    const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],name:'张**',
      selectAll:whole,folds:[0],verifiedMarks:true,visualMatches:1,
      expandMarkTransform:(marks,source)=>{
        if(source==='main')mainReads++;else visualReads++;
        const overlapping=changesMain&&mainReads>1;
        return marks.map(mark=>({...mark,left:.7,right:source==='visual'&&!changesMain&&visualReads>1?.81:.8,
          top:source==='main'&&!overlapping?.8:.18,bottom:source==='main'&&!overlapping?.84:.22}));
      },expandPointTransform:points=>points.filter(item=>item.mark.id===0)});
    const result=await f.run();assert.equal(result.issue,'');assert.equal(copyCommands(f).length,1);
    assert.equal(f.events.some(event=>event.startsWith('expand:')),false);
  }
});

test('a new clickable MAIN control elsewhere after visual hover cancels expansion and copies once',async()=>{
  let mainReads=0;
  const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],name:'张**',
    selectAll:whole,folds:[0],verifiedMarks:true,visualMatches:1,
    expandMarkTransform:(marks,source)=>{
      if(source==='main'&&++mainReads===1)return [];
      return marks.map(mark=>({...mark,x:source==='main'?.35:.75,
        left:source==='main'?.3:.7,right:source==='main'?.4:.8,top:.18,bottom:.22}));
    },expandPointTransform:points=>points.map(item=>item.mark.id===0?item:
      {...item,point:{...item.point,x:230}})});
  const result=await f.run();assert.equal(result.issue,'');assert.equal(result.copyCount,1);
  assert.equal(copyCommands(f).length,1);assert.equal(mainReads,2);
  assert.equal(f.events.some(event=>event.startsWith('expand:')),false);
});

test('fresh ambiguous or changed expand labels are never clicked and residual folds still reject the single copy',async()=>{
  for(const change of [points=>[],points=>[...points,...points],
    points=>points.map(item=>({...item,mark:{...item.mark,label:'展开全部'}}))]){
    const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],name:'张**',
      selectAll:copiedPage(whole.resume+' 查看全部'),folds:[0],verifiedMarks:true,visualMatches:1,
      expandPointTransform:(points,count)=>count===1?points:change(points)});
    const result=await f.run();assert.match(result.issue,/未展开内容/);assert.equal(result.copyCount,1);
    assert.equal(copyCommands(f).length,1);assert.equal(result.completeness.allScreensRead,false);
    assert.equal(f.events.some(event=>event.startsWith('expand:')),false);assert.equal(f.events.includes('visual'),false);
  }
});

test('an uncertain hovered expand control must preserve current focus and selection geometry before copying',async()=>{
  for(const changed of [
    surface=>({...surface,focused:false}),
    surface=>({...surface,end:{...surface.end,x:surface.end.x-30}}),
    surface=>({...surface,center:{...surface.center,x:surface.center.x+30}}),
    surface=>({...surface,scrollTop:8,scrollHeight:surface.scrollHeight+8}),
    surface=>({...surface,contentTopVisible:false}),
  ]){
    let hovered=false;
    const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],name:'张**',
      selectAll:whole,folds:[0],verifiedMarks:true,visualMatches:1,
      expandPointTransform:(points,count)=>{if(count===1)return points;hovered=true;return [];},
      surfaceTransform:({surface,action})=>hovered&&action==='probe'?changed(surface):surface});
    const result=await f.run();
    assert.match(result.issue,/焦点|位置|页首|可见范围/);
    assert.equal(result.copyCount,0);assert.equal(copyCommands(f).length,0);
    assert.equal(f.inputs.some(event=>event.type==='mousePressed'),false);
    assert.equal(f.events.includes('visual'),false);
  }
});

test('a short canvas requiring pointer selection and an explicit copy command succeeds in one copy',async()=>{
  const whole=virtualWhole();
  for(const stationary of [true,false]){
    const f=fixture({singlePass:true,stationary,pages:[whole],selectAll:whole,name:'张**',
      selectAllNeedsDrag:true,commandsOnly:true});
    const result=await f.run();
    assert.equal(result.issue,'');
    assert.equal(result.resume,whole.resume);
    assert.equal(copyCommands(f).length,1);
    assert.deepEqual(copyCommands(f)[0].commands,['copy']);
    const release=f.inputs.findIndex(input=>input.type==='mouseReleased');
    const select=f.inputs.findIndex(input=>input.commands?.includes('selectAll'));
    const copy=f.inputs.findIndex(input=>input.type==='rawKeyDown'&&input.key==='c');
    assert.ok(release>=0&&release<select&&select<copy);
  }
});


test('all canvas selection modes start at verified text instead of the avatar corner',async()=>{
  for(const options of [
    {singlePass:true,stationary:true},
    {singlePass:true,pages:virtualPages(),heldSelectionText:virtualWhole(),scrollUnit:300},
    {headerOnly:true},
    {},
  ]){
    const whole=virtualWhole(),f=fixture({pages:[whole],selectAll:whole,name:'张**',...options});
    const result=await f.run();
    assert.ok(!result.issue);
    const presses=f.inputs.filter(event=>event.type==='mousePressed');
    assert.ok(presses.length);
    assert.ok(presses.every(event=>event.x===200&&event.y===190));
    assert.ok(f.events.includes('selection-anchors'));
    if(options.singlePass)assert.equal(copyCommands(f).length,1);
  }
});

test('missing or changed safe text anchors stop without a mouse press or copy',async()=>{
  for(const headerOnly of [false,true]){
    for(const options of [
      {selectionAnchors:false},
      {selectionPointTransform:(points,count)=>count===1?points:[]},
      {selectionPointTransform:(points,count)=>count===1?points:
        points.map(item=>({...item,point:{x:item.point.x+20,y:item.point.y}}))},
    ]){
      const whole=virtualWhole(),f=fixture({singlePass:!headerOnly,headerOnly,stationary:true,
        pages:[whole],selectAll:whole,name:'张**',...options});
      await assert.rejects(f.run(),/文字起点|文字位置/);
      assert.equal(copyCommands(f).length,0);
      assert.equal(f.inputs.filter(event=>event.type==='mousePressed').length,0);
      assert.ok(f.events.includes('detach'));
      assert.ok(f.events.includes('cleanup'));
    }
  }
});

test('selection anchor mapping rejects malformed, clipped, and occluded text geometry',()=>{
  const {inspect,document,canvas}=overflowFixedCanvasFrame({viewportHeight:700});
  inspect('focus');
  const valid={id:1,x:.30,y:.10,left:.29,top:.09,right:.35,bottom:.12};
  const points=inspect('selection-points',[valid]);
  assert.equal(points.length,1);
  assert.deepEqual({...points[0].point},{x:200,y:120});
  for(const bad of [
    {...valid,id:1.1},{...valid,x:NaN},{...valid,y:Infinity},
    {...valid,left:-.1},{...valid,right:1.01},{...valid,top:valid.y},
    {...valid,x:valid.right},{...valid,y:.89,top:.88,bottom:.91},
  ])assert.equal(inspect('selection-points',[bad]).length,0);
  document.elementFromPoint=()=>null;
  assert.equal(inspect('selection-points',[valid]).length,0);
  document.elementFromPoint=()=>canvas;
  inspect('cleanup');
});

test('expand mapping requires complete visible label bounds when a producer provides any bbox field',()=>{
  const {inspect,document,canvas}=overflowFixedCanvasFrame({viewportHeight:700});inspect('focus');
  const valid={id:1,label:'查看全部',x:.3,y:.1,left:.25,top:.08,right:.35,bottom:.13};
  assert.equal(inspect('expand-points',[valid]).length,1);
  const {left,top,right,bottom,...legacy}=valid;
  assert.equal(inspect('expand-points',[legacy]).length,1,'fully absent bounds retain the legacy interface');
  for(const bad of [{...legacy,left:.25},{...valid,right:undefined},{...valid,left:NaN},{...valid,top:Infinity},
    {...valid,left:-.01},{...valid,right:1.01},{...valid,left:valid.x},{...valid,bottom:valid.y},
    {...valid,y:.73,top:.72,bottom:.77},{...valid,left:.4,right:.5}]){
    assert.equal(inspect('expand-points',[bad]).length,0,JSON.stringify(bad));
  }
  // The center still hits the canvas, but the label extends below the viewport.
  const cut={...valid,y:.73,top:.72,bottom:.77};
  assert.equal(inspect('expand-points',[{id:cut.id,label:cut.label,x:cut.x,y:cut.y}]).length,1);
  assert.equal(inspect('expand-points',[cut]).length,0);
  document.elementFromPoint=()=>null;assert.equal(inspect('expand-points',[valid]).length,0);
  document.elementFromPoint=()=>canvas;inspect('cleanup');
});

test('selection anchor mapping applies actual CSS canvas size at different zoom levels',()=>{
  for(const scale of [.67,.8,1,1.25,1.5]){
    const bounds=geometryBox(40,60,600*scale,400*scale);
    const root=geometryElement(geometryBox(0,0,1600,1200));
    const canvas=geometryElement(bounds,root);
    const document={body:root,scrollingElement:root,hasFocus:()=>true,querySelectorAll:()=>[canvas],
      elementFromPoint:(x,y)=>x>=bounds.left&&x<bounds.right&&y>=bounds.top&&y<bounds.bottom?canvas:null};
    canvas.hasAttribute=()=>true;canvas.focus=()=>{document.activeElement=canvas;};
    const window={};window.top=window;
    const context=vm.createContext({window,document,innerWidth:1600,innerHeight:1200,
      location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'},
      getComputedStyle:()=>geometryStyle});
    const inspect=vm.runInContext('('+inspectCopyFrame.toString()+')',context);
    inspect('focus');
    const anchor={id:1,x:.3,y:.1,left:.29,top:.09,right:.35,bottom:.12};
    const point=inspect('selection-points',[anchor])[0].point;
    assert.ok(Math.abs(point.x-(40+180*scale))<.001);
    assert.ok(Math.abs(point.y-(60+40*scale))<.001);
    inspect('cleanup');
  }
});

test('a smaller badge on the same header row never precedes the higher leading name glyph',()=>{
  const inspect=fixedCanvasFrame();inspect('focus');
  const name={id:1,x:.2,y:.075,left:.19,top:.05,right:.25,bottom:.1};
  const badge={id:2,x:.6,y:.07,left:.59,top:.06,right:.65,bottom:.08};
  const points=inspect('selection-points',[badge,name]);
  assert.deepEqual(Array.from(points,item=>item.mark.id),[1,2]);
  inspect('cleanup');
});

test('transient canvas focus failure waits and then performs exactly one copy',async()=>{
  let focusReads=0;
  const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
    surfaceTransform:({surface,action})=>action==='focus'&&++focusReads<=2?null:surface});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(copyCommands(f).length,1);
  assert.equal(f.inputs.filter(event=>event.type==='mousePressed').length,1);
  assert.equal(f.pauses.filter(value=>value===180).length,2);
});

test('focus recovery shares a single bound callback and never replays the expansion or copy',async()=>{
  let blocked=true,recoveries=0,f;
  const whole=virtualWhole();
  f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
    folds:[0],verifiedMarks:true,
    surfaceTransform:({surface,action})=>action==='focus'&&blocked&&f.events.includes('expand:0')?null:surface,
    recoverFocus:async()=>{recoveries++;blocked=false;return true;}});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(recoveries,1);
  assert.equal(f.events.filter(event=>event==='expand:0').length,1);
  assert.equal(copyCommands(f).length,1);
});

test('a newly inconclusive preview check during focus recovery leaves expand controls untouched',async()=>{
  let ready=false;
  const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
    folds:[0],verifiedMarks:true,
    surfaceTransform:({surface,action})=>action==='focus'&&!ready?null:surface,
    recoverFocus:async()=>{ready=true;return {skipExpansion:true};}});
  await f.run();
  assert.equal(ready,true);
  assert.equal(f.events.includes('expand:0'),false);
  assert.equal(copyCommands(f).length,1);
});

test('persistent focus obstruction and changed binding stop after bounded recovery without copying',async()=>{
  for(const changed of [false,true]){
    let recoveries=0;
    const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
      surfaceTransform:({surface,action})=>action==='focus'?null:surface,
      recoverFocus:async()=>{recoveries++;if(changed)throw Error('候选人已切换');return false;}});
    await assert.rejects(f.run(),changed?/候选人已切换/:/简历正文未获得焦点/);
    assert.equal(recoveries,1);
    assert.equal(copyCommands(f).length,0);
    assert.equal(f.inputs.filter(event=>event.type==='mousePressed').length,0);
    assert.ok(f.pauses.filter(value=>value===180).length<=4);
    assert.ok(f.events.includes('detach'));
  }
});

test('delayed real text paint is awaited without repeated pointer movement or copying',async()=>{
  const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
    selectionPointTransform:(points,count)=>count<5?[]:points});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(copyCommands(f).length,1);
  assert.equal(f.pauses.filter(value=>value===150).length,4);
  const pressed=f.inputs.findIndex(event=>event.type==='mousePressed');
  assert.equal(f.inputs.slice(0,pressed).filter(event=>event.type==='mouseMoved').length,1);
});

test('a hover repaint needs a stable fresh witness instead of the invalidated anchor ID',async()=>{
  const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
    selectionPointTransform:(points,count)=>count===1?points:
      points.map(item=>({...item,mark:{...item.mark,id:200}}))});
  const result=await f.run();
  assert.equal(result.issue,'');
  assert.equal(copyCommands(f).length,1);
  assert.equal(f.pauses.filter(value=>value===150).length,1);
});

test('waiting for text still stops immediately on cancellation or changed geometry',async()=>{
  for(const moved of [false,true]){
    let f,probes=0;
    const whole=virtualWhole();
    f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',selectionAnchors:false,
      surfaceTransform:({surface,action})=>moved&&action==='probe'&&++probes>2?
        {...surface,end:{...surface.end,x:surface.end.x+30}}:surface,
      check:()=>{if(!moved&&f.pauses.includes(150))throw Error('已停止');}});
    await assert.rejects(f.run(),moved?/位置|可见范围/:/已停止/);
    assert.equal(copyCommands(f).length,0);
    assert.equal(f.inputs.filter(event=>event.type==='mousePressed').length,0);
  }
});

test('temporary clipboard focus denial retries only reads and never repeats the copy shortcut',async()=>{
  for(const denied of [1,2,3]){
    const whole=virtualWhole(),f=fixture({singlePass:true,stationary:true,pages:[whole],selectAll:whole,name:'张**',
      clipboardReadFailures:denied});
    if(denied<3)assert.equal((await f.run()).issue,'');
    else await assert.rejects(f.run(),/无法读取剪贴板/);
    assert.equal(copyCommands(f).length,1);
    assert.equal(f.events.filter(event=>event==='clipboard-denied').length,denied);
    assert.ok(f.events.includes('detach'));
  }
});

test('a verified leading caret corridor starts before the name without a guessed corner offset',()=>{
  const inspect=fixedCanvasFrame();inspect('focus');
  const anchor={id:1,x:.30,y:.10,left:.29,top:.09,right:.35,bottom:.12,startX:.285,safeLeft:.28};
  const points=inspect('selection-points',[anchor]);
  assert.equal(points.length,1);
  assert.ok(Math.abs(points[0].point.x-(100+460*.285))<.001);
  for(const bad of [
    {...anchor,startX:NaN},{...anchor,safeLeft:undefined},{...anchor,safeLeft:-.1},
    {...anchor,startX:.31},{...anchor,safeLeft:.286},{...anchor,startX:undefined},
  ])assert.equal(inspect('selection-points',[bad]).length,0);
  inspect('cleanup');
});
