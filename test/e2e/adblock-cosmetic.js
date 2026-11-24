// Min's ad blocker's hiding rules and scriptlets on pages (AGENTS.md section 10.2), without the internet: Chromium's
// --host-resolver-rules sends edition.cnn.com, www.cnn.com and news.example.org to the local test server, so Min's blocker treats the test
// page as CNN, with the real lists (the harness's cached engine). Tabs are steered with DevTools (Page.navigate), which
// skips Min's address bar and its HTTPS upgrade list (cnn.com is on it).
//   - site rules on a subdomain: EasyList's cnn.com##.ad-slot-header__wrapper and uBO's
//     cnn.com##+js(set, FAVE.settings.ads.ssai.prod.clips.enabled, false) must apply on edition.cnn.com, not only on
//     www.cnn.com (pitfall 52: Min passed edition.cnn.com as the domain until 2026-11-10);
//   - generic rules from the page's classes, ids and links (getRulesFromDOM): EasyList's ##.ad-slot on a page, and
//     ##.ad-slot-banner on an element the page adds 2 s later (a class the page didn't have, so it has to be reported);
//     links (##a[href^="https://ad.doubleclick.net/"]); a page still arriving (its first part drawn, the rest 1.5 s later)
//     gets them once it's parsed by default, and before that with the setting hideAdSpacesWhileLoading on; a tab in the
//     background reports nothing until it's shown;
//   - frames inside a page (since 2026-11-17; until then only a tab's top frame got any): a frame from edition.cnn.com
//     inside a news.example.org page gets CNN's rule and scriptlet and the generic rules, also on an element it adds later;
//   - procedural rules (since 2026-11-17): uBlock Origin's medievalists.net##.widget-title:has-text(Adv) hides the heading
//     that says "Advertisement", also one the page adds later, and not the others (Ghostery's evaluator in the page);
//   - none of it on a site whose blocking is off (the shield button's exceptionDomains), nor in frames inside it.
const http = require('http')
const t = require('./harness')({ name: 'adblock-cosmetic' + (process.env.MIN_TEST_OLD ? '-old' : ''), minutes: 6 })
const { PAGE, sleep, check, finish, list, connect, waitFor, launch, quit, ui } = t
// MIN_TEST_OLD (old-behaviour.js), for example noFrameHiding, switches a change back for a comparison
const switchedOff = require('./old-behaviour')(t)
const PORT = 8783
const page = `<!doctype html><title>cosmetic test</title><body>
<div class="ad-slot-header__wrapper" style="height: 100px">CNN's header ad wrapper</div>
<div class="ad-slot" style="height: 100px">generic ad slot</div>
<a href="https://ad.doubleclick.net/ddm/clk/123" style="display: block; height: 30px">ad link</a>
<p id="content" style="height: 50px">real content</p>
<script>
  window.FAVE = { settings: { ads: { ssai: { prod: { clips: { enabled: true } } } } } }
  window.__faveClipsAtStart = FAVE.settings.ads.ssai.prod.clips.enabled
  // how long each box was on screen before Min hid it: checked now, then before every frame (requestAnimationFrame)
  const T = window.__timing = {}
  const watch = (key, el, since) => {
    let framesShown = 0
    const tick = () => {
      if (getComputedStyle(el).display === 'none') {
        T[key] = { hiddenAtMs: Math.round(performance.now()), afterMs: Math.round(performance.now() - since), framesShown }
      } else if (performance.now() - since < 5000) {
        framesShown++
        requestAnimationFrame(tick)
      } else {
        T[key] = { hiddenAtMs: null, framesShown }
      }
    }
    tick()
  }
  watch('headerWrapper', document.querySelector('.ad-slot-header__wrapper'), 0)
  watch('adSlot', document.querySelector('.ad-slot'), 0)
  watch('adLink', document.querySelector('a[href^="https://ad.doubleclick.net/"]'), 0)
  document.addEventListener('DOMContentLoaded', () => { T.domContentLoadedMs = Math.round(performance.now()) })
  setTimeout(function () { const d = document.createElement('div'); d.className = 'ad-slot-banner'; d.id = 'late'; d.style.height = '100px'; d.textContent = 'late ad slot'; document.body.appendChild(d); watch('lateAdSlot', d, performance.now()) }, 2000)
</script></body>`
// a page that arrives in two parts, 1.5 s apart (a big page on a slow connection): its first part is drawn while the rest
// is on its way, so a box there only a generic rule hides must be hidden before the page is parsed
const slowFirstPart = `<!doctype html><title>slow page</title><body>
<div class="ad-slot" style="height: 100px">generic ad slot</div>
<p id="content" style="height: 50px">real content</p>
<script>
  const T = window.__timing = {}
  document.addEventListener('DOMContentLoaded', () => { T.domContentLoadedMs = Math.round(performance.now()) })
  const el = document.querySelector('.ad-slot')
  let framesShown = 0
  const tick = () => {
    if (getComputedStyle(el).display === 'none') {
      T.adSlot = { hiddenAtMs: Math.round(performance.now()), framesShown }
    } else if (performance.now() < 5000) {
      framesShown++
      requestAnimationFrame(tick)
    } else {
      T.adSlot = { hiddenAtMs: null, framesShown }
    }
  }
  tick()
</script>
`
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (req.url.startsWith('/procedural')) {
    res.end(`<!doctype html><title>procedural</title><h3 class="widget-title" id="adv">Advertisement</h3><h3 class="widget-title" id="posts">Recent posts</h3>
<script>setTimeout(function () { const h = document.createElement('h3'); h.className = 'widget-title'; h.id = 'late-adv'; h.textContent = 'Adverts'; document.body.appendChild(h) }, 1500)</script>`)
    return
  }
  if (req.url.startsWith('/withframe')) {
    res.end(`<!doctype html><title>a page with a frame</title><p>the page</p><iframe src="http://edition.cnn.com:${PORT}/inframe" style="width: 900px; height: 700px"></iframe>`)
    return
  }
  if (req.url === '/slow') {
    res.write(slowFirstPart)
    setTimeout(() => res.end('<p>the rest of the page</p></body>'), 1500)
    return
  }
  res.end(page)
}).listen(PORT, '127.0.0.1')

