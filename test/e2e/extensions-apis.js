// End-to-end test of phase 7: the APIs Min adds for extensions (main/extensionAPIs.js, js/preload/extensionSupport*.js),
// driven from the test extension's background worker. Uses the shared harness (harness.js).
// The download check writes a folder under the user's Downloads and deletes it afterwards.
const path = require('path')
const fs = require('fs')
const http = require('http')
const t = require('./harness')({ name: 'extensions-apis', minutes: 8 })
const { sleep, check, finish, connect, list, waitFor, target, launch, quit, ui } = t
const APIS = t.extension('apis')
const API_PORT = 8777
const apiServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/auth') {
    res.writeHead(302, { location: u.searchParams.get('to') + '?code=abc' })
    return res.end()
  }
  if (u.pathname === '/cookie') {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'minTest=1; Max-Age=3600; Path=/' })
    return res.end('<!doctype html><title>cookie</title><p>cookie set</p>')
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html lang="fr"><title>Page en français ' + u.search + '</title><body style="background: #fde"><h1>Bonjour</h1><p>Une page de test.</p></body></html>')
}).listen(API_PORT, '127.0.0.1')
const api = name => `http://127.0.0.1:${API_PORT}/${name}`

const MAIN_WINDOW = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow) && !w.isDestroyed()) })()"
const panelState = main => main.evaluate(`(() => { const win = ${MAIN_WINDOW}; const kids = win.contentView.children; const panel = kids.find(v => v.webContents && !v.webContents.isDestroyed() && v.webContents.getURL().endsWith('/panel.html')); const tab = kids[1]; return { panel: panel ? panel.getBounds() : null, panelVisible: panel ? (typeof panel.getVisible === 'function' ? panel.getVisible() : 'unknown') : null, last: !!panel && kids[kids.length - 1] === panel, tab: tab && tab !== panel ? tab.getBounds() : null, count: kids.length } })()`)
const headerState = u => u.evaluate("(() => { const h = document.getElementById('extension-side-panel-header'); const r = h.getBoundingClientRect(); return { hidden: h.hidden, title: document.getElementById('extension-side-panel-title').textContent, x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } })()")

