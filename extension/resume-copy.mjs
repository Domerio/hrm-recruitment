import {isBoss,resumeFoldLabels} from './capture-utils.mjs';
import {visualExpandMarks} from './visual-expand.mjs';
import {createClipboardProof,proveWholeClipboard,hasTerminalClipboard} from './copy-proof.mjs';

// Injected as an isolated-world function. Only inspect the resume surface and focus it.
export function inspectCopyFrame(action, marks=[]) {
  if (location.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(location.hostname)
      || !/^\/web\/frame\/c-resume\/?$/.test(location.pathname)) return null;
  if (action === 'cleanup') {
    const canvas = window.__hrmCopyFocusable;
    if (canvas?.getAttribute('tabindex') === '-1') canvas.removeAttribute('tabindex');
    const scroll = window.__hrmCopyScroll;
    const owners=scroll?.owners || (scroll?.element?[scroll]:[]);
    for (const owner of [...owners].reverse()) {
      if (owner.element.isConnected) owner.element.scrollTop=owner.top;
    }
    delete window.__hrmCopyFocusable;
    delete window.__hrmCopyScroll;
    return null;
  }
  if (/请完成安全验证|访问过于频繁|拖动滑块|账号异常/.test(document.body?.innerText || '')) return null;
  const canvases = [...document.querySelectorAll('canvas')].filter(canvas => {
    const rect = canvas.getBoundingClientRect(), style = getComputedStyle(canvas);
    return rect.width >= 250 && rect.height >= 150 && style.visibility === 'visible' && Number(style.opacity) > 0;
  });
  if (canvases.length !== 1) return null;
  const canvas = canvases[0], rect = canvas.getBoundingClientRect();
  const session = window.__hrmCopyScroll;
  if (session && (session.canvas !== canvas || !session.owners ||
      session.owners.some(owner=>owner.element.isConnected===false))) return null;
  let left=rect.left, right=rect.right, top=rect.top, bottom=rect.bottom;
  let offsetX=0, offsetY=0;
  const owners=[], frames=[];
  const addOwner=element=>{
    if (element && element.clientHeight>=150 && !owners.includes(element)) owners.push(element);
  };
  const clip=(x1,y1,x2,y2)=>{
    left=Math.max(left,x1);top=Math.max(top,y1);
    right=Math.min(right,x2);bottom=Math.min(bottom,y2);
  };
  try {
    let child=window, anchor=canvas;
    for (let depth=0;depth<10;depth++) {
      const doc=child===window?document:child.document;
      const width=child===window?innerWidth:child.innerWidth;
      const height=child===window?innerHeight:child.innerHeight;
      const styleOf=child===window?getComputedStyle:element=>child.getComputedStyle(element);
      clip(0,0,width,height);
      let fixed=false;
      for (let ancestor=anchor;ancestor;ancestor=ancestor.parentElement) {
        const style=styleOf(ancestor);
        if (ancestor!==canvas && ancestor!==doc.scrollingElement) {
          const clipX=/^(auto|scroll|hidden|clip)$/.test(style.overflowX);
          const clipY=/^(auto|scroll|hidden|clip)$/.test(style.overflowY);
          if (clipX || clipY) {
            const bounds=ancestor.getBoundingClientRect();
            const scaleX=ancestor.offsetWidth?bounds.width/ancestor.offsetWidth:1;
            const scaleY=ancestor.offsetHeight?bounds.height/ancestor.offsetHeight:1;
            const clientLeft=bounds.left+ancestor.clientLeft*scaleX;
            const clientTop=bounds.top+ancestor.clientTop*scaleY;
            clip(clipX?clientLeft:-Infinity,clipY?clientTop:-Infinity,
              clipX?clientLeft+ancestor.clientWidth*scaleX:Infinity,
              clipY?clientTop+ancestor.clientHeight*scaleY:Infinity);
          }
        }
        if (!fixed && ancestor!==canvas && /^(auto|scroll)$/.test(style.overflowY)) addOwner(ancestor);
        if (style.position==='fixed') fixed=true;
      }
      if (!fixed && doc.scrollingElement &&
          !/^(hidden|clip)$/.test(styleOf(doc.scrollingElement).overflowY)) addOwner(doc.scrollingElement);
      if (child===child.top) break;
      if (depth===9) return null;
      const frame=child.frameElement;
      if (!frame || frame.isConnected===false) return null;
      const bounds=frame.getBoundingClientRect();
      if (Math.abs(bounds.width-frame.offsetWidth)>2 || Math.abs(bounds.height-frame.offsetHeight)>2) return null;
      frames.push(frame);
      const x=bounds.left+frame.clientLeft, y=bounds.top+frame.clientTop;
      left+=x;right+=x;top+=y;bottom+=y;offsetX+=x;offsetY+=y;
      anchor=frame;child=child.parent;
    }
  } catch {
    return null;
  }
  if (session && (session.owners.length!==owners.length ||
      session.owners.some((owner,index)=>owner.element!==owners[index]) ||
      session.frames.length!==frames.length || session.frames.some((frame,index)=>frame!==frames[index]))) return null;
  if (right - left < 250 || bottom - top < 150) return null;

  function mapPoint(x, y) {
    if (document.elementFromPoint(x, y) !== canvas) return null;
    try {
      for (let child = window; child !== child.top; child = child.parent) {
        const frame = child.frameElement;
        if (!frame) return null;
        const bounds = frame.getBoundingClientRect();
        if (Math.abs(bounds.width - frame.offsetWidth) > 2 || Math.abs(bounds.height - frame.offsetHeight) > 2) return null;
        x += bounds.left + frame.clientLeft;
        y += bounds.top + frame.clientTop;
        if (frame.ownerDocument.elementFromPoint(x, y) !== frame) return null;
      }
    } catch {
      return null;
    }
    return {x, y};
  }

  if (action === 'expand-points') {
    const transform = getComputedStyle(canvas).transform;
    if (transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(transform);
      if (!matrix.is2D || matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0) return [];
    }
    return marks.flatMap(mark => {
      const label=typeof mark.label==='string'?mark.label.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,''):'';
      const allowed=/^(?:查看全部|展开全部|查看更多)(?:(?:[1-9]\d{0,3}(?:个|项|条|段|份)?)?(?:个人优势|个人简介|期望职位|工作经历|工作经验|项目经历|项目经验|教育经历|教育背景|资格证书|专业技能|所获荣誉|荣誉奖项|获奖经历|荣誉|语言能力))?$/;
      if (!Number.isSafeInteger(mark.id) || !allowed.test(label) ||
          !(mark.x > 0 && mark.x < 1 && mark.y > 0 && mark.y < 1)) return [];
      const point = mapPoint(rect.left+rect.width*mark.x,rect.top+rect.height*mark.y);
      return point ? [{mark:{...mark,label},point}] : [];
    });
  }

  const center = mapPoint((left+right)/2-offsetX,(top+bottom)/2-offsetY);
  if (!center) return null;
  const start = mapPoint(left+10-offsetX,top+10-offsetY), end = mapPoint(right-18-offsetX,bottom-10-offsetY);
  if (action === 'focus') {
    if (!window.__hrmCopyScroll) {
      window.__hrmCopyScroll={canvas,frames,owners:owners.map(element=>({element,top:element.scrollTop}))};
    }
    if (!canvas.hasAttribute('tabindex')) {
      canvas.setAttribute('tabindex', '-1');
      window.__hrmCopyFocusable = canvas;
    }
    canvas.focus({preventScroll: true});
  }
  const measured=Boolean(window.__hrmCopyScroll);
  const scrollChain=owners.map((element,index)=>({index,scrollTop:element.scrollTop,
    clientHeight:element.clientHeight,scrollHeight:element.scrollHeight}));
  const range=scrollChain.reduce((sum,owner)=>sum+Math.max(0,owner.scrollHeight-owner.clientHeight),0);
  const viewport=bottom-top;
  return {focused: document.hasFocus(), canvasFocused: document.activeElement === canvas, center, start, end,
    scrollMeasured:measured, scrollMode:range>4?'native':'stationary', scrollChain,
    scrollTop:measured?scrollChain.reduce((sum,owner)=>sum+owner.scrollTop,0):null,
    clientHeight:measured?viewport:null, scrollHeight:measured?viewport+range:null,
    contentTopVisible: top <= rect.top+offsetY+2, contentBottomVisible: bottom >= rect.bottom+offsetY-2,
    contentWidthVisible: left <= rect.left+offsetX+2 && right >= rect.right+offsetX-2};
}

