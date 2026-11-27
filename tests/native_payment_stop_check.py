"""Native, offline tests for the passive BOSS payment-surface detector.

Run: python tests/native_payment_stop_check.py
Requires an installed Playwright Chromium. All HTTP responses are synthetic;
the official-looking document URLs never reach BOSS or any external service.
Only the real DOM/layout detection is exercised here. Monitor cancellation and
collector stop integration are covered separately by their JavaScript tests.
"""

import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
TOP = 'https://www.zhipin.com/web/geek/recommend'
FRAME = 'https://www.zhipin.com/web/frame/c-resume/'
STYLE = """<style>
html,body{margin:0;font:16px Arial,sans-serif}
.sidebar{position:fixed;left:0;top:0;width:240px;height:100vh;background:#ddd}
.resume{margin-left:260px;padding:20px}
.boss-popup__wrapper,.payment-dialog{position:fixed;inset:35px;background:#fff;z-index:50;box-shadow:0 0 0 100vw #0006}
.vip2-layout{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:25px}
.rights-table-vip{border:1px solid #ddd;padding:16px}
.payment-layout-v2{padding:16px;background:#f6f8fa}
.pay-wrap-qrcode-v1{width:160px;height:160px;background:repeating-conic-gradient(#333 0 25%,#fff 0 50%) 0/20px 20px}
button{padding:10px 20px}iframe{border:0;width:850px;height:580px}
</style>"""
GATE = """<div class="boss-popup__wrapper" role="dialog" aria-modal="true">
<div class="vip2-layout">
<section><h2>VIP账号</h2><p>开通招聘权益，提升招聘效率</p>
<div class="rights-table-vip"><h3>套餐权益</h3><p>每日查看牛人简历</p>
<button id="plan">1个月 ¥288</button><button id="long-plan">3个月 ¥688</button></div></section>
<section class="payment-layout-v2"><h3>商品需付</h3><strong>￥288.00</strong>
<p>直豆抵扣 0 元</p><div class="pay-wrap-qrcode-v1" aria-label="合成付款码"></div>
<p>扫码支付</p><label><input type="checkbox">我已阅读增值服务协议</label>
<button id="buy">立即购买</button><button id="close-pay">关闭</button></section>
</div></div>"""
GENERIC = """<section class="payment-dialog" role="dialog" aria-modal="true">
<h2>开通VIP招聘权益</h2><p>商品需付 ￥288.00</p><p>套餐服务</p>
<button id="generic-buy">立即支付</button><p>扫码支付</p></section>"""
NORMAL = """<aside class="sidebar">推荐牛人列表</aside><article class="resume">
<h1>合成候选人</h1><h2>工作经历</h2><p>曾负责会员VIP购买、扫码支付、充值和套餐系统开发。</p>
<p>历史项目商品需付￥288.00，涉及增值服务协议和直豆抵扣。</p></article>"""
MEASURE = """()=>{const before=document.body.innerHTML,start=performance.now();
 const detected=window.detectPaymentSurface();return {
 detected,ms:performance.now()-start,clicks:window.fixtureClicks,
 unchanged:before===document.body.innerHTML};}"""