// what Min did to the page: the elements' display (from an isolated world, as Min's preload sees them) and the scriptlet
const STATE = `(() => { const d = sel => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : 'missing' }
  return { headerWrapper: d('.ad-slot-header__wrapper'), adSlot: d('.ad-slot'), lateAdSlot: d('#late'), adLink: d('a[href^="https://ad.doubleclick.net/"]'), content: d('#content'), faveClipsAtStart: window.__faveClipsAtStart, visibility: document.visibilityState } })()`

async function visit (u, url) {
  const blank = PAGE + '?visit-' + Math.random().toString(36).slice(2)
  await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(blank)} }); 1`)
  const target = await waitFor(async () => (await list()).find(x => x.type === 'page' && x.url === blank), 15000)
  const c = connect(target.webSocketDebuggerUrl)
  await c.send('Page.navigate', { url })
  await waitFor(async () => (await c.evaluate('location.href')) === url && (await c.evaluate('document.readyState')) === 'complete', 15000)
  // the late element, and the page reporting it
  await sleep(4000)
  const state = await c.evaluate(STATE)
  state.url = await c.evaluate('location.href')
  state.timing = await c.evaluate("(() => { const p = n => { const e = performance.getEntriesByName(n)[0]; return e ? Math.round(e.startTime) : null }; return Object.assign({ firstPaintMs: p('first-paint') }, window.__timing) })()")
  c.close()
  return state
}

// the same in a frame from another site inside a page (its own process, so its own DevTools target)
async function visitFrame (u, url, frameURL) {
  const blank = PAGE + '?visit-' + Math.random().toString(36).slice(2)
  await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(blank)} }); 1`)
  const target = await waitFor(async () => (await list()).find(x => x.type === 'page' && x.url === blank), 15000)
  const c = connect(target.webSocketDebuggerUrl)
  // this tab's frame, not one left in an earlier tab
  const before = new Set((await list()).map(x => x.id))
  await c.send('Page.navigate', { url })
  const frameTarget = await waitFor(async () => (await list()).find(x => x.type === 'iframe' && x.url === frameURL && !before.has(x.id)), 15000)
  if (!frameTarget) {
    c.close()
    return { error: 'no frame target' }
  }
  const f = connect(frameTarget.webSocketDebuggerUrl)
  await waitFor(async () => (await f.evaluate('document.readyState')) === 'complete', 15000)
  await sleep(4000)
  const state = await f.evaluate(STATE)
  state.url = await f.evaluate('location.href')
  f.close()
  c.close()
  return state
}