;(async () => {
  let main
  try {
    main = await launch(api('page?fr'))
    const u = await ui()
    await sleep(1500)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(APIS)}; 1`)
    const id = await s.evaluate("extensionPages.request('load-unpacked')")
    check('test extension loaded', /^[a-p]{32}$/.test(id), id)
    const item = (await s.evaluate("extensionPages.request('list')")).find(e => e.id === id)
    check('Settings: none of its permissions is called unsupported', item && item.unsupported.length === 0, item && item.unsupported)
    const frTab = await u.evaluate("tabs.get().find(t => t.url.includes('page?fr')).id")
    await u.evaluate(`ipc.emit('extensions-select-tab', {}, ${JSON.stringify(frTab)}); 1`)
    await sleep(1500)
    const w = await target(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + id + '/'), 15000)
    check('the worker runs', !!w)

    // the preloads
    check('chrome can be added to, as in Chrome', (await w.evaluate('self.chromeExtensible')) === true, await w.evaluate('self.chromeExtensible'))
    check('the APIs are there', await w.evaluate("['sidePanel', 'identity', 'privacy', 'browsingData', 'search', 'tts', 'downloads'].every(n => typeof chrome[n] === 'object') && ['captureVisibleTab', 'detectLanguage', 'discard'].every(n => typeof chrome.tabs[n] === 'function')"))
    // the library's answers (Dark Reader's popup waits for isAllowedFileSchemeAccess)
    const access = await w.evaluate('Promise.all([chrome.extension.isAllowedFileSchemeAccess(), withCallback(cb => chrome.extension.isAllowedIncognitoAccess(cb)), chrome.extension.inIncognitoContext])')
    check('chrome.extension: no file or private-tab access (promise and callback)', JSON.stringify(access) === '[false,[false,null],false]', access)
    // loading or removing another extension makes Chromium rebuild some API objects in running workers and pages, without
    // the library's and Min's additions; Min puts them back (the rest of this suite then uses the restored ones). Also a
    // hidden helper page (offscreen document) of another extension, which its worker sends work to
    const constants = await w.evaluate('JSON.stringify([chrome.tabs.TAB_ID_NONE, chrome.tabs.TAB_INDEX_NONE, chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, chrome.windows.WINDOW_ID_NONE, chrome.windows.WINDOW_ID_CURRENT])')
    check('Chrome\'s tab and window constants', constants === '[-1,-1,2,-1,-2]', constants)
    const apisKept = 'JSON.stringify([typeof chrome.tabs.create, typeof chrome.tabs.captureVisibleTab, typeof chrome.extension.isAllowedFileSchemeAccess, typeof chrome.runtime.onPerformanceWarning, chrome.tabs.TAB_ID_NONE])'
    const allKept = '["function","function","function","object",-1]'
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(t.extension('offscreen'))}; 1`)
    const helperId = await s.evaluate("extensionPages.request('load-unpacked')")
    const hw = await target(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + helperId + '/'), 15000)
    await waitFor(async () => hw && (await hw.evaluate('typeof openHelper')) === 'function', 10000)
    const helperOpen = hw && await hw.evaluate("openHelper().then(r => r, e => 'ERR ' + e.message)")
    const parse = html => hw.evaluate(`askHelper({ op: 'parse', html: ${JSON.stringify(html)} }).then(r => r.text, e => 'ERR ' + e.message)`)
    const helperState = () => hw.evaluate("askHelper({ op: 'probe' }).then(r => JSON.stringify({ replaced: r.replaced, canRestore: r.canRestore }), e => 'ERR ' + e.message)")
    check('offscreen document: opens and does its work', helperOpen === true && (await parse('<p>Hello <b>helper</b></p>')) === 'Hello helper', { helperOpen, parsed: hw && await parse('<p>Hello <b>helper</b></p>') })
    const helperOK = '{"replaced":[],"canRestore":true}'
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(t.extension('basic'))}; 1`)
    const second = await s.evaluate("extensionPages.request('load-unpacked')")
    const afterLoad = await waitFor(async () => (await w.evaluate(apisKept)) === allKept, 5000) || await w.evaluate(apisKept)
    check('another extension loaded: the worker keeps the library\'s and Min\'s APIs', afterLoad === true, { second, kept: afterLoad })
    const helperAfterLoad = { state: await helperState(), parsed: await parse('<p>Still <i>here</i></p>') }
    check('another extension loaded: the offscreen document keeps its objects and works', helperAfterLoad.state === helperOK && helperAfterLoad.parsed === 'Still here', helperAfterLoad)
    await s.evaluate(`extensionPages.request('remove', { id: ${JSON.stringify(second)} })`)
    await sleep(500)
    const afterRemove = await waitFor(async () => (await w.evaluate(apisKept)) === allKept, 5000) || await w.evaluate(apisKept)
    check('another extension removed: the worker keeps them too', afterRemove === true, afterRemove)
    const helperAfterRemove = { state: await helperState(), parsed: await parse('<p>Still <i>here</i></p>') }
    check('another extension removed: the offscreen document too', helperAfterRemove.state === helperOK && helperAfterRemove.parsed === 'Still here', helperAfterRemove)
    if (hw) hw.close()
    await s.evaluate(`extensionPages.request('remove', { id: ${JSON.stringify(helperId)} })`)
    await sleep(500)
    const pageTarget = (await list()).find(t => t.url === api('page?fr'))
    const page = pageTarget && connect(pageTarget.webSocketDebuggerUrl)
    check('web pages keep their own Object.freeze', page && (await page.evaluate("Object.freeze.toString().includes('[native code]')")) === true)

    // screenshots and language
    // a covered window draws nothing, so there is nothing to capture: kept on top while testing
    await main.evaluate(`(() => { const win = ${MAIN_WINDOW}; win.setAlwaysOnTop(true); win.show(); win.focus(); return 1 })()`)
    await sleep(1000)
    const png = await w.evaluate("chrome.tabs.captureVisibleTab({ format: 'png' }).then(u => u.slice(0, 22) + ' ' + u.length)")
    check('captureVisibleTab: a PNG of the shown page', typeof png === 'string' && png.startsWith('data:image/png;base64, ') && +png.split(' ')[1] > 2000, png)
    const jpeg = await w.evaluate('withCallback(cb => chrome.tabs.captureVisibleTab(null, {}, cb)).then(r => [r[0] && r[0].slice(0, 23), r[1]])')
    check('captureVisibleTab: JPEG by default, with a callback', Array.isArray(jpeg) && jpeg[0] === 'data:image/jpeg;base64,' && jpeg[1] === null, jpeg)
    const lang = await w.evaluate('chrome.tabs.detectLanguage()')
    check('detectLanguage: the page says French', lang === 'fr', lang)

    // discard: Min's hibernation
    await u.evaluate(`ipc.emit('extensions-open-tab', {}, { requestId: 'test', url: ${JSON.stringify(api('page?bg'))}, active: false }); 1`)
    await sleep(3000)
    const bg = await w.evaluate("chrome.tabs.query({}).then(t => t.find(x => x.url.includes('page?bg')))")
    const discarded = bg && await w.evaluate(`chrome.tabs.discard(${bg.id}).then(t => t.discarded, e => e.message)`)
    await sleep(1000)
    const bgModel = await u.evaluate("tabs.get().find(t => t.url.includes('page?bg'))")
    check('tabs.discard: the background tab is hibernated and stays in the list', discarded === true && bgModel && bgModel.hasWebContents === false, { discarded, bgModel: bgModel && bgModel.hasWebContents })
    const shownDiscard = await w.evaluate('chrome.tabs.query({ active: true }).then(t => chrome.tabs.discard(t[0].id)).then(() => "discarded", e => e.message)')
    check('tabs.discard: the shown tab is refused', /^Cannot discard/.test(shownDiscard), shownDiscard)

    // downloads
    const downloadsDir = await main.evaluate("process.mainModule.require('electron').app.getPath('downloads')")
    const folder = 'min-extension-test-' + Date.now()
    try {
      const downloadId = await w.evaluate(`chrome.downloads.download({ url: 'data:text/plain,hello%20from%20Min', filename: '${folder}/hello.txt' })`)
      const done = await waitFor(() => w.evaluate(`chrome.downloads.search({ id: ${downloadId} }).then(r => r[0] && r[0].state === 'complete' ? r[0] : null)`), 15000)
      const file = path.join(downloadsDir, folder, 'hello.txt')
      check('downloads.download: saved under Downloads with its name, without a dialog', done && done.filename === file && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'hello from Min', { downloadId, filename: done && done.filename })
      await sleep(500)
      const events = await w.evaluate('self.events')
      check('downloads: onCreated (by this extension) and onChanged (complete)', events.created.some(c => c.id === downloadId && c.byExtensionId === id) && events.changed.some(c => c.id === downloadId && c.state && c.state.current === 'complete'), { created: events.created, changed: events.changed.slice(0, 4) })
      const second = await w.evaluate(`chrome.downloads.download({ url: 'data:text/plain,second', filename: '${folder}/hello.txt' }).then(id => new Promise(r => setTimeout(() => chrome.downloads.search({ id }).then(x => r(x[0].filename)), 1500)))`)
      check('downloads: a second file with that name gets " (1)"', second === path.join(downloadsDir, folder, 'hello (1).txt'), second)
      const outside = await w.evaluate("chrome.downloads.download({ url: 'data:text/plain,x', filename: '../escape.txt' }).then(() => 'started', e => e.message)")
      check('downloads: a name outside Downloads is refused', outside === 'Invalid filename', outside)
      const erased = await w.evaluate(`chrome.downloads.erase({ id: ${downloadId} })`)
      await sleep(500)
      check('downloads.erase: forgotten, with onErased', Array.isArray(erased) && erased.includes(downloadId) && (await w.evaluate('self.events.erased')).includes(downloadId) && (await w.evaluate(`chrome.downloads.search({ id: ${downloadId} }).then(r => r.length)`)) === 0, erased)
    } finally {
      fs.rmSync(path.join(downloadsDir, folder), { recursive: true, force: true })
    }

    // privacy
    const p1 = await w.evaluate('chrome.privacy.services.passwordSavingEnabled.get({})')
    await w.evaluate('chrome.privacy.services.passwordSavingEnabled.set({ value: false })')
    const p2 = await w.evaluate('withCallback(cb => chrome.privacy.services.passwordSavingEnabled.get({}, cb))')
    await w.evaluate('chrome.privacy.services.passwordSavingEnabled.clear({})')
    const p3 = await w.evaluate('chrome.privacy.services.passwordSavingEnabled.get({})')
    await sleep(300)
    const privacyEvents = await w.evaluate('self.events.privacy')
    check('privacy: get, set, clear, onChange', p1.value === true && p1.levelOfControl === 'controllable_by_this_extension' && p2[0].value === false && p2[0].levelOfControl === 'controlled_by_this_extension' && p3.value === true && privacyEvents.length >= 2, { p1, p2, p3, privacyEvents })

    // identity
    check('identity.getRedirectURL', (await w.evaluate("chrome.identity.getRedirectURL('cb')")) === `https://${id}.chromiumapp.org/cb`)
    const flow = await w.evaluate(`chrome.identity.launchWebAuthFlow({ url: ${JSON.stringify(api('auth'))} + '?to=' + encodeURIComponent(chrome.identity.getRedirectURL('cb')), interactive: true }).then(u => u, e => 'ERROR ' + e.message)`)
    check('launchWebAuthFlow: the sign-in page sends the user back, and the flow returns that address', flow === `https://${id}.chromiumapp.org/cb?code=abc`, flow)
    const quiet = await w.evaluate(`chrome.identity.launchWebAuthFlow({ url: ${JSON.stringify(api('stay'))}, interactive: false }).then(u => u, e => e.message)`)
    check('launchWebAuthFlow without interaction: a page that needs the user fails', quiet === 'User interaction required.', quiet)
    const closing = w.evaluate(`chrome.identity.launchWebAuthFlow({ url: ${JSON.stringify(api('stay?user'))}, interactive: true }).then(u => u, e => e.message)`)
    const signInWindow = await waitFor(() => main.evaluate(`(() => { const w = process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/stay?user') && w.isVisible()); if (!w) return null; w.close(); return true })()`), 10000)
    check('launchWebAuthFlow: the window is shown, and closing it ends the flow', signInWindow === true && (await closing) === 'The user did not approve access.', await closing)
    const left = await main.evaluate(`process.mainModule.require('electron').BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().startsWith('http://127.0.0.1:${API_PORT}')).length`)
    check('no sign-in windows left', left === 0, left)
    const token = await w.evaluate('chrome.identity.getAuthToken({ interactive: false }).then(t => t, e => e.message)')
    check('getAuthToken: not signed in, as in Chrome without an account', token === 'The user is not signed in.', token)

    // side panel
    const before = await panelState(main)
    await w.evaluate('chrome.windows.getCurrent().then(win => chrome.sidePanel.open({ windowId: win.id }))')
    await sleep(2000)
    let ps = await panelState(main)
    let hs = await headerState(u)
    check('sidePanel.open: the panel sits beside the narrowed tab, under its title bar', ps.panel && ps.panelVisible && ps.last && ps.panel.width === 360 && ps.panel.x === ps.tab.x + ps.tab.width && ps.tab.width === before.tab.width - 360 && !hs.hidden && hs.title === 'Min test: APIs' && Math.abs(hs.x - ps.panel.x) <= 1 && Math.abs(hs.y + hs.height - ps.panel.y) <= 1, { before: before.tab, ps, hs })
    const panelPage = await target(t => t.url === `chrome-extension://${id}/panel.html`, 10000)
    const panelText = panelPage && await waitFor(() => panelPage.evaluate("window.panelReady === true && document.getElementById('tab').textContent"), 10000)
    check('the panel page works and sees the tab beside it', typeof panelText === 'string' && panelText.includes('Page en français'), panelText)
    await u.evaluate(`ipc.emit('extensions-select-tab', {}, ${JSON.stringify(await u.evaluate("tabs.get().find(t => t.url.startsWith('min://app/pages/settings')).id"))}); 1`)
    await sleep(1200)
    ps = await panelState(main)
    check('switching tabs keeps the panel on top of the new tab', ps.panel && ps.last && ps.panelVisible, ps)
    await w.evaluate('chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })')
    await u.evaluate(`document.querySelector('#extension-actions [data-extension-id="${id}"]').click(); 1`)
    await sleep(1500)
    ps = await panelState(main)
    hs = await headerState(u)
    check('openPanelOnActionClick: the button closes it, and the tab gets its room back', !ps.panel && hs.hidden && ps.tab.width === before.tab.width, { ps, hs })
    await u.evaluate(`document.querySelector('#extension-actions [data-extension-id="${id}"]').click(); 1`)
    await sleep(1500)
    ps = await panelState(main)
    check('...and opens it again', !!ps.panel && ps.panelVisible, ps)
    await u.evaluate("document.getElementById('extension-side-panel-close').click(); 1")
    await sleep(1200)
    ps = await panelState(main)
    hs = await headerState(u)
    const panelEvents = await w.evaluate('self.events.panel')
    check('the title bar\'s close button closes it; onOpened and onClosed sent', !ps.panel && hs.hidden && ps.tab.width === before.tab.width && panelEvents.filter(e => e.startsWith('opened')).length >= 2 && panelEvents.filter(e => e.startsWith('closed')).length >= 2, { ps, hs, panelEvents })

    // browsing data
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(api('cookie'))} }); 1`)
    await sleep(2000)
    const cookies = () => main.evaluate(`process.mainModule.require('electron').session.fromPartition('persist:webcontent').cookies.get({ url: 'http://127.0.0.1:${API_PORT}' }).then(c => c.map(x => x.name))`)
    const cookiesBefore = await cookies()
    await w.evaluate(`chrome.browsingData.removeCookies({ origins: ['http://127.0.0.1:${API_PORT}'] })`)
    const cookiesAfter = await cookies()
    check('browsingData.removeCookies for one site', cookiesBefore.includes('minTest') && !cookiesAfter.includes('minTest'), { cookiesBefore, cookiesAfter })
    const range = await w.evaluate('chrome.browsingData.remove({ since: Date.now() - 3600000 }, { cookies: true }).then(() => "removed", e => e.message)')
    check('browsingData: a time range is refused (Electron can only clear everything)', /all time/.test(range), range)

    // search
    await w.evaluate("chrome.search.query({ text: 'min browser test', disposition: 'NEW_TAB' })")
    await sleep(800)
    const tabURLsNow = await u.evaluate('tabs.get().map(t => t.url)')
    const searchTab = tabURLsNow.find(url => /min(%20|\+)browser(%20|\+)test/.test(url))
    check('search.query: a new tab with Min\'s search engine', typeof searchTab === 'string', searchTab || tabURLsNow)
    await u.evaluate("(() => { const t = tabs.get().find(t => /min(%20|\\+)browser(%20|\\+)test/.test(t.url)); if (t) ipc.emit('extensions-close-tab', {}, t.id); return 1 })()")

    // speech (silent)
    const voices = await w.evaluate('chrome.tts.getVoices().then(v => v.map(x => x.voiceName))')
    const spoken = await w.evaluate("self.speak('Min')")
    check('tts: voices listed, and speaking sends start and end', Array.isArray(voices) && voices.length > 0 && Array.isArray(spoken) && spoken[0] === 'start' && spoken.includes('end'), { voices: Array.isArray(voices) ? voices.slice(0, 3) : voices, spoken })

    // an icon given as pixels
    const iconOf = () => u.evaluate(`(() => { const img = document.querySelector('#extension-actions [data-extension-id="${id}"] img'); return img ? img.src : '' })()`)
    const iconBefore = await iconOf()
    await w.evaluate('self.setRedIcon()')
    await sleep(1000)
    const iconAfter = await iconOf()
    check('action.setIcon with pixels changes the button', iconAfter.startsWith('data:image/png;base64,') && iconAfter !== iconBefore, { before: iconBefore.slice(0, 40), after: iconAfter.slice(0, 40) })

    // removing the extension closes what it opened
    await w.evaluate('chrome.windows.getCurrent().then(win => chrome.sidePanel.open({ windowId: win.id }))')
    await sleep(1000)
    await s.evaluate(`extensionPages.request('remove', { id: '${id}' })`)
    await sleep(1500)
    ps = await panelState(main)
    check('removing the extension closes its side panel', !ps.panel && (await headerState(u)).hidden, ps)

    if (page) page.close()
    s.close()
    u.close()
    await quit(main)
    apiServer.close()
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    apiServer.close()
    finish()
  }
})()