def run_checks():
    source = (ROOT / 'extension/payment-surface.mjs').read_text(encoding='utf-8')
    source = source.replace('export function detectPaymentSurface', 'function detectPaymentSurface', 1)
    checks = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),
            headless=True, args=['--disable-background-networking', '--disable-component-update',
                                 '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND'])
        try:
            context = browser.new_context(viewport={'width': 1100, 'height': 750})

            def route_request(route):
                url = route.request.url
                if url == TOP:
                    body = NORMAL
                elif url.startswith(FRAME + '?nested='):
                    body = '<iframe src="' + FRAME + '?payment=1"></iframe>'
                elif url.startswith(FRAME + '?controls='):
                    body = '<section class="payment-layout-v2"><div class="pay-wrap-qrcode-v1"></div><p>扫码支付</p><button>立即支付</button></section>'
                elif url.startswith(FRAME + '?payment='):
                    body = GATE
                elif url.startswith(FRAME + '?normal='):
                    body = NORMAL
                else:
                    route.abort()
                    return
                route.fulfill(status=200, content_type='text/html',
                              body='<!doctype html><meta charset="utf-8">' + STYLE + body)
            context.route('**/*', route_request)
            page = context.new_page()
            page.goto(TOP)

            def reset(markup):
                page.evaluate('html=>document.body.innerHTML=html', markup)
                page.evaluate("""()=>{window.fixtureClicks=0;
                  document.addEventListener('click',()=>window.fixtureClicks++,{capture:true});}""")
                page.evaluate("source=>{window.detectPaymentSurface=new Function(source+';return detectPaymentSurface;')();}", source)
                page.evaluate('document.body.offsetHeight')

            def check(name, expected, markup=None):
                if markup is not None:
                    reset(markup)
                measured = page.evaluate(MEASURE)
                assert isinstance(measured['detected'], bool), (name, measured)
                assert measured['detected'] is expected, (name, measured)
                assert measured['clicks'] == 0 and measured['unchanged'], (name, measured)
                checks.append({'case': name, **measured})
                print(json.dumps(checks[-1]), flush=True)

            check('screenshot-like-two-column-vip-purchase', True, NORMAL + GATE)
            check('vip-cashier-with-inline-payment-icons-and-no-buy-button', True,
                  '<div class="boss-popup__wrapper"><section><h2>VIP账号</h2><p>120查看/60沟通</p></section>'
                  '<section><div>商品需付</div><div><span>¥</span><span>448</span></div><p>商品价格 ¥798</p>'
                  '<canvas width="128" height="128"></canvas><p>请使用 <i></i><i></i><i></i> 扫码支付</p>'
                  '<p>付费即表示同意《BOSS直聘增值服务协议》</p></section></div>')
            check('generic-payment-modal-with-amount-and-payment-action', True, GENERIC)
            check('known-payment-component-without-dialog-role', True,
                  GATE.replace(' role="dialog" aria-modal="true"', ''))
            check('resume-text-mentions-price-vip-and-payment', False, NORMAL)
            check('plain-chat-transcript-mentions-payment', False,
                  '<main><h2>聊天记录</h2><p>候选人：我做过VIP账号、商品需付288元、扫码支付模块。</p></main>')
            check('ordinary-salary-dialog-is-not-payment', False,
                  '<section role="dialog" class="payment-dialog"><h2>期望薪资</h2><p>￥15000/月</p><button>确认</button></section>')
            check('vip-description-without-product-payment', False,
                  '<section role="dialog" class="payment-dialog"><h2>VIP账号说明</h2><p>查看账户权益和使用规则。</p><button>关闭</button></section>')
            check('marketing-card-price-is-not-modal-payment', False,
                  '<main><article><h2>VIP招聘服务介绍</h2><p>￥288.00/月</p><a href="#">了解套餐</a></article></main>')
            check('hidden-attribute-payment-template', False, '<div hidden>' + GATE + '</div>')
            check('display-none-ancestor-payment-template', False, '<div style="display:none">' + GATE + '</div>')
            check('visibility-hidden-payment-template', False, '<div style="visibility:hidden">' + GATE + '</div>')
            check('opacity-zero-ancestor-payment-template', False, '<div style="opacity:0">' + GATE + '</div>')
            check('offscreen-payment-template', False,
                  GATE.replace('class="boss-popup__wrapper"', 'class="boss-popup__wrapper" style="inset:auto;left:2000px;top:50px;width:800px;height:600px"'))
            check('hidden-price-and-hidden-pay-button-not-visible-evidence', False,
                  '<section role="dialog" class="payment-dialog"><h2>账户帮助</h2>'
                  '<div style="display:none"><p>商品需付￥288.00</p><button>立即支付</button><p>扫码支付</p></div></section>')
            reset('<div style="width:1px;height:1px;overflow:hidden">'+GATE+'</div>')
            assert page.evaluate("document.elementFromPoint(400,200)?.closest('.boss-popup__wrapper')!==null"), 'fixed fixture is not actually visible'
            check('fixed-popup-escapes-ordinary-overflow-ancestor', True)
            reset('<div style="width:1px;height:1px;overflow:hidden;transform:translateZ(0)">'+GATE+'</div>')
            assert not page.evaluate("!!document.elementFromPoint(400,200)?.closest('.boss-popup__wrapper')"), 'transformed fixture should be clipped'
            check('fixed-popup-still-clipped-by-containing-block', False)
            check('child-visibility-restores-real-visible-payment', True,
                  '<div style="visibility:hidden">' +
                  GATE.replace('class="boss-popup__wrapper"', 'class="boss-popup__wrapper" style="visibility:visible"') + '</div>')

            reset('<div id="payment-host" hidden>' + GATE + '</div>')
            check('dynamic-hidden-before-show', False)
            page.evaluate("document.querySelector('#payment-host').hidden=false")
            check('dynamic-shown-detected-without-reinstall', True)
            page.evaluate("document.querySelector('#payment-host').hidden=true")
            check('dynamic-hidden-again-not-stale', False)
            page.evaluate("document.querySelector('#payment-host').hidden=false")
            check('dynamic-shown-again', True)
            page.evaluate("document.querySelector('#payment-host').remove()")
            check('removed-dialog-not-stale', False)

            reset('<div class="sidebar">推荐列表</div><main style="margin-left:250px">'
                  '<iframe id="body" src="' + FRAME + '?payment=1"></iframe></main>')
            page.frames[-1].wait_for_selector('.vip2-layout')
            check('visible-same-origin-frame-payment', True)
            page.evaluate("document.querySelector('#body').style.display='none'")
            check('hidden-frame-payment-is-not-current', False)
            page.evaluate("document.querySelector('#body').style.display='block'")
            check('frame-visible-again-detected', True)
            page.evaluate("document.querySelector('#body').style.opacity='0'")
            check('transparent-frame-payment-is-not-current', False)
            page.evaluate("document.querySelector('#body').style.opacity='1';document.querySelector('#body').remove()")
            check('removed-frame-not-stale', False)

            reset('<section class="payment-dialog" role="dialog"><div style="display:flex;gap:20px">' +
                  '<article style="width:350px"><h2>VIP账号</h2><p>商品需付￥288.00</p></article>' +
                  '<iframe style="width:400px;height:400px" src="' + FRAME + '?controls=1"></iframe></div></section>')
            page.frames[-1].wait_for_selector('.pay-wrap-qrcode-v1')
            check('two-column-price-and-iframe-payment-combine', True)

            reset('<iframe src="' + FRAME + '?nested=1"></iframe>')
            page.wait_for_function('document.querySelector("iframe").contentDocument.querySelector("iframe")?.contentDocument?.querySelector(".vip2-layout")')
            check('nested-same-origin-frame-payment', True)
            reset('<iframe src="' + FRAME + '?normal=1"></iframe>')
            page.frames[-1].wait_for_selector('.resume')
            check('iframe-resume-payment-mentions-not-purchase', False)

            reset('<main id="large-background"></main>' + GATE)
            page.evaluate("""()=>document.querySelector('#large-background').innerHTML=
              '<article><span>VIP系统开发</span><p>薪资￥15000</p><span>历史支付项目</span></article>'.repeat(10000)""")
            page.evaluate('document.body.offsetHeight')
            check('payment-after-forty-thousand-background-elements', True)
            page.evaluate("document.querySelector('.boss-popup__wrapper').remove()")
            check('large-background-alone-not-payment', False)
            context.close()
        finally:
            browser.close()
    return checks


def main():
    checks = run_checks()
    print(json.dumps({'checks': len(checks), 'passed': len(checks), 'failed': []}))


if __name__ == '__main__':
    main()