;(async () => {
  try {
    // hidden pages aren't watched, and Chromium counts every page as hidden while Min's window is covered or the display is
    // off (an idle computer): its occlusion check is off for this run. A tab in the background is still hidden without it.
    const main = await launch(PAGE, { args: ['--host-resolver-rules=MAP edition.cnn.com 127.0.0.1, MAP www.cnn.com 127.0.0.1, MAP news.example.org 127.0.0.1, MAP medievalists.net 127.0.0.1', '--disable-features=CalculateNativeWinOcclusion'] })
    const u = await ui()
    await sleep(1500)
    if (switchedOff.length) check('switched back to the old behaviour (info)', true, switchedOff)

    const www = await visit(u, `http://www.cnn.com:${PORT}/`)
    check('www.cnn.com: CNN\'s hiding rule and scriptlet apply', www.url.startsWith('http://www.cnn.com') && www.headerWrapper === 'none' && www.faveClipsAtStart === false, www)
    const edition = await visit(u, `http://edition.cnn.com:${PORT}/`)
    check('edition.cnn.com: CNN\'s rules apply on a subdomain too (the right domain)', edition.url.startsWith('http://edition.cnn.com') && edition.headerWrapper === 'none', edition)
    check('edition.cnn.com: CNN\'s scriptlet ran before the page\'s script', edition.faveClipsAtStart === false, edition)
    check('real content stays visible', edition.content === 'block' && www.content === 'block', { www: www.content, edition: edition.content })

    // generic rules: any site (the engine gives none to a bare IP address, so a name)
    const generic = await visit(u, `http://news.example.org:${PORT}/generic`)
    check('generic rule (##.ad-slot) hides an element the page has', generic.adSlot === 'none', generic)
    check('generic rule hides an element the page adds later', generic.lateAdSlot === 'none', generic)
    check('generic link rule hides an ad link', generic.adLink === 'none', generic)
    check('generic page: real content stays visible', generic.content === 'block', generic)
    // a site's own rules come before the page is drawn; generic ones only once the page has said what it holds, so a box
    // can show for a few frames first (framesShown: frames drawn with it visible; afterMs from the page's start, or from
    // when the late box was added)
    check('how long the boxes showed before being hidden (info)', true, { siteRuleOnCnn: www.timing.headerWrapper, genericOnCnn: www.timing.adSlot, generic: generic.timing })
    // a page still arriving: by default its generic rules come once it's parsed (DOMContentLoaded), so its first part's
    // box shows until then; with the setting hideAdSpacesWhileLoading on, a shown page is watched while it arrives, so the
    // first part gets them before the rest comes (read by main as each page starts)
    const slowUrl = `http://news.example.org:${PORT}/slow`
    const slowDefault = await visit(u, slowUrl)
    const slowDefaultAd = slowDefault.timing.adSlot || {}
    check('default: a page still arriving gets its generic rules once it has arrived', slowDefault.adSlot === 'none' && typeof slowDefaultAd.hiddenAtMs === 'number' && slowDefaultAd.hiddenAtMs >= slowDefault.timing.domContentLoadedMs, slowDefault)
    await u.evaluate("ipc.send('settingChanged', 'hideAdSpacesWhileLoading', true); 1")
    await sleep(500)
    const slow = await visit(u, slowUrl)
    const slowAd = slow.timing.adSlot || {}
    check('setting on: generic rule hides a box while the page is still arriving', slow.adSlot === 'none' && typeof slowAd.hiddenAtMs === 'number' && slowAd.hiddenAtMs < slow.timing.domContentLoadedMs, slow)
    await u.evaluate("ipc.send('settingChanged', 'hideAdSpacesWhileLoading', false); 1")
    await sleep(500)

    // a tab in the background doesn't watch its page (no work while hidden); shown, it catches up at once
    const bgUrl = `http://news.example.org:${PORT}/background`
    await u.evaluate(`ipc.emit('extensions-open-tab', {}, { requestId: 'bg', url: ${JSON.stringify(bgUrl)}, active: false }); 1`)
    const bgTarget = await waitFor(async () => (await list()).find(x => x.type === 'page' && x.url === bgUrl), 15000)
    const bg = connect(bgTarget.webSocketDebuggerUrl)
    await waitFor(async () => (await bg.evaluate('document.readyState')) === 'complete', 15000)
    await sleep(4000)
    const whileHidden = await bg.evaluate(STATE)
    whileHidden.visibility = await bg.evaluate('document.visibilityState')
    await u.evaluate(`ipc.emit('extensions-select-tab', {}, tabs.get().find(t => t.url === ${JSON.stringify(bgUrl)}).id); 1`)
    await sleep(2000)
    const shown = await bg.evaluate(STATE)
    shown.visibility = await bg.evaluate('document.visibilityState')
    bg.close()
    check('background tab: what the page had at first is hidden, what it added later isn\'t looked at while hidden', whileHidden.visibility === 'hidden' && whileHidden.adSlot === 'none' && whileHidden.lateAdSlot === 'block', whileHidden)
    check('background tab, once shown: the later element is hidden too', shown.visibility === 'visible' && shown.lateAdSlot === 'none', shown)

    // procedural rules: a heading by its text, also one added later, and not the others
    {
      const blank = PAGE + '?visit-' + Math.random().toString(36).slice(2)
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(blank)} }); 1`)
      const procTarget = await waitFor(async () => (await list()).find(x => x.type === 'page' && x.url === blank), 15000)
      const c = connect(procTarget.webSocketDebuggerUrl)
      await c.send('Page.navigate', { url: `http://medievalists.net:${PORT}/procedural` })
      await waitFor(async () => (await c.evaluate('document.readyState')) === 'complete', 15000)
      await sleep(3500)
      const procedural = await c.evaluate("(() => { const d = id => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : 'missing' }; return { adv: d('adv'), posts: d('posts'), lateAdv: d('late-adv'), url: location.href } })()")
      c.close()
      check('procedural rule (:has-text): the heading that says "Advertisement" is hidden, the others aren\'t', procedural.adv === 'none' && procedural.posts === 'block', procedural)
      check('procedural rule: a heading the page adds later is hidden too', procedural.lateAdv === 'none', procedural)
    }

    // a frame from another site inside a page: its own site's rules and scriptlet, and the generic rules
    const frameURL = `http://edition.cnn.com:${PORT}/inframe`
    const framed = await visitFrame(u, `http://news.example.org:${PORT}/withframe`, frameURL)
    check('a frame inside a page: its own site\'s rule and scriptlet apply (CNN\'s, in a frame from edition.cnn.com)', framed.headerWrapper === 'none' && framed.faveClipsAtStart === false, framed)
    check('a frame inside a page: generic rules hide its elements, also one it adds later', framed.adSlot === 'none' && framed.lateAdSlot === 'none' && framed.adLink === 'none', framed)
    check('a frame inside a page: real content stays visible', framed.content === 'block', framed)

    // the shield button: blocking off for that site, so nothing hidden there
    await u.evaluate('ipc.send("settingChanged", "filtering", ' + JSON.stringify({ blockingLevel: 1, contentTypes: [], exceptionDomains: ['news.example.org'] }) + '); 1')
    await sleep(1000)
    const excepted = await visit(u, `http://news.example.org:${PORT}/excepted`)
    check('blocking off for the site: nothing hidden', excepted.adSlot === 'block' && excepted.lateAdSlot === 'block' && excepted.adLink === 'block', excepted)
    const exceptedFrame = await visitFrame(u, `http://news.example.org:${PORT}/withframe?excepted`, frameURL)
    check('blocking off for the site: nothing hidden in frames inside it either', exceptedFrame.adSlot === 'block' && exceptedFrame.headerWrapper === 'block', exceptedFrame)

    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
