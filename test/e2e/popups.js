// Windows a page opens, shown as tabs (main/viewManager.js's window-open handler, js/browserUI.js's did-create-popup;
// section 10.1). Since 2026-11-17 every window.open() and every link that opens a new tab gets Chromium's window, so the
// page keeps its handle and the new page its opener, as in Chrome; before, an open without features went to a tab Min
// opened itself and the page got null (web-platform-tests: 102 tests). Checks:
//   - window.open(url) without features: the page gets the window, the new page its opener, messages both ways, a name
//     opens the same tab again, w.close() closes it
//   - links: target="_blank" opens in front without an opener; Ctrl+click and middle-click in the background; Shift+click
//     in front (real mouse clicks through the DevTools protocol, which pages can't tell from a person's)
//   - a private tab's window is private, in its opener's session, also after hibernation
//   - the ad blocker's pop-up rules, which Ghostery's engine can't read (main/filtering.js, popupRulesEngine): a site
//     only a pop-up rule of the lists names (adsession.com: not blocked as a page, so the check fails without them), a
//     third-party pop-up rule of the lists (`&fp_sid=pop$popup,third-party`: blocked from another site, opened from the
//     same one), and one in customFilters.txt (Min's older matcher, which compared a pop-up's address with itself, so a
//     third-party rule never applied); the names are mapped to the suite's server. window.open without a click (info)
// `MIN_TEST_OLD=popupsAsNewTabs` (old-behaviour.js) puts the rule from before 2026-11-17 back, for a comparison.
const fs = require('fs')
const http = require('http')
const path = require('path')

const PORT = 8793
const SITE = `http://127.0.0.1:${PORT}`
const LISTED = `http://adsession.com:${PORT}` // the lists: ||adsession.com^$popup
const OTHER_SITE = `http://popup-elsewhere.test:${PORT}` // for the lists' &fp_sid=pop$popup,third-party
const CUSTOM = `http://blocked-popup.test:${PORT}` // customFilters.txt below

const t = require('./harness')({ name: 'popups' + (process.env.MIN_TEST_OLD ? '-old' : ''), minutes: 8 })
const { sleep, check, finish, target, waitFor, launch, ui } = t
const switchedOff = require('./old-behaviour')(t)
// the ad blocker's own pop-up rules (Min's older matcher reads this file at start)
fs.writeFileSync(path.join(t.profileDir, 'customFilters.txt'), '||blocked-popup.test^$popup,third-party\n')

const OPENER = `<!doctype html><title>opener</title>
<style>a { display: block; margin: 20px; font-size: 24px; }</style>
<a id="blank" href="${SITE}/target?blank" target="_blank">target blank</a>
<a id="plain-ctrl" href="${SITE}/target?ctrl">ctrl</a>
<a id="plain-middle" href="${SITE}/target?middle">middle</a>
<a id="plain-shift" href="${SITE}/target?shift">shift</a>
<script>
self.messages = []
addEventListener('message', function (e) { self.messages.push(e.data) })
function openPlain (url, name) { self.w = window.open(url, name); return self.w !== null }
</script>`
const TARGET = `<!doctype html><title>target</title><script>
document.title = 'target' + location.search + (window.opener ? ' with-opener' : ' no-opener')
if (window.opener) { window.opener.postMessage({ from: location.search }, '*') }
</script>`
const server = http.createServer(function (req, res) {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(req.url.startsWith('/target') ? TARGET : OPENER)
}).listen(PORT, '127.0.0.1')

const pageTarget = (prefix, ms = 10000) => target(x => x.type === 'page' && x.url.startsWith(prefix), ms)
const tabList = u => u.evaluate('({ selected: tabs.getSelected(), tabs: tabs.get().map(t => ({ id: t.id, url: t.url, private: t.private, partition: t.partition || null })) })')
const tabFor = (state, part) => state.tabs.find(x => x.url.includes(part))
const closeTabsWith = (u, part) => u.evaluate(`tabs.get().filter(t => t.url.includes(${JSON.stringify(part)})).forEach(t => ipc.emit('extensions-close-tab', {}, t.id)); 1`)
const selectTab = (u, id) => u.evaluate(`ipc.emit('extensions-select-tab', {}, ${JSON.stringify(id)}); 1`)

