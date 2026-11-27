import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { backgroundResumeFrame, readBackgroundResume } from '../extension/background-read.mjs';

const footer = '为妥善保护牛人在BOSS直聘平台提交的简历信息，未经授权不得在任何第三方平台进行复制、使用、传播、存储。';
const overlapA = '独立负责工业相机镜头光源选型和视觉系统方案设计，完成机器视觉算法的软件开发与现场技术交付。';
const overlapB = '协同机械电气团队进行多工位设备测试，建立标定流程和质量验证标准，持续改善检测精度和生产效率。';
const pages = [
  '张**\n个人优势\n熟悉 C++ 与图像处理，保留实际绘制的原文。\n' + overlapA,
  overlapA + '\n工作经历\n虚构测试设备公司，视觉研发工程师。\n' + overlapB,
  overlapB + '\n教育经历\n虚构测试大学计算机本科。\n' + footer,
];

// Execute the real frame adapter as well as the reader. A small native outer
// overflow does not drive the virtual canvas; only the dispatched wheel does.
// The old reader harness advanced its text index on every `next`, masking this.
function mixedFixture({ nativeRange = 8, responds = true, obstructed = false,
  incompleteTail = false, onWheel, invalidAfterWheel = false, jumpLargeWheel = false,
  positionRequired = '', onPosition, pointerEvents = true } = {}) {
  let scrollTop = 0, page = 0, snapshots = 0, stopped = false;
  let overlay = obstructed;
  const positioned = {};
  const events = [], actions = [], wheels = [], reported = [];
  const root = { isConnected: true, parentElement: null, clientHeight: 956,
    clientWidth: 773, scrollHeight: 956, scrollTop: 0 };
  const owner = { isConnected: true, parentElement: root, clientHeight: 956,
    clientWidth: 773, scrollHeight: 956 + nativeRange, clientTop: 0, clientLeft: 0,
    offsetWidth: 773, offsetHeight: 956,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 773, height: 956 }),
    dispatchEvent(event) { events.push({ target: 'owner', type: event.type }); return true; },
  };
  Object.defineProperty(owner, 'scrollTop', {
    get: () => scrollTop,
    set: value => { scrollTop = Math.min(nativeRange, Math.max(0, value)); },
  });
  const canvas = { isConnected: true, parentElement: owner, width: 773, height: 956,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 773, bottom: 956, width: 773, height: 956 }),
    dispatchEvent(event) {
      events.push({ target: 'canvas', type: event.type, clientX: event.clientX, clientY: event.clientY,
        composed: event.composed, buttons: event.buttons });
      if (event.type === 'pointermove' || event.type === 'mousemove') {
        positioned[event.type] = [event.clientX, event.clientY];
        onPosition?.({ event, canvas, document, obscure: () => { overlay = true; } });
      }
      if (event.type === 'wheel') {
        wheels.push({ deltaY: event.deltaY, nativeTop: scrollTop, page });
        const position = positioned[positionRequired];
        if (responds && (!positionRequired || position?.[0] === event.clientX && position?.[1] === event.clientY))
          page = event.deltaY < 0 ? 0 : Math.min(2, page + (jumpLargeWheel && event.deltaY > 300 ? 2 : 1));
        delete positioned.pointermove; delete positioned.mousemove;
        onWheel?.({ event, owner, canvas, stop: () => { stopped = true; } });
        if (invalidAfterWheel) canvas.isConnected = false;
      }
      return true;
    },
  };
  const document = { body: { innerText: '' }, documentElement: { clientWidth: 773, clientHeight: 956 },
    scrollingElement: root, querySelectorAll: () => [canvas],
    elementFromPoint: () => overlay ? {} : canvas,
    visibilityState: 'hidden', hidden: true,
  };
  Object.defineProperty(document, 'hasFocus', { get() { throw Error('Must not read foreground focus'); } });
  const window = { __hrmCanvasText: { version: 1, snapshot() {
    snapshots++;
    return { version: 1, canvasId: 'mixed-canvas', revision: page + 1, text: pages[page], marks: [],
      boundaryRows: { top: page > 0, bottom: page < 2 || incompleteTail },
      diagnostics: { baseline: true, entries: pages[page].length, operations: { fillText: 700 },
        scheduler: { hidden: true, pending: 5, nativeFrames: 184, pumpedFrames: 85 } },
    };
  } } };
  window.top = window;
  class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  const context = vm.createContext({ window, document, innerWidth: 773, innerHeight: 956,
    location: { protocol: 'https:', hostname: 'www.zhipin.com', pathname: '/web/frame/c-resume/' },
    Event, MouseEvent: Event, WheelEvent: Event, ...(pointerEvents ? { PointerEvent: Event } : {}),
    getComputedStyle: element => element === canvas ? { visibility: 'visible', opacity: '1' }
      : element === owner ? { overflowY: 'auto', overflowX: 'hidden' } : { overflowY: 'hidden' },
  });
  const frame = vm.runInContext('(' + backgroundResumeFrame.toString() + ')', context);
  const tab = { id: 7, url: 'https://www.zhipin.com/web/chat/search', active: false };
  const browser = { tabs: { get: async () => tab }, scripting: { executeScript: async request => {
    assert.deepEqual(request.target, { tabId: 7, documentIds: ['mixed-frame'] });
    assert.equal(request.world, 'MAIN'); assert.equal(request.func, backgroundResumeFrame);
    const [action, args] = request.args; actions.push(action);
    return [{ documentId: 'mixed-frame', result: frame(action, args) }];
  } } };
  for (const forbidden of ['windows', 'debugger', 'clipboard']) {
    Object.defineProperty(browser, forbidden, { get() { throw Error('Forbidden foreground API: ' + forbidden); } });
  }
  return { owner, canvas, window, document, actions, events, wheels, reported,
    snapshots: () => snapshots,
    run: (action, args = {}) => frame(action, { token: 'direct', name: '张**', ...args }),
    read: () => readBackgroundResume({ browser, tab, documentId: 'mixed-frame', name: '张**',
      check: () => { if (stopped) throw Error('任务已停止'); }, pause: async () => {},
      report: message => reported.push(message) }),
  };
}

