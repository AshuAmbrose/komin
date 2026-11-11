// Visible ad slots with Min's blocker (AGENTS.md section 10.2): what the "visible ad slots" that measure-ad-blockers.js
// counts actually are, and what would hide them. Two gaps found 2026-11-10:
//   - Min passed the engine the hostname without "www." as the domain (edition.cnn.com), not the registrable domain
//     (cnn.com), so rules written for cnn.com never applied on edition.cnn.com. Step A tries the right domain.
//   - Generic EasyList rules such as ##.ad-slot are kept in lookups by the page's classes, ids and links
//     (getRulesFromDOM), which Min never asks for. Step B tries them.
// Per site:
//   1. every visible element the comparison counts (the same selector): size, what's inside, which part matched, its parents;
//   2. A: the site's hiding rules looked up with the right domain (tldts, as Ghostery does), inserted as Min inserts its
//      CSS (insertCSS, cssOrigin user); the slots counted again, and how many elements disappeared in all;
//   3. B: also the generic rules for the page's classes, ids and links (collected as Ghostery's content script does,
//      extractFeaturesFromDOM), the same way;
//   4. the procedural rules (getExtendedRules) the site would get, counted only (Min doesn't run them);
//   5. screenshots before, after A and after B, scrolled to the first slot;
//   6. for some common hosts, how many hiding rules and scriptlets each domain gives (engine only).
// Steps A and B use the cached engine file in this process (the same file the run's Min loads). If Min already passes the
// right domain, A changes nothing on the page; if Min already applies the generic rules, B changes nothing.
// usage: node test/e2e/measure-ad-slots.js [site ...]     results: results/measure-ad-slots.json, -sites.json, -<site>-*.png
// Needs the internet and an unlocked screen (screenshots).
const fs = require('fs')
const path = require('path')
const harness = require('./harness')
// --ubol: install uBlock Origin Lite first (it then blocks in normal tabs instead of Min's blocker), to see what it leaves
const UBOL = process.argv.includes('--ubol')
const UBOL_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
const t = harness({ name: 'measure-ad-slots', minutes: 15, extensions: UBOL ? [UBOL_ID] : [] })
const { PAGE, sleep, check, finish, connect, list, waitFor, launch, quit, ui } = t
const { FiltersEngine } = require('@ghostery/adblocker')
const { getDomain } = require('tldts-experimental')
// --gpt-stand-in: give each page uBlock Origin's stand-in for Google's ad script (gpt.js), through DevTools request
// interception, as uBO Lite serves it; Min's own blocker can't (its data: stand-ins are refused, section 10.2)
const GPT_STAND_IN = process.argv.includes('--gpt-stand-in')
const ARGS = process.argv.slice(2).filter(a => !a.startsWith('--'))
const SITES = ARGS.length ? ARGS : [
  'https://edition.cnn.com/',
  'https://www.allrecipes.com/',
  'https://timesofindia.indiatimes.com/',
  'https://www.hindustantimes.com/',
  'https://www.ndtv.com/'
]
const HOSTS = ['edition.cnn.com', 'www.cnn.com', 'timesofindia.indiatimes.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube.com', 'news.google.com', 'old.reddit.com', 'www.reddit.com', 'open.spotify.com', 'en.m.wikipedia.org', 'edition.channel5.com']
// the same selector as measure-ad-blockers-run.js counts
const AD_SELECTOR = '[id^="div-gpt-ad"], [id*="google_ads_iframe"], ins.adsbygoogle, .adsbygoogle, iframe[src*="doubleclick.net"], iframe[src*="googlesyndication"], iframe[id^="google_ads_iframe"], iframe[name^="google_ads_iframe"], [id^="taboola-"], .trc_related_container, .OUTBRAIN, [data-google-query-id], [class*="ad-slot"], [class*="adSlot"], [class*="ad-container"], [class*="adContainer"], [id*="ad-slot"], [id*="adSlot"], amp-ad, [data-ad-slot], [data-ad-unit], [class*="advertisement"], [id*="advertisement"]'
const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"