function canvasExpandMarks() {
  return window.__hrmExpandMarks?.read() || [];
}

export async function readClipboardResume(clipboard) {
  const items = await clipboard.read();
  const item = items.find(entry => entry.types.includes('text/html'))
    || items.find(entry => entry.types.includes('text/plain'));
  const read = async type => item?.types.includes(type) ? (await item.getType(type)).text() : '';
  return {resume: await read('text/plain'), resume_html: await read('text/html')};
}

const sameClipboard = (a,b) => a.resume === b.resume && a.resume_html === b.resume_html;
const clipboardText = item => item.resume || item.resume_html.replace(/<[^>]*>/g, ' ');
const normalizedText = item => clipboardText(item).replace(/\s/g, '');

function scrollGeometry(surface) {
  if (!surface?.scrollMeasured) return null;
  const {scrollTop, clientHeight, scrollHeight} = surface;
  if (![scrollTop,clientHeight,scrollHeight].every(Number.isFinite) || clientHeight < 150 ||
      scrollHeight < clientHeight - 4 || scrollTop < -4 || scrollTop > scrollHeight - clientHeight + 4) return null;
  return {scrollTop,clientHeight,scrollHeight};
}
const atBottom = geometry => geometry.scrollTop + geometry.clientHeight >= geometry.scrollHeight - 4;
const sameGeometry = (a,b) => ['scrollTop','clientHeight','scrollHeight'].every(key=>Math.abs(a[key]-b[key]) <= 2);