test('a hidden virtual resume advances past a small native outer overflow and recovers clipped rows', async () => {
  const f = mixedFixture(), result = await f.read();
  assert.equal(result.issue, undefined);
  assert.equal(result.resume, pages[0] + pages[1].slice(overlapA.length) + pages[2].slice(overlapB.length));
  assert.equal(result.completeness.allScreensRead, true);
  assert.equal(result.completeness.stableBottomReads, 2);
  const positive = f.wheels.filter(event => event.deltaY > 0);
  assert.equal(positive.length, 2);
  assert.ok(positive[0].deltaY > 0 && positive[0].deltaY <= 956 * .55 - 8 + .001);
  assert.equal(positive[0].nativeTop, 8);
  assert.ok(f.events.every(event => ['wheel','scroll','pointerover','pointermove','mouseover','mousemove'].includes(event.type)));
  assert.equal(f.document.visibilityState, 'hidden');
  assert.equal(f.actions.at(-1), 'cleanup');
});

test('canvas wheel establishes its pointer position after exactly 14 pixels of native movement', () => {
  for (const positionRequired of ['pointermove', 'mousemove']) {
    const f = mixedFixture({ nativeRange: 14, positionRequired }); f.run('prepare');
    f.run('next', { stepRatio: .1 });
    assert.equal(f.owner.scrollTop, 14);
    assert.ok(Math.abs(f.wheels[0].deltaY - 81.6) < 1e-6);
    assert.equal(f.run('sample').text, pages[1]);
    assert.deepEqual(f.events.filter(event => event.target === 'canvas').map(event => event.type),
      ['pointerover','pointermove','mouseover','mousemove','wheel']);
    const sent = f.events.filter(event => event.target === 'canvas');
    assert.ok(sent.every(event => event.clientX === 386.5 && event.clientY === 478 && event.composed === true && event.buttons === 0));
    assert.equal(f.run('sample').diagnostics.motion.pointerNotifications, 4);
  }
});

test('pointer-dependent canvas reads every screen and resets its position on return to top', async () => {
  const f = mixedFixture({ nativeRange: 14, positionRequired: 'pointermove' });
  const result = await f.read();
  assert.equal(result.issue, undefined);
  assert.equal(result.resume, pages[0] + pages[1].slice(overlapA.length) + pages[2].slice(overlapB.length));
  f.run('prepare'); f.run('next'); f.run('top');
  assert.equal(f.run('sample').text, pages[0]);
});

test('mouse positioning supports a canvas without PointerEvent', async () => {
  const f = mixedFixture({ nativeRange: 14, positionRequired: 'mousemove', pointerEvents: false });
  assert.equal((await f.read()).issue, undefined);
  assert.equal(f.events.some(event => event.type.startsWith('pointer')), false);
});

test('canvas replacement, obstruction or verification during positioning prevents the wheel', async () => {
  for (const change of [({canvas}) => { canvas.isConnected = false; },
    ({obscure}) => obscure(), ({document}) => { document.body.innerText = '请完成安全验证'; },
    ({canvas}) => { canvas.getBoundingClientRect = () => ({left:0,top:5,right:773,bottom:961,width:773,height:956}); }]) {
    const f = mixedFixture({ onPosition: change });
    await assert.rejects(f.read(), /发生变化|遮挡|验证/);
    assert.equal(f.wheels.length, 0);
    assert.equal(f.actions.at(-1), 'cleanup');
  }
});

