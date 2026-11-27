"""Native clipboard regression using a disposable Chromium and synthetic pages.

Run: python tests/native_clipboard_copy_check.py
Optionally set PLAYWRIGHT_CHROMIUM_EXECUTABLE to an existing Chromium binary.
Requires the installed Playwright package/browser; never downloads dependencies.
Only a loopback fixture is reachable. No account, real resume, extension install,
or production service is used. Nothing is persisted; stdout contains case names
and counts only. Headless page switching is not an OS-window focus test.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


TEXT = '合成候选人\n工作经历：Python <A&B> 设备开发\n重复相同的合成正文'
PAGE = '''<!doctype html><meta charset="utf-8"><title>Clipboard fixture</title>
<iframe src="/resume" width="700" height="400"></iframe>'''
FRAME = '''<!doctype html><meta charset="utf-8"><title>Synthetic resume</title>
<canvas id="resume" tabindex="0" width="600" height="180"></canvas>
<p id="text" tabindex="0">默认复制：合成简历，Python 设备开发。</p>
<div id="avatar-preview" hidden style="position:fixed;inset:0;background:#ddd;z-index:100">Synthetic avatar preview</div>
<script>
const text=FIXTURE_TEXT;
const escaped=text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
window.mode='html';window.asyncDone=false;window.copyEvents=[];
window.customSelection={started:false,moves:0,dragged:false,all:false};
window.avatarOpen=false;window.pointerEvents=[];window.avatarPress=null;
const canvas=document.querySelector('canvas');
canvas.getContext('2d').fillText(text,20,40);
const selectionMode=()=>['selection','avatar-selection','geometry-selection'].includes(window.mode);
const avatarMode=()=>window.mode==='avatar-selection'||window.mode==='geometry-selection';
const pointerPoint=event=>{
  const rect=canvas.getBoundingClientRect();
  return {x:event.clientX-rect.left,y:event.clientY-rect.top};
};
window.paintAvatarFixture=(scale=1)=>{
  canvas.width=600*scale;canvas.height=180*scale;
  canvas.style.width='600px';canvas.style.height='180px';
  const ctx=canvas.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.setTransform(scale,0,0,scale,0,0);
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#729dcc';ctx.fillRect(0,0,90,90);
  ctx.fillStyle='#161616';ctx.font='18px sans-serif';
  ctx.fillText('工作经历',140,115);
  ctx.fillText('Synthetic Python resume body',140,150);
};
window.paintNameFixture=({scale=1,align='left',italic=true}={})=>{
  canvas.width=600*scale;canvas.height=180*scale;
  canvas.style.width='600px';canvas.style.height='180px';
  const ctx=canvas.getContext('2d');ctx.setTransform(scale,0,0,scale,0,0);
  ctx.fillStyle='#fff';ctx.fillRect(0,0,600,180);
  const avatar=document.createElement('canvas');avatar.width=90;avatar.height=90;
  const ac=avatar.getContext('2d');ac.fillStyle='#729dcc';ac.fillRect(0,0,90,90);
  ctx.drawImage(avatar,0,0);
  ctx.fillStyle='#161616';ctx.font=(italic?'italic ':'')+'bold 24px Microsoft YaHei';
  ctx.textAlign=align;
  let x=140;window.nameCarets=[x];
  for(const char of '杜先生'){
    const width=ctx.measureText(char).width;
    ctx.fillText(char,x+(align==='center'?width/2:align==='right'?width:0),50);
    x+=width;window.nameCarets.push(x);
  }
  window.geometryText='杜先生\\n工作经历：Python开发\\n为妥善保护牛人隐私';
  ctx.textAlign='left';ctx.font='18px Microsoft YaHei';
  ctx.fillText('工作经历：Python开发',140,105);ctx.fillText('为妥善保护牛人隐私',140,150);
};
// This editor computes its clipboard substring from actual trusted pointer
// caret positions. Ctrl+A is deliberately ignored, so a bad name start cannot
// be hidden by returning a predetermined complete string.
const geometryCaret=point=>{
  if(point.y>120)return window.geometryText.length;
  if(point.y>70)return 4;
  let index=0;
  for(let i=1;i<window.nameCarets.length;i++)
    if(Math.abs(point.x-window.nameCarets[i])<Math.abs(point.x-window.nameCarets[index]))index=i;
  return index;
};
// A custom Canvas editor only has a selection after a real pointer drag.
// Ctrl+A extends that existing selection; it cannot create one from a click.
canvas.addEventListener('mousedown',event=>{
  if(!selectionMode()||!event.isTrusted||event.button!==0)return;
  window.customSelection={started:true,x:event.clientX,y:event.clientY,moves:0,dragged:false,all:false};
  if(window.mode==='geometry-selection')window.customSelection.startIndex=geometryCaret(pointerPoint(event));
  if(avatarMode()){
    const point=pointerPoint(event);
    window.avatarPress={...point,avatar:point.x>=0&&point.x<90&&point.y>=0&&point.y<90};
    window.pointerEvents.push({type:event.type,trusted:event.isTrusted,...point});
  }
});
canvas.addEventListener('mousemove',event=>{
  const selected=window.customSelection;
  if(!selectionMode()||!event.isTrusted||event.buttons!==1||!selected.started)return;
  selected.moves++;
  const distance=avatarMode()?3:50;
  if(selected.moves>=2&&Math.hypot(event.clientX-selected.x,event.clientY-selected.y)>=distance)selected.dragged=true;
});
canvas.addEventListener('mouseup',event=>{
  if(selectionMode()&&event.isTrusted)window.customSelection.started=false;
  if(window.mode==='geometry-selection')window.customSelection.endIndex=geometryCaret(pointerPoint(event));
  if(avatarMode())window.pointerEvents.push({type:event.type,trusted:event.isTrusted,...pointerPoint(event)});
});
// Deliberately model a custom editor that retains its pointer-down hit target.
// This establishes native click delivery after a drag; it does not claim that
// a particular website uses this avatar handler.
canvas.addEventListener('click',event=>{
  if(!avatarMode())return;
  window.pointerEvents.push({type:event.type,trusted:event.isTrusted,...pointerPoint(event)});
  if(event.isTrusted&&window.avatarPress?.avatar){
    window.avatarOpen=true;document.querySelector('#avatar-preview').hidden=false;
  }
});
canvas.addEventListener('keydown',event=>{
  if(!selectionMode()||!event.isTrusted||!event.ctrlKey||event.key.toLowerCase()!=='a')return;
  event.preventDefault();
  if(window.mode!=='geometry-selection'&&window.customSelection.dragged)window.customSelection.all=true;
});
document.addEventListener('copy',event=>{
  window.copyEvents.push({trusted:event.isTrusted,selectedAll:window.customSelection.all});
  if(window.mode==='geometry-selection'){
    const selected=window.customSelection;
    if(selected.dragged&&Number.isInteger(selected.startIndex)&&Number.isInteger(selected.endIndex)){
      const raw=window.geometryText.slice(Math.min(selected.startIndex,selected.endIndex),
        Math.max(selected.startIndex,selected.endIndex));
      event.clipboardData.setData('text/plain',raw);
      event.clipboardData.setData('text/html','<p>'+raw.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')+'</p>');
    }
    event.preventDefault();return;
  }
  if(selectionMode()&&!window.customSelection.all){event.preventDefault();return;}
  if(window.mode==='default')return;
  if(window.mode==='cancel'){event.preventDefault();return;}
  if(window.mode==='async'){
    event.preventDefault();setTimeout(async()=>{
      await navigator.clipboard.writeText(text);window.asyncDone=true;
    },40);return;
  }
  event.clipboardData.setData('text/plain',text);
  if(window.mode!=='plain')event.clipboardData.setData('text/html',window.mode==='full-html'
    ? '<html><body><p>'+escaped+'</p></body></html>' : '<p>'+escaped+'</p>');
  event.preventDefault();
  if(window.mode==='stop')event.stopPropagation();
});
</script>'''.replace('FIXTURE_TEXT', json.dumps(TEXT, ensure_ascii=False))
READ_CLIPBOARD = '''async()=>{
  const value={resume:'',resume_html:''};
  for(const item of await navigator.clipboard.read()){
    if(item.types.includes('text/plain'))value.resume=await(await item.getType('text/plain')).text();
    if(item.types.includes('text/html'))value.resume_html=await(await item.getType('text/html')).text();
  }
  return value;
}'''


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        pages = {'/': PAGE, '/resume': FRAME, '/collector': '<!doctype html><title>Collector</title>'}
        content = pages.get(self.path)
        body = (content or 'Not found').encode('utf-8')
        self.send_response(200 if content is not None else 404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def production_sources():
    """Use the production observer and LAN acceptance/return code, not replicas."""
    path = Path(__file__).resolve().parents[1] / 'extension/resume-copy.mjs'
    source = path.read_text(encoding='utf-8')

    def section(start, end):
        assert source.count(start) == 1, 'Production source marker changed: ' + start
        result = source.split(start, 1)[1]
        assert end in result, 'Production source marker changed: ' + end
        return start + result.split(end, 1)[0]

    observer = section('export function observeCopyClipboard(',
                       '// Injected as an isolated-world').replace('export function', 'function', 1)
    inspect = section('export function inspectCopyFrame(',
                      'function canvasExpandMarks()').replace('export function', 'function', 1)
    expand = (path.parent / 'canvas-expand.js').read_text(encoding='utf-8')
    helpers = section('  const witnessed = ', '  let previous = baseline')
    decision = section('      const tagged = ', '      if (command === copyKeys[0])')
    comparisons = '\n'.join(next(line for line in source.splitlines() if line.startswith(prefix))
                            for prefix in ('const sameClipboard = ', 'const clipboardText = '))
    # Execute the exact production LAN decision and business return expression.
    accept = ('(previous,copied,localWitness)=>{const before=null,after=null;'
              + comparisons + helpers + decision + 'return null;}')
    return observer, accept, inspect, expand


def run_checks():
    observer_source, accept_source, inspect_source, expand_source = production_sources()
    server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    checks = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),
                headless=True, args=[
                    '--disable-background-networking', '--disable-component-update', '--disable-sync',
                    '--no-first-run', '--no-default-browser-check', '--no-pings',
                    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
                ])
            try:
                context = browser.new_context(permissions=['clipboard-read', 'clipboard-write'])
                context.route('**/*', lambda route: route.continue_()
                              if route.request.url.startswith(origin + '/') else route.abort())
                page = context.new_page()
                page.goto(origin + '/')
                frame = page.frames[1]
                frame.wait_for_selector('#resume')
                collector = context.new_page()
                collector.goto(origin + '/collector')
                session = context.new_cdp_session(page)
                frame_id = session.send('Page.getFrameTree')['frameTree']['childFrames'][0]['frame']['id']
                world_id = session.send('Page.createIsolatedWorld', {
                    'frameId': frame_id, 'worldName': 'hrm-clipboard-regression',
                })['executionContextId']

                def isolated(expression):
                    result = session.send('Runtime.evaluate', {
                        'expression': expression, 'contextId': world_id,
                        'returnByValue': True, 'awaitPromise': True,
                    })
                    assert 'exceptionDetails' not in result, 'Isolated fixture evaluation failed'
                    return result['result'].get('value')

                # Only the location guard is supplied by the fixture; no real site is opened.
                isolated('window.observe=((location)=>' + observer_source + ')('
                         '{protocol:"https:",hostname:"www.zhipin.com",pathname:"/web/frame/c-resume"});'
                         'window.__hrmCopyScroll={canvas:document.querySelector("#resume")};true')
                assert isolated("typeof window.mode==='undefined'"), 'MAIN and ISOLATED globals must differ'
                collector.evaluate('source=>{window.accept=(0,eval)(source);}', accept_source)

                def shortcut(letter, command):
                    code = ord(letter.upper())
                    key = {'key': letter, 'code': 'Key' + letter.upper(), 'windowsVirtualKeyCode': code,
                           'nativeVirtualKeyCode': code, 'modifiers': 2}
                    control = {'key': 'Control', 'code': 'ControlLeft', 'windowsVirtualKeyCode': 17,
                               'nativeVirtualKeyCode': 17}
                    session.send('Input.dispatchKeyEvent', {'type': 'rawKeyDown', **control, 'modifiers': 2})
                    try:
                        session.send('Input.dispatchKeyEvent', {'type': 'rawKeyDown', **key, 'commands': [command]})
                    finally:
                        try:
                            session.send('Input.dispatchKeyEvent', {'type': 'keyUp', **key})
                        finally:
                            session.send('Input.dispatchKeyEvent', {'type': 'keyUp', **control, 'modifiers': 0})

                def case(name, mode='html', *, repeat=False, marker=True, fresh=True,
                         synthetic=False, late_clear=False, drag=False, command=False, select_all=False):
                    collector.bring_to_front()
                    if not repeat:
                        collector.evaluate("navigator.clipboard.writeText('synthetic-old')")
                    before = collector.evaluate(READ_CLIPBOARD)
                    nonce = collector.evaluate('crypto.randomUUID()')
                    page.bring_to_front()
                    frame.evaluate('''mode=>{window.mode=mode;window.asyncDone=false;window.copyEvents=[];
                      window.customSelection={started:false,moves:0,dragged:false,all:false};}''', mode)
                    frame.locator('#text' if mode == 'default' else '#resume').click()
                    if mode == 'default':
                        frame.evaluate('''()=>{const range=document.createRange();
                          range.selectNodeContents(document.querySelector('#text'));
                          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}''')
                    if drag:
                        box = frame.locator('#resume').bounding_box()
                        page.mouse.move(box['x'] + 20, box['y'] + 30)
                        page.mouse.down()
                        page.mouse.move(box['x'] + 520, box['y'] + 150, steps=12)
                        page.mouse.up()
                    if select_all:
                        shortcut('a', 'selectAll')
                    if mode == 'selection':
                        selected = frame.evaluate('window.customSelection')
                        assert selected['dragged'] == drag, name + ': genuine drag selection was not established'
                        assert selected['all'] == (drag and select_all), name + ': unexpected custom select-all state'
                    armed = isolated("window.observe('arm'," + json.dumps(nonce) + ')')
                    assert armed == (mode != 'default'), name + ': unexpected arm state'
                    if late_clear:
                        frame.evaluate('''window.addEventListener('copy',event=>{
                          event.clipboardData.clearData();event.preventDefault();},{once:true})''')
                    if synthetic:
                        frame.evaluate('''document.querySelector('#resume').dispatchEvent(new ClipboardEvent('copy',{
                          bubbles:true,cancelable:true,clipboardData:new DataTransfer()}))''')
                    elif command:
                        shortcut('c', 'copy')
                    else:
                        page.keyboard.press('Control+c')
                    if mode == 'async':
                        frame.wait_for_function('window.asyncDone===true')
                    page.wait_for_timeout(100)
                    copy_events = frame.evaluate('window.copyEvents')
                    assert len(copy_events) == 1, name + ': one copy command must dispatch exactly one copy event'
                    assert sum(event['trusted'] for event in copy_events) == (0 if synthetic else 1), \
                        name + ': unexpected trusted copy event count'
                    collector.bring_to_front()
                    actual = collector.evaluate(READ_CLIPBOARD)
                    witness = isolated("window.observe('read')")
                    isolated("window.observe('cleanup')")
                    assert isolated("window.observe('read')") is None, name + ': cleanup retained witness'
                    received_marker = bool(witness and witness['marker'] in actual['resume_html'])
                    assert received_marker == marker, name + ': unexpected native clipboard marker'
                    business = collector.evaluate('''args=>window.accept(...args)''', [before, actual, witness])
                    assert (business is not None) == fresh, name + ': unexpected production freshness'
                    if marker:
                        assert witness['resume'] == actual['resume'] == TEXT, name + ': plain text changed'
                        assert before['resume_html'] != actual['resume_html'], name + ': marker did not change'
                        assert '<!--hrm-copy:' not in business['resume_html'], name + ': business marker leaked'
                    if repeat and mode in ('html', 'plain'):
                        assert before['resume'] == actual['resume'], name + ': repeat did not use identical text'
                    if mode == 'plain':
                        assert witness['resume_html'] == business['resume_html'] == '', name + ': generated HTML leaked'
                        assert '&lt;A&amp;B&gt;' in actual['resume_html'], name + ': generated HTML is not escaped'
                    if late_clear:
                        assert witness and before == actual, name + ': late-clear fixture did not retain old clipboard'
                    checks.append(name)

                case('html-copy')
                case('html-identical-repeat', repeat=True)
                case('late-clear-retains-old-clipboard', repeat=True, marker=False, fresh=False, late_clear=True)
                case('plain-only-copy', mode='plain')
                case('plain-only-identical-repeat', mode='plain', repeat=True)
                case('full-html-copy', mode='full-html')
                case('default-copy-falls-back-to-content-change', mode='default', marker=False)
                case('default-identical-repeat-is-not-proven', mode='default', repeat=True, marker=False, fresh=False)
                case('cancel-without-data', mode='cancel', marker=False, fresh=False)
                case('stopped-propagation-falls-back', mode='stop', marker=False)
                case('async-write-falls-back', mode='async', marker=False)
                case('synthetic-untrusted-copy', synthetic=True, marker=False, fresh=False)
                case('canvas-pointer-drag-copy', drag=True)
                case('raw-cdp-copy-command', command=True)
                case('short-canvas-select-all-without-drag-is-empty', mode='selection',
                     select_all=True, command=True, marker=False, fresh=False)
                case('short-canvas-drag-without-select-all-is-incomplete', mode='selection',
                     drag=True, command=True, marker=False, fresh=False)
                case('short-canvas-drag-select-all-command-copy', mode='selection',
                     drag=True, select_all=True, command=True)
                case('short-canvas-drag-select-all-identical-repeat', mode='selection',
                     drag=True, select_all=True, command=True, repeat=True)

                # Use both production worlds: MAIN records actual painted glyph
                # pixels; ISOLATED maps their backing coordinates through the
                # iframe and validates the visible, unobstructed Canvas.
                guard = '{protocol:"https:",hostname:"www.zhipin.com",pathname:"/web/frame/c-resume"}'
                frame.evaluate('(function(location){' + expand_source + '})(' + guard + ')')
                isolated('delete window.__hrmCopyScroll;window.inspect=((location)=>'
                         + inspect_source + ')(' + guard + ');true')

                def reset_avatar(scale=1):
                    page.bring_to_front()
                    frame.evaluate('''scale=>{
                      window.mode='avatar-selection';window.avatarOpen=false;window.avatarPress=null;
                      window.copyEvents=[];window.pointerEvents=[];
                      window.customSelection={started:false,moves:0,dragged:false,all:false};
                      document.querySelector('#avatar-preview').hidden=true;
                      window.paintAvatarFixture(scale);
                    }''', scale)
                    isolated("window.inspect('cleanup')")
                    surface = isolated("window.inspect('focus')")
                    assert surface and surface['focused'] and surface['canvasFocused'], \
                        'Avatar fixture must focus through production inspectCopyFrame'
                    return surface

                def pointer_drag(start, end):
                    # Match production CDP mouse messages, including clickCount
                    # and distinct down/up positions. No synthetic DOM events.
                    session.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', **start, 'buttons': 0})
                    session.send('Input.dispatchMouseEvent', {
                        'type': 'mousePressed', **start, 'button': 'left', 'buttons': 1, 'clickCount': 1,
                    })
                    last = start
                    try:
                        for step in range(1, 13):
                            last = {key: start[key] + (end[key] - start[key]) * step / 12 for key in ('x', 'y')}
                            session.send('Input.dispatchMouseEvent', {
                                'type': 'mouseMoved', **last, 'button': 'left', 'buttons': 1,
                            })
                    finally:
                        session.send('Input.dispatchMouseEvent', {
                            'type': 'mouseReleased', **last, 'button': 'left', 'buttons': 0, 'clickCount': 1,
                        })

                surface = reset_avatar()
                box = frame.locator('#resume').bounding_box()
                pointer_drag({'x': box['x'] + 10, 'y': box['y'] + 10}, surface['end'])
                events = frame.evaluate('window.pointerEvents')
                assert [event['type'] for event in events] == ['mousedown', 'mouseup', 'click'], \
                    'Chromium should deliver a click even after a long same-Canvas drag'
                assert all(event['trusted'] for event in events), 'Avatar pointer events must be native and trusted'
                assert abs(events[1]['x'] - events[0]['x']) > 200 and abs(events[1]['y'] - events[0]['y']) > 50, \
                    'Avatar regression must release far from the pointer-down location'
                assert frame.evaluate('window.avatarOpen'), 'The cached avatar target should open on the trusted click'
                assert isolated("window.inspect('focus')") is None, \
                    'Production inspection must reject the now-obstructed resume'
                assert frame.evaluate('window.copyEvents.length') == 0, 'The failed drag must not copy'
                checks.append('old-canvas-corner-drag-opens-avatar-on-trusted-click')

                def safe_avatar_case(name, scale=1):
                    collector.bring_to_front()
                    collector.evaluate("navigator.clipboard.writeText('synthetic-avatar-old')")
                    before = collector.evaluate(READ_CLIPBOARD)
                    nonce = collector.evaluate('crypto.randomUUID()')
                    surface = reset_avatar(scale)
                    anchors = frame.evaluate('window.__hrmExpandMarks.readSelectionAnchors()')
                    assert anchors, name + ': actual text paint produced no production selection anchor'
                    points = isolated("window.inspect('selection-points'," + json.dumps(anchors) + ')')
                    assert points, name + ': production inspection rejected all text anchors'
                    point = points[0]['point']
                    box = frame.locator('#resume').bounding_box()
                    assert point['x'] > box['x'] + 130 and point['y'] > box['y'] + 90, \
                        name + ': selected text seed must be outside the avatar hot-zone'
                    pointer_drag(point, surface['end'])
                    shortcut('a', 'selectAll')
                    selected = frame.evaluate('window.customSelection')
                    assert selected['dragged'] and selected['all'], name + ': Canvas select-all needs a genuine text drag'
                    assert not frame.evaluate('window.avatarOpen'), name + ': text drag opened the avatar'
                    events = frame.evaluate('window.pointerEvents')
                    assert [event['type'] for event in events] == ['mousedown', 'mouseup', 'click'], \
                        name + ': safe seed must remain safe even when Chromium dispatches click'
                    assert all(event['trusted'] for event in events), name + ': pointer events must be trusted'
                    assert isolated("window.inspect('probe')")['canvasFocused'], name + ': safe drag lost Canvas focus'
                    assert isolated("window.observe('arm'," + json.dumps(nonce) + ')'), name + ': witness did not arm'
                    shortcut('c', 'copy')
                    page.wait_for_timeout(100)
                    copies = frame.evaluate('window.copyEvents')
                    assert copies == [{'trusted': True, 'selectedAll': True}], \
                        name + ': one CDP copy command must produce exactly one trusted complete copy'
                    collector.bring_to_front()
                    actual = collector.evaluate(READ_CLIPBOARD)
                    witness = isolated("window.observe('read')")
                    isolated("window.observe('cleanup')")
                    business = collector.evaluate('args=>window.accept(...args)', [before, actual, witness])
                    assert business and business['resume'] == TEXT, name + ': production freshness rejected native copy'
                    assert witness and witness['marker'] in actual['resume_html'], name + ': marker never reached clipboard'
                    assert '<!--hrm-copy:' not in business['resume_html'], name + ': copy marker leaked to business content'
                    assert not frame.evaluate('window.avatarOpen'), name + ': copy unexpectedly opened the avatar'
                    assert isolated("window.observe('read')") is None, name + ': copy witness was not cleaned up'
                    checks.append(name)

                safe_avatar_case('painted-text-seed-avoids-avatar-and-copies-once')
                safe_avatar_case('double-backing-scale-text-seed-avoids-avatar-and-copies-once', scale=2)

                def geometry_name_case(name, *, scale=1, align='left', italic=True, forced_caret=None):
                    collector.bring_to_front()
                    collector.evaluate("navigator.clipboard.writeText('synthetic-name-old')")
                    before = collector.evaluate(READ_CLIPBOARD)
                    nonce = collector.evaluate('crypto.randomUUID()')
                    page.bring_to_front()
                    frame.evaluate('''options=>{
                      window.mode='geometry-selection';window.avatarOpen=false;window.avatarPress=null;
                      window.copyEvents=[];window.pointerEvents=[];
                      window.customSelection={started:false,moves:0,dragged:false,all:false};
                      document.querySelector('#avatar-preview').hidden=true;
                      window.paintNameFixture(options);
                    }''', {'scale': scale, 'align': align, 'italic': italic})
                    isolated("window.inspect('cleanup')")
                    surface = isolated("window.inspect('focus')")
                    assert surface and surface['focused'], name + ': fixture did not focus'
                    anchors = frame.evaluate('window.__hrmExpandMarks.readSelectionAnchors()')
                    points = isolated("window.inspect('selection-points'," + json.dumps(anchors) + ')')
                    assert points, name + ': no verified name anchor'
                    point = points[0]['point']
                    if forced_caret is not None:
                        box = frame.locator('#resume').bounding_box()
                        carets = frame.evaluate('window.nameCarets')
                        point = {'x': box['x'] + carets[forced_caret] + 1, 'y': box['y'] + 43}
                    pointer_drag(point, surface['end'])
                    shortcut('a', 'selectAll')
                    selected = frame.evaluate('window.customSelection')
                    expected_index = forced_caret or 0
                    assert selected['startIndex'] == expected_index, name + ': wrong actual pointer caret'
                    assert selected['endIndex'] == frame.evaluate('window.geometryText.length'), name + ': drag did not reach tail'
                    assert not selected['all'], name + ': ignored Ctrl+A must not repair an incorrect start'
                    assert not frame.evaluate('window.avatarOpen'), name + ': name drag opened avatar'
                    assert isolated("window.observe('arm'," + json.dumps(nonce) + ')')
                    shortcut('c', 'copy')
                    page.wait_for_timeout(100)
                    assert frame.evaluate('window.copyEvents') == [{'trusted': True, 'selectedAll': False}], \
                        name + ': expected exactly one trusted native copy'
                    collector.bring_to_front()
                    actual = collector.evaluate(READ_CLIPBOARD)
                    witness = isolated("window.observe('read')")
                    isolated("window.observe('cleanup')")
                    expected = frame.evaluate('index=>window.geometryText.slice(index)', expected_index)
                    assert actual['resume'] == expected, name + ': native clipboard substring did not follow pointer geometry'
                    assert actual['resume'].startswith('杜先生') == (expected_index == 0), name + ': name prefix mismatch'
                    business = collector.evaluate('args=>window.accept(...args)', [before, actual, witness])
                    assert business and business['resume'] == expected, name + ': actual native copy freshness failed'
                    checks.append(name)

                geometry_name_case('last-glyph-start-really-copies-only-last-name-character', forced_caret=2)
                geometry_name_case('middle-glyph-start-really-omits-first-name-character', forced_caret=1)
                geometry_name_case('bold-name-geometry-keeps-all-characters', italic=False)
                geometry_name_case('overhanging-glyph-name-geometry-keeps-all-characters')
                geometry_name_case('overhanging-glyph-name-geometry-keeps-all-characters-at-2x', scale=2)
                geometry_name_case('center-aligned-glyph-name-geometry-keeps-all-characters', align='center')
                geometry_name_case('right-aligned-glyph-name-geometry-keeps-all-characters', align='right')
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
    return checks


def main():
    checks = run_checks()
    print(json.dumps({'checks': len(checks), 'passed': len(checks), 'failed': [], 'cases': checks}))


if __name__ == '__main__':
    main()