// a real click through the DevTools protocol: modifiers 2 = Ctrl, 8 = Shift
async function click (main, page, url, selector, { button = 'left', modifiers = 0 } = {}) {
  await main.evaluate(`(() => { const wc = process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL() === ${JSON.stringify(url)}); if (wc) wc.focus(); return 1 })()`)
  const box = await page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 } })()`)
  const buttons = button === 'middle' ? 4 : 1
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, modifiers })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button, buttons, clickCount: 1, modifiers })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button, buttons: 0, clickCount: 1, modifiers })
}

// runs code in the page as if the user had just clicked (window.open needs that)
const withClick = (page, expression) => page.send('Runtime.evaluate', { expression, userGesture: true, returnByValue: true }).then(r => r && r.result && r.result.result && r.result.result.value)

;(async () => {
  let main
  try {
    if (switchedOff.length) check('switched back to the old behaviour (info)', true, switchedOff)
    main = await launch(SITE + '/opener', { args: ['--host-resolver-rules=MAP blocked-popup.test 127.0.0.1, MAP adsession.com 127.0.0.1, MAP popup-elsewhere.test 127.0.0.1'] })
    const u = await ui()
    await sleep(1500)
    const opener = await pageTarget(SITE + '/opener')
    const openerTab = (await tabList(u)).selected

    // window.open without features
    const got = await withClick(opener, `openPlain(${JSON.stringify(SITE + '/target?script')})`)
    const popup = await pageTarget(SITE + '/target?script').catch(() => null)
    const popupTitle = popup ? await waitFor(async () => { const v = await popup.evaluate('document.title'); return v.startsWith('target') ? v : null }, 5000) : null
    await sleep(500)
    const messages = await opener.evaluate('self.messages')
    const state = await tabList(u)
    const scriptTab = tabFor(state, '?script')
    check('window.open(url) without features: the page gets the window and the new tab is in front', got === true && Boolean(scriptTab) && state.selected === (scriptTab && scriptTab.id), { got, selected: state.selected, scriptTab })
    check('window.open(url) without features: the new page has its opener and can message it', /with-opener/.test(popupTitle || '') && messages.some(m => m && m.from === '?script'), { popupTitle, messages })
    const seenFromOpener = await opener.evaluate('self.w && !self.w.closed ? self.w.document.title : null')
    check('window.open(url) without features: the opener can reach the window (same site)', /^target\?script/.test(seenFromOpener || ''), seenFromOpener)
    await opener.evaluate('self.w.close(); 1')
    const closed = await waitFor(async () => !tabFor(await tabList(u), '?script'), 5000)
    const closedFlag = await opener.evaluate('self.w ? self.w.closed : null')
    check('w.close() from the opener closes the tab', Boolean(closed) && closedFlag === true, { tabGone: Boolean(closed), wClosed: closedFlag })
    if (popup) popup.close()
    await closeTabsWith(u, '?script')
    await selectTab(u, openerTab)
    await sleep(500)

    // a name opens the same tab again
    await withClick(opener, `openPlain(${JSON.stringify(SITE + '/target?named1')}, 'mine')`)
    await sleep(1500)
    await selectTab(u, openerTab)
    await sleep(500)
    await withClick(opener, `openPlain(${JSON.stringify(SITE + '/target?named2')}, 'mine')`)
    await sleep(2000)
    const named = (await tabList(u)).tabs.filter(x => x.url.includes('?named'))
    check('window.open with a name twice: one tab, at the second address', named.length === 1 && named[0].url.includes('?named2'), named)
    await closeTabsWith(u, '?named')
    await selectTab(u, openerTab)
    await sleep(800)

    // links
    const linkCase = async (selector, part, options) => {
      await selectTab(u, openerTab)
      await sleep(600)
      await click(main, opener, SITE + '/opener', selector, options)
      const tab = await waitFor(async () => tabFor(await tabList(u), part), 6000)
      await sleep(800)
      const now = await tabList(u)
      const page = tab ? await pageTarget(SITE + '/target' + part, 4000).catch(() => null) : null
      const title = page ? await page.evaluate('document.title') : null
      if (page) page.close()
      return { opened: Boolean(tab), inFront: Boolean(tab) && now.selected === tab.id, title }
    }
    const blank = await linkCase('#blank', '?blank', {})
    check('a target="_blank" link opens a tab in front, without an opener', blank.opened && blank.inFront && /no-opener/.test(blank.title || ''), blank)
    const ctrl = await linkCase('#plain-ctrl', '?ctrl', { modifiers: 2 })
    check('Ctrl+click on a link opens it in the background', ctrl.opened && !ctrl.inFront, ctrl)
    const middle = await linkCase('#plain-middle', '?middle', { button: 'middle' })
    check('middle-click on a link opens it in the background', middle.opened && !middle.inFront, middle)
    const shift = await linkCase('#plain-shift', '?shift', { modifiers: 8 })
    check('Shift+click on a link opens it in front', shift.opened && shift.inFront, shift)
    for (const part of ['?blank', '?ctrl', '?middle', '?shift']) await closeTabsWith(u, part)
    await selectTab(u, openerTab)
    await sleep(800)

    // the ad blocker's pop-up rules
    const listed = await withClick(opener, `openPlain(${JSON.stringify(LISTED + '/target?listed')})`)
    await sleep(1500)
    check('a pop-up to a site the lists\' pop-up rules name (adsession.com) doesn\'t open', listed === false && !tabFor(await tabList(u), '?listed'), { got: listed })
    await closeTabsWith(u, '?listed')
    await selectTab(u, openerTab)
    await sleep(500)
    const thirdParty = await withClick(opener, `openPlain(${JSON.stringify(OTHER_SITE + '/target?third&fp_sid=pop')})`)
    await sleep(1500)
    await closeTabsWith(u, '?third')
    await selectTab(u, openerTab)
    await sleep(500)
    const sameSite = await withClick(opener, `openPlain(${JSON.stringify(SITE + '/target?same&fp_sid=pop')})`)
    await sleep(1500)
    check('a third-party pop-up rule of the lists blocks a pop-up to another site, not to the same site', thirdParty === false && sameSite === true, { otherSite: thirdParty, sameSite })
    await closeTabsWith(u, '?same')
    await selectTab(u, openerTab)
    await sleep(500)
    const custom = await withClick(opener, `openPlain(${JSON.stringify(CUSTOM + '/target?custom')})`)
    await sleep(1500)
    check('a pop-up a third-party rule in customFilters.txt blocks doesn\'t open', custom === false && !tabFor(await tabList(u), '?custom'), { got: custom })
    await closeTabsWith(u, '?custom')
    await selectTab(u, openerTab)
    await sleep(500)
    // without a click: Electron has no pop-up blocker of Chrome's kind, so this records what happens
    await opener.evaluate(`openPlain(${JSON.stringify(SITE + '/target?noclick')}); 1`)
    await sleep(1500)
    check('window.open without a click (info)', true, { opened: Boolean(tabFor(await tabList(u), '?noclick')) })
    await closeTabsWith(u, '?noclick')

    // private tabs
    await u.evaluate("ipc.emit('addPrivateTab'); 1")
    await sleep(800)
    const newPrivate = (await tabList(u)).selected
    await u.evaluate(`ipc.emit('extensions-load-tab', {}, { tabId: ${JSON.stringify(newPrivate)}, url: ${JSON.stringify(SITE + '/opener?private')} }); 1`)
    const privateOpener = await pageTarget(SITE + '/opener?private')
    await sleep(800)
    await privateOpener.evaluate("document.cookie = 'p=1; path=/'; 1")
    const privateOpenerTab = (await tabList(u)).selected
    await withClick(privateOpener, `openPlain(${JSON.stringify(SITE + '/target?popup-of-private')})`)
    const privatePopup = await pageTarget(SITE + '/target?popup-of-private').catch(() => null)
    await sleep(800)
    const privateState = await tabList(u)
    const privateTab = tabFor(privateState, 'target?popup-of-private')
    const privateCookie = privatePopup ? await privatePopup.evaluate('document.cookie') : null
    check('a private tab\'s window is private, in its opener\'s session', Boolean(privateTab) && privateTab.private === true && privateTab.partition === privateOpenerTab && /p=1/.test(privateCookie || ''), { privateTab, cookie: privateCookie })
    if (privatePopup) privatePopup.close()
    // hibernated, then shown again: still that session
    await selectTab(u, privateOpenerTab)
    await sleep(800)
    if (privateTab) {
      await u.evaluate(`ipc.emit('hibernateTab', {}, ${JSON.stringify(privateTab.id)}); 1`)
      await sleep(1000)
      const hibernated = await u.evaluate(`tabs.get(${JSON.stringify(privateTab.id)}).hasWebContents === false`)
      await selectTab(u, privateTab.id)
      const woken = await pageTarget(SITE + '/target?popup-of-private', 8000).catch(() => null)
      const cookieAfter = woken ? await waitFor(() => woken.evaluate('document.cookie'), 4000) : null
      check('a private tab\'s window keeps that session after hibernation', hibernated === true && /p=1/.test(cookieAfter || ''), { hibernated, cookie: cookieAfter })
      if (woken) woken.close()
    }

    // closing the page that opened tabs leaves those tabs alive: Electron closes the windows a page opened when it closes,
    // unless told otherwise (outlivesOpener), and since 2026-11-17 every tab a page opens is such a window; Min still
    // showed them, empty, and walking its tabs then threw (found 2026-11-24 by security-checks A6)
    const SECOND = SITE + '/opener?second'
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(SECOND)} }); 1`)
    const second = await pageTarget(SECOND)
    await sleep(1000)
    await withClick(second, `openPlain(${JSON.stringify(SITE + '/target?survivor-script')})`)
    await waitFor(async () => tabFor(await tabList(u), '?survivor-script'), 5000)
    // the links clicked by the page's script with a user's activation (the real-mouse clicks above test how links open;
    // here, on a second page, they missed now and then)
    const clickLink = async (selector, part, ctrlKey) => {
      await withClick(second, `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, ctrlKey: ${ctrlKey} })); 1`)
      await waitFor(async () => tabFor(await tabList(u), part), 5000)
    }
    await clickLink('#blank', '?blank', false)
    await clickLink('#plain-ctrl', '?ctrl', true)
    await sleep(1500)
    const openedBefore = ['?survivor-script', '?blank', '?ctrl']
    const tabsBefore = (await tabList(u)).tabs.map(x => x.url)
    second.close()
    await closeTabsWith(u, 'opener?second')
    await sleep(1500)
    const survivors = {}
    for (const part of ['?survivor-script', '?blank', '?ctrl']) {
      const tab = tabFor(await tabList(u), part)
      const page = tab ? await pageTarget(SITE + '/target' + part, 3000).catch(() => null) : null
      survivors[part] = { tab: Boolean(tab), page: page ? await page.evaluate('document.title').catch(e => 'gone: ' + e.message) : null }
      if (page) page.close()
    }
    check('closing the page that opened tabs (window.open, a target="_blank" link, Ctrl+click) leaves those tabs alive', openedBefore.every(part => tabsBefore.some(x => x.includes(part))) && Object.values(survivors).every(s => s.tab && /^target/.test(s.page || '')), { survivors, tabsBefore })
    for (const part of ['?survivor-script', '?blank', '?ctrl']) await closeTabsWith(u, part)

    opener.close()
    privateOpener.close()
    u.close()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
  }
  server.close()
  finish()
})()