test('mixed motion preserves real native geometry and marks virtual movement separately', () => {
  const f = mixedFixture();
  assert.equal(f.run('prepare').geometry.scrollMode, 'native');
  const moved = f.run('next');
  assert.equal(moved.geometry.scrollMode, 'native');
  assert.equal(moved.geometry.scrollTop, 8);
  assert.equal(moved.geometry.scrollHeight, 964);
  assert.equal(moved.geometry.virtualScroll, true);
  assert.equal(f.run('sample').text, pages[1]);
});

test('top resets both known virtual state and native overflow before proving the start again', () => {
  const f = mixedFixture(); f.run('prepare'); f.run('next'); f.run('next');
  assert.equal(f.run('sample').text, pages[2]);
  const reset = f.run('top');
  assert.equal(reset.geometry.scrollTop, 0);
  assert.equal(f.wheels.at(-1).deltaY < 0, true);
  assert.equal(f.run('sample').text, pages[0]);
});

test('a hybrid overlap gap restarts both scroll systems and re-proves every screen with a smaller wheel', async () => {
  const f = mixedFixture({ jumpLargeWheel: true }), result = await f.read();
  assert.equal(result.issue, undefined);
  assert.equal(result.resume, pages[0] + pages[1].slice(overlapA.length) + pages[2].slice(overlapB.length));
  assert.equal(result.completeness.allScreensRead, true);
  assert.ok(f.wheels.some(event => event.deltaY < 0));
  assert.ok(f.wheels.some(event => event.deltaY > 0 && event.deltaY < 300));
  assert.equal(f.actions.includes('restore'), false, 'Native positions cannot restore virtual text offsets');
});

test('native-only restore is rejected after a virtual wheel has changed the text position', () => {
  const f = mixedFixture(); f.run('prepare'); f.run('next');
  const count = f.wheels.length;
  assert.throws(() => f.run('restore', { scrollPositions: [0] }), /无法返回/);
  assert.equal(f.owner.scrollTop, 8);
  assert.equal(f.wheels.length, count);
  assert.equal(f.run('sample').text, pages[1]);
});

test('native scrolling with enough remaining range never also dispatches a wheel', () => {
  const f = mixedFixture({ nativeRange: 2000 }); f.run('prepare');
  const moved = f.run('next');
  assert.equal(moved.geometry.scrollTop, 956 * .55);
  assert.equal(f.wheels.length, 0);
  assert.equal(f.events.some(event => event.target === 'canvas'), false);
  assert.notEqual(moved.geometry.virtualScroll, true);
});

test('a nonresponsive native end remains incomplete despite bounded virtual probes', async () => {
  const f = mixedFixture({ responds: false }), result = await f.read();
  assert.ok(result.issue);
  assert.equal(result.completeness.allScreensRead, false);
  assert.equal(result.completeness.bottomVerified, false);
  assert.equal(result.resume.includes(footer), false);
  assert.ok(f.wheels.length > 0 && f.wheels.length <= 16);
  assert.ok(f.snapshots() < 150);
});

test('a virtual wheel cannot excuse the unresolved last clipped row even when the footer is visible', async () => {
  const f = mixedFixture({ incompleteTail: true }), result = await f.read();
  assert.equal(result.failureReason, 'boundary-bottom');
  assert.equal(result.completeness.allScreensRead, false);
});

test('native exhaustion cannot dispatch a virtual wheel into an obscuring overlay', async () => {
  const f = mixedFixture({ obstructed: true });
  await assert.rejects(f.read(), /遮挡/);
  assert.equal(f.wheels.length, 0);
  assert.equal(f.actions.at(-1), 'cleanup');
});

test('stopping during the native-to-virtual transition prevents another sample or action', async () => {
  const f = mixedFixture({ onWheel: ({ event, stop }) => { if (event.deltaY > 0) stop(); } });
  await assert.rejects(f.read(), /任务已停止/);
  assert.deepEqual(f.actions.slice(-2), ['next', 'cleanup']);
  assert.equal(f.wheels.length, 1);
});

test('a canvas replaced during virtual movement cannot supply a later accepted screen', async () => {
  const f = mixedFixture({ invalidAfterWheel: true });
  await assert.rejects(f.read(), /发生变化/);
  assert.equal(f.actions.at(-1), 'cleanup');
  assert.equal(f.wheels.length, 1);
});
