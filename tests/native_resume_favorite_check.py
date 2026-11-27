"""Offline native DOM checks for the serialized favorite receipt action.

Only an intercepted synthetic BOSS-shaped document is loaded in a disposable
Chromium. Every request is fulfilled locally or aborted; no real BOSS page,
account, extension installation, clipboard write or production API is used.
Run with PLAYWRIGHT_CHROMIUM_EXECUTABLE pointing to an existing Chromium.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

OWNER = 'https://www.zhipin.com/web/frame/recommend'
BODY = 'https://www.zhipin.com/web/frame/c-resume/?source=recommend'
OUTER = 'https://www.zhipin.com/web/geek/recommend'
NAME = '杜先生'
PLATFORM = 'synthetic_candidate_a'
IDENTITY = json.dumps([NAME, '35岁', '本科', '8年'], ensure_ascii=False)
HTML = """<!doctype html><meta charset="utf-8"><style>
body{margin:0}.dialog-lib-resume{position:relative;margin:20px;width:760px;height:350px;background:#eee}
.resume-root{padding:12px}.toolbar{height:60px}button{width:100px;height:40px}
.resume-detail-wrap,iframe{width:700px;height:220px;border:0}
</style><div class="dialog-lib-resume"><div class="resume-root">
<div class="toolbar"><button type="button" id="favorite">收藏</button></div>
<div class="resume-detail-wrap"><iframe src="BODY_URL"></iframe></div>
</div></div><script>
window.events={clicks:0,copies:0,forbidden:0};window.clickMode='saved';
const element=document.querySelector('.resume-root'),frame=document.querySelector('iframe');
window.base={name:'杜先生',userId:'9007199254740993',encryptGeekId:'synthetic_candidate_a'};
window.fixtureRoot={$options:{name:'ResumeRoot'},$el:element,$refs:{iframe:frame},loading:false,
 currGeek:{encryptGeekId:'synthetic_candidate_a'},dataSource:{encryptGeekId:'synthetic_candidate_a'},
 resumeInfo:{geekBaseInfo:window.base}};
element.__vue__={$options:{name:'Layout'},$el:element,$parent:window.fixtureRoot};
const forbidden=()=>{window.events.forbidden++;throw Error('Forbidden private field or page method');};
for(const value of [window.base,window.fixtureRoot.currGeek,window.fixtureRoot.dataSource]){
 Object.defineProperty(value,'securityId',{get:forbidden});Object.defineProperty(value,'lid',{get:forbidden});
}
window.fixtureRoot.getDetails=forbidden;window.fixtureRoot.openChat=forbidden;
document.addEventListener('copy',()=>window.events.copies++);
document.querySelector('#favorite').addEventListener('click',event=>{
 window.events.clicks++;
 if(window.clickMode==='saved'){event.currentTarget.textContent='已收藏';event.currentTarget.setAttribute('aria-pressed','true');}
 if(window.clickMode==='switch')window.base.userId='222222';
 if(window.clickMode==='late')setTimeout(()=>{document.querySelector('#favorite').textContent='已收藏';},250);
});
</script>""".replace('BODY_URL', BODY)
BODY_HTML = """<!doctype html><meta charset="utf-8"><canvas width="600" height="180"></canvas>
<script>const c=document.querySelector('canvas'),x=c.getContext('2d');
x.fillStyle='#1677ff';x.fillRect(0,0,600,180);x.fillStyle='#fff';x.font='24px sans-serif';
x.fillText('杜先生',110,50);x.fillText('合成简历已完成一次复制',110,110);
document.addEventListener('copy',()=>parent.events.copies++);</script>"""


def run_checks():
    source = (Path(__file__).resolve().parents[1] / 'extension/resume-favorite.mjs').read_text('utf8')
    source = source.replace('export async function resumeFavoriteAction', 'async function resumeFavoriteAction', 1)
    checks = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'), headless=True,
            args=['--disable-background-networking', '--disable-component-update', '--disable-sync',
                  '--no-first-run', '--no-default-browser-check', '--no-pings'])
        try:
            context = browser.new_context(viewport={'width':1100, 'height':800})

            def route(request):
                if request.request.url == OWNER:
                    request.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML)
                elif request.request.url == OUTER:
                    request.fulfill(status=200, content_type='text/html; charset=utf-8',
                        body='<iframe id="owner" src="' + OWNER + '" style="width:900px;height:500px;border:0"></iframe>')
                elif request.request.url == BODY:
                    request.fulfill(status=200, content_type='text/html; charset=utf-8', body=BODY_HTML)
                else:
                    request.abort()

            context.route('**/*', route)
            page = context.new_page()

            def setup():
                page.goto(OWNER)
                page.locator('iframe').wait_for()
                page.frames[1].wait_for_selector('canvas')
                page.evaluate('source=>{(0,eval)(source+";window.favoriteAction=resumeFavoriteAction;")}', source)

            def args(action, token=None, **overrides):
                value = {'action':action, 'name':NAME, 'kind':'canvas', 'expected_platform_geek_id':PLATFORM}
                if token is not None:
                    value.update(token=token, identity=IDENTITY)
                value.update(overrides)
                return value

            def call(action, token=None, **overrides):
                return page.evaluate('args=>window.favoriteAction(args)', args(action, token, **overrides))

            def prepare():
                value = call('prepare')
                assert value['status'] == 'prepared', value
                return value['token']

            def sealed():
                token = prepare()
                value = call('seal', token)
                assert value['status'] == 'sealed' and value['sealed'], value
                return token

            def counts(clicks):
                value = page.evaluate('window.events')
                assert value == {'clicks':clicks, 'copies':0, 'forbidden':0}, value

            setup()
            token = sealed()
            assert call('verify', token)['status'] == 'verified'
            value = call('click', token)
            assert value['status'] == 'confirmed' and value['favorited'] and not value['already'], value
            counts(1)
            assert call('click', token)['status'] == 'confirmed'
            counts(1)
            checks.append('blue-selected-canvas-favorites-without-another-copy')

            for stage in ['before-seal', 'after-seal']:
                setup()
                token = prepare()
                if stage == 'after-seal':
                    assert call('seal', token)['status'] == 'sealed'
                page.evaluate("window.base.userId='222222'")
                value = call('seal' if stage == 'before-seal' else 'click', token)
                assert value['status'] == 'blocked' and value['reason'] == 'identity_changed', value
                counts(0)
                checks.append('same-name-uid-change-' + stage)

            for label, mutate in [
                ('platform-change', "window.base.encryptGeekId='synthetic_b';window.fixtureRoot.currGeek.encryptGeekId='synthetic_b';window.fixtureRoot.dataSource.encryptGeekId='synthetic_b'"),
                ('component-replaced', "const root=window.fixtureRoot;document.querySelector('.resume-root').__vue__={$parent:{...root}}"),
                ('canvas-replaced', "const d=document.querySelector('iframe').contentDocument,c=d.querySelector('canvas');c.replaceWith(c.cloneNode(true))"),
                ('owner-node-reused-for-other-name', "window.base.name='另一候选人'"),
            ]:
                setup()
                token = sealed()
                page.evaluate('()=>{' + mutate + '}')
                value = call('click', token)
                assert value['status'] == 'blocked', (label, value)
                counts(0)
                checks.append('model-wait-' + label)

            setup()
            token = sealed()
            page.frames[1].goto(BODY)
            value = call('click', token)
            assert value['status'] == 'blocked' and value['reason'] == 'detail_changed', value
            counts(0)
            checks.append('same-url-iframe-document-reload-invalidates-receipt')

            setup()
            page.evaluate('delete window.base.userId')
            value = call('prepare')
            assert value['status'] == 'unavailable' and value['reason'] == 'missing_uid', value
            counts(0)
            checks.append('missing-uid-does-not-click-or-copy')

            setup()
            token = prepare()
            assert call('click', token)['status'] == 'blocked'
            assert call('seal', token, identity='[]')['status'] == 'blocked'
            counts(0)
            checks.append('unsealed-or-malformed-copy-identity-cannot-click')

            setup()
            token = sealed()
            page.evaluate("document.querySelector('#favorite').textContent='已收藏'")
            value = call('click', token)
            assert value['status'] == 'confirmed' and value['already'] and not value['attempted'], value
            counts(0)
            checks.append('already-favorited-does-not-toggle')

            setup()
            token = sealed()
            page.evaluate("window.clickMode='none'")
            value = call('click', token)
            assert value['status'] == 'uncertain' and value['attempted'], value
            assert call('click', token)['status'] == 'uncertain'
            call('stop')
            call('reset')
            value = call('prepare')
            assert value['status'] == 'uncertain' and value['attempted'], value
            counts(1)
            checks.append('uncertain-click-never-repeats-even-after-stop-reset')

            setup()
            token = sealed()
            page.evaluate("window.clickMode='switch'")
            value = call('click', token)
            assert value['status'] == 'uncertain' and value['attempted'], value
            page.evaluate("window.base.userId='9007199254740993'")
            assert call('click', token)['status'] == 'uncertain'
            counts(1)
            checks.append('synchronous-uid-change-inside-click-stays-uncertain')

            setup()
            token = sealed()
            page.evaluate("window.clickMode='late'")
            values = page.evaluate('args=>Promise.all([window.favoriteAction(args),window.favoriteAction(args)])', args('click', token))
            assert sorted(value['status'] for value in values) == ['confirmed', 'uncertain'], values
            counts(1)
            checks.append('concurrent-clicks-consume-only-one-attempt')

            setup()
            old = sealed()
            call('reset')
            new = sealed()
            call('stop', old)
            assert call('verify', old)['status'] == 'blocked'
            assert call('verify', new)['status'] == 'verified'
            assert call('click', new)['status'] == 'confirmed'
            counts(1)
            checks.append('late-token-stop-does-not-revoke-new-run')

            setup()
            token = sealed()
            call('stop')
            assert call('click', token)['status'] == 'blocked'
            counts(0)
            call('reset')
            token = sealed()
            assert call('click', token)['status'] == 'confirmed'
            counts(1)
            checks.append('global-stop-revokes-unattempted-receipts')

            for label, mutate in [
                ('covered', "const cover=document.createElement('div');cover.style.cssText='position:fixed;inset:0;background:#ddd;z-index:999';document.body.append(cover)"),
                ('ambiguous', "const b=document.querySelector('#favorite');b.parentElement.append(b.cloneNode(true))"),
            ]:
                setup()
                token = sealed()
                page.evaluate('()=>{' + mutate + '}')
                assert call('click', token)['status'] == 'blocked'
                counts(0)
                checks.append('unsafe-button-' + label)

            for later_available in [False, True]:
                setup()
                original = sealed()
                assert call('click', original)['status'] == 'confirmed'
                call('stop')
                call('reset')
                token = sealed()
                if later_available:
                    page.evaluate("""()=>{
                      const button=document.querySelector('#favorite');
                      button.textContent='收藏';button.removeAttribute('aria-pressed');
                    }""")
                value = call('click', token)
                if later_available:
                    assert value['status'] == 'uncertain' and value['attempted'], value
                else:
                    assert value['status'] == 'confirmed' and value['already'] and not value['attempted'], value
                counts(1)
                checks.append('prior-attempt-' + ('reconcile-cannot-click-again' if later_available else 'saved-state-reconciles-with-zero-new-clicks'))

            for covered in [False, True]:
                page.goto(OUTER)
                owner = page.frame(url=OWNER)
                assert owner is not None
                owner.wait_for_selector('#favorite')
                body = page.frame(url=BODY)
                assert body is not None
                body.wait_for_selector('canvas')
                owner.evaluate('source=>{(0,eval)(source+";window.favoriteAction=resumeFavoriteAction;")}', source)
                prepared = owner.evaluate('args=>window.favoriteAction(args)', args('prepare'))
                assert prepared['status'] == 'prepared', prepared
                token = prepared['token']
                assert owner.evaluate('args=>window.favoriteAction(args)', args('seal', token))['status'] == 'sealed'
                if covered:
                    page.evaluate("""()=>{
                      const cover=document.createElement('div');
                      cover.style.cssText='position:fixed;inset:0;background:#ddd;z-index:999';
                      document.body.append(cover);
                    }""")
                value = owner.evaluate('args=>window.favoriteAction(args)', args('click', token))
                assert value['status'] == ('blocked' if covered else 'confirmed'), value
                assert owner.evaluate('window.events') == {'clicks':0 if covered else 1, 'copies':0, 'forbidden':0}
                checks.append('nested-owner-frame-' + ('parent-obstruction-blocked' if covered else 'native-hit-test-confirmed'))
        finally:
            browser.close()
    return checks


if __name__ == '__main__':
    checks = run_checks()
    print(json.dumps({'checks':len(checks), 'passed':len(checks), 'failed':[], 'cases':checks}))