/* global document, getComputedStyle */
// runs in the page: the visible slots, outermost only, described and marked (data-min-slot)
function describeSlots (selector) {
  const parts = selector.split(', ')
  const shown = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width >= 20 && r.height >= 20 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' }
  const visible = Array.from(document.querySelectorAll(selector)).filter(shown)
  const outer = visible.filter(el => !visible.some(other => other !== el && other.contains(el)))
  const label = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '')
  return outer.map((el, i) => {
    el.setAttribute('data-min-slot', String(i))
    const r = el.getBoundingClientRect()
    const parents = []
    for (let p = el.parentElement; p && parents.length < 4 && p !== document.body; p = p.parentElement) parents.push(label(p))
    return {
      slot: i,
      element: label(el),
      size: Math.round(r.width) + 'x' + Math.round(r.height),
      minHeight: getComputedStyle(el).minHeight,
      text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      visibleFrames: Array.from(el.querySelectorAll('iframe')).filter(f => f.getBoundingClientRect().width > 1).map(f => (f.src || f.name || f.id || '(no src)').slice(0, 80)),
      visibleImages: Array.from(el.querySelectorAll('img')).filter(m => m.getBoundingClientRect().width > 1).length,
      matched: parts.filter(p => { try { return el.matches(p) } catch (e) { return false } }),
      parents
    }
  })
}
// runs in the page: what Ghostery's content script collects (adblocker-content's extractFeaturesFromDOM)
function pageFeatures () {
  const ignored = new Set(['br', 'head', 'link', 'meta', 'script', 'style', 's'])
  const classes = new Set(); const hrefs = new Set(); const ids = new Set()
  for (const el of document.querySelectorAll('[id]:not(html):not(body),[class]:not(html):not(body),[href]:not(html):not(body)')) {
    if (ignored.has(el.nodeName.toLowerCase())) continue
    const id = el.getAttribute('id'); if (typeof id === 'string') ids.add(id)
    for (const c of el.classList) classes.add(c)
    const href = el.getAttribute('href'); if (typeof href === 'string') hrefs.add(href)
  }
  return { classes: Array.from(classes), hrefs: Array.from(hrefs), ids: Array.from(ids) }
}
const DESCRIBE = '(' + describeSlots.toString() + ')(' + JSON.stringify(AD_SELECTOR) + ')'
const FEATURES = '(' + pageFeatures.toString() + ')()'
const VISIBLE_COUNT = "Array.from(document.querySelectorAll('body *')).filter(el => el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null).length"
const STILL_SHOWN = "Array.from(document.querySelectorAll('[data-min-slot]')).filter(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width >= 20 && r.height >= 20 && cs.display !== 'none' && cs.visibility !== 'hidden' }).map(el => +el.getAttribute('data-min-slot'))"
const SCROLL_TO_FIRST = "(() => { const el = document.querySelector('[data-min-slot]'); if (el) el.scrollIntoView({ block: 'center' }); return !!el })()"
const kb = s => Math.round((s || '').length / 102.4) / 10
// evaluates in an isolated world of the page's main frame: the page's own patches to built-ins (ad-recovery scripts
// rename ad elements' classes and ids, and patch getters to show the old names) don't reach it
async function isolatedEvaluate (c, expression) {
  const tree = await c.send('Page.getFrameTree')
  const frameId = tree && tree.result && tree.result.frameTree.frame.id
  const world = frameId && await c.send('Page.createIsolatedWorld', { frameId, worldName: 'min-ad-slots' })
  const contextId = world && world.result && world.result.executionContextId
  if (!contextId) return 'no isolated world'
  const r = await c.send('Runtime.evaluate', { contextId, returnByValue: true, expression })
  return r && r.result && r.result.result ? r.result.result.value : r
}
// runs in an isolated world: the first slot's and its parent's real id and class, and the hosts the page loads scripts from
function isolatedSlotView () {
  const el = document.querySelector('[data-min-slot]')
  const parent = el && el.parentElement
  return {
    slot: el ? { id: el.getAttribute('id'), class: el.getAttribute('class') } : null,
    parent: parent ? { tag: parent.tagName.toLowerCase(), id: parent.getAttribute('id'), class: parent.getAttribute('class') } : null,
    elementsWithRealClassMmAds: document.querySelectorAll('[class*="mm-ads"]').length,
    scripts: Array.from(document.scripts).map(s => s.src).filter(Boolean).map(u => new URL(u).hostname).filter((h, i, a) => a.indexOf(h) === i)
  }
}
// ids made of 20+ lower-case letters (Ad-Shield's scrambled names), read from an isolated world
const SCRAMBLED = "Array.from(document.querySelectorAll('[id]')).filter(e => /^[a-z0-9]{20,}$/.test(e.getAttribute('id')) && /[a-z]{12}/.test(e.getAttribute('id'))).length"
// The engine packs up to 1,024 selectors into one CSS rule (createStylesheet). Chromium drops a whole rule when one of its
// selectors is invalid, silently, so one unsupported selector switches off its 1,023 neighbours. This parses a stylesheet
// in a page the way Chromium will (a constructed stylesheet, not applied) and lists the selectors it rejects.
async function stylesheetHealth (page, css) {
  const selectors = []
  for (const block of (css || '').split('}')) {
    const head = block.split('{')[0]
    for (const sel of head.split(',\n')) {
      const s = sel.trim()
      if (s) selectors.push(s)
    }
  }
  const verdict = await page.evaluate(`(() => { const css = ${JSON.stringify(css || '')}; const sheet = new CSSStyleSheet(); sheet.replaceSync(css); const sels = ${JSON.stringify(selectors)}; const bad = sels.filter(s => { try { return !CSS.supports('selector(' + s + ')') } catch (e) { return true } }); return { rulesKept: sheet.cssRules.length, invalid: bad } })()`)
  const blocks = (css || '').split('}').filter(b => b.includes('{'))
  const droppedBlocks = blocks.filter(b => verdict.invalid.some(s => b.includes(s)))
  return { rules: blocks.length, rulesKept: verdict.rulesKept, selectors: selectors.length, invalidSelectors: verdict.invalid.slice(0, 20), selectorsSwitchedOff: droppedBlocks.reduce((n, b) => n + b.split('{')[0].split(',\n').length, 0) }
}