function looksLikeResume(item) {
  const text = clipboardText(item).trim();
  return text.length >= 40 && /工作经历|工作经验|项目经历|教育经历|教育背景|个人优势|个人简介|期望职位|专业技能/.test(text.replace(/\s/g, ''));
}

function combineScreens(screens) {
  const resume = screens.map(clipboardText).join('\n\n');
  const escape = value => value.replace(/[&<>]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[ch]);
  const resume_html = screens.some(page=>page.resume_html)
    ? screens.map(page=>page.resume_html || `<pre>${escape(page.resume)}</pre>`).join('<hr>') : '';
  return {resume, resume_html};
}

export async function copyOpenResume({browser, clipboard, clipboardSequence, tab, documentId, textSelection, report, pause, check=()=>{}}) {
  const home = await browser.windows.getCurrent();
  const target = {tabId: tab.id};
  const debug = browser.debugger;
  const baseline = await readClipboardResume(clipboard);
  if(!textSelection&&!documentId){
    const found=(await browser.scripting.executeScript({target:{...target,allFrames:true},func:inspectCopyFrame,args:['probe']})).filter(frame=>frame.result);
    if(found.length!==1||!found[0].documentId)throw Error('未确认唯一的在线简历正文。');
    documentId=found[0].documentId;
  }
  const frameTarget = {...target, documentIds: [documentId]};
  const inspect = textSelection?async action=>{
    if(action==='cleanup')return textSelection.clear();
    const focused=action==='focus'?await textSelection.select():await textSelection.focused();
    return focused?{focused:true,canvasFocused:true}:null;
  }:async (action, marks=[]) => (await browser.scripting.executeScript({
    target: frameTarget, func: inspectCopyFrame, args: [action,marks]
  }))[0]?.result;
  const verifyTab = async () => {
    check();
    const current = await browser.tabs.get(tab.id);
    if (!current.active || current.url !== tab.url || !isBoss(current.url)) throw Error('BOSS 标签页已切换，自动复制已停止。');
  };
  const send = (method, params) => debug.sendCommand(target, `Input.${method}`, params);
  const shortcut = async (letter, command) => {
    const code = letter.toUpperCase().charCodeAt(0);
    const key = {key: letter, code: `Key${letter.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: 2};
    const control = {key:'Control', code:'ControlLeft', windowsVirtualKeyCode:17, nativeVirtualKeyCode:17};
    await send('dispatchKeyEvent', {type:'rawKeyDown', ...control, modifiers:2});
    try {
      await send('dispatchKeyEvent', {type:'rawKeyDown', ...key, ...(command?{commands:[command]}:{})});
    } finally {
      try {
        await send('dispatchKeyEvent', {type:'keyUp', ...key});
      } finally {
        await send('dispatchKeyEvent', {type:'keyUp', ...control, modifiers:0});
      }
    }
  };
  const focus = async () => {
    await verifyTab();
    await browser.windows.update(tab.windowId, {focused: true});
    const surface = await inspect('focus');
    if (!surface?.focused || !surface.canvasFocused) throw Error('无法聚焦简历正文，自动复制已停止。');
    return surface;
  };
  let previous = baseline;
  const sequence = clipboardSequence || (async () => null);
  const copySelection = async () => {
    const before = await sequence();
    const copyKeys = textSelection ? ['copy', undefined] : [undefined, 'copy'];
    for (const command of copyKeys) {
      await verifyTab();
      if (!(await inspect('probe'))?.focused) throw Error('简历正文已失去焦点，自动复制已停止。');
      await shortcut('c', command);
      // Give the page time to finish a clipboard write while it still has focus.
      for (let attempt = 0; attempt < (before === null ? 1 : 6); attempt++) {
        await pause(before === null ? 300 : 120);
        check();
        const current = await sequence();
        if (current !== null && current !== before) break;
      }
      await verifyTab();
      if (!await inspect('probe')) throw Error('简历已关闭或切换，自动复制已停止。');
      await browser.windows.update(home.id, {focused: true});
      for (let attempt = 0; attempt < 8 && globalThis.document && !document.hasFocus(); attempt++) {
        check();
        await pause(40);
      }
      let copied;
      try {
        copied = await readClipboardResume(clipboard);
      } catch (error) {
        if (error.name !== 'NotAllowedError') throw error;
        throw Error('采集窗口无法读取剪贴板，请保持窗口开启并确认 Edge 已授予剪贴板权限。');
      }
      const after = await sequence();
      const fresh = before !== null && after !== null ? before !== after : !sameClipboard(previous,copied);
      previous = copied;
      if (fresh && clipboardText(copied).trim()) return copied;
      if (command === copyKeys[0]) await browser.windows.update(tab.windowId, {focused: true});
    }
    return null;
  };
  const scroll = async (surface, deltaY) => {
    await verifyTab();
    await send('dispatchMouseEvent', {type:'mouseWheel', ...surface.center, deltaX:0, deltaY});
    await pause(350);
  };
  const expandPoints = async visual => {
    const query = visual ? {func:visualExpandMarks} : {world:'MAIN',func:canvasExpandMarks};
    const [row] = await browser.scripting.executeScript({target:frameTarget,...query});
    const marks = row?.result;
    if (!Array.isArray(marks) || !marks.length) return [];
    return await inspect('expand-points',marks) || [];
  };
  const click = async point => {
    await send('dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
    await send('dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
  };
  const drag = async ({start,end}) => {
    let last = start;
    await send('dispatchMouseEvent', {type:'mouseMoved', ...start, buttons:0});
    await send('dispatchMouseEvent', {type:'mousePressed', ...start, button:'left', buttons:1, clickCount:1});
    try {
      for (let step = 1; step <= 12; step++) {
        check();
        last = {x:start.x + (end.x-start.x)*step/12, y:start.y + (end.y-start.y)*step/12};
        await send('dispatchMouseEvent', {type:'mouseMoved', ...last, button:'left', buttons:1});
      }
    } finally {
      await send('dispatchMouseEvent', {type:'mouseReleased', ...last, button:'left', buttons:0, clickCount:1});
    }
  };
  const copyRange = async (start,end) => {
    await drag({start,end});
    return copySelection();
  };
  const clickedMarks = new Set();
  const nearby = (a,b,distance) => a.mark.label === b.mark.label &&
    Math.hypot(a.point.x-b.point.x,a.point.y-b.point.y) < distance;
  const expandVisible = async page => {
    let labels = resumeFoldLabels(clipboardText(page));
    const clickedHere = [];
    for (let attempt=0; labels.length && attempt<8; attempt++) {
      await focus();
      const eligible = item => labels.includes(item.mark.label) && !clickedMarks.has(item.mark.id) &&
        !clickedHere.some(clicked=>Math.hypot(clicked.point.x-item.point.x,clicked.point.y-item.point.y)<8);
      const findCandidate = points => {
        const candidates = points.filter(eligible);
        return candidates.find(({mark}) =>
          candidates.filter(item=>item.mark.label===mark.label).length === labels.filter(label=>label===mark.label).length);
      };
      let visual = false;
      let candidate = findCandidate(await expandPoints(visual));
      if (!candidate && labels.includes('查看全部')) {
        visual = true;
        candidate = findCandidate(await expandPoints(visual));
      }
      if (!candidate) return {page,foldIssue:'已读到折叠字样，但未确认当前屏的展开控件位置。'};
      await send('dispatchMouseEvent',{type:'mouseMoved',...candidate.point,buttons:0});
      const fresh = (await expandPoints(visual)).find(item=>eligible(item)&&nearby(candidate,item,4));
      if (!fresh) return {page,foldIssue:'展开控件的位置发生变化，未能确认当前可点击的位置。'};
      const label = fresh.mark.label;
      report(`正在展开「${label}」…`);
      await verifyTab();
      if (!visual) {
        clickedMarks.add(candidate.mark.id);
        clickedMarks.add(fresh.mark.id);
      }
      clickedHere.push(fresh);
      await click(fresh.point);
      report(`已点击「${label}」，正在核对展开结果…`);
      await pause(650);
      const surface = await focus();
      const recopy = surface.start && surface.end ? await copyRange(surface.start,surface.end) : null;
      const remaining = recopy ? resumeFoldLabels(clipboardText(recopy)) : labels;
      if (!recopy || remaining.filter(item=>item===label).length >= labels.filter(item=>item===label).length) {
        return {page,foldIssue:`已定位并点击「${label}」，但未确认展开。`};
      }
      page = recopy;
      labels = remaining;
    }
    return {page,expanded:clickedHere.length>0,foldIssue:labels.length?'仍有折叠项，未确认全部展开。':''};
  };
  const copyAll = async () => {
    await focus();
    await shortcut('a','selectAll');
    return copySelection();
  };
  const detach = () => debug.detach(target).catch(() => {});
  await verifyTab();
  await debug.attach(target, '1.3');
  try {
    globalThis.addEventListener?.('pagehide', detach, {once: true});
    if(textSelection){
      report('正在复制已展开的简历正文…');
      await focus();
      const copied=await copySelection();
      if(!copied||!looksLikeResume(copied))throw Error('剪贴板没有收到可用的简历正文');
      return {...copied,selection:'text-range',screens:1};
    }
    const completeness = {topVerified:false,bottomVerified:false,stableBottomReads:0,allScreensRead:false};
    const resetTop = async () => {
      const surface = await focus();
      await scroll(surface,-Math.max(100000,(surface.scrollTop||0)+(surface.clientHeight||0)));
      const positioned = await inspect('probe'), geometry = scrollGeometry(positioned);
      completeness.topVerified = Boolean(geometry && geometry.scrollTop <= 4 && positioned.contentTopVisible !== false);
      completeness.bottomVerified = false;
      completeness.stableBottomReads = 0;
    };
    await resetTop();
    let selected = null;
    let foldedSelection = null;
    const screens = [];
    let previousRead = null;
    let textProof = createClipboardProof(), firstScreenText = '';
    let clipboardMode = false;
    let issue = '已达到分屏复制上限，尚未确认读完正文。';
    for (let index = 0; index < 80; index++) {
      const screenNumber = screens.length+1;
      report(`正在复制第 ${screenNumber} 屏简历正文…`);
      const focused=await focus();
      if(!focused.start || !focused.end)throw Error('简历区域被遮挡，无法安全拖选。');
      if(previousRead)await scroll(focused,Math.max(120,(focused.end.y-focused.start.y)*0.65));
      await verifyTab();
      let surface=await inspect('probe');
      if(!surface?.focused || !surface.start || !surface.end)throw Error('简历区域被遮挡，无法安全拖选。');
      let page=await copyRange(surface.start,surface.end);
      if ((surface.scrollMode==='stationary' || clipboardMode) && previousRead && page &&
          normalizedText(page)===previousRead.content && !hasTerminalClipboard(clipboardText(page)) &&
          !textProof.snapshot().complete) {
        await pause(500);
        surface=await focus();
        if (!surface.start || !surface.end) throw Error('简历区域被遮挡，无法安全拖选。');
        page=await copyRange(surface.start,surface.end);
      }
      if (page && resumeFoldLabels(clipboardText(page)).length) {
        const result = await expandVisible(page);
        if (result.foldIssue) return {...result.page,selection:'scroll-drag',screens:screenNumber,
          foldIssue:result.foldIssue,completeness};
        page = result.page;
        if (previousRead && result.expanded) {
          selected = null;
          foldedSelection = null;
          screens.length = 0;
          previousRead = null;
          textProof = createClipboardProof();
          firstScreenText = '';
          clipboardMode = false;
          report('下方内容已展开，正在从顶部重新核对全文…');
          await resetTop();
          continue;
        }
      }
      if (!previousRead) {
        firstScreenText=page?clipboardText(page):'';
        const copied = await copyAll();
        if (copied && resumeFoldLabels(clipboardText(copied)).length) foldedSelection = copied;
        else if (copied && looksLikeResume(copied)) selected = copied;
      }
      const firstHeader=page && surface.scrollMode==='stationary' &&
        createClipboardProof().observe(clipboardText(page)).topVerified;
      if (!page || (!previousRead && !selected && !looksLikeResume(page) && !firstHeader)) {
        issue = `第 ${screenNumber} 屏未读到剪贴板正文，无法确认后续内容。`;
        break;
      }
      const copiedSurface = await inspect('probe');
      const before = scrollGeometry(surface), after = scrollGeometry(copiedSurface);
      if (!screens.some(screen=>sameClipboard(screen,page))) screens.push(page);
      if (!before || !after) {
        issue = '未测得唯一简历滚动区域的完整尺寸，无法确认全文已复制。';
        break;
      }
      const stationary=surface.scrollMode==='stationary' && copiedSurface.scrollMode==='stationary';
      const content = normalizedText(page);
      const frozenProgress=previousRead && Math.abs(before.scrollTop-previousRead.geometry.scrollTop)<=2 &&
        Math.abs(after.scrollHeight-previousRead.geometry.scrollHeight)<=2 && previousRead.content!==content;
      if (stationary || frozenProgress) clipboardMode=true;
      const sequenceProof=textProof.observe(clipboardText(page));
      const sequenceComplete=sequenceProof.complete && !sequenceProof.issue;
      const wholeProof=selected?proveWholeClipboard(clipboardText(selected),firstScreenText):null;
      const wholeCoversPage=Boolean(wholeProof?.complete && normalizedText(selected).includes(normalizedText(page)));
      if (clipboardMode) completeness.topVerified=Boolean(sequenceProof.topVerified || wholeProof?.topVerified);
      if (!completeness.topVerified) {
        issue = '未确认从简历顶部开始复制，无法确认全文完整。';
        break;
      }
      if (surface.contentWidthVisible === false || copiedSurface.contentWidthVisible === false) {
        issue = '简历正文的横向区域未完整显示，无法确认已复制所有文字。';
        break;
      }
      if (!clipboardMode && atBottom(after) && copiedSurface.contentBottomVisible === false) {
        issue = '滚动区域已到底部，但简历末尾仍被页面区域遮挡，无法确认正文完整。';
        break;
      }
      if (Math.abs(before.scrollTop-after.scrollTop) > 2 || Math.abs(before.clientHeight-after.clientHeight) > 2) {
        issue = '复制期间简历滚动位置或可见范围发生变化，无法确认正文连续。';
        break;
      }
      if (previousRead) {
        const advance = before.scrollTop-previousRead.geometry.scrollTop;
        if (advance < -2 || advance > previousRead.coverage - 8) {
          issue = '简历滚动跨度超出已复制区域，无法确认中间内容完整。';
          break;
        }
        if (advance > 2 && previousRead.content === content) {
          issue = `已滚动至第 ${screenNumber} 屏，但剪贴板仍是上一屏，无法确认后续内容。`;
          break;
        }
        const grew = after.scrollHeight > previousRead.geometry.scrollHeight + 2;
        if (!clipboardMode && advance <= 2 && !grew && !atBottom(after)) {
          issue = '简历滚动位置未前进，且尚未到达底部，无法确认全文完整。';
          break;
        }
        if (clipboardMode && previousRead.content===content && !sequenceComplete && !hasTerminalClipboard(clipboardText(page))) {
          issue = '剪贴板正文没有前进，且尚未读到平台末尾，无法确认全文完整。';
          break;
        }
      }
      if (clipboardMode && !sequenceProof.accepted && !sequenceComplete && !wholeCoversPage) {
        issue=sequenceProof.issue || '尚未从复制正文中确认连续内容和平台末尾。';
        break;
      }
      const terminal=clipboardMode
        ? sequenceComplete || hasTerminalClipboard(clipboardText(page)) && wholeCoversPage
        : atBottom(before) && atBottom(after);
      const stable = terminal && sameGeometry(before,after);
      completeness.stableBottomReads = stable
        ? previousRead && previousRead.content === content && sameGeometry(previousRead.geometry,after)
          ? completeness.stableBottomReads+1 : 1
        : 0;
      if (completeness.stableBottomReads >= 2) {
        completeness.bottomVerified = true;
        completeness.allScreensRead = true;
        issue = '';
        break;
      }
      previousRead = {geometry:after,content,coverage:surface.end.y-surface.start.y};
    }
    // The first all-selection can contain an old folded view. Prefer the
    // freshly verified screens once they have reached a stable end.
    const foldIssue = foldedSelection && !completeness.allScreensRead
      ? '初次全选中出现折叠字样，分屏未能确认正文完整。' : '';
    if (foldIssue) await scroll(await focus(),-100000);
    if (selected || screens.length || foldedSelection) {
      const parts = selected ? [selected] : [];
      for (const page of screens) {
        const text = normalizedText(page);
        if (parts.some(part => normalizedText(part).includes(text))) continue;
        if (parts.length === 1 && text.includes(normalizedText(parts[0]))) parts[0] = page;
        else parts.push(page);
      }
      const result = parts.length > 1 ? combineScreens(parts) : parts[0] || foldedSelection;
      return {...result, selection:'scroll-drag', screens:screens.length, issue,
        completeness,...(foldIssue?{foldIssue}:{})};
    }
    throw Error('未确认剪贴板获得新简历正文。请展开简历并滚动到开头后重试。');
  } finally {
    globalThis.removeEventListener?.('pagehide', detach);
    await detach();
    await inspect('cleanup').catch(() => {});
    await browser.windows.update(home.id, {focused: true}).catch(() => {});
  }
}
