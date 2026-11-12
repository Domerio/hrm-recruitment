import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {copyOpenResume,inspectCopyFrame} from '../extension/resume-copy.mjs';

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

function fixture({ambiguous=false,leaveAfterSelect=false,textSelection,initial=first,
  pages=[first],selectAll=first,commandsOnly=false,folds=[],neverExpands=false,
  clipboardFold=false,staleMarks=[],visualMatches=0,blockedScroll=false,resetBlocked=false,
  initialIndex=0,missingGeometry=false,advancePages=1,lazyGrowth=false,unmeasuredScroll=false,
  stationary=false,rangeWithoutProgress=false,delayedPageOnce=false,ownerless=false,
  foldLabel='查看全部',markLabel=foldLabel}={}) {
  let left=false, selection='', index=initialIndex, item=initial, sequence=8, pending, dragStart;
  let available=lazyGrowth?1:pages.length;
  const inputs=[], events=[];
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
    return collapsed.has(index) ? {resume:`${page.resume} … ${foldLabel}`,resume_html:`${page.resume_html}<span>${foldLabel}</span>`} : page;
  }
  const browser={
    windows:{getCurrent:async()=>({id:30}),update:async id=>events.push(`focus:${id}`)},
    tabs:{get:async()=>left?{...tab,active:false}:tab},
    scripting:{executeScript:async({target,args,world,func})=>{
      if(target.allFrames)return Array.from({length:ambiguous?2:1},(_,i)=>({documentId:`doc${i}`,result:surface}));
      assert.deepEqual(target.documentIds,['doc0']);
      if(world==='MAIN'){
        const present=(folds.includes(index)&&collapsed.has(index))||staleMarks.includes(index);
        return [{result:present?[{id:index+1,label:markLabel,x:.75,y:.2}]:[]}];
      }
      if(func?.name==='visualExpandMarks'){
        events.push('visual');
        return [{result:collapsed.has(index)?Array.from({length:visualMatches},(_,i)=>(
          {id:0,label:'查看全部',x:.75-i*.1,y:.2})):[]}];
      }
      if(args[0]==='expand-points')return [{result:args[1].map(mark=>({mark,point}))}];
      events.push(args[0]);
      if(inspectOwnerless)return [{result:inspectOwnerless(args[0])}];
      return [{result:{...surface,scrollMeasured:!missingGeometry,scrollMode:stationary?'stationary':'native',
        scrollTop:unmeasuredScroll||stationary||rangeWithoutProgress?0:index*300,clientHeight:510,
        scrollHeight:unmeasuredScroll||stationary?510:rangeWithoutProgress?1510:510+(available-1)*300}}];
    }},
    debugger:{attach:async target=>{assert.equal(target.tabId,tab.id);events.push('attach');},
      detach:async()=>events.push('detach'),sendCommand:async(_,method,params)=>{
        inputs.push({method,...params});
        if(params.commands?.includes('selectAll')){
          selection='all';
          if(leaveAfterSelect)left=true;
        }
        if(params.type==='mouseWheel'){
          if(params.deltaY<0){if(!resetBlocked)index=0;}
          else if(!blockedScroll){
            if(lazyGrowth&&index===available-1)available=pages.length;
            index=Math.min(index+advancePages,available-1);
          }
        }
        if(params.type==='mousePressed')dragStart={x:params.x,y:params.y};
        if(params.type==='mouseReleased'){
          const click=params.x===dragStart.x&&params.y===dragStart.y;
          if(click&&params.x>=446&&params.x<=508&&params.y>=225&&params.y<=241){
            events.push(`expand:${index}`);
            if(!neverExpands)collapsed.delete(index);
          }else selection='drag';
        }
        if(params.type==='rawKeyDown'&&params.key==='c'&&(!commandsOnly||params.commands?.includes('copy'))){
          events.push(`copy:${index}`);
          const whole=typeof selectAll==='function'?selectAll(collapsed):selectAll;
          let next=selection==='drag'?selectedRange():clipboardFold&&collapsed.size?folded:whole;
          if(selection==='drag' && delayedPageOnce && index && !lagged.has(index)){
            next=pages[index-1];lagged.add(index);
          }
          if(next)pending={next,waits:2};
        }
      }}
  };
  const clipboard={read:async()=>[{types:['text/plain','text/html'],getType:async type=>({text:async()=>
    type==='text/html'?item.resume_html:item.resume})}]};
  const pause=async()=>{
    if(pending&&--pending.waits===0){
      assert.equal(events.findLast(event=>event.startsWith('focus:')),'focus:23');
      item=pending.next;
      sequence++;
      pending=null;
    }
  };
  return {inputs,events,run:()=>copyOpenResume({browser,clipboard,clipboardSequence:async()=>sequence,tab,textSelection,report(){},pause})};
}

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
    assert.ok(f.inputs.some(input=>input.type==='mousePressed'&&input.x===100&&input.y===180));
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

test('verifies every overlapping screen in a long resume and requires two stable measured bottom reads',async()=>{
  const pages=Array.from({length:5},(_,index)=>({
    resume:`${text}\n第 ${index+1} 段独立项目，负责完整的技术方案、开发和现场交付。`,
    resume_html:`<section>${markup}<p>第 ${index+1} 段独立项目</p></section>`,
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
  const middle={resume:`${text}\n独立的中间工作经历。`,resume_html:`${markup}<p>中间工作经历</p>`};
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