;(async () => {
  const results = []
  let hosts = []
  try {
    const engine = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(path.join(harness.CACHE, 'adblocker-engine-v2.bin'))))
    // the domain each rule lookup gets, for some common hosts (engine only)
    hosts = HOSTS.map(function (h) {
      const count = d => { const r = engine.getCosmeticsFilters({ url: 'https://' + h + '/', hostname: h, domain: d, getBaseRules: false, getInjectionRules: true, getExtendedRules: false, getRulesFromHostname: true, getRulesFromDOM: false }); return { scriptlets: r.scripts.length, cssKB: kb(r.styles) } }
      const minDomain = h.replace(/^www\./, '')
      const rightDomain = getDomain(h)
      return { host: h, minDomain, rightDomain, withMinsDomain: count(minDomain), withRightDomain: count(rightDomain) }
    })
    check('rules per host, with the domain Min passed and the right one (info)', true, hosts.filter(h => h.minDomain !== h.rightDomain).map(h => h.host + ': ' + JSON.stringify(h.withMinsDomain) + ' -> ' + JSON.stringify(h.withRightDomain)))

    const main = await launch(PAGE)
    const u = await ui()
    await sleep(2000)
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(true); win.focus(); return 1 })()`)
    check('screen unlocked (info)', true, { screenLocked: t.isScreenLocked() })
    if (UBOL) {
      await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
      const s = await waitFor(async () => { const x = (await list()).find(x => x.url.startsWith('min://app/pages/settings/')); return x ? connect(x.webSocketDebuggerUrl) : null })
      await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
      await main.evaluate(`global.__nextOpen = ${JSON.stringify(t.crx(UBOL_ID))}; 1`)
      check('uBO Lite installed (info)', true, await s.evaluate("extensionPages.request('install-crx')"))
      s.close()
      // its first start: lists compiled, rulesets turned on (as measure-ad-blockers-run.js waits)
      await sleep(60000)
    }

    for (const site of SITES) {
      const name = new URL(site).hostname.replace(/^www\./, '').split('.')[0]
      const siteDomain = getDomain(new URL(site).hostname)
      let c
      let standInServed = 0
      if (GPT_STAND_IN) {
        // a blank tab first, so the interception is on before the site's first request
        const blank = PAGE + '?stand-in-' + name
        await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(blank)} }); 1`)
        const bt = await waitFor(async () => (await list()).find(x => x.type === 'page' && x.url === blank), 20000)
        if (!bt) {
          results.push({ site, error: 'tab not found' })
          continue
        }
        c = connect(bt.webSocketDebuggerUrl)
        const stub = engine.resources.getResource('googletagservices_gpt.js')
        c.on(function (d) {
          if (d.method === 'Fetch.requestPaused') {
            standInServed++
            c.send('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }], body: Buffer.from(stub.body).toString('base64') })
          }
        })
        await c.send('Fetch.enable', { patterns: [{ urlPattern: '*://securepubads.g.doubleclick.net/tag/js/gpt.js*', requestStage: 'Request' }] })
        await c.send('Page.navigate', { url: site })
        await sleep(3000)
      } else {
        await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(site)} }); 1`)
        const target = await waitFor(async () => (await list()).find(x => x.type === 'page' && x.url.startsWith('http') && getDomain(new URL(x.url).hostname) === siteDomain), 20000)
        if (!target) {
          results.push({ site, error: 'tab not found' })
          continue
        }
        c = connect(target.webSocketDebuggerUrl)
      }
      await waitFor(async () => (await c.evaluate('document.readyState')) === 'complete', 35000)
      await sleep(15000)
      const url = await c.evaluate('location.href')
      const slots = await c.evaluate(DESCRIBE)
      if (await c.evaluate(SCROLL_TO_FIRST)) await sleep(1500)
      await t.screenshot(c, name + (GPT_STAND_IN ? '-stand-in' : '') + (UBOL ? '-ubol' : '') + '-0-before.png')
      // with the stand-in: whether the page got it (googletag is the stand-in's), and whether ad elements' names are scrambled
      const scrambledIds = await isolatedEvaluate(c, SCRAMBLED)
      const standIn = GPT_STAND_IN ? { served: standInServed, googletag: await c.evaluate("typeof googletag === 'object' && typeof googletag.pubads === 'function' ? (String(googletag.pubads).length < 200 ? 'stand-in' : 'real') : typeof googletag") } : null

      const features = await c.evaluate(FEATURES)
      const hostname = new URL(url).hostname
      const minDomain = hostname.replace(/^www\./, '')
      const domain = getDomain(hostname) || minDomain
      const insert = css => main.evaluate(`(() => { const e = process.mainModule.require('electron'); const wc = e.webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL() === ${JSON.stringify(url)}); if (!wc) return false; wc.insertCSS(${JSON.stringify(css)}, { cssOrigin: 'user' }); return true })()`)
      const step = async (label, css) => {
        const visibleBefore = await c.evaluate(VISIBLE_COUNT)
        const inserted = css ? await insert(css) : 'nothing to insert'
        await sleep(1500)
        const stillShown = await c.evaluate(STILL_SHOWN)
        const visibleAfter = await c.evaluate(VISIBLE_COUNT)
        if (await c.evaluate(SCROLL_TO_FIRST)) await sleep(1000)
        await t.screenshot(c, name + '-' + label + '.png')
        return { inserted, cssKB: kb(css), slotsStillShown: stillShown, elementsHidden: visibleBefore - visibleAfter }
      }
      const lookup = (d, dom) => engine.getCosmeticsFilters({ url, hostname, domain: d, classes: dom ? features.classes : [], ids: dom ? features.ids : [], hrefs: dom ? features.hrefs : [], getBaseRules: false, getInjectionRules: true, getExtendedRules: false, getRulesFromHostname: !dom, getRulesFromDOM: !!dom })
      const siteWithMinsDomain = lookup(minDomain, false)
      const siteWithRightDomain = lookup(domain, false)
      // A: the site's rules with the right domain
      const a = await step('a-site-rules', domain !== minDomain ? siteWithRightDomain.styles : '')
      // B: the generic rules for the page's classes, ids and links
      const start = process.hrtime.bigint()
      const generic = lookup(domain, true)
      const lookupMs = Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100
      const b = await step('b-generic-rules', generic.styles)
      // does the inserted generic CSS apply at all? Elements with a few of its classes, added to the page and removed again
      const probeClasses = (generic.styles.match(/^\.[A-Za-z0-9_-]+(?=,|\s*\{)/gm) || []).slice(0, 5).map(s => s.slice(1))
      const probe = await c.evaluate(`(() => ${JSON.stringify(probeClasses)}.map(cls => { const d = document.createElement('div'); d.className = cls; d.textContent = 'x'; document.body.appendChild(d); const display = getComputedStyle(d).display; d.remove(); return cls + ': ' + display }))()`)
      // when the generic CSS didn't apply: does Min's own CSS (its site rules), a trivial stylesheet, or the generic one
      // without its first selector apply? Each checked with a throwaway element of a class it hides
      const probeOne = async (cls, css) => {
        if (css) await insert(css)
        await sleep(500)
        return c.evaluate(`(() => { const d = document.createElement('div'); d.className = ${JSON.stringify(cls)}; d.textContent = 'x'; document.body.appendChild(d); const display = getComputedStyle(d).display; d.remove(); return display })()`)
      }
      const firstRuleOnly = (generic.styles.split(',\n')[0] || '')
      const isolation = probe.every(p => !p.endsWith(': none')) ? {
        minsSiteRule: (siteWithMinsDomain.styles.match(/^\.([A-Za-z0-9_-]+)(?=,|\s*\{)/m) || [])[1] ? (siteWithMinsDomain.styles.match(/^\.([A-Za-z0-9_-]+)(?=,|\s*\{)/m)[1] + ': ' + await probeOne(siteWithMinsDomain.styles.match(/^\.([A-Za-z0-9_-]+)(?=,|\s*\{)/m)[1], null)) : 'no class rule',
        trivialStylesheet: await probeOne('min-probe-trivial', '.min-probe-trivial { display: none !important; }'),
        genericWithoutFirstSelector: await probeOne(probeClasses[0] || 'none', generic.styles.slice(generic.styles.indexOf(',\n') + 2)),
        firstSelector: firstRuleOnly.slice(0, 160),
        // the page's own rules (any depth, @media included) that set display with !important on the probed classes
        pageImportantDisplay: await c.evaluate(`(() => { const classes = ${JSON.stringify(probeClasses)}; const out = []; const walk = rules => { for (const r of Array.from(rules || [])) { if (r.cssRules && !r.selectorText) walk(r.cssRules); else if (r.selectorText && classes.some(cls => r.selectorText.includes(cls)) && r.style && r.style.getPropertyPriority('display') === 'important') out.push(r.selectorText.slice(0, 100) + ' { display: ' + r.style.getPropertyValue('display') + ' !important }') } }; for (const s of Array.from(document.styleSheets)) { try { walk(s.cssRules) } catch (e) {} } return out.slice(0, 10) })()`),
        // the same class, one selector per stylesheet
        singleSelector: await probeOne(probeClasses[0] || 'none', '.' + (probeClasses[0] || 'none') + ' { display: none !important; }'),
        // the whole generic stylesheet as page-level CSS (a constructed stylesheet), not Min's user-level CSS
        wholeAsPageCss: await c.evaluate(`(() => { const sheet = new CSSStyleSheet(); sheet.replaceSync(${JSON.stringify(generic.styles)}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; const d = document.createElement('div'); d.className = ${JSON.stringify(probeClasses[1] || 'none')}; d.textContent = 'x'; document.body.appendChild(d); const display = getComputedStyle(d).display; d.remove(); document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet); return ${JSON.stringify(probeClasses[1] || 'none')} + ': ' + display })()`),
        // the whole generic stylesheet, one rule per selector, Min's way
        onePerSelector: await probeOne(probeClasses[2] || 'none', generic.styles.replace(/\s*\{[^}]*\}\s*$/, '').split(',\n').map(s => s.trim() + ' { display: none !important; }').join('\n')),
        // facts about the page: patched built-ins, another property through the same kind of rule, a rule by id, transitions
        facts: await (async () => {
          const cls = probeClasses[0] || 'none'
          await insert('.' + cls + ' { outline: 7px solid rgb(255, 0, 0) !important; } #min-no-such-id, [id^="mm-ads-leaderboard-header"] { visibility: hidden !important; }')
          await sleep(500)
          return c.evaluate(`(() => {
            const real = document.querySelector('[id^="mm-ads-leaderboard-header"]')
            const d = document.createElement('div'); d.className = ${JSON.stringify(cls)}; d.textContent = 'x'; document.body.appendChild(d)
            const probe = { className: d.className, matches: d.matches('.' + ${JSON.stringify(cls)}), display: getComputedStyle(d).display, outline: getComputedStyle(d).outlineStyle + ' ' + getComputedStyle(d).outlineColor }
            d.remove()
            const native = f => /\\[native code\\]/.test(Function.prototype.toString.call(f))
            return {
              probe,
              builtinsNative: { getComputedStyle: native(window.getComputedStyle), appendChild: native(Node.prototype.appendChild), matches: native(Element.prototype.matches) },
              realContainer: real ? { visibility: getComputedStyle(real).visibility, display: getComputedStyle(real).display, transition: getComputedStyle(real).transition.slice(0, 120), animation: getComputedStyle(real).animationName } : null,
              // where the slot really lives: a shadow root can't be reached by the document's CSS, Min's included
              slotRoot: (() => { const el = document.querySelector('[data-min-slot]'); if (!el) return null; const root = el.getRootNode(); const host = root && root.host; return { inShadowRoot: root instanceof ShadowRoot, mode: root instanceof ShadowRoot ? root.mode : null, host: host ? host.tagName.toLowerCase() + (host.id ? '#' + host.id : '') + (typeof host.className === 'string' && host.className ? '.' + host.className.trim().split(/\\s+/).slice(0, 3).join('.') : '') : null, hostParent: host && host.parentElement ? host.parentElement.tagName.toLowerCase() + (host.parentElement.id ? '#' + host.parentElement.id : '') : null } })(),
              shadowRootsInPage: Array.from(document.querySelectorAll('*')).filter(e => e.shadowRoot).length,
              appendChildStart: Function.prototype.toString.call(Node.prototype.appendChild).slice(0, 200)
            }
          })()`)
        })(),
        // the same slot read from an isolated world, where the page's patched built-ins don't reach: its real class and id
        isolatedView: await isolatedEvaluate(c, '(' + isolatedSlotView.toString() + ')()'),
        // Min's way (a user-level sheet, display: none !important) against a page rule with display: block !important
        userVersusPageImportant: await (async () => {
          await insert('.min-probe-contest { display: none !important; }')
          await sleep(300)
          return c.evaluate("(() => { const sheet = new CSSStyleSheet(); sheet.replaceSync('.min-probe-contest { display: block !important; }'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; const d = document.createElement('div'); d.className = 'min-probe-contest'; d.textContent = 'x'; document.body.appendChild(d); const display = getComputedStyle(d).display; d.remove(); document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet); return display })()")
        })()
      } : null
      // a slot still shown after B: why the hiding rule didn't win (computed display, inline styles, the page's own rules)
      const why = b.slotsStillShown.length ? await c.evaluate(`(() => Array.from(document.querySelectorAll('[data-min-slot]')).filter(el => ${JSON.stringify(b.slotsStillShown)}.includes(+el.getAttribute('data-min-slot'))).map(el => {
        const chain = []
        for (let p = el; p && p !== document.body && chain.length < 4; p = p.parentElement) chain.push({ element: p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') + (typeof p.className === 'string' && p.className ? '.' + p.className.trim().split(/\\s+/).join('.') : ''), display: getComputedStyle(p).display, inlineStyle: (p.getAttribute('style') || '').slice(0, 160), isConnected: p.isConnected })
        const pageRules = []
        for (const sheet of Array.from(document.styleSheets)) { let rules; try { rules = sheet.cssRules } catch (e) { continue } for (const r of Array.from(rules || [])) { if (r.selectorText && chain.some(x => x.element.split('.').slice(1).some(c => c && r.selectorText.includes(c)) || r.selectorText.includes(x.element.split('.')[0].split('#')[1] || '@@')) && /display/.test(r.style.cssText)) pageRules.push(r.selectorText.slice(0, 120) + ' { ' + r.style.cssText.slice(0, 120) + ' }') } }
        return { chain, pageRules: pageRules.slice(0, 10) }
      }))()`) : []
      const extended = engine.getCosmeticsFilters({ url, hostname, domain, classes: features.classes, ids: features.ids, hrefs: features.hrefs, getBaseRules: false, getInjectionRules: false, getExtendedRules: true, getRulesFromHostname: true, getRulesFromDOM: true }).extended || []
      // which of the stylesheets Chromium would partly throw away: what Min inserts today, and the generic rules' (B)
      const minsCss = engine.getCosmeticsFilters({ url, hostname, domain: minDomain, getBaseRules: true, getInjectionRules: false, getExtendedRules: false, getRulesFromHostname: true, getRulesFromDOM: false }).styles
      const health = { minsStylesheet: await stylesheetHealth(c, minsCss), genericRules: await stylesheetHealth(c, generic.styles) }
      c.close()

      const entry = {
        site,
        url,
        domains: { min: minDomain, right: domain },
        siteRules: { scriptletsWithMinsDomain: siteWithMinsDomain.scripts.length, scriptletsWithRightDomain: siteWithRightDomain.scripts.length, cssKBWithMinsDomain: kb(siteWithMinsDomain.styles), cssKBWithRightDomain: kb(siteWithRightDomain.styles) },
        slots,
        page: { classes: features.classes.length, ids: features.ids.length, hrefs: features.hrefs.length },
        a,
        b: Object.assign(b, { lookupMs }),
        proceduralRules: extended.length,
        stylesheets: health,
        genericCss: generic.styles,
        whyStillShown: why,
        probeAfterB: probe,
        isolation,
        standIn,
        scrambledIds
      }
      console.log('SITE ' + JSON.stringify(entry).slice(0, 2500))
      results.push(entry)
      check(name + ': visible slots, then with the right domain (A), then generic rules too (B) (info)', true, { slots: slots.length, domains: entry.domains, afterA: { stillShown: a.slotsStillShown.length, elementsHidden: a.elementsHidden }, afterB: { stillShown: b.slotsStillShown.length, elementsHidden: b.elementsHidden, cssKB: b.cssKB, lookupMs }, siteRules: entry.siteRules, proceduralRules: extended.length, stylesheets: health, scrambledIds, standIn })
      const tabId = await u.evaluate(`(tabs.get().find(x => x.url && x.url.startsWith(${JSON.stringify(url.split('/').slice(0, 3).join('/'))})) || {}).id`)
      if (tabId) await u.evaluate(`ipc.emit('extensions-close-tab', {}, ${JSON.stringify(tabId)}); 1`)
      await sleep(1000)
    }
    fs.writeFileSync(t.output('sites.json'), JSON.stringify({ sites: results, hosts }, null, 2))
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    fs.writeFileSync(t.output('sites.json'), JSON.stringify({ sites: results, hosts }, null, 2))
    finish()
  }
})()
