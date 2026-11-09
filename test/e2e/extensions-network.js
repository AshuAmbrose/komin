// End-to-end test of phase 6: an extension that filters requests takes over normal tabs from Min's ad blocker.
// The rules-only test extension blocks just the pagead2 script, so it can be told apart from Min's ad blocker, which
// also blocks trackers (scorecardresearch, Google Analytics). Uses the shared harness (harness.js).
const path = require('path')
const fs = require('fs')
const http = require('http')
const t = require('./harness')({ name: 'extensions-network', minutes: 8, extensions: ['ddkjiahejlhfcafbddmgiahcphecmpfh'] })
const { PAGE, sleep, check, finish, list, waitFor, target, launch, quit, ui } = t
const RULES_ONLY = t.extension('network-noworker')
const UBOL = t.crx('ddkjiahejlhfcafbddmgiahcphecmpfh')
const UBOL_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
const HELPER_ID = 'gnpfkmcflhpbhcdmklkmnjkhebgdgnap'
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 150]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 52>>stream\nBT /F1 24 Tf 30 70 Td (Hello from a PDF) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
const NET_PORT = 8773
const netServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/t') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(`<!doctype html><title>trackers</title><div class="adsbygoogle" id="ad" style="height: 20px">ad</div><script>
const tryFetch = url => fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(() => 'allowed', () => 'blocked')
window.__result = null
Promise.all([
  tryFetch('https://sb.scorecardresearch.com/b?c1=2&c2=' + Math.random()),
  tryFetch('https://www.google-analytics.com/g/collect?v=2&tid=G-TEST&r=' + Math.random()),
  new Promise(resolve => { const s = document.createElement('script'); s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?r=' + Math.random(); s.onload = () => resolve('loaded'); s.onerror = () => resolve('blocked'); document.head.appendChild(s) })
]).then(r => setTimeout(() => { window.__result = { tracker: r[0], analytics: r[1], adScript: r[2], adElement: getComputedStyle(document.getElementById('ad')).display } }, 1500))
</script>`)
  }
  if (u.pathname === '/article') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<!doctype html><title>An article</title><article><h1>An article for reader view</h1>' + '<p>This is a test paragraph for reader view, long enough to count as content. '.repeat(20) + '</p><p>The last paragraph says MIN-READER-OK.</p></article>')
  }
  if (u.pathname === '/script.user.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    return res.end('// ==UserScript==\n// @name Network test script\n// @match *://example.com/*\n// ==/UserScript==\n')
  }
  if (u.pathname === '/file.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('a text file')
  }
  if (u.pathname === '/test.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf' })
    return res.end(pdf)
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>page</title><p>' + u.pathname + '</p>')
}).listen(NET_PORT, '127.0.0.1')
const net = name => `http://127.0.0.1:${NET_PORT}/${name}`

async function openTab (u, url, isPrivate) {
  if (isPrivate) {
    await u.evaluate("ipc.emit('addPrivateTab', {}); 1")
    await sleep(800)
    // a private tab opened empty: load the address into it
    await u.evaluate(`(() => { const id = tabs.getSelected(); tabs.update(id, { url: ${JSON.stringify(url)} }); ipc.send('loadURLInView', { id, url: ${JSON.stringify(url)} }); return id })()`)
  } else {
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
  }
  return target(t => t.url === url && t.type === 'page', 10000)
}
async function trackers (u, label, isPrivate) {
  const url = net('t?' + label)
  const page = await openTab(u, url, isPrivate)
  // a page that hasn't started yet answers with an error ("Cannot find default execution context"): wait for the result
  const result = page && await waitFor(async () => { const r = await page.evaluate('window.__result'); return r && typeof r === 'object' ? r : null }, 20000)
  if (page) page.close()
  return result || 'no answer'
}
const mainState = main => main.evaluate(`(() => { const electron = process.mainModule.require('electron'); const ses = electron.session.fromPartition('persist:webcontent'); return { helper: !!ses.extensions.getExtension(${JSON.stringify(HELPER_ID)}), extensions: ses.extensions.getAllExtensions().map(e => e.name) } })()`)
const readSettings = () => { try { return JSON.parse(fs.readFileSync(path.join(t.profileDir, 'settings.json'), 'utf-8')) } catch (e) { return {} } }
const tabURLs = u => u.evaluate('tabs.get().map(t => ({ url: t.url, isFileView: t.isFileView }))')

// the headers of a navigation, as Chromium sent them (after extensions' rules), from the DevTools protocol
async function sentHeaders (tabTarget, url) {
  const ws = new WebSocket(tabTarget.webSocketDebuggerUrl)
  let id = 0
  const requests = {}
  const extra = {}
  ws.onmessage = function (m) {
    const d = JSON.parse(m.data)
    if (d.method === 'Network.requestWillBeSent') requests[d.params.requestId] = { url: d.params.request.url, type: d.params.type }
    if (d.method === 'Network.requestWillBeSentExtraInfo') extra[d.params.requestId] = d.params.headers
  }
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.send(JSON.stringify({ id: ++id, method: 'Network.enable' }))
  await sleep(300)
  ws.send(JSON.stringify({ id: ++id, method: 'Page.navigate', params: { url } }))
  await sleep(6000)
  ws.close()
  const requestId = Object.keys(requests).find(r => requests[r].type === 'Document' && requests[r].url.startsWith(url))
  const headers = requestId && extra[requestId]
  if (!headers) return 'no headers'
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { userAgent: lower['user-agent'], secChUa: lower['sec-ch-ua'] || 'none' }
}

;(async () => {
  let main
  try {
    main = await launch(PAGE)
    let u = await ui()
    await sleep(1500)
    await main.evaluate(`(() => { const electron = process.mainModule.require('electron'); electron.dialog.showMessageBox = async (win, options) => { __dialogs.push({ message: options.message, detail: options.detail }); return { response: 0 } }; return 1 })()`)
    let st = await mainState(main)
    check('no network extension: Min\'s blocker in charge, no helper', !readSettings().extensionsFilteringNetworkNow && !st.helper, { settings: readSettings().extensionsFilteringNetworkNow, st })
    let r = await trackers(u, 'start')
    check('Min\'s blocker blocks trackers and the ad script', r.tracker === 'blocked' && r.adScript === 'blocked', r)

    // a rules-only extension: installing it hands normal tabs over
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    let s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    check('Settings: no switch without a network extension', await s.evaluate("document.getElementById('extension-network-filtering').hidden"))
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(RULES_ONLY)}; 1`)
    const rulesId = await s.evaluate("extensionPages.request('load-unpacked')")
    await sleep(2500)
    st = await mainState(main)
    let set = readSettings()
    check('installing it turns extension filtering on, and loads the helper', set.extensionsFilterNetwork === true && set.extensionsFilteringNetworkNow === true && st.helper, { set: [set.extensionsFilterNetwork, set.extensionsFilteringNetworkNow], st })
    r = await trackers(u, 'ext')
    check('normal tab: trackers pass (Min\'s blocker off), the extension blocks the ad script (its ruleset turned on by Min)', r.tracker === 'allowed' && r.analytics === 'allowed' && r.adScript === 'blocked', r)
    const rPrivate = await trackers(u, 'private', true)
    check('private tab: Min\'s blocker still blocks', rPrivate.tracker === 'blocked' && rPrivate.adScript === 'blocked', rPrivate)
    await sleep(500)
    check('Settings: switch shown, on, naming the extension', await s.evaluate("!document.getElementById('extension-network-filtering').hidden && document.getElementById('checkbox-extension-network-filtering').checked && /Min test: rules only/.test(document.getElementById('extension-network-filtering-label').textContent)"))
    check('Settings: the extension\'s note says it blocks in normal tabs', await s.evaluate("Array.from(document.querySelectorAll('.extension-item .userscript-detail')).some(d => /instead of Min's ad blocker/.test(d.textContent))"))

    // the helper's rules
    const helperPage = await openTab(u, 'chrome-extension://' + HELPER_ID + '/manifest.json')
    const rules = helperPage && await helperPage.evaluate('chrome.declarativeNetRequest.getDynamicRules().then(r => r.map(x => ({ id: x.id, type: x.action.type, ua: x.action.requestHeaders ? x.action.requestHeaders[0].value : undefined, filter: x.condition.urlFilter || x.condition.regexFilter })))')
    check('helper rules: Google sign-in user agent and tracking parameters', Array.isArray(rules) && rules.some(x => x.type === 'modifyHeaders' && /Firefox/.test(x.ua)) && rules.some(x => x.type === 'redirect'), rules)
    if (helperPage) helperPage.close()
    // Google sign-in, as sent
    const blank = await openTab(u, net('blank'))
    const blankTarget = (await list()).find(t => t.url === net('blank'))
    const signIn = blankTarget && await sentHeaders(blankTarget, 'https://accounts.google.com/')
    check('accounts.google.com is requested with a Firefox user agent and no client hints', signIn && /Firefox/.test(signIn.userAgent) && signIn.secChUa === 'none', signIn)
    if (blank) blank.close()

    // tracking parameters, .user.js, file views, reader view, PDFs
    await openTab(u, net('landing?utm_source=newsletter&keep=1'))
    await sleep(1500)
    let urls = await tabURLs(u)
    check('tracking parameters removed, others kept', urls.some(t => t.url === net('landing?keep=1')), urls.map(t => t.url))
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(net('script.user.js'))} }); 1`)
    await sleep(3000)
    urls = await tabURLs(u)
    check('.user.js opens the install page', urls.some(t => t.url.startsWith('min://app/pages/userscriptInstall/') && t.url.includes(encodeURIComponent(net('script.user.js')))), urls.map(t => t.url))
    await openTab(u, net('file.txt'))
    await sleep(2000)
    urls = await tabURLs(u)
    check('file views recognized (text file yes, page no)', urls.find(t => t.url === net('file.txt'))?.isFileView === true && urls.find(t => t.url.startsWith(net('landing')))?.isFileView === false, urls.filter(t => /file.txt|landing/.test(t.url)))
    const readerURL = 'min://app/reader/index.html?url=' + encodeURIComponent(net('article'))
    const reader = await openTab(u, readerURL)
    const readerText = reader && await waitFor(async () => { const t = await reader.evaluate("(() => { const f = document.querySelector('iframe'); const d = f && f.contentDocument; return d && d.body ? d.body.innerText : '' })()"); return typeof t === 'string' && /MIN-READER-OK|Failed to load/.test(t) ? t : null }, 15000)
    check('reader view loads the article (through main)', typeof readerText === 'string' && readerText.includes('MIN-READER-OK'), (readerText || '').slice(0, 120))
    if (reader) reader.close()
    await openTab(u, net('test.pdf'))
    await sleep(3000)
    const pdfInfo = await main.evaluate(`(async () => { const electron = process.mainModule.require('electron'); const wc = electron.webContents.getAllWebContents().find(w => w.getURL() === ${JSON.stringify(net('test.pdf'))}); if (!wc) return 'no tab'; const image = await wc.capturePage(); process.mainModule.require('fs').writeFileSync(${JSON.stringify(t.output('pdf.png'))}, image.toPNG()); return wc.mainFrame.framesInSubtree.map(f => f.url).slice(0, 3) })()`)
    check('PDF opens in Chromium\'s viewer', Array.isArray(pdfInfo) && pdfInfo.some(f => f.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')), pdfInfo)

    // switching back in Settings
    await s.evaluate("(() => { const c = document.getElementById('checkbox-extension-network-filtering'); c.checked = false; c.dispatchEvent(new Event('change')); return 1 })()")
    await sleep(1500)
    st = await mainState(main)
    set = readSettings()
    check('switched off in Settings: Min\'s blocker back, helper unloaded', set.extensionsFilterNetwork === false && set.extensionsFilteringNetworkNow === false && !st.helper, { set: [set.extensionsFilterNetwork, set.extensionsFilteringNetworkNow], st })
    r = await trackers(u, 'off')
    check('normal tab: Min blocks trackers again', r.tracker === 'blocked' && r.adScript === 'blocked', r)
    await sleep(500)
    check('Settings: the extension\'s note says its blocking is off', await s.evaluate("Array.from(document.querySelectorAll('.extension-item .userscript-detail')).some(d => /blocking is off/.test(d.textContent))"))
    await s.evaluate("(() => { const c = document.getElementById('checkbox-extension-network-filtering'); c.checked = true; c.dispatchEvent(new Event('change')); return 1 })()")
    await sleep(1500)
    check('switched on again', readSettings().extensionsFilteringNetworkNow === true && (await mainState(main)).helper)

    // turning the extension off, then on; removing it
    await s.evaluate(`extensionPages.request('set-enabled', { id: '${rulesId}', enabled: false })`)
    await sleep(1000)
    check('extension turned off: Min\'s blocker back (the preference stays)', readSettings().extensionsFilteringNetworkNow === false && readSettings().extensionsFilterNetwork === true)
    await s.evaluate(`extensionPages.request('set-enabled', { id: '${rulesId}', enabled: true })`)
    await sleep(1000)
    check('extension turned on: it takes over again', readSettings().extensionsFilteringNetworkNow === true)
    await s.evaluate(`extensionPages.request('remove', { id: '${rulesId}' })`)
    await sleep(1500)
    r = await trackers(u, 'removed')
    check('extension removed: Min\'s blocker back', readSettings().extensionsFilteringNetworkNow === false && r.tracker === 'blocked' && !(await mainState(main)).helper, r)
    await sleep(500)
    check('Settings: switch hidden again', await s.evaluate("document.getElementById('extension-network-filtering').hidden"))

    // uBO Lite from a .crx: the review warns
    await main.evaluate(`global.__dialogs = []; global.__nextOpen = ${JSON.stringify(UBOL)}; 1`)
    check('uBO Lite installed', (await s.evaluate("extensionPages.request('install-crx')")) === UBOL_ID)
    const review = (await main.evaluate('global.__dialogs')).find(d => d.message === 'Add "uBlock Origin Lite"?')
    check('review warns that Min\'s ad blocker turns off in normal tabs', review && /turns off Min's ad blocker in normal tabs/.test(review.detail), review && review.detail)
    await sleep(4000)
    r = await trackers(u, 'ubol')
    check('uBO Lite blocks trackers in normal tabs', readSettings().extensionsFilteringNetworkNow === true && r.tracker === 'blocked' && r.analytics === 'blocked', r)

    // a restart, with the rules-only extension too
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(RULES_ONLY)}; 1`)
    await s.evaluate("extensionPages.request('load-unpacked')")
    await s.evaluate(`extensionPages.request('set-enabled', { id: '${UBOL_ID}', enabled: false })`)
    await sleep(2000)
    s.close()
    u.close()
    await quit(main)
    main = await launch(PAGE)
    u = await ui()
    await sleep(4000)
    st = await mainState(main)
    check('after restart: extension filtering on, helper loaded', readSettings().extensionsFilteringNetworkNow === true && st.helper, st)
    r = await trackers(u, 'restart')
    check('after restart: trackers pass, the extension blocks the ad script', r.tracker === 'allowed' && r.adScript === 'blocked', r)
    u.close()
    await quit(main)
    netServer.close()
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    netServer.close()
    finish()
  }
})()
